import assert from 'node:assert/strict';
import test from 'node:test';
import type { GateDepositSource } from '../src/chain-arb/gate-deposit-proof.ts';
import { createChainArbMarket } from '../src/chain-arb/read.ts';
import { withChainArbLedger } from '../src/service/chain-arb-ledger.ts';
import { ARB_ADDRESS, chainArbFixture, TEST_DEPOSIT, testGateLedger } from './chain-arb-fake.ts';

const start = 1_795_600_000_000;
const form = { chain: 'arbitrum', amount: '1000', spotFeeBps: '10', perpFeeBps: '5', spotCosts: '0', perpCosts: '0' };
const manual = { ...form, symbol: 'ARB', address: ARB_ADDRESS, swapGas: 'auto' };
const signal = new AbortController().signal;

function setup(t: { after: (clean: () => void) => void }) {
  const state = { at: start, generation: 1, minimum: '0.1', reads: 0, net: 10_000n * 10n ** 18n,
    recipient: TEST_DEPOSIT, queried: [] as string[], afterTransfer: () => {} };
  const now = () => state.at, base = chainArbFixture(now), generations = new WeakMap<object, number>();
  const ledger: GateDepositSource = { ...testGateLedger(now),
    async gateDepositProof(symbol, chain) {
      state.reads++;
      const proof = { symbol, chain, at: now(), expiresAt: now() + 60_000, minDeposit: state.minimum };
      generations.set(proof, state.generation); return proof;
    },
    gateDepositCurrent: proof => generations.get(proof) === state.generation && state.at < proof.expiresAt,
    gateDepositRecipient: proof => generations.get(proof) === state.generation ? state.recipient : undefined,
  };
  const fetcher = async (url: string, init: RequestInit) => {
    const body = await base(url, init);
    if (new URL(url).hostname !== 'arb1.arbitrum.io') {
      assert.ok(!String(init.body).includes(TEST_DEPOSIT.slice(2))); return body;
    }
    const req = JSON.parse(String(init.body));
    if (req.method !== 'eth_simulateV1') return body;
    const calls = req.params[0].blockStateCalls[0].calls;
    if (calls.length !== 10) return body;
    state.queried.push('0x' + calls[7].data.slice(34,74));
    assert.equal(state.queried.at(-1), state.recipient);
    const data = await body.json() as { result: { calls: { returnData: string }[] }[] };
    data.result[0].calls[8].returnData = '0x' + state.net.toString(16).padStart(64,'0');
    state.afterTransfer();
    return Response.json(data);
  };
  const market = createChainArbMarket({ fetchImpl: base, now });
  const service = withChainArbLedger(market, undefined, now, ledger, fetcher);
  t.after(() => { market.closeChainArb(); service.close(); });
  return { state, service, market, ledger, fetcher, now, scan: () => service.scanChainArb(form, 'test', signal, true),
    single: () => service.chainArb(manual, signal) };
}

test('实际 Gate 地址收款扣税，按精确实收量重新吃盘、计算两路净额并应用原币最低额', async t => {
  const { state, single, scan } = setup(t);
  const pass = await single();
  assert.equal(pass.dex.execution?.depositVenue, 'gate');
  assert.ok('netUsdt' in pass.spot && pass.spot.netUsdt! > 0);
  state.net = 7900n * 10n ** 18n;
  const loss = await single();
  assert.equal(loss.dex.execution?.transferQuantity, 7900);
  assert.ok('netUsdt' in loss.spot && loss.spot.quantity === 7900 && loss.spot.netUsdt! < 0);
  assert.ok('netUsdt' in loss.perp && loss.perp.quantity === 7900 && loss.perp.netUsdt! < 0);
  assert.deepEqual((await scan()).rows, []);
  state.at += 2000;
  state.minimum = '7900.000000000000000001';
  const low = await single();
  for (const leg of [low.spot, low.perp]) { assert.ok('error' in leg); assert.match(leg.error,/最低充值量/); }
  assert.ok(!JSON.stringify(low).includes(TEST_DEPOSIT));
});

test('地址缺失、不能重放或重放期间换账户均不输出净收益；旧证据不能在新账户复用', async t => {
  const { state, single, service, scan } = setup(t);
  const good = await scan();
  assert.equal(good.rows.length, 2);
  assert.ok(good.rows.every(service.gateResultCurrent));
  state.generation++;
  assert.ok(good.rows.every(row => !service.gateResultCurrent(row)));
  assert.deepEqual((await scan()).rows, []);
  state.afterTransfer = () => { state.generation++; };
  const late = await single();
  assert.equal(late.dex.execution?.depositVenue, undefined);
  assert.equal(late.dex.execution?.transferQuantity, null);
  assert.ok('error' in late.spot && 'error' in late.perp);
  state.recipient = '';
  const failed = await single();
  assert.equal(failed.deposit, null);
  assert.ok('error' in failed.spot && 'error' in failed.perp);
  assert.equal(state.queried.length, 2);
});

test('手工缺少成本保留实际地址毛值；不支持的场所和外部自带地址不会发起私有查询', async t => {
  const { service, state } = setup(t);
  await assert.rejects(service.chainArb({ ...manual, recipient: TEST_DEPOSIT }, signal), /未知参数/);
  for (const venue of ['binance','bitget']) {
    await assert.rejects(service.chainArb({ ...manual, venue }, signal), /尚未接入/);
    assert.deepEqual((await service.scanChainArb({ ...form, venue }, 'scan', signal)).rows, []);
  }
  assert.equal(state.reads,0);
  const gross = await service.chainArb({ ...manual, spotCosts: '', perpCosts: '' }, signal);
  assert.equal(gross.dex.execution?.depositVenue, 'gate');
  assert.ok('netUsdt' in gross.spot && gross.spot.netUsdt === null && gross.spot.grossUsdt > 0);
});

test('扫描后的单币复核重读 Gate 交易状态，暂停交易立即撤掉两条路线', async t => {
  let at = start, paused = false, marketReads = 0;
  const now = () => at, base = chainArbFixture(now);
  const market = createChainArbMarket({ now, fetchImpl: async (url, init) => {
    const response = await base(url, init);
    if (!url.includes('/spot/currency_pairs/ARB_USDT')) return response;
    marketReads++;
    if (!paused) return response;
    return Response.json({ ...await response.json() as Record<string, unknown>, trade_status: 'untradable' });
  } });
  const service = withChainArbLedger(market, undefined, now, testGateLedger(now), base);
  t.after(() => { market.closeChainArb(); service.close(); });
  assert.equal((await service.scanChainArb(form, 'scan', signal, true)).rows.length, 2);
  paused = true; at += 2000;
  const blocked = await service.chainArb(manual, signal);
  assert.ok('error' in blocked.spot && 'error' in blocked.perp);
  assert.equal(marketReads, 2);
});

test('公开买一的乐观上界已亏损时正常略过，不读私有地址、不累计失败', async t => {
  const now = () => start, base = chainArbFixture(now), ledger = testGateLedger(now);
  let reads = 0;
  ledger.gateDepositProof = async () => { reads++; throw new Error(); };
  const reader = { catalog: async () => [{ symbol: 'ARB', chain: 'arbitrum' as const, address: ARB_ADDRESS, spot: true, perp: true }],
    read: async () => { const book = { bids: [['0.08','100000']] as [string,string][], at: start, step: 1 };
      return { deposit: true, withdraw: true, spot: book, perp: book }; } };
  const market = createChainArbMarket({ now, fetchImpl: base, venueReaders: { gate: reader, binance: reader, bitget: reader } });
  const service = withChainArbLedger(market, undefined, now, ledger, base);
  t.after(() => { market.closeChainArb(); service.close(); });
  const view = await service.scanChainArb(form, 'scan', signal, true);
  assert.deepEqual([view.rows,view.checked,view.failed,reads], [[],1,0,0]);
});
