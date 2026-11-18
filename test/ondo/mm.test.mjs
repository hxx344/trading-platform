import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Ported from the workbench (project-aggregation 7745181 tests/ondo-mm.test.mjs). Changes: the key comes from
// readCredentials (secrets.json here) instead of setKey/clearKey; the order prefix is tpo- and the workbench's omm- orders
// are left alone; the workbench route test is replaced by test/ondo-service.test.ts.
import { createOndoMarketMaker, ONDO_MM_DEFAULTS, validateOndoMmConfig } from '../../src/vendor/ondo/mm.mjs';
import { OndoError } from '../../src/vendor/ondo/client.mjs';
import { decimalUnits as u } from '../../src/vendor/ondo/decimal.mjs';
import { remoteOndoStream } from '../../src/service/remote-venue-feeds.ts';

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const EPOCH = 1_800_000_000_000, MARKET = 'NVDA-USD.P';
const SECRET = 'ondoApiSecret_fixture-secret-value';
const KEY = Object.freeze({ keyId: 'ondoKeyId_fixture', secret: SECRET });
const config = (extra = {}) => ({ ...structuredClone(ONDO_MM_DEFAULTS), markets: [MARKET], mode: 'live', wallEnabled: true, wallUsd: '100', ...extra });
// Mid 200.02: the fixed quotes are 199.93 and 200.11.
const BIDS = [['200.00', '10'], ['199.98', '20'], ['199.95', '100']], ASKS = [['200.04', '10'], ['200.06', '20'], ['200.09', '100']];

function fixture(options = {}) {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'ondo-mm-'));
  const f = { dataDir, key: options.key ?? null, time: EPOCH, maintenance: false, admission: true, privateReady: true, stream: null, streamClosed: 0, book: null, frozen: false };
  const v = { orders: [], history: new Map(), positions: new Map(), entries: new Map(), calls: [], seq: 0, cooldown: 0, onPlace: null, cancelError: null, readError: null,
    rules: new Map([[MARKET, { tick: '0.01', step: '0.01', trading: true }]]) };
  const count = name => v.calls.filter(call => call[0] === name).length;
  const clientFactory = () => ({
    cooldownUntil: () => v.cooldown,
    async markets() { v.calls.push(['markets']); if (v.rulesGate) await v.rulesGate; if (v.rulesError) throw v.rulesError; return v.rules; },
    async place(input) {
      await v.beforeSend?.(input);
      if (!input.canSend()) throw new OndoError('send_guard');
      v.calls.push(['place', input]);
      const order = { id: `o${++v.seq}`, clientId: input.clientOrderId, market: input.market, side: input.side, price: input.price, size: input.size, filled: '0', status: 'open', reduceOnly: input.reduceOnly };
      const outcome = v.onPlace?.(input, order);
      if (outcome?.rests !== false) v.orders.push(order);
      if (outcome?.error) throw outcome.error;
      return { ...order, ...outcome?.report };
    },
    async cancel(id) {
      v.calls.push(['cancel', id]);
      if (v.cancelError) throw v.cancelError;
      const index = v.orders.findIndex(order => order.id === id);
      if (index < 0) throw new OndoError('order_not_found', { status: 400 });
      const canceled = { ...v.orders.splice(index, 1)[0], status: 'canceled' };
      const report = v.onCancel?.(canceled) ?? canceled;
      v.history.set(report.clientId, report);
      return report;
    },
    async orderByClientId(clientId) { v.calls.push(['lookup', clientId]); if (v.lookupError) throw v.lookupError; const found = v.orders.find(order => order.clientId === clientId) ?? v.history.get(clientId); return found ? { ...found } : null; },
    async openOrders() { v.calls.push(['open']); if (v.readError) throw v.readError; return v.orders.map(order => ({ ...order })); },
    async positions({ details = false } = {}) { v.calls.push(['positions']); await v.positionsGate; if (v.positionsError) throw v.positionsError;
      if (details) return new Map([...v.positions].map(([name, size]) => [name, { size, entryPrice: v.entries.get(name) ?? '200' }]));
      const snapshot = new Map(v.positions); v.afterPreflight?.(); return snapshot; },
    close() {},
  });
  const streamFactory = input => {
    f.stream = input;
    return { start() {}, close() { f.streamClosed += 1; },
      expireOrders(verified) { if (f.deadManReady !== false) { f.expiry = verified; f.deadManReady = false; } },
      status: () => ({ connected: true, publicReady: true, privateReady: !!input.credentials && f.privateReady,
        deadManReady: !!input.credentials && f.deadManReady !== false, lastFrameAt: f.time, error: null }) };
  };
  const mm = createOndoMarketMaker({ dataDir, readCredentials: () => f.key, log: silent, now: () => f.time, monotonicNow: () => f.time - EPOCH, intervalMs: 0, clientFactory, streamFactory,
    readMaintenance: () => f.maintenance, readAdmission: () => f.admission, sleep: async ms => { f.time += ms; }, ...options.manager });
  const levels = rows => rows.map(([price, size]) => [u(price), u(size)]);
  f.push = (bids = BIDS, asks = ASKS, source = f.time) => { f.book = [bids, asks]; f.stream.onBook(MARKET, { time: source, bids: levels(bids), asks: levels(asks) }, f.time); };
  f.rounds = async (n = 1, ms = 300) => { for (let i = 0; i < n; i++) { f.time += ms; if (f.book && !f.frozen) f.push(...f.book); await mm.tick(); } };
  f.resting = () => v.orders.map(order => `${order.side} ${order.size}@${order.price}${order.reduceOnly ? ' close' : ''}`).sort();
  f.live = async (extra = {}) => {
    f.key = KEY; mm.initialize(); mm.save(config(extra));
    await mm.start({ revision: mm.state().revision, confirmLive: true, confirmAccountWide: true });
    f.push(); await f.rounds(4);
  };
  f.market = () => mm.state().markets[0];
  return { f, v, mm, count };
}
const status = code => error => error.status === code;

function splitMakerFixture(t) {
  const link = { callbacks: null, privateOptions: null, lease: 'first', generation: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', expired: 0, frame: null };
  const market = { epoch: () => link.lease, stream(_op, request, listener) {
    assert.deepEqual(request, { markets: [MARKET], depth: 50, trades: false, metrics: true });
    link.callbacks = listener; listener.data({ type: 'ready', generation: link.generation, at: f.time });
    return () => {};
  } };
  const { f, v, mm, count } = fixture({ manager: { streamFactory: options => remoteOndoStream(market, options, input => {
    link.privateOptions = input;
    return { start() {}, close() {}, expireOrders() { link.expired++; }, status: () => ({ connected: true, privateReady: true, deadManReady: true }) };
  }) } });
  t.after(() => mm.close(0));
  const wire = rows => rows.map(row => row.map(value => u(value).toString()));
  f.push = (bids = BIDS, asks = ASKS, time = f.time) => {
    f.book = [bids, asks];
    link.frame = { type: 'book', generation: link.generation, market: MARKET, at: f.time, book: { time, bids: wire(bids), asks: wire(asks) } };
    link.callbacks.data(link.frame);
  };
  return { f, v, mm, count, link };
}

test('a public outage withdraws accepted Ondo quotes while the same private session keeps reconciling', async t => {
  const { f, v, mm, count, link } = splitMakerFixture(t);
  await f.live(); assert.equal(count('place'), 2);
  assert.equal(link.privateOptions.privateOnly, true); assert.deepEqual(link.privateOptions.markets, []);
  const original = link.frame, ids = v.orders.map(order => order.id), reads = count('open');
  link.lease = null; link.callbacks.down();
  // A late frame from the former socket cannot repopulate the book between scheduler ticks.
  link.callbacks.data(original); f.frozen = true;
  await f.rounds(1, 1500);
  assert.equal(f.market().bid, null);
  assert.deepEqual(v.calls.filter(call => call[0] === 'cancel').map(call => call[1]).sort(), ids.sort());
  assert.ok(count('open') > reads); assert.equal(link.expired, 0); assert.equal(mm.state().stream.deadManReady, true);
  link.lease = 'second'; link.generation = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  link.callbacks.data({ type: 'ready', generation: link.generation, at: f.time });
  link.callbacks.data({ ...original, at: f.time }); link.callbacks.data({ ...original, generation: link.generation, at: f.time });
  await f.rounds(3); assert.equal(count('place'), 2); assert.equal(f.market().bid, null);
  f.frozen = false; await f.rounds(5); assert.equal(count('place'), 4);
});

test('an invalid snapshot in the current generation withdraws accepted quotes and revokes a queued create even after immediate recovery', async t => {
  for (const damage of [
    (frame, at) => { frame.book.time = at + 1501; },
    (frame, at) => { frame.book.time = at - 10001; },
    (frame, at) => { frame.book.time = at - 1; },
    frame => { frame.book.bids = []; },
    frame => { frame.book.asks[0][0] = 'invalid'; },
    (frame, at) => { frame.at = at + 2000; },
  ]) {
    const { f, v, link } = splitMakerFixture(t);
    const interruptBook = () => {
      const invalid = structuredClone(link.frame); damage(invalid, f.time); link.callbacks.data(invalid);
      assert.equal(f.market().bid, null); assert.equal(f.market().bookAt, null);
      // A repeat of the formerly valid source time cannot refresh it.
      link.callbacks.data(link.frame); assert.equal(f.market().bookAt, null);
      f.time++; f.push(); assert.equal(f.market().bid, '200');
    };
    let queued;
    v.beforeSend = input => {
      if (queued || input.side !== 'buy') return;
      queued = input.clientOrderId; interruptBook();
    };
    await f.live(); assert.ok(queued);
    assert.ok(!v.calls.some(([method, order]) => method === 'place' && order.clientOrderId === queued));
    await f.rounds(6);
    const resting = v.orders.map(order => order.id); assert.equal(resting.length, 2);
    const wrong = structuredClone(link.frame); wrong.generation = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'; damage(wrong, f.time);
    link.callbacks.data(wrong); assert.equal(f.market().bid, '200');
    interruptBook();
    assert.ok(resting.every(id => v.calls.some(([method, value]) => method === 'cancel' && value === id)));
  }
});

test('configuration is validated as a whole', () => {
  assert.deepEqual(validateOndoMmConfig(config()), config());
  for (const bad of [{ minBps: '4' }, { maxBps: '4' }, { maxBps: '26' }, { markets: [] }, { markets: ['nvda'] }, { markets: [MARKET, MARKET] }, { orderUsd: '0' }, { orderUsd: 100 },
    { maxPositionUsd: '50' }, { maxTotalUsd: '50' }, { mode: 'real' }, { rps: 50 }, { dwellMs: -1 }, { wallEnabled: 'yes' }, { extra: 1 }, { targetBps: '4.00001' }]) assert.throws(() => validateOndoMmConfig(config(bad)), JSON.stringify(bad));
  const { orderUsd, ...partial } = config();
  assert.throws(() => validateOndoMmConfig(partial));
});

test('v0.61 settings retain their sizes and revision, acquire strict protection, and round-trip the exit policy', () => {
  const { f, mm } = fixture();
  const { maxHoldSec, maxLossBps, exitMode, exitSlippageBps, ...legacy } = config({ orderUsd: '73', maxTotalUsd: '446', wallEnabled: false, wallUsd: '0' });
  const dir = join(f.dataDir, 'ondo-mm'); mkdirSync(dir, { recursive: true });
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ revision: 11, config: legacy }));
  mm.initialize();
  const settings = mm.state().config;
  assert.equal(mm.state().phase, 'stopped'); assert.equal(mm.state().revision, 11);
  assert.equal(settings.wallEnabled, true); assert.equal(settings.wallUsd, '5000');
  assert.equal(settings.maxTotalUsd, '446'); assert.equal(settings.orderUsd, '73'); assert.equal(settings.maxHoldSec, maxHoldSec);
  assert.throws(() => mm.save({ ...settings, wallEnabled: false }), status(400));
  assert.throws(() => mm.save({ ...settings, wallUsd: '0' }), status(400));
  assert.throws(() => mm.save({ ...settings, maxHoldSec: 0 }), status(400));
  mm.save({ ...settings, maxHoldSec: 17, exitMode: 'makerThenManual' });
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file)).config).sort(), Object.keys(legacy).sort());
  const restarted = fixture({ dataDir: f.dataDir }).mm; restarted.initialize();
  assert.deepEqual(restarted.state().config, { ...settings, maxHoldSec: 17, exitMode: 'makerThenManual' });
});

test('observe mode computes quotes and sends nothing', async () => {
  const { f, v, mm, count } = fixture();
  mm.initialize(); mm.save(config({ mode: 'observe' }));
  assert.equal(mm.state().observation, null);
  await mm.start({ revision: 1 });
  assert.equal(f.stream.credentials, null);
  f.push(); await f.rounds(3);
  const market = f.market();
  assert.equal(market.hold, null);
  assert.deepEqual([market.buy.state, market.buy.price, market.sell.price], ['planned', '199.93', '200.11']);
  assert.equal(count('place') + count('open') + count('positions') + count('cancel'), 0);
  assert.equal(v.orders.length, 0);
  const priced = levels => levels.map(([price, size]) => [u(price), u(size)]);
  f.time += 100;
  f.stream.onBook(MARKET, { time: f.time + 600, bids: priced(BIDS), asks: priced(ASKS) }, f.time);
  await mm.tick();
  assert.equal(f.market().hold, null);
  f.stream.onTrade(MARKET, { id: 'sweep', time: f.time + 600, price: u('199.92'), aggressorSide: 'sell' }, f.time);
  const stopped = await mm.stop();
  assert.equal(stopped.phase, 'stopped'); assert.equal(stopped.observation.endedAt, f.time);
  assert.equal(stopped.observation.rows.find(row => row.side === 'buy' && row.distanceBps === 4).sweeps, 1);
  f.time += 60_000;
  assert.deepEqual(mm.state().observation, stopped.observation);
});

test('parallel observation subscribes listed and trading markets on one public feed without changing trading configuration', async () => {
  const { f, v, mm, count } = fixture({ key: KEY });
  mm.initialize();
  const markets = [MARKET, ...Array.from({ length: 19 }, (_, i) => `OBS${i}-USD.P`)];
  for (const name of markets.slice(1, -1)) v.rules.set(name, { ...v.rules.get(MARKET), trading: true });
  v.rules.get(markets[1]).trading = false;
  for (const invalid of [[], [MARKET, MARKET], [false], [...markets, 'EXTRA-USD.P']]) await assert.rejects(mm.start({ revision: 0, observeMarkets: invalid }), status(400));
  const state = await mm.start({ revision: 0, observeMarkets: markets });
  assert.deepEqual(state.config.markets, [MARKET]); assert.deepEqual(state.activeConfig.markets, markets);
  assert.deepEqual(f.stream.markets, [MARKET, ...markets.slice(2, -1)]); assert.equal(f.stream.credentials, null);
  assert.equal(state.observation.rows.length, 120); assert.equal(state.markets.at(-1).hold, 'unknown_market'); assert.equal(state.markets[1].hold, 'market_closed');
  const prior = f.stream;
  v.rules.get(markets[1]).trading = true; v.rules.delete(MARKET);
  f.time += 60_000; await mm.tick();
  assert.deepEqual(f.stream.markets, markets.slice(1, -1)); assert.equal(f.streamClosed, 1);
  prior.onBook(MARKET, { time: f.time, bids: [[u('99'), u('1')]], asks: [[u('100'), u('1')]] }, f.time);
  assert.equal(mm.state().markets[0].bid, null);
  // No order, account read or persisted trade permission, including on a host which does have credentials.
  assert.equal(v.calls.length, count('markets')); assert.equal(existsSync(join(f.dataDir, 'ondo-mm', 'config.json')), false);
  await mm.stop({ sessionId: state.sessionId, live: false });
  assert.throws(() => mm.save(config({ markets })), status(400));
  mm.save(config());
  await assert.rejects(mm.start({ revision: 1, confirmLive: true, confirmAccountWide: true, observeMarkets: [MARKET] }), status(400));
  assert.equal(v.calls.length, count('markets')); assert.equal(mm.state().phase, 'stopped');
});

test('an observation waits for public rules, retries a failure and fences a rule response across stop', async () => {
  const { f, v, mm } = fixture(); mm.initialize();
  v.rulesError = new OndoError('upstream');
  const failed = await mm.start({ revision: 0, observeMarkets: [MARKET, 'OLD-USD.P'] });
  assert.equal(failed.rulesError, 'upstream'); assert.equal(failed.markets[0].hold, 'no_rules'); assert.equal(f.stream, null);
  v.rulesError = null; f.time += 60_000; await mm.tick();
  assert.deepEqual(f.stream.markets, [MARKET]); assert.equal(mm.state().rulesError, null);
  await mm.stop({ sessionId: failed.sessionId, live: false });
  let release; v.rulesGate = new Promise(resolve => { release = resolve; });
  const pending = mm.start({ revision: 0, observeMarkets: [MARKET] });
  const warming = mm.state(); assert.equal(warming.stream, null);
  const stopped = await mm.stop({ sessionId: warming.sessionId, live: false });
  release(); await assert.rejects(pending, status(409));
  assert.equal(f.streamClosed, 1); assert.deepEqual(mm.state().observation, stopped.observation);
});

test('a live start needs confirmation, the saved revision, credentials and an open gate', async () => {
  const { f, mm, count } = fixture();
  mm.initialize(); mm.save(config());
  await assert.rejects(mm.start({ revision: 1, confirmLive: true, confirmAccountWide: true }), status(409));
  f.key = KEY;
  assert.ok(!JSON.stringify(mm.state()).includes(SECRET));
  await assert.rejects(mm.start({ revision: 1 }), status(400));
  await assert.rejects(mm.start({ revision: 0, confirmLive: true, confirmAccountWide: true }), status(409));
  f.maintenance = true;
  await assert.rejects(mm.start({ revision: 1, confirmLive: true, confirmAccountWide: true }), status(409));
  f.maintenance = false; f.admission = false;
  await assert.rejects(mm.start({ revision: 1, confirmLive: true, confirmAccountWide: true }), status(409));
  assert.equal(mm.state().phase, 'stopped'); assert.equal(count('markets'), 0);
  assert.equal(existsSync(join(f.dataDir, 'ondo-mm', 'session.json')), false);
});

test('a wall vanishing for a single frame withdraws only the affected opening order before the next tick', async () => {
  const { f, v, mm } = fixture();
  await f.live({ wallUsd: '5000', dwellMs: 60_000 });
  assert.equal(f.stream.onTrade, undefined);
  const buy = v.orders.find(order => order.side === 'buy');
  const ask = v.orders.find(order => order.side === 'sell');
  f.time += 20;
  // Even enormous size at the order's own price cannot protect it.
  f.push([['200', '1'], ['199.93', '10000']], ASKS);
  f.time += 20; f.push();
  assert.deepEqual(v.calls.filter(([method]) => method === 'cancel').map(([, id]) => id), [buy.id]);
  assert.ok(v.orders.some(order => order.id === ask.id));
  await mm.tick();
});

test('a recovered wall cannot release a queued opening or leave an already-sent opening on the venue', async () => {
  for (const stage of ['beforeSend', 'onPlace']) {
    const { f, v } = fixture();
    let clientId = null, id = null;
    v[stage] = (input, placed) => {
      if (clientId || input.side !== 'buy') return;
      clientId = input.clientOrderId; id = placed?.id;
      f.time += 10; f.push([['200', '1']], ASKS);
      f.time += 10; f.push();
    };
    await f.live({ wallUsd: '5000' });
    assert.ok(clientId);
    if (stage === 'beforeSend') assert.ok(!v.calls.some(([method, placed]) => method === 'place' && placed.clientOrderId === clientId));
    else assert.ok(v.calls.some(([method, canceled]) => method === 'cancel' && canceled === id));
    assert.ok(!v.orders.some(order => order.clientId === clientId));
  }
});

test('canceled size in an old depth cannot fund a new opening, including duplicate and delayed venue frames', async () => {
  for (const venueTimestamp of [true, false]) {
    const { f, v, mm } = fixture();
    await f.live({ wallUsd: '5000' });
    const old = v.orders.find(order => order.side === 'buy');
    const bids = [['199.95', '25'], ['199.93', old.size]], asks = [['199.96', '100']];
    f.time += 10;
    const changed = f.time, through = changed + (venueTimestamp ? 400 : 1500);
    v.onCancel = order => venueTimestamp ? { ...order, canceledAt: through } : order;
    f.push(bids, asks); await mm.tick();
    assert.ok(!v.orders.some(order => order.side === 'buy'));
    for (const source of [changed, changed + 1, through]) {
      f.time = Math.max(f.time + 100, source);
      f.push(bids, asks, source); await mm.tick();
      assert.ok(!v.orders.some(order => order.side === 'buy'));
      assert.equal(f.market().buy.reason, 'unprotected');
    }
    f.time += 1; f.push(bids, asks, through + 1); await mm.tick();
    assert.equal(v.orders.find(order => order.side === 'buy')?.price, '199.87');
    assert.equal(f.market().buy.protection, '5098.715');
  }
});

test('the queued replacement rechecks external depth with the canceled amount still deducted', async () => {
  const { f, v, mm } = fixture();
  await f.live({ wallUsd: '5000' });
  const old = v.orders.find(order => order.side === 'buy'), asks = [['199.96', '100']];
  let queued;
  v.beforeSend = input => {
    if (input.side !== 'buy') return;
    queued = input.clientOrderId;
    f.time += 1;
    f.push([['199.95', '25'], ['199.93', old.size]], asks);
  };
  f.time += 1; f.push([['199.95', '26'], ['199.93', old.size]], asks);
  await mm.tick();
  assert.ok(queued);
  assert.ok(!v.calls.some(([method, order]) => method === 'place' && order.clientOrderId === queued));
});

test('a terminal lookup after an open-order disappearance retains its old depth debit', async () => {
  const { f, v, mm } = fixture();
  await f.live({ wallUsd: '5000' });
  const old = v.orders.find(order => order.side === 'buy');
  v.orders = v.orders.filter(order => order !== old);
  const settled = f.time + 1800;
  v.history.set(old.clientId, { ...old, status: 'canceled', canceledAt: settled });
  f.stream.onPrivate('ordersPerps', [{ market: MARKET, clientOrderId: old.clientId, status: 'canceled', filledSize: '0', cancelReason: 'user' }]);
  f.time += 1100; f.push(); await mm.tick();
  f.time += 5;
  const bids = [['199.95', '25'], ['199.93', old.size]], asks = [['199.96', '100']];
  f.push(bids, asks); await mm.tick();
  assert.ok(v.calls.some(([method, id]) => method === 'lookup' && id === old.clientId));
  f.time += 1001; f.push(bids, asks, settled); await mm.tick(); await mm.tick();
  assert.equal(f.market().buy.reason, 'unprotected');
  assert.ok(!v.orders.some(order => order.side === 'buy'));
});

test('a one-sided frame invalidates both openings even if a full snapshot follows immediately', async () => {
  const { f, v } = fixture();
  await f.live();
  const original = v.orders.map(order => order.id).sort();
  f.time += 5; f.push([], ASKS);
  f.time += 5; f.push();
  assert.deepEqual(v.calls.filter(([method]) => method === 'cancel').map(([, id]) => id).sort(), original);
});

test('rate-limited account holds preserve the original wall-withdrawal timer through retries', async () => {
  const { f, v, mm } = fixture();
  await f.live({ wallUsd: '5000' });
  const buy = v.orders.find(o => o.side === 'buy'), at = f.time + 1;
  v.cancelError = new OndoError('rate_limited', { status: 429 });
  f.time = at; f.push([['200.00', '1']], ASKS);
  await new Promise(resolve => setImmediate(resolve));
  v.cooldown = at + 2000; f.time = at + 1100; f.push([['200.00', '1']], ASKS);
  await mm.tick();
  v.cancelError = null; f.time = at + 3200; f.push([['200.00', '1']], ASKS);
  await mm.tick(); await new Promise(resolve => setImmediate(resolve));
  assert.ok(!v.orders.some(order => order.id === buy.id));
  const withdraw = mm.state().latency.markets[0].withdraw;
  assert.ok(withdraw.n > 0); assert.equal(withdraw.p95Ms, 3200);
});

test('live quotes rest on both sides inside the band and follow the book', async () => {
  const { f, v, mm, count } = fixture();
  await f.live();
  assert.deepEqual(f.resting(), ['buy 0.5@199.93', 'sell 0.49@200.11']);
  assert.ok(v.calls.filter(call => call[0] === 'place').every(call => call[1].clientOrderId.startsWith('tpo-') && call[1].reduceOnly === false));
  assert.equal(existsSync(join(f.dataDir, 'ondo-mm', 'session.json')), true);
  assert.throws(() => mm.save(config()), status(409));
  // A calm book changes nothing.
  await f.rounds(10);
  assert.equal(count('place'), 2); assert.equal(count('cancel'), 0);
  // The venue's book shows the two quotes themselves: they are not mistaken for outside liquidity.
  f.push([...BIDS.slice(0, 3), ['199.93', '0.5']], [...ASKS, ['200.11', '0.49']]);
  await f.rounds(10);
  assert.equal(count('place'), 2); assert.equal(count('cancel'), 0);
  assert.equal(f.market().buy.protection, '25994.6');
  f.push();
  // The market drops: the buy is 1.5 bps from the mid and is replaced at once; the sell is merely far and waits out the dwell time.
  v.onCancel = order => { f.time += 7; return order; };
  v.onPlace = () => { f.time += 11; };
  f.push([['199.94', '10']], [['199.98', '10']]);
  await f.rounds(1);
  assert.deepEqual(f.resting(), ['buy 0.5@199.88', 'sell 0.49@200.11']);
  assert.equal(f.market().sell.reason, 'too_far');
  let stats = mm.state().latency.markets[0];
  assert.deepEqual([stats.withdraw.n, stats.withdraw.lastMs, stats.replace.n], [1, 7, 0]);
  await f.rounds(6);
  assert.deepEqual(f.resting(), ['buy 0.5@199.88', 'sell 0.49@200.04']);
  assert.equal(count('place'), 4); assert.equal(count('cancel'), 2);
  stats = mm.state().latency.markets[0];
  assert.deepEqual([stats.replace.n, stats.replace.lastMs, stats.replace.failed], [1, 18, 0]);
  const stopped = await mm.stop();
  assert.equal(stopped.latency.mode, 'live'); assert.equal(stopped.latency.stoppedAt, f.time);
  f.time += 600_000;
  assert.deepEqual(mm.state().latency, stopped.latency);
});

test('replacement excludes a rejected, unknown, pending or partially filled leg and never matches a later tick', async t => {
  for (const scenario of ['new rejected', 'new unknown', 'new pending', 'new partial', 'old partial', 'old cancel failed', 'mid-request stop', 'mid-request book gap']) {
    await t.test(scenario, async () => {
      const { f, v, mm } = fixture();
      await f.live({ dwellMs: 0 });
      await f.rounds(3, 300);
      let stopping;
      v.onCancel = old => {
        if (old.side === 'sell' && scenario === 'old partial') return { ...old, filled: '0.01' };
        if (old.side === 'sell' && scenario === 'old cancel failed') throw new OndoError('timeout', { uncertain: true });
        return old;
      };
      v.onPlace = input => {
        if (input.side !== 'sell') return;
        if (scenario === 'new rejected') return { rests: false, error: new OndoError('post_only_has_match') };
        if (scenario === 'new unknown') return { rests: false, error: new OndoError('timeout', { uncertain: true }) };
        if (scenario === 'new pending') return { report: { status: 'pending' } };
        if (scenario === 'new partial') return { report: { filled: '0.01' } };
        if (scenario === 'mid-request stop') stopping = mm.stop();
        if (scenario === 'mid-request book gap') { f.push([], ASKS); f.push([['199.94', '10']], [['199.98', '10']]); }
      };
      f.push([['199.94', '10']], [['199.98', '10']]); await mm.tick();
      if (stopping) await stopping;
      let metric = mm.state().latency.markets[0].replace;
      assert.deepEqual([metric.n, metric.failed, metric.lastMs], [0, 1, null]);
      if (scenario === 'new rejected') {
        v.onPlace = null; await f.rounds(4, 300);
        assert.ok(v.orders.some(order => order.side === 'sell' && order.price === '200.04'));
        metric = mm.state().latency.markets[0].replace;
        assert.deepEqual([metric.n, metric.failed], [0, 1]);
      }
    });
  }
});

test('private data without the venue dead-man acknowledgement cannot authorize a quote', async () => {
  const { f, v, count } = fixture();
  f.deadManReady = false; await f.live();
  assert.equal(f.market().hold, 'dead_man_switch'); assert.equal(count('place'), 0);
  f.deadManReady = true; await f.rounds();
  assert.equal(v.orders.length, 2);
  f.deadManReady = false; await f.rounds();
  assert.equal(f.market().hold, 'dead_man_switch'); assert.deepEqual(v.orders, []);
});

test('a stale stop from another tab cannot stop a newer live session', async () => {
  const { f, v, mm } = fixture();
  mm.initialize();
  const observed = await mm.start({ revision: 0 });
  await mm.stop({ sessionId: observed.sessionId, live: false });
  await f.live();
  await assert.rejects(mm.stop({ sessionId: observed.sessionId, live: false }), status(409));
  await assert.rejects(mm.stop({}), status(409));
  assert.equal(mm.state().live, true); assert.equal(v.orders.length, 2);
  await mm.stop({ sessionId: mm.state().sessionId, live: true });
  assert.equal(v.orders.length, 0);
});

test('an out-of-scope legacy quote appearing after startup cannot keep the account heartbeat alive', async () => {
  const { f, v, mm } = fixture();
  await f.live({ wallUsd: '1000000' }); assert.equal(v.orders.length, 0);
  v.orders.push({ market: 'TSLA-USD.P', id: 'stray', clientId: 'tpo-older-1', side: 'buy', size: '1', price: '300', filled: '0', status: 'open', reduceOnly: false });
  v.cancelError = new OndoError('timeout', { uncertain: true });
  await f.rounds(6, 1000);
  assert.equal(mm.state().stream.deadManReady, false); assert.equal(f.expiry(), false);
  v.orders = []; await f.rounds(7, 1000); assert.equal(f.expiry(), true);
  assert.equal(mm.state().incident.market, 'TSLA-USD.P');
});

test('a foreign private order stops renewal while REST is down; a new order invalidates even an earlier all-clear', async () => {
  const { f, v, mm } = fixture();
  await f.live({ wallUsd: '1000000' });
  const stray = { market: 'TSLA-USD.P', clientOrderId: 'tpo-older-1', orderId: 'stray1', status: 'open', filledSize: '0' };
  v.readError = new OndoError('network'); f.stream.onPrivate('ordersPerps', [stray]);
  assert.equal(mm.state().stream.deadManReady, false);
  const canReconnect = f.expiry; assert.equal(canReconnect(), false);
  v.readError = null; await f.rounds(6, 1000); assert.equal(canReconnect(), true);

  let release;
  v.positionsGate = new Promise(r => { release = r; });
  v.orders.push({ market: stray.market, clientId: stray.clientOrderId, id: stray.orderId, side: 'buy', size: '1', price: '300', filled: '0', status: 'open', reduceOnly: false });
  f.time += 6000; const nonempty = mm.tick();
  await new Promise(r => setImmediate(r));
  assert.equal(canReconnect(), false, 'the order list arrives before the pending positions read');
  release(); await nonempty;
  v.orders = []; await f.rounds(6, 1000); assert.equal(canReconnect(), true);

  v.positionsGate = new Promise(r => { release = r; });
  f.time += 6000; const oldEmpty = mm.tick();
  await new Promise(r => setImmediate(r)); f.stream.onPrivate('ordersPerps', [stray]);
  release(); await oldEmpty;
  assert.equal(canReconnect(), false, 'a flat snapshot started before the new private order is not authoritative');
  await f.rounds(3, 1000); assert.equal(canReconnect(), true);
});

test('an untracked open order freezes quotes before its apparent liquidity can provide protection', async () => {
  const { f, mm, count } = fixture();
  await f.live({ wallUsd: '5000' }); const placed = count('place');
  f.stream.onPrivate('ordersPerps', [{ market: MARKET, clientOrderId: 'manual', orderId: 'other', status: 'open', filledSize: '0' }]);
  f.push([['200', '25']], [['200.04', '25']]); await f.rounds(5);
  assert.match(mm.state().incident.reason, /其他永续挂单/); assert.equal(count('place'), placed); assert.deepEqual(f.resting(), []);
});

test('an empty account read that crosses the freshness deadline cannot reauthorize a disconnected session', async () => {
  const { f, v, mm } = fixture();
  await f.live({ wallUsd: '1000000' });
  f.stream.onPrivate('ordersPerps', [{ market: 'TSLA-USD.P', clientOrderId: 'external', status: 'open' }]);
  await f.rounds(6, 1000); const allowed = f.expiry;
  assert.equal(allowed(), true);
  let release;
  v.positionsGate = new Promise(r => { release = r; });
  f.time += 6000; const slow = mm.tick(); await new Promise(r => setImmediate(r));
  f.time += 16_000; assert.equal(allowed(), false);
  release(); await slow;
  assert.equal(allowed(), false); assert.equal(mm.state().syncError, 'account_read_stale');
  await f.rounds(2, 1000); assert.equal(allowed(), true);
});

test('repeated failed cancellations stop the heartbeat even when private data is flowing', async () => {
  const { f, v, mm } = fixture();
  await f.live(); v.cancelError = new OndoError('cancel_refused', { status: 400 });
  f.stream.onPrivate('fillsPerps', [{ market: MARKET, side: 'buy', size: '0.1', price: '199.93' }]);
  await f.rounds(6, 1100);
  assert.equal(mm.state().stream.deadManReady, false); assert.equal(f.expiry(), false);
  v.cancelError = null; v.orders = []; await f.rounds(18, 1100);
  assert.equal(f.expiry(), true); assert.ok(mm.state().incident);
});

test('adopting a known position permits only reductions even if the next REST snapshot is flat', async () => {
  const { f, v, mm, count } = fixture();
  f.key = KEY; mm.initialize(); mm.save(config());
  v.positions.set(MARKET, '0.1'); v.afterPreflight = () => v.positions.clear();
  await mm.start({ revision: 1, confirmLive: true, confirmAccountWide: true, adoptPositions: true });
  f.push(); await f.rounds(5);
  assert.ok(mm.state().incident); assert.equal(count('place'), 0);
});

test('an ambiguous withdrawal with both lookup and REST offline cannot keep the venue timer alive', async () => {
  const { f, v, mm } = fixture();
  await f.live();
  v.cancelError = new OndoError('timeout', { uncertain: true });
  v.lookupError = v.readError = new OndoError('network');
  f.push([], []); await f.rounds(17, 1000);
  assert.equal(mm.state().stream.deadManReady, false); assert.equal(f.expiry(), false);
});

test('a fill locks all new exposure, including after the maker close brings the account back to flat', async () => {
  const { f, v, mm, count } = fixture();
  await f.live();
  v.orders = v.orders.filter(order => order.side !== 'buy'); v.positions.set(MARKET, '0.5');
  f.stream.onPrivate('fillsPerps', [{ market: MARKET, side: 'buy', size: '0.5', price: '199.93' }]);
  await f.rounds(7);
  assert.deepEqual(f.resting(), ['sell 0.5@200.04 close']);
  assert.ok(mm.state().incident); assert.equal(f.market().position, '0.5');
  // The touch moves away: the close stays the best price. It moves toward: the close follows.
  f.push(BIDS, [['200.06', '20']]);
  await f.rounds(5);
  assert.deepEqual(f.resting(), ['sell 0.5@200.04 close']);
  v.orders = []; v.positions.delete(MARKET);
  f.stream.onPrivate('fillsPerps', [{ market: MARKET, side: 'sell', size: '0.5', price: '200.04' }]);
  f.push(); await f.rounds(5);
  assert.deepEqual(f.resting(), []);
  assert.equal(count('place'), 3);
  assert.equal(mm.state().incident.market, MARKET);
});

test('a short position is closed by a reduce-only buy that follows the bid up', async () => {
  const { f, v } = fixture();
  await f.live();
  v.orders = v.orders.filter(order => order.side !== 'sell'); v.positions.set(MARKET, '-0.49');
  f.stream.onPrivate('positionsPerps', [{ market: MARKET, direction: 'short', netQuantity: '0.49' }]);
  await f.rounds(7);
  assert.deepEqual(f.resting(), ['buy 0.49@200 close']);
  f.push([['200.02', '5'], ...BIDS], ASKS);
  await f.rounds(6);
  assert.deepEqual(f.resting(), ['buy 0.49@200.02 close']);
});

async function adoptedPosition({ f, v, mm }, position, extra = {}) {
  v.positions.set(MARKET, position); v.entries.set(MARKET, '200'); f.key = KEY;
  mm.initialize(); mm.save(config(extra));
  await mm.start({ revision: 1, confirmLive: true, confirmAccountWide: true, adoptPositions: true });
  f.push(); await f.rounds(4);
}

test('a partial private order update immediately withdraws opening orders in all markets and latches across a reconnect', async () => {
  const notices = [], other = 'TSLA-USD.P';
  const { f, v, mm, count } = fixture({ manager: { notifyRisk: (key, text) => notices.push({ key, text }) } });
  v.rules.set(other, { tick: '0.01', step: '0.01', trading: true });
  await f.live({ markets: [MARKET, other] });
  f.stream.onBook(other, { time: f.time, bids: [[u('200'), u('100')]], asks: [[u('200.04'), u('100')]] }, f.time);
  await f.rounds(2);
  assert.equal(v.orders.length, 4);
  const filled = v.orders.find(order => order.market === other);
  filled.filled = '0.1';
  f.stream.onPrivate('ordersPerps', [{ market: other, clientOrderId: filled.clientId, status: 'open', filledSize: '0.1' }]);
  assert.equal(mm.state().incident.market, other);
  assert.equal(count('cancel'), 4);
  assert.equal(notices.length, 1);
  assert.deepEqual(v.orders, []);
  f.stream.onDown('disconnected'); f.push(); await f.rounds(25);
  assert.equal(count('place'), 4); assert.equal(mm.state().incident.market, other);
});

test('a placement or cancel response can report the first opening fill before positions or the websocket sees it', async () => {
  for (const source of ['place', 'cancel', 'already_filled', 'lookup']) {
    const { f, v, mm, count } = fixture();
    if (source === 'place') v.onPlace = () => ({ report: { filled: '0.1' } });
    if (source === 'lookup') v.onPlace = (_input, order) => {
      v.history.set(order.clientId, { ...order, status: 'fullyfilled', filled: order.size });
      return { rests: false, error: new OndoError('timeout', { uncertain: true }) };
    };
    await f.live();
    if (source === 'cancel' || source === 'already_filled') {
      if (source === 'cancel') v.onCancel = order => ({ ...order, filled: '0.1' });
      else v.cancelError = new OndoError('order_already_fully_filled');
      f.push([['200.08', '10']], [['200.12', '10']]); await f.rounds(1);
    }
    await f.rounds(12);
    assert.equal(mm.state().incident?.market, MARKET, source);
    const placed = count('place');
    await f.rounds(20);
    assert.equal(count('place'), placed, source);
  }
});

test('a partial REST order locks the session before its pending positions read finishes', async () => {
  const { f, v, mm, count } = fixture(); await f.live();
  v.orders[0].filled = '0.1';
  let release; v.positionsGate = new Promise(resolve => { release = resolve; });
  f.time += 5001; f.push(); const running = mm.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(mm.state().incident?.market, MARKET);
  assert.equal(count('cancel'), 2);
  release(); await running;
  assert.deepEqual(v.orders, []); assert.equal(count('cancel'), 2);
});

test('an opening placement waiting in the HTTP queue fails its send guard as soon as a different market reports exposure', async () => {
  const { f, v, mm, count } = fixture();
  v.beforeSend = () => f.stream.onPrivate('positionsPerps', [{ market: 'TSLA-USD.P', direction: 'long', netQuantity: '1' }]);
  await f.live();
  assert.equal(count('place'), 0); assert.equal(mm.state().incident?.market, 'TSLA-USD.P');
});

test('the executable loss threshold switches both directions to bounded reduce-only IOC and rereads the residual after a partial fill', async () => {
  for (const long of [true, false]) {
    const setup = fixture(), { f, v, mm } = setup;
    await adoptedPosition(setup, long ? '0.5' : '-0.5');
    assert.equal(v.orders.length, 1); assert.ok(v.orders[0].reduceOnly);
    const sent = [];
    v.onPlace = (input, order) => {
      assert.equal(input.timeInForce, 'IOC'); assert.ok(input.reduceOnly); sent.push(input);
      if (sent.length === 1) return { rests: false, report: { status: 'canceled', filled: '0.2' } };
      v.positions.clear();
      return { rests: false, report: { status: 'fullyfilled', filled: order.size } };
    };
    // The mid is within 2 bps of the entry. Only the price the position can trade at has lost 20 bps.
    f.push([[(long ? '199.58' : '199.64'), '50']], [[(long ? '200.40' : '200.42'), '50']]);
    await f.rounds(18);
    assert.equal(sent.length, 1); assert.equal(sent[0].price, long ? '199.39' : '200.62');
    assert.equal(sent[0].side, long ? 'sell' : 'buy'); assert.equal(sent[0].size, '0.5');
    assert.match(f.market().exitStatus, /核对剩余仓位/);
    v.positions.set(MARKET, long ? '0.3' : '-0.3');
    f.stream.onPrivate('positionsPerps', [{ market: MARKET, direction: long ? 'long' : 'short', netQuantity: '0.3' }]);
    await f.rounds(25);
    assert.deepEqual(sent.map(input => input.size), ['0.5', '0.3']);
    assert.equal(f.market().position, '0'); assert.ok(mm.state().incident); assert.deepEqual(v.orders, []);
  }
});

test('the manual deadline withdraws the maker close even with a stale book and notifies only once', async () => {
  const notices = [], setup = fixture({ manager: { notifyRisk: (_key, text) => notices.push(text) } }), { f, v } = setup;
  await adoptedPosition(setup, '0.5', { maxHoldSec: 3, exitMode: 'makerThenManual' });
  assert.equal(v.orders.length, 1); f.frozen = true;
  await f.rounds(20);
  assert.deepEqual(v.orders, []); assert.match(f.market().exitStatus, /人工接手.*最长持仓/);
  f.frozen = false; await f.rounds(20);
  assert.deepEqual(v.orders, []);
  assert.equal(notices.filter(value => value.includes('请人工接手')).length, 1);
});

test('a late individual fill for a terminal IOC blocks another order until the position reflects it, even when delivered twice', async () => {
  const setup = fixture(), { f, v } = setup;
  await adoptedPosition(setup, '0.5', { maxHoldSec: 3 });
  const sent = [];
  v.onPlace = (input, order) => {
    sent.push(order);
    if (sent.length > 1) { v.positions.clear(); return { rests: false, report: { status: 'fullyfilled', filled: order.size } }; }
    return { rests: false, report: { status: 'canceled', filled: '0' } };
  };
  for (let i = 0; i < 20 && !sent.length; i++) await f.rounds(1);
  assert.equal(sent.length, 1);
  const row = { id: 'late_trade', market: MARKET, orderId: sent[0].id, direction: 'closeLong', side: 'sell', size: '0.2', price: '200' };
  f.stream.onPrivate('fillsPerps', [row, row]);
  await f.rounds(15);
  assert.equal(sent.length, 1); assert.match(f.market().exitStatus, /核对剩余仓位/);
  v.positions.set(MARKET, '0.3');
  f.stream.onPrivate('positionsPerps', [{ market: MARKET, direction: 'long', netQuantity: '0.3' }]);
  await f.rounds(18);
  assert.deepEqual(sent.map(order => order.size), ['0.5', '0.3']);
});

test('IOC retries are bounded and neither an unknown IOC nor an unconfirmed maker cancel is followed by another exit order', async () => {
  for (const result of ['canceled', 'uncertain', 'cancelUnknown']) {
    const setup = fixture(), { f, v } = setup, sent = [];
    await adoptedPosition(setup, '0.5', { maxHoldSec: 3 });
    if (result === 'cancelUnknown') v.cancelError = new OndoError('timeout', { uncertain: true });
    v.onPlace = input => {
      if (input.timeInForce === 'IOC') sent.push(input);
      return result === 'uncertain' ? { rests: false, error: new OndoError('timeout', { uncertain: true }) } : { rests: false, report: { status: 'canceled', filled: '0' } };
    };
    await f.rounds(130);
    assert.equal(sent.length, result === 'canceled' ? 3 : result === 'uncertain' ? 1 : 0, result);
    assert.match(f.market().exitStatus, /人工接手/, result);
    assert.equal(new Set(sent.map(input => input.clientOrderId)).size, sent.length);
  }
});

test('a placement with an unknown outcome is looked up, never sent twice', async () => {
  const { f, v, mm, count } = fixture();
  let failed = false;
  v.onPlace = input => (input.side === 'buy' && !failed ? (failed = true, { error: new OndoError('timeout', { uncertain: true }) }) : null);
  await f.live();
  assert.equal(v.calls.filter(call => call[0] === 'place' && call[1].side === 'buy').length, 1);
  // Either the lookup by client id or the account read finds it resting.
  assert.ok(count('lookup') <= 1);
  await f.rounds(10);
  assert.equal(v.calls.filter(call => call[0] === 'place' && call[1].side === 'buy').length, 1);
  assert.deepEqual(f.resting(), ['buy 0.5@199.93', 'sell 0.49@200.11']);
  assert.ok(mm.state().events.some(event => event.kind === 'unknown'));
});

test('an unknown placement the venue never saw is dropped after three lookups, then quoted again', async () => {
  const { f, v, count } = fixture();
  let failed = false;
  v.onPlace = input => (input.side === 'buy' && !failed ? (failed = true, { rests: false, error: new OndoError('upstream', { status: 502, uncertain: true }) }) : null);
  await f.live();
  assert.equal(f.market().hold, 'unknown_order');
  // While the outcome is unknown the other side is withdrawn and nothing new is placed.
  assert.deepEqual(f.resting(), []);
  const placed = count('place');
  await f.rounds(10);
  assert.equal(count('place'), placed);
  await f.rounds(20);
  assert.equal(count('lookup'), 3);
  assert.deepEqual(f.resting(), ['buy 0.5@199.93', 'sell 0.49@200.11']);
});

test('refused placements back off instead of hammering the venue', async () => {
  const { f, v, count } = fixture();
  v.onPlace = () => ({ rests: false, error: new OndoError('insufficient_margin', { status: 400 }) });
  await f.live();
  await f.rounds(20);
  // 6 s of 300 ms rounds: attempts at 0, +2 s and +4 s per side at most.
  assert.ok(count('place') <= 6, String(count('place')));
  assert.equal(f.resting().length, 0);
});

test('a rejected credential halts the session', async () => {
  const { f, v, mm, count } = fixture();
  v.onPlace = () => ({ rests: false, error: new OndoError('api_key_not_found', { status: 401 }) });
  await f.live();
  const placed = count('place');
  await f.rounds(30);
  assert.equal(count('place'), placed);
  assert.equal(mm.state().halt, 'auth_failed'); assert.equal(f.market().hold, 'auth_failed');
});

test('maintenance and quarantine withdraw everything, closes included, and quoting resumes after', async () => {
  const { f, v, mm } = fixture();
  await f.live();
  v.orders = v.orders.filter(order => order.side !== 'buy'); v.positions.set(MARKET, '0.5');
  f.stream.onPrivate('fillsPerps', [{ market: MARKET }]);
  await f.rounds(7);
  assert.deepEqual(f.resting(), ['sell 0.5@200.04 close']);
  f.maintenance = true;
  await f.rounds(2);
  assert.deepEqual(f.resting(), []);
  assert.equal(f.market().hold, 'maintenance'); assert.equal(mm.state().paused, true); assert.equal(mm.state().phase, 'running');
  f.maintenance = false; f.admission = false;
  await f.rounds(3);
  assert.deepEqual(f.resting(), []); assert.equal(f.market().hold, 'admission');
  f.admission = true;
  await f.rounds(4);
  assert.deepEqual(f.resting(), ['sell 0.5@200.04 close']);
});

test('quotes are withdrawn when the book goes stale, the market closes, or the account cannot be read', async () => {
  const stale = fixture();
  await stale.f.live();
  stale.f.frozen = true;
  await stale.f.rounds(12);
  assert.deepEqual(stale.f.resting(), []); assert.equal(stale.f.market().hold, 'stale_book');
  stale.f.frozen = false;
  await stale.f.rounds(3);
  assert.equal(stale.f.resting().length, 2);
  // The stream reports the connection lost: every book is void at once.
  stale.f.stream.onDown('disconnected'); stale.f.book = null;
  await stale.f.rounds(1);
  assert.deepEqual(stale.f.resting(), []);

  const closed = fixture();
  await closed.f.live();
  closed.v.rules = new Map([[MARKET, { tick: '0.01', step: '0.01', trading: false }]]);
  await closed.f.rounds(205);
  assert.deepEqual(closed.f.resting(), []); assert.equal(closed.f.market().hold, 'market_closed');

  const blind = fixture();
  await blind.f.live();
  blind.v.readError = new OndoError('upstream', { status: 502 });
  await blind.f.rounds(60);
  assert.deepEqual(blind.f.resting(), []); assert.equal(blind.f.market().hold, 'account_unknown');

  const deaf = fixture();
  await deaf.f.live();
  deaf.f.privateReady = false;
  await deaf.f.rounds(1);
  assert.deepEqual(deaf.f.resting(), []); assert.equal(deaf.f.market().hold, 'private_stream');
});

test('an account with existing perps orders is refused before its account-wide timer is armed', async () => {
  const { f, v, mm, count } = fixture();
  const manual = { id: 'manual1', clientId: null, market: MARKET, side: 'sell', price: '199.93', size: '1', filled: '0', status: 'open', reduceOnly: false };
  v.orders.push(manual);
  await assert.rejects(f.live(), error => error.status === 409 && error.message.includes('账户须无永续挂单'));
  assert.deepEqual(v.orders, [manual]); assert.equal(mm.state().phase, 'stopped');
  assert.equal(count('place') + count('cancel'), 0);
});

test('the total notional cap limits what rests', async () => {
  const { f } = fixture();
  await f.live({ maxTotalUsd: '150' });
  assert.deepEqual(f.resting(), ['buy 0.5@199.93']);
  assert.equal(f.market().sell.reason, 'total_cap');
});

test('stop withdraws every order and ends only after the venue confirms none is left', async () => {
  const { f, v, mm } = fixture();
  await f.live();
  const state = await mm.stop();
  assert.equal(state.phase, 'stopped'); assert.deepEqual(v.orders, []);
  assert.equal(existsSync(join(f.dataDir, 'ondo-mm', 'session.json')), false);
  assert.equal(f.streamClosed, 1);
  assert.deepEqual(mm.save(config()).config, config());
});

test('a stop that cannot be confirmed keeps trying and blocks an update', async () => {
  const { f, v, mm } = fixture();
  await f.live();
  v.cancelError = new OndoError('upstream', { status: 502, uncertain: true });
  const state = await mm.stop();
  assert.equal(state.phase, 'stopping'); assert.equal(v.orders.length, 2);
  assert.equal(f.streamClosed, 1, 'REST failures must not keep the venue timer alive');
  await assert.rejects(mm.prepareStop(), status(409));
  assert.equal(existsSync(join(f.dataDir, 'ondo-mm', 'session.json')), true);
  await assert.rejects(mm.start({ revision: 1, confirmLive: true, confirmAccountWide: true }), status(409));
  // Nothing new is placed while stopping, and the next tick finishes once cancels work again.
  v.cancelError = null;
  await mm.prepareStop();
  assert.equal(mm.state().phase, 'stopped'); assert.deepEqual(v.orders, []);
});

test('a flat snapshot from before stop cannot complete a stop while REST is unavailable', async () => {
  const { f, v, mm } = fixture();
  await f.live({ wallUsd: '1000000' }); await f.rounds(6, 1000);
  assert.equal(v.orders.length, 0);
  v.readError = new OndoError('network');
  assert.equal((await mm.stop()).phase, 'stopping');
  assert.equal(JSON.parse(readFileSync(join(f.dataDir, 'ondo-mm/session.json'))).interrupted, true);
  v.readError = null; assert.equal((await mm.stop()).phase, 'stopped');
  assert.equal(existsSync(join(f.dataDir, 'ondo-mm/session.json')), false);
});

test('a process lost before open-order settlement requires manual reconciliation across flat reads', async () => {
  const { f, mm } = fixture(); await f.live(); await mm.close(0);
  const file = join(f.dataDir, 'ondo-mm/session.json');
  assert.equal(JSON.parse(readFileSync(file)).interrupted, true);
  const again = fixture({ dataDir: f.dataDir, key: KEY });
  again.mm.initialize(); await again.mm.cleanup(); await again.mm.cleanup();
  assert.equal(again.mm.state().recovery.error, 'position_unconfirmed'); assert.equal(existsSync(file), true);
  await assert.rejects(again.mm.start({ revision: 1, confirmLive: true, confirmAccountWide: true }), status(409));
  again.mm.discardRecovery(); assert.equal(existsSync(file), false);
});

test('an order that appears after its cancel was thought done is found by the closing account read', async () => {
  const { f, v, mm } = fixture();
  await f.live();
  // The venue still lists an order of this module that the session no longer tracks.
  v.orders.push({ id: 'late1', clientId: 'tpo-deadbeef-9', market: MARKET, side: 'buy', price: '199.80', size: '0.5', filled: '0', status: 'open', reduceOnly: false });
  assert.equal((await mm.stop()).phase, 'stopped');
  assert.deepEqual(v.orders, []);
});

test('a restart does not resume: it withdraws what the last live session left and nothing else', async () => {
  const first = fixture();
  await first.f.live();
  await first.mm.close();
  const { f, v, mm, count } = fixture({ dataDir: first.f.dataDir, key: KEY });
  writeFileSync(join(f.dataDir, 'ondo-mm', 'session.json'), JSON.stringify({ startedAt: '2026-11-12T00:00:00.000Z' }));
  // The workbench's own quotes (omm-) on the same account are not this service's to withdraw.
  v.orders = [{ id: 'left1', clientId: 'tpo-abcd1234-0', market: MARKET, side: 'buy', price: '199.93', size: '0.5', filled: '0', status: 'open', reduceOnly: false },
    { id: 'manual1', clientId: 'mine', market: MARKET, side: 'sell', price: '205', size: '1', filled: '0', status: 'open', reduceOnly: false },
    { id: 'workbench1', clientId: 'omm-abcd1234-0', market: MARKET, side: 'sell', price: '206', size: '1', filled: '0', status: 'open', reduceOnly: false }];
  mm.initialize();
  assert.equal(mm.state().phase, 'stopped'); assert.ok(mm.state().recovery);
  await mm.cleanup();
  assert.deepEqual(v.orders.map(order => order.id), ['manual1', 'workbench1']);
  assert.equal(mm.state().recovery.error, 'position_unconfirmed'); assert.equal(count('place'), 0);
  assert.equal(existsSync(join(f.dataDir, 'ondo-mm', 'session.json')), true);
  mm.discardRecovery();
  await mm.prepareStop();
});

test('a fill during an outage is reported on recovery even when the dead-man switch removed every order', async () => {
  const alerts = [], { f, v, mm, count } = fixture({ key: KEY, manager: { notifyRisk(key, text) { alerts.push({ key, text }); } } });
  const dir = join(f.dataDir, 'ondo-mm'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.json'), JSON.stringify({ startedAt: '2026-11-12T00:00:00.000Z' }));
  v.positions.set(MARKET, '-0.5');
  mm.initialize(); await mm.cleanup();
  assert.equal(mm.state().recovery.error, 'positions_remain'); assert.ok(existsSync(join(dir, 'session.json')));
  assert.deepEqual(mm.state().leftPositions, [{ market: MARKET, position: '-0.5' }]);
  assert.ok(alerts.some(alert => /NVDA-USD\.P -0\.5/.test(alert.text))); assert.equal(count('place'), 0);
  v.positions.clear(); await mm.cleanup();
  assert.equal(mm.state().recovery.error, 'position_unconfirmed'); assert.deepEqual(mm.state().leftPositions, []); assert.equal(count('place'), 0);
});

test('restart cleanup records the original cancellation before DELETE and keeps its fill pending across another restart', async () => {
  const other = 'TSLA-USD.P';
  for (const outcome of ['partial', 'already_filled', 'already_fully_filled', 'lost_reply']) {
    const { f, v, mm } = fixture({ key: KEY });
    const dir = join(f.dataDir, 'ondo-mm'), file = join(dir, 'session.json');
    mkdirSync(dir); writeFileSync(file, JSON.stringify({ startedAt: '2026-11-12T00:00:00.000Z', interrupted: false }));
    v.orders.push({ id: 'left1', clientId: 'tpo-dead-1', market: MARKET, side: 'buy', price: '200', size: '0.5', filled: '0', status: 'open', reduceOnly: false });
    let beforeDelete;
    v.onCancel = order => {
      beforeDelete = JSON.parse(readFileSync(file, 'utf8')).canceling;
      if (outcome === 'partial') return { ...order, filled: '0.1' };
      if (outcome === 'lost_reply') throw new OndoError('timeout', { uncertain: true });
      throw new OndoError(`order_${outcome}`);
    };
    v.positions.set(other, '2');
    mm.initialize(); await mm.cleanup();
    assert.equal(beforeDelete?.clientId, 'tpo-dead-1', outcome);
    assert.equal(mm.state().recovery?.error, 'positions_remain', outcome);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).unconfirmed, [MARKET], outcome);
    await mm.close();
    const notices = [], again = fixture({ dataDir: f.dataDir, key: KEY, manager: { notifyRisk: (_key, text) => notices.push(text) } });
    again.mm.initialize(); await again.mm.cleanup();
    assert.equal(again.mm.state().recovery?.error, 'position_unconfirmed', outcome);
    assert.ok(notices.some(text => text.includes(MARKET)), outcome);
    await again.mm.cleanup(); assert.ok(existsSync(file), outcome);
    again.v.positions.set(MARKET, '0.1'); await again.mm.cleanup();
    assert.deepEqual(again.mm.state().leftPositions, [{ market: MARKET, position: '0.1' }], outcome);
    again.v.positions.clear(); await again.mm.cleanup();
    assert.equal(again.mm.state().recovery, null, outcome); assert.equal(again.count('place'), 0);
  }
});

test('a normal stop and an expedited process close both leave durable evidence for late positions, including outside the selected markets', async () => {
  const other = 'TSLA-USD.P';
  for (const expedited of [false, true]) {
    const { f, v, mm } = fixture();
    await f.live();
    if (!expedited) {
      v.positions.set(other, '-2');
      f.stream.onPrivate('positionsPerps', [{ market: other, direction: 'short', netQuantity: '2' }]);
      await f.rounds(8);
    }
    f.stream.onPrivate('fillsPerps', [{ market: MARKET, direction: 'openLong', side: 'buy', size: '0.1', price: '200' }]);
    if (!expedited) {
      const stopped = await mm.stop();
      assert.equal(stopped.phase, 'stopped'); assert.deepEqual(stopped.leftPositions, [{ market: other, position: '-2' }]);
    }
    await mm.close(0);
    const notices = [], again = fixture({ dataDir: f.dataDir, key: KEY, manager: { notifyRisk: (_key, text) => notices.push(text) } });
    again.mm.initialize(); await again.mm.cleanup();
    assert.equal(again.mm.state().recovery?.error, 'position_unconfirmed');
    assert.ok(notices.some(text => text.includes(MARKET)));
    if (!expedited) assert.ok(notices.some(text => text.includes(other)));
    await assert.rejects(again.mm.start({ revision: 1, confirmLive: true, confirmAccountWide: true }), status(409));
    again.mm.discardRecovery(); assert.equal(again.mm.state().recovery, null);
  }
});

test('a process that dies during DELETE resumes by the recorded order identity before settling the account', async () => {
  for (const knownCanceled of [false, true]) {
    const { f, v, mm, count } = fixture({ key: KEY });
    const dir = join(f.dataDir, 'ondo-mm'); mkdirSync(dir);
    const canceling = { id: 'o1', clientId: 'tpo-dead-3', market: MARKET, side: 'sell', price: '200', size: '1', reduceOnly: false };
    writeFileSync(join(dir, 'session.json'), JSON.stringify({ interrupted: false, canceling }));
    if (knownCanceled) v.history.set(canceling.clientId, { ...canceling, status: 'canceled', filled: '0' });
    mm.initialize(); await mm.cleanup();
    assert.deepEqual(v.calls.filter(call => call[0] === 'lookup'), [['lookup', canceling.clientId]]);
    assert.equal(count('cancel'), 0); assert.equal(count('place'), 0);
    assert.equal(mm.state().recovery?.error ?? null, knownCanceled ? null : 'position_unconfirmed');
  }
});

test('cleanup catches a late position in its second flat-account read even without an earlier fill receipt', async () => {
  let venue;
  const { f, v, mm } = fixture({ key: KEY, manager: { sleep: async () => { venue.positions.set(MARKET, '0.2'); } } });
  venue = v;
  const dir = join(f.dataDir, 'ondo-mm'); mkdirSync(dir); writeFileSync(join(dir, 'session.json'), JSON.stringify({ interrupted: false }));
  mm.initialize(); await mm.cleanup();
  assert.equal(mm.state().recovery?.error, 'positions_remain');
  assert.deepEqual(mm.state().leftPositions, [{ market: MARKET, position: '0.2' }]);
});

test('leftovers that cannot be withdrawn stay reported and block an update', async () => {
  const { f, v, mm } = fixture({ key: KEY });
  mkdirSync(join(f.dataDir, 'ondo-mm'));
  writeFileSync(join(f.dataDir, 'ondo-mm', 'session.json'), JSON.stringify({ startedAt: '2026-11-12T00:00:00.000Z' }));
  v.readError = new OndoError('upstream', { status: 502 });
  mm.initialize();
  await mm.cleanup();
  assert.equal(mm.state().recovery.error, 'upstream');
  await assert.rejects(mm.prepareStop(), status(409));
  // Live cannot start over the leftovers.
  mm.save(config());
  await assert.rejects(mm.start({ revision: mm.state().revision, confirmLive: true, confirmAccountWide: true }), status(409));
  v.readError = null;
  await mm.cleanup();
  assert.equal(mm.state().recovery.error, 'position_unconfirmed'); mm.discardRecovery();
  assert.equal(mm.state().recovery, null);
});

test('leftovers with an unreadable key do not wedge the cleanup; a new key or a manual check clears them', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ondo-mm-'));
  mkdirSync(join(dataDir, 'ondo-mm'));
  writeFileSync(join(dataDir, 'ondo-mm', 'session.json'), JSON.stringify({ startedAt: '2026-11-12T00:00:00.000Z' }));
  const { v, mm } = fixture({ dataDir });
  v.orders = [{ id: 'left1', clientId: 'tpo-abcd1234-0', market: MARKET, side: 'buy', price: '199.93', size: '0.5', filled: '0', status: 'open', reduceOnly: false }];
  mm.initialize();
  await mm.cleanup(); await mm.cleanup();
  assert.equal(mm.state().recovery.error, 'no_credentials'); assert.equal(mm.state().recovery.cleaning, false);
  await assert.rejects(mm.prepareStop(), status(409));
  assert.equal(v.orders.length, 1);
  const other = fixture({ dataDir });
  other.mm.initialize();
  assert.equal(other.mm.discardRecovery().recovery, null);
  assert.equal(existsSync(join(dataDir, 'ondo-mm', 'session.json')), false);
  await other.mm.prepareStop();
});
test('a live start refuses a position it did not open unless the caller adopts it', async () => {
  const { f, v, mm, count } = fixture();
  f.key = KEY; mm.initialize(); mm.save(config());
  v.positions.set(MARKET, '10');
  await assert.rejects(mm.start({ revision: 1, confirmLive: true, confirmAccountWide: true }), error => error.status === 409 && error.message.includes(`${MARKET} 10`));
  await assert.rejects(mm.start({ revision: 1, confirmLive: true, confirmAccountWide: true, adoptPositions: 'yes' }), status(400));
  assert.equal(mm.state().phase, 'stopped'); assert.equal(count('place'), 0); assert.equal(f.streamClosed, 1);
  assert.equal(existsSync(join(f.dataDir, 'ondo-mm', 'session.json')), false);
  // Positions that cannot be read are not assumed to be empty.
  v.positionsError = new OndoError('upstream', { status: 502 });
  await assert.rejects(mm.start({ revision: 1, confirmLive: true, confirmAccountWide: true, adoptPositions: true }), status(503));
  assert.equal(mm.state().phase, 'stopped');
  v.positionsError = null;
  await mm.start({ revision: 1, confirmLive: true, confirmAccountWide: true, adoptPositions: true });
  f.push(); await f.rounds(4);
  assert.deepEqual(f.resting(), ['sell 10@200.04 close']);
  assert.equal(f.market().buy.reason, 'incident');
});

test('a position locks new quotes in every market before and after its valuation is available', async () => {
  const OTHER = 'TSLA-USD.P';
  const { f, v, mm, count } = fixture();
  v.rules.set(OTHER, { tick: '0.01', step: '0.01', trading: true });
  v.positions.set(OTHER, '1');
  f.key = KEY; mm.initialize(); mm.save(config({ markets: [MARKET, OTHER], maxTotalUsd: '450' }));
  await mm.start({ revision: 1, confirmLive: true, confirmAccountWide: true, adoptPositions: true });
  f.push(); await f.rounds(4);
  assert.equal(count('place'), 0);
  assert.equal(f.market().buy.reason, 'incident'); assert.equal(f.market().sell.reason, 'incident');
  f.stream.onBook(OTHER, { time: f.time, bids: [[u('300.00'), u('10')]], asks: [[u('300.10'), u('10')]] }, f.time);
  await f.rounds(2);
  assert.deepEqual(f.resting(), ['sell 1@300.1 close']);
  assert.equal(f.market().sell.reason, 'incident');
  // Losing this market's book cannot unlock another market.
  f.stream.onBook(OTHER, { time: f.time, bids: [], asks: [[u('300.10'), u('10')]] }, f.time);
  await f.rounds(8);
  assert.equal(mm.state().markets[1].hold, 'stale_book');
  assert.equal(f.market().sell.reason, 'incident');
  assert.equal(v.orders.filter(order => order.market === MARKET).length, 0);
});

test('withdrawals of both sides go out before either replacement', async () => {
  const { f, v } = fixture();
  await f.live({ dwellMs: 0 });
  await f.rounds(4);
  const before = v.calls.length;
  // The market rises: the sell is half a bp from the mid (urgent), the buy is merely far.
  f.push([['200.08', '10']], [['200.12', '10']]);
  await f.rounds(1);
  assert.deepEqual(v.calls.slice(before).map(call => call[0]).filter(name => name === 'place' || name === 'cancel'), ['cancel', 'cancel', 'place', 'place']);
  assert.deepEqual(f.resting(), ['buy 0.49@200.01', 'sell 0.49@200.19']);
});

test('quotes are withdrawn while the venue rate-limits the client', async () => {
  const { f, v } = fixture();
  await f.live();
  v.cooldown = f.time + 60_000;
  await f.rounds(2);
  assert.deepEqual(f.resting(), []); assert.equal(f.market().hold, 'rate_limited');
  v.cooldown = 0;
  await f.rounds(4);
  assert.equal(f.resting().length, 2);
});

test('a stop reports the position it leaves behind', async () => {
  const { f, v, mm } = fixture();
  await f.live();
  v.orders = v.orders.filter(order => order.side !== 'buy'); v.positions.set(MARKET, '0.5');
  f.stream.onPrivate('fillsPerps', [{ market: MARKET, side: 'buy', size: '0.5', price: '199.93' }]);
  await f.rounds(5);
  const state = await mm.stop();
  assert.equal(state.phase, 'stopped'); assert.deepEqual(v.orders, []);
  assert.deepEqual(state.leftPositions, [{ market: MARKET, position: '0.5' }]);
  assert.ok(state.events[0].text.includes(`${MARKET} 0.5`));
  // The next start refuses it like any other existing position.
  await assert.rejects(mm.start({ revision: 1, confirmLive: true, confirmAccountWide: true }), status(409));
});
test('nothing can change or stop being honoured while a live start reads the positions', async () => {
  const { f, v, mm, count } = fixture();
  f.key = KEY; mm.initialize(); mm.save(config());
  let release;
  const hold = () => { v.positionsGate = new Promise(resolve => { release = resolve; }); };
  hold();
  const first = mm.start({ revision: 1, confirmLive: true, confirmAccountWide: true });
  await assert.rejects(mm.start({ revision: 1, confirmLive: true, confirmAccountWide: true }), status(409));
  assert.throws(() => mm.save(config({ markets: ['TSLA-USD.P'] })), status(409));
  // A stop that arrives during the read cancels the start.
  assert.equal((await mm.stop()).phase, 'stopped');
  release();
  await assert.rejects(first, status(409));
  assert.equal(mm.state().phase, 'stopped'); assert.equal(f.streamClosed, 1);
  assert.equal(existsSync(join(f.dataDir, 'ondo-mm', 'session.json')), false);
  // A caller that left gets nothing started; an update that begins meanwhile is not overtaken.
  const controller = new AbortController();
  hold();
  const second = mm.start({ revision: 1, confirmLive: true, confirmAccountWide: true }, { signal: controller.signal });
  controller.abort(); release();
  await assert.rejects(second, status(503));
  hold();
  const third = mm.start({ revision: 1, confirmLive: true, confirmAccountWide: true });
  await mm.prepareStop();
  release();
  await assert.rejects(third, status(409));
  v.positionsGate = null;
  assert.equal(f.streamClosed, 3); assert.equal(count('place'), 0); assert.equal(v.orders.length, 0);
  await mm.start({ revision: 1, confirmLive: true, confirmAccountWide: true });
  assert.equal(mm.state().phase, 'running');
});

test('an unknown placement whose lookup keeps failing is dropped once account reads no longer list it', async () => {
  const { f, v, mm, count } = fixture();
  let failed = false;
  v.onPlace = input => (input.side === 'buy' && !failed ? (failed = true, { rests: false, error: new OndoError('invalid_data', { status: 200, uncertain: true }) }) : null);
  v.lookupError = new OndoError('http_404', { status: 404 });
  await f.live();
  assert.equal(f.market().hold, 'unknown_order');
  await f.rounds(120);
  assert.ok(count('lookup') > 3);
  assert.deepEqual(f.resting(), ['buy 0.5@199.93', 'sell 0.49@200.11']);
  assert.equal((await mm.stop()).phase, 'stopped');
});
