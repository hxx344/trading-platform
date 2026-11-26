import { anySignal } from '../any-signal.mjs';
import { isGateDepositRequest, type GateDepositProof, type GateDepositSource } from '../chain-arb/gate-deposit-proof.ts';
import type { AssetDb } from './db.ts';
import { historyGeneration } from './history-cache.ts';
import { revisionOf, type Unseal } from './positions-service.ts';
import { PositionsPermissionError } from './positions-values.ts';
import { GateDepositThrottle, GATE_DEPOSIT_UNAVAILABLE, readGateDeposit } from './sources/gate-deposit.ts';
import { untilAborted } from './sources/shared-reads.ts';
import { parseConnection } from './validation.ts';
import type { GateCredential } from './sources/gate.ts';

type Connection = { database: AssetDb; importedAt: string; encrypted: string; keyFile: string };
type Deposit = Awaited<ReturnType<typeof readGateDeposit>>;
type Job = { controller: AbortController; work: Promise<Deposit>; waiters: number };
type Entry = { latest?: Deposit; job?: Job; retryAt: number };
type Scope = Connection & { entries: Map<string, Entry>; stop: AbortController; permission: ReturnType<typeof historyGeneration> };
const invalid = () => new Error(GATE_DEPOSIT_UNAVAILABLE);
const MAX_COINS = 256, MAX_CONCURRENT = 2, MAX_PER_SECOND = 4;
function sameConnection(a: Connection, b: Connection): boolean {
  return a.database === b.database && a.encrypted === b.encrypted && a.importedAt === b.importedAt && a.keyFile === b.keyFile;
}

export function createGateDepositSource(connection: () => Connection | null, unseal: Unseal, fetcher: typeof fetch, now: () => number):
  GateDepositSource & { watchReconnect(candidate: GateCredential): (() => void) | undefined; reset(): void; close(): void } {
  let scope: Scope | undefined, closed = false, changedAt = 0, nextAllowed = 0, running = 0;
  const recent: number[] = [];
  function reset() {
    const old = scope;
    scope = undefined;
    if (old) { changedAt = Math.max(changedAt, now()); old.stop.abort(); }
  }
  function observed() {
    if (closed) return;
    let found: Connection | null;
    try { found = connection(); } catch { reset(); throw invalid(); }
    if (scope && (!found || !sameConnection(found, scope))) reset();
    // Permission invalidation records its own time. A later observation must not move that time forward.
    if (scope && !scope.permission.current()) { const old = scope; scope = undefined; old.stop.abort(); }
    if (found && !scope) {
      const database = found.database;
      scope = { ...found, entries: new Map(), stop: new AbortController(),
        permission: historyGeneration(() => database, 'gate', revisionOf(found.encrypted), now) };
    }
    return scope;
  }
  function fresh(value: Deposit | undefined): value is Deposit {
    const time = now();
    return !!value && value.at <= time && time < value.expiresAt;
  }
  function recipient(proof: GateDepositProof): string | undefined {
    try {
      const entry = observed()?.entries.get(proof.symbol);
      if (!entry?.latest) return;
      if (!fresh(entry.latest)) { delete entry.latest; return; }
      if (entry.latest.rows.get(proof.chain) === proof) return entry.latest.recipients.get(proof);
    } catch { return; }
  }
  function start(saved: Scope, symbol: string, entry: Entry) {
    const started = now();
    while (recent.length && started - recent[0] >= 1000) recent.shift();
    if (running >= MAX_CONCURRENT || started < nextAllowed || recent.length >= MAX_PER_SECOND || started < entry.retryAt) throw invalid();
    if (!saved.entries.has(symbol)) {
      if (saved.entries.size >= MAX_COINS) {
        const oldest = [...saved.entries].find(([, value]) => !value.job);
        if (!oldest) throw invalid();
        saved.entries.delete(oldest[0]);
      }
      saved.entries.set(symbol, entry);
    }
    delete entry.latest;
    recent.push(started);
    running++;
    const controller = new AbortController(), signal = anySignal([saved.stop.signal, saved.permission.signal, controller.signal], 8_000);
    const check = () => {
      signal.throwIfAborted();
      if (observed() !== saved || now() < started) throw invalid();
    };
    const read = async () => {
      try {
        const c = parseConnection(unseal(saved.encrypted, 'gate'));
        if (c.exchange !== 'gate') throw invalid();
        const result = await readGateDeposit(c, symbol, fetcher, signal, now, Math.max(changedAt, saved.permission.deniedAt), check);
        check();
        if (!fresh(result)) throw invalid();
        entry.latest = result;
        return result;
      } catch (error) {
        check();
        entry.retryAt = now() + 3000;
        if (error instanceof GateDepositThrottle) nextAllowed = now() + 60_000;
        if (error instanceof PositionsPermissionError) { nextAllowed = Math.max(nextAllowed, now() + 3000); saved.permission.deny(); }
        throw invalid();
      }
    };
    const work = untilAborted(read(), signal).finally(() => { running--; });
    return { controller, work, waiters: 0 };
  }
  return {
    gateDepositRecipient: recipient,
    gateDepositCurrent: proof => !!recipient(proof),
    watchReconnect(candidate) {
      try {
        const saved = observed();
        if (!saved) return;
        const c = parseConnection(unseal(saved.encrypted, 'gate'));
        if (c.exchange !== 'gate' || c.apiKey !== candidate.apiKey || c.apiSecret !== candidate.apiSecret) return;
        return () => {
          const active = observed();
          if (active && sameConnection(active, saved)) active.permission.deny();
        };
      } catch { return; } // A damaged previous connection must still be replaceable.
    },
    async gateDepositProof(symbol, chain, signal) {
      try {
        signal.throwIfAborted();
        if (!isGateDepositRequest(symbol, chain)) throw invalid();
        const saved = observed();
        if (!saved) throw invalid();
        const entry = saved.entries.get(symbol) ?? { retryAt: 0 };
        let value = entry.latest;
        if (!fresh(value)) {
          if (!entry.job || entry.job.controller.signal.aborted) entry.job = start(saved, symbol, entry);
          const job = entry.job;
          if (job.waiters >= 16) throw invalid();
          job.waiters++;
          try { value = await untilAborted(job.work, signal); }
          finally {
            if (--job.waiters === 0) {
              job.controller.abort();
              if (entry.job === job) delete entry.job;
            }
          }
        }
        signal.throwIfAborted();
        const proof = value.rows.get(chain);
        if (!proof || !recipient(proof)) throw invalid();
        return proof;
      } catch { throw invalid(); }
    },
    reset,
    close() { closed = true; reset(); },
  };
}
