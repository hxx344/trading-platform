// One sync round shares each public price read between the ledger's sources (src/asset/sources/shared-reads.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { sharePublicReads } from '../src/asset/sources/shared-reads.ts';
import { COINGECKO_QUOTES, quotes, usdPrice } from '../src/asset/sources/quotes.ts';
import { syncGate } from '../src/asset/sources/gate.ts';
import { syncVariational } from '../src/asset/sources/variational.ts';
import { yuanQuote } from '../src/asset/sources/fx.ts';

const COINBASE_USD = 'https://api.coinbase.com/v2/exchange-rates?currency=USD';
const gecko = () => { const at = Math.floor(Date.now() / 1000); return { 'virtual-protocol': { usd: 2, last_updated_at: at }, tether: { usd: 1, last_updated_at: at }, 'usd-coin': { usd: 0.999, last_updated_at: at } }; };
function venue(answers: Record<string, () => Response | Promise<Response>>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    for (const [prefix, answer] of Object.entries(answers)) if (url.startsWith(prefix)) return answer();
    return new Response('', { status: 404 });
  }) as typeof fetch;
  return { calls, fetcher, count: (prefix: string) => calls.filter(call => call.url.startsWith(prefix)).length };
}

test('资产账本：一轮同步里总行情、Gate、Var 共用一次 CoinGecko 读取，同一币种的 Bybit 现货价只读一次', async () => {
  const outside = venue({
    'https://api.coingecko.com/': () => Response.json(gecko()),
    'https://api.bybit.com/v5/market/tickers': () => Response.json({ retCode: 0, result: { list: [{ lastPrice: '3' }] } }),
    'https://api.gateio.ws/': () => Response.json({ total: { amount: '120.5', currency: 'USDT' }, details: { spot: { amount: '100', currency: 'USDT' }, finance: { amount: '25.5', currency: 'USDT' }, futures: { amount: '-5', currency: 'USDT' } } }),
  });
  const { fetcher } = sharePublicReads(outside.fetcher);
  const [prices, gate, variational] = await Promise.all([
    quotes(fetcher), syncGate({ apiKey: 'k', apiSecret: 's' }, fetcher), syncVariational({ vrToken: 'synthetic.var.session' }, fetcher, async () => '10'),
  ]);
  assert.deepEqual([prices.USDT.price, gate.total, variational.total], [1, 120.5, 9.99]);
  assert.equal(outside.count('https://api.coingecko.com/'), 1);
  assert.equal(outside.calls.find(call => call.url.startsWith('https://api.coingecko.com/'))!.url, COINGECKO_QUOTES);
  assert.deepEqual(await Promise.all([usdPrice('ABC', prices, fetcher), usdPrice('ABC', prices, fetcher), usdPrice('XYZ', prices, fetcher)]), [3, 3, 3]);
  assert.equal(outside.count('https://api.bybit.com/'), 2);
  // The signed Gate read went straight through with its own headers.
  const signed = outside.calls.find(call => call.url.startsWith('https://api.gateio.ws/'))!;
  assert.ok(new Headers(signed.init.headers).has('KEY'));
});

test('资产账本：共用的应答只在本轮内有效，最长 30 秒；失败的应答不保留，等它的调用方各自按原样失败并回退', async () => {
  let clock = 1_000_000, fail = true;
  const outside = venue({
    'https://api.coingecko.com/': () => fail ? new Response('busy', { status: 429 }) : Response.json(gecko()),
    [COINBASE_USD]: () => Response.json({ data: { currency: 'USD', rates: { VIRTUAL: '0.5', USDT: '1', USDC: '1', CNY: '7.1' } } }),
  });
  const shared = sharePublicReads(outside.fetcher, () => clock);
  // Both callers wait for the one refused CoinGecko read, then share the Coinbase fallback with the yuan rate.
  const [first, second, yuan] = await Promise.all([quotes(shared.fetcher), quotes(shared.fetcher), yuanQuote(shared.fetcher, clock)]);
  assert.deepEqual([first.VIRTUAL.price, second.VIRTUAL.source, yuan.rate], [2, 'Coinbase / USD（获取时间）', 7.1]);
  assert.deepEqual([outside.count('https://api.coingecko.com/'), outside.count(COINBASE_USD)], [1, 1]);
  fail = false;
  assert.equal((await quotes(shared.fetcher)).VIRTUAL.source, 'CoinGecko / USD');
  await quotes(shared.fetcher);
  assert.equal(outside.count('https://api.coingecko.com/'), 2);
  clock += 29_999; await quotes(shared.fetcher);
  assert.equal(outside.count('https://api.coingecko.com/'), 2);
  clock += 1; await quotes(shared.fetcher);
  assert.equal(outside.count('https://api.coingecko.com/'), 3);
  shared.reset(); await quotes(shared.fetcher);
  assert.equal(outside.count('https://api.coingecko.com/'), 4);
});

test('资产账本：带请求体或其它请求头的请求、清单外的地址不共用；等待中的调用方按自己的信号结束，不影响其它调用方', async () => {
  let release: (response: Response) => void = () => undefined;
  const outside = venue({
    'https://api.coingecko.com/': () => new Promise<Response>(resolve => { release = resolve; }),
    'https://api.hyperliquid.xyz/info': () => Response.json({ ok: true }),
  });
  const { fetcher } = sharePublicReads(outside.fetcher);
  await Promise.all([fetcher('https://api.hyperliquid.xyz/info', { method: 'POST', body: '{}' }), fetcher('https://api.hyperliquid.xyz/info', { method: 'POST', body: '{}' })]);
  await Promise.all([fetcher(COINBASE_USD, { headers: { 'X-Key': 'a' } }), fetcher(COINBASE_USD, { headers: { 'X-Key': 'a' } })]);
  assert.deepEqual([outside.count('https://api.hyperliquid.xyz/'), outside.count(COINBASE_USD)], [2, 2]);
  const impatient = new AbortController();
  const stopped = fetcher(COINGECKO_QUOTES, { signal: impatient.signal }), waiting = fetcher(COINGECKO_QUOTES, {});
  impatient.abort();
  await assert.rejects(stopped, { name: 'AbortError' });
  release(Response.json(gecko()));
  assert.equal((await (await waiting).json() as { tether: { usd: number } }).tether.usd, 1);
  assert.equal(outside.count('https://api.coingecko.com/'), 1);
});
