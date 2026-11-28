// DEX 价差「Binance 领先测速」页签的不依赖 DOM 部分：表单校验、候选填充、延迟格式化与图表行数据。
import type {
  LeadCandidateView,
  LeadConfig,
  LeadEventVenueView,
  LeadFollowStatus,
  LeadSessionView,
  LeadVenue,
  LeadVenueStatsView,
} from '../../../src/varlighter/views.ts';
import type { Parsed } from './varlighter-form.ts';

export const LEAD_VENUES: readonly LeadVenue[] = ['lighter', 'rh', 'entropy'];
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

export interface LeadForm {
  binanceSymbol: string;
  lighter: string;
  rh: string;
  entropy: string;
  durationSec: string;
  thresholdBps: string;
  impulseWindowMs: string;
  followRatio: string;
  maxWaitMs: string;
  cooldownMs: string;
}

export const DEFAULT_LEAD_FORM: LeadForm = {
  binanceSymbol: '',
  lighter: '',
  rh: '',
  entropy: '',
  durationSec: '180',
  thresholdBps: '3',
  impulseWindowMs: '1000',
  followRatio: '0.5',
  maxWaitMs: '10000',
  cooldownMs: '2000',
};

const BINANCE_SYMBOL_RE = /^[A-Z0-9]{2,32}$/;
const LEG_SYMBOL_RE = /^[A-Za-z0-9._-]{1,24}$/;

interface NumField {
  key: keyof Pick<LeadForm, 'durationSec' | 'thresholdBps' | 'impulseWindowMs' | 'followRatio' | 'maxWaitMs' | 'cooldownMs'>;
  label: string;
  min: number;
  max: number;
  integer: boolean;
}

export const LEAD_NUM_FIELDS: readonly NumField[] = [
  { key: 'durationSec', label: '测试时长（秒）', min: 30, max: 1800, integer: true },
  { key: 'thresholdBps', label: '触发阈值（基点）', min: 0.5, max: 500, integer: false },
  { key: 'impulseWindowMs', label: '变化窗口（毫秒）', min: 100, max: 10_000, integer: true },
  { key: 'followRatio', label: '跟进判定比例', min: 0.2, max: 1.0, integer: false },
  { key: 'maxWaitMs', label: '最大等待时间（毫秒）', min: 1_000, max: 30_000, integer: true },
  { key: 'cooldownMs', label: '事件冷却时间（毫秒）', min: 500, max: 30_000, integer: true },
];

export function applyCandidate(form: LeadForm, candidate: LeadCandidateView): LeadForm {
  return {
    ...form,
    binanceSymbol: candidate.symbol,
    lighter: candidate.targets.lighter ?? '',
    rh: candidate.targets.rh ?? '',
    entropy: candidate.targets.entropy ?? '',
  };
}

export function formFromConfig(config: LeadConfig): LeadForm {
  return {
    binanceSymbol: config.binanceSymbol,
    lighter: config.targets.lighter ?? '',
    rh: config.targets.rh ?? '',
    entropy: config.targets.entropy ?? '',
    durationSec: String(config.durationSec),
    thresholdBps: String(config.thresholdBps),
    impulseWindowMs: String(config.impulseWindowMs),
    followRatio: String(config.followRatio),
    maxWaitMs: String(config.maxWaitMs),
    cooldownMs: String(config.cooldownMs),
  };
}

/** 校验并生成 `POST /api/varlighter/lead/start` 请求体，规则与服务端 `readLeadConfig` 一致。 */
export function leadStartRequest(form: LeadForm): Parsed<LeadConfig> {
  const binanceSymbol = form.binanceSymbol.trim().toUpperCase();
  if (!BINANCE_SYMBOL_RE.test(binanceSymbol)) {
    return { ok: false, error: 'Binance 合约代码无效（应为 2–32 位大写字母或数字，如 BTCUSDT）' };
  }
  const targets: Partial<Record<LeadVenue, string>> = {};
  for (const venue of LEAD_VENUES) {
    const raw = form[venue].trim();
    if (!raw) continue;
    if (!LEG_SYMBOL_RE.test(raw)) return { ok: false, error: `${LEAD_VENUE_LABELS[venue]} 代码无效` };
    targets[venue] = raw;
  }
  if (!Object.keys(targets).length) {
    return { ok: false, error: '至少选择一个需要对比的 DEX 场所并填写标的代码' };
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
      binanceSymbol,
      targets,
      ...nums,
    },
  };
}

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/** 延迟可读文本：正值表示 Binance 领先，负值表示目标场所领先。 */
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

export function lagVerdict(venue: Pick<LeadVenueStatsView, 'name' | 'medianMs' | 'followed' | 'xcorr'>): string {
  if (venue.followed > 0 && finite(venue.medianMs)) {
    if (venue.medianMs > 20) return `Binance 领先约 ${formatLagMs(venue.medianMs)}`;
    if (venue.medianMs < -20) return `${venue.name} 反超约 ${formatLagMs(Math.abs(venue.medianMs))}`;
    return '两边基本同步（±20 ms）';
  }
  if (venue.xcorr) {
    if (venue.xcorr.peakLagMs > 0) return `互相关显示 Binance 领先 ${venue.xcorr.peakLagMs} ms`;
    if (venue.xcorr.peakLagMs < 0) return `互相关显示 ${venue.name} 领先 ${Math.abs(venue.xcorr.peakLagMs)} ms`;
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
  cancelled: '测试结束',
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

export interface XcorrChartRow {
  time: number;
  lighter: number | null;
  rh: number | null;
  entropy: number | null;
}

export function buildXcorrRows(session: LeadSessionView): XcorrChartRow[] {
  const byLag = new Map<number, XcorrChartRow>();
  for (const venue of session.venues) {
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

export interface LeadSeriesChartRow {
  time: number;
  binance: number | null;
  lighter: number | null;
  rh: number | null;
  entropy: number | null;
}

export function buildSeriesRows(session: LeadSessionView): LeadSeriesChartRow[] {
  return session.series.map(pt => ({
    time: pt.t,
    binance: pt.binance,
    lighter: pt.lighter,
    rh: pt.rh,
    entropy: pt.entropy,
  }));
}
