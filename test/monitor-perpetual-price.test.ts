// Monitor M-5c: the workbench's hourly trade-close history inside the perpetual collector (the pair chart's data), its
// cache table and route. The service's own rules are the workbench's tests (test/perpetual/{price-history,
// price-reader}.test.mjs); these cover what this service adds: running state, the cache across restarts, the write-back at
// stop, the cache-unavailable notice and the route.
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
import type { PerpetualPriceHistoryReport } from '../src/vendor/perpetual-price-history.ts';
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

/** Binance and Bybit with one BTCUSDT quote each; their hourly klines answered from memory (Binance 100, Bybit 102). */
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
  const opens = (from: number, to: number) => { const list: number[] = []; for (let time = Math.ceil(from / HOUR) * HOUR; time <= Math.min(to, Date.now()); time += HOUR) list.push(time); return list; };
  const priceFetch = async (input: string) => {
    requests.push(input);
    const url = new URL(input), params = url.searchParams;
    if (url.hostname === 'fapi.binance.com' && url.pathname === '/fapi/v1/klines') {
      return json(opens(Number(params.get('startTime')), Number(params.get('endTime'))).slice(0, Number(params.get('limit'))).map(open => [open, '0', '0', '0', '100', '0', open + HOUR - 1]));
    }
    if (url.hostname === 'api.bybit.com' && url.pathname === '/v5/market/kline') {
      const list = opens(Number(params.get('start')), Number(params.get('end'))).slice(0, Number(params.get('limit'))).reverse().map(open => [String(open), '0', '0', '0', '102', '0', '0']);
      return json({ retCode: 0, result: { symbol: params.get('symbol'), category: 'linear', list } });
    }
    throw new Error('offline');
  };
  const options: PerpetualOptions = {
    exchanges: [{ id: 'binance', name: 'Binance', kind: 'cex' }, { id: 'bybit', name: 'Bybit', kind: 'cex' }],
    discover: async exchange => [{ id: `${exchange}:BTCUSDT`, exchange, symbol: 'BTCUSDT', base: 'BTC', quoteCurrency: 'USDT', multiplier: 1, delisting: false, delistingAt: null }],
    subscriptions: (exchange, markets) => [{ url: `wss://${exchange}.test/ws`, markets, subscribe: [], sendIntervalMs: 1 }],
    parse: ((_exchange: string, payload: unknown) => (payload as { updates?: PerpetualUpdate[] }).updates ?? []) as PerpetualOptions['parse'],
    control: (() => null) as PerpetualOptions['control'],
    WebSocketImpl: FakeSocket, fetchImpl: async () => { throw new Error('offline'); },
    metrics: { fetchImpl: async () => { throw new Error('offline'); }, intervalMs: 10 },
    fundingHistory: { fetchImpl: async () => { throw new Error('offline'); } },
    priceHistory: { fetchImpl: priceFetch as never },
    retryMs: 20, observationIntervalMs: 5, broadcastIntervalMs: 15, log: () => undefined,
  };
  return { options, requests };
}
const pair = { base: 'BTC', longKey: 'binance:BTCUSDT', shortKey: 'bybit:BTCUSDT' };
const request = { pair, days: 7 };
const ready = (report: PerpetualPriceHistoryReport) => report.legs[pair.longKey]?.status === 'ready' && report.legs[pair.shortKey]?.status === 'ready';
const refused = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { assert.ok(error instanceof PerpetualInspectionError); return [error.status, error.message]; } assert.fail('应当拒绝'); };

test('采集器：运行时读两腿成交价；未运行 503，组合或窗口无效 400；停止时写回缓存，新开的采集器先给缓存里的记录', async () => {
  const { options, requests } = venues();
  const saved = new Map<string, PerpetualContractCacheEntry>();
  const cache = {
    loadContractMetrics: () => [], saveContractMetrics: () => undefined,
    loadPriceHistory: (key?: string) => key === undefined ? [...saved.values()] : saved.has(key) ? [saved.get(key)!] : [],
    savePriceHistory: (entry: PerpetualContractCacheEntry) => { saved.set(entry.key, structuredClone(entry)); },
  };
  const first = createPerpetualMonitor({ ...options, cache });
  let second: ReturnType<typeof createPerpetualMonitor> | null = null;
  try {
    assert.deepEqual(await refused(first.priceHistory(request)), [503, '合约价差采集未运行，开启后再读取成交价历史']);
    first.start();
    await until(() => first.snapshot().quotes.length === 2, '两腿报价');
    assert.equal((await refused(first.priceHistory({ pair, days: 5 })))[0], 400, '只认 3/7/30 天');
    assert.equal((await refused(first.priceHistory({ pair: { ...pair, shortKey: 'okx:BTCUSDT' }, days: 7 })))[0], 400, '没有报价的腿');
    assert.equal((await refused(first.priceHistory({ pair: { ...pair, shortKey: pair.longKey }, days: 7 })))[0], 400, '两腿相同');
    const pending = await first.priceHistory(request);
    assert.deepEqual(Object.keys(pending.legs).sort(), [pair.longKey, pair.shortKey], '两腿都登记');
    await until(async () => ready(await first.priceHistory(request)), '两腿成交价就绪');
    const report = await first.priceHistory(request);
    const long = report.legs[pair.longKey]!, short = report.legs[pair.shortKey]!;
    assert.ok(long.points.length >= 24 && short.points.length >= 24, '至少一天的小时收盘');
    assert.ok(long.points.every(point => point.close === 100) && short.points.every(point => point.close === 102), '两腿各自的收盘价');
    assert.ok(requests.some(url => url.includes('/fapi/v1/klines')) && requests.some(url => url.includes('/v5/market/kline')), '两家都读了 K 线');
    first.stop();
    await first.settled();
    assert.deepEqual([...saved.keys()].sort(), [pair.longKey, pair.shortKey], '停止时写回两腿');
    assert.equal((await refused(first.priceHistory(request)))[0], 503, '停止后');
    // The restored legs may still owe a backfill; it hangs until stop aborts it, so the cached closes stay readable.
    const hang = (_url: unknown, init?: { signal?: AbortSignal }) => new Promise<never>((_, reject) => { init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)); });
    second = createPerpetualMonitor({ ...venues().options, priceHistory: { fetchImpl: hang as unknown as typeof fetch }, cache });
    second.start();
    await until(() => second!.snapshot().quotes.length === 2, '新采集器两腿报价');
    const restored = await second.priceHistory(request);
    assert.ok(ready(restored), '缓存里的记录直接可读');
    assert.deepEqual(restored.legs[pair.longKey]!.points, long.points);
  } finally {
    first.stop(); second?.stop();
    await Promise.all([first.settled(), second?.settled()]);
  }
});

test('采集器：缓存库不可用时成交价报告带只存内存的提示', async () => {
  const unavailable = '缓存库 perpetual-cache.sqlite 打不开，只存内存';
  const perpetual = createPerpetualMonitor({ ...venues().options, cacheUnavailable: unavailable });
  try {
    perpetual.start();
    await until(() => perpetual.snapshot().quotes.length === 2, '两腿报价');
    assert.equal((await perpetual.priceHistory(request)).storageError, unavailable);
  } finally { perpetual.stop(); await perpetual.settled(); }
});

test('缓存库：成交价单独一张表，重开后读回，坏行按缺失处理', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-perpetual-price-cache-'));
  const file = join(dir, PERPETUAL_CACHE_FILE);
  const entry = { key: 'binance:BTCUSDT', lastAccessAt: 2000, value: { status: 'ready', points: [{ time: HOUR, close: 100 }] } };
  let cache = openPerpetualCache(file);
  try {
    cache.savePriceHistory(entry);
    cache.saveFundingHistory({ key: 'binance:BTCUSDT', lastAccessAt: 1, value: {} });
    cache.close();
    cache = openPerpetualCache(file);
    assert.deepEqual(cache.loadPriceHistory('binance:BTCUSDT'), [entry]);
    assert.deepEqual(cache.loadFundingHistory('binance:BTCUSDT').map(item => item.lastAccessAt), [1], '两张表互不覆盖');
    const inspection = new DatabaseSync(file);
    try { inspection.prepare('UPDATE price_history_cache SET payload=? WHERE id=?').run(Buffer.from('corrupt'), 'binance:BTCUSDT'); } finally { inspection.close(); }
    assert.deepEqual(cache.loadPriceHistory(), [], '坏行不返回');
  } finally { cache.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('接口：price-history 用 POST；须登录与页面请求标记；未运行 503，无效 400，未配置 404，关闭后 423', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-perpetual-price-'));
  const config = parseServiceConfig({ secretsFile: '/etc/tp/secrets.json', monitor: { hynix: {}, perpetual: {} } }).monitor!;
  const runtime = openMonitor(config, dir, { fetchImpl: async () => { throw new Error('offline'); }, log: () => undefined, perpetualOptions: venues().options });
  const bareDir = mkdtempSync(join(tmpdir(), 'tp-perpetual-price-bare-'));
  const bare = openMonitor(parseServiceConfig({ secretsFile: '/etc/tp/secrets.json', monitor: { hynix: {} } }).monitor!, bareDir, { fetchImpl: async () => { throw new Error('offline'); }, log: () => undefined });
  const h = createHarness();
  const servers = [runtime, bare].map(item => createExecutorServer({ executor: h.ex, accessToken: 'perpetual-token-0001', views: { monitor: monitorViews(item) } }));
  try {
    const urls: string[] = [];
    for (const server of servers) { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); urls.push(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
    const login = async (url: string) => ((await fetch(`${url}/login?token=perpetual-token-0001`, { redirect: 'manual' })).headers.get('set-cookie') ?? '').split(';')[0]!;
    const cookies = [await login(urls[0]!), await login(urls[1]!)];
    const call = async (index: number, payload?: unknown, marker = true) => {
      const response = await fetch(`${urls[index]}/api/monitor/perpetual/price-history`, payload === undefined ? { headers: { cookie: cookies[index]! } } : { method: 'POST', headers: { cookie: cookies[index]!, ...(marker ? { 'x-pa-executor': '1' } : {}), 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    assert.equal((await fetch(`${urls[0]}/api/monitor/perpetual/price-history`, { method: 'POST', headers: { 'x-pa-executor': '1', 'content-type': 'application/json' }, body: JSON.stringify(request) })).status, 401, '须登录');
    assert.equal((await call(0, request, false)).status, 403, '须带页面请求标记');
    assert.equal((await call(0)).status, 404, '不接受 GET');
    assert.equal((await call(1, request)).status, 404, '未配置合约价差');
    assert.deepEqual(await call(0, request), { status: 503, body: { code: 'unavailable', message: '合约价差采集未运行，开启后再读取成交价历史' } });
    runtime.perpetual!.start();
    await until(() => runtime.perpetual!.snapshot().quotes.length === 2, '两腿报价');
    await until(async () => { const answer = await call(0, request); return answer.status === 200 && ready(answer.body as PerpetualPriceHistoryReport); }, '接口给出两腿成交价');
    const invalid = await call(0, { pair, days: 1 });
    assert.deepEqual([invalid.status, invalid.body.code], [400, 'invalid_request'], '无效窗口');
    runtime.control.update('perpetual', { enabled: false, revision: 0 });
    assert.equal((await call(0, request)).status, 423, '关闭后');
  } finally {
    runtime.perpetual?.stop();
    await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    await settleMonitor(runtime);
    closeMonitor(runtime); closeMonitor(bare);
    rmSync(dir, { recursive: true, force: true }); rmSync(bareDir, { recursive: true, force: true });
  }
});
