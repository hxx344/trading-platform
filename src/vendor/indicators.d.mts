// Types of indicators.mjs, from the workbench's lib/indicators.ts (8bc3bee).
export declare const INDICATOR_PERIODS: { sma: number; bands: number };
export type SpreadMetric = 'premium' | 'spread';
export type IndicatorFields = {
  sma: number | null;
  basis: number | null;
  upper: number | null;
  lower: number | null;
  band: [number, number] | null;
  zscore: number | null;
  deviation: number | null;
  consecutiveHours: number;
};
export type IndicatorPoint<T> = T & IndicatorFields;
/**
 * Includes the current closed bar; requires complete, consecutive windows. `periods` count bars of `intervalMs`
 * (hourly by default); throws unless both are integers of at least two.
 */
export declare function calculateIndicators<T extends { time: number; premium: number; spread: number }>(
  points: readonly T[], metric: SpreadMetric, periods?: { sma: number; bands: number }, intervalMs?: number,
): IndicatorPoint<T>[];
