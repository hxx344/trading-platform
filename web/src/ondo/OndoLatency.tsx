import { useState } from 'react';
import type { OndoLatencyMarket, OndoLatencyMetric, OndoLatencySnapshot } from '../../../src/vendor/ondo/latency.mjs';
import { TableEmpty } from '../StateViews.tsx';

const liveMetrics = [
  ['restQueue', 'REST 令牌排队'], ['cancelAck', '撤单确认'], ['placeAck', '开仓挂单确认'],
  ['withdraw', '保护撤单全程'], ['replace', '同侧撤旧至改挂确认'],
] as const satisfies readonly [keyof OndoLatencyMarket, string][];
const ms = (value: number | null) => value === null ? '—' : value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const time = (at: number | null) => at === null ? '—' : new Date(at).toLocaleTimeString('zh-CN', { hour12: false });

function MetricRow({ name, metric, note }: { name: string; metric: OndoLatencyMetric; note?: string }) {
  return <tr><th scope="row">{name}{note ? <small>{note}</small> : null}</th>
    <td className="num">{ms(metric.lastMs)}{metric.lastAt !== null ? <small>{time(metric.lastAt)}</small> : null}</td>
    <td className="num">{ms(metric.p50Ms)}</td><td className="num">{ms(metric.p95Ms)}</td>
    <td className="num">{metric.n ? `${metric.n} 个` : '暂无样本'}
      {metric.failed > 0 ? <small className="om-hold">{metric.failed} 次未获确认 · {time(metric.lastFailureAt)}</small> : null}</td></tr>;
}

export function OndoLatencyPanel({ data, connected, stale }: { data?: OndoLatencySnapshot | null; connected: boolean; stale: boolean }) {
  const [selected, setSelected] = useState('');
  const market = data?.markets.find(item => item.market === selected) ?? data?.markets[0];
  return <section className="panel" aria-label="行情与订单延迟">
    <div className="panel-heading"><h2>行情与订单延迟</h2>{data ? <span className="muted">{data.mode === 'live' ? '实盘' : '观察'} · {data.stoppedAt !== null ? `已停止于 ${time(data.stoppedAt)}` : stale ? '页面数据过期' : !connected ? '公开行情未连接' : '采样中'}</span> : null}</div>
    {!data || !market ? <TableEmpty>启动会话后显示延迟样本。</TableEmpty> : <>
      <div className="oo-results-heading"><label className="or-window">延迟市场<select value={market.market} onChange={event => setSelected(event.target.value)}>
        {data.markets.map(item => <option key={item.market}>{item.market}</option>)}</select></label>
        <span className="muted">最近 {data.windowMs / 60_000} 分钟 · 每项最多 {data.maxSamples} 次</span></div>
      <div className="om-table" role="region" aria-label={`${market.market} 延迟指标`} tabIndex={0}><table>
        <thead><tr><th scope="col">指标</th><th scope="col" className="num">最近 ms</th><th scope="col" className="num">P50 ms</th>
          <th scope="col" className="num">P95 ms</th><th scope="col" className="num">成功样本</th></tr></thead>
        <tbody>
          <MetricRow name="盘口到达时差" metric={market.bboAge} note={market.clockAheadN > 0 ? `${market.clockAheadN} 个样本的交易所时钟领先` : undefined} />
          <MetricRow name="盘口收帧间隔" metric={market.bookInterval} />
          <MetricRow name="WebSocket 心跳往返" metric={data.wsRtt} note="本会话共用" />
          {data.mode === 'live' ? liveMetrics.map(([key, name]) => <MetricRow key={key} name={name} metric={market[key]} />) : null}
        </tbody>
      </table></div>
      <p className="muted oo-note">盘口时差按服务收帧时间减交易所时间计算，包含两地时钟偏差。负值表示交易所时钟领先。P50 是中位数，P95 覆盖 95% 的成功样本。
        {data.mode === 'observe' ? '观察仅订阅公开数据，订单延迟在实盘产生实际请求后显示。'
          : '保护撤单从发起到无成交撤销确认，包含排队。同侧改挂从超出最远距离后撤旧单起，到异价新单确认止。'}</p>
    </>}
  </section>;
}
