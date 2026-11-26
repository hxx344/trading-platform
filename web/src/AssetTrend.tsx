// The trend panel of the asset page, after AssetTrend, DailyChanges and CashFlowsPanel in project_aggregation
// modules/asset/app (asset-trend.tsx, daily-changes.tsx, cash-flows-panel.tsx at 0014655). Changes: the curve, the
// monthly figures and the annualized returns come computed from /api/asset/history; the chart is the service's SvgPlot
// instead of recharts; daily changes and cash flows are read from /api/asset/*; the cash flow form is a panel above the
// list and saves through the page's one writer (AssetPage.tsx useWriter).
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { SvgPlot, createHoverStore, type HoverStore, type PlotLayer, type PlotScales } from './svg-plot.tsx';
import { niceAxis } from './svg-plot-geometry.ts';
import { useLiveResource } from './use-live-resource.ts';
import { readFailure } from './live-resource.ts';
import { MIN_MONTHLY_SPAN_DAYS, formatGain, formatReturnRate, performanceTone } from '../../src/asset/performance-metrics.ts';
import { DAILY_CHANGE_DAYS } from '../../src/asset/daily-changes.ts';
import { POSITION_GROUPS, type PositionAnalysis } from '../../src/asset/daily-positions.ts';
import { businessDay, type CashFlowInput, type CashFlowRecord } from '../../src/asset/cash-flows.ts';
import { newRequestId } from './request-ids.ts';
import type { Writer } from './AssetPage.tsx';
import type { AssetCashFlowsView, AssetDailyChangesView, AssetHistoryView, TrendPoint } from '../../src/asset/views.ts';
import { type DailyBar, CASH_FLOW_PAGE, amountTick, auditLine, dailyItems, dayTick, dailyProfitBars, evidenceStatus, monthlyHint, signed, trendPlotPoints, trendStepDays, trendSummary, zhMoney } from './asset-format.ts';

export const DAILY_CHANGES_PATH = '/api/asset/daily-changes';
export const CASH_FLOWS_PATH = '/api/asset/cash-flows';
/** The daily report compares up to 90 snapshots with their holdings; it may take longer than the other reads. */
const DAILY_TIMEOUT_MS = 20_000;
const READ_TIMEOUT_MS = 10_000;

const lines = (single: boolean): PlotLayer[] => [
  { kind: 'line', key: 'adjusted', color: 'var(--chart-1)', width: 2, active: true, ...(single ? { dots: 3 } : {}) },
  { kind: 'line', key: 'held', color: 'var(--chart-2)', width: 1.5, dash: '5 4', active: true, ...(single ? { dots: 2 } : {}) },
];

function TrendTip({ point }: { point: TrendPoint }) {
  return <div className="trend-tooltip"><strong>{point.date}</strong>{point.missingValues ? <p>部分估值：仅汇总已知金额</p> : null}
    <div>实际持有：$ {zhMoney(point.held)}</div><div>累计出金：$ {zhMoney(point.withdrawn)}</div><div>剔除出金影响：$ {zhMoney(point.adjusted)}</div>
    {point.difference ? <p>原表合计差异：$ {zhMoney(point.difference)}</p> : null}</div>;
}

const DAY_MS = 86_400_000;
const NO_LAYERS: PlotLayer[] = [];
const BAR_MARGIN = { top: 8, right: 48, bottom: 28 };
const ZERO_LINE = [{ y: 0, color: 'var(--muted-foreground)' }];

function BarTip({ bar }: { bar: DailyBar }) {
  return <div className="trend-tooltip"><strong>{bar.date}</strong>
    {bar.change === null ? <p>快照估值不完整，不计算变化</p>
      : <div>{bar.gapDays === 1 ? '当日盈亏' : `较 ${bar.previousDate.slice(5)}（间隔 ${bar.gapDays} 天）`}：<span className={performanceTone(bar.change)}>$ {formatGain(bar.change)}</span></div>}
    {bar.change !== null && bar.gapDays !== 1 ? <p>间隔超过一天，不画柱</p> : null}</div>;
}

/** The day-over-day change of adjusted assets as bars, on the trend's time axis and sharing its hover. */
const DailyBars = memo(function DailyBars({ trend, hover }: { trend: readonly TrendPoint[]; hover: HoverStore }) {
  const bars = useMemo(() => dailyProfitBars(trend), [trend]);
  const start = trend[0].time, end = trend.at(-1)!.time;
  const xDomain = useMemo(() => [start, end] as const, [start, end]);
  const drawn = useMemo(() => bars.flatMap(bar => bar.bar === null ? [] : [bar.bar]), [bars]);
  const axis = useMemo(() => niceAxis(Math.min(0, ...drawn), Math.max(0, ...drawn), 3), [drawn]);
  const overlay = useMemo(() => ({ x, y }: PlotScales) => {
    const width = Math.max(1, Math.min(12, (x(start + DAY_MS) - x(start)) * 0.7)), zero = y(0);
    return <g aria-hidden="true" pointerEvents="none">{bars.map(bar => {
      if (!bar.bar) return null;
      const height = Math.max(1, Math.abs(y(bar.bar) - zero));
      return <rect key={bar.time} x={x(bar.time) - width / 2} width={width} y={bar.bar > 0 ? zero - height : zero} height={height} fill={bar.bar > 0 ? 'var(--positive)' : 'var(--destructive)'} />;
    })}</g>;
  }, [bars, start]);
  return <>
    <div className="trend-key daily-bars-key"><span>每日盈亏</span><span><i className="bar-gain" />盈利</span><span><i className="bar-loss" />亏损</span><span>较前一日，剔除出金影响，入金未剔除</span></div>
    {drawn.length ? <div className="chart daily-bars">
      <SvgPlot rows={bars} xDomain={xDomain} yDomain={axis.domain} yTicks={axis.ticks} yTick={amountTick} xTick={dayTick} layers={NO_LAYERS} references={ZERO_LINE}
        margin={BAR_MARGIN} height={130} hover={hover} overlay={overlay} label="每日盈亏柱形图：每根柱为当日调整后资产较前一日的变化，绿色为盈利、红色为亏损；前一份快照隔了一天以上或估值不完整的日期不画柱。"
        tooltip={row => <BarTip bar={row as DailyBar} />} />
    </div> : <p className="help daily-bars-empty">还没有相邻两天且估值完整的快照，暂无每日盈亏。</p>}
  </>;
});

export const AssetTrend = memo(function AssetTrend({ history, version, writer, onHistory, onExpired }: { history: AssetHistoryView; version: string; writer: Writer; onHistory: () => void; onExpired: () => void }) {
  const { trend, monthly, annualized, today } = history;
  const { first, last, change, incomplete } = trendSummary(trend);
  const plotted = useMemo(() => trendPlotPoints(trend), [trend]);
  const step = first && last ? trendStepDays((last.time - first.time) / 86_400_000) : 1;
  const axis = useMemo(() => { const values = plotted.flatMap(point => [point.adjusted, point.held]); return niceAxis(Math.min(...values), Math.max(...values)); }, [plotted]);
  const layers = useMemo(() => lines(trend.length === 1), [trend.length]);
  const month = annualized?.monthlyPeriod ?? null;
  const [hover] = useState(createHoverStore);
  return <section className="panel trend-panel">
    <div className="panel-h"><h2>资产变化</h2><span className="panel-h-right">北京时间 · USD{step > 1 ? ` · 每 ${step} 天一点` : null}</span></div>
    <div className="trend-summary">
      <span>剔除出金影响的区间变化</span>
      <strong className={change === null ? undefined : performanceTone(change)}>{change === null ? '—' : '$ ' + signed(change)}</strong>
      <p>{first && last ? first.date + ' — ' + last.date : '等待首条快照'}{change === null && incomplete ? '；' + incomplete : null}</p>
    </div>
    <div className="trend-key"><span><i className="adjusted-line" />剔除出金影响</span><span><i className="held-line" />实际持有资产</span></div>
    {first && last ? <div className="chart">
      <SvgPlot rows={plotted} hoverRows={trend} xDomain={[first.time, last.time]} yDomain={axis.domain} yTicks={axis.ticks} yTick={amountTick} xTick={dayTick} layers={layers}
        margin={{ top: 10, right: 48, bottom: 28 }} height={220} hover={hover} label="资产变化折线图：实线为剔除出金影响后的资产，虚线为实际持有资产；跨度超过两个月时每 3 天、超过半年时每 7 天取一份快照。详细数值见历史记录。"
        tooltip={row => <TrendTip point={row as TrendPoint} />} />
    </div> : <div className="empty-state">导入的账本还没有可画的快照</div>}
    {trend.length >= 2 ? <DailyBars trend={trend} hover={hover} /> : null}
    {trend.length >= 2 && annualized ? <section className="performance-metrics" aria-label="资产变化指标">
      <div className="performance-annualized">
        <div className="performance-card">
          <span className="performance-label">当月资产变化年化 <small>{annualized.referenceMonth}</small></span>
          <strong className={performanceTone(annualized.monthlyAnnualized, 100)}>{formatReturnRate(annualized.monthlyAnnualized)}</strong>
          <p>{monthlyHint(month)}</p>
        </div>
        <div className="performance-card">
          <span className="performance-label">全期间资产变化年化</span>
          <strong className={performanceTone(annualized.overallAnnualized, 100)}>{formatReturnRate(annualized.overallAnnualized)}</strong>
          <p>{first?.date} — {last?.date} · {annualized.daysSpan} 天{annualized.overallAnnualized === null ? '；' + (incomplete ? incomplete + '，不计算变化' : '首末快照估值须完整，起始调整后资产须大于 0，变化率需为有效数值') : null}</p>
        </div>
      </div>
      <p className="performance-note">仅加回已登记出金，入金未剔除；资产变化不等于投资收益。</p>
      <details className="performance-monthly">
        <summary>每月表现 <span>（{monthly.length} 个月）</span>与计算口径</summary>
        <div className="performance-monthly-body">
          <div className="performance-heading"><h3>资产变化指标</h3><span>全历史 · 单利年化</span></div>
          <p className="performance-note">基于调整后资产，入金未剔除。当月首末快照间隔至少 {MIN_MONTHLY_SPAN_DAYS} 天才计算当月资产变化年化；按实际相隔天数及各年 365 / 366 天折算，不计复利。</p>
          <div className="performance-table-scroll" role="region" aria-label="每月表现明细，可横向滚动" tabIndex={0}>
            <table className="performance-table">
              <caption>各月按月内首末已有快照计算，不补齐缺失日期。金额单位：USD。</caption>
              <thead><tr><th scope="col">月份 / 快照区间</th><th scope="col">变化金额</th><th scope="col">变化率</th><th scope="col">期末调整后资产</th></tr></thead>
              <tbody>{monthly.map(period => <tr key={period.month}>
                <th scope="row">{period.month}{period.month === today.slice(0, 7) ? <span className="performance-month-state">进行中</span> : null}
                  <small>{period.startDate.slice(5)} — {period.endDate.slice(5)} · {period.snapshotCount} 日快照</small>
                  {period.snapshotCount < 2 ? <small>仅一个日期，无法计算变化</small> : null}
                  {period.snapshotCount >= 2 && period.gain === null ? <small>首末快照估值不完整或超出计算范围</small> : null}
                  {period.snapshotCount >= 2 && period.startValue <= 0 ? <small>起始资产不大于 0，变化率不可用</small> : null}
                </th>
                <td className={performanceTone(period.gain)}>{period.gain === null ? '—' : '$ ' + formatGain(period.gain)}</td>
                <td className={performanceTone(period.returnRate, 100)}>{formatReturnRate(period.returnRate)}</td>
                <td>$ {zhMoney(period.endValue)}</td>
              </tr>)}</tbody>
            </table>
          </div>
        </div>
      </details>
    </section> : null}
    {trend.length >= 2 ? <DailyChanges version={version} writer={writer} onExpired={onExpired} /> : null}
    <p className="panel-foot chart-note">调整后资产 = 实际持有资产 + 累计出金；仅计已登记出金，入金未剔除。缺失估值的快照仅含已知金额，首末快照估值不完整时不计算变化。连线仅连接已有记录，不代表缺失日期的估值。<button type="button" className="text-button" onClick={onHistory}>查看记录</button></p>
  </section>;
});

function Holdings({ positions }: { positions: PositionAnalysis | null }) {
  const note = !positions?.recorded ? '这份快照缺少持仓数据' : !positions.compared ? '上一份快照缺少持仓数据'
    : positions.groups.every(group => group.change === null) ? '两份快照间缺少可比持仓数据' : null;
  return <>
    <ul className="daily-combos" aria-label="持仓影响（USD）">{POSITION_GROUPS.map(({ id, label }) => {
      const group = positions?.groups.find(item => item.id === id), change = group?.change ?? null;
      return <li key={id}><span>{label}</span><b className={change === null ? undefined : performanceTone(change)}>{formatGain(change)}</b>
        {change !== null && !group?.complete ? <small className="daily-partial">部分</small> : null}
      </li>;
    })}</ul>
    {note ? <p className="daily-combos-note">{note}</p> : null}
  </>;
}

/** Read only while expanded; read again when the ledger changes (a new import or a write here), at once while open or on the next opening. */
function DailyChanges({ version, writer, onExpired }: { version: string; writer: Writer; onExpired: () => void }) {
  const [open, setOpen] = useState(false), [expanded, setExpanded] = useState<string | null>(null);
  const { data: report, error, status, refresh } = useLiveResource<AssetDailyChangesView>(DAILY_CHANGES_PATH, { intervalMs: null, timeoutMs: DAILY_TIMEOUT_MS, enabled: open, onExpired });
  const seen = useRef(version);
  // A change while closed is read when the report opens again.
  useEffect(() => { if (!open || seen.current === version) return; seen.current = version; void refresh(); }, [version, open, refresh]);
  const loading = open && status === 'loading';
  const failure = readFailure({ error, status });
  const days = report?.days ?? [];
  return <details className="performance-monthly daily-changes" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>每日波动 <span>（近 {DAILY_CHANGE_DAYS} 天{report ? ' · ' + days.length + ' 日' : ''}）</span>与来源</summary>
    <div className="performance-monthly-body">
      {open ? <CashFlows version={version} writer={writer} onExpired={onExpired} /> : null}
      <p className="performance-note">逐日对比上一份已有快照，缺失日期不补造。来源为各资产行估值变化，展开可看交易所按账户、币种的分项；出金单列并加回，与“剔除出金影响”口径一致。入金未剔除，资产变化不等于投资收益。</p>
      <p className="performance-note">持仓影响按资产已接入的合约分组，Hyperliquid 覆盖 xyz 和 io。金额以 USD 显示，含浮盈亏变化和可比的已实现盈亏、手续费及资金费。“部分”表示只统计了能核对的金额，“—”表示缺少可比数据。</p>
      {open && failure ? <p className="error-text" role="alert">{failure}{report ? '，当前显示上次读取结果' : null} <button type="button" className="text-button" disabled={loading || status === 'offline'} onClick={() => void refresh()}>{loading ? '正在重试' : '重试'}</button></p> : null}
      {!report ? (loading && !failure ? <p className="help" role="status">读取每日波动…</p> : null)
        : !days.length ? <p className="help">近 {DAILY_CHANGE_DAYS} 天不足两份快照，暂无逐日变化。</p>
        : <ol className="daily-change-list" aria-label="每日波动明细，按日期从新到旧" aria-busy={loading}>{days.map(day => {
          const all = dailyItems(day), isOpen = expanded === day.date, shown = isOpen ? all : all.slice(0, 3);
          const extra = all.some(item => item.sub.length);
          const rate = !day.partial && day.previousAdjusted > 0 ? day.change / day.previousAdjusted : null;
          return <li key={day.date}>
            <div className="daily-change-head">
              <span><strong>{day.date.slice(5)}</strong>{day.partial ? <small className="daily-partial" title="快照含旧值或缺失估值，仅比较已知金额">部分数据</small> : null}<small>较 {day.previousDate.slice(5)}{day.gapDays > 1 ? ' · 间隔 ' + day.gapDays + ' 天' : null}</small></span>
              <span className={performanceTone(day.change)}>$ {formatGain(day.change)}<small>{formatReturnRate(rate)}</small></span>
            </div>
            <Holdings positions={day.positions} />
            {day.attribution ? <details><summary>资金流与未解释差额</summary>
              <p>已标注净外部资金流：{formatGain(day.attribution.cashFlows.knownNetUsd)} USD · 已知持仓贡献：{formatGain(day.attribution.knownPositionChange)} USD · 出金加回：{formatGain(day.withdrawnChange)} USD · 未解释差额：{formatGain(day.attribution.unexplained)} USD</p>
              <p className="performance-note">{day.attribution.note}</p>
              <p>待配对 {day.attribution.cashFlows.pending} 条 · 缺汇率 {day.attribution.cashFlows.missingRate} 条。{day.attribution.cashFlows.note}</p>
              <ul>{day.attribution.cashFlows.rows.map(row => <li key={row.id}>{row.date} · {row.account} · {row.amount} {row.currency} · {row.reference} · v{row.revision}{row.note ? ` · ${row.note}` : ''}</li>)}</ul>
            </details> : null}
            {all.length ? <ul className={isOpen ? 'daily-sources expanded' : 'daily-sources'}>{shown.map(item => <li key={item.key}>
              <span className="daily-source-label">{item.label}</span>
              {isOpen ? <small>{item.detail}</small> : null}
              <b className={performanceTone(item.change)}>{formatGain(item.change)}</b>
              {isOpen && item.sub.length ? <ul className="daily-sources expanded daily-details">{item.sub.map(line => <li key={line.key}>
                <span className="daily-source-label">{line.label}</span><small>{line.detail}</small><b className={performanceTone(line.change)}>{formatGain(line.change)}</b>
              </li>)}</ul> : null}
            </li>)}</ul> : <p className="daily-sources">{day.partial ? '已知来源无变化，部分数据无法比较' : '各来源无变化'}</p>}
            {all.length > 3 || extra ? <button type="button" className="text-button" aria-expanded={isOpen} onClick={() => setExpanded(isOpen ? null : day.date)}>{isOpen ? '收起' : extra ? '展开明细' : '全部 ' + all.length + ' 项'}</button> : null}
          </li>;
        })}</ol>}
    </div>
  </details>;
}

function AuditTrail({ id, audit }: { id: string; audit: readonly CashFlowRecord[] }) {
  return <details><summary>完整审计历史</summary><ul>{audit.filter(item => item.id === id).map(item => <li key={item.revision}>{auditLine(item)}</li>)}</ul></details>;
}

/** The workbench's 净资金流标注 (cash-flows-panel.tsx at 0014655): the audit, newest business day first, 20 a page. */
function CashFlows({ version, writer, onExpired }: { version: string; writer: Writer; onExpired: () => void }) {
  const { data, error, status, refresh, commit } = useLiveResource<AssetCashFlowsView>(CASH_FLOWS_PATH, { intervalMs: null, timeoutMs: READ_TIMEOUT_MS, onExpired });
  const failure = readFailure({ error, status });
  const [page, setPage] = useState(0), [draft, setDraft] = useState<CashFlowInput | null>(null);
  const seen = useRef(version);
  useEffect(() => { if (seen.current === version) return; seen.current = version; void refresh(); }, [version, refresh]);
  const rows = data?.evidence ?? [], audit = data?.audit ?? [], voided = data?.voided ?? [];
  const lastPage = Math.max(0, Math.ceil(rows.length / CASH_FLOW_PAGE) - 1), current = Math.min(page, lastPage);
  const edit = (value: Partial<CashFlowInput>) => setDraft(previous => previous ? { ...previous, ...value } : previous);
  const open = (next: CashFlowInput) => { writer.clear(); setDraft(next); };
  const save = () => { if (draft) void writer.run<AssetCashFlowsView>(CASH_FLOWS_PATH, draft, result => { if (result && 'audit' in result) commit(result); setDraft(null); }); };
  return <section className="cash-flows" aria-label="净资金流标注">
    <h4>净资金流标注</h4><p className="performance-note">账户用稳定、可辨认的标识；日期按北京时间。正数为流入、负数为流出。仅标注已有凭证，不会转账或修改余额。内部转账使用相同配对编号，单侧、重复候选或跨日保持待配对。旧出金登记独立保留。</p>
    {failure ? <p role="alert" className="error-text">{failure}{data ? '，当前显示上次读取结果' : null} <button type="button" className="text-button" disabled={status === 'loading' || status === 'offline'} onClick={() => void refresh()}>{status === 'loading' ? '正在重试' : '重新读取'}</button></p> : null}
    {!draft ? <p><button type="button" className="button" disabled={writer.busy || !data} onClick={() => open({ id: newRequestId(), revision: 0, date: businessDay(Date.now()), account: '', currency: 'USD', amount: '', kind: 'external', transferId: null, usdRate: null, rateAt: null, reference: '', reason: '', void: false })}>登记资金流</button></p> : null}
    {draft ? <div className="panel edit-panel" role="group" aria-label={draft.revision > 0 ? '修改资金流标注' : '登记资金流'}>
      <form className="form-grid" onSubmit={event => { event.preventDefault(); save(); }}>
        <label>业务日期<input type="date" required max={businessDay(Date.now())} value={draft.date} onChange={event => edit({ date: event.target.value })} /></label>
        <label>账户标识<input maxLength={80} required value={draft.account} onChange={event => edit({ account: event.target.value })} /></label>
        <label>币种<input maxLength={20} required value={draft.currency} onChange={event => edit({ currency: event.target.value.toUpperCase(), usdRate: null, rateAt: null })} /></label>
        <label>原币金额（流出为负）<input inputMode="decimal" maxLength={35} required value={draft.amount} onChange={event => edit({ amount: event.target.value })} /></label>
        <label>类型<select value={draft.kind} onChange={event => edit({ kind: event.target.value as CashFlowInput['kind'], transferId: event.target.value === 'internal' ? '' : null })}><option value="external">外部入出金</option><option value="internal">内部转账</option></select></label>
        {draft.kind === 'internal' ? <label>内部转账配对编号<input required maxLength={80} value={draft.transferId ?? ''} onChange={event => edit({ transferId: event.target.value })} /></label> : null}
        {draft.currency !== 'USD' ? <><label>每单位币种折 USD（未知留空）<input inputMode="decimal" value={draft.usdRate ?? ''} onChange={event => edit({ usdRate: event.target.value || null, rateAt: event.target.value ? draft.rateAt ?? new Date().toISOString() : null })} /></label>
          <label>汇率证据时间（ISO，含时区）<input value={draft.rateAt ?? ''} onChange={event => edit({ rateAt: event.target.value || null })} /></label></> : null}
        <label>原始凭证引用<input required maxLength={200} value={draft.reference} onChange={event => edit({ reference: event.target.value })} /></label>
        <label>登记或修改原因<input required maxLength={200} value={draft.reason} onChange={event => edit({ reason: event.target.value })} /></label>
        {draft.revision > 0 ? <label className="checkbox-label"><input type="checkbox" checked={draft.void} onChange={event => edit({ void: event.target.checked })} />作废本条（保留历史）</label> : null}
        {writer.errorOf(CASH_FLOWS_PATH) ? <p className="error-text" role="alert">{writer.errorOf(CASH_FLOWS_PATH)}</p> : null}
        <div className="form-actions"><button type="button" className="button" disabled={writer.busy} onClick={() => setDraft(null)}>取消</button><button className="button primary" disabled={writer.busy}>{writer.busy ? '保存中…' : '保存标注'}</button></div>
      </form>
    </div> : null}
    {!data && !failure ? <p className="help" role="status">读取资金流标注…</p> : null}
    {data && !rows.length ? <p className="help">还没有资金流标注。</p> : null}
    <ol start={current * CASH_FLOW_PAGE + 1}>{rows.slice(current * CASH_FLOW_PAGE, (current + 1) * CASH_FLOW_PAGE).map(row => <li key={row.id}>
      {row.date} · {row.account} · {row.amount} {row.currency} · {evidenceStatus(row)} · {row.reference}
      {row.note ? <p>{row.note}</p> : null}
      <button type="button" className="text-button" disabled={writer.busy} onClick={() => { const { status: _status, usdValue: _usd, note: _note, recordedAt: _at, ...input } = row; open({ ...input, reason: '' }); }}>修改/作废</button>
      <AuditTrail id={row.id} audit={audit} />
    </li>)}</ol>
    {lastPage ? <p className="cash-flow-pages"><button type="button" className="text-button" disabled={current === 0} onClick={() => setPage(current - 1)}>上一页</button> {current + 1}/{lastPage + 1} <button type="button" className="text-button" disabled={current === lastPage} onClick={() => setPage(current + 1)}>下一页</button></p> : null}
    {voided.length ? <details><summary>作废审计记录</summary><ul>{voided.map(row => <li key={row.id}>{row.id} v{row.revision} · {row.recordedAt} · {row.account} {row.amount} {row.currency} · {row.reason}<AuditTrail id={row.id} audit={audit} /></li>)}</ul></details> : null}
  </section>;
}
