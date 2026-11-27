import { anySignal } from '../any-signal.mjs';
import { untilAborted } from '../asset/sources/shared-reads.ts';
import type { BitgetDepositSource } from '../chain-arb/bitget-deposit-proof.ts';
import type { BinanceDepositSource } from '../chain-arb/binance-deposit-proof.ts';
import type { GateDepositSource } from '../chain-arb/gate-deposit-proof.ts';
import { readDex } from '../chain-arb/dex.ts';
import type { DexFetcher } from '../chain-arb/dex-request.ts';
import { compareChainArb } from '../chain-arb/estimate.ts';
import { CHAIN_ARB_TTL_MS, isDepositVenue, parseChainArb, VENUE_NAMES, type ChainArbView, type DepositVenue } from '../chain-arb/model.ts';
import { assertOkxDirectory, type OkxDirectory, type OkxDirectorySource } from '../chain-arb/okx-network.ts';
import { createQuoteBudget } from '../chain-arb/quote-budget.ts';
import type { createChainArbMarket } from '../chain-arb/read.ts';
import { createChainArbScanner } from '../chain-arb/scan.ts';
import { isDepositExecution, parseChainArbScan, type ScanRow, type ScanView } from '../chain-arb/scan-model.ts';
import Decimal from '../vendor/decimal.mjs';

type Market = Pick<ReturnType<typeof createChainArbMarket>, 'chainArbCatalog' | 'chainArbBook'>;
type Recipient = { address: string; minDeposit: string; expiresAt: number; current: () => boolean };
const unavailable = (message: string) => Object.assign(new Error(message), { status: 503 });
const unsupported = '该交易所尚未接入实际充值地址模拟';
const noRecipient = '未能核实当前账户在此链的实际充值地址或模拟到账数量';
const D = Decimal.clone({ precision: 1100 });

/** Public catalogues and books may cross IPC. Recipient addresses are only passed to the executor's read-only chain RPC. */
export function withChainArbLedger(market: Market, ledger?: OkxDirectorySource, now = Date.now, gateLedger?: GateDepositSource, fetcher: DexFetcher = fetch, binanceLedger?: BinanceDepositSource, bitgetLedger?: BitgetDepositSource) {
  const closing = new AbortController(), acquire = createQuoteBudget(now);
  const wallets = {
    binance: binanceLedger && { proof: binanceLedger.binanceDepositProof, recipient: binanceLedger.binanceDepositRecipient, current: binanceLedger.binanceDepositCurrent },
    bitget: bitgetLedger && { proof: bitgetLedger.bitgetDepositProof, recipient: bitgetLedger.bitgetDepositRecipient, current: bitgetLedger.bitgetDepositCurrent },
  };
  function walletFor(venue: DepositVenue) {
    if (venue !== 'binance' && venue !== 'bitget') return;
    const wallet = wallets[venue];
    if (!wallet || (venue === 'bitget' && !bitgetLedger?.bitgetDepositConnected())) {
      throw unavailable('请启用资产账本并连接 ' + VENUE_NAMES[venue] + ' 只读账户');
    }
    return wallet;
  }
  const checks = new WeakMap<object, () => boolean>(), directories = new WeakMap<ScanView, OkxDirectory>();
  function rowCurrent(row: ScanRow) {
    return isDepositExecution(row.execution, row.venue) && checks.get(row.execution)?.() === true;
  }
  async function getDirectory(signal: AbortSignal) {
    if (!ledger) throw unavailable('请启用资产账本并连接 OKX 只读账户');
    const dir = await ledger.okxScanDirectory(signal);
    signal.throwIfAborted();
    assertOkxDirectory(dir, now());
    checkDirectory(dir);
    return dir;
  }
  function checkDirectory(dir: OkxDirectory) {
    if (!ledger?.okxScanDirectoryCurrent(dir)) throw unavailable('OKX 只读连接或币链目录已变更，请重新核验');
  }
  async function quote(raw: unknown, caller: AbortSignal, scanning: boolean, dir?: OkxDirectory): Promise<ChainArbView> {
    const input = parseChainArb(raw), venue = input.venue ?? 'gate';
    if (!isDepositVenue(venue)) throw unavailable(unsupported);
    const stop = new AbortController(), signal = anySignal([caller, closing.signal, stop.signal], 12_000);
    const release = await acquire(signal, scanning);
    try {
      const wallet = walletFor(venue);
      const bookRequest = market.chainArbBook(raw, signal, dir, scanning);
      let unprofitable = false;
      let recipient: Recipient | undefined;
      const resolve = async (bought: { rawQuantity: string; decimals: number }, active: AbortSignal) => {
        const book = await bookRequest;
        if (book.deposit !== true || 'error' in book.spot || !book.spot.bids.length || now() - book.spot.at >= CHAIN_ARB_TTL_MS) return;
        if (dir) checkDirectory(dir);
        const quantity = new D(bought.rawQuantity + 'e-' + bought.decimals);
        if (scanning) {
          // Only screen at an optimistic upper bound. Tax can reduce the lot to a size that fits the book.
          const best = [book.spot, book.perp].flatMap(leg => 'bids' in leg && leg.bids.length ? [new D(leg.bids[0][0])] : []);
          if (!best.length) return;
          if (quantity.times(D.max(...best)).lte(input.amount)) { unprofitable = true; return; }
        }
        if (venue === 'gate' && gateLedger?.gateDepositRecipient) {
          const proof = await gateLedger.gateDepositProof(input.symbol, input.chain, active);
          const address = gateLedger.gateDepositRecipient(proof);
          if (!address || proof.symbol !== input.symbol || proof.chain !== input.chain || !gateLedger.gateDepositCurrent(proof)) return;
          recipient = { address, minDeposit: proof.minDeposit, expiresAt: proof.expiresAt, current: () => gateLedger.gateDepositCurrent(proof) };
        } else if (wallet) {
          if (book.minDeposit === undefined) return;
          const proof = await wallet.proof(input.symbol, input.chain, input.address, active);
          if (proof.symbol !== input.symbol || proof.chain !== input.chain || proof.contract !== input.address) return;
          const address = wallet.recipient(proof);
          if (!address || !wallet.current(proof)) return;
          const minDeposit = D.max(book.minDeposit, proof.minDeposit).toFixed();
          recipient = { address, minDeposit, expiresAt: proof.expiresAt, current: () => wallet.current(proof) };
        } else if (dir && ledger?.okxDepositRecipient && ledger.okxDepositRecipientCurrent) {
          const token = dir.rows.find(row => row.chain === input.chain && row.symbol === input.symbol && row.address === input.address && row.depositEligible);
          if (!token) return;
          const proof = await ledger.okxDepositRecipient(dir, input.symbol, input.chain, input.address, active);
          if (!ledger.okxDepositRecipientCurrent(dir, proof)) return;
          recipient = { address: proof.address, minDeposit: token.minDeposit, expiresAt: Math.min(dir.expiresAt, proof.expiresAt),
            current: () => ledger.okxScanDirectoryCurrent(dir) && ledger.okxDepositRecipientCurrent!(dir, proof) };
        }
        active.throwIfAborted();
        if (recipient && recipient.expiresAt > now() && quantity.gte(recipient.minDeposit)) return recipient.address;
      };
      const [book, buy] = await untilAborted(Promise.all([bookRequest, readDex(input, signal, fetcher, now, undefined, resolve)]), signal);
      signal.throwIfAborted();
      if (dir) checkDirectory(dir);
      const proof = recipient, time = now();
      const current = () => !!proof && now() >= time && now() < proof.expiresAt && proof.current();
      const confirmed = !!buy.evidence?.transferRaw && current();
      const view = compareChainArb(input, buy, { ...book, minDeposit: proof?.minDeposit ?? book.minDeposit }, time);
      if (!confirmed || !view.dex.execution) {
        if (view.dex.execution) {
          view.dex.execution.transferQuantity = null; view.dex.execution.transferAmount = null;
        }
        view.dex.swapGasUsdt = null;
        if (unprofitable) view.screenedUnprofitable = true;
        if (view.deposit === true) view.deposit = null;
        const blocked = (leg: ChainArbView['spot']) => 'error' in leg && !leg.error.includes('转账模拟未确认') ? leg : { error: noRecipient };
        view.spot = blocked(view.spot); view.perp = blocked(view.perp);
        return view;
      }
      view.dex.execution.depositVenue = venue;
      view.dex.execution.depositExpiresAt = proof!.expiresAt;
      view.expiresAt = Math.min(view.expiresAt, proof!.expiresAt);
      checks.set(view.dex.execution, current);
      return view;
    } finally { stop.abort(); release(); }
  }
  function scanner(venue: DepositVenue, directory: () => OkxDirectory | undefined) {
    return createChainArbScanner({ now, catalog: signal => market.chainArbCatalog(venue, signal, directory()),
      quote: (raw, signal) => quote(raw, signal, true, directory()) });
  }
  const scanners = { gate: scanner('gate', () => undefined), binance: scanner('binance', () => undefined), bitget: scanner('bitget', () => undefined) };
  let activeDir: OkxDirectory | undefined, okx = scanner('okx', () => activeDir);
  return {
    async chainArb(raw: unknown, signal: AbortSignal) {
      const input = parseChainArb(raw);
      walletFor(input.venue ?? 'gate');
      return quote(raw, signal, false, input.venue === 'okx' ? await getDirectory(signal) : undefined);
    },
    async scanChainArb(raw: unknown, scope: string, signal: AbortSignal, awaitBatch = false): Promise<ScanView> {
      const input = parseChainArbScan(raw), venue = input.venue ?? 'gate';
      if (!isDepositVenue(venue)) return { asOf: now(), phase: 'error', total: 0, checked: 0, failed: 0, cycle: 0, message: unsupported, rows: [], history: [] };
      walletFor(venue);
      const dir = venue === 'okx' ? await getDirectory(signal) : undefined;
      if (dir && activeDir !== dir) {
        if (dir.connection !== activeDir?.connection) { okx.close(); okx = scanner('okx', () => activeDir); }
        else okx.revalidateSamples(() => false);
        activeDir = dir;
      }
      const selected = venue === 'okx' ? okx : scanners[venue];
      const data = await selected.read(raw, scope, signal, awaitBatch);
      if (dir) checkDirectory(dir);
      const view = { ...data, rows: data.rows.filter(rowCurrent), history: data.history.filter(rowCurrent) };
      if (dir) directories.set(view, dir);
      return view;
    },
    okxResultCurrent(view: ScanView) {
      const dir = directories.get(view);
      return !!dir && !!ledger?.okxScanDirectoryCurrent(dir);
    },
    gateResultCurrent: rowCurrent, okxDepositResultCurrent: rowCurrent, binanceResultCurrent: rowCurrent, bitgetResultCurrent: rowCurrent,
    close() { closing.abort(); okx.close(); for (const scan of Object.values(scanners)) scan.close(); },
  };
}
