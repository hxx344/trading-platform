// Types for perpetual-scanner-data-service.mjs (the workbench's perpetual-scanner-data.mjs, c84ba27).
import type { PerpetualFundingHistoryService } from './perpetual-funding-history-service.mjs';
import type { PerpetualMarketMetricsService } from './perpetual-market-metrics-service.mjs';
import type { PerpetualScannerDataReport } from './perpetual-scanner-data.ts';
import type { PerpetualMarket, PerpetualQuote } from './perpetual-stream.mjs';

export interface PerpetualScannerDataServiceOptions {
  getSnapshot: () => { quotes: PerpetualQuote[] } | null | undefined;
  getMarket: (exchange: string, symbol: string) => PerpetualMarket | undefined | null;
  marketMetrics: Pick<PerpetualMarketMetricsService, 'read'>;
  fundingHistory: Pick<PerpetualFundingHistoryService, 'read'>;
  clock?: () => number;
}
export interface PerpetualScannerDataService {
  /** Throws an Error with `status: 400` for an invalid batch. */
  read(input: unknown): PerpetualScannerDataReport;
}
export declare function createPerpetualScannerDataService(options: PerpetualScannerDataServiceOptions): PerpetualScannerDataService;
