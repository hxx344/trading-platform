// Barrels to native quantity. Oil legs are asked for in barrels; each venue lists its own contract size and quantity step,
// so one barrel count maps to a whole number of steps on some venues and not on others. A count that does not fit is refused
// with the two nearest counts every leg can take, never rounded silently.
import { fromUnits, mul, units } from './decimal.ts';
import type { Instrument } from './contracts.ts';

const gcd = (a: bigint, b: bigint): bigint => { while (b !== 0n) [a, b] = [b, a % b]; return a; };
/** Barrels (in 18-digit units) of one quantity step of this contract. */
const barrelStep = (instrument: Instrument): bigint => units(mul(instrument.quantityStep, instrument.contractSize));

/** The native quantity for these barrels, or null when it is not a whole number of the contract's steps. */
export function quantityForBarrels(barrels: string, instrument: Instrument): string | null {
  const step = barrelStep(instrument), scaled = units(barrels);
  if (step <= 0n || scaled % step !== 0n) return null;
  return fromUnits(scaled / step * units(instrument.quantityStep));
}

/**
 * Barrel counts every leg can take are the multiples of the least common multiple of the legs' barrel steps, from the
 * smallest such multiple that meets every leg's minimum quantity. Returns the one at or below the request (if it meets the
 * minimums) and the next one above; below the minimum, the two smallest usable counts.
 */
export function nearestBarrels(barrels: string, instruments: readonly Instrument[]): [string, string] {
  const steps = instruments.map(barrelStep);
  if (steps.some(step => step <= 0n)) throw new RangeError('合约步长或乘数无效');
  const grid = steps.reduce((a, b) => a / gcd(a, b) * b);
  const floor = instruments.map(item => units(mul(item.minQuantity, item.contractSize))).reduce((a, b) => a > b ? a : b);
  const least = floor <= grid ? grid : (floor + grid - 1n) / grid * grid;
  const below = units(barrels) / grid * grid;
  const low = below >= least ? below : least;
  return [fromUnits(low), fromUnits(low + grid)];
}
