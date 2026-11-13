import { useEffect, useState, type ReactNode } from 'react';
import { ApiError, api } from './api.ts';
import { RequestIds } from './request-ids.ts';
import { TRANSFER_FIELDS, defaultText, transferBody, transferChanges, transferDraft, type TransferDraft } from './transfer-form.ts';
import type { AdlPairView, PairView, TransferConfig } from './types.ts';

// One pair's transfer and ADL settings, laid out after the workbench's pair-settings.tsx (modules/aster/dashboard,
// b2fae14): fieldsets with a legend, two columns of labelled inputs, the actions underneath. The two parts are saved
// separately because the service stores them through two endpoints.

// A request keeps its id until an answer arrives; a changed input is a new request.
const requests = new RequestIds();
type Message = { tone: 'ok' | 'err'; text: string } | null;
type AdlDraft = { autoReduce: boolean; batchNotional: string };
const STALE_TITLE = '页面数据不是最新的，等刷新恢复后再保存';

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** The workbench's ConfigurationField: label, unit on the right, input, note. */
function Field({ id, label, unit, children, ...input }: { id: string; label: string; unit?: string; children?: ReactNode; value: string; disabled: boolean; onChange: (value: string) => void; data: Record<string, string> }) {
  return <label htmlFor={id}>
    {label}{unit ? <> <span>{unit}</span></> : null}
    <input id={id} data-slot="input" type="text" inputMode="decimal" value={input.value} disabled={input.disabled} {...input.data}
      onChange={event => input.onChange(event.target.value)} />
    {children}
  </label>;
}

/** An error above the actions (the workbench's message-error); a success next to the buttons. */
function Note({ message, data, inline }: { message: Message; data?: Record<string, string>; inline: boolean }) {
  if (!message || (message.tone === 'err') === inline) return null;
  return message.tone === 'err' ? <p className="message message-error" role="alert" {...data}>{message.text}</p>
    : <span className="mint" role="status" {...data}>{message.text}</span>;
}

function TransferForm({ pair, stale, onChanged }: { pair: PairView; stale: boolean; onChanged: () => void }) {
  // What the operator typed survives the periodic refresh until it is saved; the saved answer shows until the refresh has it.
  // A draft remembers the stored settings it started from: the server refuses the save when they changed meanwhile.
  const [draft, setDraft] = useState<{ values: TransferDraft; expected: TransferConfig } | null>(null);
  const [saved, setSaved] = useState<TransferConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const storedKey = JSON.stringify(pair.config);
  useEffect(() => { setSaved(null); }, [storedKey]);
  const current = saved ?? pair.config;
  const input = draft?.values ?? transferDraft(current);
  const expected = draft?.expected ?? current;
  const edit = (values: TransferDraft) => { setDraft({ values, expected }); if (!conflict) setMessage(null); };
  const reload = () => { setDraft(null); setSaved(null); setConflict(false); setMessage(null); onChanged(); };
  const save = async () => {
    const body = transferBody(input);
    if ('error' in body) { setMessage({ tone: 'err', text: body.error }); return; }
    const changes = transferChanges(expected, body.config);
    if (!changes.length) { setDraft(null); setMessage({ tone: 'ok', text: '没有改动' }); return; }
    if (!confirm(`修改配对 ${pair.id} 的划转参数，保存后下一轮检查起生效：\n${changes.join('\n')}\n确定？`)) return;
    setBusy(true);
    try {
      const answer = await requests.run(`transfer-config:${pair.id}`, JSON.stringify({ expected, config: body.config }), requestId =>
        api<PairView>(`/api/transfer-pairs/${encodeURIComponent(pair.id)}/config`, { body: { requestId, expected, ...body.config } }));
      if (answer && typeof answer.config === 'object') setSaved(answer.config);
      setDraft(null);
      setConflict(false);
      setMessage({ tone: 'ok', text: '已保存' });
      onChanged();
    } catch (error) {
      // Changed from another page: the input stays, and the operator chooses to load the latest settings.
      if (error instanceof ApiError && error.code === 'config_changed') {
        setConflict(true);
        setMessage({ tone: 'err', text: `${error.message}（输入已保留；点「载入最新值」会放弃这里的修改）` });
        onChanged();
      } else setMessage({ tone: 'err', text: errorText(error) });
    } finally { setBusy(false); }
  };
  return <form className="pair-settings-form form-stack" data-transfer-form={pair.id} onSubmit={event => { event.preventDefault(); if (!busy && !stale) void save(); }}>
    <fieldset className="settings-form-grid">
      <legend>自动保证金平衡</legend>
      {TRANSFER_FIELDS.map(field => <Field key={field.key} id={`${pair.id}-transfer-${field.key}`} label={field.label} unit={field.unit || undefined}
        value={input[field.key]} disabled={busy} data={{ 'data-transfer-field': field.key }} onChange={value => edit({ ...input, [field.key]: value })}>
        <small>{field.hint}；默认 {defaultText(field.key)}</small>
      </Field>)}
      <p className="muted">以两侧 USD1 可用余额差的一半为平衡目标，遵循交易所可划额度、单次上限和现金保留。配对启用中也可以修改，保存后下一轮检查起生效，已发出的划转不受影响。</p>
    </fieldset>
    <Note message={message} data={{ 'data-transfer-message': pair.id }} inline={false} />
    <div className="form-actions">
      <button type="submit" className="button primary" data-slot="button" data-transfer-save={pair.id} disabled={busy || stale} title={stale ? STALE_TITLE : undefined}>保存划转参数</button>
      {conflict ? <button type="button" className="button secondary" data-slot="button" data-transfer-reload={pair.id} disabled={busy} onClick={reload}>载入最新值</button>
        : draft ? <button type="button" className="button secondary" data-slot="button" disabled={busy} onClick={() => { setDraft(null); setMessage(null); }}>撤销修改</button> : null}
      <Note message={message} data={{ 'data-transfer-message': pair.id }} inline />
    </div>
  </form>;
}

function AdlForm({ pair, stale, onChanged }: { pair: AdlPairView; stale: boolean; onChanged: () => void }) {
  const [draft, setDraft] = useState<AdlDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const input = draft ?? { autoReduce: pair.config.autoReduce, batchNotional: pair.config.batchNotional };
  const edit = (next: AdlDraft) => { setDraft(next); setMessage(null); };
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
  const toggle = `${pair.pairId}-adl-auto`;
  return <form className="pair-settings-form form-stack" data-adl-pair={pair.pairId} onSubmit={event => { event.preventDefault(); if (!busy && !stale) void save(); }}>
    <fieldset className="settings-form-grid pair-adl-settings">
      <legend>ADL 应急处理</legend>
      <div className="settings-toggle">
        <label htmlFor={toggle}>ADL 后自动减仓</label>
        <input id={toggle} type="checkbox" role="switch" data-slot="switch" data-adl-auto={pair.pairId} checked={input.autoReduce} disabled={busy}
          onChange={event => edit({ ...input, autoReduce: event.target.checked })} />
      </div>
      <Field id={`${pair.pairId}-adl-batch`} label="ADL 单批名义金额上限" unit="USDT" value={input.batchNotional} disabled={busy}
        data={{ 'data-adl-notional': pair.pairId }} onChange={value => edit({ ...input, batchNotional: value })}>
        <small>每批按现场标记价折算，实际成交金额随市价变化；不足最小下单量的残差记为完成。</small>
      </Field>
      <p className="muted">关闭自动减仓后仍检测 ADL 并告警，等待手工处理，不下单。保存后对新事件生效。</p>
    </fieldset>
    <Note message={message} inline={false} />
    <div className="form-actions">
      <button type="submit" className="button secondary" data-slot="button" data-adl-save={pair.pairId} disabled={busy || stale} title={stale ? STALE_TITLE : undefined}>保存 ADL 设置</button>
      {draft ? <button type="button" className="button secondary" data-slot="button" disabled={busy} onClick={() => { setDraft(null); setMessage(null); }}>撤销修改</button> : null}
      <Note message={message} inline />
    </div>
  </form>;
}

/** The disclosure's content: the ADL part only once the service has registered the pair for ADL. */
export function PairSettings({ pair, adl, stale, onChanged }: { pair: PairView; adl: AdlPairView | null; stale: boolean; onChanged: () => void }) {
  return <div data-settings-pair={pair.id}>
    {stale ? <p className="settings-lock amber" data-settings-stale>页面数据不是最新的，等刷新恢复后才能保存。</p> : null}
    {adl ? <AdlForm pair={adl} stale={stale} onChanged={onChanged} /> : <p className="settings-lock muted">ADL 设置在配对启用后显示。</p>}
    <TransferForm pair={pair} stale={stale} onChanged={onChanged} />
    <p className="settings-lock muted">设置保存在本服务的数据库里；配置文件 config.json 中的 transfer 与 adl 只在配对第一次登记时作为初始值。</p>
  </div>;
}
