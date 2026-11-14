// Monitor M-4a: the perpetual-contract collector. Against stand-in venues and sockets: discovery, subscribing, merging the
// updates into one quote per contract, control replies, reconnecting, a directory change, the switch starting and stopping
// it, the endpoints (table, summary, the SSE stream with and without gzip, 404 and 423), the config and the import.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, get, type IncomingMessage, type ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGunzip } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { PERPETUAL_CLIENT_BACKLOG, acceptsGzip, createPerpetualMonitor, type PerpetualOptions } from '../src/monitor/perpetual.ts';
import type { LoopContext } from '../src/monitor/anthropic.ts';
import { parseServiceConfig } from '../src/service/config.ts';
import { monitorSummary, parseMonitorConfig } from '../src/service/monitor-config.ts';
import { planMonitor } from '../src/service/import-modules.ts';
import { monitorLoops, monitorStatus, monitorViews, openMonitor } from '../src/service/monitor.ts';
import { createExecutorServer } from '../src/http.ts';
import { EXCHANGES, createSubscriptions } from '../src/vendor/perpetual-exchanges.mjs';
import type { PerpetualMarket, PerpetualUpdate } from '../src/vendor/perpetual-stream.mjs';
import { disabledNotice } from '../web/src/monitor-control.ts';
import { createHarness } from './harness.ts';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) { if (check()) return; await sleep(4); }
  assert.fail(`等待超时：${what}`);
}

/** Two venues whose sockets the test drives: each message `{ updates }` carries parser output as it is. */
function fakeVenues() {
  const sockets: FakeSocket[] = [];
  let multiplier = 1, discoverFails = false, discoveries = 0;
  const logs: string[] = [];
  /** While set, discovery waits for the test to release it. */
  let gate: Promise<void> | null = null;
  class FakeSocket {
    readyState = 0; binaryType = 'blob'; sent: unknown[] = []; closed = false;
    readonly listeners = new Map<string, ((event: { data: unknown }) => void)[]>();
    readonly url: string; readonly options: { headers?: Record<string, string> } | undefined;
    constructor(url: string, options?: { headers?: Record<string, string> }) {
      this.url = url; this.options = options;
      sockets.push(this);
      setTimeout(() => { if (!this.closed) { this.readyState = 1; this.emit('open'); } }, 0);
    }
    addEventListener(type: string, listener: (event: { data: unknown }) => void): void { this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]); }
    emit(type: string, data?: unknown): void { for (const listener of this.listeners.get(type) ?? []) listener({ data }); }
    send(text: string): void { this.sent.push(JSON.parse(text)); }
    close(): void { this.closed = true; this.readyState = 3; }
    /** The venue closing the connection. */
    drop(): void { this.readyState = 3; this.emit('close'); }
  }
  const market = (exchange: string): PerpetualMarket => ({ id: `${exchange}:BTCUSDT`, exchange, symbol: 'BTCUSDT', base: 'BTC', quoteCurrency: 'USDT', multiplier });
  const options: PerpetualOptions = {
    exchanges: [{ id: 'alpha', name: 'Alpha', kind: 'cex' }, { id: 'beta', name: 'Beta', kind: 'dex' }],
    discover: async exchange => { discoveries++; const multiple = multiplier; if (gate) await gate; if (discoverFails && exchange === 'beta') throw new Error('down'); return [{ ...market(exchange), multiplier: multiple }]; },
    subscriptions: (exchange, markets) => [{ url: `wss://${exchange}.test/ws`, markets, subscribe: [{ op: 'subscribe', exchange }], sendIntervalMs: 1, ...(exchange === 'beta' ? { headers: { 'x-size': '1' } } : {}) }],
    parse: ((_exchange: string, payload: unknown) => (payload as { updates?: PerpetualUpdate[] }).updates ?? []) as PerpetualOptions['parse'],
    control: ((_exchange: string, payload: unknown) => (payload as { ping?: number }).ping ? { pong: (payload as { ping: number }).ping } : null) as PerpetualOptions['control'],
    WebSocketImpl: FakeSocket,
    retryMs: 20, observationIntervalMs: 5, broadcastIntervalMs: 15,
    log: line => { logs.push(line); },
  };
  const live = (exchange: string) => sockets.filter(socket => socket.url.includes(exchange) && !socket.closed && socket.readyState === 1);
  /** A book (and mark) update on the venue's open socket. */
  const book = (exchange: string, bid: number, ask: number, extra: Partial<PerpetualUpdate> = {}) => {
    const socket = live(exchange).at(-1);
    assert.ok(socket, `${exchange} 没有已连接的 socket`);
    socket.emit('message', JSON.stringify({ updates: [{ exchange, symbol: 'BTCUSDT', base: 'BTC', quoteCurrency: 'USDT', bid, ask, mark: (bid + ask) / 2, ...extra }] }));
  };
  return {
    options, sockets, live, book, logs,
    setMultiplier: (value: number) => { multiplier = value; },
    failDiscovery: (value: boolean) => { discoverFails = value; },
    discoveries: () => discoveries,
    /** Holds discovery until the returned release is called. */
    holdDiscovery: () => { let release!: () => void; gate = new Promise<void>(resolve => { release = () => { gate = null; resolve(); }; }); return release; },
  };
}

test('采集：发现合约后连接并订阅，盘口合并为每合约一条，控制消息回复，快照与概要反映在线状态', async () => {
  const venues = fakeVenues();
  const perpetual = createPerpetualMonitor(venues.options);
  try {
    assert.equal(perpetual.snapshot().status, 'unavailable', '未启动');
    perpetual.start();
    perpetual.start();
    await until(() => venues.live('alpha').length === 1 && venues.live('beta').length === 1, '两家都连上');
    assert.equal(venues.sockets.length, 2, '重复 start 不会多连');
    await until(() => venues.live('alpha')[0]!.sent.length === 1, '订阅已发出');
    assert.deepEqual(venues.live('alpha')[0]!.sent, [{ op: 'subscribe', exchange: 'alpha' }]);
    assert.deepEqual([venues.live('alpha')[0]!.binaryType, venues.live('beta')[0]!.options?.headers], ['arraybuffer', { 'x-size': '1' }], '二进制按 ArrayBuffer 收，请求头照计划带上');
    venues.book('alpha', 100, 101);
    venues.book('alpha', 100.5, 101, { fundingRate: 0.0001 });
    venues.live('alpha')[0]!.emit('message', JSON.stringify({ ping: 7 }));
    assert.deepEqual(venues.live('alpha')[0]!.sent.at(-1), { pong: 7 }, '控制消息原样回复');
    await until(() => perpetual.snapshot().quotes.length === 1, '报价提交');
    const quote = perpetual.snapshot().quotes[0]!;
    assert.deepEqual([quote.exchange, quote.symbol, quote.bid, quote.ask, quote.fundingRate, quote.transport], ['alpha', 'BTCUSDT', 100.5, 101, 0.0001, 'ws']);
    const views = new Map(perpetual.snapshot().exchanges.map(exchange => [exchange.id, exchange]));
    assert.deepEqual([views.get('alpha')!.status, views.get('alpha')!.marketCount, views.get('beta')!.status], ['live', 1, 'connecting']);
    assert.equal(perpetual.snapshot().status, 'partial');
    const summary = perpetual.summary();
    assert.deepEqual([summary.status, summary.state, summary.quoteCount, summary.onlineExchangeCount, summary.baseCount, summary.message], ['partial', 'partial', 1, 1, 1, '行情待更新：Beta']);
    venues.book('beta', 99, 100);
    await until(() => perpetual.snapshot().status === 'live', '两家都在线');
    assert.deepEqual([perpetual.summary().state, perpetual.summary().message], ['online', '']);
    const status = perpetual.status();
    assert.deepEqual([status.running, status.quotes, status.connections, status.venues.map(venue => venue.status)], [true, 2, 2, ['live', 'live']]);
  } finally { perpetual.stop(); }
});

test('采集：断线按退避重连，消息无效重新订阅；合约列表失败标记错误；目录换了合约身份时剔除旧报价并重新订阅', async () => {
  const venues = fakeVenues();
  venues.failDiscovery(true);
  const perpetual = createPerpetualMonitor({ ...venues.options, discoveryIntervalMs: 60 });
  try {
    perpetual.start();
    await until(() => venues.live('alpha').length === 1, 'alpha 连上');
    await until(() => perpetual.snapshot().exchanges.find(exchange => exchange.id === 'beta')!.status === 'error', 'beta 发现失败');
    assert.equal(perpetual.snapshot().exchanges.find(exchange => exchange.id === 'beta')!.error, '合约列表获取失败，正在重试。');
    venues.book('alpha', 100, 101);
    await until(() => perpetual.snapshot().quotes.length === 1, '报价提交');
    const first = venues.live('alpha')[0]!;
    first.drop();
    assert.equal(perpetual.status().venues[0]!.error, 'WebSocket 已断开，正在重连。');
    await until(() => venues.live('alpha').length === 1 && venues.live('alpha')[0] !== first, '重连');
    assert.equal(perpetual.status().venues[0]!.reconnects, 1);
    assert.equal(perpetual.snapshot().quotes.length, 1, '断线不清报价');
    // A parser that throws is a broken message: the connection is replaced.
    const second = venues.live('alpha')[0]!;
    const broken = createPerpetualMonitor({ ...venues.options, exchanges: [{ id: 'alpha', name: 'Alpha', kind: 'cex' }], parse: (() => { throw new Error('bad frame'); }) as PerpetualOptions['parse'] });
    try {
      broken.start();
      await until(() => venues.live('alpha').length === 2, '第二个采集器连上');
      const bad = venues.live('alpha').find(socket => socket !== second)!;
      bad.emit('message', '{}');
      assert.deepEqual([broken.status().venues[0]!.error, broken.status().venues[0]!.lastProtocolError, bad.closed], ['行情消息无效，正在重新订阅。', 'bad frame', true]);
      await until(() => venues.live('alpha').length === 2 && !venues.live('alpha').includes(bad), '消息无效后换了新连接');
    } finally { broken.stop(); }
    // The next discovery finds the contract with another multiplier: the old quote goes and the venue resubscribes.
    const before = venues.sockets.length;
    venues.setMultiplier(10);
    await until(() => perpetual.snapshot().quotes.length === 0 && venues.sockets.length > before, '旧报价剔除并重新连接');
    assert.ok(second.closed, '旧一代连接已关闭');
    // Beta's directory failed on every 60 ms refresh: logged once until it recovers, then once more.
    assert.equal(venues.logs.filter(line => line.includes('Beta 合约列表获取失败')).length, 1, '失败只记首次');
    venues.failDiscovery(false);
    await until(() => venues.live('beta').length === 1, 'beta 恢复后连上');
    assert.deepEqual(venues.logs.filter(line => line.includes('Beta')).map(line => line.split('（')[0]), ['合约价差：Beta 合约列表获取失败', '合约价差：Beta 合约列表已恢复']);
  } finally { perpetual.stop(); }
});

test('换代：旧一代断线后挂着的重连计时作废，到期也不会再连', async () => {
  const venues = fakeVenues();
  const perpetual = createPerpetualMonitor({ ...venues.options, exchanges: [{ id: 'alpha', name: 'Alpha', kind: 'cex' }], retryMs: 200, discoveryIntervalMs: 40 });
  try {
    perpetual.start();
    await until(() => venues.live('alpha').length === 1, '连上');
    const old = venues.live('alpha')[0]!;
    old.drop(); // its reconnect is due in 200–250 ms
    venues.setMultiplier(10);
    await until(() => venues.live('alpha').length === 1 && venues.live('alpha')[0] !== old, '新一代在重连到期前连上');
    const count = venues.sockets.length;
    await sleep(350);
    assert.deepEqual([venues.live('alpha').length, venues.sockets.length], [1, count], '旧一代的重连没有发生');
  } finally { perpetual.stop(); }
});

test('停止：连接关闭、报价清空、换新的流编号；再次启动从头采集', async () => {
  const venues = fakeVenues();
  const perpetual = createPerpetualMonitor(venues.options);
  perpetual.start();
  await until(() => venues.live('alpha').length === 1, '连上');
  venues.book('alpha', 100, 101);
  await until(() => perpetual.snapshot().quotes.length === 1, '报价提交');
  const stream = perpetual.snapshot().streamId;
  perpetual.stop();
  assert.ok(venues.sockets.every(socket => socket.closed), '全部连接已关闭');
  const stopped = perpetual.snapshot();
  assert.deepEqual([stopped.status, stopped.quotes.length, stopped.exchanges.map(exchange => exchange.status), perpetual.running()], ['unavailable', 0, ['disabled', 'disabled'], false]);
  assert.notEqual(stopped.streamId, stream);
  const count = venues.sockets.length;
  await sleep(40);
  assert.equal(venues.sockets.length, count, '停止后不再重连');
  perpetual.start();
  try {
    await until(() => venues.live('alpha').length === 1 && venues.live('beta').length === 1, '重新连上');
    assert.equal(perpetual.snapshot().exchanges[0]!.status, 'connecting');
  } finally { perpetual.stop(); }
});

/** Reads an SSE response's `data:` frames as they come. */
function frames(response: IncomingMessage, gzip: boolean) {
  const received: Record<string, any>[] = [];
  let buffer = '', retry = false;
  const source = gzip ? response.pipe(createGunzip()) : response;
  source.setEncoding('utf8');
  source.on('data', (chunk: string) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      for (const line of block.split('\n')) {
        if (line === 'retry: 5000') retry = true;
        if (line.startsWith('data: ')) received.push(JSON.parse(line.slice(6)));
      }
    }
  });
  return { received, retry: () => retry };
}

test('接口：合约表、概要与 SSE（首帧全量带 retry，其后按 baseSequence 增量；gzip 可选）；未配置 404，关闭后 423，开关启停采集器', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-perpetual-'));
  const venues = fakeVenues();
  const config = parseServiceConfig({ secretsFile: '/etc/tp/secrets.json', monitor: { hynix: {}, perpetual: {} } }).monitor!;
  const runtime = openMonitor(config, dir, { fetchImpl: async () => { throw new Error('offline'); }, log: () => undefined, perpetualOptions: venues.options });
  let stopped = false;
  const context: LoopContext = { stopped: () => stopped, pause: ms => sleep(Math.min(ms, 10)) };
  const loops = monitorLoops({ ...runtime, hynix: null }, context, () => undefined);
  const h = createHarness();
  const server = createExecutorServer({ executor: h.ex, accessToken: 'perpetual-token-0001', views: { monitor: monitorViews(runtime) } });
  const responses: IncomingMessage[] = [];
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const cookie = ((await fetch(`${url}/login?token=perpetual-token-0001`, { redirect: 'manual' })).headers.get('set-cookie') ?? '').split(';')[0]!;
    const call = async (path: string, body?: unknown) => {
      const response = await fetch(url + path, body === undefined ? { headers: { cookie } } : { method: 'POST', headers: { cookie, 'x-pa-executor': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    const open = (gzip: boolean) => new Promise<IncomingMessage>((resolve, reject) => {
      get(`${url}/api/monitor/perpetual/stream`, { headers: { cookie, ...(gzip ? { 'accept-encoding': 'gzip, br' } : {}) } }, response => { responses.push(response); resolve(response); }).on('error', reject);
    });
    assert.equal((await fetch(`${url}/api/monitor/perpetual/quote`)).status, 401, '须登录');
    await until(() => runtime.perpetual!.running() && venues.live('alpha').length === 1 && venues.live('beta').length === 1, '开关开启后循环启动采集器');
    venues.book('alpha', 100, 101);
    await until(() => runtime.perpetual!.snapshot().quotes.length === 1, '报价提交');
    const table = await call('/api/monitor/perpetual/quote');
    assert.deepEqual([table.status, table.body.monitorId, table.body.quotes.length, table.body.quotes[0].bid], [200, 'perpetual', 1, 100]);
    const summary = await call('/api/monitor/perpetual/summary');
    assert.deepEqual([summary.status, summary.body.quoteCount, summary.body.running, summary.body.available], [200, 1, true, true]);
    assert.deepEqual([monitorStatus(runtime).perpetual?.quotes, monitorStatus(runtime).perpetual?.summary.quoteCount], [1, 1], '状态页带采集器状态');

    const plain = await open(false), zipped = await open(true);
    assert.deepEqual([plain.statusCode, plain.headers['content-type'], plain.headers['content-encoding'], zipped.headers['content-encoding'], plain.headers['cache-control']],
      [200, 'text/event-stream; charset=utf-8', undefined, 'gzip', 'no-store, no-transform']);
    const a = frames(plain, false), b = frames(zipped, true);
    await until(() => a.received.length >= 1 && b.received.length >= 1, '首帧');
    assert.ok(a.retry() && b.retry(), '首帧带 retry: 5000');
    for (const { received } of [a, b]) assert.deepEqual([received[0]!.monitorId, received[0]!.type, received[0]!.quotes.length, received[0]!.quotes[0].bid], ['perpetual', undefined, 1, 100]);
    venues.book('alpha', 102, 103);
    venues.book('beta', 99, 100);
    const patched = (frame: Record<string, any>) => frame.type === 'patch' && frame.patches.length > 0;
    await until(() => a.received.some(patched) && b.received.some(patched), '增量帧');
    for (const { received } of [a, b]) {
      const patches = received.filter(frame => frame.type === 'patch');
      patches.forEach((frame, index) => { if (index) assert.equal(frame.baseSequence, patches[index - 1]!.baseSequence + 1, '序号连续'); });
      const changes = new Map(patches.flatMap(frame => frame.patches as [string, Record<string, unknown>][]));
      assert.equal(changes.get('alpha:BTCUSDT')!.bid, 102);
      assert.equal(changes.get('beta:BTCUSDT')!.bid, 99, '新合约以完整字段出现在增量里');
    }

    const off = await call('/api/monitor/perpetual/control', { enabled: false, revision: 0 });
    assert.deepEqual([off.status, off.body.enabled], [200, false]);
    await until(() => !runtime.perpetual!.running(), '关闭后循环停止采集器');
    await until(() => plain.complete && zipped.complete, '关闭时结束读者的流');
    for (const path of ['/api/monitor/perpetual/quote', '/api/monitor/perpetual/summary', '/api/monitor/perpetual/stream']) {
      const answer = await call(path);
      assert.deepEqual([answer.status, answer.body.code, answer.body.message], [423, 'monitor_disabled', '合约价差监控已关闭，行情采集已暂停；开启后重新采集'], path);
    }
    assert.ok(venues.sockets.every(socket => socket.closed), '连接全部关闭');
    assert.equal((await call('/api/monitor/perpetual/control', { enabled: true, revision: 1 })).body.enabled, true);
    await until(() => runtime.perpetual!.running(), '重新开启');
    assert.deepEqual([(await call('/api/monitor/perpetual/quote')).status, (await call('/api/monitor/perpetual/history')).status], [200, 404]);
  } finally {
    stopped = true;
    for (const response of responses) response.destroy();
    await Promise.all(loops);
    assert.equal(runtime.perpetual!.running(), false, '服务停止时采集器停下');
    await new Promise(resolve => server.close(resolve));
    h.dispose();
    runtime.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('接口：未配置合约价差时各读取 404', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-perpetual-none-'));
  const config = parseServiceConfig({ secretsFile: '/etc/tp/secrets.json', monitor: { hynix: {} } }).monitor!;
  const runtime = openMonitor(config, dir, { fetchImpl: async () => { throw new Error('offline'); }, log: () => undefined });
  const h = createHarness();
  const server = createExecutorServer({ executor: h.ex, accessToken: 'perpetual-token-0002', views: { monitor: monitorViews(runtime) } });
  try {
    assert.equal(runtime.perpetual, null);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const cookie = ((await fetch(`${url}/login?token=perpetual-token-0002`, { redirect: 'manual' })).headers.get('set-cookie') ?? '').split(';')[0]!;
    for (const path of ['quote', 'summary', 'stream']) {
      const response = await fetch(`${url}/api/monitor/perpetual/${path}`, { headers: { cookie } });
      assert.deepEqual([response.status, ((await response.json()) as { message: string }).message], [404, '本服务没有配置合约价差行情监控'], path);
    }
    const control = await fetch(`${url}/api/monitor/perpetual/control`, { method: 'POST', headers: { cookie, 'x-pa-executor': '1', 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false, revision: 0 }) });
    assert.equal(control.status, 404);
  } finally {
    await new Promise(resolve => server.close(resolve));
    h.dispose(); runtime.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('配置与导入：perpetual 不带设置；--check-config 摘要；从工作台导入暂不补上 perpetual，已有的保留', () => {
  assert.deepEqual(parseMonitorConfig({ perpetual: {} }), { perpetual: {} });
  assert.throws(() => parseMonitorConfig({ perpetual: { venues: ['binance'] } }), /monitor\.perpetual 无效（不带设置，写 \{\}）/);
  assert.match(monitorSummary({ perpetual: {} }), /合约价差（各交易所永续合约公开盘口）/);
  const fits = () => undefined;
  const fresh: Record<string, any> = {};
  planMonitor({ workbench: false }, fresh, fits, []);
  assert.deepEqual(fresh.monitor, { anthropic: {}, oil: {}, hynix: {} }, '新导入不含 perpetual（M-4b 随页面加入）');
  const existing: Record<string, any> = { monitor: { anthropic: {}, oil: {}, hynix: {}, perpetual: {} } };
  const item = planMonitor({ workbench: false }, existing, fits, []);
  assert.deepEqual([item.status, existing.monitor.perpetual, item.markets], ['skipped', {}, ['anthropic', 'oil', 'hynix', 'perpetual']]);
  assert.match(item.detail, /合约价差/);
  assert.match(disabledNotice('perpetual'), /报价只在内存中，不保留/);
});

test('照搬的交易所模块：11 家交易所，订阅计划可由合约目录生成', () => {
  assert.equal(EXCHANGES.length, 11);
  assert.ok(EXCHANGES.every(exchange => exchange.kind === 'cex' || exchange.kind === 'dex'));
  const market = { id: 'binance:BTCUSDT', exchange: 'binance', symbol: 'BTCUSDT', base: 'BTC', quoteCurrency: 'USDT', multiplier: 1 };
  const specs = createSubscriptions('binance', [market]);
  assert.ok(specs.length >= 1 && specs.every(spec => spec.url.startsWith('wss://') && spec.markets.length >= 1));
});

/** Rebuilds a reader's table from its frames by the workbench feed's rules (lib/perpetual-feed.ts): a full frame replaces
 * the table; a patch must start at the last frame's sequence and merges `{ ...previous, ...changes }`. */
function rebuild(received: Record<string, any>[]): Map<string, Record<string, any>> {
  let table = new Map<string, Record<string, any>>(), sequence: number | null = null;
  for (const frame of received) {
    if (Array.isArray(frame.quotes)) { table = new Map(frame.quotes.map((quote: Record<string, any>) => [`${quote.exchange}:${quote.symbol}`, quote])); sequence = frame.sequence; continue; }
    assert.equal(frame.baseSequence, sequence, '增量接在上一帧之后');
    for (const [key, changes] of frame.patches as [string, Record<string, any>][]) {
      const next = { ...table.get(key), ...changes };
      assert.equal(`${next.exchange}:${next.symbol}`, key, '新合约在增量里带完整身份');
      table.set(key, next);
    }
    for (const key of frame.removed as string[]) table.delete(key);
    sequence = frame.sequence;
  }
  return table;
}
const prices = (table: Iterable<Record<string, any>>) => [...table].map(quote => `${quote.exchange}:${quote.symbol} ${quote.bid}/${quote.ask} ×${quote.multiplier}`).sort();

test('SSE：先到的与中途加入的读者都能按工作台规则拼回服务端的表，含目录换代后的移除', async () => {
  const venues = fakeVenues();
  const perpetual = createPerpetualMonitor({ ...venues.options, discoveryIntervalMs: 60 });
  const server = createServer((request, response) => perpetual.stream(request, response));
  const responses: IncomingMessage[] = [];
  const open = (url: string) => new Promise<IncomingMessage>((resolve, reject) => { get(url, response => { responses.push(response); resolve(response); }).on('error', reject); });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    perpetual.start();
    await until(() => venues.live('alpha').length === 1 && venues.live('beta').length === 1, '连上');
    const first = frames(await open(url), false);
    venues.book('alpha', 100, 101);
    await until(() => first.received.some(frame => frame.type === 'patch' && frame.patches.length), '第一个读者收到增量');
    venues.book('alpha', 100.5, 101.5);
    await until(() => rebuild(first.received).get('alpha:BTCUSDT')?.bid === 100.5, '共享基线已前进');
    const late = frames(await open(url), false);
    await until(() => late.received.length > 0, '中途加入的读者收到首帧');
    venues.book('beta', 99, 100);
    venues.book('alpha', 102, 103);
    await until(() => [first, late].every(reader => prices(rebuild(reader.received).values()).join() === prices(perpetual.snapshot().quotes).join()), '两个读者拼出的表与服务端一致');
    // The next directory has another multiplier: the quotes go (frames carry `removed`) and come back from the new generation.
    venues.setMultiplier(10);
    await until(() => first.received.some(frame => frame.removed?.includes('alpha:BTCUSDT')) && late.received.some(frame => frame.removed?.includes('alpha:BTCUSDT')), '增量里带移除');
    await until(() => venues.live('alpha').length === 1 && venues.live('beta').length === 1, '新一代连上');
    venues.book('alpha', 104, 105, { multiplier: 10 });
    await until(() => [first, late].every(reader => { const table = rebuild(reader.received); return table.size === 1 && table.get('alpha:BTCUSDT')?.bid === 104; }), '换代后两个读者的表一致');
    assert.deepEqual(prices(rebuild(first.received).values()), prices(perpetual.snapshot().quotes));
  } finally {
    for (const response of responses) response.destroy();
    perpetual.stop();
    await new Promise(resolve => server.close(resolve));
  }
});

/** A response the test controls: whether it needs a drain and how much is waiting. */
function fakeResponse() {
  const response = Object.assign(new EventEmitter(), {
    writes: [] as string[], destroyed: false, writableEnded: false, writableLength: 0, writableNeedDrain: false, status: 0,
    writeHead(status: number) { response.status = status; return response; },
    write(chunk: string) { response.writes.push(chunk); return true; },
    end() { response.writableEnded = true; response.emit('close'); return response; },
    destroy() { response.destroyed = true; response.emit('close'); return response; },
  });
  return response;
}

test('SSE：读者积压时跳过增量、可写后改发全量；积压超过上限断开；采集器未运行时流立即结束', async () => {
  const venues = fakeVenues();
  const perpetual = createPerpetualMonitor(venues.options);
  const request = { headers: {} } as IncomingMessage;
  try {
    const idle = fakeResponse();
    perpetual.stream(request, idle as unknown as ServerResponse);
    assert.deepEqual([idle.status, idle.writes.length, idle.writableEnded], [200, 1, true], '未运行：首帧后结束');
    perpetual.start();
    await until(() => venues.live('alpha').length === 1, '连上');
    const slow = fakeResponse(), fast = fakeResponse();
    perpetual.stream(request, slow as unknown as ServerResponse);
    perpetual.stream(request, fast as unknown as ServerResponse);
    slow.writableNeedDrain = true;
    venues.book('alpha', 100, 101);
    await until(() => fast.writes.some(chunk => chunk.includes('"type":"patch"') && chunk.includes('alpha:BTCUSDT')), '正常读者收到增量');
    assert.equal(slow.writes.length, 1, '积压的读者只有首帧');
    slow.writableNeedDrain = false;
    await until(() => slow.writes.length === 2, '可写后补发');
    const full = JSON.parse(slow.writes[1]!.slice(6)) as Record<string, any>;
    assert.deepEqual([full.type, full.quotes.length, full.quotes[0].bid], [undefined, 1, 100], '补发的是全量');
    slow.writableLength = PERPETUAL_CLIENT_BACKLOG + 1;
    await until(() => slow.destroyed && perpetual.status().clients === 1, '积压超过上限断开');
    perpetual.stop();
    assert.equal(fast.writableEnded, true, '停止时结束读者的流');
  } finally { perpetual.stop(); }
});

test('停止与重启的竞态：停止时还在进行的合约发现在重启后返回，不会连出旧一代的连接', async () => {
  const venues = fakeVenues();
  const perpetual = createPerpetualMonitor(venues.options);
  try {
    const release = venues.holdDiscovery();
    perpetual.start();
    await until(() => venues.discoveries() === 2, '两家的发现都在等');
    perpetual.stop();
    const releaseAgain = venues.holdDiscovery();
    perpetual.start();
    await until(() => venues.discoveries() === 4, '重启后的发现也在等');
    release();
    await sleep(30);
    assert.equal(venues.sockets.length, 0, '旧一轮的发现结果被丢弃');
    releaseAgain();
    await until(() => venues.live('alpha').length === 1 && venues.live('beta').length === 1, '新一轮照常连上');
    await sleep(30);
    assert.equal(venues.sockets.length, 2, '每家只有一条连接');
  } finally { perpetual.stop(); }
});

test('停止与重启的竞态（反向）：新一轮先连上、旧一轮的发现后返回，也不会多出连接', async () => {
  const venues = fakeVenues();
  const perpetual = createPerpetualMonitor(venues.options);
  try {
    const release = venues.holdDiscovery();
    perpetual.start();
    await until(() => venues.discoveries() === 2, '两家的发现都在等');
    perpetual.stop();
    const releaseAgain = venues.holdDiscovery();
    perpetual.start();
    await until(() => venues.discoveries() === 4, '重启后的发现也在等');
    releaseAgain();
    await until(() => venues.live('alpha').length === 1 && venues.live('beta').length === 1, '新一轮连上');
    release();
    await sleep(30);
    assert.equal(venues.sockets.length, 2, '旧一轮的发现结果被丢弃');
  } finally { perpetual.stop(); }
});

test('gzip：Accept-Encoding 含 gzip 且 q 不为 0 时才压缩', () => {
  assert.deepEqual(['gzip', 'br, GZIP', 'gzip;q=0.5', 'deflate, gzip ; q=1', 'gzip;q=0', 'gzip; q = 0', 'gzip;q=abc', 'br', '', undefined, 'x-gzip'].map(value => acceptsGzip(value)),
    [true, true, true, true, false, false, false, false, false, false, false]);
});
