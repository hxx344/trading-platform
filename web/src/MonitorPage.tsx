import { Activity, ArrowDownRight, ArrowUpRight, ChevronDown, Clock3, Info, MoveRight, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ANTHROPIC_COMPARISON_LEGS, ANTHROPIC_LEGS, anthropicPremium, anthropicSharesPerUnit, perShare, type AnthropicComparisonLeg, type AnthropicShares } from '../../src/vendor/anthropic-market.mjs';
import { api, ApiError } from './api.ts';
import { ANTHROPIC_WARMUP_DAYS, anthropicChartConfig, anthropicPoints, anthropicQuote, dailyPoints, ranges, selectRange, type AnthropicQuote, type ChartMode, type Point } from './monitor-history.ts';
import { candleReadDenied } from './monitor-candle-cache.ts';
import { anthropicCandles, useMonitorCandles } from './use-monitor-candles.ts';
import { SpreadChart, date, stamp } from './MonitorChart.tsx';
import { disabledNotice, parseControl, parseControls, switchFailure, switchLabel, toggleBody, type MonitorControl, type MonitorControls } from './monitor-control.ts';
import { DetailLayout, RelatedPositions } from './MonitorRelated.tsx';
import { linkedMonitorTab, withoutMonitorLink } from './monitor-link.ts';
import { HynixPanel } from './MonitorHynix.tsx';
import { OilPanel } from './MonitorOil.tsx';
import { GoldOilMonitorPanel } from './MonitorGoldOil.tsx';
import { PerpetualPanel } from './MonitorPerpetual.tsx';
import { MovesPanel } from './MonitorMoves.tsx';
import { StatePanel } from './StateViews.tsx';
import { useLiveResource, type LiveResource } from './use-live-resource.ts';
import { shellMarkets, type MonitorScopes, type ShellView } from '../../src/shell-view.ts';
import { mainQuoteDisplay, mainQuoteRetention, monitorReadError } from './monitor-display.ts';
import './monitor.css';

// The market monitor page, laid out as the workbench's Anthropic detail (modules/monitor/app/anthropic-panel.tsx and
// spread-chart.tsx, styles copied in monitor.css) as it shows inside the workbench hub, where the top bar is hidden. Left
// out: the fills on the chart, the shares synced from the trading centre (the service's config gives them). The asset
// ledger's related positions sit in the right column as in the hub (MonitorRelated.tsx), without the ANT pair totals.
// Every read goes through useLiveResource; the service collects in the background, the page only reads what it saved.
export const MONITOR_STATE_PATH = '/api/monitor/state';
export const MONITOR_READ_TIMEOUT_MS = 10_000;
const QUOTE_PATH = '/api/monitor/anthropic/quote';
const STATE_MS = 60_000, CONTROL_TIMEOUT_MS = 15_000, QUOTE_MS = 10_000;

// controls is null from a service older than M-3c (no run switch): the page then shows the markets as before.
export type MonitorState = { markets: string[]; anthropic: { shares: AnthropicShares } | null; controls: MonitorControls | null };

const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
export function parseMonitorState(raw: unknown): MonitorState {
  const value = raw as { markets?: unknown; anthropic?: { shares?: { outstanding?: unknown; diluted?: unknown } }; controls?: unknown } | null;
  if (!value || !Array.isArray(value.markets) || !value.markets.every(market => typeof market === 'string')) throw new Error('行情监控状态格式不正确');
  const controls = parseControls(value.controls, value.markets);
  if (!value.markets.includes('anthropic')) return { markets: value.markets, anthropic: null, controls };
  const shares = value.anthropic?.shares;
  if (!shares || !positive(shares.outstanding) || !positive(shares.diluted)) throw new Error('行情监控状态缺少 Anthropic 股数');
  return { markets: value.markets, anthropic: { shares: { outstanding: shares.outstanding, diluted: shares.diluted } }, controls };
}

const EMPTY_POINTS: Point[] = [];
const usd = (v: number | null | undefined) => v == null ? '—' : `$${v.toFixed(2)}`;
const native = (v: number | null | undefined) => v == null ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: 3 });
const signed = (v: number | null | undefined, suffix = '%') => v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}${suffix}`;
const fundingText = (v: number | null | undefined) => v == null ? '—' : `${v >= 0 ? '' : '−'}${Math.abs(v * 100).toFixed(4)}%`;
const legName = (key: string) => ANTHROPIC_LEGS[key as keyof typeof ANTHROPIC_LEGS]?.name ?? key;

const MARKET_TABS: Record<string, string> = { anthropic: 'Anthropic', oil: '原油', goldoil: '金油比', hynix: '海力士', perpetual: '合约价差', moves: '异动行情' };
/** EQN 异动行情（docs/news.md）：不是服务端的监控市场，没有运行开关；/api/news 有应答时排在最后。 */
const MOVES_TAB = 'moves';
const TAB_KEY = 'monitor:market:v1';
const savedTab = () => { try { return localStorage.getItem(TAB_KEY); } catch { return null; } };
// M-5c: a pair-chart link opens its market over the saved tab, also on back / forward (monitor-link.ts).

export function MonitorPage({ shell, scopes, onControlChanged, onExpired }: {
  shell: LiveResource<ShellView>; scopes: MonitorScopes | null; onControlChanged: (market: string, control: MonitorControl) => Promise<void>; onExpired: () => void;
}) {
  // The first full snapshot must be read after the shell establishes the collector generations.
  const state = useLiveResource<MonitorState>(MONITOR_STATE_PATH, { intervalMs: STATE_MS, timeoutMs: MONITOR_READ_TIMEOUT_MS, parse: parseMonitorState, enabled: scopes !== null, onExpired });
  const [chosen, setChosen] = useState<string | null>(() => linkedMonitorTab(location.href) ?? savedTab());
  const [pending, setPending] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<{ market: string; text: string } | null>(null);
  const { data: current, refresh } = state;
  useEffect(() => {
    const follow = () => { const linked = linkedMonitorTab(location.href); if (linked) setChosen(linked); };
    window.addEventListener('popstate', follow);
    return () => window.removeEventListener('popstate', follow);
  }, []);
  const toggle = useCallback(async (market: string) => {
    const control = current?.controls?.[market];
    if (!current || !control || pending) return;
    setPending(market); setSwitchError(null);
    try {
      const view = parseControl(await api<unknown>(`/api/monitor/${market}/control`, { body: toggleBody(control), timeoutMs: CONTROL_TIMEOUT_MS }));
      await onControlChanged(market, view);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) { onExpired(); return; }
      const answered = error instanceof ApiError;
      setSwitchError({ market, text: switchFailure(answered ? error.status : null, answered ? error.code : undefined, answered ? error.message : null) });
      // A conflict or an unknown outcome: read the switch again so the page shows what the service has.
      if (!answered || error.code === 'control_conflict') void refresh();
    } finally { setPending(null); }
  }, [current, pending, refresh, onControlChanged, onExpired]);
  if (!shell.data && (shell.error || shell.status === 'offline')) return <StatePanel kind="error" title="读取行情监控失败" detail={shell.error?.message ?? '网络离线'} />;
  if (shell.data?.monitor === null) return <StatePanel kind="empty" title="本服务没有启用行情监控" />;
  if (candleReadDenied(state.error) || (!state.data && (state.status === 'error' || state.status === 'offline')))
    return <StatePanel kind="error" title="读取行情监控失败" detail={state.error?.message ?? '网络离线'} />;
  if (!current) return <StatePanel kind="loading" title="加载中…" />;
  const readFailure = state.error?.message ?? shell.error?.message;
  const checking = <StatePanel kind={readFailure ? 'error' : 'loading'} title={readFailure ? '行情开关状态待核对' : '正在核对行情开关…'} detail={readFailure}>{readFailure && <button type="button" onClick={() => { void refresh(); void shell.refresh(); }}>重新读取</button>}</StatePanel>;
  // Markets this page can show, in the service's order; a market a newer service adds stays hidden here.
  const sharedMarkets = current.markets.filter(market => scopes && Object.hasOwn(scopes, market));
  const movesAvailable = shell.data?.modules.news;
  if (!sharedMarkets.length && !(movesAvailable && chosen === MOVES_TAB)
    && shellMarkets.some(market => scopes?.[market] || current.markets.includes(market))) return checking;
  const markets = movesAvailable ? [...sharedMarkets, MOVES_TAB] : sharedMarkets;
  if (!markets.length) return <StatePanel kind="empty" title="本服务没有启用行情监控" />;
  const active = chosen && markets.includes(chosen) ? chosen : markets[0];
  const choose = (market: string) => {
    setChosen(market); try { localStorage.setItem(TAB_KEY, market); } catch { /* the choice only lasts this visit */ }
    if (market !== 'perpetual' && linkedMonitorTab(location.href)) history.replaceState(history.state, '', withoutMonitorLink(location.href));
  };
  const shares = current.anthropic?.shares;
  const control = current.controls?.[active];
  const market = shellMarkets.find(item => item === active);
  const scope = market && scopes?.[market];
  // Either read can arrive first. Only mount this market after its cached generation and full view agree.
  const confirmed = active === MOVES_TAB || (!!scope && scope.enabled === (control?.enabled ?? true) && scope.revision === (control?.revision ?? null));
  const busy = pending === active, failed = switchError?.market === active;
  // The run switch sits on the right of the market tabs, as in the workbench hub; with one market the row shows only it.
  const controls = confirmed && current.controls && active !== MOVES_TAB && <div className="hub-monitor-controls"><span>运行监控</span><button type="button" role="switch" aria-checked={control?.enabled ?? false} aria-busy={busy} aria-label={`${MARKET_TABS[active]}运行监控`} disabled={!control || pending !== null} onClick={() => void toggle(active)}><span>{switchLabel(control, busy, failed)}</span><i aria-hidden="true" /></button></div>;
  const off = control?.enabled === false;
  // Only the shown market subscribes. Switching it off unmounts the panel and its readers.
  return <div className="monitor-desk">
    <div className="site-shell" data-monitor={active}><div className="monitor-main">
      {(markets.length > 1 || controls) && <div className="hub-nav-row">{markets.length > 1 ? <div className="hub-market-nav" role="tablist" aria-label="选择监控市场">{markets.map(market => <button type="button" role="tab" key={market} aria-selected={active === market} data-state={active === market ? 'active' : 'inactive'} className="hub-market-tab" onClick={() => choose(market)}>{MARKET_TABS[market]}</button>)}</div> : <span />}{controls}</div>}
      {failed && <p className="hub-control-notice" role="alert">{switchError.text}</p>}
      {confirmed && control?.error && <p className="hub-control-notice" role="alert">{control.error}</p>}
      {!confirmed ? checking
        : off ? <p className="notice" role="status">{disabledNotice(active)}</p>
        : active === MOVES_TAB ? <MovesPanel onExpired={onExpired} /> : active === 'oil' ? <OilPanel onExpired={onExpired} /> : active === 'goldoil' ? <GoldOilMonitorPanel onExpired={onExpired} /> : active === 'hynix' ? <HynixPanel onExpired={onExpired} /> : active === 'perpetual' ? <PerpetualPanel onExpired={onExpired} /> : shares && <AnthropicPanel outstanding={shares.outstanding} diluted={shares.diluted} onExpired={onExpired} />}
    </div></div>
  </div>;
}

function AnthropicPanel({ outstanding, diluted, onExpired }: { outstanding: number; diluted: number; onExpired: () => void }) {
  const [requestedRange, setRange] = useState<number | null>(7);
  const [leg, setLeg] = useState<AnthropicComparisonLeg>('xyz');
  const [mode, setMode] = useState<ChartMode>('premium');
  const [details, setDetails] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const shares = useMemo<AnthropicShares>(() => ({ outstanding, diluted }), [outstanding, diluted]);
  const quoteLive = useLiveResource<AnthropicQuote>(QUOTE_PATH, { intervalMs: QUOTE_MS, timeoutMs: MONITOR_READ_TIMEOUT_MS, parse: anthropicQuote, retain: mainQuoteRetention, onExpired });
  const candleLive = useMonitorCandles(anthropicCandles, requestedRange, ANTHROPIC_WARMUP_DAYS, onExpired, quoteLive.error);
  const { data, range } = candleLive;
  const quote = quoteLive.data;
  const quoteDisplay = mainQuoteDisplay(quoteLive, QUOTE_MS);
  const error = monitorReadError(candleLive.error, data !== null, '15 分钟 K 线校验失败，将在下一轮自动重试。');
  const loading = refreshing || (quote === null && quoteLive.error === null) || (data === null && candleLive.error === null);
  const { refresh: refreshQuote } = quoteLive, { refresh: refreshCandles } = candleLive;
  const refresh = useCallback(() => {
    setRefreshing(true);
    void Promise.all([refreshQuote(), refreshCandles()]).finally(() => setRefreshing(false));
  }, [refreshQuote, refreshCandles]);
  const sharesNote = `服务配置的完全稀释股数：${shares.diluted}（十亿股）`;
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
  const historyPending = data === null && !error;
  const contract = ANTHROPIC_LEGS[leg], symbol = contract.symbol, rhLeg = leg === 'rh';
  const comparisonShares = anthropicSharesPerUnit(leg, shares);
  return <DetailLayout side={<RelatedPositions market="anthropic" onExpired={onExpired} />}>
      <div className="page-heading detail-toolbar"><div className="toolbar-identity"><div className="eyebrow">ANTHROPIC <span>/</span> {ANTHROPIC_LEGS.binance.symbol} · {contract.label}</div><h1>Anthropic 价差<span className="small-tag">每股口径</span></h1><p>Binance 相对 {contract.label} 的每股溢价 · 15 分钟 K 线</p></div><div className="refresh-area"><div className="segmented" role="group" aria-label="对比合约">{ANTHROPIC_COMPARISON_LEGS.map(key => <button type="button" key={key} aria-pressed={leg === key} className={leg === key ? 'active' : ''} onClick={() => setLeg(key)}>{ANTHROPIC_LEGS[key].name}</button>)}</div><button type="button" className="refresh-button" onClick={refresh} disabled={loading}><RefreshCw size={15} className={loading ? 'spinning' : ''} aria-hidden="true" />{loading ? '加载行情' : '刷新行情'}</button><span>每 10 秒自动刷新</span></div></div>
      <div className="data-status" role="status"><span className="status-left"><Clock3 size={14} aria-hidden="true" />{quoteDisplay.label}{quote && ` ${date(quote.fetchedAt, true)} ${new Date(quote.fetchedAt).toISOString().slice(11, 19)} UTC`}</span><span className="status-right">USD · 每股标记价格</span></div>
      <div className="notice" role="status"><Info size={16} aria-hidden="true" />{sharesNote}</div>
      {quoteDisplay.notice && <div className="notice error" role="alert"><Info size={16} aria-hidden="true" />{quoteDisplay.notice}</div>}
      {legErrors.length > 0 && <div className="notice error" role="alert"><Info size={16} aria-hidden="true" />部分行情缺失：{legErrors.join('；')}。缺失一侧时不计算溢价。</div>}
      {error && <div className="notice error" role="alert"><Info size={16} aria-hidden="true" />历史更新中断：{error}{data ? ' 当前保留上次成功加载的数据。' : ''}</div>}
      {candleErrors.length > 0 && <div className="notice error" role="alert"><Info size={16} aria-hidden="true" />K 线更新失败：{candleErrors.join('；')}。图表保留已保存的收盘价，之后的时段会断开，下一轮自动重试。</div>}
      {candleLive.notice && <div className="notice" role="status"><Info size={16} aria-hidden="true" />{candleLive.notice}</div>}
      {candleLive.cached && data ? <div className="notice"><Info size={16} aria-hidden="true" />图表显示本地缓存，行情采集于 {stamp(data.fetchedAt)}。</div>
        : data?.status === 'snapshot' && <div className="notice"><Info size={16} aria-hidden="true" />K 线采集暂停，图表展示 {stamp(data.fetchedAt)} 保存的行情。</div>}
      <div className="hynix-chart-group"><section className="metrics readout" aria-label="最新溢价概览">
        <article className="metric primary-metric"><div className="metric-label">当前溢价<Activity size={16} aria-hidden="true" /></div><div className={`metric-value ${direction}`}>{signed(premium)}</div><div className="metric-foot">Binance ÷ {contract.name} − 1 <span>· 每股</span></div></article>
        <article className="metric"><div className="metric-label"><span className="legend-dot adr" />Binance<span className="ticker">{ANTHROPIC_LEGS.binance.symbol}</span></div><div className="metric-value">{usd(binance ? perShare('binance', binance.markPx, shares) : null)}</div><div className="metric-foot">标记价 {native(binance?.markPx)} USDT <span>· 资金费 {fundingText(binance?.fundingRate)} / 期</span></div></article>
        <article className="metric"><div className="metric-label"><span className="legend-dot ordinary" />{contract.venue}<span className="ticker">{symbol}</span></div><div className="metric-value">{usd(other ? perShare(leg, other.markPx, shares) : null)}</div><div className="metric-foot">标记价 {native(other?.markPx)}{rhLeg ? ' USDG' : ''}{comparisonShares === 1 ? '' : ` ÷ ${comparisonShares ?? '—'}`} <span>· {rhLeg ? '资金费暂未接入' : `资金费 ${fundingText(other?.fundingRate)} / 小时`}</span></div></article>
        <article className="metric"><div className="metric-label">区间平均溢价<span className="ticker">{ranges.find(r => r.days === range)?.label}</span></div><div className="metric-value">{signed(stats?.mean)}</div><div className="metric-foot">{stats ? `${signed(stats.min)} 至 ${signed(stats.max)}` : '等待行情数据'}</div></article>
      </section>
      <SpreadChart data={allPoints} loading={historyPending} range={range} onRangeChange={setRange} mode={mode} onModeChange={setMode} config={config} />
      <p className="chart-footnote"><Info size={13} aria-hidden="true" />缺失时段曲线断开，不补 0 · 采样 15 分钟 · 每股价格依赖股数假设</p></div>
      <div className="bottom-grid"><section className="table-panel"><div className="section-heading"><h2>近期观察</h2><span>每日最后共同 15 分钟 K 线 · 起点 UTC</span></div><div className="table-scroll"><table><thead><tr><th>日期</th><th>Binance / 股</th><th>{contract.name} / 股</th><th>溢价</th></tr></thead><tbody>{recent.map(p => <tr key={p.time}><td>{date(p.time, true)}<small>{new Date(p.time).toISOString().slice(11, 16)}</small></td><td>{usd(p.adr)}</td><td>{usd(p.equivalent)}</td><td><span className={`premium-pill ${p.premium >= 0 ? 'positive' : 'negative'}`}>{p.premium >= 0 ? <ArrowUpRight size={13} aria-hidden="true" /> : <ArrowDownRight size={13} aria-hidden="true" />}{signed(p.premium)}</span></td></tr>)}{!recent.length && <tr><td colSpan={4} className="empty-table">{historyPending ? '正在加载记录…' : '暂无记录'}</td></tr>}</tbody></table></div></section>
      <aside className="method-panel"><div className="section-heading"><h2>如何比较</h2><span className="info-icon"><Info size={17} aria-hidden="true" /></span></div><div className="conversion"><div><span className="instrument-label">Binance</span><strong>{anthropicSharesPerUnit('binance', shares) ?? '—'} <small>股 / 单位</small></strong><span>{ANTHROPIC_LEGS.binance.symbol} · 1 股</span></div><MoveRight size={22} aria-hidden="true" /><div><span className="instrument-label">{contract.venue}</span><strong>{comparisonShares ?? '—'} <small>股 / 单位</small></strong><span>{symbol} · {leg === 'xyz' ? '1 股' : '完全稀释股数'}</span></div></div><div className="formula"><span>溢价</span><code>Binance 每股 ÷ {contract.name} 每股 − 1</code></div><p className="method-note">各所合约按不同口径报价：Binance ANTUSDT 与 xyz:ANT 为每股价格，io:ANTH 以每 10 亿完全稀释股估值报价；Binance 于 2026-11-17 以 ANTUSDT 取代按每 10 亿流通股估值报价的 ANTHROPICUSDT，此前的历史按 Binance 的合约换算系数 13.116 折算为每股价格；Lighter RH ANTHROPIC 按 Lighter Pre-IPO 规则以假设 10 亿总股本中的 1 股报价（价格 × 10 亿 = 估值），IPO 后按股价 × 完全稀释股数 ÷ 10 亿结算，与 io:ANTH 同口径。{sharesNote}。io:ANTH 与 Lighter RH 的实时与历史每股价格均按这份股数换算，修改服务配置的股数后重新计算；换算基于估算，收敛不保证。正数表示 Binance 较贵。Binance 以 USDT、Hyperliquid 以 USDC 等稳定币、Lighter RH 以 USDG 结算，未做稳定币汇率调整。</p><div className="listing-note"><span>历史起点</span><b>{data ? date(data.coverage.firstObservation, true) : '—'}</b></div></aside></div>
      <section className="source-panel"><button type="button" className="source-toggle" aria-expanded={details} onClick={() => setDetails(!details)}><span><Info size={16} aria-hidden="true" />数据来源与覆盖范围</span><ChevronDown size={17} className={details ? 'rotated' : ''} aria-hidden="true" /></button>{details && <div className="source-content"><div><h3>行情来源</h3><p>Binance U 本位永续合约 ANTUSDT（2026-11-17 10:30 UTC 起成交；此前为已结算的 ANTHROPICUSDT，旧合约停止成交到新合约开始成交之间约 1.5 小时没有 Binance 收盘价）、Hyperliquid 的 xyz:ANT（trade.xyz）、io:ANTH（Entropy），以及 Lighter RH（Robinhood Chain 上的独立 Lighter 盘口，USDG 结算）的 ANTHROPIC。服务后台每 10 秒读取一次实时报价，使用标记价格，时间标注为成功获取时间；某一所读取失败时保留其他交易所报价并标明缺失原因。Binance 资金费为当期费率，Hyperliquid 为每小时费率；Lighter RH 公开接口每分钟只有 60 次额度，后台每轮只读一次报价，资金费暂未接入。历史图每 60 秒检查更新，使用同一 UTC 时段已收盘的 15 分钟 K 线收盘价，只匹配双方都有报价的时段，不补齐缺失报价；图中时间为该 K 线起点。</p><a href="https://www.binance.com/en/futures/ANTUSDT" target="_blank" rel="noreferrer">ANTUSDT <ArrowUpRight size={13} aria-hidden="true" /></a><a className="second-source" href="https://app.hyperliquid.xyz/trade/xyz:ANT" target="_blank" rel="noreferrer">xyz:ANT <ArrowUpRight size={13} aria-hidden="true" /></a><a className="second-source" href="https://app.hyperliquid.xyz/trade/io:ANTH" target="_blank" rel="noreferrer">io:ANTH <ArrowUpRight size={13} aria-hidden="true" /></a><a className="second-source" href="https://robinhoodchain.lighter.xyz" target="_blank" rel="noreferrer">Lighter RH <ArrowUpRight size={13} aria-hidden="true" /></a><a className="second-source" href="https://docs.lighter.xyz/trading/real-world-assets-rwas/pre-ipo-markets" target="_blank" rel="noreferrer">Lighter Pre-IPO 规则 <ArrowUpRight size={13} aria-hidden="true" /></a></div><div><h3>历史覆盖</h3><p>Hyperliquid 只提供最近约 5000 根 15 分钟 K 线，首次采集从 50 天前开始，之后后台持续保存到 monitor.sqlite 并与新 K 线合并，最多保留 400 天。Lighter RH 每次请求最多返回 500 根，回补每分钟最多读 4 页（2000 根），首次补齐 50 天约需 3 轮。{data ? `当前已保存 ${stamp(data.coverage.firstObservation)} 至 ${stamp(data.coverage.lastObservation)}，共 ${data.coverage.rows.toLocaleString()} 个时段；取数时间：${stamp(data.fetchedAt)}。` : '正在检查历史覆盖范围。'}</p></div></div>}</section>
      <footer><span>ANTHROPIC / SPREAD<span className="footer-divider">·</span>同口径，看溢价。</span><span>Binance · Hyperliquid · Lighter RH 永续合约数据<span className="footer-divider">/</span>所有时间为 UTC</span></footer>
  </DetailLayout>;
}
