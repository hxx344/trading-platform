// Types for perpetual-quality-service.mjs (the workbench's quality service, c84ba27).
import type { PerpetualQualityReport } from './perpetual-quality.ts';
import type { FundamentalsClient } from './perpetual-fundamentals.mjs';
import type { PositioningFetch } from './perpetual-positioning.mjs';
import type { PerpetualSnapshot } from './perpetual-stream.mjs';

/** One minute's ranked rows: [base, longKey, shortKey, identity, spread %, long funding 8h %, short funding 8h %]. */
export type QualitySampleRow = [string, string, string, string, number | null, number | null, number | null];
export interface QualitySample { bucket: number; rows: QualitySampleRow[] | unknown[] }
/** Both optional, as the service calls them (`store?.saveQualitySample?.(...)`). */
export interface PerpetualQualityStore {
  loadQualitySamples?(now: number): Iterable<QualitySample>;
  saveQualitySample?(bucket: number, rows: unknown[]): void;
}
export interface PerpetualQualityServiceOptions {
  /** The workbench's snapshot shape: status, staleAfterMs, exchanges (id, status) and quotes. */
  getSnapshot: () => Pick<PerpetualSnapshot, 'status' | 'staleAfterMs' | 'exchanges' | 'quotes'>;
  store?: PerpetualQualityStore | null;
  clock?: () => number;
  fundamentals?: FundamentalsClient;
  positioningFetch?: PositioningFetch;
  shouldDeferAuxiliary?: () => boolean;
}
export interface PerpetualQualityService {
  /** Throws a plain Error for an invalid batch (over 30 pairs, or a pair with a missing or overlong field). */
  read(input: unknown): PerpetualQualityReport;
  start(): void;
  stop(): Promise<void>;
  collectSample(): void;
  collectFundamentals(): Promise<void>;
  collectPositioning(): Promise<void>;
  metrics(): { trackedPairs: number; pricePoints: number; fundingPoints: number; convergencePoints: number; watchedPairs: number; positioningCache: number; restoring: boolean; metadataRetryAt: number; auxiliaryDeferredAt: number | null; error: string | null };
}
export declare function createPerpetualQualityService(options: PerpetualQualityServiceOptions): PerpetualQualityService;
