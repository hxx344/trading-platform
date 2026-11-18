// Types for perpetual-metrics-reader.mjs (the workbench's metrics reader, c84ba27): only what this service calls.
import type { PerpetualMarketMetric } from './perpetual-market-metrics.ts';
import type { PerpetualMarket } from './perpetual-stream.mjs';

export interface PerpetualMetricsReaderOptions {
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  clock?: () => number; cacheMs?: number; cacheLimit?: number; maxConcurrent?: number; hostSpacingMs?: number;
}
export interface PerpetualMetricsReading { volume24h: PerpetualMarketMetric; openInterest: PerpetualMarketMetric; readerState?: unknown }
export interface PerpetualMetricsReader {
  (market: PerpetualMarket, options: { signal: AbortSignal; readerState?: unknown }): Promise<PerpetualMetricsReading>;
  isCached(market: PerpetualMarket): boolean;
  cachedUntil?(market: PerpetualMarket): [string, number][];
  retryAt(market: PerpetualMarket): number;
  stop(): void;
  metrics(): { cacheEntries: number; queued: number; inFlight: number; candleEntries: number };
}
export declare function sanitizePerpetualMetricsReaderState(state: unknown, market: PerpetualMarket, now: number): unknown;
export declare function createPerpetualMetricsReader(options?: PerpetualMetricsReaderOptions): PerpetualMetricsReader;
export declare const createPerpetualMarketMetricsReader: typeof createPerpetualMetricsReader;

export declare function perpetualMetricsCacheKeys(market: PerpetualMarket, now: number): string[];
