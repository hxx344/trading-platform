// Monitor M-2b: the Hynix ADR premium collector (Hyperliquid xyz:SKHY against xyz:SKHX ÷ 10). Three loops: the xyz dex's mids
// every 10 s, completed 1-hour candles every 60 s through the vendored workbench module, and (M-2d, funding.ts) the settled
// hourly funding rates every 5 minutes. Every request carries its own
// timeout and is never retried within a round; a failed round keeps what was there and says why. The last quote and the
// candles are kept in monitor.sqlite and read back at start, marked as a snapshot until a round succeeds.
import {
  FIRST_FULL_HOUR, HYNIX_CANDLE_MS, HYNIX_MAX_CANDLES, validateHynixQuote, validateHynixRows,
  type HynixCandleRow, type HynixFetcher, type HynixQuote,
} from '../vendor/hynix-market.mjs';
import { HYNIX_FIRST_SETTLEMENT, HYNIX_FUNDING_MS, projectHynixFunding, validateHynixFundingRows, type HynixFundingRow } from '../vendor/settled-funding.mjs';
import { FUNDING_REFRESH_MS, createFundingHistory, projectedFunding, type FundingView } from './funding.ts';
import { createFundingArchive, type FundingArchive } from './funding-archive.ts';
import { CANDLE_STALE_MS, QUOTE_STALE_MS, type LoopContext } from './anthropic.ts';
import { createMarketReaders, type MarketReaders } from './market-readers.ts';
import { afterCandleRange, candleCheckOverdue, candleCoverage, nextCandleRange, type CandleCoverage } from './candle-coverage.ts';
import type { MonitorStore } from './store.ts';

export const HYNIX_QUOTE_REFRESH_MS = 10_000;
export const HYNIX_CANDLE_REFRESH_MS = 60_000;
export const HYNIX_RETENTION_DAYS = 400;
export const HYNIX_QUOTE_KEY = 'hynix.quote';
export const HYNIX_CANDLE_KEY = 'hynix.candles';
export const HYNIX_FUNDING_KEY = 'hynix.funding';
/** The settlement range one funding round reads at most (see the funding history below). */
export const HYNIX_FUNDING_SPAN_MS = 60 * 86_400_000;
const DAY_MS = 86_400_000;
export { CANDLE_GAP_RETRY_MS as HYNIX_GAP_RETRY_MS } from './candle-coverage.ts';

export interface HynixQuoteView extends HynixQuote {
  status: 'live' | 'snapshot';
  staleAfterMs: number;
  lastAttemptAt: string | null;
  lastError: string | null;
}
export interface HynixCoverage { firstObservation: string; lastObservation: string; rows: number }
/** `windowDays`: present on a windowed read, whose `rows` start that many days before the last hour. */
export interface HynixCandleView {
  rows: HynixCandleRow[]; fetchedAt: string; status: 'live' | 'snapshot'; windowDays?: number;
  coverage: HynixCoverage; lastAttemptAt: string | null; lastError: string | null;
}

/** Short Chinese reason for a failed read; never echoes upstream bodies. */
export function hynixError(error: unknown): string {
  const value = error as { name?: string; message?: unknown } | null;
  const http = /HTTP (\d{3})/.exec(String(value?.message ?? ''));
  if (http) return http[1] === '429' ? '接口限流（HTTP 429）' : `接口返回 HTTP ${http[1]}`;
  if (value?.name === 'TimeoutError' || value?.name === 'AbortError') return '请求超时';
  return '响应无效或网络失败';
}

const iso = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString();
const detail = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);

export function createHynixMonitor({ store, fetchImpl = fetch, now = Date.now, readers = createMarketReaders({ fetchImpl, now }), archive = createFundingArchive(store, now), log = line => process.stderr.write(`${line}\n`) }: {
  store: MonitorStore; archive?: FundingArchive; readers?: MarketReaders; fetchImpl?: HynixFetcher; now?: () => number; log?: (line: string) => void;
}) {
  const stopping = new AbortController();

  let quoteEpoch: string | null = null;
  let quote: HynixQuote | null = null, quoteRestored = false, quoteAttemptAt: number | null = null, quoteError: string | null = null;
  let rows: HynixCandleRow[] = [], fetchedAt: string | null = null, candlesRestored = false, candleAttemptAt: number | null = null, candleError: string | null = null;
  // The stored rows could not be read back: the next successful round rewrites the table instead of adding to it.
  let replaceCandles = false;
  let progress = candleCoverage(null, 0, HYNIX_CANDLE_MS, 0);

  try {
    const saved = store.readState(HYNIX_QUOTE_KEY);
    if (saved) { quote = validateHynixQuote(saved.value); quoteRestored = true; }
  } catch (error) { log(`海力士上次报价无法读回，等待新报价：${detail(error)}`); }
  try {
    const stored = store.hynixCandles();
    const saved = store.readState(HYNIX_CANDLE_KEY);
    if (stored.length || saved) {
      if (!saved) throw new Error('K 线轮次记录缺失');
      const { fetchedAt: at, coverage } = saved.value as { fetchedAt: string; coverage?: CandleCoverage };
      const checked = validateHynixRows(stored, at), stamp = Date.parse(at);
      progress = candleCoverage(coverage, Math.floor(stamp / HYNIX_CANDLE_MS) * HYNIX_CANDLE_MS, HYNIX_CANDLE_MS, stamp);
      rows = checked; fetchedAt = at; candlesRestored = true;
    }
  } catch (error) { rows = []; fetchedAt = null; replaceCandles = true; log(`海力士 K 线历史无法读回，将重新回补：${detail(error)}`); }

  /** Logs a failure when its text changes and the recovery once, so an outage does not write a line every round. */
  const reporter = (name: string) => {
    let last: string | null = null;
    return {
      failed(text: string, cause: string): void { if (text !== last) log(`海力士${name}失败：${text}（${cause}）`); last = text; },
      recovered(): void { if (last !== null) log(`海力士${name}已恢复`); last = null; },
    };
  };
  const quoteReport = reporter('报价读取'), quoteSave = reporter('报价保存'), candleReport = reporter('K 线读取'), candleSave = reporter('K 线保存');
  const funding = createFundingHistory<HynixFundingRow>({
    // Hyperliquid weighs fundingHistory 20 a call plus 1 per 20 records (1200 a minute per IP): 60 days are ~300 for both legs,
    // where a 400-day backfill in one round would pass the limit and fail every round.
    name: '海力士', key: HYNIX_FUNDING_KEY, legs: ['adr', 'ordinary'], first: HYNIX_FIRST_SETTLEMENT, intervalMs: HYNIX_FUNDING_MS, spanMs: HYNIX_FUNDING_SPAN_MS,
    read: () => store.hynixFunding(), readState: () => store.readState(HYNIX_FUNDING_KEY)?.value ?? null, write: write => store.writeHynixFunding(write),
    validate: validateHynixFundingRows, fetch: projectedFunding(archive, 'hynix', 'hyperliquid', stopping.signal, readers.hynixFunding, projectHynixFunding),
    reason: hynixError, aborted: () => stopping.signal.aborted, now, log,
  });

  async function refreshQuote(): Promise<void> {
    quoteAttemptAt = now();
    let next: HynixQuote;
    try { next = await readers.hynixQuote(stopping.signal); }
    catch (error) {
      if (stopping.signal.aborted) return;
      quoteError = hynixError(error);
      quoteReport.failed(quoteError, detail(error));
      return;
    }
    if (stopping.signal.aborted) return;
    quote = next; quoteEpoch = readers.epoch?.() ?? null; quoteRestored = false; quoteError = null;
    quoteReport.recovered();
    try { store.writeState(HYNIX_QUOTE_KEY, next); quoteSave.recovered(); }
    catch (error) { quoteSave.failed('monitor.sqlite 写入失败', detail(error)); }
  }

  async function refreshCandles(): Promise<void> {
    const at = now();
    const cutoff = Math.max(FIRST_FULL_HOUR, at - HYNIX_RETENTION_DAYS * DAY_MS);
    const first = Math.max(FIRST_FULL_HOUR, (Math.floor(at / HYNIX_CANDLE_MS) - HYNIX_MAX_CANDLES + 1) * HYNIX_CANDLE_MS);
    const work = nextCandleRange(progress, rows, () => true, first, HYNIX_CANDLE_MS, at);
    if (!work) { candlesRestored = false; return; }
    candleAttemptAt = at;
    let next: HynixCandleRow[];
    try {
      const fetched = validateHynixRows(await readers.hynixCandles(work.start, at, stopping.signal, work.end), new Date(work.end).toISOString());
      if (fetched.some(row => row.time < work.start)) throw new Error('海力士 K 线超出本轮范围');
      // The fetched hours take precedence over the stored ones they overlap; the kept history ends at the retention cut.
      const merged = new Map(rows.map(row => [row.time, row]));
      for (const row of fetched) merged.set(row.time, row);
      next = [...merged.values()].filter(row => row.time >= cutoff).sort((a, b) => a.time - b.time);
    } catch (error) {
      if (stopping.signal.aborted) return;
      const reason = hynixError(error);
      candleError = `K 线读取失败：${reason}`;
      candleReport.failed(reason, detail(error));
      return;
    }
    if (stopping.signal.aborted) return;
    candleReport.recovered();
    const previous = new Map(rows.map(row => [row.time, row]));
    const changed = replaceCandles ? next : next.filter(row => {
      const old = previous.get(row.time);
      return !old || old.adr !== row.adr || old.ordinary !== row.ordinary;
    });
    const stamp = new Date(at).toISOString();
    const nextProgress = afterCandleRange(progress, work, work.end, at);
    try {
      store.writeHynixCandles({ rows: changed, cutoff, replace: replaceCandles, state: { key: HYNIX_CANDLE_KEY, value: { fetchedAt: stamp, coverage: nextProgress } } });
    } catch (error) {
      // Memory stays with what is stored, so the next round reads on from there and writes the same rows again.
      candleError = 'K 线保存失败：monitor.sqlite 写入失败';
      candleSave.failed('monitor.sqlite 写入失败', detail(error));
      return;
    }
    candleSave.recovered();
    progress = nextProgress;
    rows = next; fetchedAt = stamp; candlesRestored = false; candleError = null; replaceCandles = false;
  }

  return {
    refreshQuote,
    refreshCandles,
    /** The last quote with its freshness (by receipt time: allMids carries no source time); null before any quote exists. */
    quote(): HynixQuoteView | null {
      if (!quote) return null;
      const stale = quoteRestored || (readers.epoch && (!quoteEpoch || quoteEpoch !== readers.epoch())) || now() - Date.parse(quote.fetchedAt) > QUOTE_STALE_MS;
      return { ...quote, status: stale ? 'snapshot' : 'live', staleAfterMs: QUOTE_STALE_MS, lastAttemptAt: iso(quoteAttemptAt), lastError: quoteError };
    },
    /** The hours within `days` before the last stored one (null: all of them), with the complete history's range; null before any row exists. */
    candles(days: number | null): HynixCandleView | null {
      if (!rows.length || fetchedAt === null) return null;
      const commonThrough = rows.at(-1)!.time + HYNIX_CANDLE_MS;
      const stale = candlesRestored || candleError !== null || candleCheckOverdue(Math.min(progress.through, commonThrough), HYNIX_CANDLE_MS, now(), CANDLE_STALE_MS);
      const coverage = { firstObservation: new Date(rows[0]!.time).toISOString(), lastObservation: new Date(rows.at(-1)!.time).toISOString(), rows: rows.length };
      const from = days === null ? -Infinity : rows.at(-1)!.time - days * DAY_MS;
      const shown = days === null ? rows : rows.filter(row => row.time >= from);
      return { rows: shown, fetchedAt, status: stale ? 'snapshot' : 'live', ...(days === null ? {} : { windowDays: days }), coverage, lastAttemptAt: iso(candleAttemptAt), lastError: candleError };
    },
    refreshFunding: funding.refresh,
    /** Every stored settlement hour since the retention cut; null before any row exists. */
    funding: (): FundingView<HynixFundingRow> | null => funding.view(),
    /** For the status page. */
    status() {
      return { quoteAt: quote?.fetchedAt ?? null, quoteError, candlesAt: fetchedAt, candleRows: rows.length, candleError, ...funding.status() };
    },
    /** The three loops; a round starts only after the previous one of its loop ended and the interval passed. */
    loops(context: LoopContext): Promise<void>[] {
      const every = (intervalMs: number, name: string, round: () => Promise<void>) => (async () => {
        while (!context.stopped()) {
          try { await round(); } catch (error) { log(`海力士${name}出错：${detail(error)}`); }
          if (context.stopped()) break;
          await context.pause(intervalMs);
        }
      })();
      return [every(HYNIX_QUOTE_REFRESH_MS, '报价', refreshQuote), every(HYNIX_CANDLE_REFRESH_MS, ' K 线', refreshCandles), every(FUNDING_REFRESH_MS, '资金费', funding.refresh)];
    },
    /** Cuts the requests in flight short; the loops then end at their next stop check. */
    stop(): void { stopping.abort(); },
  };
}
export type HynixMonitor = ReturnType<typeof createHynixMonitor>;
