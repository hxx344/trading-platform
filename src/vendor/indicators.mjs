// 复制自 project-aggregation 工作台 modules/monitor：lib/indicators.ts（提交 8bc3bee）的 calculateIndicators。
// 与原文件不同的地方：
// - 去掉 TypeScript 类型（类型在 indicators.d.mts），INDICATOR_PERIODS 默认值与计算规则不变；
// - 不再引用 lib/market 的 Point：任何带 time 与 premium / spread 的行都可以计算，结果保留行上原有字段。
export const INDICATOR_PERIODS = { sma: 7 * 24, bands: 20 * 24 };
/**
 * Includes the current closed bar; requires complete, consecutive windows.
 * `periods` count bars of `intervalMs` (hourly by default).
 */
export function calculateIndicators(points, metric, periods = INDICATOR_PERIODS, intervalMs = 3_600_000) {
  if (![periods.sma, periods.bands].every(p => Number.isInteger(p) && p >= 2)) {
    throw new Error("Indicator periods must be integers of at least two hours");
  }
  // Consecutive values of the current run; `start` trims it to the longest window
  // without per-hour slices or shifts. Sums keep the original element order.
  const window = [];
  let start = 0;
  let previous;
  const maxPeriod = Math.max(periods.sma, periods.bands);
  // Two-pass variance avoids cancellation from E[x²] − E[x]².
  const mean = from => {
    const first = window[from];
    let sum = 0;
    for (let i = from; i < window.length; i++) sum += window[i] - first;
    return first + sum / (window.length - from);
  };

  return points.map(point => {
    const result = {
      ...point, sma: null, basis: null, upper: null, lower: null,
      band: null, zscore: null, deviation: null, consecutiveHours: 0,
    };
    if (!Number.isFinite(point.time) || !Number.isFinite(point[metric])) {
      window.length = 0; start = 0; previous = undefined;
      return result;
    }
    if (previous !== undefined && point.time - previous !== intervalMs) { window.length = 0; start = 0; }
    previous = point.time;
    window.push(point[metric]);
    if (window.length - start > maxPeriod) start++;
    const count = window.length - start;
    result.consecutiveHours = count;

    if (count >= periods.sma) result.sma = mean(window.length - periods.sma);
    if (count >= periods.bands) {
      const from = window.length - periods.bands;
      const basis = mean(from);
      let squares = 0;
      for (let i = from; i < window.length; i++) squares += (window[i] - basis) ** 2;
      const deviation = Math.sqrt(squares / periods.bands);
      result.basis = basis;
      result.deviation = deviation;
      result.lower = basis - 2 * deviation;
      result.upper = basis + 2 * deviation;
      result.band = [result.lower, result.upper];
      result.zscore = deviation > 0 ? (point[metric] - basis) / deviation : null;
    }
    return result;
  });
}
