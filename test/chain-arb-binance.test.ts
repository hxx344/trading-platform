import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createBinanceReader } from '../src/chain-arb/binance.ts';
import { createBinanceStreams } from '../src/chain-arb/binance-streams.ts';
import { compareChainArb } from '../src/chain-arb/estimate.ts';
import type { ChainArbInput } from '../src/chain-arb/model.ts';
import { createMarketClient } from '../src/market/ipc.ts';
import { createMonitorData } from '../src/market/monitor-data.ts';
import { createMarketServer } from '../src/market/server.ts';
import { createRemoteMonitor } from '../src/service/remote-monitor.ts';
import { verifiedBuy } from './chain-arb-fake.ts';

const at = 1_795_690_000_000;
const address = '0x514910771af9ca656af840dff83e8264ecf986ca';
const input: ChainArbInput = { chain: 'ethereum', symbol: 'LINK', address, amount: '1',
  venue: 'binance', spotFeeBps: 10, perpFeeBps: 5, spotCosts: 0, perpCosts: 0 };
const signal = new AbortController().signal;
const wallet = 'https://www.binance.com/bapi/capital/v1/public/capital/getNetworkCoinAll';
const futures = 'https://fapi.binance.com/fapi/v1/';
const spotDepth = 'spot.depth', perpDepth = 'perp.depth', spotPrice = 'spot.referencePrice', perpPrice = 'linkusdt@markPrice@1s';
const spotInfo = 'spot.exchangeInfo';
const perpInfo = futures + 'exchangeInfo';
const network = { network: 'ETH', coin: 'LINK', contractAddress: address, denomination: 1, depositEnable: true,
  withdrawEnable: true, depositHideEnable: false, withdrawHideEnable: false, depositFee: '0', depositDust: '0.5' };
const currency = { coin: 'LINK', depositAllEnable: true, withdrawAllEnable: true, depositHideAll: false, withdrawHideAll: false, networkList: [network] };
const lot = { filterType: 'LOT_SIZE', minQty: '0.01', maxQty: '1000', stepSize: '0.01' };
const market = { filterType: 'MARKET_LOT_SIZE', minQty: '0', maxQty: '500', stepSize: '0' };
const spotMarket = { symbol: 'LINKUSDT', baseAsset: 'LINK', quoteAsset: 'USDT', status: 'TRADING', isSpotTradingAllowed: true,
  orderTypes: ['MARKET'], filters: [lot, market, { filterType: 'NOTIONAL', minNotional: '5', applyMinToMarket: true,
    maxNotional: '50000', applyMaxToMarket: false }] };
const perpMarket = { ...spotMarket, pair: 'LINKUSDT', contractType: 'PERPETUAL', underlyingType: 'COIN', marginAsset: 'USDT',
  onboardDate: at - 10000, deliveryDate: 4133404800000, marketTakeBound: '0.10',
  filters: [lot, { ...market, stepSize: '0.02', minQty: '0.02' }, { filterType: 'MIN_NOTIONAL', notional: '20' }] };
const book = { lastUpdateId: 103, bids: [['10.1', '1'], ['10', '2'], ['9', '3'], ['8.9', '4'], ['7', '9']] };
const priceRules = { symbolRules: [{ symbol: 'LINKUSDT', rules: [{ ruleType: 'PRICE_RANGE', askLimitMultDown: '0.8', askLimitMultUp: '1.2' }] }] };
class PublicSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  readonly frames: Record<string, unknown>[] = [];
  receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  send(frame: string) { this.frames.push(JSON.parse(frame)); }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; this.onclose?.(); }
}
const event = { e: 'depthUpdate', s: 'LINKUSDT', E: at - 710, U: 99, u: 103, a: [], b: [['10.1', '1']] };
function setup({ overrides = {}, depthEvent = event, age, walletHeaders = {} }: {
  overrides?: Record<string, unknown>; depthEvent?: typeof event; age?: () => number; walletHeaders?: Record<string, string>;
} = {}) {
  const calls: string[] = [], sockets: PublicSocket[] = [];
  const responses: Record<string, unknown> = {
    [wallet]: { code: '000000', data: [currency] }, [spotInfo]: { symbols: [spotMarket] }, [perpInfo]: { symbols: [perpMarket] },
    [spotDepth]: book, [perpDepth]: { ...book, T: at - 800, E: at - 200 },
    [spotPrice]: { symbol: 'LINKUSDT', referencePrice: '10', timestamp: at - 290 },
    ['spot.executionRules']: priceRules,
    [perpPrice]: { s: 'LINKUSDT', e: 'markPriceUpdate', p: '10', E: at - 650 }, ...overrides,
  };
  const options = { now: age ?? (() => at), fetchImpl: async (url, init) => {
    assert.ok([wallet, perpInfo].includes(url));
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error');
    assert.deepEqual(init.headers, { Accept: 'application/json' });
    assert.ok(Object.hasOwn(responses, url), url); calls.push(url);
    const value = responses[url];
    return value instanceof Response ? value : Response.json(value, { headers: url === wallet ? walletHeaders : {} });
  }, binanceSocket: url => {
    const socket = new PublicSocket();
    sockets.push(socket);
    const handle = socket.send.bind(socket);
    socket.send = raw => {
      handle(raw);
      const { id, method, params } = JSON.parse(raw);
      if (method === 'SUBSCRIBE') {
        assert.deepEqual(params, [url === 'wss://data-stream.binance.vision/stream' ? 'linkusdt@depth@100ms' : perpPrice]);
        if (params[0] === perpPrice) assert.equal(url, 'wss://fstream.binance.com/market/stream');
        calls.push(params[0]);
        socket.receive({ id, result: null });
        socket.receive({ stream: params[0], data: params[0] === perpPrice ? responses[perpPrice] : depthEvent });
      } else {
        const endpoint = url === 'wss://ws-api.binance.com:443/ws-api/v3' ? 'spot' : 'perp';
        if (endpoint === 'perp') assert.equal(url, 'wss://ws-fapi.binance.com/ws-fapi/v1');
        const name = endpoint + '.' + method;
        assert.ok(Object.hasOwn(responses, name), name);
        assert.deepEqual(params, method === 'exchangeInfo' ? { permissions: ['SPOT'], showPermissionSets: false, symbolStatus: 'TRADING' }
          : { symbol: 'LINKUSDT', ...(method === 'depth' ? { limit: 100 } : method === 'trades.recent' ? { limit: 1 } : {}) });
        calls.push(name);
        const result = responses[name];
        socket.receive(result instanceof Response ? { id, status: result.status } : { id, status: 200, result });
      }
    };
    queueMicrotask(() => socket.open());
    return socket as unknown as WebSocket;
  } } satisfies Parameters<typeof createBinanceReader>[0];
  return { reader: createBinanceReader(options), calls, responses, sockets, options };
}
test('币安匿名目录、同币双腿与页面估算使用真实盘口时间、充值下限和精确的市价规则', async () => {
  const { reader, calls } = setup();
  const [first, second] = await Promise.all([reader.catalog(signal), reader.catalog(signal)]);
  assert.equal(first, second);
  assert.deepEqual(first, [{ chain: 'ethereum', address, symbol: 'LINK', spot: true, perp: true }]);
  const value = await reader.read(input, signal);
  assert.equal(calls.filter(url => url === wallet).length, 1);
  assert.equal(value.minDeposit, '0.5'); assert.equal(value.deposit, true); assert.equal(value.withdraw, true);
  assert.deepEqual(value.spot, { at: at - 710, bids: book.bids.slice(0, 4), step: '0.01', minQuantity: '0.5', maxQuantity: '500' });
  assert.deepEqual(value.perp, { at: at - 800, bids: book.bids.slice(0, 3), step: '0.02', minQuantity: '2', maxQuantity: '500' });
  assert.ok('quantity' in compareChainArb(input, verifiedBuy({ rawQuantity: '3100', decimals: 3, at, swapGasUsdt: 0.1 }), value, at).spot);
  const below = compareChainArb(input, verifiedBuy({ rawQuantity: '49', decimals: 2, at }), value, at);
  assert.match((below.spot as { error: string }).error, /最低充值/);
  assert.deepEqual(below.perp, below.spot);
});
test('币安目录排除面额不为一或冲突的链、币、地址，错误币名不能读取盘口', async () => {
  const badWallets = [
    [{ ...currency, networkList: [{ ...network, denomination: 1_000_000 }] }],
    [currency, { ...currency, networkList: [] }],
    [{ ...currency, networkList: [network, { ...network, contractAddress: '' }] }],
    [currency, { ...currency, coin: 'OTHER', networkList: [{ ...network, coin: 'OTHER', denomination: 1000 }] }],
  ];
  for (const data of badWallets) {
    const { reader, calls } = setup({ overrides: { [wallet]: { code: '000000', data } } });
    assert.deepEqual(await reader.catalog(signal), []);
    await assert.rejects(reader.read(input, signal), /唯一匹配/);
    assert.ok(!calls.includes(spotDepth) && !calls.includes(perpDepth));
  }
  await assert.rejects(setup().reader.read({ ...input, symbol: 'OTHER' }, signal), /唯一匹配/);
});
test('币安暂停充值、未核实状态与有充值手续费的币可读取原始永续行情，两条套利路线均不可用', async () => {
  for (const patch of [{ depositEnable: false }, { depositHideEnable: true }, { depositEnable: undefined }, { depositFee: '0.01' }]) {
    const { reader, calls } = setup({ overrides: { [wallet]: { code: '000000', data: [{ ...currency, networkList: [{ ...network, ...patch }] }] } } });
    assert.deepEqual((await reader.catalog(signal)).map(c => [c.spot, c.perp]), [[false, true]]);
    const view = await reader.read(input, signal);
    assert.ok('error' in view.spot && 'bids' in view.perp);
    const quote = compareChainArb(input, verifiedBuy({ rawQuantity: '3', decimals: 0, at }), view, at);
    assert.ok('error' in quote.spot && 'error' in quote.perp);
    if ('depositEnable' in patch && patch.depositEnable === undefined) assert.equal(view.deposit, null);
    assert.ok(!calls.includes(spotDepth));
  }
});
test('币安无有效事件、快照落后、来源过期或异币的现货深度都不能作为新盘口', async () => {
  for (const depthEvent of [{ ...event, E: at - 15000 }, { ...event, E: at + 2001 }, { ...event, u: 104 },
    { ...event, s: 'BADUSDT' }, { ...event, a: [], b: [] }]) {
    const { reader } = setup({ depthEvent });
    const view = await reader.read(input, signal);
    assert.ok('error' in view.spot && 'bids' in view.perp);
  }
  const { reader } = setup({ overrides: { [perpDepth]: { ...book, T: at - 15000, E: at }, [spotDepth]: { ...book, bids: [['12.1','1'],['10','1']] } } });
  const view = await reader.read(input, signal);
  assert.match((view.spot as { error: string }).error, /保护/); assert.match((view.perp as { error: string }).error, /过期/);
});
test('币安永续市价开空保留高于标记价的买盘，在下限处截止', async () => {
  const bids = [['11.1', '3'], ['10', '3'], ['9', '1'], ['8.99', '8']];
  const { reader } = setup({ overrides: { [perpDepth]: { ...book, T: at - 100, E: at, bids } } });
  const { perp } = await reader.read(input, signal);
  assert.ok('bids' in perp);
  assert.deepEqual(perp.bids, bids.slice(0, 3));
});
test('币安按基准价验算名义下限和市场步长；不接受开仓受控、定期或退市的合约', async () => {
  const { reader } = setup({ overrides: { [perpPrice]: { s: 'LINKUSDT', e: 'markPriceUpdate', p: '9.9', E: at } } });
  const { perp } = await reader.read(input, signal);
  assert.ok('bids' in perp); assert.equal(perp.minQuantity, '2.04');
  for (const change of [{ contractType: 'CURRENT_QUARTER' }, { deliveryDate: at + 30000 }, { marginAsset: 'USDC' }, { underlyingType: 'EQUITY' }]) {
    const { reader } = setup({ overrides: { [perpInfo]: { symbols: [{ ...perpMarket, ...change }] } } });
    assert.equal((await reader.catalog(signal))[0].perp, false);
  }
  const restricted = setup({ overrides: { [perpInfo]: { symbols: [{ ...perpMarket, filters: [...perpMarket.filters, { filterType: 'POSITION_RISK_CONTROL', positionControlSide: 'SHORT' }] }] } } });
  assert.ok('error' in (await restricted.reader.read(input, signal)).perp);
});
test('币安按 HTTP 来源年龄失效，取消和限流不把旧目录或深度当作可成交', async () => {
  let time = at;
  const { reader, responses } = setup({ age: () => time, walletHeaders: { age: '13' } });
  await reader.catalog(signal);
  const snapshot = await reader.read(input, signal);
  assert.ok('at' in snapshot.spot && 'at' in snapshot.perp);
  assert.equal(snapshot.spot.at, at - 13_000);
  assert.equal(snapshot.perp.at, at - 13_000);
  time += 2000; responses[wallet] = new Response(null, { status: 429 });
  await assert.rejects(reader.catalog(signal), { status: 429 });
  await assert.rejects(reader.read(input, AbortSignal.abort()), { name: 'AbortError' });
  const limited = setup({ overrides: { [perpDepth]: new Response(null, { status: 418 }) } });
  const quote = await limited.reader.read(input, signal);
  assert.deepEqual(quote.perp, { error: '币安公开行情请求受限', rateLimited: true }); assert.ok('bids' in quote.spot);
});

test('币安无参考价时价格带不生效，名义金额按过滤器的成交均价窗口或最新一笔核实', async () => {
  const noRef = { symbol: 'LINKUSDT', referencePrice: null, timestamp: at };
  const price = { mins: 5, price: '5', closeTime: at - 900 };
  const withWindow = (avgPriceMins: number) => ({ symbols: [{ ...spotMarket, filters: [lot, market,
    { ...spotMarket.filters[2], avgPriceMins }] }] });
  for (const [ref, mins, fallback] of [[noRef, 5, 'spot.avgPrice'], [{ code: -2043 }, 0, 'spot.trades.recent']] as const) {
    const { reader, calls } = setup({ overrides: { [spotInfo]: withWindow(mins), [spotPrice]: ref,
      [fallback]: mins ? price : [{ price: '5', time: at - 900 }] } });
    const { spot } = await reader.read(input, signal);
    assert.ok('bids' in spot); assert.equal(spot.at, at - 900); assert.equal(spot.minQuantity, '1');
    assert.deepEqual(spot.bids, book.bids); assert.ok(calls.includes(fallback));
    reader.close?.();
  }
  for (const quote of [{ ...price, mins: 1 }, { ...price, closeTime: at - 15_000 }]) {
    const { reader } = setup({ overrides: { [spotInfo]: withWindow(5), [spotPrice]: noRef, 'spot.avgPrice': quote } });
    assert.ok('error' in (await reader.read(input, signal)).spot);
    reader.close?.();
  }
});

test('币安并发与重复读取共享四个匿名连接和按币订阅，关闭后释放全部', async () => {
  const { reader, sockets, calls } = setup();
  const results = await Promise.all([reader.read(input, signal), reader.read(input, signal)]);
  assert.deepEqual(results[0], results[1]); assert.ok('bids' in results[0].perp && 'bids' in results[0].spot);
  assert.deepEqual(await reader.read(input, signal), results[0]);
  assert.equal(sockets.length, 4); assert.equal(calls.filter(v => v === perpPrice).length, 1);
  reader.close?.();
  assert.ok(sockets.every(socket => socket.readyState === 3));
});

test('相邻请求按编号匹配；单次取消不影响同时读取，断连与关闭清除证据和等待', async () => {
  const sockets: PublicSocket[] = [];
  const client = createBinanceStreams(() => at, () => {
    const socket = new PublicSocket(); sockets.push(socket); return socket as unknown as WebSocket;
  });
  const cancelled = new AbortController();
  const a = client.spot('depth', { symbol: 'AAAUSDT', limit: 100 }, cancelled.signal);
  const b = client.spot('depth', { symbol: 'BBBUSDT', limit: 100 }, signal);
  sockets[0].open();
  cancelled.abort(); await assert.rejects(a, { name: 'AbortError' });
  sockets[0].receive({ id: sockets[0].frames[0].id, status: 200, result: 'A' });
  sockets[0].receive({ id: sockets[0].frames[1].id, status: 200, result: 'B' });
  assert.equal((await b).body, 'B');
  const mark = client.mark('LINKUSDT', signal);
  sockets[1].open(); sockets[1].receive({ stream: perpPrice, data: { E: at, p: '10' } });
  const proof = await mark;
  sockets[1].close();
  assert.throws(proof.check, /断开/);
  await assert.rejects(client.mark('LINKUSDT', signal));
  const pending = client.spot('depth', { symbol: 'CCCUSDT', limit: 100 }, signal);
  client.close(); await assert.rejects(pending, /断开/);
  await assert.rejects(client.spot('depth', { symbol: 'LINKUSDT' }, signal), /断开/);
});

test('仅全市场现货目录应答可超过行情帧上限', async () => {
  const socket = new PublicSocket();
  const client = createBinanceStreams(() => at, () => socket as unknown as WebSocket);
  const directory = client.directory(signal);
  socket.open();
  const large = { symbols: [], padding: 'x'.repeat(300_000) };
  socket.receive({ id: socket.frames[0].id, status: 200, result: large });
  assert.deepEqual((await directory).body, large);
  const nextDirectory = client.directory(signal);
  const book = client.spot('depth', { symbol: 'LINKUSDT', limit: 100 }, signal);
  socket.receive({ id: socket.frames[2].id, status: 200, result: large });
  await Promise.all([assert.rejects(nextDirectory, /断开/), assert.rejects(book, /断开/)]);
  client.close();
});

test('现货重复序号不能续期，断线重连后必须收到本连接的新事件', async ctx => {
  const sockets: PublicSocket[] = [];
  let clock = at, mono = 0;
  ctx.mock.method(performance, 'now', () => mono);
  const client = createBinanceStreams(() => clock, () => {
    const socket = new PublicSocket(); sockets.push(socket); return socket as unknown as WebSocket;
  });
  const key = 'linkusdt@depth@100ms', first = client.spotEvent('LINKUSDT', signal);
  const socket = sockets[0];
  socket.open(); socket.receive({ stream: key, data: event });
  assert.deepEqual((await first).body, event);
  clock += 15_000; mono += 15_000;
  socket.receive({ stream: key, data: { ...event, E: clock } });
  const stale = client.spotEvent('LINKUSDT', signal);
  socket.receive({ stream: key, data: { ...event, E: clock, u: 102 } });
  await assert.rejects(stale, /断开/);
  const next = client.spotEvent('LINKUSDT', signal);
  assert.equal(sockets.length, 2); sockets[1].open();
  const updated = { ...event, E: clock, U: 105, u: 109 };
  sockets[1].receive({ stream: key, data: updated });
  assert.deepEqual((await next).body, updated); client.close();
});

test('币安匿名目录、现货及永续盘口跨行情 IPC 读取，拒绝钱包目录和跨交易所参数', async () => {
  const { options, calls, sockets } = setup();
  const name = 'tp-binance-' + randomUUID();
  const path = process.platform === 'win32' ? '\\\\.\\pipe\\' + name : join(tmpdir(), name + '.sock');
  const WebSocketImpl = function (url: string) { return options.binanceSocket(url); } as unknown as typeof WebSocket;
  const monitor = createMonitorData({ fetchImpl: options.fetchImpl, now: options.now, WebSocketImpl });
  const server = createMarketServer({ monitor }, 'binance-test');
  const client = createMarketClient(path);
  const timeout = AbortSignal.timeout(4000);
  const params = { ...input, spotFeeBps: '10', perpFeeBps: '5', spotCosts: '0', perpCosts: '0' };
  try {
    await new Promise<void>((resolve, reject) => { server.server.once('error', reject); server.server.listen(path, resolve); });
    const remote = createRemoteMonitor(client, options.now);
    assert.deepEqual(await remote.chainArbCatalog('binance', timeout), [
      { chain: 'ethereum', address, symbol: 'LINK', spot: true, perp: true },
    ]);
    const result = await remote.chainArbBook(params, timeout);
    assert.deepEqual(result.spot, { at: at - 710, bids: book.bids.slice(0, 4), step: '0.01', minQuantity: '0.5', maxQuantity: '500' });
    assert.deepEqual(result.perp, { at: at - 800, bids: book.bids.slice(0, 3), step: '0.02', minQuantity: '2', maxQuantity: '500' });
    assert.equal(result.minDeposit, '0.5');
    const before = calls.length, directory = { rows: [network] };
    const rejectsDirectory = { ok: false, error: { message: '该行情不接受账户目录' } };
    assert.partialDeepStrictEqual(await client.call('monitor.perpetual.depositCatalog', { venue: 'binance', directory }, timeout), rejectsDirectory);
    assert.partialDeepStrictEqual(await client.call('monitor.perpetual.depositBook', {
      venue: 'binance', directory, params, scanning: false,
    }, timeout), rejectsDirectory);
    assert.partialDeepStrictEqual(await client.call('monitor.perpetual.depositBook', {
      venue: 'binance', directory: null, params: { ...params, venue: 'gate' }, scanning: false,
    }, timeout), { ok: false, error: { message: '行情交易所不一致' } });
    assert.equal(calls.length, before);
  } finally {
    client.close(); server.close();
  }
  assert.equal(sockets.length, 4); assert.ok(sockets.every(socket => socket.readyState === 3));
});

test('WS 已取消的普通错误只影响原请求；交易所限流则跨币种、跨手查和后台通道等到指定时间', async t => {
  let time = at, monotonic = 0;
  t.mock.method(performance, 'now', () => monotonic);
  const sockets: PublicSocket[] = [];
  const streams = createBinanceStreams(() => time, () => {
    const socket = new PublicSocket(); sockets.push(socket); return socket as unknown as WebSocket;
  });
  t.after(() => streams.close());
  const stop = new AbortController();
  const first = streams.spot('depth', { symbol: 'AAAUSDT' }, stop.signal);
  const other = streams.spot('depth', { symbol: 'BBBUSDT' }, signal);
  sockets[0].open();
  stop.abort();
  await assert.rejects(first, { name: 'AbortError' });
  sockets[0].receive({ id: sockets[0].frames[0].id, status: 400, error: { code: -1121 } });
  sockets[0].receive({ id: sockets[0].frames[1].id, status: 200, result: 'B' });
  assert.equal((await other).body, 'B');

  for (const status of [429, 418]) {
    const req = streams.spot('depth', { symbol: 'CCCUSDT' }, signal);
    const socket = sockets.at(-1)!;
    if (socket.readyState === 0) socket.open();
    const banUntil = time + 180_000;
    socket.receive({ id: socket.frames.at(-1)!.id, status, error: { code: -1003, data: { retryAfter: banUntil } } });
    await assert.rejects(req, { status: 429 });
    const count = sockets.length;
    time = banUntil - 1; monotonic += 179_999;
    await assert.rejects(streams.directory(signal), { status: 429 });
    await assert.rejects(streams.spotEvent('CCCUSDT', signal), { status: 429 });
    assert.equal(sockets.length, count);
    time++; monotonic++;
    const recovered = streams.spot('depth', { symbol: 'DDDUSDT' }, signal);
    const fresh = sockets.at(-1)!;
    fresh.open(); fresh.receive({ id: fresh.frames[0].id, status: 200, result: 'fresh' });
    assert.equal((await recovered).body, 'fresh');
  }
});

test('已撤销的现货参考价可附旧时间或 null，名义金额仍须有新鲜匹配窗口的均价', async () => {
  const withWindow = { symbols: [{ ...spotMarket, filters: [lot, market, { ...spotMarket.filters[2], avgPriceMins: 5 }] }] };
  const quote = async (referencePrice: string | null, timestamp: unknown, closeTime = at - 1000) => {
    const { reader } = setup({ overrides: { [spotInfo]: withWindow, [spotPrice]: { symbol: 'LINKUSDT', referencePrice, timestamp },
      'spot.avgPrice': { mins: 5, price: '5', closeTime } } });
    try { return (await reader.read(input, signal)).spot; } finally { reader.close?.(); }
  };
  for (const timestamp of [at - 86_400_000, null]) {
    const result = await quote(null, timestamp);
    assert.ok('bids' in result); assert.deepEqual(result.bids, book.bids);
    assert.equal(result.at, at - 1000); assert.equal(result.minQuantity, '1');
  }
  for (const [ref, timestamp, closeTime] of [
    ['10', at - 86_400_000, at], ['10', null, at], [null, at - 86_400_000, at - 15_000], [null, 'unknown', at],
  ] as const) assert.ok('error' in await quote(ref, timestamp, closeTime));
});

test('等待另一腿期间请求或推送连接断开，交付时只撤下对应的盘口', async () => {
  const spotRpc = 'wss://ws-api.binance.com:443/ws-api/v3', perpRpc = 'wss://ws-fapi.binance.com/ws-fapi/v1';
  for (const [venue, dropped] of [['spot', spotRpc], ['spot', 'wss://data-stream.binance.vision/stream'],
    ['perp', perpRpc], ['perp', 'wss://fstream.binance.com/market/stream']] as const) {
    const { options } = setup(), sockets = new Map<string, PublicSocket>();
    let release!: () => void, started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const reader = createBinanceReader({ ...options, binanceSocket: url => {
      const socket = options.binanceSocket(url) as unknown as PublicSocket;
      sockets.set(url, socket);
      if (url === (venue === 'spot' ? perpRpc : spotRpc)) {
        const receive = socket.receive.bind(socket);
        socket.receive = (frame: unknown) => {
          if (typeof frame === 'object' && frame !== null && 'result' in frame
            && typeof frame.result === 'object' && frame.result !== null && 'lastUpdateId' in frame.result) {
            release = () => receive(frame); started();
          } else receive(frame);
        };
      }
      return socket as unknown as WebSocket;
    } });
    try {
      const pending = reader.read(input, signal);
      await waiting;
      // The fast leg completes its promise chain while the other leg's depth response is still held.
      await new Promise<void>(resolve => setImmediate(resolve));
      sockets.get(dropped)!.close();
      release();
      const result = await pending, failed = result[venue];
      assert.ok('error' in failed); assert.match(failed.error, /断开/);
      assert.ok('bids' in result[venue === 'spot' ? 'perp' : 'spot']);
    } finally { reader.close?.(); }
  }
});

test('已发送目录取消后，其迟到的大应答只消耗原编号，当前盘口及重试目录各取自己的应答', async t => {
  const socket = new PublicSocket();
  const client = createBinanceStreams(() => at, () => socket as unknown as WebSocket);
  t.after(() => client.close());
  const stop = new AbortController();
  const old = client.directory(stop.signal);
  socket.open();
  const [original] = socket.frames;
  stop.abort();
  await assert.rejects(old, { name: 'AbortError' });
  const book = client.spot('depth', { symbol: 'LINKUSDT' }, signal);
  const retry = client.directory(signal);
  const oldReply = { id: original.id, status: 200, result: { symbols: [], padding: 'x'.repeat(300_000) } };
  socket.receive(oldReply);
  socket.receive({ id: socket.frames[1].id, status: 200, result: { lastUpdateId: 17 } });
  socket.receive({ id: socket.frames[2].id, status: 200, result: { symbols: ['LINKUSDT'] } });
  assert.deepEqual((await book).body, { lastUpdateId: 17 });
  assert.deepEqual((await retry).body, { symbols: ['LINKUSDT'] });

  // Neither the consumed old ID nor an unrelated large frame can use the next directory's allowance.
  const another = client.directory(signal);
  socket.receive(oldReply);
  await assert.rejects(another, /断开/);
});
