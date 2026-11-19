// Monitor M-2d: the settled-funding history of a two-leg market (oil on Binance every 4 h, Hynix on Hyperliquid hourly),
// The collector checks every five minutes and queries due settlements, unfinished chunks or one missing interval.
// A failed round keeps the last durable rows and source time.
import { mergeFundingRows } from '../vendor/settled-funding.mjs';
import type { Exchange, SpreadMarket } from '../vendor/exchange-comparison.mjs';
import type { FundingHistoryRange } from '../vendor/exchange-funding-history.mjs';
import { FundingArchiveWriteError, type FundingArchive, type FundingFact, type FundingSide } from './funding-archive.ts';
import type { CandleWrite } from './store.ts';

export const FUNDING_REFRESH_MS = 300_000;
export const FUNDING_RETENTION_DAYS = 400;
/** Delay between repairs of previous settlement slots. */
export const FUNDING_GAP_RETRY_MS = 3_600_000;
/** About three missed rounds. */
export const FUNDING_STALE_MS = 3 * FUNDING_REFRESH_MS + 60_000;
const SETTLEMENT_GRACE_MS = 60_000;
const DAY_MS = 86_400_000;
/** Prefer a recent hole on the first repair, then rotate through all known gaps. */
export const FUNDING_GAP_LOOKBACK_MS = 7 * DAY_MS;

export interface FundingCoverage { firstSettlement: string; lastSettlement: string; rows: number; pairedRows: number }
export interface FundingView<Row> {
  rows: Row[]; fetchedAt: string; status: 'live' | 'snapshot'; intervalHours: number;
  /** False while the backfill still reads on in segments; the rows then end before fetchedAt. */
  complete: boolean;
  coverage: FundingCoverage; lastAttemptAt: string | null; lastError: string | null;
}

export interface FundingSpec<Row extends { time: number }> {
  /** '原油' / '海力士', for the log lines. */
  name: string;
  key: string;
  legs: readonly (keyof Row & string)[];
  first: number;
  intervalMs: number;
  /** The longest time range one round reads, so a backfill is spread over rounds and stays within the venue's request weight. */
  spanMs: number;
  read(): Row[];
  /** The round metadata saved with the rows ({ fetchedAt }); null when it was never written. */
  readState(): unknown;
  write(write: CandleWrite<Row>): number;
  validate(rows: unknown, fetchedAt: string): Row[];
  fetch(startTime: number, endTime: number, now: number, sides: readonly FundingSide[], since: number): Promise<Row[] | { rows: Row[]; fetchedAt: number }>;
  /** Short Chinese reason for a failed read; never echoes upstream bodies. */
  reason(error: unknown): string;
  aborted(): boolean;
  now: () => number;
  log: (line: string) => void;
}

const iso = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString();
const detail = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);

export function projectedFunding<Row>(archive: FundingArchive, market: SpreadMarket, exchange: Exchange, signal: AbortSignal,
  load: (side: FundingSide, range: FundingHistoryRange, signal: AbortSignal) => Promise<FundingFact[]>,
  project: (left: FundingFact[], right: FundingFact[], at: number) => Row[]) {
  return async (from: number, to: number, at: number, sides: readonly FundingSide[], since: number) => {
    const range = { from, to };
    const read = async (side: FundingSide) => {
      if (!sides.includes(side)) return { records: [], fetchedAt: 0 };
      // Another consumer may already have recovered the settlement that is missing from the paired chart.
      const held = since && archive.inspect(market, exchange, side, range).records.length;
      return archive.read(market, exchange, side, range, (_market, _exchange, leg, bounds, stop) => load(leg, bounds, stop), signal, held ? 0 : since);
    };
    const [left, right] = await Promise.allSettled([read('left'), read('right')]);
    if (left.status === 'rejected') throw left.reason;
    if (right.status === 'rejected') throw right.reason;
    return { rows: project(left.value.records, right.value.records, at), fetchedAt: Math.max(left.value.fetchedAt, right.value.fetchedAt) };
  };
}

export function createFundingHistory<Row extends { time: number }>(spec: FundingSpec<Row>) {
  const { name, key, legs, now, log } = spec;
  let rows: Row[] = [], fetchedAt: string | null = null, attemptAt: number | null = null, error: string | null = null;
  let complete = false, readTo = -1, gapRetryAt = 0, tailRetryAt = 0, gapCursor = 0;
  // The stored rows could not be read back: the next successful round rewrites the table instead of adding to it.
  let replace = false;
  try {
    const stored = spec.read(), saved = spec.readState() as { fetchedAt: string; readTo?: number; complete?: boolean; gapRetryAt?: number; tailRetryAt?: number; gapCursor?: number } | null;
    if (stored.length || saved) {
      if (!saved || !Number.isFinite(Date.parse(saved.fetchedAt))) throw new Error('资金费轮次记录缺失');
      rows = spec.validate(stored, saved.fetchedAt); fetchedAt = saved.fetchedAt;
      // Old databases have only projected grid times. Resume conservatively at their last settlement.
      readTo = saved.readTo ?? (rows.length ? rows.at(-1)!.time - 1 : -1);
      if (!Number.isSafeInteger(readTo) || readTo > Date.parse(fetchedAt)) throw new Error('资金费回补进度无效');
      complete = saved.complete === true;
      gapRetryAt = saved.gapRetryAt ?? 0; tailRetryAt = saved.tailRetryAt ?? 0; gapCursor = saved.gapCursor ?? 0;
    }
  } catch (cause) { rows = []; fetchedAt = null; readTo = -1; replace = true; log(`${name}资金费历史无法读回，将重新回补：${detail(cause)}`); }

  /** Logs a failure when its text changes and the recovery once, so an outage does not write a line every round. */
  const reporter = (what: string) => {
    let last: string | null = null;
    return {
      failed(text: string, cause: string): void { if (text !== last) log(`${name}${what}失败：${text}（${cause}）`); last = text; },
      recovered(): void { if (last !== null) log(`${name}${what}已恢复`); last = null; },
    };
  };
  const readReport = reporter('资金费读取'), saveReport = reporter('资金费保存');
  const same = (a: Row, b: Row): boolean => legs.every(leg => a[leg] === b[leg]);

  const allSides = ['left', 'right'] as const;
  function missing(row: Row | undefined): FundingSide[] { return allSides.filter((_, i) => !row || row[legs[i]!] == null); }
  const lastDue = (at: number) => Math.floor((at - SETTLEMENT_GRACE_MS) / spec.intervalMs) * spec.intervalMs;

  async function collect(): Promise<void> {
    const at = now();
    const cutoff = Math.max(spec.first, at - FUNDING_RETENTION_DAYS * DAY_MS);
    const due = lastDue(at);
    if (due < cutoff) return;
    let start = Math.max(cutoff, readTo + 1), end = Math.min(at, start + spec.spanMs);
    const forward = !complete || readTo < due;
    let sides: readonly FundingSide[] = allSides, since = 0, nextGapRetryAt = gapRetryAt, nextGapCursor = gapCursor;
    if (!forward) {
      const byTime = new Map(rows.map(row => [row.time, row]));
      const holes: number[] = [];
      if (at >= gapRetryAt && rows.length) {
        // Scan actually listed history. Rotate through old holes so a permanently missing settlement cannot starve the next.
        const first = Math.max(rows[0]!.time, Math.ceil(cutoff / spec.intervalMs) * spec.intervalMs);
        for (let t = first; t < due; t += spec.intervalMs) if (missing(byTime.get(t)).length) holes.push(t);
      }
      if (holes.length) {
        const recent = holes.filter(t => t >= at - FUNDING_GAP_LOOKBACK_MS);
        // Start with a recent hole, then rotate over the whole set, including older history.
        start = gapCursor ? holes.find(t => t > gapCursor) ?? holes[0]! : recent[0] ?? holes[0]!;
        end = start + spec.intervalMs - 1; sides = missing(byTime.get(start));
        since = at - FUNDING_GAP_RETRY_MS + 1; nextGapRetryAt = at + FUNDING_GAP_RETRY_MS; nextGapCursor = start;
      } else {
        sides = missing(byTime.get(due));
        if (!sides.length || at < tailRetryAt) return;
        start = due; end = at; since = at - FUNDING_REFRESH_MS + 1;
      }
    }
    if (start > end) return;
    attemptAt = at;
    let next: Row[], sourceAt: number;
    try {
      const batch = await spec.fetch(start, end, at, sides, since);
      const fetched = Array.isArray(batch) ? batch : batch.rows;
      sourceAt = Math.max(fetchedAt ? Date.parse(fetchedAt) : 0, Array.isArray(batch) ? at : batch.fetchedAt);
      next = mergeFundingRows(rows, fetched, legs).filter(row => row.time >= cutoff);
      next = spec.validate(next, new Date(sourceAt).toISOString());
    } catch (cause) {
      if (spec.aborted()) return;
      if (cause instanceof FundingArchiveWriteError) {
        error = '资金费保存失败：monitor.sqlite 写入失败';
        saveReport.failed('monitor.sqlite 写入失败', detail(cause.cause)); return;
      }
      const reason = spec.reason(cause);
      error = `资金费读取失败：${reason}`;
      readReport.failed(reason, detail(cause));
      return;
    }
    if (spec.aborted()) return;
    readReport.recovered();
    const previous = new Map(rows.map(row => [row.time, row]));
    const changed = replace ? next : next.filter(row => { const old = previous.get(row.time); return !old || !same(old, row); });
    const stamp = new Date(sourceAt).toISOString(), nextReadTo = forward ? end : readTo;
    const nextComplete = forward ? end >= at : complete;
    if (readTo < 0) nextGapRetryAt = at + FUNDING_GAP_RETRY_MS;
    const nextTailRetryAt = end >= due ? at + FUNDING_REFRESH_MS : tailRetryAt;
    try { spec.write({ rows: changed, cutoff, replace, state: { key, value: { fetchedAt: stamp, readTo: nextReadTo, complete: nextComplete,
      gapRetryAt: nextGapRetryAt, tailRetryAt: nextTailRetryAt, gapCursor: nextGapCursor } } }); }
    catch (cause) {
      // Memory stays with what is stored, so the next round reads on from there and writes the same rows again.
      error = '资金费保存失败：monitor.sqlite 写入失败';
      saveReport.failed('monitor.sqlite 写入失败', detail(cause));
      return;
    }
    saveReport.recovered();
    gapRetryAt = nextGapRetryAt; gapCursor = nextGapCursor; tailRetryAt = nextTailRetryAt;
    rows = next; fetchedAt = stamp; error = null; replace = false; complete = nextComplete; readTo = nextReadTo;
  }

  let pending: Promise<void> | undefined;
  return {
    refresh: () => pending ??= collect().finally(() => { pending = undefined; }),
    /** Every stored settlement with the history's range; null before any row exists. */
    view(): FundingView<Row> | null {
      if (!rows.length || fetchedAt === null) return null;
      const at = now(), expected = Math.floor((at - FUNDING_STALE_MS) / spec.intervalMs) * spec.intervalMs;
      const pairedThrough = rows.findLast(row => legs.every(leg => row[leg] !== null))?.time ?? -1;
      const stale = error !== null || (complete ? readTo < expected || pairedThrough < expected : at - Date.parse(fetchedAt) > FUNDING_STALE_MS);
      const pairedRows = rows.filter(row => legs.every(leg => row[leg] !== null)).length;
      return {
        rows, fetchedAt, status: stale ? 'snapshot' : 'live', intervalHours: spec.intervalMs / 3_600_000, complete,
        coverage: { firstSettlement: new Date(rows[0]!.time).toISOString(), lastSettlement: new Date(rows.at(-1)!.time).toISOString(), rows: rows.length, pairedRows },
        lastAttemptAt: iso(attemptAt), lastError: error,
      };
    },
    status: () => ({ fundingAt: fetchedAt, fundingRows: rows.length, fundingError: error }),
  };
}
export type FundingHistory<Row extends { time: number }> = ReturnType<typeof createFundingHistory<Row>>;
