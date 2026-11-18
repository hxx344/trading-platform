// Types for perpetual-market-metrics-service.mjs (the workbench's perpetual-market-metrics.mjs, c84ba27).
import type { PerpetualMarketMetricsReport } from './perpetual-market-metrics.ts';
import type { PerpetualMetricsReader } from './perpetual-metrics-reader.mjs';
import type { PerpetualMarket, PerpetualQuote } from './perpetual-stream.mjs';

/** The persisted entry (the cache store keeps it as gzip JSON, keyed by `key`, ordered by `lastAccessAt`). */
export interface PerpetualContractCacheEntry { key: string; lastAccessAt: number; [field: string]: unknown }
export interface PerpetualContractMetricsStore {
  loadContractMetrics(key?: string, limit?: number): PerpetualContractCacheEntry[];
  saveContractMetrics(entry: PerpetualContractCacheEntry): void;
}
export interface PerpetualMarketMetricsServiceOptions {
  getSnapshot: () => { quotes: PerpetualQuote[] } | null | undefined;
  getMarket?: (exchange: string, symbol: string) => PerpetualMarket | undefined | null;
  store?: PerpetualContractMetricsStore | null;
  clock?: () => number;
  reader?: ((...args: Parameters<PerpetualMetricsReader>) => ReturnType<PerpetualMetricsReader>) & Partial<Pick<PerpetualMetricsReader, 'stop' | 'retryAt' | 'isCached'>>;
  cacheLimit?: number; maxConcurrent?: number; hostSpacingMs?: number; intervalMs?: number;
}
export interface PerpetualMarketMetricsService {
  start(): void;
  stop(): Promise<void>;
  collect(): Promise<void>;
  /** Throws an Error with `status: 400` for an invalid batch. */
  read(input: unknown): PerpetualMarketMetricsReport;
  metrics(): { cached: number; inFlight: number; storageError: string };
}
export declare function perpetualMetricsIdentity(market: PerpetualMarket): string;
export declare function createPerpetualMarketMetricsService(options: PerpetualMarketMetricsServiceOptions): PerpetualMarketMetricsService;
