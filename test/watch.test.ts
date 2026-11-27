// The heartbeat pushed to the second server's main-watch (docs/watch.md): the two files' entries, the wire format against
// the receiver that ships with it (deploy/main-watch/main_watch.py), what a failed push leaves behind, and install.sh's
// planning of the change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SIGNATURE_HEADER, createWatch, heartbeatBody, heartbeatSignature, parseWatchConfig, parseWatchSecret, watchLoop, watchSummary } from '../src/service/watch.ts';
import { parseSenderFile, planWatch } from '../src/service/watch-config.ts';
import { parseServiceConfig, parseServiceSecrets } from '../src/service/config.ts';

const TOKEN = 'watch-test-token-0123456789abcdefghij';
const URL_ = 'http://203.0.113.9:8792/heartbeat';
const WATCH_DIR = join(import.meta.dirname, '..', 'deploy', 'main-watch');
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('巡检心跳配置：地址须为不带账号的 http(s)，令牌 32~256 位；配置与密钥文件各认一个 watch', () => {
  assert.deepEqual(parseWatchConfig({ url: URL_ }), { url: URL_ });
  assert.deepEqual(parseWatchConfig({ url: 'https://watch.example/heartbeat' }), { url: 'https://watch.example/heartbeat' });
  for (const url of ['ftp://203.0.113.9/heartbeat', '203.0.113.9:8792', 'http://user:pw@203.0.113.9/heartbeat', 'http://203.0.113.9/heartbeat#x', '', 7, `http://203.0.113.9/${'a'.repeat(300)}`]) assert.throws(() => parseWatchConfig({ url }), /watch\.url/, String(url));
  assert.throws(() => parseWatchConfig({ url: URL_, token: TOKEN }), /不支持的字段/);
  assert.deepEqual(parseWatchSecret({ token: TOKEN }), { token: TOKEN });
  for (const token of ['short', 'a'.repeat(257), `${'a'.repeat(31)}!`, 5]) assert.throws(() => parseWatchSecret({ token }), (error: unknown) => error instanceof Error && /watch\.token/.test(error.message) && (typeof token !== 'string' || !error.message.includes(token)), String(token));
  assert.equal(watchSummary(undefined), '');
  assert.equal(watchSummary({ url: URL_ }), `，巡检心跳推送到 ${URL_}`);

  const config = parseServiceConfig({ secretsFile: '/etc/tp/secrets.json', pairs: [], watch: { url: URL_ } });
  assert.deepEqual(config.watch, { url: URL_ });
  assert.equal(parseServiceConfig({ secretsFile: '/etc/tp/secrets.json', pairs: [] }).watch, undefined);
  assert.deepEqual(parseServiceSecrets({ accounts: {}, watch: { token: TOKEN } }, []).watch, { token: TOKEN });
  assert.equal(parseServiceSecrets({ accounts: {} }, []).watch, undefined);
  for (const invalid of [{ accounts: {}, [TOKEN]: true }, { accounts: {}, watch: { token: TOKEN, [TOKEN]: true } }, { accounts: {}, feishu: { webhook: '', [TOKEN]: true } }]) {
    assert.throws(() => parseServiceSecrets(invalid, []), { message: '包含不支持的字段' });
  }
});

test('心跳正文与签名：main-watch 的格式，签名为令牌对正文字节的 HMAC-SHA256', () => {
  const body = heartbeatBody(1_700_000_000_123, null);
  assert.equal(body, '{"sent_at":1700000000123,"ready":true,"detail":""}');
  const down = heartbeatBody(1_700_000_000_124, `划转循环已 200 秒未完成一轮${'长'.repeat(300)}`);
  const parsed = JSON.parse(down) as { ready: boolean; detail: string };
  assert.deepEqual([parsed.ready, parsed.detail.length, parsed.detail.startsWith('划转循环已 200 秒')], [false, 200, true]);
  assert.ok(Buffer.byteLength(down) <= 4096, '不超过接收端的正文上限');
  assert.equal(heartbeatSignature(TOKEN, down), createHmac('sha256', Buffer.from(TOKEN)).update(Buffer.from(down, 'utf8')).digest('hex'));
  assert.equal(SIGNATURE_HEADER, 'X-Main-Watch-Signature');
});

test('推送：一次一个签名 POST，不跟随跳转；失败与恢复各记一条日志，状态里不出现令牌', async () => {
  let clock = 1_000_000;
  const calls: { url: string; init: RequestInit }[] = [];
  const replies: (() => Response | Promise<Response>)[] = [];
  const logs: string[] = [];
  let problem: string | null = null;
  const watch = createWatch({
    config: { url: URL_ }, secret: { token: TOKEN }, problem: () => problem, now: () => clock, log: line => logs.push(line),
    fetchImpl: async (url, init) => { calls.push({ url, init }); return (replies.shift() ?? (() => new Response(null, { status: 204 })))(); },
  });
  assert.deepEqual(watch.status(), { url: URL_, lastOkAt: null, lastReady: null, failures: 0, lastError: null, lastErrorAt: null });

  await watch.push();
  const first = calls[0]!;
  const headers = first.init.headers as Record<string, string>;
  assert.deepEqual([first.url, first.init.method, first.init.redirect], [URL_, 'POST', 'manual']);
  assert.equal(first.init.body, '{"sent_at":1000000,"ready":true,"detail":""}');
  assert.equal(headers[SIGNATURE_HEADER], createHmac('sha256', TOKEN).update(first.init.body as string).digest('hex'));
  assert.deepEqual(watch.status(), { url: URL_, lastOkAt: 1_000_000, lastReady: true, failures: 0, lastError: null, lastErrorAt: null });

  // The clock stepping back must not repeat or lower the stamp: the receiver refuses a beat that is not newer.
  clock = 999_000;
  problem = 'ADL 循环尚未完成一轮';
  await watch.push();
  assert.deepEqual(JSON.parse(calls[1]!.init.body as string), { sent_at: 1_000_001, ready: false, detail: 'ADL 循环尚未完成一轮' });
  assert.equal(watch.status().lastReady, false, '送达的是“未就绪”');

  clock = 1_030_000;
  replies.push(() => new Response(null, { status: 403 }), () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }, () => new Response(null, { status: 302, headers: { location: 'http://elsewhere.example/' } }));
  await watch.push(); await watch.push(); await watch.push();
  const failed = watch.status();
  assert.deepEqual([failed.failures, failed.lastError, failed.lastErrorAt, failed.lastOkAt], [3, 'HTTP 302', 1_030_000, 999_000]);
  assert.equal(logs.length, 1, '连续失败只记第一条');
  assert.match(logs[0]!, /巡检心跳推送失败：HTTP 403：副服务器拒绝了心跳，请核对两端令牌是否一致/);
  await watch.push();
  assert.deepEqual([watch.status().failures, logs.length], [0, 2]);
  assert.match(logs[1]!, /已恢复送达（此前连续失败 3 次）/);
  assert.equal(calls.length, 6, '失败不在同一次里重试');
  assert.doesNotMatch(JSON.stringify([watch.status(), logs]), new RegExp(TOKEN));
  for (const call of calls) assert.doesNotMatch(`${call.url}${String(call.init.body)}`, new RegExp(TOKEN), '令牌本身不上线路');
});

test('推送：停止时放弃在途的一次，不记失败；循环按固定间隔推送，停止后退出', async () => {
  const logs: string[] = [];
  const watch = createWatch({
    config: { url: URL_ }, secret: { token: TOKEN }, problem: () => null, log: line => logs.push(line),
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => { init.signal!.addEventListener('abort', () => reject(init.signal!.reason)); }),
  });
  const pending = watch.push();
  watch.abort();
  await pending;
  assert.deepEqual([watch.status().failures, logs], [0, []]);

  let stopped = false, pushes = 0;
  const pauses: number[] = [];
  await watchLoop({ push: async () => { pushes++; if (pushes === 3) stopped = true; } }, { stopped: () => stopped, pause: async ms => { pauses.push(ms); } }, { firstMs: 7, intervalMs: 30_000 });
  assert.equal(pushes, 3);
  assert.equal(pauses[0], 7, '第一次推送前等各循环转起来');
  assert.ok(pauses.length === 3 && pauses.slice(1).every(ms => ms > 29_000 && ms <= 30_000), JSON.stringify(pauses));
});

const python = ['python3', 'python'].find(name => spawnSync(name, ['-I', '-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)']).status === 0);

test('与接收端互通：本服务的心跳被 main_watch.py 收下并读出就绪与原因，令牌不符时被拒', { skip: python ? false : '本机没有 python3', timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-watch-'));
  const port = await new Promise<number>(resolve => { const probe = createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address() as { port: number }; probe.close(() => resolve(port)); }); });
  writeFileSync(join(dir, 'config'), `FEISHU_WEBHOOK=http://127.0.0.1:9/hook\nHEARTBEAT_LISTEN=127.0.0.1:${port}\nHEARTBEAT_TOKEN=${TOKEN}\n`);
  const args = ['-I', '-X', 'utf8', join(WATCH_DIR, 'main_watch.py'), '--config', join(dir, 'config'), '--state', join(dir, 'state.json')];
  const receiver = spawn(python!, [...args, '--serve'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  receiver.stdout.on('data', chunk => { output += String(chunk); });
  receiver.stderr.on('data', chunk => { output += String(chunk); });
  try {
    for (let i = 0; i < 200 && !output.includes('心跳接收已启动'); i++) await wait(50);
    assert.match(output, /心跳接收已启动/, output);
    const url = `http://127.0.0.1:${port}/heartbeat`;
    let problem: string | null = null;
    const watch = createWatch({ config: { url }, secret: { token: TOKEN }, problem: () => problem, log: () => undefined });
    const beat = () => JSON.parse(readFileSync(join(dir, 'heartbeat.json'), 'utf8')) as { sent_at: number; ready: boolean; detail: string };
    const probe = () => spawnSync(python!, [...args, '--probe'], { encoding: 'utf8' });

    await watch.push();
    assert.deepEqual([watch.status().failures, watch.status().lastError, watch.status().lastReady], [0, null, true]);
    assert.deepEqual([beat().ready, beat().detail], [true, '']);
    assert.equal(probe().status, 0, '巡检认为主服务器正常');

    problem = '划转循环已 200 秒未完成一轮';
    await watch.push();
    assert.equal(watch.status().failures, 0);
    assert.deepEqual([beat().ready, beat().detail], [false, problem]);
    const down = probe();
    assert.equal(down.status, 1);
    assert.match(down.stdout, /主服务器自检未就绪：划转循环已 200 秒未完成一轮/);

    const before = beat();
    const wrong = createWatch({ config: { url }, secret: { token: 'x'.repeat(40) }, problem: () => null, log: () => undefined });
    await wrong.push();
    assert.match(wrong.status().lastError ?? '', /^HTTP 403：/);
    assert.deepEqual(beat(), before, '被拒的心跳不改记录');
  } finally {
    receiver.kill();
    await new Promise(resolve => { if (receiver.exitCode !== null || receiver.signalCode !== null) resolve(null); else receiver.once('exit', resolve); });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('工作台推送端配置：取 HEARTBEAT_URL 与 HEARTBEAT_TOKEN，引号去掉，其余键不管', () => {
  assert.deepEqual(parseSenderFile(`# sender\nHEARTBEAT_URL=${URL_}\nHEARTBEAT_TOKEN="${TOKEN}"\nREADY_URL=http://127.0.0.1:3100/api/ready\nTIMEOUT=5\n`), { url: URL_, token: TOKEN });
  assert.deepEqual(parseSenderFile(`HEARTBEAT_URL = '${URL_}'\r\nHEARTBEAT_TOKEN=${TOKEN}\r\n`), { url: URL_, token: TOKEN });
  assert.throws(() => parseSenderFile(`HEARTBEAT_URL=${URL_}\n`), /没有 HEARTBEAT_URL 或 HEARTBEAT_TOKEN/);
});

test('开启与关闭：只动 watch 两处，其余原样；不带令牌时沿用已存的，没存过则拒绝；写入前按服务的规则校验', () => {
  const existing = { config: { secretsFile: '/etc/tp/secrets.json', pairs: [], port: 4720 }, secrets: { accounts: { a: 1 } } };
  const on = planWatch(existing, { url: URL_, token: TOKEN });
  assert.deepEqual(on, { config: { ...existing.config, watch: { url: URL_ } }, secrets: { accounts: { a: 1 }, watch: { token: TOKEN } }, changed: true, url: URL_ });
  assert.deepEqual(existing, { config: { secretsFile: '/etc/tp/secrets.json', pairs: [], port: 4720 }, secrets: { accounts: { a: 1 } } }, '不改传入的对象');
  assert.equal(planWatch(on, { url: URL_, token: TOKEN }).changed, false);
  assert.equal(planWatch(on, { url: URL_, token: null }).changed, false);
  const moved = planWatch(on, { url: 'http://203.0.113.10:8792/heartbeat', token: null });
  assert.deepEqual([moved.changed, moved.config.watch, moved.secrets.watch], [true, { url: 'http://203.0.113.10:8792/heartbeat' }, { token: TOKEN }]);
  assert.throws(() => planWatch(existing, { url: URL_, token: null }), /还没有保存过心跳令牌/);
  assert.throws(() => planWatch(existing, { url: 'not a url', token: TOKEN }), /watch\.url/);
  assert.throws(() => planWatch(existing, { url: URL_, token: 'short' }), (error: unknown) => error instanceof Error && /watch\.token/.test(error.message) && !error.message.includes('short'));
  const off = planWatch(on, 'off');
  assert.deepEqual([off.config, off.secrets, off.changed, off.url], [existing.config, existing.secrets, true, null]);
  assert.equal(planWatch(existing, 'off').changed, false);
});
