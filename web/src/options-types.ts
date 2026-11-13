// The shapes of the options reads (GET /api/options/market, /preview, /state) and writes (POST /api/options/plans,
// /tasks), as the options page reads them; the server side is src/options/engine.ts.

export type Side = 'Buy' | 'Sell';
export type OptionType = 'Call' | 'Put';
export type StrategyMode = 'iron_condor' | 'short_strangle';
export type TaskStatus = 'accepted' | 'running' | 'stopping' | 'recovering' | 'recovery_needed' | 'completed' | 'partial' | 'stopped' | 'failed';

export interface ChainRow {
  symbol: string; expiry: number; strike: number; optionType: OptionType; delta: number; mark: number; bid: number; ask: number;
  iv: number; volume: number; openInterest: number; bidSize: number; askSize: number;
  gamma?: number | null; vega?: number | null; theta?: number | null;
}
export interface OptionsMarket { at: number | null; stale: boolean; index: number | null; error: string | null; expiries: number[]; expiry: number | null; rows: ChainRow[] }

export interface PreviewLeg {
  symbol: string; side: Side; optionType: OptionType; strike: number; delta: number; qty: string; mark: number; targetDelta: number;
  estimatedFeeUsd: number; feeCapUsd: number; feeBasisPrice: number;
}
export interface Preview {
  mode: StrategyMode; unboundedLoss: boolean; expiry: number; legs: PreviewLeg[];
  netCreditUsd: number; maxLossUsd: number | null; maxProfitUsd: number; riskReward: number | null;
  estimatedMarginUsd: number; estimatedTradingCostUsd: number; estimatedInitialMarginUsd: number; estimatedMaintenanceMarginUsd: number;
  marginBasis: string; marginMode: string; marginBufferPct: number; feeRate: number; feeCapPct: number;
  index: number | null; marketAt: number;
}
export interface PreviewView { preview: Preview; riskProblem: string | null }

export interface PlanLeg { symbol: string; side: Side; qty: string; expiry: number; strike: number; optionType: OptionType; referencePrice: number }
export interface Plan {
  planId: string; operation: 'open' | 'close'; mode: StrategyMode; createdAt: number; expiresAt: number; legs: PlanLeg[];
  estimatedGrossUsd: number; estimatedFeeUsd: number; estimatedNetUsd: number; estimatedMarginUsd: number; unboundedLoss: boolean;
  minNetIncomeUsd: number | null; maxNetCostUsd: number | null;
}
export interface TaskAccepted { taskId: string; status: TaskStatus; operation: 'open' | 'close'; planId: string }

export interface Task {
  id: string; type: 'open' | 'close'; status: TaskStatus; planId: string; requestId: string;
  acceptedAt: number; startedAt: number | null; finishedAt: number | null; stopRequested: boolean; stopRequestedAt: number | null;
  mode: StrategyMode; legs: Record<string, PlanLeg & { chainPrice: number }>; links: string[];
  minNetIncomeUsd: number | null; maxNetCostUsd: number | null; netBlocked: boolean; riskBlocked: boolean;
  openingGroup: string | null; strategyStatus: 'open' | 'closed' | null; closedAt: number | null; closeReason: string | null; error: string | null;
  scheduled?: boolean;
}
export interface OrderRow {
  link: string; taskId: string; symbol: string; side: Side; qty: string; reduceOnly: boolean; status: string; terminal: boolean;
  filledQty: string; orderId: string; createdAt: number; updatedAt: number; message?: string; price?: string; kind?: 'ioc';
}
export interface Position { symbol: string; side: Side; size: string; avgPrice: number; markPrice: number; unrealisedPnl: number }
export interface Execution {
  execId: string; symbol: string; side: Side; orderId: string; orderLinkId: string; execFee: number; feeCurrency: string;
  execPrice: number; execQty: number; execTime: number; reduceOnly: boolean; taskId: string | null; chainPrice: number | null; chainPriceDiff: number | null;
}
export type GreekName = 'delta' | 'gamma' | 'vega' | 'theta';
export interface GreeksSummary {
  status: 'ok' | 'partial' | 'empty' | 'unavailable'; positionCount: number; positionsAvailable: boolean; marketAt: number | null; stale: boolean;
  totals: Record<GreekName, number | null>; missing: Record<GreekName, string[]>;
}
export interface PortfolioMargin {
  accountIm: number | null; accountMm: number | null; assetIm: number | null; assetMm: number | null; contingency: number | null;
  maxLossPriceMove: number | null; maxLossIvShock: number | null; incrementalImUsd: number | null; incrementalMmUsd: number | null; baselineAt: number | null;
}
export interface AccountHealth {
  available: boolean; message?: string; updatedAt: number;
  availableBalanceUsd?: number | null; marginBalanceUsd?: number | null; totalEquityUsd?: number | null;
  initialMarginRate?: number | null; maintenanceMarginRate?: number | null; marginMode?: string | null;
  portfolioMargin?: PortfolioMargin | null; portfolioMarginMessage?: string;
}
export interface ScheduleView {
  enabled: boolean; source: 'config' | 'page'; configEnabled: boolean; hourUtc: number; minuteUtc: number; windowSeconds: number;
  marketFallback: boolean; nextAt: number; inWindow: boolean; waiting: boolean; lastOpenWeek: string | null;
  lastError: { week: string; message: string | null; at: number | null } | null;
}
export interface OptionsState {
  settings: { maxRiskUsd: number; maxMarginUsd: number; legQty: string; strategyMode: StrategyMode; orderTimeoutSeconds: number; feeRate: number; marginBufferPct: number; marginMode: string };
  account: string; busy: boolean; tasks: Task[]; orders: OrderRow[];
  tracked: { groupId: string | null; legs: { symbol: string; side: Side; size: string }[]; mode: StrategyMode | null };
  positions: { rows: Position[]; at: number } | null; positionsError: string | null;
  greeks: GreeksSummary; health: AccountHealth | null;
  reconciliation: { error: string | null; lastSuccessAt: number | null; pendingOrders: number };
  executions: Execution[]; market: { at: number | null; stale: boolean; error: string | null };
  /** Absent from a pre-G2a service (a page left open across a rollback). */
  schedule?: ScheduleView;
}

// GET /api/options/performance (G2b 收益); amounts are in the group's settlement currency, times in ms.
export interface PerformancePoint { time: number; pnl: number; terminal?: true; gapBefore?: true }
export interface PerformanceSeriesPoint extends PerformancePoint { groupId: string; cumulative: number }
export interface PerformanceFill extends Execution { openingGroup: string | null }
export interface PerformanceGroup {
  id: string; openedAt: number | null; strategyMode: StrategyMode | null; closedAt: number | null; currency: string; status: 'open' | 'closed' | 'pending'; issues: string[];
  legCount: number; openPremium: number | null; openFee: number | null; closeFee: number | null; deliveryFee: number;
  netPnl: number | null; floatingPnl: number | null; markToMarketPnl: number | null; expiry: number | null; eligible: boolean;
  closureKind: 'early' | 'expiry' | 'unknown' | 'holding'; exclusionReason: string; remainingQty: number; source: 'executions' | 'exchange_closed_positions';
  fills: PerformanceFill[]; samples: PerformancePoint[]; sampleCount: number;
}
export interface PerformanceSeries {
  currency: string; points: PerformanceSeriesPoint[]; totalPnl: number; closedCount: number; wins: number; maxDrawdown: number;
  sampleSeconds: number; sampledCount: number; unsampledCount: number;
}
export interface PerformanceView {
  account: string; sampleSeconds: number; unassignedCloses: number; groups: PerformanceGroup[]; series: PerformanceSeries[];
  ledger: { count: number; firstAt: number | null }; positionsAt: number | null; error: string | null;
}
