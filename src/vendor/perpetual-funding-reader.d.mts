// Types for perpetual-funding-reader.mjs (the workbench's funding reader, c84ba27): only what the history service calls.
import type { FundingHistoryRange, SettledFundingRecord } from './exchange-funding-history.mjs';
import type { PerpetualMarket } from './perpetual-stream.mjs';

export interface PerpetualFundingReaderOptions {
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  clock?: () => number; requestSpacingMs?: number;
}
export type PerpetualFundingReader = (market: PerpetualMarket, range: FundingHistoryRange, options?: {
  signal?: AbortSignal; onProgress?: (progress: { coverage: FundingHistoryRange; records: SettledFundingRecord[] }) => void;
}) => Promise<SettledFundingRecord[]>;
export declare function createPerpetualFundingReader(options?: PerpetualFundingReaderOptions): PerpetualFundingReader;
