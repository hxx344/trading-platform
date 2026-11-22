// Var/Lighter 价差模块自己的数据库（varlighter.sqlite，docs/varlighter.md 第 7 节）：对齐样本、模拟盘持仓与成交、
// 参数与事件。执行器数据库结构不动；丢掉这个文件只丢采集历史与模拟盘记录，不影响任何真实交易。
import { DatabaseSync } from 'node:sqlite';
import type { Regime, Sample } from './model.ts';
import type { ClosedTrade, Position } from './strategy.ts';

export const VARLIGHTER_FILE = 'varlighter.sqlite';
/** 样本保留天数：两个场所约 210 个配对每分钟各一条，每天约 30 万条；14 天约 420 万条（库文件大小见 docs/varlighter.md 第 7 节）。 */
export const SAMPLE_RETENTION_DAYS = 14;

const COLUMNS = ['symbol', 't', 'received_at', 'regime', 'var_mark', 'var_bid0', 'var_ask0', 'var_bid1k', 'var_ask1k', 'var_bid100k', 'var_ask100k', 'var_funding',
  'rh_at', 'rh_bid0', 'rh_ask0', 'rh_mark', 'rh_index', 'rh_funding', 'rh_bid1k', 'rh_ask1k', 'rh_bid100k', 'rh_ask100k'] as const;
type Row = Record<typeof COLUMNS[number], unknown>;

const toRow = (sample: Sample): (string | number | null)[] => [sample.symbol, sample.t, sample.receivedAt, sample.regime, sample.varMark, sample.varBid0, sample.varAsk0,
  sample.varBid1k, sample.varAsk1k, sample.varBid100k, sample.varAsk100k, sample.varFunding, sample.rhAt, sample.rhBid0, sample.rhAsk0, sample.rhMark, sample.rhIndex,
  sample.rhFunding, sample.rhBid1k, sample.rhAsk1k, sample.rhBid100k, sample.rhAsk100k];
const nullable = (value: unknown): number | null => typeof value === 'number' ? value : null;
const fromRow = (row: Row): Sample => ({
  symbol: row.symbol as string, t: row.t as number, receivedAt: row.received_at as number, regime: row.regime as Regime,
  varMark: row.var_mark as number, varBid0: row.var_bid0 as number, varAsk0: row.var_ask0 as number, varBid1k: row.var_bid1k as number, varAsk1k: row.var_ask1k as number,
  varBid100k: nullable(row.var_bid100k), varAsk100k: nullable(row.var_ask100k), varFunding: nullable(row.var_funding),
  rhAt: row.rh_at as number, rhBid0: row.rh_bid0 as number, rhAsk0: row.rh_ask0 as number, rhMark: nullable(row.rh_mark), rhIndex: nullable(row.rh_index), rhFunding: nullable(row.rh_funding),
  rhBid1k: nullable(row.rh_bid1k), rhAsk1k: nullable(row.rh_ask1k), rhBid100k: nullable(row.rh_bid100k), rhAsk100k: nullable(row.rh_ask100k),
});

export interface StoredEvent { id: number; at: number; kind: string; symbol: string | null; message: string }
export type VarLighterStore = ReturnType<typeof openVarLighterStore>;

export function openVarLighterStore(file: string) {
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=2000;
    CREATE TABLE IF NOT EXISTS samples (symbol TEXT NOT NULL, t INTEGER NOT NULL, received_at INTEGER NOT NULL, regime TEXT NOT NULL,
      var_mark REAL NOT NULL, var_bid0 REAL NOT NULL, var_ask0 REAL NOT NULL, var_bid1k REAL NOT NULL, var_ask1k REAL NOT NULL, var_bid100k REAL, var_ask100k REAL, var_funding REAL,
      rh_at INTEGER NOT NULL, rh_bid0 REAL NOT NULL, rh_ask0 REAL NOT NULL, rh_mark REAL, rh_index REAL, rh_funding REAL, rh_bid1k REAL, rh_ask1k REAL, rh_bid100k REAL, rh_ask100k REAL,
      PRIMARY KEY (symbol, t)) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS samples_t ON samples(t);
    CREATE TABLE IF NOT EXISTS paper_positions (id TEXT PRIMARY KEY, symbol TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS paper_trades (id TEXT PRIMARY KEY, symbol TEXT NOT NULL, closed_at INTEGER NOT NULL, net_usd REAL NOT NULL, json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS paper_trades_closed ON paper_trades(closed_at);
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, symbol TEXT, message TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL);`);
  } catch (error) { db.close(); throw error; }
  const insertSample = db.prepare(`INSERT OR IGNORE INTO samples(${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`);
  const selectRange = db.prepare(`SELECT ${COLUMNS.join(', ')} FROM samples WHERE symbol = ? AND t >= ? AND t <= ? ORDER BY t`);
  const selectLatest = db.prepare(`SELECT ${COLUMNS.join(', ')} FROM samples WHERE symbol = ? ORDER BY t DESC LIMIT 1`);
  const countSince = db.prepare('SELECT COUNT(*) AS n FROM samples WHERE symbol = ? AND t >= ?');
  const firstSample = db.prepare('SELECT MIN(t) AS first FROM samples');
  const firstOf = db.prepare('SELECT MIN(t) AS first FROM samples WHERE symbol = ?');
  const pruneBatch = db.prepare('DELETE FROM samples WHERE (symbol, t) IN (SELECT symbol, t FROM samples WHERE t < ? ORDER BY t LIMIT ?)');
  const upsertPosition = db.prepare('INSERT INTO paper_positions(id, symbol, json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json');
  const deletePosition = db.prepare('DELETE FROM paper_positions WHERE id = ?');
  const allPositions = db.prepare('SELECT json FROM paper_positions');
  const insertTrade = db.prepare('INSERT INTO paper_trades(id, symbol, closed_at, net_usd, json) VALUES (?, ?, ?, ?, ?)');
  const recentTrades = db.prepare('SELECT json FROM paper_trades ORDER BY closed_at DESC LIMIT ?');
  const tradesSince = db.prepare('SELECT json FROM paper_trades WHERE closed_at >= ? ORDER BY closed_at');
  const symbolTrades = db.prepare('SELECT json FROM paper_trades WHERE symbol = ? AND closed_at >= ? ORDER BY closed_at');
  const tradeTotals = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(net_usd), 0) AS net, SUM(CASE WHEN net_usd > 0 THEN 1 ELSE 0 END) AS wins, MIN(closed_at) AS first FROM paper_trades');
  const netSince = db.prepare('SELECT COALESCE(SUM(net_usd), 0) AS net FROM paper_trades WHERE closed_at >= ?');
  const insertEvent = db.prepare('INSERT INTO events(at, kind, symbol, message) VALUES (?, ?, ?, ?)');
  const recentEvents = db.prepare('SELECT id, at, kind, symbol, message FROM events ORDER BY id DESC LIMIT ?');
  const pruneEvents = db.prepare('DELETE FROM events WHERE at < ?');
  const readState = db.prepare('SELECT json FROM state WHERE key = ?');
  const writeState = db.prepare('INSERT INTO state(key, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at');
  const transaction = <T>(work: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = work(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  return {
    /** 写入一批样本，已有同一时刻的忽略；返回新写入的条数。 */
    addSamples(samples: readonly Sample[]): number {
      if (!samples.length) return 0;
      return transaction(() => samples.reduce((count, sample) => count + Number(insertSample.run(...toRow(sample)).changes), 0));
    },
    samples(symbol: string, from: number, to: number): Sample[] { return (selectRange.all(symbol, from, to) as Row[]).map(fromRow); },
    latest(symbol: string): Sample | null { const row = selectLatest.get(symbol) as Row | undefined; return row ? fromRow(row) : null; },
    /** 某配对某时刻以来的样本数（走主键；满量时 210 个配对合计约 60 ms，引擎缓存 10 分钟）。 */
    countSince(symbol: string, since: number): number { return (countSince.get(symbol, since) as { n: number }).n; },
    /** 最早的样本时刻（走 t 索引）。 */
    firstSampleAt(): number | null { return ((firstSample.get() as { first: number | null } | undefined)?.first) ?? null; },
    /** 某配对最早的样本时刻（走主键）。 */
    firstAt(symbol: string): number | null { return ((firstOf.get(symbol) as { first: number | null } | undefined)?.first) ?? null; },
    /** 删掉保留期以前最早的至多 limit 条样本，返回删除条数；调用方分批删、批间让出事件循环。 */
    pruneSamples(now: number, limit: number): number { return Number(pruneBatch.run(now - SAMPLE_RETENTION_DAYS * 86_400_000, limit).changes); },
    /** 删掉 30 天前的事件。 */
    pruneEvents(now: number): void { pruneEvents.run(now - 30 * 86_400_000); },
    positions(): Position[] { return (allPositions.all() as { json: string }[]).map(row => JSON.parse(row.json) as Position); },
    savePosition(position: Position): void { upsertPosition.run(position.id, position.symbol, JSON.stringify(position)); },
    /** 平仓：删持仓、记成交、记事件在同一事务里。 */
    closePosition(trade: ClosedTrade, event: { at: number; kind: string; message: string }): void {
      transaction(() => {
        deletePosition.run(trade.id);
        insertTrade.run(trade.id, trade.symbol, trade.closedAt, trade.netUsd, JSON.stringify(trade));
        insertEvent.run(event.at, event.kind, trade.symbol, event.message);
      });
    },
    openPosition(position: Position, event: { at: number; kind: string; message: string }): void {
      transaction(() => { upsertPosition.run(position.id, position.symbol, JSON.stringify(position)); insertEvent.run(event.at, event.kind, position.symbol, event.message); });
    },
    trades(limit: number): ClosedTrade[] { return (recentTrades.all(limit) as { json: string }[]).map(row => JSON.parse(row.json) as ClosedTrade); },
    tradesSince(since: number): ClosedTrade[] { return (tradesSince.all(since) as { json: string }[]).map(row => JSON.parse(row.json) as ClosedTrade); },
    symbolTrades(symbol: string, since: number): ClosedTrade[] { return (symbolTrades.all(symbol, since) as { json: string }[]).map(row => JSON.parse(row.json) as ClosedTrade); },
    totals(): { trades: number; netUsd: number; wins: number; first: number | null } {
      const row = tradeTotals.get() as { n: number; net: number; wins: number | null; first: number | null };
      return { trades: row.n, netUsd: row.net, wins: row.wins ?? 0, first: row.first };
    },
    netSince(since: number): number { return (netSince.get(since) as { net: number }).net; },
    event(at: number, kind: string, symbol: string | null, message: string): void { insertEvent.run(at, kind, symbol, message.slice(0, 500)); },
    events(limit: number): StoredEvent[] { return recentEvents.all(limit) as unknown as StoredEvent[]; },
    /** 清空模拟盘（持仓与成交），记一条事件。 */
    resetPaper(at: number): void {
      transaction(() => { db.exec('DELETE FROM paper_positions; DELETE FROM paper_trades;'); insertEvent.run(at, 'reset', null, '模拟盘已清空'); });
    },
    state<T>(key: string): T | null { const row = readState.get(key) as { json: string } | undefined; return row ? JSON.parse(row.json) as T : null; },
    setState(key: string, value: unknown, at: number): void { writeState.run(key, JSON.stringify(value), at); },
    close(): void { db.close(); },
  };
}
