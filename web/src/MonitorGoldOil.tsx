import { Activity, ArrowUpRight, ChevronDown, Clock3, Info, RefreshCw } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { date, stamp } from './MonitorChart.tsx';
import { AlertSettings } from './MonitorAlerts.tsx';
import { sampleChartPoints } from './monitor-history.ts';
import {
  GOLDOIL_DEFAULT_RANGE, GOLDOIL_INSTRUMENTS, GOLDOIL_QUOTE_MS, GOLDOIL_RANGES, GOLDOIL_UNITS, goldOilGaps, goldOilPoints, goldOilQuote, goldOilStatistics,
  selectGoldOilRange, withGoldOilBreaks, type GoldOilPoint, type GoldOilQuote, type GoldOilRange, type GoldOilType, type GoldOilView,
} from './monitor-goldoil.ts';
import { mainQuoteDisplay, mainQuoteRetention, monitorReadError } from './monitor-display.ts';
import { createHoverStore, SvgPlot, type PlotLayer } from './svg-plot.tsx';
import { niceAxis } from './svg-plot-geometry.ts';
import { goldOilCandles, useMonitorCandles } from './use-monitor-candles.ts';
import { useLiveResource } from './use-live-resource.ts';

// Monitor M-2f: the gold/oil ratio (XAU ÷ CL or XAU ÷ BZ) on the monitor page, after the workbench's
// modules/monitor/app/gold-oil-panel.tsx (584ebc8) and app/gold-oil-svg-chart.tsx (8470785): the oil-leg switch, the ratio and
// price views, the readouts, the range summary and the source notes. Left out for now (docs/monitor.md M-2f): the Bybit
// variant, the funding panels, the monthly bars, the 15-minute table, the exchange comparison, indicators and trade marks;
// the workbench's range slider is replaced by the shared chart's hover. The service collects; the page reads what it saved.
const QUOTE_PATH = '/api/monitor/goldoil/quote';
const READ_TIMEOUT_MS = 10_000;
const EMPTY: GoldOilPoint[] = [];
const VIEWS: { id: GoldOilView; label: string }[] = [{ id: 'ratio', label: '金油比走势' }, { id: 'price', label: '黄金与原油价格' }];
const MARGIN = { top: 25, right: 82, bottom: 36 }, PRICE_MARGIN = { top: 14, right: 82, bottom: 30 };

const format = (value: number | null | undefined, digits = 3) => value == null ? '—' : value.toFixed(digits);
const signed = (value: number | null | undefined, digits = 3) => value == null ? '—' : `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(digits)}`;
const clock = (time: number) => new Date(time).toISOString().slice(11, 16);
const rangeLabel = (days: number | null) => GOLDOIL_RANGES.find(item => item.days === days)?.label ?? `${days} 天`;

function tooltip(point: GoldOilPoint, type: GoldOilType) {
  const instrument = GOLDOIL_INSTRUMENTS[type];
  return <div className="chart-tooltip">
    <strong>{stamp(point.time)}</strong>
    <div><span>金油比 XAU / {instrument.code}</span><b>{format(point.ratio, 4)} {GOLDOIL_UNITS.ratio}</b></div>
    <div><span>黄金 XAUUSDT</span><b>{format(point.xau, 2)} {GOLDOIL_UNITS.xau}</b></div>
    <div><span>{instrument.name} {instrument.symbol}</span><b>{format(point.oil)} {GOLDOIL_UNITS.oil}</b></div>
  </div>;
}

function axis(points: readonly GoldOilPoint[], key: 'ratio' | 'xau' | 'oil', extra: number[] = []) {
  let min = Infinity, max = -Infinity;
  for (const point of points) { const value = point[key]; if (value !== null) { min = Math.min(min, value); max = Math.max(max, value); } }
  for (const value of extra) { min = Math.min(min, value); max = Math.max(max, value); }
  return niceAxis(min, max);
}

export function GoldOilMonitorPanel({ onExpired }: { onExpired: () => void }) {
  const [type, setType] = useState<GoldOilType>('cl');
  const [view, setView] = useState<GoldOilView>('ratio');
  const [requestedRange, setRange] = useState<GoldOilRange>(GOLDOIL_DEFAULT_RANGE);
  const [details, setDetails] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [hover] = useState(createHoverStore);
  const quoteLive = useLiveResource<GoldOilQuote>(QUOTE_PATH, { intervalMs: GOLDOIL_QUOTE_MS, timeoutMs: READ_TIMEOUT_MS, parse: goldOilQuote, retain: mainQuoteRetention, onExpired });
  const candleLive = useMonitorCandles(goldOilCandles, requestedRange, 0, onExpired, quoteLive.error);
  const { data, range } = candleLive;
  const quote = quoteLive.data;
  const quoteDisplay = mainQuoteDisplay(quoteLive, GOLDOIL_QUOTE_MS);
  const error = monitorReadError(candleLive.error, data !== null, '15 分钟 K 线校验失败，将在下一轮自动重试。');
  const loading = refreshing || (quote === null && quoteLive.error === null) || (data === null && candleLive.error === null);
  const { refresh: refreshQuote } = quoteLive, { refresh: refreshCandles } = candleLive;
  const refresh = useCallback(() => {
    setRefreshing(true);
    void Promise.all([refreshQuote(), refreshCandles()]).finally(() => setRefreshing(false));
  }, [refreshQuote, refreshCandles]);

  const instrument = GOLDOIL_INSTRUMENTS[type];
  const all = useMemo(() => data ? goldOilPoints(data, type) : EMPTY, [data, type]);
  const points = useMemo(() => selectGoldOilRange(all, range), [all, range]);
  const stats = useMemo(() => goldOilStatistics(points), [points]);
  const lastClose = useMemo(() => goldOilStatistics(all.slice(-8))?.last ?? null, [all]);
  const gaps = useMemo(() => goldOilGaps(points), [points]);
  const sampled = useMemo(() => withGoldOilBreaks(sampleChartPoints(points, view === 'ratio' ? ['ratio'] : ['xau', 'oil']), points), [points, view]);
  const xDomain = useMemo((): [number, number] => points.length ? [points[0]!.time, points.at(-1)!.time] : [0, 1], [points]);
  const ratioAxis = useMemo(() => axis(points, 'ratio', stats ? [stats.average] : []), [points, stats]);
  const xauAxis = useMemo(() => axis(points, 'xau'), [points]), oilAxis = useMemo(() => axis(points, 'oil'), [points]);
  const ratioLayers = useMemo((): PlotLayer[] => [{ kind: 'line', key: 'ratio', color: 'var(--chart-2)', width: 2, active: true }], []);
  const xauLayers = useMemo((): PlotLayer[] => [{ kind: 'line', key: 'xau', color: 'var(--warning)', width: 2, active: true }], []);
  const oilLayers = useMemo((): PlotLayer[] => [{ kind: 'line', key: 'oil', color: 'var(--chart-5)', width: 2, active: true }], []);
  const average = useMemo(() => stats ? [{ y: stats.average, color: 'var(--muted-foreground)', dash: '4 4' }] : [], [stats]);
  const xTick = range === 1 ? clock : undefined;
  const tip = useCallback((row: { time: number }) => tooltip(row as GoldOilPoint, type), [type]);
  const current = quote ? quote.ratio[type] : undefined;
  const historyPending = data === null && !error;
  const empty = historyPending ? '历史数据尚未就绪，后台采集中…' : error && !data ? '历史行情暂不可用' : data ? '所选区间暂无有效共同历史' : '正在读取所选区间…';

  return <>
    <div className="page-heading detail-toolbar"><div className="toolbar-identity"><div className="eyebrow">GOLD / OIL <span>/</span> XAU ÷ {instrument.code}</div><h1>黄金 / 原油 · 金油比<span className="small-tag">15 分钟</span></h1><p>XAUUSDT 与 {instrument.symbol} 永续合约 · 15 分钟标记价格</p></div><div className="refresh-area"><button type="button" className="refresh-button" onClick={refresh} disabled={loading}><RefreshCw size={15} className={loading ? 'spinning' : ''} aria-hidden="true" />{loading ? '加载行情' : '刷新行情'}</button><span>每 30 秒自动刷新</span></div></div>
    <div className="goldoil-controls"><span>原油合约</span><div className="segmented range-control" role="group" aria-label="原油合约">{(['cl', 'bz'] as const).map(id => <button type="button" key={id} aria-pressed={type === id} className={type === id ? 'active' : ''} onClick={() => setType(id)}>{GOLDOIL_INSTRUMENTS[id].code} · {GOLDOIL_INSTRUMENTS[id].name}</button>)}</div></div>
    <div className="data-status" role="status"><span className="status-left"><Clock3 size={14} aria-hidden="true" />{quoteDisplay.label}{quote && ` ${date(quote.fetchedAt, true)} ${new Date(quote.fetchedAt).toISOString().slice(11, 19)} UTC`}</span><span className="status-right">Binance 标记价 · 金油比单位 {GOLDOIL_UNITS.ratio}</span></div>
    {quoteDisplay.notice && <div className="notice error" role="alert"><Info size={16} aria-hidden="true" />{quoteDisplay.notice}</div>}
    {error && <div className="notice error" role="alert"><Info size={16} aria-hidden="true" />历史行情：{error}{data ? ' 当前保留上次成功加载的数据。' : ''}</div>}
    {candleLive.notice && <div className="notice" role="status"><Info size={16} aria-hidden="true" />{candleLive.notice}</div>}
    {candleLive.cached && data ? <div className="notice"><Info size={16} aria-hidden="true" />图表显示本地缓存，行情采集于 {stamp(data.fetchedAt)}。</div>
      : data?.status === 'snapshot' && <div className="notice"><Info size={16} aria-hidden="true" />K 线采集暂停{data.lastError ? `（${data.lastError}）` : ''}，图表展示 {stamp(data.fetchedAt)} 保存的行情。</div>}
    {gaps.gaps > 0 && <div className="notice"><Info size={16} aria-hidden="true" />所选区间有 {gaps.gaps} 处缺口（共缺 {gaps.missing.toLocaleString()} 根 15 分钟 K 线），图表保留断点；区间统计仅基于可用时段。</div>}
    <div className="hynix-chart-group"><section className="metrics readout" aria-label="金油比报价">
      <article className="metric primary-metric"><div className="metric-label">当前金油比<span className="ticker">XAU / {instrument.code}</span></div><div className="metric-value">{format(current)}</div><div className="metric-foot">较最后收盘 <b>{current !== undefined && lastClose ? signed(current - lastClose.ratio) : '—'}</b> <span>{GOLDOIL_UNITS.ratio}</span></div></article>
      <article className="metric"><div className="metric-label"><span className="legend-dot ordinary" />黄金<span className="ticker">XAUUSDT</span></div><div className="metric-value">{format(quote?.xau.price, 2)}</div><div className="metric-foot">{GOLDOIL_UNITS.xau} <span>· Binance 永续标记价</span></div></article>
      <article className="metric"><div className="metric-label"><span className="legend-dot goldoil-oil" />{instrument.name}<span className="ticker">{instrument.symbol}</span></div><div className="metric-value">{format(quote?.[type].price)}</div><div className="metric-foot">{GOLDOIL_UNITS.oil} <span>· Binance 永续标记价</span></div></article>
      <article className="metric"><div className="metric-label">区间比值变化<span className="ticker">{rangeLabel(range)}</span></div><div className="metric-value">{signed(stats?.change)}</div><div className="metric-foot">{stats ? `${stamp(stats.first.time)} 起 · 相对变化 ${signed(stats.percentChange, 2)}%` : '等待共同历史'}</div></article>
    </section>
    <section className="chart-panel" aria-label="金油比历史走势">
      <div className="chart-heading goldoil-chart-heading">
        <div><div className="section-kicker">GOLD / OIL RATIO</div><h2>{view === 'ratio' ? `黄金相对原油 · XAU / ${instrument.code}` : '黄金与原油标记价格'}</h2><p className="history-timestamp">15 分钟标记价收盘 · 每分钟检查更新{stats ? ` · 最近收盘 ${stamp(stats.last.time + 900_000)}` : ''}</p></div>
        <div className="segmented range-control" role="group" aria-label="时间范围">{GOLDOIL_RANGES.map(item => <button type="button" key={item.label} aria-pressed={requestedRange === item.days} className={requestedRange === item.days ? 'active' : ''} onClick={() => setRange(item.days)}>{item.label}</button>)}</div>
      </div>
      <div className="chart-toolbar">
        <div className="chart-tabs" role="group" aria-label="图表视图">{VIEWS.map(item => <button type="button" key={item.id} aria-pressed={view === item.id} className={view === item.id ? 'active' : ''} onClick={() => setView(item.id)}>{item.label}</button>)}</div>
        <span className="chart-unit">{view === 'ratio' ? `${GOLDOIL_UNITS.ratio} · XAU ÷ ${instrument.code}` : `${GOLDOIL_UNITS.xau} · ${GOLDOIL_UNITS.oil}`}</span>
      </div>
      {!stats ? <div className="chart-container"><div className="empty-chart"><Activity size={28} aria-hidden="true" /><p>{empty}</p><span>Binance XAUUSDT / {instrument.symbol} 同一时段已收盘的 15 分钟标记价</span></div></div>
        : view === 'ratio' ? <div className="chart-container"><SvgPlot rows={sampled} hoverRows={points} xDomain={xDomain} yDomain={ratioAxis.domain} yTicks={ratioAxis.ticks} yTick={v => `${Number(v.toFixed(2))}`} xTick={xTick}
          layers={ratioLayers} references={average} margin={MARGIN} height={300} hover={hover} label={`金油比 XAU / ${instrument.code} 15 分钟走势`} tooltip={tip} /></div>
          : <div className="goldoil-price-charts">
            <div className="goldoil-plot-label"><span className="legend-dot ordinary" />黄金 XAUUSDT<span>{GOLDOIL_UNITS.xau}</span></div>
            <div className="goldoil-price-chart"><SvgPlot rows={sampled} hoverRows={points} xDomain={xDomain} yDomain={xauAxis.domain} yTicks={xauAxis.ticks} yTick={v => `${Number(v.toFixed(0))}`} xTick={xTick}
              layers={xauLayers} margin={PRICE_MARGIN} height={150} hover={hover} label="黄金 XAUUSDT 15 分钟标记价走势" tooltip={tip} /></div>
            <div className="goldoil-plot-label"><span className="legend-dot goldoil-oil" />{instrument.name} {instrument.symbol}<span>{GOLDOIL_UNITS.oil}</span></div>
            <div className="goldoil-price-chart"><SvgPlot rows={sampled} hoverRows={points} xDomain={xDomain} yDomain={oilAxis.domain} yTicks={oilAxis.ticks} yTick={v => `${Number(v.toFixed(1))}`} xTick={xTick}
              layers={oilLayers} margin={PRICE_MARGIN} height={150} hover={hover} label={`${instrument.name} ${instrument.symbol} 15 分钟标记价走势`} tooltip={tip} /></div>
          </div>}
      <div className="chart-caption"><span>{view === 'ratio' ? <><i className="legend-dot adr" />15 分钟金油比 <span className="goldoil-average-line" />区间均值</> : <><i className="legend-dot ordinary" />黄金 <i className="legend-dot goldoil-oil" />{instrument.name}</>}</span><span>{points.length ? `${date(points[0]!.time, true)} — ${date(points.at(-1)!.time, true)} · 有效样本 ${(stats?.count ?? 0).toLocaleString()} / ${points.length.toLocaleString()}${sampled.length < points.length ? ` · 绘图保留极值与缺口，读数与统计使用全部记录` : ''}` : '15 分钟收盘 · UTC'}</span></div>
    </section>
    <p className="chart-footnote"><Info size={13} aria-hidden="true" />缺失时段曲线断开，不补 0 · 采样 15 分钟</p></div>
    <AlertSettings market="goldoil" onExpired={onExpired} />
    <div className="bottom-grid"><section className="table-panel"><div className="section-heading"><h2>区间速览</h2><span>{rangeLabel(range)} · XAU / {instrument.code} · {GOLDOIL_UNITS.ratio}</span></div><div className="table-scroll"><table><thead><tr><th>项目</th><th>金油比</th><th>时刻（UTC）</th></tr></thead><tbody>
      {stats ? <>
        <tr><td>平均金油比</td><td>{format(stats.average)}</td><td>{stats.count.toLocaleString()} 个 15 分钟样本</td></tr>
        <tr><td>最高金油比</td><td>{format(stats.max.ratio)}</td><td>{stamp(stats.max.time)}</td></tr>
        <tr><td>最低金油比</td><td>{format(stats.min.ratio)}</td><td>{stamp(stats.min.time)}</td></tr>
        <tr><td>末值</td><td>{format(stats.last.ratio)}</td><td>{stamp(stats.last.time)}</td></tr>
        <tr><td>区间变化</td><td>{signed(stats.change)}</td><td>{stamp(stats.first.time)} 起 · 相对变化 {signed(stats.percentChange, 2)}%</td></tr>
      </> : <tr><td colSpan={3} className="empty-table">{historyPending ? '正在加载记录…' : '暂无记录'}</td></tr>}
    </tbody></table></div></section>
    <aside className="method-panel"><div className="section-heading"><h2>如何计算</h2><span className="info-icon"><Info size={17} aria-hidden="true" /></span></div><div className="formula"><span>金油比</span><code>XAUUSDT 标记价 ÷ {instrument.symbol} 标记价（{GOLDOIL_UNITS.ratio}）</code></div><p className="method-note">比值上升表示黄金相对原油走强；比值下降表示原油相对黄金走强。实时读数取三条腿的最新标记价，三者源时间相差超过 15 秒的一轮不采用；走势图只用同一 15 分钟两腿都有收盘的时段。</p></aside></div>
    <section className="source-panel"><button type="button" className="source-toggle" aria-expanded={details} onClick={() => setDetails(!details)}><span><Info size={16} aria-hidden="true" />数据来源与覆盖范围</span><ChevronDown size={17} className={details ? 'rotated' : ''} aria-hidden="true" /></button>{details && <div className="source-content"><div><h3>行情来源</h3><p>Binance U 本位永续：XAUUSDT（黄金，USDT/盎司）、CLUSDT（WTI 原油）与 BZUSDT（布伦特原油，USDT/桶）。服务后台每 30 秒读取一次三条腿的标记价（premiumIndex），时间取三条腿中最早的源时间，超过 75 秒视为过期。历史图每 60 秒检查更新，使用已结束的 15 分钟标记价 K 线（markPriceKlines）收盘价；不补齐缺失报价。图中时间为该 15 分钟的起点。</p><a href="https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Mark-Price-Kline-Candlestick-Data" target="_blank" rel="noreferrer">Binance 标记价 K 线说明 <ArrowUpRight size={13} aria-hidden="true" /></a></div><div><h3>历史覆盖</h3><p>共同历史从三个合约中较晚的上架时间开始{data?.metadata.listedAt ? `（${stamp(data.metadata.listedAt)}）` : ''}。{data ? `当前共同可用行情 ${stamp(data.coverage.firstObservation)} 至 ${stamp(data.coverage.lastObservation)}，共 ${data.coverage.observationRows.toLocaleString()} 根 15 分钟 K 线；取数时间：${stamp(data.fetchedAt)}。` : '正在检查历史覆盖范围。'} 后台持续保存到 monitor.sqlite，最多保留 400 天。</p></div></div>}</section>
    <footer><span>GOLD / OIL<span className="footer-divider">·</span>XAU ÷ {instrument.code}</span><span>Binance 永续合约标记价<span className="footer-divider">/</span>所有时间为 UTC</span></footer>
  </>;
}
