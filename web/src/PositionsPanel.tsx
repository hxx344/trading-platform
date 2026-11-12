import { Layers } from 'lucide-react';
import { Callout, TableEmpty } from './StateViews.tsx';
import { DIRECTION, POSITION_STATE, SIDE, clock, label, seconds } from './labels.ts';
import type { PositionSideView, PositionsPair, PositionsView } from './types.ts';

function SideBlock({ name, side }: { name: 'long' | 'short'; side: PositionSideView }) {
  const tone = side.state === 'fresh' ? 'ok' : side.state === 'pending' ? 'muted' : 'err';
  return <div className="position-side">
    <div>{label(SIDE, name)} {side.account} · <span className={tone}>{label(POSITION_STATE, side.state)}</span>
      {side.sampledAt ? ` · 采样于 ${clock(side.sampledAt)}（${seconds(side.ageMs)} 秒前）` : ''}</div>
    {side.note ? <div className="muted">{side.note}</div> : null}
    {side.positions.length ? <div className="table-wrap"><table className="data">
      <thead><tr><th>合约</th><th>方向</th><th>数量</th><th>开仓均价</th><th>标记价</th><th>名义价值</th><th>未实现盈亏</th><th>交易所更新</th></tr></thead>
      <tbody>{side.positions.map(row => <tr key={`${row.symbol}:${row.positionSide}:${row.direction}`}>
        <td>{row.symbol}</td><td>{label(DIRECTION, row.direction)}{row.positionSide === 'BOTH' ? '（单向持仓模式）' : ''}</td><td className="num">{row.quantity}</td><td className="num">{row.entryPrice}</td>
        <td className="num">{row.markPrice}</td><td className="num">{row.notional}</td><td className="num">{row.unrealizedProfit}</td><td>{clock(row.updateTime)}</td>
      </tr>)}</tbody>
    </table></div> : side.state === 'fresh' || side.state === 'retained' ? <div className="muted">无持仓</div> : null}
  </div>;
}

function Totals({ pair }: { pair: PositionsPair }) {
  if (!pair.totals) return <span className="muted">两侧持仓都有效时才汇总</span>;
  if (!pair.totals.length) return <span className="muted">两侧均无持仓</span>;
  return <div className="table-wrap"><table className="data">
    <thead><tr><th>合约</th><th>多侧账户净持仓</th><th>空侧账户净持仓</th><th>两侧合计</th><th>多空总量</th></tr></thead>
    <tbody>{pair.totals.map(row => <tr key={row.symbol}>
      <td>{row.symbol}</td><td className="num">{row.long}</td><td className="num">{row.short}</td><td className="num">{row.total}</td>
      <td>{row.balanced === null ? <span className="muted">未判断（{pair.verdictNote}）</span>
        : row.balanced ? <span className="ok">{Number(row.total) === 0 ? '一致' : `偏差 ${row.gapPercent}%，在 0.5% 内`}</span>
          : <span className="err">偏差 {row.gapPercent}%，超过 0.5%</span>}</td>
    </tr>)}</tbody>
  </table></div>;
}

/** stale: the last refresh failed, so the rows below are the ones from shownAt and must not read as current. */
export function PositionsPanel({ view, stale, shownAt }: { view: PositionsView; stale: boolean; shownAt: number | null }) {
  return <section className="panel">
    <div className="panel-heading"><h2><Layers size={16} aria-hidden="true" />ASTER 账户持仓（只读）</h2></div>
    <p className="panel-note">定时读取每个配对多侧与空侧子账户的全部持仓，只展示，不下单。某次读取失败时继续显示上次结果并注明，超过有效期后不再显示；两侧最新读取都成功时才判断多空总量是否一致（偏差不超过较大一侧的 0.5% 算一致）。</p>
    {stale ? <div className="panel-body"><Callout tone="error">页面数据未更新，下方持仓停留在 {clock(shownAt)} 的结果，不代表当前</Callout></div> : null}
    {!view.available ? <TableEmpty>未接入 ASTER 持仓读取</TableEmpty> : !view.pairs.length ? <TableEmpty>没有划转配对</TableEmpty> : <div className="panel-body">
      <p className="muted">每 {seconds(view.refreshMs)} 秒读取一次，有效期 {seconds(view.maxAgeMs)} 秒；数量为基础币，价格与金额为计价币。</p>
      {view.pairs.map(pair => <div key={pair.pairId} className="position-pair" data-positions-pair={pair.pairId}>
        <h3>{pair.pairId}{pair.enabled ? '' : <span className="muted">（划转已停用）</span>}</h3>
        <SideBlock name="long" side={pair.long} />
        <SideBlock name="short" side={pair.short} />
        <div className="muted">按合约汇总：</div>
        <Totals pair={pair} />
      </div>)}
    </div>}
  </section>;
}
