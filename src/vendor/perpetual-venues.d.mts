import type { PerpetualExchangeKind } from './perpetual-stream.mjs';
export interface PerpetualVenue { id: string; name: string; type: PerpetualExchangeKind; kind: PerpetualExchangeKind; website: string; docsUrl: string }
export const EXCHANGES: readonly PerpetualVenue[];
