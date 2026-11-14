// Live mode of the oil spread rules (docs/oil.md 7.3, O2b): the stored live state, the executor intent a rule sends, and
// what a finished job means for the rule. Orders go only through the executor's own preview and confirm, so its caps,
// account checks and price protection apply to an automatic job exactly as to one sent from the page.
import type { PositionSide, Venue } from '../contracts.ts';
import { cmp, sub } from '../decimal.ts';
import type { BookRow, Direction, RuleAction, RuleConfig } from './rules.ts';

export const PHASES = ['idle', 'opening', 'holding', 'closing', 'review'] as const;
export type Phase = typeof PHASES[number];
/** Failures in a row (rejected previews or confirms) that disable a live rule, as in the workbench. */
export const FAILURE_LIMIT = 3;
/** How long a rule waits after a failure, a locked contract or a job that filled nothing before it judges again. */
export const RETRY_MS = 60_000;
/** An automatic job's longest run; the executor ends it at this deadline. */
export const JOB_TIMEOUT_MS = 60_000;
/** Lead leg first: CL is the same-venue preset's default lead. */
export const RULE_SYMBOLS = ['CLUSDT', 'BZUSDT'] as const;
export type RuleSymbol = typeof RULE_SYMBOLS[number];
const FINAL = ['completed', 'failed', 'stopped', 'attention'];
const ZERO = '0';

/** The executor account a leg used, compared before a close so a rule never closes on a different account than it opened. */
export interface AccountRef { accountKey: string; credentialVersion: number }
/** One leg the rule holds: what its opening job filled, less what its closing jobs filled. */
export interface HeldLeg extends AccountRef { symbol: RuleSymbol; side: PositionSide; quantity: string; barrels: string }
/** Written before the confirm is called; a restart replays the confirm with the same request id. */
export interface Pending { action: RuleAction; requestId: string; previewId: string; at: number; day: string; accounts: AccountRef[] }
/** The job the rule follows until it ends. */
export interface Tracked { id: string; action: RuleAction; at: number; day: string; accounts: AccountRef[] }
export interface LiveState {
  enabled: boolean;
  phase: Phase;
  pending: Pending | null;
  job: Tracked | null;
  held: HeldLeg[] | null;
  /** Opens confirmed on a Beijing calendar day. */
  opens: { day: string; count: number };
  failures: number;
  retryAt: number | null;
  /** Why the rule stopped or waits for review. */
  reason: string | null;
}

/** The slices of the executor a rule uses (src/executor.ts). */
export interface RulePlanLeg extends AccountRef { symbol: string; quantity: string; quote: { bid: string; ask: string; receivedAt: number } }
export interface RulePlan { id: string; legs: readonly RulePlanLeg[]; notional?: string; barrels?: string }
export interface RuleJobLeg { symbol: string; filledQuantity: string; filledBarrels: string }
export interface RuleExecutor {
  preview(intent: unknown, session: string): Promise<RulePlan>;
  confirm(body: unknown, session: string): { duplicate: boolean; job: { id: string } };
  jobView(id: string): { status: string; reason?: string | null; legs: readonly RuleJobLeg[] };
  /** The job a confirm of this preview with this request id created for this session, or null; never creates one. */
  confirmedJob(requestId: string, previewId: string, session: string): string | null;
}

export const idleLive = (): LiveState => ({ enabled: false, phase: 'idle', pending: null, job: null, held: null, opens: { day: '', count: 0 }, failures: 0, retryAt: null, reason: null });
export const isFinal = (status: string): boolean => FINAL.includes(status);
export const ruleSession = (id: string): string => `oil-rule:${id}`;
/** Beijing calendar day (UTC+8, no daylight saving) of a time. */
export const beijingDay = (at: number): string => new Date(at + 8 * 3_600_000).toISOString().slice(0, 10);
export const opensOn = (live: LiveState, day: string): number => live.opens.day === day ? live.opens.count : 0;
export const actionName = (action: RuleAction): string => action === 'open' ? '开仓' : '平仓';
export const PHASE_NAMES: Record<Phase, string> = { idle: '等待开仓', opening: '开仓中', holding: '持仓中', closing: '平仓中', review: '待核对' };

/** Position side of each contract: selling the spread (short) is short BZ, long CL. */
export const legSides = (direction: Direction): Record<RuleSymbol, PositionSide> => direction === 'short' ? { CLUSDT: 'long', BZUSDT: 'short' } : { CLUSDT: 'short', BZUSDT: 'long' };

/** The executor intent: same venue, CL lead then BZ hedge, both at market; an open by barrels, a close by the held quantities. */
export function ruleIntent(config: RuleConfig, action: RuleAction, held: readonly HeldLeg[] | null) {
  const sides = legSides(config.direction);
  if (action === 'close' && !held) throw new Error('没有持有记录，无法平仓');
  return {
    market: 'oil', preset: 'same-exchange', action, timeoutMs: JOB_TIMEOUT_MS,
    legs: RULE_SYMBOLS.map(symbol => ({
      venue: config.venue, symbol, side: sides[symbol], orderType: 'market',
      ...(action === 'open' ? { barrels: config.barrels } : { quantity: held!.find(leg => leg.symbol === symbol)!.quantity }),
    })),
  };
}

/** The preview's legs in the planned order, or null when they are not CL then BZ. */
export function planLegs(plan: RulePlan): [RulePlanLeg, RulePlanLeg] | null {
  const [lead, hedge] = plan.legs;
  return plan.legs.length === 2 && lead?.symbol === RULE_SYMBOLS[0] && hedge?.symbol === RULE_SYMBOLS[1] ? [lead, hedge] : null;
}
/** The preview's books as the rule reads books, for the recheck before confirm. */
export const planRows = (venue: Venue, legs: readonly RulePlanLeg[]): BookRow[] => legs.map(leg => ({ venue, symbol: leg.symbol, bid: leg.quote.bid, ask: leg.quote.ask, receivedAt: leg.quote.receivedAt, error: null }));

/** A held leg's account against the preview's: a changed account or credential means another account would be closed. */
export const sameAccount = (a: AccountRef, b: AccountRef): boolean => a.accountKey === b.accountKey && a.credentialVersion === b.credentialVersion;

export type Outcome =
  | { kind: 'hold'; held: HeldLeg[]; message: string }
  | { kind: 'flat'; message: string }
  | { kind: 'revert'; message: string }
  | { kind: 'review'; message: string };

const STATUS_NAMES: Record<string, string> = { completed: '已完成', failed: '失败', stopped: '已停止', attention: '转人工' };

/** What a finished job leaves the rule with; anything that does not add up goes to review. */
export function settleJob(job: { status: string; reason?: string | null; legs: readonly RuleJobLeg[] }, tracked: Tracked, held: readonly HeldLeg[] | null, direction: Direction): Outcome {
  const label = `${actionName(tracked.action)}任务 ${tracked.id}`, status = STATUS_NAMES[job.status] ?? job.status;
  const review = (why: string): Outcome => ({ kind: 'review', message: `${label}${status}，${why}；规则已停用，请在执行进度与交易所核对后重置` });
  const legs = RULE_SYMBOLS.map(symbol => job.legs.find(leg => leg.symbol === symbol));
  if (legs.some(leg => !leg)) return review('任务两腿与规则不符');
  const filled = legs.map(leg => leg!.filledQuantity), barrels = legs.map(leg => leg!.filledBarrels);
  const none = filled.every(quantity => cmp(quantity, ZERO) === 0);
  if (job.status !== 'completed') {
    // failed or stopped with nothing filled is a job that sent nothing or whose lead IOC did not fill: try again later.
    if (job.status !== 'attention' && none) return { kind: 'revert', message: `${label}${status}，两腿都没有成交${job.reason ? `（${job.reason.slice(0, 120)}）` : ''}；${RETRY_MS / 1000} 秒后再判断` };
    return review(none ? '任务转人工' : `已成交 CL ${filled[0]}、BZ ${filled[1]}`);
  }
  if (none) return { kind: 'revert', message: `${label}${status}，但两腿都没有成交；${RETRY_MS / 1000} 秒后再判断` };
  if (cmp(barrels[0]!, barrels[1]!) !== 0) return review(`两腿成交桶数不等（CL ${barrels[0]}、BZ ${barrels[1]}）`);
  if (tracked.action === 'open') {
    const sides = legSides(direction);
    if (tracked.accounts.length !== 2) return review('开仓账户记录缺失');
    return {
      kind: 'hold', message: `开仓完成：CL ${filled[0]}、BZ ${filled[1]}（每腿 ${barrels[0]} 桶），进入持仓中`,
      held: RULE_SYMBOLS.map((symbol, index) => ({ symbol, side: sides[symbol], quantity: filled[index]!, barrels: barrels[index]!, ...tracked.accounts[index]! })),
    };
  }
  if (!held) return review('规则没有持有记录');
  const left = held.map((leg, index) => ({ ...leg, quantity: sub(leg.quantity, filled[index]!), barrels: sub(leg.barrels, barrels[index]!) }));
  if (left.some(leg => cmp(leg.quantity, ZERO) < 0 || cmp(leg.barrels, ZERO) < 0)) return review('成交超过规则持有量');
  if (left.every(leg => cmp(leg.quantity, ZERO) === 0)) return { kind: 'flat', message: `平仓完成：CL ${filled[0]}、BZ ${filled[1]}，回到等待开仓` };
  if (left.some(leg => cmp(leg.quantity, ZERO) === 0) || cmp(left[0]!.barrels, left[1]!.barrels) !== 0) return review(`平仓后两腿剩余不等（CL ${left[0]!.quantity}、BZ ${left[1]!.quantity}）`);
  return { kind: 'hold', held: left, message: `部分平仓：CL ${filled[0]}、BZ ${filled[1]}，剩余每腿 ${left[0]!.barrels} 桶，继续等平仓条件` };
}

// ---- stored state, read defensively ----------------------------------------------------------------------------------
type Raw = Record<string, unknown>;
const object = (value: unknown): Raw | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Raw : null;
const DECIMAL = /^\d{1,18}(\.\d{1,18})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const accountOf = (value: unknown): AccountRef | null => {
  const raw = object(value);
  return raw && typeof raw.accountKey === 'string' && raw.accountKey.length > 0 && raw.accountKey.length <= 200 && Number.isSafeInteger(raw.credentialVersion)
    ? { accountKey: raw.accountKey, credentialVersion: raw.credentialVersion as number } : null;
};
const accountsOf = (value: unknown): AccountRef[] | null => {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const list = value.map(accountOf);
  return list.every(Boolean) ? list as AccountRef[] : null;
};
const actionOf = (value: unknown): RuleAction | null => value === 'open' || value === 'close' ? value : null;
function pendingOf(value: unknown): Pending | null {
  const raw = object(value), action = actionOf(raw?.action), accounts = accountsOf(raw?.accounts);
  if (!raw || !action || !accounts || typeof raw.requestId !== 'string' || !UUID.test(raw.requestId) || typeof raw.previewId !== 'string' || !UUID.test(raw.previewId) || !Number.isFinite(raw.at) || typeof raw.day !== 'string' || !DAY.test(raw.day)) return null;
  return { action, requestId: raw.requestId, previewId: raw.previewId, at: raw.at as number, day: raw.day, accounts };
}
function trackedOf(value: unknown): Tracked | null {
  const raw = object(value), action = actionOf(raw?.action), accounts = accountsOf(raw?.accounts);
  if (!raw || !action || !accounts || typeof raw.id !== 'string' || !UUID.test(raw.id) || !Number.isFinite(raw.at) || typeof raw.day !== 'string' || !DAY.test(raw.day)) return null;
  return { id: raw.id, action, at: raw.at as number, day: raw.day, accounts };
}
function heldOf(value: unknown): HeldLeg[] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const legs = value.map((item, index) => {
    const raw = object(item), account = accountOf(item);
    if (!raw || !account || raw.symbol !== RULE_SYMBOLS[index] || (raw.side !== 'long' && raw.side !== 'short')) return null;
    if (typeof raw.quantity !== 'string' || !DECIMAL.test(raw.quantity) || typeof raw.barrels !== 'string' || !DECIMAL.test(raw.barrels)) return null;
    return { symbol: RULE_SYMBOLS[index]!, side: raw.side, quantity: raw.quantity, barrels: raw.barrels, ...account } satisfies HeldLeg;
  });
  return legs.every(Boolean) ? legs as HeldLeg[] : null;
}

/** A live rule's stored state; one that does not add up is held for review with what can still be read. */
export function liveOf(value: unknown): LiveState {
  const raw = object(value) ?? {};
  const phase = (PHASES as readonly unknown[]).includes(raw.phase) ? raw.phase as Phase : null;
  const opens = object(raw.opens);
  const live: LiveState = {
    enabled: raw.enabled === true, phase: phase ?? 'review', pending: pendingOf(raw.pending), job: trackedOf(raw.job), held: heldOf(raw.held),
    opens: opens && typeof opens.day === 'string' && DAY.test(opens.day) && Number.isSafeInteger(opens.count) && (opens.count as number) >= 0 ? { day: opens.day, count: opens.count as number } : { day: '', count: 0 },
    failures: Number.isSafeInteger(raw.failures) && (raw.failures as number) >= 0 ? raw.failures as number : 0,
    retryAt: Number.isFinite(raw.retryAt) ? raw.retryAt as number : null,
    reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 400) : null,
  };
  const busy = live.phase === 'opening' || live.phase === 'closing';
  const problem = phase === null ? '阶段'
    : busy && !live.pending && !live.job ? '下单记录'
    : (live.phase === 'holding' || live.phase === 'closing') && !live.held ? '持有记录'
    : (live.phase === 'idle' || live.phase === 'opening') && live.held ? '持有记录'
    : !busy && (live.pending || live.job) ? '下单记录'
    : live.pending && live.job ? '下单记录'
    : (live.pending && (live.pending.action === 'open') !== (live.phase === 'opening')) || (live.job && (live.job.action === 'open') !== (live.phase === 'opening')) ? '下单记录'
    : null;
  if (problem) return { ...live, phase: 'review', enabled: false, pending: null, job: null, reason: `实盘状态的${problem}无法读取；请在执行进度与交易所核对后重置` };
  return live;
}
