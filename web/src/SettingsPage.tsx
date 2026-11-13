import { Settings2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from './api.ts';
import { ImportPanel } from './ImportPanel.tsx';
import { RequestIds } from './request-ids.ts';
import { TableEmpty } from './StateViews.tsx';
import { TRANSFER_FIELDS, defaultText, transferBody, transferChanges, transferDraft, type TransferDraft } from './transfer-form.ts';
import { useLiveResource } from './use-live-resource.ts';
import type { AdlPairView, PairView, ServiceState, ServiceStatus, TransferConfig } from './types.ts';

// A request keeps its id until an answer arrives; a changed input is a new request.
const requests = new RequestIds();
// Shared with the status page, so the same read options.
const STATUS_REFRESH_MS = 5_000;
type Message = { tone: 'ok' | 'err'; text: string } | null;
type AdlDraft = { autoReduce: boolean; batchNotional: string };

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

function TransferForm({ pair, onChanged }: { pair: PairView; onChanged: () => void }) {
  // What the operator typed survives the periodic refresh until it is saved; the saved answer shows until the refresh has it.
  const [draft, setDraft] = useState<TransferDraft | null>(null);
  const [saved, setSaved] = useState<TransferConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const storedKey = JSON.stringify(pair.config);
  useEffect(() => { setSaved(null); }, [storedKey]);
  const current = saved ?? pair.config;
  const input = draft ?? transferDraft(current);
  const save = async () => {
    const body = transferBody(input);
    if ('error' in body) { setMessage({ tone: 'err', text: body.error }); return; }
    const changes = transferChanges(current, body.config);
    if (!changes.length) { setDraft(null); setMessage({ tone: 'ok', text: '没有改动' }); return; }
    if (!confirm(`修改配对 ${pair.id} 的划转参数，保存后下一轮检查起生效：\n${changes.join('\n')}\n确定？`)) return;
    setBusy(true);
    try {
      const answer = await requests.run(`transfer-config:${pair.id}`, JSON.stringify(body.config), requestId =>
        api<PairView>(`/api/transfer-pairs/${encodeURIComponent(pair.id)}/config`, { body: { requestId, ...body.config } }));
      if (answer && typeof answer.config === 'object') setSaved(answer.config);
      setDraft(null);
      setMessage({ tone: 'ok', text: '已保存' });
      onChanged();
    } catch (error) { setMessage({ tone: 'err', text: errorText(error) }); }
    finally { setBusy(false); }
  };
  return <div className="settings-block" data-transfer-form={pair.id}>
    <h3 className="panel-subheading">保证金平衡划转</h3>
    <div className="settings-grid">
      {TRANSFER_FIELDS.map(field => <label key={field.key} className="settings-field">
        <span className="settings-label">{field.label}{field.unit ? `（${field.unit}）` : ''}</span>
        <input data-transfer-field={field.key} inputMode="decimal" value={input[field.key]} disabled={busy}
          onChange={event => { setDraft({ ...input, [field.key]: event.target.value }); setMessage(null); }} />
        <small className="muted">{field.hint}；默认 {defaultText(field.key)}</small>
      </label>)}
    </div>
    <div className="toolbar">
      <button type="button" className="button primary" data-transfer-save={pair.id} disabled={busy} onClick={save}>保存划转参数</button>
      {draft ? <button type="button" className="button secondary" disabled={busy} onClick={() => { setDraft(null); setMessage(null); }}>放弃修改</button> : null}
      {message ? <span className={message.tone} role="status" data-transfer-message={pair.id}>{message.text}</span> : null}
    </div>
  </div>;
}

function AdlForm({ pair, onChanged }: { pair: AdlPairView; onChanged: () => void }) {
  const [draft, setDraft] = useState<AdlDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const input = draft ?? { autoReduce: pair.config.autoReduce, batchNotional: pair.config.batchNotional };
  const save = async () => {
    const body = { autoReduce: input.autoReduce, batchNotional: input.batchNotional.trim() };
    setBusy(true);
    try {
      await requests.run(`adl-config:${pair.pairId}`, JSON.stringify(body), requestId => api(`/api/adl/pairs/${encodeURIComponent(pair.pairId)}/config`, { body: { requestId, ...body } }));
      setDraft(null);
      setMessage({ tone: 'ok', text: '已保存' });
      onChanged();
    } catch (error) { setMessage({ tone: 'err', text: errorText(error) }); }
    finally { setBusy(false); }
  };
  return <div className="settings-block adl-settings" data-adl-pair={pair.pairId}>
    <h3 className="panel-subheading">ADL 应急处理</h3>
    <label className="check"><input type="checkbox" data-adl-auto={pair.pairId} checked={input.autoReduce} disabled={busy} onChange={event => { setDraft({ ...input, autoReduce: event.target.checked }); setMessage(null); }} /> 自动减仓</label>
    <label className="inline-field">单批上限 <input data-adl-notional={pair.pairId} inputMode="decimal" value={input.batchNotional} disabled={busy} onChange={event => { setDraft({ ...input, batchNotional: event.target.value }); setMessage(null); }} /> USDT</label>
    <div className="toolbar">
      <button type="button" className="button secondary" data-adl-save={pair.pairId} disabled={busy} onClick={save}>保存 ADL 设置</button>
      {message ? <span className={message.tone} role="status">{message.text}</span> : null}
    </div>
  </div>;
}

function Weight({ onExpired }: { onExpired: () => void }) {
  const { data } = useLiveResource<ServiceStatus>('/api/status', { intervalMs: STATUS_REFRESH_MS, onExpired });
  const weight = data?.idleWeight;
  if (!weight) return null;
  const over = weight.needed > weight.available;
  return <p className={over ? 'panel-note err' : 'panel-note'} data-idle-weight>
    按当前检查间隔，配对空闲时每分钟约需请求权重 {weight.needed}，可用 {weight.available}（每分钟上限 {weight.limitPerMinute} 减去 ADL 预留 {weight.adlReserve}）。
    {over ? '已超出：超出部分的请求会被限速器拒绝，请调大检查间隔。' : '改短检查间隔时，超出可用额度会被拒绝并给出能用的最短间隔。'}
  </p>;
}

/** Each pair's transfer and ADL settings, and the workbench import. */
export function SettingsPage({ state, stale, onChanged, onExpired }: { state: ServiceState; stale: boolean; onChanged: () => void; onExpired: () => void }) {
  const adl = new Map(state.adl.pairs.map(pair => [pair.pairId, pair]));
  return <>
    <section className="panel">
      <div className="panel-heading"><h2><Settings2 size={16} aria-hidden="true" />配对设置</h2><span className="count-label">{state.transfers.pairs.length}</span></div>
      <p className="panel-note">这里的设置保存在本服务的数据库里，配置文件 config.json 中的 transfer 与 adl 只在配对第一次登记时作为初始值。配对启用中也可以修改，已发出的划转不受影响。</p>
      <Weight onExpired={onExpired} />
      {stale ? <p className="panel-note err">页面数据不是最新的，保存前请等刷新恢复。</p> : null}
      {state.transfers.pairs.length ? state.transfers.pairs.map(pair => <div key={pair.id} className="settings-pair" data-settings-pair={pair.id}>
        <h3>{pair.id} <span className={pair.enabled ? 'ok' : 'muted'}>{pair.enabled ? '已启用' : '已停用'}</span></h3>
        <TransferForm pair={pair} onChanged={onChanged} />
        {adl.get(pair.id) ? <AdlForm pair={adl.get(pair.id)!} onChanged={onChanged} /> : <p className="muted">ADL 设置在配对启用后显示。</p>}
      </div>) : <TableEmpty>没有划转配对</TableEmpty>}
    </section>
    <ImportPanel onImported={onChanged} />
  </>;
}
