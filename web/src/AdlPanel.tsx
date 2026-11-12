import { ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from './api.ts';
import { RequestIds } from './request-ids.ts';
import { TableEmpty } from './StateViews.tsx';
import { ADL_BATCH, ADL_PROGRESS, ADL_STATUS, DIRECTION, SIDE, clock, label, seconds } from './labels.ts';
import type { AdlIncident, AdlPairView, ServiceState } from './types.ts';

// A request keeps its id until an answer arrives; a changed setting is a new request.
const requests = new RequestIds();
type Draft = { autoReduce: boolean; batchNotional: string };

function Progress({ incident }: { incident: AdlIncident }) {
  const rows = Object.entries(incident.progress || {});
  if (!rows.length) return <span className="muted">尚未读取现场</span>;
  return <>{rows.map(([symbol, entry]) => <div key={symbol}>
    {symbol} {label(ADL_PROGRESS, entry.status)}{entry.direction ? ` · 多出${label(DIRECTION, entry.direction)}仓 ${entry.residual}` : ''}
    {entry.reason ? <div className="muted">{entry.reason}</div> : null}
  </div>)}</>;
}

function Batches({ incident }: { incident: AdlIncident }) {
  if (!incident.batches.length) return <span className="muted">没有减仓批次</span>;
  return <div className="table-wrap"><table className="data">
    <thead><tr><th>时间</th><th>侧</th><th>合约</th><th>减仓</th><th>成交</th><th>状态</th><th>备注</th></tr></thead>
    <tbody>{incident.batches.map((batch, index) => <tr key={index}>
      <td>{clock(batch.sentAt || batch.preparedAt)}</td><td>{label(SIDE, batch.side)} {batch.account}</td><td>{batch.symbol} {batch.positionSide}</td>
      <td>{batch.orderSide === 'sell' ? '卖' : '买'} {batch.quantity}</td><td>{batch.filledQuantity ?? '—'}{batch.averagePrice ? ` @ ${batch.averagePrice}` : ''}</td>
      <td>{label(ADL_BATCH, batch.state)}{batch.recovered ? '（接管恢复）' : ''}{batch.cancelRequested ? '（已撤单）' : ''}</td><td>{batch.note}</td>
    </tr>)}</tbody>
  </table></div>;
}

function Incident({ incident, onChanged }: { incident: AdlIncident; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  // A restart that took effect (the incident left halted, or its restart count moved) ends the pending request: halting
  // again later needs a new request, not a replay of the first one.
  useEffect(() => { if (incident.status !== 'halted') requests.answered(`restart:${incident.id}`); }, [incident.id, incident.status]);
  const restart = async () => {
    if (!confirm('重新开始自动减仓：重置处理时限与批次计数，重新核对现场后继续分批市价减仓。确定？')) return;
    setBusy(true);
    try {
      await requests.run(`restart:${incident.id}`, String(incident.restarts), requestId => api(`/api/adl/incidents/${encodeURIComponent(incident.id)}/restart`, { body: { requestId } }));
      onChanged();
    } catch (error) { alert(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <div className="adl-incident" data-adl-incident={incident.id}>
    <div><b>{label(ADL_STATUS, incident.status)}</b> · 事件 <span className="mono">{incident.id.slice(0, 8)}</span> · 合约 {incident.symbols.join('、')} · 处理时长 {seconds(incident.activeMs)} 秒 · 本轮批次 {incident.batchesSinceRestart}
      {incident.restarts ? ` · 已重新开始 ${incident.restarts} 次` : ''}{incident.watchUntil ? ` · 观察至 ${clock(incident.watchUntil)}` : ''}</div>
    <div>{incident.reason}</div>
    {incident.residuals.length ? <div>残差：{incident.residuals.map(item => `${item.symbol} 多出${label(DIRECTION, item.direction)}仓 ${item.quantity}`).join('、')}</div> : null}
    {incident.status === 'halted' ? <div className="adl-actions">
      <button type="button" className="button primary" data-adl-restart={incident.id} disabled={busy} onClick={restart}>重新开始自动减仓</button>
      <span className="muted">（重置时限与批次计数，所有安全检查照常）</span>
    </div> : null}
    <div className="muted">ADL 证据：</div>
    {incident.evidence.length ? incident.evidence.map((item, index) => <div key={index}>
      {label(SIDE, item.side)} {item.symbol} {item.positionSide || ''} ADL 成交 {item.filledQuantity}{item.conflict ? <> <span className="err">{item.conflict}</span></> : null}
    </div>) : <div>—</div>}
    <div className="muted">各合约进度：</div>
    <Progress incident={incident} />
    <Batches incident={incident} />
  </div>;
}

function PairRow({ pair, draft, setDraft, onChanged }: { pair: AdlPairView; draft: Draft | undefined; setDraft: (value: Draft | undefined) => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  // What the operator typed survives the periodic refresh until it is saved.
  const input = draft ?? { autoReduce: pair.config.autoReduce, batchNotional: pair.config.batchNotional };
  const save = async () => {
    const body = { autoReduce: input.autoReduce, batchNotional: input.batchNotional.trim() };
    setBusy(true);
    try {
      await requests.run(`config:${pair.pairId}`, JSON.stringify(body), requestId => api(`/api/adl/pairs/${encodeURIComponent(pair.pairId)}/config`, { body: { requestId, ...body } }));
      setDraft(undefined);
      onChanged();
    } catch (error) { alert(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const scan = pair.scans ? (['long', 'short'] as const).map(side => <div key={side}>
    {label(SIDE, side)} 已查至 {clock(pair.scans![side].coveredUntil)}{pair.scans![side].pendingWindows ? ` 待查 ${pair.scans![side].pendingWindows} 段` : ''}
    {pair.scans![side].note ? <> <span className="err">{pair.scans![side].note}</span></> : null}
  </div>) : '尚未开始';
  return <tr data-adl-pair={pair.pairId}>
    <td>{pair.pairId}<br /><span className="muted">多 {pair.long} / 空 {pair.short}</span>{pair.shared ? <><br /><span className="err">{pair.shared}</span></> : null}</td>
    <td className="adl-settings">
      <label className="check"><input type="checkbox" data-adl-auto={pair.pairId} checked={input.autoReduce} onChange={event => setDraft({ ...input, autoReduce: event.target.checked })} /> 自动减仓</label>
      <label className="inline-field">单批上限 <input data-adl-notional={pair.pairId} inputMode="decimal" value={input.batchNotional} onChange={event => setDraft({ ...input, batchNotional: event.target.value })} /> USDT</label>
      <button type="button" className="button secondary" data-adl-save={pair.pairId} disabled={busy} onClick={save}>保存</button>
    </td>
    <td>{scan}</td>
    <td>{pair.incident ? <Incident incident={pair.incident} onChanged={onChanged} /> : <span className="muted">无进行中的 ADL 事件</span>}</td>
  </tr>;
}

export function AdlPanel({ state, onChanged }: { state: ServiceState; onChanged: () => void }) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const finished = state.adl.recent.filter(incident => incident.status === 'completed');
  const setDraft = (pairId: string) => (value: Draft | undefined) => setDrafts(current => {
    const next = { ...current };
    if (value) next[pairId] = value; else delete next[pairId];
    return next;
  });
  return <section className="panel">
    <div className="panel-heading"><h2><ShieldAlert size={16} aria-hidden="true" />ASTER ADL 应急处理</h2></div>
    <p className="panel-note">交易所自动减仓后，配对两侧多空总量偏差超过较大一侧的 0.5% 时，按只减仓市价单分批减少多出的一侧，直到两侧相等后自动结束；偏差在 0.5% 内不减仓、直接完成。结果未知的减仓单不重发，有界核对后按新现场继续；不足最小下单量的残差记为完成。</p>
    {state.adl.pairs.length ? <div className="table-wrap"><table className="data">
      <thead><tr><th>配对</th><th>设置</th><th>ADL 历史扫描</th><th>当前事件</th></tr></thead>
      <tbody>{state.adl.pairs.map(pair => <PairRow key={pair.pairId} pair={pair} draft={drafts[pair.pairId]} setDraft={setDraft(pair.pairId)} onChanged={onChanged} />)}</tbody>
    </table></div> : <TableEmpty>没有划转配对</TableEmpty>}
    {finished.length ? <>
      <h3 className="panel-subheading">最近结束的 ADL 事件</h3>
      <div className="table-wrap"><table className="data">
        <thead><tr><th>事件</th><th>开始</th><th>结束</th><th>合约</th><th>结论</th><th>批次</th></tr></thead>
        <tbody>{finished.map(incident => <tr key={incident.id}>
          <td className="mono">{incident.id.slice(0, 8)}{incident.parentId ? <><br /><span className="muted">续 {incident.parentId.slice(0, 8)}</span></> : null}</td>
          <td>{clock(incident.createdAt)}</td><td>{clock(incident.closedAt)}</td><td>{incident.symbols.join('、')}</td><td>{incident.reason}</td><td>{incident.totalBatches}</td>
        </tr>)}</tbody>
      </table></div>
    </> : null}
  </section>;
}
