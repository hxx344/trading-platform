// 实盘下单预演（docs/varlighter.md 第 8 节）：按最新样本算出两腿将要提交的数量与限价，并核对 Lighter 的最小数量、
// 最小金额与精度。只生成计划，不签名、不发送；两边的下单连接器都还没有接入。
import { VENUE_NAMES, bucketOf, spreadOf, type PairInfo, type Sample } from './model.ts';
import type { Direction } from './strategy.ts';

export interface PlanCheck { ok: boolean; label: string }
export interface LegPlan {
  venue: 'var' | 'lighter'; side: 'buy' | 'sell';
  /** 基础数量（十进制字符串，已按精度向下取整）。 */ qty: string;
  /** 预期成交价与带滑点保护的限价。 */ expected: number; limit: string;
  notionalUsd: number;
  /** 交易所下单接口里的字段（预览）。 */ fields: Record<string, string | number | boolean>;
}
export interface OrderPlan {
  /** 配对键「场所:代码」。 */ symbol: string; direction: Direction; notionalUsd: number; at: number;
  legs: LegPlan[]; checks: PlanCheck[]; ready: boolean;
  /** 先下哪条腿、另一条腿失败时怎么处理。 */ sequence: string[];
}

const floorTo = (value: number, decimals: number) => { const scale = 10 ** decimals; return Math.floor(value * scale + 1e-9) / scale; };
const roundTo = (value: number, decimals: number, up: boolean) => { const scale = 10 ** decimals; return (up ? Math.ceil(value * scale - 1e-9) : Math.floor(value * scale + 1e-9)) / scale; };

/** 下单前报价须足够新、两边须对得上：Var 报价距现在与 Lighter 一档距 Var 报价时刻的上限。 */
export const PLAN_MAX_QUOTE_AGE_MS = 90_000;
/** 采集时已按 75 秒对齐，这里是兜底，防止用库里拼出的旧样本。 */
export const PLAN_MAX_ALIGN_MS = 75_000;
/** Var 报价时刻最多比本机早到 5 秒（时钟差），这段负值不算失败。 */
const CLOCK_SKEW_MS = 5_000;

export function orderPlan(pair: PairInfo, sample: Sample, direction: Direction, notionalUsd: number, maxSlippageBps: number, now: number): OrderPlan {
  const spec = pair.rh, checks: PlanCheck[] = [], venue = VENUE_NAMES[pair.venue];
  const spread = spreadOf(sample, bucketOf(notionalUsd));
  const rich = direction === 'var_rich';
  const mid = (sample.rhBid0 + sample.rhAsk0) / 2;
  const qty = floorTo(notionalUsd / mid, spec.sizeDecimals);
  const rhSide = rich ? 'buy' : 'sell', varSide = rich ? 'sell' : 'buy';
  const rhExpected = spread ? (rich ? spread.prices.rhAsk : spread.prices.rhBid) : rich ? sample.rhAsk0 : sample.rhBid0;
  const varExpected = spread ? (rich ? spread.prices.varBid : spread.prices.varAsk) : rich ? sample.varBid0 : sample.varAsk0;
  const slip = maxSlippageBps / 10_000;
  const rhLimit = roundTo(rhSide === 'buy' ? rhExpected * (1 + slip) : rhExpected * (1 - slip), spec.priceDecimals, rhSide === 'buy');
  const varLimit = varSide === 'buy' ? varExpected * (1 + slip) : varExpected * (1 - slip);
  checks.push({ ok: qty > 0, label: `按 ${venue} 数量精度 ${spec.sizeDecimals} 位取整后数量 ${qty}` });
  checks.push({ ok: qty >= spec.minBase, label: `不小于 ${venue} 最小数量 ${spec.minBase}` });
  checks.push({ ok: qty * rhExpected >= spec.minQuote, label: `不小于 ${venue} 最小金额 ${spec.minQuote} USDC` });
  checks.push({ ok: !!spread, label: spread ? `${bucketOf(notionalUsd)} 档两边都有可成交价${spread.estimated ? '（Lighter 用一档价估算）' : ''}` : `该档位缺少可成交价（100k 档需要 ${venue} 盘口快照）` });
  const quoteAge = Math.max(0, now - sample.t), ahead = sample.t - now > CLOCK_SKEW_MS, align = Math.abs(sample.t - sample.rhAt);
  checks.push({ ok: !ahead && quoteAge <= PLAN_MAX_QUOTE_AGE_MS, label: `Var 报价 ${Math.round(quoteAge / 1000)} 秒前（不超过 ${PLAN_MAX_QUOTE_AGE_MS / 1000} 秒）` });
  checks.push({ ok: align <= PLAN_MAX_ALIGN_MS, label: `${venue} 一档与 Var 报价相差 ${Math.round(align / 1000)} 秒（不超过 ${PLAN_MAX_ALIGN_MS / 1000} 秒）` });
  checks.push({ ok: pair.identity !== 'mismatch', label: pair.identity === 'verified' ? '两边合约规格已核对' : pair.identity === 'review' ? '两边合约规格待人工确认' : '两边价格差距过大，规格不同' });
  checks.push({ ok: false, label: `${venue} 下单连接器（该场所的账户、API 密钥与签名器）尚未接入` });
  checks.push({ ok: false, label: 'Var 下单接口尚未接入' });
  const base = Math.round(qty * 10 ** spec.sizeDecimals), price = Math.round(rhLimit * 10 ** spec.priceDecimals);
  const legs: LegPlan[] = [
    { venue: 'var', side: varSide, qty: qty.toFixed(spec.sizeDecimals), expected: varExpected, limit: varLimit.toPrecision(8), notionalUsd: qty * varExpected,
      fields: { underlying: pair.symbol, side: varSide, qty: qty.toFixed(spec.sizeDecimals), max_slippage: slip, order_type: 'market (RFQ)' } },
    { venue: 'lighter', side: rhSide, qty: qty.toFixed(spec.sizeDecimals), expected: rhExpected, limit: rhLimit.toFixed(spec.priceDecimals), notionalUsd: qty * rhExpected,
      fields: { market_index: spec.marketId, base_amount: base, price, is_ask: rhSide === 'sell', order_type: 'LIMIT', time_in_force: 'IMMEDIATE_OR_CANCEL', reduce_only: false } },
  ];
  return {
    symbol: pair.key, direction, notionalUsd, at: sample.t, legs, checks, ready: checks.every(check => check.ok),
    sequence: [
      `1. Var 按询价成交 ${varSide === 'buy' ? '买入' : '卖出'} ${qty}，成交价劣于 ${legs[0].limit} 即放弃本次机会`,
      `2. 按 Var 实际成交数量在 ${venue}（市场 ${spec.marketId}）下 IOC 限价单 ${rhSide === 'buy' ? '买入' : '卖出'}，限价 ${legs[1].limit}`,
      `3. ${venue} 未成交或部分成交：剩余数量在 Var 反向平掉，记一次单腿事件；连续两次单腿暂停该标的`,
      `4. 平仓顺序相同，Var 先、${venue} 后，${venue} 用只减仓（reduce_only）`,
    ],
  };
}
