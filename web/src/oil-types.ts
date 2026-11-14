// The shapes of the oil reads (GET /api/oil/market, /api/oil/state) and of a preview, as the oil page reads them.
import type { Account } from './types.ts';
import type { OilIntent } from './oil-form.ts';

export interface OilBook { venue: string; symbol: string; bid: string | null; ask: string | null; receivedAt: number | null; failedAt: number | null; error: string | null }
export interface OilMarket {
  now: number; readAt: number | null; readEveryMs: number; timeoutMs: number;
  books: OilBook[];
  /** sell: BZ bid − CL ask (what selling the spread gets); buy: BZ ask − CL bid (what buying it costs). */
  sameExchange: { venue: string; sell: string | null; buy: string | null; receivedAt: number | null }[];
  crossExchange: { symbol: string; binanceOverBybit: string | null; bybitOverBinance: string | null; receivedAt: number | null }[];
}
export interface OilPositionAccount {
  venue: string; accountId: string; accountMode: string;
  long: Record<string, string> | null; short: Record<string, string> | null; openOrders: number | null;
  receivedAt: number | null; failedAt: number | null; error: string | null;
}
export interface OilLimits { perJob: string; openPer24h: string; openUsed: string; windowMs: number; nextReleaseAt: number | null }
export interface OilOperation {
  kind: string; clientOrderId: string; state: string; quantity: string; limitPrice?: string | null; filledQuantity: string; averagePrice: string | null; remoteId: string | null;
  strategyStatus: string | null; childrenSettled: boolean | null; adoptedAt: number | null; releasedAt: number | null; ackStrategyId: string | null; note: string | null;
}
export interface OilJobLeg {
  venue: string; symbol: string; side: string; orderSide: string; orderType: string; plannedQuantity: string; accountId: string; priceBound: string | null; limitPrice?: string | null;
  contractSize: string; plannedBarrels: string; filledBarrels: string; averagePrice: string | null; previewQuote: { bid: string; ask: string };
  attempts: number; filledQuantity: string; operation: OilOperation | null;
}
export interface OilJob {
  id: string; preset: 'same-exchange' | 'cross-exchange'; action: 'open' | 'close'; status: string; reason: string | null; stopRequested: boolean;
  createdAt: number; deadlineAt: number; holdNewSends: boolean; locked: boolean; acknowledgedAt: number | null; strategyPending: boolean;
  /** current: 1-based batch of the latest lead order, 0 before the first; null when the job is not batched. */
  batches?: { count: number; current: number; intervalMs: number } | null;
  legs: OilJobLeg[]; events: { type: string; at: number; [key: string]: unknown }[];
}
export interface OilState {
  accounts: Account[];
  positions: { readAt: number | null; readEveryMs: number; timeoutMs: number; accounts: OilPositionAccount[] };
  jobs: OilJob[];
  notionalLimits: OilLimits | null;
}
export interface OilPreviewLeg {
  index: number; venue: string; symbol: string; side: string; orderSide: string; quantity: string; orderType: string; reduceOnly: boolean;
  accountId: string; accountMode: string; priceBound?: string | null; limitPrice?: string | null; chaseCeiling?: string; instrument: { contractSize: string; quantityStep: string };
  quote: { bid: string; ask: string; receivedAt: number };
}
/** batches: the lead quantity of each batch, when the intent asked for more than one. */
export interface OilPreview { id: string; expiresAt: number; intent: OilIntent; legs: OilPreviewLeg[]; notional: string; barrels?: string; batches?: string[]; notes: string[] }
export interface OilConfirmResult { accepted: boolean; duplicate: boolean; job: OilJob }

/** GET /api/oil/pnl (docs/oil.md section 9): amounts are USDT decimal strings; null where the ledgers do not reach. */
export interface OilPnlPoint { time: number; unrealizedPnl: string | null; fundingPnl: string | null; realizedPnl: string | null; feePnl: string | null; totalPnl: string | null }
export interface OilPnlAccount {
  venue: string; accountId: string; accountMode: string;
  positions: { rows: { symbol: string; side: string; quantity: string; entryPrice: string | null; markPrice: string | null; unrealizedPnl: string }[] | null; receivedAt: number | null; failedAt: number | null; error: string | null };
  ledger: { start: number | null; coveredUntil: number | null; syncedAt: number | null; failedAt: number | null; error: string | null };
  symbols: { symbol: string; funding: string; realized: string; fee: string; unrealized: string | null }[];
}
export interface OilPnlView {
  currency: 'USDT'; range: string; ranges: string[]; now: number; requestedStart: number; start: number; intervalMs: number; sampledAt: number | null;
  status: 'collecting' | 'incomplete' | 'ready'; recordingStartedAt: number | null; pointCount: number; points: OilPnlPoint[]; latest: OilPnlPoint | null;
  totals: { funding: string; realized: string; fee: string } | null;
  accounts: OilPnlAccount[];
  entries: { page: number; pages: number; total: number; pageSize: number; rows: { venue: string | null; id: string; time: number; symbol: string; kind: 'funding' | 'realized' | 'fee'; amount: string }[] };
}
/** The PnL store could not open: the reason, nothing else. */
export interface OilPnlUnavailable { available: false; error: string }
