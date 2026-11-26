// A covered interval and its complete exchange rows live in the same SQLite record.
// UTC day boundaries keep both appending a small tail and an 85-day replay bounded.
import type { AssetDb } from './db.ts';
import { CYCLE_LOOKBACK_MS } from './positions-cycle.ts';
import { POSITIONS_FAILED, POSITIONS_INVALID, PositionsPermissionError } from './positions-values.ts';

const DAY = 86_400_000;
export const HISTORY_OVERLAP = 10 * 60_000;
export type HistoryRow = Record<string, unknown>;
type Range = { start: number; end: number };
type Segment = Range & { data: string };
type Database = Pick<AssetDb, 'prepare' | 'transaction'>;
type DatabaseSource = () => Database | null;
type Stream = { instrument: string; source: string };

export const HISTORY_TABLE = `CREATE TABLE IF NOT EXISTS asset_history_windows (
  account TEXT NOT NULL, revision TEXT NOT NULL, scope TEXT NOT NULL, instrument TEXT NOT NULL, source TEXT NOT NULL,
  start INTEGER NOT NULL, end INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(account,revision,scope,instrument,source,start)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS asset_history_expiry ON asset_history_windows(end);`;
const KEY = 'account=? AND revision=? AND scope=? AND instrument=? AND source=?';
type Permission = 'unknown' | 'verified' | 'denied';
type Access = { revision: string; data: AbortController; authorization: AbortController; permission: Permission; deniedAt: number; checks: number; failed?: boolean; pending?: Promise<void> };
function newAccess(revision: string, permission: Permission, deniedAt = 0): Access {
  return { revision, data: new AbortController(), authorization: new AbortController(), permission, deniedAt, checks: 0 };
}
const generations = new WeakMap<Pick<Database, 'prepare'>, Map<string, Access>>();
export function historyPermission(database: Pick<Database, 'prepare'> | null, account: string, revision: string): Permission {
  const entry = database && generations.get(database)?.get(account);
  return entry?.revision === revision ? entry.permission : 'unknown';
}
type Denied = (account: string, revision: string) => void;
const permissionListeners = new WeakMap<Database, Set<Denied>>();

/** A display can remain live while another service verifies the same saved credential. */
export function onHistoryPermissionDenied(database: Database, listener: Denied) {
  const listeners = permissionListeners.get(database) ?? new Set<Denied>();
  permissionListeners.set(database, listeners); listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function historyGeneration(database: DatabaseSource, account: string, revision: string, now = Date.now) {
  const file = database();
  const accounts = (file && generations.get(file)) ?? new Map<string, Access>();
  if (file) generations.set(file, accounts);
  let entry = accounts.get(account);
  if (entry?.revision !== revision) {
    const previous = entry;
    entry = newAccess(revision, 'unknown'); accounts.set(account, entry);
    previous?.authorization.abort(); previous?.data.abort();
  }
  const access = entry, { signal } = access.data, started = access.checks;
  const permissionCurrent = () => !!file && !access.authorization.signal.aborted && database() === file;
  const current = () => !signal.aborted && permissionCurrent();
  const deny = () => { if (permissionCurrent()) invalidateHistory(file, account, revision, undefined, now()); };
  const assertVerified = () => { if (!current() || access.permission !== 'verified') throw new Error(POSITIONS_FAILED); };
  async function verify(probe: (signal: AbortSignal) => Promise<void>) {
    if (!current()) throw new Error(POSITIONS_FAILED);
    // A permission check completed after this snapshot was queued, possibly in the other asset service.
    if (!access.pending && access.checks > started) {
      if (access.failed) throw new Error(POSITIONS_FAILED);
      assertVerified(); return;
    }
    if (!access.pending) {
      access.pending = Promise.resolve().then(() => {
        if (!permissionCurrent()) throw new Error(POSITIONS_FAILED);
        return probe(access.authorization.signal);
      }).then(() => {
        if (!permissionCurrent()) throw new Error(POSITIONS_FAILED);
        access.permission = 'verified'; access.failed = false;
      }).catch(error => {
        access.failed = true;
        if (error instanceof PositionsPermissionError) deny();
        throw error;
      }).finally(() => { access.checks++; access.pending = undefined; });
    }
    await access.pending;
    assertVerified();
  }
  return { current, assertVerified, verify, deny, signal, deniedAt: access.deniedAt };
}
export type HistoryGeneration = ReturnType<typeof historyGeneration>;

type Dispute = { scope: string; slot: string; records: readonly { symbol: string; time: string }[] };
/** Cancel readers started before a permission denial or an immutable fill conflict. For a conflict only the
 * display slot and the raw segments containing the disputed timestamps need to be read again. */
export function invalidateHistory(database: Database | null, account: string, revision: string, dispute?: Dispute, at = Date.now()) {
  if (!database) return;
  const accounts = generations.get(database) ?? new Map<string, Access>(), entry = accounts.get(account);
  if (dispute && entry?.revision === revision) {
    // A bad fill cancels writers. A permission request already sent for this same credential still counts.
    const previous = entry.data; entry.data = new AbortController(); previous.abort();
  } else if (!entry || entry.revision === revision) {
    generations.set(database, accounts);
    // Keep the last denial even after a later successful probe; the scan directory compares it to the source response time.
    accounts.set(account, newAccess(revision, dispute ? 'unknown' : 'denied', dispute ? 0 : Math.max(at, entry?.deniedAt ?? 0)));
    entry?.authorization.abort(); entry?.data.abort();
  }
  if (!dispute) for (const listener of permissionListeners.get(database) ?? []) listener(account, revision);
  try {
    database.transaction(() => {
      if (!dispute) {
        database.prepare('DELETE FROM fill_cache WHERE account=? AND revision=?').bind(account, revision).run();
        database.prepare('DELETE FROM asset_history_windows WHERE account=? AND revision=?').bind(account, revision).run();
        database.prepare('DELETE FROM asset_position_snapshots WHERE account=? AND revision=?').bind(account, revision).run();
        return;
      }
      database.prepare('DELETE FROM fill_cache WHERE account=? AND revision=? AND scope=?').bind(account, revision, dispute.slot).run();
      for (const record of dispute.records) {
        const at = Date.parse(record.time);
        database.prepare('DELETE FROM asset_history_windows WHERE account=? AND revision=? AND scope=? AND instrument=? AND start<=? AND end>=?')
          .bind(account, revision, dispute.scope, record.symbol, at, at).run();
      }
    });
  }
  catch { /* A read-only or older database can still serve the live read. */ }
}

export function accountHistory(database: DatabaseSource, account: string, revision: string, scope: string, valid: () => boolean,
  generation = historyGeneration(database, account, revision)) {
  const file = database();
  const check = () => { generation.assertVerified(); if (!valid()) throw new Error(POSITIONS_FAILED); };
  function load(stream: Stream, start: number, end: number): Segment[] {
    if (end < start) return [];
    check();
    try {
      return file!.prepare(`SELECT start,end,data FROM asset_history_windows WHERE ${KEY} AND start>=? AND start<=? AND end>=? ORDER BY start`)
        .bind(account, revision, scope, stream.instrument, stream.source, Math.floor(start / DAY) * DAY, end, start).rows<Segment>();
    } catch { return []; } // Absent on an older database opened read-only.
  }
  function discard(stream: Stream, segment: Segment) {
    check();
    try { file!.prepare(`DELETE FROM asset_history_windows WHERE ${KEY} AND start=? AND data=?`)
      .bind(account, revision, scope, stream.instrument, stream.source, segment.start, segment.data).run(); }
    catch { /* A read-only cache can still be bypassed. */ }
  }
  function save(stream: Stream, start: number, end: number, records: HistoryRow[], time: (row: HistoryRow) => number, anchor: number) {
    if (end < start) return;
    check();
    try {
      file!.transaction(() => {
        check(); // After taking the writer lock: an external import may have replaced the connections.
        const id = [account, revision, scope, stream.instrument, stream.source];
        file!.prepare('DELETE FROM asset_history_windows WHERE end<?').bind(anchor - CYCLE_LOOKBACK_MS).run();
        for (let from = start; from <= end;) {
          const day = Math.floor(from / DAY) * DAY, to = Math.min(end, day + DAY - 1);
          const neighbors = file!.prepare(`SELECT start,end,data FROM asset_history_windows WHERE ${KEY} AND start>=? AND start<=? AND end>=? ORDER BY start`)
            .bind(...id, day, Math.min(day + DAY - 1, to + 1), from - 1).rows<Segment>();
          const data = records.filter(row => time(row) >= from && time(row) <= to);
          let first = from, last = to;
          for (const old of neighbors) {
            // Only the parts outside the freshly validated interval need to survive a concurrent overlapping read.
            if (old.start < from || old.end > to) {
              for (const row of JSON.parse(old.data) as HistoryRow[]) if (time(row) < from || time(row) > to) data.push(row);
            }
            first = Math.min(first, old.start); last = Math.max(last, old.end);
            file!.prepare(`DELETE FROM asset_history_windows WHERE ${KEY} AND start=?`).bind(...id, old.start).run();
          }
          file!.prepare('INSERT INTO asset_history_windows(account,revision,scope,instrument,source,start,end,data) VALUES(?,?,?,?,?,?,?,?)')
            .bind(...id, first, last, JSON.stringify(data)).run();
          from = to + 1;
        }
      });
    } catch { check(); } // A failed write (including a full disk) leaves the whole interval unconfirmed.
  }
  return { load, save, discard, check };
}
export type AccountHistory = ReturnType<typeof accountHistory>;

type WindowOptions<T> = {
  history?: AccountHistory; instrument: string; source: string; start: number; end: number | null; anchor: number;
  time: (row: HistoryRow) => number;
  fetch: (start: number, end: number | null, newer: readonly T[]) => Promise<HistoryRow[] | { rows: HistoryRow[]; coveredFrom: number }>;
  decode: (rows: HistoryRow[]) => T[];
  accept?: (values: readonly T[]) => void;
  stop?: (newer: readonly T[]) => boolean;
  /** A consumer may display incomplete optional fields without certifying them for a stricter replay. */
  complete?: (rows: HistoryRow[]) => boolean;
};

/** Return current exchange rows for gaps, including the open head and late arrivals. Validate before recording
 * coverage. Cached raw rows go through the same parser as live ones and a malformed cache becomes a gap. */
export async function historyWindow<T>(options: WindowOptions<T>): Promise<T[]> {
  const { history, start, end, anchor, time, decode } = options;
  async function fetchRange(from: number, to: number | null, newer: readonly T[]) {
    const fetched = await options.fetch(from, to, newer);
    const { rows, coveredFrom } = Array.isArray(fetched) ? { rows: fetched, coveredFrom: from } : fetched;
    if (coveredFrom < from || rows.some(row => time(row) < coveredFrom || (to !== null && time(row) > to))) throw new Error(POSITIONS_INVALID);
    return { rows, coveredFrom };
  }
  if (!history) {
    const values = decode((await fetchRange(start, end, [])).rows); options.accept?.(values);
    return values;
  }
  const last = end ?? anchor, stable = Math.min(last, anchor - HISTORY_OVERLAP - 1);
  const result: T[] = [];
  async function gap(from: number, to: number, open: boolean) {
    history!.check();
    const { rows, coveredFrom } = await fetchRange(from, open ? null : to, result);
    history!.check();
    const values = decode(rows); options.accept?.(values);
    result.push(...values);
    if (!options.complete || options.complete(rows)) history!.save(options, coveredFrom, Math.min(to, stable), rows, time, anchor);
    return coveredFrom > from;
  }
  // Descending intervals preserve venue listing order for same-millisecond Bybit executions.
  let cursor = last;
  for (const segment of history.load(options, start, stable).reverse()) {
    const from = Math.max(start, segment.start), to = Math.min(cursor, stable, segment.end);
    if (to < from) continue;
    let values: T[];
    try {
      const rows = JSON.parse(segment.data) as HistoryRow[];
      if (!Number.isSafeInteger(segment.start) || !Number.isSafeInteger(segment.end) || Math.floor(segment.start / DAY) !== Math.floor(segment.end / DAY)
        || !Array.isArray(rows) || rows.some(row => time(row) < segment.start || time(row) > segment.end)) throw new Error(POSITIONS_INVALID);
      values = decode(rows.filter(row => time(row) >= from && time(row) <= to));
    } catch { history.discard(options, segment); continue; }
    if (cursor > to) {
      if (await gap(to + 1, cursor, cursor === last && end === null) || options.stop?.(result)) { history.check(); return result; }
    }
    options.accept?.(values);
    result.push(...values);
    cursor = from - 1;
    if (options.stop?.(result)) { history.check(); return result; }
  }
  if (cursor >= start) await gap(start, cursor, cursor === last && end === null);
  history.check();
  return result;
}
