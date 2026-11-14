// Monitor M-2a: the oil spread collector (Brent − WTI on Binance BZUSDT / CLUSDT). Two loops: the two marks and the funding
// terms every 10 s, completed 15-minute candles every 60 s through the vendored workbench module. Every request carries its
// own timeout and is never retried within a round; a failed round keeps what was there and says why. The last quote and the
// candles are kept in monitor.sqlite and read back at start, marked as a snapshot until a round succeeds.
import {
  ASSETS, OIL_CANDLE_REFRESH_MS, createIntradaySnapshot, fetchIntradaySnapshot, intradayWindow, requestBinance, validateMarket,
  type OilCoverage, type OilFetcher, type OilIntraday, type OilIntradayWindow, type OilMarket,
} from '../vendor/oil-market.mjs';
import type { BinanceGate } from '../vendor/anthropic-market.mjs';
import { CANDLE_STALE_MS, QUOTE_STALE_MS, boundedReply, type LoopContext } from './anthropic.ts';
import type { MonitorStore } from './store.ts';

export const OIL_QUOTE_REFRESH_MS = 10_000;
export const OIL_RETENTION_DAYS = 400;
export const OIL_QUOTE_KEY = 'oil.quote';
export const OIL_CANDLE_KEY = 'oil.candles';
const QUOTE_TIMEOUT_MS = 10_000, CANDLE_TIMEOUT_MS = 15_000, DAY_MS = 86_400_000;
/** The workbench's limits (lib/exchange-service.ts parseBinanceQuote): a mark's source time near this clock, both legs close together. */
const SOURCE_PAST_MS = 120_000, SOURCE_FUTURE_MS = 60_000, LEG_SKEW_MS = 15_000;

export interface OilQuoteView extends OilMarket {
  status: 'live' | 'snapshot';
  staleAfterMs: number;
  lastAttemptAt: string | null;
  lastError: string | null;
}
export type OilCandleView = OilIntradayWindow & { coverage: OilCoverage; lastAttemptAt: string | null; lastError: string | null };

class BinanceCooldown extends Error {
  readonly status: number;
  constructor(status: number) { super(`Binance HTTP ${status} cooldown`); this.status = status; }
}

/** Short Chinese reason for a failed read; never echoes upstream bodies. */
export function oilError(error: unknown): string {
  if (error instanceof BinanceCooldown) return `接口限流冷却中（HTTP ${error.status}）`;
  const value = error as { name?: string; message?: unknown } | null;
  const http = /HTTP (\d{3})/.exec(String(value?.message ?? ''));
  if (http) return http[1] === '451' ? '服务器所在地区被拒绝访问（HTTP 451）' : `接口返回 HTTP ${http[1]}`;
  if (value?.name === 'TimeoutError' || value?.name === 'AbortError') return '请求超时';
  return '响应无效或网络失败';
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Binance object'); return value as Json; };
const finite = (value: unknown): number => {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '' || !Number.isFinite(Number(value))) throw new Error('Invalid Binance number');
  return Number(value);
};
const optional = (value: unknown): number | null => { try { return finite(value); } catch { return null; } };

/**
 * The workbench's parseBinanceQuote for the oil pair, on the two per-symbol premiumIndex replies instead of the whole market
 * (and without the contract catalog). Funding terms missing on either leg leave both legs' rates empty; the prices stand.
 */
export function parseOilQuote(brentTicker: unknown, wtiTicker: unknown, fundingInfo: unknown, now: number): OilMarket {
  const funding = fundingInfo === null ? [] : (() => { if (!Array.isArray(fundingInfo)) throw new Error('Invalid Binance funding list'); return fundingInfo.map(record); })();
  const sources: number[] = [];
  const leg = (input: unknown, symbol: string) => {
    const ticker = record(input);
    if (ticker.symbol !== symbol) throw new Error('Unexpected Binance symbol');
    const source = finite(ticker.time);
    if (!Number.isSafeInteger(source) || source < now - SOURCE_PAST_MS || source > now + SOURCE_FUTURE_MS) throw new Error('Delayed or invalid Binance quote');
    sources.push(source);
    const specs = funding.filter(item => item.symbol === symbol);
    if (specs.length > 1) throw new Error('Duplicate funding metadata');
    const hours = optional(specs[0]?.fundingIntervalHours), rate = optional(ticker.lastFundingRate), next = optional(ticker.nextFundingTime);
    return {
      coin: symbol, markPx: finite(ticker.markPrice),
      fundingRate: rate !== null && Math.abs(rate) <= 1 ? rate : null,
      fundingIntervalHours: hours !== null && Number.isInteger(hours) && hours > 0 && hours <= 24 ? hours : null,
      nextFundingAt: next !== null && next >= source - 60_000 && next <= now + 25 * 3_600_000 ? new Date(next).toISOString() : null,
    };
  };
  let brent = leg(brentTicker, ASSETS.brent.coin), wti = leg(wtiTicker, ASSETS.wti.coin);
  if (Math.abs(sources[0]! - sources[1]!) > LEG_SKEW_MS) throw new Error('Binance oil legs are not synchronized');
  // Missing current settlement terms must not make up a funding estimate.
  if (![brent, wti].every(item => item.fundingRate !== null && item.fundingIntervalHours !== null && item.nextFundingAt !== null)) {
    brent = { ...brent, fundingRate: null }; wti = { ...wti, fundingRate: null };
  }
  return validateMarket({ source: 'Binance', currency: 'USDT', fetchedAt: new Date(Math.min(...sources)).toISOString(), brent, wti });
}

const iso = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString();
const detail = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);

export function createOilMonitor({ store, gate, fetchImpl = fetch, now = Date.now, log = line => process.stderr.write(`${line}\n`) }: {
  store: MonitorStore;
  /** The Binance cooldown, shared with the Anthropic monitor: both read Binance from the same address. */
  gate: BinanceGate;
  fetchImpl?: OilFetcher; now?: () => number; log?: (line: string) => void;
}) {
  const stopping = new AbortController();
  // The vendor module (and readQuote) put a timeout on every request; the stop signal is added so a shutdown does not wait
  // one out. A 429 or 418 starts the cooldown, during which nothing is sent to Binance.
  const fetcher: OilFetcher = async (url, init) => {
    if (now() < gate.until) throw new BinanceCooldown(gate.status);
    const response = boundedReply(await fetchImpl(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, stopping.signal]) : stopping.signal }));
    if (response.status === 429 || response.status === 418) {
      gate.until = Math.max(gate.until, now() + (response.status === 418 ? 120_000 : 60_000)); gate.status = response.status;
    }
    return response;
  };

  let quote: OilMarket | null = null, quoteRestored = false, quoteAttemptAt: number | null = null, quoteError: string | null = null;
  let candles: OilIntraday | null = null, candlesRestored = false, candleAttemptAt: number | null = null, candleError: string | null = null;
  // The stored rows could not be read back: the next successful round rewrites the table instead of adding to it.
  let replaceCandles = false;
  const windows = new Map<number | null, { source: OilIntraday; stale: boolean; value: OilIntraday | OilIntradayWindow }>();

  try {
    const saved = store.readState(OIL_QUOTE_KEY);
    if (saved) { quote = validateMarket(saved.value); quoteRestored = true; }
  } catch (error) { log(`原油上次报价无法读回，等待新报价：${detail(error)}`); }
  try {
    const rows = store.oilCandles();
    if (rows.length) {
      const saved = store.readState(OIL_CANDLE_KEY);
      if (!saved) throw new Error('K 线轮次记录缺失');
      candles = createIntradaySnapshot(rows, (saved.value as { fetchedAt?: unknown }).fetchedAt as string, 'snapshot');
      candlesRestored = true;
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

  async function readQuote(): Promise<OilMarket> {
    const options = { fetcher, timeout: QUOTE_TIMEOUT_MS };
    const [brent, wti, funding] = await Promise.all([
      requestBinance('/fapi/v1/premiumIndex', { symbol: ASSETS.brent.coin }, options),
      requestBinance('/fapi/v1/premiumIndex', { symbol: ASSETS.wti.coin }, options),
      // The funding terms are optional: without them the prices still count.
      requestBinance('/fapi/v1/fundingInfo', {}, options).catch(() => null),
    ]);
    return parseOilQuote(brent, wti, funding, now());
  }

  async function refreshQuote(): Promise<void> {
    quoteAttemptAt = now();
    let next: OilMarket;
    try { next = await readQuote(); }
    catch (error) {
      if (stopping.signal.aborted) return;
      quoteError = oilError(error);
      quoteReport.failed(quoteError, detail(error));
      return;
    }
    if (stopping.signal.aborted) return;
    quote = next; quoteRestored = false; quoteError = null;
    quoteReport.recovered();
    try { store.writeState(OIL_QUOTE_KEY, next); quoteSave.recovered(); }
    catch (error) { quoteSave.failed('monitor.sqlite 写入失败', detail(error)); }
  }

  async function refreshCandles(): Promise<void> {
    const at = now();
    candleAttemptAt = at;
    const cutoff = at - OIL_RETENTION_DAYS * DAY_MS;
    let next: OilIntraday;
    try {
      next = await fetchIntradaySnapshot(candles, { fetcher, now: at, timeout: CANDLE_TIMEOUT_MS });
      // The kept history ends at the retention cut in memory as in the file.
      if (next.data[0]!.time < cutoff) next = createIntradaySnapshot(next.data.filter(row => row.time >= cutoff), next.metadata.fetchedAt);
    } catch (error) {
      if (stopping.signal.aborted) return;
      candleError = `K 线读取失败：${oilError(error)}`;
      candleReport.failed(candleError, detail(error));
      return;
    }
    if (stopping.signal.aborted) return;
    candleReport.recovered();
    const previous = new Map((candles?.data ?? []).map(row => [row.time, row]));
    const changed = replaceCandles ? next.data : next.data.filter(row => {
      const old = previous.get(row.time);
      return !old || old.brent !== row.brent || old.wti !== row.wti;
    });
    try {
      store.writeOilCandles({ rows: changed, cutoff, replace: replaceCandles, state: { key: OIL_CANDLE_KEY, value: { fetchedAt: next.metadata.fetchedAt } } });
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
    /** The last quote with its freshness (by the marks' source time); null before any quote exists. */
    quote(): OilQuoteView | null {
      if (!quote) return null;
      const stale = quoteRestored || now() - Date.parse(quote.fetchedAt) > QUOTE_STALE_MS;
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
    /** For the status page. */
    status() {
      return { quoteAt: quote?.fetchedAt ?? null, quoteError, candlesAt: candles?.metadata.fetchedAt ?? null, candleRows: candles?.data.length ?? 0, candleError };
    },
    /** The two loops; a round starts only after the previous one of its loop ended and the interval passed. */
    loops(context: LoopContext): Promise<void>[] {
      const every = (intervalMs: number, name: string, round: () => Promise<void>) => (async () => {
        while (!context.stopped()) {
          try { await round(); } catch (error) { log(`原油${name}出错：${detail(error)}`); }
          if (context.stopped()) break;
          await context.pause(intervalMs);
        }
      })();
      return [every(OIL_QUOTE_REFRESH_MS, '报价', refreshQuote), every(OIL_CANDLE_REFRESH_MS, ' K 线', refreshCandles)];
    },
    /** Cuts the requests in flight short; the loops then end at their next stop check. */
    stop(): void { stopping.abort(); },
  };
}
export type OilMonitor = ReturnType<typeof createOilMonitor>;
