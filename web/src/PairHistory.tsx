import { StatePanel } from './StateViews.tsx';
import { ADL_BATCH, ADL_PROGRESS, ADL_STATUS, BASIS, DIRECTION, TRANSFER_STATE, clock, label, stamp } from './labels.ts';
import { isUnreadable, usePagedHistory, type HistoryRow } from './paged-history.ts';
import type { AdlIncident, TransferView } from './types.ts';

// A pair's transfer and ADL records, shown inside the workspace's disclosures. Read only.

const TRANSFER_PAGE = 20, ADL_PAGE = 10, HISTORY_REFRESH_MS = 5_000;
const transferAt = (row: HistoryRow<TransferView>) => row.preparedAt ?? 0;
const incidentAt = (row: HistoryRow<AdlIncident>) => row.createdAt ?? 0;

/** The workbench's A/B naming: A is the long side, B the short side. */
export const sideName = (side: 'long' | 'short'): string => side === 'long' ? 'A' : 'B';

export function transferText(item: TransferView): string {
  return `${sideName(item.sourceSide)} → ${sideName(item.destinationSide)} · ${item.amount} ${item.asset} · ${label(TRANSFER_STATE, item.state)}`
    + (item.readyAt ? `（${clock(item.readyAt)} 后结算）` : '') + (item.recovered ? '（接管恢复）' : '');
}

export function Progress({ incident }: { incident: AdlIncident }) {
  const rows = Object.entries(incident.progress || {});
  if (!rows.length) return <p className="muted">尚未读取现场</p>;
  return <>{rows.map(([symbol, entry]) => <p key={symbol}>
    <strong>{symbol}</strong> {label(ADL_PROGRESS, entry.status)}{entry.direction ? ` · 多出${label(DIRECTION, entry.direction)}仓 ${entry.residual}` : ''}
    {entry.reason ? <><br /><span className="muted">{entry.reason}</span></> : null}
  </p>)}</>;
}

export function Batches({ incident }: { incident: AdlIncident }) {
  if (!incident.batches.length) return <p className="muted">没有减仓批次</p>;
  return <div className="table-scroll"><table aria-label="减仓批次">
    <thead><tr><th>时间</th><th>侧</th><th>合约</th><th className="number">减仓</th><th className="number">成交</th><th>状态</th><th>备注</th></tr></thead>
    <tbody>{incident.batches.map((batch, index) => <tr key={index}>
      <td>{clock(batch.sentAt || batch.preparedAt)}</td><td>{sideName(batch.side)} {batch.account}</td><td>{batch.symbol} {batch.positionSide}</td>
      <td className="number">{batch.orderSide === 'sell' ? '卖' : '买'} {batch.quantity}</td><td className="number">{batch.filledQuantity ?? '—'}{batch.averagePrice ? ` @ ${batch.averagePrice}` : ''}</td>
      <td>{label(ADL_BATCH, batch.state)}{batch.recovered ? '（接管恢复）' : ''}{batch.cancelRequested ? '（已撤单）' : ''}</td><td>{batch.note}</td>
    </tr>)}</tbody>
  </table></div>;
}

function TransferDetail({ item }: { item: TransferView }) {
  return <details className="disclosure">
    <summary>{transferText(item)}</summary>
    <dl className="saved-settings">
      <div><dt>结算依据</dt><dd>{item.basis ? label(BASIS, item.basis) : '尚未结算'}{item.labelNote ? <small>{item.labelNote}</small> : null}</dd></div>
      {item.receipt || item.tranId ? <div><dt>回执 / 交易所流水号</dt><dd>{item.receipt ?? '—'}<small>{item.tranId ?? '—'}</small></dd></div> : null}
      <div><dt>流水核对</dt><dd>找到 {item.evidence} 条对应记录<small>{item.baseline.length ? `发送前已有基线：${item.baseline.map(side => side === 'source' ? '转出侧' : '转入侧').join('、')}` : '发送前没有基线记录'}</small></dd></div>
      <div><dt>时间</dt><dd>落盘 {stamp(item.preparedAt)}<small>发送 {stamp(item.sentAt)} · 回执 {stamp(item.ackAt)} · 结算 {stamp(item.settledAt)} · 余额刷新 {stamp(item.balancesRefreshedAt)}</small></dd></div>
      {item.note ? <div><dt>备注</dt><dd>{item.note}</dd></div> : null}
    </dl>
  </details>;
}

function More({ more, loading, error, onMore }: { more: boolean; loading: boolean; error: string | null; onMore: () => void }) {
  if (!more && !error) return null;
  return <div className="form-actions">
    {more ? <button type="button" className="button secondary" data-slot="button" disabled={loading} onClick={onMore}>{loading ? '读取中…' : '加载更早的记录'}</button> : null}
    {error ? <span className="danger">读取失败：{error}</span> : null}
  </div>;
}

export function TransferHistory({ pairId, onExpired }: { pairId: string; onExpired: () => void }) {
  const { live, rows, more, loadMore, loading, error } = usePagedHistory<TransferView>(`/api/transfer-pairs/${encodeURIComponent(pairId)}/history`, { limit: TRANSFER_PAGE, intervalMs: HISTORY_REFRESH_MS, at: transferAt, onExpired });
  if (!live.data && !rows.length) return live.status === 'error' || live.status === 'offline' ? <StatePanel kind="error" title="读取划转记录失败" detail={live.error?.message ?? '网络离线'} /> : <StatePanel kind="loading" title="加载中…" />;
  return <div className="disclosure-body" data-transfer-history={pairId}>
    <p className="muted">最新一页每 5 秒刷新；更早的记录按需读取，读取后不再刷新。点开一笔看结算依据。</p>
    {live.error ? <p className="amber">刷新失败：{live.error.message}（显示的是上次结果）</p> : null}
    {rows.length ? <div className="table-scroll"><table aria-label="划转记录">
      <thead><tr><th>时间 / 编号</th><th>划转与结果</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.id}>
        <td>{stamp(transferAt(row))}<br /><span className="muted">{row.id.slice(0, 8)}</span></td>
        <td>{isUnreadable(row) ? <span className="danger">这条记录无法解析</span> : <TransferDetail item={row} />}</td>
      </tr>)}</tbody>
    </table></div> : <p className="pair-positions-empty">还没有划转记录</p>}
    <More more={more} loading={loading} error={error} onMore={() => void loadMore()} />
  </div>;
}

function IncidentRow({ incident }: { incident: AdlIncident }) {
  return <details className="disclosure">
    <summary>{label(ADL_STATUS, incident.status)} · {incident.symbols.join('、')} · {incident.reason}</summary>
    <div className="pair-adl-incident">
      <p className="muted">开始 {stamp(incident.createdAt)} · 结束 {stamp(incident.closedAt)} · 批次 {incident.totalBatches}（显示最近 20 批）{incident.restarts ? ` · 重新开始 ${incident.restarts} 次` : ''}</p>
      <Progress incident={incident} />
      <Batches incident={incident} />
    </div>
  </details>;
}

export function AdlHistory({ pairId, onExpired }: { pairId: string; onExpired: () => void }) {
  const { live, rows, more, loadMore, loading, error } = usePagedHistory<AdlIncident>(`/api/adl/pairs/${encodeURIComponent(pairId)}/incidents`, { limit: ADL_PAGE, intervalMs: HISTORY_REFRESH_MS, at: incidentAt, onExpired });
  if (!live.data && !rows.length) return live.status === 'error' || live.status === 'offline' ? <StatePanel kind="error" title="读取 ADL 记录失败" detail={live.error?.message ?? '网络离线'} /> : <StatePanel kind="loading" title="加载中…" />;
  return <div className="disclosure-body" data-adl-history={pairId}>
    <p className="muted">该配对的全部 ADL 事件，最新一页每 5 秒刷新；进行中的事件与操作在右侧「ADL 应急处理」。</p>
    {live.error ? <p className="amber">刷新失败：{live.error.message}（显示的是上次结果）</p> : null}
    {rows.length ? <div className="table-scroll"><table aria-label="ADL 事件记录">
      <thead><tr><th>时间</th><th>事件（点开看进度与减仓批次）</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.id}>
        <td>{stamp(incidentAt(row))}</td>
        <td>{isUnreadable(row) ? <span className="danger">这条记录无法解析（{row.id.slice(0, 8)}）</span> : <IncidentRow incident={row} />}</td>
      </tr>)}</tbody>
    </table></div> : <p className="pair-positions-empty">没有 ADL 事件</p>}
    <More more={more} loading={loading} error={error} onMore={() => void loadMore()} />
  </div>;
}

