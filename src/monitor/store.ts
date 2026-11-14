// Monitor history in a database file of its own (monitor.sqlite), like the balance samples: the executor's database keeps
// its schema, so an older release still opens it after a rollback, and losing this file loses only the monitor history
// (the venues serve the last ~50 days of Anthropic and the oil history since 2026-04-01 again). Nothing here takes part in a trading decision.
import { DatabaseSync } from 'node:sqlite';
import type { AnthropicCandleRow } from '../vendor/anthropic-market.mjs';
import type { OilCandleRow } from '../vendor/oil-market.mjs';

export const MONITOR_FILE = 'monitor.sqlite';

export interface CandleWrite<Row = AnthropicCandleRow> {
  /** Rows to insert or overwrite by time. */
  rows: readonly Row[];
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
    CREATE TABLE IF NOT EXISTS oil_candles (time INTEGER PRIMARY KEY, brent REAL, wti REAL);
    CREATE TABLE IF NOT EXISTS monitor_state (key TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL);`);
  } catch (error) { db.close(); throw error; }
  const upsertCandle = db.prepare(`INSERT INTO anthropic_candles(time, binance, xyz, io, rh) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(time) DO UPDATE SET binance = excluded.binance, xyz = excluded.xyz, io = excluded.io, rh = excluded.rh`);
  const pruneCandles = db.prepare('DELETE FROM anthropic_candles WHERE time < ?');
  const upsertOil = db.prepare(`INSERT INTO oil_candles(time, brent, wti) VALUES (?, ?, ?)
    ON CONFLICT(time) DO UPDATE SET brent = excluded.brent, wti = excluded.wti`);
  const pruneOil = db.prepare('DELETE FROM oil_candles WHERE time < ?');
  const upsertState = db.prepare(`INSERT INTO monitor_state(key, json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`);

  function writeState(key: string, value: unknown): void { upsertState.run(key, JSON.stringify(value), now()); }
  /** One transaction: the rows, the retention cut and the round's state. Returns how many rows the cut removed. */
  function writeRows<Row>(table: string, upsert: (row: Row) => void, prune: { run(cutoff: number): { changes: number | bigint } }, { rows, cutoff, replace = false, state }: CandleWrite<Row>): number {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (replace) db.exec(`DELETE FROM ${table}`);
      for (const row of rows) upsert(row);
      const removed = Number(prune.run(cutoff).changes);
      if (state) writeState(state.key, state.value);
      db.exec('COMMIT');
      return removed;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  return {
    /** Every stored candle row, oldest first. */
    candles(): AnthropicCandleRow[] {
      return db.prepare('SELECT time, binance, xyz, io, rh FROM anthropic_candles ORDER BY time').all() as unknown as AnthropicCandleRow[];
    },
    /** One transaction: the rows, the retention cut and the round's state. Returns how many rows the cut removed. */
    writeCandles: (write: CandleWrite): number => writeRows('anthropic_candles', row => upsertCandle.run(row.time, row.binance, row.xyz, row.io, row.rh), pruneCandles, write),
    /** Every stored oil row (Brent and WTI closes), oldest first. */
    oilCandles(): OilCandleRow[] {
      return db.prepare('SELECT time, brent, wti FROM oil_candles ORDER BY time').all() as unknown as OilCandleRow[];
    },
    writeOilCandles: (write: CandleWrite<OilCandleRow>): number => writeRows('oil_candles', row => upsertOil.run(row.time, row.brent, row.wti), pruneOil, write),
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
