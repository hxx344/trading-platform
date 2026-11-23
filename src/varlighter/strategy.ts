// 价差回归策略（docs/varlighter.md 第 5 节）：参数、开平仓判断与盈亏。回测（backtest.ts）与模拟盘（paper.ts）共用，
// 只有纯计算，不读写存储。
import { REGIMES, bucketOf, spreadOf, type Regime, type Sample, type Spread } from './model.ts';
import type { Baseline } from './stats.ts';

/** var_rich：Var 相对偏贵，卖 Var、买 Lighter；var_cheap：买 Var、卖 Lighter。 */
export type Direction = 'var_rich' | 'var_cheap';
export const DIRECTION_NAMES: Record<Direction, string> = { var_rich: '卖 Var / 买 Lighter', var_cheap: '买 Var / 卖 Lighter' };

export interface SymbolParams {
  /** 模拟盘是否对这个标的开仓（已有持仓照常按规则平仓）。 */ enabled: boolean;
  /** 每笔名义金额（美元），两腿同样的基础数量。 */ notionalUsd: number;
  /** 可成交价差偏离基线至少这么多基点才开仓。 */ entryBps: number;
  /** 中间价基差回到基线 ± 这么多基点以内就平仓；可为负（要求越过基线）。每笔约赚「入场 − 出场 − 半个往返成本」。 */ exitBps: number;
  /** 按可成交价算的浮亏达到这么多基点就止损。 */ stopBps: number;
  maxHoldMinutes: number;
  /** 平仓后多久内不再开同一标的。 */ cooldownMinutes: number;
  /** 允许开仓的时段（不影响平仓）。 */ regimes: Regime[];
  directions: Direction[];
}
export interface GlobalParams {
  /** 基线窗口（小时）。 */ windowHours: number;
  /** 基线最少样本数。 */ minSamples: number;
  /** 每次成交的滑点（基点，每条腿每次各计一次）。 */ slippageBps: number;
  /** 两边每次成交的手续费（基点）。公开目录 2026-11-22 显示 Lighter RH 标准账户为 0；Var 不收交易手续费，价差即成本。 */
  varFeeBps: number; rhFeeBps: number;
  /** Var 报价收到时已过去的时间上限（秒），超过不开仓。 */ maxQuoteAgeSec: number;
  maxOpenPositions: number;
  /** 所有持仓名义金额合计上限（美元）。 */ maxTotalNotionalUsd: number;
  /** 当日（UTC）已实现净亏损达到这个数（美元）后当天不再开仓。 */ dailyLossLimitUsd: number;
  /** 暂停：不再开新仓，已有持仓照常按规则平仓。 */ paused: boolean;
}

export const DEFAULT_SYMBOL: SymbolParams = { enabled: false, notionalUsd: 1000, entryBps: 15, exitBps: 0, stopBps: 60, maxHoldMinutes: 720, cooldownMinutes: 10, regimes: [...REGIMES], directions: ['var_rich', 'var_cheap'] };
export const DEFAULT_GLOBAL: GlobalParams = { windowHours: 24, minSamples: 120, slippageBps: 1, varFeeBps: 0, rhFeeBps: 0, maxQuoteAgeSec: 90, maxOpenPositions: 5, maxTotalNotionalUsd: 10_000, dailyLossLimitUsd: 100, paused: false };

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

/** 页面提交的单个标的参数；缺的字段用 base 补（新标的用默认值）。 */
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
    directions: list(pick('directions'), ['var_rich', 'var_cheap'] as const, '方向'),
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
  return {
    windowHours: num(pick('windowHours'), 1, 24 * 30, '基线窗口', true),
    minSamples: num(pick('minSamples'), 10, 50_000, '基线最少样本', true),
    slippageBps: num(pick('slippageBps'), 0, 100, '滑点'),
    varFeeBps: num(pick('varFeeBps'), 0, 100, 'Var 手续费'),
    rhFeeBps: num(pick('rhFeeBps'), 0, 100, 'Lighter 手续费'),
    maxQuoteAgeSec: num(pick('maxQuoteAgeSec'), 5, 600, '报价时效', true),
    maxOpenPositions: num(pick('maxOpenPositions'), 1, 100, '最多持仓数', true),
    maxTotalNotionalUsd: num(pick('maxTotalNotionalUsd'), 10, 10_000_000, '名义合计上限'),
    dailyLossLimitUsd: num(pick('dailyLossLimitUsd'), 1, 10_000_000, '当日亏损上限'),
    paused: paused as boolean,
  };
}

// ---- 开平仓 ----
export interface Position {
  id: string; symbol: string; direction: Direction; openedAt: number; qty: number; notionalUsd: number;
  /** 开仓时的可成交价差（基点）与基线。 */ entrySpread: number; entryBaseline: number; entryRegime: Regime;
  varEntry: number; rhEntry: number; estimated: boolean;
}
export interface ClosedTrade extends Position {
  closedAt: number; varExit: number; rhExit: number; exitSpread: number; reason: CloseReason;
  grossUsd: number; costUsd: number; netUsd: number; netBps: number;
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
  return position.direction === 'var_rich'
    ? { exitSpread: spread.buyVar, pnlBps: position.entrySpread - spread.buyVar }
    : { exitSpread: spread.sellVar, pnlBps: spread.sellVar - position.entrySpread };
}

/**
 * 持仓按开仓档位取平仓价。100k 档缺价（缺盘口快照或 Var 没给 100k 报价）时退回 1k 档并标为估算，
 * 止损、超时与手动平仓照常进行，不会因为缺一份快照而一直卡住。
 */
export function positionSpread(sample: Sample, notionalUsd: number): Spread | null {
  const bucket = bucketOf(notionalUsd), spread = spreadOf(sample, bucket);
  if (spread || bucket === '1k') return spread;
  const fallback = spreadOf(sample, '1k');
  return fallback ? { ...fallback, estimated: true } : null;
}

/** 已有持仓：回归、止损、超时；没有持仓：按方向与偏离开仓。时段、报价时效与风控限制由调用方在开仓前另外判断。 */
export function decide(sample: Sample, baseline: Baseline | null, params: SymbolParams, position: Position | null): Decision {
  const spread = position ? positionSpread(sample, position.notionalUsd) : spreadOf(sample, bucketOf(params.notionalUsd));
  if (!spread) return { kind: 'wait', reason: '该档位缺少可成交价格（100k 档需要 Lighter 完整盘口）' };
  if (position) {
    const { pnlBps } = markToMarket(position, spread);
    if (pnlBps <= -params.stopBps) return { kind: 'close', reason: 'stop', spread, deviation: baseline ? deviationToClose(position.direction, spread, baseline.median) : 0 };
    if (sample.t - position.openedAt >= params.maxHoldMinutes * 60_000) return { kind: 'close', reason: 'timeout', spread, deviation: baseline ? deviationToClose(position.direction, spread, baseline.median) : 0 };
    if (!baseline) return { kind: 'hold', deviation: null };
    const deviation = deviationToClose(position.direction, spread, baseline.median);
    return deviation <= params.exitBps ? { kind: 'close', reason: 'revert', spread, deviation } : { kind: 'hold', deviation };
  }
  if (!baseline) return { kind: 'wait', reason: '基线样本不足' };
  const rich = spread.sellVar - baseline.median, cheap = baseline.median - spread.buyVar;
  if (params.directions.includes('var_rich') && rich >= params.entryBps) return { kind: 'open', direction: 'var_rich', spread, deviation: rich };
  if (params.directions.includes('var_cheap') && cheap >= params.entryBps) return { kind: 'open', direction: 'var_cheap', spread, deviation: cheap };
  return { kind: 'hold', deviation: Math.max(rich, cheap) };
}
/**
 * 中间价基差还偏离基线多少（基点，正数表示尚未回到基线）。开仓按可成交价差判断（已含半个往返成本），平仓按中间价
 * 判断：若也按可成交价差，中间价回到基线时可成交价差仍差半个往返成本，永远等不到平仓。
 */
export function deviationToClose(direction: Direction, spread: Spread, median: number): number {
  return direction === 'var_rich' ? spread.mid - median : median - spread.mid;
}

/** 按两腿同样的基础数量开仓：数量 = 名义金额 ÷ Lighter 中间价。 */
export function openPosition(id: string, sample: Sample, params: SymbolParams, decision: Extract<Decision, { kind: 'open' }>, baseline: Baseline): Position {
  const { spread, direction } = decision, prices = spread.prices;
  const qty = params.notionalUsd / prices.rhMid;
  return {
    id, symbol: sample.symbol, direction, openedAt: sample.t, qty, notionalUsd: params.notionalUsd,
    entrySpread: direction === 'var_rich' ? spread.sellVar : spread.buyVar, entryBaseline: baseline.median, entryRegime: sample.regime,
    varEntry: direction === 'var_rich' ? prices.varBid : prices.varAsk, rhEntry: direction === 'var_rich' ? prices.rhAsk : prices.rhBid, estimated: spread.estimated,
  };
}

/** 平仓结算：价差收益按两腿实际成交价算；滑点与手续费按四次成交（每腿开平各一次）的名义金额扣。 */
export function closePosition(position: Position, at: number, spread: Spread, reason: CloseReason, global: Pick<GlobalParams, 'slippageBps' | 'varFeeBps' | 'rhFeeBps'>, fundingUsd: number | null): ClosedTrade {
  const prices = spread.prices, rich = position.direction === 'var_rich';
  const varExit = rich ? prices.varAsk : prices.varBid, rhExit = rich ? prices.rhBid : prices.rhAsk;
  const varPnl = (rich ? position.varEntry - varExit : varExit - position.varEntry) * position.qty;
  const rhPnl = (rich ? rhExit - position.rhEntry : position.rhEntry - rhExit) * position.qty;
  const traded = position.qty * (position.varEntry + varExit), tradedRh = position.qty * (position.rhEntry + rhExit);
  const costUsd = (traded * (global.slippageBps + global.varFeeBps) + tradedRh * (global.slippageBps + global.rhFeeBps)) / 10_000;
  const grossUsd = varPnl + rhPnl, netUsd = grossUsd - costUsd;
  return { ...position, closedAt: at, varExit, rhExit, exitSpread: rich ? spread.buyVar : spread.sellVar, reason, grossUsd, costUsd, netUsd, netBps: netUsd / position.notionalUsd * 10_000, fundingUsd };
}

/**
 * 资金费估算（美元，正为收入）：Lighter 每小时费率（多头付费为正）与 Var 年化费率（推测口径）按持有时长线性累计。
 * var_rich 是 Var 空头、Lighter 多头。只作参考，不进净盈亏。
 */
export function fundingEstimate(position: Position, until: number, varAnnual: number | null, rhHourly: number | null): number | null {
  if (varAnnual === null || rhHourly === null) return null;
  const hours = Math.max(0, until - position.openedAt) / 3_600_000;
  const varSign = position.direction === 'var_rich' ? 1 : -1;
  const varUsd = varSign * varAnnual / (365 * 24) * hours * position.qty * position.varEntry;
  const rhUsd = -varSign * rhHourly * hours * position.qty * position.rhEntry;
  return varUsd + rhUsd;
}

/** 开仓前的风控与时效检查；返回不开仓的原因，可以开则为 null。回测与模拟盘共用。 */
/** varBusy：同一个 Var 代码已在另一个 Lighter 场所有持仓。Var 的持仓按代码合并，两笔反向会互相抵消，所以每个代码同时只开一笔。 */
export interface GateContext { openPositions: number; openNotionalUsd: number; dailyNetUsd: number; cooldownUntil: number; eligible: boolean; varBusy?: boolean }
export function openBlocker(sample: Sample, params: SymbolParams, global: GlobalParams, context: GateContext): string | null {
  if (global.paused) return '已暂停';
  if (!params.enabled) return '未启用';
  if (!context.eligible) return '规格未确认';
  if (!params.regimes.includes(sample.regime)) return '当前时段不开仓';
  if (sample.receivedAt - sample.t > global.maxQuoteAgeSec * 1000) return 'Var 报价过旧';
  if (sample.t < context.cooldownUntil) return '冷却中';
  if (context.varBusy) return '同一 Var 代码已在另一场所持仓';
  if (context.openPositions >= global.maxOpenPositions) return '持仓数已满';
  if (context.openNotionalUsd + params.notionalUsd > global.maxTotalNotionalUsd) return '名义合计将超上限';
  if (context.dailyNetUsd <= -global.dailyLossLimitUsd) return '当日亏损已达上限';
  return null;
}
