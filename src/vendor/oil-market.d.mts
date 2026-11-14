// Types for oil-market.mjs, gathered from its signatures.
export type OilFetcher = (url: string, init: RequestInit) => Promise<Response>;
export interface OilRequestOptions { fetcher?: OilFetcher; timeout?: number; pageSize?: number; now?: number }

export const API_URL: 'https://fapi.binance.com';
export const SOURCE: 'Binance';
export const DAY: number;
/** 2026-04-01 09:00 UTC, the first Binance oil bar. */
export const HISTORY_START: number;
export const ASSETS: Readonly<{
  brent: { coin: 'BZUSDT'; label: string; page: string };
  wti: { coin: 'CLUSDT'; label: string; page: string };
}>;
export function numeric(value: unknown, positive?: boolean): number;
export function requestBinance(path: string, params?: Record<string, string | number>, options?: OilRequestOptions): Promise<unknown>;

export interface OilQuoteLeg { coin: string; markPx: number; fundingRate: number | null; fundingIntervalHours: number | null; nextFundingAt: string | null }
export interface OilMarket { source: 'Binance'; currency: 'USDT'; fetchedAt: string; brent: OilQuoteLeg; wti: OilQuoteLeg }
export function validateMarket(input: unknown): OilMarket;
export interface OilSpreadFunding {
  basis: 'quantity' | 'notional'; brentNotional: number; wtiNotional: number; grossNotional: number;
  brentRate: number | null; wtiRate: number | null; brentCashflow: number | null; wtiCashflow: number | null;
  hourlyCashflow: number | null; hourlyRate: number | null; annualizedRate: number | null; cashflowPer10k: number | null;
}
export function calculateShortSpreadFunding(market: unknown, basis?: 'quantity' | 'notional'): OilSpreadFunding;
export type BinanceKline = [number, string, string, string, string, string, number, ...unknown[]];
export function fetchCandles(symbol: string, interval: '15m' | '1d', startTime: number, endTime: number, options?: OilRequestOptions): Promise<BinanceKline[]>;

/** Brent − WTI in USDT per barrel, subtracted on the decimal quotes; null means the pair is unavailable. */
export function oilSpread(brent: unknown, wti: unknown): number | null;
export function decimalDifference(left: number, right: number): number;

export const OIL_CANDLE_INTERVAL: '15m';
export const OIL_CANDLE_MS: number;
export const OIL_CANDLE_ACTION: 'candles/15m';
export const OIL_CANDLE_REFRESH_MS: number;
export interface OilCandleRow { time: number; brent: number | null; wti: number | null }
export interface OilIntradayMetadata {
  source: 'Binance'; api: string; currency: 'USDT'; symbols: string[]; interval: '15m'; timezone: 'UTC'; priceBasis: string; fetchedAt: string;
  firstCommonObservation: string; lastCommonObservation: string; pairedObservationRows: number; expectedObservationRows: number; missingObservationRows: number;
}
export interface OilIntraday { status: 'live' | 'snapshot'; metadata: OilIntradayMetadata; data: OilCandleRow[] }
export interface OilCoverage { firstCommonObservation: string; lastCommonObservation: string; pairedObservationRows: number }
/** A windowed snapshot; the snapshot itself when the window already covers it. */
export type OilIntradayWindow = OilIntraday & { windowDays?: number; coverage?: OilCoverage };
export interface OilChartRow extends OilCandleRow { brent: number; wti: number; spread: number }

export function pairIntradayCandles(brent: unknown, wti: unknown, now?: number): OilCandleRow[];
export function createIntradaySnapshot(rows: readonly OilCandleRow[], fetchedAt: string, status?: 'live' | 'snapshot'): OilIntraday;
export function validateIntradaySnapshot(input: unknown): OilIntraday;
export function parseCandleWindowDays(value: string | null | undefined): number | null;
export function intradayWindow(snapshot: OilIntraday, days: number): OilIntradayWindow;
export function fetchIntradaySnapshot(existing?: OilIntraday | null, options?: OilRequestOptions): Promise<OilIntraday>;
export function validatedIntradayChartRows(snapshot: OilIntraday): OilChartRow[];
export function intradayChartRows(snapshot: unknown): OilChartRow[];
export function recentIntradayChartRows(snapshot: unknown, durationMs: number): OilChartRow[];
