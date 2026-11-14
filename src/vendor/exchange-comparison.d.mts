// Types for exchange-comparison.mjs, gathered from its signatures.
import type { OilMarket } from './oil-market.mjs';
import type { HynixQuote } from './hynix-market.mjs';

export type SpreadMarket = 'oil' | 'hynix';
export type Exchange = 'hyperliquid' | 'bybit' | 'binance' | 'lighter' | 'variational' | 'okx' | 'bitget' | 'gate';
export const EXCHANGE_REFRESH_MS: number;
export const EXCHANGE_STALE_MS: number;
export const DISPLAY_EXCHANGES: Readonly<Record<SpreadMarket, readonly Exchange[]>>;
export const COMPARISON_EXCHANGES: Readonly<Record<SpreadMarket, readonly Exchange[]>>;
export function supportsExchange(market: string, exchange: string): boolean;
export const EXCHANGE_NAMES: Readonly<Record<Exchange, string>>;
export const EXCHANGE_CONTRACTS: Readonly<Record<SpreadMarket, { left: string; right: string; leftBase: string; rightBase: string; leftLabel: string; rightLabel: string; leftUnits: number }>>;
export interface ExchangeDefinition { left: string; right: string; currency: 'USD' | 'USDT' | 'USDC'; priceBasis: 'mid' | 'mark'; fundingPriceBasis: 'oracle' | 'index' | 'mark' }
export function exchangeDefinition(exchange: Exchange, market: SpreadMarket): ExchangeDefinition;

export interface ExchangeLeg {
  symbol: string; price: number; fundingPrice: number | null; fundingRate: number | null; fundingIntervalHours: number | null;
  nextFundingAt: string | null; nextFundingEstimated?: boolean;
}
export interface ExchangeQuote {
  exchange: Exchange; monitorId: SpreadMarket; currency: 'USD' | 'USDT' | 'USDC'; priceBasis: 'mid' | 'mark'; fundingPriceBasis: 'oracle' | 'index' | 'mark';
  fetchedAt: string;
  /** Absent or 'source': the venue's quote time; 'received': the time the service received the reply. */
  timestampBasis?: 'source' | 'received';
  fundingFetchedAt: string | null; status: 'live' | 'snapshot'; left: ExchangeLeg; right: ExchangeLeg; fundingError: string;
}
export interface ExchangeSpread { equivalent: number; spread: number; premium: number; shortAnnualized: number | null; longAnnualized: number | null }
export function calculateExchangeSpread(quote: ExchangeQuote): ExchangeSpread;
export function externalQuoteStale(quote: ExchangeQuote, now: number): boolean;
export function validateExchangeQuote(input: unknown, exchange: Exchange, monitorId: SpreadMarket): ExchangeQuote;

export function parseBybitQuote(monitorId: SpreadMarket, instruments: unknown, tickers: unknown, now?: number): ExchangeQuote;
export function bybitInstruments(response: unknown): Record<string, unknown>[];
export function checkedReply(exchange: 'okx' | 'bitget', response: unknown, symbol: string): unknown;
export function parseBinanceQuote(monitorId: SpreadMarket, tickers: unknown, fundingInfo: unknown, now?: number): ExchangeQuote;
export function binanceOilExchangeQuote(market: OilMarket, stale?: boolean): ExchangeQuote;
export function parseOkxQuote(monitorId: SpreadMarket, instruments: unknown, marks: unknown, funding: unknown, now?: number): ExchangeQuote;
export function parseBitgetQuote(monitorId: SpreadMarket, instruments: unknown, tickers: unknown, funding: unknown, now?: number): ExchangeQuote;
export function parseGateQuote(monitorId: SpreadMarket, details: unknown, receivedAt: number): ExchangeQuote;

export interface HyperliquidContext { coin: string; markPx: number; oraclePx: number; funding: number }
export function parseHyperliquidContexts(response: unknown, coins: readonly string[]): HyperliquidContext[];
export function hyperliquidOilQuote(response: unknown, receivedAt: number): ExchangeQuote;
export function hyperliquidHynixQuote(quote: HynixQuote, contexts: { contexts: HyperliquidContext[]; receivedAt: number } | null, stale?: boolean): ExchangeQuote;

export const LIGHTER_ORIGIN: string;
export const LIGHTER_SOCKET: string;
export interface LighterMarket { symbol: 'BRENTOIL' | 'WTI'; marketId: number }
export interface LighterObservation { marketId: number; sourceTime: number; leg: ExchangeLeg }
export function parseLighterOilMarkets(input: unknown): LighterMarket[];
export function parseLighterOilObservation(input: unknown, market: LighterMarket, now?: number): LighterObservation;
export function parseLighterOilQuote(observations: LighterObservation[], now?: number): ExchangeQuote;
export function readLighterOilSnapshot(markets: LighterMarket[], options?: { clock?: () => number; WebSocketImpl?: typeof WebSocket; timeoutMs?: number; signal?: AbortSignal }): Promise<ExchangeQuote>;
