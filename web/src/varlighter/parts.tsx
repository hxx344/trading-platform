// DEX 价差页共用的小部件：指标卡、标记、写操作状态、价差走势图与累计盈亏图。
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../api.ts';
import { SvgPlot, type PlotLayer } from '../svg-plot.tsx';
import { niceAxis } from '../svg-plot-geometry.ts';
import type { ClosedTrade } from '../../../src/varlighter/strategy.ts';
import { bps, chartRange, clamp, signedUsd, type ChartRow } from './varlighter-form.ts';

export function Metric({ label, value, foot, tone = '', accent = false }: { label: ReactNode; value: ReactNode; foot?: ReactNode; tone?: string; /** 需要注意的读数：整张卡用强调色 */ accent?: boolean }) {
  return <div className={accent ? 'vl-metric accent' : 'vl-metric'}><span>{label}</span><strong className={tone ? `vl-${tone}` : undefined}>{value}</strong>{foot ? <small>{foot}</small> : null}</div>;
}
export function Badge({ tone = '', children }: { tone?: 'ok' | 'warn' | 'bad' | 'info' | ''; children: ReactNode }) {
  return <span className={`vl-badge${tone ? ` ${tone}` : ''}`}>{children}</span>;
}

export type WriteMessage = { tone: 'success' | 'error' | 'warning'; text: string };
/** 一次只跑一个写操作；有 HTTP 状态的失败是服务端的明确答复，没有状态的（超时、断网）提示结果未知、刷新核对。 */
export function useWrite() {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<WriteMessage | null>(null);
  const running = useRef(false);
  const run = useCallback(async <T,>(key: string, send: () => Promise<T>, done: (result: T) => string): Promise<T | null> => {
    if (running.current) return null;
    running.current = true; setBusy(key); setMessage(null);
    try {
      const result = await send();
      setMessage({ tone: 'success', text: done(result) });
      return result;
    } catch (error) {
      if (error instanceof ApiError) setMessage({ tone: 'error', text: error.message });
      else setMessage({ tone: 'warning', text: `${error instanceof Error ? error.message : String(error)}（结果未知，请刷新核对）` });
      return null;
    } finally { running.current = false; setBusy(null); }
  }, []);
  const clear = useCallback(() => setMessage(null), []);
  return { busy, message, run, clear };
}

const MARGIN = { top: 12, right: 56, bottom: 30 };
export const timeTick = (span: number) => (time: number): string => {
  const date = new Date(time);
  if (span <= 2 * 86_400_000) return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return `${date.getMonth() + 1}/${date.getDate()}`;
};
export const stampText = (time: number) => new Date(time).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

const SPREAD_LAYERS: PlotLayer[] = [
  { kind: 'area', key: 'upper', lower: 'lower', fill: 'var(--accent)', opacity: 0.08 },
  { kind: 'line', key: 'upper', color: 'var(--text-tertiary)', width: 1, dash: '3 3' },
  { kind: 'line', key: 'lower', color: 'var(--text-tertiary)', width: 1, dash: '3 3' },
  { kind: 'line', key: 'median', color: 'var(--text-secondary)', width: 1.25, dash: '6 4' },
  { kind: 'line', key: 'sellA', color: 'var(--emerald)', width: 1, opacity: 0.75 },
  { kind: 'line', key: 'buyA', color: 'var(--error)', width: 1, dash: '4 2', opacity: 0.75 },
  { kind: 'line', key: 'mid', color: 'var(--accent)', width: 1.75, active: true },
];

/** 价差走势：中间价基差、两个方向的可成交价差、基线中位数与入场带；开平仓画在可成交价差上。 */
export function SpreadChart({ rows, trades, from, to, label, aName = 'A' }: { rows: readonly ChartRow[]; trades: readonly ClosedTrade[]; from: number; to: number; label: string; /** A 腿场所的简称 */ aName?: string }) {
  const range = useMemo(() => chartRange(rows), [rows]);
  const samples = useMemo(() => rows.filter(row => row.mid !== null), [rows]);
  const axis = useMemo(() => range ? niceAxis(range[0], range[1]) : null, [range]);
  const tick = useMemo(() => timeTick(to - from), [from, to]);
  if (!axis) return null;
  const domain = axis.domain;
  const inside = trades.filter(trade => trade.closedAt >= from && trade.openedAt <= to);
  return <SvgPlot rows={rows} hoverRows={samples} xDomain={[from, to]} yDomain={domain} yTicks={axis.ticks} yTick={value => bps(value, 0)} xTick={tick}
    layers={SPREAD_LAYERS} margin={MARGIN} height={320} label={label}
    tooltip={row => { const item = row as ChartRow; return <div className="vl-tip"><b>{stampText(item.time)}</b>
      <span>中间价基差</span><span>{bps(item.mid)}</span><span>卖 {aName} 价差</span><span>{bps(item.sellA)}</span><span>买 {aName} 价差</span><span>{bps(item.buyA)}</span>
      <span>基线中位数</span><span>{bps(item.median)}</span><span>入场上 / 下线</span><span>{bps(item.upper)} / {bps(item.lower)}</span></div>; }}
    overlay={scales => <g aria-hidden="true">{inside.map(trade => <g key={trade.id}>
      {trade.openedAt >= from ? <circle className="vl-marker-open" data-outside={clamp(trade.entrySpread, domain) !== trade.entrySpread || undefined} cx={scales.x(trade.openedAt)} cy={scales.y(clamp(trade.entrySpread, domain))} r={4} /> : null}
      <circle className="vl-marker-close" data-outside={clamp(trade.exitSpread, domain) !== trade.exitSpread || undefined} cx={scales.x(trade.closedAt)} cy={scales.y(clamp(trade.exitSpread, domain))} r={3.5} />
    </g>)}</g>} />;
}
export function SpreadLegend({ aName = 'A' }: { aName?: string }) {
  return <div className="vl-legend">
    <span><i className="mid" />中间价基差</span><span><i className="sell" />卖 {aName} 可成交价差</span><span><i className="buy" />买 {aName} 可成交价差</span>
    <span><i className="median" />基线中位数</span><span><i className="band" />入场带（中位数 ± 入场偏离）</span><span><i className="open" />开仓</span><span><i className="close" />平仓</span><span>边框虚线圈表示成交价差超出纵轴</span>
  </div>;
}

const EQUITY_LAYERS: PlotLayer[] = [{ kind: 'line', key: 'net', color: 'var(--accent)', width: 1.75, active: true, step: true }];
/** 累计净盈亏（每笔平仓后的值，按平仓时刻跳变）。 */
export function EquityChart({ points, label }: { points: readonly { t: number; net: number }[]; label: string }) {
  const rows = useMemo(() => points.map(point => ({ time: point.t, net: point.net })), [points]);
  if (rows.length < 2) return null;
  const from = rows[0]!.time, to = rows.at(-1)!.time;
  const values = rows.map(row => row.net);
  const axis = niceAxis(Math.min(0, ...values), Math.max(0, ...values));
  // 刻度间隔小于 1 美元时带小数，否则小额盈亏会显示成一排 $0。
  const step = axis.ticks.length > 1 ? Math.abs(axis.ticks[1]! - axis.ticks[0]!) : 1;
  const digits = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  return <SvgPlot rows={rows} xDomain={[from, to > from ? to : from + 60_000]} yDomain={axis.domain} yTicks={axis.ticks} yTick={value => signedUsd(Math.abs(value) < step / 1e6 ? 0 : value, digits)} xTick={timeTick(to - from)}
    layers={EQUITY_LAYERS} references={[{ y: 0, color: 'var(--surface-6)' }]} margin={MARGIN} height={200} label={label}
    tooltip={row => { const item = row as { time: number; net: number }; return <div className="vl-tip"><b>{stampText(item.time)}</b><span>累计净盈亏</span><span>{signedUsd(item.net)}</span></div>; }} />;
}
