// The oil page's 自动开平仓 panel (docs/oil.md section 7, O2a: observe only), laid out as the workbench's
// TradingAutoRules.tsx (styles from its trading-execution.css, commit 1d06abd, in trading.css). Rules are read every 3 s
// through useLiveResource; every write is guarded by the rule's revision and its answer becomes the shown list. A write
// without a definite answer re-reads the list before anything else can be done.
import { Bot, CircleAlert, Pencil, Plus, Power, RefreshCw, Trash2 } from 'lucide-react';
import { memo, useState } from 'react';
import { api, ApiError } from './api.ts';
import { stamp } from './labels.ts';
import { conditionText, directionText, emptyRuleForm, ruleConfigOf, ruleFormOf, type OilRule, type OilRulesView, type RuleDirection, type RuleForm, type RuleVenue } from './oil-rules-form.ts';
import { useLiveResource } from './use-live-resource.ts';

export const OIL_RULES_PATH = '/api/oil/rules';
const RULES_MS = 3_000, READ_TIMEOUT_MS = 10_000;
const VENUES: Record<RuleVenue, string> = { binance: 'Binance', bybit: 'Bybit' };
const spread = (value: string) => `${value} USDT/桶`;

const RuleFormView = memo(function RuleFormView({ initial, editing, venues, disabled, onSave, onCancel }: { initial: RuleForm; editing: OilRule | null; venues: readonly RuleVenue[]; disabled: boolean; onSave: (form: RuleForm, observe: boolean) => Promise<string | null>; onCancel: () => void }) {
  const [form, setForm] = useState(initial);
  const [observe, setObserve] = useState(true), [error, setError] = useState('');
  const set = <K extends keyof RuleForm>(key: K, value: RuleForm[K]) => setForm(current => ({ ...current, [key]: value }));
  const short = form.direction === 'short';
  async function submit() {
    const checked = ruleConfigOf(form);
    if ('error' in checked) { setError(checked.error); return; }
    setError('');
    const refused = await onSave(form, observe);
    if (refused) setError(refused);
  }
  return <form className="auto-rule-form" onSubmit={event => { event.preventDefault(); void submit(); }} aria-label={editing ? `修改自动规则 ${editing.title}` : '新建自动规则'}>
    <fieldset disabled={disabled}>
      <div className="auto-rule-form-grid">
        <label>规则名称（选填）<input type="text" maxLength={40} value={form.name} onChange={event => set('name', event.target.value)} placeholder="留空按交易所与方向命名" /></label>
        <label>交易所（同所两腿）<select value={form.venue} onChange={event => set('venue', event.target.value as RuleVenue)}>{venues.map(value => <option key={value} value={value}>{VENUES[value]}</option>)}</select></label>
        <label>开仓方向<select value={form.direction} onChange={event => set('direction', event.target.value as RuleDirection)}><option value="short">{directionText('short')}</option><option value="long">{directionText('long')}</option></select></label>
        <label>开仓阈值 · USDT/桶<input type="text" inputMode="decimal" required maxLength={24} value={form.openThreshold} onChange={event => set('openThreshold', event.target.value)} placeholder={short ? '价差达到或高于此值开仓' : '价差达到或低于此值开仓'} /></label>
        <label>平仓阈值 · USDT/桶<input type="text" inputMode="decimal" required maxLength={24} value={form.closeThreshold} onChange={event => set('closeThreshold', event.target.value)} placeholder={short ? '价差回落到此值或以下平仓' : '价差回升到此值或以上平仓'} /></label>
        <label>每腿桶数 · 桶<input type="text" inputMode="decimal" required maxLength={24} value={form.barrels} onChange={event => set('barrels', event.target.value)} /></label>
        <label>连续满足次数<input type="number" min="1" max="30" step="1" required value={form.confirmSamples} onChange={event => set('confirmSamples', event.target.value)} /></label>
        <label>每日最多开仓次数<input type="number" min="1" max="50" step="1" required value={form.maxOpensPerDay} onChange={event => set('maxOpensPerDay', event.target.value)} /></label>
      </div>
      <p className="execution-help">按可成交价判断：卖出价差取 BZ 买一价与 CL 卖一价，买入价差取 BZ 卖一价与 CL 买一价。每次读到新盘口并满足条件计一次，达到连续次数记录一条信号。当前只提供观察：只记录条件信号，不下单；每腿桶数与每日最多开仓次数留给以后转实盘使用。</p>
      {!editing ? <div className="auto-rule-confirm"><label className="execution-checkbox"><input type="checkbox" checked={observe} onChange={event => setObserve(event.target.checked)} />保存后开始只观察</label></div> : null}
      {error ? <p className="execution-warning" role="alert">{error}</p> : null}
      <div className="execution-actions"><button className="button primary" type="submit">{editing ? '保存修改' : observe ? '保存并观察' : '保存规则'}</button><button className="button secondary" type="button" onClick={onCancel}>取消</button></div>
    </fieldset>
  </form>;
});

function ReadingLine({ name, reading, samples }: { name: string; reading: NonNullable<OilRule['observation']>['open']; samples: number }) {
  return <p>{name}条件：{reading && !reading.stale
    ? <>{reading.side === 'sell' ? '卖出' : '买入'}价差 <strong className={reading.met ? 'spread-up' : undefined}>{spread(reading.value)}</strong> · 连续满足 {reading.hits} / {samples} 次 · 盘口 {stamp(reading.at)}</>
    : '等待新鲜盘口'}</p>;
}

const RuleCard = memo(function RuleCard({ rule, disabled, evidenceValid, onAction, onEdit }: { rule: OilRule; disabled: boolean; evidenceValid: boolean; onAction: (rule: OilRule, action: 'start' | 'stop' | 'delete') => void; onEdit: (rule: OilRule) => void }) {
  const { config } = rule;
  return <article className="execution-job auto-rule idle" aria-label={`自动规则 ${rule.title}`} data-oil-rule={rule.id}>
    <header><div><h3>{rule.title}<span className={`execution-badge ${evidenceValid && rule.observing ? 'connected' : ''}`}>{!evidenceValid ? '状态待更新' : rule.observing ? '只观察中' : '观察已停止'}</span><span className="execution-badge">条件信号 · 不下单</span></h3>
      <p>{VENUES[config.venue]} · 原油 · {directionText(config.direction)} · {conditionText(config)}</p>
      <p>每腿桶数 {config.barrels} 桶 · 连续 {config.confirmSamples} 次满足才记录信号 · 每日最多开仓 {config.maxOpensPerDay} 次（转实盘后生效）</p></div></header>
    <div className="auto-rule-live">
      {rule.problem ? <p className="execution-warning" role="alert">{rule.problem}</p>
        : !evidenceValid ? <span className="execution-warning">当前状态待重新读取，不展示旧连续次数。</span>
        : <div><p className="execution-help">开仓与平仓条件独立观察；不代表完成开平仓，不计算模拟收益。</p>{!rule.observing ? <p>观察已停止。</p> : rule.observation?.note ? <p className="execution-warning">{rule.observation.note}</p>
          : <><ReadingLine name="开仓" reading={rule.observation?.open ?? null} samples={config.confirmSamples} /><ReadingLine name="平仓" reading={rule.observation?.close ?? null} samples={config.confirmSamples} /></>}</div>}
    </div>
    <footer>
      <div className="auto-rule-actions">
        {rule.observing ? <button className="button secondary" type="button" disabled={disabled} onClick={() => onAction(rule, 'stop')}><Power size={14} />停止观察</button>
          : <button className="button secondary" type="button" disabled={disabled || !!rule.problem} onClick={() => onAction(rule, 'start')}>开始只观察</button>}
        <button className="button secondary" type="button" disabled={disabled} onClick={() => onEdit(rule)}><Pencil size={14} />修改</button>
        <button className="button secondary auto-rule-delete" type="button" disabled={disabled} onClick={() => onAction(rule, 'delete')}><Trash2 size={14} />删除</button>
      </div>
    </footer>
    <details className="execution-events"><summary>规则记录</summary><p>规则编号：{rule.id} · 创建于 {stamp(rule.createdAt)}</p><ul>{[...rule.events].reverse().map((item, index) => <li key={`${item.at}-${index}`}><time>{stamp(item.at)}</time><span>{item.message}</span></li>)}</ul></details>
    {rule.observations.length ? <details className="execution-events"><summary>观察记录（最近 30 条）</summary><p>同一轮连续满足只记录一次；条件中断后重新计数。开始、停止、修改、行情缺口及重启均清零。</p><ul>{[...rule.observations].reverse().map((item, index) => <li key={`${item.at}-${index}`}><time>{stamp(item.at)}</time><span>{item.message}{item.kind === 'signal' && item.value ? ` · BZ ${stamp(item.bzAt)} / CL ${stamp(item.clAt)} · 价差 ${spread(item.value)} · 阈值 ${item.threshold} · ${item.hits} 次` : ''}</span></li>)}</ul></details> : null}
  </article>;
});

const ACTION_DONE: Record<'start' | 'stop' | 'delete', string> = { start: '已开始只观察，不会下单。', stop: '已停止观察。', delete: '规则已删除。' };

export function OilRules({ onExpired }: { onExpired: () => void }) {
  const live = useLiveResource<OilRulesView>(OIL_RULES_PATH, { intervalMs: RULES_MS, timeoutMs: READ_TIMEOUT_MS, onExpired });
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false);
  const [writeError, setWriteError] = useState(''), [notice, setNotice] = useState('');
  const [editor, setEditor] = useState<{ rule: OilRule | null; key: number } | null>(null);
  const view = live.data;
  // Counts are only shown from a read that is current: a failed, paused or old read hides them and blocks writes.
  const evidenceValid = !uncertain && (live.status === 'ready' || (live.status === 'loading' && live.error === null)) && live.receivedAt !== null && Date.now() - live.receivedAt <= 2 * RULES_MS + READ_TIMEOUT_MS;

  /** Sends a write; returns null when it went through, else the message to show. */
  async function write(path: string, body: unknown, done: string, inline = false): Promise<string | null> {
    if (busy) return '上一次操作尚未完成';
    setBusy(true); setWriteError(''); setNotice('');
    try {
      live.commit(await api<OilRulesView>(path, { body }));
      setNotice(done);
      return null;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) { onExpired(); return '会话已过期'; }
      // Without a definite answer the write may have been saved: re-read before anything is retried.
      const unknown = !(error instanceof ApiError) || error.status >= 500;
      const message = `${error instanceof Error ? error.message : '操作未完成'}${unknown ? ' 结果未确认，已重新读取规则列表，请核对后再操作。' : ''}`;
      if (!inline || unknown) setWriteError(message);
      if (unknown || (error instanceof ApiError && error.status === 409)) { setUncertain(true); void live.refresh().finally(() => setUncertain(false)); }
      return message;
    } finally { setBusy(false); }
  }
  async function save(form: RuleForm, observe: boolean): Promise<string | null> {
    const checked = ruleConfigOf(form);
    if ('error' in checked) return checked.error;
    const rule = editor?.rule ?? null;
    const refused = rule ? await write(`${OIL_RULES_PATH}/${rule.id}/update`, { revision: rule.revision, config: checked.config }, '规则已更新，连续次数已清零。', true)
      : await write(OIL_RULES_PATH, { config: checked.config, observing: observe }, observe ? '规则已保存并开始只观察。' : '规则已保存，开始观察后才会记录信号。', true);
    if (!refused) setEditor(null);
    return refused;
  }
  function act(rule: OilRule, action: 'start' | 'stop' | 'delete'): void {
    if (action === 'delete' && !window.confirm(`删除自动规则「${rule.title}」？观察记录一并删除。`)) return;
    void write(`${OIL_RULES_PATH}/${rule.id}/${action}`, { revision: rule.revision }, ACTION_DONE[action]);
  }

  const venues = view?.available ? view.venues : [];
  const full = !!view?.available && view.rules.length >= view.maxRules;
  const disabled = busy || !evidenceValid;
  return <section className="trading-panel auto-panel" id="oilRules" aria-labelledby="oil-rules-title">
    <header className="trading-panel-heading"><div><h2 id="oil-rules-title"><Bot size={17} />自动开平仓</h2><p>同所 BZ − CL · 可成交价差达到阈值时记录信号 · 当前只观察、不下单 · 由服务器运行，关闭页面不影响</p></div>
      <div className="execution-actions"><button className="button secondary" type="button" disabled={busy} onClick={() => void live.refresh()}><RefreshCw size={15} />刷新</button>
        {!editor && view?.available ? <button className="button primary" type="button" disabled={disabled || full || !venues.length} title={full ? `最多 ${view.maxRules} 条规则` : undefined} onClick={() => setEditor({ rule: null, key: Date.now() })}><Plus size={15} />新建规则</button> : null}</div></header>
    {view && !view.available ? <p className="execution-message warning" role="alert"><CircleAlert size={16} />{view.error}</p> : null}
    {live.error && live.status !== 'ready' ? <p className="execution-message warning" role="alert">规则读取失败：{live.error.message}</p> : null}
    {writeError ? <p className="execution-message warning" role="alert"><CircleAlert size={16} />{writeError}</p> : null}
    {notice ? <p className="execution-message" role="status">{notice}</p> : null}
    {editor && venues.length ? <RuleFormView key={editor.key} initial={editor.rule ? ruleFormOf(editor.rule.config) : emptyRuleForm(venues[0]!)} editing={editor.rule} venues={venues} disabled={disabled} onSave={save} onCancel={() => setEditor(null)} /> : null}
    <div className="auto-rules">{view ? view.rules.length ? view.rules.map(rule => <RuleCard key={`${rule.id}:${rule.revision}`} rule={rule} disabled={disabled} evidenceValid={evidenceValid} onAction={act} onEdit={item => setEditor({ rule: item, key: Date.now() })} />)
      : view.available ? <p className="execution-help">尚无自动规则。先只观察条件信号；转实盘在审查通过后的版本提供。</p> : null : <p className="execution-help">正在读取自动规则…</p>}</div>
    <p className="execution-help auto-panel-note">规则使用原油页同一份每 3 秒读取的盘口；读取失败、盘口超过 10 秒未更新或服务重启时连续次数清零，等新盘口重新计数。观察规则不下单、不占用额度，也不会发飞书消息。</p>
  </section>;
}
