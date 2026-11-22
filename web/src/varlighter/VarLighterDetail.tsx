// 标的详情页签：价差走势与基线、分时段统计与建议阈值、参数（回测与保存）、下单预演、该标的的模拟成交。
import { useEffect, useMemo, useState } from 'react';
import { CircleCheck, CircleAlert, LoaderCircle, Play, Save } from 'lucide-react';
import { api } from '../api.ts';
import { Callout, StatePanel, TableEmpty } from '../StateViews.tsx';
import { useLiveResource } from '../use-live-resource.ts';
import type { ClosedTrade } from '../../../src/varlighter/strategy.ts';
import type { BacktestView, StateView, SymbolView } from '../../../src/varlighter/views.ts';
import { Badge, EquityChart, Metric, SpreadChart, SpreadLegend, stampText, useWrite } from './parts.tsx';
import {
  ALL_DIRECTIONS, BACKTEST_HOURS, DIRECTION_LABELS, IDENTITY_LABELS, REASON_LABELS, REGIME_LABELS, SYMBOL_FIELDS, VARLIGHTER_BASE, backtestBody, bps,
  chartRows, duration, fundingAnnual, percent, plain, price, settingsBody, signal, signedUsd, symbolForm, symbolRequest, tone, usd, varLighterHref, pairLabel, type SymbolForm,
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
        {view.rows.map(row => <option key={row.key} value={row.key}>{row.symbol} · {row.venueName} · {row.name}</option>)}</select></label>
      <div className="vl-seg" role="group" aria-label="时间范围">{RANGES.map(item => <button type="button" key={item.hours} aria-pressed={hours === item.hours} onClick={() => setHours(item.hours)}>{item.label}</button>)}</div>
      <span className="grow" />
      {live.status === 'loading' || (live.data && !data) ? <span className="muted"><LoaderCircle size={13} className="spin" aria-hidden="true" /> 读取中</span> : data ? <span className="muted">{data.samples.toLocaleString()} 个样本</span> : null}
    </div></div>
    {chosen === null ? <StatePanel kind="empty" title="还没有共同标的" detail="两边的标的目录与报价到达后这里显示。" />
      : !data ? live.error ? <StatePanel kind="error" title="读取标的失败" detail={live.error.message} /> : <StatePanel kind="loading" title="加载中…" />
        : <Detail data={data} view={view} onChanged={async () => { await Promise.all([onChanged(), live.refresh()]); }} />}
  </>;
}

function Detail({ data, view, onChanged }: { data: SymbolView; view: StateView; onChanged: () => Promise<void> }) {
  const row = view.rows.find(item => item.key === data.key) ?? null;
  const rows = useMemo(() => chartRows(data.points, data.params.entryBps), [data.points, data.params.entryBps]);
  const latest = data.latest;
  const funding = fundingAnnual(latest?.varFunding ?? null, latest?.rhFunding ?? null);
  return <>
    {data.identity === 'mismatch' ? <Callout tone="error">两边价格相差 {plain(data.gapBps, 0)} 基点，合约规格不同（可能是不同的标的或不同的报价单位），不能交易。</Callout>
      : !data.eligible ? <Callout tone="warning">该标的的两边规格还没有人工确认（价格相差 {plain(data.gapBps, 0)} 基点）。确认前只采集、可回测，模拟盘不开仓。<a href={varLighterHref('ready')}>去实盘准备页确认</a></Callout> : null}
    <section className="vl-metrics" aria-label={`${data.symbol} 读数`}>
      <Metric label="中间价基差" value={`${bps(row?.mid ?? null)} 基点`} foot={latest ? `样本 ${stampText(latest.t)} · ${REGIME_LABELS[latest.regime]}` : '无样本'} />
      <Metric label="基线中位数 ± σ" value={row?.baseline ? `${bps(row.baseline.median)} ± ${plain(row.baseline.sigma)}` : '样本不足'} foot={row?.baseline ? `${row.baseline.fallback ? '全天' : REGIME_LABELS[row.baseline.regime]}基线 · ${row.baseline.samples} 个样本 · 窗口 ${data.global.windowHours} 小时` : `至少 ${data.global.minSamples} 个样本`} />
      <Metric label="卖 Var / 买 Var 偏离" value={`${bps(row?.rich ?? null)} / ${bps(row?.cheap ?? null)}`} foot={`入场 ${plain(data.params.entryBps)} · 出场 ${plain(data.params.exitBps)} · ${data.bucket} 档${row?.estimated ? ' · Lighter 一档估算' : ''}`} />
      <Metric label="资金费（年化）" value={`${funding.var} / ${funding.rh}`} foot="Var / Lighter，只作参考" />
      <Metric label={`${data.venueName} 合约`} value={`#${data.rh.marketId}`} foot={`最小 ${data.rh.minBase} 个 / ${data.rh.minQuote} USDC · 数量 ${data.rh.sizeDecimals} 位 · 价格 ${data.rh.priceDecimals} 位 · 规格${IDENTITY_LABELS[data.identity]}`} />
    </section>
    <section className="panel" aria-label="价差走势">
      <div className="panel-heading"><h2>{data.symbol} · {data.venueName} 价差走势</h2><span className="muted">{data.kindName} · 单位基点 · 基线按样本当时之前的窗口计算，不含未来</span></div>
      {rows.length ? <><div className="vl-chart"><SpreadChart rows={rows} trades={data.trades} from={data.from} to={data.to} label={`${data.symbol} ${data.venueName} 价差走势`} /></div><SpreadLegend /></>
        : <TableEmpty>这个范围内还没有样本</TableEmpty>}
    </section>
    <StatsPanel data={data} />
    <div className="vl-columns">
      <ParamsPanel data={data} view={view} onChanged={onChanged} />
      <PlanPanel data={data} />
    </div>
    <TradesPanel title={`${data.symbol} · ${data.venueName} 模拟成交`} trades={data.trades} empty="这个范围内没有模拟成交" />
  </>;
}

function StatsPanel({ data }: { data: SymbolView }) {
  return <section className="panel" aria-label="分时段统计">
    <div className="panel-heading"><h2>分时段统计</h2><span className="muted">所选范围内的样本 · 建议入场 = 偏离 95 分位 − 半个往返成本（不低于 5）</span></div>
    {data.stats.length ? <div className="vl-table"><table>
      <thead><tr><th>时段</th><th className="num">样本</th><th className="num">中位数</th><th className="num">σ（MAD）</th><th className="num">5% – 95%</th><th className="num">往返成本</th>
        <th className="num">半衰期</th><th className="num">穿越 / 天</th><th className="num">机会占比</th><th className="num">偏离 95%</th><th className="num">建议入场</th></tr></thead>
      <tbody>{data.stats.map(item => <tr key={item.regime}>
        <td>{REGIME_LABELS[item.regime]}</td><td className="num">{item.samples.toLocaleString()}</td><td className="num">{bps(item.median)}</td><td className="num">{plain(item.sigma)}</td>
        <td className="num">{bps(item.p05)} – {bps(item.p95)}</td><td className="num">{plain(item.costMedian)}</td>
        <td className="num">{item.halfLifeMin === null ? '不回归' : duration(item.halfLifeMin * 60_000)}</td><td className="num">{plain(item.crossingsPerDay)}</td>
        <td className="num">{percent(item.opportunityShare, 1)}</td><td className="num">{plain(item.deviation95)}</td><td className="num">{item.suggestedEntryBps ?? '—'}</td>
      </tr>)}</tbody></table></div> : <TableEmpty>样本不足，无法统计</TableEmpty>}
    <p className="vl-note">半衰期按相邻 3 分钟内的样本做 AR(1) 估计；机会占比是按当前入场阈值，卖 Var 或买 Var 的可成交价差偏离中位数达到阈值的样本比例。</p>
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
  const saved = JSON.stringify(data.params) === (parsed.ok ? JSON.stringify(parsed.value) : '');
  const set = (patch: Partial<SymbolForm>) => setForm(current => ({ ...current, ...patch }));
  const runBacktest = () => {
    const body = backtestBody(data.key, btHours, form, data.global);
    if (!body.ok) return;
    void write.run('backtest', () => api<BacktestView>(`${VARLIGHTER_BASE}/backtest`, { body: body.value, timeoutMs: 60_000 }), value => { setResult(value); return `回测完成：${value.summary.trades} 笔，净 ${signedUsd(value.summary.netUsd)}`; });
  };
  const save = () => {
    if (!parsed.ok) return;
    void write.run('save', () => api(`${VARLIGHTER_BASE}/settings`, { body: settingsBody(view.settings, { symbol: { symbol: data.key, params: parsed.value } }) }), () => { void onChanged(); return '参数已保存，模拟盘从下一个样本起按新参数运行'; });
  };
  return <section className="panel" aria-label="参数与回测">
    <div className="panel-heading"><h2>参数与回测</h2><span className="muted">{saved ? '与已保存参数一致' : '有未保存的修改'}</span></div>
    <div className="vl-fields">
      {SYMBOL_FIELDS.map(field => <label className="vl-field" key={field.key}>{field.label}（{field.unit}）
        <input inputMode="decimal" value={form[field.key]} onChange={event => set({ [field.key]: event.target.value } as Partial<SymbolForm>)} />
        {field.hint ? <small>{field.hint}</small> : null}</label>)}
    </div>
    <div className="vl-options"><b>允许开仓的时段（不影响平仓）</b>{data.regimes.map(regime => <label key={regime}><input type="checkbox" checked={form.regimes.includes(regime)}
      onChange={event => set({ regimes: event.target.checked ? [...form.regimes, regime] : form.regimes.filter(item => item !== regime) })} />{REGIME_LABELS[regime]}</label>)}</div>
    <div className="vl-options"><b>方向</b>{ALL_DIRECTIONS.map(direction => <label key={direction}><input type="checkbox" checked={form.directions.includes(direction)}
      onChange={event => set({ directions: event.target.checked ? [...form.directions, direction] : form.directions.filter(item => item !== direction) })} />{DIRECTION_LABELS[direction]}</label>)}</div>
    <div className="vl-options"><label><input type="checkbox" checked={form.enabled} disabled={!data.eligible && !form.enabled} onChange={event => set({ enabled: event.target.checked })} />模拟盘启用该标的</label>
      {!data.eligible ? <span className="vl-warn">规格确认后才能启用</span> : null}</div>
    <div className="vl-actions">
      <label className="vl-field">回测范围<select value={btHours} onChange={event => setBtHours(Number(event.target.value))}>{BACKTEST_HOURS.map(value => <option key={value} value={value}>最近 {value / 24} 天</option>)}</select></label>
      <button type="button" className="button secondary" disabled={!parsed.ok || write.busy !== null} onClick={runBacktest}>{write.busy === 'backtest' ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}按表单参数回测</button>
      <button type="button" className="button primary" disabled={!parsed.ok || saved || write.busy !== null} onClick={save}>{write.busy === 'save' ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Save size={14} aria-hidden="true" />}保存为模拟盘参数</button>
      {!parsed.ok ? <Callout tone="warning" role="status">{parsed.error}</Callout> : null}
      {write.message ? <Callout tone={write.message.tone}>{write.message.text}</Callout> : null}
    </div>
    {result ? <BacktestResultView result={result} /> : <p className="vl-note">回测用已采集的样本按时间重放，规则与模拟盘相同（基线不看未来、同一套风控与成本），按公开报价当时的价格成交。不改已保存的参数。</p>}
  </section>;
}

function BacktestResultView({ result }: { result: BacktestView }) {
  const summary = result.summary;
  const blocked = Object.entries(summary.blocked).sort((a, b) => b[1] - a[1]);
  const reasons = Object.entries(summary.reasons);
  return <div aria-label="回测结果">
    <div className="vl-metrics inset">
      <Metric label="净盈亏" value={signedUsd(summary.netUsd)} tone={tone(summary.netUsd)} foot={`毛 ${signedUsd(summary.grossUsd)} · 成本 ${usd(summary.costUsd)}`} />
      <Metric label="成交" value={`${summary.trades} 笔`} foot={`胜率 ${percent(summary.winRate)} · 平均 ${bps(summary.avgNetBps)} 基点`} />
      <Metric label="最大回撤" value={usd(summary.maxDrawdownUsd)} foot={`平均持有 ${duration(summary.avgHoldMinutes === null ? null : summary.avgHoldMinutes * 60_000)}`} />
      <Metric label="资金费估算" value={signedUsd(summary.fundingUsd)} foot={summary.openMarkUsd === null ? '期末无持仓 · 不计入净盈亏' : `期末持仓估值 ${signedUsd(summary.openMarkUsd)} · 资金费不计入`} />
    </div>
    {result.equity.length > 1 ? <div className="vl-chart small"><EquityChart points={result.equity} label="回测累计净盈亏" /></div> : null}
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
      <h3>{DIRECTION_LABELS[plan.direction]} {plan.ready ? <Badge tone="ok">可下单</Badge> : <Badge tone="warn">未就绪</Badge>}</h3>
      <div className="vl-table"><table><thead><tr><th>腿</th><th className="num">数量</th><th className="num">预期价</th><th className="num">限价</th></tr></thead>
        <tbody>{plan.legs.map(leg => <tr key={leg.venue}><td>{leg.venue === 'var' ? 'Var' : data.venueName} {leg.side === 'buy' ? '买入' : '卖出'}<small>{usd(leg.notionalUsd)}</small></td>
          <td className="num">{leg.qty}</td><td className="num">{price(leg.expected)}</td><td className="num">{leg.limit}</td></tr>)}</tbody></table></div>
      <ul className="vl-checklist">{plan.checks.map(check => <li key={check.label} className={check.ok ? 'ok' : 'warn'}>{check.ok ? <CircleCheck size={15} aria-hidden="true" /> : <CircleAlert size={15} aria-hidden="true" />}<span>{check.label}</span></li>)}</ul>
      <ol>{plan.sequence.map(step => <li key={step}>{step.replace(/^\d+\.\s*/, '')}</li>)}</ol>
      <p className="vl-note"><code>{JSON.stringify(plan.legs[1]?.fields ?? {})}</code></p>
    </div>)}</div> : <TableEmpty>还没有样本，无法生成计划</TableEmpty>}
  </section>;
}

export function TradesPanel({ title, trades, empty }: { title: string; trades: readonly ClosedTrade[]; empty: string }) {
  const shown = [...trades].reverse().slice(0, 100);
  return <section className="panel" aria-label={title}>
    <div className="panel-heading"><h2>{title}</h2><span className="muted">{trades.length > shown.length ? `最近 ${shown.length} / ${trades.length} 笔` : `${trades.length} 笔`}</span></div>
    {shown.length ? <TradeTable trades={shown} /> : <TableEmpty>{empty}</TableEmpty>}
  </section>;
}

export function TradeTable({ trades }: { trades: readonly ClosedTrade[] }) {
  return <div className="vl-table"><table>
    <thead><tr><th>平仓时间</th><th>标的 · 方向</th><th className="num">名义</th><th className="num">入场 / 出场价差</th><th className="num">入场基线</th><th className="num">持有</th><th>原因</th><th className="num">毛 / 成本</th><th className="num">净</th></tr></thead>
    <tbody>{trades.map(trade => <tr key={trade.id}>
      <td>{stampText(trade.closedAt)}<small>开 {stampText(trade.openedAt)}</small></td>
      <td>{pairLabel(trade.symbol).symbol}<small>{pairLabel(trade.symbol).short ? `${pairLabel(trade.symbol).short} · ` : ''}{DIRECTION_LABELS[trade.direction]}{trade.estimated ? ' · 估' : ''}</small></td>
      <td className="num">{usd(trade.notionalUsd, 0)}</td>
      <td className="num">{bps(trade.entrySpread)} / {bps(trade.exitSpread)}</td>
      <td className="num">{bps(trade.entryBaseline)}<small>{REGIME_LABELS[trade.entryRegime]}</small></td>
      <td className="num">{duration(trade.closedAt - trade.openedAt)}</td>
      <td>{REASON_LABELS[trade.reason] ?? trade.reason}</td>
      <td className="num">{signedUsd(trade.grossUsd)}<small>{usd(trade.costUsd)}</small></td>
      <td className={`num vl-${tone(trade.netUsd) || 'dim'}`}>{signedUsd(trade.netUsd)}<small>{bps(trade.netBps)} 基点</small></td>
    </tr>)}</tbody></table></div>;
}
