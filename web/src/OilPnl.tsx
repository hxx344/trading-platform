// The oil page's 盈亏与资金费 panels (docs/oil.md section 9), laid out as the workbench's OilTradingPage pnl tab and
// TradingPnlChart.tsx (styles from its trading.css, commit a12e583, in trading.css). Read only: the curve, each account's
// legs and ledger coverage, and the range's ledger rows, read every 30 s through useLiveResource. Switching the range or
// page keeps the last answer on screen, marked, until the new one arrives.
import { CircleAlert } from 'lucide-react';
import { memo, useEffect, useId, useRef, useState } from 'react';
import { formatNumber } from './number-format.ts';
import type { OilPnlAccount, OilPnlPoint, OilPnlUnavailable, OilPnlView } from './oil-types.ts';
import { StatePanel } from './StateViews.tsx';
import { useLiveResource } from './use-live-resource.ts';

const PNL_MS = 30_000, READ_TIMEOUT_MS = 10_000, SETTLED_WINDOW = 15 * 60_000;
const RANGES = [['1d', '近1天'], ['7d', '近7天'], ['30d', '近30天'], ['90d', '近90天']] as const;
const VENUES: Record<string, string> = { binance: 'Binance', bybit: 'Bybit' };
const KINDS: Record<string, string> = { funding: '资金费', realized: '平仓盈亏', fee: '手续费' };
const time = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const full = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const compact = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 2 });
const exact = (value: string | null | undefined) => value == null ? '—' : value;
const date = (at: number | null | undefined) => at ? full.format(at) : '—';
const polarity = (value: string | null | undefined) => !value || !/[1-9]/.test(value) ? undefined : value.startsWith('-') ? 'trading-negative' : 'trading-positive';
const amount = (value: string | null | undefined, signed = false) => {
  const text = formatNumber(value, 4);
  return text === '—' || !signed || !value || value.startsWith('-') || !/[1-9]/.test(value) ? text : `+${text}`;
};
const series = [{ key: 'totalPnl', label: '总盈亏', color: 'var(--accent)' }, { key: 'unrealizedPnl', label: '持仓浮盈亏', color: 'var(--text-secondary)' }] as const;

/** Copied from the workbench TradingPnlChart.tsx (a12e583): two lines, a hover or slider picks a sample, gaps break the lines. */
const PnlChart = memo(function PnlChart({ pnl }: { pnl: OilPnlView }) {
  const container = useRef<HTMLDivElement>(null), descriptionId = useId();
  const [width, setWidth] = useState(640), [selectedTime, setSelectedTime] = useState<number | null>(null);
  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(entries => setWidth(Math.max(240, entries[0]!.contentRect.width)));
    observer.observe(container.current); return () => observer.disconnect();
  }, []);
  const points = pnl.points;
  const found = selectedTime === null ? -1 : points.findIndex(point => point.time >= selectedTime);
  const selectedIndex = found < 0 ? points.length - 1 : found;
  const selected = points[selectedIndex];
  const values = points.flatMap(point => series.map(({ key }) => point[key])).filter((value): value is string => value !== null).map(Number).filter(Number.isFinite);
  const min = Math.min(0, ...values), max = Math.max(0, ...values), extent = max - min || 1;
  const low = min - extent * .1, high = max + extent * .1;
  const left = 63, right = 18, top = 14, bottom = 210, height = 246;
  const from = points[0]?.time ?? 0, to = Math.max(from + 60_000, points.at(-1)?.time ?? from);
  const x = (value: number) => left + (value - from) / (to - from) * (width - left - right);
  const y = (value: number) => bottom - (value - low) / (high - low) * (bottom - top);
  function line(key: 'totalPnl' | 'unrealizedPnl') {
    let drawing = false;
    return points.map(point => {
      const value = point[key] === null ? NaN : Number(point[key]);
      if (!Number.isFinite(value)) { drawing = false; return ''; }
      const command = `${drawing ? 'L' : 'M'}${x(point.time).toFixed(2)},${y(value).toFixed(2)}`;
      drawing = true; return command;
    }).join(' ');
  }
  const detail = (point: OilPnlPoint | null | undefined) => <><span>总盈亏 <b>{exact(point?.totalPnl)}</b></span><span>持仓浮盈亏 <b>{exact(point?.unrealizedPnl)}</b></span><span>区间平仓盈亏 <b>{exact(point?.realizedPnl)}</b></span><span>区间手续费 <b>{exact(point?.feePnl)}</b></span><span>区间累计资金费 <b>{exact(point?.fundingPnl)}</b></span></>;
  // Ledgers sync every five minutes, so the newest sample usually lacks a total: show a complete one at most 15 minutes older, with its own time.
  const latest = pnl.latest, recent = latest && latest.totalPnl === null && latest.unrealizedPnl !== null ? [...points].reverse().find(point => point.totalPnl !== null) : undefined;
  const settled = recent && latest && latest.time - recent.time <= SETTLED_WINDOW ? recent : undefined;
  const headline = settled ?? latest;
  return <figure className="trading-pnl-chart">
    <figcaption className="trading-pnl-legend">{series.map(item => <span key={item.key}><i style={{ background: item.color }} />{item.label}</span>)}<span>USDT · 北京时间</span></figcaption>
    <p id={descriptionId} className="trading-caption">后台约每分钟记录一次。缺失或过期时断线；账单未同步到该时刻时仅显示浮盈亏。长区间保留峰谷，缺失区段不连线。</p>
    <div className="trading-pnl-latest">{detail(headline)}</div>
    {settled ? <p className="trading-caption">账单同步中，以上为 {time.format(settled.time)} 的完整数据（北京时间）；最新浮盈亏 {exact(latest?.unrealizedPnl)}。</p> : null}
    <div className="trading-pnl-plot" ref={container}>
      {values.length ? <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="原油总盈亏与持仓浮盈亏曲线" aria-describedby={descriptionId}
        onPointerMove={event => {
          const bounds = event.currentTarget.getBoundingClientRect();
          const at = from + ((event.clientX - bounds.left) * width / bounds.width - left) / (width - left - right) * (to - from);
          let lo = 0, hi = points.length - 1;
          while (lo < hi) { const mid = (lo + hi) >> 1; if (points[mid]!.time < at) lo = mid + 1; else hi = mid; }
          const index = lo > 0 && Math.abs(points[lo - 1]!.time - at) < Math.abs(points[lo]!.time - at) ? lo - 1 : lo;
          setSelectedTime(points[index]!.time);
        }}>
        {[min, (min + max) / 2, max].filter((value, index, all) => all.indexOf(value) === index).map(value => <g key={value}><line x1={left} x2={width - right} y1={y(value)} y2={y(value)} stroke={value === 0 ? 'var(--text-tertiary)' : 'var(--surface-5)'} strokeDasharray={value === 0 ? undefined : '3 4'} /><text x={left - 8} y={y(value) + 4} textAnchor="end" fill="var(--text-secondary)" fontSize="11">{compact.format(value)}</text></g>)}
        {series.slice().reverse().map(item => <g key={item.key}><path data-series={item.key} d={line(item.key)} fill="none" stroke={item.color} strokeWidth={item.key === 'totalPnl' ? 2.5 : 1.6} strokeDasharray={item.key === 'totalPnl' ? undefined : '5 4'} />{points.map((point, index) => point[item.key] !== null && (points[index - 1]?.[item.key] == null && points[index + 1]?.[item.key] == null) ? <circle key={point.time} cx={x(point.time)} cy={y(Number(point[item.key]))} r="3.5" fill={item.color} /> : null)}</g>)}
        {[from, to].map((value, index) => <text key={value} x={index ? width - right : left} y={height - 8} textAnchor={index ? 'end' : 'start'} fill="var(--text-secondary)" fontSize="11">{time.format(value)}</text>)}
        {selected ? <line x1={x(selected.time)} x2={x(selected.time)} y1={top} y2={bottom} stroke="var(--text-tertiary)" strokeDasharray="3 4" /> : null}
      </svg> : <div className="trading-chart-empty">所有执行账户都读到持仓后开始记录，历史浮盈亏无法回补。</div>}
    </div>
    {points.length ? <div className="trading-pnl-inspect"><label htmlFor={descriptionId + '-point'}>查看采样时刻 <strong>{selected ? time.format(selected.time) : '—'}</strong>（北京时间）</label><input id={descriptionId + '-point'} type="range" min="0" max={points.length - 1} value={selectedIndex} aria-label="选择盈亏采样时刻" aria-valuetext={selected ? `${time.format(selected.time)}，总盈亏 ${exact(selected.totalPnl)} USDT` : undefined} onChange={event => setSelectedTime(points[Number(event.target.value)]!.time)} /><div>{detail(selected)}<span>USDT</span></div></div> : null}
    <p className="trading-footnote">{pnl.recordingStartedAt ? `当前可用记录起点：${time.format(pnl.recordingStartedAt)}（北京时间）。` : '等待持仓采样。'}{pnl.pointCount === 1 ? '已取得首个采样点，后续将逐步形成曲线。' : ''}{pnl.latest ? ` 最新采样：${time.format(pnl.latest.time)}。` : ''}</p>
  </figure>;
});

function Coverage({ account }: { account: OilPnlAccount }) {
  const { positions, ledger } = account;
  return <div>
    <strong>{VENUES[account.venue] ?? account.venue}</strong>
    <span>账户 {account.accountId}</span>
    <span>持仓读取：{positions.receivedAt ? date(positions.receivedAt) : '尚未读取'}</span>
    <span>账单截至：{ledger.coveredUntil ? date(ledger.coveredUntil) : '尚未同步'}</span>
    {positions.error ? <p className="trading-warning">持仓读取失败（{date(positions.failedAt)}）：{positions.error}</p> : null}
    {ledger.error ? <p className="trading-warning">账单同步失败（{date(ledger.failedAt)}）：{ledger.error}</p> : null}
  </div>;
}

export function OilPnl({ onExpired }: { onExpired: () => void }) {
  const [range, setRange] = useState<string>('7d'), [page, setPage] = useState(0);
  const live = useLiveResource<OilPnlView | OilPnlUnavailable>(`/api/oil/pnl?range=${range}&page=${page}`, { intervalMs: PNL_MS, timeoutMs: READ_TIMEOUT_MS, onExpired });
  // The last answer of any range or page stays on screen until the chosen one arrives.
  const [shown, setShown] = useState<OilPnlView | OilPnlUnavailable | null>(null);
  useEffect(() => {
    const value = live.data;
    if (!value) return;
    setShown(value);
    // The ledger shrank under the page asked for (the range moved on): follow the server to its last page instead of waiting forever.
    if (!('available' in value) && value.range === range && page >= value.entries.pages) setPage(value.entries.pages - 1);
  }, [live.data, range, page]);
  if (!shown) return live.status === 'error' || live.status === 'offline'
    ? <StatePanel kind="error" title="读取原油盈亏失败" detail={live.error?.message ?? '网络离线'} />
    : <StatePanel kind="loading" title="加载盈亏…" />;
  if ('available' in shown) return <StatePanel kind="error" title="原油盈亏不可用" detail={shown.error} />;
  const data = shown, pending = data.range !== range || data.entries.page !== page;
  const changeRange = (value: string) => { setRange(value); setPage(0); };
  const rows = data.entries.rows;
  return <>
    <section className="trading-panel trading-pnl" id="oilPnl" aria-labelledby="oil-pnl-title">
      <div className="trading-panel-heading"><div><h2 id="oil-pnl-title">原油总盈亏</h2><p>持仓浮盈亏＋区间平仓盈亏＋手续费（扣费为负）＋已结算资金费 · 仅本服务的原油执行账户</p></div>
        <div className="trading-range" role="group" aria-label="盈亏与资金费时间范围">{RANGES.map(([value, text]) => <button key={value} type="button" aria-pressed={range === value} onClick={() => changeRange(value)}>{text}</button>)}</div></div>
      {pending ? <p className="trading-window-loading" role="status">{live.status === 'error' || live.status === 'offline' ? `所选区间或分页读取失败：${live.error?.message ?? '网络离线'}；` : '正在读取所选区间或分页；'}下方仍显示上一次的数据。</p> : null}
      <p className="trading-caption">累计起点：{date(data.start)}（北京时间）{data.start > data.requestedStart ? '，账单从这时起才有记录，早于它的不计' : ''}；每个采样点只累计到各账户自己的持仓读取时刻。</p>
      {live.error && !pending ? <p className="trading-warning trading-caption" role="alert">最近一次读取失败：{live.error.message}；显示上次结果。</p> : null}
      <PnlChart pnl={data} />
      <p className="trading-footnote">平仓盈亏、手续费与资金费按账户内 BZUSDT / CLUSDT 的交易所账单统计，可能包含同账户在其他地方的交易；持仓浮盈亏来自交易所当前仓位。更换账户后重新开始记录，切换区间会改变累计起点。</p>
    </section>

    <section className="trading-panel trading-funding" aria-labelledby="oil-pnl-ledger-title">
      <div className="trading-panel-heading"><div><h2 id="oil-pnl-ledger-title">区间账单与各腿</h2><p>{date(data.start)} — {date(data.now)}（北京时间）· 与上方曲线共用区间</p></div></div>
      <div className="trading-funding-summary">
        <div><span>资金费<small>USDT</small></span><strong className={polarity(data.totals?.funding)}>{amount(data.totals?.funding, true)}</strong></div>
        <div><span>平仓盈亏<small>USDT</small></span><strong className={polarity(data.totals?.realized)}>{amount(data.totals?.realized, true)}</strong></div>
        <div><span>手续费<small>USDT</small></span><strong className={polarity(data.totals?.fee)}>{amount(data.totals?.fee, true)}</strong></div>
      </div>
      <div className="trading-funding-coverage">
        {data.accounts.some(account => account.ledger.error || account.positions.error) ? <p className="trading-warning"><CircleAlert size={15} aria-hidden="true" />有账户读取失败：上方汇总只含已同步的账单，曲线在失败期间不显示总盈亏。</p> : null}
        {data.accounts.map(account => <Coverage key={`${account.venue}:${account.accountId}`} account={account} />)}
      </div>
      <div className="trading-table-scroll" tabIndex={0} role="region" aria-label="各账户各合约的盈亏明细"><table>
        <thead><tr><th scope="col">交易所</th><th scope="col">合约</th><th scope="col">持仓</th><th scope="col">开仓均价</th><th scope="col">标记价</th><th scope="col">浮盈亏</th><th scope="col">资金费</th><th scope="col">平仓盈亏</th><th scope="col">手续费</th></tr></thead>
        <tbody>{data.accounts.flatMap(account => account.symbols.map(leg => {
          const held = account.positions.rows?.filter(row => row.symbol === leg.symbol) ?? [];
          const position = held.length === 1 ? held[0]! : null;
          return <tr key={`${account.venue}:${account.accountId}:${leg.symbol}`}>
            <td>{VENUES[account.venue] ?? account.venue}</td><td>{leg.symbol}</td>
            <td>{account.positions.rows === null ? '—' : held.length ? held.map(row => `${row.side === 'long' ? '多' : '空'} ${row.quantity}`).join(' / ') : '无'}</td>
            <td>{position?.entryPrice ?? '—'}</td><td>{position?.markPrice ?? '—'}</td>
            <td className={polarity(leg.unrealized)}>{amount(leg.unrealized, true)}</td>
            <td className={polarity(leg.funding)}>{amount(leg.funding, true)}</td><td className={polarity(leg.realized)}>{amount(leg.realized, true)}</td><td className={polarity(leg.fee)}>{amount(leg.fee, true)}</td>
          </tr>;
        }))}</tbody>
      </table></div>
      <p className="trading-footnote">账单每 5 分钟增量同步一次（首次回溯 30 天，每次重读最近 10 分钟）；持仓每分钟读取一次。资金费、平仓盈亏与手续费为区间合计，浮盈亏为最近一次读取。</p>
    </section>

    <section className="trading-panel trading-ledger" aria-labelledby="oil-pnl-entries-title">
      <div className="trading-panel-heading"><div><h2 id="oil-pnl-entries-title">账单流水</h2><p>BZUSDT / CLUSDT 的资金费、平仓盈亏与手续费 · 共 {data.entries.total} 条</p></div></div>
      {rows.length ? <><div className="trading-table-scroll trading-ledger-scroll" tabIndex={0} role="region" aria-label="账单流水明细"><table>
        <thead><tr><th scope="col">时间（北京时间）</th><th scope="col">交易所</th><th scope="col">合约</th><th scope="col">类型</th><th scope="col">金额 · USDT</th></tr></thead>
        <tbody>{rows.map(row => <tr key={`${row.venue}-${row.id}`}><td>{date(row.time)}</td><td>{VENUES[row.venue ?? ''] ?? row.venue ?? '—'}</td><td>{row.symbol}</td><td>{KINDS[row.kind] ?? row.kind}</td><td className={polarity(row.amount)}>{amount(row.amount, true)}</td></tr>)}</tbody>
      </table></div>
        <div className="trading-pagination"><span>第 {data.entries.page + 1} / {data.entries.pages} 页 · 每页最多 {data.entries.pageSize} 条</span><div>
          <button className="button secondary" type="button" disabled={pending || data.entries.page === 0} onClick={() => setPage(data.entries.page - 1)}>上一页</button>
          <button className="button secondary" type="button" disabled={pending || data.entries.page + 1 >= data.entries.pages} onClick={() => setPage(data.entries.page + 1)}>下一页</button></div></div></>
        : <div className="trading-ledger-empty">{data.accounts.every(account => account.ledger.coveredUntil) ? '所选区间没有账单流水。' : '账单尚未同步完成；首次同步回溯 30 天，完成后显示。'}</div>}
    </section>
  </>;
}
