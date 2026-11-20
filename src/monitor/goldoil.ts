// Monitor M-2f: the gold/oil ratio collector (XAU ÷ WTI and XAU ÷ Brent on Binance XAUUSDT, CLUSDT and BZUSDT marks), laid out
// as the oil collector (oil.ts). Two loops: the three marks every 30 s and the completed 15-minute mark bars every 60 s, both
// read in the market process (market-readers.ts: goldOilQuote / goldOilListing / goldOilCandles) behind the Binance cooldown
// shared with Anthropic and oil. The history starts at the latest of the three listings and is kept 400 days in
// monitor.sqlite (goldoil_candles); the last quote is kept too, and both are read back at start as a snapshot until a round
// succeeds. Every request carries its own timeout and is never retried within a round; a failed round keeps what was there.
import type { BinanceGate } from '../vendor/anthropic-market.mjs';
import type { OilFetcher } from '../vendor/oil-market.mjs';
import { CANDLE_STALE_MS, type LoopContext } from './anthropic.ts';
import { OIL_CANDLE_WINDOW_MS } from './market-contract.ts';
import { createMarketReaders, type MarketReaders } from './market-readers.ts';
import { afterCandleRange, candleCheckOverdue, candleCoverage, nextCandleRange, type CandleCoverage } from './candle-coverage.ts';
import {
  GOLDOIL_CANDLE_MS, GOLDOIL_CANDLE_REFRESH_MS, GOLDOIL_QUOTE_REFRESH_MS, GOLDOIL_STALE_MS, goldOilComplete, goldOilRatio, goldOilSnapshot, goldOilWindow,
  mergeGoldOilRows, validateGoldOilQuote, validateGoldOilRows, type GoldOilCandleRow, type GoldOilCoverage, type GoldOilHistory, type GoldOilQuote,
} from './goldoil-market.ts';
import { oilError } from './oil.ts';
import type { MonitorStore } from './store.ts';

export const GOLDOIL_RETENTION_DAYS = 400;
export const GOLDOIL_QUOTE_KEY = 'goldoil.quote';
export const GOLDOIL_CANDLE_KEY = 'goldoil.candles';
const DAY_MS = 86_400_000;
const MAX_OBSERVATION_AGE = 96 * GOLDOIL_CANDLE_MS;

export interface GoldOilQuoteView extends GoldOilQuote {
  /** XAU ÷ CL and XAU ÷ BZ, barrels per ounce. */
  ratio: { cl: number; bz: number };
  status: 'live' | 'snapshot';
  staleAfterMs: number;
  lastAttemptAt: string | null;
  lastError: string | null;
}
export type GoldOilCandleView = GoldOilHistory & { coverage: GoldOilCoverage; lastAttemptAt: string | null; lastError: string | null };
interface SavedCandles { fetchedAt: string; listedAt: number | null; resumeAt: number | null; coverage: CandleCoverage }

const iso = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString();
const detail = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);
/** oilError, with the gold/oil checks named (the reasons the page shows). */
export function goldOilError(error: unknown): string {
  const message = String((error as { message?: unknown } | null)?.message ?? '');
  if (message.includes('not synchronized')) return '三条腿的报价时间相差超过 15 秒，本轮不采用';
  if (message.includes('Delayed or unexpected')) return '报价源时间过旧或合约不符';
  if (message.includes('Unsupported Binance gold/oil contract')) return '合约类型、状态或计价资产不符';
  if (message.includes('listing date')) return '合约上架时间无效';
  return oilError(error);
}
const boundary = (value: unknown, fetched: number) => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) % GOLDOIL_CANDLE_MS === 0 && (value as number) <= fetched;

export function createGoldOilMonitor({ store, gate, fetchImpl = fetch, now = Date.now, readers = createMarketReaders({ fetchImpl, now, gate }), log = line => process.stderr.write(`${line}\n`) }: {
  store: MonitorStore;
  /** The Binance cooldown, shared with the Anthropic and oil monitors: all read Binance from the same address. */
  gate: BinanceGate; readers?: MarketReaders;
  fetchImpl?: OilFetcher; now?: () => number; log?: (line: string) => void;
}) {
  const stopping = new AbortController();
  let quoteEpoch: string | null = null;
  let quote: GoldOilQuote | null = null, quoteRestored = false, quoteAttemptAt: number | null = null, quoteError: string | null = null;
  let rows: GoldOilCandleRow[] = [], history: GoldOilHistory | null = null, candlesRestored = false, candleAttemptAt: number | null = null, candleError: string | null = null;
  let listedAt: number | null = null, replaceCandles = false, resumeAt: number | null = null;
  let progress = candleCoverage(null, 0, GOLDOIL_CANDLE_MS, 0);
  const windows = new Map<number | null, { source: GoldOilHistory; stale: boolean; value: GoldOilHistory }>();

  try {
    const saved = store.readState(GOLDOIL_QUOTE_KEY);
    if (saved) { quote = validateGoldOilQuote(saved.value); quoteRestored = true; }
  } catch (error) { log(`金油比上次报价无法读回，等待新报价：${detail(error)}`); }
  try {
    const stored = store.goldOilCandles(), saved = store.readState(GOLDOIL_CANDLE_KEY);
    if (stored.length || saved) {
      if (!saved) throw new Error('K 线轮次记录缺失');
      const state = saved.value as SavedCandles, fetched = Date.parse(state.fetchedAt);
      const checked = validateGoldOilRows(stored, state.fetchedAt);
      if (state.resumeAt !== null && !boundary(state.resumeAt, fetched)) throw new Error('K 线回补进度无效');
      if (state.listedAt !== null && !boundary(state.listedAt, fetched)) throw new Error('上架时间无效');
      progress = candleCoverage(state.coverage, state.resumeAt ?? Math.floor(fetched / GOLDOIL_CANDLE_MS) * GOLDOIL_CANDLE_MS, GOLDOIL_CANDLE_MS, fetched);
      rows = checked; listedAt = state.listedAt; resumeAt = state.resumeAt; history = goldOilSnapshot(rows, state.fetchedAt, listedAt); candlesRestored = true;
    }
  } catch (error) { replaceCandles = true; log(`金油比 K 线历史无法读回，将从三个合约的共同上架时间重新回补：${detail(error)}`); }

  /** Logs a failure when its text changes and the recovery once, so an outage does not write a line every round. */
  const reporter = (name: string) => {
    let last: string | null = null;
    return {
      failed(text: string, cause: string): void { if (text !== last) log(`金油比${name}失败：${text}（${cause}）`); last = text; },
      recovered(): void { if (last !== null) log(`金油比${name}已恢复`); last = null; },
    };
  };
  const quoteReport = reporter('报价读取'), quoteSave = reporter('报价保存'), candleReport = reporter('K 线读取'), candleSave = reporter('K 线保存');

  async function refreshQuote(): Promise<void> {
    quoteAttemptAt = now();
    let next: GoldOilQuote;
    try { next = validateGoldOilQuote(await readers.goldOilQuote(stopping.signal)); }
    catch (error) {
      if (stopping.signal.aborted) return;
      quoteError = goldOilError(error);
      quoteReport.failed(quoteError, detail(error));
      return;
    }
    if (stopping.signal.aborted) return;
    quote = next; quoteEpoch = readers.epoch?.() ?? null; quoteRestored = false; quoteError = null;
    quoteReport.recovered();
    try { store.writeState(GOLDOIL_QUOTE_KEY, next); quoteSave.recovered(); }
    catch (error) { quoteSave.failed('monitor.sqlite 写入失败', detail(error)); }
  }

  async function refreshCandles(): Promise<void> {
    const at = now();
    // The listing is re-read every round (cached 5 minutes where the reads run): a contract delisted or changed stops the backfill.
    let listing: number;
    try { listing = await readers.goldOilListing(stopping.signal); }
    catch (error) {
      if (stopping.signal.aborted) return;
      const reason = goldOilError(error);
      candleAttemptAt = at; candleError = `合约信息读取失败：${reason}`;
      candleReport.failed(`合约信息 ${reason}`, detail(error));
      return;
    }
    if (stopping.signal.aborted) return;
    const cutoff = at - GOLDOIL_RETENTION_DAYS * DAY_MS;
    const first = Math.max(listing, Math.ceil(cutoff / GOLDOIL_CANDLE_MS) * GOLDOIL_CANDLE_MS);
    const work = nextCandleRange(progress, rows, goldOilComplete, first, GOLDOIL_CANDLE_MS, at);
    if (!work) { candlesRestored = false; listedAt = listing; return; }
    candleAttemptAt = at;
    const target = work.end, stamp = new Date(at).toISOString();
    let start = Math.max(first, resumeAt ?? work.start);
    while (start < target && !stopping.signal.aborted) {
      const end = Math.min(start + OIL_CANDLE_WINDOW_MS, target);
      let next: GoldOilCandleRow[], changed: GoldOilCandleRow[];
      try {
        const batch = validateGoldOilRows(await readers.goldOilCandles(start, end, stopping.signal), new Date(end).toISOString());
        if (stopping.signal.aborted) return;
        if (batch.some(row => row.time < start)) throw new Error('金油比 K 线超出本轮范围');
        next = mergeGoldOilRows(rows, batch).filter(row => row.time >= cutoff && row.time >= listing);
        const previous = new Map(rows.map(row => [row.time, row]));
        changed = replaceCandles ? next : next.filter(row => {
          const old = previous.get(row.time);
          return !old || old.xau !== row.xau || old.wti !== row.wti || old.brent !== row.brent;
        });
      } catch (error) {
        if (stopping.signal.aborted) return;
        const reason = goldOilError(error);
        candleError = `K 线读取失败：${reason}`;
        candleReport.failed(reason, detail(error));
        return;
      }
      // The segment, its resume cursor and the listing are committed together; a failed write retries this exact segment.
      const cursor = work.kind === 'tail' && end < target ? end : null;
      const nextCoverage = afterCandleRange(progress, work, end, at);
      const state: SavedCandles = { fetchedAt: stamp, listedAt: listing, resumeAt: cursor, coverage: nextCoverage };
      try { store.writeGoldOilCandles({ rows: changed, cutoff: Math.max(cutoff, listing), replace: replaceCandles, state: { key: GOLDOIL_CANDLE_KEY, value: state } }); }
      catch (error) {
        candleError = 'K 线保存失败：monitor.sqlite 写入失败';
        candleSave.failed('monitor.sqlite 写入失败', detail(error)); return;
      }
      const projection = goldOilSnapshot(next, stamp, listing);
      if (projection && history && !changed.length && projection.data.length === history.data.length) projection.data = history.data;
      resumeAt = cursor; progress = nextCoverage; rows = next; history = projection; listedAt = listing;
      candlesRestored = cursor !== null;
      replaceCandles = false; start = end; candleError = null;
    }
    if (stopping.signal.aborted) return;
    candleSave.recovered(); candleReport.recovered();
  }

  return {
    refreshQuote,
    refreshCandles,
    /** The last quote with both ratios and its freshness (by the earliest leg's source time); null before any quote exists. */
    quote(): GoldOilQuoteView | null {
      if (!quote) return null;
      const stale = quoteRestored || (readers.epoch && (!quoteEpoch || quoteEpoch !== readers.epoch())) || now() - Date.parse(quote.fetchedAt) > GOLDOIL_STALE_MS;
      return { ...quote, ratio: { cl: goldOilRatio(quote, 'cl'), bz: goldOilRatio(quote, 'bz') }, status: stale ? 'snapshot' : 'live', staleAfterMs: GOLDOIL_STALE_MS, lastAttemptAt: iso(quoteAttemptAt), lastError: quoteError };
    },
    /** The observed rows opening within `days` before the last one (null: all), with the whole history's range; null before any. */
    candles(days: number | null): GoldOilCandleView | null {
      if (!history) return null;
      const current = now(), lastClosedBoundary = Math.floor(current / GOLDOIL_CANDLE_MS) * GOLDOIL_CANDLE_MS;
      const stale = candlesRestored || candleError !== null || candleCheckOverdue(progress.through, GOLDOIL_CANDLE_MS, current, CANDLE_STALE_MS)
        || Date.parse(history.metadata.lastObservation) < lastClosedBoundary - MAX_OBSERVATION_AGE;
      const snapshot: GoldOilHistory = { ...history, status: stale ? 'snapshot' : 'live' };
      const { firstObservation, lastObservation, observationRows } = snapshot.metadata;
      let window = windows.get(days);
      if (!window || window.source !== history || window.stale !== stale) {
        window = { source: history, stale, value: days === null ? snapshot : goldOilWindow(snapshot, days) };
        if (windows.size >= 8) windows.clear();
        windows.set(days, window);
      }
      return { coverage: { firstObservation, lastObservation, observationRows }, ...window.value, lastAttemptAt: iso(candleAttemptAt), lastError: candleError };
    },
    /** For the status page. */
    status() {
      return { quoteAt: quote?.fetchedAt ?? null, quoteError, candlesAt: history?.metadata.fetchedAt ?? null, candleRows: history?.data.length ?? 0, candleError, listedAt: iso(listedAt) };
    },
    /** The two loops; a round starts only after the previous one of its loop ended and the interval passed. */
    loops(context: LoopContext): Promise<void>[] {
      const every = (intervalMs: number, name: string, round: () => Promise<void>) => (async () => {
        while (!context.stopped()) {
          try { await round(); } catch (error) { log(`金油比${name}出错：${detail(error)}`); }
          if (context.stopped()) break;
          await context.pause(intervalMs);
        }
      })();
      return [every(GOLDOIL_QUOTE_REFRESH_MS, '报价', refreshQuote), every(GOLDOIL_CANDLE_REFRESH_MS, ' K 线', refreshCandles)];
    },
    /** Cuts the requests in flight short; the loops then end at their next stop check. */
    stop(): void { stopping.abort(); },
  };
}
export type GoldOilMonitor = ReturnType<typeof createGoldOilMonitor>;
