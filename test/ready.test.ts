// The login-free readiness probe an outside watchdog asks: what it answers without a session, that it tells nothing
// else, and how the run loop decides (every tracked loop finished a round recently, the lease held, not stopping).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { createExecutorServer } from '../src/http.ts';
import { READY_STALE_MS, loopsReady, runExecutor } from '../src/runtime.ts';
import type { Executor } from '../src/executor.ts';
import type { Store } from '../src/store.ts';
import { bindAccounts, createHarness } from './harness.ts';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('就绪接口：不登录可读，只答就绪与否；其余接口照旧须登录', async () => {
  const h = createHarness();
  bindAccounts(h.ex);
  let ready = true;
  const servers = [
    createExecutorServer({ executor: h.ex, accessToken: 'ready-access-token-0001', session: 'ready-session-value-0001', ready: () => ready }),
    createExecutorServer({ executor: h.ex, accessToken: 'ready-access-token-0001', session: 'ready-session-value-0001' }),
  ];
  for (const server of servers) await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const [base, bare] = servers.map(server => `http://127.0.0.1:${(server.address() as AddressInfo).port}`) as [string, string];
  try {
    const up = await fetch(`${base}/api/ready`);
    assert.equal(up.status, 200);
    assert.equal(up.headers.get('cache-control'), 'no-store');
    assert.equal(up.headers.get('set-cookie'), null, '不发会话');
    assert.deepEqual(await up.json(), { ready: true });
    ready = false;
    const down = await fetch(`${base}/api/ready?detail=1`);
    assert.equal(down.status, 503);
    assert.deepEqual(await down.json(), { ready: false }, '未就绪时也不带原因');

    // Only this exact path and method are open.
    for (const path of ['/api/status', '/api/state', '/api/logs', '/api/ready/', '/api/ready/x', '/api/readyz']) assert.equal((await fetch(`${base}${path}`)).status, 401, path);
    for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await fetch(`${base}/api/ready`, { method })).status, 401, method);
    assert.equal((await fetch(`${bare}/api/ready`)).status, 401, '入口没提供判定时没有这个接口');

    // The Host check comes first, as for every other path.
    const status = await new Promise<number>((resolve, reject) => {
      const probe = httpRequest(`${base}/api/ready`, { headers: { host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode ?? 0); });
      probe.on('error', reject); probe.end();
    });
    assert.equal(status, 421);
  } finally { for (const server of servers) server.close(); h.ex.close(); h.store.close(); }
});

test('就绪判定：每个循环都在时限内完成过一轮才算就绪', () => {
  const tick = 5_000_000;
  assert.equal(loopsReady([{ okTick: tick }, { okTick: tick - READY_STALE_MS }], tick), true);
  assert.equal(loopsReady([{ okTick: tick }, { okTick: tick - READY_STALE_MS - 1 }], tick), false, '一个循环超时就不就绪');
  assert.equal(loopsReady([{ okTick: tick }, { okTick: null }], tick), false, '还没完成过一轮');
  assert.equal(loopsReady([], tick), true, '没有被跟踪的循环时不拦（运行循环总会登记循环）');
});

/** A run over a stand-in executor whose transfer and ADL rounds the test can hold. */
async function standInRun(drainMs: number) {
  const dir = mkdtempSync(join(tmpdir(), 'tp-ready-'));
  const held = { transfers: null as Promise<void> | null, adl: null as Promise<void> | null, transferRounds: 0 };
  const executor = {
    budgets: { leaseTtlMs: 60_000, positionsRefreshMs: 15_000 }, retired: false, generation: 1,
    acquire: () => true,
    tickTransfers: () => { held.transferRounds++; return held.transfers ?? Promise.resolve(); },
    tickAdl: () => held.adl ?? Promise.resolve(),
    maintain: () => undefined, refreshPositions: async () => undefined, stopSending: () => undefined, close: () => undefined,
  } as unknown as Executor & { retired: boolean };
  const store = { maintainWal: () => ({ walBytes: 0 }), close: () => undefined } as unknown as Store;
  const exitCode = process.exitCode;
  const hold = (name: 'transfers' | 'adl'): (() => void) => { let release!: () => void; held[name] = new Promise<void>(resolve => { release = resolve; }); return () => { held[name] = null; release(); }; };
  const releaseAdl = hold('adl');
  const run = runExecutor({ executor, store, dir, port: 0, passes: ['transfers', 'adl'], startedMessage: 'test', drainMs, log: () => undefined });
  const releases = [releaseAdl];
  const close = async () => {
    for (const release of releases) release();
    await run.shutdown();
    process.removeAllListeners('SIGINT'); process.removeAllListeners('SIGTERM');
    process.exitCode = exitCode;
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    let link = '';
    for (let i = 0; i < 200 && !link; i++) { try { link = readFileSync(join(dir, 'access-url'), 'utf8').trim(); } catch { await wait(10); } }
    const origin = new URL(link).origin;
    const until = async (status: number) => { let got = 0; for (let i = 0; i < 200 && got !== status; i++) { got = (await fetch(`${origin}/api/ready`)).status; if (got !== status) await wait(10); } return got; };
    return { run, executor, held, origin, releaseAdl, until, close, hold: (name: 'transfers' | 'adl') => { const release = hold(name); releases.push(release); return release; } };
  } catch (error) { await close(); throw error; }
}

test('运行循环：有循环没完成过一轮时不就绪，都转起来后就绪；失去租约后不就绪', async () => {
  const s = await standInRun(0);
  try {
    await wait(60);
    assert.equal((await fetch(`${s.origin}/api/ready`)).status, 503, 'ADL 循环卡在第一轮');
    s.releaseAdl();
    assert.equal(await s.until(200), 200);
    s.executor.retired = true;
    assert.equal((await fetch(`${s.origin}/api/ready`)).status, 503, '失去写入租约');
    await s.run.done;
    await assert.rejects(fetch(`${s.origin}/api/ready`), '停止后不再监听');
  } finally { await s.close(); }
});

test('运行循环：停止中（等进行中的一轮结束时）不就绪', { timeout: 15_000 }, async () => {
  const s = await standInRun(5_000);
  const socket = connect(Number(new URL(s.origin).port), '127.0.0.1');
  try {
    s.releaseAdl();
    assert.equal(await s.until(200), 200);
    // A round in progress keeps the stop draining. A request already begun on an open connection is still answered
    // after the listener closes, so it shows what the probe is told meanwhile.
    const rounds = s.held.transferRounds;
    const releaseTransfers = s.hold('transfers');
    for (let i = 0; i < 300 && s.held.transferRounds === rounds; i++) await wait(10);
    assert.ok(s.held.transferRounds > rounds, '划转循环进入被按住的一轮');
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); if (!socket.connecting) resolve(); });
    socket.write('GET /api/ready HTTP/1.1\r\nHost: 127.0.0.1\r\n');
    await wait(50);
    const stopped = s.run.shutdown();
    let answer = '';
    const answered = new Promise<void>(resolve => { socket.on('data', chunk => { answer += chunk.toString('latin1'); if (answer.includes('}')) resolve(); }); socket.on('close', () => resolve()); setTimeout(resolve, 5_000).unref(); });
    socket.write('\r\n');
    await answered;
    assert.match(answer, /^HTTP\/1\.1 503 /);
    assert.match(answer, /\{"ready":false\}/);
    releaseTransfers();
    await stopped;
  } finally { socket.destroy(); await s.close(); }
});
