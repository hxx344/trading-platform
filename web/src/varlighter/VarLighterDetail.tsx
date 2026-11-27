// 标的详情页签：价差走势与基线、分时段统计与建议阈值、参数（回测与保存）、下单预演、该标的的实盘成交（v0.112.0 起没有模拟盘）。
import { useEffect, useMemo, useState } from 'react';
import { CircleCheck, CircleAlert, LoaderCircle, Play, Save } from 'lucide-react';
import { api } from '../api.ts';
import { Callout, StatePanel, TableEmpty } from '../StateViews.tsx';
import { useLiveResource } from '../use-live-resource.ts';
import type { LiveTradeView } from '../../../src/varlighter/views.ts';
import type { BacktestView, StateView, SymbolView } from '../../../src/varlighter/views.ts';
import { Badge, EquityChart, Metric, SpreadChart, SpreadLegend, stampText, useWrite } from './parts.tsx';
import {
  ALL_DIRECTIONS, AUTO_FIELDS, BACKTEST_HOURS, IDENTITY_LABELS, REASON_LABELS, REGIME_LABELS, reasonLabel, SYMBOL_FIELDS, VARLIGHTER_BASE, VAR_QUOTE_LABELS, age, autoBody, autoFormPatch, backtestBody, bps,
  chartRows, directionLabel, duration, fundingAnnual, percent, plain, price, settingsBody, signal, signedUsd, symbolForm, symbolRequest, tone, usd, varLighterHref, venueLabel, venueShort, pairLabel, type SymbolForm,
} from './varlighter-form.ts';

const RANGES: readonly { hours: number; label: string }[] = [{ hours: 6, label: '6 小时' }, { hours: 24, label: '1 天' }, { hours: 72, label: '3 天' }, { hours: 168, label: '7 天' }, { hours: 336, label: '14 天' }];

export function VarLighterDetail({ view, symbol, onChanged, onExpired }: { view: StateView; symbol: string | null; onChanged: () => Promise<void>; onExpired: () => void }) {
  // 没指定标的时先看已启用的，再看离入场最近的。
  const fallback = useMemo(() => view.rows.find(row => row.enabled)?.key ?? [...view.rows].sort((a, b) => (signal(b)?.gap ?? -1e9) - (signal(a)?.gap ?? -1e9))[0]?.key ?? null, [view.rows]);
  const chosen = symbol ?? fallback;
  const [hours, setHours] = useState(24);
  const live = useLiveResource<SymbolView>(`${VARLIGHTER_BASE}/symbol?symbol=${encodeURIComponent(chosen ?? '')}&hours=${hours}`, { intervalMs: 60_000, timeoutMs: 30_000, enabled: chosen !== null, onExpired });
  const data = live.data && live.data.key === chosen ? live.data : null;
  const known = view.rows.some(row => row.key === chosen);
  return <>
    <div className="panel"><div className="vl-toolbar">
      <label>标的<select value={chosen ?? ''} onChange={event => { location.hash = varLighterHref('detail', event.target.value); }}>
        {chosen && !known ? <option value={chosen}>{chosen}</option> : null}
        {view.rows.map(row => <option key={row.key} value={row.key}>{row.symbol} · {venueShort(row.a.venue)}↔{venueShort(row.b.venue)}{row.custom ? '（手动）' : ''}{row.name ? ` · ${row.name}` : ''}</option>)}</select></label>
      <div className="vl-seg" role="group" aria-label="时间范围">{RANGES.map(item => <button type="button" key={item.hours} aria-pressed={hours === item.hours} onClick={() => setHours(item.hours)}>{item.label}</button>)}</div>
      <span className="grow" />
      {live.status === 'loading' || (live.data && !data) ? <span className="muted"><LoaderCircle size={13} className="spin" aria-hidden="true" /> 读取中</span> : data ? <span className="muted">{data.samples.toLocaleString()} 个样本</span> : null}
    </div></div>
    {chosen === null ? <StatePanel kind="empty" title="还没有配对" detail="各场所的目录与报价到达后这里显示；也可以在实盘准备页添加手动配对。" />
      : !data ? live.error ? <StatePanel kind="error" title="读取标的失败" detail={live.error.message} /> : <StatePanel kind="loading" title="加载中…" />
        : <Detail data={data} view={view} onChanged={async () => { await Promise.all([onChanged(), live.refresh()]); }} />}
  </>;
}

function Detail({ data, view, onChanged }: { data: SymbolView; view: StateView; onChanged: () => Promise<void> }) {
  const row = view.rows.find(item => item.key === data.key) ?? null;
  // 入场带与读数按当前生效的参数：自动配置开着时是推荐值。
  const rows = useMemo(() => chartRows(data.points, data.effective.entryBps), [data.points, data.effective.entryBps]);
  const latest = data.latest;
  const funding = fundingAnnual(latest?.aFunding ?? row?.aFunding ?? null, latest?.bFunding ?? row?.bFunding ?? null);
  const aName = venueShort(data.a.venue), bName = venueShort(data.b.venue), pairName = `${aName}↔${bName}`;
  const fee = (value: number | null) => value === null ? '未知' : plain(value, 2);
  return <>
    {data.custom ? <Callout tone="info">手动配对：{data.a.name} {data.a.symbol} 对 {data.b.name} {data.b.symbol}{data.ratio !== 1 ? `，B 腿价格按 ×${data.ratio} 折算` : ''}{data.note ? `。${data.note}` : ''}</Callout> : null}
    {data.identity === 'mismatch' ? <Callout tone="error">两边价格相差 {plain(data.gapBps, 0)} 基点，合约规格不同（可能是不同的标的或不同的报价单位），不能交易。</Callout>
      : !data.eligible ? <Callout tone="warning">该标的的两边规格还没有人工确认（价格相差 {plain(data.gapBps, 0)} 基点）。确认前只采集、可回测，不开仓。<a href={varLighterHref('ready')}>去实盘准备页确认</a></Callout> : null}
    <section className="vl-metrics" aria-label={`${data.symbol} 读数`}>
      <Metric label="中间价基差" value={`${bps(row?.mid ?? null)} 基点`} foot={latest ? `样本 ${stampText(latest.t)} · ${REGIME_LABELS[latest.regime]}` : '无样本'} />
      <Metric label="基线中位数 ± σ" value={row?.baseline ? `${bps(row.baseline.median)} ± ${plain(row.baseline.sigma)}` : '样本不足'} foot={row?.baseline ? `${row.baseline.fallback ? '全天' : REGIME_LABELS[row.baseline.regime]}基线 · ${row.baseline.samples} 个样本 · 窗口 ${data.global.windowHours} 小时` : `至少 ${data.global.minSamples} 个样本`} />
      <Metric label={`卖 ${aName} / 买 ${aName} 偏离`} value={`${bps(row?.rich ?? null)} / ${bps(row?.cheap ?? null)}`} foot={`入场 ${plain(data.effective.entryBps)} · 出场 ${plain(data.effective.exitBps)}${data.auto.on && data.auto.params ? '（自动配置）' : ''} · ${data.bucket} 档${row?.estimated ? ' · 一档估算' : ''}`} />
      <Metric label="资金费（年化）" value={`${funding.a} / ${funding.b}`} foot={`${aName} / ${bName}，只作参考`} />
      <Metric label="两腿合约" value={`${data.a.symbol} ↔ ${data.b.symbol}${data.ratio !== 1 ? ` ×${data.ratio}` : ''}`}
        foot={`手续费 ${fee(data.fees.a)} / ${fee(data.fees.b)} 基点${data.fees.a !== null && data.fees.b !== null && data.fees.a + data.fees.b > 0 ? `（往返 ${plain(2 * (data.fees.a + data.fees.b))}）` : ''} · ${[data.a, data.b].filter(leg => leg.venue !== 'var').map(leg => `${venueShort(leg.venue)} #${leg.market.id} 最小 ${leg.market.minQuote} USDC`).join(' · ')} · 规格${IDENTITY_LABELS[data.identity]}`} />
    </section>
    <section className="panel" aria-label="价差走势">
      <div className="panel-heading"><h2>{data.symbol} · {pairName} 价差走势</h2><span className="muted">{data.kindName} · 单位基点 · 基线按样本当时之前的窗口计算，不含未来</span></div>
      {rows.length ? <><div className="vl-chart"><SpreadChart rows={rows} trades={data.trades} from={data.from} to={data.to} label={`${data.symbol} ${pairName} 价差走势`} aName={aName} /></div><SpreadLegend aName={aName} /></>
        : <TableEmpty>这个范围内还没有样本</TableEmpty>}
    </section>
    <StatsPanel data={data} />
    <div className="vl-columns">
      <ParamsPanel data={data} view={view} onChanged={onChanged} />
      <PlanPanel data={data} />
    </div>
    <TradesPanel title={`${data.symbol} · ${pairName} 实盘成交`} trades={data.trades} empty="这个范围内没有两腿都成交并平掉的实盘持仓（没开成、单腿的在实盘准备页）" />
  </>;
}

function StatsPanel({ data }: { data: SymbolView }) {
  return <section className="panel" aria-label="分时段统计">
    <div className="panel-heading"><h2>分时段统计</h2><span className="muted">所选范围内的样本 · 往返成本列为盘口成本（不含手续费） · 建议入场 = 偏离 95 分位 − 半个往返成本（不低于 5）</span></div>
    {data.stats.length ? <div className="vl-table"><table>
      <thead><tr><th>时段</th><th className="num">样本</th><th className="num">中位数</th><th className="num">σ（MAD）</th><th className="num">5% – 95%</th><th className="num">往返成本</th>
        <th className="num">半衰期</th><th className="num">穿越 / 天</th><th className="num">机会占比</th><th className="num">偏离 95%</th><th className="num">建议入场</th></tr></thead>
      <tbody>{data.stats.map(item => <tr key={item.regime}>
        <td>{REGIME_LABELS[item.regime]}</td><td className="num">{item.samples.toLocaleString()}</td><td className="num">{bps(item.median)}</td><td className="num">{plain(item.sigma)}</td>
        <td className="num">{bps(item.p05)} – {bps(item.p95)}</td><td className="num">{plain(item.costMedian)}</td>
        <td className="num">{item.halfLifeMin === null ? '不回归' : duration(item.halfLifeMin * 60_000)}</td><td className="num">{plain(item.crossingsPerDay)}</td>
        <td className="num">{percent(item.opportunityShare, 1)}</td><td className="num">{plain(item.deviation95)}</td><td className="num">{item.suggestedEntryBps ?? '—'}</td>
      </tr>)}</tbody></table></div> : <TableEmpty>样本不足，无法统计</TableEmpty>}
    <p className="vl-note">半衰期按相邻 3 分钟内的样本做 AR(1) 估计；机会占比是按当前入场阈值，卖 A 或买 A（A 为配对键里的第一条腿）的可成交价差偏离中位数达到阈值的样本比例。</p>
  </section>;
}

function ParamsPanel({ data, view, onChanged }: { data: SymbolView; view: StateView; onChanged: () => Promise<void> }) {
  const [form, setForm] = useState<SymbolForm>(() => symbolForm(data.params));
  const [loadedFor, setLoadedFor] = useState(data.key);
  const [btHours, setBtHours] = useState(168);
  const [result, setResult] = useState<BacktestView | null>(null);
  const write = useWrite(), clearMessage = write.clear;
  // 换标的时用该标的已保存的参数重填，回测结果清空。
  useEffect(() => { if (loadedFor !== data.key) { setForm(symbolForm(data.params)); setLoadedFor(data.key); setResult(null); clearMessage(); } }, [data.key, data.params, loadedFor, clearMessage]);
  const parsed = symbolRequest(form);
  // 两边都经 symbolRequest 规整（字段顺序一致），否则服务端字段顺序不同会一直显示“有未保存的修改”。
  const savedParsed = symbolRequest(symbolForm(data.params));
  const saved = parsed.ok && savedParsed.ok && JSON.stringify(savedParsed.value) === JSON.stringify(parsed.value);
  const set = (patch: Partial<SymbolForm>) => setForm(current => ({ ...current, ...patch }));
  const runBacktest = () => {
    const body = backtestBody(data.key, btHours, form, data.global);
    if (!body.ok) return;
    void write.run('backtest', () => api<BacktestView>(`${VARLIGHTER_BASE}/backtest`, { body: body.value, timeoutMs: 125_000 }), value => { setResult(value); return `回测完成：${value.summary.trades} 笔，净 ${signedUsd(value.summary.netUsd)}`; });
  };
  const auto = data.auto, recommended = auto.params;
  const save = () => {
    if (!parsed.ok) return;
    void write.run('save', async () => { await api(`${VARLIGHTER_BASE}/settings`, { body: settingsBody(view.settings, { symbol: { symbol: data.key, params: parsed.value } }) }); await onChanged().catch(() => {}); },
      () => { return auto.on ? '参数已保存；自动配置开着，入场、出场、止损与最长持有仍用推荐值' : '参数已保存，策略从下一个样本起按新参数运行'; });
  };
  const setAuto = (on: boolean) => {
    void write.run('auto', async () => { await api(`${VARLIGHTER_BASE}/settings`, { body: autoBody(view.settings, data.key, on) }); await onChanged().catch(() => {}); },
      () => { return on ? '已改用自动配置：新开的仓按推荐的入场、出场、止损与最长持有，推荐值随行情更新' : '已关闭自动配置，按下面保存的参数运行'; });
  };
  return <section className="panel" aria-label="参数与回测">
    <div className="panel-heading"><h2>参数与回测</h2><span className="muted">{saved ? '与已保存参数一致' : '有未保存的修改'}</span></div>
    <div className={`vl-auto${auto.on ? ' on' : ''}`} aria-label="自动配置">
      <label><input type="checkbox" checked={auto.on} disabled={write.busy !== null} onChange={event => setAuto(event.target.checked)} />自动配置<Badge tone={auto.on ? recommended && data.params.enabled ? 'info' : 'warn' : ''}>{auto.on ? !recommended ? '等待样本' : data.params.enabled ? '使用中' : '已选用 · 配对未启用' : '未使用'}</Badge></label>
      {recommended ? <>
        <dl>{SYMBOL_FIELDS.filter(field => AUTO_FIELDS.includes(field.key as (typeof AUTO_FIELDS)[number])).map(field => <div key={field.key}><dt>{field.label}</dt><dd>{recommended[field.key as (typeof AUTO_FIELDS)[number]]} {field.unit}</dd></div>)}</dl>
        <p>{auto.on ? '策略按这组推荐值运行' : '当前的推荐值'}：按{auto.regime ? REGIME_LABELS[auto.regime] : ''}最近 {auto.samples.toLocaleString()} 个样本的偏离、往返成本与回归快慢，加上当前的滑点、手续费和最低预期净利算出，{age(auto.at, view.now)}更新，约每 10 分钟重算。名义金额、冷却、时段与方向仍用下面保存的值。
          <button type="button" className="button secondary" onClick={() => set(autoFormPatch(recommended))}>填入表单</button></p>
      </> : <p className={auto.on ? 'vl-warn' : undefined}>{auto.reason ?? '暂时没有推荐值'}{auto.on ? '。有推荐值之前不开仓，已有持仓按开仓时的参数平仓。' : '。'}</p>}
    </div>
    <div className="vl-fields">
      {SYMBOL_FIELDS.map(field => { const taken = auto.on && recommended ? recommended[field.key as (typeof AUTO_FIELDS)[number]] : undefined; return <label className="vl-field" key={field.key}>{field.label}（{field.unit}）
        <input inputMode="decimal" value={form[field.key]} onChange={event => set({ [field.key]: event.target.value } as Partial<SymbolForm>)} />
        {taken !== undefined ? <small className="vl-auto-note">自动配置中，当前用 {taken}；这里是关闭自动配置后的值</small> : field.hint ? <small>{field.hint}</small> : null}</label>; })}
    </div>
    <div className="vl-options"><b>允许开仓的时段（不影响平仓）</b>{data.regimes.map(regime => <label key={regime}><input type="checkbox" checked={form.regimes.includes(regime)}
      onChange={event => set({ regimes: event.target.checked ? [...form.regimes, regime] : form.regimes.filter(item => item !== regime) })} />{REGIME_LABELS[regime]}</label>)}</div>
    <div className="vl-options"><b>方向</b>{ALL_DIRECTIONS.map(direction => <label key={direction}><input type="checkbox" checked={form.directions.includes(direction)}
      onChange={event => set({ directions: event.target.checked ? [...form.directions, direction] : form.directions.filter(item => item !== direction) })} />{directionLabel(direction, data.a.venue, data.b.venue)}</label>)}</div>
    <div className="vl-options"><label><input type="checkbox" checked={form.enabled} disabled={!data.eligible && !form.enabled} onChange={event => set({ enabled: event.target.checked })} />启用该标的的策略（实盘准备页勾选后才下真实订单）</label>
      {!data.eligible ? <span className="vl-warn">规格确认后才能启用</span> : null}</div>
    <div className="vl-actions">
      <label className="vl-field">回测范围<select value={btHours} onChange={event => setBtHours(Number(event.target.value))}>{BACKTEST_HOURS.map(value => <option key={value} value={value}>最近 {value / 24} 天</option>)}</select></label>
      <button type="button" className="button secondary" disabled={!parsed.ok || write.busy !== null} onClick={runBacktest}>{write.busy === 'backtest' ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}按表单参数回测</button>
      <button type="button" className="button primary" disabled={!parsed.ok || saved || write.busy !== null} onClick={save}>{write.busy === 'save' ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Save size={14} aria-hidden="true" />}保存为策略参数</button>
      {!parsed.ok ? <Callout tone="warning" role="status">{parsed.error}</Callout> : null}
      {write.message ? <Callout tone={write.message.tone}>{write.message.text}</Callout> : null}
    </div>
    {result ? <BacktestResultView result={result} /> : <p className="vl-note">回测按时间重放已采集的盘口和询价，采用当前表单参数及策略的风控与成本规则。</p>}
  </section>;
}

function BacktestResultView({ result }: { result: BacktestView }) {
  const summary = result.summary;
  const blocked = Object.entries(summary.blocked).sort((a, b) => b[1] - a[1]);
  const reasons = Object.entries(summary.reasons);
  const endMark = summary.openMarkUsd === null
    ? (result.open ? '期末持仓缺少可用报价' : '期末无持仓')
    : `期末持仓估值 ${signedUsd(summary.openMarkUsd)}${summary.openMarkEstimated ? '（估算）' : ''}${summary.openMarkVarSource ? ` · Var ${VAR_QUOTE_LABELS[summary.openMarkVarSource]}` : ''}`;
  return <div aria-label="回测结果">
    <div className="vl-metrics inset">
      <Metric label="净盈亏" value={signedUsd(summary.netUsd)} tone={tone(summary.netUsd)} foot={`毛 ${signedUsd(summary.grossUsd)} · 成本 ${usd(summary.costUsd)}`} />
      <Metric label="成交" value={`${summary.trades} 笔`} foot={`胜率 ${percent(summary.winRate)} · 平均 ${bps(summary.avgNetBps)} 基点`} />
      <Metric label="最大回撤" value={usd(summary.maxDrawdownUsd)} foot={`平均持有 ${duration(summary.avgHoldMinutes === null ? null : summary.avgHoldMinutes * 60_000)}`} />
      <Metric label="资金费估算" value={signedUsd(summary.fundingUsd)} foot={`${endMark} · 资金费不计入净盈亏`} />
    </div>
    {result.equity.length > 1 ? <div className="vl-chart small"><EquityChart points={result.equity} label="回测累计净盈亏" /></div> : null}
    {summary.alignedSamples > 0 && <p className="vl-note">旧版采集的 {summary.alignedSamples.toLocaleString()} 个样本只记录了对齐时刻的盘口，其中 {summary.alignedOpens.toLocaleString()} 次开仓按该盘口估算。</p>}
    {summary.unknownDecisionSamples > 0 && <p className="vl-note">{summary.unknownDecisionSamples.toLocaleString()} 个样本缺少开仓判断时刻，已排除在开仓依据之外。</p>}
    <p className="vl-note">{result.samples.toLocaleString()} 个样本，{summary.evaluated.toLocaleString()} 个有基线可判断
      {reasons.length ? `；平仓原因：${reasons.map(([key, count]) => `${REASON_LABELS[key] ?? key} ${count}`).join('，')}` : ''}
      {blocked.length ? `；达到入场但没开仓：${blocked.map(([key, count]) => `${key} ${count}`).join('，')}` : ''}
      {result.truncated ? '；成交超过 1000 笔，只列最近 1000 笔' : ''}。</p>
    {result.trades.length ? <TradeTable trades={result.trades.slice(-50).reverse()} /> : null}
  </div>;
}

function PlanPanel({ data }: { data: SymbolView }) {
  return <section className="panel" aria-label="下单预演">
    <div className="panel-heading"><h2>下单预演</h2><span className="muted">按最新样本与当前名义金额 {usd(data.params.notionalUsd, 0)} · 只生成计划，不发送</span></div>
    {data.plans.length ? <div className="vl-plans">{data.plans.map(plan => <div className="vl-plan" key={plan.direction}>
      <h3>{directionLabel(plan.direction, data.a.venue, data.b.venue)} {plan.ready ? <Badge tone="ok">可下单</Badge> : <Badge tone="warn">未就绪</Badge>}</h3>
      <div className="vl-table"><table><thead><tr><th>腿</th><th className="num">数量</th><th className="num">预期价</th><th className="num">限价</th></tr></thead>
        <tbody>{plan.legs.map(leg => <tr key={leg.venue}><td>{venueLabel(leg.venue)} {leg.side === 'buy' ? '买入' : '卖出'}<small>{usd(leg.notionalUsd)}</small></td>
          <td className="num">{leg.qty}</td><td className="num">{price(leg.expected)}</td><td className="num">{leg.limit}</td></tr>)}</tbody></table></div>
      <ul className="vl-checklist">{plan.checks.map(check => <li key={check.label} className={check.ok ? 'ok' : 'warn'}>{check.ok ? <CircleCheck size={15} aria-hidden="true" /> : <CircleAlert size={15} aria-hidden="true" />}<span>{check.label}</span></li>)}</ul>
      <ol>{plan.sequence.map(step => <li key={step}>{step.replace(/^\d+\.\s*/, '')}</li>)}</ol>
      {plan.legs.filter(leg => leg.venue !== 'var').map(leg => <p className="vl-note" key={leg.venue}>{venueLabel(leg.venue)}：<code>{JSON.stringify(leg.fields)}</code></p>)}
    </div>)}</div> : <TableEmpty>还没有样本，无法生成计划</TableEmpty>}
  </section>;
}

export function TradesPanel({ title, trades, empty }: { title: string; trades: readonly LiveTradeView[]; empty: string }) {
  const shown = [...trades].reverse().slice(0, 100);
  return <section className="panel" aria-label={title}>
    <div className="panel-heading"><h2>{title}</h2><span className="muted">{trades.length > shown.length ? `最近 ${shown.length} / ${trades.length} 笔` : `${trades.length} 笔`}</span></div>
    {shown.length ? <TradeTable trades={shown} /> : <TableEmpty>{empty}</TableEmpty>}
  </section>;
}

export function TradeTable({ trades }: { trades: readonly LiveTradeView[] }) {
  return <div className="vl-table"><table>
    <thead><tr><th>平仓时间</th><th>标的 · 方向</th><th className="num">名义</th><th className="num">入场 / 出场价差</th><th className="num">入场基线</th><th className="num">持有</th><th>原因</th><th className="num">毛 / 成本</th><th className="num">净</th></tr></thead>
    <tbody>{trades.map(trade => <tr key={trade.id}>
      <td>{stampText(trade.closedAt)}<small>开 {stampText(trade.openedAt)}</small></td>
      <td>{pairLabel(trade.symbol).symbol}<small>{pairLabel(trade.symbol).short ? `${pairLabel(trade.symbol).short} · ` : ''}{directionLabel(trade.direction, pairLabel(trade.symbol).a, pairLabel(trade.symbol).b)}{trade.estimated ? ' · 估' : ''}</small></td>
      <td className="num">{usd(trade.notionalUsd, 0)}</td>
      <td className="num">{bps(trade.entrySpread)} / {bps(trade.exitSpread)}
        {trade.entryVarSource || trade.exitVarSource ? <small>Var {trade.entryVarSource ? VAR_QUOTE_LABELS[trade.entryVarSource] : '未记录'} / {trade.exitVarSource ? VAR_QUOTE_LABELS[trade.exitVarSource] : '未记录'}</small> : null}</td>
      <td className="num">{bps(trade.entryBaseline)}<small>{REGIME_LABELS[trade.entryRegime]}</small></td>
      <td className="num">{duration(trade.closedAt - trade.openedAt)}</td>
      <td>{reasonLabel(trade.reason)}</td>
      <td className="num">{signedUsd(trade.grossUsd)}<small>{usd(trade.costUsd)}</small></td>
      <td className={`num vl-${tone(trade.netUsd) || 'dim'}`}>{signedUsd(trade.netUsd)}<small>{bps(trade.netBps)} 基点</small></td>
    </tr>)}</tbody></table></div>;
}
