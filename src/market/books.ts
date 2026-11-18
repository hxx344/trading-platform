import { VenueError } from '../connector.ts';
import { VENUES, VENUE_READ_SYMBOLS, exactKeys, oneOf, parseQuote, type Quote, type Venue } from '../contracts.ts';
import { exchange, type FetchLike } from '../live/http.ts';
import { INSTRUMENT_IDS } from '../live/instrument-ids.ts';
import { amount, list, millis, record, ShapeError } from '../live/values.ts';
import { MarketError, type MarketOperations } from './protocol.ts';

/** A signed account is never needed for these fixed public top-of-book endpoints. */
export async function readPublicBook(venue: Venue, symbol: string, signal: AbortSignal, fetchImpl: FetchLike = fetch, now = Date.now, timeoutMs = 8000): Promise<Quote> {
  if (!VENUE_READ_SYMBOLS[venue].includes(symbol)) throw new VenueError('read-failed', `${symbol} 不在可读合约内`);
  const url = venue === 'binance' ? 'https://fapi.binance.com/fapi/v1/ticker/bookTicker?' + new URLSearchParams({ symbol })
    : venue === 'bybit' ? 'https://api.bybit.com/v5/market/orderbook?' + new URLSearchParams({ category: 'linear', symbol, limit: '1' })
    : 'https://www.okx.com/api/v5/market/books?' + new URLSearchParams({ instId: INSTRUMENT_IDS[symbol], sz: '1' });
  const reply = await exchange(fetchImpl, timeoutMs, { method: 'GET', url, maxBytes: 16_384 }, { signal });
  const receivedAt = now();
  if (reply.status !== 200) throw new VenueError('read-failed', `公开盘口请求失败（HTTP ${reply.status}）`);
  const value = record(reply.data, '盘口应答');
  let bid: string, ask: string, sourceTime: number;
  if (venue === 'binance') {
    if (value.symbol !== symbol) throw new ShapeError('盘口合约与请求不一致');
    bid = amount(value.bidPrice, '买一价'); ask = amount(value.askPrice, '卖一价');
    amount(value.bidQty, '买一量'); amount(value.askQty, '卖一量');
    sourceTime = millis(value.time, '盘口时间');
  } else {
    const bybit = venue === 'bybit';
    if (bybit ? value.retCode !== 0 : value.code !== '0') throw new ShapeError('交易所未返回有效盘口');
    const book = bybit ? record(value.result, '盘口') : record(list(value.data, '盘口记录', 1)[0], '盘口');
    if (bybit ? book.s !== symbol : book.instId !== undefined && book.instId !== INSTRUMENT_IDS[symbol]) throw new ShapeError('盘口合约与请求不一致');
    const level = (side: unknown, name: string) => {
      const levels = list(side, name, 1), top = list(levels[0], name, bybit ? 2 : 4);
      if (levels.length !== 1 || top.length < 2) throw new ShapeError(`${name}缺失`);
      amount(top[1], name + '数量');
      return amount(top[0], name);
    };
    bid = level(bybit ? book.b : book.bids, '买一价'); ask = level(bybit ? book.a : book.asks, '卖一价');
    sourceTime = millis(book.ts, '盘口时间');
  }
  return parseQuote({ venue, symbol, bid, ask, receivedAt, sourceTime, connectionGeneration: 0, sequence: null, complete: true }, venue, symbol);
}

export function createBookOperations(fetchImpl?: FetchLike): MarketOperations {
  return {
    async call(op, input, signal) {
      if (op !== 'books.quote') throw new MarketError('未知盘口读取', 404);
      const body = exactKeys(input, ['venue', 'symbol']);
      const venue = oneOf(body.venue, VENUES, '交易所');
      return readPublicBook(venue, oneOf(body.symbol, VENUE_READ_SYMBOLS[venue], '合约'), signal, fetchImpl);
    },
    stream() { throw new MarketError('盘口读取不支持此订阅', 404); },
  };
}
