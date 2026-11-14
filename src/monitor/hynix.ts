// Monitor M-2b: the Hynix ADR premium collector (Hyperliquid xyz:SKHY against xyz:SKHX ÷ 10). Three loops: the xyz dex's mids
// every 10 s, completed 1-hour candles every 60 s through the vendored workbench module, and (M-2d, funding.ts) the settled
// hourly funding rates every 5 minutes. Every request carries its own
// timeout and is never retried within a round; a failed round keeps what was there and says why. The last quote and the
// candles are kept in monitor.sqlite and read back at start, marked as a snapshot until a round succeeds.
import {
  FIRST_FULL_HOUR, fetchHynixCandles, fetchHynixQuote, hynixCandleStart, validateHynixQuote, validateHynixRows,
  type HynixCandleRow, type HynixFetcher, type HynixQuote,
} from '../vendor/hynix-market.mjs';
import { HYNIX_FIRST_SETTLEMENT, HYNIX_FUNDING_MS, fetchHynixFunding, validateHynixFundingRows, type HynixFundingRow } from '../vendor/settled-funding.mjs';
import { FUNDING_REFRESH_MS, createFundingHistory, type FundingView } from './funding.ts';
import { CANDLE_STALE_MS, QUOTE_STALE_MS, boundedReply, type LoopContext } from './anthropic.ts';
import type { MonitorStore } from './store.ts';

export const HYNIX_QUOTE_REFRESH_MS = 10_000;
export const HYNIX_CANDLE_REFRESH_MS = 60_000;
export const HYNIX_RETENTION_DAYS = 400;
export const HYNIX_QUOTE_KEY = 'hynix.quote';
export const HYNIX_CANDLE_KEY = 'hynix.candles';
export const HYNIX_FUNDING_KEY = 'hynix.funding';
/** The settlement range one funding round reads at most (see the funding history below). */
export const HYNIX_FUNDING_SPAN_MS = 60 * 86_400_000;
/** The workbench's timeouts (lib/quote-service.ts, lib/market-service.ts). */
const QUOTE_TIMEOUT_MS = 5_000, CANDLE_TIMEOUT_MS = 10_000, DAY_MS = 86_400_000;
/**
 * How often a round also re-reads the gaps older than the last 48 hours. The workbench reads from the earliest gap every
 * round; an hour without trades on either leg has no candle, so that would page up to 5000 hours each minute.
 */
export const HYNIX_GAP_RETRY_MS = 3_600_000;

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

export function createHynixMonitor({ store, fetchImpl = fetch, now = Date.now, log = line => process.stderr.write(`${line}\n`) }: {
  store: MonitorStore; fetchImpl?: HynixFetcher; now?: () => number; log?: (line: string) => void;
}) {
  const stopping = new AbortController();
  // The vendor module puts a timeout on every request; the stop signal is added so a shutdown does not wait one out.
  const fetcher: HynixFetcher = async (url, init) => boundedReply(await fetchImpl(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, stopping.signal]) : stopping.signal }));

  let quote: HynixQuote | null = null, quoteRestored = false, quoteAttemptAt: number | null = null, quoteError: string | null = null;
  let rows: HynixCandleRow[] = [], fetchedAt: string | null = null, candlesRestored = false, candleAttemptAt: number | null = null, candleError: string | null = null;
  // The stored rows could not be read back: the next successful round rewrites the table instead of adding to it.
  let replaceCandles = false;
  // Until this time, rounds read on from the last 48 hours only; the first round after a start reads every gap.
  let gapRetryAt = 0;

  try {
    const saved = store.readState(HYNIX_QUOTE_KEY);
    if (saved) { quote = validateHynixQuote(saved.value); quoteRestored = true; }
  } catch (error) { log(`海力士上次报价无法读回，等待新报价：${detail(error)}`); }
  try {
    const stored = store.hynixCandles();
    if (stored.length) {
      const saved = store.readState(HYNIX_CANDLE_KEY);
      if (!saved) throw new Error('K 线轮次记录缺失');
      const at = (saved.value as { fetchedAt?: unknown }).fetchedAt as string;
      rows = validateHynixRows(stored, at); fetchedAt = at; candlesRestored = true;
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
    validate: validateHynixFundingRows, fetch: (start, end, at) => fetchHynixFunding(start, { fetcher, timeout: CANDLE_TIMEOUT_MS, now: at, endTime: end }),
    reason: hynixError, aborted: () => stopping.signal.aborted, now, log,
  });

  async function refreshQuote(): Promise<void> {
    quoteAttemptAt = now();
    let next: HynixQuote;
    try { next = await fetchHynixQuote({ fetcher, timeout: QUOTE_TIMEOUT_MS, now }); }
    catch (error) {
      if (stopping.signal.aborted) return;
      quoteError = hynixError(error);
      quoteReport.failed(quoteError, detail(error));
      return;
    }
    if (stopping.signal.aborted) return;
    quote = next; quoteRestored = false; quoteError = null;
    quoteReport.recovered();
    try { store.writeState(HYNIX_QUOTE_KEY, next); quoteSave.recovered(); }
    catch (error) { quoteSave.failed('monitor.sqlite 写入失败', detail(error)); }
  }

  async function refreshCandles(): Promise<void> {
    const at = now();
    candleAttemptAt = at;
    const cutoff = Math.max(FIRST_FULL_HOUR, at - HYNIX_RETENTION_DAYS * DAY_MS);
    const full = at >= gapRetryAt;
    let next: HynixCandleRow[];
    try {
      const fetched = await fetchHynixCandles(hynixCandleStart(rows, at, full), { fetcher, timeout: CANDLE_TIMEOUT_MS, now: at });
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
    try {
      store.writeHynixCandles({ rows: changed, cutoff, replace: replaceCandles, state: { key: HYNIX_CANDLE_KEY, value: { fetchedAt: stamp } } });
    } catch (error) {
      // Memory stays with what is stored, so the next round reads on from there and writes the same rows again.
      candleError = 'K 线保存失败：monitor.sqlite 写入失败';
      candleSave.failed('monitor.sqlite 写入失败', detail(error));
      return;
    }
    candleSave.recovered();
    // The gaps count as re-read only once the round is stored; a failed write re-reads them next round.
    if (full) gapRetryAt = at + HYNIX_GAP_RETRY_MS;
    rows = next; fetchedAt = stamp; candlesRestored = false; candleError = null; replaceCandles = false;
  }

  return {
    refreshQuote,
    refreshCandles,
    /** The last quote with its freshness (by receipt time: allMids carries no source time); null before any quote exists. */
    quote(): HynixQuoteView | null {
      if (!quote) return null;
      const stale = quoteRestored || now() - Date.parse(quote.fetchedAt) > QUOTE_STALE_MS;
      return { ...quote, status: stale ? 'snapshot' : 'live', staleAfterMs: QUOTE_STALE_MS, lastAttemptAt: iso(quoteAttemptAt), lastError: quoteError };
    },
    /** The hours within `days` before the last stored one (null: all of them), with the complete history's range; null before any row exists. */
    candles(days: number | null): HynixCandleView | null {
      if (!rows.length || fetchedAt === null) return null;
      const stale = candlesRestored || candleError !== null || now() - Date.parse(fetchedAt) > CANDLE_STALE_MS;
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
