import { Activity, ArrowDownRight, ArrowUpRight, ChevronDown, Clock3, Info, MoveRight, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError } from './api.ts';
import { SpreadChart, date, stamp } from './MonitorChart.tsx';
import { dailyPoints, ranges, selectRange, type ChartMode, type Point } from './monitor-history.ts';
import { HYNIX_SPREAD_CHART, HYNIX_WARMUP_DAYS, coversHynixRange, hynixHistory, hynixQuote, type HynixHistory, type HynixQuote } from './monitor-hynix.ts';
import { ExchangeComparison } from './MonitorExchanges.tsx';
import { HynixFundingPanel } from './MonitorFunding.tsx';
import { useLiveResource } from './use-live-resource.ts';

// The Hynix ADR premium on the monitor page, laid out as the workbench's modules/monitor/app/dashboard.tsx (9c652bc) inside
// the hub, where its top bar is hidden; the exchange comparison (M-2c) sits under the chart, the settled funding (M-2d)
// under it, sharing the chart's range. Left out: the indicators (M-2e), the fills and the hub summary card. The service collects; the page reads what it saved.
const QUOTE_PATH = '/api/monitor/hynix/quote', CANDLE_PATH = '/api/monitor/hynix/candles';
const QUOTE_MS = 10_000, CANDLE_MS = 60_000, READ_TIMEOUT_MS = 10_000;
// The complete history is at most 400 days of hourly rows, well under a megabyte.
const CANDLE_TIMEOUT_MS = 30_000;
const EMPTY_POINTS: Point[] = [];
const money = (v: number | undefined) => v === undefined ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
const percent = (v: number | undefined) => v === undefined ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
const signedMoney = (v: number | undefined) => v === undefined ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${money(Math.abs(v))}`;
const notReady = (error: Error | null) => error instanceof ApiError && error.status === 503;
const readable = (error: Error, fallback: string) => /[一-鿿]/.test(error.message) ? error.message : fallback;

export function HynixPanel({ onExpired }: { onExpired: () => void }) {
  const [range, setRange] = useState<number | null>(null);
  const [mode, setMode] = useState<ChartMode>('premium');
  const [details, setDetails] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Read only the selected range plus the indicator warmup; 全部 (the workbench's default here) reads the complete history.
  const windowDays = range === null ? null : range + HYNIX_WARMUP_DAYS;
  const quoteLive = useLiveResource<HynixQuote>(QUOTE_PATH, { intervalMs: QUOTE_MS, timeoutMs: READ_TIMEOUT_MS, parse: hynixQuote, onExpired });
  const candleLive = useLiveResource<HynixHistory>(windowDays === null ? CANDLE_PATH : `${CANDLE_PATH}?days=${windowDays}`, { intervalMs: CANDLE_MS, timeoutMs: CANDLE_TIMEOUT_MS, parse: hynixHistory, onExpired });
  // A newly chosen range reads its own window; until it arrives, an earlier read that already covers it stays on screen.
  const [kept, setKept] = useState<HynixHistory | null>(null);
  useEffect(() => { if (candleLive.data) setKept(candleLive.data); }, [candleLive.data]);
  const data = candleLive.data ?? (kept && coversHynixRange(kept, range) ? kept : null);
  const quote = quoteLive.data;
  const quoteFailed = quoteLive.error !== null && !(quote === null && notReady(quoteLive.error));
  const quoteError = quoteFailed ? '实时报价更新失败，10 秒后自动重试；请留意报价获取时间。'
    : quote?.status === 'snapshot' ? `后台尚未取得新报价${quote.lastError ? `（${quote.lastError}）` : ''}，显示上次保存的数据；请留意采集时间。` : '';
  const historyFailed = candleLive.error !== null && !(data === null && notReady(candleLive.error));
  const error = historyFailed && candleLive.error ? readable(candleLive.error, '小时 K 线校验失败，将在下一轮自动重试。') : '';
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
    for (const { premium } of points) { sum += premium; min = Math.min(min, premium); max = Math.max(max, premium); }
    return { mean: sum / points.length, min, max };
  }, [points]);
  const recent = useMemo(() => dailyPoints(points).slice(-6).reverse(), [points]);
  // Current metrics always come from the live quote, never from the last hourly close.
  const current = quote ?? undefined;
  const direction = !current || current.premium >= 0 ? 'positive' : 'negative';
  const historyPending = data === null && !historyFailed;
  return <>
    <div className="page-heading detail-toolbar"><div className="toolbar-identity"><div className="eyebrow">SK HYNIX <span>/</span> 000660 · SKHY</div><h1>海力士 ADR 价差<span className="small-tag">上市以来</span></h1><p>正股与 ADR 同口径比较 · Hyperliquid 永续合约</p></div><div className="refresh-area"><button type="button" className="refresh-button" onClick={refresh} disabled={loading}><RefreshCw size={15} className={loading ? 'spinning' : ''} aria-hidden="true" />{loading ? '加载行情' : '刷新行情'}</button><span>每 10 秒自动刷新</span></div></div>
    <div className="data-status" role="status"><span className="status-left"><Clock3 size={14} aria-hidden="true" />{quote ? `${quoteError ? '实时更新中断 · 上次获取' : '实时报价 · 获取于'} ${date(quote.fetchedAt, true)} ${new Date(quote.fetchedAt).toISOString().slice(11, 19)} UTC` : quoteFailed ? '实时报价暂不可用 · 每 10 秒自动重试' : '正在获取实时报价 · 每 10 秒自动刷新'}</span><span className="status-right">USD · 1 股正股 = 10 份 ADR</span></div>
    {quoteError && <div className="notice error" role="alert"><Info size={16} aria-hidden="true" />{quoteError}</div>}
    {error && <div className="notice error" role="alert"><Info size={16} aria-hidden="true" />历史行情：{error}{data ? ' 当前保留上次成功加载的数据。' : ''}</div>}
    {data?.status === 'snapshot' && <div className="notice"><Info size={16} aria-hidden="true" />K 线采集暂停{data.lastError ? `（${data.lastError}）` : ''}，图表展示 {stamp(data.fetchedAt)} 保存的行情。</div>}
    {data?.warnings.map(w => <div className="notice" key={w}><Info size={16} aria-hidden="true" />{w}</div>)}
    <div className="hynix-chart-group"><section className="metrics readout" aria-label="最新价差概览">
      <article className="metric primary-metric"><div className="metric-label">当前 ADR 溢价率<Activity size={16} aria-hidden="true" /></div><div className={`metric-value ${direction}`}>{percent(current?.premium)}</div><div className="metric-foot">每份价差 <b className={direction}>{signedMoney(current?.spread)}</b></div></article>
      <article className="metric"><div className="metric-label"><span className="legend-dot adr" />ADR 价格<span className="ticker">SKHY</span></div><div className="metric-value">{money(current?.adr)}</div><div className="metric-foot">1 份 ADR <span>· xyz:SKHY</span></div></article>
      <article className="metric"><div className="metric-label"><span className="legend-dot ordinary" />正股折算价格<span className="ticker">SKHX</span></div><div className="metric-value">{money(current?.equivalent)}</div><div className="metric-foot">正股 {money(current?.ordinary)} <span>÷ 10</span></div></article>
      <article className="metric"><div className="metric-label">区间平均溢价<span className="ticker">{ranges.find(r => r.days === range)?.label}</span></div><div className="metric-value">{percent(stats?.mean)}</div><div className="metric-foot">{stats ? `${percent(stats.min)} 至 ${percent(stats.max)}` : '等待行情数据'}</div></article>
    </section>
    <SpreadChart data={chartPoints} loading={historyPending} range={range} onRangeChange={setRange} mode={mode} onModeChange={setMode} config={HYNIX_SPREAD_CHART} />
    <p className="chart-footnote"><Info size={13} aria-hidden="true" />缺失时段曲线断开，不补 0 · 采样 1 小时</p></div>
    <ExchangeComparison market="hynix" onExpired={onExpired} />
    <HynixFundingPanel range={range} onRangeChange={setRange} onExpired={onExpired} />
    <div className="bottom-grid"><section className="table-panel"><div className="section-heading"><h2>近期观察</h2><span>每日最后共同小时 · 起点 UTC</span></div><div className="table-scroll"><table><thead><tr><th>日期</th><th>ADR</th><th>正股 ÷ 10</th><th>每份价差</th><th>溢价率</th></tr></thead><tbody>{recent.map(p => <tr key={p.time}><td>{date(p.time, true)}<small>{new Date(p.time).toISOString().slice(11, 16)}</small></td><td>{money(p.adr)}</td><td>{money(p.equivalent)}</td><td>{signedMoney(p.spread)}</td><td><span className={`premium-pill ${p.premium >= 0 ? 'positive' : 'negative'}`}>{p.premium >= 0 ? <ArrowUpRight size={13} aria-hidden="true" /> : <ArrowDownRight size={13} aria-hidden="true" />}{percent(p.premium)}</span></td></tr>)}{!recent.length && <tr><td colSpan={5} className="empty-table">{historyPending ? '正在加载记录…' : '暂无记录'}</td></tr>}</tbody></table></div></section>
    <aside className="method-panel"><div className="section-heading"><h2>如何比较</h2><span className="info-icon"><Info size={17} aria-hidden="true" /></span></div><div className="conversion"><div><span className="instrument-label">韩国正股</span><strong>1 <small>股</small></strong><span>000660 · KRX</span></div><MoveRight size={22} aria-hidden="true" /><div><span className="instrument-label">美国 ADR</span><strong>10 <small>份</small></strong><span>SKHY · NASDAQ</span></div></div><div className="formula"><span>ADR 溢价率</span><code>(ADR ÷ (正股美元价 ÷ 10) − 1) × 100%</code></div><p className="method-note">正数表示 ADR 溢价，负数表示折价。两条行情均来自 Hyperliquid 永续合约；价差包含合约基差，并非交易所现货价差。</p><div className="listing-note"><span>ADR 首次交易</span><b>2026.07.10</b></div></aside></div>
    <section className="source-panel"><button type="button" className="source-toggle" aria-expanded={details} onClick={() => setDetails(!details)}><span><Info size={16} aria-hidden="true" />数据来源与覆盖范围</span><ChevronDown size={17} className={details ? 'rotated' : ''} aria-hidden="true" /></button>{details && <div className="source-content"><div><h3>行情来源</h3><p>Hyperliquid HIP-3 / XYZ：xyz:SKHX（正股美元代理）与 xyz:SKHY（ADR 代理）。SKHX 已包含韩元兑美元换算。服务后台每 10 秒读取一次实时报价，使用 allMids 中间价（空盘口时为最近成交价），时间标注为服务成功获取的时间。历史图每 60 秒检查更新，使用已结束的 1 小时 K 线收盘价，仅匹配双方都有报价的时段；不补齐缺失报价。图中时间为该小时起点。</p><a href="https://docs.trade.xyz/perpetuals/specifications-and-schedules/specification-index" target="_blank" rel="noreferrer">XYZ 合约说明 <ArrowUpRight size={13} aria-hidden="true" /></a></div><div><h3>历史覆盖</h3><p>ADR 于 2026 年 7 月 10 日以 SKHYV 首次交易。小时图从当日 14:00 UTC 开始，排除上市前的合约交易。{data ? `当前共同可用行情 ${stamp(data.coverage.firstObservation)} 至 ${stamp(data.coverage.lastObservation)}，共 ${data.coverage.rows.toLocaleString()} 小时；取数时间：${stamp(data.fetchedAt)}。` : '正在检查历史覆盖范围。'} 接口只保留最近 5,000 根小时线；后台持续保存到 monitor.sqlite 并与新行情合并展示，最多保留 400 天。休市时永续合约仍可交易。</p><a href="https://depositaryreceipts.citi.com/adr/guides/pgm_dispabook.aspx?cusip=78392B206&pageId=15&subpageID=111" target="_blank" rel="noreferrer">Citi ADR 换算比例 <ArrowUpRight size={13} aria-hidden="true" /></a><a className="second-source" href="https://news.skhynix.com/en/skhynix-lists-adrs-on-nasdaq/" target="_blank" rel="noreferrer">上市公告 <ArrowUpRight size={13} aria-hidden="true" /></a></div></div>}</section>
    <footer><span>HYNIX / SPREAD<span className="footer-divider">·</span>同口径，看价差。</span><span>Hyperliquid 永续合约数据<span className="footer-divider">/</span>所有时间为 UTC</span></footer>
  </>;
}
