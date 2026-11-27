// 实盘准备页签：上线前核对清单、全局参数与风控、自动配对的组合开关与手动配对、待确认规格的配对、各场所的采集状态。
import { useMemo, useState } from 'react';
import { CircleAlert, CircleCheck, CircleDashed, LoaderCircle, Plus, Save, Trash2 } from 'lucide-react';
import { api } from '../api.ts';
import { Callout, StatePanel, TableEmpty } from '../StateViews.tsx';
import { useLiveResource } from '../use-live-resource.ts';
import type { Combo, CustomPair, VenueId } from '../../../src/varlighter/model.ts';
import type { CatalogEntry, ReadinessView, StateView, VenueStatus } from '../../../src/varlighter/views.ts';
import { Badge, useWrite } from './parts.tsx';
import { VarLighterLive } from './VarLighterLive.tsx';
import {
  COMBO_OPTIONS, EMPTY_PAIR_FORM, GLOBAL_FIELDS, IDENTITY_LABELS, KIND_OPTIONS, VARLIGHTER_BASE, VENUE_OPTIONS, age, bytesPerDay, comboLabel, customPairKey, customPairRequest, globalForm, globalRequest,
  plain, price, settingsBody, toggleConfirmed, varLighterHref, venueShort, type CustomPairForm, type GlobalForm,
} from './varlighter-form.ts';

const STATUS_ICON = { ok: CircleCheck, warn: CircleAlert, todo: CircleDashed } as const;
const STATUS_TEXT = { ok: '已就绪', warn: '待完成', todo: '待接入' } as const;

export function VarLighterReady({ view, onChanged, onExpired }: { view: StateView; onChanged: () => Promise<void>; onExpired: () => void }) {
  const live = useLiveResource<ReadinessView>(`${VARLIGHTER_BASE}/readiness`, { intervalMs: 30_000, timeoutMs: 15_000, onExpired });
  const refresh = async () => { await Promise.all([live.refresh(), onChanged()]); };
  const data = live.data;
  const counts = { ok: 0, warn: 0, todo: 0 };
  for (const item of data?.items ?? []) counts[item.status]++;
  return <>
    <VarLighterLive onExpired={onExpired} />
    <div className="vl-columns">
      <section className="panel" aria-label="实盘前核对">
        <div className="panel-heading"><h2>实盘前核对</h2>{data ? <span className="muted">已就绪 {counts.ok} · 待完成 {counts.warn} · 待接入 {counts.todo}</span> : null}</div>
        {!data ? live.error ? <StatePanel kind="error" title="读取核对清单失败" detail={live.error.message} /> : <StatePanel kind="loading" title="加载中…" />
          : <ul className="vl-checklist">{data.items.map(item => { const Icon = STATUS_ICON[item.status]; return <li key={item.key} className={item.status}>
            <Icon size={16} aria-label={STATUS_TEXT[item.status]} /><div><strong>{item.label}</strong> <Badge tone={item.status === 'ok' ? 'ok' : item.status === 'warn' ? 'warn' : ''}>{STATUS_TEXT[item.status]}</Badge><p>{item.detail}</p></div></li>; })}</ul>}
        <p className="vl-note">这张清单只作参考，不拦实盘：是否下真实订单只看上面的实盘总开关与勾选的配对。「待接入」是还没有做的事项（Var 没有下单接口，带 Var 腿的配对不上实盘）。</p>
      </section>
      <div className="vl-stack">
        <GlobalPanel view={view} onChanged={refresh} />
        <CombosPanel view={view} onChanged={refresh} />
      </div>
    </div>
    <PairsPanel view={view} markets={data?.markets ?? null} onChanged={refresh} />
    <IdentityPanel view={view} onChanged={refresh} />
    <SourcesPanel view={view} />
  </>;
}

function GlobalPanel({ view, onChanged }: { view: StateView; onChanged: () => Promise<void> }) {
  const current = view.settings.global;
  const [draft, setDraft] = useState<{ revision: number; fields: Partial<GlobalForm> } | null>(null);
  const form = { ...globalForm(current), ...draft?.fields };
  const write = useWrite();
  const parsed = globalRequest(form);
  const dirty = !!draft && (!parsed.ok || GLOBAL_FIELDS.some(({ key }) => parsed.value[key] !== current[key]));
  const changed = dirty && draft.revision !== view.settings.revision;
  const updateField = (key: (typeof GLOBAL_FIELDS)[number]['key'], value: string) => {
    setDraft(previous => {
      const fields = { ...previous?.fields, [key]: value };
      if (value === globalForm(current)[key]) delete fields[key];
      return Object.keys(fields).length ? { revision: previous?.revision ?? view.settings.revision, fields } : null;
    });
  };
  const submit = (global: typeof current, done: string, saving = false) => {
    void write.run(saving ? 'save' : 'pause', async () => {
      await api(`${VARLIGHTER_BASE}/settings`, { body: settingsBody(view.settings, { global }) });
      await onChanged();
      if (saving) setDraft(previous => previous === draft ? null : previous);
    }, () => done);
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
        <input inputMode="decimal" value={form[field.key]} disabled={write.busy === 'save'} onChange={event => updateField(field.key, event.target.value)} />
        {field.hint ? <small>{field.hint}</small> : null}</label>)}
    </div>
    {changed ? <Callout tone="warning" role="status">设置已更新到版本 {view.settings.revision}。保留了你改过的字段，其余使用最新值。
      <button type="button" className="button secondary" disabled={write.busy === 'save'} onClick={() => setDraft(null)}>放弃草稿</button>
    </Callout> : null}
    <div className="vl-actions">
      <button type="button" className="button primary" disabled={!parsed.ok || !dirty || write.busy !== null} onClick={() => parsed.ok && submit({ ...parsed.value, paused: current.paused }, '全局参数已保存', true)}>{write.busy === 'save' ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Save size={14} aria-hidden="true" />}保存</button>
      {!parsed.ok ? <Callout tone="warning" role="status">{parsed.error}</Callout> : null}
      {write.message ? <Callout tone={write.message.tone}>{write.message.text}</Callout> : null}
    </div>
  </section>;
}

/** 自动配对：每个场所组合一个开关，开着的组合把两个场所里代码相同的市场配成一对。 */
function CombosPanel({ view, onChanged }: { view: StateView; onChanged: () => Promise<void> }) {
  const write = useWrite();
  const combos = view.sources.combos ?? [];
  const enabled = combos.filter(item => item.enabled).map(item => item.combo);
  const toggle = (combo: Combo, on: boolean) => {
    if (!on && !confirm(`关闭「${comboLabel(combo)}」？它的配对不再采集新样本，已采集的样本保留；还启用着或有持仓的配对须先停用并平仓。`)) return;
    const next = on ? [...enabled, combo] : enabled.filter(item => item !== combo);
    void write.run(`combo:${combo}`, () => api(`${VARLIGHTER_BASE}/settings`, { body: settingsBody(view.settings, { combos: next }) }),
      () => { void onChanged(); return on ? `已开启 ${comboLabel(combo)}` : `已关闭 ${comboLabel(combo)}`; });
  };
  return <section className="panel" aria-label="自动配对">
    <div className="panel-heading"><h2>自动配对</h2><span className="muted">两个场所里代码相同的市场自动成对；只在没有组合与手动配对用到某个场所时才停采它</span></div>
    {write.message ? <div className="vl-actions"><Callout tone={write.message.tone}>{write.message.text}</Callout></div> : null}
    <ul className="vl-combos">{combos.map(item => <li key={item.combo}>
      <label><input type="checkbox" checked={item.enabled} disabled={write.busy !== null} onChange={event => toggle(item.combo, event.target.checked)} />{comboLabel(item.combo)}</label>
      <span className="muted">{item.enabled ? `${item.pairs} 对` : '未开启'}</span>
      {write.busy === `combo:${item.combo}` ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : null}
    </li>)}</ul>
    <p className="vl-note">两腿都是行情流（Lighter、Entropy）的配对每 5 秒采一次（未启用、没有持仓的每 20 秒一次），基线按约一分钟抽一个样本；有 Var 一腿的配对跟着每分钟一次的 Var 报价。已启用或有持仓、两腿都是行情流的配对，一档一有变化就判断开平仓，不等采样。</p>
  </section>;
}

const catalogOf = (markets: Record<VenueId, CatalogEntry[]> | null, venue: VenueId) => markets?.[venue] ?? [];
/** 手动配对：任意两个场所、任意两个代码，B 腿价格可乘一个乘数（如一股对十股、不同计价单位）。 */
function PairsPanel({ view, markets, onChanged }: { view: StateView; markets: Record<VenueId, CatalogEntry[]> | null; onChanged: () => Promise<void> }) {
  const write = useWrite();
  const [form, setForm] = useState<CustomPairForm>(EMPTY_PAIR_FORM);
  const pairs = view.settings.pairs ?? [];
  const existing = useMemo(() => [...view.rows.map(row => row.key), ...pairs.map(customPairKey)], [view.rows, pairs]);
  const parsed = customPairRequest(form, existing);
  const rowOf = (pair: CustomPair) => view.rows.find(row => row.key === customPairKey(pair)) ?? null;
  const markOf = (venue: VenueId, symbol: string) => catalogOf(markets, venue).find(item => item.symbol === symbol.trim())?.mark ?? null;
  const aMark = markOf(form.aVenue, form.aSymbol), bMark = markOf(form.bVenue, form.bSymbol);
  const ratio = Number(form.ratio);
  const gap = aMark && bMark && Number.isFinite(ratio) && ratio > 0 ? (aMark / (ratio * bMark) - 1) * 10_000 : null;
  const save = (next: CustomPair[], done: string) => {
    void write.run('pairs', () => api(`${VARLIGHTER_BASE}/settings`, { body: settingsBody(view.settings, { pairs: next }) }), () => { void onChanged(); return done; });
  };
  const add = () => { if (parsed.ok) save([...pairs, parsed.value], `已添加 ${customPairKey(parsed.value)}，目录里两条腿都在时开始采集`); };
  const remove = (pair: CustomPair) => {
    if (!confirm(`删除手动配对 ${customPairKey(pair)}？已采集的样本保留；还启用着或有持仓时须先停用并平仓。`)) return;
    save(pairs.filter(item => customPairKey(item) !== customPairKey(pair)), `已删除 ${customPairKey(pair)}`);
  };
  const set = (patch: Partial<CustomPairForm>) => setForm(current => ({ ...current, ...patch }));
  const leg = (side: 'a' | 'b') => {
    const venue = side === 'a' ? form.aVenue : form.bVenue, symbol = side === 'a' ? form.aSymbol : form.bSymbol, list = catalogOf(markets, venue);
    return <div className="vl-leg">
      <label className="vl-field">{side === 'a' ? 'A 腿场所' : 'B 腿场所'}<select value={venue} onChange={event => set(side === 'a' ? { aVenue: event.target.value as VenueId } : { bVenue: event.target.value as VenueId })}>
        {VENUE_OPTIONS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <label className="vl-field">代码<input value={symbol} list={`vl-catalog-${venue}`} autoComplete="off" spellCheck={false} onChange={event => set(side === 'a' ? { aSymbol: event.target.value } : { bSymbol: event.target.value })} />
        <small>{list.length ? `目录 ${list.length} 个${markOf(venue, symbol) ? `，标记价 ${price(markOf(venue, symbol))}` : symbol.trim() ? '，目录里没有这个代码' : ''}` : '该场所目录未取到'}</small></label>
    </div>;
  };
  return <section className="panel" aria-label="手动配对">
    <div className="panel-heading"><h2>手动配对</h2><span className="muted">{pairs.length} / 100 · 两腿价格差超过 5% 判为规格不同，其余需在下方确认规格后才能启用</span></div>
    {write.message ? <div className="vl-actions"><Callout tone={write.message.tone}>{write.message.text}</Callout></div> : null}
    {VENUE_OPTIONS.map(item => <datalist key={item.id} id={`vl-catalog-${item.id}`}>{catalogOf(markets, item.id).map(entry => <option key={entry.symbol} value={entry.symbol} />)}</datalist>)}
    <div className="vl-pair-form">
      {leg('a')}{leg('b')}
      <label className="vl-field">乘数<input inputMode="decimal" value={form.ratio} onChange={event => set({ ratio: event.target.value })} /><small>A 价 ≈ 乘数 × B 价{gap === null ? '' : `；按当前标记价相差 ${plain(gap, 0)} 基点`}</small></label>
      <label className="vl-field">类别<select value={form.kind} onChange={event => set({ kind: event.target.value as CustomPairForm['kind'] })}>{KIND_OPTIONS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select><small>决定交易时段</small></label>
      <label className="vl-field">备注<input value={form.note} maxLength={80} onChange={event => set({ note: event.target.value })} /></label>
    </div>
    <div className="vl-actions">
      <button type="button" className="button primary" disabled={!parsed.ok || write.busy !== null} onClick={add}>{write.busy === 'pairs' ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}添加</button>
      {!parsed.ok && (form.aSymbol || form.bSymbol) ? <Callout tone="warning" role="status">{parsed.error}</Callout> : null}
    </div>
    {pairs.length ? <div className="vl-table"><table>
      <thead><tr><th>配对</th><th className="num">乘数</th><th>类别</th><th>状态</th><th className="num">两边价格差</th><th>备注</th><th /></tr></thead>
      <tbody>{pairs.map(pair => { const row = rowOf(pair), key = customPairKey(pair); return <tr key={key}>
        <td>{row ? <a className="vl-symbol" href={varLighterHref('detail', key)}>{row.symbol}</a> : <span className="vl-symbol">{pair.a.symbol}{pair.a.symbol === pair.b.symbol ? '' : ` / ${pair.b.symbol}`}</span>}<small>{venueShort(pair.a.venue)} {pair.a.symbol} ↔ {venueShort(pair.b.venue)} {pair.b.symbol}</small></td>
        <td className="num">{pair.ratio}</td>
        <td>{KIND_OPTIONS.find(item => item.id === pair.kind)?.label ?? pair.kind}</td>
        <td>{row ? <Badge tone={row.identity === 'mismatch' ? 'bad' : row.eligible ? 'ok' : 'warn'}>{row.identity === 'review' && row.eligible ? '已确认' : IDENTITY_LABELS[row.identity]}</Badge> : <Badge>目录里缺一腿</Badge>}{row?.enabled ? <Badge tone="ok">已启用</Badge> : null}</td>
        <td className="num">{row ? `${plain(row.gapBps, 0)} 基点` : '—'}</td>
        <td className="wrap">{pair.note || <span className="vl-dim">—</span>}</td>
        <td><button type="button" className="button secondary" aria-label={`删除 ${key}`} disabled={write.busy !== null || !!row?.enabled || !!row?.position} title={row?.enabled || row?.position ? '先停用并平仓' : undefined} onClick={() => remove(pair)}><Trash2 size={14} aria-hidden="true" />删除</button></td>
      </tr>; })}</tbody></table></div> : <TableEmpty>还没有手动配对。例：Var AAPL 对 Entropy AAPL 已是自动配对；不同代码或不同单位的同一资产（如 B 腿每份是 A 的十分之一，乘数填 10）在这里添加</TableEmpty>}
  </section>;
}

function SourcesPanel({ view }: { view: StateView }) {
  const { var: varSource, venues } = view.sources, poll = varSource.poll, now = view.now, live = view.sources.live ?? null;
  // 旧版本服务端没有这一项；预览没接询价时为 null。
  const token = varSource.token ?? null;
  // v0.94.0 起；旧版本服务端没有这一项。
  const push = view.sources.push ?? null;
  return <section className="panel" aria-label="采集状态">
    <div className="panel-heading"><h2>采集状态</h2><span className="muted">服务启动于 {age(view.startedAt, now)} · 场所由组合与手动配对决定</span></div>
    <div className="vl-table"><table><tbody>
      <tr><td>Var 公开报价<small>{varSource.enabled === false ? '没有配对用到' : '每分钟'}</small></td><td className="wrap">{varSource.error ? <span className="vl-down">{varSource.error}</span> : `${age(varSource.ok, now)} · ${varSource.count} 个标的`}
        {poll ? <small>上次：新报价 {poll.fresh}，未变 {poll.unchanged}，无报价 {poll.noQuote}，对手腿无一档 {poll.noTop ?? 0}，写入 {poll.written}，缺判断时刻一档 {poll.noLive ?? 0}{Object.entries(poll.blocked ?? {}).map(([reason, count]) => `；${reason} ${count}`).join('')}</small> : null}
        <small>报价收到时已过去 {varSource.quoteAgeMedianMs === null ? '—' : `${plain(varSource.quoteAgeMedianMs / 1000, 0)} 秒`}（中位数）</small></td></tr>
      <tr><td>行情流配对<small>两腿都是行情流</small></td><td className="wrap">{live ? `上次 ${age(live.at, now)}：到期 ${live.due}，写入 ${live.written}，缺一档 ${live.noTop}` : '还没有采样'}
        {live && Object.keys(live.blocked).length ? <small>{Object.entries(live.blocked).map(([reason, count]) => `${reason} ${count}`).join('；')}</small> : null}
        {push ? <small>按推送判断（启动以来）：{push.checks.toLocaleString('zh-CN')} 次，成交 {push.trades} 次{push.lastTradeAt === null ? '' : `，最近 ${age(push.lastTradeAt, now)}`}{push.lastBlocked ? `；最近被挡：${push.lastBlocked.symbol} ${push.lastBlocked.reason}（${age(push.lastBlocked.at, now)}）` : ''}</small> : null}</td></tr>
      {token ? <tr><td>Var token 询价</td><td className="wrap">{token.status === 'ready' ? token.statusName : <span className="vl-down">{token.statusName}</span>}
        {token.okAt === null ? ' · 还没有成功过' : ` · 最近成功 ${age(token.okAt, now)}${token.lagMs === null ? '' : `，收到时距 Var 报价时刻 ${plain(token.lagMs / 1000, 1)} 秒`}`}
        {poll ? <small>上次：成功 {poll.tokenOk ?? 0}，失败 {poll.tokenFailed ?? 0}，未询 {poll.tokenSkipped ?? 0}{token.expiresAt === null ? '' : `；token 到期 ${new Date(token.expiresAt).toLocaleString('zh-CN', { hour12: false })}`}</small> : null}
        {token.error ? <small className="vl-down">{token.error}</small> : null}
        {token.status === 'ready' ? null : <small>token 在「行情监控 → 原油」页的 Var token 表单里保存；没有可用 token 时开平仓只按公开报价。</small>}</td></tr> : null}
      {venues.map(status => <VenueRow key={status.venue} status={status} now={now} />)}
    </tbody></table></div>
    <p className="vl-note">Lighter 与 Entropy 的行情全部走 WebSocket：Lighter 订阅全部市场的一档价、标记价与资金费，Entropy 只订阅配对用到的市场（bbo 一档，长时间无变化时用 l2Book 确认；activeAssetCtx 标记价、预言机价与资金费）；已启用或有持仓的配对的腿另订阅完整盘口（Lighter order_book、Entropy l2Book），每个场所最多 10 条腿。目录每 10 分钟取一次，只用于规格与手续费。流量按解码后的文本折算（线上有压缩）。有可用的 Var token 时带 Var 腿的同一批配对各询一次价。</p>
  </section>;
}

function VenueRow({ status, now }: { status: VenueStatus; now: number }) {
  const stream = status.stream, catalog = status.catalog;
  return <tr>
    <td>{status.name}<small>{status.enabled ? `${status.pairs} 个配对` : '没有配对用到'}</small></td>
    <td className="wrap">{!status.enabled ? <><span className="vl-dim">未连接行情流</span><small>目录：{catalog.error ? <span className="vl-down">{catalog.error}</span> : `${age(catalog.ok, now)} · ${catalog.count} 个市场（供手动配对选择）`}</small></> : <>
      {stream?.connected ? `行情流已连接 ${age(stream.connectedAt, now)}` : <span className="vl-down">行情流未连接{stream?.lastError ? `：${stream.lastError}` : ''}</span>}
      {stream ? <small>最后消息 {age(stream.lastMessageAt, now)} · 重连 {stream.reconnects} 次 · {stream.markets} 个市场 · 约 {bytesPerDay(stream.bytes, stream.bytesSince, now)}</small> : null}
      <small>目录：{catalog.error ? <span className="vl-down">{catalog.error}</span> : `${age(catalog.ok, now)} · ${catalog.count} 个市场`}</small>
      <small>盘口：{status.depth.length ? status.depth.map(item => `${item.key.split(':')[1]} ${item.error ? `未同步（${item.error}）` : item.at ? '已同步' : '等待中'}`).join('，') : '没有启用的配对或持仓，不订阅'}</small>
    </>}</td>
  </tr>;
}

function IdentityPanel({ view, onChanged }: { view: StateView; onChanged: () => Promise<void> }) {
  const write = useWrite();
  const rows = view.rows.filter(row => row.identity !== 'verified');
  const confirmed = view.settings.confirmed;
  const toggle = (row: StateView['rows'][number], on: boolean) => {
    const label = `${row.symbol}（${venueShort(row.a.venue)}↔${venueShort(row.b.venue)}）`;
    void write.run(`confirm:${row.key}`, () => api(`${VARLIGHTER_BASE}/settings`, { body: settingsBody(view.settings, { confirmed: toggleConfirmed(confirmed, row.key, on) }) }), () => { void onChanged(); return on ? `${label} 已确认两边规格相同` : `${label} 已撤销确认`; });
  };
  return <section className="panel" aria-label="规格核对">
    <div className="panel-heading"><h2>规格核对</h2><span className="muted">已核对的配对不列出；待确认的按配对分别确认，确认后才能启用模拟盘</span></div>
    {write.message ? <div className="vl-actions"><Callout tone={write.message.tone}>{write.message.text}</Callout></div> : null}
    {rows.length ? <div className="vl-table"><table>
      <thead><tr><th>标的</th><th>两腿</th><th>类别</th><th>状态</th><th className="num">两边价格差</th><th>说明</th><th /></tr></thead>
      <tbody>{rows.map(row => { const on = confirmed.includes(row.key); return <tr key={row.key}>
        <td><a className="vl-symbol" href={varLighterHref('detail', row.key)}>{row.symbol}</a><small>{row.name}</small></td>
        <td>{venueShort(row.a.venue)} ↔ {venueShort(row.b.venue)}{row.custom ? <small>手动配对</small> : null}</td>
        <td>{row.kindName}</td>
        <td><Badge tone={row.identity === 'mismatch' ? 'bad' : on ? 'ok' : 'warn'}>{row.identity === 'review' && on ? '已确认' : IDENTITY_LABELS[row.identity]}</Badge></td>
        <td className="num">{plain(row.gapBps, 0)} 基点</td>
        <td className="wrap">{row.identity === 'mismatch' ? '两边价格相差超过 5%，可能是同名不同物或报价单位不同，不能交易' : row.custom ? '手动配对，先到两边官网核对合约说明与乘数' : row.a.symbol !== row.b.symbol ? '代码别名（两边代码不同、按同一标的自动配对），先到两边官网核对计价单位' : '同名但不在已核对清单（未上市、小市值、可能重名，或 Entropy 不是每股合约），先到两边官网核对合约说明'}</td>
        <td>{row.identity === 'review' ? <button type="button" className="button secondary" disabled={write.busy !== null || (on && row.enabled)} title={on && row.enabled ? '先停用该标的再撤销' : undefined} onClick={() => toggle(row, !on)}>{on ? '撤销确认' : '确认规格相同'}</button> : null}</td>
      </tr>; })}</tbody></table></div> : <TableEmpty>所有配对的规格都已核对</TableEmpty>}
  </section>;
}
