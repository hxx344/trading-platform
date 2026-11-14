// 改编自工作台 modules/crossex/src/PositionCharts.tsx（提交 7745181）：本服务没有 recharts，价差趋势改用 SvgPlot，
// 收益构成的环形图手画 SVG；序列、断线规则（相邻采样超过 5 分钟断开）、文案与说明不变。
import { useMemo } from 'react';
import Decimal from './decimal.mjs';
import { SvgPlot, type PlotLayer } from '../svg-plot.tsx';
import { niceAxis } from '../svg-plot-geometry.ts';
import type { PositionSample } from './position-history.ts';
import { POSITION_HISTORY_GAP_MS } from './position-history.ts';
import { percentage } from './position-view.ts';

const chartTime = (at: number) => new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
const D = Decimal.clone({ precision: 100 });
const LAYERS: PlotLayer[] = [{ kind: 'line', key: 'value', color: 'var(--accent)', width: 2, active: true }];

function SpreadTrend({ samples }: { samples: PositionSample[] }) {
  const data = useMemo(() => samples.flatMap((sample, index) => {
    const parsed = sample.spread === null ? null : new D(sample.spread).mul(100).toNumber();
    const point = { time: sample.at, value: parsed !== null && Number.isFinite(parsed) ? parsed : null };
    return index && sample.at - samples[index - 1].at > POSITION_HISTORY_GAP_MS
      ? [{ time: samples[index - 1].at + 1, value: null }, point] : [point];
  }), [samples]);
  const valid = data.filter((point): point is { time: number; value: number } => point.value !== null);
  const axis = useMemo(() => valid.length ? niceAxis(Math.min(...valid.map(point => point.value)), Math.max(...valid.map(point => point.value)), 4) : null, [valid]);
  if (valid.length < 2 || !axis) return <figure className="position-trend"><figcaption>价差趋势 · 最近 24h</figcaption><div className="position-trend-empty">等待至少两个有效采样点<small>仅记录本次页面会话，不补填历史数据</small></div></figure>;
  const first = valid[0], last = valid[valid.length - 1], minutes = Math.floor((last.time - first.time) / 60_000);
  return <figure className="position-trend" aria-label={`本会话价差趋势，${valid.length}个采样点，覆盖${minutes}分钟`}>
    <figcaption><span>价差趋势 · 最近 24h</span><span>本会话覆盖 {minutes < 60 ? `${minutes} 分钟` : `${(minutes / 60).toFixed(1)} 小时`}</span></figcaption>
    <div className="position-trend-chart">
      <SvgPlot rows={data} xDomain={[data[0].time, data[data.length - 1].time]} yDomain={axis.domain} yTicks={axis.ticks} yTick={value => `${Number(value.toPrecision(4))}%`} xTick={chartTime}
        layers={LAYERS} margin={{ top: 8, right: 54, bottom: 26 }} height={125} label={`本会话价差趋势，${valid.length} 个采样点`}
        tooltip={row => { const value = (row as unknown as { value: number | null }).value; return value === null ? null : <span>{chartTime(row.time)} 价差 {Number(value).toPrecision(4)}%</span>; }}/>
    </div>
    <p className="metrics-note">{chartTime(first.time)} {percentage(new D(first.value).div(100).toString())} → {chartTime(last.time)} {percentage(new D(last.value).div(100).toString())}；超过 5 分钟的采样间隔显示断线。</p>
  </figure>;
}

/** One ring segment from fraction start to end (0..1, clockwise from the top), centre (45, 45) like the workbench pie. */
function arc(start: number, end: number, outer = 43, inner = 29): string {
  const point = (fraction: number, radius: number) => {
    const angle = fraction * 2 * Math.PI - Math.PI / 2;
    return `${(45 + radius * Math.cos(angle)).toFixed(3)} ${(45 + radius * Math.sin(angle)).toFixed(3)}`;
  };
  const large = end - start > 0.5 ? 1 : 0;
  return `M ${point(start, outer)} A ${outer} ${outer} 0 ${large} 1 ${point(end, outer)} L ${point(end, inner)} A ${inner} ${inner} 0 ${large} 0 ${point(start, inner)} Z`;
}

function Composition({ values }: { values: [string, string] }) {
  const total = new D(values[0]).plus(values[1]);
  const share = new D(values[0]).div(total).toNumber();
  // A full ring cannot be one arc; split at the half so either part may be the whole.
  const segments = [{ name: '价差收益', from: 0, to: share, fill: 'var(--accent)' }, { name: '资金费收益', from: share, to: 1, fill: 'var(--emerald)' }]
    .filter(segment => segment.to - segment.from > 1e-9)
    .flatMap(segment => segment.to - segment.from > 0.5 ? [{ ...segment, to: segment.from + 0.5 }, { ...segment, from: segment.from + 0.5 }] : [segment]);
  return <div className="position-composition-chart" role="img" aria-label={`收益构成：价差 ${(share * 100).toFixed(1)}%，资金费 ${((1 - share) * 100).toFixed(1)}%`}>
    <svg width="100" height="100" viewBox="0 0 100 100" aria-hidden="true">{segments.map((segment, index) => <path key={index} d={arc(segment.from, segment.to)} fill={segment.fill} stroke="var(--surface-1)"><title>{segment.name}</title></path>)}</svg>
  </div>;
}

export default function PositionCharts(props: { kind: 'spread'; samples: PositionSample[] } | { kind: 'composition'; values: [string, string] }) {
  return props.kind === 'spread' ? <SpreadTrend samples={props.samples}/> : <Composition values={props.values}/>;
}
