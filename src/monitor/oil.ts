// Monitor M-2a: the oil spread collector (Brent − WTI on Binance BZUSDT / CLUSDT). Three loops: the two marks and the funding
// terms every 10 s, completed 15-minute candles every 60 s through the vendored workbench module, and (M-2d, funding.ts) the
// settled four-hour funding rates every 5 minutes. Every request carries its
// own timeout and is never retried within a round; a failed round keeps what was there and says why. The last quote and the
// candles are kept in monitor.sqlite and read back at start, marked as a snapshot until a round succeeds.
import {
  OIL_CANDLE_MS, OIL_CANDLE_REFRESH_MS, createIntradaySnapshot, oilCandleStart, mergeOilCandleRows, validateOilCandleRows, intradayWindow, validateMarket,
  type OilCandleRow, type OilCoverage, type OilFetcher, type OilIntraday, type OilIntradayWindow, type OilMarket,
} from '../vendor/oil-market.mjs';
import type { BinanceGate } from '../vendor/anthropic-market.mjs';
import { OIL_FIRST_SETTLEMENT, OIL_FUNDING_MS, validateOilFundingRows, type OilFundingRow } from '../vendor/settled-funding.mjs';
import { FUNDING_REFRESH_MS, createFundingHistory, type FundingView } from './funding.ts';
import { CANDLE_STALE_MS, QUOTE_STALE_MS, type LoopContext } from './anthropic.ts';
import { BinanceCooldown, OIL_CANDLE_WINDOW_MS } from './market-contract.ts';
import { createMarketReaders, type MarketReaders } from './market-readers.ts';
export { parseOilQuote } from './market-readers.ts';
import type { MonitorStore } from './store.ts';

export const OIL_QUOTE_REFRESH_MS = 10_000;
export const OIL_RETENTION_DAYS = 400;
export const OIL_QUOTE_KEY = 'oil.quote';
export const OIL_CANDLE_KEY = 'oil.candles';
export const OIL_FUNDING_KEY = 'oil.funding';
const DAY_MS = 86_400_000;
/**
 * How often a round also re-reads the gaps older than the last day. The vendored reader starts every round at the earliest
 * gap; a bar Binance never returns would make each round page from there to now (about 26 pages per leg after a year).
 */
export const OIL_GAP_RETRY_MS = 3_600_000;
const RESUME_MS = 96 * OIL_CANDLE_MS;
export interface OilQuoteView extends OilMarket {
  status: 'live' | 'snapshot';
  staleAfterMs: number;
  lastAttemptAt: string | null;
  lastError: string | null;
}
export type OilCandleView = OilIntradayWindow & { coverage: OilCoverage; lastAttemptAt: string | null; lastError: string | null };

/** Short Chinese reason for a failed read; never echoes upstream bodies. */
export function oilError(error: unknown): string {
  if (error instanceof BinanceCooldown) return `接口限流冷却中（HTTP ${error.status}）`;
  const value = error as { name?: string; message?: unknown } | null;
  const http = /HTTP (\d{3})/.exec(String(value?.message ?? ''));
  if (http) return http[1] === '451' ? '服务器所在地区被拒绝访问（HTTP 451）' : `接口返回 HTTP ${http[1]}`;
  if (value?.name === 'TimeoutError' || value?.name === 'AbortError') return '请求超时';
  return '响应无效或网络失败';
}

const iso = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString();
const detail = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);

export function createOilMonitor({ store, gate, fetchImpl = fetch, now = Date.now, readers = createMarketReaders({ fetchImpl, now, gate }), log = line => process.stderr.write(`${line}\n`) }: {
  store: MonitorStore;
  /** The Binance cooldown, shared with the Anthropic monitor: both read Binance from the same address. */
  gate: BinanceGate; readers?: MarketReaders;
  fetchImpl?: OilFetcher; now?: () => number; log?: (line: string) => void;
}) {
  const stopping = new AbortController();

  let quoteEpoch: string | null = null;
  let quote: OilMarket | null = null, quoteRestored = false, quoteAttemptAt: number | null = null, quoteError: string | null = null;
  let candles: OilIntraday | null = null, candlesRestored = false, candleAttemptAt: number | null = null, candleError: string | null = null;
  // The stored rows could not be read back: the next successful round rewrites the table instead of adding to it.
  let replaceCandles = false;
  // Until this time, rounds read on from the last day only; the first round after a start reads every gap.
  let gapRetryAt = 0, checkedThrough = 0, resumeAt: number | null = null;
  // Pre-listing windows may be empty or contain just one leg. Keep these rows until a paired chart can be projected.
  let candleRows: OilCandleRow[] = [];
  const chart = (rows: OilCandleRow[], stamp: string) => rows.some(row => row.brent !== null && row.wti !== null) ? createIntradaySnapshot(rows, stamp) : null;
  const windows = new Map<number | null, { source: OilIntraday; stale: boolean; value: OilIntraday | OilIntradayWindow }>();

  try {
    const saved = store.readState(OIL_QUOTE_KEY);
    if (saved) { quote = validateMarket(saved.value); quoteRestored = true; }
  } catch (error) { log(`原油上次报价无法读回，等待新报价：${detail(error)}`); }
  try {
    const rows = store.oilCandles(), saved = store.readState(OIL_CANDLE_KEY);
    if (rows.length || saved) {
      if (!saved) throw new Error('K 线轮次记录缺失');
      const state = saved.value as { fetchedAt: string; resumeAt?: number | null };
      const checked = validateOilCandleRows(rows, state.fetchedAt);
      const cursor = state.resumeAt;
      if (cursor != null && (!Number.isSafeInteger(cursor) || cursor % OIL_CANDLE_MS !== 0 || cursor < 0 || cursor > Date.parse(state.fetchedAt))) throw new Error('K 线回补进度无效');
      candles = chart(checked, state.fetchedAt); candleRows = checked; resumeAt = cursor ?? null; candlesRestored = true;
      checkedThrough = resumeAt ?? Math.floor(Date.parse(state.fetchedAt) / OIL_CANDLE_MS) * OIL_CANDLE_MS;
    }
  } catch (error) { replaceCandles = true; log(`原油 K 线历史无法读回，将从 2026-04-01 重新回补：${detail(error)}`); }

  /** Logs a failure when its text changes and the recovery once, so an outage does not write a line every round. */
  const reporter = (name: string) => {
    let last: string | null = null;
    return {
      failed(text: string, cause: string): void { if (text !== last) log(`原油${name}失败：${text}（${cause}）`); last = text; },
      recovered(): void { if (last !== null) log(`原油${name}已恢复`); last = null; },
    };
  };
  const quoteReport = reporter('报价读取'), quoteSave = reporter('报价保存'), candleReport = reporter('K 线读取'), candleSave = reporter('K 线保存');
  const funding = createFundingHistory<OilFundingRow>({
    // Binance pages 1000 settlements (~167 days) a request: the whole retention is a few requests, no need to split.
    name: '原油', key: OIL_FUNDING_KEY, legs: ['brent', 'wti'], first: OIL_FIRST_SETTLEMENT, intervalMs: OIL_FUNDING_MS, spanMs: OIL_RETENTION_DAYS * DAY_MS,
    read: () => store.oilFunding(), readState: () => store.readState(OIL_FUNDING_KEY)?.value ?? null, write: write => store.writeOilFunding(write),
    validate: validateOilFundingRows, fetch: (start, end, at) => readers.oilFunding(start, end, at, stopping.signal),
    reason: oilError, aborted: () => stopping.signal.aborted, now, log,
  });

  async function refreshQuote(): Promise<void> {
    quoteAttemptAt = now();
    let next: OilMarket;
    try { next = await readers.oilQuote(stopping.signal); }
    catch (error) {
      if (stopping.signal.aborted) return;
      quoteError = oilError(error);
      quoteReport.failed(quoteError, detail(error));
      return;
    }
    if (stopping.signal.aborted) return;
    quote = next; quoteEpoch = readers.epoch?.() ?? null; quoteRestored = false; quoteError = null;
    quoteReport.recovered();
    try { store.writeState(OIL_QUOTE_KEY, next); quoteSave.recovered(); }
    catch (error) { quoteSave.failed('monitor.sqlite 写入失败', detail(error)); }
  }

  async function refreshCandles(): Promise<void> {
    const at = now();
    candleAttemptAt = at;
    const cutoff = at - OIL_RETENTION_DAYS * DAY_MS;
    const full = at >= gapRetryAt;
    let history = candleRows;
    if (!full && history.length) {
      const from = history.at(-1)!.time - RESUME_MS;
      const firstPair = history.findIndex(row => row.time >= from && row.brent !== null && row.wti !== null);
      if (firstPair > 0) history = history.slice(firstPair);
    }
    const target = Math.floor(at / OIL_CANDLE_MS) * OIL_CANDLE_MS, stamp = new Date(at).toISOString();
    let suggested = oilCandleStart(history);
    if (!full && (!candles || (history.at(-1)?.time ?? 0) < checkedThrough - RESUME_MS)) suggested = Math.max(suggested, checkedThrough - RESUME_MS);
    let start = Math.max(resumeAt ?? suggested, Math.ceil(cutoff / OIL_CANDLE_MS) * OIL_CANDLE_MS);
    let sawBrent = false, sawWti = false;
    while (start < target && !stopping.signal.aborted) {
      const end = Math.min(start + OIL_CANDLE_WINDOW_MS, target);
      let next: OilCandleRow[], projection: OilIntraday | null, changed: OilCandleRow[];
      try {
        const batch = await readers.oilCandles(start, end, stopping.signal);
        if (stopping.signal.aborted) return;
        const incoming = validateOilCandleRows(batch, new Date(end).toISOString());
        if (incoming.some(row => row.time < start)) throw new Error('原油 K 线超出本轮范围');
        sawBrent ||= incoming.some(row => row.brent !== null); sawWti ||= incoming.some(row => row.wti !== null);
        next = mergeOilCandleRows(candleRows, incoming).filter(row => row.time >= cutoff);
        projection = chart(next, stamp);
        const previous = new Map(candleRows.map(row => [row.time, row]));
        changed = replaceCandles ? next : next.filter(row => {
          const old = previous.get(row.time);
          return !old || old.brent !== row.brent || old.wti !== row.wti;
        });
      } catch (error) {
        if (stopping.signal.aborted) return;
        const reason = oilError(error);
        candleError = `K 线读取失败：${reason}`;
        candleReport.failed(reason, detail(error));
        return;
      }
      // Commit the segment and its resume cursor together, including a verified empty segment. A failed write retries this exact segment.
      const cursor = end < target ? end : null;
      try { store.writeOilCandles({ rows: changed, cutoff, replace: replaceCandles, state: { key: OIL_CANDLE_KEY, value: { fetchedAt: stamp, resumeAt: cursor } } }); }
      catch (error) {
        candleError = 'K 线保存失败：monitor.sqlite 写入失败';
        candleSave.failed('monitor.sqlite 写入失败', detail(error)); return;
      }
      resumeAt = cursor; checkedThrough = end; candleRows = next; candles = projection;
      candlesRestored = cursor !== null || !sawBrent || !sawWti;
      replaceCandles = false; start = end; candleError = null;
    }
    if (stopping.signal.aborted) return;
    if (full) gapRetryAt = at + OIL_GAP_RETRY_MS;
    candleSave.recovered(); candleReport.recovered();
  }

  return {
    refreshQuote,
    refreshCandles,
    /** The last quote with its freshness (by the marks' source time); null before any quote exists. */
    quote(): OilQuoteView | null {
      if (!quote) return null;
      const stale = quoteRestored || (readers.epoch && (!quoteEpoch || quoteEpoch !== readers.epoch())) || now() - Date.parse(quote.fetchedAt) > QUOTE_STALE_MS;
      return { ...quote, status: stale ? 'snapshot' : 'live', staleAfterMs: QUOTE_STALE_MS, lastAttemptAt: iso(quoteAttemptAt), lastError: quoteError };
    },
    /** The candles opening within `days` before the last paired bar (null: all of them), with the complete history's range; null before any row exists. */
    candles(days: number | null): OilCandleView | null {
      if (!candles) return null;
      const stale = candlesRestored || candleError !== null || now() - Date.parse(candles.metadata.fetchedAt) > CANDLE_STALE_MS;
      const snapshot: OilIntraday = { ...candles, status: stale ? 'snapshot' : 'live' };
      const { firstCommonObservation, lastCommonObservation, pairedObservationRows } = snapshot.metadata;
      // Cutting a window validates every stored row; it is redone only when a round stored new candles or the freshness changed.
      let window = windows.get(days);
      if (!window || window.source !== candles || window.stale !== stale) {
        window = { source: candles, stale, value: days === null ? snapshot : intradayWindow(snapshot, days) };
        if (windows.size >= 8) windows.clear();
        windows.set(days, window);
      }
      return { coverage: { firstCommonObservation, lastCommonObservation, pairedObservationRows }, ...window.value, lastAttemptAt: iso(candleAttemptAt), lastError: candleError };
    },
    refreshFunding: funding.refresh,
    /** Every stored four-hour settlement since the retention cut; null before any row exists. */
    funding: (): FundingView<OilFundingRow> | null => funding.view(),
    /** For the status page. */
    status() {
      return { quoteAt: quote?.fetchedAt ?? null, quoteError, candlesAt: candles?.metadata.fetchedAt ?? null, candleRows: candles?.data.length ?? 0, candleError, ...funding.status() };
    },
    /** The three loops; a round starts only after the previous one of its loop ended and the interval passed. */
    loops(context: LoopContext): Promise<void>[] {
      const every = (intervalMs: number, name: string, round: () => Promise<void>) => (async () => {
        while (!context.stopped()) {
          try { await round(); } catch (error) { log(`原油${name}出错：${detail(error)}`); }
          if (context.stopped()) break;
          await context.pause(intervalMs);
        }
      })();
      return [every(OIL_QUOTE_REFRESH_MS, '报价', refreshQuote), every(OIL_CANDLE_REFRESH_MS, ' K 线', refreshCandles), every(FUNDING_REFRESH_MS, '资金费', funding.refresh)];
    },
    /** Cuts the requests in flight short; the loops then end at their next stop check. */
    stop(): void { stopping.abort(); },
  };
}
export type OilMonitor = ReturnType<typeof createOilMonitor>;
