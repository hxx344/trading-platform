// Exercise the installed control CLI against a separate real executor with simulated exchanges. During the outage
// the test observes committed SQLite rows through a read-only connection and never drives an executor tick itself.
import assert from 'node:assert/strict';
import { fork, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { connect, createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { Executor } from '../src/executor.ts';
import { SIM_TRANSFER_PAIR } from '../src/simulation.ts';
import type { ExchangeSnapshot } from './fixtures/continuity-executor.ts';
import { openIntent } from './harness.ts';

interface State {
  generation: number;
  jobs: ReturnType<Executor['recentJobs']>;
  transfers: { recent: ReturnType<Executor['recentTransfers']> };
  adl: { recent: ReturnType<Executor['recentAdlIncidents']> };
}
interface Status { health: { startedAt: number; generation: number }; exchange: ExchangeSnapshot }
const EXECUTION_BUILD = 'a'.repeat(64);

async function until<T>(description: string, read: () => T | null | Promise<T | null>): Promise<T> {
  const deadline = performance.now() + 20_000;
  do {
    const value = await read();
    if (value !== null) return value;
    await pause(50);
  } while (performance.now() < deadline);
  throw new Error(`等待超时：${description}`);
}

function watch(child: ChildProcess) {
  let errors = '';
  child.stderr?.setEncoding('utf8').on('data', text => { errors += text; });
  const closed = new Promise<void>(resolve => child.once('close', resolve));
  return {
    child,
    check() { assert.ok(child.exitCode === null && child.signalCode === null, `子进程提前退出：${errors}`); },
    async kill() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
    },
  };
}

function release(dir: string, version: string, script: string): string {
  const root = join(dir, version), dist = join(root, 'web', 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(root, 'VERSION'), `${version} 0123456789ab\n`);
  writeFileSync(join(root, '.executor-sha256'), EXECUTION_BUILD);
  writeFileSync(join(dist, 'index.html'), `<!doctype html><title>${version}</title><script src="/assets/${script}"></script>`);
  writeFileSync(join(dist, 'assets', script), `document.title = "${version}";`);
  return root;
}

test('更换页面版本、杀掉并重启控制面期间，两腿交易、保证金划转和 ADL 按原记录继续', { timeout: 90_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-continuity-'));
  const children: ReturnType<typeof watch>[] = [];
  let db: DatabaseSync | undefined;
  t.after(async () => {
    db?.close();
    await Promise.all(children.map(service => service.kill()));
    rmSync(dir, { recursive: true, force: true });
  });
  const current = join(dir, 'current'), next = join(dir, 'next'), listen = join(dir, 'listen.json');
  symlinkSync(release(dir, 'v0.64.0', 'old.js'), current, 'junction');
  symlinkSync(release(dir, 'v0.64.1', 'new.js'), next, 'junction');
  const socket = process.platform === 'win32' ? `\\\\.\\pipe\\tp-continuity-${randomUUID()}` : join(dir, 'executor.sock');
  const reservation = createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = (reservation.address() as AddressInfo).port, base = `http://127.0.0.1:${port}`;
  writeFileSync(listen, JSON.stringify({ port, host: null }));
  const execution = watch(fork(new URL('./fixtures/continuity-executor.ts', import.meta.url), [dir, socket, String(port), EXECUTION_BUILD], {
    execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  }));
  children.push(execution);
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  async function startControl() {
    const main = fileURLToPath(new URL('../src/control/main.ts', import.meta.url));
    const service = watch(spawn(process.execPath, [main, '--current', current, '--socket', socket, '--listen-file', listen], { stdio: ['ignore', 'ignore', 'pipe'] }));
    children.push(service);
    await until('控制面就绪', async () => {
      execution.check(); service.check();
      try {
        const response = await fetch(base + '/api/ready', { signal: AbortSignal.timeout(2_000) });
        const value = await response.json() as { ready: boolean };
        return response.ok && value.ready ? true : null;
      } catch { return null; }
    });
    return service;
  }
  const original = await startControl();
  assert.equal((await fetch(base + '/api/state')).status, 401);
  const login = await fetch(readFileSync(join(dir, 'access-url'), 'utf8').trim(), { redirect: 'manual' });
  assert.equal(login.status, 303);
  const cookie = login.headers.getSetCookie()[0]?.split(';')[0];
  assert.ok(cookie);
  const headers = { cookie, 'x-pa-executor': '1', 'content-type': 'application/json' };
  async function api<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(base + path, { headers, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5_000) });
    const payload = await response.text();
    assert.equal(response.status, 200, `${path}：${payload}`);
    return JSON.parse(payload) as T;
  }
  async function page(path: string) {
    const response = await fetch(base + path, { headers: { cookie } });
    assert.equal(response.status, 200);
    return response.text();
  }
  assert.match(await page('/'), /\/assets\/old\.js/);
  assert.match(await page('/assets/old.js'), /v0\.64\.0/);

  const preview = await api<{ id: string }>('/api/preview', openIntent({ orderType: 'limit', limitPrice: '70', timeoutMs: 120_000 }));
  const confirm = { previewId: preview.id, requestId: randomUUID(), confirmLive: true };
  // The client sends the complete confirm and never reads the reply. Its only recovery after the crash is the same
  // session and request ID. A second client can see the committed job while this connection is paused.
  const pendingReply = connect(port, '127.0.0.1');
  t.after(() => pendingReply.destroy());
  await once(pendingReply, 'connect');
  pendingReply.on('error', () => { /* control can reset this connection when killed */ });
  pendingReply.pause();
  const body = JSON.stringify(confirm);
  pendingReply.write(['POST /api/confirm HTTP/1.1', `Host: 127.0.0.1:${port}`, `Cookie: ${cookie}`, 'X-PA-Executor: 1',
    'Content-Type: application/json', `Content-Length: ${Buffer.byteLength(body)}`, '', body].join('\r\n'));
  const enablePath = `/api/transfer-pairs/${SIM_TRANSFER_PAIR.id}/enable`, enable = { requestId: randomUUID() };
  await api(enablePath, enable);
  execution.child.send('adl');
  const active = await until('交易首腿挂单、划转发送中、ADL 第一批挂单', async () => {
    execution.check();
    const state = await api<State>('/api/state');
    const [job] = state.jobs, [transfer] = state.transfers.recent, [incident] = state.adl.recent;
    return job?.legs[0].operation?.state === 'open' && transfer?.state === 'sending' && incident?.batches[0]?.state === 'open'
      ? { job, transfer, incident } : null;
  });
  const before = await api<Status>('/api/status');
  assert.equal(before.exchange.pid, execution.child.pid);
  assert.notEqual(before.exchange.pid, original.child.pid);
  assert.deepEqual(before.exchange.arrivals, { lead: 1, hedge: 0, transfer: 0, reduction: 1 });

  // Linux replaces the active symlink atomically and reloads via systemd's signal. A Windows junction must first be
  // unlinked. The first request through the same live control process then observes the new physical release.
  if (process.platform === 'win32') unlinkSync(current);
  renameSync(next, current);
  if (process.platform !== 'win32') original.child.kill('SIGHUP');
  await until('同一控制进程提供新页面', async () => { original.check(); return (await page('/')).includes('/assets/new.js') ? true : null; });
  assert.match(await page('/assets/new.js'), /v0\.64\.1/);
  assert.match(await page('/assets/old.js'), /v0\.64\.0/, '切换前已发出的 HTML 仍能载入自己的脚本');
  assert.equal((await api<State>('/api/state')).jobs[0].id, active.job.id);
  await original.kill();
  pendingReply.destroy();
  const downAt = performance.now();
  await assert.rejects(fetch(base + '/api/ready', { signal: AbortSignal.timeout(1_500) }));
  execution.child.send('fill-and-deliver');
  db = new DatabaseSync(join(dir, 'executor.sqlite'), { readOnly: true });
  const rows = db.prepare(`SELECT j.status AS job, t.state AS transfer, a.status AS adl FROM jobs j, transfers t, adl_incidents a
    WHERE j.id = ? AND t.id = ? AND a.id = ? AND j.final = 1 AND t.settled = 1 AND a.final = 1`);
  const settled = await until('控制面离线时三条原记录全部持久化结清', () => {
    execution.check();
    return rows.get(active.job.id, active.transfer.id, active.incident.id) ?? null;
  });
  assert.deepEqual({ ...settled }, { job: 'completed', transfer: 'confirmed', adl: 'completed' });
  const offlineMs = Math.round(performance.now() - downAt);

  const replacement = await startControl();
  assert.notEqual(replacement.child.pid, original.child.pid);
  assert.match(await page('/'), /\/assets\/new\.js/);
  const probe = () => spawnSync(process.execPath, [fileURLToPath(new URL('../src/control/probe.ts', import.meta.url)),
    '--current', current, '--listen-file', listen], { encoding: 'utf8', timeout: 6_000 });
  const healthy = probe();
  assert.equal(healthy.status, 0, healthy.stderr);
  const replay = await api<{ duplicate: boolean; job: { id: string } }>('/api/confirm', confirm);
  assert.deepEqual([replay.duplicate, replay.job.id], [true, active.job.id]);
  await api(enablePath, enable);
  const state = await api<State>('/api/state'), status = await api<Status>('/api/status');
  assert.deepEqual([status.exchange.pid, status.health.startedAt, state.generation], [before.exchange.pid, before.health.startedAt, before.health.generation]);
  const [job] = state.jobs, [transfer] = state.transfers.recent, [incident] = state.adl.recent;
  assert.deepEqual([state.jobs.length, state.transfers.recent.length, state.adl.recent.length], [1, 1, 1]);
  assert.deepEqual([job.id, transfer.id, incident.id], [active.job.id, active.transfer.id, active.incident.id]);
  assert.deepEqual(job.legs.map(leg => leg.filledQuantity), ['1', '1']);
  assert.deepEqual(job.legs.map(leg => leg.operation?.clientOrderId), status.exchange.orderIds);
  assert.equal(job.legs[0].operation?.clientOrderId, active.job.legs[0].operation?.clientOrderId);
  assert.deepEqual([transfer.amount, transfer.asset, transfer.receipt], ['100', 'USD1', status.exchange.transfers[0].tranId]);
  assert.deepEqual(status.exchange.balances, ['500', '500']);
  assert.deepEqual(incident.batches.map(batch => [batch.state, batch.filledQuantity]).reverse(), [['done', '0.016'], ['done', '0.004']]);
  assert.deepEqual(incident.batches.map(batch => batch.clientOrderId).reverse(), status.exchange.reductions.map(order => order.clientOrderId));
  assert.equal(incident.batches.at(-1)?.clientOrderId, active.incident.batches[0].clientOrderId);
  assert.equal(incident.evidence[0].handledQuantity, '0.02');
  assert.deepEqual(status.exchange.positions, ['0.03', '-0.03']);
  assert.deepEqual(status.exchange.arrivals, { lead: 1, hedge: 1, transfer: 1, reduction: 2 });
  t.diagnostic(`控制 PID ${original.child.pid} → ${replacement.child.pid}，执行 PID ${status.exchange.pid}、租约代次 ${state.generation} 持续运行。控制面离线 ${offlineMs} ms 内完成两腿各 1、划转 100 USD1、ADL 两批共 0.02 BTC。`);

  // Shutdown in the other direction: an otherwise live control must not serve a cached page or advertise readiness.
  await execution.kill();
  const unavailable = await fetch(base + '/api/ready');
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { ready: false });
  assert.equal((await fetch(base + '/', { headers: { cookie } })).status, 503);
  assert.equal(probe().status, 1, '执行面退出后，正式部署探针必须拒绝认定切换成功');
});
