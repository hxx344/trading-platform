// The gold-oil order form turned into the executor's intent (POST /api/preview, market 'goldoil', docs/goldoil.md). Kept
// free of the DOM so the server-side tests import it. Same venue: XAUUSDT against CLUSDT or BZUSDT, equal USDT notional;
// across venues: XAUUSDT only. No four legs (docs/goldoil.md 7).
import { HEDGE_TYPES, LEAD_TYPES, allowedOrderTypes, OIL_VENUES, VENUE_LABEL, hedgeOrder, hedgeOrderError, hedgeVenueFor, leadTypeAllowed, type OilHedgeType, type OilLeadType, type OilPreset, type OilSide, type OilSymbol, type OilVenue } from './oil-form.ts';

export type GoldOilSymbol = 'XAUUSDT' | OilSymbol;
export const GOLD: GoldOilSymbol = 'XAUUSDT';
/** The contracts of the positions table and the books, gold first. */
export const GOLDOIL_SYMBOLS: readonly GoldOilSymbol[] = ['XAUUSDT', 'CLUSDT', 'BZUSDT'];
export const GOLDOIL_LABEL: Record<GoldOilSymbol, string> = { XAUUSDT: 'XAU', CLUSDT: 'CL', BZUSDT: 'BZ' };
export { HEDGE_TYPES, LEAD_TYPES, OIL_VENUES, VENUE_LABEL, allowedOrderTypes, hedgeVenueFor };

export interface GoldOilForm {
  preset: OilPreset;
  /** Same venue: the venue of both legs. Cross venue: the first leg's venue. */
  venue: OilVenue;
  /** Cross venue: the hedge leg's venue, never the first leg's. */
  hedgeVenue: OilVenue;
  action: 'open' | 'close';
  /** Same venue: long the ratio is long gold / short oil (on open; close takes the same choice back). */
  ratio: OilSide;
  /** Same venue: the oil contract against gold. */
  oilSymbol: OilSymbol;
  /** Same venue: which leg is sent first. */
  lead: 'gold' | 'oil';
  /** Cross venue: the first leg's side on XAUUSDT; the hedge takes the other. */
  leadSide: OilSide;
  /** notional: equal USDT on both legs, sized at the preview's midpoints; quantity (close only): each leg's own contract quantity. */
  sizing: 'notional' | 'quantity';
  notional: string;
  /** Quantity sizing: the first and the hedge leg's quantities, in the order the legs are sent. */
  leadQuantity: string;
  hedgeQuantity: string;
  leadOrderType: OilLeadType;
  /** Four legs only, which gold-oil does not offer; kept at market so the oil form's order-type rules apply as they are. */
  peerLeadOrderType: OilLeadType;
  chaseLimit: string;
  hedgeOrderType: OilHedgeType;
  hedgeChaseSeconds: string;
  timeoutSeconds: string;
  slippageBps: string;
  /** Lead market or local chase only: the lead split on its step, each batch's hedge in the planned proportion. */
  batchCount: string;
  batchIntervalSeconds: string;
}

export interface GoldOilLegIntent { venue: OilVenue; symbol?: GoldOilSymbol; side: OilSide; orderType: OilLeadType; notional?: string; quantity?: string; limitPrice?: string; chaseTimeoutMs?: number }
export interface GoldOilIntent {
  market: 'goldoil'; preset: OilPreset; symbol?: 'XAUUSDT'; action: 'open' | 'close'; timeoutMs: number; maxSlippageBps?: number; batches?: { count: number; intervalMs: number };
  legs: [GoldOilLegIntent, GoldOilLegIntent];
}

export const DEFAULT_GOLDOIL_FORM: GoldOilForm = {
  preset: 'same-exchange', venue: 'binance', hedgeVenue: 'bybit', action: 'open', ratio: 'long', oilSymbol: 'CLUSDT', lead: 'gold', leadSide: 'long',
  sizing: 'notional', notional: '', leadQuantity: '', hedgeQuantity: '', leadOrderType: 'market', peerLeadOrderType: 'market', chaseLimit: '', hedgeOrderType: 'market', hedgeChaseSeconds: '10', timeoutSeconds: '60', slippageBps: '',
  batchCount: '1', batchIntervalSeconds: '0',
};

const DECIMAL = /^(0|[1-9]\d{0,11})(\.\d{1,8})?$/;
const INTEGER = /^[1-9]\d{0,6}$/;
const COUNT = /^\d{1,6}$/;
const opposite = (side: OilSide): OilSide => (side === 'long' ? 'short' : 'long');
const positive = (value: string): boolean => DECIMAL.test(value) && Number(value) > 0;

/** The two legs this form describes, first leg first, sized as the form says; the page shows them while the form is filled. */
export function draftGoldOilLegs(form: GoldOilForm): [GoldOilLegIntent, GoldOilLegIntent] {
  const bound = form.leadOrderType === 'local-chase' && form.chaseLimit.trim() ? { limitPrice: form.chaseLimit.trim() } : {};
  const size = (quantity: string) => form.sizing === 'notional' ? { notional: form.notional.trim() } : { quantity: quantity.trim() };
  if (form.preset === 'same-exchange') {
    // Long the ratio: long gold, short oil.
    const goldSide: OilSide = form.ratio, oilSide = opposite(form.ratio);
    const [first, second] = form.lead === 'gold' ? [[GOLD, goldSide], [form.oilSymbol, oilSide]] as const : [[form.oilSymbol, oilSide], [GOLD, goldSide]] as const;
    return [
      { venue: form.venue, symbol: first[0], side: first[1], orderType: form.leadOrderType, ...size(form.leadQuantity), ...bound },
      { venue: form.venue, symbol: second[0], side: second[1], ...hedgeOrder(form), ...size(form.hedgeQuantity) },
    ];
  }
  return [
    { venue: form.venue, side: form.leadSide, orderType: form.leadOrderType, ...size(form.leadQuantity), ...bound },
    { venue: form.hedgeVenue, side: opposite(form.leadSide), ...hedgeOrder(form), ...size(form.hedgeQuantity) },
  ];
}

/** The intent for this form, or the first thing to fix; the executor checks the rest at preview (steps, minimums, caps, books). */
export function goldOilFormToIntent(form: GoldOilForm): { intent: GoldOilIntent } | { error: string } {
  if (form.action === 'open' && form.sizing !== 'notional') return { error: '开仓须按每腿相同的名义金额下单；按各腿数量只用于平仓' };
  if (form.sizing === 'notional') {
    if (!positive(form.notional.trim())) return { error: '每腿名义金额须为正数 USDT（最多 8 位小数）' };
  } else if (!positive(form.leadQuantity.trim()) || !positive(form.hedgeQuantity.trim())) return { error: '两腿合约数量都须为正数（最多 8 位小数）' };
  const seconds = form.timeoutSeconds.trim();
  if (!INTEGER.test(seconds) || Number(seconds) < 30 || Number(seconds) > 3600) return { error: '最长执行时间须为 30–3600 秒的整数' };
  const bps = form.slippageBps.trim();
  if (bps !== '' && (!INTEGER.test(bps) || Number(bps) > 1000)) return { error: '价格保护须为 1–1000 的整数基点，或留空用默认值' };
  if (!leadTypeAllowed(form.venue, form.leadOrderType)) return { error: form.leadOrderType === 'chase' ? `追价策略只有 Bybit 支持；${VENUE_LABEL[form.venue]} 首腿请选市价或本地追价` : '本地追价只用于 Binance 或 OKX 首腿；Bybit 首腿请选追价策略' };
  if (form.preset === 'cross-exchange' && form.hedgeVenue === form.venue) return { error: '跨所组合的对冲腿须在另一个交易所' };
  const hedgeError = hedgeOrderError(form);
  if (hedgeError) return { error: hedgeError };
  const chaseLimit = form.leadOrderType === 'local-chase' ? form.chaseLimit.trim() : '';
  if (chaseLimit !== '' && !positive(chaseLimit)) return { error: '追价界限须为正数价格，或留空用价格保护界限' };
  // The same checks as the hynix form (hynix-form.ts) and the executor's parseIntent.
  const count = form.batchCount.trim() || '1', interval = form.batchIntervalSeconds.trim() || '0';
  if (!INTEGER.test(count) || Number(count) > 20) return { error: '批次数须为 1–20 的整数' };
  // One batch has no interval: whatever the hidden field holds is ignored, not refused.
  if (Number(count) > 1 && (!COUNT.test(interval) || Number(interval) > 600)) return { error: '批次间隔须为 0–600 秒的整数' };
  if (Number(count) > 1 && form.leadOrderType === 'chase') return { error: '分批只用于首腿市价或本地追价' };
  if ((Number(count) - 1) * Number(interval) >= Number(seconds)) return { error: `${count} 批、每批间隔 ${interval} 秒，总间隔须短于最长执行时间` };
  const common = {
    market: 'goldoil' as const, action: form.action, timeoutMs: Number(seconds) * 1000, ...(bps ? { maxSlippageBps: Number(bps) } : {}),
    ...(Number(count) > 1 ? { batches: { count: Number(count), intervalMs: Number(interval) * 1000 } } : {}),
  };
  const legs = draftGoldOilLegs({ ...form, chaseLimit });
  return { intent: form.preset === 'same-exchange' ? { ...common, preset: 'same-exchange', legs } : { ...common, preset: 'cross-exchange', symbol: 'XAUUSDT', legs } };
}

/** One line for the confirm dialog and the preview heading, e.g. "开仓 Binance 做多金油比：多 XAU / 空 CL". */
export function describeGoldOilIntent(intent: GoldOilIntent): string {
  const action = intent.action === 'open' ? '开仓' : '平仓';
  const legs = intent.legs.map(leg => `${intent.preset === 'cross-exchange' ? VENUE_LABEL[leg.venue] + ' ' : ''}${leg.side === 'long' ? '多' : '空'} ${GOLDOIL_LABEL[leg.symbol ?? intent.symbol ?? GOLD]}`);
  if (intent.preset === 'same-exchange') {
    const gold = intent.legs.find(leg => leg.symbol === GOLD);
    return `${action} ${VENUE_LABEL[intent.legs[0].venue]} ${gold?.side === 'long' ? '做多' : '做空'}金油比：${legs.join(' / ')}`;
  }
  return `${action} 跨所 XAU：${legs.join(' / ')}`;
}

/** The fields that decide which contract and account each leg is: a change to any of them clears the per-leg quantities. */
export const LEG_FIELDS: readonly (keyof GoldOilForm)[] = ['preset', 'venue', 'hedgeVenue', 'action', 'ratio', 'oilSymbol', 'lead', 'leadSide'];

/** The held amounts a position read gives, by side and contract (null: that account's read has not answered). */
export interface HeldPositions { venue: string; long: Record<string, string> | null; short: Record<string, string> | null }
/**
 * What the gold-oil jobs hold on each venue's account, netted over all of them (GET /api/goldoil/state goldoilHeld);
 * uncertain: the contracts, by side, where a gold-oil job's fills are unverified (an order left unknown, a strategy
 * released as possibly executed).
 */
export interface GoldOilHeld { venue: string; long: Record<string, string>; short: Record<string, string>; uncertain: { long: string[]; short: string[] } }
const DIGITS = 18n;
/** Exact decimal comparison and difference for the amounts the server sends (at most 18 decimals). */
const units = (value: string): bigint => {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole! + fraction.padEnd(Number(DIGITS), '0').slice(0, Number(DIGITS)));
};
const decimal = (value: bigint): string => {
  const text = value.toString().padStart(Number(DIGITS) + 1, '0');
  const whole = text.slice(0, -Number(DIGITS)), fraction = text.slice(-Number(DIGITS)).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
};
/**
 * Close sizing taken from the positions read: each leg closes what its account holds on that leg's side and contract,
 * but no more than the gold-oil jobs hold there. The account's CL / BZ position also carries what the oil page and its
 * rules opened (docs/goldoil.md 2), and XAU what was traded outside; that part is left, and `left` says so. A leg whose
 * account has not been read, or holds nothing of gold-oil's, gives the reason instead. A leg where a gold-oil job's fills
 * are unverified is left empty (quantity '') to be typed from the venue's position, and `left` says why.
 */
export function closeQuantities(form: GoldOilForm, accounts: readonly HeldPositions[], held: readonly GoldOilHeld[]): { leadQuantity: string; hedgeQuantity: string; left: string[] } | { error: string } {
  const legs = draftGoldOilLegs(form).map(leg => {
    const symbol = leg.symbol ?? GOLD;
    const side = accounts.find(account => account.venue === leg.venue)?.[leg.side];
    const amount = side ? side[symbol] ?? '0' : null;
    const ours = held.find(item => item.venue === leg.venue);
    const mine = ours?.[leg.side][symbol] ?? '0', uncertain = ours?.uncertain[leg.side].includes(symbol) ?? false;
    return { leg, symbol, amount, mine, uncertain, where: `${VENUE_LABEL[leg.venue]} ${GOLDOIL_LABEL[symbol]}${leg.side === 'long' ? '多' : '空'}头` };
  });
  const unread = legs.find(item => item.amount === null);
  if (unread) return { error: `${unread.where}持仓尚未读到，请稍后再填` };
  const empty = legs.find(item => !(Number(item.amount) > 0));
  if (empty) return { error: `${empty.where}没有持仓，不能按持仓平仓` };
  if (legs.every(item => item.uncertain)) return { error: '两腿都有金油任务成交未核实，请按交易所持仓手动填写' };
  const none = legs.find(item => !item.uncertain && !(Number(item.mine) > 0));
  if (none) return { error: `${none.where}没有金油任务的持仓（账户持仓 ${none.amount} 不属于金油任务），不能按持仓平仓` };
  const sized = legs.map(item => {
    if (item.uncertain) return { ...item, quantity: '', other: null };
    const account = units(item.amount!), mine = units(item.mine);
    return { ...item, quantity: decimal(account < mine ? account : mine), other: account > mine ? decimal(account - mine) : null };
  });
  const left = sized.flatMap(item => item.uncertain ? [`${item.where}有金油任务成交未核实，请按交易所持仓手动填写`] : item.other !== null ? [`${item.where}账户另有 ${item.other} 不属于金油任务，未填入`] : []);
  return { leadQuantity: sized[0]!.quantity, hedgeQuantity: sized[1]!.quantity, left };
}
