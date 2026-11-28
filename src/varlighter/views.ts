// DEX 价差模块（原 Var/Lighter）各接口的应答结构（docs/varlighter.md 第 9 节、docs/dexspread.md 第 6 节）。只有类型，引擎按这些类型返回，
// 页面按这些类型读取；不引用 node 模块，前端类型检查可以直接导入。
import type { KeyVenue } from '../dex/keys.ts';
import type { AccountAsset, AccountFunding, AccountHistorySummary, AccountPnlPoint, AccountTrade } from './accounts.ts';
import type { BacktestResult } from './backtest.ts';
import type { AssetKind, Combo, CustomPair, Identity, LegInfo, LiveVenue, Regime, Sample, SizeBucket, VarPriceSource, VenueId } from './model.ts';
import type { OrderPlan } from './plan.ts';
import type { LighterPrivateStatus } from './lighter-private.ts';
import type { LiveExecSettings, LivePosition, LiveSettings, LiveSkipStats, LiveState } from './live.ts';
import type { LiveKeysView } from './livekeys.ts';
import type { RegimeStats } from './stats.ts';
import type { AutoParams, ClosedTrade, Direction, GlobalParams, Position, SymbolParams } from './strategy.ts';

/**
 * symbols 与 confirmed 都按配对键「A场所:A代码|B场所:B代码」（乘数不是 1 时带「@乘数」）；combos 是自动配对的场所组合，
 * pairs 是手动配对（实盘准备页「配对管理」）。auto 是用自动配置的配对键（v0.93.0）：入场、出场、止损与最长持有按近期统计的推荐值，
 * symbols 里保存的这四项留作关掉自动配置后的值。放在 symbols 外面，旧版本读参数时会忽略它（回退后这些配对按保存的参数运行）。
 */
export interface Settings { revision: number; global: GlobalParams; symbols: Record<string, SymbolParams>; confirmed: string[]; combos: Combo[]; pairs: CustomPair[]; auto: string[] }
/** 一个配对的自动配置：on 为是否在用；params 是当前的推荐值，算不出时为 null、reason 写原因；at 是所用统计的计算时刻，regime、samples 是所用统计的时段与样本数。 */
export interface AutoView { on: boolean; params: AutoParams | null; reason: string | null; at: number | null; regime: Regime | null; samples: number }
export interface SourceState { at: number | null; ok: number | null; error: string | null; count: number }
export interface PollStats { at: number; listings: number; fresh: number; unchanged: number; noQuote: number;
  /** 有 Var 腿的配对里，对手腿在 Var 报价时刻没有可用一档的条数。 */ noTop: number; written: number;
  /** 新样本里没取到判断时刻对手腿一档的条数，以及这一轮达到入场偏离却没开仓的次数（按原因）。 */ noLive: number; blocked: Record<string, number>;
  /** 这一轮的 Var token 询价：成功、失败的次数（没有可用 token 时都是 0）。 */ tokenOk: number; tokenFailed: number;
  /** 该询而没询的配对数：类别的写法没确认、失败后暂停中、这一轮中途 token 不可用或到了阶段时限（v0.82.0 起；没有可用 token 时为 0）。 */ tokenSkipped: number }
/** 两腿都是行情流的配对最近一轮采样：写入条数、到期却缺一档的条数、达到入场偏离却没开仓的次数。 */
export interface LiveStats { at: number; due: number; written: number; noTop: number; blocked: Record<string, number> }
/** 按行情流推送做的开平仓判断（服务启动以来）：判断次数、交给实盘开平仓的次数、最近一次成交的时刻，以及最近一次达到开仓条件却被挡住的配对与原因。 */
export interface PushStats { checks: number; trades: number; lastTradeAt: number | null; lastBlocked: { at: number; symbol: string; reason: string } | null }
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
/** 页面上的一条腿：场所、代码与场所名。 */
export interface LegRef { venue: VenueId; symbol: string; name: string }
/** 自动配对的一个组合：是否开启、两个场所与当前配对数。 */
export interface ComboView { combo: Combo; name: string; enabled: boolean; pairs: number }

export interface PositionSummary {
  /** 实盘持仓编号与状态（v0.112.0 起；失联配对的平仓按编号发给实盘）。 */ id?: string; state?: LiveState;
  direction: Direction; openedAt: number; pnlBps: number | null;
  /** 开仓或估值使用估算价时为 true；缺估值返回 null，旧服务未提供该字段。 */
  estimated?: boolean | null;
}
/**
 * 为什么没开仓（v0.114.0 起；只给已启用、当前没有实盘持仓的配对，其余为 null）：按引擎判断的顺序给出第一个挡住的原因，
 * 读数取最新样本（两腿都是行情流的启用配对每 5 秒一条，推送判断用的是更新的一档，两者可能差几秒）。
 */
export interface GateView {
  /** 现在不会开仓的原因；null 表示没有东西挡着（没到入场线就是在等信号）。 */
  blocker: string | null;
  /** blocker 要不要人去处理：false 是策略本来就会等的（时段、冷却、净利不足、信号消失、限额占满）或用户自己的设置（暂停、没开实盘、没勾选）；true 是不处理就一直开不了的（规格、手续费、凭据、余额、账户读数、实盘停止、当日亏损上限）。blocker 为 null 时为 false。 */
  attention: boolean;
  /** 允许的方向里较大的可成交偏离（基点）是否已到入场线；没有样本或基线时 deviation 为 null。 */
  reached: boolean; deviation: number | null;
  /** 已到入场线时这次开仓的预期净利（基点）；没到为 null。 */
  expectedNetBps: number | null;
  /** 服务启动以来最近一次到了入场线却没开成的时刻与原因（策略风控或实盘检查）。 */
  last: { at: number; reason: string } | null;
}
export interface StateRow {
  /** 配对键；symbol 是页面上的代码（同代码写一次，否则「A / B」，乘数不是 1 时带「×乘数」）。venue、venueName 是旧接口字段（B 腿）。 */
  key: string; a: LegRef; b: LegRef; ratio: number; custom: boolean; note: string; venue: VenueId; venueName: string;
  symbol: string; name: string; kind: AssetKind; kindName: string; identity: Identity; eligible: boolean; gapBps: number | null;
  regime: Regime; sampleAt: number | null;
  /** 中间价基差、卖 A / 买 A 的可成交价差与往返盘口成本（基点）。 */ mid: number | null; sellA: number | null; buyA: number | null; estimated: boolean | null; cost: number | null;
  /** 两腿往返手续费（基点，`2 * (aFeeBps + bFeeBps)`）与总往返成本（盘口成本 + 往返手续费，不含滑点）；任一腿手续费未知时为 null。 */
  feeCost?: number | null; totalCost?: number | null;
  baseline: BaselineView | null;
  /** 中间价偏离基线的 σ 倍数；rich / cheap 是两个方向可成交价差相对基线的偏离（基点）。 */ z: number | null; rich: number | null; cheap: number | null;
  samples24h: number; firstAt: number | null;
  /** 平仓后的冷却截止时刻，已过期为 null。 */ cooldownUntil: number | null;
  /** entryBps、exitBps 是生效的值（自动配置时为推荐值）。auto：在用自动配置；autoPending：在用但样本还不够算出推荐值（按保存的参数显示，不开仓）。 */
  enabled: boolean; entryBps: number; exitBps: number; auto: boolean; autoPending: boolean;
  /** 当前允许开仓的方向；旧版状态可从同一份应答的 settings.symbols 读取。 */
  directions?: readonly Direction[];
  position: PositionSummary | null;
  /** 两腿每小时资金费率（小数，多头付费为正）。 */ aFunding: number | null; bFunding: number | null;
  /** 两腿手续费（基点，手动值或目录费率）；取不到为 null（不开仓）。 */ aFeeBps: number | null; bFeeBps: number | null;
  /** v0.114.0 起；旧服务没有这个字段。 */ gate?: GateView | null;
  /** 基线还在后台预热（服务刚启动或刚改了基线窗口）：baseline 暂时为 null，不是样本不足。v0.114.0 起。 */ baselineWarming?: boolean;
}
export interface OrphanRow {
  key: string; a: LegRef | null; b: LegRef | null; venue: VenueId | null; venueName: string; symbol: string; reason: string; enabled: boolean; lastSampleAt: number | null;
  position: PositionSummary | null;
}
export interface StateView {
  now: number; startedAt: number;
  sources: {
    /** Var 没有组合或手动配对用到时 enabled 为假。 */
    var: SourceState & { enabled: boolean; poll: PollStats | null; quoteAgeMedianMs: number | null; /** 引擎没有接询价器时为 null。 */ token: TokenView | null };
    venues: VenueStatus[]; live: LiveStats | null; /** v0.94.0 起。 */ push?: PushStats; combos: ComboView[];
  };
  firstSampleAt: number | null;
  rows: StateRow[];
  /** 已启用或有持仓、但不在当前配对里的键。 */
  orphans: OrphanRow[];
  settings: Settings;
  /** v0.112.0 起取代模拟盘汇总：实盘开关、在途与持有中的实盘持仓（含开仓中、平仓中）、今天已平的实盘净盈亏。 */
  trading: { on: boolean; /** 实盘准备页勾选的配对。 */ pairs: string[]; open: number; openNotionalUsd: number; todayNetUsd: number };
  regimeNames: Record<Regime, string>;
  venueNames: Record<VenueId, string>;
}

export interface SymbolPoint { gapBefore?: true; t: number; mid: number; sellA: number | null; buyA: number | null; median: number | null; sigma: number | null; regime: Regime; estimated: boolean }
export interface PositionMark { netUsd: number; pnlBps: number; at: number; estimated: boolean; varSource?: VarPriceSource }
export interface SymbolView {
  key: string; a: LegInfo & { name: string }; b: LegInfo & { name: string }; ratio: number; custom: boolean; note: string; venue: VenueId; venueName: string;
  symbol: string; name: string; kind: AssetKind; kindName: string; identity: Identity; eligible: boolean; gapBps: number | null;
  regimes: Regime[]; hours: number; from: number; to: number; bucket: SizeBucket;
  points: SymbolPoint[]; samples: number;
  stats: (RegimeStats & { suggestedEntryBps: number | null })[];
  /** params 是保存的参数，effective 是生效的（自动配置时入场、出场、止损、最长持有换成推荐值）；统计、走势的入场带与下单预演按 effective。 */
  params: SymbolParams; effective: SymbolParams; auto: AutoView; global: GlobalParams; latest: Sample | null; plans: OrderPlan[];
  /** 两腿手续费（基点）；取不到为 null。 */ fees: { a: number | null; b: number | null };
  /** 这个配对未结束的实盘持仓，按策略口径（入场为两腿实际成交均价）；mark 只在持有中时估。 */
  position: (Position & { state: LiveState; mark: PositionMark | null }) | null;
  /** 这个时段内这个配对已结束的实盘成交（两腿都开过、都平掉过的），按平仓时刻升序。 */
  trades: LiveTradeView[];
}
/** 详情页的一笔实盘成交：字段同回测成交，平仓原因可能是实盘自己的（not_filled 等不会出现，single_leg、dismissed 可能）。 */
export type LiveTradeView = Omit<ClosedTrade, 'reason'> & { reason: string };

export type BacktestView = BacktestResult & { truncated: boolean };

export interface StoredEventView { id: number; at: number; kind: string; symbol: string | null; message: string }

/** 原始样本的一页（docs/mcp.md 第 8.3 节）：rows 每行按 columns 的顺序；next 为本页最后一条的时刻，读完为 null。format 是样本格式版本（v0.88.0 起为 2）。 */
export interface SamplesView { symbol: string; format: number; columns: (keyof Sample)[]; rows: unknown[][]; next: number | null; firstAt: number | null; retentionDays: number }
/** 实盘页（docs/dexspread.md 第 13 节）：设置、凭据是否已录入（不含任何凭据内容）、持仓、成交与事件。 */
export interface LiveCandidate { key: string; symbol: string; a: LegRef; b: LegRef; /** 总览里是否启用了这个配对（实盘还要求启用）。 */ enabled: boolean }
/** 一笔未结束的实盘持仓按最新样本的估值与它的平仓线（v0.114.0 起）。 */
export interface LivePositionMark {
  /** 估值所用样本的时刻；没有样本为 null。 */ at: number | null;
  /** 按可成交价现在平掉的收益：相对入场的基点（不含滑点与手续费）与净额（美元，已扣四次成交的滑点与手续费）；不在持有中或缺可成交价为 null。 */
  pnlBps: number | null; netUsd: number | null; estimated: boolean | null;
  /** 开仓信号里的入场价差与按两腿实际成交均价算的入场价差（基点）；旧记录没有信号读数、两腿没都成交时分别为 null。 */
  signalSpread: number | null; entrySpread: number | null;
  /** 开仓时的基线、现在的基线（基点），以及中间价还偏离现在的基线多少（降到 exitBps 及以下回归平仓）；没有为 null。 */
  entryBaseline: number | null; baseline: number | null; deviation: number | null;
  /** 这笔仓的平仓规则：出场偏离、止损（基点）、最长持有（分钟）。 */
  exitBps: number; stopBps: number; maxHoldMinutes: number;
}
/** 有成交的已结束实盘持仓的分组汇总的一行：key 是配对键、UTC 日期（YYYY-MM-DD）或平仓原因。 */
export interface LiveBreakdownRow { key: string; trades: number; wins: number; netUsd: number }
/** 已结束实盘持仓的结果计数：有成交的、第一腿没成交的（not_filled）、其余没有成交就结束的；singleLeg 是有成交里单腿的笔数。 */
export interface LiveOutcomeCounts {
  traded: number; notFilled: number; other: number; singleLeg: number;
  /** notFilled 里没发出第一腿就放弃的笔数（意图过期、发单前的报价或实时价差复核没过）；其余是第一腿发出去却没成交。 */
  unsent?: number;
}
export interface LiveView {
  now: number; settings: LiveSettings; exec: LiveExecSettings; halt: string | null; paused: Record<string, string>;
  lastSkip: { at: number; symbol: string; reason: string } | null;
  skipStats: LiveSkipStats;
  privateStreams: Partial<Record<'lighter' | 'rh', LighterPrivateStatus>>;
  /** trades 是最近 50 笔已结束的持仓（含第一腿没成交、什么都没发生的）；totals 只算有成交的。 */
  positions: LivePosition[]; trades: LivePosition[]; todayNetUsd: number; totals: { trades: number; netUsd: number; wins: number };
  /** 以下 v0.114.0 起，旧服务没有：未结束持仓的估值与平仓线（按持仓编号）。 */
  marks?: Record<string, LivePositionMark>;
  /** trades 里排不下的、更早的有成交持仓（新的在前）：与 trades 里有成交的合起来是最近 50 笔有成交的，没成交的再多也挤不掉它们。 */
  tradedMore?: LivePosition[];
  /** 已结束持仓的结果计数：今天（UTC）与全部。 */
  outcomes?: { today: LiveOutcomeCounts; total: LiveOutcomeCounts };
  /** 有成交的已结束持仓按配对（净额绝对值大的在前，最多 50 个）、按 UTC 日（最近 14 天，新的在前）、按平仓原因的汇总。 */
  breakdown?: { byPair: LiveBreakdownRow[]; byDay: LiveBreakdownRow[]; byReason: LiveBreakdownRow[] };
  keys: LiveKeysView; keysProblem: string | null; signerProblem: string | null; venueNames: Record<VenueId, string>;
  candidates: LiveCandidate[]; events: StoredEventView[];
}
export interface ReadinessItem { key: string; status: 'ok' | 'warn' | 'todo'; label: string; detail: string }
/** 手动配对用的目录：各场所在交易的代码与标记价（场所没有在采集、目录未取到时为空）。 */
export interface CatalogEntry { symbol: string; mark: number | null }
export interface ReadinessView { now: number; items: ReadinessItem[]; ready: boolean; markets: Record<VenueId, CatalogEntry[]> }

/** 账户资产页签（docs/dexspread.md 第 14 节）：交易所实时资产、持仓、成交记录、资金费与盈亏汇总（不含账户标识与私钥）。 */
export interface VenuePositionView {
  venue: KeyVenue;
  venueName: string;
  collateralAsset: string;
  symbol: string;
  size: number;
  side: 'long' | 'short';
  valueUsd: number;
  entryPrice: number | null;
  markPrice: number | null;
  markEstimated: boolean;
  unrealizedPnl: number | null;
  unrealizedPnlPct: number | null;
  realizedPnl: number | null;
  liquidationPrice: number | null;
  leverage: number | null;
  marginMode: 'cross' | 'isolated' | null;
}

export interface VenueAccountView {
  venue: KeyVenue;
  name: string;
  collateralAsset: string;
  configured: boolean;
  hasTradingKey: boolean;
  at: number | null;
  stale: boolean;
  error: string | null;
  equity: number | null;
  collateral: number | null;
  available: number | null;
  marginUsed: number | null;
  unrealizedPnl: number | null;
  positionRealizedPnl: number | null;
  positionsCount: number;
  assets: AccountAsset[];
  historyAt: number | null;
  historyStale: boolean;
  authRequired: boolean;
  tradesError: string | null;
  fundingError: string | null;
  pnlError: string | null;
  tradesTruncated: boolean;
  fundingTruncated: boolean;
  summary: AccountHistorySummary;
  equityCurve: { t: number; equity: number }[];
  pnlCurve: AccountPnlPoint[];
}

export interface AccountsTotalsView {
  configured: number;
  fresh: number;
  staleVenues: KeyVenue[];
  errorVenues: KeyVenue[];
  complete: boolean;
  equityUsd: number | null;
  collateralUsd: number | null;
  availableUsd: number | null;
  marginUsedUsd: number | null;
  unrealizedPnlUsd: number | null;
  positionsCount: number;
  positionsNotionalUsd: number;
  tradeCount30d: number;
  volumeUsd30d: number;
  feeUsd30d: number | null;
  realizedPnlUsd30d: number | null;
  realizedVenues: KeyVenue[];
  fundingUsd30d: number | null;
  fundingVenues: KeyVenue[];
  liveTrades: number;
  liveNetUsd: number;
  liveTodayNetUsd: number;
  liveWins: number;
  liveOpenCount: number;
}

export interface AccountsView {
  now: number;
  windowDays: number;
  refreshing: boolean;
  cooldownMs: number;
  keysProblem: string | null;
  signerProblem: string | null;
  totals: AccountsTotalsView;
  venues: VenueAccountView[];
  positions: VenuePositionView[];
  trades: AccountTrade[];
  funding: AccountFunding[];
  equityCurve: { t: number; equity: number }[];
  equityComplete: boolean;
  liveTrades: LivePosition[];
  venueNames: Record<VenueId, string>;
}

export interface AccountsRefreshResult {
  triggered: boolean;
  cooldownMs: number;
  refreshing: boolean;
}

/** Entropy 真实成交对账明细（不含主账户地址明文）。 */
export interface EntropyFillView {
  tid: number; oid: number; cloid: string | null; time: number; coin: string; side: 'B' | 'A'; dir: string | null; crossed: boolean;
  px: number; sz: number; notionalUsd: number; feeUsd: number; feeToken: string; builderFeeUsd: number; closedPnl: number | null;
  livePositionId: string | null; livePurpose: string | null;
  assumedFeeBps: number | null; catalogFeeBps: number | null; deployerFeeScale: number | null; growthMode: string | null;
  hypePriceUsd: number | null;
}
/** Entropy 主账户 Hyperliquid 费率快照与当前估算假设。 */
export interface EntropyFeeSnapshotView {
  at: number; userCrossRate: number | null; userAddRate: number | null; referralDiscount: number | null; stakingDiscount: number | null;
  hypePriceUsd: number | null; assumedFeeBps: number | null;
}
/** 指定时间窗内的 Entropy 实扣费用与假设成本汇总。 */
export interface EntropyCostSummary {
  fills: number; takerFills: number; makerFills: number; platformFills: number; externalFills: number;
  notionalUsd: number; usdcNotionalUsd: number; usdcFeeUsd: number; builderFeeUsd: number; nonUsdcFeeCount: number;
  actualFeeBps: number | null; actualRoundTripBps: number | null;
  assumedFeeUsd: number; rebateGapUsd: number;
  weightedHypePriceUsd: number | null; hypeCoveredNotionalRatio: number | null;
}
export interface EntropyCostView {
  now: number; configured: boolean; from: number; to: number;
  assumedFeeBps: number | null; assumedRoundTripBps: number | null; catalogFeeBps: number | null; estimatedExchangeFeeBps: number | null;
  snapshot: EntropyFeeSnapshotView | null;
  sync: { lastSyncAt: number | null; lastOkAt: number | null; incomplete: boolean; error: string | null };
  summary: EntropyCostSummary;
  fills: EntropyFillView[];
}

// ---- Binance & 多参考源领先测速（#/varlighter/lead） ----
export type LeadRefSource =
  | 'binance_perp'
  | 'binance_spot'
  | 'binance_equity'
  | 'hl_xyz'
  | 'coinbase_spot'
  | 'okx_perp'
  | 'bybit_perp';
export type LeadVenue = 'lighter' | 'rh' | 'entropy';
export type LeadSource = LeadRefSource | LeadVenue;
export type LeadFollowStatus = 'followed' | 'unfollowed' | 'pending' | 'disconnected' | 'no_data' | 'cancelled';
export type LeadAssetCategory = 'us_equity' | 'crypto' | 'tradfi' | 'other';

export interface LeadWatcherConfig {
  symbol: string;
  leads: Partial<Record<LeadRefSource, string>>;
  targets: Partial<Record<LeadVenue, string>>;
  thresholdBps: number;
  impulseWindowMs: number;
  followRatio: number;
  maxWaitMs: number;
  cooldownMs: number;
}

export interface LeadRefCatalogEntry {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  contractType?: string;
}

export interface LeadSourceCatalogStatus {
  ok: number | null;
  count: number;
  error: string | null;
}

export interface LeadCatalogStatusView {
  loading: boolean;
  at: number | null;
  sources: Record<LeadRefSource, LeadSourceCatalogStatus>;
  contracts: Record<LeadRefSource, LeadRefCatalogEntry[]>;
}

export interface LeadCatalogEntry {
  symbol: string;
  mark: number | null;
}

export interface LeadCandidateView {
  symbol: string;
  kind: LeadAssetCategory;
  leads: Partial<Record<LeadRefSource, string>>;
  targets: Partial<Record<LeadVenue, string>>;
  leadCount: number;
  targetCount: number;
}

export interface LeadStreamView {
  source: LeadSource;
  name: string;
  symbol: string;
  connected: boolean;
  lastError: string | null;
  reconnects: number;
  ticks: number;
  ticksPerSec: number;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  spreadBps: number | null;
  lastTickAt: number | null;
  exchangeLagMs: number | null;
  basisBps: number | null;
}

export interface LeadXcorrPoint {
  lagMs: number;
  corr: number;
  samples: number;
}

export interface LeadXcorrView {
  peakLagMs: number;
  peakCorr: number;
  zeroCorr: number | null;
  samples: number;
  points: LeadXcorrPoint[];
}

export interface LeadVenueStatsView {
  venue: LeadVenue;
  name: string;
  symbol: string;
  followed: number;
  unfollowed: number;
  disconnected: number;
  noData: number;
  cancelled: number;
  pending: number;
  followRate: number | null;
  bnLeadCount: number;
  dexLeadCount: number;
  tieCount: number;
  bnLeadRate: number | null;
  medianMs: number | null;
  meanMs: number | null;
  p25Ms: number | null;
  p75Ms: number | null;
  p90Ms: number | null;
  p95Ms: number | null;
  minMs: number | null;
  maxMs: number | null;
  xcorr: LeadXcorrView | null;
  xcorrReason: string | null;
}

export interface LeadEventVenueView {
  status: LeadFollowStatus;
  lagMs: number | null;
  maxMoveBps: number | null;
}

export interface LeadEventView {
  id: number;
  leadSource: LeadRefSource;
  leadName: string;
  at: number;
  direction: 'up' | 'down';
  baseMid: number;
  triggerMid: number;
  moveBps: number;
  venues: Partial<Record<LeadVenue, LeadEventVenueView>>;
}

export interface LeadSeriesPoint {
  t: number;
  values: Partial<Record<LeadSource, number | null>>;
}

export interface LeadWatcherRecentRow {
  leadSource: LeadRefSource;
  name: string;
  symbol: string;
  events: number;
  venues: Partial<Record<LeadVenue, {
    followed: number;
    unfollowed: number;
    followRate: number | null;
    medianMs: number | null;
    bnLeadRate: number | null;
  }>>;
}

export interface LeadWatcherView {
  symbol: string;
  config: LeadWatcherConfig;
  enabled: boolean;
  status: 'running' | 'waiting_catalog' | 'paused';
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  runId: number | null;
  recentWindowSec: number;
  recentEventCount: number;
  streams: LeadStreamView[];
  recentSummary: LeadWatcherRecentRow[];
}

export interface LeadStoredSymbolSummary {
  symbol: string;
  events: number;
  gridPoints: number;
  firstAt: number | null;
  lastAt: number | null;
  leads: LeadRefSource[];
  targets: LeadVenue[];
}

export interface LeadStorageView {
  file: string;
  retentionDays: number;
  error: string | null;
  dbBytes: number | null;
  totalEvents: number;
  totalGridPoints: number;
  symbols: LeadStoredSymbolSummary[];
}

export interface LeadLeaderboardVenueCell {
  followed: number;
  unfollowed: number;
  followRate: number | null;
  medianMs: number | null;
  peakLagMs: number | null;
  peakCorr: number | null;
}

export interface LeadLeaderboardRow {
  leadSource: LeadRefSource;
  name: string;
  symbol: string;
  events: number;
  overallMedianMs: number | null;
  vsBinancePerpMs: number | null;
  vsBinancePerpCorr: number | null;
  venues: Partial<Record<LeadVenue, LeadLeaderboardVenueCell>>;
}

export interface LeadTimeBucketVenueCell {
  followed: number;
  unfollowed: number;
  followRate: number | null;
  medianMs: number | null;
}

export interface LeadTimeBucketView {
  at: number;
  events: number;
  venues: Partial<Record<LeadVenue, LeadTimeBucketVenueCell>>;
}

export interface LeadAnalyzeView {
  symbol: string;
  activeLead: LeadRefSource;
  availableLeads: LeadRefSource[];
  from: number;
  to: number;
  xcorrFrom: number;
  xcorrTo: number;
  xcorrTruncated: boolean;
  gridTruncated: boolean;
  bucketMs: number;
  computedMs: number;
  eventCount: number;
  dataRange: { firstAt: number | null; lastAt: number | null };
  leaderboard: LeadLeaderboardRow[];
  venues: LeadVenueStatsView[];
  buckets: LeadTimeBucketView[];
  events: LeadEventView[];
  series: LeadSeriesPoint[];
}

export interface LeadView {
  now: number;
  maxWatchers: number;
  retentionDays: number;
  catalog: LeadCatalogStatusView;
  dexCatalogs: Record<LeadVenue, LeadCatalogEntry[]>;
  candidates: LeadCandidateView[];
  storage: LeadStorageView;
  watchers: LeadWatcherView[];
}
