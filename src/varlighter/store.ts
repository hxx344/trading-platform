// DEX 价差模块自己的数据库（varlighter.sqlite，docs/varlighter.md 第 7 节、docs/dexspread.md 第 7 节）：对齐样本、模拟盘持仓与成交、
// 参数与事件。执行器数据库结构不动；丢掉这个文件只丢采集历史与模拟盘记录，不影响任何真实交易。
// v0.88.0 起样本、持仓与成交写两腿口径的新表（leg_samples、leg_positions、leg_trades），旧表（samples、paper_positions、paper_trades）
// 不再写也不改：旧样本按配对键映射后与新表合并读出，旧持仓与成交在首次启动时一次性复制到新表（同一事务，带完成标记）。
// 回退到 v0.87.0 时旧版本照常读写旧表，升级后新开的模拟盘记录在回退版本里看不到（docs/dexspread.md 第 9 节）。
import { DatabaseSync } from 'node:sqlite';
import { SAMPLE_FIELDS, legacyKeyOf, upgradeKey, varHourly, type Regime, type Sample } from './model.ts';
import { upgradePosition, type ClosedTrade, type LegFees, type Position } from './strategy.ts';
import type { Settings } from './views.ts';

export const VARLIGHTER_FILE = 'varlighter.sqlite';
/** 样本保留天数：约 300 个配对每分钟各一条（两腿都是行情流的启用配对每 15 秒一条），每天约 45 万条；14 天约 600 万条（库文件大小见 docs/varlighter.md 第 7 节）。 */
export const SAMPLE_RETENTION_DAYS = 14;
/** 旧表迁移完成的标记（state 表的键）。 */
export const MIGRATED_KEY = 'legs_migrated';
export const SETTINGS_KEY = 'settings2', COOLDOWN_KEY = 'cooldown2';

// ---- 新表（两腿口径） ----
const snake = (field: string) => field.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`).replace(/^([ab])([a-z])/, '$1_$2').replace(/(\d+)k$/, '$1k');
/** Sample 字段与列名一一对应（aBid0 → a_bid0，aBidRx → a_bid_rx，receivedAt → received_at）。 */
const LEG_FIELDS = SAMPLE_FIELDS;
const LEG_COLUMNS = LEG_FIELDS.map(snake);
const NOT_NULL = new Set(['symbol', 't', 'receivedAt', 'regime', 'ratio', 'aAt', 'aBid0', 'aAsk0', 'bAt', 'bBid0', 'bAsk0']);
const columnType = (field: string) => field === 'symbol' || field === 'regime' || field === 'captureKind' ? 'TEXT' : field === 't' || field.endsWith('At') ? 'INTEGER' : 'REAL';
const legDefinition = LEG_FIELDS.map((field, index) => `${LEG_COLUMNS[index]} ${columnType(field)}${NOT_NULL.has(field) ? ' NOT NULL' : ''}`).join(', ');
type LegRow = Record<string, unknown>;
const legRow = (sample: Sample): (string | number | null)[] => LEG_FIELDS.map(field => sample[field] ?? null);
const fromLegRow = (row: LegRow): Sample => Object.fromEntries(LEG_FIELDS.map((field, index) => {
  const value = row[LEG_COLUMNS[index]];
  return [field, typeof value === 'number' || typeof value === 'string' ? value : null];
})) as unknown as Sample;

// ---- 旧表（v0.87.0 以前，Var 对一个 Lighter 场所） ----
const OLD_COLUMNS = ['symbol', 't', 'received_at', 'regime', 'var_mark', 'var_bid0', 'var_ask0', 'var_bid1k', 'var_ask1k', 'var_bid100k', 'var_ask100k', 'var_funding',
  'rh_at', 'rh_bid0', 'rh_ask0', 'rh_mark', 'rh_index', 'rh_funding', 'rh_bid1k', 'rh_ask1k', 'rh_bid100k', 'rh_ask100k', 'rh_bid_rx', 'rh_ask_rx', 'var_bid_tk', 'var_ask_tk', 'var_tk_at', 'legacy_aligned'] as const;
type OldRow = Record<typeof OLD_COLUMNS[number], unknown>;
const nullable = (value: unknown): number | null => typeof value === 'number' ? value : null;
/** 旧样本换成两腿口径：A 是 Var（年化资金费折成每小时），B 是 Lighter 场所；乘数 1。 */
const fromOldRow = (row: OldRow, key: string): Sample => ({
  symbol: key, t: row.t as number, receivedAt: row.received_at as number, regime: row.regime as Regime, ratio: 1,
  aAt: row.t as number, aMark: nullable(row.var_mark), aIndex: null, aFunding: varHourly(nullable(row.var_funding)),
  aBid0: row.var_bid0 as number, aAsk0: row.var_ask0 as number, aBid1k: nullable(row.var_bid1k), aAsk1k: nullable(row.var_ask1k),
  aBid100k: nullable(row.var_bid100k), aAsk100k: nullable(row.var_ask100k), aBidRx: null, aAskRx: null,
  aBidTk: nullable(row.var_bid_tk), aAskTk: nullable(row.var_ask_tk), aTkAt: nullable(row.var_tk_at),
  bAt: row.rh_at as number, bMark: nullable(row.rh_mark), bIndex: nullable(row.rh_index), bFunding: nullable(row.rh_funding),
  bBid0: row.rh_bid0 as number, bAsk0: row.rh_ask0 as number, bBid1k: nullable(row.rh_bid1k), bAsk1k: nullable(row.rh_ask1k),
  bBid100k: nullable(row.rh_bid100k), bAsk100k: nullable(row.rh_ask100k), bBidRx: nullable(row.rh_bid_rx), bAskRx: nullable(row.rh_ask_rx),
  bBidTk: null, bAskTk: null, bTkAt: null,
  decisionAt: null, aRxAt: null, bRxAt: null, aTkQty: null, bTkQty: null, aTkReceivedAt: null, bTkReceivedAt: null,
  captureKind: row.legacy_aligned === 1 ? 'aligned' : null,
});
/** 两组按 t 升序的样本合并；同一时刻以新表为准。 */
function mergeByTime(old: Sample[], fresh: Sample[]): Sample[] {
  if (!old.length) return fresh;
  if (!fresh.length) return old;
  const result: Sample[] = [];
  let i = 0, j = 0;
  while (i < old.length || j < fresh.length) {
    if (j >= fresh.length || (i < old.length && old[i].t < fresh[j].t)) result.push(old[i++]);
    else { if (i < old.length && old[i].t === fresh[j].t) i++; result.push(fresh[j++]); }
  }
  return result;
}

export interface StoredEvent { id: number; at: number; kind: string; symbol: string | null; message: string }
export type VarLighterStore = ReturnType<typeof openVarLighterStore>;
/** 迁移用的转换：旧参数换成新参数（引擎提供），旧持仓的手续费取旧参数里的 Var 与 Lighter 手续费。 */
export interface LegacyUpgrade { settings: (old: unknown) => unknown; cooldown: (old: unknown) => unknown; fees: (old: unknown) => LegFees }

export function openVarLighterStore(file: string) {
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=2000;
    CREATE TABLE IF NOT EXISTS samples (symbol TEXT NOT NULL, t INTEGER NOT NULL, received_at INTEGER NOT NULL, regime TEXT NOT NULL,
      var_mark REAL NOT NULL, var_bid0 REAL NOT NULL, var_ask0 REAL NOT NULL, var_bid1k REAL NOT NULL, var_ask1k REAL NOT NULL, var_bid100k REAL, var_ask100k REAL, var_funding REAL,
      rh_at INTEGER NOT NULL, rh_bid0 REAL NOT NULL, rh_ask0 REAL NOT NULL, rh_mark REAL, rh_index REAL, rh_funding REAL, rh_bid1k REAL, rh_ask1k REAL, rh_bid100k REAL, rh_ask100k REAL,
      rh_bid_rx REAL, rh_ask_rx REAL, var_bid_tk REAL, var_ask_tk REAL, var_tk_at REAL, legacy_aligned INTEGER,
      PRIMARY KEY (symbol, t)) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS samples_t ON samples(t);
    CREATE TABLE IF NOT EXISTS paper_positions (id TEXT PRIMARY KEY, symbol TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS paper_trades (id TEXT PRIMARY KEY, symbol TEXT NOT NULL, closed_at INTEGER NOT NULL, net_usd REAL NOT NULL, json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS paper_trades_closed ON paper_trades(closed_at);
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, symbol TEXT, message TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS leg_samples (${legDefinition}, PRIMARY KEY (symbol, t)) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS leg_samples_t ON leg_samples(t);
    CREATE TABLE IF NOT EXISTS leg_positions (id TEXT PRIMARY KEY, symbol TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS leg_trades (id TEXT PRIMARY KEY, symbol TEXT NOT NULL, closed_at INTEGER NOT NULL, net_usd REAL NOT NULL, json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS leg_trades_closed ON leg_trades(closed_at);
    CREATE INDEX IF NOT EXISTS leg_trades_symbol ON leg_trades(symbol, closed_at);`);
    // v0.81.0、v0.82.0 给旧表加的可空列；新版本不再写旧表，但旧库可能还没有这些列（读旧样本时按列名读）。
    db.exec('BEGIN IMMEDIATE');
    const existing = new Set((db.prepare('PRAGMA table_info(samples)').all() as { name: string }[]).map(column => column.name));
    if (!existing.has('legacy_aligned')) {
      // 只有从未加过判断盘口列的旧表才一次性登记现有行。默认 NULL 让回退后的新行保守地保持未知。
      const preLive = ['rh_bid_rx', 'rh_ask_rx', 'var_bid_tk', 'var_ask_tk', 'var_tk_at'].every(column => !existing.has(column));
      db.exec('ALTER TABLE samples ADD COLUMN legacy_aligned INTEGER');
      if (preLive) db.exec('UPDATE samples SET legacy_aligned = 1');
    }
    for (const column of ['rh_bid_rx', 'rh_ask_rx', 'var_bid_tk', 'var_ask_tk', 'var_tk_at']) if (!existing.has(column)) db.exec(`ALTER TABLE samples ADD COLUMN ${column} REAL`);
    // 旧两腿表按列名读写。只添可空列，保留历史缺证状态，也兼容旧版本继续写入。
    const legColumns = new Set((db.prepare('PRAGMA table_info(leg_samples)').all() as { name: string }[]).map(column => column.name));
    for (const field of LEG_FIELDS) {
      const column = snake(field);
      if (!legColumns.has(column)) db.exec(`ALTER TABLE leg_samples ADD COLUMN ${column} ${columnType(field)}`);
    }
    db.exec('COMMIT');
  } catch (error) { db.close(); throw error; }
  const insertSample = db.prepare(`INSERT OR IGNORE INTO leg_samples(${LEG_COLUMNS.join(', ')}) VALUES (${LEG_COLUMNS.map(() => '?').join(', ')})`);
  const selectRange = db.prepare(`SELECT ${LEG_COLUMNS.join(', ')} FROM leg_samples WHERE symbol = ? AND t >= ? AND t <= ? ORDER BY t`);
  const selectAfter = db.prepare(`SELECT ${LEG_COLUMNS.join(', ')} FROM leg_samples WHERE symbol = ? AND t > ? ORDER BY t LIMIT ?`);
  const selectLatest = db.prepare(`SELECT ${LEG_COLUMNS.join(', ')} FROM leg_samples WHERE symbol = ? ORDER BY t DESC LIMIT 1`);
  const countSince = db.prepare('SELECT COUNT(*) AS n FROM leg_samples WHERE symbol = ? AND t >= ?');
  const firstSample = db.prepare('SELECT MIN(t) AS first FROM leg_samples');
  const firstOf = db.prepare('SELECT MIN(t) AS first FROM leg_samples WHERE symbol = ?');
  const pruneBatch = db.prepare('DELETE FROM leg_samples WHERE (symbol, t) IN (SELECT symbol, t FROM leg_samples WHERE t < ? ORDER BY t LIMIT ?)');
  const oldRange = db.prepare(`SELECT ${OLD_COLUMNS.join(', ')} FROM samples WHERE symbol = ? AND t >= ? AND t <= ? ORDER BY t`);
  const oldAfter = db.prepare(`SELECT ${OLD_COLUMNS.join(', ')} FROM samples WHERE symbol = ? AND t > ? ORDER BY t LIMIT ?`);
  const oldLatest = db.prepare(`SELECT ${OLD_COLUMNS.join(', ')} FROM samples WHERE symbol = ? ORDER BY t DESC LIMIT 1`);
  const oldCount = db.prepare('SELECT COUNT(*) AS n FROM samples WHERE symbol = ? AND t >= ?');
  const oldFirst = db.prepare('SELECT MIN(t) AS first FROM samples');
  const oldFirstOf = db.prepare('SELECT MIN(t) AS first FROM samples WHERE symbol = ?');
  const oldPrune = db.prepare('DELETE FROM samples WHERE (symbol, t) IN (SELECT symbol, t FROM samples WHERE t < ? ORDER BY t LIMIT ?)');
  const upsertPosition = db.prepare('INSERT INTO leg_positions(id, symbol, json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json');
  const deletePosition = db.prepare('DELETE FROM leg_positions WHERE id = ?');
  const allPositions = db.prepare('SELECT json FROM leg_positions');
  const insertTrade = db.prepare('INSERT OR IGNORE INTO leg_trades(id, symbol, closed_at, net_usd, json) VALUES (?, ?, ?, ?, ?)');
  const recentTrades = db.prepare('SELECT json FROM leg_trades ORDER BY closed_at DESC LIMIT ?');
  const tradesSince = db.prepare('SELECT json FROM leg_trades WHERE closed_at >= ? ORDER BY closed_at');
  const symbolTrades = db.prepare('SELECT json FROM leg_trades WHERE symbol = ? AND closed_at >= ? ORDER BY closed_at');
  const tradeTotals = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(net_usd), 0) AS net, SUM(CASE WHEN net_usd > 0 THEN 1 ELSE 0 END) AS wins, MIN(closed_at) AS first FROM leg_trades');
  const netSince = db.prepare('SELECT COALESCE(SUM(net_usd), 0) AS net FROM leg_trades WHERE closed_at >= ?');
  const insertEvent = db.prepare('INSERT INTO events(at, kind, symbol, message) VALUES (?, ?, ?, ?)');
  const recentEvents = db.prepare('SELECT id, at, kind, symbol, message FROM events ORDER BY id DESC LIMIT ?');
  const pruneEvents = db.prepare('DELETE FROM events WHERE at < ?');
  const readState = db.prepare('SELECT json FROM state WHERE key = ?');
  const writeState = db.prepare('INSERT INTO state(key, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at');
  const transaction = <T>(work: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = work(); db.exec('COMMIT'); return result; } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  };
  const legacy = (key: string, read: (old: string) => unknown[]): Sample[] => {
    const old = legacyKeyOf(key);
    return old ? (read(old) as OldRow[]).map(row => fromOldRow(row, key)) : [];
  };
  const fresh = (rows: unknown[]) => (rows as LegRow[]).map(fromLegRow);
  const parse = <T>(rows: unknown[]) => (rows as { json: string }[]).map(row => JSON.parse(row.json) as T);
  const minimum = (...values: (number | null | undefined)[]) => { const known = values.filter((value): value is number => typeof value === 'number'); return known.length ? Math.min(...known) : null; };
  /** 只返回本事务新插入的样本。重复键保留先前证据，采样方不能再次推进基线或成交。 */
  const addNewSamples = (samples: readonly Sample[]): Sample[] => samples.length
    ? transaction(() => samples.filter(sample => Number(insertSample.run(...legRow(sample)).changes) > 0)) : [];
  return {
    /** 写入一批样本，已有同一时刻的忽略；返回新写入的条数。 */
    addSamples(samples: readonly Sample[]): number {
      return addNewSamples(samples).length;
    },
    addNewSamples,
    samples(symbol: string, from: number, to: number): Sample[] {
      return mergeByTime(legacy(symbol, old => oldRange.all(old, from, to)), fresh(selectRange.all(symbol, from, to)));
    },
    /** 某配对 after 之后（不含）按时刻升序的至多 limit 条样本，走主键；只读导出（docs/mcp.md 第 8.3 节）用。 */
    samplesAfter(symbol: string, after: number, limit: number): Sample[] {
      return mergeByTime(legacy(symbol, old => oldAfter.all(old, after, limit)), fresh(selectAfter.all(symbol, after, limit))).slice(0, limit);
    },
    latest(symbol: string): Sample | null {
      const row = selectLatest.get(symbol) as LegRow | undefined, newer = row ? fromLegRow(row) : null;
      const old = legacyKeyOf(symbol), oldRow = old ? oldLatest.get(old) as OldRow | undefined : undefined, older = oldRow ? fromOldRow(oldRow, symbol) : null;
      return newer && (!older || newer.t >= older.t) ? newer : older;
    },
    /** 某配对某时刻以来的样本数（走主键；满量时合计约 100 ms，引擎缓存 10 分钟）。 */
    countSince(symbol: string, since: number): number {
      const old = legacyKeyOf(symbol);
      return (countSince.get(symbol, since) as { n: number }).n + (old ? (oldCount.get(old, since) as { n: number }).n : 0);
    },
    /** 最早的样本时刻（走 t 索引）。 */
    firstSampleAt(): number | null { return minimum((firstSample.get() as { first: number | null } | undefined)?.first, (oldFirst.get() as { first: number | null } | undefined)?.first); },
    /** 某配对最早的样本时刻（走主键）。 */
    firstAt(symbol: string): number | null {
      const old = legacyKeyOf(symbol);
      return minimum((firstOf.get(symbol) as { first: number | null } | undefined)?.first, old ? (oldFirstOf.get(old) as { first: number | null } | undefined)?.first : null);
    },
    /** 删掉保留期以前最早的至多 limit 条样本（先旧表后新表），返回删除条数；调用方分批删、批间让出事件循环。 */
    pruneSamples(now: number, limit: number): number {
      const cutoff = now - SAMPLE_RETENTION_DAYS * 86_400_000, old = Number(oldPrune.run(cutoff, limit).changes);
      return old >= limit ? old : old + Number(pruneBatch.run(cutoff, limit - old).changes);
    },
    /** 删掉 30 天前的事件。 */
    pruneEvents(now: number): void { pruneEvents.run(now - 30 * 86_400_000); },
    positions(): Position[] { return parse<Position>(allPositions.all()); },
    savePosition(position: Position): void { upsertPosition.run(position.id, position.symbol, JSON.stringify(position)); },
    /** 平仓时持仓、成交、事件和冷却一起提交。 */
    closePosition(trade: ClosedTrade, event: { at: number; kind: string; message: string }, cooldown: Record<string, number>): void {
      transaction(() => {
        deletePosition.run(trade.id);
        insertTrade.run(trade.id, trade.symbol, trade.closedAt, trade.netUsd, JSON.stringify(trade));
        writeState.run(COOLDOWN_KEY, JSON.stringify(cooldown), event.at);
        insertEvent.run(event.at, event.kind, trade.symbol, event.message);
      });
    },
    openPosition(position: Position, event: { at: number; kind: string; message: string }): void {
      transaction(() => { upsertPosition.run(position.id, position.symbol, JSON.stringify(position)); insertEvent.run(event.at, event.kind, position.symbol, event.message); });
    },
    trades(limit: number): ClosedTrade[] { return parse<ClosedTrade>(recentTrades.all(limit)); },
    tradesSince(since: number): ClosedTrade[] { return parse<ClosedTrade>(tradesSince.all(since)); },
    symbolTrades(symbol: string, since: number): ClosedTrade[] { return parse<ClosedTrade>(symbolTrades.all(symbol, since)); },
    totals(): { trades: number; netUsd: number; wins: number; first: number | null } {
      const row = tradeTotals.get() as { n: number; net: number; wins: number | null; first: number | null };
      return { trades: row.n, netUsd: row.net, wins: row.wins ?? 0, first: row.first };
    },
    netSince(since: number): number { return (netSince.get(since) as { net: number }).net; },
    event(at: number, kind: string, symbol: string | null, message: string): void { insertEvent.run(at, kind, symbol, message.slice(0, 500)); },
    events(limit: number): StoredEvent[] { return recentEvents.all(limit) as unknown as StoredEvent[]; },
    /** 清空模拟盘的持仓、成交和冷却，保留事件历史。 */
    resetPaper(at: number): void {
      transaction(() => {
        db.exec('DELETE FROM leg_positions; DELETE FROM leg_trades;');
        writeState.run(COOLDOWN_KEY, '{}', at);
        insertEvent.run(at, 'reset', null, '模拟盘已清空');
      });
    },
    saveSettings(settings: Settings, at: number, message: string): void {
      transaction(() => {
        writeState.run(SETTINGS_KEY, JSON.stringify(settings), at);
        insertEvent.run(at, 'settings', null, message.slice(0, 500));
      });
    },
    state<T>(key: string): T | null { const row = readState.get(key) as { json: string } | undefined; return row ? JSON.parse(row.json) as T : null; },
    setState(key: string, value: unknown, at: number): void { writeState.run(key, JSON.stringify(value), at); },
    /**
     * 首次启动的一次性迁移（已有完成标记时什么都不做，返回 false）：旧持仓与成交换成两腿口径复制到新表，旧参数（settings）
     * 与冷却（cooldown）换成新键（settings2、cooldown2）。全部在一个事务里，失败整体回滚、下次启动重试。旧表与旧键原样保留。
     */
    migrateLegacy(at: number, upgrade: LegacyUpgrade): { positions: number; trades: number; skipped: number } | false {
      return transaction(() => {
        if (readState.get(MIGRATED_KEY)) return false;
        const oldSettings = (readState.get('settings') as { json: string } | undefined)?.json;
        const parsedSettings: unknown = oldSettings ? JSON.parse(oldSettings) : null;
        const fees = upgrade.fees(parsedSettings);
        let positions = 0, trades = 0, skipped = 0;
        for (const row of db.prepare('SELECT symbol, json FROM paper_positions').all() as { symbol: string; json: string }[]) {
          const key = upgradeKey(row.symbol), position = key ? upgradePosition<Position>(JSON.parse(row.json), key, fees) : null;
          if (!position) { skipped++; continue; }
          upsertPosition.run(position.id, position.symbol, JSON.stringify(position)); positions++;
        }
        for (const row of db.prepare('SELECT symbol, json FROM paper_trades').all() as { symbol: string; json: string }[]) {
          const key = upgradeKey(row.symbol), trade = key ? upgradePosition<ClosedTrade>(JSON.parse(row.json), key, fees) : null;
          if (!trade) { skipped++; continue; }
          insertTrade.run(trade.id, trade.symbol, trade.closedAt, trade.netUsd, JSON.stringify(trade)); trades++;
        }
        if (parsedSettings !== null) writeState.run(SETTINGS_KEY, JSON.stringify(upgrade.settings(parsedSettings)), at);
        const oldCooldown = (readState.get('cooldown') as { json: string } | undefined)?.json;
        if (oldCooldown) writeState.run(COOLDOWN_KEY, JSON.stringify(upgrade.cooldown(JSON.parse(oldCooldown))), at);
        const result = { positions, trades, skipped };
        writeState.run(MIGRATED_KEY, JSON.stringify({ at, ...result }), at);
        if (positions || trades || parsedSettings !== null) insertEvent.run(at, 'migrate', null, `已升级为两腿口径：持仓 ${positions} 笔、成交 ${trades} 笔${skipped ? `，${skipped} 条无法识别未迁移` : ''}`);
        return result;
      });
    },
    close(): void { db.close(); },
  };
}
