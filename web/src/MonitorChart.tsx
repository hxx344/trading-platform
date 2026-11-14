import { Activity } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { ranges, sampleChartPoints, selectRange, type ChartMode, type Point, type SpreadChartConfig } from './monitor-history.ts';
import { SvgPlot, createHoverStore, type PlotLayer } from './svg-plot.tsx';
import { fixedAxis, niceAxis } from './svg-plot-geometry.ts';

// The history chart of every monitor market, the workbench's modules/monitor/app/spread-chart.tsx (4be9aa4) without the
// fills and the indicators (M-2e). Each market's config names its tabs: Anthropic has premium, spread and price; oil has
// spread and price only.
export const date = (t: number | string, full = false) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', month: '2-digit', day: '2-digit', ...(full ? { year: 'numeric' } : {}) }).format(new Date(t));
export const stamp = (t: number | string) => `${date(t, true)} ${new Date(t).toISOString().slice(11, 16)} UTC`;

/** A gap row carries null prices: lines break there and it shows no tooltip. */
type ChartPoint = { time: number; adr: number | null; equivalent: number | null; spread: number | null; premium: number | null };
const metricValue = (v: number | null | undefined, mode: ChartMode, config: SpreadChartConfig) => v == null ? '—' : mode === 'premium' ? `${v.toFixed(config.digits)}%` : `${v < 0 ? '−' : ''}${config.price(Math.abs(v))}`;
const zeroLine = [{ y: 0, color: 'var(--muted-foreground)', dash: '4 4' }];
const premiumFill = <linearGradient id="premiumFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--primary)" stopOpacity={0.21} /><stop offset="100%" stopColor="var(--primary)" stopOpacity={0.01} /></linearGradient>;

function chartTooltip(p: ChartPoint, config: SpreadChartConfig) {
  if (p.adr == null || p.equivalent == null) return null;
  return <div className="chart-tooltip">
    <strong>{stamp(p.time)}</strong>
    {config.modes.includes('premium') && p.premium != null && <div><span>{config.premiumName}</span><b className={p.premium >= 0 ? 'positive' : 'negative'}>{metricValue(p.premium, 'premium', config)}</b></div>}
    <div><span>{config.legs.join(' / ')}</span><b>{config.price(p.adr)} / {config.price(p.equivalent)}</b></div>
    <div><span>{config.spreadName}</span><b>{metricValue(p.spread, 'spread', config)}</b></div>
  </div>;
}

export const SpreadChart = memo(function SpreadChart({ data, loading, range, onRangeChange, mode, onModeChange, config }: {
  data: Point[]; loading: boolean; range: number | null; onRangeChange: (range: number | null) => void; mode: ChartMode; onModeChange: (mode: ChartMode) => void; config: SpreadChartConfig;
}) {
  const { intervalMs } = config;
  const metric = mode === 'spread' ? 'spread' : 'premium';
  const points = useMemo(() => selectRange(data, range), [data, range]);
  const latest = points.at(-1);
  const chartPoints = useMemo((): ChartPoint[] => points.flatMap((p, i) => i && p.time - points[i - 1].time > intervalMs ? [
    { time: points[i - 1].time + intervalMs, adr: null, equivalent: null, spread: null, premium: null }, p,
  ] : [p]), [points, intervalMs]);
  // Long ranges plot bucket extrema only; readings and stats keep every bar.
  const sampled = useMemo(() => sampleChartPoints(chartPoints, mode === 'price' ? ['adr', 'equivalent'] : [metric]), [chartPoints, mode, metric]);
  const step = config.domainStep;
  const domain = useMemo((): [number, number] => {
    let low = 0, high = 0, any = false;
    for (const p of points) { const value = p[metric]; if (Number.isFinite(value)) { any = true; low = Math.min(low, value); high = Math.max(high, value); } }
    if (!any) return [0, step];
    return [Math.floor(low / step) * step, Math.ceil(high / step) * step || step];
  }, [points, metric, step]);
  const priceDomain = useMemo(() => {
    let low = Infinity, high = -Infinity;
    for (const p of points) for (const value of [p.adr, p.equivalent]) if (Number.isFinite(value)) { low = Math.min(low, value); high = Math.max(high, value); }
    return [low, high] as const;
  }, [points]);
  // The premium and spread axes keep their explicit domains; only the price axis widens to round ticks.
  const mainAxis = useMemo(() => mode === 'price' ? niceAxis(priceDomain[0], priceDomain[1]) : fixedAxis(domain[0], domain[1]), [mode, priceDomain, domain]);
  const xRange = useMemo(() => points.length ? [points[0].time, points.at(-1)!.time] as const : [0, 1] as const, [points]);
  const layers = useMemo((): PlotLayer[] => mode === 'price' ? [
    { kind: 'line', key: 'adr', color: 'var(--chart-2)', width: 2, active: true },
    { kind: 'line', key: 'equivalent', color: 'var(--warning)', width: 2, active: true },
  ] : [
    { kind: 'area', key: metric, lower: 0, fill: 'url(#premiumFill)' },
    { kind: 'line', key: metric, color: 'var(--primary)', width: 2, active: true },
  ], [mode, metric]);
  const [hover] = useState(createHoverStore);
  const metricName = mode === 'premium' ? config.premiumName : config.spreadName;
  const tick = config.tick[mode] ?? config.tick.spread;
  return <section className="chart-panel" aria-label="历史价差图表">
    <div className="chart-heading">
      <div><div className="section-kicker">{config.kicker}</div><h2>{mode === 'price' ? '同口径价格走势' : '价差走势'}</h2><p className="history-timestamp">{config.bar}收盘图 · {config.checkCadence}{latest ? ` · 最近收盘 ${stamp(latest.time + intervalMs)}` : ''}</p></div>
      <div className="segmented range-control" role="group" aria-label="时间范围">{ranges.map(r => <button type="button" key={r.label} aria-pressed={range === r.days} className={range === r.days ? 'active' : ''} onClick={() => onRangeChange(r.days)}>{r.label}</button>)}</div>
    </div>
    <div className="chart-toolbar">
      <div className="chart-tabs" role="group" aria-label="图表指标">{config.modes.map(id => <button type="button" key={id} aria-pressed={mode === id} className={mode === id ? 'active' : ''} onClick={() => onModeChange(id)}>{config.tabs[id]}</button>)}</div>
      <span className="chart-unit">{config.units[mode]}</span>
    </div>
    <div className="chart-container">
      {!points.length ? <div className="empty-chart"><Activity size={28} aria-hidden="true" /><p>{loading ? config.emptyText.loading : '暂无可用行情'}</p><span>{loading ? config.emptyText.hint : '点击刷新行情重试'}</span></div>
        : <SvgPlot rows={sampled} hoverRows={chartPoints} xDomain={xRange} yDomain={mainAxis.domain} yTicks={mainAxis.ticks} yTick={tick}
          layers={layers} references={mode === 'price' ? [] : zeroLine} margin={{ top: 25, right: 82, bottom: 36 }} height={300} hover={hover}
          label={mode === 'price' ? `${config.legs.join(' 与 ')} ${config.bar}收盘价格走势` : `${metricName}${config.bar}走势`}
          defs={premiumFill} tooltip={row => chartTooltip(row as ChartPoint, config)} />}
    </div>
    <div className="chart-caption"><span>{mode === 'price' ? <><i className="legend-dot adr" />{config.legs[0]} <i className="legend-dot ordinary" />{config.legs[1]}</> : <><i className="legend-dot premium" />{metricName}<span className="zero-line" />{config.zeroLabel}</>}</span><span>{points.length ? `${date(points[0].time, true)} — ${date(points.at(-1)!.time, true)} · ${config.span(points.length)}${sampled.length < chartPoints.length ? ` · 绘图保留极值与缺口共 ${sampled.length.toLocaleString()} 点，读数与统计使用全部记录` : ''}` : `${config.bar}收盘 · UTC`}</span></div>
  </section>;
});
