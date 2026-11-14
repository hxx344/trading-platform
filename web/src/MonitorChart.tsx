import { Activity, Check, Info } from 'lucide-react';
import { memo, useMemo, useState, type SetStateAction } from 'react';
import { calculateIndicators, type IndicatorPoint, type SpreadMetric } from '../../src/vendor/indicators.mjs';
import { ranges, sampleChartPoints, savedToggles, selectRange, type ChartMode, type IndicatorToggles as Toggles, type Point, type SpreadChartConfig } from './monitor-history.ts';
import { SvgPlot, createHoverStore, type PlotLayer } from './svg-plot.tsx';
import { fixedAxis, niceAxis } from './svg-plot-geometry.ts';

// The history chart of every monitor market, the workbench's modules/monitor/app/spread-chart.tsx (4be9aa4) without the
// fills and trade markers: the 7-day average, the 20-day Bollinger bands and the 20-day Z-score panel, computed over the
// whole read (the selected range plus its warmup) before the range is cut. Each market's config names its tabs: Anthropic
// has premium, spread and price; oil has spread and price only. The tab stays page state (the funding panel shares the
// range, not the tab); the indicator toggles are remembered per market in this browser, as the workbench does.
export const date = (t: number | string, full = false) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', month: '2-digit', day: '2-digit', ...(full ? { year: 'numeric' } : {}) }).format(new Date(t));
export const stamp = (t: number | string) => `${date(t, true)} ${new Date(t).toISOString().slice(11, 16)} UTC`;

const options = [
  { key: 'sma', label: '7 日均线', color: 'var(--warning)' },
  { key: 'bands', label: '布林带 · 20 日', color: 'var(--chart-5)' },
  { key: 'zscore', label: 'Z-score · 20 日', color: 'var(--chart-2)' },
] as const;

type Row = IndicatorPoint<Point>;
/** A gap row carries null prices and indicators: lines break there and it shows no tooltip. */
type ChartPoint = Row | ({ time: number } & { [K in Exclude<keyof Row, 'time'>]: null });
const metricValue = (v: number | null | undefined, mode: ChartMode, config: SpreadChartConfig) => v == null ? '—' : mode === 'premium' ? `${v.toFixed(config.digits)}%` : `${v < 0 ? '−' : ''}${config.price(Math.abs(v))}`;
const zValue = (v: number | null | undefined) => v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}σ`;
/** Tab names of the spread modes, e.g. "溢价率或美元价差". */
const spreadTabs = (config: SpreadChartConfig) => config.modes.filter(mode => mode !== 'price').map(mode => config.tabs[mode]).join('或');
const zLayers: PlotLayer[] = [{ kind: 'line', key: 'zscore', color: 'var(--chart-2)', width: 1.7, active: true }];
const zZones = [{ from: -2, to: 2, fill: 'var(--chart-2)', opacity: 0.035 }];
const zeroLine = [{ y: 0, color: 'var(--muted-foreground)', dash: '4 4' }];
const zReferences = [{ y: 0, color: 'var(--muted-foreground)' }, { y: 2, color: 'var(--warning)', dash: '4 4' }, { y: -2, color: 'var(--warning)', dash: '4 4' }];
const premiumFill = <linearGradient id="premiumFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--primary)" stopOpacity={0.21} /><stop offset="100%" stopColor="var(--primary)" stopOpacity={0.01} /></linearGradient>;

function indicatorTooltip(p: ChartPoint, mode: ChartMode, enabled: Toggles, config: SpreadChartConfig, zOnly = false) {
  if (p.adr == null || p.equivalent == null) return null;
  const value = (v: number | null | undefined, as: ChartMode = mode) => metricValue(v, as, config);
  return <div className="chart-tooltip">
    <strong>{stamp(p.time)}</strong>
    {zOnly ? <>
      <div><span>Z-score · 20 日</span><b>{zValue(p.zscore)}</b></div>
      <div><span>20 日均值</span><b>{value(p.basis)}</b></div>
      <div><span>{mode === 'premium' ? config.premiumName : config.spreadName}</span><b>{value(p[mode === 'spread' ? 'spread' : 'premium'])}</b></div>
    </> : <>
      {config.modes.includes('premium') && p.premium != null && <div><span>{config.premiumName}</span><b className={p.premium >= 0 ? 'positive' : 'negative'}>{value(p.premium, 'premium')}</b></div>}
      <div><span>{config.legs.join(' / ')}</span><b>{config.price(p.adr)} / {config.price(p.equivalent)}</b></div>
      <div><span>{config.spreadName}</span><b>{value(p.spread, 'spread')}</b></div>
      {mode !== 'price' && <div className="tooltip-indicators">
        {enabled.sma && <div><span>7 日均线</span><b>{value(p.sma)}</b></div>}
        {enabled.bands && <>
          <div><span>布林上轨</span><b>{value(p.upper)}</b></div>
          <div><span>20 日中轨</span><b>{value(p.basis)}</b></div>
          <div><span>布林下轨</span><b>{value(p.lower)}</b></div>
        </>}
        {enabled.zscore && <div><span>Z-score</span><b>{zValue(p.zscore)}</b></div>}
      </div>}
    </>}
  </div>;
}

export const SpreadChart = memo(function SpreadChart({ data, loading, range, onRangeChange, mode, onModeChange, config }: {
  data: Point[]; loading: boolean; range: number | null; onRangeChange: (range: number | null) => void; mode: ChartMode; onModeChange: (mode: ChartMode) => void; config: SpreadChartConfig;
}) {
  const { intervalMs, periods, preferenceKey } = config;
  // Each market's page has its own chart, so the key never changes under one instance.
  const [enabled, setToggles] = useState(() => savedToggles(preferenceKey));
  const setEnabled = (next: SetStateAction<Toggles>) => {
    const value = typeof next === 'function' ? next(enabled) : next;
    setToggles(value);
    try { localStorage.setItem(preferenceKey, JSON.stringify(value)); } catch { /* the choice only lasts this visit */ }
  };
  const metric: SpreadMetric = mode === 'spread' ? 'spread' : 'premium';
  // Calculate on the whole read first so a one-week range keeps the 20-day warmup read before it.
  const fullHistory = useMemo(() => calculateIndicators(data, metric, periods, intervalMs), [data, metric, periods, intervalMs]);
  const points = useMemo(() => selectRange(fullHistory, range), [fullHistory, range]);
  const latest = points.at(-1);
  const chartPoints = useMemo((): ChartPoint[] => points.flatMap((p, i) => i && p.time - points[i - 1]!.time > intervalMs ? [
    { time: points[i - 1]!.time + intervalMs, adr: null, ordinary: null, equivalent: null, spread: null, premium: null, sma: null, basis: null, upper: null, lower: null, band: null, zscore: null, deviation: null, consecutiveHours: null }, p,
  ] : [p]), [points, intervalMs]);
  // Long ranges plot bucket extrema only; readings and stats keep every bar.
  const sampled = useMemo(() => sampleChartPoints(chartPoints, mode === 'price' ? ['adr', 'equivalent'] : [
    metric, ...(enabled.sma ? ['sma'] as const : []), ...(enabled.bands ? ['basis', 'upper', 'lower'] as const : []), ...(enabled.zscore ? ['zscore'] as const : []),
  ]), [chartPoints, mode, metric, enabled]);
  const step = config.domainStep;
  const domain = useMemo((): [number, number] => {
    let low = 0, high = 0, any = false;
    const add = (value: number) => { if (Number.isFinite(value)) { any = true; low = Math.min(low, value); high = Math.max(high, value); } };
    for (const p of points) { add(p[metric]); if (enabled.sma && p.sma !== null) add(p.sma); if (enabled.bands && p.band) { add(p.band[0]); add(p.band[1]); } }
    if (!any) return [0, step];
    return [Math.floor(low / step) * step, Math.ceil(high / step) * step || step];
  }, [points, metric, enabled.sma, enabled.bands, step]);
  const zDomain = useMemo(() => {
    let low = 0, high = 0;
    for (const p of points) if (p.zscore !== null) { low = Math.min(low, p.zscore); high = Math.max(high, p.zscore); }
    return [Math.min(-3, Math.floor(low)), Math.max(3, Math.ceil(high))] as const;
  }, [points]);
  const priceDomain = useMemo(() => {
    let low = Infinity, high = -Infinity;
    for (const p of points) for (const value of [p.adr, p.equivalent]) if (Number.isFinite(value)) { low = Math.min(low, value); high = Math.max(high, value); }
    return [low, high] as const;
  }, [points]);
  // Premium/spread and z keep their explicit domains; only the price axis widens to round ticks.
  const mainAxis = useMemo(() => mode === 'price' ? niceAxis(priceDomain[0], priceDomain[1]) : fixedAxis(domain[0], domain[1]), [mode, priceDomain, domain]);
  const zAxis = useMemo(() => fixedAxis(zDomain[0], zDomain[1]), [zDomain]);
  const xRange = useMemo(() => points.length ? [points[0]!.time, points.at(-1)!.time] as const : [0, 1] as const, [points]);
  const layers = useMemo((): PlotLayer[] => mode === 'price' ? [
    { kind: 'line', key: 'adr', color: 'var(--chart-2)', width: 2, active: true },
    { kind: 'line', key: 'equivalent', color: 'var(--warning)', width: 2, active: true },
  ] : [
    ...(enabled.bands ? [
      { kind: 'area', key: 'upper', lower: 'lower', fill: 'var(--chart-5)', opacity: 0.09 },
      { kind: 'line', key: 'upper', color: 'var(--chart-5)', width: 1, dash: '4 4' },
      { kind: 'line', key: 'lower', color: 'var(--chart-5)', width: 1, dash: '4 4' },
      { kind: 'line', key: 'basis', color: 'var(--chart-5)', width: 1, dash: '2 5', opacity: 0.6 },
    ] as const : []),
    { kind: 'area', key: metric, lower: 0, fill: 'url(#premiumFill)' },
    { kind: 'line', key: metric, color: 'var(--primary)', width: 2, active: true },
    ...(enabled.sma ? [{ kind: 'line', key: 'sma', color: 'var(--warning)', width: 1.8 }] as const : []),
  ], [mode, metric, enabled.bands, enabled.sma]);
  const [hover] = useState(createHoverStore);
  const zState = !latest || latest.zscore === null ? (latest?.deviation === 0 ? '窗口无波动' : `等待 ${config.bars(periods.bands)}`) : latest.zscore > 2 ? '高于 +2σ' : latest.zscore < -2 ? '低于 −2σ' : '位于 ±2σ 内';
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
    {mode !== 'price' && <>
      <div className="indicator-controls" role="group" aria-label="技术指标开关">
        <span className="indicator-label">技术指标</span>
        {options.map(option => <button type="button" key={option.key} aria-pressed={enabled[option.key]} className={`indicator-toggle ${enabled[option.key] ? 'selected' : ''}`} onClick={() => setEnabled(previous => ({ ...previous, [option.key]: !previous[option.key] }))}>
          <span className="indicator-check" style={{ borderColor: enabled[option.key] ? option.color : undefined, color: option.color }}>{enabled[option.key] && <Check size={12} aria-hidden="true" />}</span>{option.label}
        </button>)}
        <span className="indicator-period">{config.bar}线 · 布林带 ±2σ</span>
      </div>
      <div className="indicator-readings" aria-label={`最新${config.bar}技术指标`}>
        {enabled.sma && <div><span className="reading-label"><i className="sample-line sma-line" />7 日均线</span><strong>{metricValue(latest?.sma, mode, config)}</strong><small>{config.span(periods.sma)} · 平滑短期波动</small></div>}
        {enabled.bands && <div><span className="reading-label"><i className="sample-line band-line" />20 日布林带</span><strong>{latest?.band ? `${metricValue(latest.lower, mode, config)} — ${metricValue(latest.upper, mode, config)}` : '—'}</strong><small>{config.span(periods.bands)}均值 ± 2 倍标准差</small></div>}
        {enabled.zscore && <div><span className="reading-label"><i className="sample-line z-line" />20 日 Z-score</span><strong>{zValue(latest?.zscore)}<span className="z-state">{zState}</span></strong><small>与 20 日均值相差多少个标准差</small></div>}
      </div>
    </>}
    <div className="chart-container">
      {!points.length ? <div className="empty-chart"><Activity size={28} aria-hidden="true" /><p>{loading ? config.emptyText.loading : '暂无可用行情'}</p><span>{loading ? config.emptyText.hint : '点击刷新行情重试'}</span></div>
        : <SvgPlot rows={sampled} hoverRows={chartPoints} xDomain={xRange} yDomain={mainAxis.domain} yTicks={mainAxis.ticks} yTick={tick}
          layers={layers} references={mode === 'price' ? [] : zeroLine} margin={{ top: 25, right: 82, bottom: 36 }} height={300} hover={hover}
          label={mode === 'price' ? `${config.legs.join(' 与 ')} ${config.bar}收盘价格走势` : `${metricName}${config.bar}走势`}
          defs={premiumFill} tooltip={row => indicatorTooltip(row as ChartPoint, mode, enabled, config)} />}
    </div>
    <div className="chart-caption"><span>{mode === 'price' ? <><i className="legend-dot adr" />{config.legs[0]} <i className="legend-dot ordinary" />{config.legs[1]}</> : <><i className="legend-dot premium" />{metricName}<span className="zero-line" />{config.zeroLabel}</>}</span><span>{points.length ? `${date(points[0]!.time, true)} — ${date(points.at(-1)!.time, true)} · ${config.span(points.length)}${sampled.length < chartPoints.length ? ` · 绘图保留极值与缺口共 ${sampled.length.toLocaleString()} 点，读数与统计使用全部记录` : ''}` : `${config.bar}收盘 · UTC`}</span></div>
    {mode !== 'price' && enabled.zscore && <div className="zscore-panel" aria-label="Z-score 历史走势">
      <div className="zscore-heading"><h3><span className="sample-line z-line" />Z-score <span>20 日</span></h3><span>0 = 近期均值 · 虚线 = ±2σ</span></div>
      <div className="zscore-chart">
        {points.some(p => p.zscore !== null) ? <SvgPlot rows={sampled} hoverRows={chartPoints} xDomain={xRange} yDomain={zAxis.domain} yTicks={zAxis.ticks} yTick={v => `${v}σ`}
          layers={zLayers} zones={zZones} references={zReferences} margin={{ top: 12, right: 82, bottom: 36 }} height={160} hover={hover} label={`20 日 Z-score ${config.bar}走势`}
          tooltip={row => indicatorTooltip(row as ChartPoint, mode, enabled, config, true)} /> : <div className="indicator-empty">{latest?.deviation === 0 ? '窗口内价差无波动，Z-score 无法定义。' : `累计 ${config.bars(periods.bands)}后显示 Z-score。`}</div>}
      </div>
    </div>}
    {mode !== 'price' && <details className="indicator-help"><summary><Info size={14} aria-hidden="true" />指标怎么看</summary><div>
      <p><b>7 日均线</b>平滑最近 {config.span(periods.sma)}的价差。<b>布林带</b>以 {config.span(periods.bands)}均值为中轨，上下轨为均值 ± 2 倍总体标准差；带宽反映这段时间的波动幅度。</p>
      <p><b>Z-score =（当前价差 − {config.span(periods.bands)}均值）÷ 标准差。</b>正值表示高于近期均值，负值表示低于近期均值；±2σ 是偏离参考线，不代表价差必然回归。</p>
      <p>7 / 20 日均为自然日{config.bar}窗口，包含当前已收盘的{config.bar}线。{range === null ? '使用完整历史计算，开头不足一个窗口的部分留空' : '连同所选范围之前多读的 21 天一起计算，再按所选时间范围显示'}；窗口不足或跨数据缺口时留空，零波动时 Z-score 留空。{config.modes.includes('premium') ? `切换${spreadTabs(config)}时，所有指标同步换算口径。` : ''}</p>
      <a href="https://www.bollingerbands.com/bollinger-band-rules" target="_blank" rel="noreferrer">布林带官方说明 ↗</a><a href="https://www.itl.nist.gov/div898/software/dataplot/refman2/auxillar/standard.htm" target="_blank" rel="noreferrer">NIST 标准化定义 ↗</a>
    </div></details>}
  </section>;
});
