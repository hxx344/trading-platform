// 改编自 project-aggregation 工作台 modules/crossex/src/App.tsx（提交 7745181）。差异：没有工作台外壳（hub-bridge），
// 读取只在页面可见且在线时进行；没有 Monitor 跳转按钮与行情来源标记，也不接收 Monitor 导入的机会；接口改为
// /api/crossex/*，经 api.ts 发出（x-pa-executor 头，没有 CSRF 令牌），请求编号用 request-ids.ts；
// 设置页不填写或移除 API 密钥。子页面地址为 #/crossex[/trade|/hedge|/orders|/settings]。
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, AlertTriangle, ArrowLeftRight, RefreshCw, LayoutDashboard, CandlestickChart, ListOrdered, Settings2 } from 'lucide-react';
import { api } from '../api.ts';
import { newRequestId, RequestIds } from '../request-ids.ts';
import { createLatestRead } from './latest-read.ts';
import { createServerClock, sourceIsStale, STATE_POLL_MS } from './freshness.ts';
import { readPollDelay, observeReadWake, usePageActivity } from './page-activity.ts';
import type { LiveBootstrap, LiveExecution, LiveOrder, LivePreview, LiveState, PositionActionInput, PreviewInput } from './live-types.ts';
import { positionPreviewChanged } from './position-actions.ts';
import { BOOTSTRAP_REFRESH_MS, latestBootstrap, needsCatalog, parseBootstrap, readRetryDelay, stateReadPath } from './live-loading.ts';
import { time } from './display.ts';
import { executionStatus, liveStatus, orderIsTerminal, stateIsUncertain } from './live-display.ts';
import { readPendingRequest, readRequestStatus, requestStorageKey, resolveRequestStatus, writePendingRequest } from './live-requests.ts';
import type { PendingRequest } from './live-requests.ts';
import { CROSSEX_API, CROSSEX_BOOTSTRAP_PATH, CROSSEX_SETTINGS_PATH, sessionExpired, writeNotSubmitted } from './crossex-api.ts';
import AccountOverview from './AccountOverview.tsx';
import PortfolioPanel from './PortfolioPanel.tsx';
import TradingTerminal from './TradingTerminal.tsx';
import ManualHedgePanel from './ManualHedgePanel.tsx';
import { useInstruments } from './live-market.ts';
import SettingsForm from './SettingsForm.tsx';
import HistoryPanel from './HistoryPanel.tsx';
import { CancelReview, TradeReview } from './TradeReview.tsx';

import type { CrossexTab } from '../route-parse.ts';
export type { CrossexTab };
const tabs: [CrossexTab, string, typeof ArrowLeftRight][] = [['positions', '持仓', LayoutDashboard], ['trade', '交易', CandlestickChart], ['hedge', '对冲', ArrowLeftRight], ['orders', '订单', ListOrdered], ['settings', '设置', Settings2]];
export const crossexHref = (tab: CrossexTab) => tab === 'positions' ? '#/crossex' : `#/crossex/${tab}`;

export function CrossexPage({ tab, onExpired }: { tab: CrossexTab; onExpired: () => void }) {
  const hub = usePageActivity();
  const expired = useRef(onExpired); expired.current = onExpired;
  const [state, setState] = useState<LiveState | null>(null), [online, setOnline] = useState(false);
  const [bootstrap, setBootstrap] = useState<LiveBootstrap | null>(null), [bootstrapError, setBootstrapError] = useState(''), [bootstrapLoading, setBootstrapLoading] = useState(false);
  const [bootstrapRevision, setBootstrapRevision] = useState(0);
  const [error, setError] = useState(''), [readError, setReadError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<LivePreview | null>(null), [cancelOrder, setCancelOrder] = useState<LiveOrder | null>(null);
  const [positionPreview, setPositionPreview] = useState<PositionActionInput | null>(null), [previewInvalidated, setPreviewInvalidated] = useState(false);
  const [confirmRejected, setConfirmRejected] = useState(false);
  const previewInput = useRef<PreviewInput | null>(null), writeNotSent = useRef(false);
  const [requestStore] = useState(() => { let storage: Storage | null = null; try { storage = window.sessionStorage; } catch { /* Writes stay blocked when their identity cannot survive reload. */ } return { storage, key: requestStorageKey(location.pathname + '#/crossex') }; });
  const [pendingRequest, setPendingRequest] = useState<PendingRequest | null>(() => readPendingRequest(requestStore.storage, requestStore.key)), [now, setNow] = useState(0);
  const pendingRef = useRef(pendingRequest);
  const operationPending = useRef(false);
  const requests = useRef(new RequestIds(newRequestId));
  const rememberPending = useCallback((next: PendingRequest | null) => {
    const saved = writePendingRequest(requestStore.storage, requestStore.key, next);
    if (!saved && next) return false;
    pendingRef.current = next; setPendingRequest(next); return true;
  }, [requestStore]);
  const lifecycle = useRef({ active: hub.readActive, mutating: false, tab }); lifecycle.current.active = hub.readActive; lifecycle.current.tab = tab;
  const serverClock = useRef(createServerClock());
  const instruments = useInstruments(hub.readActive && needsCatalog(tab), hub.background);
  const bootstrapFailures = useRef(0), stateFailures = useRef(0);
  const bootstrapReader = useRef<ReturnType<typeof createLatestRead<LiveBootstrap>> | null>(null);
  if (!bootstrapReader.current) bootstrapReader.current = createLatestRead<LiveBootstrap>({
    canRead: () => lifecycle.current.active && !lifecycle.current.mutating,
    load: async signal => {
      setBootstrapLoading(true);
      return parseBootstrap(await api<unknown>(CROSSEX_BOOTSTRAP_PATH, { signal, timeoutMs: 8000 }));
    },
    onData: data => { bootstrapFailures.current = 0; setBootstrap(data); setBootstrapError(''); setBootstrapLoading(false); },
    onError: cause => { if (sessionExpired(cause)) expired.current(); bootstrapFailures.current++; setBootstrapLoading(false); setBootstrapError(cause instanceof Error && cause.name !== 'TimeoutError' ? cause.message : '读取连接信息超时，请重试。'); },
    timeoutMs: 8000,
  });
  const cancelBootstrap = useCallback(() => { bootstrapReader.current?.cancel(); setBootstrapLoading(false); }, []);
  const refreshBootstrap = useCallback(() => bootstrapReader.current!.refresh(), []);
  const loadBootstrap = tab === 'settings' || !bootstrap && !state;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined, epoch = 0, stopped = false;
    const synchronize = () => {
      const version = ++epoch; clearTimeout(timer); cancelBootstrap();
      if (!loadBootstrap || !hub.readActive || busy || stopped) return;
      const poll = async () => {
        if (version !== epoch || stopped) return;
        await refreshBootstrap();
        if (version === epoch && !stopped) timer = setTimeout(poll, readPollDelay(bootstrapFailures.current ? readRetryDelay(bootstrapFailures.current) : BOOTSTRAP_REFRESH_MS, hub.background));
      };
      void poll();
    };
    synchronize(); const stopWake = observeReadWake(synchronize);
    return () => { stopped = true; epoch++; clearTimeout(timer); cancelBootstrap(); stopWake(); };
  }, [hub.readActive, hub.background, loadBootstrap, busy, bootstrapRevision, refreshBootstrap, cancelBootstrap]);
  const reader = useRef<ReturnType<typeof createLatestRead<LiveState & { requestStartedAt: number; requestedTab: CrossexTab }>> | null>(null);
  if (!reader.current) reader.current = createLatestRead<LiveState & { requestStartedAt: number; requestedTab: CrossexTab }>({
    canRead: () => lifecycle.current.active && lifecycle.current.tab !== 'settings' && !lifecycle.current.mutating,
    load: async signal => {
      const requestStartedAt = performance.now(), requestedTab = lifecycle.current.tab;
      const data = await api<LiveState>(stateReadPath(requestedTab), { signal, timeoutMs: 12_000 });
      if (!data.live) throw new Error('服务尚未提供完整实盘账户状态，请更新服务后重试');
      return { ...data, requestStartedAt, requestedTab };
    },
    onData: ({ requestStartedAt, requestedTab, ...data }) => {
      if (requestedTab !== lifecycle.current.tab) return;
      stateFailures.current = 0;
      serverClock.current.sample(data.now, requestStartedAt); setState(data); setOnline(true); setReadError(''); setNow(serverClock.current.now());
    },
    onError: cause => { if (sessionExpired(cause)) expired.current(); stateFailures.current++; setOnline(false); setReadError(cause instanceof Error ? cause.name === 'TimeoutError' ? '读取超时，保留上次数据；恢复连接后继续查询。' : cause.message : '连接中断，保留上次数据。'); },
  });
  const cancelRead = useCallback(() => reader.current?.cancel(), []);
  const refresh = useCallback((force = false) => reader.current!.refresh(force), []);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined, epoch = 0, stopped = false;
    const synchronize = () => {
      setNow(serverClock.current.now());
      const version = ++epoch; clearTimeout(timer); cancelRead();
      if (!hub.readActive || tab === 'settings' || stopped) return;
      const poll = async () => { if (version !== epoch || stopped) return; const startedAt = performance.now(); await refresh(); if (version === epoch && !stopped) timer = setTimeout(poll, readPollDelay(stateFailures.current ? readRetryDelay(stateFailures.current) : Math.max(0, STATE_POLL_MS - (performance.now() - startedAt)), hub.background)); };
      void poll();
    };
    // Ageing the data every second re-renders the whole tree; skip it while the tab is hidden.
    const ageTimer = setInterval(() => { if (hub.readActive && !hub.background) setNow(serverClock.current.now()); }, 1000);
    synchronize(); const stopWake = observeReadWake(synchronize);
    return () => { stopped = true; epoch++; clearTimeout(timer); clearInterval(ageTimer); cancelRead(); stopWake(); };
  }, [hub.readActive, hub.background, tab, refresh, cancelRead]);
  useEffect(() => {
    if (!pendingRequest || !state || busy) return;
    const execution = pendingRequest.kind === 'confirm' ? state.live.executions.find(item => item.requestId === pendingRequest.id || item.id === pendingRequest.id) : null;
    const order = pendingRequest.kind === 'cancel' && pendingRequest.orderId ? state.live.orders.find(item => item.id === pendingRequest.orderId || item.orderId === pendingRequest.orderId) : null;
    if (execution && !stateIsUncertain(execution.state) || order && orderIsTerminal(order.status)) {
      rememberPending(null); setError(''); setNotice('已查询到先前操作的结果，请核对订单与逐腿持仓。');
    }
  }, [pendingRequest, state, busy, rememberPending]);
  const connectionInfo = latestBootstrap(bootstrap, state);

  async function mutate<T>(route: string, input: object, actionKey?: string): Promise<T | null> {
    const administrative = route === CROSSEX_SETTINGS_PATH;
    writeNotSent.current = true;
    if (operationPending.current || !administrative && (!state || tradingDisabled) || administrative && !connectionInfo || actionKey && pendingRef.current) return null;
    operationPending.current = true; lifecycle.current.mutating = true; cancelRead(); cancelBootstrap(); setBusy(true); setError(''); setNotice('');
    let id: string | undefined;
    try {
      if (actionKey) {
        id = requests.current.idFor(actionKey);
        const pending: PendingRequest = { version: 1, id, kind: actionKey.startsWith('cancel:') ? 'cancel' : 'confirm', ...(actionKey.startsWith('cancel:') ? { orderId: actionKey.slice(7) } : {}) };
        if (!rememberPending(pending)) { setError('此浏览器无法保存待确认请求，委托尚未发送。请允许会话存储后重试。'); return null; }
      }
      writeNotSent.current = false;
      let data: T & { execution?: { state?: string; status?: string }; order?: { id?: string; status?: string }; state?: string; status?: string };
      try {
        data = await api<typeof data>(route, { body: { ...input, ...(id ? { requestId: id } : {}) }, timeoutMs: 30_000, ...(administrative ? { method: 'PUT' as const } : {}) });
      } catch (cause) {
        // Any answer from the server ends this request id; a lost answer keeps it for the status query.
        if (actionKey && typeof (cause as { status?: unknown }).status === 'number') requests.current.answered(actionKey);
        if (actionKey && writeNotSubmitted(cause)) { writeNotSent.current = true; rememberPending(null); setError(cause instanceof Error && cause.message ? cause.message : '委托未提交，请重新预览。'); return null; }
        throw cause;
      }
      if (actionKey) requests.current.answered(actionKey);
      if (id) {
        const result = data.execution || data;
        if (data.order?.id && pendingRef.current) rememberPending({ ...pendingRef.current, orderId: data.order.id });
        const resultState = result.state || data.order?.status || result.status;
        if (resultState && !stateIsUncertain(resultState)) rememberPending(null);
      }
      if (administrative) setOnline(false);
      return data as T;
    } catch (cause) {
      setError(actionKey ? '提交结果尚未确认。请查询最新状态，确认前不要再次提交。请求编号：' + id : cause instanceof Error ? cause.message : '请求未完成，请稍后重试');
      return null;
    } finally {
      lifecycle.current.mutating = false;
      try {
        if (lifecycle.current.tab === 'settings') setBootstrapRevision(value => value + 1);
        else await refresh(true);
      } finally { operationPending.current = false; setBusy(false); }
    }
  }
  const go = (value: CrossexTab) => { location.hash = crossexHref(value); window.scrollTo(0, 0); };
  const queryAccount = async () => {
    if (operationPending.current) return;
    operationPending.current = true; lifecycle.current.mutating = true; cancelRead(); cancelBootstrap(); setBusy(true); setError(''); setNotice('');
    let message = '已查询账户与订单状态。';
    try {
      const pending = pendingRef.current;
      if (pending) {
        const resolution = resolveRequestStatus(pending, await readRequestStatus(pending));
        if (resolution.resolved) {
          rememberPending(null);
          message = resolution.notSubmitted ? '服务已确认原请求未提交。可重新预览并核对后下单。' : '已查到原请求的真实结果，请核对订单与逐腿持仓。';
        } else {
          if (resolution.orderId) rememberPending({ ...pending, orderId: resolution.orderId });
          message = '原请求仍待确认，继续保留交易限制；本次仅查询账户与订单。';
        }
      }
      if (!connectionInfo) { setNotice(message); throw new Error('连接信息尚未读取；未发送账户刷新请求，请重试读取连接信息。'); }
      try { await api(`${CROSSEX_API}/refresh`, { body: {}, timeoutMs: 30_000 }); }
      catch (cause) { throw cause instanceof Error && cause.message ? cause : new Error('账户查询未完成，请继续查询。'); }
      setNotice(message);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '状态查询未完成，待确认请求已保留。'); }
    finally {
      lifecycle.current.mutating = false;
      try {
        if (lifecycle.current.tab === 'settings') setBootstrapRevision(value => value + 1);
        else await refresh(true);
      } finally { operationPending.current = false; setBusy(false); }
    }
  };
  const previewOrder = async (input: PreviewInput) => {
    const data = await mutate<LivePreview | { preview: LivePreview }>(`${CROSSEX_API}/preview`, input);
    if (data) { previewInput.current = input; setPreview('preview' in data ? data.preview : data); setPositionPreview(input.kind === 'position' ? input : null); setPreviewInvalidated(false); setConfirmRejected(false); }
    return !!data;
  };
  const closePreview = () => { setPreview(null); setConfirmRejected(false); };
  const repreviewOrder = async () => { if (previewInput.current) await previewOrder(previewInput.current); };
  const confirmOrder = async () => {
    if (!preview || positionPreviewInvalid || tradingDisabled || preview.legs.some(leg => !leg.reduceOnly) && openingDisabled) return;
    const current = preview;
    const data = await mutate<LiveExecution | { execution: LiveExecution }>(`${CROSSEX_API}/confirm`, { previewId: current.id }, 'confirm:' + current.id);
    // Only a write that never left the browser or that the server proved unsent keeps the review open for an immediate re-preview.
    if (!data && writeNotSent.current) { setError(message => message || '委托未发送，请重新预览。'); setConfirmRejected(true); return; }
    closePreview(); go('orders');
    if (data) { const result = 'execution' in data ? data.execution : data; setNotice('真实委托处理状态：' + executionStatus(result.state) + '。请核对逐腿成交结果。'); }
  };
  const confirmCancel = async () => {
    if (!cancelOrder) return;
    const data = await mutate(`${CROSSEX_API}/cancel`, { orderId: cancelOrder.id }, 'cancel:' + cancelOrder.id);
    setCancelOrder(null); if (data) setNotice('撤单请求已处理，请核对最新订单状态。');
  };
  const marketStale = sourceIsStale(state?.source, now, online);
  const live = state?.live;
  const accountStale = !online || !live || live.stale || live.partial || !live.asOf || now - live.asOf > 15_000 || live.asOf > now + 1000;
  const accountStatus = !live?.connection.configured ? live?.status || 'offline'
    : !online ? 'offline' : live.partial ? 'partial' : accountStale ? 'stale' : live.status;
  const tradingDisabled = busy || !live?.tradingAllowed || accountStale || !!pendingRequest;
  const openingDisabled = tradingDisabled || !!state?.config.entryPaused;
  const positionPreviewInvalid = !!preview && !!positionPreview && (previewInvalidated || !live || positionPreviewChanged(positionPreview, live));
  useEffect(() => { if (positionPreviewInvalid) setPreviewInvalidated(true); }, [positionPreviewInvalid]);
  const capacityContext = live && state ? { live: { ...live, stale: accountStale }, active: hub.readActive, background: hub.background,
    now, readNow: serverClock.current.now,
    revision: JSON.stringify([state.config, !!pendingRequest, live.orders.map(o => [o.id, o.status, o.filledQuantity]), live.positions.map(p => [p.id, p.quantity])]) } : null;
  const extraAlerts = live?.alerts.map(item => typeof item === 'string' ? item : item.message || item.reason).filter((item): item is string => !!item && !live.reasons.includes(item) && item !== live.connection.error) || [];
  const accountWarnings = live ? [...(accountStale && live.connection.configured ? [live.partial ? '账户数据不完整，保留上次已知数据，暂停交易。' : '账户数据待更新，保留上次已知数据，暂停交易。'] : []), ...live.reasons, ...(live.connection.error ? [live.connection.error] : [])].filter((item, index, all) => all.indexOf(item) === index) : [];
  // Every source here blocks or pauses trading (server reasons gate tradingAllowed; alerts carry no severity), so all stay fully visible.
  const alerts = [...accountWarnings, ...extraAlerts.filter(item => !accountWarnings.includes(item))];
  const counts: Partial<Record<CrossexTab, number>> = live ? { positions: live.positions.length, orders: live.orders.filter(order => !orderIsTerminal(order.status)).length } : {};

  return <div className="crossex-page"><div className="app hub-embedded"><header className="topbar"><a className="brand" href={crossexHref('positions')}><span className="brand-icon"><ArrowLeftRight size={21}/></span><span>Gate <strong>CrossEx</strong></span><span className="tag live-tag">LIVE</span></a>
    <nav aria-label="模块功能">{tabs.map(([id, label, Icon]) => <button key={id} type="button" aria-current={tab === id ? 'page' : undefined} onClick={() => go(id)}><Icon size={15}/>{label}{counts[id] != null && <span className="count" aria-hidden="true">{counts[id]}</span>}</button>)}</nav>
    <div className="header-actions"><span className={'connection-badge ' + (!accountStale && live?.connection.connected ? 'positive' : 'warning')}><i className={'status-dot ' + (!accountStale && live?.connection.connected ? 'live' : '')}/>{!connectionInfo ? '读取连接信息' : !connectionInfo.connection.configured ? '未连接账户' : accountStale ? '待同步' : '账户已连接'}</span><button type="button" className="icon-button" disabled={busy} onClick={() => { if (tab === 'settings') void refreshBootstrap(); else void refresh(true); }} aria-label="刷新页面状态"><RefreshCw size={15}/></button><button type="button" className="primary small" onClick={() => go('settings')}>{connectionInfo?.connection.configured ? '管理账户' : '连接账户'}</button></div>
  </header><main>
    {(error || tab !== 'settings' && readError) && <div className="notice error" role="alert"><AlertCircle size={16}/><span>{error || readError}</span>{error && !pendingRequest && <button type="button" onClick={() => setError('')} aria-label="关闭操作提示">×</button>}</div>}
    {pendingRequest && <div className="notice warning" role="status"><span>存在结果待确认的操作，新的交易暂不可用。请求 {pendingRequest.id}</span><button type="button" disabled={busy} onClick={() => void queryAccount()}>查询最新状态</button></div>}
    {notice && <div className="notice success" role="status"><span>{notice}</span><button type="button" aria-label="关闭状态提示" onClick={() => setNotice('')}>×</button></div>}
    {tab === 'settings' && <SettingsForm config={connectionInfo?.config || null} connection={connectionInfo?.connection ?? null} limits={connectionInfo?.limits ?? null} ready={!!connectionInfo} loading={bootstrapLoading} loadError={bootstrapError} retry={() => void refreshBootstrap()} busy={busy} save={async input => !!await mutate(CROSSEX_SETTINGS_PATH, input)}/>}
    {tab === 'settings' ? null : !state || !live ? <div className="empty panel loading-state"><p>{readError ? '账户状态尚未读取，可重试或先查看账户设置。' : '正在读取 Gate CrossEx 账户状态…'}</p><div className="filters"><button type="button" disabled={busy} onClick={() => void refresh(true)}>重试账户状态</button><button type="button" className="primary" onClick={() => go('settings')}>账户设置</button></div></div> : <>
      <div className="account-identity strip"><div>{alerts.length ? <span className="strip-alert warning"><AlertTriangle size={13}/>{alerts.length} 项提醒</span> : <span className="strip-quiet">无提醒</span>}<i className="strip-sep"/><span className="strip-brand">Gate CrossEx</span><strong>{live.connection.accountId ? 'UID ' + live.connection.accountId : live.connection.connected ? 'UID 未返回' : '账户尚未连接'}</strong><span>Key {live.connection.keySuffix ? '•••• ' + live.connection.keySuffix : '—'}</span><span>{live.connection.positionMode === 'SINGLE' ? '单向持仓' : live.connection.positionMode === 'DUAL' ? '双向持仓' : '持仓模式待查询'}</span><span className={accountStale ? 'warning' : 'positive'}>{liveStatus(accountStatus)}</span><i className="strip-sep"/><span>账户来源 {time(live.asOf)}</span></div><div><button type="button" className="text-button" disabled={busy || !live.connection.configured} onClick={() => void queryAccount()}><RefreshCw size={12}/>{busy ? '处理中…' : '查询账户与订单'}</button></div></div>
      {alerts.length > 0 && <ul className="strip-risks" role="status" aria-label="交易风险提示">{alerts.map(item => <li key={item}><AlertCircle size={13}/><span>{item}</span></li>)}</ul>}
      {state.config.entryPaused && (tab === 'trade' || tab === 'hedge') && <p className="inline-state warning">新开仓已暂停，可在设置中恢复；仍可手动平仓和撤单。</p>}
      {tab === 'positions' && <><AccountOverview live={live} stale={accountStale}/><PortfolioPanel positionFundingRates={state.positionFundingRates} now={now} fundingOpportunities={state.fundingOpportunities || []} marketStale={marketStale} live={{ ...live, stale: accountStale }} instruments={instruments.items} disabled={tradingDisabled || !!preview} preview={previewOrder} previewError={error} budget={state.config.notionalPerLeg} entryPaused={!!state.config.entryPaused} capacityContext={capacityContext!} catalogError={instruments.error} close={positions => previewOrder({ kind: 'close', positions })}/></>}
      {tab === 'trade' && <TradingTerminal instruments={instruments.items} catalogError={instruments.error} live={live} budget={state.config.notionalPerLeg} active={hub.readActive} background={hub.background} disabled={openingDisabled} preview={previewOrder} capacityContext={capacityContext!}/>}
      {tab === 'hedge' && <ManualHedgePanel instruments={instruments.items} catalogError={instruments.error} live={live} budget={state.config.notionalPerLeg} slippageBps={state.config.slippageBps} fx={state.fx} active={hub.readActive} background={hub.background} disabled={openingDisabled} fundingOpportunities={state.fundingOpportunities || []} now={now} monitorStale={marketStale} preview={previewOrder} capacityContext={capacityContext!}/>}
      {tab === 'orders' && <><HistoryPanel live={live} disabled={tradingDisabled} querying={busy} query={() => void queryAccount()} cancel={setCancelOrder}/></>}

    </>}
    <footer className="app-footer"><span><i className="status-dot"/>手动实盘 · 北京时间 · 2 秒状态刷新</span><span><a href="https://github.com/hxx344/gate-crossex-arbitrage" target="_blank" rel="noreferrer">源代码</a><b>·</b><a href="https://github.com/your-quantguy/gate-crossex" target="_blank" rel="noreferrer">参考 your-quantguy/gate-crossex</a><b>·</b><a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noreferrer">AGPL-3.0-only</a></span></footer>
  </main>
  {preview && <TradeReview key={preview.id} preview={preview} now={now} busy={busy} disabled={positionPreviewInvalid || (preview.legs.some(leg => !leg.reduceOnly) ? openingDisabled : tradingDisabled)} invalidReason={positionPreviewInvalid ? '持仓数量、方向或账户已变化，请关闭并重新预览。' : undefined} error={error} rejected={confirmRejected} close={closePreview} confirm={() => void confirmOrder()} repreview={live && String(live.connection.version) === String(preview.connectionVersion) ? () => void repreviewOrder() : undefined}/>}
  {cancelOrder && <CancelReview order={cancelOrder} busy={busy} disabled={tradingDisabled} close={() => setCancelOrder(null)} confirm={() => void confirmCancel()}/>}
  </div></div>;
}
