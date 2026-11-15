// Monitor M-5e1: the workbench's paper-position service inside the perpetual collector, its file in the data directory and
// route. The service's own rules are the workbench's tests (test/perpetual/paper.test.mjs); these cover what this service adds:
// the synchronous store (empty, corrupt or oversized files refused and left alone, atomic 0600 writes), the collector's life
// (503 while stopped, minute observations from the broadcast timer, a venue without an open connection, nothing written after
// the stop), openMonitor's wiring and the route (login, page marker, 400 / 404 / 409 / 423 / 503, retry by requestId).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createPerpetualMonitor, type PerpetualMonitor, type PerpetualOptions } from '../src/monitor/perpetual.ts';
import { PERPETUAL_PAPER_FILE, PERPETUAL_PAPER_UNREADABLE, openPerpetualPaperStore } from '../src/monitor/perpetual-paper-store.ts';
import { PERPETUAL_PAPER_LIMITS, perpetualPaperIdentity, type PerpetualPaperState } from '../src/vendor/perpetual-paper.ts';
import type { PerpetualPaperStore } from '../src/vendor/perpetual-paper-service.mjs';
import type { PerpetualQuote, PerpetualUpdate } from '../src/vendor/perpetual-stream.mjs';
import { parseServiceConfig } from '../src/service/config.ts';
import { closeMonitor, monitorViews, openMonitor, settleMonitor } from '../src/service/monitor.ts';
import { createExecutorServer } from '../src/http.ts';
import { createHarness } from './harness.ts';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 1500; i++) { if (await check()) return; await sleep(4); }
  assert.fail(`等待超时：${what}`);
}
const MINUTE = 60_000, HOUR = 3_600_000;

/**
 * Binance and Bybit with one BTCUSDT quote each, sent every 5 ms (books 100/101 and 102/103, funding settling on the hour);
 * `offline` makes a venue's socket report it is not open while the quotes keep coming. Every public read is offline.
 */
function venues(offline = new Set<string>()): PerpetualOptions {
  class FakeSocket {
    state = 0; binaryType = 'blob'; timer?: ReturnType<typeof setInterval>;
    readonly exchange: string;
    readonly listeners = new Map<string, ((event: { data: unknown }) => void)[]>();
    get readyState(): number { return offline.has(this.exchange) && this.state === 1 ? 3 : this.state; }
    constructor(url: string) {
      this.exchange = url.includes('binance') ? 'binance' : 'bybit';
      const mid = this.exchange === 'binance' ? 100.5 : 102.5;
      setTimeout(() => {
        if (this.state !== 0) return;
        this.state = 1; this.emit('open');
        const tick = () => this.emit('message', JSON.stringify({ updates: [{ exchange: this.exchange, symbol: 'BTCUSDT', base: 'BTC', quoteCurrency: 'USDT', bid: mid - 0.5, ask: mid + 0.5, mark: mid, fundingRate: 0.0001, fundingIntervalHours: 8, nextFundingAt: Math.ceil((Date.now() + 2 * HOUR) / HOUR) * HOUR }] }));
        tick(); this.timer = setInterval(tick, 5);
      }, 0);
    }
    addEventListener(type: string, listener: (event: { data: unknown }) => void): void { this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]); }
    emit(type: string, data?: unknown): void { for (const listener of this.listeners.get(type) ?? []) listener({ data }); }
    send(): void { /* Subscriptions are not checked here. */ }
    close(): void { this.state = 3; clearInterval(this.timer); }
  }
  const offlineFetch = async () => { throw new Error('offline'); };
  return {
    exchanges: [{ id: 'binance', name: 'Binance', kind: 'cex' }, { id: 'bybit', name: 'Bybit', kind: 'cex' }],
    discover: async exchange => [{ id: `${exchange}:BTCUSDT`, exchange, symbol: 'BTCUSDT', base: 'BTC', quoteCurrency: 'USDT', multiplier: 1, delisting: false, delistingAt: null }],
    subscriptions: (exchange, markets) => [{ url: `wss://${exchange}.test/ws`, markets, subscribe: [], sendIntervalMs: 1 }],
    parse: ((_exchange: string, payload: unknown) => (payload as { updates?: PerpetualUpdate[] }).updates ?? []) as PerpetualOptions['parse'],
    control: (() => null) as PerpetualOptions['control'],
    WebSocketImpl: FakeSocket as unknown as PerpetualOptions['WebSocketImpl'], fetchImpl: offlineFetch,
    metrics: { fetchImpl: offlineFetch, intervalMs: 10 }, fundingHistory: { fetchImpl: offlineFetch }, priceHistory: { fetchImpl: offlineFetch },
    quality: { fundamentals: { refresh: async () => ({}), get: () => null, describe: base => ({ base, coinId: null, status: 'unmapped', reason: null }) }, positioningFetch: async () => null },
    retryMs: 20, observationIntervalMs: 5, broadcastIntervalMs: 15, log: () => undefined,
  };
}

const OPENED_AT = Date.now() - MINUTE;
/** A paper registration of the two legs as the page builds it (identity from the current quotes, account taker fees given). */
function draft(quotes: PerpetualQuote[], patch: Record<string, unknown> = {}) {
  // The collector's quotes (perpetual-stream.mjs) allow a null assetClass that the shared lib's type leaves out.
  type Quote = Parameters<typeof perpetualPaperIdentity>[0];
  const long = quotes.find(quote => quote.exchange === 'binance') as unknown as Quote, short = quotes.find(quote => quote.exchange === 'bybit') as unknown as Quote;
  return { mode: 'paper', base: 'BTC', longKey: 'binance:BTCUSDT', shortKey: 'bybit:BTCUSDT', identity: perpetualPaperIdentity(long, short),
    quantity: 10, entryLongPrice: 100, entryShortPrice: 104, entryFeePaid: 1, settledFunding: 0, capital: 2_000, openedAt: OPENED_AT,
    targetNetProfit: 5, maxHoldingHours: 24, takerOverrides: { binance: 0.05, bybit: 0.055 }, ...patch };
}
const refused = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { return [(error as { status?: number }).status, (error as Error).message]; } assert.fail('应当拒绝'); };
const saved = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as PerpetualPaperState;

test('存放：没有文件为空；坏文件与过大文件不可用且原样保留；保存先写临时文件再改名，600 权限；校验失败或写入失败不改文件与内存', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-perpetual-paper-store-'));
  const file = join(dir, PERPETUAL_PAPER_FILE);
  try {
    const store = openPerpetualPaperStore(file);
    assert.deepEqual(store.get(), { version: 1, revision: 0, positions: [] });
    assert.equal(existsSync(file), false, '打开不建文件');
    await store.save({ version: 1, revision: 3, positions: [] });
    assert.deepEqual(saved(file), { version: 1, revision: 3, positions: [] });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(existsSync(`${file}.tmp`), false, '临时文件已改名');
    assert.equal(store.get().revision, 3);
    const copy = store.get(); copy.revision = 99;
    assert.equal(store.get().revision, 3, 'get 给副本');
    await assert.rejects(store.save({ version: 2, revision: 4, positions: [] } as unknown as PerpetualPaperState), /Invalid paper-position state/);
    assert.equal(saved(file).revision, 3, '校验失败不写');
    assert.equal(openPerpetualPaperStore(file).get().revision, 3, '重开读回');
    writeFileSync(`${file}.tmp`, 'interrupted', { mode: 0o644 });
    assert.equal(openPerpetualPaperStore(file).get().revision, 3, '残留的临时文件不影响读取');
    await store.save({ version: 1, revision: 4, positions: [] });
    assert.equal(existsSync(`${file}.tmp`), false, '下次保存覆盖残留的临时文件');
    assert.equal(statSync(file).mode & 0o777, 0o600, '残留临时文件的宽权限不带到正式文件');
    // Saving into a directory that cannot be written: refused, no temporary file, the file and the memory copy unchanged.
    chmodSync(dir, 0o500);
    try { await assert.rejects(store.save({ version: 1, revision: 5, positions: [] }), /EACCES|EPERM/); }
    finally { chmodSync(dir, 0o700); }
    assert.equal(existsSync(`${file}.tmp`), false, '写入失败不留临时文件');
    assert.equal(saved(file).revision, 4, '写入失败不改文件');
    assert.equal(store.get().revision, 4, '写入失败不改内存');

    for (const content of ['{not json', JSON.stringify({ version: 1, revision: -1, positions: [] }), ' '.repeat(PERPETUAL_PAPER_LIMITS.fileBytes + 1)]) {
      writeFileSync(file, content);
      assert.throws(() => openPerpetualPaperStore(file), (error: Error) => error.message === PERPETUAL_PAPER_UNREADABLE && error.cause instanceof Error);
      assert.equal(readFileSync(file, 'utf8'), content, '坏文件原样保留');
    }
    assert.match(PERPETUAL_PAPER_UNREADABLE, /perpetual-paper-positions\.json/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('采集器：未运行时写入 503、读取可用；开启后登记写盘、每分钟观测一次；平台连接不在线时观测无效；关闭后不再写', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-perpetual-paper-collector-'));
  const file = join(dir, PERPETUAL_PAPER_FILE), real = openPerpetualPaperStore(file);
  let saves = 0, offset = 0, failing = false;
  const store: PerpetualPaperStore = { get: () => real.get(), save: async next => { saves++; if (failing) throw new Error('disk full'); await real.save(next); } };
  const logs: string[] = [];
  const offline = new Set<string>();
  let perpetual: PerpetualMonitor | null = null;
  try {
    perpetual = createPerpetualMonitor({ ...venues(offline), now: () => Date.now() + offset, paper: { store }, log: line => { logs.push(line); } });
    assert.deepEqual([perpetual.paperView().available, perpetual.paperView().running, perpetual.paperView().positions], [true, false, []]);
    assert.deepEqual(await refused(perpetual.paperUpdate({ revision: 0, action: 'create', position: {} })), [503, '合约价差采集未运行，开启后再登记或修改持仓']);
    perpetual.start();
    await until(() => perpetual!.snapshot().quotes.length === 2, '两腿报价');
    assert.equal(perpetual.paperView().running, true);
    // Let the first broadcast ticks run the service's first check (nothing to observe yet), so the next one waits a minute.
    await sleep(60);

    const view = await perpetual.paperUpdate({ revision: 0, action: 'create', position: draft(perpetual.snapshot().quotes) });
    assert.equal(view.revision, 1);
    const [position] = view.positions;
    assert.equal(position!.observations, 1, '登记时观测一次');
    assert.equal(position!.lastObservation!.valid, true, position!.lastObservation!.reason);
    assert.equal(position!.currentObservation!.valid, true, '读取时用当前盘口估算');
    assert.equal(saved(file).positions[0]!.id, position!.id, '登记写盘');
    assert.ok(perpetual.paperView().positions[0]!.nextFundingAt! > Date.now(), '记下资金费结算时间');

    // The service observes at most once a minute: move the collector's clock past it until the broadcast timer observes (a
    // jump can leave the books a minute old for one tick, so retry until an observation is valid).
    const observed = async (want: (observation: { valid: boolean; reason: string }) => boolean, what: string) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const before = saved(file).positions[0]!.observations;
        offset += MINUTE + 1_000;
        await until(() => saved(file).positions[0]!.observations > before, what);
        if (want(saved(file).positions[0]!.lastObservation!)) return saved(file).positions[0]!;
      }
      assert.fail(`没有得到期望的观测：${what}`);
    };
    const minute = await observed(observation => observation.valid, '分钟观测');
    assert.ok(minute.observations >= 2 && minute.validObservations >= 2, '观测与有效观测计数');
    assert.ok(minute.samples.length >= 1 && minute.worstObservedNetProfit !== null, '记采样点与最差观测');
    const writes = saves;
    await sleep(100);
    assert.equal(saves, writes, '一分钟之内不再观测');

    offline.add('bybit');
    const down = await observed(observation => !observation.valid, '连接断开后的观测');
    assert.equal(down.lastObservation!.reason, '至少一腿平台连接未在线');
    assert.equal(perpetual.paperView().positions[0]!.currentObservation!.reason, '至少一腿平台连接未在线');
    offline.delete('bybit');

    // A minute observation that cannot be saved: the broadcast goes on, the log gets one line, and one more on recovery.
    failing = true;
    const failedFrom = saves;
    offset += MINUTE + 1_000;
    await until(() => logs.some(line => line.includes('持仓记录保存失败')), '保存失败的日志');
    assert.ok(saves > failedFrom && perpetual.paperView().error.includes('持仓记录保存失败'), '页面看到保存失败');
    offset += MINUTE + 1_000;
    await until(() => saves > failedFrom + 1, '再次尝试保存');
    assert.equal(logs.filter(line => line.includes('持仓记录保存失败')).length, 1, '持续失败只记一行');
    failing = false;
    offset += MINUTE + 1_000;
    await until(() => logs.some(line => line.includes('持仓记录已恢复保存')), '恢复保存的日志');

    perpetual.stop();
    await perpetual.settled();
    const stoppedAt = saves;
    assert.equal(perpetual.paperView().running, false);
    assert.equal(perpetual.paperView().positions.length, 1, '关闭后记录仍可读');
    assert.deepEqual(await refused(perpetual.paperUpdate({ revision: 1, action: 'close', id: position!.id, close: { kind: 'stop' } })), [503, '合约价差采集未运行，开启后再登记或修改持仓']);
    offset += 2 * MINUTE;
    await sleep(100);
    assert.equal(saves, stoppedAt, '关闭后不再观测与写盘');

    perpetual.start();
    await until(() => perpetual!.snapshot().quotes.length === 2, '重开后两腿报价');
    const closed = await perpetual.paperUpdate({ revision: 1, action: 'close', id: position!.id, close: { kind: 'stop' } });
    assert.equal(closed.positions[0]!.status, 'stopped', '重开后可以结束观察');
  } finally {
    perpetual?.stop(); await perpetual?.settled();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('采集器：没有存放时不可用，读取写明原因，写入 503', async () => {
  const perpetual = createPerpetualMonitor({ ...venues(), paper: { unavailableReason: '持仓记录坏了' } });
  try {
    perpetual.start();
    assert.deepEqual([perpetual.paperView().available, perpetual.paperView().error], [false, '持仓记录坏了']);
    assert.deepEqual(await refused(perpetual.paperUpdate({ revision: 0, action: 'create', position: {} })), [503, '持仓记录坏了']);
    const bare = createPerpetualMonitor(venues());
    assert.deepEqual([bare.paperView().available, bare.paperView().error], [false, '本服务没有配置持仓记录存放']);
  } finally { perpetual.stop(); await perpetual.settled(); }
});

test('接口：paper 的 GET 与 POST；须登录与页面请求标记；400 / 404 / 409 / 503，未配置 404，关闭 423；登记编号重试得到同一条；坏文件只停持仓跟踪', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-perpetual-paper-route-'));
  const badDir = mkdtempSync(join(tmpdir(), 'tp-perpetual-paper-bad-'));
  const bareDir = mkdtempSync(join(tmpdir(), 'tp-perpetual-paper-bare-'));
  writeFileSync(join(badDir, PERPETUAL_PAPER_FILE), '{broken');
  const lines: string[] = [];
  const config = parseServiceConfig({ secretsFile: '/etc/tp/secrets.json', monitor: { hynix: {}, perpetual: {} } }).monitor!;
  const offline = async () => { throw new Error('offline'); };
  const runtime = openMonitor(config, dir, { fetchImpl: offline, log: () => undefined, perpetualOptions: venues(), env: {} });
  const bad = openMonitor(config, badDir, { fetchImpl: offline, log: line => { lines.push(line); }, perpetualOptions: venues(), env: {} });
  const bare = openMonitor(parseServiceConfig({ secretsFile: '/etc/tp/secrets.json', monitor: { hynix: {} } }).monitor!, bareDir, { fetchImpl: offline, log: () => undefined, env: {} });
  const h = createHarness();
  const servers = [runtime, bad, bare].map(item => createExecutorServer({ executor: h.ex, accessToken: 'perpetual-token-0001', views: { monitor: monitorViews(item) } }));
  try {
    const urls: string[] = [];
    for (const server of servers) { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); urls.push(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/monitor/perpetual/paper`); }
    const cookies: string[] = [];
    for (const url of urls) cookies.push(((await fetch(url.replace(/\/api\/.*$/, '/login?token=perpetual-token-0001'), { redirect: 'manual' })).headers.get('set-cookie') ?? '').split(';')[0]!);
    const call = async (index: number, payload?: unknown, marker = true) => {
      const response = await fetch(urls[index]!, payload === undefined ? { headers: { cookie: cookies[index]! } } : { method: 'POST', headers: { cookie: cookies[index]!, ...(marker ? { 'x-pa-executor': '1' } : {}), 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    assert.equal((await fetch(urls[0]!)).status, 401, 'GET 须登录');
    assert.equal((await fetch(urls[0]!, { method: 'POST', headers: { 'x-pa-executor': '1', 'content-type': 'application/json' }, body: '{}' })).status, 401, 'POST 须登录');
    assert.equal((await call(0, { revision: 0, action: 'create' }, false)).status, 403, '须带页面请求标记');
    assert.equal((await call(2)).status, 404, '未配置合约价差');
    assert.equal((await call(2, { revision: 0 })).status, 404, '未配置合约价差');

    const idle = await call(0);
    assert.equal(idle.status, 200);
    assert.deepEqual([idle.body.available, idle.body.running, idle.body.revision, idle.body.error, idle.body.positions, idle.body.limits], [true, false, 0, '', [], { ...PERPETUAL_PAPER_LIMITS }]);
    assert.equal(typeof idle.body.generatedAt, 'number');
    assert.deepEqual(await call(0, { revision: 0, action: 'create', position: {} }), { status: 503, body: { code: 'unavailable', message: '合约价差采集未运行，开启后再登记或修改持仓' } });

    runtime.perpetual!.start();
    await until(() => runtime.perpetual!.snapshot().quotes.length === 2, '两腿报价');
    const quotes = runtime.perpetual!.snapshot().quotes;
    const created = await call(0, { revision: 0, action: 'create', position: draft(quotes, { requestId: 'page-request-1' }) });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.deepEqual([created.body.revision, created.body.positions.length, created.body.positions[0].requestId], [1, 1, 'page-request-1']);
    const id = created.body.positions[0].id as string;
    const read = await call(0);
    assert.deepEqual([read.body.revision, read.body.running, read.body.positions[0].id], [1, true, id], 'GET 读到登记');
    assert.equal(saved(join(dir, PERPETUAL_PAPER_FILE)).positions[0]!.id, id, '写进数据目录');

    const retried = await call(0, { revision: 0, action: 'create', position: draft(quotes, { requestId: 'page-request-1' }) });
    assert.deepEqual([retried.status, retried.body.revision, retried.body.positions.length, retried.body.positions[0].id], [200, 1, 1, id], '丢失应答后重试得到同一条');
    const reused = await call(0, { revision: 1, action: 'create', position: draft(quotes, { requestId: 'page-request-1', quantity: 11 }) });
    assert.deepEqual([reused.status, reused.body.code, reused.body.message], [409, 'conflict', '此登记请求编号已用于不同持仓参数，请重新登记。'], '编号复用');
    const stale = await call(0, { revision: 0, action: 'create', position: draft(quotes) });
    assert.deepEqual([stale.status, stale.body.code, stale.body.message], [409, 'conflict', '持仓记录已被另一页面修改，请重载后再保存。'], '版本冲突');
    const invalid = await call(0, { revision: 1, action: 'update', id, changes: { quantity: 3 } });
    assert.deepEqual([invalid.status, invalid.body.code, invalid.body.message], [400, 'invalid_request', '只能更新资金费、预算、目标、最长持有时间和备注。']);
    const calculator = await call(0, { revision: 1, action: 'create', position: draft(quotes, { quantity: 0 }) });
    assert.deepEqual([calculator.status, calculator.body.code, calculator.body.message], [400, 'invalid_request', '标的数量需大于 0 且不超过 10¹⁸'], '平仓计算器的输入检查 400');
    const missing = await call(0, { revision: 1, action: 'delete', id: 'no-such-position' });
    assert.deepEqual([missing.status, missing.body.code], [404, 'not_found'], '记录不存在');
    const badJson = await fetch(urls[0]!, { method: 'POST', headers: { cookie: cookies[0]!, 'x-pa-executor': '1', 'content-type': 'application/json' }, body: '{' });
    assert.equal(badJson.status, 400);
    const updated = await call(0, { revision: 1, action: 'update', id, changes: { settledFunding: 1.5 } });
    assert.deepEqual([updated.status, updated.body.revision, updated.body.positions[0].settledFunding], [200, 2, 1.5]);

    // A file that cannot be read: the collector runs, the position tracking is unavailable with the reason, the file stays.
    assert.ok(lines.some(line => line.includes(PERPETUAL_PAPER_FILE) && line.includes('持仓跟踪不可用')), '记一行日志');
    bad.perpetual!.start();
    const broken = await call(1);
    assert.deepEqual([broken.status, broken.body.available, broken.body.error], [200, false, PERPETUAL_PAPER_UNREADABLE]);
    assert.deepEqual(await call(1, { revision: 0, action: 'create', position: draft(quotes) }), { status: 503, body: { code: 'unavailable', message: PERPETUAL_PAPER_UNREADABLE } });
    assert.equal(readFileSync(join(badDir, PERPETUAL_PAPER_FILE), 'utf8'), '{broken', '坏文件原样保留');

    runtime.control.update('perpetual', { enabled: false, revision: 0 });
    assert.equal((await call(0)).status, 423, '关闭后 GET');
    assert.equal((await call(0, { revision: 2, action: 'delete', id })).status, 423, '关闭后 POST');
  } finally {
    runtime.perpetual?.stop(); bad.perpetual?.stop();
    await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    await settleMonitor(runtime); await settleMonitor(bad);
    closeMonitor(runtime); closeMonitor(bad); closeMonitor(bare);
    for (const item of [dir, badDir, bareDir]) rmSync(item, { recursive: true, force: true });
  }
});
