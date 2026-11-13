// One option order that follows the book, and its reconciliation by order link id (never by account position). Ported
// from the workbench's OrderExecutor (orders.py, commit 160e932): a GTC limit at bid 1 for a buy and ask 1 for a sell,
// rounded half up to the tick, amended whenever that price moves, looked at every poll; at the deadline, on a stop or on
// any error the order is cancelled and read back up to five times. An order neither list knows stays unknown, unless the
// caller says it may settle: see reconcileOrder.
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

/** The order read back, checked against what was sent; null (not found) keeps the previous outcome. */
export function snapshot(order: Row | null, qty: string, side: Side, previous: OrderOutcome): OrderOutcome {
  if (order === null) return previous;
  let filled: string, requested: string;
  try { filled = decimal(order.cumExecQty, 'nonnegative'); requested = decimal(order.qty, 'positive'); }
  catch { throw new Error('订单核对返回的数量无效'); }
  if (order.side !== side || cmp(requested, qty) !== 0 || cmp(filled, previous.filledQty) < 0 || cmp(filled, qty) > 0) throw new Error('订单核对返回的数量或方向与下单不一致');
  const terminal = TERMINAL.has(String(order.orderStatus));
  const full = cmp(filled, qty) === 0;
  if (order.orderStatus === 'Filled' && !full) throw new Error('已成交订单的累计成交数量不完整');
  const status: OrderStatus = terminal ? (full ? 'filled' : cmp(filled, '0') > 0 ? 'partial' : 'timeout_cancelled') : 'unknown';
  return { ...previous, orderId: typeof order.orderId === 'string' && order.orderId ? order.orderId : previous.orderId, status, terminal, filledQty: filled };
}

export interface ReconcileHooks {
  record(outcome: OrderOutcome): void;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
}

/**
 * Cancels (optionally), then reads the order back until it is terminal, at most RECONCILE_CHECKS times. With
 * settleMissing (the caller's word that the create went out long enough ago that Bybit can no longer accept it: it
 * refuses a request older than its receive window), an order the venue never answered with an id and that every read
 * answers "not found" (no read failing) is settled as not submitted, filled 0. One with an id stays unknown.
 */
export async function reconcileOrder(client: OptionsClient, spec: Pick<OrderSpec, 'symbol' | 'side' | 'qty' | 'link'>, previous: OrderOutcome, cancel: boolean, hooks: ReconcileHooks, settleMissing = false): Promise<OrderOutcome> {
  let outcome: OrderOutcome = { ...previous, status: 'unknown', terminal: false };
  let missing = settleMissing && previous.orderId === '';
  if (cancel) {
    try { await client.cancel(spec.symbol, spec.link, AbortSignal.timeout(CALL_MS)); }
    catch (error) { hooks.log(`期权订单 ${spec.link} 撤单未确认：${describe(error)}`); }
  }
  for (let attempt = 0; attempt < RECONCILE_CHECKS; attempt++) {
    try {
      const order = await client.order(spec.symbol, spec.link, AbortSignal.timeout(CALL_MS));
      outcome = snapshot(order, spec.qty, spec.side, outcome);
      if (order !== null) { missing = false; hooks.record(outcome); }
      if (outcome.terminal) return outcome;
    } catch (error) { missing = false; hooks.log(`期权订单 ${spec.link} 核对失败：${describe(error)}`); }
    if (attempt + 1 < RECONCILE_CHECKS) await hooks.sleep(RECONCILE_INTERVAL_MS);
  }
  if (missing) {
    hooks.log(`期权订单 ${spec.link} 发出已超过交易所接收时限且查无此单，按未下单结算`);
    return { ...outcome, status: 'not_submitted', terminal: true, filledQty: '0', message: '下单应答丢失，交易所查无此单，按未下单结算' };
  }
  hooks.log(`期权订单 ${spec.link} 状态仍未知，已禁止自动重试`);
  return { ...outcome, message: '订单状态未知，已禁止自动重试' };
}

export interface FollowHooks extends ReconcileHooks {
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

export async function followOrder(client: OptionsClient, spec: OrderSpec, hooks: FollowHooks): Promise<OrderOutcome> {
  let outcome: OrderOutcome = { orderId: '', status: 'unknown', terminal: false, filledQty: '0' };
  // Set before the create is awaited: a lost answer can hide an accepted order.
  let attempted = false, lastPrice: string | null = null;
  try {
    while (hooks.now() < hooks.deadline) {
      hooks.checkStop();
      hooks.checkPrice(null);
      if (attempted) {
        const order = await client.order(spec.symbol, spec.link, AbortSignal.timeout(CALL_MS));
        outcome = snapshot(order, spec.qty, spec.side, outcome);
        hooks.record(outcome);
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
            const answer = await client.create({ symbol: spec.symbol, side: spec.side, qty: spec.qty, price, link: spec.link, reduceOnly: spec.reduceOnly }, AbortSignal.timeout(CALL_MS));
            if (typeof answer.orderId === 'string') outcome.orderId = answer.orderId;
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
          await client.amend(spec.symbol, spec.link, price, AbortSignal.timeout(CALL_MS));
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
