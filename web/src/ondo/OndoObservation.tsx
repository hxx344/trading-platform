import { useState } from 'react';
import { TableEmpty } from '../StateViews.tsx';
import type { OndoObservation } from './ondo-mm-types.ts';

function duration(ms: number) {
  if (ms < 1000) return ms > 0 ? '<1 秒' : '0 秒';
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return (hours ? `${hours} 小时 ` : '') + (hours || minutes ? `${minutes} 分 ` : '') + `${seconds % 60} 秒`;
}

const rateFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
function Count({ count, perHour, sampled }: { count: number; perHour: number | null; sampled: boolean }) {
  const rate = perHour !== null && perHour > 0 && perHour < 0.01 ? '<0.01' : perHour === null ? null : rateFormat.format(perHour);
  return <td className="num">{sampled ? `${count} 次` : '—'}<small>{rate === null ? '—' : `${rate} 次/小时`}</small></td>;
}

export function OndoObservationPanel({ data, ready, stale, period }: {
  data: OndoObservation | null; ready: boolean; stale: boolean; period: string;
}) {
  const [selected, setSelected] = useState('');
  const markets = [...new Set(data?.rows.map(row => row.market))];
  const market = markets.includes(selected) ? selected : markets[0];
  const rows = data?.rows.filter(row => row.market === market) ?? [];
  const status = !data ? '' : data.endedAt !== null ? '观察已停止，本次结果已保留'
    : stale ? '页面未更新，显示上次读取的结果' : ready ? '观察中' : '盘口或逐笔未连接，暂停计时';
  return <section className="panel" aria-label="观察触价统计">
    <div className="panel-heading"><h2>观察触价统计</h2>{data ? <div className="or-heading-tools">
      <span className="muted">{status}</span>
      {markets.length > 1 ? <label className="or-window">市场<select value={market} onChange={event => setSelected(event.target.value)}>
        {markets.map(name => <option key={name}>{name}</option>)}
      </select></label> : <span>{market}</span>}
    </div> : null}</div>
    {!data ? <TableEmpty>暂无观察记录。启动观察后，比较 4、8、15 bps 的虚拟买卖单。</TableEmpty> : <>
      <p className="panel-note">{period}{rows.some(row => row.activeMs > 0 || row.touches > 0) ? '' : ' · 这个市场暂无有效虚挂样本'}</p>
      <div className="om-table" role="region" aria-label={`${market ?? ''} 观察明细`} tabIndex={0}><table>
        <thead><tr><th scope="col">方向</th><th scope="col" className="num">目标距离</th><th scope="col" className="num">有效虚挂时长</th>
          <th scope="col" className="num">触价（含扫过）</th><th scope="col" className="num">扫过</th></tr></thead>
        <tbody>{rows.map(row => {
          const sampled = row.activeMs > 0 || row.touches > 0;
          return <tr key={`${row.side}-${row.distanceBps}`}><th scope="row">{row.side === 'buy' ? '买' : '卖'}</th>
            <td className="num">{row.distanceBps} bps</td><td className="num">{duration(row.activeMs)}</td>
            <Count count={row.touches} perHour={row.touchesPerHour} sampled={sampled} />
            <Count count={row.sweeps} perHour={row.sweepsPerHour} sampled={sampled} />
          </tr>;
        })}</tbody>
      </table></div>
      <p className="muted om-form or-note">对手方逐笔成交达到或越过虚挂价都记触价，严格越过还记扫过。每张虚拟单各最多记一次。
        各行只累计该侧有效虚挂的时长，满 60 秒显示每小时次数。触价和扫过均为观察值，无法确认实盘成交。</p>
    </>}
  </section>;
}
