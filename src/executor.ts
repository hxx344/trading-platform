// Phase 1 executor for the Binance + Bybit oil two-leg slice. It owns its own
// database and only accepts simulated connectors, so it cannot take execution
// rights over a real account (plan 1, 5.3, 8).
import { createHash, randomUUID } from 'node:crypto';
import { add, bandEdge, cmp, DecimalError, floorToStep, isMultiple, isZero, mul, sub, units, fromUnits } from './decimal.ts';
import {
  ContractError, HEDGE_CHASE_TIMEOUT_MS, HYNIX_SYMBOLS, MAX_SLIPPAGE_BPS, UUID, marketOfSymbol, MARKET_SYMBOLS, VENUE_NAMES, VENUE_READ_SYMBOLS, accountKey, checkQuoteFresh, exactKeys, orderSideOf, parseAccountSnapshot, parseBinding, parseConfirm, parseNotionalLimits, parseInstrument, parseIntent, parseFourLegIntent, parseQuote, positionOf, reject, text,
  type AccountBinding, type BatchIntent, type NotionalLimits, type AccountSnapshot, type Action, type Environment, type FourLegIntent, type Instrument, type LegOrderType, type Market, type OrderSide, type PairIntent, type PositionSide, type Quote, type RebalanceIntent, type TransferConfig, type Venue,
} from './contracts.ts';
import {
  STRATEGY_ID, OrderOwnerConflict, VenueError, parseOrderReport, parseStrategyAck, parseStrategyReport, strategyRequestOf, supportsChase,
  type ChaseConnector, type ChaseRequest, type OrderReport, type OrderRequest, type StrategyIdentity, type StrategyReport, type StrategyStatus, type TransferConnector, type VenueConnector,
} from './connector.ts';
import type { Store } from './store.ts';
import { nearestBarrels, quantityForBarrels, splitBarrels } from './barrels.ts';
import { fillGapText, fillGaps, hedgeSkippedQuantity, type FillLeg } from './four-leg-fill.ts';
import { midOf, proportionalHedge, quantityForNotional, splitSteps } from './hynix/sizing.ts';
import { pairBalance, rebalanceOrder, type HeldContract, type RebalanceMethod } from './hynix/balance.ts';
import { createTransfers, type PairRecord, type TransferDeps } from './transfer.ts';
import { DEFAULT_ADL_BUDGETS, createAdl, type Adl, type AdlBudgets } from './adl.ts';
import type { AdlConnector } from './adl-contracts.ts';
import { DEFAULT_POSITIONS_BUDGETS, createPositions, type AsterPositionsConnector, type PositionsBudgets } from './positions.ts';
import { ControlRefusal, MAX_OWNED_BUDGET_MS, REGISTRY_ASTER_EXPIRY_MS, createAccountControl, parseOperationId, type AccountWriterPort, type ControlEnvironment, type WriteOutcome, type WriterOperation } from './account-control.ts';

/** Start values come from the legacy constants registered in plan 6.4; none of them is a met performance target. */
/** The ADL budgets are documented in adl.ts. */
export interface Budgets extends AdlBudgets, PositionsBudgets {
  previewTtlMs: number;
  previewQuoteMaxAgeMs: number;
  sendQuoteMaxAgeMs: number;
  futureToleranceMs: number;
  callTimeoutMs: number;
  createObserveMs: number;
  createArrivalMarginMs: number;
  absentChecks: number;
  absentSpacingMs: number;
  cancelAttempts: number;
  cancelRetryMs: number;
  leaseTtlMs: number;
  /** How long an unresolvable unknown order, or a failing hedge account read, may last before a person takes over. */
  unresolvedGraceMs: number;
  /** How far either book may move against the preview before the lead is sent; also the lead's IOC limit. */
  maxSlippageBps: number;
  /** Both legs' books must have been received within this window of each other (L100). */
  pairQuoteWindowMs: number;
  /** Hedge orders per job that did not fill in full, counting the first; a definitive venue refusal stops earlier. */
  hedgeAttempts: number;
  /** A local chase order rests at least this long before it is moved to a new best price. */
  chaseRepriceMs: number;
  /** Lead orders one job may send (local chase reposts and batches); three digits keep the client order id in bounds. */
  chaseOrderLimit: number;
  /** Lead sends in a row that ended without resting or filling (refused, not sent, not created, expired post-only) before a local chase gives up. */
  chaseFailureLimit: number;
  /** How far a venue clock may be off when strategies are searched by creation time (Hub VENUE_CLOCK_TOLERANCE_MS). */
  venueClockToleranceMs: number;
  /** Slack on each side of the send window an adopted strategy's creation time must fall in. */
  adoptSkewMs: number;
  /** Events, commands and consumed previews of finished jobs older than this are deleted; jobs and orders are kept. */
  historyRetentionMs: number;
  pruneIntervalMs: number;
  pruneBatch: number;
  /** A transfer without an answer is labeled once this long has passed since the send, or once the signed request has expired if that is later. */
  transferHistorySpanMs: number;
  /** How far the venue clock may differ: receipts are read from this long before the send, and the pre-send snapshot looks back this far. */
  transferClockToleranceMs: number;
  /** How long a label read that fails or is incomplete may be put off before the transfer is settled from what is known. */
  transferLabelDeferMs: number;
  /** Least cooldown after a transfer without an answer was settled, and the longer one when it is still open whether money moved. */
  transferSettleCooldownMs: number;
  transferUncertainCooldownMs: number;
  /** Spacing of read-only retries: the balance refresh after an acknowledgement and a deferred label read. */
  transferRetryMs: number;
  /** Timeout of one transfer read (balance, sub-account list, label history). The send keeps callTimeoutMs, which is what a transfer's expiry counts on. */
  transferReadTimeoutMs: number;
  /** Timeout of the optional pre-send receipt snapshot; a side not read by then is sent without one. */
  transferBaselineTimeoutMs: number;
  /** A transfer is only planned and sent from balance snapshots received within this long. */
  transferBalanceMaxAgeMs: number;
  /** How long after its acknowledgement a transfer may wait for both balances to be read again before it is settled on the acknowledgement alone. */
  transferRefreshDeferMs: number;
  /** Once a pass has spent this long on transfers it starts no further transfer or pair; the rest goes first in the next pass. */
  transferTickBudgetMs: number;
}
export const DEFAULT_BUDGETS: Readonly<Budgets> = Object.freeze({
  previewTtlMs: 30_000, previewQuoteMaxAgeMs: 10_000, sendQuoteMaxAgeMs: 10_000, futureToleranceMs: 1_000, callTimeoutMs: 35_000,
  createObserveMs: 120_000, createArrivalMarginMs: 60_000, absentChecks: 2, absentSpacingMs: 5_000, cancelAttempts: 5, cancelRetryMs: 10_000, leaseTtlMs: 60_000,
  unresolvedGraceMs: 60_000, maxSlippageBps: 50, pairQuoteWindowMs: 1_500, hedgeAttempts: 5, chaseRepriceMs: 2_000, chaseOrderLimit: 300, chaseFailureLimit: 3, venueClockToleranceMs: 300_000, adoptSkewMs: 5_000,
  historyRetentionMs: 90 * 24 * 3_600_000, pruneIntervalMs: 3_600_000, pruneBatch: 500,
  transferHistorySpanMs: 180_000, transferClockToleranceMs: 60_000, transferLabelDeferMs: 300_000, transferSettleCooldownMs: 30_000, transferUncertainCooldownMs: 300_000, transferRetryMs: 5_000,
  transferReadTimeoutMs: 8_000, transferBaselineTimeoutMs: 1_500, transferBalanceMaxAgeMs: 8_000, transferRefreshDeferMs: 300_000, transferTickBudgetMs: 10_000,
  ...DEFAULT_ADL_BUDGETS,
  ...DEFAULT_POSITIONS_BUDGETS,
});

export class WriterLostError extends ContractError { constructor(message: string) { super(503, 'writer_lost', message); } }

/** The passes the entry schedules apart: two-leg jobs, margin transfers and ADL incidents. */
export type LoopName = 'jobs' | 'transfers' | 'adl';
export type JobStatus = 'accepted' | 'running' | 'completed' | 'failed' | 'stopped' | 'attention';
const FINAL_JOB = new Set<JobStatus>(['completed', 'failed', 'stopped', 'attention']);
/**
 * prepared: persisted, transport not called. sending: transport may have been called.
 * open: the venue confirmed a resting order. unknown: sent without a usable answer.
 * filled / canceled / rejected / not-sent / not-created are settled facts.
 */
export type OpState = 'prepared' | 'sending' | 'open' | 'unknown' | 'filled' | 'canceled' | 'rejected' | 'not-sent' | 'not-created';
const SETTLED = new Set<OpState>(['filled', 'canceled', 'rejected', 'not-sent', 'not-created']);

export interface PlannedLeg {
  index: 0 | 1;
  venue: Venue;
  symbol: string;
  side: PositionSide;
  orderSide: OrderSide;
  quantity: string;
  orderType: LegOrderType;
  limitPrice: string | null;
  reduceOnly: boolean;
  accountKey: string;
  accountId: string;
  credentialVersion: number;
  accountMode: string;
  positionMode: 'one-way' | 'hedge';
  baseline: string;
  instrument: Instrument;
  /** Worst acceptable book price for this leg's side, fixed at preview. The lead sends it as an IOC limit (a chase lead as its maxChasePrice); the hedge only checks it before the lead goes out. Absent in rows written before it existed. */
  priceBound?: string | null;
  /** Local chase sell only: the highest price it posts at, the preview ask moved up by the protection band; the notional caps count it. */
  chaseCeiling?: string | null;
  /** Chasing hedge only: how long one unhedged gap may chase before the rest goes to market (docs/oil.md 13). */
  chaseTimeoutMs?: number;
  quote: Pick<Quote, 'bid' | 'ask' | 'receivedAt' | 'connectionGeneration' | 'sequence'>;
}
type PairLegs = [PlannedLeg, PlannedLeg];
/** The other hynix leg of a rebalance: never traded by the job, but locked and required to stay as the preview read it. */
export interface RebalanceCounter { symbol: string; side: PositionSide; quantity: string; positionMode: 'one-way' | 'hedge' }
export interface RebalancePlan { method: RebalanceMethod; counter: RebalanceCounter }
interface PreviewBase {
  id: string;
  expiresAt: number;
  writerGeneration: number;
  /** USDT, as counted against the notional limits; recomputed from the legs at confirm, never trusted from here. */
  notional: string;
  /** Barrels per leg (quantity × contract size, equal on both legs). Absent in previews written before it existed. */
  barrels?: string;
  /** Lead quantity of each batch, when the intent asked for more than one. */
  batches?: string[];
  notes: string[];
}
export interface PairPreview extends PreviewBase { intent: PairIntent; legs: PairLegs; rebalance?: undefined }
/** before and after: USDT notional at the preview's book midpoints; after is the estimate once the order fills in full. */
export interface RebalancePreview extends PreviewBase {
  intent: RebalanceIntent;
  legs: [PlannedLeg];
  rebalance: RebalancePlan & {
    before: { longNotional: string; shortNotional: string; gap: string; percent: string; netSide: PositionSide | null };
    after: { gap: string; netSide: PositionSide | null };
  };
}
export type Preview = PairPreview | RebalancePreview;
/**
 * Four legs (docs/oil.md 11): one same-exchange plan per venue, stored as one preview that only the four-leg confirm takes.
 * notional is the two plans' sum; barrels (oil) is per leg, equal on all four.
 */
export interface FourLegPreview {
  id: string; fourLeg: true; expiresAt: number; writerGeneration: number; intent: Omit<FourLegIntent, 'parts'>;
  parts: [PairPreview, PairPreview]; notional: string; barrels?: string; notes: string[];
}
/** The two jobs of one four-leg confirm: id is the group's, index the venue's place in the intent, peer the other job. */
export interface JobGroup { id: string; index: 0 | 1; peer: string }
interface JobBase {
  id: string;
  status: JobStatus;
  reason: string | null;
  /**
   * Why a job that filled nothing ended, when a caller may act on it: 'price_moved' (a book past its bound before the first
   * lead was sent) or 'lead_unfilled' (the protected market lead's IOC expired unfilled). Absent otherwise and in older rows.
   */
  endCode?: 'price_moved' | 'lead_unfilled';
  createdAt: number;
  deadlineAt: number;
  previewId: string;
  requestId: string;
  action: Action;
  /** Set by takeover recovery: reconcile what was sent, never send anything new for this job. */
  holdNewSends: boolean;
  /** attention keeps its symbol locks until a person acknowledges the remaining exposure. */
  acknowledgedAt: number | null;
  /** First failed hedge-side account read; bounded by unresolvedGraceMs. Absent in rows written before it existed. */
  hedgeWaitSince?: number | null;
  /** Lead quantity of each batch; absent is one batch of the lead's whole quantity. */
  batches?: string[];
  batchIntervalMs?: number;
  /** When the batch in hand was found done; the next one goes out batchIntervalMs later. */
  batchDoneAt?: number | null;
  /**
   * Set when the hedge cannot go on while a lead order rests (refused, out of attempts, unknown, guard refusal): the lead
   * is withdrawn first, so no further fill lands unhedged, and the job ends once it settles.
   */
  leadWithdraw?: string | null;
  /** A job of a four-leg group; absent on every other job and in older rows. */
  group?: JobGroup;
  /**
   * Set when the other job of the group ended without completing: no new lead order (nor batch) goes out and a resting lead
   * is withdrawn, but what the lead filled is still hedged; the job then settles as usual (docs/oil.md 11.3).
   */
  peerHalt?: string | null;
  /**
   * Four legs: what a local-chase lead skipped by design, per batch (batch index → quantity): a remainder nextLead does not
   * send (under the minimum quantity, or an opening under the minimum notional with its margin). Absent on older rows.
   */
  leadSkipped?: Record<string, string>;
  /** Four legs: the first time the lead fell short of its plan other than by design; it halts the other job (docs/oil.md 11.3). */
  leadDeviation?: string | null;
  /** Inconsistent persisted order quantities: retain locks for human reconciliation and withdraw only verified live orders. */
  fourLegQuantityIssue?: string;
  /** Chasing hedge: when the unhedged gap in hand began to chase; cleared once the hedge caught up. Absent on older rows. */
  hedgeChaseSince?: number | null;
}
/** A lead and its hedge (oil, hynix). */
export interface PairJob extends JobBase { legs: PairLegs; rebalance?: undefined }
/** One hynix order that levels the two legs' notional; action is that order's (close for reduce, open for add). */
export interface RebalanceJob extends JobBase { legs: [PlannedLeg]; rebalance: RebalancePlan }
export type Job = PairJob | RebalanceJob;
const isPair = (job: Job): job is PairJob => job.legs.length === 2;
const REBALANCE_ACTION: Record<RebalanceMethod, Action> = { reduce: 'close', add: 'open' };
/** Every symbol a job or preview holds on its account: its legs, and a rebalance's other leg too. */
const lockResources = (value: { legs: readonly PlannedLeg[]; rebalance?: { counter: Pick<RebalanceCounter, 'symbol'> } }): string[] =>
  [...value.legs.map(leg => `${leg.accountKey}:${leg.symbol}`), ...(value.rebalance && value.legs[0] ? [`${value.legs[0].accountKey}:${value.rebalance.counter.symbol}`] : [])];
/** A leg by its operation index; a rebalance job only has leg 0, which every path of its own uses. */
const legAt = (job: Pick<Job, 'legs'>, index: 0 | 1): PlannedLeg => (index === 0 ? job.legs[0] : job.legs.length === 2 ? job.legs[1] : undefined) ?? reject('leg_missing', '任务没有该腿', 500);
export interface Operation {
  id: string;
  jobId: string;
  leg: 0 | 1;
  /** 0 for the first order of a leg; hedge resumes, local chase reposts and later batches count up. Absent in rows written before it existed means 0. */
  attempt?: number;
  /** Lead only: the batch this order belongs to. Absent means 0. */
  batch?: number;
  venue: Venue;
  /** strategy: a venue-native chase strategy whose remoteId is its strategy id; the client order id stays local. Absent means order. */
  kind?: 'order' | 'strategy';
  clientOrderId: string;
  request: OrderRequest | ChaseRequest;
  state: OpState;
  remoteId: string | null;
  filledQuantity: string;
  averagePrice: string | null;
  venueStatus: OrderReport['status'] | null;
  /** Set by a venue report of a working order or strategy. Older open rows require another read. */
  verifiedWorking?: true;
  preparedAt: number;
  sentAt: number | null;
  lastCheckedAt: number | null;
  absentChecks: number;
  absentAt: number | null;
  positionMismatchAt: number | null;
  cancelSent: number;
  cancelRequestedAt: number | null;
  /** Monotonic cancel sequence for shared-registry operation ids; unlike cancelSent it is never given back. Absent means 0. */
  cancelSeq?: number;
  /** Start of the latest query that still found this order resting. */
  openCheckedFrom?: number | null;
  /** First time the shared registry refused a cancel of this order. */
  cancelBlockedAt?: number | null;
  /** Strategy only: last status read from the venue, and whether its children were settled then. */
  strategyStatus?: StrategyStatus | null;
  childrenSettled?: boolean;
  /** Strategy only: first time it read ended with a child still open; bounded by unresolvedGraceMs. */
  childrenWaitSince?: number | null;
  /** Strategy only: when a person attached a strategy id to a create that had no answer. */
  adoptedAt?: number | null;
  /** Strategy only: last read that showed remoteId names this create. Only such an id is ever stopped. */
  identityVerifiedAt?: number | null;
  /** The known venue ID was attributed to another order or strategy. Further writes require manual resolution. */
  identityMismatchAt?: number | null;
  /** Strategy only: a person released a create without an answer, accepting that it may have executed; it stays unknown and is never adopted or resent. */
  releasedAt?: number | null;
  /** Strategy only: stops tried for an adopted strategy while its job waits for a person, bounded by cancelAttempts. */
  manualStops?: number;
  manualStopAt?: number | null;
  /** Strategy only: the id the create's answer named, written before it is checked so a takeover mid-check still shows it to a person. */
  ackStrategyId?: string | null;
  /** Strategy only: when that answer arrived. The venue makes a strategy before answering, so none made later can be this create's. */
  ackAt?: number | null;
  note: string | null;
}

const isStrategy = (op: Operation): boolean => op.kind === 'strategy';
/** A chasing hedge's post-only order (docs/oil.md 13); its fallback to market is an ordinary hedge order. */
const isPostedHedge = (op: Operation): boolean => op.leg === 1 && (op.request as Partial<OrderRequest> | undefined)?.timeInForce === 'gtx';
/** A strategy create without an answer and not released by a person: the venue takes no client id, so nothing automatic can find it or prove it absent. */
const isOrphanStrategy = (op: Operation): boolean => op.kind === 'strategy' && op.state === 'unknown' && op.remoteId === null && op.releasedAt == null;
/** Lower bound as for adoption; upper bound the answer's arrival, both widened by the venue clock skew. */
const outsideAck = (op: Operation, createdAt: number, ackAt: number, skewMs: number): boolean => createdAt < op.preparedAt - skewMs || createdAt > ackAt + skewMs;
const ackHint = (op: Operation): string => op.ackStrategyId ? `；交易所曾回报策略编号 ${op.ackStrategyId}，核对后可认领` : '';
const strategyIdentity = (op: Operation): StrategyIdentity => {
  const { symbol, side, positionSide, reduceOnly, quantity, maxChasePrice } = op.request as ChaseRequest;
  return { symbol, side, positionSide, reduceOnly, quantity, maxChasePrice };
};

/** Compare original venue times as well as receipt times when determining the two-leg price window. */
function sameQuoteWindow(books: readonly Quote[], window: number): boolean {
  const received = books.map(book => book.receivedAt);
  const source = books.map(book => book.sourceTime ?? book.receivedAt);
  return Math.max(...received) - Math.min(...received) <= window && Math.max(...source) - Math.min(...source) <= window;
}

export interface ExecutorOptions {
  store: Store;
  connectors: readonly VenueConnector[];
  environment?: Environment;
  now?: () => number;
  budgets?: Partial<Budgets>;
  /** Shared account-writer registry; absent means this executor writes no shared state. */
  control?: { writer: AccountWriterPort; environment: ControlEnvironment };
  /**
   * ASTER sub-account transfers. With control injected each is registered under the registry's margin-transfer intent
   * (the pair's main account and both sub-accounts), so the transfer connector's signed requests must expire within the
   * registry's ASTER expiry.
   */
  transfers?: TransferConnector;
  /** ASTER ADL emergency handling of the same pairs. With control injected each reduction order and cancel is registered on its sub-account. */
  adl?: AdlConnector;
  /** Read-only display of the pairs' ASTER positions; read by `refreshPositions`, which the entry schedules apart from the other passes. */
  positions?: AsterPositionsConnector;
  /**
   * Hard notional caps checked at preview and again inside the confirm transaction; totalOpen counts every opening job ever
   * accepted. The live canary sets them; the service runs without, and then no job is bounded by notional.
   */
  notionalLimits?: NotionalLimits;
  /** Checks rule-owned positions on the bound account synchronously, including inside the confirm transaction. */
  checkHynixRebalance?: (venue: Venue, accountKey: string) => void;
  /** Extra checks before a transfer pair is switched on (after ownership is proven); throws a ContractError to refuse. */
  enableGuard?: TransferDeps['enableGuard'];
  /** Checks a transfer pair's new settings from the page before they are stored; throws a ContractError to refuse. */
  transferConfigGuard?: TransferDeps['configGuard'];
  /**
   * ADL acts only on pairs whose transfers are switched on, plus any pair it still has unfinished work on. The service
   * sets it: a configured pair is not taken over from the workbench until it is enabled here.
   */
  adlOnlyEnabledPairs?: boolean;
}

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const exposure = (quantity: string, instrument: Instrument): string => mul(quantity, instrument.contractSize);
/** Headroom over a venue's minimum notional for an amount priced at the preview, which the market may have left. */
const MIN_NOTIONAL_MARGIN = '1.2';
/** Whether the hedge contract's minimum quantity, at the preview bid, is under MIN_NOTIONAL_MARGIN times its minimum notional. */
function reserveNeeded(leg: { instrument: Instrument; quote: Pick<Quote, 'bid'> }): boolean {
  return cmp(mul(exposure(leg.instrument.minQuantity, leg.instrument), leg.quote.bid), mul(leg.instrument.minNotional, MIN_NOTIONAL_MARGIN)) < 0;
}
/** The smallest quantity on the step (and at least the minimum) worth MIN_NOTIONAL_MARGIN times the minimum notional at a price. */
function reserveFor(instrument: Instrument, price: string): string {
  const target = mul(instrument.minNotional, MIN_NOTIONAL_MARGIN), perStep = Number(mul(exposure(instrument.quantityStep, instrument), price));
  if (!(perStep > 0)) return instrument.minQuantity;
  // A float estimate of the step count, then exact steps up until the amount reaches the target.
  let quantity = mul(instrument.quantityStep, String(Math.max(1, Math.ceil(Number(target) / perStep))));
  while (cmp(mul(exposure(quantity, instrument), price), target) < 0) quantity = add(quantity, instrument.quantityStep);
  return cmp(quantity, instrument.minQuantity) < 0 ? instrument.minQuantity : quantity;
}
const maskId = (id: string): string => id.length > 4 ? `***${id.slice(-4)}` : '***';
const maxOf = (...values: string[]): string => values.reduce((top, value) => cmp(value, top) > 0 ? value : top);
/**
 * A leg's asked bound rounded inward on the tick (a buy's down, a sell's up), then the tighter of it and the band: a buy is
 * held to the lower, a sell to the higher, so the asked bound can only narrow what may fill.
 */
function tighterBound(band: string, asked: string, side: OrderSide, tick: string): string {
  const unit = units(tick), raw = units(asked);
  const rounded = fromUnits(side === 'buy' ? raw - raw % unit : (raw + unit - 1n) / unit * unit);
  return side === 'buy' ? (cmp(rounded, band) < 0 ? rounded : band) : (cmp(rounded, band) > 0 ? rounded : band);
}
/**
 * A leg's notional at the highest price the plan admits for it: the preview bound, the book's ask or the limit, whichever is
 * highest, so a sell is not undercounted at its lower bound. The market hedge carries no venue-enforced price limit, so its
 * real fill can still cost more than this. A buy leg's own tighter bound (priceBound in the intent) counts it at that lower
 * price, never under the preview ask.
 */
const legNotional = (leg: Pick<PlannedLeg, 'quantity' | 'instrument' | 'priceBound' | 'quote' | 'limitPrice' | 'chaseCeiling'>): string =>
  mul(exposure(leg.quantity, leg.instrument), maxOf(leg.priceBound ?? '0', leg.quote.ask, leg.limitPrice ?? '0', leg.chaseCeiling ?? '0'));
/** Legs are told apart by venue across venues and by contract on one venue. */
const legLabel = (legs: readonly Pick<PlannedLeg, 'venue' | 'symbol'>[], index: number): string => {
  const leg = legs[index]!;
  return legs.length < 2 || legs[0]!.venue === legs[1]!.venue ? `${VENUE_NAMES[leg.venue]} ${leg.symbol}` : VENUE_NAMES[leg.venue];
};
/** Both legs carry the same barrels, so the job's notional is the dearer leg, not their sum. */
const jobNotional = (legs: readonly PlannedLeg[]): string => maxOf(...legs.map(legNotional));
/** Fill-weighted average price over a leg's orders, truncated at 18 digits; null before any fill. */
const averageOf = (ops: readonly Pick<Operation, 'filledQuantity' | 'averagePrice'>[]): string | null => {
  let weight = 0n, total = 0n;
  for (const op of ops) {
    if (op.averagePrice === null || isZero(op.filledQuantity)) continue;
    weight += units(op.filledQuantity); total += units(op.filledQuantity) * units(op.averagePrice);
  }
  return weight === 0n ? null : fromUnits(total / weight);
};
/** `pa1-` + 24 hex + `-` + leg index, plus `r` + attempt for a later order of the leg (at most three digits: both legs stop at chaseOrderLimit ≤ 999). */
const CLIENT_ORDER_ID_LENGTH = 34;

export function createExecutor({ store, connectors, environment = 'simulated', now = Date.now, budgets: overrides = {}, control: controlOptions, transfers: transferConnector, adl: adlConnector, positions: positionsConnector, notionalLimits, checkHynixRebalance, enableGuard, transferConfigGuard, adlOnlyEnabledPairs = false }: ExecutorOptions) {
  // Caps are optional; a malformed cap stops the start instead of being ignored.
  const limits = notionalLimits ? parseNotionalLimits(notionalLimits) : null;
  // A standalone live executor can share the account while using a different data directory from the rule owner.
  const requireRebalanceAuthority = checkHynixRebalance ?? (() => {
    if (environment === 'mainnet') reject('rebalance_service_required', '手动调平需要核对实盘规则持仓，请使用正式服务的海力士页面', 409);
  });
  // An override passed as undefined keeps the default instead of turning the budget into NaN arithmetic.
  const budgets: Budgets = { ...DEFAULT_BUDGETS, ...Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined)) };
  // The client order id has three digits for a leg's order index (chaseOrderLimit caps both legs), and the band must stay strictly inside the book.
  if (!Number.isSafeInteger(budgets.hedgeAttempts) || budgets.hedgeAttempts < 1 || budgets.hedgeAttempts > 99) throw new ContractError(500, 'budget', 'hedgeAttempts 须为 1–99');
  if (!Number.isSafeInteger(budgets.chaseOrderLimit) || budgets.chaseOrderLimit < 1 || budgets.chaseOrderLimit > 999) throw new ContractError(500, 'budget', 'chaseOrderLimit 须为 1–999');
  if (!Number.isSafeInteger(budgets.chaseFailureLimit) || budgets.chaseFailureLimit < 1 || budgets.chaseFailureLimit > 99) throw new ContractError(500, 'budget', 'chaseFailureLimit 须为 1–99');
  if (!Number.isSafeInteger(budgets.chaseRepriceMs) || budgets.chaseRepriceMs < 500 || budgets.chaseRepriceMs > 60_000) throw new ContractError(500, 'budget', 'chaseRepriceMs 须为 500–60000');
  if (!Number.isSafeInteger(budgets.maxSlippageBps) || budgets.maxSlippageBps < 1 || budgets.maxSlippageBps > MAX_SLIPPAGE_BPS) throw new ContractError(500, 'budget', `maxSlippageBps 须为 1–${MAX_SLIPPAGE_BPS}`);
  if (controlOptions && Math.max(budgets.callTimeoutMs, budgets.adlOrderTimeoutMs) > MAX_OWNED_BUDGET_MS) throw new ContractError(500, 'control_budget', `共享写者登记要求单次调用不超过 ${MAX_OWNED_BUDGET_MS} 毫秒`);
  // The registry stops gating on an unknown ASTER transfer this long after it; a request still valid then could land unseen.
  if (controlOptions && transferConnector && transferConnector.capabilities.requestValidityMs > REGISTRY_ASTER_EXPIRY_MS) throw new ContractError(500, 'control_budget', `共享写者登记要求划转请求有效期不超过 ${REGISTRY_ASTER_EXPIRY_MS} 毫秒`);
  // The registry pins an account to its first claimant forever, so a real account claimed here could never be written by
  // the workbench again; the live canary runs on accounts the workbench does not trade, without the registry (3.0c).
  if (controlOptions && environment === 'mainnet') throw new ContractError(500, 'control_mainnet', '实盘金丝雀不接入共享写者登记：登记会把真实账户永久归属本模块');
  const venues = new Map<Venue, VenueConnector>();
  for (const connector of connectors) {
    // A simulated environment reaches only simulated venues and the mainnet only real ones, so no configuration mistake
    // sends a real order from a test setup or lets a simulated fill stand in for a real account.
    if (connector.capabilities.transport !== (environment === 'mainnet' ? 'live' : 'simulated')) throw new ContractError(500, 'live_transport_refused', environment === 'mainnet' ? '实盘环境只接受真实交易所连接器' : '模拟环境只接受模拟传输');
    if (venues.has(connector.venue)) throw new ContractError(500, 'duplicate_connector', `重复的 ${connector.venue} 连接器`);
    venues.set(connector.venue, connector);
  }
  // Same rule as the order venues: the mainnet reaches only the real ASTER connectors, a simulation only simulated ones.
  const asterTransport = environment === 'mainnet' ? 'live' : 'simulated';
  for (const [name, connector] of [['划转', transferConnector], ['ADL', adlConnector], ['持仓展示', positionsConnector]] as const) {
    if (connector && connector.capabilities.transport !== asterTransport) throw new ContractError(500, 'live_transport_refused', environment === 'mainnet' ? `实盘环境的 ASTER ${name}只接受真实连接器` : `模拟环境的 ASTER ${name}只接受模拟传输`);
  }
  const db = store.db;
  const owner = randomUUID();
  let generation = 0, held = false, retired = false, closed = false, heldSince = 0;
  /** One pass at a time per loop; a second call while one runs joins it. */
  const passes: Record<'all' | LoopName, Promise<void> | null> = { all: null, jobs: null, transfers: null, adl: null };
  const singleFlight = (name: 'all' | LoopName, run: () => Promise<void>): Promise<void> => {
    const current = passes[name];
    if (current) return current;
    const next = run().finally(() => { passes[name] = null; });
    passes[name] = next;
    return next;
  };
  /** The last transfer-pass failure written to the event log; the same reason is written at most once a minute. */
  let transferTickFailure: { reason: string; at: number } | null = null, adlTickFailure: { reason: string; at: number } | null = null;
  /** Operations whose send is running in this process; any other prepared or sending row was interrupted. */
  const inFlight = new Set<string>();
  /** Operations whose cancel is running in this process. */
  const cancelling = new Set<string>();
  const control = controlOptions ? createAccountControl({ ...controlOptions, lost: (message: string): never => { retired = true; throw new WriterLostError(message); } }) : null;

  const connectorFor = (venue: Venue): VenueConnector => venues.get(venue) ?? reject('venue_unavailable', `${VENUE_NAMES[venue]} 连接器不可用`, 503);
  const chaseConnector = (venue: Venue): ChaseConnector => {
    const connector = connectorFor(venue);
    return supportsChase(connector) ? connector : reject('chase_unsupported', `${VENUE_NAMES[venue]} 连接器不支持原生追价策略`, 409);
  };
  const event = (jobId: string | null, type: string, detail: Record<string, unknown> = {}) =>
    db.prepare('INSERT INTO events(job_id, type, at, json) VALUES (?, ?, ?, ?)').run(jobId, type, now(), JSON.stringify(detail));

  // ---- writer lease and fence --------------------------------------------------
  function assertWriter(): void {
    if (retired) throw new WriterLostError('执行器已失去写入权，请重启后核对');
    const row = db.prepare('SELECT owner, generation, expires_at FROM writer WHERE id = 1').get() as { owner: string; generation: number; expires_at: number } | undefined;
    if (!held || !row || row.owner !== owner || row.generation !== generation || row.expires_at <= now()) {
      if (held) retired = true;
      throw new WriterLostError(held ? '执行器写入租约已失效或被接管，本实例停止写入' : '执行器尚未取得写入租约');
    }
  }
  const write = <T>(operation: () => T): T => store.tx(() => { assertWriter(); return operation(); });

  /** Takes or renews the single-writer lease. A lapsed lease is never revived by the same instance. */
  function acquire(): boolean {
    if (closed || retired) return false;
    const renewed = store.tx(() => {
      const row = db.prepare('SELECT owner, generation, expires_at FROM writer WHERE id = 1').get() as { owner: string; generation: number; expires_at: number } | undefined;
      if (held) {
        if (!row || row.owner !== owner || row.generation !== generation || row.expires_at <= now()) { retired = true; return false; }
        db.prepare('UPDATE writer SET expires_at = ? WHERE id = 1').run(now() + budgets.leaseTtlMs);
        return true;
      }
      if (row && row.expires_at > now()) return false;
      generation = (row?.generation ?? 0) + 1;
      db.prepare('INSERT INTO writer(id, owner, generation, expires_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, generation = excluded.generation, expires_at = excluded.expires_at')
        .run(owner, generation, now() + budgets.leaseTtlMs);
      held = true; heldSince = now();
      recoverAfterTakeover();
      return true;
    });
    if (renewed && control) { try { control.keepAlive(); } catch (error) { if (!(error instanceof WriterLostError)) throw error; } }
    return renewed && !retired;
  }

  /**
   * A new writer cannot know what the previous one did after its last commit.
   * prepared never reached transport; sending may have; jobs keep reconciling
   * but never send anything new (plan 8 step 5).
   */
  function recoverAfterTakeover(): void {
    for (const op of unsettledOps()) {
      if (op.state === 'prepared') { Object.assign(op, { state: 'not-sent', note: '恢复：落盘后、发送前中断，传输未调用' }); saveOp(op); event(op.jobId, 'operation-recovered', { op: op.id, state: op.state }); }
      else if (op.state === 'sending') { Object.assign(op, { state: 'unknown', note: isStrategy(op) ? `恢复：追价策略发送中断，结果未知；交易所无客户编号，需人工认领或确认未创建${ackHint(op)}` : '恢复：发送中断，结果未知，按原客户订单号核对' }); saveOp(op); event(op.jobId, 'operation-recovered', { op: op.id, state: op.state }); }
    }
    // Older writers persisted a terminal lead before its deviation. Recover it before failing an as-yet unsent peer.
    const pending = unfinishedJobs();
    for (const { id, group } of pending) {
      if (!group) continue;
      const job = readJob(id), ops = opsOf(id);
      const issue = fourLegQuantityIssue(job, ops);
      if (issue) { holdInvalidQuantities(job, issue, '服务恢复时'); continue; }
      const why = shortLeadReason(job, ops.filter(op => op.leg === 0));
      if (why) noteDeviation(job, why);
    }
    // Finishing or halting one job may have changed its peer.
    for (const { id } of pending) {
      const job = readJob(id);
      if (FINAL_JOB.has(job.status)) continue;
      if (job.status === 'accepted' && !opsOf(job.id).length) finish(job, 'failed', '服务重启时任务尚未发送，已取消；请重新预览');
      else if (!job.holdNewSends) { job.holdNewSends = true; job.reason = isPair(job) ? '服务恢复：核对已发送委托；首腿不再新发并撤销挂单，已成交部分按落盘进度补发对冲腿' : '服务恢复：核对已发送的调平委托；不再新发并撤销挂单'; saveJob(job); event(job.id, 'job-held', {}); }
    }
    transfers.recover();
    adl.recover();
  }

  // ---- persistence -------------------------------------------------------------
  const readJob = (id: string): Job => {
    const row = db.prepare('SELECT json FROM jobs WHERE id = ?').get(id) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as Job : reject('job_missing', '执行任务不存在', 404);
  };
  const unfinishedJobs = (): Job[] => (db.prepare('SELECT json FROM jobs WHERE final = 0 ORDER BY created_at, rowid').all() as { json: string }[]).map(row => JSON.parse(row.json) as Job);
  const opsOf = (jobId: string): Operation[] => (db.prepare('SELECT json FROM operations WHERE job_id = ? ORDER BY leg').all(jobId) as { json: string }[]).map(row => JSON.parse(row.json) as Operation);
  const unsettledOps = (): Operation[] => (db.prepare('SELECT json FROM operations WHERE settled = 0 ORDER BY rowid').all() as { json: string }[]).map(row => JSON.parse(row.json) as Operation);
  const readOp = (id: string): Operation => JSON.parse((db.prepare('SELECT json FROM operations WHERE id = ?').get(id) as { json: string }).json) as Operation;
  function saveJob(job: Job): void {
    db.prepare('UPDATE jobs SET status = ?, final = ?, version = version + 1, updated_at = ?, json = ? WHERE id = ?').run(job.status, FINAL_JOB.has(job.status) ? 1 : 0, now(), JSON.stringify(job), job.id);
  }
  function saveOp(op: Operation): void {
    db.prepare('UPDATE operations SET state = ?, settled = ?, version = version + 1, json = ? WHERE id = ?').run(op.state, SETTLED.has(op.state) ? 1 : 0, JSON.stringify(op), op.id);
  }
  const stopRequested = (jobId: string): boolean => !!db.prepare('SELECT 1 FROM stop_requests WHERE job_id = ?').get(jobId);
  function finish(job: Job, status: JobStatus, reason: string | null, endCode?: Job['endCode']): void {
    // An unresolved hedge can go to attention before the ordinary lead/hedge progression in this pass.
    if (status === 'attention' && job.group && !job.fourLegQuantityIssue && job.legs[0].orderType === 'local-chase') {
      const ops = opsOf(job.id), issue = fourLegQuantityIssue(job, ops);
      if (issue) { job.fourLegQuantityIssue = issue; reason = `${issue}，保留合约锁，需人工核对`; }
      else {
        const leads = ops.filter(op => op.leg === 0).sort((a, b) => attemptOf(a) - attemptOf(b));
        if (leads.length && leads.every(op => SETTLED.has(op.state))) rememberLeadSkip(job, nextLead(job, leads).skipped);
      }
    }
    job.status = status; job.reason = reason;
    if (endCode) job.endCode = endCode;
    saveJob(job);
    // An unhedged or unverified exposure must not let a new job trade the same symbol on that account.
    if (status !== 'attention') db.prepare('DELETE FROM locks WHERE job_id = ?').run(job.id);
    event(job.id, 'job-finished', { status, reason });
    if (job.group && isPair(job)) {
      const venue = VENUE_NAMES[job.legs[0].venue];
      if (status !== 'completed') haltPeer(job, `${venue} 任务${STATUS_TEXT[status]}${reason ? `：${reason.slice(0, 120)}` : ''}`);
      else if (!job.peerHalt && !job.leadDeviation) {
        const lead = job.legs[0], leads = legOps(job.id, 0);
        const filled = add('0', ...leads.map(item => item.filledQuantity)), skipped = skippedOf(job);
        // An IOC or native chase sends a whole batch once. Its accepted order already has its own one-step deviation check;
        // only a refused or never-submitted batch remains to account for here. Local reposts may cover the same quantity.
        const accounted = lead.orderType === 'market' || lead.orderType === 'chase'
          ? add('0', ...leads.filter(item => item.state === 'filled' || item.state === 'canceled').map(item => item.request.quantity))
          : add(filled, skipped);
        const unsent = sub(lead.quantity, accounted);
        if (cmp(unsent, '0') > 0) noteDeviation(job, `${venue} 首腿提前结束：计划 ${lead.quantity}，成交 ${filled}${isZero(skipped) ? '' : `，按设计跳过 ${skipped}`}，未发 ${unsent}`);
      }
      checkGroupFills(job);
    }
  }
  const STATUS_TEXT: Record<JobStatus, string> = { accepted: '已受理', running: '执行中', completed: '已完成', failed: '失败', stopped: '已停止', attention: '需人工处理' };
  /**
   * The other job of a four-leg group, once this one ended without completing or its lead deviated from the plan: no new lead
   * goes out there, a resting lead is withdrawn and its fills are still hedged (docs/oil.md 11.3). A job already over, already
   * told to stop, or whose own deviation stopped it (and so caused this) is left alone.
   */
  function haltPeer(job: Job, why: string, detail: Record<string, unknown> = {}): void {
    const peer = readJob((job.group as JobGroup).peer);
    if (FINAL_JOB.has(peer.status) || peer.peerHalt || peer.leadDeviation || stopRequested(peer.id)) return;
    peer.peerHalt = why;
    peer.reason = '四腿另一交易所任务未完成或已停止：不再发送新的首腿，撤销首腿挂单，已成交部分照常对冲';
    saveJob(peer);
    event(peer.id, 'four-leg-halted', { by: job.id, reason: why, ...detail });
  }
  /** What a local-chase lead of a four-leg job skipped by design, all batches together (leadSkipped). */
  const skippedOf = (job: Job): string => add('0', ...Object.values(job.leadSkipped ?? {}));
  /** A terminal accepted lead that fell short by at least a whole order step. Local reposts account for their own batch. */
  function shortLeadReason(job: Job, leads: readonly Operation[]): string | null {
    if (!job.group || job.fourLegQuantityIssue || job.peerHalt || job.leadDeviation || job.legs[0].orderType === 'local-chase') return null;
    const short = leads.find(item => (item.state === 'filled' || item.state === 'canceled') && cmp(sub(item.request.quantity, item.filledQuantity), job.legs[0].instrument.quantityStep) >= 0);
    return short ? `${VENUE_NAMES[job.legs[0].venue]} 第 ${(short.batch ?? 0) + 1} 批首腿发出 ${short.request.quantity}，成交 ${short.filledQuantity}` : null;
  }
  /** Called inside the transaction applying the order/strategy report, before the scheduler can send the peer's lead. */
  function noteReportedShortLead(op: Operation): void {
    if (op.leg !== 0 || (op.state !== 'filled' && op.state !== 'canceled') || op.filledQuantity === op.request.quantity) return;
    const job = readJob(op.jobId), why = shortLeadReason(job, [op]);
    if (why) noteDeviation(job, why);
  }
  /** The first deviation of a four-leg job's lead from its plan: recorded once, and the other job is halted (docs/oil.md 11.3). */
  function noteDeviation(job: Job, why: string): void {
    const current = readJob(job.id);
    if (!current.group || current.leadDeviation) return;
    current.leadDeviation = why;
    saveJob(current);
    event(current.id, 'four-leg-deviation', { reason: why });
    haltPeer(current, why);
  }
  /** Only a decimal parse/range failure is recoverable here. Store and programming errors still propagate. */
  function historicalDecimal<T>(read: () => T, invalid: T): T {
    try { return read(); } catch (error) { if (error instanceof DecimalError) return invalid; throw error; }
  }
  const storedUnits = (value: string): bigint | null => historicalDecimal(() => units(value), null);
  /** Tie a stored operation to the job and the original customer order id before trusting its fill or touching a live order. */
  function originalOrder(job: Job, op: Operation): boolean {
    const leg = job.legs[op.leg], request = op.request, attempt = attemptOf(op);
    return !!leg && !!request && Number.isSafeInteger(attempt) && attempt >= 0 && op.jobId === job.id && op.venue === leg.venue
      && op.clientOrderId === clientOrderIdFor(job, op.leg, attempt) && request.clientOrderId === op.clientOrderId && request.symbol === leg.symbol
      && request.side === leg.orderSide && request.positionSide === leg.side && request.reduceOnly === leg.reduceOnly
      && isStrategy(op) === (request.type === 'chase');
  }
  /** The connector validates this bound on the wire. A persisted cumulative fill is only usable against that same order. */
  function boundedFill(op: Operation): bigint | null {
    const requested = storedUnits(op.request?.quantity), filled = storedUnits(op.filledQuantity);
    if (requested === null || requested <= 0n || filled === null || filled < 0n || filled > requested) return null;
    if (filled > 0n && ['prepared', 'sending', 'not-sent', 'not-created', 'rejected'].includes(op.state)) return null;
    return filled;
  }
  function fourLegAmounts(job: PairJob, leg: PlannedLeg, ops: readonly Operation[]): { filled: string; issue: string | null } {
    const name = leg.index === 0 ? '首腿' : '对冲腿';
    const plan = storedUnits(leg.quantity), step = storedUnits(leg.instrument?.quantityStep);
    let issue = plan === null || plan <= 0n || step === null || step <= 0n || plan % step !== 0n ? `${name}计划数量或数量步长无效` : null;
    const counts = leg.index === 0 && job.batches != null ? job.batches : [leg.quantity];
    const parts = Array.isArray(counts) ? counts.map(storedUnits) : [];
    if (!parts.length || parts.some(q => q === null || q <= 0n || (step !== null && step > 0n && q % step !== 0n))
      || parts.reduce<bigint>((total, q) => total + (q ?? 0n), 0n) !== plan) issue ??= `${name}批次计划数量无效`;
    const perBatch = parts.map(() => 0n);
    let total = 0n;
    for (const op of ops) {
      if (op.leg !== leg.index) continue;
      const fill = boundedFill(op), batch = leg.index === 0 ? op.batch ?? 0 : 0;
      if (!originalOrder(job, op) || fill === null || !Number.isSafeInteger(batch) || batch < 0 || batch >= parts.length) {
        return { filled: '无效', issue: `${name}第 ${attemptOf(op) + 1} 笔委托身份或成交数量无效（本地委托 ${op.id}）` };
      }
      total += fill;
      perBatch[batch] += fill;
      // Reposts can each request the remainder. Only actual fills count against the plan.
      const batchPlan = parts[batch];
      if ((plan !== null && plan > 0n && total > plan) || (batchPlan !== null && batchPlan > 0n && perBatch[batch] > batchPlan)) {
        return { filled: '无效', issue: `${name}累计成交超过计划数量` };
      }
    }
    const filled = historicalDecimal(() => fromUnits(total), '无效');
    return { filled, issue: issue ?? (filled === '无效' ? `${name}累计成交数量无效` : null) };
  }
  function fourLegQuantityIssue(job: Job, ops: readonly Operation[]): string | null {
    if (!job.group || !isPair(job)) return null;
    if (ops.some(op => op.leg !== 0 && op.leg !== 1)) return '委托的交易腿编号无效';
    const [lead, hedge] = job.legs.map(leg => fourLegAmounts(job, leg, ops));
    if (lead.issue || hedge.issue) return lead.issue ?? hedge.issue;
    if (job.leadSkipped != null && (typeof job.leadSkipped !== 'object' || Object.values(job.leadSkipped).some(value => {
      const amount = storedUnits(value);
      return amount === null || amount < 0n;
    }))) return '首腿已登记的跳过数量无效';
    if (cmp(hedge.filled, hedgeQuantityFor(job, lead.filled)) > 0) return '对冲腿已记成交超过首腿实际成交对应的对冲数量';
    return null;
  }
  function holdInvalidQuantities(job: Job, issue: string, when: string): void {
    job.fourLegQuantityIssue = issue;
    finish(job, 'attention', `${when}${issue}，保留合约锁，需人工核对`);
  }
  /** The alert and job view read the same quantities. A damaged historical field cannot abort the healthy peer's settlement. */
  function fillLegs(job: PairJob, ops = opsOf(job.id)): (FillLeg & { filledBarrels: string; plannedBarrels: string })[] {
    const skipTotal = Object.values(job.leadSkipped ?? {}).reduce((sum, value) => {
      const quantity = storedUnits(value);
      return sum + (quantity !== null && quantity > 0n ? quantity : 0n);
    }, 0n);
    const skipped = historicalDecimal(() => fromUnits(skipTotal), '0');
    const hedgeSkipped = historicalDecimal(() => hedgeSkippedQuantity(skipped, job.legs[0].quantity, job.legs[1].quantity), '0');
    return job.legs.map(leg => {
      const { filled } = fourLegAmounts(job, leg, ops);
      const planned = typeof leg.quantity === 'string' ? leg.quantity : '无效';
      const barrels = (value: string) => historicalDecimal(() => mul(value, leg.instrument?.contractSize), '无效');
      const filledBarrels = barrels(filled), plannedBarrels = barrels(planned);
      return { venue: VENUE_NAMES[leg.venue], symbol: leg.symbol, filled, planned, filledBarrels, plannedBarrels, step: leg.instrument?.quantityStep ?? '0', skipped: leg.index === 0 ? skipped : hedgeSkipped,
        shown: marketOfJob(job) === 'oil' ? `${filledBarrels} / ${plannedBarrels} 桶` : `${filled} / ${planned}` };
    });
  }
  /**
   * Once both jobs of a group are over, fills that differ between the venues are recorded for Feishu (four-leg-fill.ts). A job
   * needing a person may still have orders being reconciled, so the alert says the fills are as of the end.
   */
  function checkGroupFills(job: PairJob): void {
    const group = job.group as JobGroup;
    const peer = readJob(group.peer);
    if (!FINAL_JOB.has(peer.status) || !isPair(peer)) return;
    const [first, second] = group.index === 0 ? [job, peer] : [peer, job];
    const gaps = fillGaps(fillLegs(first), fillLegs(second));
    if (gaps.length) event(job.id, 'four-leg-unbalanced', { group: group.id, peer: group.peer, details: gaps.map(fillGapText), attention: job.status === 'attention' || peer.status === 'attention' });
  }
  /**
   * Before a group's first lead goes out, the other venue's job is checked too (L100): if its lead could not go out now, this
   * one waits, so one venue does not open alone. The text says why, or null when the other job is already past this point.
   */
  function acceptedLead(op: Operation): boolean {
    const filled = boundedFill(op);
    return filled !== null && op.identityMismatchAt == null && (filled > 0n || op.verifiedWorking === true);
  }
  async function peerFirstLeadEvidence(job: PairJob): Promise<Quote[] | string> {
    if (!job.group || legOps(job.id, 0).some(acceptedLead)) return [];
    const peer = readJob(job.group.peer);
    if (!isPair(peer)) return '四腿任务的另一组身份无效';
    const leads = legOps(peer.id, 0);
    if (leads.some(acceptedLead)) return [];
    if (leads.length || FINAL_JOB.has(peer.status) || peer.peerHalt || peer.holdNewSends || stopRequested(peer.id)) {
      return `${VENUE_NAMES[peer.legs[0].venue]} 首腿尚无已受理的有效委托或成交`;
    }
    try { return await guardLead(peer); }
    catch (error) {
      if (error instanceof WriterLostError) throw error;
      return `${VENUE_NAMES[peer.legs[0].venue]}：${error instanceof Error ? error.message.slice(0, 160) : '发送前检查失败'}`;
    }
  }

  /** Applies to a repost too when the venue has never accepted a lead of this group. */
  async function groupLeadBooks(job: PairJob): Promise<Quote[]> {
    const [books, peer] = await Promise.all([guardLead(job), peerFirstLeadEvidence(job)]);
    if (typeof peer === 'string') return reject('four_leg_peer', `四腿另一交易所首腿暂不能发送（${peer}），本所首腿等待`, 409);
    return [...books, ...peer];
  }

  // ---- accounts ----------------------------------------------------------------
  interface AccountRow { account_key: string; venue: Venue; environment: Environment; account_id: string; account_mode: string; credential_version: number }
  const accountFor = (venue: Venue): AccountRow | undefined => db.prepare('SELECT * FROM accounts WHERE venue = ? AND environment = ?').get(venue, environment) as AccountRow | undefined;
  const bindingOf = (row: AccountRow): AccountBinding => ({ venue: row.venue, environment: row.environment, accountId: row.account_id, accountMode: row.account_mode, credentialVersion: row.credential_version });
  const lockedBy = (key: string): boolean => !!db.prepare('SELECT 1 FROM locks WHERE substr(resource, 1, ?) = ? LIMIT 1').get(key.length + 1, `${key}:`);

  /** Binds a verified principal. Rotation keeps the account key; changing principal needs no unfinished job on the old one. */
  function registerAccount(input: unknown): { accountKey: string; credentialVersion: number } {
    const binding = parseBinding(input);
    if (binding.environment !== environment) reject('environment', '账户环境与执行器环境不一致', 409);
    return write(() => {
      const current = accountFor(binding.venue), key = accountKey(binding);
      if (current && current.account_id === binding.accountId) {
        if (binding.credentialVersion < current.credential_version) reject('credential_version', '凭据版本不能回退', 409);
        if (binding.credentialVersion === current.credential_version && binding.accountMode === current.account_mode) return { accountKey: key, credentialVersion: binding.credentialVersion };
      }
      if (current && lockedBy(current.account_key)) reject('account_busy', '该账户有未结束任务，先完成核对再更换连接', 409);
      if (current && current.account_key !== key) db.prepare('DELETE FROM accounts WHERE account_key = ?').run(current.account_key);
      db.prepare(`INSERT INTO accounts(account_key, venue, environment, account_id, account_mode, credential_version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_key) DO UPDATE SET account_mode = excluded.account_mode, credential_version = excluded.credential_version, updated_at = excluded.updated_at`)
        .run(key, binding.venue, binding.environment, binding.accountId, binding.accountMode, binding.credentialVersion, now());
      event(null, 'account-bound', { accountKey: key, credentialVersion: binding.credentialVersion });
      return { accountKey: key, credentialVersion: binding.credentialVersion };
    });
  }

  // ---- venue calls -------------------------------------------------------------
  async function callVenue<T>(kind: 'read' | 'write', operation: (signal: AbortSignal) => Promise<T>, timeoutMs = budgets.callTimeoutMs): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, fail) => {
      timer = setTimeout(() => { controller.abort(); fail(new VenueError(kind === 'write' ? 'uncertain' : 'read-failed', `交易所调用超过 ${timeoutMs} 毫秒`)); }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
    });
    try { return await Promise.race([operation(controller.signal), deadline]); }
    finally { clearTimeout(timer); }
  }
  // Transfers and ADL use this only as their send guard: the writer check, and no new send once a stop is draining.
  let draining = false;
  const assertSendable = (): void => { assertWriter(); if (draining) throw new Error('服务正在停止，不再发出新的请求'); };
  const transfers = createTransfers({ db, now, budgets, connector: transferConnector ?? null, control, write, assertWriter: assertSendable, callVenue, event, isWriterLost: error => error instanceof WriterLostError,
    busy: pairId => adl.busy(pairId), adlSending: pairId => adl.sending(pairId), enableGuard, configGuard: transferConfigGuard,
    // Only enabled pairs are watched for ADL here, so switching one on starts its watch afresh rather than catching up the pause.
    ...(adlOnlyEnabledPairs ? { onEnabled: (pair: PairRecord, from: number) => adl.watchFrom(pair, from) } : {}) });
  const adl: Adl = createAdl({ db, now, budgets, connector: adlConnector ?? null, control, write, assertWriter: assertSendable, callVenue, event, isWriterLost: error => error instanceof WriterLostError,
    pairs: adlOnlyEnabledPairs ? () => transfers.records().filter(pair => pair.enabled || adl.busy(pair.id) !== null) : transfers.records,
    // A pair switched off can still be given its ADL settings (the config's starting value) before it is taken over.
    configurablePairs: transfers.records,
    transferSending: pairId => transfers.sending(pairId) });
  const positions = createPositions({ connector: positionsConnector ?? null, now, budgets, pairs: transfers.records, callVenue });
  const readFailure = (error: unknown): never => {
    if (error instanceof ContractError) throw error;
    throw new ContractError(502, 'venue_read_failed', `交易所读取失败：${error instanceof Error ? error.message.slice(0, 160) : '未知错误'}`);
  };
  function checkBook(quote: Quote, at: number, maxAge: number): void {
    checkQuoteFresh(quote, at, maxAge, budgets.futureToleranceMs);
    if (connectorFor(quote.venue).quoteCurrent?.(quote) === false) reject('quote_incomplete', '行情连接已切换，请等待新盘口', 409);
  }
  async function readQuote(venue: Venue, symbol: string): Promise<Quote> {
    try { return parseQuote(await callVenue('read', signal => connectorFor(venue).quote(symbol, { signal })), venue, symbol); } catch (error) { return readFailure(error); }
  }
  async function readAccount(binding: AccountBinding, symbol: string): Promise<AccountSnapshot> {
    let snapshot: AccountSnapshot;
    try { snapshot = parseAccountSnapshot(await callVenue('read', signal => connectorFor(binding.venue).account(binding, [symbol], { signal })), binding.venue); } catch (error) { return readFailure(error); }
    if (snapshot.accountId !== binding.accountId) reject('account_identity', `${VENUE_NAMES[binding.venue]} 账户真实身份与绑定不一致`, 409);
    return snapshot;
  }
  async function readInstrument(venue: Venue, symbol: string): Promise<Instrument> {
    try { return parseInstrument(await callVenue('read', signal => connectorFor(venue).instrument(symbol, { signal })), venue, symbol); } catch (error) { return readFailure(error); }
  }

  // ---- preview -----------------------------------------------------------------
  function checkLegAccount(leg: Pick<PlannedLeg, 'venue' | 'symbol' | 'side' | 'quantity'>, snapshot: AccountSnapshot, action: Action, own: readonly Operation[] = []): { baseline: string; positionMode: 'one-way' | 'hedge' } {
    const name = `${VENUE_NAMES[leg.venue]} ${leg.symbol}`;
    const positionMode = snapshot.positionModes[leg.symbol] ?? reject('position_mode', `${name} 持仓模式无法确认，禁止下单`, 409);
    const baseline = positionOf(snapshot, leg.symbol, leg.side);
    if (action === 'close' && cmp(leg.quantity, baseline) > 0) reject('close_exceeds_position', `${name} 可平数量不足（持仓 ${baseline}）`, 409);
    const opposite = positionOf(snapshot, leg.symbol, leg.side === 'long' ? 'short' : 'long');
    if (action === 'open' && positionMode === 'one-way' && cmp(opposite, '0') > 0) reject('implicit_reduce', `${name} 单向模式已有反向仓位，开仓会变成隐式减仓`, 409);
    for (const order of snapshot.openOrders) {
      if (order.symbol !== leg.symbol) continue;
      const known = own.some(op => op.venue === leg.venue && op.request?.symbol === order.symbol && op.identityMismatchAt == null
        && op.clientOrderId === order.clientOrderId && op.remoteId === order.remoteId);
      if (!known) reject('external_orders', `${name} 存在本任务之外的活动委托`, 409);
    }
    return { baseline, positionMode };
  }
  function checkQuantity(leg: Pick<PlannedLeg, 'venue' | 'symbol' | 'quantity' | 'orderType' | 'limitPrice'> & { index?: 0 | 1 }, instrument: Instrument, quote: Quote, action: Action): void {
    const name = `${VENUE_NAMES[leg.venue]} ${leg.symbol}`;
    // A chasing hedge may end with the rest at market, so it fits the market limit too.
    const maximum = leg.orderType === 'market' || (leg.index === 1 && leg.orderType === 'local-chase') ? (cmp(instrument.maxMarketQuantity, instrument.maxQuantity) < 0 ? instrument.maxMarketQuantity : instrument.maxQuantity) : instrument.maxQuantity;
    if (!isMultiple(leg.quantity, instrument.quantityStep)) reject('quantity_step', `${name} 数量须为 ${instrument.quantityStep} 的整数倍`);
    if (cmp(leg.quantity, instrument.minQuantity) < 0 || cmp(leg.quantity, maximum) > 0) reject('quantity_range', `${name} 数量须在 ${instrument.minQuantity} 至 ${maximum} 之间`);
    if (leg.limitPrice !== null && !isMultiple(leg.limitPrice, instrument.tickSize)) reject('price_step', `${name} 限价须为 ${instrument.tickSize} 的整数倍`);
    if (action === 'open' && cmp(mul(mul(leg.quantity, quote.bid), instrument.contractSize), instrument.minNotional) < 0) reject('min_notional', `${name} 名义金额低于 ${instrument.minNotional} USDT`);
  }

  /**
   * The batches of a plan, or null for one batch. A close asked to fit (the spread rules', docs/hynix.md 8.2) takes the most
   * batches its quantities split into, down to one; anything else refuses a count that does not split.
   */
  function fitBatches(legs: [PlannedLeg, PlannedLeg], asked: BatchIntent, quotes: readonly Quote[], action: Action): string[] | null {
    if (!asked.fit) return planBatches(legs, asked.count, quotes, action);
    for (let count = asked.count; count > 1; count--) {
      try { return planBatches(legs, count, quotes, action); }
      catch (error) { if (!(error instanceof ContractError) || error.code !== 'batch_size') throw error; }
    }
    return null;
  }
  /** Lead quantity of each batch. Every batch is checked as an order on both legs, so no batch is refused at send for its size. */
  function planBatches(legs: [PlannedLeg, PlannedLeg], count: number, quotes: readonly Quote[], action: Action): string[] {
    if (marketOfSymbol(legs[0].symbol) === 'hynix') return planHynixBatches(legs, count, quotes, action);
    const barrels = exposure(legs[0].quantity, legs[0].instrument);
    const parts = splitBarrels(barrels, count, legs.map(leg => leg.instrument)) ?? reject('batch_size', `${barrels} 桶分不成 ${count} 批：每批须是两腿共同桶数步长的整数倍`);
    for (const part of parts) {
      legs.forEach((leg, index) => {
        const quantity = quantityForBarrels(part, leg.instrument) ?? reject('batch_size', `每批 ${part} 桶换算不成 ${VENUE_NAMES[leg.venue]} ${leg.symbol} 的整数步长`);
        try { checkQuantity({ ...leg, quantity }, leg.instrument, quotes[index] as Quote, action); }
        catch (error) {
          if (error instanceof ContractError) reject('batch_size', `分 ${count} 批后每批约 ${part} 桶：${error.message}`);
          throw error;
        }
      });
    }
    return parts.map(part => quantityForBarrels(part, legs[0].instrument) as string);
  }
  /**
   * Hynix (docs/hynix.md 8.2): the lead split evenly on its own step; each batch's hedge is what the planned proportion adds
   * for that batch's lead (the executor hedges cumulative lead fills by it), so a batch that fills in full is hedged exactly so.
   */
  function planHynixBatches(legs: [PlannedLeg, PlannedLeg], count: number, quotes: readonly Quote[], action: Action): string[] {
    const [lead, hedge] = legs, step = lead.instrument.quantityStep;
    const parts = splitSteps(lead.quantity, count, step) ?? reject('batch_size', `首腿 ${lead.quantity} 分不成 ${count} 批：每批至少一个数量步长 ${step}`);
    let done = '0', hedged = '0';
    parts.forEach((part, batch) => {
      done = add(done, part);
      const target = proportionalHedge(hedge.quantity, lead.quantity, done, hedge.instrument.quantityStep), hedgePart = sub(target, hedged);
      hedged = target;
      [part, hedgePart].forEach((quantity, index) => {
        try { checkQuantity({ ...legs[index]!, quantity }, legs[index]!.instrument, quotes[index] as Quote, action); }
        catch (error) {
          if (error instanceof ContractError) reject('batch_size', `分 ${count} 批后第 ${batch + 1} 批首腿 ${part}、对冲腿 ${hedgePart}：${error.message}`);
          throw error;
        }
      });
    });
    return parts;
  }

  /**
   * Notional of every opening job accepted so far, priced like at its preview. A job counts from its confirm on and is never
   * given back by fills, cancels or a close; only a job that ended without any order leaving this process (every operation
   * not-sent, or none) is left out. Jobs are never pruned, so the sum survives restarts and cap changes.
   */
  function openNotionalUsed(): string {
    const rows = db.prepare(`SELECT json FROM jobs WHERE json_extract(json, '$.action') = 'open'
      AND NOT (final = 1 AND NOT EXISTS (SELECT 1 FROM operations WHERE operations.job_id = jobs.id AND operations.state <> 'not-sent'))`).all() as { json: string }[];
    return add('0', ...rows.map(row => jobNotional((JSON.parse(row.json) as Job).legs)));
  }
  /** Closing jobs only meet the per-job cap: the running total bounds new exposure, and closing must stay possible. */
  function checkNotional(notional: string, action: Action): void {
    if (!limits) return;
    if (cmp(notional, limits.perJob) > 0) reject('notional_job_cap', `本任务名义金额 ${notional} USDT 超过单笔上限 ${limits.perJob} USDT`, 409);
    if (action !== 'open') return;
    const used = openNotionalUsed();
    if (cmp(add(used, notional), limits.totalOpen) > 0) reject('notional_total_cap', `累计开仓名义金额已用 ${used} USDT，加上本任务 ${notional} USDT 超过累计上限 ${limits.totalOpen} USDT`, 409);
  }
  /** The caps with what is used; null without caps. */
  const notionalView = () => limits ? { perJob: limits.perJob, totalOpen: limits.totalOpen, openUsed: openNotionalUsed() } : null;

  async function preview(input: unknown, session: string): Promise<Preview> {
    if (typeof session !== 'string' || !/^[\x21-\x7e]{8,128}$/.test(session)) reject('session', '会话无效', 401);
    const intent = parseIntent(input);
    assertWriter();
    if (intent.preset === 'rebalance') return previewRebalance(intent, session);
    return storePreview(await planPair(intent), session);
  }
  /** A same-exchange or cross-exchange plan from the books, rules and accounts just read; stored by the caller. */
  async function planPair(intent: PairIntent): Promise<PairPreview> {
    const accounts = intent.legs.map(leg => accountFor(leg.venue) ?? reject('account_missing', `${VENUE_NAMES[leg.venue]} 尚未绑定已核验的账户`, 409));
    for (const leg of intent.legs) if (connectorFor(leg.venue).capabilities.maxClientOrderIdLength < CLIENT_ORDER_ID_LENGTH) reject('client_order_id', `${VENUE_NAMES[leg.venue]} 客户订单号长度上限不足`, 409);
    for (const leg of intent.legs) if (leg.orderType === 'chase') chaseConnector(leg.venue);
    for (const leg of intent.legs) if (leg.orderType === 'local-chase' && connectorFor(leg.venue).capabilities.postOnly !== true) reject('chase_unsupported', `${VENUE_NAMES[leg.venue]} 连接器不支持只挂单，不能本地追价`, 409);
    intent.legs.forEach((leg, index) => { if (db.prepare('SELECT 1 FROM locks WHERE resource = ?').get(`${accounts[index].account_key}:${leg.symbol}`)) reject('symbol_locked', '所选合约已有未结束任务', 409); });
    const reads = await Promise.all(intent.legs.map(async (leg, index) => {
      const binding = bindingOf(accounts[index]);
      const [instrument, quote, snapshot] = await Promise.all([readInstrument(leg.venue, leg.symbol), readQuote(leg.venue, leg.symbol), readAccount(binding, leg.symbol)]);
      return { binding, instrument, quote, snapshot };
    }));
    // Barrels become each leg's native quantity here, from the contract rules just read; a count that is not a whole number
    // of every leg's steps is refused with the nearest counts both legs can take.
    // Hynix notional becomes each leg's quantity at the book midpoint just read, floored to the step (docs/hynix.md 2).
    const hynix = intent.market === 'hynix';
    const quantities = intent.legs.map((leg, index) => leg.quantity
      ?? (leg.notional != null ? quantityForNotional(leg.notional, midOf(reads[index].quote.bid, reads[index].quote.ask), reads[index].instrument) : quantityForBarrels(leg.barrels as string, reads[index].instrument)));
    intent.legs.forEach((leg, index) => {
      const quantity = quantities[index], { instrument } = reads[index];
      if (leg.notional != null && quantity !== null && cmp(quantity, instrument.minQuantity) < 0) reject('notional_too_small', `${VENUE_NAMES[leg.venue]} ${leg.symbol} 每腿 ${leg.notional} USDT 按中间价折算不足最小数量 ${instrument.minQuantity}（数量步长 ${instrument.quantityStep}）`);
    });
    if (quantities.some(quantity => quantity === null)) {
      const barrels = intent.legs[0].barrels as string, [low, high] = nearestBarrels(barrels, reads.map(read => read.instrument));
      const rules = intent.legs.map((leg, index) => `${VENUE_NAMES[leg.venue]} ${leg.symbol} 每步 ${mul(reads[index].instrument.quantityStep, reads[index].instrument.contractSize)} 桶`).join('、');
      reject('barrels_step', `${barrels} 桶换算不成整数倍的下单数量（${rules}）；按步长最近的桶数为 ${low} 或 ${high}（仍须满足最小名义金额与数量上限）`);
    }
    const at = now();
    for (const { quote } of reads) checkBook(quote, at, budgets.previewQuoteMaxAgeMs);
    if (!sameQuoteWindow(reads.map(read => read.quote), budgets.pairQuoteWindowMs)) reject('quote_window', `两腿盘口时间相差超过 ${budgets.pairQuoteWindowMs} 毫秒，请重新预览`, 409);
    const slippageBps = intent.maxSlippageBps ?? budgets.maxSlippageBps;
    const legs = intent.legs.map((leg, index) => {
      const { binding, instrument, quote, snapshot } = reads[index];
      const orderSide = orderSideOf(intent.action, leg.side);
      // A selling chase has only a floor: it may chase the price up for the whole job, past what the caps counted. On real
      // accounts it stays refused without caps too: that order has never run on one.
      if ((limits || environment === 'mainnet') && leg.orderType === 'chase' && orderSide === 'sell') reject('notional_chase_sell', '卖出方向的原生追价首腿只有最低价、没有价格上限，不能使用；请改用市价、限价或本地追价', 409);
      const band = orderSide === 'buy' ? bandEdge(quote.ask, slippageBps, 'up', instrument.tickSize) : bandEdge(quote.bid, slippageBps, 'down', instrument.tickSize);
      // A market leg's own bound (the spread rules' threshold bound) is rounded inward on the tick and only ever tightens the
      // band; the lead's IOC price and every batch's send check then hold to it (docs/hynix.md 8.2, L100). A book already past
      // it is refused here: the rule counts its samples again.
      const priceBound = leg.priceBound === undefined ? band : tighterBound(band, leg.priceBound, orderSide, instrument.tickSize);
      if (leg.priceBound !== undefined) {
        const price = orderSide === 'buy' ? quote.ask : quote.bid;
        if (orderSide === 'buy' ? cmp(price, priceBound) > 0 : cmp(price, priceBound) < 0) reject('price_moved', `${VENUE_NAMES[leg.venue]} ${leg.symbol} 盘口 ${price} 已越过价格界限 ${priceBound}`, 409);
      }
      const planned = { venue: leg.venue, symbol: leg.symbol, side: leg.side, quantity: quantities[index] as string, orderType: leg.orderType, limitPrice: leg.limitPrice };
      checkQuantity({ ...planned, index: index as 0 | 1 }, instrument, quote, intent.action);
      // A marketable limit beyond the band would fill past the protection the plan promises (L100); a chase bound may only be tighter.
      if (planned.limitPrice !== null && (orderSide === 'buy' ? cmp(planned.limitPrice, priceBound) > 0 : cmp(planned.limitPrice, priceBound) < 0)) reject('limit_beyond_bound', `${VENUE_NAMES[leg.venue]} ${leg.symbol} ${leg.orderType === 'local-chase' ? '追价界限' : '限价'} ${planned.limitPrice} 越过价格保护界限 ${priceBound}`, 409);
      // A selling local chase follows the ask up; it stops at the band above the preview ask, which the caps count.
      const chaseCeiling = leg.orderType === 'local-chase' && orderSide === 'sell' ? bandEdge(quote.ask, slippageBps, 'up', instrument.tickSize) : null;
      if (chaseCeiling && planned.limitPrice !== null && cmp(planned.limitPrice, chaseCeiling) > 0) reject('limit_beyond_bound', `${VENUE_NAMES[leg.venue]} ${leg.symbol} 追价界限 ${planned.limitPrice} 高于卖出挂单上限 ${chaseCeiling}`, 409);
      const { baseline, positionMode } = checkLegAccount(planned, snapshot, intent.action);
      const result: PlannedLeg = {
        ...planned, index: index as 0 | 1, orderSide, reduceOnly: intent.action === 'close', priceBound, ...(chaseCeiling ? { chaseCeiling } : {}),
        ...(index === 1 && leg.orderType === 'local-chase' ? { chaseTimeoutMs: leg.chaseTimeoutMs ?? HEDGE_CHASE_TIMEOUT_MS } : {}),
        accountKey: accountKey(binding), accountId: binding.accountId, credentialVersion: binding.credentialVersion, accountMode: binding.accountMode, positionMode, baseline, instrument,
        quote: { bid: quote.bid, ask: quote.ask, receivedAt: quote.receivedAt, connectionGeneration: quote.connectionGeneration, sequence: quote.sequence },
      };
      return result;
    }) as [PlannedLeg, PlannedLeg];
    // Oil settlement completes only on equal barrels, so the plan must already be equal; a tolerance here would end every such
    // job in attention. Hynix legs hedge equal notional, so their units differ and they settle in the planned proportion.
    const [a, b] = legs.map(leg => units(exposure(leg.quantity, leg.instrument)));
    if (!hynix && a !== b) reject('unbalanced', `两腿桶数不相等：${fromUnits(a)} 与 ${fromUnits(b)}`);
    const batches = intent.batches ? fitBatches(legs, intent.batches, reads.map(read => read.quote), intent.action) : null;
    const bounded = intent.legs.some(leg => leg.priceBound !== undefined);
    const notional = jobNotional(legs);
    checkNotional(notional, intent.action);
    const capNote = !limits ? null
      : `名义金额按价格保护界限计 ${notional} USDT；单笔上限 ${limits.perJob} USDT，累计开仓上限 ${limits.totalOpen} USDT（确认时按当时累计再核一次，超限拒绝；对冲腿市价成交可能高于此估算）。`;
    const value: PairPreview = {
      id: randomUUID(), expiresAt: at + budgets.previewTtlMs, writerGeneration: generation, intent, legs, notional, ...(hynix ? {} : { barrels: fromUnits(a) }), ...(batches ? { batches } : {}),
      notes: [
        hynix
          ? `先发送 ${legLabel(legs, 0)} 腿，成交确认后按计划比例（对冲腿 ${legs[1].quantity} ÷ 首腿 ${legs[0].quantity}）换算其成交量，向下取整到步长后发送 ${legLabel(legs, 1)} 对冲腿；取整留下的差额不超过对冲腿一个数量步长 ${legs[1].instrument.quantityStep}。`
          : `先发送 ${legLabel(legs, 0)} 腿，成交确认后按其成交量发送 ${legLabel(legs, 1)} 对冲腿。`,
        ...(hynix ? [`按预览中间价估算：${legs.map(leg => `${legLabel(legs, leg.index)} ${leg.quantity} 约 ${mul(exposure(leg.quantity, leg.instrument), midOf(leg.quote.bid, leg.quote.ask)).replace(/(\.\d{2})\d+$/, '$1')} USDT`).join('，')}。`] : []),
        ...(intent.batches && (batches?.length ?? 1) < intent.batches.count ? [`持有量分不成 ${intent.batches.count} 批，按能分开的最多 ${batches?.length ?? 1} 批平仓。`] : []),
        ...(bounded ? [`价格界限：${legs.map(leg => `${legLabel(legs, leg.index)} ${leg.orderSide === 'buy' ? '买入不高于' : '卖出不低于'} ${leg.priceBound}`).join('，')}（自带价格界限与 ${slippageBps} 基点界限取较紧者）；每一批发送前任一腿盘口越过界限即不发送。`] : []),
        ...(batches && intent.batches ? [`分 ${batches.length} 批，首腿每批 ${hynix ? `${batches.join(' / ')}（${legs[0].symbol} 合约数量），对冲腿每批按计划比例` : `${batches.map(quantity => exposure(quantity, legs[0].instrument)).join(' / ')} 桶`}；一批首腿结束并补齐对冲后，等 ${intent.batches.intervalMs / 1000} 秒再发下一批。后续批次发送前盘口或持仓不满足条件时等待到截止，不追加；截止或停止时未发的批次不再发送。`] : []),
        legs[0].orderType === 'local-chase'
          ? `首腿本地追价：只挂单挂在${legs[0].orderSide === 'buy' ? '买一' : '卖一'}，盘口变化后撤单重挂（挂满 ${budgets.chaseRepriceMs / 1000} 秒后才改价），${legs[0].orderSide === 'buy' ? '最高' : '最低'}追到 ${legs[0].limitPrice ?? legs[0].priceBound}${legs[0].limitPrice ? '（自填界限）' : `（${slippageBps} 基点价格保护界限）`}${legs[0].chaseCeiling ? `，最高挂到 ${legs[0].chaseCeiling}` : ''}；挂单期间的成交每轮按比例对冲。首腿最多 ${budgets.chaseOrderLimit} 笔委托（各批合计）；连续 ${budgets.chaseFailureLimit} 次挂单失败或到截止时间时撤单结束追价，按实际成交对冲后结束；请求停止则撤单且不再补发对冲腿。发送前对冲腿盘口越过界限 ${legs[1].priceBound} 即不发送。`
          : legs[0].orderType === 'market'
          ? `价格保护 ${slippageBps} 基点：首腿以 IOC 限价 ${legs[0].priceBound} 发送，未即时成交的部分由交易所撤销；发送前任一腿盘口越过界限（对冲腿界限 ${legs[1].priceBound}）即不发送。`
          : legs[0].orderType === 'chase'
            ? `首腿以 ${VENUE_NAMES[legs[0].venue]} 原生追价策略发送，${legs[0].orderSide === 'buy' ? '最高' : '最低'}追价为 ${slippageBps} 基点界限 ${legs[0].priceBound}；发送前任一腿盘口越过界限（对冲腿界限 ${legs[1].priceBound}）即不发送；截止、停止或策略被交易所暂停时停止策略，按停止后重查的实际成交对冲。追价策略不接受客户编号：交易所回报的策略编号须经查询核对身份后才会被停止；创建结果不明时不重发、不自动核对，任务转人工，需填写策略编号认领、在观察窗后确认未创建，或强制释放（策略可能已成交，由人工在交易所处理）。`
            : `首腿按限价 ${legs[0].limitPrice} 挂单；发送前任一腿盘口越过 ${slippageBps} 基点界限即不发送。`,
        ...(intent.action === 'open' && (legs[0].orderType === 'local-chase' || legs[0].orderType === 'limit') && reserveNeeded(legs[1])
          ? [`对冲合约最小数量不足最小名义金额 ${MIN_NOTIONAL_MARGIN} 倍：首腿挂单期间留约 ${mul(legs[1].instrument.minNotional, MIN_NOTIONAL_MARGIN)} USDT 的成交不对冲，首腿结束后一并对冲；这期间请求停止，这部分转人工处理。`] : []),
        legs[1].orderType === 'local-chase'
          ? `对冲腿本地追价：首腿成交后只挂单挂在${legs[1].orderSide === 'buy' ? '买一' : '卖一'}，盘口变化或首腿又有成交时撤单重挂（挂满 ${budgets.chaseRepriceMs / 1000} 秒后才改），${legs[1].orderSide === 'buy' ? '最高' : '最低'}追到 ${legs[1].priceBound}${legs[1].chaseCeiling ? `，最高挂到 ${legs[1].chaseCeiling}` : ''}；一段未对冲量追价超过 ${(legs[1].chaseTimeoutMs ?? HEDGE_CHASE_TIMEOUT_MS) / 1000} 秒、挂单连续 ${budgets.chaseFailureLimit} 次未成功、到截止时间或服务重启接管后，撤单并把剩余按市价补齐（不设价格限制）；对冲挂单期间首腿不改价、不发下一批；请求停止则撤单且不再补发对冲腿。`
          : '对冲腿按市价发送；首腿成交后，包括服务重启接管后，按已落盘成交量补发对冲腿，补发不设价格限制。',
        ...(capNote ? [capNote] : []),
        environment === 'mainnet' ? '实盘传输：确认后委托会发送到真实交易所账户。' : '模拟传输：不会访问任何真实交易所。',
      ],
    };
    return value;
  }
  function storePreview<T extends Preview | FourLegPreview>(value: T, session: string): T {
    write(() => {
      db.prepare('DELETE FROM previews WHERE expires_at < ? AND consumed_job IS NULL').run(now());
      db.prepare('INSERT INTO previews(id, session, expires_at, json) VALUES (?, ?, ?, ?)').run(value.id, session, value.expiresAt, JSON.stringify(value));
    });
    return value;
  }

  /**
   * A single order that levels the two hynix legs the venue's account holds (docs/hynix.md 7.3). Which leg, which way and
   * how much are worked out here from the positions and books just read; the other leg is checked and locked, not traded.
   */
  async function previewRebalance(intent: RebalanceIntent, session: string): Promise<RebalancePreview> {
    const { venue, method } = intent, venueName = VENUE_NAMES[venue];
    const account = accountFor(venue) ?? reject('account_missing', `${venueName} 尚未绑定已核验的账户`, 409);
    if (connectorFor(venue).capabilities.maxClientOrderIdLength < CLIENT_ORDER_ID_LENGTH) reject('client_order_id', `${venueName} 客户订单号长度上限不足`, 409);
    for (const symbol of HYNIX_SYMBOLS) if (db.prepare('SELECT 1 FROM locks WHERE resource = ?').get(`${account.account_key}:${symbol}`)) reject('symbol_locked', `${venueName} ${symbol} 已有未结束任务，调平须两个合约都空闲`, 409);
    requireRebalanceAuthority(venue, account.account_key);
    const binding = bindingOf(account);
    const reads = await Promise.all(HYNIX_SYMBOLS.map(async symbol => {
      const [instrument, quote, snapshot] = await Promise.all([readInstrument(venue, symbol), readQuote(venue, symbol), readAccount(binding, symbol)]);
      return { symbol, instrument, quote, snapshot };
    }));
    const at = now();
    requireRebalanceAuthority(venue, account.account_key);
    for (const { quote } of reads) checkBook(quote, at, budgets.previewQuoteMaxAgeMs);
    if (!sameQuoteWindow(reads.map(read => read.quote), budgets.pairQuoteWindowMs)) reject('quote_window', `两腿盘口时间相差超过 ${budgets.pairQuoteWindowMs} 毫秒，请重新预览`, 409);
    const held = reads.map(({ symbol, instrument, quote, snapshot }): HeldContract => (
      { symbol, long: positionOf(snapshot, symbol, 'long'), short: positionOf(snapshot, symbol, 'short'), price: midOf(quote.bid, quote.ask), contractSize: instrument.contractSize }));
    const balance = pairBalance(held[0], held[1]);
    if (balance.status === 'none') return reject('rebalance_unpaired', `${venueName} 账户没有海力士持仓，无需调平`, 409);
    if (balance.status === 'unpaired') return reject('rebalance_unpaired', `${venueName} 海力士两腿不成对（${balance.reason}），不能调平；请先人工处理`, 409);
    const order = rebalanceOrder(balance, method, Object.fromEntries(reads.map(read => [read.symbol, read.instrument])));
    if ('error' in order) return reject('rebalance_too_small', order.error, 409);
    const target = reads.find(read => read.symbol === order.symbol) ?? reject('rebalance_target', '调平合约未读到', 500);
    const other = reads.find(read => read.symbol !== order.symbol) ?? reject('rebalance_target', '另一腿合约未读到', 500);
    const otherLeg = order.side === 'long' ? balance.short : balance.long, otherName = `${venueName} ${other.symbol}`;
    // The other leg is not traded, so only what checkLegAccount would refuse for any symbol applies to it.
    const otherMode = other.snapshot.positionModes[other.symbol] ?? reject('position_mode', `${otherName} 持仓模式无法确认，禁止下单`, 409);
    if (other.snapshot.openOrders.some(item => item.symbol === other.symbol)) reject('external_orders', `${otherName} 存在本任务之外的活动委托`, 409);
    const action = REBALANCE_ACTION[method], { instrument, quote } = target;
    const orderSide = orderSideOf(action, order.side), slippageBps = intent.maxSlippageBps ?? budgets.maxSlippageBps;
    const priceBound = orderSide === 'buy' ? bandEdge(quote.ask, slippageBps, 'up', instrument.tickSize) : bandEdge(quote.bid, slippageBps, 'down', instrument.tickSize);
    const planned = { venue, symbol: order.symbol, side: order.side, quantity: order.quantity, orderType: 'market' as const, limitPrice: null };
    checkQuantity(planned, instrument, quote, action);
    const { baseline, positionMode } = checkLegAccount(planned, target.snapshot, action);
    const leg: PlannedLeg = {
      ...planned, index: 0, orderSide, reduceOnly: action === 'close', priceBound,
      accountKey: accountKey(binding), accountId: binding.accountId, credentialVersion: binding.credentialVersion, accountMode: binding.accountMode, positionMode, baseline, instrument,
      quote: { bid: quote.bid, ask: quote.ask, receivedAt: quote.receivedAt, connectionGeneration: quote.connectionGeneration, sequence: quote.sequence },
    };
    // The estimate after a full fill, on the same midpoints the quantity was worked out on.
    const moved = action === 'close' ? sub(baseline, order.quantity) : add(baseline, order.quantity);
    const afterHeld = held.map(item => item.symbol !== order.symbol ? item : order.side === 'long' ? { ...item, long: moved } : { ...item, short: moved });
    const after = pairBalance(afterHeld[0], afterHeld[1]);
    const afterGap = after.status === 'paired' ? after.gap : '0', afterSide = after.status === 'paired' ? after.netSide : null;
    const legs: [PlannedLeg] = [leg];
    const notional = jobNotional(legs);
    checkNotional(notional, action);
    const cents = (value: string): string => value.replace(/(\.\d{2})\d+$/, '$1');
    const sideName = (side: PositionSide | null): string => side === 'long' ? '多头' : side === 'short' ? '空头' : '无';
    const capNote = !limits ? null
      : `名义金额按价格保护界限计 ${notional} USDT；单笔上限 ${limits.perJob} USDT，累计开仓上限 ${limits.totalOpen} USDT（确认时按当时累计再核一次，超限拒绝）。`;
    const value: RebalancePreview = {
      id: randomUUID(), expiresAt: at + budgets.previewTtlMs, writerGeneration: generation, intent, legs, notional,
      rebalance: {
        method, counter: { symbol: other.symbol, side: otherLeg.side, quantity: otherLeg.quantity, positionMode: otherMode },
        before: { longNotional: balance.long.notional, shortNotional: balance.short.notional, gap: balance.gap, percent: balance.percent, netSide: balance.netSide },
        after: { gap: afterGap, netSide: afterSide },
      },
      notes: [
        `${method === 'reduce' ? '减仓调平' : '加仓调平'}：${action === 'close' ? '平' : '加'} ${venueName} ${order.symbol} ${sideName(order.side)} ${order.quantity}${action === 'close' ? '（只减仓）' : ''}，只发这一笔，未成交部分不补发。`,
        `按预览中间价：多头 ${balance.long.symbol} 约 ${cents(balance.long.notional)} USDT，空头 ${balance.short.symbol} 约 ${cents(balance.short.notional)} USDT，净敞口 ${cents(balance.gap)} USDT（${sideName(balance.netSide)}多出 ${cents(balance.percent)}%）；全部成交后估算净敞口约 ${cents(afterGap)} USDT${afterSide ? `（${sideName(afterSide)}多出）` : ''}。`,
        `价格保护 ${slippageBps} 基点：以 IOC 限价 ${priceBound} 发送，未即时成交的部分由交易所撤销；发送前盘口越过界限，或两腿持仓与预览时不一致，即不发送，任务失败。部分成交记为完成，可重新预览再调。`,
        `另一腿 ${other.symbol}（${sideName(otherLeg.side)} ${otherLeg.quantity}）不下单，但任务期间与本合约一起锁定，其他任务不能改动。`,
        ...(capNote ? [capNote] : []),
        environment === 'mainnet' ? '实盘传输：确认后委托会发送到真实交易所账户。' : '模拟传输：不会访问任何真实交易所。',
      ],
    };
    return storePreview(value, session);
  }

  // ---- confirm -----------------------------------------------------------------
  function confirm(input: unknown, session: string): { accepted: true; duplicate: boolean; job: ReturnType<typeof jobView> } {
    const body = parseConfirm(input);
    const payload = digest({ kind: 'confirm', previewId: body.previewId, confirmLive: body.confirmLive });
    return write(() => {
      const existing = db.prepare('SELECT * FROM commands WHERE request_id = ?').get(body.requestId) as { kind: string; digest: string; session: string; job_id: string } | undefined;
      if (existing) {
        if (existing.kind !== 'confirm' || existing.digest !== payload || existing.session !== session) reject('request_reused', '请求编号已用于其他内容', 409);
        return { accepted: true as const, duplicate: true, job: jobView(existing.job_id) };
      }
      const record = db.prepare('SELECT * FROM previews WHERE id = ?').get(body.previewId) as { session: string; expires_at: number; consumed_job: string | null; json: string } | undefined;
      if (!record || record.session !== session || record.expires_at <= now() || record.consumed_job) reject('preview_invalid', '预览已过期、已提交或不属于本会话，请重新预览', 409);
      const plan = JSON.parse((record as { json: string }).json) as Preview;
      if (plan.writerGeneration !== generation) reject('preview_generation', '执行器已重启或换代，请重新预览', 409);
      if (Object.hasOwn(plan, 'fourLeg')) reject('preview_invalid', '四腿预览须用四腿确认', 409);
      const job = insertJob(plan, plan.id, body.requestId);
      db.prepare('UPDATE previews SET consumed_job = ? WHERE id = ?').run(job.id, plan.id);
      db.prepare('INSERT INTO commands(request_id, kind, digest, session, job_id, accepted_at) VALUES (?, ?, ?, ?, ?, ?)').run(body.requestId, 'confirm', payload, session, job.id, now());
      return { accepted: true as const, duplicate: false, job: jobView(job.id) };
    });
  }
  /**
   * Inside confirm's write transaction: the plan's accounts as previewed and its symbols free, then the job, its locks and
   * its accepted event. Any refusal rolls the whole transaction back.
   */
  function insertJob(plan: Preview, previewId: string, requestId: string, group?: JobGroup & { jobId: string }): Job {
    for (const leg of plan.legs) {
      const row = accountFor(leg.venue);
      if (!row || row.account_key !== leg.accountKey || row.credential_version !== leg.credentialVersion || row.account_mode !== leg.accountMode) reject('binding_changed', `${VENUE_NAMES[leg.venue]} 账户绑定已变化，请重新预览`, 409);
      if (db.prepare('SELECT 1 FROM locks WHERE resource = ?').get(`${leg.accountKey}:${leg.symbol}`)) reject('symbol_locked', group ? `${VENUE_NAMES[leg.venue]} ${leg.symbol} 已有未结束任务，四腿整体不确认` : '所选合约已有未结束任务', 409);
    }
    // A rebalance also holds its other leg, which no leg of the plan names.
    for (const resource of lockResources(plan).slice(plan.legs.length)) if (db.prepare('SELECT 1 FROM locks WHERE resource = ?').get(resource)) reject('symbol_locked', '另一腿合约已有未结束任务', 409);
    if (plan.rebalance) requireRebalanceAuthority(plan.legs[0].venue, plan.legs[0].accountKey);
    const action = plan.rebalance ? REBALANCE_ACTION[plan.rebalance.method] : plan.intent.action;
    // Inside the write transaction, so two confirms cannot both fit under the running total.
    checkNotional(jobNotional(plan.legs), action);
    const base = { id: group?.jobId ?? randomUUID(), status: 'accepted' as const, reason: null, createdAt: now(), deadlineAt: now() + plan.intent.timeoutMs, previewId, requestId, action, holdNewSends: false, acknowledgedAt: null, hedgeWaitSince: null };
    const job: Job = plan.rebalance
      ? { ...base, legs: plan.legs, rebalance: { method: plan.rebalance.method, counter: plan.rebalance.counter } }
      : { ...base, legs: plan.legs, ...(plan.batches && plan.intent.batches ? { batches: plan.batches, batchIntervalMs: plan.intent.batches.intervalMs, batchDoneAt: null } : {}), ...(group ? { group: { id: group.id, index: group.index, peer: group.peer }, peerHalt: null } : {}) };
    db.prepare('INSERT INTO jobs(id, status, final, version, created_at, updated_at, json) VALUES (?, ?, 0, 1, ?, ?, ?)').run(job.id, job.status, job.createdAt, job.createdAt, JSON.stringify(job));
    for (const resource of lockResources(job)) db.prepare('INSERT INTO locks(resource, job_id) VALUES (?, ?)').run(resource, job.id);
    event(job.id, 'job-accepted', { previewId, requestId, ...(group ? { group: group.id, peer: group.peer } : {}) });
    return job;
  }

  /**
   * Four legs (docs/oil.md 11.3): one same-exchange plan per venue, read side by side; either refusing refuses the whole,
   * and only the four-leg record is stored, so no single plan can be confirmed alone.
   */
  async function previewFourLeg(input: unknown, session: string): Promise<FourLegPreview> {
    if (typeof session !== 'string' || !/^[\x21-\x7e]{8,128}$/.test(session)) reject('session', '会话无效', 401);
    const { parts: intents, ...intent } = parseFourLegIntent(input);
    assertWriter();
    const settled = await Promise.allSettled(intents.map(planPair));
    const failed = settled.find(item => item.status === 'rejected');
    if (failed) {
      const index = settled.indexOf(failed), error = failed.reason;
      // Each plan names its venue, so the refusal says which of the two it was.
      const venue = VENUE_NAMES[intents[index]!.legs[0].venue];
      if (error instanceof ContractError) throw new ContractError(error.status, error.code, error.message.startsWith(venue) ? error.message : `${venue}：${error.message}`);
      throw error;
    }
    const parts = settled.map(item => (item as PromiseFulfilledResult<PairPreview>).value) as [PairPreview, PairPreview];
    if (intent.market === 'oil' && parts[0].barrels !== parts[1].barrels) reject('unbalanced', `两个交易所每腿桶数不相等：${parts[0].barrels} 与 ${parts[1].barrels}`);
    const venues = parts.map(part => VENUE_NAMES[part.legs[0].venue]);
    const batchCounts = parts.map(part => part.batches?.length ?? 1);
    const value: FourLegPreview = {
      id: randomUUID(), fourLeg: true, expiresAt: Math.min(...parts.map(part => part.expiresAt)), writerGeneration: generation, intent, parts,
      notional: add(parts[0].notional, parts[1].notional), ...(parts[0].barrels ? { barrels: parts[0].barrels } : {}),
      notes: [
        `确认后建两个同所两腿任务：${venues[0]} 与 ${venues[1]} 各一个，一起取四个合约锁，各自先首腿、成交后对冲腿；两个任务在同一执行轮里先后推进，不是四腿同时发出。`,
        `任一个任务以失败、停止或待人工处理结束时，另一个任务不再发送新的首腿（含后续批次）并撤销首腿挂单，首腿已成交部分照常补发对冲腿；已成交仓位都不回平。`,
        '停止任一个任务会同时停止另一个。',
        ...(batchCounts[0] !== batchCounts[1] ? [`两个交易所能分的批数不同：${venues[0]} ${batchCounts[0]} 批，${venues[1]} ${batchCounts[1]} 批。`] : []),
      ],
    };
    return storePreview(value, session);
  }
  /** The two jobs of a four-leg confirm, built in one write transaction: any refusal (a lock, a binding, a cap) creates none. */
  function confirmFourLeg(input: unknown, session: string): { accepted: true; duplicate: boolean; group: string; jobs: ReturnType<typeof jobView>[] } {
    const body = parseConfirm(input);
    const payload = digest({ kind: 'confirm-four-leg', previewId: body.previewId, confirmLive: body.confirmLive });
    return write(() => {
      const existing = db.prepare('SELECT * FROM commands WHERE request_id = ?').get(body.requestId) as { kind: string; digest: string; session: string; job_id: string } | undefined;
      if (existing) {
        if (existing.kind !== 'confirm-four-leg' || existing.digest !== payload || existing.session !== session) reject('request_reused', '请求编号已用于其他内容', 409);
        const first = readJob(existing.job_id), group = first.group ?? reject('group_missing', '四腿任务缺少分组', 500);
        return { accepted: true as const, duplicate: true, group: group.id, jobs: [jobView(first.id), jobView(group.peer)] };
      }
      const record = db.prepare('SELECT * FROM previews WHERE id = ?').get(body.previewId) as { session: string; expires_at: number; consumed_job: string | null; json: string } | undefined;
      if (!record || record.session !== session || record.expires_at <= now() || record.consumed_job) reject('preview_invalid', '预览已过期、已提交或不属于本会话，请重新预览', 409);
      const plan = JSON.parse((record as { json: string }).json) as FourLegPreview;
      if (plan.fourLeg !== true) reject('preview_invalid', '这不是四腿预览，请用普通确认', 409);
      if (plan.writerGeneration !== generation) reject('preview_generation', '执行器已重启或换代，请重新预览', 409);
      const group = randomUUID(), ids = [randomUUID(), randomUUID()] as const;
      const jobs = plan.parts.map((part, index) => insertJob(part, plan.id, body.requestId, { id: group, index: index as 0 | 1, peer: ids[1 - index] as string, jobId: ids[index] as string }));
      db.prepare('UPDATE previews SET consumed_job = ? WHERE id = ?').run(jobs[0]!.id, plan.id);
      db.prepare('INSERT INTO commands(request_id, kind, digest, session, job_id, accepted_at) VALUES (?, ?, ?, ?, ?, ?)').run(body.requestId, 'confirm-four-leg', payload, session, jobs[0]!.id, now());
      return { accepted: true as const, duplicate: false, group, jobs: jobs.map(job => jobView(job.id)) };
    });
  }
  /** Page and API view of a four-leg preview: each plan as publicPreview shows it. */
  const publicFourLegPreview = (value: FourLegPreview) => ({ ...value, parts: value.parts.map(publicPreview) });

  /**
   * Read-only lookup of the job a confirm of this preview with this request id created for this session, or null when none
   * was written; the same match as confirm's duplicate check. Used by callers that must not confirm again (say a disabled
   * rule) but may hold a confirm whose answer they never saw.
   */
  function confirmedJob(requestId: string, previewId: string, session: string): string | null {
    const existing = db.prepare('SELECT kind, digest, session, job_id FROM commands WHERE request_id = ?').get(requestId) as { kind: string; digest: string; session: string; job_id: string } | undefined;
    if (!existing) return null;
    if (existing.kind !== 'confirm' || existing.digest !== digest({ kind: 'confirm', previewId, confirmLive: true }) || existing.session !== session) reject('request_reused', '请求编号已用于其他内容', 409);
    return existing.job_id;
  }

  /** Durable, idempotent stop. It stops new sends; orders already sent keep being reconciled. */
  function requestStop(jobId: string, requestId: string, session: string): ReturnType<typeof jobView> {
    if (!UUID.test(requestId)) reject('request_id', '请求编号无效');
    const payload = digest({ kind: 'stop', jobId });
    return write(() => {
      const existing = db.prepare('SELECT * FROM commands WHERE request_id = ?').get(requestId) as { digest: string; session: string } | undefined;
      if (existing && (existing.digest !== payload || existing.session !== session)) reject('request_reused', '请求编号已用于其他内容', 409);
      const job = readJob(jobId);
      if (!existing) {
        db.prepare('INSERT INTO commands(request_id, kind, digest, session, job_id, accepted_at) VALUES (?, ?, ?, ?, ?, ?)').run(requestId, 'stop', payload, session, jobId, now());
        if (!FINAL_JOB.has(job.status)) { db.prepare('INSERT OR IGNORE INTO stop_requests(job_id, request_id, requested_at) VALUES (?, ?, ?)').run(jobId, requestId, now()); event(jobId, 'stop-requested', { requestId }); }
        // A four-leg stop stops both venues' jobs (docs/oil.md 11.3).
        // The other venue gets the linked halt, not a stop: its lead stops and is withdrawn, its fills are still hedged, so
        // no exposure is left on the venue the user did not stop.
        if (job.group && !FINAL_JOB.has(job.status)) haltPeer(job, `${VENUE_NAMES[job.legs[0].venue]} 任务已请求停止`, { requestId });
      }
      return jobView(jobId);
    });
  }

  /** A person has handled an attention job's exposure outside the executor; only then are its symbols free again. */
  function acknowledge(jobId: string, requestId: string, session: string): ReturnType<typeof jobView> {
    if (!UUID.test(requestId)) reject('request_id', '请求编号无效');
    const payload = digest({ kind: 'acknowledge', jobId });
    const view = write(() => {
      const existing = db.prepare('SELECT * FROM commands WHERE request_id = ?').get(requestId) as { digest: string; session: string } | undefined;
      if (existing) {
        if (existing.digest !== payload || existing.session !== session) reject('request_reused', '请求编号已用于其他内容', 409);
        return jobView(jobId);
      }
      const job = readJob(jobId);
      if (job.status !== 'attention') reject('not_attention', '只有待人工处理的任务需要确认', 409);
      // Releasing the account while a strategy nobody tracks may be running would let it trade unseen.
      if (opsOf(jobId).some(isOrphanStrategy)) reject('strategy_unresolved', '追价策略创建结果未知：须先填写策略编号认领、在观察窗后确认未创建或强制释放，才能确认人工处理', 409);
      db.prepare('INSERT INTO commands(request_id, kind, digest, session, job_id, accepted_at) VALUES (?, ?, ?, ?, ?, ?)').run(requestId, 'acknowledge', payload, session, jobId, now());
      job.acknowledgedAt = now(); saveJob(job);
      db.prepare('DELETE FROM locks WHERE job_id = ?').run(jobId);
      event(jobId, 'attention-acknowledged', { requestId });
      return jobView(jobId);
    });
    if (!control) return view;
    releaseControl(jobId);
    return jobView(jobId);
  }
  /**
   * A person has taken over the job's exposure. Its writes still unresolved in the shared registry are
   * released as possibly executed, so the account is writable again; local reconciliation goes on.
   */
  function releaseControl(jobId: string): void {
    const mine = new Map(opsOf(jobId).map(op => [op.clientOrderId, op.id]));
    try { if (!control?.anyPending()) return; } catch (error) { if (error instanceof WriterLostError) throw error; return; }
    for (const leg of readJob(jobId).legs) {
      // Writes on a principal that is no longer bound stay in the registry for manual recovery.
      const row = accountFor(leg.venue);
      if (!row || row.account_key !== leg.accountKey) continue;
      const binding = bindingOf(row);
      // A refusal here is retried by settleControl on every pass, which treats the acknowledgement as settling.
      let pending: string[];
      try { pending = control.pending(binding); } catch (error) { if (error instanceof WriterLostError) throw error; continue; }
      for (const operationId of pending) {
        const parsed = parseOperationId(operationId), opId = parsed && mine.get(parsed.clientOrderId);
        // A write still running finishes its own entry once its result is durable; resolving it now would release the account mid-send.
        if (!opId || inFlight.has(opId) || cancelling.has(opId)) continue;
        try { control.resolve(binding, operationId, 'confirmed'); } catch (error) { if (error instanceof WriterLostError) throw error; continue; }
        write(() => event(jobId, 'control-released', { operationId }));
      }
    }
  }

  // ---- strategies without an answer --------------------------------------------
  function priorCommand(requestId: string, payload: string, session: string): boolean {
    const existing = db.prepare('SELECT digest, session FROM commands WHERE request_id = ?').get(requestId) as { digest: string; session: string } | undefined;
    if (existing && (existing.digest !== payload || existing.session !== session)) reject('request_reused', '请求编号已用于其他内容', 409);
    return !!existing;
  }
  /** Strategy ids already attached to an operation of any job; such a strategy is accounted for there. */
  const claimedStrategies = (): Set<string> => new Set((db.prepare("SELECT json_extract(json, '$.remoteId') AS id FROM operations WHERE json_extract(json, '$.kind') = 'strategy' AND json_extract(json, '$.remoteId') IS NOT NULL").all() as { id: string }[]).map(row => row.id));
  function orphanOf(job: Job): Operation {
    if (job.status !== 'attention') reject('not_attention', '只有待人工处理的任务可以认领追价策略、确认未创建或强制释放', 409);
    return opsOf(job.id).find(isOrphanStrategy) ?? reject('no_pending_strategy', '该任务没有创建结果未知的追价策略', 409);
  }
  function manualTarget(job: Job): { op: Operation; binding: AccountBinding } {
    const op = orphanOf(job);
    const leg = legAt(job, op.leg), row = accountFor(leg.venue);
    if (!row || row.account_key !== leg.accountKey) reject('binding_changed', `${VENUE_NAMES[leg.venue]} 账户绑定已变化，暂不能核对`, 409);
    return { op, binding: bindingOf(row as AccountRow) };
  }
  function resolvedBy(jobId: string, reason: string): void { const job = readJob(jobId); job.reason = reason; saveJob(job); }
  const manualId = (input: Record<string, unknown>) => {
    const jobId = text(input.jobId, '任务编号', UUID);
    if (typeof input.requestId !== 'string' || !UUID.test(input.requestId)) reject('request_id', '请求编号无效');
    return { jobId, requestId: input.requestId as string };
  };

  /**
   * A person names the strategy a create without an answer made. It must match the request exactly, have been
   * created around the send, and belong to no other operation; whatever is still running is then stopped.
   */
  async function adoptStrategy(input: unknown, session: string): Promise<ReturnType<typeof jobView>> {
    const raw = exactKeys(input, ['jobId', 'requestId', 'strategyId']);
    const { jobId, requestId } = manualId(raw), strategyId = text(raw.strategyId, '策略编号', STRATEGY_ID);
    const payload = digest({ kind: 'adopt-strategy', jobId, strategyId });
    assertWriter();
    if (priorCommand(requestId, payload, session)) return jobView(jobId);
    const { op, binding } = manualTarget(readJob(jobId)), name = `${VENUE_NAMES[op.venue]} ${op.request.symbol}`;
    if (claimedStrategies().has(strategyId)) reject('strategy_claimed', '该策略编号已被其他委托认领', 409);
    let report: StrategyReport;
    try {
      const value = await callVenue('read', signal => chaseConnector(op.venue).queryStrategy(binding, strategyId, { signal, symbol: op.request.symbol }));
      report = value === null ? reject('strategy_not_found', `${name} 交易所查无该策略编号`, 409) : parseStrategyReport(value, { ...strategyIdentity(op), strategyId });
    } catch (error) { return readFailure(error); }
    // createdAt is the venue's clock; the window is the local prepare-to-send span widened by the skew.
    const from = op.preparedAt - budgets.adoptSkewMs, to = (op.sentAt ?? op.preparedAt) + budgets.callTimeoutMs + budgets.adoptSkewMs;
    if (report.createdAt < from || report.createdAt > to) reject('strategy_window', `${name} 该策略的创建时间不在本委托发送时段内，不能认领`, 409);
    const adopted = write(() => {
      if (priorCommand(requestId, payload, session)) return false;
      const current = readOp(op.id);
      if (readJob(jobId).status !== 'attention' || !isOrphanStrategy(current)) reject('operation_changed', '待核对委托已变化，请刷新后重试', 409);
      if (claimedStrategies().has(strategyId)) reject('strategy_claimed', '该策略编号已被其他委托认领', 409);
      db.prepare('INSERT INTO commands(request_id, kind, digest, session, job_id, accepted_at) VALUES (?, ?, ?, ?, ?, ?)').run(requestId, 'adopt-strategy', payload, session, jobId, now());
      applyStrategy(current, report);
      current.adoptedAt = now(); current.note = '人工认领的追价策略';
      saveOp(current);
      // The reason that called for a person no longer describes the job.
      resolvedBy(jobId, `已人工认领 ${name} 追价策略 ${strategyId}（首腿成交 ${current.filledQuantity}），未结束的部分由执行器有界停止，停止情况见委托备注；对冲腿不自动补发，敞口须人工处理后确认`);
      event(jobId, 'strategy-adopted', { op: op.id, requestId, strategyId, state: current.state, strategyStatus: report.status, filled: report.filledQuantity });
      return true;
    });
    if (!adopted) return jobView(jobId);
    // The create must be settled in the registry first: an unresolved write on the account refuses the stop's record.
    settleControl();
    const latest = readOp(op.id);
    if (latest.state === 'open' && latest.strategyStatus !== 'terminal') {
      try { await cancel(readJob(jobId), latest); } catch (error) { if (error instanceof WriterLostError) throw error; }
    }
    settleControl();
    return jobView(jobId);
  }

  /**
   * A person confirms a create without an answer made nothing. Accepted only after the request can no longer
   * arrive, when no unclaimed strategy on the symbol is running or was created around the send (venue clock
   * tolerance included), and a fresh account read shows the position equal to the known fills and no order.
   */
  async function confirmNotCreated(input: unknown, session: string): Promise<ReturnType<typeof jobView>> {
    const raw = exactKeys(input, ['jobId', 'requestId']);
    const { jobId, requestId } = manualId(raw);
    const payload = digest({ kind: 'confirm-not-created', jobId });
    assertWriter();
    if (priorCommand(requestId, payload, session)) return jobView(jobId);
    const job = readJob(jobId), { op, binding } = manualTarget(job), leg = legAt(job, op.leg), name = `${VENUE_NAMES[leg.venue]} ${leg.symbol}`;
    const settledAt = createSettledAt(op);
    if (now() < settledAt) reject('create_window', `${name} 追价策略创建请求仍可能送达交易所，请约 ${Math.ceil((settledAt - now()) / 1000)} 秒后再确认`, 409);
    const tolerance = budgets.venueClockToleranceMs, sentAt = op.sentAt ?? op.preparedAt;
    const near = { from: sentAt - tolerance, to: sentAt + budgets.callTimeoutMs + tolerance };
    // The listing runs through now plus the tolerance, as a strategy created near the send may have ended much later;
    // only strategies created near the send are candidates, or any later one on the symbol would block this forever.
    const window = { from: near.from, to: Math.max(near.to, now() + tolerance) };
    let listed: StrategyReport[];
    try {
      const value: unknown = await callVenue('read', signal => chaseConnector(op.venue).listStrategies(binding, leg.symbol, window, { signal }));
      listed = Array.isArray(value) ? value.map(item => parseStrategyReport(item)) : reject('report_shape', '策略列表结构无效', 502);
    } catch (error) { return readFailure(error); }
    const claimed = claimedStrategies(), candidates = listed.filter(item => item.symbol === leg.symbol && !claimed.has(item.strategyId));
    if (candidates.some(item => item.status !== 'terminal')) reject('strategy_running', `${name} 仍有运行中或暂停的追价策略，请填写其策略编号认领`, 409);
    if (candidates.some(item => item.createdAt >= near.from && item.createdAt <= near.to)) reject('strategy_candidate', `${name} 存在下单时段前后创建的同合约追价策略，请填写其策略编号认领`, 409);
    // The account is read after the listing so the decision uses the latest evidence (L091).
    const snapshot = await readAccount(binding, leg.symbol);
    if (cmp(positionOf(snapshot, leg.symbol, leg.side), expectedPosition(job, op.leg)) !== 0 || snapshot.openOrders.some(order => order.symbol === leg.symbol)) {
      reject('position_mismatch', `${name} 当前持仓或挂单与本任务已知成交不一致，不能确认策略未创建`, 409);
    }
    const confirmed = write(() => {
      if (priorCommand(requestId, payload, session)) return false;
      const current = readOp(op.id);
      if (readJob(jobId).status !== 'attention' || !isOrphanStrategy(current)) reject('operation_changed', '待核对委托已变化，请刷新后重试', 409);
      db.prepare('INSERT INTO commands(request_id, kind, digest, session, job_id, accepted_at) VALUES (?, ?, ?, ?, ?, ?)').run(requestId, 'confirm-not-created', payload, session, jobId, now());
      Object.assign(current, { state: 'not-created', note: '人工确认：观察窗后交易所无对应追价策略，持仓与挂单无痕迹，判定未创建', lastCheckedAt: now() });
      saveOp(current);
      resolvedBy(jobId, `已人工确认 ${name} 追价策略未创建；任务不再发送，确认处理后释放合约`);
      event(jobId, 'strategy-not-created', { op: op.id, requestId });
      return true;
    });
    if (confirmed) settleControl();
    return jobView(jobId);
  }

  /**
   * Last resort when a create without an answer can be neither adopted nor proven absent: a person accepts that the
   * strategy may have executed and handles it on the venue. The operation stays unknown, its shared create is released as
   * possibly executed, and it is never adopted or resent; only then can the job be acknowledged.
   */
  function releaseStrategy(input: unknown, session: string): ReturnType<typeof jobView> {
    const raw = exactKeys(input, ['jobId', 'requestId'], ['acknowledgeRisk']);
    const { jobId, requestId } = manualId(raw);
    if (raw.acknowledgeRisk !== true) reject('acknowledge_risk', '强制释放须明确确认风险：策略可能已成交，由人工在交易所处理');
    const payload = digest({ kind: 'release-strategy', jobId });
    const released = write(() => {
      if (priorCommand(requestId, payload, session)) return false;
      const op = orphanOf(readJob(jobId));
      db.prepare('INSERT INTO commands(request_id, kind, digest, session, job_id, accepted_at) VALUES (?, ?, ?, ?, ?, ?)').run(requestId, 'release-strategy', payload, session, jobId, now());
      Object.assign(op, { releasedAt: now(), note: '人工强制释放：策略可能已成交，由人工在交易所处理' });
      saveOp(op);
      resolvedBy(jobId, '已人工强制释放追价策略：策略可能已成交，敞口与策略须由人工在交易所处理，之后确认处理以释放合约');
      event(jobId, 'strategy-released', { op: op.id, requestId });
      return true;
    });
    if (released) settleControl();
    return jobView(jobId);
  }

  /** Read-only market and position view. ANT is observable on Binance only and never executable here. */
  async function observe(venue: Venue, symbol: string): Promise<{ instrument: Instrument; quote: Quote; ageMs: number; position: { long: string; short: string } | null }> {
    if (!VENUE_READ_SYMBOLS[venue]?.includes(symbol)) reject('venue_symbol', `${VENUE_NAMES[venue] ?? venue} 不提供 ${symbol} 数据`, 400);
    const row = accountFor(venue);
    const [instrument, quote, snapshot] = await Promise.all([readInstrument(venue, symbol), readQuote(venue, symbol), row ? readAccount(bindingOf(row), symbol) : Promise.resolve(null)]);
    return { instrument, quote, ageMs: now() - quote.receivedAt, position: snapshot ? { long: positionOf(snapshot, symbol, 'long'), short: positionOf(snapshot, symbol, 'short') } : null };
  }

  // ---- sending -----------------------------------------------------------------
  const clientOrderIdFor = (job: Job, leg: 0 | 1, attempt: number): string => `pa1-${job.id.replace(/-/g, '').slice(0, 24)}-${leg}${attempt ? `r${attempt}` : ''}`;
  const attemptOf = (op: Operation): number => op.attempt ?? 0;
  const legOps = (jobId: string, index: 0 | 1): Operation[] => opsOf(jobId).filter(item => item.leg === index).sort((a, b) => attemptOf(a) - attemptOf(b));
  /** Page and API view of a preview: account principals are masked like everywhere else. */
  const publicPreview = (value: Preview) => ({
    ...value,
    legs: value.legs.map(({ accountKey: _key, accountId, ...leg }) => ({ ...leg, accountId: maskId(accountId) })),
  });
  function bindingStillValid(leg: PlannedLeg): AccountBinding {
    const row = accountFor(leg.venue);
    if (!row || row.account_key !== leg.accountKey || row.credential_version !== leg.credentialVersion || row.account_mode !== leg.accountMode) reject('binding_changed', `${VENUE_NAMES[leg.venue]} 账户绑定已变化，本任务不再发送`, 409);
    return bindingOf(row as AccountRow);
  }

  /**
   * Final send guard of a lead order: both books fresh, both accounts where this job left them (the preview baseline before
   * the first order). A local chase lead posts on its own side, so only the hedge's taker price is held to its bound here;
   * its post price is checked by chaseTarget. Both books remain evidence until transmission.
   */
  async function guardLead(job: PairJob): Promise<Quote[]> {
    if (now() >= job.deadlineAt) reject('deadline', '任务已超过最长执行时间，未发送', 409);
    const checks = await Promise.all(job.legs.map(async leg => {
      const binding = bindingStillValid(leg);
      const [quote, snapshot] = await Promise.all([readQuote(leg.venue, leg.symbol), readAccount(binding, leg.symbol)]);
      return { leg, quote, snapshot };
    }));
    const at = now();
    // A stale or broken book is a refusal; only two fresh books read too far apart are retried, like a failed read.
    for (const { quote } of checks) checkBook(quote, at, budgets.sendQuoteMaxAgeMs);
    if (!sameQuoteWindow(checks.map(check => check.quote), budgets.pairQuoteWindowMs)) reject('quote_window', `两腿盘口时间相差超过 ${budgets.pairQuoteWindowMs} 毫秒，暂不发送`, 409);
    // This job's own orders may still show in a snapshot read just after they ended.
    const own = opsOf(job.id);
    for (const { leg, quote, snapshot } of checks) {
      const price = leg.orderSide === 'buy' ? quote.ask : quote.bid, bound = leg.priceBound ?? null;
      const posting = leg.index === 0 && leg.orderType === 'local-chase';
      if (!posting && bound !== null && (leg.orderSide === 'buy' ? cmp(price, bound) > 0 : cmp(price, bound) < 0)) reject('price_moved', `${VENUE_NAMES[leg.venue]} ${leg.symbol} 盘口 ${price} 已越过价格保护界限 ${bound}，未发送`, 409);
      const { baseline, positionMode } = checkLegAccount({ ...leg, quantity: unfilledOf(job, leg.index) }, snapshot, job.action, own);
      if (cmp(baseline, expectedPosition(job, leg.index)) !== 0 || positionMode !== leg.positionMode) reject('position_changed', `${VENUE_NAMES[leg.venue]} ${leg.symbol} 持仓已变化，请重新预览`, 409);
    }
    // Both accounts: a lead whose hedge account cannot be written would leave an exposure nobody can close.
    for (const leg of job.legs) admit(leg);
    return checks.map(check => check.quote);
  }
  /**
   * Final send guard of a rebalance order: its book fresh and inside the preview bound, its account where the preview left it,
   * and the other leg, which the quantity was worked out against, still supporting the confirmed direction and size.
   */
  async function guardRebalance(job: RebalanceJob): Promise<Quote[]> {
    if (now() >= job.deadlineAt) reject('deadline', '任务已超过最长执行时间，未发送', 409);
    const leg = job.legs[0], counter = job.rebalance.counter, binding = bindingStillValid(leg);
    const [quote, otherQuote, targetRules, counterRules, snapshot, counterSnapshot] = await Promise.all([
      readQuote(leg.venue, leg.symbol), readQuote(leg.venue, counter.symbol), readInstrument(leg.venue, leg.symbol), readInstrument(leg.venue, counter.symbol),
      readAccount(binding, leg.symbol), readAccount(binding, counter.symbol),
    ]);
    const sizing = ['contractSize', 'tickSize', 'quantityStep', 'minQuantity', 'maxQuantity', 'maxMarketQuantity', 'minNotional'] as const;
    if (targetRules.catalogVersion !== leg.instrument.catalogVersion || sizing.some(key => cmp(targetRules[key], leg.instrument[key]) !== 0)) {
      reject('instrument_changed', '调平合约规格已变化，请重新预览', 409);
    }
    const books = [quote, otherQuote], at = now();
    for (const book of books) checkBook(book, at, budgets.sendQuoteMaxAgeMs);
    if (!sameQuoteWindow(books, budgets.pairQuoteWindowMs)) reject('quote_window', '调平两腿盘口不在同一时间窗，请重新预览', 409);
    const price = leg.orderSide === 'buy' ? quote.ask : quote.bid, bound = leg.priceBound ?? null;
    if (bound !== null && (leg.orderSide === 'buy' ? cmp(price, bound) > 0 : cmp(price, bound) < 0)) reject('price_moved', `${VENUE_NAMES[leg.venue]} ${leg.symbol} 盘口 ${price} 已越过价格保护界限 ${bound}，未发送`, 409);
    const own = opsOf(job.id);
    const { baseline, positionMode } = checkLegAccount({ ...leg, quantity: unfilledOf(job, 0) }, snapshot, job.action, own);
    if (cmp(baseline, expectedPosition(job, 0)) !== 0 || positionMode !== leg.positionMode) reject('position_changed', `${VENUE_NAMES[leg.venue]} ${leg.symbol} 持仓已变化，调平委托未发送；请重新预览`, 409);
    const name = `${VENUE_NAMES[leg.venue]} ${counter.symbol}`;
    if (cmp(positionOf(counterSnapshot, counter.symbol, counter.side), counter.quantity) !== 0 || !isZero(positionOf(counterSnapshot, counter.symbol, counter.side === 'long' ? 'short' : 'long'))
      || counterSnapshot.positionModes[counter.symbol] !== counter.positionMode) reject('position_changed', `${name}（另一腿）持仓已变化，调平委托未发送；请重新预览`, 409);
    if (counterSnapshot.openOrders.some(order => order.symbol === counter.symbol)) reject('external_orders', `${name} 存在本任务之外的活动委托`, 409);
    const held = (symbol: string, account: AccountSnapshot, book: Quote, rules: Instrument): HeldContract => ({
      symbol, long: positionOf(account, symbol, 'long'), short: positionOf(account, symbol, 'short'), price: midOf(book.bid, book.ask), contractSize: rules.contractSize,
    });
    const balance = pairBalance(held(leg.symbol, snapshot, quote, targetRules), held(counter.symbol, counterSnapshot, otherQuote, counterRules));
    const order = balance.status === 'paired' ? rebalanceOrder(balance, job.rebalance.method, { [leg.symbol]: targetRules, [counter.symbol]: counterRules }) : null;
    if (!order || 'error' in order || order.symbol !== leg.symbol || order.side !== leg.side || cmp(order.quantity, leg.quantity) < 0) {
      reject('rebalance_changed', '当前两腿盘口已不支持原先确认的调平方向或数量，请重新预览', 409);
    }
    admit(leg);
    return books;
  }
  /** What this job has yet to fill on a leg; a close needs at least that much position left. */
  function unfilledOf(job: Job, index: 0 | 1): string {
    const left = sub(legAt(job, index).quantity, add('0', ...opsOf(job.id).filter(item => item.leg === index).map(item => item.filledQuantity)));
    return cmp(left, '0') > 0 ? left : '0';
  }
  /**
   * Where a local chase lead posts: its own side's best price, held inside its chase bound (the leg's limit, else the
   * preview bound) and, for a sell, under its ceiling. A price that would take liquidity is refused, never sent.
   */
  function chaseTarget(leg: PlannedLeg, quote: Pick<Quote, 'bid' | 'ask'>): string {
    const bound = leg.limitPrice ?? leg.priceBound ?? reject('chase_unsupported', '本地追价缺少追价界限，未发送', 409);
    let price: string;
    if (leg.orderSide === 'buy') price = cmp(quote.bid, bound) < 0 ? quote.bid : bound;
    else {
      price = cmp(quote.ask, bound) > 0 ? quote.ask : bound;
      if (leg.chaseCeiling && cmp(price, leg.chaseCeiling) > 0) price = leg.chaseCeiling;
    }
    if (leg.orderSide === 'buy' ? cmp(price, quote.ask) >= 0 : cmp(price, quote.bid) <= 0) reject('price_moved', `${VENUE_NAMES[leg.venue]} ${leg.symbol} 挂 ${price} 会立即成交（盘口 ${quote.bid} / ${quote.ask}），暂不挂单`, 409);
    return price;
  }
  function admit(leg: PlannedLeg): void {
    if (control) control.admit(bindingStillValid(leg), budgets.callTimeoutMs);
  }
  /**
   * The hedge reduces the lead's exposure: only the account basis that decides its quantity is required (L084).
   * A resumed hedge expects the preview baseline moved by the fills of this job's earlier hedge orders.
   */
  async function guardHedge(job: PairJob): Promise<void> {
    const leg = job.legs[1], binding = bindingStillValid(leg), snapshot = await readAccount(binding, leg.symbol);
    // This job's own orders may still show in a snapshot read just after they ended (as in guardLead): a chasing hedge's post cancelled a moment ago.
    const own = opsOf(job.id);
    const { baseline, positionMode } = checkLegAccount({ ...leg, quantity: '0' }, snapshot, job.action, own);
    if (cmp(baseline, expectedPosition(job, 1)) !== 0 || positionMode !== leg.positionMode) reject('position_changed', `${VENUE_NAMES[leg.venue]} ${leg.symbol} 持仓已变化，对冲腿未发送`, 409);
    admit(leg);
  }

  async function send(job: Job, index: 0 | 1, quantity: string, attempt = 0, lead: { batch: number; price: string | null; books?: readonly Quote[] } = { batch: 0, price: null }): Promise<void> {
    const leg = legAt(job, index), orderType = leg.orderType, clientOrderId = clientOrderIdFor(job, index, attempt);
    let request: OrderRequest | ChaseRequest;
    // A chasing hedge with no price goes to market (its time is up, or the job is winding down); a lead always posts.
    if (orderType === 'local-chase' && (index === 0 || lead.price !== null)) {
      // Post-only, so the venue refuses it rather than let it take liquidity past the chase bound.
      if (lead.price === null) reject('chase_unsupported', '本地追价需要挂单价，未发送', 409);
      request = { clientOrderId, symbol: leg.symbol, side: leg.orderSide, positionSide: leg.side, quantity, type: 'limit', limitPrice: lead.price, timeInForce: 'gtx', reduceOnly: leg.reduceOnly };
    } else if (orderType === 'chase') {
      // The preview bound is the venue-enforced protection of a chase lead, as the IOC limit is for a market lead.
      if (index !== 0 || !leg.priceBound) reject('chase_unsupported', '追价策略只用于首腿且需要价格保护界限，未发送', 409);
      request = { clientOrderId, symbol: leg.symbol, side: leg.orderSide, positionSide: leg.side, quantity, type: 'chase', maxChasePrice: leg.priceBound as string, reduceOnly: leg.reduceOnly };
    } else {
      // A market lead goes out as an IOC limit at its preview bound, so the venue itself enforces the protection (L100).
      const protectedLead = index === 0 && orderType === 'market' && leg.priceBound != null;
      const type = protectedLead ? 'limit' : orderType === 'local-chase' ? 'market' : orderType;
      request = {
        clientOrderId, symbol: leg.symbol, side: leg.orderSide, positionSide: leg.side, quantity,
        type, limitPrice: protectedLead ? leg.priceBound as string : type === 'market' ? null : leg.limitPrice,
        timeInForce: protectedLead || type === 'market' ? 'ioc' : 'gtc', reduceOnly: leg.reduceOnly,
      };
    }
    const op: Operation = { id: randomUUID(), jobId: job.id, leg: index, attempt, ...(index === 0 ? { batch: lead.batch } : {}), venue: leg.venue, kind: request.type === 'chase' ? 'strategy' : 'order', clientOrderId, request, state: 'prepared', remoteId: null, filledQuantity: '0', averagePrice: null, venueStatus: null,
      preparedAt: now(), sentAt: null, lastCheckedAt: null, absentChecks: 0, absentAt: null, positionMismatchAt: null, cancelSent: 0, cancelRequestedAt: null, note: null,
      ...(request.type === 'chase' ? { strategyStatus: null, childrenSettled: false, childrenWaitSince: null, adoptedAt: null } : {}) };
    inFlight.add(op.id);
    try { await sendPrepared(job, index, op, request, lead.books); } finally { inFlight.delete(op.id); }
  }
  async function sendPrepared(job: Job, index: 0 | 1, op: Operation, request: OrderRequest | ChaseRequest, books?: readonly Quote[]): Promise<void> {
    const leg = legAt(job, index), quantity = request.quantity;
    const binding = write(() => {
      const current = readJob(job.id);
      // After a takeover only the hedge may still go out; any earlier order of the same leg must be settled and older.
      const earlier = opsOf(job.id).filter(item => item.leg === index);
      if (FINAL_JOB.has(current.status) || (index === 0 && (current.holdNewSends || !!current.peerHalt)) || stopRequested(job.id)
        || earlier.some(item => attemptOf(item) >= attemptOf(op) || !SETTLED.has(item.state))) reject('send_superseded', '任务状态已变化，本次不发送', 409);
      const valid = bindingStillValid(leg);
      db.prepare('INSERT INTO operations(id, job_id, leg, venue, client_order_id, state, settled, version, json) VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?)').run(op.id, job.id, index, leg.venue, op.clientOrderId, op.state, JSON.stringify(op));
      if (current.status === 'accepted') { current.status = 'running'; saveJob(current); }
      event(job.id, 'operation-prepared', { op: op.id, leg: index, quantity });
      return valid;
    });
    // The shared operation is recorded after the local prepared row and before the sending mark, so either store alone proves transport was not called.
    let registered: WriterOperation | null = null;
    if (control) {
      try { registered = control.prepareCreate(binding, job.id, request); }
      catch (error) {
        if (!(error instanceof ControlRefusal)) throw error;
        write(() => { const current = readOp(op.id); Object.assign(current, { state: 'not-sent', note: error.message.slice(0, 200) }); saveOp(current); event(job.id, 'operation-sent', { op: op.id, state: current.state, filled: '0' }); });
        return;
      }
    }
    try { write(() => { Object.assign(op, { state: 'sending', sentAt: now() }); saveOp(op); }); }
    catch (error) { if (registered) control?.finish(registered, 'rejected'); throw error; }
    let report: OrderReport | null = null, strategyId: string | null = null, failure: unknown = null;
    const beforeSend = () => {
      assertWriter();
      if (registered) control?.assertSend(registered, budgets.callTimeoutMs);
      const current = readJob(job.id);
      if (stopRequested(job.id) || FINAL_JOB.has(current.status)) throw new VenueError('not-sent', '任务已停止或结束，不再发出新委托');
      if (books) {
        const at = now();
        if (at >= current.deadlineAt || current.holdNewSends || current.peerHalt || current.leadWithdraw) {
          throw new VenueError('not-sent', '任务已停止、到期或不再允许发出新委托');
        }
        if (index === 1 && isPair(current) && hedgeChaseTimedOut(current, at)) throw new VenueError('not-sent', '对冲腿本段追价已到时限');
        try { for (const book of books) checkBook(book, at, budgets.sendQuoteMaxAgeMs); }
        catch (error) { throw new VenueError('not-sent', error instanceof Error ? error.message : '盘口已失效'); }
      }
    };
    try {
      if (request.type === 'chase') strategyId = parseStrategyAck(await callVenue('write', signal => chaseConnector(leg.venue).placeChase(binding, strategyRequestOf(request), { signal, beforeSend }))).strategyId;
      else report = parseOrderReport(await callVenue('write', signal => connectorFor(leg.venue).place(binding, request, { signal, beforeSend, ackOnly: true, positionMode: leg.positionMode })), request);
    } catch (error) { failure = error; }
    const ackAt = now();
    if (strategyId !== null) {
      const acked = strategyId;
      write(() => { const current = readOp(op.id); if (current.state !== 'sending') return; Object.assign(current, { ackStrategyId: acked, ackAt }); saveOp(current); });
    }
    const ack = strategyId === null ? null : await checkAck(op, binding, strategyId, ackAt);
    const settled = write(() => {
      const current = readOp(op.id);
      if (current.state !== 'sending') return null;
      // An id some other operation already holds cannot name this create; the answer is as good as none.
      const answer = strategyId !== null && claimedStrategies().has(strategyId) ? { orphan: `回报的策略编号 ${strategyId} 已被其他委托认领` } : ack;
      if (report) applyReport(current, report);
      else if (answer && 'report' in answer) applyStrategy(current, answer.report);
      else if (answer && 'unread' in answer) Object.assign(current, { state: 'open', remoteId: strategyId, strategyStatus: null, identityVerifiedAt: null, lastCheckedAt: now(), note: answer.unread });
      else if (failure instanceof VenueError && failure.kind === 'not-sent') Object.assign(current, { state: 'not-sent', note: failure.message.slice(0, 200) });
      else if (failure instanceof VenueError && failure.kind === 'rejected') Object.assign(current, { state: 'rejected', note: failure.message.slice(0, 200) });
      // Any other outcome, including a report that fails validation, leaves the result unknown.
      else if (isStrategy(current)) Object.assign(current, { state: 'unknown', note: `追价策略创建结果未知（${answer && 'orphan' in answer ? answer.orphan : failure instanceof Error ? failure.message.slice(0, 120) : '无回报'}）；交易所无客户编号，不重发` });
      else Object.assign(current, { state: 'unknown', note: `结果未知：${failure instanceof Error ? failure.message.slice(0, 160) : '无回报'}` });
      saveOp(current);
      event(job.id, 'operation-sent', { op: op.id, state: current.state, filled: current.filledQuantity, ...(strategyId !== null ? { strategyId } : {}) });
      return current.state as OpState;
    });
    // Released only after the local result is durable; anything left open is settled from local facts later.
    if (registered && settled) control?.finish(registered, outcomeOf(settled));
    if (settled === 'open' && report?.status === 'acknowledged') await reconcile(job, readOp(op.id));
  }
  type AckCheck = { report: StrategyReport } | { orphan: string } | { unread: string };
  /**
   * An acknowledged id is taken only once a read shows it names this create; an id that names another strategy or none
   * is as good as no answer. A failed read keeps the id, but it is never stopped until a read verifies it.
   */
  async function checkAck(op: Operation, binding: AccountBinding, strategyId: string, ackAt: number): Promise<AckCheck> {
    if (claimedStrategies().has(strategyId)) return { orphan: `回报的策略编号 ${strategyId} 已被其他委托认领` };
    try {
      const value = await callVenue('read', signal => chaseConnector(op.venue).queryStrategy(binding, strategyId, { signal, symbol: op.request.symbol }));
      if (value === null) return { orphan: `交易所查无回报的策略编号 ${strategyId}` };
      const report = parseStrategyReport(value, { ...strategyIdentity(op), strategyId });
      if (outsideAck(op, report.createdAt, ackAt, budgets.adoptSkewMs)) return { orphan: `回报的策略编号 ${strategyId} 的创建时间不在本委托发送时段内` };
      return { report };
    } catch (error) {
      if (error instanceof ContractError && error.code === 'strategy_identity') return { orphan: `回报的策略编号 ${strategyId} 经查询与本委托身份不一致` };
      return { unread: `回报的策略编号 ${strategyId} 暂未能查询核对身份（${error instanceof Error ? error.message.slice(0, 120) : '未知'}），核对前不发送停止` };
    }
  }
  function outcomeOf(state: OpState): WriteOutcome {
    if (state === 'open' || state === 'filled' || state === 'canceled') return 'confirmed';
    return state === 'rejected' || state === 'not-sent' || state === 'not-created' ? 'rejected' : 'unknown';
  }

  /** A paused strategy or one awaiting child settlement still needs reconciliation. */
  function applyStrategy(op: Operation, report: StrategyReport, reviewingQuantities = false): void {
    if ((!reviewingQuantities || boundedFill(op) !== null) && cmp(report.filledQuantity, op.filledQuantity) < 0) reject('report_regressed', '策略回报的成交数量回退，保留原状态', 409);
    // An ended strategy never runs again; a stale report saying otherwise would bring back stops and restart the children wait.
    if (op.strategyStatus === 'terminal' && report.status !== 'terminal') reject('report_regressed', '策略回报的状态从已结束回退，保留原状态', 409);
    const settled = report.status === 'terminal' && report.childrenSettled;
    const state: OpState = settled ? (cmp(report.filledQuantity, op.request.quantity) === 0 ? 'filled' : 'canceled') : 'open';
    const lagging = report.status === 'terminal' && !report.childrenSettled;
    if (report.status === 'working') op.verifiedWorking = true;
    Object.assign(op, { state, remoteId: report.strategyId, filledQuantity: report.filledQuantity, averagePrice: report.averagePrice, strategyStatus: report.status, childrenSettled: report.childrenSettled,
      childrenWaitSince: lagging ? op.childrenWaitSince ?? now() : null, identityVerifiedAt: now(), lastCheckedAt: now(), absentChecks: 0, absentAt: null });
    noteReportedShortLead(op);
  }
  function applyReport(op: Operation, report: OrderReport, reviewingQuantities = false): boolean {
    // Cumulative fills never go backwards; a lower count is a stale or foreign answer.
    if ((!reviewingQuantities || boundedFill(op) !== null) && cmp(report.filledQuantity, op.filledQuantity) < 0) reject('report_regressed', '委托回报的成交数量回退，保留原状态', 409);
    const state: OpState = report.status === 'filled' ? 'filled' : report.terminal ? (report.status === 'rejected' && isZero(report.filledQuantity) ? 'rejected' : 'canceled') : 'open';
    const working = report.status === 'new' || report.status === 'partially-filled';
    if (working) op.verifiedWorking = true;
    Object.assign(op, { state, remoteId: report.remoteId, filledQuantity: report.filledQuantity, averagePrice: report.averagePrice, venueStatus: report.status, lastCheckedAt: now(), absentChecks: 0, absentAt: null });
    noteReportedShortLead(op);
    return working;
  }

  // ---- reconciliation ----------------------------------------------------------
  /** The send starts at most a call timeout after the count; the venue then accepts the signed cancel until its validity ends. */
  const cancelSettledAt = (op: Operation): number => (op.cancelRequestedAt ?? 0) + budgets.callTimeoutMs + connectorFor(op.venue).capabilities.requestValidityMs + budgets.createArrivalMarginMs;
  const createSettledAt = (op: Operation): number => (op.sentAt ?? op.preparedAt) + Math.max(budgets.createObserveMs, budgets.callTimeoutMs + budgets.createArrivalMarginMs, connectorFor(op.venue).capabilities.requestValidityMs + budgets.createArrivalMarginMs);

  /**
   * A prepared or sending row that this process is not sending was interrupted by a failed write.
   * prepared never reached transport (the sending mark commits first); sending may have.
   */
  function recoverIdle(op: Operation): void {
    if (inFlight.has(op.id) || (op.state !== 'prepared' && op.state !== 'sending')) return;
    if (op.state === 'sending' && now() - (op.sentAt ?? op.preparedAt) < budgets.callTimeoutMs) return;
    write(() => {
      const current = readOp(op.id);
      if (inFlight.has(current.id) || (current.state !== 'prepared' && current.state !== 'sending')) return;
      Object.assign(current, current.state === 'prepared'
        ? { state: 'not-sent', note: '落盘后发送标记未写入，传输未调用' }
        : { state: 'unknown', note: isStrategy(current) ? `追价策略发送结果未能写入，结果未知；交易所无客户编号，需人工认领或确认未创建${ackHint(current)}` : '发送结果未能写入，按原客户订单号核对' });
      saveOp(current); event(op.jobId, 'operation-recovered', { op: op.id, state: current.state });
    });
  }

  /** Returns true only when this read verified the original order and found it still open. */
  async function reconcile(job: Job, op: Operation): Promise<boolean | void> {
    // A released create has nothing the venue can be asked about, and its release note must stay.
    if (op.releasedAt != null) return;
    const leg = legAt(job, op.leg), row = accountFor(leg.venue);
    // Reconciling on another principal could find nothing and wrongly conclude not-created.
    if (!row || row.account_key !== leg.accountKey) { write(() => { const current = readOp(op.id); current.note = '账户绑定已变化，暂停核对'; saveOp(current); }); return; }
    if (isStrategy(op)) return reconcileStrategy(job, op, bindingOf(row));
    if (op.identityMismatchAt != null) return;
    const binding = bindingOf(row), startedAt = now(), request = op.request as OrderRequest;
    let report: OrderReport | null;
    try {
      const value = await callVenue('read', signal => connectorFor(op.venue).query(binding, request, { signal, remoteId: op.remoteId, positionMode: leg.positionMode }));
      report = value === null ? null : parseOrderReport(value, request, op.remoteId);
    }
    catch (error) {
      write(() => {
        const current = readOp(op.id);
        if (error instanceof OrderOwnerConflict) return holdOrderOwnerConflict(job, current);
        current.note = `核对读取失败：${error instanceof Error ? error.message.slice(0, 160) : '未知'}`; current.lastCheckedAt = now();
        // Misses must be consecutive answers; a failed read in between starts the count again.
        if (current.state === 'unknown') { current.absentChecks = 0; current.absentAt = null; }
        saveOp(current);
      });
      return;
    }
    if (report) {
      const found = report;
      return write(() => {
        const current = readOp(op.id);
        if (SETTLED.has(current.state)) return;
        const working = applyReport(current, found, !!job.fourLegQuantityIssue); current.note = null;
        if (working) current.openCheckedFrom = startedAt;
        saveOp(current); event(job.id, 'operation-reconciled', { op: op.id, state: current.state });
        return working;
      });
    }
    if (op.state === 'open') { write(() => { const current = readOp(op.id); current.note = '交易所暂未查到原委托，保留编号继续核对'; saveOp(current); }); return; }
    // A damaged ledger cannot prove that the account has no trace of an unknown order.
    if (op.state !== 'unknown' || job.fourLegQuantityIssue) return;
    // A miss is not proof (L039/L093): wait out the request validity window, count spaced misses, then require the account to show no trace.
    const counted = write(() => {
      const current = readOp(op.id);
      if (current.state !== 'unknown') return null;
      if (now() < createSettledAt(current)) { current.absentChecks = 0; current.lastCheckedAt = now(); saveOp(current); return null; }
      if (current.absentAt !== null && now() - current.absentAt < budgets.absentSpacingMs) return null;
      current.absentChecks += 1; current.absentAt = now(); current.lastCheckedAt = now(); saveOp(current);
      return current.absentChecks >= budgets.absentChecks ? current : null;
    });
    if (!counted) return;
    // The account read happens after the order query so the decision uses the latest evidence (L091).
    let snapshot: AccountSnapshot;
    try { snapshot = await readAccount(binding, leg.symbol); }
    catch (error) {
      if (error instanceof WriterLostError) throw error;
      write(() => { const current = readOp(op.id); if (current.state !== 'unknown') return; current.note = `查无原委托，但账户读取失败，无法确认无痕迹：${error instanceof Error ? error.message.slice(0, 120) : '未知'}`; saveOp(current); });
      return;
    }
    const expected = expectedPosition(job, op.leg);
    const traceFree = cmp(positionOf(snapshot, leg.symbol, leg.side), expected) === 0 && !snapshot.openOrders.some(order => order.symbol === leg.symbol);
    write(() => {
      const current = readOp(op.id);
      if (current.state !== 'unknown') return;
      if (!traceFree) {
        if (current.positionMismatchAt === null) { current.positionMismatchAt = now(); event(job.id, 'operation-mismatch', { op: op.id }); }
        current.note = '查无原委托，但当前持仓或挂单与已知成交不一致，保留待核对'; saveOp(current); return;
      }
      Object.assign(current, { state: 'not-created', note: '超过请求有效窗口后多次按客户订单号查询均不存在，且持仓与挂单无痕迹，判定未送达' });
      saveOp(current); event(job.id, 'operation-not-created', { op: op.id });
    });
  }
  /** Only by strategy id: without one there is nothing the venue can be asked, and a miss is never read as not created. */
  async function reconcileStrategy(job: Job, op: Operation, binding: AccountBinding): Promise<boolean | void> {
    const strategyId = op.remoteId;
    if (strategyId === null) return;
    const startedAt = now();
    let report: StrategyReport | null;
    try { const value = await callVenue('read', signal => chaseConnector(op.venue).queryStrategy(binding, strategyId, { signal, symbol: op.request.symbol })); report = value === null ? null : parseStrategyReport(value, { ...strategyIdentity(op), strategyId }); }
    catch (error) {
      if (error instanceof ContractError && error.code === 'strategy_identity') return strategyMismatch(job, op, strategyId);
      write(() => { const current = readOp(op.id); current.note = `策略核对读取失败：${error instanceof Error ? error.message.slice(0, 160) : '未知'}`; current.lastCheckedAt = now(); saveOp(current); });
      return;
    }
    if (!report) {
      write(() => {
        const current = readOp(op.id);
        if (SETTLED.has(current.state) || current.remoteId !== strategyId) return;
        if (current.identityVerifiedAt == null) return disown(current, `交易所查无回报的策略编号 ${strategyId}`);
        current.note = '交易所查无该追价策略编号，保留待人工核对'; current.lastCheckedAt = now(); saveOp(current);
      });
      return;
    }
    const found = report;
    return write(() => {
      const current = readOp(op.id);
      if (SETTLED.has(current.state) || current.remoteId !== strategyId) return;
      // The first read that verifies an id checks its creation time too, whether at the answer or later after a failed read.
      if (current.identityVerifiedAt == null && outsideAck(current, found.createdAt, current.ackAt ?? (current.sentAt ?? current.preparedAt) + budgets.callTimeoutMs, budgets.adoptSkewMs)) {
        return disown(current, `回报的策略编号 ${strategyId} 的创建时间不在本委托发送时段内`);
      }
      applyStrategy(current, found, !!job.fourLegQuantityIssue);
      current.note = strategyNote(current);
      if (current.state === 'open') current.openCheckedFrom = startedAt;
      saveOp(current); event(job.id, 'operation-reconciled', { op: op.id, state: current.state, strategyStatus: current.strategyStatus, filled: current.filledQuantity });
      return current.state === 'open';
    });
  }
  const strategyNote = (op: Operation): string | null => {
    if (op.adoptedAt == null) return null;
    const tries = Math.max(op.manualStops ?? 0, op.cancelSent);
    return tries >= budgets.cancelAttempts && op.strategyStatus !== 'terminal' ? `人工认领的追价策略：已尝试停止 ${tries} 次仍未结束，不再自动停止；需人工在交易所处理` : '人工认领的追价策略';
  };
  /**
   * The id answered for something else. One never verified did not name this create, which is then as unknown as one
   * without an answer; a verified one is kept but nothing more is sent to it. Either way a person takes over.
   */
  function strategyMismatch(job: Job, op: Operation, strategyId: string): void {
    write(() => {
      const current = readOp(op.id);
      if (SETTLED.has(current.state) || current.remoteId !== strategyId) return;
      const verified = current.identityVerifiedAt != null;
      event(job.id, 'strategy-identity-mismatch', { op: op.id, strategyId, verified });
      if (!verified) return disown(current, `回报的策略编号 ${strategyId} 经查询与本委托身份不一致`);
      Object.assign(current, { identityMismatchAt: current.identityMismatchAt ?? now(), note: `策略编号 ${strategyId} 的查询回报与本委托身份不一致，不再对其发送停止；需人工核对` });
      current.lastCheckedAt = now(); saveOp(current);
      const latest = readJob(job.id);
      if (!FINAL_JOB.has(latest.status)) finish(latest, 'attention', `${VENUE_NAMES[current.venue]} 追价策略编号 ${strategyId} 的查询回报与本委托身份不一致，不对其发送停止；需人工核对`);
    });
  }
  /** Inside a write: keep the original receipt and stop both new exposure and cancels targeting the disputed ID. */
  function holdOrderOwnerConflict(job: Job, op: Operation): void {
    if (SETTLED.has(op.state) || op.identityMismatchAt != null) return;
    op.identityMismatchAt = op.lastCheckedAt = now();
    op.note = `${VENUE_NAMES[op.venue]} 原交易所委托编号 ${op.remoteId} 返回另一客户订单号，已暂停自动查撤，需人工核对`;
    saveOp(op);
    event(job.id, 'order-identity-mismatch', { op: op.id });
    const latest = readJob(job.id);
    if (!FINAL_JOB.has(latest.status)) finish(latest, 'attention', op.note);
  }
  /**
   * Inside a write. An id no read has verified did not name this create, which is then as unknown as one without an
   * answer: it holds the job for a person exactly like that one, so the job cannot be acknowledged until it is resolved.
   */
  function disown(current: Operation, cause: string): void {
    const strategyId = current.remoteId;
    Object.assign(current, { state: 'unknown', remoteId: null, strategyStatus: null, lastCheckedAt: now(), note: `${cause}，追价策略创建结果未知；交易所无客户编号，不重发` });
    saveOp(current);
    event(current.jobId, 'strategy-disowned', { op: current.id, strategyId });
    const job = readJob(current.jobId);
    if (!FINAL_JOB.has(job.status)) finish(job, 'attention', orphanReason(current));
  }
  /** Baseline plus this job's settled fills on the leg, excluding the operation under test (which has none known). */
  function expectedPosition(job: Job, index: 0 | 1): string {
    const leg = legAt(job, index), filled = add('0', ...opsOf(job.id).filter(item => item.leg === index).map(item => item.filledQuantity));
    return job.action === 'open' ? add(leg.baseline, filled) : sub(leg.baseline, filled);
  }

  const cancelDue = (op: Operation): boolean => op.cancelSent < budgets.cancelAttempts && (op.cancelRequestedAt === null || now() - op.cancelRequestedAt >= budgets.cancelRetryMs);
  /** For a strategy this is a stop, which only proves the venue accepted it; the strategy is read again whatever the answer. */
  async function cancel(job: Job, op: Operation, reason?: string): Promise<void> {
    if (!cancelDue(op) || op.identityMismatchAt != null) return;
    const strategyId = isStrategy(op) ? op.remoteId : undefined;
    // Checked here too, so no caller can stop a strategy id that no read has shown to be this create's.
    if (strategyId === null || (strategyId !== undefined && op.identityVerifiedAt == null)) return;
    const guardedWithdrawal = job.status === 'attention' || !!job.fourLegQuantityIssue;
    const leg = legAt(job, op.leg), binding = guardedWithdrawal ? bindingStillValid(leg) : bindingOf(accountFor(leg.venue) ?? reject('account_missing', '账户绑定缺失，保留待核对', 409));
    const seq = (op.cancelSeq ?? 0) + 1;
    let stopFailed: string | null = null;
    // The shared operation comes first: a sequence above the local one then proves this cancel was never sent.
    let registered: WriterOperation | null = null;
    if (control) {
      try { registered = control.prepareCancel(binding, job.id, op.request, seq, strategyId); }
      catch (error) {
        if (!(error instanceof ControlRefusal)) throw error;
        write(() => { const current = readOp(op.id); current.cancelBlockedAt ??= now(); current.note = `撤单未发送：${error.message.slice(0, 160)}`; saveOp(current); });
        return;
      }
    }
    cancelling.add(op.id);
    try {
      // Counted before transport so a crash mid-request stays counted; only a provable not-sent gives it back.
      try { write(() => { const current = readOp(op.id); current.cancelSent += 1; current.cancelSeq = seq; current.cancelRequestedAt = now(); current.cancelBlockedAt = null; saveOp(current); event(job.id, 'cancel-sent', { op: op.id, attempt: current.cancelSent, ...(reason ? { reason } : {}) }); }); }
      catch (error) { if (registered) control?.finish(registered, 'rejected'); throw error; }
      let outcome: WriteOutcome | null = null;
      const beforeSend = () => {
        assertWriter();
        const latest = readJob(job.id);
        if (latest.acknowledgedAt != null) reject('already_acknowledged', '已人工接管，停止自动撤单', 409);
        if (FINAL_JOB.has(latest.status) && !guardedWithdrawal) reject('withdrawal_changed', '任务已转入结清或人工核对，本次撤单停止', 409);
        if (guardedWithdrawal) bindingStillValid(leg);
        if (registered) control?.assertSend(registered, budgets.callTimeoutMs);
      };
      try {
        if (strategyId !== undefined) {
          const ack = parseStrategyAck(await callVenue('write', signal => chaseConnector(op.venue).stopStrategy(binding, strategyId, { signal, beforeSend })));
          if (ack.strategyId !== strategyId) reject('strategy_identity', '停止回报的策略编号与本操作不一致', 502);
          outcome = 'confirmed';
        } else {
          const request = op.request as OrderRequest;
          const report = parseOrderReport(await callVenue('write', signal => connectorFor(op.venue).cancel(binding, request, { signal, beforeSend, remoteId: op.remoteId, positionMode: leg.positionMode })), request, op.remoteId);
          write(() => { const current = readOp(op.id); if (SETTLED.has(current.state)) return; applyReport(current, report); saveOp(current); });
          outcome = 'confirmed';
        }
      } catch (error) {
        outcome ??= error instanceof VenueError && (error.kind === 'not-sent' || error.kind === 'rejected') ? 'rejected' : 'unknown';
        const note = `撤单未确认：${error instanceof Error ? error.message.slice(0, 160) : '未知'}`;
        stopFailed = note;
        write(() => {
          const current = readOp(op.id);
          if (error instanceof OrderOwnerConflict) return holdOrderOwnerConflict(job, current);
          if (error instanceof VenueError && error.kind === 'not-sent') current.cancelSent -= 1;
          current.note = note; saveOp(current);
        });
      }
      if (registered) control?.finish(registered, outcome);
    } finally { cancelling.delete(op.id); }
    if (strategyId === undefined) return;
    try { await reconcile(job, readOp(op.id)); } catch (error) { if (error instanceof WriterLostError) throw error; }
    // The read clears the note; a failed stop must stay visible while the strategy still runs.
    const note = stopFailed ?? reason;
    if (note) write(() => { const current = readOp(op.id); if (stopFailed && SETTLED.has(current.state)) return; current.note = note; saveOp(current); });
  }

  // ---- job progression ---------------------------------------------------------
  async function progress(job: Job): Promise<void> {
    const initial = opsOf(job.id), unsettled = initial.filter(item => !SETTLED.has(item.state));
    const issue = fourLegQuantityIssue(job, initial);
    if (issue) { write(() => holdInvalidQuantities(readJob(job.id), issue, '执行时')); return; }
    for (const op of unsettled) recoverIdle(op);
    for (const op of opsOf(job.id).filter(item => !SETTLED.has(item.state))) {
      if (op.state !== 'unknown' && op.state !== 'open') continue;
      // A failed check must not skip the bounded escalation below.
      try { await reconcile(job, op); }
      catch (error) {
        if (error instanceof WriterLostError) throw error;
        write(() => { const current = readOp(op.id); if (SETTLED.has(current.state)) return; current.note = `核对失败：${error instanceof Error ? error.message.slice(0, 160) : '未知'}`; saveOp(current); });
      }
    }
    // A write this pass settled must not read as an unresolved registry entry when the same pass resends.
    settleControl();
    if (FINAL_JOB.has(readJob(job.id).status)) return;
    if (holdOrphan(job.id)) return;
    // The grace starts no earlier than this writer's takeover, so a long outage still gets full checks before escalation.
    const unresolved = opsOf(job.id).find(item => item.state === 'unknown' && now() >= Math.max(createSettledAt(item), heldSince) + budgets.unresolvedGraceMs);
    if (unresolved) {
      const reason = `${VENUE_NAMES[unresolved.venue]} 委托超过观察窗仍无法确认（${(unresolved.note ?? '无回报').slice(0, 120)}），不再发送；需人工核对`;
      // A lead order still resting would keep filling with nobody hedging: it is withdrawn before the job goes to a person.
      if (!restingLeadOrder(job.id)) { write(() => finish(readJob(job.id), 'attention', reason)); return; }
      holdLead(job.id, reason);
    }
    job = readJob(job.id);
    const stop = stopRequested(job.id);
    const pastDeadline = now() >= job.deadlineAt;
    // After a takeover nothing new is sent, so resting orders are withdrawn instead of waiting for the deadline; so too when the hedge cannot go on.
    const withdraw = stop || pastDeadline || job.holdNewSends || !!job.leadWithdraw || !!job.peerHalt;
    for (const op of opsOf(job.id).filter(item => item.state === 'open')) {
      if (!wantsStop(op, withdraw)) continue;
      const latest = readJob(job.id);
      if (FINAL_JOB.has(latest.status)) return;
      await cancel(latest, op, withdraw ? undefined : '追价策略被交易所暂停，已停止；按实际成交对冲');
    }
    job = readJob(job.id);
    const deviation = job.leadDeviation ?? null;
    if (FINAL_JOB.has(job.status)) return;
    // A chasing hedge's post whose cancels ran out waits while a lead order is still being withdrawn, so the job does not go to a
    // person while that lead may still fill; the lead's own cancels are bounded by the same check. The wait itself is bounded too
    // (a cancel that is never sent does not count), after which the post goes to a person whatever the lead's state.
    const leadUnsettled = withdraw && opsOf(job.id).some(item => item.leg === 0 && !isStrategy(item) && !SETTLED.has(item.state));
    const leadWait = budgets.cancelAttempts * budgets.cancelRetryMs + budgets.unresolvedGraceMs;
    const exhausted = opsOf(job.id).find(item => item.state === 'open' && wantsStop(item, withdraw) && item.cancelSent >= budgets.cancelAttempts && item.cancelRequestedAt !== null
      && now() - item.cancelRequestedAt >= (leadUnsettled && isPostedHedge(item) ? Math.max(budgets.cancelRetryMs, leadWait) : budgets.cancelRetryMs));
    if (exhausted) {
      const which = isPair(job) ? (exhausted.leg === 0 ? '首腿' : '对冲腿') : '';
      const leadToo = leadUnsettled && exhausted.leg !== 0 ? '，首腿委托也可能仍在挂单' : '';
      write(() => finish(readJob(job.id), 'attention', `${withdrawnFor(job)}${which}撤单 ${exhausted.cancelSent} 次仍未确认，委托可能仍在挂单${leadToo}；需人工核对`));
      return;
    }
    // A refusal caused by this order's own unknown cancel clears once that cancel's window has passed, so the grace counts from then;
    // like every grace here it starts no earlier than this writer's takeover.
    const blocked = opsOf(job.id).find(item => item.state === 'open' && wantsStop(item, withdraw) && item.cancelBlockedAt != null && now() >= Math.max(item.cancelBlockedAt, item.cancelRequestedAt === null ? 0 : cancelSettledAt(item), heldSince) + budgets.unresolvedGraceMs);
    if (blocked) { write(() => finish(readJob(job.id), 'attention', `${withdrawnFor(job)}撤单被账户写入登记阻止超过 ${budgets.unresolvedGraceMs} 毫秒（${(blocked.note ?? '').slice(0, 120)}），委托仍在挂单；需人工核对`)); return; }
    const lagging = opsOf(job.id).find(item => item.state === 'open' && item.childrenWaitSince != null && now() >= Math.max(item.childrenWaitSince, heldSince) + budgets.unresolvedGraceMs);
    if (lagging) { write(() => finish(readJob(job.id), 'attention', `${VENUE_NAMES[lagging.venue]} 追价策略已结束，但子单超过 ${budgets.unresolvedGraceMs} 毫秒仍未结清，成交量无法确认；需人工核对`)); return; }
    // An id that no read has verified is never stopped, so it may run on unseen; that too is bounded by the grace.
    const unverified = opsOf(job.id).find(item => isStrategy(item) && item.state === 'open' && item.identityVerifiedAt == null && now() >= Math.max(item.sentAt ?? item.preparedAt, heldSince) + budgets.unresolvedGraceMs);
    if (unverified) {
      write(() => {
        const current = readOp(unverified.id);
        if (current.state === 'open' && current.identityVerifiedAt == null) disown(current, `回报的策略编号 ${current.remoteId} 超过 ${budgets.unresolvedGraceMs} 毫秒仍未能查询核对身份，未对其发送停止`);
      });
      return;
    }
    if (!isPair(job)) { await progressRebalance(job, stop); return; }
    const ops = unsettled.length ? opsOf(job.id) : initial;
    // Reconciliation or a cancel may just have learned another cumulative fill. Use those same rows for the next send.
    const updatedIssue = unsettled.length ? fourLegQuantityIssue(job, ops) : null;
    if (updatedIssue) { write(() => holdInvalidQuantities(readJob(job.id), updatedIssue, '核对回报后')); return; }
    const byAttempt = (a: Operation, b: Operation) => attemptOf(a) - attemptOf(b);
    const leads = ops.filter(op => op.leg === 0).sort(byAttempt), hedges = ops.filter(op => op.leg === 1).sort(byAttempt);
    if (leads.length === 0) {
      if (stop) { write(() => finish(readJob(job.id), 'stopped', '已停止，未发送任何委托')); return; }
      if (job.peerHalt) { write(() => finish(readJob(job.id), 'stopped', `四腿联动停止（${job.peerHalt}），未发送任何委托`)); return; }
      if (job.holdNewSends) { write(() => finish(readJob(job.id), 'failed', '服务恢复后不再发送新委托')); return; }
      // Four legs: the other venue's job is checked alongside (in parallel, so this one's quote stays fresh for the send).
      let books: Quote[];
      try { books = await groupLeadBooks(job); }
      catch (error) {
        if (error instanceof WriterLostError) throw error;
        const reason = error instanceof Error ? error.message.slice(0, 200) : '发送前检查失败';
        const retry = error instanceof ContractError && ['venue_read_failed', 'quote_window', 'four_leg_peer'].includes(error.code) || error instanceof ControlRefusal && error.transient;
        if (retry && now() < job.deadlineAt) { write(() => { const current = readJob(job.id); if (current.reason !== reason) { current.reason = reason; saveJob(current); } }); return; }
        write(() => finish(readJob(job.id), 'failed', reason, error instanceof ContractError && error.code === 'price_moved' ? 'price_moved' : undefined)); return;
      }
      try { await sendLead(job, books, 0, 0); }
      catch (error) {
        if (!(error instanceof ContractError) || error.code !== 'price_moved') throw error;
        write(() => finish(readJob(job.id), 'failed', error.message.slice(0, 200), 'price_moved')); return;
      }
      holdOrphan(job.id);
      return;
    }
    // A strategy, or an order whose state is not known, is waited out; under an order of the job's own that rests, what it filled is hedged.
    const resting = leads.find(item => !SETTLED.has(item.state));
    if (resting && (resting.state !== 'open' || isStrategy(resting))) return;
    // Once the last lead settles its batch remainder is known, even if a hedge is still unknown or new leads are prohibited.
    const decision = resting ? null : nextLead(job, leads);
    if (job.group && rememberLeadSkip(job, decision?.skipped)) write(() => saveJob(job));
    // A chasing hedge's own order that rests is followed below (docs/oil.md 13); any other unsettled hedge is waited out.
    const postedHedge = hedges.find(item => !SETTLED.has(item.state));
    if (postedHedge && (postedHedge.state !== 'open' || !isPostedHedge(postedHedge) || withdraw)) return;
    // Resume from what is on disk (L095): hedge what the lead filled minus what earlier hedge orders filled.
    const leadFilled = add('0', ...leads.map(item => item.filledQuantity));
    const hedgeLeg = job.legs[1], hedged = add('0', ...hedges.map(item => item.filledQuantity));
    const target = hedgeQuantityFor(job, leadFilled), gap = sub(target, hedged);
    const remaining = cmp(gap, '0') > 0 ? floorToStep(gap, hedgeLeg.instrument.quantityStep) : '0';
    // A refused market hedge is final; a refused post-only hedge counts as a missed post, and the chase goes to market after a few.
    const refused = hedges.at(-1)?.state === 'rejected' && !isPostedHedge(hedges.at(-1) as Operation);
    const hedgeChasing = hedgeLeg.orderType === 'local-chase' && !withdraw && !hedgeChaseOver(job, hedges);
    // An opening hedge below the venue's minimum notional is refused. While the lead goes on (an order of it rests, or a local chase
    // posts again after a reprice or for the next batch) and so may fill in pieces, a reserve worth 1.2 times that minimum stays
    // unhedged, so the last hedge is never too small; a hedge contract whose minimum quantity is already worth that needs none.
    const upcoming = !refused && !withdraw && !deviation ? decision : null;
    const notional = (quantity: string): string => mul(exposure(quantity, hedgeLeg.instrument), hedgeLeg.quote.bid);
    // A market lead's IOC may read as open for a pass, but it never goes on, so it holds no reserve.
    const leadGoesOn = reserveNeeded(hedgeLeg) && job.action === 'open' && !withdraw && !refused
      && ((!!resting && job.legs[0].orderType !== 'market') || (job.legs[0].orderType === 'local-chase' && !!upcoming?.order));
    let hedgeNow = remaining;
    if (leadGoesOn) {
      const keep = reserveFor(hedgeLeg.instrument, hedgeLeg.quote.bid);
      hedgeNow = cmp(remaining, keep) > 0 ? floorToStep(sub(remaining, keep), hedgeLeg.instrument.quantityStep) : '0';
      if (cmp(notional(hedgeNow), mul(hedgeLeg.instrument.minNotional, MIN_NOTIONAL_MARGIN)) < 0) hedgeNow = '0';
    } else if (job.action === 'open' && !refused && !stop && !resting && !postedHedge && cmp(remaining, hedgeLeg.instrument.minQuantity) >= 0 && cmp(notional(remaining), hedgeLeg.instrument.minNotional) < 0) {
      // The lead is over and what it left unhedged is too small for any opening hedge: a person closes it on the lead account.
      write(() => finish(readJob(job.id), 'attention', `${withdrawnFor(job)}首腿结束后未对冲 ${remaining}（按预览价约 ${notional(remaining)} USDT）低于${VENUE_NAMES[hedgeLeg.venue]}最小名义金额 ${hedgeLeg.instrument.minNotional}，无法开对冲单；可在首腿账户只减仓平掉这部分，需人工处理`));
      return;
    }
    // Escalation while a lead order rests withdraws it first; the job goes to a person once it has settled.
    const escalate = async (reason: string): Promise<void> => {
      if (resting) { holdLead(job.id, reason); await cancel(readJob(job.id), resting); return; }
      write(() => finish(readJob(job.id), 'attention', reason));
    };
    if (postedHedge) {
      // A post whose cancels all went unconfirmed may still rest: the lead stops and a person checks it, rather than waiting for the deadline.
      if (postedHedge.cancelSent >= budgets.cancelAttempts && postedHedge.cancelRequestedAt !== null && now() - postedHedge.cancelRequestedAt >= budgets.cancelRetryMs) {
        await escalate(`对冲腿追价挂单撤单 ${postedHedge.cancelSent} 次仍未确认，委托可能仍在挂单；首腿敞口保留，需人工核对`);
        return;
      }
      // Its time is up: withdrawn first, and the next pass sends the rest to market. Otherwise it follows the book and the lead's fills.
      if (!hedgeChasing) await cancel(job, postedHedge, `对冲腿追价${hedgeChaseTimedOut(job, now()) ? `超过 ${(hedgeLeg.chaseTimeoutMs ?? HEDGE_CHASE_TIMEOUT_MS) / 1000} 秒` : '结束'}，撤单后剩余按市价补齐`);
      else await repriceHedge(job, postedHedge, hedgeNow);
      return;
    }
    if (!refused && !stop && cmp(hedgeNow, hedgeLeg.instrument.minQuantity) >= 0) {
      // Only hedge orders that fell short count: a job that hedges batch by batch or fill by fill sends many that fill in full.
      // A chasing hedge's posts end unfilled by design (reprices); they are bounded by the chase time and the order limit.
      const short = hedges.filter(item => item.state !== 'filled' && !isPostedHedge(item)).length;
      if (short >= budgets.hedgeAttempts || hedges.length >= budgets.chaseOrderLimit) {
        await escalate(`对冲腿已有 ${short >= budgets.hedgeAttempts ? `${short} 笔未全部成交` : `${hedges.length} 笔委托`}，仍差 ${remaining}，不再补发；首腿敞口保留，需人工处理`);
        return;
      }
      try { await guardHedge(job); }
      catch (error) {
        // A position that disagrees may be the venue lagging behind the last fill (L110); it must persist through the grace before a person is called.
        const waiting = error instanceof ContractError && error.code === 'venue_read_failed' ? '账户读取' : error instanceof ControlRefusal && error.transient ? '账户写入登记'
          : error instanceof ContractError && error.code === 'position_changed' ? '持仓核对' : null;
        if (waiting) {
          const message = error instanceof Error ? error.message : '未知';
          // A wait recorded by a previous writer restarts at the takeover, so a fresh process still gets the full grace.
          const since = Math.max(readJob(job.id).hedgeWaitSince ?? now(), heldSince);
          if (now() - since >= budgets.unresolvedGraceMs) { await escalate(`对冲腿持续无法发送（最后原因：${waiting}，${message.slice(0, 120)}）；首腿敞口保留，需人工处理`); return; }
          write(() => { const current = readJob(job.id); current.hedgeWaitSince = since; current.reason = `对冲腿等待${waiting}：${message.slice(0, 160)}`; saveJob(current); });
          return;
        }
        await escalate(`对冲腿未发送：${error instanceof Error ? error.message.slice(0, 160) : '检查失败'}；首腿敞口保留，需人工处理`); return;
      }
      // Each wait is bounded on its own: an earlier wait that cleared must not shorten the next one.
      if (job.hedgeWaitSince != null) write(() => { const current = readJob(job.id); current.hedgeWaitSince = null; saveJob(current); });
      if (!hedgeChasing) { await send(job, 1, hedgeNow, hedges.length); return; }
      // The chase time of this gap starts before its first post, so a book that cannot be read is bounded by it too.
      if (job.hedgeChaseSince == null) write(() => { const current = readJob(job.id); current.hedgeChaseSince ??= now(); saveJob(current); });
      let price: string, quote: Quote;
      try {
        quote = await readQuote(hedgeLeg.venue, hedgeLeg.symbol);
        checkBook(quote, now(), budgets.sendQuoteMaxAgeMs);
        price = chaseTarget(hedgeLeg, quote);
      } catch (error) {
        if (error instanceof WriterLostError) throw error;
        const reason = `对冲腿等待挂单：${error instanceof Error ? error.message.slice(0, 160) : '盘口读取失败'}`;
        write(() => { const current = readJob(job.id); if (current.reason !== reason) { current.reason = reason; saveJob(current); } });
        return;
      }
      await send(job, 1, hedgeNow, hedges.length, { batch: 0, price, books: [quote] });
      return;
    }
    // Nothing left to hedge for now: the next gap gets its own chase time.
    if (job.hedgeChaseSince != null) write(() => { const current = readJob(job.id); current.hedgeChaseSince = null; saveJob(current); });
    if (resting) {
      // A refused hedge will not be sent again, so the lead must not fill any further.
      if (refused && !withdraw) { holdLead(job.id, `对冲腿被交易所拒绝（${(hedges.at(-1)?.note ?? '').slice(0, 80)}）`); await cancel(readJob(job.id), resting); return; }
      // A local chase follows the book; any other resting lead waits for its fills, the deadline or a stop.
      if (job.legs[0].orderType === 'local-chase' && !withdraw) await reprice(job, resting);
      return;
    }
    const next = upcoming?.order;
    if (next) {
      if (next.batch !== (leads.at(-1)?.batch ?? 0)) {
        // The interval counts from when the previous batch was found done, which survives a restart.
        const doneAt = job.batchDoneAt ?? now();
        if (job.batchDoneAt == null) write(() => { const current = readJob(job.id); current.batchDoneAt = doneAt; saveJob(current); });
        if (now() < doneAt + (job.batchIntervalMs ?? 0)) return;
      }
      let quote: Quote[];
      try { quote = await groupLeadBooks(job); }
      catch (error) {
        if (error instanceof WriterLostError) throw error;
        if (error instanceof ContractError && error.code === 'binding_changed') { write(() => settleJob(readJob(job.id), error.message.slice(0, 120))); return; }
        // The lead's fills are hedged here (but for a local chase's small reserve), so a later send waits for books and accounts until the deadline ends the job.
        const reason = `首腿等待发送：${error instanceof Error ? error.message.slice(0, 160) : '发送前检查失败'}`;
        write(() => { const current = readJob(job.id); if (current.reason !== reason) { current.reason = reason; saveJob(current); } });
        return;
      }
      try { await sendLead(job, quote, next.batch, leads.length, next.quantity); }
      catch (error) {
        if (!(error instanceof ContractError) || error.code !== 'price_moved') throw error;
        write(() => { const current = readJob(job.id); current.reason = `首腿等待发送：${error.message.slice(0, 160)}`; saveJob(current); });
        return;
      }
      // Cleared once the order is out, so a send that waits keeps the interval already served.
      write(() => { const current = readJob(job.id); if (current.batchDoneAt != null || current.reason !== null) { current.batchDoneAt = null; current.reason = null; saveJob(current); } });
      return;
    }
    write(() => settleJob(readJob(job.id), upcoming?.end ?? (job.peerHalt ? `四腿联动停止（${job.peerHalt}），首腿不再发送` : deviation ? `四腿首腿偏离计划（${deviation}），两所都不再发送首腿` : job.leadWithdraw ? '对冲腿一度无法发送，已撤销首腿挂单' : undefined)));
  }

  /**
   * After the shared steps of progress (reconciling, withdrawing, escalation): the one order goes out once, is waited on, and
   * the job settles from what it filled. Nothing is ever sent again, and there is no hedge.
   */
  async function progressRebalance(job: RebalanceJob, stop: boolean): Promise<void> {
    const orders = legOps(job.id, 0);
    if (orders.length === 0) {
      if (stop) { write(() => finish(readJob(job.id), 'stopped', '已停止，未发送任何委托')); return; }
      if (job.holdNewSends) { write(() => finish(readJob(job.id), 'failed', '服务恢复后不再发送新委托')); return; }
      let quote: Quote[];
      try { quote = await guardRebalance(job); }
      catch (error) {
        const reason = error instanceof Error ? error.message.slice(0, 200) : '发送前检查失败';
        const retry = error instanceof ContractError && error.code === 'venue_read_failed' || error instanceof ControlRefusal && error.transient;
        if (retry && now() < job.deadlineAt) { write(() => { const current = readJob(job.id); current.reason = reason; saveJob(current); }); return; }
        write(() => finish(readJob(job.id), 'failed', reason)); return;
      }
      await sendLead(job, quote, 0, 0);
      return;
    }
    if (orders.some(item => !SETTLED.has(item.state))) return;
    write(() => settleJob(readJob(job.id)));
  }

  /** The lead's next order: a market or limit lead sends the batch whole, a local chase posts it at its target price. */
  async function sendLead(job: Job, books: readonly Quote[], batch: number, attempt: number, quantity = (job.batches ?? [job.legs[0].quantity])[0] as string): Promise<void> {
    const lead = job.legs[0];
    await send(job, 0, quantity, attempt, { batch, price: lead.orderType === 'local-chase' ? chaseTarget(lead, books[0]) : null, books });
  }
  /** The job's lead order still resting at the venue (a strategy is handled by its own paths). */
  const restingLeadOrder = (jobId: string): Operation | undefined => legOps(jobId, 0).find(item => item.state === 'open' && !isStrategy(item));
  /** Records why the lead is being withdrawn; the first reason stays. */
  function holdLead(jobId: string, reason: string): void {
    write(() => { const current = readJob(jobId); if (current.leadWithdraw) return; current.leadWithdraw = reason.slice(0, 240); current.reason = `${isPair(current) ? '正在撤销首腿挂单' : '正在撤销调平委托'}：${reason.slice(0, 160)}`; saveJob(current); });
  }
  /** Why the lead was being withdrawn, ahead of a reason that would otherwise hide it. */
  const withdrawnFor = (job: Job): string => job.leadWithdraw ? `${isPair(job) ? '撤首腿挂单' : '撤调平委托'}（${job.leadWithdraw.slice(0, 120)}）时：` : '';
  /** A lead order that neither rested nor filled. */
  const missed = (op: Operation): boolean => isZero(op.filledQuantity) && (op.state === 'rejected' || op.state === 'not-sent' || op.state === 'not-created' || (op.state === 'canceled' && op.venueStatus === 'expired'));
  interface BatchQuantity { batch: number; quantity: string }
  function rememberLeadSkip(job: Job, skipped?: BatchQuantity): boolean {
    if (!skipped || job.leadSkipped?.[skipped.batch] === skipped.quantity) return false;
    job.leadSkipped = { ...job.leadSkipped, [skipped.batch]: skipped.quantity };
    return true;
  }
  /** Decide from settled leads alone. A local remainder skipped by size can coexist with an order for the following batch. */
  function nextLead(job: Job, leads: readonly Operation[]): { order?: BatchQuantity; end?: string; skipped?: BatchQuantity } {
    const lead = job.legs[0], plan = job.batches ?? [lead.quantity], last = leads.at(-1) as Operation, batch = last.batch ?? 0;
    if (leads.length >= budgets.chaseOrderLimit) return { end: `首腿已发送 ${leads.length} 笔委托，达到上限，不再发送` };
    let skipped: BatchQuantity | undefined;
    if (lead.orderType === 'local-chase') {
      let misses = 0;
      for (const item of [...leads].reverse()) { if (!missed(item)) break; misses += 1; }
      if (misses >= budgets.chaseFailureLimit) return { end: `首腿连续 ${misses} 次挂单未成功（${(last.note ?? last.venueStatus ?? last.state).slice(0, 80)}），停止追价` };
      const left = sub(plan[batch] as string, add('0', ...leads.filter(item => (item.batch ?? 0) === batch).map(item => item.filledQuantity)));
      // A remainder the venue would refuse as an opening order (minimum notional at the preview bid, with headroom once the batch
      // has partly filled; a whole batch passed the preview's own check) ends the batch.
      const margin = cmp(left, plan[batch] as string) < 0 ? MIN_NOTIONAL_MARGIN : '1';
      const refusable = job.action === 'open' && cmp(mul(exposure(left, lead.instrument), lead.quote.bid), mul(lead.instrument.minNotional, margin)) < 0;
      if (cmp(left, lead.instrument.minQuantity) >= 0 && !refusable) return { order: { batch, quantity: left } };
      if (cmp(left, '0') > 0) skipped = { batch, quantity: left };
    } else if (last.state === 'rejected' || last.state === 'not-sent' || last.state === 'not-created') {
      // A whole batch refused or never sent would be refused again; an IOC that found no price within the bound is not.
      return isZero(last.filledQuantity) && leads.length > 1 ? { end: `第 ${batch + 1} 批首腿未发出（${(last.note ?? last.state).slice(0, 80)}），不再发送后续批次` } : {};
    }
    return { skipped, order: batch + 1 < plan.length ? { batch: batch + 1, quantity: plan[batch + 1] as string } : undefined };
  }
  /** Moves a local chase order that has rested chaseRepriceMs once its target price moved; a book that cannot be read leaves it. */
  async function reprice(job: Job, op: Operation): Promise<void> {
    if (op.sentAt === null || now() - op.sentAt < budgets.chaseRepriceMs) return;
    const leg = job.legs[0], posted = (op.request as OrderRequest).limitPrice as string;
    let target: string;
    try {
      const quote = await readQuote(leg.venue, leg.symbol);
      checkBook(quote, now(), budgets.sendQuoteMaxAgeMs);
      target = chaseTarget(leg, quote);
    } catch (error) {
      if (error instanceof WriterLostError) throw error;
      return;
    }
    if (cmp(target, posted) !== 0) await cancel(job, op, `追价改价 ${posted} → ${target}`);
  }

  /**
   * A chasing hedge order that rested chaseRepriceMs is withdrawn once its target price moved or the lead's fills changed
   * what it should hedge; the next pass posts the gap afresh. A book that cannot be read leaves it.
   */
  async function repriceHedge(job: PairJob, op: Operation, wanted: string): Promise<void> {
    if (op.sentAt === null || now() - op.sentAt < budgets.chaseRepriceMs) return;
    const leg = job.legs[1], request = op.request as OrderRequest, posted = request.limitPrice as string, left = sub(request.quantity, op.filledQuantity);
    // An opening post partly filled down to less than the venue's minimum notional could not be posted again: it rests where it is
    // until it fills or its chase time is up (docs/oil.md 13.3); only more to hedge (the lead filled again) replaces it.
    const tooSmall = job.action === 'open' && cmp(mul(exposure(left, leg.instrument), leg.quote.bid), leg.instrument.minNotional) < 0;
    if (tooSmall && cmp(wanted, left) <= 0) return;
    let price: string;
    try {
      const quote = await readQuote(leg.venue, leg.symbol);
      checkBook(quote, now(), budgets.sendQuoteMaxAgeMs);
      price = chaseTarget(leg, quote);
    } catch (error) {
      if (error instanceof WriterLostError) throw error;
      return;
    }
    if (cmp(price, posted) !== 0) await cancel(job, op, `对冲追价改价 ${posted} → ${price}`);
    else if (cmp(wanted, left) !== 0) await cancel(job, op, `对冲追价改量 ${left} → ${wanted}`);
  }
  /**
   * Whether a chasing hedge must give up posting and send the rest to market: its gap chased past chaseTimeoutMs, its last
   * chaseFailureLimit posts neither rested nor filled (refused, not sent, not delivered or expired by the venue), or its orders
   * reached the job's order limit less the market hedges' attempts.
   */
  function hedgeChaseOver(job: PairJob, hedges: readonly Operation[]): boolean {
    let misses = 0;
    for (const item of [...hedges].reverse()) { if (!isPostedHedge(item) || !missed(item)) break; misses += 1; }
    // The job's order limit keeps room for the market orders that hedge the rest.
    // A limit configured at or below the market attempts leaves no room to post: the hedge goes straight to market.
    return hedgeChaseTimedOut(job, now()) || misses >= budgets.chaseFailureLimit || hedges.length >= budgets.chaseOrderLimit - budgets.hedgeAttempts;
  }
  function hedgeChaseTimedOut(job: PairJob, at: number): boolean {
    return job.hedgeChaseSince != null && at >= job.hedgeChaseSince + (job.legs[1].chaseTimeoutMs ?? HEDGE_CHASE_TIMEOUT_MS);
  }

  /**
   * Orders are cancelled only when withdrawing. A strategy is stopped then too, and also when the venue paused it, since a
   * paused strategy neither fills nor ends; one already ended is only read again until its children settle.
   */
  function wantsStop(op: Operation, withdraw: boolean): boolean {
    if (!isStrategy(op)) return withdraw;
    return op.remoteId !== null && op.identityVerifiedAt != null && op.identityMismatchAt == null && op.strategyStatus !== 'terminal' && (withdraw || op.strategyStatus === 'paused');
  }
  /** A strategy create without an answer goes to a person at once: waiting cannot make it any more knowable. */
  function holdOrphan(jobId: string): boolean {
    const orphan = opsOf(jobId).find(isOrphanStrategy);
    if (!orphan) return false;
    write(() => {
      const current = readJob(jobId);
      if (!FINAL_JOB.has(current.status)) finish(current, 'attention', orphanReason(orphan));
    });
    return true;
  }
  const orphanReason = (orphan: Operation): string => `${VENUE_NAMES[orphan.venue]} 追价策略创建结果未知（交易所无客户编号，无法自动核对；${(orphan.note ?? '无回报').slice(0, 100)}），不再发送；需人工填写策略编号认领、在观察窗后确认未创建，或强制释放`;

  const marketOfJob = (job: Pick<Job, 'legs'>): Market => marketOfSymbol(job.legs[0].symbol);
  /** Hedge the lead's actual fill in the planned proportion, floored to the hedge venue's step. */
  function hedgeQuantityFor(job: PairJob, leadFilled: string): string {
    const [lead, hedge] = job.legs;
    return proportionalHedge(hedge.quantity, lead.quantity, leadFilled, hedge.instrument.quantityStep);
  }

  /** note: why the lead stopped early, when it did. */
  function settleJob(job: Job, note?: string): void {
    if (FINAL_JOB.has(job.status)) return;
    if (!isPair(job)) { settleRebalance(job); return; }
    const ops = opsOf(job.id), filled = (index: 0 | 1) => add('0', ...ops.filter(item => item.leg === index).map(item => item.filledQuantity));
    const leadExposure = exposure(filled(0), job.legs[0].instrument), hedgeExposure = exposure(filled(1), job.legs[1].instrument);
    const leadsOf = ops.filter(item => item.leg === 0), lead = [...leadsOf].sort((a, b) => attemptOf(a) - attemptOf(b)).at(-1);
    const refused = ops.filter(item => item.leg === 1).sort((a, b) => attemptOf(a) - attemptOf(b)).at(-1);
    if (isZero(leadExposure) && isZero(hedgeExposure)) {
      // A protected market lead is an IOC at its bound: every lead order expiring unfilled says the book was past it.
      const expired = job.legs[0].orderType === 'market' && leadsOf.length > 0 && leadsOf.every(item => item.state === 'canceled' && isZero(item.filledQuantity));
      const stopped = stopRequested(job.id) || !!job.peerHalt;
      finish(job, stopped ? 'stopped' : 'failed', `首腿未成交（${note ?? lead?.state ?? '未发送'}），未发送对冲腿`, expired && !stopped ? 'lead_unfilled' : undefined);
      return;
    }
    if (marketOfJob(job) === 'hynix') {
      // Hynix legs hedge in the planned proportion: done when the hedge filled exactly what the lead's fill asks for.
      const target = hedgeQuantityFor(job, filled(0)), missing = sub(target, filled(1));
      if (isZero(missing)) {
        const short = cmp(filled(0), job.legs[0].quantity) < 0 ? `首腿成交 ${filled(0)}，计划 ${job.legs[0].quantity}；对冲腿按比例成交 ${filled(1)}` : null;
        finish(job, 'completed', [note, short].filter(Boolean).join('；') || null);
        return;
      }
      const why = refused?.state === 'rejected' && !isPostedHedge(refused) ? `对冲腿被交易所拒绝（${(refused.note ?? '').slice(0, 80)}），不再补发；` : stopRequested(job.id) ? '已请求停止，不再补发对冲腿；' : '';
      finish(job, 'attention', `${why}两腿成交不平衡：${legLabel(job.legs, 0)} ${filled(0)}，${legLabel(job.legs, 1)} ${filled(1)}，按计划比例对冲腿应为 ${target}，相差 ${missing}；敞口保留，需人工处理`);
      return;
    }
    const gap = sub(leadExposure, hedgeExposure);
    if (isZero(gap)) {
      // Level but short of the plan (an IOC partly filled, a chase or batches cut off): say how far it got.
      const planned = exposure(job.legs[0].quantity, job.legs[0].instrument);
      const short = cmp(leadExposure, planned) < 0 ? `两腿各成交 ${leadExposure} 桶，计划 ${planned} 桶` : null;
      finish(job, 'completed', [note, short].filter(Boolean).join('；') || null);
      return;
    }
    const why = refused?.state === 'rejected' && !isPostedHedge(refused) ? `对冲腿被交易所拒绝（${(refused.note ?? '').slice(0, 80)}），不再补发；` : stopRequested(job.id) ? '已请求停止，不再补发对冲腿；' : '';
    finish(job, 'attention', `${why}两腿成交不平衡：${legLabel(job.legs, 0)} ${filled(0)}，${legLabel(job.legs, 1)} ${filled(1)}，未对冲 ${gap} 桶；敞口保留，需人工处理`);
  }

  /** A partial fill still levels part of the gap and leaves no new exposure, so it completes; nothing is sent for the rest. */
  function settleRebalance(job: RebalanceJob): void {
    const ops = legOps(job.id, 0), leg = job.legs[0], filled = add('0', ...ops.map(item => item.filledQuantity)), last = ops.at(-1);
    if (isZero(filled)) {
      const why = !last ? '未发送' : last.state === 'canceled' ? '价格保护界限内没有成交，已由交易所撤销' : last.state === 'rejected' ? '交易所拒绝' : last.state === 'not-created' ? '未送达交易所' : last.state === 'not-sent' ? '未发送' : last.state;
      finish(job, stopRequested(job.id) ? 'stopped' : 'failed', `调平委托未成交（${why}${last?.note ? `：${last.note.slice(0, 120)}` : ''}）`);
      return;
    }
    if (cmp(filled, leg.quantity) === 0) { finish(job, 'completed', null); return; }
    finish(job, 'completed', `调平委托成交 ${filled}，计划 ${leg.quantity}；未成交部分已由交易所撤销，可重新预览再调平`);
  }

  // ---- retention ---------------------------------------------------------------
  // Only history of jobs that are over, have every order settled and need no one's attention is removed;
  // an unknown order or an unacknowledged exposure keeps its evidence (plan 6.1).
  const DONE_JOB = `SELECT id FROM jobs j WHERE j.final = 1 AND j.updated_at < ?
    AND NOT (j.status = 'attention' AND json_extract(j.json, '$.acknowledgedAt') IS NULL)
    AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.job_id = j.id AND o.settled = 0)`;
  let prunedAt = 0;
  /** Deletes at most pruneBatch rows per table in one short transaction; returns what it removed. */
  function prune(): { events: number; commands: number; previews: number; transfers: number; adl: number } {
    const cutoff = now() - budgets.historyRetentionMs, limit = budgets.pruneBatch;
    return write(() => {
      const events = Number(db.prepare(`DELETE FROM events WHERE seq IN (SELECT seq FROM events WHERE at < ? AND (job_id IS NULL OR job_id IN (${DONE_JOB})) ORDER BY seq LIMIT ?)`).run(cutoff, cutoff, limit).changes);
      // Pair switches name a pair, not a job; past the retention period their request ids need no replay protection.
      const commands = Number(db.prepare(`DELETE FROM commands WHERE request_id IN (SELECT request_id FROM commands WHERE accepted_at < ? AND (kind IN ('transfer-enable', 'transfer-config', 'adl-config', 'adl-restart') OR job_id IN (${DONE_JOB})) LIMIT ?)`).run(cutoff, cutoff, limit).changes);
      const previews = Number(db.prepare(`DELETE FROM previews WHERE id IN (SELECT id FROM previews WHERE expires_at < ? AND (consumed_job IS NULL OR consumed_job IN (${DONE_JOB})) LIMIT ?)`).run(cutoff, cutoff, limit).changes);
      // A settled transfer is only history: used receipts, cooldown and pacing live on the pair, which is kept.
      const transfers = Number(db.prepare('DELETE FROM transfers WHERE id IN (SELECT id FROM transfers WHERE settled = 1 AND created_at < ? ORDER BY created_at LIMIT ?)').run(cutoff, limit).changes);
      // ADL history: settled batches of closed incidents, then the closed incidents left without batches, then handled evidence.
      // Settings and scan progress live on adl_pairs, which is kept; recent fills (24 h) are far inside the retention period.
      const adlBatches = Number(db.prepare(`DELETE FROM adl_batches WHERE id IN (SELECT b.id FROM adl_batches b JOIN adl_incidents i ON i.id = b.incident_id
        WHERE b.settled = 1 AND i.final = 1 AND b.created_at < ? ORDER BY b.created_at LIMIT ?)`).run(cutoff, limit).changes);
      const adlIncidents = Number(db.prepare(`DELETE FROM adl_incidents WHERE id IN (SELECT i.id FROM adl_incidents i WHERE i.final = 1 AND i.created_at < ?
        AND NOT EXISTS (SELECT 1 FROM adl_batches b WHERE b.incident_id = i.id) ORDER BY i.created_at LIMIT ?)`).run(cutoff, limit).changes);
      const adlEvidence = Number(db.prepare('DELETE FROM adl_evidence WHERE key IN (SELECT key FROM adl_evidence WHERE pending = 0 AND updated_at < ? ORDER BY updated_at LIMIT ?)').run(cutoff, limit).changes);
      const adl = adlBatches + adlIncidents + adlEvidence;
      if (events + commands + previews + transfers + adl) event(null, 'history-pruned', { events, commands, previews, transfers, adl, before: cutoff });
      return { events, commands, previews, transfers, adl };
    });
  }

  // ---- loop --------------------------------------------------------------------
  /**
   * Resolves this module's open shared operations from local facts, after a crash or a failed finish.
   * Nothing is resolved while its write may still be in flight or the local evidence is missing.
   */
  function settleControl(): void {
    if (!control) return;
    try { if (!control.anyPending()) return; } catch (error) { if (error instanceof WriterLostError) throw error; return; }
    for (const row of db.prepare('SELECT * FROM accounts WHERE environment = ?').all(environment) as unknown as AccountRow[]) {
      const binding = bindingOf(row);
      let pending: string[];
      try { pending = control.pending(binding); } catch (error) { if (error instanceof WriterLostError) throw error; continue; }
      for (const operationId of pending) {
        // One entry that cannot be judged (a venue without a connector, say) must not stop the rest or the pass.
        let outcome: ReturnType<typeof controlOutcome>;
        try { outcome = controlOutcome(operationId); } catch (error) { if (error instanceof WriterLostError) throw error; continue; }
        if (!outcome) continue;
        try { control.resolve(binding, operationId, outcome); event(jobOfOperation(operationId), 'control-resolved', { operationId, outcome }); }
        catch (error) { if (error instanceof WriterLostError) throw error; }
      }
    }
  }
  /** The job owning a registry entry, so its resolution shows in that job's history. */
  function jobOfOperation(operationId: string): string | null {
    const parsed = parseOperationId(operationId);
    const row = parsed && db.prepare('SELECT job_id FROM operations WHERE client_order_id = ?').get(parsed.clientOrderId) as { job_id: string } | undefined;
    return row?.job_id ?? null;
  }
  function controlOutcome(operationId: string): 'confirmed' | 'rejected' | null {
    const parsed = parseOperationId(operationId);
    const row = parsed && db.prepare('SELECT json FROM operations WHERE client_order_id = ?').get(parsed.clientOrderId) as { json: string } | undefined;
    if (!parsed || !row) return null;
    const op = JSON.parse(row.json) as Operation;
    if (inFlight.has(op.id) || cancelling.has(op.id)) return null;
    // Only adoption, a person's confirmation of not-created or a release settles such a create; acknowledgement is refused until then.
    // A create whose answered id was disowned later was already settled as confirmed when that id was kept, which stays.
    if (isOrphanStrategy(op)) return null;
    const proven = provenOutcome(parsed, op);
    if (proven) return proven;
    // A person who acknowledged the job owns its exposure; its writes are released as possibly executed (plan 6.1).
    const job = readJob(op.jobId);
    return job.status === 'attention' && job.acknowledgedAt != null ? 'confirmed' : null;
  }
  function provenOutcome(parsed: NonNullable<ReturnType<typeof parseOperationId>>, op: Operation): 'confirmed' | 'rejected' | null {
    if (parsed.kind === 'create') {
      // A person released it as possibly executed.
      if (op.releasedAt != null) return 'confirmed';
      // prepared never reached transport: the sending mark commits before any send.
      if (op.state === 'prepared' || op.state === 'not-sent' || op.state === 'rejected' || op.state === 'not-created') return 'rejected';
      return op.state === 'open' || op.state === 'filled' || op.state === 'canceled' ? 'confirmed' : null;
    }
    if (parsed.seq > (op.cancelSeq ?? 0)) return 'rejected';
    // Once the order is over, a cancel of it can no longer change anything; an ended strategy is over even while its children settle.
    if (SETTLED.has(op.state) || (isStrategy(op) && op.strategyStatus === 'terminal')) return 'confirmed';
    // Past the window in which the venue could still accept the signed cancel, an order seen resting afterwards proves it did nothing (L091).
    return op.state === 'open' && op.cancelRequestedAt !== null && op.openCheckedFrom != null && op.openCheckedFrom >= cancelSettledAt(op) ? 'rejected' : null;
  }

  /** History pruning at most once per pruneIntervalMs; runs from the jobs pass or, without it, its own loop. */
  function maintain(): void {
    if (now() - prunedAt < budgets.pruneIntervalMs) return;
    prunedAt = now();
    try { prune(); } catch (error) { if (error instanceof WriterLostError) throw error; }
  }

  /** Two-leg jobs: reconcile, hedge, cancel and release registry entries. Transfers and ADL run in passes of their own. */

  async function runJobs(): Promise<void> {
    if (!acquire()) return;
    settleControl();
    maintain();
    for (const job of unfinishedJobs()) {
      try { await progress(job); }
      catch (error) {
        if (error instanceof WriterLostError) throw error;
        write(() => { const current = readJob(job.id); current.reason = `本轮处理失败：${error instanceof Error ? error.message.slice(0, 160) : '未知'}`; saveJob(current); });
      }
    }
    // A disputed order stays frozen. Other, freshly verified orders can still be withdrawn before manual takeover.
    const pending = unsettledOps();
    const disputedJobs = new Set(pending.filter(op => op.identityMismatchAt != null).map(op => op.jobId));
    for (const op of pending) {
      const job = readJob(op.jobId);
      if (job.status !== 'attention') continue;
      try {
        recoverIdle(op);
        const current = readOp(op.id);
        const verifyWithdrawal = !!job.fourLegQuantityIssue || disputedJobs.has(job.id);
        if (verifyWithdrawal && (current.identityMismatchAt != null || !originalOrder(job, current))) continue;
        const verifiedOpen = (current.state === 'unknown' || current.state === 'open') && await reconcile(job, current);
        const latest = readOp(op.id);
        // Read again: a person may have acknowledged the job while the reconcile above was waiting on the venue.
        const shouldWithdraw = verifyWithdrawal ? verifiedOpen === true : latest.adoptedAt != null;
        if (shouldWithdraw && readJob(op.jobId).acknowledgedAt == null && latest.state === 'open' && wantsStop(latest, true) && cancelDue(latest)
          && (latest.manualStopAt == null || now() - latest.manualStopAt >= budgets.cancelRetryMs)) {
          if ((latest.manualStops ?? 0) >= budgets.cancelAttempts) {
            const note = verifyWithdrawal ? `原委托已尝试撤销 ${latest.manualStops} 次，需人工核对` : strategyNote(latest);
            if (latest.note !== note) write(() => { const current = readOp(op.id); current.note = note; saveOp(current); });
          } else {
            write(() => { const current = readOp(op.id); current.manualStops = (current.manualStops ?? 0) + 1; current.manualStopAt = now(); saveOp(current); });
            await cancel(job, readOp(op.id));
          }
        }
      } catch (error) { if (error instanceof WriterLostError) throw error; }
    }
    // Again at the end, so a result reconciled in this pass releases its account before the next one.
    settleControl();
  }
  /**
   * Margin transfers. A slow venue holds up only this pass: it is scheduled apart from the jobs and from ADL,
   * which share nothing with it but the lease and append-only event rows.
   */
  async function runTransfers(): Promise<void> {
    if (!acquire()) return;
    try { await transfers.tick(); }
    catch (error) {
      if (error instanceof WriterLostError) throw error;
      const reason = error instanceof Error ? error.message.slice(0, 160) : '未知';
      const at = now();
      if (!transferTickFailure || transferTickFailure.reason !== reason || at - transferTickFailure.at >= 60_000) {
        try { write(() => event(null, 'transfer-tick-failed', { reason })); transferTickFailure = { reason, at }; }
        catch (inner) { if (inner instanceof WriterLostError) throw inner; }
      }
    }
  }
  /** ADL incidents, on their own schedule so neither a slow transfer nor a slow job delays the emergency reduction. */
  async function runAdl(): Promise<void> {
    if (!acquire()) return;
    try { await adl.tick(); }
    catch (error) {
      if (error instanceof WriterLostError) throw error;
      const reason = error instanceof Error ? error.message.slice(0, 160) : '未知';
      const at = now();
      if (!adlTickFailure || adlTickFailure.reason !== reason || at - adlTickFailure.at >= 60_000) {
        try { write(() => event(null, 'adl-tick-failed', { reason })); adlTickFailure = { reason, at }; }
        catch (inner) { if (inner instanceof WriterLostError) throw inner; }
      }
    }
  }
  const tickJobs = (): Promise<void> => singleFlight('jobs', runJobs);
  const tickTransfers = (): Promise<void> => singleFlight('transfers', runTransfers);
  const tickAdl = (): Promise<void> => singleFlight('adl', runAdl);
  /** One pass of each loop in turn, as tests and the measurement script drive it; the entry schedules the three apart. */
  function tick(): Promise<void> {
    return singleFlight('all', async () => { await tickJobs(); await tickTransfers(); await tickAdl(); });
  }

  function jobView(id: string) {
    const job = readJob(id), ops = opsOf(id);
    const events = (db.prepare('SELECT type, at, json FROM events WHERE job_id = ? ORDER BY seq DESC LIMIT 40').all(id) as { type: string; at: number; json: string }[]).reverse().map(row => ({ type: row.type, at: row.at, ...JSON.parse(row.json) }));
    const groupLegs = isPair(job) && job.group ? fillLegs(job, ops) : null;
    return {
      id: job.id, endCode: job.endCode ?? null, market: marketOfJob(job), preset: !isPair(job) ? 'rebalance' as const : job.legs[0].venue === job.legs[1].venue ? 'same-exchange' as const : 'cross-exchange' as const,
      rebalance: job.rebalance ? { method: job.rebalance.method } : null, group: job.group ?? null, peerHalt: job.peerHalt ?? null, leadSkipped: job.leadSkipped ? groupLegs?.[0].skipped ?? skippedOf(job) : null, leadDeviation: job.leadDeviation ?? null, action: job.action, status: job.status, reason: job.reason, stopRequested: stopRequested(id), createdAt: job.createdAt, deadlineAt: job.deadlineAt, holdNewSends: job.holdNewSends,
      locked: !!db.prepare('SELECT 1 FROM locks WHERE job_id = ? LIMIT 1').get(id), acknowledgedAt: job.acknowledgedAt,
      /** A strategy create without an answer waits for adoption, a confirmation of not-created or a release. */
      strategyPending: ops.some(isOrphanStrategy),
      /** current: the batch of the latest lead order (0 before the first), 1-based. */
      batches: job.batches ? { count: job.batches.length, current: ops.some(item => item.leg === 0) ? Math.max(...ops.filter(item => item.leg === 0).map(item => item.batch ?? 0)) + 1 : 0, intervalMs: job.batchIntervalMs ?? 0 } : null,
      legs: job.legs.map(leg => {
        const mine = ops.filter(item => item.leg === leg.index).sort((a, b) => attemptOf(a) - attemptOf(b)), op = mine.at(-1), groupLeg = groupLegs?.[leg.index];
        const filledQuantity = groupLeg?.filled ?? add('0', ...mine.map(item => item.filledQuantity));
        const averagePrice = filledQuantity === '无效' ? null : groupLeg && FINAL_JOB.has(job.status) ? historicalDecimal(() => averageOf(mine), null) : averageOf(mine);
        return { venue: leg.venue, symbol: leg.symbol, side: leg.side, orderSide: leg.orderSide, orderType: leg.orderType, plannedQuantity: groupLeg?.planned ?? leg.quantity, accountId: maskId(leg.accountId), priceBound: leg.priceBound ?? null, limitPrice: leg.limitPrice ?? null,
          contractSize: leg.instrument?.contractSize ?? '无效', quantityStep: leg.instrument?.quantityStep ?? '0', skippedQuantity: groupLeg?.skipped ?? '0', plannedBarrels: groupLeg?.plannedBarrels ?? exposure(leg.quantity, leg.instrument), filledBarrels: groupLeg?.filledBarrels ?? exposure(filledQuantity, leg.instrument), averagePrice,
          previewQuote: { bid: leg.quote.bid, ask: leg.quote.ask },
          attempts: mine.length, filledQuantity,
          operation: op ? { kind: op.kind ?? 'order', clientOrderId: op.clientOrderId, state: op.state, quantity: op.request?.quantity ?? '无效', limitPrice: (op.request as { limitPrice?: string | null })?.limitPrice ?? null, filledQuantity: op.filledQuantity, averagePrice: op.averagePrice, remoteId: op.remoteId,
            venueStatus: op.venueStatus ?? null, verifiedWorking: op.verifiedWorking === true && op.identityMismatchAt == null, strategyStatus: op.identityVerifiedAt != null && op.identityMismatchAt == null ? op.strategyStatus ?? null : null,
            childrenSettled: op.childrenSettled ?? null, adoptedAt: op.adoptedAt ?? null, releasedAt: op.releasedAt ?? null, ackStrategyId: op.ackStrategyId ?? null, note: op.note } : null };
      }),
      events,
    };
  }

  return {
    owner,
    get generation() { return generation; },
    get retired() { return retired; },
    budgets,
    acquire,
    prune,
    maintain,
    registerAccount,
    preview,
    publicPreview,
    confirm,
    previewFourLeg,
    publicFourLegPreview,
    confirmFourLeg,
    confirmedJob,
    requestStop,
    acknowledge,
    adoptStrategy,
    confirmNotCreated,
    releaseStrategy,
    observe,
    tick,
    tickJobs,
    tickTransfers,
    tickAdl,
    jobView,
    registerTransferPair: transfers.registerPair,
    setTransferEnabled: transfers.setEnabled,
    setTransferConfig: transfers.setConfig,
    transferPairs: transfers.pairs,
    /** Each readable pair's switch and stored settings only, without the balances, open transfer or blocks of a pair view. */
    transferPairSettings: (): { id: string; enabled: boolean; config: TransferConfig }[] => transfers.records().map(pair => ({ id: pair.id, enabled: pair.enabled, config: pair.config })),
    /** Unmasked accounts of the pairs that may still write: enabled, or with an ADL incident not yet finished. */
    writableAccounts: (): string[] => [...new Set(transfers.records().filter(pair => pair.enabled || adl.busy(pair.id) !== null).flatMap(pair => [pair.mainAccountId, pair.long, pair.short]))],
    corruptTransferPairs: transfers.corruptPairs,
    recentTransfers: transfers.recent,
    transferHistory: transfers.history,
    adlPairs: adl.pairs,
    adlIncident: adl.incident,
    recentAdlIncidents: adl.recent,
    adlHistory: adl.history,
    setAdlConfig: adl.setConfig,
    restartAdl: adl.restart,
    /** One read round of every paired ASTER account; never part of tick(), so a slow read cannot hold up the jobs, transfers or ADL. */
    refreshPositions: positions.refresh,
    asterPositions: positions.view,
    unfinished: () => unfinishedJobs().map(job => job.id),
    /** null when no caps are configured. */
    environment,
    notionalLimits: notionalView,
    /** The latest jobs, of one market when it is named (a job's market is its first leg's contract). */
    recentJobs: (limit = 20, market?: Market) => {
      const count = Math.min(Math.max(1, Math.trunc(limit)), 100);
      const rows = market
        ? db.prepare(`SELECT id FROM jobs WHERE json_extract(json, '$.legs[0].symbol') IN (${MARKET_SYMBOLS[market].map(() => '?').join(', ')}) ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...MARKET_SYMBOLS[market], count)
        : db.prepare('SELECT id FROM jobs ORDER BY created_at DESC, rowid DESC LIMIT ?').all(count);
      // A four-leg job whose other job fell outside the limit brings it along, so the page always shows the group whole.
      const views = (rows as { id: string }[]).map(row => jobView(row.id));
      // A row that is gone is skipped: the page then shows the group as "另一所未列出" rather than no list at all.
      for (const view of [...views]) {
        if (!view.group || views.some(item => item.id === view.group!.peer)) continue;
        try { views.push(jobView(view.group.peer)); } catch (error) { if (!(error instanceof ContractError)) throw error; }
      }
      return views;
    },
    /** Principal ids are masked: the page needs to tell accounts apart, not to see who they are. */
    accounts: () => (db.prepare('SELECT * FROM accounts WHERE environment = ? ORDER BY venue').all(environment) as unknown as AccountRow[])
      .map(row => ({ venue: row.venue, accountMode: row.account_mode, credentialVersion: row.credential_version, accountId: maskId(row.account_id) })),
    /**
     * Stops writing and hands the lease back so a clean restart need not wait for expiry.
     * A write still in flight then fails the fence; its operation stays sending and the next writer recovers it as unknown.
     */
    /** Starts a drain: transfers and ADL send nothing new (not-sent), while results of sends already out are still written. */
    stopSending(): void { draining = true; },
    close() {
      if (closed) return;
      closed = true;
      adl.close();
      positions.close();
      if (held && !retired) {
        store.tx(() => db.prepare('UPDATE writer SET expires_at = ? WHERE id = 1 AND owner = ? AND generation = ?').run(now(), owner, generation));
        retired = true;
      }
    },
  };
}
export type Executor = ReturnType<typeof createExecutor>;
