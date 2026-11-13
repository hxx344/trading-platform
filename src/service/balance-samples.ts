// Balance history for the page's trend chart. It lives in a database file of its own (samples.sqlite), like the alert
// outbox: the executor's database keeps its schema, so an older release can still open it after a rollback, and losing
// this file loses only the chart. The samples are copied from what the transfer checks already read and stored on each
// pair; nothing here reads the venue or takes part in a decision.
import { DatabaseSync, type StatementSync } from 'node:sqlite';

/** At most one sample per pair this often. */
export const SAMPLE_EVERY_MS = 60_000;
export const SAMPLE_RETENTION_MS = 30 * 24 * 3_600_000;
const PRUNE_EVERY_MS = 3_600_000;
const PRUNE_BATCH = 20_000;
/** A stamp this far ahead of the local clock is not recorded: it would hold back every later sample of the pair. */
const FUTURE_TOLERANCE_MS = 60_000;
const MAX_VALUE = 40;
/** The chart draws at most about this many points; a longer range takes the last sample of each stretch. */
const MAX_POINTS = 720;
export const BALANCE_RANGES: Readonly<Record<string, number>> = Object.freeze({ '6h': 6 * 3_600_000, '24h': 24 * 3_600_000, '7d': 7 * 24 * 3_600_000, '30d': 30 * 24 * 3_600_000 });

interface Side { available: string; equity: string; receivedAt: number }
export interface SampledPair { id: string; balances: { long: Side; short: Side } | null; balancesFresh: boolean }
export interface BalancePoint { at: number; long: { available: string; equity: string }; short: { available: string; equity: string }; fresh: boolean }

/** The range's window and stretch length; null for a range that is not offered. */
export function balanceWindow(range: string, to: number): { from: number; to: number; bucketMs: number; sampleEveryMs: number } | null {
  const span = Object.hasOwn(BALANCE_RANGES, range) ? BALANCE_RANGES[range]! : null;
  return span === null ? null : { from: to - span, to, bucketMs: Math.max(SAMPLE_EVERY_MS, Math.ceil(span / MAX_POINTS)), sampleEveryMs: SAMPLE_EVERY_MS };
}

const value = (text: unknown): string | null => typeof text === 'string' && text.length <= MAX_VALUE && /^-?\d+(\.\d+)?$/.test(text) ? text : null;

export function createBalanceSamples({ file, now = Date.now }: { file: string; now?: () => number }) {
  const db = new DatabaseSync(file);
  let insert: StatementSync;
  try {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=2000;
    CREATE TABLE IF NOT EXISTS balance_samples (pair_id TEXT NOT NULL, at INTEGER NOT NULL, long_available TEXT NOT NULL, long_equity TEXT NOT NULL,
      short_available TEXT NOT NULL, short_equity TEXT NOT NULL, fresh INTEGER NOT NULL, PRIMARY KEY (pair_id, at)) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS balance_samples_at ON balance_samples(at);`);
    insert = db.prepare('INSERT OR IGNORE INTO balance_samples(pair_id, at, long_available, long_equity, short_available, short_equity, fresh) VALUES (?, ?, ?, ?, ?, ?, ?)');
  } catch (error) { db.close(); throw error; }
  /** The newest sample per pair, read from the file once and then kept in step. */
  const newest = new Map<string, number>();
  const newestOf = (pairId: string): number => {
    let at = newest.get(pairId);
    if (at === undefined) {
      at = (db.prepare('SELECT MAX(at) AS at FROM balance_samples WHERE pair_id = ?').get(pairId) as { at: number | null }).at ?? 0;
      newest.set(pairId, at);
    }
    return at;
  };
  let prunedAt = 0;

  /** Records the pairs' stored balances where both sides were read at least SAMPLE_EVERY_MS after the pair's last sample. */
  function record(pairs: readonly SampledPair[]): number {
    const at = now();
    let added = 0;
    for (const pair of pairs) {
      const balances = pair.balances;
      if (!balances) continue;
      const sampledAt = Math.min(balances.long.receivedAt, balances.short.receivedAt);
      const values = [value(balances.long.available), value(balances.long.equity), value(balances.short.available), value(balances.short.equity)];
      if (!Number.isSafeInteger(sampledAt) || sampledAt <= 0 || sampledAt > at + FUTURE_TOLERANCE_MS || values.includes(null)) continue;
      // A newest sample ahead of the local clock (the clock has since been set back) no longer throttles: balances are
      // stamped with the local clock, so it would hold the pair's sampling until the clock caught up.
      const last = newestOf(pair.id);
      if (last <= at && sampledAt - last < SAMPLE_EVERY_MS) continue;
      if (insert.run(pair.id, sampledAt, values[0]!, values[1]!, values[2]!, values[3]!, pair.balancesFresh ? 1 : 0).changes) added += 1;
      newest.set(pair.id, Math.max(sampledAt, last <= at ? last : 0));
    }
    return added;
  }

  /** Drops samples past the retention period, at most once an hour and a bounded batch at a time. */
  function prune(): number {
    const at = now();
    if (at - prunedAt < PRUNE_EVERY_MS) return 0;
    prunedAt = at;
    return Number(db.prepare('DELETE FROM balance_samples WHERE (pair_id, at) IN (SELECT pair_id, at FROM balance_samples WHERE at < ? ORDER BY at LIMIT ?)').run(at - SAMPLE_RETENTION_MS, PRUNE_BATCH).changes);
  }

  /** The pair's samples over the range, the last one of each stretch when there are more than MAX_POINTS stretches. */
  function history(pairId: string, range: string) {
    const window = balanceWindow(range, now());
    if (!window) return null;
    const { from, to, bucketMs } = window;
    // SQLite returns the other columns of the row that holds MAX(at) in its group.
    const rows = db.prepare(`SELECT MAX(at) AS at, long_available, long_equity, short_available, short_equity, fresh FROM balance_samples
      WHERE pair_id = ? AND at >= ? AND at <= ? GROUP BY CAST(at / ? AS INTEGER) ORDER BY at`).all(pairId, from, to, bucketMs) as {
      at: number; long_available: string; long_equity: string; short_available: string; short_equity: string; fresh: number }[];
    const points: BalancePoint[] = rows.map(row => ({ at: row.at, long: { available: row.long_available, equity: row.long_equity }, short: { available: row.short_available, equity: row.short_equity }, fresh: row.fresh === 1 }));
    return { pairId, range, ...window, points };
  }

  return { record, prune, history, close: (): void => db.close() };
}
export type BalanceSamples = ReturnType<typeof createBalanceSamples>;
