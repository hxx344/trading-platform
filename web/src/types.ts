// The shape of GET /api/state as the page reads it (only the fields shown). The server owns the full contracts.
export type Side = 'long' | 'short';
export type Direction = 'long' | 'short';

export interface Account { venue: string; accountMode: string; accountId: string; credentialVersion: number | string }
export interface Balance { available: string; equity: string; maxWithdraw: string }
export interface TransferView {
  id: string; pairId: string; sourceSide: Side; destinationSide: Side; amount: string; asset: string; state: string;
  readyAt: number | null; recovered: boolean; preparedAt: number; basis: string | null; receipt: string | null; labelNote: string | null; note: string | null;
}
export interface PairView {
  id: string; mainAccountId: string; enabled: boolean; long: string; short: string; balances: Record<Side, Balance> | null;
  blocked: string | null; cooldownUntil: number; note: string | null; current: TransferView | null;
}
export interface PositionRow { symbol: string; direction: Direction; positionSide: string; quantity: string; entryPrice: string; markPrice: string; notional: string; unrealizedProfit: string; updateTime: number }
export interface PositionSideView { account: string; state: 'pending' | 'fresh' | 'retained' | 'unavailable'; sampledAt: number | null; ageMs: number; note: string | null; positions: PositionRow[] }
export interface PositionTotal { symbol: string; long: string; short: string; total: string; balanced: boolean | null; gapPercent: string }
export interface PositionsPair { pairId: string; enabled: boolean; long: PositionSideView; short: PositionSideView; totals: PositionTotal[] | null; verdictNote: string | null }
export interface PositionsView { available: boolean; refreshMs: number; maxAgeMs: number; checkedAt: number | null; pairs: PositionsPair[] }

export interface AdlProgress { status: string; residual: string; direction: Direction | null; reason?: string }
export interface AdlBatch {
  side: Side; account: string; symbol: string; positionSide: string; orderSide: 'buy' | 'sell'; quantity: string; filledQuantity: string | null; averagePrice: string | null;
  state: string; recovered: boolean; cancelRequested: boolean; note: string | null; sentAt: number | null; preparedAt: number;
}
export interface AdlEvidence { side: Side; symbol: string; positionSide: string | null; filledQuantity: string; conflict: string | null }
export interface AdlIncident {
  id: string; parentId: string | null; status: string; symbols: string[]; activeMs: number; batchesSinceRestart: number; restarts: number; watchUntil: number | null;
  reason: string; residuals: { symbol: string; direction: Direction; quantity: string }[]; evidence: AdlEvidence[]; progress: Record<string, AdlProgress> | null;
  batches: AdlBatch[]; createdAt: number; closedAt: number | null; totalBatches: number;
}
export interface AdlScan { coveredUntil: number | null; pendingWindows: number; note: string | null }
export interface AdlPairView {
  pairId: string; long: string; short: string; shared: string | null; config: { autoReduce: boolean; batchNotional: string };
  scans: Record<Side, AdlScan> | null; incident: AdlIncident | null;
}

export interface ServiceState {
  generation: number; retired: boolean; transport: string; accounts: Account[];
  notionalLimits: { perJob: string; openUsed: string; totalOpen: string } | null;
  transfers: { pairs: PairView[]; corruptPairs: string[]; recent: TransferView[] };
  adl: { pairs: AdlPairView[]; recent: AdlIncident[] };
  positions: PositionsView;
}
