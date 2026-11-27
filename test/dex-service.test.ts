// DEX 价差独立服务（docs/dexspread.md 第 11 节）：token 序号与租约、崩溃记录、执行面推送与转发的失败语义、库复制工具、执行面不导入 varlighter。
import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, globSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createExecutorServer } from '../src/http.ts';
import { DexOutcomeUnknown, createDexClient, type DexClient, type DexPageRequest } from '../src/dex/ipc.ts';
import { DEX_CRASH_REPORT_MS, startDex } from '../src/dex/main.ts';
import { CRASH_FILE } from '../src/crash-guard.ts';
import { createDexLink } from '../src/service/dex.ts';
import { DB_FILE, KEEP_BACKUPS, exportDb, importDb, tableCounts } from '../src/dex/move-db.ts';
import { DEX_PATH, DEX_PROTOCOL, DEX_TOKEN_LEASE_MS, DexError, tokenDigest, type DexStatus, type DexTokenPush } from '../src/dex/protocol.ts';
import { createLiveKeysStore } from '../src/varlighter/livekeys.ts';
import type { SocketLike } from '../src/varlighter/feeds.ts';
import { createHarness } from './harness.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const socketIn = (dir: string, name: string) => process.platform === 'win32' ? `\\\\.\\pipe\\${path.basename(dir)}-${name}` : path.join(dir, `${name}.sock`);
// 不联网：WebSocket 永远连不上，HTTP 一律失败。
const silent = (): SocketLike => { const s: SocketLike = { readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null, send() {}, close() { s.readyState = 3; } }; return s; };
const offline = { fetchImpl: (async () => { throw new Error('offline'); }) as unknown as typeof fetch, connect: silent };

test('DEX 只接受序号更大的 token 推送，超过租约后不再持有 token', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dex-token-'));
  let clock = 1_000_000;
  const dex = startDex({ socket: socketIn(dir, 'dex'), stateDir: dir, build: 'test', options: offline, log: () => {}, now: () => clock });
  const client = createDexClient(socketIn(dir, 'dex'));
  t.after(async () => { client.close(); await dex.stop(); rmSync(dir, { recursive: true, force: true }); });
  await dex.ready;
  const first = { seq: 5, token: 'a', problem: '' };
  assert.equal((await client.pushToken(first)).token, tokenDigest(first));
  assert.equal((await client.pushToken({ seq: 4, token: 'b', problem: '' })).token, tokenDigest(first), '旧序号的推送被丢弃');
  assert.equal((await client.pushToken({ seq: 5, token: 'c', problem: '' })).token, tokenDigest(first), '同序号也丢弃');
  assert.equal((await client.status()).token, tokenDigest(first));
  clock += DEX_TOKEN_LEASE_MS + 1;
  assert.equal((await client.status()).token, null, '租约过期');
  const next = { seq: 3, token: '', problem: '没有 token' };
  assert.equal((await client.pushToken(next)).token, tokenDigest(next), '租约过期后序号更小也收（执行服务重启后墙钟回拨），空 token 也立即生效');
  assert.equal((await client.pushToken({ seq: 2, token: 'd', problem: '' })).token, tokenDigest(next), '租约内又只收更大的序号');
});

test('DEX 只报告 24 小时以内的崩溃记录', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dex-crash-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const at = 2_000_000_000_000;
  writeFileSync(path.join(dir, CRASH_FILE), JSON.stringify({ at, process: 'DEX 价差服务', kind: 'uncaughtException', message: 'boom', stack: '' }));
  for (const [clock, expected] of [[at + DEX_CRASH_REPORT_MS, true], [at + DEX_CRASH_REPORT_MS + 1, false]] as const) {
    const dex = startDex({ socket: socketIn(dir, `crash-${clock}`), stateDir: dir, build: 'test', options: offline, log: () => {}, now: () => clock });
    const client = createDexClient(socketIn(dir, `crash-${clock}`));
    try { await dex.ready; assert.equal(!!(await client.status()).crash, expected); }
    finally { client.close(); await dex.stop(); }
  }
});

test('执行面每轮推 token：status 读失败时照推，确知版本不兼容时停推', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dex-tick-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pushes: DexTokenPush[] = [];
  let status: () => Promise<DexStatus> = async () => { throw new Error('timeout'); };
  const fake = {
    page: async () => ({ status: 200, body: {} }), close() {}, setCompatible() {},
    status: () => status(),
    accounts: async () => ({ accounts: {}, problem: null }),
    pushToken: async (push: DexTokenPush) => { pushes.push(push); return { instance: 'i', token: tokenDigest(push) }; },
  } satisfies DexClient;
  const link = createDexLink({ socketPath: '', dir, notifyOnce() {}, log() {}, client: fake });
  await link.tick();
  assert.equal(pushes.length, 1, 'status 失败也推');
  status = async () => ({ build: 'x', instance: 'i', protocol: DEX_PROTOCOL + 1, process: {} as DexStatus['process'], crash: null, token: null });
  await link.tick();
  assert.equal(pushes.length, 1, '版本不兼容不推');
  status = async () => { throw new Error('timeout'); };
  await link.tick();
  assert.equal(pushes.length, 1, '之后 status 失败仍沿用不兼容的判断');
  status = async () => ({ build: 'x', instance: 'i', protocol: DEX_PROTOCOL, process: {} as DexStatus['process'], crash: null, token: null });
  await link.tick();
  assert.equal(pushes.length, 2);
  assert.ok(pushes[1]!.seq > pushes[0]!.seq);
});

test('执行面转发：DEX 正常时原样返回，停了以后读与写都是 503', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dex-forward-'));
  const dex = startDex({ socket: socketIn(dir, 'dex'), stateDir: dir, build: 'test', options: offline, log: () => {} });
  const client = createDexClient(socketIn(dir, 'dex'));
  t.after(async () => { client.close(); await dex.stop(); rmSync(dir, { recursive: true, force: true }); });
  await dex.ready;
  assert.equal((await client.page({ method: 'GET', path: 'state', query: [] })).status, 200);
  assert.equal((await client.page({ method: 'GET', path: 'nothing', query: [] })).status, 404);
  await dex.stop();
  for (const request of [{ method: 'GET', path: 'state', query: [] }, { method: 'POST', path: 'settings', query: [], body: {} }, { method: 'POST', path: 'backtest', query: [], body: {} }] satisfies DexPageRequest[]) {
    const answer = await client.page(request);
    assert.equal(answer.status, 503, `${request.method} ${request.path}`);
    assert.equal((answer.body as { code: string }).code, 'dex_unavailable');
  }
  client.setCompatible(false);
  assert.equal((await client.page({ method: 'GET', path: 'state', query: [] })).status, 503);
});

test('POST 发出后应答丢失：写操作结果未知，回测返回 504，读返回 503', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dex-lost-'));
  const socket = socketIn(dir, 'lost');
  const server = createServer(connection => connection.once('data', () => connection.destroy()));
  await new Promise<void>(resolve => server.listen(socket, resolve));
  const client = createDexClient(socket);
  t.after(async () => { client.close(); await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); });
  await assert.rejects(client.page({ method: 'POST', path: 'settings', query: [], body: {} }), DexOutcomeUnknown);
  assert.equal((await client.page({ method: 'POST', path: 'backtest', query: [], body: {} })).status, 504);
  assert.equal((await client.page({ method: 'GET', path: 'state', query: [] })).status, 503);
});

function makeDb(dir: string, rows: number): void {
  const db = new DatabaseSync(path.join(dir, DB_FILE));
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS t (v TEXT); CREATE TABLE IF NOT EXISTS u (v INTEGER)");
  for (let i = 0; i < rows; i++) db.prepare('INSERT INTO t VALUES (?)').run(`row-${i}`);
  db.close();
}

/** 把 export 的头与字节写成一个文件，当作 import 的输入。 */
function exported(from: string, into: string, tamper = false): string {
  const { header, file } = exportDb(from);
  const bytes = file ? readFileSync(file) : Buffer.alloc(0);
  if (file) rmSync(file);
  if (tamper && bytes.length) bytes[bytes.length - 1] ^= 1;
  const input = path.join(into, `input-${Math.random().toString(16).slice(2)}`);
  writeFileSync(input, Buffer.concat([Buffer.from(JSON.stringify(header) + '\n'), bytes]));
  return input;
}

function importFrom(input: string, dir: string, stamp: string): string {
  const fd = openSync(input, 'r');
  try { return importDb(dir, fd, stamp); } finally { closeSync(fd); }
}

test('库复制：核对行数，原有库改名为备份并只留最近几份，篡改的输入被拒绝', { skip: process.platform === 'win32' }, t => {
  const base = mkdtempSync(path.join(tmpdir(), 'dex-move-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const [from, to, work, empty] = ['from', 'to', 'work', 'empty'].map(name => path.join(base, name));
  for (const dir of [from, to, work, empty]) mkdirSync(dir);
  makeDb(from, 25);
  makeDb(to, 2);
  assert.match(importFrom(exported(from, work), to, '20261126T000001Z'), /25 行/);
  const copy = new DatabaseSync(path.join(to, DB_FILE));
  assert.deepEqual(tableCounts(copy), { t: 25, u: 0 });
  copy.close();
  assert.ok(readdirSync(to).includes(`${DB_FILE}.bak-20261126T000001Z`), '原有的库改名为备份');
  assert.ok(!readdirSync(from).some(name => name.endsWith('.tmp')), '源端不留临时文件');

  for (let i = 2; i <= 5; i++) importFrom(exported(from, work), to, `20261126T00000${i}Z`);
  const stamps = new Set(readdirSync(to).map(name => /\.bak-(\w+?)(?:-wal|-shm|-journal)?$/.exec(name)?.[1]).filter(Boolean));
  assert.equal(stamps.size, KEEP_BACKUPS);

  const before = readFileSync(path.join(to, DB_FILE));
  assert.throws(() => importFrom(exported(from, work, true), to, '20261126T000009Z'), /不一致/);
  assert.deepEqual(readFileSync(path.join(to, DB_FILE)), before, '核对失败时目标不变');
  assert.ok(!readdirSync(to).some(name => name.endsWith('.tmp')));

  assert.match(importFrom(exported(empty, work), to, '20261126T000010Z'), /源端没有库/);
  assert.ok(!readdirSync(to).includes(DB_FILE), '以源端为准：目标处的库也改名为备份');
});

test('库复制：还有连接持有写锁时拒绝导出，不等待', { skip: process.platform === 'win32' }, t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dex-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  makeDb(dir, 3);
  const holder = new DatabaseSync(path.join(dir, DB_FILE));
  holder.exec('BEGIN IMMEDIATE');
  try { assert.throws(() => exportDb(dir), /locked|busy/i); }
  finally { holder.exec('ROLLBACK'); holder.close(); }
  const { header, file } = exportDb(dir);
  assert.equal(header.counts.t, 3);
  if (file) rmSync(file);
});

test('库复制：收到的库含触发器或视图时拒绝，目标处的库还被占用时拒绝', { skip: process.platform === 'win32' }, t => {
  const base = mkdtempSync(path.join(tmpdir(), 'dex-harden-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const [from, to, work] = ['from', 'to', 'work'].map(name => path.join(base, name));
  for (const dir of [from, to, work]) mkdirSync(dir);
  makeDb(from, 3);
  makeDb(to, 1);
  const holder = new DatabaseSync(path.join(to, DB_FILE));
  holder.exec('BEGIN IMMEDIATE');
  try { assert.throws(() => importFrom(exported(from, work), to, '20261126T000001Z'), /占用/); }
  finally { holder.exec('ROLLBACK'); holder.close(); }
  assert.ok(!readdirSync(to).some(name => name.includes('.bak-') || name.endsWith('.tmp')), '没有改名、没有留下临时文件');

  const db = new DatabaseSync(path.join(from, DB_FILE));
  db.exec('CREATE TRIGGER x AFTER INSERT ON t BEGIN DELETE FROM u; END');
  db.close();
  assert.throws(() => importFrom(exported(from, work), to, '20261126T000002Z'), /表与索引以外/);
  const copy = new DatabaseSync(path.join(to, DB_FILE));
  assert.deepEqual(tableCounts(copy), { t: 1, u: 0 }, '目标不变');
  copy.close();
});

test('执行面代码不导入 src/varlighter（含动态导入），只有 DEX 进程导入', () => {
  const offenders = globSync('src/**/*.{ts,mjs}', { cwd: root })
    .map(file => file.replaceAll('\\', '/'))
    .filter(file => !file.startsWith('src/varlighter/') && !file.startsWith('src/dex/'))
    .filter(file => /(?:from\s*|import\s*\(\s*)['"`][^'"`]*varlighter\//.test(readFileSync(path.join(root, file), 'utf8')));
  assert.deepEqual(offenders, []);
});

test('执行面 http：写请求发到 DEX 后应答丢失时断开页面连接，不回 503；读请求回 503', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dex-http-'));
  const socket = socketIn(dir, 'lost');
  const dex = createServer(connection => connection.once('data', () => connection.destroy()));
  await new Promise<void>(resolve => dex.listen(socket, resolve));
  const client = createDexClient(socket);
  const h = createHarness();
  const server = createExecutorServer({ executor: h.ex, accessToken: 'dex-http-access-01', session: 'dex-http-session-01', log: () => {}, views: { varlighter: { page: request => client.page(request) } } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const stderr = process.stderr.write.bind(process.stderr);
  t.after(async () => {
    process.stderr.write = stderr;
    client.close(); await new Promise(resolve => server.close(resolve)); await new Promise(resolve => dex.close(resolve));
    h.dispose(); rmSync(dir, { recursive: true, force: true });
  });
  const cookie = ((await fetch(`${base}/login?token=dex-http-access-01`, { redirect: 'manual' })).headers.get('set-cookie') ?? '').split(';')[0]!;
  const headers = { cookie, 'content-type': 'application/json', 'x-pa-executor': '1' };
  let logged = '';
  process.stderr.write = ((chunk: string | Uint8Array) => { logged += String(chunk); return true; }) as typeof process.stderr.write;
  await assert.rejects(fetch(`${base}/api/varlighter/settings`, { method: 'POST', headers, body: '{}' }), '页面连接被断开，没有收到任何应答');
  assert.match(logged, /DEX 价差接口 settings 的应答丢失/);
  process.stderr.write = stderr;
  const read = await fetch(`${base}/api/varlighter/state`, { headers });
  assert.equal(read.status, 503);
  assert.equal(((await read.json()) as { code: string }).code, 'dex_unavailable');
});

test('DEX 只读场所账户接口：页面凭据优先于 keys.env，不含私钥，拒绝未知字段与旧版 404', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dex-accounts-ipc-'));
  const envState = { accounts: { lighter: { accountIndex: 11 }, rh: { accountIndex: 22 } }, problem: null };
  const dex = startDex({ socket: socketIn(dir, 'dex'), stateDir: dir, build: 'test', options: { ...offline, accounts: () => envState }, log: () => {} });
  const client = createDexClient(socketIn(dir, 'dex'));
  t.after(async () => { client.close(); await dex.stop(); rmSync(dir, { recursive: true, force: true }); });
  await dex.ready;

  assert.deepEqual(await client.accounts(), { accounts: { lighter: { accountIndex: 11 }, rh: { accountIndex: 22 } }, problem: null });
  const liveKeys = createLiveKeysStore(dir);
  const entropyAddr = '0x' + '12'.repeat(20);
  liveKeys.set('lighter', { accountIndex: 99, apiKeyIndex: 5, privateKey: 'ab'.repeat(40) });
  liveKeys.set('entropy', { address: entropyAddr, privateKey: '0x' + '34'.repeat(32) });
  const withPage = await client.accounts();
  assert.deepEqual(withPage, { accounts: { lighter: { accountIndex: 99 }, rh: { accountIndex: 22 }, entropy: { address: entropyAddr } }, problem: null });
  const raw = JSON.stringify(withPage);
  assert.equal(raw.includes('privateKey'), false);
  assert.equal(raw.includes('apiKeyIndex'), false);
  assert.equal(raw.includes('abab'), false);

  liveKeys.remove('lighter');
  assert.deepEqual(await client.accounts(), { accounts: { lighter: { accountIndex: 11 }, rh: { accountIndex: 22 }, entropy: { address: entropyAddr } }, problem: null });

  const badSocket = socketIn(dir, 'bad');
  let mode: 'leak' | 'version' | 'old' = 'leak';
  const { createServer: createHttp } = await import('node:http');
  const httpBad = createHttp((req, res) => {
    if (req.url !== DEX_PATH + 'accounts') { res.writeHead(404); res.end('{}'); return; }
    if (mode === 'old') { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ message: '未知 DEX 操作' })); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (mode === 'leak') res.end(JSON.stringify({ accounts: { lighter: { accountIndex: 1, privateKey: 'xx' } }, problem: null }));
    else res.end(JSON.stringify({ accounts: { version: 1, lighter: { accountIndex: 1 } }, problem: null }));
  });
  await new Promise<void>(resolve => httpBad.listen(badSocket, resolve));
  const badClient = createDexClient(badSocket);
  t.after(async () => { badClient.close(); await new Promise(resolve => httpBad.close(resolve)); });
  await assert.rejects(badClient.accounts(), DexError);
  mode = 'version';
  await assert.rejects(badClient.accounts(), DexError);
  mode = 'old';
  await assert.rejects(badClient.accounts(), { message: 'DEX 价差服务版本较旧，不支持读取场所账户' });
});
