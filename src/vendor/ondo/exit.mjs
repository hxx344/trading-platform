// A time or loss trigger latches for the entire incident. Exact integer arithmetic keeps the
// executable limit inside the slippage budget, including when a price falls between ticks.
import { decimalUnits as units } from './decimal.mjs';

const BPS = units('10000');
export const EXIT_ATTEMPTS = 3, EXIT_CONFIRM_MS = 15_000;

export function exitTrigger(position, entry, touch, maxLossBps, elapsed, maxHoldSec) {
  if (elapsed >= maxHoldSec * 1000) return '达到最长持仓时间';
  if (entry === null || touch === undefined) return null;
  const adverse = position > 0n ? entry - touch : touch - entry;
  return adverse > 0n && adverse * BPS >= entry * units(maxLossBps) ? '达到最大可成交亏损' : null;
}

export function iocLimit(side, touch, anchor, slipBps, tick, ownLimit) {
  if (touch === undefined || anchor === null) return null;
  const sell = side === 'sell', step = BPS * tick, slip = units(slipBps);
  // A retry can improve the price but cannot expand the first exit's price range.
  const reference = sell ? (touch > anchor ? touch : anchor) : (touch < anchor ? touch : anchor);
  const numerator = reference * (sell ? BPS - slip : BPS + slip);
  let price = (sell ? (numerator + step - 1n) / step : numerator / step) * tick;
  if (ownLimit !== undefined && (sell ? price <= ownLimit : price >= ownLimit)) price = sell ? ownLimit + tick : ownLimit - tick;
  return price > 0n && (sell ? price <= touch : price >= touch) ? price : null;
}
