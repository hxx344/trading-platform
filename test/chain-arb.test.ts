import { withChainArbLedger } from '../src/service/chain-arb-ledger.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { setImmediate as settle } from 'node:timers/promises';
import { join } from 'node:path';
import { createMarketClient } from '../src/market/ipc.ts';
import { createMarketServer } from '../src/market/server.ts';
import { createRemoteMonitor } from '../src/service/remote-monitor.ts';
import type { ScanView } from '../src/chain-arb/scan-model.ts';
import { createExecutorServer } from '../src/http.ts';
import { createMonitorData } from '../src/market/monitor-data.ts';
import { parseChainArb } from '../src/chain-arb/model.ts';
import { createChainArbMarket } from '../src/chain-arb/read.ts';
import { compareChainArb } from '../src/chain-arb/estimate.ts';
import type { GateLeg } from '../src/chain-arb/gate.ts';
import { createHarness } from './harness.ts';
import { ARB_ADDRESS, chainArbFixture, testGateLedger, verifiedBuy } from './chain-arb-fake.ts';
import { chainArbQuery } from '../web/src/chain-arb-form.ts';
import { reviewScanRow } from '../web/src/chain-arb-scan-form.ts';

const raw = { chain: 'ethereum', address: '0x' + '1'.repeat(40), symbol: 'EXAMPLE',
  amount: '105', spotFeeBps: '10', perpFeeBps: '5', spotCosts: '1', perpCosts: '2' };
const input = parseChainArb(raw);
const now = 2_000_000;
const buy = verifiedBuy({ rawQuantity: '105', decimals: 1, at: now - 2000 });
const spot: GateLeg = { step: 0.1, at: now - 3000, bids: [[12, 4], [11, 7]] };
const perp: GateLeg = { step: 1, at: now, bids: [[13, 11]] };
const venue = { deposit: true, withdraw: false, spot, perp };

test('整笔买入后按深度卖现货，永续收敛计入现货吃档、尾数与三次交易的费用', () => {
  const view = compareChainArb(input, buy, venue, now);
  assert.equal(view.expiresAt, spot.at + 15_000);
  assert.deepEqual(view.dex, { quantity: 10.5, price: 10, at: buy.at, swapGasUsdt: null,
    execution: { quotedQuantity: 10.5, receivedQuantity: 10.5, transferQuantity: 10.5, transferAmount: '10.5', impactBps: 0, blockNumber: '0x123' } });
  assert.ok('quantity' in view.spot && 'quantity' in view.perp);
  assert.equal(view.spot.grossUsdt, 14.5);
  assert.equal(view.spot.netUsdt, 13.3805);
  assert.equal(view.spot.remainder, 0);
  assert.equal(view.perp.quantity, 10);
  // 卖现货 114，开空 130，收敛时按现货买一 12 平空 120，链上整笔花费 105。
  assert.equal(view.perp.grossUsdt, 19);
  assert.equal(view.perp.spreadBps, 1809.5238095238096);
  assert.equal(view.perp.netUsdt, 16.761);
  assert.equal(view.perp.remainder, 0.5);
});

test('充值关闭或未知阻断两条路线，缺成本留空，精度与单笔限额按路线检查', () => {
  for (const deposit of [null, false]) {
    const closed = compareChainArb(input, buy, { ...venue, deposit }, now);
    assert.ok('error' in closed.spot && 'error' in closed.perp);
  }
  const view = compareChainArb({ ...input, perpCosts: null }, buy, venue, now);
  assert.ok('netUsdt' in view.spot && 'netUsdt' in view.perp);
  assert.equal(view.perp.netUsdt, null);
  for (const limits of [{ minQuantity: 11 }, { maxQuantity: 10 }, { minNotional: 200 }, { maxNotional: 100 }]) {
    assert.ok('error' in compareChainArb(input, buy, { ...venue, spot: { ...spot, ...limits } }, now).spot);
  }
  const rounded = compareChainArb(input, verifiedBuy({ ...buy, rawQuantity: '3' }), venue, now);
  assert.ok('quantity' in rounded.spot && 'error' in rounded.perp);
  assert.equal(rounded.spot.quantity, 0.3);
});

test('自动 Gas 模式按整笔买入成本计算，缺少估值时不产生净价差', () => {
  const auto = parseChainArb({ ...raw, swapGas: 'auto' });
  const view = compareChainArb(auto, { ...buy, swapGasUsdt: 1.5 }, venue, now);
  assert.ok('netBps' in view.spot && 'netBps' in view.perp);
  assert.equal(view.spot.netUsdt, 11.8805);
  assert.equal(view.perp.coveredCostUsdt, 105);
  assert.equal(view.perp.netBps, 1453.4285714285713);
  const missing = compareChainArb(auto, buy, venue, now);
  assert.ok('netBps' in missing.spot && missing.spot.netBps === null && missing.spot.netUsdt === null);
});

test('最低充值量按转账实收量比较，差一个最小单位关闭两条路线', () => {
  const market = { ...venue, minDeposit: '1', spot: { ...spot, step: '0.1' }, perp: { ...perp, step: '0.01' } };
  const full = verifiedBuy({ ...buy, rawQuantity: '1000000000000000000', decimals: 18 });
  const below = compareChainArb({ ...input, venue: 'bitget' }, { ...full,
    evidence: { ...full.evidence, transferRaw: '999999999999999999' } }, market, now);
  assert.deepEqual(below.spot, { error: '预计到账数量低于该网络最低充值量' });
  assert.deepEqual(below.perp, below.spot);
  const exact = compareChainArb(input, full, market, now);
  assert.ok('netUsdt' in exact.spot && 'netUsdt' in exact.perp);
});

test('目录刷新撤销单条路线时，同一行情进程的所有榜单都按新资格过滤，即使单币缓存仍旧', async t => {
  let time = 1_795_600_000_000, mode: 'both' | 'perp' | 'spot' = 'both';
  const now = () => time, fixture = chainArbFixture(now);
  let currencyReads = 0, directoryReads = 0, unavailable = false;
  const market = createChainArbMarket({ now, fetchImpl: async (url, init) => {
    const response = await fixture(url, init);
    if (url.endsWith('/spot/currencies')) {
      directoryReads++;
      if (unavailable) return Response.json({}, { status: 429 });
      const [asset] = await response.json() as Record<string, unknown>[];
      return Response.json([{ ...asset, deposit_disabled: mode === 'perp' }], { headers: { Age: '295' } });
    }
    if (url.endsWith('/spot/currencies/ARB')) {
      currencyReads++;
      const asset = await response.json() as Record<string, unknown>;
      return Response.json({ ...asset, deposit_disabled: mode === 'perp' }, { headers: { date: new Date(time).toUTCString() } });
    }
    if (url.endsWith('/futures/usdt/tickers') && mode === 'spot') return Response.json([{ contract: 'OTHER_USDT' }]);
    return response;
  } });
  t.after(() => market.closeChainArb());
  const form = { chain: 'all', amount: '1000', spotFeeBps: '10', perpFeeBps: '5', spotCosts: '0', perpCosts: '0' };
  const signal = new AbortController().signal;
  const poll = (amount: string) => market.scanChainArb({ ...form, amount }, 'test', signal);
  async function reviewRequest() {
    const row = (await poll(form.amount)).rows[0];
    const manual = reviewScanRow(form, row);
    const query = chainArbQuery(manual.form, manual.autoGas);
    const parameters = Object.fromEntries(new URL(query.path, 'http://localhost').searchParams);
    return () => market.chainArb(parameters, signal);
  }
  const kinds = async (amount: string) => (await poll(amount)).rows.map(row => row.kind);
  await poll('1000'); await settle();
  assert.deepEqual(await kinds('1000'), ['perp', 'spot']);
  time += 2000;
  await poll('1001'); await settle();
  assert.deepEqual(await kinds('1001'), ['perp', 'spot']);
  const readPerp = await reviewRequest();
  time += 3000; mode = 'perp';
  await poll('1000'); await settle();
  assert.deepEqual(await kinds('1000'), []);
  assert.deepEqual(await kinds('1001'), []);
  const beforeReview = currencyReads, perpOnly = await readPerp();
  assert.equal(currencyReads, beforeReview + 1);
  assert.equal(perpOnly.deposit, false);
  assert.ok('error' in perpOnly.spot && 'error' in perpOnly.perp);
  time += 30_000; mode = 'spot';
  await poll('1001'); await settle();
  assert.deepEqual(await kinds('1001'), ['spot']);
  assert.ok((await kinds('1000')).every(kind => kind === 'spot'));
  form.amount = '1001';
  const readSpot = await reviewRequest(), spotOnly = await readSpot();
  assert.equal(spotOnly.deposit, true);
  assert.ok('netBps' in spotOnly.spot && 'error' in spotOnly.perp);
  const priorReads = directoryReads;
  time += 10_000;
  const refreshed = await readSpot();
  assert.equal(directoryReads, priorReads + 1);
  assert.ok('netBps' in refreshed.spot && 'error' in refreshed.perp);
  time += 10_000; unavailable = true;
  await assert.rejects(readSpot(), { status: 429 });
});

test('扫描从登录后的 HTTP 经行情 IPC 自动发现 ARB，两条路线按扣费后价差排序', async () => {
  const h = createHarness();
  const socket = process.platform === 'win32' ? '\\\\.\\pipe\\tp-scan-' + randomUUID() : join(h.dir, 'scan.sock');
  const market = createMarketServer({ monitor: createMonitorData({ fetchImpl: chainArbFixture() }) }, 'test');
  const client = createMarketClient(socket);
  const remote = withChainArbLedger(createRemoteMonitor(client), undefined, Date.now, testGateLedger());
  let enabled = true;
  const server = createExecutorServer({ executor: h.ex, accessToken: 'chain-scan-test-0001', views: { monitor: {
    state: () => ({ markets: ['perpetual'], controls: { perpetual: { enabled, revision: 0 } } }),
    enabled: () => enabled, quote: () => null, candles: () => null, scanChainArb: remote.scanChainArb,
  } } });
  try {
    await new Promise<void>((resolve, reject) => { market.server.once('error', reject); market.server.listen(socket, resolve); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
    const url = base + '/api/monitor/perpetual/chain-arb-scan?chain=all&amount=1000&spotFeeBps=10&perpFeeBps=5&spotCosts=0&perpCosts=0';
    assert.equal((await fetch(url)).status, 401);
    const login = await fetch(base + '/login?token=chain-scan-test-0001', { redirect: 'manual' });
    const headers = { cookie: login.headers.get('set-cookie')!.split(';')[0] };
    assert.equal((await fetch(url + '&chain=bsc', { headers })).status, 400);
    const deadline = Date.now() + 8500;
    let snapshot: ScanView;
    do {
      const response = await fetch(url, { headers });
      assert.equal(response.status, 200);
      snapshot = await response.json() as ScanView;
      if (snapshot.rows.length) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    assert.equal(snapshot.total, 1);
    assert.deepEqual(snapshot.rows.map(row => [row.symbol, row.chain, row.address, row.kind, row.netBps, row.netUsdt, row.gasUsdt]), [
      ['ARB', 'arbitrum', ARB_ADDRESS, 'perp', 374.35, 37.435, 0.5], ['ARB', 'arbitrum', ARB_ADDRESS, 'spot', 284.7, 28.47, 0.5],
    ]);
    enabled = false;
    assert.equal((await fetch(url, { headers })).status, 423);
  } finally {
    client.close(); market.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    h.dispose();
  }
});

test('低于一手的链上最小单位不能凑整张或跨过 Gate 单笔门槛', () => {
  const near = verifiedBuy({ rawQuantity: '26999999999999999999', decimals: 18, at: buy.at });
  const book: GateLeg = { ...spot, step: 1, bids: [[1, 100]] };
  const limits = { ...venue, spot: { ...book, minNotional: 27 }, perp: { ...book, minQuantity: 27 } };
  const blocked = compareChainArb(input, near, limits, now);
  assert.deepEqual(blocked.spot, { error: '名义金额不在该市场单笔范围内' });
  assert.deepEqual(blocked.perp, { error: '名义金额不在该市场单笔范围内' });

  const covered = compareChainArb({ ...input, amount: '27' }, near, { ...venue, spot: book, perp: book }, now);
  for (const route of [covered.spot, covered.perp]) {
    assert.ok('quantity' in route);
    assert.equal(route.quantity, 26);
    assert.equal(route.grossUsdt, -1);
    assert.equal(route.remainder, Number('0.999999999999999999'));
  }
  const oneWeiLeft = compareChainArb(input, verifiedBuy({ ...near, rawQuantity: '27000000000000000001' }), limits, now);
  assert.ok('remainder' in oneWeiLeft.perp);
  assert.deepEqual([oneWeiLeft.perp.quantity, oneWeiLeft.perp.remainder], [27, 1e-18]);
});

test('使用科学计数法的交易步长也按原始买入量、深度和名义金额比较', () => {
  const near = verifiedBuy({ rawQuantity: '2999999999999999999', decimals: 25, at: buy.at });
  const book: GateLeg = { ...spot, step: 1e-7, bids: [[1e8, 0.00001]] };
  const view = compareChainArb(input, near, { ...venue, spot: { ...book, minNotional: 20 }, perp: { ...book, minNotional: 21 } }, now);
  assert.ok('quantity' in view.spot && 'error' in view.perp);
  assert.equal(view.spot.quantity, 2e-7);
  const above = compareChainArb(input, verifiedBuy({ ...buy, rawQuantity: '1000000000000000001', decimals: 18 }),
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
    const reply = await market.call('monitor.perpetual.verifiedChainArb', { ...raw, amount: '0x5' }, new AbortController().signal);
    assert.equal((reply as { error: { status: number } }).error.status, 400);
    for (const old of ['chainArb', 'chainArbScan', 'chainArbBatch', 'okxChainArb', 'okxChainArbScan']) {
      const legacy = await market.call('monitor.perpetual.' + old, raw, new AbortController().signal);
      assert.ok(legacy && typeof legacy === 'object' && 'error' in legacy);
      assert.match(JSON.stringify(legacy.error), /未知公开行情操作/);
    }
  } finally { market.close?.(); }
});

test('行情进程用同一份链上买入数量与两份 Gate 买盘生成结果', async () => {
  const clock = () => 1_795_600_000_000;
  const market = createMonitorData({ fetchImpl: chainArbFixture(clock), now: clock });
  try {
    const reply = await market.call('monitor.perpetual.verifiedChainArb', { ...raw, address: ARB_ADDRESS, chain: 'arbitrum', symbol: 'ARB' }, new AbortController().signal);
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
    const reply = await market.call('monitor.perpetual.verifiedChainArb', { ...raw, chain: 'arbitrum', address: ARB_ADDRESS, symbol: 'ARB', amount: '0.1' }, new AbortController().signal);
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
