// Monitor M-2b: the Hynix ADR premium. The vendored workbench rules (src/vendor/hynix-market.mjs), the collector on
// monitor.sqlite, the two endpoints and the page's data rules. Every venue is the stand-in in monitor-fake.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  FIRST_FULL_HOUR, HYNIX_CANDLE_MS as HOUR, alignHynixCandles, fetchHynixCandles, hynixCandleStart, parseHynixMids, validateHynixQuote, validateHynixRows,
} from '../src/vendor/hynix-market.mjs';
import { createMonitorStore, MONITOR_FILE, type MonitorStore } from '../src/monitor/store.ts';
import { CANDLE_STALE_MS, QUOTE_STALE_MS } from '../src/monitor/anthropic.ts';
import { HYNIX_CANDLE_KEY, HYNIX_GAP_RETRY_MS, HYNIX_QUOTE_KEY, createHynixMonitor, hynixError } from '../src/monitor/hynix.ts';
import { parseServiceConfig } from '../src/service/config.ts';
import { monitorSummary } from '../src/service/monitor-config.ts';
import { monitorStatus, monitorViews, openMonitor } from '../src/service/monitor.ts';
import { createExecutorServer } from '../src/http.ts';
import { HYNIX_SPREAD_CHART, coversHynixRange, hynixHistory, hynixQuote } from '../web/src/monitor-hynix.ts';
import { createHarness } from './harness.ts';
import { fakeAnthropicVenues, fakeHynixPrice } from './monitor-fake.ts';

const DAY = 86_400_000;
const candle = (coin: string, t: number, close: number) => ({ t, T: t + HOUR - 1, s: coin, i: '1h', o: '1', h: '1', l: '1', c: String(close), v: '1', n: 1 });
const plain = (rows: readonly { time: number; adr: number; ordinary: number }[]) => rows.map(({ time, adr, ordinary }) => ({ time, adr, ordinary }));
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`);

test('报价与换算：ADR 对正股 ÷ 10 的价差与溢价率；缺腿、非正数、非对象拒收；读回时按两腿价格重算', () => {
  const quote = parseHynixMids({ 'xyz:SKHY': '24.15', 'xyz:SKHX': '230', other: '1' }, Date.UTC(2026, 10, 13));
  assert.deepEqual([quote.source, quote.adr, quote.ordinary, quote.equivalent, quote.fetchedAt], ['Hyperliquid', 24.15, 230, 23, '2026-11-13T00:00:00.000Z']);
  close(quote.spread, 1.15); close(quote.premium, 5);
  for (const bad of [null, [], 'x', { 'xyz:SKHY': '24' }, { 'xyz:SKHY': 24.15, 'xyz:SKHX': '230' }, { 'xyz:SKHY': true, 'xyz:SKHX': '230' }, { 'xyz:SKHY': '0', 'xyz:SKHX': '230' }, { 'xyz:SKHY': 'NaN', 'xyz:SKHX': '230' }, { 'xyz:SKHY': '-1', 'xyz:SKHX': '230' }]) assert.throws(() => parseHynixMids(bad, 0), JSON.stringify(bad));
  assert.deepEqual(validateHynixQuote({ ...quote, spread: 99, premium: 99 }), quote, '换算字段按价格重算');
  for (const bad of [{ ...quote, source: 'Binance' }, { ...quote, fetchedAt: 'x' }, { ...quote, adr: '24.15' }, { ...quote, ordinary: 0 }]) assert.throws(() => validateHynixQuote(bad));
});

test('K 线配对与续读起点：只配同一已收盘整点，上市首个整点之前与未收盘的不收；续读从最后一小时前 48 小时，整轮补读从最早缺口，不早于接口保留的 5000 根', async () => {
  const t0 = FIRST_FULL_HOUR, now = t0 + 5 * HOUR + 1;
  const ordinary = [-1, 0, 1, 2, 4, 5].map(i => candle('xyz:SKHX', t0 + i * HOUR, 230 + i));
  const adr = [-1, 0, 2, 3, 4, 5].map(i => candle('xyz:SKHY', t0 + i * HOUR, 24 + i));
  assert.deepEqual(alignHynixCandles(ordinary, adr, now), [0, 2, 4].map(i => ({ time: t0 + i * HOUR, adr: 24 + i, ordinary: 230 + i })), '缺腿、上市前、未收盘的整点都不收');
  assert.deepEqual(alignHynixCandles([candle('xyz:SKHX', t0 + 1, 230)], [candle('xyz:SKHY', t0 + 1, 24)], now), [], '非整点不收');
  const early = (coin: string, t: number) => ({ ...candle(coin, t, 230), T: t + 60_000 });
  assert.deepEqual(alignHynixCandles([early('xyz:SKHX', t0 + 5 * HOUR)], [early('xyz:SKHY', t0 + 5 * HOUR)], now), [], '收盘时刻提前也要等整点过完');

  const rows = [0, 1, 3, 4, 100].map(i => ({ time: t0 + i * HOUR, adr: 24, ordinary: 230 }));
  const at = t0 + 101 * HOUR + 5;
  assert.equal(hynixCandleStart([], at, false), t0, '首次从上市首个整点');
  assert.equal(hynixCandleStart(rows, at, false), t0 + 52 * HOUR, '续读：最后一小时前 48 小时');
  assert.equal(hynixCandleStart(rows, at, true), t0 + 2 * HOUR, '整轮：从最早缺口');
  assert.equal(hynixCandleStart(rows.slice(1), at, true), t0, '缺第一小时也算缺口');
  const late = t0 + 6000 * HOUR + 5;
  assert.equal(hynixCandleStart([], late, true), t0 + 1001 * HOUR, '不早于最近 5000 根');
  assert.equal(hynixCandleStart(rows, late, true), t0 + 1001 * HOUR);
  const recent = [1001, 1002, 1100].map(i => ({ time: t0 + i * HOUR, adr: 24, ordinary: 230 }));
  assert.equal(hynixCandleStart([rows[0]!, ...recent], late, true), t0 + 1003 * HOUR, '下限之前的缺口读不回来，只在下限之后找缺口');

  // The ADR leg answers correctly; only the ordinary leg's reply is broken, so each rule is what rejects it.
  const reply = (bad: unknown) => async (_url: string, init: RequestInit) => {
    const coin = (JSON.parse(String(init.body)) as { req: { coin: string } }).req.coin;
    return Response.json(coin === 'xyz:SKHY' ? [candle('xyz:SKHY', t0, 24)] : bad);
  };
  assert.deepEqual(await fetchHynixCandles(t0, { fetcher: reply([candle('xyz:SKHX', t0, 230)]), now }), [{ time: t0, adr: 24, ordinary: 230 }]);
  for (const bad of [[], [{ ...candle('xyz:SKHX', t0, 230), i: '15m' }], [candle('xyz:SKHY', t0, 230)], [{ ...candle('xyz:SKHX', t0, 230), T: t0 + HOUR }], [{ ...candle('xyz:SKHX', t0, 230), T: t0 - 1 }], [candle('xyz:SKHX', t0, 0)], [candle('xyz:SKHX', t0, Number.NaN)], {}]) {
    await assert.rejects(fetchHynixCandles(t0, { fetcher: reply(bad), now }), /Unexpected candle response/, JSON.stringify(bad));
  }
  let call = 0;
  const oneSided = async () => Response.json(call++ === 0 ? [candle('xyz:SKHX', t0, 230)] : [candle('xyz:SKHY', t0 + HOUR, 24)]);
  await assert.rejects(fetchHynixCandles(t0, { fetcher: oneSided, now }), /No shared closed candles/);
  await assert.rejects(fetchHynixCandles(t0, { fetcher: async () => new Response('{}', { status: 429 }), now }), /Hyperliquid HTTP 429/);

  const fetchedAt = new Date(t0 + 3 * HOUR).toISOString();
  assert.deepEqual(validateHynixRows(rows.slice(0, 2), fetchedAt), rows.slice(0, 2));
  for (const bad of [[rows[1], rows[0]], [rows[0], rows[0]], [{ ...rows[0], time: t0 + 1 }], [{ ...rows[0], time: t0 - HOUR }], [rows[3]], [{ ...rows[0], adr: null }], 'x']) assert.throws(() => validateHynixRows(bad, fetchedAt), JSON.stringify(bad));
  assert.equal(hynixError(new Error('Hyperliquid HTTP 429')), '接口限流（HTTP 429）');
  assert.equal(hynixError(Object.assign(new Error('x'), { name: 'TimeoutError' })), '请求超时');
  assert.equal(hynixError(new Error('Unexpected candle response <html>')), '响应无效或网络失败');
});

function hynixEnv(listedAt?: number) {
  const dir = mkdtempSync(join(tmpdir(), 'tp-monitor-hynix-'));
  const env = { clock: Date.UTC(2026, 10, 13, 8, 7), logs: [] as string[] };
  const venues = fakeAnthropicVenues({ now: () => env.clock, ...(listedAt === undefined ? {} : { listedAt: { skhy: listedAt, skhx: listedAt } }) });
  const store = createMonitorStore({ file: join(dir, MONITOR_FILE), now: () => env.clock });
  const starts: number[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { type: string; req?: { startTime: number } };
    if (body.type === 'candleSnapshot') starts.push(body.req!.startTime);
    return venues.fetch(url, init);
  };
  const monitor = (over: { store?: MonitorStore } = {}) => createHynixMonitor({ store: over.store ?? store, fetchImpl, now: () => env.clock, log: line => env.logs.push(line) });
  return Object.assign(env, { dir, venues, store, starts, monitor, dispose: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } });
}

test('采集：首轮从上市首个整点读起（替身上市 30 天）；报价超过 35 秒、K 线超过 615 秒标为快照；重启读回为快照，续读只从最后 48 小时读起', async () => {
  const env = hynixEnv();
  try {
    const monitor = env.monitor();
    assert.deepEqual([monitor.quote(), monitor.candles(null)], [null, null]);
    await monitor.refreshQuote();
    const quote = monitor.quote()!;
    assert.deepEqual([quote.status, quote.adr, quote.ordinary, quote.fetchedAt, quote.staleAfterMs, quote.lastError], ['live', fakeHynixPrice('skhy', env.clock), fakeHynixPrice('skhx', env.clock), new Date(env.clock).toISOString(), QUOTE_STALE_MS, null]);
    close(quote.equivalent, quote.ordinary / 10);
    env.clock += QUOTE_STALE_MS + 1;
    assert.equal(monitor.quote()!.status, 'snapshot');

    await monitor.refreshCandles();
    assert.deepEqual(env.starts, [FIRST_FULL_HOUR, FIRST_FULL_HOUR]);
    const all = monitor.candles(null)!;
    const listed = Math.ceil((Date.UTC(2026, 10, 13, 8, 7) - 30 * DAY) / HOUR) * HOUR, lastHour = Math.floor(env.clock / HOUR) * HOUR - HOUR;
    assert.deepEqual([all.status, all.rows[0]!.time, all.rows.at(-1)!.time, all.rows.length, all.windowDays], ['live', listed, lastHour, (lastHour - listed) / HOUR + 1, undefined]);
    assert.deepEqual(all.coverage, { firstObservation: new Date(listed).toISOString(), lastObservation: new Date(lastHour).toISOString(), rows: all.rows.length });
    assert.deepEqual(plain(env.store.hynixCandles()), plain(all.rows));
    const week = monitor.candles(7)!;
    assert.deepEqual([week.windowDays, week.rows[0]!.time, week.coverage], [7, lastHour - 7 * DAY, all.coverage]);
    env.clock += CANDLE_STALE_MS + 1;
    assert.equal(monitor.candles(null)!.status, 'snapshot');

    const restarted = env.monitor();
    assert.deepEqual([restarted.quote()!.status, restarted.candles(null)!.status, restarted.candles(null)!.rows.length], ['snapshot', 'snapshot', all.rows.length]);
    env.starts.length = 0;
    env.clock += 2 * HOUR;
    await restarted.refreshCandles();
    // The stand-in lists 30 days back, later than the real first hour, so the hours before it count as missing.
    assert.deepEqual(env.starts, [FIRST_FULL_HOUR, FIRST_FULL_HOUR], '启动后第一轮整轮补读：从最早缺口（上市首个整点）读起');
    env.starts.length = 0;
    env.clock += 60_000;
    await restarted.refreshCandles();
    const last = restarted.candles(null)!.rows.at(-1)!.time;
    assert.deepEqual(env.starts, [last - 48 * HOUR, last - 48 * HOUR], '之后续读从最后一小时前 48 小时');
    assert.deepEqual([restarted.candles(null)!.status, restarted.candles(null)!.rows.length], ['live', all.rows.length + 2]);
  } finally { env.dispose(); }
});

test('采集失败：报价失败本轮作废并说明原因（日志只记一次，恢复记一次）；K 线任一腿失败保留已存数据；429 说明限流', async () => {
  const env = hynixEnv();
  try {
    const monitor = env.monitor();
    await monitor.refreshQuote(); await monitor.refreshCandles();
    const fetchedAt = monitor.quote()!.fetchedAt, rows = monitor.candles(null)!.rows.length;
    env.clock += 60_000;
    env.venues.down.add('skhy');
    await monitor.refreshQuote(); await monitor.refreshQuote(); await monitor.refreshCandles();
    assert.deepEqual([monitor.quote()!.fetchedAt, monitor.quote()!.lastError], [fetchedAt, '接口返回 HTTP 500']);
    env.clock += QUOTE_STALE_MS;
    assert.equal(monitor.quote()!.status, 'snapshot');
    assert.deepEqual([monitor.candles(null)!.rows.length, monitor.candles(null)!.status, monitor.candles(null)!.lastError], [rows, 'snapshot', 'K 线读取失败：接口返回 HTTP 500']);
    assert.equal(env.logs.filter(line => /海力士报价读取失败/.test(line)).length, 1);
    env.venues.down.clear();
    env.venues.hynixStatus = 429;
    await monitor.refreshQuote();
    assert.equal(monitor.quote()!.lastError, '接口限流（HTTP 429）');
    env.venues.hynixStatus = null;
    await monitor.refreshQuote(); await monitor.refreshCandles();
    assert.deepEqual([monitor.quote()!.status, monitor.quote()!.lastError, monitor.candles(null)!.status, monitor.candles(null)!.lastError], ['live', null, 'live', null]);
    assert.equal(env.logs.filter(line => line === '海力士报价读取已恢复').length, 1);
    assert.ok(env.logs.includes('海力士K 线读取已恢复'));
    assert.ok(env.logs.includes('海力士K 线读取失败：接口返回 HTTP 500（Hyperliquid HTTP 500）'), '日志不重复“K 线读取失败”');
    assert.deepEqual(monitor.status(), { quoteAt: monitor.quote()!.fetchedAt, quoteError: null, candlesAt: monitor.candles(null)!.fetchedAt, candleRows: rows, candleError: null, fundingAt: null, fundingRows: 0, fundingError: null });
  } finally { env.dispose(); }
});

test('读回与写入失败：库里的报价无法解析时等新报价；K 线写入失败时内存不前进，下一轮补写；K 线读回失败时下一轮整表重写', async () => {
  const env = hynixEnv();
  try {
    env.store.writeState(HYNIX_QUOTE_KEY, { source: 'Hyperliquid' });
    const monitor = env.monitor();
    assert.equal(monitor.quote(), null);
    assert.ok(env.logs.some(line => /海力士上次报价无法读回/.test(line)));
    let failing = false;
    const flaky = { ...env.store,
      writeHynixCandles: (write: Parameters<MonitorStore['writeHynixCandles']>[0]) => { if (failing) throw new Error('disk I/O error'); return env.store.writeHynixCandles(write); },
      writeState: (key: string, value: unknown) => { if (failing) throw new Error('disk I/O error'); return env.store.writeState(key, value); },
    } as MonitorStore;
    const collector = env.monitor({ store: flaky });
    await collector.refreshCandles();
    const before = collector.candles(null)!.rows.length;
    env.clock += 2 * HOUR;
    failing = true;
    await collector.refreshQuote();
    await collector.refreshCandles();
    assert.equal(collector.quote()!.status, 'live', '报价照常可读，只是没存下');
    assert.equal(collector.candles(null)!.rows.length, before, '写入失败：内存不前进');
    assert.equal(collector.status().candleError, 'K 线保存失败：monitor.sqlite 写入失败');
    assert.ok(env.logs.some(line => /海力士报价保存失败：monitor\.sqlite 写入失败（disk I\/O error）/.test(line)));
    failing = false;
    env.clock += 60_000;
    await collector.refreshCandles();
    const rows = collector.candles(null)!.rows;
    assert.equal(rows.length, before + 2, '下一轮把没存下的 K 线一起写入');
    assert.deepEqual(plain(env.store.hynixCandles()), plain(rows));

    // A row the stand-in never serves (it lists 30 days back) and a changed price: only a full rewrite removes both.
    const [first, ...rest] = env.store.hynixCandles();
    env.store.writeHynixCandles({ rows: [{ time: FIRST_FULL_HOUR, adr: 1, ordinary: 1 }, { ...first!, adr: first!.adr + 1 }], cutoff: FIRST_FULL_HOUR, replace: false, state: { key: HYNIX_CANDLE_KEY, value: {} } });
    assert.equal(env.store.hynixCandles().length, rest.length + 2);
    const reread = env.monitor();
    assert.equal(reread.candles(null), null);
    assert.ok(env.logs.some(line => /海力士 K 线历史无法读回，将重新回补/.test(line)));
    await reread.refreshCandles();
    assert.deepEqual(plain(env.store.hynixCandles()), plain(reread.candles(null)!.rows));
    assert.ok(!env.store.hynixCandles().some(row => row.time === FIRST_FULL_HOUR), '库里多出的行被整表重写清掉');
    assert.equal(env.store.hynixCandles()[0]!.adr, first!.adr, '改过的价格被覆盖');
    assert.equal(reread.candles(null)!.status, 'live');
  } finally { env.dispose(); }
});

test('永久缺口：没有成交的整点不让每轮都从缺口处读起，每小时补读一次', async () => {
  const env = hynixEnv(FIRST_FULL_HOUR);
  try {
    const gap = Math.floor(env.clock / HOUR) * HOUR - 10 * DAY;
    env.venues.hynixMissing.add(gap);
    const collector = env.monitor();
    await collector.refreshCandles();
    assert.ok(!collector.candles(null)!.rows.some(row => row.time === gap));
    env.starts.length = 0;
    env.clock += 60_000;
    await collector.refreshCandles();
    const last = collector.candles(null)!.rows.at(-1)!.time;
    assert.deepEqual(env.starts, [last - 48 * HOUR, last - 48 * HOUR], '一小时内只续读最后 48 小时');
    env.starts.length = 0;
    env.clock += HYNIX_GAP_RETRY_MS;
    await collector.refreshCandles();
    assert.deepEqual(env.starts, [gap, gap], '满一小时从缺口处补读');
    env.starts.length = 0;
    env.clock += 60_000;
    await collector.refreshCandles();
    const after = collector.candles(null)!.rows.at(-1)!.time;
    assert.deepEqual(env.starts, [after - 48 * HOUR, after - 48 * HOUR]);
  } finally { env.dispose(); }
});

test('永久缺口：补读那一轮写入失败时，下一轮照样从缺口补读', async () => {
  const env = hynixEnv(FIRST_FULL_HOUR);
  try {
    const gap = Math.floor(env.clock / HOUR) * HOUR - 10 * DAY;
    env.venues.hynixMissing.add(gap);
    let failing = false;
    const flaky = { ...env.store, writeHynixCandles: (write: Parameters<MonitorStore['writeHynixCandles']>[0]) => { if (failing) throw new Error('disk I/O error'); return env.store.writeHynixCandles(write); } } as MonitorStore;
    const collector = env.monitor({ store: flaky });
    await collector.refreshCandles();
    env.clock += HYNIX_GAP_RETRY_MS;
    failing = true;
    env.starts.length = 0;
    await collector.refreshCandles();
    assert.deepEqual(env.starts, [gap, gap]);
    failing = false;
    env.starts.length = 0;
    env.clock += 60_000;
    await collector.refreshCandles();
    assert.deepEqual(env.starts, [gap, gap], '没存下的补读轮不算数');
    assert.equal(collector.status().candleError, null);
  } finally { env.dispose(); }
});

test('配置与接口：monitor.hynix 不带设置；只配海力士时其他市场 404；海力士接口 503 → 200，days 窗口与覆盖范围', async () => {
  const secretsFile = '/etc/tp/secrets.json';
  const config = parseServiceConfig({ secretsFile, monitor: { hynix: {} } });
  assert.deepEqual(config.monitor, { hynix: {} });
  assert.equal(monitorSummary(config.monitor), '，行情监控 海力士溢价（Hyperliquid SKHY / SKHX）');
  for (const hynix of [{ refreshMs: 1 }, null, 1, []]) assert.throws(() => parseServiceConfig({ secretsFile, monitor: { hynix } }), /monitor\.hynix 无效/, JSON.stringify(hynix));

  const dir = mkdtempSync(join(tmpdir(), 'tp-monitor-hynix-'));
  const venues = fakeAnthropicVenues();
  const runtime = openMonitor(config.monitor!, dir, { fetchImpl: venues.fetch, log: () => undefined });
  const h = createHarness();
  const server = createExecutorServer({ executor: h.ex, accessToken: 'monitor-token-0003', views: { monitor: monitorViews(runtime) } });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const cookie = ((await fetch(`${base}/login?token=monitor-token-0003`, { redirect: 'manual' })).headers.get('set-cookie') ?? '').split(';')[0]!;
    const get = async (path: string) => { const response = await fetch(base + path, { headers: { cookie } }); return { status: response.status, body: await response.json() as Record<string, any> }; };
    assert.equal((await fetch(`${base}/api/monitor/hynix/quote`)).status, 401);
    assert.deepEqual(await get('/api/monitor/state'), { status: 200, body: { markets: ['hynix'], anthropic: null } });
    assert.deepEqual([(await get('/api/monitor/oil/candles?days=x')).status, (await get('/api/monitor/oil/quote')).body.message], [404, '本服务没有配置原油行情监控']);
    assert.deepEqual([(await get('/api/monitor/hynix/quote')).status, (await get('/api/monitor/hynix/quote')).body.message], [503, '尚未取得海力士报价，后台正在采集']);
    assert.equal((await get('/api/monitor/hynix/candles?days=7')).status, 503);
    for (const days of ['0', 'x', '401']) assert.equal((await get(`/api/monitor/hynix/candles?days=${days}`)).body.code, 'invalid_days', days);
    await runtime.hynix!.refreshQuote();
    await runtime.hynix!.refreshCandles();
    const quote = await get('/api/monitor/hynix/quote');
    assert.deepEqual([quote.status, quote.body.status, quote.body.source], [200, 'live', 'Hyperliquid']);
    const all = (await get('/api/monitor/hynix/candles')).body, week = (await get('/api/monitor/hynix/candles?days=7')).body;
    assert.deepEqual([all.status, all.windowDays, week.windowDays, week.coverage], ['live', undefined, 7, all.coverage]);
    // The page's rules accept what the service sends.
    assert.equal(hynixHistory(all).points.length, all.rows.length);
    assert.equal(hynixHistory(week).windowDays, 7);
    assert.equal(hynixQuote(quote.body).status, 'live');
    assert.deepEqual(Object.keys(monitorStatus(runtime)), ['anthropic', 'oil', 'hynix']);
    assert.deepEqual([monitorStatus(runtime).oil, monitorStatus(runtime).hynix!.candleRows], [null, all.rows.length]);
  } finally {
    await new Promise(resolve => server.close(resolve));
    h.dispose();
    runtime.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('页面数据规则：K 线换算为溢价率与价差；缺口与过时提示照工作台；覆盖范围须与窗口一致；窗口够大才沿用旧读数', () => {
  const t0 = FIRST_FULL_HOUR, fetchedAt = new Date(t0 + 10 * HOUR).toISOString();
  const rows = [0, 1, 4].map(i => ({ time: t0 + i * HOUR, adr: 24.15, ordinary: 230 + i * 0 }));
  const coverage = { firstObservation: new Date(t0).toISOString(), lastObservation: new Date(t0 + 4 * HOUR).toISOString(), rows: 3 };
  const history = hynixHistory({ rows, fetchedAt, status: 'live', coverage, lastError: null }, t0 + 5 * HOUR);
  assert.deepEqual([history.points.length, history.points[0]!.equivalent, history.status, history.windowDays, history.warnings], [3, 23, 'live', null, ['历史行情存在 1 处缺口，图表保留断点；区间均值仅基于可用时段。']]);
  close(history.points[0]!.premium, 5); close(history.points[0]!.spread, 1.15);
  assert.deepEqual(hynixHistory({ rows, fetchedAt, status: 'snapshot', coverage, lastError: 'K 线读取失败：请求超时' }, t0 + 8 * HOUR).warnings.at(-1), '最近一个共同小时距今超过 2 小时，请留意行情时间。');
  assert.equal(hynixHistory({ rows, fetchedAt, status: 'snapshot', coverage, lastError: 'K 线读取失败：请求超时' }).lastError, 'K 线读取失败：请求超时');
  for (const bad of [
    { rows, fetchedAt, coverage: { ...coverage, rows: 4 } },
    { rows, fetchedAt, coverage: { ...coverage, lastObservation: fetchedAt } },
    { rows, fetchedAt, coverage: { ...coverage, firstObservation: new Date(t0 + HOUR).toISOString() } },
    { rows: [], fetchedAt, coverage },
    { rows, fetchedAt, coverage, windowDays: 0 },
    { rows, coverage },
  ]) assert.throws(() => hynixHistory(bad), JSON.stringify(bad));
  const windowed = hynixHistory({ rows: rows.slice(1), fetchedAt, status: 'live', windowDays: 28, coverage });
  assert.deepEqual([windowed.windowDays, windowed.coverage.rows], [28, 3]);
  assert.deepEqual([coversHynixRange(windowed, 7), coversHynixRange(windowed, 30), coversHynixRange(windowed, null), coversHynixRange(history, 30)], [true, false, false, true]);
  assert.throws(() => hynixQuote({ source: 'Hyperliquid', fetchedAt, adr: 1 }));
  assert.deepEqual([HYNIX_SPREAD_CHART.modes, HYNIX_SPREAD_CHART.intervalMs, HYNIX_SPREAD_CHART.tick.premium!(1.234)], [['premium', 'spread', 'price'], HOUR, '1.23%']);
});
