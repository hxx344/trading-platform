// The monitor and asset parts of the workbench import (src/service/import-modules.ts, docs/module-import.md): the plan of
// each, reading the workbench ledger and its users, the writer run as the data directory's owner, the page request body,
// the import helper's order (ledger first, no restart when only the ledger changes, the ledger kept when the config is
// put back) and the command line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ASSET_DB_FILE } from '../src/asset/db.ts';
import { CREDENTIAL_KEY_FILE, credentialKey, unseal } from '../src/asset/credentials.ts';
import { ledgerOwner, planAsset, planMonitor, readLastImport, readWorkbenchAsset, readWorkbenchLedger, writeLedgerAsService, type AssetSource } from '../src/service/import-modules.ts';
import { fileText, filesUnchanged, planImport, previewImport } from '../src/service/import-workbench.ts';
import { parseImportBody, parseImportRequest, readImportResult, submitImportRequest } from '../src/service/import-channel.ts';
import { runImportHelper } from '../src/service/import-helper.ts';
import { CIPHERTEXT, KEY_TAIL, OTHER_OWNER, OWNER, WALLET, writeWorkbenchLedger } from './asset-fixture.ts';

const NOW = Date.parse('2026-11-10T04:00:00Z');

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'tp-modules-import-'));
  const wb = join(root, 'wb'), svc = join(root, 'svc'), assetDir = join(wb, 'modules', 'asset');
  for (const path of [assetDir, svc]) mkdirSync(path, { recursive: true });
  const ledger = join(assetDir, 'ledger.sqlite');
  writeWorkbenchLedger(ledger, { now: NOW });
  return { root, wb, svc, ledger, target: join(svc, ASSET_DB_FILE), done: () => rmSync(root, { recursive: true, force: true }) };
}
const importInfo = (file: string): { owner: string; assets: number } => {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return JSON.parse((db.prepare("SELECT value FROM settings WHERE key = 'import-info'").get() as { value: string }).value) as { owner: string; assets: number }; }
  finally { db.close(); }
};
const noLedgerContent = (text: string): void => {
  for (const secret of [CIPHERTEXT, WALLET, KEY_TAIL, '冷钱包']) assert.ok(!text.includes(secret), `输出含 ${secret.slice(0, 8)}…`);
};
const fits = (): void => undefined;

test('行情监控导入：没有 monitor 时写入全部市场（默认股数），已有时保留现有设置、只补缺少的市场', () => {
  const config: Record<string, unknown> = { secretsFile: '/x/secrets.json', pairs: [] }, notes: string[] = [];
  const item = planMonitor({ workbench: true }, config, fits, notes);
  assert.deepEqual([item.status, item.enabled, item.shares, item.markets], ['added', false, { outstanding: 12.7, diluted: 16.7 }, ['anthropic', 'oil', 'hynix']]);
  assert.deepEqual(config.monitor, { anthropic: {}, oil: {}, hynix: {} });
  assert.match(item.detail, /Anthropic 价差（股数取默认值.*原油价差（每 10 秒读报价.*海力士溢价（每 10 秒读报价.*不需要密钥/);
  assert.match(notes.join(), /股数设置只存在浏览器里/);
  assert.match(notes.join(), /本地行情记录不导入/);
  // M-1 enabled the Anthropic premium only: its shares stay, the oil spread and the Hynix premium are added.
  const tuned = { secretsFile: '/x/secrets.json', monitor: { anthropic: { shares: { outstanding: 13, diluted: 17 } } } }, tunedNotes: string[] = [];
  const grown = planMonitor({ workbench: false }, tuned, fits, tunedNotes);
  assert.deepEqual([grown.status, grown.enabled, grown.shares, grown.markets], ['added', true, { outstanding: 13, diluted: 17 }, ['anthropic', 'oil', 'hynix']]);
  assert.match(grown.detail, /^补上 原油价差（.*、海力士溢价（.*已有的Anthropic 价差保留现有设置/);
  assert.deepEqual(tuned.monitor, { anthropic: { shares: { outstanding: 13, diluted: 17 } }, oil: {}, hynix: {} });
  assert.deepEqual(tunedNotes, [], '没有补 Anthropic 时不提默认股数');
  const kept = planMonitor({ workbench: false }, tuned, fits, []);
  assert.deepEqual([kept.status, kept.enabled, kept.shares], ['skipped', true, { outstanding: 13, diluted: 17 }]);
  assert.match(kept.detail, /已启用（Anthropic 价差、原油价差、海力士溢价.*保留现有设置/);
  // Only the oil spread configured: the Anthropic premium comes with the default shares.
  const oilOnly = { secretsFile: '/x/secrets.json', monitor: { oil: {} } };
  assert.equal(planMonitor({ workbench: false }, oilOnly, fits, []).status, 'added');
  assert.deepEqual(oilOnly.monitor, { oil: {}, anthropic: {}, hynix: {} });
  const broken = { secretsFile: '/x/secrets.json', monitor: { oil: { x: 1 } } };
  const refusedOld = planMonitor({ workbench: false }, broken, fits, []);
  assert.deepEqual([refusedOld.status, broken.monitor], ['skipped', { oil: { x: 1 } }]);
  assert.match(refusedOld.detail, /现有设置无效，未改动/);
  const refused = planMonitor({ workbench: false }, { pairs: [] }, () => { throw new Error('检查失败'); }, []);
  assert.deepEqual([refused.status, refused.detail], ['skipped', '加入后本服务不接受（检查失败）']);
});

test('资产账本读取：列出有账本的用户与条数，逐个按导入规则校验；读不了时逐项说明原因', () => {
  const w = workspace();
  try {
    const source = readWorkbenchLedger(w.wb);
    assert.equal(source.problem, null);
    assert.deepEqual(source.owners.map(item => [item.owner, item.importable, item.assets, item.snapshots]), [[OWNER, true, 6, 10], [OTHER_OWNER, true, 1, 1]]);
    assert.match(source.owners[0]!.detail, /资产 6 条、快照 10 条，最近的日快照 \d{4}-\d{2}-\d{2}/);
    assert.equal(source.more, 0);
    noLedgerContent(JSON.stringify(source.owners));
    // One user asked for: only that user's rows.
    const one = readWorkbenchLedger(w.wb, { owner: OTHER_OWNER });
    assert.deepEqual([...one.rows.keys()], [OTHER_OWNER]);

    // A broken row of one user: that user cannot come over, the reason names the row only.
    const db = new DatabaseSync(w.ledger);
    db.prepare("UPDATE assets SET data = '{oops' WHERE owner = ? AND id = 'row-2'").run(OWNER);
    db.prepare("INSERT INTO settings VALUES ('bad name', 'source-ledger', (SELECT value FROM settings WHERE owner = ? AND key = 'source-ledger'))").run(OTHER_OWNER);
    db.close();
    const spoilt = readWorkbenchLedger(w.wb);
    const byName = new Map(spoilt.owners.map(item => [item.owner, item]));
    assert.deepEqual([byName.get(OWNER)?.importable, byName.get(OWNER)?.detail], [false, '资产 row-2 不是有效的 JSON']);
    assert.equal(byName.get(OTHER_OWNER)?.importable, true);
    assert.equal(byName.get('bad name')?.importable, false);
    assert.match(byName.get('bad name')!.detail, /用户名含页面不支持的字符/);

    assert.match(readWorkbenchLedger(join(w.root, 'nowhere')).problem ?? '', /没有找到工作台的资产账本/);
    const dirLedger = join(w.root, 'dir-ledger');
    mkdirSync(join(dirLedger, 'modules', 'asset', 'ledger.sqlite'), { recursive: true });
    assert.match(readWorkbenchLedger(dirLedger).problem ?? '', /不是普通文件/);
    const empty = join(w.root, 'empty');
    mkdirSync(join(empty, 'modules', 'asset'), { recursive: true });
    new DatabaseSync(join(empty, 'modules', 'asset', 'ledger.sqlite')).close();
    assert.match(readWorkbenchLedger(empty).problem ?? '', /不是工作台的资产库（缺少 assets 表）/);
    const nobody = join(w.root, 'nobody');
    mkdirSync(join(nobody, 'modules', 'asset'), { recursive: true });
    const blank = new DatabaseSync(join(nobody, 'modules', 'asset', 'ledger.sqlite'));
    blank.exec('CREATE TABLE assets (owner TEXT, id TEXT, data TEXT); CREATE TABLE settings (owner TEXT, key TEXT, value TEXT); CREATE TABLE snapshots (owner TEXT, date TEXT, data TEXT);');
    blank.close();
    assert.match(readWorkbenchLedger(nobody).problem ?? '', /没有任何用户的账本/);
    assert.throws(() => readWorkbenchLedger('relative'), /绝对路径/);
  } finally { w.done(); }
});

test('资产账本计划：多个用户须选一个；选中后启用 asset 并交出要写的行；已启用时保留配置、整体替换', () => {
  const w = workspace();
  try {
    const source: AssetSource = readWorkbenchAsset(w.wb, w.svc);
    assert.deepEqual([source.last, source.lastProblem], [null, null]);
    const config: Record<string, unknown> = { secretsFile: '/x/secrets.json', pairs: [] };
    const unnamed = planAsset(source, config, fits, undefined, []);
    assert.deepEqual([unnamed.item.status, unnamed.write], ['skipped', null]);
    assert.match(unnamed.item.detail, /有 2 个用户，导入时须选择其中一个/);
    assert.equal(config.asset, undefined);
    assert.match(planAsset(source, config, fits, 'carol', []).item.detail, /没有用户 carol 的账本/);

    const chosen = planAsset(source, config, fits, OTHER_OWNER, []);
    assert.deepEqual([chosen.item.status, chosen.item.owner, chosen.write?.owner, chosen.write?.file], ['added', OTHER_OWNER, OTHER_OWNER, 'ledger.sqlite']);
    assert.deepEqual(config.asset, {});
    noLedgerContent(JSON.stringify(chosen.item));
    assert.ok(!('rows' in chosen.item), '计划结果不带账本行');

    const again = planAsset(source, config, fits, OWNER, []);
    assert.equal(again.item.status, 'added');
    assert.match(again.item.detail, /已启用资产账本，整体替换已有账本/);

    // A ledger of one user needs no choice.
    const single: AssetSource = { ...source, owners: source.owners.slice(0, 1), rows: new Map([[OWNER, source.rows.get(OWNER)!]]) };
    assert.equal(planAsset(single, { pairs: [] }, fits, undefined, []).write?.owner, OWNER);
    assert.equal(planAsset({ ...source, problem: '读不了' }, { pairs: [] }, fits, OWNER, []).item.detail, '读不了');

    // A single user whose name has control characters: the reason, not "no such user".
    const weird = 'ali\x07ce';
    const odd: AssetSource = { ...source, owners: [ledgerOwner(weird, source.rows.get(OWNER)!)], rows: new Map([[weird, source.rows.get(OWNER)!]]), more: 0 };
    const picked = planAsset(odd, { pairs: [] }, fits, undefined, []);
    assert.deepEqual([picked.item.status, picked.write], ['skipped', null]);
    assert.match(picked.item.detail, /页面不支持的字符/);
  } finally { w.done(); }
});

test('资产账本写入：以数据目录属主的子进程整体替换 asset.sqlite；校验不过时已有账本不变；上次导入记录可读', async () => {
  const w = workspace();
  try {
    const source = readWorkbenchAsset(w.wb, w.svc);
    const plan = planAsset(source, { pairs: [] }, fits, OWNER, []);
    const last = await writeLedgerAsService(w.svc, plan.write!);
    assert.deepEqual([last.owner, last.assets, last.snapshots], [OWNER, 6, 10]);
    // The fixture workbench has no config.json: the ledger comes over without its connection.
    assert.deepEqual([last.connections.imported, last.connections.skipped], [[], []]);
    assert.match(last.connections.problem ?? '', /config\.json 不存在，连接未导入（账本照常导入）/);
    assert.deepEqual([importInfo(w.target).owner, importInfo(w.target).assets], [OWNER, 6]);
    const raw = readFileSync(w.target).toString('latin1');
    for (const secret of [CIPHERTEXT, WALLET, KEY_TAIL]) assert.ok(!raw.includes(secret), '库里没有凭据与账户标识');
    assert.deepEqual(readLastImport(w.svc).last && [readLastImport(w.svc).last!.owner, readLastImport(w.svc).last!.assets], [OWNER, 6]);
    assert.equal(readWorkbenchAsset(w.wb, w.svc).last?.owner, OWNER);

    // Rows the writer's own check refuses: nothing is replaced.
    const spoilt = { ...plan.write!, rows: { ...plan.write!.rows, settings: [...plan.write!.rows.settings, { key: 'sync-state', value: '{}' }] } };
    await assert.rejects(writeLedgerAsService(w.svc, spoilt), /^Error: 写入资产账本失败，已有账本未改动：工作台账本的设置不在导入范围内/);
    assert.equal(importInfo(w.target).owner, OWNER);
    await assert.rejects(writeLedgerAsService(w.svc, { ...plan.write!, rows: { ...plan.write!.rows, assets: [{ id: 'x', data: '{}' }] } }), /资产 x 格式无效/);
    assert.equal(importInfo(w.target).assets, 6);
  } finally { w.done(); }
});

/** A value sealed as the workbench's vault does (WebCrypto AES-GCM, additional data owner:name). */
async function workbenchSeal(value: unknown, aad: string, keyHex: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', Buffer.from(keyHex, 'hex'), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) }, key, new TextEncoder().encode(JSON.stringify(value)));
  return JSON.stringify({ iv: Array.from(iv), cipher: Array.from(new Uint8Array(cipher)) });
}

test('资产账本写入：工作台连接由属主解密后直交写入进程，用本服务密钥重新加密并与账本同一事务写入；单个解密失败只跳过该连接', async () => {
  const w = workspace();
  try {
    const WB_KEY = 'a1'.repeat(32), ACCOUNT = '3f2a1b0c-9d8e-4f7a-8b6c-5d4e3f2a1b0c';
    const binance = { exchange: 'binance', apiKey: 'binance-key-B1N4', apiSecret: 'binance-secret-' + 'S'.repeat(20) };
    const aster = { exchange: 'aster', walletAddress: '0x' + 'cd'.repeat(18) + 'e5f6', privateKey: '0x' + '7'.repeat(64), includeSpot: true };
    writeFileSync(join(w.wb, 'modules', 'asset', 'config.json'), JSON.stringify({ credentialKey: WB_KEY, sessionSecret: 'b2'.repeat(32), passwordHash: 'c3'.repeat(16) + ':' + 'd4'.repeat(32) }));
    const db = new DatabaseSync(w.ledger);
    const add = (name: string, encrypted: string) => db.prepare('INSERT INTO connections VALUES (?, ?, ?, ?)').run(OWNER, name, encrypted, new Date(NOW).toISOString());
    add('binance', await workbenchSeal(binance, `${OWNER}:binance`, WB_KEY));
    add(`aster:${ACCOUNT}`, await workbenchSeal(aster, `${OWNER}:aster:${ACCOUNT}`, WB_KEY));
    // Sealed for another user: does not open with this user's additional data.
    add('okx', await workbenchSeal({ exchange: 'okx', apiKey: 'okx-key-0001', apiSecret: 'okx-secret-0001', passphrase: 'pass' }, `${OTHER_OWNER}:okx`, WB_KEY));
    add('mystery', await workbenchSeal({ apiKey: 'x' }, `${OWNER}:mystery`, WB_KEY));
    // A valid Aster connection whose account is not in the ledger: skipped, it could not be managed on the page.
    const ORPHAN = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';
    add(`aster:${ORPHAN}`, await workbenchSeal({ ...aster, walletAddress: '0x' + 'ab'.repeat(20) }, `${OWNER}:aster:${ORPHAN}`, WB_KEY));
    db.prepare("UPDATE settings SET value = ? WHERE owner = ? AND key = 'aster-accounts'").run(JSON.stringify([{ id: ACCOUNT, name: '主号', value: 6_200, details: [], updatedAt: new Date(NOW).toISOString(), includeSpot: true, configured: true, lastSync: null, error: null, scope: 'API Pro · 合约 + 现货', walletAddress: aster.walletAddress, label: 'e5f6' }]), OWNER);
    db.close();

    // The preview names the connections only.
    const source = readWorkbenchAsset(w.wb, w.svc);
    const owner = source.owners.find(item => item.owner === OWNER)!;
    assert.deepEqual(owner.connections, [`aster:${ACCOUNT}`, `aster:${ORPHAN}`, 'binance', 'bybit', 'mystery', 'okx']);
    assert.match(owner.detail, /连接 6 个（aster:3f2a1b0c-9d8e-4f7a-8b6c-5d4e3f2a1b0c、aster:9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b、binance、bybit、mystery、okx）/);
    assert.equal(source.connectionProblem, null);
    const notes: string[] = [];
    const plan = planAsset(source, { pairs: [] }, fits, OWNER, notes);
    assert.equal(plan.write?.ledger, w.ledger);
    assert.match(notes.join(), /连接（.*）一并导入/);
    const preview = JSON.stringify({ source: { ...source, rows: undefined }, item: plan.item, notes });
    for (const secret of [binance.apiSecret, aster.privateKey, aster.walletAddress]) assert.ok(!preview.includes(secret), '预览不带凭据');

    const last = await writeLedgerAsService(w.svc, plan.write!);
    assert.deepEqual(last.connections.imported, ['aster:3f2a1b0c-9d8e-4f7a-8b6c-5d4e3f2a1b0c', 'binance']);
    assert.deepEqual(last.connections.skipped.map(item => item.exchange).sort(), [`aster:${ORPHAN}`, 'bybit', 'mystery', 'okx']);
    assert.match(last.connections.skipped.find(item => item.exchange === `aster:${ORPHAN}`)!.reason, /没有对应的 Aster 账号/);
    assert.equal(last.connections.problem, null);
    const report = JSON.stringify(last);
    for (const secret of [binance.apiSecret, binance.apiKey, aster.privateKey, aster.walletAddress]) assert.ok(!report.includes(secret), '结果不带凭据');

    // Sealed again with this service's key, the additional data the name alone; the key file is the service's, 0600.
    const keyFile = join(w.svc, CREDENTIAL_KEY_FILE);
    assert.equal(statSync(keyFile).mode & 0o777, 0o600);
    const target = new DatabaseSync(w.target, { readOnly: true });
    const rows = target.prepare('SELECT exchange, encrypted FROM connections ORDER BY exchange').all() as { exchange: string; encrypted: string }[];
    const settings = new Map((target.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]).map(row => [row.key, row.value]));
    target.close();
    const key = credentialKey(w.svc);
    assert.deepEqual(rows.map(row => [row.exchange, unseal(row.encrypted, row.exchange, key)]), [[`aster:${ACCOUNT}`, aster], ['binance', binance]]);
    assert.throws(() => unseal(rows[1]!.encrypted, `${OWNER}:binance`, key), /decrypt failed/);
    // The tails come back from the credentials; wallet addresses stay out of the settings.
    assert.equal(JSON.parse(settings.get('aster-accounts')!)[0].label, 'e5f6');
    assert.ok(!settings.get('aster-accounts')!.includes(aster.walletAddress));
    assert.equal(JSON.parse(settings.get('bybit-status')!).label, undefined, '没导入的连接不补尾号');
    const raw = readFileSync(w.target).toString('latin1');
    for (const secret of [binance.apiSecret, aster.privateKey, aster.walletAddress, CIPHERTEXT]) assert.ok(!raw.includes(secret), '库里只有本服务密钥加密后的连接');

    // Importing again replaces the connections with the workbench's current ones; a workbench key gone means none.
    rmSync(join(w.wb, 'modules', 'asset', 'config.json'));
    const missing = readWorkbenchAsset(w.wb, w.svc);
    assert.match(missing.connectionProblem ?? '', /没有 config\.json，已保存的连接无法解密，导入时只导入账本、不带连接/);
    const again = await writeLedgerAsService(w.svc, planAsset(missing, { pairs: [] }, fits, OWNER, []).write!);
    assert.deepEqual(again.connections.imported, []);
    const after = new DatabaseSync(w.target, { readOnly: true });
    assert.equal((after.prepare('SELECT COUNT(*) AS n FROM connections').get() as { n: number }).n, 0);
    after.close();
  } finally { w.done(); }
});

test('页面请求：monitor、asset 只能是 true，asset 须带合规的用户名；只勾这两项也可以；预览不能带', () => {
  assert.deepEqual(parseImportBody({ action: 'import', monitor: true }), { action: 'import', pairs: [], monitor: true });
  assert.deepEqual(parseImportBody({ action: 'import', asset: true, assetOwner: 'alice.w@x-1' }), { action: 'import', pairs: [], asset: true, assetOwner: 'alice.w@x-1' });
  assert.deepEqual(parseImportBody({ action: 'import', pairs: ['p1'], monitor: true, asset: true, assetOwner: 'a' }), { action: 'import', pairs: ['p1'], monitor: true, asset: true, assetOwner: 'a' });
  assert.throws(() => parseImportBody({ action: 'import', monitor: false }), /monitor 只能是 true/);
  assert.throws(() => parseImportBody({ action: 'import', asset: 'yes', assetOwner: 'a' }), /asset 只能是 true/);
  assert.throws(() => parseImportBody({ action: 'import', asset: true }), /须选择一个工作台用户/);
  for (const owner of ['', '.alice', 'a b', 'a/b', '../x', 'a'.repeat(65), 7, null]) assert.throws(() => parseImportBody({ action: 'import', asset: true, assetOwner: owner }), /须选择一个工作台用户/, String(owner));
  assert.ok(parseImportBody({ action: 'import', asset: true, assetOwner: 'a'.repeat(64) }).assetOwner);
  assert.throws(() => parseImportBody({ action: 'import', assetOwner: 'alice' }), /assetOwner 须和 asset 一起使用/);
  for (const extra of [{ monitor: true }, { asset: true }, { assetOwner: 'alice' }]) assert.throws(() => parseImportBody({ action: 'preview', ...extra }), /预览不选配对/);
  assert.throws(() => parseImportBody({ action: 'import', path: '/etc/shadow', asset: true, assetOwner: 'a' }), /path/);
  // The earlier messages stay as they were.
  assert.throws(() => parseImportBody({ action: 'import' }), /请选择 1–20 个配对，或勾选导入原油执行账户/);
  const request = parseImportRequest({ id: '00000000-0000-4000-8000-000000000000', action: 'import', at: 1, monitor: true, asset: true, assetOwner: 'bob' });
  assert.deepEqual([request.monitor, request.asset, request.assetOwner], [true, true, 'bob']);
});

test('planImport：只启用行情监控与资产账本时不要配对；配置只有模块时重新导入账本不算改动', () => {
  const w = workspace();
  try {
    const asset = readWorkbenchAsset(w.wb, w.svc);
    const plan = planImport({ pairs: [], accounts: [], env: {} }, null, { secretsFile: '/x/secrets.json', only: [], monitor: { workbench: false }, asset, assetOwner: OWNER });
    assert.deepEqual([plan.monitor?.status, plan.asset?.status, plan.ledger?.owner], ['added', 'added', OWNER]);
    assert.deepEqual([plan.config.monitor, plan.config.asset, plan.config.pairs], [{ anthropic: {}, oil: {}, hynix: {} }, {}, []]);
    assert.equal(filesUnchanged(plan, null), false);
    const existing = { config: { secretsFile: '/x/secrets.json', asset: {} }, secrets: { accounts: {} } };
    const again = planImport({ pairs: [], accounts: [], env: {} }, existing, { secretsFile: '/x/secrets.json', only: [], asset, assetOwner: OTHER_OWNER });
    assert.deepEqual([again.asset?.status, again.ledger?.owner], ['added', OTHER_OWNER]);
    assert.ok(filesUnchanged(again, existing), '只重新导入账本，配置不变');
    const preview = previewImport({ pairs: [], accounts: [], env: {} }, existing, { secretsFile: '/x/secrets.json', monitor: { workbench: true }, asset });
    assert.deepEqual([preview.monitor?.status, preview.asset?.enabled, preview.asset?.owners.length], ['added', true, 2]);
    assert.equal(previewImport({ pairs: [], accounts: [], env: {} }, existing, { secretsFile: '/x/secrets.json' }).asset, undefined);
  } finally { w.done(); }
});

test('导入助手：预览列出行情监控与资产账本；先写账本再写配置；只重导账本不重启；账本失败什么都不改；配置恢复时账本保留', async () => {
  const w = workspace();
  try {
    const conf = join(w.root, 'conf'), dir = join(w.root, 'import');
    for (const path of [conf, dir]) mkdirSync(path, { recursive: true });
    writeFileSync(join(w.root, 'workbench.env'), `DATA_DIR=${w.wb}\n`);
    mkdirSync(join(w.root, 'proc'));
    const configFile = join(conf, 'config.json'), secretsFile = join(conf, 'secrets.json');
    const first = fileText({ secretsFile, pairs: [] });
    writeFileSync(secretsFile, fileText({ accounts: {} }), { mode: 0o600 });
    writeFileSync(configFile, first, { mode: 0o600 });
    const restarts: string[] = [];
    let check: () => string = () => 'ok';
    const base = { dir, configFile, dataDir: w.svc, workbenchEnv: join(w.root, 'workbench.env'), log: () => undefined, checkConfig: () => check(), procDir: join(w.root, 'proc'),
      restart: async () => { restarts.push(readFileSync(configFile, 'utf8')); return true; } };
    const run = async (body: unknown, options: Partial<Parameters<typeof runImportHelper>[0]> = {}) => {
      submitImportRequest(dir, body);
      await runImportHelper({ ...base, ...options });
      return readImportResult(dir)!;
    };

    const shown = await run({ action: 'preview' });
    assert.equal(shown.phase, 'done', shown.message);
    assert.match(shown.message, /行情监控可以启用；资产账本可以导入（2 个用户）/);
    assert.deepEqual([shown.monitor?.status, shown.asset?.owners.map(item => item.owner)], ['added', [OWNER, OTHER_OWNER]]);
    assert.equal(readFileSync(configFile, 'utf8'), first, '预览不写文件');
    noLedgerContent(readFileSync(join(dir, 'result.json'), 'utf8'));

    // The ledger fails: neither the config nor asset.sqlite changes, no restart.
    const failed = await run({ action: 'import', monitor: true, asset: true, assetOwner: OWNER }, { writeLedger: () => { throw new Error('写入资产账本失败，已有账本未改动：库被占用'); } });
    assert.equal(failed.phase, 'failed');
    assert.match(failed.message, /库被占用；配置未改动，本次没有导入任何内容/);
    assert.equal(readFileSync(configFile, 'utf8'), first);
    assert.equal(restarts.length, 0);

    const done = await run({ action: 'import', monitor: true, asset: true, assetOwner: OWNER });
    assert.equal(done.phase, 'done', done.message);
    assert.match(done.message, /已导入 行情监控与资产账本（用户 alice），服务已重启/);
    assert.equal(restarts.length, 1);
    const config = JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>;
    assert.deepEqual([config.monitor, config.asset], [{ anthropic: {}, oil: {}, hynix: {} }, {}]);
    assert.equal(importInfo(w.target).owner, OWNER);
    assert.equal(done.asset?.status, 'added');
    noLedgerContent(readFileSync(join(dir, 'result.json'), 'utf8'));

    // The ledger again, another user: written, the config untouched, no restart.
    const written = readFileSync(configFile, 'utf8');
    const again = await run({ action: 'import', asset: true, assetOwner: OTHER_OWNER });
    assert.equal(again.phase, 'done', again.message);
    assert.match(again.message, /已重新导入资产账本（用户 bob，资产 1 条、快照 1 条）；配置未改动，未重启服务/);
    assert.equal(readFileSync(configFile, 'utf8'), written);
    assert.equal(restarts.length, 1);
    assert.equal(importInfo(w.target).owner, OTHER_OWNER);
    // Monitor already on: nothing to do.
    assert.match((await run({ action: 'import', monitor: true })).message, /行情监控不能导入，配置未改动/);

    // The config check fails: the config goes back, the ledger written first stays and the message says so.
    writeFileSync(configFile, first, { mode: 0o600 });
    check = () => { throw new Error('配置检查失败'); };
    const restored = await run({ action: 'import', asset: true, assetOwner: OWNER });
    assert.equal(restored.phase, 'failed');
    assert.match(restored.message, /未通过服务检查（配置检查失败），已恢复导入前的配置。资产账本已写入并保留/);
    assert.equal(readFileSync(configFile, 'utf8'), first);
    assert.equal(importInfo(w.target).owner, OWNER);
    assert.equal(restarts.length, 1);
  } finally { w.done(); }
});

test('命令行：--monitor --asset 启用行情监控并导入指定用户的账本；多个用户不指定时报错列出、不改文件；参数须成对', () => {
  const w = workspace();
  try {
    const conf = join(w.root, 'conf');
    mkdirSync(conf);
    const configFile = join(conf, 'config.json'), secretsFile = join(conf, 'secrets.json');
    writeFileSync(secretsFile, fileText({ accounts: {} }), { mode: 0o600 });
    writeFileSync(configFile, fileText({ secretsFile, pairs: [] }), { mode: 0o600 });
    const cli = (...args: string[]) => spawnSync(process.execPath, ['src/service/import-workbench.ts', '--config', configFile, '--workbench-env', join(w.root, 'none.env'), '--workbench-data', w.wb, ...args], { encoding: 'utf8' });

    const ambiguous = cli('--monitor', '--asset', '--data-dir', w.svc);
    assert.equal(ambiguous.status, 1);
    assert.match(ambiguous.stderr, /有多个用户（alice、bob），请用 --asset-owner <用户> 指定，未改动任何文件/);
    assert.equal(readFileSync(configFile, 'utf8'), fileText({ secretsFile, pairs: [] }));

    const dry = cli('--monitor', '--asset', '--asset-owner', OWNER, '--data-dir', w.svc, '--dry-run');
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /试运行：未写入任何文件/);
    assert.throws(() => readFileSync(w.target));

    const ok = cli('--monitor', '--asset', '--asset-owner', OWNER, '--data-dir', w.svc);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /工作台资产账本：.*ledger\.sqlite（只读）/);
    assert.match(ok.stdout, /启用行情监控 Anthropic 价差/);
    assert.match(ok.stdout, /已写入资产账本 .*asset\.sqlite：用户 alice，资产 6 条、快照 10 条/);
    assert.match(ok.stdout, /行情监控已写入.*资产账本已启用/);
    noLedgerContent(ok.stdout);
    const config = JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>;
    assert.deepEqual([config.monitor, config.asset], [{ anthropic: {}, oil: {}, hynix: {} }, {}]);

    const again = cli('--asset', '--asset-owner', OTHER_OWNER, '--data-dir', w.svc);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /配置未改动（资产账本已启用，只重新导入了账本/);
    assert.equal(importInfo(w.target).owner, OTHER_OWNER);

    assert.match(cli('--asset-owner', OWNER).stderr, /--asset-owner 须和 --asset 一起使用/);
    assert.match(cli('--asset', '--asset-owner', '../x', '--data-dir', w.svc).stderr, /--asset-owner 须为工作台资产用户名/);
    assert.match(cli('--asset').stderr, /--asset 需要 --data-dir/);
  } finally { w.done(); }
});
