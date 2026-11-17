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

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const EPOCH = 1_800_000_000_000, MARKET = 'NVDA-USD.P';
const SECRET = 'ondoApiSecret_fixture-secret-value';
const KEY = Object.freeze({ keyId: 'ondoKeyId_fixture', secret: SECRET });
const config = (extra = {}) => ({ ...structuredClone(ONDO_MM_DEFAULTS), markets: [MARKET], mode: 'live', wallEnabled: false, ...extra });
// Mid 200.02: the fixed quotes are 199.93 and 200.11.
const BIDS = [['200.00', '10'], ['199.98', '20'], ['199.95', '100']], ASKS = [['200.04', '10'], ['200.06', '20'], ['200.09', '100']];

function fixture(options = {}) {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'ondo-mm-'));
  const f = { dataDir, key: options.key ?? null, time: EPOCH, maintenance: false, admission: true, privateReady: true, stream: null, streamClosed: 0, book: null, frozen: false };
  const v = { orders: [], positions: new Map(), calls: [], seq: 0, cooldown: 0, onPlace: null, cancelError: null, readError: null,
    rules: new Map([[MARKET, { tick: '0.01', step: '0.01', trading: true }]]) };
  const count = name => v.calls.filter(call => call[0] === name).length;
  const clientFactory = () => ({
    cooldownUntil: () => v.cooldown,
    async markets() { v.calls.push(['markets']); return v.rules; },
    async place(input) {
      v.calls.push(['place', input]);
      const order = { id: `o${++v.seq}`, clientId: input.clientOrderId, market: input.market, side: input.side, price: input.price, size: input.size, filled: '0', status: 'open', reduceOnly: input.reduceOnly };
      const outcome = v.onPlace?.(input);
      if (outcome?.rests !== false) v.orders.push(order);
      if (outcome?.error) throw outcome.error;
      return { ...order };
    },
    async cancel(id) {
      v.calls.push(['cancel', id]);
      if (v.cancelError) throw v.cancelError;
      const index = v.orders.findIndex(order => order.id === id);
      if (index < 0) throw new OndoError('order_not_found', { status: 400 });
      return { ...v.orders.splice(index, 1)[0], status: 'canceled' };
    },
    async orderByClientId(clientId) { v.calls.push(['lookup', clientId]); if (v.lookupError) throw v.lookupError; const found = v.orders.find(order => order.clientId === clientId); return found ? { ...found } : null; },
    async openOrders() { v.calls.push(['open']); if (v.readError) throw v.readError; return v.orders.map(order => ({ ...order })); },
    async positions() { v.calls.push(['positions']); await v.positionsGate; if (v.positionsError) throw v.positionsError; return new Map(v.positions); },
    close() {},
  });
  const streamFactory = input => { f.stream = input; return { start() {}, close() { f.streamClosed += 1; }, status: () => ({ connected: true, publicReady: true, privateReady: !!input.credentials && f.privateReady, lastFrameAt: f.time, error: null }) }; };
  const mm = createOndoMarketMaker({ dataDir, readCredentials: () => f.key, log: silent, now: () => f.time, intervalMs: 0, clientFactory, streamFactory,
    readMaintenance: () => f.maintenance, readAdmission: () => f.admission, sleep: async ms => { f.time += ms; }, ...options.manager });
  const levels = rows => rows.map(([price, size]) => [u(price), u(size)]);
  f.push = (bids = BIDS, asks = ASKS) => { f.book = [bids, asks]; f.stream.onBook(MARKET, { time: f.time, bids: levels(bids), asks: levels(asks) }, f.time); };
  f.rounds = async (n = 1, ms = 300) => { for (let i = 0; i < n; i++) { f.time += ms; if (f.book && !f.frozen) f.push(...f.book); await mm.tick(); } };
  f.resting = () => v.orders.map(order => `${order.side} ${order.size}@${order.price}${order.reduceOnly ? ' close' : ''}`).sort();
  f.live = async (extra = {}) => {
    f.key = KEY; mm.initialize(); mm.save(config(extra));
    await mm.start({ revision: mm.state().revision, confirmLive: true });
    f.push(); await f.rounds(4);
  };
  f.market = () => mm.state().markets[0];
  return { f, v, mm, count };
}
const status = code => error => error.status === code;

test('configuration is validated as a whole', () => {
  assert.deepEqual(validateOndoMmConfig(config()), config());
  for (const bad of [{ minBps: '4' }, { maxBps: '4' }, { maxBps: '26' }, { markets: [] }, { markets: ['nvda'] }, { markets: [MARKET, MARKET] }, { orderUsd: '0' }, { orderUsd: 100 },
    { maxPositionUsd: '50' }, { maxTotalUsd: '50' }, { mode: 'real' }, { rps: 50 }, { dwellMs: -1 }, { wallEnabled: 'yes' }, { extra: 1 }, { targetBps: '4.00001' }]) assert.throws(() => validateOndoMmConfig(config(bad)), JSON.stringify(bad));
  const { orderUsd, ...partial } = config();
  assert.throws(() => validateOndoMmConfig(partial));
});

test('observe mode computes quotes and sends nothing', async () => {
  const { f, v, mm, count } = fixture();
  mm.initialize(); mm.save(config({ mode: 'observe' }));
  await mm.start({ revision: 1 });
  assert.equal(f.stream.credentials, null);
  f.push(); await f.rounds(3);
  const market = f.market();
  assert.equal(market.hold, null);
  assert.deepEqual([market.buy.state, market.buy.price, market.sell.price], ['planned', '199.93', '200.11']);
  assert.equal(count('place') + count('open') + count('positions') + count('cancel'), 0);
  assert.equal(v.orders.length, 0);
  assert.equal((await mm.stop()).phase, 'stopped');
});

test('a live start needs confirmation, the saved revision, credentials and an open gate', async () => {
  const { f, mm, count } = fixture();
  mm.initialize(); mm.save(config());
  await assert.rejects(mm.start({ revision: 1, confirmLive: true }), status(409));
  f.key = KEY;
  assert.ok(!JSON.stringify(mm.state()).includes(SECRET));
  await assert.rejects(mm.start({ revision: 1 }), status(400));
  await assert.rejects(mm.start({ revision: 0, confirmLive: true }), status(409));
  f.maintenance = true;
  await assert.rejects(mm.start({ revision: 1, confirmLive: true }), status(409));
  f.maintenance = false; f.admission = false;
  await assert.rejects(mm.start({ revision: 1, confirmLive: true }), status(409));
  assert.equal(mm.state().phase, 'stopped'); assert.equal(count('markets'), 0);
  assert.equal(existsSync(join(f.dataDir, 'ondo-mm', 'session.json')), false);
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
  f.push([['199.94', '10']], [['199.98', '10']]);
  await f.rounds(1);
  assert.deepEqual(f.resting(), ['buy 0.5@199.88', 'sell 0.49@200.11']);
  assert.equal(f.market().sell.reason, 'too_far');
  await f.rounds(6);
  assert.deepEqual(f.resting(), ['buy 0.5@199.88', 'sell 0.49@200.04']);
  assert.equal(count('place'), 4); assert.equal(count('cancel'), 2);
});

test('a fill stops the side that would add and leaves a reduce-only close at the touch', async () => {
  const { f, v, count } = fixture();
  await f.live();
  v.orders = v.orders.filter(order => order.side !== 'buy'); v.positions.set(MARKET, '0.5');
  f.stream.onPrivate('fillsPerps', [{ market: MARKET, side: 'buy', size: '0.5', price: '199.93' }]);
  await f.rounds(5);
  assert.deepEqual(f.resting(), ['sell 0.5@200.04 close']);
  assert.equal(f.market().buy.reason, 'position_cap'); assert.equal(f.market().position, '0.5');
  // The touch moves away: the close stays the best price. It moves toward: the close follows.
  f.push(BIDS, [['200.06', '20']]);
  await f.rounds(5);
  assert.deepEqual(f.resting(), ['sell 0.5@200.04 close']);
  v.orders = []; v.positions.delete(MARKET);
  f.stream.onPrivate('fillsPerps', [{ market: MARKET, side: 'sell', size: '0.5', price: '200.04' }]);
  f.push(); await f.rounds(5);
  assert.deepEqual(f.resting(), ['buy 0.5@199.93', 'sell 0.49@200.11']);
  assert.equal(count('place'), 5);
});

test('a short position is closed by a reduce-only buy that follows the bid up', async () => {
  const { f, v } = fixture();
  await f.live();
  v.orders = v.orders.filter(order => order.side !== 'sell'); v.positions.set(MARKET, '-0.49');
  f.stream.onPrivate('positionsPerps', [{ market: MARKET, direction: 'short', netQuantity: '0.49' }]);
  await f.rounds(5);
  assert.deepEqual(f.resting(), ['buy 0.49@200 close']);
  f.push([['200.02', '5'], ...BIDS], ASKS);
  await f.rounds(6);
  assert.deepEqual(f.resting(), ['buy 0.49@200.02 close']);
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
  await f.rounds(5);
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

test('the account\'s other orders are left alone and never crossed', async () => {
  const { f, v, count } = fixture();
  const manual = { id: 'manual1', clientId: null, market: MARKET, side: 'sell', price: '199.93', size: '1', filled: '0', status: 'open', reduceOnly: false };
  v.orders.push(manual);
  await f.live();
  // In the default book a buy at 199.93 would meet the manual sell: no buy is placed.
  assert.equal(f.market().buy.reason, 'own_order_in_way');
  assert.equal(v.orders.some(order => order.side === 'buy'), false);
  // The manual sell is the best ask (mid 199.89): the buy rests 4 bps below the mid, under it.
  f.push([['199.85', '10']], [['199.93', '1'], ['200.04', '10']]);
  await f.rounds(8);
  assert.equal(v.orders.find(order => order.side === 'buy').price, '199.81');
  assert.ok(v.orders.includes(manual));
  assert.ok(!v.calls.some(call => call[0] === 'cancel' && call[1] === 'manual1'));
  assert.ok(count('place') >= 2);
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
  await assert.rejects(mm.prepareStop(), status(409));
  assert.equal(existsSync(join(f.dataDir, 'ondo-mm', 'session.json')), true);
  await assert.rejects(mm.start({ revision: 1, confirmLive: true }), status(409));
  // Nothing new is placed while stopping, and the next tick finishes once cancels work again.
  v.cancelError = null;
  await mm.prepareStop();
  assert.equal(mm.state().phase, 'stopped'); assert.deepEqual(v.orders, []);
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
  assert.equal(mm.state().recovery, null); assert.equal(count('place'), 0);
  assert.equal(existsSync(join(f.dataDir, 'ondo-mm', 'session.json')), false);
  await mm.prepareStop();
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
  await assert.rejects(mm.start({ revision: mm.state().revision, confirmLive: true }), status(409));
  v.readError = null;
  await mm.cleanup();
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
  await assert.rejects(mm.start({ revision: 1, confirmLive: true }), error => error.status === 409 && error.message.includes(`${MARKET} 10`));
  await assert.rejects(mm.start({ revision: 1, confirmLive: true, adoptPositions: 'yes' }), status(400));
  assert.equal(mm.state().phase, 'stopped'); assert.equal(count('place'), 0); assert.equal(f.streamClosed, 1);
  assert.equal(existsSync(join(f.dataDir, 'ondo-mm', 'session.json')), false);
  // Positions that cannot be read are not assumed to be empty.
  v.positionsError = new OndoError('upstream', { status: 502 });
  await assert.rejects(mm.start({ revision: 1, confirmLive: true, adoptPositions: true }), status(503));
  assert.equal(mm.state().phase, 'stopped');
  v.positionsError = null;
  await mm.start({ revision: 1, confirmLive: true, adoptPositions: true });
  f.push(); await f.rounds(4);
  assert.deepEqual(f.resting(), ['sell 10@200.04 close']);
  assert.equal(f.market().buy.reason, 'position_cap');
});

test('a position that cannot be valued blocks new quotes everywhere, and keeps counting once it had a price', async () => {
  const OTHER = 'TSLA-USD.P';
  const { f, v, mm, count } = fixture();
  v.rules.set(OTHER, { tick: '0.01', step: '0.01', trading: true });
  v.positions.set(OTHER, '1');
  f.key = KEY; mm.initialize(); mm.save(config({ markets: [MARKET, OTHER], maxTotalUsd: '450' }));
  await mm.start({ revision: 1, confirmLive: true, adoptPositions: true });
  f.push(); await f.rounds(4);
  assert.equal(count('place'), 0);
  assert.equal(f.market().buy.reason, 'total_unknown'); assert.equal(f.market().sell.reason, 'total_unknown');
  f.stream.onBook(OTHER, { time: f.time, bids: [[u('300.00'), u('10')]], asks: [[u('300.10'), u('10')]] }, f.time);
  await f.rounds(2);
  // 300.05 held in the other market + 100 leaves no room for the second quote.
  assert.deepEqual(f.resting(), ['buy 0.5@199.93', 'sell 1@300.1 close']);
  assert.equal(f.market().sell.reason, 'total_cap');
  // Its book goes away (one-sided, then stale): the position is still counted at the last price.
  f.stream.onBook(OTHER, { time: f.time, bids: [], asks: [[u('300.10'), u('10')]] }, f.time);
  await f.rounds(8);
  assert.equal(mm.state().markets[1].hold, 'stale_book');
  assert.equal(f.market().sell.reason, 'total_cap');
  assert.equal(v.orders.filter(order => order.market === MARKET).length, 1);
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
  await assert.rejects(mm.start({ revision: 1, confirmLive: true }), status(409));
});
test('nothing can change or stop being honoured while a live start reads the positions', async () => {
  const { f, v, mm, count } = fixture();
  f.key = KEY; mm.initialize(); mm.save(config());
  let release;
  const hold = () => { v.positionsGate = new Promise(resolve => { release = resolve; }); };
  hold();
  const first = mm.start({ revision: 1, confirmLive: true });
  await assert.rejects(mm.start({ revision: 1, confirmLive: true }), status(409));
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
  const second = mm.start({ revision: 1, confirmLive: true }, { signal: controller.signal });
  controller.abort(); release();
  await assert.rejects(second, status(503));
  hold();
  const third = mm.start({ revision: 1, confirmLive: true });
  await mm.prepareStop();
  release();
  await assert.rejects(third, status(409));
  v.positionsGate = null;
  assert.equal(f.streamClosed, 3); assert.equal(count('place'), 0); assert.equal(v.orders.length, 0);
  await mm.start({ revision: 1, confirmLive: true });
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
