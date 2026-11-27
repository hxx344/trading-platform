// DEX 价差页（#/varlighter，docs/varlighter.md 第 10 节、docs/dexspread.md 第 7 节、docs/frontend.md《DEX 价差页》）。
// 工作台没有对应页面，骨架照 Ondo 页（wb-page、panel、callout）。四个页签：价差总览、标的详情、模拟盘、实盘准备；
// 页签与配对键（场所:代码|场所:代码）在地址里，刷新或分享链接回到同一处。场所有 Var、Lighter RH、Lighter 主网与 Entropy，
// 开着的组合自动把同代码的市场配对，另有手动配对；同一代码在几个组合里是几行。
import './varlighter.css';
import { useDeferredValue, useRef, useState } from 'react';
import { api } from '../api.ts';
import { useDialogGuard } from '../AppDialog.tsx';
import { Callout, StatePanel, TableEmpty } from '../StateViews.tsx';
import { useLiveResource } from '../use-live-resource.ts';
import type { OrphanRow, PositionSummary, StateRow, StateView, VenueStatus } from '../../../src/varlighter/views.ts';
import { Badge, Metric, useWrite } from './parts.tsx';
import { VarLighterDetail } from './VarLighterDetail.tsx';
import { VarLighterPaper } from './VarLighterPaper.tsx';
import { VarLighterReady } from './VarLighterReady.tsx';
import {
  IDENTITY_LABELS, OVERVIEW_MODES, OVERVIEW_MODE_KEY, REGIME_LABELS, SIMPLE_SORT_KEYS, VARLIGHTER_BASE, VARLIGHTER_TABS, age, bps, comboShort, directionLabel, directionShort, directionSides, entryProgress, fundingAnnual, matchesCombo, matchesQuery, plain,
  quickEnableBody, readOverviewMode, settingsBody, signal, signedUsd, sortRows, tone, usd, varLighterHref, venueShort, type ComboFilter, type OverviewMode, type SortKey, type VarLighterTab,
} from './varlighter-form.ts';

export const STATE_PATH = `${VARLIGHTER_BASE}/state`;
// 两腿都是行情流的配对启用后 5 秒一个样本，页面跟着 5 秒读一次。
export const STATE_REFRESH_MS = 5_000;
const READ_TIMEOUT_MS = 15_000;

/** 同一路径的订阅共用一次读取，各页签用同样的选项。 */
export function useVarLighterState(onExpired: () => void) {
  return useLiveResource<StateView>(STATE_PATH, { intervalMs: STATE_REFRESH_MS, timeoutMs: READ_TIMEOUT_MS, parse: parseState, onExpired });
}
function parseState(raw: unknown): StateView {
  const value = raw as StateView | null;
  if (!value || typeof value !== 'object' || !Array.isArray(value.rows) || !value.sources || !value.settings) throw new Error('应答格式不对');
  return value;
}

export function VarLighterPage({ tab, symbol, onExpired }: { tab: VarLighterTab; symbol: string | null; onExpired: () => void }) {
  const live = useVarLighterState(onExpired);
  const { data, error, status, receivedAt } = live;
  return <div className="vl-page" data-varlighter>
    <header className="wb-heading"><div><h1>DEX 价差</h1>
      <p>比较同一资产在 Var、Lighter RH、Lighter 主网与 Entropy 上的价格。价差明显偏离平时水平时模拟开仓，回到平时水平后模拟平仓。成交价取自盘口或与成交数量匹配的 Var 询价。</p></div>
      {data ? <Sources view={data} /> : null}</header>
    <nav className="vl-tabs" aria-label="DEX 价差页签">
      {VARLIGHTER_TABS.map(item => <a key={item.id} href={varLighterHref(item.id, item.id === 'detail' ? symbol : null)} aria-current={tab === item.id ? 'page' : undefined}>{item.label}</a>)}
    </nav>
    {error && data ? <p className="vl-note err" role="status">刷新失败：{error.message}（数据停留在 {receivedAt ? new Date(receivedAt).toLocaleTimeString() : '—'}）</p> : null}
    {!data
      ? status === 'error' || status === 'offline' ? <StatePanel kind="error" title="读取价差模块失败" detail={error?.message ?? '网络离线'} /> : <StatePanel kind="loading" title="加载中…" />
      : tab === 'overview' ? <Overview view={data} onChanged={live.refresh} />
        : tab === 'detail' ? <VarLighterDetail view={data} symbol={symbol} onChanged={live.refresh} onExpired={onExpired} />
          : tab === 'paper' ? <VarLighterPaper view={data} onChanged={live.refresh} onExpired={onExpired} />
            : <VarLighterReady view={data} onChanged={live.refresh} onExpired={onExpired} />}
  </div>;
}

function Sources({ view }: { view: StateView }) {
  const { var: varSource, venues } = view.sources, now = view.now;
  const varTone = varSource.error ? 'bad' : varSource.ok && now - varSource.ok < 180_000 ? 'ok' : 'warn';
  return <div className="vl-sources" aria-label="数据来源">
    {varSource.enabled !== false ? <span className={`vl-chip ${varTone}`} title={varSource.error ?? undefined}><i />Var {varSource.error ? '读取失败' : age(varSource.ok, now)}</span> : null}
    {venues.filter(item => item.enabled).map(item => <VenueChip key={item.venue} status={item} now={now} />)}
    {view.settings.global.paused ? <span className="vl-chip warn"><i />模拟盘已暂停</span> : null}
  </div>;
}

/** 一个场所一枚：行情流连接、盘口同步、目录读取失败合在一起，悬停看详情。 */
function VenueChip({ status, now }: { status: VenueStatus; now: number }) {
  const stream = status.stream;
  const staleDepth = status.depth.filter(item => item.at === null || item.error !== null || now - item.at > 180_000).length;
  const chipTone = !stream?.connected || status.catalog.error ? 'bad' : staleDepth ? 'warn' : 'ok';
  const detail = [stream?.lastError, status.catalog.error, staleDepth ? `${staleDepth} 个盘口未同步` : null].filter(Boolean).join('；');
  return <span className={`vl-chip ${chipTone}`} title={detail || undefined}><i />{status.name} {stream?.connected ? `${status.pairs} 对` : '未连接'}{status.depth.length ? ` · 盘口 ${status.depth.length - staleDepth}/${status.depth.length}` : ''}</span>;
}

function Overview({ view, onChanged }: { view: StateView; onChanged: () => Promise<void> }) {
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({ key: 'gap', descending: true });
  const [query, setQuery] = useState('');
  const [onlyEnabled, setOnlyEnabled] = useState(false);
  const [mode, setMode] = useState<OverviewMode>(() => { try { return readOverviewMode(localStorage.getItem(OVERVIEW_MODE_KEY)); } catch { return 'simple'; } });
  const orphanWrite = useWrite(), paperWrite = useWrite();
  const [combo, setCombo] = useState<ComboFilter>('all');
  const deferred = useDeferredValue(query);
  const rows = sortRows(view.rows.filter(row => matchesQuery(row, deferred) && matchesCombo(row, combo) && (!onlyEnabled || row.enabled || row.position)), sort.key, sort.descending);
  const combos = (view.sources.combos ?? []).filter(item => item.enabled && item.pairs > 0);
  const customCount = view.rows.filter(row => row.custom).length;
  const filters: { id: ComboFilter; label: string }[] = [{ id: 'all', label: '全部' }, ...combos.map(item => ({ id: item.combo, label: comboShort(item.combo) })), ...(customCount ? [{ id: 'custom' as const, label: '手动' }] : [])];
  const multi = filters.length > 2 || customCount > 0;
  const counts = { verified: 0, review: 0, mismatch: 0 };
  for (const row of view.rows) counts[row.identity]++;
  // 样本过期的行不算机会，也不高亮：最后一个样本到过线不代表现在还在线上。
  const hits = view.rows.filter(row => !isStale(row, view.now) && (signal(row)?.gap ?? -1) >= 0).length;
  const paper = view.paper;
  const simple = mode === 'simple';
  const changeMode = (next: OverviewMode) => {
    setMode(next);
    // 简洁视图没有的列不留作排序依据，否则表头上看不出按什么排。
    if (next === 'simple' && !SIMPLE_SORT_KEYS.includes(sort.key)) setSort({ key: 'gap', descending: true });
    try { localStorage.setItem(OVERVIEW_MODE_KEY, next); } catch { /* 浏览器未允许持久化。 */ }
  };
  const header = (key: SortKey, text: string, num = true, hint?: string) => <th className={num ? 'num' : undefined} title={hint} aria-sort={sort.key === key ? sort.descending ? 'descending' : 'ascending' : undefined}>
    <button type="button" aria-pressed={sort.key === key} onClick={() => setSort(current => ({ key, descending: current.key === key ? !current.descending : key !== 'symbol' && key !== 'kind' }))}>{text}{sort.key === key ? sort.descending ? ' ↓' : ' ↑' : ''}</button></th>;
  const toggle = (row: StateRow, on: boolean) => {
    const label = `${row.symbol}（${venueShort(row.a.venue)}↔${venueShort(row.b.venue)}）`;
    // 等状态读回来再放开复选框：下一次勾选要带新的版本号。
    void paperWrite.run(`paper:${row.key}`, async () => { await api(`${VARLIGHTER_BASE}/settings`, { body: quickEnableBody(view.settings, row.key, on) }); await onChanged().catch(() => {}); },
      () => { return on ? `${label} 已启用模拟盘，入场、出场、止损与最长持有按推荐值自动配置` : `${label} 已停用${row.position ? '，已有持仓照常平仓' : ''}`; });
  };
  const paperProps = { now: view.now, multi, busy: paperWrite.busy !== null, onToggle: toggle };
  const pairFoot = [...combos.map(item => `${comboShort(item.combo)} ${item.pairs}`), customCount ? `手动 ${customCount}` : '', counts.review ? `待确认 ${counts.review}` : '', counts.mismatch ? `规格不同 ${counts.mismatch}` : ''].filter(Boolean).join(' · ');
  return <>
    <section className="vl-metrics" aria-label="概览">
      <Metric label="开仓机会" value={`${hits} 个`} tone={hits ? 'up' : ''} accent={hits > 0} foot={hits ? '价差偏离已到开仓线，表格里绿色高亮' : '暂时没有配对的偏离到开仓线'} />
      <Metric label="监控中的配对" value={`${view.rows.length} 个`} foot={pairFoot || '还没有配对'} />
      <Metric label="模拟盘累计盈亏" value={signedUsd(paper.netUsd)} tone={tone(paper.netUsd)} foot={`已平仓 ${paper.trades} 笔 · 今日 ${signedUsd(paper.todayNetUsd)}`} />
      <Metric label="模拟持仓" value={`${paper.open} 笔`} foot={`名义金额 ${usd(paper.openNotionalUsd, 0)}`} />
    </section>
    {view.orphans?.length ? <Orphans view={view} rows={view.orphans} write={orphanWrite} onChanged={onChanged} />
      : orphanWrite.message ? <div className="vl-actions"><Callout tone={orphanWrite.message.tone}>{orphanWrite.message.text}</Callout><button type="button" className="button secondary" onClick={orphanWrite.clear}>知道了</button></div> : null}
    <section className="panel" aria-label="价差总览">
      <div className="panel-heading"><h2>价差总览</h2><span className="muted">单位：基点（1 基点 = 0.01%）{view.firstSampleAt ? <span title={new Date(view.firstSampleAt).toLocaleString()}> · 数据自 {age(view.firstSampleAt, view.now)}开始采集</span> : ' · 还没有样本'}</span></div>
      <div className="vl-toolbar">
        <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="代码或名称" aria-label="筛选标的" />
        {filters.length > 2 ? <div className="vl-seg" role="group" aria-label="场所组合">
          {filters.map(item => <button type="button" key={item.id} aria-pressed={combo === item.id} onClick={() => setCombo(item.id)}>{item.label}</button>)}</div> : null}
        <label><input type="checkbox" checked={onlyEnabled} onChange={event => setOnlyEnabled(event.target.checked)} />只看已启用或有持仓</label>
        <span className="grow" />
        <div className="vl-seg" role="group" aria-label="表格视图">
          {OVERVIEW_MODES.map(item => <button type="button" key={item.id} aria-pressed={mode === item.id} title={item.hint} onClick={() => changeMode(item.id)}>{item.label}</button>)}</div>
        <span className="muted">{rows.length} / {view.rows.length}</span>
      </div>
      {paperWrite.message ? <div className="vl-actions vl-pause"><Callout tone={paperWrite.message.tone}>{paperWrite.message.text}</Callout></div> : null}
      {rows.length ? <div className="vl-table vl-overview"><table>
        {simple
          ? <thead><tr>{header('symbol', '标的', false)}<th title="勾选即启用，参数按推荐值自动配置">模拟盘</th>{header('mid', '当前价差', true, '两个场所同一资产的价格差')}{header('gap', '距开仓', false, '当前偏离对比开仓线，条满即达到开仓条件')}<th>操作方向</th>
            {header('cost', '交易成本', true, '开仓加平仓、两条腿合计的盘口成本')}</tr></thead>
          : <thead><tr>{header('symbol', '标的', false)}<th title="勾选即启用，参数按推荐值自动配置">模拟盘</th>{header('kind', '类别 · 时段', false)}{header('mid', '中间价基差')}<th className="num">基线</th>{header('z', '偏离 σ')}
            <th className="num">卖 A / 买 A</th>{header('cost', '往返成本')}{header('gap', '信号')}<th className="num">资金费（年化）</th>{header('samples', '24h 样本')}</tr></thead>}
        <tbody>{rows.map(row => simple ? <SimpleRow key={row.key} row={row} {...paperProps} /> : <Row key={row.key} row={row} {...paperProps} />)}</tbody>
      </table></div> : <TableEmpty>{view.rows.length ? '没有符合筛选的配对' : view.sources.venues.some(item => item.catalog.ok) ? '开着的组合里还没有配对的报价；可在实盘准备页开启组合或添加手动配对' : '正在读取各场所的目录…'}</TableEmpty>}
      <details className="vl-help">
        <summary>这些数字怎么看</summary>
        {simple ? <dl>
          <dt>当前价差</dt><dd>同一资产在两个场所的价格差（配对里写在前面的场所相对后面的场所，有 Var 时 Var 在前），正数表示前面的更贵。下面的「平时」是近期同一时段的常见水平。</dd>
          <dt>模拟盘</dt><dd>勾选就把这个配对交给模拟盘自动开平仓，不用先设参数：入场线、出场、止损和最长持有由系统按这个配对近期的波动和交易成本推荐，约每 10 分钟更新一次（标「自动」）；刚开始采集、样本还不够时先不开仓。取消勾选即停用，已有的持仓照常平仓。想自己定参数，点标的代码进详情页关掉「自动配置」。</dd>
          <dt>距开仓</dt><dd>现在的价差比平时偏了多少，对比这个标的的开仓线。进度条满了就到了开仓线，这一行会高亮；模拟盘真正开仓前还要过风控，也只做该配对参数里允许的方向。数据超过 5 分钟没更新的行不高亮。</dd>
          <dt>操作方向</dt><dd>价差回到平时水平时能赚钱的做法：贵的一边卖出，便宜的一边买入。现在还没有偏离的配对不显示方向。</dd>
          <dt>交易成本</dt><dd>开仓加平仓、两条腿合计要付的盘口成本。偏离要明显大于它才有利润；写「估算」的是按一档价估算。</dd>
          <dt>还想看更多</dt><dd>右上角切到「完整」，可以看基线、偏离 σ、两个方向的可成交价差、资金费和样本数。</dd>
        </dl> : <p>有 Var 腿的每分钟一个 Var 报价、对齐对手腿当时的一档；两腿都是行情流的每 5 秒（未启用每 20 秒），已启用或有持仓的一档一有变化就判断开平仓。模拟盘一列勾选即启用并用自动配置（入场、出场、止损、最长持有取推荐值，约 10 分钟更新），信号列的入场阈值是当前生效的值。A 是配对键里的第一条腿（有 Var 时为 Var）。卖 A 价差 = A 买价 ÷（乘数 × B 卖价）− 1，买 A 价差 = A 卖价 ÷（乘数 × B 买价）− 1，按各配对名义金额取档（≤ 1000 美元用 1k 档）；
          已启用或有持仓的配对订阅行情流腿的完整盘口（WebSocket）算冲击，其余用一档价估算（标「估」）。信号列是离入场最近的一侧：偏离 − 入场阈值，≥ 0 即达到开仓条件。资金费只作参考，两腿都折成年化。</p>}
      </details>
    </section>
  </>;
}

const positionPnl = ({ pnlBps, estimated }: PositionSummary): string | null =>
  pnlBps === null ? null : `${bps(pnlBps)} 基点${estimated ? '（估算）' : ''}`;

/** 已启用或有持仓、但已失联的键（下架、规格改判、长时间无样本）：可停用，持仓按最后样本平仓。 */
function Orphans({ view, rows, write, onChanged }: { view: StateView; rows: OrphanRow[]; write: ReturnType<typeof useWrite>; onChanged: () => Promise<void> }) {
  const dialog = useDialogGuard();
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const writeBusyRef = useRef(write.busy);
  writeBusyRef.current = write.busy;
  const label = (row: OrphanRow) => `${row.symbol}（${row.a && row.b ? `${venueShort(row.a.venue)}↔${venueShort(row.b.venue)}` : row.key}）`;
  const disable = (row: OrphanRow) => {
    const params = view.settings.symbols[row.key];
    if (!params) return;
    void write.run(`disable:${row.key}`, () => api(`${VARLIGHTER_BASE}/settings`, { body: settingsBody(view.settings, { symbol: { symbol: row.key, params: { ...params, enabled: false } } }) }),
      () => { void onChanged(); return `${label(row)} 已停用`; });
  };
  const close = async (row: OrphanRow) => {
    if (writeBusyRef.current !== null) return;
    if (!await dialog.confirm(`${label(row)}：${row.reason}。按最后一个样本（${row.lastSampleAt ? new Date(row.lastSampleAt).toLocaleString() : '—'}）平掉模拟持仓？`, { title: '平掉模拟持仓', confirmLabel: '确认平仓', tone: 'danger' })) return;
    if (!dialog.isAlive() || writeBusyRef.current !== null || !rowsRef.current.some(item => item.key === row.key && item.position)) return;
    void write.run(`close:${row.key}`, () => api<{ netUsd: number; closedAt: number }>(`${VARLIGHTER_BASE}/paper/close`, { body: { symbol: row.key } }),
      trade => { void onChanged(); return `${label(row)} 已按 ${new Date(trade.closedAt).toLocaleString()} 的样本平仓，净 ${signedUsd(trade.netUsd)}`; });
  };
  return <section className="panel" aria-label="失联的标的">
    <div className="panel-heading"><h2>失联的标的</h2><span className="muted">下架、规格改判或长时间无样本；没有新样本就不会自动止损或超时平仓，可停用或按最后样本平仓</span></div>
    {write.message ? <div className="vl-actions"><Callout tone={write.message.tone}>{write.message.text}</Callout></div> : null}
    <div className="vl-table"><table>
      <thead><tr><th>标的</th><th>状态</th><th>最后样本</th><th /></tr></thead>
      <tbody>{rows.map(row => <tr key={row.key}>
        <td><span className="vl-symbol">{row.symbol}</span><small>{row.a && row.b ? `${row.a.name} ↔ ${row.b.name}` : row.key}</small></td>
        <td className="wrap">{row.reason}<small>{row.enabled ? <Badge tone="warn">已启用</Badge> : null} {row.position ? <>{directionShort(row.position.direction, row.a?.venue ?? null)} 持仓 {positionPnl(row.position)}</> : null}</small></td>
        <td>{age(row.lastSampleAt, view.now)}</td>
        <td><div className="vl-actions">
          {row.enabled ? <button type="button" className="button secondary" disabled={write.busy !== null} onClick={() => disable(row)}>停用</button> : null}
          {row.position ? <button type="button" className="button secondary" disabled={write.busy !== null} onClick={() => void close(row)}>按最后样本平仓</button> : null}
        </div></td>
      </tr>)}</tbody>
    </table></div>
  </section>;
}

/** 当天只写时刻，跨日带日期。 */
const clockOrDate = (at: number, now: number) => new Date(at).toDateString() === new Date(now).toDateString() ? new Date(at).toLocaleTimeString() : new Date(at).toLocaleString();
const isStale = (row: StateRow, now: number) => row.sampleAt === null || now - row.sampleAt > 5 * 60_000;

function SymbolCell({ row, multi, simple }: { row: StateRow; multi: boolean; simple: boolean }) {
  // 简洁视图只标出需要处理的规格状态；「已确认」不占位置。
  const confirmed = row.identity === 'review' && row.eligible;
  return <td><a className="vl-symbol" href={varLighterHref('detail', row.key)}>{row.symbol}</a>{multi ? <Badge tone={row.custom ? 'warn' : row.a.venue === 'var' ? 'info' : ''}>{venueShort(row.a.venue)}↔{venueShort(row.b.venue)}</Badge> : null}
    {row.identity !== 'verified' && !(simple && confirmed) ? <Badge tone={row.identity === 'mismatch' ? 'bad' : row.eligible ? 'ok' : 'warn'}>{confirmed ? '已确认' : IDENTITY_LABELS[row.identity]}</Badge> : null}
    <small>{simple ? [row.name, row.kindName].filter(Boolean).join(' · ') : row.name}</small></td>;
}
type PaperProps = { row: StateRow; now: number; multi: boolean; busy: boolean; onToggle: (row: StateRow, on: boolean) => void };
function PaperCell({ row, now, busy, onToggle }: PaperProps) {
  // 规格没确认或不同的配对服务端不让启用；已启用的总能停用。
  const locked = !row.enabled && !row.eligible;
  const hint = locked ? row.identity === 'mismatch' ? '两边合约规格不同，不能启用' : '两边规格还没确认，先到实盘准备页确认'
    : row.enabled ? '取消勾选即停用，已有持仓照常平仓' : '勾选即启用模拟盘，入场、出场、止损与最长持有按推荐值自动配置';
  return <td>
    <label className={`vl-check${row.enabled ? ' on' : ''}`} title={hint}>
      <input type="checkbox" checked={row.enabled} disabled={busy || locked} onChange={event => onToggle(row, event.target.checked)} aria-label={`${row.symbol} ${venueShort(row.a.venue)}↔${venueShort(row.b.venue)} 模拟盘`} />
      {row.enabled ? '已启用' : '启用'}</label>
    {row.enabled && row.auto ? <Badge tone={row.autoPending ? 'warn' : 'info'}>自动</Badge> : null}{row.position ? <Badge tone="info">持仓</Badge> : null}
    {row.position ? <small title={directionLabel(row.position.direction, row.a.venue, row.b.venue)}>{directionShort(row.position.direction, row.a.venue)} · {positionPnl(row.position) ?? '—'}</small>
      : row.enabled && row.autoPending ? <small className="vl-warn">样本不足，暂不开仓</small>
        : row.enabled && row.cooldownUntil ? <small>冷却至 {clockOrDate(row.cooldownUntil, now)}</small> : locked ? <small>{row.identity === 'mismatch' ? '规格不同' : '规格待确认'}</small> : null}
  </td>;
}

function SimpleRow(props: PaperProps) {
  const { row, now, multi } = props;
  const progress = entryProgress(row);
  const stale = isStale(row, now);
  const reached = !!progress?.reached && !stale;
  // 偏离不为正时按这个方向做，回到平时水平也赚不到，不给买卖提示。
  const sides = progress && progress.deviation > 0 ? directionSides(progress.direction, row.a.venue, row.b.venue) : null;
  return <tr className={reached ? 'vl-hit' : undefined}>
    <SymbolCell row={row} multi={multi} simple />
    <PaperCell {...props} />
    <td className="num"><span className={`vl-value${stale ? ' vl-dim' : ''}`}>{bps(row.mid)}</span>
      {stale ? <small className="vl-warn">{row.sampleAt ? `${age(row.sampleAt, now)}的数据` : '暂无数据'}</small>
        : <small title={row.baseline ? `${row.baseline.fallback ? '全天' : REGIME_LABELS[row.baseline.regime]}基线，${row.baseline.samples} 个样本` : undefined}>{row.baseline ? `平时 ${bps(row.baseline.median)}` : '平时水平统计中'}</small>}</td>
    <td>{progress ? <div className={`vl-gap${reached ? ' reached' : stale ? ' stale' : ''}`}>
      <span>{progress.reached ? '已到开仓线' : `还差 ${plain(progress.short)}`}</span>
      <svg viewBox="0 0 100 6" preserveAspectRatio="none" role="img" aria-label={`偏离 ${plain(progress.deviation)} 基点，开仓线 ${plain(progress.entry)} 基点`}>
        <rect className="track" width="100" height="6" /><rect className="fill" width={Math.round(progress.ratio * 100)} height="6" /></svg>
      <small>偏离 {plain(progress.deviation)} / 开仓线 {plain(progress.entry)}</small>
    </div> : <span className="vl-dim">数据不足</span>}</td>
    <td>{sides ? <span className="vl-sides"><span className="vl-side sell">卖 {venueShort(sides.sell)}</span><span className="vl-side buy">买 {venueShort(sides.buy)}</span></span> : <span className="vl-dim">—</span>}</td>
    <td className="num">{plain(row.cost)}{row.estimated ? <small>估算</small> : null}</td>
  </tr>;
}

function Row(props: PaperProps) {
  const { row, now, multi } = props;
  const hit = signal(row);
  const funding = fundingAnnual(row.aFunding, row.bFunding);
  const stale = isStale(row, now);
  return <tr className={hit && hit.gap >= 0 && !stale ? 'vl-hit' : undefined}>
    <SymbolCell row={row} multi={multi} simple={false} />
    <PaperCell {...props} />
    <td>{row.kindName}<small>{REGIME_LABELS[row.regime]}</small></td>
    <td className={`num ${stale ? 'vl-dim' : ''}`}>{bps(row.mid)}<small>{row.sampleAt ? age(row.sampleAt, now) : '无样本'}</small></td>
    <td className="num">{row.baseline ? <>{bps(row.baseline.median)} <span className="vl-dim">± {plain(row.baseline.sigma)}</span><small>{row.baseline.fallback ? '全天基线 · ' : `${REGIME_LABELS[row.baseline.regime]} · `}{row.baseline.samples} 个</small></> : <span className="vl-dim">样本不足</span>}</td>
    <td className={`num ${row.z !== null && Math.abs(row.z) >= 2 ? 'vl-warn' : ''}`}>{row.z === null ? '—' : row.z.toFixed(1)}</td>
    <td className="num">{bps(row.sellA)} / {bps(row.buyA)}{row.estimated ? <Badge>估</Badge> : null}</td>
    <td className="num">{plain(row.cost)}</td>
    <td className="num">{hit ? <><span className={hit.gap >= 0 ? 'vl-up' : undefined}>{bps(hit.gap)}</span><small title={directionLabel(hit.direction, row.a.venue, row.b.venue)}>{directionShort(hit.direction, row.a.venue)} {plain(hit.deviation)} / {plain(row.entryBps)}</small></> : '—'}</td>
    <td className="num">{funding.a} / {funding.b}<small>{venueShort(row.a.venue)} / {venueShort(row.b.venue)}</small></td>
    <td className="num">{row.samples24h}</td>
  </tr>;
}
