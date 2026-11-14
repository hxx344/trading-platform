// M-3b: the workbench's market alert files turned into this service's tiers (docs/monitor.md M-3b). Pure functions over
// the parsed JSON of <workbench data>/modules/monitor/:
//   oil/monitor.json      { schemaVersion: 1, config: { enabled, rules: [{ id, label, metric, operator, threshold, cooldownMinutes, hysteresis, enabled }] } }
//                         the rules this service's tiers were copied from (server/oil/config.mjs); stored percentage rules
//                         (`spreadPercent`) become disabled absolute-spread rules as the workbench converts them on read.
//   hynix/alerts.json     { version: 1 | 2, config: { enabled, cooldownSeconds, hysteresis, rules: [{ id, name, enabled, direction, threshold, cooldownSeconds?, hysteresis? }] } }
//                         (server/alert-engine.mjs): each tier takes its own cooldown and band or the panel-wide ones,
//                         above / below / both become gte / lte / both, the cooldown goes from seconds to minutes.
//   notifications.json    { version: 1, config: { webhookUrl, signingSecret }, candidates: [...] } (server/notification-store.mjs):
//                         the one robot of the workbench's market alerts.
// Only names, counts and reasons leave this file as text; a webhook address goes into the plan's secrets and nowhere else.
import { ALERT_SPECS, validateAlertConfig, type AlertConfig, type AlertMarket } from './alerts.ts';

export type Converted = { config: AlertConfig; notes: string[] } | { config: null; problem: string };
export interface WorkbenchRobot { webhook: string; secret: string | null }
export type RobotRead = { robot: WorkbenchRobot } | { robot: null; problem: string };

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const LEGACY_PERCENT_SUFFIX = '（原百分比）';
/** Cut to `max` UTF-16 units on whole code points (the workbench's truncateUnits). */
function truncateUnits(text: string, max: number): string {
  let out = '';
  for (const char of text) { if (out.length + char.length > max) break; out += char; }
  return out;
}
const condition = (rule: Record<string, unknown>): string => JSON.stringify([rule.metric, rule.operator, rule.threshold]);

/** Validated as the page's save validates; the reason is the check that failed. */
function checked(market: AlertMarket, config: unknown, notes: string[]): Converted {
  try { return { config: validateAlertConfig(market, config), notes }; }
  catch (error) { return { config: null, problem: `档位未通过本服务的检查：${reason(error)}` }; }
}

/** oil/monitor.json → this service's oil tiers. */
export function convertOilAlerts(file: unknown): Converted {
  if (!isRecord(file) || file.schemaVersion !== 1 || !isRecord(file.config) || !Array.isArray(file.config.rules)) return { config: null, problem: '格式无法识别（不是工作台原油告警的 monitor.json）' };
  const notes: string[] = [];
  const rules = file.config.rules as unknown[];
  const kept = new Set(rules.filter(isRecord).filter(rule => rule.metric !== 'spreadPercent').map(condition));
  let converted = 0, dropped = 0;
  const next = rules.flatMap(item => {
    if (!isRecord(item)) return [item];
    const { id, label, metric, operator, threshold, cooldownMinutes, hysteresis, enabled } = item;
    const rule = { id, label, metric, operator, threshold, cooldownMinutes, hysteresis, enabled };
    if (metric !== 'spreadPercent') return [rule];
    const moved = { ...rule, label: typeof label === 'string' ? `${truncateUnits(label.trim(), ALERT_SPECS.oil.labelMax - LEGACY_PERCENT_SUFFIX.length)}${LEGACY_PERCENT_SUFFIX}` : label, metric: 'spread', enabled: false };
    if (kept.has(condition(moved))) { dropped += 1; return []; }
    kept.add(condition(moved)); converted += 1;
    return [moved];
  });
  if (converted) notes.push(`${converted} 档旧的百分比价差档改为同数值的绝对价差档并关闭（同工作台），核对阈值后再打开`);
  if (dropped) notes.push(`${dropped} 档旧的百分比价差档换算后与已有档重复，未导入`);
  return checked('oil', { enabled: file.config.enabled, rules: next }, notes);
}

const DIRECTION = { above: 'gte', below: 'lte', both: 'both' } as const;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** hynix/alerts.json → this service's Hynix tiers; a tier repeating an earlier one's direction and threshold is left out. */
export function convertHynixAlerts(file: unknown): Converted {
  if (!isRecord(file) || (file.version !== 1 && file.version !== 2) || !isRecord(file.config) || !Array.isArray(file.config.rules)) return { config: null, problem: '格式无法识别（不是工作台海力士告警的 alerts.json）' };
  const config = file.config;
  if (!finite(config.cooldownSeconds) || !finite(config.hysteresis)) return { config: null, problem: '缺少统一的冷却时间或回差' };
  const notes: string[] = [], seen = new Set<string>();
  let duplicates = 0;
  const rules = (config.rules as unknown[]).flatMap(item => {
    if (!isRecord(item)) return [item];
    const operator = typeof item.direction === 'string' && Object.hasOwn(DIRECTION, item.direction) ? DIRECTION[item.direction as keyof typeof DIRECTION] : item.direction;
    const cooldownSeconds = item.cooldownSeconds ?? config.cooldownSeconds;
    const rule = {
      id: item.id, label: item.name, metric: 'premium', operator, threshold: item.threshold,
      cooldownMinutes: finite(cooldownSeconds) ? cooldownSeconds / 60 : cooldownSeconds, hysteresis: item.hysteresis ?? config.hysteresis, enabled: item.enabled,
    };
    if (seen.has(condition(rule))) { duplicates += 1; return []; }
    seen.add(condition(rule));
    return [rule];
  });
  if (duplicates) notes.push(`${duplicates} 档与前面的档方向、阈值相同，本服务不允许重复，未导入`);
  notes.push('冷却时间由秒换算为分钟；没有单独设置的档带上工作台的统一冷却与回差');
  return checked('hynix', { enabled: config.enabled, rules }, notes);
}

/** notifications.json → the workbench's market alert robot. */
export function convertRobot(file: unknown): RobotRead {
  if (!isRecord(file) || file.version !== 1 || !isRecord(file.config) || typeof file.config.webhookUrl !== 'string' || typeof file.config.signingSecret !== 'string') return { robot: null, problem: '格式无法识别（不是工作台的 notifications.json）' };
  const webhook = file.config.webhookUrl.trim(), secret = file.config.signingSecret.trim();
  if (!webhook) {
    return { robot: null, problem: Array.isArray(file.candidates) && file.candidates.length ? '工作台有两个待选的机器人（原油、海力士各一个），尚未在工作台的统一飞书告警设置里选定' : '工作台没有配置行情告警机器人' };
  }
  return { robot: { webhook, secret: secret || null } };
}

/** The markets' tiers in one import, as the writer receives them on stdin. */
export type AlertImport = Partial<Record<AlertMarket, AlertConfig>>;
/** Checks the writer's input again (it runs as another user and trusts nothing it is handed). */
export function parseAlertImport(value: unknown): AlertImport {
  if (!isRecord(value)) throw new Error('导入内容须为对象');
  const out: AlertImport = {};
  for (const [market, config] of Object.entries(value)) {
    if (market !== 'oil' && market !== 'hynix') throw new Error(`未知的市场：${market.slice(0, 16)}`);
    out[market] = validateAlertConfig(market, config);
  }
  if (!out.oil && !out.hynix) throw new Error('没有要导入的档位');
  return out;
}
