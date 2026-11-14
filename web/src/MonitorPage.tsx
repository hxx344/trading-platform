import { Activity, ArrowDownRight, ArrowUpRight, ChevronDown, Clock3, Info, MoveRight, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ANTHROPIC_COMPARISON_LEGS, ANTHROPIC_LEGS, anthropicPremium, anthropicSharesPerUnit, perShare, type AnthropicComparisonLeg, type AnthropicShares } from '../../src/vendor/anthropic-market.mjs';
import { ApiError } from './api.ts';
import { ANTHROPIC_WARMUP_DAYS, anthropicChartConfig, anthropicHistory, anthropicPoints, anthropicQuote, coversAnthropicRange, dailyPoints, ranges, selectRange, type AnthropicHistory, type AnthropicQuote, type ChartMode, type Point } from './monitor-history.ts';
import { SpreadChart, date, stamp } from './MonitorChart.tsx';
import { OilPanel } from './MonitorOil.tsx';
import { StatePanel } from './StateViews.tsx';
import { useLiveResource } from './use-live-resource.ts';
import './monitor.css';

// The market monitor page, laid out as the workbench's Anthropic detail (modules/monitor/app/anthropic-panel.tsx and
// spread-chart.tsx, styles copied in monitor.css) as it shows inside the workbench hub, where the top bar is hidden. Left
// out: the fills on the chart, the indicators, the shares synced from the trading centre (the service's config gives them).
// Every read goes through useLiveResource; the service collects in the background, the page only reads what it saved.
export const MONITOR_STATE_PATH = '/api/monitor/state';
export const MONITOR_READ_TIMEOUT_MS = 10_000;
const QUOTE_PATH = '/api/monitor/anthropic/quote', CANDLE_PATH = '/api/monitor/anthropic/candles';
const STATE_MS = 60_000, QUOTE_MS = 10_000, CANDLE_MS = 60_000;
// The complete history is up to 400 days of 15-minute rows, a few megabytes.
const CANDLE_TIMEOUT_MS = 30_000;

export type MonitorState = { markets: string[]; anthropic: { shares: AnthropicShares } | null };

const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
export function parseMonitorState(raw: unknown): MonitorState {
  const value = raw as { markets?: unknown; anthropic?: { shares?: { outstanding?: unknown; diluted?: unknown } } } | null;
  if (!value || !Array.isArray(value.markets) || !value.markets.every(market => typeof market === 'string')) throw new Error('行情监控状态格式不正确');
  if (!value.markets.includes('anthropic')) return { markets: value.markets, anthropic: null };
  const shares = value.anthropic?.shares;
  if (!shares || !positive(shares.outstanding) || !positive(shares.diluted)) throw new Error('行情监控状态缺少 Anthropic 股数');
  return { markets: value.markets, anthropic: { shares: { outstanding: shares.outstanding, diluted: shares.diluted } } };
}

const EMPTY_POINTS: Point[] = [];
const usd = (v: number | null | undefined) => v == null ? '—' : `$${v.toFixed(2)}`;
const native = (v: number | null | undefined) => v == null ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: 3 });
const signed = (v: number | null | undefined, suffix = '%') => v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}${suffix}`;
const fundingText = (v: number | null | undefined) => v == null ? '—' : `${v >= 0 ? '' : '−'}${Math.abs(v * 100).toFixed(4)}%`;
const legName = (key: string) => ANTHROPIC_LEGS[key as keyof typeof ANTHROPIC_LEGS]?.name ?? key;
// 503 means the service has not collected anything yet: still loading rather than failed.
const notReady = (error: Error | null) => error instanceof ApiError && error.status === 503;
// Validation errors are internal English text; only the service's (Chinese) messages are shown as they are.
const readable = (error: Error, fallback: string) => /[一-鿿]/.test(error.message) ? error.message : fallback;

const MARKET_TABS: Record<string, string> = { anthropic: 'Anthropic', oil: '原油' };
const TAB_KEY = 'monitor:market:v1';
const savedTab = () => { try { return localStorage.getItem(TAB_KEY); } catch { return null; } };

export function MonitorPage({ onExpired }: { onExpired: () => void }) {
  const state = useLiveResource<MonitorState>(MONITOR_STATE_PATH, { intervalMs: STATE_MS, timeoutMs: MONITOR_READ_TIMEOUT_MS, parse: parseMonitorState, onExpired });
  const [chosen, setChosen] = useState<string | null>(savedTab);
  if (!state.data) return state.status === 'error' || state.status === 'offline'
    ? <StatePanel kind="error" title="读取行情监控失败" detail={state.error?.message ?? '网络离线'} />
    : <StatePanel kind="loading" title="加载中…" />;
  // Markets this page can show, in the service's order; a market a newer service adds stays hidden here.
  const markets = state.data.markets.filter(market => market in MARKET_TABS);
  if (!markets.length) return <StatePanel kind="empty" title="本服务没有启用行情监控" />;
  const active = chosen && markets.includes(chosen) ? chosen : markets[0];
  const choose = (market: string) => { setChosen(market); try { localStorage.setItem(TAB_KEY, market); } catch { /* the choice only lasts this visit */ } };
  const shares = state.data.anthropic?.shares;
  // Only the shown market reads: switching remounts its panel, which reads again at once.
  return <div className="monitor-desk">
    <div className="site-shell" data-monitor={active}><div className="monitor-main">
      {markets.length > 1 && <div className="hub-nav-row"><div className="hub-market-nav" role="tablist" aria-label="选择监控市场">{markets.map(market => <button type="button" role="tab" key={market} aria-selected={active === market} data-state={active === market ? 'active' : 'inactive'} className="hub-market-tab" onClick={() => choose(market)}>{MARKET_TABS[market]}</button>)}</div></div>}
      {active === 'oil' ? <OilPanel onExpired={onExpired} /> : shares && <AnthropicPanel outstanding={shares.outstanding} diluted={shares.diluted} onExpired={onExpired} />}
    </div></div>
  </div>;
}

function AnthropicPanel({ outstanding, diluted, onExpired }: { outstanding: number; diluted: number; onExpired: () => void }) {
  const [range, setRange] = useState<number | null>(7);
  const [leg, setLeg] = useState<AnthropicComparisonLeg>('xyz');
  const [mode, setMode] = useState<ChartMode>('premium');
  const [details, setDetails] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const shares = useMemo<AnthropicShares>(() => ({ outstanding, diluted }), [outstanding, diluted]);
  const windowDays = range === null ? null : range + ANTHROPIC_WARMUP_DAYS;
  const quoteLive = useLiveResource<AnthropicQuote>(QUOTE_PATH, { intervalMs: QUOTE_MS, timeoutMs: MONITOR_READ_TIMEOUT_MS, parse: anthropicQuote, onExpired });
  const candleLive = useLiveResource<AnthropicHistory>(windowDays === null ? CANDLE_PATH : `${CANDLE_PATH}?days=${windowDays}`, { intervalMs: CANDLE_MS, timeoutMs: CANDLE_TIMEOUT_MS, parse: anthropicHistory, onExpired });
  // A newly chosen range reads its own window; until it arrives, an earlier read that already covers it stays on screen.
  const [kept, setKept] = useState<AnthropicHistory | null>(null);
  useEffect(() => { if (candleLive.data) setKept(candleLive.data); }, [candleLive.data]);
  const data = candleLive.data ?? (kept && coversAnthropicRange(kept, range) ? kept : null);
  const quote = quoteLive.data;
  const quoteFailed = quoteLive.error !== null && !(quote === null && notReady(quoteLive.error));
  const quoteError = quoteFailed ? '实时报价更新失败，10 秒后自动重试；请留意报价获取时间。' : quote?.status === 'snapshot' ? '后台尚未取得新报价，显示上次保存的数据；请留意采集时间。' : '';
  const historyFailed = candleLive.error !== null && !(data === null && notReady(candleLive.error));
  const error = historyFailed && candleLive.error ? readable(candleLive.error, '15 分钟 K 线校验失败，将在下一轮自动重试。') : '';
  const loading = refreshing || (quote === null && quoteLive.error === null) || (data === null && candleLive.error === null);
  const { refresh: refreshQuote } = quoteLive, { refresh: refreshCandles } = candleLive;
  const refresh = useCallback(() => {
    setRefreshing(true);
    void Promise.all([refreshQuote(), refreshCandles()]).finally(() => setRefreshing(false));
  }, [refreshQuote, refreshCandles]);
  const sharesNote = `服务配置股数：流通 ${shares.outstanding}、完全稀释 ${shares.diluted}（十亿股）`;
  const config = useMemo(() => anthropicChartConfig(leg), [leg]);
  const allPoints = useMemo(() => data ? anthropicPoints(data.rows, leg, shares) : EMPTY_POINTS, [data, leg, shares]);
  const binance = quote?.binance ?? null, other = quote?.[leg] ?? null;
  const premium = anthropicPremium(binance?.markPx, other?.markPx, leg, shares);
  const points = useMemo(() => selectRange(allPoints, range), [allPoints, range]);
  const stats = useMemo(() => {
    if (!points.length) return null;
    let sum = 0, min = Infinity, max = -Infinity;
    for (const { premium: value } of points) { sum += value; min = Math.min(min, value); max = Math.max(max, value); }
    return { mean: sum / points.length, min, max };
  }, [points]);
  const recent = useMemo(() => dailyPoints(points).slice(-6).reverse(), [points]);
  const direction = premium === null || premium >= 0 ? 'positive' : 'negative';
  const legErrors = quote ? Object.entries(quote.errors).map(([key, message]) => `${legName(key)}：${message}`) : [];
  // Candle reads fail per leg; only the legs this chart compares matter here.
  const candleErrors = data ? (['binance', leg] as const).flatMap(key => data.errors[key] ? [`${legName(key)}：${data.errors[key]}`] : []) : [];
  const historyPending = data === null && !historyFailed;
  const contract = ANTHROPIC_LEGS[leg], symbol = contract.symbol, rhLeg = leg === 'rh';
  const comparisonShares = anthropicSharesPerUnit(leg, shares);
  return <>
      <div className="page-heading detail-toolbar"><div className="toolbar-identity"><div className="eyebrow">ANTHROPIC <span>/</span> ANTHROPICUSDT · {contract.label}</div><h1>Anthropic 价差<span className="small-tag">每股口径</span></h1><p>Binance 相对 {contract.label} 的每股溢价 · 15 分钟 K 线</p></div><div className="refresh-area"><div className="segmented" role="group" aria-label="对比合约">{ANTHROPIC_COMPARISON_LEGS.map(key => <button type="button" key={key} aria-pressed={leg === key} className={leg === key ? 'active' : ''} onClick={() => setLeg(key)}>{ANTHROPIC_LEGS[key].name}</button>)}</div><button type="button" className="refresh-button" onClick={refresh} disabled={loading}><RefreshCw size={15} className={loading ? 'spinning' : ''} aria-hidden="true" />{loading ? '加载行情' : '刷新行情'}</button><span>每 10 秒自动刷新</span></div></div>
      <div className="data-status" role="status"><span className="status-left"><Clock3 size={14} aria-hidden="true" />{quote ? `${quoteError ? '实时更新中断 · 上次获取' : '实时报价 · 获取于'} ${date(quote.fetchedAt, true)} ${new Date(quote.fetchedAt).toISOString().slice(11, 19)} UTC` : quoteFailed ? '实时报价暂不可用 · 每 10 秒自动重试' : '正在获取实时报价 · 每 10 秒自动刷新'}</span><span className="status-right">USD · 每股标记价格</span></div>
      <div className="notice" role="status"><Info size={16} aria-hidden="true" />{sharesNote}</div>
      {quoteError && <div className="notice error" role="alert"><Info size={16} aria-hidden="true" />{quoteError}</div>}
      {legErrors.length > 0 && <div className="notice error" role="alert"><Info size={16} aria-hidden="true" />部分行情缺失：{legErrors.join('；')}。缺失一侧时不计算溢价。</div>}
      {error && <div className="notice error" role="alert"><Info size={16} aria-hidden="true" />历史更新中断：{error}{data ? ' 当前保留上次成功加载的数据。' : ''}</div>}
      {candleErrors.length > 0 && <div className="notice error" role="alert"><Info size={16} aria-hidden="true" />K 线更新失败：{candleErrors.join('；')}。图表保留已保存的收盘价，之后的时段会断开，下一轮自动重试。</div>}
      {data?.status === 'snapshot' && <div className="notice"><Info size={16} aria-hidden="true" />K 线采集暂停，图表展示 {stamp(data.fetchedAt)} 保存的行情。</div>}
      <div className="hynix-chart-group"><section className="metrics readout" aria-label="最新溢价概览">
        <article className="metric primary-metric"><div className="metric-label">当前溢价<Activity size={16} aria-hidden="true" /></div><div className={`metric-value ${direction}`}>{signed(premium)}</div><div className="metric-foot">Binance ÷ {contract.name} − 1 <span>· 每股</span></div></article>
        <article className="metric"><div className="metric-label"><span className="legend-dot adr" />Binance<span className="ticker">ANTHROPICUSDT</span></div><div className="metric-value">{usd(binance ? perShare('binance', binance.markPx, shares) : null)}</div><div className="metric-foot">标记价 {native(binance?.markPx)} USDT ÷ {shares.outstanding} <span>· 资金费 {fundingText(binance?.fundingRate)} / 期</span></div></article>
        <article className="metric"><div className="metric-label"><span className="legend-dot ordinary" />{contract.venue}<span className="ticker">{symbol}</span></div><div className="metric-value">{usd(other ? perShare(leg, other.markPx, shares) : null)}</div><div className="metric-foot">标记价 {native(other?.markPx)}{rhLeg ? ' USDG' : ''}{comparisonShares === 1 ? '' : ` ÷ ${comparisonShares ?? '—'}`} <span>· {rhLeg ? '资金费暂未接入' : `资金费 ${fundingText(other?.fundingRate)} / 小时`}</span></div></article>
        <article className="metric"><div className="metric-label">区间平均溢价<span className="ticker">{ranges.find(r => r.days === range)?.label}</span></div><div className="metric-value">{signed(stats?.mean)}</div><div className="metric-foot">{stats ? `${signed(stats.min)} 至 ${signed(stats.max)}` : '等待行情数据'}</div></article>
      </section>
      <SpreadChart data={allPoints} loading={historyPending} range={range} onRangeChange={setRange} mode={mode} onModeChange={setMode} config={config} />
      <p className="chart-footnote"><Info size={13} aria-hidden="true" />缺失时段曲线断开，不补 0 · 采样 15 分钟 · 每股价格依赖股数假设</p></div>
      <div className="bottom-grid"><section className="table-panel"><div className="section-heading"><h2>近期观察</h2><span>每日最后共同 15 分钟 K 线 · 起点 UTC</span></div><div className="table-scroll"><table><thead><tr><th>日期</th><th>Binance / 股</th><th>{contract.name} / 股</th><th>溢价</th></tr></thead><tbody>{recent.map(p => <tr key={p.time}><td>{date(p.time, true)}<small>{new Date(p.time).toISOString().slice(11, 16)}</small></td><td>{usd(p.adr)}</td><td>{usd(p.equivalent)}</td><td><span className={`premium-pill ${p.premium >= 0 ? 'positive' : 'negative'}`}>{p.premium >= 0 ? <ArrowUpRight size={13} aria-hidden="true" /> : <ArrowDownRight size={13} aria-hidden="true" />}{signed(p.premium)}</span></td></tr>)}{!recent.length && <tr><td colSpan={4} className="empty-table">{historyPending ? '正在加载记录…' : '暂无记录'}</td></tr>}</tbody></table></div></section>
      <aside className="method-panel"><div className="section-heading"><h2>如何比较</h2><span className="info-icon"><Info size={17} aria-hidden="true" /></span></div><div className="conversion"><div><span className="instrument-label">Binance</span><strong>{shares.outstanding} <small>股 / 单位</small></strong><span>ANTHROPICUSDT · 流通股数</span></div><MoveRight size={22} aria-hidden="true" /><div><span className="instrument-label">{contract.venue}</span><strong>{comparisonShares ?? '—'} <small>股 / 单位</small></strong><span>{symbol} · {leg === 'xyz' ? '1 股' : '完全稀释股数'}</span></div></div><div className="formula"><span>溢价</span><code>Binance 每股 ÷ {contract.name} 每股 − 1</code></div><p className="method-note">各所合约按不同口径报价：Binance 以每 10 亿流通股估值报价，io:ANTH 以每 10 亿完全稀释股估值报价，xyz:ANT 为每股价格；Lighter RH ANTHROPIC 按 Lighter Pre-IPO 规则以假设 10 亿总股本中的 1 股报价（价格 × 10 亿 = 估值），IPO 后按股价 × 完全稀释股数 ÷ 10 亿结算，与 io:ANTH 同口径。{sharesNote}。实时与历史每股价格均按这份股数换算，修改服务配置的股数后重新计算；换算基于估算，收敛不保证。正数表示 Binance 较贵。Binance 以 USDT、Hyperliquid 以 USDC 等稳定币、Lighter RH 以 USDG 结算，未做稳定币汇率调整。</p><div className="listing-note"><span>历史起点</span><b>{data ? date(data.coverage.firstObservation, true) : '—'}</b></div></aside></div>
      <section className="source-panel"><button type="button" className="source-toggle" aria-expanded={details} onClick={() => setDetails(!details)}><span><Info size={16} aria-hidden="true" />数据来源与覆盖范围</span><ChevronDown size={17} className={details ? 'rotated' : ''} aria-hidden="true" /></button>{details && <div className="source-content"><div><h3>行情来源</h3><p>Binance U 本位永续合约 ANTHROPICUSDT、Hyperliquid 的 xyz:ANT（trade.xyz）、io:ANTH（Entropy），以及 Lighter RH（Robinhood Chain 上的独立 Lighter 盘口，USDG 结算）的 ANTHROPIC。服务后台每 10 秒读取一次实时报价，使用标记价格，时间标注为成功获取时间；某一所读取失败时保留其他交易所报价并标明缺失原因。Binance 资金费为当期费率，Hyperliquid 为每小时费率；Lighter RH 公开接口每分钟只有 60 次额度，后台每轮只读一次报价，资金费暂未接入。历史图每 60 秒检查更新，使用同一 UTC 时段已收盘的 15 分钟 K 线收盘价，只匹配双方都有报价的时段，不补齐缺失报价；图中时间为该 K 线起点。</p><a href="https://www.binance.com/en/futures/ANTHROPICUSDT" target="_blank" rel="noreferrer">ANTHROPICUSDT <ArrowUpRight size={13} aria-hidden="true" /></a><a className="second-source" href="https://app.hyperliquid.xyz/trade/xyz:ANT" target="_blank" rel="noreferrer">xyz:ANT <ArrowUpRight size={13} aria-hidden="true" /></a><a className="second-source" href="https://app.hyperliquid.xyz/trade/io:ANTH" target="_blank" rel="noreferrer">io:ANTH <ArrowUpRight size={13} aria-hidden="true" /></a><a className="second-source" href="https://robinhoodchain.lighter.xyz" target="_blank" rel="noreferrer">Lighter RH <ArrowUpRight size={13} aria-hidden="true" /></a><a className="second-source" href="https://docs.lighter.xyz/trading/real-world-assets-rwas/pre-ipo-markets" target="_blank" rel="noreferrer">Lighter Pre-IPO 规则 <ArrowUpRight size={13} aria-hidden="true" /></a></div><div><h3>历史覆盖</h3><p>Hyperliquid 只提供最近约 5000 根 15 分钟 K 线，首次采集从 50 天前开始，之后后台持续保存到 monitor.sqlite 并与新 K 线合并，最多保留 400 天。Lighter RH 每次请求最多返回 500 根，回补每分钟最多读 4 页（2000 根），首次补齐 50 天约需 3 轮。{data ? `当前已保存 ${stamp(data.coverage.firstObservation)} 至 ${stamp(data.coverage.lastObservation)}，共 ${data.coverage.rows.toLocaleString()} 个时段；取数时间：${stamp(data.fetchedAt)}。` : '正在检查历史覆盖范围。'}</p></div></div>}</section>
      <footer><span>ANTHROPIC / SPREAD<span className="footer-divider">·</span>同口径，看溢价。</span><span>Binance · Hyperliquid · Lighter RH 永续合约数据<span className="footer-divider">/</span>所有时间为 UTC</span></footer>
  </>;
}
