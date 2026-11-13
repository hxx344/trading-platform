import { Layers3, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { OIL_READ_TIMEOUT_MS, OIL_STATE_PATH, OilPage } from './OilPage.tsx';
import { LogsPage } from './LogsPage.tsx';
import { MONITOR_READ_TIMEOUT_MS, MONITOR_STATE_PATH, MonitorPage, parseMonitorState, type MonitorState } from './MonitorPage.tsx';
import { PairsWorkspace } from './PairsWorkspace.tsx';
import { useRoute, type Route } from './route.ts';
import { SettingsPage } from './SettingsPage.tsx';
import { StatusPage } from './StatusPage.tsx';
import { Callout, StatePanel } from './StateViews.tsx';
import { clock } from './labels.ts';
import { useLiveResource } from './use-live-resource.ts';
import type { ServiceState } from './types.ts';
import type { OilState } from './oil-types.ts';

// The page shell follows the workbench's ASTER desk (modules/aster/dashboard/app/page.tsx, b2fae14): the top bar with
// the brand, the page heading with the connection state, then line tabs. The ASTER pages sit in .aster-module, which
// carries the workbench's element styles; the oil and monitor pages keep their own.

const REFRESH_MS = 2_000;
const READ_TIMEOUT_MS = 10_000;

function limitsText(state: ServiceState): string | null {
  const limits = state.notionalLimits;
  if (!limits) return null;
  return `名义金额上限 单笔 ${limits.perJob} USDT，${'openPer24h' in limits ? `24 小时开仓 ${limits.openUsed} / ${limits.openPer24h}` : `累计开仓 ${limits.openUsed} / ${limits.totalOpen}`} USDT`;
}

type Tab = { pages: Route['page'][]; href: string; text: string };
const TABS: Tab[] = [
  { pages: ['overview', 'pair'], href: '#/', text: '配对组' }, { pages: ['status'], href: '#/status', text: '运行状态' }, { pages: ['logs'], href: '#/logs', text: '日志' }, { pages: ['settings'], href: '#/settings', text: '设置' },
];
/** Shown only where /api/oil/state answers: a service without oil returns 404 there. */
const OIL_TAB: Tab = { pages: ['oil'], href: '#/oil', text: '原油' };
const OIL_CHECK_MS = 60_000;
/** Likewise for /api/monitor/state: without config.monitor (or its database) the service answers 404. */
const MONITOR_TAB: Tab = { pages: ['monitor'], href: '#/monitor', text: '行情监控' };

export function App() {
  const route = useRoute();
  const [expired, setExpired] = useState(false);
  const onExpired = useCallback(() => setExpired(true), []);
  const live = useLiveResource<ServiceState>('/api/state', { intervalMs: REFRESH_MS, timeoutMs: READ_TIMEOUT_MS, onExpired });
  const { data: state, status, error, receivedAt, refresh } = live;
  // The oil page reads the same path faster while it is open; here it only decides whether the tab shows.
  const oil = useLiveResource<OilState>(OIL_STATE_PATH, { intervalMs: OIL_CHECK_MS, timeoutMs: OIL_READ_TIMEOUT_MS, onExpired });
  const monitor = useLiveResource<MonitorState>(MONITOR_STATE_PATH, { intervalMs: OIL_CHECK_MS, timeoutMs: MONITOR_READ_TIMEOUT_MS, parse: parseMonitorState, onExpired });
  const tabs = [...TABS, ...(oil.data !== null ? [OIL_TAB] : []), ...(monitor.data !== null ? [MONITOR_TAB] : [])];
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
  const aster = route.page !== 'oil' && route.page !== 'monitor';
  return <div className="aster-desk">
    <main className="desk focused-desk">
      <header className="topbar">
        <div className="brand"><Layers3 size={22} aria-hidden="true" /><span>统一交易平台<span className="brand-separator">/</span><small>ASTER 保证金平衡 · 原油</small></span></div>
      </header>
      <div className="workspace">
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
          <Callout tone="error" role="status">实盘：启用的配对会在真实 ASTER 子账户之间划转 USD1；ADL 导致两侧不一致时按只减仓市价单自动减仓。启用前请先在工作台停用并删除同一配对。停用后该配对的划转与新的 ADL 检测都会停止。</Callout>
          {expired ? <Callout tone="warning" action={{ label: '刷新页面', onClick: () => location.reload() }}>会话已失效，请刷新页面重新登录（或用数据目录 access-url 里的登录链接）。</Callout> : null}
          <div className="workspace-tabs">
            <nav className="workspace-navigation" data-slot="tabs-list" aria-label="页面">
              {tabs.map(tab => {
                const active = tab.pages.includes(route.page);
                return <a key={tab.href} href={tab.href} data-slot="tabs-trigger" data-active={active ? '' : undefined} aria-current={active ? 'page' : undefined}>{tab.text}</a>;
              })}
            </nav>
            {aster ? <div className="aster-module">
              {route.page === 'status' ? <StatusPage onExpired={onExpired} /> : route.page === 'logs' ? <LogsPage onExpired={onExpired} /> : route.page === 'settings'
                // The import does not need the state: it stays usable when the state cannot be read (the way to add the first pair).
                ? <SettingsPage onChanged={changed} onExpired={onExpired} />
                : !state ? (failed
                  ? <StatePanel kind="error" title="读取服务状态失败" detail={error?.message ?? '网络离线'} />
                  : <StatePanel kind="loading" title="加载中…" />)
                  : <PairsWorkspace state={state} pairId={route.page === 'pair' ? route.pairId : null} stale={stale} onChanged={changed} onExpired={onExpired} />}
            </div> : route.page === 'oil' ? <OilPage onExpired={onExpired} /> : <MonitorPage onExpired={onExpired} />}
          </div>
        </div>
      </div>
    </main>
  </div>;
}
