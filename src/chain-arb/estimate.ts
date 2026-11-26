import Decimal from '../vendor/decimal.mjs';
import type { DexQuote } from './dex.ts';
import type { GateLeg } from './gate.ts';
import { CHAIN_ARB_CLOCK_SKEW_MS, CHAIN_ARB_MAX_IMPACT_BPS, CHAIN_ARB_TTL_MS, VENUE_NAMES, type ArbResult, type ChainArbInput, type ChainArbView } from './model.ts';
import type { VenueBook } from './venue.ts';

// ERC-20 数量最多 78 位。维持足够的十进制精度以精确比较盘口累加、单笔限额与交易步长。
const D = Decimal.clone({ precision: 1100 });
const UINT256_MAX = (1n << 256n) - 1n;
type Book = Extract<GateLeg, { bids: unknown }>;
type Unavailable = Extract<GateLeg, { error: string }>;

function fresh(at: number, now: number): boolean {
  return Number.isFinite(at) && at > 0 && now - at < CHAIN_ARB_TTL_MS && at - now <= CHAIN_ARB_CLOCK_SKEW_MS;
}

function rawAmount(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d{0,77})$/.test(value) && BigInt(value) <= UINT256_MAX;
}

// 十进制步长同样适用欧几里得算法，保留合约面额与 lotSz 相乘后超过 18 位的小数。
function commonStep(spot: Decimal, perp: Decimal): Decimal {
  let a = spot, b = perp;
  while (!b.isZero()) [a, b] = [b, a.mod(b)];
  return spot.div(a).times(perp);
}

function notionalAllowed(book: Book, amount: Decimal): boolean {
  return amount.gte(book.minNotional ?? 0) && amount.lte(book.maxNotional ?? Infinity);
}

function sellInto(book: Book, quantity: Decimal): { proceeds: Decimal; bestBid: Decimal } | Unavailable {
  if (quantity.lt(book.minQuantity ?? 0) || quantity.gt(book.maxQuantity ?? Infinity)) return { error: '数量不在该市场单笔范围内' };
  let remaining = quantity, proceeds = new D(0), previous = new D(Infinity);
  for (const [priceText, quantityText] of book.bids) {
    const bid = new D(priceText), available = new D(quantityText);
    if (!bid.isFinite() || !available.isFinite() || !bid.gt(0) || !available.gt(0) || bid.gt(previous)) return { error: '盘口档位无效' };
    const take = D.min(remaining, available);
    proceeds = proceeds.plus(take.times(bid));
    remaining = remaining.minus(take);
    previous = bid;
    if (remaining.isZero()) break;
  }
  if (!remaining.isZero()) return { error: '公开买盘深度不足以覆盖该数量' };
  if (!notionalAllowed(book, proceeds)) return { error: '名义金额不在该市场单笔范围内' };
  return { proceeds, bestBid: new D(book.bids[0][0]) };
}

function estimate(input: ChainArbInput, delivered: Decimal, buy: DexQuote, now: number, spot: GateLeg, perp?: GateLeg): ArbResult {
  if (perp && 'error' in perp) return perp;
  if ('error' in spot) return spot;
  const times = perp ? [spot.at, perp.at, buy.at] : [spot.at, buy.at];
  if (times.some(at => !fresh(at, now)) || Math.max(...times) - Math.min(...times) >= CHAIN_ARB_TTL_MS) return { error: '盘口已过期，请刷新报价' };

  const steps = (perp ? [spot.step, perp.step] : [spot.step]).map(value => new D(value));
  if (steps.some(step => !step.isFinite() || !step.gt(0))) return { error: '交易数量步长无效' };
  const step = steps.reduce(commonStep);
  const remainder = delivered.mod(step), quantity = delivered.minus(remainder);
  if (!quantity.gt(0)) return { error: '预计到账数量不足一个交易单位' };
  const spotSale = sellInto(spot, quantity);
  if ('error' in spotSale) return spotSale;
  let proceeds = spotSale.proceeds, price = proceeds.div(quantity);
  let tradingFees = proceeds.times(input.spotFeeBps).div(10_000);
  if (perp) {
    const opening = sellInto(perp, quantity);
    if ('error' in opening) return opening;
    // 收敛时按现货买一平空，卖出现货按真实深度。现货卖出额与平空额之间的吃档损耗保留。
    const closeNotional = spotSale.bestBid.times(quantity);
    if (!notionalAllowed(perp, closeNotional)) return { error: '假设平空金额不在永续市场单笔范围内' };
    proceeds = proceeds.plus(opening.proceeds).minus(closeNotional);
    price = opening.proceeds.div(quantity);
    tradingFees = tradingFees.plus(opening.proceeds.plus(closeNotional).times(input.perpFeeBps).div(10_000));
  }

  // 整笔资金均已花出。不能按该市场步长卖出或对冲的尾数不计回收价值。
  const cost = new D(input.amount), gross = proceeds.minus(cost);
  const costs = perp ? input.perpCosts : input.spotCosts;
  const gas = input.swapGas === 'auto' ? buy.swapGasUsdt ?? null : 0;
  const net = costs === null || gas === null ? null : gross.minus(tradingFees).minus(costs).minus(gas);
  const result = { quantity: quantity.toNumber(), price: price.toNumber(), grossUsdt: gross.toNumber(), spreadBps: gross.times(10_000).div(cost).toNumber(),
    netUsdt: net?.toNumber() ?? null, netBps: net?.times(10_000).div(cost).toNumber() ?? null, coveredCostUsdt: cost.toNumber(),
    at: perp ? Math.min(spot.at, perp.at) : spot.at, remainder: remainder.toNumber() };
  if (!Object.values(result).every(value => value === null || Number.isFinite(value))) return { error: '报价超出可计算范围' };
  return result;
}

export function compareChainArb(input: ChainArbInput, buy: DexQuote, venue: VenueBook, now: number): ChainArbView {
  if (!fresh(buy.at, now)) throw new Error('链上报价已过期或时间异常，请刷新');
  if (!rawAmount(buy.rawQuantity) || buy.rawQuantity === '0' || !Number.isInteger(buy.decimals) || buy.decimals < 0 || buy.decimals > 255) throw new Error('链上买入数量无效');
  const tokenAmount = (raw: string) => new D(raw + 'e-' + buy.decimals);
  const bought = tokenAmount(buy.rawQuantity);
  const dex: ChainArbView['dex'] = { quantity: bought.toNumber(), price: new D(input.amount).div(bought).toNumber(), at: buy.at, swapGasUsdt: buy.swapGasUsdt ?? null };
  if (!Number.isFinite(dex.price) || dex.price <= 0) throw new Error('链上买入均价无效');
  const evidence = buy.evidence;
  let delivered: Decimal | null = null;
  if (evidence && rawAmount(evidence.quotedRaw) && evidence.quotedRaw !== '0' && Number.isFinite(evidence.impactBps) && evidence.impactBps >= 0
    && /^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i.test(evidence.blockNumber) && (evidence.transferRaw === null || rawAmount(evidence.transferRaw))) {
    delivered = evidence.transferRaw === null ? null : tokenAmount(evidence.transferRaw);
    if (delivered === null || delivered.lte(bought)) {
      dex.execution = { quotedQuantity: tokenAmount(evidence.quotedRaw).toNumber(), receivedQuantity: dex.quantity,
        transferQuantity: delivered?.toNumber() ?? null, transferAmount: delivered?.toFixed() ?? null,
        impactBps: evidence.impactBps, blockNumber: evidence.blockNumber };
    }
  }
  const name = VENUE_NAMES[input.venue ?? 'gate'];
  let blocked: string | undefined;
  if (venue.deposit !== true) blocked = venue.deposit === false ? name + ' 已暂停此网络充值' : '此网络的 ' + name + ' 充值状态未核实';
  else if (!dex.execution) blocked = '缺少完整有效的链上买入和转账模拟证据';
  else if (dex.execution.impactBps > CHAIN_ARB_MAX_IMPACT_BPS) blocked = '整笔链上买入价格影响超过 ' + CHAIN_ARB_MAX_IMPACT_BPS + ' bp';
  else if (!delivered?.gt(0)) blocked = '转账模拟未确认可到账数量';
  else if (venue.minDeposit !== undefined && delivered.lt(venue.minDeposit)) blocked = '预计到账数量低于该网络最低充值量';
  const unavailable = (market: GateLeg): Unavailable => ({ error: blocked!, ...('error' in market && market.rateLimited ? { rateLimited: true as const } : {}) });
  const spot = blocked ? unavailable(venue.spot) : estimate(input, delivered!, buy, now, venue.spot);
  const perp = blocked ? unavailable(venue.perp) : estimate(input, delivered!, buy, now, venue.spot, venue.perp);
  const oldest = Math.min(dex.at, 'at' in spot ? spot.at : now, 'at' in perp ? perp.at : now, now);
  return { asOf: now, expiresAt: oldest + CHAIN_ARB_TTL_MS, dex, deposit: venue.deposit, withdraw: venue.withdraw, spot, perp };
}
