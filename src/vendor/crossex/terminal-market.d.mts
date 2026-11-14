// Types for terminal-market.mjs, only what the service's TypeScript uses; loose on purpose.
import type { CrossexMarket } from './market.mjs';
export const INTERVALS: Readonly<Record<string, number>>;
export interface CrossexTerminalMarket {
  read(symbol: string | null, interval: string): Promise<unknown>;
  stop(): Promise<void>;
}
export function createCandleReader(options?: { fetcher?: (url: string, init?: RequestInit) => Promise<Response>; clock?: () => number }): unknown;
export function createTerminalMarket(options: { market: CrossexMarket; depthReader?: unknown; candleReader?: unknown; WebSocketImpl?: unknown; clock?: () => number }): CrossexTerminalMarket;
