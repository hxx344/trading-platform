import assert from 'node:assert/strict';
import test from 'node:test';
import { createScanCatalog } from '../src/chain-arb/catalog.ts';

const signal = new AbortController().signal;
const start = 1_795_690_885_886;
const addr = (n: number) => '0x' + n.toString(16).padStart(40, '0');
const network = (name: string, addr: string, deposit_disabled = false, withdraw_disabled = false) => ({ name, addr, deposit_disabled, withdraw_disabled });
const coin = (currency: string, chains: ReturnType<typeof network>[], overrides = {}) => ({
  currency, chains, delisted: false, trade_disabled: false, deposit_disabled: false, ...overrides,
});
const pair = (base: string, overrides = {}) => ({ id: base + '_USDT', quote: 'USDT', base, type: 'normal', trade_status: 'tradable', ...overrides });
const ticker = (base: string) => ({ contract: base + '_USDT' });
const path = { currencies: '/api/v4/spot/currencies', pairs: '/api/v4/spot/currency_pairs', tickers: '/api/v4/futures/usdt/tickers' };
type Data = Record<keyof typeof path, unknown>;
const sample = (): Data => ({ currencies: [coin('AAA', [network('ETH', addr(10))])], pairs: [pair('AAA')], tickers: [ticker('OTHER')] });
function setup(data: Data) {
  const calls: string[] = [];
  let time = start;
  const read = createScanCatalog({ now: () => time, fetchImpl: async (url, init) => {
    const endpoint = new URL(url);
    assert.equal(endpoint.origin, 'https://api.gateio.ws');
    assert.equal(endpoint.search, '');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    const key = (Object.keys(path) as (keyof typeof path)[]).find(k => path[k] === endpoint.pathname);
    assert.ok(key, 'unexpected public API ' + endpoint.pathname);
    calls.push(key);
    const body = data[key];
    return body instanceof Response ? body : Response.json(body);
  } });
  return { read, calls, advance: (ms: number) => { time += ms; } };
}

test('目录保留仅永续、单向充值和多链同名代币，按代码与链稳定排序', async () => {
  const currencies = [
    coin('FUT', [network('ETH', addr(20), true, true)], { trade_disabled: true, deposit_disabled: true }),
    coin('MULTI', [network('BSC', addr(12)), network('ARBEVM', addr(12)), network('ETH', addr(30))]),
    coin('AAA', [network('ARBITRUM', addr(10), false, true)], { withdraw_disabled: true }),
    coin('WITHDRAW', [network('ETH', addr(17), true, false)]),
    coin('PAUSED', [network('ETH', addr(14))], { delisted: true }),
    coin('GLOBAL', [network('ETH', addr(15))], { deposit_disabled: true }),
    coin('FUTURE', [network('ETH', addr(16))]),
    coin('BUYONLY', [network('BSC', addr(11))]),
    coin('WRONG', [network('ETH', addr(18))]),
    coin('OFFCHAIN', [network('BASEEVM', addr(19))]),
  ];
  const pairs = [...['MULTI', 'WITHDRAW', 'PAUSED', 'GLOBAL', 'OFFCHAIN'].map(s => pair(s)), pair('AAA', { trade_status: 'sellable' }),
    pair('FUTURE', { sell_start: Math.ceil(start / 1000) + 100 }), pair('BUYONLY', { trade_status: 'buyable' }), pair('WRONG', { id: 'OTHER_USDT' })];
  const tickers = [ticker('FUT'), ticker('1000BUYONLY')];
  const expected = [
    { chain: 'arbitrum', symbol: 'AAA', address: addr(10), spot: true, perp: false },
    { chain: 'ethereum', symbol: 'FUT', address: addr(20), spot: false, perp: true },
    { chain: 'arbitrum', symbol: 'MULTI', address: addr(12), spot: true, perp: false },
    { chain: 'bsc', symbol: 'MULTI', address: addr(12), spot: true, perp: false },
    { chain: 'ethereum', symbol: 'MULTI', address: addr(30), spot: true, perp: false },
  ];
  assert.deepEqual(await setup({ currencies, pairs, tickers }).read(signal), expected);
  assert.deepEqual(await setup({ currencies: currencies.reverse(), pairs: pairs.reverse(), tickers: tickers.reverse() }).read(signal), expected);
});

test('候选剔除重复代码、同网络别名重复及不同代码相同地址，即使另一项已关闭', async () => {
  const same = addr(0xab);
  const currencies = [
    coin('SAFE', [network('ARB', addr(7)), network('ETH', addr(8))]),
    coin('AMBIG', [network('ARBEVM', addr(8)), network('ARB', ''), network('ETH', addr(6))]),
    coin('DUP', [network('ETH', addr(1))]), coin('DUP', [network('BSC', addr(2))]),
    coin('ACTIVE', [network('BSC', same)]), coin('NO-MARKET', [network('BSC', same.toUpperCase())], { delisted: true }),
    coin('COLLISION', [network('ETH', addr(3))]), coin('AMBIGOTHER', [network('ETH', addr(3)), network('ETH', addr(4))]),
    coin('DUPEPAIR', [network('ETH', addr(5))]),
  ];
  const pairs = [...currencies.map(c => pair(c.currency)), pair('DUPEPAIR', { trade_status: 'untradable' })];
  const rows = await setup({ currencies, pairs, tickers: [ticker('OTHER')] }).read(signal);
  assert.deepEqual(rows, [
    { chain: 'ethereum', symbol: 'AMBIG', address: addr(6), spot: true, perp: false },
    { chain: 'arbitrum', symbol: 'SAFE', address: addr(7), spot: true, perp: false },
    { chain: 'ethereum', symbol: 'SAFE', address: addr(8), spot: true, perp: false },
  ]);
});

test('候选剔除结算币、原生占位符、非 ERC-20 地址及不受支持的币种代码', async () => {
  const currencies = [
    coin('USDT', [network('ARB', addr(1))]), coin('RENAMED', [network('ETH', '0xdAC17F958D2ee523a2206206994597C13D831ec7'),
      network('ARBEVM', '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9'), network('BSC', '0x55d398326f99059fF775485246999027B3197955')]),
    coin('NATIVE', [network('ETH', addr(0)), network('ARB', '0x' + 'E'.repeat(40)), network('BSC', '')]),
    coin('BAD', [network('ETH', '0x1234')]), coin('混/合', [network('BSC', addr(4))]),
  ];
  assert.deepEqual(await setup({ currencies, pairs: currencies.map(c => pair(c.currency)), tickers: currencies.map(c => ticker(c.currency)) }).read(signal), []);
});

test('共享目录以三份应答中最早期限失效，过期刷新受限不回退旧缓存', async () => {
  const data = sample();
  data.currencies = Response.json(data.currencies, { headers: { Age: '290' } });
  const state = setup(data);
  const first = await Promise.all([state.read(signal), state.read(signal)]);
  assert.equal(state.calls.length, 3);
  assert.deepEqual(first[0], first[1]);
  state.advance(9999);
  await state.read(signal);
  assert.equal(state.calls.length, 3);
  state.advance(1);
  data.currencies = [coin('NEW', [network('ETH', addr(2))])];
  data.pairs = [pair('NEW')];
  data.tickers = new Response('unavailable', { status: 429 });
  await assert.rejects(state.read(signal), { status: 429 });
  assert.equal(state.calls.length, 6);
  data.tickers = [ticker('OTHER')];
  assert.deepEqual(await state.read(signal), [{ symbol: 'NEW', chain: 'ethereum', address: addr(2), spot: true, perp: false }]);
  assert.equal(state.calls.length, 9);
});

test('任一目录不完整、异常或越界均中止此次读取，失败不占用缓存', async () => {
  for (const [source, bad, error] of [
    ['currencies', [], /不完整/], ['pairs', [{ base: 'AAA' }], /不完整/], ['tickers', {}, /不完整/],
    ['currencies', [{ currency: 'AAA' }], /不完整/], ['currencies', [coin('AAA', Array(129).fill(network('ETH', addr(2))))], /不完整/],
    ['currencies', [coin('AAA', [network('ETH', addr(2))], { deposit_disabled: 'false' })], /不完整/],
    ['pairs', [pair('AAA', { trade_status: null })], /不完整/],
    ['tickers', Array(12_001).fill(ticker('AAA')), /不完整/], ['tickers', new Response('not JSON'), /不完整/],
    ['pairs', new Response('[]', { status: 206 }), /206/], ['pairs', new Response('[]', { headers: { Age: '300' } }), /过期/],
    ['pairs', new Response('[]', { headers: { 'content-length': String(6 * 1024 * 1024) } }), /过大/],
    ['currencies', new Response(' '.repeat(5 * 1024 * 1024 + 1)), /过大/],
  ] as const) {
    const data = sample(), original = data[source];
    data[source] = bad;
    const state = setup(data);
    await assert.rejects(state.read(signal), error);
    data[source] = original;
    assert.equal((await state.read(signal))[0].symbol, 'AAA');
    assert.equal(state.calls.length, 6);
  }
});

test('等待者独立取消，最后一人离开后中止上游，新请求可以重新获取', async () => {
  const first = new AbortController(), second = new AbortController(), upstream: AbortSignal[] = [];
  let stall = true;
  const read = createScanCatalog({ fetchImpl: async (url, init) => {
    const active = init.signal!;
    upstream.push(active);
    if (stall) await new Promise<void>((_, reject) => active.addEventListener('abort', () => reject(active.reason), { once: true }));
    return Response.json(url.endsWith('/currencies') ? sample().currencies : url.endsWith('/tickers') ? sample().tickers : sample().pairs);
  } });
  const a = read(first.signal), b = read(second.signal);
  assert.equal(upstream.length, 3);
  first.abort();
  await assert.rejects(a, { name: 'AbortError' });
  assert.ok(upstream.every(s => !s.aborted));
  second.abort();
  await assert.rejects(b, { name: 'AbortError' });
  assert.ok(upstream.every(s => s.aborted));
  stall = false;
  assert.equal((await read(signal))[0].symbol, 'AAA');
  assert.equal(upstream.length, 6);
});

test('目录超时中止三条上游读取并释放共享工作', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signals: AbortSignal[] = [];
  const read = createScanCatalog({ fetchImpl: async (_url, init) => {
    signals.push(init.signal!);
    return new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
  } });
  const pending = read(signal);
  t.mock.timers.tick(12_000);
  await assert.rejects(pending, /超时/);
  assert.equal(signals.length, 3);
  assert.ok(signals.every(s => s.aborted));
});
