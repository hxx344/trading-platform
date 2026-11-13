// Strategy selection and the risk arithmetic, ported from the workbench's strategy.py and risk.py (commit 160e932).
// USD estimates are binary floats as there (they are limits and displays, never order fields); quantities stay decimal
// strings until the arithmetic needs a number.
import { isSunday, type OptionRow, type OptionType } from './market.ts';

export type StrategyMode = 'iron_condor' | 'short_strangle';
export type Side = 'Buy' | 'Sell';
export const STRATEGY_MODES: readonly StrategyMode[] = ['iron_condor', 'short_strangle'];
export const legCount = (mode: StrategyMode): number => mode === 'short_strangle' ? 2 : 4;

export class StrategyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export interface Estimates {
  feeRate: number; feeCapPct: number; marginBufferPct: number; marginMode: 'REGULAR_MARGIN' | 'PORTFOLIO_MARGIN';
  mmFactor: number; maxImFactor: number; minImFactor: number; liquidationFeeRate: number;
}
export const DEFAULT_ESTIMATES: Estimates = { feeRate: 0.0003, feeCapPct: 0.07, marginBufferPct: 0.10, marginMode: 'REGULAR_MARGIN', mmFactor: 0.03, maxImFactor: 0.10, minImFactor: 0.05, liquidationFeeRate: 0.002 };

export interface PreviewLeg {
  symbol: string; side: Side; optionType: OptionType; strike: number; delta: number; qty: string; mark: number; targetDelta: number;
  estimatedFeeUsd: number; feeCapUsd: number; feeBasisPrice: number;
}
export interface Preview {
  mode: StrategyMode; unboundedLoss: boolean; expiry: number; legs: PreviewLeg[];
  netCreditUsd: number; maxLossUsd: number | null; maxProfitUsd: number; riskReward: number | null;
  estimatedMarginUsd: number; estimatedTradingCostUsd: number; estimatedInitialMarginUsd: number; estimatedMaintenanceMarginUsd: number;
  marginBasis: 'regular_order_im' | 'portfolio_loss_estimate'; marginMode: Estimates['marginMode']; marginBufferPct: number; feeRate: number; feeCapPct: number;
  index: number | null; marketAt: number;
}

const round = (value: number, digits: number): number => { const scale = 10 ** digits; return Math.round(value * scale) / scale; };
const nearest = (rows: OptionRow[], target: number): OptionRow => rows.reduce((best, row) => Math.abs(Math.abs(row.delta) - target) < Math.abs(Math.abs(best.delta) - target) ? row : best);

/** The earliest future Sunday expiry in the chain. */
export function chooseExpiry(rows: readonly OptionRow[], now: number): number {
  const expiries = [...new Set(rows.filter(row => row.expiry > now && isSunday(row.expiry)).map(row => row.expiry))].sort((a, b) => a - b);
  if (!expiries.length) throw new StrategyError('no_sunday_expiry', '期权链里没有未来的周日到期');
  return expiries[0]!;
}

/** A leg as risk sees it: role, strike, quantity, the price it is bounded by, and for short strangles the margin bounds. */
export interface RiskLeg {
  side: Side; optionType: OptionType; strike: number; qty: number; expiry: number; mark: number;
  priceBound: number; priceFloor?: number; priceCeiling?: number; marginBound?: number;
}

/** The complete original structure, never a set of residual fills. */
export function validateStructure(legs: Record<string, Pick<RiskLeg, 'side' | 'optionType' | 'strike' | 'qty' | 'expiry'>>, mode: StrategyMode): void {
  const values = Object.values(legs);
  const roles = new Map(values.map(leg => [`${leg.optionType}|${leg.side}`, leg]));
  const expected = mode === 'iron_condor' ? ['Call|Sell', 'Put|Sell', 'Call|Buy', 'Put|Buy'] : ['Call|Sell', 'Put|Sell'];
  if (values.length !== legCount(mode) || roles.size !== expected.length || expected.some(role => !roles.has(role))) throw new StrategyError('structure', mode === 'iron_condor' ? '风险检查要求四条平衡的腿' : '风险检查要求恰好两条卖出 Call / Put 腿');
  if (values.some(leg => !Number.isFinite(leg.qty) || leg.qty <= 0 || !Number.isFinite(leg.strike) || leg.strike <= 0)) throw new StrategyError('structure', '数量或行权价无效');
  if (new Set(values.map(leg => leg.qty)).size !== 1) throw new StrategyError('structure', '各腿数量须相同');
  const strike = (role: string): number => roles.get(role)!.strike;
  if (mode === 'iron_condor' && !(strike('Put|Buy') < strike('Put|Sell') && strike('Put|Sell') < strike('Call|Sell') && strike('Call|Sell') < strike('Call|Buy'))) throw new StrategyError('structure', '铁鹰行权价顺序不对');
  if (strike('Put|Sell') >= strike('Call|Sell')) throw new StrategyError('structure', '卖出 Put 行权价须低于卖出 Call');
  const expiries = new Set(values.map(leg => leg.expiry));
  if (expiries.size !== 1 || values.some(leg => !isSunday(leg.expiry))) throw new StrategyError('structure', '各腿须同一个周日到期');
}

/** Expiry loss of a balanced condor at its bounded execution prices. */
export function maximumLoss(legs: Record<string, RiskLeg>): number {
  validateStructure(legs, 'iron_condor');
  const values = Object.values(legs);
  if (values.some(leg => !Number.isFinite(leg.priceBound) || leg.priceBound <= 0)) throw new StrategyError('price', '执行价无效');
  const role = (key: string) => values.find(leg => `${leg.optionType}|${leg.side}` === key)!;
  const qty = values[0]!.qty;
  const width = Math.max(role('Call|Buy').strike - role('Call|Sell').strike, role('Put|Sell').strike - role('Put|Buy').strike);
  const credit = values.reduce((sum, leg) => sum + (leg.side === 'Sell' ? 1 : -1) * leg.qty * leg.priceBound, 0);
  const loss = Math.max(0, width * qty - credit);
  if (!Number.isFinite(loss)) throw new StrategyError('price', '组合风险无法计算');
  return loss;
}

export interface MarginContext extends Estimates { index: number }

/** Regular option order IM of one short leg at one sell price, fees included (Bybit's published formula). */
export function shortOrderMargin(leg: Pick<RiskLeg, 'optionType' | 'strike' | 'qty' | 'mark'>, context: MarginContext, price: number): number {
  if (!(context.index > 0) || !Number.isFinite(context.index)) throw new StrategyError('margin', '卖出宽跨保证金预算需要有效的 BTC 指数');
  if (!(price > 0) || !Number.isFinite(price) || !(leg.mark > 0) || !Number.isFinite(leg.mark)) throw new StrategyError('margin', '卖出宽跨保证金预算需要有效的标记价与执行价');
  const { index } = context, mark = leg.mark, qty = leg.qty;
  const otm = leg.optionType === 'Call' ? Math.max(0, leg.strike - index) : Math.max(0, index - leg.strike);
  const positionMm = (Math.max(context.mmFactor * index, context.mmFactor * mark) + mark + context.liquidationFeeRate * index) * qty;
  const orderImPrime = (Math.max(context.maxImFactor * index - otm, context.minImFactor * index) + Math.max(price, mark)) * qty;
  const fee = Math.min(context.feeRate * index, context.feeCapPct * price) * qty;
  const value = Math.max(orderImPrime, positionMm) + fee - price * qty;
  if (!Number.isFinite(value) || value < 0) throw new StrategyError('margin', '卖出宽跨保证金无法计算');
  return value;
}

/** Each leg reserves its worst IM over every price it was ever sent at; favourable prices never free it. */
export function reserveShortMargin(legs: Record<string, RiskLeg>, context: MarginContext): { legs: Record<string, RiskLeg>; total: number } {
  validateStructure(legs, 'short_strangle');
  const proposed: Record<string, RiskLeg> = {};
  for (const [symbol, leg] of Object.entries(legs)) {
    const price = leg.priceBound, floor = leg.priceFloor ?? price, ceiling = leg.priceCeiling ?? price, old = leg.marginBound ?? 0;
    if ([price, floor, ceiling].some(value => !Number.isFinite(value) || value <= 0) || !(floor <= price && price <= ceiling)) throw new StrategyError('margin', '卖出宽跨执行价界限无效');
    if (!Number.isFinite(old) || old < 0) throw new StrategyError('margin', '已预留保证金无效');
    // IM falls then rises in a short order's price: both ends cover its worst value over every price used so far.
    proposed[symbol] = { ...leg, priceFloor: floor, priceCeiling: ceiling, marginBound: Math.max(old, shortOrderMargin(leg, context, floor), shortOrderMargin(leg, context, ceiling)) };
  }
  const total = Object.values(proposed).reduce((sum, leg) => sum + leg.marginBound!, 0) * (1 + context.marginBufferPct);
  if (!Number.isFinite(total)) throw new StrategyError('margin', '卖出宽跨保证金预算无法计算');
  return { legs: proposed, total };
}

/** build_strategy: the legs for a mode on the nearest Sunday expiry, with premium, risk, fee and margin estimates. */
export function buildStrategy(chain: readonly OptionRow[], { now, qty, mode, index, estimates, marketAt }: { now: number; qty: string; mode: StrategyMode; index: number | null; estimates: Estimates; marketAt: number }): Preview {
  const quantity = Number(qty);
  if (!Number.isFinite(quantity) || quantity <= 0) throw new StrategyError('quantity', '数量须为正数');
  const unbounded = mode === 'short_strangle';
  const usable = chain.filter(row => Number.isFinite(row.delta) && Math.abs(row.delta) > 0 && Math.abs(row.delta) <= 1 && row.mark > 0 && row.strike > 0);
  if (!usable.length) throw new StrategyError('no_chain', '期权链没有可用的价格与 delta');
  const expiry = chooseExpiry(usable, now);
  const rows = usable.filter(row => row.expiry === expiry);
  const calls = rows.filter(row => row.optionType === 'Call').sort((a, b) => a.strike - b.strike);
  const puts = rows.filter(row => row.optionType === 'Put').sort((a, b) => a.strike - b.strike);
  if (!calls.length || !puts.length) throw new StrategyError('missing_option_side', '所选到期日缺少可用的 Call 或 Put');
  const shortCall = nearest(calls, 0.45), shortPut = nearest(puts, 0.45);
  if (shortPut.strike >= shortCall.strike) throw new StrategyError('short_strike_order', '卖出 Put 行权价须低于卖出 Call');
  const leg = (row: OptionRow, side: Side, target: number): PreviewLeg => ({ symbol: row.symbol, side, optionType: row.optionType, strike: row.strike, delta: row.delta, qty, mark: row.mark, targetDelta: target, estimatedFeeUsd: 0, feeCapUsd: 0, feeBasisPrice: 0 });
  const legs = [leg(shortCall, 'Sell', 0.45), leg(shortPut, 'Sell', 0.45)];
  let maxLoss: number | null = null;
  const credit = (): number => legs.reduce((sum, item) => sum + (item.side === 'Sell' ? 1 : -1) * item.mark * quantity, 0);
  if (!unbounded) {
    const longCalls = calls.filter(row => row.strike > shortCall.strike), longPuts = puts.filter(row => row.strike < shortPut.strike);
    if (!longCalls.length || !longPuts.length) throw new StrategyError('missing_protective_wings', '卖腿外侧找不到保护腿');
    const longCall = nearest(longCalls, 0.10), longPut = nearest(longPuts, 0.10);
    legs.push(leg(longCall, 'Buy', 0.10), leg(longPut, 'Buy', 0.10));
    const width = Math.max(longCall.strike - shortCall.strike, shortPut.strike - longPut.strike);
    maxLoss = Math.max(0, width * quantity - credit());
  }
  const net = credit();
  validateStructure(Object.fromEntries(legs.map(item => [item.symbol, { ...item, qty: quantity, expiry }])), mode);
  if (unbounded && !(index !== null && index > 0)) throw new StrategyError('no_index', '卖出宽跨保证金估算需要有效的 BTC 指数');
  const basis = index && index > 0 ? index : Math.max(...rows.map(row => row.strike));
  // Passive estimate: buys at bid 1, sells at ask 1.
  const bySymbol = new Map(rows.map(row => [row.symbol, row]));
  let fees = 0, orderIm = 0, maintenance = 0;
  for (const item of legs) {
    const row = bySymbol.get(item.symbol)!;
    const price = (item.side === 'Buy' ? row.bid : row.ask) || item.mark;
    if (!Number.isFinite(price) || price <= 0) throw new StrategyError('price', '期权链执行价无效');
    const fee = Math.min(estimates.feeRate * basis, estimates.feeCapPct * price) * quantity;
    item.estimatedFeeUsd = round(fee, 8); item.feeCapUsd = round(estimates.feeCapPct * price * quantity, 8); item.feeBasisPrice = round(price, 8);
    fees += fee;
    if (item.side === 'Buy') { orderIm += price * quantity + fee; continue; }
    const otm = item.optionType === 'Call' ? Math.max(0, row.strike - basis) : Math.max(0, basis - row.strike);
    const positionMm = (Math.max(estimates.mmFactor * basis, estimates.mmFactor * row.mark) + row.mark + estimates.liquidationFeeRate * basis) * quantity;
    const orderImPrime = (Math.max(estimates.maxImFactor * basis - otm, estimates.minImFactor * basis) + Math.max(price, row.mark)) * quantity;
    orderIm += Math.max(orderImPrime, positionMm) + fee - price * quantity;
    maintenance += positionMm;
  }
  let margin: number, marginBasis: Preview['marginBasis'];
  if (unbounded) { margin = orderIm * (1 + estimates.marginBufferPct); marginBasis = 'regular_order_im'; }
  else if (estimates.marginMode === 'PORTFOLIO_MARGIN') { margin = maxLoss! * (1 + estimates.marginBufferPct); marginBasis = 'portfolio_loss_estimate'; }
  else { margin = orderIm; marginBasis = 'regular_order_im'; }
  if ([margin, fees, orderIm, maintenance].some(value => !Number.isFinite(value) || value < 0)) throw new StrategyError('margin', '期权链保证金估算无效');
  return {
    mode, unboundedLoss: unbounded, expiry, legs, netCreditUsd: round(net, 2), maxLossUsd: maxLoss === null ? null : round(maxLoss, 2), maxProfitUsd: round(Math.max(0, net), 2),
    riskReward: unbounded ? null : maxLoss ? round(net / maxLoss, 3) : 0,
    estimatedMarginUsd: round(margin, 2), estimatedTradingCostUsd: round(fees, 2), estimatedInitialMarginUsd: round(orderIm, 2), estimatedMaintenanceMarginUsd: round(maintenance, 2),
    marginBasis, marginMode: estimates.marginMode, marginBufferPct: estimates.marginBufferPct, feeRate: estimates.feeRate, feeCapPct: estimates.feeCapPct, index, marketAt,
  };
}
