// Importing the workbench's ASTER pairs: settings carried over field by field, pairs that cannot run here skipped with
// the reason, an existing config only extended, and the files written private without a key in the output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { planImport, readWorkbench } from '../src/service/import-workbench.ts';
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
  writeFileSync(join(module, '.env'), `${env('ASTER_L1', LONG)}${env('ASTER_S1', SHORT)}${env('ASTER_L2', LONG)}FEISHU_EVENT_WEBHOOK_URL=${HOOK}\nFEISHU_EVENT_SIGN_SECRET=sig\n`);
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
    writeFileSync(module, readFileSync(module, 'utf8').replace(/FEISHU_EVENT_[^\n]*\n/g, '') + env('ASTER_MAIN', S2));
    const plan = planImport(readWorkbench(wb.envFile, undefined), null, { secretsFile: '/x/secrets.json' });
    assert.deepEqual(plan.secrets.feishu, { webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/legacy999' });
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
    assert.match(result.stderr, /有 secrets|已存在但没有 config.json/);
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
