import type { PerpetualQuote } from './perpetual-stream.mjs';
import type { PerpetualExecutionService } from './perpetual-depth.mjs';

export interface MarketDepthBook {
  exchange: string; symbol: string; base: string; quoteCurrency: string; source: string; sourceTime: number | null; receivedAt: number;
  transport: string; bids: [number, number][]; asks: [number, number][];
}
export type MarketDepthResult = MarketDepthBook | { reason: string };
export function createPerpetualEstimates(options: {
  getQuote(exchange: string, symbol: string): PerpetualQuote | undefined;
  books(legs: PerpetualQuote[]): Promise<MarketDepthResult[]>;
  fx: PerpetualExecutionService['fx']; clock?: () => number;
}): Pick<PerpetualExecutionService, 'depth' | 'exit' | 'fx'>;
