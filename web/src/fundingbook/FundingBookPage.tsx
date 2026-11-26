// 资金费组合页（#/fundingbook，docs/fundingbook.md 第 7 节、docs/frontend.md《资金费组合页》）。多所多账户的资金费
// 套利组合：按每条腿的已结算资金费与各标的的波动、相关性求目标仓位，给出从当前仓位走过去的步骤，并记模拟盘。
// 第一期不读账户、不下单。工作台没有对应页面，骨架与部件沿用 Var/Lighter 价差页（wb-heading、panel、callout、vl-*）。
import '../varlighter/varlighter.css';
import './fundingbook.css';
import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Play, Plus, RotateCcw, Save, Trash2 } from 'lucide-react';
import { api } from '../api.ts';
import { Callout, StatePanel, TableEmpty } from '../StateViews.tsx';
import { useLiveResource } from '../use-live-resource.ts';
import { Badge, EquityChart, Metric, useWrite } from '../varlighter/parts.tsx';
import type { RoundView, StateView } from '../../../src/fundingbook/views.ts';
import {
  FUNDINGBOOK_BASE, FUNDINGBOOK_TABS, SETTING_FIELDS, SETTING_GROUPS, fundingBookHref, multiple, newAccount, notice, parseState, percent, price, quantity, resetConfirmText,
  settingsChanged, settingsForm, settingsRequest, signedUsd, stamp, stepText, tone, usd, type FundingBookTab, type SettingsForm, venueDefaults,
} from './fundingbook-form.ts';

const STATE_PATH = `${FUNDINGBOOK_BASE}/state`;
type Write = ReturnType<typeof useWrite>;
type Changed = () => Promise<void>;

export function FundingBookPage({ tab, onExpired }: { tab: FundingBookTab; onExpired: () => void }) {
  const live = useLiveResource<StateView>(STATE_PATH, { intervalMs: 5_000, timeoutMs: 10_000, parse: parseState, onExpired });
  const { data, error, status, receivedAt } = live;
  const write = useWrite();
  const hint = data ? notice(data) : null;
  return <div className="vl-page" data-fundingbook>
    <header className="wb-heading"><div><h1>资金费组合</h1>
      <p>多所多账户的资金费套利组合：在资金费高的账户做空、低的账户做多，同一标的各账户合计为零；每个账户留足安全距离，相关的标的互相对冲以腾出额度。现在只做规划与模拟盘，不读账户、不下单。</p></div>
      {data ? <Chips view={data} /> : null}</header>
    {data ? <nav className="vl-tabs" aria-label="资金费组合页签">
      {FUNDINGBOOK_TABS.map(item => <a key={item.id} href={fundingBookHref(item.id)} aria-current={tab === item.id ? 'page' : undefined}>{item.label}</a>)}
    </nav> : null}
    {error && data ? <p className="vl-note err" role="status">刷新失败：{error.message}（数据停留在 {receivedAt ? new Date(receivedAt).toLocaleTimeString() : '—'}）</p> : null}
    {write.message ? <Callout tone={write.message.tone} action={{ label: '知道了', onClick: write.clear }}>{write.message.text}</Callout> : null}
    {hint && tab !== 'settings' ? <Callout tone={hint.tone}>{hint.text}</Callout> : null}
    {!data
      ? status === 'error' || status === 'offline' ? <StatePanel kind="error" title="读取资金费组合模块失败" detail={error?.message ?? '网络离线'} /> : <StatePanel kind="loading" title="加载中…" />
      : tab === 'overview' ? <Overview view={data} />
        : tab === 'plan' ? <PlanTab view={data} write={write} onChanged={live.refresh} onExpired={onExpired} />
          : tab === 'paper' ? <PaperTab view={data} write={write} onChanged={live.refresh} />
            : <SettingsTab view={data} write={write} onChanged={live.refresh} />}
  </div>;
}

function Chips({ view }: { view: StateView }) {
  const collecting = view.collect.total > 0 && view.collect.done < view.collect.total;
  return <div className="vl-sources" aria-label="运行状态">
    <span className={`vl-chip ${view.settings.enabled ? 'ok' : ''}`}><i />{view.settings.enabled ? '模拟盘运行中' : '未启用'}</span>
    <span className={`vl-chip ${view.running ? 'ok' : 'warn'}`}><i />{view.running ? '行情在线' : '合约价差监控未运行'}</span>
    {view.settings.enabled && view.running ? <span className={`vl-chip ${view.collect.errors.length ? 'warn' : collecting ? '' : 'ok'}`} title={view.collect.errors.join('\n') || undefined}><i />历史 {view.collect.done} / {view.collect.total}</span> : null}
    {view.solving ? <span className="vl-chip"><i />求解中</span> : null}
  </div>;
}

function Overview({ view }: { view: StateView }) {
  const round = view.round, book = view.book;
  const profit = book && book.equity !== null ? book.equity - book.initialCapital : null;
  return <>
    <section className="vl-metrics" aria-label="组合">
      <Metric label="模拟盘权益" value={usd(book?.equity, 2)} tone={tone(profit)} foot={book ? `本金 ${usd(book.initialCapital)} · 盈亏 ${signedUsd(profit)}` : '还没有模拟盘'} />
      <Metric label="预期年化（调整均值）" value={percent(round?.expectedApr)} tone={tone(round?.expectedApr)} foot={round ? `按短窗口 ${percent(round.optimisticApr)} · 相对权益，不含成本` : '第一轮规划后给出'} />
      <Metric label="持仓名义合计" value={usd(round?.gross)} foot={round ? `权益的 ${round.capital > 0 ? (round.gross / round.capital).toFixed(2) : '—'} 倍 · 上限 ${view.settings.maxGrossLeverage} 倍` : undefined} />
      <Metric label="所需资金" value={usd(round?.required)} foot={round ? `占权益 ${percent(round.required / round.capital, 1)} · 预留 ${view.settings.reservePct}%` : undefined} />
      <Metric label="累计资金费" value={signedUsd(book?.funding)} tone={tone(book?.funding)} foot={book ? `手续费与滑点 ${usd(book.fees, 2)}` : undefined} />
      <Metric label="上一轮规划" value={stamp(view.lastRoundAt)} foot={view.nextRoundAt === null ? '未在运行' : view.nextRoundAt > view.checkedAt ? `下一轮 ${stamp(view.nextRoundAt)} · 每 ${view.settings.roundMinutes} 分钟` : '已排入下一轮，这一遍采集结束后开始'} />
    </section>
    <section className="panel" aria-label="账户">
      <div className="panel-heading"><h2>账户</h2><span className="muted">目标仓位与安全距离 · 下限 {view.settings.safetySigma}σ</span></div>
      {round ? <div className="vl-table"><table>
        <thead><tr><th>账户</th><th className="num">目标权益</th><th className="num">持仓名义</th><th className="num">1 日波动金额</th><th className="num">维持保证金</th><th className="num">安全距离</th><th>目标仓位</th></tr></thead>
        <tbody>{round.accounts.map(account => <tr key={account.id}>
          <td><span className="vl-symbol">{account.id}</span><small>{view.venues.find(venue => venue.id === account.venue)?.name ?? account.venue}</small></td>
          <td className="num">{usd(account.equity, 2)}<small>规划前 {usd(account.equityBefore, 2)}</small></td>
          <td className="num">{usd(account.gross)}</td>
          <td className="num">{usd(account.sigma, 2)}</td>
          <td className="num">{usd(account.mm, 2)}</td>
          <td className={`num ${account.distance !== null && account.distance < view.settings.safetySigma ? 'vl-warn' : ''}`}>{multiple(account.distance)}</td>
          <td className="wrap">{account.positions.length ? account.positions.map(position => <span key={position.base}>{position.notional > 0 ? '多' : '空'} {position.base} {usd(Math.abs(position.notional))}<Badge tone={-position.notional * position.adjustedApr > 0 ? 'ok' : 'warn'}>{position.notional > 0 ? '付' : '收'} {percent(position.adjustedApr)}</Badge> </span>) : <span className="vl-dim">空仓</span>}</td>
        </tr>)}</tbody></table></div>
        : <TableEmpty>还没有规划。启用并补齐历史后给出第一轮。</TableEmpty>}
      <p className="vl-note">安全距离 =（目标权益 − 维持保证金）÷ 1 日波动金额：价格朝不利方向走这么多个日标准差才触及维持保证金。1 日波动金额按账户内各标的的波动率与相关性合算，方向相反的相关标的会互相抵掉。</p>
    </section>
    <section className="panel" aria-label="各标的的作用">
      <div className="panel-heading"><h2>各标的的作用</h2><span className="muted">持有期 {round?.horizonDays ?? view.settings.horizonDays} 天</span></div>
      {round?.bases.length ? <div className="vl-table"><table>
        <thead><tr><th>标的</th><th className="num">单边名义</th><th className="num">自身资金费收入</th><th className="num">往返成本</th><th className="num">边际贡献</th><th>对账户波动的影响</th></tr></thead>
        <tbody>{round.bases.map(item => <tr key={item.base}>
          <td><span className="vl-symbol">{item.base}</span>{item.income - item.cost <= 0 && item.marginal > 0 ? <Badge tone="info">对冲</Badge> : null}</td>
          <td className="num">{usd(item.notional)}</td>
          <td className={`num vl-${tone(item.income)}`}>{signedUsd(item.income)}</td>
          <td className="num">{usd(item.cost, 2)}</td>
          <td className={`num vl-${tone(item.marginal)}`}>{signedUsd(item.marginal)}</td>
          <td className="wrap">{item.impacts.map(impact => <span key={impact.account}>{impact.account}：{usd(impact.sigmaWithout)} → {usd(impact.sigma)}（{multiple(impact.distanceWithout)} → {multiple(impact.distance)}）<br /></span>)}</td>
        </tr>)}</tbody></table></div>
        : <TableEmpty>{round ? '这一轮没有值得开的仓位：各账户之间的息差扣掉往返成本后不为正' : '还没有规划'}</TableEmpty>}
      <p className="vl-note">边际贡献：不许做这个标的时重新求解，整个组合在持有期内的净收入少多少。自身收入不为正而边际贡献为正的标的是对冲仓：它压低账户的波动金额，腾出的额度由息差仓位用掉。「对账户波动的影响」是去掉这个标的之前 → 之后的 1 日波动金额与安全距离。</p>
    </section>
    <div className="vl-columns">
      <section className="panel" aria-label="各腿资金费">
        <div className="panel-heading"><h2>各腿资金费（年化）</h2><span className="muted">多头付为正 · 短 {view.settings.shortDays} 天 / 长 {view.settings.longDays} 天</span></div>
        {view.legs.length ? <div className="vl-table"><table>
          <thead><tr><th>场所 · 合约</th><th className="num">价格</th><th className="num">当前</th><th className="num">短窗口</th><th className="num">长窗口</th><th className="num">调整均值</th><th>状态</th></tr></thead>
          <tbody>{view.legs.map(leg => <tr key={`${leg.venue}|${leg.base}`}>
            <td><span className="vl-symbol">{leg.base}</span><small>{view.venues.find(venue => venue.id === leg.venue)?.name ?? leg.venue} · {leg.symbol || '—'}</small></td>
            <td className="num">{price(leg.price)}</td>
            <td className="num">{percent(leg.currentApr)}</td>
            <td className="num">{percent(leg.shortApr)}<small>{leg.settlements} 次结算</small></td>
            <td className="num">{percent(leg.longApr)}</td>
            <td className="num">{percent(leg.adjustedApr)}</td>
            <td className="wrap">{leg.note ? <span className="vl-warn">{leg.note}</span> : <span className="vl-dim">可用</span>}</td>
          </tr>)}</tbody></table></div>
          : <TableEmpty>启用后列出各账户场所上每个标的的合约</TableEmpty>}
      </section>
      <section className="panel" aria-label="波动率与相关性">
        <div className="panel-heading"><h2>波动率与相关性</h2><span className="muted">{view.settings.volDays} 天小时收益</span></div>
        {view.risk?.bases.length ? <div className="vl-table fb-corr"><table>
          <thead><tr><th>标的</th><th className="num">日波动率</th>{view.risk.bases.map(base => <th className="num" key={base}>{base}</th>)}</tr></thead>
          <tbody>{view.risk.bases.map((base, row) => <tr key={base}>
            <td><span className="vl-symbol">{base}</span><small>{view.risk!.samples[row]} 个样本</small></td>
            <td className="num">{percent(view.risk!.vol[row])}</td>
            {view.risk!.corr[row]!.map((value, column) => <td key={column} className={`num${row === column ? ' self' : ''}`}>{value.toFixed(3)}</td>)}
          </tr>)}</tbody></table></div>
          : <TableEmpty>价格历史补齐后给出</TableEmpty>}
        {view.collect.errors.length ? <p className="vl-note err">读取失败（5 分钟后重试）：{view.collect.errors.join('；')}</p> : null}
      </section>
    </div>
  </>;
}

function Steps({ round }: { round: RoundView }) {
  if (!round.steps.length) return <TableEmpty>这一轮不用调整：当前仓位与资金分布已经在目标上</TableEmpty>;
  return <div className="vl-table fb-steps"><table>
    <thead><tr><th>顺序</th><th>步骤</th><th className="num">数量</th><th className="num">规划价</th><th className="num">金额</th></tr></thead>
    <tbody>{round.steps.map((step, index) => <tr key={index}>
      <td>{index + 1}</td>
      <td className="wrap">{stepText(step)}{step.kind === 'transfer' ? <Badge tone="info">划转</Badge> : step.reduce ? <Badge tone="warn">减仓</Badge> : <Badge tone="ok">加仓</Badge>}</td>
      <td className="num">{step.kind === 'order' ? quantity(step.qty) : '—'}</td>
      <td className="num">{step.kind === 'order' ? price(step.price) : '—'}</td>
      <td className="num">{usd(step.notional, 2)}</td>
    </tr>)}</tbody></table></div>;
}

function PlanTab({ view, write, onChanged, onExpired }: { view: StateView; write: Write; onChanged: Changed; onExpired: () => void }) {
  const [picked, setPicked] = useState<number | null>(null);
  const latest = view.round;
  const chosen = picked !== null && picked !== latest?.id ? picked : null;
  const detail = useLiveResource<RoundView>(`${FUNDINGBOOK_BASE}/round?id=${chosen ?? 0}`, { intervalMs: null, enabled: chosen !== null, onExpired });
  const shown = chosen === null ? latest : detail.data;
  const plan = () => { void write.run('plan', () => api(`${FUNDINGBOOK_BASE}/plan`, { body: {} }), () => { setPicked(null); void onChanged(); return '已排入下一轮规划，这一遍采集结束后开始'; }); };
  return <>
    <section className="panel" aria-label="路径规划">
      <div className="panel-heading"><h2>路径规划{shown ? ` · 第 ${shown.id} 轮` : ''}</h2><span className="muted">{shown ? `${stamp(shown.at)} · ${shown.applied ? '已记入模拟盘' : '只出规划，模拟盘未动'}` : ''}</span></div>
      <div className="vl-toolbar">
        <span className="muted">先减仓放出保证金，再在账户之间划转，最后加仓。只是规划：不向任何交易所发单。</span><span className="grow" />
        <button type="button" className="button secondary" disabled={write.busy !== null || !view.settings.enabled || !view.running} onClick={plan}>{write.busy === 'plan' ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}立即规划</button>
      </div>
      {shown ? <>
        <div className="vl-metrics inset">
          <Metric label="规划时权益" value={usd(shown.capital, 2)} />
          <Metric label="持有期资金费收入" value={signedUsd(shown.income)} tone={tone(shown.income)} foot={`${shown.horizonDays} 天，按调整均值`} />
          <Metric label="新开仓往返成本" value={usd(shown.cost, 2)} foot="手续费加滑点，开与平各一次" />
          <Metric label="所需资金" value={usd(shown.required, 2)} foot={`每 1 美元额度的价格 ${percent(shown.lambda)}`} />
        </div>
        <Steps round={shown} />
      </> : chosen !== null && detail.error ? <p className="vl-note err">读取第 {chosen} 轮失败：{detail.error.message}</p>
        : <TableEmpty>{chosen !== null ? '读取中…' : '还没有规划'}</TableEmpty>}
    </section>
    <section className="panel" aria-label="规划记录">
      <div className="panel-heading"><h2>规划记录</h2><span className="muted">最近 {view.rounds.length} 轮</span></div>
      {view.rounds.length ? <div className="vl-table"><table>
        <thead><tr><th>轮次</th><th>时间</th><th className="num">权益</th><th className="num">持仓名义</th><th className="num">步骤</th><th className="num">预期年化</th></tr></thead>
        <tbody>{view.rounds.map(item => <tr key={item.id} className={item.id === shown?.id ? 'vl-hit' : undefined}>
          <td><button type="button" className="fb-pick" aria-pressed={item.id === shown?.id} onClick={() => setPicked(item.id)}>第 {item.id} 轮</button></td>
          <td>{stamp(item.at)}</td>
          <td className="num">{usd(item.capital, 2)}</td>
          <td className="num">{usd(item.gross)}</td>
          <td className="num">{item.stepCount}</td>
          <td className="num">{percent(item.expectedApr)}</td>
        </tr>)}</tbody></table></div>
        : <TableEmpty>还没有规划记录</TableEmpty>}
    </section>
  </>;
}

function PaperTab({ view, write, onChanged }: { view: StateView; write: Write; onChanged: Changed }) {
  const book = view.book;
  const reset = () => {
    if (!confirm(resetConfirmText(view))) return;
    void write.run('reset', () => api(`${FUNDINGBOOK_BASE}/paper/reset`, { body: { confirm: true } }), () => { void onChanged(); return '模拟盘已重置，下一轮规划从本金重新开始'; });
  };
  const profit = book && book.equity !== null ? book.equity - book.initialCapital : null;
  const days = book ? (view.checkedAt - book.startedAt) / 86_400_000 : 0;
  const points = book ? [...view.rounds].reverse().map(item => ({ t: item.at, net: item.capital - book.initialCapital })) : [];
  return <>
    <section className="vl-metrics" aria-label="模拟盘">
      <Metric label="权益" value={usd(book?.equity, 2)} tone={tone(profit)} foot={book ? `本金 ${usd(book.initialCapital)} · 自 ${stamp(book.startedAt)}` : '第一轮规划时建立'} />
      <Metric label="累计盈亏" value={signedUsd(profit)} tone={tone(profit)} foot={profit !== null && book && days >= 1 ? `折年化 ${percent(profit / book.initialCapital / days * 365)}（${days.toFixed(1)} 天）` : '满 1 天后给出折年化'} />
      <Metric label="资金费" value={signedUsd(book?.funding)} tone={tone(book?.funding)} foot="按已结算记录逐笔计入" />
      <Metric label="手续费与滑点" value={usd(book?.fees, 2)} foot={`已实现价差盈亏 ${signedUsd(book?.realized)}`} />
    </section>
    {points.length >= 2 ? <section className="panel" aria-label="累计盈亏走势">
      <div className="panel-heading"><h2>累计盈亏</h2><span className="muted">每轮规划时的权益减本金</span></div>
      <div className="vl-chart small"><EquityChart points={points} label="模拟盘累计盈亏" /></div>
    </section> : null}
    <section className="panel" aria-label="模拟持仓">
      <div className="panel-heading"><h2>账户与持仓</h2><span className="muted">{view.settings.paperAuto ? '每轮规划后按规划更新' : '自动更新已关闭，持仓不动'}</span></div>
      {book ? <div className="vl-table"><table>
        <thead><tr><th>账户 · 标的</th><th className="num">数量</th><th className="num">开仓均价</th><th className="num">现价</th><th className="num">名义金额</th><th className="num">浮动盈亏</th><th className="num">资金费 / 成本</th></tr></thead>
        <tbody>{book.accounts.flatMap(account => [
          <tr key={account.id}>
            <td><span className="vl-symbol">{account.id}</span><small>现金 {usd(account.cash, 2)}</small></td>
            <td className="num" colSpan={4}>权益 {usd(account.equity, 2)}</td>
            <td className="num" />
            <td className="num">{signedUsd(account.funding)}<small>成本 {usd(account.fees, 2)}</small></td>
          </tr>,
          ...account.positions.map(position => <tr key={`${account.id}|${position.base}`}>
            <td>{position.qty > 0 ? '多' : '空'} {position.base}<small>{position.symbol}</small></td>
            <td className="num">{quantity(position.qty)}</td>
            <td className="num">{price(position.entry)}</td>
            <td className="num">{price(position.price)}</td>
            <td className="num">{usd(position.notional)}</td>
            <td className={`num vl-${tone(position.unrealized)}`}>{signedUsd(position.unrealized)}</td>
            <td className="num" />
          </tr>),
        ])}</tbody></table></div>
        : <TableEmpty>还没有模拟盘。启用后第一轮规划时按本金建立。</TableEmpty>}
      <div className="vl-actions vl-pause">
        <button type="button" className="button secondary" disabled={write.busy !== null || !book} onClick={reset}>{write.busy === 'reset' ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <RotateCcw size={14} aria-hidden="true" />}重置模拟盘</button>
      </div>
      <p className="vl-note">模拟盘按规划价成交，每次成交扣账户的吃单费率加滑点；资金费按各腿已结算的记录逐笔计入，名义金额用计入时的价格近似。它不反映排队、部分成交、划转在途与各所的保证金档位。</p>
    </section>
  </>;
}

function SettingsTab({ view, write, onChanged }: { view: StateView; write: Write; onChanged: Changed }) {
  const [form, setForm] = useState<SettingsForm>(() => settingsForm(view.settings));
  const [touched, setTouched] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const saved = JSON.stringify(view.settings);
  // 没在编辑时跟随服务端的值（别处保存后这里不留旧值）。
  // 只在服务端的值变了时跟随：保存成功后表单已经是新值，这时服务端的值还没刷新过来，不能拿旧值盖回去。
  const synced = useRef(saved);
  useEffect(() => { if (!touched && synced.current !== saved) { synced.current = saved; setForm(settingsForm(JSON.parse(saved))); } }, [saved, touched]);
  const edit = (change: (current: SettingsForm) => SettingsForm) => { setTouched(true); setForm(change); };
  const editAccount = (index: number, patch: Partial<SettingsForm['accounts'][number]>) => edit(current => ({ ...current, accounts: current.accounts.map((account, at) => at === index ? { ...account, ...patch } : account) }));
  const dirty = settingsChanged(form, view.settings);
  const save = () => {
    const request = settingsRequest(form);
    if (!request.ok) { setProblem(request.message); return; }
    setProblem(null);
    void write.run('settings', () => api(`${FUNDINGBOOK_BASE}/settings`, { body: request.body }), () => { setForm(settingsForm(request.body)); setTouched(false); void onChanged(); return request.body.enabled ? '参数已保存，下一轮规划起生效' : '参数已保存；模块未启用'; });
  };
  return <section className="panel" aria-label="参数">
    <div className="panel-heading"><h2>参数</h2><span className="muted">保存整份，下一轮规划起生效</span></div>
    <div className="fb-switches">
      <label className={`vl-check${form.enabled ? ' on' : ''}`}><input type="checkbox" checked={form.enabled} onChange={event => edit(current => ({ ...current, enabled: event.target.checked }))} />启用（采集公开行情、求解、记模拟盘）</label>
      <label className={`vl-check${form.paperAuto ? ' on' : ''}`}><input type="checkbox" checked={form.paperAuto} onChange={event => edit(current => ({ ...current, paperAuto: event.target.checked }))} />每轮规划后按规划更新模拟盘</label>
    </div>
    <div className="vl-fields"><label className="vl-field">标的
      <input value={form.bases} autoCapitalize="characters" spellCheck={false} onChange={event => edit(current => ({ ...current, bases: event.target.value }))} />
      <small>用逗号或空格分开，例如 BTC, ETH, SOL, BNB；最多 12 个。每个账户的场所上有这个标的的永续合约才会参与</small>
    </label></div>
    {SETTING_GROUPS.map(group => <div key={group.id}>
      <div className="fb-group">{group.label}</div>
      <div className="vl-fields">{SETTING_FIELDS.filter(field => field.group === group.id).map(field => <label className="vl-field" key={field.key}>
        {field.label}（{field.unit}）
        <input inputMode="decimal" value={form[field.key]} onChange={event => edit(current => ({ ...current, [field.key]: event.target.value }))} />
        <small>{field.hint}</small>
      </label>)}</div>
    </div>)}
    <div className="fb-group">账户（模拟）</div>
    <div className="vl-table fb-accounts"><table>
      <thead><tr><th>名称</th><th>场所</th><th>维持保证金率（%）</th><th>最大杠杆（倍）</th><th>吃单费率（基点）</th><th /></tr></thead>
      <tbody>{form.accounts.map((account, index) => <tr key={index}>
        <td><input aria-label={`账户 ${index + 1} 名称`} value={account.id} spellCheck={false} onChange={event => editAccount(index, { id: event.target.value })} /></td>
        <td><select aria-label={`账户 ${index + 1} 场所`} value={account.venue} onChange={event => editAccount(index, venueDefaults(event.target.value, view.venues))}>{view.venues.map(venue => <option key={venue.id} value={venue.id}>{venue.name}</option>)}</select></td>
        <td><input aria-label={`账户 ${index + 1} 维持保证金率`} inputMode="decimal" value={account.mmrPct} onChange={event => editAccount(index, { mmrPct: event.target.value })} /></td>
        <td><input aria-label={`账户 ${index + 1} 最大杠杆`} inputMode="decimal" value={account.maxLeverage} onChange={event => editAccount(index, { maxLeverage: event.target.value })} /></td>
        <td><input aria-label={`账户 ${index + 1} 吃单费率`} inputMode="decimal" value={account.takerBps} onChange={event => editAccount(index, { takerBps: event.target.value })} /></td>
        <td><button type="button" className="icon" aria-label={`删除账户 ${account.id || index + 1}`} onClick={() => edit(current => ({ ...current, accounts: current.accounts.filter((_, at) => at !== index) }))}><Trash2 size={14} aria-hidden="true" /></button></td>
      </tr>)}</tbody></table></div>
    <p className="vl-note">账户只是模拟盘里的记账单位，不对应任何 API 密钥。维持保证金率填这个账户规模下所在档位的数值（各所按持仓规模递增）；同一场所可以有多个账户。删掉在模拟盘里还有资金或持仓的账户会被拒绝，先重置模拟盘。</p>
    <div className="vl-actions">
      {problem ? <Callout tone="error">{problem}</Callout> : null}
      <button type="button" className="button secondary" disabled={write.busy !== null || form.accounts.length >= 8} onClick={() => edit(current => ({ ...current, accounts: [...current.accounts, newAccount(current, view.venues)] }))}><Plus size={14} aria-hidden="true" />添加账户</button>
      <button type="button" className="button" disabled={!dirty || write.busy !== null} onClick={save}>{write.busy === 'settings' ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Save size={14} aria-hidden="true" />}保存参数</button>
      <button type="button" className="button secondary" disabled={!dirty || write.busy !== null} onClick={() => { setTouched(false); setProblem(null); setForm(settingsForm(view.settings)); }}>撤销修改</button>
    </div>
  </section>;
}
