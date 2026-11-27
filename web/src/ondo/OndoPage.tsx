// 改编自 project-aggregation 工作台 src/OndoMarketMakerPage.tsx（提交 7745181），docs/ondo.md §7。改动：
// - 接口换成本服务的 /api/ondo/*（读状态是 GET /api/ondo/state），请求层用本服务的 api.ts（body 传对象）；
// - API Key 不在页面填写：只读显示 secrets.json 里的 Key 尾号，导入或修改的方法写在卡片里；
// - 文案里的「工作台服务器」改为「本服务」；
// - 页面末尾加「奖励市场盘口与收益模拟」（OndoRewards.tsx）。
import './ondo.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { LoaderCircle, Play, RefreshCw, Save, Square } from 'lucide-react';
import { api, ApiError } from '../api.ts';
import { useDialogGuard } from '../AppDialog.tsx';
import type { OndoMmConfig, OndoMmSide, OndoMmSnapshot } from './ondo-mm-types.ts';
import type { OndoRewardsView } from '../../../src/ondo/reward-types.ts';
import { useLiveResource } from '../use-live-resource.ts';
import { Callout, StatePanel, TableEmpty } from '../StateViews.tsx';
import { OndoObservationPanel } from './OndoObservation.tsx';
import { OndoLatencyPanel } from './OndoLatency.tsx';
import { OndoRewards } from './OndoRewards.tsx';
import { ACCOUNT_WIDE_CONFIRMATION, exitSummary, quoteConfigRequest, quoteStartRequest, quoteStopRequest, type OndoStopRequest } from './quote-form.ts';

const ROOT = '/api/ondo';
export const ONDO_STATE_PATH = `${ROOT}/state`;
export const ONDO_READ_TIMEOUT_MS = 10_000;
const HOLDS: Record<string, string> = {
  starting: '启动中', stopping: '正在撤单停止', maintenance: '更新维护中，暂停挂单并撤单', admission: '账户隔离恢复中，暂停挂单并撤单', auth_failed: '凭据或访问被拒绝，已停止下单；撤单可能失败，请到 Ondo 核对',
  rate_limited: '交易所限流冷却中，暂停挂单并撤单', no_rules: '市场规则未读到', unknown_market: '交易所没有这个市场', market_closed: '休市或暂停交易', private_stream: '账户推送未连接',
  dead_man_switch: '断线撤单尚未确认，暂停下单', incident_lock: '风险锁已触发，停止开仓',
  account_unknown: '账户状态读取失败', stale_book: '盘口过期或单边', unknown_order: '有订单结果未知，核对中',
};
const REASONS: Record<string, string> = {
  ...HOLDS, in_flight: '请求处理中', duplicate: '重复挂单，撤销中', role_change: '持仓变化，换单中', position_cap: '持仓已到上限，不再加仓', total_cap: '总名义已到上限', total_unknown: '有市场的持仓暂时无法估值，不新挂单',
  too_close: '离中间价太近', too_far: '离中间价太远，等待确认后改价', unprotected: '前方保护量不足，不挂新单，立即撤销已有开仓单', own_order_in_way: '会碰到本账户的反向挂单',
  no_book: '盘口不完整', no_price: '没有可挂的价位', no_tick_in_band: '价格步长太粗，区间内没有价位', size_too_small: '每单金额不足一个最小数量', syncing: '核对账户中', awaiting_depth: '最优价提前撤单后，等待更新的深度盘口',
  backoff: '下单被拒后等待重试', close_size: '持仓变化，调整平仓数量', close_follow: '跟随盘口平仓', dust_position: '持仓不足一个最小数量',
  incident: '风险锁已触发，停止开仓', exit: '撤单并核对剩余仓位', manual_exit: '等待人工处理余仓',
};
const STATES: Record<OndoMmSide['state'], string> = { none: '未挂', planned: '计划', sending: '下单中', open: '挂单中', canceling: '撤单中', unknown: '结果未知' };
const dates = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const when = (value: string | number | null) => { const ms = typeof value === 'number' ? value : value ? Date.parse(value) : NaN; return Number.isFinite(ms) ? dates.format(ms) : '—'; };
const message = (reason: unknown) => reason instanceof Error ? reason.message : '请求失败，请重试。';
const marketList = (text: string) => text.split(/[\s,，、]+/).filter(Boolean).map(item => item.toUpperCase());
const stopNotice = (live: boolean) => live ? '实盘已停止，已核对本模块挂单。请核实账户余仓。' : '观察已停止，本次统计已保留。';
const STOP_SESSION_CHANGED = '会话已变化，本次请求未停止新会话。请核对刷新后的运行状态。';

function SideCell({ side }: { side: OndoMmSide }) {
  if (side.state === 'none') return <td><span className="muted">未挂</span>{side.reason ? <small>{REASONS[side.reason] ?? side.reason}</small> : null}</td>;
  return <td>
    <span className={side.state === 'open' ? 'om-ok' : undefined}>{side.role === 'close' ? '只减仓 ' : '开仓 '}{side.price} × {side.size}</span>
    <small>{STATES[side.state]}{side.mode === 'ioc' ? ' · 限价 IOC' : ''}{side.bps === undefined ? '' : ` · 距中间价 ${side.bps.toFixed(2)} bps`}{side.mode === 'wall' && side.protection ? ` · 前方保护 ${side.protection} USD` : ''}</small>
    {side.reason ? <small>{REASONS[side.reason] ?? side.reason}</small> : null}
  </td>;
}

export function OndoPage({ onExpired }: { onExpired: () => void }) {
  const [snapshot, setSnapshot] = useState<OndoMmSnapshot | null>(null);
  const [suspendedSnapshot, setSuspendedSnapshot] = useState<OndoMmSnapshot | null>(null);
  const [draft, setDraft] = useState<OndoMmConfig | null>(null);
  const [marketsText, setMarketsText] = useState('');
  const [confirmedRevision, setConfirmedRevision] = useState<number | null>(null);
  const [adoptPositions, setAdoptPositions] = useState(false);
  const [stopPending, setStopPending] = useState<OndoStopRequest | null>(null);
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const lifetime = useRef<AbortController | null>(null);
  const lastAccepted = useRef<OndoMmSnapshot | null>(null);
  const dirty = !!snapshot && !!draft && JSON.stringify(draft) !== JSON.stringify(snapshot.config);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const busyRef = useRef(false);
  busyRef.current = !!busy;
  const dialog = useDialogGuard();
  const guardRef = useRef({ active: false, startBlock: '', snapshot: null as OndoMmSnapshot | null });
  const fail = useCallback((reason: unknown, show: (text: string) => void) => { if (reason instanceof ApiError && reason.status === 401) onExpired(); else show(message(reason)); }, [onExpired]);
  // 未保存的草稿保留；轮询只刷新运行状态。
  const accept = useCallback((data: OndoMmSnapshot, replace?: boolean) => {
    if (lastAccepted.current?.revision !== data.revision || lastAccepted.current?.phase !== data.phase) {
      setConfirmedRevision(null); setAdoptPositions(false);
    }
    lastAccepted.current = data; setSnapshot(data);
    if (replace ?? !dirtyRef.current) { setDraft(data.config); setMarketsText(data.config.markets.join(', ')); }
  }, []);
  const active = !!snapshot && snapshot.phase !== 'stopped';
  const stateInterval = active ? 2000 : 15_000;
  const resource = useLiveResource<OndoMmSnapshot>(ONDO_STATE_PATH, { intervalMs: stateInterval, timeoutMs: ONDO_READ_TIMEOUT_MS, onExpired });
  const [rewardWindow, setRewardWindow] = useState(60);
  const rewards = useLiveResource<OndoRewardsView>(`${ROOT}/rewards?window=${rewardWindow}`, { intervalMs: 15_000, timeoutMs: 10_000, onExpired });
  const loadError = resource.error && !(resource.error instanceof ApiError && resource.error.status === 401) ? resource.error.message : '';
  const suspended = resource.status === 'offline' || resource.status === 'paused';
  const stateStale = suspended || !!resource.error || resource.receivedAt === null || Date.now() - resource.receivedAt > 2 * stateInterval
    || (suspendedSnapshot !== null && snapshot === suspendedSnapshot);
  // 写入进行中不接收读取结果：写入成功后的结果作废之前发出的读取（L089）。
  useEffect(() => {
    if (suspended) { setSuspendedSnapshot(resource.data); return; }
    if (busy || !resource.data || resource.data === lastAccepted.current) return;
    accept(resource.data);
    setSuspendedSnapshot(null);
  }, [resource.data, suspended, busy, accept]);
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    return () => { controller.abort(); };
  }, []);
  const execute = async (name: string, path: string, method: 'POST' | 'PUT', body: unknown, done: string, replace: () => boolean | undefined = () => undefined, timeoutMs = 30_000): Promise<{ data: OndoMmSnapshot } | { error: unknown } | null> => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || busyRef.current) return null;
    busyRef.current = true;
    setBusy(name); setActionError(''); setNotice('');
    try {
      const data = await api<OndoMmSnapshot>(ROOT + path, { method, body, signal, timeoutMs });
      if (signal.aborted) return null;
      if (!data.config) throw new Error('服务应答缺少挂单状态，正在重新读取。');
      accept(data, replace()); resource.commit(data); setNotice(done);
      return { data };
    } catch (error) {
      if (signal.aborted) return null;
      fail(error, setActionError); void resource.refresh();
      return { error };
    }
    finally { busyRef.current = false; if (!signal.aborted) setBusy(''); }
  };
  const change = (next: Partial<OndoMmConfig>) => setDraft(current => current && { ...current, ...next });
  const configRequest = draft ? quoteConfigRequest(draft) : null;
  const configError = configRequest && 'error' in configRequest ? configRequest.error : '';
  const save = async () => {
    if (!configRequest || !('body' in configRequest)) return;
    const submitted = JSON.stringify(draft);
    await execute('save', '/config', 'PUT', configRequest.body, '设置已保存', () => JSON.stringify(draftRef.current) === submitted);
  };
  const startLive = async () => {
    if (!snapshot || snapshot.config.mode !== 'live' || active || startBlock || busyRef.current) return;
    const body = quoteStartRequest('live', snapshot.revision, confirmedRevision, adoptPositions);
    if (!body) return;
    const config = snapshot.config;
    const preview = [`在 ${config.markets.join('、')} 启动实盘，每单 ${config.orderUsd} USD，开仓前方至少 ${config.wallUsd} USD。`,
      ACCOUNT_WIDE_CONFIRMATION, exitSummary(config), adoptPositions ? '将接管所选市场的已有持仓。' : '所选市场已有持仓时拒绝启动。', '确认启动实盘挂单？'].join('\n\n');
    if (!await dialog.confirm(preview, { title: '确认启动实盘挂单', confirmLabel: '确认启动', tone: 'danger' })) return;
    const current = guardRef.current;
    if (!dialog.isAlive() || busyRef.current || current.active || current.startBlock || current.snapshot?.revision !== snapshot.revision) return;
    await execute('start', '/start', 'POST', body, '实盘会话已启动');
  };
  const stopRequest = quoteStopRequest(snapshot);
  const stop = async () => {
    if (!stopRequest || busyRef.current) return;
    setStopPending(null);
    const result = await execute('stop', '/stop', 'POST', stopRequest, '', undefined, 60_000);
    if (!result) return;
    if ('error' in result) {
      if (result.error instanceof ApiError) {
        if (result.error.status === 409) setActionError(STOP_SESSION_CHANGED);
      } else setStopPending(stopRequest); // 网络中断时仍需核对原会话。
      return;
    }
    if (result.data.phase === 'stopped') setNotice(stopNotice(stopRequest.live));
    else if (result.data.sessionId === stopRequest.sessionId && result.data.live === stopRequest.live) {
      setStopPending(stopRequest); setActionError('停止尚未完成，服务器仍在核对挂单。请留意下方状态。');
    } else setActionError(STOP_SESSION_CHANGED);
  };
  // 只跟踪用户点停止时看到的会话。应答未知时，轮询只能确认当前状态。
  useEffect(() => {
    if (!stopPending || !snapshot) return;
    if (snapshot.phase === 'stopped') {
      setActionError(''); setNotice('当前没有运行中的会话。请以最近核对的状态为准。');
    } else if (snapshot.sessionId !== stopPending.sessionId || snapshot.live !== stopPending.live) setActionError(STOP_SESSION_CHANGED);
    else return;
    setStopPending(null);
  }, [stopPending, snapshot]);

  const cleanup = async () => {
    const checked = await execute('cleanup', '/cleanup', 'POST', {}, '', undefined, 60_000);
    if (checked && 'data' in checked && !checked.data.recovery) setNotice('已完成上次实盘的恢复核对。');
  };
  const discard = async () => {
    if (busyRef.current || !guardRef.current.snapshot?.recovery || guardRef.current.active) return;
    if (await dialog.confirm('请先在 Ondo 核实已撤清本模块挂单，并确认剩余仓位由你自行处理。现在结束上次会话的恢复跟踪？实盘须另行手动启动。', { title: '结束恢复跟踪', confirmLabel: '确认结束', tone: 'danger' })) {
      if (!dialog.isAlive() || busyRef.current || !guardRef.current.snapshot?.recovery || guardRef.current.active) return;
      void execute('discard', '/recovery/discard', 'POST', {}, '已按人工核对结果结束恢复跟踪。');
    }
  };
  const recovery = snapshot?.recovery;
  const recoveryPositions = recovery?.error === 'positions_remain';
  const remaining = snapshot?.leftPositions.map(item => `${item.market} ${item.position}`).join('、');
  const liveSaved = snapshot?.config.mode === 'live';
  const confirmLive = !!snapshot && confirmedRevision === snapshot.revision;
  const startBlock = !snapshot ? '' : stateStale ? '等待最新会话状态' : dirty ? '请先保存设置' : liveSaved && !snapshot.credentials.configured ? '没有配置 API Key' : liveSaved && snapshot.paused ? snapshot.pauseReason ?? '挂单已暂停' : liveSaved && recovery ? '请先核对上次实盘的挂单与余仓' : liveSaved && !confirmLive ? '请先勾选实盘确认' : '';
  guardRef.current = { active, startBlock, snapshot };
  const heading = <header className="wb-heading"><div><h1>Ondo 挂单奖励</h1><p>观察奖励区间的盘口与触价频率。实盘仅在前方保护量充足时挂 Maker 开仓单，成交后暂停开仓并处理持仓。</p></div><div className="wb-toolbar">
    <button className="button secondary" disabled={!!busy} onClick={() => void resource.refresh()}><RefreshCw size={15} />刷新</button>
    {active ? <button key={stopRequest?.sessionId} className="button primary" disabled={!!busy || !stopRequest} title={!stopRequest ? '请刷新以核对当前会话' : undefined} onClick={() => void stop()}>{busy === 'stop' ? <LoaderCircle size={15} className="spin" /> : <Square size={15} />}{snapshot?.phase === 'stopping' ? '继续停止' : snapshot?.live ? '停止并撤单' : '停止观察'}</button>
      : <><button className="button secondary" disabled={!dirty || !!busy || !!configError} title={configError || undefined} onClick={() => void save()}>{busy === 'save' ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}保存设置</button>
        {liveSaved ? <button className="button primary" disabled={!!busy || !!startBlock} title={startBlock || undefined} onClick={() => void startLive()}>{busy === 'start' ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}启动实盘挂单</button> : null}</>}
  </div></header>;
  const disabled = active || !!busy;
  return <div className="wb-page">
    {heading}
    {actionError ? <Callout tone="error">{actionError}</Callout> : null}
    {notice && !snapshot?.incident ? <Callout tone="success">{notice}</Callout> : null}
    {loadError ? <Callout tone="warning">状态读取失败：{loadError}。保留最后读取的数据，稍后自动重试。</Callout> : null}
    {snapshot?.loadError ? <Callout tone="warning">{snapshot.loadError}</Callout> : null}
    {snapshot?.credentials.error ? <Callout tone="warning">{snapshot.credentials.error}</Callout> : null}
    {snapshot?.lastError ? <Callout tone="error">{snapshot.lastError}</Callout> : null}
    {snapshot?.incident ? <Callout tone="error"><strong>开仓风险锁已触发</strong> · {when(snapshot.incident.at)} · {snapshot.incident.market} · {snapshot.incident.reason}
      <p>本次会话全部市场停止开仓，进入撤单与持仓处理。请核对订单和余仓。恢复开仓须停止本次会话，再手动启动实盘。已配置飞书时推送告警。</p></Callout> : null}
    {remaining && !recoveryPositions ? <Callout tone="warning"><strong>最近一次实盘核对仍有余仓</strong> · {remaining}。这是核对时的数量。请到 Ondo 查验当前持仓并自行处理，或手动启动实盘时勾选接管。</Callout> : null}
    {recovery ? <Callout tone="warning"><strong>{recoveryPositions ? '本模块遗留挂单已清，账户仍有持仓' : '上次实盘的挂单与持仓待核对'}</strong>{recovery.startedAt ? ` · 上次启动 ${when(recovery.startedAt)}` : ''}
      <p>{recoveryPositions ? <>{remaining ? `上次核对余仓为 ${remaining}。` : ''}请到 Ondo 平仓后重新核对，或确认由你接手余仓。</>
        : recovery.error === 'position_unconfirmed' ? '订单可能已成交，最新持仓尚未证实结果。请核对 Ondo 成交记录和余仓。'
        : <>交易所可能仍有本模块的挂单。{recovery.error ? `最近一次核对未完成（${recovery.error}）。` : ''}</>}
        {recovery.cleaning ? '正在撤销遗留挂单并核对持仓…' : active ? '停止观察后可重新核对。' : ''}</p>
      <button className="button secondary" disabled={!!busy || recovery.cleaning || active} onClick={() => void cleanup()}>{busy === 'cleanup' ? <LoaderCircle size={15} className="spin" /> : null}{recoveryPositions ? '重新核对持仓' : '撤单并核对'}</button>
      {' '}{recovery.error && !recovery.cleaning ? <button className="button secondary" disabled={!!busy || active} onClick={discard}>已人工核对并接手</button> : null}</Callout> : null}
    {!snapshot || !draft ? <StatePanel kind="loading" title="正在读取状态" /> : <>
      <OndoObservationPanel snapshot={snapshot} rewards={rewards.data?.config.markets ?? []} busy={busy} dirty={dirty}
        stale={stateStale} onStart={body => {
          if (!active && !stateStale && !dirty && snapshot.config.mode === 'observe' && body.revision === snapshot.revision) void execute('start', '/start', 'POST', body, '观察已启动');
        }} />
      <div className="om-layout">
      <div className="om-column">
        <section className="panel wb-status" aria-label="运行状态"><div className="wb-state-line">
          <span className={`wb-state ${snapshot.incident ? 'fault' : snapshot.phase}`}>{snapshot.phase === 'stopped' ? '未运行' : snapshot.phase === 'stopping' ? '正在停止，撤单并核对中' : snapshot.incident ? '实盘已锁定开仓' : snapshot.live ? '实盘会话运行中' : '观察中（不下单）'}</span>
          {snapshot.paused && snapshot.live && active ? <span className="wb-paused">{snapshot.pauseReason}</span> : null}
          {dirty ? <span className="wb-paused">有未保存的修改</span> : null}</div>
          {active ? <div className="om-facts">
            <span>启动于 {when(snapshot.startedAt)}</span>
            <span>行情 {snapshot.stream?.publicReady ? '已连接' : `未连接${snapshot.stream?.error ? `（${snapshot.stream.error}）` : ''}`}</span>
            {snapshot.live ? <span>账户推送 {snapshot.stream?.privateReady ? '已连接' : '未连接'}</span> : null}
            {snapshot.live ? <span className={snapshot.stream?.deadManReady ? undefined : 'om-hold'}>账户断线撤单 {snapshot.stream?.deadManReady ? '已就绪' : '未就绪，暂停下单'}</span> : null}
            {snapshot.cooldownUntil && snapshot.cooldownUntil > snapshot.serverNow ? <span className="om-hold">限流冷却至 {when(snapshot.cooldownUntil)}</span> : null}
            {snapshot.syncError ? <span className="om-hold">账户读取失败：{snapshot.syncError}</span> : null}
            {snapshot.rulesError ? <span className="om-hold">市场规则读取失败：{snapshot.rulesError}</span> : null}
            {snapshot.totals && snapshot.live ? <span>下单 {snapshot.totals.placed} · 撤单 {snapshot.totals.canceled} · 成交 {snapshot.totals.fills} · 被拒 {snapshot.totals.rejected} · 只做 Maker 拦截 {snapshot.totals.postOnly}</span> : null}
          </div> : null}</section>
        <section className="panel" aria-label="市场"><div className="panel-heading"><h2>市场</h2><span className="muted">{active ? `数据 ${when(snapshot.serverNow)}` : '启动后显示'}</span></div>
          {!snapshot.markets.length ? <TableEmpty>尚未运行。启动观察后可查看各市场的虚拟挂单位置。</TableEmpty> : <div className="om-table"><table>
            <thead><tr><th scope="col">市场</th><th scope="col">状态</th><th scope="col" className="num">买一 / 卖一</th><th scope="col" className="num">持仓</th><th scope="col">买单</th><th scope="col">卖单</th></tr></thead>
            <tbody>{snapshot.markets.map(market => <tr key={market.market}>
              <th scope="row">{market.market}</th>
              <td className={market.hold || snapshot.incident ? 'om-hold' : 'om-ok'}>{market.hold ? HOLDS[market.hold] ?? market.hold : snapshot.incident ? '已锁定开仓' : snapshot.live ? '运行中' : '观察中'}
                {market.exitStatus ? <small>持仓处理 · {market.exitStatus}</small> : null}
                {market.error ? <small>循环出错：{market.error}</small> : null}</td>
              <td className="num">{market.bid ?? '—'} / {market.ask ?? '—'}</td>
              <td className="num">{market.position ?? '—'}{snapshot.live && !market.synced ? <small>核对中</small> : null}</td>
              <SideCell side={market.buy} /><SideCell side={market.sell} />
            </tr>)}</tbody>
          </table></div>}</section>
        <OndoLatencyPanel data={snapshot.latency} connected={!!snapshot.stream?.publicReady} stale={stateStale} />
        <section className="panel" aria-label="事件"><div className="panel-heading"><h2>事件</h2><span className="muted">最近 {snapshot.events.length} 条，重启后清空</span></div>
          {snapshot.events.length ? <ul className="om-events">{snapshot.events.map((event, index) => <li key={`${event.at}-${index}`}><time>{when(event.at)}</time><span>{event.market ? <b>{event.market}</b> : null}{event.text}</span></li>)}</ul>
            : <p className="muted om-form">暂无事件</p>}</section>
      </div>
      <div className="om-column">
        <section className="panel wb-section" aria-label="挂单设置"><div className="panel-heading"><h2>挂单设置</h2><span className="muted">{active ? '运行中不可修改' : `版本 ${snapshot.revision}`}</span></div>
          <fieldset className="om-form" disabled={disabled}>
            <div className="om-modes" role="radiogroup" aria-label="运行模式">
              <label><input type="radio" name="om-mode" checked={draft.mode === 'observe'} onChange={() => change({ mode: 'observe' })} />观察（只计算，不下单）</label>
              <label><input type="radio" name="om-mode" checked={draft.mode === 'live'} onChange={() => change({ mode: 'live' })} />实盘（真实下单）</label></div>
            <div className="wb-grid om-grid">
              <label className="wb-field wide"><span>已保存的挂单市场</span><input value={marketsText} onChange={e => { setMarketsText(e.target.value); change({ markets: marketList(e.target.value) }); }} placeholder="NVDA-USD.P, TSLA-USD.P" /><small>最多 10 个，逗号分隔。实盘使用这份名单，本次观察可在上方单独选市场。</small></label>
              <label className="wb-field"><span>每单金额（USD）</span><input inputMode="decimal" value={draft.orderUsd} onChange={e => change({ orderUsd: e.target.value.trim() })} /><small>每个市场买卖各挂一单。</small></label>
              <label className="wb-field"><span>目标距离（bps）</span><input inputMode="decimal" value={draft.targetBps} onChange={e => change({ targetBps: e.target.value.trim() })} /><small>距中间价 0–5 bps 的挂单分 85% 奖励。</small></label>
              <label className="wb-field"><span>最近距离（bps）</span><input inputMode="decimal" value={draft.minBps} onChange={e => change({ minBps: e.target.value.trim() })} /><small>比这更近立即撤单重挂。</small></label>
              <label className="wb-field"><span>最远距离（bps）</span><input inputMode="decimal" value={draft.maxBps} onChange={e => change({ maxBps: e.target.value.trim() })} /><small>比这更远、确认后改价；超过 25 bps 没有奖励。</small></label>
              <label className="wb-field"><span>单市场最大持仓（USD）</span><input inputMode="decimal" value={draft.maxPositionUsd} onChange={e => change({ maxPositionUsd: e.target.value.trim() })} /><small>限制该市场的开仓名义金额。</small></label>
              <label className="wb-field"><span>总名义上限（USD）</span><input inputMode="decimal" value={draft.maxTotalUsd} onChange={e => change({ maxTotalUsd: e.target.value.trim() })} /><small>上面所列市场的挂单与持仓合计；不含其他市场的持仓。</small></label>
              <label className="wb-field"><span>改价确认时间（毫秒）</span><input type="number" min={0} max={60000} value={draft.dwellMs} onChange={e => change({ dwellMs: Number(e.target.value) })} /><small>偏远时等这么久再改价，减少来回撤挂。</small></label>
              <label className="wb-field"><span>每秒请求上限</span><input type="number" min={1} max={10} value={draft.rps} onChange={e => change({ rps: Number(e.target.value) })} /><small>Ondo 未公布限速，默认保守；撤单优先于新挂单。</small></label>
            </div>
            <h3>开仓保护</h3>
            <div className="wb-grid om-grid"><label className="wb-field wide"><span>前方最低保护量（USD）</span><input inputMode="decimal" value={draft.wallUsd} onChange={e => change({ wallUsd: e.target.value.trim() })} /><small>同侧更优价格上的他人挂单合计须达到此金额。区间内保护不足就不挂，已有开仓单保护不足立即撤销。只减仓平仓单按下方退出设置执行。</small></label></div>
            <h3>成交后退出</h3>
            <p className="muted or-note">开仓单即使只成交一部分，也会锁住全部市场的新开仓，先撤开仓余单，再用只减仓 Maker 单平仓。已配置飞书时推送告警。</p>
            <div className="wb-grid om-grid">
              <label className="wb-field"><span>最长持仓时间（秒）</span><input type="number" min={1} max={86400} step={1} value={draft.maxHoldSec || ''} onChange={e => change({ maxHoldSec: Number(e.target.value) })} /></label>
              <label className="wb-field"><span>不利价格变动（bps）</span><input inputMode="decimal" value={draft.maxLossBps} onChange={e => change({ maxLossBps: e.target.value.trim() })} /><small>按可成交的对手价相对入场均价计算。触发时开始退出，实际亏损可能超过阈值。</small></label>
              <label className="wb-field"><span>IOC 滑点限幅（bps）</span><input inputMode="decimal" value={draft.exitSlippageBps} onChange={e => change({ exitSlippageBps: e.target.value.trim() })} /><small>仅用于限价 IOC。设为 0 时以当前对手价为界，可能有余仓。</small></label>
            </div>
            <h3 id="ondo-exit-mode">达到任一阈值后</h3>
            <div className="om-modes" role="radiogroup" aria-labelledby="ondo-exit-mode">
              <label><input type="radio" name="om-exit-mode" checked={draft.exitMode === 'makerThenIoc'} onChange={() => change({ exitMode: 'makerThenIoc' })} />限价 IOC 只减仓（可能吃单）</label>
              <label><input type="radio" name="om-exit-mode" checked={draft.exitMode === 'makerThenManual'} onChange={() => change({ exitMode: 'makerThenManual' })} />撤掉平仓挂单，人工接手</label>
            </div>
            {dirty && configError ? <Callout tone="warning">{configError}</Callout> : null}
          </fieldset>
          {!active && liveSaved ? <label className="checkbox-field om-confirm om-form"><input type="checkbox" checked={confirmLive} disabled={!!busy || dirty} onChange={e => setConfirmedRevision(e.target.checked ? snapshot.revision : null)} />
            <span>确认用真实资金在 {snapshot.config.markets.join('、')} 挂单，每单 {snapshot.config.orderUsd} USD。{ACCOUNT_WIDE_CONFIRMATION}{exitSummary(snapshot.config)}</span></label> : null}
          {!active && liveSaved ? <label className="checkbox-field om-form"><input type="checkbox" checked={adoptPositions} disabled={!!busy || dirty} onChange={e => setAdoptPositions(e.target.checked)} />接管所选市场的已有持仓，按上述设置平仓。不勾选时，这些市场有持仓就拒绝启动。</label> : null}
        </section>
        <section className="panel wb-section" aria-label="API Key"><div className="panel-heading"><h2>Ondo API Key</h2><span className="muted">{snapshot.credentials.configured ? `已配置 …${snapshot.credentials.hint ?? ''}` : '尚未配置'}</span></div>
          <p className="muted om-form">本服务从密钥文件 secrets.json 的 ondo（keyId、secret）读取，不在页面填写或回显。从工作台迁移时在设置页「从工作台导入」勾选 Ondo 一并导入；自己修改时改密钥文件后重启服务。没有 Key 时只能观察。在 Ondo Perps 的 API 管理页创建，只需交易权限，建议绑定服务器 IP 白名单。</p></section>
      </div>
    </div></>}
    <OndoRewards mmConfig={snapshot?.config ?? null} onExpired={onExpired} windowMin={rewardWindow} setWindowMin={setRewardWindow} resource={rewards} />
  </div>;
}
