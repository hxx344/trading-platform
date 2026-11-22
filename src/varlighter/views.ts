// Var/Lighter 模块各接口的应答结构（docs/varlighter.md 第 9 节）。只有类型，引擎按这些类型返回，页面按这些类型读取；
// 不引用 node 模块，前端类型检查可以直接导入。
import type { BacktestResult } from './backtest.ts';
import type { AssetKind, Identity, Regime, RhMarket, Sample, SizeBucket, Venue } from './model.ts';
import type { OrderPlan } from './plan.ts';
import type { RegimeStats } from './stats.ts';
import type { ClosedTrade, Direction, GlobalParams, Position, SymbolParams } from './strategy.ts';

/** symbols 与 confirmed 都按配对键「场所:代码」；venues 是正在采集的 Lighter 场所。 */
export interface Settings { revision: number; global: GlobalParams; symbols: Record<string, SymbolParams>; confirmed: string[]; venues: Venue[] }
export interface SourceState { at: number | null; ok: number | null; error: string | null; count: number }
export interface PollStats { at: number; listings: number; fresh: number; unchanged: number; noQuote: number; noLighter: number; written: number }
export interface LighterStatus {
  connected: boolean; connectedAt: number | null; lastMessageAt: number | null; reconnects: number; lastError: string | null;
  markets: number; bytes: number; bytesSince: number | null;
}
/** 一个配对的盘口快照状态：最近一次成功的时刻与最近一次的错误。 */
export interface DepthStatus { key: string; marketId: number; at: number | null; error: string | null }
/** 一个 Lighter 场所的采集状态；停用的场所 stream 为 null。 */
export interface VenueStatus { venue: Venue; name: string; enabled: boolean; catalog: SourceState; stream: LighterStatus | null; depth: DepthStatus[]; pairs: number }
export interface BaselineView { median: number; sigma: number; samples: number; regime: Regime; fallback: boolean }
export interface PaperTotals { trades: number; netUsd: number; wins: number; first: number | null }

export interface StateRow {
  /** 配对键「场所:代码」；symbol 是两边共同的代码。 */ key: string; venue: Venue; venueName: string;
  symbol: string; name: string; kind: AssetKind; kindName: string; identity: Identity; eligible: boolean; gapBps: number | null;
  regime: Regime; sampleAt: number | null;
  /** 中间价基差、卖 Var / 买 Var 的可成交价差与往返成本（基点）。 */ mid: number | null; sellVar: number | null; buyVar: number | null; estimated: boolean | null; cost: number | null;
  baseline: BaselineView | null;
  /** 中间价偏离基线的 σ 倍数；rich / cheap 是两个方向可成交价差相对基线的偏离（基点）。 */ z: number | null; rich: number | null; cheap: number | null;
  samples24h: number; firstAt: number | null;
  enabled: boolean; entryBps: number; exitBps: number;
  position: { direction: Direction; pnlBps: number | null; openedAt: number } | null;
  varFunding: number | null; rhFunding: number | null;
}
export interface StateView {
  now: number; startedAt: number;
  sources: { var: SourceState & { poll: PollStats | null; quoteAgeMedianMs: number | null }; venues: VenueStatus[] };
  firstSampleAt: number | null;
  rows: StateRow[];
  settings: Settings;
  paper: PaperTotals & { open: number; openNotionalUsd: number; todayNetUsd: number };
  regimeNames: Record<Regime, string>;
}

export interface SymbolPoint { t: number; mid: number; sellVar: number | null; buyVar: number | null; median: number | null; sigma: number | null; regime: Regime; estimated: boolean }
export interface PositionMark { netUsd: number; pnlBps: number; at: number }
export interface SymbolView {
  key: string; venue: Venue; venueName: string;
  symbol: string; name: string; kind: AssetKind; kindName: string; identity: Identity; eligible: boolean; gapBps: number | null;
  rh: RhMarket; regimes: Regime[]; hours: number; from: number; to: number; bucket: SizeBucket;
  points: SymbolPoint[]; samples: number;
  stats: (RegimeStats & { suggestedEntryBps: number | null })[];
  params: SymbolParams; global: GlobalParams; latest: Sample | null; plans: OrderPlan[];
  position: (Position & { mark: PositionMark | null }) | null;
  trades: ClosedTrade[];
}

export type BacktestView = BacktestResult & { truncated: boolean };

export interface StoredEventView { id: number; at: number; kind: string; symbol: string | null; message: string }
export interface PaperView {
  now: number;
  positions: (Position & { mark: PositionMark | null; sampleAt: number | null; maxHoldMinutes: number })[];
  trades: ClosedTrade[];
  equity: { t: number; net: number }[];
  daily: { day: number; netUsd: number; trades: number }[];
  totals: PaperTotals; todayNetUsd: number;
  limits: { maxOpenPositions: number; maxTotalNotionalUsd: number; dailyLossLimitUsd: number; paused: boolean };
  openNotionalUsd: number;
  events: StoredEventView[];
}

export interface ReadinessItem { key: string; status: 'ok' | 'warn' | 'todo'; label: string; detail: string }
export interface ReadinessView { now: number; items: ReadinessItem[]; ready: boolean }
