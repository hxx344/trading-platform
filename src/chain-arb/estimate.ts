import Decimal from '../vendor/decimal.mjs';
import type { DexQuote } from './dex.ts';
import type { GateLeg } from './gate.ts';
import { CHAIN_ARB_CLOCK_SKEW_MS, CHAIN_ARB_TTL_MS, VENUE_NAMES, type ArbResult, type ChainArbInput, type ChainArbView } from './model.ts';
import type { VenueBook } from './venue.ts';

// ERC-20 输出最多 78 位整数。覆盖它与 Gate 有限数值相乘时，从最小买盘量 × 最小价 (1e-648)
// 到最大输出 × 最大价 (1e386) 的全部位数，确保盘口累加、限额与步长比较不进位。
const D = Decimal.clone({ precision: 1100 });

function fresh(at: number, now: number): boolean {
  return Number.isFinite(at) && at > 0 && now - at < CHAIN_ARB_TTL_MS && at - now <= CHAIN_ARB_CLOCK_SKEW_MS;
}

function estimate(leg: GateLeg, input: ChainArbInput, bought: Decimal, buy: DexQuote, now: number, isPerp: boolean): ArbResult {
  if ('error' in leg) return leg;
  if (!fresh(leg.at, now) || Math.abs(leg.at - buy.at) >= CHAIN_ARB_TTL_MS) return { error: '盘口已过期，请刷新报价' };
  // Gate validates the decimal strings before handing the book to this calculation.
  const step = new D(leg.step);
  if (!step.isFinite() || !step.gt(0)) return { error: '交易数量步长无效' };
  const remainder = bought.mod(step);
  const quantity = bought.minus(remainder);
  if (quantity.isZero()) return { error: '链上买入数量不足一个交易单位' };
  if (quantity.lt(leg.minQuantity ?? 0) || quantity.gt(leg.maxQuantity ?? Infinity)) return { error: '数量不在该市场单笔范围内' };

  let remaining = quantity, proceeds = new D(0), previous = new D(Infinity);
  for (const [priceText, quantityText] of leg.bids) {
    const bid = new D(priceText), available = new D(quantityText);
    if (!bid.isFinite() || !available.isFinite() || !bid.gt(0) || !available.gt(0) || bid.gt(previous)) return { error: '盘口档位无效' };
    const take = D.min(remaining, available);
    proceeds = proceeds.plus(take.times(bid));
    remaining = remaining.minus(take);
    previous = bid;
    if (remaining.isZero()) break;
  }
  if (!remaining.isZero()) return { error: '公开买盘深度不足以覆盖该数量' };
  if (proceeds.lt(leg.minNotional ?? 0) || proceeds.gt(leg.maxNotional ?? Infinity)) return { error: '名义金额不在该市场单笔范围内' };
  const coveredCost = quantity.times(input.amount).div(bought);
  const gross = proceeds.minus(coveredCost);
  const costs = isPerp ? input.perpCosts : input.spotCosts;
  const feeRate = isPerp ? new D(input.perpFeeBps).times(2) : input.spotFeeBps;
  const tradingFees = proceeds.times(feeRate).div(10_000);
  const gas = input.swapGas === 'auto' ? buy.swapGasUsdt ?? null : 0;
  const net = costs === null || gas === null ? null : gross.minus(tradingFees).minus(costs).minus(gas);
  const netUsdt = net?.toNumber() ?? null, netBps = net?.times(10_000).div(coveredCost).toNumber() ?? null;
  const price = proceeds.div(quantity).toNumber(), grossUsdt = gross.toNumber();
  const spreadBps = gross.times(10_000).div(coveredCost).toNumber();
  if (![price, grossUsdt, spreadBps, netUsdt ?? 0, netBps ?? 0].every(Number.isFinite)) return { error: '报价超出可计算范围' };
  return { quantity: quantity.toNumber(), price, grossUsdt, spreadBps, netUsdt, netBps, coveredCostUsdt: coveredCost.toNumber(), at: leg.at, remainder: remainder.toNumber() };
}

export function compareChainArb(input: ChainArbInput, buy: DexQuote, venue: VenueBook, now: number): ChainArbView {
  if (!fresh(buy.at, now)) throw new Error('链上报价已过期或时间异常，请刷新');
  const bought = new D(`${buy.rawQuantity}e-${buy.decimals}`);
  const dex = { quantity: bought.toNumber(), price: new D(input.amount).div(bought).toNumber(), at: buy.at, swapGasUsdt: buy.swapGasUsdt ?? null };
  if (!(dex.quantity > 0 && dex.price > 0) || !Number.isFinite(dex.price) || !Number.isFinite(dex.quantity)) throw new Error('链上买入数量无效');
  const name = VENUE_NAMES[input.venue ?? 'gate'];
  const spot = venue.deposit !== true
    ? { error: venue.deposit === false ? name + ' 已暂停此网络充值' : '此网络的 ' + name + ' 充值状态未核实',
      ...('error' in venue.spot && venue.spot.rateLimited ? { rateLimited: true as const } : {}) }
    : venue.minDeposit !== undefined && bought.lt(venue.minDeposit) ? { error: '链上买入数量低于该网络最低充值量' }
    : estimate(venue.spot, input, bought, buy, now, false);
  const perp = estimate(venue.perp, input, bought, buy, now, true);
  const oldest = Math.min(dex.at, 'at' in spot ? spot.at : now, 'at' in perp ? perp.at : now, now);
  return { asOf: now, expiresAt: oldest + CHAIN_ARB_TTL_MS, dex, deposit: venue.deposit, withdraw: venue.withdraw, spot, perp };
}
