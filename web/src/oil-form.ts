// The oil order form turned into the executor's intent (POST /api/preview), and the rules for which job actions the
// page offers. Kept free of the DOM so the server-side tests import it.

export type OilVenue = 'binance' | 'bybit';
export type OilSymbol = 'CLUSDT' | 'BZUSDT';
export type OilSide = 'long' | 'short';
export type OilPreset = 'same-exchange' | 'cross-exchange';

export interface OilForm {
  preset: OilPreset;
  /** Same venue: the venue of both legs. Cross venue: the first leg's venue; the hedge goes to the other one. */
  venue: OilVenue;
  action: 'open' | 'close';
  /** Same venue: long the spread is long BZ / short CL (on open; close takes the same choice back). */
  spread: OilSide;
  /** Same venue: the contract sent first. */
  leadSymbol: OilSymbol;
  /** Cross venue: the one contract both legs trade. */
  symbol: OilSymbol;
  /** Cross venue: the first leg's side; the hedge takes the other. */
  leadSide: OilSide;
  /** Barrels per leg, equal on both legs. */
  barrels: string;
  leadOrderType: 'market' | 'chase';
  timeoutSeconds: string;
  /** Empty: the executor's default price protection. */
  slippageBps: string;
}

export interface OilLegIntent { venue: OilVenue; symbol?: OilSymbol; side: OilSide; orderType: 'market' | 'chase'; barrels: string }
export interface OilIntent {
  market: 'oil'; preset: OilPreset; symbol?: OilSymbol; action: 'open' | 'close'; timeoutMs: number; maxSlippageBps?: number;
  legs: [OilLegIntent, OilLegIntent];
}

export const VENUE_LABEL: Record<OilVenue, string> = { binance: 'Binance', bybit: 'Bybit' };
export const SIDE_LABEL: Record<OilSide, string> = { long: '多', short: '空' };
export const SYMBOL_LABEL: Record<OilSymbol, string> = { BZUSDT: 'BZ（布伦特）', CLUSDT: 'CL（WTI）' };
const other = <T extends string>(value: T, pair: readonly [T, T]): T => (value === pair[0] ? pair[1] : pair[0]);
const opposite = (side: OilSide): OilSide => (side === 'long' ? 'short' : 'long');

export const DEFAULT_FORM: OilForm = {
  preset: 'same-exchange', venue: 'binance', action: 'open', spread: 'long', leadSymbol: 'CLUSDT', symbol: 'BZUSDT', leadSide: 'long',
  barrels: '', leadOrderType: 'market', timeoutSeconds: '60', slippageBps: '',
};

const DECIMAL = /^(0|[1-9]\d{0,11})(\.\d{1,8})?$/;
const INTEGER = /^[1-9]\d{0,6}$/;

/**
 * The intent for this form, or the first thing to fix. Only what the page can tell on its own is checked here (a number
 * where one is needed, chase only on a Bybit lead); the executor checks the rest at preview (barrel step, caps, books).
 */
export function formToIntent(form: OilForm): { intent: OilIntent } | { error: string } {
  const barrels = form.barrels.trim();
  if (!DECIMAL.test(barrels) || Number(barrels) <= 0) return { error: '每腿桶数须为正数（最多 8 位小数）' };
  const seconds = form.timeoutSeconds.trim();
  if (!INTEGER.test(seconds) || Number(seconds) < 30 || Number(seconds) > 3600) return { error: '最长执行时间须为 30–3600 秒的整数' };
  const bps = form.slippageBps.trim();
  if (bps !== '' && (!INTEGER.test(bps) || Number(bps) > 1000)) return { error: '价格保护须为 1–1000 的整数基点，或留空用默认值' };
  if (form.leadOrderType === 'chase' && form.venue !== 'bybit') return { error: '追价策略只有 Bybit 支持；Binance 首腿请选市价' };
  const common = { market: 'oil' as const, action: form.action, timeoutMs: Number(seconds) * 1000, ...(bps ? { maxSlippageBps: Number(bps) } : {}) };
  if (form.preset === 'same-exchange') {
    // Long the spread: long BZ, short CL. The first leg is whichever contract was picked to go first.
    const sideOf = (symbol: OilSymbol): OilSide => (symbol === 'BZUSDT') === (form.spread === 'long') ? 'long' : 'short';
    const hedge = other(form.leadSymbol, ['CLUSDT', 'BZUSDT'] as const);
    return { intent: { ...common, preset: 'same-exchange', legs: [
      { venue: form.venue, symbol: form.leadSymbol, side: sideOf(form.leadSymbol), orderType: form.leadOrderType, barrels },
      { venue: form.venue, symbol: hedge, side: sideOf(hedge), orderType: 'market', barrels },
    ] } };
  }
  return { intent: { ...common, preset: 'cross-exchange', symbol: form.symbol, legs: [
    { venue: form.venue, side: form.leadSide, orderType: form.leadOrderType, barrels },
    { venue: other(form.venue, ['binance', 'bybit'] as const), side: opposite(form.leadSide), orderType: 'market', barrels },
  ] } };
}

/** One line for the confirm dialog and the preview heading, e.g. "开仓 Binance 做多价差：多 BZ / 空 CL". */
export function describeIntent(intent: OilIntent): string {
  const action = intent.action === 'open' ? '开仓' : '平仓';
  const legs = intent.legs.map(leg => `${intent.preset === 'cross-exchange' ? VENUE_LABEL[leg.venue] + ' ' : ''}${SIDE_LABEL[leg.side]} ${(leg.symbol ?? intent.symbol ?? '').replace('USDT', '')}`);
  if (intent.preset === 'same-exchange') {
    const bz = intent.legs.find(leg => leg.symbol === 'BZUSDT');
    return `${action} ${VENUE_LABEL[intent.legs[0].venue]} ${bz?.side === 'long' ? '做多' : '做空'}价差：${legs.join(' / ')}`;
  }
  return `${action} 跨所 ${intent.symbol ?? ''}：${legs.join(' / ')}`;
}

/** The fields of a job the action rules read (GET /api/oil/state jobs[]). */
export interface JobFlags { status: string; stopRequested: boolean; locked: boolean; strategyPending: boolean }
/**
 * Which buttons a job gets, as the earlier page offered them: stop while it runs; for a strategy create whose answer was
 * lost, adopt / confirm-not-created / force release; for any other job left needing attention with its contracts still
 * locked, the acknowledgement that releases them.
 */
export function jobActions(job: JobFlags): { stop: boolean; strategy: boolean; acknowledge: boolean } {
  const pending = job.status === 'attention' && job.strategyPending;
  return {
    stop: (job.status === 'accepted' || job.status === 'running') && !job.stopRequested,
    strategy: pending,
    acknowledge: job.status === 'attention' && job.locked && !pending,
  };
}

export const ACTIVE_STATUSES: readonly string[] = ['accepted', 'running'];
export const CONFIRM_NOT_CREATED = '确认已在交易所核对，该合约没有本次下单产生的追价策略？';
export const CONFIRM_RELEASE = '强制释放：本次追价策略可能已在交易所创建并成交，执行器将不再认领、核对或停止它，敞口与仍在运行的策略须由你在交易所自行处理。确定释放？';
export const CONFIRM_ACKNOWLEDGE = '确认已在交易所人工处理完这笔任务的敞口与挂单？释放后这两个合约可以再次下单。';
