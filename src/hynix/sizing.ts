// SK hynix sizing and premium (docs/hynix.md section 2). The ADR (SKHYUSDT) and the ordinary share (SKHYNIXUSDT) hedge
// equal USDT notional, not equal units: one ordinary share is ten ADRs. Exact decimals throughout, as in decimal.ts.
import { floorToStep, fromUnits, units } from '../decimal.ts';
import type { Instrument } from '../contracts.ts';

const SCALE = 10n ** 18n;
/** ADRs per ordinary share. */
export const HYNIX_RATIO = 10n;

/** Book midpoint, truncated at 18 digits. */
export const midOf = (bid: string, ask: string): string => fromUnits((units(bid) + units(ask)) / 2n);

/**
 * The native quantity worth this notional at this price: notional ÷ (price × contract size), floored to the quantity step.
 * Zero when not even one step fits; the caller refuses quantities below the contract minimum.
 */
export function quantityForNotional(notional: string, price: string, instrument: Pick<Instrument, 'contractSize' | 'quantityStep'>): string {
  const perUnit = units(price) * units(instrument.contractSize) / SCALE, step = units(instrument.quantityStep);
  if (perUnit <= 0n || step <= 0n) throw new RangeError('价格、合约乘数或数量步长无效');
  const raw = units(notional) * SCALE / perUnit;
  return fromUnits(raw - raw % step);
}

/**
 * Premium of the ADR over a tenth of the ordinary share, in percent: (adr × 10 ÷ ordinary − 1) × 100, truncated at 18
 * digits. Null without a positive ordinary price.
 */
export function premiumPercent(adr: string, ordinary: string): string | null {
  const base = units(ordinary);
  if (base <= 0n) return null;
  return fromUnits(units(adr) * HYNIX_RATIO * 100n * SCALE / base - 100n * SCALE);
}

/**
 * The exact sign of premiumPercent(adr, ordinary) − threshold (percent), without its truncation, as the workbench's
 * compareSpread: adr × 10 × 100 against (threshold + 100) × ordinary. The ordinary price must be positive.
 */
export function comparePremium(adr: string, ordinary: string, threshold: string): -1 | 0 | 1 {
  const left = units(adr) * HYNIX_RATIO * 100n * SCALE, right = (units(threshold) + 100n * SCALE) * units(ordinary);
  return left > right ? 1 : left < right ? -1 : 0;
}

/**
 * The hedge for a lead fill in the planned proportion: hedge plan × lead filled ÷ lead plan, floored to the hedge step. The
 * executor hedges and settles hynix jobs by this, and the batch plan sizes each batch's hedge by it (docs/hynix.md 2, 7.2).
 */
export function proportionalHedge(hedgePlanned: string, leadPlanned: string, leadFilled: string, hedgeStep: string): string {
  return floorToStep(fromUnits(units(hedgePlanned) * units(leadFilled) / units(leadPlanned)), hedgeStep);
}

/**
 * A quantity split into count parts on its step, as the workbench's splitQuantity: whole steps spread evenly, the steps
 * left over one each to the first parts. Null when the quantity is not a whole number of steps or has fewer steps than parts.
 */
export function splitSteps(quantity: string, count: number, step: string): string[] | null {
  const unit = units(step), total = units(quantity), parts = BigInt(count);
  if (unit <= 0n || parts <= 0n || total % unit !== 0n) return null;
  const lots = total / unit;
  if (lots < parts) return null;
  const base = lots / parts, extra = lots % parts;
  return Array.from({ length: count }, (_, index) => fromUnits((base + (BigInt(index) < extra ? 1n : 0n)) * unit));
}
