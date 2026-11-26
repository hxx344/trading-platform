// 资金费组合的路径规划（docs/fundingbook.md 第 5 节）：从当前仓位与资金分布走到目标的步骤。顺序是先减仓、
// 再划转、最后加仓：减仓放出保证金，划转把它送到要加仓的账户。第一期只生成步骤，不向任何交易所发单。
export interface PlanLeg { symbol: string; price: number; /** 把名义金额折成数量用的参考价（同一标的各账户相同，数量才配得平）；不给时用 price。 */ ref?: number }
export interface PlanStep {
  kind: 'order' | 'transfer';
  account: string;
  /** 划转的收款账户。 */
  to?: string;
  base?: string;
  symbol?: string;
  side?: 'buy' | 'sell';
  qty?: number;
  price?: number;
  /** 订单的成交金额或划转金额（美元）。 */
  notional: number;
  /** 订单属于减仓（含平仓）。 */
  reduce?: boolean;
  /** 订单把这条腿全部平掉：模拟盘按持仓数量整笔平，不留零头。 */
  close?: boolean;
}
export interface PlanInput {
  accounts: readonly string[];
  bases: readonly string[];
  /** legs[账户][标的]：这条腿的合约与价格；没有就不出这条腿的订单。 */
  legs: readonly (readonly (PlanLeg | null)[])[];
  current: readonly (readonly number[])[];
  target: readonly (readonly number[])[];
  equity: readonly number[];
  targetEquity: readonly number[];
  minOrder: number;
  minTransfer: number;
}

/** 数量保留 5 位有效数字（合约步长目录接入前的近似，见文档第 10 节）。 */
export const roundQty = (value: number): number => value > 0 ? Number(value.toPrecision(5)) : 0;

export function buildPlan(input: PlanInput): PlanStep[] {
  const { accounts, bases, legs, current, target, equity, targetEquity, minOrder, minTransfer } = input;
  const reductions: PlanStep[] = [], increases: PlanStep[] = [];
  for (let a = 0; a < accounts.length; a++) for (let b = 0; b < bases.length; b++) {
    const leg = legs[a][b], from = current[a][b], to = target[a][b], delta = to - from;
    if (!leg || !(leg.price > 0)) continue;
    const close = to === 0 && from !== 0;
    if (!close && Math.abs(delta) < minOrder) continue;
    const reduce = Math.abs(to) < Math.abs(from) && to * from >= 0;
    const step: PlanStep = { kind: 'order', account: accounts[a], base: bases[b], symbol: leg.symbol, side: delta > 0 ? 'buy' : 'sell', qty: roundQty(Math.abs(delta) / (leg.ref ?? leg.price)), price: leg.price, notional: Math.abs(delta) * leg.price / (leg.ref ?? leg.price), reduce, ...(close ? { close: true } : {}) };
    (reduce ? reductions : increases).push(step);
  }
  const byNotional = (left: PlanStep, right: PlanStep) => right.notional - left.notional;
  reductions.sort(byNotional); increases.sort(byNotional);

  // 划转：多出资金最多的账户补给缺口最大的账户，直到剩下的差额都小于最小划转额。
  const surplus = accounts.map((_, a) => equity[a] - targetEquity[a]), transfers: PlanStep[] = [];
  for (let guard = 0; guard < accounts.length * accounts.length; guard++) {
    let giver = 0, taker = 0;
    for (let a = 1; a < accounts.length; a++) { if (surplus[a] > surplus[giver]) giver = a; if (surplus[a] < surplus[taker]) taker = a; }
    const amount = Math.min(surplus[giver], -surplus[taker]);
    if (!(amount >= minTransfer)) break;
    transfers.push({ kind: 'transfer', account: accounts[giver], to: accounts[taker], notional: amount });
    surplus[giver] -= amount; surplus[taker] += amount;
  }
  return [...reductions, ...transfers, ...increases];
}
