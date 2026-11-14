// The Anthropic page's data rules, copied from the project-aggregation workbench: anthropicHistory, coversAnthropicRange,
// anthropicPoints and anthropicChartConfig from lib/anthropic-history.ts (35ebb94, without the fills and indicator parts),
// selectRange and dailyPoints from lib/market.ts (8470785), ranges from lib/chart-ranges.ts (8470785), sampleChartPoints
// from lib/chart-sampling.ts (7581e78, unchanged).
import { ANTHROPIC_CANDLE_MS, ANTHROPIC_LEGS, anthropicChartRows, validateAnthropicCandles, validateAnthropicQuote, type AnthropicChartRow, type AnthropicComparisonLeg, type AnthropicShares } from '../../src/vendor/anthropic-market.mjs';

export type Point = AnthropicChartRow;
type Snapshot = ReturnType<typeof validateAnthropicCandles>;
export type AnthropicRow = Snapshot['data'][number];
type Coverage = Pick<Snapshot['metadata'], 'firstObservation' | 'lastObservation' | 'rows'>;
export type AnthropicQuote = ReturnType<typeof validateAnthropicQuote> & { status: 'live' | 'snapshot' };
/** A windowed read keeps only its last `windowDays` days in `rows`; `coverage` is always the complete history's range. */
export type AnthropicHistory = { rows: AnthropicRow[]; status: 'live' | 'snapshot'; fetchedAt: string; windowDays: number | null; coverage: Coverage; errors: Snapshot['metadata']['errors'] };

export const ranges = [{ label: '1 周', days: 7 }, { label: '1 月', days: 30 }, { label: '全部', days: null }] as const;
/** The widest Anthropic indicator window (Bollinger bands and Z-score), as in the workbench's lib/anthropic-history.ts. */
export const ANTHROPIC_BANDS_DAYS = 20;
/** Days read before a selected range so its first bar has the full indicator window, plus one day of margin. */
export const ANTHROPIC_WARMUP_DAYS = ANTHROPIC_BANDS_DAYS + 1;
const ANTHROPIC_BARS_PER_DAY = 86_400_000 / ANTHROPIC_CANDLE_MS;

/** The quote as the service sends it: the venues' marks, and whether the service still counts them as current. */
export function anthropicQuote(input: unknown): AnthropicQuote {
  const quote = validateAnthropicQuote(input);
  return { ...quote, status: (input as { status?: unknown }).status === 'live' ? 'live' : 'snapshot' };
}

export function anthropicHistory(input: unknown): AnthropicHistory {
  const snapshot = validateAnthropicCandles(input), raw = input as { windowDays?: unknown; coverage?: Partial<Coverage> };
  const windowDays = raw.windowDays === undefined ? null : Number.isSafeInteger(raw.windowDays) && (raw.windowDays as number) > 0 ? raw.windowDays as number : NaN;
  if (Number.isNaN(windowDays)) throw new Error('Invalid Anthropic candle window');
  const { firstObservation, lastObservation, rows } = snapshot.metadata;
  let coverage: Coverage = { firstObservation, lastObservation, rows };
  if (windowDays !== null) {
    const value = raw.coverage ?? {};
    if (typeof value.firstObservation !== 'string' || value.lastObservation !== lastObservation || !(Date.parse(value.firstObservation) <= Date.parse(firstObservation))
      || !Number.isSafeInteger(value.rows) || value.rows! < rows) throw new Error('Invalid Anthropic candle coverage');
    coverage = { firstObservation: value.firstObservation, lastObservation, rows: value.rows! };
  }
  return { rows: snapshot.data, status: snapshot.status === 'snapshot' ? 'snapshot' : 'live', fetchedAt: snapshot.metadata.fetchedAt, windowDays, coverage, errors: snapshot.metadata.errors };
}

export const coversAnthropicRange = (history: AnthropicHistory, range: number | null) =>
  history.windowDays === null || (range !== null && history.windowDays >= range + ANTHROPIC_WARMUP_DAYS);

/** Binance (`adr`) against one comparison leg (`equivalent`), both per share. */
export const anthropicPoints = (rows: AnthropicRow[], leg: AnthropicComparisonLeg, shares: AnthropicShares | null): Point[] => anthropicChartRows(rows, leg, shares);

export function selectRange<T extends Point>(points: T[], days: number | null): T[] {
  if (!days || !points.length) return points;
  const start = points.at(-1)!.time - days * 86_400_000;
  return points.filter(p => p.time >= start);
}

/**
 * The breaks between consecutive bars and how many bars they miss, counted on the rows a range shows: a windowed read
 * also carries the indicator warmup before the range, which its notices must not count.
 */
export function rangeGaps(points: readonly { time: number }[], intervalMs: number): { gaps: number; missing: number } {
  let gaps = 0, missing = 0;
  for (let i = 1; i < points.length; i++) {
    const step = points[i]!.time - points[i - 1]!.time;
    if (step > intervalMs) { gaps++; missing += Math.round(step / intervalMs) - 1; }
  }
  return { gaps, missing };
}

export type IndicatorToggles = { sma: boolean; bands: boolean; zscore: boolean };
/** The chart's saved indicator toggles under `key`; anything missing or unreadable is on, as the workbench's defaults. */
export function savedToggles(key: string): IndicatorToggles {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null') as Partial<Record<keyof IndicatorToggles, unknown>> | null;
    if (!value || typeof value !== 'object') return { sma: true, bands: true, zscore: true };
    return { sma: value.sma !== false, bands: value.bands !== false, zscore: value.zscore !== false };
  } catch { return { sma: true, bands: true, zscore: true }; }
}

export function dailyPoints(points: Point[]): Point[] {
  const days = new Map<string, Point>();
  for (const p of points) days.set(new Date(p.time).toISOString().slice(0,10), p);
  return [...days.values()];
}

const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * Reduce SVG cost for long hourly charts. Every bucket keeps its endpoints and
 * each plotted series' extrema; every presence change (data gap break rows,
 * indicator warmup) keeps both neighbours so lines still break where the data does.
 * About 300 buckets keep a noisy series' envelope at roughly 3 px per bucket on a
 * desktop chart; smooth series rarely add points beyond the bucket endpoints.
 * Inputs of up to four points per bucket are returned unchanged.
 */
export function sampleChartPoints<T extends object>(points: readonly T[], keys: readonly (keyof T)[], buckets = 300): readonly T[] {
  if (!keys.length || !(buckets >= 1) || points.length <= buckets * 4) return points;
  const width = Math.ceil(points.length / Math.floor(buckets));
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  for (let start = 0; start < points.length; start += width) {
    const end = Math.min(points.length, start + width);
    keep[start] = keep[end - 1] = 1;
    for (const key of keys) {
      let min = -1, max = -1, low = Infinity, high = -Infinity;
      for (let i = start; i < end; i++) {
        const value = finite(points[i][key]);
        if (value === null) continue;
        if (value < low) { low = value; min = i; }
        if (value > high) { high = value; max = i; }
      }
      if (min >= 0) keep[min] = keep[max] = 1;
    }
  }
  for (let i = 1; i < points.length; i++) {
    if (keys.some(key => (finite(points[i][key]) === null) !== (finite(points[i - 1][key]) === null))) keep[i - 1] = keep[i] = 1;
  }
  return points.filter((_, index) => keep[index] === 1);
}

export type ChartMode = 'premium' | 'spread' | 'price';
/** Labels for each chart tab; a market without a percentage view (oil) has no `premium`. */
export type ModeLabels<T> = Record<'spread' | 'price', T> & Partial<Record<'premium', T>>;
/** The workbench SpreadChartConfig (app/spread-chart.tsx, 4be9aa4) without the fill and trade-marker fields. */
export type SpreadChartConfig = {
  intervalMs: number;
  /** Indicator windows in bars: 7 days and 20 days of `intervalMs`. */
  periods: { sma: number; bands: number };
  /** Where the indicator toggles are remembered (the workbench keys them by market too). */
  preferenceKey: string;
  kicker: string;
  /** "小时" or "15 分钟": names one bar. */
  bar: string;
  /** Reads a bar count, e.g. "168 小时". */
  span: (count: number) => string;
  /** Reads a consecutive bar count, e.g. "480 个连续小时". */
  bars: (count: number) => string;
  checkCadence: string;
  /** The tabs in order; the first one is shown first. */
  modes: readonly ChartMode[];
  tabs: ModeLabels<string>;
  units: ModeLabels<string>;
  premiumName?: string;
  spreadName: string;
  legs: readonly [string, string];
  zeroLabel: string;
  /** Premium/spread axes include zero and round outward to this step. */
  domainStep: number;
  digits: number;
  price: (value: number) => string;
  tick: ModeLabels<(value: number) => string>;
  emptyText: { loading: string; hint: string };
};
const usd = (v: number) => `$${v.toFixed(2)}`;
/** Per-share premium chart of Binance against the selected comparison contract. */
export function anthropicChartConfig(leg: AnthropicComparisonLeg): SpreadChartConfig {
  const { name, label } = ANTHROPIC_LEGS[leg];
  return {
    intervalMs: ANTHROPIC_CANDLE_MS, periods: { sma: 7 * ANTHROPIC_BARS_PER_DAY, bands: ANTHROPIC_BANDS_DAYS * ANTHROPIC_BARS_PER_DAY }, preferenceKey: 'monitor:chart:anthropic:v1',
    kicker: 'PREMIUM MONITOR', bar: '15 分钟', span: count => `${(count / 4).toLocaleString()} 小时`, bars: count => `${count.toLocaleString()} 根连续 15 分钟 K 线`, checkCadence: '每分钟检查更新', modes: ['premium', 'spread', 'price'],
    tabs: { premium: '溢价率', spread: '每股价差', price: '每股价格' }, units: { premium: `% · Binance 相对 ${name}`, spread: 'USD / 股', price: 'USD / 股' },
    premiumName: 'Binance 溢价率', spreadName: '每股价差', legs: ['Binance', name], zeroLabel: '0 = 同价', domainStep: 1, digits: 2, price: usd,
    tick: { premium: v => `${Number(v.toFixed(2))}%`, spread: v => `$${Number(v.toFixed(2))}`, price: v => `$${Number(v.toFixed(1))}` },
    emptyText: { loading: '正在载入 15 分钟 K 线', hint: `Binance ANTHROPICUSDT / ${label} 同一时段已收盘 K 线` },
  };
}
