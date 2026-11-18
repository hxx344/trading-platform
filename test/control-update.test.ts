import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { createControl } from '../src/control/main.ts';
import { createExecutorServer } from '../src/http.ts';
import { legacyUpdateJob } from '../src/service/update-legacy.ts';
import { takeUpdateRequest } from '../src/service/update-helper.ts';
import { takeImportRequest } from '../src/service/import-channel.ts';
import { createHarness } from './harness.ts';

test('在线更新经执行面授权，控制面校验原请求并沿用 root 助手的交接文件', async t => {
  const h = createHarness();
  t.after(() => h.dispose());
  const root = join(h.dir, 'releases', 'installed'), handoff = join(h.dir, 'handoff');
  mkdirSync(join(root, 'web', 'dist'), { recursive: true });
  mkdirSync(handoff);
  writeFileSync(join(root, 'web', 'dist', 'index.html'), '<title>控制面</title>');
  writeFileSync(join(root, 'VERSION'), 'v0.64.0 0123456789ab\n');
  writeFileSync(join(h.dir, '.update-helper'), 'enabled\n');
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\tp-update-${randomUUID()}` : join(h.dir, 'execution.sock');
  let checks = 0;
  const control = createControl({ current: root, socketPath, importDir: handoff, updateFetch: async () => {
    checks++;
    return Response.json({ tag_name: 'v0.65.0', name: '页面更新' });
  } });
  control.server.listen(0, '127.0.0.1');
  await once(control.server, 'listening');
  const port = (control.server.address() as AddressInfo).port, base = `http://127.0.0.1:${port}`;
  const legacyDir = join(h.dir, 'old-import');
  mkdirSync(legacyDir);
  const engine = createExecutorServer({ executor: h.ex, browserPort: port, accessToken: 'update-test-login',
    imports: { submit: () => { throw new Error('unexpected import'); }, latest: () => null, legacyUpdate: () => legacyUpdateJob(legacyDir) } });
  engine.listen(socketPath);
  await once(engine, 'listening');
  t.after(async () => {
    control.close();
    await Promise.all([control.server, engine].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  });
  const login = await fetch(base + '/login?token=update-test-login', { redirect: 'manual' });
  const cookie = login.headers.getSetCookie()[0].split(';')[0];
  const headers = { cookie, 'content-type': 'application/json', 'x-pa-executor': '1' };
  const post = (path: string, headers: Record<string, string>, body: string) => fetch(base + path, { method: 'POST', headers, body });
  assert.equal((await fetch(base + '/api/update', { headers: { 'x-trading-platform-control': '1' } })).status, 401);
  const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
    httpRequest(base + '/', { headers: { cookie, host: 'invalid.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject).end();
  });
  assert.equal(wrongHost, 421);
  const check = '/api/update/check', apply = '/api/update/apply';
  assert.equal((await post(check, { cookie }, '{}')).status, 403);
  assert.equal((await post(check, headers, 'bad')).status, 400);
  assert.equal((await post(check, headers, 'x'.repeat(16 * 1024 + 1))).status, 413);
  assert.equal(checks, 0);
  const checked = await post(check, headers, '{}');
  assert.equal(checked.status, 200);
  const view = await checked.json() as { current: { version: string }; enabled: boolean; available: boolean };
  assert.deepEqual([view.current.version, view.enabled, view.available, checks], ['v0.64.0', true, true, 1]);
  const file = join(handoff, 'update-request.json');
  const oldJob = { id: randomUUID(), version: 'v0.64.0', from: 'v0.63.0', startedAt: Date.now(), at: Date.now(), phase: 'running', message: '正在切换', output: [] };
  const oldResult = join(legacyDir, 'update-result.json');
  const earlier = { ...oldJob, id: randomUUID(), startedAt: oldJob.startedAt - 1000, at: oldJob.at - 900, phase: 'done' };
  // A downgrade and a second migration leave a valid result from the first split installation behind.
  writeFileSync(join(handoff, 'update-result.json'), JSON.stringify(earlier));
  writeFileSync(oldResult, JSON.stringify(oldJob));
  const statusJob = async () => (await (await fetch(base + '/api/update', { headers })).json() as { job: typeof oldJob | null }).job;
  assert.deepEqual(await statusJob(), oldJob);
  assert.equal((await post(apply, headers, '{"version":"v0.65.0"}')).status, 409, '迁移更新仍在进行');
  oldJob.phase = 'done';
  writeFileSync(oldResult, JSON.stringify(oldJob));
  assert.deepEqual(await statusJob(), oldJob, '旧浏览器继续跟踪原请求编号');
  assert.equal((await post(apply, headers, '{"version":"v0.64.1"}')).status, 409);
  assert.equal(existsSync(file), false);
  const body = '{"version":"v0.65.0"}';
  const accepted = await post(apply, headers, body);
  assert.equal(accepted.status, 200);
  const { pending } = await accepted.json() as { pending: { id: string } };
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual([saved.id, saved.version], [pending.id, 'v0.65.0']);
  assert.deepEqual(await statusJob(), earlier, '新目录已有待处理请求时优先显示新目录的记录');
  assert.equal((await post(apply, headers, body)).status, 409);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), saved);
});

test('页面助手将误投的目录移出监听路径，保留内容并能处理下一份请求', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-handoff-'));
  try {
    const owner = { uid: statSync(dir).uid };
    for (const [name, take] of [['request.json', takeImportRequest], ['update-request.json', takeUpdateRequest]] as const) {
      const path = join(dir, name);
      mkdirSync(path);
      writeFileSync(join(path, 'keep'), '保留');
      assert.ok('invalid' in take(dir, owner)!);
      assert.equal(existsSync(path), false);
      const quarantine = readdirSync(dir).find(item => item.startsWith(name + '.taken-'))!;
      assert.equal(readFileSync(join(dir, quarantine, 'keep'), 'utf8'), '保留');
      assert.equal(take(dir, owner), null);
      const request = { id: randomUUID(), at: Date.now(), ...(name === 'request.json' ? { action: 'preview' } : { version: 'v0.65.0' }) };
      writeFileSync(path, JSON.stringify(request));
      assert.equal((take(dir, owner) as { id: string }).id, request.id);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
