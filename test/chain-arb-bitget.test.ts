import assert from 'node:assert/strict';
import test from 'node:test';
import { createBitgetReader } from '../src/chain-arb/bitget.ts';
import type { ChainArbInput } from '../src/chain-arb/model.ts';

const now = 1_795_690_885_886, signal = new AbortController().signal;
const address = '0x912ce59144191c1204e64559fe8253a0e49e6548';
const input: ChainArbInput = { venue: 'bitget', chain: 'arbitrum', symbol: 'ARB', address,
  amount: '20', spotFeeBps: 10, perpFeeBps: 5, spotCosts: 0, perpCosts: 0 };
const network = { chain: 'ArbitrumOne', contractAddress: address, rechargeable: 'true', withdrawable: 'false', needTag: 'false', minDepositAmount: '3.15' };
const coin = { coin: 'ARB', chains: [network] };
const pair = { symbol: 'ARBUSDT', baseCoin: 'ARB', quoteCoin: 'USDT', status: 'online', areaSymbol: 'no', offTime: '',
  quantityPrecision: '2', minTradeUSDT: '1', maxMarketOrderValue: '28000', sellLimitPriceRatio: '0.1' };
const contract = { symbol: 'ARBUSDT', baseCoin: 'ARB', quoteCoin: 'USDT', symbolType: 'perpetual', symbolStatus: 'normal', isRwa: 'NO',
  offTime: '-1', limitOpenTime: '-1', supportMarginCoins: ['USDT'], volumePlace: '2', sizeMultiplier: '0.25', minTradeNum: '0.50',
  minTradeUSDT: '5', maxMarketOrderQty: '100', sellLimitPriceRatio: '0.02' };
const spotRef = { symbol: 'ARBUSDT', category: 'SPOT', lastPrice: '10', ts: String(now - 73) };
const perpRef = { symbol: 'ARBUSDT', category: 'USDT-FUTURES', markPrice: '10', ts: String(now - 150) };
const sample = () => ({
  coins: [coin], pairs: [pair], contracts: [contract], currency: [coin], spotMeta: [pair], perpMeta: [contract],
  spotBook: { b: [[10, 1.5], [9, 5], [8.99, 15]], ts: String(now - 33) },
  perpBook: { b: [[10, 9.25], [9.8, 5], [9.79, 100]], ts: String(now - 30) },
  spotRef: [spotRef], perpRef: [perpRef],
});
type Data = Record<keyof ReturnType<typeof sample>, unknown>;
function setup(changes: Partial<Data> = {}) {
  const data: Data = { ...sample(), ...changes }, calls: string[] = [];
  const paths: Record<string, keyof Data> = {
    '/api/v2/spot/public/coins': 'coins', '/api/v2/spot/public/symbols': 'pairs',
    '/api/v2/mix/market/contracts?productType=USDT-FUTURES': 'contracts',
    '/api/v2/spot/public/coins?coin=ARB': 'currency', '/api/v2/spot/public/symbols?symbol=ARBUSDT': 'spotMeta',
    '/api/v2/mix/market/contracts?productType=USDT-FUTURES&symbol=ARBUSDT': 'perpMeta',
    '/api/v3/market/orderbook?category=SPOT&symbol=ARBUSDT&limit=100': 'spotBook',
    '/api/v3/market/orderbook?category=USDT-FUTURES&symbol=ARBUSDT&limit=100': 'perpBook',
    '/api/v3/market/tickers?category=SPOT&symbol=ARBUSDT': 'spotRef',
    '/api/v3/market/tickers?category=USDT-FUTURES&symbol=ARBUSDT': 'perpRef',
  };
  const reader = createBitgetReader({ now: () => now, fetchImpl: async (url, init) => {
    const endpoint = new URL(url), key = paths[endpoint.pathname + endpoint.search];
    assert.equal(endpoint.origin, 'https://api.bitget.com');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.ok(key);
    calls.push(key);
    const value = data[key];
    return value instanceof Response ? value.clone() : Response.json({ code: '00000', requestTime: now, data: value });
  } });
  return { ...reader, data, calls };
}

test('Bitget 从本所币链和 USDT 市场生成候选，按基础币读取线性永续深度和步长', async () => {
  const reader = setup();
  assert.deepEqual(await reader.catalog(signal), [{ chain: 'arbitrum', symbol: 'ARB', address, spot: true, perp: true }]);
  const result = await reader.read(input, signal);
  assert.deepEqual(result, { deposit: true, withdraw: false, minDeposit: '3.15',
    spot: { bids: [['10', '1.5'], ['9', '5']], at: now - 73, step: '0.01', minNotional: '1', maxNotional: '28000' },
    perp: { bids: [['10', '9.25'], ['9.8', '5']], at: now - 150, step: '0.25', minQuantity: '0.5', maxQuantity: '100', minNotional: '5' } });
  assert.equal(reader.calls.filter(key => key === 'coins').length, 1);
});

test('Bitget 同名错链或复核中换地址时拒绝；重复币种、网络、地址及非普通市场不入榜', async () => {
  const duplicate = { ...coin, coin: 'OTHER' };
  const otherChain = { ...network, chain: 'BEP20' };
  for (const changes of [
    { coins: [coin, duplicate] }, { coins: [coin, { ...coin, chains: [otherChain] }] },
    { coins: [{ ...coin, chains: [network, { ...network, contractAddress: null }] }] },
    { pairs: [pair, pair], contracts: [contract, contract] },
    { pairs: [{ ...pair, areaSymbol: 'yes' }], contracts: [{ ...contract, isRwa: 'YES' }] },
    { pairs: [{ ...pair, status: 'gray' }], contracts: [{ ...contract, symbolType: 'delivery' }] },
  ]) assert.deepEqual(await setup(changes).catalog(signal), []);
  await assert.rejects(setup().read({ ...input, chain: 'bsc' }, signal), /唯一匹配/);
  const reader = setup({ currency: [{ ...coin, chains: [{ ...network, contractAddress: '0x' + '1'.repeat(40) }] }] });
  await assert.rejects(reader.read(input, signal), /唯一匹配/);
  assert.ok(!reader.calls.includes('spotBook'));
});

test('Bitget 单币复核重查充值和开仓状态；状态或最低充值量缺失只撤下对应路线', async () => {
  const reader = setup();
  await reader.catalog(signal);
  reader.data.currency = [{ ...coin, chains: [{ ...network, rechargeable: 'false' }] }];
  const closed = await reader.read(input, signal);
  assert.equal(closed.deposit, false);
  assert.ok('error' in closed.spot && 'bids' in closed.perp);
  for (const changed of [{ ...network, minDepositAmount: '' }, { ...network, needTag: 'true' }]) {
    const coins = [{ ...coin, chains: [changed] }];
    const partial = setup({ coins, currency: coins });
    assert.equal((await partial.catalog(signal))[0].spot, false);
    const view = await partial.read(input, signal);
    assert.ok('error' in view.spot && 'bids' in view.perp);
  }
  reader.data.currency = [coin];
  reader.data.perpMeta = [{ ...contract, limitOpenTime: '1795690885000' }];
  const noOpen = await reader.read(input, signal);
  assert.ok('bids' in noOpen.spot && 'error' in noOpen.perp);
});

test('Bitget 现货按当前价、永续按标记价计算卖出下限，买一溢价不改变下限', async () => {
  const book = { b: [[11, 1], [10, 10], [9.8, 4], [9.79, 3], [8.99, 12]], ts: String(now) };
  const result = await setup({ perpBook: book, spotBook: book }).read(input, signal);
  assert.ok('bids' in result.perp && 'bids' in result.spot);
  assert.deepEqual(result.perp.bids, [['11', '1'], ['10', '10'], ['9.8', '4']]);
  assert.deepEqual(result.spot.bids, [...result.perp.bids, ['9.79', '3']]);
});

test('Bitget 检查撮合时间、参考价身份与顺序，并精确保留 JSON 裸数字', async () => {
  const precise = new Response('{"code":"00000","requestTime":' + now + ',"data":{"b":[[10,1.000000000000000001],[9.000000000000000001,5]],"ts":"' + now + '"}}');
  const exact = await setup({ spotBook: precise }).read(input, signal);
  assert.ok('bids' in exact.spot);
  assert.deepEqual(exact.spot.bids, [['10', '1.000000000000000001'], ['9.000000000000000001', '5']]);
  for (const changes of [
    { spotBook: { b: [[10, 2]], ts: String(now - 15_000) } },
    { spotBook: { b: [[9, 2], [10, 2]], ts: String(now) } },
    { spotBook: { b: [[10, -1]], ts: String(now) } },
    { spotRef: [{ ...spotRef, ts: String(now + 2001) }] },
    { spotRef: [{ ...spotRef, category: 'USDT-FUTURES' }] },
    { spotMeta: [{ ...pair, maxMarketOrderValue: 'bogus' }] },
  ]) {
    const view = await setup(changes).read(input, signal);
    assert.ok('error' in view.spot && 'bids' in view.perp);
  }
  const throttled = await setup({ perpBook: new Response(null, { status: 429 }) }).read(input, signal);
  assert.ok('error' in throttled.perp && throttled.perp.rateLimited && 'bids' in throttled.spot);
});
