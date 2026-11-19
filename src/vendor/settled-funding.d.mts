// Types for settled-funding.mjs, gathered from its signatures.
export type FundingFetcher = (url: string, init: RequestInit) => Promise<Response>;

export const HOUR: number;
export const OIL_FUNDING_HOURS: 4;
export const OIL_FUNDING_MS: number;
export const OIL_FIRST_SETTLEMENT: number;
export const HYNIX_FUNDING_MS: number;
export const HYNIX_FIRST_SETTLEMENT: number;

/** One oil settlement (`time` = the four-hour grid point), each leg's settled rate or null when that leg has none. */
export interface OilFundingRow { time: number; brent: number | null; wti: number | null }
/** One Hynix settlement hour (xyz:SKHY = adr, xyz:SKHX = ordinary). */
export interface HynixFundingRow { time: number; adr: number | null; ordinary: number | null }

export function pairOilFunding(brent: unknown, wti: unknown, now: number): OilFundingRow[];
export function validateOilFundingRows(rows: unknown, fetchedAt: string): OilFundingRow[];
export function validateHynixFundingRows(rows: unknown, fetchedAt: string): HynixFundingRow[];
export function fetchOilFundingHistory(symbol: string, startTime: number, endTime: number, options?: { fetcher?: FundingFetcher; timeout?: number; pageSize?: number }): Promise<unknown[]>;
export function pairHynixFunding(adrRecords: readonly unknown[], ordinaryRecords: readonly unknown[], now: number): HynixFundingRow[];
export function fetchHynixFundingRecords(coin: string, startTime: number, endTime: number, options?: { fetcher?: FundingFetcher; timeout?: number }): Promise<{ coin: string; time: number; fundingRate: number }[]>;
export function mergeFundingRows<Row extends { time: number }>(previous: readonly Row[], fetched: readonly Row[], legs: readonly (keyof Row & string)[]): Row[];
import type { FundingFact, FundingSide, FundingHistoryRange } from './exchange-funding-history.mjs';
type FundingFactReader = (side: FundingSide, range: FundingHistoryRange, options: { fetcher: FundingFetcher; timeout?: number }) => Promise<FundingFact[]>;
export const fetchOilFundingFacts: FundingFactReader;
export const fetchHynixFundingFacts: FundingFactReader;
export function projectOilFunding(left: FundingFact[], right: FundingFact[], at: number): OilFundingRow[];
export function projectHynixFunding(left: FundingFact[], right: FundingFact[], at: number): HynixFundingRow[];

export interface FundingChartPoint {
  time: number; shortRate: number | null; longRate: number | null; shortCumulative: number | null; longCumulative: number | null;
  shortAnnualized: number | null; longAnnualized: number | null; adr: number | null; ordinary: number | null; count: number;
}
export interface SettledFundingAnalysis {
  chart: FundingChartPoint[]; count: number; expectedHours: number; missingHours: number; firstTime: number | null; lastTime: number | null;
  shortCumulative: number | null; longCumulative: number | null; shortAnnualized: number | null; longAnnualized: number | null;
  latestShortRate: number | null; latestLongRate: number | null;
}
export function analyzeSettledFunding(rows: readonly { time: number; adr: number | null; ordinary: number | null }[], days: number | null, endTime: number, options: { intervalMs: number; firstSettlement: number }): SettledFundingAnalysis;
