// 实盘下单预演（docs/varlighter.md 第 8 节、docs/dexspread.md 第 6 节）：按最新样本算出两腿将要提交的数量与限价，并核对各场所的
// 最小数量、最小金额与精度。只生成计划，不签名、不发送；实盘（live.ts）用它定两腿的数量与第一腿的限价。
import { VENUE_NAMES, bucketOf, isLive, spreadOf, type LegInfo, type PairInfo, type Sample, type VenueId } from './model.ts';
import type { Direction } from './strategy.ts';

export interface PlanCheck { ok: boolean; label: string }
export interface LegPlan {
  venue: VenueId; side: 'buy' | 'sell';
  /** 基础数量（十进制字符串，已按精度向下取整）。 */ qty: string;
  /** 预期成交价与带滑点保护的限价（该场所原始价格，不乘乘数）。 */ expected: number; limit: string;
  notionalUsd: number;
  /** 交易所下单接口里的字段（预览）。 */ fields: Record<string, string | number | boolean>;
}
export interface OrderPlan {
  /** 配对键。 */ symbol: string; direction: Direction; notionalUsd: number; at: number;
  legs: LegPlan[]; checks: PlanCheck[]; ready: boolean;
  /** 先下哪条腿、另一条腿失败时怎么处理。 */ sequence: string[];
}

export const floorTo = (value: number, decimals: number) => { const scale = 10 ** decimals; return Math.floor(value * scale + 1e-9) / scale; };
const roundTo = (value: number, decimals: number, up: boolean) => { const scale = 10 ** decimals; return (up ? Math.ceil(value * scale - 1e-9) : Math.floor(value * scale + 1e-9)) / scale; };
/** Hyperliquid 价格最多 5 位有效数字。 */
const significant = (value: number, digits: number) => Number(value.toPrecision(digits));

/** 下单前报价须足够新、两边须对得上：较慢一腿报价距现在与两腿报价时刻之差的上限。 */
export const PLAN_MAX_QUOTE_AGE_MS = 90_000;
/** 采集时已按 75 秒对齐，这里是兜底，防止用库里拼出的旧样本。 */
export const PLAN_MAX_ALIGN_MS = 75_000;
/** 时钟差：报价时刻晚于本机不超过 5 秒时按 0 秒算，不判失败。 */
const CLOCK_SKEW_MS = 5_000;

function legFields(leg: LegInfo, side: 'buy' | 'sell', qty: number, qtyText: string, limit: number, limitText: string, slip: number): Record<string, string | number | boolean> {
  const market = leg.market;
  if (leg.venue === 'var') return { underlying: leg.symbol, side, qty: qtyText, max_slippage: slip, order_type: 'market (RFQ)' };
  if (leg.venue === 'entropy') return { coin: market.coin ?? `io:${leg.symbol}`, is_buy: side === 'buy', sz: qtyText, limit_px: limitText, order_type: 'limit', tif: 'Ioc', reduce_only: false };
  const sizeDecimals = market.sizeDecimals ?? 0, priceDecimals = market.priceDecimals ?? 0;
  return { market_index: market.id, base_amount: Math.round(qty * 10 ** sizeDecimals), price: Math.round(limit * 10 ** priceDecimals), is_ask: side === 'sell', order_type: 'LIMIT', time_in_force: 'IMMEDIATE_OR_CANCEL', reduce_only: false };
}

/** 带滑点保护的限价（数值与按精度写出的文本）：买单向上、卖单向下取整；Entropy 先取 5 位有效数字。 */
export function limitPrice(leg: LegInfo, side: 'buy' | 'sell', expected: number, slippageBps: number): [number, string] {
  const slip = slippageBps / 10_000, raw = side === 'buy' ? expected * (1 + slip) : expected * (1 - slip), decimals = leg.market.priceDecimals;
  if (leg.venue === 'var' || decimals === null) return [raw, raw.toPrecision(8)];
  const rounded = roundTo(leg.venue === 'entropy' ? significant(raw, 5) : raw, decimals, side === 'buy');
  return [rounded, rounded.toFixed(decimals)];
}

export function orderPlan(pair: PairInfo, sample: Sample, direction: Direction, notionalUsd: number, maxSlippageBps: number, now: number): OrderPlan {
  const checks: PlanCheck[] = [], k = pair.ratio, aName = VENUE_NAMES[pair.a.venue], bName = VENUE_NAMES[pair.b.venue];
  const spread = spreadOf(sample, bucketOf(notionalUsd));
  const rich = direction === 'a_rich';
  const aSide = rich ? 'sell' : 'buy', bSide = rich ? 'buy' : 'sell';
  // 预期价：A 腿原价；B 腿 spread 里是折算价，除以乘数回到 B 的原价。
  const aExpected = spread ? (rich ? spread.prices.aBid : spread.prices.aAsk) : rich ? sample.aBid0 : sample.aAsk0;
  const bExpected = spread ? (rich ? spread.prices.bAsk : spread.prices.bBid) / k : rich ? sample.bAsk0 : sample.bBid0;
  const bMid = (sample.bBid0 + sample.bAsk0) / 2;
  // 数量以有精度的一腿为准：B 有精度时先定 B 的数量（名义 ÷ B 中间价），A = B ÷ 乘数；否则先定 A。
  const aDecimals = pair.a.market.sizeDecimals, bDecimals = pair.b.market.sizeDecimals;
  let aQty: number, bQty: number;
  if (bDecimals !== null) {
    bQty = floorTo(notionalUsd / bMid, bDecimals);
    aQty = aDecimals !== null ? floorTo(bQty / k, aDecimals) : bQty / k;
    if (aDecimals !== null) bQty = floorTo(aQty * k, bDecimals);
  }
  else { aQty = floorTo(notionalUsd / (k * bMid), aDecimals ?? 6); bQty = aQty * k; }
  const format = (qty: number, decimals: number | null, other: number | null) => decimals !== null ? qty.toFixed(decimals) : other !== null && k === 1 ? qty.toFixed(other) : String(Number(qty.toPrecision(8)));
  const aQtyText = format(aQty, aDecimals, bDecimals), bQtyText = format(bQty, bDecimals, aDecimals);
  const slip = maxSlippageBps / 10_000;
  const limitOf = (leg: LegInfo, side: 'buy' | 'sell', expected: number) => limitPrice(leg, side, expected, maxSlippageBps);
  const [aLimit, aLimitText] = limitOf(pair.a, aSide, aExpected), [bLimit, bLimitText] = limitOf(pair.b, bSide, bExpected);
  for (const [leg, qty, qtyText, expected, name] of [[pair.a, aQty, aQtyText, aExpected, aName], [pair.b, bQty, bQtyText, bExpected, bName]] as const) {
    if (leg.venue === 'var') continue;
    checks.push({ ok: qty > 0, label: `按 ${name} 数量精度 ${leg.market.sizeDecimals} 位取整后数量 ${qtyText}` });
    if (leg.market.minBase > 0) checks.push({ ok: qty >= leg.market.minBase, label: `不小于 ${name} 最小数量 ${leg.market.minBase}` });
    if (leg.market.minQuote > 0) checks.push({ ok: qty * expected >= leg.market.minQuote, label: `不小于 ${name} 最小金额 ${leg.market.minQuote} USDC` });
  }
  checks.push({ ok: !!spread, label: spread ? `${bucketOf(notionalUsd)} 档两边都有可成交价${spread.estimated ? '（有一腿用一档价估算）' : ''}` : '该档位缺少可成交价（100k 档需要两腿的盘口快照）' });
  const slowAt = Math.min(sample.aAt, sample.bAt), quoteAge = Math.max(0, now - slowAt), ahead = sample.t - now > CLOCK_SKEW_MS, align = Math.abs(sample.aAt - sample.bAt);
  checks.push({ ok: !ahead && quoteAge <= PLAN_MAX_QUOTE_AGE_MS, label: ahead ? `报价时刻超前本机 ${Math.round((sample.t - now) / 1000)} 秒` : `较慢一腿报价 ${Math.round(quoteAge / 1000)} 秒前（不超过 ${PLAN_MAX_QUOTE_AGE_MS / 1000} 秒）` });
  checks.push({ ok: align <= PLAN_MAX_ALIGN_MS, label: `${aName} 与 ${bName} 报价相差 ${Math.round(align / 1000)} 秒（不超过 ${PLAN_MAX_ALIGN_MS / 1000} 秒）` });
  checks.push({ ok: pair.identity !== 'mismatch', label: pair.identity === 'verified' ? '两边合约规格已核对' : pair.identity === 'review' ? '两边合约规格待人工确认' : '两边价格差距过大，规格不同' });
  for (const leg of [pair.a, pair.b]) if (leg.venue === 'var') checks.push({ ok: false, label: 'Var 没有下单接口，带 Var 腿的配对不上实盘' });
  const legs: LegPlan[] = [
    { venue: pair.a.venue, side: aSide, qty: aQtyText, expected: aExpected, limit: aLimitText, notionalUsd: aQty * aExpected, fields: legFields(pair.a, aSide, aQty, aQtyText, aLimit, aLimitText, slip) },
    { venue: pair.b.venue, side: bSide, qty: bQtyText, expected: bExpected, limit: bLimitText, notionalUsd: bQty * bExpected, fields: legFields(pair.b, bSide, bQty, bQtyText, bLimit, bLimitText, slip) },
  ];
  // 先下没有盘口、按询价成交的 Var；两腿都是限价簿时先下 A。
  const [first, second] = !isLive(pair.b.venue) ? [1, 0] : [0, 1];
  const verb = (side: 'buy' | 'sell') => side === 'buy' ? '买入' : '卖出';
  const firstLeg = legs[first], secondLeg = legs[second], firstName = VENUE_NAMES[firstLeg.venue], secondName = VENUE_NAMES[secondLeg.venue];
  const firstText = firstLeg.venue === 'var' ? `1. Var 按询价成交 ${verb(firstLeg.side)} ${firstLeg.qty}，成交价劣于 ${firstLeg.limit} 即放弃本次机会` : `1. ${firstName} 下 IOC 限价单 ${verb(firstLeg.side)} ${firstLeg.qty}，限价 ${firstLeg.limit}，未成交即放弃本次机会`;
  return {
    symbol: pair.key, direction, notionalUsd, at: sample.t, legs, checks, ready: checks.every(check => check.ok),
    sequence: [
      firstText,
      `2. 按 ${firstName} 实际成交数量${k === 1 ? '' : `（× 乘数 ${k}）`}在 ${secondName}${isLive(secondLeg.venue) && pair[second === 0 ? 'a' : 'b'].venue !== 'entropy' ? `（市场 ${pair[second === 0 ? 'a' : 'b'].market.id}）` : ''} 下 IOC 限价单 ${verb(secondLeg.side)}，限价 ${secondLeg.limit}`,
      `3. ${secondName} 未成交或部分成交：剩余数量在 ${firstName} 反向平掉，记一次单腿事件；连续两次单腿暂停该配对`,
      `4. 平仓顺序相同，${firstName} 先、${secondName} 后，${secondName} 用只减仓（reduce_only）`,
    ],
  };
}
