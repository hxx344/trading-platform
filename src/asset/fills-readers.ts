// The workbench market replay (7745181) reads fixed contracts even after a position closes.
// The display and the current-cycle calculation now share the venue's complete raw history.
import type { Credentials } from './validation.ts';
import { FILL_MARKETS, type FillMarket, type ReadFill } from './fills-types.ts';
import { POSITIONS_INVALID } from './positions-values.ts';
import { cycleSupported } from './positions-cycle-readers.ts';
import { historyContext, latestOpenWindows, MAX_FILLS, BINANCE_LATEST_WINDOW_MS, BYBIT_LATEST_WINDOW_MS, type HistoryOptions } from './positions-history.ts';
import { binanceTrades, bybitLedger, okxHistory, type HistoryEvent, type HistoryTrade } from './history-records.ts';

export type FillsRequest = { market: FillMarket; start: number; end: number };
export const fillsSupported = (exchange: string, scope: string, _market: FillMarket) => cycleSupported(exchange, scope);

export type FillHistoryOptions = HistoryOptions & { verify?: (fill: ReadFill) => void };
export async function readFills(credentials: Credentials, scope: string, request: FillsRequest, options: FillHistoryOptions = {}): Promise<ReadFill[]> {
  const exchange = credentials.exchange;
  if (!fillsSupported(exchange, scope, request.market) || (exchange !== 'binance' && exchange !== 'bybit' && exchange !== 'okx')) throw new Error(POSITIONS_INVALID);
  const ctx = historyContext(exchange, credentials, options), fills: ReadFill[] = [];
  const currency = scope === 'linear-usdc' ? 'USDC' : 'USDT';
  let order = 0;
  for (const base of FILL_MARKETS[request.market]) {
    const project = (event: HistoryTrade): ReadFill => {
      const { id, symbol, time, side, positionSide, quantity, price, realizedPnl, fee, feeCurrency } = event;
      return { id: exchange === 'binance' ? symbol + ':' + id : id, symbol, base, time: new Date(time).toISOString(),
        side, positionSide, quantity, quantityUnit: exchange === 'okx' ? '张' : base, price, priceCurrency: currency, realizedPnl, fee, feeCurrency,
        ...(exchange === 'bybit' ? { sizeAfter: event.sizeAfter } : {}) };
    };
    const verify = options.verify;
    const accept = verify && ((events: readonly HistoryEvent[]) => { for (const event of events) if (event.kind === 'trade') verify(project(event)); });
    const latest = exchange === 'bybit' ? BYBIT_LATEST_WINDOW_MS : exchange === 'okx' ? request.end - request.start : BINANCE_LATEST_WINDOW_MS;
    const next = latestOpenWindows(request.start, request.end, latest, async (start, end) => {
      const bounds = { start, end, anchor: request.end, history: options.history, accept };
      if (exchange === 'binance') return binanceTrades(ctx, scope, base + 'USDT', bounds);
      if (exchange === 'okx') return okxHistory(ctx, base + '-USDT-SWAP', bounds, false);
      return bybitLedger(ctx, base, currency, currency === 'USDC' ? [base + 'USDC', base + 'PERP'] : [base + 'USDT'], bounds, true);
    });
    for (let page = await next(); page; page = await next()) for (const event of page) {
      if (event.kind !== 'trade') continue;
      const fill = project(event);
      if (exchange === 'bybit') fill.order = order++;
      fills.push(fill);
      if (fills.length > MAX_FILLS) throw new Error(POSITIONS_INVALID);
    }
  }
  return fills;
}
