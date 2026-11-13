// Types for anthropic-market.mjs, gathered from its JSDoc typedefs and signatures.
export interface AnthropicShares { outstanding: number; diluted: number }
export type AnthropicComparisonLeg = 'xyz' | 'io' | 'rh';
export type AnthropicLegKey = 'binance' | AnthropicComparisonLeg;
export interface AnthropicLeg {
  readonly exchange: 'binance' | 'hyperliquid' | 'rh-lighter';
  readonly symbol: string;
  readonly dex?: string;
  readonly name: string;
  readonly venue: string;
  readonly label: string;
  readonly sharesPerUnit: number;
  readonly basis: string;
}
export interface BinanceLegQuote { markPx: number; fundingRate: number | null; nextFundingTime: number | null }
export interface HyperliquidLegQuote { markPx: number; fundingRate: number | null; oraclePx: number | null }
export interface RhLighterLegQuote { markPx: number; fundingRate: number | null; indexPx: number | null }
export type AnthropicLegErrors = Partial<Record<AnthropicLegKey, string>>;
export interface AnthropicQuote {
  fetchedAt: string;
  binance: BinanceLegQuote | null;
  xyz: HyperliquidLegQuote | null;
  io: HyperliquidLegQuote | null;
  rh: RhLighterLegQuote | null;
  errors: AnthropicLegErrors;
}
export interface AnthropicCandleRow { time: number; binance: number | null; xyz: number | null; io: number | null; rh: number | null }
export interface AnthropicCandleMetadata {
  source: string; symbols: string[]; interval: '15m'; timezone: 'UTC'; priceBasis: string; fetchedAt: string;
  firstObservation: string; lastObservation: string; rows: number; errors: AnthropicLegErrors;
}
export interface AnthropicCandles { status: 'live' | 'snapshot'; metadata: AnthropicCandleMetadata; data: AnthropicCandleRow[] }
export interface AnthropicCandleCoverage { firstObservation: string; lastObservation: string; rows: number }
/** A windowed snapshot; returned as the snapshot itself when the window already covers it. */
export type AnthropicCandleWindow = AnthropicCandles & { windowDays?: number; coverage?: AnthropicCandleCoverage };
export interface BinanceGate { until: number; status: number }
export interface RhLighterMarket { id: number; listedAt: number | null }
export interface RhLighterState { until: number; status: number; market: RhLighterMarket | null; discovery: Promise<unknown> | null }
export interface AnthropicChartRow { time: number; adr: number; ordinary: number; equivalent: number; spread: number; premium: number }
export type AnthropicFetcher = (url: string, init: RequestInit) => Promise<Response>;
export interface AnthropicReadOptions {
  fetcher?: AnthropicFetcher;
  now?: number;
  timeout?: number;
  gate?: BinanceGate;
  rh?: RhLighterState;
  clock?: () => number;
}

export const ANTHROPIC_SHARES: Readonly<AnthropicShares>;
export const ANTHROPIC_LEGS: Readonly<Record<AnthropicLegKey, AnthropicLeg>>;
export const HYPERLIQUID_LEGS: readonly ('xyz' | 'io')[];
export const ANTHROPIC_COMPARISON_LEGS: readonly AnthropicComparisonLeg[];
export const ANTHROPIC_LEG_KEYS: readonly AnthropicLegKey[];
export const ANTHROPIC_SOURCE: string;
export const ANTHROPIC_QUOTE_REFRESH_MS: number;
export const ANTHROPIC_CANDLE_ACTION: string;
export const ANTHROPIC_CANDLE_MS: number;
export const ANTHROPIC_CANDLE_REFRESH_MS: number;
export const ANTHROPIC_INITIAL_DAYS: number;
export const ANTHROPIC_RETENTION_DAYS: number;

/** Short Chinese reason for a failed leg read; never echoes upstream bodies. */
export function legError(error: unknown): string;
export function anthropicSharesPerUnit(leg: AnthropicLegKey, shares?: AnthropicShares | null): number | null;
export function perShare(leg: AnthropicLegKey, price: number, shares?: AnthropicShares | null): number | null;
export function anthropicPremium(binance: number | null | undefined, other: number | null | undefined, leg: AnthropicComparisonLeg, shares?: AnthropicShares | null): number | null;
export function validateAnthropicQuote(input: unknown): AnthropicQuote;
export function createBinanceGate(): BinanceGate;
export function createRhLighterState(): RhLighterState;
export function fetchAnthropicQuote(options?: AnthropicReadOptions): Promise<AnthropicQuote>;
export function createAnthropicCandles(rows: unknown[], fetchedAt: string, status?: 'live' | 'snapshot', errors?: unknown): AnthropicCandles;
export function validateAnthropicCandles(input: unknown): AnthropicCandles;
export function anthropicCandleWindow(snapshot: AnthropicCandles, days: number): AnthropicCandleWindow;
export function fetchAnthropicCandles(existing?: unknown, options?: AnthropicReadOptions): Promise<AnthropicCandles>;
export function anthropicChartRows(rows: readonly AnthropicCandleRow[], leg: AnthropicComparisonLeg, shares?: AnthropicShares | null): AnthropicChartRow[];
