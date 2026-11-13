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
/** The workbench reads its widest indicator window (20 days) and one more day before a range; kept so the same reads cover the same ranges. */
export const ANTHROPIC_WARMUP_DAYS = 21;

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
export const CHART_MODES: readonly ChartMode[] = ['premium', 'spread', 'price'];
/** The workbench SpreadChartConfig, keeping only what the chart without fills and indicators reads. */
export type AnthropicChartConfig = {
  intervalMs: number;
  kicker: string;
  bar: string;
  span: (count: number) => string;
  checkCadence: string;
  tabs: Record<ChartMode, string>;
  units: Record<ChartMode, string>;
  premiumName: string;
  spreadName: string;
  legs: readonly [string, string];
  zeroLabel: string;
  /** Premium/spread axes include zero and round outward to this step. */
  domainStep: number;
  digits: number;
  price: (value: number) => string;
  tick: Record<ChartMode, (value: number) => string>;
  emptyText: { loading: string; hint: string };
};
const usd = (v: number) => `$${v.toFixed(2)}`;
/** Per-share premium chart of Binance against the selected comparison contract. */
export function anthropicChartConfig(leg: AnthropicComparisonLeg): AnthropicChartConfig {
  const { name, label } = ANTHROPIC_LEGS[leg];
  return {
    intervalMs: ANTHROPIC_CANDLE_MS, kicker: 'PREMIUM MONITOR', bar: '15 分钟',
    span: count => `${(count / 4).toLocaleString()} 小时`, checkCadence: '每分钟检查更新',
    tabs: { premium: '溢价率', spread: '每股价差', price: '每股价格' }, units: { premium: `% · Binance 相对 ${name}`, spread: 'USD / 股', price: 'USD / 股' },
    premiumName: 'Binance 溢价率', spreadName: '每股价差', legs: ['Binance', name], zeroLabel: '0 = 同价', domainStep: 1, digits: 2, price: usd,
    tick: { premium: v => `${Number(v.toFixed(2))}%`, spread: v => `$${Number(v.toFixed(2))}`, price: v => `$${Number(v.toFixed(1))}` },
    emptyText: { loading: '正在载入 15 分钟 K 线', hint: `Binance ANTHROPICUSDT / ${label} 同一时段已收盘 K 线` },
  };
}
