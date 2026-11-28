// 资金费组合给页面的视图类型（/api/fundingbook/*）。只有类型，页面直接引用。金额是美元，年化与波动率是小数。
import type { Settings, VENUE_SPECS } from './model.ts';
import type { PlanStep } from './plan.ts';

export interface LegView {
  venue: string; base: string; symbol: string;
  price: number | null;
  /** 当前预测费率折年化。 */
  currentApr: number | null;
  shortApr: number | null; longApr: number | null; adjustedApr: number | null;
  settlements: number; coverageDays: number;
  /** 这条腿本轮不能用的原因；能用时为 null。 */
  note: string | null;
}
export interface RiskView { bases: string[]; vol: number[]; corr: number[][]; samples: number[] }
export interface RoundPosition { base: string; symbol: string; notional: number; qty: number; price: number; adjustedApr: number; shortApr: number }
export interface RoundAccount {
  id: string; venue: string;
  /** 规划前的权益与目标权益。 */
  equityBefore: number; equity: number;
  gross: number; sigma: number; mm: number; required: number;
  /** (目标权益 − 维持保证金) ÷ 1 日波动金额；没有仓位时为 null。 */
  distance: number | null;
  positions: RoundPosition[];
}
export interface BaseImpact { account: string; sigma: number; sigmaWithout: number; distance: number | null; distanceWithout: number | null }
export interface RoundBase {
  base: string;
  /** 单边名义金额（多头合计）。 */
  notional: number;
  /** 这个标的自己在持有期内的资金费收入，与整仓往返一次的成本。 */
  income: number; cost: number;
  /** 不许做这个标的时重新求解，整个组合的净收入少多少（持有期内）。 */
  marginal: number;
  impacts: BaseImpact[];
}
export interface RoundSummary { capital: number; gross: number; stepCount: number; expectedApr: number; optimisticApr: number }
export interface RoundView extends RoundSummary {
  id: number; at: number;
  horizonDays: number; safetySigma: number;
  income: number; cost: number; required: number; lambda: number;
  /** 这一轮是否已记入模拟盘。 */
  applied: boolean;
  accounts: RoundAccount[];
  bases: RoundBase[];
  steps: PlanStep[];
}
export interface BookPosition { base: string; symbol: string; qty: number; entry: number; price: number | null; notional: number | null; unrealized: number | null }
export interface BookAccount { id: string; cash: number; equity: number | null; funding: number; fees: number; realized: number; positions: BookPosition[] }
export interface BookView { startedAt: number; initialCapital: number; equity: number | null; funding: number; fees: number; realized: number; accounts: BookAccount[] }
export interface CollectView { done: number; total: number; errors: string[] }
export interface StateView {
  /** 合约价差监控在运行；不在运行时本模块不采集也不规划。 */
  running: boolean;
  settings: Settings;
  venues: typeof VENUE_SPECS;
  collect: CollectView;
  roundError: string | null;
  /** 仅异常的持久记录需要显式恢复。参数不可读时 settings 是供编辑的初值。 */
  recovery: { settings: string | null; book: string | null };
  solving: boolean;
  lastRoundAt: number | null;
  nextRoundAt: number | null;
  legs: LegView[];
  risk: RiskView | null;
  /** 本轮不可用时为 null。最后成功规划仍可从 rounds 按 id 读取。 */
  round: RoundView | null;
  rounds: ({ id: number; at: number } & RoundSummary)[];
  book: BookView | null;
  checkedAt: number;
}
