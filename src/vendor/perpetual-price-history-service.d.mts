// Types for perpetual-price-history-service.mjs (the workbench's perpetual-price-history.mjs, c84ba27).
import type { PerpetualPriceHistoryReport } from './perpetual-price-history.ts';
import type { PerpetualPriceReader } from './perpetual-price-reader.mjs';
import type { PerpetualContractCacheEntry } from './perpetual-market-metrics-service.mjs';
import type { PerpetualMarket, PerpetualQuote } from './perpetual-stream.mjs';

/** Both optional, as the service calls them (`store?.loadPriceHistory?.(...)`). */
export interface PerpetualPriceHistoryStore {
  loadPriceHistory?(key?: string, limit?: number): PerpetualContractCacheEntry[];
  savePriceHistory?(entry: PerpetualContractCacheEntry): void;
}
export interface PerpetualPriceHistoryServiceOptions {
  getSnapshot: () => { quotes: PerpetualQuote[] };
  getMarket?: (exchange: string, symbol: string) => PerpetualMarket | undefined | null;
  store?: PerpetualPriceHistoryStore | null;
  clock?: () => number;
  reader?: PerpetualPriceReader;
  cacheLimit?: number; maxConcurrent?: number; hostSpacingMs?: number; activeLeaseMs?: number;
}
export interface PerpetualPriceHistoryService {
  start(): void;
  stop(): Promise<void>;
  collect(): Promise<void>;
  /** Throws an Error with `status: 400` for an invalid pair or window. */
  read(input: unknown): PerpetualPriceHistoryReport;
  metrics(): { cached: number; inFlight: number; storageError: string };
}
export declare function createPerpetualPriceHistoryService(options: PerpetualPriceHistoryServiceOptions): PerpetualPriceHistoryService;
