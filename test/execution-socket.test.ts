import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { openSessionStore } from '../src/sessions.ts';
import { CLIENT_ADDRESS_HEADER, CONFIG_CHECK_HEADER, CONFIG_MATCH_HEADER, CONTROL_HEADER, EXECUTION_HEADER, LEGACY_UPDATE_HEADER, LISTEN_HEADER, sessionCookieName } from '../src/http-public.ts';
import { PASSWORD_FILE, hashPassword, loadPasswordHash, parsePasswordHash } from '../src/login-password.ts';
import { runExecutor } from '../src/runtime.ts';
import { configFingerprint, fingerprintReader } from '../src/service/config-fingerprint.ts';
import { loadServiceConfig, loadServiceSecrets } from '../src/service/config.ts';
import { UPDATE_RESULT_FILE, UPDATE_RUNNING_STALE_MS, legacyUpdateJob } from '../src/service/update-legacy.ts';
import { createHarness } from './harness.ts';

const socketFor = (dir: string) => process.platform === 'win32' ? `\\\\.\\pipe\\tp-executor-${randomUUID()}` : join(dir, 'executor.sock');
function call(socketPath: string, path: string, headers: Record<string, string> = {}, method = 'GET', body?: string): Promise<{ status: number; headers: IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method, headers, agent: false }, res => {
      res.setEncoding('utf8');
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('拆分执行器只监听本地套接字，沿用浏览器端口和会话，只在版本、Host、登录与写入标记都正确时交接控制请求', async () => {
  const h = createHarness();
  const publicServer = createServer((_req, res) => res.end('public'));
  await new Promise<void>(resolve => publicServer.listen(0, '127.0.0.1', resolve));
  const port = (publicServer.address() as AddressInfo).port;
  const socketPath = socketFor(h.dir);
  const build = 'a'.repeat(64);
  const configBuild = 'b'.repeat(64);
  const host = `100.101.102.103:${port}`;
  const forwarded = { host, [EXECUTION_HEADER]: build };
  const imported: unknown[] = [];
  const logs: string[] = [];
  const password = parsePasswordHash(await hashPassword('test-local-login'));
  let allowPositions!: () => void;
  const firstRead = new Promise<void>(resolve => { allowPositions = resolve; });
  const refresh = h.ex.refreshPositions;
  h.ex.refreshPositions = async () => { await firstRead; return refresh(); };
  const run = runExecutor({ executor: h.ex, store: h.store, dir: h.dir, port, socketPath, executionBuild: build, configBuild, sessions: openSessionStore({ file: join(h.dir, 'http-session'), epoch: 'e' }), startedMessage: 'test',
    password, log: line => logs.push(line), listen: { address: '100.101.102.103', urlHost: '100.101.102.103' },
    imports: { latest: () => null, submit: body => { imported.push(body); return { id: 'test', at: 1 }; }, legacyUpdate: () => legacyUpdateJob(h.dir) } });
  try {
    const access = join(h.dir, 'access-url');
    for (let i = 0; i < 200 && !existsSync(access); i++) await delay(10);
    const [tailnet, loopback] = readFileSync(access, 'utf8').trim().split('\n').map(line => new URL(line));
    if (process.platform !== 'win32') assert.equal(statSync(socketPath).mode & 0o777, 0o660);
    assert.equal(tailnet.host, host);
    assert.equal(loopback.host, `127.0.0.1:${port}`);
    assert.equal(tailnet.search, loopback.search);
    assert.equal(await (await fetch(loopback)).text(), 'public', '页面端口由既有控制服务持有');

    for (const path of ['/api/ready', '/', '/api/state', '/api/import']) {
      const wrong = await call(socketPath, path, { host, [EXECUTION_HEADER]: 'old', [CONTROL_HEADER]: '1' });
      assert.equal(wrong.status, 503, path);
      assert.equal(JSON.parse(wrong.text).code, 'execution_version');
      assert.equal(wrong.headers[CONTROL_HEADER], undefined);
      assert.equal(wrong.headers[EXECUTION_HEADER], build);
      assert.equal(wrong.headers[LISTEN_HEADER], undefined);
    }
    assert.equal((await call(socketPath, '/api/ready', { host })).status, 503);
    assert.equal((await call(socketPath, '/api/ready', { host: 'example.invalid' })).status, 421);
    const warming = await call(socketPath, '/api/ready', { ...forwarded, [CONFIG_CHECK_HEADER]: configBuild });
    assert.equal(warming.status, 503);
    assert.deepEqual(JSON.parse(warming.text), { ready: false });
    assert.equal(warming.headers[EXECUTION_HEADER], build);
    assert.equal(warming.headers[CONFIG_MATCH_HEADER], '1');
    assert.equal(warming.headers[LISTEN_HEADER], JSON.stringify([port, '100.101.102.103']));
    allowPositions();
    const ready = await call(socketPath, '/api/ready', forwarded);
    assert.equal(ready.status, 200);
    assert.deepEqual(JSON.parse(ready.text), { ready: true });
    assert.equal(ready.headers[EXECUTION_HEADER], build);
    assert.equal(ready.headers[CONTROL_HEADER], undefined);
    assert.equal(ready.headers[CONFIG_MATCH_HEADER], undefined);
    assert.equal((await call(socketPath, '/api/ready', { ...forwarded, [CONFIG_CHECK_HEADER]: 'short' })).headers[CONFIG_MATCH_HEADER], undefined);
    assert.equal((await call(socketPath, '/api/ready', { ...forwarded, [CONFIG_CHECK_HEADER]: '9'.repeat(64) })).headers[CONFIG_MATCH_HEADER], '0');

    const login = await call(socketPath, tailnet.pathname + tailnet.search, forwarded);
    assert.equal(login.status, 303);
    const cookie = login.headers['set-cookie']![0]!.split(';')[0]!;
    assert.match(cookie, new RegExp(`^${sessionCookieName(port)}=[A-Za-z0-9_-]{43}$`));
    assert.match(login.headers['set-cookie']![0]!, /HttpOnly; SameSite=Strict; Path=\/; Max-Age=/);
    const form = { ...forwarded, origin: `http://${host}`, 'content-type': 'application/x-www-form-urlencoded' };
    const badPassword = await call(socketPath, '/login', { ...form, [CLIENT_ADDRESS_HEADER]: 'arbitrary text' }, 'POST', 'password=wrong');
    assert.equal(badPassword.status, 401);
    assert.ok(logs.some(line => line.includes('密码错误（来自 未知地址）')));
    const byPassword = await call(socketPath, '/login', { ...form, [CLIENT_ADDRESS_HEADER]: '100.99.98.97' }, 'POST', 'password=test-local-login');
    assert.match(byPassword.headers['set-cookie']![0]!, /HttpOnly; SameSite=Strict; Path=\/; Max-Age=/);
    assert.notEqual(byPassword.headers['set-cookie']![0], login.headers['set-cookie']![0], '每次登录各自一个会话');
    assert.ok(logs.some(line => line.includes('密码登录成功（来自 100.99.98.97，')));
    const authorized = { ...forwarded, cookie };
    const write = { ...authorized, 'x-pa-executor': '1', 'content-type': 'application/json' };
    for (const [path, method] of [['/', 'GET'], ['/assets/app.js', 'GET'], ['/api/update', 'GET'], ['/api/update/check', 'POST'], ['/api/update/apply', 'POST']]) {
      const denied = await call(socketPath, path, { ...forwarded, [CONTROL_HEADER]: '1' }, method);
      assert.equal(denied.status, 401, path);
      assert.equal(denied.headers[CONTROL_HEADER], undefined);
      if (path === '/') assert.match(denied.text, /type="password"/);
      else assert.equal(JSON.parse(denied.text).code, 'session');
      const granted = await call(socketPath, path, method === 'POST' ? write : authorized, method);
      assert.equal(granted.status, 204, path);
      assert.equal(granted.text, '');
      assert.equal(granted.headers[CONTROL_HEADER], '1');
    }
    for (const headers of [authorized, { ...authorized, 'x-pa-executor': '1', 'content-type': 'text/plain' }]) {
      const denied = await call(socketPath, '/api/update/apply', headers, 'POST');
      assert.equal(denied.status, 403);
      assert.equal(denied.headers[CONTROL_HEADER], undefined);
    }
    const resultPath = join(h.dir, UPDATE_RESULT_FILE);
    const oldJob = { id: randomUUID(), version: 'v0.64.0', from: 'v0.63.0', startedAt: Date.now(), at: Date.now(),
      phase: 'running', step: 'install', message: '正在升级', output: ['已检查配置'] };
    const legacy = { ...authorized, [LEGACY_UPDATE_HEADER]: '1' };
    const legacyWrite = { ...write, [LEGACY_UPDATE_HEADER]: '1' };
    writeFileSync(resultPath, JSON.stringify({ ...oldJob, privateNote: '内部字段' }));
    assert.equal((await call(socketPath, '/api/update', { ...forwarded, [LEGACY_UPDATE_HEADER]: '1' })).status, 401);
    assert.equal((await call(socketPath, '/api/update', authorized)).status, 204);
    const oldStatus = await call(socketPath, '/api/update', legacy);
    assert.equal(oldStatus.status, 200);
    assert.equal(oldStatus.headers[CONTROL_HEADER], '1');
    assert.deepEqual(JSON.parse(oldStatus.text), { job: oldJob });
    const busy = await call(socketPath, '/api/update/apply', legacyWrite, 'POST');
    assert.equal(busy.status, 409);
    assert.equal(JSON.parse(busy.text).code, 'update_busy');
    writeFileSync(resultPath, JSON.stringify({ ...oldJob, startedAt: Date.now() - UPDATE_RUNNING_STALE_MS - 1 }));
    assert.equal(JSON.parse((await call(socketPath, '/api/update', legacy)).text).job.stale, true);
    assert.equal((await call(socketPath, '/api/update/apply', legacyWrite, 'POST')).status, 204);
    for (const bad of [JSON.stringify({ phase: 'running' }), 'x'.repeat(65537)]) {
      writeFileSync(resultPath, bad);
      assert.equal((await call(socketPath, '/api/update', legacy)).status, 204);
    }
    for (const [path, method] of [['/api/update/apply', 'GET'], ['/api/update/check/', 'POST'], ['/assets/sub/app.js', 'GET'], ['/', 'HEAD']]) {
      const wrong = await call(socketPath, path, write, method);
      assert.equal(wrong.status, 404, path);
      assert.equal(wrong.headers[CONTROL_HEADER], undefined);
    }
    const badBuild = await call(socketPath, '/api/import', { ...write, [EXECUTION_HEADER]: 'old' }, 'POST', '{"module":"oil"}');
    assert.equal(badBuild.status, 503);
    assert.deepEqual(imported, []);
    const saved = await call(socketPath, '/api/import', write, 'POST', '{"module":"oil"}');
    assert.equal(saved.status, 200);
    assert.equal(saved.headers[CONTROL_HEADER], undefined);
    assert.deepEqual(imported, [{ module: 'oil' }]);
    assert.equal((await call(socketPath, '/api/state', authorized)).status, 200);
  } finally {
    allowPositions();
    await run.shutdown();
    await new Promise(resolve => publicServer.close(resolve));
    h.dispose();
  }
});

test('安装器指纹与执行器实际解析的三个文件一致，密钥、口令或权限变化均可检测', { skip: process.platform !== 'linux' && '真实文件属主与私有权限校验仅支持 Linux' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-config-fingerprint-'));
  const path = join(dir, 'config.json'), key = join(dir, 'external-key.json'), password = join(dir, PASSWORD_FILE);
  const loaded = () => {
    const files = fingerprintReader();
    const config = loadServiceConfig(path, files.read);
    loadServiceSecrets(config, files.read);
    loadPasswordHash(password, files.read);
    return files.digest();
  };
  try {
    writeFileSync(path, JSON.stringify({ pairs: [], secretsFile: key }), { mode: 0o600 });
    writeFileSync(key, JSON.stringify({ accounts: {} }), { mode: 0o600 });
    const first = loaded();
    assert.equal(first, configFingerprint(path));
    writeFileSync(key, '{"accounts": {}}\n');
    const keysChanged = loaded();
    assert.notEqual(keysChanged, first);
    assert.equal(keysChanged, configFingerprint(path));
    writeFileSync(password, await hashPassword('test-page-password'), { mode: 0o600 });
    assert.notEqual(loaded(), keysChanged);
    assert.equal(loaded(), configFingerprint(path));
    chmodSync(key, 0o644);
    assert.throws(() => configFingerprint(path), /权限过宽/);
    chmodSync(key, 0o600);
    writeFileSync(key, 'x'.repeat(65537));
    assert.throws(() => configFingerprint(path), /64 KiB/);
    rmSync(key);
    assert.throws(() => configFingerprint(path), /密钥文件.*ENOENT/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('执行器启动时已有进程持有套接字，启动失败后原监听仍可用', async () => {
  const h = createHarness(), socketPath = socketFor(h.dir);
  const owner = createServer((_req, res) => res.end('original'));
  await new Promise<void>(resolve => owner.listen(socketPath, resolve));
  const previousExitCode = process.exitCode;
  let reason = '';
  const run = runExecutor({ executor: h.ex, store: h.store, dir: h.dir, port: 4720, socketPath, startedMessage: 'test',
    log: () => undefined, onStopping: value => { reason = value; } });
  try {
    await run.done;
    assert.equal(reason, 'listen-failed');
    assert.equal(existsSync(join(h.dir, 'access-url')), false);
    assert.equal((await call(socketPath, '/')).text, 'original');
  } finally {
    await run.shutdown();
    process.exitCode = previousExitCode;
    await new Promise(resolve => owner.close(resolve));
    h.dispose();
  }
});
