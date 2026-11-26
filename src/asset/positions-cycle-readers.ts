// The workbench cycle replay (7745181) with database-backed raw trade and funding windows.
import type { Position, PositionCycle } from './positions-types.ts';
import type { Credentials } from './validation.ts';
import { POSITIONS_INVALID, PositionsPermissionError } from './positions-values.ts';
import { CYCLE_CURRENCY, CYCLE_LOOKBACK_MS, CYCLE_MISMATCH, cycleUnavailable, locateCycle, negate, newestFirst, summarizeCycle } from './positions-cycle.ts';
import type { CycleCash, CycleFill } from './positions-cycle.ts';
import { WEEK, SNAPSHOT_SKEW_MS, MAX_FILLS, TOO_MANY, CycleUnavailable, historyContext, latestOpenWindows, BINANCE_LATEST_WINDOW_MS, BYBIT_LATEST_WINDOW_MS, type HistoryOptions } from './positions-history.ts';
import { binanceFunding, binanceTrades, bybitLedger, okxHistory, type HistoryEvent, type HistoryTrade } from './history-records.ts';
export { CycleUnavailable } from './positions-history.ts';

export const CYCLE_SCOPES: Readonly<Record<string, readonly string[]>> = { binance: ['um', 'pm-um'], bybit: ['linear-usdt', 'linear-usdc'], okx: ['SWAP'] };
export const cycleSupported = (exchange: string, scope: string) => CYCLE_SCOPES[exchange]?.includes(scope) ?? false;

/** The position changed after its snapshot was taken; the caller retries with a newer snapshot. */
export class CycleRetry extends Error {}

/** `snapshotAt` is when the positions read that produced `position` started. */
export type CycleRequest = { position: Position; siblings: readonly Position[]; snapshotAt: number };
export type CycleOptions = HistoryOptions;

const signedCurrent = (position: Position) => position.side === 'short' ? negate(position.quantity) : position.quantity;

/** Reads pages newest first until the fill that opened the current position is found or the lookback is exhausted. */
async function walk(request: CycleRequest, now: number, next: () => Promise<CycleFill[] | null>) {
  const current = signedCurrent(request.position), fills: CycleFill[] = [], ids = new Set<string>();
  let located: ReturnType<typeof locateCycle> = null;
  for (let page = await next(); page; page = located ? null : await next()) {
    for (const fill of page) { if (ids.has(fill.id)) throw new Error(POSITIONS_INVALID); ids.add(fill.id); fills.push(fill); }
    if (fills.length > MAX_FILLS) throw new CycleUnavailable(TOO_MANY);
    fills.sort(newestFirst);
    located = locateCycle(current, fills);
  }
  if (fills.some(fill => fill.time >= request.snapshotAt - SNAPSHOT_SKEW_MS)) throw new CycleRetry();
  const lookbackStart = now - CYCLE_LOOKBACK_MS;
  return { current, located, fills: located ? fills.slice(0, located.index + 1) : fills,
    excludedFills: located ? fills.slice(located.index + 1) : [], since: located ? fills[located.index].time : lookbackStart };
}

type Walked = Awaited<ReturnType<typeof walk>>;
function finish(request: CycleRequest, walked: Walked, cash: CycleCash[], fundingAttributable: boolean, now: number): PositionCycle {
  return summarizeCycle({ current: walked.current, currency: request.position.pnlCurrency, fills: walked.fills, cash,
    complete: walked.located !== null, openingFraction: walked.located?.openingFraction ?? null, since: walked.since,
    fundingAttributable, notes: [], updatedAt: new Date(now).toISOString(), excludedFills: walked.excludedFills });
}
const opposed = (request: CycleRequest) => request.siblings.some(item => item.instrumentId === request.position.instrumentId && item.side !== request.position.side);

type CycleCredentials = Extract<Credentials, { exchange: 'binance' | 'bybit' | 'okx' }>;
async function venueCycle(credentials: CycleCredentials, scope: string, request: CycleRequest, options: CycleOptions): Promise<PositionCycle> {
  const { position } = request, symbol = position.instrumentId, exchange = credentials.exchange;
  if (exchange === 'bybit' && opposed(request)) throw new CycleUnavailable('同一合约同时持有多空两边，暂不统计本轮');
  if (exchange === 'okx' && request.siblings.some(item => item.id !== position.id && item.instrumentId === symbol && item.side === position.side)) {
    throw new CycleUnavailable('同一合约有多笔同向仓位，暂不统计本轮');
  }
  const ctx = historyContext(exchange, credentials, options), anchor = ctx.now(), history = options.history;
  const currency = scope === 'linear-usdc' ? 'USDC' : 'USDT', cash: CycleCash[] = [], otherTimes: number[] = [];
  let order = 0;
  function collect(events: HistoryEvent[]) {
    const fills: CycleFill[] = [];
    for (const event of events) {
      if (event.kind !== 'trade') { cash.push(event); continue; }
      if (event.positionSide !== 'net' && event.positionSide !== position.side) { otherTimes.push(event.time); continue; }
      if (event.fee === null) throw new CycleUnavailable('缺少手续费证据，本轮净额不可计算');
      if (event.feeCurrency === null) throw new CycleUnavailable('缺少手续费币种，本轮净额不可计算');
      // The Bybit ledger reports zero amounts as an empty string.
      const realizedPnl = event.realizedPnl ?? (exchange === 'bybit' ? '0' : null);
      if (realizedPnl === null) throw new Error(POSITIONS_INVALID);
      fills.push({ id: event.id, time: event.time, side: event.side, quantity: event.quantity, price: event.price,
        realizedPnl, fee: event.fee, feeCurrency: event.feeCurrency, ...(exchange === 'bybit' ? { sizeAfter: event.sizeAfter ?? '0', order: order++ } : {}) });
    }
    return fills;
  }
  const recentOkx: CycleFill[] = [];
  function okxOpening(events: readonly HistoryEvent[]) {
    const held = events.filter((event): event is HistoryTrade => event.kind === 'trade' && (event.positionSide === 'net' || event.positionSide === position.side));
    if (held.some(event => event.time >= request.snapshotAt - SNAPSHOT_SKEW_MS)) throw new CycleRetry();
    const ordered = [...recentOkx, ...held].sort(newestFirst);
    const located = locateCycle(signedCurrent(position), ordered);
    return located ? ordered[located.index].time : null;
  }
  const latest = exchange === 'bybit' ? BYBIT_LATEST_WINDOW_MS : exchange === 'okx' ? 86_400_000 : BINANCE_LATEST_WINDOW_MS;
  const next = latestOpenWindows(anchor - CYCLE_LOOKBACK_MS, anchor, latest, async (start, end) => {
    const bounds = { start, end, anchor, history };
    if (exchange === 'binance') return collect(await binanceTrades(ctx, scope, symbol, bounds));
    if (exchange === 'bybit') return collect(await bybitLedger(ctx, position.quantityUnit, currency, [symbol], bounds));
    const fills = collect(await okxHistory(ctx, symbol, bounds, false, okxOpening));
    recentOkx.push(...fills);
    return fills;
  });
  const walked = await walk(request, anchor, next);
  if (exchange === 'binance') {
    for (let start = walked.since; start <= anchor; start += WEEK) {
      cash.push(...await binanceFunding(ctx, scope, symbol, { start, end: Math.min(anchor, start + WEEK - 1), anchor, history }));
    }
  } else if (exchange === 'okx') {
    collect(await okxHistory(ctx, symbol, { start: walked.since, end: null, anchor, history }, true));
  }
  return finish(request, walked, cash, exchange === 'bybit' || (!opposed(request) && !otherTimes.some(time => time >= walked.since)), anchor);
}

/** Summarizes realized results since the position last opened from zero. Failures become an unavailable summary with a note. */
export async function readPositionCycle(credentials: Credentials, scope: string, request: CycleRequest, options: CycleOptions = {}): Promise<PositionCycle> {
  const at = () => new Date((options.now ?? Date.now)()).toISOString();
  if (!cycleSupported(credentials.exchange, scope)) return cycleUnavailable('此产品范围暂不支持统计本轮平仓', at());
  if (!request.position.pnlCurrency) return cycleUnavailable('缺少结算币种，无法统计本轮平仓', at());
  try {
    if (credentials.exchange !== 'binance' && credentials.exchange !== 'bybit' && credentials.exchange !== 'okx') return cycleUnavailable('此交易所暂不支持统计本轮平仓', at());
    return await venueCycle(credentials, scope, request, options);
  } catch (error) {
    if (error instanceof PositionsPermissionError || error instanceof CycleRetry || options.signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : '';
    return cycleUnavailable(error instanceof CycleUnavailable || message === CYCLE_MISMATCH || message === CYCLE_CURRENCY ? message
      : message === POSITIONS_INVALID ? '交易所成交数据格式无法识别，暂不统计本轮' : '本轮成交或资金费分页未完成，稍后重试', at());
  }
}
