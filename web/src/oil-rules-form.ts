// The spread rules' form (docs/oil.md section 7; hynix docs/hynix.md 8.2) without the DOM: the form's text fields to the
// config the service checks, and the shapes of GET /api/oil/rules. Wording follows the workbench's TradingAutoRules.tsx.

export type RuleDirection = 'short' | 'long';
export type RuleVenue = 'binance' | 'bybit' | 'okx';
export type RuleMarket = 'oil' | 'hynix';
export interface RuleBatches { count: number; intervalMs: number }
export interface OilRuleConfig {
  /** The service reads a stored rule without one as oil and always answers with it. */
  market: RuleMarket;
  name: string; venue: RuleVenue; direction: RuleDirection; openThreshold: string; closeThreshold: string;
  /** Oil per leg. */
  barrels?: string;
  /** Hynix per leg, USDT. */
  notional?: string;
  confirmSamples: number; maxOpensPerDay: number;
  batches?: RuleBatches;
}
/** Each market's wording: the spread's name and unit, the legs (premium first) and the size field. */
export const RULE_MARKET_TEXT = {
  oil: { name: '原油', spread: '价差', unit: 'USDT/桶', premium: 'BZ', base: 'CL', lead: 'CL', hedge: 'BZ', low: '-1000', size: '每腿桶数', sizeUnit: '桶', sizeLimit: '10000' },
  hynix: { name: '海力士', spread: '溢价', unit: '%', premium: 'ADR', base: '正股', lead: 'ADR', hedge: '正股', low: '-99', size: '每腿名义金额', sizeUnit: 'USDT', sizeLimit: '1000000' },
} as const;
const LEG_NAMES: Record<string, string> = { CLUSDT: 'CL', BZUSDT: 'BZ', SKHYUSDT: 'ADR', SKHYNIXUSDT: '正股' };
/** Batches the service allows (contracts MAX_BATCHES, MAX_BATCH_INTERVAL_MS; a job of one minute plus intervals within an hour). */
export const RULE_BATCH_LIMITS = { count: 20, intervalSeconds: 600, totalMs: 3_600_000, jobMs: 60_000 } as const;
export interface OilRuleReading { value: string; met: boolean; side: 'sell' | 'buy'; hits: number; signaled: boolean; at: number; stale: boolean }
export interface OilRuleEvent { at: number; kind: 'signal' | 'reset' | 'note'; message: string; action?: 'open' | 'close'; value?: string; threshold?: string; hits?: number; bzAt?: number; clAt?: number }
export type RulePhase = 'idle' | 'opening' | 'holding' | 'closing' | 'review';
export interface OilRuleLive {
  enabled: boolean; phase: RulePhase; phaseName: string;
  held: { symbol: string; side: 'long' | 'short'; quantity: string; barrels: string }[] | null;
  pending: { action: 'open' | 'close'; at: number } | null; job: { id: string; action: 'open' | 'close'; at: number } | null;
  opensToday: number; failures: number; retryAt: number | null; reason: string | null;
  /**
   * Refused for another position on the contract since `since`, last at `lastAt`; notified: the 30-minute notice was handed
   * to the notifier's outbox (without a Feishu robot it is only logged). Absent from older services.
   */
  blocked?: { since: number; lastAt: number; notified: boolean } | null;
}
export interface OilRule {
  id: string; revision: number; createdAt: number; title: string; mode: 'observe' | 'live'; observing: boolean; config: OilRuleConfig; problem: string | null;
  observation: { open: OilRuleReading | null; close: OilRuleReading | null; note: string | null } | null;
  /** Live mode only (docs/oil.md 7.3). */
  live: OilRuleLive | null;
  observations: OilRuleEvent[]; events: OilRuleEvent[];
}
export type OilRulesView = { available: true; liveAvailable: boolean; now: number; maxRules: number; quoteMaxAgeMs: number; failureLimit: number; venues: RuleVenue[]; rules: OilRule[] } | { available: false; error: string; rules: [] };

/** `size` is the barrels (oil) or the USDT notional (hynix) per leg; batches of 1 send no batches. */
export interface RuleForm { market: RuleMarket; name: string; venue: RuleVenue; direction: RuleDirection; openThreshold: string; closeThreshold: string; size: string; confirmSamples: string; maxOpensPerDay: string; batchCount: string; batchIntervalSeconds: string }
export const emptyRuleForm = (venue: RuleVenue, market: RuleMarket = 'oil'): RuleForm => ({ market, name: '', venue, direction: 'short', openThreshold: '', closeThreshold: '', size: '', confirmSamples: '3', maxOpensPerDay: '3', batchCount: '1', batchIntervalSeconds: '0' });
export const ruleFormOf = (config: OilRuleConfig): RuleForm => ({
  market: config.market, name: config.name, venue: config.venue, direction: config.direction, openThreshold: config.openThreshold, closeThreshold: config.closeThreshold,
  size: (config.market === 'hynix' ? config.notional : config.barrels) ?? '', confirmSamples: String(config.confirmSamples), maxOpensPerDay: String(config.maxOpensPerDay),
  batchCount: String(config.batches?.count ?? 1), batchIntervalSeconds: String((config.batches?.intervalMs ?? 0) / 1000),
});

const DECIMAL = /^-?\d+(?:\.\d{1,18})?$/;
/** Exact order of two decimal strings (up to 18 places), matching the server's comparison. */
export function compareDecimal(left: string, right: string): -1 | 0 | 1 {
  const scaled = (value: string) => { const [whole, fraction = ''] = value.replace('-', '').split('.'); const magnitude = BigInt(whole + fraction.padEnd(18, '0')); return value.startsWith('-') ? -magnitude : magnitude; };
  const a = scaled(left.trim()), b = scaled(right.trim());
  return a > b ? 1 : a < b ? -1 : 0;
}

/** The config to send, or the first thing wrong with the form; the service checks everything again. */
export function ruleConfigOf(form: RuleForm): { config: OilRuleConfig } | { error: string } {
  const text = RULE_MARKET_TEXT[form.market];
  const open = form.openThreshold.trim(), close = form.closeThreshold.trim(), size = form.size.trim();
  const name = form.name.trim();
  // The same bounds as the service's parseRuleConfig (src/oil/rules.ts).
  if (name.length > 40 || /[\u0000-\u001f\u007f-\u009f]/.test(form.name)) return { error: '规则名称最多 40 个字符，不能含控制字符。' };
  if (!DECIMAL.test(open) || !DECIMAL.test(close) || open.length > 24 || close.length > 24) return { error: '开仓与平仓阈值须为十进制数，可为负数。' };
  if ([open, close].some(value => compareDecimal(value, text.low) < 0 || compareDecimal(value, '1000') > 0)) return { error: `开仓与平仓阈值须在 ${text.low} 至 1000 ${text.unit}之间。` };
  if (!/^\d+(?:\.\d{1,18})?$/.test(size) || !/[1-9]/.test(size) || size.length > 24) return { error: `请填写大于零的${text.size}。` };
  if (compareDecimal(size, text.sizeLimit) > 0) return { error: `${text.size}最多 ${text.sizeLimit} ${text.sizeUnit}。` };
  const order = compareDecimal(close, open), short = form.direction === 'short';
  if (short ? order >= 0 : order <= 0) return { error: short ? `做空${text.spread}时，平仓阈值须低于开仓阈值。` : `做多${text.spread}时，平仓阈值须高于开仓阈值。` };
  const whole = (value: string, low: number, high: number) => /^\d{1,3}$/.test(value.trim()) && Number(value) >= low && Number(value) <= high ? Number(value) : null;
  const confirmSamples = whole(form.confirmSamples, 1, 30), maxOpensPerDay = whole(form.maxOpensPerDay, 1, 50);
  if (confirmSamples === null) return { error: '连续满足次数须为 1 至 30 的整数。' };
  if (maxOpensPerDay === null) return { error: '每日最多开仓次数须为 1 至 50 的整数。' };
  const count = whole(form.batchCount, 1, RULE_BATCH_LIMITS.count), seconds = whole(form.batchIntervalSeconds, 0, RULE_BATCH_LIMITS.intervalSeconds);
  if (count === null) return { error: `批次数须为 1 至 ${RULE_BATCH_LIMITS.count} 的整数。` };
  if (count > 1 && seconds === null) return { error: `批次间隔须为 0 至 ${RULE_BATCH_LIMITS.intervalSeconds} 秒的整数。` };
  if (count > 1 && RULE_BATCH_LIMITS.jobMs + (count - 1) * seconds! * 1000 > RULE_BATCH_LIMITS.totalMs) return { error: `批次间隔合计加上 ${RULE_BATCH_LIMITS.jobMs / 1000} 秒执行时间不能超过 ${RULE_BATCH_LIMITS.totalMs / 1000} 秒。` };
  return { config: {
    market: form.market, name, venue: form.venue, direction: form.direction, openThreshold: open, closeThreshold: close,
    ...(form.market === 'hynix' ? { notional: size } : { barrels: size }), confirmSamples, maxOpensPerDay,
    ...(count > 1 ? { batches: { count, intervalMs: seconds! * 1000 } } : {}),
  } };
}

export const directionText = (direction: RuleDirection, market: RuleMarket = 'oil'): string => {
  const text = RULE_MARKET_TEXT[market];
  return direction === 'short' ? `做空${text.spread}：卖 ${text.premium} / 买 ${text.base}` : `做多${text.spread}：买 ${text.premium} / 卖 ${text.base}`;
};
export function conditionText(config: OilRuleConfig): string {
  const short = config.direction === 'short', text = RULE_MARKET_TEXT[config.market];
  return `开仓：${text.spread} ${short ? '≥' : '≤'} ${config.openThreshold} ${text.unit} · 平仓：${text.spread} ${short ? '≤' : '≥'} ${config.closeThreshold} ${text.unit}`;
}
/** The rule's size per job: barrels or USDT per leg, and its batches. */
export function sizeText(config: OilRuleConfig): string {
  const size = config.market === 'hynix' ? `每腿 ${config.notional ?? '—'} USDT` : `每腿 ${config.barrels ?? '—'} 桶`;
  return config.batches ? `${size}，分 ${config.batches.count} 批、间隔 ${config.batches.intervalMs / 1000} 秒` : size;
}

export type RuleAction = 'start' | 'stop' | 'live' | 'enable' | 'disable' | 'observe' | 'reset' | 'delete';
/** A live rule with an order on the way: it cannot be edited, deleted or reset until the job ends. */
export const ruleBusy = (live: OilRuleLive): boolean => live.phase === 'opening' || live.phase === 'closing' || live.pending !== null || live.job !== null;
/** The actions the service would accept now (src/oil/rules.ts act), so the page offers only those. */
export function ruleActions(rule: OilRule, liveAvailable: boolean): { actions: RuleAction[]; edit: boolean; lockSides: boolean } {
  const live = rule.live;
  if (rule.mode === 'observe' || !live) {
    // A rule whose settings cannot be read can still be stopped, but not started.
    const actions: RuleAction[] = rule.observing ? ['stop'] : rule.problem ? [] : ['start'];
    if (liveAvailable && !rule.problem) actions.push('live');
    actions.push('delete');
    return { actions, edit: true, lockSides: false };
  }
  const busy = ruleBusy(live), actions: RuleAction[] = [];
  if (live.enabled) actions.push('disable');
  else if (live.phase !== 'review' && liveAvailable && !rule.problem) actions.push('enable');
  if ((live.phase === 'review' || live.phase === 'holding') && !busy) actions.push('reset');
  if (!live.enabled && live.phase === 'idle' && !live.held && !busy) actions.push('observe');
  if (live.phase === 'idle' && !live.held && !busy) actions.push('delete');
  // An enabled rule is disabled before an edit, so new sizes and thresholds go through the enable confirmation again.
  return { actions, edit: !busy && !live.enabled, lockSides: live.phase !== 'idle' };
}

const sideText = (side: 'long' | 'short') => side === 'long' ? '多' : '空';
export const heldText = (held: NonNullable<OilRuleLive['held']>, market: RuleMarket = 'oil'): string =>
  `${held.map(leg => `${LEG_NAMES[leg.symbol] ?? leg.symbol} ${sideText(leg.side)} ${leg.quantity}`).join(' · ')}${market === 'oil' ? `（每腿 ${held[0]?.barrels ?? '0'} 桶）` : ''}`;

/** The browser confirmation before a rule may send orders, or before its record of a position is dropped. */
export function liveConfirmText(rule: OilRule, action: 'live' | 'enable' | 'reset', venueName: string): string {
  const { config } = rule;
  const text = RULE_MARKET_TEXT[config.market];
  if (action === 'reset') return `确认已在交易所核对并处理「${rule.title}」的仓位？\n重置后规则不再记录之前的持仓${rule.live?.held ? `（${heldText(rule.live.held, config.market)}）` : ''}，回到等待开仓、未启用；不会向交易所发送任何委托。`;
  const size = config.market === 'hynix' ? `开仓每腿 ${config.notional} USDT 等金额` : `开仓每腿 ${config.barrels} 桶`;
  const batches = config.batches ? `，每次分 ${config.batches.count} 批、批间隔 ${config.batches.intervalMs / 1000} 秒` : '';
  const hedge = config.market === 'hynix' ? `${text.hedge}对冲腿市价按计划比例` : `${text.hedge}对冲腿市价`;
  return `${action === 'live' ? `将「${rule.title}」转为实盘并启用？` : `启用实盘规则「${rule.title}」？`}\n条件连续满足 ${config.confirmSamples} 次后，服务器会在 ${venueName} 自动下单：${size}${batches}（${text.lead} 首腿 IOC 市价带价格保护，${hedge}），平仓按规则自己的持有量；每日最多开仓 ${config.maxOpensPerDay} 次。\n账户核对与价格保护照常生效。关闭页面不影响，停用前会一直运行。`;
}
