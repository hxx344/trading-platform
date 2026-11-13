// Monitor history in a database file of its own (monitor.sqlite), like the balance samples: the executor's database keeps
// its schema, so an older release still opens it after a rollback, and losing this file loses only the monitor history
// (the venues serve the last ~50 days again). Nothing here takes part in a trading decision.
import { DatabaseSync } from 'node:sqlite';
import type { AnthropicCandleRow } from '../vendor/anthropic-market.mjs';

export const MONITOR_FILE = 'monitor.sqlite';

export interface CandleWrite {
  /** Rows to insert or overwrite by time. */
  rows: readonly AnthropicCandleRow[];
  /** Rows opening before this are deleted. */
  cutoff: number;
  /** Clears the table first: the history held in memory no longer matches what is stored. */
  replace?: boolean;
  /** Written in the same transaction, so the rows and their round's metadata never disagree. */
  state?: { key: string; value: unknown };
}

export function createMonitorStore({ file, now = Date.now }: { file: string; now?: () => number }) {
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=2000;
    CREATE TABLE IF NOT EXISTS anthropic_candles (time INTEGER PRIMARY KEY, binance REAL, xyz REAL, io REAL, rh REAL);
    CREATE TABLE IF NOT EXISTS monitor_state (key TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL);`);
  } catch (error) { db.close(); throw error; }
  const upsertCandle = db.prepare(`INSERT INTO anthropic_candles(time, binance, xyz, io, rh) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(time) DO UPDATE SET binance = excluded.binance, xyz = excluded.xyz, io = excluded.io, rh = excluded.rh`);
  const pruneCandles = db.prepare('DELETE FROM anthropic_candles WHERE time < ?');
  const upsertState = db.prepare(`INSERT INTO monitor_state(key, json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`);

  function writeState(key: string, value: unknown): void { upsertState.run(key, JSON.stringify(value), now()); }

  return {
    /** Every stored candle row, oldest first. */
    candles(): AnthropicCandleRow[] {
      return db.prepare('SELECT time, binance, xyz, io, rh FROM anthropic_candles ORDER BY time').all() as unknown as AnthropicCandleRow[];
    },
    /** One transaction: the rows, the retention cut and the round's state. Returns how many rows the cut removed. */
    writeCandles({ rows, cutoff, replace = false, state }: CandleWrite): number {
      db.exec('BEGIN IMMEDIATE');
      try {
        if (replace) db.exec('DELETE FROM anthropic_candles');
        for (const row of rows) upsertCandle.run(row.time, row.binance, row.xyz, row.io, row.rh);
        const removed = Number(pruneCandles.run(cutoff).changes);
        if (state) writeState(state.key, state.value);
        db.exec('COMMIT');
        return removed;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    /** null when the key was never written; a value that no longer parses throws. */
    readState(key: string): { value: unknown; updatedAt: number } | null {
      const row = db.prepare('SELECT json, updated_at FROM monitor_state WHERE key = ?').get(key) as { json: string; updated_at: number } | undefined;
      return row ? { value: JSON.parse(row.json) as unknown, updatedAt: row.updated_at } : null;
    },
    writeState,
    close: (): void => db.close(),
  };
}
export type MonitorStore = ReturnType<typeof createMonitorStore>;
