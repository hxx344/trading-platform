import { useMemo, useState } from 'react';
import { Callout, StatePanel } from './StateViews.tsx';
import { SvgPlot, type PlotLayer } from './svg-plot.tsx';
import { niceAxis } from './svg-plot-geometry.ts';
import { stamp } from './labels.ts';
import { useLiveResource } from './use-live-resource.ts';
import type { BalanceHistory, BalancePoint } from './types.ts';

const RANGES = [['6h', '6 小时'], ['24h', '24 小时'], ['7d', '7 天'], ['30d', '30 天']] as const;
const REFRESH_MS = 60_000;
/** Samples further apart than this are not joined: the service was down or the balances were not read. */
const GAP_MS = 3 * 60_000;
type Plotted = { time: number; long: number | null; short: number | null; point: BalancePoint | null };

const LAYERS: PlotLayer[] = [
  { kind: 'line', key: 'long', color: 'var(--accent)', width: 1.6, active: true },
  { kind: 'line', key: 'short', color: 'var(--warning)', width: 1.6, active: true },
];

function plotted(history: BalanceHistory): Plotted[] {
  const rows: Plotted[] = [];
  const gap = Math.max(GAP_MS, 2 * history.bucketMs);
  for (const point of history.points) {
    const previous = rows.at(-1);
    if (previous && point.at - previous.time > gap) rows.push({ time: previous.time + 1, long: null, short: null, point: null });
    rows.push({ time: point.at, long: Number(point.long.available), short: Number(point.short.available), point });
  }
  return rows;
}

const amount = (value: number): string => Math.abs(value) >= 10_000 ? `${(value / 1000).toFixed(1)}k` : value.toFixed(Math.abs(value) >= 100 ? 0 : 2);
const xTickFor = (range: string) => (time: number): string => {
  const at = new Date(time);
  const hm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  return range === '6h' ? hm : `${at.getMonth() + 1}/${at.getDate()}${range === '30d' ? '' : ` ${hm}`}`;
};

function Tooltip({ point }: { point: BalancePoint | null }) {
  if (!point) return null;
  const gap = Number(point.long.available) - Number(point.short.available);
  return <div className="chart-tip">
    <div>{stamp(point.at)}{point.fresh ? '' : <span className="err">（读取时余额已过期）</span>}</div>
    <div><span className="swatch long" />多侧 可用 {point.long.available} / 权益 {point.long.equity}</div>
    <div><span className="swatch short" />空侧 可用 {point.short.available} / 权益 {point.short.equity}</div>
    <div className="muted">可用差（多 − 空）{Number.isFinite(gap) ? gap.toFixed(2) : '—'}</div>
  </div>;
}

/** Each side's available USD1 over the range: the input of every transfer decision, as sampled once a minute. */
export function BalanceChart({ pairId, onExpired }: { pairId: string; onExpired: () => void }) {
  const [range, setRange] = useState<string>('24h');
  const { data, status, error } = useLiveResource<BalanceHistory>(`/api/transfer-pairs/${encodeURIComponent(pairId)}/balances?range=${range}`, { intervalMs: REFRESH_MS, onExpired });
  const history = data && data.pairId === pairId && data.range === range ? data : null;
  const rows = useMemo(() => history ? plotted(history) : [], [history]);
  const hoverRows = useMemo(() => rows.filter(row => row.point), [rows]);
  const axis = useMemo(() => {
    const values = rows.flatMap(row => [row.long, row.short]).filter((value): value is number => value !== null && Number.isFinite(value));
    return niceAxis(Math.min(...values), Math.max(...values));
  }, [rows]);
  const xTick = useMemo(() => xTickFor(range), [range]);
  let body;
  if (!history) body = status === 'error' || status === 'offline' ? <StatePanel kind="error" title="读取余额走势失败" detail={error?.message ?? '网络离线'} /> : <StatePanel kind="loading" title="加载中…" />;
  else if (history.unavailable) body = <Callout tone="warning">{history.unavailable}</Callout>;
  else if (!history.points.length) body = <p className="muted">这个范围内还没有采样：本服务每分钟记一次两侧余额（升级到本版本后开始记录，保留 30 天）。</p>;
  else body = <>
    <div className="chart-legend"><span><span className="swatch long" />多侧可用</span><span><span className="swatch short" />空侧可用</span>
      <span className="muted">{history.bucketMs > history.sampleEveryMs ? `每 ${Math.round(history.bucketMs / 60_000)} 分钟取最后一次采样` : '每分钟一次采样'}；中断处断线</span></div>
    <div className="balance-chart">
      <SvgPlot rows={rows} hoverRows={hoverRows} xDomain={[history.from, history.to]} yDomain={axis.domain} yTicks={axis.ticks} yTick={amount} xTick={xTick}
        layers={LAYERS} margin={{ top: 10, right: 56, bottom: 30 }} label="两侧可用余额走势" height={240}
        tooltip={row => <Tooltip point={(row as Plotted).point} />} />
    </div>
    {error ? <p className="err">刷新失败：{error.message}（显示的是上次结果）</p> : null}
  </>;
  return <div className="panel-body">
    <div className="toolbar" role="group" aria-label="时间范围">
      {RANGES.map(([key, text]) => <button key={key} type="button" className={`button ${key === range ? 'primary' : 'secondary'}`} aria-pressed={key === range} onClick={() => setRange(key)}>{text}</button>)}
    </div>
    {body}
  </div>;
}
