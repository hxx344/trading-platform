// Importing the workbench's Binance/Bybit execution accounts for the oil module: hub.sqlite decrypted with
// credentials.key, every account the service could not trade on refused with its reason, a live oil rule of the workbench
// blocking its venue, an existing oil config kept, and no key, ciphertext or field content in any message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OIL_DEFAULT_LIMITS, decryptCredential, fileText, planImport, readWorkbench, readWorkbenchOil } from '../src/service/import-workbench.ts';
import { parseImportBody, parseImportRequest, readImportResult, submitImportRequest } from '../src/service/import-channel.ts';
import { runImportHelper } from '../src/service/import-helper.ts';
import { parseServiceConfig, parseServiceSecrets } from '../src/service/config.ts';

const API_KEY = 'K'.repeat(40) + 'apikeyBINANCE';
const API_SECRET = 'S'.repeat(40) + 'secretBINANCE';
const BYBIT_KEY = 'B'.repeat(18) + 'bybitkey';
const BYBIT_SECRET = 'Y'.repeat(30) + 'bybitsecret';

const encrypt = (key: Buffer, value: unknown): string => {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
};

interface Row { exchange: string; revision?: number; credentials?: unknown; mode?: string; identity?: string | null; foreignKey?: boolean }
interface Rule { enabled?: boolean; market?: string; exchange?: string; name?: string; mode?: string; raw?: string }

/** A workbench data directory with hub.sqlite and credentials.key, the way the workbench writes them. */
function hub(rows: Row[], rules: Rule[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'tp-oil-import-'));
  const data = join(root, 'data');
  mkdirSync(data);
  const key = randomBytes(32), other = randomBytes(32);
  writeFileSync(join(data, 'credentials.key'), key, { mode: 0o600 });
  const db = new DatabaseSync(join(data, 'hub.sqlite'));
  db.exec(`CREATE TABLE execution_accounts (exchange TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, credentials TEXT, account_mode TEXT NOT NULL,
    identity TEXT, key_label TEXT, verified_at TEXT, snapshot TEXT);
    CREATE TABLE execution_auto_rules (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, enabled INTEGER NOT NULL, created_at TEXT NOT NULL, config TEXT NOT NULL, state TEXT NOT NULL);`);
  for (const row of rows) {
    const credentials = row.credentials === undefined ? encrypt(row.foreignKey ? other : key, { purpose: 'execution', exchange: row.exchange, apiKey: row.exchange === 'bybit' ? BYBIT_KEY : API_KEY, apiSecret: row.exchange === 'bybit' ? BYBIT_SECRET : API_SECRET })
      : typeof row.credentials === 'string' || row.credentials === null ? row.credentials : encrypt(key, row.credentials);
    db.prepare('INSERT INTO execution_accounts (exchange, revision, credentials, account_mode, identity) VALUES (?, ?, ?, ?, ?)')
      .run(row.exchange, row.revision ?? 3, credentials as string | null, row.mode ?? (row.exchange === 'bybit' ? 'unified' : 'standard'), row.identity === undefined ? (row.exchange === 'bybit' ? '55667788' : '123456789') : row.identity);
  }
  rules.forEach((rule, index) => {
    const config = rule.raw ?? JSON.stringify({ name: rule.name ?? '', market: rule.market ?? 'oil', exchange: rule.exchange ?? 'binance' });
    db.prepare('INSERT INTO execution_auto_rules VALUES (?, 0, ?, ?, ?, ?)').run(`r${index}`, rule.enabled === false ? 0 : 1, `2026-11-0${index + 1}T00:00:00Z`, config, JSON.stringify({ mode: rule.mode ?? 'live' }));
  });
  db.close();
  return { root, data };
}

const noSecrets = (text: string): void => {
  for (const secret of [API_KEY, API_SECRET, BYBIT_KEY, BYBIT_SECRET]) assert.ok(!text.includes(secret.slice(-12)), '不得含密钥');
};

test('原油导入：解密执行账户写成 oil 配置与 binance/bybit 密钥，首次写入默认名义上限，只输出打码账户', () => {
  const wb = hub([{ exchange: 'binance' }, { exchange: 'bybit', revision: 7 }, { exchange: 'okx' }]);
  try {
    const oil = readWorkbenchOil(wb.data);
    assert.deepEqual(oil.accounts.map(item => [item.venue, item.accountMode, item.accountId, item.credentialVersion, item.problem]), [['binance', 'standard', '123456789', 3, null], ['bybit', 'unified', '55667788', 7, null]], 'OKX 不是本服务的交易所');
    const plan = planImport({ pairs: [], accounts: [], env: {} }, null, { secretsFile: '/etc/trading-platform/secrets.json', only: [], oil });
    assert.deepEqual(plan.config.oil, { notionalLimits: OIL_DEFAULT_LIMITS, accounts: [
      { venue: 'binance', accountId: '123456789', accountMode: 'standard', credentialVersion: 3 },
      { venue: 'bybit', accountId: '55667788', accountMode: 'unified', credentialVersion: 7 },
    ] });
    assert.deepEqual(plan.secrets.binance, { apiKey: API_KEY, apiSecret: API_SECRET });
    assert.deepEqual(plan.secrets.bybit, { apiKey: BYBIT_KEY, apiSecret: BYBIT_SECRET });
    // The files load as the service would read them.
    const config = parseServiceConfig(plan.config);
    assert.equal(parseServiceSecrets(plan.secrets, [], config.oil!.accounts.map(account => account.venue)).exchanges!.size, 2);
    assert.deepEqual(plan.oil.map(item => [item.venue, item.status, item.accountId]), [['binance', 'added', '***6789'], ['bybit', 'added', '***7788']]);
    assert.ok(plan.notes.some(note => /单笔 200 USDT、24 小时开仓 1000 USDT/.test(note)));
    noSecrets(JSON.stringify({ items: plan.oil, notes: plan.notes }));
  } finally { rmSync(wb.root, { recursive: true, force: true }); }
});

test('原油导入：用途、账户模式、缺身份、未连接、密钥不匹配、版本无效都拒绝并说明原因，报错不带密文与字段内容', () => {
  const cases: [Row, RegExp][] = [
    [{ exchange: 'binance', credentials: { purpose: 'read', exchange: 'binance', apiKey: API_KEY, apiSecret: API_SECRET } }, /purpose 须为 execution/],
    [{ exchange: 'binance', mode: 'cross-margin' }, /账户模式 cross-margin 不支持/],
    [{ exchange: 'bybit', mode: 'standard' }, /账户模式 standard 不支持/],
    [{ exchange: 'binance', identity: null }, /重新验证/],
    [{ exchange: 'binance', identity: 'bad id!' }, /重新验证/],
    [{ exchange: 'binance', credentials: null }, /未连接/],
    [{ exchange: 'binance', foreignKey: true }, /无法解密/],
    [{ exchange: 'binance', credentials: 'not-base64-but-anything' }, /无法解密/],
    [{ exchange: 'binance', revision: 0 }, /凭据版本无效/],
    [{ exchange: 'binance', credentials: { purpose: 'execution', exchange: 'bybit', apiKey: API_KEY, apiSecret: API_SECRET } }, /交易所与记录不一致/],
    [{ exchange: 'binance', credentials: { purpose: 'execution', exchange: 'binance', apiKey: 'has space', apiSecret: API_SECRET } }, /不完整或格式无效/],
  ];
  for (const [row, reason] of cases) {
    const one = hub([row]);
    try {
      const oil = readWorkbenchOil(one.data);
      const plan = planImport({ pairs: [], accounts: [], env: {} }, null, { secretsFile: '/x/secrets.json', only: [], oil });
      assert.equal(plan.oil.length, 1);
      assert.equal(plan.oil[0]!.status, 'skipped', JSON.stringify(row));
      assert.match(plan.oil[0]!.detail, reason);
      assert.equal(plan.config.oil, undefined);
      assert.equal(plan.secrets.binance, undefined);
      noSecrets(JSON.stringify(plan.oil));
    } finally { rmSync(one.root, { recursive: true, force: true }); }
  }
  // A blob that does not decrypt is one fixed error whatever it holds.
  assert.throws(() => decryptCredential(randomBytes(32), Buffer.from(`${API_KEY}${API_SECRET}`).toString('base64')), (error: Error) => error.message === 'decrypt_failed');
});

test('原油导入：实盘启用的原油自动规则拒绝导入该交易所账户；观察模式、已停用、其他品种与其他交易所的规则不拦，无法解析的规则全部拦', () => {
  const plan = (rules: Rule[]) => {
    const wb = hub([{ exchange: 'binance' }, { exchange: 'bybit' }], rules);
    try { return planImport({ pairs: [], accounts: [], env: {} }, null, { secretsFile: '/x/secrets.json', only: [], oil: readWorkbenchOil(wb.data) }); }
    finally { rmSync(wb.root, { recursive: true, force: true }); }
  };
  const blocked = plan([{ exchange: 'binance', name: '币安原油价差' }]);
  assert.deepEqual(blocked.oil.map(item => [item.venue, item.status]), [['binance', 'skipped'], ['bybit', 'added']]);
  assert.match(blocked.oil[0]!.detail, /先在工作台停用原油自动规则（币安原油价差）/);
  assert.deepEqual(blocked.oil[0]!.blockedBy, ['币安原油价差']);
  assert.deepEqual((blocked.config.oil as { accounts: { venue: string }[] }).accounts.map(account => account.venue), ['bybit']);

  const quiet = plan([{ exchange: 'binance', mode: 'observe' }, { exchange: 'binance', enabled: false }, { exchange: 'binance', market: 'hynix' }, { exchange: 'okx' }]);
  assert.deepEqual(quiet.oil.map(item => item.status), ['added', 'added']);

  const unknown = plan([{ raw: '{not json' }]);
  assert.deepEqual(unknown.oil.map(item => item.status), ['skipped', 'skipped']);
  assert.match(unknown.oil[0]!.detail, /1 条自动规则无法解析.*先在工作台停用原油自动规则/);
});

test('原油导入：已有 oil 配置的交易所保留现有设置与上限，只补新交易所；未登记账户的同名密钥不覆盖', () => {
  const wb = hub([{ exchange: 'binance' }, { exchange: 'bybit' }]);
  try {
    const oil = readWorkbenchOil(wb.data);
    const existing = {
      config: { secretsFile: '/x/secrets.json', pairs: [], oil: { notionalLimits: { perJob: '50', openPer24h: '300' }, accounts: [{ venue: 'binance', accountId: '99990000', accountMode: 'portfolio-margin', credentialVersion: 1 }] } },
      secrets: { accounts: {}, binance: { apiKey: 'old-key-0001', apiSecret: 'old-secret-0001' } },
    };
    const plan = planImport({ pairs: [], accounts: [], env: {} }, existing, { secretsFile: '/x/secrets.json', only: [], oil });
    assert.deepEqual(plan.oil.map(item => [item.venue, item.status]), [['binance', 'skipped'], ['bybit', 'added']]);
    assert.match(plan.oil[0]!.detail, /已在本项目配置中，保留现有设置/);
    const written = plan.config.oil as { notionalLimits: unknown; accounts: { venue: string; accountId: string }[] };
    assert.deepEqual(written.notionalLimits, { perJob: '50', openPer24h: '300' }, '上限不改');
    assert.deepEqual(written.accounts.map(account => [account.venue, account.accountId]), [['binance', '99990000'], ['bybit', '55667788']]);
    assert.deepEqual(plan.secrets.binance, { apiKey: 'old-key-0001', apiSecret: 'old-secret-0001' });
    assert.ok(!plan.notes.some(note => /默认值/.test(note)), '已有 oil 时不提默认上限');

    // A bybit key already in the file without its account: left alone, the account not added.
    const stray = planImport({ pairs: [], accounts: [], env: {} }, { config: existing.config, secrets: { ...existing.secrets, bybit: { apiKey: 'stray-key-1', apiSecret: 'stray-secret-1' } } }, { secretsFile: '/x/secrets.json', only: [], oil });
    assert.match(stray.oil[1]!.detail, /已有 bybit 的密钥但 config.json 没有对应账户，不覆盖/);
    assert.deepEqual(stray.secrets.bybit, { apiKey: 'stray-key-1', apiSecret: 'stray-secret-1' });
  } finally { rmSync(wb.root, { recursive: true, force: true }); }
});

test('原油导入：未完成的回滚日志、工作台未运行时的未合并 WAL、符号链接与长度不对的密钥都拒绝读取', () => {
  const wb = hub([{ exchange: 'binance' }]);
  const hubFile = join(wb.data, 'hub.sqlite');
  try {
    writeFileSync(`${hubFile}-journal`, 'x');
    assert.throws(() => readWorkbenchOil(wb.data), /未完成的回滚日志/);
    rmSync(`${hubFile}-journal`);
    writeFileSync(`${hubFile}-wal`, 'x');
    assert.throws(() => readWorkbenchOil(wb.data), /未合并的 WAL 而工作台未在运行/);
    rmSync(`${hubFile}-wal`);
    assert.equal(readWorkbenchOil(wb.data).accounts.length, 1, '清掉后可读');
    assert.throws(() => statSync(`${hubFile}-wal`), '不可变只读不生成 -wal');
    assert.throws(() => statSync(`${hubFile}-shm`), '不可变只读不生成 -shm');

    const keyFile = join(wb.data, 'credentials.key');
    const key = readFileSync(keyFile);
    writeFileSync(keyFile, key.subarray(0, 16));
    assert.throws(() => readWorkbenchOil(wb.data), /长度不是 32 字节/);
    rmSync(keyFile);
    writeFileSync(join(wb.root, 'elsewhere.key'), key);
    symlinkSync(join(wb.root, 'elsewhere.key'), keyFile);
    assert.throws(() => readWorkbenchOil(wb.data), /不是普通文件/);
    assert.throws(() => readWorkbenchOil('relative/data'), /绝对路径/);

    // The workbench running (its connection open in WAL mode): a row not yet checkpointed is read through its -shm.
    rmSync(keyFile); writeFileSync(keyFile, key, { mode: 0o600 });
    const writer = new DatabaseSync(hubFile);
    try {
      writer.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0');
      writer.prepare("INSERT INTO execution_accounts (exchange, revision, credentials, account_mode, identity) VALUES ('bybit', 1, NULL, 'unified', '1')").run();
      assert.ok(statSync(`${hubFile}-wal`).size > 0);
      assert.deepEqual(readWorkbenchOil(wb.data).accounts.map(item => [item.venue, item.problem]), [['binance', null], ['bybit', '工作台未连接该执行账户']]);
    } finally { writer.close(); }
  } finally { rmSync(wb.root, { recursive: true, force: true }); }
});

test('原油导入：命令行 --oil 只导入原油执行账户（没有 ASTER 模块也可以），输出不含密钥，重复导入不改动', () => {
  const wb = hub([{ exchange: 'binance' }]);
  const conf = join(wb.root, 'conf');
  mkdirSync(conf);
  writeFileSync(join(wb.root, 'workbench.env'), `DATA_DIR=${wb.data}\n`);
  const run = (...extra: string[]) => spawnSync(process.execPath, [join(import.meta.dirname, '../src/service/import-workbench.ts'),
    '--config', join(conf, 'config.json'), '--workbench-env', join(wb.root, 'workbench.env'), ...extra], { encoding: 'utf8' });
  try {
    // Without --oil the ASTER database is still required.
    assert.match(run().stderr, /没有找到工作台的 ASTER 数据库/);
    const first = run('--oil');
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /导入原油执行账户 Binance standard 账户 \*\*\*6789，凭据版本 3/);
    assert.match(first.stdout, /首次写入原油配置/);
    noSecrets(first.stdout + first.stderr);
    for (const name of ['config.json', 'secrets.json']) assert.equal(statSync(join(conf, name)).mode & 0o777, 0o600);
    const config = JSON.parse(readFileSync(join(conf, 'config.json'), 'utf8')) as Record<string, unknown>;
    assert.deepEqual(config.pairs, []);
    assert.equal(parseServiceConfig(config).oil!.accounts[0]!.accountId, '123456789');

    const before = readFileSync(join(conf, 'config.json'), 'utf8');
    const again = run('--oil');
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /已在本项目配置中，保留现有设置/);
    assert.match(again.stdout, /没有新的原油执行账户，配置未改动/);
    assert.equal(readFileSync(join(conf, 'config.json'), 'utf8'), before);
  } finally { rmSync(wb.root, { recursive: true, force: true }); }
});

test('页面导入原油：请求体校验；预览列出原油账户与规则拦截；勾选后单独导入并重启，结果不含密钥', async () => {
  assert.deepEqual(parseImportBody({ action: 'import', oil: true }), { action: 'import', pairs: [], oil: true });
  assert.deepEqual(parseImportBody({ action: 'import', pairs: ['gold'], oil: true }), { action: 'import', pairs: ['gold'], oil: true });
  assert.throws(() => parseImportBody({ action: 'import', pairs: [] }), /或勾选导入原油执行账户/);
  assert.throws(() => parseImportBody({ action: 'import', oil: false }), /oil 只能是 true/);
  assert.throws(() => parseImportBody({ action: 'preview', oil: true }), /预览不选配对/);
  assert.equal(parseImportRequest({ id: '00000000-0000-4000-8000-000000000000', action: 'import', at: 1, oil: true }).oil, true);

  const wb = hub([{ exchange: 'binance' }, { exchange: 'bybit' }], [{ exchange: 'bybit', name: 'Bybit 做多' }]);
  const conf = join(wb.root, 'conf'), dir = join(wb.root, 'import'), data = join(wb.root, 'svc');
  for (const path of [conf, dir, data]) mkdirSync(path);
  writeFileSync(join(wb.root, 'workbench.env'), `DATA_DIR=${wb.data}\n`);
  const configFile = join(conf, 'config.json'), secretsFile = join(conf, 'secrets.json');
  writeFileSync(secretsFile, fileText({ accounts: {} }), { mode: 0o600 });
  writeFileSync(configFile, fileText({ secretsFile, pairs: [] }), { mode: 0o600 });
  const restarts: string[] = [];
  const options = { dir, configFile, dataDir: data, workbenchEnv: join(wb.root, 'workbench.env'), log: () => undefined, checkConfig: () => 'ok',
    restart: async () => { restarts.push(readFileSync(configFile, 'utf8')); return true; } };
  try {
    submitImportRequest(dir, { action: 'preview' });
    await runImportHelper(options);
    const shown = readImportResult(dir)!;
    assert.equal(shown.phase, 'done', shown.message);
    assert.match(shown.message, /原油执行账户 2 个，其中 1 个可以导入/);
    assert.deepEqual(shown.oil!.map(item => [item.venue, item.accountMode, item.accountId, item.status, item.blockedBy]), [['binance', 'standard', '***6789', 'added', []], ['bybit', 'unified', '***7788', 'skipped', ['Bybit 做多']]]);
    assert.deepEqual(shown.preview, []);
    noSecrets(readFileSync(join(dir, 'result.json'), 'utf8'));
    assert.equal(readFileSync(configFile, 'utf8'), fileText({ secretsFile, pairs: [] }), '预览不写文件');

    submitImportRequest(dir, { action: 'import', oil: true });
    await runImportHelper(options);
    const done = readImportResult(dir)!;
    assert.equal(done.phase, 'done', done.message);
    assert.match(done.message, /已导入 原油执行账户（Binance），服务已重启/);
    assert.equal(restarts.length, 1);
    const config = JSON.parse(readFileSync(configFile, 'utf8')) as { oil: { accounts: { venue: string }[] } };
    assert.deepEqual(config.oil.accounts.map(account => account.venue), ['binance']);
    assert.ok(readFileSync(secretsFile, 'utf8').includes(API_KEY));
    noSecrets(readFileSync(join(dir, 'result.json'), 'utf8'));

    // Nothing left to bring: refused without a restart.
    submitImportRequest(dir, { action: 'import', oil: true });
    await runImportHelper(options);
    assert.match(readImportResult(dir)!.message, /原油执行账户不能导入，配置未改动/);
    assert.equal(restarts.length, 1);
  } finally { rmSync(wb.root, { recursive: true, force: true }); }
});

test('页面导入原油：工作台没有 hub.sqlite 时预览仍列出配对，原油部分说明原因', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tp-oil-none-'));
  try {
    mkdirSync(join(root, 'data', 'modules', 'aster'), { recursive: true });
    const db = new DatabaseSync(join(root, 'data', 'modules', 'aster', 'trading.sqlite3'));
    db.exec('CREATE TABLE accounts (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE pairs (id TEXT PRIMARY KEY, data TEXT NOT NULL);');
    db.close();
    writeFileSync(join(root, 'workbench.env'), `DATA_DIR=${join(root, 'data')}\n`);
    assert.equal(readWorkbench(join(root, 'workbench.env'), undefined).data, join(root, 'data'));
    const dir = join(root, 'import'), conf = join(root, 'conf'), data = join(root, 'svc');
    for (const path of [dir, conf, data]) mkdirSync(path);
    submitImportRequest(dir, { action: 'preview' });
    await runImportHelper({ dir, configFile: join(conf, 'config.json'), dataDir: data, workbenchEnv: join(root, 'workbench.env'), log: () => undefined, restart: async () => true });
    const shown = readImportResult(dir)!;
    assert.equal(shown.phase, 'done');
    assert.equal(shown.oil, undefined);
    assert.match(shown.oilError!, /没有找到工作台的数据库 .*hub\.sqlite/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
