// The options engine: plans, execution tasks, the order journal, the tracked strategy and reconciliation. Ported from the
// workbench (modules/greeks/app trade_tasks.py, engine.py, reconciliation.py, commit 160e932) without its demo mode or
// RFQ (docs/options.md §1); the Friday auto-open and the IOC fallback came in G2a, the fills ledger and the 收益 samples in G2b. One lock serializes plans, task runs and
// reconciliation as the workbench's engine lock does; a stop never waits for it. Every change to the state document is
// written before it is acted on, so a restart finds every order the service could have sent.
import { VenueError } from '../connector.ts';
import { ContractError } from '../contracts.ts';
import { add, cmp, decimal, isMultiple, isZero, min as minDecimal, sub } from '../decimal.ts';
import { describe } from '../live/values.ts';
import { parseExecution, parsePositions, pmMetrics, readAccountHealth, summarizeGreeks, type AccountHealth, type ExecutionRecord, type PmBaseline, type Position } from './account.ts';
import type { OptionsClient, Row } from './client.ts';
import { QUOTE_STALE_MS, isSunday, type ChainSnapshot, type OptionMarket, type OptionRow, type OptionType } from './market.ts';
import { followOrder, iocOrder, reconcileOrder, roundToTick, type OrderOutcome, type OrderStatus } from './orders.ts';
import { amountText, buildPerformance, exact, thinPoints, type PerformanceInput, type Sample } from './performance.ts';
import { RFQ_STATUS_NAMES, chainFor, counterpartiesFrom, filledOrders, isTerminal, observe, parseQuotes, parseRfqRow, quoteProblem, quoteView, rfqFinished, sortQuotes, strategyTypeFor, validRfq, type RfqObservation, type RfqQuote, type RfqRecord } from './rfq.ts';
import type { OptionsStore } from './store.ts';
import { StrategyError, buildStrategy, maximumLoss, reserveShortMargin, validateStructure, type Estimates, type MarginContext, type Preview, type RiskLeg, type Side, type StrategyMode } from './strategy.ts';

export const PLAN_TTL_MS = 30_000;
export const POLL_MS = 1_000;
export const SAMPLE_MS = 3_000;
/** Bybit's receive window is 5 s; two minutes leaves room for clock skew and a slow answer. */
export const MISSING_SETTLE_MS = 120_000;
/** Past this age "not found" proves nothing (order history is read for the last 7 days by default): it stays unknown. */
export const MISSING_SETTLE_MAX_AGE_MS = 6 * 24 * 3_600_000;
/** How often the scheduler looks at the Friday window (the workbench's scheduler loop). */
export const SCHEDULE_TICK_MS = 5_000;
/** The workbench's failed_leg_retry_delay_seconds before an IOC fallback. */
export const FALLBACK_DELAY_MS = 800;
const HISTORY_LIMIT_MS = 180 * 86_400_000;
const RETIRE_BUDGET_MS = 120_000;
const READ_MS = 25_000;
/** A filled RFQ is tracked from its saved structure once its trade list has not matched for this long (G2c). */
const RFQ_TRADE_WAIT_MS = 120_000;
const EXECUTIONS_KEPT = 100;
const EPSILON = 1e-9;
/** 收益 (G2b): one sample a minute per holding (the workbench's default), only on positions read within the last minute. */
export const PERFORMANCE_SAMPLE_MS = 60_000;
const POSITIONS_FRESH_MS = 60_000;
/** A gap longer than three intervals breaks the line. */
const SAMPLE_GAP_MS = 3 * PERFORMANCE_SAMPLE_MS;
/** Orders whose recorded fill the ledger lacks, read again per round; each at most every 5 min, within Bybit's 7 days. */
const BACKFILL_PER_ROUND = 10;
const BACKFILL_RETRY_MS = 5 * 60_000;
const BACKFILL_WINDOW_MS = 7 * 86_400_000;
const GROUP_POINTS = 300;
const SERIES_POINTS = 1_500;
/** The closed-position amounts kept with the retirement evidence for the 收益 page (G2b). */
const EVIDENCE_AMOUNTS = ['totalPnl', 'totalOpenFee', 'totalCloseFee', 'deliveryFee', 'avgEntryPrice'] as const;

export type TaskStatus = 'accepted' | 'running' | 'stopping' | 'recovering' | 'recovery_needed' | 'completed' | 'partial' | 'stopped' | 'failed';
export const ACTIVE_STATUSES: readonly TaskStatus[] = ['accepted', 'running', 'stopping', 'recovering', 'recovery_needed'];
const isActive = (status: TaskStatus): boolean => ACTIVE_STATUSES.includes(status);
export type Operation = 'open' | 'close';

export interface PlanLeg { symbol: string; side: Side; qty: string; expiry: number; strike: number; optionType: OptionType; referencePrice: number }
interface NetLeg extends PlanLeg { priceBound: number; feePriceCeiling?: number }
export interface FeeContext { index: number; feeRate: number; feeCapPct: number }
export interface Plan {
  planId: string; operation: Operation; mode: StrategyMode; createdAt: number; expiresAt: number; legs: PlanLeg[];
  estimatedGrossUsd: number; estimatedFeeUsd: number; estimatedNetUsd: number; estimatedMarginUsd: number; unboundedLoss: boolean;
  minNetIncomeUsd: number | null; maxNetCostUsd: number | null;
}
interface SavedPlan { plan: Plan; feeContext: FeeContext; closeFingerprint: string | null; instrumentFingerprint: string }

export interface Task {
  id: string; type: Operation; status: TaskStatus; planId: string; requestId: string; fingerprint: string;
  acceptedAt: number; startedAt: number | null; finishedAt: number | null; stopRequested: boolean; stopRequestedAt: number | null;
  mode: StrategyMode; legs: Record<string, PlanLeg & { chainPrice: number }>; links: string[];
  netLegs: Record<string, NetLeg>; feeContext: FeeContext; minNetIncomeUsd: number | null; maxNetCostUsd: number | null;
  netBlocked: boolean; reserved: { grossUsd: number; feeUsd: number; netUsd: number } | null;
  risk: { legs: Record<string, RiskLeg>; context: MarginContext; budgetUsd: number; reservedUsd: number } | null; riskBlocked: boolean;
  openingGroup: string | null; strategyStatus: 'open' | 'closed' | null; closedAt: number | null; closeReason: string | null;
  closureEvidence: Record<string, Row[]>; error: string | null; notified: string[];
  /** Admitted by the Friday scheduler: it dispatches only inside the opening window. */
  scheduled?: boolean;
  /** An opening filled through 组合询价 (G2c): the RFQ and the market maker's quote. */
  rfq?: { rfqId: string; quoteId: string; deskCode: string };
}
export interface JournalEntry {
  taskId: string; symbol: string; side: Side; qty: string; reduceOnly: boolean; tick: string;
  status: OrderStatus; terminal: boolean; filledQty: string; orderId: string; createdAt: number; updatedAt: number; message?: string; price?: string;
  /** An IOC fallback for a leg's remainder, or a leg of a filled RFQ (G2c, read by orderId); absent for the book-following order. */
  kind?: 'ioc' | 'rfq';
}
/**
 * The Friday auto-open: enabled is the page's switch (null: config.json decides); lastOpenWeek the ISO week a scheduled
 * opening was admitted in (once per week); attemptWeek / lastError the last refused attempt, notifiedWeek the week whose
 * missed opening was sent to Feishu.
 */
export interface Schedule { enabled: boolean | null; /** When the page last turned it on (null: config or off). */ enabledAt: number | null; lastOpenWeek: string | null; attemptWeek: string | null; lastError: string | null; lastAttemptAt: number | null; notifiedWeek: string | null }
export interface OptionsState {
  uid: string; tasks: Record<string, Task>; journal: Record<string, JournalEntry>;
  tracked: { groupId: string | null; sizes: Record<string, string> }; pmBaseline: PmBaseline | null; executions: ExecutionRecord[];
  /** Added in v0.13 (G2a); a document without it starts with the defaults. */
  schedule: Schedule;
  /** 组合询价 (G2c, v0.17): the latest RFQ; null or absent when there has been none. */
  rfq: RfqRecord | null;
}

export interface AutoOpenSettings { enabled: boolean; hourUtc: number; minuteUtc: number; windowSeconds: number }
/** The workbench's defaults: off, Friday 21:00 UTC, a 60 s window. */
export const DEFAULT_AUTO_OPEN: AutoOpenSettings = { enabled: false, hourUtc: 21, minuteUtc: 0, windowSeconds: 60 };
export interface EngineSettings {
  maxRiskUsd: number; maxMarginUsd: number; legQty: string; strategyMode: StrategyMode; orderTimeoutMs: number; estimates: Estimates;
  /** config.json's auto-open (the page's switch overrides enabled); absent: DEFAULT_AUTO_OPEN. */
  autoOpen?: AutoOpenSettings;
  /** The workbench's allow_market_fallback: an opening leg's timed-out remainder gets one bounded IOC. Off by default. */
  marketFallback?: boolean;
}
export interface EngineOptions {
  client: OptionsClient; market: OptionMarket; store: OptionsStore; uid: string; settings: EngineSettings;
  now?: () => number; log?: (line: string) => void; notify?: (text: string) => void;
  sleep?: (ms: number) => Promise<void>; pollMs?: number; sampleMs?: number; newId?: () => string;
  /** How long after its create an order with no id that Bybit does not know settles as not submitted (reconcileOrder). */
  missingSettleMs?: number;
}
export interface PlanRequest { operation: Operation; quantity?: string; mode?: StrategyMode }
export interface TaskRequest { planId: string; requestId: string; confirmLive: boolean; minNetIncomeUsd?: number; maxNetCostUsd?: number }

const conflict = (code: string, message: string): never => { throw new ContractError(409, code, message); };
const invalid = (code: string, message: string): never => { throw new ContractError(400, code, message); };
class StopRequested extends Error { constructor() { super('已请求停止，不再下单或改价'); } }
const opposite = (side: Side): Side => side === 'Buy' ? 'Sell' : 'Buy';
const OPERATION_NAMES: Record<Operation, string> = { open: '开仓', close: '平仓' };
export const STATUS_NAMES: Record<TaskStatus, string> = {
  accepted: '已确认', running: '执行中', stopping: '停止中', recovering: '恢复中', recovery_needed: '需人工核对',
  completed: '已完成', partial: '部分成交', stopped: '已停止', failed: '失败',
};
const sortedJson = (value: unknown): string => JSON.stringify(value);
const legIdentity = (legs: readonly PlanLeg[]): string => sortedJson(legs.map(leg => [leg.symbol, leg.side, leg.qty, leg.expiry, leg.strike, leg.optionType]).sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1]))));

const emptySchedule = (): Schedule => ({ enabled: null, enabledAt: null, lastOpenWeek: null, attemptWeek: null, lastError: null, lastAttemptAt: null, notifiedWeek: null });

/** The ISO 8601 week of a UTC time, as the workbench's strftime("%G-W%V"). */
export function isoWeek(ms: number): string {
  const date = new Date(ms);
  const thursday = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const year = new Date(thursday).getUTCFullYear();
  return `${year}-W${String(Math.floor((thursday - Date.UTC(year, 0, 1)) / 86_400_000 / 7) + 1).padStart(2, '0')}`;
}

/** Restores the saved document; a missing one starts empty, another account's refuses start. */
function restore(raw: unknown, uid: string): OptionsState {
  if (raw === null) return { uid, tasks: {}, journal: {}, tracked: { groupId: null, sizes: {} }, pmBaseline: null, executions: [], schedule: emptySchedule(), rfq: null };
  const value = raw as Partial<OptionsState>;
  const record = (item: unknown) => typeof item === 'object' && item !== null && !Array.isArray(item);
  if (!record(value) || typeof value.uid !== 'string' || !record(value.tasks) || !record(value.journal) || !record(value.tracked) || !record(value.tracked!.sizes) || !Array.isArray(value.executions)) throw new Error('期权状态库内容不完整');
  if (value.uid !== uid) throw new Error(`期权状态库属于另一个 Bybit 账户（***${value.uid.slice(-4)}），拒绝启动`);
  if (value.schedule === undefined) value.schedule = emptySchedule();
  else {
    if (!record(value.schedule)) throw new Error('期权状态库的定时开仓记录不完整');
    const schedule = { ...emptySchedule(), ...value.schedule } as Record<string, unknown>;
    const text = (key: string) => schedule[key] === null || typeof schedule[key] === 'string';
    const time = (key: string) => schedule[key] === null || Number.isFinite(schedule[key]);
    if (![null, true, false].includes(schedule.enabled as boolean | null) || !['lastOpenWeek', 'attemptWeek', 'lastError', 'notifiedWeek'].every(text) || !['enabledAt', 'lastAttemptAt'].every(time)) throw new Error('期权状态库的定时开仓记录不完整');
    value.schedule = schedule as unknown as Schedule;
  }
  if (value.rfq === undefined) value.rfq = null;
  else if (value.rfq !== null && !validRfq(value.rfq)) throw new Error('期权状态库的询价记录不完整');
  return value as OptionsState;
}

export function createOptionsEngine({ client, market, store, uid, settings, now = Date.now, log = () => undefined, notify = () => undefined, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), pollMs = POLL_MS, sampleMs = SAMPLE_MS, newId = () => crypto.randomUUID().replaceAll('-', ''), missingSettleMs = MISSING_SETTLE_MS }: EngineOptions) {
  const state = restore(store.load(), uid);
  const plans = new Map<string, SavedPlan>();
  const workers = new Map<string, Promise<void>>();
  const wakers = new Map<string, Set<() => void>>();
  let positions: { rows: Position[]; at: number } | null = null;
  let positionsError: string | null = null;
  let health: AccountHealth | null = null;
  let reconciliation: { error: string | null; lastSuccessAt: number | null } = { error: null, lastSuccessAt: null };
  let admitting = false, held = false, shutdown = false;
  let tail: Promise<void> = Promise.resolve();

  const save = () => store.save(state);
  // The fills ledger and the samples (G2b) live in their own tables; v0.14's first start copies in the recent fills.
  const ledger = new Map(store.executions().map(record => [record.execId, record]));
  const unarchived = state.executions.filter(record => !ledger.has(record.execId));
  if (unarchived.length) { store.saveExecutions(unarchived); for (const record of unarchived) ledger.set(record.execId, record); }
  const samples = store.samples();
  const backfillAt = new Map<string, number>();
  let performanceError: string | null = null;
  const autoOpen = settings.autoOpen ?? DEFAULT_AUTO_OPEN;
  const autoOpenEnabled = (): boolean => state.schedule.enabled ?? autoOpen.enabled;
  /** This day's opening time; the window is [start, start + windowSeconds) on a Friday (UTC) and never runs past midnight. */
  const windowStart = (at: number): number => { const day = new Date(at); return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), autoOpen.hourUtc, autoOpen.minuteUtc); };
  const inOpenWindow = (at = now()): boolean => new Date(at).getUTCDay() === 5 && at - windowStart(at) >= 0 && at - windowStart(at) < autoOpen.windowSeconds * 1000;
  /** The next window start this week's opening has not used yet. */
  function nextOpenAt(at = now()): number {
    const day = new Date(at), friday = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + ((5 - day.getUTCDay() + 7) % 7), autoOpen.hourUtc, autoOpen.minuteUtc);
    const used = state.schedule.lastOpenWeek === isoWeek(friday) || at >= friday + autoOpen.windowSeconds * 1000;
    return used ? friday + 7 * 86_400_000 : friday;
  }
  /** The latest Friday window that has started by `at`, and when it ends (never past that midnight). */
  function lastWindow(at = now()): { start: number; end: number } {
    const day = new Date(at), back = (day.getUTCDay() + 2) % 7;
    let start = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() - back, autoOpen.hourUtc, autoOpen.minuteUtc);
    if (start > at) start -= 7 * 86_400_000;
    const friday = new Date(start), midnight = Date.UTC(friday.getUTCFullYear(), friday.getUTCMonth(), friday.getUTCDate() + 1);
    return { start, end: Math.min(start + autoOpen.windowSeconds * 1000, midnight) };
  }
  // A state that never ran the scheduler (a first deploy with config.json's autoOpen on) owes no reminder for a window
  // that had already ended before it existed; a window still open at start is reminded as usual.
  if (state.schedule.enabled === null && autoOpen.enabled && state.schedule.lastOpenWeek === null && state.schedule.attemptWeek === null && state.schedule.notifiedWeek === null) {
    const passed = lastWindow();
    if (now() >= passed.end) state.schedule.notifiedWeek = isoWeek(passed.start);
  }
  if (state.schedule.enabled === true) log(`期权定时开仓按页面设置打开（周五 ${String(autoOpen.hourUtc).padStart(2, '0')}:${String(autoOpen.minuteUtc).padStart(2, '0')} UTC）`);

  // A restart cannot know where a task stopped: it is stopped, and reconciliation cancels and reads back its orders.
  let restarted = false;
  for (const task of Object.values(state.tasks)) {
    if (!isActive(task.status)) continue;
    Object.assign(task, { status: 'recovering', stopRequested: true, stopRequestedAt: task.stopRequestedAt ?? now() });
    restarted = true;
  }
  if (restarted) save();

  async function locked<T>(work: () => Promise<T>): Promise<T> {
    const previous = tail;
    let release!: () => void;
    tail = new Promise(resolve => { release = resolve; });
    await previous;
    held = true;
    try { return await work(); } finally { held = false; release(); }
  }

  // ---- admission ------------------------------------------------------------------------------------------------
  /** rfq: false only for the RFQ's own execute and cancel, which act on the unfinished RFQ itself. */
  function requireIdle(rfq = true): void {
    if (shutdown) conflict('shutting_down', '服务正在停止');
    if (Object.values(state.journal).some(entry => !entry.terminal)) conflict('orders_unresolved', '仍有未确认的期权订单，等对账核对后再交易');
    if (admitting || held || Object.values(state.tasks).some(task => isActive(task.status))) conflict('operation_active', '另一个期权交易操作正在进行或等待核对');
    if (rfq && !rfqFinished(state.rfq)) conflict('rfq_active', '还有未结束的组合询价（等待报价、执行或核对中），等它成交、取消或过期后再交易');
  }
  async function admitted<T>(work: () => Promise<T>, rfq = true): Promise<T> {
    requireIdle(rfq);
    // No await separates the check from this claim.
    admitting = true;
    try { return await locked(work); } finally { admitting = false; }
  }

  // ---- market checks ---------------------------------------------------------------------------------------------
  function freshSnapshot(): ChainSnapshot {
    const snapshot = market.snapshot();
    const age = snapshot ? now() - snapshot.at : Infinity;
    if (!snapshot || age < 0 || age > QUOTE_STALE_MS) return conflict('market_stale', 'Bybit 期权行情已过期，请稍后重试');
    return snapshot;
  }
  const rowOf = (symbol: string): OptionRow | undefined => market.snapshot()?.rows.find(row => row.symbol === symbol);

  function validateQuantity(row: OptionRow, qty: string): void {
    let value: string;
    try { value = decimal(qty, 'positive'); } catch { return invalid('quantity', '数量无效'); }
    if (cmp(value, row.minQty) < 0 || cmp(value, row.maxQty) > 0) invalid('quantity', `${row.symbol} 数量须在 ${row.minQty} 到 ${row.maxQty} 之间`);
    if (!isMultiple(sub(value, row.minQty), row.qtyStep)) invalid('quantity', `${row.symbol} 数量 ${value} 不符合步长 ${row.qtyStep}`);
  }

  /** A leg priced passively (bid for a buy, ask for a sell), rounded half up to the tick; both sides of the book must exist. */
  function planLeg(symbol: string, side: Side, qty: string): PlanLeg {
    const row = rowOf(symbol);
    if (!row) return conflict('instrument_gone', `合约 ${symbol} 已不在期权链里`);
    validateQuantity(row, qty);
    if (!(row.bid > 0) || !(row.ask > 0)) return conflict('no_book', `${symbol} 没有可成交的买一 / 卖一`);
    const price = roundToTick(side === 'Buy' ? row.bid : row.ask, row.tick);
    if (price === null) return conflict('no_book', `${symbol} 盘口价低于最小价格步长`);
    return { symbol, side, qty: decimal(qty), expiry: row.expiry, strike: row.strike, optionType: row.optionType, referencePrice: Number(price) };
  }

  function instrumentFingerprint(legs: readonly PlanLeg[]): string {
    return sortedJson(legs.map(leg => {
      const row = rowOf(leg.symbol);
      if (!row) return conflict('instrument_gone', '已确认的合约不在期权链里了');
      return [row.symbol, row.expiry, row.strike, row.optionType, row.minQty, row.maxQty, row.qtyStep, row.tick];
    }));
  }
  function validatePlan(saved: SavedPlan): void {
    if (now() >= saved.plan.expiresAt) conflict('plan_expired', '交易计划已过期，请重新生成');
    if (instrumentFingerprint(saved.plan.legs) !== saved.instrumentFingerprint) conflict('instrument_changed', '已确认合约的参数变了，请重新生成计划');
  }

  function feeContext(): FeeContext {
    const index = market.snapshot()?.index ?? 0;
    if (!(index > 0)) return conflict('no_index', '手续费估算需要当前 BTC 指数');
    return { index, feeRate: settings.estimates.feeRate, feeCapPct: settings.estimates.feeCapPct };
  }
  function netEstimate(legs: Record<string, NetLeg>, context: FeeContext) {
    const values = Object.values(legs);
    const gross = values.reduce((sum, leg) => sum + (leg.side === 'Sell' ? 1 : -1) * leg.priceBound * Number(leg.qty), 0);
    const fee = values.reduce((sum, leg) => sum + Math.min(context.feeRate * context.index, context.feeCapPct * (leg.feePriceCeiling ?? leg.priceBound)) * Number(leg.qty), 0);
    if (![gross, fee, gross - fee].every(Number.isFinite)) throw new Error('组合净价无法计算');
    return { gross, fee, net: gross - fee };
  }
  const marginContext = (): MarginContext => ({ ...settings.estimates, index: market.snapshot()?.index ?? 0 });

  /** A Friday (UTC) entry into this week's Sunday expiry. */
  function validateCalendar(expiry: number): void {
    const today = new Date(now());
    if (today.getUTCDay() !== 5) conflict('calendar', '实盘开仓只允许在周五（UTC）');
    if (!isSunday(expiry)) conflict('calendar', '各腿须在周日（UTC）到期');
    const sunday = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 2));
    if (new Date(expiry).toISOString().slice(0, 10) !== sunday.toISOString().slice(0, 10)) conflict('calendar', `到期日须是本周日 ${sunday.toISOString().slice(0, 10)}（UTC）`);
  }

  function preview(quantity: string, mode: StrategyMode, snapshot = market.snapshot()): Preview {
    if (!snapshot) return conflict('market_unavailable', '还没有期权行情');
    try { return buildStrategy(snapshot.rows, { now: now(), qty: quantity, mode, index: snapshot.index, estimates: settings.estimates, marketAt: snapshot.at }); }
    catch (error) { if (error instanceof StrategyError) return conflict(error.code, error.message); throw error; }
  }

  function initialRisk(view: Preview): NonNullable<Task['risk']> {
    const legs: Record<string, RiskLeg> = {};
    for (const leg of view.legs) {
      const row = rowOf(leg.symbol);
      if (!row || row.expiry !== view.expiry || row.strike !== leg.strike || row.optionType !== leg.optionType) conflict('instrument_changed', '策略腿与行情里的合约不一致了');
      legs[leg.symbol] = { side: leg.side, optionType: leg.optionType, strike: leg.strike, qty: Number(leg.qty), expiry: row!.expiry, mark: row!.mark, priceBound: (leg.side === 'Buy' ? row!.bid : row!.ask) || row!.mark };
    }
    if (Object.keys(legs).length !== view.legs.length) conflict('structure', '策略里有重复的合约');
    const context = marginContext();
    try {
      validateStructure(legs, view.mode);
      if (view.mode === 'short_strangle') {
        const reserved = reserveShortMargin(legs, context);
        if (reserved.total > settings.maxMarginUsd) conflict('risk_limit', `按当前盘口价，卖出宽跨保证金 ${reserved.total.toFixed(2)} 超过上限 ${settings.maxMarginUsd}`);
        return { legs: reserved.legs, context, budgetUsd: settings.maxMarginUsd, reservedUsd: reserved.total };
      }
      const loss = maximumLoss(legs);
      if (loss > settings.maxRiskUsd) conflict('risk_limit', `按当前盘口价，组合最大亏损 ${loss.toFixed(2)} 超过上限 ${settings.maxRiskUsd}`);
      return { legs, context, budgetUsd: settings.maxRiskUsd, reservedUsd: loss };
    } catch (error) { if (error instanceof StrategyError) return conflict(error.code, error.message); throw error; }
  }

  /** The preview's risk against the configured limits; null when it passes. */
  function riskProblem(view: Preview): string | null {
    try {
      if (new Set(view.legs.map(leg => leg.symbol)).size !== view.legs.length) return '策略里有重复的合约';
      if (view.mode === 'short_strangle') {
        if (!view.unboundedLoss || view.maxLossUsd !== null) return '卖出宽跨须标为亏损无上限';
        if (!Number.isFinite(view.estimatedMarginUsd) || view.estimatedMarginUsd < 0 || view.estimatedMarginUsd > settings.maxMarginUsd) return `保证金估算 ${view.estimatedMarginUsd.toFixed(2)} 超过上限 ${settings.maxMarginUsd}，请减少数量或调高 maxMarginUsd`;
        initialRisk(view);
        return null;
      }
      const values = [view.maxLossUsd, view.estimatedMarginUsd];
      if (view.unboundedLoss || values.some(value => value === null || !Number.isFinite(value) || value < 0 || value > settings.maxRiskUsd)) return `最大亏损或保证金估算超过上限 ${settings.maxRiskUsd}，请减少数量或调高 maxRiskUsd`;
      return null;
    } catch (error) { return error instanceof Error ? error.message : String(error); }
  }
  function validateRisk(view: Preview): void {
    const problem = riskProblem(view);
    if (problem) conflict('risk_limit', problem);
  }

  // ---- tracked strategy ------------------------------------------------------------------------------------------
  const trackedSymbols = (): Set<string> => new Set(Object.keys(state.tracked.sizes).map(key => key.slice(0, key.lastIndexOf('|'))));

  async function syncPositions(): Promise<Position[]> {
    const rows = parsePositions(await client.positions(AbortSignal.timeout(READ_MS)));
    positions = { rows, at: now() };
    positionsError = null;
    try { await retireClosedPositions(rows); }
    catch (error) { positionsError = describe(error); log(`期权持仓核对未完成：${positionsError}`); }
    return positions.rows;
  }

  /**
   * A tracked leg the account no longer holds is retired only on closing evidence: the venue's closed-position history
   * since the opening covers at least the tracked (and opened) quantity, and a second position read still lacks it.
   */
  async function retireClosedPositions(current: Position[]): Promise<void> {
    if (!Object.keys(state.tracked.sizes).length || Object.values(state.journal).some(entry => !entry.terminal)) return;
    const groupId = state.tracked.groupId;
    const group = groupId ? state.tasks[groupId] : undefined;
    const present = new Set(current.map(position => `${position.symbol}|${position.side}`));
    const absent = Object.entries(state.tracked.sizes).filter(([key]) => !present.has(key));
    if (!absent.length) return;
    if (!group) throw new Error('跟踪策略没有开仓任务，无法用历史核对');
    const since = group.acceptedAt, end = now();
    if (!(end - since >= 0 && end - since <= HISTORY_LIMIT_MS)) throw new Error('开仓时间超出可核对的平仓历史范围（180 天）');
    const signal = AbortSignal.timeout(RETIRE_BUDGET_MS);
    const evidence = new Map<string, Row[]>();
    for (const [key, qty] of absent) {
      const [symbol, side] = [key.slice(0, key.lastIndexOf('|')), key.slice(key.lastIndexOf('|') + 1)];
      const opened = Object.values(state.journal).filter(entry => entry.taskId === groupId && entry.symbol === symbol && entry.side === side && !entry.reduceOnly).reduce((sum, entry) => add(sum, entry.filledQty), '0');
      const required = Math.max(Number(qty), Number(opened));
      const seen = new Set<string>(), matched: Row[] = [];
      let total = 0;
      for (const row of await client.closedPositions(symbol, since, end, signal)) {
        if (row.symbol !== symbol || row.side !== side) continue;
        const openTime = Number(row.openTime), closeTime = Number(row.closeTime), amount = Number(row.qty);
        if (![openTime, closeTime, amount].every(Number.isFinite) || amount <= 0) throw new Error('平仓历史的数量或时间无效');
        const identity = `${openTime}|${closeTime}`;
        if (seen.has(identity) || !(since <= openTime && openTime <= closeTime && closeTime <= end)) continue;
        seen.add(identity);
        matched.push({ symbol, side, qty: row.qty, openTime: row.openTime, closeTime: row.closeTime, ...Object.fromEntries(EVIDENCE_AMOUNTS.filter(key => row[key] !== undefined).map(key => [key, row[key]])) });
        total += amount;
      }
      if (total + EPSILON >= required) evidence.set(key, matched);
    }
    if (!evidence.size) throw new Error('持仓里已看不到跟踪腿，但平仓历史还没有对应记录');
    // A delayed or transient empty list alone must never retire a strategy.
    const confirmed = parsePositions(await client.positions(AbortSignal.timeout(READ_MS)));
    positions = { rows: confirmed, at: now() };
    const still = new Set(confirmed.map(position => `${position.symbol}|${position.side}`));
    const retired = [...evidence].filter(([key]) => !still.has(key));
    for (const [key, rows] of retired) {
      delete state.tracked.sizes[key];
      group.closureEvidence[key] = rows;
    }
    if (retired.length) {
      if (!Object.keys(state.tracked.sizes).length) {
        Object.assign(group, { strategyStatus: 'closed', closedAt: end, closeReason: 'exchange_closed_position_history' });
        state.tracked.groupId = null;
        state.pmBaseline = null;
      }
      save();
      log(`期权跟踪策略：按交易所平仓历史退役 ${retired.length} 条腿`);
    }
    if (absent.some(([key]) => !evidence.has(key) && !still.has(key))) throw new Error('部分已不在持仓里的跟踪腿还没有平仓历史');
  }

  async function closeSnapshot(): Promise<{ legs: PlanLeg[]; mode: StrategyMode; fingerprint: string }> {
    const current = await syncPositions();
    const sizes = { ...state.tracked.sizes }, symbols = trackedSymbols();
    const legs: PlanLeg[] = [], exchange: [string, string, string][] = [];
    for (const position of current) {
      if (!symbols.has(position.symbol)) continue;
      const tracked = sizes[`${position.symbol}|${position.side}`] ?? '0';
      const qty = minDecimal(position.size, tracked);
      if (cmp(qty, '0') <= 0) continue;
      legs.push(planLeg(position.symbol, opposite(position.side), qty));
      exchange.push([position.symbol, position.side, position.size]);
    }
    if (!legs.length) return conflict('nothing_to_close', '没有可平的跟踪策略腿');
    const mode = (state.tracked.groupId ? state.tasks[state.tracked.groupId]?.mode : undefined) ?? 'iron_condor';
    if (legs.length > (mode === 'iron_condor' ? 4 : 2)) conflict('structure', '跟踪策略的腿数超过策略结构');
    const fingerprint = sortedJson({ openingGroup: state.tracked.groupId, tracked: Object.entries(sizes).sort(), exchange: exchange.sort() });
    return { legs, mode, fingerprint };
  }

  // ---- plans and tasks -------------------------------------------------------------------------------------------
  async function createPlan(request: PlanRequest): Promise<Plan> {
    return admitted(async () => {
      let legs: PlanLeg[], mode: StrategyMode, margin = 0, unbounded: boolean, closeFingerprint: string | null = null;
      if (request.operation === 'open') {
        if (Object.keys(state.tracked.sizes).length) await syncPositions();
        if (Object.keys(state.tracked.sizes).length) conflict('strategy_open', '先平掉跟踪中的策略再开新仓');
        await market.refresh();
        const view = preview(request.quantity ?? settings.legQty, request.mode ?? settings.strategyMode);
        validateRisk(view);
        legs = view.legs.map(leg => planLeg(leg.symbol, leg.side, leg.qty));
        validateCalendar(view.expiry);
        if (legs.some(leg => leg.expiry !== view.expiry)) conflict('instrument_changed', '预览的到期日与合约不一致了');
        ({ mode, estimatedMarginUsd: margin, unboundedLoss: unbounded } = view);
      } else {
        await market.refresh();
        ({ legs, mode, fingerprint: closeFingerprint } = await closeSnapshot());
        unbounded = mode === 'short_strangle';
      }
      freshSnapshot();
      const context = feeContext();
      const bounds = Object.fromEntries(legs.map(leg => [leg.symbol, { ...leg, priceBound: leg.referencePrice }]));
      const { gross, fee, net } = netEstimate(bounds, context);
      const created = now();
      const plan: Plan = {
        planId: newId(), operation: request.operation, mode, createdAt: created, expiresAt: created + PLAN_TTL_MS, legs,
        estimatedGrossUsd: gross, estimatedFeeUsd: fee, estimatedNetUsd: net, estimatedMarginUsd: margin, unboundedLoss: unbounded,
        minNetIncomeUsd: request.operation === 'open' ? net : null, maxNetCostUsd: request.operation === 'close' ? -net : null,
      };
      for (const [id, saved] of plans) if (saved.plan.expiresAt <= created) plans.delete(id);
      plans.set(plan.planId, { plan: structuredClone(plan), feeContext: context, closeFingerprint, instrumentFingerprint: instrumentFingerprint(legs) });
      return plan;
    });
  }

  const taskResponse = (task: Task) => ({ taskId: task.id, status: task.status, operation: task.type, planId: task.planId });

  async function startTask(request: TaskRequest, { scheduled = false }: { scheduled?: boolean } = {}) {
    const fingerprint = sortedJson([request.planId, request.requestId, request.confirmLive, request.minNetIncomeUsd ?? null, request.maxNetCostUsd ?? null]);
    for (const task of Object.values(state.tasks)) {
      if (task.requestId !== request.requestId) continue;
      if (task.fingerprint !== fingerprint) conflict('request_reused', '这个请求编号已用于不同的参数');
      return taskResponse(task);
    }
    if (Object.values(state.tasks).some(task => task.planId === request.planId)) conflict('plan_used', '这个计划已经执行过，请用原请求编号重试');
    if (request.confirmLive !== true) invalid('confirm_required', '下实盘订单需要明确确认');
    return admitted(async () => {
      const saved = plans.get(request.planId);
      if (!saved) return conflict('plan_missing', '交易计划不存在或已过期，请重新生成');
      validatePlan(saved);
      const plan = saved.plan;
      if ((plan.operation === 'open' && request.maxNetCostUsd !== undefined) || (plan.operation === 'close' && request.minNetIncomeUsd !== undefined)) invalid('net_limit_mismatch', '净价限制与计划方向不符');
      let risk: Task['risk'] = null;
      if (plan.operation === 'open') {
        if (Object.keys(state.tracked.sizes).length) await syncPositions();
        if (Object.keys(state.tracked.sizes).length) conflict('strategy_open', '跟踪持仓变了，请重新生成计划');
        await market.refresh();
        let view: Preview;
        try { view = preview(plan.legs[0]!.qty, plan.mode); } catch { return conflict('strategy_changed', '已确认的策略已不可用，请重新生成计划'); }
        validatePlan(saved);
        if (view.mode !== plan.mode || legIdentity(view.legs.map(leg => planLeg(leg.symbol, leg.side, leg.qty))) !== legIdentity(plan.legs)) conflict('strategy_changed', '选中的合约变了，请重新生成并确认计划');
        validateRisk(view);
        validateCalendar(view.expiry);
        await capturePmBaseline('manual_open');
        validatePlan(saved);
        risk = initialRisk(view);
      } else {
        await market.refresh();
        validatePlan(saved);
        let snapshot: Awaited<ReturnType<typeof closeSnapshot>>;
        try { snapshot = await closeSnapshot(); } catch { return conflict('position_changed', '跟踪平仓持仓变了，请重新生成计划'); }
        if (snapshot.mode !== plan.mode || snapshot.fingerprint !== saved.closeFingerprint || legIdentity(snapshot.legs) !== legIdentity(plan.legs)) conflict('position_changed', '跟踪或交易所持仓数量变了，请重新生成平仓计划');
      }
      // The refreshes above may have used the plan's time or changed the chain: check again after the last await.
      validatePlan(saved);
      if (plan.operation === 'open') {
        let final: string;
        try { final = legIdentity(preview(plan.legs[0]!.qty, plan.mode).legs.map(leg => planLeg(leg.symbol, leg.side, leg.qty))); }
        catch { return conflict('strategy_changed', '已确认的策略已不可用，请重新生成计划'); }
        if (final !== legIdentity(plan.legs)) conflict('strategy_changed', '选中的合约变了，请重新生成并确认计划');
      }
      for (const leg of plan.legs) if (legIdentity([planLeg(leg.symbol, leg.side, leg.qty)]) !== legIdentity([leg])) conflict('instrument_changed', '已确认合约的参数变了，请重新生成计划');
      if (scheduled && (shutdown || plan.operation !== 'open' || !inOpenWindow())) conflict('window_closed', shutdown ? '服务正在停止，本次定时开仓不受理' : '定时开仓窗口已结束');
      freshSnapshot();
      const id = newId().slice(0, 16), accepted = now();
      const task: Task = {
        id, type: plan.operation, status: 'accepted', planId: plan.planId, requestId: request.requestId, fingerprint,
        acceptedAt: accepted, startedAt: null, finishedAt: null, stopRequested: false, stopRequestedAt: null, mode: plan.mode,
        legs: Object.fromEntries(plan.legs.map(leg => [leg.symbol, { ...leg, chainPrice: leg.referencePrice }])),
        // Not the workbench's ic- prefix: its recovery after a roll-back must not take these fills for its own.
        links: plan.legs.map((_, index) => `tpo-${plan.operation === 'close' ? 'close-' : ''}${id}-${index}`),
        netLegs: Object.fromEntries(plan.legs.map(leg => [leg.symbol, { ...leg, priceBound: leg.referencePrice }])), feeContext: saved.feeContext,
        minNetIncomeUsd: plan.operation === 'open' ? request.minNetIncomeUsd ?? plan.minNetIncomeUsd : null,
        maxNetCostUsd: plan.operation === 'close' ? request.maxNetCostUsd ?? plan.maxNetCostUsd : null,
        netBlocked: false, reserved: null, risk, riskBlocked: false,
        openingGroup: plan.operation === 'close' ? state.tracked.groupId : null, strategyStatus: plan.operation === 'open' ? 'open' : null,
        closedAt: null, closeReason: null, closureEvidence: {}, error: null, notified: [],
        ...(scheduled ? { scheduled: true } : {}),
      };
      state.tasks[id] = task;
      // The week is used in the same write that admits the task: a restart never opens twice in one week.
      if (scheduled) Object.assign(state.schedule, { lastOpenWeek: isoWeek(accepted), lastError: null });
      save(); // Durable admission precedes dispatch.
      announce(task);
      const worker = locked(() => runTask(id)).finally(() => workers.delete(id));
      workers.set(id, worker);
      return taskResponse(task);
    });
  }

  // ---- 组合询价 RFQ (G2c) ------------------------------------------------------------------------------------------
  // One RFQ at a time, opening only. Every write (create, execute, cancel) is saved as "unknown" before it is sent, so a
  // restart or a lost answer leaves trading blocked until the 3 s tick reads the outcome back. A filled RFQ becomes an
  // opening task with one journal entry per leg, so tracking, closing, retirement and 收益 treat it as any other opening.
  /** Bumped by every local write to the RFQ: a tick whose reads started before one discards what it read. */
  let rfqVersion = 0, rfqTicking = false;
  let rfqQuotes: { rfqId: string; quotes: RfqQuote[]; at: number } | null = null;
  let rfqReadError: string | null = null;
  /** When this process first saw the RFQ filled and untracked: the trade-list wait counts from here (a restart waits anew). */
  let rfqFilledSeen: { rfqId: string; at: number } | null = null;
  /** The venue answered and the write did not happen (as orders.ts reads a refusal). */
  const definite = (error: unknown): boolean => error instanceof VenueError && (error.kind === 'rejected' || error.kind === 'not-sent');
  const rfqResponse = (rfq: RfqRecord) => ({ rfqId: rfq.rfqId, linkId: rfq.linkId, status: rfq.status, taskId: rfq.taskId, error: rfq.error });
  function touchRfq(rfq: RfqRecord): void { rfq.updatedAt = now(); rfqVersion += 1; save(); }

  interface RfqRequest { requestId: string; confirmLive: boolean; quantity?: string; mode?: StrategyMode }
  /** Sends this week's structure (quantity and mode as the desk's preview) to every listed market maker. */
  async function createRfq(request: RfqRequest) {
    const fingerprint = sortedJson([request.requestId, request.confirmLive, request.quantity ?? null, request.mode ?? null]);
    if (state.rfq?.requestId === request.requestId) {
      if (state.rfq.fingerprint !== fingerprint) conflict('request_reused', '这个请求编号已用于不同的参数');
      return rfqResponse(state.rfq);
    }
    if (request.confirmLive !== true) invalid('confirm_required', '发起实盘询价需要明确确认');
    return admitted(async () => {
      if (Object.keys(state.tracked.sizes).length) await syncPositions();
      if (Object.keys(state.tracked.sizes).length) conflict('strategy_open', '先平掉跟踪中的策略再询价开仓');
      await market.refresh();
      const view = preview(request.quantity ?? settings.legQty, request.mode ?? settings.strategyMode);
      validateRisk(view);
      validateCalendar(view.expiry);
      const legs = view.legs.map(leg => planLeg(leg.symbol, leg.side, leg.qty));
      if (legs.some(leg => leg.expiry !== view.expiry)) conflict('instrument_changed', '预览的到期日与合约不一致了');
      const risk = initialRisk(view), fees = feeContext();
      let config: Row;
      try { config = await client.rfqConfig(AbortSignal.timeout(READ_MS)); } catch (error) { return conflict('rfq_unavailable', `询价配置读取失败：${describe(error)}`); }
      let counterparties: string[];
      try { counterparties = counterpartiesFrom(config); } catch (error) { return conflict('rfq_unavailable', describe(error)); }
      if (shutdown) conflict('shutting_down', '服务正在停止');
      freshSnapshot();
      const id = newId().replace(/[^0-9a-zA-Z]/g, '').slice(0, 16), created = now();
      if (id.length < 8) throw new Error('询价编号生成失败');
      const rfq: RfqRecord = {
        requestId: request.requestId, fingerprint, taskId: id, linkId: `tporfq${id}`, rfqId: null, status: 'CreationUnknown',
        mode: view.mode, strategyType: strategyTypeFor(view.mode, config), counterparties, legs, risk, feeContext: fees,
        createdAt: created, updatedAt: created, expiresAt: null, selectedQuoteId: null, selectedDesk: null, selectedPrices: null, executionChain: null,
        executionStartedAt: null, executionResolved: false, trackingApplied: false, error: null,
      };
      state.rfq = rfq;
      rfqQuotes = null;
      touchRfq(rfq); // Durable before it is sent.
      log(`期权询价 ${rfq.linkId} 发送中：${legs.map(leg => `${leg.side} ${leg.qty} ${leg.symbol}`).join('、')}`);
      try {
        const reply = await client.createRfq({ rfqLinkId: rfq.linkId, strategyType: rfq.strategyType, counterparties, legs }, AbortSignal.timeout(READ_MS));
        observe(rfq, parseRfqRow({ ...reply, rfqLinkId: reply.rfqLinkId ?? rfq.linkId, status: reply.status ?? 'Active' }), now());
      } catch (error) {
        if (definite(error) && rfq.status === 'CreationUnknown') Object.assign(rfq, { status: 'Failed', error: `询价未创建：${describe(error)}` });
        else if (rfq.status === 'CreationUnknown') rfq.error = `询价创建结果未知，正在向交易所核对：${describe(error)}`;
      }
      touchRfq(rfq);
      return rfqResponse(rfq);
    });
  }

  interface ExecuteRequest { rfqId: string; quoteId: string; confirmLive: boolean }
  /** Executes one market maker's quote after checking it again against the RFQ, the chain, the calendar and the risk limits. */
  async function executeQuote(request: ExecuteRequest) {
    const rfq = state.rfq;
    if (!rfq || rfq.rfqId === null || rfq.rfqId !== request.rfqId) return conflict('rfq_missing', '询价不存在或已被新的询价替换');
    if (rfq.selectedQuoteId !== null && rfq.selectedQuoteId === request.quoteId) return rfqResponse(rfq);
    if (request.confirmLive !== true) invalid('confirm_required', '执行报价会实盘成交，需要明确确认');
    const rfqId = rfq.rfqId;
    return admitted(async () => {
      const executable = () => { if (state.rfq !== rfq || rfq.status !== 'Active' || rfq.selectedQuoteId !== null) conflict('rfq_state', '询价已不在可执行状态'); };
      executable();
      if (Object.keys(state.tracked.sizes).length) conflict('strategy_open', '已有跟踪中的策略，不能再执行询价开仓');
      let quote: RfqQuote | undefined;
      try { quote = parseQuotes(await client.quotes(rfqId, AbortSignal.timeout(READ_MS)), rfqId).find(item => item.quoteId === request.quoteId); }
      catch (error) { return conflict('quote_unavailable', `报价读取失败：${describe(error)}`); }
      if (!quote) return conflict('quote_missing', '这条报价已不存在或已撤回');
      const chosen = quote;
      await market.refresh();
      const prices = Object.fromEntries(chosen.sell.map(leg => [leg.symbol, leg.price]));
      const check = () => {
        executable();
        const problem = quoteProblem(rfq, chosen, now());
        if (problem) conflict('quote_invalid', problem);
        freshSnapshot();
        for (const leg of rfq.legs) {
          const row = rowOf(leg.symbol);
          if (!row || row.expiry !== leg.expiry || row.strike !== leg.strike || row.optionType !== leg.optionType) conflict('instrument_changed', `合约 ${leg.symbol} 已不在期权链里或参数变了`);
        }
        validateCalendar(rfq.legs[0]!.expiry);
        try { return proposedRisk({ risk: rfq.risk, mode: rfq.mode } as Task, prices); }
        catch (error) { return conflict('risk_limit', `按报价价格：${describe(error)}`); }
      };
      check();
      const priorRisk = rfq.risk, priorBaseline = state.pmBaseline;
      await capturePmBaseline('rfq_open');
      let risk: ReturnType<typeof check>;
      try {
        risk = check(); // The baseline read awaited: the quote, the RFQ and the chain are checked again.
        if (shutdown) conflict('shutting_down', '服务正在停止');
      } catch (error) {
        state.pmBaseline = priorBaseline; // Nothing was sent: the baseline of this attempt goes with it.
        save();
        throw error;
      }
      const executionChain = Object.fromEntries(rfq.legs.map(leg => [leg.symbol, chainFor(leg.side, rowOf(leg.symbol)) ?? leg.referencePrice]));
      Object.assign(rfq, {
        status: 'ExecutionUnknown', selectedQuoteId: chosen.quoteId, selectedDesk: chosen.deskCode, selectedPrices: prices, executionChain,
        executionStartedAt: now(), executionResolved: false, error: null, risk: { ...rfq.risk, ...risk },
      });
      touchRfq(rfq); // Durable before it is sent.
      log(`期权询价 ${rfqId} 执行报价 ${chosen.quoteId}（${chosen.deskCode || '做市商'}）`);
      // Nothing executed: the RFQ waits for another quote, with the risk and the margin baseline it had before this one.
      const revert = (message: string) => {
        Object.assign(rfq, { status: 'Active', selectedQuoteId: null, selectedDesk: null, selectedPrices: null, executionChain: null, executionStartedAt: null, error: message, risk: priorRisk });
        state.pmBaseline = priorBaseline;
      };
      try {
        const reply = await client.executeQuote(rfqId, chosen.quoteId, AbortSignal.timeout(READ_MS));
        // An answer naming another RFQ or quote proves nothing about this one: it stays unknown for the loop to settle.
        const foreign = (reply.rfqId !== undefined && reply.rfqId !== rfqId) || (reply.quoteId !== undefined && reply.quoteId !== chosen.quoteId);
        if (rfq.status !== 'ExecutionUnknown') { /* the loop settled it meanwhile */ }
        else if (foreign) rfq.error = '报价执行应答与所选报价不符，正在向交易所核对';
        else if (reply.status === 'PendingFill') rfq.status = 'PendingFill';
        else if (reply.status === 'Failed') revert('交易所回复报价执行失败，没有成交；可以选择其它报价');
      } catch (error) {
        if (definite(error) && rfq.status === 'ExecutionUnknown') revert(`报价执行被拒绝：${describe(error)}`);
        else if (rfq.status === 'ExecutionUnknown') rfq.error = `报价执行结果未知，正在向交易所核对：${describe(error)}`;
      }
      touchRfq(rfq);
      return rfqResponse(rfq);
    }, false);
  }

  async function cancelRfq(request: { rfqId: string }) {
    const rfq = state.rfq;
    if (!rfq || rfq.rfqId === null || rfq.rfqId !== request.rfqId) return conflict('rfq_missing', '询价不存在或已被新的询价替换');
    if (rfq.status === 'CancelUnknown' || rfq.status === 'Canceled') return rfqResponse(rfq);
    const rfqId = rfq.rfqId;
    return admitted(async () => {
      if (state.rfq !== rfq || rfq.status !== 'Active' || rfq.selectedQuoteId !== null) conflict('rfq_state', '询价已不能取消');
      Object.assign(rfq, { status: 'CancelUnknown', error: null });
      touchRfq(rfq);
      try { await client.cancelRfq(rfqId, AbortSignal.timeout(READ_MS)); }
      catch (error) {
        if (definite(error) && rfq.status === 'CancelUnknown') Object.assign(rfq, { status: 'Active', error: `取消被拒绝：${describe(error)}` });
        else if (rfq.status === 'CancelUnknown') rfq.error = `取消结果未知，正在向交易所核对：${describe(error)}`;
      }
      touchRfq(rfq);
      return rfqResponse(rfq);
    }, false);
  }

  /**
   * The filled RFQ as an opening task: legs at the quote, one filled journal entry per leg, and the tracked strategy.
   * A strategy already tracked (only a person's change can bring one in while the RFQ holds trading) is never replaced:
   * the RFQ is finished without a task and a person reconciles it (null).
   */
  function adoptRfq(rfq: RfqRecord, orders: Record<string, { orderId: string; price: number }>): Task | null {
    const id = rfq.taskId, at = now(), started = rfq.executionStartedAt ?? rfq.createdAt;
    if (Object.keys(state.tracked.sizes).length && state.tracked.groupId !== id) {
      Object.assign(rfq, { trackingApplied: true, error: '询价已成交，但已有跟踪中的策略，没有接管跟踪；请先关闭定时开仓，再到 Bybit 核对这笔询价的持仓' });
      return null;
    }
    const priceOf = (symbol: string) => orders[symbol]!.price > 0 ? orders[symbol]!.price : rfq.selectedPrices?.[symbol] ?? 0;
    const task: Task = {
      id, type: 'open', status: 'completed', planId: `rfq:${rfq.rfqId}`, requestId: rfq.requestId, fingerprint: rfq.fingerprint,
      acceptedAt: rfq.createdAt, startedAt: started, finishedAt: at, stopRequested: false, stopRequestedAt: null, mode: rfq.mode,
      legs: Object.fromEntries(rfq.legs.map(leg => [leg.symbol, { ...leg, chainPrice: rfq.executionChain?.[leg.symbol] ?? leg.referencePrice }])),
      links: rfq.legs.map((_, index) => `tpo-rfq-${id}-${index}`),
      netLegs: Object.fromEntries(rfq.legs.map(leg => [leg.symbol, { ...leg, priceBound: priceOf(leg.symbol) }])), feeContext: rfq.feeContext,
      minNetIncomeUsd: null, maxNetCostUsd: null, netBlocked: false, reserved: null, risk: rfq.risk, riskBlocked: false,
      openingGroup: null, strategyStatus: 'open', closedAt: null, closeReason: null, closureEvidence: {}, error: null, notified: [],
      rfq: { rfqId: rfq.rfqId!, quoteId: rfq.selectedQuoteId ?? '', deskCode: rfq.selectedDesk ?? '' },
    };
    rfq.legs.forEach((leg, index) => {
      state.journal[task.links[index]!] = {
        taskId: id, symbol: leg.symbol, side: leg.side, qty: leg.qty, reduceOnly: false, tick: rowOf(leg.symbol)?.tick ?? '0', status: 'filled', terminal: true,
        filledQty: leg.qty, orderId: orders[leg.symbol]!.orderId, createdAt: started, updatedAt: at, price: String(priceOf(leg.symbol)), kind: 'rfq',
      };
    });
    state.tasks[id] = task;
    state.tracked = { groupId: id, sizes: Object.fromEntries(rfq.legs.map(leg => [`${leg.symbol}|${leg.side}`, leg.qty])) };
    Object.assign(rfq, { trackingApplied: true, error: null });
    return task;
  }

  /**
   * Every 3 s while the RFQ is unfinished: its state (live list first, history when the live list lacks it or lags a
   * write), the quotes while it waits for one, and the trade once filled. Nothing read is applied when a local write
   * happened meanwhile. A creation the venue never shows within missingSettleMs is taken as not created (no funds move
   * without an execution); a chosen quote or a cancel the venue never shows stays blocked for a person.
   */
  async function rfqTick(): Promise<void> {
    const rfq = state.rfq;
    if (shutdown || rfqTicking || !rfq || rfqFinished(rfq)) return;
    rfqTicking = true;
    const version = rfqVersion;
    try {
      const signal = AbortSignal.timeout(READ_MS);
      const by = rfq.rfqId ? { rfqId: rfq.rfqId } : { rfqLinkId: rfq.linkId };
      const find = (rows: Row[]): RfqObservation | null => {
        for (const row of rows) if (row.rfqLinkId === rfq.linkId) return parseRfqRow(row);
        return null;
      };
      // A filled RFQ not yet tracked only needs its trade. After a write, a live row still Active may lag the history.
      let seen: RfqObservation | null = null;
      if (!isTerminal(rfq.status)) {
        seen = find(await client.rfqs(by, false, signal));
        if (!seen || (seen.status === 'Active' && rfq.status !== 'Active' && rfq.status !== 'CreationUnknown')) seen = find(await client.rfqs(by, true, signal)) ?? seen;
      }
      const next: RfqRecord = structuredClone(rfq);
      if (seen) observe(next, seen, now());
      const quotes = next.status === 'Active' && next.selectedQuoteId === null && next.rfqId ? parseQuotes(await client.quotes(next.rfqId, signal), next.rfqId) : null;
      // A trade list that cannot be read counts like one that lacks the trade: Filled alone is the evidence (see below).
      let tradeReadError: string | null = null;
      const trades = next.status === 'Filled' && !next.trackingApplied && next.rfqId
        ? await client.rfqTrades(next.rfqId, signal).catch((error: unknown) => { tradeReadError = describe(error); return [] as Row[]; }) : null;
      if (rfqVersion !== version || state.rfq !== rfq) return;
      rfqReadError = null;
      if (quotes) rfqQuotes = { rfqId: next.rfqId!, quotes, at: now() };
      else if (next.status !== 'Active') rfqQuotes = null;
      if (!seen && !isTerminal(rfq.status) && rfq.status === 'CreationUnknown' && now() - rfq.createdAt >= missingSettleMs) {
        Object.assign(rfq, { status: 'Failed', error: '交易所查不到这个询价，按未创建处理' });
        touchRfq(rfq);
        log(`期权询价 ${rfq.linkId} 未在交易所出现，按未创建处理`);
        return;
      }
      if (!seen && !isTerminal(rfq.status)) { rfqReadError = rfq.status === 'CreationUnknown' ? '交易所还查不到这个询价，继续核对' : '交易所查不到这个询价，交易保持锁定，请到 Bybit 核对'; return; }
      const changed = sortedJson(next) !== sortedJson(rfq);
      if (changed) Object.assign(rfq, next);
      if (trades) {
        // Filled is the venue's answer that the saved structure traded (the workbench tracks on it alone). The trade list
        // adds the order ids; when it still lacks or contradicts the RFQ after RFQ_TRADE_WAIT_MS the structure is tracked
        // without them and a person checks the fills.
        let orders: ReturnType<typeof filledOrders>, mismatch: string | null = tradeReadError === null ? null : `成交记录读取失败：${tradeReadError}`;
        try { orders = mismatch === null ? filledOrders(rfq, trades) : null; }
        catch (error) { orders = null; mismatch = describe(error); }
        if (rfqFilledSeen?.rfqId !== rfq.rfqId) rfqFilledSeen = { rfqId: rfq.rfqId!, at: now() };
        const legsText = rfq.legs.map(leg => `${leg.side} ${leg.qty} ${leg.symbol}`).join('、');
        let fallback = false;
        if (!orders) {
          if (now() - rfqFilledSeen.at < RFQ_TRADE_WAIT_MS) {
            rfqReadError = tradeReadError !== null ? `询价已成交，${mismatch}，继续核对` : mismatch ? `询价已成交，成交记录与询价暂不一致，继续核对：${mismatch}` : '询价已成交，等待成交记录';
            if (changed) touchRfq(rfq);
            return;
          }
          orders = Object.fromEntries(rfq.legs.map(leg => [leg.symbol, { orderId: '', price: rfq.selectedPrices?.[leg.symbol] ?? 0 }]));
          fallback = true;
        }
        const task = adoptRfq(rfq, orders);
        if (task && fallback) rfq.error = `询价已成交，但没有拿到与询价一致的成交记录，已按询价结构跟踪；成交明细与收益待人工核对${mismatch ? `：${mismatch}` : ''}`;
        touchRfq(rfq);
        if (!task) {
          if (mismatch) rfq.error = `${rfq.error}（成交记录：${mismatch}）`;
          touchRfq(rfq);
          log(`期权${rfq.error}`);
          try { notify(`期权${rfq.error}：${legsText}`); } catch (error) { log(`期权飞书通知未能写入：${describe(error)}`); }
          return;
        }
        log(`期权询价 ${rfq.rfqId} 已成交，开仓任务 ${task.id} 开始跟踪${fallback ? '（按询价结构，成交明细待核对）' : ''}`);
        try { notify(fallback ? `期权${rfq.error}：${legsText}` : `期权询价开仓已成交（${rfq.selectedDesk || '做市商'}）：${legsText}`); } catch (error) { log(`期权飞书通知未能写入：${describe(error)}`); }
        void loadExecutions(task.links).catch(error => log(`期权成交明细刷新失败：${describe(error)}`));
        return;
      }
      if (!changed) return;
      touchRfq(rfq);
      log(`期权询价 ${rfq.rfqId ?? rfq.linkId}：${RFQ_STATUS_NAMES[rfq.status]}`);
      if (isTerminal(rfq.status) && rfq.status !== 'Filled' && rfq.selectedQuoteId !== null) {
        try { notify(`期权询价 ${rfq.rfqId} 选中的报价没有成交：${RFQ_STATUS_NAMES[rfq.status]}`); } catch (error) { log(`期权飞书通知未能写入：${describe(error)}`); }
      }
    } catch (error) {
      if (rfqVersion === version) rfqReadError = `询价状态读取失败，稍后重试：${describe(error)}`;
    } finally { rfqTicking = false; }
  }

  /** Why a new RFQ cannot be sent now; null when it can. */
  function rfqBlocked(): string | null {
    try { requireIdle(); } catch (error) { return describe(error); }
    if (Object.keys(state.tracked.sizes).length) return '先平掉跟踪中的策略再询价开仓';
    return null;
  }
  function rfqView() {
    const rfq = state.rfq, at = now(), snapshot = market.snapshot();
    const chain = new Map((snapshot?.rows ?? []).map(row => [row.symbol, { bid: row.bid, ask: row.ask, mark: row.mark }]));
    const current = rfq && rfqQuotes && rfqQuotes.rfqId === rfq.rfqId ? rfqQuotes : null;
    return {
      rfq, statusName: rfq ? RFQ_STATUS_NAMES[rfq.status] : null, finished: rfqFinished(rfq), readError: rfqFinished(rfq) ? null : rfqReadError,
      quotes: rfq && current ? sortQuotes(current.quotes.map(quote => quoteView(rfq, quote, chain, at))) : [], quotesAt: current?.at ?? null,
      blocked: rfqFinished(rfq) ? rfqBlocked() : null, settings: { legQty: settings.legQty, strategyMode: settings.strategyMode, maxRiskUsd: settings.maxRiskUsd, maxMarginUsd: settings.maxMarginUsd },
      market: { at: snapshot?.at ?? null, stale: !snapshot || at - snapshot.at > QUOTE_STALE_MS }, now: at,
    };
  }

  function stopTask(id: string) {
    const task = state.tasks[id];
    if (!task) return conflict('task_missing', '期权任务不存在');
    if (isActive(task.status)) {
      task.stopRequested = true;
      task.stopRequestedAt ??= now();
      if (task.status !== 'recovering' && task.status !== 'recovery_needed') task.status = 'stopping';
      for (const wake of wakers.get(id) ?? []) wake();
      // A storage failure must never undo the stop in memory.
      try { save(); } catch (error) { task.error = `停止已在内存生效，保存失败：${describe(error)}`; log(task.error); }
    }
    return taskResponse(task);
  }

  function checkStop(task: Task): void { if (task.stopRequested || shutdown) throw new StopRequested(); }
  async function pause(task: Task, ms: number): Promise<void> {
    checkStop(task);
    await new Promise<void>(resolve => {
      const set = wakers.get(task.id) ?? new Set();
      wakers.set(task.id, set);
      const done = () => { clearTimeout(timer); set.delete(done); resolve(); };
      const timer = setTimeout(done, ms);
      set.add(done);
    });
    checkStop(task);
  }

  /** Reserves a leg's price against the confirmed net limit (fees included, worst price per leg, never relaxed). */
  function reserveNet(task: Task, symbol: string, price: number | null): void {
    if (task.netBlocked) throw new Error('组合净价已超出确认的限制');
    if (price === null) return;
    if (!Number.isFinite(price) || price <= 0) throw new Error('执行价无效');
    const proposed = structuredClone(task.netLegs), leg = proposed[symbol]!;
    leg.priceBound = leg.side === 'Buy' ? Math.max(price, leg.priceBound) : Math.min(price, leg.priceBound);
    leg.feePriceCeiling = Math.max(price, leg.feePriceCeiling ?? leg.referencePrice);
    const current = feeContext();
    const context: FeeContext = { index: Math.max(task.feeContext.index, current.index), feeRate: Math.max(task.feeContext.feeRate, current.feeRate), feeCapPct: Math.max(task.feeContext.feeCapPct, current.feeCapPct) };
    const { gross, fee, net } = netEstimate(proposed, context);
    const breached = task.type === 'open' ? net < task.minNetIncomeUsd! - EPSILON : -net > task.maxNetCostUsd! + EPSILON;
    if (breached) { task.netBlocked = true; save(); throw new Error('组合价格（含估算手续费）超出确认的净价限制'); }
    const reserved = { grossUsd: gross, feeUsd: fee, netUsd: net };
    if (sortedJson([proposed, context, reserved]) === sortedJson([task.netLegs, task.feeContext, task.reserved])) return;
    Object.assign(task, { netLegs: proposed, feeContext: context, reserved });
    save();
  }

  /** The opening risk at the worst price each leg was ever sent at; a breach blocks the task's remaining orders. */
  function proposedRisk(task: Task, prices: Record<string, number>): Partial<NonNullable<Task['risk']>> & { legs: Record<string, RiskLeg>; reservedUsd: number } {
    const saved = task.risk;
    if (!saved || Object.keys(prices).some(symbol => !saved.legs[symbol])) throw new Error('开仓任务没有执行价风险界限');
    const proposed = structuredClone(saved.legs);
    for (const [symbol, price] of Object.entries(prices)) {
      if (!Number.isFinite(price) || price <= 0) throw new Error('执行价无效');
      const leg = proposed[symbol]!;
      if (task.mode === 'short_strangle') {
        leg.priceFloor = Math.min(price, leg.priceFloor ?? leg.priceBound);
        leg.priceCeiling = Math.max(price, leg.priceCeiling ?? leg.priceBound);
        leg.priceBound = price;
      } else leg.priceBound = leg.side === 'Buy' ? Math.max(price, leg.priceBound) : Math.min(price, leg.priceBound);
    }
    if (task.mode === 'short_strangle') {
      freshSnapshot();
      const current = marginContext();
      const context: MarginContext = { ...saved.context, index: current.index };
      // A restart with stricter settings must not relax a reservation; lower requirements never free one.
      for (const key of ['feeRate', 'feeCapPct', 'mmFactor', 'maxImFactor', 'minImFactor', 'liquidationFeeRate', 'marginBufferPct'] as const) context[key] = Math.max(saved.context[key], current[key]);
      for (const [symbol, leg] of Object.entries(proposed)) {
        const row = rowOf(symbol);
        if (!row || row.optionType !== leg.optionType || row.strike !== leg.strike || row.expiry !== leg.expiry) throw new Error('卖出宽跨的保证金行情与原始腿不一致');
        leg.mark = row.mark;
      }
      const reserved = reserveShortMargin(proposed, context);
      const budget = Math.min(settings.maxMarginUsd, saved.budgetUsd);
      if (reserved.total > budget) throw new Error(`执行价使卖出宽跨保证金 ${reserved.total.toFixed(2)} 超过预算 ${budget}`);
      return { legs: reserved.legs, context, reservedUsd: reserved.total };
    }
    const loss = maximumLoss(proposed);
    if (loss > settings.maxRiskUsd) throw new Error(`执行价使组合最大亏损 ${loss.toFixed(2)} 超过上限 ${settings.maxRiskUsd}`);
    return { legs: proposed, reservedUsd: loss };
  }

  function reservePrice(task: Task, link: string, symbol: string, price: number | null): void {
    checkStop(task);
    freshSnapshot();
    const entry = state.journal[link], bound = task.legs[symbol];
    const mismatch = (side: Side | undefined, qty: string | number | undefined) => !entry || entry.symbol !== symbol || entry.side !== side || qty === undefined || !(cmp(entry.qty, '0') > 0 && cmp(entry.qty, decimal(String(qty))) <= 0);
    if (mismatch(bound?.side, bound?.qty)) throw new Error('订单与确认的计划不一致');
    reserveNet(task, symbol, price);
    if (task.type === 'close') return;
    if (task.riskBlocked) throw new Error('组合风险已超出，停止剩余开仓订单');
    const riskLeg = task.risk?.legs[symbol];
    if (mismatch(riskLeg?.side, riskLeg?.qty)) { task.riskBlocked = true; save(); throw new Error('订单与原始策略的数量或方向不一致'); }
    if (price === null && task.mode === 'iron_condor') return;
    let next: ReturnType<typeof proposedRisk>;
    try {
      next = proposedRisk(task, price === null ? {} : { [symbol]: price });
    } catch (error) {
      task.riskBlocked = true;
      save();
      throw error instanceof StrategyError ? new Error(error.message) : error;
    }
    const merged = { ...task.risk!, ...next };
    // Keep the worst bound ever sent; fills can race amendments.
    if (sortedJson(merged) !== sortedJson(task.risk)) { task.risk = merged; save(); }
  }

  /** filledQty never falls; each new fill moves the tracked strategy (a reduce-only fill shrinks the opposite side). */
  function recordOrder(link: string, outcome: OrderOutcome): void {
    const entry = state.journal[link];
    if (!entry) return;
    const filled = cmp(outcome.filledQty, entry.filledQty) < 0 ? entry.filledQty : decimal(outcome.filledQty);
    const next: Partial<JournalEntry> = { status: outcome.status, terminal: outcome.terminal, filledQty: filled, orderId: outcome.orderId || entry.orderId };
    if (outcome.message !== undefined) next.message = outcome.message;
    if (outcome.price !== undefined) next.price = outcome.price;
    if (Object.entries(next).every(([key, value]) => entry[key as keyof JournalEntry] === value)) return;
    const delta = sub(filled, entry.filledQty);
    Object.assign(entry, next, { updatedAt: now() });
    const task = state.tasks[entry.taskId];
    if (cmp(delta, '0') > 0 && task) {
      const key = `${entry.symbol}|${entry.reduceOnly ? opposite(entry.side) : entry.side}`;
      const current = state.tracked.sizes[key] ?? '0';
      if (entry.reduceOnly) {
        const left = sub(current, delta);
        if (cmp(left, '0') <= 0) delete state.tracked.sizes[key]; else state.tracked.sizes[key] = left;
      } else {
        state.tracked.sizes[key] = add(current, delta);
        state.tracked.groupId = task.id;
      }
    }
    save();
  }

  const linksOf = (task: Task): string[] => [...new Set([...task.links, ...Object.entries(state.journal).filter(([, entry]) => entry.taskId === task.id).map(([link]) => link)])];

  async function runLeg(task: Task, leg: PlanLeg, link: string): Promise<OrderOutcome> {
    checkStop(task);
    const row = rowOf(leg.symbol);
    if (!row) throw new Error(`合约 ${leg.symbol} 已不在最新行情里`);
    if (state.journal[link]) throw new Error('订单编号已用过，只能核对不能重发');
    const created = now();
    state.journal[link] = { taskId: task.id, symbol: leg.symbol, side: leg.side, qty: leg.qty, reduceOnly: task.type === 'close', tick: row.tick, status: 'unknown', terminal: false, filledQty: '0', orderId: '', createdAt: created, updatedAt: created };
    save(); // The intent is durable before the order can exist.
    return followOrder(client, { symbol: leg.symbol, side: leg.side, qty: leg.qty, link, reduceOnly: task.type === 'close', tick: row.tick }, {
      now, deadline: created + settings.orderTimeoutMs, pollMs,
      checkStop: () => checkStop(task),
      checkPrice: price => reservePrice(task, link, leg.symbol, price),
      pause: ms => pause(task, ms),
      record: outcome => recordOrder(link, outcome),
      sleep, log,
    });
  }

  /**
   * The workbench's _market_fallback for an opening leg whose order ended partly filled or unfilled: after a short delay
   * the original is read again without cancelling (a late fill counts first), and only a terminal one's remainder, if it
   * meets the lot limits, gets one IOC at the far side of the book, reserved against the net and risk limits like every
   * price. A closing, a stopped task or a blocked one never falls back. The leg's combined outcome is returned.
   */
  async function legWithFallback(task: Task, leg: PlanLeg, link: string, index: number): Promise<OrderOutcome> {
    const outcome = await runLeg(task, leg, link);
    if (!settings.marketFallback || task.type !== 'open' || (outcome.status !== 'partial' && outcome.status !== 'timeout_cancelled')) return outcome;
    const entry = state.journal[link]!;
    try {
      if (task.netBlocked || task.riskBlocked) return outcome;
      await pause(task, FALLBACK_DELAY_MS);
      const previous: OrderOutcome = { orderId: entry.orderId, status: entry.status, terminal: entry.terminal, filledQty: entry.filledQty, ...(entry.price ? { price: entry.price } : {}) };
      const confirmed = await reconcileOrder(client, { ...entry, link }, previous, false, { record: item => recordOrder(link, item), sleep, log });
      // A read that failed proves nothing new: the order stays as it ended, and nothing more is sent.
      if (!confirmed.terminal) return { ...outcome, message: '兜底前未能再次读到原订单，未发 IOC 兜底' };
      recordOrder(link, confirmed);
      const remaining = sub(leg.qty, confirmed.filledQty);
      if (cmp(remaining, '0') <= 0) return confirmed;
      const row = rowOf(leg.symbol);
      if (!row) return { ...confirmed, message: `合约 ${leg.symbol} 已不在最新行情里，未发 IOC 兜底` };
      if (cmp(remaining, row.minQty) < 0 || cmp(remaining, row.maxQty) > 0 || !isMultiple(sub(remaining, row.minQty), row.qtyStep)) return { ...confirmed, message: '剩余数量不符合交易所下单步长，未发 IOC 兜底' };
      checkStop(task);
      const iocLink = `tpo-ioc-${task.id}-${index}`;
      if (state.journal[iocLink]) throw new Error('IOC 订单编号已用过，只能核对不能重发');
      const created = now();
      state.journal[iocLink] = { taskId: task.id, symbol: leg.symbol, side: leg.side, qty: remaining, reduceOnly: false, tick: row.tick, status: 'unknown', terminal: false, filledQty: '0', orderId: '', createdAt: created, updatedAt: created, kind: 'ioc' };
      save();
      log(`期权任务 ${task.id}：${leg.symbol} 剩余 ${remaining}，尝试 IOC 兜底（先核对净价与风险限制）`);
      const ioc = await iocOrder(client, { symbol: leg.symbol, side: leg.side, qty: remaining, link: iocLink, reduceOnly: false, tick: row.tick }, {
        checkStop: () => checkStop(task),
        checkPrice: price => reservePrice(task, iocLink, leg.symbol, price),
        record: item => recordOrder(iocLink, item),
        sleep, log,
      });
      const filled = add(confirmed.filledQty, ioc.filledQty);
      const status: OrderStatus = !ioc.terminal ? 'unknown' : cmp(filled, leg.qty) === 0 ? 'filled' : isZero(filled) ? 'timeout_cancelled' : 'partial';
      return { orderId: confirmed.orderId, status, terminal: ioc.terminal, filledQty: filled, ...(ioc.message ? { message: `IOC 兜底：${ioc.message}` } : {}) };
    } catch (error) { return { ...outcome, message: `IOC 兜底中断：${describe(error)}` }; }
  }

  async function runTask(id: string): Promise<void> {
    const task = state.tasks[id]!;
    let error: string | null = null, done = false;
    let sampler: Promise<void> | null = null;
    try {
      try {
        checkStop(task);
        Object.assign(task, { status: 'running', startedAt: now() });
        save();
        if (task.scheduled && !inOpenWindow()) throw new Error('定时开仓窗口在下单前已结束，未下单');
        freshSnapshot();
        const legs = Object.values(task.legs);
        sampler = (async () => {
          while (!done) {
            await new Promise<void>(resolve => { const timer = setTimeout(resolve, sampleMs); timer.unref?.(); });
            if (done) break;
            try { await loadExecutions(linksOf(task)); } catch (failure) { log(`期权成交明细刷新失败：${describe(failure)}`); }
          }
        })();
        // Buys before sells: an opening's wings fill before its short legs go out, a closing buys its shorts back before
        // selling the wings, so a stop, a limit or a timeout can never leave a short leg without its wing. A sell goes
        // out only when every buy filled in full; a short strangle (sells only) or its closing (buys only) is one round.
        const indexed = legs.map((leg, index) => ({ leg, link: task.links[index]!, index }));
        const round = (side: 'Buy' | 'Sell') => Promise.allSettled(indexed.filter(item => item.leg.side === side).map(item => legWithFallback(task, item.leg, item.link, item.index)));
        const results = await round('Buy');
        const errors: string[] = [];
        if (results.every(result => result.status === 'fulfilled' && result.value.status === 'filled')) results.push(...await round('Sell'));
        else if (indexed.some(item => item.leg.side === 'Sell')) errors.push('买入腿未全部成交，卖出腿未下单（避免留下无保护的卖出）');
        errors.unshift(...results.flatMap(result => result.status === 'rejected' ? [describe(result.reason)] : result.value.message && result.value.status !== 'filled' ? [result.value.message] : []));
        if (errors.length) error = [...new Set(errors)].join('；');
        try { await loadExecutions(linksOf(task)); } catch (failure) { log(`期权成交明细刷新失败：${describe(failure)}`); }
      } catch (failure) {
        error = describe(failure);
        log(`期权任务 ${id}：${error}`);
      } finally {
        done = true;
        if (sampler) await sampler;
        finishTask(id, error);
      }
    } catch (failure) {
      Object.assign(task, { status: 'recovery_needed', error: describe(failure) });
      log(`期权任务 ${id} 的结束状态无法保存：${describe(failure)}`);
    } finally { wakers.delete(id); }
  }

  function finishTask(id: string, error: string | null = null): void {
    const task = state.tasks[id]!;
    const entries = Object.values(state.journal).filter(entry => entry.taskId === id);
    if (entries.some(entry => !entry.terminal)) task.status = 'recovery_needed';
    else {
      const filled = Object.fromEntries(Object.keys(task.legs).map(symbol => [symbol, entries.filter(entry => entry.symbol === symbol).reduce((sum, entry) => add(sum, entry.filledQty), '0')]));
      const complete = Object.entries(task.legs).every(([symbol, leg]) => cmp(filled[symbol]!, leg.qty) === 0);
      task.status = complete ? 'completed' : Object.values(filled).some(value => !isZero(value)) ? 'partial' : task.stopRequested ? 'stopped' : 'failed';
      task.finishedAt = now();
      if (complete && task.type === 'close' && !Object.keys(state.tracked.sizes).length) {
        const opening = task.openingGroup ? state.tasks[task.openingGroup] : undefined;
        if (opening) Object.assign(opening, { strategyStatus: 'closed', closedAt: now(), closeReason: 'close_task_completed' });
        state.tracked.groupId = null;
        state.pmBaseline = null;
      }
    }
    if (error) task.error = error;
    save();
    announce(task);
  }

  /** One Feishu message per task and status: accepted, needs a human, and each end state. */
  function announce(task: Task): void {
    const tag = task.status;
    if (task.notified.includes(tag) || !['accepted', 'recovery_needed', 'completed', 'partial', 'stopped', 'failed'].includes(tag)) return;
    const what = `期权${task.scheduled ? '定时' : ''}${OPERATION_NAMES[task.type]}任务 ${task.id}`;
    const text = tag === 'accepted' ? `${what} 已确认：${Object.keys(task.legs).join('、')}`
      : tag === 'recovery_needed' ? `${what} 有订单状态未确认，已停止自动重试，对账循环会继续核对；请到交易所核对订单`
      : `${what} 结束：${STATUS_NAMES[tag]}${task.error ? `（${task.error}）` : ''}`;
    try { notify(text); task.notified.push(tag); save(); } catch (error) { log(`期权飞书通知未能写入：${describe(error)}`); }
  }

  async function capturePmBaseline(context: string): Promise<void> {
    try {
      const signal = AbortSignal.timeout(READ_MS);
      const account = await client.accountInfo(signal);
      if (account.marginMode !== 'PORTFOLIO_MARGIN') { state.pmBaseline = null; return; }
      state.pmBaseline = { ...pmMetrics(await client.portfolioMargin(signal)), capturedAt: now(), context };
      save();
    } catch (error) { log(`开仓前组合保证金基线读取失败：${describe(error)}`); }
  }

  /** Reads the fills of the given orders into the ledger and the recent list; answers how many reads failed. */
  async function loadExecutions(links: readonly string[]): Promise<number> {
    const signal = AbortSignal.timeout(READ_MS);
    // An RFQ leg (G2c) is a block trade without our orderLinkId: it is read by its order id and filed under its journal link.
    const targets = [...new Set(links)].map(link => ({ link, rfq: Object.hasOwn(state.journal, link) && state.journal[link]!.kind === 'rfq' ? state.journal[link]!.orderId : null }));
    const groups = await Promise.allSettled(targets.map(({ link, rfq }) => rfq === null ? client.executions(link, signal) : rfq ? client.executionsByOrder(rfq, signal) : Promise.resolve([]))); // An RFQ tracked without order ids has no fills to read.
    const records: ExecutionRecord[] = [];
    let failed = 0;
    for (const [index, group] of groups.entries()) {
      if (group.status === 'rejected') { failed += 1; log(`部分期权成交明细读取失败，保留已有记录：${describe(group.reason)}`); continue; }
      const target = targets[index]!;
      for (const row of group.value) {
        const parsed = parseExecution(row);
        if (target.rfq !== null && parsed.orderId !== target.rfq) continue;
        const record = target.rfq === null ? parsed : { ...parsed, orderLinkId: target.link };
        const owner = Object.hasOwn(state.journal, record.orderLinkId) ? state.journal[record.orderLinkId] : undefined;
        const task = owner ? state.tasks[owner.taskId] : undefined;
        const reduceOnly = task?.type === 'close' || record.orderLinkId.startsWith('tpo-close-');
        const baseline = reduceOnly ? undefined : task?.legs[record.symbol];
        const chainPrice = baseline?.chainPrice ?? null;
        const chainPriceDiff = chainPrice !== null && baseline ? (baseline.side === 'Sell' ? 1 : -1) * (record.execPrice - chainPrice) * record.execQty : null;
        records.push({ ...record, reduceOnly, taskId: task?.id ?? null, openingGroup: task?.openingGroup ?? null, chainPrice, chainPriceDiff });
      }
    }
    if (!records.length) return failed;
    const changed = records.filter(record => sortedJson(ledger.get(record.execId)) !== sortedJson(record));
    if (changed.length) { store.saveExecutions(changed); for (const record of changed) ledger.set(record.execId, record); }
    const merged = new Map(state.executions.map(item => [item.execId, item]));
    for (const record of records) merged.set(record.execId, record);
    const next = [...merged.values()].sort((a, b) => b.execTime - a.execTime).slice(0, EXECUTIONS_KEPT);
    if (sortedJson(next) === sortedJson(state.executions)) return failed;
    state.executions = next;
    save();
    return failed;
  }

  // ---- 收益 (G2b) ------------------------------------------------------------------------------------------------
  function performanceInput(at: number): PerformanceInput {
    const fresh = positions !== null && at - positions.at >= 0 && at - positions.at <= POSITIONS_FRESH_MS ? positions.rows : null;
    return { groups: state.tasks, executions: [...ledger.values()], journal: state.journal, positions: fresh, samples, sampleSeconds: PERFORMANCE_SAMPLE_MS / 1000 };
  }

  /**
   * Every 15 s: reads again the fills of finished orders the ledger lacks (a restart or a recovery ended them without a
   * read), then records one mark-to-market sample a minute for each valued holding before its expiry. A failed read or
   * an unvalued holding records nothing; the chart shows the gap.
   */
  async function performanceTick(): Promise<void> {
    if (shutdown) return;
    const errors: string[] = [];
    try {
      const archived = new Map<string, bigint>();
      for (const record of ledger.values()) archived.set(record.orderLinkId, (archived.get(record.orderLinkId) ?? 0n) + exact(record.execQty));
      const at = now();
      const missing = Object.entries(state.journal)
        .filter(([link, entry]) => entry.terminal && at - entry.createdAt <= BACKFILL_WINDOW_MS && at - (backfillAt.get(link) ?? -Infinity) >= BACKFILL_RETRY_MS && exact(entry.filledQty) > (archived.get(link) ?? 0n))
        .sort(([, a], [, b]) => b.createdAt - a.createdAt).slice(0, BACKFILL_PER_ROUND).map(([link]) => link);
      for (const link of missing) backfillAt.set(link, at);
      if (missing.length && await loadExecutions(missing)) errors.push('部分订单的成交明细补读失败，下次再读');
    } catch (error) { errors.push(`成交明细补读失败：${describe(error)}`); }
    try {
      const at = now();
      // Status, value and expiry do not depend on the samples, so this build skips them; its cost stays flat as they grow.
      for (const row of buildPerformance({ ...performanceInput(at), samples: new Map() }).groups) {
        if (row.status !== 'open' || row.markToMarketPnl === null || row.expiry === null || at >= row.expiry) continue;
        const history = samples.get(row.id) ?? [];
        const last = history.at(-1);
        if (last && at - last.time < PERFORMANCE_SAMPLE_MS) continue;
        const sample: Sample = { time: at, pnl: amountText(exact(row.markToMarketPnl)) };
        store.addSample(row.id, sample);
        history.push(sample);
        samples.set(row.id, history);
      }
    } catch (error) { errors.push(`持仓盈亏采样失败，保留已有采样：${describe(error)}`); }
    const message = errors.length ? errors.join('；') : null;
    if (message && message !== performanceError) log(`期权收益：${message}`);
    performanceError = message;
  }

  // ---- reconciliation --------------------------------------------------------------------------------------------
  /** Unfinished orders are cancelled and read back; recovered tasks end; positions sync and closed legs retire. */
  async function reconcileOnce(): Promise<void> {
    await locked(async () => {
      const errors: string[] = [];
      try {
        const pending = Object.entries(state.journal).filter(([, entry]) => !entry.terminal);
        await Promise.all(pending.map(async ([link, entry]) => {
          const previous: OrderOutcome = { orderId: entry.orderId, status: entry.status, terminal: entry.terminal, filledQty: entry.filledQty, ...(entry.price ? { price: entry.price } : {}) };
          const outcome = await reconcileOrder(client, { ...entry, link }, previous, true, { record: item => recordOrder(link, item), sleep, log }, now() - entry.createdAt >= missingSettleMs && now() - entry.createdAt <= MISSING_SETTLE_MAX_AGE_MS);
          recordOrder(link, outcome);
        }));
        for (const task of Object.values(state.tasks)) if ((task.status === 'recovering' || task.status === 'recovery_needed') && !workers.has(task.id)) finishTask(task.id);
        if (Object.values(state.journal).some(entry => !entry.terminal)) throw new Error('仍有未确认的期权订单，交易前请到交易所核对');
      } catch (error) { errors.push(describe(error)); }
      try { await syncPositions(); } catch (error) { errors.push(describe(error)); }
      if (positionsError) errors.push(positionsError);
      reconciliation = { error: errors.length ? [...new Set(errors)].join('；') : null, lastSuccessAt: errors.length ? reconciliation.lastSuccessAt : now() };
    });
  }

  // ---- Friday auto-open -------------------------------------------------------------------------------------------
  /**
   * The workbench's scheduler: inside the Friday window, once per ISO week, a plan with the configured quantity and
   * structure and its default net limit is confirmed under request id scheduled-<week>. A refusal (a task or order still
   * open, a tracked strategy, a stale market, a limit) is tried again on the next tick while the window lasts; a week
   * whose window passed without an admitted opening sends one Feishu message.
   */
  async function autoOpenTick(): Promise<void> {
    const at = now(), week = isoWeek(at), schedule = state.schedule;
    if (autoOpenEnabled() && !shutdown && inOpenWindow(at) && schedule.lastOpenWeek !== week) {
      try {
        const plan = await createPlan({ operation: 'open' });
        await startTask({ planId: plan.planId, requestId: `scheduled-${week}`, confirmLive: true }, { scheduled: true });
        log(`期权定时开仓已确认（${week}）`);
      } catch (error) {
        const message = describe(error);
        if (schedule.attemptWeek !== week || schedule.lastError !== message) log(`期权定时开仓未执行（${week}）：${message}`);
        Object.assign(schedule, { attemptWeek: week, lastError: message, lastAttemptAt: now() });
        save();
      }
      return;
    }
    // Once per missed week, whether or not a check ran in the window (the service down, a window shorter than a tick);
    // not for a week whose window had passed before the page turned it on.
    const last = lastWindow(at), missed = isoWeek(last.start);
    if (autoOpenEnabled() && at >= last.end && schedule.lastOpenWeek !== missed && schedule.notifiedWeek !== missed && ((schedule.enabledAt ?? -Infinity) <= last.start || schedule.attemptWeek === missed)) {
      try {
        notify(`期权定时开仓未执行（${missed}）：${schedule.attemptWeek === missed ? schedule.lastError ?? '原因未知' : '窗口内没有执行检查（服务没在运行，或窗口短于 5 秒的检查间隔）'}`);
        schedule.notifiedWeek = missed;
        save();
      } catch (error) { log(`期权飞书通知未能写入：${describe(error)}`); }
    }
  }

  /** The page's switch; it outlives restarts and overrides config.json until changed again. */
  function setAutoOpen(enabled: boolean) {
    state.schedule.enabled = enabled;
    state.schedule.enabledAt = enabled ? now() : null;
    save();
    log(`期权定时开仓已在页面${enabled ? '开启' : '关闭'}`);
    return scheduleView();
  }
  function scheduleView() {
    const schedule = state.schedule;
    return {
      enabled: autoOpenEnabled(), source: schedule.enabled === null ? 'config' as const : 'page' as const, configEnabled: autoOpen.enabled,
      hourUtc: autoOpen.hourUtc, minuteUtc: autoOpen.minuteUtc, windowSeconds: autoOpen.windowSeconds, marketFallback: settings.marketFallback ?? false,
      nextAt: nextOpenAt(), inWindow: inOpenWindow(), waiting: inOpenWindow() && schedule.lastOpenWeek !== isoWeek(now()), lastOpenWeek: schedule.lastOpenWeek,
      lastError: schedule.attemptWeek === isoWeek(now()) && schedule.attemptWeek !== schedule.lastOpenWeek ? { week: schedule.attemptWeek, message: schedule.lastError, at: schedule.lastAttemptAt } : null,
    };
  }

  async function refreshHealth(): Promise<void> {
    health = await readAccountHealth(client, state.pmBaseline, now(), AbortSignal.timeout(READ_MS));
    if (!health.available) log(`期权账户健康度读取失败：${health.message}`);
  }

  /** Stops every running task and waits for its orders to be cancelled and read back. */
  async function close(): Promise<void> {
    shutdown = true;
    for (const task of Object.values(state.tasks)) if (isActive(task.status) && workers.has(task.id)) stopTask(task.id);
    await Promise.allSettled([...workers.values()]);
  }

  // ---- views -----------------------------------------------------------------------------------------------------
  function marketView(expiry: number | null) {
    const snapshot = market.snapshot(), error = market.error();
    const rows = snapshot?.rows ?? [];
    const expiries = [...new Set(rows.map(row => row.expiry))].sort((a, b) => a - b);
    const selected = expiry !== null && expiries.includes(expiry) ? expiry : expiries.find(value => isSunday(value)) ?? expiries[0] ?? null;
    return {
      at: snapshot?.at ?? null, stale: !snapshot || now() - snapshot.at > QUOTE_STALE_MS, index: snapshot?.index ?? null, error: error?.message ?? null,
      expiries, expiry: selected,
      rows: rows.filter(row => row.expiry === selected).sort((a, b) => a.strike - b.strike || a.optionType.localeCompare(b.optionType)).map(row => ({ ...row, ...snapshot!.greeks.get(row.symbol) })),
    };
  }
  function previewView(quantity: string | null, mode: StrategyMode | null) {
    const view = preview(quantity ?? settings.legQty, mode ?? settings.strategyMode);
    return { preview: view, riskProblem: riskProblem(view) };
  }
  function stateView() {
    const snapshot = market.snapshot();
    const tasks = Object.values(state.tasks).sort((a, b) => b.acceptedAt - a.acceptedAt).slice(0, 30);
    const orders = Object.entries(state.journal).map(([link, entry]) => ({ link, ...entry })).sort((a, b) => b.createdAt - a.createdAt).slice(0, 60);
    return {
      settings: { maxRiskUsd: settings.maxRiskUsd, maxMarginUsd: settings.maxMarginUsd, legQty: settings.legQty, strategyMode: settings.strategyMode, orderTimeoutSeconds: settings.orderTimeoutMs / 1000, feeRate: settings.estimates.feeRate, marginBufferPct: settings.estimates.marginBufferPct, marginMode: settings.estimates.marginMode },
      account: `***${uid.slice(-4)}`,
      busy: admitting || held || Object.values(state.tasks).some(task => isActive(task.status)) || !rfqFinished(state.rfq),
      rfqActive: !rfqFinished(state.rfq),
      tasks, orders, schedule: scheduleView(),
      tracked: { groupId: state.tracked.groupId, legs: Object.entries(state.tracked.sizes).map(([key, size]) => ({ symbol: key.slice(0, key.lastIndexOf('|')), side: key.slice(key.lastIndexOf('|') + 1), size })), mode: state.tracked.groupId ? state.tasks[state.tracked.groupId]?.mode ?? null : null },
      positions: positions ? { rows: positions.rows, at: positions.at } : null, positionsError,
      greeks: summarizeGreeks(positions?.rows ?? null, snapshot?.greeks ?? new Map(), { marketAt: snapshot?.at ?? null, now: now(), staleMs: QUOTE_STALE_MS }),
      health, pmBaseline: state.pmBaseline,
      reconciliation: { ...reconciliation, pendingOrders: Object.values(state.journal).filter(entry => !entry.terminal).length },
      executions: state.executions.slice(0, 50),
      market: { at: snapshot?.at ?? null, stale: !snapshot || now() - snapshot.at > QUOTE_STALE_MS, error: market.error()?.message ?? null },
    };
  }

  /** The 收益 page: every opening with its amounts, samples and fills, and the per-currency curve of those held to expiry. */
  function performanceView() {
    const at = now();
    const report = buildPerformance(performanceInput(at));
    let firstAt: number | null = null;
    for (const record of ledger.values()) if (firstAt === null || record.execTime < firstAt) firstAt = record.execTime;
    return {
      account: `***${uid.slice(-4)}`, sampleSeconds: PERFORMANCE_SAMPLE_MS / 1000, unassignedCloses: report.unassignedCloses,
      groups: report.groups.map(group => ({ ...group, samples: thinPoints(group.samples, GROUP_POINTS, SAMPLE_GAP_MS, point => point.pnl) })),
      series: report.series.map(series => ({ ...series, points: thinPoints(series.points, SERIES_POINTS, SAMPLE_GAP_MS, point => point.cumulative) })),
      ledger: { count: ledger.size, firstAt },
      positionsAt: positions?.at ?? null, error: performanceError,
    };
  }

  return { createPlan, startTask, stopTask, createRfq, executeQuote, cancelRfq, rfqTick, reconcileOnce, refreshHealth, autoOpenTick, setAutoOpen, performanceTick, close, marketView, previewView, stateView, performanceView, rfqView, state: () => state };
}
export type OptionsEngine = ReturnType<typeof createOptionsEngine>;
