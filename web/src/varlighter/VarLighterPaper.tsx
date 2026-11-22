// 模拟盘页签：持仓（可手动平仓）、累计盈亏、按日汇总、成交与事件，以及清空模拟盘。
import { useState } from 'react';
import { LoaderCircle, RotateCcw, X } from 'lucide-react';
import { api } from '../api.ts';
import { Callout, StatePanel, TableEmpty } from '../StateViews.tsx';
import { useLiveResource } from '../use-live-resource.ts';
import type { PaperView, StateView } from '../../../src/varlighter/views.ts';
import { TradesPanel } from './VarLighterDetail.tsx';
import { Badge, EquityChart, Metric, stampText, useWrite } from './parts.tsx';
import { DIRECTION_LABELS, VARLIGHTER_BASE, bps, duration, pairLabel, percent, price, signedUsd, tone, usd, varLighterHref } from './varlighter-form.ts';

const PAPER_PATH = `${VARLIGHTER_BASE}/paper`;

export function VarLighterPaper({ view, onChanged, onExpired }: { view: StateView; onChanged: () => Promise<void>; onExpired: () => void }) {
  const live = useLiveResource<PaperView>(PAPER_PATH, { intervalMs: 10_000, timeoutMs: 15_000, onExpired });
  const data = live.data;
  const write = useWrite();
  const [resetText, setResetText] = useState('');
  const refresh = async () => { await Promise.all([live.refresh(), onChanged()]); };
  if (!data) return live.error ? <StatePanel kind="error" title="读取模拟盘失败" detail={live.error.message} /> : <StatePanel kind="loading" title="加载中…" />;
  const totals = data.totals, limits = data.limits;
  const close = (symbol: string) => {
    const label = `${pairLabel(symbol).symbol}（${pairLabel(symbol).short || '—'}）`;
    if (!confirm(`按最新报价平掉 ${label} 的模拟持仓？`)) return;
    void write.run(`close:${symbol}`, () => api<{ netUsd: number }>(`${PAPER_PATH}/close`, { body: { symbol } }), trade => { void refresh(); return `${label} 已平仓，净 ${signedUsd(trade.netUsd)}`; });
  };
  const reset = () => {
    void write.run('reset', () => api(`${PAPER_PATH}/reset`, { body: { confirm: resetText } }), () => { setResetText(''); void refresh(); return '模拟盘已清空：持仓、成交与冷却全部清除，参数保留'; });
  };
  return <>
    {limits.paused ? <Callout tone="warning">模拟盘已暂停：不开新仓，已有持仓照常按规则平仓。在<a href={varLighterHref('ready')}>实盘准备页</a>恢复。</Callout> : null}
    {write.message ? <Callout tone={write.message.tone}>{write.message.text}</Callout> : null}
    <section className="vl-metrics" aria-label="模拟盘汇总">
      <Metric label="累计净盈亏" value={signedUsd(totals.netUsd)} tone={tone(totals.netUsd)} foot={totals.first ? `自 ${stampText(totals.first)} 起` : '还没有成交'} />
      <Metric label="成交笔数" value={totals.trades} foot={`胜率 ${totals.trades ? percent(totals.wins / totals.trades) : '—'}`} />
      <Metric label="今日（UTC）" value={signedUsd(data.todayNetUsd)} tone={tone(data.todayNetUsd)} foot={`亏损上限 ${usd(limits.dailyLossLimitUsd, 0)}`} />
      <Metric label="持仓" value={`${data.positions.length} / ${limits.maxOpenPositions} 笔`} foot={`名义 ${usd(data.openNotionalUsd, 0)} / ${usd(limits.maxTotalNotionalUsd, 0)}`} />
    </section>
    <section className="panel" aria-label="模拟持仓">
      <div className="panel-heading"><h2>模拟持仓</h2><span className="muted">浮动盈亏按最新样本的可成交价，已扣平仓成本</span></div>
      {data.positions.length ? <div className="vl-table"><table>
        <thead><tr><th>标的 · 方向</th><th className="num">名义 · 数量</th><th className="num">开仓价 Var / 对手</th><th className="num">入场价差 / 基线</th><th className="num">持有</th><th className="num">浮动</th><th /></tr></thead>
        <tbody>{data.positions.map(position => <tr key={position.id}>
          <td><a className="vl-symbol" href={varLighterHref('detail', position.symbol)}>{pairLabel(position.symbol).symbol}</a><small>{pairLabel(position.symbol).short} · {DIRECTION_LABELS[position.direction]}{position.estimated ? ' · 估' : ''}</small></td>
          <td className="num">{usd(position.notionalUsd, 0)}<small>{price(position.qty)}</small></td>
          <td className="num">{price(position.varEntry)} / {price(position.rhEntry)}</td>
          <td className="num">{bps(position.entrySpread)} / {bps(position.entryBaseline)}</td>
          <td className="num">{duration(data.now - position.openedAt)}<small>上限 {duration(position.maxHoldMinutes * 60_000)}</small></td>
          <td className={`num vl-${tone(position.mark?.netUsd) || 'dim'}`}>{position.mark ? <>{signedUsd(position.mark.netUsd)}<small>{bps(position.mark.pnlBps)} 基点 · {stampText(position.mark.at)}</small></> : '无可成交价'}</td>
          <td><button type="button" className="button secondary" disabled={write.busy !== null} onClick={() => close(position.symbol)}>{write.busy === `close:${position.symbol}` ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <X size={14} aria-hidden="true" />}平仓</button></td>
        </tr>)}</tbody></table></div> : <TableEmpty>{view.rows.some(row => row.enabled) ? '没有持仓，等待价差偏离到入场阈值' : '还没有启用任何标的，在标的详情里调好参数后启用'}</TableEmpty>}
    </section>
    <div className="vl-columns">
      <section className="panel" aria-label="累计净盈亏">
        <div className="panel-heading"><h2>累计净盈亏</h2><span className="muted">最近 30 天，每笔平仓后的值</span></div>
        {data.equity.length > 1 ? <div className="vl-chart small"><EquityChart points={data.equity} label="模拟盘累计净盈亏" /></div> : <TableEmpty>至少两笔成交后显示</TableEmpty>}
      </section>
      <section className="panel" aria-label="按日汇总">
        <div className="panel-heading"><h2>按日汇总</h2><span className="muted">UTC 日</span></div>
        {data.daily.length ? <div className="vl-table"><table><thead><tr><th>日期</th><th className="num">笔数</th><th className="num">净盈亏</th></tr></thead>
          <tbody>{[...data.daily].reverse().map(day => <tr key={day.day}><td>{new Date(day.day).toISOString().slice(0, 10)}</td><td className="num">{day.trades}</td><td className={`num vl-${tone(day.netUsd) || 'dim'}`}>{signedUsd(day.netUsd)}</td></tr>)}</tbody></table></div>
          : <TableEmpty>还没有成交</TableEmpty>}
      </section>
    </div>
    <TradesPanel title="模拟成交" trades={data.trades} empty="还没有成交" />
    <div className="vl-columns">
      <section className="panel" aria-label="事件">
        <div className="panel-heading"><h2>事件</h2><span className="muted">最近 {data.events.length} 条</span></div>
        {data.events.length ? <ul className="vl-events">{data.events.map(event => <li key={event.id}><time>{stampText(event.at)}</time><span><b>{event.symbol ? `${pairLabel(event.symbol).symbol}${pairLabel(event.symbol).short ? ` ${pairLabel(event.symbol).short}` : ''}` : '全局'}</b>{event.message}</span></li>)}</ul> : <TableEmpty>暂无事件</TableEmpty>}
      </section>
      <section className="panel" aria-label="清空模拟盘">
        <div className="panel-heading"><h2>清空模拟盘</h2><Badge tone="warn">不可撤销</Badge></div>
        <p className="vl-note">删除全部模拟持仓、成交与冷却记录，重新累计。参数、确认过的规格和采集的样本都保留。输入 RESET 确认。</p>
        <div className="vl-actions"><input value={resetText} onChange={event => setResetText(event.target.value)} placeholder="RESET" aria-label="输入 RESET 确认" />
          <button type="button" className="button secondary" disabled={resetText !== 'RESET' || write.busy !== null} onClick={reset}>{write.busy === 'reset' ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <RotateCcw size={14} aria-hidden="true" />}清空</button></div>
      </section>
    </div>
  </>;
}
