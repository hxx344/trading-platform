// 价差回归策略（docs/varlighter.md 第 5 节、docs/dexspread.md 第 5 节）：参数、开平仓判断与盈亏。回测（backtest.ts）与模拟盘（engine.ts）共用，
// 只有纯计算，不读写存储。A、B 是配对的两条腿（Var/Lighter 配对里 A 是 Var）。
import { REGIMES, bucketOf, missingDecisionTop, spreadOf, targetSpread, type Regime, type Sample, type Spread, type VarPriceSource, type VenueId } from './model.ts';
import type { Baseline, RegimeStats } from './stats.ts';

/** a_rich：A 相对偏贵，卖 A、买 B；a_cheap：买 A、卖 B。v0.87.0 以前叫 var_rich、var_cheap。 */
export type Direction = 'a_rich' | 'a_cheap';
export const DIRECTIONS: readonly Direction[] = ['a_rich', 'a_cheap'];
export const DIRECTION_NAMES: Record<Direction, string> = { a_rich: '卖 A / 买 B', a_cheap: '买 A / 卖 B' };
/** 旧方向名换成新的；不认识的返回 null。 */
export const upgradeDirection = (value: unknown): Direction | null =>
  value === 'a_rich' || value === 'var_rich' ? 'a_rich' : value === 'a_cheap' || value === 'var_cheap' ? 'a_cheap' : null;

export interface SymbolParams {
  /** 模拟盘是否对这个配对开仓（已有持仓照常按规则平仓）。 */ enabled: boolean;
  /** 每笔名义金额（美元），两腿同样的名义（B 腿数量 = A 腿数量 × 乘数）。 */ notionalUsd: number;
  /** 可成交价差偏离基线至少这么多基点才开仓。 */ entryBps: number;
  /** 中间价基差回到基线 ± 这么多基点以内就平仓；可为负（要求越过基线）。每笔约赚「入场 − 出场 − 半个往返成本」。 */ exitBps: number;
  /** 按可成交价算的浮亏达到这么多基点就止损。 */ stopBps: number;
  maxHoldMinutes: number;
  /** 平仓后多久内不再开同一配对。 */ cooldownMinutes: number;
  /** 允许开仓的时段（不影响平仓）。 */ regimes: Regime[];
  directions: Direction[];
}
/** 各场所手续费的手动值（基点，每次成交）；null 表示按场所目录（Var 为 0，Lighter 取目录的吃单费率，Entropy 按部署方系数算）。 */
export const FEE_FIELDS = { var: 'varFeeBps', rh: 'rhFeeBps', lighter: 'lighterFeeBps', entropy: 'entropyFeeBps' } as const satisfies Record<VenueId, string>;
export interface GlobalParams {
  /** 基线窗口（小时）。 */ windowHours: number;
  /** 基线最少样本数（按每分钟一个计；两腿都是行情流的配对每分钟只计一个）。 */ minSamples: number;
  /** 每次成交的滑点（基点，每条腿每次各计一次）。 */ slippageBps: number;
  varFeeBps: number | null; rhFeeBps: number | null; lighterFeeBps: number | null;
  /** Entropy 单边手续费（基点）：默认 0.2（往返 0.4，含返佣估算）；留空（null）按目录原始费率。 */ entropyFeeBps: number | null;
  /** 在决策时逐腿核对实际成交报价的最大年龄（秒）。 */ maxQuoteAgeSec: number;
  /** 预期净利（偏离 − 出场 − 半个往返成本 − 四次成交的滑点与手续费，基点）低于这个数不开仓。 */ minNetBps: number;
  maxOpenPositions: number;
  /** 所有持仓名义金额合计上限（美元）。 */ maxTotalNotionalUsd: number;
  /** 当日（UTC）已实现净亏损达到这个数（美元）后当天不再开仓。 */ dailyLossLimitUsd: number;
  /** 暂停：不再开新仓，已有持仓照常按规则平仓。 */ paused: boolean;
}

export const DEFAULT_SYMBOL: SymbolParams = { enabled: false, notionalUsd: 1000, entryBps: 15, exitBps: 0, stopBps: 60, maxHoldMinutes: 720, cooldownMinutes: 10, regimes: [...REGIMES], directions: [...DIRECTIONS] };
export const DEFAULT_GLOBAL: GlobalParams = { windowHours: 24, minSamples: 120, slippageBps: 1, varFeeBps: null, rhFeeBps: null, lighterFeeBps: null, entropyFeeBps: 0.2, maxQuoteAgeSec: 30, minNetBps: 3, maxOpenPositions: 5, maxTotalNotionalUsd: 10_000, dailyLossLimitUsd: 100, paused: false };
/** 一条腿的手续费：手动值优先，其次目录费率；都没有为 null（不开仓）。 */
export const legFeeBps = (global: GlobalParams, venue: VenueId, catalogBps: number | null): number | null => global[FEE_FIELDS[venue]] ?? catalogBps;

export class ParamsError extends Error { readonly status = 400; }
const fail = (message: string): never => { throw new ParamsError(message); };
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function only(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (!isObject(value)) fail(`${name}须为对象`);
  const unknown = Object.keys(value as object).find(key => !keys.includes(key));
  if (unknown) fail(`${name}包含未知字段 ${unknown.slice(0, 40)}`);
  return value as Record<string, unknown>;
}
function num(value: unknown, min: number, max: number, name: string, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) fail(`${name}须为 ${min} 到 ${max} 之间的${integer ? '整数' : '数'}`);
  return value as number;
}
function list<T extends string>(value: unknown, options: readonly T[], name: string): T[] {
  if (!Array.isArray(value) || value.length > options.length || value.some(item => !options.includes(item as T)) || new Set(value).size !== value.length) fail(`${name}无效`);
  return options.filter(option => (value as string[]).includes(option));
}

/** 页面提交的单个配对参数；缺的字段用 base 补（新配对用默认值）。 */
export function readSymbolParams(value: unknown, base: SymbolParams = DEFAULT_SYMBOL): SymbolParams {
  const raw = only(value, Object.keys(DEFAULT_SYMBOL), '标的参数');
  const pick = <K extends keyof SymbolParams>(key: K) => (raw[key] === undefined ? base[key] : raw[key]) as unknown;
  const enabled = pick('enabled');
  if (typeof enabled !== 'boolean') fail('启用须为 true 或 false');
  const params: SymbolParams = {
    enabled: enabled as boolean,
    notionalUsd: num(pick('notionalUsd'), 10, 100_000, '名义金额'),
    entryBps: num(pick('entryBps'), 0.5, 2000, '入场偏离'),
    exitBps: num(pick('exitBps'), -500, 500, '出场偏离'),
    stopBps: num(pick('stopBps'), 1, 5000, '止损'),
    maxHoldMinutes: num(pick('maxHoldMinutes'), 1, 43_200, '最长持有', true),
    cooldownMinutes: num(pick('cooldownMinutes'), 0, 1440, '冷却', true),
    regimes: list(pick('regimes'), REGIMES, '允许开仓的时段'),
    directions: list(pick('directions'), DIRECTIONS, '方向'),
  };
  if (params.exitBps >= params.entryBps) fail('出场偏离须小于入场偏离，否则开仓即满足平仓条件');
  if (!params.directions.length) fail('至少选择一个方向');
  if (!params.regimes.length) fail('至少选择一个时段');
  return params;
}
export function readGlobalParams(value: unknown, base: GlobalParams = DEFAULT_GLOBAL): GlobalParams {
  const raw = only(value, Object.keys(DEFAULT_GLOBAL), '全局参数');
  const pick = <K extends keyof GlobalParams>(key: K) => (raw[key] === undefined ? base[key] : raw[key]) as unknown;
  const paused = pick('paused');
  if (typeof paused !== 'boolean') fail('暂停须为 true 或 false');
  const fee = (venue: VenueId, name: string): number | null => { const value = pick(FEE_FIELDS[venue]); return value === null ? null : num(value, 0, 100, `${name}手续费`); };
  return {
    windowHours: num(pick('windowHours'), 1, 24 * 30, '基线窗口', true),
    minSamples: num(pick('minSamples'), 10, 50_000, '基线最少样本', true),
    slippageBps: num(pick('slippageBps'), 0, 100, '滑点'),
    varFeeBps: fee('var', 'Var '), rhFeeBps: fee('rh', 'Lighter RH '), lighterFeeBps: fee('lighter', 'Lighter '), entropyFeeBps: fee('entropy', 'Entropy '),
    maxQuoteAgeSec: num(pick('maxQuoteAgeSec'), 5, 600, '报价时效', true),
    minNetBps: num(pick('minNetBps'), 0, 500, '最低预期净利'),
    maxOpenPositions: num(pick('maxOpenPositions'), 1, 100, '最多持仓数', true),
    maxTotalNotionalUsd: num(pick('maxTotalNotionalUsd'), 10, 10_000_000, '名义合计上限'),
    dailyLossLimitUsd: num(pick('dailyLossLimitUsd'), 1, 10_000_000, '当日亏损上限'),
    paused: paused as boolean,
  };
}
/** 自动配置接管的参数：其余（名义金额、冷却、时段、方向）仍用保存的。 */
export interface AutoParams { entryBps: number; exitBps: number; stopBps: number; maxHoldMinutes: number }
/**
 * 按近期统计给一个配对推荐参数（自动配置用，docs/varlighter.md 第 5 节）：
 * - 入场 = 中间价偏离的 95 分位 − 半个往返成本（历史上约 5% 的时间能触发），且不低于「刚到入场线时预期净利仍达最低净利」的偏离
 *   （半个往返成本 + 四次成交的滑点 + 两腿开平的手续费 + 最低净利），也不低于 5 基点；
 * - 出场 = -2 基点（多等 2 基点回归空间覆盖滑点）；止损 = 往返成本 + 3 倍入场偏离（开仓时浮亏就等于往返成本，再留 3 倍入场偏离的余地），不低于 20 基点；
 * - 最长持有 = 6 个半衰期，限在 1 到 24 小时；统计里不回归时用默认的 12 小时。
 * 统计里没有往返成本或偏离分位（样本没有可成交价）时返回 null。
 */
export function recommendParams(stats: Pick<RegimeStats, 'costMedian' | 'deviation95' | 'halfLifeMin'>, costs: Pick<GlobalParams, 'slippageBps' | 'minNetBps'> & LegFees): AutoParams | null {
  if (stats.costMedian === null || stats.deviation95 === null) return null;
  const cost = Math.max(0, stats.costMedian);
  const breakEven = cost / 2 + 4 * costs.slippageBps + 2 * (costs.aFeeBps + costs.bFeeBps) + costs.minNetBps;
  const entryBps = Math.min(2000, Math.max(5, Math.round(stats.deviation95 - cost / 2), Math.ceil(breakEven)));
  return {
    entryBps, exitBps: -2, stopBps: Math.min(5000, Math.max(20, Math.round(cost + 3 * entryBps))),
    maxHoldMinutes: stats.halfLifeMin === null ? DEFAULT_SYMBOL.maxHoldMinutes : Math.min(1440, Math.max(60, Math.ceil(6 * stats.halfLifeMin))),
  };
}

/** v0.87.0 以前存的全局参数：Var 与 Lighter 手续费是数（默认 0），0 换成「按目录」，非 0 的 Lighter 费率两个 Lighter 场所都用。 */
export function upgradeGlobal(value: unknown): GlobalParams {
  if (!isObject(value)) return DEFAULT_GLOBAL;
  const { varFeeBps, rhFeeBps, ...rest } = value;
  const known = Object.fromEntries(Object.entries(rest).filter(([key]) => key in DEFAULT_GLOBAL));
  const fee = (raw: unknown) => typeof raw === 'number' && raw > 0 ? raw : null;
  try {
    return readGlobalParams({ ...known, varFeeBps: fee(varFeeBps), rhFeeBps: fee(rhFeeBps), lighterFeeBps: 'lighterFeeBps' in value ? value.lighterFeeBps : fee(rhFeeBps) });
  } catch { return DEFAULT_GLOBAL; }
}

// ---- 开平仓 ----
/**
 * qty 是 A 腿数量，B 腿使用实盘记录的 bQty 或模拟对冲量 qty × ratio。aEntry 是 A 腿成交价，
 * bEntry 是 B 腿原生成交价乘 ratio 后的折算价。手续费在开仓时记下，平仓沿用。
 */
export interface Position {
  id: string; symbol: string; direction: Direction; openedAt: number; qty: number; notionalUsd: number;
  /** 实盘 B 腿实际剩余的原生数量，含步长取整和已平部分。回测仓按 qty × ratio 对冲。 */
  bQty?: number;
  /** 开仓时的可成交价差（基点）、基线与往返成本（基点）。 */ entrySpread: number; entryBaseline: number; entryRegime: Regime;
  aEntry: number; bEntry: number; estimated: boolean; ratio: number; aFeeBps: number; bFeeBps: number;
  entryVarSource?: VarPriceSource;
  entryCostBps?: number;
}
export interface ClosedTrade extends Position {
  closedAt: number; aExit: number; bExit: number; exitSpread: number; reason: CloseReason;
  grossUsd: number; costUsd: number; netUsd: number; netBps: number;
  exitVarSource?: VarPriceSource;
  /** 资金费估算（美元），只作参考，不计入 netUsd。 */ fundingUsd: number | null;
}
export type CloseReason = 'revert' | 'stop' | 'timeout' | 'manual';
export const CLOSE_REASON_NAMES: Record<CloseReason, string> = { revert: '回归平仓', stop: '止损', timeout: '超时平仓', manual: '手动平仓' };

export type Decision =
  | { kind: 'open'; direction: Direction; spread: Spread; deviation: number }
  | { kind: 'close'; reason: CloseReason; spread: Spread; deviation: number }
  | { kind: 'hold'; deviation: number | null }
  | { kind: 'wait'; reason: string };

/** 持仓当前按可成交价平仓的价差（基点）与对开仓的收益（基点，正为盈利，不含滑点与手续费）。 */
export function markToMarket(position: Position, spread: Spread): { exitSpread: number; pnlBps: number } {
  return position.direction === 'a_rich'
    ? { exitSpread: spread.buyA, pnlBps: position.entrySpread - spread.buyA }
    : { exitSpread: spread.sellA, pnlBps: spread.sellA - position.entrySpread };
}

/**
 * 持仓信号按实际数量逐腿估算公开盘口冲击；同一套取价规则用于平仓与回测期末估值。
 */
export function positionSpread(sample: Sample, position: Position): Spread | null {
  return targetSpread(sample, position, false)?.spread ?? null;
}

/** 已有持仓：回归、止损、超时；没有持仓：按方向与偏离开仓。时段、报价时效与风控限制由调用方在开仓前另外判断。 */
export function decide(sample: Sample, baseline: Baseline | null, params: SymbolParams, position: Position | null, spread = position ? positionSpread(sample, position) : spreadOf(sample, bucketOf(params.notionalUsd))): Decision {
  if (!spread) return { kind: 'wait', reason: '该档位缺少可成交价格（100k 档需要两腿的完整盘口）' };
  if (position) {
    const { pnlBps } = markToMarket(position, spread);
    if (pnlBps <= -params.stopBps) return { kind: 'close', reason: 'stop', spread, deviation: baseline ? deviationToClose(position.direction, spread, baseline.median) : 0 };
    if (sample.t - position.openedAt >= params.maxHoldMinutes * 60_000) return { kind: 'close', reason: 'timeout', spread, deviation: baseline ? deviationToClose(position.direction, spread, baseline.median) : 0 };
    if (!baseline) return { kind: 'hold', deviation: null };
    const deviation = deviationToClose(position.direction, spread, baseline.median);
    if (deviation <= params.exitBps) {
      // 出场价差成本护栏：盘口点差异常拉宽且按当前价差平仓仍浮亏时暂缓回归平仓（绝不拦截止损或超时）。
      const exitCost = spread.buyA - spread.sellA;
      if (exitCost > Math.max(15, 2.5 * Math.max(0, position.entryCostBps ?? 0)) && pnlBps < 0) return { kind: 'hold', deviation };
      return { kind: 'close', reason: 'revert', spread, deviation };
    }
    return { kind: 'hold', deviation };
  }
  if (!baseline) return { kind: 'wait', reason: '基线样本不足' };
  const rich = spread.sellA - baseline.median, cheap = baseline.median - spread.buyA;
  if (params.directions.includes('a_rich') && rich >= params.entryBps) return { kind: 'open', direction: 'a_rich', spread, deviation: rich };
  if (params.directions.includes('a_cheap') && cheap >= params.entryBps) return { kind: 'open', direction: 'a_cheap', spread, deviation: cheap };
  return { kind: 'hold', deviation: Math.max(rich, cheap) };
}
/**
 * 中间价基差还偏离基线多少（基点，正数表示尚未回到基线）。开仓按可成交价差判断（已含半个往返成本），平仓按中间价
 * 判断：若也按可成交价差，中间价回到基线时可成交价差仍差半个往返成本，永远等不到平仓。
 */
export function deviationToClose(direction: Direction, spread: Spread, median: number): number {
  return direction === 'a_rich' ? spread.mid - median : median - spread.mid;
}

export interface LegFees { aFeeBps: number; bFeeBps: number }
/** Var 精确询价成交时按所询数量建仓并按乘数对冲；公开档位按名义金额除以折算后的 B 中间价建仓。 */
export function openPosition(id: string, sample: Sample, params: SymbolParams, decision: Extract<Decision, { kind: 'open' }>, baseline: Baseline, fees: LegFees): Position {
  const { spread, direction } = decision, prices = spread.prices;
  const qty = spread.varQtyA ?? params.notionalUsd / prices.bMid;
  return {
    id, symbol: sample.symbol, direction, openedAt: sample.t, qty, notionalUsd: params.notionalUsd,
    entrySpread: direction === 'a_rich' ? spread.sellA : spread.buyA, entryBaseline: baseline.median, entryRegime: sample.regime,
    aEntry: direction === 'a_rich' ? prices.aBid : prices.aAsk, bEntry: direction === 'a_rich' ? prices.bAsk : prices.bBid, estimated: spread.estimated,
    ratio: sample.ratio, aFeeBps: fees.aFeeBps, bFeeBps: fees.bFeeBps,
    entryCostBps: spread.buyA - spread.sellA,
    ...(spread.varSource && { entryVarSource: spread.varSource }),
  };
}

/** B 腿的价格已按乘数折算成 A 单位；用同一单位的实际数量换算名义额。 */
const bQtyInA = (position: Position): number => position.bQty === undefined ? position.qty : position.bQty / position.ratio;

/** 平仓结算：价差收益按两腿实际成交价算；滑点与手续费按四次成交（每腿开平各一次）的名义金额扣，手续费用开仓时记下的。 */
export function closePosition(position: Position, at: number, spread: Spread, reason: CloseReason, global: Pick<GlobalParams, 'slippageBps'>, fundingUsd: number | null): ClosedTrade {
  const prices = spread.prices, rich = position.direction === 'a_rich';
  const aExit = rich ? prices.aAsk : prices.aBid, bExit = rich ? prices.bBid : prices.bAsk;
  const aPnl = (rich ? position.aEntry - aExit : aExit - position.aEntry) * position.qty;
  const bQty = bQtyInA(position);
  const bPnl = (rich ? bExit - position.bEntry : position.bEntry - bExit) * bQty;
  const tradedA = position.qty * (position.aEntry + aExit), tradedB = bQty * (position.bEntry + bExit);
  const costUsd = (tradedA * (global.slippageBps + position.aFeeBps) + tradedB * (global.slippageBps + position.bFeeBps)) / 10_000;
  const grossUsd = aPnl + bPnl, netUsd = grossUsd - costUsd;
  return { ...position, closedAt: at, aExit, bExit, exitSpread: rich ? spread.buyA : spread.sellA, reason, grossUsd, costUsd, netUsd, netBps: netUsd / position.notionalUsd * 10_000, fundingUsd,
    estimated: position.estimated || spread.estimated, ...(spread.varSource && { exitVarSource: spread.varSource }) };
}

/**
 * 资金费估算（美元，正为收入）：两腿每小时费率（多头付费为正；Var 的年化推测口径已折成每小时）按持有时长线性累计。
 * a_rich 是 A 空头、B 多头。只作参考，不进净盈亏。
 */
export function fundingEstimate(position: Position, until: number, aHourly: number | null, bHourly: number | null): number | null {
  if (aHourly === null || bHourly === null) return null;
  const hours = Math.max(0, until - position.openedAt) / 3_600_000;
  const sign = position.direction === 'a_rich' ? 1 : -1;
  return sign * aHourly * hours * position.qty * position.aEntry - sign * bHourly * hours * bQtyInA(position) * position.bEntry;
}

/**
 * 这次开仓的预期净利（基点）：平仓时中间价回到「基线 + 出场偏离」，可成交价还差半个往返成本，再扣四次成交
 * （两腿开平各一次）的滑点与手续费。往返成本按开仓时的算。
 */
export function expectedNetBps(decision: Extract<Decision, { kind: 'open' }>, params: Pick<SymbolParams, 'exitBps'>, costs: Pick<GlobalParams, 'slippageBps'> & LegFees): number {
  const halfCost = (decision.spread.buyA - decision.spread.sellA) / 2;
  return decision.deviation - params.exitBps - halfCost - 4 * costs.slippageBps - 2 * (costs.aFeeBps + costs.bFeeBps);
}

/**
 * 实盘每条腿每次成交的限价保护（基点）：偏离刚好等于入场线时，四次成交把保护用满后仍剩最低净利，
 * 即（入场 − 出场 − 半个往返成本 − 手续费 − 最低净利）÷ 4，限在 1 到 10 基点。算出来不足 1 时取 1，
 * 这时保护用满会低于最低净利（这样的机会本来也过不了预期净利门槛）。
 */
export function slippageBudgetBps(params: Pick<SymbolParams, 'entryBps' | 'exitBps'>, costs: Pick<GlobalParams, 'minNetBps'> & LegFees, halfCostBps: number): number {
  return Math.min(10, Math.max(1, (params.entryBps - params.exitBps - Math.max(0, halfCostBps) - 2 * (costs.aFeeBps + costs.bFeeBps) - costs.minNetBps) / 4));
}

export const DECAYED = '拿到报价时信号已消失', NO_LIVE_TOP = '缺少判断时刻的一档';
export const NO_QUOTE_TIME = '缺少决策或逐腿报价时间证据', STALE_QUOTE = '报价过旧';
/**
 * 开仓复核：有 Var 腿的配对，信号按 Var 报价时刻的样本算出，拿到报价时已过去约 20 秒。按判断时刻的行情流一档（与 Var 询价）重算，
 * 方向不变且仍达到入场偏离才开，并按那一刻的价成交。历史样本缺少决策时间、行情流一档或其来源时刻时只进入基线。
 * 返回字符串是不开仓的原因。
 */
export function confirmOpen(sample: Sample, baseline: Baseline, params: SymbolParams, decision: Extract<Decision, { kind: 'open' }>, maxQuoteAgeSec: number): Extract<Decision, { kind: 'open' }> | string {
  const aligned = sample.captureKind === 'aligned', at = aligned ? sample.receivedAt : sample.decisionAt;
  if (at === null || !Number.isFinite(at) || at < sample.receivedAt) return NO_QUOTE_TIME;
  const fill = targetSpread(sample, params, !aligned);
  if (!fill) return missingDecisionTop(sample) ? NO_LIVE_TOP : '目标数量缺少可成交盘口';
  if (fill.oldestAt === null || !Number.isFinite(fill.oldestAt)) return NO_QUOTE_TIME;
  if (at - fill.oldestAt > maxQuoteAgeSec * 1000) return STALE_QUOTE;
  if (aligned) fill.spread.estimated = true;
  const again = decide(sample, baseline, params, null, fill.spread);
  return again.kind === 'open' && again.direction === decision.direction ? again : DECAYED;
}
/** 自动与手动平仓、浮盈与回测期末估值使用同一份持仓数量和逐腿取价规则。 */
export function closeSpread(sample: Sample, position: Position): Spread | null {
  const fill = targetSpread(sample, position, true);
  if (fill) return fill.spread;
  const quoted = positionSpread(sample, position);
  return quoted && { ...quoted, estimated: true };
}

/**
 * 报价复核后的开仓风控；返回不开仓的原因，可以开则为 null。回测与模拟盘共用。
 * legBusy：这个配对的某条腿（同场所同代码）已在另一个配对持仓。场所的持仓按代码合并，两笔反向会互相抵消，所以每条腿同时只开一笔。
 * feeUnknown：某条腿的手续费既没有手动值也取不到目录费率。
 * fallbackBaseline：本时段样本不足、基线退回了全天窗口。时段刚切换（周一开盘、进周末）时全天窗口里是上一个时段的基差，不开仓。
 * expectedNetBps：见 expectedNetBps()。costBps：开仓时的往返成本（买 A 价差 − 卖 A 价差）；开仓后按可成交价的浮亏
 * 一开始就等于它，达到止损线的话下一个样本就止损，所以不开。
 * autoPending：配对用自动配置，但近期样本还不够算出推荐参数。
 */
export interface GateContext { openPositions: number; openNotionalUsd: number; dailyNetUsd: number; cooldownUntil: number; eligible: boolean; legBusy?: boolean; feeUnknown?: boolean; fallbackBaseline?: boolean; expectedNetBps?: number; costBps?: number; autoPending?: boolean }
export const FALLBACK_BLOCK = '本时段基线样本不足（全天基线不开仓）', THIN_BLOCK = '预期净利不足', COST_BLOCK = '往返成本已达止损线', FEE_BLOCK = '手续费未知', BUSY_BLOCK = '同一腿已在另一配对持仓', AUTO_BLOCK = '自动配置的样本不足';
export const SPEC_BLOCK = '规格未确认', LOSS_BLOCK = '当日亏损已达上限';
/** openBlocker 的原因里不处理就一直开不了的；其余是策略本来就会等的（时段、冷却、净利不足、限额占满等）或用户自己的设置（暂停、未启用）。 */
export const ATTENTION_BLOCKS: ReadonlySet<string> = new Set([SPEC_BLOCK, FEE_BLOCK, COST_BLOCK, LOSS_BLOCK]);
/**
 * 复核后的开仓决定对应的两个门槛读数。
 * `quoted`：报价时刻（复核前）的开仓决定，只在样本带 Var token 询价时传（不带询价时与 v0.81.0 相同，只看复核后的）。开仓后的止损仍按公开报价的样本判断，所以成本门槛取复核后与报价时刻两种口径里
 * 较大的往返成本：按 token 询价复核后成本很小、公开档位成本却已到止损线的仓，开了下一个样本就会止损。
 */
export const openEconomics = (decision: Extract<Decision, { kind: 'open' }>, params: Pick<SymbolParams, 'exitBps'>, costs: Pick<GlobalParams, 'slippageBps'> & LegFees, quoted?: Extract<Decision, { kind: 'open' }>) =>
  ({ expectedNetBps: expectedNetBps(decision, params, costs), costBps: Math.max(decision.spread.buyA - decision.spread.sellA, quoted ? quoted.spread.buyA - quoted.spread.sellA : -Infinity) });
export function openBlocker(sample: Sample, params: SymbolParams, global: GlobalParams, context: GateContext): string | null {
  if (global.paused) return '已暂停';
  if (!params.enabled) return '未启用';
  if (!context.eligible) return SPEC_BLOCK;
  if (context.autoPending) return AUTO_BLOCK;
  if (!params.regimes.includes(sample.regime)) return '当前时段不开仓';
  if (context.fallbackBaseline) return FALLBACK_BLOCK;
  if (sample.t < context.cooldownUntil) return '冷却中';
  if (context.feeUnknown) return FEE_BLOCK;
  if (context.costBps !== undefined && context.costBps >= params.stopBps) return COST_BLOCK;
  if (context.expectedNetBps !== undefined && context.expectedNetBps < global.minNetBps) return THIN_BLOCK;
  if (context.legBusy) return BUSY_BLOCK;
  if (context.openPositions >= global.maxOpenPositions) return '持仓数已满';
  if (context.openNotionalUsd + params.notionalUsd > global.maxTotalNotionalUsd) return '名义合计将超上限';
  if (context.dailyNetUsd <= -global.dailyLossLimitUsd) return LOSS_BLOCK;
  return null;
}

/** v0.87.0 以前存的持仓与成交（var 与 rh 前缀字段、var_rich 方向）换成两腿口径；已是新格式的原样返回，认不出的返回 null。 */
export function upgradePosition<T extends Position | ClosedTrade>(raw: unknown, symbol: string, legacyFees: LegFees): T | null {
  if (!isObject(raw)) return null;
  const direction = upgradeDirection(raw.direction);
  if (!direction) return null;
  if (typeof raw.aEntry === 'number') return { ...raw, symbol, direction } as T;
  if (typeof raw.varEntry !== 'number' || typeof raw.rhEntry !== 'number') return null;
  const { varEntry, rhEntry, varExit, rhExit, ...rest } = raw;
  const upgraded: Record<string, unknown> = { ...rest, symbol, direction, aEntry: varEntry, bEntry: rhEntry, ratio: 1, aFeeBps: legacyFees.aFeeBps, bFeeBps: legacyFees.bFeeBps };
  if (typeof varExit === 'number' && typeof rhExit === 'number') { upgraded.aExit = varExit; upgraded.bExit = rhExit; }
  return upgraded as unknown as T;
}
