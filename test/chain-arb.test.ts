import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import { createExecutorServer } from '../src/http.ts';
import { createMonitorData } from '../src/market/monitor-data.ts';
import { parseChainArb } from '../src/chain-arb/model.ts';
import { compareChainArb } from '../src/chain-arb/estimate.ts';
import type { GateLeg } from '../src/chain-arb/gate.ts';
import { createHarness } from './harness.ts';
import { ARB_ADDRESS, chainArbFixture } from './chain-arb-fake.ts';

const raw = { chain: 'ethereum', address: '0x' + '1'.repeat(40), symbol: 'EXAMPLE',
  amount: '105', spotFeeBps: '10', perpFeeBps: '5', spotCosts: '1', perpCosts: '2' };
const input = parseChainArb(raw);
const now = 2_000_000;
const buy = { rawQuantity: '105', decimals: 1, at: now - 2000 };
const spot: GateLeg = { step: 0.1, at: now - 3000, bids: [[12, 4], [11, 7]] };
const perp: GateLeg = { step: 1, at: now, bids: [[13, 11]] };
const venue = { deposit: true, withdraw: false, spot, perp };

test('链上买入后按卖方深度估现货，永续按整张开空；回收同价情景扣双边手续费', () => {
  const view = compareChainArb(input, buy, venue, now);
  assert.equal(view.expiresAt, spot.at + 15_000);
  assert.deepEqual(view.dex, { quantity: 10.5, price: 10, at: buy.at });
  assert.ok('quantity' in view.spot && 'quantity' in view.perp);
  assert.equal(view.spot.grossUsdt, 14.5);
  assert.equal(view.spot.netUsdt, 13.3805);
  assert.equal(view.spot.remainder, 0);
  assert.equal(view.perp.quantity, 10);
  assert.equal(view.perp.grossUsdt, 30);
  assert.equal(view.perp.spreadBps, 3000);
  assert.equal(view.perp.netUsdt, 27.87);
  assert.equal(view.perp.remainder, 0.5);
});

test('同币身份已匹配时充值状态只阻断现货，缺成本留空，精度与单笔限额按路线检查', () => {
  const view = compareChainArb({ ...input, perpCosts: null }, buy, { ...venue, deposit: null }, now);
  assert.ok('error' in view.spot && 'netUsdt' in view.perp);
  assert.equal(view.perp.netUsdt, null);
  for (const limits of [{ minQuantity: 11 }, { maxQuantity: 10 }, { minNotional: 200 }, { maxNotional: 100 }]) {
    assert.ok('error' in compareChainArb(input, buy, { ...venue, spot: { ...spot, ...limits } }, now).spot);
  }
  const rounded = compareChainArb(input, { ...buy, rawQuantity: '3' }, venue, now);
  assert.ok('quantity' in rounded.spot && 'error' in rounded.perp);
  assert.equal(rounded.spot.quantity, 0.3);
});

test('低于一手的链上最小单位不能凑整张或跨过 Gate 单笔门槛', () => {
  const near = { rawQuantity: '26999999999999999999', decimals: 18, at: buy.at };
  const book: GateLeg = { ...spot, step: 1, bids: [[1, 100]] };
  const limits = { ...venue, spot: { ...book, minNotional: 27 }, perp: { ...book, minQuantity: 27 } };
  const blocked = compareChainArb(input, near, limits, now);
  assert.deepEqual(blocked.spot, { error: '名义金额不在该市场单笔范围内' });
  assert.deepEqual(blocked.perp, { error: '数量不在该市场单笔范围内' });

  const covered = compareChainArb({ ...input, amount: '27' }, near, { ...venue, spot: book, perp: book }, now);
  for (const route of [covered.spot, covered.perp]) {
    assert.ok('quantity' in route);
    assert.equal(route.quantity, 26);
    assert.equal(route.grossUsdt, -9.62962962962963e-19);
    assert.equal(route.remainder, Number('0.999999999999999999'));
  }
  const oneWeiLeft = compareChainArb(input, { ...near, rawQuantity: '27000000000000000001' }, limits, now);
  assert.ok('remainder' in oneWeiLeft.perp);
  assert.deepEqual([oneWeiLeft.perp.quantity, oneWeiLeft.perp.remainder], [27, 1e-18]);
});

test('使用科学计数法的交易步长也按原始买入量、深度和名义金额比较', () => {
  const near = { rawQuantity: '2999999999999999999', decimals: 25, at: buy.at };
  const book: GateLeg = { ...spot, step: 1e-7, bids: [[1e8, 0.00001]] };
  const view = compareChainArb(input, near, { ...venue, spot: { ...book, minNotional: 20 }, perp: { ...book, minNotional: 21 } }, now);
  assert.ok('quantity' in view.spot && 'error' in view.perp);
  assert.equal(view.spot.quantity, 2e-7);
  const above = compareChainArb(input, { ...buy, rawQuantity: '1000000000000000001', decimals: 18 },
    { ...venue, spot: { ...book, step: 1e-18, bids: [[1, 1]] } }, now);
  assert.deepEqual(above.spot, { error: '公开买盘深度不足以覆盖该数量' });
});

test('过期、时间超前及深度不足不返回收益，负价差保留负号', () => {
  for (const at of [now - 15_000, now + 2001]) assert.throws(() => compareChainArb(input, { ...buy, at }, venue, now), /时间|过期/);
  const view = compareChainArb(input, buy, { ...venue, spot: { ...spot, at: now - 15_000 }, perp: { ...perp, bids: [[13, 1]] } }, now);
  assert.ok('error' in view.spot && 'error' in view.perp);
  const loss = compareChainArb(input, buy, { ...venue, spot: { ...spot, bids: [[9, 100]] } }, now);
  assert.ok('netUsdt' in loss.spot && loss.spot.netUsdt! < 0 && loss.spot.spreadBps < 0);
});

test('公开行情 IPC 校验币种和金额后才联系上游', async () => {
  const market = createMonitorData({ fetchImpl: async () => { assert.fail('无效请求不得联系上游'); } });
  try {
    const reply = await market.call('monitor.perpetual.chainArb', { ...raw, amount: '0x5' }, new AbortController().signal);
    assert.equal((reply as { error: { status: number } }).error.status, 400);
  } finally { market.close?.(); }
});

test('行情进程用同一份链上买入数量与两份 Gate 买盘生成结果', async () => {
  const clock = () => 1_795_600_000_000;
  const market = createMonitorData({ fetchImpl: chainArbFixture(clock), now: clock });
  try {
    const reply = await market.call('monitor.perpetual.chainArb', { ...raw, address: ARB_ADDRESS, chain: 'arbitrum', symbol: 'ARB' }, new AbortController().signal);
    assert.ok(reply && typeof reply === 'object' && 'ok' in reply && reply.ok && 'value' in reply);
    const view = reply.value as ReturnType<typeof compareChainArb>;
    assert.equal(view.dex.quantity, 1050);
    assert.ok('quantity' in view.perp && 'quantity' in view.spot);
    assert.deepEqual([view.deposit, view.perp.quantity, view.spot.quantity], [true, 1050, 1050]);
  } finally { market.close?.(); }
});

test('真实读取入口不将差一个最小单位的 Gate 现货深度向上舍入', async () => {
  const clock = () => 1_795_600_000_000;
  const fixture = chainArbFixture(clock);
  const market = createMonitorData({ now: clock, fetchImpl: async (url, init) => {
    const response = await fixture(url, init);
    if (!url.includes('/spot/order_book?')) return response;
    const book = await response.json() as Record<string, unknown>;
    return Response.json({ ...book, bids: [['0.103', '0.999999999999999999']] });
  } });
  try {
    const reply = await market.call('monitor.perpetual.chainArb', { ...raw, chain: 'arbitrum', address: ARB_ADDRESS, symbol: 'ARB', amount: '0.1' }, new AbortController().signal);
    assert.ok(reply && typeof reply === 'object' && 'value' in reply);
    const view = reply.value as ReturnType<typeof compareChainArb>;
    assert.equal(view.dex.quantity, 1);
    assert.deepEqual(view.spot, { error: '公开买盘深度不足以覆盖该数量' });
  } finally { market.close?.(); }
});

test('登录后的入口在监控切换时撤回在途结果，拒绝重复参数与未配置市场', async () => {
  const h = createHarness();
  let revision = 0, enabled = true, configured = true, entered = () => {};
  let read = Promise.resolve<unknown>(42);
  const server = createExecutorServer({ executor: h.ex, accessToken: 'chain-arb-test-0001', views: { monitor: {
    state: () => ({ markets: configured ? ['perpetual'] : [], controls: { perpetual: { enabled, revision } } }),
    enabled: () => enabled, quote: () => null, candles: () => null,
    chainArb: () => { entered(); return read; },
  } } });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    const url = base + '/api/monitor/perpetual/chain-arb?symbol=ARB';
    assert.equal((await fetch(url)).status, 401);
    const login = await fetch(base + '/login?token=chain-arb-test-0001', { redirect: 'manual' });
    const headers = { cookie: login.headers.get('set-cookie')!.split(';')[0] };
    assert.equal((await fetch(url, { headers })).status, 200);
    assert.equal((await fetch(url + '&symbol=ARB', { headers })).status, 400);
    let release!: () => void;
    read = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = fetch(url, { headers });
    await started; revision++; release();
    assert.equal((await pending).status, 409);
    enabled = false;
    assert.equal((await fetch(url, { headers })).status, 423);
    configured = false;
    assert.equal((await fetch(url, { headers })).status, 404);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    h.dispose();
  }
});
