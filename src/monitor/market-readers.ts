// Public rounds shared by the independent market service and the stand-in/local runner.
// Every operation reads fixed venue markets. The caller supplies only persisted resume times.
import { createBinanceGate, createRhLighterState, fetchAnthropicCandleBatch, fetchAnthropicQuote,
  type AnthropicCandleStarts, type AnthropicFetcher, type BinanceGate } from '../vendor/anthropic-market.mjs';
import { ASSETS, fetchOilCandleBatch, requestBinance, validateMarket, type OilMarket } from '../vendor/oil-market.mjs';
import { fetchHynixCandles, fetchHynixQuote } from '../vendor/hynix-market.mjs';
import { fetchOilFunding, fetchHynixFunding } from '../vendor/settled-funding.mjs';

import { boundedReply, BinanceCooldown } from './market-contract.ts';

/** The workbench's limits (lib/exchange-service.ts parseBinanceQuote): a mark's source time near this clock, both legs close together. */
const SOURCE_PAST_MS = 120_000, SOURCE_FUTURE_MS = 60_000, LEG_SKEW_MS = 15_000;

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

export function createMarketReaders({ fetchImpl = fetch, now = Date.now, gate = createBinanceGate() }: {
  fetchImpl?: AnthropicFetcher; now?: () => number; gate?: BinanceGate;
} = {}) {
  const rh = createRhLighterState();
  const fetcher = (signal: AbortSignal): AnthropicFetcher => async (url, init) =>
    boundedReply(await fetchImpl(url, { ...init, signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal }));
  const oilFetcher = (signal: AbortSignal): AnthropicFetcher => {
    const read = fetcher(signal);
    return async (url, init) => {
      if (now() < gate.until) throw new BinanceCooldown(gate.status);
      const response = await read(url, init);
      if (response.status === 429 || response.status === 418) {
        gate.until = Math.max(gate.until, now() + (response.status === 418 ? 120_000 : 60_000)); gate.status = response.status;
      }
      return response;
    };
  };
  async function oilQuote(signal: AbortSignal): Promise<OilMarket> {
    const options = { fetcher: oilFetcher(signal), timeout: 10_000 };
    const [brent, wti, funding] = await Promise.all([
      requestBinance('/fapi/v1/premiumIndex', { symbol: ASSETS.brent.coin }, options),
      requestBinance('/fapi/v1/premiumIndex', { symbol: ASSETS.wti.coin }, options),
      // The funding terms are optional: without them the prices still count.
      requestBinance('/fapi/v1/fundingInfo', {}, options).catch(() => null),
    ]);
    return parseOilQuote(brent, wti, funding, now());
  }

  return {
    anthropicQuote: (signal: AbortSignal) => fetchAnthropicQuote({ fetcher: fetcher(signal), now: now(), gate, rh, clock: now }),
    anthropicCandles: (starts: AnthropicCandleStarts, at: number, signal: AbortSignal) => fetchAnthropicCandleBatch(starts, { fetcher: fetcher(signal), now: at, gate, rh, clock: now }),
    oilQuote,
    oilCandles: (start: number, at: number, signal: AbortSignal) => fetchOilCandleBatch(start, { fetcher: oilFetcher(signal), now: at, timeout: 15_000 }),
    oilFunding: (start: number, end: number, at: number, signal: AbortSignal) => fetchOilFunding(start, { fetcher: oilFetcher(signal), timeout: 15_000, now: at, endTime: end }),
    hynixQuote: (signal: AbortSignal) => fetchHynixQuote({ fetcher: fetcher(signal), now, timeout: 5_000 }),
    hynixCandles: (start: number, at: number, signal: AbortSignal) => fetchHynixCandles(start, { fetcher: fetcher(signal), timeout: 10_000, now: at }),
    hynixFunding: (start: number, end: number, at: number, signal: AbortSignal) => fetchHynixFunding(start, { fetcher: fetcher(signal), timeout: 10_000, now: at, endTime: end }),
  };
}
export type MarketReaders = ReturnType<typeof createMarketReaders> & { epoch?: () => string | null };
