// Types for perpetual-paper-service.mjs (the workbench's paper-position service, c84ba27).
// The collector's quotes (perpetual-stream.mjs), as the depth service's declaration takes them.
import type { PerpetualQuote } from './perpetual-stream.mjs';
import type { PerpetualPaperObservation, PerpetualPaperPosition, PerpetualPaperState, PerpetualPaperView } from './perpetual-paper.ts';

/** What the service needs of its store: the last saved state, and an atomic save that rejects on failure. */
export interface PerpetualPaperStore {
  get(): PerpetualPaperState;
  save(next: PerpetualPaperState): Promise<void>;
}
export interface PerpetualPaperServiceOptions {
  /** Absent: the service is unavailable (`available: false`), every update answers 503 with `unavailableReason`. */
  store?: PerpetualPaperStore | undefined;
  unavailableReason?: string;
  /** The current quote of `exchange:symbol`. */
  getQuote?: (key: string) => PerpetualQuote | undefined;
  /** Whether the venue has a connection open now. */
  isVenueLive?: (exchange: string) => boolean;
  clock?: () => number;
}
export interface PerpetualPaperMetrics {
  observations: number; writes: number; writeFailures: number; active: number; closed: number; samplePoints: number; storageError: string;
}
export interface PerpetualPaperService {
  view(): PerpetualPaperView;
  /** A minute observation of every active position (throttled to one a minute; a no-op while stopped or without a store). */
  check(): Promise<void>;
  /**
   * `create` / `update` / `close` / `delete` at `revision`; answers the new view. Refusals are Errors with `status` 400, 404,
   * 409 or 503; the exit calculator's input checks throw plain Errors (the workbench answers those 400 too).
   */
  update(input: unknown): Promise<PerpetualPaperView>;
  start(): void;
  /** Stops the minute observations and waits for the queued writes. */
  stop(): Promise<void>;
  healthy(): boolean;
  metrics(): PerpetualPaperMetrics;
}
export declare const initialPerpetualPaperState: () => PerpetualPaperState;
export declare function evaluatePerpetualPaperPosition(position: PerpetualPaperPosition, getQuote: (key: string) => PerpetualQuote | undefined, now: number, isVenueLive?: (exchange: string) => boolean): PerpetualPaperObservation;
export declare function createPerpetualPaperService(options?: PerpetualPaperServiceOptions): PerpetualPaperService;
