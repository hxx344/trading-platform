// Ported from the workbench's modules/monitor/tests/anthropic-market.test.mjs (commit 9a5223f): the cases that use only
// the market module (src/vendor/anthropic-market.mjs). Cases and assertions on the workbench's market store, monitor
// switch file, hub summary, HTTP handler and lib/anthropic-history.ts are left out; this service's store, loops and
// endpoints are covered in monitor.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANTHROPIC_CANDLE_MS, anthropicCandleWindow, anthropicChartRows, anthropicPremium, createAnthropicCandles, createBinanceGate,
  createRhLighterState, fetchAnthropicCandles, fetchAnthropicQuote, validateAnthropicCandles, validateAnthropicQuote,
  type AnthropicCandles,
} from '../src/vendor/anthropic-market.mjs';

// The ported cases poke at loosely shaped venue payloads.
type Any = any;
type Call = { hl?: Any; rh?: string; binance?: string; params?: Record<string, string> };

const BAR = ANTHROPIC_CANDLE_MS, DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 6, 12, 7);
const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fail = (status: number) => new Response('{}', { status });
const hlContext = (name: string, markPx: number, isDelisted = false) => [{ universe: [{ name: 'other' }, { name, isDelisted }] }, [{ markPx: '1' }, { markPx: String(markPx), funding: '0.00001', oraclePx: String(markPx) }]];

/** Routes Binance GETs, Lighter RH GETs and Hyperliquid POSTs; `binance`/`hl`/`rh` return a response or throw. */
function fetcher({ binance, hl, rh = () => fail(500) }: { binance: (url: URL) => Response | Promise<Response>; hl: (body: Any) => Response | Promise<Response>; rh?: (url: URL) => Response | Promise<Response> }) {
  const calls: Call[] = [];
  const fn = async (url: string, init: RequestInit = {}) => {
    if (init.method === 'POST') { const body = JSON.parse(init.body as string); calls.push({ hl: body }); return hl(body); }
    const parsed = new URL(url), params = Object.fromEntries(parsed.searchParams);
    if (parsed.hostname === 'api.rh.lighter.xyz') { calls.push({ rh: parsed.pathname, params }); return rh(parsed); }
    calls.push({ binance: parsed.pathname, params });
    return binance(parsed);
  };
  return Object.assign(fn, { calls });
}

/**
 * A public Lighter RH deployment: the catalog lists the ANTHROPIC perpetual among other markets, an
 * unknown market id answers HTTP 400, and candles return the latest `count_back` bars opening before
 * `end_timestamp` (at most 500), as measured against api.rh.lighter.xyz.
 */
function rhVenue({ id = 38, mark = '1503.5', status = 'active', symbol = 'ANTHROPIC', listedAt = NOW - 400 * DAY, close = (_t: number): number => 1503 } = {}) {
  const row = () => ({ symbol, market_id: id, market_type: 'perp', status, mark_price: mark, index_price: '1502.5', last_trade_price: 1504.1, created_at: String(listedAt) });
  return (url: URL) => {
    if (url.pathname === '/api/v1/orderBookDetails') {
      const market = url.searchParams.get('market_id');
      if (market === null) return ok({ code: 200, order_book_details: [{ symbol: 'BTC', market_id: 1, market_type: 'perp', status: 'active', mark_price: '1' }, { symbol: 'ANTHROPIC', market_id: 99, market_type: 'spot', status: 'active', mark_price: '1' }, row()], spot_order_book_details: [] });
      return Number(market) === id ? ok({ code: 200, order_book_details: [row()] }) : ok({ code: 21602, message: 'invalid market index' }, 400);
    }
    if (url.pathname === '/api/v1/candles' && Number(url.searchParams.get('market_id')) === id && url.searchParams.get('resolution') === '15m') {
      const end = Number(url.searchParams.get('end_timestamp')), count = Number(url.searchParams.get('count_back')), c = [];
      for (let t = Math.ceil(Math.max(end - count * BAR, listedAt) / BAR) * BAR; t < end && t < NOW + DAY; t += BAR) c.push({ t, o: 1, h: 1, l: 1, c: close(t), v: 1, V: 1, i: t });
      return ok({ code: 200, r: '15m', c: c.slice(-500) });
    }
    return fail(404);
  };
}
const rhCalls = (calls: Call[]) => calls.filter(call => call.rh);

test('quote converts every leg to per-share prices and keeps a failed leg as a reason', async () => {
  const quote: Any = await fetchAnthropicQuote({ now: NOW, fetcher: fetcher({
    binance: () => fail(451),
    hl: body => ok(hlContext(body.dex === 'xyz' ? 'xyz:ANT' : 'io:ANTH', body.dex === 'xyz' ? 95 : 1603.2)),
  }) });
  assert.equal(quote.binance, null);
  assert.match(quote.errors.binance, /451/);
  assert.equal(quote.xyz.markPx, 95);
  assert.equal(quote.io.markPx, 1603.2);
  assert.equal(quote.fetchedAt, new Date(NOW).toISOString());
  // 1206.5 / 12.7 = 95 per share, 1603.2 / 16.7 = 96 per share.
  assert.ok(Math.abs(anthropicPremium(1206.5, 95, 'xyz')!) < 1e-9);
  assert.ok(Math.abs(anthropicPremium(1206.5, 1603.2, 'io')! - (95 / 96 - 1) * 100) < 1e-9);
  assert.equal(anthropicPremium(null, 95, 'xyz'), null);
  await assert.rejects(fetchAnthropicQuote({ now: NOW, fetcher: fetcher({ binance: () => fail(500), hl: () => fail(500) }) }), /No Anthropic quote/);
  // Wrong market names are rejected rather than read as Anthropic.
  const wrong: Any = await fetchAnthropicQuote({ now: NOW, fetcher: fetcher({ binance: () => ok({ symbol: 'ANTHROPICUSDT', markPrice: '1200', lastFundingRate: '0.0001', nextFundingTime: NOW + 3_600_000 }), hl: () => ok(hlContext('xyz:OTHER', 1)) }) });
  assert.equal(wrong.binance.markPx, 1200); assert.equal(wrong.xyz, null); assert.equal(wrong.io, null);
  assert.throws(() => validateAnthropicQuote({ ...wrong, binance: { markPx: -1 } }));
});

const kline = (time: number, close: number) => [time, '1', '1', '1', String(close), '1', time + BAR - 1];
const candle = (coin: string, time: number, close: number) => ({ t: time, T: time + BAR - 1, s: coin, i: '15m', c: String(close), o: '1', h: '1', l: '1', v: '1', n: 1 });
const lastClosed = Math.floor(NOW / BAR) * BAR - BAR;

test('candles merge three legs, skip the open bar, and resume a failed leg from its own last close', async () => {
  const times = [lastClosed - 2 * BAR, lastClosed - BAR, lastClosed, lastClosed + BAR];
  const first = fetcher({
    binance: url => ok(times.filter(time => time >= Number(url.searchParams.get('startTime'))).map((time, index) => kline(time, 1200 + index))),
    hl: body => body.req.coin === 'io:ANTH' ? fail(500) : ok(times.map(time => candle('xyz:ANT', time, 95))),
  });
  const snapshot = await fetchAnthropicCandles(null, { now: NOW, fetcher: first });
  assert.equal(snapshot.data.length, 3, 'the still-open bar is not stored');
  assert.deepEqual(snapshot.data.map(row => [row.binance, row.xyz, row.io]), [[1200, 95, null], [1201, 95, null], [1202, 95, null]]);
  assert.equal(first.calls.find(call => call.binance)?.params!.startTime, String(Math.floor((NOW - 50 * DAY) / BAR) * BAR));
  validateAnthropicCandles(snapshot);

  const later = NOW + BAR, second = fetcher({ binance: url => ok([kline(Number(url.searchParams.get('startTime')), 1300)]), hl: body => ok([candle(body.req.coin, lastClosed + BAR, body.req.coin === 'io:ANTH' ? 1600 : 96)]) });
  const resumed = await fetchAnthropicCandles(snapshot, { now: later, fetcher: second });
  const starts = Object.fromEntries(second.calls.filter(call => !call.rh).map(call => call.hl ? [call.hl.req.coin, call.hl.req.startTime] : ['binance', Number(call.params!.startTime)]));
  assert.equal(starts.binance, lastClosed - 96 * BAR);
  assert.equal(starts['xyz:ANT'], lastClosed - 96 * BAR);
  assert.equal(starts['io:ANTH'], Math.min(snapshot.data[0]!.time, Math.floor((later - 50 * DAY) / BAR) * BAR), 'a leg that never succeeded backfills the initial window');
  assert.deepEqual(resumed.data.at(-1), { time: lastClosed + BAR, binance: null, xyz: 96, io: 1600, rh: null });
  assert.equal(resumed.data.length, 5, 'the overlap read adds the earlier Binance bar');
});

test('Binance candle pages continue until a short page', async () => {
  const start = Math.floor((NOW - 50 * DAY) / BAR) * BAR, total = Math.floor((NOW - start) / BAR);
  const binance = fetcher({ binance: url => { const from = Number(url.searchParams.get('startTime')), limit = Number(url.searchParams.get('limit')); const rows = []; for (let time = from; time < NOW && rows.length < limit; time += BAR) rows.push(kline(time, 1000)); return ok(rows); }, hl: () => fail(500) });
  const snapshot = await fetchAnthropicCandles(null, { now: NOW, fetcher: binance });
  assert.equal(binance.calls.filter(call => call.binance).length, Math.ceil((total + 1) / 1500));
  assert.equal(snapshot.data.length, total);
});

test('chart rows and windowed reads keep the per-share premium and coverage', async () => {
  const rows = [0, 1, 2, 3].map(index => ({ time: lastClosed - (3 - index) * DAY, binance: 1270, xyz: index === 1 ? null : 100, io: 1670 }));
  const snapshot = createAnthropicCandles(rows, new Date(NOW).toISOString());
  const chart = anthropicChartRows(snapshot.data, 'xyz');
  assert.equal(chart.length, 3);
  assert.deepEqual(chart[0], { time: rows[0]!.time, adr: 100, ordinary: 100, equivalent: 100, spread: 0, premium: 0 });
  assert.equal(anthropicChartRows(snapshot.data, 'io').length, 4);
  const window = anthropicCandleWindow({ ...snapshot }, 1);
  assert.equal(window.data.length, 2);
  assert.equal(window.windowDays, 1);
  assert.deepEqual(window.coverage, { firstObservation: snapshot.metadata.firstObservation, lastObservation: snapshot.metadata.lastObservation, rows: 4 });
});

test('Binance 429/418 starts a cooldown shared by quotes and candles, and a delisted Hyperliquid market is not a live quote', async () => {
  const gate = createBinanceGate();
  let binanceCalls = 0;
  const limited = fetcher({ binance: () => { binanceCalls++; return fail(429); }, hl: body => ok(hlContext(body.dex === 'xyz' ? 'xyz:ANT' : 'io:ANTH', 95, body.dex === 'io')) });
  const first: Any = await fetchAnthropicQuote({ now: NOW, fetcher: limited, gate, clock: () => NOW });
  assert.match(first.errors.binance, /429/);
  assert.equal(first.errors.io, '合约已下架');
  assert.equal(first.xyz.markPx, 95);
  const cooled = await fetchAnthropicQuote({ now: NOW + 59_000, fetcher: limited, gate, clock: () => NOW + 59_000 });
  assert.equal(binanceCalls, 1, 'no Binance request inside the cooldown');
  assert.equal(cooled.errors.binance, '接口限流冷却中（HTTP 429）');
  const candles = await fetchAnthropicCandles(null, { now: NOW + 59_000, fetcher: fetcher({ binance: () => { binanceCalls++; return fail(429); }, hl: body => ok([candle(body.req.coin, lastClosed, 95)]) }), gate, clock: () => NOW + 59_000 });
  assert.equal(binanceCalls, 1);
  assert.equal(candles.metadata.errors.binance, '接口限流冷却中（HTTP 429）');
  await fetchAnthropicQuote({ now: NOW + 60_000, fetcher: limited, gate, clock: () => NOW + 60_000 });
  assert.equal(binanceCalls, 2, 'the cooldown ends after 60 s');
  const banned = fetcher({ binance: () => fail(418), hl: body => ok(hlContext(body.dex === 'xyz' ? 'xyz:ANT' : 'io:ANTH', 95)) });
  await fetchAnthropicQuote({ now: NOW + 130_000, fetcher: banned, gate, clock: () => NOW + 130_000 });
  assert.match((await fetchAnthropicQuote({ now: NOW + 249_000, fetcher: banned, gate, clock: () => NOW + 249_000 })).errors.binance!, /冷却中（HTTP 418）/);
});

test('a failed candle leg is reported in the snapshot, survives window validation, and clears on success', async () => {
  const gate = createBinanceGate();
  const broken = fetcher({ binance: () => ok([kline(lastClosed, 1270)]), hl: body => body.req.coin === 'io:ANTH' ? fail(500) : ok([candle('xyz:ANT', lastClosed, 100)]), rh: rhVenue() });
  const snapshot = await fetchAnthropicCandles(null, { now: NOW, fetcher: broken, gate, rh: createRhLighterState() });
  assert.deepEqual(snapshot.metadata.errors, { io: '接口返回 HTTP 500' });
  assert.deepEqual(validateAnthropicCandles(JSON.parse(JSON.stringify(snapshot))).metadata.errors, { io: '接口返回 HTTP 500' });
  // Snapshots saved before leg errors existed still validate.
  const legacy = JSON.parse(JSON.stringify(snapshot)); delete legacy.metadata.errors;
  assert.deepEqual(validateAnthropicCandles(legacy).metadata.errors, {});
  assert.throws(() => validateAnthropicCandles({ ...snapshot, metadata: { ...snapshot.metadata, errors: { other: 'x' } } }), /leg error/);
  const healed = await fetchAnthropicCandles(snapshot, { now: NOW, fetcher: fetcher({ binance: () => ok([kline(lastClosed, 1270)]), hl: body => ok([candle(body.req.coin, lastClosed, 100)]), rh: rhVenue() }), gate, rh: createRhLighterState() });
  assert.deepEqual(healed.metadata.errors, {});
  // Hyperliquid candles must be 15-minute bars in ascending order.
  const duplicate = fetcher({ binance: () => fail(500), hl: body => ok([candle(body.req.coin, lastClosed, 100), candle(body.req.coin, lastClosed, 101)]) });
  await assert.rejects(fetchAnthropicCandles(null, { now: NOW, fetcher: duplicate, gate }));
  const hourly = fetcher({ binance: () => fail(500), hl: body => ok([{ ...candle(body.req.coin, lastClosed, 100), i: '1h' }]) });
  await assert.rejects(fetchAnthropicCandles(null, { now: NOW, fetcher: hourly, gate }));
});

test('Lighter RH reads the ANTHROPIC perpetual by symbol, then one market per round, priced per fully diluted share', async () => {
  const rh = createRhLighterState(), venue = fetcher({ binance: () => ok({ symbol: 'ANTHROPICUSDT', markPrice: '1270', lastFundingRate: '0.0001', nextFundingTime: NOW }), hl: () => fail(500), rh: rhVenue({ id: 51, mark: '1670' }) });
  const first: Any = await fetchAnthropicQuote({ now: NOW, fetcher: venue, rh });
  assert.deepEqual(first.rh, { markPx: 1670, fundingRate: null, indexPx: 1502.5 });
  assert.deepEqual(rhCalls(venue.calls).map(call => call.params), [{}], 'the first round discovers the market from the catalog only');
  const second: Any = await fetchAnthropicQuote({ now: NOW + 10_000, fetcher: venue, rh });
  assert.equal(second.rh.markPx, 1670);
  assert.deepEqual(rhCalls(venue.calls).map(call => call.params), [{}, { market_id: '51' }], 'later rounds read only the discovered market');
  // 1270 / 12.7 = 100 per share on Binance, 1670 / 16.7 = 100 per share on Lighter RH.
  assert.ok(Math.abs(anthropicPremium(first.binance.markPx, first.rh.markPx, 'rh')!) < 1e-9);
  assert.ok(Math.abs(anthropicPremium(1270, 1503, 'rh')! - (100 / (1503 / 16.7) - 1) * 100) < 1e-9);
  assert.deepEqual(anthropicChartRows([{ time: 0, binance: 1270, xyz: null, io: null, rh: 1503 }], 'rh').map(row => row.equivalent), [1503 / 16.7]);
});

test('a missing, delisted or reassigned Lighter RH market fails only that leg and is looked up again', async () => {
  const healthy = { binance: () => ok({ symbol: 'ANTHROPICUSDT', markPrice: '1270' }), hl: (body: Any) => ok(hlContext(body.dex === 'xyz' ? 'xyz:ANT' : 'io:ANTH', 95)) };
  const missing: Any = await fetchAnthropicQuote({ now: NOW, rh: createRhLighterState(), fetcher: fetcher({ ...healthy, rh: rhVenue({ symbol: 'OPENAI' }) }) });
  assert.equal(missing.rh, null); assert.equal(missing.errors.rh, '合约缺失');
  assert.equal(missing.binance.markPx, 1270); assert.equal(missing.xyz.markPx, 95); assert.equal(missing.io.markPx, 95);
  const inactive = await fetchAnthropicQuote({ now: NOW, rh: createRhLighterState(), fetcher: fetcher({ ...healthy, rh: rhVenue({ status: 'inactive' }) }) });
  assert.equal(inactive.errors.rh, '合约已下架');

  // The cached id stops existing (HTTP 400), then the symbol moves to a new id.
  const rh = createRhLighterState();
  await fetchAnthropicQuote({ now: NOW, rh, fetcher: fetcher({ ...healthy, rh: rhVenue({ id: 38 }) }) });
  const moved = fetcher({ ...healthy, rh: rhVenue({ id: 40 }) });
  assert.equal((await fetchAnthropicQuote({ now: NOW, rh, fetcher: moved })).errors.rh, '合约缺失');
  assert.equal((await fetchAnthropicQuote({ now: NOW, rh, fetcher: moved })).rh!.markPx, 1503.5);
  assert.deepEqual(rhCalls(moved.calls).map(call => call.params), [{ market_id: '38' }, {}]);
  // A single-market answer for another contract is not read as Anthropic.
  const swapped = fetcher({ ...healthy, rh: url => url.searchParams.has('market_id') ? ok({ code: 200, order_book_details: [{ symbol: 'OPENAI', market_id: 40, market_type: 'perp', status: 'active', mark_price: '900' }] }) : rhVenue({ id: 40 })(url) });
  assert.equal((await fetchAnthropicQuote({ now: NOW, rh, fetcher: swapped })).errors.rh, '合约缺失');
  assert.equal(rh.market, null);
});

test('Lighter RH 429 or 405 pauses its quote and candle requests for 60 s without touching other venues', async () => {
  for (const status of [429, 405]) {
    const rh = createRhLighterState(), gate = createBinanceGate();
    const limited = fetcher({ binance: () => ok({ symbol: 'ANTHROPICUSDT', markPrice: '1270' }), hl: () => fail(500), rh: () => fail(status) });
    const first = await fetchAnthropicQuote({ now: NOW, fetcher: limited, rh, gate, clock: () => NOW });
    assert.equal(first.errors.rh, `接口返回 HTTP ${status}`);
    const cooled = await fetchAnthropicQuote({ now: NOW + 59_000, fetcher: limited, rh, gate, clock: () => NOW + 59_000 });
    assert.equal(cooled.errors.rh, `接口限流冷却中（HTTP ${status}）`);
    assert.equal(cooled.binance!.markPx, 1270);
    const candles = await fetchAnthropicCandles(null, { now: NOW + 59_000, fetcher: fetcher({ binance: () => ok([kline(lastClosed, 1270)]), hl: () => fail(500), rh: limited as unknown as (url: URL) => Promise<Response> }), rh, gate, clock: () => NOW + 59_000 });
    assert.equal(candles.metadata.errors.rh, `接口限流冷却中（HTTP ${status}）`);
    assert.equal(rhCalls(limited.calls).length, 1, 'no Lighter RH request inside the cooldown');
    await fetchAnthropicQuote({ now: NOW + 60_000, fetcher: limited, rh, gate, clock: () => NOW + 60_000 });
    assert.equal(rhCalls(limited.calls).length, 2, 'the cooldown ends after 60 s');
  }
});

test('Lighter RH code 23000, as HTTP 400 or inside a 200 body, cools down like a firewall 429', async () => {
  for (const status of [400, 200]) {
    const rh = createRhLighterState(), gate = createBinanceGate();
    const limited = fetcher({ binance: () => ok({ symbol: 'ANTHROPICUSDT', markPrice: '1270' }), hl: () => fail(500), rh: () => ok({ code: 23000, message: 'Too Many Requests' }, status) });
    const first = await fetchAnthropicQuote({ now: NOW, fetcher: limited, rh, gate, clock: () => NOW });
    assert.equal(first.errors.rh, '接口限流冷却中（代码 23000）');
    const cooled = await fetchAnthropicQuote({ now: NOW + 59_000, fetcher: limited, rh, gate, clock: () => NOW + 59_000 });
    assert.equal(cooled.errors.rh, '接口限流冷却中（代码 23000）');
    assert.equal(rhCalls(limited.calls).length, 1, 'no Lighter RH request inside the cooldown');
  }
});

test('a Lighter RH response over 2 MiB is refused, whether announced by Content-Length or only seen while streaming', async () => {
  const binance = () => ok({ symbol: 'ANTHROPICUSDT', markPrice: '1270' });
  const padded = (size: number) => async (url: URL) => { const body = await rhVenue()(url).json() as Record<string, unknown>; return ok({ ...body, pad: 'x'.repeat(size) }); };
  const read = (rh: (url: URL) => Response | Promise<Response>) => fetchAnthropicQuote({ now: NOW, fetcher: fetcher({ binance, hl: () => fail(500), rh }), rh: createRhLighterState(), gate: createBinanceGate(), clock: () => NOW });
  const small = await read(padded(1024 * 1024));
  assert.equal(small.errors.rh, undefined, 'a valid 1 MiB catalog is read');
  const streamed = await read(padded(2 * 1024 * 1024));
  assert.equal(streamed.errors.rh, '响应无效或网络失败', 'the same catalog past 2 MiB is refused');
  assert.equal(streamed.binance!.markPx, 1270);
  let pulls = 0, cancelled = false;
  const announced = () => new Response(new ReadableStream({ pull(controller) { pulls += 1; controller.enqueue(new TextEncoder().encode('{')); }, cancel() { cancelled = true; } }), { status: 200, headers: { 'content-length': String(3 * 1024 * 1024) } });
  const refused = await read(announced);
  assert.equal(refused.errors.rh, '响应无效或网络失败');
  assert.ok(cancelled, 'the announced oversized body is cancelled');
  assert.ok(pulls <= 1, `the body is not read (${pulls} pulls)`);
});

test('Lighter RH candles page forward from the listing, at most four pages a round, and resume from the last close', async () => {
  const rh = createRhLighterState(), listedAt = NOW - 30 * DAY + 7 * 60_000, closedEnd = Math.floor(NOW / BAR) * BAR;
  const venue = fetcher({ binance: () => fail(500), hl: () => fail(500), rh: rhVenue({ listedAt, close: t => 1000 + (t / BAR) % 7 }) });
  const first = await fetchAnthropicCandles(null, { now: NOW, fetcher: venue, rh });
  const pages = rhCalls(venue.calls).filter(call => call.rh === '/api/v1/candles').map(call => call.params!);
  assert.equal(pages.length, 4);
  assert.equal(Number(pages[0]!.start_timestamp), Math.floor(listedAt / BAR) * BAR, 'the backfill starts at the listing, not 50 days back');
  for (const page of pages) {
    assert.equal(Number(page.count_back), (Number(page.end_timestamp) - Number(page.start_timestamp)) / BAR, 'count_back matches the range so a cached answer cannot belong to another range');
    assert.ok(Number(page.end_timestamp) <= closedEnd && Number(page.count_back) <= 500);
  }
  // The listing falls inside a bar, so the venue's first bar is the next one.
  assert.equal(first.data[0]!.time, Math.ceil(listedAt / BAR) * BAR);
  assert.equal(first.data.length, 1999);
  assert.ok(first.data.every(row => row.rh === 1000 + (row.time / BAR) % 7 && row.binance === null));
  assert.deepEqual(first.metadata.errors, { binance: '接口返回 HTTP 500', xyz: '接口返回 HTTP 500', io: '接口返回 HTTP 500' });

  const second = await fetchAnthropicCandles(first, { now: NOW, fetcher: venue, rh });
  const resumed = rhCalls(venue.calls).filter(call => call.rh === '/api/v1/candles').slice(4);
  assert.equal(Number(resumed[0]!.params!.start_timestamp), first.data.at(-1)!.time - 96 * BAR);
  assert.equal(second.data.at(-1)!.time, closedEnd - BAR, 'the open bar is never stored');
  assert.equal(second.data.length, (closedEnd - Math.ceil(listedAt / BAR) * BAR) / BAR, 'no gap between the two rounds');
  assert.equal(rhCalls(venue.calls).filter(call => call.rh === '/api/v1/orderBookDetails').length, 1, 'the market is discovered once');

  const bad = fetcher({ binance: () => ok([kline(lastClosed, 1270)]), hl: () => fail(500), rh: url => url.pathname === '/api/v1/candles' ? ok({ code: 200, r: '15m', c: [{ t: lastClosed + 60_000, c: 1 }] }) : rhVenue()(url) });
  const rejected = await fetchAnthropicCandles(null, { now: NOW, fetcher: bad, rh: createRhLighterState() });
  assert.equal(rejected.metadata.errors.rh, '响应无效或网络失败');
  assert.equal(rejected.data.at(-1)!.binance, 1270, 'an invalid Lighter RH page fails only that leg');
});

test('history saved before the Lighter RH leg validates, gains an empty leg and backfills it', async () => {
  const rows = [0, 1, 2].map(index => ({ time: lastClosed - (2 - index) * BAR, binance: 1270, xyz: 100, io: 1670 }));
  const fetchedAt = new Date(NOW).toISOString();
  const legacy = { status: 'live', metadata: { source: 'Binance + Hyperliquid', symbols: ['ANTHROPICUSDT', 'xyz:ANT', 'io:ANTH'], interval: '15m', timezone: 'UTC', priceBasis: 'Completed 15-minute trade candle closes', fetchedAt, firstObservation: new Date(rows[0]!.time).toISOString(), lastObservation: new Date(rows[2]!.time).toISOString(), rows: 3, errors: { io: '请求超时' } }, data: rows };
  const migrated = validateAnthropicCandles(JSON.parse(JSON.stringify(legacy)));
  assert.deepEqual(migrated.data.map(row => row.rh), [null, null, null]);
  assert.equal(migrated.metadata.source, 'Binance + Hyperliquid + rh-Lighter');
  assert.deepEqual(migrated.metadata.symbols, ['ANTHROPICUSDT', 'xyz:ANT', 'io:ANTH', 'ANTHROPIC']);
  assert.deepEqual(migrated.metadata.errors, { io: '请求超时' });
  assert.equal(anthropicCandleWindow(legacy as unknown as AnthropicCandles, 1).data.length, 3);
  assert.throws(() => validateAnthropicCandles({ ...legacy, metadata: { ...legacy.metadata, symbols: ['ANTHROPICUSDT', 'xyz:ANT'] } }), /source/);
  assert.throws(() => validateAnthropicCandles({ ...legacy, metadata: { ...legacy.metadata, source: 'Binance + Hyperliquid + rh-Lighter' } }), /source/);

  // The workbench reads each round's input back from its store; here it goes through JSON the same way.
  const venue = fetcher({ binance: url => ok([kline(Number(url.searchParams.get('startTime')), 1270)]), hl: body => ok([candle(body.req.coin, lastClosed, body.req.coin === 'io:ANTH' ? 1670 : 100)]), rh: rhVenue({ close: () => 1503 }) });
  const rh = createRhLighterState(), gate = createBinanceGate();
  let next = await fetchAnthropicCandles(JSON.parse(JSON.stringify(legacy)), { now: NOW, fetcher: venue, rh, gate });
  const firstPage = rhCalls(venue.calls).find(call => call.rh === '/api/v1/candles')!;
  assert.equal(Number(firstPage.params!.start_timestamp), Math.floor((NOW - 50 * DAY) / BAR) * BAR, 'the new leg starts from the initial window');
  assert.equal(next.data.at(-1)!.rh, null, 'one round backfills at most four pages');
  for (let round = 0; round < 2; round++) next = await fetchAnthropicCandles(JSON.parse(JSON.stringify(next)), { now: NOW, fetcher: venue, rh, gate });
  assert.deepEqual(next.data.find(row => row.time === rows[0]!.time), { ...rows[0], rh: 1503 });
  assert.equal(next.data.at(-1)!.rh, 1503);
  assert.equal(validateAnthropicCandles(JSON.parse(JSON.stringify(next))).metadata.symbols.length, 4);
});

test('a quote saved before the Lighter RH leg reads that leg as missing', () => {
  const saved = validateAnthropicQuote({ fetchedAt: new Date(NOW).toISOString(), binance: { markPx: 1270 }, xyz: { markPx: 100 }, io: null, errors: { io: '请求超时' } });
  assert.equal(saved.rh, null); assert.equal(saved.errors.rh, '暂无报价');
});
