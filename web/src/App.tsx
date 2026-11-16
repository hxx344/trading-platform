import { Activity, ArrowLeftRight, Cpu, ChevronRight, Gauge, Menu, RefreshCw, ScrollText, Server, Settings2, ShieldCheck, Sigma, Wallet, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { OIL_READ_TIMEOUT_MS, OIL_STATE_PATH, OilPage } from './OilPage.tsx';
import { HynixPage } from './HynixPage.tsx';
import { ASSET_READ_TIMEOUT_MS, ASSET_STATE_PATH, AssetPage } from './AssetPage.tsx';
import { LogsPage } from './LogsPage.tsx';
import { MONITOR_READ_TIMEOUT_MS, MONITOR_STATE_PATH, MonitorPage, parseMonitorState, type MonitorState } from './MonitorPage.tsx';
import { OPTIONS_READ_TIMEOUT_MS, OPTIONS_STATE_PATH, OptionsPage } from './OptionsPage.tsx';
import type { OptionsState } from './options-types.ts';
import { PairsWorkspace } from './PairsWorkspace.tsx';
import { useRoute } from './route.ts';
import { SettingsPage } from './SettingsPage.tsx';
import { StatusPage } from './StatusPage.tsx';
import { Callout, StatePanel } from './StateViews.tsx';
import { clock } from './labels.ts';
import { useLiveResource } from './use-live-resource.ts';
import { ApiError } from './api.ts';
import type { ServiceState } from './types.ts';
import type { OilState } from './oil-types.ts';
import type { AssetState } from '../../src/asset/views.ts';
import { CrossexPage } from './crossex/CrossexPage.tsx';
import { CROSSEX_READ_TIMEOUT_MS, CROSSEX_STATE_PATH } from './crossex/crossex-api.ts';
import { breadcrumbOf, entryOf, navEntries, workspaceGroups, type NavEntry } from './workspace-nav.ts';

// The shell follows the workbench's main interface (src/App.tsx, 31242e0): a side navigation grouped by the workspaces
// of the unified platform plan (workspace-nav.ts), a topbar with the breadcrumb, and on a phone a drawer behind a menu
// button. The content keeps the workbench's ASTER desk (modules/aster/dashboard/app/page.tsx, b2fae14): the page heading
// with the connection state, then the page. The ASTER pages sit in .aster-module, which carries the workbench's element
// styles; the oil, options, monitor, asset and CrossEx pages keep their own.

const REFRESH_MS = 2_000;
const READ_TIMEOUT_MS = 10_000;

function limitsText(state: ServiceState): string | null {
  const limits = state.notionalLimits;
  if (!limits) return null;
  return `名义金额上限 单笔 ${limits.perJob} USDT，${'openPer24h' in limits ? `24 小时开仓 ${limits.openUsed} / ${limits.openPer24h}` : `累计开仓 ${limits.openUsed} / ${limits.totalOpen}`} USDT`;
}

const OIL_CHECK_MS = 60_000;
const ASSET_CHECK_MS = 60_000;
/** Shown on every service; the oil and monitor entries only where their state path answers (a service without that
 * module returns 404 there), the asset entry unless /api/asset/state answers 404 (a ledger that cannot be read keeps
 * the entry, and the page says why), the CrossEx and options entries where their state path answers or answers 503
 * (configured but not started, retrying: the page says why). */
const ALWAYS: readonly NavEntry[] = ['pairs', 'status', 'logs', 'settings'];
const ICONS: Record<NavEntry, LucideIcon> = { asset: Wallet, monitor: Activity, oil: ArrowLeftRight, hynix: Cpu, crossex: Gauge, pairs: ShieldCheck, options: Sigma, status: Server, logs: ScrollText, settings: Settings2 };
/** Below this width the side navigation is a drawer (the workbench's 760px breakpoint, shell.css). */
const DRAWER_QUERY = '(max-width: 760px)';

function Brand() { return <div className="brand"><span className="brand-mark" aria-hidden="true"><i /><i /><i /><i /></span><span>统一交易平台<small>交易服务</small></span></div>; }

export function App() {
  const route = useRoute();
  const [expired, setExpired] = useState(false);
  const onExpired = useCallback(() => setExpired(true), []);
  const live = useLiveResource<ServiceState>('/api/state', { intervalMs: REFRESH_MS, timeoutMs: READ_TIMEOUT_MS, onExpired });
  const { data: state, status, error, receivedAt, refresh } = live;
  // The oil page reads the same path faster while it is open; here it only decides whether the tab shows. SK hynix rides
  // on oil's execution accounts (its state answers exactly where oil's does), so the same read decides its tab too.
  const oil = useLiveResource<OilState>(OIL_STATE_PATH, { intervalMs: OIL_CHECK_MS, timeoutMs: OIL_READ_TIMEOUT_MS, onExpired });
  const options = useLiveResource<OptionsState>(OPTIONS_STATE_PATH, { intervalMs: OIL_CHECK_MS, timeoutMs: OPTIONS_READ_TIMEOUT_MS, onExpired });
  const monitor = useLiveResource<MonitorState>(MONITOR_STATE_PATH, { intervalMs: OIL_CHECK_MS, timeoutMs: MONITOR_READ_TIMEOUT_MS, parse: parseMonitorState, onExpired });
  // The asset page reads the same path at the same pace and timeout (the shared read keeps the first subscriber's).
  const asset = useLiveResource<AssetState>(ASSET_STATE_PATH, { intervalMs: ASSET_CHECK_MS, timeoutMs: ASSET_READ_TIMEOUT_MS, onExpired });
  // The CrossEx page reads its state on its own (tab-specific paths, paused around writes); this only decides whether the entry
  // shows, so it asks for the light view without the opportunity list.
  const crossex = useLiveResource<unknown>(`${CROSSEX_STATE_PATH}?opportunities=0`, { intervalMs: OIL_CHECK_MS, timeoutMs: CROSSEX_READ_TIMEOUT_MS, onExpired });
  const available = new Set<NavEntry>([...ALWAYS, ...(oil.data !== null ? ['oil' as const, 'hynix' as const] : []), ...(options.data !== null || (options.error instanceof ApiError && options.error.status === 503) ? ['options' as const] : []), ...(monitor.data !== null ? ['monitor' as const] : []), ...(asset.data !== null || (asset.error instanceof ApiError && asset.error.status === 500) ? ['asset' as const] : []),
    ...(crossex.data !== null || (crossex.error instanceof ApiError && crossex.error.status === 503) ? ['crossex' as const] : [])]);
  const current = entryOf(route), crumb = breadcrumbOf(route);
  // The phone drawer, as in the workbench: focus moves into it, Tab cycles inside, Escape or the backdrop closes it and
  // gives focus back to the menu button. Widening the window past the breakpoint closes it too.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const closeMenu = useCallback(() => { setMenuOpen(false); menuButton.current?.focus(); }, []);
  useEffect(() => {
    if (!menuOpen) return;
    const focusable = () => Array.from(sidebar.current?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled)') ?? []);
    focusable()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu();
      if (event.key === 'Tab') {
        const items = focusable();
        if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
      }
    };
    const drawer = matchMedia(DRAWER_QUERY);
    const onWidth = () => { if (!drawer.matches) setMenuOpen(false); };
    document.addEventListener('keydown', onKey);
    drawer.addEventListener('change', onWidth);
    return () => { document.removeEventListener('keydown', onKey); drawer.removeEventListener('change', onWidth); };
  }, [menuOpen, closeMenu]);
  // A read that succeeds again (after logging in from another tab) clears the notice.
  useEffect(() => { if (status === 'ready') setExpired(false); }, [status]);
  const changed = useCallback(() => { void refresh(); }, [refresh]);
  // The last result stays on screen after a failed read, but must not read as current. Every read passes through
  // loading; one that follows a failure keeps the error until it succeeds.
  // A result older than two refreshes and a read timeout is stale too: the first read after the page comes back from
  // the background has no error yet, and the rows may be hours old.
  const old = receivedAt !== null && Date.now() - receivedAt > 2 * REFRESH_MS + READ_TIMEOUT_MS;
  const stale = state !== null && (status === 'error' || status === 'offline' || status === 'paused' || (status === 'loading' && (error !== null || old)));
  const failed = status === 'error' || status === 'offline';
  const limits = state ? limitsText(state) : null;
  const aster = route.page !== 'oil' && route.page !== 'hynix' && route.page !== 'options' && route.page !== 'monitor' && route.page !== 'asset' && route.page !== 'crossex';
  return <div className="app-shell">
    {menuOpen ? <button type="button" className="nav-backdrop" aria-label="关闭导航" onClick={closeMenu} /> : null}
    <aside ref={sidebar} className={`sidebar ${menuOpen ? 'open' : ''}`}><Brand /><nav aria-label="主导航">
      {workspaceGroups(available).map(group => <div className="nav-group" role="group" aria-label={group.label} key={group.id}>
        <div className="nav-label" aria-hidden="true">{group.label}</div>
        {group.entries.map(entry => {
          const Icon = ICONS[entry], active = entry === current;
          return <a key={entry} href={navEntries[entry].href} className={`nav-item ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} onClick={menuOpen ? closeMenu : undefined}><Icon size={17} aria-hidden="true" /><span className="nav-text">{navEntries[entry].text}</span></a>;
        })}
      </div>)}
    </nav></aside>
    <div className="workspace">
      <header className="topbar"><div className="breadcrumb">
        <button ref={menuButton} type="button" className="icon-button mobile-menu" aria-label="打开导航" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}><Menu size={21} aria-hidden="true" /></button>
        <span>{crumb.workspace}</span><ChevronRight size={13} aria-hidden="true" /><strong>{crumb.page}</strong>
      </div></header>
      <main className="aster-desk"><div className="desk focused-desk"><div className="workspace">
        <div className="page-heading">
          <div className="page-title">
            <div className="page-title-row">
              <h1>交易服务</h1>
              <span className={`connection ${failed || state?.retired ? 'danger' : state ? 'mint' : ''}`} id="status">
                <i />{failed ? '连接异常' : state?.retired ? '已失去写入权，请重启' : state ? '服务已连接' : '等待连接'}
              </span>
            </div>
            {state ? <p className="page-meta">
              <span>写者代次 {state.generation} · 传输 {state.transport}</span>
              {limits ? <span>{limits}</span> : null}
              <span className={stale ? 'amber' : undefined}>{stale
                ? status === 'paused' ? `页面在后台，已暂停刷新（停留在 ${clock(receivedAt)}）` : status === 'offline' ? `网络离线（停留在 ${clock(receivedAt)}）`
                  : error ? `刷新失败：${error.message}（停留在 ${clock(receivedAt)}）` : `正在刷新，下方仍是 ${clock(receivedAt)} 的结果`
                : `更新 ${clock(receivedAt)}`}</span>
            </p> : null}
          </div>
          <div className="account-controls">
            <button type="button" className="button secondary" data-slot="button" onClick={changed}><RefreshCw size={16} aria-hidden="true" />刷新</button>
          </div>
        </div>
        <div className="feature-stack">
          {expired ? <Callout tone="warning" action={{ label: '刷新页面', onClick: () => location.reload() }}>会话已失效，请刷新页面重新登录（或用数据目录 access-url 里的登录链接）。</Callout> : null}
          {aster ? <div className="aster-module">
            {route.page === 'status' ? <StatusPage onExpired={onExpired} /> : route.page === 'logs' ? <LogsPage onExpired={onExpired} /> : route.page === 'settings'
              // The import does not need the state: it stays usable when the state cannot be read (the way to add the first pair).
              ? <SettingsPage onChanged={changed} onExpired={onExpired} />
              : !state ? (failed
                ? <StatePanel kind="error" title="读取服务状态失败" detail={error?.message ?? '网络离线'} />
                : <StatePanel kind="loading" title="加载中…" />)
                : <PairsWorkspace state={state} pairId={route.page === 'pair' ? route.pairId : null} stale={stale} onChanged={changed} onExpired={onExpired} />}
          </div> : route.page === 'options' ? <OptionsPage tab={route.tab} onExpired={onExpired} /> : route.page === 'monitor' ? <MonitorPage onExpired={onExpired} /> : route.page === 'asset' ? <AssetPage onExpired={onExpired} />
            : route.page === 'crossex' ? <CrossexPage tab={route.tab} onExpired={onExpired} /> : route.page === 'hynix' ? <HynixPage onExpired={onExpired} /> : <OilPage onExpired={onExpired} />}
        </div>
      </div></div></main>
    </div>
  </div>;
}
