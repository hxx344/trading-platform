// Monitor M-5b1: the workbench's market-metrics service inside the perpetual collector, its cache file and its route. The
// service's own rules are the workbench's tests (test/perpetual/{market-metrics,metrics-reader}.test.mjs); these cover what
// this service adds: running state, the switch, the cache across restarts and the write-back at stop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import { PerpetualInspectionError, createPerpetualMonitor, type PerpetualOptions } from '../src/monitor/perpetual.ts';
import { PERPETUAL_CACHE_FILE, openPerpetualCache } from '../src/monitor/perpetual-cache.ts';
import type { PerpetualContractCacheEntry } from '../src/vendor/perpetual-market-metrics-service.mjs';
import type { PerpetualUpdate } from '../src/vendor/perpetual-stream.mjs';
import { parseServiceConfig } from '../src/service/config.ts';
import { closeMonitor, monitorViews, openMonitor, settleMonitor } from '../src/service/monitor.ts';
import { createExecutorServer } from '../src/http.ts';
import { createHarness } from './harness.ts';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 1000; i++) { if (await check()) return; await sleep(4); }
  assert.fail(`等待超时：${what}`);
}

/** Binance and Bybit with one BTCUSDT quote each; their public 24h tickers and open interest answered from memory. */
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
  const metricsFetch = async (url: string) => {
    requests.push(url);
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
    retryMs: 20, observationIntervalMs: 5, broadcastIntervalMs: 15, log: () => undefined,
  };
  return { options, requests };
}
const pairs = { pairs: [{ base: 'BTC', longKey: 'binance:BTCUSDT', shortKey: 'bybit:BTCUSDT' }] };
type Report = { legs: Record<string, { status: string; volume24h: { value: number | null }; openInterest: { value: number | null } }> };
const figures = (report: Report) => Object.fromEntries(Object.entries(report.legs).map(([key, leg]) => [key, [leg.status, leg.volume24h.value, leg.openInterest.value]]));
const ready = { 'binance:BTCUSDT': ['ready', 1234567, 890000], 'bybit:BTCUSDT': ['ready', 765432, 345678] };

test('采集器：运行时读市场指标；未运行 503，组合无效 400；停止时写回缓存，重开后同一服务先给缓存里的数值', async () => {
  const { options, requests } = venues();
  const saved = new Map<string, PerpetualContractCacheEntry>();
  const cache = { loadContractMetrics: (key?: string) => key === undefined ? [...saved.values()] : saved.has(key) ? [saved.get(key)!] : [], saveContractMetrics: (entry: PerpetualContractCacheEntry) => { saved.set(entry.key, structuredClone(entry)); } };
  const perpetual = createPerpetualMonitor({ ...options, cache });
  const refused = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { assert.ok(error instanceof PerpetualInspectionError); return [error.status, error.message]; } assert.fail('应当拒绝'); };
  try {
    assert.deepEqual(await refused(perpetual.marketMetrics(pairs)), [503, '合约价差采集未运行，开启后再读取市场指标']);
    perpetual.start();
    await until(() => perpetual.snapshot().quotes.length === 2, '两腿报价');
    assert.deepEqual((await refused(perpetual.marketMetrics({ pairs: 'x' })))[0], 400);
    assert.deepEqual((await refused(perpetual.marketMetrics({ pairs: Array.from({ length: 31 }, () => pairs.pairs[0]) })))[0], 400, '至多 30 个组合');
    const first = await perpetual.marketMetrics(pairs) as Report;
    assert.deepEqual(Object.keys(first.legs).sort(), ['binance:BTCUSDT', 'bybit:BTCUSDT'], '两腿都登记');
    await until(async () => JSON.stringify(figures(await perpetual.marketMetrics(pairs) as Report)) === JSON.stringify(ready), '两腿指标就绪');
    perpetual.stop();
    await perpetual.settled();
    assert.deepEqual([...saved.keys()].sort(), ['binance:BTCUSDT', 'bybit:BTCUSDT'], '停止时写回两腿');
    assert.deepEqual((await refused(perpetual.marketMetrics(pairs)))[0], 503, '停止后');
    const before = requests.length;
    perpetual.start();
    await until(() => perpetual.snapshot().quotes.length === 2, '重开后两腿报价');
    assert.deepEqual(figures(await perpetual.marketMetrics(pairs) as Report), ready, '重开后先给已有数值');
    assert.ok(requests.length - before <= 3, '30 秒内不重复读取');
  } finally { perpetual.stop(); await perpetual.settled(); }
});

test('缓存库：重开后读回，坏行按缺失处理，无效或超长的条目拒绝写入', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-perpetual-cache-'));
  const file = join(dir, PERPETUAL_CACHE_FILE);
  const metric = { key: 'binance:BTCUSDT', lastAccessAt: 2000, value: { volume24h: { value: 0, currency: 'USDT' } }, readerState: { candles: [[1, 10]] } };
  const other = { key: 'bybit:BTCUSDT', lastAccessAt: 1000, value: {} };
  let cache = openPerpetualCache(file);
  try {
    cache.saveContractMetrics(metric); cache.saveContractMetrics(other);
    cache.close(); cache.close();
    cache = openPerpetualCache(file);
    assert.deepEqual(cache.loadContractMetrics('binance:BTCUSDT'), [metric]);
    assert.deepEqual(cache.loadContractMetrics(), [metric, other], '按最近访问在前');
    assert.deepEqual(cache.loadContractMetrics(undefined, 1), [metric]);
    assert.deepEqual(cache.loadContractMetrics('missing'), []);
    const inspection = new DatabaseSync(file);
    try { inspection.prepare('UPDATE contract_metrics_cache SET payload=? WHERE id=?').run(Buffer.from('corrupt'), 'bybit:BTCUSDT'); } finally { inspection.close(); }
    assert.deepEqual(cache.loadContractMetrics(), [metric], '坏行不返回');
    assert.throws(() => cache.saveContractMetrics({ ...metric, lastAccessAt: Number.NaN }), /Invalid/);
    assert.throws(() => cache.saveContractMetrics({ ...metric, key: '' }), /Invalid/);
    assert.throws(() => cache.saveContractMetrics({ ...metric, payload: 'x'.repeat(1_000_001) }), /size limit/);
    assert.deepEqual(cache.loadContractMetrics('binance:BTCUSDT'), [metric], '拒绝的写入不改已有条目');
  } finally { cache.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('服务层：缓存库打不开时只存内存并写日志；关闭时一并关掉缓存库，settleMonitor 等停止写回', async () => {
  const config = parseServiceConfig({ secretsFile: '/etc/tp/secrets.json', monitor: { perpetual: {} } }).monitor!;
  const blocked = mkdtempSync(join(tmpdir(), 'tp-perpetual-blocked-'));
  mkdirSync(join(blocked, PERPETUAL_CACHE_FILE));
  const lines: string[] = [];
  const { options } = venues();
  const memory = openMonitor(config, blocked, { fetchImpl: async () => { throw new Error('offline'); }, log: line => lines.push(line), perpetualOptions: options });
  const dir = mkdtempSync(join(tmpdir(), 'tp-perpetual-file-'));
  const runtime = openMonitor(config, dir, { fetchImpl: async () => { throw new Error('offline'); }, log: () => undefined, perpetualOptions: venues().options });
  try {
    assert.equal(memory.perpetualCache, null);
    assert.ok(lines.some(line => line.includes(PERPETUAL_CACHE_FILE) && line.includes('只存内存')), '写日志');
    memory.perpetual!.start();
    await until(() => memory.perpetual!.snapshot().quotes.length === 2, '内存模式两腿报价');
    await until(async () => JSON.stringify(figures(await memory.perpetual!.marketMetrics(pairs) as Report)) === JSON.stringify(ready), '内存模式指标就绪');
    assert.match(String((await memory.perpetual!.marketMetrics(pairs)).storageError), /perpetual-cache\.sqlite.*只存内存/, '报告带只存内存的提示');
    assert.ok(runtime.perpetualCache);
    runtime.perpetual!.start();
    await until(() => runtime.perpetual!.snapshot().quotes.length === 2, '两腿报价');
    await until(async () => JSON.stringify(figures(await runtime.perpetual!.marketMetrics(pairs) as Report)) === JSON.stringify(ready), '指标就绪');
    assert.equal((await runtime.perpetual!.marketMetrics(pairs)).storageError, undefined, '缓存库正常时不带提示');
    runtime.perpetual!.stop();
    await settleMonitor(runtime);
    assert.deepEqual(runtime.perpetualCache!.loadContractMetrics().map(entry => entry.key).sort(), ['binance:BTCUSDT', 'bybit:BTCUSDT'], '写回缓存库');
    closeMonitor(runtime);
    assert.throws(() => runtime.perpetualCache!.loadContractMetrics(), '缓存库已关闭');
  } finally {
    memory.perpetual?.stop(); runtime.perpetual?.stop();
    await Promise.all([settleMonitor(memory), settleMonitor(runtime)]);
    closeMonitor(memory); closeMonitor(runtime);
    rmSync(blocked, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true });
  }
});

test('接口：metrics 用 POST；须登录与页面请求标记；未运行 503，组合无效 400，未配置 404，关闭后 423', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-perpetual-metrics-'));
  const config = parseServiceConfig({ secretsFile: '/etc/tp/secrets.json', monitor: { hynix: {}, perpetual: {} } }).monitor!;
  const runtime = openMonitor(config, dir, { fetchImpl: async () => { throw new Error('offline'); }, log: () => undefined, perpetualOptions: venues().options });
  const bareDir = mkdtempSync(join(tmpdir(), 'tp-perpetual-bare-'));
  const bare = openMonitor(parseServiceConfig({ secretsFile: '/etc/tp/secrets.json', monitor: { hynix: {} } }).monitor!, bareDir, { fetchImpl: async () => { throw new Error('offline'); }, log: () => undefined });
  const h = createHarness();
  const servers = [runtime, bare].map(item => createExecutorServer({ executor: h.ex, accessToken: 'perpetual-token-0001', views: { monitor: monitorViews(item) } }));
  try {
    const urls: string[] = [];
    for (const server of servers) { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); urls.push(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
    const login = async (url: string) => ((await fetch(`${url}/login?token=perpetual-token-0001`, { redirect: 'manual' })).headers.get('set-cookie') ?? '').split(';')[0]!;
    const cookies = [await login(urls[0]!), await login(urls[1]!)];
    const call = async (index: number, payload?: unknown, marker = true) => {
      const response = await fetch(`${urls[index]}/api/monitor/perpetual/metrics`, payload === undefined ? { headers: { cookie: cookies[index]! } } : { method: 'POST', headers: { cookie: cookies[index]!, ...(marker ? { 'x-pa-executor': '1' } : {}), 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    assert.equal((await fetch(`${urls[0]}/api/monitor/perpetual/metrics`, { method: 'POST', headers: { 'x-pa-executor': '1', 'content-type': 'application/json' }, body: JSON.stringify(pairs) })).status, 401, '须登录');
    assert.equal((await call(0, pairs, false)).status, 403, '须带页面请求标记');
    assert.deepEqual(await call(0, pairs), { status: 503, body: { code: 'unavailable', message: '合约价差采集未运行，开启后再读取市场指标' } });
    runtime.perpetual!.start();
    await until(() => runtime.perpetual!.snapshot().quotes.length === 2, '两腿报价');
    await until(async () => { const answer = await call(0, pairs); return answer.status === 200 && JSON.stringify(figures(answer.body as Report)) === JSON.stringify(ready); }, '接口给出两腿指标');
    const invalid = await call(0, { pairs: [{ base: 'BTC', longKey: 1 }] });
    assert.deepEqual([invalid.status, invalid.body.code], [400, 'invalid_request']);
    const raw = async (body: string) => { const response = await fetch(`${urls[0]}/api/monitor/perpetual/metrics`, { method: 'POST', headers: { cookie: cookies[0]!, 'x-pa-executor': '1', 'content-type': 'application/json' }, body }); return [response.status, (await response.json() as Record<string, unknown>).code]; };
    assert.deepEqual(await raw('{"pairs":'), [400, 'invalid_json'], '非法 JSON');
    assert.deepEqual(await raw(JSON.stringify({ pairs: [], pad: 'x'.repeat(20_000) })), [413, 'body_too_large'], '请求体超过上限');
    assert.equal((await call(0)).status, 404, 'metrics 不接受 GET');
    assert.equal((await call(1, pairs)).status, 404, '未配置合约价差');
    runtime.control.update('perpetual', { enabled: false, revision: 0 });
    assert.equal((await call(0, pairs)).status, 423, '关闭后');
  } finally {
    runtime.perpetual?.stop();
    await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    await settleMonitor(runtime);
    closeMonitor(runtime); closeMonitor(bare);
    rmSync(dir, { recursive: true, force: true }); rmSync(bareDir, { recursive: true, force: true });
  }
});

test('服务层：写回迟迟不结束时 settleMonitor 至多等 limitMs 就返回，停机不被拖住', async () => {
  const started = Date.now();
  await settleMonitor({ perpetual: { settled: () => new Promise<void>(() => undefined) } } as never, 50);
  assert.ok(Date.now() - started < 1_000, '按上限返回');
  await settleMonitor({ perpetual: null } as never);
});
