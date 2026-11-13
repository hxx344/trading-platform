// The shape of GET /api/state as the page reads it (only the fields shown). The server owns the full contracts.
export type Side = 'long' | 'short';
export type Direction = 'long' | 'short';

export interface Account { venue: string; accountMode: string; accountId: string; credentialVersion: number | string }
export interface Balance { available: string; equity: string; maxWithdraw: string; receivedAt: number }
export interface TransferView {
  id: string; pairId: string; sourceSide: Side; destinationSide: Side; amount: string; asset: string; state: string;
  readyAt: number | null; recovered: boolean; preparedAt: number; basis: string | null; receipt: string | null; labelNote: string | null; note: string | null;
  sentAt: number | null; ackAt: number | null; tranId: string | null; evidence: number; baseline: ('source' | 'destination')[]; settledAt: number | null; balancesRefreshedAt: number | null;
}
export interface PairView {
  id: string; mainAccountId: string; enabled: boolean; long: string; short: string; balances: Record<Side, Balance> | null;
  blocked: string | null; cooldownUntil: number; note: string | null; current: TransferView | null;
  config: TransferConfig; nextCheckAt: number; noteIdle: boolean; balancesFresh: boolean;
}
export interface TransferConfig {
  threshold: string; minTransfer: string; maxTransfer: string; bufferRatio: string; longReserve: string; shortReserve: string; cooldownMs: number; checkIntervalMs: number;
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
  /** The lifetime form without oil; the rolling 24-hour form when oil is configured. */
  notionalLimits: { perJob: string; openUsed: string; totalOpen: string } | { perJob: string; openUsed: string; openPer24h: string; windowMs: number; nextReleaseAt: number | null } | null;
  transfers: { pairs: PairView[]; corruptPairs: string[]; recent: TransferView[] };
  adl: { pairs: AdlPairView[]; recent: AdlIncident[] };
  positions: PositionsView;
}

// ---- the read-only detail endpoints -------------------------------------------------
/** A row the server could not parse keeps its place in the paging. */
export interface Unreadable { id: string; pairId: string; unreadable: true; preparedAt?: number; createdAt?: number }
export interface HistoryPage<T> { items: (T | Unreadable)[]; next: string | null }
export interface BalancePoint { at: number; long: { available: string; equity: string }; short: { available: string; equity: string }; fresh: boolean }
export interface BalanceHistory { pairId: string; range: string; from: number; to: number; bucketMs: number; sampleEveryMs: number; points: BalancePoint[]; unavailable?: string }

export interface LoopStatus { name: string; lastOkAt: number | null; failures: number; lastError: string | null; lastErrorAt: number | null }
export interface StreamStatus { account: string; connected: boolean; since: number | null; lastMessageAt: number | null; disconnects: number; lastError: string | null; lastErrorAt: number | null }
export interface OutboxRow { id: number; createdAt: number; text: string; attempts: number; nextAt: number; sentAt: number | null; lastError: string | null }
export interface ServiceStatus {
  health: {
    startedAt: number; now: number; generation: number; retired: boolean; schemaVersion: number; walBytes: number; walLimitBytes: number;
    writes: { transactions: number; busy: number; waitBucketsMs: number[]; waitBuckets: number[]; maxWaitMs: number; maxHoldMs: number };
    loops: LoopStatus[];
  };
  /** The pairs' idle weight at their stored check intervals against the limit less the ADL reserve. */
  idleWeight?: { needed: number; available: number; limitPerMinute: number; adlReserve: number };
  budget?: { usedLastMinute: number; limitPerMinute: number; adlReserve: number; ipUsedThisMinute: number | null; ipCeiling: number; ipCeilingAdl: number; coolingUntil: number | null; reason: string | null };
  streams?: StreamStatus[];
  feishu?: { configured: boolean; pending: number; retrying: number; lastSentAt: number | null; lastError: string | null; nextRetryAt: number | null; retentionMs: number; recent: OutboxRow[] };
  summary?: SummaryStatus;
  samples?: { available: boolean; error: string | null };
}

/** One line of the service log (GET /api/logs). */
export interface LogLine { id: string; at: number; level: 'alert' | 'problem' | 'info'; text: string }

/** The scheduled summary card's schedule (GET /api/status, and the answer to its two writes). */
export interface SummaryStatus {
  enabled: boolean;
  /** In effect: the page's value once set, else config.json's. */
  intervalMinutes: number;
  configIntervalMinutes: number;
  fromPage: boolean;
  robot: 'scheduled' | 'event' | null;
  nextDueAt: number | null;
  lastSentAt: number | null;
  lastSentRobot: 'scheduled' | 'event' | null;
  lastError: string | null;
  lastErrorAt: number | null;
}
