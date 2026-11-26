import { anySignal } from '../any-signal.mjs';
import { BINANCE_DEPOSIT_TTL, type BinanceDepositProof, type BinanceDepositSource } from '../chain-arb/binance-deposit-proof.ts';
import { isGateBaseSymbol } from '../chain-arb/model.ts';
import { isSettlementOrNative } from '../chain-arb/networks.ts';
import type { AssetDb } from './db.ts';
import { historyGeneration } from './history-cache.ts';
import { revisionOf, type Unseal } from './positions-service.ts';
import { PositionsPermissionError } from './positions-values.ts';
import { parseConnection } from './validation.ts';
import { binanceDepositUnavailable as invalid, evmAddress, readBinanceDepositAddress, readBinanceDepositNetworks } from './sources/binance-deposit.ts';
import { BinanceReadThrottle } from './sources/binance-wallet.ts';
import type { BinanceCredential } from './sources/exchanges.ts';
import { untilAborted } from './sources/shared-reads.ts';

type Connection = { database: AssetDb; importedAt: string; encrypted: string; keyFile: string };
type Times = { at: number; expiresAt: number };
type Job<T> = { work: Promise<T>; stop: AbortController; waiters: number };
type Slot<T> = { latest?: T; job?: Job<T>; retryAt?: number };
type Directory = Awaited<ReturnType<typeof readBinanceDepositNetworks>>;
type Deposit = Times & { proof: BinanceDepositProof; address: string };
type Context = Parameters<typeof readBinanceDepositNetworks>[0];
type Scope = Connection & { directory: Slot<Directory>; deposits: Map<string, Slot<Deposit>>; stop: AbortController; permission: ReturnType<typeof historyGeneration> };
const same = (a: Connection, b: Connection) => a.database === b.database && a.encrypted === b.encrypted && a.importedAt === b.importedAt && a.keyFile === b.keyFile;

export function createBinanceDepositSource(connection: () => Connection | null, unseal: Unseal, fetcher: typeof fetch, now: () => number):
  BinanceDepositSource & { watchReconnect(c: BinanceCredential): (() => void) | undefined; reset(): void; close(): void } {
  let scope: Scope | undefined, closed = false, changedAt = 0, retryAt = 0, running = 0;
  const starts: number[] = [];
  function reset() {
    const old = scope;
    scope = undefined;
    if (old) { changedAt = Math.max(changedAt, now()); old.stop.abort(); }
  }
  function observe() {
    if (closed) return;
    let found: Connection | null;
    try { found = connection(); } catch { reset(); throw invalid(); }
    if (scope && (!found || !same(scope, found))) reset();
    if (scope && !scope.permission.current()) { const old = scope; scope = undefined; old.stop.abort(); }
    if (!scope && found) {
      const database = found.database;
      scope = { ...found, directory: {}, deposits: new Map(), stop: new AbortController(),
        permission: historyGeneration(() => database, 'binance', revisionOf(found.encrypted), now) };
    }
    return scope;
  }
  function credential(saved: Scope) {
    const c = parseConnection(unseal(saved.encrypted, 'binance'));
    if (c.exchange !== 'binance') throw invalid();
    return c;
  }
  function denyIfSame(saved: Scope) {
    const active = observe();
    if (active && same(active, saved)) active.permission.deny();
  }
  function fresh<T extends Times>(slot: Slot<T>) {
    const value = slot.latest, time = now();
    if (value && value.at <= time && time < value.expiresAt) return value;
    delete slot.latest;
  }
  function recipient(proof: BinanceDepositProof) {
    try {
      const saved = observe();
      if (!saved || !fresh(saved.directory)) return;
      const slot = saved.deposits.get(proof.symbol + ':' + proof.chain);
      const result = slot && fresh(slot);
      return result?.proof === proof ? result.address : undefined;
    } catch { return; }
  }
  // Permissions and the balance-free network projection are shared across symbols. Address reads share only an exact coin/network.
  async function load<T extends Times>(saved: Scope, slot: Slot<T>, caller: AbortSignal, read: (ctx: Context) => Promise<T>): Promise<T> {
    caller.throwIfAborted();
    const value = fresh(slot);
    if (value) return value;
    if (!slot.job || slot.job.stop.signal.aborted) {
      const started = now();
      while (starts.length && started - starts[0] >= 1000) starts.shift();
      if (running >= 3 || starts.length >= 6 || started < Math.max(retryAt, slot.retryAt ?? 0)) throw invalid();
      starts.push(started); running++;
      const stop = new AbortController(), signal = anySignal([stop.signal, saved.stop.signal, saved.permission.signal], 8_000);
      const check = () => {
        signal.throwIfAborted();
        if (observe() !== saved || now() < started || now() < retryAt) throw invalid();
      };
      const run = async () => {
        try {
          const result = await read({ credential: credential(saved), fetcher, signal, now, deniedAt: Math.max(changedAt, saved.permission.deniedAt), check });
          check();
          if (now() < result.at || now() >= result.expiresAt) throw invalid();
          slot.latest = result;
          return result;
        } catch (error) {
          if (error instanceof BinanceReadThrottle) retryAt = Math.max(retryAt, now() + error.delay);
          if (error instanceof PositionsPermissionError) {
            denyIfSame(saved);
            if (scope && same(scope, saved)) retryAt = Math.max(retryAt, now() + 3000);
          }
          if (!signal.aborted && observe() === saved) slot.retryAt = now() + 3000;
          throw invalid();
        }
      };
      slot.job = { stop, waiters: 0, work: untilAborted(run(), signal).finally(() => { running--; }) };
    }
    const job = slot.job;
    if (job.waiters >= 16) throw invalid();
    job.waiters++;
    try { return await untilAborted(job.work, caller); }
    finally {
      if (--job.waiters === 0) { job.stop.abort(); if (slot.job === job) delete slot.job; }
    }
  }
  return {
    async binanceDepositProof(symbol, chain, contract, signal) {
      try {
        signal.throwIfAborted();
        if (!isGateBaseSymbol(symbol) || (chain !== 'ethereum' && chain !== 'arbitrum' && chain !== 'bsc') || !evmAddress(contract)
          || isSettlementOrNative(chain, contract)) throw invalid();
        const saved = observe();
        if (!saved) throw invalid();
        const directory = await load(saved, saved.directory, signal, async ctx => {
          const value = await readBinanceDepositNetworks(ctx);
          saved.deposits.clear();
          return value;
        });
        const key = symbol + ':' + chain, row = directory.rows.get(key);
        if (!row || row.contract !== contract.toLowerCase() || observe() !== saved || fresh(saved.directory) !== directory) throw invalid();
        let slot = saved.deposits.get(key);
        if (!slot) saved.deposits.set(key, slot = {});
        const result = await load(saved, slot, signal, async ctx => {
          const answer = await readBinanceDepositAddress(ctx, row);
          if (fresh(saved.directory) !== directory) throw invalid();
          const at = Math.min(directory.at, answer.at), expiresAt = at + BINANCE_DEPOSIT_TTL;
          const proof = Object.freeze({ symbol, chain, contract: row.contract, minDeposit: row.minDeposit, at, expiresAt });
          return { proof, address: answer.address, at, expiresAt };
        });
        signal.throwIfAborted();
        if (!recipient(result.proof)) throw invalid();
        return result.proof;
      } catch { throw invalid(); }
    },
    binanceDepositRecipient: recipient,
    binanceDepositCurrent: proof => !!recipient(proof),
    watchReconnect(candidate) {
      try {
        const saved = observe();
        if (!saved) return;
        const c = credential(saved);
        if (candidate.apiKey !== c.apiKey || candidate.apiSecret !== c.apiSecret) return;
        return () => denyIfSame(saved);
      } catch { return; }
    },
    reset,
    close() { closed = true; reset(); },
  };
}
