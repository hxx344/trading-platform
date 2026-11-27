// 实盘（docs/dexspread.md 第 13 节）：按场所录入下单凭据、实盘总开关与配对、限额、实盘持仓与成交。
// 凭据只往服务器写、不回读：页面只知道每个场所「已录入」与否，输入框提交后立即清空。
import { useEffect, useRef, useState } from 'react';
import { KeyRound, LoaderCircle, Play, Save, Trash2, X } from 'lucide-react';
import { api } from '../api.ts';
import { useDialogGuard } from '../AppDialog.tsx';
import { Callout, StatePanel, TableEmpty } from '../StateViews.tsx';
import { useLiveResource } from '../use-live-resource.ts';
import type { LiveLimits, LivePosition, LiveState } from '../../../src/varlighter/live.ts';
import type { LiveView } from '../../../src/varlighter/views.ts';
import { Badge, Metric, stampText, useWrite } from './parts.tsx';
import { VARLIGHTER_BASE, directionLabel, duration, pairLabel, percent, price, signedUsd, tone, usd, varLighterHref, venueShort } from './varlighter-form.ts';

const LIVE_PATH = `${VARLIGHTER_BASE}/live`;
type KeyVenue = 'lighter' | 'rh' | 'entropy';
const KEY_FIELDS: Record<KeyVenue, { title: string; hint: string; fields: { key: string; label: string; secret?: boolean; hint?: string }[] }> = {
  lighter: { title: 'Lighter 主网', hint: '在 Lighter 主网的 API 密钥页新建一把 API 密钥，填它的编号与私钥。', fields: [
    { key: 'accountIndex', label: '账户编号' }, { key: 'apiKeyIndex', label: 'API 密钥编号', hint: '4 到 254' }, { key: 'privateKey', label: 'API 私钥', secret: true, hint: '80 位十六进制' }] },
  rh: { title: 'Lighter RH', hint: 'RH 链是另一套账户与密钥，要在 RH 上单独新建。', fields: [
    { key: 'accountIndex', label: '账户编号' }, { key: 'apiKeyIndex', label: 'API 密钥编号', hint: '4 到 254，157 保留' }, { key: 'privateKey', label: 'API 私钥', secret: true, hint: '80 位十六进制' }] },
  entropy: { title: 'Entropy（Hyperliquid）', hint: '在 Hyperliquid 的 API 页生成 API 钱包并授权，填主账户地址与 API 钱包的私钥。', fields: [
    { key: 'address', label: '主账户地址', hint: '0x 开头，40 位十六进制' }, { key: 'privateKey', label: 'API 钱包私钥', secret: true, hint: '64 位十六进制；不是主钱包私钥' }] },
};
const KEY_VENUES = ['lighter', 'rh', 'entropy'] as const;
const STATE_TEXT: Record<LiveState, string> = { opening: '开仓中', open: '持仓中', closing: '平仓中', stuck: '需要人工处理', closed: '已结束' };
const STATE_TONE: Record<LiveState, 'ok' | 'warn' | 'bad' | 'info' | ''> = { opening: 'info', open: 'ok', closing: 'info', stuck: 'bad', closed: '' };
const LIMIT_FIELDS: { key: keyof LiveLimits; label: string; hint: string }[] = [
  { key: 'perTradeUsd', label: '单笔名义（美元）', hint: '实盘每笔取它与模拟盘名义中较小的一个' },
  { key: 'maxOpen', label: '同时持仓（笔）', hint: '到上限后不再跟新的开仓' },
  { key: 'dailyLossUsd', label: '当日亏损上限（美元）', hint: 'UTC 日内已实现亏损到这个数就不再开仓' },
  { key: 'slippageBps', label: '限价保护（基点）', hint: '两腿开仓 IOC 限价离预期价最多这么远' },
];
const legQty = (position: LivePosition, leg: 'a' | 'b') => { const item = position[leg]; return Math.max(0, item.qty - item.exitQty); };
const avg = (quote: number, qty: number) => qty > 0 ? quote / qty : null;

export function VarLighterLive({ onExpired }: { onExpired: () => void }) {
  const live = useLiveResource<LiveView>(LIVE_PATH, { intervalMs: 5_000, timeoutMs: 15_000, onExpired });
  const data = live.data;
  if (!data) return <section className="panel" aria-label="实盘">
    <div className="panel-heading"><h2>实盘</h2></div>
    {live.error ? <StatePanel kind="error" title="读取实盘状态失败" detail={live.error.message} /> : <StatePanel kind="loading" title="加载中…" />}
  </section>;
  const refresh = async () => { await live.refresh(); };
  return <>
    {data.halt ? <ResumeBar view={data} onChanged={refresh} /> : null}
    <SwitchPanel view={data} onChanged={refresh} />
    <KeysPanel view={data} onChanged={refresh} />
    <PositionsPanel view={data} onChanged={refresh} />
    <TradesPanel view={data} />
  </>;
}

function ResumeBar({ view, onChanged }: { view: LiveView; onChanged: () => Promise<void> }) {
  const dialog = useDialogGuard();
  const haltRef = useRef(view.halt);
  haltRef.current = view.halt;
  const write = useWrite();
  const writeBusyRef = useRef(write.busy);
  writeBusyRef.current = write.busy;
  const resume = async () => {
    if (writeBusyRef.current !== null || !haltRef.current) return;
    if (!await dialog.confirm('确认已在交易所核对过账户持仓，恢复实盘开仓？', { title: '恢复实盘开仓', confirmLabel: '确认恢复', tone: 'danger' })) return;
    if (!dialog.isAlive() || writeBusyRef.current !== null || !haltRef.current) return;
    void write.run('resume', () => api(`${LIVE_PATH}/resume`, { body: {} }), () => { void onChanged(); return '实盘已恢复'; });
  };
  return <Callout tone="error">实盘已停止，不再开新仓：{view.halt}
    <div className="vl-live-inline"><button type="button" className="button secondary" disabled={write.busy !== null} onClick={() => void resume()}>{write.busy ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}核对后恢复</button>
      {write.message ? <span className={write.message.tone === 'success' ? 'muted' : 'vl-down'}>{write.message.text}</span> : null}</div>
  </Callout>;
}

/** 总开关、实盘配对与限额：一起保存。 */
function SwitchPanel({ view, onChanged }: { view: LiveView; onChanged: () => Promise<void> }) {
  const dialog = useDialogGuard();
  const write = useWrite();
  const saved = view.settings;
  const savedText = JSON.stringify(saved);
  const [pairs, setPairs] = useState<string[]>(saved.pairs);
  const [limits, setLimits] = useState<Record<keyof LiveLimits, string>>(() => limitsForm(saved.limits));
  const [base, setBase] = useState(savedText);
  // 服务端的设置变了（别处保存、或本次保存成功）时用新值重填。
  useEffect(() => { if (savedText !== base) { setPairs(saved.pairs); setLimits(limitsForm(saved.limits)); setBase(savedText); } }, [savedText, base, saved]);
  const parsed = parseLimits(limits);
  const pairsRef = useRef(pairs);
  pairsRef.current = pairs;
  const parsedRef = useRef(parsed);
  parsedRef.current = parsed;
  const savedOnRef = useRef(saved.on);
  savedOnRef.current = saved.on;
  const writeBusyRef = useRef(write.busy);
  writeBusyRef.current = write.busy;
  const known = new Set(view.candidates.map(item => item.key));
  const gone = pairs.filter(key => !known.has(key));
  const dirty = JSON.stringify([...pairs].sort()) !== JSON.stringify(saved.pairs) || (parsed.ok && JSON.stringify(parsed.value) !== JSON.stringify(saved.limits)) || !parsed.ok;
  const missing = (key: string) => { const item = view.candidates.find(row => row.key === key); return item ? [item.a.venue, item.b.venue].filter(venue => !view.keys[venue as KeyVenue]) : []; };
  // 总开关只在点「打开实盘」「关闭实盘」时才提交；保存配对与限额不带它，免得用几秒前的视图把别处刚改的开关改回去。
  const send = (body: Record<string, unknown>, done: string) => { void write.run('settings', () => api(`${LIVE_PATH}/settings`, { body }), () => { void onChanged(); return done; }); };
  const save = (done: string) => { if (parsed.ok) send({ pairs, limits: parsed.value }, done); };
  const turnOn = async () => {
    if (!pairs.length || !parsed.ok || writeBusyRef.current !== null) return;
    const confirmedPairs = [...pairs];
    const confirmedLimits = parsed.value;
    const samePairs = (a: readonly string[], b: readonly string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
    const lines = confirmedPairs.map(key => `${pairLabel(key).symbol}（${pairLabel(key).short}）`).join('、');
    if (!await dialog.confirm(`打开实盘？打开后，下列配对的模拟盘每次开仓，都会在两个交易所下真实订单：${lines}。单笔不超过 ${limits.perTradeUsd} 美元，同时不超过 ${limits.maxOpen} 笔。`, { title: '确认打开实盘', confirmLabel: '确认打开', tone: 'danger' })) return;
    if (!dialog.isAlive() || writeBusyRef.current !== null || savedOnRef.current) return;
    const latestPairs = pairsRef.current, latestParsed = parsedRef.current;
    if (!latestParsed.ok || !samePairs(latestPairs, confirmedPairs) || JSON.stringify(latestParsed.value) !== JSON.stringify(confirmedLimits)) {
      void dialog.alert('实盘配对或限额在确认期间已更新，已取消打开，请核对后再试', { title: '配置已变更', tone: 'warning' });
      return;
    }
    send({ on: true, pairs: confirmedPairs, limits: confirmedLimits }, '实盘已打开：跟随模拟盘信号下真实订单');
  };
  return <section className="panel" aria-label="实盘开关">
    <div className="panel-heading"><h2>实盘</h2><span className="muted">跟随模拟盘：模拟盘在勾选的配对上开仓、平仓时，两个交易所同步下真实订单 · <a href={varLighterHref('accounts')}>查看各场所账户资产与成交 →</a></span></div>
    <div className="vl-actions vl-pause">
      {saved.on ? view.halt ? <Badge tone="bad">已停止</Badge> : <Badge tone="ok">实盘运行中</Badge> : <Badge tone="warn">实盘关闭</Badge>}
      {saved.on
        ? <button type="button" className="button secondary" disabled={write.busy !== null} onClick={() => send({ on: false }, '实盘已关闭：不再开新仓，已有实盘持仓仍会跟随模拟盘平仓')}>关闭实盘</button>
        : <button type="button" className="button primary" disabled={write.busy !== null || !parsed.ok || !pairs.length} onClick={() => void turnOn()}><Play size={14} aria-hidden="true" />打开实盘</button>}
      <span className="muted">{saved.on ? '关闭只停开新仓，已有实盘持仓照常跟随平仓' : pairs.length ? '打开前先确认两边账户有足够保证金' : '先在下面勾选实盘配对'}</span>
    </div>
    <section className="vl-metrics" aria-label="实盘汇总">
      <Metric label="实盘累计净盈亏" value={signedUsd(view.totals.netUsd)} tone={tone(view.totals.netUsd)} foot={`${view.totals.trades} 笔，胜率 ${view.totals.trades ? percent(view.totals.wins / view.totals.trades) : '—'}`} />
      <Metric label="今日（UTC）" value={signedUsd(view.todayNetUsd)} tone={tone(view.todayNetUsd)} foot={`亏损上限 ${usd(saved.limits.dailyLossUsd, 0)}`} />
      <Metric label="实盘持仓" value={`${view.positions.length} / ${saved.limits.maxOpen} 笔`} foot={`单笔 ≤ ${usd(saved.limits.perTradeUsd, 0)}`} />
    </section>
    {view.lastSkip ? <p className="vl-note">最近一次没有跟单：{stampText(view.lastSkip.at)} {pairLabel(view.lastSkip.symbol).symbol}（{pairLabel(view.lastSkip.symbol).short}），{view.lastSkip.reason}</p> : null}
    <h3 className="vl-live-sub">实盘配对</h3>
    {view.candidates.length ? <ul className="vl-combos">{view.candidates.map(item => { const lack = missing(item.key), paused = view.paused[item.key]; return <li key={item.key}>
      <label><input type="checkbox" checked={pairs.includes(item.key)} disabled={write.busy !== null} onChange={event => setPairs(list => event.target.checked ? [...list, item.key] : list.filter(key => key !== item.key))} />
        <a className="vl-symbol" href={varLighterHref('detail', item.key)}>{item.symbol}</a> {venueShort(item.a.venue)}↔{venueShort(item.b.venue)}</label>
      <span className="muted">{paused ? `已暂停：${paused}` : lack.length ? `缺凭据：${lack.map(venue => view.venueNames[venue]).join('、')}` : item.paper ? '模拟盘已启用' : '模拟盘未启用，不会有信号'}</span>
    </li>; })}</ul> : <TableEmpty>没有两腿都能下单的配对。实盘只做 Lighter 主网、Lighter RH、Entropy 之间的配对，带 Var 腿的不上实盘；在下面「自动配对」里开启这些场所的组合。</TableEmpty>}
    {gone.length ? <p className="vl-note err">已勾选但目录里已经没有的配对：{gone.join('、')} <button type="button" className="button secondary" onClick={() => setPairs(list => list.filter(key => known.has(key)))}>去掉</button></p> : null}
    <h3 className="vl-live-sub">限额</h3>
    <div className="vl-fields">
      {LIMIT_FIELDS.map(field => <label className="vl-field" key={field.key}>{field.label}
        <input inputMode="decimal" value={limits[field.key]} onChange={event => setLimits(value => ({ ...value, [field.key]: event.target.value }))} /><small>{field.hint}</small></label>)}
    </div>
    <div className="vl-actions">
      <button type="button" className="button primary" disabled={!parsed.ok || !dirty || write.busy !== null} onClick={() => save('实盘配对与限额已保存')}>{write.busy === 'settings' ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Save size={14} aria-hidden="true" />}保存配对与限额</button>
      {!parsed.ok ? <Callout tone="warning" role="status">{parsed.error}</Callout> : null}
      {write.message ? <Callout tone={write.message.tone}>{write.message.text}</Callout> : null}
    </div>
    <p className="vl-note">实盘只用专门的账户：这些账户上不要手动开仓，也不要让别的程序交易，否则持仓对不上会自动停止。第二腿没成交时，第一腿多出的部分会立即反向平掉（记一次单腿）；同一配对连续两次单腿会暂停该配对。</p>
  </section>;
}
const limitsForm = (limits: LiveLimits): Record<keyof LiveLimits, string> => ({ perTradeUsd: String(limits.perTradeUsd), maxOpen: String(limits.maxOpen), dailyLossUsd: String(limits.dailyLossUsd), slippageBps: String(limits.slippageBps) });
function parseLimits(form: Record<keyof LiveLimits, string>): { ok: true; value: LiveLimits } | { ok: false; error: string } {
  const value = {} as LiveLimits;
  for (const field of LIMIT_FIELDS) {
    const text = form[field.key].trim(), number = Number(text);
    if (!text || !Number.isFinite(number) || number <= 0) return { ok: false, error: `${field.label}须为正数` };
    if (field.key === 'maxOpen' && !Number.isInteger(number)) return { ok: false, error: `${field.label}须为整数` };
    value[field.key] = number;
  }
  return { ok: true, value };
}

/** 各场所的下单凭据：只写不读，提交后清空输入框。 */
function KeysPanel({ view, onChanged }: { view: LiveView; onChanged: () => Promise<void> }) {
  return <section className="panel" aria-label="下单凭据">
    <div className="panel-heading"><h2>下单凭据</h2><span className="muted">保存在服务器上只有 DEX 价差服务能读的文件里；页面与接口都不回显</span></div>
    <div className="vl-actions vl-pause"><Callout tone="warning">只填交易所的 API 密钥私钥或 API 钱包私钥（只能交易、不能提币）。不要填主钱包私钥或助记词。请通过 HTTPS 或可信网络打开本页再录入。</Callout>
      {view.keysProblem ? <Callout tone="error">{view.keysProblem}</Callout> : null}
      {view.signerProblem ? <Callout tone="warning">Lighter 签名器不可用：{view.signerProblem}。两条 Lighter 链暂时下不了单，Entropy 不受影响。</Callout> : null}</div>
    <div className="vl-live-keys">{KEY_VENUES.map(venue => <KeyForm key={venue} venue={venue} configured={view.keys[venue]} onChanged={onChanged} />)}</div>
  </section>;
}
function KeyForm({ venue, configured, onChanged }: { venue: KeyVenue; configured: boolean; onChanged: () => Promise<void> }) {
  const dialog = useDialogGuard();
  const configuredRef = useRef(configured);
  configuredRef.current = configured;
  const spec = KEY_FIELDS[venue];
  const empty = Object.fromEntries(spec.fields.map(field => [field.key, ''])) as Record<string, string>;
  const [form, setForm] = useState(empty);
  const write = useWrite();
  const writeBusyRef = useRef(write.busy);
  writeBusyRef.current = write.busy;
  const filled = spec.fields.every(field => form[field.key]!.trim());
  const submit = () => {
    const body = { venue, ...Object.fromEntries(spec.fields.map(field => [field.key, form[field.key]!.trim()])) };
    // 无论成败都清掉私钥输入框。
    setForm(value => ({ ...value, privateKey: '' }));
    void write.run('set', () => api(`${LIVE_PATH}/keys`, { body }), () => { setForm(empty); void onChanged(); return `${spec.title} 的凭据已保存`; });
  };
  const remove = async () => {
    if (writeBusyRef.current !== null || !configuredRef.current) return;
    if (!await dialog.confirm(`移除 ${spec.title} 的下单凭据？移除后这个场所不能再下单。`, { title: '移除下单凭据', confirmLabel: '确认移除', tone: 'danger' })) return;
    if (!dialog.isAlive() || writeBusyRef.current !== null || !configuredRef.current) return;
    void write.run('remove', () => api(`${LIVE_PATH}/keys/remove`, { body: { venue } }), () => { void onChanged(); return `${spec.title} 的凭据已移除`; });
  };
  return <form className="vl-live-key" autoComplete="off" onSubmit={event => { event.preventDefault(); if (filled && write.busy === null) submit(); }}>
    <div className="vl-live-keyhead"><strong>{spec.title}</strong>{configured ? <Badge tone="ok">已录入</Badge> : <Badge>未录入</Badge>}</div>
    <small>{spec.hint}</small>
    {spec.fields.map(field => <label className="vl-field" key={field.key}>{field.label}
      <input type={field.secret ? 'password' : 'text'} autoComplete={field.secret ? 'new-password' : 'off'} spellCheck={false} value={form[field.key]} placeholder={configured ? '已录入，重新填写即替换' : ''}
        onChange={event => setForm(value => ({ ...value, [field.key]: event.target.value }))} />{field.hint ? <small>{field.hint}</small> : null}</label>)}
    <div className="vl-live-inline">
      <button type="submit" className="button primary" disabled={!filled || write.busy !== null}>{write.busy === 'set' ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <KeyRound size={14} aria-hidden="true" />}{configured ? '替换' : '保存'}</button>
      {configured ? <button type="button" className="button secondary" disabled={write.busy !== null} onClick={() => void remove()}><Trash2 size={14} aria-hidden="true" />移除</button> : null}
    </div>
    {write.message ? <Callout tone={write.message.tone}>{write.message.text}</Callout> : null}
  </form>;
}

function PositionsPanel({ view, onChanged }: { view: LiveView; onChanged: () => Promise<void> }) {
  const dialog = useDialogGuard();
  const positionsRef = useRef(view.positions);
  positionsRef.current = view.positions;
  const write = useWrite();
  const writeBusyRef = useRef(write.busy);
  writeBusyRef.current = write.busy;
  const close = async (position: LivePosition) => {
    if (writeBusyRef.current !== null || position.state !== 'open') return;
    if (!await dialog.confirm(`在两个交易所平掉 ${pairLabel(position.symbol).symbol}（${pairLabel(position.symbol).short}）的实盘持仓？`, { title: '平掉实盘持仓', confirmLabel: '确认平仓', tone: 'danger' })) return;
    if (!dialog.isAlive() || writeBusyRef.current !== null || !positionsRef.current.some(item => item.id === position.id && item.state === 'open')) return;
    void write.run(`close:${position.id}`, () => api(`${LIVE_PATH}/close`, { body: { id: position.id } }), () => { void onChanged(); return '已开始平仓，结果见下方'; });
  };
  const dismiss = (position: LivePosition) => {
    const text = prompt('这一步不发任何订单，只把这笔记录标记为已结束。请先在两个交易所把剩余持仓手动处理干净，然后输入 DISMISS 确认：');
    if (text === null) return;
    void write.run(`dismiss:${position.id}`, () => api(`${LIVE_PATH}/dismiss`, { body: { id: position.id, confirm: text.trim() } }), () => { void onChanged(); return '已标记为结束'; });
  };
  return <section className="panel" aria-label="实盘持仓">
    <div className="panel-heading"><h2>实盘持仓</h2><span className="muted">数量与均价来自交易所的成交回报</span></div>
    {write.message ? <div className="vl-actions vl-pause"><Callout tone={write.message.tone}>{write.message.text}</Callout></div> : null}
    {view.positions.length ? <div className="vl-table"><table>
      <thead><tr><th>标的 · 方向</th><th>状态</th><th className="num">A 腿 数量 @ 均价</th><th className="num">B 腿 数量 @ 均价</th><th className="num">持有</th><th>说明</th><th /></tr></thead>
      <tbody>{view.positions.map(position => { const label = pairLabel(position.symbol); return <tr key={position.id}>
        <td><a className="vl-symbol" href={varLighterHref('detail', position.symbol)}>{label.symbol}</a><small>{label.short} · {directionLabel(position.direction, label.a, label.b)}</small></td>
        <td><Badge tone={STATE_TONE[position.state]}>{STATE_TEXT[position.state]}</Badge>{position.pending ? <small>有一笔订单在确认结果</small> : null}</td>
        <td className="num">{price(legQty(position, 'a'))} @ {price(avg(position.a.entryQuote, position.a.qty))}<small>{view.venueNames[position.a.venue]} {position.a.side === 'buy' ? '多' : '空'}{position.a.estimated ? ' · 估' : ''}</small></td>
        <td className="num">{price(legQty(position, 'b'))} @ {price(avg(position.b.entryQuote, position.b.qty))}<small>{view.venueNames[position.b.venue]} {position.b.side === 'buy' ? '多' : '空'}{position.b.estimated ? ' · 估' : ''}</small></td>
        <td className="num">{duration(view.now - position.openedAt)}</td>
        <td className="wrap">{position.note || '—'}</td>
        <td>{position.state === 'open' ? <button type="button" className="button secondary" disabled={write.busy !== null} onClick={() => void close(position)}>{write.busy === `close:${position.id}` ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <X size={14} aria-hidden="true" />}平仓</button>
          : position.state === 'stuck' ? <button type="button" className="button secondary" disabled={write.busy !== null} onClick={() => dismiss(position)}>已人工处理</button> : null}</td>
      </tr>; })}</tbody></table></div> : <TableEmpty>{view.settings.on ? '没有实盘持仓，等待模拟盘在勾选的配对上开仓' : '实盘关闭，没有实盘持仓'}</TableEmpty>}
  </section>;
}

function TradesPanel({ view }: { view: LiveView }) {
  return <div className="vl-columns">
    <section className="panel" aria-label="实盘成交">
      <div className="panel-heading"><h2>实盘成交</h2><span className="muted">最近 {view.trades.length} 笔，净盈亏已扣手续费</span></div>
      {view.trades.length ? <div className="vl-table"><table>
        <thead><tr><th>标的 · 方向</th><th>结束</th><th className="num">A 开 / 平</th><th className="num">B 开 / 平</th><th className="num">净盈亏</th><th>原因</th></tr></thead>
        <tbody>{view.trades.map(trade => { const label = pairLabel(trade.symbol); return <tr key={trade.id}>
          <td>{label.symbol}<small>{label.short} · {directionLabel(trade.direction, label.a, label.b)}{trade.singleLeg ? ' · 单腿' : ''}</small></td>
          <td>{trade.closedAt ? stampText(trade.closedAt) : '—'}<small>持有 {duration((trade.closedAt ?? trade.updatedAt) - trade.openedAt)}</small></td>
          <td className="num">{price(avg(trade.a.entryQuote, trade.a.qty))} / {price(avg(trade.a.exitQuote, trade.a.exitQty))}<small>{price(trade.a.qty)}</small></td>
          <td className="num">{price(avg(trade.b.entryQuote, trade.b.qty))} / {price(avg(trade.b.exitQuote, trade.b.exitQty))}<small>{price(trade.b.qty)}</small></td>
          <td className={`num vl-${tone(trade.netUsd) || 'dim'}`}>{signedUsd(trade.netUsd)}{trade.a.estimated || trade.b.estimated ? <small>含估算价</small> : null}</td>
          <td className="wrap">{trade.closeReason ?? '—'}{trade.note ? <small>{trade.note}</small> : null}</td>
        </tr>; })}</tbody></table></div> : <TableEmpty>还没有实盘成交</TableEmpty>}
    </section>
    <section className="panel" aria-label="实盘事件">
      <div className="panel-heading"><h2>实盘事件</h2><span className="muted">最近 {view.events.length} 条</span></div>
      {view.events.length ? <ul className="vl-events">{view.events.map(event => <li key={event.id}><time>{stampText(event.at)}</time><span><b>{event.symbol ? `${pairLabel(event.symbol).symbol} ${pairLabel(event.symbol).short}` : '全局'}</b>{event.message}</span></li>)}</ul> : <TableEmpty>暂无事件</TableEmpty>}
    </section>
  </div>;
}
