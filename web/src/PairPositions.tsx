import { ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import { formatNumber as fmt } from './number-format.ts';
import { POSITION_STATE, SIDE, label, seconds, stamp } from './labels.ts';
import type { PositionRow, PositionSideView, PositionsPair, PositionsView, Side } from './types.ts';

// Laid out after the workbench's pair-account-positions.tsx / account-positions-table.tsx (modules/aster/dashboard,
// b2fae14). The service reads no leverage, margin or liquidation price, so those columns are left out.

const profitClass = (value: string): string => !value.trim() || !Number.isFinite(Number(value)) ? '' : Number(value) < 0 ? 'danger' : 'mint';

function PositionsTable({ rows, label: name, stale }: { rows: PositionRow[]; label: string; stale: boolean }) {
  return <div className="table-scroll account-positions-table">
    <table aria-label={name}>
      <thead><tr>
        <th>市场 / 方向</th><th className="number">数量</th><th className="number">开仓均价</th><th className="number">标记价格</th>
        <th className="number">名义价值</th><th className="number">未实现盈亏</th><th className="number">交易所更新</th>
      </tr></thead>
      <tbody>{rows.map(row => <tr key={`${row.symbol}:${row.positionSide}:${row.direction}`} className={stale ? 'stale-row' : undefined}>
        <td>
          <div className="position-market"><strong>{row.symbol}</strong>{stale ? <span className="stale-tag">旧</span> : null}</div>
          <span className={`direction ${row.direction === 'long' ? 'mint' : 'danger'}`}>
            {row.direction === 'long' ? <ArrowUpRight size={14} /> : <ArrowDownLeft size={14} />} {row.direction === 'long' ? '多仓' : '空仓'}{row.positionSide === 'BOTH' ? '（单向持仓模式）' : ''}
          </span>
        </td>
        <td className="number">{row.quantity}</td><td className="number">{row.entryPrice}</td><td className="number">{row.markPrice}</td>
        <td className="number">{fmt(row.notional)}</td><td className={`number ${profitClass(row.unrealizedProfit)}`}>{fmt(row.unrealizedProfit)}</td>
        <td className="number">{stamp(row.updateTime)}</td>
      </tr>)}</tbody>
    </table>
  </div>;
}

/** One side's account positions. stale: the page's last refresh failed, so the rows are older than they look. */
export function PairAccountPositions({ side, view, refreshMs, maxAgeMs, stale }: { side: Side; view: PositionSideView | null; refreshMs: number; maxAgeMs: number; stale: boolean }) {
  const name = side === 'long' ? 'A' : 'B';
  const title = `${name} 账户完整持仓`;
  const old = stale || view?.state === 'retained';
  const warning = !view || view.state === 'retained' || view.state === 'unavailable';
  return <section className="panel pair-account-positions" aria-label={title} data-positions-side={side}>
    <div className="section-head">
      <div className="pair-positions-title">
        <h2>{name} · 账户持仓</h2>
        <span className="muted">{label(SIDE, side)} {view?.account ?? '账户待确认'}</span>
        <span className="count">完整持仓 {view && view.state !== 'pending' && view.state !== 'unavailable' ? view.positions.length : '—'}</span>
      </div>
      <span className={warning ? 'small-note amber' : 'small-note'}>
        {view ? `${label(POSITION_STATE, view.state)}${view.sampledAt ? ` · ${stamp(view.sampledAt)}` : ''}` : '尚未读取'}
      </span>
    </div>
    <div className="pair-positions-notes">
      <p>只读：每 {seconds(refreshMs)} 秒读取一次，有效期 {seconds(maxAgeMs)} 秒；数量为基础币，价格与金额为计价币。</p>
      {view?.note ? <p className="amber">{view.note}</p> : null}
      {stale ? <p className="amber">页面数据未能刷新，下面是上次读到的持仓，不代表当前。</p> : null}
    </div>
    {view && view.positions.length ? <PositionsTable rows={view.positions} label={title} stale={old} />
      : <p className="pair-positions-empty">{!view || view.state === 'pending' ? '尚未读取持仓' : view.state === 'unavailable' ? '持仓暂不可用' : '无持仓'}</p>}
  </section>;
}

/** Both accounts' totals per contract; the ADL tolerance decides whether the pair is hedged. */
export function PairTotals({ pair }: { pair: PositionsPair | null }) {
  return <section className="panel pair-account-positions" aria-label="两侧多空核对" data-positions-pair={pair?.pairId}>
    <div className="section-head">
      <div className="pair-positions-title"><h2>两侧多空核对</h2></div>
      <span className="small-note">偏差不超过较大一侧的 0.5% 视为一致</span>
    </div>
    {!pair || !pair.totals ? <p className="pair-positions-empty">{pair?.verdictNote ?? '两侧持仓都读取成功后才核对'}</p>
      : !pair.totals.length ? <p className="pair-positions-empty">两侧均无持仓</p>
        : <div className="table-scroll"><table aria-label="两侧多空核对">
          <thead><tr><th>合约</th><th className="number">A 多侧净持仓</th><th className="number">B 空侧净持仓</th><th className="number">两侧合计</th><th>多空总量</th></tr></thead>
          <tbody>{pair.totals.map(row => <tr key={row.symbol}>
            <td><strong>{row.symbol}</strong></td><td className="number">{row.long}</td><td className="number">{row.short}</td><td className="number">{row.total}</td>
            <td>{row.balanced === null ? <span className="muted">未判断（{pair.verdictNote}）</span>
              : row.balanced ? <span className="mint">{Number(row.total) === 0 ? '一致' : `偏差 ${row.gapPercent}%，在 0.5% 内`}</span>
                : <span className="danger">偏差 {row.gapPercent}%，超过 0.5%</span>}</td>
          </tr>)}</tbody>
        </table></div>}
  </section>;
}

export const positionsOf = (view: PositionsView, pairId: string): PositionsPair | null => view.pairs.find(item => item.pairId === pairId) ?? null;
