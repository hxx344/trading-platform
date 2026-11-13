// The BTC option chain (docs/options.md §2–3): instruments every hour, tickers and the BTC index every 10 s. A refresh
// replaces the snapshot only when both reads parsed and the chain has usable calls and puts; otherwise the previous one
// stays (marked by its time), as the workbench's refresh_chain does. Nothing here is ever invented: a field the venue left
// blank stays unknown (null) for the Greeks, and zero for prices, which every user of a price treats as unusable.
import { decimal } from '../decimal.ts';
import type { OptionsClient, Row } from './client.ts';
import { describe } from '../live/values.ts';

export type OptionType = 'Call' | 'Put';
export interface OptionRow {
  symbol: string;
  /** Delivery time, ms. */
  expiry: number;
  strike: number;
  optionType: OptionType;
  delta: number;
  mark: number;
  bid: number;
  ask: number;
  iv: number;
  volume: number;
  openInterest: number;
  bidSize: number;
  askSize: number;
  minQty: string;
  qtyStep: string;
  maxQty: string;
  tick: string;
}
export interface Greeks { delta: number | null; gamma: number | null; vega: number | null; theta: number | null }
export interface ChainSnapshot { rows: OptionRow[]; greeks: Map<string, Greeks>; index: number | null; at: number }

export const MARKET_REFRESH_MS = 10_000;
export const INSTRUMENT_REFRESH_MS = 3_600_000;
export const QUOTE_STALE_MS = 30_000;
const READ_TIMEOUT_MS = 10_000;

const number = (value: unknown): number => {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : typeof value === 'number' ? value : 0;
  return Number.isFinite(parsed) ? parsed : 0;
};
const optional = (value: unknown): number | null => {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const step = (value: unknown, fallback: string): string => {
  try { return typeof value === 'string' && value !== '' ? decimal(value, 'positive') : fallback; } catch { return fallback; }
};

export function tickerGreeks(ticker: Row | undefined): Greeks {
  return { delta: optional(ticker?.delta), gamma: optional(ticker?.gamma), vega: optional(ticker?.vega), theta: optional(ticker?.theta) };
}

/** Rows of unexpired instruments with their tickers; the shapes follow refresh_chain. */
export function parseChain(instruments: Row[], tickers: Row[], now: number): { rows: OptionRow[]; greeks: Map<string, Greeks> } {
  const bySymbol = new Map<string, Row>();
  for (const ticker of tickers) if (typeof ticker.symbol === 'string' && ticker.symbol) bySymbol.set(ticker.symbol, ticker);
  const rows: OptionRow[] = [];
  for (const item of instruments) {
    const symbol = typeof item.symbol === 'string' ? item.symbol : '';
    const expiry = Number(item.deliveryTime);
    const strike = number(item.strikePrice ?? symbol.split('-')[2]);
    if (!symbol || !Number.isSafeInteger(expiry) || expiry <= now || !(strike > 0)) continue;
    const ticker = bySymbol.get(symbol) ?? {};
    const lot = (item.lotSizeFilter ?? {}) as Row, price = (item.priceFilter ?? {}) as Row;
    rows.push({
      symbol, expiry, strike, optionType: item.optionsType === 'Call' ? 'Call' : 'Put',
      delta: number(ticker.delta), mark: number(ticker.markPrice), bid: number(ticker.bid1Price), ask: number(ticker.ask1Price), iv: number(ticker.markIv),
      volume: number(ticker.volume24h), openInterest: number(ticker.openInterest), bidSize: number(ticker.bid1Size), askSize: number(ticker.ask1Size),
      minQty: step(lot.minOrderQty, '0.01'), qtyStep: step(lot.qtyStep, '0.01'), maxQty: step(lot.maxOrderQty, '500'), tick: step(price.tickSize, '0.01'),
    });
  }
  const greeks = new Map<string, Greeks>();
  for (const [symbol, ticker] of bySymbol) greeks.set(symbol, tickerGreeks(ticker));
  return { rows, greeks };
}

export function createOptionMarket(client: OptionsClient, { now = Date.now, log = (_line: string) => undefined }: { now?: () => number; log?: (line: string) => void } = {}) {
  let snapshot: ChainSnapshot | null = null;
  let instruments: { rows: Row[]; at: number } | null = null;
  let error: { message: string; at: number } | null = null;
  let running: Promise<ChainSnapshot | null> | null = null;

  async function load(forceInstruments: boolean): Promise<ChainSnapshot | null> {
    const time = now(), signal = AbortSignal.timeout(READ_TIMEOUT_MS * 2);
    try {
      const stale = forceInstruments || !instruments || time - instruments.at >= INSTRUMENT_REFRESH_MS;
      const [rawInstruments, tickers, underlying] = await Promise.all([stale ? client.instruments(signal) : Promise.resolve(instruments!.rows), client.tickers(signal), client.underlying(signal)]);
      if (stale) instruments = { rows: rawInstruments, at: time };
      const { rows, greeks } = parseChain(rawInstruments, tickers, time);
      const usable = rows.filter(row => Math.abs(row.delta) > 0 && row.mark > 0);
      if (usable.length < 2 || new Set(usable.map(row => row.optionType)).size !== 2) throw new Error('Bybit 没有返回可用的 BTC 期权链');
      const index = number(underlying.indexPrice) || number(underlying.markPrice) || number(underlying.lastPrice);
      snapshot = { rows, greeks, index: index > 0 ? index : null, at: time };
      error = null;
      return snapshot;
    } catch (failure) {
      error = { message: describe(failure), at: time };
      log(`期权行情刷新失败，保留上次结果：${error.message}`);
      return snapshot;
    }
  }

  return {
    /** Re-reads unless the snapshot is younger than `fresherThanMs`; concurrent callers share one read. */
    async refresh({ fresherThanMs = 0, forceInstruments = false }: { fresherThanMs?: number; forceInstruments?: boolean } = {}): Promise<ChainSnapshot | null> {
      if (snapshot && fresherThanMs > 0 && now() - snapshot.at < fresherThanMs) return snapshot;
      running ??= load(forceInstruments).finally(() => { running = null; });
      return running;
    },
    snapshot: (): ChainSnapshot | null => snapshot,
    error: () => error,
  };
}
export type OptionMarket = ReturnType<typeof createOptionMarket>;

/** Expiry as a UTC day: Sunday is 0 in JavaScript. */
export const isSunday = (ms: number): boolean => new Date(ms).getUTCDay() === 0;
