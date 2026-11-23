// Monitor M-5a: the workbench's execution service (depth / exit / fx) inside the perpetual collector, and its routes. The
// service's own rules are the workbench's tests (test/perpetual/*.test.mjs); these cover what this service adds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { PerpetualInspectionError, createPerpetualMonitor, type PerpetualOptions } from '../src/monitor/perpetual.ts';
import { NodeWebSocket } from '../src/vendor/perpetual-depth.mjs';
import type { PerpetualUpdate } from '../src/vendor/perpetual-stream.mjs';
import { parseServiceConfig } from '../src/service/config.ts';
import { closeMonitor, monitorViews, openMonitor, settleMonitor } from '../src/service/monitor.ts';
import { createExecutorServer } from '../src/http.ts';
import { createHarness } from './harness.ts';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) { if (check()) return; await sleep(4); }
  assert.fail(`等待超时：${what}`);
}
test('NodeWebSocket：ws 兼容（文本帧与二进制帧都交付可 String() 解码的 Buffer，超过 8 MB 断开）', () => {
  const original = globalThis.WebSocket;
  type Record = { url: string; binaryType: string; listeners: Map<string, (event: { data?: unknown; code?: number }) => void>; sent: string[]; closed: number };
  const created: Record[] = [];
  class Fake {
    record: Record = { url: '', binaryType: 'blob', listeners: new Map(), sent: [], closed: 0 };
    readyState = 0;
    constructor(url: string) { this.record.url = url; created.push(this.record); }
    set binaryType(value: string) { this.record.binaryType = value; }
    addEventListener(type: string, listener: (event: { data?: unknown; code?: number }) => void) { this.record.listeners.set(type, listener); }
    send(data: string) { this.record.sent.push(data); }
    close() { this.record.closed++; throw new Error('already closed'); }
  }
  globalThis.WebSocket = Fake as unknown as typeof WebSocket;
  try {
    const socket = new NodeWebSocket('wss://example.test/stream');
    const seen: string[] = [];
    socket.on('open', () => seen.push('open'));
    socket.on('message', data => seen.push(String(data)));
    socket.on('close', () => seen.push('close'));
    const record = created[0]!;
    record.listeners.get('open')!({});
    record.listeners.get('message')!({ data: '{"type":"ping"}' });
    record.listeners.get('message')!({ data: new TextEncoder().encode('{"feed":"book_snapshot"}').buffer });
    socket.send('{"type":"pong"}');
    socket.terminate();
    socket.terminate();
    assert.deepEqual([record.url, record.binaryType, seen, record.sent, record.closed],
      ['wss://example.test/stream', 'arraybuffer', ['open', '{"type":"ping"}', '{"feed":"book_snapshot"}', 'close'], ['{"type":"pong"}'], 1], '关闭出错不外抛，close 只一次');

    const big = new NodeWebSocket('wss://example.test/big');
    const events: string[] = [];
    big.on('error', () => events.push('error'));
    big.on('message', () => events.push('message'));
    big.on('close', () => events.push('close'));
    created[1]!.listeners.get('message')!({ data: new ArrayBuffer(8 * 1024 * 1024 + 1) });
    assert.deepEqual(events, ['error', 'close'], '超过 8 MB 的消息不交付');
  } finally { globalThis.WebSocket = original; }
});

/** Binance and Bybit with one BTCUSDT quote each, pushed once their sockets open; public REST books answered from memory. */
function venues() {
  const requests: string[] = [];
  class FakeSocket {
    readyState = 0; binaryType = 'blob';
    readonly listeners = new Map<string, ((event: { data: unknown }) => void)[]>();
    readonly url: string;
    constructor(url: string) {
      this.url = url;
      setTimeout(() => {
        this.readyState = 1; this.emit('open');
        const exchange = url.includes('binance') ? 'binance' : 'bybit', mid = exchange === 'binance' ? 100.5 : 102.5;
        this.emit('message', JSON.stringify({ updates: [{ exchange, symbol: 'BTCUSDT', base: 'BTC', quoteCurrency: 'USDT', bid: mid - 0.5, ask: mid + 0.5, mark: mid }] }));
      }, 0);
    }
    addEventListener(type: string, listener: (event: { data: unknown }) => void): void { this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]); }
    emit(type: string, data?: unknown): void { for (const listener of this.listeners.get(type) ?? []) listener({ data }); }
    send(): void { /* Subscriptions are not checked here. */ }
    close(): void { this.readyState = 3; }
  }
  const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url: string) => {
    requests.push(url);
    const now = Date.now();
    if (url.includes('fapi.binance.com/fapi/v1/depth')) return json({ E: now, bids: [['100', '50']], asks: [['101', '50']] });
    if (url.includes('api.bybit.com/v5/market/orderbook')) return json({ retCode: 0, result: { s: 'BTCUSDT', ts: now, b: [['102', '50']], a: [['103', '50']] } });
    if (url.includes('api.gateio.ws/api/v4/spot/order_book')) return json({ update: now, bids: [['0.9995', '1000']], asks: [['1.0005', '1000']] });
    throw new Error('offline');
  };
  const options: PerpetualOptions = {
    exchanges: [{ id: 'binance', name: 'Binance', kind: 'cex' }, { id: 'bybit', name: 'Bybit', kind: 'cex' }],
    discover: async exchange => [{ id: `${exchange}:BTCUSDT`, exchange, symbol: 'BTCUSDT', base: 'BTC', quoteCurrency: 'USDT', multiplier: 1, delisting: false, delistingAt: null }],
    subscriptions: (exchange, markets) => [{ url: `wss://${exchange}.test/ws`, markets, subscribe: [], sendIntervalMs: 1 }],
    parse: ((_exchange: string, payload: unknown) => (payload as { updates?: PerpetualUpdate[] }).updates ?? []) as PerpetualOptions['parse'],
    control: (() => null) as PerpetualOptions['control'],
    WebSocketImpl: FakeSocket, fetchImpl: fetchImpl as PerpetualOptions['fetchImpl'],
    retryMs: 20, observationIntervalMs: 5, broadcastIntervalMs: 15, log: () => undefined,
  };
  return { options, requests };
}
const legs = { long: { exchange: 'binance', symbol: 'BTCUSDT' }, short: { exchange: 'bybit', symbol: 'BTCUSDT' } };

test('采集器：运行时按需读盘口算成交价差与平仓收益；未运行 503，输入无效 400；停止后再启动换新的查询服务', async () => {
  const { options, requests } = venues();
  const perpetual = createPerpetualMonitor(options);
  const refused = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { assert.ok(error instanceof PerpetualInspectionError); return [error.status, error.message]; } assert.fail('应当拒绝'); };
  try {
    assert.deepEqual(await refused(perpetual.depth({ ...legs, notional: 1000 })), [503, '合约价差采集未运行，开启后再查询盘口']);
    perpetual.start();
    await until(() => perpetual.snapshot().quotes.length === 2, '两腿报价');
    const depth = await perpetual.depth({ ...legs, notional: 1010 }) as Record<string, any>;
    assert.deepEqual([depth.complete, depth.quantity, depth.long.vwap, depth.short.vwap, depth.reasons], [true, 10, 101, 102, []]);
    assert.ok(Math.abs(depth.estimatedSpreadPct - (102 / 101 - 1) * 100) < 1e-9);
    const exit = await perpetual.exit({ ...legs, quantity: 2, entryLongPrice: 99, entryShortPrice: 104, entryFeePaid: 0, settledFunding: 0, capital: null }) as Record<string, any>;
    assert.deepEqual([exit.kind, exit.bookComplete, exit.longPnl, exit.shortPnl], ['exit', true, 2, 2], '卖出多腿于买一 100、买回空腿于卖一 103');
    assert.deepEqual((await refused(perpetual.depth({ ...legs, notional: 0 })))[0], 400);
    assert.deepEqual((await refused(perpetual.depth({ long: legs.long, short: { exchange: 'bybit', symbol: 'ETHUSDT' }, notional: 10 })))[0], 400, '不在目录中的合约');
    assert.deepEqual((await refused(perpetual.exit({ ...legs, quantity: -1, entryLongPrice: 1, entryShortPrice: 1, entryFeePaid: 0, settledFunding: 0, capital: null })))[0], 400);
    const fx = await perpetual.fx() as Record<string, any>;
    assert.deepEqual([fx.baseCurrency, fx.rates.USDC.bid, fx.rates.USDC.ask, Boolean(fx.rates.USD), typeof fx.reasons.USD], ['USDT', 0.9995, 1.0005, false, 'string'], 'USD 汇率读不到时不纳入并给原因');
    perpetual.stop();
    assert.deepEqual((await refused(perpetual.fx()))[0], 503);
    perpetual.start();
    await until(() => perpetual.snapshot().quotes.length === 2, '重启后两腿报价');
    const before = requests.length;
    assert.equal((await perpetual.depth({ ...legs, notional: 1010 }) as Record<string, any>).complete, true, '新的查询服务（旧的已停止）');
    assert.ok(requests.length > before, '缓存随旧服务清空，重新读盘口');
  } finally { perpetual.stop(); }
});

test('接口：depth / exit 用 POST、fx 用 GET；拒绝带服务的原因与状态；未配置 404，关闭后 423', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-perpetual-depth-'));
  const { options } = venues();
  const config = parseServiceConfig({ secretsFile: '/etc/tp/secrets.json', monitor: { hynix: {}, perpetual: {} } }).monitor!;
  const runtime = openMonitor(config, dir, { fetchImpl: async () => { throw new Error('offline'); }, log: () => undefined, perpetualOptions: options });
  const bareDir = mkdtempSync(join(tmpdir(), 'tp-perpetual-bare-'));
  const bare = openMonitor(parseServiceConfig({ secretsFile: '/etc/tp/secrets.json', monitor: { hynix: {} } }).monitor!, bareDir, { fetchImpl: async () => { throw new Error('offline'); }, log: () => undefined });
  const h = createHarness();
  const servers = [runtime, bare].map(item => createExecutorServer({ executor: h.ex, accessToken: 'perpetual-token-0001', views: { monitor: monitorViews(item) } }));
  try {
    const urls: string[] = [];
    for (const server of servers) { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); urls.push(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
    const login = async (url: string) => ((await fetch(`${url}/login?token=perpetual-token-0001`, { redirect: 'manual' })).headers.get('set-cookie') ?? '').split(';')[0]!;
    const cookies = [await login(urls[0]!), await login(urls[1]!)];
    const call = async (index: number, path: string, payload?: unknown) => {
      const response = await fetch(urls[index]! + path, payload === undefined ? { headers: { cookie: cookies[index]! } } : { method: 'POST', headers: { cookie: cookies[index]!, 'x-pa-executor': '1', 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    assert.equal((await fetch(`${urls[0]}/api/monitor/perpetual/fx`)).status, 401, '须登录');
    assert.deepEqual(await call(0, '/api/monitor/perpetual/depth', { ...legs, notional: 1000 }), { status: 503, body: { code: 'unavailable', message: '合约价差采集未运行，开启后再查询盘口' } });
    runtime.perpetual!.start();
    await until(() => runtime.perpetual!.snapshot().quotes.length === 2, '两腿报价');
    const depth = await call(0, '/api/monitor/perpetual/depth', { ...legs, notional: 1010 });
    assert.deepEqual([depth.status, depth.body.complete, depth.body.quantity], [200, true, 10]);
    const exit = await call(0, '/api/monitor/perpetual/exit', { ...legs, quantity: 2, entryLongPrice: 99, entryShortPrice: 104, entryFeePaid: 0, settledFunding: 0, capital: null });
    assert.deepEqual([exit.status, exit.body.kind], [200, 'exit']);
    const invalid = await call(0, '/api/monitor/perpetual/depth', { ...legs, notional: -5 });
    assert.deepEqual([invalid.status, invalid.body.code], [400, 'invalid_request']);
    const changed = await call(0, '/api/monitor/perpetual/exit', { ...legs, identity: 'old', quantity: 2, entryLongPrice: 99, entryShortPrice: 104, entryFeePaid: 0, settledFunding: 0, capital: null });
    assert.deepEqual([changed.status, changed.body.code], [409, 'identity_changed']);
    const fx = await call(0, '/api/monitor/perpetual/fx');
    assert.deepEqual([fx.status, fx.body.baseCurrency], [200, 'USDT']);
    assert.equal((await fetch(`${urls[0]}/api/monitor/perpetual/fx`, { method: 'POST', headers: { cookie: cookies[0]!, 'x-pa-executor': '1', 'content-type': 'application/json' }, body: '{}' })).status, 404, 'fx 只读');
    assert.equal((await call(0, '/api/monitor/perpetual/depth')).status, 404, 'depth 不接受 GET');
    assert.deepEqual((await call(1, '/api/monitor/perpetual/fx')).status, 404, '未配置合约价差');
    runtime.control.update('perpetual', { enabled: false, revision: 0 });
    assert.equal((await call(0, '/api/monitor/perpetual/depth', { ...legs, notional: 1000 })).status, 423, '关闭后');
  } finally {
    runtime.perpetual?.stop();
    await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    await settleMonitor(runtime); closeMonitor(runtime); closeMonitor(bare); h.dispose();
    rmSync(bareDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
