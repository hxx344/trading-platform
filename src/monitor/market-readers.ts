// Public rounds shared by the independent market service and the stand-in/local runner.
// Every operation reads fixed venue markets. The caller supplies only persisted resume times.
import { createBinanceGate, createRhLighterState, fetchAnthropicCandleBatch, fetchAnthropicQuote,
  type AnthropicCandleStarts, type AnthropicFetcher, type BinanceGate } from '../vendor/anthropic-market.mjs';
import { ASSETS, fetchOilCandleBatch, requestBinance, validateMarket, type OilMarket } from '../vendor/oil-market.mjs';
import { fetchHynixCandles, fetchHynixQuote } from '../vendor/hynix-market.mjs';
import { fetchOilFundingFacts, fetchHynixFundingFacts } from '../vendor/settled-funding.mjs';
import type { FundingHistoryRange } from '../vendor/exchange-funding-history.mjs';
import type { FundingSide } from './funding-archive.ts';

import { boundedReply, BinanceCooldown } from './market-contract.ts';
import { HYPERLIQUID_INFO, XYZ_CONTEXTS_BODY, type SharedMarketReads } from './shared-reads.ts';

/** The workbench's limits (lib/exchange-service.ts parseBinanceQuote): a mark's source time near this clock, both legs close together. */
const SOURCE_PAST_MS = 120_000, SOURCE_FUTURE_MS = 60_000, LEG_SKEW_MS = 15_000;
/** The Anthropic quote is dated by the time it was asked for, so a shared xyz reply may be this old at most. */
const ANTHROPIC_CONTEXTS_MAX_AGE_MS = 2_000;

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

/** Ends this caller's wait on its own signal; the shared read goes on for the others. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = (): void => reject(signal.reason);
    if (signal.aborted) { work.catch(() => {}); return stop(); }
    signal.addEventListener('abort', stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

export function createMarketReaders({ fetchImpl = fetch, now = Date.now, gate = createBinanceGate(), shared }: {
  fetchImpl?: AnthropicFetcher; now?: () => number; gate?: BinanceGate;
  /** The market service's reads in common with the comparison and the collector (./shared-reads.ts); absent, every read is its own. */
  shared?: SharedMarketReads;
} = {}) {
  const rh = createRhLighterState();
  const fetcher = (signal: AbortSignal): AnthropicFetcher => async (url, init) => {
    if (shared && url === HYPERLIQUID_INFO && init.method === 'POST' && init.body === XYZ_CONTEXTS_BODY) {
      // The Anthropic xyz leg and the comparison ask for the same reply; a refusal keeps its status for the leg's own handling.
      const stop = init.signal ? AbortSignal.any([signal, init.signal]) : signal;
      try { return Response.json((await untilAborted(shared.xyzContexts(ANTHROPIC_CONTEXTS_MAX_AGE_MS), stop)).reply); }
      catch (error) {
        const status = (error as { status?: unknown } | null)?.status;
        if (typeof status === 'number' && status >= 400 && status <= 599) return new Response(null, { status });
        throw error;
      }
    }
    return boundedReply(await fetchImpl(url, { ...init, signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal }));
  };
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
    if (shared) {
      // The funding terms stay optional, and marks the collector cannot vouch for are read from the venue as before.
      const funding = shared.fundingInfo().catch(() => null), rows = shared.binanceMarks([ASSETS.brent.coin, ASSETS.wti.coin]);
      if (rows) { try { return parseOilQuote(rows[0], rows[1], await funding, now()); } catch { /* read premiumIndex instead */ } }
      const [brent, wti] = await Promise.all([
        requestBinance('/fapi/v1/premiumIndex', { symbol: ASSETS.brent.coin }, options),
        requestBinance('/fapi/v1/premiumIndex', { symbol: ASSETS.wti.coin }, options),
      ]);
      return parseOilQuote(brent, wti, await funding, now());
    }
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
    anthropicCandles: (starts: AnthropicCandleStarts, at: number, signal: AbortSignal, ends?: AnthropicCandleStarts) => fetchAnthropicCandleBatch(starts, { fetcher: fetcher(signal), now: at, ends, gate, rh, clock: now }),
    oilQuote,
    oilCandles: (start: number, end: number, signal: AbortSignal) => fetchOilCandleBatch(start, { fetcher: oilFetcher(signal), now: end, timeout: 15_000 }, true),
    oilFunding: (side: FundingSide, range: FundingHistoryRange, signal: AbortSignal) => fetchOilFundingFacts(side, range, { fetcher: oilFetcher(signal), timeout: 15_000 }),
    hynixQuote: (signal: AbortSignal) => fetchHynixQuote({ fetcher: fetcher(signal), now, timeout: 5_000 }),
    hynixCandles: (start: number, at: number, signal: AbortSignal, end?: number) => fetchHynixCandles(start, { fetcher: fetcher(signal), timeout: 10_000, now: at, end }),
    hynixFunding: (side: FundingSide, range: FundingHistoryRange, signal: AbortSignal) => fetchHynixFundingFacts(side, range, { fetcher: fetcher(signal), timeout: 10_000 }),
  };
}
export type MarketReaders = ReturnType<typeof createMarketReaders> & { epoch?: () => string | null };
