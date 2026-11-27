import { ArrowRightLeft, ChevronDown, LoaderCircle } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from './api.ts';
import { useDialogGuard } from './AppDialog.tsx';
import { clock, label } from './labels.ts';
import { LEVEL_LABEL, LEVEL_TONE, METHOD_LABEL, contractName, followsServer, legParts, netText, percent2, rebalanceConfirmText, rebalanceIntent, sameSettings, settingsFormError, sideName, suggestionText, suggestionUsable, usdt2, venueLabel, type SettingsForm } from './hynix-balance.ts';
import type { HynixBalanceLeg, HynixBalanceRow, HynixBalanceSettings, HynixBalanceView, HynixRebalancePreview, OilConfirmResult, OilJob, RebalanceMethod } from './oil-types.ts';
import { ACCOUNT_MODE, JOB_STATUS, errorText, operation } from './OilPage.tsx';
import { RequestIds } from './request-ids.ts';
import { acceptedJobText, executeOrderConfirm, leaveOrderPreview } from './order-confirm.ts';

// The H2 panel of the hynix page (docs/hynix.md section 7): each venue's two legs by USDT notional, the net exposure and
// its level, the thresholds (saved to the service) and the one-click rebalance (preview, then confirm). Laid out with the
// tables, review card and settings already copied into trading.css for the oil and hynix execution panels.

type Message = { tone: 'ok' | 'err' | 'muted'; text: string };
const messageClass = (message: Message): string | undefined => message.tone === 'err' ? 'execution-warning' : message.tone === 'ok' ? 'oil-ok' : 'execution-help';

function LegCell({ heading, legs }: { heading: string; legs: HynixBalanceLeg[] }) {
  if (!legs.length) return <td data-label={heading}>—</td>;
  // One child per cell: on narrow screens the cell is a flex row of its label and its content.
  return <td data-label={heading}><span>{legs.map((item, index) => {
    const parts = legParts(item);
    return <span key={index}><strong>{parts.name} {parts.quantity}</strong><small>{parts.notional}</small></span>;
  })}</span></td>;
}

function Level({ row }: { row: HynixBalanceRow }) {
  if (row.status === 'unavailable') return <span className="trading-status"><i aria-hidden="true" />不可用</span>;
  return <span className={`trading-status ${LEVEL_TONE[row.level]}`}><i aria-hidden="true" />{LEVEL_LABEL[row.level]}</span>;
}

function BalanceRowView({ row, locked, pending, onRebalance }: { row: HynixBalanceRow; locked: boolean; pending: string | null; onRebalance: (venue: string, method: RebalanceMethod) => void }) {
  const venue = venueLabel(row.venue);
  const at = <small>持仓 {clock(row.positionsAt)} · 盘口 {clock(row.quotesAt)}</small>;
  const head = <th scope="row"><strong>{venue}</strong>{row.status === 'unavailable' ? null : at}</th>;
  if (row.status === 'unavailable') return <tr data-hynix-balance={row.venue}>{head}<td data-label="多头腿">—</td><td data-label="空头腿">—</td><td data-label="净敞口">—</td><td data-label="占比">—</td>
    <td data-label="状态"><Level row={row} /></td><td data-label="建议"><span className="execution-warning spread-error">{row.reason}</span></td></tr>;
  if (row.status === 'none') return <tr data-hynix-balance={row.venue}>{head}<td data-label="多头腿">—</td><td data-label="空头腿">—</td><td data-label="净敞口">—</td><td data-label="占比">—</td>
    <td data-label="状态"><Level row={row} /></td><td data-label="建议">没有海力士持仓</td></tr>;
  if (row.status === 'unpaired') return <tr data-hynix-balance={row.venue}>{head}
    <LegCell heading="多头腿" legs={row.legs.filter(item => item.side === 'long')} /><LegCell heading="空头腿" legs={row.legs.filter(item => item.side === 'short')} />
    <td data-label="净敞口">—</td><td data-label="占比">—</td><td data-label="状态"><Level row={row} /></td>
    <td data-label="建议"><span><span className="execution-warning spread-error">{row.reason}</span><small>两腿不成对，不提供调平；请先人工处理</small></span></td></tr>;
  const methods: RebalanceMethod[] = ['reduce', 'add'];
  const button = (method: RebalanceMethod): ReactNode => {
    const usable = suggestionUsable(row.suggest?.[method]);
    const waiting = pending === `${row.venue}:${method}`;
    return <button key={method} className="button secondary" type="button" data-hynix-rebalance={`${row.venue}:${method}`} disabled={!usable || locked} onClick={() => onRebalance(row.venue, method)}>
      {waiting ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : null}{METHOD_LABEL[method]}</button>;
  };
  return <tr data-hynix-balance={row.venue}>{head}
    <LegCell heading="多头腿" legs={[row.long]} /><LegCell heading="空头腿" legs={[row.short]} />
    <td data-label="净敞口">{netText(row.gap, row.netSide)}</td><td data-label="占比"><span>{percent2(row.percent)}<small>占较大一腿</small></span></td>
    <td data-label="状态"><Level row={row} /></td>
    <td data-label="建议"><span>{methods.map(method => <small key={method} className="spread-error">{suggestionText(method, row.suggest?.[method])}</small>)}<span>{button('reduce')} {button('add')}</span></span></td>
  </tr>;
}

function SettingsPanel({ balance, receivedAt, onSaved }: { balance: HynixBalanceView; receivedAt: number | null; onSaved: () => void }) {
  const server = balance.settings;
  const [draft, setDraft] = useState<SettingsForm>(() => ({ ...server }));
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => {
    if (!followsServer(dirty, savedAt, receivedAt)) return;
    if (savedAt !== null) setSavedAt(null);
    setDraft(current => sameSettings(current, server) ? current : { ...server });
  }, [server.rebalancePercent, server.hardPercent, server.minGapUsdt, dirty, savedAt, receivedAt]);
  const set = (key: keyof SettingsForm, value: string) => { setDraft(current => ({ ...current, [key]: value })); setDirty(true); setMessage(null); };

  async function save(): Promise<void> {
    const checked = settingsFormError(draft);
    if ('error' in checked) { setMessage({ tone: 'err', text: checked.error }); return; }
    setBusy(true); setMessage({ tone: 'muted', text: '保存中…' });
    const sent = draft;
    try {
      const saved = await api<HynixBalanceSettings>('/api/hynix/balance/settings', { body: checked.settings });
      setSavedAt(Date.now());
      // Edits typed while the save was in flight stay unsaved; otherwise the form takes the saved values.
      if (sameSettings(draftRef.current, sent)) {
        setDirty(false);
        setDraft({ rebalancePercent: saved.rebalancePercent ?? checked.settings.rebalancePercent, hardPercent: saved.hardPercent ?? checked.settings.hardPercent, minGapUsdt: saved.minGapUsdt ?? checked.settings.minGapUsdt });
      }
      setMessage({ tone: 'ok', text: '已保存，状态按新阈值判断' });
      onSaved();
    } catch (error) { setMessage({ tone: 'err', text: errorText(error) }); }
    finally { setBusy(false); }
  }

  return <details className="execution-advanced" id="hynixBalanceSettings" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><span><strong>阈值设置</strong><small>调平线 {server.rebalancePercent}% · 硬上限 {server.hardPercent}% · 最小差额 {server.minGapUsdt} USDT</small></span><ChevronDown size={16} aria-hidden="true" /></summary>
    {!balance.settingsAvailable || balance.settingsError ? <p className="execution-warning" role="alert">{balance.settingsError ?? '设置库不可用，按默认阈值判断'}</p> : null}
    <form onSubmit={event => { event.preventDefault(); void save(); }} aria-label="两腿名义平衡阈值">
      <fieldset disabled={busy}>
        <div className="execution-settings">
          <label>调平线 · %<input id="hynixRebalancePercent" type="text" inputMode="decimal" autoComplete="off" maxLength={6} value={draft.rebalancePercent} onChange={event => set('rebalancePercent', event.target.value)} /></label>
          <label>硬上限 · %<input id="hynixHardPercent" type="text" inputMode="decimal" autoComplete="off" maxLength={6} value={draft.hardPercent} onChange={event => set('hardPercent', event.target.value)} /></label>
          <label>最小差额 · USDT<input id="hynixMinGap" type="text" inputMode="decimal" autoComplete="off" maxLength={10} value={draft.minGapUsdt} onChange={event => set('minGapUsdt', event.target.value)} /></label>
        </div>
        <p className="execution-help">净敞口不超过调平线，或差额低于最小差额，为正常；超过调平线为建议调平，超过硬上限或两腿不成对为尽快处理。0.1 ≤ 调平线 &lt; 硬上限 ≤ 50，最多两位小数。</p>
        <div className="execution-actions">
          <button className="button primary" type="submit" id="hynixBalanceSave" disabled={!balance.settingsAvailable}>{busy ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : null}保存</button>
          {dirty ? <span className="execution-help">有未保存的修改</span> : null}
          {message ? <span id="hynixBalanceSettingsMsg" className={messageClass(message)} role="status">{message.text}</span> : null}
        </div>
      </fieldset>
    </form>
  </details>;
}

function RebalanceReview({ preview, busy, unknown, onConfirm, onCancel }: { preview: HynixRebalancePreview; busy: boolean; unknown: boolean; onConfirm: () => void; onCancel: () => void }) {
  const method: RebalanceMethod = preview.intent?.method === 'add' ? 'add' : 'reduce';
  const action = method === 'reduce' ? 'close' : 'open';
  const item = preview.legs?.[0];
  const before = preview.rebalance?.before, after = preview.rebalance?.after, counter = preview.rebalance?.counter;
  const expired = Date.now() > preview.expiresAt;
  const net = (gap: string | undefined, side: 'long' | 'short' | null | undefined): string => gap === undefined ? '—' : side === undefined ? usdt2(gap) : netText(gap, side);
  return <section className="execution-review" id="hynixRebalancePreview" aria-labelledby="hynix-rebalance-title" tabIndex={-1}>
    <div className="execution-review-title"><div><h3 id="hynix-rebalance-title">确认{METHOD_LABEL[method]} · {venueLabel(item?.venue ?? preview.intent?.venue)}</h3><p>预览有效至 {clock(preview.expiresAt)}（北京时间）</p></div><span className="execution-badge attention">实盘下单</span></div>
    {item ? <div className="execution-review-accounts"><p><strong>{venueLabel(item.venue)}</strong> {label(ACCOUNT_MODE, item.accountMode)} · 账户 {item.accountId}</p></div> : null}
    <dl className="execution-review-settings">
      <div><dt>调平前多头名义</dt><dd>{usdt2(before?.longNotional)}</dd></div>
      <div><dt>调平前空头名义</dt><dd>{usdt2(before?.shortNotional)}</dd></div>
      <div><dt>调平前净敞口</dt><dd>{net(before?.gap, before?.netSide)}<small>{before?.percent !== undefined ? ` 占 ${percent2(before.percent)}` : ''}</small></dd></div>
      <div><dt>调平后估算净敞口</dt><dd>{net(after?.gap, after?.netSide)}</dd></div>
      <div><dt>估算名义金额</dt><dd>{preview.notional ?? '—'} USDT</dd></div>
      <div><dt>价格保护</dt><dd>{preview.intent?.maxSlippageBps ? `${preview.intent.maxSlippageBps} 基点` : '执行器默认值'}</dd></div>
      <div><dt>最长执行</dt><dd>{Math.round((preview.intent?.timeoutMs ?? 0) / 1000)} 秒</dd></div>
    </dl>
    <div className="execution-review-legs execution-table-wrap"><table className="execution-progress-table execution-review-table">
      <thead><tr><th scope="col">调平腿</th><th scope="col">数量<small>合约数量</small></th><th scope="col">下单方式</th><th scope="col">价格保护界限<small>USDT</small></th><th scope="col">买一 / 卖一<small>盘口时间</small></th></tr></thead>
      <tbody>{item ? <tr>
        <th scope="row"><strong>{venueLabel(item.venue)} {contractName(item.symbol)}</strong><span className={`execution-side ${item.side}`}>{operation(action, item.side)}{item.reduceOnly ? ' · 只减仓' : ''}</span></th>
        <td data-label="数量"><strong>{item.quantity ?? '—'}</strong><small>{item.symbol}{item.instrument?.quantityStep ? ` · 步长 ${item.instrument.quantityStep}` : ''}</small></td>
        <td data-label="下单方式">市价 · IOC 限价</td>
        <td data-label="价格保护界限">{item.priceBound ?? '—'}</td>
        <td data-label="买一 / 卖一">{item.quote ? <>{item.quote.bid} / {item.quote.ask}<small>{clock(item.quote.receivedAt)}</small></> : '—'}</td>
      </tr> : <tr><th scope="row">—</th><td data-label="数量">—</td><td data-label="下单方式">—</td><td data-label="价格保护界限">—</td><td data-label="买一 / 卖一">—</td></tr>}</tbody>
    </table></div>
    <p className="execution-help">只发这一笔：以价格保护界限为 IOC 限价，未即时成交的部分由交易所撤销，不补发。{counter?.symbol ? `另一腿 ${contractName(counter.symbol)} ${sideName(counter.side)} ${counter.quantity ?? ''} 不下单，任务期间一并锁定。` : ''}发送前持仓或盘口与预览不符时不发送。</p>
    {preview.notes?.length ? <ul className="execution-review-notes">{preview.notes.map((note, index) => <li key={index}>{note}</li>)}</ul> : null}
    {unknown ? <p className="execution-warning">上次确认没有收到应答，可能已受理：请先再点“确认并实盘调平”核对（沿用同一请求编号，不会重复下单）。</p>
      : expired ? <p className="execution-warning" role="status">预览已过期，确认会被执行器拒绝；请取消后重新调平。</p> : null}
    <div className="execution-actions">
      <button className="button primary" type="button" id="hynixRebalanceConfirm" disabled={busy} onClick={onConfirm}>{busy ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <ArrowRightLeft size={16} aria-hidden="true" />}确认并实盘调平</button>
      <button className="button secondary" type="button" disabled={busy} onClick={onCancel}>取消</button>
    </div>
  </section>;
}

export function BalancePanel({ balance, stale, receivedAt, onSaved, onAccepted }: { balance: HynixBalanceView; stale: boolean; receivedAt: number | null; onSaved: () => void; onAccepted: (job: OilJob) => void }) {
  const [preview, setPreview] = useState<HynixRebalancePreview | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dialog = useDialogGuard();
  const busyRef = useRef(false);
  busyRef.current = busy;
  const previewRef = useRef(preview);
  previewRef.current = preview;
  const [unanswered, setUnanswered] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const ids = useRef(new RequestIds());
  const reviewRef = useRef<HTMLDivElement>(null);
  // Bumped when a preview is dropped: one answered after the cancel is not shown.
  const version = useRef(0);
  useEffect(() => { if (preview) reviewRef.current?.querySelector<HTMLElement>('.execution-review')?.focus(); }, [preview]);

  async function runPreview(venue: string, method: RebalanceMethod): Promise<void> {
    const asked = ++version.current;
    setPending(`${venue}:${method}`); setPreview(null); setMessage({ tone: 'muted', text: `${venueLabel(venue)} ${METHOD_LABEL[method]}预览中…` });
    try {
      const result = await api<HynixRebalancePreview>('/api/preview', { body: rebalanceIntent(venue, method) });
      if (asked === version.current) { setPreview(result); setMessage(null); setUnanswered(null); }
    } catch (error) { if (asked === version.current) setMessage({ tone: 'err', text: `${venueLabel(venue)} ${METHOD_LABEL[method]}：${errorText(error)}` }); }
    finally { if (asked === version.current) setPending(null); }
  }

  const setConfirmBusy = (next: boolean): void => { busyRef.current = next; if (next || dialog.isAlive()) setBusy(next); };
  const previewIdOf = (): string | undefined => previewRef.current?.id;

  async function runConfirm(current: HynixRebalancePreview): Promise<void> {
    await executeOrderConfirm({
      previewId: current.id,
      confirmText: rebalanceConfirmText(current),
      confirmTitle: '确认名义平衡下单',
      dialog, ids: ids.current, isBusy: () => busyRef.current, setBusy: setConfirmBusy, currentPreviewId: previewIdOf,
      send: requestId => api<OilConfirmResult>('/api/confirm', { body: { previewId: current.id, requestId, confirmLive: true } }),
      formatAccepted: result => acceptedJobText(result, label(JOB_STATUS, result.job.status), '下方'),
      onAccepted: result => onAccepted(result.job),
      clearPreview: () => { version.current++; setPreview(null); },
      setUnanswered, setMessage,
    });
  }

  async function cancel(): Promise<void> {
    await leaveOrderPreview({
      dialog, isBusy: () => busyRef.current, currentPreviewId: previewIdOf, unansweredId: unanswered,
      onClear: () => { version.current++; setPreview(null); setUnanswered(null); setMessage(null); setPending(null); },
    });
  }

  const locked = busy || pending !== null || preview !== null;
  return <section className="trading-panel execution-panel" id="hynixBalance" aria-labelledby="hynix-balance-title">
    <header className="trading-panel-heading"><div><h2 id="hynix-balance-title">两腿名义平衡</h2>
      <p>同一交易所同一账户的 ADR 与正股 · 名义金额 = 数量 × 合约乘数 × 盘口中间价 · 占比 = 净敞口 ÷ 较大一腿名义 · 建议数量向下取整到下单步长，实际数量以预览为准</p></div></header>
    <div className="spread-markets oil-spread-markets"><div className="execution-table-wrap"><table className="execution-progress-table spread-table" id="hynixBalanceTable">
      <thead><tr><th scope="col">交易所</th><th scope="col">多头腿<small>数量 · 名义</small></th><th scope="col">空头腿<small>数量 · 名义</small></th><th scope="col">净敞口<small>USDT</small></th><th scope="col">占比</th><th scope="col">状态</th><th scope="col">建议</th></tr></thead>
      <tbody>{balance.venues.length ? balance.venues.map((row, index) => <BalanceRowView key={`${row.venue}:${index}`} row={row} locked={locked} pending={pending} onRebalance={(venue, method) => void runPreview(venue, method)} />)
        : <tr><th scope="row">—</th><td data-label="说明" colSpan={6}>没有配置执行账户</td></tr>}</tbody>
    </table></div></div>
    {stale ? <p className="trading-footnote trading-warning">执行状态未能刷新，显示的是上次读取的结果。</p> : null}
    {message ? <p className={`execution-message${message.tone === 'err' ? ' warning' : ''}`} id="hynixBalanceMsg" role="status">{message.text}</p> : null}
    <div ref={reviewRef}>{preview ? <RebalanceReview preview={preview} busy={busy} unknown={unanswered === preview.id} onConfirm={() => void runConfirm(preview)} onCancel={() => void cancel()} /> : null}</div>
    <div className="execution-builder"><SettingsPanel balance={balance} receivedAt={receivedAt} onSaved={onSaved} /></div>
  </section>;
}
