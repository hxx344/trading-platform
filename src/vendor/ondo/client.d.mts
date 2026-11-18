// Types for client.mjs, only what the service's TypeScript uses.
export const ONDO_MARKET: RegExp;
export class OndoError extends Error {
  code: string; status: number | null; uncertain: boolean; retryAt: number | null;
  constructor(code: string, options?: { status?: number | null; uncertain?: boolean; retryAt?: number | null });
}
export interface OndoRules { tick: string; step: string; trading: boolean; makerFee: string | null }
/** Levels as the venue sends them: [price, size] decimal strings (or numbers), bids best first, asks best first. */
export interface OndoDepth { market: string; time?: unknown; bids?: unknown; asks?: unknown }
export interface OndoClient {
  cooldownUntil(): number;
  markets(signal?: AbortSignal): Promise<Map<string, OndoRules>>;
  depth(market: string, levels?: number, signal?: AbortSignal): Promise<OndoDepth>;
  close(): void;
}
export function createOndoClient(options?: {
  latency?: import('./latency.mjs').OndoLatencyObserver;
  credentials?: { keyId: string; secret: string } | null; fetchImpl?: typeof fetch; now?: () => number; timeoutMs?: number; rps?: number; cooldownUntil?: number;
}): OndoClient;
