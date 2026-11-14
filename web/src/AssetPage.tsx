// The asset page: the workbench ledger's overview, history and withdrawals views (project_aggregation
// modules/asset/app/dashboard.tsx and withdrawals-panel.tsx at 0014655). Changes: the data is what src/asset/import.ts
// imported and the service computes the figures (/api/asset/*); the edit, fx and withdrawal writes go to this service's
// ledger (A-2, docs/asset.md); the sync and the connections view are A-3 (AssetConnections.tsx); the import dialog is
// left out (the settings page imports); dialogs became panels opened in place; the toasts are a status line under the
// alerts.
import { Check, ChevronRight, Eye, Info, Pencil, Plus, RefreshCw, ShieldCheck, Trash2, TriangleAlert, X } from 'lucide-react';
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError } from './api.ts';
import { newRequestId } from './request-ids.ts';
import { StatePanel } from './StateViews.tsx';
import { useLiveResource } from './use-live-resource.ts';
import { AssetTrend } from './AssetTrend.tsx';
import { CONNECTIONS_PATH, ConnectionsView, SIDE_EXCHANGES, pendingText, type CardExchange } from './AssetConnections.tsx';
import { startRefreshLoop } from './asset-refresh-loop.ts';
import { isExchangeMode, EXCHANGE_NAMES, type AssetHistoryView, type AssetLedgerView, type AssetPeriodView, type AssetState, type AssetWithdrawalsView, type HistoryRow } from '../../src/asset/views.ts';
import type { Asset, Withdrawal } from '../../src/asset/types.ts';
import {
  IMPORT_COMMAND, badge, detailHeads, detailLine, detailNote, detailSubtitle, detailTitle, fullStamp, fxView, money, periodFxTitle, periodKind, periodSource,
  priceText, quantityText, stamp, staleRow, statusTone, zhMoney,
} from './asset-format.ts';

export const ASSET_STATE_PATH = '/api/asset/state';
export const ASSET_READ_TIMEOUT_MS = 10_000;
/** The data changes with a new import or a write here; the minute is how soon one from elsewhere shows. */
const REFRESH_MS = 60_000;
/** A write waits longer than a read: it runs under the ledger's sync lock (docs/asset.md A-2). */
export const ASSET_WRITE_TIMEOUT_MS = 20_000;
/** The workbench's limits (dashboard.tsx api()): a sync reads every exchange, a connection is verified with one first. */
const SYNC_PATH = '/api/asset/sync';
const SYNC_TIMEOUT_MS = 80_000, CONNECT_TIMEOUT_MS = 60_000;
const writeTimeout = (path: string): number => path.startsWith(CONNECTIONS_PATH) || path.startsWith('/api/asset/aster-accounts/') ? CONNECT_TIMEOUT_MS : ASSET_WRITE_TIMEOUT_MS;

/**
 * One write at a time for the whole page, like the workbench's mutate(): busy blocks the other forms, the error stays in
 * the open form with its input, and a confirmed answer becomes the ledger at once.
 */
export type Writer = { busy: boolean; writes: number; errorOf: (...paths: string[]) => string; clear: () => void; run: <T>(path: string, body: unknown, done: (result: T) => void) => Promise<void> };

type View = 'overview' | 'history' | 'withdrawals' | 'connections';
const VIEWS: { id: View; label: string }[] = [{ id: 'overview', label: '资产总览' }, { id: 'history', label: '历史记录' }, { id: 'withdrawals', label: '出金记录' }, { id: 'connections', label: '交易所连接' }];
const VIEW_DESCRIPTIONS: Record<View, string> = { overview: '实时估值与手动资产，统一记录', history: '保留原表记录；每天保存最近一次更新', withdrawals: '登记出金，观察剔除提款影响后的资产变化', connections: '通过读取接口获取账户资产，连接凭据仅加密保存在服务端' };
type Filter = 'all' | 'auto' | 'manual';
const FILTERS: { id: Filter; label: string }[] = [{ id: 'all', label: '全部资产' }, { id: 'auto', label: '自动更新' }, { id: 'manual', label: '手动维护' }];

export function AssetPage({ onExpired }: { onExpired: () => void }) {
  const [view, setView] = useState<View>('overview');
  const [connecting, setConnecting] = useState<CardExchange | null>(null);
  const state = useLiveResource<AssetState>(ASSET_STATE_PATH, { intervalMs: REFRESH_MS, timeoutMs: ASSET_READ_TIMEOUT_MS, onExpired });
  const imported = state.data?.imported === true;
  const ledger = useLiveResource<AssetLedgerView>('/api/asset/ledger', { intervalMs: REFRESH_MS, timeoutMs: ASSET_READ_TIMEOUT_MS, enabled: imported, onExpired });
  const history = useLiveResource<AssetHistoryView>('/api/asset/history', { intervalMs: REFRESH_MS, timeoutMs: ASSET_READ_TIMEOUT_MS, enabled: imported && view !== 'withdrawals', onExpired });
  const withdrawals = useLiveResource<AssetWithdrawalsView>('/api/asset/withdrawals', { intervalMs: REFRESH_MS, timeoutMs: ASSET_READ_TIMEOUT_MS, enabled: imported && view === 'withdrawals', onExpired });
  const version = state.data?.importedAt ?? '';
  // A new import shows up in the state first; the views follow at once instead of at their next minute.
  const seen = useRef(version);
  const { refresh: refreshLedger } = ledger, { refresh: refreshHistory } = history, { refresh: refreshWithdrawals } = withdrawals;
  useEffect(() => {
    if (seen.current === version) return;
    seen.current = version;
    void refreshLedger(); void refreshHistory(); void refreshWithdrawals();
  }, [version, refreshLedger, refreshHistory, refreshWithdrawals]);
  const writer = useWriter({ onExpired, onLedger: ledger.commit, onWritten: useCallback((committed: boolean) => { void state.refresh(); if (!committed) void refreshLedger(); void refreshHistory(); void refreshWithdrawals(); }, [state.refresh, refreshLedger, refreshHistory, refreshWithdrawals]) });
  // The workbench's startRefreshLoop: a sync every minute while the page is shown and online, and one when it comes back.
  const sync = useRef(writer.sync), stopSync = useRef(writer.stopSync);
  useEffect(() => { sync.current = writer.sync; stopSync.current = writer.stopSync; });
  useEffect(() => {
    if (!imported) return;
    const loop = startRefreshLoop({ page: document, view: window, enabled: () => !document.hidden && navigator.onLine, onActivity: active => { if (!active) stopSync.current(); }, refresh: () => void sync.current(false) });
    return () => loop.stop();
  }, [imported]);

  const failed = (status: string) => status === 'error' || status === 'offline';
  if (!state.data) return <div className="asset-desk"><div className="page">{failed(state.status)
    ? <StatePanel kind="error" title="读取资产账本失败" detail={state.error?.message ?? '网络离线'} />
    : <StatePanel kind="loading" title="加载中…" />}</div></div>;
  if (!state.data.imported) return <div className="asset-desk"><div className="page">
    <StatePanel kind="empty" title="尚未导入资产账本" detail="本服务的资产页数据来自工作台资产账本的一次导入。到「设置」页的「从工作台导入」点「读取工作台」，勾选「导入资产账本」并选择工作台用户即可（不重启服务）；导入完成后本页一分钟内显示。也可在服务器上运行下面的命令（参数见 README 的 asset 一节）。">
      <p><a className="button secondary" href="#/settings">打开设置页导入</a></p>
      <code className="import-command">{IMPORT_COMMAND}</code>
    </StatePanel>
  </div></div>;

  const info = state.data, data = ledger.data?.imported ? ledger.data : null;
  const navigate = (next: View) => { setView(next); if (next !== 'connections') setConnecting(null); window.scrollTo({ top: 0 }); };
  const connect = (exchange: CardExchange | 'aster') => { writer.clear(); setView('connections'); setConnecting(exchange === 'aster' ? null : exchange); window.scrollTo({ top: 0 }); };
  const pending = data?.ledger ? Object.values(data.ledger.connections).filter(item => !item.configured).length : 0;
  const counts: Partial<Record<View, string>> = { history: history.data?.imported ? String(history.data.periods.length) : undefined, withdrawals: data?.ledger ? String(data.ledger.withdrawals.length) : undefined, connections: pending ? pending + ' 待连接' : undefined };
  const readErrors = [state, ledger, view === 'withdrawals' ? withdrawals : history].filter(item => failed(item.status) && item.error).map(item => item.error!.message);
  const alerts: { key: string; role: 'alert' | 'status'; text: string; tone: 'error' | 'warn' }[] = [
    ...(writer.syncError ? [{ key: 'sync', role: 'alert' as const, text: '同步失败：' + writer.syncError + '。当前显示上次同步的数据。', tone: 'error' as const }] : []),
    ...[...new Set(readErrors)].map(text => ({ key: 'read:' + text, role: 'alert' as const, text: '读取失败：' + text + '。当前显示上次读取的数据。', tone: 'error' as const })),
    ...(data?.ledger?.fxStatus.error ? [{ key: 'fx', role: 'status' as const, text: data.ledger.fxStatus.error + '，人民币折算暂用 1 USD = ' + money(data.ledger.fx, 4) + ' CNY。', tone: 'warn' as const }] : []),
    ...(data?.summary?.valuation.partial ? [{ key: 'valuation', role: 'status' as const, text: data.summary.valuation.missingValues + ' 项资产估值缺失，汇总仅包含已知金额，当前为部分估值。', tone: 'warn' as const }] : []),
    ...(data?.ledger?.assets ?? []).filter(asset => asset.error).map(asset => ({ key: 'asset-' + asset.id, role: 'status' as const, text: asset.project + '：' + asset.error, tone: 'warn' as const })),
  ];
  const example = data?.ledger?.dataKind === 'example'
    ? <div className="notice import-notice"><Info size={15} aria-hidden="true" /><div><strong>当前为示例数据，工作台尚未导入原表</strong><p>这里的资产和金额是演示内容。在工作台导入原表后重新运行导入命令，才会显示真实持仓和历史。</p></div></div> : null;
  return <div className="asset-desk">
    <div className="ledger-head">
      <nav className="ledger-tabs" aria-label="资产账本">{VIEWS.map(({ id, label }) => <button type="button" key={id} aria-current={view === id ? 'page' : undefined} onClick={() => navigate(id)}>{label}{counts[id] ? <span className="count-chip">{counts[id]}</span> : null}</button>)}</nav>
      <div className="ledger-head-meta">
        <span className="workspace-date">导入于 {fullStamp(info.importedAt)} · 北京时间</span>
        <button type="button" className="button primary" disabled={writer.busy} onClick={() => void writer.sync(true)}><RefreshCw size={15} className={writer.syncing ? 'loading-spin' : undefined} aria-hidden="true" />{writer.syncing ? '正在更新' : '刷新资产'}</button>
      </div>
    </div>
    {alerts.length ? <div className="ledger-strip"><span className="strip-title"><TriangleAlert size={14} aria-hidden="true" />{alerts.length} 项提醒</span>{alerts.map(item => <span key={item.key} className={'strip-item ' + item.tone} role={item.role}>{item.text}</span>)}</div> : null}
    <div className="page">
      <div className="notice info" role="status"><Info size={15} aria-hidden="true" /><div>账本于 {fullStamp(info.importedAt)} 从工作台导入（工作台用户 {info.source?.owner ?? '—'}，资产 {info.assets} 行、日快照 {info.snapshots.count} 份）。页面打开时每 60 秒同步交易所余额、行情单价与人民币汇率；编辑、出金与资金流登记保存在本服务的账本。重新导入会整体替换本服务的账本，本页做过的修改一并被覆盖。</div></div>
      {writer.saved ? <p className="notice saved-notice" role="status"><Check size={15} aria-hidden="true" />{writer.saved}</p> : null}
      {!data?.ledger || !data.summary ? (failed(ledger.status) ? <StatePanel kind="error" title="读取资产明细失败" detail={ledger.error?.message ?? '网络离线'} /> : <StatePanel kind="loading" title="加载中…" />)
        : <>
          {view !== 'overview' ? example : null}
          {view === 'overview' ? <Overview data={data as LoadedLedger} history={history.data?.imported ? history.data : null} historyError={failed(history.status) ? history.error?.message ?? '网络离线' : null} version={version} example={example} writer={writer} onHistory={() => navigate('history')} onWithdrawals={() => navigate('withdrawals')} onConnect={connect} onExpired={onExpired} />
            : view === 'history' ? <History history={history.data?.imported ? history.data : null} error={failed(history.status) ? history.error?.message ?? '网络离线' : null} />
            : view === 'withdrawals' ? <Withdrawals view={withdrawals.data?.imported ? withdrawals.data : null} today={data.today} error={failed(withdrawals.status) ? withdrawals.error?.message ?? '网络离线' : null} writer={writer} />
            : <ConnectionsView connections={data.ledger.connections} accounts={data.ledger.asterAccounts} now={Date.now()} writer={writer} opened={connecting} onOpen={setConnecting} />}
          <footer className="page-footer">{VIEW_DESCRIPTIONS[view]} · {data.ledger.dataKind === 'example' ? '示例账本 · 尚未导入原表' : '源自《资产统计.xlsx》'} · 起始持仓 {data.ledger.baselineDate} · 自 {data.ledger.startedAt} 开始更新</footer>
        </>}
    </div>
  </div>;
}

type LoadedLedger = AssetLedgerView & { ledger: NonNullable<AssetLedgerView['ledger']>; summary: NonNullable<AssetLedgerView['summary']> };

const SAVED_MS = 4_000;
const isLedgerView = (value: unknown): value is AssetLedgerView => !!value && typeof value === 'object' && 'imported' in value && 'ledger' in value;

type PageWriter = Writer & { saved: string; syncing: boolean; syncError: string; sync: (manual: boolean) => Promise<void>; stopSync: () => void };

function useWriter({ onExpired, onLedger, onWritten }: { onExpired: () => void; onLedger: (view: AssetLedgerView) => void; onWritten: (committed: boolean) => void }): PageWriter {
  // The error belongs to the form whose path failed, so another open form does not show it too.
  const [busy, setBusy] = useState(false), [error, setError] = useState<{ path: string; text: string } | null>(null), [saved, setSaved] = useState(''), [writes, setWrites] = useState(0);
  const [syncing, setSyncing] = useState(false), [syncError, setSyncError] = useState('');
  const running = useRef(false), mounted = useRef(true), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), syncRequest = useRef<AbortController | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; clearTimeout(timer.current); syncRequest.current?.abort(); }; }, []);
  const flash = useCallback((text: string) => { setSaved(text); clearTimeout(timer.current); timer.current = setTimeout(() => { if (mounted.current) setSaved(''); }, SAVED_MS); }, []);
  const clear = useCallback(() => setError(null), []);
  const errorOf = useCallback((...paths: string[]) => error && paths.includes(error.path) ? error.text : '', [error]);
  const run = useCallback(async <T,>(path: string, body: unknown, done: (result: T) => void) => {
    if (running.current) return;
    running.current = true; setBusy(true); setError(null); setSaved('');
    try {
      const result = await api<T>(path, { body, timeoutMs: writeTimeout(path) });
      if (!mounted.current) return;
      // A success without a readable body (api.ts answers {}) went through; the ledger is read again instead.
      const committed = isLedgerView(result);
      if (committed) onLedger(result);
      onWritten(committed); setWrites(count => count + 1); done(result);
      flash('已保存');
    } catch (reason) {
      if (!mounted.current) return;
      if (reason instanceof ApiError && reason.status === 401) { onExpired(); return; }
      setError({ path, text: reason instanceof Error ? reason.message : '保存失败，输入已保留' });
      // A conflict (another write, a new import) or an unknown outcome: show what the ledger holds now.
      if (!(reason instanceof ApiError) || reason.status === 409 || reason.status >= 500) { onWritten(false); setWrites(count => count + 1); }
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [onExpired, onLedger, onWritten, flash]);
  /**
   * The workbench's refresh(): one sync of every connection, prices and the rate, taking the writer's turn so no form
   * writes meanwhile. An automatic one skips while a write runs and is dropped when the page is hidden; its 409 (the
   * ledger busy with another sync or an import) waits for the next minute instead of showing an error.
   */
  const sync = useCallback(async (manual: boolean) => {
    if (running.current) return;
    running.current = true; setBusy(true); setSyncing(true);
    if (manual) { setError(null); setSaved(''); }
    const request = new AbortController(); syncRequest.current = request;
    try {
      const result = await api<unknown>(SYNC_PATH, { body: {}, timeoutMs: SYNC_TIMEOUT_MS, signal: request.signal });
      if (!mounted.current || request.signal.aborted) return;
      const committed = isLedgerView(result);
      if (committed) onLedger(result);
      setSyncError(''); onWritten(committed); setWrites(count => count + 1);
      if (manual) flash('已完成刷新，更新状态见资产明细');
    } catch (reason) {
      if (!mounted.current || request.signal.aborted) return;
      if (reason instanceof ApiError && reason.status === 401) { onExpired(); return; }
      if (manual || !(reason instanceof ApiError && reason.status === 409)) setSyncError(reason instanceof Error ? reason.message : '更新失败');
      onWritten(false);
    } finally {
      if (syncRequest.current === request) syncRequest.current = null;
      running.current = false;
      if (mounted.current) { setBusy(false); setSyncing(false); }
    }
  }, [onExpired, onLedger, onWritten, flash]);
  const stopSync = useCallback(() => syncRequest.current?.abort(), []);
  return { busy, errorOf, writes, saved, clear, run, syncing, syncError, sync, stopSync };
}

/** The workbench's 编辑 dialog as a panel: quantity, price (fixed for market rows) and the value it gives. */
function EditPanel({ asset, writer, onClose }: { asset: Asset; writer: Writer; onClose: () => void }) {
  const [quantity, setQuantity] = useState(asset.quantity === null ? '' : String(asset.quantity));
  const [price, setPrice] = useState(asset.price === null ? '' : String(asset.price));
  const panel = useRef<HTMLElement | null>(null);
  useEffect(() => { panel.current?.scrollIntoView({ block: 'nearest' }); }, []);
  const market = asset.mode === 'market';
  return <section ref={panel} className="panel edit-panel" aria-label={'编辑 ' + asset.project}>
    <h2>编辑 {asset.project}</h2>
    <p className="help">{asset.kind} · {asset.project.trim() === '出金' ? '仅编辑原表出金；新增出金由出金记录自动叠加，请在出金记录中修改。' : market ? '单价按行情更新，持仓数量手动维护。' : '修改后重新计算估值，并保存当日快照。'}</p>
    <form className="form-grid" onSubmit={event => { event.preventDefault(); void writer.run('/api/asset/assets/edit', { id: asset.id, quantity: Number(quantity), price: market ? asset.price : price === '' ? null : Number(price) }, onClose); }}>
      <label>数量<input type="number" min="0" step="any" required value={quantity} onChange={event => setQuantity(event.target.value)} /></label>
      <label>单价 / USD<input type="number" min="0" step="any" value={price} disabled={market} onChange={event => setPrice(event.target.value)} /></label>
      <p className="help">估值：{quantity === '' ? '待填写数量' : price === '' ? '待填写单价' : '$ ' + money(Number(quantity) * Number(price))}</p>
      {writer.errorOf('/api/asset/assets/edit') ? <p className="error-text" role="alert">{writer.errorOf('/api/asset/assets/edit')}</p> : null}
      <div className="form-actions"><button type="button" className="button" disabled={writer.busy} onClick={onClose}>取消</button><button className="button primary" disabled={writer.busy}>{writer.busy ? '正在保存' : '保存修改'}</button></div>
    </form>
  </section>;
}

/** The workbench's 人民币换算汇率 dialog as a panel: the value set here holds until the next sync fetches a rate. */
function FxPanel({ ledger, writer, source, onClose }: { ledger: LoadedLedger['ledger']; writer: Writer; source: string; onClose: () => void }) {
  const [fx, setFx] = useState(String(ledger.fx));
  const panel = useRef<HTMLElement | null>(null);
  useEffect(() => { panel.current?.scrollIntoView({ block: 'nearest' }); }, []);
  return <section ref={panel} className="panel edit-panel" aria-label="人民币换算汇率">
    <h2>人民币换算汇率</h2>
    <p className="help">每 60 秒随资产自动更新。可临时设置备用值，下一次自动获取成功后会覆盖；历史快照保留当时汇率。</p>
    <p className="help">当前来源：{source}<br />{ledger.fxStatus.rateDate ? '报价日期：' + ledger.fxStatus.rateDate : '获取时间：' + stamp(ledger.fxStatus.fetchedAt)}<br />来源未提供逐笔报价时间时，展示获取时间。</p>
    <form className="form-grid" onSubmit={event => { event.preventDefault(); void writer.run('/api/asset/fx', { fx: Number(fx) }, onClose); }}>
      <label>1 USD 折合 CNY<input type="number" min="0.001" max="1000" step="any" required value={fx} onChange={event => setFx(event.target.value)} /></label>
      {writer.errorOf('/api/asset/fx') ? <p className="error-text" role="alert">{writer.errorOf('/api/asset/fx')}</p> : null}
      <div className="form-actions"><button type="button" className="button" disabled={writer.busy} onClick={onClose}>取消</button><button className="button primary" disabled={writer.busy}>{writer.busy ? '正在保存' : '临时使用此汇率'}</button></div>
    </form>
  </section>;
}

function Overview({ data, history, historyError, version, example, writer, onHistory, onWithdrawals, onConnect, onExpired }: { data: LoadedLedger; history: AssetHistoryView | null; historyError: string | null; version: string; example: ReactNode; writer: Writer; onHistory: () => void; onWithdrawals: () => void; onConnect: (exchange: CardExchange | 'aster') => void; onExpired: () => void }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [editing, setEditing] = useState<string | null>(null), [fxOpen, setFxOpen] = useState(false);
  // The original row: the table shows recorded withdrawals merged in, the edit changes what the ledger stores.
  const edited = editing ? data.ledger.assets.find(row => row.id === editing) ?? null : null;
  const edit = (asset: Asset) => {
    if (!data.ledger.assets.some(row => row.id === asset.id)) { onWithdrawals(); return; }
    writer.clear(); setFxOpen(false); setEditing(asset.id);
  };
  const { ledger, summary } = data, { measures, valuation } = summary;
  const now = Date.now(), fx = fxView(ledger.fxStatus, now);
  const pending = Object.values(ledger.connections).filter(item => !item.configured).length;
  const rows = data.rows.filter(asset => filter === 'all' || (filter === 'manual' ? asset.mode === 'manual' : asset.mode !== 'manual'));
  return <>
    <section className="panel ledger-kpis" aria-label="资产汇总">
      <div className="kpi hero"><div className="kpi-label">表内总额 <span>USD · 含累计出金{valuation.partial ? ' · 部分估值' : ''}</span></div><div className="kpi-value"><span className="cur">$</span>{money(measures.adjusted)}</div><p className="kpi-sub">= 剔除出金影响（实际持有资产 + 累计出金）· 折合人民币 ¥ {money(measures.adjusted * ledger.fx)}</p></div>
      <div className="kpi"><div className="kpi-label">实际持有资产 <span>USD{valuation.partial ? ' · 部分估值' : ''}</span></div><div className="kpi-value"><span className="cur">$</span>{money(measures.held)}</div><p className="kpi-sub">表内总额减去累计出金</p></div>
      <div className="kpi"><div className="kpi-label">累计出金 <span>USD{summary.withdrawals.partial ? ' · 部分金额' : ''}</span></div><div className="kpi-value"><span className="cur">$</span>{money(measures.withdrawn)}</div><p className="kpi-sub"><button type="button" className="text-button" onClick={onWithdrawals}>管理出金记录</button></p></div>
      <div className="kpi"><div className="kpi-label">交易所资产{summary.exchanges.partial ? <span>部分估值</span> : null}</div><div className="kpi-value"><span className="cur">$</span>{money(summary.exchanges.total)}</div><p className="kpi-sub">折合人民币 ¥ {money(summary.exchanges.total * ledger.fx)} · <span className={pending ? 'warn-text' : 'good-text'}>{pending ? pending + ' 个账户待连接' : '账户已连接'}</span></p></div>
      <div className="kpi"><div className="kpi-label">积分预估价值{summary.points.partial ? <span>部分估值</span> : null}</div><div className="kpi-value"><span className="cur">$</span>{money(summary.points.total)}</div><p className="kpi-sub">折合人民币 ¥ {money(summary.points.total * ledger.fx)} · 沿用表格估值，可手动编辑</p></div>
      <div className="kpi"><div className="kpi-label">USD / CNY <button type="button" className="kpi-edit" aria-label="人民币汇率详情与备用设置" aria-expanded={fxOpen} disabled={writer.busy} onClick={() => { writer.clear(); setEditing(null); setFxOpen(true); }}><Pencil size={11} aria-hidden="true" /></button></div><div className="kpi-value">{money(ledger.fx, 4)}{fx.stale ? <span className="old" title="汇率未在 5 分钟内更新">旧</span> : null}</div><p className="kpi-sub"><span className={fx.stale ? 'warn-text' : 'good-text'}>1 USD = {money(ledger.fx, 4)} CNY · {fx.state}</span><br />{fx.source} · {fx.when}</p></div>
    </section>
    {fxOpen ? <FxPanel ledger={ledger} writer={writer} source={fx.source} onClose={() => setFxOpen(false)} /> : null}
    {example}
    <div className="overview-grid">
      <div className="overview-main">
        {history ? <AssetTrend history={history} version={version + '#' + writer.writes} writer={writer} onHistory={onHistory} onExpired={onExpired} />
          : historyError ? <StatePanel kind="error" title="读取资产变化失败" detail={historyError} /> : <StatePanel kind="loading" title="读取资产变化…" />}
        <section className="panel holdings">
          <div className="holdings-heading"><h2>资产明细 <span className="count-chip">{rows.length}</span></h2>
            <div data-slot="tabs-list" role="group" aria-label="筛选资产">{FILTERS.map(item => <button type="button" key={item.id} data-slot="tabs-trigger" data-state={filter === item.id ? 'active' : 'inactive'} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label}</button>)}</div>
            <span className="panel-h-right">单价、估值单位 USD · 北京时间</span></div>
          {edited ? <EditPanel key={edited.id} asset={edited} writer={writer} onClose={() => setEditing(null)} /> : null}
          <AssetTable assets={rows} current now={now} data={data} busy={writer.busy} onEdit={edit} />
          <p className="panel-foot">交易所行显示账户估值口径，不重复累加保证金或持仓名义价值；点查看可见分账户明细 · 缺失显示 —，不计 0</p>
        </section>
      </div>
      <div className="overview-side">
        <section className="panel sync-panel"><div className="panel-h"><h2>数据连接</h2><ShieldCheck size={16} aria-hidden="true" /></div>
          {SIDE_EXCHANGES.map(name => {
            const connection = ledger.connections[name];
            return <button type="button" className="connection-row" key={name} onClick={() => onConnect(name)}><div className={'exchange-mark ' + name} aria-hidden="true">{EXCHANGE_NAMES[name][0]}</div>
              <div><strong>{EXCHANGE_NAMES[name]}</strong><small>{connection.configured ? '已连接 · ' + stamp(connection.lastSync) : pendingText(name)}{connection.error ? <span className="warn-text"> · 同步失败</span> : null}</small></div>
              <ChevronRight size={16} aria-hidden="true" /></button>;
          })}
          <div className="connection-row"><div className="exchange-mark virtual" aria-hidden="true">V</div><div><strong>Virtual</strong><small>实时单价 · 数量手动</small></div></div>
          <p className="panel-foot">页面打开时每 60 秒刷新 · USD/CNY 随刷新自动更新 · {fx.source}</p>
        </section>
      </div>
    </div>
  </>;
}

/** The workbench's renderTable: `current` is the live ledger (marks, status, detail); a recorded period shows the bare rows. */
function AssetTable({ assets, current, now, data, busy = false, onEdit }: { assets: Asset[]; current: boolean; now: number; data?: LoadedLedger; busy?: boolean; onEdit?: (asset: Asset) => void }) {
  const [detail, setDetail] = useState<string | null>(null);
  const columns = current ? 7 : 5;
  return <div data-slot="table-container"><table data-slot="table">
    <thead data-slot="table-header"><tr data-slot="table-row"><th data-slot="table-head">项目 / 资产</th><th data-slot="table-head">类型</th><th data-slot="table-head" className="numeric">数量</th><th data-slot="table-head" className="numeric">单价 / USD</th><th data-slot="table-head" className="numeric">估值 / USD</th>{current ? <><th data-slot="table-head">数据来源 / 更新时间</th><th data-slot="table-head" className="numeric">操作</th></> : null}</tr></thead>
    <tbody data-slot="table-body">{assets.map(a => {
      const label = badge(a, now), stale = current && staleRow(a, label), open = detail === a.id && !!a.details;
      const original = data?.ledger.assets.find(row => row.id === a.id);
      return <Fragment key={a.id}>
        <tr data-slot="table-row" className={stale ? 'stale-row' : undefined}>
          <td data-slot="table-cell"><div className="asset-cell">{current && isExchangeMode(a.mode) ? <span className={'exchange-mark ' + a.mode} aria-hidden="true">{EXCHANGE_NAMES[a.mode][0]}</span> : null}<div><strong className="asset-name">{a.project}</strong>
            {current && a.mode === 'aster' && data && data.ledger.asterAccounts.length > 0 ? <small className="ticker">{data.ledger.asterAccounts.length} 个账号</small> : null}
            {current && a.project.trim() === '出金' && data && data.summary.measures.recorded > 0 ? <small className="ticker">{a.id === 'recorded-withdrawals' ? '新增出金记录' : original?.value !== a.value ? '含新增出金记录' : ''}</small> : null}
            {a.project === 'virtual' ? <small className="ticker">VIRTUAL</small> : null}</div></div></td>
          <td data-slot="table-cell"><span className="kind">{a.kind}</span></td>
          <td data-slot="table-cell" className="numeric">{quantityText(a, current)}</td>
          <td data-slot="table-cell" className="numeric">{priceText(a, current)}</td>
          <td data-slot="table-cell" className="numeric asset-value">{a.value === null ? '—' : money(a.value)}</td>
          {current ? <>
            <td data-slot="table-cell"><span title={a.error} className={'status ' + statusTone(a, label)}>{label}</span><small className="ticker">{stamp(a.updatedAt)}</small></td>
            <td data-slot="table-cell" className="numeric">{isExchangeMode(a.mode) && a.details ? <button type="button" className="icon-button" aria-expanded={open} aria-label={(open ? '收起 ' : '查看 ') + a.project + ' 资产'} onClick={() => setDetail(open ? null : a.id)}>{open ? <X size={15} /> : <Eye size={15} />}</button>
              : isExchangeMode(a.mode) || !onEdit ? '—'
              : <button type="button" className="icon-button" disabled={busy} aria-label={a.id === 'recorded-withdrawals' ? '管理出金记录' : '编辑 ' + a.project + ' ' + a.kind} onClick={() => onEdit(a)}><Pencil size={14} /></button>}</td>
          </> : null}
        </tr>
        {open ? <tr data-slot="table-row" className="detail-row"><td data-slot="table-cell" colSpan={columns}><AccountDetail asset={a} /></td></tr> : null}
      </Fragment>;
    })}</tbody>
  </table></div>;
}

function AccountDetail({ asset }: { asset: Asset }) {
  const [account, amount] = detailHeads(asset.mode);
  return <section className="account-detail" aria-label={asset.project + ' ' + detailTitle(asset.mode)}>
    <h3>{asset.project} {detailTitle(asset.mode)}</h3><p className="help">{detailSubtitle(asset)}</p>
    <div data-slot="table-container"><table data-slot="table">
      <thead data-slot="table-header"><tr data-slot="table-row"><th data-slot="table-head">{account}</th><th data-slot="table-head" className="numeric">{amount}</th><th data-slot="table-head" className="numeric">美元价值</th></tr></thead>
      <tbody data-slot="table-body">{asset.details!.map((balance, index) => { const line = detailLine(asset.mode, balance); return <tr data-slot="table-row" key={index}>
        <td data-slot="table-cell">{balance.account}{line.coin !== null ? <small className="ticker">{line.coin}</small> : null}</td>
        <td data-slot="table-cell" className="numeric">{line.quantity}</td><td data-slot="table-cell" className="numeric">{line.value}</td></tr>; })}</tbody>
    </table></div>
    <p className="help">{detailNote(asset.mode)}</p>
  </section>;
}

function History({ history, error }: { history: AssetHistoryView | null; error: string | null }) {
  const [period, setPeriod] = useState<HistoryRow | null>(null);
  const [rows, setRows] = useState<{ id: string; rows: Asset[] } | { id: string; error: string } | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const open = (p: HistoryRow) => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setPeriod(p); setRows(null);
    api<AssetPeriodView>('/api/asset/period?id=' + encodeURIComponent(p.id), { signal: controller.signal, timeoutMs: ASSET_READ_TIMEOUT_MS })
      .then(data => { if (!controller.signal.aborted) setRows({ id: p.id, rows: data.rows }); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setRows({ id: p.id, error: reason instanceof Error ? reason.message : '无法读取历史明细' }); });
  };
  const close = () => { request.current?.abort(); setPeriod(null); setRows(null); };
  if (!history) return error ? <StatePanel kind="error" title="读取历史记录失败" detail={error} /> : <StatePanel kind="loading" title="加载中…" />;
  const loaded = rows && period && rows.id === period.id ? rows : null;
  return <>
    <div className="notice info">原表未来预填和导入前示例不计入曲线。同日多份记录在此保留；曲线优先采用日快照，其次采用最后一份原表记录。此处“原始表内总额”保留历史原值；总览表内总额与当前明细已加入新增出金。</div>
    {period ? <section className="panel holdings period-detail" aria-label={period.date + ' 资产快照'}>
      <div className="holdings-heading"><h2>{period.date} 资产快照</h2><span className="help">{periodKind(period)} · 总额 $ {money(period.total)}{period.missingValues ? ' · 部分估值，仅含已知金额' : ''}</span>
        <button type="button" className="button" onClick={close}><X size={15} aria-hidden="true" />关闭</button></div>
      {period.difference !== 0 ? <p className="notice">行估值之和与原合计相差 $ {money(period.difference)}。保留原合计，未修改历史。</p> : null}
      {!loaded ? <p className="help period-state" role="status">读取快照…</p> : 'error' in loaded ? <p className="error-text period-state" role="alert">{loaded.error}</p>
        : loaded.rows.length ? <AssetTable assets={loaded.rows} current={false} now={0} /> : <p className="help period-state">这份记录没有保存资产明细。</p>}
    </section> : null}
    <section className="panel holdings">
      {history.periods.length ? <div data-slot="table-container"><table data-slot="table">
        <thead data-slot="table-header"><tr data-slot="table-row"><th data-slot="table-head">日期（北京时间）</th><th data-slot="table-head">来源</th><th data-slot="table-head" className="numeric">原始表内总额 / USD</th><th data-slot="table-head" className="numeric">实际持有 / USD</th><th data-slot="table-head" className="numeric">累计出金 / USD</th><th data-slot="table-head" className="numeric">剔除出金影响 / USD</th><th data-slot="table-head" className="numeric">汇率</th><th data-slot="table-head" className="numeric">原总额 / CNY</th><th data-slot="table-head">核对 / 明细</th></tr></thead>
        <tbody data-slot="table-body">{history.periods.map(p => <tr data-slot="table-row" key={p.id}>
          <td data-slot="table-cell">{p.date}</td>
          <td data-slot="table-cell"><span className={'status ' + (p.future || p.partial ? 'amber' : '')}>{periodSource(p)}</span></td>
          <td data-slot="table-cell" className="numeric">{money(p.total)}</td>
          <td data-slot="table-cell" className="numeric">{p.included ? money(p.held) : '—'}</td>
          <td data-slot="table-cell" className="numeric">{p.included ? money(p.withdrawn) : '—'}</td>
          <td data-slot="table-cell" className="numeric">{p.included ? money(p.adjusted) : '—'}</td>
          <td data-slot="table-cell" className="numeric" title={periodFxTitle(p)}>{p.fx}{p.fxStatus?.error ? <small className="ticker">沿用旧汇率</small> : null}</td>
          <td data-slot="table-cell" className="numeric">{money(p.cny)}</td>
          <td data-slot="table-cell"><button type="button" className="text-button" aria-pressed={period?.id === p.id} onClick={() => open(p)}>{p.difference ? '合计差异 $ ' + money(p.difference) : '查看明细'}</button></td>
        </tr>)}</tbody>
      </table></div> : <div className="empty-state">导入的账本没有历史记录。</div>}
      <p className="panel-foot">日快照在编辑资产、汇率或出金时保存（导入前由工作台在刷新或编辑时保存）；页面关闭期间不补造记录。部分估值快照仅汇总已知金额。入金未剔除，资产变化不等于投资收益。交易所同步接入前，交易所行沿用导入时的估值。</p>
    </section>
  </>;
}

type WithdrawalDraft = { id: string; editing: boolean; date: string; amount: string; note: string };

function Withdrawals({ view, today, error, writer }: { view: AssetWithdrawalsView | null; today: string; error: string | null; writer: Writer }) {
  const [draft, setDraft] = useState<WithdrawalDraft | null>(null), [removing, setRemoving] = useState<Withdrawal | null>(null);
  if (!view) return error ? <StatePanel kind="error" title="读取出金记录失败" detail={error} /> : <StatePanel kind="loading" title="加载中…" />;
  // The id is made when the form opens and kept through retries, so a save whose answer was lost is not recorded twice.
  const open = (row?: Withdrawal) => { writer.clear(); setRemoving(null); setDraft({ id: row?.id ?? newRequestId(), editing: !!row, date: row?.date ?? today, amount: row ? String(row.amount) : '', note: row?.note ?? '' }); };
  const rows = [...view.withdrawals].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  return <>
    <div className="notice info">原表“出金”已作为累计出金计入，当前{view.embedded.partial ? '已知金额（部分）' : '金额'}为 $ {zhMoney(view.embedded.total)}。这里只登记原表基准日 {view.baselineDate ?? '—'} 之后尚未计入的新增出金；同日新增也可登记。新增记录会自动加入总览表内总额及资产明细的出金数量和估值，请勿再手动加到原表“出金”行。</div>
    {draft ? <section className="panel edit-panel" aria-label={draft.editing ? '修改出金记录' : '登记出金'}>
      <h2>{draft.editing ? '修改出金记录' : '登记出金'}</h2><p className="help">仅调整统计口径。请先确认当前资产已反映这笔出金。</p>
      <form className="form-grid" onSubmit={event => { event.preventDefault(); void writer.run(draft.editing ? '/api/asset/withdrawals/edit' : '/api/asset/withdrawals/add', { id: draft.id, date: draft.date, amount: Number(draft.amount), note: draft.note }, () => setDraft(null)); }}>
        <label>出金日期（北京时间）<input type="date" required min={view.baselineDate ?? undefined} max={today} value={draft.date} onChange={event => setDraft({ ...draft, date: event.target.value })} /></label>
        <label>出金金额 / USD<input type="number" required min="0.01" max="1000000000000" step="0.01" inputMode="decimal" value={draft.amount} onChange={event => setDraft({ ...draft, amount: event.target.value })} /></label>
        <label>备注（可选）<input maxLength={200} placeholder="例如：转至个人银行账户" value={draft.note} onChange={event => setDraft({ ...draft, note: event.target.value })} /></label>
        {writer.errorOf('/api/asset/withdrawals/add', '/api/asset/withdrawals/edit') ? <p className="error-text" role="alert">{writer.errorOf('/api/asset/withdrawals/add', '/api/asset/withdrawals/edit')}</p> : null}
        <div className="form-actions"><button type="button" className="button" disabled={writer.busy} onClick={() => setDraft(null)}>取消</button><button className="button primary" disabled={writer.busy}>{writer.busy ? '正在保存' : '保存出金'}</button></div>
      </form>
    </section> : null}
    {removing ? <section className="panel edit-panel" aria-label="删除出金记录">
      <h2>删除出金记录</h2><p className="help">删除 {removing.date} 的 $ {zhMoney(removing.amount)} 出金后，相关调整曲线会重新计算，账户余额保持不变。</p>
      {writer.errorOf('/api/asset/withdrawals/delete') ? <p className="error-text" role="alert">{writer.errorOf('/api/asset/withdrawals/delete')}</p> : null}
      <div className="form-actions"><button type="button" className="button" disabled={writer.busy} onClick={() => setRemoving(null)}>取消</button><button type="button" className="button primary" disabled={writer.busy} onClick={() => void writer.run('/api/asset/withdrawals/delete', { id: removing.id }, () => setRemoving(null))}>{writer.busy ? '正在删除' : '确认删除'}</button></div>
    </section> : null}
    <section className="panel holdings">
      <div className="holdings-heading"><h2>新增出金记录 <span className="count-chip">{rows.length}</span></h2><p className="help">金额使用出金时的美元价值；账户间内部转账不记出金。</p><button type="button" className="button primary" disabled={writer.busy} onClick={() => open()}><Plus size={15} aria-hidden="true" />登记出金</button></div>
      {rows.length ? <div data-slot="table-container"><table data-slot="table">
        <thead data-slot="table-header"><tr data-slot="table-row"><th data-slot="table-head">日期（北京时间）</th><th data-slot="table-head" className="numeric">金额 / USD</th><th data-slot="table-head">备注</th><th data-slot="table-head">操作</th></tr></thead>
        <tbody data-slot="table-body">{rows.map(row => <tr data-slot="table-row" key={row.id}><td data-slot="table-cell">{row.date}</td><td data-slot="table-cell" className="numeric">{zhMoney(row.amount)}</td><td data-slot="table-cell" className="withdrawal-note">{row.note || '—'}</td>
          <td data-slot="table-cell"><div className="row-actions"><button type="button" className="icon-button" disabled={writer.busy} aria-label={'编辑 ' + row.date + ' 出金 ' + row.amount} onClick={() => open(row)}><Pencil size={16} /></button><button type="button" className="icon-button" disabled={writer.busy} aria-label={'删除 ' + row.date + ' 出金 ' + row.amount} onClick={() => { writer.clear(); setDraft(null); setRemoving(row); }}><Trash2 size={16} /></button></div></td></tr>)}</tbody>
      </table></div> : <div className="empty-state">尚未登记新增出金。原表中的累计出金已自动纳入统计。</div>}
      <p className="panel-foot">登记不会改动持仓或再次扣减账户余额。交易所余额在同步接入前沿用导入时的值；手动资产需先更新实际剩余金额。补录、修改或删除出金后，对应日期起的调整曲线会重新计算，原始历史总额保持不变。</p>
    </section>
  </>;
}
