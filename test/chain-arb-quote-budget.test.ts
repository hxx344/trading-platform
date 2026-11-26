import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as settle } from 'node:timers/promises';
import type { ChainArbVenue } from '../src/chain-arb/model.ts';
import { createQuoteBudget } from '../src/chain-arb/quote-budget.ts';
import { createChainArbMarket } from '../src/chain-arb/read.ts';
import type { VenueReader } from '../src/chain-arb/venue.ts';
import { ARB_ADDRESS, chainArbFixture } from './chain-arb-fake.ts';

const base = 1_800_000_000_000;
const params = { chain: 'all', amount: '1000', spotFeeBps: '10', perpFeeBps: '5', spotCosts: '0', perpCosts: '0' };

test('三所各扫两币、单次询价五秒时，第三所等到共享名额后同批给出有效机会', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: base });
  const candidates = [ARB_ADDRESS, '0x' + '2'.repeat(40)].map((address, i) => ({
    symbol: i ? 'SECOND' : 'ARB', address, chain: 'arbitrum' as const, spot: true, perp: false,
  }));
  const starts: [ChainArbVenue, number][] = [];
  let active = 0, peak = 0;
  const reader = (venue: ChainArbVenue): VenueReader => ({
    catalog: async () => candidates,
    read: async () => {
      starts.push([venue, Date.now() - base]); active++; peak = Math.max(peak, active);
      await new Promise<void>(resolve => setTimeout(resolve, 5_000));
      active--;
      return { deposit: true, withdraw: true, spot: { at: Date.now(), step: '0.1', bids: [['0.11', '25000']] }, perp: { error: '无永续' } };
    },
  });
  const fixture = chainArbFixture(Date.now);
  const market = createChainArbMarket({ now: Date.now, venueReaders: { gate: reader('gate'), binance: reader('binance'), bitget: reader('bitget') },
    fetchImpl: async (raw, init) => {
      const url = new URL(raw), address = url.searchParams.get('tokenOut');
      if (!address || address === ARB_ADDRESS) return fixture(raw, init);
      url.searchParams.set('tokenOut', ARB_ADDRESS);
      const response = await fixture(url.href, init);
      const body = await response.json() as { data: { routeSummary: { tokenOut: string } } };
      body.data.routeSummary.tokenOut = address;
      return Response.json(body);
    } });
  t.after(() => market.closeChainArb());
  const scan = (venue: ChainArbVenue) => market.scanChainArb({ ...params, venue }, 'batch:1', new AbortController().signal, true);
  const gate = scan('gate'); await settle();
  t.mock.timers.tick(2000); const binance = scan('binance'); await settle();
  t.mock.timers.tick(2000); const bitget = scan('bitget'); await settle();
  assert.equal(starts.length, 4);
  t.mock.timers.tick(1000); await settle();
  assert.deepEqual(starts, [['gate', 0], ['gate', 0], ['binance', 2000], ['binance', 2000], ['bitget', 5000], ['bitget', 5000]]);
  t.mock.timers.tick(5000); await settle();
  assert.equal(peak, 4);
  for (const result of await Promise.all([gate, binance, bitget])) {
    assert.equal(result.phase, 'scanning');
    assert.equal(result.failed, 0);
    assert.deepEqual(result.rows.map(row => row.symbol).sort(), ['ARB', 'SECOND']);
    assert.ok(result.rows.every(row => row.netUsdt > 0 && row.expiresAt > result.asOf));
  }
});

test('每秒最多启动三次，FIFO 保留扫描名额，取消的等待者不会启动或阻挡下一位', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: base });
  const acquire = createQuoteBudget(Date.now), controller = new AbortController(), signal = controller.signal;
  const first = await Promise.all(Array.from({ length: 3 }, () => acquire(signal, false)));
  for (const release of first) release();
  const started: string[] = [], released: (() => void)[] = [];
  const wait = async (name: string, scanning: boolean, stop = signal) => {
    const release = await acquire(stop, scanning);
    started.push(name); released.push(release);
  };
  const cancelled = new AbortController();
  const requests = [wait('manual-1', false), wait('manual-2', false)];
  await assert.rejects(wait('manual-overflow', false), { status: 429 });
  const discarded = assert.rejects(wait('cancelled', true, cancelled.signal), { name: 'AbortError' });
  requests.push(wait('scan-1', true), wait('scan-2', true));
  cancelled.abort(); await discarded;
  t.mock.timers.tick(999); await settle(); assert.deepEqual(started, []);
  t.mock.timers.tick(1); await settle(); assert.deepEqual(started, ['manual-1', 'manual-2', 'scan-1']);
  t.mock.timers.tick(1000); await Promise.all(requests);
  assert.deepEqual(started, ['manual-1', 'manual-2', 'scan-1', 'scan-2']);
  for (const release of released) release();
});

test('行情关闭会终止在途和排队查询，之后不会再请求上游', async () => {
  const controller = new AbortController(), calls: string[] = [];
  const reader: VenueReader = { catalog: async () => [], read: async (_input, signal) => {
    calls.push('venue');
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } };
  const market = createChainArbMarket({ venueReaders: { gate: reader, bitget: reader, binance: reader }, fetchImpl: chainArbFixture() });
  const request = () => market.chainArb({ ...params, chain: 'arbitrum', address: ARB_ADDRESS, symbol: 'ARB' }, controller.signal);
  const pending = Array.from({ length: 5 }, () => assert.rejects(request(), { name: 'AbortError' }));
  await settle(); assert.equal(calls.length, 3);
  market.closeChainArb(); await Promise.all(pending);
  await assert.rejects(request(), { name: 'AbortError' });
  assert.equal(calls.length, 3);
});
