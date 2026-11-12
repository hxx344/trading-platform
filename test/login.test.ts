// The page's login password and the Tailscale listen address: the stored digest, the throttle, the password form,
// the Host check for the chosen address, and the run loop waiting for that address at boot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { createExecutorServer, sessionCookieName } from '../src/http.ts';
import { writeAccessUrl } from '../src/data-dir.ts';
import { FAILURE_MEMORY_MS, FREE_FAILURES, LoginThrottle, checkPasswordStrength, hashPassword, loadPasswordHash, parsePasswordHash, verifyPassword } from '../src/login-password.ts';
import { parseListenHost, parseServiceConfig, urlHost } from '../src/service/config.ts';
import { runExecutor } from '../src/runtime.ts';
import type { Executor } from '../src/executor.ts';
import type { Store } from '../src/store.ts';
import { bindAccounts, createHarness } from './harness.ts';

const PASSWORD = 'correct horse 电池';
const TOKEN = 'login-access-token-0001';
const SESSION = 'login-session-value-0001';
const stored = parsePasswordHash(await hashPassword(PASSWORD));

test('登录密码：只存 scrypt 摘要，验证正确与错误密码；长度、控制字符与文件参数受限', async () => {
  const text = await hashPassword(PASSWORD);
  assert.match(text, /^scrypt:32768:8:1:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]{43}$/);
  assert.doesNotMatch(text, /horse/);
  assert.notEqual(text, await hashPassword(PASSWORD), '每次盐不同');
  assert.equal(await verifyPassword(PASSWORD, stored), true);
  assert.equal(await verifyPassword(`${PASSWORD} `, stored), false);
  assert.equal(await verifyPassword('', stored), false);
  assert.throws(() => checkPasswordStrength('short'), /至少 8/);
  assert.throws(() => checkPasswordStrength('abc\tdefgh'), /控制字符/);
  assert.throws(() => checkPasswordStrength('x'.repeat(257)), /最多/);
  await assert.rejects(hashPassword('1234567'), /至少 8/);
  assert.throws(() => parsePasswordHash('plain-text-password'), /格式无效/);
  assert.throws(() => parsePasswordHash(text.replace(':32768:', ':1048576:')), /超出范围/);
  assert.throws(() => parsePasswordHash(text.replace(':32768:', ':30000:')), /超出范围/);
});

test('登录密码：文件不存在即未设置；文件须归当前用户且为 600', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-login-'));
  try {
    const path = join(dir, 'login-password');
    assert.equal(loadPasswordHash(path), null);
    writeFileSync(path, `${await hashPassword(PASSWORD)}\n`, { mode: 0o600 });
    assert.equal(await verifyPassword(PASSWORD, loadPasswordHash(path)!), true);
    chmodSync(path, 0o644);
    assert.throws(() => loadPasswordHash(path), /权限过宽/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('登录限速：连续错 5 次后锁 30 秒并逐次加倍，最长 15 分钟；输对清零', () => {
  let now = 0;
  const throttle = new LoginThrottle(() => now);
  for (let i = 1; i < FREE_FAILURES; i++) { throttle.failed(); assert.equal(throttle.waitMs(), 0, `第 ${i} 次`); }
  throttle.failed();
  assert.equal(throttle.waitMs(), 30_000);
  now += 30_000;
  assert.equal(throttle.waitMs(), 0);
  throttle.failed();
  assert.equal(throttle.waitMs(), 60_000);
  for (let i = 0; i < 10; i++) throttle.failed();
  assert.equal(throttle.waitMs(), 15 * 60_000);
  throttle.succeeded();
  assert.equal(throttle.waitMs(), 0);
  throttle.failed();
  assert.equal(throttle.waitMs(), 0, '清零后重新计数');
  // Slips an hour apart never add up to a lockout.
  for (let i = 0; i < FREE_FAILURES * 2; i++) { now += FAILURE_MEMORY_MS + 1; throttle.failed(); }
  assert.equal(throttle.waitMs(), 0);
});

async function withPasswordServer(run: (base: string, port: number, clock: { now: number }) => Promise<void>, host?: string) {
  const h = createHarness();
  bindAccounts(h.ex);
  const clock = { now: 1_000_000 };
  const lines: string[] = [];
  const server = createExecutorServer({ executor: h.ex, accessToken: TOKEN, session: SESSION, password: stored, throttle: new LoginThrottle(() => clock.now), log: line => lines.push(line), ...(host ? { host } : {}) });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try { await run(`http://127.0.0.1:${port}`, port, clock); }
  finally { await new Promise(resolve => server.close(resolve)); h.dispose(); }
}
const form = (base: string, password: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams({ password }).toString() });

test('HTTP 密码登录：未登录显示密码表单；输对下发会话 cookie，输错 401 不下发；访问令牌仍可登录', () => withPasswordServer(async (base, port) => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 401);
  const html = await page.text();
  assert.match(html, /<form method="post" action="\/login">/);
  assert.match(html, /type="password"/);
  assert.match(page.headers.get('content-security-policy') ?? '', /form-action 'self'/);
  assert.equal((await fetch(`${base}/login`)).status, 200);

  const wrong = await form(base, 'not the password');
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get('set-cookie'), null);
  assert.match(await wrong.text(), /密码错误/);

  const right = await form(base, PASSWORD, { origin: base, 'sec-fetch-site': 'same-origin' });
  assert.equal(right.status, 303);
  assert.equal(right.headers.get('location'), '/');
  const cookie = (right.headers.get('set-cookie') ?? '').split(';')[0];
  assert.equal(cookie, `${sessionCookieName(port)}=${SESSION}`);
  assert.match(right.headers.get('set-cookie') ?? '', /HttpOnly; SameSite=Strict/);
  assert.equal((await fetch(`${base}/api/state`, { headers: { cookie } })).status, 200);

  assert.equal(page.headers.get('referrer-policy'), 'same-origin', '登录页让表单带上真实 Origin');
  assert.equal((await form(base, PASSWORD, { 'sec-fetch-site': 'none' })).status, 303);
  assert.equal((await form(base, PASSWORD, { 'sec-fetch-site': 'same-origin', origin: 'http://evil.example' })).status, 303, '有 Sec-Fetch-Site 时以它为准');

  const byToken = await fetch(`${base}/login?token=${TOKEN}`, { redirect: 'manual' });
  assert.equal(byToken.status, 303);
  assert.equal((await fetch(`${base}/login?token=wrong`, { redirect: 'manual' })).status, 401);
  assert.match(((await (await fetch(`${base}/api/state`)).json()) as { message: string }).message, /重新登录/);
}));

test('HTTP 密码登录：跨站提交、非表单类型、超长请求体都不受理', () => withPasswordServer(async base => {
  const crossSite: Record<string, string>[] = [{ origin: 'http://evil.example' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }];
  for (const headers of crossSite) {
    const response = await form(base, PASSWORD, headers);
    assert.equal(response.status, 403, JSON.stringify(headers));
    assert.equal(response.headers.get('set-cookie'), null);
  }
  const json = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  assert.equal(json.status, 403);
  const huge = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `password=${encodeURIComponent(PASSWORD)}&pad=${'x'.repeat(8 * 1024)}` });
  assert.equal(huge.status, 413);
  assert.equal(huge.headers.get('set-cookie'), null);
  // Too large is refused outright and not counted: the right password still logs in at once.
  for (let i = 0; i < FREE_FAILURES; i++) await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'x'.repeat(8 * 1024) }).catch(() => undefined);
  assert.equal((await form(base, PASSWORD)).status, 303);
}));

test('HTTP 密码登录：连续输错后锁定，锁定期间正确密码也被拒；到期后可登录', () => withPasswordServer(async (base, _port, clock) => {
  for (let i = 0; i < FREE_FAILURES - 1; i++) assert.equal((await form(base, `guess-${i}-xxxx`)).status, 401);
  const locking = await form(base, 'guess-last-xxxx');
  assert.equal(locking.status, 401);
  assert.match(await locking.text(), /已锁定 30 秒/);
  const locked = await form(base, PASSWORD);
  assert.equal(locked.status, 429);
  assert.equal(locked.headers.get('set-cookie'), null);
  assert.match(await locked.text(), /30 秒后再试/);
  clock.now += 30_000;
  assert.equal((await form(base, PASSWORD)).status, 303);
  // The access-url link lifts a lockout too.
  for (let i = 0; i < FREE_FAILURES; i++) await form(base, `again-${i}-xxxx`);
  assert.equal((await form(base, PASSWORD)).status, 429);
  assert.equal((await fetch(`${base}/login?token=${TOKEN}`, { redirect: 'manual' })).status, 303);
  assert.equal((await form(base, PASSWORD)).status, 303);
}));

test('HTTP 密码登录：同时提交的多个猜测只受理一个', () => withPasswordServer(async base => {
  const statuses = (await Promise.all(Array.from({ length: 4 }, (_, i) => form(base, `parallel-guess-${i}`)))).map(response => response.status).sort();
  assert.ok(statuses.includes(429), `并发猜测应有被拒的：${statuses}`);
  assert.equal(statuses.filter(status => status === 401).length + statuses.filter(status => status === 429).length, 4);
}));

test('HTTP 密码登录：请求体没发完就断开的客户端不占住登录，慢速发送也不挡别人', () => withPasswordServer(async base => {
  const url = new URL(base);
  // Sends part of the body and hangs: the right password must still log in meanwhile, and after it goes.
  const slow = httpRequest({ host: url.hostname, port: url.port, path: '/login', method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': '200' } });
  slow.on('error', () => undefined);
  slow.write('password=abc');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await form(base, PASSWORD)).status, 303, '慢速请求不应占住验证');
  slow.destroy();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await form(base, PASSWORD)).status, 303, '断开后仍可登录');
}));

const statusWithHost = (base: string, host: string) => new Promise<number>((resolve, reject) => {
  const url = new URL(base);
  const req = httpRequest({ host: url.hostname, port: url.port, path: '/login', headers: { host } }, res => { res.resume(); resolve(res.statusCode ?? 0); });
  req.on('error', reject); req.end();
});

test('HTTP 监听地址：Host 头只放行本机回环与配置的地址（可带端口）', async () => {
  await withPasswordServer(async base => {
    for (const host of ['100.64.0.5', '100.64.0.5:4720', '127.0.0.1:4720', 'localhost']) assert.equal(await statusWithHost(base, host), 200, host);
    for (const host of ['100.64.0.6', '100.64.0.5:abc', '100.64.0.5.evil.example', 'evil.example', '100.64.0.55:4720']) assert.equal(await statusWithHost(base, host), 421, host);
  }, '100.64.0.5');
  await withPasswordServer(async base => {
    assert.equal(await statusWithHost(base, '[fd7a:115c:a1e0::1]:4720'), 200);
    assert.equal(await statusWithHost(base, '[fd7a:115c:a1e0::2]:4720'), 421);
  }, '[fd7a:115c:a1e0::1]');
  await withPasswordServer(async base => {
    assert.equal(await statusWithHost(base, '100.64.0.5:4720'), 421, '没配置地址时只放行本机');
  });
});

test('配置 host：只收本机的具体 IP，IPv6 规范化；通配地址与域名被拒；不写即回环', () => {
  assert.equal(parseListenHost(undefined), null);
  assert.equal(parseListenHost('100.101.102.103'), '100.101.102.103');
  assert.equal(parseListenHost('FD7A:115C:A1E0:0:0:0:0:1'), 'fd7a:115c:a1e0::1');
  assert.equal(urlHost('fd7a:115c:a1e0::1'), '[fd7a:115c:a1e0::1]');
  assert.equal(urlHost('100.101.102.103'), '100.101.102.103');
  assert.equal(parseListenHost('::ffff:7.240.0.1'), '::ffff:7f0:1', '7.240.x 的映射地址不是回环');
  for (const bad of ['0.0.0.0', '::', '0:0::0', '::ffff:0.0.0.0', '255.255.255.255', 'tailscale.example', '100.64.0.5:4720', '[fd7a::1]', '127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', 4720, '']) {
    assert.throws(() => parseListenHost(bad), /host/, String(bad));
  }
  const config = parseServiceConfig({ secretsFile: '/etc/trading-platform/secrets.json', pairs: [], host: '100.101.102.103' });
  assert.equal(config.host, '100.101.102.103');
  assert.equal(parseServiceConfig({ secretsFile: '/etc/trading-platform/secrets.json', pairs: [] }).host, null);
});

test('登录链接：配置了监听地址时 access-url 先写该地址，再写总可用的回环地址', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-login-'));
  try {
    writeAccessUrl(dir, 4720, 'tok_abc', '[fd7a::1]');
    assert.equal(readFileSync(join(dir, 'access-url'), 'utf8'), 'http://[fd7a::1]:4720/login?token=tok_abc\nhttp://127.0.0.1:4720/login?token=tok_abc\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('运行循环：配置的地址绑不上时回环照常服务、服务不停，持续重试，地址可用后开始监听', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-runtime-'));
  const executor = {
    budgets: { leaseTtlMs: 60_000, positionsRefreshMs: 15_000 }, retired: false, acquire: () => true,
    tickTransfers: async () => undefined, tickAdl: async () => undefined, maintain: () => undefined, refreshPositions: async () => undefined,
    stopSending: () => undefined, close: () => undefined,
  } as unknown as Executor;
  const store = { maintainWal: () => ({ walBytes: 0 }), close: () => undefined } as unknown as Store;
  const lines: string[] = [], reasons: string[] = [];
  // A free port, then something else on 127.0.0.2 at that port: the chosen address is taken until the blocker goes.
  const probe = createNetServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise(resolve => probe.close(resolve));
  const blocker = createNetServer();
  await new Promise<void>(resolve => blocker.listen(port, '127.0.0.2', resolve));
  const until = async (done: () => boolean, what: string) => { for (let i = 0; i < 200 && !done(); i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(done(), what); };
  const run = runExecutor({ executor, store, dir, port, listen: { address: '127.0.0.2', urlHost: '127.0.0.2' }, listenRetry: { firstMs: 10, maxMs: 40 }, passes: ['transfers'], startedMessage: 'test', log: line => lines.push(line), onStopping: reason => reasons.push(reason) });
  try {
    await until(() => existsSync(join(dir, 'access-url')), '回环监听后应写出登录链接');
    assert.match(readFileSync(join(dir, 'access-url'), 'utf8'), new RegExp(`^http://127\\.0\\.0\\.2:${port}/login\\?token=.+\\nhttp://127\\.0\\.0\\.1:${port}/`));
    assert.equal((await fetch(`http://127.0.0.1:${port}/login`)).status, 401, '回环照常服务');
    await until(() => lines.filter(line => line.includes('EADDRINUSE')).length === 1 && lines.length >= 1, '应提示一次绑定失败');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(lines.filter(line => line.includes('EADDRINUSE')).length, 1, '同一原因只提示一次');
    assert.deepEqual(reasons, [], '绑不上不停服务');
    await new Promise(resolve => blocker.close(resolve));
    await until(() => lines.some(line => line.includes(`已开始监听 127.0.0.2:${port}`)), '地址可用后应开始监听');
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.2', port, path: '/login', headers: { host: `127.0.0.2:${port}` } }, res => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject); req.end();
    });
    assert.equal(status, 401, '经配置地址进来的请求走同一服务（Host 放行）');
    await run.shutdown();
    const refused = await new Promise<string>(resolve => {
      const req = httpRequest({ host: '127.0.0.2', port, path: '/login', agent: false }, res => { res.resume(); resolve(`status ${res.statusCode}`); });
      req.on('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'error')); req.end();
    });
    assert.equal(refused, 'ECONNREFUSED', '停止后配置地址不再监听');
  } finally {
    await run.shutdown();
    blocker.close();
    process.removeAllListeners('SIGINT'); process.removeAllListeners('SIGTERM');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('运行循环：配置的地址在重试等待中时停止服务，干净退出', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-runtime-'));
  const executor = {
    budgets: { leaseTtlMs: 60_000, positionsRefreshMs: 15_000 }, retired: false, acquire: () => true,
    tickTransfers: async () => undefined, tickAdl: async () => undefined, maintain: () => undefined, refreshPositions: async () => undefined,
    stopSending: () => undefined, close: () => undefined,
  } as unknown as Executor;
  const store = { maintainWal: () => ({ walBytes: 0 }), close: () => undefined } as unknown as Store;
  const lines: string[] = [];
  const probe = createNetServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise(resolve => probe.close(resolve));
  const blocker = createNetServer();
  await new Promise<void>(resolve => blocker.listen(port, '127.0.0.2', resolve));
  const run = runExecutor({ executor, store, dir, port, listen: { address: '127.0.0.2', urlHost: '127.0.0.2' }, listenRetry: { firstMs: 60_000, maxMs: 60_000 }, passes: ['transfers'], startedMessage: 'test', log: line => lines.push(line), onStopping: () => undefined });
  try {
    for (let i = 0; i < 200 && !lines.some(line => line.includes('EADDRINUSE')); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(lines.some(line => line.includes('EADDRINUSE')), '应先绑定失败');
    const started = Date.now();
    await run.shutdown();
    assert.ok(Date.now() - started < 5_000, '不等重试计时就退出');
    await new Promise(resolve => blocker.close(resolve));
    await new Promise(resolve => setTimeout(resolve, 50));
    const refused = await new Promise<string>(resolve => {
      const req = httpRequest({ host: '127.0.0.2', port, path: '/login', agent: false }, res => { res.resume(); resolve(`status ${res.statusCode}`); });
      req.on('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'error')); req.end();
    });
    assert.equal(refused, 'ECONNREFUSED', '地址空出后也不留监听');
  } finally {
    blocker.close();
    process.removeAllListeners('SIGINT'); process.removeAllListeners('SIGTERM');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('页面：不依赖只在 HTTPS 或 localhost 才有的 crypto.randomUUID，请求号仍是服务端接受的 UUID', async () => {
  const { PAGE, LIVE_PAGE } = await import('../src/page.ts');
  const { UUID } = await import('../src/contracts.ts');
  for (const page of [PAGE, LIVE_PAGE]) assert.ok(!page.includes('randomUUID('), '页面脚本不能调用 randomUUID');
  const line = PAGE.split('\n').find(text => text.startsWith('const newRequestId = '));
  assert.ok(line, '页面应有 newRequestId');
  const newRequestId = new Function('crypto', `${line}; return newRequestId;`)({ getRandomValues: (b: Uint8Array) => globalThis.crypto.getRandomValues(b) }) as () => string;
  const ids = new Set(Array.from({ length: 200 }, () => newRequestId()));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, UUID);
});
