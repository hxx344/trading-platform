// Monitor M-2f: the gold/oil ratio's data rules, without I/O, shared by the market process (market-readers.ts), the collector
// (goldoil.ts) and the page (web/src/monitor-goldoil.ts). Ported from the project-aggregation workbench modules/monitor:
// lib/gold-oil.ts (61eaae1: the intervals, the 75 s staleness, the instruments and units) and lib/gold-oil-service.ts
// (61eaae1: validateGoldOilContracts, parseGoldOilQuote, the markPriceKlines page checks, the listing start). Differences: one
// quote carries XAU, CL and BZ together (the workbench reads XAU/CL and XAU/BZ as two variants), and the three legs' source
// times must lie within 15 s of each other (the platform's oil rule), or the round is dropped.

export const GOLDOIL_CANDLE_MS = 900_000;
export const GOLDOIL_QUOTE_REFRESH_MS = 30_000;
export const GOLDOIL_CANDLE_REFRESH_MS = 60_000;
/** A mark older than this (by its source time) is not taken, and a stored quote this old is a snapshot. */
export const GOLDOIL_STALE_MS = 75_000;
/** The legs' source times may differ by at most this much. */
export const GOLDOIL_LEG_SKEW_MS = 15_000;
/** A source time this far ahead of the clock is refused: the alerts' own tolerance (alerts.ts FUTURE_MS; the workbench allows 1 s). */
export const GOLDOIL_FUTURE_MS = 5_000;
export const GOLDOIL_SYMBOLS = { xau: 'XAUUSDT', cl: 'CLUSDT', bz: 'BZUSDT' } as const;
export type GoldOilType = 'cl' | 'bz';
/** `column`: the oil leg's column in goldoil_candles. */
export const GOLDOIL_INSTRUMENTS = {
  cl: { symbol: 'CLUSDT', code: 'CL', name: 'WTI 原油', column: 'wti' },
  bz: { symbol: 'BZUSDT', code: 'BZ', name: '布伦特原油', column: 'brent' },
} as const;
export const GOLDOIL_UNITS = { ratio: '桶/盎司', xau: 'USDT/盎司', oil: 'USDT/桶' } as const;

export interface GoldOilLeg { symbol: string; price: number; updatedAt: string }
export interface GoldOilQuote { source: 'Binance'; currency: 'USDT'; priceBasis: 'mark'; fetchedAt: string; xau: GoldOilLeg; cl: GoldOilLeg; bz: GoldOilLeg }
/** One 15-minute bar's mark closes; a leg without a bar at that time is null. */
export interface GoldOilCandleRow { time: number; xau: number | null; wti: number | null; brent: number | null }
export interface GoldOilCoverage { firstObservation: string; lastObservation: string; observationRows: number }
export interface GoldOilHistoryMetadata extends GoldOilCoverage {
  source: 'Binance'; currency: 'USDT'; priceBasis: 'mark'; interval: '15m'; timezone: 'UTC'; symbols: string[]; fetchedAt: string;
  /** The later listing of the three contracts, rounded up to a bar: history starts there. null before it was read. */
  listedAt: string | null;
}
/** Rows where XAU and at least one oil leg have a bar. A windowed read carries `windowDays` and the whole history's `coverage`. */
export interface GoldOilHistory { status: 'live' | 'snapshot'; metadata: GoldOilHistoryMetadata; data: GoldOilCandleRow[]; windowDays?: number; coverage?: GoldOilCoverage }

type Json = Record<string, unknown>;
const object = (value: unknown, what = 'Binance object'): Json => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${what}`);
  return value as Json;
};
const number = (value: unknown): number => {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return NaN;
  return Number(value);
};
const positive = (value: unknown): number => {
  const result = number(value);
  if (!Number.isFinite(result) || result <= 0) throw new Error('Invalid Binance price');
  return result;
};

/**
 * exchangeInfo: each of XAUUSDT, CLUSDT and BZUSDT listed exactly once, trading, a (TradFi) perpetual, USDT quoted and
 * margined. Returns where the common history starts: the latest listing rounded up to a 15-minute bar.
 */
export function goldOilListing(info: unknown, now: number): number {
  const symbols = object(info, 'Binance contracts').symbols;
  if (!Array.isArray(symbols)) throw new Error('Missing Binance contracts');
  const dates = ([['XAU', GOLDOIL_SYMBOLS.xau], ['CL', GOLDOIL_SYMBOLS.cl], ['BZ', GOLDOIL_SYMBOLS.bz]] as const).map(([base, symbol]) => {
    const matches = symbols.filter(item => item && typeof item === 'object' && (item as Json).symbol === symbol) as Json[], spec = matches[0];
    if (matches.length !== 1 || spec!.status !== 'TRADING' || !['PERPETUAL', 'TRADIFI_PERPETUAL'].includes(String(spec!.contractType))
      || spec!.baseAsset !== base || spec!.quoteAsset !== 'USDT' || spec!.marginAsset !== 'USDT') throw new Error('Unsupported Binance gold/oil contract');
    return number(spec!.onboardDate);
  });
  if (dates.some(date => !Number.isSafeInteger(date) || date <= 0 || date > now)) throw new Error('Invalid contract listing date');
  return Math.ceil(Math.max(...dates) / GOLDOIL_CANDLE_MS) * GOLDOIL_CANDLE_MS;
}

/** Three premiumIndex replies (or the collector's marks of the same shape): each recent, the three within 15 s of each other. */
export function parseGoldOilQuote(xauInput: unknown, clInput: unknown, bzInput: unknown, now: number): GoldOilQuote {
  const leg = (input: unknown, symbol: string): GoldOilLeg => {
    const value = object(input), time = number(value.time);
    if (value.symbol !== symbol || !Number.isSafeInteger(time) || time < now - GOLDOIL_STALE_MS || time > now + GOLDOIL_FUTURE_MS) throw new Error('Delayed or unexpected Binance quote');
    return { symbol, price: positive(value.markPrice), updatedAt: new Date(time).toISOString() };
  };
  const xau = leg(xauInput, GOLDOIL_SYMBOLS.xau), cl = leg(clInput, GOLDOIL_SYMBOLS.cl), bz = leg(bzInput, GOLDOIL_SYMBOLS.bz);
  const times = [xau, cl, bz].map(item => Date.parse(item.updatedAt));
  if (Math.max(...times) - Math.min(...times) > GOLDOIL_LEG_SKEW_MS) throw new Error('Binance gold/oil legs are not synchronized');
  return { source: 'Binance', currency: 'USDT', priceBasis: 'mark', fetchedAt: new Date(Math.min(...times)).toISOString(), xau, cl, bz };
}

/** A stored or served quote, checked again (the page and the collector's read-back). */
export function validateGoldOilQuote(input: unknown): GoldOilQuote {
  const value = object(input, 'gold/oil quote');
  if (value.source !== 'Binance' || value.currency !== 'USDT' || value.priceBasis !== 'mark' || typeof value.fetchedAt !== 'string' || !Number.isFinite(Date.parse(value.fetchedAt))) throw new Error('Expected Binance gold/oil quote');
  const leg = (key: 'xau' | 'cl' | 'bz'): GoldOilLeg => {
    const item = object(value[key], 'gold/oil leg');
    if (item.symbol !== GOLDOIL_SYMBOLS[key] || typeof item.updatedAt !== 'string' || !Number.isFinite(Date.parse(item.updatedAt))) throw new Error('Unexpected gold/oil leg');
    return { symbol: GOLDOIL_SYMBOLS[key], price: positive(item.price), updatedAt: item.updatedAt };
  };
  return { source: 'Binance', currency: 'USDT', priceBasis: 'mark', fetchedAt: value.fetchedAt, xau: leg('xau'), cl: leg('cl'), bz: leg('bz') };
}

/** XAU ÷ oil in barrels per ounce. */
export const goldOilRatio = (quote: GoldOilQuote, type: GoldOilType): number => quote.xau.price / quote[type].price;

/**
 * One markPriceKlines page of `symbol` read from `cursor`: closed 15-minute bars in [cursor, end), strictly increasing, each
 * closing at time + 15 min − 1 with a positive close. Returns the page's bars by time.
 */
export function goldOilKlinePage(batch: unknown, cursor: number, end: number): [number, number][] {
  if (!Array.isArray(batch)) throw new Error('Invalid Binance history page');
  const rows: [number, number][] = [];
  let last = cursor - 1;
  for (const item of batch) {
    if (!Array.isArray(item) || item.length < 7) throw new Error('Invalid Binance candle');
    const time = number(item[0]), close = number(item[6]), price = number(item[4]);
    if (!Number.isSafeInteger(time) || time % GOLDOIL_CANDLE_MS || time < cursor || time <= last || time >= end) throw new Error('Invalid Binance pagination');
    if (close !== time + GOLDOIL_CANDLE_MS - 1 || !Number.isFinite(price) || price <= 0) throw new Error('Invalid Binance candle');
    rows.push([time, price]);
    last = time;
  }
  return rows;
}

/** The three legs' bars on one time grid; a time any leg has is a row. */
export function pairGoldOilRows(xau: readonly [number, number][], wti: readonly [number, number][], brent: readonly [number, number][]): GoldOilCandleRow[] {
  const rows = new Map<number, GoldOilCandleRow>();
  const add = (bars: readonly [number, number][], key: 'xau' | 'wti' | 'brent') => {
    for (const [time, price] of bars) {
      const row = rows.get(time) ?? { time, xau: null, wti: null, brent: null };
      row[key] = price; rows.set(time, row);
    }
  };
  add(xau, 'xau'); add(wti, 'wti'); add(brent, 'brent');
  return [...rows.values()].sort((a, b) => a.time - b.time);
}

/** Stored or fetched rows: aligned, strictly increasing, closed by `fetchedAt`, each price positive or null. */
export function validateGoldOilRows(rows: readonly GoldOilCandleRow[], fetchedAt: string): GoldOilCandleRow[] {
  const end = Date.parse(fetchedAt);
  if (!Array.isArray(rows) || !Number.isFinite(end)) throw new Error('Invalid gold/oil candles');
  const price = (value: unknown) => {
    if (value === null) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error('Invalid gold/oil candle price');
    return value;
  };
  let last = -Infinity;
  return rows.map(row => {
    const time = row?.time;
    if (!Number.isSafeInteger(time) || time % GOLDOIL_CANDLE_MS || time <= last || time + GOLDOIL_CANDLE_MS > end) throw new Error('Invalid gold/oil candle time');
    last = time;
    return { time, xau: price(row.xau), wti: price(row.wti), brent: price(row.brent) };
  });
}

/** `incoming` replaces a stored row's legs where it has them; a leg it lacks keeps the stored close. */
export function mergeGoldOilRows(previous: readonly GoldOilCandleRow[], incoming: readonly GoldOilCandleRow[]): GoldOilCandleRow[] {
  const rows = new Map(previous.map(row => [row.time, row]));
  for (const row of incoming) {
    const old = rows.get(row.time);
    rows.set(row.time, old ? { time: row.time, xau: row.xau ?? old.xau, wti: row.wti ?? old.wti, brent: row.brent ?? old.brent } : row);
  }
  return [...rows.values()].sort((a, b) => a.time - b.time);
}

/** A row the chart can use: gold and at least one oil leg. */
export const goldOilObserved = (row: GoldOilCandleRow): boolean => row.xau !== null && (row.wti !== null || row.brent !== null);
/** A row the backfill counts as complete: all three legs. */
export const goldOilComplete = (row: GoldOilCandleRow): boolean => row.xau !== null && row.wti !== null && row.brent !== null;

const iso = (time: number) => new Date(time).toISOString();
/** The served history over every observed row; null while there is none. */
export function goldOilSnapshot(rows: readonly GoldOilCandleRow[], fetchedAt: string, listedAt: number | null, status: 'live' | 'snapshot' = 'live'): GoldOilHistory | null {
  const data = rows.filter(goldOilObserved);
  if (!data.length) return null;
  return {
    status,
    metadata: {
      source: 'Binance', currency: 'USDT', priceBasis: 'mark', interval: '15m', timezone: 'UTC', symbols: [GOLDOIL_SYMBOLS.xau, GOLDOIL_SYMBOLS.cl, GOLDOIL_SYMBOLS.bz],
      fetchedAt, listedAt: listedAt === null ? null : iso(listedAt), firstObservation: iso(data[0]!.time), lastObservation: iso(data.at(-1)!.time), observationRows: data.length,
    },
    data,
  };
}

/** The rows opening within `days` before the last observation; the snapshot itself when it is no longer than that. */
export function goldOilWindow(snapshot: GoldOilHistory, days: number): GoldOilHistory {
  const start = Date.parse(snapshot.metadata.lastObservation) - days * 86_400_000;
  const { firstObservation, lastObservation, observationRows } = snapshot.metadata;
  const coverage = { firstObservation, lastObservation, observationRows };
  if (snapshot.data[0]!.time >= start) return { ...snapshot, windowDays: days, coverage };
  const data = snapshot.data.filter(row => row.time >= start);
  return { ...snapshot, metadata: { ...snapshot.metadata, firstObservation: iso(data[0]!.time), observationRows: data.length }, data, windowDays: days, coverage };
}

/** A served history, checked (the page's boundary check). */
export function validateGoldOilHistory(input: unknown): GoldOilHistory {
  const value = object(input, 'gold/oil history'), metadata = object(value.metadata, 'gold/oil history');
  if ((value.status !== 'live' && value.status !== 'snapshot') || metadata.source !== 'Binance' || metadata.currency !== 'USDT' || metadata.priceBasis !== 'mark'
    || metadata.interval !== '15m' || typeof metadata.fetchedAt !== 'string' || !Array.isArray(value.data) || !value.data.length) throw new Error('Invalid gold/oil history');
  const data = validateGoldOilRows(value.data as GoldOilCandleRow[], metadata.fetchedAt);
  if (!data.every(goldOilObserved) || metadata.firstObservation !== iso(data[0]!.time) || metadata.lastObservation !== iso(data.at(-1)!.time) || metadata.observationRows !== data.length) throw new Error('Invalid gold/oil history range');
  const listedAt = metadata.listedAt === null ? null : typeof metadata.listedAt === 'string' && Number.isFinite(Date.parse(metadata.listedAt)) ? metadata.listedAt : NaN;
  if (Number.isNaN(listedAt)) throw new Error('Invalid gold/oil listing');
  const checked: GoldOilHistory = { status: value.status, metadata: { ...(metadata as unknown as GoldOilHistoryMetadata), symbols: [GOLDOIL_SYMBOLS.xau, GOLDOIL_SYMBOLS.cl, GOLDOIL_SYMBOLS.bz], listedAt: listedAt as string | null }, data };
  if (value.windowDays === undefined) return checked;
  const coverage = object(value.coverage, 'gold/oil coverage');
  if (!Number.isSafeInteger(value.windowDays) || (value.windowDays as number) < 1 || typeof coverage.firstObservation !== 'string' || coverage.lastObservation !== metadata.lastObservation
    || !(Date.parse(coverage.firstObservation) <= data[0]!.time) || !Number.isSafeInteger(coverage.observationRows) || (coverage.observationRows as number) < data.length) throw new Error('Invalid gold/oil candle window');
  return { ...checked, windowDays: value.windowDays as number, coverage: { firstObservation: coverage.firstObservation, lastObservation: coverage.lastObservation as string, observationRows: coverage.observationRows as number } };
}
