// Whether the two venues of a four-leg group filled alike (docs/oil.md 11.3): one rule for the executor's Feishu alert and
// the page's group status. Pure, without node modules, so the page imports it too.

/**
 * One leg of one venue's job: what it filled against its own plan, in contract quantities, its quantity step, and what the
 * job actually skipped of it by design (a local chase's remainder too small to send, recorded per batch as leadSkipped; for
 * the hedge, the lead's skip scaled by the two legs' plans).
 */
export interface FillLeg { venue: string; symbol: string; filled: string; planned: string; step: string; skipped: string; shown: string }
/** A contract both venues trade whose fills differ, or cannot be compared (a plan that is not a finite positive number). */
export interface FillGap { symbol: string; a: FillLeg; b: FillLeg; comparable: boolean }

/** A step or skip that is not a number counts as none, so a broken value shows a gap rather than hiding one. */
const amount = (value: string): number => { const number = Number(value); return Number.isFinite(number) && number > 0 ? number : 0; };

/**
 * The contracts whose fills differ between the two venues. Each venue sizes its own plan (equal barrels for oil, equal
 * notional for hynix), so fills compare as the share of the plan filled. They differ when the shares are further apart than
 * one quantity step plus what both venues recorded as skipped, each as a share of its own plan: no estimate, no per-batch
 * allowance. A plan that is not a finite positive number cannot be compared and is reported too.
 */
export function fillGaps(a: readonly FillLeg[], b: readonly FillLeg[]): FillGap[] {
  const gaps: FillGap[] = [];
  for (const leg of a) {
    const other = b.find(item => item.symbol === leg.symbol);
    if (!other) continue;
    const [planA, planB] = [Number(leg.planned), Number(other.planned)];
    const [shareA, shareB] = [Number(leg.filled) / planA, Number(other.filled) / planB];
    if (!(Number.isFinite(planA) && planA > 0 && Number.isFinite(planB) && planB > 0 && Number.isFinite(shareA) && Number.isFinite(shareB))) { gaps.push({ symbol: leg.symbol, a: leg, b: other, comparable: false }); continue; }
    const tolerance = Math.max(amount(leg.step) / planA, amount(other.step) / planB) + amount(leg.skipped) / planA + amount(other.skipped) / planB + 1e-12;
    if (Math.abs(shareA - shareB) > tolerance) gaps.push({ symbol: leg.symbol, a: leg, b: other, comparable: true });
  }
  return gaps;
}

/** One line per gap, e.g. "BZ 两所成交不等：Binance 10 / 10 桶，Bybit 4 / 10 桶". */
export const fillGapText = (gap: FillGap): string => `${gap.symbol.replace(/USDT$/, '')} ${gap.comparable ? '两所成交不等' : '计划数量无效，无法比较两所成交'}：${gap.a.venue} ${gap.a.shown}，${gap.b.venue} ${gap.b.shown}`;
