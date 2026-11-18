import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempDisposableSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVenueFeeds } from '../src/market/venue-feeds.ts';
import { unpackBook } from '../src/market/venue-protocol.ts';
import type { MarketClient, MarketOperations } from '../src/market/ipc.ts';
import { remoteCrossexReaders, remoteOndoClient, remoteOndoStream, remoteOndoTopStream } from '../src/service/remote-venue-feeds.ts';
import { createOndoModule } from '../src/service/ondo.ts';
import { ONDO_MM_DEFAULTS } from '../src/vendor/ondo/mm.mjs';
import { createOndoStream, createOndoTopStream, type OndoBook, type OndoStreamOptions, type OndoStreamStatus } from '../src/vendor/ondo/stream.mjs';
import { createOndoClient } from '../src/vendor/ondo/client.mjs';
import { createPublicClients } from '../src/vendor/crossex/clients.mjs';
import { createFundingClient } from '../src/vendor/crossex/funding-client.mjs';
import { createCandleReader } from '../src/vendor/crossex/candle-reader.mjs';

const symbol = 'NVDA-USD.P', controller = () => new AbortController();
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const identity = { exchange: 'binance', symbol: 'BTCUSDT', base: 'BTC', rawBase: 'BTC', quoteCurrency: 'USDT', counterCurrency: 'USDT',
  settlementCurrency: 'USDT', collateralCurrency: 'USDT', crossexSymbol: 'BINANCE_FUTURE_BTC_USDT', contractKind: 'linear', multiplier: 1,
  identityVerified: true, identitySource: 'exchange-instrument-metadata', assetClass: 'crypto', identityScope: 'manual', nativeUnit: '1', comparable: true };
function connection(service: MarketOperations, observe?: (op: string, frame: Record<string, unknown>) => void) {
  let generation: string | null = 'one';
  const sent: { op: string; input: unknown }[] = [];
  const peer: MarketClient = {
    epoch: () => generation,
    async call<T>(op: string, input: unknown, signal = controller().signal) {
      sent.push({ op, input }); return JSON.parse(JSON.stringify(await service.call(op, input, signal))) as T;
    },
    stream(op, input, { data }) {
      sent.push({ op, input }); const local = controller();
      service.stream(op, input, frame => { const wire = JSON.parse(JSON.stringify(frame)); observe?.(op, wire); data(wire); }, local.signal);
      return () => local.abort();
    },
  };
  return { peer, sent, generation(value: string | null) { generation = value; } };
}

test('Ondo public observation and REST sampling cross JSON without credentials and preserve exact sizes and times', async t => {
  const now = Date.now(), prices = [202_000_000_000_000_123_456n, 123_456_789_012_345_678n] as [bigint, bigint];
  let upstream: OndoStreamOptions | undefined, closed = 0, books = 0, trades = 0;
  const raw = { market: symbol, time: new Date(now).toISOString(), bids: [['201', '3']], asks: [['203', '1']] };
  const feeds = createVenueFeeds({
    ondo: { close() {}, cooldownUntil: () => 0, async depth() { return raw; },
      async markets() { return new Map([[symbol, { tick: '0.01', step: '0.1', trading: true, makerFee: '-0.0002' }]]); } },
    ondoStream: options => {
      upstream = options;
      return { start() { options.onPublicReady!(now); }, status: () => ({ connected: true, publicReady: true, privateReady: false, lastFrameAt: now, error: null }), close() { closed++; } };
    },
  });
  t.after(() => feeds.close?.());
  const { peer, sent } = connection(feeds);
  const api = remoteOndoClient(peer); t.after(() => api.close());
  assert.equal((await api.markets()).get(symbol)?.tick, '0.01');
  assert.deepEqual(await api.depth(symbol), raw);
  const arrivals: { wall: number; mono: number }[] = [], rtt: number[] = [];
  const stream = remoteOndoStream(peer, { markets: [symbol], now: () => now,
    latency: { stamp: () => ({ wall: now + 10, mono: 500 }), down() {},
      book(_name, _sourceAt, received) { arrivals.push(received); },
      elapsed(_name, metric, start, end) { if (metric === 'wsRtt' && start && end) rtt.push(end.mono - start.mono); } },
    onBook(name, book, at) { assert.equal(name, symbol); assert.deepEqual(book?.bids[0], prices); assert.equal(book.time, now - 1); assert.equal(at, now); books++; },
    onTrade(name, trade, at) { assert.equal(name, symbol); assert.equal(trade.price, prices[0]); assert.equal(trade.time, now); assert.equal(at, now); trades++; },
  });
  stream.start();
  assert.equal(upstream?.credentials, undefined);
  upstream!.onBook(symbol, { bids: [prices], asks: [[prices[0] + 10n, 99n]], time: now - 1 }, now);
  upstream!.onTrade!(symbol, { price: prices[0], time: now, id: '1234', aggressorSide: 'buy' }, now);
  upstream!.latency!.book(symbol, now - 1, { wall: now, mono: 60 });
  upstream!.latency!.book(symbol, now - 1, { wall: now, mono: 72 });
  upstream!.latency!.elapsed(null, 'wsRtt', { wall: now - 7, mono: 53 }, { wall: now, mono: 60 });
  assert.deepEqual(arrivals, [{ wall: now, mono: 500 }, { wall: now, mono: 512 }]); assert.deepEqual(rtt, [7]);
  assert.equal(books, 1); assert.equal(trades, 1);
  assert.deepEqual(sent, [{ op: 'ondo.markets', input: {} }, { op: 'ondo.depth', input: { market: symbol, levels: 100 } },
    { op: 'ondo.public', input: { markets: [symbol], depth: 50, trades: true, metrics: true } }]);
  stream.close(); assert.equal(closed, 1);
  upstream!.onBook(symbol, { bids: [prices], asks: [], time: now }, now); assert.equal(books, 1);
});

test('the installed Ondo module opens public depth and top at market, and only the protected account socket at execution', async t => {
  class Socket extends EventEmitter {
    sent: { op: string; channel?: string; markets?: string[] }[] = [];
    closed = false;
    addEventListener(name: string, fn: (...args: unknown[]) => void) { this.on(name, fn); }
    send(text: string) { this.sent.push(JSON.parse(text)); }
    frame(value: unknown) { this.emit('message', { data: JSON.stringify(value) }); }
    close() { if (!this.closed) { this.closed = true; this.emit('close'); } }
  }
  const publicSockets: Socket[] = [], accountSockets: Socket[] = [];
  class Public extends Socket { constructor() { super(); publicSockets.push(this); } }
  class Account extends Socket { constructor() { super(); accountSockets.push(this); } }
  const feeds = createVenueFeeds({
    ondo: { close() {}, cooldownUntil: () => 0, async depth() { throw new Error('unexpected depth read'); },
      async markets() { return new Map([[symbol, { tick: '0.01', step: '0.1', trading: true, makerFee: null }]]); } },
    ondoStream: feed => createOndoStream({ ...feed, WebSocketImpl: Public }),
    ondoTopStream: feed => createOndoTopStream({ ...feed, WebSocketImpl: Public }),
  });
  const wireTops: unknown[] = [], dir = mkdtempDisposableSync(join(tmpdir(), 'tp-ondo-venue-'));
  const { peer, sent } = connection(feeds, (op, frame) => { if (op === 'ondo.top' && frame.type === 'top') wireTops.push(frame.book); });
  const key = { keyId: 'ondo-key-fixture-only', secret: 'ondo-secret-fixture-only' };
  const service = await createOndoModule({}, key, dir.path, { marketClient: peer, WebSocketImpl: Account, mmIntervalMs: 0,
    log() {}, locks: async () => ({ release() {} }), fetchImpl: async (url, init) => {
      assert.match(new URL(String(url)).pathname, /^\/v1\/perps\/(orders|positions)$/);
      assert.equal(init?.method, 'GET'); assert.equal(new Headers(init.headers).get('ONDO-KEY-ID'), key.keyId);
      return Response.json({ success: true, result: [] });
    } });
  t.after(async () => { try { await service.close(); } finally { feeds.close?.(); dir.remove(); } });
  const { revision } = service.views.save({ config: { ...ONDO_MM_DEFAULTS, mode: 'live', markets: [symbol], rps: 10 } }) as { revision: number };
  await service.views.start({ revision, confirmLive: true, confirmAccountWide: true });
  const state = () => service.views.state() as { stream: OndoStreamStatus; markets: { bid: string | null }[]; incident: { market: string } | null };
  assert.equal(publicSockets.length, 2); assert.equal(accountSockets.length, 1);
  for (const socket of [...publicSockets, ...accountSockets]) socket.emit('open');
  const [depth, top] = publicSockets;
  assert.deepEqual(depth.sent, [{ op: 'subscribe', channel: 'depthBooksPerps', markets: [symbol], limit: 50 }]);
  assert.deepEqual(top.sent, [{ op: 'subscribe', channel: 'topOfBooksPerps', markets: [symbol] }]);
  assert.deepEqual(sent.find(request => request.op === 'ondo.top'), { op: 'ondo.top', input: { markets: [symbol] } });
  const [account] = accountSockets;
  assert.deepEqual(account.sent.map(row => row.op), ['login']); account.frame({ type: 'loggedIn' });
  const channels = account.sent.slice(1).map(row => row.channel);
  assert.deepEqual(channels, ['ordersPerps', 'fillsPerps', 'positionsPerps', 'cancelAllOrdersAfterPerps']);
  for (const channel of channels) account.frame({ type: 'subscribed', channel });
  for (const socket of publicSockets) socket.frame({ type: 'subscribed', channel: socket.sent[0].channel });
  const row = { market: symbol, time: new Date().toISOString(), bids: [['199', '3']], asks: [['201', '2']] };
  top.frame({ type: 'update', channel: 'topOfBooksPerps', data: [
    { ...row, bids: [...row.bids, ['198', '2']], asks: [...row.asks, ['202', '3']] }, { ...row, bids: [], asks: [] }] });
  assert.deepEqual(wireTops, [{ time: Date.parse(row.time), bids: [['199000000000000000000', '3000000000000000000']],
    asks: [['201000000000000000000', '2000000000000000000']] }, { time: Date.parse(row.time), bids: [], asks: [] }]);
  assert.equal(state().markets[0].bid, null);
  top.close(); depth.frame({ type: 'update', channel: 'depthBooksPerps', data: [row] });
  assert.equal(state().stream.publicReady, true); assert.equal(state().markets[0].bid, '199');
  depth.close(); assert.equal(state().stream.publicReady, false); assert.equal(state().markets[0].bid, null);
  assert.equal(state().stream.deadManReady, true);
  account.frame({ type: 'update', channel: 'fillsPerps', data: [{ market: symbol, direction: 'openLong' }] });
  assert.equal(state().incident?.market, symbol); assert.equal(account.closed, false);
});

test('remote Ondo tops require fresh monotonic snapshots on the confirmed generation and the current IPC epoch', () => {
  let now = 1_800_000_000_000, epoch: string | null = 'first';
  let feed!: Parameters<MarketClient['stream']>[2], stops = 0;
  const peer: MarketClient = { epoch: () => epoch, async call() { throw new Error('unexpected call'); },
    stream(op, args, listener) { assert.equal(op, 'ondo.top'); assert.deepEqual(args, { markets: [symbol] }); feed = listener; return () => { stops++; }; } };
  const received: { book: OndoBook | null; at: number }[] = [], states: boolean[] = [];
  const stream = remoteOndoTopStream(peer, { markets: [symbol], now: () => now, onState: state => states.push(state),
    onTop(name, book, at) { assert.equal(name, symbol); received.push({ book, at }); } });
  stream.start();
  const first = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', second = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', third = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const ready = (generation: string, at = now) => feed.data({ type: 'ready', generation, at });
  const top = (generation: string, time = now, at = now) => ({ type: 'top', generation, market: symbol, at,
    book: { time, bids: [['201000000000000000123', '1000000000000000001']], asks: [] as string[][] } });
  feed.data(top(first)); ready('invalid'); ready(first, now + 1); assert.equal(stream.status().ready, false);
  const started = now; ready(first); now += 50;
  const valid = top(first, now - 1), source = valid.book.time;
  for (const msg of [{ ...valid, market: 'TSLA-USD.P' }, { ...valid, type: 'bbo' }, { ...valid, generation: second },
    { ...valid, at: started - 1 }, { ...valid, at: now + 1 }, top(first, now + 1501), top(first, now - 1501),
    { ...valid, book: null }, { ...valid, book: { time: now, bids: [] } }, { ...valid, book: { ...valid.book, bids: [['-1', '3']] } },
    { ...valid, book: { ...valid.book, asks: [['1', '5']] } }, { ...valid, book: { ...valid.book, bids: [...valid.book.bids, ['100', '3']] } }]) feed.data(msg);
  assert.equal(received.length, 0);
  feed.data(valid); feed.data(valid); feed.data(top(first, source - 1)); feed.data(top(first, source + 1, now - 1));
  assert.deepEqual(received, [{ book: { time: source, bids: [[201000000000000000123n, 1000000000000000001n]], asks: [] }, at: now }]);
  feed.data({ type: 'down', generation: first }); ready(first, started); feed.data(top(first));
  assert.equal(stream.status().ready, false); assert.deepEqual(states, []);
  ready(second, ++now); feed.data(top(first)); feed.data(top(second, source));
  assert.equal(received.length, 1);
  feed.data(top(second)); feed.data({ type: 'steady', generation: first }); feed.data({ type: 'steady', generation: second });
  assert.equal(received.length, 2); assert.deepEqual(states, [true]);
  epoch = null; assert.equal(stream.status().ready, false); feed.data(top(second, ++now)); feed.down();
  epoch = 'second'; ready(second); feed.data(top(second)); ready(third, ++now); ready(first, started); feed.data(top(second));
  assert.deepEqual(states, [true, false]); assert.equal(received.length, 2);
  now += 2000;
  feed.data(top(third, now - 1000, now - 1501)); feed.data(top(third, now - 1501, now - 1000)); feed.data(top(third, now + 1, now - 1500));
  assert.equal(received.length, 2);
  const empty = { time: now, bids: [], asks: [] };
  feed.data({ ...top(third), book: empty }); assert.equal(received.length, 3); assert.deepEqual(received.at(-1), { at: now, book: empty });
  stream.close(); stream.close(); feed.data(top(third, ++now));
  assert.equal(stops, 1); assert.equal(stream.status().ready, false); assert.equal(received.length, 3);
});

test('public operations reject unknown fields, mixed identities, invalid intervals and unbounded history before a reader runs', async t => {
  const calls: string[] = [], read = async () => { calls.push('read'); return []; };
  const feeds = createVenueFeeds({ depth: { loadDepth: read, loadManualDepth: read }, candles: read,
    funding: { read, current: read }, resolveLighter: async () => ({ symbol: 'BTC', marketId: 2 }) });
  t.after(() => feeds.close?.()); const signal = controller().signal;
  const comparable = { ...identity, identityScope: 'comparable' };
  const lighter = { ...identity, exchange: 'lighter', symbol: 'BTC', quoteCurrency: 'USDC', counterCurrency: 'USDC',
    collateralCurrency: 'USDC', settlementCurrency: 'USDC', crossexSymbol: 'LIGHTER_FUTURE_BTC_USDC', marketId: 1 };
  const to = Date.now();
  for (const [op, input] of [
    ['ondo.depth', { market: symbol, levels: 101 }], ['ondo.markets', { credentials: { secret: 'invalid' } }],
    ['crossex.candles', { quote: identity, interval: '2s' }], ['crossex.candles', { quote: lighter, interval: '1h' }],
    ['crossex.manualDepth', { quote: { ...identity, crossexSymbol: 'BYBIT_FUTURE_BTC_USDT' } }],
    ['crossex.manualDepth', { quote: { ...identity, apiKey: 'invalid' } }],
    ['crossex.fundingHistory', { quote: comparable, from: to + 1, to }],
    ['crossex.fundingHistory', { quote: comparable, from: to - 367 * 86400000, to }],
    ['crossex.fundingHistory', { quote: comparable, from: to - 60000, to, cursor: 'unbounded' }],
    ['crossex.orders', { url: 'https://invalid.example' }],
  ] as const) await assert.rejects(feeds.call(op, input, signal));
  assert.throws(() => feeds.stream('ondo.public', { markets: [symbol], depth: 10, trades: true, credentials: {} }, () => {}, signal));
  for (const input of [{ markets: [symbol], credentials: {} }, { markets: [symbol], depth: 1 }, { markets: [symbol, symbol] },
    { markets: [] }, { markets: ['ordersPerps'] }, { markets: Array.from({ length: 41 }, (_, i) => `M${i}-USD.P`) }]) {
    assert.throws(() => feeds.stream('ondo.top', input, () => {}, signal));
  }
  assert.throws(() => feeds.stream('crossex.terminal', { symbol: identity.crossexSymbol, channel: 'orders' }, () => {}, signal));
  for (const invalidPrice of [1, '01', '0x10', '1e9', '0', '-1', '1'.repeat(79)]) {
    assert.throws(() => unpackBook({ time: to, bids: [[invalidPrice, '1']], asks: [] }, 5));
  }
  assert.deepEqual(calls, []);
  await feeds.call('crossex.fundingHistory', { quote: comparable, from: to - 60000, to }, signal);
  assert.equal(calls.length, 1);
});

test('CrossEx binds the exact native identity and source timestamp to each confirmation generation', async t => {
  let at = Date.now() - 200, returned = identity.symbol;
  const read = async () => ({ exchange: 'binance', base: 'BTC', quoteCurrency: 'USDT', symbol: returned, at, bids: [[100, 5]], asks: [[101, 5]] });
  const feeds = createVenueFeeds({ depth: { loadDepth: read, loadManualDepth: read } }); t.after(() => feeds.close?.());
  const link = connection(feeds), remote = remoteCrossexReaders(link.peer);
  t.after(() => remote.terminalOptions.publicFeed.close());
  const depth = remote.marketOptions.manualDepthReader;
  const first = await depth({ ...identity, privateApiKey: 'excluded' });
  assert.deepEqual(link.sent[0].input, { quote: identity }); assert.equal(first.at, at); assert.equal(first.isCurrent(), true);
  link.generation(null); assert.equal(first.isCurrent(), false); link.generation('two'); assert.equal(first.isCurrent(), false);
  await assert.rejects(depth(identity), /来源时间/);
  at++; returned = 'ETHUSDT'; await assert.rejects(depth(identity), /身份/);
  returned = identity.symbol; const fresh = await depth(identity); assert.equal(fresh.isCurrent(), true);
  at -= 60_000; await assert.rejects(depth(identity), /过期/);
});

test('a cancelled Ondo IPC request leaves the rate queue immediately and an active request aborts its HTTP read', async t => {
  const entered = deferred<AbortSignal>(), calls: string[] = [];
  const ondo = createOndoClient({ rps: 1, fetchImpl: async (url, init) => {
    calls.push(String(url)); const signal = init!.signal!; entered.resolve(signal);
    return new Promise<Response>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const feeds = createVenueFeeds({ ondo }); t.after(() => feeds.close?.());
  const api = remoteOndoClient(connection(feeds).peer); t.after(() => api.close());
  const first = controller(), queued = controller();
  const active = api.depth(symbol, 50, first.signal), http = await entered.promise;
  const second = api.markets(queued.signal); queued.abort();
  await assert.rejects(second); assert.equal(http.aborted, false);
  const reason = new Error('caller canceled depth');
  first.abort(reason);
  assert.equal(http.reason, reason);
  await assert.rejects(active);
  assert.equal(calls.length, 1);
});

test('cancelled CrossEx readers preserve shared metadata until the remaining depth reader finishes', async t => {
  const entered = deferred<AbortSignal>(), release = deferred<void>();
  let catalogs = 0, depths = 0;
  const clients = createPublicClients({ fetcher: async (url, init) => {
    if (url.includes('exchangeInfo')) {
      catalogs++; entered.resolve(init!.signal!); await release.promise; init!.signal!.throwIfAborted();
      return Response.json({ symbols: [{ baseAsset: 'BTC', quoteAsset: 'USDT', marginAsset: 'USDT', symbol: 'BTCUSDT',
        underlyingType: 'COIN', underlyingSubType: [], contractType: 'PERPETUAL', status: 'TRADING' }] });
    }
    depths++; return Response.json({ bids: [['100', '2']], asks: [['101', '2']], T: Date.now() });
  } });
  const feeds = createVenueFeeds({ depth: clients }); t.after(() => feeds.close?.());
  const first = controller(), remaining = controller();
  const a = feeds.call('crossex.manualDepth', { quote: identity }, first.signal);
  const b = feeds.call('crossex.manualDepth', { quote: identity }, remaining.signal);
  const upstream = await entered.promise; first.abort();
  await assert.rejects(a); assert.equal(upstream.aborted, false);
  release.resolve(); const book = await b as { symbol: string };
  assert.equal(book.symbol, identity.symbol); assert.equal(catalogs, 1); assert.equal(depths, 1);
});

test('funding history aborts its native requests only after both callers cancel; private-free candles and temporary WS stop immediately', async t => {
  const entered = deferred<void>(), requests: AbortSignal[] = [];
  const fetcher = async (_url: string, init?: RequestInit): Promise<Response> => {
    const signal = init!.signal!; requests.push(signal); if (requests.length === 3) entered.resolve();
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  };
  const opened = deferred<void>(); let terminated = 0;
  class Socket extends EventEmitter {
    constructor() { super(); queueMicrotask(() => this.emit('open')); }
    send() { opened.resolve(); }
    terminate() { terminated++; }
  }
  const candleStarted = deferred<AbortSignal>();
  const candles = createCandleReader({ fetcher: async (_url, init) => {
    const signal = init!.signal!; candleStarted.resolve(signal);
    return new Promise<Response>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const feeds = createVenueFeeds({ funding: createFundingClient({ fetcher, WebSocketImpl: Socket }), candles,
    resolveLighter: async () => ({ symbol: 'BTC', marketId: 1 }) }); t.after(() => feeds.close?.());
  const end = Date.now(), query = { quote: { ...identity, identityScope: 'comparable' }, from: end - 60_000, to: end };
  const a = controller(), b = controller();
  const first = feeds.call('crossex.fundingHistory', query, a.signal), second = feeds.call('crossex.fundingHistory', query, b.signal);
  await entered.promise; a.abort(); await assert.rejects(first); assert.ok(requests.every(s => !s.aborted));
  b.abort(); await assert.rejects(second); assert.ok(requests.every(s => s.aborted));
  const c = controller(), history = feeds.call('crossex.candles', { quote: identity, interval: '5m' }, c.signal);
  const candleSignal = await candleStarted.promise; c.abort(); await assert.rejects(history); assert.equal(candleSignal.aborted, true);
  const lighter = { ...identity, exchange: 'lighter', symbol: 'BTC', quoteCurrency: 'USDC', counterCurrency: 'USDC',
    collateralCurrency: 'USDC', settlementCurrency: 'USDC', crossexSymbol: 'LIGHTER_FUTURE_BTC_USDC', marketId: 1 };
  const d = controller(), current = feeds.call('crossex.currentFunding', { quote: lighter }, d.signal);
  await opened.promise; d.abort(); await assert.rejects(current); assert.equal(terminated, 1);
});
