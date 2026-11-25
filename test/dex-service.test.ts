// DEX 价差独立服务（docs/dexspread.md 第 11 节）：token 序号与租约、执行面转发的失败语义、库复制工具、执行面不导入 varlighter。
import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, globSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { DexOutcomeUnknown, createDexClient, type DexPageRequest } from '../src/dex/ipc.ts';
import { startDex } from '../src/dex/main.ts';
import { DB_FILE, KEEP_BACKUPS, exportDb, importDb, tableCounts } from '../src/dex/move-db.ts';
import { DEX_TOKEN_LEASE_MS, tokenDigest } from '../src/dex/protocol.ts';
import type { SocketLike } from '../src/varlighter/feeds.ts';

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
  const next = { seq: 6, token: '', problem: '没有 token' };
  assert.equal((await client.pushToken(next)).token, tokenDigest(next), '空 token 也立即生效');
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

test('执行面代码不导入 src/varlighter（含动态导入），只有 DEX 进程导入', () => {
  const offenders = globSync('src/**/*.{ts,mjs}', { cwd: root })
    .map(file => file.replaceAll('\\', '/'))
    .filter(file => !file.startsWith('src/varlighter/') && !file.startsWith('src/dex/'))
    .filter(file => /(?:from\s*|import\s*\(\s*)['"`][^'"`]*varlighter\//.test(readFileSync(path.join(root, file), 'utf8')));
  assert.deepEqual(offenders, []);
});
