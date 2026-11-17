// Ported from the workbench (project-aggregation 7745181 tests/), with the imports pointed at src/vendor/ondo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createOndoStream, parseOndoBook } from '../../src/vendor/ondo/stream.mjs';
import { createOndoLatency } from '../../src/vendor/ondo/latency.mjs';
import { formatDecimalUnits as f } from '../../src/vendor/ondo/decimal.mjs';

const EPOCH = 1_800_000_000_000;
const keys = { keyId: 'ondoKeyId_fixture', secret: 'ondoApiSecret_fixture-secret' };
const flush = async () => { for (let index = 0; index < 5; index += 1) await Promise.resolve(); };
function fixture(options = {}) {
  let time = EPOCH, nextTimer = 0;
  const timers = new Map(), sockets = [], books = [], hints = [], downs = [];
  class Socket {
    constructor(url) { this.url = url; this.sent = []; this.listeners = new Map(); this.closed = false; sockets.push(this); }
    addEventListener(name, fn) { const list = this.listeners.get(name) ?? []; list.push(fn); this.listeners.set(name, list); }
    emit(name, value) { for (const fn of this.listeners.get(name) ?? []) fn(value); }
    send(text) { if (this.closed) throw new Error('closed'); this.sent.push(JSON.parse(text)); }
    frame(value) { this.emit('message', { data: typeof value === 'string' ? value : JSON.stringify(value) }); }
    close() { this.closed = true; this.emit('close', {}); }
  }
  const stream = createOndoStream({ markets: ['NVDA-USD.P'], WebSocketImpl: Socket, now: () => time,
    setTimeoutImpl: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, at: time + ms }); return id; }, clearTimeoutImpl: id => timers.delete(id),
    onBook: (market, book, at) => books.push({ market, book, at }), onPrivate: (channel, data) => hints.push({ channel, data }), onDown: reason => downs.push(reason), ...options });
  async function advance(ms) {
    const until = time + ms;
    for (;;) {
      const first = [...timers].filter(([, value]) => value.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!first) break;
      timers.delete(first[0]); time = first[1].at; first[1].fn(); await flush();
    }
    time = until;
  }
  const depth = (extra = {}) => ({ type: 'update', channel: 'depthBooksPerps', timestamp: time, data: [{ market: 'NVDA-USD.P', time: new Date(time).toISOString(), asks: [['200.04', '10'], ['200.06', '20']], bids: [['200.00', '10'], ['199.98', '20']], ...extra }] });
  return { stream, sockets, books, hints, downs, advance, depth, now: () => time };
}

test('depth snapshots are parsed exactly and malformed or crossed ones become null', () => {
  const book = parseOndoBook({ time: '2026-11-12T18:30:26.554762785Z', asks: [['166.01', '56.97']], bids: [['165.95', '310.32'], ['165.93', '225.9']] });
  assert.equal(book.time, Date.parse('2026-11-12T18:30:26.554Z'));
  assert.deepEqual(book.bids.map(([price, size]) => [f(price), f(size)]), [['165.95', '310.32'], ['165.93', '225.9']]);
  assert.equal(parseOndoBook({ time: '2026-11-12T18:30:26Z', asks: [['165.95', '1']], bids: [['165.95', '1']] }), null);
  assert.equal(parseOndoBook({ time: '2026-11-12T18:30:26Z', asks: [], bids: [['165.93', '1'], ['165.95', '1']] }), null);
  assert.equal(parseOndoBook({ time: '2026-11-12T18:30:26Z', asks: [['1e3', '1']], bids: [] }), null);
  assert.equal(parseOndoBook({ time: 'never', asks: [], bids: [] }), null);
  assert.equal(parseOndoBook({ time: '2026-11-12T18:30:26Z', asks: [['1', '0']], bids: [] }), null);
});

test('BBO latency samples complete market frames once, keeps clock lead, and restarts intervals on reconnect', async () => {
  const markets = ['NVDA-USD.P', 'TSLA-USD.P'];
  let wallOffset = 0;
  const latency = createOndoLatency({ markets, mode: 'observe', startedAt: EPOCH, now: () => s.now() + wallOffset, monotonicNow: () => s.now() - EPOCH });
  const s = fixture({ markets, latency });
  s.stream.start();
  const first = s.sockets[0]; first.emit('open');
  const batch = s.depth(), row = batch.data[0];
  batch.data.push({ ...row, time: new Date(EPOCH + 13).toISOString() }, { ...row, market: markets[1] });
  first.frame(batch);
  let [a, b] = latency.snapshot().markets;
  assert.deepEqual([a.bboAge.n, a.bboAge.lastMs, a.clockAheadN, a.bookInterval.lastMs], [1, -13, 1, null]);
  assert.deepEqual([b.bboAge.n, b.bboAge.lastMs, b.clockAheadN], [1, 0, 0]);
  await s.advance(50); first.frame(s.depth({ asks: [] }));
  await s.advance(70); wallOffset = -100;
  first.frame(s.depth({ time: new Date(EPOCH).toISOString() }));
  [a, b] = latency.snapshot().markets;
  assert.deepEqual([a.bboAge.lastMs, a.bboAge.lastAt, a.bookInterval.lastMs], [20, EPOCH + 20, 120]);
  assert.deepEqual([b.bboAge.n, b.bookInterval.n], [1, 0]);
  first.close(); await s.advance(1000);
  const next = s.sockets[1]; next.emit('open');
  first.frame(s.depth()); next.frame(s.depth());
  assert.equal(latency.snapshot().markets[0].bookInterval.n, 1);
  s.stream.close();
});

test('only an unambiguous pong from the same socket measures RTT; the existing ping schedule is preserved', async () => {
  const latency = createOndoLatency({ markets: ['NVDA-USD.P'], mode: 'observe', startedAt: EPOCH, now: () => s.now(), monotonicNow: () => s.now() - EPOCH });
  const s = fixture({ latency }); s.stream.start();
  const first = s.sockets[0]; first.emit('open');
  const pong = socket => socket.frame({ type: 'pong' });
  pong(first); await s.advance(5000); await s.advance(83); pong(first); pong(first);
  assert.deepEqual([latency.snapshot().wsRtt.lastMs, latency.snapshot().wsRtt.n], [83, 1]);
  await s.advance(9917); // Both the 10 s and 15 s pings are outstanding. Neither reply can be attributed.
  pong(first); pong(first);
  assert.equal(latency.snapshot().wsRtt.n, 1);
  await s.advance(5000); await s.advance(12); pong(first);
  assert.deepEqual([latency.snapshot().wsRtt.lastMs, latency.snapshot().wsRtt.n], [12, 2]);
  await s.advance(4988); first.close(); await s.advance(1000);
  const second = s.sockets[1]; second.emit('open'); pong(first); pong(second);
  assert.equal(latency.snapshot().wsRtt.n, 2);
  await s.advance(5000); pong(second);
  assert.deepEqual([latency.snapshot().wsRtt.lastMs, latency.snapshot().wsRtt.n], [0, 3]);
  assert.equal(first.sent.filter(value => value.op === 'ping').length, 5);
  s.stream.close();
});

test('a broken latency observer cannot invalidate a book or interrupt the account heartbeat', async () => {
  const broken = () => { throw new Error('observer'); };
  const s = fixture({ credentials: keys, latency: { stamp: () => ({ wall: EPOCH, mono: 0 }), book: broken, elapsed: broken, down: broken } });
  s.stream.start(); const socket = s.sockets[0]; socket.emit('open'); socket.frame({ type: 'loggedIn' });
  for (const item of socket.sent.filter(it => it.op === 'subscribe')) socket.frame({ type: 'subscribed', channel: item.channel });
  socket.frame(s.depth()); await s.advance(5000); socket.frame({ type: 'pong' });
  assert.equal(s.books.length, 1); assert.equal(s.stream.status().deadManReady, true); assert.deepEqual(s.downs, []);
  s.stream.close();
});

test('a public stream subscribes to depth only and passes each snapshot on', async () => {
  const s = fixture(); s.stream.start();
  const socket = s.sockets[0];
  assert.equal(socket.url, 'wss://api.ondoperps.xyz/ws');
  socket.emit('open');
  assert.deepEqual(socket.sent, [{ op: 'subscribe', channel: 'depthBooksPerps', markets: ['NVDA-USD.P'], limit: 50 }]);
  socket.frame({ type: 'subscribed', channel: 'depthBooksPerps' });
  assert.deepEqual(s.stream.status(), { connected: true, publicReady: true, privateReady: false, deadManReady: false, lastFrameAt: EPOCH, error: null });
  socket.frame(s.depth());
  socket.frame(s.depth({ market: 'TSLA-USD.P' }));
  socket.frame(s.depth({ bids: [['200.04', '1']] }));
  assert.equal(s.books.length, 2);
  assert.equal(f(s.books[0].book.bids[0][0]), '200'); assert.equal(s.books[1].book, null);
  socket.frame({ type: 'update', channel: 'ordersPerps', data: [{ market: 'NVDA-USD.P' }] });
  assert.equal(s.hints.length, 0);
  s.stream.close();
  assert.equal(socket.closed, true); assert.deepEqual(s.downs, []);
});

test('an observation stream requires both public subscriptions and requests no historical prints', async () => {
  const trades = [];
  const s = fixture({ onTrade: (market, trade, at) => trades.push({ market, trade, at }) });
  s.stream.start();
  const socket = s.sockets[0]; socket.emit('open');
  assert.deepEqual(socket.sent[1], { op: 'subscribe', channel: 'tradesPerps', markets: ['NVDA-USD.P'], numPastTrades: 0 });
  const row = { market: 'NVDA-USD.P', price: '199.93', aggressor_side: 'sell', id: 'trade1', time: new Date(EPOCH).toISOString() };
  const frame = rows => socket.frame({ type: 'update', channel: 'tradesPerps', data: rows });
  socket.frame({ type: 'subscribed', channel: 'depthBooksPerps' });
  frame([row]);
  assert.equal(s.stream.status().publicReady, false); assert.equal(trades.length, 0);
  socket.frame({ type: 'subscribed', channel: 'tradesPerps' });
  frame([{ ...row, market: 'TSLA-USD.P' }, row]);
  assert.equal(s.stream.status().publicReady, true);
  assert.deepEqual(trades, [{ market: 'NVDA-USD.P', trade: { id: 'trade1', time: EPOCH, aggressorSide: 'sell', price: 199_930_000_000_000_000_000n }, at: EPOCH }]);
  frame([{ ...row, aggressor_side: 'unknown' }]);
  assert.deepEqual(s.downs, ['invalid_data']); assert.equal(s.stream.status().publicReady, false);
  await s.advance(1000); s.sockets[1].emit('open');
  s.sockets[1].frame({ type: 'subscribed', channel: 'depthBooksPerps' });
  await s.advance(8000);
  assert.equal(s.downs.at(-1), 'public_timeout');
  s.stream.close();
});

test('with credentials the private channels follow a signed login', async () => {
  const s = fixture({ credentials: keys }); s.stream.start();
  const socket = s.sockets[0];
  socket.emit('open');
  assert.deepEqual(socket.sent[1], { op: 'login', args: { key: keys.keyId, time: String(EPOCH), sign: createHmac('sha256', keys.secret).update(`${EPOCH}ondo_perps_ws_login`).digest('hex') } });
  socket.frame({ type: 'subscribed', channel: 'depthBooksPerps' });
  socket.frame({ type: 'update', channel: 'fillsPerps', data: [{ market: 'NVDA-USD.P' }] });
  assert.equal(s.hints.length, 0);
  assert.equal(s.stream.status().privateReady, false);
  socket.frame({ type: 'loggedIn' });
  assert.deepEqual(socket.sent.slice(2), [...['ordersPerps', 'fillsPerps', 'positionsPerps'].map(channel => ({ op: 'subscribe', channel })),
    { op: 'subscribe', channel: 'cancelAllOrdersAfterPerps', timeout_seconds: 30 }]);
  for (const channel of ['ordersPerps', 'fillsPerps', 'positionsPerps']) socket.frame({ type: 'subscribed', channel });
  assert.equal(s.stream.status().privateReady, true);
  assert.equal(s.stream.status().deadManReady, false);
  socket.frame({ type: 'subscribed', channel: 'cancelAllOrdersAfterPerps' });
  assert.equal(s.stream.status().deadManReady, true);
  socket.frame({ type: 'update', channel: 'fillsPerps', data: [{ market: 'NVDA-USD.P', size: '0.5' }] });
  assert.deepEqual(s.hints, [{ channel: 'fillsPerps', data: [{ market: 'NVDA-USD.P', size: '0.5' }] }]);
  s.stream.close();
});

test('the account-wide timer must expire across disconnect and be acknowledged on the new socket', async () => {
  const s = fixture({ credentials: keys }); s.stream.start();
  const first = s.sockets[0];
  first.emit('open'); first.frame({ type: 'loggedIn' });
  first.frame({ type: 'subscribed', channel: 'cancelAllOrdersAfterPerps' });
  for (const channel of ['ordersPerps', 'fillsPerps', 'positionsPerps']) first.frame({ type: 'subscribed', channel });
  // Inbound market data can still arrive while our heartbeat round trip is broken.
  await s.advance(9000); first.frame(s.depth());
  await s.advance(6000);
  assert.equal(s.downs.at(-1), 'heartbeat_timeout'); assert.equal(s.stream.status().deadManReady, false);
  await s.advance(30_000); assert.equal(s.sockets.length, 1);
  await s.advance(1000);
  const second = s.sockets[1]; second.emit('open'); second.frame({ type: 'loggedIn' });
  first.frame({ type: 'subscribed', channel: 'cancelAllOrdersAfterPerps' });
  assert.equal(s.stream.status().deadManReady, false);
  assert.deepEqual(second.sent.at(-1), { op: 'subscribe', channel: 'cancelAllOrdersAfterPerps', timeout_seconds: 30 });
  second.frame({ type: 'subscribed', channel: 'cancelAllOrdersAfterPerps' });
  second.frame({ type: 'unsubscribed', channel: 'cancelAllOrdersAfterPerps' });
  assert.equal(s.downs.at(-1), 'protection_lost'); assert.equal(s.stream.status().deadManReady, false);
  s.stream.close();
});

test('authenticated heartbeat renews the switch until shutdown and leaves it armed when the client stops', async () => {
  const s = fixture({ credentials: keys }); s.stream.start();
  const socket = s.sockets[0]; socket.emit('open'); socket.frame({ type: 'loggedIn' });
  let venueDeadline = 0;
  for (const message of socket.sent.filter(item => item.op === 'subscribe')) {
    socket.frame({ type: 'subscribed', channel: message.channel });
    if (message.channel === 'cancelAllOrdersAfterPerps') venueDeadline = s.now() + message.timeout_seconds * 1000;
  }
  for (let i = 0; i < 9; i++) {
    const before = socket.sent.length; await s.advance(5000);
    assert.ok(s.now() < venueDeadline);
    assert.deepEqual(socket.sent.slice(before), [{ op: 'ping' }]);
    socket.frame({ type: 'pong' }); venueDeadline = s.now() + 30_000;
  }
  const count = socket.sent.length;
  s.stream.close(); await s.advance(30_000);
  assert.equal(socket.sent.length, count); assert.equal(s.sockets.length, 1);
  assert.equal(s.now(), venueDeadline);
});

test('an unconfirmed REST withdrawal leaves the venue timer to expire until the account is reconciled', async () => {
  let clear = false;
  const s = fixture({ credentials: keys }); s.stream.start();
  const first = s.sockets[0]; first.emit('open'); first.frame({ type: 'loggedIn' });
  first.frame({ type: 'subscribed', channel: 'cancelAllOrdersAfterPerps' });
  const sent = first.sent.length;
  s.stream.expireOrders(() => clear);
  assert.equal(first.closed, true); assert.equal(s.stream.status().deadManReady, false);
  await s.advance(40_000);
  assert.equal(s.sockets.length, 1); assert.equal(first.sent.length, sent);
  clear = true; await s.advance(1000);
  assert.equal(s.sockets.length, 2); assert.equal(s.stream.status().deadManReady, false);
  s.stream.close();
});

test('the venue switch is not armed if reconciliation expires during the login handshake', async () => {
  let accountFresh = true;
  const s = fixture({ credentials: keys, heartbeatAllowed: () => accountFresh }); s.stream.start();
  const first = s.sockets[0]; first.emit('open'); first.frame({ type: 'loggedIn' });
  s.stream.expireOrders(() => accountFresh);
  await s.advance(31_000);
  const second = s.sockets[1]; second.emit('open');
  accountFresh = false; second.frame({ type: 'loggedIn' });
  assert.ok(!second.sent.some(item => item.channel === 'cancelAllOrdersAfterPerps'));
  assert.equal(second.closed, true); assert.equal(s.stream.status().deadManReady, false);
  s.stream.close();
});

test('a silent, broken or closed connection is reported down and reopened with backoff', async () => {
  const s = fixture(); s.stream.start();
  s.sockets[0].emit('open'); s.sockets[0].frame({ type: 'subscribed', channel: 'depthBooksPerps' });
  await s.advance(5000);
  assert.deepEqual(s.sockets[0].sent.at(-1), { op: 'ping' });
  s.sockets[0].frame({ type: 'pong' });
  await s.advance(14_000);
  assert.deepEqual(s.downs, []);
  await s.advance(6000);
  assert.deepEqual(s.downs, ['silent']);
  assert.equal(s.stream.status().connected, false); assert.equal(s.sockets[0].closed, true);
  await s.advance(1000);
  assert.equal(s.sockets.length, 2);
  s.sockets[1].emit('open');
  s.sockets[1].frame('not json');
  assert.deepEqual(s.downs, ['silent', 'invalid_data']);
  await s.advance(1999);
  assert.equal(s.sockets.length, 2);
  await s.advance(1);
  assert.equal(s.sockets.length, 3);
  // A connection that never opens is dropped after the connect timeout.
  await s.advance(8000);
  assert.equal(s.downs.at(-1), 'connect_timeout');
  await s.advance(4000);
  assert.equal(s.sockets.length, 4);
  s.sockets[3].emit('open'); s.sockets[3].frame({ type: 'subscribed', channel: 'depthBooksPerps' });
  s.sockets[3].close();
  assert.equal(s.downs.at(-1), 'disconnected');
  // A confirmed subscription resets the backoff.
  await s.advance(1000);
  assert.equal(s.sockets.length, 5);
  s.stream.close();
  await s.advance(120_000);
  assert.equal(s.sockets.length, 5);
});

test('a refused login waits a minute and never exposes the venue text', async () => {
  const s = fixture({ credentials: keys }); s.stream.start();
  s.sockets[0].emit('open');
  s.sockets[0].frame({ type: 'error', msg: `bad key ${keys.keyId}` });
  assert.deepEqual(s.downs, ['login_refused']);
  assert.ok(!JSON.stringify(s.stream.status()).includes(keys.keyId));
  await s.advance(59_999);
  assert.equal(s.sockets.length, 1);
  await s.advance(1);
  assert.equal(s.sockets.length, 2);
  // A login that is never answered is dropped as well.
  s.sockets[1].emit('open');
  await s.advance(8000);
  assert.equal(s.downs.at(-1), 'login_timeout');
  s.stream.close();
});
