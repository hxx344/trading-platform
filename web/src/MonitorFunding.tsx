import { RefreshCw } from 'lucide-react';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { calculateShortSpreadFunding } from '../../src/vendor/oil-market.mjs';
import { analyzeSettledFunding, type FundingChartPoint } from '../../src/vendor/settled-funding.mjs';
import { ApiError } from './api.ts';
import { ranges, sampleChartPoints } from './monitor-history.ts';
import { FUNDING_SCHEDULE, fundingEnd, fundingFirst, hynixFunding, oilFunding, type FundingHistory, type FundingMarket, type FundingRow } from './monitor-funding.ts';
import type { OilQuote } from './monitor-oil.ts';
import { SvgPlot, type PlotLayer } from './svg-plot.tsx';
import { niceAxis, plotValue } from './svg-plot-geometry.ts';
import { useLiveResource } from './use-live-resource.ts';

// The settled funding of the oil and Hynix pages (M-2d): the workbench's modules/monitor/app/settled-funding-panel.tsx
// (8bc3bee) with the configs of oil-funding-panel.tsx and hynix-funding-panel.tsx (8bc3bee) and the 5-minute polling of
// hooks/use-oil-funding.ts / use-funding-history.ts. The service collects the settlements; the page reads what it saved.
// Changed: the feed comes from useLiveResource; a market still backfilling (503) shows as loading; a paused collector
// shows its reason in the status line; the 等数量 / 等名义 choice is kept in this browser only.
const FUNDING_MS = 300_000, FUNDING_TIMEOUT_MS = 30_000;
const BASIS_KEY = 'monitor:oil:basis:v1';
const emptyRows: FundingRow[] = [];
const modes = [{ id: 'rate', label: '小时费率', short: 'shortRate', long: 'longRate' }, { id: 'cumulative', label: '累计资金费', short: 'shortCumulative', long: 'longCumulative' }, { id: 'annualized', label: '累计年化', short: 'shortAnnualized', long: 'longAnnualized' }] as const;
type Mode = typeof modes[number]['id'];
const percent = (value: number | null | undefined, digits = 2) => value == null ? '—' : `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value * 100).toFixed(digits)}%`;
const stamp = (value: number | string | null) => value === null ? '尚无记录' : `${new Date(value).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
const fundingTick = (value: number) => `${Number((value * 100).toPrecision(3))}%`;
const zeroLine = [{ y: 0, color: 'var(--muted-foreground)', dash: '4 4' }];

type SettledFundingFeed = { history: FundingHistory | null; error: string; loading: boolean; refreshing: boolean; refresh: () => void };
type SettledFundingConfig = {
  label: string; short: string; long: string;
  /** "个共同结算小时" / "次共同结算" and the matching missing unit. */
  coverage: { count: string; missing: string; valid: string };
  method: string; details: ReactNode;
};

const CONFIGS: Record<FundingMarket, SettledFundingConfig> = {
  oil: {
    label: '原油历史多空资金费', short: '空布伦特、多 WTI', long: '多布伦特、空 WTI', coverage: { count: '次共同结算', missing: '次结算', valid: '次有效结算' },
    method: '区间累计年化 = 净小时费率之和 ÷ 有效小时数 × 8,760，不复利。历史图按两腿等名义计算；当前预估按所选口径使用实时费率与标记价格。',
    details: <><p>Binance BZUSDT 与 CLUSDT 每 4 小时结算一次。做空净小时率 = (布伦特结算费率 − WTI 结算费率) ÷ 2 ÷ 4；做多取相反数。累计曲线从所选区间重新求和实际结算费率，累计年化使用截至各时点的有效结算次数 × 4 小时。只统计资金费，不含价差盈亏、手续费、滑点和保证金成本。</p><p>当前预估：等数量 = 空 1 桶布伦特、多 1 桶 WTI，分母为两腿标记价之和；等名义 = 两腿 USDT 名义相等，净小时率 = (布伦特小时费率 − WTI 小时费率) ÷ 2。</p><p>服务后台每 5 分钟检查新结算，从 2026-04-01 起回补，保存在 monitor.sqlite，最多保留 400 天。缺少任一腿的结算保留断点，不补零。</p><a href="https://www.binance.com/en/support/faq/detail/360033525031" target="_blank" rel="noreferrer">Binance 资金费规则 ↗</a></>,
  },
  hynix: {
    label: '海力士历史多空资金费', short: '空 ADR、多正股', long: '多 ADR、空正股', coverage: { count: '个共同结算小时', missing: '小时', valid: '个有效小时' },
    method: '区间累计年化 = 净小时费率之和 ÷ 有效小时数 × 8,760，不复利。历史图按两腿等名义计算。',
    details: <><p>做空净小时率 = (SKHY 费率 − SKHX 费率) ÷ 2；做多取相反数。分母是双腿总名义金额，每小时按等名义权重计算。累计曲线从所选区间重新求和，累计年化曲线使用截至各时点的有效小时数。只统计资金费，不含价差盈亏。</p><p>从 2026-07-10 15:00 UTC 的结算开始，与价差图首个完整价格小时结束时间对应。缺少任一腿或整个小时均保留断点，不补零；缺失时的累计值只代表已覆盖部分。服务后台每 5 分钟检查更新，保存在 monitor.sqlite，最多保留 400 天。</p><a href="https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding" target="_blank" rel="noreferrer">Hyperliquid 资金费规则 ↗</a><a href="https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals" target="_blank" rel="noreferrer">历史结算费率接口 ↗</a></>,
  },
};

function fundingTooltip(point: FundingChartPoint, config: SettledFundingConfig) {
  return <div className="chart-tooltip funding-tooltip"><strong>{stamp(point.time)} · 结算</strong>
    {point.shortRate === null ? <p>该时点缺少共同结算数据</p> : <>
      <div><span>做空 · 小时费率</span><b>{percent(point.shortRate, 5)}</b></div><div><span>做多 · 小时费率</span><b>{percent(point.longRate, 5)}</b></div>
      <div><span>做空 / 做多累计</span><b>{percent(point.shortCumulative, 4)} / {percent(point.longCumulative, 4)}</b></div>
      <div><span>做空 / 做多年化</span><b>{percent(point.shortAnnualized)} / {percent(point.longAnnualized)}</b></div>
      <p>从所选区间起点累计 · {point.count} {config.coverage.valid}</p>
    </>}
  </div>;
}

function SettledFundingPanel({ market, range, onRangeChange, feed, current }: { market: FundingMarket; range: number | null; onRangeChange: (range: number | null) => void; feed: SettledFundingFeed; current?: ReactNode }) {
  const { history, error, loading, refreshing, refresh } = feed;
  const config = CONFIGS[market], { intervalMs } = FUNDING_SCHEDULE[market];
  const firstSettlement = fundingFirst(history, market);
  const [mode, setMode] = useState<Mode>('rate');
  const [details, setDetails] = useState(false);
  const detailsId = useId();
  const rows = history?.rows ?? emptyRows;
  const loaded = rows.length > 0;
  const end = fundingEnd(history, market);
  const summary = useMemo(() => analyzeSettledFunding(rows, range, end, { intervalMs, firstSettlement }), [rows, range, end, intervalMs, firstSettlement]);
  const selectedMode = modes.find(item => item.id === mode)!;
  // Long ranges plot bucket extrema and gap edges only; readings and coverage keep every settlement.
  const plotted = useMemo(() => sampleChartPoints(summary.chart, [selectedMode.short, selectedMode.long]), [summary.chart, selectedMode]);
  const dots = summary.missingHours ? 1.5 : summary.count === 1 ? 3 : 0;
  const layers = useMemo((): PlotLayer[] => [
    { kind: 'line', key: selectedMode.short, color: 'var(--positive)', width: 1.8, active: true, dots },
    { kind: 'line', key: selectedMode.long, color: 'var(--chart-2)', width: 1.8, dash: '5 3', active: true, dots },
  ], [selectedMode, dots]);
  const pad = summary.expectedHours === 1 ? intervalMs / 2 : 0;
  const xDomain = useMemo(() => [(summary.firstTime ?? 0) - pad, (summary.lastTime ?? 0) + pad] as const, [summary.firstTime, summary.lastTime, pad]);
  const yAxis = useMemo(() => {
    let low = -0.00001, high = 0.00001;
    for (const row of summary.chart) for (const key of [selectedMode.short, selectedMode.long]) { const value = plotValue(row, key); if (value !== null) { low = Math.min(low, value); high = Math.max(high, value); } }
    return niceAxis(low, high);
  }, [summary.chart, selectedMode]);
  const unit = mode === 'rate' ? '% / 小时' : mode === 'annualized' ? '% / 年 · 简单年化' : '% · 区间累计';
  const snapshot = history?.status === 'snapshot';
  const stale = Boolean(error) || snapshot;
  const readings = [{ key: 'short', name: '做空价差', position: config.short, annualized: summary.shortAnnualized, cumulative: summary.shortCumulative }, { key: 'long', name: '做多价差', position: config.long, annualized: summary.longAnnualized, cumulative: summary.longCumulative }];
  const status = error || (snapshot ? `后台资金费采集暂停${history?.lastError ? `（${history.lastError}）` : ''}，显示上次保存的结算记录。` : '')
    || (history && !history.complete && loaded ? `正在分段回补历史结算，已到 ${stamp(rows.at(-1)!.time)}，每 5 分钟续读一段。` : '');
  return <section className="chart-panel hynix-funding-panel" aria-label={config.label}>
    <div className="chart-heading"><div><div className="section-kicker">SETTLED FUNDING</div><h2>多空价差资金费</h2><p className="history-timestamp">已结算资金费 · 按小时折算 · 两腿等名义金额</p></div><div className="segmented range-control" aria-label="资金费时间范围">{ranges.map(item => <button type="button" key={item.label} aria-pressed={range === item.days} className={range === item.days ? 'active' : ''} onClick={() => onRangeChange(item.days)}>{item.label}</button>)}</div></div>
    <div className="funding-return-readings" aria-label="区间累计资金费与年化">{readings.map(item => <article key={item.key}><div className="funding-return-label"><span><i className={`funding-sample ${item.key}`} />{item.name}</span><small>{item.position}</small></div><span className="funding-return-caption">区间累计年化</span><strong className={item.annualized === null ? '' : item.annualized >= 0 ? 'positive' : 'negative'}>{percent(item.annualized)}</strong><p>区间累计资金费 <b>{percent(item.cumulative, 4)}</b></p></article>)}</div>
    <div className="chart-toolbar"><div className="chart-tabs" aria-label="资金费图表指标">{modes.map(item => <button type="button" key={item.id} aria-pressed={mode === item.id} className={mode === item.id ? 'active' : ''} onClick={() => setMode(item.id)}>{item.label}</button>)}</div><span className="chart-unit">{unit}</span></div>
    <div className="funding-chart-key"><span><i className="funding-sample short" />做空价差</span><span><i className="funding-sample long" />做多价差</span><small>正值收款 · 负值付款</small><span className="funding-mobile-unit">{unit}</span></div>
    <div className="chart-container funding-curve" aria-label={`${selectedMode.label}曲线`}>
      {!summary.count ? <div className="empty-chart" role="status"><p>{loading ? '正在载入历史结算费率…' : '所选区间没有共同结算数据'}</p><span>{error || '仅计算双方都有费率的结算时点'}</span></div> : <SvgPlot rows={plotted} hoverRows={summary.chart} xDomain={xDomain} yDomain={yAxis.domain} yTicks={yAxis.ticks} yTick={fundingTick} layers={layers} references={zeroLine}
        margin={{ top: 15, right: 88, bottom: 38 }} height={280} label={`${selectedMode.label} · 做空与做多价差资金费曲线`} tooltip={row => fundingTooltip(row as FundingChartPoint, config)} />}
    </div>
    <div className="funding-coverage"><span>{!loaded ? '正在检查数据覆盖范围…' : <>{summary.count.toLocaleString()} / {summary.expectedHours.toLocaleString()} {config.coverage.count}{summary.missingHours > 0 ? ` · 缺少 ${summary.missingHours} ${config.coverage.missing}，累计仅含已覆盖数据` : ' · 覆盖完整'}{plotted.length < summary.chart.length ? ` · 绘图保留极值与缺口共 ${plotted.length.toLocaleString()} 点` : ''}</>}</span><span>{stamp(summary.firstTime)} — {stamp(summary.lastTime)}</span></div>
    <div className="funding-history-status"><p className={stale ? 'funding-stale' : ''} role="status">{status || (loaded ? '历史费率已同步' : '正在连接历史资金费接口…')}{loaded && <span> · 获取于 {stamp(history!.fetchedAt)}</span>}</p><button type="button" className="refresh-button" disabled={refreshing} onClick={refresh}><RefreshCw size={14} className={refreshing ? 'spinning' : ''} aria-hidden="true" />{refreshing ? '更新中' : '刷新资金费'}</button></div>
    {current}
    <p className="funding-method">{config.method}</p>
    <button type="button" className="funding-method-toggle" aria-expanded={details} aria-controls={detailsId} onClick={() => setDetails(!details)}>计算口径与数据来源</button>
    {details && <div id={detailsId} className="funding-method-detail">{config.details}</div>}
  </section>;
}

/** One market's settlements every 5 minutes; a backfill still running (503 not_ready) counts as loading, not as a failure;
 * a first round that failed (503 funding_unavailable) shows the service's reason. */
function useFunding(market: FundingMarket, onExpired: () => void): SettledFundingFeed {
  const live = useLiveResource<FundingHistory>(`/api/monitor/${market}/funding`, { intervalMs: FUNDING_MS, timeoutMs: FUNDING_TIMEOUT_MS, parse: market === 'oil' ? oilFunding : hynixFunding, onExpired });
  const [refreshing, setRefreshing] = useState(false);
  const notReady = live.error instanceof ApiError && live.error.status === 503 && live.data === null ? live.error : null;
  const backfilling = notReady?.code === 'not_ready';
  const error = live.error && !backfilling
    ? notReady?.code === 'funding_unavailable' ? `${notReady.message}。价差行情继续更新。`
      : live.error instanceof ApiError ? '历史资金费暂不可用，请稍后刷新。价差行情继续更新。' : '历史资金费校验失败，将在下一轮自动重试。'
    : '';
  const { refresh: reread } = live;
  return {
    history: live.data, error,
    loading: refreshing || live.status === 'loading' || backfilling,
    refreshing: refreshing || live.status === 'loading',
    refresh: () => { setRefreshing(true); void reread().finally(() => setRefreshing(false)); },
  };
}

export type FundingBasis = 'quantity' | 'notional';
const bases: { id: FundingBasis; label: string }[] = [{ id: 'quantity', label: '等数量' }, { id: 'notional', label: '等名义' }];
const tone = (value: number | null | undefined) => value == null || value === 0 ? '' : value > 0 ? 'positive' : 'negative';
const savedBasis = (): FundingBasis => { try { return localStorage.getItem(BASIS_KEY) === 'notional' ? 'notional' : 'quantity'; } catch { return 'quantity'; } };

function CurrentFunding({ quote, basis, onBasisChange }: { quote: OilQuote | null; basis: FundingBasis; onBasisChange: (basis: FundingBasis) => void }) {
  const result = quote ? calculateShortSpreadFunding(quote, basis) : null;
  const legs = quote ? [['布伦特', quote.brent], ['WTI', quote.wti]] as const : [];
  return <div className="funding-current" aria-label="当前预估资金费">
    <div className="funding-current-head"><span>当前预估 · 空布伦特、多 WTI</span><div className="segmented" aria-label="资金费口径">{bases.map(item => <button type="button" key={item.id} aria-pressed={basis === item.id} className={basis === item.id ? 'active' : ''} onClick={() => onBasisChange(item.id)}>{item.label}</button>)}</div></div>
    {result?.hourlyRate == null ? <p>{quote ? '资金费暂不可用 · 等待有效费率和结算周期' : '等待实时报价'}</p> : <dl>
      <div><dt>净小时费率</dt><dd className={tone(result.hourlyRate)}>{percent(result.hourlyRate, 5)} / 小时</dd></div>
      <div><dt>简单年化</dt><dd className={tone(result.hourlyRate)}>{percent(result.annualizedRate, 2)}</dd></div>
      <div><dt>每 1 万 USDT · 每小时</dt><dd className={tone(result.hourlyRate)}>{result.cashflowPer10k! < 0 ? '−' : result.cashflowPer10k! > 0 ? '+' : ''}{Math.abs(result.cashflowPer10k!).toFixed(4)} USDT</dd></div>
      {legs.map(([name, leg]) => <div key={name}><dt>{name}费率</dt><dd>{percent(leg.fundingRate, 5)} / {leg.fundingIntervalHours} h</dd></div>)}
    </dl>}
  </div>;
}

/** The oil page's panel, with the current estimate from the live quote (等数量 / 等名义). */
export function OilFundingPanel({ range, onRangeChange, quote, onExpired }: { range: number | null; onRangeChange: (range: number | null) => void; quote: OilQuote | null; onExpired: () => void }) {
  const feed = useFunding('oil', onExpired);
  const [basis, setBasis] = useState<FundingBasis>(savedBasis);
  const choose = (next: FundingBasis) => { setBasis(next); try { localStorage.setItem(BASIS_KEY, next); } catch { /* this browser keeps no choice */ } };
  return <SettledFundingPanel market="oil" range={range} onRangeChange={onRangeChange} feed={feed} current={<CurrentFunding quote={quote} basis={basis} onBasisChange={choose} />} />;
}

export function HynixFundingPanel({ range, onRangeChange, onExpired }: { range: number | null; onRangeChange: (range: number | null) => void; onExpired: () => void }) {
  return <SettledFundingPanel market="hynix" range={range} onRangeChange={onRangeChange} feed={useFunding('hynix', onExpired)} />;
}
