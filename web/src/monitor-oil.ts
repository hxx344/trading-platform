// The oil page's data rules, copied from the project-aggregation workbench (modules/monitor): oilHistory and coversOilRange
// from lib/oil-history.ts (89f26e5; retainOilHistory left out, the page keeps the last read as useLiveResource gives it),
// OIL_SPREAD_CHART from lib/oil-chart-config.ts (35ebb94, without the fills). The quote is the
// service's validated Binance market plus whether the service still counts it as current.
import { OIL_CANDLE_MS, validateIntradaySnapshot, validateMarket, validatedIntradayChartRows, type OilIntradayMetadata, type OilMarket } from '../../src/vendor/oil-market.mjs';
import type { Point, SpreadChartConfig } from './monitor-history.ts';

/** The widest oil indicator window (Bollinger bands and Z-score, M-2e). */
export const OIL_BANDS_DAYS = 20;
/** Days read before a selected range so its first bar has the full indicator window, plus one day of margin. */
export const OIL_WARMUP_DAYS = OIL_BANDS_DAYS + 1;
const OIL_BARS_PER_DAY = 86_400_000 / OIL_CANDLE_MS;

/** `lastError`: why the service's latest read failed, null when it succeeded. */
export type OilQuote = OilMarket & { status: 'live' | 'snapshot'; lastError: string | null };
type Coverage = Pick<OilIntradayMetadata, 'firstCommonObservation' | 'lastCommonObservation' | 'pairedObservationRows'>;
/**
 * Paired 15-minute closes on the shared chart shape: `adr` = Brent, `equivalent` = WTI.
 * A windowed read keeps only the last `windowDays` days in `points`/`metadata`; `coverage` is always the complete history's range.
 */
export type OilHistory = { points: Point[]; status: 'live' | 'snapshot'; fetchedAt: string; metadata: OilIntradayMetadata; windowDays: number | null; coverage: Coverage; lastError: string | null };

const lastError = (input: unknown) => { const value = (input as { lastError?: unknown }).lastError; return typeof value === 'string' && value ? value : null; };

export function oilQuote(input: unknown): OilQuote {
  const quote = validateMarket(input);
  return { ...quote, status: (input as { status?: unknown }).status === 'live' ? 'live' : 'snapshot', lastError: lastError(input) };
}

function readCoverage(input: unknown, metadata: OilIntradayMetadata): Coverage {
  const { firstCommonObservation, lastCommonObservation, pairedObservationRows } = (input ?? {}) as Partial<Coverage>;
  if (typeof firstCommonObservation !== 'string' || lastCommonObservation !== metadata.lastCommonObservation
    || !(Date.parse(firstCommonObservation) <= Date.parse(metadata.firstCommonObservation))
    || !Number.isSafeInteger(pairedObservationRows) || pairedObservationRows! < metadata.pairedObservationRows) throw new Error('Invalid oil candle coverage');
  return { firstCommonObservation, lastCommonObservation, pairedObservationRows: pairedObservationRows! };
}

/** `spread` = Brent − WTI in USDT per barrel. Oil charts only the absolute spread, so `premium` is NaN and the chart has no percentage tab. */
export function oilHistory(input: unknown): OilHistory {
  const snapshot = validateIntradaySnapshot(input);
  const points = validatedIntradayChartRows(snapshot).flatMap(({ time, brent, wti, spread }) => brent === null || wti === null ? [] : [{ time, adr: brent, ordinary: wti, equivalent: wti, spread, premium: NaN }]);
  const raw = input as { windowDays?: unknown; coverage?: unknown };
  const windowDays = raw.windowDays === undefined ? null : Number.isSafeInteger(raw.windowDays) && (raw.windowDays as number) > 0 ? raw.windowDays as number : NaN;
  if (Number.isNaN(windowDays)) throw new Error('Invalid oil candle window');
  const { firstCommonObservation, lastCommonObservation, pairedObservationRows } = snapshot.metadata;
  const coverage = windowDays === null ? { firstCommonObservation, lastCommonObservation, pairedObservationRows } : readCoverage(raw.coverage, snapshot.metadata);
  return { points, status: snapshot.status === 'snapshot' ? 'snapshot' : 'live', fetchedAt: snapshot.metadata.fetchedAt, metadata: snapshot.metadata, windowDays, coverage, lastError: lastError(input) };
}

/** Whether loaded history holds every bar a `range`-day chart (null = all) and its indicator warmup need. */
export const coversOilRange = (history: OilHistory, range: number | null) =>
  history.windowDays === null || (range !== null && history.windowDays >= range + OIL_WARMUP_DAYS);

const usdt = (v: number) => `${v.toFixed(3)} USDT`;
/** Brent (`adr`) against WTI (`equivalent`) on completed 15-minute Binance candles. */
export const OIL_SPREAD_CHART: SpreadChartConfig = {
  intervalMs: OIL_CANDLE_MS, periods: { sma: 7 * OIL_BARS_PER_DAY, bands: OIL_BANDS_DAYS * OIL_BARS_PER_DAY }, preferenceKey: 'monitor:chart:oil:v1',
  kicker: 'SPREAD MONITOR', bar: '15 分钟', span: count => `${(count / 4).toLocaleString()} 小时`, bars: count => `${count.toLocaleString()} 根连续 15 分钟 K 线`, checkCadence: '每分钟检查更新',
  // Oil charts only the absolute Brent − WTI spread; there is no percentage tab.
  modes: ['spread', 'price'], tabs: { spread: '价差', price: '价格对比' }, units: { spread: 'USDT / 桶 · 布伦特 − WTI', price: 'USDT / 桶' },
  spreadName: '价差', legs: ['布伦特', 'WTI'], zeroLabel: '0 = 同价', domainStep: 1, digits: 3, price: usdt,
  tick: { spread: v => `${Number(v.toFixed(2))}`, price: v => `${Number(v.toFixed(1))}` },
  emptyText: { loading: '正在载入 15 分钟 K 线', hint: 'Binance BZUSDT / CLUSDT 同一时段已收盘 K 线' },
};
