// Monitor M-3a: threshold alerts for the oil spread and the Hynix ADR premium. Every 10 s the latest live quote of the market's
// collector is checked against the tiers; a tier that is reached is queued in the service's Feishu outbox (notify.sqlite), which
// then delivers it with its own retries. The rules are the workbench's oil rules (server/oil/config.mjs at 31242e0), shared by
// both markets: one alert per crossing, a hysteresis band before the next one, a cooldown across crossings, and two-way tiers
// that report crossings only. Config, crossing states and the recent history sit in monitor.sqlite's key-value table.
import { randomUUID } from 'node:crypto';
import { ContractError } from '../contracts.ts';
import { oilSpread } from '../vendor/oil-market.mjs';
import type { MonitorStore } from './store.ts';

export type AlertMarket = 'oil' | 'hynix';
export type AlertOperator = 'gte' | 'lte' | 'both';
export interface AlertRule { id: string; label: string; metric: string; operator: AlertOperator; threshold: number; cooldownMinutes: number; hysteresis: number; enabled: boolean }
export interface AlertConfig { enabled: boolean; rules: AlertRule[] }
interface Side { active: boolean; alerted: boolean }
export interface RuleState { active: boolean; alerted: boolean; lastSentAt: number | null; sides?: { gte: Side; lte: Side } }
export interface AlertEventRule { label: string; metric: string; operator: 'gte' | 'lte'; threshold: number; value: number }
export interface AlertEvent {
  id: string; time: string; kind: 'alert' | 'test';
  /** alert: the tiers sent and the outbox message (null: no robot at the time, only logged). */
  rules?: AlertEventRule[]; outboxId?: number | null;
  /** test: sent directly, so its result is known at once. */
  status?: 'sent' | 'failed'; error?: string;
}
interface Saved { version: 1; revision: number; config: AlertConfig; states: Record<string, RuleState>; events: AlertEvent[] }

export const ALERT_CHECK_MS = 10_000;
/** A failed queue write is retried after this long (the workbench retried a failed send after 60 s). */
export const QUEUE_RETRY_MS = 60_000;
/** One test message per minute for the service: both markets share one robot. */
export const TEST_INTERVAL_MS = 60_000;
const EVENTS_KEPT = 100;
const FUTURE_MS = 5_000;
const OPERATORS: readonly AlertOperator[] = ['gte', 'lte', 'both'];
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);

interface MetricSpec { label: string; unit: string; min: number; max: number; positive?: true }
interface MarketSpec {
  title: string; metrics: Record<string, MetricSpec>; maxRules: number; labelMax: number; cooldownMax: number; hysteresisMax: number;
  /** A quote older than this (by its own time) is not judged: the workbench's 90 s for oil, 30 s for Hynix. */
  maxAgeMs: number;
  defaults(): AlertConfig;
}
export const ALERT_SPECS: Record<AlertMarket, MarketSpec> = {
  oil: {
    title: '原油', maxRules: 50, labelMax: 60, cooldownMax: 10_080, hysteresisMax: 1e6, maxAgeMs: 90_000,
    metrics: {
      spread: { label: '价差', unit: 'USDT/桶', min: -1e6, max: 1e6 },
      brent: { label: '布伦特', unit: 'USDT/桶', min: 0, max: 1e6, positive: true },
      wti: { label: 'WTI', unit: 'USDT/桶', min: 0, max: 1e6, positive: true },
    },
    defaults: () => ({ enabled: false, rules: [3, 4, 5].map((threshold, index) => ({ id: `spread-${index + 1}`, label: `价差 ${threshold} USDT`, metric: 'spread', operator: 'gte' as const, threshold, cooldownMinutes: 30, hysteresis: 0.1, enabled: true })) }),
  },
  hynix: {
    title: '海力士', maxRules: 20, labelMax: 40, cooldownMax: 1_440, hysteresisMax: 100, maxAgeMs: 30_000,
    metrics: { premium: { label: 'ADR 溢价率', unit: '%', min: -100, max: 10_000 } },
    defaults: () => ({ enabled: false, rules: [] }),
  },
};

const invalid = (message: string): never => { throw new ContractError(400, 'invalid_alerts', message); };
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** The tiers as the page sent them, checked as the workbench did; throws 400 with the reason. */
export function validateAlertConfig(market: AlertMarket, input: unknown): AlertConfig {
  const spec = ALERT_SPECS[market];
  const raw = input as { enabled?: unknown; rules?: unknown } | null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.enabled !== 'boolean' || !Array.isArray(raw.rules)) return invalid('配置需包含总开关与档位列表');
  if (Object.keys(raw).some(key => key !== 'enabled' && key !== 'rules')) return invalid('配置含有未知字段');
  if (raw.rules.length > spec.maxRules) return invalid(`最多允许 ${spec.maxRules} 档`);
  const ids = new Set<string>(), conditions = new Set<string>();
  const rules = raw.rules.map((item: unknown): AlertRule => {
    const rule = item as Record<string, unknown> | null;
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return invalid('档位格式不正确');
    if (Object.keys(rule).some(key => !['id', 'label', 'metric', 'operator', 'threshold', 'cooldownMinutes', 'hysteresis', 'enabled'].includes(key))) return invalid('档位含有未知字段');
    if (typeof rule.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(rule.id) || RESERVED.has(rule.id) || ids.has(rule.id)) return invalid('档位编号无效或重复');
    ids.add(rule.id);
    if (typeof rule.label !== 'string' || !rule.label.trim() || rule.label.length > spec.labelMax || /[\x00-\x1f\x7f]/.test(rule.label)) return invalid(`档位名称需要 1–${spec.labelMax} 个字符，不含换行`);
    if (typeof rule.metric !== 'string' || !Object.hasOwn(spec.metrics, rule.metric) || !OPERATORS.includes(rule.operator as AlertOperator) || typeof rule.enabled !== 'boolean') return invalid('监控指标、方向或开关无效');
    if (!finite(rule.threshold) || !finite(rule.cooldownMinutes) || !finite(rule.hysteresis)) return invalid('阈值、冷却时间和回差必须是有效数字');
    const metric = spec.metrics[rule.metric]!;
    if (rule.threshold < metric.min || rule.threshold > metric.max || (metric.positive && rule.threshold <= 0)) return invalid(`${metric.label}阈值须在 ${metric.min} 至 ${metric.max} 之间${metric.positive ? '且大于 0' : ''}`);
    if (rule.cooldownMinutes < 0 || rule.cooldownMinutes > spec.cooldownMax) return invalid(`冷却时间需在 0–${spec.cooldownMax} 分钟内`);
    if (rule.hysteresis < 0 || rule.hysteresis > spec.hysteresisMax) return invalid(`回差需在 0–${spec.hysteresisMax} 之间`);
    const condition = JSON.stringify([rule.metric, rule.operator, rule.threshold]);
    if (conditions.has(condition)) return invalid('相同指标、方向和阈值的档位不能重复');
    conditions.add(condition);
    return { id: rule.id, label: rule.label.trim(), metric: rule.metric, operator: rule.operator as AlertOperator, threshold: rule.threshold, cooldownMinutes: rule.cooldownMinutes, hysteresis: rule.hysteresis, enabled: rule.enabled };
  });
  return { enabled: raw.enabled, rules };
}

/** A tier keeps its crossing state across a save only when none of these changed (the workbench's ruleFingerprint). */
const fingerprint = (rule: AlertRule): string => JSON.stringify([rule.metric, rule.operator, rule.threshold, rule.hysteresis, rule.enabled]);

const compare = (left: number, right: number): number => Math.abs(left - right) <= Number.EPSILON * 8 * Math.max(1, Math.abs(left), Math.abs(right)) ? 0 : Math.sign(left - right);
const matches = (operator: 'gte' | 'lte', value: number, rule: AlertRule): boolean => operator === 'gte' ? compare(value, rule.threshold) >= 0 : compare(value, rule.threshold) <= 0;
const resets = (operator: 'gte' | 'lte', value: number, rule: AlertRule): boolean => operator === 'gte' ? compare(value, rule.threshold - rule.hysteresis) < 0 : compare(value, rule.threshold + rule.hysteresis) > 0;

/**
 * One tier against one value (the workbench's evaluateRule without its retry clock: the outbox retries). `operator` is the side
 * that would be reported. Returns a new state; the caller marks it alerted once the message is queued.
 */
export function evaluateRule(rule: AlertRule, previous: RuleState | undefined, value: number, now: number): { state: RuleState; operator: 'gte' | 'lte' | null; due: boolean } {
  const cooled = (state: RuleState) => state.lastSentAt === null || now - state.lastSentAt >= rule.cooldownMinutes * 60_000;
  if (rule.operator === 'both') {
    // Each side starts as an already-reported crossing: saving a tier never reports the side the market is on.
    const side = (saved: Side | undefined): Side => ({ active: true, alerted: true, ...saved });
    const state: RuleState = { active: false, alerted: false, lastSentAt: previous?.lastSentAt ?? null, sides: { gte: side(previous?.sides?.gte), lte: side(previous?.sides?.lte) } };
    let operator: 'gte' | 'lte' | null = null;
    for (const name of ['gte', 'lte'] as const) {
      const current = state.sides![name], matched = matches(name, value, rule);
      if (current.active && resets(name, value, rule)) { current.active = false; current.alerted = false; }
      if (!current.active && matched) { current.active = true; current.alerted = false; }
      if (operator === null && matched && current.active && !current.alerted) operator = name;
    }
    state.active = operator !== null;
    return { state, operator, due: rule.enabled && operator !== null && cooled(state) };
  }
  const state: RuleState = { active: previous?.active ?? false, alerted: previous?.alerted ?? false, lastSentAt: previous?.lastSentAt ?? null };
  const matched = matches(rule.operator, value, rule);
  if (state.active && resets(rule.operator, value, rule)) { state.active = false; state.alerted = false; }
  if (!state.active && matched) { state.active = true; state.alerted = false; }
  return { state, operator: rule.operator, due: rule.enabled && matched && state.active && !state.alerted && cooled(state) };
}

/** Marks the reported side (or the one-way tier) as alerted at `at`. */
function markAlerted(state: RuleState, operator: 'gte' | 'lte', at: number): void {
  if (state.sides) state.sides[operator].alerted = true; else state.alerted = true;
  state.lastSentAt = at;
}

interface OilLike { status?: unknown; fetchedAt?: unknown; brent?: { markPx?: unknown }; wti?: { markPx?: unknown } }
interface HynixLike { status?: unknown; fetchedAt?: unknown; adr?: unknown; ordinary?: unknown; equivalent?: unknown; spread?: unknown; premium?: unknown }
export type AlertValues = Record<string, number>;

/** The judged values of a live quote, or the reason it cannot be judged. */
export function quoteValues(market: AlertMarket, quote: unknown, now: number): { values: AlertValues; fetchedAt: string; quote: Record<string, number> } | { reason: string } {
  if (!quote) return { reason: '尚未取得实时报价，暂停阈值判断' };
  const raw = quote as OilLike & HynixLike;
  const at = typeof raw.fetchedAt === 'string' ? Date.parse(raw.fetchedAt) : NaN;
  if (raw.status !== 'live' || !Number.isFinite(at) || now - at > ALERT_SPECS[market].maxAgeMs || at - now > FUTURE_MS) return { reason: '实时报价已过期，暂停阈值判断，下一轮自动重试' };
  if (market === 'oil') {
    const brent = raw.brent?.markPx, wti = raw.wti?.markPx, spread = oilSpread(brent, wti);
    if (!finite(brent) || !finite(wti) || spread === null) return { reason: '行情价格无效，暂停阈值判断' };
    return { values: { spread, brent, wti }, fetchedAt: raw.fetchedAt as string, quote: { brent, wti, spread } };
  }
  const { adr, equivalent, spread, premium } = raw;
  if (![adr, equivalent, spread, premium].every(finite) || (adr as number) <= 0 || (equivalent as number) <= 0) return { reason: '行情价格无效，暂停阈值判断' };
  return { values: { premium: premium as number }, fetchedAt: raw.fetchedAt as string, quote: { adr: adr as number, equivalent: equivalent as number, spread: spread as number, premium: premium as number } };
}

const fixed = (value: number, digits: number): string => value.toFixed(digits);
const sign = (operator: 'gte' | 'lte'): string => operator === 'gte' ? '≥' : '≤';
/** The outbox keeps 1500 characters of a message (feishu.ts MAX_TEXT); the tiers line leaves room for the quote line. */
export const ALERT_TEXT_MAX = 1_500;
/** The first line within the limit (minus `reserve`: the quote line and its line break): tiers that do not fit are counted as 另有 N 档. */
function fit(title: string, tiers: readonly string[], reserve: number): string {
  const budget = ALERT_TEXT_MAX - reserve;
  let line = title, shown = 0;
  for (const tier of tiers) {
    const next = `${line}${shown ? '；' : ''}${tier}`, rest = tiers.length - shown - 1;
    if (next.length + (rest ? `；另有 ${rest} 档`.length : 0) > budget) break;
    line = next; shown++;
  }
  return shown === tiers.length ? line : `${line}${shown ? '；' : ''}另有 ${tiers.length - shown} 档`;
}
/** Two lines: the tiers reached, then the quote they were judged on. */
export function alertMessage(market: AlertMarket, due: readonly { rule: AlertRule; operator: 'gte' | 'lte'; value: number }[], quote: Record<string, number>, fetchedAt: string): string {
  const spec = ALERT_SPECS[market];
  const crossing = (rule: AlertRule, operator: 'gte' | 'lte') => rule.operator === 'both' ? (operator === 'gte' ? '（向上穿越）' : '（向下穿越）') : '';
  if (market === 'oil') {
    const line = `布伦特 ${fixed(quote.brent!, 4)} · WTI ${fixed(quote.wti!, 4)} · 价差 ${fixed(quote.spread!, 4)} USDT/桶（Binance BZUSDT / CLUSDT 标记价，报价时刻 ${fetchedAt}）`;
    return `${fit('【原油阈值告警】', due.map(({ rule, operator, value }) => `${rule.label}${crossing(rule, operator)}：${spec.metrics[rule.metric]!.label} ${fixed(value, 4)} ${sign(operator)} ${rule.threshold} USDT/桶`), line.length + 1)}\n${line}`;
  }
  const line = `ADR $${fixed(quote.adr!, 2)} · 正股 ÷ 10 $${fixed(quote.equivalent!, 2)} · 每份价差 $${fixed(quote.spread!, 2)}（Hyperliquid xyz:SKHY / xyz:SKHX，获取时刻 ${fetchedAt}）`;
  return `${fit('【海力士价差告警】', due.map(({ rule, operator, value }) => `${rule.label}${crossing(rule, operator)}：ADR 溢价率 ${fixed(value, 2)}% ${sign(operator)} ${rule.threshold}%`), line.length + 1)}\n${line}`;
}

const validSide = (value: unknown): value is Side => !!value && typeof (value as Side).active === 'boolean' && typeof (value as Side).alerted === 'boolean';
/** The saved crossing states of the current tiers; a state that does not parse starts over. */
function restoreStates(config: AlertConfig, states: Record<string, unknown>): Record<string, RuleState> {
  const result: Record<string, RuleState> = {};
  for (const rule of config.rules) {
    const value = Object.hasOwn(states, rule.id) ? states[rule.id] as RuleState : undefined;
    if (!validSide(value) || !(value.lastSentAt === null || finite(value.lastSentAt))) continue;
    if (value.sides !== undefined && !(validSide(value.sides?.gte) && validSide(value.sides?.lte))) continue;
    result[rule.id] = { active: value.active, alerted: value.alerted, lastSentAt: value.lastSentAt, ...(value.sides ? { sides: { gte: { active: value.sides.gte.active, alerted: value.sides.gte.alerted }, lte: { active: value.sides.lte.active, alerted: value.sides.lte.alerted } } } : {}) };
  }
  return result;
}
const validEvent = (value: unknown): value is AlertEvent => {
  const event = value as AlertEvent | null;
  return !!event && typeof event.id === 'string' && typeof event.time === 'string' && (event.kind === 'test' || (event.kind === 'alert' && Array.isArray(event.rules) && (event.outboxId === null || Number.isSafeInteger(event.outboxId))));
};

export interface AlertDelivery { sentAt: number | null; attempts: number; lastError: string | null; nextAt: number }
export interface AlertHooks {
  /** Queues the text in the Feishu outbox; its id, or null without a robot. Throws when the outbox cannot be written. */
  notify(text: string): number | null;
  /** Delivery of queued messages by id; a missing id has left the outbox. */
  delivery(ids: readonly number[]): Map<number, AlertDelivery>;
  /** Whether a robot is configured. */
  robot(): boolean;
  /** Posts a test message directly (not queued); rejects with the robot's answer. */
  test(text: string): Promise<void>;
}

/** The test-message limit shared by both markets' services. */
export function createTestGate(now: () => number) {
  let last: number | null = null;
  return {
    take(): void {
      const at = now();
      if (last !== null && at - last < TEST_INTERVAL_MS) throw new ContractError(429, 'test_too_soon', `测试消息每分钟最多发送一次，请 ${Math.ceil((TEST_INTERVAL_MS - (at - last)) / 1000)} 秒后再试`);
      last = at;
    },
  };
}
export type TestGate = ReturnType<typeof createTestGate>;

const brief = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);

export function createAlertService({ market, store, quote, hooks, gate, now = Date.now, log = line => process.stderr.write(`${line}\n`) }: {
  market: AlertMarket; store: MonitorStore; quote: () => unknown; hooks: AlertHooks; gate: TestGate; now?: () => number; log?: (line: string) => void;
}) {
  const spec = ALERT_SPECS[market], key = `alerts.${market}`;
  // A saved value that no longer passes the checks is not used: the defaults start (with a revision past the old one), and the
  // old value stays in the file until the next write.
  let saved: Saved;
  let restoreError: string | null = null;
  let loaded: Partial<Saved> | null = null;
  try {
    loaded = (store.readState(key)?.value ?? null) as Partial<Saved> | null;
    if (loaded === null) throw null;
    if (typeof loaded !== 'object' || loaded.version !== 1 || !Number.isSafeInteger(loaded.revision) || loaded.revision! < 0 || !loaded.states || typeof loaded.states !== 'object' || Array.isArray(loaded.states) || !Array.isArray(loaded.events)) throw new Error('format');
    const config = validateAlertConfig(market, loaded.config);
    saved = { version: 1, revision: loaded.revision!, config, states: restoreStates(config, loaded.states), events: loaded.events.filter(validEvent).slice(0, EVENTS_KEPT) };
  } catch (error) {
    if (error !== null) { restoreError = `已保存的${spec.title}告警配置无法读取，已按默认配置启动；保存一次即覆盖`; log(`${spec.title}告警：${restoreError}`); }
    const revision = loaded && typeof loaded === 'object' && Number.isSafeInteger(loaded.revision) && loaded.revision! >= 0 ? loaded.revision! + 1 : 0;
    saved = { version: 1, revision, config: spec.defaults(), states: {}, events: [] };
  }
  let checkedAt: number | null = null, lastValidAt: string | null = null, lastValues: Record<string, number> | null = null;
  let quoteReason: string | null = null, queueError: string | null = null, queueRetryAt = 0;
  /** Set while monitor.sqlite refuses the write: new alerts pause, the states in memory go on. */
  let storageError: string | null = null;
  let lastLogged: string | null = null;
  const note = (reason: string | null) => { if (reason !== lastLogged) { if (reason) log(`${spec.title}告警：${reason}`); else if (lastLogged) log(`${spec.title}告警：已恢复`); lastLogged = reason; } };

  const persist = (): boolean => {
    try {
      store.writeState(key, saved);
      if (storageError) log(`${spec.title}告警：monitor.sqlite 已可写入，恢复提醒`);
      storageError = null;
      return true;
    } catch (error) {
      // Logged once per outage: check() retries every 10 s.
      if (!storageError) log(`${spec.title}告警：告警状态写入 monitor.sqlite 失败：${brief(error)}`);
      storageError = '告警状态写入 monitor.sqlite 失败，暂停新提醒；请检查磁盘与数据目录权限';
      return false;
    }
  };
  /** Background writes (check, test). While the saved value could not be read it is kept in the file until the page saves. */
  const write = (): void => { if (!restoreError) persist(); };
  const record = (event: AlertEvent) => { saved.events = [event, ...saved.events].slice(0, EVENTS_KEPT); };

  function check(): void {
    const at = now();
    checkedAt = at;
    // A failed write is retried first; until it succeeds nothing new is queued, so a lost state cannot repeat an alert.
    if (storageError && !persist()) return;
    const read = quoteValues(market, quote(), at);
    if ('reason' in read) { quoteReason = read.reason; note(read.reason); return; }
    quoteReason = null; lastValidAt = read.fetchedAt; lastValues = read.quote;
    const states: Record<string, RuleState> = {};
    const due: { rule: AlertRule; operator: 'gte' | 'lte'; value: number }[] = [];
    for (const rule of saved.config.rules) {
      const value = read.values[rule.metric];
      if (value === undefined) continue;
      const result = evaluateRule(rule, saved.states[rule.id], value, at);
      states[rule.id] = result.state;
      if (result.due && result.operator) due.push({ rule, operator: result.operator, value });
    }
    const changed = JSON.stringify(states) !== JSON.stringify(saved.states);
    saved.states = states;
    if (due.length && saved.config.enabled && hooks.robot() && at >= queueRetryAt) {
      let outboxId: number | null;
      try { outboxId = hooks.notify(alertMessage(market, due, read.quote, read.fetchedAt)); }
      catch (error) {
        queueError = '告警写入飞书队列失败，60 秒后重试';
        queueRetryAt = at + QUEUE_RETRY_MS;
        note(`${queueError}：${brief(error)}`);
        if (changed) write();
        return;
      }
      queueError = null; queueRetryAt = 0;
      for (const item of due) markAlerted(states[item.rule.id]!, item.operator, at);
      record({ id: randomUUID(), time: new Date(at).toISOString(), kind: 'alert', outboxId, rules: due.map(({ rule, operator, value }) => ({ label: rule.label, metric: rule.metric, operator, threshold: rule.threshold, value })) });
      write();
      note(null);
      return;
    }
    // Nothing left to send (the crossing ended or the alerts were switched off): a queue failure no longer applies.
    // Cleared without a log line: the outbox has not been shown to work again.
    if (queueError && (!due.length || !saved.config.enabled)) { queueError = null; queueRetryAt = 0; lastLogged = null; }
    if (!queueError) note(null);
    if (changed) write();
  }

  const robotNotice = () => hooks.robot() ? null : '尚未配置飞书机器人（secrets.json 的 feishu），档位可先保存，配置后才会发送';
  function view() {
    const ids = saved.events.flatMap(event => event.kind === 'alert' && typeof event.outboxId === 'number' ? [event.outboxId] : []);
    let delivery: Map<number, AlertDelivery> | null = null;
    try { delivery = hooks.delivery(ids); } catch { /* shown as unknown below */ }
    return {
      market, revision: saved.revision, config: saved.config, robotConfigured: hooks.robot(),
      checkedAt: checkedAt === null ? null : new Date(checkedAt).toISOString(), lastValidAt, values: lastValues,
      error: storageError ?? restoreError ?? queueError ?? quoteReason, notice: robotNotice(),
      history: saved.events.map(event => {
        if (event.kind === 'test') return { id: event.id, time: event.time, kind: 'test' as const, status: event.status ?? 'failed', rules: [], error: event.error ?? '' };
        const sent = typeof event.outboxId === 'number' ? delivery?.get(event.outboxId) : undefined;
        const status = event.outboxId === null ? 'unqueued' : !delivery ? 'unknown' : !sent ? 'expired' : sent.sentAt !== null ? 'sent' : sent.attempts > 0 ? 'retrying' : 'queued';
        return { id: event.id, time: event.time, kind: 'alert' as const, status, rules: event.rules ?? [], error: status === 'retrying' ? sent?.lastError ?? '' : '' };
      }),
    };
  }

  return {
    check,
    view,
    /** Replaces the tiers (POST /alerts); 409 on a stale revision, 503 when the write fails (nothing changes then). */
    update(body: unknown) {
      const raw = body as { revision?: unknown; config?: unknown } | null;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(name => name !== 'revision' && name !== 'config')) return invalid('请求须包含 revision 与 config');
      if (!Number.isSafeInteger(raw.revision) || raw.revision !== saved.revision) throw new ContractError(409, 'stale_revision', '告警配置已被其他页面修改，请重新载入后再保存');
      const config = validateAlertConfig(market, raw.config);
      const states: Record<string, RuleState> = {};
      for (const rule of config.rules) {
        const old = saved.config.rules.find(item => item.id === rule.id);
        if (old && fingerprint(old) === fingerprint(rule) && saved.states[rule.id]) states[rule.id] = saved.states[rule.id]!;
      }
      const previous = saved, previousError = storageError;
      saved = { ...saved, revision: saved.revision + 1, config, states };
      // A failed save keeps an earlier write failure from check(): new alerts stay paused until that state is written.
      if (!persist()) { saved = previous; storageError = previousError; throw new ContractError(503, 'alerts_unavailable', '告警配置保存失败（monitor.sqlite 写入失败），请检查磁盘与数据目录权限后重试'); }
      restoreError = null;
      return view();
    },
    /** Posts a test message straight to the robot (POST /alerts/test). */
    async test() {
      if (!hooks.robot()) throw new ContractError(400, 'robot_missing', '尚未配置飞书机器人：请在 secrets.json 填写 feishu 后重启服务');
      gate.take();
      const at = now(), time = new Date(at).toISOString();
      let failure: string | null = null;
      try { await hooks.test(`【行情监控】飞书连接测试：原油 / 海力士阈值告警使用此机器人。${time}`); }
      catch (error) { failure = brief(error); }
      record({ id: randomUUID(), time, kind: 'test', status: failure ? 'failed' : 'sent', ...(failure ? { error: failure } : {}) });
      write();
      if (failure) throw new ContractError(503, 'test_failed', `测试消息发送失败：${failure}`);
      return view();
    },
    /** For the status page. */
    status: () => ({ enabled: saved.config.enabled, rules: saved.config.rules.filter(rule => rule.enabled).length, checkedAt: checkedAt === null ? null : new Date(checkedAt).toISOString(), error: storageError ?? restoreError ?? queueError ?? quoteReason }),
  };
}
export type AlertService = ReturnType<typeof createAlertService>;
