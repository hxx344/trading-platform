// 价差基线（docs/varlighter.md 第 4 节）：按时段分组的滚动中位数与稳健离散度，以及页面的基线统计。
// 模拟盘与回测共用 BaselineTracker，任何时刻的基线只用该时刻之前的样本（不看未来）。
import { midBasis, regimesOf, spreadOf, type AssetKind, type Regime, type Sample, type SizeBucket } from './model.ts';

/** 中位数绝对偏差换算成正态标准差的系数。 */
const MAD_SCALE = 1.4826;
/** 离散度每进这么多个样本重算一次（中位数每次都是精确的）。 */
const DISPERSION_EVERY = 10;

function insertSorted(sorted: number[], value: number): void {
  let low = 0, high = sorted.length;
  while (low < high) { const middle = (low + high) >>> 1; if (sorted[middle] < value) low = middle + 1; else high = middle; }
  sorted.splice(low, 0, value);
}
function removeSorted(sorted: number[], value: number): void {
  let low = 0, high = sorted.length;
  while (low < high) { const middle = (low + high) >>> 1; if (sorted[middle] < value) low = middle + 1; else high = middle; }
  if (low < sorted.length && sorted[low] === value) sorted.splice(low, 1);
}
export function quantileOf(sorted: readonly number[], q: number): number | null {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * q, lower = Math.floor(position), upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/** 时间窗口内数值的滚动分布：按时间先进先出，另存一份有序副本。 */
export class RollingWindow {
  private readonly times: number[] = [];
  private readonly values: number[] = [];
  private head = 0;
  private readonly sorted: number[] = [];
  private pushes = 0;
  private dispersion: number | null = null;
  private readonly windowMs: number;
  constructor(windowMs: number) { this.windowMs = windowMs; }
  push(time: number, value: number): void {
    this.times.push(time); this.values.push(value); insertSorted(this.sorted, value);
    this.evict(time);
    if (++this.pushes % DISPERSION_EVERY === 0) this.dispersion = null;
  }
  evict(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.head < this.times.length && this.times[this.head] < cutoff) { removeSorted(this.sorted, this.values[this.head]); this.head++; }
    if (this.head > 4096 && this.head * 2 > this.times.length) { this.times.splice(0, this.head); this.values.splice(0, this.head); this.head = 0; }
  }
  get size(): number { return this.sorted.length; }
  get oldest(): number | null { return this.head < this.times.length ? this.times[this.head] : null; }
  median(): number | null { return quantileOf(this.sorted, 0.5); }
  quantile(q: number): number | null { return quantileOf(this.sorted, q); }
  /** 稳健标准差：MAD × 1.4826，下限 0.5 基点（价差长时间不动时避免除以零）。 */
  sigma(): number | null {
    if (this.sorted.length < 2) return null;
    if (this.dispersion === null) {
      const median = this.median()!;
      const deviations = this.sorted.map(value => Math.abs(value - median)).sort((a, b) => a - b);
      this.dispersion = Math.max(0.5, quantileOf(deviations, 0.5)! * MAD_SCALE);
    }
    return this.dispersion;
  }
}

export interface Baseline { regime: Regime; median: number; sigma: number; samples: number; since: number | null; fallback: boolean }

/** 两腿都是行情流的配对计入基线的最短间隔（约一分钟抽一个，留 5 秒余量）。 */
export const LIVE_BASELINE_GAP_MS = 55_000;

/**
 * 一个标的的基线：每个时段一个滚动窗口，另有一个不分时段的窗口。当前时段样本不足时退回全天窗口（标 fallback），
 * 全天窗口也不足时没有基线。
 */
export class BaselineTracker {
  private readonly windows = new Map<Regime, RollingWindow>();
  private readonly all: RollingWindow;
  readonly kind: AssetKind;
  private readonly minSamples: number;
  private readonly minGapMs: number;
  private last = -Infinity;
  /** minGapMs：两次计入基线的最短间隔。两腿都是行情流的配对每 5 秒或 20 秒采一次，按约一分钟抽一个，最少样本数与有 Var 的配对同样是「分钟」。 */
  constructor(kind: AssetKind, windowMs: number, minSamples: number, minGapMs = 0) {
    this.kind = kind; this.minSamples = minSamples; this.minGapMs = minGapMs;
    this.all = new RollingWindow(windowMs);
    for (const regime of regimesOf(kind)) if (regime !== 'all') this.windows.set(regime, new RollingWindow(windowMs));
  }
  push(sample: Sample): void {
    const value = midBasis(sample);
    if (!Number.isFinite(value) || sample.t - this.last < this.minGapMs) return;
    this.last = sample.t;
    this.all.push(sample.t, value);
    this.windows.get(sample.regime)?.push(sample.t, value);
  }
  value(regime: Regime, now: number): Baseline | null {
    const own = this.windows.get(regime);
    for (const window of own ? [own, this.all] : [this.all]) {
      window.evict(now);
      if (window.size >= this.minSamples) return { regime: window === this.all ? 'all' : regime, median: window.median()!, sigma: window.sigma()!, samples: window.size, since: window.oldest, fallback: window === this.all && own !== undefined };
    }
    return null;
  }
}

// ---- 页面的基线统计 ----
export interface RegimeStats {
  regime: Regime;
  samples: number;
  /** 中间价基差的分布（基点）。 */ median: number | null; mean: number | null; sigma: number | null; std: number | null;
  p05: number | null; p25: number | null; p75: number | null; p95: number | null;
  /** 1k 档往返成本（买 A 价差 − 卖 A 价差）的中位数，基点。 */ costMedian: number | null;
  /** 偏离中位数的 AR(1) 半衰期（分钟），不回归时为 null。 */ halfLifeMin: number | null;
  /** 每天穿越中位数的次数。 */ crossingsPerDay: number | null;
  /** 卖 A 或买 A 的可成交价差偏离中位数至少 entryBps 的样本占比。 */ opportunityShare: number | null;
  /** 中间价偏离中位数绝对值的 95 分位（基点）。 */ deviation95: number | null;
}

/** 相邻样本间隔超过这个值时不当作连续（半衰期回归与穿越计数都跳过）。 */
const CONTIGUOUS_MS = 3 * 60_000;

export function regimeStats(regime: Regime, samples: readonly Sample[], entryBps: number, bucket: SizeBucket = '1k'): RegimeStats {
  const values = samples.map(midBasis).filter(Number.isFinite);
  const sorted = [...values].sort((a, b) => a - b);
  const median = quantileOf(sorted, 0.5);
  const mean = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const std = mean !== null && values.length > 1 ? Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)) : null;
  const deviations = median === null ? [] : values.map(value => Math.abs(value - median)).sort((a, b) => a - b);
  const sigma = median === null || values.length < 2 ? null : Math.max(0.5, quantileOf(deviations, 0.5)! * MAD_SCALE);
  const costs: number[] = [];
  let opportunities = 0, priced = 0;
  for (const sample of samples) {
    const spread = spreadOf(sample, bucket);
    if (!spread) continue;
    priced++;
    costs.push(spread.buyA - spread.sellA);
    if (median !== null && (spread.sellA - median >= entryBps || median - spread.buyA >= entryBps)) opportunities++;
  }
  costs.sort((a, b) => a - b);
  // 半衰期：x(t) = φ·x(t−1) + ε，只用相邻且连续的样本对；按两样本实际间隔换算成每分钟的 φ。
  let sxy = 0, sxx = 0, pairs = 0, crossings = 0, spanMs = 0, gapSum = 0;
  if (median !== null) {
    for (let index = 1; index < samples.length; index++) {
      const previous = samples[index - 1], current = samples[index], gap = current.t - previous.t;
      if (gap <= 0 || gap > CONTIGUOUS_MS) continue;
      const x0 = midBasis(previous) - median, x1 = midBasis(current) - median;
      sxy += x0 * x1; sxx += x0 * x0; pairs++; gapSum += gap; spanMs += gap;
      if (x0 !== 0 && x1 !== 0 && Math.sign(x0) !== Math.sign(x1)) crossings++;
    }
  }
  let halfLifeMin: number | null = null;
  if (pairs >= 30 && sxx > 0) {
    const phi = sxy / sxx, stepMin = gapSum / pairs / 60_000;
    if (phi > 0 && phi < 1) halfLifeMin = -Math.log(2) / Math.log(phi) * stepMin;
  }
  return {
    regime, samples: values.length, median, mean, sigma, std,
    p05: quantileOf(sorted, 0.05), p25: quantileOf(sorted, 0.25), p75: quantileOf(sorted, 0.75), p95: quantileOf(sorted, 0.95),
    costMedian: quantileOf(costs, 0.5), halfLifeMin,
    crossingsPerDay: spanMs >= 3_600_000 ? crossings / (spanMs / 86_400_000) : null,
    opportunityShare: priced ? opportunities / priced : null,
    deviation95: quantileOf(deviations, 0.95),
  };
}

/** 一个标的在各时段与全天的统计；全天排在最后。 */
export function symbolStats(kind: AssetKind, samples: readonly Sample[], entryBps: number, bucket: SizeBucket = '1k'): RegimeStats[] {
  const groups = regimesOf(kind);
  const result = groups.filter(regime => regime !== 'all').map(regime => regimeStats(regime, samples.filter(sample => sample.regime === regime), entryBps, bucket));
  result.push(regimeStats('all', samples, entryBps, bucket));
  return result;
}

/**
 * 参数建议（只作参考）：入场阈值是可成交价差对基线的偏离，可成交价差比中间价多付半个往返成本，所以取「中间价偏离的
 * 95 分位 − 半个往返成本」，即历史上约 5% 的时间能触发；不足 5 基点按 5 基点。出场取基线（0）。
 */
export function suggestedEntryBps(stats: RegimeStats): number | null {
  if (stats.costMedian === null || stats.deviation95 === null) return null;
  return Math.max(5, Math.round(stats.deviation95 - stats.costMedian / 2));
}
