// Whether the two venues of a four-leg group filled alike (docs/oil.md 11.3): one rule for the executor's Feishu alert and
// the page's group status. Pure, without node modules, so the page imports it too.

/** One leg of one venue's job: what it filled against its own plan, in contract quantities, and its quantity step. */
export interface FillLeg { venue: string; symbol: string; filled: string; planned: string; step: string; shown: string }
/** A contract both venues trade whose fills differ, or cannot be compared (a plan that is not positive). */
export interface FillGap { symbol: string; a: FillLeg; b: FillLeg; comparable: boolean }

/**
 * The contracts whose fills differ between the two venues. Each venue sizes its own plan (equal barrels for oil, equal
 * notional for hynix), so fills compare as the share of the plan filled; a difference within one quantity step of either
 * plan is rounding, not a gap.
 */
export function fillGaps(a: readonly FillLeg[], b: readonly FillLeg[]): FillGap[] {
  const gaps: FillGap[] = [];
  for (const leg of a) {
    const other = b.find(item => item.symbol === leg.symbol);
    if (!other) continue;
    const plans = [Number(leg.planned), Number(other.planned)];
    if (!plans.every(plan => Number.isFinite(plan) && plan > 0)) { gaps.push({ symbol: leg.symbol, a: leg, b: other, comparable: false }); continue; }
    const share = (item: FillLeg, plan: number): number => Number(item.filled) / plan;
    const tolerance = Math.max(Number(leg.step) / plans[0]!, Number(other.step) / plans[1]!) + 1e-12;
    if (Math.abs(share(leg, plans[0]!) - share(other, plans[1]!)) > tolerance) gaps.push({ symbol: leg.symbol, a: leg, b: other, comparable: true });
  }
  return gaps;
}

/** One line per gap, e.g. "BZ 两所成交不等：Binance 10 / 10 桶，Bybit 4 / 10 桶". */
export const fillGapText = (gap: FillGap): string => `${gap.symbol.replace(/USDT$/, '')} ${gap.comparable ? '两所成交不等' : '计划数量无效，无法比较两所成交'}：${gap.a.venue} ${gap.a.shown}，${gap.b.venue} ${gap.b.shown}`;
