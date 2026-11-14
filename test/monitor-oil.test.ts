// Monitor M-2a: the oil spread. The vendored workbench module (src/vendor/oil-market.mjs; the cases that need only that
// module are taken from the workbench's tests/oil-spread, oil-intraday and oil-candle-window tests), the quote parser, the
// collector on monitor.sqlite and the two endpoints. Every venue is the stand-in in monitor-fake.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  HISTORY_START, OIL_CANDLE_MS as BAR, createIntradaySnapshot, decimalDifference, fetchCandles, fetchIntradaySnapshot, intradayChartRows, intradayWindow, oilSpread, pairIntradayCandles, validateIntradaySnapshot,
} from '../src/vendor/oil-market.mjs';
import { createMonitorStore, MONITOR_FILE, type MonitorStore } from '../src/monitor/store.ts';
import { CANDLE_STALE_MS, QUOTE_STALE_MS } from '../src/monitor/anthropic.ts';
import { OIL_QUOTE_KEY, createOilMonitor, oilError, parseOilQuote } from '../src/monitor/oil.ts';
import { createBinanceGate } from '../src/vendor/anthropic-market.mjs';
import { parseServiceConfig } from '../src/service/config.ts';
import { monitorSummary } from '../src/service/monitor-config.ts';
import { monitorStatus, monitorViews, openMonitor } from '../src/service/monitor.ts';
import { createExecutorServer } from '../src/http.ts';
import { createHarness } from './harness.ts';
import { fakeAnthropicVenues, fakeOilPrice } from './monitor-fake.ts';

const START = HISTORY_START, DAY = 86_400_000;
const candle = (time: number, close: number) => [time, String(close), String(close), String(close), String(close), '1', time + BAR - 1];
const json = (body: unknown) => Response.json(body);

function referenceDecimalDifference(left: number, right: number): number {
  const parts = (value: number) => {
    const [mantissa, exponent = '0'] = String(value).split('e');
    const [whole, fraction = ''] = mantissa!.split('.');
    return { integer: BigInt(whole! + fraction), scale: fraction.length - Number(exponent) };
  };
  const a = parts(left), b = parts(right), scale = Math.max(0, a.scale, b.scale);
  const difference = a.integer * 10n ** BigInt(scale - a.scale) - b.integer * 10n ** BigInt(scale - b.scale);
  const digits = (difference < 0n ? -difference : difference).toString().padStart(scale + 1, '0');
  return Number((difference < 0n ? '-' : '') + (scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits));
}

test('价差：布伦特 − WTI 按十进制相减，与 BigInt 参考逐位相同；任一腿无效时为空', () => {
  for (const [brent, wti, expected] of [[80, 75, 5], [75, 80, -5], [80, 80, 0], [75.3, 75, 0.3], [70.1, 66.2, 3.9], [74.12, 70.05, 4.07]] as const) assert.equal(oilSpread(brent, wti), expected);
  for (const bad of [null, undefined, 0, -1, NaN, Infinity, '75']) { assert.equal(oilSpread(80, bad), null); assert.equal(oilSpread(bad, 75), null); }
  let seed = 141;
  const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
  const pairs: [number, number][] = [[0.1, 0.2], [0.3, 0.1], [1e-7, 3e-8], [1e21, 1], [Number.MAX_SAFE_INTEGER, 0.5], [Number('123456789.12345678'), 0.00000001], [80, 80], [-1.25, 0.75], [0, 0]];
  for (let i = 0; i < 5_000; i++) {
    const digits = Math.floor(random() * 9);
    pairs.push([Number((random() * 200).toFixed(digits)), Number((random() * 200).toFixed(8 - digits))], [random() * 1e3, random() * 1e3]);
  }
  for (const [left, right] of pairs) assert.ok(Object.is(decimalDifference(left, right), referenceDecimalDifference(left, right)), `${left} - ${right}`);
});

test('K 线配对：同一时段的已收盘价配对，保留缺腿与缺口；格式、重复、未收盘的 K 线拒收', () => {
  const rows = pairIntradayCandles([0, 1, 3, 4].map(i => candle(START + i * BAR, 80 + i)), [0, 3, 4].map(i => candle(START + i * BAR, 70 + i)), START + 4 * BAR);
  assert.deepEqual(rows.map(row => [row.time - START, row.wti]), [[0, 70], [BAR, null], [3 * BAR, 73]]);
  const snapshot = createIntradaySnapshot(rows, new Date(START + 4 * BAR).toISOString());
  assert.deepEqual([snapshot.metadata.pairedObservationRows, snapshot.metadata.missingObservationRows], [2, 2]);
  assert.deepEqual(intradayChartRows(snapshot).map(row => row.time), [START, START + 3 * BAR]);
  for (const [index, value] of [[0, START + 1], [6, START + BAR], [4, ''], [4, 0], [4, 'Infinity']] as const) {
    const bad = candle(START, 80); bad[index] = value;
    assert.throws(() => pairIntradayCandles([bad], [candle(START, 70)], START + BAR + 1));
  }
  assert.throws(() => pairIntradayCandles([candle(START, 80), candle(START, 80)], [candle(START, 70)], START + BAR));
  assert.throws(() => createIntradaySnapshot([{ time: START, brent: 80, wti: 70 }], new Date(START + BAR - 1).toISOString()));
  for (const metadata of [{ source: 'Hyperliquid' }, { currency: 'USD' }, { symbols: ['BZUSDT', 'BTCUSDT'] }, { interval: '1d' }, { pairedObservationRows: 1 }]) {
    assert.throws(() => validateIntradaySnapshot({ ...snapshot, metadata: { ...snapshot.metadata, ...metadata } }));
  }
});

test('K 线分页按实际开盘时间前进，重复页拒收；续读补齐旧缺口、保留旧值、不收未收盘的 K 线；任一腿失败不改动已有数据', async () => {
  const all = Array.from({ length: 5 }, (_, i) => candle(START + i * BAR, 80 + i)), requests: number[] = [];
  const result = await fetchCandles('BZUSDT', '15m', START, START + 5 * BAR, { pageSize: 2, fetcher: async url => {
    const params = new URL(url).searchParams; requests.push(Number(params.get('startTime')));
    return json(all.filter(row => (row[0] as number) >= Number(params.get('startTime'))).slice(0, 2));
  } });
  assert.deepEqual(requests, [START, START + 2 * BAR, START + 4 * BAR]);
  assert.deepEqual(result, all);
  await assert.rejects(fetchCandles('BZUSDT', '15m', START, START + 5 * BAR, { pageSize: 2, fetcher: async () => json(all.slice(0, 2)) }), /pagination/);

  const rows = Array.from({ length: 160 }, (_, i) => ({ time: START + i * BAR, brent: i === 11 ? null : 80, wti: 70 })).filter((_, i) => i !== 10);
  const existing = createIntradaySnapshot(rows, new Date(START + 160 * BAR).toISOString()), before = JSON.stringify(existing), starts: number[] = [];
  const next = await fetchIntradaySnapshot(existing, { now: START + 161 * BAR, fetcher: async url => {
    const params = new URL(url).searchParams; starts.push(Number(params.get('startTime')));
    return json([10, 11, 160, 161].map(i => candle(START + i * BAR, params.get('symbol') === 'BZUSDT' ? 81 : 71)));
  } });
  assert.deepEqual(starts, [START + 10 * BAR, START + 10 * BAR], '从最早的缺口续读');
  assert.equal(next.data.length, 161);
  assert.deepEqual(next.data[0], existing.data[0]);
  assert.deepEqual(next.data[11], { time: START + 11 * BAR, brent: 81, wti: 71 });
  assert.equal(next.metadata.missingObservationRows, 0);
  assert.equal(JSON.stringify(existing), before);
  await assert.rejects(fetchIntradaySnapshot(existing, { now: START + 162 * BAR, fetcher: async url => new URL(url).searchParams.get('symbol') === 'BZUSDT' ? json([candle(START + 161 * BAR, 81)]) : new Response('', { status: 503 }) }));
  assert.equal(JSON.stringify(existing), before);
});

test('K 线窗口：保留最后一根共同 K 线之前若干天，覆盖范围仍是完整历史；窗口大于历史时原样返回', () => {
  const rows = [];
  for (let i = 0; i < 10 * 96; i++) if ((i < 250 || i > 300) && (i < 500 || i > 509)) rows.push({ time: START + i * BAR, brent: 90 + (i % 7) / 10, wti: i >= 955 ? null : 85 });
  const snapshot = { ...createIntradaySnapshot(rows, new Date(START + 10 * DAY).toISOString()), status: 'snapshot' as const };
  const window = intradayWindow(snapshot, 7);
  assert.equal(window.data[0]!.time, START + 301 * BAR, '窗口起点落在缺口里时从缺口后开始');
  assert.equal(window.data.at(-1)!.wti, null, '末尾没配对的 K 线保留');
  assert.deepEqual([window.status, window.windowDays, window.metadata.missingObservationRows], ['snapshot', 7, 10]);
  assert.equal(window.coverage!.pairedObservationRows, snapshot.metadata.pairedObservationRows);
  assert.equal(intradayWindow(snapshot, 400), snapshot);
});

const ticker = (symbol: string, time: number, over: Record<string, unknown> = {}) => ({ symbol, markPrice: symbol === 'BZUSDT' ? '74.12' : '70.05', lastFundingRate: '0.0001', nextFundingTime: time + 3_600_000, time, ...over });
const FUNDING = [{ symbol: 'BZUSDT', fundingIntervalHours: 4 }, { symbol: 'CLUSDT', fundingIntervalHours: 4 }];

test('报价解析：两腿标记价与资金费条款；源时刻过旧、两腿相差超过 15 秒、合约不符时拒收；资金费条款不全时两腿费率都置空', () => {
  const now = Date.UTC(2026, 10, 13, 8);
  const quote = parseOilQuote(ticker('BZUSDT', now - 1000), ticker('CLUSDT', now - 500), FUNDING, now);
  assert.deepEqual(quote, {
    source: 'Binance', currency: 'USDT', fetchedAt: new Date(now - 1000).toISOString(),
    brent: { coin: 'BZUSDT', markPx: 74.12, fundingRate: 0.0001, fundingIntervalHours: 4, nextFundingAt: new Date(now + 3_599_000).toISOString() },
    wti: { coin: 'CLUSDT', markPx: 70.05, fundingRate: 0.0001, fundingIntervalHours: 4, nextFundingAt: new Date(now + 3_599_500).toISOString() },
  });
  assert.equal(oilSpread(quote.brent.markPx, quote.wti.markPx), 4.07);
  const unfunded = parseOilQuote(ticker('BZUSDT', now), ticker('CLUSDT', now), null, now);
  assert.deepEqual([unfunded.brent.fundingRate, unfunded.wti.fundingRate, unfunded.brent.markPx], [null, null, 74.12], 'fundingInfo 读不到：价格照用');
  const partial = parseOilQuote(ticker('BZUSDT', now), ticker('CLUSDT', now, { nextFundingTime: 0 }), FUNDING, now);
  assert.deepEqual([partial.brent.fundingRate, partial.wti.fundingRate], [null, null], '一腿缺下次结算时刻：两腿都不给资金费');
  assert.throws(() => parseOilQuote(ticker('BZUSDT', now - 121_000), ticker('CLUSDT', now), FUNDING, now), /Delayed/);
  assert.throws(() => parseOilQuote(ticker('BZUSDT', now - 16_000), ticker('CLUSDT', now), FUNDING, now), /synchronized/);
  assert.throws(() => parseOilQuote(ticker('CLUSDT', now), ticker('CLUSDT', now), FUNDING, now), /symbol/);
  assert.throws(() => parseOilQuote(ticker('BZUSDT', now, { markPrice: '0' }), ticker('CLUSDT', now), FUNDING, now));
  assert.throws(() => parseOilQuote(ticker('BZUSDT', now), ticker('CLUSDT', now), [...FUNDING, FUNDING[0]], now), /Duplicate/);
  assert.equal(oilError(new Error('Binance HTTP 451')), '服务器所在地区被拒绝访问（HTTP 451）');
  assert.equal(oilError(Object.assign(new Error('x'), { name: 'TimeoutError' })), '请求超时');
});

function oilEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'tp-monitor-oil-'));
  const env = { clock: Date.UTC(2026, 10, 13, 8, 7), logs: [] as string[] };
  const venues = fakeAnthropicVenues({ now: () => env.clock });
  const store = createMonitorStore({ file: join(dir, MONITOR_FILE), now: () => env.clock });
  const gate = createBinanceGate();
  const monitor = (over: { store?: MonitorStore } = {}) => createOilMonitor({ store: over.store ?? store, gate, fetchImpl: venues.fetch, now: () => env.clock, log: line => env.logs.push(line) });
  return Object.assign(env, { dir, venues, store, gate, monitor, dispose: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } });
}

test('采集：首轮从上市起回补；报价超过 35 秒、K 线超过 615 秒标为快照；重启读回为快照，续读只从最后一天读起', async () => {
  const env = oilEnv();
  try {
    const monitor = env.monitor();
    assert.deepEqual([monitor.quote(), monitor.candles(null)], [null, null]);
    await monitor.refreshQuote();
    const quote = monitor.quote()!;
    assert.deepEqual([quote.status, quote.brent.markPx, quote.wti.markPx, quote.brent.fundingIntervalHours, quote.lastError], ['live', fakeOilPrice('brent', env.clock), fakeOilPrice('wti', env.clock), 4, null]);
    env.clock += QUOTE_STALE_MS + 1;
    assert.equal(monitor.quote()!.status, 'snapshot');
    await monitor.refreshCandles();
    const all = monitor.candles(null)!;
    assert.equal(all.status, 'live');
    assert.equal(all.data[0]!.time, Math.ceil((Date.UTC(2026, 10, 13, 8, 7) - 30 * DAY) / BAR) * BAR, '替身行情上市 30 天：首轮全部回补');
    assert.equal(all.metadata.missingObservationRows, 0);
    assert.equal(env.store.oilCandles().length, all.data.length);
    const week = monitor.candles(7)!;
    assert.deepEqual([week.windowDays, week.coverage.pairedObservationRows], [7, all.metadata.pairedObservationRows]);
    assert.ok(week.data.length < all.data.length);
    env.clock += CANDLE_STALE_MS + 1;
    assert.equal(monitor.candles(null)!.status, 'snapshot');

    const restarted = env.monitor();
    assert.deepEqual([restarted.quote()!.status, restarted.candles(null)!.status, restarted.candles(null)!.data.length], ['snapshot', 'snapshot', all.data.length]);
    env.venues.requests.clear();
    const lastStart = all.data.at(-1)!.time;
    const seen: number[] = [];
    const watched = createOilMonitor({ store: env.store, gate: env.gate, now: () => env.clock, log: () => undefined, fetchImpl: async (url, init) => {
      const start = new URL(url).searchParams.get('startTime'); if (start) seen.push(Number(start));
      return env.venues.fetch(url, init);
    } });
    await watched.refreshCandles();
    assert.deepEqual(seen, [lastStart - 96 * BAR, lastStart - 96 * BAR], '续读从最后一根往前 96 根');
    assert.equal(watched.candles(null)!.status, 'live');
  } finally { env.dispose(); }
});

test('采集失败：报价任一腿失败本轮作废并说明原因；资金费读不到只让费率为空；K 线失败保留已存数据；429 后 Binance 冷却与 Anthropic 共用', async () => {
  const env = oilEnv();
  try {
    const monitor = env.monitor();
    await monitor.refreshQuote(); await monitor.refreshCandles();
    const fetchedAt = monitor.quote()!.fetchedAt, rows = monitor.candles(null)!.data.length;
    env.clock += 60_000;
    env.venues.down.add('wti');
    await monitor.refreshQuote(); await monitor.refreshCandles();
    assert.deepEqual([monitor.quote()!.fetchedAt, monitor.quote()!.status, monitor.quote()!.lastError], [fetchedAt, 'snapshot', '接口返回 HTTP 500']);
    assert.deepEqual([monitor.candles(null)!.data.length, monitor.candles(null)!.status, monitor.candles(null)!.lastError], [rows, 'snapshot', 'K 线读取失败：接口返回 HTTP 500']);
    assert.equal(env.logs.filter(line => /原油报价读取失败/.test(line)).length, 1);
    env.venues.down.clear();
    env.venues.down.add('funding');
    await monitor.refreshQuote();
    assert.deepEqual([monitor.quote()!.status, monitor.quote()!.brent.fundingRate, monitor.quote()!.lastError], ['live', null, null]);
    assert.ok(env.logs.some(line => line === '原油报价读取已恢复'));
    env.venues.down.clear();

    env.venues.oilStatus = 429;
    await monitor.refreshQuote();
    assert.ok(env.gate.until > env.clock, '429 开始冷却');
    env.venues.oilStatus = null;
    env.venues.requests.clear();
    await monitor.refreshQuote();
    assert.equal(monitor.quote()!.lastError, '接口限流冷却中（HTTP 429）');
    assert.equal(env.venues.requests.size, 0, '冷却中不发 Binance 请求');
    const { createAnthropicMonitor } = await import('../src/monitor/anthropic.ts');
    const anthropic = createAnthropicMonitor({ store: env.store, gate: env.gate, fetchImpl: env.venues.fetch, now: () => env.clock, log: () => undefined });
    await anthropic.refreshQuote();
    assert.equal(env.venues.requests.get('quote:binance'), undefined, 'Anthropic 的 Binance 腿同样等冷却');
    assert.match(anthropic.quote()!.errors.binance ?? '', /限流冷却/);
    env.clock += 60_001;
    await monitor.refreshQuote();
    assert.deepEqual([monitor.quote()!.status, monitor.quote()!.lastError], ['live', null]);
  } finally { env.dispose(); }
});

test('读回与写入失败：库里的报价无法解析时等新报价；K 线写入失败时内存不前进，下一轮重写', async () => {
  const env = oilEnv();
  try {
    env.store.writeState(OIL_QUOTE_KEY, { source: 'Binance' });
    const monitor = env.monitor();
    assert.equal(monitor.quote(), null);
    assert.ok(env.logs.some(line => /原油上次报价无法读回/.test(line)));
    const failing = { ...env.store, writeOilCandles: () => { throw new Error('disk I/O error'); }, writeState: () => { throw new Error('disk I/O error'); } } as MonitorStore;
    const broken = env.monitor({ store: failing });
    await broken.refreshQuote();
    await broken.refreshCandles();
    assert.equal(broken.quote()!.status, 'live', '报价照常可读，只是没存下');
    assert.equal(broken.candles(null), null);
    assert.equal(broken.status().candleError, 'K 线保存失败：monitor.sqlite 写入失败');
    assert.ok(env.logs.some(line => /原油报价保存失败：monitor\.sqlite 写入失败（disk I\/O error）/.test(line)));
  } finally { env.dispose(); }
});

test('配置与接口：monitor.oil 不带设置；只配原油时 Anthropic 接口 404；原油接口 503 → 200，days 校验同 Anthropic', async () => {
  const secretsFile = '/etc/tp/secrets.json';
  const config = parseServiceConfig({ secretsFile, monitor: { oil: {} } });
  assert.deepEqual([config.monitor, config.pairs], [{ oil: {} }, []]);
  assert.equal(monitorSummary(config.monitor), '，行情监控 原油价差（Binance 布伦特 − WTI）');
  assert.equal(monitorSummary(parseServiceConfig({ secretsFile, monitor: { anthropic: {}, oil: {} } }).monitor), '，行情监控 Anthropic 价差（流通股 12.7 十亿、完全稀释 16.7 十亿股）、原油价差（Binance 布伦特 − WTI）');
  for (const oil of [{ refreshMs: 1 }, null, 1, []]) assert.throws(() => parseServiceConfig({ secretsFile, monitor: { oil } }), /monitor/, JSON.stringify(oil));

  const dir = mkdtempSync(join(tmpdir(), 'tp-monitor-oil-'));
  const venues = fakeAnthropicVenues();
  const runtime = openMonitor(config.monitor!, dir, { fetchImpl: venues.fetch, log: () => undefined });
  const h = createHarness();
  const server = createExecutorServer({ executor: h.ex, accessToken: 'monitor-token-0002', views: { monitor: monitorViews(runtime) } });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const cookie = ((await fetch(`${base}/login?token=monitor-token-0002`, { redirect: 'manual' })).headers.get('set-cookie') ?? '').split(';')[0]!;
    const get = async (path: string) => { const response = await fetch(base + path, { headers: { cookie } }); return { status: response.status, body: await response.json() as Record<string, any> }; };
    assert.equal((await fetch(`${base}/api/monitor/oil/quote`)).status, 401);
    assert.deepEqual(await get('/api/monitor/state'), { status: 200, body: { markets: ['oil'], anthropic: null } });
    for (const path of ['/api/monitor/anthropic/quote', '/api/monitor/anthropic/candles']) assert.deepEqual([(await get(path)).status, (await get(path)).body.message], [404, '本服务没有配置Anthropic行情监控'], path);
    assert.deepEqual([(await get('/api/monitor/oil/quote')).status, (await get('/api/monitor/oil/quote')).body.message], [503, '尚未取得原油报价，后台正在采集']);
    assert.equal((await get('/api/monitor/oil/candles?days=7')).status, 503);
    for (const days of ['0', 'x', '401', '007', '']) assert.equal((await get(`/api/monitor/oil/candles?days=${days}`)).body.code, 'invalid_days', days);
    assert.equal((await get('/api/monitor/hynix/quote')).status, 404);
    await runtime.oil!.refreshQuote();
    await runtime.oil!.refreshCandles();
    const quote = await get('/api/monitor/oil/quote');
    assert.deepEqual([quote.status, quote.body.status, quote.body.brent.coin, quote.body.staleAfterMs], [200, 'live', 'BZUSDT', QUOTE_STALE_MS]);
    const all = (await get('/api/monitor/oil/candles')).body, week = (await get('/api/monitor/oil/candles?days=7')).body;
    assert.deepEqual([all.status, all.windowDays, week.windowDays, week.coverage.pairedObservationRows], ['live', undefined, 7, all.metadata.pairedObservationRows]);
    assert.deepEqual(Object.keys(monitorStatus(runtime)), ['anthropic', 'oil']);
    assert.equal(monitorStatus(runtime).anthropic, null);
    assert.equal(monitorStatus(runtime).oil!.candleRows, all.data.length);
  } finally {
    await new Promise(resolve => server.close(resolve));
    h.dispose();
    runtime.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
