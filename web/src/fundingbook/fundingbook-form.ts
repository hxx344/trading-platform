// 资金费组合页不依赖 DOM 的部分（docs/fundingbook.md 第 7 节、docs/frontend.md《资金费组合页》）：页签地址、读数格式、参数表单与请求体的互转。
import type { Account, Settings } from '../../../src/fundingbook/model.ts';
import type { PlanStep } from '../../../src/fundingbook/plan.ts';
import type { StateView } from '../../../src/fundingbook/views.ts';

export const FUNDINGBOOK_BASE = '/api/fundingbook';
import type { FundingBookTab } from '../route-parse.ts';
export type { FundingBookTab };
export const FUNDINGBOOK_TABS: readonly { id: FundingBookTab; label: string }[] = [
  { id: 'overview', label: '总览' }, { id: 'plan', label: '路径规划' }, { id: 'paper', label: '模拟盘' }, { id: 'settings', label: '设置' },
];
export const fundingBookHref = (tab: FundingBookTab): string => tab === 'overview' ? '#/fundingbook' : `#/fundingbook/${tab}`;

export function parseState(raw: unknown): StateView {
  const value = raw as Partial<StateView> | null;
  if (!value || typeof value !== 'object' || !value.settings || !value.recovery || !Array.isArray(value.legs) || !Array.isArray(value.rounds) || !Array.isArray(value.venues) || !value.collect || !Array.isArray(value.collect.errors)) throw new Error('应答格式不对');
  return value as StateView;
}

const missing = (value: number | null | undefined): value is null | undefined => value === null || value === undefined || !Number.isFinite(value);
export function usd(value: number | null | undefined, digits = 0): string {
  if (missing(value)) return '—';
  return `${value < 0 ? '−' : ''}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}
export function signedUsd(value: number | null | undefined, digits = 2): string {
  if (missing(value)) return '—';
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}
/** 小数形式的比例显示成百分数：0.0876 → 8.76%。 */
export function percent(value: number | null | undefined, digits = 2): string {
  if (missing(value)) return '—';
  return `${value < 0 ? '−' : ''}${Math.abs(value * 100).toFixed(digits)}%`;
}
export const multiple = (value: number | null | undefined, digits = 2): string => missing(value) ? '—' : `${value.toFixed(digits)}σ`;
export function quantity(value: number | null | undefined): string {
  if (missing(value)) return '—';
  return `${value < 0 ? '−' : ''}${Number(Math.abs(value).toPrecision(5)).toLocaleString('en-US', { maximumFractionDigits: 8 })}`;
}
export function price(value: number | null | undefined): string {
  if (missing(value)) return '—';
  return value.toLocaleString('en-US', { maximumFractionDigits: value >= 1000 ? 1 : value >= 1 ? 3 : 6 });
}
export const tone = (value: number | null | undefined): 'up' | 'down' | '' => missing(value) || value === 0 ? '' : value > 0 ? 'up' : 'down';
export const stamp = (at: number | null | undefined): string => missing(at) ? '—' : new Date(at).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** 一步规划的说明文字。 */
export function stepText(step: PlanStep): string {
  if (step.kind === 'transfer') return `从 ${step.account} 划转 ${usd(step.notional, 2)} 到 ${step.to ?? '—'}`;
  const action = step.close ? '平仓' : step.reduce ? '减仓' : '加仓';
  return `${step.account} ${action}：${step.side === 'buy' ? '买入' : '卖出'} ${quantity(step.qty)} ${step.base ?? ''}（${step.symbol ?? '—'}）`;
}

/** 页面现在该提示什么：没有行情、没启用、回补中、规划失败。没有要提示的为 null。 */
export function notice(state: Pick<StateView, 'running' | 'settings' | 'collect' | 'roundError' | 'round'>): { tone: 'info' | 'warning' | 'error'; text: string } | null {
  if (state.roundError) return { tone: 'error', text: `本轮规划不可用。${state.roundError}` };
  if (!state.settings.enabled) return { tone: 'info', text: '模块还没有启用。在「设置」页签核对账户、标的与参数后打开「启用」，之后只采集公开行情、求解并记模拟盘，不读账户、不下单。' };
  if (!state.running) return { tone: 'warning', text: '合约价差监控没有运行，本模块不采集也不规划。到「行情监控」页打开合约价差后自动继续。' };
  if (!state.round && state.collect.total > 0 && state.collect.done < state.collect.total) return { tone: 'info', text: `正在回补资金费与价格历史：${state.collect.done} / ${state.collect.total} 条序列已补齐，补齐后开始第一轮规划。` };
  return null;
}

type NumericKey = { [K in keyof Settings]: Settings[K] extends number ? K : never }[keyof Settings];
export interface SettingField { key: NumericKey; label: string; unit: string; hint: string; group: 'capital' | 'stats' | 'risk' | 'run' }
export const SETTING_GROUPS: readonly { id: SettingField['group']; label: string }[] = [
  { id: 'capital', label: '本金与规模' }, { id: 'stats', label: '资金费与波动率口径' }, { id: 'risk', label: '安全距离与成本' }, { id: 'run', label: '运行' },
];
export const SETTING_FIELDS: readonly SettingField[] = [
  { key: 'capital', label: '模拟盘本金', unit: '美元', hint: '模拟盘的起始本金；改了之后要重置模拟盘才生效', group: 'capital' },
  { key: 'reservePct', label: '预留比例', unit: '%', hint: '不参与分配的本金；已有仓位的所需资金超出一半预留时按比例减仓', group: 'capital' },
  { key: 'maxGrossLeverage', label: '总名义倍数上限', unit: '倍', hint: '全部账户持仓名义金额合计不超过本金的这么多倍', group: 'capital' },
  { key: 'minLegUsd', label: '最小单腿金额', unit: '美元', hint: '小于它的腿不开；调整小于它的五分之一时不出单', group: 'capital' },
  { key: 'shortDays', label: '短窗口', unit: '天', hint: '最近这么多天的已结算资金费折年化', group: 'stats' },
  { key: 'longDays', label: '长窗口', unit: '天', hint: '更长的参照窗口；历史不够时把短窗口按权重向零收缩', group: 'stats' },
  { key: 'shortWeight', label: '短窗口权重', unit: '0–1', hint: '调整均值 = 短窗口 × 权重 + 长窗口 × (1 − 权重)', group: 'stats' },
  { key: 'volDays', label: '波动率窗口', unit: '天', hint: '用这么多天的小时收益算日波动率与相关性', group: 'stats' },
  { key: 'safetySigma', label: '安全距离', unit: 'σ', hint: '每个账户的权益减维持保证金，至少是 1 日波动金额的这么多倍', group: 'risk' },
  { key: 'horizonDays', label: '持有期', unit: '天', hint: '新开仓位的往返成本按这么多天摊销；越短越不愿意换仓', group: 'risk' },
  { key: 'slippageBps', label: '滑点', unit: '基点', hint: '每次成交在手续费之外再扣的成本', group: 'risk' },
  { key: 'roundMinutes', label: '规划间隔', unit: '分钟', hint: '每隔这么久重新求解一次', group: 'run' },
];
export interface AccountForm { id: string; venue: string; mmrPct: string; maxLeverage: string; takerBps: string }
export type SettingsForm = Record<NumericKey, string> & { enabled: boolean; paperAuto: boolean; bases: string; accounts: AccountForm[] };

const tidy = (value: number): string => String(Number(value.toPrecision(12)));
export function settingsForm(settings: Settings): SettingsForm {
  return {
    ...Object.fromEntries(SETTING_FIELDS.map(field => [field.key, tidy(settings[field.key])])) as Record<NumericKey, string>,
    enabled: settings.enabled, paperAuto: settings.paperAuto, bases: settings.bases.join(', '),
    accounts: settings.accounts.map(account => ({ id: account.id, venue: account.venue, mmrPct: tidy(account.mmrPct), maxLeverage: tidy(account.maxLeverage), takerBps: tidy(account.takerBps) })),
  };
}
/** 换场所时带出这个场所默认的费率、保证金率与杠杆：留着上一个场所的值会算错成本。 */
export function venueDefaults(venue: string, venues: StateView['venues']): Partial<AccountForm> {
  const spec = venues.find(item => item.id === venue);
  return spec ? { venue, mmrPct: tidy(spec.mmrPct), maxLeverage: tidy(spec.maxLeverage), takerBps: tidy(spec.takerBps) } : { venue };
}
/** 新加一个账户：名称取「场所-序号」里第一个没用过的，费率与保证金率取这个场所的默认值。 */
export function newAccount(form: SettingsForm, venues: StateView['venues']): AccountForm {
  const used = new Set(form.accounts.map(account => account.id));
  const spec = venues.find(venue => !form.accounts.some(account => account.venue === venue.id)) ?? venues[0]!;
  let index = 1;
  while (used.has(`${spec.id}-${index}`)) index += 1;
  return { id: `${spec.id}-${index}`, venue: spec.id, mmrPct: tidy(spec.mmrPct), maxLeverage: tidy(spec.maxLeverage), takerBps: tidy(spec.takerBps) };
}
const NUMBER = /^\d+(\.\d+)?$/;
/** 表单转成请求体；只查格式，范围由服务端校验。有填错的项时给出第一处的说明。 */
export function settingsRequest(form: SettingsForm): { ok: true; body: Settings } | { ok: false; message: string } {
  const numbers = {} as Record<NumericKey, number>;
  for (const field of SETTING_FIELDS) {
    const text = form[field.key].trim();
    if (!NUMBER.test(text)) return { ok: false, message: `${field.label}须为不带符号的数字` };
    numbers[field.key] = Number(text);
  }
  const bases = form.bases.split(/[\s,，、]+/).map(item => item.trim().toUpperCase()).filter(Boolean);
  const accounts: Account[] = [];
  for (const [index, account] of form.accounts.entries()) {
    const id = account.id.trim();
    if (!id) return { ok: false, message: `第 ${index + 1} 个账户没有名称` };
    for (const [key, label] of [['mmrPct', '维持保证金率'], ['maxLeverage', '最大杠杆'], ['takerBps', '吃单费率']] as const) {
      if (!NUMBER.test(account[key].trim())) return { ok: false, message: `账户 ${id} 的${label}须为不带符号的数字` };
    }
    accounts.push({ id, venue: account.venue as Account['venue'], mmrPct: Number(account.mmrPct), maxLeverage: Number(account.maxLeverage), takerBps: Number(account.takerBps) });
  }
  return { ok: true, body: { ...numbers, enabled: form.enabled, paperAuto: form.paperAuto, bases, accounts } };
}
export function settingsChanged(form: SettingsForm, settings: Settings): boolean {
  const request = settingsRequest(form);
  return !request.ok || JSON.stringify(settingsForm(request.body)) !== JSON.stringify(settingsForm(settings));
}
export const resetConfirmText = (state: Pick<StateView, 'settings' | 'rounds' | 'recovery'>): string =>
  `确认后删除${state.recovery.book ? '原始账本、' : ''}全部模拟持仓、现金和规划记录（最近 ${state.rounds.length} 轮可见）。${state.recovery.settings ? '恢复参数后才能重新规划。' : `下一轮规划按本金 ${usd(state.settings.capital)} 重新开始。`}已回补的行情历史保留。`;
