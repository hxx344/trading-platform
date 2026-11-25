// DEX 价差页（#/varlighter，docs/varlighter.md 第 10 节、docs/dexspread.md 第 7 节、docs/frontend.md《DEX 价差页》）。
// 工作台没有对应页面，骨架照 Ondo 页（wb-page、panel、callout）。四个页签：价差总览、标的详情、模拟盘、实盘准备；
// 页签与配对键（场所:代码|场所:代码）在地址里，刷新或分享链接回到同一处。场所有 Var、Lighter RH、Lighter 主网与 Entropy，
// 开着的组合自动把同代码的市场配对，另有手动配对；同一代码在几个组合里是几行。
import './varlighter.css';
import { useDeferredValue, useState } from 'react';
import { api } from '../api.ts';
import { Callout, StatePanel, TableEmpty } from '../StateViews.tsx';
import { useLiveResource } from '../use-live-resource.ts';
import type { OrphanRow, StateRow, StateView, VenueStatus } from '../../../src/varlighter/views.ts';
import { Badge, Metric, useWrite } from './parts.tsx';
import { VarLighterDetail } from './VarLighterDetail.tsx';
import { VarLighterPaper } from './VarLighterPaper.tsx';
import { VarLighterReady } from './VarLighterReady.tsx';
import {
  IDENTITY_LABELS, REGIME_LABELS, SORT_LABELS, VARLIGHTER_BASE, VARLIGHTER_TABS, age, bps, comboShort, directionLabel, directionShort, fundingAnnual, matchesCombo, matchesQuery, plain,
  settingsBody, signal, signedUsd, sortRows, tone, usd, varLighterHref, venueShort, type ComboFilter, type SortKey, type VarLighterTab,
} from './varlighter-form.ts';

export const STATE_PATH = `${VARLIGHTER_BASE}/state`;
export const STATE_REFRESH_MS = 10_000;
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
      <p>Var、Lighter RH、Lighter 主网与 Entropy 之间同一资产的价差采集、基线与回归套利，可自动配对也可手动配对。目前只做模拟盘：按公开报价撮合，不向任何交易所下单。</p></div>
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

/** 一个场所一枚：行情流连接、盘口快照新鲜度、目录读取失败合在一起，悬停看详情。 */
function VenueChip({ status, now }: { status: VenueStatus; now: number }) {
  const stream = status.stream;
  const staleDepth = status.depth.filter(item => item.at === null || now - item.at > 180_000).length;
  const chipTone = !stream?.connected || status.catalog.error ? 'bad' : staleDepth ? 'warn' : 'ok';
  const detail = [stream?.lastError, status.catalog.error, staleDepth ? `${staleDepth} 个盘口快照过期` : null].filter(Boolean).join('；');
  return <span className={`vl-chip ${chipTone}`} title={detail || undefined}><i />{status.name} {stream?.connected ? `${status.pairs} 对` : '未连接'}{status.depth.length ? ` · 盘口 ${status.depth.length - staleDepth}/${status.depth.length}` : ''}</span>;
}

function Overview({ view, onChanged }: { view: StateView; onChanged: () => Promise<void> }) {
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({ key: 'gap', descending: true });
  const [query, setQuery] = useState('');
  const [onlyEnabled, setOnlyEnabled] = useState(false);
  const orphanWrite = useWrite();
  const [combo, setCombo] = useState<ComboFilter>('all');
  const deferred = useDeferredValue(query);
  const rows = sortRows(view.rows.filter(row => matchesQuery(row, deferred) && matchesCombo(row, combo) && (!onlyEnabled || row.enabled || row.position)), sort.key, sort.descending);
  const combos = (view.sources.combos ?? []).filter(item => item.enabled && item.pairs > 0);
  const customCount = view.rows.filter(row => row.custom).length;
  const filters: { id: ComboFilter; label: string }[] = [{ id: 'all', label: '全部' }, ...combos.map(item => ({ id: item.combo, label: comboShort(item.combo) })), ...(customCount ? [{ id: 'custom' as const, label: '手动' }] : [])];
  const multi = filters.length > 2 || customCount > 0;
  const counts = { verified: 0, review: 0, mismatch: 0 };
  for (const row of view.rows) counts[row.identity]++;
  const hits = view.rows.filter(row => (signal(row)?.gap ?? -1) >= 0).length;
  const paper = view.paper;
  const header = (key: SortKey, text: string, num = true) => <th className={num ? 'num' : undefined} aria-sort={sort.key === key ? sort.descending ? 'descending' : 'ascending' : undefined}>
    <button type="button" aria-pressed={sort.key === key} onClick={() => setSort(current => ({ key, descending: current.key === key ? !current.descending : key !== 'symbol' && key !== 'kind' }))}>{text}{sort.key === key ? sort.descending ? ' ↓' : ' ↑' : ''}</button></th>;
  return <>
    <section className="vl-metrics" aria-label="概览">
      <Metric label="配对" value={view.rows.length} foot={`${combos.map(item => `${comboShort(item.combo)} ${item.pairs}`).join(' · ')}${customCount ? ` · 手动 ${customCount}` : ''} · 待确认 ${counts.review} · 规格不同 ${counts.mismatch}`} />
      <Metric label="达到入场偏离" value={hits} foot="按各标的入场阈值，开仓前还要过风控" />
      <Metric label="采集起点" value={view.firstSampleAt ? age(view.firstSampleAt, view.now) : '—'} foot={view.firstSampleAt ? new Date(view.firstSampleAt).toLocaleString() : '还没有样本'} />
      <Metric label="模拟盘净盈亏" value={signedUsd(paper.netUsd)} tone={tone(paper.netUsd)} foot={`${paper.trades} 笔 · 今日 ${signedUsd(paper.todayNetUsd)} · 持仓 ${paper.open} 笔 ${usd(paper.openNotionalUsd, 0)}`} />
    </section>
    {view.orphans?.length ? <Orphans view={view} rows={view.orphans} write={orphanWrite} onChanged={onChanged} />
      : orphanWrite.message ? <div className="vl-actions"><Callout tone={orphanWrite.message.tone}>{orphanWrite.message.text}</Callout><button type="button" className="button secondary" onClick={orphanWrite.clear}>知道了</button></div> : null}
    <section className="panel" aria-label="价差总览">
      <div className="panel-heading"><h2>价差总览</h2><span className="muted">有 Var 腿的每分钟一个 Var 报价、对齐对手腿当时的一档；两腿都是行情流的每 15 秒（未启用每分钟）· 单位基点（1 = 0.01%）</span></div>
      <div className="vl-toolbar">
        <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="代码或名称" aria-label="筛选标的" />
        {filters.length > 2 ? <div className="vl-seg" role="group" aria-label="场所组合">
          {filters.map(item => <button type="button" key={item.id} aria-pressed={combo === item.id} onClick={() => setCombo(item.id)}>{item.label}</button>)}</div> : null}
        <label><input type="checkbox" checked={onlyEnabled} onChange={event => setOnlyEnabled(event.target.checked)} />只看已启用或有持仓</label>
        <span className="grow" />
        <label>排序<select value={sort.key} onChange={event => setSort({ key: event.target.value as SortKey, descending: event.target.value !== 'symbol' && event.target.value !== 'kind' })}>
          {(Object.keys(SORT_LABELS) as SortKey[]).map(key => <option key={key} value={key}>{SORT_LABELS[key]}</option>)}</select></label>
        <span className="muted">{rows.length} / {view.rows.length}</span>
      </div>
      {rows.length ? <div className="vl-table"><table>
        <thead><tr>{header('symbol', '标的', false)}{header('kind', '类别 · 时段', false)}{header('mid', '中间价基差')}<th className="num">基线</th>{header('z', '偏离 σ')}
          <th className="num">卖 A / 买 A</th>{header('cost', '往返成本')}{header('gap', '信号')}<th className="num">资金费（年化）</th>{header('samples', '24h 样本')}<th>模拟盘</th></tr></thead>
        <tbody>{rows.map(row => <Row key={row.key} row={row} now={view.now} multi={multi} />)}</tbody>
      </table></div> : <TableEmpty>{view.rows.length ? '没有符合筛选的配对' : view.sources.venues.some(item => item.catalog.ok) ? '开着的组合里还没有配对的报价；可在实盘准备页开启组合或添加手动配对' : '正在读取各场所的目录…'}</TableEmpty>}
      <p className="vl-note">A 是配对键里的第一条腿（有 Var 时为 Var）。卖 A 价差 = A 买价 ÷（乘数 × B 卖价）− 1，买 A 价差 = A 卖价 ÷（乘数 × B 买价）− 1，按各配对名义金额取档（≤ 1000 美元用 1k 档）；
        已启用或有持仓的配对每分钟取一次行情流腿的盘口快照算冲击，其余用一档价估算（标「估」）。信号列是离入场最近的一侧：偏离 − 入场阈值，≥ 0 即达到开仓条件。资金费只作参考，两腿都折成年化。</p>
    </section>
  </>;
}

/** 已启用或有持仓、但已失联的键（下架、规格改判、长时间无样本）：可停用，持仓按最后样本平仓。 */
function Orphans({ view, rows, write, onChanged }: { view: StateView; rows: OrphanRow[]; write: ReturnType<typeof useWrite>; onChanged: () => Promise<void> }) {
  const label = (row: OrphanRow) => `${row.symbol}（${row.a && row.b ? `${venueShort(row.a.venue)}↔${venueShort(row.b.venue)}` : row.key}）`;
  const disable = (row: OrphanRow) => {
    const params = view.settings.symbols[row.key];
    if (!params) return;
    void write.run(`disable:${row.key}`, () => api(`${VARLIGHTER_BASE}/settings`, { body: settingsBody(view.settings, { symbol: { symbol: row.key, params: { ...params, enabled: false } } }) }),
      () => { void onChanged(); return `${label(row)} 已停用`; });
  };
  const close = (row: OrphanRow) => {
    if (!confirm(`${label(row)}：${row.reason}。按最后一个样本（${row.lastSampleAt ? new Date(row.lastSampleAt).toLocaleString() : '—'}）平掉模拟持仓？`)) return;
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
        <td className="wrap">{row.reason}<small>{row.enabled ? <Badge tone="warn">已启用</Badge> : null} {row.position ? <>{directionShort(row.position.direction, row.a?.venue ?? null)} 持仓{row.position.pnlBps === null ? '' : ` ${bps(row.position.pnlBps)} 基点`}</> : null}</small></td>
        <td>{age(row.lastSampleAt, view.now)}</td>
        <td><div className="vl-actions">
          {row.enabled ? <button type="button" className="button secondary" disabled={write.busy !== null} onClick={() => disable(row)}>停用</button> : null}
          {row.position ? <button type="button" className="button secondary" disabled={write.busy !== null} onClick={() => close(row)}>按最后样本平仓</button> : null}
        </div></td>
      </tr>)}</tbody>
    </table></div>
  </section>;
}

/** 当天只写时刻，跨日带日期。 */
const clockOrDate = (at: number, now: number) => new Date(at).toDateString() === new Date(now).toDateString() ? new Date(at).toLocaleTimeString() : new Date(at).toLocaleString();

function Row({ row, now, multi }: { row: StateRow; now: number; multi: boolean }) {
  const hit = signal(row);
  const funding = fundingAnnual(row.aFunding, row.bFunding);
  const stale = row.sampleAt === null || now - row.sampleAt > 5 * 60_000;
  return <tr className={hit && hit.gap >= 0 ? 'vl-hit' : undefined}>
    <td><a className="vl-symbol" href={varLighterHref('detail', row.key)}>{row.symbol}</a>{multi ? <Badge tone={row.custom ? 'warn' : row.a.venue === 'var' ? 'info' : ''}>{venueShort(row.a.venue)}↔{venueShort(row.b.venue)}</Badge> : null}
      {row.identity !== 'verified' ? <Badge tone={row.identity === 'mismatch' ? 'bad' : row.eligible ? 'ok' : 'warn'}>{row.identity === 'review' && row.eligible ? '已确认' : IDENTITY_LABELS[row.identity]}</Badge> : null}
      <small>{row.name}</small></td>
    <td>{row.kindName}<small>{REGIME_LABELS[row.regime]}</small></td>
    <td className={`num ${stale ? 'vl-dim' : ''}`}>{bps(row.mid)}<small>{row.sampleAt ? age(row.sampleAt, now) : '无样本'}</small></td>
    <td className="num">{row.baseline ? <>{bps(row.baseline.median)} <span className="vl-dim">± {plain(row.baseline.sigma)}</span><small>{row.baseline.fallback ? '全天基线 · ' : `${REGIME_LABELS[row.baseline.regime]} · `}{row.baseline.samples} 个</small></> : <span className="vl-dim">样本不足</span>}</td>
    <td className={`num ${row.z !== null && Math.abs(row.z) >= 2 ? 'vl-warn' : ''}`}>{row.z === null ? '—' : row.z.toFixed(1)}</td>
    <td className="num">{bps(row.sellA)} / {bps(row.buyA)}{row.estimated ? <Badge>估</Badge> : null}</td>
    <td className="num">{plain(row.cost)}</td>
    <td className="num">{hit ? <><span className={hit.gap >= 0 ? 'vl-up' : undefined}>{bps(hit.gap)}</span><small title={directionLabel(hit.direction, row.a.venue, row.b.venue)}>{directionShort(hit.direction, row.a.venue)} {plain(hit.deviation)} / {plain(row.entryBps)}</small></> : '—'}</td>
    <td className="num">{funding.a} / {funding.b}<small>{venueShort(row.a.venue)} / {venueShort(row.b.venue)}</small></td>
    <td className="num">{row.samples24h}</td>
    <td>{row.position ? <><Badge tone="info">持仓</Badge><small title={directionLabel(row.position.direction, row.a.venue, row.b.venue)}>{directionShort(row.position.direction, row.a.venue)} · {row.position.pnlBps === null ? '—' : `${bps(row.position.pnlBps)} 基点`}</small></>
      : row.enabled ? <><Badge tone="ok">已启用</Badge>{row.cooldownUntil ? <small>冷却至 {clockOrDate(row.cooldownUntil, now)}</small> : null}</> : <span className="vl-dim">未启用</span>}</td>
  </tr>;
}
