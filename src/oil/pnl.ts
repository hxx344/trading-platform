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
      CREATE TABLE IF NOT EXISTS samples (accounts TEXT NOT NULL, time INTEGER NOT NULL, cutoffs TEXT NOT NULL, unrealized TEXT NOT NULL, PRIMARY KEY (accounts, time));
      CREATE INDEX IF NOT EXISTS samples_time ON samples (time);`);
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
 * A curve before its values are worked out, in flat arrays (a 90-day range has ~130k points): per slot its time, its
 * sample's index in the series (-1 for a break in the line), its null pattern (0 full, 1 no total, 2 break) and
 * approximate unrealized and total values to pick by.
 */
interface Slots { length: number; time: Float64Array; index: Int32Array; mask: Uint8Array; unrealized: Float64Array; total: Float64Array }
/**
 * Keeps each continuous run's first, last, lowest and highest total and unrealized values per bucket, so a long range
 * still shows its peaks and troughs; every gap boundary is kept (the workbench trading-pnl reducePoints, on slots).
 * Returns the kept slot numbers in order.
 */
function reduceSlots(slots: Slots): number[] {
  const { length, mask, unrealized, total } = slots;
  if (length <= MAX_POINTS) return Array.from({ length }, (_, slot) => slot);
  const width = Math.ceil(length / 180), result: number[] = [];
  for (let offset = 0; offset < length;) {
    let end = offset + 1;
    while (end < length && end - offset < width && mask[end] === mask[offset]) end++;
    const selected = [offset, end - 1];
    if (mask[offset] !== 2) {
      // A bucket has one null pattern: unrealized is known in every slot of it, the total in all or none.
      const withTotal = mask[offset] === 0;
      let lowU = offset, highU = offset, lowT = offset, highT = offset;
      for (let i = offset + 1; i < end; i++) {
        if (unrealized[i]! < unrealized[lowU]!) lowU = i;
        if (unrealized[i]! > unrealized[highU]!) highU = i;
        if (withTotal && total[i]! < total[lowT]!) lowT = i;
        if (withTotal && total[i]! > total[highT]!) highT = i;
      }
      selected.push(lowU, highU);
      if (withTotal) selected.push(lowT, highT);
    }
    for (const slot of [...new Set(selected)].sort((x, y) => x - y)) result.push(slot);
    offset = end;
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
  /** Bumped on every change a read shows (a sample, a position read, ledger rows or coverage); the read cache keys on it. */
  let version = 0;
  const cache = new Map<string, { version: number; minute: number; result: unknown }>();
  const statements = new Map<string, StatementSync>();
  const sql = (text: string): StatementSync => { let found = statements.get(text); if (!found) { found = db.prepare(text); statements.set(text, found); } return found; };

  // ---- in-memory curve (review P2-1): a read must not parse and re-add every stored sample on the event loop ----
  // Each account's ledger as sorted times with running sums per kind (cum[k][j] = sum of its first j rows), rebuilt only when
  // rows are inserted. Each sample keeps its per-account read times and the ledgers summed from the beginning up to them
  // (abs); a range's value is abs minus the same sums up to the range start, so a new sample costs one point, not a rebuild.
  type Prefix = { times: number[]; cum: Record<LedgerKind, bigint[]> };
  let prefixes: Prefix[] | null = null;
  const series = { times: [] as number[], cutoffs: [] as number[][], unrealized: [] as bigint[], abs: { funding: [] as bigint[], realized: [] as bigint[], fee: [] as bigint[] },
    /** Number copies for picking points on a long range only; shown values are always the exact sums. */
    approxUnrealized: [] as number[], approxTotal: [] as number[] };
  const approx = (value: bigint) => Number(value) / 1e18;
  let seriesLoaded = false;
  /** The number of values in a sorted array below x (strictly). */
  const below = (values: readonly number[], x: number) => { let lo = 0, hi = values.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (values[mid]! < x) lo = mid + 1; else hi = mid; } return lo; };
  const atMost = (values: readonly number[], x: number) => { let lo = 0, hi = values.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (values[mid]! <= x) lo = mid + 1; else hi = mid; } return lo; };
  function ledgerPrefixes(): Prefix[] {
    if (prefixes) return prefixes;
    prefixes = keys.map(key => {
      const rows = sql('SELECT time, kind, amount FROM ledger WHERE account=? ORDER BY time').all(key) as { time: number; kind: LedgerKind; amount: string }[];
      const prefix: Prefix = { times: rows.map(row => row.time), cum: { funding: [0n], realized: [0n], fee: [0n] } };
      for (const row of rows) for (const kind of KINDS) prefix.cum[kind].push(prefix.cum[kind].at(-1)! + (row.kind === kind ? units(row.amount) : 0n));
      return prefix;
    });
    return prefixes;
  }
  /** Ledger sums per kind over all accounts, each account's rows before its own time. */
  const sumsBefore = (times: readonly number[]): Record<LedgerKind, bigint> => {
    const result = { funding: 0n, realized: 0n, fee: 0n }, all = ledgerPrefixes();
    for (const [account, prefix] of all.entries()) {
      const count = below(prefix.times, times[account] ?? -Infinity);
      for (const kind of KINDS) result[kind] += prefix.cum[kind][count]!;
    }
    return result;
  };
  const setAbs = (index: number) => {
    const sums = sumsBefore(series.cutoffs[index]!);
    for (const kind of KINDS) series.abs[kind][index] = sums[kind];
    series.approxUnrealized[index] = approx(series.unrealized[index]!);
    series.approxTotal[index] = approx(series.unrealized[index]! + sums.funding + sums.realized + sums.fee);
  };
  function loadSeries(): void {
    if (seriesLoaded) return;
    const rows = sql('SELECT time, cutoffs, unrealized FROM samples WHERE accounts=? ORDER BY time').all(setKey) as { time: number; cutoffs: string; unrealized: string }[];
    for (const row of rows) {
      let stored: Record<string, unknown> = {};
      try { const parsed = JSON.parse(row.cutoffs) as unknown; if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed as Record<string, unknown>; } catch { /* unreadable: no total */ }
      series.times.push(row.time); series.unrealized.push(units(row.unrealized));
      // A read time that is missing makes the point unknown (NaN fails every coverage check below).
      series.cutoffs.push(keys.map(key => typeof stored[key] === 'number' ? stored[key] as number : NaN));
    }
    for (let index = 0; index < series.times.length; index++) setAbs(index);
    seriesLoaded = true;
  }
  function ledgerChanged(): void {
    prefixes = null;
    if (seriesLoaded) for (let index = 0; index < series.times.length; index++) setAbs(index);
  }
  function prune(before: number): void {
    const count = below(series.times, before);
    if (!count) return;
    series.times.splice(0, count); series.cutoffs.splice(0, count); series.unrealized.splice(0, count);
    for (const kind of KINDS) series.abs[kind].splice(0, count);
    series.approxUnrealized.splice(0, count); series.approxTotal.splice(0, count);
  }

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
      } catch (error) {
        // A failed read shows no positions (not the last ones beside the failure); its last read time stays.
        Object.assign(slot, { rows: null, failedAt: now(), error: message(error) });
        return null;
      }
    }));
    sampledAt = now();
    version++;
    if (results.some(result => result === null) || !results.length) return;
    const times = results.map(result => result!.receivedAt), time = Math.max(...times), current = now();
    if (time - Math.min(...times) > MAX_SKEW_MS || times.some(at => at > current + 1_000 || current - at > MAX_AGE_MS)) return;
    loadSeries();
    const last = series.times.at(-1) ?? (sql('SELECT MAX(time) AS time FROM samples WHERE accounts=?').get(setKey) as { time: number | null }).time;
    if (last !== null && time <= last) return;
    const unrealized = results.reduce((sum, result) => sum + result!.unrealized, 0n);
    // Read times by account key, so reordering the configured accounts keeps each read time with its account.
    sql('INSERT INTO samples (accounts, time, cutoffs, unrealized) VALUES (?, ?, ?, ?)').run(setKey, time, JSON.stringify(Object.fromEntries(keys.map((key, index) => [key, times[index]]))), fromUnits(unrealized));
    sql('DELETE FROM samples WHERE time < ?').run(current - SAMPLE_RETENTION_MS);
    series.times.push(time); series.cutoffs.push(times); series.unrealized.push(unrealized);
    setAbs(series.times.length - 1);
    prune(current - SAMPLE_RETENTION_MS);
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
    let inserted = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const entry of entries) {
        const stored = sql('SELECT time, symbol, kind, amount FROM ledger WHERE account=? AND id=?').get(key, entry.id) as { time: number; symbol: string; kind: string; amount: string } | undefined;
        if (!stored) { sql('INSERT INTO ledger (account, id, time, symbol, kind, amount) VALUES (?, ?, ?, ?, ?, ?)').run(key, entry.id, entry.time, entry.symbol, entry.kind, entry.amount); inserted++; }
        else if (stored.time !== entry.time || stored.symbol !== entry.symbol || stored.kind !== entry.kind || units(stored.amount) !== units(entry.amount)) throw new Error('交易所账单与已保存的同一编号记录不一致，未写入；请核对交易所账单');
      }
      sql('UPDATE ledger_sync SET covered_until=MAX(covered_until, ?), synced_at=?, failed_at=NULL, error=NULL WHERE account=? AND symbol=?').run(to, now(), key, symbol);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    if (inserted) ledgerChanged();
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

  /**
   * The curve: one point per sample in [start, current], each with each account's ledger summed from start up to (not
   * including) that account's own read time; a point whose read time is past an account's ledger coverage has no total.
   * Long ranges are thinned on approximate values (each bucket keeps its ends, lows and highs) and only the kept points
   * are summed exactly, so a 90-day read does not do bigint sums for every minute.
   */
  function curve(start: number, current: number, sync: ReturnType<typeof syncState>[]) {
    loadSeries();
    const lo = below(series.times, start), hi = atMost(series.times, current);
    const ready = sync.every(state => state.ready && state.start <= start);
    const coverage = sync.map(state => state.coveredUntil ?? -Infinity);
    const offset = sumsBefore(keys.map(() => start));
    // A read time before the range start (a sample within MAX_SKEW of it) sums nothing for that account.
    const edge = (index: number) => { const cutoffs = series.cutoffs[index]!; for (let account = 0; account < cutoffs.length; account++) if (cutoffs[account]! < start) return true; return false; };
    const covered = (index: number) => { const cutoffs = series.cutoffs[index]!; for (let account = 0; account < cutoffs.length; account++) if (!(cutoffs[account]! <= coverage[account]!)) return false; return true; };
    const sumsAt = (index: number) => edge(index) ? sumsBefore(series.cutoffs[index]!.map(cutoff => Math.max(cutoff, start))) : { funding: series.abs.funding[index]!, realized: series.abs.realized[index]!, fee: series.abs.fee[index]! };
    // At most one break before each sample plus one at the end.
    const size = 2 * (hi - lo) + 1;
    const slots: Slots = { length: 0, time: new Float64Array(size), index: new Int32Array(size), mask: new Uint8Array(size), unrealized: new Float64Array(size), total: new Float64Array(size) };
    const push = (time: number, index: number, mask: number, unrealized: number, total: number) => {
      const slot = slots.length++;
      slots.time[slot] = time; slots.index[slot] = index; slots.mask[slot] = mask; slots.unrealized[slot] = unrealized; slots.total[slot] = total;
    };
    for (let index = lo; index < hi; index++) {
      const time = series.times[index]!;
      if (slots.length && time - slots.time[slots.length - 1]! > GAP_MS) push(slots.time[slots.length - 1]! + PNL_SAMPLE_MS, -1, 2, NaN, NaN);
      if (!(ready && covered(index))) { push(time, index, 1, series.approxUnrealized[index]!, NaN); continue; }
      let total = series.approxTotal[index]!;
      if (edge(index)) { const sums = sumsAt(index); total = approx(series.unrealized[index]! + sums.funding + sums.realized + sums.fee); }
      push(time, index, 0, series.approxUnrealized[index]!, total);
    }
    if (slots.length && current - slots.time[slots.length - 1]! > GAP_MS) push(current, -1, 2, NaN, NaN);
    const point = (slot: number): Point => {
      const time = slots.time[slot]!, index = slots.index[slot]!;
      if (index < 0) return { time, unrealizedPnl: null, fundingPnl: null, realizedPnl: null, feePnl: null, totalPnl: null };
      const unrealizedPnl = series.unrealized[index]!;
      if (slots.mask[slot] !== 0) return { time, unrealizedPnl, fundingPnl: null, realizedPnl: null, feePnl: null, totalPnl: null };
      const sums = sumsAt(index), funding = sums.funding - offset.funding, realized = sums.realized - offset.realized, fee = sums.fee - offset.fee;
      return { time, unrealizedPnl, fundingPnl: funding, realizedPnl: realized, feePnl: fee, totalPnl: unrealizedPnl + funding + realized + fee };
    };
    return { count: hi - lo, points: reduceSlots(slots).map(point), latest: slots.length ? point(slots.length - 1) : null };
  }

  /**
   * The page's read. range picks the curve's start (never earlier than the ledgers' own start, so every total is summed
   * from one start); page pages the range's ledger rows, newest first. Each range and page keeps its own answer until a
   * sample, a position read, the ledgers or the minute change.
   */
  function read({ range = '7d', page = 0 }: { range?: PnlRange; page?: number } = {}) {
    const current = now(), minute = Math.floor(current / PNL_SAMPLE_MS);
    const cacheKey = `${range}:${page}`, cached = cache.get(cacheKey);
    if (cached && cached.version === version && cached.minute === minute) return cached.result;
    const sync = keys.map(syncState);
    const ledgerStart = sync.every(state => state.ready) ? Math.max(...sync.map(state => state.start as number)) : null;
    const requestedStart = current - PNL_RANGES[range], start = ledgerStart === null ? requestedStart : Math.max(requestedStart, ledgerStart);
    const { count, points, latest } = curve(start, current, sync);
    // Range totals from the stored rows, per account and symbol.
    const totals = keys.map(key => sql('SELECT symbol, kind, amount FROM ledger WHERE account=? AND time>=? AND time<=?').all(key, start, current) as { symbol: string; kind: LedgerKind; amount: string }[]);
    // One pass: sums by kind over everything and by account, symbol and kind.
    const sums = new Map<string, bigint>(), addTo = (key: string, value: bigint) => sums.set(key, (sums.get(key) ?? 0n) + value);
    totals.forEach((rows, index) => { for (const row of rows) { const value = units(row.amount); addTo(row.kind, value); addTo(`${index}:${row.symbol}:${row.kind}`, value); } });
    const sum = (key: string) => fromUnits(sums.get(key) ?? 0n);
    const total = sql(`SELECT COUNT(*) AS count FROM ledger WHERE account IN (${keys.map(() => '?').join(',')}) AND time>=? AND time<=?`).get(...keys, start, current) as { count: number };
    const pages = Math.max(1, Math.ceil(total.count / PNL_PAGE_SIZE)), shown = Math.min(Math.max(0, page), pages - 1);
    const rows = sql(`SELECT account, id, time, symbol, kind, amount FROM ledger WHERE account IN (${keys.map(() => '?').join(',')}) AND time>=? AND time<=? ORDER BY time DESC, account, id LIMIT ? OFFSET ?`)
      .all(...keys, start, current, PNL_PAGE_SIZE, shown * PNL_PAGE_SIZE) as { account: string; id: string; time: number; symbol: string; kind: LedgerKind; amount: string }[];
    const venueOf = (key: string) => accounts[keys.indexOf(key)]?.venue ?? null;
    const result = {
      currency: 'USDT', range, ranges: Object.keys(PNL_RANGES), now: current, requestedStart, start, intervalMs: PNL_SAMPLE_MS, sampledAt,
      status: count === 0 ? 'collecting' : latest?.totalPnl === null ? 'incomplete' : 'ready',
      recordingStartedAt: series.times[0] ?? null, pointCount: count, points: points.map(formatPoint), latest: latest ? formatPoint(latest) : null,
      totals: ledgerStart === null ? null : { funding: sum('funding'), realized: sum('realized'), fee: sum('fee') },
      accounts: accounts.map((account, index) => {
        const slot = slots[index]!, state = sync[index]!;
        return {
          venue: account.venue, accountId: maskId(account.accountId), accountMode: account.accountMode,
          positions: { ...slot }, ledger: { start: state.start, coveredUntil: state.coveredUntil, syncedAt: state.syncedAt, failedAt: state.failedAt, error: state.error },
          symbols: OIL_SYMBOLS.map(symbol => {
            return { symbol, funding: sum(`${index}:${symbol}:funding`), realized: sum(`${index}:${symbol}:realized`), fee: sum(`${index}:${symbol}:fee`),
              unrealized: slot.rows ? fromUnits(slot.rows.filter(row => row.symbol === symbol).reduce((total, row) => total + units(row.unrealizedPnl), 0n)) : null };
          }),
        };
      }),
      entries: { page: shown, pages, total: total.count, pageSize: PNL_PAGE_SIZE, rows: rows.map(row => ({ venue: venueOf(row.account), id: row.id, time: row.time, symbol: row.symbol, kind: row.kind, amount: row.amount })) },
    };
    // Bounded: four ranges times the pages viewed lately.
    if (cache.size >= 32) cache.clear();
    cache.set(cacheKey, { version, minute, result });
    return result;
  }

  // Loaded once while the service starts, not on the first page read or sample.
  loadSeries();
  return { sample, syncLedgers, read, close: () => db.close() };
}
export type OilPnl = ReturnType<typeof createOilPnl>;
