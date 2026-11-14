// Types for hynix-market.mjs, gathered from its signatures.
export type HynixFetcher = (url: string, init: RequestInit) => Promise<Response>;

export const SOURCE: 'Hyperliquid';
export const HYNIX_LEGS: Readonly<{ adr: 'xyz:SKHY'; ordinary: 'xyz:SKHX' }>;
export const LISTING_DATE: string;
export const FIRST_FULL_HOUR: number;
export const ADR_PER_SHARE: number;
export const HYNIX_CANDLE_MS: number;
export const HYNIX_MAX_CANDLES: number;
export const HYNIX_RESUME_MS: number;

export interface HynixPrices { adr: number; ordinary: number; equivalent: number; spread: number; premium: number }
export interface HynixQuote extends HynixPrices { source: 'Hyperliquid'; fetchedAt: string }
/** One paired hour: the ADR and ordinary-share closes (USD), `time` = the hour's start. */
export interface HynixCandleRow { time: number; adr: number; ordinary: number }
export interface HynixChartRow extends HynixPrices { time: number }

export function hynixPrices(adr: unknown, ordinary: unknown): HynixPrices;
export function requestInfo(payload: unknown, options?: { fetcher?: HynixFetcher; timeout?: number }): Promise<unknown>;
export function parseHynixMids(mids: unknown, receivedAt: number): HynixQuote;
export function fetchHynixQuote(options?: { fetcher?: HynixFetcher; timeout?: number; now?: () => number }): Promise<HynixQuote>;
export function validateHynixQuote(input: unknown): HynixQuote;
export function alignHynixCandles(ordinary: readonly { t: number; T: number; c: string }[], adr: readonly { t: number; T: number; c: string }[], now: number): HynixCandleRow[];
export function hynixCandleStart(rows: readonly HynixCandleRow[], now: number, full: boolean): number;
export function fetchHynixCandles(startTime: number, options: { fetcher?: HynixFetcher; timeout?: number; now: number }): Promise<HynixCandleRow[]>;
export function validateHynixRows(input: unknown, fetchedAt: string): HynixCandleRow[];
export function hynixChartRows(rows: readonly HynixCandleRow[]): HynixChartRow[];
