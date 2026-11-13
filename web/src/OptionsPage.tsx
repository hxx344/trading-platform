import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { api, ApiError } from './api.ts';
import {
  autoOpenConfirm, chainLines, isActive, money, orderState, payoffAt, payoffCurve, planBody, planLimit, parseQuantity, quantityText, QUANTITY_PRESETS,
  signedMoney, startBody, startRefused, STATUS_TEXT, scheduleTime, strategyName, taskSummary, utcDate, utcTime,
} from './options-form.ts';
import type { ChainRow, GreekName, OptionsMarket, OptionsState, Plan, Preview, PreviewView, StrategyMode, Task, TaskAccepted } from './options-types.ts';
import { RequestIds } from './request-ids.ts';
import { useLiveResource } from './use-live-resource.ts';
import { PerformancePane, type PerformanceChoice } from './OptionsPerformance.tsx';

// The options page follows the workbench Greeks desk (modules/greeks/app/static/index.html and app.js, 2f0593d): the
// page header, four tabs (执行台, 持仓, 组合执行, 收益 in OptionsPerformance.tsx), the alert strip, then the desk grid — strategy figures, the chain, the
// legs with the expiry payoff, the Greeks of the positions, the execution control and the account health. A trade is
// planned on the server, checked in the confirmation dialog and started with a request id kept until an answer arrives.
// The workbench's 组合询价 tab is not part of this service (docs/options.md, G2).

export const OPTIONS_STATE_PATH = '/api/options/state';
export const OPTIONS_READ_TIMEOUT_MS = 10_000;
const ACTIVE_MS = 1_000;
const IDLE_MS = 5_000;
const MARKET_MS = 10_000;
const WRITE_TIMEOUT_MS = 30_000;
export type OptionsTab = 'desk' | 'positions' | 'orders' | 'performance';
const TABS: { tab: OptionsTab; href: string; text: string }[] = [
  { tab: 'desk', href: '#/options', text: '执行台' }, { tab: 'positions', href: '#/options/positions', text: '持仓' }, { tab: 'orders', href: '#/options/orders', text: '组合执行' },
  { tab: 'performance', href: '#/options/performance', text: '收益' },
];
const STOP_CONFIRM = '停止只撤未成交委托，已成交部分保留。确认停止？';
const UNKNOWN_START = '提交结果未知：请求可能已被受理。不要换方案重下；再点“确认”会用同一请求编号向服务核对。';
const LEAVE_UNANSWERED = '上次提交没有收到应答，任务可能已被受理。关闭后请到“组合执行”核对，不要重复开仓。确定关闭？';
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const fixed = (value: number, digits: number): string => `${value > 0 ? '+' : ''}${value.toFixed(digits)}`;
const GREEK_TEXT: Record<GreekName, (value: number) => string> = {
  delta: value => fixed(value, 4),
  gamma: value => value !== 0 && Math.abs(value) < 0.001 ? `${value > 0 ? '+' : ''}${value.toExponential(2)}` : fixed(value, 6),
  vega: value => fixed(value, 2), theta: value => fixed(value, 2),
};
const number = (value: number | null | undefined, digits = 2): string => value === null || value === undefined || !Number.isFinite(value) ? '--' : value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const marginLabel = (value: string | null | undefined): string => ({ REGULAR_MARGIN: '常规保证金', PORTFOLIO_MARGIN: '组合保证金', ISOLATED_MARGIN: '逐仓保证金' } as Record<string, string>)[value ?? ''] ?? value ?? 'UTA';

/** A bar whose length is set by an SVG attribute: the page's CSP allows no style attributes. */
function Bar({ ratio, className }: { ratio: number | null; className: string }) {
  const width = ratio === null ? 0 : Math.max(0, Math.min(1, ratio)) * 100;
  return <span className={className} aria-hidden="true"><svg viewBox="0 0 100 1" preserveAspectRatio="none"><rect width={width} height="1" /></svg></span>;
}

function Panel({ className, title, detail, right, children, label }: { className: string; title: ReactNode; detail?: ReactNode; right?: ReactNode; children: ReactNode; label?: string }) {
  const id = useId();
  return <section className={`panel ${className}`} aria-labelledby={label ? undefined : id} aria-label={label}>
    <div className="panel-h"><h2 id={id}>{title}</h2>{detail}{right !== undefined ? <div className="right">{right}</div> : null}</div>
    {children}
  </section>;
}

function quoteCell(row: ChainRow | null, value: (row: ChainRow) => string, className = '') {
  return row ? <td className={className}>{value(row)}</td> : <td className="empty-cell">--</td>;
}
function deltaCell(row: ChainRow | null, side: 'call' | 'put') {
  if (!row) return <td className="empty-cell">--</td>;
  return <td className={`delta ${side}`}><span className="delta-value">{row.delta.toFixed(3)}</span><Bar className="delta-track" ratio={Math.abs(row.delta)} /></td>;
}
function legCell(row: ChainRow | null, legs: Map<string, 'Buy' | 'Sell'>) {
  const side = row ? legs.get(row.symbol) : undefined;
  return <td className="position">{side ? <span className={`selected-mark ${side.toLowerCase()}`}>{side === 'Sell' ? 'S' : 'B'}</span> : '--'}</td>;
}

function ChainPanel({ market, preview }: { market: OptionsMarket | null; preview: Preview | null }) {
  const [full, setFull] = useState(false);
  const rows = market?.rows ?? [];
  const legs = new Map((preview?.legs ?? []).map(leg => [leg.symbol, leg.side] as const));
  const lines = chainLines(rows, market?.index ?? null, [...legs.keys()]);
  const buys = preview?.legs.filter(leg => leg.side === 'Buy').length ?? 0, sells = (preview?.legs.length ?? 0) - buys;
  const n = (row: ChainRow, key: 'volume' | 'openInterest' | 'bidSize' | 'askSize' | 'bid' | 'ask' | 'mark') => number(row[key]);
  return <section className="panel chain-panel" data-depth={full ? 'full' : 'compact'} data-availability={rows.length ? undefined : 'unavailable'} aria-label="盘口">
    <div className="panel-h"><h2>期权链<span className="heading-detail">双侧盘口</span></h2><span className="source-tag">Bybit</span><span className="expiry-tag">到期 {utcDate(market?.expiry)}</span><div className="right"><span className="spot-tag">BTC <b>{market?.index ? number(market.index, 0) : '--'}</b></span></div></div>
    <div className="chain-toolbar"><span>到期日 <b>{utcDate(market?.expiry)}</b></span><span className="sep" aria-hidden="true" /><span>每 <b>10</b> 秒更新</span><span className="leg-summary">BUY {buys} · SELL {sells}</span>
      <span className="toolbar-right"><span className="legend"><i className="legend-buy" />Bid 买价<i className="legend-sell" />Ask 卖价</span><button className="table-toggle" type="button" aria-pressed={full} onClick={() => setFull(value => !value)}>{full ? '精简盘口 ↙' : '完整盘口 ↗'}</button></span></div>
    <div className="chain-wrap" tabIndex={0} role="region" aria-label="双侧期权盘口，可横向滚动">
      <table className="chain-table" aria-label="BTC 期权链">
        <thead><tr><th colSpan={9} className="call-head" scope="colgroup">CALLS <span>看涨期权</span></th><th className="strike-head" scope="col">STRIKE</th><th colSpan={9} className="put-head" scope="colgroup"><span>看跌期权</span> PUTS</th></tr>
          <tr>{['24H VOL', 'OI', 'DELTA', 'BID SIZE', 'BID', 'MARK', 'ASK', 'ASK SIZE', 'LEG', '行权价', 'LEG', 'ASK SIZE', 'ASK', 'MARK', 'BID', 'BID SIZE', 'DELTA', 'OI', '24H VOL'].map((text, index) => <th key={index} scope="col">{text}</th>)}</tr></thead>
        <tbody>{lines.map(line => <tr key={line.strike} className={`${line.atm ? 'atm ' : ''}${line.selected ? 'selected' : ''}`.trim() || undefined}>
          {quoteCell(line.call, row => n(row, 'volume'))}{quoteCell(line.call, row => n(row, 'openInterest'))}{deltaCell(line.call, 'call')}{quoteCell(line.call, row => n(row, 'bidSize'))}{quoteCell(line.call, row => n(row, 'bid'), 'bid')}{quoteCell(line.call, row => n(row, 'mark'), 'mark')}{quoteCell(line.call, row => n(row, 'ask'), 'ask')}{quoteCell(line.call, row => n(row, 'askSize'))}{legCell(line.call, legs)}
          <td className="strike">{line.strike.toLocaleString('en-US')}</td>
          {legCell(line.put, legs)}{quoteCell(line.put, row => n(row, 'askSize'))}{quoteCell(line.put, row => n(row, 'ask'), 'ask')}{quoteCell(line.put, row => n(row, 'mark'), 'mark')}{quoteCell(line.put, row => n(row, 'bid'), 'bid')}{quoteCell(line.put, row => n(row, 'bidSize'))}{deltaCell(line.put, 'put')}{quoteCell(line.put, row => n(row, 'openInterest'))}{quoteCell(line.put, row => n(row, 'volume'))}
        </tr>)}</tbody>
      </table>
    </div>
    <div className="chain-foot"><span>{rows.length ? `${rows.length} 个合约 · 展示 ${lines.length} 个行权价` : market?.error ? `期权链读取失败：${market.error}` : '等待合约数据'}</span><span>高亮为策略腿 <span className="text-divider">·</span> B 买入 / S 卖出<span className="compact-note"> <span className="text-divider">·</span> 精简盘口隐藏 Vol / OI / Size 列</span></span></div>
  </section>;
}

function PayoffChart({ preview }: { preview: Preview }) {
  const clip = useId();
  const curve = payoffCurve(preview);
  if (!curve) return null;
  const width = 600, height = 220, left = 48, right = 15, top = preview.unboundedLoss ? 40 : 18, bottom = 28;
  const pad = Math.max(50, (curve.max - curve.min) * 0.12), yMin = curve.min - pad, yMax = curve.max + pad;
  const x = (price: number) => left + (price - curve.low) / (curve.high - curve.low) * (width - left - right);
  const y = (pnl: number) => top + (yMax - pnl) / (yMax - yMin) * (height - top - bottom);
  const line = curve.samples.map(point => `${x(point.price).toFixed(1)},${y(point.pnl).toFixed(1)}`).join(' ');
  const zero = y(0), spot = preview.index;
  return <svg className="payoff-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`到期盈亏曲线，非当前持仓浮动盈亏${preview.unboundedLoss ? '。无保护腿，亏损无上限；绘图区仅展示有限价格范围' : ''}`}>
    <defs><clipPath id={clip}><polygon points={`${line} ${x(curve.high).toFixed(1)},${zero.toFixed(1)} ${x(curve.low).toFixed(1)},${zero.toFixed(1)}`} /></clipPath></defs>
    {[0, 1, 2, 3, 4].map(step => { const pnl = yMin + (yMax - yMin) * step / 4; return <g key={step}><line className="grid" x1={left} x2={width - right} y1={y(pnl)} y2={y(pnl)} /><text className="axis" x={5} y={y(pnl) + 3}>{`${pnl >= 0 ? '+' : ''}${Math.round(pnl).toLocaleString('en-US')}`}</text></g>; })}
    <g clipPath={`url(#${clip})`}><rect className="profit-fill" x={left} y={top} width={width - left - right} height={Math.max(0, zero - top)} /><rect className="loss-fill" x={left} y={zero} width={width - left - right} height={Math.max(0, height - bottom - zero)} /></g>
    <line className="zero" x1={left} x2={width - right} y1={zero} y2={zero} />
    <polyline className="curve" points={line} />
    {preview.legs.map(leg => <g key={leg.symbol}><line className="strike" x1={x(leg.strike)} x2={x(leg.strike)} y1={top} y2={height - bottom} /><text className="strike-label" x={x(leg.strike)} y={height - 9}>{Math.round(leg.strike).toLocaleString('en-US')}</text></g>)}
    {spot !== null && spot >= curve.low && spot <= curve.high ? <g><line className="spot" x1={x(spot)} x2={x(spot)} y1={top} y2={height - bottom} /><text className="spot-label" x={x(spot)} y={11}>BTC {Math.round(spot).toLocaleString('en-US')}</text></g> : null}
  </svg>;
}

function StrategyPanel({ preview, problem }: { preview: Preview | null; problem: string | null }) {
  const curve = preview ? payoffCurve(preview) : null;
  const current = preview && preview.index !== null ? payoffAt(preview.index, preview) : null;
  return <Panel className="strategy-panel" title="组合结构" detail={<span className="muted">{preview?.mode === 'short_strangle' ? '双侧卖出 · 无保护腿' : '双侧卖出 · 远端保护'}</span>} right="到期盈亏曲线按当前报价估算 · USD">
    {preview ? <>
      <div className="strategy-body">
        <div className="legs"><table className="legs-table" aria-label="策略腿"><thead><tr><th scope="col">腿</th><th scope="col">合约</th><th scope="col" className="r">Δ / 目标</th><th scope="col" className="r">标记价</th><th scope="col" className="r">预估费 / 封顶</th></tr></thead>
          <tbody>{preview.legs.map(leg => <tr key={leg.symbol}><td><span className={`leg-mark ${leg.side.toLowerCase()}`} title={`${leg.side === 'Sell' ? '卖出' : '买入'} ${leg.optionType}`}>{leg.side === 'Sell' ? 'S' : 'B'} {leg.optionType[0]}</span></td><td className="leg-symbol">{leg.symbol}<small>{leg.side === 'Sell' ? '卖出' : '买入'} {leg.optionType} · {quantityText(leg.qty)} BTC</small></td><td className="r">{leg.delta.toFixed(3)} / {leg.targetDelta.toFixed(2)}</td><td className="r">{money(leg.mark)}</td><td className="r">{money(leg.estimatedFeeUsd)} / {money(leg.feeCapUsd)}</td></tr>)}</tbody></table></div>
        <div className="payoff"><div className="payoff-chart-wrap"><PayoffChart preview={preview} />{preview.unboundedLoss ? <p className="payoff-risk">亏损无上限 · 图中仅展示有限价格范围，曲线边缘不是亏损上限。</p> : null}</div></div>
      </div>
      <div className="payoff-stats">
        <div className="payoff-stat"><span>现价对应到期盈亏</span><strong className={current !== null && current >= 0 ? 'profit' : 'loss'}>{money(current)}</strong></div>
        <div className="payoff-stat"><span>最大收益</span><strong className="profit">{money(preview.maxProfitUsd)}</strong></div>
        <div className="payoff-stat"><span>最大亏损</span><strong className="loss">{preview.unboundedLoss ? '无上限' : money(preview.maxLossUsd)}</strong></div>
        <div className="payoff-stat"><span>盈亏平衡</span><strong>{curve?.breakevens.length ? curve.breakevens.map(point => Math.round(point).toLocaleString('en-US')).join(' / ') : '--'}</strong></div>
      </div>
      {problem ? <p className="panel-f loss" role="status">{problem}</p> : null}
    </> : <div className="strategy-empty">{problem ?? '等待可用策略'}</div>}
  </Panel>;
}

function GreeksPanel({ state }: { state: OptionsState | null }) {
  const summary = state?.greeks ?? null;
  const missing = [...new Set(Object.values(summary?.missing ?? {}).flat())];
  const status = summary === null ? '等待同步' : summary.status === 'empty' ? summary.positionsAvailable ? '暂无持仓' : '持仓暂不可用'
    : summary.status === 'unavailable' ? summary.positionsAvailable ? '期权行情 Greeks 暂不可用' : '持仓暂不可用'
    : summary.status === 'partial' ? `${missing.length} 个合约缺少部分 Greeks` : `${summary.positionCount} 笔持仓${summary.marketAt ? ` · 行情 ${utcTime(summary.marketAt).slice(6)} UTC` : ''}`;
  const stale = summary?.stale === true && summary.status !== 'empty';
  const names: [GreekName, string][] = [['delta', 'Delta · BTC'], ['gamma', 'Gamma · BTC / USD'], ['vega', 'Vega · USD / 1% IV'], ['theta', 'Theta · USD / 天']];
  return <section className="panel greeks-panel" data-state={summary?.status ?? 'loading'} data-stale={String(stale)} aria-label="持仓 Greeks 汇总">
    <div className="panel-h"><h2>持仓 Greeks 汇总</h2><span className="muted">按当前持仓数量与 Bybit 期权行情聚合</span><div className="right" id="greeksStatus">{stale ? `${status} · 旧` : status}</div></div>
    <div className="pstat">{names.map(([name, label]) => { const value = summary?.totals[name]; const known = typeof value === 'number' && Number.isFinite(value); return <div key={name}><span>{label}</span><b className={`num${known ? '' : ' miss'}`}>{known ? GREEK_TEXT[name](value) : '—'}</b></div>; })}</div>
    <p className="panel-f">买入为正、卖出为负，按持仓数量（BTC）乘以交易所每张合约的 Greek 求和；任一持仓缺少某项 Greek 时该项显示 —，不按 0 计入。</p>
  </section>;
}

function HealthPanel({ state }: { state: OptionsState | null }) {
  const health = state?.health ?? null;
  const rate = (value: number | null | undefined) => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const im = rate(health?.initialMarginRate), mm = rate(health?.maintenanceMarginRate);
  const pm = health?.portfolioMargin ?? null;
  const increment = (value: number | null) => value === null ? '—' : `${value >= 0 ? '+' : ''}${money(value)}`;
  return <section className="health panel" aria-label="账户保证金健康度">
    <div className="panel-h"><h2>账户保证金健康度</h2><span className="source-tag">{health?.available ? `Bybit ${state?.account ?? ''}` : '未连接账户'}</span></div>
    {!health?.available ? <div className="health-unavailable">{health?.message ? `账户读取失败：${health.message}` : '连接账户后，将显示余额、保证金和风险指标。'}</div> : <div className="health-content">
      <div className="health-values"><div className="balance-featured"><span>可用余额</span><strong>{number(health.availableBalanceUsd)}</strong><small>USD</small></div><div><span>保证金余额</span><strong>{number(health.marginBalanceUsd)}</strong><small>USD</small></div><div><span>总权益</span><strong>{number(health.totalEquityUsd)}</strong><small>USD</small></div></div>
      <div className="health-metric"><div><span>初始保证金率</span><b>{im === null ? '—' : `${(im * 100).toFixed(2)}%`}</b></div><Bar className="progress" ratio={im} /></div>
      <div className="health-metric"><div><span>维护保证金率</span><b>{mm === null ? '—' : `${(mm * 100).toFixed(2)}%`}</b></div><Bar className="progress danger" ratio={mm} /></div>
      <div className="health-account-mode"><span>账户模式</span><strong>{marginLabel(health.marginMode)}</strong></div>
      {health.marginMode === 'PORTFOLIO_MARGIN' ? <details className="disclosure"><summary>真实 PM 明细 · 8 项</summary><div className="pm-details">{pm ? <>
        <div><span>真实账户 IM</span><strong>{money(pm.accountIm)}</strong></div><div><span>真实账户 MM</span><strong>{money(pm.accountMm)}</strong></div>
        <div><span>BTC 风险单元 IM</span><strong>{money(pm.assetIm)}</strong></div><div><span>BTC 风险单元 MM</span><strong>{money(pm.assetMm)}</strong></div>
        <div><span>本次开仓 IM 增量</span><strong className={pm.incrementalImUsd === null ? 'muted' : pm.incrementalImUsd > 0 ? 'loss' : 'profit'}>{increment(pm.incrementalImUsd)}</strong></div>
        <div><span>本次开仓 MM 增量</span><strong className={pm.incrementalMmUsd === null ? 'muted' : pm.incrementalMmUsd > 0 ? 'loss' : 'profit'}>{increment(pm.incrementalMmUsd)}</strong></div>
        <div><span>Contingency</span><strong>{money(pm.contingency)}</strong></div>
        <div><span>最大压力场景</span><strong>{pm.maxLossPriceMove === null ? '—' : `价格 ${(pm.maxLossPriceMove * 100).toFixed(0)}% · IV ${pm.maxLossIvShock === null ? '—' : `${(pm.maxLossIvShock * 100).toFixed(0)}%`}`}</strong></div>
      </> : <div className="pm-message">真实 PM 明细不可用：{health.portfolioMarginMessage ?? '等待 Bybit 返回'}</div>}</div></details> : null}
    </div>}
  </section>;
}

function TaskCard({ task, state, stopping, onStop }: { task: Task; state: OptionsState; stopping: boolean; onStop: (task: Task) => void }) {
  const summary = taskSummary(task, state.orders, state.executions);
  const active = isActive(task);
  const elapsed = Math.max(0, Math.floor(((task.finishedAt ?? Date.now()) - task.acceptedAt) / 1000));
  const amount = (value: number) => summary.amountsComplete ? signedMoney(value, summary.currency ?? 'USDT') : '待核对';
  const stopped = task.stopRequested || task.status === 'stopping';
  const unknown = summary.legs.some(leg => leg.unknown);
  const message = task.error ?? (task.netBlocked ? '净价限制已触发，未成交委托已停止。' : task.riskBlocked ? '组合风险超出上限，未成交委托已停止。' : null);
  return <article className="execution-card" data-active={String(active)}>
    <div className="execution-card-head"><div><h3>{task.scheduled ? <span className="lock-badge scheduled-tag">定时</span> : null}{task.type === 'close' ? '平仓组合' : '开仓组合'} · {strategyName(task.mode)}</h3><span className="execution-status">{STATUS_TEXT[task.status]}{unknown ? ' · 成交待核对' : ''}</span></div>
      <span>耗时 {Math.floor(elapsed / 60)}分 {elapsed % 60}秒</span>
      {active ? <button type="button" className="button stop-execution" disabled={stopped || stopping} onClick={() => onStop(task)}>{stopped ? '已请求停止 · 等待终态' : stopping ? '停止请求待核对…' : '停止执行'}</button> : null}</div>
    <div className="execution-progress"><span>完成 {summary.completedLegs} / {summary.totalLegs} 腿</span><span>{summary.ratio === null ? '进度待核对' : `${Math.round(summary.ratio * 100)}%`}</span><progress max={1} value={summary.ratio ?? undefined} aria-label="组合成交进度" /></div>
    <div className="execution-amounts"><div><span>累计成交净额（未扣费）</span><strong>{amount(summary.gross)}</strong></div><div><span>手续费</span><strong>{amount(-summary.fee)}</strong></div><div><span>累计成交净额（含费）</span><strong>{amount(summary.net)}</strong></div></div>
    {message ? <p className="execution-caveat">{message}</p> : null}
    {!summary.amountsComplete ? <p className="execution-caveat">金额与费用待核对，缺失数据未计作零。</p> : null}
    {active || summary.completedLegs !== summary.totalLegs ? <p className="execution-caveat">分腿尚未全部完成时，净价限制不代表已实现净额。停止仅撤未成交委托，已成交部分保留。</p> : null}
    <div className="execution-legs">{summary.legs.map(leg => <div className="execution-leg" key={leg.symbol}>
      <div><strong>{leg.symbol}</strong><span>{leg.side === 'Sell' ? '卖出' : '买入'}</span></div>
      <div className="execution-leg-quantity"><span>已成 <b>{quantityText(leg.filled)}</b></span><span>目标 <b>{quantityText(leg.target)}</b></span><span>剩余 <b>{quantityText(leg.remaining)}</b> BTC</span><span className={leg.unknown ? 'loss' : leg.complete ? 'profit' : 'muted'}>{leg.unknown ? '待核对' : leg.complete ? '已完成' : '未完成'}</span></div>
      <details><summary>委托详情 · {leg.orders.length} 笔</summary><div className="orders-table-wrap"><table className="orders-table" aria-label="本腿委托明细"><tbody>{leg.orders.map(order => { const phase = orderState(order, task); return <tr key={order.link}>
        <td data-label="合约 / 订单标识" className="order-contract"><strong>{order.symbol}</strong><small>关联 {order.link}</small><small>交易所 {order.orderId || '--'}</small></td>
        <td data-label="执行"><div className="order-operation">{task.type === 'close' ? '平仓' : '开仓'} <span>{order.kind === 'ioc' ? 'IOC' : 'BBO'}</span></div><span className={`order-side ${order.side === 'Buy' ? 'buy' : 'sell'}`}>{order.side === 'Buy' ? '买入' : '卖出'}</span></td>
        <td data-label="价格 · USD"><div className="order-values"><span><small>最近</small><b>{order.price ?? '--'}</b></span></div></td>
        <td data-label="数量 · BTC"><div className="order-values"><span><small>委托</small><b>{quantityText(order.qty)}</b></span><span><small>累计成交</small><b>{quantityText(order.filledQty)}</b></span></div></td>
        <td data-label="状态阶段"><span className="order-phase" data-tone={phase.tone}>{phase.label}</span>{order.message ? <small className="order-exchange-status">{order.message}</small> : null}</td>
        <td data-label="时间 · UTC"><div className="order-values order-times"><span><small>更新</small><b>{utcTime(order.updatedAt)}</b></span><span><small>创建</small><b>{utcTime(order.createdAt)}</b></span></div></td>
      </tr>; })}</tbody></table></div></details>
    </div>)}</div>
    <details className="execution-identifiers"><summary>执行标识与时间</summary><p>任务 {task.id}<br />请求 {task.requestId}<br />方案 {task.planId}<br />创建 {utcTime(task.acceptedAt)} UTC{task.finishedAt ? <><br />结束 {utcTime(task.finishedAt)} UTC</> : null}</p></details>
  </article>;
}

/** pending: the last start's answer was lost; re-sending the same request id only asks the service, so expiry does not lock it. */
function PlanDialog({ plan, error, sending, pending, fallback, onClose, onSubmit }: { plan: Plan | null; error: string | null; sending: boolean; pending: boolean; fallback: boolean; onClose: () => void; onSubmit: (limit: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [limit, setLimit] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [now, setNow] = useState(Date.now());
  // Counted from when the plan arrived over the server's own lifetime (expiresAt − createdAt, both server clock), so a
  // browser clock that is off does not expire a fresh plan; the server still refuses a late start.
  const [deadline, setDeadline] = useState(0);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (plan && !element.open) element.showModal();
    if (!plan && element.open) element.close();
  }, [plan]);
  useEffect(() => {
    if (!plan) return;
    setLimit(planLimit(plan) === null ? '' : String(planLimit(plan)));
    setConfirmed(false);
    setDeadline(Date.now() + Math.max(0, plan.expiresAt - plan.createdAt));
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [plan]);
  const closing = plan?.operation === 'close';
  const left = plan ? Math.max(0, Math.ceil((deadline - now) / 1000)) : 0;
  const expired = left <= 0 && !pending;
  useEffect(() => { if (plan && expired) setConfirmed(false); }, [plan, expired]);
  return <dialog ref={dialog} className="trade-dialog" aria-labelledby="planTitle" onCancel={event => { event.preventDefault(); onClose(); }}>
    {plan ? <>
      <div className="dialog-head"><div><div className="kicker">确认固定交易方案</div><h2 id="planTitle">{closing ? '核对平仓方案' : '核对开仓方案'}</h2></div><button className="link-button" type="button" onClick={onClose}>关闭</button></div>
      <p className="plan-environment">主网实盘 · {closing ? '跟踪持仓的实际剩余数量' : strategyName(plan.mode)}</p>
      <p className="plan-expiry" role="timer" aria-live="off">{left > 0 ? `方案 ${left} 秒后过期，过期后须重新核对` : pending ? '方案已过期；上次提交结果未知，仍可点确认用同一请求编号核对' : '方案已过期，请关闭后重新核对'}</p>
      <div className="plan-legs">{plan.legs.map(leg => <div className="plan-leg" key={leg.symbol}><strong>{leg.symbol}</strong><span className={`order-side ${leg.side === 'Buy' ? 'buy' : 'sell'}`}>{leg.side === 'Buy' ? '买入' : '卖出'}</span><span>数量 {quantityText(leg.qty)} BTC</span><small>到期 {utcTime(leg.expiry)} UTC · 行权价 {leg.strike.toLocaleString('en-US')} · {leg.optionType}</small><small>参考价 {number(leg.referencePrice)} USD</small></div>)}</div>
      <div className="plan-amounts"><div><span>预估成交净额（未扣费）</span><strong>{signedMoney(plan.estimatedGrossUsd)}</strong></div><div><span>预估手续费</span><strong>{money(plan.estimatedFeeUsd)}</strong></div><div><span>预估成交净额（含费）</span><strong>{signedMoney(plan.estimatedNetUsd)}</strong></div><div><span>预估保证金</span><strong>{money(plan.estimatedMarginUsd)}</strong></div></div>
      <label id="planNetLabel" htmlFor="planNetLimit">{closing ? '最多接受的平仓净支出（含预估手续费）· USD' : '最低接受的开仓净收入（扣预估手续费）· USD'}</label>
      <input id="planNetLimit" type="text" inputMode="decimal" autoComplete="off" value={limit} readOnly={pending} onChange={event => setLimit(event.target.value)} aria-describedby="planRisk planError" />
      <p id="planRisk" className="execution-caveat">{plan.unboundedLoss && !closing ? '无保护腿，亏损无上限。' : ''}各腿分别执行；净价限制不等于部分成交时已实现的净额。停止仅撤未成交委托，已成交部分保留。{closing ? '净支出为负数表示平仓应取得净收入。' : ''}{!closing && fallback ? 'IOC 兜底已打开：超时未成交的腿会按对手价补发一次 IOC，价格仍受上面的最低净收入限制。' : ''}</p>
      <p id="planError" className="loss" role="status">{error ?? ''}</p>
      <label className="confirm"><input type="checkbox" checked={confirmed} disabled={expired} onChange={event => setConfirmed(event.target.checked)} /><span>{closing ? '我确认按以上合约、方向和实际剩余数量平仓。' : `我确认以上固定合约、方向、数量与净价限制${plan.unboundedLoss ? '，并了解无保护腿、亏损无上限' : '及组合风险'}。`}</span></label>
      <button className="button primary" type="button" disabled={!confirmed || sending || expired} data-busy={sending ? '' : undefined} onClick={() => onSubmit(limit)}>{sending ? '提交中…' : `确认并${closing ? '平仓' : '开仓'}`}</button>
    </> : null}
  </dialog>;
}

export function OptionsPage({ tab, onExpired }: { tab: OptionsTab; onExpired: () => void }) {
  const [mode, setMode] = useState<StrategyMode | null>(null);
  const [preset, setPreset] = useState<string>('');
  const [custom, setCustom] = useState('');
  const [riskChecked, setRiskChecked] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // The plan whose start got no answer: it may have been accepted, so leaving it asks first.
  const [unanswered, setUnanswered] = useState<string | null>(null);
  const [preparing, setPreparing] = useState<'open' | 'close' | null>(null);
  const [notice, setNotice] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const [stops, setStops] = useState<Set<string>>(() => new Set());
  const [performanceChoice, setPerformanceChoice] = useState<PerformanceChoice>(() => ({ currency: null, expanded: new Set() }));
  const [toggling, setToggling] = useState(false);
  const ids = useRef(new RequestIds());
  const busyRef = useRef(false);
  const state = useLiveResource<OptionsState>(OPTIONS_STATE_PATH, { intervalMs: busyRef.current ? ACTIVE_MS : IDLE_MS, timeoutMs: OPTIONS_READ_TIMEOUT_MS, onExpired });
  const data = state.data;
  busyRef.current = data?.busy === true;
  const strategy = mode ?? data?.settings.strategyMode ?? 'iron_condor';
  const quantityInput = preset === '' ? data?.settings.legQty ?? '1' : preset === 'custom' ? custom : preset;
  const quantity = parseQuantity(quantityInput);
  const market = useLiveResource<OptionsMarket>('/api/options/market', { intervalMs: MARKET_MS, timeoutMs: OPTIONS_READ_TIMEOUT_MS, onExpired, enabled: tab === 'desk' });
  const previewPath = `/api/options/preview?quantity=${encodeURIComponent(quantity ?? '1')}&mode=${strategy}`;
  const previewRead = useLiveResource<PreviewView>(previewPath, { intervalMs: MARKET_MS, timeoutMs: OPTIONS_READ_TIMEOUT_MS, onExpired, enabled: tab === 'desk' && quantity !== null });
  const preview = quantity !== null ? previewRead.data?.preview ?? null : null;
  const riskProblem = quantity === null ? '每腿数量须为正数（最多 8 位小数）' : previewRead.data?.riskProblem ?? (previewRead.error && !previewRead.data ? previewRead.error.message : null);
  const busy = data?.busy === true;
  const tasks = data?.tasks ?? [];
  const activeTasks = tasks.filter(isActive), history = tasks.filter(task => !isActive(task));
  const hero = activeTasks[0];
  const positionsCount = data?.positions?.rows.length ?? 0;
  // A change of strategy or quantity invalidates the risk check, as the workbench does.
  useEffect(() => { setRiskChecked(false); }, [strategy, quantity]);
  const refresh = useCallback(() => { void state.refresh(); void market.refresh(); void previewRead.refresh(); }, [state, market, previewRead]);

  async function prepare(operation: 'open' | 'close') {
    setPreparing(operation);
    setNotice(null);
    try {
      const created = await api<Plan>('/api/options/plans', { body: planBody(operation, quantity ?? '1', strategy), timeoutMs: WRITE_TIMEOUT_MS });
      setPlanError(null);
      setPlan(created);
    } catch (error) { setNotice({ tone: 'error', text: `${operation === 'open' ? '开仓' : '平仓'}方案未生成：${errorText(error)}` }); }
    finally { setPreparing(null); }
  }
  async function submit(limit: string) {
    if (!plan) return;
    const built = startBody(plan, '', limit);
    if ('error' in built) { setPlanError(built.error); return; }
    setSending(true);
    try {
      const accepted = await ids.current.run('start', `${plan.planId}|${limit.trim()}`, requestId => api<TaskAccepted>('/api/options/tasks', { body: { ...built.body, requestId }, timeoutMs: WRITE_TIMEOUT_MS }), startRefused);
      setPlan(null);
      setUnanswered(null);
      setRiskChecked(false);
      setNotice({ tone: 'info', text: `${accepted.operation === 'close' ? '平仓' : '开仓'}任务已受理（${STATUS_TEXT[accepted.status]}），进度见“组合执行”。` });
      location.hash = '#/options/orders';
      void state.refresh();
    } catch (error) {
      const refused = startRefused(error);
      setUnanswered(refused ? null : plan.planId);
      setPlanError(refused ? `服务拒绝：${errorText(error)}` : `${UNKNOWN_START}（${errorText(error)}）`);
      if (error instanceof ApiError && error.status === 401) onExpired();
    } finally { setSending(false); }
  }
  async function toggleAutoOpen(enabled: boolean) {
    if (!data?.schedule) return;
    if (enabled && !confirm(autoOpenConfirm(data.settings, data.schedule))) return;
    setToggling(true);
    try {
      await api('/api/options/auto-open', { body: { enabled }, timeoutMs: WRITE_TIMEOUT_MS });
      const running = data.tasks.some(task => task.scheduled && isActive(task));
      setNotice({ tone: 'info', text: enabled ? `定时开仓已打开：${scheduleTime(data.schedule)}。` : running ? '定时开仓已关闭；已受理的定时任务仍在执行，要停下请在“组合执行”里停止。' : '定时开仓已关闭。' });
      void state.refresh();
    } catch (error) {
      setNotice({ tone: 'error', text: `定时开仓开关未确认：${errorText(error)}；请刷新核对后再试` });
      if (error instanceof ApiError && error.status === 401) onExpired();
    } finally { setToggling(false); }
  }
  async function stop(task: Task) {
    if (!confirm(STOP_CONFIRM)) return;
    setStops(current => new Set(current).add(task.id));
    try {
      await api(`/api/options/tasks/${task.id}/stop`, { body: {}, timeoutMs: WRITE_TIMEOUT_MS });
      void state.refresh();
    } catch (error) { setNotice({ tone: 'error', text: `停止请求未确认：${errorText(error)}；请刷新核对后再试` }); }
    finally { setStops(current => { const next = new Set(current); next.delete(task.id); return next; }); }
  }

  const marketAt = market.data?.at ?? data?.market.at ?? null;
  // Off the desk tab the market is not read; the state carries the server's own verdict.
  const marketStale = market.data?.stale ?? data?.market.stale ?? true;
  const strip: string[] = [];
  if (data?.market.error) strip.push(`行情读取失败：${data.market.error}`);
  if (data?.reconciliation.error) strip.push(`对账：${data.reconciliation.error}`);
  if (data?.positionsError) strip.push(`持仓：${data.positionsError}`);
  if (data?.health && !data.health.available) strip.push(`账户：${data.health.message ?? '读取失败'}`);
  if (state.error) strip.push(`刷新失败：${state.error.message}`);
  const missed = data?.schedule?.lastError;
  if (missed) strip.push(`本周定时开仓未执行（${missed.week}）：${missed.message ?? '原因未知'}`);
  const schedule = data?.schedule ?? null;
  const canOpen = !busy && riskChecked && preview !== null && !riskProblem && quantity !== null && preparing === null && !(data?.tracked.legs.length);
  const canClose = !busy && preparing === null && (data?.tracked.legs.length ?? 0) > 0;
  return <div className="options-desk">
    <header className="ph">
      <div className="ph-main">
        <div className="ph-title"><h1>BTC 期权执行台</h1><span className="status-chip" data-mode="live">主网实盘 · {data?.account ?? '--'}</span></div>
        <div className="ph-meta"><span>周五开仓 / 周日到期</span><span className="sep" aria-hidden="true" /><a href="#/options/orders">{hero ? `${hero.type === 'close' ? '平仓' : '开仓'}执行中 · ${STATUS_TEXT[hero.status]}` : '当前无活动执行'}</a><span className="sep" aria-hidden="true" /><span>时间统一为 UTC</span></div>
      </div>
      <div className="ph-actions"><span className="update-state"><i data-stale={String(marketStale)} />{marketAt ? `行情 ${utcTime(marketAt).slice(6)} UTC${marketStale ? ' · 已过期' : ''}` : '行情同步中'}</span><button type="button" className="button ghost" onClick={refresh}>立即刷新</button></div>
    </header>
    <nav className="subnav" aria-label="期权页面">
      {TABS.map(item => <a key={item.tab} className={`tab${item.tab === tab ? ' active' : ''}`} href={item.href} aria-current={item.tab === tab ? 'page' : undefined}>{item.text}{item.tab === 'positions' && positionsCount ? <span className="count">{positionsCount}</span> : null}{item.tab === 'orders' && activeTasks.length ? <span className="count">{activeTasks.length}</span> : null}</a>)}
    </nav>
    <div className="strip">
      {data?.reconciliation.pendingOrders ? <span className="item strip-count">{data.reconciliation.pendingOrders} 笔订单未结束</span> : null}
      {strip.map(text => <span key={text} className="item strip-alert">{text}</span>)}
      <span className="item">{schedule?.enabled ? `定时开仓 ${scheduleTime(schedule)}` : '只手动开仓'}{schedule?.marketFallback ? ' + IOC 兜底' : ''} · 每腿 {data?.settings.legQty ?? '--'} BTC · 最大亏损上限 {data ? money(data.settings.maxRiskUsd) : '--'} · 保证金上限 {data ? money(data.settings.maxMarginUsd) : '--'}</span>
    </div>
    <main className="shell">
      {notice ? <p className={`orders-notice${notice.tone === 'error' ? ' loss' : ''}`} role="status">{notice.text}</p> : null}
      {tab === 'desk' ? <div className="tab-pane">
        <section className="panel kpi-panel" aria-label="策略指标"><div className="kpis">
          <article className="kpi"><span className="l">净权利金 <small>USD</small></span><strong>{money(preview?.netCreditUsd)}</strong><small>每组策略</small></article>
          <article className="kpi"><span className="l">最大亏损</span><strong>{preview?.unboundedLoss ? '无上限' : money(preview?.maxLossUsd)}</strong><small>风险上限 {data ? money(data.settings.maxRiskUsd) : '--'}</small></article>
          <article className="kpi"><span className="l">保证金需求</span><strong>{money(preview?.estimatedMarginUsd)}</strong><small>{preview ? marginLabel(preview.marginMode) : '官方公式估算'}</small></article>
          <article className="kpi"><span className="l">维护保证金</span><strong>{money(preview?.estimatedMaintenanceMarginUsd)}</strong><small>短期权 MM</small></article>
          <article className="kpi"><span className="l">交易成本</span><strong>{money(preview?.estimatedTradingCostUsd)}</strong><small>手续费率 {preview ? `${(preview.feeRate * 100).toFixed(3)}%` : '--'}</small></article>
          <article className="kpi metric-status"><span className="l">行情状态</span><strong>{market.data?.error ? '读取失败' : !marketAt ? '准备中' : marketStale ? '已过期' : '正常'}</strong><small>{marketAt ? `${utcTime(marketAt).slice(6)} UTC` : '等待行情'}</small></article>
        </div></section>
        <div className="desk-grid">
          <div className="stack desk-main">
            <ChainPanel market={market.data} preview={preview} />
            <StrategyPanel preview={preview} problem={riskProblem} />
            <GreeksPanel state={data} />
          </div>
          <div className="stack desk-side">
            <aside className="panel execution" aria-label="执行控制">
              <div className="panel-h"><h2>执行控制</h2><span className="lock-badge">{schedule?.marketFallback ? 'LIMIT / BBO + IOC' : 'LIMIT / BBO'}</span></div>
              <div className="execution-body">
                <div className="mode-box" data-mode="live"><span className="mode-icon" aria-hidden="true">!</span><div><strong>主网实盘</strong><p>确认后向 Bybit 发送真实期权限价单，按盘口最优价跟价。</p></div></div>
                <div className="execution-inputs">
                  <div className="field"><label htmlFor="optionsStrategy">开仓结构 <span>STRATEGY</span></label>
                    <select id="optionsStrategy" value={strategy} onChange={event => setMode(event.target.value as StrategyMode)}><option value="iron_condor">四腿铁鹰 · 带保护腿</option><option value="short_strangle">双腿卖出 · 无保护腿</option></select>
                    <small className="field-hint strategy-risk" data-unbounded={String(strategy === 'short_strangle')} role="status">{strategy === 'short_strangle' ? '不买保护腿，亏损无上限；按保证金上限控制风险。' : '买入远端保护腿，按最大亏损控制风险。'}</small></div>
                  <div className="field"><label htmlFor="optionsQuantity">每腿数量 <span>BTC</span></label>
                    <div className="quantity-row"><select aria-label="每腿数量预设" value={preset === '' ? (QUANTITY_PRESETS as readonly string[]).includes(quantityInput) ? quantityInput : 'custom' : preset} onChange={event => { setPreset(event.target.value); if (event.target.value === 'custom') setCustom(quantityInput); }}>
                      {QUANTITY_PRESETS.map(value => <option key={value} value={value}>{Number(value).toFixed(2)}</option>)}<option value="custom">自定义</option></select>
                      <input id="optionsQuantity" aria-label="自定义每腿数量" type="text" inputMode="decimal" value={preset === 'custom' ? custom : quantityInput} onChange={event => { setPreset('custom'); setCustom(event.target.value); }} /></div>
                    <small className="field-hint">调整数量后，自动重算保证金与交易成本。</small></div>
                </div>
                <label className="confirm"><input type="checkbox" checked={riskChecked} onChange={event => setRiskChecked(event.target.checked)} /><span>{strategy === 'short_strangle' ? '我已核对两腿、报价和保证金上限，了解亏损无上限' : '我已核对四腿、报价和风险上限'}</span></label>
                <button type="button" className="button primary" disabled={!canOpen} data-busy={preparing === 'open' ? '' : undefined} onClick={() => void prepare('open')}>{preparing === 'open' ? '正在生成方案…' : `实盘开仓${strategy === 'short_strangle' ? '两腿' : '四腿'}`}</button>
                <button type="button" className="button close-button" disabled={!canClose} data-busy={preparing === 'close' ? '' : undefined} onClick={() => void prepare('close')}>{preparing === 'close' ? '正在生成方案…' : '实盘平仓已跟踪持仓'}</button>
                <p className="microcopy">{busy ? '有任务或订单未结束，结束前不能开始新的开仓或平仓。' : data?.tracked.legs.length ? '已有跟踪中的策略：先平仓或在交易所平掉后，才能再开仓。' : '开仓与平仓先核对固定方案，再独立确认提交。实盘开仓只在周五（UTC）。'}</p>
              </div>
              <div className="schedule"><span>计划开仓 <small>{!schedule ? '读取中' : schedule.enabled ? schedule.waiting ? schedule.lastError ? '窗口中 · 本周未能开仓' : '窗口中 · 正在开仓' : `下次 ${utcTime(schedule.nextAt)} UTC` : schedule.source === 'page' && schedule.configEnabled ? '已在页面关闭（覆盖配置）' : '定时开仓已关闭'}</small></span>
                <span className="schedule-side"><strong>{schedule?.enabled ? `${scheduleTime(schedule)} · 自动` : '周五 · 手动'}</strong>
                  <button type="button" className="link-button" disabled={!schedule || toggling} data-busy={toggling ? '' : undefined} onClick={() => void toggleAutoOpen(!schedule?.enabled)}>{toggling ? '提交中…' : schedule?.enabled ? '关闭定时' : '打开定时'}</button></span></div>
            </aside>
            <HealthPanel state={data} />
          </div>
        </div>
      </div> : tab === 'positions' ? <div className="tab-pane"><div className="pos-grid">
        <Panel className="tracked-panel" title="跟踪策略" detail={<span className="muted">{data?.tracked.mode ? strategyName(data.tracked.mode) : '无'}</span>} right={data?.tracked.groupId ? `开仓任务 ${data.tracked.groupId}` : undefined}>
          {data?.tracked.legs.length ? <div className="positions">{data.tracked.legs.map(leg => <div className="position-row" key={`${leg.symbol}|${leg.side}`}><strong>{leg.symbol}</strong><span>{leg.side} · {quantityText(leg.size)}</span><span className="muted">跟踪数量</span></div>)}</div> : <div className="empty">没有跟踪中的策略</div>}
          <p className="panel-f">平仓只平跟踪数量。持仓在交易所被手动平掉时，须有交易所平仓历史且再读持仓仍不在，才会退役对应的腿。</p>
        </Panel>
        <section className="panel activity-panel" aria-label="仓位与事件">
          <div className="panel-h"><h2>仓位与事件</h2><div className="right"><button type="button" className="link-button" onClick={() => void state.refresh()}>刷新 ↗</button></div></div>
          <div className="subhead">当前仓位<span>POSITIONS</span></div>
          {data?.positions?.rows.length ? <div className="positions">{data.positions.rows.map(position => <div className="position-row" key={`${position.symbol}|${position.side}`}><strong>{position.symbol}</strong><span>{position.side} · {quantityText(position.size)}</span><span className={position.unrealisedPnl >= 0 ? 'pnl-positive' : 'pnl-negative'}>{money(position.unrealisedPnl)}</span></div>)}</div> : <div className="positions empty">{data?.positions ? '暂无持仓' : data?.positionsError ? `持仓读取失败：${data.positionsError}` : '等待持仓同步…'}</div>}
          <div className="subhead log-title">成交与手续费<span>FILLS</span></div>
          {data?.executions.length ? <div className="executions">{data.executions.map(item => <div className="execution-row" key={item.execId}><strong>{item.symbol}</strong><span>{item.side} {item.execQty.toFixed(4)} · {money(item.execPrice)}{item.chainPrice !== null ? ` · 链基准 ${item.chainPrice.toFixed(4)}` : ''} · {utcTime(item.execTime)}</span><span className="exec-fee">-{item.execFee.toFixed(6)} {item.feeCurrency}</span></div>)}</div> : <div className="executions empty">暂无成交记录</div>}
        </section>
      </div></div> : tab === 'performance' ? <div className="tab-pane"><PerformancePane onExpired={onExpired} choice={performanceChoice} onChoice={setPerformanceChoice} /></div> : <div className="tab-pane">
        <section className="panel orders-panel" aria-label="组合执行" data-state={state.error ? 'stale' : 'ready'}>
          <div className="panel-h"><h2>组合执行<span className="heading-detail">当前进度与净额</span></h2><span className="source-tag" id="ordersSyncState">{state.error ? '刷新失败' : state.receivedAt ? `已同步 ${utcTime(state.receivedAt).slice(6)}` : '等待同步'}</span></div>
          <div className="orders-toolbar"><span>执行中 {activeTasks.length} 组 · 最近结束 {history.length} 组</span><span>前台每 {busy ? 1 : 5} 秒</span></div>
          <div className="panel-b">
            {data ? <>
              <div className="execution-groups">{activeTasks.map(task => <TaskCard key={task.id} task={task} state={data} stopping={stops.has(task.id)} onStop={item => void stop(item)} />)}</div>
              {!activeTasks.length ? <div className="empty">当前无活动执行</div> : null}
              {history.length ? <details className="execution-history"><summary>最近结束的组合 · {history.length} 笔</summary><div className="execution-groups">{history.map(task => <TaskCard key={task.id} task={task} state={data} stopping={false} onStop={() => undefined} />)}</div></details> : null}
            </> : <div className="empty">{state.error ? `读取失败：${state.error.message}` : '等待执行任务同步…'}</div>}
          </div>
          <p className="orders-note">每次开仓或平仓按一笔组合跟踪。各腿数量单位 BTC；成交净额与手续费按实际币种展示，缺失金额待核对。停止只撤未成交委托，已成交部分保留。</p>
        </section>
      </div>}
    </main>
    <PlanDialog plan={plan} error={planError} sending={sending} pending={plan !== null && unanswered === plan.planId} fallback={data?.schedule?.marketFallback ?? false} onClose={() => {
      if (sending || (unanswered === plan?.planId && !confirm(LEAVE_UNANSWERED))) return;
      setPlan(null); setPlanError(null); setUnanswered(null); void state.refresh();
    }} onSubmit={limit => void submit(limit)} />
  </div>;
}
