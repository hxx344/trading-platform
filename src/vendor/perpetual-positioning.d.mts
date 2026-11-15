// Types for perpetual-positioning.mjs (the workbench's public long/short account ratio reads, c84ba27).
import type { PositioningRatio } from './perpetual-quality.ts';
import type { PerpetualQuote } from './perpetual-stream.mjs';

export interface PositioningFetchOptions {
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  signal?: AbortSignal; now?: number;
}
/** One request at most; null when the venue has no usable row. Rejects with `status` (429 / 403 / 502) and `retryAfterMs`. */
export type PositioningFetch = (quote: PerpetualQuote, options?: PositioningFetchOptions) => Promise<PositioningRatio | null>;
export declare const fetchPositioning: PositioningFetch;
/** Null when a public request is supported for this contract, otherwise the reason it is not. */
export declare function positioningUnavailableReason(quote: PerpetualQuote): string | null;
