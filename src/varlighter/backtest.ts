// 单标的回测（docs/varlighter.md 第 6 节）：用已采集的对齐样本按时间重放，与模拟盘同一套基线、开平仓与风控规则。
// 基线在每个样本判断之后才把该样本计入，不看未来；from 之前的样本只用来预热基线。
import { PAIR_KEY, bucketOf, spreadOf, type AssetKind, type Sample } from './model.ts';
import { BaselineTracker } from './stats.ts';
import { DEFAULT_SYMBOL, ParamsError, closePosition, closeSpread, confirmOpen, decide, fundingEstimate, openEconomics, openBlocker, openPosition, readGlobalParams, readSymbolParams, type ClosedTrade, type GlobalParams, type Position, type SymbolParams } from './strategy.ts';

export interface BacktestSummary {
  trades: number; wins: number; winRate: number | null;
  netUsd: number; grossUsd: number; costUsd: number; fundingUsd: number;
  avgNetBps: number | null; avgHoldMinutes: number | null; maxDrawdownUsd: number;
  /** 期末仍未平仓的持仓按最后一个样本的可成交价估值（美元，已扣平仓成本）。 */ openMarkUsd: number | null;
  /** 有基线可判断的样本数与按原因统计的不开仓次数（只计偏离已达入场阈值的样本）。 */ evaluated: number; blocked: Record<string, number>;
  reasons: Record<string, number>;
}
export interface BacktestResult {
  symbol: string; from: number; to: number; samples: number;
  trades: ClosedTrade[]; open: Position | null;
  /** 每笔平仓后的累计净盈亏。 */ equity: { t: number; net: number }[];
  summary: BacktestSummary;
}

export function runBacktest(symbol: string, kind: AssetKind, samples: readonly Sample[], from: number, to: number, params: SymbolParams, global: GlobalParams): BacktestResult {
  const tracker = new BaselineTracker(kind, global.windowHours * 3_600_000, global.minSamples);
  const effective: SymbolParams = { ...params, enabled: true }, settings: GlobalParams = { ...global, paused: false };
  const trades: ClosedTrade[] = [], equity: { t: number; net: number }[] = [];
  const blocked: Record<string, number> = {};
  let position: Position | null = null, cooldownUntil = 0, evaluated = 0, counted = 0, cumulative = 0, peak = 0, maxDrawdown = 0;
  let day = -1, dayNet = 0, sequence = 0;
  let last: Sample | null = null;
  const liveFrom = samples.find(sample => sample.rhBidRx !== null && sample.rhAskRx !== null)?.t ?? Infinity;
  for (const sample of samples) {
    if (sample.t > to) break;
    if (sample.t >= from) {
      counted++;
      const today = Math.floor(sample.t / 86_400_000);
      if (today !== day) { day = today; dayNet = 0; }
      const baseline = tracker.value(sample.regime, sample.t);
      if (baseline) evaluated++;
      const decision = decide(sample, baseline, effective, position);
      if (decision.kind === 'close' && position) {
        const trade = closePosition(position, sample.t, closeSpread(sample, position, decision.spread), decision.reason, settings, fundingEstimate(position, sample.t, sample.varFunding, sample.rhFunding));
        trades.push(trade);
        cumulative += trade.netUsd; dayNet += trade.netUsd;
        peak = Math.max(peak, cumulative); maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
        equity.push({ t: sample.t, net: cumulative });
        position = null;
        cooldownUntil = sample.t + params.cooldownMinutes * 60_000;
      } else if (decision.kind === 'open' && baseline) {
        // 与模拟盘同序：先按判断时刻的 Lighter 一档复核，再过风控。开始记录那一刻一档（liveFrom）之前的旧样本沿用样本本身；
        // 之后的样本没有它说明当时行情流不可用，与模拟盘一样不开仓。
        const confirmed = confirmOpen(sample, baseline, effective, decision, sample.t >= liveFrom);
        const reason = typeof confirmed === 'string' ? confirmed : openBlocker(sample, effective, settings, {
          openPositions: 0, openNotionalUsd: 0, dailyNetUsd: dayNet, cooldownUntil, eligible: true, fallbackBaseline: baseline.fallback, ...openEconomics(confirmed.decision, effective, settings, decision) });
        if (reason) blocked[reason] = (blocked[reason] ?? 0) + 1;
        else if (typeof confirmed !== 'string') position = openPosition(`bt-${++sequence}`, confirmed.sample, effective, confirmed.decision, baseline);
      }
      last = sample;
    }
    tracker.push(sample);
  }
  let openMarkUsd: number | null = null;
  if (position && last) {
    const quoted = spreadOf(last, bucketOf(position.notionalUsd)), spread = quoted && closeSpread(last, position, quoted);
    if (spread) openMarkUsd = closePosition(position, last.t, spread, 'manual', settings, null).netUsd;
  }
  const wins = trades.filter(trade => trade.netUsd > 0).length;
  const reasons: Record<string, number> = {};
  for (const trade of trades) reasons[trade.reason] = (reasons[trade.reason] ?? 0) + 1;
  const sum = (pick: (trade: ClosedTrade) => number) => trades.reduce((total, trade) => total + pick(trade), 0);
  return {
    symbol, from, to, samples: counted, trades, open: position, equity,
    summary: {
      trades: trades.length, wins, winRate: trades.length ? wins / trades.length : null,
      netUsd: sum(trade => trade.netUsd), grossUsd: sum(trade => trade.grossUsd), costUsd: sum(trade => trade.costUsd), fundingUsd: sum(trade => trade.fundingUsd ?? 0),
      avgNetBps: trades.length ? sum(trade => trade.netBps) / trades.length : null,
      avgHoldMinutes: trades.length ? sum(trade => trade.closedAt - trade.openedAt) / trades.length / 60_000 : null,
      maxDrawdownUsd: maxDrawdown, openMarkUsd, evaluated, blocked, reasons,
    },
  };
}

/** 页面的回测请求：{ symbol, hours, params?, global? }；参数缺的字段用当前保存的参数补。 */
export function backtestRequest(body: unknown, saved: Readonly<Record<string, SymbolParams>>, global: GlobalParams): { symbol: string; hours: number; params: SymbolParams; global: GlobalParams } {
  const fail = (message: string): never => { throw new ParamsError(message); };
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return fail('回测请求格式无效');
  const raw = body as Record<string, unknown>;
  const unknown = Object.keys(raw).find(key => !['symbol', 'hours', 'params', 'global'].includes(key));
  if (unknown) fail(`回测请求包含未知字段 ${unknown.slice(0, 40)}`);
  if (typeof raw.symbol !== 'string' || !PAIR_KEY.test(raw.symbol)) fail('配对键无效（应为「场所:代码」，如 rh:AAPL）');
  const hours = raw.hours;
  if (typeof hours !== 'number' || !Number.isInteger(hours) || hours < 1 || hours > 24 * 14) fail('回测时长须为 1 到 336 小时的整数');
  const symbol = raw.symbol as string;
  if (raw.params !== undefined && (raw.params === null || typeof raw.params !== 'object' || Array.isArray(raw.params))) fail('回测参数须为对象');
  const params = readSymbolParams({ ...(raw.params === undefined ? {} : raw.params as object), enabled: true }, saved[symbol] ?? DEFAULT_SYMBOL);
  return { symbol, hours: hours as number, params, global: raw.global === undefined ? global : readGlobalParams(raw.global, global) };
}
