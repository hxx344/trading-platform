// The oil spread rules' form (docs/oil.md section 7) without the DOM: the form's text fields to the config the service
// checks, and the shapes of GET /api/oil/rules. Wording follows the workbench's TradingAutoRules.tsx.

export type RuleDirection = 'short' | 'long';
export type RuleVenue = 'binance' | 'bybit';
export interface OilRuleConfig {
  name: string; venue: RuleVenue; direction: RuleDirection; openThreshold: string; closeThreshold: string; barrels: string; confirmSamples: number; maxOpensPerDay: number;
}
export interface OilRuleReading { value: string; met: boolean; side: 'sell' | 'buy'; hits: number; signaled: boolean; at: number; stale: boolean }
export interface OilRuleEvent { at: number; kind: 'signal' | 'reset' | 'note'; message: string; action?: 'open' | 'close'; value?: string; threshold?: string; hits?: number; bzAt?: number; clAt?: number }
export interface OilRule {
  id: string; revision: number; createdAt: number; title: string; mode: 'observe'; observing: boolean; config: OilRuleConfig; problem: string | null;
  observation: { open: OilRuleReading | null; close: OilRuleReading | null; note: string | null } | null;
  observations: OilRuleEvent[]; events: OilRuleEvent[];
}
export type OilRulesView = { available: true; now: number; maxRules: number; quoteMaxAgeMs: number; venues: RuleVenue[]; rules: OilRule[] } | { available: false; error: string; rules: [] };

export interface RuleForm { name: string; venue: RuleVenue; direction: RuleDirection; openThreshold: string; closeThreshold: string; barrels: string; confirmSamples: string; maxOpensPerDay: string }
export const emptyRuleForm = (venue: RuleVenue): RuleForm => ({ name: '', venue, direction: 'short', openThreshold: '', closeThreshold: '', barrels: '', confirmSamples: '3', maxOpensPerDay: '3' });
export const ruleFormOf = (config: OilRuleConfig): RuleForm => ({ ...config, confirmSamples: String(config.confirmSamples), maxOpensPerDay: String(config.maxOpensPerDay) });

const DECIMAL = /^-?\d+(?:\.\d{1,18})?$/;
/** Exact order of two decimal strings (up to 18 places), matching the server's comparison. */
export function compareDecimal(left: string, right: string): -1 | 0 | 1 {
  const scaled = (value: string) => { const [whole, fraction = ''] = value.replace('-', '').split('.'); const magnitude = BigInt(whole + fraction.padEnd(18, '0')); return value.startsWith('-') ? -magnitude : magnitude; };
  const a = scaled(left.trim()), b = scaled(right.trim());
  return a > b ? 1 : a < b ? -1 : 0;
}

/** The config to send, or the first thing wrong with the form; the service checks everything again. */
export function ruleConfigOf(form: RuleForm): { config: OilRuleConfig } | { error: string } {
  const open = form.openThreshold.trim(), close = form.closeThreshold.trim(), barrels = form.barrels.trim();
  const name = form.name.trim();
  // The same bounds as the service's parseRuleConfig (src/oil/rules.ts).
  if (name.length > 40 || /[\u0000-\u001f\u007f-\u009f]/.test(form.name)) return { error: '规则名称最多 40 个字符，不能含控制字符。' };
  if (!DECIMAL.test(open) || !DECIMAL.test(close) || open.length > 24 || close.length > 24) return { error: '开仓与平仓阈值须为十进制数，可为负数。' };
  if ([open, close].some(value => compareDecimal(value, '-1000') < 0 || compareDecimal(value, '1000') > 0)) return { error: '开仓与平仓阈值须在 -1000 至 1000 USDT/桶之间。' };
  if (!/^\d+(?:\.\d{1,18})?$/.test(barrels) || !/[1-9]/.test(barrels) || barrels.length > 24) return { error: '请填写大于零的每腿桶数。' };
  if (compareDecimal(barrels, '10000') > 0) return { error: '每腿桶数最多 10000 桶。' };
  const order = compareDecimal(close, open), short = form.direction === 'short';
  if (short ? order >= 0 : order <= 0) return { error: short ? '做空价差时，平仓阈值须低于开仓阈值。' : '做多价差时，平仓阈值须高于开仓阈值。' };
  const whole = (value: string, low: number, high: number) => /^\d{1,3}$/.test(value.trim()) && Number(value) >= low && Number(value) <= high ? Number(value) : null;
  const confirmSamples = whole(form.confirmSamples, 1, 30), maxOpensPerDay = whole(form.maxOpensPerDay, 1, 50);
  if (confirmSamples === null) return { error: '连续满足次数须为 1 至 30 的整数。' };
  if (maxOpensPerDay === null) return { error: '每日最多开仓次数须为 1 至 50 的整数。' };
  return { config: { name, venue: form.venue, direction: form.direction, openThreshold: open, closeThreshold: close, barrels, confirmSamples, maxOpensPerDay } };
}

export const directionText = (direction: RuleDirection): string => direction === 'short' ? '做空价差：卖 BZ / 买 CL' : '做多价差：买 BZ / 卖 CL';
export function conditionText(config: OilRuleConfig): string {
  const short = config.direction === 'short';
  return `开仓：价差 ${short ? '≥' : '≤'} ${config.openThreshold} USDT/桶 · 平仓：价差 ${short ? '≤' : '≥'} ${config.closeThreshold} USDT/桶`;
}
