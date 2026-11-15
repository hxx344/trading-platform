// Types for perpetual-price-reader.mjs (the workbench's price reader, c84ba27): only what the history service and tests call.
import type { PerpetualPricePoint } from './perpetual-price-history.ts';
import type { PerpetualMarket } from './perpetual-stream.mjs';

export interface PerpetualPriceRange { from: number; to: number }
export interface PerpetualPriceReaderOptions {
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  clock?: () => number; requestSpacingMs?: number;
}
export type PerpetualPriceReader = (market: PerpetualMarket, range: PerpetualPriceRange, options?: { signal?: AbortSignal }) => Promise<PerpetualPricePoint[]>;
export declare function normalizePerpetualPriceCandles(exchange: string, rows: unknown, market: PerpetualMarket, range: PerpetualPriceRange, now: number): PerpetualPricePoint[];
export declare function createPerpetualPriceReader(options?: PerpetualPriceReaderOptions): PerpetualPriceReader;
