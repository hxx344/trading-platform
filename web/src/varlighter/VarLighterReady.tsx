// 实盘准备页签：上线前核对清单、全局参数与风控、待确认规格的配对、各场所的采集状态与开关。
import { useEffect, useState } from 'react';
import { CircleAlert, CircleCheck, CircleDashed, LoaderCircle, Save } from 'lucide-react';
import { api } from '../api.ts';
import { Callout, StatePanel, TableEmpty } from '../StateViews.tsx';
import { useLiveResource } from '../use-live-resource.ts';
import type { ReadinessView, StateView, VenueStatus } from '../../../src/varlighter/views.ts';
import { Badge, useWrite } from './parts.tsx';
import { GLOBAL_FIELDS, IDENTITY_LABELS, VARLIGHTER_BASE, age, bytesPerDay, globalForm, globalRequest, plain, settingsBody, toggleConfirmed, varLighterHref, type GlobalForm } from './varlighter-form.ts';

const STATUS_ICON = { ok: CircleCheck, warn: CircleAlert, todo: CircleDashed } as const;
const STATUS_TEXT = { ok: '已就绪', warn: '待完成', todo: '待接入' } as const;

export function VarLighterReady({ view, onChanged, onExpired }: { view: StateView; onChanged: () => Promise<void>; onExpired: () => void }) {
  const live = useLiveResource<ReadinessView>(`${VARLIGHTER_BASE}/readiness`, { intervalMs: 30_000, timeoutMs: 15_000, onExpired });
  const refresh = async () => { await Promise.all([live.refresh(), onChanged()]); };
  const data = live.data;
  const counts = { ok: 0, warn: 0, todo: 0 };
  for (const item of data?.items ?? []) counts[item.status]++;
  return <>
    <div className="vl-columns">
      <section className="panel" aria-label="实盘前核对">
        <div className="panel-heading"><h2>实盘前核对</h2>{data ? <span className="muted">已就绪 {counts.ok} · 待完成 {counts.warn} · 待接入 {counts.todo}</span> : null}</div>
        {!data ? live.error ? <StatePanel kind="error" title="读取核对清单失败" detail={live.error.message} /> : <StatePanel kind="loading" title="加载中…" />
          : <ul className="vl-checklist">{data.items.map(item => { const Icon = STATUS_ICON[item.status]; return <li key={item.key} className={item.status}>
            <Icon size={16} aria-label={STATUS_TEXT[item.status]} /><div><strong>{item.label}</strong> <Badge tone={item.status === 'ok' ? 'ok' : item.status === 'warn' ? 'warn' : ''}>{STATUS_TEXT[item.status]}</Badge><p>{item.detail}</p></div></li>; })}</ul>}
        <p className="vl-note">「待接入」是需要账户与交易接口的事项，模拟盘阶段不会变成已就绪；全部就绪前本模块不会下真实订单。</p>
      </section>
      <div className="vl-stack">
        <GlobalPanel view={view} onChanged={refresh} />
        <SourcesPanel view={view} onChanged={refresh} />
      </div>
    </div>
    <IdentityPanel view={view} onChanged={refresh} />
  </>;
}

function GlobalPanel({ view, onChanged }: { view: StateView; onChanged: () => Promise<void> }) {
  const current = view.settings.global;
  const [form, setForm] = useState<GlobalForm>(() => globalForm(current));
  const [revision, setRevision] = useState(view.settings.revision);
  const write = useWrite();
  // 别处改了参数（版本号变了）时用新值重填。
  useEffect(() => { if (view.settings.revision !== revision) { setForm(globalForm(view.settings.global)); setRevision(view.settings.revision); } }, [view.settings, revision]);
  const parsed = globalRequest(form);
  const dirty = !parsed.ok || JSON.stringify(parsed.value) !== JSON.stringify(current);
  const submit = (global: typeof current, done: string) => {
    void write.run('global', () => api(`${VARLIGHTER_BASE}/settings`, { body: settingsBody(view.settings, { global }) }), () => { void onChanged(); return done; });
  };
  return <section className="panel" aria-label="全局参数与风控">
    <div className="panel-heading"><h2>全局参数与风控</h2><span className="muted">版本 {view.settings.revision}</span></div>
    <div className="vl-actions vl-pause">
      {current.paused ? <Badge tone="warn">已暂停</Badge> : <Badge tone="ok">运行中</Badge>}
      <button type="button" className="button secondary" disabled={write.busy !== null} onClick={() => submit({ ...current, paused: !current.paused }, current.paused ? '模拟盘已恢复开仓' : '模拟盘已暂停开仓')}>{current.paused ? '恢复开仓' : '暂停开仓'}</button>
      <span className="muted">暂停只停开新仓，已有持仓照常按规则平仓</span>
    </div>
    <div className="vl-fields">
      {GLOBAL_FIELDS.map(field => <label className="vl-field" key={field.key}>{field.label}（{field.unit}）
        <input inputMode="decimal" value={form[field.key]} onChange={event => setForm(value => ({ ...value, [field.key]: event.target.value }))} />
        {field.hint ? <small>{field.hint}</small> : null}</label>)}
    </div>
    <div className="vl-actions">
      <button type="button" className="button primary" disabled={!parsed.ok || !dirty || write.busy !== null} onClick={() => parsed.ok && submit({ ...parsed.value, paused: current.paused }, '全局参数已保存')}>{write.busy === 'global' ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Save size={14} aria-hidden="true" />}保存</button>
      {!parsed.ok ? <Callout tone="warning" role="status">{parsed.error}</Callout> : null}
      {write.message ? <Callout tone={write.message.tone}>{write.message.text}</Callout> : null}
    </div>
  </section>;
}

function SourcesPanel({ view, onChanged }: { view: StateView; onChanged: () => Promise<void> }) {
  const { var: varSource, venues } = view.sources, poll = varSource.poll, now = view.now;
  const write = useWrite();
  const enabled = venues.filter(item => item.enabled).map(item => item.venue);
  const toggle = (status: VenueStatus) => {
    const next = status.enabled ? enabled.filter(venue => venue !== status.venue) : [...enabled, status.venue];
    if (status.enabled && !confirm(`停止采集 ${status.name}？已采集的样本保留，重新开启后接着采集。`)) return;
    void write.run(`venue:${status.venue}`, () => api(`${VARLIGHTER_BASE}/settings`, { body: settingsBody(view.settings, { venues: next }) }),
      () => { void onChanged(); return status.enabled ? `已停止采集 ${status.name}` : `已开始采集 ${status.name}`; });
  };
  return <section className="panel" aria-label="采集状态">
    <div className="panel-heading"><h2>采集状态</h2><span className="muted">服务启动于 {age(view.startedAt, now)}</span></div>
    {write.message ? <div className="vl-actions"><Callout tone={write.message.tone}>{write.message.text}</Callout></div> : null}
    <div className="vl-table"><table><tbody>
      <tr><td>Var 公开报价</td><td className="wrap">{varSource.error ? <span className="vl-down">{varSource.error}</span> : `${age(varSource.ok, now)} · ${varSource.count} 个标的`}
        {poll ? <small>上次：新报价 {poll.fresh}，未变 {poll.unchanged}，无报价 {poll.noQuote}，Lighter 无盘口 {poll.noLighter}，写入 {poll.written}</small> : null}
        <small>报价收到时已过去 {varSource.quoteAgeMedianMs === null ? '—' : `${plain(varSource.quoteAgeMedianMs / 1000, 0)} 秒`}（中位数）</small></td></tr>
      {venues.map(status => <VenueRow key={status.venue} status={status} now={now} busy={write.busy}
        locked={status.enabled && enabled.length === 1} onToggle={() => toggle(status)} />)}
    </tbody></table></div>
    <p className="vl-note">行情流订阅全部市场的一档价，流量按解码后的文本折算（线上有压缩，实际约为其四分之一到二分之一）。已启用或有持仓的配对每分钟各取一次盘口快照（约 22 KB），每个场所最多 10 个。
      停采前先停用该场所上的标的并平掉模拟持仓。</p>
  </section>;
}

function VenueRow({ status, now, busy, locked, onToggle }: { status: VenueStatus; now: number; busy: string | null; locked: boolean; onToggle: () => void }) {
  const stream = status.stream, catalog = status.catalog;
  return <tr>
    <td>{status.name}<small>{status.enabled ? `${status.pairs} 个共同标的` : '未采集'}</small>
      <button type="button" className="button secondary vl-venue-toggle" disabled={busy !== null || locked} title={locked ? '至少保留一个场所' : undefined} onClick={onToggle}>
        {busy === `venue:${status.venue}` ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : null}{status.enabled ? '停止采集' : '开始采集'}</button></td>
    <td className="wrap">{!status.enabled ? <span className="vl-dim">已停止采集</span> : <>
      {stream?.connected ? `行情流已连接 ${age(stream.connectedAt, now)}` : <span className="vl-down">行情流未连接{stream?.lastError ? `：${stream.lastError}` : ''}</span>}
      {stream ? <small>最后消息 {age(stream.lastMessageAt, now)} · 重连 {stream.reconnects} 次 · {stream.markets} 个市场 · 约 {bytesPerDay(stream.bytes, stream.bytesSince, now)}</small> : null}
      <small>目录：{catalog.error ? <span className="vl-down">{catalog.error}</span> : `${age(catalog.ok, now)} · ${catalog.count} 个市场`}</small>
      <small>盘口快照：{status.depth.length ? status.depth.map(item => `${item.key.split(':')[1]} #${item.marketId} ${item.error ? `失败（${item.error}）` : item.at ? age(item.at, now) : '等待中'}`).join('，') : '没有启用的标的或持仓，不取'}</small>
    </>}</td>
  </tr>;
}

function IdentityPanel({ view, onChanged }: { view: StateView; onChanged: () => Promise<void> }) {
  const write = useWrite();
  const rows = view.rows.filter(row => row.identity !== 'verified');
  const confirmed = view.settings.confirmed;
  const toggle = (row: StateView['rows'][number], on: boolean) => {
    const label = `${row.symbol}（${row.venueName}）`;
    void write.run(`confirm:${row.key}`, () => api(`${VARLIGHTER_BASE}/settings`, { body: settingsBody(view.settings, { confirmed: toggleConfirmed(confirmed, row.key, on) }) }), () => { void onChanged(); return on ? `${label} 已确认两边规格相同` : `${label} 已撤销确认`; });
  };
  return <section className="panel" aria-label="规格核对">
    <div className="panel-heading"><h2>规格核对</h2><span className="muted">已核对的标的不列出；待确认的按场所分别确认，确认后才能启用模拟盘</span></div>
    {write.message ? <div className="vl-actions"><Callout tone={write.message.tone}>{write.message.text}</Callout></div> : null}
    {rows.length ? <div className="vl-table"><table>
      <thead><tr><th>标的</th><th>场所</th><th>类别</th><th>状态</th><th className="num">两边价格差</th><th>说明</th><th /></tr></thead>
      <tbody>{rows.map(row => { const on = confirmed.includes(row.key); return <tr key={row.key}>
        <td><a className="vl-symbol" href={varLighterHref('detail', row.key)}>{row.symbol}</a><small>{row.name}</small></td>
        <td>{row.venueName}</td>
        <td>{row.kindName}</td>
        <td><Badge tone={row.identity === 'mismatch' ? 'bad' : on ? 'ok' : 'warn'}>{row.identity === 'review' && on ? '已确认' : IDENTITY_LABELS[row.identity]}</Badge></td>
        <td className="num">{plain(row.gapBps, 0)} 基点</td>
        <td className="wrap">{row.identity === 'mismatch' ? '两边价格相差超过 5%，可能是同名不同物或报价单位不同，不能交易' : '同名但不在已核对清单（未上市、小市值或可能重名），先到两边官网核对合约说明'}</td>
        <td>{row.identity === 'review' ? <button type="button" className="button secondary" disabled={write.busy !== null || (on && row.enabled)} title={on && row.enabled ? '先停用该标的再撤销' : undefined} onClick={() => toggle(row, !on)}>{on ? '撤销确认' : '确认规格相同'}</button> : null}</td>
      </tr>; })}</tbody></table></div> : <TableEmpty>所有共同标的的规格都已核对</TableEmpty>}
  </section>;
}
