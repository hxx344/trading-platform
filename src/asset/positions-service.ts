// Live positions of the saved asset connections. Adapted from project_aggregation modules/asset/lib/hub-positions.ts at
// 7745181 (same as 0014655). The cache, refresh pacing (5 s, 30 s for Variational and Lighter RH), the 25 s deadline,
// 90 s staleness, 15 min idle eviction, the concurrency limits (3 reads, 1 cycle summary), the Binance account-mode
// exclusion, the connection re-check before answering and the daily-snapshot peek are unchanged. Changes:
// - no owner: this service has one user, so the cache key, the connection queries and the credential names drop it
//   (credential names are the connection names, as in sync.ts);
// - the database comes from a getter on every use instead of a long-lived handle: store.ts drops and reopens its handle
//   when the file is imported again, and a missing handle (or a file without a connections table) reads as no
//   connections, so a credential that disappears stops the read;
// - the statements run synchronously (node:sqlite), so peek is synchronous and can run inside a write's transaction;
// - unseal is the local vault (synchronous); the fetch every reader uses is injectable (tests);
// - close() stops every entry (the workbench's service lives as long as its process).
import { createHash } from 'node:crypto';
import type { AssetDb, SnapshotDb } from './db.ts';
import { parseConnection, type Credentials } from './validation.ts';
import { POSITIONS_CATALOG } from './positions-catalog.ts';
import type { PositionsExchangeId, ScopeDefinition } from './positions-catalog.ts';
import type { HubPositions, Position, PositionCycle, PositionsScope } from './positions-types.ts';
import type { SnapshotScope } from './daily-positions.ts';
import { POSITIONS_FAILED, PositionsPermissionError } from './positions-values.ts';
import { accountHistory, historyGeneration, historyPermission, type AccountHistory, type HistoryGeneration } from './history-cache.ts';
import { POSITION_DISPLAY_AGE, POSITION_TTL, verifiedPositionSnapshot } from './position-snapshots.ts';
import { cycleUnavailable } from './positions-cycle.ts';
import { boundPositionEvidence } from './positions-evidence.ts';
import { cycleSupported, CycleRetry, readPositionCycle } from './positions-cycle-readers.ts';
import type { CycleRequest } from './positions-cycle-readers.ts';
import { readBinancePositions, readBybitPositions, readOkxPositions, readAsterPositions, verifyAssetPermission } from './positions-readers.ts';
import type { BinanceScope, BybitScope } from './positions-readers.ts';
import { readVariationalPythonPositions } from './sources/variational-python.ts';
import { readRhLighterPositions } from './sources/rh-lighter.ts';
import { readHyperliquidPositions } from './sources/hyperliquid.ts';
import { anySignal } from '../any-signal.mjs';

export type Database = Pick<AssetDb, 'prepare'>;
/** The open asset.sqlite at the moment of the call; null before the first import. */
export type DatabaseSource = () => Pick<AssetDb, 'prepare' | 'transaction'> | null;
export type ConnectionRow = { exchange: string; encrypted: string };
export type SourceAccount = { id: string; name: string; exchange: PositionsExchangeId; key: string; row?: ConnectionRow };
export type Unseal = (encrypted: string, name: string) => unknown;
export type Fetcher = typeof fetch;
type Read = (credentials: Credentials, scope: string, signal: AbortSignal) => Promise<Position[]>;
type CycleRead = (credentials: Credentials, scope: string, request: CycleRequest, signal: AbortSignal, history: AccountHistory) => Promise<PositionCycle>;
/** `entryPrice` joins the signature so a close and same-size reopen between two reads is not mistaken for the old cycle. */
type CycleSlot = { side: Position['side']; quantity: string; entryPrice: string | null; cycle: PositionCycle; at: number };
type Entry = { revision: string; scope: PositionsScope; attemptedAt: number; touchedAt: number; pending?: Promise<void>; abort?: AbortController;
  restoredUnder?: HistoryGeneration; cycles?: Map<string, CycleSlot>; cycleGeneration?: HistoryGeneration; cycleJob?: Promise<void>; cycleAbort?: AbortController };
// Variational reads start a Python process per refresh. Lighter RH shares a 60-requests-per-minute limit with other
// modules; its reader also reuses one account read per address for 30 seconds.
const SLOW_TTL: Partial<Record<PositionsExchangeId, number>> = { variational: 30_000, 'rh-lighter': 30_000, hyperliquid: 30_000 };
const STALE_AFTER = 90_000;
const DEADLINE = 25_000;
const SNAPSHOT_WAIT = 12_000;
const IDLE = 15 * 60_000;
// Cycle summaries walk fill history, so they refresh far less often than positions: on a quantity change after
// CYCLE_MIN_AGE, otherwise after CYCLE_TTL (CYCLE_RETRY after a failure). One summary is read at a time globally.
const CYCLE_TTL = 5 * 60_000, CYCLE_RETRY = 60_000, CYCLE_MIN_AGE = 30_000, CYCLE_DEADLINE = 45_000;
const CYCLE_LOADING = '正在统计本轮平仓…';
export const revisionOf = (value: string) => createHash('sha256').update(value).digest('hex');

export async function defaultRead(credentials: Credentials, scope: string, signal: AbortSignal, fetcher: Fetcher = fetch, authorized?: () => void): Promise<Position[]> {
  switch (credentials.exchange) {
    case 'binance': return readBinancePositions(credentials, fetcher, signal, scope as BinanceScope, authorized);
    case 'bybit': return readBybitPositions(credentials, scope as BybitScope, fetcher, signal, authorized);
    case 'okx': return readOkxPositions(credentials, scope as 'SWAP' | 'FUTURES', fetcher, signal, authorized);
    case 'aster': return readAsterPositions(credentials, fetcher, signal);
    case 'variational': return readVariationalPythonPositions(credentials, signal);
    case 'rh-lighter': return readRhLighterPositions(credentials, fetcher, signal);
    default: throw new Error(POSITIONS_FAILED);
  }
}

/** A file imported before A-3 and opened read-only has no connections table: nothing is connected. */
function withoutTable<T>(read: () => T, empty: T): T {
  try { return read(); }
  catch (error) { if (error instanceof Error && /no such table/.test(error.message)) return empty; throw error; }
}
export function connectionRows(database: Database | null): ConnectionRow[] {
  return database ? withoutTable(() => database.prepare('SELECT exchange,encrypted FROM connections').rows<ConnectionRow>(), []) : [];
}
export function connectionRow(database: Database | SnapshotDb | null, key: string): { encrypted: string } | null {
  return database ? withoutTable(() => database.prepare('SELECT encrypted FROM connections WHERE exchange = ?').bind(key).get<{ encrypted: string }>(), null) : null;
}

export function sourceAccounts(database: Database | null): SourceAccount[] {
  const stored = connectionRows(database);
  const settings = database ? withoutTable(() => database.prepare('SELECT value FROM settings WHERE key = ?').bind('aster-accounts').get<{ value: string }>(), null) : null;
  const accounts: SourceAccount[] = POSITIONS_CATALOG.filter(item => item.id !== 'aster').map(item => ({
    id: 'default', name: '默认账号', exchange: item.id, key: item.id, row: stored.find(row => row.exchange === item.id),
  }));
  const aster = new Map<string, string>();
  if (settings) {
    const values: unknown = JSON.parse(settings.value);
    if (!Array.isArray(values) || values.length > 10) throw new Error(POSITIONS_FAILED);
    for (const value of values) {
      if (!value || typeof value !== 'object' || !/^(default|[a-f0-9-]{36})$/i.test(value.id) || typeof value.name !== 'string' || value.name.length > 40) throw new Error(POSITIONS_FAILED);
      aster.set(value.id, value.name);
    }
  }
  for (const row of stored) {
    const id = row.exchange === 'aster' ? 'default' : row.exchange.startsWith('aster:') ? row.exchange.slice(6) : null;
    if (id && /^(default|[a-f0-9-]{36})$/i.test(id) && !aster.has(id)) aster.set(id, id === 'default' ? '默认账号' : 'Aster 账号');
  }
  if (!aster.size) aster.set('default', '默认账号');
  for (const [id, name] of aster) {
    const key = id === 'default' ? 'aster' : 'aster:' + id;
    accounts.push({ id, name, exchange: 'aster', key, row: stored.find(row => row.exchange === key) });
  }
  return accounts;
}

export type PositionsServiceOptions = { now?: () => number; ttl?: number; deadline?: number; concurrency?: number; read?: Read; cycle?: CycleRead | null; fetcher?: Fetcher; permission?: typeof verifyAssetPermission };
export type PositionsService = ReturnType<typeof createPositionsService>;

/** Each poll reads current vault revisions. Only normalized positions of positively verified connections can be restored. */
export function createPositionsService(options: PositionsServiceOptions = {}) {
  const now = options.now ?? Date.now;
  const fetcher = options.fetcher ?? fetch;
  const defaultCycle: CycleRead = (credentials, scope, request, signal, history) => readPositionCycle(credentials, scope, request, { signal, fetcher, now, history });
  // An injected position reader has no matching fill history unless a cycle reader is injected with it.
  const cycleRead = options.cycle !== undefined ? options.cycle : options.read ? null : defaultCycle;
  const cyclesFor = (exchange: PositionsExchangeId, scope: string) => !!cycleRead && cycleSupported(exchange, scope);
  const ttlFor = (exchange: PositionsExchangeId) => options.ttl ?? SLOW_TTL[exchange] ?? POSITION_TTL;
  const entries = new Map<string, Entry>();
  let activeFile: Database | null = null;
  function limiter(limit: number) {
    let active = 0;
    const queue: (() => void)[] = [];
    return async (work: () => Promise<void>) => {
      if (active >= limit) await new Promise<void>(resolve => queue.push(resolve));
      else active++;
      try { await work(); } finally { const next = queue.shift(); if (next) next(); else active--; }
    };
  }
  const limited = limiter(Math.max(1, Math.min(3, options.concurrency ?? 3))), cycleLimited = limiter(1);
  const stop = (entry: Entry) => { entry.abort?.abort(); entry.cycleAbort?.abort(); };
  const cacheKey = (key: string, scope: string) => JSON.stringify([key, scope]);
  function selectFile(file: Database | null) {
    if (file === activeFile) return;
    for (const entry of entries.values()) stop(entry);
    entries.clear(); activeFile = file;
  }
  function hideRevoked(scope: PositionsScope) {
    scope.status = 'error'; scope.positions = []; scope.fetchedAt = null; scope.error = POSITIONS_FAILED;
  }
  function checkRestored(entry: Entry) {
    if (!entry.restoredUnder) return;
    const age = now() - Date.parse(entry.scope.fetchedAt ?? '');
    if (entry.restoredUnder.current() && age >= 0 && age < POSITION_DISPLAY_AGE) return;
    hideRevoked(entry.scope); entry.restoredUnder = undefined;
  }
  function inactiveScopes(account: SourceAccount, scopes: ScopeDefinition[], revision: string | null) {
    const healthyMode = (mode: ScopeDefinition['accountMode']) => scopes.some(scope => {
      if (!mode || scope.accountMode !== mode) return false;
      const entry = entries.get(cacheKey(account.key, scope.id));
      if (entry) checkRestored(entry);
      return !!revision && entry?.revision === revision && entry.scope.status === 'live';
    });
    // Binance account modes are exclusive; suppress an unread mode only if its counterpart is working.
    const classic = healthyMode('classic'), portfolio = healthyMode('portfolio');
    if (classic === portfolio) return new Set<string>();
    return new Set(scopes.filter(scope => scope.accountMode === (classic ? 'portfolio' : 'classic')).map(scope => scope.id));
  }
  function empty(scope: ScopeDefinition, configured: boolean): PositionsScope {
    return { id: scope.id, label: scope.label, status: !configured ? 'unconfigured' : scope.unsupported ? 'unsupported' : 'loading',
      refreshing: false, fetchedAt: null, error: configured ? scope.unsupported ?? null : null, positions: [] };
  }
  function current(database: DatabaseSource, account: SourceAccount, revision: string) {
    const row = connectionRow(database(), account.key);
    return !!row && revisionOf(row.encrypted) === revision;
  }
  function cycleView(entry: Entry, item: Position): PositionCycle {
    const slot = entry.cycles?.get(item.id);
    // A slot from the same side stays visible while a newer one loads; its updatedAt dates it.
    return slot && slot.side === item.side ? { ...slot.cycle } : cycleUnavailable(CYCLE_LOADING, null, 'loading');
  }
  function scheduleCycles(database: DatabaseSource, account: SourceAccount, entry: Entry, key: string, credentials: Credentials, snapshotAt: number, generation: HistoryGeneration) {
    if (!cycleRead) return;
    if (!entry.cycleGeneration?.current()) entry.cycles?.clear();
    entry.cycleGeneration = generation;
    const cycles = entry.cycles ??= new Map(), positions = entry.scope.positions, scope = entry.scope.id;
    for (const id of cycles.keys()) if (!positions.some(item => item.id === id)) cycles.delete(id);
    if (entry.cycleJob) return;
    const due = positions.filter(item => {
      const slot = cycles.get(item.id), age = slot ? now() - slot.at : Infinity;
      if (!slot || slot.side !== item.side) return true;
      if (slot.quantity !== item.quantity || slot.entryPrice !== item.entryPrice) return age >= CYCLE_MIN_AGE;
      return age >= (slot.cycle.status === 'unavailable' ? CYCLE_RETRY : CYCLE_TTL);
    });
    if (!due.length) return;
    const file = database();
    const abort = entry.cycleAbort = new AbortController();
    entry.cycleJob = cycleLimited(async () => {
      for (const item of due) {
        if (!generation.current() || entries.get(key) !== entry || abort.signal.aborted || !current(database, account, entry.revision)) return;
        // A position closed while its summary was read must not regain a slot.
        const store = (cycle: PositionCycle) => {
          if (generation.current() && !abort.signal.aborted && entries.get(key) === entry && current(database, account, entry.revision) && entry.scope.positions.some(held => held.id === item.id)) {
            cycles.set(item.id, { side: item.side, quantity: item.quantity, entryPrice: item.entryPrice, cycle, at: now() });
          }
        };
        try {
          const signal = anySignal([abort.signal, generation.signal], CYCLE_DEADLINE);
          const history = accountHistory(database, account.key, entry.revision, scope, () => !signal.aborted && entries.get(key) === entry && current(database, account, entry.revision), generation);
          store(await cycleRead(credentials, scope, { position: item, siblings: positions, snapshotAt }, signal, history));
        } catch (error) {
          if (error instanceof PositionsPermissionError) {
            // A second read may already have renewed permissions. Revoke the current generation only for this saved credential.
            if (database() === file && current(database, account, entry.revision)) {
              historyGeneration(database, account.key, entry.revision, now).deny();
            }
            return;
          }
          if (!(error instanceof CycleRetry) && !abort.signal.aborted) store(cycleUnavailable('本轮成交读取超时，稍后重试', new Date(now()).toISOString()));
        }
      }
    }).catch(() => {}).finally(() => { entry.cycleJob = undefined; entry.cycleAbort = undefined; });
  }
  function refresh(database: DatabaseSource, account: SourceAccount, entry: Entry, key: string, unseal: Unseal) {
    if (entry.pending) return;
    entry.scope.refreshing = true;
    const generation = historyGeneration(database, account.key, entry.revision, now);
    entry.pending = limited(async () => {
      if (entries.get(key) !== entry || !current(database, account, entry.revision)) return;
      const abort = new AbortController(); entry.abort = abort;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let sampleStartedAt: number | undefined;
      try {
        const work = async () => {
          const c = parseConnection(unseal(account.row!.encrypted, account.key));
          if (!generation.current() || c.exchange !== account.exchange || !current(database, account, entry.revision)) throw new Error(POSITIONS_FAILED);
          const signal = anySignal([abort.signal, generation.signal]);
          const scope = entry.scope.id;
          const read = (s: AbortSignal) => options.read ? options.read(c, scope, s) : defaultRead(c, scope, s, fetcher, generation.assertVerified);
          if (c.exchange === 'binance' || c.exchange === 'bybit' || c.exchange === 'okx') {
            await generation.verify(shared => (options.permission ?? verifyAssetPermission)(c, fetcher, shared));
            const snapshot = await verifiedPositionSnapshot({ database, account, scope, revision: entry.revision, generation, signal, now, maxAge: ttlFor(c.exchange) }, read,
              entry.scope.fetchedAt ? undefined : saved => {
                entry.restoredUnder = generation;
                entry.scope = { ...entry.scope, status: 'stale', positions: saved.positions, fetchedAt: new Date(saved.completedAt).toISOString(), error: null };
              });
            return { c, positions: snapshot.positions, startedAt: snapshot.startedAt, observedAt: new Date(snapshot.completedAt).toISOString(), restored: snapshot.restored };
          }
          const startedAt = now();
          if (!options.read && c.exchange === 'hyperliquid') {
            return { c, ...await readHyperliquidPositions(c, scope, fetcher, signal, now), startedAt, restored: false };
          }
          return { c, positions: await read(signal), startedAt, observedAt: new Date(now()).toISOString(), restored: false };
        };
        const { c, positions, startedAt, observedAt, restored } = await Promise.race([work(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => { abort.abort(); reject(new Error(POSITIONS_FAILED)); }, options.deadline ?? DEADLINE);
        })]);
        if (entries.get(key) !== entry || !current(database, account, entry.revision)) return;
        if (!generation.current()) throw new Error(POSITIONS_FAILED);
        const previousObservation = c.exchange === 'hyperliquid' ? entry.scope.fetchedAt : null;
        if (previousObservation && observedAt < previousObservation) throw new Error(POSITIONS_FAILED);
        entry.restoredUnder = restored ? generation : undefined;
        if (c.exchange === 'binance' || c.exchange === 'bybit' || c.exchange === 'okx') sampleStartedAt = startedAt;
        entry.scope = { ...entry.scope, positions: observedAt === previousObservation ? entry.scope.positions : positions,
          status: 'live', refreshing: false, fetchedAt: observedAt, error: null };
        if (cyclesFor(account.exchange, entry.scope.id)) scheduleCycles(database, account, entry, key, c, startedAt, generation);
      } catch (error) {
        if (error instanceof PositionsPermissionError) generation.deny();
        let still = false;
        try { still = current(database, account, entry.revision); } catch { /* the file is gone: the next poll rebuilds */ }
        if (entries.get(key) === entry && still) {
          checkRestored(entry);
          entry.scope = { ...entry.scope, status: entry.scope.status === 'stale' ? 'stale' : 'error', refreshing: false, error: POSITIONS_FAILED };
        }
      } finally {
        clearTimeout(timer); entry.attemptedAt = sampleStartedAt ?? now(); entry.scope.refreshing = false; entry.abort = undefined;
      }
    }).catch(() => {
      if (entries.get(key) === entry) entry.scope = { ...entry.scope, status: 'error', refreshing: false, error: POSITIONS_FAILED };
    }).finally(() => { entry.pending = undefined; });
  }
  async function read(database: DatabaseSource, unseal: Unseal, pending?: Set<Promise<void>>): Promise<HubPositions> {
    const file = database(); selectFile(file);
    const accounts = sourceAccounts(file);
    const keep = new Set<string>();
    const restoredViews: { scope: PositionsScope; generation: HistoryGeneration }[] = [];
    const cycleViews: { account: SourceAccount; entry: Entry; positions: Position[] }[] = [];
    const exchanges = POSITIONS_CATALOG.map(exchange => ({ id: exchange.id, name: exchange.name,
      accounts: accounts.filter(account => account.exchange === exchange.id).map(account => {
        const revision = account.row ? revisionOf(account.row.encrypted) : null;
        const inactive = inactiveScopes(account, exchange.scopes, revision);
        return { id: account.id, name: account.name, configured: !!account.row, revision, scopes: exchange.scopes.flatMap(scope => {
          const key = cacheKey(account.key, scope.id); keep.add(key);
          let entry = entries.get(key);
          if (entry && entry.revision !== revision) { stop(entry); entries.delete(key); entry = undefined; }
          if (!revision || scope.unsupported) return [empty(scope, !!revision)];
          if (inactive.has(scope.id)) return [];
          if (!entry) {
            entry = { revision, scope: empty(scope, true), attemptedAt: -Infinity, touchedAt: now() }; entries.set(key, entry);
          }
          entry.touchedAt = now();
          checkRestored(entry);
          if (!entry.pending && now() - entry.attemptedAt >= ttlFor(account.exchange)) refresh(database, account, entry, key, unseal);
          if (entry.pending) pending?.add(entry.pending);
          const result = { ...entry.scope, positions: entry.scope.positions.map(item => ({ ...item })) };
          if (entry.restoredUnder) restoredViews.push({ scope: result, generation: entry.restoredUnder });
          if (result.positions.length && cyclesFor(account.exchange, scope.id)) cycleViews.push({ account, entry, positions: result.positions });
          if (result.status === 'live' && result.fetchedAt && now() - Date.parse(result.fetchedAt) >= STALE_AFTER) result.status = 'stale';
          return [result];
        }) };
      }),
    }));
    for (const [key, entry] of entries) {
      if (!keep.has(key) || now() - entry.touchedAt > IDLE) { stop(entry); entries.delete(key); }
    }
    // The workbench awaits its asynchronous database here and re-checks the connections. With this synchronous database
    // the re-check below only covers writes already queued as microtasks; a replaced key is kept out by the revision in
    // every cache key and by the current() checks before and after each refresh, not by this yield.
    await Promise.resolve();
    if (database() !== file) throw new Error(POSITIONS_FAILED);
    const latest = connectionRows(database());
    for (const account of accounts) {
      const row = latest.find(item => item.exchange === account.key);
      if ((row?.encrypted ?? null) !== (account.row?.encrypted ?? null)) throw new Error(POSITIONS_FAILED);
    }
    for (const restored of restoredViews) if (!restored.generation.current()) hideRevoked(restored.scope);
    for (const { account, entry, positions } of cycleViews) {
      const allowed = entry.cycleGeneration?.current() && historyPermission(database(), account.key, entry.revision) === 'verified';
      for (const item of positions) item.cycle = allowed ? cycleView(entry, item) : cycleUnavailable(CYCLE_LOADING, null, 'loading');
    }
    return boundPositionEvidence({ schemaVersion: 1, generatedAt: new Date(now()).toISOString(), exchanges });
  }
  return {
    read,
    /** Share the live reads, but cap how long the ledger waits and leave cycle reads in the background. */
    async refreshForSnapshot(database: DatabaseSource, unseal: Unseal): Promise<void> {
      const pending = new Set<Promise<void>>();
      await read(database, unseal, pending);
      if (!pending.size) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([Promise.all(pending), new Promise<void>(resolve => { timer = setTimeout(resolve, SNAPSHOT_WAIT); })]);
      } finally { clearTimeout(timer); }
    },
    /** Cached scopes for daily snapshots; never starts a read and does not keep idle entries alive. */
    peek(database: Database | null): SnapshotScope[] {
      selectFile(database);
      const scopes: SnapshotScope[] = [];
      for (const account of sourceAccounts(database)) {
        if (!account.row) continue;
        const revision = revisionOf(account.row.encrypted), catalog = POSITIONS_CATALOG.find(item => item.id === account.exchange)!;
        const generation = revisionOf('daily-snapshot:' + revision).slice(0, 16), inactive = inactiveScopes(account, catalog.scopes, revision);
        for (const definition of catalog.scopes) {
          if (definition.unsupported || inactive.has(definition.id)) continue;
          const cached = entries.get(cacheKey(account.key, definition.id)), entry = cached?.revision === revision ? cached : undefined;
          if (entry) checkRestored(entry);
          const fetchedAt = entry?.scope.fetchedAt;
          if (!entry || !fetchedAt) {
            // Keep evidence of unread configured scopes so a successful read elsewhere can't turn missing data into zero.
            scopes.push({ exchange: account.exchange, account: account.id, accountName: account.name, generation, scope: definition.id, fetchedAt: '', status: 'stale', positions: [] });
            continue;
          }
          const cycles = cyclesFor(account.exchange, definition.id);
          scopes.push({ exchange: account.exchange, account: account.id, accountName: account.name, generation, scope: definition.id, fetchedAt,
            status: entry.scope.status === 'live' && now() - Date.parse(fetchedAt) < STALE_AFTER ? 'live' : 'stale',
            positions: entry.scope.positions.map(item => {
              // Unlike the live view, a snapshot keeps a summary only while it still describes the held size and entry.
              const slot = cycles && entry.cycleGeneration?.current() && historyPermission(database, account.key, revision) === 'verified' ? entry.cycles?.get(item.id) : undefined;
              const cycle = !cycles ? null : slot && slot.side === item.side && slot.quantity === item.quantity && slot.entryPrice === item.entryPrice
                ? slot.cycle : cycleUnavailable(CYCLE_LOADING, null, 'loading');
              return { id: item.id, symbol: item.symbol, instrumentId: item.instrumentId, side: item.side, quantity: item.quantity, quantityUnit: item.quantityUnit,
                unrealizedPnl: item.unrealizedPnl, pnlCurrency: item.pnlCurrency,
                cycle: cycle && { status: cycle.status, since: cycle.since, realizedPnl: cycle.realizedPnl, fees: cycle.fees, funding: cycle.funding, net: cycle.net, currency: cycle.currency, updatedAt: cycle.updatedAt } };
            }) });
        }
      }
      return scopes;
    },
    async idle() {
      while ([...entries.values()].some(entry => entry.pending || entry.cycleJob)) await Promise.allSettled([...entries.values()].flatMap(entry => [entry.pending, entry.cycleJob]));
    },
    close() { for (const entry of entries.values()) stop(entry); entries.clear(); },
  };
}
