import assert from 'node:assert/strict';
import test from 'node:test';
import { createBinanceReader } from '../src/chain-arb/binance.ts';
import { compareChainArb } from '../src/chain-arb/estimate.ts';
import type { ChainArbInput } from '../src/chain-arb/model.ts';

const at = 1_795_690_000_000;
const address = '0x514910771af9ca656af840dff83e8264ecf986ca';
const input: ChainArbInput = { chain: 'ethereum', symbol: 'LINK', address, amount: '1',
  venue: 'binance', spotFeeBps: 10, perpFeeBps: 5, spotCosts: 0, perpCosts: 0 };
const signal = new AbortController().signal;
const wallet = 'https://www.binance.com/bapi/capital/v1/public/capital/getNetworkCoinAll';
const spot = 'https://api.binance.com/api/v3/', futures = 'https://fapi.binance.com/fapi/v1/';
const query = '?symbol=LINKUSDT', depth = 'depth' + query + '&limit=100';
const spotInfo = spot + 'exchangeInfo?permissions=SPOT&showPermissionSets=false&symbolStatus=TRADING';
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
const event = { e: 'depthUpdate', s: 'LINKUSDT', E: at - 710, U: 99, u: 103, a: [], b: [['10.1', '1']] };
function setup({ overrides = {}, depthEvent = event, age, walletHeaders = {} }: {
  overrides?: Record<string, unknown>; depthEvent?: typeof event; age?: () => number; walletHeaders?: Record<string, string>;
} = {}) {
  const calls: string[] = [];
  const responses: Record<string, unknown> = {
    [wallet]: { code: '000000', data: [currency] }, [spotInfo]: { symbols: [spotMarket] }, [perpInfo]: { symbols: [perpMarket] },
    [spot + depth]: book, [futures + depth]: { ...book, T: at - 800, E: at - 200 },
    [spot + 'referencePrice' + query]: { symbol: 'LINKUSDT', referencePrice: '10', timestamp: at - 290 },
    [spot + 'executionRules' + query]: priceRules,
    [futures + 'premiumIndex' + query]: { symbol: 'LINKUSDT', markPrice: '10', time: at - 650 }, ...overrides,
  };
  const reader = createBinanceReader({ now: age ?? (() => at), fetchImpl: async (url, init) => {
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error');
    assert.deepEqual(init.headers, { Accept: 'application/json' });
    assert.ok(Object.hasOwn(responses, url), url); calls.push(url);
    const value = responses[url];
    return value instanceof Response ? value : Response.json(value, { headers: url === wallet ? walletHeaders : {} });
  }, spotDepthEvent: async (pair, life) => { assert.equal(pair, 'LINKUSDT'); life.throwIfAborted(); return depthEvent; } });
  return { reader, calls, responses };
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
  assert.ok('quantity' in compareChainArb(input, { rawQuantity: '3100', decimals: 3, at, swapGasUsdt: 0.1 }, value, at).spot);
  assert.match((compareChainArb(input, { rawQuantity: '49', decimals: 2, at }, value, at).spot as { error: string }).error, /最低充值/);
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
    assert.ok(!calls.includes(spot + depth) && !calls.includes(futures + depth));
  }
  await assert.rejects(setup().reader.read({ ...input, symbol: 'OTHER' }, signal), /唯一匹配/);
});
test('币安暂停充值、未核实状态与有充值手续费的币仅保留永续', async () => {
  for (const patch of [{ depositEnable: false }, { depositHideEnable: true }, { depositEnable: undefined }, { depositFee: '0.01' }]) {
    const { reader, calls } = setup({ overrides: { [wallet]: { code: '000000', data: [{ ...currency, networkList: [{ ...network, ...patch }] }] } } });
    assert.deepEqual((await reader.catalog(signal)).map(c => [c.spot, c.perp]), [[false, true]]);
    const view = await reader.read(input, signal);
    assert.ok('error' in view.spot && 'bids' in view.perp);
    if ('depositEnable' in patch && patch.depositEnable === undefined) assert.equal(view.deposit, null);
    assert.ok(!calls.includes(spot + depth));
  }
});
test('币安无有效事件、快照落后、来源过期或异币的现货深度都不能作为新盘口', async () => {
  for (const depthEvent of [{ ...event, E: at - 15000 }, { ...event, E: at + 2001 }, { ...event, u: 104 },
    { ...event, s: 'BADUSDT' }, { ...event, a: [], b: [] }]) {
    const { reader } = setup({ depthEvent });
    const view = await reader.read(input, signal);
    assert.ok('error' in view.spot && 'bids' in view.perp);
  }
  const { reader } = setup({ overrides: { [futures + depth]: { ...book, T: at - 15000, E: at }, [spot + depth]: { ...book, bids: [['12.1','1'],['10','1']] } } });
  const view = await reader.read(input, signal);
  assert.match((view.spot as { error: string }).error, /保护/); assert.match((view.perp as { error: string }).error, /过期/);
});
test('币安永续市价开空保留高于标记价的买盘，在下限处截止', async () => {
  const bids = [['11.1', '3'], ['10', '3'], ['9', '1'], ['8.99', '8']];
  const { reader } = setup({ overrides: { [futures + depth]: { ...book, T: at - 100, E: at, bids } } });
  const { perp } = await reader.read(input, signal);
  assert.ok('bids' in perp);
  assert.deepEqual(perp.bids, bids.slice(0, 3));
});
test('币安按基准价验算名义下限和市场步长；不接受开仓受控、定期或退市的合约', async () => {
  const { reader } = setup({ overrides: { [futures + 'premiumIndex' + query]: { symbol: 'LINKUSDT', markPrice: '9.9', time: at } } });
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
  const { reader, responses } = setup({ age: () => time, walletHeaders: { age: '58' } });
  await reader.catalog(signal);
  time += 2000; responses[wallet] = new Response(null, { status: 429 });
  await assert.rejects(reader.catalog(signal), { status: 429 });
  await assert.rejects(reader.read(input, AbortSignal.abort()), { name: 'AbortError' });
  const limited = setup({ overrides: { [futures + depth]: new Response(null, { status: 418 }) } });
  const quote = await limited.reader.read(input, signal);
  assert.deepEqual(quote.perp, { error: '币安公开行情请求受限', rateLimited: true }); assert.ok('bids' in quote.spot);
});
