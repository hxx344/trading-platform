// Monitor M-5d2: the workbench's quality service inside the perpetual collector (minute samples, fundamentals, long/short
// account ratios), its cache table and route. The service's own rules are the workbench's tests (test/perpetual/{quality,
// quality-service,fundamentals,positioning,positioning-summary}.test.mjs); these cover what this service adds: running state,
// the 400 / 500 split, the injected sources, samples written to and restored from perpetual-cache.sqlite, the cache-unavailable
// notice, the environment settings and the route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import { PerpetualInspectionError, createPerpetualMonitor, type PerpetualMonitor, type PerpetualOptions } from '../src/monitor/perpetual.ts';
import { PERPETUAL_CACHE_FILE, openPerpetualCache } from '../src/monitor/perpetual-cache.ts';
import type { FundamentalsClient } from '../src/vendor/perpetual-fundamentals.mjs';
import type { PositioningFetch } from '../src/vendor/perpetual-positioning.mjs';
import type { PerpetualUpdate } from '../src/vendor/perpetual-stream.mjs';
import { parseServiceConfig } from '../src/service/config.ts';
import { closeMonitor, monitorViews, openMonitor, perpetualQualityEnv, settleMonitor } from '../src/service/monitor.ts';
import { createExecutorServer } from '../src/http.ts';
import { createHarness } from './harness.ts';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 1500; i++) { if (await check()) return; await sleep(4); }
  assert.fail(`等待超时：${what}`);
}
const MINUTE = 60_000, DAY = 86_400_000;

const BTC = { coinId: 'bitcoin', name: 'Bitcoin', marketCapUsd: 1e12, fdvUsd: 1.1e12, circulatingSupply: 19e6, totalSupply: 19e6, maxSupply: 21e6, updatedAt: 1, source: 'test' };
const fundamentals = (get: FundamentalsClient['get'] = base => base === 'BTC' ? BTC : null): FundamentalsClient => ({
  refresh: async () => ({}), get, describe: base => ({ base, coinId: null, status: 'unmapped', reason: null }),
});
const positioningFetch: PositioningFetch = async (quote, options) => ({ exchange: quote.exchange, symbol: quote.symbol, longRatio: 0.6, shortRatio: 0.4, kind: 'accounts', scope: '合约全体持仓账户（5 分钟）', source: 'test', observedAt: Math.floor((options?.now ?? Date.now()) / 300_000) * 300_000 });

/** Binance and Bybit with one BTCUSDT quote each (books 100/101 and 102/103); every public read offline unless given. */
function venues(quality: PerpetualOptions['quality'] = { fundamentals: fundamentals(), positioningFetch }): PerpetualOptions {
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
  const offline = async () => { throw new Error('offline'); };
  return {
    exchanges: [{ id: 'binance', name: 'Binance', kind: 'cex' }, { id: 'bybit', name: 'Bybit', kind: 'cex' }],
    discover: async exchange => [{ id: `${exchange}:BTCUSDT`, exchange, symbol: 'BTCUSDT', base: 'BTC', quoteCurrency: 'USDT', multiplier: 1, delisting: false, delistingAt: null }],
    subscriptions: (exchange, markets) => [{ url: `wss://${exchange}.test/ws`, markets, subscribe: [], sendIntervalMs: 1 }],
    parse: ((_exchange: string, payload: unknown) => (payload as { updates?: PerpetualUpdate[] }).updates ?? []) as PerpetualOptions['parse'],
    control: (() => null) as PerpetualOptions['control'],
    WebSocketImpl: FakeSocket, fetchImpl: offline,
    metrics: { fetchImpl: offline, intervalMs: 10 }, fundingHistory: { fetchImpl: offline }, priceHistory: { fetchImpl: offline },
    quality, retryMs: 20, observationIntervalMs: 5, broadcastIntervalMs: 15, log: () => undefined,
  };
}
const pair = { base: 'BTC', longKey: 'binance:BTCUSDT', shortKey: 'bybit:BTCUSDT' };
const pairId = JSON.stringify([pair.base, pair.longKey, pair.shortKey]);
const request = { pairs: [pair] };
const refused = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { assert.ok(error instanceof PerpetualInspectionError); return [error.status, error.message]; } assert.fail('应当拒绝'); };

test('采集器：未运行 503，输入无效 400；运行时取样写入缓存，读到样本、基本面与多空比；新采集器从缓存恢复样本', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-perpetual-quality-'));
  const real = openPerpetualCache(join(dir, PERPETUAL_CACHE_FILE));
  let first: PerpetualMonitor | null = null, second: PerpetualMonitor | null = null;
  // The first sample is taken right after the (empty) restore; hold the restore until both quotes are in, so that sample has
  // the pair instead of waiting a minute for the next one. Bucket 0 is outside every window and is ignored on ingest.
  const gated = { ...real, *loadQualitySamples(now: number) {
    for (let i = 0; i < 1_000_000 && first?.snapshot().quotes.length !== 2; i++) yield { bucket: 0, rows: [] };
    yield* real.loadQualitySamples(now);
  } };
  try {
    first = createPerpetualMonitor({ ...venues(), cache: gated });
    assert.deepEqual(await refused(first.quality(request)), [503, '合约价差采集未运行，开启后再读取质量资料']);
    first.start();
    await until(() => first!.snapshot().quotes.length === 2, '两腿报价');
    assert.deepEqual(await refused(first.quality({})), [400, '每次最多评估30个平台组合']);
    assert.equal((await refused(first.quality({ pairs: Array.from({ length: 31 }, () => pair) })))[0], 400, '最多 30 个组合');
    assert.deepEqual(await refused(first.quality({ pairs: [{ ...pair, base: 1 }] })), [400, '平台组合格式无效']);
    await until(() => [...real.loadQualitySamples(Date.now())].some(sample => JSON.stringify(sample.rows).includes(pair.shortKey)), '样本写入缓存');
    const report = await first.quality(request);
    const evidence = report.pairs[pairId]!;
    assert.equal(evidence.spread.samples, 1, '一分钟一个样本');
    assert.ok(Math.abs(evidence.spread.mean! - (102 / 101 - 1) * 100) < 1e-9, '价差 = 空腿买一 / 多腿卖一 - 1');
    assert.deepEqual(report.assets.BTC, BTC, '注入的基本面');
    assert.equal(report.storageError, undefined, '缓存可用时不带提示');
    assert.ok(!('okx:BTCUSDT' in report.pairs), '只回请求的组合');
    await until(async () => { const read = await first!.quality(request); return Boolean(read.positioning[pair.longKey] && read.positioning[pair.shortKey]); }, '后台采到两腿多空比');
    const overview = (await first.quality(request)).positioningOverview!.BTC!;
    assert.equal(overview.availableExchanges, 2, '两家交易所计入多空概览');
    const bucket = [...real.loadQualitySamples(Date.now())].find(sample => JSON.stringify(sample.rows).includes(pair.shortKey))!.bucket;
    first.stop();
    await first.settled();
    assert.equal((await refused(first.quality(request)))[0], 503, '停止后');
    second = createPerpetualMonitor({ ...venues(), cache: real });
    second.start();
    await until(() => second!.snapshot().quotes.length === 2, '新采集器两腿报价');
    const restored = (await second.quality(request)).pairs[pairId]!;
    assert.ok(restored.spread.samples >= 1, '恢复的样本可读');
    assert.equal(restored.spread.firstAt, bucket, '保留原来的分钟');
  } finally {
    first?.stop(); second?.stop();
    await Promise.all([first?.settled(), second?.settled()]);
    real.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('采集器：缓存库不可用时质量报告带只存内存的提示；多空比经 quality.fetchImpl 读取；其它失败 500', async () => {
  const unavailable = '缓存库 perpetual-cache.sqlite 打不开，只存内存';
  const requests: string[] = [];
  const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  const ratioFetch = async (input: string) => {
    requests.push(input);
    const url = new URL(input), at = Math.floor(Date.now() / 300_000) * 300_000;
    if (url.hostname === 'fapi.binance.com' && url.pathname === '/futures/data/globalLongShortAccountRatio') return json([{ symbol: 'BTCUSDT', longAccount: '0.55', shortAccount: '0.45', timestamp: at }]);
    if (url.hostname === 'api.bybit.com' && url.pathname === '/v5/market/account-ratio') return json({ retCode: 0, result: { list: [{ symbol: 'BTCUSDT', buyRatio: '0.5', sellRatio: '0.5', timestamp: String(at) }] } });
    throw new Error('offline');
  };
  let failing = false;
  const perpetual = createPerpetualMonitor({ ...venues({ fetchImpl: ratioFetch as never, fundamentals: fundamentals(base => { if (failing) throw new Error('boom'); return base === 'BTC' ? BTC : null; }) }), cacheUnavailable: unavailable });
  try {
    perpetual.start();
    await until(() => perpetual.snapshot().quotes.length === 2, '两腿报价');
    assert.equal((await perpetual.quality(request)).storageError, unavailable);
    await until(async () => Object.keys((await perpetual.quality(request)).positioning).length === 2, '多空比');
    const report = await perpetual.quality(request);
    assert.equal(report.positioning[pair.longKey]!.longRatio, 0.55);
    assert.ok(requests.some(url => url.includes('/futures/data/globalLongShortAccountRatio')) && requests.some(url => url.includes('/v5/market/account-ratio')), '两家都经注入的 fetch');
    failing = true;
    assert.deepEqual(await refused(perpetual.quality(request)), [500, 'boom']);
  } finally { perpetual.stop(); await perpetual.settled(); }
});

test('缓存库：质量样本单独一张表，重开后读回；同一分钟不覆盖，坏行跳过，只留 24 小时与 1440 行', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-perpetual-quality-cache-'));
  const file = join(dir, PERPETUAL_CACHE_FILE);
  const now = Math.floor(1_790_000_000_000 / MINUTE) * MINUTE;
  const metrics = { key: 'binance:BTCUSDT', lastAccessAt: 5, value: { volume24h: 1 } };
  let cache = openPerpetualCache(file);
  try {
    cache.saveContractMetrics(metrics);
    cache.savePriceHistory({ key: 'binance:BTCUSDT', lastAccessAt: 6, value: {} });
    cache.saveQualitySample(now - 2 * MINUTE, [['first']]);
    cache.saveQualitySample(now - MINUTE, [['second']]);
    cache.saveQualitySample(now - MINUTE, [['replaced']]);
    cache.saveQualitySample(now, [['third']]);
    cache.close();
    cache = openPerpetualCache(file);
    assert.deepEqual([...cache.loadQualitySamples(now)], [{ bucket: now - 2 * MINUTE, rows: [['first']] }, { bucket: now - MINUTE, rows: [['second']] }, { bucket: now, rows: [['third']] }], '同一分钟保留先写的');
    assert.deepEqual([...cache.loadQualitySamples(now - MINUTE)].map(sample => sample.bucket), [now - 2 * MINUTE, now - MINUTE], '不读将来的分钟');
    assert.deepEqual(cache.loadContractMetrics('binance:BTCUSDT'), [metrics], '与其它表互不覆盖');
    assert.deepEqual(cache.loadPriceHistory('binance:BTCUSDT').map(item => item.lastAccessAt), [6]);
    const inspection = new DatabaseSync(file);
    try { inspection.prepare('UPDATE quality_samples SET payload=? WHERE bucket=?').run(Buffer.from('corrupt'), now - MINUTE); } finally { inspection.close(); }
    assert.deepEqual([...cache.loadQualitySamples(now)].map(sample => sample.bucket), [now - 2 * MINUTE, now], '坏行跳过');
    for (let index = 1500; index > 0; index--) cache.saveQualitySample(now + index * MINUTE - DAY, [['later']]);
    const count = () => { const db = new DatabaseSync(file); try { return (db.prepare('SELECT COUNT(*) AS count, MIN(bucket) AS oldest FROM quality_samples').get() as { count: number; oldest: number }); } finally { db.close(); } };
    cache.saveQualitySample(now + 2 * MINUTE, [['newest']]);
    const after = count();
    assert.ok(after.count <= 1440, '至多 1440 行');
    assert.ok(after.oldest > now + 2 * MINUTE - DAY, '24 小时以前的剪掉');
    // More than 1440 distinct buckets inside 24 hours (half-minute steps): the row cap, not the age cut, keeps the newest 1440.
    const start = now + 3 * MINUTE;
    for (let index = 0; index < 1600; index++) cache.saveQualitySample(start + index * 30_000, [['dense']]);
    const capped = count();
    assert.equal(capped.count, 1440, '24 小时内也只留 1440 行');
    assert.equal(capped.oldest, start + (1600 - 1440) * 30_000, '留下最新的 1440 个分钟');
  } finally { cache.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('环境变量：PERPETUAL_COIN_IDS 校验后传入，非法时忽略并记日志（不写值）；COINGECKO_DEMO_API_KEY 只传不记', () => {
  const lines: string[] = [];
  const log = (line: string) => { lines.push(line); };
  assert.deepEqual(perpetualQualityEnv({}, log), {});
  assert.deepEqual(perpetualQualityEnv({ PERPETUAL_COIN_IDS: '{"HYPE":"hyperliquid","1000PEPE":"pepe"}', COINGECKO_DEMO_API_KEY: 'demo-key-1' }, log), { coinIds: { HYPE: 'hyperliquid', '1000PEPE': 'pepe' }, apiKey: 'demo-key-1' });
  assert.equal(lines.length, 0, '合法时不记日志');
  for (const value of ['not json', '[]', '{"hype":"hyperliquid"}', '{"HYPE":"Hyperliquid"}', '{"HYPE":1}', JSON.stringify(Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [`C${i}`, 'x'])))]) {
    assert.deepEqual(perpetualQualityEnv({ PERPETUAL_COIN_IDS: value, COINGECKO_DEMO_API_KEY: 'demo-key-2' }, log), { apiKey: 'demo-key-2' }, value.slice(0, 30));
  }
  assert.equal(lines.length, 6);
  assert.ok(lines.every(line => line.includes('PERPETUAL_COIN_IDS') && !line.includes('not json') && !line.includes('demo-key')), '日志不带值');
});

test('接口：quality 用 POST；须登录与页面请求标记；未运行 503，无效 400，未配置 404，关闭后 423；非法环境变量只记日志', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-perpetual-quality-route-'));
  const lines: string[] = [];
  const config = parseServiceConfig({ secretsFile: '/etc/tp/secrets.json', monitor: { hynix: {}, perpetual: {} } }).monitor!;
  const runtime = openMonitor(config, dir, { fetchImpl: async () => { throw new Error('offline'); }, log: line => { lines.push(line); }, perpetualOptions: venues(), env: { PERPETUAL_COIN_IDS: 'not json' } });
  const bareDir = mkdtempSync(join(tmpdir(), 'tp-perpetual-quality-bare-'));
  const bare = openMonitor(parseServiceConfig({ secretsFile: '/etc/tp/secrets.json', monitor: { hynix: {} } }).monitor!, bareDir, { fetchImpl: async () => { throw new Error('offline'); }, log: () => undefined, env: { PERPETUAL_COIN_IDS: 'not json' } });
  const h = createHarness();
  const servers = [runtime, bare].map(item => createExecutorServer({ executor: h.ex, accessToken: 'perpetual-token-0001', views: { monitor: monitorViews(item) } }));
  try {
    assert.equal(lines.filter(line => line.includes('PERPETUAL_COIN_IDS')).length, 1, '只在配置了合约价差时读环境变量');
    const urls: string[] = [];
    for (const server of servers) { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); urls.push(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
    const login = async (url: string) => ((await fetch(`${url}/login?token=perpetual-token-0001`, { redirect: 'manual' })).headers.get('set-cookie') ?? '').split(';')[0]!;
    const cookies = [await login(urls[0]!), await login(urls[1]!)];
    const call = async (index: number, payload?: unknown, marker = true) => {
      const response = await fetch(`${urls[index]}/api/monitor/perpetual/quality`, payload === undefined ? { headers: { cookie: cookies[index]! } } : { method: 'POST', headers: { cookie: cookies[index]!, ...(marker ? { 'x-pa-executor': '1' } : {}), 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    assert.equal((await fetch(`${urls[0]}/api/monitor/perpetual/quality`, { method: 'POST', headers: { 'x-pa-executor': '1', 'content-type': 'application/json' }, body: JSON.stringify(request) })).status, 401, '须登录');
    assert.equal((await call(0, request, false)).status, 403, '须带页面请求标记');
    assert.equal((await call(0)).status, 404, '不接受 GET');
    assert.equal((await call(1, request)).status, 404, '未配置合约价差');
    assert.deepEqual(await call(0, request), { status: 503, body: { code: 'unavailable', message: '合约价差采集未运行，开启后再读取质量资料' } });
    runtime.perpetual!.start();
    await until(() => runtime.perpetual!.snapshot().quotes.length === 2, '两腿报价');
    const answer = await call(0, request);
    assert.equal(answer.status, 200);
    assert.deepEqual([answer.body.schemaVersion, answer.body.sampleIntervalMs, Object.keys(answer.body.pairs)], [1, MINUTE, [pairId]]);
    assert.deepEqual(answer.body.assets.BTC, BTC);
    const invalid = await call(0, { pairs: 'BTC' });
    assert.deepEqual([invalid.status, invalid.body.code, invalid.body.message], [400, 'invalid_request', '每次最多评估30个平台组合'], '无效请求');
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

test('采集器：同一实例关闭后不再写样本、重开后沿用原样本；恢复途中关闭时停止恢复且不取样', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-perpetual-quality-restart-'));
  const real = openPerpetualCache(join(dir, PERPETUAL_CACHE_FILE));
  let perpetual: PerpetualMonitor | null = null, holding = true, held = 0, saves = 0;
  // As in the first test, hold the first restore until both quotes are in so its closing sample carries the pair.
  const cache = { ...real,
    saveQualitySample(bucket: number, rows: unknown[]) { saves++; return real.saveQualitySample(bucket, rows); },
    *loadQualitySamples(now: number) {
      for (let i = 0; i < 1_000_000 && (perpetual?.snapshot().quotes.length !== 2 || holding); i++) { held++; yield { bucket: 0, rows: [] }; }
      yield* real.loadQualitySamples(now);
    } };
  try {
    perpetual = createPerpetualMonitor({ ...venues(), cache });
    holding = false;
    perpetual.start();
    await until(() => [...real.loadQualitySamples(Date.now())].some(sample => JSON.stringify(sample.rows).includes(pair.shortKey)), '样本写入缓存');
    const bucket = (await perpetual.quality(request)).pairs[pairId]!.spread.firstAt;
    perpetual.stop();
    await perpetual.settled();
    const stoppedAt = saves;
    await sleep(1_200); // past the one-second ratio timer: nothing left running writes a sample
    assert.equal(saves, stoppedAt, '关闭后不再写样本');

    perpetual.start();
    await until(() => perpetual!.snapshot().quotes.length === 2, '重开后两腿报价');
    await until(async () => { try { return (await perpetual!.quality(request)).pairs[pairId]!.spread.samples >= 1; } catch { return false; } }, '重开后读到样本');
    assert.equal((await perpetual.quality(request)).pairs[pairId]!.spread.firstAt, bucket, '沿用原来的分钟样本');
    perpetual.stop();
    await perpetual.settled();

    // Stopping while the restore is still iterating ends the restore and skips its closing sample.
    holding = true; held = 0;
    const beforeRestore = saves;
    perpetual.start();
    await until(() => held > 64, '恢复进行中');
    perpetual.stop();
    await perpetual.settled();
    const heldAtStop = held;
    await sleep(50);
    assert.equal(held, heldAtStop, '恢复已停止迭代');
    assert.ok(heldAtStop < 1_000_000, '恢复没有跑完');
    assert.equal(saves, beforeRestore, '恢复途中关闭不取样');
  } finally {
    holding = false; perpetual?.stop(); await perpetual?.settled();
    real.close(); rmSync(dir, { recursive: true, force: true });
  }
});
