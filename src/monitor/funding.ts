// Monitor M-2d: the settled-funding history of a two-leg market (oil on Binance every 4 h, Hynix on Hyperliquid hourly),
// one round every 5 minutes inside the market's collector, through its fetcher (oil: with the Binance cooldown). Like the
// candles: rows stored in monitor.sqlite and read back at start as a snapshot, memory advanced only after a successful
// write, the full gap re-read at most hourly, a failed round keeps what was there and says why.
import { fundingStart, mergeFundingRows } from '../vendor/settled-funding.mjs';
import type { CandleWrite } from './store.ts';

export const FUNDING_REFRESH_MS = 300_000;
export const FUNDING_RETENTION_DAYS = 400;
/** How often a round also re-reads the gaps and one-sided settlements older than the last two days. */
export const FUNDING_GAP_RETRY_MS = 3_600_000;
/** About three missed rounds. */
export const FUNDING_STALE_MS = 3 * FUNDING_REFRESH_MS + 60_000;
const DAY_MS = 86_400_000;
/** How far back the hourly round looks for gaps; older gaps stay as they are (a permanent gap must not make every hour re-read months). */
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
  fetch(startTime: number, endTime: number, now: number): Promise<Row[]>;
  /** Short Chinese reason for a failed read; never echoes upstream bodies. */
  reason(error: unknown): string;
  aborted(): boolean;
  now: () => number;
  log: (line: string) => void;
}

const iso = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString();
const detail = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);

export function createFundingHistory<Row extends { time: number }>(spec: FundingSpec<Row>) {
  const { name, key, legs, now, log } = spec;
  let rows: Row[] = [], fetchedAt: string | null = null, restored = false, attemptAt: number | null = null, error: string | null = null;
  // Whether the last stored round read up to its own time, and where it read to: a backfill reads on from there, even when
  // that segment had no settlement (so an empty stretch cannot hold it in place). A restart reads from the rows again.
  let complete = true, readTo = -Infinity;
  // The stored rows could not be read back: the next successful round rewrites the table instead of adding to it.
  let replace = false;
  // Until this time, rounds read on from the last two days only; the first round after a start reads every gap.
  let gapRetryAt = 0;

  try {
    const stored = spec.read();
    if (stored.length) {
      const saved = spec.readState();
      if (!saved) throw new Error('资金费轮次记录缺失');
      const at = (saved as { fetchedAt?: unknown }).fetchedAt as string;
      rows = spec.validate(stored, at); fetchedAt = at; restored = true;
    }
  } catch (cause) { rows = []; fetchedAt = null; replace = true; log(`${name}资金费历史无法读回，将重新回补：${detail(cause)}`); }

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

  async function refresh(): Promise<void> {
    const at = now();
    attemptAt = at;
    const cutoff = Math.max(spec.first, at - FUNDING_RETENTION_DAYS * DAY_MS);
    const full = at >= gapRetryAt;
    let next: Row[], end = at;
    try {
      const resume = fundingStart(rows, { first: spec.first, intervalMs: spec.intervalMs, legs, cutoff, full, gapSince: at - FUNDING_GAP_LOOKBACK_MS });
      const start = complete ? resume : Math.max(resume, readTo);
      end = Math.min(at, start + spec.spanMs);
      const fetched = await spec.fetch(start, end, at);
      next = mergeFundingRows(rows, fetched, legs).filter(row => row.time >= cutoff);
      // The same checks as a read-back, so what is stored always reads back.
      next = spec.validate(next, new Date(at).toISOString());
    } catch (cause) {
      if (spec.aborted()) return;
      const reason = spec.reason(cause);
      error = `资金费读取失败：${reason}`;
      readReport.failed(reason, detail(cause));
      return;
    }
    if (spec.aborted()) return;
    readReport.recovered();
    const previous = new Map(rows.map(row => [row.time, row]));
    const changed = replace ? next : next.filter(row => { const old = previous.get(row.time); return !old || !same(old, row); });
    const stamp = new Date(at).toISOString();
    try { spec.write({ rows: changed, cutoff, replace, state: { key, value: { fetchedAt: stamp } } }); }
    catch (cause) {
      // Memory stays with what is stored, so the next round reads on from there and writes the same rows again.
      error = '资金费保存失败：monitor.sqlite 写入失败';
      saveReport.failed('monitor.sqlite 写入失败', detail(cause));
      return;
    }
    saveReport.recovered();
    if (full) gapRetryAt = at + FUNDING_GAP_RETRY_MS;
    rows = next; fetchedAt = stamp; restored = false; error = null; replace = false; complete = end >= at; readTo = end;
  }

  return {
    refresh,
    /** Every stored settlement with the history's range; null before any row exists. */
    view(): FundingView<Row> | null {
      if (!rows.length || fetchedAt === null) return null;
      const stale = restored || error !== null || now() - Date.parse(fetchedAt) > FUNDING_STALE_MS;
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
