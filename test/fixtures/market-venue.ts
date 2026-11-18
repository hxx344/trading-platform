// Independent market process for the outage test. Only public venue replies are substituted.
import { createMarketServer } from '../../src/market/server.ts';
import { createBookOperations } from '../../src/market/books.ts';

const [socket, mode] = process.argv.slice(2);
let sourceOffset = mode === 'stale' ? -120_000 : 0;
const books = createBookOperations(async input => {
  const url = new URL(input), symbol = url.searchParams.get('symbol'), ts = Date.now() + sourceOffset;
  const oil = symbol === 'BZUSDT';
  if (url.pathname === '/fapi/v1/ticker/bookTicker') return Response.json({ symbol, bidPrice: oil ? '74.10' : '70.00', askPrice: oil ? '74.12' : '70.02', bidQty: '10', askQty: '10', time: ts });
  if (url.pathname === '/v5/market/orderbook') return Response.json({ retCode: 0, result: { s: symbol, b: [[oil ? '74.15' : '70.05', '10']], a: [[oil ? '74.17' : '70.07', '10']], ts } });
  throw new Error('测试未允许此行情读取');
});
const market = createMarketServer({ books }, 'test');
market.server.listen(socket, () => process.send?.('ready'));
process.on('message', value => {
  if (typeof value === 'number') { sourceOffset = value; process.send?.('changed'); }
});
process.on('disconnect', () => market.close());
