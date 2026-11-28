// DEX 价差「Binance & 多参考源领先测速」页签不依赖 DOM 的工具函数（校验、候选填充、排行榜与三图数据转换）。
import type {
  LeadAnalyzeView,
  LeadAssetCategory,
  LeadCandidateView,
  LeadCatalogStatusView,
  LeadEventVenueView,
  LeadFollowStatus,
  LeadRefSource,
  LeadSource,
  LeadVenue,
  LeadVenueStatsView,
  LeadWatcherConfig,
} from '../../../src/varlighter/views.ts';
import type { Parsed } from './varlighter-form.ts';

export const LEAD_REF_SOURCES: readonly LeadRefSource[] = [
  'binance_perp',
  'binance_spot',
  'binance_equity',
  'hl_xyz',
  'coinbase_spot',
  'okx_perp',
  'bybit_perp',
];
export const LEAD_VENUES: readonly LeadVenue[] = ['lighter', 'rh', 'entropy'];

export const LEAD_REF_LABELS: Record<LeadRefSource, string> = {
  binance_perp: 'Binance 合约',
  binance_spot: 'Binance 现货',
  binance_equity: 'Binance 股票',
  hl_xyz: 'Hyperliquid xyz',
  coinbase_spot: 'Coinbase 现货',
  okx_perp: 'OKX 永续',
  bybit_perp: 'Bybit 永续',
};

export const LEAD_REF_SHORT: Record<LeadRefSource, string> = {
  binance_perp: 'BN合约',
  binance_spot: 'BN现货',
  binance_equity: 'BN美股',
  hl_xyz: 'HL xyz',
  coinbase_spot: 'CB现货',
  okx_perp: 'OKX',
  bybit_perp: 'Bybit',
};

export const LEAD_VENUE_LABELS: Record<LeadVenue, string> = {
  lighter: 'Lighter 主网',
  rh: 'Lighter RH',
  entropy: 'Entropy',
};

export const LEAD_VENUE_SHORT: Record<LeadVenue, string> = {
  lighter: '主网',
  rh: 'RH',
  entropy: 'Entropy',
};

export const LEAD_SOURCE_LABELS: Record<LeadSource, string> = {
  ...LEAD_REF_LABELS,
  ...LEAD_VENUE_LABELS,
};

export const LEAD_CATEGORY_LABELS: Record<LeadAssetCategory, string> = {
  us_equity: '美股',
  crypto: '加密',
  tradfi: 'TradFi',
  other: '其他',
};

export const LEAD_ANALYZE_WINDOWS = [
  { hours: 1, label: '近 1 小时' },
  { hours: 6, label: '近 6 小时' },
  { hours: 24, label: '近 24 小时' },
  { hours: 72, label: '近 3 天' },
  { hours: 168, label: '近 7 天' },
] as const;

export interface LeadForm {
  symbol: string;
  binance_perp: string;
  binance_spot: string;
  binance_equity: string;
  hl_xyz: string;
  coinbase_spot: string;
  okx_perp: string;
  bybit_perp: string;
  lighter: string;
  rh: string;
  entropy: string;
  thresholdBps: string;
  impulseWindowMs: string;
  followRatio: string;
  maxWaitMs: string;
  cooldownMs: string;
}

export const DEFAULT_LEAD_FORM: LeadForm = {
  symbol: '',
  binance_perp: '',
  binance_spot: '',
  binance_equity: '',
  hl_xyz: '',
  coinbase_spot: '',
  okx_perp: '',
  bybit_perp: '',
  lighter: '',
  rh: '',
  entropy: '',
  thresholdBps: '3',
  impulseWindowMs: '1000',
  followRatio: '0.5',
  maxWaitMs: '10000',
  cooldownMs: '2000',
};

const WATCHER_SYMBOL_RE = /^[A-Z0-9._-]{1,24}$/;
const LEAD_REF_SYMBOL_RE = /^[A-Za-z0-9:._-]{1,36}$/;
const LEG_SYMBOL_RE = /^[A-Za-z0-9._-]{1,24}$/;

interface NumField {
  key: keyof Pick<LeadForm, 'thresholdBps' | 'impulseWindowMs' | 'followRatio' | 'maxWaitMs' | 'cooldownMs'>;
  label: string;
  min: number;
  max: number;
  integer: boolean;
}

export const LEAD_NUM_FIELDS: readonly NumField[] = [
  { key: 'thresholdBps', label: '触发阈值（基点）', min: 0.5, max: 500, integer: false },
  { key: 'impulseWindowMs', label: '变化窗口（毫秒）', min: 100, max: 10_000, integer: true },
  { key: 'followRatio', label: '跟进判定比例', min: 0.2, max: 1.0, integer: false },
  { key: 'maxWaitMs', label: '最大等待时间（毫秒）', min: 1_000, max: 30_000, integer: true },
  { key: 'cooldownMs', label: '事件冷却时间（毫秒）', min: 500, max: 30_000, integer: true },
];

export function applyCandidate(form: LeadForm, candidate: LeadCandidateView): LeadForm {
  return {
    ...form,
    symbol: candidate.symbol,
    binance_perp: candidate.leads.binance_perp ?? '',
    binance_spot: candidate.leads.binance_spot ?? '',
    binance_equity: candidate.leads.binance_equity ?? '',
    hl_xyz: candidate.leads.hl_xyz ?? '',
    coinbase_spot: candidate.leads.coinbase_spot ?? '',
    okx_perp: candidate.leads.okx_perp ?? '',
    bybit_perp: candidate.leads.bybit_perp ?? '',
    lighter: candidate.targets.lighter ?? '',
    rh: candidate.targets.rh ?? '',
    entropy: candidate.targets.entropy ?? '',
  };
}

export function formFromConfig(config: LeadWatcherConfig): LeadForm {
  return {
    symbol: config.symbol,
    binance_perp: config.leads.binance_perp ?? '',
    binance_spot: config.leads.binance_spot ?? '',
    binance_equity: config.leads.binance_equity ?? '',
    hl_xyz: config.leads.hl_xyz ?? '',
    coinbase_spot: config.leads.coinbase_spot ?? '',
    okx_perp: config.leads.okx_perp ?? '',
    bybit_perp: config.leads.bybit_perp ?? '',
    lighter: config.targets.lighter ?? '',
    rh: config.targets.rh ?? '',
    entropy: config.targets.entropy ?? '',
    thresholdBps: String(config.thresholdBps),
    impulseWindowMs: String(config.impulseWindowMs),
    followRatio: String(config.followRatio),
    maxWaitMs: String(config.maxWaitMs),
    cooldownMs: String(config.cooldownMs),
  };
}

/** 校验并生成 `POST /api/varlighter/lead/watchers/add` 请求体，规则与服务端 `readLeadWatcherConfig` 一致。 */
export function leadWatcherRequest(form: LeadForm): Parsed<LeadWatcherConfig> {
  const symbol = form.symbol.trim().toUpperCase();
  if (!WATCHER_SYMBOL_RE.test(symbol)) {
    return { ok: false, error: '基础标的代码无效（应为 1–24 位大写字母或数字，如 NVDA、BTC）' };
  }

  const leads: Partial<Record<LeadRefSource, string>> = {};
  for (const src of LEAD_REF_SOURCES) {
    const raw = form[src].trim();
    if (!raw) continue;
    if (!LEAD_REF_SYMBOL_RE.test(raw)) return { ok: false, error: `${LEAD_REF_LABELS[src]} 代码格式无效` };
    leads[src] = src === 'hl_xyz' ? raw : raw.toUpperCase();
  }
  if (!Object.keys(leads).length) {
    return { ok: false, error: '至少选择一个参考领先源并填写标的代码' };
  }

  const targets: Partial<Record<LeadVenue, string>> = {};
  for (const venue of LEAD_VENUES) {
    const raw = form[venue].trim();
    if (!raw) continue;
    if (!LEG_SYMBOL_RE.test(raw)) return { ok: false, error: `${LEAD_VENUE_LABELS[venue]} 代码无效` };
    targets[venue] = raw;
  }
  if (!Object.keys(targets).length) {
    return { ok: false, error: '至少选择一个目标 DEX 场所并填写标的代码' };
  }

  const nums = {} as Record<NumField['key'], number>;
  for (const field of LEAD_NUM_FIELDS) {
    const text = form[field.key].trim();
    const val = Number(text);
    if (!text || !Number.isFinite(val)) return { ok: false, error: `${field.label}须填数字` };
    if (field.integer && !Number.isInteger(val)) return { ok: false, error: `${field.label}须为整数` };
    if (val < field.min || val > field.max) return { ok: false, error: `${field.label}须在 ${field.min} 到 ${field.max} 之间` };
    nums[field.key] = val;
  }

  return {
    ok: true,
    value: {
      symbol,
      leads,
      targets,
      ...nums,
    },
  };
}

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/** 延迟可读文本：正值表示参考领先源快于目标，负值表示目标更早动。 */
export function formatLagMs(ms: number | null | undefined): string {
  if (!finite(ms)) return '—';
  const sign = ms > 0 ? '+' : ms < 0 ? '−' : '';
  const abs = Math.abs(ms);
  return abs >= 1000 ? `${sign}${(abs / 1000).toFixed(2)} s` : `${sign}${Math.round(abs)} ms`;
}

export function lagTone(ms: number | null | undefined): 'up' | 'down' | '' {
  if (!finite(ms) || ms === 0) return '';
  return ms > 0 ? 'up' : 'down';
}

export function lagVerdict(venue: Pick<LeadVenueStatsView, 'name' | 'medianMs' | 'followed' | 'xcorr'>, leadName = '参考源'): string {
  if (venue.followed > 0 && finite(venue.medianMs)) {
    if (venue.medianMs > 20) return `${leadName}领先约 ${formatLagMs(venue.medianMs)}`;
    if (venue.medianMs < -20) return `${venue.name}反超约 ${formatLagMs(Math.abs(venue.medianMs))}`;
    return '两边基本同步（±20 ms）';
  }
  if (venue.xcorr) {
    if (venue.xcorr.peakLagMs > 0) return `互相关显示${leadName}领先 ${venue.xcorr.peakLagMs} ms`;
    if (venue.xcorr.peakLagMs < 0) return `互相关显示${venue.name}领先 ${Math.abs(venue.xcorr.peakLagMs)} ms`;
    return '互相关峰值在 0 ms（同步）';
  }
  return '等待足够波动样本';
}

export const FOLLOW_STATUS_LABELS: Record<LeadFollowStatus, string> = {
  followed: '已跟进',
  unfollowed: '未跟进',
  pending: '等待中',
  disconnected: '中途断线',
  no_data: '缺基准价',
  cancelled: '停止结算',
};

export function formatEventVenue(entry: LeadEventVenueView | undefined): { text: string; tone: 'ok' | 'warn' | 'bad' | 'info' | '' } {
  if (!entry) return { text: '—', tone: '' };
  if (entry.status === 'followed') {
    const lag = entry.lagMs ?? 0;
    return { text: formatLagMs(lag), tone: lag > 0 ? 'ok' : lag < 0 ? 'warn' : 'info' };
  }
  if (entry.status === 'pending') return { text: '等待中…', tone: 'info' };
  if (entry.status === 'unfollowed') return { text: '未跟进', tone: 'bad' };
  return { text: FOLLOW_STATUS_LABELS[entry.status], tone: 'warn' };
}

export function formatDbBytes(bytes: number | null): string {
  if (!finite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function catalogSummaryText(catalog: LeadCatalogStatusView): string {
  const loaded = LEAD_REF_SOURCES.filter(s => s !== 'binance_equity' && catalog.sources[s].ok !== null);
  const failed = LEAD_REF_SOURCES.filter(s => s !== 'binance_equity' && catalog.sources[s].error !== null);
  if (catalog.loading) return '正在拉取多参考源公开目录…';
  return `已连目录 ${loaded.length}/6${failed.length ? ` · 异常 ${failed.length}` : ''}`;
}

export interface BucketChartRow {
  time: number;
  lighter: number | null;
  rh: number | null;
  entropy: number | null;
  events: number;
}

export function buildBucketRows(view: Pick<LeadAnalyzeView, 'buckets'>): BucketChartRow[] {
  return view.buckets.map(b => ({
    time: b.at,
    lighter: b.venues.lighter?.medianMs ?? null,
    rh: b.venues.rh?.medianMs ?? null,
    entropy: b.venues.entropy?.medianMs ?? null,
    events: b.events,
  }));
}

export interface XcorrChartRow {
  time: number;
  lighter: number | null;
  rh: number | null;
  entropy: number | null;
}

export function buildAnalyzeXcorrRows(view: Pick<LeadAnalyzeView, 'venues'>): XcorrChartRow[] {
  const byLag = new Map<number, XcorrChartRow>();
  for (const venue of view.venues) {
    if (!venue.xcorr) continue;
    for (const pt of venue.xcorr.points) {
      let row = byLag.get(pt.lagMs);
      if (!row) {
        row = { time: pt.lagMs, lighter: null, rh: null, entropy: null };
        byLag.set(pt.lagMs, row);
      }
      row[venue.venue] = pt.corr;
    }
  }
  return [...byLag.values()].sort((a, b) => a.time - b.time);
}

export interface AnalyzeSeriesChartRow {
  time: number;
  binance_perp: number | null;
  binance_spot: number | null;
  binance_equity: number | null;
  hl_xyz: number | null;
  coinbase_spot: number | null;
  okx_perp: number | null;
  bybit_perp: number | null;
  lighter: number | null;
  rh: number | null;
  entropy: number | null;
}

export function buildAnalyzeSeriesRows(view: Pick<LeadAnalyzeView, 'series'>): AnalyzeSeriesChartRow[] {
  return view.series.map(pt => ({
    time: pt.t,
    binance_perp: pt.values.binance_perp ?? null,
    binance_spot: pt.values.binance_spot ?? null,
    binance_equity: pt.values.binance_equity ?? null,
    hl_xyz: pt.values.hl_xyz ?? null,
    coinbase_spot: pt.values.coinbase_spot ?? null,
    okx_perp: pt.values.okx_perp ?? null,
    bybit_perp: pt.values.bybit_perp ?? null,
    lighter: pt.values.lighter ?? null,
    rh: pt.values.rh ?? null,
    entropy: pt.values.entropy ?? null,
  }));
}
