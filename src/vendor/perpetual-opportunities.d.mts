import type { PerpetualMarket, PerpetualSnapshot } from './perpetual-stream.mjs';
import type { CrossExFilter } from './perpetual-crossex-service.mjs';
import type { PerpetualOpportunities } from './perpetual-opportunities.ts';
export type PerpetualMarketLookup = (exchange: string, symbol: string) => PerpetualMarket | undefined;
export function createPerpetualOpportunities(snapshot: PerpetualSnapshot, now: number, getMarket: PerpetualMarketLookup, filter: CrossExFilter): PerpetualOpportunities;
