// Whether the two venues of a four-leg group filled alike (docs/oil.md 11.3): one rule for the executor's Feishu alert and
// the page's group status. Pure, without node modules, so the page imports it too.

/**
 * One leg of one venue's job: what it filled against its own plan, in contract quantities, and its slack: how far it may fall
 * short of the plan by design (the executor's fillSlack: a quantity step, plus what a local chase leaves as a remainder too
 * small to send in each batch).
 */
export interface FillLeg { venue: string; symbol: string; filled: string; planned: string; slack: string; shown: string }

/** A slack that is not a number counts as none, so a broken value shows a gap rather than hiding one. */
const slackOf = (leg: FillLeg): number => { const value = Number(leg.slack); return Number.isFinite(value) && value > 0 ? value : 0; };

/** Whether a leg filled materially less than its plan: by more than its slack. The executor's linked halt uses it. */
export const shortOfPlan = (leg: FillLeg): boolean => Number(leg.planned) - Number(leg.filled) > slackOf(leg) + 1e-12;
/** A contract both venues trade whose fills differ, or cannot be compared (a plan that is not positive). */
export interface FillGap { symbol: string; a: FillLeg; b: FillLeg; comparable: boolean }

/**
 * The contracts whose fills differ between the two venues. Each venue sizes its own plan (equal barrels for oil, equal
 * notional for hynix), so fills compare as the share of the plan filled; a difference within either leg's slack (as a
 * share of its plan) is by design, not a gap.
 */
export function fillGaps(a: readonly FillLeg[], b: readonly FillLeg[]): FillGap[] {
  const gaps: FillGap[] = [];
  for (const leg of a) {
    const other = b.find(item => item.symbol === leg.symbol);
    if (!other) continue;
    const plans = [Number(leg.planned), Number(other.planned)];
    if (!plans.every(plan => Number.isFinite(plan) && plan > 0)) { gaps.push({ symbol: leg.symbol, a: leg, b: other, comparable: false }); continue; }
    const share = (item: FillLeg, plan: number): number => Number(item.filled) / plan;
    const tolerance = Math.max(slackOf(leg) / plans[0]!, slackOf(other) / plans[1]!) + 1e-12;
    if (Math.abs(share(leg, plans[0]!) - share(other, plans[1]!)) > tolerance) gaps.push({ symbol: leg.symbol, a: leg, b: other, comparable: true });
  }
  return gaps;
}

/** One line per gap, e.g. "BZ 两所成交不等：Binance 10 / 10 桶，Bybit 4 / 10 桶". */
export const fillGapText = (gap: FillGap): string => `${gap.symbol.replace(/USDT$/, '')} ${gap.comparable ? '两所成交不等' : '计划数量无效，无法比较两所成交'}：${gap.a.venue} ${gap.a.shown}，${gap.b.venue} ${gap.b.shown}`;
