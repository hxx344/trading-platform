// Types for perpetual-exchanges.mjs, gathered from its signatures and the subscription specs it returns.
import type { PerpetualMarket, PerpetualUpdate } from './perpetual-stream.mjs';

export { EXCHANGES, type PerpetualVenue } from './perpetual-venues.mjs';
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
export interface PerpetualRequestOptions { fetchImpl?: Fetcher; signal?: AbortSignal; now?: number }
/** One WebSocket connection's plan (exchanges.mjs createSubscriptions). */
export interface PerpetualSpec {
  url: string; markets: PerpetualMarket[]; subscribe?: unknown[]; context?: Record<string, unknown>; headers?: Record<string, string>;
  sendIntervalMs?: number; startDelayMs?: number; heartbeat?: unknown; heartbeatMs?: number;
  poll?: { messages: { request?: { payload?: { coin?: string } } }[]; intervalMs?: number; sendIntervalMs?: number; staleBookAfterMs?: number; maxPerMinute?: number };
  snapshot?: (options: PerpetualRequestOptions) => Promise<PerpetualUpdate[]>; snapshotIntervalMs?: number;
}

export function discoverMarkets(exchangeId: string, options?: PerpetualRequestOptions): Promise<PerpetualMarket[]>;
export function createSubscriptions(exchangeId: string, markets: PerpetualMarket[]): PerpetualSpec[];
export function getControlResponse(exchangeId: string, payload: unknown): unknown;
export function parseMessage(exchangeId: string, payload: unknown, markets: PerpetualMarket[], receivedAt?: number, context?: Record<string, unknown>): PerpetualUpdate[];
export function fetchBookSnapshots(exchangeId: string, markets: PerpetualMarket[], options?: PerpetualRequestOptions): Promise<PerpetualUpdate[]>;
