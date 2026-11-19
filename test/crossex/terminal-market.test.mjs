// Ported from project-aggregation 工作台 modules/crossex/tests/terminal-market.test.mjs (commit 7745181). Changes: import paths only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempDisposableSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCrossexStore } from '../../src/crossex/store.ts';
import { createCandleReader, createTerminalMarket, normalizeCandles, INTERVALS } from '../../src/vendor/crossex/terminal-market.mjs';
import { AppError, contractIdentity } from '../../src/vendor/crossex/model.mjs';
import { acceptTerminalRead, lastTerminalObservation, marketReadPath, pauseTerminalRead, readTerminalChart, rememberTerminalObservation, terminalObservation, visibleTerminalCandles } from '../../web/src/crossex/terminal-candles.ts';

const NOW = Date.UTC(2026, 9, 8, 8), SYMBOL = 'BINANCE_FUTURE_BTC_USDT';
const bar = (time = NOW, changes = {}) => ({ time, open: '100', high: '103', low: '99', close: '102', volume: '0.125', ...changes });
const json = value => new Response(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function quote(exchange, base = 'BTC') {
  const currency = ['deribit', 'lighter'].includes(exchange) ? 'USDC' : exchange === 'kraken' ? 'USD' : 'USDT';
  return { exchange, base, quoteCurrency: currency, symbol: { binance: `${base}USDT`, bybit: `${base}USDT`, okx: `${base}-USDT-SWAP`, gate: `${base}_USDT`, kraken: `PF_${base === 'BTC' ? 'XBT' : base}USD`, hyperliquid: base, lighter: base, deribit: `${base}_USDC-PERPETUAL` }[exchange], ...(exchange === 'lighter' ? { marketId: 7 } : {}) };
}
const book = (q, at = NOW) => ({ exchange: q.exchange, symbol: q.symbol, base: q.base, quoteCurrency: q.quoteCurrency, at, bids: [[100, 2], [99, 3]], asks: [[101, 4], [102, 5]] });
function rawCandles(exchange, q, at = NOW) {
  const array = [String(at), '100', '103', '99', '102', '0.125', '12.5'];
  return {
    binance: [[at, ...array.slice(1)]], bybit: { retCode: 0, result: { category: 'linear', symbol: q.symbol, list: [array] } },
    okx: { code: '0', data: [[String(at), '100', '103', '99', '102', '125', '0.125', '12.5', '1']] },
    gate: [{ t: at / 1000, o: '100', h: '103', l: '99', c: '102', v: 1250 }],
    kraken: { candles: [{ time: at, open: 100, high: 103, low: 99, close: 102, volume: 0.125 }] },
    hyperliquid: [{ t: at, s: q.symbol, i: '1m', o: '100', h: '103', l: '99', c: '102', v: '0.125' }],
    lighter: { code: 200, c: [{ t: at, o: 100, h: 103, l: 99, c: 102, v: 0.125 }] },
    deribit: { jsonrpc: '2.0', result: { status: 'ok', ticks: [at], open: [100], high: [103], low: [99], close: [102], volume: [0.125] } },
  }[exchange];
}
function terminalFixture(options = {}) {
  let now = NOW;
  const calls = { resolve: [], depth: [], candles: [] };
  class Socket extends EventEmitter {
    static instances = [];
    constructor(url, socketOptions) { super(); this.url = url; this.options = socketOptions; this.readyState = 1; this.sent = []; this.closed = 0; this.pings = 0; this.constructor.instances.push(this); queueMicrotask(() => this.emit('open')); }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { if (this.readyState === 3) return; this.closed++; this.readyState = 3; this.emit('close'); }
    terminate() { this.terminated = true; this.close(); }
    ping() { this.pings++; }
  }
  const service = createTerminalMarket({
    store: options.store,
    market: { resolveDisplaySymbol: async symbol => { if (options.display) return options.display(symbol); return { quote: quote(symbol.split('_')[0].toLowerCase(), symbol.split('_')[2]), rule: {} }; }, resolveSymbol: async symbol => { calls.resolve.push(symbol); if (options.resolve) return options.resolve(symbol); const q = quote(symbol.split('_')[0].toLowerCase(), symbol.split('_')[2]); return { quote: { ...q, nativeUnit: '0.01' }, rule: { contract_size: null } }; } },
    depthReader: async q => { calls.depth.push(q); return options.depth ? options.depth(q, now) : book(q, now); },
    candleReader: async (q, interval, signal, range) => { calls.candles.push({ q, interval, range }); return options.candles ? options.candles(q, interval, now, range, signal) : [bar(Math.floor(now / INTERVALS[interval]) * INTERVALS[interval])]; },
    WebSocketImpl: Socket, clock: () => now, ...(options.publicFeed ? { publicFeed: options.publicFeed } : {}),
  });
  return { service, calls, Socket, advance(ms) { now += ms; }, setNow(value) { now = value; }, now: () => now };
}
const frame = (socket, channel, result, event = 'update') => socket.emit('message', Buffer.from(JSON.stringify({ channel, event, result })));

test('hedge legs read live books without restoring or scheduling any candles', async t => {
  const f = terminalFixture(); t.after(() => f.service.stop());
  const symbols = [SYMBOL, 'BYBIT_FUTURE_BTC_USDT'];
  for (const symbol of symbols) {
    const query = new URL(marketReadPath(symbol, '5m', 'none'), 'http://localhost').searchParams;
    const result = await f.service.read(query.get('symbol'), query.get('interval'), Object.fromEntries(query));
    assert.equal(result.status, 'live'); assert.equal(result.book.at, NOW); assert.equal(result.ticker.askPrice, '101');
    assert.deepEqual(result.candles, []); assert.equal(result.candleBlocks, undefined);
  }
  assert.equal(f.calls.candles.length, 0); assert.equal(f.calls.depth.length, 2);
});

test('terminal block negotiation reuses verified history, sends a repaired gap and never promotes an expired live candle', async t => {
  const step = INTERVALS['1m'], gap = NOW - 43 * step;
  let repair = false, unit = '1';
  const f = terminalFixture({
    resolve: async () => ({ rule: {}, quote: { ...quote('binance'), nativeUnit: unit } }),
    depth: (q, now) => ({ ...book(q, now), bids: [[now === NOW ? 99 : 100, 2]] }),
    candles: (_q, _interval, now, range) => Array.from({ length: Math.floor((range.to - range.from) / step) + 1 }, (_, i) => bar(range.from + i * step, { close: now === NOW ? '100' : '101' })).filter(c => repair || c.time !== gap),
  });
  t.after(() => f.service.stop());
  const read = async previous => {
    const query = new URL(marketReadPath(SYMBOL, '1m', 'blocks', previous), 'http://localhost').searchParams;
    return f.service.read(SYMBOL, '1m', Object.fromEntries(query));
  };
  const full = await f.service.read(SYMBOL, '1m'), cold = await read();
  const initial = readTerminalChart(cold); assert.equal(initial.saved.blocks.flatMap(b => b.rows).length, 238);
  assert.deepEqual(visibleTerminalCandles(initial.chart, '1m', NOW), full.candles);
  assert.deepEqual(visibleTerminalCandles(initial.chart, '1m', NOW, false), full.candles.filter(c => c.closed));
  assert.ok(initial.saved.blocks.every(b => b.rows.every(c => c.closed)));
  f.advance(2000);
  const warm = await read(initial.saved), next = readTerminalChart(warm, initial.saved);
  assert.equal(next.saved, initial.saved); assert.ok(warm.candleBlocks.blocks.every(b => !b.rows));
  assert.equal(warm.book.bids[0][0], '100'); assert.equal(warm.book.at, NOW + 2000); assert.equal(warm.candles.length, 1);
  assert.equal(visibleTerminalCandles(next.chart, '1m', NOW + step).at(-1).time, NOW - step);
  repair = true; f.advance(5 * step);
  await read(initial.saved); await new Promise(setImmediate);
  const fixed = await read(initial.saved), merged = readTerminalChart(fixed, initial.saved);
  const transferred = fixed.candleBlocks.blocks.flatMap(b => b.rows ?? []);
  assert.ok(transferred.some(c => c.time === gap)); assert.ok(transferred.length < 25);
  assert.deepEqual(visibleTerminalCandles(merged.chart, '1m', NOW + 5 * step), (await f.service.read(SYMBOL, '1m')).candles);
  unit = '0.01'; f.advance(31_000);
  const other = await read(merged.saved);
  assert.notEqual(other.candleIdentity, fixed.candleIdentity); assert.ok(other.candleBlocks.blocks.every(b => b.rows && !b.base));
  assert.deepEqual(readTerminalChart({ ...other, candleIdentity: null, candleBlocks: null }, merged.saved).chart.closed, []);
  assert.ok((await read()).candleBlocks.blocks.every(b => b.rows), 'an empty browser cache receives the full replacement');
});

test('native archives survive an offline v0.70.0 upgrade and remain readable after rollback with a versioned Gate listing', async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'tp-terminal-upgrade-'));
  const store = openCrossexStore(dir.path, { secret: { apiKey: 'test-key', apiSecret: 'test-secret' }, limits: {} });
  const step = INTERVALS['1m'], native = { ...quote('binance'), nativeUnit: '0.01' };
  const legacyKey = contractIdentity(native), legacyRow = bar(NOW - step);
  let listing = 'version-1', online = false;
  const rule = { contract_size: '0.01', list_time: '1746000000' };
  const f = terminalFixture({ store,
    display: () => ({ quote: native, rule, candleListing: listing }),
    resolve: () => ({ quote: native, rule }),
    candles: () => { if (!online) throw Error('offline'); return [bar(NOW, { close: '101' })]; },
  });
  try {
    store.prepare('INSERT INTO terminal_candles VALUES (?,?,?,?,?)').run(legacyKey, '1m', legacyRow.time, NOW, JSON.stringify(legacyRow));
    const old = await f.service.read(SYMBOL, '1m', { candles: 'blocks' });
    assert.deepEqual(readTerminalChart(old).chart.closed, [{ ...legacyRow, closed: true }]);
    listing = 'version-2';
    const relisted = await f.service.read(SYMBOL, '1m', { candles: 'blocks', identity: old.candleIdentity, known: '' });
    assert.notEqual(relisted.candleIdentity, old.candleIdentity);
    assert.deepEqual(readTerminalChart(relisted).chart.closed, [{ ...legacyRow, closed: true }]);
    online = true; f.advance(step);
    await f.service.read(SYMBOL, '1m'); await new Promise(setImmediate);
    const legacyRows = store.prepare('SELECT json FROM terminal_candles WHERE identity=? AND interval=? AND opened_at<? ORDER BY opened_at DESC LIMIT 240')
      .all(legacyKey, '1m', NOW + step).map(row => JSON.parse(row.json));
    assert.deepEqual(legacyRows, [bar(NOW, { close: '101' }), legacyRow]);
  } finally { await f.service.stop(); store.close(); }
});

test('a resumed terminal waits for a new observation of an identical open candle, even when an HTTP snapshot succeeds', async t => {
  let online = true;
  const f = terminalFixture({
    candles: () => { if (!online) throw Error('offline'); return [bar(NOW - 60000), bar(NOW)]; },
    depth: (q, now) => { if (!online) throw Error('offline'); return book(q, now); },
  });
  t.after(() => f.service.stop());
  const read = async previous => {
    const data = await f.service.read(SYMBOL, '1m', { candles: 'blocks' });
    return acceptTerminalRead(previous, { scope: '1m', listingScope: SYMBOL, data, chart: readTerminalChart(data).chart });
  };
  const first = await read(null); assert.equal(first.data.candlePartialAsOf, NOW);
  rememberTerminalObservation(first.scope, terminalObservation(first.data, first.chart));
  f.advance(2000);
  const continuous = await read(first); assert.deepEqual(continuous.chart.partial, first.chart.partial);
  const onMount = lastTerminalObservation(first.scope, continuous.data.candleIdentity);
  assert.equal(acceptTerminalRead(null, continuous, onMount).chart.partial, undefined);
  const paused = pauseTerminalRead(continuous); assert.equal(paused.chart.partial, undefined);
  const retained = await read(paused); assert.equal(retained.data.status, 'live'); assert.equal(retained.chart.partial, undefined);
  online = false; f.advance(14000);
  await read(retained); await new Promise(setImmediate);
  const unavailable = await read(retained); assert.equal(unavailable.data.status, 'stale'); assert.equal(unavailable.data.candleAsOf, NOW);
  assert.equal(unavailable.data.candlePartialAsOf, null); assert.equal(unavailable.chart.partial, undefined);
  assert.deepEqual(unavailable.chart.closed, first.chart.closed);
  online = true; f.advance(15000); await read(unavailable); await new Promise(setImmediate);
  const recovered = await read(unavailable); assert.equal(recovered.data.candlePartialAsOf, f.now());
  assert.deepEqual(recovered.chart.partial, first.chart.partial);
  assert.deepEqual(acceptTerminalRead(null, recovered, onMount).chart.partial, recovered.chart.partial);
});

test('a Lighter market ID change fences queued stream callbacks and waits for the new native or subscribed book', async t => {
  const symbol = 'LIGHTER_FUTURE_BTC_USDC';
  for (const depthWorks of [false, true]) {
    const listeners = [];
    let id = 7;
    const f = terminalFixture({
      publicFeed: { subscribe(_s, listener) { listeners.push(listener); return () => {}; }, close() {} },
      display: () => ({ quote: quote('lighter'), rule: {}, candleListing: 'unchanged' }),
      resolve: () => ({ quote: { ...quote('lighter'), marketId: id }, rule: {} }),
      depth: (q, now) => { if (q.marketId === 8 && !depthWorks) throw Error('new depth unavailable');
        const bid = q.marketId === 8 ? 20 : 100; return { ...book(q, now), bids: [[bid, 1]], asks: [[bid + 1, 1]] }; },
    });
    t.after(() => f.service.stop());
    const read = () => f.service.read(symbol, '1m', { candles: 'none' });
    const push = (to, channel, fields, at = f.now()) => to.data({ event: 'update', channel, time_ms: at, result: { s: symbol, ts: at, ...fields } });
    const initial = await read(); f.advance(29000);
    const old = listeners[0], rawBook = { b: [['100', '2']], a: [['101', '2']] };
    push(old, 'order_book_5', rawBook); push(old, 'ticker', { bp: '100', ap: '101', lp: '100.5' });
    push(old, 'trade', { i: 'old-print', p: '100', q: '2', S: 'BUY' }); push(old, 'mark_price', { mp: '101' });
    push(old, 'funding_rate', { r: '0.01', T: NOW + 90000 });
    assert.equal((await read()).trades.length, 1);
    f.advance(2100); id = 8;
    const changed = await read(); assert.notEqual(changed.candleIdentity, initial.candleIdentity);
    assert.deepEqual(f.calls.depth.map(q => q.marketId), [7, 8]);
    assert.equal(changed.tradingAvailable, depthWorks); assert.equal(changed.ticker.bidPrice, depthWorks ? '20' : null);
    assert.equal(changed.ticker.lastPrice, null); assert.equal(changed.ticker.markPrice, null); assert.equal(changed.ticker.fundingRate, null);
    assert.deepEqual(changed.trades, []); assert.equal(listeners.length, 2);
    const active = listeners[1]; f.advance(1100);
    push(old, 'order_book_5', rawBook); push(old, 'ticker', { bp: '100', ap: '101', lp: '100.5' }); old.down();
    push(active, 'order_book_5', rawBook, NOW + 29000);
    assert.equal((await read()).ticker.bidPrice, depthWorks ? '20' : null);
    push(active, 'ticker', { bp: '21', ap: '22', lp: '21.5' });
    assert.equal((await read()).tradingAvailable, depthWorks);
    push(active, 'order_book_5', { b: [['21', '2']], a: [['22', '2']] });
    const recovered = await read(); assert.equal(recovered.book.bids[0][0], '21'); assert.equal(recovered.tradingAvailable, true);
  }
});

test('an initial Lighter resolve cannot authorize the unverified socket book received before the native market was known', async t => {
  const pending = deferred(), listeners = [], symbol = 'LIGHTER_FUTURE_BTC_USDC';
  let marketId = 7, available = false;
  const f = terminalFixture({
    publicFeed: { subscribe(_s, listener) { listeners.push(listener); return () => {}; }, close() {} },
    display: () => ({ quote: quote('lighter'), rule: {}, candleListing: 'stable' }),
    resolve: async () => { await pending.promise; return { quote: { ...quote('lighter'), marketId }, rule: {}, candleListing: 'stable' }; },
    depth: (q, at) => { if (!available) throw Error('new depth unavailable'); return { ...book(q, at), bids: [[20, 1]], asks: [[21, 1]] }; },
  });
  t.after(async () => { pending.resolve(); await f.service.stop(); });
  const read = () => f.service.read(symbol, '1m', { candles: 'none' });
  const push = listener => listener.data({ event: 'update', channel: 'order_book_5', result: { s: symbol, ts: f.now(), b: [['100', '2']], a: [['101', '2']] } });
  assert.equal((await read()).tradingAvailable, false);
  const provisional = listeners[0]; push(provisional);
  const display = await read(); assert.equal(display.book.bids[0][0], '100'); assert.equal(display.tradingAvailable, false);
  f.advance(50); marketId = 8; pending.resolve(); await new Promise(setImmediate);
  push(provisional); push(listeners[1]);
  const verified = await read(); assert.ok(verified.candleIdentity); assert.equal(verified.tradingAvailable, false); assert.equal(verified.book, null);
  assert.deepEqual(f.calls.depth.map(q => q.marketId), [8]);
  available = true; f.advance(1500);
  const fresh = await read(); assert.equal(fresh.tradingAvailable, true); assert.equal(fresh.book.bids[0][0], '20');
});

test('a late native lookup for a retired directory cannot arm its old book or subscription', async t => {
  let listing = 'a'; const pending = deferred(), seen = [];
  const f = terminalFixture({
    publicFeed: { subscribe(s, cb) { seen.push(cb); return () => {}; }, close() {} },
    display: () => ({ quote: quote('lighter'), rule: {}, candleListing: listing }),
    resolve: async () => { const before = listing; if (before === 'a') await pending.promise;
      return { quote: { ...quote('lighter'), marketId: before === 'a' ? 7 : 8 }, rule: {}, candleListing: before }; },
  });
  t.after(async () => { pending.resolve(); await f.service.stop(); });
  const read = () => f.service.read('LIGHTER_FUTURE_BTC_USDC', '1m', { candles: 'none' });
  assert.equal((await read()).tradingAvailable, false);
  listing = 'b'; const active = await read();
  pending.resolve(); await new Promise(setImmediate);
  seen[0].down(); const final = await read();
  assert.equal(final.candleIdentity, active.candleIdentity); assert.equal(final.status, 'live');
  assert.deepEqual(f.calls.depth.map(q => q.marketId), [8]); assert.equal(seen.length, 2);
});

test('all eight candle adapters preserve native timestamps and base volumes without private requests', async () => {
  for (const exchange of ['binance', 'bybit', 'okx', 'gate', 'kraken', 'hyperliquid', 'lighter', 'deribit']) {
    const q = quote(exchange), calls = [];
    const reader = createCandleReader({ clock: () => NOW, fetcher: async (url, init) => {
      calls.push({ url, init }); const parsed = new URL(url);
      assert.equal(parsed.protocol, 'https:'); assert.equal(init.redirect, 'error'); assert.ok(init.signal);
      assert.ok(!/private|accounts|orders|positions|transfers/.test(parsed.pathname));
      for (const key of Object.keys(init.headers || {})) assert.ok(!/authorization|^key$|sign|secret/i.test(key));
      if (exchange === 'hyperliquid') {
        assert.equal(url, 'https://api.hyperliquid.xyz/info'); assert.equal(init.method, 'POST');
        assert.deepEqual(JSON.parse(init.body), { type: 'candleSnapshot', req: { coin: 'BTC', interval: '1m', startTime: NOW - 240 * 60000, endTime: NOW } });
      } else { assert.equal(init.method, 'GET'); assert.equal(init.body, undefined); }
      return json(parsed.pathname.includes('/contracts/') ? { name: q.symbol, quanto_multiplier: '0.0001' } : rawCandles(exchange, q));
    } });
    assert.deepEqual(await reader(q, '1m'), [bar()], exchange);
    assert.equal(calls.length, exchange === 'gate' ? 2 : 1, exchange);
    if (exchange === 'lighter') assert.equal(new URL(calls[0].url).searchParams.get('market_id'), '7');
    if (exchange === 'kraken') assert.ok(calls[0].url.includes('/PF_XBTUSD/1m?'));
    if (exchange === 'deribit') assert.equal(new URL(calls[0].url).searchParams.get('instrument_name'), 'BTC_USDC-PERPETUAL');
  }
});

test('incremental native candle requests bound all eight venues to the requested opening times', async () => {
  const from = NOW - 5 * 60000, to = from + 2 * 60000 - 1;
  for (const exchange of ['binance', 'bybit', 'okx', 'gate', 'kraken', 'hyperliquid', 'lighter', 'deribit']) {
    const q = quote(exchange), requests = [];
    const read = createCandleReader({ clock: () => NOW, fetcher: async (url, init) => {
      if (url.includes('/contracts/')) return json({ name: q.symbol, quanto_multiplier: '0.0001' });
      const params = Object.fromEntries(new URL(url).searchParams);
      requests.push(exchange === 'hyperliquid' ? JSON.parse(init.body).req : params);
      return json(rawCandles(exchange, q, from));
    } });
    assert.deepEqual(await read(q, '1m', undefined, { from, to }), [bar(from)], exchange);
    const actual = requests[0];
    const expected = { binance: { startTime: from, endTime: to, limit: 2 }, bybit: { start: from, end: to, limit: 2 },
      okx: { before: from - 1, after: to + 1, limit: 2 }, gate: { from: from / 1000, to: Math.floor(to / 1000) },
      kraken: { from: from / 1000, to: Math.floor(to / 1000), count: 2 }, hyperliquid: { startTime: from, endTime: to },
      lighter: { start_timestamp: from, end_timestamp: to + 1, count_back: 2 }, deribit: { start_timestamp: from, end_timestamp: to } }[exchange];
    for (const [key, value] of Object.entries(expected)) assert.equal(Number(actual[key]), value, exchange);
    if (exchange === 'gate') assert.equal(actual.limit, undefined);
  }
  const changed = createCandleReader({ clock: () => NOW, fetcher: async url => json(url.includes('/contracts/')
    ? { name: 'BTC_USDT', quanto_multiplier: '0.001' } : rawCandles('gate', quote('gate'), from)) });
  await assert.rejects(changed({ ...quote('gate'), nativeUnit: '0.01' }, '1m', undefined, { from, to }));
});

test('terminal reopens stored closes, repairs only a gap and the tail, and keeps the open bar in memory', async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'tp-terminal-history-'));
  const open = () => openCrossexStore(dir.path, { secret: { apiKey: 'test-key', apiSecret: 'test-secret' }, limits: {} });
  const step = INTERVALS['1m'], gap = NOW - 62 * step, first = NOW - 239 * step;
  const rows = Array.from({ length: 240 }, (_, i) => bar(first + i * step));
  let store = open(), terminal = terminalFixture({ store, candles: () => rows.filter(c => c.time !== gap) });
  try {
    const view = await terminal.service.read(SYMBOL, '1m');
    assert.equal(view.candles.length, 239);
    assert.equal(view.candles.at(-1).closed, false); assert.equal(view.candles.at(-2).closed, true);
    assert.equal(store.prepare('SELECT COUNT(*) n FROM terminal_candles').get().n, 238);
    await terminal.service.stop(); store.close(); store = open();
    const gate = deferred();
    let nativeUnit = '0.01', reject = false;
    terminal = terminalFixture({ store, resolve: async () => ({ quote: { ...quote('binance'), nativeUnit }, rule: {} }),
      candles: async (_q, _i, _now, range) => {
        await gate.promise;
        if (reject) throw Error('offline');
        return rows.filter(c => c.time >= range.from && c.time <= range.to).map(c => ({ ...c, close: '101' }));
      } });
    terminal.advance(10_000);
    const saved = await terminal.service.read(SYMBOL, '1m');
    assert.equal(saved.candleAsOf, NOW); assert.equal(saved.candles.length, 238);
    assert.equal(saved.candles.at(-1).time, NOW - step); assert.equal(saved.candles.at(-1).close, '102');
    assert.deepEqual(terminal.calls.candles.map(c => c.range), [{ from: NOW, to: NOW + 10_000 }]);
    gate.resolve(); await new Promise(setImmediate);
    const repaired = await terminal.service.read(SYMBOL, '1m');
    assert.deepEqual(terminal.calls.candles[1].range, { from: gap, to: gap + step - 1 });
    assert.equal(repaired.candles.length, 240); assert.equal(repaired.candles.at(-1).close, '101');
    assert.equal(store.prepare('SELECT COUNT(*) n FROM terminal_candles WHERE opened_at=?').get(NOW).n, 0);
    assert.equal(repaired.candleAsOf, NOW + 10_000);
    reject = true; terminal.advance(60_000);
    await terminal.service.read(SYMBOL, '1m'); await new Promise(setImmediate);
    const failed = await terminal.service.read(SYMBOL, '1m');
    assert.ok(failed.candleError); assert.equal(failed.candleAsOf, repaired.candleAsOf);
    assert.equal(failed.candles.at(-1).time, NOW - step); // prior live bar was never promoted
    nativeUnit = '1'; terminal.advance(31_000);
    const other = await terminal.service.read(SYMBOL, '1m');
    assert.equal(other.candles.length, 0); assert.equal(other.candleAsOf, null);
    assert.equal(other.tradingAvailable, true);
  } finally { await terminal.service.stop(); store.close(); }
});

test('terminal retains verified closes and source time if SQLite rejects a correction', async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'tp-terminal-rollback-'));
  const store = openCrossexStore(dir.path, { secret: { apiKey: 'test-key', apiSecret: 'test-secret' }, limits: {} });
  let close = '102';
  const f = terminalFixture({ store, candles: () => [bar(NOW - 60000, { close }), bar(NOW, { close })] });
  try {
    const original = await f.service.read(SYMBOL, '1m');
    assert.equal(original.candleAsOf, NOW);
    store.db.exec("CREATE TRIGGER candle_unwritable BEFORE INSERT ON terminal_candles BEGIN SELECT RAISE(ABORT,'disk'); END");
    close = '100'; f.advance(60_000);
    await f.service.read(SYMBOL, '1m'); await new Promise(setImmediate);
    const failed = await f.service.read(SYMBOL, '1m');
    assert.ok(failed.candleError); assert.equal(failed.candleAsOf, NOW);
    assert.deepEqual(failed.candles, original.candles.filter(c => c.closed));
    assert.equal(JSON.parse(store.prepare('SELECT json FROM terminal_candles').get().json).close, '102');
  } finally { await f.service.stop(); store.close(); }
});

test('a later observation repairing an older candle protects the archive across a clock rollback and restart', async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'tp-terminal-clock-'));
  const open = () => openCrossexStore(dir.path, { secret: { apiKey: 'test-key', apiSecret: 'test-secret' }, limits: {} });
  const step = INTERVALS['1m'], gap = NOW - 5 * step, repairedAt = NOW + 5 * step + 1;
  const rows = Array.from({ length: 240 }, (_, i) => bar(NOW - (239 - i) * step));
  const candles = (_q, _i, now, range) => {
    if (now === NOW) return rows.filter(c => c.time !== gap);
    if (now === repairedAt && range.to === now) throw Error('tail offline');
    return [gap, Math.floor(now / step) * step].filter(t => t >= range.from && t <= range.to).map(t => bar(t, { close: '101' }));
  };
  let store = open(), f = terminalFixture({ store, candles });
  try {
    await f.service.read(SYMBOL, '1m');
    f.setNow(repairedAt);
    await f.service.read(SYMBOL, '1m'); await new Promise(setImmediate);
    const repaired = await f.service.read(SYMBOL, '1m');
    assert.equal(repaired.candleAsOf, NOW); assert.equal(repaired.candles.find(c => c.time === gap).close, '101');
    assert.equal(store.prepare('SELECT observed_at FROM terminal_candles WHERE opened_at=?').get(gap).observed_at, repairedAt);
    const requests = f.calls.candles.length; f.setNow(NOW + 20_000);
    const rolledBack = await f.service.read(SYMBOL, '1m');
    assert.match(rolledBack.candleError, /本机时间/); assert.equal(rolledBack.candleAsOf, NOW);
    assert.equal(f.calls.candles.length, requests); assert.ok(rolledBack.candles.every(c => c.closed));
    await f.service.stop(); store.close(); store = open(); f = terminalFixture({ store, candles });
    f.setNow(NOW + 25_000);
    const restored = await f.service.read(SYMBOL, '1m');
    assert.equal(f.calls.candles.length, 0); assert.match(restored.candleError, /本机时间/);
    assert.deepEqual(restored.candles, rolledBack.candles); assert.equal(restored.candleAsOf, NOW);
    f.setNow(repairedAt + step); await f.service.read(SYMBOL, '1m'); await new Promise(setImmediate);
    assert.equal((await f.service.read(SYMBOL, '1m')).candleAsOf, repairedAt + step);
  } finally { await f.service.stop(); store.close(); }
});

test('after a five-minute clock rollback and restart all 239 stored closes reappear before the venue answers', async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'tp-terminal-clock-catch-up-'));
  const open = () => openCrossexStore(dir.path, { secret: { apiKey: 'test-key', apiSecret: 'test-secret' }, limits: {} });
  const step = INTERVALS['1m'], rows = Array.from({ length: 240 }, (_, i) => bar(NOW - (239 - i) * step));
  const expected = rows.slice(0, -1).map(c => ({ ...c, closed: true }));
  let store = open(), f = terminalFixture({ store, candles: () => rows }), hold;
  try {
    await f.service.read(SYMBOL, '1m');
    assert.equal(store.prepare('SELECT count(*) n FROM terminal_candles').get().n, 239);
    for (const mode of ['current only', 'empty', 'offline']) {
      await f.service.stop(); store.close(); store = open(); hold = deferred();
      f = terminalFixture({ store, candles: async () => {
        await hold.promise;
        if (mode === 'offline') throw Error('unavailable');
        return mode === 'empty' ? [] : [bar(NOW)];
      } });
      f.setNow(NOW - 5 * step);
      const rolledBack = await f.service.read(SYMBOL, '1m');
      assert.deepEqual(rolledBack.candles, expected.slice(0, -5));
      assert.match(rolledBack.candleError, /本机时间/); assert.equal(f.calls.candles.length, 0);
      f.setNow(NOW - 3 * step);
      assert.deepEqual((await f.service.read(SYMBOL, '1m')).candles, expected.slice(0, -3));
      assert.equal(f.calls.candles.length, 0);
      f.setNow(NOW + 1000);
      const beforeResponse = await f.service.read(SYMBOL, '1m');
      assert.deepEqual(beforeResponse.candles, expected);
      assert.deepEqual(f.calls.candles.map(c => c.range), [{ from: NOW, to: NOW + 1000 }]);
      hold.resolve(); await new Promise(setImmediate);
      const recovered = await f.service.read(SYMBOL, '1m');
      assert.deepEqual(recovered.candles.filter(c => c.closed), expected, mode);
      assert.equal(recovered.candles.length, mode === 'current only' ? 240 : 239);
      assert.equal(recovered.candleAsOf, mode === 'current only' ? NOW + 1000 : NOW);
      assert.equal(!!recovered.candleError, mode === 'offline');
    }
  } finally { hold?.resolve(); await f.service.stop(); store.close(); }
});

test('restart respects the latest observation of this contract even when the repaired candle is outside the 240 displayed closes', async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'tp-terminal-archive-clock-'));
  const open = () => openCrossexStore(dir.path, { secret: { apiKey: 'test-key', apiSecret: 'test-secret' }, limits: {} });
  const step = INTERVALS['1m'], ancient = NOW - 500 * step, repairedAt = NOW + 8 * step;
  const rows = Array.from({ length: 240 }, (_, i) => bar(NOW - (239 - i) * step));
  let store = open(), f = terminalFixture({ store, candles: () => rows });
  try {
    await f.service.read(SYMBOL, '1m');
    const { identity } = store.prepare('SELECT identity FROM terminal_candles LIMIT 1').get();
    const insert = store.prepare('INSERT INTO terminal_candles VALUES (?,?,?,?,?)');
    insert.run(identity, '1m', NOW - 240 * step, NOW, JSON.stringify(bar(NOW - 240 * step)));
    insert.run(identity, '1m', ancient, repairedAt, JSON.stringify(bar(ancient)));
    await f.service.stop(); store.close(); store = open();
    f = terminalFixture({ store, candles: (_q, _i, now) => [bar(Math.floor(now / step) * step)] });
    f.setNow(NOW + step);
    const restored = await f.service.read(SYMBOL, '1m');
    assert.equal(restored.candles.length, 240); assert.ok(restored.candles.every(c => c.time > ancient));
    assert.equal(restored.candleAsOf, NOW); assert.match(restored.candleError, /本机时间/); assert.equal(f.calls.candles.length, 0);
    f.setNow(repairedAt); await f.service.read(SYMBOL, '1m'); await new Promise(setImmediate);
    assert.equal((await f.service.read(SYMBOL, '1m')).candleAsOf, repairedAt);
  } finally { await f.service.stop(); store.close(); }
});

test('the terminal publishes SQLite’s winning revision when a late candle loses the conditional upsert', async () => {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'tp-terminal-revision-'));
  const store = openCrossexStore(dir.path, { secret: { apiKey: 'test-key', apiSecret: 'test-secret' }, limits: {} });
  const step = INTERVALS['1m'], preceding = NOW - step, later = NOW + 2 * step, release = deferred();
  const f = terminalFixture({ store, candles: async (_q, _i, now, range) => {
    if (now === NOW) return Array.from({ length: 240 }, (_, i) => bar(NOW - (239 - i) * step));
    await release.promise;
    return [preceding, NOW, now].filter(t => t >= range.from).map(t => bar(t, { close: '100' }));
  } });
  try {
    await f.service.read(SYMBOL, '1m'); f.advance(step);
    await f.service.read(SYMBOL, '1m');
    assert.deepEqual(f.calls.candles.at(-1).range, { from: preceding, to: NOW + step });
    store.prepare('UPDATE terminal_candles SET observed_at=?, json=? WHERE opened_at=?')
      .run(later, JSON.stringify(bar(preceding, { close: '101' })), preceding);
    release.resolve(); await new Promise(setImmediate);
    const result = await f.service.read(SYMBOL, '1m');
    assert.match(result.candleError, /本机时间/); assert.equal(result.candleAsOf, later);
    assert.equal(result.candles.at(-1).close, '101');
    assert.equal(store.prepare('SELECT count(*) n FROM terminal_candles WHERE opened_at=?').get(NOW).n, 0);
  } finally { release.resolve(); await f.service.stop(); store.close(); }
});

test('native interval aliases and explicit no-data responses remain accurate', async () => {
  for (const [exchange, interval, name, expected] of [['bybit', '1d', 'interval', 'D'], ['okx', '1h', 'bar', '1H'], ['okx', '1d', 'bar', '1Dutc'], ['deribit', '4h', 'resolution', '60'], ['deribit', '1d', 'resolution', '1D']]) {
    const q = quote(exchange), at = Math.floor(NOW / INTERVALS[interval]) * INTERVALS[interval];
    const reader = createCandleReader({ clock: () => NOW, fetcher: async url => {
      assert.equal(new URL(url).searchParams.get(name), expected);
      return json(exchange === 'deribit' ? { result: { status: 'no_data' } } : rawCandles(exchange, q, at));
    } });
    assert.equal((await reader(q, interval)).length, exchange === 'deribit' ? 0 : 1);
  }
});

test('Deribit four-hour candles combine only complete or current contiguous source hours', async () => {
  const anchor = NOW - 2 * INTERVALS['4h'], hours = [0, 1, 2, 3, 4, 6, 8].map(i => bar(anchor + i * INTERVALS['1h'], { open: String(100 + i), high: String(104 + i), low: String(99 + i), close: String(102 + i), volume: '0.1' }));
  const result = { status: 'ok', ticks: hours.map(c => c.time), ...Object.fromEntries(['open', 'high', 'low', 'close', 'volume'].map(key => [key, hours.map(c => c[key])])) };
  const reader = createCandleReader({ clock: () => NOW, fetcher: async () => json({ result }) });
  const values = await reader(quote('deribit'), '4h');
  assert.deepEqual(values.map(c => c.time), [anchor, NOW]);
  assert.deepEqual(values[0], { time: anchor, open: '100', high: '107', low: '99', close: '105', volume: '0.4' });
  assert.equal(values[1].volume, '0.1');
});

test('candle validation rejects duplicates, future bars, invalid times, prices and missing volume', () => {
  for (const changes of [{ time: NOW + 60000 }, { time: NOW / 1000 }, { time: NOW + 1 }, { time: [NOW] }, { open: '0' }, { high: '101' }, { low: '103' }, { close: 'NaN' }, { volume: '-1' }, { volume: undefined }, { volume: {} }]) {
    assert.throws(() => normalizeCandles([bar(NOW, changes)], '1m', NOW), undefined, JSON.stringify(changes));
  }
  assert.throws(() => normalizeCandles([bar(), bar()], '1m', NOW));
  assert.throws(() => normalizeCandles({ data: [] }, '1m', NOW));
  assert.throws(() => normalizeCandles([bar()], 'bad', NOW));
});

test('candle normalization sorts real bars, preserves gaps and bounds history without seeding', () => {
  assert.deepEqual(normalizeCandles([], '1m', NOW), []);
  assert.deepEqual(normalizeCandles([bar(NOW), bar(NOW - 3 * 60000)], '1m', NOW).map(c => c.time), [NOW - 3 * 60000, NOW]);
  const many = Array.from({ length: 300 }, (_, i) => bar(NOW - (299 - i) * 60000));
  const normalized = normalizeCandles(many, '1m', NOW);
  assert.equal(normalized.length, 240); assert.equal(normalized[0].time, NOW - 239 * 60000);
});

test('native error envelopes and invalid multiplier cannot masquerade as usable candles', async () => {
  for (const [exchange, payload] of [['bybit', { retCode: 10001, result: { list: [] } }], ['okx', { code: '51000', data: [] }], ['deribit', { error: { code: 10000 }, result: { status: 'ok', ticks: [] } }], ['deribit', { result: { status: 'ok', ticks: [NOW], open: [] } }]]) {
    await assert.rejects(createCandleReader({ clock: () => NOW, fetcher: async () => json(payload) })(quote(exchange), '1m'));
  }
  for (const multiplier of ['0', '-1', undefined]) await assert.rejects(createCandleReader({ clock: () => NOW, fetcher: async url => json(url.includes('/contracts/') ? { name: 'BTC_USDT', quanto_multiplier: multiplier } : rawCandles('gate', quote('gate'))) })(quote('gate'), '1m'));
});

test('unavailable symbols return no sample book, ticker, trades or candles', async t => {
  const f = terminalFixture({ display: async () => { throw new AppError('合约不可用'); } }); t.after(() => f.service.stop());
  await assert.rejects(f.service.read(SYMBOL), /合约不可用/);
  assert.equal(f.calls.depth.length, 0); assert.equal(f.calls.candles.length, 0); assert.equal(f.Socket.instances.length, 0);
});

test('public ticker and trade frames validate identity, time and prices, with trade ID deduplication', async t => {
  const f = terminalFixture(); t.after(() => f.service.stop()); await f.service.read(SYMBOL);
  const socket = f.Socket.instances[0];
  const ticker = { s: SYMBOL, lp: '102', bp: '100', ap: '101', o: '100', ts: NOW };
  frame(socket, 'ticker', ticker); let value = await f.service.read(SYMBOL);
  assert.equal(value.ticker.lastPrice, '102'); assert.equal(value.ticker.change24h, '0.02'); assert.equal(value.ticker.volume24h, null);
  for (const change of [{ s: 'OKX_FUTURE_BTC_USDT' }, { ts: NOW - 1 }, { ts: NOW + 1001 }, { ts: [NOW] }, { bp: '102' }, { lp: '0' }, { ap: null }]) frame(socket, 'ticker', { ...ticker, lp: '999', ...change });
  frame(socket, 'ticker', { ...ticker, lp: '999' }, 'subscribe'); socket.emit('message', Buffer.from('bad-json'));
  const trade = { s: SYMBOL, i: 'trade-1', p: '100.5', q: '0.123456789012345678901', S: 'BUY', ts: NOW };
  frame(socket, 'trade', trade); frame(socket, 'trade', { ...trade, p: '900' });
  for (const change of [{ i: '' }, { i: 'x'.repeat(200) }, { i: 'array-time', ts: [NOW] }, { i: 'old', ts: NOW - 300000 }, { i: 'future', ts: NOW + 1001 }, { i: 'side', S: 'buy' }, { i: 'zero', q: '0' }, { i: 'bad-price', p: 'NaN' }]) frame(socket, 'trade', { ...trade, ...change });
  value = await f.service.read(SYMBOL);
  assert.equal(value.ticker.lastPrice, '102');
  assert.deepEqual(value.trades, [{ id: 'trade-1', price: '100.5', quantity: '0.123456789012345678901', side: 'BUY', at: NOW, quantityUnit: 'base' }]);
});

test('Gate and OKX WS trades convert only with confirmed native units, otherwise retain labeled contracts', async t => {
  for (const exchange of ['gate', 'okx']) for (const size of ['0.0001', undefined]) {
    const q = quote(exchange), symbol = `${exchange.toUpperCase()}_FUTURE_BTC_USDT`;
    const f = terminalFixture({ resolve: async () => ({ quote: { ...q, nativeUnit: size }, rule: { contract_size: null } }) }); t.after(() => f.service.stop());
    await f.service.read(symbol); frame(f.Socket.instances[0], 'trade', { s: symbol, i: 'native-1', p: '100', q: '1250', S: 'SELL', ts: NOW });
    const value = await f.service.read(symbol);
    assert.equal(value.trades.length, 1); assert.equal(value.trades[0].quantity, size ? '0.125' : '1250'); assert.equal(value.trades[0].quantityUnit, size ? 'base' : 'contracts');
  }
});

test('snapshot regressions and failed refreshes preserve the last book with an honest stale status', async t => {
  let at = NOW, fails = false;
  const f = terminalFixture({ depth: q => { if (fails) throw new AppError('上游不可用'); return book(q, at); } }); t.after(() => f.service.stop());
  assert.equal((await f.service.read(SYMBOL)).status, 'live'); f.advance(2000); at = NOW - 1;
  let value = await f.service.read(SYMBOL); assert.equal(value.status, 'stale'); assert.equal(value.asOf, NOW); assert.match(value.error, /回退/);
  f.advance(2000); at = f.now(); value = await f.service.read(SYMBOL); assert.equal(value.status, 'live'); assert.equal(value.asOf, at);
  f.advance(11000); fails = true; value = await f.service.read(SYMBOL);
  assert.equal(value.status, 'stale'); assert.equal(value.asOf, at); assert.equal(value.book.bids[0][0], '100');
});

test('simultaneous readers share depth and candle work while repeated polling does not resubscribe', async t => {
  const gate = deferred(), f = terminalFixture({ depth: async q => { await gate.promise; return book(q); } }); t.after(() => f.service.stop());
  const reads = [f.service.read(SYMBOL), f.service.read(SYMBOL), f.service.read(SYMBOL)];
  await new Promise(setImmediate); assert.equal(f.calls.depth.length, 1); gate.resolve();
  const values = await Promise.all(reads); assert.ok(values.every(value => value.status === 'live'));
  assert.equal(f.calls.resolve.length, 1); assert.equal(f.calls.candles.length, 1);
  for (let i = 0; i < 5; i++) { f.advance(2000); await f.service.read(SYMBOL); }
  assert.equal(f.Socket.instances.length, 1); assert.equal(f.Socket.instances[0].sent.filter(message => message.event === 'subscribe').length, 5);
  assert.equal(f.calls.candles.length, 1);
  await f.service.read(SYMBOL, '1m'); assert.equal(f.calls.candles.length, 2);
  assert.equal(f.Socket.instances[0].url, 'wss://api.gateio.ws/ws/crossex/public');
  assert.ok(f.Socket.instances[0].sent.every(message => ['ticker', 'trade', 'funding_rate', 'mark_price', 'order_book_5'].includes(message.channel)));
  assert.equal(f.Socket.instances[0].options.maxPayload, 1000000);
});

test('idle subscriptions are released and the empty public socket closes', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = terminalFixture(); t.after(() => f.service.stop()); await f.service.read(SYMBOL);
  const socket = f.Socket.instances[0]; f.advance(120001); t.mock.timers.tick(25000);
  assert.equal(socket.sent.filter(message => message.event === 'unsubscribe').length, 5); assert.equal(socket.closed, 1);
  await f.service.read(SYMBOL); assert.equal(f.Socket.instances.length, 2); assert.equal(f.calls.resolve.length, 2);
});

test('stream cache and trade history remain bounded without mixing symbols', async t => {
  const f = terminalFixture(); t.after(() => f.service.stop());
  for (let i = 0; i < 13; i++) { await f.service.read(`BINANCE_FUTURE_COIN${i}_USDT`); f.advance(1); }
  const socket = f.Socket.instances[0];
  assert.deepEqual(socket.sent.filter(message => message.event === 'unsubscribe').map(message => message.payload), Array(5).fill(['BINANCE_FUTURE_COIN0_USDT']));
  const symbol = 'BINANCE_FUTURE_COIN12_USDT';
  for (let i = 0; i < 70; i++) frame(socket, 'trade', { s: symbol, i: String(i), p: '100', q: '0.1', S: 'SELL', ts: f.now() - i });
  assert.equal((await f.service.read(symbol)).trades.length, 60);
  assert.deepEqual((await f.service.read('BINANCE_FUTURE_COIN11_USDT')).trades, []);
});

test('stop closes the socket and prevents a pending depth read from starting new candle work', async () => {
  const gate = deferred(), f = terminalFixture({ depth: async q => { await gate.promise; return book(q); } });
  const reading = f.service.read(SYMBOL); await new Promise(setImmediate);
  const stopping = f.service.stop(); gate.resolve(); await Promise.allSettled([reading, stopping]);
  assert.equal(f.Socket.instances[0].closed, 1); assert.equal(f.calls.candles.length, 0);
  await assert.rejects(f.service.read(SYMBOL), /停止/); await f.service.stop();
});

test('invalid symbols and intervals fail before resolving sources or starting a socket', async t => {
  const f = terminalFixture(); t.after(() => f.service.stop());
  for (const symbol of ['', null, '../accounts', 'BINANCE_SPOT_BTC_USDT', 'BINANCE_FUTURE_BTC_USDT?key=x', 'binance_FUTURE_BTC_USDT', 'UNKNOWN_FUTURE_BTC_USDT']) await assert.rejects(f.service.read(symbol));
  for (const interval of ['1s', '7w', '__proto__', '', null]) await assert.rejects(f.service.read(SYMBOL, interval));
  assert.equal(f.calls.resolve.length, 0); assert.equal(f.Socket.instances.length, 0);
  let network = 0;
  const candles = createCandleReader({ fetcher: async () => { network++; throw Error('unexpected'); } });
  await assert.rejects(candles(quote('binance'), '7w')); await assert.rejects(candles(quote('unknown'), '1m'));
  assert.equal(network, 0);
});

test('funding rates retain source time and never rejuvenate old, regressed or settled frames', async t => {
  const f = terminalFixture(); t.after(() => f.service.stop()); await f.service.read(SYMBOL);
  const socket = f.Socket.instances[0];
  const send = (at, settlement = NOW + 3600000, rate = '0.001') => socket.emit('message', Buffer.from(JSON.stringify({ channel: 'funding_rate', event: 'update', time_ms: at, result: { s: SYMBOL, r: rate, T: settlement } })));
  send(NOW - 86400000, NOW - 3600000); assert.equal((await f.service.read(SYMBOL)).ticker.fundingRate, null);
  send(NOW); assert.equal((await f.service.read(SYMBOL)).ticker.fundingRate, '0.001');
  for (const at of [NOW - 1, NOW + 1001, [NOW], undefined]) send(at, NOW + 3600000, '0.5');
  send(NOW, NOW - 1, '0.5'); assert.equal((await f.service.read(SYMBOL)).ticker.fundingRate, '0.001');
  f.advance(60001); assert.equal((await f.service.read(SYMBOL)).ticker.fundingRate, null);
});

test('Deribit retains 960 source hours until all 240 four-hour bars are aggregated', async () => {
  const ticks = Array.from({ length: 960 }, (_, i) => NOW - (960 - i) * INTERVALS['1h']);
  const reader = createCandleReader({ clock: () => NOW, fetcher: async () => json({ result: { status: 'ok', ticks, open: ticks.map(() => 100), high: ticks.map(() => 103), low: ticks.map(() => 99), close: ticks.map(() => 102), volume: ticks.map(() => 1) } }) });
  const values = await reader(quote('deribit'), '4h');
  assert.equal(values.length, 240); assert.equal(values[0].time, ticks[0]); assert.equal(values[0].volume, '4');
});

test('CrossEx books and mark prices remain usable when native identity and history are unavailable', async t => {
  const symbol = 'OKX_FUTURE_CL_USDC';
  const f = terminalFixture({ resolve: async () => { throw new AppError('原生合约不存在'); } }); t.after(() => f.service.stop());
  let value = await f.service.read(symbol);
  assert.equal(value.tradingAvailable, false);
  const socket = f.Socket.instances[0];
  frame(socket, 'order_book_5', { s: symbol, ts: NOW, b: [['72.1', '1250'], ['72', '100']], a: [['72.2', '300']] });
  socket.emit('message', Buffer.from(JSON.stringify({ channel: 'mark_price', event: 'update', time_ms: NOW, result: { s: symbol, mp: '72.15' } })));
  frame(socket, 'trade', { s: symbol, ts: NOW, p: '72.2', q: '10', S: 'BUY', i: 'cl-1' });
  value = await f.service.read(symbol);
  assert.equal(value.status, 'live'); assert.equal(value.error, null); assert.equal(value.ticker.bidPrice, '72.1'); assert.equal(value.ticker.markPrice, '72.15');
  assert.equal(value.book.quantityUnit, 'contracts'); assert.equal(value.book.bids[0][1], '1250');
  assert.equal(value.trades[0].quantityUnit, 'contracts'); assert.match(value.tradingReason, /原生合约不存在/);
  assert.equal(value.tradingAvailable, false); assert.deepEqual(value.candles, []); assert.equal(f.calls.depth.length, 0);
  f.advance(11000); value = await f.service.read(symbol);
  assert.equal(value.status, 'stale'); assert.equal(value.ticker.markPrice, null);
});

test('disconnect clears the terminal cache and a late message from the old socket cannot restore a live price', async t => {
  const f = terminalFixture({ resolve: async () => { throw new AppError('原生合约暂未确认'); } });
  t.after(() => f.service.stop()); await f.service.read(SYMBOL);
  const socket = f.Socket.instances[0];
  const tick = { s: SYMBOL, ts: NOW, bp: '100', ap: '101', lp: '100.5' };
  frame(socket, 'ticker', tick);
  assert.equal((await f.service.read(SYMBOL)).ticker.bidPrice, '100');
  socket.close(); frame(socket, 'ticker', { ...tick, bp: '99' });
  const after = await f.service.read(SYMBOL);
  assert.equal(after.ticker.bidPrice, null); assert.equal(after.status, 'unavailable'); assert.equal(after.asOf, null);
});

test('raw books are display-only until a freshly bound native market supplies its own book and prints', async t => {
  const symbol = 'GATE_FUTURE_ETH_USDT'; let available = false;
  const f = terminalFixture({ resolve: async () => { if (!available) throw new AppError('暂未确认单位'); return { quote: { ...quote('gate', 'ETH'), nativeUnit: '0.01' }, rule: {} }; } }); t.after(() => f.service.stop());
  await f.service.read(symbol); const socket = f.Socket.instances[0];
  frame(socket, 'order_book_5', { s: symbol, ts: NOW, b: [['3000', '0.75']], a: [['3001', '125']] });
  frame(socket, 'trade', { s: symbol, ts: NOW, p: '3000', q: '0.75', S: 'BUY', i: 'eth-1' });
  assert.equal((await f.service.read(symbol)).book.quantityUnit, 'contracts');
  available = true; f.advance(30001); frame(socket, 'order_book_5', { s: symbol, ts: f.now(), b: [['3000', '0.75']], a: [['3001', '125']] }); const value = await f.service.read(symbol);
  assert.equal(value.book.quantityUnit, 'base'); assert.equal(value.book.bids[0][0], '100'); assert.deepEqual(value.trades, []); assert.equal(value.tradingAvailable, true);
  assert.equal(f.calls.depth.length, 1);
  f.advance(1100); const confirmed = f.Socket.instances.at(-1);
  frame(confirmed, 'order_book_5', { s: symbol, ts: f.now(), b: [['2999', '0.75']], a: [['3000', '125']] });
  frame(confirmed, 'trade', { s: symbol, ts: f.now(), p: '2999', q: '0.75', S: 'BUY', i: 'new-print' });
  const fresh = await f.service.read(symbol);
  assert.equal(fresh.book.bids[0][1], '0.0075'); assert.equal(fresh.trades[0].quantity, '0.0075');
});

test('malformed, regressed and wrong-channel public books never replace a validated snapshot', async t => {
  const f = terminalFixture(); t.after(() => f.service.stop()); await f.service.read(SYMBOL); const socket = f.Socket.instances[0];
  const good = { s: SYMBOL, ts: NOW + 1, b: [['100', '1'], ['99', '2']], a: [['101', '1']] };
  frame(socket, 'order_book_5', good);
  for (const change of [{ ts: NOW }, { ts: [NOW] }, { ts: NOW + 1001 }, { b: [['102', '1']] }, { b: [['100', '0']] }, { b: [['100', '1'], ['100', '2']] }, { a: [] }, { b: Array(6).fill(['100', '1']) }]) frame(socket, 'order_book_5', { ...good, ...change });
  frame(socket, 'order_book_1', { ...good, b: [['98', '1']] });
  const value = await f.service.read(SYMBOL); assert.equal(value.book.at, NOW + 1); assert.deepEqual(value.book.bids, good.b);
});

test('slow native and candle requests do not hold the public terminal response open', async t => {
  const hold = deferred();
  const f = terminalFixture({ resolve: async () => { await hold.promise; throw new AppError('慢来源'); } });
  t.after(async () => { hold.resolve(); await f.service.stop(); });
  const start = performance.now(); await f.service.read(SYMBOL); assert.ok(performance.now() - start < 1000);
  assert.equal(f.Socket.instances.length, 1);
  frame(f.Socket.instances[0], 'ticker', { s: SYMBOL, ts: NOW, bp: '100', ap: '101', lp: '100.5', o: '100' });
  const value = await f.service.read(SYMBOL); assert.equal(value.status, 'live'); assert.equal(value.ticker.bidPrice, '100'); assert.equal(value.tradingAvailable, false);
  hold.resolve();
});

test('mark price uses its own time and Bybit subscribes only to supported depth', async t => {
  const f = terminalFixture(); t.after(() => f.service.stop()); const symbol = 'BYBIT_FUTURE_BTC_USDT'; await f.service.read(symbol);
  const socket = f.Socket.instances[0];
  assert.ok(socket.sent.some(m => m.channel === 'order_book_1')); assert.ok(!socket.sent.some(m => m.channel === 'order_book_5'));
  const send = (at, price) => socket.emit('message', Buffer.from(JSON.stringify({ channel: 'mark_price', event: 'update', time_ms: at, result: { s: symbol, mp: price } })));
  send(NOW, '101'); for (const at of [NOW - 1, NOW + 1001, [NOW], undefined]) send(at, '999');
  assert.equal((await f.service.read(symbol)).ticker.markPrice, '101');
  f.advance(11000); frame(socket, 'ticker', { s: symbol, ts: f.now(), bp: '100', ap: '101', lp: '100.5' });
  const value = await f.service.read(symbol); assert.equal(value.status, 'live'); assert.equal(value.ticker.markPrice, null);
});

test('concurrent catalog lookups retain the twelve-symbol subscription bound', async t => {
  const hold = deferred();
  const f = terminalFixture({ display: async symbol => { await hold.promise; return { quote: quote('binance', symbol.split('_')[2]), rule: {} }; } });
  t.after(async () => { hold.resolve(); await f.service.stop(); });
  const reads = Array.from({ length: 12 }, (_, i) => f.service.read(`BINANCE_FUTURE_COIN${i}_USDT`));
  const same = f.service.read('BINANCE_FUTURE_COIN0_USDT');
  await assert.rejects(f.service.read('BINANCE_FUTURE_EXTRA_USDT'), error => error.status === 429);
  hold.resolve(); await Promise.all([...reads, same]);
  const subscribed = new Set(f.Socket.instances[0].sent.filter(m => m.event === 'subscribe').flatMap(m => m.payload));
  assert.equal(subscribed.size, 12); assert.equal(f.calls.resolve.length, 12);
});

test('socket open never subscribes a symbol whose catalog identity is still pending', async t => {
  const hold = deferred();
  const f = terminalFixture({ display: async symbol => { if (symbol.includes('WAIT')) { await hold.promise; throw new AppError('目录不存在'); } return { quote: quote('binance'), rule: {} }; } });
  t.after(async () => { hold.resolve(); await f.service.stop(); });
  const rejected = assert.rejects(f.service.read('BINANCE_FUTURE_WAIT_USDT'), /目录不存在/);
  await f.service.read(SYMBOL);
  assert.ok(f.Socket.instances[0].sent.every(m => !m.payload.includes('BINANCE_FUTURE_WAIT_USDT')));
  hold.resolve(); await rejected;
});
