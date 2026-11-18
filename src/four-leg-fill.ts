// Whether the two venues of a four-leg group filled alike (docs/oil.md 11.3): one rule for the executor's Feishu alert and
// the page's group status. Pure, without node modules, so the page imports it too.
import { fromUnits, units } from './decimal.ts';

/**
 * One leg of one venue's job: what it filled against its own plan, in contract quantities, its quantity step, and what the
 * job actually skipped of it by design (a local chase's remainder too small to send, recorded per batch as leadSkipped; for
 * the hedge, the lead's skip scaled by the two legs' plans).
 */
export interface FillLeg { venue: string; symbol: string; filled: string; planned: string; step: string; skipped: string; shown: string }
/** A contract both venues trade whose fills differ, or cannot be compared (a plan that is not a finite positive number). */
export interface FillGap { symbol: string; a: FillLeg; b: FillLeg; comparable: boolean }

function quantity(value: string): bigint | null {
  try { return units(value); } catch { return null; }
}
/** An invalid or negative step or skip adds no tolerance. */
function allowance(value: string): bigint {
  const parsed = quantity(value);
  return parsed !== null && parsed > 0n ? parsed : 0n;
}
/** The lead's actual skipped share also applies to its hedge, whose equivalent in contracts can be a recurring decimal. */
function skippedShare(lead: FillLeg): { amount: bigint; plan: bigint } {
  const plan = allowance(lead.planned);
  return plan ? { amount: allowance(lead.skipped), plan } : { amount: 0n, plan: 1n };
}

/** Contract quantity shown on the hedge leg. A malformed historical plan is reported by fillGaps. */
export function hedgeSkippedQuantity(skipped: string, leadPlan: string, hedgePlan: string): string {
  if (skipped === '0') return '0';
  const plan = allowance(leadPlan);
  return plan ? fromUnits(allowance(skipped) * allowance(hedgePlan) / plan) : '0';
}

/**
 * The contracts whose fills differ between the two venues, each job's lead first. Each venue sizes its own plan (equal barrels for oil, equal
 * notional for hynix), so fills compare as the share of the plan filled. They differ when the shares are further apart than
 * one quantity step plus what both venues recorded as skipped, each as a share of its own plan: no estimate, no per-batch
 * allowance. A plan that is not a finite positive number cannot be compared and is reported too.
 */
export function fillGaps(a: readonly FillLeg[], b: readonly FillLeg[]): FillGap[] {
  const gaps: FillGap[] = [];
  if (!a.length || !b.length) return gaps;
  const skipA = skippedShare(a[0]), skipB = skippedShare(b[0]);
  const skipNumerator = skipA.amount * skipB.plan + skipB.amount * skipA.plan;
  const skipDenominator = skipA.plan * skipB.plan;
  for (const leg of a) {
    const other = b.find(item => item.symbol === leg.symbol);
    if (!other) continue;
    const planA = allowance(leg.planned), planB = allowance(other.planned);
    const filledA = quantity(leg.filled), filledB = quantity(other.filled);
    if (!planA || !planB || filledA === null || filledB === null) {
      gaps.push({ symbol: leg.symbol, a: leg, b: other, comparable: false });
      continue;
    }
    // Put fills and steps over planA × planB. Compare the excess over one step with the two exact skipped shares.
    const difference = filledA * planB - filledB * planA;
    const stepA = allowance(leg.step) * planB, stepB = allowance(other.step) * planA;
    const excess = (difference < 0n ? -difference : difference) - (stepA > stepB ? stepA : stepB);
    if (excess * skipDenominator > skipNumerator * planA * planB) gaps.push({ symbol: leg.symbol, a: leg, b: other, comparable: true });
  }
  return gaps;
}

/** One line per gap, e.g. "BZ 两所成交不等：Binance 10 / 10 桶，Bybit 4 / 10 桶". */
export const fillGapText = (gap: FillGap): string => `${gap.symbol.replace(/USDT$/, '')} ${gap.comparable ? '两所成交不等' : '计划或成交数量无效，无法比较两所成交'}：${gap.a.venue} ${gap.a.shown}，${gap.b.venue} ${gap.b.shown}`;
