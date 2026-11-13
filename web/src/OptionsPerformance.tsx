// The options page's 收益 tab, after the workbench Greeks page's pane-perf (modules/greeks/app/static/index.html) and
// performance.js (renderPerformance, performanceChart), 0c5a219: the toolbar, the four figures of the groups held to
// expiry, their combined curve, then every opening as an expandable row with its amounts, its sampled path and fills.
// Differences: the curves are the service's SvgPlot, broken where the service marks a gap (thinned points can no
// longer show one by their spacing); a group's curve is drawn only while it is open; the read runs every 30 s while
// this tab is shown and keeps the last result when it fails; with no data yet the currency is USDC (docs/frontend.md, G2b).
import { useMemo } from 'react';
import { SvgPlot, type PlotLayer } from './svg-plot.tsx';
import { niceAxis } from './svg-plot-geometry.ts';
import { useLiveResource } from './use-live-resource.ts';
import {
  PERFORMANCE_PATH, coverageLine, groupLabel, markedRows, money, performanceCurrencies, performanceStatus, plotRows, plotTick, selectedSeries, utcMinute, type PlotRow,
} from './options-form.ts';
import type { PerformanceGroup, PerformancePoint, PerformanceSeriesPoint, PerformanceView } from './options-types.ts';

const READ_MS = 30_000;
const READ_TIMEOUT_MS = 10_000;
const number = (value: number, digits: number): string => value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const amount = (value: number | null | undefined): string => value === null || value === undefined ? '--' : money(value);
const tone = (value: number | null | undefined): string => value === null || value === undefined ? '' : value >= 0 ? 'profit' : 'loss';

/** sampled: the real samples behind the curve, counted by the service before it thinned the points it sends. */
function PerformanceChart<T extends PerformancePoint>({ points, sampled, value, holding, currency, describe }: { points: readonly T[]; sampled: number; value: (point: T) => number; holding: boolean; currency: string; describe: (point: T) => string }) {
  const plot = useMemo(() => plotRows(points, value), [points, value]);
  const axis = useMemo(() => { const values = [0, ...plot.hover.map(row => row.value as number)]; return niceAxis(Math.min(...values), Math.max(...values)); }, [plot]);
  const marked = useMemo(() => markedRows(plot.hover), [plot]);
  if (!points.length) return <div className="empty">{holding ? '暂无持仓期间采样。开始采集后显示真实盈亏路径，历史缺失时段无法还原。' : '暂无已核实的到期结束组合。提前平仓和持仓中的组合仅在下方展示。'}</div>;
  const first = points[0]!.time, last = points.at(-1)!.time;
  const terminalOnly = sampled === 0;
  return <>
    <div className="performance-plot">
      <SvgPlot rows={plot.rows} hoverRows={plot.hover} xDomain={[first, last]} yDomain={axis.domain} yTicks={axis.ticks} yTick={tick => number(tick, Math.abs(tick) < 10 ? 2 : 0)} xTick={plotTick(last - first)}
        layers={LAYERS} references={[{ y: 0, color: 'var(--text-tertiary)', dash: '5 4' }]} margin={{ top: 24, right: 64, bottom: 32 }} height={280}
        label={`${holding ? '单次组合持仓盈亏采样曲线' : '仅到期结束组合综合收益采样曲线'}，横轴为实际时间。${sampled} 个真实采样点，缺失区间断开显示。`}
        overlay={scales => marked.map(row => <circle key={row.time} className="performance-point" cx={scales.x(row.time)} cy={scales.y(row.value as number)} r={row.point?.terminal ? 4 : 2} />)}
        tooltip={row => { const point = (row as PlotRow).point as T | null; return point ? <span className="performance-tip">{describe(point)} {currency}</span> : null; }} />
    </div>
    <p className="performance-sample-note">{sampled} 个真实采样点 · UTC{plot.gaps ? ` · ${plot.gaps} 段采样缺口已断开` : ''}{terminalOnly ? ' · 历史无持仓采样，仅显示结束净收益点' : ''}</p>
  </>;
}

const LAYERS: PlotLayer[] = [{ kind: 'line', key: 'value', color: 'var(--accent)', width: 2.5, active: true }];
const seriesValue = (point: PerformanceSeriesPoint) => point.cumulative;
const sampleValue = (point: PerformancePoint) => point.pnl;

function GroupRow({ group, sampleSeconds, open, onToggle }: { group: PerformanceGroup; sampleSeconds: number; open: boolean; onToggle: (id: string, open: boolean) => void }) {
  const metric = (label: string, value: number | null, className = '') => <div><span>{label}</span><strong className={className}>{amount(value)}</strong></div>;
  return <details className="performance-group" open={open} onToggle={event => { if (event.currentTarget.open !== open) onToggle(group.id, event.currentTarget.open); }}>
    <summary>
      <span className="performance-identity"><strong>{group.id}</strong><small>{utcMinute(group.openedAt)} UTC · {group.legCount} 腿</small></span>
      <span className="performance-result"><span className="source-tag">{groupLabel(group)}</span><b className={tone(group.netPnl)}>{amount(group.netPnl)}</b><small>{group.status === 'closed' ? '组合净收益' : '已实现部分'}</small></span>
    </summary>
    <div className="performance-detail">
      <div className="performance-metrics">{metric('开仓权利金净额', group.openPremium)}{metric('开仓手续费', group.openFee)}{metric('平仓手续费', group.closeFee)}{metric('交割手续费', group.deliveryFee)}{metric('已实现净收益', group.netPnl, tone(group.netPnl))}{metric('剩余持仓浮盈亏（未扣费）', group.floatingPnl, tone(group.floatingPnl))}</div>
      <p className="performance-detail-note">{group.status === 'closed' ? `结束于 ${utcMinute(group.closedAt)} UTC · ` : ''}{group.source === 'exchange_closed_positions' ? '收益已按交易所平仓／交割记录核实，包含手续费。' : '根据实际成交逐笔匹配开平仓，手续费按匹配数量分摊。'}{group.eligible ? ' 本组已纳入综合统计。' : ` 本组不纳入综合统计：${group.exclusionReason || '尚未核实到期结束'}。`}</p>
      {group.issues.length ? <p className="pp-warning">{group.issues.join('；')}</p> : null}
      <h4 className="performance-sample-title">持仓盈亏过程<span>每 {sampleSeconds} 秒采样 · 已扣已知交易费用</span></h4>
      {open ? <div className="pp-chart"><PerformanceChart points={group.samples} sampled={group.sampleCount} value={sampleValue} holding currency={group.currency} describe={point => `${group.id} · ${utcMinute(point.time)} · ${point.terminal ? '结束净收益' : '真实采样'} ${money(point.pnl)}`} /></div> : null}
      <div className="performance-fills">{group.fills.length ? group.fills.map(fill => <div key={fill.execId}><strong>{fill.symbol}</strong><span>{fill.side} · {number(fill.execQty, 4)} BTC × {money(fill.execPrice)}</span><span>手续费 {number(fill.execFee, 6)} {fill.feeCurrency}</span><small>{utcMinute(fill.execTime)} UTC</small></div>) : <p className="muted">逐笔成交历史尚未补齐，已核实的交割收益以交易所记录为准。</p>}</div>
    </div>
  </details>;
}

/** What the viewer picked on this tab; the options page keeps it, so leaving the tab and coming back restores it. */
export interface PerformanceChoice { currency: string | null; expanded: ReadonlySet<string> }

export function PerformancePane({ onExpired, choice, onChoice }: { onExpired: () => void; choice: PerformanceChoice; onChoice: (next: PerformanceChoice) => void }) {
  const read = useLiveResource<PerformanceView>(PERFORMANCE_PATH, { intervalMs: READ_MS, timeoutMs: READ_TIMEOUT_MS, onExpired });
  const view = read.data;
  const chosen = choice.currency;
  const currencies = view ? performanceCurrencies(view) : [];
  const currency = chosen !== null && currencies.includes(chosen) ? chosen : currencies[0] ?? 'USDC';
  const series = view ? selectedSeries(view, currency) : null;
  const groups = view ? view.groups.filter(group => group.currency === currency) : [];
  const status = performanceStatus(view, read.error ? read.error.message : null);
  const closed = series?.closedCount ?? 0;
  return <section className="panel performance-panel" aria-labelledby="performanceTitle">
    <div className="panel-h"><h2 id="performanceTitle">策略实盘收益<span className="heading-detail">按每次组合开仓累计</span></h2><span className="source-tag">{view ? 'MAINNET · 实盘业绩' : '等待同步'}</span></div>
    <div className="performance-toolbar">
      <p data-warning={String(status.warning)} role="status">{status.text}</p>
      <select aria-label="收益结算币种" value={currency} onChange={event => onChoice({ ...choice, currency: event.target.value })}>{(currencies.length ? currencies : [currency]).map(item => <option key={item} value={item}>{item}</option>)}</select>
      <button type="button" className="link-button" onClick={() => void read.refresh()}>刷新收益 ↗</button>
    </div>
    <div className="performance-summary">
      <div><span>到期组合综合净收益</span><strong className={closed ? tone(series!.totalPnl) : ''}>{closed ? money(series!.totalPnl) : '--'}</strong></div>
      <div><span>纳入统计的到期组合</span><strong>{closed}</strong></div>
      <div><span>到期组合胜率</span><strong>{closed ? `${number(series!.wins / closed * 100, 1)}%` : '--'}</strong></div>
      <div><span>到期组合采样最大回撤</span><strong>{closed ? money(series!.maxDrawdown) : '--'}</strong></div>
    </div>
    <div className="panel-b">
      <div className="pp-chart">{series ? <PerformanceChart points={series.points} sampled={series.sampledCount} value={seriesValue} holding={false} currency={currency} describe={point => `${point.groupId} · ${utcMinute(point.time)} · ${point.terminal ? '结束净收益' : '真实采样'} ${money(point.pnl)} · 曲线值 ${money(point.cumulative)}`} /> : <div className="empty">等待实盘收益记录</div>}</div>
      <div className="performance-list-head"><h3>每次开仓收益详情</h3><span>{view ? coverageLine(groups, view.unassignedCloses) : '等待同步'}</span></div>
      <div>{!view ? <div className="empty">等待组合记录</div> : groups.length ? groups.map(group => <GroupRow key={group.id} group={group} sampleSeconds={view.sampleSeconds} open={choice.expanded.has(group.id)} onToggle={(id, open) => { const expanded = new Set(choice.expanded); if (open) expanded.add(id); else expanded.delete(id); onChoice({ ...choice, expanded }); }} />) : <div className="empty">暂无该币种的实盘组合记录。</div>}</div>
    </div>
    <p className="pp-note">综合统计仅纳入已核实持有至到期的组合，提前平仓或部分减仓的整组均不纳入。持仓期间定时保存真实盈亏采样；到期后将采样路径与最终净收益纳入综合曲线，包含已知交易费用和最终交割手续费。历史未采样时段不补造数据，断网缺口断开显示。按结算币种分别统计，不含账户充值、提现和无关交易。台账从本服务开始记录成交时起，不导入工作台的历史台账。<a href="https://bybit-exchange.github.io/docs/v5/position/close-position" target="_blank" rel="noopener noreferrer">交易所收益记录 ↗</a></p>
  </section>;
}
