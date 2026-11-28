// DEX 价差子模块「Binance & 多参考源领先测速」（#/varlighter/lead）：
// - 独立 lead.sqlite 常驻采集（最多 3 个标的、7 天滚动保留、7 个免 Key 领先源对比 3 个 DEX 目标）；
// - 离线 Worker 分析查询：领先源横向排行榜 + 分时段延迟趋势 + 500ms 收益率互相关 + 多源涨跌幅对比。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LoaderCircle, Pause, Play, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api } from '../api.ts';
import { useDialogGuard } from '../AppDialog.tsx';
import { Callout, StatePanel, TableEmpty } from '../StateViews.tsx';
import { SvgPlot, type PlotLayer } from '../svg-plot.tsx';
import { niceAxis } from '../svg-plot-geometry.ts';
import { useLiveResource } from '../use-live-resource.ts';
import type {
  LeadAnalyzeView,
  LeadCandidateView,
  LeadRefSource,
  LeadSource,
  LeadVenue,
  LeadVenueStatsView,
  LeadView,
  LeadWatcherView,
} from '../../../src/varlighter/views.ts';
import { Badge, Metric, stampMsText, useWrite } from './parts.tsx';
import { VARLIGHTER_BASE, age, bps, percent, plain, price } from './varlighter-form.ts';
import {
  DEFAULT_LEAD_FORM,
  LEAD_ANALYZE_WINDOWS,
  LEAD_CATEGORY_LABELS,
  LEAD_NUM_FIELDS,
  LEAD_REF_LABELS,
  LEAD_REF_SHORT,
  LEAD_REF_SOURCES,
  LEAD_SOURCE_LABELS,
  LEAD_VENUE_LABELS,
  LEAD_VENUE_SHORT,
  LEAD_VENUES,
  applyCandidate,
  buildAnalyzeSeriesRows,
  buildAnalyzeXcorrRows,
  buildBucketRows,
  catalogSummaryText,
  formatDbBytes,
  formatEventVenue,
  formatLagMs,
  lagTone,
  lagVerdict,
  leadWatcherRequest,
  type LeadForm,
} from './varlighter-lead-form.ts';

const LEAD_PATH = `${VARLIGHTER_BASE}/lead`;
const LEAD_REFRESH_MS = 2_000;
const READ_TIMEOUT_MS = 15_000;
const CHART_MARGIN = { top: 12, right: 56, bottom: 30 };

const VENUE_LAYERS: PlotLayer[] = [
  { kind: 'line', key: 'lighter', color: 'var(--accent)', width: 1.75, active: true },
  { kind: 'line', key: 'rh', color: 'var(--emerald)', width: 1.75, active: true },
  { kind: 'line', key: 'entropy', color: 'var(--warning)', width: 1.75, active: true },
];

const SERIES_COLORS: Record<LeadSource, { color: string; dash?: string; width: number }> = {
  binance_perp: { color: 'var(--text-primary)', width: 1.75 },
  binance_spot: { color: 'var(--text-secondary)', dash: '4 2', width: 1.4 },
  binance_equity: { color: 'var(--error)', width: 1.75 },
  hl_xyz: { color: 'var(--info)', width: 1.5 },
  coinbase_spot: { color: 'var(--info)', dash: '4 2', width: 1.4 },
  okx_perp: { color: 'var(--emerald)', dash: '3 2', width: 1.4 },
  bybit_perp: { color: 'var(--warning)', dash: '3 2', width: 1.4 },
  lighter: { color: 'var(--accent)', width: 1.5 },
  rh: { color: 'var(--emerald)', width: 1.5 },
  entropy: { color: 'var(--warning)', width: 1.5 },
};

const ALL_SERIES_LAYERS: PlotLayer[] = ([...LEAD_REF_SOURCES, ...LEAD_VENUES] as LeadSource[]).map(key => ({
  kind: 'line',
  key,
  color: SERIES_COLORS[key].color,
  dash: SERIES_COLORS[key].dash,
  width: SERIES_COLORS[key].width,
  active: key === 'binance_perp' || key === 'binance_equity' || key === 'lighter',
}));

function parseLeadView(raw: unknown): LeadView {
  const v = raw as LeadView | null;
  if (!v || typeof v !== 'object' || !v.catalog || !v.storage || !Array.isArray(v.watchers) || !Array.isArray(v.candidates)) {
    throw new Error('领先测速应答格式不对');
  }
  return v;
}

const clockSec = (time: number): string => {
  const d = new Date(time);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
};

const bucketClock = (spanMs: number) => (time: number): string => {
  const d = new Date(time);
  if (spanMs <= 24 * 3_600_000) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:00`;
};

export function VarLighterLead({ onExpired }: { onExpired: () => void }) {
  const live = useLiveResource<LeadView>(LEAD_PATH, { intervalMs: LEAD_REFRESH_MS, timeoutMs: READ_TIMEOUT_MS, parse: parseLeadView, onExpired });
  const write = useWrite();
  const dialog = useDialogGuard();

  const [form, setForm] = useState<LeadForm>(DEFAULT_LEAD_FORM);
  const [candidateQuery, setCandidateQuery] = useState('');
  const [formInitialized, setFormInitialized] = useState(false);

  // 离线分析区状态（与 2s 轮询解耦，仅在主动查询或切换维度时派发 Worker）
  const [selectedSymbol, setSelectedSymbol] = useState<string>('');
  const [hours, setHours] = useState<number>(6);
  const [selectedLead, setSelectedLead] = useState<LeadRefSource | null>(null);
  const [analysis, setAnalysis] = useState<LeadAnalyzeView | null>(null);
  const [analyzeBusy, setAnalyzeBusy] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const analyzeSeq = useRef(0);
  const initialAnalyzeRan = useRef(false);

  const data = live.data;

  // 所有可分析标的：合并常驻列表与独立库中仍存有 7 天数据的历史标的
  const analyzeSymbols = useMemo(() => {
    if (!data) return [];
    const set = new Set<string>();
    for (const w of data.watchers) set.add(w.symbol);
    for (const s of data.storage.symbols) set.add(s.symbol);
    return [...set];
  }, [data]);

  const runAnalyze = useCallback(async (sym: string, h: number, leadSrc: LeadRefSource | null) => {
    if (!sym) return;
    initialAnalyzeRan.current = true;
    const seq = ++analyzeSeq.current;
    setAnalyzeBusy(true);
    setAnalyzeError(null);
    try {
      const res = await api<LeadAnalyzeView>(`${LEAD_PATH}/analyze`, {
        body: { symbol: sym, hours: h, ...(leadSrc ? { leadSource: leadSrc } : {}) },
      });
      if (analyzeSeq.current !== seq) return;
      setAnalysis(res);
    } catch (error) {
      if (analyzeSeq.current !== seq) return;
      setAnalyzeError(error instanceof Error ? error.message : String(error));
    } finally {
      if (analyzeSeq.current === seq) setAnalyzeBusy(false);
    }
  }, []);

  // 冷启动自动预填添加表单第一个候选
  useEffect(() => {
    if (!data || formInitialized) return;
    if (data.candidates.length && !form.symbol) {
      const next = data.candidates.find(c => !data.watchers.some(w => w.symbol === c.symbol)) ?? data.candidates[0]!;
      setForm(current => applyCandidate(current, next));
      setFormInitialized(true);
    } else if (!data.catalog.loading) {
      setFormInitialized(true);
    }
  }, [data, formInitialized, form.symbol]);

  // 当前所选分析标的若被移除且无历史数据时，同步回落到首个可用标的
  useEffect(() => {
    if (!selectedSymbol || analyzeSymbols.includes(selectedSymbol)) return;
    const next = analyzeSymbols[0] ?? '';
    setSelectedSymbol(next);
    setSelectedLead(null);
    if (!next) setAnalysis(null);
  }, [analyzeSymbols, selectedSymbol]);

  // 首次进页若已有常驻或历史标的，自动触发一次 6 小时离线分析（避免与加仓写入竞态）
  useEffect(() => {
    if (!data || initialAnalyzeRan.current || write.busy === 'add') return;
    const first = analyzeSymbols[0];
    if (!first) return;
    initialAnalyzeRan.current = true;
    setSelectedSymbol(first);
    void runAnalyze(first, hours, null);
  }, [data, analyzeSymbols, hours, runAnalyze, write.busy]);

  const filteredCandidates = useMemo(() => {
    if (!data) return [];
    const q = candidateQuery.trim().toUpperCase();
    const list = q
      ? data.candidates.filter(item =>
          item.symbol.includes(q)
          || Object.values(item.leads).some(v => v?.toUpperCase().includes(q))
          || Object.values(item.targets).some(v => v?.toUpperCase().includes(q)))
      : data.candidates;
    return list.slice(0, 60);
  }, [data, candidateQuery]);

  if (!data) {
    return live.error
      ? <StatePanel kind="error" title="读取领先测速失败" detail={live.error.message} />
      : <StatePanel kind="loading" title="加载领先测速中…" />;
  }

  const parsed = leadWatcherRequest(form);
  const busy = write.busy !== null;
  const fullWatchers = data.watchers.length >= data.maxWatchers;
  const set = (patch: Partial<LeadForm>) => {
    setFormInitialized(true);
    setForm(current => ({ ...current, ...patch }));
  };

  const refreshCatalog = () => {
    void write.run('catalog', () => api<LeadView>(`${LEAD_PATH}/catalog`, { body: {} }), result => {
      void live.refresh();
      const errs = LEAD_REF_SOURCES.filter(s => result.catalog.sources[s].error !== null);
      if (errs.length === 6) return { tone: 'error', text: '全部参考源公开目录拉取失败' };
      if (errs.length) return { tone: 'warning', text: `部分目录拉取异常（${errs.map(s => LEAD_REF_SHORT[s]).join('、')}），不影响其余源与手填代码` };
      return '已刷新全部参考领先源公开目录';
    });
  };

  const addWatcher = () => {
    if (!parsed.ok || fullWatchers) return;
    void write.run('add', () => api<LeadView>(`${LEAD_PATH}/watchers/add`, { body: parsed.value }), () => {
      initialAnalyzeRan.current = true;
      void live.refresh();
      setSelectedSymbol(parsed.value.symbol);
      setSelectedLead(null);
      void runAnalyze(parsed.value.symbol, hours, null);
      return `已添加常驻测速标的 ${parsed.value.symbol}（数据将保留 ${data.retentionDays} 天）`;
    });
  };

  const toggleWatcher = (w: LeadWatcherView) => {
    const nextEnabled = !w.enabled;
    void write.run(`toggle:${w.symbol}`, () => api<LeadView>(`${LEAD_PATH}/watchers/toggle`, {
      body: { symbol: w.symbol, enabled: nextEnabled, updatedAt: w.updatedAt },
    }), () => {
      void live.refresh();
      return `${w.symbol} 已${nextEnabled ? '恢复常驻采集' : '暂停采集'}`;
    });
  };

  const removeWatcher = async (w: LeadWatcherView) => {
    if (!await dialog.confirm(`移除常驻标的 ${w.symbol}？将关闭其实时行情流，已写入 lead.sqlite 的 ${data.retentionDays} 天历史统计默认保留供离线分析。`, {
      title: `移除常驻标的 ${w.symbol}`, confirmLabel: '移除', tone: 'danger',
    })) return;
    if (!dialog.isAlive()) return;
    void write.run(`remove:${w.symbol}`, () => api<LeadView>(`${LEAD_PATH}/watchers/remove`, {
      body: { symbol: w.symbol, updatedAt: w.updatedAt },
    }), result => {
      void live.refresh();
      const stillStored = result.storage.symbols.some(s => s.symbol === w.symbol);
      if (selectedSymbol === w.symbol && !stillStored) {
        const nextSym = result.watchers[0]?.symbol ?? result.storage.symbols[0]?.symbol ?? '';
        setSelectedSymbol(nextSym);
        setSelectedLead(null);
        if (nextSym) void runAnalyze(nextSym, hours, null);
        else setAnalysis(null);
      }
      return `已移除常驻标的 ${w.symbol}`;
    });
  };

  const clearSymbolData = async () => {
    const sym = selectedSymbol || analysis?.symbol || '';
    const msg = sym
      ? `清空标的 ${sym} 在 lead.sqlite 中的全部历史事件与网格采样？（不影响常驻配置）`
      : '清空 lead.sqlite 中所有标的的历史事件与网格采样？（不影响常驻配置）';
    if (!await dialog.confirm(msg, { title: '清空历史数据', confirmLabel: '清空', tone: 'danger' })) return;
    if (!dialog.isAlive()) return;
    void write.run('clear', () => api<LeadView>(`${LEAD_PATH}/clear`, { body: sym ? { symbol: sym } : {} }), () => {
      void live.refresh();
      setAnalysis(null);
      return sym ? `已清空 ${sym} 的历史测速数据` : '已清空全部历史测速数据';
    });
  };

  const pickCandidate = (candidate: LeadCandidateView) => {
    setFormInitialized(true);
    setForm(current => applyCandidate(current, candidate));
  };

  const selectAnalyzeTarget = (sym: string, h = hours, leadSrc: LeadRefSource | null = null) => {
    setSelectedSymbol(sym);
    setSelectedLead(leadSrc);
    setHours(h);
    void runAnalyze(sym, h, leadSrc);
  };

  return <>
    {live.error ? <p className="vl-note err" role="status">刷新失败：{live.error.message}（停留在 {live.receivedAt ? new Date(live.receivedAt).toLocaleTimeString() : '—'}）</p> : null}

    <section className="panel" aria-label="常驻多源测速管理">
      <div className="panel-heading">
        <h2>常驻测速标的（{data.watchers.length} / {data.maxWatchers}）</h2>
        <div className="vl-lead-head-actions">
          <span className="muted">
            {data.storage.file} · 保留 {data.retentionDays} 天 · {formatDbBytes(data.storage.dbBytes)} · {data.storage.totalEvents} 次事件 / {data.storage.totalGridPoints} 网格点
          </span>
          <span className="muted">{catalogSummaryText(data.catalog)}</span>
          <button type="button" className="button secondary" disabled={busy || data.catalog.loading} onClick={refreshCatalog}>
            {write.busy === 'catalog' || data.catalog.loading ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
            刷新目录
          </button>
        </div>
      </div>

      {data.storage.error ? <Callout tone="error">独立存储异常（不影响实盘主模块）：{data.storage.error}</Callout> : null}
      {write.message ? <Callout tone={write.message.tone}>{write.message.text}</Callout> : null}

      {data.watchers.length ? <div className="vl-lead-watchers">
        {data.watchers.map(w => <WatcherCard
          key={w.symbol}
          watcher={w}
          now={data.now}
          busy={busy}
          activeAnalyze={selectedSymbol === w.symbol}
          onAnalyze={() => selectAnalyzeTarget(w.symbol, hours, null)}
          onToggle={() => toggleWatcher(w)}
          onRemove={() => void removeWatcher(w)}
        />)}
      </div> : <TableEmpty>当前还没有常驻测速标的。可在下方一键选择候选标的（或手动输入）添加，最多同时常驻 {data.maxWatchers} 个标的，不设时长限制并自动保留 {data.retentionDays} 天历史。</TableEmpty>}

      <details className="vl-lead-adv" open={data.watchers.length === 0}>
        <summary>
          + 添加常驻标的（同时支持 Binance 合约/现货/股票、Hyperliquid xyz、Coinbase、OKX、Bybit 共 7 个免 Key 领先源{fullWatchers ? ' · 已达 3 个上限' : ''}）
        </summary>

        <datalist id="vl-lead-binance_perp">{data.catalog.contracts.binance_perp.map(c => <option key={c.symbol} value={c.symbol} />)}</datalist>
        <datalist id="vl-lead-binance_spot">{data.catalog.contracts.binance_spot.map(c => <option key={c.symbol} value={c.symbol} />)}</datalist>
        <datalist id="vl-lead-hl_xyz">{data.catalog.contracts.hl_xyz.map(c => <option key={c.symbol} value={c.symbol} />)}</datalist>
        <datalist id="vl-lead-coinbase_spot">{data.catalog.contracts.coinbase_spot.map(c => <option key={c.symbol} value={c.symbol} />)}</datalist>
        <datalist id="vl-lead-okx_perp">{data.catalog.contracts.okx_perp.map(c => <option key={c.symbol} value={c.symbol} />)}</datalist>
        <datalist id="vl-lead-bybit_perp">{data.catalog.contracts.bybit_perp.map(c => <option key={c.symbol} value={c.symbol} />)}</datalist>
        {LEAD_VENUES.map(venue => (
          <datalist key={venue} id={`vl-lead-${venue}`}>
            {(data.dexCatalogs[venue] ?? []).map(item => <option key={item.symbol} value={item.symbol} />)}
          </datalist>
        ))}

        <div className="vl-toolbar">
          <input type="search" value={candidateQuery} onChange={e => setCandidateQuery(e.target.value)} placeholder="搜索并一键填齐多源候选（如 NVDA、BTC、ETH、ANT）" aria-label="筛选候选标的" />
          <span className="grow" />
          <span className="muted">点选候选卡片可自动填入对应场所与多条参考源</span>
        </div>

        {filteredCandidates.length ? <div className="vl-lead-chips" aria-label="多源自动匹配候选">
          {filteredCandidates.map(item => {
            const activeChip = form.symbol.trim().toUpperCase() === item.symbol;
            const added = data.watchers.some(w => w.symbol === item.symbol);
            return <button type="button" key={item.symbol} className={`vl-lead-chip${activeChip ? ' active' : ''}`} onClick={() => pickCandidate(item)}>
              <b>{item.symbol}</b>
              <Badge tone={item.kind === 'us_equity' ? 'info' : ''}>{LEAD_CATEGORY_LABELS[item.kind]}</Badge>
              {added ? <Badge tone="ok">已常驻</Badge> : null}
              <small>{item.leadCount}L · {item.targetCount}D</small>
            </button>;
          })}
        </div> : null}

        <div className="vl-lead-form">
          <label className="vl-field">
            基础标的代码
            <input value={form.symbol} onChange={e => set({ symbol: e.target.value.toUpperCase() })} placeholder="如 NVDA / BTC" />
            <small>用于归并统计与排行榜标识</small>
          </label>
          {LEAD_REF_SOURCES.map(src => {
            const st = data.catalog.sources[src];
            const listId = src === 'binance_equity' ? undefined : `vl-lead-${src}`;
            return <label className="vl-field" key={src}>
              {LEAD_REF_LABELS[src]}（可选）
              <input list={listId} value={form[src]} onChange={e => set({ [src]: src === 'hl_xyz' ? e.target.value : e.target.value.toUpperCase() })} placeholder="留空不订阅" />
              <small>{src === 'binance_equity' ? '美股 @quote 实时流（免 Key）' : st.error ? `目录异常：${st.error}` : st.count ? `目录 ${st.count} 个` : '可手动填写代码'}</small>
            </label>;
          })}
          {LEAD_VENUES.map(venue => {
            const count = (data.dexCatalogs[venue] ?? []).length;
            return <label className="vl-field" key={venue}>
              目标 · {LEAD_VENUE_LABELS[venue]}（可选）
              <input list={`vl-lead-${venue}`} value={form[venue]} onChange={e => set({ [venue]: e.target.value })} placeholder="留空不对比" />
              <small>{count ? `目录 ${count} 个` : '目录未同步'}</small>
            </label>;
          })}
        </div>

        <details className="vl-lead-adv">
          <summary>跃动检测参数（阈值 {form.thresholdBps} bps · 变化窗 {form.impulseWindowMs} ms · 跟进比 {form.followRatio} · 最大等待 {form.maxWaitMs} ms · 冷却 {form.cooldownMs} ms）</summary>
          <div className="vl-fields">
            {LEAD_NUM_FIELDS.map(field => <label className="vl-field" key={field.key}>
              {field.label}
              <input inputMode="decimal" value={form[field.key]} onChange={e => set({ [field.key]: e.target.value })} />
              <small>范围 {field.min} – {field.max}</small>
            </label>)}
          </div>
        </details>

        <div className="vl-actions">
          <button type="button" className="button primary" disabled={!parsed.ok || busy || fullWatchers} onClick={addWatcher}>
            {write.busy === 'add' ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}
            加入常驻测速
          </button>
          {fullWatchers ? <Callout tone="warning">已达到最多 {data.maxWatchers} 个常驻上限，请先移除不用的标的。</Callout>
            : !parsed.ok ? <Callout tone="warning" role="status">{parsed.error}</Callout> : null}
        </div>
      </details>
    </section>

    <section className="panel" aria-label="历史离线分析控制">
      <div className="panel-heading">
        <h2>多源领先排行与历史分析（Worker 线程离线计算）</h2>
        <div className="vl-lead-head-actions">
          <select
            aria-label="选择分析标的"
            value={selectedSymbol}
            onChange={e => selectAnalyzeTarget(e.target.value, hours, null)}
            disabled={!analyzeSymbols.length || analyzeBusy}
          >
            {analyzeSymbols.length
              ? analyzeSymbols.map(sym => <option key={sym} value={sym}>{sym}</option>)
              : <option value="">暂无可分析标的</option>}
          </select>
          <div className="vl-lead-pills" role="group" aria-label="时间窗口选择">
            {LEAD_ANALYZE_WINDOWS.map(w => (
              <button
                type="button"
                key={w.hours}
                className={`vl-lead-pill${hours === w.hours ? ' active' : ''}`}
                disabled={!selectedSymbol || analyzeBusy}
                onClick={() => selectAnalyzeTarget(selectedSymbol, w.hours, selectedLead)}
              >
                {w.label}
              </button>
            ))}
          </div>
          <button type="button" className="button secondary" disabled={!selectedSymbol || analyzeBusy} onClick={() => void runAnalyze(selectedSymbol, hours, selectedLead)}>
            {analyzeBusy ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
            立即计算
          </button>
          <button type="button" className="button secondary" disabled={busy || !data.storage.totalEvents && !data.storage.totalGridPoints} onClick={() => void clearSymbolData()}>
            <Trash2 size={14} aria-hidden="true" />
            清空历史
          </button>
        </div>
      </div>

      {analyzeError ? <Callout tone="error">离线分析失败：{analyzeError}</Callout> : null}

      {analysis ? <AnalyzeViewContent
        analysis={analysis}
        busy={analyzeBusy}
        onPickLead={leadSrc => selectAnalyzeTarget(analysis.symbol, hours, leadSrc)}
      /> : <TableEmpty>
        {analyzeBusy ? '正在从 lead.sqlite 还原网格并在 Worker 线程计算…' : '添加常驻标的并采集数据后，在此选择标的和时间窗口（1 小时 – 7 天）进行多源横向对比与分时段分析。'}
      </TableEmpty>}
    </section>

    <section className="panel" aria-label="多源与独立库口径说明">
      <details className="vl-help">
        <summary>多源常驻架构与口径说明（独立 lead.sqlite + Worker 离线算图 + 免 Key 多领先源）</summary>
        <dl>
          <dt>常驻与独立存储</dt><dd>最多同时常驻 3 个标的，每秒将已结算事件与稀疏 100 ms 网格变化点（含每 30 s 心跳锚点与断线哨兵）单事务批量写入独立 <code>lead.sqlite</code>，自动滚动清理 7 天前旧样本，物理隔离于 <code>varlighter.sqlite</code> 实盘主库。</dd>
          <dt>7 个免 Key 领先参考源</dt><dd>同时订阅 <b>Binance 合约</b>（<code>@bookTicker</code>）、<b>Binance 现货</b>（<code>@bookTicker</code>）、<b>Binance 股票</b>（<code>@quote</code>）、<b>Hyperliquid xyz</b>（<code>bbo</code> + <code>l2Book</code>）、<b>Coinbase 现货</b>（<code>ticker</code>）、<b>OKX 永续</b>（<code>bbo-tbt</code> 10ms）与 <b>Bybit 永续</b>（<code>orderbook.1</code> 10ms）。</dd>
          <dt>谁比 Binance 更快（Leaderboard）</dt><dd>对同一标的的所有启用参考源，除分别对比三家目标 DEX（Lighter 主网/RH、Entropy）外，额外通过 500 ms 收益率互相关计算其相对「Binance 合约」的领先毫秒数（正值代表更快先动）。</dd>
          <dt>Worker 离线计算与互相关窗口</dt><dd>全时段事件（最长 7 天）聚合分位与分时段延迟趋势图；100 ms 密集网格还原与互相关计算限定于查询窗口末端最多 6 小时并在独立 Worker 线程（<code>7.5 s</code> 超时保护）执行，绝不阻塞 DEX 实盘主线程。</dd>
        </dl>
      </details>
    </section>
  </>;
}

function WatcherCard({
  watcher, now, busy, activeAnalyze, onAnalyze, onToggle, onRemove,
}: {
  watcher: LeadWatcherView;
  now: number;
  busy: boolean;
  activeAnalyze: boolean;
  onAnalyze: () => void;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const statusBadge = watcher.status === 'running'
    ? <Badge tone="ok">常驻采集</Badge>
    : watcher.status === 'waiting_catalog'
      ? <Badge tone="warn">等待 DEX 目录</Badge>
      : <Badge tone="info">已暂停</Badge>;

  return <div className="vl-lead-watcher">
    <div className="vl-lead-watcher-head">
      <div className="vl-lead-watcher-title">
        <strong className="vl-symbol">{watcher.symbol}</strong>
        {statusBadge}
        <span className="muted">
          阈值 {watcher.config.thresholdBps} bps · 窗 {watcher.config.impulseWindowMs} ms · 近 30m {watcher.recentEventCount} 次事件
          {watcher.startedAt ? ` · 本轮起于 ${age(watcher.startedAt, now)}` : ''}
        </span>
      </div>
      <div className="vl-lead-watcher-actions">
        <button type="button" className={`button ${activeAnalyze ? 'primary' : 'secondary'}`} onClick={onAnalyze}>
          查看分析
        </button>
        <button type="button" className="button secondary" disabled={busy} onClick={onToggle}>
          {watcher.enabled ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
          {watcher.enabled ? '暂停' : '恢复'}
        </button>
        <button type="button" className="button secondary" disabled={busy} onClick={onRemove}>
          <Trash2 size={14} aria-hidden="true" />
          移除
        </button>
      </div>
    </div>

    <div className="vl-lead-streams">
      {watcher.streams.map(s => <span key={s.source} className="vl-lead-stream-pill">
        <Badge tone={s.connected ? 'ok' : 'bad'}>{s.connected ? '连' : '断'}</Badge>
        <b>{LEAD_SOURCE_LABELS[s.source]}</b>
        <small>{s.symbol}</small>
        <span>{s.mid !== null ? price(s.mid) : (s.lastError ?? '等首档')}</span>
        {s.ticksPerSec > 0 ? <small>{s.ticksPerSec}/s</small> : null}
        {s.lastError && s.mid !== null ? <small className="vl-down">{s.lastError}</small> : null}
      </span>)}
    </div>

    {watcher.recentSummary.some(r => r.events > 0) ? <div className="vl-lead-streams">
      {watcher.recentSummary.filter(r => r.events > 0).map(r => (
        <span key={r.leadSource} className="vl-lead-stream-pill">
          <b>{LEAD_REF_SHORT[r.leadSource]}（{r.events}次）</b>
          {LEAD_VENUES.filter(v => r.venues[v]).map(v => {
            const cell = r.venues[v]!;
            return <small key={v}>{LEAD_VENUE_SHORT[v]} {formatLagMs(cell.medianMs)} ({cell.followRate !== null ? percent(cell.followRate, 0) : '—'})</small>;
          })}
        </span>
      ))}
    </div> : null}
  </div>;
}

function AnalyzeViewContent({
  analysis, busy, onPickLead,
}: {
  analysis: LeadAnalyzeView;
  busy: boolean;
  onPickLead: (lead: LeadRefSource) => void;
}) {
  const activeName = LEAD_REF_LABELS[analysis.activeLead];
  const bucketRows = useMemo(() => buildBucketRows(analysis), [analysis]);
  const xcorrRows = useMemo(() => buildAnalyzeXcorrRows(analysis), [analysis]);
  const seriesRows = useMemo(() => buildAnalyzeSeriesRows(analysis), [analysis]);
  const xcorrVenues = analysis.venues.filter(v => v.xcorr !== null);

  // 确定相对涨跌幅走势图实际包含哪些源，动态裁剪 layers 与图例避免空图例泛滥
  const presentSeriesSources = useMemo(() => {
    const present = new Set<LeadSource>();
    for (const pt of analysis.series) {
      for (const [k, v] of Object.entries(pt.values)) {
        if (v !== null) present.add(k as LeadSource);
      }
    }
    return ([...LEAD_REF_SOURCES, ...LEAD_VENUES] as LeadSource[]).filter(s => present.has(s));
  }, [analysis.series]);

  const seriesLayers = useMemo(
    () => ALL_SERIES_LAYERS.filter(l => l.kind === 'line' && presentSeriesSources.includes(l.key as LeadSource)),
    [presentSeriesSources],
  );

  return <>
    <p className="vl-note">
      当前主基准：<b>{activeName}</b> · 查询区间 {new Date(analysis.from).toLocaleString()} ~ {new Date(analysis.to).toLocaleString()} ·
      共 {analysis.eventCount} 次跃动事件 · Worker 用时 {analysis.computedMs} ms
      {analysis.xcorrTruncated ? ' · （注：互相关与走势图取末端最多 6 小时）' : ''}
      {analysis.gridTruncated ? ' · （注：高密度网格已截断最新 40 万行）' : ''}
    </p>

    <div className="panel-heading">
      <h3>领先源横向对比榜（按综合领先 DEX 中位速度排序）</h3>
      <div className="vl-lead-pills">
        {analysis.availableLeads.map(src => (
          <button
            type="button"
            key={src}
            className={`vl-lead-pill${analysis.activeLead === src ? ' active' : ''}`}
            disabled={busy}
            onClick={() => onPickLead(src)}
          >
            {LEAD_REF_LABELS[src]}
          </button>
        ))}
      </div>
    </div>

    {analysis.leaderboard.length ? <div className="vl-table vl-lead-board"><table>
      <thead><tr>
        <th>领先参考源 · 代码</th>
        <th className="num">跃动事件</th>
        <th className="num">相对 Binance 合约</th>
        <th className="num">综合领先 P50</th>
        {LEAD_VENUES.map(v => <th className="num" key={v}>{LEAD_VENUE_LABELS[v]}（P50 / 跟进 / 互相关）</th>)}
        <th>主视角</th>
      </tr></thead>
      <tbody>{analysis.leaderboard.map(row => {
        const isCurrent = row.leadSource === analysis.activeLead;
        return <tr key={row.leadSource} className={isCurrent ? 'vl-lead-active-row' : undefined}>
          <td><span className="vl-symbol">{row.name}</span><small>{row.symbol}</small></td>
          <td className="num">{row.events}</td>
          <td className={`num vl-${row.leadSource === 'binance_perp' ? 'dim' : (lagTone(row.vsBinancePerpMs) || 'dim')}`}>
            {row.leadSource === 'binance_perp' ? '基准 (0 ms)' : formatLagMs(row.vsBinancePerpMs)}
            {row.vsBinancePerpCorr !== null && row.leadSource !== 'binance_perp' ? <small>r = {row.vsBinancePerpCorr.toFixed(2)}</small> : null}
          </td>
          <td className={`num vl-${lagTone(row.overallMedianMs) || 'dim'}`}><b>{formatLagMs(row.overallMedianMs)}</b></td>
          {LEAD_VENUES.map(v => {
            const cell = row.venues[v];
            if (!cell) return <td className="num vl-dim" key={v}>—</td>;
            return <td className="num" key={v}>
              <span className={`vl-${lagTone(cell.medianMs) || 'dim'}`}><b>{formatLagMs(cell.medianMs)}</b></span>
              <small>
                {cell.followRate !== null ? `${percent(cell.followRate, 0)} (${cell.followed})` : '无事件'}
                {cell.peakLagMs !== null ? ` · 峰 ${formatLagMs(cell.peakLagMs)}` : ''}
              </small>
            </td>;
          })}
          <td>
            <button type="button" className={`button ${isCurrent ? 'primary' : 'secondary'}`} disabled={busy || isCurrent} onClick={() => onPickLead(row.leadSource)}>
              {isCurrent ? '当前' : '设为主视角'}
            </button>
          </td>
        </tr>;
      })}</tbody>
    </table></div> : <TableEmpty>该标的选择时间段内暂无参考源对比数据</TableEmpty>}

    <section className="vl-metrics" aria-label="主基准各场所核心统计">
      {analysis.venues.map(v => <Metric
        key={v.venue}
        label={`${activeName} → ${v.name} (${v.symbol})`}
        value={v.medianMs !== null ? formatLagMs(v.medianMs) : v.xcorr ? formatLagMs(v.xcorr.peakLagMs) : '—'}
        tone={lagTone(v.medianMs ?? v.xcorr?.peakLagMs ?? null)}
        accent={v.followed >= 3 && (v.medianMs ?? 0) > 50}
        foot={`${lagVerdict(v, activeName)} · 跟进 ${v.followed}/${v.followed + v.unfollowed} · P90 ${formatLagMs(v.p90Ms)}`}
      />)}
    </section>

    <div className="vl-table"><table>
      <thead><tr>
        <th>目标 DEX · 代码</th><th className="num">跟进 / 有效</th><th className="num">领先占比</th>
        <th className="num">P25</th><th className="num">中位 P50</th><th className="num">均值</th>
        <th className="num">P75</th><th className="num">P90</th><th className="num">P95</th>
        <th className="num">最小 / 最大</th><th className="num">互相关峰值（样本点）</th>
      </tr></thead>
      <tbody>{analysis.venues.map(v => {
        const resolved = v.followed + v.unfollowed;
        return <tr key={v.venue}>
          <td><span className="vl-symbol">{v.name}</span><small>{v.symbol}</small></td>
          <td className="num">{v.followRate !== null ? percent(v.followRate, 0) : '—'}<small>{v.followed}/{resolved}{v.disconnected + v.noData ? ` · 缺 ${v.disconnected + v.noData}` : ''}</small></td>
          <td className="num">{v.bnLeadRate !== null ? percent(v.bnLeadRate, 0) : '—'}<small>先 {v.bnLeadCount} / 反超 {v.dexLeadCount}</small></td>
          <td className="num">{formatLagMs(v.p25Ms)}</td>
          <td className={`num vl-${lagTone(v.medianMs) || 'dim'}`}><b>{formatLagMs(v.medianMs)}</b></td>
          <td className="num">{formatLagMs(v.meanMs)}</td>
          <td className="num">{formatLagMs(v.p75Ms)}</td>
          <td className="num">{formatLagMs(v.p90Ms)}</td>
          <td className="num">{formatLagMs(v.p95Ms)}</td>
          <td className="num">{v.minMs !== null ? `${formatLagMs(v.minMs)} / ${formatLagMs(v.maxMs)}` : '—'}</td>
          <td className="num">{v.xcorr ? <><span className={`vl-${lagTone(v.xcorr.peakLagMs) || 'dim'}`}>{formatLagMs(v.xcorr.peakLagMs)}</span><small>r = {v.xcorr.peakCorr.toFixed(2)}（{v.xcorr.samples} 点）</small></> : <span className="vl-dim">{v.xcorrReason ?? '—'}</span>}</td>
        </tr>;
      })}</tbody>
    </table></div>

    <div className="vl-lead-grid3">
      <section className="panel" aria-label="分时段中位延迟趋势">
        <div className="panel-heading"><h3>分时段中位延迟趋势</h3><span className="muted">每 {Math.round(analysis.bucketMs / 60_000)} 分钟分位</span></div>
        {bucketRows.length >= 2 ? <BucketTrendChart rows={bucketRows} venues={analysis.venues} spanMs={analysis.to - analysis.from} />
          : <TableEmpty>至少需要 2 个活跃时段桶才能绘制趋势线（当前 {bucketRows.length} 个）。</TableEmpty>}
      </section>

      <section className="panel" aria-label="互相关领先曲线">
        <div className="panel-heading"><h3>500ms 收益率互相关</h3><span className="muted">正滞后 = {LEAD_REF_SHORT[analysis.activeLead]} 领先 · 0 ms 虚线</span></div>
        {xcorrVenues.length && xcorrRows.length >= 2 ? <XcorrChart rows={xcorrRows} venues={analysis.venues} />
          : <TableEmpty>{analysis.venues.map(v => `${v.name}: ${v.xcorrReason ?? '样本不足'}`).join(' · ') || '互相关采样不足'}</TableEmpty>}
      </section>

      <section className="panel" aria-label="多源归一化相对走势">
        <div className="panel-heading"><h3>多源相对涨跌幅走势（基点）</h3><span className="muted">窗口起点归一化，不含跨所绝对价差</span></div>
        {seriesRows.length >= 2 && seriesLayers.length ? <MultiSeriesChart rows={seriesRows} sources={presentSeriesSources} layers={seriesLayers} spanMs={analysis.xcorrTo - analysis.xcorrFrom} />
          : <TableEmpty>该窗口暂无多源对比稀疏网格点。</TableEmpty>}
      </section>
    </div>

    <section className="panel" aria-label="跃动事件明细">
      <div className="panel-heading"><h3>{activeName} 近期跃动事件明细</h3><span className="muted">显示最新 {analysis.events.length} 次（全窗口共 {analysis.eventCount} 次）</span></div>
      {analysis.events.length ? <div className="vl-table"><table>
        <thead><tr>
          <th>触发时刻</th><th>方向</th><th className="num">跃动幅度</th><th className="num">基准 → 触发价</th>
          {analysis.venues.map(v => <th className="num" key={v.venue}>{v.name} 跟进</th>)}
        </tr></thead>
        <tbody>{analysis.events.map(ev => <tr key={ev.id}>
          <td>{stampMsText(ev.at)}</td>
          <td><Badge tone={ev.direction === 'up' ? 'ok' : 'bad'}>{ev.direction === 'up' ? '急涨' : '急跌'}</Badge></td>
          <td className={`num vl-${ev.direction === 'up' ? 'up' : 'down'}`}>{bps(ev.moveBps, 2)} bps</td>
          <td className="num">{price(ev.baseMid)} → {price(ev.triggerMid)}</td>
          {analysis.venues.map(v => {
            const cell = formatEventVenue(ev.venues[v.venue]);
            const maxMove = ev.venues[v.venue]?.maxMoveBps;
            return <td className="num" key={v.venue}>
              {cell.tone ? <Badge tone={cell.tone}>{cell.text}</Badge> : cell.text}
              {maxMove !== null && maxMove !== undefined ? <small>同向极值 {plain(maxMove, 1)} bps</small> : null}
            </td>;
          })}
        </tr>)}</tbody>
      </table></div> : <TableEmpty>选定时间段与参考源暂无触发达到 {analysis.events.length ? '' : '阈值'} 的跃动事件。</TableEmpty>}
    </section>
  </>;
}

function BucketTrendChart({ rows, venues, spanMs }: { rows: ReturnType<typeof buildBucketRows>; venues: readonly LeadVenueStatsView[]; spanMs: number }) {
  const values: number[] = [];
  for (const row of rows) {
    for (const v of venues) {
      const val = row[v.venue];
      if (val !== null) values.push(val);
    }
  }
  const axis = niceAxis(Math.min(0, ...values), Math.max(100, ...values));
  const from = rows[0]!.time, to = rows.at(-1)!.time;
  return <>
    <div className="vl-chart small">
      <SvgPlot
        rows={rows}
        xDomain={[from, to > from ? to : from + 60_000]}
        yDomain={axis.domain}
        yTicks={axis.ticks}
        yTick={v => `${Math.round(v)}ms`}
        xTick={bucketClock(spanMs)}
        layers={VENUE_LAYERS}
        references={[{ y: 0, color: 'var(--surface-6)', dash: '3 3' }]}
        margin={CHART_MARGIN}
        height={200}
        label="分时段中位延迟趋势"
        tooltip={raw => {
          const item = raw as (typeof rows)[number];
          return <div className="vl-tip">
            <b>{new Date(item.time).toLocaleString()}（{item.events} 次）</b>
            {venues.flatMap(v => [
              <span key={`${v.venue}-l`}>{v.name}</span>,
              <span key={`${v.venue}-v`}>{formatLagMs(item[v.venue])}</span>,
            ])}
          </div>;
        }}
      />
    </div>
    <div className="vl-legend">
      {venues.map(v => <span key={v.venue}><i className={`lead-${v.venue}`} />{v.name}</span>)}
    </div>
  </>;
}

function XcorrChart({ rows, venues }: { rows: ReturnType<typeof buildAnalyzeXcorrRows>; venues: readonly LeadVenueStatsView[] }) {
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
        layers={VENUE_LAYERS}
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

function MultiSeriesChart({
  rows, sources, layers, spanMs,
}: {
  rows: ReturnType<typeof buildAnalyzeSeriesRows>;
  sources: readonly LeadSource[];
  layers: readonly PlotLayer[];
  spanMs: number;
}) {
  const values: number[] = [];
  for (const row of rows) {
    for (const s of sources) {
      const val = row[s];
      if (val !== null) values.push(val);
    }
  }
  const axis = niceAxis(Math.min(-1, ...values), Math.max(1, ...values));
  const from = rows[0]!.time, to = rows.at(-1)!.time;
  return <>
    <div className="vl-chart small">
      <SvgPlot
        rows={rows}
        xDomain={[from, to > from ? to : from + 1_000]}
        yDomain={axis.domain}
        yTicks={axis.ticks}
        yTick={v => bps(v, 1)}
        xTick={spanMs <= 3_600_000 ? clockSec : bucketClock(spanMs)}
        layers={layers}
        references={[{ y: 0, color: 'var(--surface-6)', dash: '3 3' }]}
        margin={CHART_MARGIN}
        height={200}
        label="多源相对涨跌幅走势"
        tooltip={raw => {
          const item = raw as (typeof rows)[number];
          return <div className="vl-tip">
            <b>{clockSec(item.time)}</b>
            {sources.flatMap(s => [
              <span key={`${s}-n`}>{LEAD_SOURCE_LABELS[s]}</span>,
              <span key={`${s}-v`}>{bps(item[s], 2)} bps</span>,
            ])}
          </div>;
        }}
      />
    </div>
    <div className="vl-legend">
      {sources.map(s => <span key={s}><i className={`lead-${s}`} />{LEAD_SOURCE_LABELS[s]}</span>)}
    </div>
  </>;
}
