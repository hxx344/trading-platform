// The gold-oil ratio (docs/goldoil.md 2): gold's price over oil's, both quoted in USDT per unit, so the ratio has no unit.
// Exact decimals, truncated at 18 digits as in decimal.ts.
import { fromUnits, units } from '../decimal.ts';

const SCALE = 10n ** 18n;

/** gold ÷ oil; null without a positive oil price. */
export function goldOilRatio(gold: string, oil: string): string | null {
  const base = units(oil);
  if (base <= 0n) return null;
  return fromUnits(units(gold) * SCALE / base);
}
