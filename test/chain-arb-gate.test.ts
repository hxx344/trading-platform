import assert from 'node:assert/strict';
import test from 'node:test';
import { createGateReader } from '../src/chain-arb/gate.ts';
import { createScanCatalog } from '../src/chain-arb/catalog.ts';
import { parseChainArb } from '../src/chain-arb/model.ts';

const now = 1_795_690_885_886;
const address = '0x912CE59144191C1204E64559FE8253a0e49E6548';
const input = { chain: 'arbitrum', address, symbol: 'ARB' } as const;
const signal = new AbortController().signal;
const chain = { name: 'ARBEVM', addr: address, deposit_disabled: false, withdraw_disabled: false, withdraw_delayed: false };
const fixtures = {
  currency: { currency: 'ARB', chains: [chain], delisted: false, trade_disabled: false, deposit_disabled: false,
    withdraw_disabled: false, withdraw_delayed: false },
  pair: { id: 'ARB_USDT', base: 'ARB', quote: 'USDT', amount_precision: 2, min_base_amount: '1', min_quote_amount: '3',
    max_base_amount: '8000', max_quote_amount: '20000', market_order_max_stock: '6500', market_order_max_money: '0',
    type: 'normal', trade_status: 'tradable', sell_start: 1_600_000_000, slippage: '0.05' },
  contract: { name: 'ARB_USDT', type: 'direct', contract_type: '', status: 'trading', is_pre_market: false, in_delisting: false,
    quanto_multiplier: '0.5', enable_decimal: true, order_size_min: '0.1', order_size_max: '1200', market_order_size_max: '1000',
    market_order_slip_ratio: '0.05', order_price_deviate: '0.2', mark_price: '3.2' },
  spot: { current: now, update: now - 122, bids: [['3.2', '600'], ['3.1', '42']] },
  perp: { current: now / 1000, update: (now - 386) / 1000, bids: [{ p: '3.25', s: '10.2' }, { p: '3.1', s: '20' }] },
};
type Key = keyof typeof fixtures;
const paths: Record<string, Key> = {
  '/api/v4/spot/currencies/ARB': 'currency', '/api/v4/spot/currency_pairs/ARB_USDT': 'pair',
  '/api/v4/futures/usdt/contracts/ARB_USDT': 'contract', '/api/v4/spot/order_book?currency_pair=ARB_USDT&limit=100': 'spot',
  '/api/v4/futures/usdt/order_book?contract=ARB_USDT&limit=100': 'perp',
};
function setup(values: Partial<Record<Key, unknown>> = {}, symbol = 'ARB') {
  const counts = { currency: 0, pair: 0, contract: 0, spot: 0, perp: 0 };
  const expected = new Map(Object.entries(paths).map(([path, key]) => [path.replace('ARB', encodeURIComponent(symbol)), key]));
  let time = now;
  const read = createGateReader({ clock: () => time, fetcher: async (url, init) => {
    const route = new URL(url);
    assert.equal(route.origin, 'https://api.gateio.ws');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(url, route.href);
    const key = expected.get(route.pathname + route.search);
    assert.ok(key, 'Only the five fixed public Gate routes are used');
    const headers = new Headers(init.headers);
    assert.equal(headers.get('X-Gate-Size-Decimal'), key === 'contract' || key === 'perp' ? '1' : null);
    counts[key]++;
    const value = Object.hasOwn(values, key) ? values[key] : fixtures[key];
    if (value instanceof Error) throw value;
    return value instanceof Response ? value.clone() : Response.json(value, { headers: { date: new Date(time).toUTCString() } });
  } });
  return { read, counts, advance(ms: number) { time += ms; } };
}

test('Gate 按链及合约匹配币种，从两种原始时间单位读取盘口变更时间并按每张币数换算永续', async () => {
  const venue = await setup().read({ ...input, address: address.toLowerCase() }, signal);
  assert.deepEqual(venue, {
    deposit: true, withdraw: true,
    spot: { bids: [['3.2', '600'], ['3.1', '42']], at: now - 122, step: '0.01', minQuantity: '1', minNotional: '3', maxQuantity: '6500', maxNotional: '20000' },
    perp: { bids: [['3.25', '5.1'], ['3.1', '10']], at: Math.floor(now / 1000) * 1000, step: '0.5', minQuantity: '0.05', maxQuantity: '500' },
  });
});

test('BSC 中文币从公开目录到现货和永续询价保留原名，各路径和查询只编码一次', async () => {
  const symbol = '哈基米', market = symbol + '_USDT';
  const currency = { ...fixtures.currency, currency: symbol, chains: [{ ...chain, name: 'BSC', addr: '0x82ec31d69b3c289e541b50e30681fd1acad24444' }] };
  const pair = { ...fixtures.pair, id: market, base: symbol };
  const lists: Record<string, unknown[]> = { '/api/v4/spot/currencies': [currency], '/api/v4/spot/currency_pairs': [pair],
    '/api/v4/futures/usdt/tickers': [{ contract: market }] };
  const catalog = createScanCatalog({ now: () => now, fetchImpl: async url => Response.json(lists[new URL(url).pathname]) });
  const found = await catalog(signal);
  assert.equal(found.length, 1);
  const candidate = found[0];
  const verified = parseChainArb({ symbol: candidate.symbol, chain: candidate.chain, address: candidate.address,
    amount: '1000', spotFeeBps: '10', perpFeeBps: '5' });
  assert.equal(verified.symbol, symbol);
  const { read, counts } = setup({ currency, pair, contract: { ...fixtures.contract, name: market } }, symbol);
  const venue = await read(verified, signal);
  assert.ok('bids' in venue.spot && 'bids' in venue.perp);
  assert.deepEqual(counts, { currency: 1, pair: 1, contract: 1, spot: 1, perp: 1 });
  await assert.rejects(read({ ...verified, address: '0x' + 'a'.repeat(40) }, signal), /唯一匹配/);
});

test('Gate 拒绝链、合约、代码不匹配和重复网络，在身份不明时不读取任何市场', async () => {
  for (const currency of [
    { ...fixtures.currency, currency: 'ARB2' },
    { ...fixtures.currency, chains: [{ ...chain, name: 'ETH' }] },
    { ...fixtures.currency, chains: [{ ...chain, addr: '0x' + 'a'.repeat(40) }] },
    { ...fixtures.currency, chains: [chain, { name: 'ARB' }] },
  ]) {
    const { read, counts } = setup({ currency });
    await assert.rejects(read(input, signal), /唯一匹配所选链与代币合约地址/);
    assert.equal(counts.perp + counts.spot + counts.contract + counts.pair, 0);
  }
  const { read, counts } = setup();
  await assert.rejects(read({ ...input, symbol: '../wallet' }, signal), /唯一匹配/);
  assert.equal(counts.currency, 0);
  for (const [network, name] of [['ethereum', 'ETH'], ['bsc', 'BSC']] as const) {
    const known = setup({ currency: { ...fixtures.currency, chains: [{ ...chain, name }] } });
    assert.equal((await known.read({ ...input, chain: network }, signal)).deposit, true);
  }
});

test('Gate 充提开关、现货卖出和永续开空独立判定', async () => {
  const { read } = setup({ currency: { ...fixtures.currency, deposit_disabled: true, trade_disabled: true,
    chains: [{ ...chain, withdraw_delayed: true }] } });
  const unavailable = await read(input, signal);
  assert.equal(unavailable.deposit, false);
  assert.equal(unavailable.withdraw, false);
  assert.ok('error' in unavailable.spot && /未开放卖出/.test(unavailable.spot.error));
  assert.ok('bids' in unavailable.perp);
  const unknown = await setup({ currency: { ...fixtures.currency, chains: [{ ...chain, deposit_disabled: undefined }] },
    pair: { ...fixtures.pair, trade_status: 'sellable' }, contract: new Response(null, { status: 404 }) }).read(input, signal);
  assert.equal(unknown.deposit, null);
  assert.ok('bids' in unknown.spot);
  assert.deepEqual(unknown.perp, { error: 'Gate USDT 永续合约不可用' });
});

test('Gate 排除异类合约、乘数无效、未开盘或待退市的市场', async () => {
  for (const patch of [{ type: 'inverse' }, { contract_type: 'stocks' }, { status: 'circuit_breaker' },
    { quanto_multiplier: '0' }, { in_delisting: true }, { is_pre_market: true }, { launch_time: Math.ceil(now / 1000) + 60 }]) {
    const { read } = setup({ contract: { ...fixtures.contract, ...patch } });
    const venue = await read(input, signal);
    assert.ok('error' in venue.perp);
    assert.ok('at' in venue.spot);
  }
  for (const patch of [{ id: 'ARB_BTC' }, { amount_precision: -1 }, { trade_status: 'buyable' },
    { delisting_time: 123 }, { sell_start: Math.ceil(now / 1000) + 60 }, { market_order_max_stock: 'invalid' }]) {
    const { read, counts } = setup({ pair: { ...fixtures.pair, ...patch } });
    assert.ok('error' in (await read(input, signal)).spot);
    assert.equal(counts.spot, 0);
  }
});

test('Gate 拒绝刷新过的旧盘口、未来或错单位时间，以及无效价格和数量', async () => {
  for (const patch of [{ update: now - 15_000 }, { current: now + 2_001 }, { update: now + 1 },
    { update: now / 1000 }, { update: undefined }, { bids: [['3', '1'], ['4', '2']] }, { bids: [['3', '0']] }]) {
    const { read } = setup({ spot: { ...fixtures.spot, ...patch } });
    const venue = await read(input, signal);
    assert.ok('error' in venue.spot);
    assert.ok('bids' in venue.perp);
  }
  for (const patch of [{ update: now }, { bids: [{ p: 10, s: false }] }, { bids: [] }]) {
    assert.ok('error' in (await setup({ perp: { ...fixtures.perp, ...patch } }).read(input, signal)).perp);
  }
});

test('Gate 仅短缓存目录，每次重读两侧盘口，超龄、超大响应和上游错误有界', async () => {
  const fixture = setup();
  await fixture.read(input, signal);
  await fixture.read(input, signal);
  assert.deepEqual(fixture.counts, { currency: 1, pair: 1, contract: 2, spot: 2, perp: 2 });
  fixture.advance(30_000);
  await fixture.read(input, signal);
  assert.deepEqual(fixture.counts, { currency: 2, pair: 2, contract: 3, spot: 3, perp: 3 });
  const aborted = AbortSignal.abort(new Error('用户取消'));
  await assert.rejects(fixture.read(input, aborted), /用户取消/);
  assert.equal(fixture.counts.currency, 2);
  for (const currency of [new Response('x'.repeat(131_073)), new Response(null, { status: 502 }), new Error('internal-text')]) {
    await assert.rejects(setup({ currency }).read(input, signal), /^Error: Gate 币种目录不可用或未收录此币$/);
  }
  const aged = setup({ currency: Response.json(fixtures.currency, { headers: { Age: '30' } }) });
  await assert.rejects(aged.read(input, signal), /缓存已过期/);
});

test('Gate 以买一和标记价分别约束可成交买盘，精确包含边界，张数乘数只转换一次', async () => {
  const { read } = setup({
    pair: { ...fixtures.pair, slippage: '0.1' },
    spot: { ...fixtures.spot, bids: [['0.14', '3'], ['0.126', '100'], ['0.125999', '1000']] },
    contract: { ...fixtures.contract, mark_price: '0.16', order_price_deviate: '0.2', market_order_slip_ratio: '0.1',
      quanto_multiplier: '0.1', order_size_min: '3', market_order_size_max: '3' },
    perp: { ...fixtures.perp, bids: [{ p: '0.14', s: '3' }, { p: '0.128', s: '1.5' }, { p: '0.1275', s: '1000' }] },
  });
  const result = await read(input, signal);
  assert.ok('bids' in result.spot && 'bids' in result.perp);
  assert.deepEqual(result.spot.bids, [['0.14', '3'], ['0.126', '100']]);
  assert.deepEqual(result.perp.bids, [['0.14', '0.3'], ['0.128', '0.15']]);
  assert.equal(result.perp.minQuantity, '0.3');
  assert.equal(result.perp.maxQuantity, '0.3');
  const slip = await setup({ contract: { ...fixtures.contract, market_order_slip_ratio: '0.001' } }).read(input, signal);
  assert.ok('bids' in slip.perp);
  assert.deepEqual(slip.perp.bids, [['3.25', '5.1']]);
});

test('Gate 以 1 wei 区分盘口排序、保护边界、可卖数量和单笔限额', async () => {
  const wei = '0.000000000000000001', below = '0.999999999999999999', lower = '0.999999999999999998';
  const { read } = setup({
    pair: { ...fixtures.pair, amount_precision: 18, slippage: wei, max_base_amount: '01.000', market_order_max_stock: below,
      min_quote_amount: below, max_quote_amount: '1', market_order_max_money: lower },
    spot: { ...fixtures.spot, bids: [['01.000', below], [below, wei], [lower, '1000']] },
    contract: { ...fixtures.contract, quanto_multiplier: wei, order_size_min: '1', order_size_max: '999999999999999999',
      market_order_size_max: '999999999999999998', mark_price: '1', order_price_deviate: wei },
    perp: { ...fixtures.perp, bids: [{ p: '1', s: '999999999999999999' }, { p: below, s: wei }, { p: lower, s: '1000' }] },
  });
  const { spot, perp } = await read(input, signal);
  assert.ok('bids' in spot && 'bids' in perp);
  assert.deepEqual(spot.bids, [['1', below], [below, wei]]);
  assert.equal(spot.step, wei);
  assert.equal(spot.minNotional, below);
  assert.equal(spot.maxQuantity, below);
  assert.equal(spot.maxNotional, lower);
  assert.deepEqual(perp.bids, [['1', below], [below, '0.' + '0'.repeat(35) + '1']]);
  assert.equal(perp.step, wei);
  assert.equal(perp.minQuantity, wei);
  assert.equal(perp.maxQuantity, lower);
});

test('Gate 保留 JSON 裸小数原值，拒绝裸不安全整数和超出原始精度的金额', async () => {
  const book = (size: string) => new Response('{"current":' + now + ',"update":' + now + ',"bids":[["1",' + size + ']]}');
  const exact = await setup({ spot: book('0.999999999999999999') }).read(input, signal);
  assert.ok('bids' in exact.spot);
  assert.deepEqual(exact.spot.bids, [['1', '0.999999999999999999']]);
  for (const size of ['9007199254740993', '1.0000000000000000001', '"1' + '0'.repeat(60) + '"']) {
    const { spot, perp } = await setup({ spot: book(size) }).read(input, signal);
    assert.deepEqual(spot, { error: 'Gate 买盘价格、数量或排序异常' });
    assert.ok('bids' in perp);
  }
  for (const pair of [{ ...fixtures.pair, min_quote_amount: 2 ** 54 }, { ...fixtures.pair, max_base_amount: '0.0000000000000000001' }]) {
    const { spot } = await setup({ pair }).read(input, signal);
    assert.deepEqual(spot, { error: 'Gate 下单数量或金额限制无效' });
  }
});

test('Gate 保护参数缺失或无有效价位只影响当前腿，过期标记价不得借新盘口续期', async () => {
  const noRatio = await setup({ pair: { ...fixtures.pair, slippage: undefined } }).read(input, signal);
  assert.deepEqual(noRatio.spot, { error: 'Gate 市价单价格保护参数或基准价无效' });
  assert.ok('bids' in noRatio.perp);
  for (const patch of [{ mark_price: undefined }, { order_price_deviate: [] }, { market_order_slip_ratio: '1.1' }]) {
    const venue = await setup({ contract: { ...fixtures.contract, ...patch } }).read(input, signal);
    assert.deepEqual(venue.perp, { error: 'Gate 市价单价格保护参数或基准价无效' });
    assert.ok('bids' in venue.spot);
  }
  const cutoff = await setup({ contract: { ...fixtures.contract, mark_price: '8' } }).read(input, signal);
  assert.deepEqual(cutoff.perp, { error: 'Gate 市价单保护范围内没有可成交买盘' });
  for (const date of [undefined, new Date(now - 16_000).toUTCString(), new Date(now + 3_000).toUTCString()]) {
    const stale = await setup({ contract: Response.json(fixtures.contract, { headers: date ? { date } : {} }) }).read(input, signal);
    assert.ok('error' in stale.perp && /标记价/.test(stale.perp.error));
    assert.ok('at' in stale.spot);
  }
  const aged = await setup({ contract: Response.json(fixtures.contract, { headers: { date: new Date(now).toUTCString(), Age: '12' } }) }).read(input, signal);
  assert.ok('at' in aged.perp);
  assert.equal(aged.perp.at, now - 12_000);
});
