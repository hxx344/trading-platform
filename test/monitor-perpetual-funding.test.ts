// Monitor M-5b2: the workbench's settled funding-history service and scanner-data summary inside the perpetual collector,
// their cache table and routes. The services' own rules are the workbench's tests (test/perpetual/{funding-history,
// funding-reader,funding-cex,scanner-data}.test.mjs); these cover what this service adds: running state, the switch, the
// cache across restarts, the write-back at stop and the two routes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import { PerpetualInspectionError, createPerpetualMonitor, type PerpetualOptions } from '../src/monitor/perpetual.ts';
import { PERPETUAL_CACHE_FILE, openPerpetualCache } from '../src/monitor/perpetual-cache.ts';
import type { PerpetualContractCacheEntry } from '../src/vendor/perpetual-market-metrics-service.mjs';
import type { PerpetualUpdate } from '../src/vendor/perpetual-stream.mjs';
import { fundingWindowTotal, type PerpetualFundingHistoryReport } from '../src/vendor/perpetual-funding-history.ts';
import { scannerDataPairKey, type PerpetualScannerDataReport } from '../src/vendor/perpetual-scanner-data.ts';
import { parseServiceConfig } from '../src/service/config.ts';
import { closeMonitor, monitorViews, openMonitor, settleMonitor } from '../src/service/monitor.ts';
import { createExecutorServer } from '../src/http.ts';
import { createHarness } from './harness.ts';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 1500; i++) { if (await check()) return; await sleep(4); }
  assert.fail(`等待超时：${what}`);
}
const HOUR = 3_600_000;

/** Binance and Bybit with one BTCUSDT quote each; their 8-hourly settled funding, metrics and tickers answered from memory. */
function venues() {
  const requests: string[] = [];
  class FakeSocket {
    readyState = 0; binaryType = 'blob';
    readonly listeners = new Map<string, ((event: { data: unknown }) => void)[]>();
    constructor(url: string) {
      setTimeout(() => {
        this.readyState = 1; this.emit('open');
        const exchange = url.includes('binance') ? 'binance' : 'bybit', mid = exchange === 'binance' ? 100.5 : 102.5;
        this.emit('message', JSON.stringify({ updates: [{ exchange, symbol: 'BTCUSDT', base: 'BTC', quoteCurrency: 'USDT', bid: mid - 0.5, ask: mid + 0.5, mark: mid, fundingRate: 0.0001, fundingIntervalHours: 8 }] }));
      }, 0);
    }
    addEventListener(type: string, listener: (event: { data: unknown }) => void): void { this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]); }
    emit(type: string, data?: unknown): void { for (const listener of this.listeners.get(type) ?? []) listener({ data }); }
    send(): void { /* Subscriptions are not checked here. */ }
    close(): void { this.readyState = 3; }
  }
  const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  const times = (from: number, to: number) => { const list: number[] = []; for (let time = Math.ceil(from / (8 * HOUR)) * 8 * HOUR; time <= to; time += 8 * HOUR) list.push(time); return list; };
  // Long Binance settles 0.01 % each time, short Bybit 0.03 %: the net carry is positive.
  const fundingFetch = async (input: string) => {
    requests.push(input);
    const url = new URL(input), params = url.searchParams, now = Date.now(), limit = Number(params.get('limit'));
    if (url.hostname === 'fapi.binance.com' && url.pathname === '/fapi/v1/fundingRate') {
      return json(times(Number(params.get('startTime')), Math.min(now, Number(params.get('endTime')))).slice(0, limit).map(time => ({ symbol: 'BTCUSDT', fundingTime: time, fundingRate: '0.0001' })));
    }
    if (url.hostname === 'api.bybit.com' && url.pathname === '/v5/market/funding/history') {
      const end = Math.min(now, Number(params.get('endTime')));
      const list = times(end - limit * 8 * HOUR, end).reverse().slice(0, limit).map(time => ({ symbol: 'BTCUSDT', fundingRateTimestamp: String(time), fundingRate: '0.0003' }));
      return json({ retCode: 0, result: { category: 'linear', list } });
    }
    throw new Error('offline');
  };
  const metricsFetch = async (url: string) => {
    const now = Date.now();
    if (url.startsWith('https://fapi.binance.com/fapi/v1/ticker/24hr')) return json([{ symbol: 'BTCUSDT', quoteVolume: '1234567', closeTime: now }]);
    if (url.startsWith('https://fapi.binance.com/futures/data/openInterestHist')) return json([{ symbol: 'BTCUSDT', sumOpenInterestValue: '890000', timestamp: now }]);
    if (url.startsWith('https://api.bybit.com/v5/market/tickers')) return json({ retCode: 0, time: now, result: { list: [{ symbol: 'BTCUSDT', turnover24h: '765432', singleOpenInterestValue: '345678' }] } });
    throw new Error('offline');
  };
  const options: PerpetualOptions = {
    exchanges: [{ id: 'binance', name: 'Binance', kind: 'cex' }, { id: 'bybit', name: 'Bybit', kind: 'cex' }],
    discover: async exchange => [{ id: `${exchange}:BTCUSDT`, exchange, symbol: 'BTCUSDT', base: 'BTC', quoteCurrency: 'USDT', multiplier: 1, delisting: false, delistingAt: null }],
    subscriptions: (exchange, markets) => [{ url: `wss://${exchange}.test/ws`, markets, subscribe: [], sendIntervalMs: 1 }],
    parse: ((_exchange: string, payload: unknown) => (payload as { updates?: PerpetualUpdate[] }).updates ?? []) as PerpetualOptions['parse'],
    control: (() => null) as PerpetualOptions['control'],
    WebSocketImpl: FakeSocket, fetchImpl: async () => { throw new Error('offline'); },
    metrics: { fetchImpl: metricsFetch as never, intervalMs: 10 },
    fundingHistory: { fetchImpl: fundingFetch as never },
    retryMs: 20, observationIntervalMs: 5, broadcastIntervalMs: 15, log: () => undefined,
  };
  return { options, requests };
}
const pair = { base: 'BTC', longKey: 'binance:BTCUSDT', shortKey: 'bybit:BTCUSDT' };
const pairs = { pairs: [pair] };
const day = (report: PerpetualFundingHistoryReport) => fundingWindowTotal(report.legs[pair.longKey], report.legs[pair.shortKey], 24, Date.now());
const historyReady = (report: PerpetualFundingHistoryReport) => report.legs[pair.longKey]?.status === 'ready' && report.legs[pair.shortKey]?.status === 'ready';
const refused = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { assert.ok(error instanceof PerpetualInspectionError); return [error.status, error.message]; } assert.fail('应当拒绝'); };

test('采集器：运行时读历史资金费；未运行 503，组合无效 400；停止时写回缓存，新开的采集器先给缓存里的结算', async () => {
  const { options, requests } = venues();
  const saved = new Map<string, PerpetualContractCacheEntry>();
  const cache = {
    loadContractMetrics: () => [], saveContractMetrics: () => undefined,
    loadFundingHistory: (key?: string) => key === undefined ? [...saved.values()] : saved.has(key) ? [saved.get(key)!] : [],
    saveFundingHistory: (entry: PerpetualContractCacheEntry) => { saved.set(entry.key, structuredClone(entry)); },
  };
  const first = createPerpetualMonitor({ ...options, cache });
  let second: ReturnType<typeof createPerpetualMonitor> | null = null;
  try {
    assert.deepEqual(await refused(first.fundingHistory(pairs)), [503, '合约价差采集未运行，开启后再读取历史资金费']);
    first.start();
    await until(() => first.snapshot().quotes.length === 2, '两腿报价');
    assert.equal((await refused(first.fundingHistory({ pairs: 'x' })))[0], 400);
    assert.equal((await refused(first.fundingHistory({ pairs: [{ ...pair, shortKey: 'okx:BTCUSDT' }] })))[0], 400, '没有报价的腿');
    assert.equal((await refused(first.fundingHistory({ pairs: Array.from({ length: 31 }, () => pair) })))[0], 400, '至多 30 个组合');
    const pending = await first.fundingHistory(pairs);
    assert.deepEqual(Object.keys(pending.legs).sort(), [pair.longKey, pair.shortKey], '两腿都登记');
    await until(async () => historyReady(await first.fundingHistory(pairs)), '两腿历史就绪');
    const total = day(await first.fundingHistory(pairs));
    assert.equal(total.status, 'ready');
    assert.ok(total.longCount >= 2 && total.shortCount >= 2, '24 小时内至少两次结算');
    assert.ok(Math.abs(total.netPercent! - (total.shortCount * 0.03 - total.longCount * 0.01)) < 1e-9, '净累计 = 空腿 − 多腿');
    first.stop();
    await first.settled();
    assert.deepEqual([...saved.keys()].sort(), [pair.longKey, pair.shortKey], '停止时写回两腿');
    assert.equal((await refused(first.fundingHistory(pairs)))[0], 503, '停止后');
    // The restored legs still owe a backfill that the next 1-second tick sends; it hangs until stop aborts it, so the
    // cached records stay readable as ready however slow this machine is.
    const hang = (_url: unknown, init?: { signal?: AbortSignal }) => new Promise<never>((_, reject) => { init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)); });
    second = createPerpetualMonitor({ ...venues().options, fundingHistory: { fetchImpl: hang as unknown as typeof fetch }, cache });
    second.start();
    await until(() => second!.snapshot().quotes.length === 2, '新采集器两腿报价');
    const restored = await second.fundingHistory(pairs);
    assert.ok(historyReady(restored), '缓存里的结算直接可读');
    assert.equal(day(restored).netPercent, total.netPercent);
    assert.ok(requests.length > 0);
  } finally {
    first.stop(); second?.stop();
    await Promise.all([first.settled(), second?.settled()]);
  }
});

test('采集器：scanner-data 给全部候选组合的指标与净累计；未运行 503，参数无效 400；缓存库不可用时两个接口都带提示', async () => {
  const unavailable = '缓存库 perpetual-cache.sqlite 打不开，只存内存';
  const perpetual = createPerpetualMonitor({ ...venues().options, cacheUnavailable: unavailable });
  const request = { ...pairs, metrics: true, historyHours: [24] };
  try {
    assert.deepEqual(await refused(perpetual.scannerData(request)), [503, '合约价差采集未运行，开启后再读取筛选数据']);
    perpetual.start();
    await until(() => perpetual.snapshot().quotes.length === 2, '两腿报价');
    assert.equal((await refused(perpetual.scannerData({ ...request, historyHours: [5] })))[0], 400, '只认 24/72/168/720 小时');
    assert.equal((await refused(perpetual.scannerData({ ...request, pairs: [{ ...pair, longKey: 'binance:ETHUSDT' }] })))[0], 400, '没有报价的腿');
    const ready = (report: PerpetualScannerDataReport) => report.metrics[pair.longKey]?.status === 'ready' && report.metrics[pair.shortKey]?.status === 'ready'
      && report.history[scannerDataPairKey(pair)]?.[24]?.status === 'ready';
    await until(async () => ready(await perpetual.scannerData(request)), '指标与历史就绪');
    const report = await perpetual.scannerData(request);
    assert.equal(report.metrics[pair.longKey]!.volume24h.value, 1234567);
    assert.equal(report.metrics[pair.shortKey]!.openInterest.value, 345678);
    const net = report.history[scannerDataPairKey(pair)]![24]!.netPercent!;
    assert.ok(net > 0, '空腿费率高于多腿，净累计为正');
    const bare = await perpetual.scannerData({ pairs: [], metrics: false, historyHours: [] });
    assert.deepEqual([bare.metrics, bare.history].map(value => Object.keys(value).length), [0, 0], '空请求不读取');
    assert.equal(report.storageError, unavailable, 'scanner-data 带只存内存的提示');
    assert.equal((await perpetual.fundingHistory(pairs)).storageError, unavailable, 'funding-history 带只存内存的提示');
  } finally { perpetual.stop(); await perpetual.settled(); }
});

test('缓存库：历史资金费单独一张表，重开后读回，坏行按缺失处理', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-perpetual-funding-cache-'));
  const file = join(dir, PERPETUAL_CACHE_FILE);
  const entry = { key: 'binance:BTCUSDT', lastAccessAt: 2000, value: { status: 'ready', records: [{ time: 1, rate: 0.0001 }] } };
  let cache = openPerpetualCache(file);
  try {
    cache.saveFundingHistory(entry);
    cache.saveContractMetrics({ key: 'binance:BTCUSDT', lastAccessAt: 1, value: {} });
    cache.close();
    cache = openPerpetualCache(file);
    assert.deepEqual(cache.loadFundingHistory('binance:BTCUSDT'), [entry]);
    assert.deepEqual(cache.loadContractMetrics('binance:BTCUSDT').map(item => item.lastAccessAt), [1], '两张表互不覆盖');
    const inspection = new DatabaseSync(file);
    try { inspection.prepare('UPDATE funding_history_cache SET payload=? WHERE id=?').run(Buffer.from('corrupt'), 'binance:BTCUSDT'); } finally { inspection.close(); }
    assert.deepEqual(cache.loadFundingHistory(), [], '坏行不返回');
    assert.throws(() => cache.saveFundingHistory({ ...entry, key: '' }), /Invalid/);
  } finally { cache.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('接口：funding-history 与 scanner-data 用 POST；须登录与页面请求标记；未运行 503，无效 400，未配置 404，关闭后 423', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-perpetual-funding-'));
  const config = parseServiceConfig({ secretsFile: '/etc/tp/secrets.json', monitor: { hynix: {}, perpetual: {} } }).monitor!;
  const runtime = openMonitor(config, dir, { fetchImpl: async () => { throw new Error('offline'); }, log: () => undefined, perpetualOptions: venues().options });
  const bareDir = mkdtempSync(join(tmpdir(), 'tp-perpetual-funding-bare-'));
  const bare = openMonitor(parseServiceConfig({ secretsFile: '/etc/tp/secrets.json', monitor: { hynix: {} } }).monitor!, bareDir, { fetchImpl: async () => { throw new Error('offline'); }, log: () => undefined });
  const h = createHarness();
  const servers = [runtime, bare].map(item => createExecutorServer({ executor: h.ex, accessToken: 'perpetual-token-0001', views: { monitor: monitorViews(item) } }));
  const scanner = { ...pairs, metrics: false, historyHours: [24] };
  try {
    const urls: string[] = [];
    for (const server of servers) { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); urls.push(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
    const login = async (url: string) => ((await fetch(`${url}/login?token=perpetual-token-0001`, { redirect: 'manual' })).headers.get('set-cookie') ?? '').split(';')[0]!;
    const cookies = [await login(urls[0]!), await login(urls[1]!)];
    const call = async (index: number, route: string, payload?: unknown, marker = true) => {
      const response = await fetch(`${urls[index]}/api/monitor/perpetual/${route}`, payload === undefined ? { headers: { cookie: cookies[index]! } } : { method: 'POST', headers: { cookie: cookies[index]!, ...(marker ? { 'x-pa-executor': '1' } : {}), 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    for (const [route, body] of [['funding-history', pairs], ['scanner-data', scanner]] as const) {
      assert.equal((await fetch(`${urls[0]}/api/monitor/perpetual/${route}`, { method: 'POST', headers: { 'x-pa-executor': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) })).status, 401, `${route} 须登录`);
      assert.equal((await call(0, route, body, false)).status, 403, `${route} 须带页面请求标记`);
      assert.equal((await call(0, route)).status, 404, `${route} 不接受 GET`);
      assert.equal((await call(1, route, body)).status, 404, `${route} 未配置合约价差`);
    }
    assert.deepEqual(await call(0, 'funding-history', pairs), { status: 503, body: { code: 'unavailable', message: '合约价差采集未运行，开启后再读取历史资金费' } });
    assert.deepEqual(await call(0, 'scanner-data', scanner), { status: 503, body: { code: 'unavailable', message: '合约价差采集未运行，开启后再读取筛选数据' } });
    runtime.perpetual!.start();
    await until(() => runtime.perpetual!.snapshot().quotes.length === 2, '两腿报价');
    await until(async () => { const answer = await call(0, 'funding-history', pairs); return answer.status === 200 && historyReady(answer.body as PerpetualFundingHistoryReport); }, '接口给出两腿历史');
    await until(async () => { const answer = await call(0, 'scanner-data', scanner); return answer.status === 200 && (answer.body as PerpetualScannerDataReport).history[scannerDataPairKey(pair)]?.[24]?.status === 'ready'; }, '接口给出净累计');
    for (const [route, body] of [['funding-history', { pairs: [{ base: 'BTC', longKey: 1 }] }], ['scanner-data', { ...scanner, historyHours: 'x' }]] as const) {
      const invalid = await call(0, route, body);
      assert.deepEqual([invalid.status, invalid.body.code], [400, 'invalid_request'], `${route} 无效请求`);
    }
    runtime.control.update('perpetual', { enabled: false, revision: 0 });
    assert.equal((await call(0, 'funding-history', pairs)).status, 423, '关闭后');
    assert.equal((await call(0, 'scanner-data', scanner)).status, 423, '关闭后');
  } finally {
    runtime.perpetual?.stop();
    await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    await settleMonitor(runtime);
    closeMonitor(runtime); closeMonitor(bare);
    rmSync(dir, { recursive: true, force: true }); rmSync(bareDir, { recursive: true, force: true });
  }
});
