// One sync round shares each public price read between the ledger's sources (src/asset/sources/shared-reads.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { sharePublicReads } from '../src/asset/sources/shared-reads.ts';
import { COINGECKO_QUOTES, quotes, usdPrice } from '../src/asset/sources/quotes.ts';
import { syncGate } from '../src/asset/sources/gate.ts';
import { syncVariational } from '../src/asset/sources/variational.ts';
import { yuanQuote } from '../src/asset/sources/fx.ts';
import { syncBybit } from '../src/asset/sources/exchanges.ts';

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

test('资产账本：成功应答有效 30 秒，失败应答下次重试，正在等待的调用方各自回退', async () => {
  let clock = Date.now(), fail = true;
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

test('Bybit 业务错误不会占用报价缓存，旧报价在上游时刻满十五分钟后马上补取', async t => {
  const initial = Date.now();
  let clock = initial, recovering = false, sourceAt = initial - 899_000, symbol = 'WRONGUSDT';
  t.mock.method(Date, 'now', () => clock);
  const ticker = 'https://api.bybit.com/v5/market/tickers';
  const outside = venue({ [ticker]: () => Response.json(recovering
    ? { retCode: 0, time: sourceAt, result: { list: [{ symbol, lastPrice: '2' }] } }
    : { retCode: 10006, retMsg: 'busy' }) });
  const shared = sharePublicReads(outside.fetcher, () => clock);
  const rates = { USDT: { price: 1, at: new Date(initial).toISOString(), source: 'fixture' } };
  const quote = () => usdPrice('ABC', rates, shared.fetcher);
  await assert.rejects(quote(), /缺少行情/);
  recovering = true;
  await assert.rejects(quote(), /缺少行情/);
  symbol = 'ABCUSDT';
  assert.equal(await quote(), 2); assert.equal(outside.count(ticker), 3);
  clock += 500;
  assert.equal(await quote(), 2); assert.equal(outside.count(ticker), 3);
  clock += 29_499;
  await assert.rejects(quote(), /行情数据已过期/);
  assert.equal(outside.count(ticker), 4);
  sourceAt = clock;
  assert.equal(await quote(), 2); assert.equal(outside.count(ticker), 5);
});

test('估值来源拒绝的汇率边界、数字类型与货币格式均不占用后续重试', async () => {
  let valid = false;
  const cg = 'https://api.coingecko.com/', cb = 'https://api.coinbase.com/';
  const outside = venue({
    [cg]: () => Response.json({ ...gecko(), 'usd-coin': { usd: valid ? 1 : '1', last_updated_at: Math.floor(Date.now() / 1000) } }),
    [cb]: () => Response.json({ data: { currency: 'USD', rates: { USDC: '1', USDT: '1', VIRTUAL: '2', CNY: valid ? '7.1' : '1001' } } }),
  });
  const { fetcher } = sharePublicReads(outside.fetcher);
  const balance = () => syncVariational({ vrToken: 'synthetic.var.session' }, fetcher, async () => '10');
  await assert.rejects(yuanQuote(fetcher), /人民币汇率/);
  await assert.rejects(balance());
  valid = true;
  assert.equal((await yuanQuote(fetcher)).rate, 7.1);
  assert.equal((await balance()).total, 10);
  assert.equal(outside.count(cg), 2);
});

test('后续同步沿用公开报价的原始观测时间，余额仍从交易所重新读取', async () => {
  let clock = Date.now() - 120_000;
  const first = clock;
  const tickers = 'https://api.bybit.com/v5/market/tickers';
  const wallet = 'https://api.bybit.com/v5/account/wallet-balance';
  const outside = venue({
    'https://api.coingecko.com/': () => new Response(null, { status: 429 }),
    [COINBASE_USD]: () => Response.json({ data: { currency: 'USD', rates: { VIRTUAL: '0.5', USDT: '1', USDC: '1', CNY: '7' } } }),
    [tickers]: () => Response.json({ retCode: 0, result: { list: [{ lastPrice: '2' }] } }),
    'https://api.bybit.com/v5/user/query-api': () => Response.json({ retCode: 0, result: { readOnly: 1 } }),
    [wallet]: () => Response.json({ retCode: 0, result: { list: [{ accountType: 'UNIFIED', totalEquity: '0', coin: [] }] } }),
    'https://api.bybit.com/v5/asset/': () => Response.json({ retCode: 0, result: { balance: [{ coin: 'ABC', walletBalance: '3' }] } }),
  });
  const { fetcher } = sharePublicReads(outside.fetcher, () => clock);
  const prices = { USDT: { price: 1, at: new Date().toISOString(), source: 'fixture' } };
  const account = { apiKey: 'fixture', apiSecret: 'fixture', region: 'global' as const };
  const round = async () => {
    const [market, yuan, balance] = await Promise.all([quotes(fetcher), yuanQuote(fetcher, clock), syncBybit(account, prices, fetcher)]);
    assert.equal(balance.total, 6);
    return [market.VIRTUAL.at, yuan.status.fetchedAt, balance.updatedAt];
  };
  assert.deepEqual(await round(), Array(3).fill(new Date(first).toISOString()));
  clock += 29_999;
  assert.deepEqual(await round(), Array(3).fill(new Date(first).toISOString()));
  assert.deepEqual([outside.count(COINBASE_USD), outside.count(tickers), outside.count(wallet)], [1, 1, 2]);
  clock++;
  assert.deepEqual(await round(), Array(3).fill(new Date(clock).toISOString()));
  assert.deepEqual([outside.count(COINBASE_USD), outside.count(tickers), outside.count(wallet)], [2, 2, 3]);
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
