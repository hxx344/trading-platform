// The alert tiers of the oil and Hynix monitors (M-3a): the page's description of each market (the workbench's oilAlerts /
// hynixAlerts adapters in modules/monitor/lib/monitor-alerts.ts, ef09438, with the service's field names) and the boundary
// check of GET /api/monitor/<market>/alerts. Limits must match src/monitor/alerts.ts ALERT_SPECS; the service checks again.

export type AlertMarket = 'oil' | 'hynix';
export type AlertOperator = 'gte' | 'lte' | 'both';
export interface AlertRule { id: string; label: string; metric: string; operator: AlertOperator; threshold: number; cooldownMinutes: number; hysteresis: number; enabled: boolean }
export interface AlertConfig { enabled: boolean; rules: AlertRule[] }
export type AlertStatus = 'sent' | 'failed' | 'queued' | 'retrying' | 'expired' | 'unqueued' | 'unknown';
export interface AlertHistoryItem { id: string; time: string; kind: 'alert' | 'test'; status: AlertStatus; rules: { label: string; metric: string; operator: 'gte' | 'lte'; threshold: number; value: number }[]; error: string }
export interface AlertView {
  market: AlertMarket; revision: number; config: AlertConfig; robotConfigured: boolean; checkedAt: string | null; lastValidAt: string | null;
  values: Record<string, number> | null; error: string | null; notice: string | null; history: AlertHistoryItem[];
}

export interface AlertMetric { id: string; label: string; unit: string; hysteresisUnit: string; min: number; max: number }
export interface AlertMarketSpec {
  title: string; metrics: readonly AlertMetric[]; maxRules: number; labelMax: number; cooldownMax: number; hysteresisMax: number; example: string;
  /** Initial range for the tier generator when the draft has no evenly spaced tiers to reuse. */
  grid: { from: number; to: number; step: number };
  /** A new tier's cooldown and hysteresis. */
  defaults: { cooldownMinutes: number; hysteresis: number };
  /** The quote the service last judged, one line. */
  market(values: Record<string, number> | null): string;
}

export const ALERT_MARKETS: Record<AlertMarket, AlertMarketSpec> = {
  oil: {
    title: '原油',
    metrics: [
      { id: 'spread', label: '价差 · 布伦特 − WTI', unit: 'USDT/桶', hysteresisUnit: 'USDT/桶', min: -1e6, max: 1e6 },
      { id: 'brent', label: '布伦特价格', unit: 'USDT/桶', hysteresisUnit: 'USDT/桶', min: 0, max: 1e6 },
      { id: 'wti', label: 'WTI 价格', unit: 'USDT/桶', hysteresisUnit: 'USDT/桶', min: 0, max: 1e6 },
    ],
    maxRules: 50, labelMax: 60, cooldownMax: 10_080, hysteresisMax: 1e6, grid: { from: 3, to: 5, step: 0.5 }, defaults: { cooldownMinutes: 30, hysteresis: 0.1 },
    example: '价差＝布伦特 − WTI，单位 USDT/桶。阈值 4、回差 0.1：触发后需回落到 3.9 以下，再次达到 4 且冷却结束才提醒。',
    market: values => values ? `服务器最近报价 · 布伦特 ${values.brent?.toFixed(4)} · WTI ${values.wti?.toFixed(4)} · 价差 ${values.spread?.toFixed(4)} USDT/桶` : '服务器尚未取得有效行情。',
  },
  hynix: {
    title: '海力士',
    metrics: [{ id: 'premium', label: 'ADR 溢价率', unit: '%', hysteresisUnit: '百分点', min: -100, max: 10_000 }],
    maxRules: 20, labelMax: 40, cooldownMax: 1_440, hysteresisMax: 100, grid: { from: 30, to: 50, step: 5 }, defaults: { cooldownMinutes: 5, hysteresis: 0.5 },
    example: '例如向上阈值为 40%、回差为 0.5 个百分点：触发后需回落到 39.5% 以下，再次达到 40% 且冷却结束，才会再次提醒。',
    market: values => values ? `服务器最近溢价率 · ${values.premium?.toFixed(2)}%` : '服务器尚未取得有效行情。',
  },
};

export const newRuleId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
export const newRule = (market: AlertMarket, config: AlertConfig): AlertRule => {
  const spec = ALERT_MARKETS[market];
  return { id: newRuleId(), label: `档位 ${config.rules.length + 1}`, metric: spec.metrics[0]!.id, operator: 'gte', threshold: Number.NaN, ...spec.defaults, enabled: true };
};

const STATUSES: readonly AlertStatus[] = ['sent', 'failed', 'queued', 'retrying', 'expired', 'unqueued', 'unknown'];
const bad = (): never => { throw new Error('告警状态格式无法识别，稍后自动重试'); };
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : bad();
const finite = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : bad();
const text = (value: unknown): string => typeof value === 'string' ? value : bad();
const nullableText = (value: unknown): string | null => value === null ? null : text(value);

function rule(raw: unknown): AlertRule {
  const item = object(raw);
  const operator = item.operator === 'gte' || item.operator === 'lte' || item.operator === 'both' ? item.operator : bad();
  if (typeof item.enabled !== 'boolean') bad();
  return { id: text(item.id), label: text(item.label), metric: text(item.metric), operator, threshold: finite(item.threshold), cooldownMinutes: finite(item.cooldownMinutes), hysteresis: finite(item.hysteresis), enabled: item.enabled as boolean };
}

/** GET /api/monitor/<market>/alerts, checked; a shape it does not know fails the read and keeps the last view. */
export function alertView(raw: unknown): AlertView {
  const view = object(raw), config = object(view.config);
  const market = view.market === 'oil' || view.market === 'hynix' ? view.market : bad();
  if (!Number.isSafeInteger(view.revision) || typeof config.enabled !== 'boolean' || !Array.isArray(config.rules) || typeof view.robotConfigured !== 'boolean' || !Array.isArray(view.history)) bad();
  const values = view.values === null ? null : Object.fromEntries(Object.entries(object(view.values)).map(([key, value]) => [key, finite(value)]));
  return {
    market, revision: view.revision as number, config: { enabled: config.enabled as boolean, rules: (config.rules as unknown[]).map(rule) }, robotConfigured: view.robotConfigured as boolean,
    checkedAt: nullableText(view.checkedAt), lastValidAt: nullableText(view.lastValidAt), values, error: nullableText(view.error), notice: nullableText(view.notice),
    history: (view.history as unknown[]).map(raw => {
      const item = object(raw);
      const status = STATUSES.includes(item.status as AlertStatus) ? item.status as AlertStatus : bad();
      const kind = item.kind === 'alert' || item.kind === 'test' ? item.kind : bad();
      const rules = Array.isArray(item.rules) ? item.rules.map(raw => { const r = object(raw); return { label: text(r.label), metric: text(r.metric), operator: r.operator === 'lte' || r.operator === 'gte' ? r.operator as 'gte' | 'lte' : bad(), threshold: finite(r.threshold), value: finite(r.value) }; }) : bad();
      return { id: text(item.id), time: text(item.time), kind, status, rules, error: typeof item.error === 'string' ? item.error : '' };
    }),
  };
}

/** alertView for one market's endpoint: an answer for the other market is refused. */
export const alertViewFor = (market: AlertMarket) => (raw: unknown): AlertView => {
  const view = alertView(raw);
  return view.market === market ? view : bad();
};

export const STATUS_LABELS: Record<AlertStatus, string> = { sent: '已发送', failed: '发送失败', queued: '排队待发', retrying: '发送失败，自动重试中', expired: '已超出队列保留期（7 天）', unqueued: '未进入队列', unknown: '发送状态读取失败' };

/** One history line: the tiers reached with the values judged. */
export function historyText(market: AlertMarket, item: AlertHistoryItem): string {
  if (item.kind === 'test') return '测试消息';
  const metrics = ALERT_MARKETS[market].metrics;
  return item.rules.map(r => {
    const metric = metrics.find(m => m.id === r.metric);
    const unit = metric?.unit === '%' ? '%' : ` ${metric?.unit ?? ''}`;
    return `${r.label}：${r.value.toFixed(market === 'oil' ? 4 : 2)} ${r.operator === 'gte' ? '≥' : '≤'} ${r.threshold}${unit}`;
  }).join('；');
}
