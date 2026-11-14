// The Hynix page's data rules, copied from the project-aggregation workbench (modules/monitor): the history warnings from
// lib/market-service.ts describeMarket (8470785), HYNIX_SPREAD_CHART from app/spread-chart.tsx (4be9aa4, without the
// indicator periods, the fills and the trade markers). The quote is the service's validated Hyperliquid mids plus whether
// the service still counts it as current; the candles are the stored hourly closes, converted here.
import { HYNIX_CANDLE_MS, hynixChartRows, validateHynixQuote, validateHynixRows, type HynixQuote as Quote } from '../../src/vendor/hynix-market.mjs';
import type { Point, SpreadChartConfig } from './monitor-history.ts';

/** The workbench's widest Hynix indicator window is 20 days (M-2e); one more day of margin, as on the other markets. */
export const HYNIX_WARMUP_DAYS = 21;

/** `lastError`: why the service's latest read failed, null when it succeeded. */
export type HynixQuote = Quote & { status: 'live' | 'snapshot'; lastError: string | null };
type Coverage = { firstObservation: string; lastObservation: string; rows: number };
/** A windowed read keeps only its last `windowDays` days in `points`; `coverage` is always the complete history's range. */
export type HynixHistory = { points: Point[]; status: 'live' | 'snapshot'; fetchedAt: string; windowDays: number | null; coverage: Coverage; lastError: string | null; warnings: string[] };

const lastError = (input: unknown) => { const value = (input as { lastError?: unknown } | null)?.lastError; return typeof value === 'string' && value ? value : null; };

export function hynixQuote(input: unknown): HynixQuote {
  return { ...validateHynixQuote(input), status: (input as { status?: unknown }).status === 'live' ? 'live' : 'snapshot', lastError: lastError(input) };
}

/** The workbench's notices: gaps between paired hours, and a last hour more than two hours behind `now`. */
function warnings(points: readonly Point[], now: number): string[] {
  const out: string[] = [];
  let gaps = 0;
  for (let i = 1; i < points.length; i++) if (points[i]!.time - points[i - 1]!.time > HYNIX_CANDLE_MS) gaps++;
  if (gaps) out.push(`历史行情存在 ${gaps} 处缺口，图表保留断点；区间均值仅基于可用时段。`);
  if (points.length && now - (points.at(-1)!.time + HYNIX_CANDLE_MS) > 2 * HYNIX_CANDLE_MS) out.push('最近一个共同小时距今超过 2 小时，请留意行情时间。');
  return out;
}

export function hynixHistory(input: unknown, now = Date.now()): HynixHistory {
  const raw = (input ?? {}) as { rows?: unknown; fetchedAt?: unknown; status?: unknown; windowDays?: unknown; coverage?: Partial<Coverage> };
  if (typeof raw.fetchedAt !== 'string') throw new Error('Invalid Hynix candle time');
  const rows = validateHynixRows(raw.rows, raw.fetchedAt);
  if (!rows.length) throw new Error('Empty Hynix candles');
  const windowDays = raw.windowDays === undefined ? null : Number.isSafeInteger(raw.windowDays) && (raw.windowDays as number) > 0 ? raw.windowDays as number : NaN;
  if (Number.isNaN(windowDays)) throw new Error('Invalid Hynix candle window');
  const first = new Date(rows[0]!.time).toISOString(), last = new Date(rows.at(-1)!.time).toISOString();
  const value = raw.coverage ?? {};
  // The complete history's range: it ends at the same hour and starts no later than the rows sent.
  if (typeof value.firstObservation !== 'string' || value.lastObservation !== last || !(Date.parse(value.firstObservation) <= Date.parse(first))
    || !Number.isSafeInteger(value.rows) || value.rows! < rows.length || (windowDays === null && (value.firstObservation !== first || value.rows !== rows.length))) throw new Error('Invalid Hynix candle coverage');
  const points = hynixChartRows(rows);
  return {
    points, status: raw.status === 'live' ? 'live' : 'snapshot', fetchedAt: raw.fetchedAt, windowDays,
    coverage: { firstObservation: value.firstObservation, lastObservation: last, rows: value.rows! }, lastError: lastError(input), warnings: warnings(points, now),
  };
}

/** Whether loaded history holds every hour a `range`-day chart (null = all) and its indicator warmup need. */
export const coversHynixRange = (history: HynixHistory, range: number | null) =>
  history.windowDays === null || (range !== null && history.windowDays >= range + HYNIX_WARMUP_DAYS);

const usd = (v: number) => `$${v.toFixed(2)}`;
/** The ADR (`adr`) against the ordinary share ÷ 10 (`equivalent`) on completed Hyperliquid hours. */
export const HYNIX_SPREAD_CHART: SpreadChartConfig = {
  intervalMs: HYNIX_CANDLE_MS, kicker: 'PREMIUM MONITOR', bar: '小时', span: count => `${count.toLocaleString()} 小时`, checkCadence: '每分钟检查更新',
  modes: ['premium', 'spread', 'price'], tabs: { premium: '溢价率', spread: '美元价差', price: '价格对比' }, units: { premium: '% · ADR 相对正股', spread: 'USD / 份 ADR', price: 'USD / 份 ADR' },
  premiumName: 'ADR 溢价率', spreadName: '每份价差', legs: ['ADR', '正股 ÷ 10'], zeroLabel: '0 = 平价', domainStep: 5, digits: 2, price: usd,
  tick: { premium: v => `${Number(v.toFixed(2))}%`, spread: v => `$${Number(v.toFixed(2))}`, price: v => `$${Number(v.toFixed(2))}` },
  emptyText: { loading: '正在载入小时 K 线', hint: 'Hyperliquid xyz:SKHY / xyz:SKHX 同一小时已收盘 K 线' },
};
