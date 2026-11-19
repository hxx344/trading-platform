import { candleKnown, mergeCandleBlocks, type CandleBlockCache, type CandleBlocks } from '../../../src/candle-blocks.ts';
import { CANDLE_LIMIT, INTERVALS, terminalBlockSpan } from '../../../src/vendor/crossex/terminal-intervals.ts';
import { CROSSEX_API } from './crossex-api.ts';
import type { Instrument, MarketData, TerminalCandle } from './live-types.ts';

export type SavedTerminalHistory = { identity: string; blocks: CandleBlockCache<TerminalCandle>; asOf: number | null };
export type TerminalMarketResponse = MarketData & {
  candleListing?: string | null; candleBlocks?: CandleBlocks<TerminalCandle> | null;
};
export type TerminalChart = { closed: TerminalCandle[]; partial?: TerminalCandle; asOf: number | null; error?: string | null; base: string; quote: string };
type TerminalObservation = { identity: string | null | undefined; at: number };
export type TerminalRead = { scope: string; listingScope: string; data: TerminalMarketResponse; chart: TerminalChart | null;
  resumeAfter?: TerminalObservation };

const observed = (data: TerminalMarketResponse) => data.candlePartialAsOf === undefined ? data.candleAsOf : data.candlePartialAsOf;
const observedSeries = new Map<string, TerminalObservation>();
const OBSERVATIONS_KEY = 'crossex-terminal-observations-v1', MAX_OBSERVATIONS = 64;
let restored = false;
/** Remember only the observation time and its source when leaving a chart, never the open bar's values. */
export function lastTerminalObservation(scope: string, identity: TerminalObservation['identity']): TerminalObservation | undefined {
  if (!restored) {
    restored = true;
    try {
      const saved = JSON.parse(window.sessionStorage.getItem(OBSERVATIONS_KEY) ?? '[]');
      if (Array.isArray(saved)) for (const [key, item] of saved.slice(-MAX_OBSERVATIONS)) {
        if (typeof key === 'string' && Number.isSafeInteger(item?.at) && item.at > 0 && (item.identity == null || typeof item.identity === 'string')) observedSeries.set(key, item);
      }
    } catch { /* Memory remains usable with storage disabled. */ }
  }
  return observedSeries.get(JSON.stringify([scope, identity]));
}
export function rememberTerminalObservation(scope: string, next: TerminalObservation | undefined) {
  if (!next) return;
  const prior = lastTerminalObservation(scope, next.identity);
  if (prior && prior.at >= next.at) return;
  const key = JSON.stringify([scope, next.identity]);
  observedSeries.delete(key); observedSeries.set(key, next);
  if (observedSeries.size > MAX_OBSERVATIONS) observedSeries.delete(observedSeries.keys().next().value!);
  try { window.sessionStorage.setItem(OBSERVATIONS_KEY, JSON.stringify([...observedSeries])); } catch { /* Optional across full document reloads. */ }
}
export function terminalObservation(data: TerminalMarketResponse, chart: TerminalChart | null): TerminalObservation | undefined {
  const at = observed(data);
  return chart?.partial && at != null ? { identity: data.candleIdentity, at } : undefined;
}
export function pauseTerminalRead(read: TerminalRead): TerminalRead {
  return { ...read, data: { ...read.data, status: 'stale' },
    resumeAfter: terminalObservation(read.data, read.chart) ?? read.resumeAfter,
    chart: read.chart?.partial ? { ...read.chart, partial: undefined } : read.chart };
}

/** An HTTP success can repeat the same in-memory open bar. Only a newer venue observation releases a paused bar. */
export function acceptTerminalRead(previous: TerminalRead | null, next: TerminalRead, onMount?: TerminalObservation): TerminalRead {
  const prior = previous?.scope === next.scope ? previous.resumeAfter : undefined;
  const fence = prior && (next.data.candleIdentity == null || prior.identity === next.data.candleIdentity) && (!onMount || prior.at >= onMount.at) ? prior : onMount;
  if (!fence || next.data.candleIdentity != null && next.data.candleIdentity !== fence.identity) return next;
  if (next.chart?.partial && (observed(next.data) ?? 0) > fence.at) return next;
  return { ...next, resumeAfter: fence, chart: next.chart?.partial ? { ...next.chart, partial: undefined } : next.chart };
}

export const terminalCacheKey = (i: Instrument, interval: string): string =>
  JSON.stringify([i.symbol, i.exchange, i.base, i.quoteCurrency, i.settlementCurrency, i.candleListing, interval]);

export function marketReadPath(symbol: string, interval: string, mode: 'blocks' | 'none', cached?: SavedTerminalHistory) {
  const params = new URLSearchParams({ symbol, interval, candles: mode });
  if (mode === 'blocks' && cached) {
    params.set('identity', cached.identity);
    params.set('known', candleKnown(cached.blocks));
  }
  return `${CROSSEX_API}/market?${params}`;
}

const historyRows = new WeakMap<CandleBlockCache<TerminalCandle>, TerminalCandle[]>();
function closedRows(blocks: CandleBlockCache<TerminalCandle>): TerminalCandle[] {
  let rows = historyRows.get(blocks);
  if (!rows) { rows = blocks.flatMap(block => block.rows); historyRows.set(blocks, rows); }
  return rows;
}

/** Merge only against the exact baseline sent with this request and only after the server verifies the native source. */
export function readTerminalChart(next: TerminalMarketResponse, cached?: SavedTerminalHistory) {
  const asOf = next.candleAsOf ?? null, error = next.candleError, base = next.base, quote = next.quoteCurrency;
  if (next.candleIdentity === undefined) {
    const chart: TerminalChart = { asOf, error, base, quote, closed: next.candles.filter(c => c.closed !== false), partial: next.candles.find(c => c.closed === false) };
    return { chart, saved: undefined };
  }
  const previous = next.candleIdentity && cached?.identity === next.candleIdentity ? cached : undefined;
  let saved = previous;
  if (next.candleIdentity && next.candleBlocks) {
    const blocks = mergeCandleBlocks(previous?.blocks ?? [], next.candleBlocks, terminalBlockSpan(next.interval));
    if (blocks !== previous?.blocks) saved = { identity: next.candleIdentity, blocks, asOf };
  }
  const chart: TerminalChart = { asOf: asOf ?? saved?.asOf ?? null, error, base, quote,
    closed: saved ? closedRows(saved.blocks) : [],
    partial: next.candleIdentity ? next.candles.find(c => c.closed === false) : undefined };
  return { chart, saved };
}

export function visibleTerminalCandles(chart: TerminalChart | null, interval: string, current: number, active = true): TerminalCandle[] {
  if (!chart || !Object.hasOwn(INTERVALS, interval)) return [];
  const rows = chart.closed.filter(c => c.time < current);
  if (active && chart.partial?.time === current) rows.push(chart.partial);
  return rows.slice(-CANDLE_LIMIT);
}
