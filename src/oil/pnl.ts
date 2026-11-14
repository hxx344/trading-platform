// Oil PnL, funding and realized ledgers (docs/oil.md section 9). Read only: nothing here sends an order or feeds a preview.
// - Every minute the configured accounts' oil positions are read with entry price, mark price and unrealized PnL; when every
//   account answered close together, the sum is stored as one sample (kept 92 days).
// - Every five minutes each account's ledger of BZUSDT and CLUSDT (funding, closing PnL, fees) is read forward from where the
//   last read ended (the first read looks back 30 days, every read covers the last 10 minutes again) into oil-pnl.sqlite.
// - A read adds them up as the workbench does (PR #345): total = unrealized + funding + realized + fees, each ledger summed from
//   the range start to the sample's own position read time per account, so a fill between two reads is never counted both as
//   closing PnL and as unrealized PnL. A sample later than the ledger's coverage has no total.
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { OIL_SYMBOLS, VENUE_NAMES, accountKey, type AccountBinding, type Venue } from '../contracts.ts';
import type { LedgerEntry, LedgerKind, PnlPosition, VenueConnector } from '../connector.ts';
import { decimal, fromUnits, units } from '../decimal.ts';
import { bounded } from './market.ts';

export const OIL_PNL_DATABASE = 'oil-pnl.sqlite';
const SCHEMA_VERSION = 1;
const DAY = 86_400_000;
/** Position reads: one round a minute, each account's read bounded by its own timeout, never retried within a round. */
export const PNL_SAMPLE_MS = 60_000;
export const PNL_TIMEOUT_MS = 10_000;
/** Ledger reads: one round every five minutes; one window of one symbol is bounded by its own timeout. */
export const LEDGER_SYNC_MS = 5 * 60_000;
export const LEDGER_TIMEOUT_MS = 30_000;
export const LEDGER_LOOKBACK_MS = 30 * DAY;
/** Each read starts this far before the last one ended, so a row the venue books late is still picked up. */
export const LEDGER_REREAD_MS = 10 * 60_000;
const LEDGER_WINDOW_MS = 7 * DAY;
export const SAMPLE_RETENTION_MS = 92 * DAY;
/** Accounts read further apart than this, or a read older than MAX_AGE at sample time, give no sample. */
const MAX_SKEW_MS = 45_000;
const MAX_AGE_MS = 75_000;
/** Samples further apart than this are not joined by a line. */
const GAP_MS = PNL_SAMPLE_MS * 2.5;
const MAX_POINTS = 1200;
export const PNL_PAGE_SIZE = 50;
export const PNL_RANGES = { '1d': DAY, '7d': 7 * DAY, '30d': 30 * DAY, '90d': 90 * DAY } as const;
export type PnlRange = keyof typeof PNL_RANGES;
const KINDS: readonly LedgerKind[] = ['funding', 'realized', 'fee'];

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);
const maskId = (id: string): string => id.length > 4 ? `***${id.slice(-4)}` : '***';

function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  try {
    const mode = (db.prepare('PRAGMA journal_mode=WAL').get() as { journal_mode: string }).journal_mode;
    if (mode !== 'wal') throw new Error(`未能进入 WAL 模式：${mode}`);
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > SCHEMA_VERSION) throw new Error(`库版本 ${version} 比本版本能读的 ${SCHEMA_VERSION} 新`);
    db.exec(`PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS ledger (account TEXT NOT NULL, id TEXT NOT NULL, time INTEGER NOT NULL, symbol TEXT NOT NULL, kind TEXT NOT NULL, amount TEXT NOT NULL, PRIMARY KEY (account, id));
      CREATE INDEX IF NOT EXISTS ledger_time ON ledger (account, time);
      CREATE TABLE IF NOT EXISTS ledger_sync (account TEXT NOT NULL, symbol TEXT NOT NULL, start INTEGER NOT NULL, covered_until INTEGER NOT NULL, synced_at INTEGER, failed_at INTEGER, error TEXT, PRIMARY KEY (account, symbol));
      CREATE TABLE IF NOT EXISTS samples (accounts TEXT NOT NULL, time INTEGER NOT NULL, cutoffs TEXT NOT NULL, unrealized TEXT NOT NULL, PRIMARY KEY (accounts, time));`);
    const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(column => column.name).join(',');
    const expected: Record<string, string> = {
      ledger: 'account,id,time,symbol,kind,amount', ledger_sync: 'account,symbol,start,covered_until,synced_at,failed_at,error', samples: 'accounts,time,cutoffs,unrealized',
    };
    for (const [table, want] of Object.entries(expected)) if (columns(table) !== want) throw new Error(`${table} 表结构不符：${columns(table)}`);
    db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
  } catch (error) { db.close(); throw error; }
  return db;
}

interface PositionsSlot { rows: PnlPosition[] | null; receivedAt: number | null; failedAt: number | null; error: string | null }
interface SyncRow { start: number; covered_until: number; synced_at: number | null; failed_at: number | null; error: string | null }
interface Point { time: number; unrealizedPnl: bigint | null; fundingPnl: bigint | null; realizedPnl: bigint | null; feePnl: bigint | null; totalPnl: bigint | null }
const POINT_KEYS = ['unrealizedPnl', 'fundingPnl', 'realizedPnl', 'feePnl', 'totalPnl'] as const;

/** A position row as a connector gave it, checked before it is summed or shown. */
function checkedPosition(row: PnlPosition): PnlPosition {
  if (!(OIL_SYMBOLS as readonly string[]).includes(row.symbol) || (row.side !== 'long' && row.side !== 'short')) throw new Error('盈亏持仓的合约或方向无效');
  return { symbol: row.symbol, side: row.side, quantity: decimal(row.quantity, 'nonnegative'), entryPrice: row.entryPrice === null ? null : decimal(row.entryPrice, 'nonnegative'),
    markPrice: row.markPrice === null ? null : decimal(row.markPrice, 'nonnegative'), unrealizedPnl: decimal(row.unrealizedPnl) };
}
function checkedEntry(entry: LedgerEntry, symbol: string, from: number, to: number): LedgerEntry {
  if (entry.symbol !== symbol || !KINDS.includes(entry.kind) || typeof entry.id !== 'string' || !entry.id || entry.id.length > 200
    || !Number.isSafeInteger(entry.time) || entry.time < from || entry.time > to) throw new Error('账单记录的合约、类型、编号或时间无效');
  return { id: entry.id, time: entry.time, symbol, kind: entry.kind, amount: decimal(entry.amount) };
}

/**
 * Keeps each continuous run's first, last, lowest and highest total and unrealized values per bucket, so a long range
 * still shows its peaks and troughs; every gap boundary is kept (copied from the workbench trading-pnl reducePoints).
 */
function reducePoints(points: Point[]): Point[] {
  if (points.length <= MAX_POINTS) return points;
  const width = Math.ceil(points.length / 180), result: Point[] = [];
  const mask = (point: Point) => POINT_KEYS.reduce((bits, key, index) => bits | (point[key] === null ? 1 << index : 0), 0);
  for (let offset = 0; offset < points.length;) {
    let end = offset + 1;
    while (end < points.length && end - offset < width && mask(points[end]!) === mask(points[offset]!)) end++;
    const bucket = points.slice(offset, end);
    offset = end;
    const selected = new Set([0, bucket.length - 1]);
    for (const key of ['unrealizedPnl', 'totalPnl'] as const) {
      if (bucket[0]![key] === null) continue;
      let low = 0, high = 0;
      for (let i = 1; i < bucket.length; i++) {
        if (bucket[i]![key]! < bucket[low]![key]!) low = i;
        if (bucket[i]![key]! > bucket[high]![key]!) high = i;
      }
      selected.add(low); selected.add(high);
    }
    for (const index of [...selected].sort((a, b) => a - b)) result.push(bucket[index]!);
  }
  return result;
}
const formatPoint = (point: Point) => ({ time: point.time, ...Object.fromEntries(POINT_KEYS.map(key => [key, point[key] === null ? null : fromUnits(point[key])])) });

export interface OilPnlOptions {
  file: string;
  connectors: readonly VenueConnector[];
  accounts: readonly AccountBinding[];
  now?: () => number;
  pnlTimeoutMs?: number;
  ledgerTimeoutMs?: number;
}

export function createOilPnl({ file, connectors, accounts, now = Date.now, pnlTimeoutMs = PNL_TIMEOUT_MS, ledgerTimeoutMs = LEDGER_TIMEOUT_MS }: OilPnlOptions) {
  const db = openDatabase(file);
  const keys = accounts.map(accountKey);
  /** Samples belong to one set of accounts; another set (an account added, removed or replaced) starts its own curve. */
  const setKey = JSON.stringify([...keys].sort());
  const connectorOf = (venue: Venue) => connectors.find(item => item.venue === venue);
  const slots = accounts.map((): PositionsSlot => ({ rows: null, receivedAt: null, failedAt: null, error: null }));
  let sampledAt: number | null = null, syncing = false;
  let version = 0;
  const cache = new Map<string, { version: number; result: unknown }>();
  const statements = new Map<string, StatementSync>();
  const sql = (text: string): StatementSync => { let found = statements.get(text); if (!found) { found = db.prepare(text); statements.set(text, found); } return found; };

  /** One round of position reads; stores a sample when every account answered within MAX_SKEW of the others. */
  async function sample(): Promise<void> {
    const results = await Promise.all(accounts.map(async (account, index) => {
      const slot = slots[index]!, connector = connectorOf(account.venue);
      try {
        if (!connector?.pnlPositions) throw new Error(`${VENUE_NAMES[account.venue]} 连接器不支持盈亏读取`);
        const snapshot = await bounded(signal => connector.pnlPositions!(account, OIL_SYMBOLS, { signal }), pnlTimeoutMs);
        if (snapshot.venue !== account.venue || snapshot.accountId !== account.accountId) throw new Error(`${VENUE_NAMES[account.venue]} 账户真实身份与配置不一致`);
        if (!Number.isSafeInteger(snapshot.receivedAt) || snapshot.receivedAt <= 0) throw new Error('盈亏持仓读取时刻无效');
        const rows = snapshot.positions.map(checkedPosition);
        Object.assign(slot, { rows, receivedAt: snapshot.receivedAt, error: null });
        return { receivedAt: snapshot.receivedAt, unrealized: rows.reduce((sum, row) => sum + units(row.unrealizedPnl), 0n) };
      } catch (error) { Object.assign(slot, { failedAt: now(), error: message(error) }); return null; }
    }));
    sampledAt = now();
    if (results.some(result => result === null) || !results.length) return;
    const times = results.map(result => result!.receivedAt), time = Math.max(...times), current = now();
    if (time - Math.min(...times) > MAX_SKEW_MS || times.some(at => at > current + 1_000 || current - at > MAX_AGE_MS)) return;
    const last = sql('SELECT MAX(time) AS time FROM samples WHERE accounts=?').get(setKey) as { time: number | null };
    if (last.time !== null && time <= last.time) return;
    sql('INSERT INTO samples (accounts, time, cutoffs, unrealized) VALUES (?, ?, ?, ?)').run(setKey, time, JSON.stringify(times), fromUnits(results.reduce((sum, result) => sum + result!.unrealized, 0n)));
    sql('DELETE FROM samples WHERE time < ?').run(current - SAMPLE_RETENTION_MS);
    version++;
  }

  /**
   * One round of ledger reads, account by account and symbol by symbol, each forward from where its last read ended. A
   * window that fails stops that symbol for this round (its coverage stays where it was) and the next symbol goes on.
   */
  async function syncLedgers(stopped: () => boolean = () => false): Promise<void> {
    if (syncing) return;
    syncing = true;
    try {
      for (const account of accounts) for (const symbol of OIL_SYMBOLS) {
        if (stopped()) return;
        const key = accountKey(account), connector = connectorOf(account.venue), started = now();
        let state = sql('SELECT start, covered_until, synced_at, failed_at, error FROM ledger_sync WHERE account=? AND symbol=?').get(key, symbol) as SyncRow | undefined;
        if (!state) {
          sql('INSERT INTO ledger_sync (account, symbol, start, covered_until) VALUES (?, ?, ?, ?)').run(key, symbol, started - LEDGER_LOOKBACK_MS, started - LEDGER_LOOKBACK_MS);
          state = { start: started - LEDGER_LOOKBACK_MS, covered_until: started - LEDGER_LOOKBACK_MS, synced_at: null, failed_at: null, error: null };
        }
        try {
          if (!connector?.ledger) throw new Error(`${VENUE_NAMES[account.venue]} 连接器不支持账单读取`);
          for (let from = Math.max(state.start, state.covered_until - LEDGER_REREAD_MS); from < started && !stopped();) {
            const to = Math.min(started, from + LEDGER_WINDOW_MS);
            const entries = (await bounded(signal => connector.ledger!(account, symbol, { from, to }, { signal }), ledgerTimeoutMs)).map(entry => checkedEntry(entry, symbol, from, to));
            store(key, entries, symbol, to);
            from = to;
          }
        } catch (error) {
          sql('UPDATE ledger_sync SET failed_at=?, error=? WHERE account=? AND symbol=?').run(now(), message(error), key, symbol);
          version++;
        }
      }
    } finally { syncing = false; }
  }
  /** One window's rows and the coverage they prove, in one transaction. A stored row read again must be the same row. */
  function store(key: string, entries: LedgerEntry[], symbol: string, to: number): void {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const entry of entries) {
        const stored = sql('SELECT time, symbol, kind, amount FROM ledger WHERE account=? AND id=?').get(key, entry.id) as { time: number; symbol: string; kind: string; amount: string } | undefined;
        if (!stored) sql('INSERT INTO ledger (account, id, time, symbol, kind, amount) VALUES (?, ?, ?, ?, ?, ?)').run(key, entry.id, entry.time, entry.symbol, entry.kind, entry.amount);
        else if (stored.time !== entry.time || stored.symbol !== entry.symbol || stored.kind !== entry.kind || units(stored.amount) !== units(entry.amount)) throw new Error('交易所账单与已保存的同一编号记录不一致，未写入；请核对交易所账单');
      }
      sql('UPDATE ledger_sync SET covered_until=MAX(covered_until, ?), synced_at=?, failed_at=NULL, error=NULL WHERE account=? AND symbol=?').run(to, now(), key, symbol);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    version++;
  }

  function syncState(key: string) {
    const rows = OIL_SYMBOLS.map(symbol => sql('SELECT start, covered_until, synced_at, failed_at, error FROM ledger_sync WHERE account=? AND symbol=?').get(key, symbol) as SyncRow | undefined);
    if (rows.some(row => !row)) return { ready: false as const, start: null, coveredUntil: null, syncedAt: null, failedAt: rows.find(row => row?.failed_at)?.failed_at ?? null, error: rows.find(row => row?.error)?.error ?? null };
    const known = rows as SyncRow[];
    const latest = (values: (number | null)[]) => values.every(value => value === null) ? null : Math.max(...values.filter((value): value is number => value !== null));
    return {
      ready: true as const, start: Math.max(...known.map(row => row.start)), coveredUntil: Math.min(...known.map(row => row.covered_until)),
      syncedAt: known.some(row => row.synced_at === null) ? null : Math.min(...known.map(row => row.synced_at as number)),
      failedAt: latest(known.map(row => row.failed_at)), error: known.find(row => row.error)?.error ?? null,
    };
  }

  /** The curve: one point per stored sample in [start, current], each with the ledgers summed up to that sample's read times. */
  function curve(start: number, current: number, sync: ReturnType<typeof syncState>[]) {
    const samples = sql('SELECT time, cutoffs, unrealized FROM samples WHERE accounts=? AND time>=? AND time<=? ORDER BY time').all(setKey, start, current) as { time: number; cutoffs: string; unrealized: string }[];
    const ledgers = keys.map(key => sql('SELECT time, kind, amount FROM ledger WHERE account=? AND time>=? AND time<=? ORDER BY time').all(key, start, current) as { time: number; kind: LedgerKind; amount: string }[]);
    const ready = sync.every(state => state.ready && state.start <= start);
    const index = keys.map(() => 0), sums: Record<LedgerKind, bigint> = { funding: 0n, realized: 0n, fee: 0n };
    const points: Point[] = [];
    for (const row of samples) {
      const previous = points.at(-1);
      if (previous && row.time - previous.time > GAP_MS) points.push({ time: previous.time + PNL_SAMPLE_MS, unrealizedPnl: null, fundingPnl: null, realizedPnl: null, feePnl: null, totalPnl: null });
      let cutoffs: number[];
      try { cutoffs = JSON.parse(row.cutoffs) as number[]; } catch { cutoffs = []; }
      let known = ready && cutoffs.length === keys.length;
      for (const [account, rows] of ledgers.entries()) {
        const cutoff = cutoffs[account] ?? row.time;
        while (index[account]! < rows.length && rows[index[account]!]!.time < cutoff) { const entry = rows[index[account]!++]!; sums[entry.kind] += units(entry.amount); }
        if (!sync[account]!.ready || cutoff > (sync[account]!.coveredUntil ?? -Infinity)) known = false;
      }
      const unrealizedPnl = units(row.unrealized);
      points.push({ time: row.time, unrealizedPnl, fundingPnl: known ? sums.funding : null, realizedPnl: known ? sums.realized : null, feePnl: known ? sums.fee : null,
        totalPnl: known ? unrealizedPnl + sums.funding + sums.realized + sums.fee : null });
    }
    if (points.length && current - points.at(-1)!.time > GAP_MS) points.push({ time: current, unrealizedPnl: null, fundingPnl: null, realizedPnl: null, feePnl: null, totalPnl: null });
    return { count: samples.length, points };
  }

  /**
   * The page's read. range picks the curve's start (never earlier than the ledgers' own start, so every total is summed
   * from one start); page pages the range's ledger rows, newest first. Rebuilt only when a sample, a ledger or the minute changes.
   */
  function read({ range = '7d', page = 0 }: { range?: PnlRange; page?: number } = {}) {
    const current = now(), minute = Math.floor(current / PNL_SAMPLE_MS);
    const cacheKey = `${range}:${page}:${minute}`, cached = cache.get(cacheKey);
    if (cached?.version === version) return cached.result;
    const sync = keys.map(syncState);
    const ledgerStart = sync.every(state => state.ready) ? Math.max(...sync.map(state => state.start as number)) : null;
    const requestedStart = current - PNL_RANGES[range], start = ledgerStart === null ? requestedStart : Math.max(requestedStart, ledgerStart);
    const { count, points } = curve(start, current, sync);
    const latest = points.at(-1) ?? null;
    const first = sql('SELECT MIN(time) AS time FROM samples WHERE accounts=?').get(setKey) as { time: number | null };
    // Range totals from the stored rows (each account's up to its own coverage), per account and symbol.
    const totals = keys.map(key => sql('SELECT symbol, kind, amount FROM ledger WHERE account=? AND time>=? AND time<=?').all(key, start, current) as { symbol: string; kind: LedgerKind; amount: string }[]);
    const sum = (rows: { kind: LedgerKind; amount: string }[], kind: LedgerKind) => fromUnits(rows.filter(row => row.kind === kind).reduce((total, row) => total + units(row.amount), 0n));
    const all = totals.flat();
    const total = sql(`SELECT COUNT(*) AS count FROM ledger WHERE account IN (${keys.map(() => '?').join(',')}) AND time>=? AND time<=?`).get(...keys, start, current) as { count: number };
    const pages = Math.max(1, Math.ceil(total.count / PNL_PAGE_SIZE)), shown = Math.min(Math.max(0, page), pages - 1);
    const rows = sql(`SELECT account, id, time, symbol, kind, amount FROM ledger WHERE account IN (${keys.map(() => '?').join(',')}) AND time>=? AND time<=? ORDER BY time DESC, account, id LIMIT ? OFFSET ?`)
      .all(...keys, start, current, PNL_PAGE_SIZE, shown * PNL_PAGE_SIZE) as { account: string; id: string; time: number; symbol: string; kind: LedgerKind; amount: string }[];
    const venueOf = (key: string) => accounts[keys.indexOf(key)]?.venue ?? null;
    const result = {
      currency: 'USDT', range, ranges: Object.keys(PNL_RANGES), now: current, requestedStart, start, intervalMs: PNL_SAMPLE_MS, sampledAt,
      status: count === 0 ? 'collecting' : latest?.totalPnl === null ? 'incomplete' : 'ready',
      recordingStartedAt: first.time, pointCount: count, points: reducePoints(points).map(formatPoint), latest: latest ? formatPoint(latest) : null,
      totals: ledgerStart === null ? null : { funding: sum(all, 'funding'), realized: sum(all, 'realized'), fee: sum(all, 'fee') },
      accounts: accounts.map((account, index) => {
        const slot = slots[index]!, state = sync[index]!;
        return {
          venue: account.venue, accountId: maskId(account.accountId), accountMode: account.accountMode,
          positions: { ...slot }, ledger: { start: state.start, coveredUntil: state.coveredUntil, syncedAt: state.syncedAt, failedAt: state.failedAt, error: state.error },
          symbols: OIL_SYMBOLS.map(symbol => {
            const mine = totals[index]!.filter(row => row.symbol === symbol);
            return { symbol, funding: sum(mine, 'funding'), realized: sum(mine, 'realized'), fee: sum(mine, 'fee'),
              unrealized: slot.rows ? fromUnits(slot.rows.filter(row => row.symbol === symbol).reduce((total, row) => total + units(row.unrealizedPnl), 0n)) : null };
          }),
        };
      }),
      entries: { page: shown, pages, total: total.count, pageSize: PNL_PAGE_SIZE, rows: rows.map(row => ({ venue: venueOf(row.account), id: row.id, time: row.time, symbol: row.symbol, kind: row.kind, amount: row.amount })) },
    };
    cache.clear();
    cache.set(cacheKey, { version, result });
    return result;
  }

  return { sample, syncLedgers, read, close: () => db.close() };
}
export type OilPnl = ReturnType<typeof createOilPnl>;
