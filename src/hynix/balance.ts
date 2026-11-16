// The two SK hynix legs one account holds on one venue, compared by USDT notional (docs/hynix.md section 7). The ADR and
// the ordinary share hedge equal notional, so what is left unhedged is the difference of the two legs' notional, not of
// their units. Pure and exact: the page view, the alert and the executor's rebalance preview all compute it here.
import { cmp, decimal, fromUnits, isZero, mul, sub, units } from '../decimal.ts';
import { exactKeys, reject, type Instrument, type PositionSide } from '../contracts.ts';
import { quantityForNotional } from './sizing.ts';

const SCALE = 10n ** 18n;

/** Percent of the larger leg's notional, and USDT. A gap under minGapUsdt is left alone whatever its percent. */
export interface BalanceSettings { rebalancePercent: string; hardPercent: string; minGapUsdt: string }
export const DEFAULT_BALANCE_SETTINGS: Readonly<BalanceSettings> = Object.freeze({ rebalancePercent: '2', hardPercent: '5', minGapUsdt: '50' });
const PERCENT = /^(0|[1-9]\d?)(\.\d{1,2})?$/, USDT = /^(0|[1-9]\d{0,5})(\.\d{1,2})?$/;

/** 0.1 ≤ rebalancePercent < hardPercent ≤ 50 (two decimals), 0 ≤ minGapUsdt ≤ 100000 (two decimals). */
export function parseBalanceSettings(value: unknown): BalanceSettings {
  const raw = exactKeys(value, ['rebalancePercent', 'hardPercent', 'minGapUsdt']);
  const field = (input: unknown, pattern: RegExp, name: string): string => typeof input === 'string' && pattern.test(input) ? decimal(input) : reject('invalid_value', `${name}无效`);
  const rebalancePercent = field(raw.rebalancePercent, PERCENT, '调平线（%）'), hardPercent = field(raw.hardPercent, PERCENT, '硬上限（%）'), minGapUsdt = field(raw.minGapUsdt, USDT, '最小差额（USDT）');
  if (cmp(rebalancePercent, '0.1') < 0) reject('invalid_value', '调平线不能低于 0.1%');
  if (cmp(hardPercent, '50') > 0) reject('invalid_value', '硬上限不能高于 50%');
  if (cmp(rebalancePercent, hardPercent) >= 0) reject('invalid_value', '调平线须低于硬上限');
  if (cmp(minGapUsdt, '100000') > 0) reject('invalid_value', '最小差额不能高于 100000 USDT');
  return { rebalancePercent, hardPercent, minGapUsdt };
}

/** One contract as held: both sides' quantities (0 when flat), the price it is valued at and its contract size. */
export interface HeldContract { symbol: string; long: string; short: string; price: string; contractSize: string }
export interface BalanceLeg { symbol: string; side: PositionSide; quantity: string; price: string; notional: string }
/**
 * none: neither contract is held. unpaired: something is held that is not one long leg against one short leg on the two
 * contracts (one contract only, both the same side, or one contract held both ways); its whole notional is unhedged.
 * paired: gap = |long notional − short notional| in USDT, netSide the larger leg's side (null when equal), percent = gap ÷
 * the larger leg's notional × 100, truncated at 18 digits.
 */
export type PairBalance =
  | { status: 'none' }
  | { status: 'unpaired'; reason: string; legs: BalanceLeg[] }
  | { status: 'paired'; long: BalanceLeg; short: BalanceLeg; gap: string; netSide: PositionSide | null; percent: string };

export function pairBalance(adr: HeldContract, ordinary: HeldContract): PairBalance {
  const legs = [adr, ordinary].flatMap(held => (['long', 'short'] as const).filter(side => !isZero(held[side])).map((side): BalanceLeg => (
    { symbol: held.symbol, side, quantity: held[side], price: held.price, notional: mul(mul(held[side], held.contractSize), held.price) })));
  if (legs.length === 0) return { status: 'none' };
  const unpaired = (reason: string): PairBalance => ({ status: 'unpaired', reason, legs });
  if ([adr, ordinary].some(held => !isZero(held.long) && !isZero(held.short))) return unpaired('同一合约同时持有多头与空头');
  if (legs.length === 1) return unpaired('只有单腿持仓，另一腿为空');
  const long = legs.find(leg => leg.side === 'long'), short = legs.find(leg => leg.side === 'short');
  if (!long || !short) return unpaired('两腿方向相同，没有对冲');
  const order = cmp(long.notional, short.notional), larger = order >= 0 ? long : short, smaller = order >= 0 ? short : long;
  const gap = sub(larger.notional, smaller.notional);
  return { status: 'paired', long, short, gap, netSide: order === 0 ? null : larger.side, percent: isZero(larger.notional) ? '0' : fromUnits(units(gap) * 100n * SCALE / units(larger.notional)) };
}

export type BalanceLevel = 'ok' | 'rebalance' | 'hard';
/** ok within the rebalance line or under the minimum gap; rebalance above the line; hard above the hard limit or unpaired. */
export function balanceLevel(balance: PairBalance, settings: BalanceSettings): BalanceLevel {
  if (balance.status === 'none') return 'ok';
  if (balance.status === 'unpaired') return 'hard';
  if (cmp(balance.gap, settings.minGapUsdt) < 0) return 'ok';
  return cmp(balance.percent, settings.hardPercent) > 0 ? 'hard' : cmp(balance.percent, settings.rebalancePercent) > 0 ? 'rebalance' : 'ok';
}

export type RebalanceMethod = 'reduce' | 'add';
export interface RebalanceOrder { symbol: string; side: PositionSide; action: 'open' | 'close'; quantity: string }
/**
 * The one order that levels a paired balance: reduce closes part of the larger leg, add opens more of the smaller one.
 * Its quantity is the gap at that leg's price, floored to the step, so the order never crosses the balance point at the
 * prices it was computed on. Refused (with the reason) when the legs are level or the gap is under the leg's minimum quantity.
 */
export function rebalanceOrder(balance: Extract<PairBalance, { status: 'paired' }>, method: RebalanceMethod, instruments: Readonly<Record<string, Pick<Instrument, 'contractSize' | 'quantityStep' | 'minQuantity'>>>): RebalanceOrder | { error: string } {
  if (balance.netSide === null) return { error: '两腿名义金额已相等，无需调平' };
  const larger = balance.netSide === 'long' ? balance.long : balance.short, smaller = balance.netSide === 'long' ? balance.short : balance.long;
  const leg = method === 'reduce' ? larger : smaller, instrument = instruments[leg.symbol];
  if (!instrument) return { error: `${leg.symbol} 合约规则未读到` };
  const quantity = quantityForNotional(balance.gap, leg.price, instrument);
  if (cmp(quantity, instrument.minQuantity) < 0) return { error: `两腿名义差额 ${balance.gap.replace(/(\.\d{2})\d+$/, '$1')} USDT 不足 ${leg.symbol} 最小下单量 ${instrument.minQuantity}` };
  return { symbol: leg.symbol, side: leg.side, action: method === 'reduce' ? 'close' : 'open', quantity };
}
