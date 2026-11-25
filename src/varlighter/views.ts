// DEX 价差模块（原 Var/Lighter）各接口的应答结构（docs/varlighter.md 第 9 节、docs/dexspread.md 第 6 节）。只有类型，引擎按这些类型返回，
// 页面按这些类型读取；不引用 node 模块，前端类型检查可以直接导入。
import type { BacktestResult } from './backtest.ts';
import type { AssetKind, Combo, CustomPair, Identity, LegInfo, LiveVenue, Regime, Sample, SizeBucket, VenueId } from './model.ts';
import type { OrderPlan } from './plan.ts';
import type { RegimeStats } from './stats.ts';
import type { ClosedTrade, Direction, GlobalParams, Position, SymbolParams } from './strategy.ts';

/**
 * symbols 与 confirmed 都按配对键「A场所:A代码|B场所:B代码」（乘数不是 1 时带「@乘数」）；combos 是自动配对的场所组合，
 * pairs 是手动配对（实盘准备页「配对管理」）。
 */
export interface Settings { revision: number; global: GlobalParams; symbols: Record<string, SymbolParams>; confirmed: string[]; combos: Combo[]; pairs: CustomPair[] }
export interface SourceState { at: number | null; ok: number | null; error: string | null; count: number }
export interface PollStats { at: number; listings: number; fresh: number; unchanged: number; noQuote: number;
  /** 有 Var 腿的配对里，对手腿在 Var 报价时刻没有可用一档的条数。 */ noTop: number; written: number;
  /** 新样本里没取到判断时刻对手腿一档的条数，以及这一轮达到入场偏离却没开仓的次数（按原因）。 */ noLive: number; blocked: Record<string, number>;
  /** 这一轮的 Var token 询价：成功、失败的次数（没有可用 token 时都是 0）。 */ tokenOk: number; tokenFailed: number;
  /** 该询而没询的配对数：类别的写法没确认、失败后暂停中、这一轮中途 token 不可用或到了阶段时限（v0.82.0 起；没有可用 token 时为 0）。 */ tokenSkipped: number }
/** 两腿都是行情流的配对最近一轮采样：写入条数、到期却缺一档的条数、达到入场偏离却没开仓的次数。 */
export interface LiveStats { at: number; due: number; written: number; noTop: number; blocked: Record<string, number> }
export type TokenStatus = 'missing' | 'expired' | 'ready' | 'rejected' | 'unavailable';
/** Var token 询价的状态：不含 token。`lagMs` 是最近一次成功询价收到时距 Var 报价时刻的毫秒数。 */
export interface TokenView { status: TokenStatus; statusName: string; expiresAt: number | null; error: string | null; okAt: number | null; lagMs: number | null }
export interface LighterStatus {
  connected: boolean; connectedAt: number | null; lastMessageAt: number | null; reconnects: number; lastError: string | null;
  markets: number; bytes: number; bytesSince: number | null;
}
/** 一条腿的盘口（行情流订阅）状态：key 是腿「场所:代码」，最近一次取到的时刻与当前不可用的原因。 */
export interface DepthStatus { key: string; marketId: number; at: number | null; error: string | null }
/** 一个行情流场所的采集状态；没有组合或手动配对用到时 enabled 为假、stream 为 null。 */
export interface VenueStatus { venue: LiveVenue; name: string; enabled: boolean; catalog: SourceState; stream: LighterStatus | null; depth: DepthStatus[]; pairs: number }
export interface BaselineView { median: number; sigma: number; samples: number; regime: Regime; fallback: boolean }
export interface PaperTotals { trades: number; netUsd: number; wins: number; first: number | null }
/** 页面上的一条腿：场所、代码与场所名。 */
export interface LegRef { venue: VenueId; symbol: string; name: string }
/** 自动配对的一个组合：是否开启、两个场所与当前配对数。 */
export interface ComboView { combo: Combo; name: string; enabled: boolean; pairs: number }

export interface StateRow {
  /** 配对键；symbol 是页面上的代码（同代码写一次，否则「A / B」，乘数不是 1 时带「×乘数」）。venue、venueName 是旧接口字段（B 腿）。 */
  key: string; a: LegRef; b: LegRef; ratio: number; custom: boolean; note: string; venue: VenueId; venueName: string;
  symbol: string; name: string; kind: AssetKind; kindName: string; identity: Identity; eligible: boolean; gapBps: number | null;
  regime: Regime; sampleAt: number | null;
  /** 中间价基差、卖 A / 买 A 的可成交价差与往返成本（基点）。 */ mid: number | null; sellA: number | null; buyA: number | null; estimated: boolean | null; cost: number | null;
  baseline: BaselineView | null;
  /** 中间价偏离基线的 σ 倍数；rich / cheap 是两个方向可成交价差相对基线的偏离（基点）。 */ z: number | null; rich: number | null; cheap: number | null;
  samples24h: number; firstAt: number | null;
  /** 平仓后的冷却截止时刻，已过期为 null。 */ cooldownUntil: number | null;
  enabled: boolean; entryBps: number; exitBps: number;
  position: { direction: Direction; pnlBps: number | null; openedAt: number } | null;
  /** 两腿每小时资金费率（小数，多头付费为正）。 */ aFunding: number | null; bFunding: number | null;
  /** 两腿手续费（基点，手动值或目录费率）；取不到为 null（不开仓）。 */ aFeeBps: number | null; bFeeBps: number | null;
}
export interface OrphanRow {
  key: string; a: LegRef | null; b: LegRef | null; venue: VenueId | null; venueName: string; symbol: string; reason: string; enabled: boolean; lastSampleAt: number | null;
  position: { direction: Direction; openedAt: number; pnlBps: number | null } | null;
}
export interface StateView {
  now: number; startedAt: number;
  sources: {
    /** Var 没有组合或手动配对用到时 enabled 为假。 */
    var: SourceState & { enabled: boolean; poll: PollStats | null; quoteAgeMedianMs: number | null; /** 引擎没有接询价器时为 null。 */ token: TokenView | null };
    venues: VenueStatus[]; live: LiveStats | null; combos: ComboView[];
  };
  firstSampleAt: number | null;
  rows: StateRow[];
  /** 已启用或有持仓、但不在当前配对里的键。 */
  orphans: OrphanRow[];
  settings: Settings;
  paper: PaperTotals & { open: number; openNotionalUsd: number; todayNetUsd: number };
  regimeNames: Record<Regime, string>;
  venueNames: Record<VenueId, string>;
}

export interface SymbolPoint { t: number; mid: number; sellA: number | null; buyA: number | null; median: number | null; sigma: number | null; regime: Regime; estimated: boolean }
export interface PositionMark { netUsd: number; pnlBps: number; at: number }
export interface SymbolView {
  key: string; a: LegInfo & { name: string }; b: LegInfo & { name: string }; ratio: number; custom: boolean; note: string; venue: VenueId; venueName: string;
  symbol: string; name: string; kind: AssetKind; kindName: string; identity: Identity; eligible: boolean; gapBps: number | null;
  regimes: Regime[]; hours: number; from: number; to: number; bucket: SizeBucket;
  points: SymbolPoint[]; samples: number;
  stats: (RegimeStats & { suggestedEntryBps: number | null })[];
  params: SymbolParams; global: GlobalParams; latest: Sample | null; plans: OrderPlan[];
  /** 两腿手续费（基点）；取不到为 null。 */ fees: { a: number | null; b: number | null };
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

/** 原始样本的一页（docs/mcp.md 第 8.3 节）：rows 每行按 columns 的顺序；next 为本页最后一条的时刻，读完为 null。format 是样本格式版本（v0.88.0 起为 2）。 */
export interface SamplesView { symbol: string; format: number; columns: (keyof Sample)[]; rows: unknown[][]; next: number | null; firstAt: number | null; retentionDays: number }
export interface ReadinessItem { key: string; status: 'ok' | 'warn' | 'todo'; label: string; detail: string }
/** 手动配对用的目录：各场所在交易的代码与标记价（场所没有在采集、目录未取到时为空）。 */
export interface CatalogEntry { symbol: string; mark: number | null }
export interface ReadinessView { now: number; items: ReadinessItem[]; ready: boolean; markets: Record<VenueId, CatalogEntry[]> }
