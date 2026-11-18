import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { createMarketClient, type MarketClient } from '../src/market/ipc.ts';
import { createMarketServer } from '../src/market/server.ts';
import { createMonitorData } from '../src/market/monitor-data.ts';
import { exchangeError } from '../src/monitor/exchanges.ts';
import { OIL_CANDLE_WINDOW_MS } from '../src/monitor/market-contract.ts';
import { OIL_CANDLE_KEY } from '../src/monitor/oil.ts';
import { HISTORY_START, OIL_CANDLE_MS } from '../src/vendor/oil-market.mjs';
import { createRemoteMonitor } from '../src/service/remote-monitor.ts';
import { closeMonitor, openMonitor, settleMonitor, stopMonitor } from '../src/service/monitor.ts';
import { parseServiceConfig } from '../src/service/config.ts';
import type { PerpetualOptions } from '../src/monitor/perpetual.ts';
import type { PerpetualMarket, PerpetualUpdate } from '../src/vendor/perpetual-stream.mjs';
import { fakePerpetualVenues } from './perpetual-fake.ts';
import { fakeAnthropicVenues, fakeVariationalToken } from './monitor-fake.ts';

const quiet = () => {};
const HOUR = 3_600_000, DAY = 24 * HOUR;
async function until(condition: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (!await condition()) { assert.ok(Date.now() < deadline, '等待行情服务超时'); await pause(10); }
}
function socketPath(dir: string): string {
  return process.platform === 'win32' ? '\\\\.\\pipe\\tp-monitor-' + randomUUID() : join(dir, 'market.sock');
}
async function listen(path: string, options: Parameters<typeof createMonitorData>[0]) {
  const worker = createMarketServer({ monitor: createMonitorData(options) }, 'test-market');
  await new Promise<void>((resolve, reject) => { worker.server.once('error', reject); worker.server.listen(path, resolve); });
  return worker;
}

test('独立行情经本机套接字整轮回补；各腿原时间、落盘检查点以及 Var 私有会话留在正确一侧', async () => {
  const at = Date.UTC(2026, 9, 1, 9, 0, 5), now = () => at;
  const venues = fakeAnthropicVenues({ now, listedAt: { brent: Date.UTC(2026, 3, 1, 9), wti: Date.UTC(2026, 3, 1, 9), skhy: Date.UTC(2026, 6, 10, 15), skhx: Date.UTC(2026, 6, 10, 15) } }), dir = mkdtempSync(join(tmpdir(), 'tp-market-rounds-')), socket = socketPath(dir);
  let publicFailure: 'none' | 'python' | 'challenge' | 'timeout' = 'none';
  const publicVar: string[] = [], privateVar: string[] = [], attemptedLocal: string[] = [];
  const worker = await listen(socket, { fetchImpl: venues.fetch, now, log: quiet, WebSocketImpl: venues.WebSocket,
    variationalFetch: async (url, init) => {
      publicVar.push(url); assert.equal(new Headers(init.headers).has('cookie'), false);
      if (publicFailure === 'python') throw Object.assign(new Error(), { code: 'VARIATIONAL_PYTHON_MISSING' });
      if (publicFailure === 'challenge') return new Response('upstream-body-not-for-display', { status: 403 });
      if (publicFailure === 'timeout') throw new DOMException('upstream-body-not-for-display', 'TimeoutError');
      return venues.variationalFetch(url, init);
    } });
  const conn = createMarketClient(socket), sent: { op: string; input: unknown }[] = [];
  const client: MarketClient = { ...conn, call<T>(op: string, input: unknown, signal?: AbortSignal) { sent.push({ op, input }); return conn.call<T>(op, input, signal); } };
  const config = parseServiceConfig({ secretsFile: '/secrets', monitor: { oil: {}, hynix: {}, anthropic: {} } }).monitor!;
  const options = { marketClient: client, now, log: quiet, fetchImpl: async (url: string) => { attemptedLocal.push(url); throw Error('unexpected executor fetch'); },
    variationalFetch: (url: string, init: RequestInit) => { privateVar.push(url); assert.ok(new Headers(init.headers).has('cookie')); return venues.variationalFetch(url, init); } };
  let runtime = openMonitor(config, dir, options);
  try {
    await Promise.all([runtime.anthropic!.refreshQuote(), runtime.oil!.refreshQuote(), runtime.hynix!.refreshQuote(),
      runtime.anthropic!.refreshCandles(), runtime.oil!.refreshCandles(), runtime.hynix!.refreshCandles(), runtime.oil!.refreshFunding(), runtime.hynix!.refreshFunding()]);
    for (const market of ['anthropic', 'oil', 'hynix'] as const) {
      assert.equal(runtime[market]!.quote()?.status, 'live', market);
      assert.equal(runtime[market]!.candles(null)?.status, 'live', market);
    }
    assert.ok(runtime.oil!.funding()!.coverage.rows > 1000);
    assert.ok(runtime.hynix!.funding()!.coverage.rows > 1000);
    assert.equal((await runtime.exchanges!.quote('hynix', 'hyperliquid')).exchange, 'hyperliquid');
    assert.equal((await runtime.exchanges!.fundingHistory('hynix', 'gate')).left.symbol, 'SKHY_USDT');
    const first = sent.filter(item => item.op === 'monitor.anthropic.candles')[0]!;
    const expected = runtime.anthropic!.candles(null)!.metadata.fetchedAt;
    stopMonitor(runtime); closeMonitor(runtime);
    runtime = openMonitor(config, dir, options);
    assert.deepEqual([runtime.anthropic!.candles(null)?.status, runtime.anthropic!.candles(null)?.metadata.fetchedAt], ['snapshot', expected]);
    await runtime.anthropic!.refreshCandles();
    const resume = sent.filter(item => item.op === 'monitor.anthropic.candles').at(-1)!;
    assert.notDeepEqual(first.input, resume.input, '从已存的腿检查点续读');
    assert.ok(JSON.stringify(resume.input).length < 180, 'IPC 只提交四个起点与截止时间');

    const token = fakeVariationalToken(at + DAY);
    await runtime.variational!.update({ token, revision: 0 });
    const quote = await runtime.exchanges!.quote('oil', 'variational');
    assert.equal(quote.exchange, 'variational'); assert.ok(quote.left.fundingRate);
    assert.ok(publicVar.every(url => url.includes('/funding/')) && publicVar.length === 2);
    assert.ok(privateVar.some(url => url.includes('/quotes/indicative')));
    assert.ok(!JSON.stringify(sent).includes(token));
    assert.deepEqual(attemptedLocal, []);
    const comparison = createRemoteMonitor(conn, now).comparison;
    for (const [failure, reason] of [['python', /Python 3/], ['challenge', /被拦截/], ['timeout', /请求超时/]] as const) {
      publicFailure = failure;
      await assert.rejects(comparison.variationalFunding(new AbortController().signal), (error: Error & { blocked?: boolean; variational?: boolean }) => {
        assert.equal(error.variational, true); assert.equal(error.blocked, failure === 'challenge'); assert.match(exchangeError(error), reason);
        assert.ok(!error.message.includes('upstream-body')); return true;
      });
    }
    await Promise.all([runtime.oil!.refreshQuote(), runtime.hynix!.refreshQuote(), runtime.anthropic!.refreshQuote()]);
    assert.equal(runtime.oil!.quote()?.status, 'live');
    const liveRow = await runtime.exchanges!.quote('hynix', 'hyperliquid');
    assert.ok(liveRow.left.fundingRate); const callsBeforeOutage = sent.length;
    worker.close(); await until(() => !conn.epoch());
    const held = await runtime.exchanges!.quote('hynix', 'hyperliquid');
    assert.deepEqual([held.status, held.left.price, held.right.price, held.fetchedAt, held.fundingFetchedAt, held.left.fundingRate, held.right.fundingRate],
      ['snapshot', liveRow.left.price, liveRow.right.price, liveRow.fetchedAt, null, null, null]);
    assert.equal(sent.length, callsBeforeOutage, '缓存中已有 live 行，断开后立即从执行端持久化报价生成快照');
    for (const market of ['anthropic', 'oil', 'hynix'] as const) assert.equal(runtime[market]!.quote()?.status, 'snapshot');
  } finally {
    stopMonitor(runtime); closeMonitor(runtime); conn.close(); worker.close(); rmSync(dir, { recursive: true, force: true });
  }
});

function controlledBooks(now: () => number) {
  const sockets: Socket[] = [], markets: PerpetualMarket[] = [{ id: 'binance:BZUSDT', exchange: 'binance', symbol: 'BZUSDT', base: 'BZ', quoteCurrency: 'USDT' }];
  class Socket {
    url: string; readyState = 0; listeners = new Map<string, ((event: { data: unknown }) => void)[]>();
    constructor(url: string) { this.url = url; sockets.push(this); queueMicrotask(() => { if (!this.readyState) { this.readyState = 1; this.emit('open'); } }); }
    addEventListener(type: string, fn: (event: { data: unknown }) => void) { this.listeners.set(type, [...this.listeners.get(type) ?? [], fn]); }
    emit(type: string, data?: string) { for (const fn of this.listeners.get(type) ?? []) fn({ data }); }
    send() {}
    close() { this.readyState = 3; }
    drop() { this.close(); this.emit('close'); }
    tick(fields: Partial<PerpetualUpdate>) { this.emit('message', JSON.stringify({ ...markets[0], ...fields })); }
  }
  const options: PerpetualOptions = { now, exchanges: [{ id: 'binance', name: 'Binance', kind: 'cex' }],
    discover: async () => markets, subscriptions: (_exchange, markets) => ['book', 'ticker'].map(id => ({ url: 'wss://' + id + '.test/ws', markets })),
    parse: (_exchange, value) => [value as PerpetualUpdate], control: () => null, WebSocketImpl: Socket, retryMs: 15, observationIntervalMs: 0,
    quality: { fundamentals: { refresh: async () => ({}), get: () => null, describe: base => ({ base, coinId: null, status: 'unmapped', reason: null }) }, positioningFetch: async () => null },
  };
  return { options, markets, sockets, active: (type: string) => sockets.filter(s => s.url.includes(type) && s.readyState === 1).at(-1) };
}

test('行情服务丢失/恢复、单个盘口连接丢失、迟到或缺源时间行情均不能续鲜；历史读验证目录身份', async () => {
  let time = Date.now();
  const now = () => time, venue = controlledBooks(now), dir = mkdtempSync(join(tmpdir(), 'tp-market-feed-')), path = socketPath(dir);
  const publicReads: string[] = [];
  const fetchImpl = async (url: string) => {
    publicReads.push(url); const u = new URL(url);
    const t = Number(u.searchParams.get('startTime'));
    if (u.pathname.endsWith('/fundingRate')) return Response.json([{ symbol: 'BZUSDT', fundingTime: t, fundingRate: '0.0003' }]);
    if (u.pathname.endsWith('/klines')) return Response.json([[t, '0', '0', '0', '74.1', '0', t + HOUR - 1]]);
    throw Error('unexpected public request');
  };
  const source = { now, log: quiet, fetchImpl, perpetual: venue.options };
  let daemon = await listen(path, source);
  const client = createMarketClient(path);
  const config = parseServiceConfig({ secretsFile: '/secrets', monitor: { perpetual: {} } }).monitor!;
  const runtime = openMonitor(config, dir, { marketClient: client, now, log: quiet, perpetualOptions: { discover: async () => { assert.fail('executor discovery'); } } });
  const collector = runtime.perpetual!, book = () => collector.book('binance', 'BZUSDT');
  try {
    collector.start();
    await until(() => !!venue.active('book') && !!venue.active('ticker'));
    const original = venue.active('book')!, originalAt = time - 2_000;
    original.tick({ bid: 74, ask: 75, sourceTime: originalAt });
    await until(() => book() !== null);
    assert.equal(book()!.at, originalAt);
    venue.active('ticker')!.tick({ fundingRate: 0.0002, sourceTime: time });
    await until(() => collector.snapshot().quotes[0]?.fundingRate === 0.0002);
    assert.equal(book()!.at, originalAt);
    original.drop();
    await until(() => book() === null);
    assert.ok(venue.active('ticker'), '同一所的另一条连接仍在线');
    await until(() => !!venue.active('book'));
    original.tick({ bid: 200, ask: 201, sourceTime: time });
    venue.active('book')!.tick({ bid: 74.2, sourceTime: time });
    await until(() => collector.snapshot().quotes[0]?.bid === 74.2);
    assert.equal(book(), null, '另一边未重新确认');
    venue.active('book')!.tick({ ask: 75.2, sourceTime: time });
    await until(() => book()?.bid === 74.2);

    const remote = createRemoteMonitor(client, now).perpetual, from = Math.floor((time - 2 * HOUR) / HOUR) * HOUR;
    const market = venue.markets[0]!;
    assert.equal((await remote.funding(market, { from, to: from + HOUR }))[0]?.rate, 0.0003);
    assert.equal((await remote.price(market, { from, to: from + HOUR }))[0]?.close, 74.1);
    const count = publicReads.length;
    await assert.rejects(remote.price({ ...market, multiplier: 6 }, { from, to: from + HOUR }), /身份/);
    assert.equal(publicReads.length, count, '身份错误不会发出上游读');

    daemon.close(); await until(() => !client.epoch() && !book());
    time += 4_000;
    daemon = await listen(path, source); await until(() => !!client.epoch() && !!venue.active('book'));
    const replacement = venue.active('book')!;
    replacement.tick({ bid: 71, ask: 72, sourceTime: originalAt });
    await until(() => collector.snapshot().quotes[0]?.bid === 71);
    assert.equal(book(), null, '断连前旧数据即使新进程收到也不可用');
    replacement.tick({ bid: 72, ask: 73, sourceTime: null });
    await until(() => collector.snapshot().quotes[0]?.bid === 72);
    assert.equal(book(), null, '没有原始时间的公开行情仅供展示');
    replacement.tick({ bid: 75, ask: 76, sourceTime: time });
    await until(() => book()?.bid === 75);
    assert.equal(book()!.at, time);
    collector.stop(); await until(() => !venue.active('book') && !venue.active('ticker'));
  } finally {
    stopMonitor(runtime); await settleMonitor(runtime); closeMonitor(runtime); client.close(); daemon.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('合约详情只向行情服务传合约身份；资金、成交和市场指标经原页面入口落入原缓存', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-market-perpetual-')), path = socketPath(dir);
  const venues = fakePerpetualVenues(), daemon = await listen(path, { perpetual: { ...venues, observationIntervalMs: 20 }, log: quiet });
  const conn = createMarketClient(path), seen: { op: string; input: unknown }[] = [];
  const client: MarketClient = { ...conn, call<T>(op: string, input: unknown, signal?: AbortSignal) { seen.push({ op, input }); return conn.call<T>(op, input, signal); } };
  const config = parseServiceConfig({ secretsFile: '/secrets', monitor: { perpetual: {} } }).monitor!;
  const runtime = openMonitor(config, dir, { marketClient: client, log: quiet });
  const collector = runtime.perpetual!, pair = { base: 'ETH', longKey: 'binance:ETHUSDT', shortKey: 'bybit:ETHUSDT' };
  try {
    collector.start();
    await until(() => [pair.longKey, pair.shortKey].every(key => collector.snapshot().quotes.some(quote => `${quote.exchange}:${quote.symbol}` === key)));
    const legs = { long: { exchange: 'binance', symbol: 'ETHUSDT' }, short: { exchange: 'bybit', symbol: 'ETHUSDT' } };
    const [depth, exit, fx] = await Promise.all([collector.depth({ ...legs, notional: 2000 }),
      collector.exit({ ...legs, quantity: 0.3, entryLongPrice: 3123, entryShortPrice: 3656, entryFeePaid: 1.22, capital: 451.78, settledFunding: -3.4 }),
      collector.fx()]);
    assert.equal(depth.complete, true); assert.equal(exit.bookComplete, true); assert.ok(fx.rates.USDC);
    const calls = seen.filter(item => item.op === 'monitor.perpetual.books');
    assert.equal(calls.length, 2);
    for (const item of calls) {
      const sent = item.input as { legs: Record<string, unknown>[] };
      assert.deepEqual(Object.keys(sent), ['legs']);
      assert.ok(sent.legs.every(key => JSON.stringify(Object.keys(key).sort()) === '["exchange","identity","symbol"]'));
    }
    const batches = { pairs: [pair] };
    await until(async () => {
      const [metrics, funding, history] = await Promise.all([collector.marketMetrics(batches), collector.fundingHistory(batches), collector.priceHistory({ pair, days: 3 })]);
      return Boolean(metrics.legs[pair.longKey]?.volume24h.value && funding.legs[pair.longKey]?.records.length && history.legs[pair.longKey]?.points.length);
    });
    const aux = createRemoteMonitor(conn).perpetual;
    await aux.fundamentals.refresh(['ETH', 'BTC']); assert.equal(aux.fundamentals.get('ETH')?.coinId, 'ethereum');
    const quote = collector.snapshot().quotes.find(q => q.exchange === 'binance' && q.base === 'ETH')!;
    assert.ok((await aux.positioning(quote))?.observedAt);
    collector.stop(); await settleMonitor(runtime);
    assert.ok(runtime.perpetualCache!.loadFundingHistory(pair.longKey).length);
    assert.ok(runtime.perpetualCache!.loadPriceHistory(pair.longKey).length);
    assert.ok(runtime.perpetualCache!.loadContractMetrics(pair.longKey).length);
  } finally {
    stopMonitor(runtime); await settleMonitor(runtime); closeMonitor(runtime); conn.close(); daemon.close(); rmSync(dir, { recursive: true, force: true });
  }
});


test('原油长区间逐段写入，空区间和单腿历史在中断后从各自的已提交检查点恢复', async () => {
  const width = OIL_CANDLE_WINDOW_MS, listed = HISTORY_START + width, paired = listed + width;
  const at = paired + width + DAY, now = () => at;
  const venues = fakeAnthropicVenues({ now, listedAt: { brent: listed, wti: paired } });
  const dir = mkdtempSync(join(tmpdir(), 'tp-market-oil-windows-')), path = socketPath(dir), starts: number[] = [];
  let failing = listed;
  const daemon = await listen(path, { now, log: quiet, fetchImpl: async (url, init) => {
    const q = new URL(url).searchParams, start = Number(q.get('startTime')), end = Number(q.get('endTime'));
    assert.ok(end - start <= width, '一次任务最多请求 14 天，单腿可在一页内返回');
    starts.push(start);
    if (start === failing) return new Response('unavailable', { status: 503 });
    return venues.fetch(url, init);
  } });
  const client = createMarketClient(path), config = parseServiceConfig({ secretsFile: '/secrets', monitor: { oil: {} } }).monitor!;
  const open = () => openMonitor(config, dir, { marketClient: client, now, log: quiet });
  let runtime = open();
  try {
    for (const [expectedStart, pending] of [[HISTORY_START, listed], [listed, paired]] as const) {
      failing = pending; starts.length = 0;
      await runtime.oil!.refreshCandles();
      assert.match(runtime.oil!.status().candleError!, /读取失败/);
      assert.equal(Math.min(...starts), expectedStart);
      assert.equal((runtime.store.readState(OIL_CANDLE_KEY)!.value as { resumeAt: number }).resumeAt, pending);
      const raw = runtime.store.oilCandles();
      assert.equal(raw.length, pending === listed ? 0 : width / OIL_CANDLE_MS);
      assert.ok(raw.every(row => row.brent && row.wti === null));
      assert.equal(runtime.oil!.candles(null), null);
      stopMonitor(runtime); closeMonitor(runtime); runtime = open();
    }
    failing = 0; starts.length = 0;
    await runtime.oil!.refreshCandles();
    assert.equal(Math.min(...starts), paired);
    const view = runtime.oil!.candles(null)!;
    assert.equal(view.status, 'live'); assert.equal(view.data[0]!.time, listed);
    assert.ok(view.data.find(row => row.time === paired)?.wti);
    assert.equal(view.data.at(-1)!.time, at - OIL_CANDLE_MS);
    assert.equal((runtime.store.readState(OIL_CANDLE_KEY)!.value as { resumeAt: number | null }).resumeAt, null);
  } finally { stopMonitor(runtime); closeMonitor(runtime); client.close(); daemon.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Bitget 下一页在途时关闭行情服务，已确认的上一页留在原 SQLite，回补从该覆盖边界继续', async () => {
  let at = Math.floor(Date.now() / HOUR) * HOUR + 1_000;
  const now = () => at, endOfData = Math.floor(at / HOUR) * HOUR, source = controlledBooks(now), dir = mkdtempSync(join(tmpdir(), 'tp-market-bitget-page-')), path = socketPath(dir);
  let blockSecond = true, waiting = false;
  const market = (exchange: string): PerpetualMarket => ({ id: exchange + ':BZUSDT', exchange, symbol: 'BZUSDT', base: 'BZ', quoteCurrency: 'USDT' });
  const options: PerpetualOptions = { ...source.options, exchanges: [{ id: 'bitget', name: 'Bitget', kind: 'cex' }, { id: 'binance', name: 'Binance', kind: 'cex' }],
    discover: async exchange => [market(exchange)], subscriptions: (exchange, markets) => [{ url: 'wss://' + exchange + '.test/ws', markets }] };
  const fetchImpl = async (url: string, init: RequestInit) => {
    const u = new URL(url);
    if (u.hostname !== 'api.bitget.com') return Response.json([]);
    const page = Number(u.searchParams.get('pageNo'));
    if (page === 2 && blockSecond) {
      waiting = true;
      return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
    }
    return Response.json({ code: '00000', data: Array.from({ length: 100 }, (_, i) => ({ symbol: 'BZUSDT', fundingTime: String(endOfData - ((page - 1) * 100 + i) * HOUR), fundingRate: '0.0001' })) });
  };
  const settings = { now, log: quiet, fetchImpl, perpetual: options };
  let daemon = await listen(path, settings);
  const client = createMarketClient(path), inputs: { op: string; range: { from: number; to: number } }[] = [];
  const instrumented: MarketClient = { ...client, call<T>(op: string, input: unknown, signal?: AbortSignal) {
    if (op === 'monitor.perpetual.fundingPage') inputs.push({ op, range: (input as { range: { from: number; to: number } }).range });
    return client.call<T>(op, input, signal);
  } };
  const config = parseServiceConfig({ secretsFile: '/secrets', monitor: { perpetual: {} } }).monitor!;
  const runtime = openMonitor(config, dir, { marketClient: instrumented, now, log: quiet }), collector = runtime.perpetual!;
  const pair = { base: 'BZ', longKey: 'bitget:BZUSDT', shortKey: 'binance:BZUSDT' };
  const saved = () => runtime.perpetualCache!.loadFundingHistory(pair.longKey)[0]?.value as { status: string; records: { time: number }[]; coverage: { from: number; to: number } } | undefined;
  async function quotes() {
    await until(() => !!source.active('binance') && !!source.active('bitget'));
    for (const exchange of ['binance', 'bitget']) source.active(exchange)!.tick({ exchange, base: 'BZ', symbol: 'BZUSDT', bid: 74, ask: 75, sourceTime: now() });
    await until(() => collector.snapshot().quotes.length === 2);
  }
  try {
    collector.start(); await quotes(); await collector.fundingHistory({ pairs: [pair] });
    await until(() => waiting); const edge = endOfData - 99 * HOUR;
    assert.deepEqual([saved()?.records.length, saved()?.coverage.from], [100, edge]);
    daemon.close(); await until(() => !client.epoch() && saved()?.status === 'error');
    assert.equal(saved()?.coverage.from, edge);
    blockSecond = false; at += 6 * 60_000; inputs.length = 0;
    daemon = await listen(path, settings); await until(() => !!client.epoch()); await quotes();
    await until(() => (saved()?.records.length ?? 0) > 100);
    assert.ok(inputs.some(request => request.range.to === edge), '已有的连续覆盖给出了下一轮要补的上界');
  } finally {
    stopMonitor(runtime); await settleMonitor(runtime); closeMonitor(runtime); client.close(); daemon.close(); rmSync(dir, { recursive: true, force: true });
  }
});
