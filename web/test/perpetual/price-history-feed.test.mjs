// Ported from project-aggregation 工作台 modules/monitor/tests/perpetual-price-feed.test.mjs (commit c84ba27). Changes: import paths (the feed is web/src/perpetual-price-history-feed.ts, the validation and identity src/vendor/perpetual-price-history.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { startPerpetualPriceHistoryFeed } from '../../src/perpetual-price-history-feed.ts';
import { validatePerpetualPriceHistory, perpetualPriceIdentity, PRICE_BLOCK_MS } from '../../../src/vendor/perpetual-price-history.ts';
import { encodeCandleBlocks } from '../../../src/candle-blocks-server.ts';
import { ApiError } from '../../src/api.ts';

const HOUR = 3_600_000, NOW = Date.UTC(2026, 9, 11, 12);
const pair = { base: 'BTC', longKey: 'binance:BTCUSDT', shortKey: 'aster:BTCUSDT' };
const second = { base: 'ETH', longKey: 'binance:ETHUSDT', shortKey: 'aster:ETHUSDT' };
function report(selected = pair, overrides = {}) {
  return { schemaVersion: 1, generatedAt: NOW, intervalMs: HOUR, legs: Object.fromEntries([selected.longKey, selected.shortKey].map(key => {
    const split = key.indexOf(':'), market = { exchange: key.slice(0, split), symbol: key.slice(split + 1), base: selected.base, quoteCurrency: 'USDT' };
    return [key, { key, identity: perpetualPriceIdentity(market), exchange: market.exchange, symbol: market.symbol, currency: 'USDT', status: 'ready', from: NOW - 30 * 24 * HOUR, to: NOW, fetchedAt: NOW, points: [{ time: NOW, close: 100 }], error: '', backfillComplete: true, ...overrides }];
  })) };
}
function fixture(t, load, cache, onExpired) {
  let now = NOW;
  const tasks = new Map(), data = [], cached = [], errors = [], calls = [];
  const feed = startPerpetualPriceHistoryFeed({ now: () => now, cache, onExpired, load: (...args) => { calls.push(args); return load(...args); }, onData: (value, fromCache) => { data.push(value); cached.push(fromCache); }, onError: error => errors.push(error), onLoading: () => {}, schedule: (fn, delay) => { const token = {}; tasks.set(token, { fn, at: now + delay }); return token; }, cancel: token => tasks.delete(token) });
  t.after(() => feed.stop());
  return { feed, data, cached, errors, calls, tasks, tick: async ms => { now += ms; const due = [...tasks].filter(([, task]) => task.at <= now); for (const [token, task] of due) { tasks.delete(token); task.fn(); } await turn(); }, last: () => data.at(-1) };
}
test('selected only; null/disabled makes no calls; window and direction reuse one report', async t => {
  const f = fixture(t, async selected => report(selected));
  f.feed.setSelection(null, 7); f.feed.setActive(true); assert.equal(f.calls.length, 0);
  f.feed.setActive(false); f.feed.setSelection(pair, 7); assert.equal(f.calls.length, 0);
  f.feed.setActive(true); await turn(); assert.equal(f.calls.length, 1);
  f.feed.setSelection(pair, 30); f.feed.setSelection({ ...pair, longKey: pair.shortKey, shortKey: pair.longKey }, 3); await turn();
  assert.equal(f.calls.length, 1); assert.equal(f.last().legs[pair.longKey].points[0].close, 100);
  await f.tick(60_000); assert.equal(f.calls.length, 2);
  await f.tick(60_000); assert.equal(f.calls.length, 3);
});
test('pair switches abort pending read and ignore late noncooperative results', async t => {
  const pending = [];
  const f = fixture(t, (selected, _days, signal) => new Promise(resolve => pending.push({ selected, signal, resolve })));
  f.feed.setSelection(pair, 7); f.feed.setActive(true); f.feed.refresh(); assert.equal(pending.length, 1);
  f.feed.setSelection(second, 7); assert.equal(pending[0].signal.aborted, true); assert.equal(f.last(), null);
  pending[1].resolve(report(second)); await turn(); pending[0].resolve(report(pair)); await turn();
  assert.equal(f.last().legs[second.longKey].symbol, 'ETHUSDT'); assert.equal(f.last().legs[pair.longKey], undefined);
});
test('pending polls at three seconds, stop aborts and suppresses callbacks', async t => {
  let pendingResolve;
  const f = fixture(t, async (_selected, _days, signal) => {
    if (f.calls.length > 1) return new Promise(resolve => { pendingResolve = resolve; signal.addEventListener('abort', () => {}); });
    return report(pair, { status: 'pending', backfillComplete: false });
  });
  f.feed.setSelection(pair, 7); f.feed.setActive(true); await turn(); await f.tick(2999); assert.equal(f.calls.length, 1); await f.tick(1); assert.equal(f.calls.length, 2);
  const count = f.data.length; f.feed.stop(); pendingResolve(report()); await turn(); assert.equal(f.data.length, count); assert.equal(f.tasks.size, 0);
});
test('request failure retains data, backoffs, and allows recovery', async t => {
  let fail = false;
  const f = fixture(t, async () => { if (fail) throw Error('unavailable'); return report(); });
  f.feed.setSelection(pair, 7); f.feed.setActive(true); await turn(); const previous = f.last();
  fail = true; await f.tick(60_000); assert.equal(f.last(), previous); assert.match(f.errors.at(-1), /保留/);
  f.feed.refresh(); f.feed.setActive(false); f.feed.setActive(true); f.feed.refresh();
  await f.tick(1000); assert.equal(f.calls.length, 2); fail = false; await f.tick(59_000); assert.equal(f.calls.length, 3); assert.equal(f.errors.at(-1), '');
});
test('missing/unrelated legs or malformed transport are rejected before publish', async t => {
  const f = fixture(t, async () => report(second));
  f.feed.setSelection(pair, 7); f.feed.setActive(true); await turn(); assert.equal(f.last(), null); assert.ok(f.errors.at(-1));
  for (const transform of [r => { r.intervalMs = 1000; }, r => { r.legs[pair.longKey].points.push({ time: NOW, close: 100 }); }, r => { r.legs[pair.longKey].points[0].close = 0; }, r => { r.legs[pair.longKey].to = NOW + HOUR; }, r => { r.legs[pair.longKey].identity = '[]'; }, r => { r.legs[pair.longKey].fetchedAt = NOW + HOUR; }]) {
    const value = report(); transform(value); assert.equal(validatePerpetualPriceHistory(value, NOW), false);
  }
});
test('fresh identity discards old prices; same identity failed report can retain prior validated cache', async t => {
  let result = report(); const f = fixture(t, async () => result);
  f.feed.setSelection(pair, 7); f.feed.setActive(true); await turn();
  result = report(pair, { points: [], status: 'error', from: null, to: null, fetchedAt: null, backfillComplete: false, error: 'failure' });
  await f.tick(60_000); assert.equal(f.last().legs[pair.longKey].points.length, 1);
  result = report(pair, { points: [], status: 'pending', from: null, to: null, fetchedAt: null, backfillComplete: false });
  for (const leg of Object.values(result.legs)) { const identity = JSON.parse(leg.identity); identity[5] = 1000; leg.identity = JSON.stringify(identity); }
  await f.tick(60_000); assert.equal(f.last().legs[pair.longKey].points.length, 0);
});

function compact(report, known) {
  return { ...report, blockSpanMs: PRICE_BLOCK_MS, legs: Object.fromEntries(Object.entries(report.legs).map(([key, { points, ...leg }]) =>
    [key, { ...leg, ...encodeCandleBlocks(points, PRICE_BLOCK_MS, known[leg.identity] ?? '') }])) };
}
function browserCache(disk) {
  const memory = new Map(), writes = [];
  return {
    peek: key => memory.get(key), load: async key => structuredClone(disk.get(key)),
    put(key, value) { writes.push(key); memory.set(key, value); disk.set(key, structuredClone(value)); },
    remove(key) { memory.delete(key); disk.delete(key); }, writes,
  };
}
const identitiesOf = value => Object.fromEntries(Object.entries(value.legs).map(([key, leg]) => [key, leg.identity]));
const transferred = response => Object.values(response.legs).flatMap(leg => leg.blocks.flatMap(block => block.rows ?? []));
const chartRows = (value, key) => [...value.unscanned[key] ?? [], ...value.legs[key].points].sort((a, b) => a.time - b.time);

test('reopening and reloading reuse verified leg blocks, including pending polls; restored prices keep the source time', async t => {
  const disk = new Map(), store = browserCache(disk), responses = [];
  const closes = [{ time: NOW - HOUR, close: 98 }, { time: NOW, close: 100 }];
  let source = report(pair, { points: closes, status: 'pending', backfillComplete: false }), wait;
  function load(_pair, _days, _signal, known) {
    const reply = compact(source, known); responses.push(reply);
    return wait ? new Promise(resolve => { wait = () => resolve(reply); }) : Promise.resolve(reply);
  }
  const ids = identitiesOf(source), f = fixture(t, load, store);
  f.feed.setSelection(pair, 3, ids); f.feed.setActive(true); await turn();
  assert.equal(transferred(responses[0]).length, 4); assert.equal(store.writes.length, 2);
  await f.tick(3000); assert.equal(transferred(responses[1]).length, 0); assert.equal(store.writes.length, 2);
  f.feed.stop();
  const reopened = fixture(t, load, store); wait = true;
  reopened.feed.setSelection(pair, 7, ids); reopened.feed.setActive(true); await turn();
  assert.equal(reopened.cached.at(-1), true); assert.equal(reopened.last().legs[pair.longKey].points.length, 2);
  assert.equal(transferred(responses.at(-1)).length, 0); wait(); await turn(); reopened.feed.stop();
  // A new module instance has only the persisted legs. Upper-level requests may change window and direction freely.
  const freshStore = browserCache(disk), reload = fixture(t, load, freshStore);
  await reload.tick(60_000); wait = true;
  reload.feed.setSelection({ ...pair, longKey: pair.shortKey, shortKey: pair.longKey }, 30, ids); reload.feed.setActive(true); await turn();
  assert.equal(reload.cached.at(-1), true); assert.equal(reload.last().generatedAt, NOW);
  assert.equal(reload.last().legs[pair.shortKey].fetchedAt, NOW); assert.equal(transferred(responses.at(-1)).length, 0);
  wait(); await turn(); assert.equal(reload.cached.at(-1), false); assert.equal(freshStore.writes.length, 0);
  wait = false;
  source = report(pair, { points: closes });
  source.legs[pair.longKey].points = [{ time: NOW - HOUR, close: 99 }, closes[1]];
  await reload.tick(3000);
  assert.deepEqual(transferred(responses.at(-1)), [{ time: NOW - HOUR, close: 99 }]);
  assert.equal(reload.last().legs[pair.longKey].points[0].close, 99);
  assert.equal(reload.last().legs[pair.shortKey].points[0].close, 98);
  assert.deepEqual(freshStore.writes.sort(), Object.values(ids).sort(), 'one status transition and one revised leg');
});

test('same-symbol identity switch cancels an old disk restore and never advertises its rows for the new market', async t => {
  const disk = new Map(), seed = browserCache(disk), old = report(), ids = identitiesOf(old);
  const f = fixture(t, async (_pair, _days, _signal, known) => compact(old, known), seed);
  f.feed.setSelection(pair, 7, ids); f.feed.setActive(true); await turn(); f.feed.stop();
  const next = report();
  const changed = JSON.parse(next.legs[pair.longKey].identity); changed[4] = 22; next.legs[pair.longKey].identity = JSON.stringify(changed);
  next.legs[pair.longKey].points = [];
  const newIds = identitiesOf(next), deferred = [], seen = [];
  const store = { ...browserCache(disk), load: id => new Promise(resolve => deferred.push({ id, finish: () => resolve(disk.get(id)) })) };
  const g = fixture(t, async (_pair, _days, _signal, known) => { seen.push(known); return compact(next, known); }, store);
  g.feed.setSelection(pair, 30, ids); g.feed.setActive(true);
  g.feed.setSelection(pair, 30, newIds);
  deferred.slice(0, 2).forEach(row => row.finish()); await turn(); assert.deepEqual(seen, []); assert.equal(g.last(), null);
  deferred.slice(2).forEach(row => row.finish()); await turn();
  assert.deepEqual(Object.keys(seen[0]), [newIds[pair.shortKey]]); assert.deepEqual(g.last().legs[pair.longKey].points, []);
  assert.ok(g.data.every(value => !value?.legs[pair.longKey] || value.legs[pair.longKey].identity === newIds[pair.longKey]));
});

test('a rebuilding server reuses older unscanned days; scanned empty periods, revisions and rolled-out closes stay authoritative', async t => {
  const day = 24 * HOUR, first = NOW - 30 * day + HOUR, old = NOW - 20 * day, later = NOW - 10 * day;
  const rows = (...times) => times.map(time => ({ time, close: 100 }));
  let source = report(pair, { points: rows(first, old, later, NOW - HOUR, NOW) });
  const replies = [], store = browserCache(new Map()), ids = identitiesOf(source);
  const f = fixture(t, async (_pair, _days, _signal, known) => { const reply = compact(source, known); replies.push(reply); return reply; }, store);
  f.feed.setSelection(pair, 30, ids); f.feed.setActive(true); await turn();
  const recent = [{ time: NOW, close: 101 }, { time: NOW + HOUR, close: 102 }];
  source = report(pair, { status: 'pending', backfillComplete: false, from: NOW - 3 * day, to: NOW + HOUR, fetchedAt: NOW + HOUR, points: recent });
  source.generatedAt = NOW + HOUR;
  await f.tick(HOUR);
  assert.equal(f.cached.at(-1), true); assert.deepEqual(chartRows(f.last(), pair.longKey), [...rows(old, later), ...recent]);
  for (const leg of Object.values(source.legs)) leg.from = NOW - 17 * day;
  await f.tick(3000);
  assert.deepEqual(chartRows(f.last(), pair.longKey), [...rows(old), ...recent]);
  for (const leg of Object.values(source.legs)) Object.assign(leg, { from: first, status: 'ready', backfillComplete: true, points: [...rows(old), ...recent] });
  await f.tick(3000);
  assert.equal(f.cached.at(-1), false); assert.deepEqual(f.last().legs[pair.longKey].points, source.legs[pair.longKey].points);
  assert.deepEqual(transferred(replies.at(-1)), [], 'the matching day older than all previous backfill pages stayed available');
});

for (const [elapsedDays, status] of [[1, 'pending'], [7, 'pending'], [7, 'error']]) test(`rebuild in ${status} state after ${elapsedDays} days preserves unscanned closes across UTC blocks and browser restarts`, async t => {
  const day = 24 * HOUR, newest = NOW + elapsedDays * day, baseline = newest - 30 * day, scanned = newest - 3 * day;
  const range = (after, through) => Array.from({ length: (through - after) / HOUR }, (_, i) => ({ time: after + (i + 1) * HOUR, close: 100 }));
  const disk = new Map(), old = range(NOW - 30 * day, NOW);
  let source = report(pair, { points: old }), replies = [], wait;
  const withCache = () => fixture(t, async (_pair, _days, _signal, known) => {
    const reply = compact(source, known); replies.push(reply);
    if (wait === true) await new Promise(resolve => { wait = resolve; });
    return reply;
  }, browserCache(disk));
  const ids = identitiesOf(source), f = withCache();
  f.feed.setSelection(pair, 30, ids); f.feed.setActive(true); await turn();
  const confirmed = range(scanned, newest).filter(point => point.time !== scanned + HOUR);
  confirmed[0].close = 101;
  source = report(pair, { from: scanned, to: newest, fetchedAt: newest, status, error: status === 'error' ? '历史补页超时' : '', backfillComplete: false, points: confirmed });
  source.generatedAt = newest;
  await f.tick(elapsedDays * day);
  const older = old.filter(row => row.time > baseline && row.time <= scanned);
  const key = pair.longKey;
  assert.equal(older.length, elapsedDays === 7 ? 552 : 648);
  assert.deepEqual(f.last().legs[key].points, confirmed);
  assert.equal(f.last().legs[key].from, scanned, 'the new scan never claims the gap before it');
  assert.equal(f.last().legs[key].status, status);
  assert.equal(f.last().legs[key].fetchedAt, newest);
  assert.deepEqual(f.last().unscanned[key], older); assert.equal(f.cached.at(-1), true);
  assert.deepEqual(chartRows(f.last(), key), [...older, ...confirmed], 'rolling cutoff and both mid-day boundaries use hourly row times');
  const saved = disk.get(ids[key]);
  for (const part of saved.archived) {
    assert.equal(part.fetchedAt, NOW);
    assert.equal(encodeCandleBlocks(part.block.rows, PRICE_BLOCK_MS, '').blocks[0].tag, part.block.tag, 'the advertised version still matches the whole original block');
  }
  f.feed.stop();
  const afterReload = withCache(); await afterReload.tick(elapsedDays * day); wait = true;
  afterReload.feed.setSelection(pair, 30, ids); afterReload.feed.setActive(true); await turn();
  assert.deepEqual(afterReload.last().unscanned[key], older); assert.equal(afterReload.cached.at(-1), true);
  assert.equal(transferred(replies.at(-1)).length, 0, 'the restored UTC-day baselines match the partial server response');
  wait(); await turn();
  const dropped = older.at(-1).time, full = range(baseline, newest).filter(point => point.time !== dropped && point.time !== scanned + HOUR);
  full.find(row => row.time === confirmed[0].time).close = 101;
  for (const leg of Object.values(source.legs)) Object.assign(leg, { from: baseline, status: 'ready', backfillComplete: true, points: full });
  await afterReload.tick(status === 'error' ? 60_000 : 3000);
  assert.deepEqual(chartRows(afterReload.last(), key), full);
  assert.equal(afterReload.cached.at(-1), false); assert.equal(disk.get(ids[key]).archived, undefined);
  const sent = replies.at(-1).legs[key].blocks.flatMap(block => block.rows ?? []);
  // A disjoint four-day interval has never been downloaded. Each partial UTC day may also need its changed rows.
  assert.ok(sent.length <= Math.max(0, (scanned - NOW) / HOUR) + 2 * 24);
  assert.ok(sent.length < full.length);
});

test('an explicit history access refusal removes both restored legs until reauthorized; a 503 preserves them', async t => {
  for (const status of [401, 403, 404, 423, 503]) {
    const source = report(), ids = identitiesOf(source), disk = new Map(), store = browserCache(disk);
    let denied = false;
    const load = async (_pair, _days, _signal, known) => {
      if (denied) throw new ApiError('不可用', status);
      return compact(source, known);
    };
    const first = fixture(t, load, store); first.feed.setSelection(pair, 7, ids); first.feed.setActive(true); await turn(); first.feed.stop();
    denied = true;
    let expired = false;
    const failed = fixture(t, load, store, () => { expired = true; assert.equal(disk.size, 0); assert.equal(failed.last(), null); });
    failed.feed.setSelection(pair, 7, ids); failed.feed.setActive(true); await turn();
    assert.equal(expired, status === 401);
    assert.equal(Boolean(failed.last()), status === 503);
    assert.equal(disk.size, status === 503 ? 2 : 0); failed.feed.stop();
    const retry = fixture(t, load, browserCache(disk)); retry.feed.setSelection(pair, 7, ids); retry.feed.setActive(true); await turn();
    assert.equal(retry.data.some(Boolean), status === 503);
    assert.equal(Object.keys(retry.calls[0][3]).length, status === 503 ? 2 : 0);
    denied = false; await retry.tick(60_000);
    assert.equal(retry.last().legs[pair.longKey].points.length, 1); assert.equal(disk.size, 2);
  }
});

for (const reauthorized of [false, true]) test(`an IndexedDB deletion delayed past denial respects the latest authorization (${reauthorized})`, async t => {
  const disk = new Map(), markers = new Map(), opening = [];
  let quotaFull = false;
  function replaceGlobal(name, value) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => { if (original) Object.defineProperty(globalThis, name, original); else delete globalThis[name]; });
  }
  const db = { transaction() {
    const tx = { objectStore: () => ({
      get([, key]) { const req = { result: disk.get(key) }; queueMicrotask(() => { req.onsuccess(); queueMicrotask(() => tx.oncomplete?.()); }); return req; },
      put(entry) { disk.set(entry.key, entry); queueMicrotask(() => tx.oncomplete?.()); },
      delete([, key]) { disk.delete(key); queueMicrotask(() => tx.oncomplete()); },
      index: () => ({ openCursor: () => ({}) }),
    }) };
    return tx;
  } };
  replaceGlobal('indexedDB', { open() { const req = { result: db }; opening.push(() => req.onsuccess()); return req; } });
  replaceGlobal('IDBKeyRange', { bound: () => ({}) });
  replaceGlobal('localStorage', { getItem: key => markers.get(key) ?? null, removeItem: key => markers.delete(key),
    setItem(key, value) { if (quotaFull) throw new DOMException('Storage full', 'QuotaExceededError'); markers.set(key, value); },
  });
  const source = report(), ids = identitiesOf(source);
  const serve = async (_pair, _days, _signal, known) => compact(source, known);
  function start(store, load) {
    const f = fixture(t, load, store); f.feed.setSelection(pair, 7, ids); f.feed.setActive(true); return f;
  }
  const namespace = 'slow-price-db';
  const { createPublicCandleCache: alreadyOpen } = await import(`../../src/public-candle-cache.ts?open-${reauthorized}`);
  const first = start(alreadyOpen(namespace, 2), serve);
  opening.shift()(); await turn(); first.feed.stop(); assert.equal(disk.size, 2);

  const { createPublicCandleCache: reload } = await import(`../../src/public-candle-cache.ts?slow-open-${reauthorized}`);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  quotaFull = true;
  const denied = start(reload(namespace, 2), async () => { throw new ApiError('已停采', 403); });
  t.mock.timers.tick(1201); await turn(); denied.feed.stop();
  assert.equal(denied.last(), null); assert.equal(markers.size, 0); assert.equal(disk.size, 2);
  const retry = start(reload(namespace, 2), async () => { throw new ApiError('服务不可用', 503); });
  await turn(); assert.equal(retry.data.some(Boolean), false); assert.deepEqual(retry.calls[0][3], {});
  quotaFull = false;
  if (reauthorized) {
    for (const leg of Object.values(source.legs)) leg.points = [{ time: NOW, close: 444 }];
    const otherTab = start(alreadyOpen(namespace, 2), serve); await turn(); otherTab.feed.stop();
    assert.equal(markers.size, 2); assert.equal(disk.size, 2);
  }
  opening.shift()(); await turn(); retry.feed.stop();
  assert.equal(disk.size, reauthorized ? 2 : 0); assert.equal(markers.size, disk.size);
  const allowed = start(reload(namespace, 2), reauthorized ? async () => { throw new ApiError('服务不可用', 503); } : serve); await turn();
  assert.equal(allowed.last().legs[pair.longKey].points.length, 1); assert.equal(disk.size, 2);
  if (reauthorized) assert.equal(allowed.last().legs[pair.longKey].points[0].close, 444);
});
