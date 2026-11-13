// The workbench ledger import: one owner's rows only, the target replaced as a whole, a failed import leaving the
// previous data untouched, and no credential or account identifier copied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ASSET_DB_FILE } from '../src/asset/db.ts';
import { IMPORTED_SETTINGS, assertNoCredentials, importLedger, redactError } from '../src/asset/import.ts';
import { CIPHERTEXT, KEY_TAIL, OTHER_OWNER, OWNER, WALLET, WORKBENCH_ONLY_KEYS, writeWorkbenchLedger } from './asset-fixture.ts';

const NOW = Date.parse('2026-11-10T04:00:00Z');

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'tp-asset-import-'));
  const from = join(root, 'ledger.sqlite'), dataDir = join(root, 'data');
  writeWorkbenchLedger(from, { now: NOW });
  return { root, from, dataDir, target: join(dataDir, ASSET_DB_FILE), done: () => rmSync(root, { recursive: true, force: true }) };
}
/** Everything in asset.sqlite, read with its own connection. */
function contents(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      assets: db.prepare('SELECT id, data FROM assets ORDER BY id').all() as { id: string; data: string }[],
      snapshots: db.prepare('SELECT date, data FROM snapshots ORDER BY date').all() as { date: string; data: string }[],
      settings: Object.fromEntries((db.prepare('SELECT key, value FROM settings ORDER BY key').all() as { key: string; value: string }[]).map(row => [row.key, row.value])),
      tables: (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(row => row.name),
    };
  } finally { db.close(); }
}

test('资产导入：只取指定用户，设置按白名单复制并去掉钱包地址与密钥尾号，凭据表不读', () => {
  const w = workspace();
  try {
    const summary = importLedger({ from: w.from, owner: OWNER, dataDir: w.dataDir, now: () => NOW });
    assert.deepEqual([summary.owner, summary.file, summary.assets, summary.snapshots, summary.importedAt], [OWNER, 'ledger.sqlite', 6, 10, new Date(NOW).toISOString()]);
    const saved = contents(w.target);
    assert.deepEqual(saved.tables, ['assets', 'settings', 'snapshots', 'sync_locks'], '没有 connections 表；sync_locks 是 A-2 的同步锁（单行）');
    assert.equal(saved.assets.length, 6);
    assert.equal(saved.snapshots.length, 10, '9 个日快照与 1 条导入前记录');
    const keys = Object.keys(saved.settings).sort();
    assert.ok(keys.includes('source-ledger'), '原表数据必须导入');
    assert.ok(keys.includes('import-info'));
    for (const key of keys) assert.ok(key === 'import-info' || IMPORTED_SETTINGS.includes(key), `白名单外的设置 ${key}`);
    for (const key of WORKBENCH_ONLY_KEYS) assert.ok(!keys.includes(key), `${key} 只属于工作台`);
    assert.deepEqual(summary.settings, keys.filter(key => key !== 'import-info'));
    assert.deepEqual(JSON.parse(saved.settings['import-info']!), summary);
    const accounts = JSON.parse(saved.settings['aster-accounts']!) as Record<string, unknown>[];
    assert.equal(accounts.length, 1);
    assert.ok(!('walletAddress' in accounts[0]!) && !('label' in accounts[0]!), 'Aster 账号不带钱包地址与尾号');
    assert.equal(accounts[0]!.name, '主号');
    for (const key of ['aster-status', 'bybit-status']) assert.deepEqual(Object.keys(JSON.parse(saved.settings[key]!)).sort(), ['configured', 'error', 'lastSync', 'scope'], key);
    // Nothing of the other user, the credentials or the identifiers anywhere in the file.
    const raw = readFileSync(w.target).toString('latin1');
    for (const secret of [CIPHERTEXT, WALLET, KEY_TAIL, `${OTHER_OWNER} 的资产表`]) assert.ok(!raw.includes(Buffer.from(secret).toString('latin1')), `库文件含 ${secret.slice(0, 8)}…`);
  } finally { w.done(); }
});

test('资产导入：再次导入整体替换，换用户也只剩该用户的数据', () => {
  const w = workspace();
  try {
    importLedger({ from: w.from, owner: OWNER, dataDir: w.dataDir, now: () => NOW });
    const source = new DatabaseSync(w.from);
    source.prepare('DELETE FROM assets WHERE owner = ? AND id = ?').run(OWNER, 'row-6');
    source.prepare('DELETE FROM settings WHERE owner = ? AND key = ?').run(OWNER, 'withdrawals');
    source.close();
    importLedger({ from: w.from, owner: OWNER, dataDir: w.dataDir, now: () => NOW + 1_000 });
    let saved = contents(w.target);
    assert.deepEqual(saved.assets.map(row => row.id), ['row-1', 'row-2', 'row-3', 'row-4', 'row-5']);
    assert.ok(!('withdrawals' in saved.settings), '源里删掉的设置不会残留');
    assert.equal(JSON.parse(saved.settings['import-info']!).importedAt, new Date(NOW + 1_000).toISOString());
    importLedger({ from: w.from, owner: OTHER_OWNER, dataDir: w.dataDir, now: () => NOW + 2_000 });
    saved = contents(w.target);
    assert.deepEqual([saved.assets.length, saved.snapshots.length], [1, 1]);
    assert.deepEqual(Object.keys(saved.settings).sort(), ['import-info', 'source-ledger']);
    assert.equal(JSON.parse(saved.settings['import-info']!).owner, OTHER_OWNER);
  } finally { w.done(); }
});

test('资产导入：校验失败时已有数据原样保留，报错只说字段名不带内容', () => {
  const w = workspace();
  try {
    importLedger({ from: w.from, owner: OWNER, dataDir: w.dataDir, now: () => NOW });
    const before = contents(w.target);
    const broken = (sql: string, ...values: string[]) => { const db = new DatabaseSync(w.from); db.prepare(sql).run(...values); db.close(); };
    const secret = 'S'.repeat(24) + 'leak';
    const cases: [spoil: () => void, message: RegExp][] = [
      [() => broken("UPDATE snapshots SET data = json_set(data, '$.assets[0].apiKey', ?) WHERE owner = ? AND date = (SELECT MAX(date) FROM snapshots WHERE owner = ?)", secret, OWNER, OWNER), /快照 .*apiKey/],
      [() => broken("UPDATE settings SET value = json_set(value, '$.privateKey', ?) WHERE owner = ? AND key = 'fx-status'", secret, OWNER), /fx-status.*privateKey/],
      [() => broken("UPDATE assets SET data = '{oops' WHERE owner = ? AND id = 'row-2'", OWNER), /资产 row-2 不是有效的 JSON/],
      [() => broken("UPDATE settings SET value = '[{\"id\":1}]' WHERE owner = ? AND key = 'cash-flow-audit-v1'", OWNER), /cash-flow-audit-v1 无效/],
      [() => broken("UPDATE settings SET value = '{\"periods\":[]}' WHERE owner = ? AND key = 'source-ledger'", OWNER), /缺少起始快照/],
    ];
    for (const [i, [spoil, pattern]] of cases.entries()) {
      // Each case starts from a fresh, valid source.
      rmSync(w.from); writeWorkbenchLedger(w.from, { now: NOW });
      spoil();
      assert.throws(() => importLedger({ from: w.from, owner: OWNER, dataDir: w.dataDir, now: () => NOW + 5_000 }), (error: Error) => pattern.test(error.message) && !error.message.includes(secret), `case ${i}`);
      assert.deepEqual(contents(w.target), before, `case ${i}: 失败后已有数据不变`);
    }
    assert.throws(() => importLedger({ from: w.from, owner: 'nobody', dataDir: w.dataDir }), /没有用户 nobody 的账本/);
    assert.throws(() => importLedger({ from: join(w.root, 'missing.sqlite'), owner: OWNER, dataDir: w.dataDir }), /找不到工作台的库文件/);
    assert.throws(() => importLedger({ from: w.target, owner: OWNER, dataDir: w.dataDir }), /不能是本服务自己的 asset\.sqlite/);
    const empty = join(w.root, 'empty.sqlite'); new DatabaseSync(empty).close();
    assert.throws(() => importLedger({ from: empty, owner: OWNER, dataDir: w.dataDir }), /不是工作台的资产库（缺少 assets 表）/);
    assert.deepEqual(contents(w.target), before);
  } finally { w.done(); }
});

test('资产导入：凭据字段检查覆盖嵌套对象与数组，不分大小写', () => {
  assert.doesNotThrow(() => assertNoCredentials({ assets: [{ id: 'row-1', details: [{ coin: 'USDT', account: '统一账户' }] }], positions: { scopes: [{ generation: 'abc', account: 'acc' }] } }, '快照'));
  for (const key of ['apiKey', 'APISECRET', 'walletAddress', 'vrToken', 'passphrase', 'encrypted', 'api_key', 'private-key', 'Secret_Key', 'vr-token', 'apiSecretKey', 'mnemonic'])
    assert.throws(() => assertNoCredentials({ a: [{ b: { [key]: 'x' } }] }, '快照 '), new RegExp(`快照 含有凭据或账户标识字段 ${key}`));
});

test('资产导入：交易所报错原文里的钱包地址与 64 位十六进制串被隐去，其余文字保留', () => {
  const wallet = '0x' + 'aB12'.repeat(10), key = 'c3'.repeat(32);
  assert.deepEqual(redactError({ configured: true, error: `account ${wallet} rejected, key ${key}, tx 0x${key}, code -2015` }),
    { configured: true, error: 'account （已隐去） rejected, key （已隐去）, tx （已隐去）, code -2015' });
  assert.deepEqual(redactError({ error: null, scope: 'spot' }), { error: null, scope: 'spot' });
});

test('资产导入命令：成功输出条数，失败说明未改动已有数据并以 1 退出', () => {
  const w = workspace();
  try {
    const run = (...args: string[]) => spawnSync(process.execPath, ['src/asset/import.ts', ...args], { encoding: 'utf8' });
    const ok = run('--from', w.from, '--owner', OWNER, '--data-dir', w.dataDir);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /已导入用户 alice 的资产账本：资产 6 条，快照 10 条，设置 \d+ 项/);
    const failed = run('--from', w.from, '--owner', 'nobody', '--data-dir', w.dataDir);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /^导入失败，未改动已有数据：工作台库里没有用户 nobody 的账本/);
    assert.equal(run('--from', w.from, '--owner', OWNER, '--data-dir', 'relative').status, 1);
    assert.match(run('--from', w.from, '--owner', OWNER).stderr, /需要 --data-dir/);
    assert.equal(contents(w.target).assets.length, 6);
  } finally { w.done(); }
});
