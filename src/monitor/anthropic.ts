// Monitor M-1: the Anthropic premium collector. Two loops read the four public legs through the vendored workbench module
// (quotes every 10 s, completed 15-minute candles every 60 s); every request carries its own timeout there and is never
// retried within a round. A failed round only keeps what was there and says why. The last quote and the candle history
// are kept in monitor.sqlite and read back at start, marked as a snapshot until a round succeeds.
import {
  ANTHROPIC_CANDLE_REFRESH_MS, ANTHROPIC_INITIAL_DAYS, ANTHROPIC_LEG_KEYS, ANTHROPIC_QUOTE_REFRESH_MS, ANTHROPIC_RETENTION_DAYS,
  anthropicCandleWindow, createAnthropicCandles, createBinanceGate, createRhLighterState, fetchAnthropicCandles, fetchAnthropicQuote, legError, validateAnthropicQuote,
  type AnthropicCandleCoverage, type AnthropicCandles, type BinanceGate, type AnthropicCandleWindow, type AnthropicFetcher, type AnthropicQuote,
} from '../vendor/anthropic-market.mjs';
import type { MonitorStore } from './store.ts';

/** A quote older than this (by local receipt time) is shown as a snapshot; the venues give no source time for a mark. */
export const QUOTE_STALE_MS = 35_000;
/** The workbench's stored-candle age limit: about ten missed candle rounds. */
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

/** The largest reply read from a venue: a full candle page is well under 1 MiB, and the vendor module only limits Lighter RH itself. */
export const MAX_REPLY_BYTES = 8 * 1024 * 1024;
/** The reply with its body cut off (as a read error) once it passes MAX_REPLY_BYTES, so an oversized answer is never parsed whole in the trading process. */
export function boundedReply(response: Response): Response {
  const length = Number(response.headers.get('content-length'));
  if (length > MAX_REPLY_BYTES) { void response.body?.cancel().catch(() => undefined); throw new Error('交易所应答超过大小上限'); }
  if (!response.body) return response;
  let size = 0;
  const counted = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > MAX_REPLY_BYTES) controller.error(new Error('交易所应答超过大小上限'));
      else controller.enqueue(chunk);
    },
  }));
  return new Response(counted, { status: response.status, statusText: response.statusText, headers: response.headers });
}

const iso = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString();
const detail = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);

export function createAnthropicMonitor({ store, gate = createBinanceGate(), fetchImpl = fetch, now = Date.now, log = line => process.stderr.write(`${line}\n`) }: {
  store: MonitorStore;
  /** The Binance cooldown; the service passes the one it shares with the oil monitor (same address, same limits). */
  gate?: BinanceGate;
  fetchImpl?: AnthropicFetcher; now?: () => number; log?: (line: string) => void;
}) {
  const stopping = new AbortController();
  // The vendor module puts its own timeout on every request; the stop signal is added so a shutdown does not wait one out.
  const fetcher: AnthropicFetcher = async (url, init) => boundedReply(await fetchImpl(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, stopping.signal]) : stopping.signal }));
  // Per service rather than the module's shared ones: the cooldowns and the Lighter RH market id belong to this service.
  const rh = createRhLighterState();

  let quote: AnthropicQuote | null = null, quoteRestored = false, quoteAttemptAt: number | null = null, quoteError: string | null = null;
  let candles: AnthropicCandles | null = null, candlesRestored = false, candleAttemptAt: number | null = null, candleError: string | null = null;
  // The stored rows could not be read back: the next successful round rewrites the table instead of adding to it.
  let replaceCandles = false;
  const windows = new Map<number | null, { source: AnthropicCandles; stale: boolean; value: AnthropicCandles | AnthropicCandleWindow }>();

  try {
    const saved = store.readState(QUOTE_KEY);
    if (saved) { quote = validateAnthropicQuote(saved.value); quoteRestored = true; }
  } catch (error) { log(`Anthropic 上次报价无法读回，等待新报价：${detail(error)}`); }
  try {
    const rows = store.candles();
    if (rows.length) {
      const saved = store.readState(CANDLE_KEY);
      if (!saved) throw new Error('K 线轮次记录缺失');
      const round = saved.value as { fetchedAt?: unknown; errors?: unknown };
      candles = createAnthropicCandles(rows, round.fetchedAt as string, 'snapshot', round.errors ?? {});
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
    try { next = await fetchAnthropicQuote({ fetcher, now: at, gate, rh, clock: now }); }
    catch (error) {
      if (stopping.signal.aborted) return;
      // Only thrown when no leg answered (or a reply fails validation); the last quote stays and turns into a snapshot.
      quoteError = /No Anthropic quote/.test(detail(error)) ? '四条腿都没有取到报价' : legError(error);
      quoteReport.failed(quoteError, detail(error));
      return;
    }
    // A stop that cut some legs short still returns the others: such a round is dropped, not stored over a complete one.
    if (stopping.signal.aborted) return;
    quote = next; quoteRestored = false; quoteError = null;
    quoteReport.recovered();
    try { store.writeState(QUOTE_KEY, next); quoteSave.recovered(); }
    catch (error) { quoteSave.failed('monitor.sqlite 写入失败', detail(error)); }
  }

  async function refreshCandles(): Promise<void> {
    const at = now();
    candleAttemptAt = at;
    let next: AnthropicCandles;
    try { next = await fetchAnthropicCandles(candles, { fetcher, now: at, gate, rh, clock: now }); }
    catch (error) {
      if (stopping.signal.aborted) return;
      candleError = `K 线读取失败：${legError(error)}`;
      candleReport.failed(candleError, detail(error));
      return;
    }
    if (stopping.signal.aborted) return;
    candleReport.recovered();
    const previous = new Map((candles?.data ?? []).map(row => [row.time, row]));
    const changed = replaceCandles ? next.data : next.data.filter(row => {
      const old = previous.get(row.time);
      return !old || ANTHROPIC_LEG_KEYS.some(key => old[key] !== row[key]);
    });
    try {
      store.writeCandles({ rows: changed, cutoff: at - ANTHROPIC_RETENTION_DAYS * DAY_MS, replace: replaceCandles, state: { key: CANDLE_KEY, value: { fetchedAt: next.metadata.fetchedAt, errors: next.metadata.errors } } });
    } catch (error) {
      // Memory stays with what is stored, so the next round reads on from there and writes the same rows again.
      candleError = 'K 线保存失败：monitor.sqlite 写入失败';
      candleSave.failed('monitor.sqlite 写入失败', detail(error));
      return;
    }
    candleSave.recovered();
    candles = next; candlesRestored = false; candleError = null; replaceCandles = false;
  }

  return {
    refreshQuote,
    refreshCandles,
    /** The last quote with its freshness; null before any quote exists. */
    quote(): AnthropicQuoteView | null {
      if (!quote) return null;
      const stale = quoteRestored || now() - Date.parse(quote.fetchedAt) > QUOTE_STALE_MS;
      return { ...quote, status: stale ? 'snapshot' : 'live', staleAfterMs: QUOTE_STALE_MS, lastAttemptAt: iso(quoteAttemptAt), lastError: quoteError };
    },
    /** The candles opening within `days` before the last row (null: all of them), with the complete history's range; null before any row exists. */
    candles(days: number | null): AnthropicCandleView | null {
      if (!candles) return null;
      const stale = candlesRestored || candleError !== null || now() - Date.parse(candles.metadata.fetchedAt) > CANDLE_STALE_MS;
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
