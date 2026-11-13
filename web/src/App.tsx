import { useCallback, useEffect, useState } from 'react';
import { AdlPanel } from './AdlPanel.tsx';
import { ImportPanel } from './ImportPanel.tsx';
import { PairDetail } from './PairDetail.tsx';
import { PairsPanel } from './PairsPanel.tsx';
import { PositionsPanel } from './PositionsPanel.tsx';
import { useRoute, type Route } from './route.ts';
import { SettingsPage } from './SettingsPage.tsx';
import { StatusPage } from './StatusPage.tsx';
import { Callout, StatePanel } from './StateViews.tsx';
import { clock } from './labels.ts';
import { useLiveResource } from './use-live-resource.ts';
import type { ServiceState } from './types.ts';

const REFRESH_MS = 2_000;
const READ_TIMEOUT_MS = 10_000;

function statusLine(state: ServiceState): string {
  // The ASTER service registers no trading connector accounts; the part is left out rather than shown empty.
  return `写者代次 ${state.generation}${state.retired ? '（已失去写入权，请重启）' : ''} · 传输 ${state.transport}`
    + (state.accounts.length ? ` · 账户 ${state.accounts.map(a => `${a.venue} ${a.accountMode} ${a.accountId} v${a.credentialVersion}`).join('，')}` : '')
    + (state.notionalLimits ? ` · 名义金额上限 单笔 ${state.notionalLimits.perJob} USDT，累计开仓 ${state.notionalLimits.openUsed} / ${state.notionalLimits.totalOpen} USDT` : '');
}

const TABS: { page: Route['page']; href: string; text: string }[] = [
  { page: 'overview', href: '#/', text: '总览' }, { page: 'pair', href: '#/pair', text: '配对详情' }, { page: 'status', href: '#/status', text: '运行状态' },
  { page: 'settings', href: '#/settings', text: '设置' },
];

export function App() {
  const route = useRoute();
  const [expired, setExpired] = useState(false);
  const onExpired = useCallback(() => setExpired(true), []);
  const live = useLiveResource<ServiceState>('/api/state', { intervalMs: REFRESH_MS, timeoutMs: READ_TIMEOUT_MS, onExpired });
  const { data: state, status, error, receivedAt, refresh } = live;
  // A read that succeeds again (after logging in from another tab) clears the notice.
  useEffect(() => { if (status === 'ready') setExpired(false); }, [status]);
  const changed = useCallback(() => { void refresh(); }, [refresh]);
  // The last result stays on screen after a failed read, but must not read as current. Every read passes through
  // loading; one that follows a failure keeps the error until it succeeds.
  // A result older than two refreshes and a read timeout is stale too: the first read after the page comes back from
  // the background has no error yet, and the rows may be hours old.
  const old = receivedAt !== null && Date.now() - receivedAt > 2 * REFRESH_MS + READ_TIMEOUT_MS;
  const stale = state !== null && (status === 'error' || status === 'offline' || status === 'paused' || (status === 'loading' && (error !== null || old)));
  return <main className="wb-page">
    <header className="wb-heading">
      <div>
        <h1>统一交易平台 · ASTER 保证金平衡与 ADL</h1>
        <p>启用的配对由本服务负责保证金平衡划转与 ADL 应急处理。</p>
      </div>
    </header>
    <Callout tone="error" role="status">实盘：启用的配对会在真实 ASTER 子账户之间划转 USD1；ADL 导致两侧不一致时按只减仓市价单自动减仓。启用前请先在工作台停用并删除同一配对。停用后该配对的划转与新的 ADL 检测都会停止。</Callout>
    {expired ? <Callout tone="warning" action={{ label: '刷新页面', onClick: () => location.reload() }}>会话已失效，请刷新页面重新登录（或用数据目录 access-url 里的登录链接）。</Callout> : null}
    {state ? <p className="status-line" id="status">
      {statusLine(state)}
      {stale ? <span className="err">{status === 'paused' ? ` · 页面在后台，已暂停刷新（停留在 ${clock(receivedAt)}）` : status === 'offline' ? ` · 网络离线（停留在 ${clock(receivedAt)}）` : error ? ` · 刷新失败：${error.message}（停留在 ${clock(receivedAt)}）` : ` · 正在刷新，下方仍是 ${clock(receivedAt)} 的结果`}</span> : null}
    </p> : null}
    <nav className="tabs" aria-label="页面">
      {TABS.map(tab => <a key={tab.page} href={tab.href} className={tab.page === route.page ? 'tab active' : 'tab'} aria-current={tab.page === route.page ? 'page' : undefined}>{tab.text}</a>)}
    </nav>
    {route.page === 'status' ? <StatusPage onExpired={onExpired} /> : <>
    {!state ? (status === 'error' || status === 'offline'
      ? <StatePanel kind="error" title="读取服务状态失败" detail={error?.message ?? '网络离线'} />
      : <StatePanel kind="loading" title="加载中…" />) : route.page === 'pair' ? <PairDetail state={state} pairId={route.pairId} stale={stale} onExpired={onExpired} />
      : route.page === 'settings' ? <SettingsPage state={state} stale={stale} onChanged={changed} onExpired={onExpired} /> : <>
      <PairsPanel state={state} onChanged={changed} />
      <PositionsPanel view={state.positions} stale={stale} shownAt={state.positions.checkedAt} />
      <AdlPanel state={state} onChanged={changed} />
    </>}
    {/* The import does not need the state: it stays usable when the state cannot be read (the way to add the first pair). */}
    {route.page === 'settings' ? <ImportPanel onImported={changed} /> : null}
    </>}
  </main>;
}
