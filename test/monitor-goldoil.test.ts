// Monitor M-2f: the gold/oil ratio. The parsing rules (src/monitor/goldoil-market.ts), the collector on monitor.sqlite
// (src/monitor/goldoil.ts), the two endpoints and their read-only access, the alerts and the page's data helpers
// (web/src/monitor-goldoil.ts). Every venue is the stand-in in monitor-fake.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  GOLDOIL_CANDLE_MS as BAR, GOLDOIL_STALE_MS, goldOilKlinePage, goldOilListing, goldOilWindow, goldOilSnapshot, mergeGoldOilRows, pairGoldOilRows, parseGoldOilQuote,
  validateGoldOilHistory, validateGoldOilQuote,
} from '../src/monitor/goldoil-market.ts';
import { GOLDOIL_CANDLE_KEY, GOLDOIL_QUOTE_KEY, createGoldOilMonitor } from '../src/monitor/goldoil.ts';
import { createOilMonitor } from '../src/monitor/oil.ts';
import { createMarketReaders, type MarketReaders } from '../src/monitor/market-readers.ts';
import { createMonitorData } from '../src/market/monitor-data.ts';
import { createMonitorStore, MONITOR_FILE, type MonitorStore } from '../src/monitor/store.ts';
import { ALERT_SPECS, alertMessage, createAlertService, createTestGate, quoteValues, validateAlertConfig } from '../src/monitor/alerts.ts';
import { createBinanceGate } from '../src/vendor/anthropic-market.mjs';
import { parseServiceConfig } from '../src/service/config.ts';
import { monitorSummary } from '../src/service/monitor-config.ts';
import { monitorStatus, monitorViews, openMonitor } from '../src/service/monitor.ts';
import { createExecutorServer } from '../src/http.ts';
import { readTokenAllows } from '../src/read-token.ts';
import { isDisplayRead } from '../src/read-view.ts';
import { TOOLS, handle } from '../tools/mcp/readonly.ts';
import { goldOilGaps, goldOilHistory, goldOilPoints, goldOilQuote, goldOilStatistics, selectGoldOilRange, withGoldOilBreaks } from '../web/src/monitor-goldoil.ts';
import { ALERT_MARKETS, alertView } from '../web/src/monitor-alerts.ts';
import { createHarness } from './harness.ts';
import { fakeAnthropicVenues, fakeGoldPrice, fakeOilPrice } from './monitor-fake.ts';

const NOW = Date.UTC(2026, 10, 20, 8, 7, 30), DAY = 86_400_000;
const mark = (symbol: string, time: number, markPrice = symbol === 'XAUUSDT' ? '2400.5' : symbol === 'CLUSDT' ? '70.05' : '74.12') => ({ symbol, markPrice, time });
const spec = (symbol: string, baseAsset: string, over: Record<string, unknown> = {}) => ({ symbol, status: 'TRADING', contractType: 'TRADIFI_PERPETUAL', baseAsset, quoteAsset: 'USDT', marginAsset: 'USDT', onboardDate: NOW - 10 * DAY, ...over });
const kline = (time: number, close: number | string = 70) => [time, '1', '1', '1', String(close), '1', time + BAR - 1];

test('合约校验：三个合约各一条、交易中、永续或 TradFi 永续、USDT 计价与保证金；历史起点取较晚上架并向上取整到 15 分钟', () => {
  const late = NOW - 3 * DAY + 7 * 60_000;
  const info = (xau: Record<string, unknown> = {}) => ({ symbols: [spec('BTCUSDT', 'BTC', { contractType: 'PERPETUAL' }), spec('XAUUSDT', 'XAU', xau), spec('CLUSDT', 'CL', { contractType: 'PERPETUAL', onboardDate: late }), spec('BZUSDT', 'BZ')] });
  assert.equal(goldOilListing(info(), NOW), Math.ceil(late / BAR) * BAR);
  assert.equal(goldOilListing(info({ contractType: 'PERPETUAL' }), NOW), Math.ceil(late / BAR) * BAR);
  for (const bad of [{ contractType: 'CURRENT_QUARTER' }, { status: 'SETTLING' }, { baseAsset: 'PAXG' }, { quoteAsset: 'USDC' }, { marginAsset: 'BTC' }]) assert.throws(() => goldOilListing(info(bad), NOW), /Unsupported/, JSON.stringify(bad));
  for (const onboardDate of [0, -1, NOW + 1, 1.5, 'x', null]) assert.throws(() => goldOilListing(info({ onboardDate }), NOW), /listing date/, String(onboardDate));
  const twice = info();
  twice.symbols.push(spec('XAUUSDT', 'XAU'));
  assert.throws(() => goldOilListing(twice, NOW), /Unsupported/);
  assert.throws(() => goldOilListing({ symbols: info().symbols.slice(0, 3) }, NOW), /Unsupported/, '缺 BZUSDT');
  assert.throws(() => goldOilListing({}, NOW), /Missing/);
});

test('报价：三腿标记价，源时间相差超过 15 秒或超过 75 秒的拒收；报价时刻取最早一腿；比值＝XAU ÷ 油', () => {
  const quote = parseGoldOilQuote(mark('XAUUSDT', NOW - 15_000), mark('CLUSDT', NOW), mark('BZUSDT', NOW - 5_000), NOW);
  assert.deepEqual([quote.fetchedAt, quote.xau.price, quote.cl.price, quote.bz.price], [new Date(NOW - 15_000).toISOString(), 2400.5, 70.05, 74.12]);
  assert.throws(() => parseGoldOilQuote(mark('XAUUSDT', NOW - 15_001), mark('CLUSDT', NOW), mark('BZUSDT', NOW), NOW), /not synchronized/);
  assert.throws(() => parseGoldOilQuote(mark('XAUUSDT', NOW - GOLDOIL_STALE_MS - 1), mark('CLUSDT', NOW - GOLDOIL_STALE_MS - 1), mark('BZUSDT', NOW - GOLDOIL_STALE_MS - 1), NOW), /Delayed/);
  assert.equal(parseGoldOilQuote(mark('XAUUSDT', NOW + 5_000), mark('CLUSDT', NOW + 5_000), mark('BZUSDT', NOW + 5_000), NOW).fetchedAt, new Date(NOW + 5_000).toISOString(), '超前 5 秒内照收');
  assert.throws(() => parseGoldOilQuote(mark('XAUUSDT', NOW + 5_001), mark('CLUSDT', NOW), mark('BZUSDT', NOW), NOW), /Delayed/, '超前超过 5 秒拒收（与告警端一致）');
  assert.throws(() => parseGoldOilQuote(mark('CLUSDT', NOW), mark('XAUUSDT', NOW), mark('BZUSDT', NOW), NOW), /unexpected/, '腿与合约对不上');
  for (const price of ['0', '-1', '', 'abc', 'Infinity']) assert.throws(() => parseGoldOilQuote(mark('XAUUSDT', NOW, price), mark('CLUSDT', NOW), mark('BZUSDT', NOW), NOW), /price/, price);
  assert.deepEqual(validateGoldOilQuote(JSON.parse(JSON.stringify(quote))), quote, '保存后可读回');
  assert.throws(() => validateGoldOilQuote({ ...quote, xau: { ...quote.xau, symbol: 'PAXGUSDT' } }), /Unexpected/);
  const page = goldOilQuote({ ...quote, status: 'live', staleAfterMs: GOLDOIL_STALE_MS, lastError: null, ratio: { cl: 1, bz: 1 } });
  assert.deepEqual([page.ratio.cl, page.ratio.bz, page.status], [2400.5 / 70.05, 2400.5 / 74.12, 'live'], '页面按两腿重新计算比值');
});

test('K 线：已收盘 15 分钟标记价，对齐、严格递增、收盘时刻正确、价格为正；三腿按时刻合并，缺腿留空', () => {
  const start = Math.floor(NOW / BAR) * BAR - 4 * BAR, end = start + 4 * BAR;
  assert.deepEqual(goldOilKlinePage([kline(start), kline(start + 2 * BAR, '71.5')], start, end), [[start, 70], [start + 2 * BAR, 71.5]]);
  for (const [name, batch] of [['未对齐', [kline(start + 1)]], ['重复', [kline(start), kline(start)]], ['倒序', [kline(start + BAR), kline(start)]], ['早于起点', [kline(start - BAR)]],
    ['未收盘', [kline(end)]], ['收盘时刻错', [[start, '1', '1', '1', '70', '1', start + BAR]]], ['价格为 0', [kline(start, 0)]], ['列不足', [[start, '1', '1', '1', '70']]]] as const) {
    assert.throws(() => goldOilKlinePage(batch, start, end), /Invalid/, name);
  }
  const rows = pairGoldOilRows([[start, 2400], [start + BAR, 2401]], [[start, 70], [start + 2 * BAR, 71]], [[start + BAR, 74]]);
  assert.deepEqual(rows, [{ time: start, xau: 2400, wti: 70, brent: null }, { time: start + BAR, xau: 2401, wti: null, brent: 74 }, { time: start + 2 * BAR, xau: null, wti: 71, brent: null }]);
  assert.deepEqual(mergeGoldOilRows(rows, [{ time: start, xau: null, wti: null, brent: 75 }]).at(0), { time: start, xau: 2400, wti: 70, brent: 75 }, '后补的一腿不抹掉已有的腿');
  const snapshot = goldOilSnapshot(rows, new Date(end).toISOString(), start)!;
  assert.deepEqual(snapshot.data.map(row => row.time), [start, start + BAR], '只有黄金且至少一条油腿的时段可用');
  assert.equal(validateGoldOilHistory(JSON.parse(JSON.stringify(snapshot))).metadata.observationRows, 2);
  const window = goldOilWindow({ ...snapshot, data: snapshot.data }, 1 / 96);
  assert.deepEqual([window.windowDays, window.data.length, window.coverage!.observationRows], [1 / 96, 2, 2], "整段都在窗口内时同样标明窗口");
  const narrow = goldOilWindow(snapshot, 1 / 192);
  assert.deepEqual([narrow.windowDays, narrow.data.length, narrow.metadata.observationRows, narrow.coverage!.observationRows], [1 / 192, 1, 1, 2]);
});

function goldEnv(listedAt = NOW - 10 * DAY - 7 * 60_000) {
  const dir = mkdtempSync(join(tmpdir(), 'tp-monitor-goldoil-'));
  const env = { clock: NOW, logs: [] as string[] };
  const venues = fakeAnthropicVenues({ now: () => env.clock, listedAt: { xau: listedAt } });
  const store = createMonitorStore({ file: join(dir, MONITOR_FILE), now: () => env.clock });
  const monitor = (over: { store?: MonitorStore } = {}) => createGoldOilMonitor({ store: over.store ?? store, gate: createBinanceGate(), fetchImpl: venues.fetch, now: () => env.clock, log: line => env.logs.push(line) });
  return { env, venues, store, monitor, dispose: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('采集：报价每轮读三腿，时间差超过 15 秒的一轮丢弃并保留上次报价；K 线从三个合约较晚上架起回补，缺口保留', async () => {
  const listedAt = NOW - 10 * DAY - 7 * 60_000;
  const { env, venues, store, monitor, dispose } = goldEnv(listedAt);
  try {
    const collector = monitor();
    assert.deepEqual([collector.quote(), collector.candles(null)], [null, null]);
    await collector.refreshQuote();
    const quote = collector.quote()!;
    assert.deepEqual([quote.status, quote.fetchedAt, quote.xau.price, quote.staleAfterMs], ['live', new Date(NOW).toISOString(), fakeGoldPrice(NOW), GOLDOIL_STALE_MS]);
    assert.equal(quote.ratio.cl, fakeGoldPrice(NOW) / fakeOilPrice('wti', NOW));
    assert.equal(quote.ratio.bz, fakeGoldPrice(NOW) / fakeOilPrice('brent', NOW));
    venues.xauLagMs = 20_000; env.clock += 30_000;
    await collector.refreshQuote();
    assert.deepEqual([collector.quote()!.fetchedAt, collector.quote()!.lastError], [quote.fetchedAt, '三条腿的报价时间相差超过 15 秒，本轮不采用']);
    env.clock += 50_000;
    assert.equal(collector.quote()!.status, 'snapshot', '超过 75 秒视为过期');
    venues.xauLagMs = 10_000;
    await collector.refreshQuote();
    assert.deepEqual([collector.quote()!.status, collector.quote()!.lastError, collector.quote()!.fetchedAt], ['live', null, new Date(env.clock - 10_000).toISOString()]);

    const first = Math.ceil(listedAt / BAR) * BAR, lastClosed = Math.floor(env.clock / BAR) * BAR - BAR;
    venues.goldOilMissing.add(`xau:${first + BAR}`).add(`wti:${first + 2 * BAR}`);
    await collector.refreshCandles();
    const all = collector.candles(null)!;
    assert.deepEqual([all.status, all.data[0]!.time, all.data.at(-1)!.time, all.metadata.listedAt, all.lastError], ['live', first, lastClosed, new Date(first).toISOString(), null]);
    assert.ok(!all.data.some(row => row.time === first + BAR), '缺黄金的时段不进图');
    assert.deepEqual(all.data.find(row => row.time === first + 2 * BAR), { time: first + 2 * BAR, xau: fakeGoldPrice(first + 2 * BAR), wti: null, brent: fakeOilPrice('brent', first + 2 * BAR) });
    assert.equal(store.goldOilCandles().length, all.data.length + 1, "缺黄金的时段照存油腿，读出时不进图");
    assert.equal(venues.requests.get('goldoil:catalog'), 1, '合约信息缓存 5 分钟');
    const day = collector.candles(1)!;
    assert.deepEqual([day.windowDays, day.coverage.observationRows, day.data.length], [1, all.data.length, 97]);

    // Restarted on the same file: both read back as saved snapshots until a round succeeds.
    const again = monitor();
    assert.deepEqual([again.quote()!.status, again.candles(null)!.status, again.candles(null)!.data.length], ['snapshot', 'snapshot', all.data.length]);
    assert.ok(store.readState(GOLDOIL_QUOTE_KEY) && store.readState(GOLDOIL_CANDLE_KEY));
    env.clock += 60_000;
    await again.refreshCandles();
    assert.equal(again.candles(null)!.status, 'live');

    venues.xauContractType = 'CURRENT_QUARTER';
    const refused = monitor();
    await refused.refreshCandles();
    assert.match(refused.status().candleError!, /^合约信息读取失败：合约类型、状态或计价资产不符/);
    assert.equal(refused.candles(null)!.status, 'snapshot', '合约不符时保留已存历史');
    venues.xauContractType = 'PERPETUAL';
    const perpetual = monitor();
    await perpetual.refreshCandles();
    assert.equal(perpetual.status().candleError, null, 'PERPETUAL 同样接受');
  } finally { dispose(); }
});

test('配置与接口：monitor.goldoil 不带设置；未配置 404，首轮前 503，之后 200；只读令牌与 MCP 只放行告警记录', async () => {
  const secretsFile = '/etc/tp/secrets.json';
  const config = parseServiceConfig({ secretsFile, monitor: { goldoil: {} } });
  assert.deepEqual(config.monitor, { goldoil: {} });
  assert.equal(monitorSummary(config.monitor), '，行情监控 金油比（Binance XAU ÷ WTI / 布伦特）');
  for (const goldoil of [{ refreshMs: 1 }, null, 1, []]) assert.throws(() => parseServiceConfig({ secretsFile, monitor: { goldoil } }), /monitor/, JSON.stringify(goldoil));

  const dir = mkdtempSync(join(tmpdir(), 'tp-monitor-goldoil-http-'));
  const clock = { now: NOW };
  const venues = fakeAnthropicVenues({ now: () => clock.now });
  const runtime = openMonitor(config.monitor!, dir, { fetchImpl: venues.fetch, now: () => clock.now, log: () => undefined,
    alertHooks: { notify: () => 1, delivery: () => new Map(), robot: () => 'feishu' as const, test: async () => undefined } });
  const h = createHarness();
  const server = createExecutorServer({ executor: h.ex, accessToken: 'monitor-token-0003', views: { monitor: monitorViews(runtime) } });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const cookie = ((await fetch(`${base}/login?token=monitor-token-0003`, { redirect: 'manual' })).headers.get('set-cookie') ?? '').split(';')[0]!;
    const get = async (path: string) => { const response = await fetch(base + path, { headers: { cookie } }); return { status: response.status, body: await response.json() as Record<string, any> }; };
    assert.equal((await fetch(`${base}/api/monitor/goldoil/quote`)).status, 401);
    assert.deepEqual((await get('/api/monitor/state')).body.markets, ['goldoil']);
    assert.deepEqual([(await get('/api/monitor/oil/quote')).status, (await get('/api/monitor/goldoil/quote')).body.message], [404, '尚未取得金油比报价，后台正在采集']);
    assert.equal((await get('/api/monitor/goldoil/candles?days=7')).status, 503);
    for (const days of ['0', 'x', '401', '007', '']) assert.equal((await get(`/api/monitor/goldoil/candles?days=${days}`)).body.code, 'invalid_days', days);
    await runtime.goldoil!.refreshQuote();
    await runtime.goldoil!.refreshCandles();
    const quote = await get('/api/monitor/goldoil/quote');
    assert.deepEqual([quote.status, quote.body.status, quote.body.xau.symbol, quote.body.cl.symbol, quote.body.bz.symbol], [200, 'live', 'XAUUSDT', 'CLUSDT', 'BZUSDT']);
    const all = (await get('/api/monitor/goldoil/candles')).body, week = (await get('/api/monitor/goldoil/candles?days=7')).body;
    assert.deepEqual([all.status, all.windowDays, week.windowDays, week.coverage.observationRows], ['live', undefined, 7, all.metadata.observationRows]);
    assert.equal(goldOilHistory(week).windowDays, 7, '页面校验通过');
    const update = (await get('/api/monitor/goldoil/candles?days=7&known=')).body;
    assert.deepEqual([update.first, update.header.windowDays, 'data' in update.header], [week.data[0].time, 7, false]);
    assert.deepEqual(Object.keys(monitorStatus(runtime)), ['anthropic', 'oil', 'goldoil', 'hynix', 'perpetual', 'controls', 'alerts']);
    assert.equal((await get('/api/monitor/goldoil/alerts')).body.market, 'goldoil');
    const off = await fetch(`${base}/api/monitor/goldoil/control`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-pa-executor': '1' }, body: JSON.stringify({ enabled: false, revision: 0 }) });
    assert.equal(off.status, 200);
    assert.deepEqual([(await get('/api/monitor/goldoil/quote')).status, (await get('/api/monitor/goldoil/quote')).body.message], [423, '金油比监控已关闭，行情采集与自动告警已暂停；开启后恢复']);
  } finally {
    await new Promise(resolve => server.close(resolve));
    h.dispose();
    runtime.store.close();
    rmSync(dir, { recursive: true, force: true });
  }

  assert.ok(readTokenAllows(new URL('http://x/api/monitor/goldoil/alerts')));
  for (const path of ['/api/monitor/goldoil/quote', '/api/monitor/goldoil/candles', '/api/monitor/goldoil/alerts/test', '/api/monitor/goldoil/control']) assert.equal(readTokenAllows(new URL(`http://x${path}`)), false, path);
  assert.ok(readTokenAllows(new URL('http://x/api/monitor/oil/alerts')) && !readTokenAllows(new URL('http://x/api/monitor/oil/quote')), '与原油一致');
  assert.ok(isDisplayRead('GET', '/api/monitor/goldoil/quote'));
  const tool = TOOLS.find(item => item.name === 'monitor')!;
  assert.deepEqual((tool.inputSchema as { properties: { market: { enum: string[] } } }).properties.market.enum, ['oil', 'goldoil', 'hynix']);
  const paths: string[] = [];
  await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'monitor', arguments: {} } }, async path => { paths.push(path); return {}; });
  assert.deepEqual(paths, ['/api/monitor/oil/alerts', '/api/monitor/goldoil/alerts', '/api/monitor/hynix/alerts', '/api/monitor/state']);
});

test('告警：XAU / CL 与 XAU / BZ 两个指标，阈值须大于 0；只判 75 秒内的实时报价；飞书文案列出两腿与比值', () => {
  const spec = ALERT_SPECS.goldoil;
  assert.deepEqual([Object.keys(spec.metrics), spec.maxRules, spec.maxAgeMs], [['clRatio', 'bzRatio'], 50, 75_000]);
  const rule = { id: 'r1', label: '金油比 50', metric: 'clRatio', operator: 'gte', threshold: 50, cooldownMinutes: 30, hysteresis: 0.5, enabled: true };
  assert.equal(validateAlertConfig('goldoil', { enabled: true, rules: [rule] }).rules[0]!.metric, 'clRatio');
  for (const threshold of [0, -1, 1e6 + 1]) assert.throws(() => validateAlertConfig('goldoil', { enabled: true, rules: [{ ...rule, threshold }] }), /invalid|阈值|须/, String(threshold));
  assert.throws(() => validateAlertConfig('goldoil', { enabled: true, rules: [{ ...rule, metric: 'spread' }] }));
  const quote = (at: number, status = 'live') => ({ status, fetchedAt: new Date(at).toISOString(), xau: { price: 2400 }, cl: { price: 48 }, bz: { price: 50 } });
  const judged = quoteValues('goldoil', quote(NOW - 75_000), NOW);
  assert.ok('values' in judged);
  assert.deepEqual(judged.values, { clRatio: 50, bzRatio: 48 });
  assert.match((quoteValues('goldoil', quote(NOW - 75_001), NOW) as { reason: string }).reason, /过期/);
  assert.match((quoteValues('goldoil', quote(NOW, 'snapshot'), NOW) as { reason: string }).reason, /过期/);
  assert.match((quoteValues('goldoil', { ...quote(NOW), bz: { price: 0 } }, NOW) as { reason: string }).reason, /价格无效/);
  const text = alertMessage('goldoil', [{ rule: { ...rule, operator: 'gte' }, operator: 'gte', value: 50 }], judged.quote, judged.fetchedAt);
  assert.equal(text, `【金油比阈值告警】金油比 50：金油比 XAU / CL 50.0000 ≥ 50 桶/盎司\n黄金 2400.00 USDT/盎司 · WTI 48.0000 · 布伦特 50.0000 USDT/桶 · XAU/CL 50.0000 · XAU/BZ 48.0000 桶/盎司（Binance XAUUSDT / CLUSDT / BZUSDT 永续标记价，金油比＝XAU ÷ 油，报价时刻 ${judged.fetchedAt}）`);

  // The service end to end: a crossing is queued once, with the live quote it was judged on.
  const dir = mkdtempSync(join(tmpdir(), 'tp-goldoil-alerts-'));
  const clock = { now: NOW };
  const store = createMonitorStore({ file: join(dir, MONITOR_FILE), now: () => clock.now });
  const sent: string[] = [];
  let current: unknown = quote(NOW);
  try {
    const service = createAlertService({ market: 'goldoil', store, quote: () => current, gate: createTestGate(() => clock.now), now: () => clock.now, log: () => undefined,
      hooks: { notify: text => { sent.push(text); return sent.length; }, delivery: () => new Map(), robot: () => 'feishu', test: async () => undefined } });
    assert.deepEqual(service.view().config, { enabled: false, rules: [] });
    service.update({ revision: service.view().revision, config: { enabled: true, rules: [rule, { ...rule, id: 'r2', label: 'BZ 60', metric: 'bzRatio', threshold: 60 }] } });
    service.check();
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /^【金油比阈值告警】金油比 50：金油比 XAU \/ CL 50\.0000 ≥ 50 桶\/盎司\n/);
    clock.now += 10_000; current = quote(clock.now);
    service.check();
    assert.equal(sent.length, 1, '持续越线不重复');
    clock.now += 80_000;
    service.check();
    assert.match(service.view().error ?? '', /过期/, '报价超过 75 秒不判断');
    const view = alertView(JSON.parse(JSON.stringify(service.view())));
    assert.deepEqual([view.market, view.values], ['goldoil', { xau: 2400, wti: 48, brent: 50, clRatio: 50, bzRatio: 48 }]);
    assert.match(ALERT_MARKETS.goldoil.market(view.values), /XAU \/ CL 50\.0000 · XAU \/ BZ 48\.0000 桶\/盎司/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('页面数据：按油腿取比值，缺腿断线；区间统计与缺口；抽样后缺口仍断开', () => {
  const t0 = Math.floor(NOW / BAR) * BAR - 10 * BAR;
  const data = [0, 1, 2, 5, 6].map(i => ({ time: t0 + i * BAR, xau: 2400 + i, wti: i === 1 ? null : 60, brent: 50 }));
  const history = goldOilHistory(JSON.parse(JSON.stringify(goldOilSnapshot(data, new Date(t0 + 8 * BAR).toISOString(), t0)!)));
  const cl = goldOilPoints(history, 'cl'), bz = goldOilPoints(history, 'bz');
  assert.deepEqual(cl.map(point => point.ratio), [40, null, 2402 / 60, 2405 / 60, 2406 / 60]);
  assert.equal(bz[1]!.ratio, 2401 / 50);
  const stats = goldOilStatistics(cl)!;
  assert.deepEqual([stats.count, stats.first.ratio, stats.last.ratio, stats.min.ratio, stats.max.time], [4, 40, 2406 / 60, 40, t0 + 6 * BAR]);
  assert.equal(stats.change, 2406 / 60 - 40);
  assert.deepEqual(goldOilGaps(cl), { gaps: 2, missing: 3 }, '比值为空的时段与缺失的时刻都算缺失');
  assert.deepEqual(goldOilGaps(bz), { gaps: 1, missing: 2 });
  assert.deepEqual(goldOilGaps([{ ...cl[0]!, ratio: null }, cl[2]!, { ...cl[4]!, ratio: null }]), { gaps: 2, missing: 6 }, '首尾为空同样计入（t0–t1、t3–t6）');
  assert.deepEqual(goldOilGaps([]), { gaps: 0, missing: 0 });
  assert.deepEqual(selectGoldOilRange(cl, 1).length, 5);
  assert.equal(goldOilStatistics([]), null);
  const sampled = [cl[0]!, cl[2]!, cl[4]!];
  assert.deepEqual(withGoldOilBreaks(sampled, cl).map(point => [point.time - t0, point.ratio === null]), [[0, false], [2 * BAR, false], [3 * BAR, true], [6 * BAR, false]]);
});

test('失败：429 后原油与金油比共用 Binance 冷却，冷却结束后都恢复；合约目录读不到时报价同样失败并给中文原因', async () => {
  const { env, venues, store, dispose } = goldEnv();
  try {
    const gate = createBinanceGate();
    const gold = createGoldOilMonitor({ store, gate, fetchImpl: venues.fetch, now: () => env.clock, log: () => undefined });
    const oil = createOilMonitor({ store, gate, fetchImpl: venues.fetch, now: () => env.clock, log: () => undefined });
    venues.down.add('catalog');
    await gold.refreshQuote();
    assert.deepEqual([gold.quote(), gold.status().quoteError], [null, '接口返回 HTTP 500'], '合约目录失败时不读报价');
    assert.equal(venues.requests.get('goldoil:quote:xau'), undefined);
    venues.down.clear();
    venues.oilStatus = 429;
    await gold.refreshQuote();
    assert.ok(gate.until > env.clock, '429 开始冷却');
    venues.oilStatus = null;
    venues.requests.clear();
    await gold.refreshQuote();
    await oil.refreshQuote();
    await gold.refreshCandles();
    assert.equal(gold.status().quoteError, '接口限流冷却中（HTTP 429）');
    assert.equal(oil.quote(), null);
    assert.match(gold.status().candleError ?? '', /限流冷却/);
    assert.equal(venues.requests.size, 0, '冷却中原油与金油比都不发 Binance 请求');
    env.clock = gate.until + 1;
    await gold.refreshQuote();
    await oil.refreshQuote();
    assert.deepEqual([gold.quote()!.status, gold.status().quoteError, oil.quote()!.status], ['live', null, 'live']);
  } finally { dispose(); }
});

test('失败：K 线写库失败时同一段重试；中途读取失败时已写的段与续读位置保留，重启后从断点续读', async () => {
  const listedAt = NOW - 30 * DAY;
  const { env, venues, store, dispose } = goldEnv(listedAt);
  try {
    const readers = createMarketReaders({ fetchImpl: venues.fetch, now: () => env.clock });
    const starts: number[] = [];
    let failRead = -1;
    const counting: MarketReaders = { ...readers, goldOilCandles: (start, end, signal) => {
      starts.push(start);
      return starts.length === failRead ? Promise.reject(new Error('HTTP 500')) : readers.goldOilCandles(start, end, signal);
    } };
    const writes: number[] = [];
    let failWrite = -1;
    const flaky = Object.assign(Object.create(store) as MonitorStore, { writeGoldOilCandles: (write: Parameters<MonitorStore['writeGoldOilCandles']>[0]) => {
      writes.push(write.rows[0]!.time);
      if (writes.length === failWrite) throw new Error('disk full');
      return store.writeGoldOilCandles(write);
    } });
    const collector = (over: MonitorStore = flaky) => createGoldOilMonitor({ store: over, gate: createBinanceGate(), readers: counting, now: () => env.clock, log: () => undefined });
    const first = Math.ceil(listedAt / BAR) * BAR, second = first + 14 * DAY;

    failWrite = 2;
    const writer = collector();
    await writer.refreshCandles();
    assert.deepEqual([writes, writer.status().candleError], [[first, second], 'K 线保存失败：monitor.sqlite 写入失败']);
    assert.equal(store.goldOilCandles().at(-1)!.time, second - BAR, '第一段已保存');
    failWrite = -1;
    await writer.refreshCandles();
    assert.equal(writes[2], second, '写库失败的那一段原样重试');
    assert.deepEqual([writer.status().candleError, writer.candles(null)!.data.at(-1)!.time], [null, Math.floor(env.clock / BAR) * BAR - BAR]);

    // Read failure half way, on a fresh file: the first segment and its resume cursor stay; a restart resumes there.
    const dir = mkdtempSync(join(tmpdir(), 'tp-goldoil-resume-'));
    const other = createMonitorStore({ file: join(dir, MONITOR_FILE), now: () => env.clock });
    try {
      starts.length = 0; failRead = 2;
      const reader = collector(other);
      await reader.refreshCandles();
      assert.deepEqual([starts, reader.status().candleError], [[first, second], 'K 线读取失败：接口返回 HTTP 500']);
      assert.equal(other.goldOilCandles().at(-1)!.time, second - BAR);
      assert.equal((other.readState(GOLDOIL_CANDLE_KEY)!.value as { resumeAt: number }).resumeAt, second);
      starts.length = 0; failRead = -1;
      await collector(other).refreshCandles();
      assert.equal(starts[0], second, '重启后从断点续读，不重读第一段');
    } finally { other.close(); rmSync(dir, { recursive: true, force: true }); }
  } finally { dispose(); }
});

test('读取：合约目录在途请求合并；K 线按区间大小设 limit；进程间 K 线读取拒绝未对齐、超过 14 天与超过当前时刻的范围', async () => {
  const { env, venues, dispose } = goldEnv();
  const limits: string[] = [];
  const fetchImpl = ((url: string | URL, init?: RequestInit) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === '/fapi/v1/markPriceKlines') limits.push(parsed.searchParams.get('limit')!);
    return venues.fetch(String(url), init);
  }) as typeof venues.fetch;
  try {
    const readers = createMarketReaders({ fetchImpl, now: () => env.clock });
    const signal = new AbortController().signal;
    const end = Math.floor(env.clock / BAR) * BAR;
    const [listing, quote, rows] = await Promise.all([readers.goldOilListing(signal), readers.goldOilQuote(signal), readers.goldOilCandles(end - DAY, end, signal)]);
    assert.equal(venues.requests.get('goldoil:catalog'), 1, '报价与 K 线同时读合约目录只发一次');
    assert.deepEqual([typeof listing, quote.xau.symbol, rows.length], ['number', 'XAUUSDT', 96]);
    assert.deepEqual(limits, ['96', '96', '96'], '一天 96 根，三腿各一页');

    // The first caller gives up while the shared catalog read is in flight: it returns early, the second still gets the catalog.
    const late = createMarketReaders({ fetchImpl, now: () => env.clock });
    let release!: () => void;
    venues.hold = new Promise<void>(resolve => { release = resolve; });
    venues.requests.clear();
    const quitting = new AbortController();
    const first = late.goldOilListing(quitting.signal), second = late.goldOilListing(signal);
    quitting.abort(new Error('caller gone'));
    await assert.rejects(first, /caller gone/);
    venues.hold = null; release();
    assert.equal(await second, listing, '第一个调用方中止不影响第二个');
    assert.equal(venues.requests.get('goldoil:catalog'), 1);

    const data = createMonitorData({ fetchImpl, now: () => env.clock, log: () => undefined });
    try {
      const call = async (input: unknown) => await data.call('monitor.goldoil.candles', input, signal) as { ok: boolean; error?: { message: string }; value?: unknown[] };
      assert.match((await call({ start: end - DAY + 1, end })).error!.message, /金油比 K 线范围无效/, '未对齐');
      assert.match((await call({ start: end - 14 * DAY - BAR, end })).error!.message, /金油比 K 线回补范围无效/, '超过 14 天');
      assert.match((await call({ start: end - DAY, end: end + BAR })).error!.message, /金油比 K 线回补范围无效/, '超过当前时刻');
      assert.match((await call({ start: end, end })).error!.message, /金油比 K 线回补范围无效/, '空范围');
      assert.match((await call({ start: end - DAY, end, extra: 1 })).error!.message, /./, '多余字段');
      const ok = await call({ start: end - 14 * DAY, end });
      assert.deepEqual([ok.ok, ok.value!.length], [true, 14 * 96]);
    } finally { data.close?.(); }
  } finally { dispose(); }
});
