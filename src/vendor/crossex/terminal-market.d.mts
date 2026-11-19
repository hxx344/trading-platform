// Types for terminal-market.mjs, only what the service's TypeScript uses; loose on purpose.
import type { CrossexMarket } from './market.mjs';
export { INTERVALS } from './terminal-data.mjs';
export interface CrossexTerminalMarket {
  read(symbol: string | null, interval: string): Promise<unknown>;
  stop(): Promise<void>;
}
export { createCandleReader } from './candle-reader.mjs';
export function createTerminalMarket(options: { market: CrossexMarket; store?: import('../../crossex/store.ts').CrossexStore; depthReader?: unknown; candleReader?: unknown; publicFeed?: import('./terminal-feed.mjs').TerminalFeed; WebSocketImpl?: unknown; clock?: () => number }): CrossexTerminalMarket;
