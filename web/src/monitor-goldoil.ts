// Monitor M-2f: the gold/oil ratio page's data (MonitorGoldOil.tsx), without React. The checks are the service's own
// (src/monitor/goldoil-market.ts); the ranges, statistics and wording follow the workbench's lib/gold-oil-analysis.ts
// (8470785: goldOilStatistics) and app/gold-oil-panel.tsx (584ebc8), both oil legs in one history.
import {
  GOLDOIL_CANDLE_MS, GOLDOIL_INSTRUMENTS, validateGoldOilHistory, validateGoldOilQuote,
  type GoldOilCoverage, type GoldOilHistory as ServedHistory, type GoldOilQuote as ServedQuote, type GoldOilType,
} from '../../src/monitor/goldoil-market.ts';
import { quoteStatus } from './monitor-display.ts';

export { GOLDOIL_INSTRUMENTS, GOLDOIL_UNITS, type GoldOilType } from '../../src/monitor/goldoil-market.ts';
export const GOLDOIL_QUOTE_MS = 30_000;
export const GOLDOIL_RANGES = [{ label: '1 天', days: 1 }, { label: '1 周', days: 7 }, { label: '1 月', days: 30 }, { label: '全部', days: null }] as const;
export type GoldOilRange = typeof GOLDOIL_RANGES[number]['days'];
export const GOLDOIL_DEFAULT_RANGE: GoldOilRange = 7;
export type GoldOilView = 'ratio' | 'price';

export type GoldOilQuote = ServedQuote & { ratio: Record<GoldOilType, number>; status: 'live' | 'snapshot'; staleAfterMs: number; lastError: string | null };
/** The served quote, checked; the ratios are recomputed from the legs rather than taken from the answer. */
export function goldOilQuote(input: unknown): GoldOilQuote {
  const quote = validateGoldOilQuote(input);
  return { ...quote, ratio: { cl: quote.xau.price / quote.cl.price, bz: quote.xau.price / quote.bz.price }, ...quoteStatus(input) };
}

export type GoldOilHistory = Omit<ServedHistory, 'windowDays' | 'coverage'> & { windowDays: number | null; coverage: GoldOilCoverage; fetchedAt: string; lastError: string | null };
/** The served candles (whole or windowed), checked. */
export function goldOilHistory(input: unknown): GoldOilHistory {
  const history = validateGoldOilHistory(input);
  const { firstObservation, lastObservation, observationRows } = history.metadata;
  const raw = input as { lastError?: unknown };
  return { ...history, windowDays: history.windowDays ?? null, coverage: history.coverage ?? { firstObservation, lastObservation, observationRows },
    fetchedAt: history.metadata.fetchedAt, lastError: typeof raw.lastError === 'string' && raw.lastError ? raw.lastError : null };
}

/** One 15-minute bar for the chosen oil leg; `ratio` is null where either leg has no bar (the line breaks there). */
export interface GoldOilPoint { time: number; xau: number | null; oil: number | null; ratio: number | null }
export function goldOilPoints(history: GoldOilHistory | null, type: GoldOilType): GoldOilPoint[] {
  if (!history) return [];
  const column = GOLDOIL_INSTRUMENTS[type].column;
  return history.data.map(row => {
    const oil = row[column];
    return { time: row.time, xau: row.xau, oil, ratio: row.xau !== null && oil !== null ? row.xau / oil : null };
  });
}

/** The bars opening within `days` before the last one (null: all). */
export function selectGoldOilRange(points: readonly GoldOilPoint[], days: number | null): GoldOilPoint[] {
  if (days === null || !points.length) return [...points];
  const start = points.at(-1)!.time - days * 86_400_000;
  return points.filter(point => point.time >= start);
}

export interface GoldOilStatistics {
  count: number; average: number; first: { time: number; ratio: number }; last: { time: number; ratio: number };
  min: { time: number; ratio: number }; max: { time: number; ratio: number }; change: number; percentChange: number;
}
/** The workbench's goldOilStatistics over the bars with a ratio; null when there is none. */
export function goldOilStatistics(points: readonly GoldOilPoint[]): GoldOilStatistics | null {
  type Item = { time: number; ratio: number } | null;
  let count = 0, sum = 0, first: Item = null, last: Item = null, min: Item = null, max: Item = null;
  for (const { time, ratio } of points) {
    if (ratio === null) continue;
    const item = { time, ratio };
    count++; sum += ratio; first ??= item; last = item;
    if (!min || ratio < min.ratio) min = item;
    if (!max || ratio > max.ratio) max = item;
  }
  if (!first || !last || !min || !max) return null;
  const change = last.ratio - first.ratio;
  return { count, average: sum / count, first, last, min, max, change, percentChange: change / first.ratio * 100 };
}

/**
 * How many stretches of the selected bars have no ratio and how many 15-minute bars they miss (the workbench's gap notice):
 * a bar absent from the history and a bar where the chosen oil leg (or gold) is empty both count.
 */
export function goldOilGaps(points: readonly GoldOilPoint[]): { gaps: number; missing: number } {
  if (!points.length) return { gaps: 0, missing: 0 };
  let gaps = 0, missing = 0, previous = points[0]!.time - GOLDOIL_CANDLE_MS;
  const close = (until: number) => {
    const step = Math.round((until - previous) / GOLDOIL_CANDLE_MS) - 1;
    if (step > 0) { gaps++; missing += step; }
  };
  for (const point of points) if (point.ratio !== null) { close(point.time); previous = point.time; }
  close(points.at(-1)!.time + GOLDOIL_CANDLE_MS);
  return { gaps, missing };
}

/**
 * The drawn rows with an empty row at every missing stretch, so the lines break there and never bridge a gap. `all` holds
 * every bar; `drawn` may be a sample of it (sampleChartPoints), in which case a gap between two kept bars still breaks.
 */
export function withGoldOilBreaks(drawn: readonly GoldOilPoint[], all: readonly GoldOilPoint[]): GoldOilPoint[] {
  const gaps: number[] = [];
  for (let i = 1; i < all.length; i++) if (all[i]!.time - all[i - 1]!.time > GOLDOIL_CANDLE_MS) gaps.push(all[i - 1]!.time + GOLDOIL_CANDLE_MS);
  if (!gaps.length) return [...drawn];
  const rows: GoldOilPoint[] = [];
  let next = 0;
  for (const point of drawn) {
    let gap: number | null = null;
    while (next < gaps.length && gaps[next]! <= point.time) gap = gaps[next++]!;
    if (gap !== null && rows.length) rows.push({ time: gap, xau: null, oil: null, ratio: null });
    rows.push(point);
  }
  return rows;
}
