import { ArrowLeftRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from './api.ts';
import { RequestIds } from './request-ids.ts';
import { TableEmpty } from './StateViews.tsx';
import { SIDE, TRANSFER_STATE, clock, label } from './labels.ts';
import type { PairView, ServiceState, TransferView } from './types.ts';

// A switch keeps its requestId only while no answer arrived, so a lost response is replayed safely.
const switches = new RequestIds();

export function transferText(item: TransferView): string {
  return `${label(SIDE, item.sourceSide)} → ${label(SIDE, item.destinationSide)} ${item.amount} ${item.asset} · ${label(TRANSFER_STATE, item.state)}`
    + (item.readyAt ? `（${clock(item.readyAt)} 后结算）` : '') + (item.recovered ? '（接管恢复）' : '');
}

function PairRow({ pair, onChanged }: { pair: PairView; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  // Once the page shows the switch in a state, a request for that state whose answer was lost has taken effect (or is
  // moot): its id is dropped, so a later click for the same state, after switching back, is a new request and not a replay.
  useEffect(() => { switches.answered(`${pair.id}:${pair.enabled ? 1 : 0}`); }, [pair.id, pair.enabled]);
  const side = (name: 'long' | 'short') => pair.balances ? `可用 ${pair.balances[name].available} / 权益 ${pair.balances[name].equity} / 可划 ${pair.balances[name].maxWithdraw}` : '未读取';
  const wait = pair.blocked || (pair.cooldownUntil > Date.now() ? `冷却至 ${clock(pair.cooldownUntil)}` : '');
  const toggle = async () => {
    const enable = !pair.enabled;
    setBusy(true);
    try {
      await switches.run(`${pair.id}:${enable ? 1 : 0}`, '', requestId => api(`/api/transfer-pairs/${encodeURIComponent(pair.id)}/${enable ? 'enable' : 'disable'}`, { body: { requestId }, timeoutMs: 60_000 }));
      onChanged();
    } catch (error) { alert(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <tr data-pair-row={pair.id}>
    <td><a href={`#/pair/${encodeURIComponent(pair.id)}`}>{pair.id}</a><br /><span className="muted">主 {pair.mainAccountId}</span></td>
    <td className={pair.enabled ? 'ok' : 'muted'}>{pair.enabled ? '已启用' : '已停用'}</td>
    <td>多侧 {pair.long}：{side('long')}<br />空侧 {pair.short}：{side('short')}</td>
    <td>{pair.current ? transferText(pair.current) : '无未结清划转'}</td>
    <td>{wait}{wait && pair.note ? '；' : ''}{pair.note}</td>
    <td><button type="button" className={`button ${pair.enabled ? 'secondary' : 'primary'}`} data-pair={pair.id} disabled={busy} onClick={toggle}>{pair.enabled ? '停用' : '启用'}</button></td>
  </tr>;
}

export function PairsPanel({ state, onChanged }: { state: ServiceState; onChanged: () => void }) {
  const { pairs, corruptPairs, recent } = state.transfers;
  return <section className="panel">
    <div className="panel-heading"><h2><ArrowLeftRight size={16} aria-hidden="true" />ASTER 保证金平衡</h2><span className="count-label">{pairs.length}</span></div>
    <p className="panel-note">在配对的多侧与空侧子账户之间划转 USD1。结果未知的划转不重发，原请求过期后核对两侧流水并自动结算。</p>
    {pairs.length ? <div className="table-wrap"><table className="data">
      <thead><tr><th>配对</th><th>开关</th><th>两侧余额（USD1）</th><th>当前划转</th><th>说明</th><th></th></tr></thead>
      <tbody>{pairs.map(pair => <PairRow key={pair.id} pair={pair} onChanged={onChanged} />)}</tbody>
    </table></div> : <TableEmpty>没有划转配对</TableEmpty>}
    {corruptPairs.length ? <p className="panel-note err">配对记录损坏，未列出也不会划转，需人工处置：{corruptPairs.join('，')}</p> : null}
    {recent.length ? <>
      <h3 className="panel-subheading">最近划转</h3>
      <div className="table-wrap"><table className="data">
        <thead><tr><th>划转</th><th>配对</th><th>时间</th><th>方向、金额与状态</th><th>结算依据</th><th>备注</th></tr></thead>
        <tbody>{recent.map(item => <tr key={item.id}>
          <td className="mono">{item.id.slice(0, 8)}</td><td>{item.pairId}</td><td>{clock(item.preparedAt)}</td><td>{transferText(item)}</td>
          <td>{item.basis}{item.receipt ? ` ${item.receipt}` : ''}</td><td>{item.labelNote || item.note}</td>
        </tr>)}</tbody>
      </table></div>
    </> : null}
  </section>;
}
