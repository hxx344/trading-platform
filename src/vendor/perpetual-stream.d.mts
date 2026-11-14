// Types for perpetual-stream.mjs, from the workbench's lib/perpetual-types.ts (c84ba27) and the functions' signatures.
export type PerpetualExchangeKind = 'cex' | 'dex';
export type PerpetualExchangeStatus = 'connecting' | 'live' | 'stale' | 'error' | 'disabled';
export type PerpetualStatus = 'live' | 'partial' | 'snapshot' | 'connecting' | 'unavailable';

export interface PerpetualExchange {
  id: string; name: string; kind: PerpetualExchangeKind; status: PerpetualExchangeStatus; marketCount: number; quoteCount: number;
  lastMessageAt: number | null; error: string | null; freshBookCount?: number; staleBookCount?: number; missingBookCount?: number;
}

/** One contract's public quote; prices per base asset (the contract multiplier taken out), rates decimal per interval, times epoch ms. */
export interface PerpetualQuote {
  exchange: string; symbol: string; base: string; quoteCurrency: string; multiplier?: number;
  bid: number | null; ask: number | null; mark: number | null; last: number | null;
  fundingRate: number | null; fundingIntervalHours: number | null; nextFundingAt: number | null;
  sourceTime: number | null; receivedAt: number; transport: 'ws' | 'rest';
  bidAt?: number; askAt?: number; bidAskAt?: number; markAt?: number; lastAt?: number; fundingAt?: number;
  fundingIntervalHoursUpdatedAt?: number; nextFundingAtUpdatedAt?: number;
  displayBase?: string; contractUnit?: string; collateralCurrency?: string; marketId?: number;
  historyIdentity?: string | null; comparable?: boolean; assetClass?: string | null; identitySource?: string | null; identityVerified?: boolean | null;
  delisting?: boolean; delistingAt?: number | null; takerFeeRate?: number | null; takerFeeAt?: number | null; takerFeeSource?: string | null;
}

export interface PerpetualSnapshot {
  schemaVersion: 1; monitorId: 'perpetual'; streamId: string; sequence: number; status: PerpetualStatus; generatedAt: number; staleAfterMs: number;
  exchanges: PerpetualExchange[]; quotes: PerpetualQuote[]; storageError?: string | null;
}
export type PerpetualQuoteChanges = { [K in keyof PerpetualQuote]?: PerpetualQuote[K] | null };
export interface PerpetualPatch extends Omit<PerpetualSnapshot, 'quotes'> {
  type: 'patch'; baseSequence?: number; patches: [string, PerpetualQuoteChanges][]; removed: string[];
}
export interface PerpetualDelta extends Omit<PerpetualSnapshot, 'quotes'> { type: 'delta'; updates: PerpetualQuote[]; removed: string[] }

/** A parser's partial update: the fields it carries replace older ones (by their own times). */
export type PerpetualUpdate = Partial<PerpetualQuote> & { exchange: string; symbol: string; base: string; quoteCurrency: string };
/** A contract from a venue's directory (discoverMarkets). */
export interface PerpetualMarket {
  id: string; exchange: string; symbol: string; base: string; quoteCurrency: string; multiplier?: number; contractUnit?: string;
  comparable?: boolean; delisting?: boolean; delistingAt?: number | null; [key: string]: unknown;
}

export const MAX_FUTURE_MS: number;
export const PERPETUAL_STALE_MS: number;
export function perpetualPriceIdentity(market: PerpetualMarket): string;
export function createPerpetualPatch(snapshot: PerpetualSnapshot, previous: Map<string, PerpetualQuote>, freshnessMs?: number): PerpetualPatch;
export function createPerpetualChangedPatch(metadata: Omit<PerpetualSnapshot, 'quotes'> | PerpetualSnapshot, quotes: Map<string, PerpetualQuote>, previous: Map<string, PerpetualQuote>, keys: Iterable<string>, freshnessMs?: number): PerpetualPatch;
export function createPerpetualDelta(snapshot: PerpetualSnapshot, previous: Map<string, PerpetualQuote>, freshnessMs?: number): PerpetualDelta;
export function mergePerpetualQuote(previous: PerpetualQuote | undefined, update: PerpetualUpdate, now?: number): PerpetualQuote | undefined;
export function withMarketMetadata(quote: PerpetualQuote, market: PerpetualMarket | undefined): PerpetualQuote;
