// Types for perpetual-funding-history-service.mjs (the workbench's perpetual-funding-history.mjs, c84ba27).
import type { PerpetualFundingHistoryReport } from './perpetual-funding-history.ts';
import type { PerpetualFundingReader } from './perpetual-funding-reader.mjs';
import type { PerpetualContractCacheEntry } from './perpetual-market-metrics-service.mjs';
import type { PerpetualMarket, PerpetualQuote } from './perpetual-stream.mjs';

/** Both optional, as the service calls them (`store?.loadFundingHistory?.(...)`). */
export interface PerpetualFundingHistoryStore {
  loadFundingHistory?(key?: string, limit?: number): PerpetualContractCacheEntry[];
  saveFundingHistory?(entry: PerpetualContractCacheEntry): void;
}
export interface PerpetualFundingHistoryServiceOptions {
  getSnapshot: () => { quotes: PerpetualQuote[] };
  getMarket?: (exchange: string, symbol: string) => PerpetualMarket | undefined | null;
  store?: PerpetualFundingHistoryStore | null;
  clock?: () => number;
  reader?: PerpetualFundingReader;
  cacheLimit?: number; maxConcurrent?: number; hostSpacingMs?: number;
}
export interface PerpetualFundingHistoryService {
  start(): void;
  stop(): Promise<void>;
  collect(): Promise<void>;
  /** Throws an Error with `status: 400` for an invalid batch. */
  read(input: unknown): PerpetualFundingHistoryReport;
  metrics(): { cached: number; inFlight: number; backfilling: number; storageError: string };
}
export declare function createPerpetualFundingHistoryService(options: PerpetualFundingHistoryServiceOptions): PerpetualFundingHistoryService;
