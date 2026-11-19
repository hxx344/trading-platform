// Complete source records for both the fills display and the cycle replay. Keep the raw decimal text and both
// hedge legs. Only the exchange fields needed by either reader may be written to the account's ledger.
import { historyWindow, type AccountHistory, type HistoryRow } from './history-cache.ts';
import { bybitAmount, bybitPages, BYBIT_FILLS, binanceRange, identifier, millis, okxHistoryPages, positive, type HistoryContext } from './positions-history.ts';
import { decimal, POSITIONS_INVALID, text } from './positions-values.ts';
import { negate, type CycleCash } from './positions-cycle.ts';

export type HistoryTrade = { kind: 'trade'; id: string; time: number; symbol: string; side: 'buy' | 'sell'; positionSide: 'long' | 'short' | 'net';
  quantity: string; price: string; realizedPnl: string | null; fee: string | null; feeCurrency: string | null; sizeAfter?: string | null };
export type HistoryEvent = HistoryTrade | CycleCash;
export type HistoryBounds = { start: number; end: number | null; anchor: number; history?: AccountHistory; accept?: (events: readonly HistoryEvent[]) => void };
const fields = (row: HistoryRow, keys: string[]) => Object.fromEntries(keys.map(key => [key, row[key]]));
const optional = (value: unknown, parse = decimal) => value === undefined || value === null || value === '' ? null : parse(value);
const fee = (value: unknown, parse = decimal) => { const amount = optional(value, parse); return amount === null ? null : negate(amount); };
function unique<T>(rows: HistoryRow[], id: (row: HistoryRow) => string, parse: (row: HistoryRow) => T): T[] {
  const seen = new Set<string>();
  return rows.map(row => {
    const key = id(row);
    if (seen.has(key)) throw new Error(POSITIONS_INVALID);
    seen.add(key); return parse(row);
  });
}
const completeTrades = (rows: HistoryRow[], names: string[]) => rows.every(row => names.every(key => row[key] !== undefined && row[key] !== null && row[key] !== ''));
const BINANCE_TRADE = ['symbol', 'id', 'side', 'positionSide', 'price', 'qty', 'realizedPnl', 'commission', 'commissionAsset', 'time'];
const BINANCE_CASH = ['symbol', 'incomeType', 'income', 'asset', 'tranId', 'time'];
export function binanceTrades(ctx: HistoryContext, scope: string, symbol: string, bounds: HistoryBounds) {
  const path = scope === 'pm-um' ? '/papi/v1/um/userTrades' : '/fapi/v1/userTrades';
  return historyWindow<HistoryTrade>({ ...bounds, instrument: symbol, source: path, time: row => millis(row.time),
    fetch: async (from, to) => (await binanceRange(ctx, path, { symbol }, from, to ?? bounds.anchor, 0, to === null)).map(row => fields(row, BINANCE_TRADE)),
    complete: rows => completeTrades(rows, ['commission', 'commissionAsset', 'realizedPnl']),
    decode: rows => unique(rows, row => identifier(row.id), row => {
      if (row.symbol !== symbol || (row.side !== 'BUY' && row.side !== 'SELL') || !['BOTH', 'LONG', 'SHORT'].includes(String(row.positionSide))) throw new Error(POSITIONS_INVALID);
      return { kind: 'trade', id: identifier(row.id), time: millis(row.time), symbol, side: row.side === 'BUY' ? 'buy' : 'sell',
        positionSide: row.positionSide === 'BOTH' ? 'net' : row.positionSide === 'LONG' ? 'long' : 'short',
        quantity: positive(row.qty), price: positive(row.price), realizedPnl: optional(row.realizedPnl),
        fee: fee(row.commission), feeCurrency: row.commissionAsset ? text(row.commissionAsset) : null };
    }) });
}
export function binanceFunding(ctx: HistoryContext, scope: string, symbol: string, bounds: HistoryBounds) {
  const path = scope === 'pm-um' ? '/papi/v1/um/income' : '/fapi/v1/income';
  return historyWindow<CycleCash>({ ...bounds, instrument: symbol, source: path, time: row => millis(row.time),
    fetch: async (from, to) => (await binanceRange(ctx, path, { symbol, incomeType: 'FUNDING_FEE' }, from, to ?? bounds.anchor)).map(row => fields(row, BINANCE_CASH)),
    decode: rows => rows.map(row => {
      if (row.symbol !== symbol || row.incomeType !== 'FUNDING_FEE') throw new Error(POSITIONS_INVALID);
      // The transport may round an int64 tranId. Keep each event independently of the display id.
      const id = typeof row.tranId === 'number' && Number.isFinite(row.tranId) && row.tranId >= 0 ? String(row.tranId) : identifier(row.tranId);
      return { id, time: millis(row.time), kind: 'funding', amount: decimal(row.income), currency: text(row.asset) };
    }) });
}

const BYBIT_LEDGER = ['symbol', 'id', 'category', 'currency', 'baseCoin', 'transactionTime', 'type', 'side', 'qty', 'tradePrice', 'size', 'cashFlow', 'fee', 'funding'];
function bybitEvent(row: HistoryRow, symbol: string, base: string, currency: string, display: boolean): HistoryEvent[] {
  if (row.symbol !== symbol || row.currency !== currency || (row.baseCoin !== undefined && row.baseCoin !== base)
    || (row.category !== undefined && row.category !== 'linear')) throw new Error(POSITIONS_INVALID);
  const id = identifier(row.id), time = millis(row.transactionTime);
  if (row.type === 'SETTLEMENT') {
    if (row.funding === undefined || row.cashFlow === undefined) throw new Error(POSITIONS_INVALID);
    return [{ id: id + ':funding', time, kind: 'funding', amount: bybitAmount(row.funding), currency },
      { id: id + ':settlement', time, kind: 'realized', amount: bybitAmount(row.cashFlow), currency }];
  }
  if (!BYBIT_FILLS.has(String(row.type)) || (row.side !== 'Buy' && row.side !== 'Sell')) throw new Error(POSITIONS_INVALID);
  if (!display && (typeof row.cashFlow !== 'string' || typeof row.size !== 'string')) throw new Error(POSITIONS_INVALID);
  return [{ kind: 'trade', id, time, symbol, side: row.side === 'Buy' ? 'buy' : 'sell', positionSide: 'net', quantity: positive(bybitAmount(row.qty)),
    price: positive(bybitAmount(row.tradePrice)), realizedPnl: optional(row.cashFlow, bybitAmount), fee: fee(row.fee, bybitAmount), feeCurrency: currency, sizeAfter: optional(row.size, bybitAmount) }];
}
export async function bybitLedger(ctx: HistoryContext, base: string, currency: string, symbols: string[], bounds: HistoryBounds, display = false) {
  // The endpoint filters base and currency. USDC can return both BASEUSDC and BASEPERP in one response.
  // Coalesce identical network gaps while recording each contract's rows and coverage separately.
  const batches = new Map<string, HistoryRow[]>(), result: HistoryEvent[] = [];
  async function batch(from: number, to: number | null) {
    const key = JSON.stringify([from, to]), previous = batches.get(key);
    if (previous) return previous;
    const rows: HistoryRow[] = [];
    await bybitPages(ctx, { accountType: 'UNIFIED', category: 'linear', baseCoin: base, currency, startTime: String(from),
      ...(to === null ? {} : { endTime: String(to) }) }, row => {
      if (!BYBIT_FILLS.has(String(row.type)) && row.type !== 'SETTLEMENT') return;
      if (typeof row.symbol !== 'string' || !row.symbol) throw new Error(POSITIONS_INVALID);
      if (symbols.includes(row.symbol)) rows.push(fields(row, BYBIT_LEDGER));
    });
    batches.set(key, rows); return rows;
  }
  for (const symbol of symbols) {
    let complete = true;
    const values = await historyWindow<HistoryEvent>({ ...bounds, source: 'bybit-ledger:' + base, instrument: symbol, time: row => millis(row.transactionTime),
      fetch: async (from, to) => {
        complete = true;
        return (await batch(from, to)).filter(row => {
          if (row.symbol !== symbol) return false;
          // The display does not use settlement. An incomplete settlement cannot certify this interval for cycle PnL.
          if (display && row.type === 'SETTLEMENT') try { bybitEvent(row, symbol, base, currency, display); }
          catch { complete = false; return false; }
          return true;
        });
      },
      complete: rows => complete && rows.every(row => row.type === 'SETTLEMENT' || (row.fee !== '' && row.fee != null && typeof row.cashFlow === 'string' && typeof row.size === 'string')),
      decode: rows => unique(rows, row => identifier(row.id), row => bybitEvent(row, symbol, base, currency, display)).flat() });
    result.push(...values);
  }
  return result.sort((a, b) => b.time - a.time);
}

const OKX_TRADE = ['instId', 'billId', 'ts', 'side', 'posSide', 'fillSz', 'fillPx', 'fillPnl', 'fee', 'feeCcy'];
const OKX_CASH = ['instId', 'billId', 'ts', 'type', 'subType', 'pnl', 'ccy'];
export function okxHistory(ctx: HistoryContext, symbol: string, bounds: HistoryBounds, funding: boolean,
  opening?: (events: readonly HistoryEvent[]) => number | null) {
  const keys = funding ? OKX_CASH : OKX_TRADE;
  function decode(rows: HistoryRow[]) {
    return unique(rows, row => identifier(row.billId), (row): HistoryEvent => {
      if (row.instId !== symbol) throw new Error(POSITIONS_INVALID);
      const id = identifier(row.billId), time = millis(row.ts);
      if (funding) {
        if (row.type !== '8' || (row.subType !== '173' && row.subType !== '174')) throw new Error(POSITIONS_INVALID);
        return { id, time, kind: 'funding', amount: decimal(row.pnl), currency: text(row.ccy) };
      }
      if ((row.side !== 'buy' && row.side !== 'sell') || (row.posSide !== 'net' && row.posSide !== 'long' && row.posSide !== 'short')) throw new Error(POSITIONS_INVALID);
      return { kind: 'trade', symbol, id, time, side: row.side, positionSide: row.posSide, quantity: positive(row.fillSz), price: positive(row.fillPx),
        realizedPnl: optional(row.fillPnl), fee: optional(row.fee), feeCurrency: row.feeCcy ? text(row.feeCcy) : null };
    });
  }
  return historyWindow<HistoryEvent>({ ...bounds, instrument: symbol, source: funding ? 'okx-funding' : 'okx-fills', time: row => millis(row.ts), decode,
    stop: opening ? events => opening(events) !== null : undefined,
    complete: rows => funding || completeTrades(rows, ['fee', 'feeCcy', 'fillPnl']),
    fetch: async (from, to, newer) => {
      const next = okxHistoryPages(ctx, symbol, from, to, funding), result: HistoryRow[] = [];
      for (let page = await next(); page; page = await next()) {
        result.push(...page.map(row => fields(row, keys)));
        if (!opening || page.length < 100) continue;
        const since = opening([...newer, ...decode(result)]);
        if (since === null || since <= from || since > (to ?? bounds.anchor)) continue;
        // billId is the page cursor. Finish the narrowed time range so all bills at the opening millisecond
        // are present, even when the next billId has the same or a later timestamp.
        const rest = okxHistoryPages(ctx, symbol, since, to, false, identifier(page[page.length - 1].billId));
        const recent = result.filter(row => millis(row.ts) >= since);
        for (let extra = await rest(); extra; extra = await rest()) recent.push(...extra.map(row => fields(row, keys)));
        if (opening([...newer, ...decode(recent)]) !== null) return { rows: recent, coveredFrom: since };
      }
      return result;
    } });
}
