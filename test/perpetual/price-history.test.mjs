// Ported from project-aggregation 工作台 modules/monitor/tests/perpetual-price-history.test.mjs (commit c84ba27). Changes: import paths;
// the durable cache is this repo's perpetual-cache.sqlite (openPerpetualCache, same price_history_cache table); the case on the
// workbench's whole createPerpetualService and HTTP handler ("price action uses existing HTTP authentication") is left out,
// test/monitor-perpetual-price.test.ts covers this collector and route instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPerpetualPriceHistoryService } from '../../src/vendor/perpetual-price-history-service.mjs';
import { candleKnown, mergeCandleBlocks } from '../../src/candle-blocks.ts';
import { openPerpetualCache } from '../../src/monitor/perpetual-cache.ts';
import { validatePerpetualPriceHistory, priceHistoryIsStale, perpetualPriceIdentity, PRICE_BLOCK_MS } from '../../src/vendor/perpetual-price-history.ts';

const HOUR = 3_600_000, NOW = Date.UTC(2026, 9, 11, 12), quote = exchange => ({ exchange, symbol: 'BTCUSDT', base: 'BTC', quoteCurrency: 'USDT', multiplier: 1 });
const pair = { base: 'BTC', longKey: 'binance:BTCUSDT', shortKey: 'aster:BTCUSDT' };
const points = (range, close = 100) => Array.from({ length: (range.to - range.from) / HOUR }, (_, i) => ({ time: range.from + (i + 1) * HOUR, close }));
function setup(t, options = {}) {
  let now = NOW, calls = [];
  const quotes = [quote('binance'), quote('aster')], markets = new Map(quotes.map(row => [`${row.exchange}:${row.symbol}`, row]));
  const service = createPerpetualPriceHistoryService({ getSnapshot: () => ({ quotes }), getMarket: (exchange, symbol) => markets.get(`${exchange}:${symbol}`), clock: () => now, hostSpacingMs: 0, reader: async (market, range, control) => { calls.push({ market, range }); return options.reader ? options.reader(market, range, control) : points(range); }, ...options.service });
  service.start(); t.after(() => service.stop());
  return { service, quotes, markets, calls, advance: ms => { now += ms; }, read: (days = 7) => service.read({ pair, days }) };
}
async function finish(f) { for (let i = 0; i < 6; i++) { await f.service.collect(); await turn(); } }

test('selected pair caches full 30d; window/direction changes reuse it and refresh only new closed hours', async t => {
  const f = setup(t);
  assert.equal(f.read().legs[pair.longKey].status, 'pending'); assert.equal(f.calls.length, 0);
  await finish(f);
  const report = f.read(30), leg = report.legs[pair.longKey];
  assert.equal(leg.points.length, 720); assert.equal(leg.backfillComplete, true); assert.equal(leg.status, 'ready'); assert.ok(validatePerpetualPriceHistory(report, NOW));
  const count = f.calls.length;
  for (const days of [3, 7, 30]) { f.read(days); await f.service.collect(); }
  f.service.read({ pair: { ...pair, longKey: pair.shortKey, shortKey: pair.longKey }, days: 3 }); await f.service.collect();
  assert.equal(f.calls.length, count);
  f.advance(HOUR + 1000); f.read(); await f.service.collect();
  assert.equal(f.calls.length, count + 2); assert.equal(f.calls.at(-1).range.to - f.calls.at(-1).range.from, 2 * HOUR);
  assert.equal(f.read().legs[pair.longKey].points.length, 720);
});
test('gaps remain gaps; conflicting duplicates within one response retain old values and stale state', async t => {
  let fail = false;
  const f = setup(t, { reader: async (_market, range) => fail ? [...points(range, 101), { time: range.to, close: 102 }] : points(range).filter(row => row.time !== NOW - HOUR) });
  f.read(); await finish(f); const prior = f.read().legs[pair.longKey];
  assert.equal(prior.points.length, 719); fail = true; f.advance(HOUR + 1000); f.read(); await f.service.collect();
  const report = f.read(); assert.equal(report.legs[pair.longKey].status, 'error'); assert.deepEqual(report.legs[pair.longKey].points, prior.points); assert.equal(priceHistoryIsStale(report, NOW + HOUR), true);
});
test('a later official revision replaces the overlapping cached close and keeps adding new hours', async t => {
  let revised = false;
  const f = setup(t, { reader: async (_market, range) => points(range, revised ? 101 : 100) });
  f.read(); await finish(f); revised = true; f.advance(HOUR + 1000); f.read(); await f.service.collect();
  const updated = f.read().legs[pair.longKey];
  assert.equal(updated.status, 'ready'); assert.equal(updated.error, ''); assert.equal(updated.points.length, 720);
  assert.equal(updated.points.find(point => point.time === NOW - HOUR).close, 100, 'outside the refreshed range remains unchanged');
  assert.equal(updated.points.find(point => point.time === NOW).close, 101, 'the overlapping official close may be revised');
  assert.deepEqual(updated.points.at(-1), { time: NOW + HOUR, close: 101 });
  f.advance(HOUR); f.read(); await f.service.collect();
  const latest = f.read().legs[pair.longKey];
  assert.equal(latest.status, 'ready'); assert.equal(latest.to, NOW + 2 * HOUR); assert.deepEqual(latest.points.at(-1), { time: NOW + 2 * HOUR, close: 101 });
});

test('known UTC blocks omit rows for warm legs, transfer new and revised closes and expire the first hour', async t => {
  let revised = false;
  const f = setup(t, { reader: async (market, range) => points(range, revised && market.exchange === 'binance' ? 101 : 100) });
  f.read(); await finish(f);
  const compact = knownBlocks => f.service.read({ pair, days: 3, knownBlocks });
  const first = compact({});
  assert.equal(first.blockSpanMs, PRICE_BLOCK_MS);
  const cache = {}, known = {};
  for (const [key, leg] of Object.entries(first.legs)) {
    assert.equal(leg.points, undefined);
    cache[key] = mergeCandleBlocks([], leg, PRICE_BLOCK_MS);
    assert.deepEqual(cache[key].flatMap(block => block.rows), f.read().legs[key].points);
    known[leg.identity] = candleKnown(cache[key]);
  }
  const warm = compact(known);
  assert.ok(Object.values(warm.legs).every(leg => leg.blocks.every(block => block.rows === undefined)));
  revised = true; f.advance(HOUR + 1000); f.read(); await f.service.collect();
  const updated = compact(known);
  for (const [key, leg] of Object.entries(updated.legs)) {
    const sent = leg.blocks.flatMap(block => block.rows ?? []);
    assert.deepEqual(sent.map(row => row.time), key === pair.longKey ? [NOW, NOW + HOUR] : [NOW + HOUR]);
    const points = mergeCandleBlocks(cache[key], leg, PRICE_BLOCK_MS).flatMap(block => block.rows);
    assert.deepEqual(points, f.read().legs[key].points);
    assert.equal(points.length, 720);
  }
  const newMarket = { ...f.quotes[0], marketId: 42 };
  f.markets.set(pair.longKey, newMarket); f.quotes[0] = { ...newMarket, historyIdentity: first.legs[pair.longKey].identity };
  assert.throws(() => compact(known), { status: 400 });
  f.quotes[0].historyIdentity = perpetualPriceIdentity(newMarket);
  const changedIdentity = compact(known).legs[pair.longKey];
  assert.equal(changedIdentity.identity, f.quotes[0].historyIdentity); assert.deepEqual(changedIdentity.blocks, []);
  await finish(f);
  assert.equal(compact(known).legs[pair.longKey].blocks.flatMap(block => block.rows ?? []).length, 720, 'old identity tags cannot suppress new rows');
});

test('older missing hours rotate across restarts, permanent gaps cool down and new closed hours take priority', async t => {
  const older = NOW - 16 * 24 * HOUR, newer = NOW - 5 * 24 * HOUR, missing = new Set([older, newer]), saved = new Map();
  const settings = {
    reader: async (market, range) => points(range).filter(point => market.exchange !== 'binance' || !missing.has(point.time)),
    service: { store: { savePriceHistory: entry => saved.set(entry.key, structuredClone(entry)), loadPriceHistory: key => [saved.get(key)] } },
  };
  const f = setup(t, settings); f.read(); await finish(f);
  assert.equal(f.read().legs[pair.longKey].points.length, 718);
  const cold = f.service.read({ pair, days: 30, knownBlocks: {} }).legs[pair.longKey];
  const cache = mergeCandleBlocks([], cold, PRICE_BLOCK_MS), knownBlocks = { [cold.identity]: candleKnown(cache) };
  f.advance(300_000); f.read(); await f.service.collect();
  assert.deepEqual(f.calls.at(-1).range, { from: older - HOUR, to: older });
  await f.service.stop();
  const restarted = setup(t, settings); restarted.advance(300_000); restarted.read(); await restarted.service.collect();
  assert.equal(restarted.calls.length, 0, 'restoring a permanent gap keeps its cooldown');
  missing.delete(newer);
  restarted.advance(300_000); restarted.read(); await restarted.service.collect();
  assert.deepEqual(restarted.calls.map(call => call.range), [{ from: newer - HOUR, to: newer }]);
  const repaired = restarted.service.read({ pair, days: 30, knownBlocks }).legs[pair.longKey];
  assert.deepEqual(repaired.blocks.flatMap(block => block.rows ?? []), [{ time: newer, close: 100 }]);
  assert.equal(repaired.fetchedAt, NOW, 'repairing old prices does not advance the latest price timestamp');
  restarted.advance(300_000); restarted.read(); await restarted.service.collect();
  assert.equal(restarted.calls.length, 1, 'the complete round backs off the remaining no-trade gap');
  restarted.advance(6 * HOUR); restarted.read(); await restarted.service.collect();
  assert.deepEqual(restarted.calls.slice(1).map(call => call.range), Array(2).fill({ from: NOW - HOUR, to: NOW + 6 * HOUR }));
});

test('a transient failure on the only old gap preserves its cursor and retries after a minute, even across a new close', async t => {
  const missing = NOW - 10 * 24 * HOUR, saved = new Map();
  let fill = false;
  const f = setup(t, {
    service: { store: { savePriceHistory: entry => saved.set(entry.key, structuredClone(entry)), loadPriceHistory: () => [] } },
    reader: async (market, range) => {
      if (market.exchange === 'binance' && range.from === missing - HOUR && range.to === missing && !fill) throw Error('timeout');
      return points(range).filter(point => market.exchange !== 'binance' || point.time !== missing || fill);
    },
  });
  f.read(); await finish(f);
  f.advance(HOUR - 30_000); f.read(); await f.service.collect();
  const failed = saved.get(pair.longKey);
  assert.equal(failed.value.status, 'error'); assert.equal(failed.gapThrough, 0);
  assert.equal(failed.gapAfter, NOW + HOUR + 30_000);
  fill = true;
  f.advance(30_000); f.read(); await f.service.collect();
  assert.ok(f.read().legs[pair.longKey].points.some(point => point.time === NOW + HOUR), 'current close is collected before the historical retry');
  assert.equal(f.read().legs[pair.longKey].points.some(point => point.time === missing), false);
  f.advance(60_000); f.read(); await f.service.collect();
  const recovered = saved.get(pair.longKey);
  assert.ok(recovered.value.points.some(point => point.time === missing)); assert.equal(recovered.gapThrough, missing);
  assert.equal(recovered.gapAfter, NOW + 7 * HOUR + 60_000);
});
test('current directory validation rejects unknown/obsolete/mismatched pair atomically', async t => {
  const f = setup(t);
  for (const input of [{ pair: { ...pair, longKey: 'evil:https://localhost' }, days: 7 }, { pair, days: 2 }, { pair: { ...pair, base: 'ETH' }, days: 7 }, { pairs: [pair], days: 7 }]) assert.throws(() => f.service.read(input), { status: 400 });
  f.markets.delete(pair.shortKey); assert.throws(() => f.read(), { status: 400 });
  assert.equal(f.service.metrics().cached, 0); assert.equal(f.calls.length, 0);
});
test('directory identity changes during in-flight load cannot write old data', async t => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const f = setup(t, { reader: async () => pending });
  f.read(); const collecting = f.service.collect(); await turn();
  f.quotes[0] = { ...f.quotes[0], multiplier: 1000 }; f.markets.set(pair.longKey, f.quotes[0]);
  f.read(); resolve([{ time: NOW, close: 999 }]); await collecting; await turn();
  const leg = f.read().legs[pair.longKey];
  assert.equal(leg.identity, perpetualPriceIdentity(f.quotes[0])); assert.equal(leg.points.some(point => point.close === 999), false);
});
test('stop aborts a noncooperative reader and prevents late writes', async t => {
  let resolve;
  const f = setup(t, { reader: () => new Promise(done => { resolve = done; }), service: { maxConcurrent: 1 } });
  f.read(); const collecting = f.service.collect(); await turn();
  await f.service.stop(); await collecting; resolve([{ time: NOW, close: 999 }]); await turn();
  assert.equal(f.read().legs[pair.longKey].points.length, 0); assert.equal(f.service.metrics().inFlight, 0);
});
test('two concurrent readers maximum and identical selections deduplicate jobs', async t => {
  const pending = [];
  const f = setup(t, { reader: (_market, range) => new Promise(resolve => pending.push(() => resolve(points(range)))), service: { maxConcurrent: 9 } });
  f.read(); const one = f.service.collect(); f.read(); const two = f.service.collect(); await turn();
  assert.equal(pending.length, 2); assert.equal(f.service.metrics().inFlight, 2);
  pending.forEach(resolve => resolve()); await Promise.all([one, two]);
});
test('durable cache survives restart and rejects changed identity', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perpetual-price-')), store = openPerpetualCache(join(dir, 'test.sqlite'));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const f = setup(t, { service: { store } }); f.read(); await finish(f); await f.service.stop();
  const f2 = setup(t, { service: { store } });
  assert.equal(f2.read().legs[pair.longKey].points.length, 720); await f2.service.collect(); assert.equal(f2.calls.length, 0);
  f2.quotes[0] = { ...f2.quotes[0], multiplier: 1000 }; f2.markets.set(pair.longKey, f2.quotes[0]);
  assert.equal(f2.read().legs[pair.longKey].points.length, 0);
});
test('unsupported leg is explicit and does not retry each poll', async t => {
  const f = setup(t, { reader: async () => { throw Object.assign(Error('未接入'), { code: 'UNSUPPORTED' }); } });
  f.read(); await f.service.collect(); assert.equal(f.read().legs[pair.longKey].status, 'unsupported');
  const count = f.calls.length; f.read(); await f.service.collect(); assert.equal(f.calls.length, count);
});
test('dormant selections stop upstream refresh until read again', async t => {
  const f = setup(t, { service: { activeLeaseMs: 5000 } }); f.read(); await finish(f);
  const count = f.calls.length; f.advance(2 * HOUR); await f.service.collect(); assert.equal(f.calls.length, count);
  f.read(); await f.service.collect(); assert.equal(f.calls.length, count + 2);
});
