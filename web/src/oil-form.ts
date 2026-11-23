// The oil order form turned into the executor's intent (POST /api/preview), and the rules for which job actions the
// page offers. Kept free of the DOM so the server-side tests import it.

export type OilVenue = 'binance' | 'bybit' | 'okx';
export type OilSymbol = 'CLUSDT' | 'BZUSDT';
export type OilSide = 'long' | 'short';
export type OilPreset = 'same-exchange' | 'cross-exchange';
/** The form's presets: four-leg is two same-venue pairs on two venues, sent as one POST /api/four-leg/preview (docs/oil.md 11). */
export type FormPreset = OilPreset | 'four-leg';

export interface OilForm {
  preset: FormPreset;
  /** Same venue: the venue of both legs. Cross venue: the first leg's venue. */
  venue: OilVenue;
  /** Cross venue: the hedge leg's venue, never the first leg's. Four legs: the second venue. */
  hedgeVenue: OilVenue;
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
  /** chase: Bybit's native strategy; local-chase: post-only orders the executor moves, Binance or OKX only. */
  leadOrderType: OilLeadType;
  /**
   * Four legs: the first venue's spread, unset ('') until picked and cleared whenever the preset or the venue pair changes,
   * since the same button means the opposite trade once the first venue changes (workbench TradingExecution.tsx, 7745181).
   */
  fourSpread: OilSide | '';
  /** Four legs: the second venue's lead order type (leadOrderType is the first venue's). */
  peerLeadOrderType: OilLeadType;
  /** Local chase: the highest buy / lowest sell it chases to; empty takes the preview's price protection bound. */
  chaseLimit: string;
  /** Two legs: the hedge goes to market, or chases with post-only orders on Binance or OKX (docs/oil.md 13). Four legs: market. */
  hedgeOrderType: OilHedgeType;
  /** Chasing hedge: seconds one unhedged gap may chase before the rest goes to market. */
  hedgeChaseSeconds: string;
  /** Lead split into this many batches (1: one batch), each hedged before the next; market and local chase only. */
  batchCount: string;
  batchIntervalSeconds: string;
  timeoutSeconds: string;
  /** Empty: the executor's default price protection. */
  slippageBps: string;
}

export type OilLeadType = 'market' | 'chase' | 'local-chase';
export type OilHedgeType = 'market' | 'local-chase';
export interface OilLegIntent { venue: OilVenue; symbol?: OilSymbol; side: OilSide; orderType: OilLeadType; barrels: string; limitPrice?: string; chaseTimeoutMs?: number }
export interface OilIntent {
  market: 'oil'; preset: OilPreset; symbol?: OilSymbol; action: 'open' | 'close'; timeoutMs: number; maxSlippageBps?: number;
  legs: [OilLegIntent, OilLegIntent]; batches?: { count: number; intervalMs: number };
}
/** Four legs: the first venue's lead and hedge, then the second venue's, each pair as a same-venue intent's legs. */
export interface OilFourLegIntent {
  market: 'oil'; preset: 'four-leg'; action: 'open' | 'close'; timeoutMs: number; maxSlippageBps?: number;
  legs: [OilLegIntent, OilLegIntent, OilLegIntent, OilLegIntent]; batches?: { count: number; intervalMs: number };
}
/** The lead order types a venue offers: Bybit chases with its own strategy, Binance and OKX with the executor's post-only orders. */
export const LEAD_TYPES: Record<OilVenue, readonly (readonly [OilLeadType, string])[]> = {
  binance: [['market', '市价'], ['local-chase', '本地追价']],
  bybit: [['market', '市价'], ['chase', '追价策略']],
  okx: [['market', '市价'], ['local-chase', '本地追价']],
};
export const leadTypeAllowed = (venue: OilVenue, type: OilLeadType): boolean => LEAD_TYPES[venue].some(([key]) => key === type);
/** The hedge order types a venue offers: a local chase (going to market once its time is up) on Binance and OKX only. */
export const HEDGE_TYPES: Record<OilVenue, readonly (readonly [OilHedgeType, string])[]> = {
  binance: [['market', '市价'], ['local-chase', '本地追价']],
  bybit: [['market', '市价']],
  okx: [['market', '市价'], ['local-chase', '本地追价']],
};
export const hedgeTypeAllowed = (venue: OilVenue, type: OilHedgeType): boolean => HEDGE_TYPES[venue].some(([key]) => key === type);
/** The hedge leg's venue of a two-leg form: the one venue of a same-venue pair, the other venue across venues. */
export const hedgeVenueOf = (form: { preset: FormPreset; venue: OilVenue; hedgeVenue: OilVenue }): OilVenue => form.preset === 'cross-exchange' ? form.hedgeVenue : form.venue;
/** The hedge leg's order fields; a chasing hedge carries its chase time in milliseconds. */
export const hedgeOrder = (form: { hedgeOrderType: OilHedgeType; hedgeChaseSeconds: string }): { orderType: OilHedgeType; chaseTimeoutMs?: number } =>
  form.hedgeOrderType === 'local-chase' ? { orderType: 'local-chase', chaseTimeoutMs: Number(form.hedgeChaseSeconds.trim()) * 1000 } : { orderType: 'market' };
/** The order types put back to market where the venue they now sit on does not offer them (a lead or hedge venue changed). */
export function allowedOrderTypes<T extends { preset: FormPreset; venue: OilVenue; hedgeVenue: OilVenue; leadOrderType: OilLeadType; peerLeadOrderType: OilLeadType; hedgeOrderType: OilHedgeType }>(form: T): T {
  const next = { ...form };
  if (!leadTypeAllowed(next.venue, next.leadOrderType)) next.leadOrderType = 'market';
  if (!leadTypeAllowed(next.hedgeVenue, next.peerLeadOrderType)) next.peerLeadOrderType = 'market';
  if (!hedgeTypeAllowed(hedgeVenueOf(next), next.hedgeOrderType)) next.hedgeOrderType = 'market';
  return next;
}
/** The first thing wrong with a two-leg form's hedge order fields (the executor's parsePairIntent checks the same), or null. */
export function hedgeOrderError(form: { preset: FormPreset; venue: OilVenue; hedgeVenue: OilVenue; hedgeOrderType: OilHedgeType; hedgeChaseSeconds: string }): string | null {
  if (form.hedgeOrderType !== 'local-chase') return null;
  if (!hedgeTypeAllowed(hedgeVenueOf(form), 'local-chase')) return '对冲腿本地追价只用于 Binance 或 OKX';
  const seconds = form.hedgeChaseSeconds.trim();
  return /^[1-9]\d{0,2}$/.test(seconds) && Number(seconds) <= 600 ? null : '对冲追价时限须为 1–600 秒的整数';
}

export const VENUE_LABEL: Record<OilVenue, string> = { binance: 'Binance', bybit: 'Bybit', okx: 'OKX' };
/** Venue order on the page, as the service lists them (contracts.ts VENUES). */
export const OIL_VENUES: readonly OilVenue[] = ['binance', 'bybit', 'okx'];
export const isOilVenue = (value: string): value is OilVenue => (OIL_VENUES as readonly string[]).includes(value);
/** The hedge venue a cross-venue form falls back to: the one kept if still valid, else the first other configured venue. */
export const hedgeVenueFor = (venues: readonly OilVenue[], lead: OilVenue, current: OilVenue): OilVenue | null =>
  current !== lead && venues.includes(current) ? current : venues.find(venue => venue !== lead) ?? null;
export const SIDE_LABEL: Record<OilSide, string> = { long: '多', short: '空' };
const other = <T extends string>(value: T, pair: readonly [T, T]): T => (value === pair[0] ? pair[1] : pair[0]);
const opposite = (side: OilSide): OilSide => (side === 'long' ? 'short' : 'long');

export const DEFAULT_FORM: OilForm = {
  preset: 'same-exchange', venue: 'binance', hedgeVenue: 'bybit', action: 'open', spread: 'long', leadSymbol: 'CLUSDT', symbol: 'BZUSDT', leadSide: 'long',
  barrels: '', leadOrderType: 'market', fourSpread: '', peerLeadOrderType: 'market', chaseLimit: '', hedgeOrderType: 'market', hedgeChaseSeconds: '10', batchCount: '1', batchIntervalSeconds: '0', timeoutSeconds: '60', slippageBps: '',
};

const DECIMAL = /^(0|[1-9]\d{0,11})(\.\d{1,8})?$/;
const INTEGER = /^[1-9]\d{0,6}$/;
const COUNT = /^(0|[1-9]\d{0,6})$/;

/**
 * The intent for this form, or the first thing to fix. Only what the page can tell on its own is checked here (a number
 * where one is needed, chase only on a Bybit lead, local chase only on a Binance or OKX one, two different venues across
 * venues, batches only for market and local
 * chase); the executor checks the rest at preview (barrel step, batch sizes, caps, books).
 */
export function formToIntent(form: OilForm): { intent: OilIntent } | { error: string } {
  const barrels = form.barrels.trim();
  if (!DECIMAL.test(barrels) || Number(barrels) <= 0) return { error: '每腿桶数须为正数（最多 8 位小数）' };
  const seconds = form.timeoutSeconds.trim();
  if (!INTEGER.test(seconds) || Number(seconds) < 30 || Number(seconds) > 3600) return { error: '最长执行时间须为 30–3600 秒的整数' };
  const bps = form.slippageBps.trim();
  if (bps !== '' && (!INTEGER.test(bps) || Number(bps) > 1000)) return { error: '价格保护须为 1–1000 的整数基点，或留空用默认值' };
  if (form.leadOrderType === 'chase' && !leadTypeAllowed(form.venue, 'chase')) return { error: `追价策略只有 Bybit 支持；${VENUE_LABEL[form.venue]} 首腿请选市价或本地追价` };
  if (form.leadOrderType === 'local-chase' && !leadTypeAllowed(form.venue, 'local-chase')) return { error: '本地追价只用于 Binance 或 OKX 首腿；Bybit 首腿请选追价策略' };
  if (form.preset === 'cross-exchange' && form.hedgeVenue === form.venue) return { error: '跨所组合的对冲腿须在另一个交易所' };
  if (form.preset === 'four-leg') return { error: '四腿组合用 fourLegFormToIntent' };
  const hedgeError = hedgeOrderError(form);
  if (hedgeError) return { error: hedgeError };
  const chaseLimit = form.leadOrderType === 'local-chase' ? form.chaseLimit.trim() : '';
  if (chaseLimit !== '' && (!DECIMAL.test(chaseLimit) || Number(chaseLimit) <= 0)) return { error: '追价界限须为正数价格，或留空用价格保护界限' };
  const count = form.batchCount.trim(), interval = form.batchIntervalSeconds.trim() || '0';
  if (!INTEGER.test(count) || Number(count) > 20) return { error: '批次数须为 1–20 的整数' };
  if (!COUNT.test(interval) || Number(interval) > 600) return { error: '批次间隔须为 0–600 秒的整数' };
  if (Number(count) > 1 && form.leadOrderType === 'chase') return { error: '分批只用于首腿市价或本地追价' };
  if ((Number(count) - 1) * Number(interval) >= Number(seconds)) return { error: `${count} 批、每批间隔 ${interval} 秒，总间隔须短于最长执行时间` };
  const common = {
    market: 'oil' as const, action: form.action, timeoutMs: Number(seconds) * 1000, ...(bps ? { maxSlippageBps: Number(bps) } : {}),
    ...(Number(count) > 1 ? { batches: { count: Number(count), intervalMs: Number(interval) * 1000 } } : {}),
  };
  const legs = draftLegs({ ...form, barrels, chaseLimit });
  return { intent: form.preset === 'same-exchange' ? { ...common, preset: 'same-exchange', legs } : { ...common, preset: 'cross-exchange', symbol: form.symbol, legs } };
}

/**
 * The four-leg intent for this form: the first venue (venue) takes the spread as picked, the second (hedgeVenue) the
 * opposite, both sending leadSymbol first. Each venue's pair passes the same checks as a same-venue form; no custom chase
 * limit, since one price cannot bound two venues' opposite leads.
 */
export function fourLegFormToIntent(form: OilForm): { intent: OilFourLegIntent } | { error: string } {
  if (form.hedgeVenue === form.venue) return { error: '四腿须选择两个不同的交易所' };
  if (!form.fourSpread) return { error: '请先选择方向' };
  const spread = form.fourSpread;
  const first = formToIntent({ ...form, preset: 'same-exchange', chaseLimit: '', hedgeOrderType: 'market', spread });
  if ('error' in first) return first;
  const second = formToIntent({ ...form, preset: 'same-exchange', chaseLimit: '', hedgeOrderType: 'market', venue: form.hedgeVenue, spread: opposite(spread), leadOrderType: form.peerLeadOrderType });
  if ('error' in second) return { error: `${VENUE_LABEL[form.hedgeVenue]}：${second.error}` };
  const { preset: _preset, legs, ...common } = first.intent;
  return { intent: { ...common, preset: 'four-leg', legs: [...legs, ...second.intent.legs] } };
}

/** The four legs a four-leg form describes for a picked spread, in the intent's order; the page shows them while the form is filled. */
export function draftFourLegs(form: OilForm, spread: OilSide): [OilLegIntent, OilLegIntent, OilLegIntent, OilLegIntent] {
  const same = { ...form, preset: 'same-exchange' as const, chaseLimit: '', hedgeOrderType: 'market' as const, spread };
  return [...draftLegs(same), ...draftLegs({ ...same, venue: form.hedgeVenue, spread: opposite(spread), leadOrderType: form.peerLeadOrderType })];
}

/** One line for the confirm dialog and the preview heading, e.g. "开仓四腿 Binance 做多价差 / Bybit 做空价差". */
export function describeFourLeg(intent: OilFourLegIntent): string {
  const spread = (index: number) => `${VENUE_LABEL[intent.legs[index]!.venue]} ${intent.legs.slice(index, index + 2).find(leg => leg.symbol === 'BZUSDT')?.side === 'long' ? '做多' : '做空'}价差`;
  return `${intent.action === 'open' ? '开仓' : '平仓'}四腿 ${spread(0)} / ${spread(2)}`;
}

/** The two legs this form describes, first leg first, whatever the fields hold; the page shows them while the form is filled. */
export function draftLegs(form: OilForm): [OilLegIntent, OilLegIntent] {
  const barrels = form.barrels;
  const bound = form.leadOrderType === 'local-chase' && form.chaseLimit.trim() ? { limitPrice: form.chaseLimit.trim() } : {};
  if (form.preset === 'same-exchange') {
    // Long the spread: long BZ, short CL. The first leg is whichever contract was picked to go first.
    const sideOf = (symbol: OilSymbol): OilSide => (symbol === 'BZUSDT') === (form.spread === 'long') ? 'long' : 'short';
    const hedge = other(form.leadSymbol, ['CLUSDT', 'BZUSDT'] as const);
    return [
      { venue: form.venue, symbol: form.leadSymbol, side: sideOf(form.leadSymbol), orderType: form.leadOrderType, barrels, ...bound },
      { venue: form.venue, symbol: hedge, side: sideOf(hedge), ...hedgeOrder(form), barrels },
    ];
  }
  return [
    { venue: form.venue, side: form.leadSide, orderType: form.leadOrderType, barrels, ...bound },
    { venue: form.hedgeVenue, side: opposite(form.leadSide), ...hedgeOrder(form), barrels },
  ];
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
