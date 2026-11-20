// Monitor M-1: the Anthropic premium collector. Two loops read the four public legs through the vendored workbench module
// (quotes every 10 s, completed 15-minute candles every 60 s); every request carries its own timeout there and is never
// retried within a round. A failed round only keeps what was there and says why. The last quote and the candle history
// are kept in monitor.sqlite and read back at start, marked as a snapshot until a round succeeds.
import {
  ANTHROPIC_CANDLE_MS, ANTHROPIC_CANDLE_REFRESH_MS, ANTHROPIC_INITIAL_DAYS, ANTHROPIC_LEG_KEYS, ANTHROPIC_QUOTE_REFRESH_MS, ANTHROPIC_RETENTION_DAYS,
  anthropicCandleWindow, createAnthropicCandles, createBinanceGate, mergeAnthropicCandleBatch, legError, validateAnthropicQuote,
  type AnthropicCandleCoverage, type AnthropicCandles, type BinanceGate, type AnthropicCandleWindow, type AnthropicFetcher, type AnthropicQuote, type AnthropicLegKey, type AnthropicLegErrors,
} from '../vendor/anthropic-market.mjs';
import { createMarketReaders, type MarketReaders } from './market-readers.ts';
import { afterCandleRange, candleCheckOverdue, candleCoverage, nextCandleRange, type CandleCoverage } from './candle-coverage.ts';
import type { MonitorStore } from './store.ts';

/** A quote older than this (by local receipt time) is shown as a snapshot; the venues give no source time for a mark. */
export const QUOTE_STALE_MS = 35_000;
/** Grace for receiving a newly closed bar before the candle view falls back to a snapshot. */
export const CANDLE_STALE_MS = 615_000;
const DAY_MS = 86_400_000;
export const QUOTE_KEY = 'anthropic.quote';
export const CANDLE_KEY = 'anthropic.candles';

export interface AnthropicQuoteView extends AnthropicQuote {
  status: 'live' | 'snapshot';
  staleAfterMs: number;
  lastAttemptAt: string | null;
  lastError: string | null;
}
export type AnthropicCandleView = AnthropicCandleWindow & { coverage: AnthropicCandleCoverage; lastAttemptAt: string | null; lastError: string | null };
export interface LoopContext { stopped(): boolean; pause(ms: number): Promise<void> }

export { boundedReply, MAX_REPLY_BYTES } from './market-contract.ts';

const iso = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString();
const detail = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);
const perLeg = <T>(value: (leg: AnthropicLegKey) => T): Record<AnthropicLegKey, T> =>
  Object.fromEntries(ANTHROPIC_LEG_KEYS.map(leg => [leg, value(leg)])) as Record<AnthropicLegKey, T>;

export function createAnthropicMonitor({ store, gate = createBinanceGate(), fetchImpl = fetch, now = Date.now, readers = createMarketReaders({ fetchImpl, now, gate }), log = line => process.stderr.write(`${line}\n`) }: {
  store: MonitorStore;
  /** The Binance cooldown; the service passes the one it shares with the oil monitor (same address, same limits). */
  gate?: BinanceGate; readers?: MarketReaders;
  fetchImpl?: AnthropicFetcher; now?: () => number; log?: (line: string) => void;
}) {
  const stopping = new AbortController();

  let quoteEpoch: string | null = null;
  let quote: AnthropicQuote | null = null, quoteRestored = false, quoteAttemptAt: number | null = null, quoteError: string | null = null;
  let candles: AnthropicCandles | null = null, candlesRestored = false, candleAttemptAt: number | null = null, candleError: string | null = null;
  // The stored rows could not be read back: the next successful round rewrites the table instead of adding to it.
  let replaceCandles = false;
  let progress = perLeg(() => candleCoverage(null, 0, ANTHROPIC_CANDLE_MS, 0));
  let legErrors: AnthropicLegErrors = {};
  const windows = new Map<number | null, { source: AnthropicCandles; stale: boolean; value: AnthropicCandles | AnthropicCandleWindow }>();

  try {
    const saved = store.readState(QUOTE_KEY);
    if (saved) { quote = validateAnthropicQuote(saved.value); quoteRestored = true; }
  } catch (error) { log(`Anthropic 上次报价无法读回，等待新报价：${detail(error)}`); }
  try {
    const rows = store.candles();
    const saved = store.readState(CANDLE_KEY);
    if (rows.length || saved) {
      if (!saved) throw new Error('K 线轮次记录缺失');
      const round = saved.value as { fetchedAt: string; errors?: AnthropicLegErrors; coverage?: Partial<Record<AnthropicLegKey, CandleCoverage>> };
      const fetched = Date.parse(round.fetchedAt);
      if (!Number.isFinite(fetched)) throw new Error('K 线轮次时间无效');
      const restored = rows.length ? createAnthropicCandles(rows, round.fetchedAt, 'snapshot', round.errors ?? {}) : null;
      progress = perLeg(key => {
        const last = rows.findLast(row => row[key] !== null);
        return candleCoverage(round.coverage?.[key], last ? last.time + ANTHROPIC_CANDLE_MS : 0, ANTHROPIC_CANDLE_MS, fetched);
      });
      candles = restored; legErrors = round.errors ?? {};
      candlesRestored = true;
    }
  } catch (error) { replaceCandles = true; log(`Anthropic K 线历史无法读回，将从 ${ANTHROPIC_INITIAL_DAYS} 天前重新回补：${detail(error)}`); }

  /** Logs a failure when its text changes and the recovery once, so an outage does not write a line every round. */
  const reporter = (name: string) => {
    let last: string | null = null;
    return {
      failed(text: string, cause: string): void { if (text !== last) log(`Anthropic ${name}失败：${text}（${cause}）`); last = text; },
      recovered(): void { if (last !== null) log(`Anthropic ${name}已恢复`); last = null; },
    };
  };
  const quoteReport = reporter('报价读取'), quoteSave = reporter('报价保存'), candleReport = reporter('K 线读取'), candleSave = reporter('K 线保存');

  async function refreshQuote(): Promise<void> {
    const at = now();
    quoteAttemptAt = at;
    let next: AnthropicQuote;
    try { next = await readers.anthropicQuote(stopping.signal); }
    catch (error) {
      if (stopping.signal.aborted) return;
      // Only thrown when no leg answered (or a reply fails validation); the last quote stays and turns into a snapshot.
      quoteError = /No Anthropic quote/.test(detail(error)) ? '四条腿都没有取到报价' : legError(error);
      quoteReport.failed(quoteError, detail(error));
      return;
    }
    // A stop that cut some legs short still returns the others: such a round is dropped, not stored over a complete one.
    if (stopping.signal.aborted) return;
    quote = next; quoteEpoch = readers.epoch?.() ?? null; quoteRestored = false; quoteError = null;
    quoteReport.recovered();
    try { store.writeState(QUOTE_KEY, next); quoteSave.recovered(); }
    catch (error) { quoteSave.failed('monitor.sqlite 写入失败', detail(error)); }
  }

  async function refreshCandles(): Promise<void> {
    const at = now();
    const step = ANTHROPIC_CANDLE_MS, target = Math.floor(at / step) * step;
    const rows = candles?.data ?? [];
    const work = perLeg(key => {
      const sourceFloor = target - ((key === 'xyz' || key === 'io') ? ANTHROPIC_INITIAL_DAYS : ANTHROPIC_RETENTION_DAYS) * DAY_MS;
      const first = progress[key].through ? Math.max(sourceFloor, rows.find(row => row[key] !== null)?.time ?? target - ANTHROPIC_INITIAL_DAYS * DAY_MS)
        : target - ANTHROPIC_INITIAL_DAYS * DAY_MS;
      return nextCandleRange(progress[key], rows, row => row[key] !== null, first, step, at);
    });
    if (ANTHROPIC_LEG_KEYS.every(key => !work[key])) { candlesRestored = false; return; }
    candleAttemptAt = at;
    const nextProgress = { ...progress }, errors = { ...legErrors };
    let next: AnthropicCandles | null;
    try {
      const batch = await readers.anthropicCandles(perLeg(key => work[key]?.start ?? target), at, stopping.signal, perLeg(key => work[key]?.end ?? target));
      if (stopping.signal.aborted) return;
      for (const key of ANTHROPIC_LEG_KEYS) {
        const range = work[key];
        if (!range) continue;
        if (batch.errors[key]) { errors[key] = batch.errors[key]; continue; }
        const end = batch.through?.[key], values = batch.legs[key];
        if (!values || end === undefined || !Number.isSafeInteger(end) || end % step || end <= range.start || end > range.end
          || values.some(([time]) => time < range.start || time >= end)) throw new Error('K 线回补进度无效');
        nextProgress[key] = afterCandleRange(progress[key], range, end, at);
        delete errors[key];
      }
      // A failed retry of just the missing legs says nothing new about the healthy, already closed legs.
      if (!ANTHROPIC_LEG_KEYS.some(key => work[key] && !batch.errors[key])) {
        legErrors = errors;
        if (candles) candles = { ...candles, metadata: { ...candles.metadata, errors } };
        else candleError = '本轮请求的行情源均未取得 K 线';
        candlesRestored = false;
        return;
      }
      next = candles || ANTHROPIC_LEG_KEYS.some(key => batch.legs[key]?.length)
        ? mergeAnthropicCandleBatch(candles, { ...batch, errors }) : null;
    }
    catch (error) {
      if (stopping.signal.aborted) return;
      const reason = legError(error);
      candleError = `K 线读取失败：${reason}`;
      candleReport.failed(reason, detail(error));
      return;
    }
    if (stopping.signal.aborted) return;
    candleReport.recovered();
    const previous = new Map((candles?.data ?? []).map(row => [row.time, row]));
    const data = next?.data ?? [];
    const changed = replaceCandles ? data : data.filter(row => {
      const old = previous.get(row.time);
      return !old || ANTHROPIC_LEG_KEYS.some(key => old[key] !== row[key]);
    });
    try {
      store.writeCandles({ rows: changed, cutoff: at - ANTHROPIC_RETENTION_DAYS * DAY_MS, replace: replaceCandles,
        state: { key: CANDLE_KEY, value: { fetchedAt: iso(at), errors, coverage: nextProgress } } });
    } catch (error) {
      // Memory stays with what is stored, so the next round reads on from there and writes the same rows again.
      candleError = 'K 线保存失败：monitor.sqlite 写入失败';
      candleSave.failed('monitor.sqlite 写入失败', detail(error));
      return;
    }
    candleSave.recovered();
    if (next && candles && !changed.length && next.data.length === candles.data.length) next.data = candles.data;
    candles = next; progress = nextProgress; legErrors = errors; candlesRestored = false; candleError = null; replaceCandles = false;
  }

  return {
    refreshQuote,
    refreshCandles,
    /** The last quote with its freshness; null before any quote exists. */
    quote(): AnthropicQuoteView | null {
      if (!quote) return null;
      const stale = quoteRestored || (readers.epoch && (!quoteEpoch || quoteEpoch !== readers.epoch())) || now() - Date.parse(quote.fetchedAt) > QUOTE_STALE_MS;
      return { ...quote, status: stale ? 'snapshot' : 'live', staleAfterMs: QUOTE_STALE_MS, lastAttemptAt: iso(quoteAttemptAt), lastError: quoteError };
    },
    /** The candles opening within `days` before the last row (null: all of them), with the complete history's range; null before any row exists. */
    candles(days: number | null): AnthropicCandleView | null {
      if (!candles) return null;
      const current = now(), lastClose = Date.parse(candles.metadata.lastObservation) + ANTHROPIC_CANDLE_MS;
      const stale = candlesRestored || candleError !== null || candleCheckOverdue(lastClose, ANTHROPIC_CANDLE_MS, current, CANDLE_STALE_MS)
        || ANTHROPIC_LEG_KEYS.every(key => candleCheckOverdue(progress[key].through, ANTHROPIC_CANDLE_MS, current, CANDLE_STALE_MS));
      const snapshot: AnthropicCandles = { ...candles, status: stale ? 'snapshot' : 'live' };
      const { firstObservation, lastObservation, rows } = snapshot.metadata;
      // Cutting a window validates every stored row; it is redone only when a round stored new candles or the freshness changed.
      let window = windows.get(days);
      if (!window || window.source !== candles || window.stale !== stale) {
        window = { source: candles, stale, value: days === null ? snapshot : anthropicCandleWindow(snapshot, days) };
        if (windows.size >= 8) windows.clear();
        windows.set(days, window);
      }
      return { coverage: { firstObservation, lastObservation, rows }, ...window.value, lastAttemptAt: iso(candleAttemptAt), lastError: candleError };
    },
    /** For the status page. */
    status() {
      return { quoteAt: quote?.fetchedAt ?? null, quoteError, candlesAt: candles?.metadata.fetchedAt ?? null, candleRows: candles?.data.length ?? 0, candleError };
    },
    /** The two loops; a round starts only after the previous one of its loop ended and the interval passed. */
    loops(context: LoopContext): Promise<void>[] {
      const every = (intervalMs: number, name: string, round: () => Promise<void>) => (async () => {
        while (!context.stopped()) {
          try { await round(); } catch (error) { log(`Anthropic ${name}出错：${detail(error)}`); }
          if (context.stopped()) break;
          await context.pause(intervalMs);
        }
      })();
      return [every(ANTHROPIC_QUOTE_REFRESH_MS, '报价', refreshQuote), every(ANTHROPIC_CANDLE_REFRESH_MS, 'K 线', refreshCandles)];
    },
    /** Cuts the requests in flight short; the loops then end at their next stop check. */
    stop(): void { stopping.abort(); },
  };
}
export type AnthropicMonitor = ReturnType<typeof createAnthropicMonitor>;
