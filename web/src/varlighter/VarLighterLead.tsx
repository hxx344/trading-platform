// DEX 价差子模块「Binance 领先测速」（#/varlighter/lead）：
// 只读按需测速面板，测试 Binance USDⓈ-M 永续合约相对 Lighter 主网 / Lighter RH / Entropy 的价格领先毫秒数。
import { useEffect, useMemo, useState } from 'react';
import { LoaderCircle, Play, RefreshCw, Square, Trash2 } from 'lucide-react';
import { api } from '../api.ts';
import { useDialogGuard } from '../AppDialog.tsx';
import { Callout, StatePanel, TableEmpty } from '../StateViews.tsx';
import { SvgPlot, type PlotLayer } from '../svg-plot.tsx';
import { niceAxis } from '../svg-plot-geometry.ts';
import { useLiveResource } from '../use-live-resource.ts';
import type { LeadCandidateView, LeadSessionView, LeadVenue, LeadVenueStatsView, LeadView } from '../../../src/varlighter/views.ts';
import { Badge, Metric, stampMsText, useWrite } from './parts.tsx';
import { VARLIGHTER_BASE, age, bps, percent, plain, price } from './varlighter-form.ts';
import {
  DEFAULT_LEAD_FORM,
  LEAD_NUM_FIELDS,
  LEAD_VENUE_LABELS,
  LEAD_VENUE_SHORT,
  LEAD_VENUES,
  applyCandidate,
  buildSeriesRows,
  buildXcorrRows,
  formFromConfig,
  formatEventVenue,
  formatLagMs,
  lagTone,
  lagVerdict,
  leadStartRequest,
  type LeadForm,
} from './varlighter-lead-form.ts';

const LEAD_PATH = `${VARLIGHTER_BASE}/lead`;
const LEAD_REFRESH_MS = 2_000;
const READ_TIMEOUT_MS = 15_000;
const CHART_MARGIN = { top: 12, right: 56, bottom: 30 };

const VENUE_COLORS: Record<LeadVenue, string> = {
  lighter: 'var(--accent)',
  rh: 'var(--emerald)',
  entropy: 'var(--warning)',
};

const XCORR_LAYERS: PlotLayer[] = [
  { kind: 'line', key: 'lighter', color: VENUE_COLORS.lighter, width: 1.75, active: true },
  { kind: 'line', key: 'rh', color: VENUE_COLORS.rh, width: 1.75, active: true },
  { kind: 'line', key: 'entropy', color: VENUE_COLORS.entropy, width: 1.75, active: true },
];

const SERIES_LAYERS: PlotLayer[] = [
  { kind: 'line', key: 'binance', color: 'var(--text-primary)', width: 1.75, active: true },
  { kind: 'line', key: 'lighter', color: VENUE_COLORS.lighter, width: 1.5, active: true },
  { kind: 'line', key: 'rh', color: VENUE_COLORS.rh, width: 1.5, active: true },
  { kind: 'line', key: 'entropy', color: VENUE_COLORS.entropy, width: 1.5, active: true },
];

function parseLeadView(raw: unknown): LeadView {
  const value = raw as LeadView | null;
  if (!value || typeof value !== 'object' || !value.catalog || !Array.isArray(value.candidates) || !Array.isArray(value.history)) {
    throw new Error('领先测速应答格式不对');
  }
  return value;
}

const clockSec = (time: number): string => {
  const d = new Date(time);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
};

export function VarLighterLead({ onExpired }: { onExpired: () => void }) {
  const live = useLiveResource<LeadView>(LEAD_PATH, { intervalMs: LEAD_REFRESH_MS, timeoutMs: READ_TIMEOUT_MS, parse: parseLeadView, onExpired });
  const write = useWrite();
  const dialog = useDialogGuard();
  const [form, setForm] = useState<LeadForm>(DEFAULT_LEAD_FORM);
  const [candidateQuery, setCandidateQuery] = useState('');
  const [initialized, setInitialized] = useState(false);

  const data = live.data;
  const session = data?.active ?? data?.last ?? null;
  const isRunning = data?.active?.status === 'running';

  // 初次进入或目录首次到达时，若用户尚未手动改过且表单为空，自动预填运行中/最近一次测试或首个候选标的。
  useEffect(() => {
    if (!data || initialized) return;
    if (session) {
      setForm(formFromConfig(session.config));
      setInitialized(true);
      return;
    }
    if (data.candidates.length && !form.binanceSymbol) {
      setForm(current => applyCandidate(current, data.candidates[0]!));
      setInitialized(true);
    } else if (!data.catalog.loading) {
      setInitialized(true);
    }
  }, [data, initialized, session, form.binanceSymbol]);

  const filteredCandidates = useMemo(() => {
    if (!data) return [];
    const q = candidateQuery.trim().toUpperCase();
    const list = q
      ? data.candidates.filter(item => item.symbol.includes(q) || item.baseAsset.includes(q) || Object.values(item.targets).some(t => t?.toUpperCase().includes(q)))
      : data.candidates;
    return list.slice(0, 60);
  }, [data, candidateQuery]);

  if (!data) {
    return live.error
      ? <StatePanel kind="error" title="读取领先测速失败" detail={live.error.message} />
      : <StatePanel kind="loading" title="加载领先测速中…" />;
  }

  const parsed = leadStartRequest(form);
  const busy = write.busy !== null;
  const set = (patch: Partial<LeadForm>) => {
    setInitialized(true);
    setForm(current => ({ ...current, ...patch }));
  };

  const refreshCatalog = () => {
    void write.run('catalog', () => api<LeadView>(`${LEAD_PATH}/catalog`, { body: {} }), result => {
      void live.refresh();
      return result.catalog.error
        ? { tone: 'error', text: `Binance 目录刷新失败：${result.catalog.error}` }
        : `已刷新 Binance 永续目录（共 ${result.catalog.count} 个活跃合约）`;
    });
  };

  const startTest = () => {
    if (!parsed.ok || isRunning) return;
    void write.run('start', () => api<LeadView>(`${LEAD_PATH}/start`, { body: parsed.value }), () => {
      void live.refresh();
      return `已启动 ${parsed.value.binanceSymbol} 领先测速（时长 ${parsed.value.durationSec} 秒）`;
    });
  };

  const stopTest = () => {
    const activeId = data.active?.id;
    if (!activeId) return;
    void write.run('stop', () => api<LeadView>(`${LEAD_PATH}/stop`, { body: { sessionId: activeId } }), () => {
      void live.refresh();
      return '已停止本次领先测速并记入历史';
    });
  };

  const clearHistory = async () => {
    if (!await dialog.confirm('清空全部历史测速记录？当前进行中的测试（若有）不受影响。', { title: '清空测速历史', confirmLabel: '清空', tone: 'danger' })) return;
    if (!dialog.isAlive()) return;
    void write.run('clear', () => api<LeadView>(`${LEAD_PATH}/clear`, { body: {} }), () => {
      void live.refresh();
      return '已清空测速历史';
    });
  };

  const pickCandidate = (candidate: LeadCandidateView) => {
    if (isRunning) return;
    setInitialized(true);
    setForm(current => applyCandidate(current, candidate));
  };

  return <>
    {live.error ? <p className="vl-note err" role="status">刷新失败：{live.error.message}（停留在 {live.receivedAt ? new Date(live.receivedAt).toLocaleTimeString() : '—'}）</p> : null}

    <section className="panel" aria-label="测速配置与控制">
      <div className="panel-heading">
        <h2>Binance 领先测速</h2>
        <span className="muted">
          {data.catalog.loading ? '正在拉取 Binance 合约目录…'
            : data.catalog.error ? <span className="vl-down">Binance 目录失败：{data.catalog.error}</span>
              : `Binance 目录 ${data.catalog.count} 个永续 · 可自动匹配 ${data.candidates.length} 个（${age(data.catalog.ok, data.now)}更新）`}
        </span>
      </div>

      <datalist id="vl-lead-binance">
        {data.catalog.contracts.map(c => <option key={c.symbol} value={c.symbol}>{c.contractType === 'TRADIFI_PERPETUAL' ? 'TradFi' : '永续'} · {c.baseAsset}/{c.quoteAsset}</option>)}
      </datalist>
      {LEAD_VENUES.map(venue => (
        <datalist key={venue} id={`vl-lead-${venue}`}>
          {(data.dexCatalogs[venue] ?? []).map(item => <option key={item.symbol} value={item.symbol} />)}
        </datalist>
      ))}

      <div className="vl-toolbar">
        <input type="search" value={candidateQuery} onChange={e => setCandidateQuery(e.target.value)} placeholder="搜索自动匹配标的（如 BTC、NVDA、ANT）" aria-label="筛选候选标的" disabled={isRunning} />
        <span className="grow" />
        <button type="button" className="button secondary" disabled={busy || data.catalog.loading} onClick={refreshCatalog}>
          {write.busy === 'catalog' || data.catalog.loading ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
          刷新 Binance 目录
        </button>
      </div>

      {filteredCandidates.length ? <div className="vl-lead-chips" aria-label="自动匹配候选标的">
        {filteredCandidates.map(item => {
          const activeChip = form.binanceSymbol.trim().toUpperCase() === item.symbol;
          return <button type="button" key={item.symbol} className={`vl-lead-chip${activeChip ? ' active' : ''}`} disabled={isRunning} onClick={() => pickCandidate(item)}>
            <b>{item.symbol}</b>
            {item.contractType === 'TRADIFI_PERPETUAL' ? <Badge tone="info">TradFi</Badge> : null}
            <small>{LEAD_VENUES.filter(v => item.targets[v]).map(v => `${LEAD_VENUE_SHORT[v]}:${item.targets[v]}`).join(' · ')}</small>
          </button>;
        })}
      </div> : null}

      <div className="vl-lead-form">
        <label className="vl-field">
          Binance 永续代码
          <input list="vl-lead-binance" value={form.binanceSymbol} onChange={e => set({ binanceSymbol: e.target.value.toUpperCase() })} placeholder="例如 BTCUSDT / NVDAUSDT" disabled={isRunning} />
          <small>使用 @bookTicker 实时逐笔一档</small>
        </label>
        {LEAD_VENUES.map(venue => {
          const count = (data.dexCatalogs[venue] ?? []).length;
          return <label className="vl-field" key={venue}>
            {LEAD_VENUE_LABELS[venue]} 代码（可选）
            <input list={`vl-lead-${venue}`} value={form[venue]} onChange={e => set({ [venue]: e.target.value })} placeholder="留空则不对比" disabled={isRunning} />
            <small>{count ? `目录 ${count} 个` : '目录尚未取到'}</small>
          </label>;
        })}
        <label className="vl-field">
          测试时长（秒）
          <input inputMode="numeric" value={form.durationSec} onChange={e => set({ durationSec: e.target.value })} disabled={isRunning} />
          <small>30 – 1800 秒，到期自动结束</small>
        </label>
        <label className="vl-field">
          触发阈值（基点）
          <input inputMode="decimal" value={form.thresholdBps} onChange={e => set({ thresholdBps: e.target.value })} disabled={isRunning} />
          <small>Binance 价格单次跃动幅度（0.5 – 500）</small>
        </label>
      </div>

      <details className="vl-lead-adv">
        <summary>高级算法参数（变化窗口、跟进判定比例、最大等待与冷却）</summary>
        <div className="vl-fields">
          {LEAD_NUM_FIELDS.slice(2).map(field => <label className="vl-field" key={field.key}>
            {field.label}
            <input inputMode="decimal" value={form[field.key]} onChange={e => set({ [field.key]: e.target.value })} disabled={isRunning} />
            <small>范围 {field.min} – {field.max}</small>
          </label>)}
        </div>
      </details>

      <div className="vl-actions">
        {!isRunning ? <button type="button" className="button primary" disabled={!parsed.ok || busy} onClick={startTest}>
          {write.busy === 'start' ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
          开始测速
        </button> : <button type="button" className="button secondary" disabled={busy} onClick={stopTest}>
          {write.busy === 'stop' ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Square size={14} aria-hidden="true" />}
          停止测速（剩余 {Math.ceil((data.active?.remainingMs ?? 0) / 1000)} s）
        </button>}
        {session ? <span className="muted">
          {isRunning ? `测速进行中 · 已运行 ${Math.floor(session.elapsedMs / 1000)} / ${session.config.durationSec} s · 已捕获 ${session.eventCount} 次跃动`
            : `最近一次：${session.config.binanceSymbol} · ${session.status === 'completed' ? '已完成' : '已手动停止'} · 共 ${session.eventCount} 次跃动`}
        </span> : null}
        {!parsed.ok && !isRunning ? <Callout tone="warning" role="status">{parsed.error}</Callout> : null}
        {write.message ? <Callout tone={write.message.tone}>{write.message.text}</Callout> : null}
      </div>
    </section>

    {session ? <SessionResult session={session} now={data.now} /> : <section className="panel" aria-label="测速结果">
      <div className="panel-heading"><h2>测速结果</h2></div>
      <TableEmpty>在上方选择自动匹配标的（或手动填写各场所代码）后点击「开始测速」，将按需建立单标的实时 WebSocket 测算毫秒级领先速度。</TableEmpty>
    </section>}

    <HistoryPanel history={data.history} busy={busy} onClear={clearHistory} />

    <section className="panel" aria-label="测速口径说明">
      <details className="vl-help">
        <summary>测速口径与通道说明（为什么能测出毫秒级领先）</summary>
        <dl>
          <dt>纯只读按需连接</dt><dd>仅在点击「开始测速」期间打开 Binance、Lighter 主网/RH、Entropy 单标的连接，停止或到期立刻关闭，不干扰 DEX 价差主行情流与实盘策略，也不修改任何持仓与资金。</dd>
          <dt>各场所低延迟频道</dt><dd>Binance 订阅单标的 <code>&lt;symbol&gt;@bookTicker</code>（非 5 秒聚合 <code>!bookTicker</code>）；Lighter 主网/RH 订阅单市场 <code>order_book/{'{id}'}</code> 增量盘口（避开滞后约 0.3–1 秒的 <code>market_stats/all</code>）；Entropy 订阅 <code>bbo</code> 并于建连时用 <code>l2Book</code> 补初始一档。</dd>
          <dt>同机单调时钟与同门槛对齐</dt><dd>所有时间差均基于本机单调时钟（<code>performance.now</code>）在收到报文瞬间打戳，消除跨交易所时钟偏差。Binance 达到阈值触发事件时，先回溯至同一跟进门槛（阈值 × 跟进比例）的起跳时刻，再量测 DEX 达到同等幅度所需毫秒数；若 DEX 提前动，则为负值。</dd>
          <dt>500 ms 重叠收益率互相关</dt><dd>将所有连续在线数据按 100 ms 网格对齐并计算 500 ms 收益率，扫描 −1000 ms 到 +3000 ms 滞后上的 Pearson 相关系数。即使在短时间内缺乏剧烈单跳波动，峰值滞后仍能给出客观的整体领先方向。</dd>
        </dl>
      </details>
    </section>
  </>;
}

function SessionResult({ session, now }: { session: LeadSessionView; now: number }) {
  const bnStream = session.streams.find(s => s.source === 'binance');
  const xcorrRows = useMemo(() => buildXcorrRows(session), [session]);
  const seriesRows = useMemo(() => buildSeriesRows(session), [session]);
  const xcorrVenues = session.venues.filter(v => v.xcorr !== null);

  return <>
    <section className="vl-metrics" aria-label="测速核心结论">
      <Metric
        label={bnStream ? `${bnStream.name} (${bnStream.symbol})` : 'Binance'}
        value={bnStream?.mid !== null && bnStream?.mid !== undefined ? price(bnStream.mid) : '等待行情'}
        tone={bnStream?.connected ? 'up' : 'down'}
        foot={bnStream ? `${bnStream.lastError ?? (bnStream.connected ? '实时流已连' : '未连接')} · 点差 ${plain(bnStream.spreadBps, 1)} bps · ${bnStream.ticksPerSec}/s · 事件 ${session.eventCount} 次` : ''}
      />
      {session.venues.map(v => <Metric
        key={v.venue}
        label={`${v.name} (${v.symbol})`}
        value={v.medianMs !== null ? formatLagMs(v.medianMs) : v.xcorr ? formatLagMs(v.xcorr.peakLagMs) : '—'}
        tone={lagTone(v.medianMs ?? v.xcorr?.peakLagMs ?? null)}
        accent={v.followed >= 3 && (v.medianMs ?? 0) > 50}
        foot={`${lagVerdict(v)} · 跟进率 ${v.followRate !== null ? percent(v.followRate, 0) : '—'} (${v.followed}/${v.followed + v.unfollowed})`}
      />)}
    </section>

    <section className="panel" aria-label="各场所领先统计">
      <div className="panel-heading">
        <h2>各场所实时流与延迟统计</h2>
        <span className="muted">正数表示 Binance 领先（毫秒）；负数表示目标场所先动 · 跟进门槛 {plain(session.config.thresholdBps * session.config.followRatio, 2)} 基点</span>
      </div>
      <div className="vl-table"><table>
        <thead><tr>
          <th>场所 · 代码</th><th>连接与实时报价</th><th className="num">价差 / 频次</th><th className="num">跟进 / 有效</th>
          <th className="num">领先占比</th><th className="num">中位 P50</th><th className="num">均值</th>
          <th className="num">P25 – P75</th><th className="num">P90</th><th className="num">最小 / 最大</th><th className="num">互相关峰值</th>
        </tr></thead>
        <tbody>{session.venues.map(v => {
          const s = session.streams.find(item => item.source === v.venue);
          const resolved = v.followed + v.unfollowed;
          return <tr key={v.venue}>
            <td><span className="vl-symbol">{v.name}</span><small>{v.symbol}</small></td>
            <td>
              <Badge tone={s?.connected ? 'ok' : 'bad'}>{s?.connected ? '已连' : '断开'}</Badge>
              {s?.mid !== null && s?.mid !== undefined ? <small>{price(s.bid)} / {price(s.ask)}{s.basisBps !== null ? ` · 基差 ${bps(s.basisBps, 1)}` : ''}</small>
                : <small>{s?.lastError ?? '等待首档'}</small>}
              {s?.lastError && s.mid !== null ? <small className="vl-down">{s.lastError}</small> : null}
            </td>
            <td className="num">{s?.spreadBps !== null && s?.spreadBps !== undefined ? `${plain(s.spreadBps, 1)} bps` : '—'}
              <small>{s ? `${s.ticksPerSec}/s · 记 ${s.ticks} 次` : '—'}</small></td>
            <td className="num">{v.followRate !== null ? percent(v.followRate, 0) : '—'}
              <small>{v.followed} / {resolved}{v.pending ? ` · 在途 ${v.pending}` : ''}{v.disconnected || v.noData ? ` · 缺 ${v.disconnected + v.noData}` : ''}</small></td>
            <td className="num">{v.bnLeadRate !== null ? percent(v.bnLeadRate, 0) : '—'}
              <small>BN {v.bnLeadCount} / DEX {v.dexLeadCount}{v.tieCount ? ` / 同 ${v.tieCount}` : ''}</small></td>
            <td className={`num vl-${lagTone(v.medianMs) || 'dim'}`}><b>{formatLagMs(v.medianMs)}</b></td>
            <td className="num">{formatLagMs(v.meanMs)}</td>
            <td className="num">{v.p25Ms !== null ? `${formatLagMs(v.p25Ms)} ~ ${formatLagMs(v.p75Ms)}` : '—'}</td>
            <td className="num">{formatLagMs(v.p90Ms)}</td>
            <td className="num">{v.minMs !== null ? `${formatLagMs(v.minMs)} / ${formatLagMs(v.maxMs)}` : '—'}</td>
            <td className="num">{v.xcorr ? <><span className={`vl-${lagTone(v.xcorr.peakLagMs) || 'dim'}`}>{formatLagMs(v.xcorr.peakLagMs)}</span><small>r = {v.xcorr.peakCorr.toFixed(2)}（{v.xcorr.samples} 点）</small></>
              : <span className="vl-dim">{v.xcorrReason ?? '—'}</span>}</td>
          </tr>;
        })}</tbody>
      </table></div>
      <p className="vl-note">各流连接明细：{session.streams.map(s => `${s.name}(${s.symbol}) 收到 ${s.ticks} 次价变${s.lastTickAt ? ` · 最近 ${age(s.lastTickAt, now)}` : ''}${s.reconnects ? ` · 重连 ${s.reconnects}` : ''}`).join('；')}</p>
    </section>

    <div className="vl-columns">
      <section className="panel" aria-label="互相关领先曲线">
        <div className="panel-heading"><h2>500ms 收益率互相关曲线</h2><span className="muted">横轴正数 = Binance 领先 · 竖虚线为 0 ms 同步线</span></div>
        {xcorrVenues.length && xcorrRows.length >= 2 ? <XcorrChart rows={xcorrRows} venues={session.venues} />
          : <TableEmpty>{session.venues.map(v => `${v.name}: ${v.xcorrReason ?? '样本不足'}`).join(' · ')}</TableEmpty>}
      </section>

      <section className="panel" aria-label="相对涨跌幅实时走势">
        <div className="panel-heading"><h2>近 60 秒相对涨跌幅（基点）</h2><span className="muted">各腿各自相对窗口起点归一化，不受合约面值差异影响</span></div>
        {seriesRows.length >= 2 ? <RelativeSeriesChart rows={seriesRows} venues={session.venues} bnSymbol={session.config.binanceSymbol} />
          : <TableEmpty>等待多方报价进入同一 60 秒窗口…</TableEmpty>}
      </section>
    </div>

    <section className="panel" aria-label="近期价格跃动明细">
      <div className="panel-heading"><h2>近期价格跃动明细</h2><span className="muted">最近 {session.events.length} 次（共触发 {session.eventCount} 次）</span></div>
      {session.events.length ? <div className="vl-table"><table>
        <thead><tr>
          <th>触发时刻</th><th>方向</th><th className="num">Binance 跃动</th><th className="num">基准 → 触发价</th>
          {session.venues.map(v => <th className="num" key={v.venue}>{v.name} 跟进</th>)}
        </tr></thead>
        <tbody>{session.events.map(ev => <tr key={ev.id}>
          <td>{stampMsText(ev.at)}</td>
          <td><Badge tone={ev.direction === 'up' ? 'ok' : 'bad'}>{ev.direction === 'up' ? '急涨' : '急跌'}</Badge></td>
          <td className={`num vl-${ev.direction === 'up' ? 'up' : 'down'}`}>{bps(ev.moveBps, 2)} bps</td>
          <td className="num">{price(ev.baseMid)} → {price(ev.triggerMid)}</td>
          {session.venues.map(v => {
            const cell = formatEventVenue(ev.venues[v.venue]);
            const maxMove = ev.venues[v.venue]?.maxMoveBps;
            return <td className="num" key={v.venue}>
              {cell.tone ? <Badge tone={cell.tone}>{cell.text}</Badge> : cell.text}
              {maxMove !== null && maxMove !== undefined ? <small>同向极值 {plain(maxMove, 1)} bps</small> : null}
            </td>;
          })}
        </tr>)}</tbody>
      </table></div> : <TableEmpty>本轮尚未触发达到 {session.config.thresholdBps} 基点的 Binance 快速跃动（可在下方调低阈值后重新测试）。</TableEmpty>}
    </section>
  </>;
}

function XcorrChart({ rows, venues }: { rows: ReturnType<typeof buildXcorrRows>; venues: readonly LeadVenueStatsView[] }) {
  const values: number[] = [];
  for (const row of rows) {
    for (const v of venues) {
      const val = row[v.venue];
      if (val !== null) values.push(val);
    }
  }
  const axis = niceAxis(Math.min(0, ...values), Math.max(0.2, ...values));
  const minLag = rows[0]!.time, maxLag = rows.at(-1)!.time;
  return <>
    <div className="vl-chart small">
      <SvgPlot
        rows={rows}
        xDomain={[minLag, maxLag > minLag ? maxLag : minLag + 100]}
        yDomain={axis.domain}
        yTicks={axis.ticks}
        yTick={v => v.toFixed(2)}
        xTick={v => `${v > 0 ? '+' : ''}${Math.round(v)}ms`}
        layers={XCORR_LAYERS}
        references={[{ y: 0, color: 'var(--surface-6)', dash: '3 3' }]}
        margin={CHART_MARGIN}
        height={200}
        label="500ms 收益率互相关曲线"
        tooltip={raw => {
          const item = raw as (typeof rows)[number];
          return <div className="vl-tip">
            <b>滞后 {formatLagMs(item.time)}</b>
            {venues.flatMap(v => [
              <span key={`${v.venue}-l`}>{v.name}</span>,
              <span key={`${v.venue}-v`}>{item[v.venue] === null ? '—' : item[v.venue]!.toFixed(3)}</span>,
            ])}
          </div>;
        }}
        overlay={scales => {
          if (minLag > 0 || maxLag < 0) return null;
          const x0 = scales.x(0);
          return <line x1={x0} x2={x0} y1={scales.y(axis.domain[1])} y2={scales.y(axis.domain[0])} stroke="var(--text-tertiary)" strokeDasharray="4 4" />;
        }}
      />
    </div>
    <div className="vl-legend">
      {venues.map(v => <span key={v.venue}><i className={`lead-${v.venue}`} />{v.name}{v.xcorr ? `（峰值 ${formatLagMs(v.xcorr.peakLagMs)}）` : ''}</span>)}
    </div>
  </>;
}

function RelativeSeriesChart({ rows, venues, bnSymbol }: { rows: ReturnType<typeof buildSeriesRows>; venues: readonly LeadVenueStatsView[]; bnSymbol: string }) {
  const values: number[] = [];
  for (const row of rows) {
    if (row.binance !== null) values.push(row.binance);
    for (const v of venues) {
      const val = row[v.venue];
      if (val !== null) values.push(val);
    }
  }
  const axis = niceAxis(Math.min(-1, ...values), Math.max(1, ...values));
  const from = rows[0]!.time, to = rows.at(-1)!.time;
  return <>
    <div className="vl-chart small">
      <SvgPlot
        rows={rows}
        xDomain={[from, to > from ? to : from + 1000]}
        yDomain={axis.domain}
        yTicks={axis.ticks}
        yTick={v => bps(v, 1)}
        xTick={clockSec}
        layers={SERIES_LAYERS}
        references={[{ y: 0, color: 'var(--surface-6)', dash: '3 3' }]}
        margin={CHART_MARGIN}
        height={200}
        label="近 60 秒相对涨跌幅走势"
        tooltip={raw => {
          const item = raw as (typeof rows)[number];
          return <div className="vl-tip">
            <b>{clockSec(item.time)}</b>
            <span>Binance ({bnSymbol})</span><span>{bps(item.binance, 2)} bps</span>
            {venues.flatMap(v => [<span key={`${v.venue}-n`}>{v.name}</span>, <span key={`${v.venue}-d`}>{bps(item[v.venue], 2)} bps</span>])}
          </div>;
        }}
      />
    </div>
    <div className="vl-legend">
      <span><i className="lead-binance" />Binance ({bnSymbol})</span>
      {venues.map(v => <span key={v.venue}><i className={`lead-${v.venue}`} />{v.name} ({v.symbol})</span>)}
    </div>
  </>;
}

function HistoryPanel({ history, busy, onClear }: { history: LeadView['history']; busy: boolean; onClear: () => Promise<void> }) {
  return <section className="panel" aria-label="历史测试记录">
    <div className="panel-heading">
      <h2>历史测试记录</h2>
      <div className="vl-lead-head-actions">
        <span className="muted">最多保存最近 20 条</span>
        {history.length ? <button type="button" className="button secondary" disabled={busy} onClick={() => void onClear()}>
          <Trash2 size={14} aria-hidden="true" />清空历史
        </button> : null}
      </div>
    </div>
    {history.length ? <div className="vl-table"><table>
      <thead><tr><th>测试时间</th><th>Binance 标的</th><th>参数</th><th className="num">事件数</th><th>各场所结果（中位延迟 / 跟进率 / 互相关峰值）</th></tr></thead>
      <tbody>{history.map(item => <tr key={item.id}>
        <td>{stampMsText(item.startedAt)}<small>耗时 {Math.round(item.elapsedMs / 1000)} s · {item.status === 'completed' ? '完成' : '手动停止'}</small></td>
        <td><span className="vl-symbol">{item.config.binanceSymbol}</span></td>
        <td>阈值 {item.config.thresholdBps} bps<small>窗口 {item.config.impulseWindowMs}ms · 跟进 {Math.round(item.config.followRatio * 100)}%</small></td>
        <td className="num">{item.eventCount}</td>
        <td className="wrap">{item.venues.map(v => `${v.name}(${v.symbol}): ${formatLagMs(v.medianMs)} / ${v.followRate !== null ? percent(v.followRate, 0) : '—'}${v.peakLagMs !== null ? ` / 峰值 ${formatLagMs(v.peakLagMs)}` : ''}`).join('；')}</td>
      </tr>)}</tbody>
    </table></div> : <TableEmpty>还没有历史测速记录</TableEmpty>}
  </section>;
}
