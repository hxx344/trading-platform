// SK hynix sizing and premium (docs/hynix.md section 2). The ADR (SKHYUSDT) and the ordinary share (SKHYNIXUSDT) hedge
// equal USDT notional, not equal units: one ordinary share is ten ADRs. Exact decimals throughout, as in decimal.ts.
import { fromUnits, units } from '../decimal.ts';
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
