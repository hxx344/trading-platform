import type { Exchange, LighterMarket, SpreadMarket } from './exchange-comparison.mjs';

export declare const HISTORY_REFRESH_MS: number;
export declare const HISTORY_STALE_MS: number;
export declare const HISTORY_WINDOW_MS: number;
export declare const HISTORY_PAGE_SIZE: number;
export declare const HISTORY_LEG_LIMIT: number;

export type FundingHistoryRange = { from: number; to: number };
export type SettledFundingRecord = { time: number; rate: number };
export type FundingHistoryLeg = { symbol: string; fetchedAt: string | null; error: string; coverage: FundingHistoryRange | null };
export type ExchangeFundingHistory = {
  exchange: Exchange;
  monitorId: SpreadMarket;
  currency: 'USD' | 'USDT' | 'USDC';
  fetchedAt: string;
  status: 'live' | 'snapshot';
  reason: string;
  left: FundingHistoryLeg;
  right: FundingHistoryLeg;
  rows: Array<{ time: number; leftRate: number | null; rightRate: number | null }>;
};
export type FundingRangeLeg = {
  records: SettledFundingRecord[];
  count: number;
  rawRate: number | null;
  positionRate: number | null;
  coverage: 'queried' | 'partial' | 'unknown';
  fetchedAt: string | null;
  error: string;
};
export type FundingRequest = (url: string, init?: RequestInit) => Promise<unknown>;
export type FundingLegReader = (exchange: Exchange, symbol: string, range: FundingHistoryRange) => Promise<SettledFundingRecord[]>;

export declare function fundingHistoryExchanges(market: SpreadMarket): readonly Exchange[];
export declare function supportsFundingHistory(market: string, exchange: string): boolean;
export declare function normalizeSettledFunding(records: SettledFundingRecord[], now: number): SettledFundingRecord[];
export declare function validateExchangeFundingHistory(input: unknown, exchange: Exchange, monitorId: SpreadMarket): ExchangeFundingHistory;
export declare function fundingRangeInput(time: number): string;
export declare function parseFundingRangeInput(input: string): number | null;
export declare function analyzeFundingRange(history: ExchangeFundingHistory, range: FundingHistoryRange, direction: 'short' | 'long'): { left: FundingRangeLeg; right: FundingRangeLeg };
export declare function parseCexFundingHistory(exchange: 'binance' | 'bybit' | 'okx' | 'bitget', symbol: string, input: unknown, now?: number): SettledFundingRecord[];
export declare function parseHyperliquidFundingHistory(input: unknown, symbol: string, now: number): SettledFundingRecord[];
export declare function parseLighterFundingHistory(input: unknown, marketId: number, now: number): SettledFundingRecord[];
export declare function parseGateFundingHistory(input: unknown, now: number): SettledFundingRecord[];
export declare function createFundingLegReader(options: { request: FundingRequest; clock?: () => number; lighterMarkets: () => Promise<LighterMarket[]> }): FundingLegReader;
export declare function mergeFundingHistory(options: { exchange: Exchange; monitorId: SpreadMarket; previous?: ExchangeFundingHistory | null; readLeg: FundingLegReader; clock?: () => number }): Promise<ExchangeFundingHistory>;
