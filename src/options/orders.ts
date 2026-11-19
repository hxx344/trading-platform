// One option order that follows the book, and its reconciliation by order link id (never by account position). Ported
// from the workbench's OrderExecutor (orders.py, commit 160e932): a GTC limit at bid 1 for a buy and ask 1 for a sell,
// rounded half up to the tick, amended whenever that price moves, looked at every poll; at the deadline, on a stop or on
// any error the order is cancelled and read back up to five times. The engine separately verifies any absence before
// settling a lost create. iocOrder is the optional bounded fallback for an opening leg's remainder.
import { VenueError } from '../connector.ts';
import { cmp, decimal, fromUnits, units } from '../decimal.ts';
import { describe } from '../live/values.ts';
import type { OptionsClient, Row } from './client.ts';
import type { Side } from './strategy.ts';

export type OrderStatus = 'unknown' | 'filled' | 'partial' | 'timeout_cancelled' | 'not_submitted';
export interface OrderOutcome { orderId: string; status: OrderStatus; terminal: boolean; filledQty: string; message?: string; price?: string }
export interface OrderSpec { symbol: string; side: Side; qty: string; link: string; reduceOnly: boolean; tick: string }

const TERMINAL = new Set(['Filled', 'Cancelled', 'Rejected', 'PartiallyFilledCanceled', 'Deactivated']);
/** Each venue call gets this long in all (an order read is two requests). */
const CALL_MS = 25_000;
export const RECONCILE_CHECKS = 5;
export const RECONCILE_INTERVAL_MS = 1_000;

/** Half up to the tick; null for a price that is missing, not positive or rounds to zero. */
export function roundToTick(value: unknown, tick: string): string | null {
  let price: bigint;
  try { price = units(decimal(typeof value === 'number' ? String(value) : value, 'positive')); } catch { return null; }
  const unit = units(tick);
  if (unit <= 0n) return null;
  const steps = (price * 2n + unit) / (2n * unit);
  return steps > 0n ? fromUnits(steps * unit) : null;
}

/** Down (a buy's IOC at ask 1) or up (a sell's at bid 1) to the tick, never past the book; null as roundToTick. */
export function toTick(value: unknown, tick: string, direction: 'down' | 'up'): string | null {
  let price: bigint;
  try { price = units(decimal(typeof value === 'number' ? String(value) : value, 'positive')); } catch { return null; }
  const unit = units(tick);
  if (unit <= 0n) return null;
  const steps = direction === 'down' ? price / unit : (price + unit - 1n) / unit;
  return steps > 0n ? fromUnits(steps * unit) : null;
}

/** The order read back, checked against what was sent; null (not found) keeps the previous outcome. */
export function snapshot(order: Row | null, qty: string, side: Side, previous: OrderOutcome): OrderOutcome {
  if (order === null) return previous;
  let filled: string, requested: string;
  try { filled = decimal(order.cumExecQty, 'nonnegative'); requested = decimal(order.qty, 'positive'); }
  catch { throw new Error('订单核对返回的数量无效'); }
  if ((previous.orderId && previous.orderId !== order.orderId) || order.side !== side || cmp(requested, qty) !== 0 || cmp(filled, previous.filledQty) < 0 || cmp(filled, qty) > 0) throw new Error('订单核对返回的编号、数量或方向与下单不一致');
  const terminal = TERMINAL.has(String(order.orderStatus));
  const full = cmp(filled, qty) === 0;
  if (order.orderStatus === 'Filled' && !full) throw new Error('已成交订单的累计成交数量不完整');
  const status: OrderStatus = terminal ? (full ? 'filled' : cmp(filled, '0') > 0 ? 'partial' : 'timeout_cancelled') : 'unknown';
  return { ...previous, orderId: typeof order.orderId === 'string' && order.orderId ? order.orderId : previous.orderId, status, terminal, filledQty: filled };
}

export interface ReconcileHooks {
  record(outcome: OrderOutcome): void;
  /** Durable positive evidence. An empty id still identifies a row by our link. */
  seen?(orderId: string): void;
  /** Recovery can wait for this order's pending fill read before committing a terminal receipt. */
  confirmTerminal?(outcome: OrderOutcome): Promise<void>;
  /** Called only after every order lookup completed empty. Verifies executions and commits the final decision. */
  settleMissing?(): Promise<OrderOutcome | null>;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
}

function receiptId(answer: Row, link: string): string {
  if (answer.orderLinkId !== undefined && answer.orderLinkId !== link) throw new Error('Bybit 委托回执关联号不一致');
  return typeof answer.orderId === 'string' && answer.orderId.trim() ? answer.orderId : '';
}

/** Cancels (optionally), then reads the order back up to RECONCILE_CHECKS times. A cancel receipt proves existence only. */
export async function reconcileOrder(client: OptionsClient, spec: Pick<OrderSpec, 'symbol' | 'side' | 'qty' | 'link'>, previous: OrderOutcome, cancel: boolean, hooks: ReconcileHooks): Promise<OrderOutcome> {
  let outcome: OrderOutcome = { ...previous, status: 'unknown', terminal: false };
  let missing = previous.orderId === '' && cmp(previous.filledQty, '0') === 0;
  const seen = (id: string) => {
    missing = false;
    hooks.seen?.(id);
    if (id && outcome.orderId && id !== outcome.orderId) throw new Error('同一关联号返回了不同的交易所订单号');
    if (id) outcome = { ...outcome, orderId: id };
  };
  if (cancel) {
    try {
      const answer = await client.cancel(spec.symbol, spec.link, AbortSignal.timeout(CALL_MS));
      missing = false;
      const id = receiptId(answer, spec.link);
      if (id || answer.orderLinkId === spec.link) seen(id);
    }
    catch (error) { hooks.log(`期权订单 ${spec.link} 撤单未确认：${describe(error)}`); }
  }
  for (let attempt = 0; attempt < RECONCILE_CHECKS; attempt++) {
    try {
      const order = await client.order(spec.symbol, spec.link, AbortSignal.timeout(CALL_MS), seen, hooks.settleMissing !== undefined);
      if (order !== null) {
        missing = false;
        const next = snapshot(order, spec.qty, spec.side, outcome);
        if (next.terminal && hooks.confirmTerminal) await hooks.confirmTerminal(next);
        else hooks.record(next);
        outcome = next;
        if (outcome.terminal) return outcome;
      }
    } catch (error) { missing = false; hooks.log(`期权订单 ${spec.link} 核对失败：${describe(error)}`); }
    if (attempt + 1 < RECONCILE_CHECKS) await hooks.sleep(RECONCILE_INTERVAL_MS);
  }
  if (missing && hooks.settleMissing) {
    try { const settled = await hooks.settleMissing(); if (settled) return settled; }
    catch (error) { hooks.log(`期权订单 ${spec.link} 未能确认无成交：${describe(error)}`); }
  }
  hooks.log(`期权订单 ${spec.link} 状态仍未知，已禁止自动重试`);
  return { ...outcome, message: '订单状态未知，已禁止自动重试' };
}

export interface FollowHooks extends ReconcileHooks {
  transmitted?(): void;
  now(): number;
  deadline: number;
  pollMs: number;
  /** Throws when a stop was asked for; the order is then cancelled and reconciled. */
  checkStop(): void;
  /** Reserves the price against the task's limits (null: only re-checks them); a throw stops this order. */
  checkPrice(price: number | null): void;
  /** Waits one poll, ended early by a stop. */
  pause(ms: number): Promise<void>;
}

function atTransmission(client: OptionsClient, ticker: Row | null, price: string, hooks: FollowHooks | IocHooks, creating = true): () => void {
  return () => {
    hooks.checkStop();
    if ('deadline' in hooks && hooks.now() >= hooks.deadline) throw new VenueError('not-sent', '期权跟价已到截止时间');
    if (ticker) client.publicAt?.(ticker);
    hooks.checkPrice(Number(price));
    if (creating) hooks.transmitted?.();
  };
}

export async function followOrder(client: OptionsClient, spec: OrderSpec, hooks: FollowHooks): Promise<OrderOutcome> {
  let outcome: OrderOutcome = { orderId: '', status: 'unknown', terminal: false, filledQty: '0' };
  // Set before the create is awaited: a lost answer can hide an accepted order.
  let attempted = false, lastPrice: string | null = null;
  try {
    while (hooks.now() < hooks.deadline) {
      hooks.checkStop();
      hooks.checkPrice(null);
      if (attempted) {
        const order = await client.order(spec.symbol, spec.link, AbortSignal.timeout(CALL_MS), hooks.seen);
        const next = snapshot(order, spec.qty, spec.side, outcome);
        hooks.record(next);
        outcome = next;
        if (outcome.terminal) break;
        hooks.checkStop();
      }
      const ticker = await client.ticker(spec.symbol, AbortSignal.timeout(CALL_MS));
      hooks.checkStop();
      const price = roundToTick(spec.side === 'Buy' ? ticker?.bid1Price : ticker?.ask1Price, spec.tick);
      if (price !== null) {
        hooks.checkPrice(Number(price));
        hooks.checkStop();
        if (!attempted) {
          attempted = true;
          try {
            const answer = await client.create({ symbol: spec.symbol, side: spec.side, qty: spec.qty, price, link: spec.link, reduceOnly: spec.reduceOnly }, AbortSignal.timeout(CALL_MS), atTransmission(client, ticker, price, hooks));
            outcome.orderId = receiptId(answer, spec.link);
            if (outcome.orderId || answer.orderLinkId === spec.link) hooks.seen?.(outcome.orderId);
          } catch (error) {
            // A refusal, or a request that never left, proves no order exists to reconcile.
            if (error instanceof VenueError && (error.kind === 'rejected' || error.kind === 'not-sent')) attempted = false;
            throw error;
          }
          lastPrice = price;
          outcome.price = price;
          hooks.record(outcome);
          hooks.checkStop();
        } else if (price !== lastPrice) {
          await client.amend(spec.symbol, spec.link, price, AbortSignal.timeout(CALL_MS), atTransmission(client, ticker, price, hooks, false));
          lastPrice = price;
          outcome.price = price;
          hooks.checkStop();
        }
      }
      await hooks.pause(hooks.pollMs);
    }
    if (attempted && !outcome.terminal) outcome = await reconcileOrder(client, spec, outcome, true, hooks);
    else if (!attempted) outcome = { ...outcome, status: 'not_submitted', terminal: true, message: '没有可用的盘口价，未下单' };
  } catch (error) {
    hooks.log(`期权订单 ${spec.link} 执行中断：${describe(error)}`);
    outcome = attempted ? await reconcileOrder(client, spec, outcome, true, hooks) : { ...outcome, status: 'not_submitted', terminal: true };
    outcome = { ...outcome, message: describe(error) };
  }
  hooks.record(outcome);
  return outcome;
}

export interface IocHooks extends ReconcileHooks {
  transmitted?(): void;
  checkStop(): void;
  /** Reserves the IOC price against the task's limits; a throw sends nothing. */
  checkPrice(price: number): void;
}

/**
 * The workbench's bounded IOC fallback (orders.py, market=True): one limit IOC at ask 1 (a buy, rounded down to the tick)
 * or bid 1 (a sell, rounded up), reserved against the task's limits first, then read back without cancelling and, if
 * still open, cancelled and read back. Never re-sent.
 */
export async function iocOrder(client: OptionsClient, spec: OrderSpec, hooks: IocHooks): Promise<OrderOutcome> {
  let outcome: OrderOutcome = { orderId: '', status: 'unknown', terminal: false, filledQty: '0' };
  let attempted = false;
  try {
    hooks.checkStop();
    const ticker = await client.ticker(spec.symbol, AbortSignal.timeout(CALL_MS));
    hooks.checkStop();
    const price = toTick(spec.side === 'Buy' ? ticker?.ask1Price : ticker?.bid1Price, spec.tick, spec.side === 'Buy' ? 'down' : 'up');
    if (price === null) outcome = { ...outcome, status: 'not_submitted', terminal: true, message: '没有可用的对手价，未发 IOC 兜底' };
    else {
      hooks.checkPrice(Number(price));
      hooks.checkStop();
      // Set before the create is awaited: a lost answer can hide an accepted order.
      attempted = true;
      try {
        const answer = await client.create({ symbol: spec.symbol, side: spec.side, qty: spec.qty, price, link: spec.link, reduceOnly: spec.reduceOnly, timeInForce: 'IOC' }, AbortSignal.timeout(CALL_MS), atTransmission(client, ticker, price, hooks));
        outcome.orderId = receiptId(answer, spec.link);
        if (outcome.orderId || answer.orderLinkId === spec.link) hooks.seen?.(outcome.orderId);
      } catch (error) {
        if (error instanceof VenueError && (error.kind === 'rejected' || error.kind === 'not-sent')) attempted = false;
        throw error;
      }
      outcome.price = price;
      hooks.record(outcome);
      outcome = await reconcileOrder(client, spec, outcome, false, hooks);
      if (!outcome.terminal) outcome = await reconcileOrder(client, spec, outcome, true, hooks);
    }
  } catch (error) {
    hooks.log(`期权 IOC 兜底 ${spec.link} 中断：${describe(error)}`);
    outcome = attempted ? await reconcileOrder(client, spec, outcome, true, hooks) : { ...outcome, status: 'not_submitted', terminal: true };
    outcome = { ...outcome, message: describe(error) };
  }
  hooks.record(outcome);
  return outcome;
}
