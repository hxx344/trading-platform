// 资金费组合自己的数据库（fundingbook.sqlite，docs/fundingbook.md 第 7 节）：已结算资金费、小时收盘价、
// 各序列已查询的范围、参数、模拟盘与每轮规划。只有本模块写。丢掉这个文件丢的是模拟盘与规划记录，行情历史会重新回补。
import { DatabaseSync } from 'node:sqlite';
import type { PaperBook } from './paper.ts';
import type { FundingRecord, PricePoint } from './stats.ts';

export const FUNDINGBOOK_FILE = 'fundingbook.sqlite';
export const ROUND_RETENTION = 500;

/** 一条序列已查询的范围；`from`、`to` 为 null 表示还没成功读过。`retryAt` 之前不再读（失败后的退避）。 */
export interface Coverage { from: number | null; to: number | null; error: string | null; retryAt: number }
export interface StoredRound { id: number; at: number; summary: unknown }
export type FundingBookStore = ReturnType<typeof openFundingBookStore>;

export function openFundingBookStore(file: string) {
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=2000;
    CREATE TABLE IF NOT EXISTS funding (leg TEXT NOT NULL, time INTEGER NOT NULL, rate REAL NOT NULL, PRIMARY KEY (leg, time)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS prices (base TEXT NOT NULL, time INTEGER NOT NULL, close REAL NOT NULL, PRIMARY KEY (base, time)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS coverage (key TEXT PRIMARY KEY, from_ms INTEGER, to_ms INTEGER, error TEXT, retry_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS rounds (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, summary TEXT NOT NULL, detail TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL);`);
  } catch (error) { db.close(); throw error; }

  const transaction = <T>(work: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = work(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const putFunding = db.prepare('INSERT INTO funding(leg, time, rate) VALUES (?, ?, ?) ON CONFLICT(leg, time) DO UPDATE SET rate = excluded.rate');
  const readFunding = db.prepare('SELECT time, rate FROM funding WHERE leg = ? AND time > ? ORDER BY time');
  const putPrice = db.prepare('INSERT INTO prices(base, time, close) VALUES (?, ?, ?) ON CONFLICT(base, time) DO UPDATE SET close = excluded.close');
  const readPrices = db.prepare('SELECT time, close FROM prices WHERE base = ? AND time > ? ORDER BY time');
  const readCoverage = db.prepare('SELECT from_ms, to_ms, error, retry_at FROM coverage WHERE key = ?');
  const putCoverage = db.prepare(`INSERT INTO coverage(key, from_ms, to_ms, error, retry_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET from_ms = excluded.from_ms, to_ms = excluded.to_ms, error = excluded.error, retry_at = excluded.retry_at`);
  const readState = db.prepare('SELECT json FROM state WHERE key = ?');
  const putState = db.prepare('INSERT INTO state(key, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at');
  const dropState = db.prepare('DELETE FROM state WHERE key = ?');
  const insertRound = db.prepare('INSERT INTO rounds(at, summary, detail) VALUES (?, ?, ?)');
  const pruneRounds = db.prepare('DELETE FROM rounds WHERE id <= (SELECT MAX(id) FROM rounds) - ?');
  const listRounds = db.prepare('SELECT id, at, summary FROM rounds ORDER BY id DESC LIMIT ?');
  const readRound = db.prepare('SELECT detail FROM rounds WHERE id = ?');
  const latestRound = db.prepare('SELECT id, at, detail FROM rounds ORDER BY id DESC LIMIT 1');
  const clearRounds = db.prepare('DELETE FROM rounds');
  const pruneFunding = db.prepare('DELETE FROM funding WHERE time < ?');
  const prunePrices = db.prepare('DELETE FROM prices WHERE time < ?');

  const state = (key: string): unknown => {
    const row = readState.get(key) as { json: string } | undefined;
    if (!row) return null;
    try { return JSON.parse(row.json); } catch { return null; }
  };
  return {
    settings: (): unknown => state('settings'),
    saveSettings(value: unknown, now: number): void { putState.run('settings', JSON.stringify(value), now); },
    book: (): PaperBook | null => state('book') as PaperBook | null,
    /** 模拟盘与这一轮规划一起落库：只落一半会让下一轮从对不上的仓位出发。 */
    commitRound(book: PaperBook, at: number, summary: unknown, detail: unknown): number {
      return transaction(() => {
        putState.run('book', JSON.stringify(book), at);
        const id = Number(insertRound.run(at, JSON.stringify(summary), JSON.stringify(detail)).lastInsertRowid);
        pruneRounds.run(ROUND_RETENTION);
        return id;
      });
    },
    /** 重置模拟盘：持仓、现金与规划记录一起清掉。 */
    resetPaper(): void { transaction(() => { dropState.run('book'); clearRounds.run(); }); },
    coverage(key: string): Coverage | null {
      const row = readCoverage.get(key) as { from_ms: number | null; to_ms: number | null; error: string | null; retry_at: number } | undefined;
      return row ? { from: row.from_ms, to: row.to_ms, error: row.error, retryAt: row.retry_at } : null;
    },
    setCoverage(key: string, value: Coverage): void { putCoverage.run(key, value.from, value.to, value.error, value.retryAt); },
    addFunding(leg: string, records: readonly FundingRecord[], coverageKey: string, coverage: Coverage): void {
      transaction(() => { for (const { time, rate } of records) putFunding.run(leg, time, rate); putCoverage.run(coverageKey, coverage.from, coverage.to, coverage.error, coverage.retryAt); });
    },
    funding: (leg: string, after: number): FundingRecord[] => readFunding.all(leg, after) as unknown as FundingRecord[],
    addPrices(base: string, points: readonly PricePoint[], coverageKey: string, coverage: Coverage): void {
      transaction(() => { for (const { time, close } of points) putPrice.run(base, time, close); putCoverage.run(coverageKey, coverage.from, coverage.to, coverage.error, coverage.retryAt); });
    },
    prices: (base: string, after: number): PricePoint[] => readPrices.all(base, after) as unknown as PricePoint[],
    rounds(limit: number): StoredRound[] {
      return (listRounds.all(limit) as { id: number; at: number; summary: string }[]).map(row => ({ id: row.id, at: row.at, summary: JSON.parse(row.summary) as unknown }));
    },
    round(id: number): unknown {
      const row = readRound.get(id) as { detail: string } | undefined;
      return row ? JSON.parse(row.detail) as unknown : null;
    },
    latestRound(): { id: number; at: number; detail: unknown } | null {
      const row = latestRound.get() as { id: number; at: number; detail: string } | undefined;
      return row ? { id: row.id, at: row.at, detail: JSON.parse(row.detail) as unknown } : null;
    },
    prune(before: number): void { pruneFunding.run(before); prunePrices.run(before); },
    close(): void { db.close(); },
  };
}
