// The options page's conversions, kept free of the DOM so they have unit tests (test/options-form.test.ts): the plan and
// start bodies, the net limit typed in the confirmation, the expiry payoff curve, the chain rows around the index and the
// per-task progress and amounts. Rules and wording follow the workbench Greeks page (modules/greeks/app/static/app.js,
// 2f0593d).
import type { ChainRow, Execution, OptionsState, OrderRow, Plan, Preview, ScheduleView, StrategyMode, Task, TaskStatus } from './options-types.ts';

export const ACTIVE_STATUSES: readonly TaskStatus[] = ['accepted', 'running', 'stopping', 'recovering', 'recovery_needed'];
export const isActive = (task: Pick<Task, 'status'>): boolean => ACTIVE_STATUSES.includes(task.status);
export const STATUS_TEXT: Record<TaskStatus, string> = {
  accepted: '已受理', running: '执行中', stopping: '请求停止 · 正在核对', recovering: '恢复中 · 正在核对', recovery_needed: '状态待核对',
  completed: '全部成交', stopped: '已停止', partial: '部分成交 · 已结束', failed: '执行失败',
};
export const strategyName = (mode: StrategyMode | null | undefined): string => mode === 'short_strangle' ? '双腿卖出' : '四腿铁鹰';
export const QUANTITY_PRESETS = ['0.01', '0.05', '0.1', '0.25', '0.5', '1'] as const;

const QUANTITY = /^\d{1,4}(\.\d{1,8})?$/;
/** The per-leg quantity typed or picked: a positive decimal of at most 8 places, or null. */
export function parseQuantity(text: string): string | null {
  const value = text.trim();
  return QUANTITY.test(value) && Number(value) > 0 ? value.replace(/^0+(?=\d)/, '') : null;
}

export function planBody(operation: 'open' | 'close', quantity: string, mode: StrategyMode): Record<string, unknown> {
  return operation === 'open' ? { operation, quantity, mode } : { operation };
}

/**
 * The net limit typed in the confirmation: an opening's lowest accepted net income, a closing's highest accepted net
 * cost (both after the estimated fees). Empty keeps the plan's own limit; anything else must be a finite number.
 */
export function startBody(plan: Plan, requestId: string, limitText: string): { body: Record<string, unknown> } | { error: string } {
  const text = limitText.trim();
  const body: Record<string, unknown> = { planId: plan.planId, requestId, confirmLive: true };
  if (text === '') return { body };
  if (!/^-?\d+(\.\d+)?$/.test(text) || !Number.isFinite(Number(text)) || Math.abs(Number(text)) > 10_000_000) return { error: '净价限制须为数字（USD）' };
  body[plan.operation === 'open' ? 'minNetIncomeUsd' : 'maxNetCostUsd'] = Number(text);
  return { body };
}
export const planLimit = (plan: Plan): number | null => plan.operation === 'open' ? plan.minNetIncomeUsd : plan.maxNetCostUsd;

/** The expiry P&L of the previewed strategy at one index price, as the workbench draws it (USD, net credit included). */
export function payoffAt(price: number, preview: Pick<Preview, 'netCreditUsd' | 'legs'>): number {
  let value = preview.netCreditUsd;
  for (const leg of preview.legs) {
    const intrinsic = leg.optionType === 'Call' ? Math.max(price - leg.strike, 0) : Math.max(leg.strike - price, 0);
    value += (leg.side === 'Buy' ? 1 : -1) * intrinsic * Number(leg.qty);
  }
  return value;
}
export interface PayoffCurve { low: number; high: number; samples: { price: number; pnl: number }[]; breakevens: number[]; min: number; max: number }
/** 121 samples over the strikes widened by 32 % of their span (at least 1 000), and where the curve crosses zero. */
export function payoffCurve(preview: Pick<Preview, 'netCreditUsd' | 'legs'>): PayoffCurve | null {
  if (!preview.legs.length) return null;
  const strikes = preview.legs.map(leg => leg.strike);
  const lowStrike = Math.min(...strikes), highStrike = Math.max(...strikes), span = Math.max(1_000, highStrike - lowStrike);
  const low = Math.max(0, lowStrike - span * 0.32), high = highStrike + span * 0.32;
  const samples = Array.from({ length: 121 }, (_, index) => { const price = low + (high - low) * index / 120; return { price, pnl: payoffAt(price, preview) }; });
  const breakevens: number[] = [];
  for (let index = 1; index < samples.length; index++) {
    const a = samples[index - 1]!, b = samples[index]!;
    if ((a.pnl < 0) !== (b.pnl < 0)) breakevens.push(a.price + (0 - a.pnl) * (b.price - a.price) / (b.pnl - a.pnl));
  }
  const values = samples.map(point => point.pnl);
  return { low, high, samples, breakevens, min: Math.min(...values, 0), max: Math.max(...values, 0) };
}

export interface ChainLine { strike: number; call: ChainRow | null; put: ChainRow | null; atm: boolean; selected: boolean }
/** The 12 strikes nearest the index plus the strategy's strikes, ascending, with the call and the put of each. */
export function chainLines(rows: readonly ChainRow[], index: number | null, legSymbols: readonly string[]): ChainLine[] {
  const strikes = [...new Set(rows.map(row => row.strike))].sort((a, b) => a - b);
  if (!strikes.length) return [];
  const mid = index ?? strikes.reduce((a, b) => a + b, 0) / strikes.length;
  const atm = strikes.reduce((nearest, strike) => Math.abs(strike - mid) < Math.abs(nearest - mid) ? strike : nearest, strikes[0]!);
  const chosen = new Set(legSymbols);
  const legStrikes = rows.filter(row => chosen.has(row.symbol)).map(row => row.strike);
  const nearby = [...strikes].sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid)).slice(0, 12);
  return [...new Set([...nearby, ...legStrikes])].sort((a, b) => a - b).map(strike => {
    const call = rows.find(row => row.optionType === 'Call' && row.strike === strike) ?? null;
    const put = rows.find(row => row.optionType === 'Put' && row.strike === strike) ?? null;
    return { strike, call, put, atm: strike === atm, selected: [call, put].some(row => row !== null && chosen.has(row.symbol)) };
  });
}

export interface TaskLeg { symbol: string; side: 'Buy' | 'Sell'; target: number; filled: number; remaining: number; complete: boolean; unknown: boolean; orders: OrderRow[] }
export interface TaskSummary { legs: TaskLeg[]; completedLegs: number; totalLegs: number; ratio: number | null; amountsComplete: boolean; gross: number; fee: number; net: number; currency: string | null }
const EPSILON = 1e-9;
/**
 * Progress from the task's orders and amounts from its fills. The amounts count only when every leg's fills add up to
 * its filled quantity in one currency (the fill list keeps the latest records only); otherwise they read "待核对".
 */
export function taskSummary(task: Task, orders: readonly OrderRow[], executions: readonly Execution[]): TaskSummary {
  const mine = orders.filter(order => order.taskId === task.id);
  const fills = executions.filter(item => item.taskId === task.id);
  const legs: TaskLeg[] = Object.values(task.legs).map(leg => {
    const legOrders = mine.filter(order => order.symbol === leg.symbol).sort((a, b) => a.createdAt - b.createdAt);
    const target = Number(leg.qty), filled = legOrders.reduce((sum, order) => sum + Number(order.filledQty), 0);
    // Open orders of a running task are working; once the task has ended or needs checking they are unconfirmed.
    const unknown = legOrders.some(order => !order.terminal) && (task.status === 'recovery_needed' || !isActive(task));
    return { symbol: leg.symbol, side: leg.side, target, filled, remaining: Math.max(0, target - filled), complete: filled + EPSILON >= target, unknown, orders: legOrders };
  });
  const completedLegs = legs.filter(leg => leg.complete).length;
  const targetTotal = legs.reduce((sum, leg) => sum + leg.target, 0);
  const ratio = targetTotal > 0 ? Math.min(1, legs.reduce((sum, leg) => sum + Math.min(leg.filled, leg.target), 0) / targetTotal) : null;
  const currencies = new Set(fills.map(item => item.feeCurrency));
  const covered = legs.every(leg => Math.abs(fills.filter(item => item.symbol === leg.symbol).reduce((sum, item) => sum + item.execQty, 0) - leg.filled) <= EPSILON);
  const gross = fills.reduce((sum, item) => sum + (item.side === 'Sell' ? 1 : -1) * item.execPrice * item.execQty, 0);
  const fee = fills.reduce((sum, item) => sum + item.execFee, 0);
  return { legs, completedLegs, totalLegs: legs.length, ratio, amountsComplete: covered && currencies.size <= 1, gross, fee, net: gross - fee, currency: [...currencies][0] ?? null };
}

const ORDER_STATE: Record<string, { label: string; tone: string }> = {
  filled: { label: '已全部成交', tone: 'filled' }, partial: { label: '部分成交 · 已结束', tone: 'warning' },
  timeout_cancelled: { label: '已撤单', tone: 'ended' }, not_submitted: { label: '未提交', tone: 'ended' },
};
/** The phase shown for one order, in the workbench's words. */
export function orderState(order: OrderRow, task: Pick<Task, 'status'> | undefined): { label: string; tone: string } {
  if (order.terminal) {
    if (order.status === 'timeout_cancelled' && Number(order.filledQty) > 0) return ORDER_STATE.partial!;
    return ORDER_STATE[order.status] ?? { label: '已结束', tone: 'ended' };
  }
  return task && isActive(task) && task.status !== 'recovery_needed' ? { label: '挂单中', tone: 'working' } : { label: '状态未知 · 待核对', tone: 'warning' };
}

/** A refusal of the start itself (bad body, plan gone or used, limits, a reused id): the request id was never accepted. */
export const startRefused = (error: unknown): boolean => {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 401 && status !== 403;
};

export const money = (value: number | null | undefined): string => value === null || value === undefined || !Number.isFinite(value) ? '—' : `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
export const signedMoney = (value: number | null | undefined, currency = 'USD'): string => value === null || value === undefined || !Number.isFinite(value) ? '待核对' : `${value >= 0 ? '+' : '−'}${Math.abs(value).toLocaleString('en-US', { maximumFractionDigits: 4 })} ${currency}`;
export const quantityText = (value: number | string): string => { const number = Number(value); return Number.isFinite(number) && number >= 0 ? number.toLocaleString('en-US', { maximumFractionDigits: 8 }) : '--'; };
export const utcTime = (value: number | null | undefined): string => value === null || value === undefined ? '--' : new Date(value).toISOString().slice(5, 19).replace('T', ' ');
export const utcDate = (value: number | null | undefined): string => value === null || value === undefined ? '--' : new Date(value).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', timeZone: 'UTC' });

const pad2 = (value: number): string => String(value).padStart(2, '0');
/** "周五 21:00 UTC" for the configured auto-open window. */
export const scheduleTime = (schedule: Pick<ScheduleView, 'hourUtc' | 'minuteUtc'>): string => `周五 ${pad2(schedule.hourUtc)}:${pad2(schedule.minuteUtc)} UTC`;

/** What turning auto-open on commits to, for the confirm() before the switch is sent. */
export function autoOpenConfirm(settings: OptionsState['settings'], schedule: ScheduleView): string {
  return [
    ...(schedule.waiting ? ['现在正处于本周的开仓窗口，本周还没开过：确认后约 5 秒内就会实盘开仓。'] : []),
    `打开后，每周${scheduleTime(schedule).slice(1)} 起 ${schedule.windowSeconds} 秒内，本服务每周最多自动实盘开仓一次：`,
    `${strategyName(settings.strategyMode)}，每腿 ${settings.legQty} BTC，最大亏损上限 ${money(settings.maxRiskUsd)}，保证金上限 ${money(settings.maxMarginUsd)}；最低净收入按当时方案的估算。`,
    schedule.marketFallback ? '超时未成交的开仓腿会按对手价补发一次 IOC，但价格仍受最低净收入限制，按估算的限制通常会把 IOC 拦下。' : '超时未成交的腿撤单后不补单（IOC 兜底未打开）。',
    '有未结束的任务、跟踪中的策略或超出上限时，窗口内每 5 秒重试；整个窗口都不满足则本周不开仓，窗口结束后发一次飞书提醒。关闭定时不会停止已受理的定时任务。确定打开定时开仓？',
  ].join('\n');
}
