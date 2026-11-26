import { verifiedBuy } from './chain-arb-fake.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as settle } from 'node:timers/promises';
import type { ScanCandidate } from '../src/chain-arb/catalog.ts';
import { compareChainArb } from '../src/chain-arb/estimate.ts';
import { parseChainArb, type ChainArbView } from '../src/chain-arb/model.ts';
import { createChainArbScanner } from '../src/chain-arb/scan.ts';
import { parseChainArbScan } from '../src/chain-arb/scan-model.ts';

const params = { chain: 'all', amount: '105', spotFeeBps: '10', perpFeeBps: '5', spotCosts: '1', perpCosts: '2' };
const signal = new AbortController().signal;
const start = 1_800_000_000_000;
function tokens(count: number): ScanCandidate[] {
  return Array.from({ length: count }, (_, i) => ({ chain: 'bsc', symbol: 'COIN' + i, spot: true, perp: true,
    address: '0x' + (i + 1).toString(16).padStart(40, '0') }));
}
function view(at: number, net = 2): ChainArbView {
  return { asOf: at, expiresAt: at + 15_000, dex: { at, price: 1, quantity: 105, swapGasUsdt: 1, execution: { quotedQuantity: 105, receivedQuantity: 105, transferQuantity: 105, impactBps: 0, blockNumber: '0x123' } },
    deposit: true, withdraw: true, spot: { quantity: 105, price: 1.1, grossUsdt: 4, spreadBps: 400, netUsdt: net,
      netBps: net * 100, coveredCostUsdt: 100, at, remainder: 5 }, perp: { error: '无永续' } };
}

test('扫描预算沿用单币精度/上限，零成本必须明确输入，格式等价的参数只产生一份配置', () => {
  assert.deepEqual(parseChainArbScan({ ...params, amount: '105.000000', spotFeeBps: '10.00' }), params);
  for (const raw of [{ ...params, spotCosts: '' }, { ...params, perpCosts: undefined }, { ...params, amount: '1e2' },
    { ...params, amount: '0' }, { ...params, spotFeeBps: '100.000001' }, { ...params, chain: ['bsc'] },
    { ...params, symbol: 'ETH' }, { ...params, swapGas: 'auto' }]) {
    assert.throws(() => parseChainArbScan(raw), { status: 400 });
  }
  assert.equal(parseChainArbScan({ ...params, perpCosts: '0.000' }).perpCosts, '0');
});

test('净额使用整笔买入成本和买入 Gas、费率、其他成本，缺 Gas 与零以下机会不入榜', async t => {
  let time = start, gas: number | null = 1;
  const scanner = createChainArbScanner({ now: () => time, catalog: async () => tokens(1), quote: async raw => {
    const input = parseChainArb(raw);
    assert.equal(input.swapGas, 'auto');
    return compareChainArb(input, verifiedBuy({ rawQuantity: '105', decimals: 1, at: time, swapGasUsdt: gas }), {
      deposit: true, withdraw: true, spot: { step: 0.1, bids: [[11, 11]], at: time - 100 },
      perp: { step: 1, bids: [[13, 11]], at: time - 200 },
    }, time);
  } });
  t.after(() => scanner.close());
  const poll = () => scanner.read(params, 'worker:1', signal);
  assert.equal((await poll()).phase, 'loading');
  await settle();
  const { rows, checked } = await poll();
  assert.equal(checked, 1);
  assert.deepEqual(rows.map(r => [r.kind, r.netUsdt, r.gasUsdt]), [['perp', 21.77, 1], ['spot', 8.3845, 1]]);
  assert.ok(Math.abs(rows[0].netBps - 21.77 * 10_000 / 105) < 1e-10);
  assert.equal(rows[0].expiresAt, time - 200 + 15_000);
  assert.ok(Math.abs(rows[1].netBps - 8.3845 * 10_000 / 105) < 1e-10);
  for (gas of [null, 30]) {
    time += 2000; await poll(); await settle();
    const result = await poll();
    assert.equal(result.failed, gas === null ? 1 : 0);
    assert.deepEqual([result.rows, result.history], [[], []]);
  }
});

test('实际地址证明独立限制各路线的盘口寿命及历史，现货不继承较旧的永续盘口期限', async t => {
  for (const proofLifetime of [3000, 60_000]) await t.test(String(proofLifetime), async t => {
    let time = start;
    const scanner = createChainArbScanner({ now: () => time, catalog: async () => tokens(1), quote: async raw => {
      const result = compareChainArb(parseChainArb(raw), verifiedBuy({ rawQuantity: '105', decimals: 1, at: start, swapGasUsdt: 1 }), {
        deposit: true, withdraw: true, spot: { step: 1, bids: [[13, 11]], at: start },
        perp: { step: 1, bids: [[13, 11]], at: start - 14_000 },
      }, start);
      result.dex.execution!.depositVenue = 'gate';
      result.dex.execution!.depositExpiresAt = start + proofLifetime;
      return result;
    } });
    t.after(() => scanner.close());
    const poll = () => scanner.read(params, 'worker:1', signal);
    await poll(); await settle();
    const rows = (await poll()).rows;
    assert.equal(rows.find(row => row.kind === 'perp')?.expiresAt, start + 1000);
    assert.equal(rows.find(row => row.kind === 'spot')?.expiresAt, start + Math.min(15_000, proofLifetime));
    time += 1001;
    const afterPerp = await poll();
    assert.deepEqual(afterPerp.rows.map(row => row.kind), ['spot']);
    assert.deepEqual(afterPerp.history.map(row => row.kind), ['perp']);
    time = start + proofLifetime;
    const expired = await poll();
    assert.deepEqual([expired.rows, expired.history], [[], []]);
  });
});

test('现货盘口到期后两条需要现货退出的路线均转入历史', async t => {
  let time = start;
  const scanner = createChainArbScanner({ now: () => time, catalog: async () => tokens(1), quote: async raw =>
    compareChainArb(parseChainArb(raw), verifiedBuy({ rawQuantity: '105', decimals: 1, at: start, swapGasUsdt: 1 }), {
      deposit: true, withdraw: true, spot: { step: 1, bids: [[13, 11]], at: start - 14_900 },
      perp: { step: 1, bids: [[13, 11]], at: start },
    }, start) });
  t.after(() => scanner.close());
  const poll = () => scanner.read(params, 'worker:1', signal);
  await poll(); await settle();
  assert.equal((await poll()).rows.length, 2);
  time += 101;
  const result = await poll();
  assert.deepEqual(result.rows, []);
  assert.deepEqual(result.history.map(r => [r.kind, r.expiresAt]).sort(), [['perp', start + 100], ['spot', start + 100]]);
});

test('慢目录、慢币均不阻塞 GET，同批结果独立发布，下一批按实际报价启动时刻限速', async t => {
  let time = start, openCatalog!: (value: ScanCandidate[]) => void, finishCoin!: (v: ChainArbView) => void;
  const calls: string[] = [];
  let directory: Promise<ScanCandidate[]> | undefined;
  const scanner = createChainArbScanner({ now: () => time, catalog: () => directory ??= new Promise(r => { openCatalog = r; }),
    quote: async raw => {
      const { symbol } = parseChainArb(raw);
      calls.push(symbol);
      if (symbol === 'COIN0') return new Promise(r => { finishCoin = r; });
      if (symbol === 'COIN2') throw new Error('此币读取失败');
      return view(time);
    } });
  t.after(() => scanner.close());
  const poll = () => scanner.read(params, 'worker:1', signal);
  assert.equal((await poll()).phase, 'loading');
  time += 5000; await poll();
  openCatalog(tokens(4)); await settle();
  const partial = await poll();
  assert.deepEqual(partial.rows.map(r => r.symbol), ['COIN1']);
  assert.equal(partial.checked, 1);
  finishCoin(view(time)); await settle();
  time += 1999; await poll(); await settle();
  assert.deepEqual(calls, ['COIN0', 'COIN1']);
  time++; await poll(); await settle();
  const final = await poll();
  assert.deepEqual([final.checked, final.failed, final.total], [4, 1, 4]);
  assert.deepEqual(final.rows.map(r => r.symbol), ['COIN0', 'COIN1', 'COIN3']);
});

test('跨页签共享预算、每批最多两币、并发配置轮转且有界，停止轮询后不自开下一批', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: start });
  const calls: string[] = [];
  const scanner = createChainArbScanner({ catalog: async () => tokens(8), quote: async raw => {
    calls.push(parseChainArb(raw).amount); return view(Date.now());
  } });
  t.after(() => scanner.close());
  const poll = (amount: string) => scanner.read({ ...params, amount }, 'worker:1', signal);
  for (const amount of ['100', '100.0', '200', '300', '400']) await poll(amount);
  await assert.rejects(poll('500'), { status: 429 });
  await settle();
  assert.deepEqual(calls, ['100', '100']);
  for (let i = 0; i < 4; i++) {
    t.mock.timers.tick(2000);
    for (const amount of ['100', '200', '300', '400']) await poll(amount);
    await settle();
  }
  assert.deepEqual(calls, ['100', '100', '200', '200', '300', '300', '400', '400', '100', '100']);
  t.mock.timers.tick(120_000); await settle();
  assert.equal(calls.length, 10);
  assert.equal((await poll('500')).phase, 'loading');
  await settle();
  assert.deepEqual(calls.slice(-2), ['500', '500']);
});

test('发现正差后仍遍历整轮，老机会轮流复核；新轮剔除退市标的并按链过滤', async t => {
  let time = start, candidates = tokens(24), catalogCalls = 0;
  const calls: string[] = [];
  const scanner = createChainArbScanner({ now: () => time, catalog: async () => { catalogCalls++; return candidates; },
    quote: async raw => { calls.push(parseChainArb(raw).symbol); return view(time); } });
  t.after(() => scanner.close());
  const byChain = { ...params, chain: 'bsc' };
  const poll = () => scanner.read(byChain, 'worker:1', signal);
  let last = await poll();
  for (let i = 0; i < 24; i++) {
    await settle(); last = await poll();
    if (last.checked === 24) break;
    time += 2000; await poll();
  }
  assert.equal(last.cycle, 1);
  assert.equal(last.checked, 24);
  assert.equal(new Set(calls).size, 24);
  for (const name of ['COIN0', 'COIN1', 'COIN2']) assert.ok(calls.filter(s => s === name).length > 1);
  assert.ok(last.history.length && last.history.every(r => r.expiresAt <= time));
  const firstCycleReads = catalogCalls;
  candidates = [candidates[23], { ...candidates[0], chain: 'ethereum' }];
  time += 2000; await poll(); await settle(); last = await poll();
  assert.deepEqual([last.cycle, last.checked, last.total, catalogCalls], [2, 1, 1, firstCycleReads + 1]);
  assert.deepEqual(last.rows.map(r => r.symbol), ['COIN23']);
  assert.deepEqual(last.history, []);
});

test('15 秒到时分离历史采样，复核失败移除旧行，目录失败撤回结果并有界恢复', async t => {
  let time = start, blocked = false, catalogFails = false, catalogCalls = 0;
  const scanner = createChainArbScanner({ now: () => time, catalog: async () => {
    catalogCalls++; if (catalogFails) throw new Error('目录不可用'); return tokens(1);
  }, quote: async () => { if (blocked) throw new Error('无报价'); return view(time); } });
  t.after(() => scanner.close());
  const poll = () => scanner.read(params, 'worker:1', signal);
  await poll(); await settle(); assert.equal((await poll()).rows.length, 1);
  blocked = true; time += 15_000;
  const old = await poll();
  assert.deepEqual([old.rows.length, old.history.length], [0, 1]);
  await settle();
  assert.deepEqual((await poll()).history, []);
  blocked = false; time += 2000; await poll(); await settle();
  assert.equal((await poll()).rows.length, 1);
  catalogFails = true; time += 2000; await poll(); await settle();
  const failed = await poll();
  assert.deepEqual([failed.phase, failed.message, failed.rows, failed.history], ['error', '目录不可用', [], []]);
  catalogFails = false; time += 9999; await poll(); await settle(); assert.equal(catalogCalls, 4);
  time++; await poll(); await settle(); assert.equal((await poll()).rows.length, 1);
});

test('长轮中目录换版立即撤下旧合约，保留已查列表并从尚未报价的身份继续', async t => {
  let time = start, candidates = tokens(5);
  const calls: string[] = [];
  const scanner = createChainArbScanner({ now: () => time, catalog: async () => candidates, quote: async raw => {
    const input = parseChainArb(raw);
    calls.push(input.address); return view(time);
  } });
  t.after(() => scanner.close());
  const poll = () => scanner.read(params, 'worker:1', signal);
  await poll(); await settle();
  const retired = candidates[0].address, replacement = tokens(12)[11].address;
  candidates = [{ ...candidates[0], address: replacement }, ...candidates.slice(1)];
  time += 2000; await poll(); await settle();
  const result = await poll();
  assert.deepEqual([result.cycle, result.checked, result.total], [1, 3, 5]);
  assert.deepEqual(calls, [retired, candidates[1].address, replacement, candidates[2].address]);
  assert.ok(result.rows.every(row => row.address !== retired));
});

test('单腿及整币限流同时约束其他配置，冷却到期重新采样', async t => {
  let time = start;
  const calls: string[] = [];
  const scanner = createChainArbScanner({ now: () => time, catalog: async () => tokens(1),
    quote: async raw => {
      calls.push(parseChainArb(raw).amount);
      if (calls.length === 1) return { ...view(time), perp: { error: 'Gate 限流', rateLimited: true } };
      if (calls.length === 2) throw Object.assign(new Error('DEX 限流'), { status: 429 });
      return view(time);
    } });
  t.after(() => scanner.close());
  const poll = (amount: string) => scanner.read({ ...params, amount }, 'worker:1', signal);
  await poll('100'); await settle();
  assert.equal((await poll('100')).phase, 'cooldown');
  assert.equal((await poll('200')).rows.length, 0);
  time += 29_999; await poll('200'); await settle(); assert.deepEqual(calls, ['100']);
  time++; await poll('200'); await settle(); assert.deepEqual(calls, ['100', '200']);
  assert.equal((await poll('100')).phase, 'cooldown');
  time += 30_000; await poll('100'); await settle();
  assert.equal((await poll('100')).rows.length, 1);
});

test('超时释放批次，迟到响应与切换监控前的结果隔离，关闭及已中止的请求不会重新启动扫描', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: start });
  const requests: { signal: AbortSignal; resolve: (v: ChainArbView) => void }[] = [];
  const scanner = createChainArbScanner({ catalog: async () => tokens(1),
    quote: (_raw, signal) => new Promise(resolve => requests.push({ signal, resolve })) });
  t.after(() => scanner.close());
  const poll = (scope: string) => scanner.read(params, scope, signal);
  await assert.rejects(scanner.read(params, 'old', AbortSignal.abort()));
  await poll('old'); await settle();
  t.mock.timers.tick(25_000); await settle();
  assert.ok(requests[0].signal.aborted);
  assert.equal((await poll('old')).failed, 1); await settle();
  assert.equal(requests.length, 2);
  assert.equal((await poll('new')).phase, 'loading');
  assert.ok(requests[1].signal.aborted);
  requests[0].resolve(view(Date.now(), 123)); requests[1].resolve(view(Date.now(), 456));
  await settle(); t.mock.timers.tick(2000);
  assert.deepEqual((await poll('new')).rows, []); await settle();
  requests[2].resolve(view(Date.now(), 3)); await settle();
  assert.deepEqual((await poll('new')).rows.map(r => r.netUsdt), [3]);
  t.mock.timers.tick(2000); await poll('new'); await settle();
  scanner.close();
  assert.ok(requests[3].signal.aborted);
  await assert.rejects(poll('new'), { status: 503 });
});
