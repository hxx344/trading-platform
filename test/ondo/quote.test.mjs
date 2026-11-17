// Ported from the workbench (project-aggregation 7745181 tests/), with the imports pointed at src/vendor/ondo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { ondoAuthHeaders, ondoSignature, ondoWsLogin } from '../../src/vendor/ondo/transport.mjs';
import { decimalUnits as u, formatDecimalUnits as f } from '../../src/vendor/ondo/decimal.mjs';
import { assessQuote, closeMoves, closePrice, planQuote, quoteSize, withoutOrders } from '../../src/vendor/ondo/quote.mjs';

const keys = { keyId: 'ondoKeyId_fixture', secret: 'ondoApiSecret_fixture' };

test('REST signature covers timestamp, method, path with query and the exact body', () => {
  const body = '{"side":"buy"}';
  const expected = createHmac('sha256', keys.secret).update(`1700000000000POST/v1/perps/orders${body}`).digest('hex');
  assert.equal(ondoSignature(keys.secret, { timestamp: '1700000000000', method: 'POST', requestPath: '/v1/perps/orders', body }), expected);
  const headers = ondoAuthHeaders(keys, { timestamp: '1700000000000', method: 'GET', requestPath: '/v1/perps/orders?status=open' });
  assert.deepEqual(Object.keys(headers), ['ONDO-KEY-ID', 'ONDO-TIMESTAMP', 'ONDO-SIGN']);
  assert.equal(headers['ONDO-SIGN'], createHmac('sha256', keys.secret).update('1700000000000GET/v1/perps/orders?status=open').digest('hex'));
  assert.throws(() => ondoSignature(keys.secret, { timestamp: '1700000000', method: 'GET', requestPath: '/v1/x' }), TypeError);
  assert.throws(() => ondoSignature(keys.secret, { timestamp: '1700000000000', method: 'GET', requestPath: '/v1/x', body: '{}' }), TypeError);
  assert.throws(() => ondoSignature(keys.secret, { timestamp: '1700000000000', method: 'PUT', requestPath: '/v1/x' }), TypeError);
  assert.throws(() => ondoAuthHeaders({ keyId: '', secret: 'x' }, { timestamp: '1700000000000', method: 'GET', requestPath: '/v1/x' }), TypeError);
});

test('WebSocket login signs the time with the fixed suffix', () => {
  const login = ondoWsLogin(keys, '1700000000000');
  assert.deepEqual(login, { op: 'login', args: { key: keys.keyId, time: '1700000000000', sign: createHmac('sha256', keys.secret).update('1700000000000ondo_perps_ws_login').digest('hex') } });
});

const levels = rows => rows.map(([price, size]) => [u(price), u(size)]);
const book = (bids, asks) => ({ bids: levels(bids), asks: levels(asks) });
const cfg = (extra = {}) => ({ target: u('4'), min: u('3'), max: u('4.8'), wallMin: u('5000'), ...extra });
const TICK = u('0.01');
// Mid 200.02; one tick is 0.5 bps.
const B = book([['200.00', '10'], ['199.98', '20'], ['199.95', '100'], ['199.90', '300']], [['200.04', '10'], ['200.06', '20'], ['200.09', '100'], ['200.14', '300']]);

test('protected quotes sit at the tick nearest the mid that is at least the target away', () => {
  const buy = planQuote('buy', B, B, TICK, cfg()), sell = planQuote('sell', B, B, TICK, cfg());
  // 200.02 × (1 − 4 bps) = 199.939992, 200.02 × (1 + 4 bps) = 200.100008.
  assert.equal(f(buy.price), '199.93'); assert.equal(f(sell.price), '200.11');
  assert.equal(buy.mode, 'wall');
  assert.ok(buy.bps >= 4 && buy.bps <= 4.8 && sell.bps >= 4 && sell.bps <= 4.8);
});

test('a coarse tick uses the tick just inside the target, or none when it would be too close', () => {
  // Mid 100.01, one tick is 1 bp: 99.96 is 5.0 bps (beyond 4.8), 99.97 is 4.0 bps.
  const coarse = book([['100.00', '50']], [['100.02', '50']]);
  assert.equal(f(planQuote('buy', coarse, coarse, TICK, cfg()).price), '99.97');
  assert.equal(f(planQuote('sell', coarse, coarse, TICK, cfg()).price), '100.05');
  // Mid 10.005, one tick is 10 bps: nothing rests between 3 and 4.8 bps.
  const tiny = book([['10.00', '50']], [['10.01', '50']]);
  assert.deepEqual(planQuote('buy', tiny, tiny, TICK, cfg()), { price: null, reason: 'no_tick_in_band' });
});

test('a quote inside a wide spread cannot rest without a better external order', () => {
  const wide = book([['100.00', '5']], [['101.00', '5']]);
  assert.deepEqual(planQuote('buy', wide, wide, TICK, cfg({ wallMin: u('1') })), { price: null, reason: 'unprotected' });
  assert.deepEqual(assessQuote('buy', u('100.91'), wide, wide, TICK, cfg()), { keep: false, reason: 'unprotected', urgent: true });
});

test('wall protection moves one tick behind the level that puts enough size in front', () => {
  const wide = cfg({ max: u('10'), wallEnabled: true, wallMin: u('50000') });
  // In front of 199.93: 2000 + 3999.6 + 19995 = 25994.6 USD. Behind 199.90 it is 85964.6 USD.
  const buy = planQuote('buy', B, B, TICK, wide);
  assert.equal(f(buy.price), '199.89'); assert.equal(buy.mode, 'wall'); assert.equal(f(buy.protection), '85964.6');
  const enough = planQuote('buy', B, B, TICK, cfg({ wallEnabled: true, wallMin: u('5000') }));
  assert.equal(f(enough.price), '199.93'); assert.equal(enough.mode, 'wall');
  // Neither legacy settings nor an amount of zero can disable the requirement.
  for (const wallMin of [u('50000'), 0n]) for (const side of ['buy', 'sell']) {
    assert.deepEqual(planQuote(side, B, B, TICK, cfg({ wallEnabled: false, wallMin })), { price: null, reason: 'unprotected' });
  }
});

test('only strictly better external levels count, down to the exact USD threshold on each side', () => {
  for (const [side, price, threshold] of [['buy', '199.93', '5999.6'], ['sell', '200.11', '6001.6']]) {
    const buy = side === 'buy';
    const ref = book([['200', '10'], ['199.98', '20'], ['199.95', '100'], ['199.93', '10000']], [['200.04', '10'], ['200.06', '20'], ['200.09', '100'], ['200.11', '10000']]);
    const external = withoutOrders(ref, [{ side, price: u(buy ? '199.95' : '200.09'), remaining: u('100') }]);
    const exact = cfg({ wallMin: u(threshold) });
    assert.equal(planQuote(side, ref, external, TICK, exact).price, u(price));
    assert.equal(assessQuote(side, u(price), ref, external, TICK, exact).protection, u(threshold));
    const short = cfg({ wallMin: u(threshold) + 1n });
    assert.deepEqual(assessQuote(side, u(price), ref, external, TICK, short), { keep: false, reason: 'unprotected', urgent: true });
    assert.deepEqual(planQuote(side, ref, external, TICK, short), { price: null, reason: 'unprotected' });
  }
});

test('own orders are not counted as external protection and are never crossed', () => {
  const own = [{ side: 'buy', price: u('199.95'), remaining: u('100') }];
  const ext = withoutOrders(B, own);
  assert.deepEqual(ext.bids.map(([price]) => f(price)), ['200', '199.98', '199.9']);
  assert.equal(f(planQuote('buy', B, ext, TICK, cfg()).protection), '5999.6');
  // An own sell resting at 199.93 pushes the buy below it, out of the band.
  assert.deepEqual(planQuote('buy', B, B, TICK, cfg(), u('199.93')), { price: null, reason: 'own_order_in_way' });
  assert.equal(f(planQuote('buy', B, B, TICK, cfg({ max: u('10') }), u('199.93')).price), '199.92');
  assert.deepEqual(assessQuote('buy', u('199.93'), B, B, TICK, cfg(), u('199.93')), { keep: false, reason: 'own_order_in_way', urgent: true });
});

test('a resting quote is urgent when too close and patient when too far', () => {
  assert.equal(assessQuote('buy', u('199.93'), B, B, TICK, cfg()).keep, true);
  const down = book([['199.94', '10']], [['199.98', '10']]);
  assert.deepEqual(assessQuote('buy', u('199.93'), down, down, TICK, cfg()), { keep: false, reason: 'too_close', urgent: true });
  const up = book([['200.10', '50']], [['200.14', '50']]);
  assert.deepEqual(assessQuote('buy', u('199.93'), up, up, TICK, cfg()), { keep: false, reason: 'too_far', urgent: false });
  const vanished = book([['200.10', '20']], [['200.14', '50']]);
  assert.deepEqual(assessQuote('buy', u('199.93'), vanished, vanished, TICK, cfg()), { keep: false, reason: 'unprotected', urgent: true });
  // The market traded through the quote: it no longer rests below the ask.
  const through = book([['199.90', '10']], [['199.92', '10']]);
  assert.equal(assessQuote('buy', u('199.93'), through, through, TICK, cfg()).reason, 'too_close');
  const empty = book([], [['200.04', '1']]);
  assert.deepEqual(assessQuote('buy', u('199.93'), empty, empty, TICK, cfg()), { keep: false, reason: 'no_book', urgent: true });
  assert.deepEqual(planQuote('buy', empty, empty, TICK, cfg()), { price: null, reason: 'no_book' });
});

test('a close joins the touch without crossing and only follows toward it', () => {
  assert.equal(f(closePrice('sell', B, TICK)), '200.04'); assert.equal(f(closePrice('buy', B, TICK)), '200');
  assert.equal(f(closePrice('sell', book([['200.00', '1']], []), TICK)), '200.01');
  assert.equal(f(closePrice('buy', book([], [['200.04', '1']]), TICK)), '200.03');
  assert.equal(closePrice('sell', book([], []), TICK), null);
  assert.equal(closeMoves('sell', u('200.04'), u('200.02')), true); assert.equal(closeMoves('sell', u('200.04'), u('200.08')), false);
  assert.equal(closeMoves('buy', u('200.00'), u('200.02')), true); assert.equal(closeMoves('buy', u('200.00'), u('199.90')), false);
});

test('size is the USD amount rounded down to the size step', () => {
  assert.equal(f(quoteSize(u('100'), u('199.93'), u('0.01'))), '0.5');
  assert.equal(f(quoteSize(u('1'), u('199.93'), u('0.01'))), '0');
});
