// Copied from project_aggregation modules/asset/lib/positions-cycle.ts at 0014655, trimmed to the decimal arithmetic
// (cash-flows.ts uses compare, multiply and negate). Left out: the fill replay (locateCycle, newestFirst, summarizeCycle,
// cycleUnavailable) with its types and constants, which belongs to live position reading. The functions kept are unchanged.
import { decimal, POSITIONS_INVALID } from './positions-decimal.ts';

type Scaled = { digits: bigint; scale: number };
const parse = (value: string): Scaled => {
  const text = decimal(value), negative = text.startsWith('-'), [whole, fraction = ''] = text.replace('-', '').split('.');
  const digits = BigInt(whole + fraction);
  return { digits: negative ? -digits : digits, scale: fraction.length };
};
const lift = (value: Scaled, scale: number) => value.digits * BigInt(10) ** BigInt(scale - value.scale);
function render({ digits, scale }: Scaled): string {
  const negative = digits < BigInt(0), absolute = (negative ? -digits : digits).toString().padStart(scale + 1, '0');
  let result = scale ? absolute.slice(0, -scale) + '.' + absolute.slice(-scale) : absolute;
  if (scale) result = result.replace(/0+$/, '').replace(/\.$/, '');
  return result === '0' ? '0' : (negative ? '-' : '') + result;
}
function combine(left: string, right: string, operation: (a: bigint, b: bigint) => bigint) {
  const a = parse(left), b = parse(right), scale = Math.max(a.scale, b.scale);
  return render({ digits: operation(lift(a, scale), lift(b, scale)), scale });
}
export const add = (left: string, right: string) => combine(left, right, (a, b) => a + b);
export const subtract = (left: string, right: string) => combine(left, right, (a, b) => a - b);
export const negate = (value: string) => subtract('0', value);
export function compare(left: string, right: string) { const a = parse(left), b = parse(right), scale = Math.max(a.scale, b.scale), x = lift(a, scale), y = lift(b, scale); return x === y ? 0 : x < y ? -1 : 1; }
export const sign = (value: string) => compare(value, '0');
export const magnitude = (value: string) => sign(value) < 0 ? negate(value) : render(parse(value));
export function multiply(left: string, right: string) { const a = parse(left), b = parse(right); return render({ digits: a.digits * b.digits, scale: a.scale + b.scale }); }
/** Truncates toward zero at `scale` places; only used for ratios and averages. */
export function divide(left: string, right: string, scale = 12) {
  const a = parse(left), b = parse(right);
  if (b.digits === BigInt(0)) throw new Error(POSITIONS_INVALID);
  return render({ digits: a.digits * BigInt(10) ** BigInt(scale + b.scale) / (b.digits * BigInt(10) ** BigInt(a.scale)), scale });
}
