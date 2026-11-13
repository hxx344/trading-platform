// The options engine: plans, execution tasks, the order journal, the tracked strategy and reconciliation. Ported from the
// workbench (modules/greeks/app trade_tasks.py, engine.py, reconciliation.py, commit 160e932) without its demo mode,
// RFQ, scheduled auto-open or market fallback (docs/options.md §1). One lock serializes plans, task runs and
// reconciliation as the workbench's engine lock does; a stop never waits for it. Every change to the state document is
// written before it is acted on, so a restart finds every order the service could have sent.
import { ContractError } from '../contracts.ts';
import { add, cmp, decimal, isMultiple, isZero, min as minDecimal, sub } from '../decimal.ts';
import { describe } from '../live/values.ts';
import { parseExecution, parsePositions, pmMetrics, readAccountHealth, summarizeGreeks, type AccountHealth, type ExecutionRecord, type PmBaseline, type Position } from './account.ts';
import type { OptionsClient, Row } from './client.ts';
import { QUOTE_STALE_MS, isSunday, type ChainSnapshot, type OptionMarket, type OptionRow, type OptionType } from './market.ts';
import { followOrder, reconcileOrder, roundToTick, type OrderOutcome, type OrderStatus } from './orders.ts';
import type { OptionsStore } from './store.ts';
import { StrategyError, buildStrategy, maximumLoss, reserveShortMargin, validateStructure, type Estimates, type MarginContext, type Preview, type RiskLeg, type Side, type StrategyMode } from './strategy.ts';

export const PLAN_TTL_MS = 30_000;
export const POLL_MS = 1_000;
export const SAMPLE_MS = 3_000;
/** Bybit's receive window is 5 s; two minutes leaves room for clock skew and a slow answer. */
export const MISSING_SETTLE_MS = 120_000;
/** Past this age "not found" proves nothing (order history is read for the last 7 days by default): it stays unknown. */
export const MISSING_SETTLE_MAX_AGE_MS = 6 * 24 * 3_600_000;
const HISTORY_LIMIT_MS = 180 * 86_400_000;
const RETIRE_BUDGET_MS = 120_000;
const READ_MS = 25_000;
const EXECUTIONS_KEPT = 100;
const EPSILON = 1e-9;

export type TaskStatus = 'accepted' | 'running' | 'stopping' | 'recovering' | 'recovery_needed' | 'completed' | 'partial' | 'stopped' | 'failed';
export const ACTIVE_STATUSES: readonly TaskStatus[] = ['accepted', 'running', 'stopping', 'recovering', 'recovery_needed'];
const isActive = (status: TaskStatus): boolean => ACTIVE_STATUSES.includes(status);
export type Operation = 'open' | 'close';

export interface PlanLeg { symbol: string; side: Side; qty: string; expiry: number; strike: number; optionType: OptionType; referencePrice: number }
interface NetLeg extends PlanLeg { priceBound: number; feePriceCeiling?: number }
interface FeeContext { index: number; feeRate: number; feeCapPct: number }
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
}
export interface JournalEntry {
  taskId: string; symbol: string; side: Side; qty: string; reduceOnly: boolean; tick: string;
  status: OrderStatus; terminal: boolean; filledQty: string; orderId: string; createdAt: number; updatedAt: number; message?: string; price?: string;
}
export interface OptionsState {
  uid: string; tasks: Record<string, Task>; journal: Record<string, JournalEntry>;
  tracked: { groupId: string | null; sizes: Record<string, string> }; pmBaseline: PmBaseline | null; executions: ExecutionRecord[];
}

export interface EngineSettings { maxRiskUsd: number; maxMarginUsd: number; legQty: string; strategyMode: StrategyMode; orderTimeoutMs: number; estimates: Estimates }
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

/** Restores the saved document; a missing one starts empty, another account's refuses start. */
function restore(raw: unknown, uid: string): OptionsState {
  if (raw === null) return { uid, tasks: {}, journal: {}, tracked: { groupId: null, sizes: {} }, pmBaseline: null, executions: [] };
  const value = raw as Partial<OptionsState>;
  const record = (item: unknown) => typeof item === 'object' && item !== null && !Array.isArray(item);
  if (!record(value) || typeof value.uid !== 'string' || !record(value.tasks) || !record(value.journal) || !record(value.tracked) || !record(value.tracked!.sizes) || !Array.isArray(value.executions)) throw new Error('期权状态库内容不完整');
  if (value.uid !== uid) throw new Error(`期权状态库属于另一个 Bybit 账户（***${value.uid.slice(-4)}），拒绝启动`);
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
  function requireIdle(): void {
    if (shutdown) conflict('shutting_down', '服务正在停止');
    if (Object.values(state.journal).some(entry => !entry.terminal)) conflict('orders_unresolved', '仍有未确认的期权订单，等对账核对后再交易');
    if (admitting || held || Object.values(state.tasks).some(task => isActive(task.status))) conflict('operation_active', '另一个期权交易操作正在进行或等待核对');
  }
  async function admitted<T>(work: () => Promise<T>): Promise<T> {
    requireIdle();
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
        matched.push({ symbol, side, qty: row.qty, openTime: row.openTime, closeTime: row.closeTime });
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

  async function startTask(request: TaskRequest) {
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
      };
      state.tasks[id] = task;
      save(); // Durable admission precedes dispatch.
      announce(task);
      const worker = locked(() => runTask(id)).finally(() => workers.delete(id));
      workers.set(id, worker);
      return taskResponse(task);
    });
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

  async function runTask(id: string): Promise<void> {
    const task = state.tasks[id]!;
    let error: string | null = null, done = false;
    let sampler: Promise<void> | null = null;
    try {
      try {
        checkStop(task);
        Object.assign(task, { status: 'running', startedAt: now() });
        save();
        freshSnapshot();
        const legs = Object.values(task.legs);
        sampler = (async () => {
          while (!done) {
            await new Promise<void>(resolve => { const timer = setTimeout(resolve, sampleMs); timer.unref?.(); });
            if (done) break;
            try { await loadExecutions(task.links); } catch (failure) { log(`期权成交明细刷新失败：${describe(failure)}`); }
          }
        })();
        // Buys before sells: an opening's wings fill before its short legs go out, a closing buys its shorts back before
        // selling the wings, so a stop, a limit or a timeout can never leave a short leg without its wing. A sell goes
        // out only when every buy filled in full; a short strangle (sells only) or its closing (buys only) is one round.
        const indexed = legs.map((leg, index) => ({ leg, link: task.links[index]! }));
        const round = (side: 'Buy' | 'Sell') => Promise.allSettled(indexed.filter(item => item.leg.side === side).map(item => runLeg(task, item.leg, item.link)));
        const results = await round('Buy');
        const errors: string[] = [];
        if (results.every(result => result.status === 'fulfilled' && result.value.status === 'filled')) results.push(...await round('Sell'));
        else if (indexed.some(item => item.leg.side === 'Sell')) errors.push('买入腿未全部成交，卖出腿未下单（避免留下无保护的卖出）');
        errors.unshift(...results.flatMap(result => result.status === 'rejected' ? [describe(result.reason)] : result.value.message && result.value.status !== 'filled' ? [result.value.message] : []));
        if (errors.length) error = [...new Set(errors)].join('；');
        try { await loadExecutions(task.links); } catch (failure) { log(`期权成交明细刷新失败：${describe(failure)}`); }
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
    const what = `期权${OPERATION_NAMES[task.type]}任务 ${task.id}`;
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

  async function loadExecutions(links: readonly string[]): Promise<void> {
    const signal = AbortSignal.timeout(READ_MS);
    const groups = await Promise.allSettled([...new Set(links)].map(link => client.executions(link, signal)));
    const records: ExecutionRecord[] = [];
    for (const group of groups) {
      if (group.status === 'rejected') { log(`部分期权成交明细读取失败，保留已有记录：${describe(group.reason)}`); continue; }
      for (const row of group.value) {
        const record = parseExecution(row);
        const owner = Object.hasOwn(state.journal, record.orderLinkId) ? state.journal[record.orderLinkId] : undefined;
        const task = owner ? state.tasks[owner.taskId] : undefined;
        const reduceOnly = task?.type === 'close' || record.orderLinkId.startsWith('tpo-close-');
        const baseline = reduceOnly ? undefined : task?.legs[record.symbol];
        const chainPrice = baseline?.chainPrice ?? null;
        const chainPriceDiff = chainPrice !== null && baseline ? (baseline.side === 'Sell' ? 1 : -1) * (record.execPrice - chainPrice) * record.execQty : null;
        records.push({ ...record, reduceOnly, taskId: task?.id ?? null, openingGroup: task?.openingGroup ?? null, chainPrice, chainPriceDiff });
      }
    }
    if (!records.length) return;
    const merged = new Map(state.executions.map(item => [item.execId, item]));
    for (const record of records) merged.set(record.execId, record);
    const next = [...merged.values()].sort((a, b) => b.execTime - a.execTime).slice(0, EXECUTIONS_KEPT);
    if (sortedJson(next) === sortedJson(state.executions)) return;
    state.executions = next;
    save();
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
      busy: admitting || held || Object.values(state.tasks).some(task => isActive(task.status)),
      tasks, orders,
      tracked: { groupId: state.tracked.groupId, legs: Object.entries(state.tracked.sizes).map(([key, size]) => ({ symbol: key.slice(0, key.lastIndexOf('|')), side: key.slice(key.lastIndexOf('|') + 1), size })), mode: state.tracked.groupId ? state.tasks[state.tracked.groupId]?.mode ?? null : null },
      positions: positions ? { rows: positions.rows, at: positions.at } : null, positionsError,
      greeks: summarizeGreeks(positions?.rows ?? null, snapshot?.greeks ?? new Map(), { marketAt: snapshot?.at ?? null, now: now(), staleMs: QUOTE_STALE_MS }),
      health, pmBaseline: state.pmBaseline,
      reconciliation: { ...reconciliation, pendingOrders: Object.values(state.journal).filter(entry => !entry.terminal).length },
      executions: state.executions.slice(0, 50),
      market: { at: snapshot?.at ?? null, stale: !snapshot || now() - snapshot.at > QUOTE_STALE_MS, error: market.error()?.message ?? null },
    };
  }

  return { createPlan, startTask, stopTask, reconcileOnce, refreshHealth, close, marketView, previewView, stateView, state: () => state };
}
export type OptionsEngine = ReturnType<typeof createOptionsEngine>;
