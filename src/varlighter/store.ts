// DEX 价差模块自己的数据库（varlighter.sqlite，docs/varlighter.md 第 7 节、docs/dexspread.md 第 7 节）：对齐样本、模拟盘持仓与成交、
// 参数与事件。执行器数据库结构不动；丢掉这个文件只丢采集历史与模拟盘记录，不影响任何真实交易。
// v0.88.0 起样本、持仓与成交写两腿口径的新表（leg_samples、leg_positions、leg_trades），旧表（samples、paper_positions、paper_trades）
// 不再写也不改：旧样本按配对键映射后与新表合并读出，旧持仓与成交在首次启动时一次性复制到新表（同一事务，带完成标记）。
// 回退到 v0.87.0 时旧版本照常读写旧表，升级后新开的模拟盘记录在回退版本里看不到（docs/dexspread.md 第 9 节）。
import { DatabaseSync } from 'node:sqlite';
import { SAMPLE_FIELDS, legacyKeyOf, upgradeKey, varHourly, type BaselinePoint, type Regime, type Sample } from './model.ts';
import { upgradePosition, type ClosedTrade, type LegFees, type Position } from './strategy.ts';
import type { Settings } from './views.ts';
import type { LivePosition } from './live.ts';
import { FIRST_LEG_MISSED_NOTE } from './live-summary.ts';

export const VARLIGHTER_FILE = 'varlighter.sqlite';
/** 样本保留天数：约 300 个配对每分钟各一条（两腿都是行情流的配对每 20 秒一条、启用的每 5 秒一条，条数随这类配对的个数变），容量估算见 docs/varlighter.md 第 7 节。 */
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
export interface AccountSnapshotRow {
  venue: string;
  accountHash: string;
  at: number;
  equity: number;
  collateral: number;
  available: number;
  unrealizedPnl: number | null;
  positions: number;
}
export const ACCOUNT_SNAPSHOT_RETENTION_DAYS = 30;
export interface StoredEntropyFill {
  accountHash: string; tid: number; oid: number; cloid: string | null; time: number; coin: string; side: 'B' | 'A'; dir: string | null;
  crossed: boolean; px: number; sz: number; notionalUsd: number; feeUsd: number; feeToken: string; builderFeeUsd: number; closedPnl: number | null;
  livePositionId: string | null; livePurpose: string | null;
  assumedFeeBps: number | null; catalogFeeBps: number | null; deployerFeeScale: number | null; growthMode: string | null;
  hlCrossRate: number | null; hlReferralDiscount: number | null; hlStakingDiscount: number | null; hypePriceUsd: number | null;
  recordedAt: number;
}
export interface StoredEntropyFeeSnapshot {
  id?: number; accountHash: string; at: number;
  userCrossRate: number | null; userAddRate: number | null; referralDiscount: number | null; stakingDiscount: number | null;
  hypePriceUsd: number | null; assumedFeeBps: number | null;
}
export interface StoredEntropyOrderLink {
  cloid: string; accountHash: string; positionId: string; purpose: string; coin: string;
  assumedFeeBps: number | null; catalogFeeBps: number | null; deployerFeeScale: number | null; growthMode: string | null;
  at: number;
}
export type VarLighterStore = ReturnType<typeof openVarLighterStore>;
/** 迁移用的转换：旧参数换成新参数（引擎提供），旧持仓的手续费取旧参数里的 Var 与 Lighter 手续费。 */
export interface LegacyUpgrade { settings: (old: unknown) => unknown; cooldown: (old: unknown) => unknown; fees: (old: unknown) => LegFees }

type RangeStatement = ReturnType<DatabaseSync['prepare']>;
/** 旧表与新表里同一个配对 [from, to] 的行按时刻合并成一个升序序列；同一时刻以新表为准。 */
function* mergedRange<T>(selectRange: RangeStatement, oldRange: RangeStatement, symbol: string, from: number, to: number, fromNew: (row: LegRow) => T, fromOld: (row: LegRow) => T): Generator<T> {
  const old = legacyKeyOf(symbol);
  let older: ReturnType<typeof oldRange.iterate> | undefined;
  let newer: ReturnType<typeof selectRange.iterate> | undefined;
  try {
    older = old ? oldRange.iterate(old, from, to) : undefined;
    newer = selectRange.iterate(symbol, from, to);
    let left = older?.next(), right = newer.next();
    while ((left && !left.done) || !right.done) {
      if (left && !left.done && (right.done || Number(left.value.t) < Number(right.value.t))) {
        yield fromOld(left.value);
        left = older!.next();
      } else if (!right.done) {
        if (left && !left.done && left.value.t === right.value.t) left = older!.next();
        yield fromNew(right.value);
        right = newer.next();
      }
    }
  } finally { newer?.return?.(); older?.return?.(); }
}
// Both the DEX writer and the read-only replay worker must resolve duplicate timestamps the same way.
export function prepareSampleRange(db: DatabaseSync) {
  const selectRange = db.prepare(`SELECT ${LEG_COLUMNS.join(', ')} FROM leg_samples WHERE symbol = ? AND t >= ? AND t <= ? ORDER BY t`);
  const oldRange = db.prepare(`SELECT ${OLD_COLUMNS.join(', ')} FROM samples WHERE symbol = ? AND t >= ? AND t <= ? ORDER BY t`);
  return (symbol: string, from: number, to: number): Generator<Sample> => mergedRange(selectRange, oldRange, symbol, from, to, fromLegRow, row => fromOldRow(row as OldRow, symbol));
}

// ---- 基线只用到的列（预热基线时不读整行） ----
const BASELINE_COLUMNS = 't, regime, ratio, a_bid0, a_ask0, b_bid0, b_ask0';
const OLD_BASELINE_COLUMNS = 't, regime, var_bid0, var_ask0, rh_bid0, rh_ask0';
const baselineFromLeg = (row: LegRow): BaselinePoint => ({ t: row.t as number, regime: row.regime as Regime, ratio: row.ratio as number, aBid0: row.a_bid0 as number, aAsk0: row.a_ask0 as number, bBid0: row.b_bid0 as number, bAsk0: row.b_ask0 as number });
const baselineFromOld = (row: LegRow): BaselinePoint => ({ t: row.t as number, regime: row.regime as Regime, ratio: 1, aBid0: row.var_bid0 as number, aAsk0: row.var_ask0 as number, bBid0: row.rh_bid0 as number, bAsk0: row.rh_ask0 as number });
/** 已结束实盘持仓按（配对、UTC 日、平仓原因、有没有成交、是否单腿）分组的一行。 */
/** sent：第一腿发出去过（没成交的记录用它区分「发出去没成交」与「发单前就放弃」；有成交的恒为真）。 */
export interface LiveSummaryRow { symbol: string; day: number; reason: string; traded: boolean; singleLeg: boolean; sent: boolean; count: number; netUsd: number; wins: number }

export function openVarLighterStore(file: string) {
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=2000; PRAGMA journal_size_limit=4194304;
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
    CREATE INDEX IF NOT EXISTS leg_trades_symbol ON leg_trades(symbol, closed_at);
    CREATE TABLE IF NOT EXISTS live_positions (id TEXT PRIMARY KEY, symbol TEXT NOT NULL, state TEXT NOT NULL, opened_at INTEGER NOT NULL, closed_at INTEGER, net_usd REAL, json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS live_positions_state ON live_positions(state, closed_at);
    CREATE TABLE IF NOT EXISTS account_snapshots (
      venue TEXT NOT NULL,
      account_hash TEXT NOT NULL,
      at INTEGER NOT NULL,
      equity REAL NOT NULL,
      collateral REAL NOT NULL,
      available REAL NOT NULL,
      unrealized_pnl REAL,
      positions INTEGER NOT NULL,
      PRIMARY KEY (venue, account_hash, at)
    );
    CREATE INDEX IF NOT EXISTS account_snapshots_at ON account_snapshots(at);
    CREATE TABLE IF NOT EXISTS entropy_fills (account_hash TEXT NOT NULL, tid INTEGER NOT NULL, oid INTEGER NOT NULL, cloid TEXT, time INTEGER NOT NULL,
      coin TEXT NOT NULL, side TEXT NOT NULL, dir TEXT, crossed INTEGER NOT NULL, px REAL NOT NULL, sz REAL NOT NULL, notional_usd REAL NOT NULL,
      fee_usd REAL NOT NULL, fee_token TEXT NOT NULL, builder_fee_usd REAL NOT NULL, closed_pnl REAL, live_position_id TEXT, live_purpose TEXT,
      assumed_fee_bps REAL, catalog_fee_bps REAL, deployer_fee_scale REAL, growth_mode TEXT,
      hl_cross_rate REAL, hl_referral_discount REAL, hl_staking_discount REAL, hype_price_usd REAL, recorded_at INTEGER NOT NULL,
      PRIMARY KEY (account_hash, tid)) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS entropy_fills_account_time ON entropy_fills(account_hash, time);
    CREATE TABLE IF NOT EXISTS entropy_fee_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, account_hash TEXT NOT NULL, at INTEGER NOT NULL,
      user_cross_rate REAL, user_add_rate REAL, referral_discount REAL, staking_discount REAL, hype_price_usd REAL, assumed_fee_bps REAL);
    CREATE INDEX IF NOT EXISTS entropy_fee_snapshots_account_at ON entropy_fee_snapshots(account_hash, at);
    CREATE TABLE IF NOT EXISTS entropy_order_links (cloid TEXT PRIMARY KEY, account_hash TEXT NOT NULL, position_id TEXT NOT NULL, purpose TEXT NOT NULL,
      coin TEXT NOT NULL, assumed_fee_bps REAL, catalog_fee_bps REAL, deployer_fee_scale REAL, growth_mode TEXT, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS entropy_order_links_at ON entropy_order_links(at);
    CREATE INDEX IF NOT EXISTS events_at ON events(at);`);
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
  const sampleRange = prepareSampleRange(db);
  const baselineRange = db.prepare(`SELECT ${BASELINE_COLUMNS} FROM leg_samples WHERE symbol = ? AND t >= ? AND t <= ? ORDER BY t`);
  const oldBaselineRange = db.prepare(`SELECT ${OLD_BASELINE_COLUMNS} FROM samples WHERE symbol = ? AND t >= ? AND t <= ? ORDER BY t`);
  const seekSample = db.prepare(`SELECT ${LEG_COLUMNS.join(', ')} FROM leg_samples WHERE symbol = ? AND t >= ? AND t <= ? ORDER BY t LIMIT 1`);
  const oldSeekSample = db.prepare(`SELECT ${OLD_COLUMNS.join(', ')} FROM samples WHERE symbol = ? AND t >= ? AND t <= ? ORDER BY t LIMIT 1`);
  const seekBaseline = db.prepare(`SELECT ${BASELINE_COLUMNS} FROM leg_samples WHERE symbol = ? AND t >= ? AND t <= ? ORDER BY t LIMIT 1`);
  const oldSeekBaseline = db.prepare(`SELECT ${OLD_BASELINE_COLUMNS} FROM samples WHERE symbol = ? AND t >= ? AND t <= ? ORDER BY t LIMIT 1`);
  const selectAfter = db.prepare(`SELECT ${LEG_COLUMNS.join(', ')} FROM leg_samples WHERE symbol = ? AND t > ? ORDER BY t LIMIT ?`);
  const selectLatest = db.prepare(`SELECT ${LEG_COLUMNS.join(', ')} FROM leg_samples WHERE symbol = ? ORDER BY t DESC LIMIT 1`);
  const countSince = db.prepare('SELECT COUNT(*) AS n FROM leg_samples WHERE symbol = ? AND t >= ?');
  const firstSample = db.prepare('SELECT MIN(t) AS first FROM leg_samples');
  const firstOf = db.prepare('SELECT MIN(t) AS first FROM leg_samples WHERE symbol = ?');
  const pruneBatch = db.prepare('DELETE FROM leg_samples WHERE (symbol, t) IN (SELECT symbol, t FROM leg_samples WHERE t < ? ORDER BY t LIMIT ?)');
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
  // 实盘（docs/dexspread.md 第 13 节）：新表，旧版本不读不写。未结束与已结束的实盘持仓都在这张表里，清空模拟盘不动它。
  const upsertLive = db.prepare('INSERT INTO live_positions(id, symbol, state, opened_at, closed_at, net_usd, json) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, closed_at = excluded.closed_at, net_usd = excluded.net_usd, json = excluded.json');
  const liveActive = db.prepare("SELECT json FROM live_positions WHERE state <> 'closed' ORDER BY opened_at");
  const liveClosed = db.prepare("SELECT json FROM live_positions WHERE state = 'closed' ORDER BY closed_at DESC LIMIT ?");
  const liveNetSince = db.prepare("SELECT COALESCE(SUM(net_usd), 0) AS net FROM live_positions WHERE state = 'closed' AND closed_at >= ?");
  const liveTotals = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(net_usd), 0) AS net, SUM(CASE WHEN net_usd > 0 THEN 1 ELSE 0 END) AS wins FROM live_positions WHERE state = 'closed' AND (json_extract(json, '$.a.qty') > 0 OR json_extract(json, '$.b.qty') > 0)");
  const liveTradedClosed = db.prepare("SELECT json FROM live_positions WHERE state = 'closed' AND (json_extract(json, '$.a.qty') > 0 OR json_extract(json, '$.b.qty') > 0) ORDER BY closed_at DESC LIMIT ?");
  const liveSummary = db.prepare(`SELECT symbol, CAST(closed_at / 86400000 AS INTEGER) AS day, COALESCE(json_extract(json, '$.closeReason'), '') AS reason,
    (json_extract(json, '$.a.qty') > 0 OR json_extract(json, '$.b.qty') > 0) AS traded, COALESCE(json_extract(json, '$.singleLeg'), 0) AS single,
    (json_extract(json, '$.a.qty') > 0 OR json_extract(json, '$.b.qty') > 0 OR instr(COALESCE(json_extract(json, '$.note'), ''), '${FIRST_LEG_MISSED_NOTE}') > 0
      OR EXISTS (SELECT 1 FROM json_each(live_positions.json, '$.orders') AS sent_order WHERE json_extract(sent_order.value, '$.role') = 'openA')) AS sent,
    COUNT(*) AS n, COALESCE(SUM(net_usd), 0) AS net, SUM(CASE WHEN net_usd > 0 THEN 1 ELSE 0 END) AS wins
    FROM live_positions WHERE state = 'closed' AND closed_at IS NOT NULL GROUP BY 1, 2, 3, 4, 5, 6`);
  const insertEvent = db.prepare('INSERT INTO events(at, kind, symbol, message) VALUES (?, ?, ?, ?)');
  const recentEvents = db.prepare('SELECT id, at, kind, symbol, message FROM events ORDER BY id DESC LIMIT ?');
  const pruneEvents = db.prepare('DELETE FROM events WHERE at < ?');
  const insertSnapshot = db.prepare('INSERT OR IGNORE INTO account_snapshots(venue, account_hash, at, equity, collateral, available, unrealized_pnl, positions) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const selectSnapshots = db.prepare('SELECT venue, account_hash AS accountHash, at, equity, collateral, available, unrealized_pnl AS unrealizedPnl, positions FROM account_snapshots WHERE venue = ? AND account_hash = ? AND at >= ? ORDER BY at');
  const pruneSnapshots = db.prepare('DELETE FROM account_snapshots WHERE at < ?');
  const readState = db.prepare('SELECT json FROM state WHERE key = ?');
  const writeState = db.prepare('INSERT INTO state(key, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at');
  const upsertEntropyLink = db.prepare('INSERT INTO entropy_order_links(cloid, account_hash, position_id, purpose, coin, assumed_fee_bps, catalog_fee_bps, deployer_fee_scale, growth_mode, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(cloid) DO UPDATE SET account_hash = excluded.account_hash, position_id = excluded.position_id, purpose = excluded.purpose, coin = excluded.coin, assumed_fee_bps = excluded.assumed_fee_bps, catalog_fee_bps = excluded.catalog_fee_bps, deployer_fee_scale = excluded.deployer_fee_scale, growth_mode = excluded.growth_mode, at = excluded.at');
  const selectEntropyLink = db.prepare('SELECT cloid, account_hash, position_id, purpose, coin, assumed_fee_bps, catalog_fee_bps, deployer_fee_scale, growth_mode, at FROM entropy_order_links WHERE cloid = ?');
  const pruneEntropyLinks = db.prepare('DELETE FROM entropy_order_links WHERE at < ?');
  const insertEntropyFill = db.prepare(`INSERT OR IGNORE INTO entropy_fills(
    account_hash, tid, oid, cloid, time, coin, side, dir, crossed, px, sz, notional_usd, fee_usd, fee_token, builder_fee_usd, closed_pnl,
    live_position_id, live_purpose, assumed_fee_bps, catalog_fee_bps, deployer_fee_scale, growth_mode,
    hl_cross_rate, hl_referral_discount, hl_staking_discount, hype_price_usd, recorded_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const backfillEntropyFillHype = db.prepare('UPDATE entropy_fills SET hype_price_usd = ? WHERE account_hash = ? AND tid = ? AND hype_price_usd IS NULL');
  const selectEntropyFills = db.prepare(`SELECT account_hash, tid, oid, cloid, time, coin, side, dir, crossed, px, sz, notional_usd, fee_usd, fee_token, builder_fee_usd, closed_pnl,
    live_position_id, live_purpose, assumed_fee_bps, catalog_fee_bps, deployer_fee_scale, growth_mode,
    hl_cross_rate, hl_referral_discount, hl_staking_discount, hype_price_usd, recorded_at
    FROM entropy_fills WHERE account_hash = ? AND time >= ? AND time <= ? ORDER BY time DESC, tid DESC LIMIT ?`);
  const selectEntropyFillsAll = db.prepare(`SELECT account_hash, tid, oid, cloid, time, coin, side, dir, crossed, px, sz, notional_usd, fee_usd, fee_token, builder_fee_usd, closed_pnl,
    live_position_id, live_purpose, assumed_fee_bps, catalog_fee_bps, deployer_fee_scale, growth_mode,
    hl_cross_rate, hl_referral_discount, hl_staking_discount, hype_price_usd, recorded_at
    FROM entropy_fills WHERE account_hash = ? AND time >= ? AND time <= ? ORDER BY time DESC, tid DESC`);
  const insertEntropySnapshot = db.prepare('INSERT INTO entropy_fee_snapshots(account_hash, at, user_cross_rate, user_add_rate, referral_discount, staking_discount, hype_price_usd, assumed_fee_bps) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const selectLatestEntropySnapshot = db.prepare('SELECT id, account_hash, at, user_cross_rate, user_add_rate, referral_discount, staking_discount, hype_price_usd, assumed_fee_bps FROM entropy_fee_snapshots WHERE account_hash = ? ORDER BY id DESC LIMIT 1');
  const mapEntropyFill = (row: Record<string, unknown>): StoredEntropyFill => ({
    accountHash: row.account_hash as string,
    tid: row.tid as number,
    oid: row.oid as number,
    cloid: (row.cloid as string | null) ?? null,
    time: row.time as number,
    coin: row.coin as string,
    side: row.side as 'B' | 'A',
    dir: (row.dir as string | null) ?? null,
    crossed: row.crossed === 1,
    px: row.px as number,
    sz: row.sz as number,
    notionalUsd: row.notional_usd as number,
    feeUsd: row.fee_usd as number,
    feeToken: row.fee_token as string,
    builderFeeUsd: row.builder_fee_usd as number,
    closedPnl: nullable(row.closed_pnl),
    livePositionId: (row.live_position_id as string | null) ?? null,
    livePurpose: (row.live_purpose as string | null) ?? null,
    assumedFeeBps: nullable(row.assumed_fee_bps),
    catalogFeeBps: nullable(row.catalog_fee_bps),
    deployerFeeScale: nullable(row.deployer_fee_scale),
    growthMode: (row.growth_mode as string | null) ?? null,
    hlCrossRate: nullable(row.hl_cross_rate),
    hlReferralDiscount: nullable(row.hl_referral_discount),
    hlStakingDiscount: nullable(row.hl_staking_discount),
    hypePriceUsd: nullable(row.hype_price_usd),
    recordedAt: row.recorded_at as number,
  });
  const transaction = <T>(work: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = work(); db.exec('COMMIT'); return result; } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  };
  const durableTransaction = <T>(work: () => T): T => {
    if (db.isTransaction) return work();
    db.exec('PRAGMA synchronous=FULL');
    try {
      db.exec('BEGIN IMMEDIATE');
      try { const result = work(); db.exec('COMMIT'); return result; }
      catch (error) { if (db.isTransaction) try { db.exec('ROLLBACK'); } catch { /* ignore */ } throw error; }
    } finally {
      try { db.exec('PRAGMA synchronous=NORMAL'); } catch { /* ignore */ }
    }
  };
  /**
   * 逐条定位着读：从 from 起每次取新旧两表里时刻最早的一行（同一时刻以新表为准）交给 take，take 返回下一次从这行之后多久开始找（毫秒，至少 1），返回 null 就停。
   */
  const spaced = (symbol: string, from: number, to: number, seek: RangeStatement, oldSeek: RangeStatement, takeNew: (row: LegRow) => number | null, takeOld: (row: LegRow) => number | null): void => {
    const old = legacyKeyOf(symbol);
    for (let cursor = from; cursor <= to;) {
      const fresh = seek.get(symbol, cursor, to) as LegRow | undefined, older = old ? oldSeek.get(old, cursor, to) as LegRow | undefined : undefined;
      const useNew = fresh !== undefined && (older === undefined || Number(fresh.t) <= Number(older.t)), row = useNew ? fresh : older;
      if (!row) return;
      const step = useNew ? takeNew(row) : takeOld(row);
      if (step === null) return;
      cursor = Number(row.t) + Math.max(1, step);
    }
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
  const store = {
    file,
    /** 写入一批样本，已有同一时刻的忽略；返回新写入的条数。 */
    addSamples(samples: readonly Sample[]): number {
      return addNewSamples(samples).length;
    },
    addNewSamples,
    samples(symbol: string, from: number, to: number): Sample[] {
      return [...sampleRange(symbol, from, to)];
    },
    /**
     * 按间隔抽稀的样本（至多 limit 条）：[from, to] 里的第一条，之后每次取「上一条的时刻 + gapMs」以后的第一条，走主键逐条定位、不读中间的。
     * 结果与按时间顺序逐条看、离上一条取用的不足 gapMs 就跳过相同。要接着读就把 from 换成最后一条的时刻 + gapMs。
     */
    samplesSpaced(symbol: string, from: number, to: number, gapMs: number, limit = Infinity): Sample[] {
      const result: Sample[] = [];
      spaced(symbol, from, to, seekSample, oldSeekSample, row => { result.push(fromLegRow(row)); return result.length < limit ? gapMs : null; }, row => { result.push(fromOldRow(row as OldRow, symbol)); return result.length < limit ? gapMs : null; });
      return result;
    },
    /**
     * 预热基线用：[from, to] 里只带基线用到的列，按时刻升序逐条交给 each，返回这条有没有被采用。
     * gapMs 大于 0 时逐条定位着读：被采用的下一条从它的时刻 + gapMs 以后找，没被采用的从它之后紧接着找（与逐条全读的结果相同）。
     */
    baselineScan(symbol: string, from: number, to: number, gapMs: number, each: (point: BaselinePoint) => boolean): void {
      if (gapMs > 0) spaced(symbol, from, to, seekBaseline, oldSeekBaseline, row => each(baselineFromLeg(row)) ? gapMs : 1, row => each(baselineFromOld(row)) ? gapMs : 1);
      else for (const point of mergedRange(baselineRange, oldBaselineRange, symbol, from, to, baselineFromLeg, baselineFromOld)) each(point);
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
    addAccountSnapshot(row: AccountSnapshotRow): void {
      insertSnapshot.run(row.venue, row.accountHash, row.at, row.equity, row.collateral, row.available, row.unrealizedPnl, row.positions);
    },
    accountSnapshots(venue: string, accountHash: string, since: number): AccountSnapshotRow[] {
      return selectSnapshots.all(venue, accountHash, since) as unknown as AccountSnapshotRow[];
    },
    pruneAccountSnapshots(now: number): void { pruneSnapshots.run(now - ACCOUNT_SNAPSHOT_RETENTION_DAYS * 86_400_000); },
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
    saveLive(position: LivePosition): void { durableTransaction(() => { upsertLive.run(position.id, position.symbol, position.state, position.openedAt, position.closedAt, position.netUsd, JSON.stringify(position)); }); },
    saveLiveState(key: string, value: unknown, at: number): void { durableTransaction(() => { writeState.run(key, JSON.stringify(value), at); }); },
    saveLiveIntent(runtimeKey: string, runtimeValue: unknown, position: LivePosition, at: number): void {
      durableTransaction(() => { writeState.run(runtimeKey, JSON.stringify(runtimeValue), at); store.saveLive(position); });
    },
    liveActive(): LivePosition[] { return parse<LivePosition>(liveActive.all()); },
    liveClosed(limit: number): LivePosition[] { return parse<LivePosition>(liveClosed.all(limit)); },
    liveNetSince(since: number): number { return (liveNetSince.get(since) as { net: number }).net; },
    /** 实盘成交过的笔数（第一腿没成交、什么都没发生的不算）与净盈亏。 */
    liveTotals(): { trades: number; netUsd: number; wins: number } {
      const row = liveTotals.get() as { n: number; net: number; wins: number | null };
      return { trades: row.n, netUsd: row.net, wins: row.wins ?? 0 };
    },
    /** 最近 limit 笔有成交的已结束实盘持仓（新的在前）。没成交的多时要扫过它们，调用方缓存。 */
    liveTradedClosed(limit: number): LivePosition[] { return parse<LivePosition>(liveTradedClosed.all(limit)); },
    /** 全部已结束实盘持仓的分组汇总（扫全表、逐行解析 JSON；调用方启动后读一次，之后自己累加）。 */
    liveSummaryRows(): LiveSummaryRow[] {
      return (liveSummary.all() as { symbol: string; day: number; reason: string; traded: number | null; single: number | null; sent: number | null; n: number; net: number; wins: number | null }[])
        .map(row => ({ symbol: row.symbol, day: row.day, reason: row.reason, traded: row.traded === 1, singleLeg: row.single === 1, sent: row.sent === 1, count: row.n, netUsd: row.net, wins: row.wins ?? 0 }));
    },
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
    saveEntropyOrderLink(link: StoredEntropyOrderLink): void {
      const cloid = link.cloid.startsWith('0x') || link.cloid.startsWith('0X') ? link.cloid.toLowerCase() : link.cloid;
      upsertEntropyLink.run(cloid, link.accountHash, link.positionId, link.purpose, link.coin, link.assumedFeeBps, link.catalogFeeBps, link.deployerFeeScale, link.growthMode, link.at);
    },
    entropyOrderLink(cloid: string): StoredEntropyOrderLink | null {
      const key = cloid.startsWith('0x') || cloid.startsWith('0X') ? cloid.toLowerCase() : cloid;
      const row = selectEntropyLink.get(key) as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        cloid: row.cloid as string, accountHash: row.account_hash as string, positionId: row.position_id as string, purpose: row.purpose as string,
        coin: row.coin as string, assumedFeeBps: nullable(row.assumed_fee_bps), catalogFeeBps: nullable(row.catalog_fee_bps),
        deployerFeeScale: nullable(row.deployer_fee_scale), growthMode: (row.growth_mode as string | null) ?? null, at: row.at as number,
      };
    },
    upsertEntropyFills(fills: readonly StoredEntropyFill[]): number {
      if (!fills.length) return 0;
      return transaction(() => {
        let added = 0;
        for (const fill of fills) {
          const changed = Number(insertEntropyFill.run(
            fill.accountHash, fill.tid, fill.oid, fill.cloid, fill.time, fill.coin, fill.side, fill.dir, fill.crossed ? 1 : 0,
            fill.px, fill.sz, fill.notionalUsd, fill.feeUsd, fill.feeToken, fill.builderFeeUsd, fill.closedPnl,
            fill.livePositionId, fill.livePurpose, fill.assumedFeeBps, fill.catalogFeeBps, fill.deployerFeeScale, fill.growthMode,
            fill.hlCrossRate, fill.hlReferralDiscount, fill.hlStakingDiscount, fill.hypePriceUsd, fill.recordedAt,
          ).changes);
          added += changed;
          if (!changed && fill.hypePriceUsd !== null) backfillEntropyFillHype.run(fill.hypePriceUsd, fill.accountHash, fill.tid);
        }
        return added;
      });
    },
    entropyFills(accountHash: string, from: number, to: number, limit: number): StoredEntropyFill[] {
      return (selectEntropyFills.all(accountHash, from, to, limit) as Record<string, unknown>[]).map(mapEntropyFill);
    },
    entropyFillsAll(accountHash: string, from: number, to: number): StoredEntropyFill[] {
      return (selectEntropyFillsAll.all(accountHash, from, to) as Record<string, unknown>[]).map(mapEntropyFill);
    },
    addEntropyFeeSnapshot(snapshot: Omit<StoredEntropyFeeSnapshot, 'id'>): void {
      insertEntropySnapshot.run(snapshot.accountHash, snapshot.at, snapshot.userCrossRate, snapshot.userAddRate, snapshot.referralDiscount, snapshot.stakingDiscount, snapshot.hypePriceUsd, snapshot.assumedFeeBps);
    },
    latestEntropyFeeSnapshot(accountHash: string): StoredEntropyFeeSnapshot | null {
      const row = selectLatestEntropySnapshot.get(accountHash) as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        id: row.id as number, accountHash: row.account_hash as string, at: row.at as number,
        userCrossRate: nullable(row.user_cross_rate), userAddRate: nullable(row.user_add_rate),
        referralDiscount: nullable(row.referral_discount), stakingDiscount: nullable(row.staking_discount),
        hypePriceUsd: nullable(row.hype_price_usd), assumedFeeBps: nullable(row.assumed_fee_bps),
      };
    },
    pruneEntropyOrderLinks(now: number): number {
      return Number(pruneEntropyLinks.run(now - 90 * 86_400_000).changes);
    },
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
  return store;
}
