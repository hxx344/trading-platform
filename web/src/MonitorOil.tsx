import { Activity, ArrowDownRight, ArrowUpRight, ChevronDown, Clock3, Info, MoveRight, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { OIL_CANDLE_MS, oilSpread } from '../../src/vendor/oil-market.mjs';
import { ApiError } from './api.ts';
import { SpreadChart, date, stamp } from './MonitorChart.tsx';
import { dailyPoints, rangeGaps, ranges, selectRange, type ChartMode, type Point } from './monitor-history.ts';
import { OIL_SPREAD_CHART, OIL_WARMUP_DAYS, coversOilRange, oilHistory, oilQuote, type OilHistory, type OilQuote } from './monitor-oil.ts';
import { ExchangeComparison } from './MonitorExchanges.tsx';
import { OilFundingPanel } from './MonitorFunding.tsx';
import { useLiveResource } from './use-live-resource.ts';

// The oil spread on the monitor page, laid out as the workbench's modules/monitor/app/oil-panel.tsx (9c652bc) inside the
// hub, where its top bar is hidden; the exchange comparison (M-2c) sits under the chart, the settled funding (M-2d) under
// it, sharing the chart's range. Left out: the fills and the hub summary card. The service collects; the page reads what it saved.
const QUOTE_PATH = '/api/monitor/oil/quote', CANDLE_PATH = '/api/monitor/oil/candles';
const QUOTE_MS = 10_000, CANDLE_MS = 60_000, READ_TIMEOUT_MS = 10_000;
// The complete history is up to 400 days of 15-minute rows, a few megabytes.
const CANDLE_TIMEOUT_MS = 30_000;
const EMPTY_POINTS: Point[] = [];
const usdt = (v: number | null | undefined) => v == null ? '—' : v.toFixed(3);
const signedUsdt = (v: number | null | undefined) => v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(3)}`;
const observation = (value: string) => value.length > 10 ? stamp(value) : value.replaceAll('-', '.');
const notReady = (error: Error | null) => error instanceof ApiError && error.status === 503;
const readable = (error: Error, fallback: string) => /[一-鿿]/.test(error.message) ? error.message : fallback;

export function OilPanel({ onExpired }: { onExpired: () => void }) {
  const [range, setRange] = useState<number | null>(7);
  const [mode, setMode] = useState<ChartMode>('spread');
  const [details, setDetails] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Read only the selected range plus the indicator warmup; 全部 reads the complete history.
  const windowDays = range === null ? null : range + OIL_WARMUP_DAYS;
  const quoteLive = useLiveResource<OilQuote>(QUOTE_PATH, { intervalMs: QUOTE_MS, timeoutMs: READ_TIMEOUT_MS, parse: oilQuote, onExpired });
  const candleLive = useLiveResource<OilHistory>(windowDays === null ? CANDLE_PATH : `${CANDLE_PATH}?days=${windowDays}`, { intervalMs: CANDLE_MS, timeoutMs: CANDLE_TIMEOUT_MS, parse: oilHistory, onExpired });
  // A newly chosen range reads its own window; until it arrives, an earlier read that already covers it stays on screen.
  const [kept, setKept] = useState<OilHistory | null>(null);
  useEffect(() => { if (candleLive.data) setKept(candleLive.data); }, [candleLive.data]);
  const data = candleLive.data ?? (kept && coversOilRange(kept, range) ? kept : null);
  const quote = quoteLive.data;
  const quoteFailed = quoteLive.error !== null && !(quote === null && notReady(quoteLive.error));
  const quoteError = quoteFailed ? '实时报价更新失败，10 秒后自动重试；请留意报价获取时间。'
    : quote?.status === 'snapshot' ? `后台尚未取得新报价${quote.lastError ? `（${quote.lastError}）` : ''}，显示上次保存的数据；请留意采集时间。` : '';
  const historyFailed = candleLive.error !== null && !(data === null && notReady(candleLive.error));
  const error = historyFailed && candleLive.error ? readable(candleLive.error, '15 分钟 K 线校验失败，将在下一轮自动重试。') : '';
  const loading = refreshing || (quote === null && quoteLive.error === null) || (data === null && candleLive.error === null);
  const { refresh: refreshQuote } = quoteLive, { refresh: refreshCandles } = candleLive;
  const refresh = useCallback(() => {
    setRefreshing(true);
    void Promise.all([refreshQuote(), refreshCandles()]).finally(() => setRefreshing(false));
  }, [refreshQuote, refreshCandles]);
  const chartPoints = data ? data.points : EMPTY_POINTS;
  const points = useMemo(() => selectRange(chartPoints, range), [chartPoints, range]);
  const stats = useMemo(() => {
    if (!points.length) return null;
    let sum = 0, min = Infinity, max = -Infinity;
    for (const { spread } of points) { sum += spread; min = Math.min(min, spread); max = Math.max(max, spread); }
    return { mean: sum / points.length, min, max };
  }, [points]);
  const recent = useMemo(() => dailyPoints(points).slice(-6).reverse(), [points]);
  // Current metrics always come from the live quote, never from the last candle close.
  const spread = quote ? oilSpread(quote.brent.markPx, quote.wti.markPx) : null;
  const direction = spread === null || spread >= 0 ? 'positive' : 'negative';
  // Counted on the bars the range shows: a windowed read's metadata also counts the indicator warmup before it.
  const missing = useMemo(() => rangeGaps(points, OIL_CANDLE_MS).missing, [points]);
  const historyPending = data === null && !historyFailed;
  return <>
    <div className="page-heading detail-toolbar"><div className="toolbar-identity"><div className="eyebrow">BRENT / WTI <span>/</span> BZUSDT · CLUSDT</div><h1>原油价差<span className="small-tag">4 月 1 日以来</span></h1><p>布伦特 − WTI · Binance 永续合约 15 分钟 K 线</p></div><div className="refresh-area"><button type="button" className="refresh-button" onClick={refresh} disabled={loading}><RefreshCw size={15} className={loading ? 'spinning' : ''} aria-hidden="true" />{loading ? '加载行情' : '刷新行情'}</button><span>每 10 秒自动刷新</span></div></div>
    <div className="data-status" role="status"><span className="status-left"><Clock3 size={14} aria-hidden="true" />{quote ? `${quoteError ? '实时更新中断 · 上次获取' : '实时报价 · 获取于'} ${date(quote.fetchedAt, true)} ${new Date(quote.fetchedAt).toISOString().slice(11, 19)} UTC` : quoteFailed ? '实时报价暂不可用 · 每 10 秒自动重试' : '正在获取实时报价 · 每 10 秒自动刷新'}</span><span className="status-right">USDT · 每桶标记价格</span></div>
    {quoteError && <div className="notice error" role="alert"><Info size={16} aria-hidden="true" />{quoteError}</div>}
    {error && <div className="notice error" role="alert"><Info size={16} aria-hidden="true" />历史更新中断：{error}{data ? ' 当前保留上次成功加载的数据。' : ''}</div>}
    {data?.status === 'snapshot' && <div className="notice"><Info size={16} aria-hidden="true" />K 线采集暂停{data.lastError ? `（${data.lastError}）` : ''}，图表展示 {stamp(data.fetchedAt)} 保存的行情。</div>}
    {missing > 0 && <div className="notice"><Info size={16} aria-hidden="true" />缺少 {missing.toLocaleString()} 根共同 15 分钟 K 线，缺口处曲线断开。</div>}
    <div className="hynix-chart-group"><section className="metrics readout" aria-label="最新价差概览">
      <article className="metric primary-metric"><div className="metric-label">当前价差<Activity size={16} aria-hidden="true" /></div><div className={`metric-value ${direction}`}>{signedUsdt(spread)}</div><div className="metric-foot">布伦特 − WTI <span>· USDT / 桶</span></div></article>
      <article className="metric"><div className="metric-label"><span className="legend-dot adr" />布伦特<span className="ticker">BZUSDT</span></div><div className="metric-value">{usdt(quote?.brent.markPx)}</div><div className="metric-foot">标记价格 <span>· USDT / 桶</span></div></article>
      <article className="metric"><div className="metric-label"><span className="legend-dot ordinary" />WTI<span className="ticker">CLUSDT</span></div><div className="metric-value">{usdt(quote?.wti.markPx)}</div><div className="metric-foot">标记价格 <span>· USDT / 桶</span></div></article>
      <article className="metric"><div className="metric-label">区间平均价差<span className="ticker">{ranges.find(r => r.days === range)?.label}</span></div><div className="metric-value">{signedUsdt(stats?.mean)}</div><div className="metric-foot">{stats ? `${signedUsdt(stats.min)} 至 ${signedUsdt(stats.max)} USDT / 桶` : '等待行情数据'}</div></article>
    </section>
    <SpreadChart data={chartPoints} loading={historyPending} range={range} onRangeChange={setRange} mode={mode} onModeChange={setMode} config={OIL_SPREAD_CHART} />
    <p className="chart-footnote"><Info size={13} aria-hidden="true" />缺失时段曲线断开，不补 0 · 采样 15 分钟</p></div>
    <ExchangeComparison market="oil" onExpired={onExpired} />
    <OilFundingPanel range={range} onRangeChange={setRange} quote={quote} onExpired={onExpired} />
    <div className="bottom-grid"><section className="table-panel"><div className="section-heading"><h2>近期观察</h2><span>每日最后共同 15 分钟 K 线 · 起点 UTC</span></div><div className="table-scroll"><table><thead><tr><th>日期</th><th>布伦特</th><th>WTI</th><th>价差</th></tr></thead><tbody>{recent.map(p => <tr key={p.time}><td>{date(p.time, true)}<small>{new Date(p.time).toISOString().slice(11, 16)}</small></td><td>{usdt(p.adr)}</td><td>{usdt(p.equivalent)}</td><td><span className={`premium-pill ${p.spread >= 0 ? 'positive' : 'negative'}`}>{p.spread >= 0 ? <ArrowUpRight size={13} aria-hidden="true" /> : <ArrowDownRight size={13} aria-hidden="true" />}{signedUsdt(p.spread)}</span></td></tr>)}{!recent.length && <tr><td colSpan={4} className="empty-table">{historyPending ? '正在加载记录…' : '暂无记录'}</td></tr>}</tbody></table></div></section>
    <aside className="method-panel"><div className="section-heading"><h2>如何比较</h2><span className="info-icon"><Info size={17} aria-hidden="true" /></span></div><div className="conversion"><div><span className="instrument-label">布伦特原油</span><strong>1 <small>桶</small></strong><span>BZUSDT · Binance</span></div><MoveRight size={22} aria-hidden="true" /><div><span className="instrument-label">WTI 原油</span><strong>1 <small>桶</small></strong><span>CLUSDT · Binance</span></div></div><div className="formula"><span>价差</span><code>布伦特 − WTI（USDT / 桶）</code></div><p className="method-note">正数表示布伦特较贵。做空价差对应空布伦特、多 WTI；等桶数配仓时，每桶价格损益等于价差变化，资金费另行计算。两条行情均为 USDT 计价的永续合约，价差包含合约基差。</p><div className="listing-note"><span>历史起点</span><b>2026.04.01</b></div></aside></div>
    <section className="source-panel"><button type="button" className="source-toggle" aria-expanded={details} onClick={() => setDetails(!details)}><span><Info size={16} aria-hidden="true" />数据来源与覆盖范围</span><ChevronDown size={17} className={details ? 'rotated' : ''} aria-hidden="true" /></button>{details && <div className="source-content"><div><h3>行情来源</h3><p>Binance U 本位永续合约 BZUSDT（布伦特）与 CLUSDT（WTI），按 USDT/桶报价。服务后台每 10 秒读取一次实时报价，使用标记价格，时间标注为交易所给出的报价时刻；两腿报价时刻相差超过 15 秒时本轮作废。历史图每 60 秒检查更新，使用两合约同一 UTC 时段已收盘的 15 分钟 K 线收盘价，仅匹配双方都有报价的时段；不补齐缺失报价。图中时间为该 K 线起点。</p><a href="https://www.binance.com/en/futures/BZUSDT" target="_blank" rel="noreferrer">BZUSDT <ArrowUpRight size={13} aria-hidden="true" /></a><a className="second-source" href="https://www.binance.com/en/futures/CLUSDT" target="_blank" rel="noreferrer">CLUSDT <ArrowUpRight size={13} aria-hidden="true" /></a><a className="second-source" href="https://www.binance.com/en/support/faq/detail/360033525031" target="_blank" rel="noreferrer">资金费规则 <ArrowUpRight size={13} aria-hidden="true" /></a></div><div><h3>历史覆盖</h3><p>从 2026 年 4 月 1 日回补，后台持续保存到 monitor.sqlite 并与新 K 线合并展示，最多保留 400 天。{data ? `当前共同可用行情 ${observation(data.coverage.firstCommonObservation)} 至 ${observation(data.coverage.lastCommonObservation)}，共 ${data.coverage.pairedObservationRows.toLocaleString()} 根；取数时间：${stamp(data.fetchedAt)}。` : '正在检查历史覆盖范围。'} 合约换月按 Binance 展期规则处理。</p><a href="https://www.binance.com/en/support/faq/detail/0675298e133640f48aab7e3bb4ae1d38" target="_blank" rel="noreferrer">展期规则 <ArrowUpRight size={13} aria-hidden="true" /></a><a className="second-source" href="https://www.binance.com/en/support/announcement/detail/e7a10ca855524655ab3dea73add40ef4" target="_blank" rel="noreferrer">合约规格 <ArrowUpRight size={13} aria-hidden="true" /></a></div></div>}</section>
    <footer><span>OIL / SPREAD<span className="footer-divider">·</span>同口径，看价差。</span><span>Binance 永续合约数据<span className="footer-divider">/</span>所有时间为 UTC</span></footer>
  </>;
}
