import { Activity, ArrowLeftRight, Cpu, ChevronRight, Coins, Gauge, Layers, Link2, Menu, Newspaper, Percent, RefreshCw, Scale, ScrollText, Server, Settings2, ShieldCheck, Sigma, Wallet, Waves, Zap, type LucideIcon } from 'lucide-react';
import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { shellMarkets, type MarketScope, type MonitorScopes, type ShellView } from '../../src/shell-view.ts';
import { LazyBoundary } from './LazyBoundary.tsx';
import { PairsWorkspace } from './PairsWorkspace.tsx';
import { useRoute } from './route.ts';
import { UpdateStatus } from './UpdateStatus.tsx';
import { HostStatusBadge } from './HostStatusBadge.tsx';
import { ConnectionStatus } from './ConnectionStatus.tsx';
import { READ_TOKEN_PATH, READ_TOKEN_REFRESH_MS, navNotice, type ReadTokenView } from './read-token-form.ts';
import { Callout, StatePanel } from './StateViews.tsx';
import { clock } from './labels.ts';
import { invalidateMonitorDisplay, revalidateMonitorState, useLiveResource } from './use-live-resource.ts';
import { readAccessDenied, type ResourceSnapshot } from './live-resource.ts';
import { ApiError } from './api.ts';
import type { ServiceState } from './types.ts';
import { breadcrumbOf, entryOf, navEntries, workspaceGroups, type NavEntry } from './workspace-nav.ts';

// The shell follows the workbench's main interface (src/App.tsx, 31242e0): a side navigation grouped by the workspaces
// of the unified platform plan (workspace-nav.ts), a topbar with the breadcrumb, and on a phone a drawer behind a menu
// button. The content keeps the workbench's ASTER desk (modules/aster/dashboard/app/page.tsx, b2fae14): the page heading
// with the connection state, then the page. The ASTER pages sit in .aster-module, which carries the workbench's element
// styles; the oil, options, monitor, asset and CrossEx pages keep their own.

const REFRESH_MS = 2_000;
const READ_TIMEOUT_MS = 10_000;

// Keep the default pair workspace ready while its first state request is in flight.
// The shell read below re-renders App twice every two seconds (loading, then the answer), and every page with it. Most
// pages lean on that: a countdown, a task's elapsed time or a preview's expiry is computed while rendering and has no
// timer of its own. Only the pages that show nothing of the kind are memoized (their props, onExpired, never change);
// before memoizing another, give each of its time-dependent texts its own timer.
const AssetPage = lazy(() => import('./AssetPage.tsx').then(m => ({ default: m.AssetPage })));
const AssetPositions = lazy(() => import('./AssetPositions.tsx').then(m => ({ default: m.AssetPositions })));
const MonitorPage = lazy(() => import('./MonitorPage.tsx').then(m => ({ default: m.MonitorPage })));
const NewsPage = lazy(() => import('./NewsPage.tsx').then(m => ({ default: memo(m.NewsPage) })));
const OilPage = lazy(() => import('./OilPage.tsx').then(m => ({ default: m.OilPage })));
const HynixPage = lazy(() => import('./HynixPage.tsx').then(m => ({ default: m.HynixPage })));
const GoldOilPage = lazy(() => import('./GoldOilPage.tsx').then(m => ({ default: m.GoldOilPage })));
const CrossexPage = lazy(() => import('./crossex/CrossexPage.tsx').then(m => ({ default: m.CrossexPage })));
const OndoPage = lazy(() => import('./ondo/OndoPage.tsx').then(m => ({ default: m.OndoPage })));
const VarLighterPage = lazy(() => import('./varlighter/VarLighterPage.tsx').then(m => ({ default: m.VarLighterPage })));
const MevPage = lazy(() => import('./mev/MevPage.tsx').then(m => ({ default: m.MevPage })));
const FundingBookPage = lazy(() => import('./fundingbook/FundingBookPage.tsx').then(m => ({ default: m.FundingBookPage })));
const ChainArbPage = lazy(() => import('./ChainArbPage.tsx').then(m => ({ default: m.ChainArbPage })));
const OptionsPage = lazy(() => import('./OptionsPage.tsx').then(m => ({ default: m.OptionsPage })));
const StatusPage = lazy(() => import('./StatusPage.tsx').then(m => ({ default: m.StatusPage })));
const LogsPage = lazy(() => import('./LogsPage.tsx').then(m => ({ default: memo(m.LogsPage) })));
const SettingsPage = lazy(() => import('./SettingsPage.tsx').then(m => ({ default: m.SettingsPage })));

function isStale(read: ResourceSnapshot<unknown>) {
  const old = read.receivedAt !== null && Date.now() - read.receivedAt > 2 * REFRESH_MS + READ_TIMEOUT_MS;
  return read.data !== null && (read.status === 'error' || read.status === 'offline' || read.status === 'paused'
    || (read.status === 'loading' && (read.error !== null || old)));
}

const ALWAYS: readonly NavEntry[] = ['pairs', 'chain-arb', 'status', 'logs', 'settings'];
const ICONS: Record<NavEntry, LucideIcon> = { asset: Wallet, positions: Layers, monitor: Activity, news: Newspaper, oil: ArrowLeftRight, hynix: Cpu, goldoil: Scale, crossex: Gauge, ondo: Coins, varlighter: Waves, pairs: ShieldCheck, fundingbook: Percent, options: Sigma, mev: Zap, 'chain-arb': Link2, status: Server, logs: ScrollText, settings: Settings2 };
/** Below this width the side navigation is a drawer (the workbench's 760px breakpoint, shell.css). */
const DRAWER_QUERY = '(max-width: 760px)';

function Brand() { return <div className="brand"><span className="brand-mark" aria-hidden="true"><i /><i /><i /><i /></span><span>统一交易平台<small>交易服务</small></span></div>; }

export function App() {
  const route = useRoute();
  const [expired, setExpired] = useState(false);
  const onExpired = useCallback(() => setExpired(true), []);
  const shell = useLiveResource<ShellView>('/api/shell', { intervalMs: REFRESH_MS, timeoutMs: READ_TIMEOUT_MS, onExpired });
  const { data: state, status, error, receivedAt, refresh } = shell;
  const pairPage = route.page === 'overview' || route.page === 'pair';
  const pairs = useLiveResource<ServiceState>('/api/state?jobs=0', { intervalMs: REFRESH_MS, timeoutMs: READ_TIMEOUT_MS, enabled: pairPage, onExpired });

  // Retained public quotes are valid only for the observed collector generation, including while another page is open.
  const lastMonitor = useRef<MonitorScopes | null | undefined>(undefined);
  const [appliedScopes, setAppliedScopes] = useState<MonitorScopes | null>(null);
  const observeMonitor = useCallback((next: MonitorScopes | null, failure: Error | null) => {
    const previous = lastMonitor.current;
    lastMonitor.current = next;
    let changed = (previous == null) !== (next == null);
    for (const market of shellMarkets) {
      const before = previous?.[market], after = next?.[market];
      if (before?.enabled === after?.enabled && before?.revision === after?.revision) continue;
      changed = true;
      if (market === 'perpetual') continue;
      if (!after?.enabled) invalidateMonitorDisplay(market, failure ?? new ApiError('行情监控已关闭或未配置', 423));
      else if (previous !== undefined && before?.revision !== after.revision) invalidateMonitorDisplay(market, null, true);
    }
    if (changed) setAppliedScopes(next);
    return previous !== undefined && changed;
  }, []);
  useLayoutEffect(() => {
    if (status === 'ready' && state) {
      if (observeMonitor(state.monitor, null)) void revalidateMonitorState();
    } else if (readAccessDenied(error)) observeMonitor(null, error);
  }, [state, status, error, observeMonitor]);
  const controlChanged = useCallback(async (market: string, control: MarketScope) => {
    const known = shellMarkets.find(item => item === market);
    const before = known && lastMonitor.current?.[known];
    if (known && before && (before.revision ?? 0) <= (control.revision ?? 0)) {
      observeMonitor({ ...lastMonitor.current, [known]: control }, null);
    }
    // Re-read all switches: an acknowledgment for one market cannot confirm the others.
    await Promise.all([revalidateMonitorState(), refresh()]);
  }, [observeMonitor, refresh]);
  // The read-only token's expiry hint under 设置 (docs/mcp.md); a service without tokens answers 404 and shows none.
  const readToken = useLiveResource<ReadTokenView>(READ_TOKEN_PATH, { intervalMs: READ_TOKEN_REFRESH_MS, onExpired });
  const tokenNotice = navNotice(readToken.data, Date.now());
  const available = new Set<NavEntry>(ALWAYS);
  if (state) {
    for (const entry of ['oil', 'options', 'asset', 'crossex', 'ondo', 'news', 'varlighter', 'mev', 'fundingbook'] as const) {
      if (state.modules[entry]) available.add(entry);
    }
    if (state.modules.oil) { available.add('hynix'); available.add('goldoil'); }
    if (state.modules.asset) available.add('positions');
    if (state.monitor !== null) available.add('monitor');
  }
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
  const refreshPairs = pairs.refresh;
  const changed = useCallback(() => {
    void refresh();
    if (pairPage) void refreshPairs();
  }, [refresh, pairPage, refreshPairs]);
  const stale = isStale(shell);
  const failed = status === 'error' || status === 'offline';
  const aster = pairPage || ['status', 'logs', 'settings', 'news'].includes(route.page);
  function pageContent() {
    switch (route.page) {
      case 'settings': return <SettingsPage onChanged={changed} onExpired={onExpired} />;
      case 'status': return <StatusPage onExpired={onExpired} />;
      case 'logs': return <LogsPage onExpired={onExpired} />;
      case 'news': return <NewsPage onExpired={onExpired} />;
      case 'monitor': return <MonitorPage shell={shell} scopes={appliedScopes} onControlChanged={controlChanged} onExpired={onExpired} />;
      case 'options': return <OptionsPage tab={route.tab} onExpired={onExpired} />;
      case 'asset': return <AssetPage onExpired={onExpired} />;
      case 'positions': return <AssetPositions onExpired={onExpired} />;
      case 'ondo': return <OndoPage onExpired={onExpired} />;
      case 'varlighter': return <VarLighterPage tab={route.tab} symbol={route.symbol} onExpired={onExpired} />;
      case 'mev': return <MevPage tab={route.tab} onExpired={onExpired} />;
      case 'fundingbook': return <FundingBookPage tab={route.tab} onExpired={onExpired} />;
      case 'chain-arb': return <ChainArbPage shell={shell} onExpired={onExpired} />;
      case 'crossex': return <CrossexPage tab={route.tab} onExpired={onExpired} />;
      case 'hynix': return <HynixPage onExpired={onExpired} />;
      case 'goldoil': return <GoldOilPage onExpired={onExpired} />;
      case 'oil': return <OilPage onExpired={onExpired} />;
      default:
        if (pairs.data) return <PairsWorkspace state={pairs.data} pairId={route.page === 'pair' ? route.pairId : null} stale={isStale(pairs)} onChanged={changed} onExpired={onExpired} />;
        if (pairs.status === 'error' || pairs.status === 'offline') return <StatePanel kind="error" title="读取服务状态失败" detail={pairs.error?.message ?? '网络离线'} />;
        return <StatePanel kind="loading" title="加载中…" />;
    }
  }
  return <div className="app-shell">
    {menuOpen ? <button type="button" className="nav-backdrop" aria-label="关闭导航" onClick={closeMenu} /> : null}
    <aside ref={sidebar} className={`sidebar ${menuOpen ? 'open' : ''}`}><Brand /><nav aria-label="主导航">
      {workspaceGroups(available).map(group => <div className="nav-group" role="group" aria-label={group.label} key={group.id}>
        <div className="nav-label" aria-hidden="true">{group.label}</div>
        {group.entries.map(entry => {
          const Icon = ICONS[entry], active = entry === current;
          return <a key={entry} href={navEntries[entry].href} className={`nav-item ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} onClick={menuOpen ? closeMenu : undefined}><Icon size={17} aria-hidden="true" /><span className="nav-text">{navEntries[entry].text}{entry === 'settings' && tokenNotice ? <small className="nav-notice" data-read-token-nav>{tokenNotice}</small> : null}</span></a>;
        })}
        {/* The online update sits after the system pages, as in the workbench (docs/update.md). */}
        {group.id === 'system' ? <UpdateStatus onExpired={onExpired} onOpen={menuOpen ? closeMenu : undefined} /> : null}
      </div>)}
    </nav></aside>
    <div className="workspace">
      <header className="topbar"><div className="breadcrumb">
        <button ref={menuButton} type="button" className="icon-button mobile-menu" aria-label="打开导航" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}><Menu size={21} aria-hidden="true" /></button>
        <span>{crumb.workspace}</span><ChevronRight size={13} aria-hidden="true" /><strong>{crumb.page}</strong>
      </div><div className="topbar-right"><HostStatusBadge onExpired={onExpired} /><ConnectionStatus onExpired={onExpired} /></div></header>
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
          {error instanceof ApiError && error.status === 404 ? <Callout tone="warning" action={{ label: '刷新页面', onClick: () => location.reload() }}>服务版本已切换，请刷新以载入对应的页面。</Callout> : null}
          <LazyBoundary key={current} what={crumb.page}>
            <Suspense fallback={<StatePanel kind="loading" title="加载中…" />}>
              {aster ? <div className="aster-module">{pageContent()}</div> : pageContent()}
            </Suspense>
          </LazyBoundary>
        </div>
      </div></div></main>
    </div>
  </div>;
}
