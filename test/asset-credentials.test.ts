// The sealed connections of A-3 (src/asset/credentials.ts): the key file (created whole once, 0600, 64 hex digits, a
// broken one never overwritten, a symlink not followed), the workbench vault's format both ways (WebCrypto), the
// connection name as the only additional data, and the connection bodies (validation.ts) the connect API takes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CREDENTIAL_KEY_FILE, KEY_MISSING, UNSEALED_FAILED, credentialKey, credentialTail, dataDirVault, seal, unseal } from '../src/asset/credentials.ts';
import { AssetInputError, connectionExchange, parseAsterAccount, parseAsterAccountDelete, parseConnection, parseDisconnect } from '../src/asset/validation.ts';

const dir = (t: { after: (fn: () => void) => void }) => { const path = mkdtempSync(join(tmpdir(), 'tp-asset-key-')); t.after(() => rmSync(path, { recursive: true, force: true })); return path; };
const WALLET = '0x' + 'ab'.repeat(19) + 'c1', PRIVATE = '0x' + '5'.repeat(64);

test('凭据密钥：首次加密时创建 0600 的 64 位十六进制密钥，之后读同一把；没有密钥时解密报 decrypt failed', t => {
  const data = dir(t);
  assert.throws(() => credentialKey(data), { message: KEY_MISSING });
  assert.match(KEY_MISSING, /decrypt failed/, 'HTTP 层据此答 503');
  const vault = dataDirVault(data);
  assert.throws(() => vault.unseal('{}', 'binance'), { message: KEY_MISSING }, '解密不创建密钥');
  assert.deepEqual(readdirSync(data), []);
  const sealed = vault.seal({ apiKey: 'k' }, 'binance');
  const path = join(data, CREDENTIAL_KEY_FILE), text = readFileSync(path, 'utf8');
  assert.match(text, /^[0-9a-f]{64}\n$/);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(data), [CREDENTIAL_KEY_FILE], '临时文件已删除');
  assert.deepEqual(vault.unseal(sealed, 'binance'), { apiKey: 'k' });
  assert.deepEqual(credentialKey(data, { create: true }), Buffer.from(text.trim(), 'hex'), '已有密钥不重建');
});

test('凭据密钥：格式不对的密钥报错且不覆盖；符号链接与目录不读', t => {
  const data = dir(t), path = join(data, CREDENTIAL_KEY_FILE);
  writeFileSync(path, 'not-a-key\n', { mode: 0o600 });
  assert.throws(() => credentialKey(data, { create: true }), /不是 64 位十六进制密钥，未改动/);
  assert.throws(() => dataDirVault(data).seal({}, 'okx'), /不是 64 位十六进制密钥/);
  assert.equal(readFileSync(path, 'utf8'), 'not-a-key\n');
  rmSync(path);
  const elsewhere = join(data, 'elsewhere.key');
  writeFileSync(elsewhere, 'ab'.repeat(32));
  symlinkSync(elsewhere, path);
  assert.throws(() => credentialKey(data, { create: true }), /是符号链接，不读取/);
});

test('加密格式：与工作台 WebCrypto vault 互通（iv 12 字节、cipher 含 16 字节 tag）；附加数据只是连接名', async t => {
  const data = dir(t), key = credentialKey(data, { create: true });
  const webKey = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const value = { exchange: 'aster', walletAddress: WALLET, privateKey: PRIVATE, includeSpot: true };
  // Sealed here, opened by WebCrypto as the workbench's unseal does.
  const ours = JSON.parse(seal(value, 'aster:x', key)) as { iv: number[]; cipher: number[] };
  assert.equal(ours.iv.length, 12);
  assert.equal(ours.cipher.length, new TextEncoder().encode(JSON.stringify(value)).length + 16);
  const opened = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(ours.iv), additionalData: new TextEncoder().encode('aster:x') }, webKey, new Uint8Array(ours.cipher));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(opened)), value);
  // Sealed by WebCrypto as the workbench's seal does, opened here.
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('binance') }, webKey, new TextEncoder().encode(JSON.stringify({ apiKey: 'a' })));
  const theirs = JSON.stringify({ iv: Array.from(iv), cipher: Array.from(new Uint8Array(cipher)) });
  assert.deepEqual(unseal(theirs, 'binance', key), { apiKey: 'a' });
  // Another name, another key or damaged text: one message, no crypto detail.
  assert.throws(() => unseal(theirs, 'alice:binance', key), { message: UNSEALED_FAILED });
  assert.throws(() => unseal(theirs, 'binance', Buffer.alloc(32, 1)), { message: UNSEALED_FAILED });
  assert.throws(() => unseal('{"iv":[1],"cipher":[2]}', 'binance', key), { message: UNSEALED_FAILED });
  assert.throws(() => unseal('nope', 'binance', key), { message: UNSEALED_FAILED });
  assert.match(UNSEALED_FAILED, /decrypt failed/);
  assert.deepEqual([credentialTail({ apiKey: 'abcdWXYZ' }), credentialTail({ walletAddress: WALLET }), credentialTail({ vrToken: 'x' })], ['WXYZ', 'abc1', undefined]);
});

test('连接请求体：按工作台 connectionSchema 逐所校验；Aster 账号与断开的请求体；工作台连接名', () => {
  assert.deepEqual(parseConnection({ exchange: 'bybit', apiKey: ' key01 ', apiSecret: 'secret' }), { exchange: 'bybit', apiKey: ' key01 ', apiSecret: 'secret', region: 'global' }, 'Bybit 不去空格，地区默认 global');
  assert.deepEqual(parseConnection({ exchange: 'binance', apiKey: ' key01 ', apiSecret: 'secret' }), { exchange: 'binance', apiKey: 'key01', apiSecret: 'secret' });
  assert.deepEqual(parseConnection({ exchange: 'aster', walletAddress: WALLET, privateKey: PRIVATE }), { exchange: 'aster', walletAddress: WALLET, privateKey: PRIVATE, includeSpot: false });
  assert.deepEqual(parseConnection({ exchange: 'hyperliquid', walletAddress: WALLET }), { exchange: 'hyperliquid', walletAddress: WALLET });
  for (const body of [
    { exchange: 'okx', apiKey: 'key01', apiSecret: 'secret' }, { exchange: 'binance', apiKey: 'key01', apiSecret: 'secret', owner: 'x' },
    { exchange: 'gate', apiKey: 'key 01', apiSecret: 'secret' }, { exchange: 'bybit', apiKey: 'key01', apiSecret: 'secret', region: 'us' },
    { exchange: 'hyperliquid', walletAddress: '0x12' }, { exchange: 'variational', vrToken: 'a b c d e' }, { exchange: 'kraken' }, null, [],
  ]) assert.throws(() => parseConnection(body), AssetInputError, JSON.stringify(body));
  const id = '3f2a1b0c-9d8e-4f7a-8b6c-5d4e3f2a1b0c';
  assert.deepEqual(parseAsterAccount({ id, name: ' 主号 ', walletAddress: WALLET, privateKey: PRIVATE }), { id, name: '主号', walletAddress: WALLET, privateKey: PRIVATE, includeSpot: false });
  assert.throws(() => parseAsterAccount({ id: 'aster-1', name: 'x', walletAddress: WALLET, privateKey: PRIVATE }), AssetInputError);
  assert.throws(() => parseAsterAccount({ id, name: 'x'.repeat(41), walletAddress: WALLET, privateKey: PRIVATE }), AssetInputError);
  assert.deepEqual(parseAsterAccountDelete({ id: 'default', action: 'remove' }), { id: 'default', action: 'remove' });
  assert.throws(() => parseAsterAccountDelete({ id, action: 'purge' }), AssetInputError);
  assert.equal(parseDisconnect({ exchange: 'rh-lighter' }), 'rh-lighter');
  assert.throws(() => parseDisconnect({ exchange: 'aster:' + id }), AssetInputError);
  assert.deepEqual([connectionExchange('okx'), connectionExchange('aster:' + id), connectionExchange('aster:aster-1'), connectionExchange('alice:okx')], ['okx', 'aster', null, null]);
});
