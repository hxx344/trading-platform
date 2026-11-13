// Importing the workbench's ASTER pairs: settings carried over field by field, pairs that cannot run here skipped with
// the reason, an existing config only extended, and the files written private without a key in the output.
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseEnv } from 'node:util';
import { fileText, planImport, readWorkbench, readerIdentity } from '../src/service/import-workbench.ts';
import { REQUEST_FILE, RESULT_FILE, RUNNING_STALE_MS, parseImportBody, readImportResult, submitImportRequest, takeImportRequest, writeImportResult } from '../src/service/import-channel.ts';
import { runImportHelper } from '../src/service/import-helper.ts';
import { keptSession } from '../src/data-dir.ts';
import { parseServiceConfig } from '../src/service/config.ts';
import { LONG, MAIN, SHORT } from './aster-fake.ts';
import { addressOf } from '../src/aster/eip712.ts';

const HOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/abcdefgh1234';
const key = (byte: string) => '0x' + byte.repeat(32);
const S2 = { user: '0x' + '4d'.repeat(20), signer: addressOf(key('24')), privateKey: key('24') };
const env = (prefix: string, wallet: { user: string; signer: string; privateKey: string }) =>
  `${prefix}_USER=${wallet.user}\n${prefix}_SIGNER=${wallet.signer}\n${prefix}_PRIVATE_KEY="${wallet.privateKey}"\n`;

function workbench() {
  const root = mkdtempSync(join(tmpdir(), 'tp-import-'));
  const data = join(root, 'data'), module = join(data, 'modules', 'aster');
  mkdirSync(module, { recursive: true });
  const db = new DatabaseSync(join(module, 'trading.sqlite3'));
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE accounts (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE pairs (id TEXT PRIMARY KEY, data TEXT NOT NULL);');
  const account = (id: string, prefix: string, mode = 'live') => db.prepare('INSERT INTO accounts VALUES (?, ?)').run(id, JSON.stringify({ id, name: id, mode, env_prefix: prefix, enabled: false }));
  account('l1', 'ASTER_L1'); account('s1', 'ASTER_S1'); account('l2', 'ASTER_L2'); account('s2', 'ASTER_S2'); account('p1', 'ASTER_P1', 'paper'); account('p2', 'ASTER_P2');
  const pair = (value: object) => db.prepare('INSERT INTO pairs VALUES (?, ?)').run((value as { id: string }).id, JSON.stringify(value));
  pair({ id: 'gold', name: '黄金', long_account_id: 'l1', short_account_id: 's1', adl: { enabled: false, batch_notional: '500' },
    margin: { enabled: true, master_env_prefix: 'ASTER_MAIN', check_interval_seconds: 10, threshold: '20', min_transfer: '2', max_transfer: '300', buffer_ratio: '0.1',
      absolute_reserve_enabled: true, long_reserve: '50', short_reserve: '40', cooldown_seconds: 60 } });
  // Off in the workbench, so not brought over unless named.
  pair({ id: 'idle', name: '未开启', long_account_id: 'l2', short_account_id: 's2', margin: { enabled: false, master_env_prefix: 'ASTER_MAIN', absolute_reserve_enabled: false, long_reserve: '9' } });
  pair({ id: 'paper', name: '模拟', long_account_id: 'p1', short_account_id: 'p2', margin: { enabled: true, master_env_prefix: 'ASTER_MAIN' } });
  db.close();
  // The server environment holds the main account and the legacy robot; the module's own file holds the sub-accounts
  // and the split robot, and wins as it does in the workbench.
  writeFileSync(join(root, 'workbench.env'), `DATA_DIR=${data}\n${env('ASTER_MAIN', MAIN)}FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/legacy999\n`);
  writeFileSync(join(module, '.env'), `${env('ASTER_L1', LONG)}${env('ASTER_S1', SHORT)}${env('ASTER_L2', LONG)}FEISHU_EVENT_WEBHOOK_URL=${HOOK}\nFEISHU_EVENT_SIGN_SECRET=sig\nFEISHU_SCHEDULED_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/timed1234\n`);
  return { root, data, envFile: join(root, 'workbench.env') };
}

test('导入工作台：逐项沿用保证金与 ADL 设置，跳过未开启、模拟与凭据不全的配对，飞书取事件通知机器人', () => {
  const wb = workbench();
  try {
    const source = readWorkbench(wb.envFile, undefined);
    const plan = planImport(source, null, { secretsFile: '/etc/trading-platform/secrets.json' });
    assert.deepEqual((plan.config.pairs as unknown[]), [{
      id: 'gold', main: 'ASTER_MAIN', long: 'ASTER_L1', short: 'ASTER_S1',
      transfer: { threshold: '20', minTransfer: '2', maxTransfer: '300', bufferRatio: '0.1', longReserve: '50', shortReserve: '40', cooldownMs: 60_000, checkIntervalMs: 10_000 },
      adl: { autoReduce: false, batchNotional: '500' },
    }]);
    assert.equal(parseServiceConfig(plan.config).pairs[0]!.adl!.batchNotional, '500');
    assert.deepEqual(Object.keys(plan.secrets.accounts as object).sort(), ['ASTER_L1', 'ASTER_MAIN', 'ASTER_S1']);
    assert.deepEqual(plan.secrets.feishu, { webhook: HOOK, secret: 'sig' });
    assert.deepEqual(plan.secrets.feishuScheduled, { webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/timed1234' }, '定时摘要沿用工作台的定时机器人');
    assert.ok(plan.skipped.some(line => /^idle.*未开启保证金平衡/.test(line)));
    assert.ok(plan.skipped.some(line => /^paper.*不是实盘模式/.test(line)));

    // A missing credential is reported by its variable names only.
    const named = planImport(source, null, { secretsFile: '/etc/trading-platform/secrets.json', only: ['idle'] });
    assert.equal(named.added.length, 0);
    assert.match(named.skipped.join('\n'), /idle.*ASTER_S2 的完整凭据/);
    // Named explicitly, a pair that is off comes over, with reserves 0 when the workbench did not use them; its long
    // side shares gold's wallet, which is refused only together with gold.
    const withS2 = { ...source, env: { ...source.env, ASTER_S2_USER: S2.user, ASTER_S2_SIGNER: S2.signer, ASTER_S2_PRIVATE_KEY: S2.privateKey } };
    const idle = planImport(withS2, null, { secretsFile: '/etc/trading-platform/secrets.json', only: ['idle'] });
    assert.equal(idle.added.length, 1, idle.skipped.join('\n'));
    assert.deepEqual((idle.config.pairs as { transfer: { longReserve: string; shortReserve: string } }[])[0]!.transfer.longReserve, '0');
    assert.deepEqual((idle.config.pairs as { transfer: { longReserve: string; shortReserve: string } }[])[0]!.transfer.shortReserve, '0');
    const both = planImport(withS2, null, { secretsFile: '/etc/trading-platform/secrets.json', only: ['gold', 'idle'] });
    assert.deepEqual(both.added.map(line => line.split('（')[0]), ['gold']);
    assert.match(both.skipped.join('\n'), /idle.*子账户已属于本项目的另一个配对/);
    // A setting this service does not accept skips that pair only, naming it.
    const odd = planImport({ ...source, pairs: source.pairs.map(pair => pair.id === 'gold' ? { ...pair, margin: { ...(pair.margin as object), max_transfer: '1e3' } } : pair) }, null, { secretsFile: '/x/secrets.json' });
    assert.equal(odd.added.length, 0);
    assert.match(odd.skipped.join('\n'), /gold.*设置无法沿用/);
    assert.throws(() => planImport(source, null, { secretsFile: '/x/secrets.json', only: ['nope'] }), /工作台里没有配对 nope/);
  } finally { rmSync(wb.root, { recursive: true, force: true }); }
});

test('导入工作台：root 以数据库属主身份读库，工作台运行中时读到尚未写回主文件的记录', () => {
  // SQLite may add -wal/-shm on a read; made by the database's owner they never stop the workbench writing.
  assert.deepEqual(readerIdentity({ uid: 990, gid: 991 }, 0), { uid: 990, gid: 991 });
  assert.deepEqual(readerIdentity({ uid: 0, gid: 0 }, 0), {});
  assert.deepEqual(readerIdentity({ uid: 990, gid: 991 }, 1000), {});
  const wb = workbench();
  try {
    const dir = join(wb.data, 'modules', 'aster'), file = join(dir, 'trading.sqlite3');
    const list = () => readdirSync(dir).sort();
    const owner = statSync(file).uid;
    readWorkbench(wb.envFile, undefined);
    for (const name of list()) assert.equal(statSync(join(dir, name)).uid, owner, name);

    // Running: the write sits in the WAL only; the side files are the workbench's and stay as they were.
    const writer = new DatabaseSync(file);
    try {
      writer.exec('PRAGMA wal_autocheckpoint = 0');
      writer.prepare('INSERT INTO pairs VALUES (?, ?)').run('fresh', JSON.stringify({ id: 'fresh', long_account_id: 'l2', short_account_id: 's2' }));
      writer.prepare('INSERT INTO pairs VALUES (?, ?)').run('zz-broken', '{not json');
      const running = list(), modes = running.map(name => statSync(join(dir, name)).mode);
      assert.ok(running.includes('trading.sqlite3-wal'));
      const source = readWorkbench(wb.envFile, undefined);
      assert.ok(source.pairs.some(pair => pair.id === 'fresh'));
      assert.equal(source.unreadablePairs, 1);
      assert.deepEqual(list(), running);
      assert.deepEqual(running.map(name => statSync(join(dir, name)).mode), modes);
      // A pair whose row cannot be read is reported, and naming it says why it is not found.
      assert.match(planImport(source, null, { secretsFile: '/x/secrets.json' }).notes.join('\n'), /1 条配对记录无法解析/);
      assert.throws(() => planImport(source, null, { secretsFile: '/x/secrets.json', only: ['zz-broken'] }), /另有 1 条配对记录无法解析/);
    } finally { writer.close(); }
    // A database without the tables is reported as a read failure, not as an empty workbench.
    rmSync(file); for (const name of list()) if (name.startsWith('trading.sqlite3')) rmSync(join(dir, name));
    new DatabaseSync(join(dir, 'other.sqlite3')).close();
    // A link is never followed (as root it could point the read at another file).
    symlinkSync(join(dir, 'other.sqlite3'), file);
    assert.throws(() => readWorkbench(wb.envFile, undefined), /不是普通文件/);
    rmSync(file); renameSync(join(dir, 'other.sqlite3'), file);
    assert.throws(() => readWorkbench(wb.envFile, undefined), /读取工作台数据库 .* 失败：.*no such table: pairs/);
    // Existing keys the service would reject stop the import before any pair is weighed.
    assert.throws(() => planImport({ pairs: [], accounts: [], env: {} }, { config: { secretsFile: '/x/secrets.json', pairs: [] }, secrets: { accounts: { old: { user: '0x' + '11'.repeat(20) } } } }, { secretsFile: '/x/secrets.json' }), /现有密钥文件未通过检查/);
  } finally { rmSync(wb.root, { recursive: true, force: true }); }
});

test('导入工作台：超出请求预算或主账户签名与别的配对子账户相同时只跳过该配对，名称里的控制字符不输出', () => {
  // Three pairs checking every second need more than the service's share of the IP limit: the third is skipped.
  const wallet = (index: number) => { const privateKey = key((0x30 + index).toString(16)); return { user: '0x' + (0x60 + index).toString(16).repeat(20), signer: addressOf(privateKey), privateKey }; };
  const lines: string[] = [env('PM', MAIN)];
  const accounts: Record<string, unknown>[] = [], pairs: Record<string, unknown>[] = [];
  for (const index of [1, 2, 3]) {
    for (const side of ['L', 'S']) {
      const id = `${side}${index}`;
      accounts.push({ id, mode: 'live', env_prefix: `P_${id}` });
      lines.push(env(`P_${id}`, wallet(index * 2 + (side === 'L' ? 0 : 1))));
    }
    pairs.push({ id: `fast-${index}`, name: index === 1 ? '快\u001b[31m速‎' : 'fast', long_account_id: `L${index}`, short_account_id: `S${index}`, margin: { enabled: true, master_env_prefix: 'PM', check_interval_seconds: 1 } });
  }
  // Its main account is pair fast-1's long side, whose API wallet is a sub-account signer.
  accounts.push({ id: 'L9', mode: 'live', env_prefix: 'P_L9' }, { id: 'S9', mode: 'live', env_prefix: 'P_S9' });
  lines.push(env('P_L9', wallet(20)), env('P_S9', wallet(21)));
  pairs.push({ id: 'cross', long_account_id: 'L9', short_account_id: 'S9', margin: { enabled: true, master_env_prefix: 'P_L1' } });
  const source = { pairs, accounts, env: parseEnv(lines.join('')) };
  const plan = planImport(source, null, { secretsFile: '/x/secrets.json' });
  assert.deepEqual((plan.config.pairs as { id: string }[]).map(pair => pair.id), ['fast-1', 'fast-2']);
  assert.match(plan.skipped.join('\n'), /fast-3.*加入后本服务不接受.*每分钟约需请求权重.*加两成余量.*可分批导入/);
  const cross = planImport(source, null, { secretsFile: '/x/secrets.json', only: ['fast-1', 'cross'] });
  assert.match(cross.skipped.join('\n'), /cross.*加入后本服务不接受.*同一个 API 钱包/);
  assert.equal(parseServiceConfig(plan.config).pairs.length, 2);
  assert.ok(plan.added[0]!.startsWith('fast-1（快[31m速）'), plan.added[0]);
  assert.doesNotMatch([...plan.added, ...plan.skipped].join(' | '), /[\u0000-\u001f\u200e]/);
});

test('导入工作台：已有配置只追加新配对，同一钱包沿用现有账户名，重复导入不改动', () => {
  const wb = workbench();
  try {
    const source = readWorkbench(wb.envFile, wb.data);
    const existing = {
      config: { secretsFile: '/etc/trading-platform/secrets.json', port: 4800, pairs: [] as unknown[] },
      secrets: { accounts: { boss: MAIN }, feishu: { webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/mine12345' } },
    };
    const plan = planImport(source, existing, { secretsFile: '/unused' });
    assert.equal(plan.config.port, 4800);
    assert.equal((plan.config.pairs as { main: string }[])[0]!.main, 'boss');
    assert.deepEqual(Object.keys(plan.secrets.accounts as object).sort(), ['ASTER_L1', 'ASTER_S1', 'boss']);
    assert.deepEqual(plan.secrets.feishu, existing.secrets.feishu);
    assert.equal(existing.config.pairs.length, 0, '不改动传入的现有配置');

    const again = planImport(source, { config: plan.config, secrets: plan.secrets }, { secretsFile: '/unused' });
    assert.equal(again.added.length, 0);
    assert.ok(again.skipped.some(line => /^gold.*已在本项目配置中/.test(line)));
  } finally { rmSync(wb.root, { recursive: true, force: true }); }
});

test('导入工作台：命令行写出 600 的配置与密钥，输出不含私钥；试运行与无新增时不写文件', () => {
  const wb = workbench();
  const conf = join(wb.root, 'conf');
  mkdirSync(conf);
  const run = (...extra: string[]) => spawnSync(process.execPath, [join(import.meta.dirname, '../src/service/import-workbench.ts'),
    '--config', join(conf, 'config.json'), '--workbench-env', wb.envFile, ...extra], { encoding: 'utf8' });
  try {
    const dry = run('--dry-run');
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /试运行/);
    assert.throws(() => statSync(join(conf, 'config.json')));

    const first = run();
    assert.equal(first.status, 0, first.stderr);
    for (const wallet of [MAIN, LONG, SHORT]) assert.ok(!first.stdout.includes(wallet.privateKey.slice(2)), '输出不得含私钥');
    assert.ok(!first.stdout.includes(HOOK));
    assert.match(first.stdout, /导入配对 gold（黄金）/);
    for (const name of ['config.json', 'secrets.json']) assert.equal(statSync(join(conf, name)).mode & 0o777, 0o600);
    const config = JSON.parse(readFileSync(join(conf, 'config.json'), 'utf8')) as { secretsFile: string };
    assert.equal(config.secretsFile, join(conf, 'secrets.json'));

    const before = readFileSync(join(conf, 'config.json'), 'utf8');
    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /没有新的配对，配置未改动/);
    assert.equal(readFileSync(join(conf, 'config.json'), 'utf8'), before);
  } finally { rmSync(wb.root, { recursive: true, force: true }); }
});

test('导入工作台：只有旧式飞书变量时用它，模块 .env 覆盖服务器环境里的同名凭据', () => {
  const wb = workbench();
  try {
    // The module file drops the split robot and overrides the main account with a wallet that is not a sub-account.
    const module = join(wb.data, 'modules', 'aster', '.env');
    writeFileSync(module, readFileSync(module, 'utf8').replace(/FEISHU_(EVENT|SCHEDULED)_[^\n]*\n/g, '') + env('ASTER_MAIN', S2));
    const plan = planImport(readWorkbench(wb.envFile, undefined), null, { secretsFile: '/x/secrets.json' });
    assert.deepEqual(plan.secrets.feishu, { webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/legacy999' });
    assert.equal(plan.secrets.feishuScheduled, undefined, '单机器人模式下定时摘要与告警同一机器人');
    assert.equal((plan.secrets.accounts as Record<string, { user: string }>).ASTER_MAIN!.user, S2.user);
  } finally { rmSync(wb.root, { recursive: true, force: true }); }
});

test('导入工作台：坏的密钥文件报错不带原文，符号链接、目录外与缺 config 的密钥文件都拒绝改写', () => {
  const wb = workbench();
  const conf = join(wb.root, 'conf');
  mkdirSync(conf);
  const run = () => spawnSync(process.execPath, [join(import.meta.dirname, '../src/service/import-workbench.ts'),
    '--config', join(conf, 'config.json'), '--workbench-env', wb.envFile], { encoding: 'utf8' });
  const config = (secretsFile: string) => writeFileSync(join(conf, 'config.json'), JSON.stringify({ secretsFile, pairs: [] }), { mode: 0o600 });
  try {
    writeFileSync(join(conf, 'secrets.json'), '{"accounts": {"x": {"privateKey": deadbeefcafe0123456789}}}', { mode: 0o600 });
    let result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /已存在但没有 config.json/);
    config(join(conf, 'secrets.json'));
    result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /现有密钥文件不是有效的 JSON/);
    assert.ok(!result.stderr.includes('deadbeef'), result.stderr);

    rmSync(join(conf, 'secrets.json'));
    writeFileSync(join(wb.root, 'real.json'), '{"accounts": {}}', { mode: 0o600 });
    symlinkSync(join(wb.root, 'real.json'), join(conf, 'secrets.json'));
    result = run();
    assert.match(result.stderr, /是符号链接，不自动改写/);

    config(join(wb.root, 'elsewhere.json'));
    result = run();
    assert.match(result.stderr, /不在 .* 下，不自动改写/);
  } finally { rmSync(wb.root, { recursive: true, force: true }); }
});

test('页面导入通道：页面请求逐项校验；请求只认服务账户的单链接普通文件，读后删除；一次只处理一个', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-channel-'));
  const owner = { uid: process.getuid!(), gid: process.getgid!() };
  try {
    assert.throws(() => parseImportBody({ action: 'import' }), /请选择 1–20 个配对/);
    assert.throws(() => parseImportBody({ action: 'import', pairs: ['a', 'a'] }), /配对重复/);
    assert.throws(() => parseImportBody({ action: 'import', pairs: ['a b'] }), /配对 id 无效/);
    assert.throws(() => parseImportBody({ action: 'preview', pairs: ['a'] }), /预览不选配对/);
    assert.throws(() => parseImportBody({ action: 'delete' }), /导入操作无效/);
    assert.throws(() => parseImportBody({ action: 'preview', extra: 1 }));
    assert.equal(takeImportRequest(dir, owner), null);
    assert.equal(readImportResult(dir), null);

    // Someone else's file, a link (its target untouched) or a file with a second link is not taken, and is removed.
    submitImportRequest(dir, { action: 'preview' });
    assert.match((takeImportRequest(dir, { uid: owner.uid + 1 }) as { invalid: string }).invalid, /不属于服务账户/);
    assert.equal(existsSync(join(dir, REQUEST_FILE)), false);
    writeFileSync(join(dir, 'target'), '{}');
    symlinkSync(join(dir, 'target'), join(dir, REQUEST_FILE));
    assert.match((takeImportRequest(dir, owner) as { invalid: string }).invalid, /符号链接/);
    assert.equal(existsSync(join(dir, REQUEST_FILE)), false);
    assert.equal(readFileSync(join(dir, 'target'), 'utf8'), '{}');
    submitImportRequest(dir, { action: 'preview' });
    linkSync(join(dir, REQUEST_FILE), join(dir, 'second'));
    assert.match((takeImportRequest(dir, owner) as { invalid: string }).invalid, /多个硬链接/);
    writeFileSync(join(dir, REQUEST_FILE), '{"id":"x"', { mode: 0o600 });
    assert.match((takeImportRequest(dir, owner) as { invalid: string }).invalid, /不是有效 JSON/);

    // One at a time: a request not yet taken blocks the next until it is stale; a result still running blocks too.
    const { id } = submitImportRequest(dir, { action: 'import', pairs: ['gold'] });
    assert.throws(() => submitImportRequest(dir, { action: 'preview' }), /还没有被处理/);
    const old = (Date.now() - 200_000) / 1000;
    utimesSync(join(dir, REQUEST_FILE), old, old);
    const replaced = submitImportRequest(dir, { action: 'preview' });
    assert.notEqual(replaced.id, id);
    const taken = takeImportRequest(dir, owner) as { id: string; action: string };
    assert.deepEqual([taken.id, taken.action], [replaced.id, 'preview']);
    assert.equal(existsSync(join(dir, REQUEST_FILE)), false);
    writeImportResult(dir, { id: replaced.id, action: 'preview', at: Date.now(), phase: 'running', message: '正在读取工作台' }, owner);
    assert.equal(statSync(join(dir, RESULT_FILE)).mode & 0o777, 0o600);
    assert.throws(() => submitImportRequest(dir, { action: 'preview' }), /正在处理/);
    writeImportResult(dir, { id: replaced.id, action: 'preview', at: Date.now() - RUNNING_STALE_MS - 1000, phase: 'running', message: '' }, owner);
    submitImportRequest(dir, { action: 'preview' });
    assert.deepEqual(readdirSync(dir).filter(name => name.endsWith('.tmp')), [], '不留临时文件');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('页面导入：预览逐个列出工作台配对能否导入；导入写好文件并重启服务，启动失败时原样恢复并再次重启', async () => {
  const wb = workbench();
  const conf = join(wb.root, 'conf'), dir = join(wb.root, 'import'), data = join(wb.root, 'svc');
  for (const path of [conf, dir, data]) mkdirSync(path);
  const configFile = join(conf, 'config.json'), secretsFile = join(conf, 'secrets.json');
  // The empty config install.sh writes on a first setup.
  writeFileSync(secretsFile, fileText({ accounts: {} }), { mode: 0o600 });
  writeFileSync(configFile, fileText({ secretsFile, pairs: [] }), { mode: 0o600 });
  let healthy = true;
  const restarts: string[] = [];
  const options = {
    dir, configFile, dataDir: data, workbenchEnv: wb.envFile, log: () => undefined,
    // The first restart after an import comes back as `healthy` says; the one after putting the files back always runs.
    restart: async () => { restarts.push(readFileSync(configFile, 'utf8')); return restarts.length > 1 || healthy; },
  };
  const noKeys = (text: string) => { for (const wallet of [MAIN, LONG, SHORT]) assert.ok(!text.includes(wallet.privateKey.slice(2)), '结果不得含私钥'); assert.ok(!text.includes(HOOK)); };
  try {
    const preview = submitImportRequest(dir, { action: 'preview' });
    assert.equal(await runImportHelper(options), 1);
    const shown = readImportResult(dir)!;
    assert.deepEqual([shown.id, shown.phase], [preview.id, 'done']);
    assert.deepEqual(shown.preview!.map(item => [item.id, item.name, item.marginEnabled, item.importable]), [['gold', '黄金', true, true], ['idle', '未开启', false, false], ['paper', '模拟', true, false]]);
    assert.match(shown.preview![1]!.detail, /页面只导入已开启的配对/);
    assert.match(shown.preview![2]!.detail, /不是实盘模式/);
    noKeys(readFileSync(join(dir, RESULT_FILE), 'utf8'));
    assert.deepEqual(restarts, [], '预览不重启');

    const before = { config: readFileSync(configFile, 'utf8'), secrets: readFileSync(secretsFile, 'utf8') };
    healthy = false;
    const failing = submitImportRequest(dir, { action: 'import', pairs: ['gold'] });
    await runImportHelper(options);
    const undone = readImportResult(dir)!;
    assert.deepEqual([undone.id, undone.phase], [failing.id, 'failed']);
    assert.match(undone.message, /已恢复导入前的配置并确认服务运行正常/);
    assert.equal(restarts.length, 2);
    assert.match(restarts[0]!, /"id": "gold"/, '第一次重启时配置里已有导入的配对');
    assert.deepEqual({ config: readFileSync(configFile, 'utf8'), secrets: readFileSync(secretsFile, 'utf8') }, before, '原样恢复');

    // Pairs the workbench does not have fail before anything is written.
    submitImportRequest(dir, { action: 'import', pairs: ['nope'] });
    await runImportHelper(options);
    assert.match(readImportResult(dir)!.message, /工作台里没有配对 nope/);
    assert.equal(restarts.length, 2);

    // A pair the workbench does not balance is not imported from the page, so the service never gets its keys.
    submitImportRequest(dir, { action: 'import', pairs: ['idle'] });
    await runImportHelper(options);
    assert.match(readImportResult(dir)!.message, /所选配对都不能导入，配置未改动/);
    assert.match(readImportResult(dir)!.imported![0]!.detail, /页面只导入已开启的配对/);

    // A request that waited past its life (install.sh held the lock) is answered, not run.
    const stale = submitImportRequest(dir, { action: 'import', pairs: ['gold'] }, () => Date.now() - 130_000);
    await runImportHelper(options);
    assert.deepEqual([readImportResult(dir)!.id, readImportResult(dir)!.phase], [stale.id, 'failed']);
    assert.match(readImportResult(dir)!.message, /已作废未执行/);
    assert.equal(restarts.length, 2);

    // A config the service would not start on (here: a check that fails) is put back without a restart.
    submitImportRequest(dir, { action: 'import', pairs: ['gold'] });
    await runImportHelper({ ...options, checkConfig: () => { throw new Error('测试：检查失败'); } });
    assert.match(readImportResult(dir)!.message, /未通过服务检查（测试：检查失败），已恢复导入前的配置/);
    assert.deepEqual({ config: readFileSync(configFile, 'utf8'), secrets: readFileSync(secretsFile, 'utf8') }, before);
    assert.equal(restarts.length, 2);

    // An import the helper was stopped in the middle of (its undo record still there) is settled on the next start.
    const undo = join(conf, '.import-undo.json');
    const half = fileText({ secretsFile, pairs: [{ id: 'half-written' }] });
    const boot = (() => { try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return null; } })();
    const sha = (text: string) => createHash('sha256').update(text).digest('hex');
    const leave = (record: object) => writeFileSync(undo, JSON.stringify({ requestId: 'r-old', bootId: boot, at: Date.now(), configFile, secretsFile, text: before, written: { config: sha(half), secrets: sha(before.secrets) }, ...record }), { mode: 0o600 });
    const files = () => ({ config: readFileSync(configFile, 'utf8'), secrets: readFileSync(secretsFile, 'utf8') });
    writeFileSync(join(conf, 'secrets.json.import.99999'), 'left by a stopped import');
    // Same boot, files as the import wrote them: put back, the service restarted, answered under the old request's id.
    leave({}); writeFileSync(configFile, half);
    restarts.length = 0; healthy = true;
    assert.equal(await runImportHelper(options), 0);
    assert.deepEqual(files(), before);
    assert.equal(existsSync(undo), false);
    assert.equal(existsSync(join(conf, 'secrets.json.import.99999')), false, '残留的临时文件被清理');
    assert.equal(restarts.length, 1);
    assert.deepEqual([readImportResult(dir)!.id, readImportResult(dir)!.phase], ['r-old', 'failed']);
    assert.match(readImportResult(dir)!.message, /上一次页面导入被中断，已恢复导入前的配置并重启了服务/);
    // Files changed since the import (install.sh, by hand): kept, and the record dropped.
    const edited = fileText({ secretsFile, pairs: [{ id: 'edited-later' }] });
    leave({}); writeFileSync(configFile, edited);
    await runImportHelper(options);
    assert.equal(readFileSync(configFile, 'utf8'), edited);
    assert.equal(existsSync(undo), false);
    assert.equal(restarts.length, 1);
    assert.match(readImportResult(dir)!.message, /配置之后已被改动，保留现有配置/);
    // After a reboot, or long after the helper's run, a complete import the service accepts is kept: it may have run on it.
    for (const record of [{ bootId: 'another-boot' }, { at: Date.now() - 20 * 60_000 }]) {
      leave(record); writeFileSync(configFile, half);
      await runImportHelper({ ...options, checkConfig: () => 'ok' });
      assert.equal(readFileSync(configFile, 'utf8'), half);
      assert.equal(existsSync(undo), false);
      assert.deepEqual([readImportResult(dir)!.phase, restarts.length], ['done', 1]);
      assert.match(readImportResult(dir)!.message, /配置检查通过、可能已在使用，已保留导入结果/);
    }
    // A half-written one (only one file as imported) goes back even then.
    leave({ bootId: 'another-boot', written: { config: sha(half), secrets: sha('other keys') } }); writeFileSync(configFile, half);
    await runImportHelper({ ...options, checkConfig: () => 'ok' });
    assert.deepEqual(files(), before);
    assert.equal(restarts.length, 2);
    restarts.length = 1; writeFileSync(configFile, half);
    // A record that cannot be trusted is moved aside, not acted on.
    writeFileSync(undo, JSON.stringify({ configFile, secretsFile: '/etc/passwd', text: before }));
    await runImportHelper(options);
    assert.equal(readFileSync(configFile, 'utf8'), half);
    assert.ok(existsSync(`${undo}.invalid`));
    assert.match(readImportResult(dir)!.message, /撤销记录无效/);
    rmSync(`${undo}.invalid`);
    writeFileSync(configFile, before.config);
    assert.equal(restarts.length, 1);

    // A result that cannot be written does not stop the import half-way: it still restarts and settles.
    restarts.length = 0; healthy = true;
    submitImportRequest(dir, { action: 'import', pairs: ['gold'] });
    rmSync(join(dir, RESULT_FILE)); mkdirSync(join(dir, RESULT_FILE));
    await runImportHelper(options);
    assert.equal(restarts.length, 1);
    assert.match(readFileSync(configFile, 'utf8'), /"id": "gold"/);
    assert.equal(existsSync(undo), false);
    rmSync(join(dir, RESULT_FILE), { recursive: true });
    writeFileSync(configFile, before.config); writeFileSync(secretsFile, before.secrets);

    restarts.length = 0; healthy = true;
    const done = submitImportRequest(dir, { action: 'import', pairs: ['gold', 'paper'] });
    await runImportHelper(options);
    const result = readImportResult(dir)!;
    assert.deepEqual([result.id, result.phase], [done.id, 'done']);
    assert.deepEqual(result.imported!.map(item => [item.id, item.status]), [['gold', 'added'], ['paper', 'skipped']]);
    assert.equal(restarts.length, 1);
    noKeys(readFileSync(join(dir, RESULT_FILE), 'utf8'));
    const config = JSON.parse(readFileSync(configFile, 'utf8')) as { pairs: { id: string }[] };
    assert.deepEqual(config.pairs.map(pair => pair.id), ['gold']);
    for (const file of [configFile, secretsFile]) assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(existsSync(undo), false, '导入落定后不留撤销文件');

    // ExecStopPost after a cut-short run with nothing to put back: the page is told instead of waiting out its limit.
    writeImportResult(dir, { id: done.id, action: 'import', at: Date.now(), phase: 'running', message: '正在读取工作台' }, { uid: process.getuid!(), gid: process.getgid!() });
    const recover = spawnSync(process.execPath, [join(import.meta.dirname, '../src/service/import-helper.ts'), '--recover', '--dir', dir, '--config', configFile, '--data-dir', data], { encoding: 'utf8' });
    assert.equal(recover.status, 0, recover.stderr);
    assert.deepEqual([readImportResult(dir)!.id, readImportResult(dir)!.phase], [done.id, 'failed']);
    assert.match(readImportResult(dir)!.message, /处理超时被中断，配置未改动/);
    assert.match(readFileSync(configFile, 'utf8'), /"id": "gold"/, '没有撤销记录时不动配置');

  } finally { rmSync(wb.root, { recursive: true, force: true }); }
});

test('页面会话：数据目录里保留一份，重启沿用；格式不对时换新', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-session-'));
  try {
    const first = keptSession(dir);
    assert.match(first, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(statSync(join(dir, 'http-session')).mode & 0o777, 0o600);
    assert.equal(keptSession(dir), first);
    writeFileSync(join(dir, 'http-session'), 'short\n');
    const second = keptSession(dir);
    assert.notEqual(second, first);
    // Replaced once older than the cookie's 30 days.
    assert.equal(keptSession(dir, Date.now() + 29 * 86_400_000), second);
    assert.notEqual(keptSession(dir, Date.now() + 31 * 86_400_000), second);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
