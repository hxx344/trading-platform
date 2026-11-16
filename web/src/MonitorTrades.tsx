// 价格图上的成交标记与「套利成交」面板（A-5），照工作台 modules/monitor/app/spread-chart.tsx（提交 7745181）的 TradeMark、
// TradePanel 与 lib/hub-fills.ts 的 useHubFills。与工作台的差异：
// - 成交从本服务 /api/asset/fills?market=… 读（use-live-resource.ts），代替工作台经 iframe 桥接向宿主要数据：有范围在读
//   （pending）且本次读取成功时每 5 秒跟读一次，连续最多 36 次（3 分钟）后回到每 5 分钟；读取失败或不再 pending 立即回到
//   每 5 分钟；每次例行读取重新计数（规则在 monitor-trades.ts followUpStep，照工作台 hub-fills-contract.ts createFillsPoller）；
// - 服务没有资产账本（404）时面板只显示一行说明，图上不画标记；
// - Anthropic 的原生来源覆盖说明不做（A-5 不做 anthropic）。
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ApiError } from './api.ts';
import { useLiveResource } from './use-live-resource.ts';
import { FILLS_FOLLOW_UP_MS, FILLS_REFRESH_MS, FOLLOW_UP_IDLE, TRADE_TEXT, TRADE_TYPES, emptyFillsView, fillsPending, followUpStep, fillItems, fillsStatusText, spreadText, summarizeTradeEvents, tradeDetailLines, type FillsView, type SpreadTradeMarker, type TradeSummary, type TradeType } from './monitor-trades.ts';
import type { FillMarket, HubFills } from '../../src/asset/fills-types.ts';

export const FILLS_TIMEOUT_MS = 20_000;
const beijingFormatter = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
export const beijing = (time: number | string) => beijingFormatter.format(new Date(time));
const markerText = ({ value, unit }: SpreadTradeMarker) => spreadText(value, unit);

/** Successful reads replace the snapshot; a failed read keeps the last one, marked retained. */
export function useFills(market: FillMarket, onExpired: () => void): FillsView {
  const [followUp, setFollowUp] = useState(false);
  const step = useRef(FOLLOW_UP_IDLE);
  const live = useLiveResource<HubFills>(`/api/asset/fills?market=${market}`, { intervalMs: followUp ? FILLS_FOLLOW_UP_MS : FILLS_REFRESH_MS, timeoutMs: FILLS_TIMEOUT_MS, onExpired });
  const data = live.data, { receivedAt, error } = live;
  // Every reply changes receivedAt (success) or the error object (failure); a failure keeps the old data, so it is judged by error.
  useEffect(() => {
    if (receivedAt === null && error === null) return;
    step.current = followUpStep(step.current, { ok: error === null, pending: fillsPending(data) });
    setFollowUp(step.current.follow);
  }, [receivedAt, error]); // once per reply: data is read with the reply it came with
  const missing = live.error instanceof ApiError && live.error.status === 404;
  const failed = live.status === 'error' || live.status === 'offline';
  return useMemo(() => missing ? emptyFillsView('missing') : data ? { status: 'ok', ...fillItems(data, Date.now(), market), retained: failed } : failed ? emptyFillsView('unavailable') : emptyFillsView('loading'), [missing, data, failed, market]);
}

/** Drawn at the marker's chart value; labels stay React text, never markup. */
export function TradeMark({ cx, cy, marker, selected, onSelect }: { cx: number; cy: number; marker: SpreadTradeMarker; selected: boolean; onSelect: (key: string) => void }) {
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return <g />;
  const type = TRADE_TYPES[marker.event.type], select = () => onSelect(marker.event.key);
  return <g className="trade-marker" data-trade-type={marker.event.type} data-selected={selected || undefined} transform={`translate(${cx},${cy})`} tabIndex={0} role="button"
    aria-label={`${marker.venueLabel ? `${marker.venueLabel} ` : ''}${type.label} · ${beijing(marker.event.time)} 北京时间 · ${marker.basis} ${markerText(marker)}，查看成交明细`}
    onClick={select} onMouseEnter={select} onFocus={select} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(); } }}>
    <circle r={12} fill="transparent" />
    <text textAnchor="middle" dy=".35em" aria-hidden="true">{type.symbol}</text>
  </g>;
}

export function TradePanel({ trades, markers, selected, onSelect, chartMarkers, market, spreadTabs }: { trades: FillsView; markers: SpreadTradeMarker[]; selected: SpreadTradeMarker | null; onSelect: (key: string) => void; chartMarkers: boolean; market: FillMarket; spreadTabs: string }) {
  const titleId = useId(), text = TRADE_TEXT[market];
  const summaries = useMemo(() => summarizeTradeEvents(markers.map(marker => marker.event), market), [markers, market]);
  const rows: { time: number; key: string; summary: TradeSummary | null; marker: SpreadTradeMarker | null }[] = [
    ...summaries.map(summary => ({ time: summary.start, key: summary.key, summary, marker: null })),
    ...markers.filter(marker => marker.event.type !== 'entry' && marker.event.type !== 'exit').map(marker => ({ time: marker.event.time, key: marker.event.key, summary: null, marker })),
  ].sort((a, b) => b.time - a.time || a.key.localeCompare(b.key));
  const summarySpread = (group: TradeSummary['groups'][number]) => group.spread === null ? '未知' : `${group.spread.toFixed(3)}${market === 'hynix' ? '%' : ` ${group.currency}${text.priceUnit}`}`;
  const eventButton = (marker: SpreadTradeMarker) => {
    const type = TRADE_TYPES[marker.event.type];
    return <button type="button" key={marker.event.key} className="trade-list-item" data-trade-type={marker.event.type} aria-pressed={selected?.event.key === marker.event.key} onClick={() => onSelect(marker.event.key)}>
      {`${type.symbol} ${beijing(marker.event.time)} · ${marker.venueLabel ? `${marker.venueLabel} ` : ''}${type.label} · ${marker.event.fills.length} 笔 · ${marker.basis} ${markerText(marker)}`}
    </button>;
  };
  if (trades.status === 'missing') return <section className="trade-panel" aria-labelledby={titleId}><h3 id={titleId}>套利成交</h3><p className="trade-status" role="status">本服务没有配置资产账本，成交标记不显示。</p></section>;
  return <section className="trade-panel" aria-labelledby={titleId}>
    <h3 id={titleId}>套利成交</h3>
    <p className="trade-status" role="status">{fillsStatusText(trades, beijing)}</p>
    <p className="trade-legend">{(Object.keys(TRADE_TYPES) as TradeType[]).map(key => <span key={key} data-trade-type={key}>{TRADE_TYPES[key].symbol} {key === 'trade' ? '成交（开平未知）' : TRADE_TYPES[key].label}</span>)}<span className="trade-legend-note">{chartMarkers ? '颜色只区分类型，不表示盈亏' : `切换到${spreadTabs}可在图上查看标记`}</span></p>
    <div className="trade-summary-list" aria-label="当前区间套利成交">
      {!markers.length && <p>{trades.status === 'ok' && !trades.pending && !trades.incomplete ? '当前图表区间暂无套利成交' : '当前图表区间暂无可展示成交'}</p>}
      {rows.map(({ summary, marker }) => summary ? <details className="trade-summary" data-trade-type={summary.type} key={summary.key}>
        <summary><strong>{TRADE_TYPES[summary.type].symbol} {TRADE_TYPES[summary.type].label}汇总</strong><span>{summary.fillCount} 笔 · {summary.groups.length === 1 ? `加权成交${text.metricName} ${summarySpread(summary.groups[0]!)}` : `${summary.groups.length} 组账户 / 方向`}</span><span className="trade-summary-range">{beijing(summary.start)} — {beijing(summary.end)}</span></summary>
        <div className="trade-summary-totals">{summary.groups.map((group, index) => <div className="trade-summary-venue" key={group.key}>
          <strong>{summary.groups.length > 1 ? `${index + 1}. ` : ''}{group.source} · {group.exchange} · {group.account} · {group.scope} · {group.direction}{group.stale ? ' · 保留旧数据' : ''}</strong>
          <p>加权成交{text.metricName} {summarySpread(group)}{group.spread === null ? '（缺少唯一配对的双腿）' : ''}</p>
          {group.legs.map(leg => <p key={leg.key}>{leg.symbol} · {leg.side === 'buy' ? '买' : '卖'} · {leg.positionSide === 'net' ? '净持仓' : leg.positionSide === 'long' ? '多头' : '空头'} · 数量 {leg.quantity} {leg.quantityUnit} · 均价 {leg.price} {group.currency}{text.priceUnit}</p>)}
        </div>)}</div>
        <div className="trade-list" aria-label={`${TRADE_TYPES[summary.type].label}各批成交`}>{markers.filter(item => summary.eventKeys.includes(item.event.key)).reverse().map(eventButton)}</div>
      </details> : marker && eventButton(marker))}
      {summaries.length > 0 && <p className="trade-summary-note">按北京时间同日、持仓连续的同向分批成交汇总 · 均价按数量加权</p>}
    </div>
    {selected && <div className="trade-details" tabIndex={0} aria-label="套利成交明细">{tradeDetailLines(selected, beijing, text).join('\n')}</div>}
  </section>;
}
