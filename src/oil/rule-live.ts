// Live mode of the spread rules (docs/oil.md 7.3, O2b; hynix docs/hynix.md 8.2): the stored live state, the executor intent
// a rule sends, and what a finished job means for the rule. Orders go only through the executor's own preview and confirm, so its caps,
// account checks and price protection apply to an automatic job exactly as to one sent from the page.
import type { PositionSide, Venue } from '../contracts.ts';
import { cmp, fromUnits, sub, units } from '../decimal.ts';
import { HYNIX_RATIO } from '../hynix/sizing.ts';
import type { BookRow, Direction, RuleAction, RuleConfig } from './rules.ts';

export const PHASES = ['idle', 'opening', 'holding', 'closing', 'review'] as const;
export type Phase = typeof PHASES[number];
/** Failures in a row (rejected previews or confirms) that disable a live rule, as in the workbench. */
export const FAILURE_LIMIT = 3;
/** How long a rule waits after a failure, a locked contract or a job that filled nothing before it judges again. */
export const RETRY_MS = 60_000;
/** An automatic job's longest run; the executor ends it at this deadline. */
export const JOB_TIMEOUT_MS = 60_000;
/** An automatic job's longest run including its batch intervals; the intent allows up to an hour. */
export const MAX_RULE_JOB_MS = 3_600_000;
export const RULE_MARKETS = ['oil', 'hynix'] as const;
export type RuleMarket = typeof RULE_MARKETS[number];
/**
 * Each market's two contracts, lead (sent first) then hedge: oil leads with CL (the same-venue preset's default lead), hynix
 * with the ADR (the hynix form's default and the workbench's order). The premium leg is the one sold when selling the spread.
 */
export const RULE_LEGS: Record<RuleMarket, readonly [string, string]> = { oil: ['CLUSDT', 'BZUSDT'], hynix: ['SKHYUSDT', 'SKHYNIXUSDT'] };
export const PREMIUM_LEG: Record<RuleMarket, string> = { oil: 'BZUSDT', hynix: 'SKHYUSDT' };
export const BASE_LEG: Record<RuleMarket, string> = { oil: 'CLUSDT', hynix: 'SKHYNIXUSDT' };
export const LEG_LABELS: Record<string, string> = { CLUSDT: 'CL', BZUSDT: 'BZ', SKHYUSDT: 'ADR', SKHYNIXUSDT: '正股' };
export const MARKET_LABELS: Record<RuleMarket, string> = { oil: '原油', hynix: '海力士' };
const legLabel = (symbol: string): string => LEG_LABELS[symbol] ?? symbol;
const FINAL = ['completed', 'failed', 'stopped', 'attention'];
const ZERO = '0';

/** The executor account a leg used, compared before a close so a rule never closes on a different account than it opened. */
export interface AccountRef { accountKey: string; credentialVersion: number }
/** One leg the rule holds: what its opening job filled, less what its closing jobs filled. */
export interface HeldLeg extends AccountRef { symbol: string; side: PositionSide; quantity: string; barrels: string }
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
export interface RulePlan { id: string; legs: readonly RulePlanLeg[]; notional?: string; barrels?: string; batches?: readonly string[] }
export interface RuleJobLeg { symbol: string; filledQuantity: string; filledBarrels: string }
export interface RuleExecutor {
  preview(intent: unknown, session: string): Promise<RulePlan>;
  confirm(body: unknown, session: string): { duplicate: boolean; job: { id: string } };
  /** endCode: why a job that filled nothing ended, when it was the price bound ('price_moved', 'lead_unfilled'). */
  jobView(id: string): { status: string; reason?: string | null; endCode?: string | null; legs: readonly RuleJobLeg[] };
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

/** Position side of each contract: selling the spread (short) is short the premium leg (BZ, the ADR), long the base leg. */
export const legSides = (market: RuleMarket, direction: Direction): Record<string, PositionSide> => direction === 'short'
  ? { [PREMIUM_LEG[market]]: 'short', [BASE_LEG[market]]: 'long' } : { [PREMIUM_LEG[market]]: 'long', [BASE_LEG[market]]: 'short' };

/** The job's longest run: one minute, plus the batch intervals when the rule splits its orders (docs/hynix.md 8.2). */
export const ruleTimeout = (config: Pick<RuleConfig, 'batches'>): number => JOB_TIMEOUT_MS + (config.batches ? (config.batches.count - 1) * config.batches.intervalMs : 0);

const SCALE = 10n ** 18n;
const divCeil = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/**
 * Per-leg price bounds that keep the spread on the threshold, as the workbench's boundsFor (server/trading-auto.mjs): the
 * slack between the executable spread and the threshold is split between the legs, so any fill no worse than both bounds
 * still meets the threshold (L100). Selling the spread, the premium leg sells no lower than its bound and the base leg buys no
 * higher; buying it is the reverse. The bounds here are exact, rounded toward safety at 18 digits; the executor rounds each
 * inward on its tick and keeps the tighter of it and its basis-point band, for every batch (docs/hynix.md 8.2). A sell
 * bound at or below zero bounds nothing and is left out. Null when the books do not meet the threshold.
 */
export function thresholdBounds(market: RuleMarket, sell: boolean, threshold: string, premium: { bid: string; ask: string }, base: { bid: string; ask: string }): Record<string, string> | null {
  const limit = units(threshold), factor = limit + 100n * SCALE, scale = HYNIX_RATIO * 100n * SCALE;
  if (market === 'hynix' && factor <= 0n) return null;
  // Premium price at the threshold for a base price, and base price at the threshold for a premium price.
  const premiumAt = (b: bigint, up: boolean) => market === 'hynix' ? (up ? divCeil(factor * b, scale) : factor * b / scale) : b + limit;
  const baseAt = (p: bigint, up: boolean) => market === 'hynix' ? (up ? divCeil(p * scale, factor) : p * scale / factor) : p - limit;
  const bounds: Record<string, string> = {};
  const put = (symbol: string, value: bigint, buying: boolean): boolean => {
    if (value > 0n) bounds[symbol] = fromUnits(value);
    return value > 0n || !buying;
  };
  if (sell) {
    const bid = units(premium.bid), floor = premiumAt(units(base.ask), true);
    if (bid < floor) return null;
    const premiumLimit = bid - (bid - floor) / 2n;
    return put(PREMIUM_LEG[market], premiumLimit, false) && put(BASE_LEG[market], baseAt(premiumLimit, false), true) ? bounds : null;
  }
  const ask = units(premium.ask), ceiling = premiumAt(units(base.bid), false);
  if (ask > ceiling) return null;
  const premiumLimit = ask + (ceiling - ask) / 2n;
  return put(PREMIUM_LEG[market], premiumLimit, true) && put(BASE_LEG[market], baseAt(premiumLimit, true), false) ? bounds : null;
}

/**
 * The executor intent: same venue, lead then hedge, both at market; an open by barrels (oil) or equal USDT notional (hynix),
 * a close by the held quantities; the rule's batches on both (a close fits them to what is held, down to one batch); each
 * leg held to its threshold bound.
 */
export function ruleIntent(config: RuleConfig, action: RuleAction, held: readonly HeldLeg[] | null, bounds: Record<string, string> = {}) {
  const sides = legSides(config.market, config.direction);
  if (action === 'close' && !held) throw new Error('没有持有记录，无法平仓');
  const size = config.market === 'hynix' ? { notional: config.notional } : { barrels: config.barrels };
  return {
    market: config.market, preset: 'same-exchange', action, timeoutMs: ruleTimeout(config),
    ...(config.batches ? { batches: action === 'close' ? { ...config.batches, fit: true } : config.batches } : {}),
    legs: RULE_LEGS[config.market].map(symbol => ({
      venue: config.venue, symbol, side: sides[symbol], orderType: 'market',
      ...(action === 'open' ? size : { quantity: held!.find(leg => leg.symbol === symbol)!.quantity }),
      ...(bounds[symbol] ? { priceBound: bounds[symbol] } : {}),
    })),
  };
}

/** The preview's legs in the planned order, or null when they are not the market's lead then hedge. */
export function planLegs(plan: RulePlan, market: RuleMarket): [RulePlanLeg, RulePlanLeg] | null {
  const [lead, hedge] = plan.legs, symbols = RULE_LEGS[market];
  return plan.legs.length === 2 && lead?.symbol === symbols[0] && hedge?.symbol === symbols[1] ? [lead, hedge] : null;
}
/** The preview's books as the rule reads books, for the recheck before confirm. */
export const planRows = (venue: Venue, legs: readonly RulePlanLeg[]): BookRow[] => legs.map(leg => ({ venue, symbol: leg.symbol, bid: leg.quote.bid, ask: leg.quote.ask, receivedAt: leg.quote.receivedAt, error: null }));

/** A held leg's account against the preview's: a changed account or credential means another account would be closed. */
export const sameAccount = (a: AccountRef, b: AccountRef): boolean => a.accountKey === b.accountKey && a.credentialVersion === b.credentialVersion;

export type Outcome =
  | { kind: 'hold'; held: HeldLeg[]; message: string }
  | { kind: 'flat'; message: string }
  | { kind: 'revert'; message: string; recount?: true }
  | { kind: 'review'; message: string };

const STATUS_NAMES: Record<string, string> = { completed: '已完成', failed: '失败', stopped: '已停止', attention: '转人工' };

/**
 * What a finished job leaves the rule with; anything that does not add up goes to review. Oil legs must fill equal barrels;
 * hynix legs differ in units by design and the executor hedges them in the planned proportion, so both must just have filled.
 */
export function settleJob(job: { status: string; reason?: string | null; endCode?: string | null; legs: readonly RuleJobLeg[] }, tracked: Tracked, held: readonly HeldLeg[] | null, config: Pick<RuleConfig, 'market' | 'direction'>): Outcome {
  const label = `${actionName(tracked.action)}任务 ${tracked.id}`, status = STATUS_NAMES[job.status] ?? job.status;
  const review = (why: string): Outcome => ({ kind: 'review', message: `${label}${status}，${why}；规则已停用，请在执行进度与交易所核对后重置` });
  const symbols = RULE_LEGS[config.market], oil = config.market === 'oil';
  const legs = symbols.map(symbol => job.legs.find(leg => leg.symbol === symbol));
  if (legs.some(leg => !leg)) return review('任务两腿与规则不符');
  const filled = legs.map(leg => leg!.filledQuantity), barrels = legs.map(leg => leg!.filledBarrels);
  const both = (values: readonly string[]) => symbols.map((symbol, index) => `${legLabel(symbol)} ${values[index]}`).join('、');
  const none = filled.every(quantity => cmp(quantity, ZERO) === 0);
  if (job.status !== 'completed') {
    // failed or stopped with nothing filled is a job that sent nothing or whose lead IOC did not fill: try again later.
    // The books moved past the threshold bound (before the first send, or the lead's IOC expired at it): the same as a preview
    // refused for it, so the samples are counted again and no failure is counted (docs/hynix.md 8.2).
    if (job.status === 'failed' && none && (job.endCode === 'price_moved' || job.endCode === 'lead_unfilled')) return { kind: 'revert', recount: true, message: `${label}${status}，两腿都没有成交（${job.endCode === 'price_moved' ? '盘口越过阈值界限，未发送' : '首腿在阈值界限上没有成交'}）；重新计数，不计失败` };
    if (job.status !== 'attention' && none) return { kind: 'revert', message: `${label}${status}，两腿都没有成交${job.reason ? `（${job.reason.slice(0, 120)}）` : ''}；${RETRY_MS / 1000} 秒后再判断` };
    return review(none ? '任务转人工' : `已成交 ${both(filled)}`);
  }
  if (none) return { kind: 'revert', message: `${label}${status}，但两腿都没有成交；${RETRY_MS / 1000} 秒后再判断` };
  if (oil && cmp(barrels[0]!, barrels[1]!) !== 0) return review(`两腿成交桶数不等（${both(barrels)}）`);
  // Hynix legs are not compared here: a completed job means the executor filled the hedge at the proportional target of the
  // lead's fills (proportionalHedge; docs/hynix.md 2), and anything short of it ends the job in attention, not completed.
  if (!oil && filled.some(quantity => cmp(quantity, ZERO) === 0)) return review(`一腿没有成交（${both(filled)}）`);
  if (tracked.action === 'open') {
    const sides = legSides(config.market, config.direction);
    if (tracked.accounts.length !== 2) return review('开仓账户记录缺失');
    return {
      kind: 'hold', message: `开仓完成：${both(filled)}${oil ? `（每腿 ${barrels[0]} 桶）` : ''}，进入持仓中`,
      held: symbols.map((symbol, index) => ({ symbol, side: sides[symbol]!, quantity: filled[index]!, barrels: barrels[index]!, ...tracked.accounts[index]! })),
    };
  }
  if (!held) return review('规则没有持有记录');
  const left = held.map((leg, index) => ({ ...leg, quantity: sub(leg.quantity, filled[index]!), barrels: sub(leg.barrels, barrels[index]!) }));
  if (left.some(leg => cmp(leg.quantity, ZERO) < 0 || (oil && cmp(leg.barrels, ZERO) < 0))) return review('成交超过规则持有量');
  if (left.every(leg => cmp(leg.quantity, ZERO) === 0)) return { kind: 'flat', message: `平仓完成：${both(filled)}，回到等待开仓` };
  if (left.some(leg => cmp(leg.quantity, ZERO) === 0) || (oil && cmp(left[0]!.barrels, left[1]!.barrels) !== 0)) return review(`平仓后两腿剩余不等（${both(left.map(leg => leg.quantity))}）`);
  return { kind: 'hold', held: left, message: `部分平仓：${both(filled)}，剩余${oil ? `每腿 ${left[0]!.barrels} 桶` : ` ${both(left.map(leg => leg.quantity))}`}，继续等平仓条件` };
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
function heldOf(value: unknown, market: RuleMarket): HeldLeg[] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const symbols = RULE_LEGS[market];
  const legs = value.map((item, index) => {
    const raw = object(item), account = accountOf(item);
    // A record of the other market's contracts (a rule whose market reads differently) is not this rule's position.
    if (!raw || !account || raw.symbol !== symbols[index] || (raw.side !== 'long' && raw.side !== 'short')) return null;
    if (typeof raw.quantity !== 'string' || !DECIMAL.test(raw.quantity) || typeof raw.barrels !== 'string' || !DECIMAL.test(raw.barrels)) return null;
    return { symbol: symbols[index]!, side: raw.side, quantity: raw.quantity, barrels: raw.barrels, ...account } satisfies HeldLeg;
  });
  return legs.every(Boolean) ? legs as HeldLeg[] : null;
}

/** A live rule's stored state; one that does not add up is held for review with what can still be read. */
export function liveOf(value: unknown, market: RuleMarket): LiveState {
  const raw = object(value) ?? {};
  const phase = (PHASES as readonly unknown[]).includes(raw.phase) ? raw.phase as Phase : null;
  const opens = object(raw.opens);
  const live: LiveState = {
    enabled: raw.enabled === true, phase: phase ?? 'review', pending: pendingOf(raw.pending), job: trackedOf(raw.job), held: heldOf(raw.held, market),
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
