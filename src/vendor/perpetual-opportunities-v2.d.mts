import type { PerpetualSnapshot } from './perpetual-stream.mjs';
import type { CrossExFilter } from './perpetual-crossex-service.mjs';
import type { PerpetualOpportunitiesV2 } from './perpetual-opportunities.ts';
import type { PerpetualFxSnapshot } from './perpetual-fx.ts';
import type { PerpetualMarketLookup } from './perpetual-opportunities.mjs';
export function createOpportunitiesV2Reader(): (snapshot: PerpetualSnapshot, now: number, getMarket: PerpetualMarketLookup, fx: PerpetualFxSnapshot | null, sourceVersion: number, filter: CrossExFilter) => PerpetualOpportunitiesV2;
