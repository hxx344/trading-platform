// 复制自 project-aggregation 工作台 modules/crossex/server/money.mjs（提交 7745181），改动：仅把 npm 包 decimal.js 的 import 改为本仓复制的 ../decimal.mjs（同版本 10.6.0）。
import DecimalJs from '../decimal.mjs';

// Keep all intermediate money/quantity arithmetic decimal; convert only at UI boundaries.
export const Decimal = DecimalJs.clone({ precision: 80, rounding: DecimalJs.ROUND_HALF_UP, toExpNeg: -100, toExpPos: 100 });
export function D(value) {
  const decimal = new Decimal(value);
  if (!decimal.isFinite()) throw new RangeError('金额或数量必须是有限数值');
  return decimal;
}
