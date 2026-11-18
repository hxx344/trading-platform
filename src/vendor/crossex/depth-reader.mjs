// Native public depth adapters from the workbench CrossEx clients (7745181).
import { AppError, validIdentity, validManualIdentity } from './model.mjs';
import { publicSnapshot } from './public-snapshot.mjs';
import { D } from './money.mjs';
import { positive, failure, HYPERLIQUID_INFO, sourceTime } from './public-values.mjs';
import { readSignal } from './shared-read.mjs';

function levels(rows, unit = 1) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 20_000) throw failure('深度快照缺失或过大');
  // Preserve the exchange's ordering: invalid/duplicate levels are never silently repaired.
  return rows.slice(0, 100).map(row => {
    const price = Array.isArray(row) ? row[0] : row?.p ?? row?.px ?? row?.price;
    const quantity = Array.isArray(row) ? row[1] : row?.s ?? row?.sz ?? row?.size ?? row?.qty;
    if (!positive(price) || !positive(quantity)) throw failure('深度快照价格或数量无效');
    let baseQuantity;
    try { baseQuantity = D(quantity).times(unit).toNumber(); } catch { throw failure('深度快照价格或数量无效'); }
    if (!positive(baseQuantity)) throw failure('深度快照价格或数量无效');
    return [Number(price), baseQuantity];
  });
}

export function createDepthReader({ contract, get: read, info: postInfo, clock, WebSocketImpl, timeoutMs, signal: lifetime }) {
  return async function depth(quote, manual, request) {
    const signal = readSignal(lifetime, request);
    const get = (url, headers) => read(url, headers, signal), info = (type, coin) => postInfo(type, coin, signal);
    if (!(manual ? validManualIdentity(quote) : validIdentity(quote))) throw new AppError('不支持的深度合约');
    const { exchange, symbol } = quote, encoded = encodeURIComponent(symbol), { row, unit, assetClass } = await contract(quote, manual, false, signal);
    if (manual && (quote.nativeUnit !== D(unit).toString() || quote.assetClass !== assetClass)) throw failure('合约原生身份或数量单位已变化，请重新预览');
    let data, bids, asks, at, source, transport = 'rest';
    if (exchange === 'binance') {
      source = `https://fapi.binance.com/fapi/v1/depth?symbol=${encoded}&limit=100`;
      data = await get(source); ({ bids, asks } = data); at = data.T;
    } else if (exchange === 'bybit') {
      source = `https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${encoded}&limit=100`;
      data = await get(source);
      if (data.retCode !== 0 || data.result?.s !== symbol) throw failure('Bybit 深度响应无效');
      ({ b: bids, a: asks } = data.result); at = data.result.cts ?? data.result.ts;
    } else if (exchange === 'okx') {
      source = `https://www.okx.com/api/v5/market/books?instId=${encoded}&sz=100`;
      data = await get(source);
      if (data.code !== '0' || data.data?.length !== 1) throw failure('OKX 深度响应无效');
      ({ bids, asks, ts: at } = data.data[0]);
    } else if (exchange === 'gate') {
      source = `https://api.gateio.ws/api/v4/futures/usdt/order_book?contract=${encoded}&limit=100`;
      data = await get(source, { 'X-Gate-Size-Decimal': '1' }); ({ bids, asks } = data); at = Number(data.update) * 1000;
    } else if (exchange === 'deribit') {
      source = `https://www.deribit.com/api/v2/public/get_order_book?instrument_name=${encoded}&depth=100`;
      data = await get(source);
      if (data.error || data.result?.instrument_name !== symbol || data.result?.state !== 'open') throw failure('Deribit 深度合约或状态无效');
      ({ bids, asks, timestamp: at } = data.result);
    } else if (exchange === 'hyperliquid') {
      source = HYPERLIQUID_INFO; data = await info('l2Book', symbol);
      if (data.coin !== symbol) throw failure('Hyperliquid 深度合约不一致');
      [bids, asks] = data.levels ?? []; at = data.time;
    } else if (exchange === 'kraken') {
      source = 'wss://futures.kraken.com/ws/v1'; transport = 'ws';
      data = await publicSnapshot({ source, WebSocketImpl, timeoutMs, signal, subscription: { event: 'subscribe', feed: 'book', product_ids: [symbol] }, accept: value => {
        if (value.feed !== 'book_snapshot') return false;
        if (value.product_id !== symbol) throw failure('Kraken 深度合约不一致');
        return true;
      } });
      ({ bids, asks, timestamp: at } = data);
    } else {
      source = 'wss://mainnet.zklighter.elliot.ai/stream?readonly=true'; transport = 'ws';
      data = await publicSnapshot({ source, WebSocketImpl, timeoutMs, signal, subscription: { type: 'subscribe', channel: `order_book/${row.market_id}` }, accept: value => {
        if (value.type !== 'subscribed/order_book') return false;
        if (value.channel !== `order_book:${row.market_id}` || value.order_book?.code !== 0) throw failure('Lighter 深度合约或响应无效');
        return true;
      } });
      ({ bids, asks } = data.order_book);
      at = sourceTime(data.timestamp, clock());
      // Lighter matching-engine time is microseconds; envelope time is milliseconds.
      const changed = data.order_book.last_updated_at ?? data.last_updated_at;
      if (changed !== undefined) at = Math.min(at, sourceTime(Number(changed) / 1000, clock()));
    }
    const receivedAt = clock();
    const book = { exchange, symbol, base: quote.base, quoteCurrency: quote.quoteCurrency, at: sourceTime(at, receivedAt), receivedAt, source, transport, bids: levels(bids, unit), asks: levels(asks, unit) };
    for (const side of ['bids', 'asks']) for (let i = 1; i < book[side].length; i++) {
      if (side === 'bids' ? book[side][i][0] >= book[side][i - 1][0] : book[side][i][0] <= book[side][i - 1][0]) throw failure('深度快照价格排序异常');
    }
    if (book.bids[0][0] > book.asks[0][0]) throw failure('深度快照买卖价交叉');
    return book;
  };
}
