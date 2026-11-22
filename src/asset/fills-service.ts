// Fills of the oil and Hynix arbitrage instruments for the monitor's charts. Adapted from project_aggregation
// modules/asset/lib/hub-fills.ts at 7745181. The refresh pacing (5 min after a success, 60 s after a failure, 30 s skew
// retries up to 10 times), 15 min idle eviction, the 45 s deadline, the request budget, the 10 min overlap of incremental
// reads, the per-exchange serial queue, the fill_cache format (version 1, oil keeps the bare scope as its slot), conflict
// handling, the 2000-per-scope and 5000-per-response limits and the messages are unchanged. Changes:
// - no owner: this service has one user (cache key, fill_cache rows and credential names drop it);
// - the database comes from a getter on every use (see positions-service.ts) and runs synchronously; a fill_cache that
//   cannot be written or read (a read-only file) costs only the next cold read a full history read, as in the workbench;
// - the ANT market and its attribution (accountIdentity, attributionVersion, orderId backfill) are not ported, and the
//   local diagnostics endpoint and its metrics are left out;
// - the fetch every reader uses is injectable (tests);
// - a position snapshot that fails the read-only check (PositionsPermissionError) stops the refresh: no history is read
//   with that key, every stored scope of the credential is deleted and the scope answers FILLS_PERMISSION. The workbench
//   (hub-fills.ts 189-192) treats it like any snapshot failure and still reads the history.
import type { Credentials } from './validation.ts';
import { parseConnection } from './validation.ts';
import { POSITIONS_CATALOG } from './positions-catalog.ts';
import type { ScopeDefinition } from './positions-catalog.ts';
import type { Position } from './positions-types.ts';
import { connectionRow, connectionRows, defaultRead, revisionOf, sourceAccounts } from './positions-service.ts';
import type { DatabaseSource, Fetcher, SourceAccount, Unseal } from './positions-service.ts';
import { CYCLE_LOOKBACK_MS } from './positions-cycle.ts';
import { MAX_REQUESTS } from './positions-history.ts';
import { accountHistory, historyGeneration, historyPermission, invalidateHistory, onHistoryPermissionDenied, HISTORY_OVERLAP, type AccountHistory } from './history-cache.ts';
import { verifyAssetPermission } from './positions-readers.ts';
import { PositionsPermissionError } from './positions-values.ts';
import { verifiedPositionSnapshot } from './position-snapshots.ts';
import { fillsSupported, readFills } from './fills-readers.ts';
import type { FillsRequest } from './fills-readers.ts';
import { FillConflict, fillsNewestFirst, mergeFills, replayFills, verifyFill } from './fills-replay.ts';
import { FILL_MARKETS, FILLS_PERMISSION } from './fills-types.ts';
import type { FillMarket, FillsScope, HubFills, ReadFill } from './fills-types.ts';
import { anySignal } from '../any-signal.mjs';

const TTL = 5 * 60_000, RETRY = 60_000, IDLE = 15 * 60_000, DEADLINE = 45_000;
const SKEW_RETRY = 30_000, MAX_AUTO_RETRIES = 10;
export const FILLS_FAILED = '成交读取失败，请检查连接、读取权限及服务器时间；已保留上次数据';
/** A-5 review: the key has write permission. Fixed text; the stored fills of the account are dropped. */
// Shared with the page (fills-types.ts has no server dependencies), which shows its own wording for it.
export { FILLS_PERMISSION };
const CONFLICT = '成交记录存在冲突，暂时无法更新';
const UNSUPPORTED: Record<FillMarket, string> = { oil: '此交易所或产品范围暂不支持原油成交读取', hynix: '此交易所或产品范围暂不支持海力士成交读取' };
type ReadPositions = (credentials: Credentials, scope: string, signal: AbortSignal, fetcher: Fetcher) => Promise<Position[]>;
type ReadFills = (credentials: Credentials, scope: string, request: FillsRequest, options: { signal: AbortSignal; fetcher: Fetcher; history: AccountHistory; verify: (fill: ReadFill) => void }) => Promise<ReadFill[]>;
type Entry = {
  market: FillMarket; revision: string; scope: FillsScope; raw: ReadFill[]; touchedAt: number; retryAt: number; cursor: number | null;
  historyCursor: number | null; cacheInvalidated?: boolean; restorePending?: boolean;
  snapshotOkAt?: number; snapshotHealthy?: boolean; pending?: Promise<void>; abort?: AbortController;
  timer?: ReturnType<typeof setTimeout>; retryScheduled: boolean; automaticRetries: number;
};
// Bump whenever readFills ids/normalization or mergeFills identity change: stored raw fills are merged with new reads.
export const FILL_CACHE_FORMAT = 1;
type Stored = Pick<Entry, 'scope' | 'raw' | 'cursor' | 'retryAt' | 'snapshotOkAt' | 'snapshotHealthy'> & { version: number; historyCursor?: number | null };
// One scope per exchange across all markets and service instances: exchanges rate-limit by IP,
// so accounts of one exchange stay serial while Binance, Bybit and OKX read in parallel.
const queues = new Map<string, Promise<void>>();
function serial(exchange: string, work: () => Promise<void>) {
  const job = (queues.get(exchange) ?? Promise.resolve()).then(work);
  queues.set(exchange, job.catch(() => {}));
  return job;
}
// Oil keeps the bare scope id so rows stored before markets existed stay valid (the workbench's slot layout).
export const slotOf = (market: FillMarket, scope: string) => market === 'oil' ? scope : market + ':' + scope;
function parseSlot(slot: string): { market: FillMarket; scope: string } | null {
  const at = slot.indexOf(':'), market = slot.slice(0, at);
  if (at < 0) return { market: 'oil', scope: slot };
  return market !== 'oil' && Object.hasOwn(FILL_MARKETS, market) ? { market: market as FillMarket, scope: slot.slice(at + 1) } : null;
}
const cacheKey = (account: string, market: FillMarket, scope: string) => JSON.stringify([account, slotOf(market, scope)]);
const iso = (time: number) => new Date(time).toISOString();
function empty(scope: ScopeDefinition, configured: boolean, supported: boolean, market: FillMarket): FillsScope {
  return { id: scope.id, label: scope.label, status: !configured ? 'unconfigured' : supported ? 'loading' : 'unsupported',
    refreshing: false, fetchedAt: null, coverageStart: null, coverageEnd: null, truncated: false,
    error: configured && !supported ? UNSUPPORTED[market] : null, fills: [] };
}
function current(database: DatabaseSource, account: SourceAccount, revision: string) {
  const row = connectionRow(database(), account.key);
  return !!row && revisionOf(row.encrypted) === revision;
}
function parseStored(value: string, id: string): Stored | null {
  try {
    const data = JSON.parse(value) as Stored;
    const finite = (item: unknown) => typeof item === 'number' && Number.isFinite(item);
    if (data?.version !== FILL_CACHE_FORMAT || data.scope?.id !== id || !Array.isArray(data.raw) || !Array.isArray(data.scope.fills)
      || data.cursor !== null && !finite(data.cursor) || !finite(data.retryAt)
      || data.historyCursor !== undefined && data.historyCursor !== null
        && (!Number.isSafeInteger(data.historyCursor) || data.historyCursor < 0 || data.historyCursor > 8.64e15)) return null;
    return data;
  } catch { return null; }
}
/** The `market` query of GET /api/asset/fills: oil or hynix; null rejects the query (the workbench defaults to oil). */
export function fillsQueryMarket(params: URLSearchParams): FillMarket | null {
  const valid = [...params.keys()].every(key => key === 'schemaVersion' || key === 'market')
    && params.getAll('schemaVersion').length <= 1 && params.getAll('market').length <= 1
    && (!params.has('schemaVersion') || params.get('schemaVersion') === '1');
  const market = params.get('market') ?? 'oil';
  return valid && Object.hasOwn(FILL_MARKETS, market) ? market as FillMarket : null;
}

export type FillsServiceOptions = { now?: () => number; deadline?: number; read?: ReadPositions; fills?: ReadFills; fetcher?: Fetcher; permission?: typeof verifyAssetPermission };
export type FillsService = ReturnType<typeof createFillsService>;

/** Credentials never enter the cache. Replaced/deleted credentials abort work and invalidate cache at every poll.
 * Each successful refresh is stored in fill_cache (account fills in plain text, like ledger snapshots) under its
 * credential revision, so a restart or an entry idle for 15m serves stored fills after a positive read-only check
 * and resumes from the complete history read's cursor with a 10m overlap, even if position replay is uncertain.
 * The legacy cursor still records successful replay. Binance mode evidence older than 15m is not restored.
 * Successes refresh after 5m, failures after 60s; failed attempts also persist their retry deadline and prior rows.
 * Snapshot uncertainty schedules at most 10 consecutive automatic retries, 30s apart, then waits for a read.
 * Each refresh has a 45s total deadline, <=80 HTTP requests (including positions), no in-request retries. */
export function createFillsService(options: FillsServiceOptions = {}) {
  const now = options.now ?? Date.now, entries = new Map<string, Entry>(), jobs = new Set<Promise<void>>();
  let closed = false;
  let observed: ReturnType<DatabaseSource> = null, unsubscribe: (() => void) | undefined;
  let permissionChanges = 0;
  function observe(database: DatabaseSource) {
    const file = database();
    if (observed === file) return;
    unsubscribe?.();
    if (observed) for (const [key, entry] of entries) remove(key, entry);
    observed = file;
    if (!file) return;
    unsubscribe = onHistoryPermissionDenied(file, (account, revision) => {
      permissionChanges++;
      for (const [key, entry] of entries) {
        if (entry.revision !== revision || (JSON.parse(key) as [string])[0] !== account) continue;
        entry.cacheInvalidated = true; entry.restorePending = true; entry.raw = []; entry.cursor = null; entry.historyCursor = null;
        entry.snapshotOkAt = undefined; entry.snapshotHealthy = false; entry.retryScheduled = false; entry.automaticRetries = 0;
        entry.scope = { ...entry.scope, status: 'error', fills: [], fetchedAt: null, refreshing: false, truncated: false, coverageStart: null, coverageEnd: null, error: FILLS_PERMISSION };
        entry.retryAt = now() + RETRY;
      }
    });
  }
  // A failed cache write only costs the next cold read a full history read.
  function save(database: DatabaseSource, account: SourceAccount, entry: Entry) {
    if (historyPermission(database(), account.key, entry.revision) !== 'verified') return;
    const { market, scope, raw, cursor, historyCursor, retryAt, snapshotOkAt, snapshotHealthy } = entry;
    const stored: Stored = { version: FILL_CACHE_FORMAT, scope: { ...scope, refreshing: false }, raw, cursor, historyCursor, retryAt, snapshotOkAt, snapshotHealthy };
    try {
      database()?.prepare('INSERT INTO fill_cache(account,scope,revision,data,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(account,scope) DO UPDATE SET revision=excluded.revision,data=excluded.data,updated_at=excluded.updated_at')
        .bind(account.key, slotOf(market, scope.id), entry.revision, JSON.stringify(stored), now()).run();
    } catch { /* see above */ }
  }
  function forget(database: DatabaseSource, account: string, slot: string, revision: string) {
    try { database()?.prepare('DELETE FROM fill_cache WHERE account = ? AND scope = ? AND revision = ?').bind(account, slot, revision).run(); } catch { /* retried on the next read */ }
  }
  function storedSlot(database: DatabaseSource, account: string, market: FillMarket, id: string, revision: string) {
    if (historyPermission(database(), account, revision) !== 'verified') return null;
    const slot = slotOf(market, id);
    try {
      const row = database()?.prepare('SELECT data FROM fill_cache WHERE account = ? AND scope = ? AND revision = ?').bind(account, slot, revision).get<{ data: string }>();
      if (!row) return null;
      const stored = parseStored(row.data, id);
      if (!stored) forget(database, account, slot, revision);
      return stored;
    } catch { return null; }
  }
  function hydrate(entry: Entry, stored: Stored) {
    const tick = now();
    entry.raw = stored.raw; entry.scope = { ...stored.scope, label: entry.scope.label };
    entry.retryAt = Math.min(stored.retryAt, tick + TTL); entry.cursor = stored.cursor;
    entry.historyCursor = stored.historyCursor === undefined ? stored.cursor : stored.historyCursor;
    if (stored.snapshotOkAt !== undefined && tick - stored.snapshotOkAt < IDLE) {
      entry.snapshotOkAt = stored.snapshotOkAt; entry.snapshotHealthy = stored.snapshotHealthy;
    }
    entry.cacheInvalidated = false;
  }
  function restoreVerified(database: DatabaseSource, account: string, entry: Entry) {
    if (!entry.restorePending || historyPermission(database(), account, entry.revision) !== 'verified') return false;
    entry.restorePending = false;
    const stored = storedSlot(database, account, entry.market, entry.scope.id, entry.revision);
    if (!stored) return false;
    hydrate(entry, stored); return true;
  }
  /** Stored scopes of one market for configured accounts that are not in memory; rows of replaced or removed credentials are deleted. */
  function restore(database: DatabaseSource, accounts: SourceAccount[], market: FillMarket) {
    const restored = new Map<string, Stored | null>();
    let rows: { account: string; scope: string; revision: string }[] = [];
    try { rows = database()?.prepare('SELECT account,scope,revision FROM fill_cache').rows<{ account: string; scope: string; revision: string }>() ?? []; } catch { /* no cache */ }
    for (const row of rows) {
      const account = accounts.find(item => item.key === row.account), slot = parseSlot(row.scope);
      const definition = POSITIONS_CATALOG.find(item => item.id === account?.exchange)?.scopes.find(item => item.id === slot?.scope);
      if (!slot || !account?.row || revisionOf(account.row.encrypted) !== row.revision || !definition || !fillsSupported(account.exchange, slot.scope, slot.market)) {
        forget(database, row.account, row.scope, row.revision); continue;
      }
      // A hidden Binance mode never gets an entry; skip it rather than parse its row on every poll.
      const key = cacheKey(row.account, market, slot.scope);
      if (slot.market !== market || entries.has(key) || inactive(account, market, slot.scope, row.revision)) continue;
      restored.set(key, storedSlot(database, row.account, market, slot.scope, row.revision));
    }
    return restored;
  }
  function remove(key: string, entry: Entry) {
    clearTimeout(entry.timer); entry.timer = undefined; entry.retryScheduled = false;
    entry.abort?.abort(); entry.scope.refreshing = false;
    if (entries.get(key) === entry) entries.delete(key);
  }
  // One unref'ed lifecycle timer per entry serves either a skew retry or idle eviction.
  function arm(database: DatabaseSource, account: SourceAccount, entry: Entry, key: string, unseal: Unseal) {
    clearTimeout(entry.timer); entry.timer = undefined;
    if (closed || entries.get(key) !== entry || entry.pending) return;
    const expires = entry.touchedAt + IDLE;
    const due = entry.retryScheduled ? Math.min(expires, entry.retryAt) : expires;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      if (closed || entries.get(key) !== entry) return;
      if (now() >= entry.touchedAt + IDLE) { remove(key, entry); return; }
      if (entry.retryScheduled && now() >= entry.retryAt) refresh(database, account, entry, key, unseal, true);
      else arm(database, account, entry, key, unseal);
    }, Math.max(0, due - now()));
    entry.timer.unref?.();
  }
  function inactive(account: SourceAccount, market: FillMarket, scope: string, revision: string) {
    if (account.exchange !== 'binance' || !['um', 'pm-um', 'cm', 'pm-cm'].includes(scope)) return false;
    const own = entries.get(cacheKey(account.key, market, scope.startsWith('pm-') ? 'pm-um' : 'um'));
    const other = entries.get(cacheKey(account.key, market, scope.startsWith('pm-') ? 'um' : 'pm-um'));
    return !(own?.revision === revision && own.snapshotOkAt !== undefined)
      && other?.revision === revision && other.snapshotHealthy === true && other.snapshotOkAt !== undefined && now() - other.snapshotOkAt < IDLE;
  }
  function refresh(database: DatabaseSource, account: SourceAccount, entry: Entry, key: string, unseal: Unseal, automatic = false) {
    if (closed || entry.pending) return;
    clearTimeout(entry.timer); entry.timer = undefined; entry.retryScheduled = false;
    entry.automaticRetries = automatic ? entry.automaticRetries + 1 : 0;
    const abort = entry.abort = new AbortController();
    const generation = historyGeneration(database, account.key, entry.revision);
    const signal = anySignal([abort.signal, generation.signal]);
    entry.scope.refreshing = true;
    const valid = () => {
      if (closed || entries.get(key) !== entry || abort.signal.aborted) return false;
      if (now() >= entry.touchedAt + IDLE || !current(database, account, entry.revision)) {
        remove(key, entry); return false;
      }
      return generation.current();
    };
    const job = serial(account.exchange, async () => {
      if (!valid() || inactive(account, entry.market, entry.scope.id, entry.revision)) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      try {
        const work = async () => {
          const credentials = parseConnection(unseal(account.row!.encrypted, account.key));
          if (credentials.exchange !== account.exchange || !valid()) throw new Error(FILLS_FAILED);
          let requests = 0;
          const budgeted: Fetcher = (input, init) => {
            if (++requests > MAX_REQUESTS) throw new Error(FILLS_FAILED);
            return (options.fetcher ?? fetch)(input, init);
          };
          await generation.verify(shared => (options.permission ?? verifyAssetPermission)(credentials, budgeted, shared));
          if (!valid()) throw new Error(FILLS_FAILED);
          if (restoreVerified(database, account.key, entry) && entry.retryAt > now()) return null;
          const fetcher: Fetcher = (input, init) => {
            if (signal.aborted) throw new Error(FILLS_FAILED);
            return budgeted(input, { ...init, signal: anySignal([signal, init?.signal]) });
          };
          let snapshotStart = now(), snapshotAt: number;
          let positions: Position[] | null = null;
          try {
            const scope = entry.scope.id;
            const snapshot = await verifiedPositionSnapshot({ database, account, scope, revision: entry.revision, generation, signal, now }, shared => {
              const sourceFetch: Fetcher = (input, init) => budgeted(input, { ...init, signal: anySignal([shared, init?.signal]) });
              return options.read ? options.read(credentials, scope, shared, sourceFetch)
                : defaultRead(credentials, scope, shared, sourceFetch, generation.assertVerified);
            });
            if (!valid()) throw new Error(FILLS_FAILED);
            positions = snapshot.positions; snapshotStart = snapshot.startedAt; snapshotAt = snapshot.completedAt;
            entry.snapshotOkAt = snapshotStart; entry.snapshotHealthy = true;
          } catch (error) {
            entry.snapshotHealthy = false;
            // Unlike the workbench (hub-fills.ts reads history anyway), a key that fails the read-only check reads nothing more.
            if (error instanceof PositionsPermissionError) throw error;
            if (abort.signal.aborted) throw new Error(FILLS_FAILED);
            snapshotAt = Math.max(snapshotStart, now());
          }
          if (!valid()) throw new Error(FILLS_FAILED);
          // The real observation anchors older windows; the newest history query has no local upper bound.
          const lookback = snapshotAt - CYCLE_LOOKBACK_MS;
          const start = Math.max(lookback, entry.historyCursor === null ? lookback : Math.min(entry.historyCursor, snapshotAt) - HISTORY_OVERLAP);
          const history = accountHistory(database, account.key, entry.revision, entry.scope.id, valid, generation);
          const known = new Map(entry.raw.filter(fill => Date.parse(fill.time) >= lookback).map(fill => [fill.id, fill]));
          const verify = (fill: ReadFill) => { verifyFill(known.get(fill.id), fill); known.set(fill.id, fill); };
          const incoming = await (options.fills ?? readFills)(credentials, entry.scope.id, { market: entry.market, start, end: snapshotAt }, { signal, fetcher, history, verify });
          if (!valid()) throw new Error(FILLS_FAILED);
          const raw = mergeFills(entry.raw, incoming, lookback);
          if (raw.some(fill => Date.parse(fill.time) > now() + 60_000)) throw new Error(FILLS_FAILED);
          const replayed = replayFills(raw, positions, snapshotStart, account.exchange);
          return { raw, replayed, snapshotAt, positions, lookback };
        };
        const result = await Promise.race([work(), new Promise<never>((_, reject) => {
          onAbort = () => reject(new Error(FILLS_FAILED));
          abort.signal.addEventListener('abort', onAbort, { once: true });
          timer = setTimeout(() => abort.abort(), options.deadline ?? DEADLINE);
          if (abort.signal.aborted) onAbort();
        })]);
        if (!result || !valid()) return;
        const { raw, replayed, snapshotAt, positions, lookback } = result;
        const truncated = raw.length > 2000 || (entry.scope.truncated && Date.parse(entry.scope.coverageStart ?? '') > lookback);
        entry.raw = raw.slice(0, 2000);
        const fills = replayed.fills.slice(0, 2000);
        entry.scope = { ...entry.scope, fills, truncated, refreshing: false,
          status: positions === null ? entry.scope.fetchedAt ? 'stale' : 'error' : 'live',
          error: positions === null ? '持仓快照读取失败，成交开平仓方向暂不可用' : null,
          fetchedAt: positions === null ? entry.scope.fetchedAt : iso(snapshotAt),
          coverageStart: truncated && fills.length ? fills[fills.length - 1]!.time : iso(lookback),
          // Coverage includes exchange-clock fills ahead of local snapshot completion (bounded above by now+60s).
          coverageEnd: iso(Math.max(snapshotAt, raw.length ? Date.parse(raw[0]!.time) : snapshotAt)) };
        // Complete, validated history is independent of whether the current position can explain its fills.
        // Only the presentation replay waits for a trustworthy snapshot; retries reuse the stored raw rows.
        entry.historyCursor = snapshotAt; entry.cacheInvalidated = false;
        if (!replayed.skew && positions !== null) entry.cursor = snapshotAt;
        entry.retryAt = now() + (replayed.skew ? SKEW_RETRY : positions === null ? RETRY : TTL);
        entry.retryScheduled = replayed.skew && entry.automaticRetries < MAX_AUTO_RETRIES;
        if (entries.get(key) === entry && !abort.signal.aborted) save(database, account, entry);
      } catch (error) {
        if (error instanceof PositionsPermissionError) {
          generation.deny();
          return;
        }
        if (!generation.current()) return;
        if (historyPermission(database(), account.key, entry.revision) === 'denied') { entry.retryAt = now() + RETRY; return; }
        // A conflicting stored history must not outlive this process; the next cold read starts over.
        if (error instanceof FillConflict) {
          entry.cacheInvalidated = true; entry.cursor = null; entry.historyCursor = null;
          invalidateHistory(database(), account.key, entry.revision, { scope: entry.scope.id, slot: slotOf(entry.market, entry.scope.id), records: error.records });
        }
        let still = false;
        try { still = current(database, account, entry.revision); } catch { /* the file is gone */ }
        if (entries.get(key) === entry && still) {
          entry.scope = { ...entry.scope, status: error instanceof FillConflict ? 'error' : entry.scope.fetchedAt ? 'stale' : 'error',
            error: error instanceof FillConflict ? CONFLICT : FILLS_FAILED };
          entry.retryAt = now() + RETRY;
          // A later transport failure must not resurrect a cache invalidated by a content conflict.
          if (!entry.cacheInvalidated) save(database, account, entry);
        }
      } finally { clearTimeout(timer); if (onAbort) abort.signal.removeEventListener('abort', onAbort); }
    }).catch(() => {
      if (generation.current() && entries.get(key) === entry) { entry.scope.status = entry.scope.fetchedAt ? 'stale' : 'error'; entry.scope.error = FILLS_FAILED; entry.retryAt = now() + RETRY; }
    }).finally(() => {
      entry.pending = undefined; entry.abort = undefined; jobs.delete(job);
      entry.scope.refreshing = entry.retryScheduled;
      arm(database, account, entry, key, unseal);
    });
    entry.pending = job; jobs.add(job);
  }
  const service = {
    async read(database: DatabaseSource, unseal: Unseal, market: FillMarket = 'oil'): Promise<HubFills> {
      if (closed) throw new Error(FILLS_FAILED);
      observe(database);
      const permissionVersion = permissionChanges;
      const accounts = sourceAccounts(database()), tick = now(), keep = new Set<string>();
      for (const [key, entry] of entries) {
        const [accountKey] = JSON.parse(key) as [string];
        const account = accounts.find(item => item.key === accountKey);
        if (tick - entry.touchedAt >= IDLE || !account?.row || revisionOf(account.row.encrypted) !== entry.revision) remove(key, entry);
      }
      const restored = restore(database, accounts, market);
      const exchanges: HubFills['exchanges'] = POSITIONS_CATALOG.map(exchange => ({ id: exchange.id, name: exchange.name,
        accounts: accounts.filter(account => account.exchange === exchange.id).map(account => {
          const revision = account.row ? revisionOf(account.row.encrypted) : null;
          // Probe PM first; a successful PM snapshot suppresses the queued classic probe and its fapi history.
          const definitions = [...exchange.scopes].sort((a, b) => Number(b.id === 'pm-um') - Number(a.id === 'pm-um'));
          const scopes = definitions.flatMap(definition => {
            const key = cacheKey(account.key, market, definition.id); keep.add(key);
            const supported = fillsSupported(exchange.id, definition.id, market);
            if (!revision) return [empty(definition, false, supported, market)];
            if (inactive(account, market, definition.id, revision)) return [];
            if (!supported) return [empty(definition, true, false, market)];
            let entry = entries.get(key);
            if (!entry) {
              const stored = restored.get(key);
              entry = { market, revision, scope: empty(definition, true, true, market), raw: [], touchedAt: tick, retryAt: -Infinity,
                cursor: null, historyCursor: null, retryScheduled: false, automaticRetries: 0,
                restorePending: stored === null };
              if (stored) hydrate(entry, stored);
              if (historyPermission(database(), account.key, revision) === 'denied') {
                entry.scope.status = 'error'; entry.scope.error = FILLS_PERMISSION; entry.cacheInvalidated = true;
              }
              entries.set(key, entry);
            }
            entry.touchedAt = tick;
            if (!entry.pending && historyPermission(database(), account.key, revision) === 'verified') {
              if (!restoreVerified(database, account.key, entry) && entry.scope.error === FILLS_PERMISSION) entry.retryAt = -Infinity;
            }
            if (!entry.pending && tick >= entry.retryAt) refresh(database, account, entry, key, unseal, entry.retryScheduled);
            else arm(database, account, entry, key, unseal);
            const scope = { ...entry.scope, refreshing: !!entry.pending || entry.retryScheduled,
              fills: entry.scope.fills.filter(fill => Date.parse(fill.time) >= tick - CYCLE_LOOKBACK_MS).map(fill => ({ ...fill })) };
            if (scope.coverageStart && Date.parse(scope.coverageStart) < tick - CYCLE_LOOKBACK_MS) {
              scope.coverageStart = scope.coverageEnd && Date.parse(scope.coverageEnd) < tick - CYCLE_LOOKBACK_MS ? scope.coverageEnd : iso(tick - CYCLE_LOOKBACK_MS);
            }
            if (scope.status === 'live' && scope.fetchedAt && tick - Date.parse(scope.fetchedAt) >= IDLE) scope.status = 'stale';
            return [scope];
          });
          scopes.sort((a, b) => exchange.scopes.findIndex(item => item.id === a.id) - exchange.scopes.findIndex(item => item.id === b.id));
          return { id: account.id, name: account.name, configured: !!revision, revision, scopes };
        }),
      }));
      for (const [key, entry] of entries) if (entry.market === market && !keep.has(key)) remove(key, entry);
      // The workbench awaits its asynchronous database here and re-checks the connections. With this synchronous database
      // the re-check below only covers writes already queued as microtasks; a replaced key is kept out by the revision in
      // every cache key and by the current() checks before and after each refresh, not by this yield.
      await Promise.resolve();
      if (permissionVersion !== permissionChanges) return service.read(database, unseal, market);
      const latest = connectionRows(database());
      for (const account of accounts) {
        const row = latest.find(item => item.exchange === account.key);
        if ((row?.encrypted ?? null) !== (account.row?.encrypted ?? null)) {
          for (const [key, entry] of entries) if ((JSON.parse(key) as [string])[0] === account.key) remove(key, entry);
          throw new Error(FILLS_FAILED);
        }
      }
      // Gate connections exist in the asset ledger but not in the positions catalog.
      const gate = latest.find(item => item.exchange === 'gate');
      if (gate) exchanges.push({ id: 'gate', name: 'Gate', accounts: [{
        id: 'default', name: '默认账号', configured: true, revision: revisionOf(gate.encrypted),
        scopes: [empty({ id: 'portfolio', label: '账户资产' }, true, false, market)],
      }] });
      const scopes = exchanges.flatMap(exchange => exchange.accounts.flatMap(account => account.scopes));
      const retained = new Set(scopes.flatMap(scope => scope.fills).sort(fillsNewestFirst).slice(0, 5000));
      for (const scope of scopes) {
        const fills = scope.fills.filter(fill => retained.has(fill));
        if (fills.length !== scope.fills.length) { scope.truncated = true; scope.coverageStart = fills.at(-1)?.time ?? null; scope.fills = fills; }
      }
      return { schemaVersion: 1, generatedAt: iso(tick), lookbackStart: iso(tick - CYCLE_LOOKBACK_MS), exchanges };
    },
    async idle() { while (jobs.size) await Promise.allSettled([...jobs]); },
    close() { closed = true; unsubscribe?.(); for (const [key, entry] of entries) remove(key, entry); },
  };
  return service;
}
