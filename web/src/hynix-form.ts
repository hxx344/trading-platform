// The SK hynix order form turned into the executor's intent (POST /api/preview, market 'hynix', docs/hynix.md). Kept free
// of the DOM so the server-side tests import it.
import { LEAD_TYPES, VENUE_LABEL, leadTypeAllowed, type OilLeadType, type OilPreset, type OilSide, type OilVenue } from './oil-form.ts';

export type HynixSymbol = 'SKHYUSDT' | 'SKHYNIXUSDT';
export const HYNIX_SYMBOLS: readonly HynixSymbol[] = ['SKHYUSDT', 'SKHYNIXUSDT'];
export const HYNIX_LABEL: Record<HynixSymbol, string> = { SKHYUSDT: 'ADR', SKHYNIXUSDT: '正股' };
export { LEAD_TYPES, VENUE_LABEL, leadTypeAllowed };

export interface HynixForm {
  preset: OilPreset;
  /** Same venue: the venue of both legs. Cross venue: the first leg's venue; the hedge goes to the other one. */
  venue: OilVenue;
  action: 'open' | 'close';
  /** Same venue: long the premium is long the ADR / short the ordinary share (on open; close takes the same choice back). */
  premium: OilSide;
  /** Same venue: the contract sent first. */
  leadSymbol: HynixSymbol;
  /** Cross venue: the one contract both legs trade. */
  symbol: HynixSymbol;
  /** Cross venue: the first leg's side; the hedge takes the other. */
  leadSide: OilSide;
  /** notional: equal USDT on both legs, sized at the preview's midpoints; quantity (close only): each leg's own contract quantity. */
  sizing: 'notional' | 'quantity';
  notional: string;
  /** Quantity sizing: the first and the hedge leg's quantities, in the order the legs are sent. */
  leadQuantity: string;
  hedgeQuantity: string;
  leadOrderType: OilLeadType;
  chaseLimit: string;
  timeoutSeconds: string;
  slippageBps: string;
  /** Lead market or local chase only: the lead split on its step, each batch's hedge in the planned proportion (docs/hynix.md 8.2). */
  batchCount: string;
  batchIntervalSeconds: string;
}

export interface HynixLegIntent { venue: OilVenue; symbol?: HynixSymbol; side: OilSide; orderType: OilLeadType; notional?: string; quantity?: string; limitPrice?: string }
export interface HynixIntent {
  market: 'hynix'; preset: OilPreset; symbol?: HynixSymbol; action: 'open' | 'close'; timeoutMs: number; maxSlippageBps?: number; batches?: { count: number; intervalMs: number };
  legs: [HynixLegIntent, HynixLegIntent];
}

export const DEFAULT_HYNIX_FORM: HynixForm = {
  preset: 'same-exchange', venue: 'binance', action: 'open', premium: 'short', leadSymbol: 'SKHYUSDT', symbol: 'SKHYUSDT', leadSide: 'long',
  sizing: 'notional', notional: '', leadQuantity: '', hedgeQuantity: '', leadOrderType: 'market', chaseLimit: '', timeoutSeconds: '60', slippageBps: '',
  batchCount: '1', batchIntervalSeconds: '0',
};

const DECIMAL = /^(0|[1-9]\d{0,11})(\.\d{1,8})?$/;
const INTEGER = /^[1-9]\d{0,6}$/;
const COUNT = /^\d{1,6}$/;
const other = <T extends string>(value: T, pair: readonly [T, T]): T => (value === pair[0] ? pair[1] : pair[0]);
const opposite = (side: OilSide): OilSide => (side === 'long' ? 'short' : 'long');
const positive = (value: string): boolean => DECIMAL.test(value) && Number(value) > 0;

/** The two legs this form describes, first leg first, sized as the form says; the page shows them while the form is filled. */
export function draftHynixLegs(form: HynixForm): [HynixLegIntent, HynixLegIntent] {
  const bound = form.leadOrderType === 'local-chase' && form.chaseLimit.trim() ? { limitPrice: form.chaseLimit.trim() } : {};
  const size = (quantity: string) => form.sizing === 'notional' ? { notional: form.notional.trim() } : { quantity: quantity.trim() };
  if (form.preset === 'same-exchange') {
    // Long the premium: long the ADR, short the ordinary share.
    const sideOf = (symbol: HynixSymbol): OilSide => (symbol === 'SKHYUSDT') === (form.premium === 'long') ? 'long' : 'short';
    const hedge = other(form.leadSymbol, ['SKHYUSDT', 'SKHYNIXUSDT'] as const);
    return [
      { venue: form.venue, symbol: form.leadSymbol, side: sideOf(form.leadSymbol), orderType: form.leadOrderType, ...size(form.leadQuantity), ...bound },
      { venue: form.venue, symbol: hedge, side: sideOf(hedge), orderType: 'market', ...size(form.hedgeQuantity) },
    ];
  }
  return [
    { venue: form.venue, side: form.leadSide, orderType: form.leadOrderType, ...size(form.leadQuantity), ...bound },
    { venue: other(form.venue, ['binance', 'bybit'] as const), side: opposite(form.leadSide), orderType: 'market', ...size(form.hedgeQuantity) },
  ];
}

/** The intent for this form, or the first thing to fix; the executor checks the rest at preview (steps, minimums, caps, books). */
export function hynixFormToIntent(form: HynixForm): { intent: HynixIntent } | { error: string } {
  if (form.action === 'open' && form.sizing !== 'notional') return { error: '开仓须按每腿相同的名义金额下单；按各腿数量只用于平仓' };
  if (form.sizing === 'notional') {
    if (!positive(form.notional.trim())) return { error: '每腿名义金额须为正数 USDT（最多 8 位小数）' };
  } else if (!positive(form.leadQuantity.trim()) || !positive(form.hedgeQuantity.trim())) return { error: '两腿合约数量都须为正数（最多 8 位小数）' };
  const seconds = form.timeoutSeconds.trim();
  if (!INTEGER.test(seconds) || Number(seconds) < 30 || Number(seconds) > 3600) return { error: '最长执行时间须为 30–3600 秒的整数' };
  const bps = form.slippageBps.trim();
  if (bps !== '' && (!INTEGER.test(bps) || Number(bps) > 1000)) return { error: '价格保护须为 1–1000 的整数基点，或留空用默认值' };
  if (!leadTypeAllowed(form.venue, form.leadOrderType)) return { error: form.leadOrderType === 'chase' ? '追价策略只有 Bybit 支持；Binance 首腿请选市价或本地追价' : '本地追价只用于 Binance 首腿；Bybit 首腿请选追价策略' };
  const chaseLimit = form.leadOrderType === 'local-chase' ? form.chaseLimit.trim() : '';
  if (chaseLimit !== '' && !positive(chaseLimit)) return { error: '追价界限须为正数价格，或留空用价格保护界限' };
  // The same checks as the oil form (oil-form.ts) and the executor's parseIntent.
  const count = form.batchCount.trim() || '1', interval = form.batchIntervalSeconds.trim() || '0';
  if (!INTEGER.test(count) || Number(count) > 20) return { error: '批次数须为 1–20 的整数' };
  if (!COUNT.test(interval) || Number(interval) > 600) return { error: '批次间隔须为 0–600 秒的整数' };
  if (Number(count) > 1 && form.leadOrderType === 'chase') return { error: '分批只用于首腿市价或本地追价' };
  if ((Number(count) - 1) * Number(interval) >= Number(seconds)) return { error: `${count} 批、每批间隔 ${interval} 秒，总间隔须短于最长执行时间` };
  const common = {
    market: 'hynix' as const, action: form.action, timeoutMs: Number(seconds) * 1000, ...(bps ? { maxSlippageBps: Number(bps) } : {}),
    ...(Number(count) > 1 ? { batches: { count: Number(count), intervalMs: Number(interval) * 1000 } } : {}),
  };
  const legs = draftHynixLegs({ ...form, chaseLimit });
  return { intent: form.preset === 'same-exchange' ? { ...common, preset: 'same-exchange', legs } : { ...common, preset: 'cross-exchange', symbol: form.symbol, legs } };
}

/** One line for the confirm dialog and the preview heading, e.g. "开仓 Binance 做空溢价：空 ADR / 多 正股". */
export function describeHynixIntent(intent: HynixIntent): string {
  const action = intent.action === 'open' ? '开仓' : '平仓';
  const name = (symbol: HynixSymbol | undefined) => symbol ? HYNIX_LABEL[symbol] : '';
  const legs = intent.legs.map(leg => `${intent.preset === 'cross-exchange' ? VENUE_LABEL[leg.venue] + ' ' : ''}${leg.side === 'long' ? '多' : '空'} ${name(leg.symbol ?? intent.symbol)}`);
  if (intent.preset === 'same-exchange') {
    const adr = intent.legs.find(leg => leg.symbol === 'SKHYUSDT');
    return `${action} ${VENUE_LABEL[intent.legs[0].venue]} ${adr?.side === 'long' ? '做多' : '做空'}溢价：${legs.join(' / ')}`;
  }
  return `${action} 跨所 ${name(intent.symbol)}：${legs.join(' / ')}`;
}

/** The fields that decide which contract and account each leg is: a change to any of them clears the per-leg quantities. */
export const LEG_FIELDS: readonly (keyof HynixForm)[] = ['preset', 'venue', 'action', 'premium', 'leadSymbol', 'symbol', 'leadSide'];

/** The held amounts a position read gives, by side and contract (null: that account's read has not answered). */
export interface HeldPositions { venue: string; long: Record<string, string> | null; short: Record<string, string> | null }
/**
 * Close sizing taken from the positions read: each leg closes what its account holds on that leg's side and contract. A
 * leg whose account has not been read, or holds nothing, gives the reason instead.
 */
export function closeQuantities(form: HynixForm, accounts: readonly HeldPositions[]): { leadQuantity: string; hedgeQuantity: string } | { error: string } {
  const legs = draftHynixLegs(form);
  const held = legs.map(leg => {
    const symbol = leg.symbol ?? form.symbol;
    const side = accounts.find(account => account.venue === leg.venue)?.[leg.side];
    const amount = side ? side[symbol] ?? '0' : null;
    return { leg, symbol, amount };
  });
  const missing = held.find(item => item.amount === null || !(Number(item.amount) > 0));
  if (missing) {
    const where = `${VENUE_LABEL[missing.leg.venue]} ${HYNIX_LABEL[missing.symbol]}${missing.leg.side === 'long' ? '多' : '空'}头`;
    return { error: missing.amount === null ? `${where}持仓尚未读到，请稍后再填` : `${where}没有持仓，不能按持仓平仓` };
  }
  return { leadQuantity: held[0]!.amount!, hedgeQuantity: held[1]!.amount! };
}
