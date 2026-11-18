// Ported from the workbench (project-aggregation 7745181 tests/), with the imports pointed at src/vendor/ondo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createOndoClient, OndoError } from '../../src/vendor/ondo/client.mjs';
import { createOndoLatency } from '../../src/vendor/ondo/latency.mjs';

const keys = { keyId: 'ondoKeyId_fixture', secret: 'ondoApiSecret_fixture-secret' };
const EPOCH = 1_800_000_000_000;
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const order = (extra = {}) => ({ orderId: 'abc123', clientOrderId: 'omm-1', side: 'buy', price: '199.93', size: '0.50', market: 'NVDA-USD.P', filledSize: '0.00', status: 'open', reduceOnly: false, ...extra });
function fixture(replies, options = {}) {
  const calls = [], clock = { now: EPOCH };
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    if (typeof reply === 'function') return reply(init);
    return reply;
  };
  return { calls, clock, client: createOndoClient({ credentials: keys, fetchImpl, now: () => clock.now, rps: 10, ...options }) };
}
const rejected = (code, extra = {}) => error => error instanceof OndoError && error.code === code && Object.entries(extra).every(([key, value]) => error[key] === value);

test('queue timing ends at token grant; HTTP timing waits for the complete validated body', async () => {
  let mono = 0, releaseToken, body;
  const market = 'NVDA-USD.P', now = () => EPOCH + mono;
  const latency = createOndoLatency({ markets: [market], mode: 'live', startedAt: EPOCH, now, monotonicNow: () => mono });
  const client = createOndoClient({ credentials: keys, rps: 1, now, latency,
    setTimeoutImpl(fn, ms) { if (ms === 1000) releaseToken = fn; return 1; }, clearTimeoutImpl() {},
    fetchImpl: async (_, { method }) => {
      if (method === 'GET') return json({ success: true, result: [] });
      mono += 17;
      return new Response(new ReadableStream({ start(controller) { body = controller; } }), { headers: { 'Content-Type': 'application/json' } });
    } });
  await client.positions();
  const placing = client.place({ market, side: 'buy', price: '199.93', size: '0.5', clientOrderId: 'omm-1' });
  mono += 1000; releaseToken(); await new Promise(resolve => setImmediate(resolve));
  let row = latency.snapshot().markets[0];
  assert.deepEqual([row.restQueue.lastMs, row.restQueue.lastAt, row.placeAck.n], [1000, EPOCH + 1000, 0]);
  mono += 23; body.enqueue(new TextEncoder().encode(JSON.stringify({ success: true, result: order() }))); body.close();
  await placing; row = latency.snapshot().markets[0];
  assert.deepEqual([row.placeAck.lastMs, row.placeAck.lastAt, row.placeAck.n], [40, EPOCH + 1040, 1]);
  client.close();
});

test('request failures, incomplete acknowledgements and local vetoes never enter successful HTTP quantiles', async () => {
  const market = 'NVDA-USD.P', now = () => EPOCH + mono;
  let mono = 0;
  const latency = createOndoLatency({ markets: [market], mode: 'live', startedAt: EPOCH, now, monotonicNow: () => mono });
  const input = { market, side: 'buy', price: '199.93', size: '0.5', clientOrderId: 'omm-1' };
  const reply = extra => json({ success: true, result: order(extra) });
  const responses = [
    () => { mono += 17; return reply({ status: 'canceled' }); },
    reply({ status: 'canceled', filledSize: '0.1' }), reply({ status: 'canceled', market: 'TSLA-USD.P' }),
    new Error('connection lost'), json({ error_code: 'post_only_has_match' }, 400), reply({ status: 'pending' }),
    reply({ filledSize: '0.1' }), reply({ reduceOnly: true }),
    json({ error_code: 'invalid_timestamp' }, 400, { Date: new Date(EPOCH).toUTCString() }),
    () => { mono += 24; return reply({}); },
  ];
  const { client, calls } = fixture(responses, { now, latency, rps: 20 });
  await client.cancel('abc123', { market });
  await client.cancel('abc123', { market });
  await assert.rejects(client.cancel('abc123', { market }), rejected('invalid_data', { uncertain: true }));
  await assert.rejects(client.place(input), rejected('network', { uncertain: true }));
  await assert.rejects(client.place(input), rejected('post_only_has_match'));
  await client.place(input); await client.place(input);
  await client.place({ ...input, reduceOnly: true });
  await client.place(input);
  await assert.rejects(client.place({ ...input, canSend: () => false }), rejected('send_guard'));
  const row = latency.snapshot().markets[0];
  assert.deepEqual([row.cancelAck.n, row.cancelAck.failed, row.cancelAck.p95Ms], [1, 2, 17]);
  assert.deepEqual([row.placeAck.n, row.placeAck.failed, row.placeAck.p95Ms, row.placeAck.lastFailureAt], [1, 5, 24, EPOCH + 17]);
  assert.deepEqual([row.restQueue.n, row.restQueue.lastMs], [10, 0]);
  assert.equal(calls.length, 10);
  client.close();
});

test('an observer failure leaves the outgoing order, its guard, and its result intact', async () => {
  const broken = () => { throw new Error('observer'); };
  const { client, calls } = fixture([json({ success: true, result: order() })], { latency: { stamp: broken, elapsed: broken } });
  const input = { market: 'NVDA-USD.P', side: 'buy', price: '199.93', size: '0.5', clientOrderId: 'omm-1' };
  const accepted = await client.place(input);
  await assert.rejects(client.place({ ...input, canSend: () => false }), rejected('send_guard'));
  assert.equal(accepted.status, 'open'); assert.equal(calls.length, 1);
  client.close();
});

test('an order is sent post-only, signed over its exact body, to the fixed host', async () => {
  const { client, calls } = fixture([json({ success: true, result: order() })]);
  const placed = await client.place({ market: 'NVDA-USD.P', side: 'buy', price: '199.93', size: '0.5', clientOrderId: 'omm-1' });
  assert.deepEqual(placed, { id: 'abc123', clientId: 'omm-1', market: 'NVDA-USD.P', side: 'buy', price: '199.93', size: '0.5', filled: '0', status: 'open', reduceOnly: false });
  const { url, init } = calls[0];
  assert.equal(url, 'https://api.ondoperps.xyz/v1/perps/orders');
  assert.deepEqual(JSON.parse(init.body), { market: 'NVDA-USD.P', side: 'buy', price: '199.93', size: '0.5', type: 'limit', timeInForce: 'GTC', postOnly: true, reduceOnly: false, clientOrderId: 'omm-1' });
  assert.equal(init.headers['ONDO-KEY-ID'], keys.keyId);
  assert.equal(init.headers['ONDO-TIMESTAMP'], String(EPOCH));
  assert.equal(init.headers['ONDO-SIGN'], createHmac('sha256', keys.secret).update(`${EPOCH}POST/v1/perps/orders${init.body}`).digest('hex'));
  assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
  await assert.rejects(client.place({ market: 'nvda', side: 'buy', price: '1', size: '1', clientOrderId: 'a' }), TypeError);
  await assert.rejects(client.place({ market: 'NVDA-USD.P', side: 'buy', price: '0', size: '1', clientOrderId: 'a' }), TypeError);
  await assert.rejects(client.cancel('../x'), TypeError);
  assert.equal(calls.length, 1);
});

test('a refusal keeps only the venue code, never its message', async () => {
  const { client } = fixture([json({ success: false, error: `key id not found: ${keys.keyId}`, error_code: 'post_only_has_match' }, 400)]);
  const error = await client.place({ market: 'NVDA-USD.P', side: 'buy', price: '1', size: '1', clientOrderId: 'a' }).catch(value => value);
  assert.ok(rejected('post_only_has_match', { uncertain: false, status: 400 })(error));
  assert.ok(!JSON.stringify({ ...error, message: error.message }).includes(keys.keyId));
});

test('terminal order reports expose venue fill and cancel times for matching later depth', async () => {
  const when = new Date(EPOCH + 123).toISOString();
  const { client } = fixture([
    json({ success: true, result: order({ status: 'canceled', canceledAt: when, filledAt: 'invalid' }) }),
    json({ success: true, result: order({ status: 'fullyfilled', filledSize: '0.5', filledAt: when }) }),
  ]);
  const canceled = await client.cancel('abc123');
  assert.equal(canceled.canceledAt, EPOCH + 123); assert.equal(canceled.filledAt, undefined);
  assert.equal((await client.orderByClientId('omm-1')).filledAt, EPOCH + 123);
});

test('a write that fails after it was sent is uncertain and is not sent again; a read is not', async () => {
  const lost = fixture([new Error('socket hang up'), json({}, 502), new Response('<html>', { status: 200 }), new Error('socket hang up')]);
  const input = { market: 'NVDA-USD.P', side: 'buy', price: '1', size: '1', clientOrderId: 'a' };
  await assert.rejects(lost.client.place(input), rejected('network', { uncertain: true }));
  await assert.rejects(lost.client.place(input), rejected('upstream', { uncertain: true }));
  await assert.rejects(lost.client.cancel('abc'), rejected('invalid_data', { uncertain: true }));
  await assert.rejects(lost.client.positions(), rejected('network', { uncertain: false }));
  assert.equal(lost.calls.length, 4);
});

test('a request that outlives the timeout is aborted', async () => {
  const { client } = fixture([init => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))], { timeoutMs: 20 });
  await assert.rejects(client.cancel('abc'), rejected('timeout', { uncertain: true }));
});

test('a 429 starts a cooldown in which nothing is sent', async () => {
  const { client, calls, clock } = fixture([json({ success: false, error_code: 'too_many_requests' }, 429, { 'Retry-After': '7' }), json({ success: true, result: [] })]);
  await assert.rejects(client.positions(), rejected('rate_limited', { uncertain: false }));
  assert.equal(client.cooldownUntil(), EPOCH + 7000);
  await assert.rejects(client.cancel('abc'), rejected('rate_limited'));
  await assert.rejects(client.place({ market: 'NVDA-USD.P', side: 'buy', price: '1', size: '1', clientOrderId: 'a' }), rejected('rate_limited'));
  assert.equal(calls.length, 1);
  clock.now += 7000;
  assert.equal((await client.positions()).size, 0);
  // Without Retry-After the wait doubles from 2 s; a restarted session inherits the cooldown.
  const plain = fixture([json({}, 429), json({}, 429)]);
  await assert.rejects(plain.client.positions(), rejected('rate_limited'));
  assert.equal(plain.client.cooldownUntil(), EPOCH + 2000);
  plain.clock.now += 2000;
  await assert.rejects(plain.client.positions(), rejected('rate_limited'));
  assert.equal(plain.client.cooldownUntil(), EPOCH + 2000 + 4000);
  const inherited = fixture([], { cooldownUntil: EPOCH + 5000 });
  await assert.rejects(inherited.client.positions(), rejected('rate_limited'));
  assert.equal(inherited.calls.length, 0);
});

test('a refused timestamp is re-signed once against the venue clock', async () => {
  const date = new Date(EPOCH + 30_000).toUTCString();
  const { client, calls } = fixture([json({ success: false, error_code: 'invalid_timestamp' }, 400, { Date: date }), json({ success: true, result: [] })]);
  await client.positions();
  assert.equal(calls[1].init.headers['ONDO-TIMESTAMP'], String(EPOCH + 30_000));
  const twice = fixture([json({ success: false, error_code: 'invalid_timestamp' }, 400, { Date: date }), json({ success: false, error_code: 'invalid_timestamp' }, 400, { Date: date })]);
  await assert.rejects(twice.client.positions(), rejected('invalid_timestamp'));
  assert.equal(twice.calls.length, 2);
});

test('open orders are complete or an error, and a missing client id is null', async () => {
  const paged = fixture([json({ success: true, result: [order()], pageInfo: { nextCursor: 'N=' } }), json({ success: true, result: [order({ orderId: 'def456', clientOrderId: undefined })], pageInfo: {} })]);
  assert.deepEqual((await paged.client.openOrders()).map(item => [item.id, item.clientId]), [['abc123', 'omm-1'], ['def456', null]]);
  assert.equal(paged.calls[1].url, 'https://api.ondoperps.xyz/v1/perps/orders?status=open&limit=1000&cursor=N%3D');
  const endless = fixture([1, 2, 3].map(() => json({ success: true, result: [order()], pageInfo: { nextCursor: 'N' } })));
  await assert.rejects(endless.client.openOrders(), rejected('incomplete_data'));
  const broken = fixture([json({ success: true, result: [{ orderId: 'x' }] })]);
  await assert.rejects(broken.client.openOrders(), rejected('invalid_data'));
  const lookup = fixture([json({ success: false, error_code: 'order_not_found' }, 400), json({ success: true, result: order({ status: 'fullyfilled' }) }), json({}, 500)]);
  assert.equal(await lookup.client.orderByClientId('omm-1'), null);
  assert.equal(lookup.calls[0].url, 'https://api.ondoperps.xyz/v1/perps/orders/client:omm-1');
  assert.equal((await lookup.client.orderByClientId('omm-1')).status, 'fullyfilled');
  await assert.rejects(lookup.client.orderByClientId('omm-1'), rejected('upstream'));
});

test('positions are signed by direction and market rules come from the public list', async () => {
  const { client, calls } = fixture([json({ success: true, result: [{ market: 'NVDA-USD.P', direction: 'short', netQuantity: '0.50' }, { market: 'BTC-USD.P', direction: 'long', netQuantity: '0.0010' }] }),
    json({ success: true, result: { perps: { tradingPairs: [{ market: 'NVDA-USD.P', baseIncrement: '0.01', quoteIncrement: '0.01', tradingState: 'TRADING', makerFee: '0.00020' },
      { market: 'TSLA-USD.P', baseIncrement: '0.01', quoteIncrement: '0.01', tradingState: 'TRADING', disabled: true }, { market: 'AMD-USD.P', baseIncrement: '0.1', quoteIncrement: '0.01', tradingState: 'CLOSED' }] } } }),
    json({ success: true, result: [{ market: 'NVDA-USD.P', direction: 'sideways', netQuantity: '1' }] })]);
  assert.deepEqual([...await client.positions()], [['NVDA-USD.P', '-0.5'], ['BTC-USD.P', '0.001']]);
  const rules = await client.markets();
  assert.equal(calls[1].init.headers['ONDO-SIGN'], undefined);
  assert.deepEqual(rules.get('NVDA-USD.P'), { tick: '0.01', step: '0.01', trading: true, makerFee: '0.0002' });
  // 本服务：a missing maker fee is null, not a refusal.
  assert.equal(rules.get('TSLA-USD.P').makerFee, null);
  assert.equal(rules.get('TSLA-USD.P').trading, false); assert.equal(rules.get('AMD-USD.P').trading, false);
  await assert.rejects(client.positions(), rejected('invalid_data'));
});

test('本服务：the public depth is read without signing and must name the market asked for', async () => {
  const book = { market: 'NVDA-USD.P', time: EPOCH, bids: [['200.00', '10']], asks: [['200.04', '5']] };
  const { client, calls } = fixture([json({ success: true, result: book }), json({ success: true, result: { ...book, market: 'TSLA-USD.P' } })]);
  assert.deepEqual(await client.depth('NVDA-USD.P', 50), book);
  assert.equal(calls[0].url, 'https://api.ondoperps.xyz/v1/perps/depth?market=NVDA-USD.P&depth=50');
  assert.equal(calls[0].init.headers['ONDO-SIGN'], undefined);
  await assert.rejects(client.depth('NVDA-USD.P'), rejected('invalid_data'));
});

test('requests share one bucket and cancels go ahead of new quotes', async () => {
  const timers = [], sent = [];
  const clock = { now: EPOCH };
  const client = createOndoClient({ credentials: keys, now: () => clock.now, rps: 1, setTimeoutImpl: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeoutImpl() {},
    fetchImpl: async (url, init) => { sent.push(init.method); return init.method === 'DELETE' ? json({ success: true, result: order({ status: 'canceled' }) }) : json({ success: true, result: order() }); } });
  const input = { market: 'NVDA-USD.P', side: 'buy', price: '199.93', size: '0.5', clientOrderId: 'omm-1' };
  const all = [client.place(input), client.place(input), client.cancel('abc123')];
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent, ['POST']);
  for (let round = 0; round < 2; round++) { clock.now += 1000; const due = timers.find(timer => timer.ms <= 1000 && !timer.fired); due.fired = true; due.fn(); await new Promise(resolve => setImmediate(resolve)); }
  await Promise.all(all);
  assert.deepEqual(sent, ['POST', 'DELETE', 'POST']);
  client.close();
  await assert.rejects(client.positions(), rejected('closed'));
});

test('an accepted placement that cannot be read is uncertain', async () => {
  const { client } = fixture([json({ success: true, result: { orderId: 'abc123' } })]);
  await assert.rejects(client.place({ market: 'NVDA-USD.P', side: 'buy', price: '1', size: '1', clientOrderId: 'a' }), rejected('invalid_data', { uncertain: true }));
});

test('an IOC is a signed reduce-only limit and every response is bound to its original request', async () => {
  const input = { market: 'NVDA-USD.P', side: 'sell', price: '199.93', size: '0.5', clientOrderId: 'omm-1', reduceOnly: true, timeInForce: 'IOC' };
  const good = { side: 'sell', reduceOnly: true, status: 'canceled', timeInForce: 'IOC' };
  const wrong = [{ market: 'TSLA-USD.P' }, { clientOrderId: 'another' }, { side: 'buy' }, { price: '199.94' },
    { size: '0.501' }, { reduceOnly: false }, { timeInForce: 'GTC' }, { filledSize: '1' }];
  const reply = extra => json({ success: true, result: order({ ...good, ...extra }) });
  const { client, calls, clock } = fixture([reply({}), ...wrong.map(reply), reply({ orderId: 'different' }), reply({ clientOrderId: 'another' })]);
  await assert.rejects(client.place({ ...input, reduceOnly: false }), TypeError);
  await client.place(input);
  assert.deepEqual(JSON.parse(calls[0].init.body), { market: input.market, side: 'sell', price: input.price, size: input.size, type: 'limit', timeInForce: 'IOC', postOnly: false, reduceOnly: true, clientOrderId: input.clientOrderId });
  for (const _ of wrong) await assert.rejects(client.place(input), rejected('invalid_data', { uncertain: true }));
  clock.now += 1000;
  await assert.rejects(client.cancel('abc123'), rejected('invalid_data', { uncertain: true }));
  await assert.rejects(client.orderByClientId('omm-1'), rejected('invalid_data', { uncertain: false }));
});

test('a locally vetoed queued order or timestamp retry never reaches fetch', async () => {
  const timers = [], clock = { now: EPOCH };
  const { client, calls } = fixture([json({ success: true, result: [] })], { rps: 1, now: () => clock.now,
    setTimeoutImpl(fn, ms) { timers.push({ fn, ms }); return timers.length; }, clearTimeoutImpl() {} });
  await client.positions();
  let armed = true;
  const input = { market: 'NVDA-USD.P', side: 'buy', price: '199.93', size: '0.5', clientOrderId: 'omm-1', canSend: () => armed };
  const queued = client.place(input);
  armed = false; clock.now += 1000; timers.find(timer => timer.ms === 1000).fn();
  await assert.rejects(queued, rejected('send_guard', { uncertain: false })); assert.equal(calls.length, 1);
  armed = true;
  const resigned = fixture([() => { armed = false; return json({ error_code: 'invalid_timestamp' }, 400, { Date: new Date(EPOCH).toUTCString() }); }]);
  await assert.rejects(resigned.client.place(input), rejected('send_guard', { uncertain: false })); assert.equal(resigned.calls.length, 1);
});

test('position details retain the venue entry price, accept explicit neutral zero, and reject an inconsistent direction', async () => {
  const rows = [{ market: 'NVDA-USD.P', direction: 'short', netQuantity: '0.500', averageEntryPrice: '200.070' },
    { market: 'TSLA-USD.P', direction: 'neutral', netQuantity: '0', averageEntryPrice: '0' },
    { market: 'AMD-USD.P', direction: 'long', netQuantity: '1', averageEntryPrice: 'unavailable' }];
  const { client } = fixture([json({ success: true, result: rows }), json({ success: true, result: [{ ...rows[1], netQuantity: '1' }] })]);
  assert.deepEqual([...(await client.positions({ details: true }))], [['NVDA-USD.P', { size: '-0.5', entryPrice: '200.07' }],
    ['TSLA-USD.P', { size: '0', entryPrice: null }], ['AMD-USD.P', { size: '1', entryPrice: null }]]);
  await assert.rejects(client.positions(), rejected('invalid_data'));
});

test('a cancel waits out a shorter, bounded part of a cooldown, and its own 429 is counted once per burst', async () => {
  const ok = () => json({ success: true, result: order({ status: 'canceled' }) });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const held = async () => { await gate; return json({}, 429); };
  const turn = () => new Promise(resolve => setImmediate(resolve));
  const { client, calls, clock } = fixture([json({}, 429, { 'Retry-After': '120' }), ok(), held, held, ok()]);
  await assert.rejects(client.positions(), rejected('rate_limited'));
  clock.now += 14_999;
  await assert.rejects(client.cancel('abc123'), rejected('rate_limited'));
  clock.now += 1;
  assert.equal((await client.cancel('abc123')).status, 'canceled');
  await assert.rejects(client.place({ market: 'NVDA-USD.P', side: 'buy', price: '1', size: '1', clientOrderId: 'a' }), rejected('rate_limited'));
  await assert.rejects(client.openOrders(), rejected('rate_limited'));
  assert.equal(calls.length, 2);
  // Two cancels in flight together (requested in different turns, so not one batch) are both refused: one strike, the next cancel may go after 2 s.
  const sent = [client.cancel('abc123')];
  await turn(); sent.push(client.cancel('abc124')); await turn(); release();
  const pair = await Promise.allSettled(sent);
  assert.ok(pair.every(result => result.status === 'rejected' && result.reason.code === 'rate_limited'));
  assert.equal(client.cooldownUntil(), EPOCH + 120_000);
  clock.now += 1999;
  await assert.rejects(client.cancel('abc123'), rejected('rate_limited'));
  clock.now += 1;
  assert.equal((await client.cancel('abc123')).status, 'canceled');
  assert.equal(calls.length, 5);
});

test('venue codes of any case are kept, lower-cased, and a 2xx write without a verdict is uncertain', async () => {
  const input = { market: 'NVDA-USD.P', side: 'buy', price: '1', size: '1', clientOrderId: 'a' };
  const { client } = fixture([json({ success: false, error_code: 'clientOrderID_collision' }, 400), json({ success: false, error_code: 'Order_Not_Found' }, 400), json({}, 404), json({ result: order() })]);
  await assert.rejects(client.place(input), rejected('clientorderid_collision', { uncertain: false }));
  assert.equal(await client.orderByClientId('a'), null);
  assert.equal(await client.orderByClientId('a'), null);
  await assert.rejects(client.place(input), rejected('invalid_data', { uncertain: true }));
});

const canceled = (id, extra = {}) => order({ orderId: id, clientOrderId: `omm-${id}`, status: 'canceled', ...extra });
const batch = (successfulCancels, failedCancels = []) => json({ success: true, result: { successfulCancels, failedCancels } });
const BATCH = 'https://api.ondoperps.xyz/v1/perps/orders/batch?orderIDs=';
const cancelAll = (client, ids, expected = { market: 'NVDA-USD.P' }) => Promise.allSettled(ids.map(id => client.cancel(id, expected)));

test('cancels requested together travel as one signed batch and each order gets its own answer', async () => {
  const { client, calls } = fixture([batch(
    [canceled('b2'), canceled('b1'), canceled('b5', { market: 'TSLA-USD.P' }), canceled('b6', { status: 'open' }), canceled('b8'), canceled('b8')],
    [{ orderId: 'b3', error: `gone ${keys.keyId}`, errorCode: 'Order_Already_Fully_Filled' }, { orderId: 'b4', error: 'boom', errorCode: '' }])]);
  const results = await cancelAll(client, ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8']);
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, `${BATCH}b1,b2,b3,b4,b5,b6,b7,b8`); assert.equal(init.method, 'DELETE'); assert.equal(init.body, undefined);
  assert.equal(init.headers['ONDO-SIGN'], createHmac('sha256', keys.secret).update(`${EPOCH}DELETE/v1/perps/orders/batch?orderIDs=b1,b2,b3,b4,b5,b6,b7,b8`).digest('hex'));
  assert.deepEqual(results.slice(0, 2).map(result => [result.value.id, result.value.status]), [['b1', 'canceled'], ['b2', 'canceled']]);
  assert.ok(rejected('order_already_fully_filled', { uncertain: false })(results[2].reason));
  assert.ok(!results[2].reason.message.includes(keys.keyId));
  // No code, another market, a nonterminal status, not listed at all, listed twice: the outcome is unknown.
  for (const result of results.slice(3)) assert.ok(rejected('invalid_data', { uncertain: true })(result.reason));
  assert.equal(client.batchCancels(), true);
});

test('a batch refused as a whole is asked again one by one, and an unsupported batch ends batching for the client', async () => {
  const refusal = code => json({ success: false, error_code: code }, 400);
  const one = id => json({ success: true, result: canceled(id) });
  const { client, calls } = fixture([refusal('order_not_found'), one('b1'), refusal('order_not_found'), batch([canceled('b3'), canceled('b4')]),
    refusal('batch_cancel_too_many_orders'), one('b5'), one('b6'), one('b7'), one('b8')]);
  const first = await cancelAll(client, ['b1', 'b2']);
  assert.equal(first[0].value.id, 'b1'); assert.ok(rejected('order_not_found', { uncertain: false })(first[1].reason));
  assert.deepEqual(calls.map(call => call.url.split('/orders/')[1]), ['batch?orderIDs=b1,b2', 'b1', 'b2']);
  // One order's state refused that batch: the next one is still sent as a batch.
  assert.equal(client.batchCancels(), true);
  assert.ok((await cancelAll(client, ['b3', 'b4'])).every(result => result.status === 'fulfilled')); assert.equal(calls.length, 4);
  assert.ok((await cancelAll(client, ['b5', 'b6'])).every(result => result.status === 'fulfilled'));
  assert.equal(calls.length, 7); assert.equal(client.batchCancels(), false);
  assert.ok((await cancelAll(client, ['b7', 'b8'])).every(result => result.status === 'fulfilled'));
  assert.deepEqual(calls.slice(7).map(call => call.url.split('/orders/')[1]), ['b7', 'b8']);
});

test('a batch whose outcome was not read leaves every order unknown and is never sent again', async () => {
  const { client, calls, clock } = fixture([new Error('connection lost'), json({}, 502), json({ success: false, error_code: 'unauthorized' }, 401),
    json({}, 429), json({ success: true, result: { successfulCancels: {} } })]);
  for (const code of ['network', 'upstream']) {
    assert.ok((await cancelAll(client, ['b1', 'b2'])).every(result => rejected(code, { uncertain: true })(result.reason)), code);
  }
  assert.ok((await cancelAll(client, ['b1', 'b2'])).every(result => rejected('unauthorized', { uncertain: false, status: 401 })(result.reason)));
  assert.ok((await cancelAll(client, ['b1', 'b2'])).every(result => rejected('rate_limited', { uncertain: false })(result.reason)));
  assert.equal(calls.length, 4); assert.equal(client.batchCancels(), true);
  clock.now += 2000;
  // The venue said success in a shape that names no order: unknown, and later cancels go one by one.
  assert.ok((await cancelAll(client, ['b1', 'b2'])).every(result => rejected('invalid_data', { uncertain: true })(result.reason)));
  assert.equal(calls.length, 5); assert.equal(client.batchCancels(), false);
});

test('a batch holds at most twenty distinct valid ids; a lone, repeated or invalid one keeps the single request', async () => {
  const ids = Array.from({ length: 21 }, (_, index) => `c${index + 1}`);
  const many = fixture([batch(ids.slice(0, 20).map(id => canceled(id))), json({ success: true, result: canceled('c21') })], { rps: 2 });
  assert.ok((await cancelAll(many.client, ids)).every(result => result.status === 'fulfilled'));
  assert.deepEqual(many.calls.map(call => call.url.split('/orders/')[1]), [`batch?orderIDs=${ids.slice(0, 20).join(',')}`, 'c21']);
  const { client, calls } = fixture([json({ success: true, result: canceled('b1') }), json({ success: false, error_code: 'order_already_canceled' }, 400)]);
  const results = await Promise.allSettled([client.cancel('bad id'), client.cancel('b1'), client.cancel('b1')]);
  assert.ok(results[0].reason instanceof TypeError); assert.equal(results[1].value.id, 'b1');
  assert.ok(rejected('order_already_canceled')(results[2].reason));
  assert.deepEqual(calls.map(call => call.url.split('/orders/')[1]), ['b1', 'b1']);
});

test('a batch cancel is timed once per order and its queue wait once per market', async () => {
  let mono = 0;
  const markets = ['NVDA-USD.P', 'TSLA-USD.P'], now = () => EPOCH + mono;
  const latency = createOndoLatency({ markets, mode: 'live', startedAt: EPOCH, now, monotonicNow: () => mono });
  const client = createOndoClient({ credentials: keys, rps: 10, now, latency, fetchImpl: async () => {
    mono += 9;
    return batch([canceled('b1'), canceled('b2'), canceled('b3', { market: markets[1], filledSize: '0.1' })]);
  } });
  await Promise.all([client.cancel('b1', { market: markets[0] }), client.cancel('b2', { market: markets[0] }), client.cancel('b3', { market: markets[1] })]);
  const [a, b] = latency.snapshot().markets;
  assert.deepEqual([a.cancelAck.n, a.cancelAck.lastMs, a.restQueue.n], [2, 9, 1]);
  // A cancel that reports a fill is not a clean acknowledgement.
  assert.deepEqual([b.cancelAck.n, b.cancelAck.failed, b.restQueue.n], [0, 1, 1]);
  client.close();
});

test('a batch answered with a code but no 4xx, re-signed, or cut off by close keeps every order honest', async () => {
  // HTTP 200 with a code names no order: it must not become every order's "already filled".
  const vague = fixture([json({ success: false, error_code: 'order_already_fully_filled' })]);
  assert.ok((await cancelAll(vague.client, ['b1', 'b2'])).every(result => rejected('invalid_data', { uncertain: true })(result.reason)));
  assert.equal(vague.calls.length, 1); assert.equal(vague.client.batchCancels(), false);
  const blank = fixture([json({ success: false })]);
  assert.ok((await cancelAll(blank.client, ['b1', 'b2'])).every(result => rejected('invalid_data', { uncertain: true })(result.reason)));
  assert.equal(blank.client.batchCancels(), false);

  let mono = 0;
  const market = 'NVDA-USD.P', now = () => EPOCH + mono;
  const latency = createOndoLatency({ markets: [market], mode: 'live', startedAt: EPOCH, now, monotonicNow: () => mono });
  const replies = [json({ success: false, error_code: 'invalid_timestamp' }, 400, { Date: new Date(EPOCH + 30_000).toUTCString() }), batch([canceled('b1'), canceled('b2')])];
  const stamps = [];
  const client = createOndoClient({ credentials: keys, rps: 10, now, latency, fetchImpl: async (_, init) => { mono += 5; stamps.push(init.headers['ONDO-TIMESTAMP']); return replies.shift(); } });
  const resigned = await cancelAll(client, ['b1', 'b2'], { market });
  assert.ok(resigned.every(result => result.status === 'fulfilled'));
  assert.equal(stamps.length, 2); assert.notEqual(stamps[0], stamps[1]);
  const row = latency.snapshot().markets[0];
  assert.deepEqual([row.cancelAck.n, row.cancelAck.failed], [2, 2]);
  client.close();

  let hang;
  const open = fixture([() => new Promise((_, reject) => { hang = reject; })]);
  const pending = cancelAll(open.client, ['b1', 'b2']);
  await new Promise(resolve => setImmediate(resolve));
  open.client.close(); hang(new Error('aborted'));
  assert.ok((await pending).every(result => rejected('closed', { uncertain: true })(result.reason)));
  assert.equal(open.calls.length, 1);
});
