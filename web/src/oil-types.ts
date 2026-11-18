// The shapes of the oil reads (GET /api/oil/market, /api/oil/state) and of a preview, as the oil page reads them.
import type { Account } from './types.ts';
import type { OilIntent } from './oil-form.ts';
import type { OrderStatus, StrategyStatus } from '../../src/connector.ts';

/** O7: `pushed` = the market monitor's collector (venue time), `rest` = this service's own read (receive time); absent before v0.59.0. */
export interface OilBook { venue: string; symbol: string; bid: string | null; ask: string | null; receivedAt: number | null; source?: 'pushed' | 'rest' | null; failedAt: number | null; error: string | null }
/** The book cell's hover text: its time, where it came from, and whether it is stale. */
export const bookTitle = (time: string, source: OilBook['source'], late: boolean): string =>
  `盘口时间 ${time}${source === 'pushed' ? ' · 行情监控推送' : source === 'rest' ? ' · 交易所接口读取' : ''}${late ? '（已过期）' : ''}`;
export interface OilMarket {
  now: number; readAt: number | null; readEveryMs: number; timeoutMs: number;
  books: OilBook[];
  /** sell: BZ bid − CL ask (what selling the spread gets); buy: BZ ask − CL bid (what buying it costs). */
  sameExchange: { venue: string; sell: string | null; buy: string | null; receivedAt: number | null }[];
  crossExchange: CrossRow[];
}
/** One contract on two configured venues: firstOverSecond = first bid − second ask, secondOverFirst the other way. */
export interface CrossRow { symbol: string; first: string; second: string; firstOverSecond: string | null; secondOverFirst: string | null; receivedAt: number | null }
/** The cross-venue rows grouped by venue pair, in the order the service lists them. */
export function crossPairs(rows: readonly CrossRow[]): { first: string; second: string; rows: CrossRow[] }[] {
  const groups: { first: string; second: string; rows: CrossRow[] }[] = [];
  for (const row of rows) {
    const group = groups.find(item => item.first === row.first && item.second === row.second);
    if (group) group.rows.push(row); else groups.push({ first: row.first, second: row.second, rows: [row] });
  }
  return groups;
}
export interface OilPositionAccount {
  venue: string; accountId: string; accountMode: string;
  long: Record<string, string> | null; short: Record<string, string> | null; openOrders: number | null;
  receivedAt: number | null; failedAt: number | null; error: string | null;
}
export interface OilOperation {
  kind: string; clientOrderId: string; state: string; quantity: string; limitPrice?: string | null; filledQuantity: string; averagePrice: string | null; remoteId: string | null;
  /** Latest ordinary order report and whether a working order or strategy has ever been verified. Older APIs omit both. */
  venueStatus?: OrderStatus | null; verifiedWorking?: boolean;
  strategyStatus: StrategyStatus | null; childrenSettled: boolean | null; adoptedAt: number | null; releasedAt: number | null; ackStrategyId: string | null; note: string | null;
}
const OP_STATE: Record<string, string> = { prepared: '已落盘', sending: '发送中', unknown: '结果未知，核对中', rejected: '被拒绝', 'not-sent': '未发送', 'not-created': '确认未创建', filled: '已成交', canceled: '已撤销', confirmed: '已确认' };
export function operationStatus(op: Pick<OilOperation, 'state' | 'kind' | 'venueStatus' | 'verifiedWorking' | 'strategyStatus' | 'childrenSettled'> | null): string {
  if (!op) return '未发送';
  if (op.state !== 'open') return OP_STATE[op.state] ?? op.state;
  if (op.kind === 'strategy') {
    // Older APIs did not check the strategy's identity when exposing its status.
    if (op.verifiedWorking === undefined) return '策略状态待核实';
    if (op.strategyStatus === 'paused') return '策略已暂停';
    if (op.strategyStatus === 'terminal') {
      if (op.childrenSettled === false) return '策略已结束，子单待结清';
      return op.childrenSettled === true ? '策略已结束' : '策略已结束，子单状态待核实';
    }
    return op.strategyStatus === 'working' && op.verifiedWorking ? '策略运行中' : '策略状态待核实';
  }
  if (op.venueStatus === 'acknowledged') return '已收到回执，挂单待核实';
  if (op.kind === 'order' && op.verifiedWorking && (op.venueStatus === 'new' || op.venueStatus === 'partially-filled')) return '交易所挂单中';
  return '挂单状态待核实';
}
export interface OilJobLeg {
  venue: string; symbol: string; side: string; orderSide: string; orderType: string; plannedQuantity: string; accountId: string; priceBound: string | null; limitPrice?: string | null;
  contractSize: string; quantityStep?: string; skippedQuantity?: string; plannedBarrels: string; filledBarrels: string; averagePrice: string | null; previewQuote: { bid: string; ask: string };
  attempts: number; filledQuantity: string; operation: OilOperation | null;
}
export interface OilJob {
  id: string; market?: 'oil' | 'hynix'; preset: 'same-exchange' | 'cross-exchange' | 'rebalance'; action: 'open' | 'close'; status: string; reason: string | null; stopRequested: boolean;
  createdAt: number; deadlineAt: number; holdNewSends: boolean; locked: boolean; acknowledgedAt: number | null; strategyPending: boolean;
  /** current: 1-based batch of the latest lead order, 0 before the first; null when the job is not batched. */
  batches?: { count: number; current: number; intervalMs: number } | null;
  /** A hynix rebalance (preset 'rebalance'): one leg; null or absent on two-leg jobs. */
  rebalance?: { method: 'reduce' | 'add' } | null;
  /** One of a four-leg group's two jobs: index is the venue's place in the intent, peer the other job (docs/oil.md 11). */
  group?: { id: string; index: number; peer: string } | null;
  /** Set when the other job of the group ended unfinished: no new lead is sent, fills already made are still hedged. */
  peerHalt?: string | null;
  legs: OilJobLeg[]; events: { type: string; at: number; [key: string]: unknown }[];
}
export interface OilState {
  accounts: Account[];
  positions: { readAt: number | null; readEveryMs: number; timeoutMs: number; accounts: OilPositionAccount[] };
  jobs: OilJob[];
}
export interface OilPreviewLeg {
  index: number; venue: string; symbol: string; side: string; orderSide: string; quantity: string; orderType: string; reduceOnly: boolean;
  accountId: string; accountMode: string; priceBound?: string | null; limitPrice?: string | null; chaseCeiling?: string; instrument: { contractSize: string; quantityStep: string };
  quote: { bid: string; ask: string; receivedAt: number };
}
/** batches: the lead quantity of each batch, when the intent asked for more than one. */
export interface OilPreview { id: string; expiresAt: number; intent: OilIntent; legs: OilPreviewLeg[]; notional: string; barrels?: string; batches?: string[]; notes: string[] }
export interface OilConfirmResult { accepted: boolean; duplicate: boolean; job: OilJob }

/** H2 (docs/hynix.md section 7): the two hynix legs one venue's account holds, compared by USDT notional. */
export type RebalanceMethod = 'reduce' | 'add';
export interface HynixBalanceSettings { rebalancePercent: string; hardPercent: string; minGapUsdt: string }
export interface HynixBalanceLeg { symbol: string; side: 'long' | 'short'; quantity: string; price: string; notional: string }
/** The one order that levels the legs, or why it is not offered. */
export type RebalanceSuggestion = { symbol: string; side: 'long' | 'short'; action: 'open' | 'close'; quantity: string } | { error: string };
export type HynixBalanceRow = { venue: string; positionsAt: number | null; quotesAt: number | null } & (
  | { status: 'unavailable'; reason: string }
  | { status: 'none'; level: 'ok' | 'rebalance' | 'hard' }
  | { status: 'unpaired'; reason: string; legs: HynixBalanceLeg[]; level: 'ok' | 'rebalance' | 'hard' }
  | { status: 'paired'; long: HynixBalanceLeg; short: HynixBalanceLeg; gap: string; netSide: 'long' | 'short' | null; percent: string; level: 'ok' | 'rebalance' | 'hard'; suggest?: { reduce: RebalanceSuggestion; add: RebalanceSuggestion } }
);
export interface HynixBalanceView { settings: HynixBalanceSettings; settingsAvailable: boolean; settingsError: string | null; venues: HynixBalanceRow[] }
/** GET /api/hynix/state: the oil state's shape on the hynix contracts, with the balance (absent from services before H2). */
export type HynixState = OilState & { balance?: unknown };
export interface HynixRebalanceIntent { market: 'hynix'; preset: 'rebalance'; venue: string; method: RebalanceMethod; timeoutMs: number; maxSlippageBps?: number | null }
/** A rebalance preview: one leg; before and after are USDT notional at the preview's midpoints. Fields may be missing on older executors. */
export interface HynixRebalancePreview extends Omit<OilPreview, 'intent' | 'barrels' | 'batches'> {
  intent: HynixRebalanceIntent;
  rebalance?: {
    method?: RebalanceMethod;
    counter?: { symbol?: string; side?: string; quantity?: string; positionMode?: string };
    before?: { longNotional?: string; shortNotional?: string; gap?: string; percent?: string; netSide?: 'long' | 'short' | null };
    after?: { gap?: string; netSide?: 'long' | 'short' | null };
  };
}

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
