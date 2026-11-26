import Decimal from '../vendor/decimal.mjs';
import { GATE_DEPOSIT_TTL, isGateDepositRequest, type GateDepositProof, type GateDepositSource } from '../chain-arb/gate-deposit-proof.ts';
import type { createChainArbMarket } from '../chain-arb/read.ts';
import { CHAIN_ARB_TTL_MS, isConsistentArbEstimate, isManualEstimate, parseChainArb, type ArbResult, type Chain, type ChainArbInput, type ChainArbView } from '../chain-arb/model.ts';
import { isSettlementOrNative } from '../chain-arb/networks.ts';
import { isVerifiedExecution, parseChainArbScan, SCAN_HISTORY_MS, type ScanInput, type ScanRow, type ScanView } from '../chain-arb/scan-model.ts';
import { assertOkxDirectory, type OkxDirectory, type OkxDirectorySource } from '../chain-arb/okx-network.ts';

type Market = Pick<ReturnType<typeof createChainArbMarket>, 'chainArb' | 'scanChainArb'>;
const unavailable = (message: string) => Object.assign(new Error(message), { status: 503 });
const GATE_UNVERIFIED = '未核实 Gate 账户在此网络的充值条件，请检查资产账本的 Gate 只读连接';
const BELOW_MINIMUM = '模拟转账实收量低于 Gate 账户在此网络的最低充值量';
const tokenDecimal = (value: unknown): value is string => typeof value === 'string' && /^(?:0|[1-9]\d{0,77})(?:\.\d{1,255})?$/.test(value);
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

function transferAmount(execution: unknown): string | undefined {
  if (!isVerifiedExecution(execution)) return;
  const amount = execution.transferAmount;
  // The numeric display field can round at the final decimal place. Compare the minimum using the original string.
  if (tokenDecimal(amount) && Number(amount) === execution.transferQuantity) return amount;
}

function manualLeg(leg: ArbResult, budget: number, missingCosts: boolean): ArbResult {
  if ('error' in leg) return leg;
  if (isConsistentArbEstimate(leg) && leg.coveredCostUsdt === budget && (leg.netUsdt === null) === missingCosts) return leg;
  return { error: '公开报价的差额、收益率或成本口径不一致' };
}

const positiveLeg = (leg: ArbResult) => !('error' in leg) && positive(leg.netUsdt) && positive(leg.netBps);

function publicRow(row: ScanRow, input: ScanInput, at: number) {
  return row && (row.venue ?? 'gate') === 'gate' && (input.chain === 'all' || row.chain === input.chain)
    && isGateDepositRequest(row.symbol, row.chain) && typeof row.address === 'string' && /^0x[0-9a-f]{40}$/i.test(row.address)
    && !isSettlementOrNative(row.chain, row.address) && (row.kind === 'spot' || row.kind === 'perp')
    && [row.netBps, row.netUsdt, row.dexPrice, row.gatePrice].every(positive) && Number.isFinite(row.gasUsdt) && row.gasUsdt >= 0
    && Number.isSafeInteger(row.at) && row.at > 0 && row.at <= at && row.expiresAt === row.at + CHAIN_ARB_TTL_MS
    && !!transferAmount(row.execution);
}

function gateResults(ledger: GateDepositSource | undefined, now: () => number) {
  const evidence = new WeakMap<ScanRow, GateDepositProof>();
  // IPC returns a fresh object for the same public sample at each poll. Keep its original proof (or rejection)
  // through the scanner's history window so reconnecting cannot assign that old sample to another account.
  const samples = new Map<string, { at: number; proof?: GateDepositProof }>();

  function current(proof: GateDepositProof | undefined): proof is GateDepositProof {
    const time = now();
    return !!proof && Number.isSafeInteger(proof.at) && proof.at > 0 && proof.at <= time
      && Number.isSafeInteger(proof.expiresAt) && proof.expiresAt > time && proof.expiresAt - proof.at <= GATE_DEPOSIT_TTL
      && !!ledger?.gateDepositCurrent(proof);
  }
  async function read(symbol: string, chain: Chain, signal: AbortSignal) {
    signal.throwIfAborted();
    try {
      const proof = await ledger?.gateDepositProof(symbol, chain, signal);
      if (proof?.symbol === symbol && proof.chain === chain && tokenDecimal(proof.minDeposit) && current(proof)) return proof;
    } catch {
      signal.throwIfAborted();
      // The account read failed. Keep provider error details out of the quote and notification.
    }
  }
  function gateResultCurrent(row: ScanRow) { return current(evidence.get(row)); }

  async function single(input: ChainArbInput, view: ChainArbView, signal: AbortSignal) {
    signal.throwIfAborted();
    const withhold = (reason: string, deposit: boolean | null = null): ChainArbView => ({ ...view, deposit,
      spot: 'error' in view.spot ? view.spot : { error: reason }, perp: 'error' in view.perp ? view.perp : { error: reason } });
    if (view.deposit !== true || ('error' in view.spot && 'error' in view.perp)) return withhold(GATE_UNVERIFIED, view.deposit === false ? false : null);
    const amount = transferAmount(view.dex.execution);
    if (!amount || isSettlementOrNative(input.chain, input.address)) return withhold('未核实该代币的精确转账实收量');
    const fresh = () => view.asOf > 0 && view.asOf <= now() && view.expiresAt > now() && view.expiresAt <= view.asOf + CHAIN_ARB_TTL_MS;
    if (!fresh()) return withhold('公开报价已过期，请重新查询');
    const budget = Number(input.amount), gasMissing = input.swapGas === 'auto' && view.dex.swapGasUsdt == null;
    const spot = manualLeg(view.spot, budget, input.spotCosts === null || gasMissing);
    const perp = manualLeg(view.perp, budget, input.perpCosts === null || gasMissing);
    const publicEstimate = (): ChainArbView => {
      const estimate = (leg: ArbResult) => 'error' in leg || isManualEstimate(leg) ? leg : { error: GATE_UNVERIFIED };
      const estimates = { spot: estimate(spot), perp: estimate(perp) };
      const visible = !('error' in estimates.spot) || !('error' in estimates.perp);
      return { ...view, ...estimates, deposit: null, ...(visible ? { manualEstimateOnly: true } : {}) };
    };
    if (!positiveLeg(spot) && !positiveLeg(perp)) return publicEstimate();
    const proof = await read(input.symbol, input.chain, signal);
    signal.throwIfAborted();
    if (!fresh()) return withhold('充值核验期间公开报价已过期，请重新查询');
    if (!current(proof)) return publicEstimate();
    if (new Decimal(amount).lt(proof.minDeposit)) return withhold(BELOW_MINIMUM, true);
    return { ...view, spot, perp, expiresAt: Math.min(view.expiresAt, proof.expiresAt) };
  }

  async function scan(input: ScanInput, scope: string, view: ScanView, signal: AbortSignal): Promise<ScanView> {
    signal.throwIfAborted();
    const at = now(), live = (view.phase === 'scanning' || view.phase === 'cooldown') && view.asOf > 0 && view.asOf <= at;
    for (const [key, sample] of samples) if (at - sample.at >= SCAN_HISTORY_MS || sample.at > at) samples.delete(key);
    const keyOf = (row: ScanRow) => JSON.stringify([scope, input, row]);
    const pending = new Map<string, Promise<GateDepositProof | undefined>>();
    const candidates = live ? view.rows.filter(row => publicRow(row, input, view.asOf) && row.expiresAt > at) : [];
    await Promise.all(candidates.map(async row => {
      const key = keyOf(row);
      if (samples.has(key)) return;
      const route = row.chain + ':' + row.symbol;
      let request = pending.get(route);
      if (!request) { request = read(row.symbol, row.chain, signal); pending.set(route, request); }
      const proof = await request;
      signal.throwIfAborted();
      if (!samples.has(key)) samples.set(key, { at: row.at, proof: row.expiresAt > now() ? proof : undefined });
    }));
    signal.throwIfAborted();
    const finished = now();
    function confirmed(row: ScanRow, liveRow: boolean) {
      const proof = samples.get(keyOf(row))?.proof;
      if (!current(proof) || (liveRow && (row.expiresAt <= finished || proof.expiresAt < row.expiresAt))) return false;
      const amount = transferAmount(row.execution);
      if (!amount || new Decimal(amount).lt(proof.minDeposit)) return false;
      evidence.set(row, proof);
      return true;
    }
    const rows = candidates.filter(row => row.at <= finished && confirmed(row, true));
    const history = view.history.filter(row => publicRow(row, input, Math.min(view.asOf, finished)) && finished - row.at < SCAN_HISTORY_MS && confirmed(row, false));
    return { ...view, rows, history, message: view.message ?? (candidates.length && !rows.length ? 'Gate 候选未通过账户充值与报价有效期核验' : null) };
  }
  return { single, scan, gateResultCurrent };
}

/** The executor alone can ask the ledger for a directory. HTTP callers supply ordinary quote settings only. */
export function withChainArbLedger(market: Market, ledger?: OkxDirectorySource, now = Date.now, gateLedger?: GateDepositSource) {
  const evidence = new WeakMap<ScanView, OkxDirectory>();
  const gate = gateResults(gateLedger, now);
  async function verified<T>(signal: AbortSignal, read: (directory: OkxDirectory) => Promise<T>) {
    if (!ledger) throw unavailable('请启用资产账本并连接 OKX 只读账户');
    const directory = await ledger.okxScanDirectory(signal);
    signal.throwIfAborted();
    assertOkxDirectory(directory, now());
    const current = () => {
      if (!ledger.okxScanDirectoryCurrent(directory)) throw unavailable('OKX 只读连接或币链目录已变更，请重新核验');
    };
    current();
    const value = await read(directory);
    signal.throwIfAborted();
    current();
    return { value, directory };
  }
  return {
    async chainArb(raw: unknown, signal: AbortSignal) {
      const input = parseChainArb(raw);
      if (input.venue === 'okx') return (await verified(signal, dir => market.chainArb(raw, signal, dir))).value;
      const value = await market.chainArb(raw, signal);
      return (input.venue ?? 'gate') === 'gate' ? gate.single(input, value, signal) : value;
    },
    async scanChainArb(raw: unknown, scope: string, signal: AbortSignal, awaitBatch = false) {
      const input = parseChainArbScan(raw);
      if (input.venue === 'okx') {
        const { value, directory } = await verified(signal, dir => market.scanChainArb(raw, scope, signal, awaitBatch, dir));
        evidence.set(value, directory);
        return value;
      }
      const value = await market.scanChainArb(raw, scope, signal, awaitBatch);
      return (input.venue ?? 'gate') === 'gate' ? gate.scan(input, scope, value, signal) : value;
    },
    okxResultCurrent(view: ScanView) {
      const directory = evidence.get(view);
      return !!directory && !!ledger?.okxScanDirectoryCurrent(directory);
    },
    gateResultCurrent: gate.gateResultCurrent,
  };
}
