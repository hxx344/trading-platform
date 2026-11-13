import { ArrowLeftRight, Layers, LineChart, ShieldAlert } from 'lucide-react';
import { useCallback } from 'react';
import { BalanceChart } from './BalanceChart.tsx';
import { Batches, Progress } from './AdlPanel.tsx';
import { transferText } from './PairsPanel.tsx';
import { SideBlock, Totals } from './PositionsPanel.tsx';
import { StatePanel, TableEmpty } from './StateViews.tsx';
import { ADL_STATUS, BASIS, clock, label, seconds, stamp } from './labels.ts';
import { isUnreadable, usePagedHistory, type HistoryRow } from './paged-history.ts';
import { pairHref } from './route.ts';
import type { AdlIncident, PairView, ServiceState, TransferView } from './types.ts';

const TRANSFER_PAGE = 20, ADL_PAGE = 10, HISTORY_REFRESH_MS = 5_000;
const transferAt = (row: HistoryRow<TransferView>) => row.preparedAt ?? 0;
const incidentAt = (row: HistoryRow<AdlIncident>) => row.createdAt ?? 0;

function Summary({ pair }: { pair: PairView }) {
  const c = pair.config;
  const side = (name: 'long' | 'short') => pair.balances ? `可用 ${pair.balances[name].available} / 权益 ${pair.balances[name].equity} / 可划 ${pair.balances[name].maxWithdraw}（${clock(pair.balances[name].receivedAt)}）` : '未读取';
  return <div className="panel-body">
    <dl className="facts">
      <dt>状态</dt><dd className={pair.enabled ? 'ok' : 'muted'}>{pair.enabled ? '已启用' : '已停用'}{pair.blocked ? <span className="err"> · {pair.blocked}</span> : null}{pair.cooldownUntil > Date.now() ? ` · 冷却至 ${clock(pair.cooldownUntil)}` : ''}</dd>
      <dt>主账户</dt><dd className="mono">{pair.mainAccountId}</dd>
      <dt>多侧</dt><dd><span className="mono">{pair.long}</span><br />{side('long')}</dd>
      <dt>空侧</dt><dd><span className="mono">{pair.short}</span><br />{side('short')}{pair.balances && !pair.balancesFresh ? <span className="err"> · 余额已过期</span> : null}</dd>
      <dt>划转设置</dt><dd>差额阈值 {c.threshold} · 单次 {c.minTransfer}–{c.maxTransfer} USD1 · 缓冲比例 {c.bufferRatio} · 保留 多 {c.longReserve} / 空 {c.shortReserve} · 冷却 {seconds(c.cooldownMs)} 秒 · 每 {seconds(c.checkIntervalMs)} 秒检查</dd>
      <dt>下次检查</dt><dd>{pair.enabled ? clock(pair.nextCheckAt) : '—'}</dd>
      {pair.note ? <><dt>说明</dt><dd className={pair.noteIdle ? 'muted' : 'err'}>{pair.note}</dd></> : null}
      <dt>当前划转</dt><dd>{pair.current ? transferText(pair.current) : '无未结清划转'}</dd>
    </dl>
  </div>;
}

function TransferDetail({ item }: { item: TransferView }) {
  return <details>
    <summary>{transferText(item)}</summary>
    <dl className="facts small">
      <dt>结算依据</dt><dd>{item.basis ? label(BASIS, item.basis) : '尚未结算'}</dd>
      {item.labelNote ? <><dt>判定</dt><dd>{item.labelNote}</dd></> : null}
      {item.receipt ? <><dt>回执</dt><dd className="mono">{item.receipt}</dd></> : null}
      {item.tranId ? <><dt>交易所流水号</dt><dd className="mono">{item.tranId}</dd></> : null}
      <dt>流水核对</dt><dd>找到 {item.evidence} 条对应记录{item.baseline.length ? `；发送前已有基线：${item.baseline.map(side => side === 'source' ? '转出侧' : '转入侧').join('、')}` : ''}</dd>
      <dt>时间</dt><dd>落盘 {stamp(item.preparedAt)} · 发送 {stamp(item.sentAt)} · 回执 {stamp(item.ackAt)} · 结算 {stamp(item.settledAt)} · 余额刷新 {stamp(item.balancesRefreshedAt)}</dd>
      {item.note ? <><dt>备注</dt><dd>{item.note}</dd></> : null}
    </dl>
  </details>;
}

function More({ more, loading, error, onMore }: { more: boolean; loading: boolean; error: string | null; onMore: () => void }) {
  if (!more && !error) return null;
  return <div className="toolbar history-more">
    {more ? <button type="button" className="button secondary" disabled={loading} onClick={onMore}>{loading ? '读取中…' : '加载更早的记录'}</button> : null}
    {error ? <span className="err">读取失败：{error}</span> : null}
  </div>;
}

function TransferHistory({ pairId, onExpired }: { pairId: string; onExpired: () => void }) {
  const { live, rows, more, loadMore, loading, error } = usePagedHistory<TransferView>(`/api/transfer-pairs/${encodeURIComponent(pairId)}/history`, { limit: TRANSFER_PAGE, intervalMs: HISTORY_REFRESH_MS, at: transferAt, onExpired });
  if (!live.data && !rows.length) return live.status === 'error' || live.status === 'offline' ? <StatePanel kind="error" title="读取划转记录失败" detail={live.error?.message ?? '网络离线'} /> : <StatePanel kind="loading" title="加载中…" />;
  return <>
    {live.error ? <p className="panel-note err">刷新失败：{live.error.message}（显示的是上次结果）</p> : null}
    {rows.length ? <div className="table-wrap"><table className="data history">
      <thead><tr><th>时间 / 编号</th><th>划转与结果（点开看结算依据）</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.id}>
        <td>{stamp(transferAt(row))}<br /><span className="mono muted">{row.id.slice(0, 8)}</span></td>
        <td>{isUnreadable(row) ? <span className="err">这条记录无法解析</span> : <TransferDetail item={row} />}</td>
      </tr>)}</tbody>
    </table></div> : <TableEmpty>还没有划转记录</TableEmpty>}
    <More more={more} loading={loading} error={error} onMore={() => void loadMore()} />
  </>;
}

function IncidentRow({ incident }: { incident: AdlIncident }) {
  return <details>
    <summary>{label(ADL_STATUS, incident.status)} · {incident.symbols.join('、')} · {incident.reason}</summary>
    <div className="adl-incident">
      <div className="muted">开始 {stamp(incident.createdAt)} · 结束 {stamp(incident.closedAt)} · 批次 {incident.totalBatches}（显示最近 20 批）{incident.restarts ? ` · 重新开始 ${incident.restarts} 次` : ''}</div>
      <Progress incident={incident} />
      <Batches incident={incident} />
    </div>
  </details>;
}

function AdlHistory({ pairId, onExpired }: { pairId: string; onExpired: () => void }) {
  const { live, rows, more, loadMore, loading, error } = usePagedHistory<AdlIncident>(`/api/adl/pairs/${encodeURIComponent(pairId)}/incidents`, { limit: ADL_PAGE, intervalMs: HISTORY_REFRESH_MS, at: incidentAt, onExpired });
  if (!live.data && !rows.length) return live.status === 'error' || live.status === 'offline' ? <StatePanel kind="error" title="读取 ADL 记录失败" detail={live.error?.message ?? '网络离线'} /> : <StatePanel kind="loading" title="加载中…" />;
  return <>
    {live.error ? <p className="panel-note err">刷新失败：{live.error.message}（显示的是上次结果）</p> : null}
    {rows.length ? <div className="table-wrap"><table className="data history">
      <thead><tr><th>时间</th><th>事件（点开看进度与减仓批次）</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.id}>
        <td>{stamp(incidentAt(row))}</td>
        <td>{isUnreadable(row) ? <span className="err">这条记录无法解析（{row.id.slice(0, 8)}）</span> : <IncidentRow incident={row} />}</td>
      </tr>)}</tbody>
    </table></div> : <TableEmpty>没有 ADL 事件</TableEmpty>}
    <More more={more} loading={loading} error={error} onMore={() => void loadMore()} />
  </>;
}

/** One pair: settings and balances, the balance trend, its transfers, positions and ADL incidents. Read only. */
export function PairDetail({ state, pairId, stale, onExpired }: { state: ServiceState; pairId: string | null; stale: boolean; onExpired: () => void }) {
  const pairs = state.transfers.pairs;
  const id = pairId ?? pairs[0]?.id ?? null;
  const pair = pairs.find(item => item.id === id) ?? null;
  const positions = state.positions.pairs.find(item => item.pairId === id) ?? null;
  const pick = useCallback((next: string) => { location.hash = pairHref(next); }, []);
  if (!pairs.length) return <StatePanel kind="empty" title="还没有配对" detail="在「总览」导入或登记配对后，这里显示每个配对的详情。" />;
  return <>
    <div className="toolbar">
      <label className="pair-pick">配对 <select value={id ?? ''} onChange={event => pick(event.target.value)}>
        {pair ? null : <option value={id ?? ''}>{id}（不存在）</option>}
        {pairs.map(item => <option key={item.id} value={item.id}>{item.id}{item.enabled ? '' : '（停用）'}</option>)}
      </select></label>
      {stale ? <span className="err">上方状态未能刷新，下方配对信息可能不是最新</span> : null}
    </div>
    {!pair || !id ? <StatePanel kind="empty" title="没有这个配对" detail="它可能已被删除；从上方选择一个配对。" /> : <>
      <section className="panel">
        <div className="panel-heading"><h2><ArrowLeftRight size={16} aria-hidden="true" />配对 {pair.id}</h2></div>
        <Summary pair={pair} />
      </section>
      <section className="panel">
        <div className="panel-heading"><h2><LineChart size={16} aria-hidden="true" />两侧可用余额走势</h2></div>
        <BalanceChart key={id} pairId={id} onExpired={onExpired} />
      </section>
      <section className="panel">
        <div className="panel-heading"><h2><ArrowLeftRight size={16} aria-hidden="true" />划转记录</h2></div>
        <p className="panel-note">最新一页每 5 秒刷新；更早的记录按需读取，读取后不再刷新。</p>
        <TransferHistory key={id} pairId={id} onExpired={onExpired} />
      </section>
      <section className="panel">
        <div className="panel-heading"><h2><Layers size={16} aria-hidden="true" />持仓（只读）</h2></div>
        <div className="panel-body">{positions ? <>
          <SideBlock name="long" side={positions.long} />
          <SideBlock name="short" side={positions.short} />
          <Totals pair={positions} />
        </> : <span className="muted">{state.positions.available ? '尚未读取这个配对的持仓' : '持仓读取不可用'}</span>}</div>
      </section>
      <section className="panel">
        <div className="panel-heading"><h2><ShieldAlert size={16} aria-hidden="true" />ADL 事件</h2></div>
        <p className="panel-note">处理中的事件与操作在「总览」的 ADL 面板；这里列出该配对的全部事件，最新一页每 5 秒刷新。</p>
        <AdlHistory key={id} pairId={id} onExpired={onExpired} />
      </section>
    </>}
  </>;
}
