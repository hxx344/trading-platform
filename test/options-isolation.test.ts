// Issue #10: a failed options start (Bybit unreachable, the key refused, a state document of another account, the account
// locked by another process) disables options only. The ASTER pairs keep running, /api/options answers 503
// options_unavailable for reads and writes, nothing is sent to Bybit's order endpoints, the lock is not held, Feishu says
// so once per reason, and the start is retried as a whole new start. Bybit and ASTER are fakes; nothing leaves the host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseServiceConfig } from '../src/service/config.ts';
import { holdAccountLocks } from '../src/live/setup.ts';
import { openOptionsStore } from '../src/options/store.ts';
import { OPTIONS_DATABASE } from '../src/service/options.ts';
import type { SocketLike } from '../src/service/stream.ts';
import { FakeAster, LONG, MAIN, SHORT } from './aster-fake.ts';
import { createOptionsClient } from '../src/options/client.ts';
import { createOptionsEngine } from '../src/options/engine.ts';
import { createOptionMarket } from '../src/options/market.ts';
import { DEFAULT_ESTIMATES } from '../src/options/strategy.ts';
import { FRIDAY, FakeOptions } from './options-fake.ts';

const APP = { index: Buffer.from('<!doctype html><title>t</title>'), assets: new Map() };
const OPTIONS_KEY = { apiKey: 'bybit-options-isolation-key-01', apiSecret: 'bybit-options-isolation-secret-0001aaaa' };
const FEISHU = { webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/options-isolation', secret: 'sec' };
// A UID per test, so the host account lock of one never meets another (or another file's).
let uidSeed = 700_000_000 + Math.floor(Math.random() * 1_000_000);
const nextUid = (): string => String(++uidSeed);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const linuxOnly = { skip: process.platform !== 'linux' && '服务进程只在 Linux 上运行' };
const ORDER_PATHS = ['/v5/order/create', '/v5/order/amend', '/v5/order/cancel', '/v5/rfq/create-rfq', '/v5/rfq/execute-quote'];

class Socket implements SocketLike {
  private listeners: Record<string, ((event: any) => void)[]> = {};
  addEventListener(type: string, listener: (event: any) => void): void { (this.listeners[type] ??= []).push(listener); }
  emit(type: string, extra: Record<string, unknown> = {}): void { for (const listener of this.listeners[type] ?? []) listener(extra); }
  send(): void { /* keepalive */ }
  close(): void { this.emit('close', { code: 1000, reason: '' }); }
}

async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise<number>(resolve => { const probe = createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address() as { port: number }; probe.close(() => resolve(port)); }); });
}
const outbox = (data: string): string[] => {
  const db = new DatabaseSync(join(data, 'notify.sqlite'));
  try { return (db.prepare('SELECT text FROM outbox ORDER BY id').all() as { text: string }[]).map(row => row.text); } finally { db.close(); }
};
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) { if (Date.now() > deadline) throw new Error(`等待超时：${what}`); await sleep(20); }
}

/** Bybit as seen by the options client: the fake, or down (every request fails), or hanging until the request is aborted. */
function bybit(uid: string, fake = new FakeOptions(Date.now)) {
  fake.uid = Number(uid);
  const calls: string[] = [];
  const control = { mode: 'up' as 'up' | 'down' | 'hang' };
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push(new URL(url).pathname);
    if (control.mode === 'down') throw new TypeError('fetch failed');
    if (control.mode === 'hang') return new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    return fake.fetch(url, init);
  };
  return { fake, calls, control, fetch };
}

async function runService(data: string, accountId: string, fetch: (url: string, init: RequestInit) => Promise<Response>, { retryMs = 150, preflightMs = 2_000 } = {}) {
  const { startService } = await import('../src/service/main.ts');
  const port = await freePort();
  rmSync(join(data, 'access-url'), { force: true });
  const notifyFetch = async () => new Response(JSON.stringify({ code: 0 }), { status: 200, headers: { 'content-type': 'application/json' } });
  const run = await startService({
    config: parseServiceConfig({ secretsFile: '/etc/tp/secrets.json', pairs: [{ id: 'p1', main: 'main', long: 'a', short: 'b' }], options: { accountId, limits: { maxRiskUsd: 500, maxMarginUsd: 1_000 } } }),
    secrets: { accounts: new Map([['main', MAIN], ['a', LONG], ['b', SHORT]]), feishu: FEISHU, bybitOptions: OPTIONS_KEY },
    dir: data, port, app: APP, fetchImpl: new FakeAster().fetch, notifyFetch, optionsFetch: fetch, optionsPreflightMs: preflightMs, optionsRetryMs: retryMs,
    connect: () => { const socket = new Socket(); queueMicrotask(() => socket.emit('open')); return socket; },
  });
  try {
    let link = '';
    for (let i = 0; i < 200 && !link; i++) { try { link = readFileSync(join(data, 'access-url'), 'utf8').trim().split('\n').at(-1)!; } catch { await sleep(20); } }
    const cookie = (await globalThis.fetch(link, { redirect: 'manual', headers: { connection: 'close' } })).headers.get('set-cookie')!.split(';')[0]!;
    const call = async (path: string, body?: unknown) => {
      const response = await globalThis.fetch(`http://127.0.0.1:${port}${path}`, body === undefined
        ? { headers: { cookie, connection: 'close' } }
        : { method: 'POST', headers: { cookie, connection: 'close', 'content-type': 'application/json', 'x-pa-executor': '1' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    return { run, call };
  } catch (error) { await run.shutdown(); await run.done; throw error; }
}

/** The ASTER side runs: the pair is listed and the transfer page reads. */
async function asterRuns(call: (path: string) => Promise<{ status: number; body: Record<string, any> }>): Promise<void> {
  const state = await call('/api/state');
  assert.equal(state.status, 200);
  assert.deepEqual(state.body.transfers.pairs.map((pair: { id: string }) => pair.id), ['p1']);
  assert.equal((await call('/api/transfer-pairs/p1/balances')).status, 200);
}

/** Every options route answers 503 options_unavailable naming the reason; writes too, before anything is sent. */
async function optionsRefused(call: (path: string, body?: unknown) => Promise<{ status: number; body: Record<string, any> }>, reason: RegExp): Promise<void> {
  for (const path of ['/api/options/state', '/api/options/market', '/api/options/performance', '/api/options/rfq']) {
    const answer = await call(path);
    assert.equal(answer.status, 503, path);
    assert.equal(answer.body.code, 'options_unavailable', path);
    assert.match(answer.body.message, reason, path);
  }
  const writes: [string, unknown][] = [
    ['/api/options/plans', { operation: 'open' }],
    ['/api/options/tasks', { planId: 'a'.repeat(32), requestId: 'isolation-1', confirmLive: true }],
    ['/api/options/auto-open', { enabled: true }],
    ['/api/options/rfq', { requestId: 'isolation-2', confirmLive: true }],
  ];
  for (const [path, body] of writes) { const answer = await call(path, body); assert.deepEqual([answer.status, answer.body.code], [503, 'options_unavailable'], path); }
}

async function lockFree(uid: string): Promise<boolean> {
  try { (await holdAccountLocks([{ venue: 'bybit', accountId: uid }], 'pa-options')).release(); return true; } catch { return false; }
}

test('期权启动：Bybit 不通 → 只停期权，ASTER 照常；接口 503、不持锁、飞书一条；恢复后重试启动并告知', linuxOnly, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-options-down-')), data = join(dir, 'data'), uid = nextUid();
  const venue = bybit(uid);
  venue.control.mode = 'down';
  try {
    const { run, call } = await runService(data, uid, venue.fetch);
    try {
      await asterRuns(call);
      await optionsRefused(call, /读不到 Bybit 账户信息/);
      // Several retries fail the same way: one Feishu message for the reason.
      const before = venue.calls.length;
      await until(() => venue.calls.length >= before + 2, '重试');
      await until(() => outbox(data).some(text => text.startsWith('【期权未启动】')), '飞书提醒');
      assert.ok(outbox(data).some(text => /^【服务启动】.*期权账户 1 个（未启动，后台重试）/.test(text)));

      venue.control.mode = 'up';
      await until(async () => (await call('/api/options/state')).status === 200, '恢复后启动');
      await until(() => outbox(data).some(text => text.startsWith('【期权已启动】')), '恢复通知');
      const texts = outbox(data);
      assert.equal(texts.filter(text => text.startsWith('【期权未启动】')).length, 1, `同一原因只提醒一次：${JSON.stringify(texts)}`);
      assert.match(texts.find(text => text.startsWith('【期权未启动】'))!, /ASTER 划转与 ADL 等其他模块照常运行/);
      assert.equal(await lockFree(uid), false, '启动后持有账户锁');
      assert.ok(!texts.join('\n').includes(OPTIONS_KEY.apiKey) && !texts.join('\n').includes(OPTIONS_KEY.apiSecret));
      await asterRuns(call);
    } finally { await run.shutdown(); await run.done; }
    assert.equal(await lockFree(uid), true, '停服后释放账户锁');
    assert.ok(!venue.calls.some(path => ORDER_PATHS.includes(path)), '没有任何下单或询价请求');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('期权启动：密钥被拒反复重试只提醒一次；状态库属于另一账户 → 只停期权，不发任何订单请求', linuxOnly, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-options-key-')), data = join(dir, 'data'), uid = nextUid(), other = nextUid();
  try {
    // The key lacks options trading: refused by the start check, every retry the same.
    const refused = bybit(uid);
    refused.fake.permissions = { ...refused.fake.permissions, Options: [] };
    const first = await runService(data, uid, refused.fetch);
    try {
      await asterRuns(first.call);
      await optionsRefused(first.call, /密钥没有通过启动检查/);
      await until(() => refused.calls.filter(path => path === '/v5/user/query-api').length >= 3, '三次启动检查');
      await until(() => outbox(data).some(text => text.startsWith('【期权未启动】')), '飞书提醒');
      await sleep(200);
      assert.equal(outbox(data).filter(text => text.startsWith('【期权未启动】')).length, 1);
    } finally { await first.run.shutdown(); await first.run.done; }

    // A healthy start writes options.sqlite for this UID ...
    const healthy = bybit(uid);
    const second = await runService(data, uid, healthy.fetch);
    try { assert.equal((await second.call('/api/options/state')).status, 200); } finally { await second.run.shutdown(); await second.run.done; }
    // (the engine saves its state document on its first change; written here as it would be)
    const store = openOptionsStore(join(data, OPTIONS_DATABASE));
    try { store.save({ uid, tasks: {}, journal: {}, tracked: { groupId: null, sizes: {} }, pmBaseline: null, executions: [] }); } finally { store.close(); }

    // ... which another account's config may not take over: the state is refused, options stays down, ASTER runs.
    // (the next retry is a minute away, so the lock probe below does not meet it)
    const foreign = bybit(other);
    const third = await runService(data, other, foreign.fetch, { retryMs: 60_000 });
    try {
      await asterRuns(third.call);
      await optionsRefused(third.call, /期权状态无法恢复/);
      assert.equal(await lockFree(other), true, '状态无法恢复时释放账户锁');
      assert.ok(foreign.calls.includes('/v5/user/query-api'), '启动检查本身通过');
    } finally { await third.run.shutdown(); await third.run.done; }
    for (const venue of [refused, healthy, foreign]) assert.ok(!venue.calls.some(path => ORDER_PATHS.includes(path)), '没有任何下单或询价请求');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('期权启动：账户被本机另一个进程占用 → 只停期权；对方释放后重试启动', linuxOnly, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-options-locked-')), data = join(dir, 'data'), uid = nextUid();
  const venue = bybit(uid);
  const held = await holdAccountLocks([{ venue: 'bybit', accountId: uid }], 'pa-options');
  let released = false;
  try {
    const { run, call } = await runService(data, uid, venue.fetch);
    try {
      await asterRuns(call);
      await optionsRefused(call, /另一个进程正占用此 Bybit 期权账户/);
      assert.equal(venue.calls.length, 0, '没取得锁就不读 Bybit');
      held.release(); released = true;
      await until(async () => (await call('/api/options/state')).status === 200, '释放后启动');
    } finally { await run.shutdown(); await run.done; }
  } finally { if (!released) held.release(); rmSync(dir, { recursive: true, force: true }); }
});

test('期权启动：停服时进行中的启动检查立即放弃，不等满超时，也不留锁', linuxOnly, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-options-stop-')), data = join(dir, 'data'), uid = nextUid();
  const venue = bybit(uid);
  venue.control.mode = 'down';
  try {
    const { run, call } = await runService(data, uid, venue.fetch, { retryMs: 100, preflightMs: 60_000 });
    try {
      await asterRuns(call);
      // The next retry hangs on Bybit (a 60 s start check).
      venue.control.mode = 'hang';
      const before = venue.calls.length;
      await until(() => venue.calls.length > before, '重试开始');
    } finally {
      const started = Date.now();
      await run.shutdown(); await run.done;
      assert.ok(Date.now() - started < 10_000, `停服用时 ${Date.now() - started} ms`);
    }
    assert.equal(await lockFree(uid), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('期权启动：启动检查超时 → 只停期权，ASTER 照常；接口 503 说明读不到 Bybit', linuxOnly, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-options-timeout-')), data = join(dir, 'data'), uid = nextUid();
  const venue = bybit(uid);
  venue.control.mode = 'hang';
  try {
    const started = Date.now();
    const { run, call } = await runService(data, uid, venue.fetch, { retryMs: 60_000, preflightMs: 300 });
    try {
      assert.ok(Date.now() - started < 10_000, '启动不被期权拖住');
      await asterRuns(call);
      await optionsRefused(call, /读不到 Bybit 账户信息/);
      assert.equal(await lockFree(uid), true, '超时后释放账户锁');
    } finally { await run.shutdown(); await run.done; }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('期权启动：重试通过后按服务启动规则恢复状态，进行中的任务改为恢复中并停止，只撤单核对、不补发下单', linuxOnly, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-options-recover-')), data = join(dir, 'data'), uid = nextUid();
  // A task left mid-way by an earlier process: its two wing orders rest on the venue (as in options.test.ts's restart case).
  const begun = Date.now(), now = () => FRIDAY + (Date.now() - begun);
  const fake = new FakeOptions(now);
  fake.uid = Number(uid);
  fake.fillMode = 'rest';
  const client = createOptionsClient({ credentials: OPTIONS_KEY, fetchImpl: fake.fetch });
  const earlier = mkdtempSync(join(tmpdir(), 'tp-options-earlier-')), earlierStore = openOptionsStore(join(earlier, OPTIONS_DATABASE));
  const engine = createOptionsEngine({
    client, market: createOptionMarket(client, { now }), store: earlierStore, uid, now, sleep: async () => { await sleep(2); }, pollMs: 20,
    settings: { maxRiskUsd: 50_000, maxMarginUsd: 50_000, legQty: '1', strategyMode: 'iron_condor', orderTimeoutMs: 30_000, estimates: DEFAULT_ESTIMATES },
  });
  const venue = bybit(uid, fake);
  try {
    const plan = await engine.createPlan({ operation: 'open' });
    const { taskId } = await engine.startTask({ planId: plan.planId, requestId: 'isolation-recover-1', confirmLive: true });
    await until(() => fake.orders.size === 2 && Object.keys(engine.state().journal).length === 2, '两条护翼挂单');
    // This service's data directory, made by a first start (options down), then given that state.
    venue.control.mode = 'down';
    const first = await runService(data, uid, venue.fetch, { retryMs: 60_000 });
    await first.run.shutdown(); await first.run.done;
    const mine = openOptionsStore(join(data, OPTIONS_DATABASE));
    try { mine.save(structuredClone(earlierStore.load())); } finally { mine.close(); }
    const resting = fake.orders.size;

    const { run, call } = await runService(data, uid, venue.fetch);
    try {
      await optionsRefused(call, /读不到 Bybit 账户信息/);
      venue.control.mode = 'up';
      await until(async () => (await call('/api/options/state')).status === 200, '恢复后启动');
      await until(() => [...fake.orders.values()].every(order => order.status === 'Cancelled'), '对账撤掉遗留挂单');
    } finally { await run.shutdown(); await run.done; }
    const saved = openOptionsStore(join(data, OPTIONS_DATABASE));
    try {
      const task = (saved.load() as { tasks: Record<string, { status: string; stopRequested: boolean }> }).tasks[taskId]!;
      assert.equal(task.stopRequested, true);
      assert.ok(['recovering', 'stopped'].includes(task.status), task.status);
    } finally { saved.close(); }
    assert.equal(fake.orders.size, resting, '没有新订单');
    assert.ok(!venue.calls.includes('/v5/order/create'), '服务没有补发下单');
    assert.ok(venue.calls.includes('/v5/order/cancel'), '撤单由本服务的对账发出');
  } finally {
    await engine.close().catch(() => undefined);
    try { earlierStore.close(); } catch { /* closed */ }
    rmSync(earlier, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
