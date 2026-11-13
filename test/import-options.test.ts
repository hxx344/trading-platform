// The options part of the workbench import (src/service/import-options.ts): the workbench Greeks module's refusals,
// the account UID read, the plan, the CLI-free planImport path, the page request body and the import helper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { optionsCandidate, planOptions, readWorkbenchOptions, resolveOptionsAccount, runningGreeksProblem, workbenchStateProblem, type OptionsSource } from '../src/service/import-options.ts';
import { fileText, planImport } from '../src/service/import-workbench.ts';
import { parseImportBody, parseImportRequest, readImportResult, submitImportRequest } from '../src/service/import-channel.ts';
import { runImportHelper } from '../src/service/import-helper.ts';
import { FakeOptions, UID } from './options-fake.ts';

const KEY = 'G'.repeat(18) + 'greekskey';
const SECRET = 'R'.repeat(30) + 'greekssecret';
const LIVE = { BYBIT_API_KEY: KEY, BYBIT_API_SECRET: SECRET, TRADING_MODE: 'live', AUTO_OPEN: 'false' };
const state = (extra: Record<string, unknown> = {}): string => JSON.stringify({
  schema_version: 1, exchange_network: 'mainnet', active_strategy_symbols: [], active_strategy_sizes: {},
  order_journal: {}, rfq_state: {}, execution_groups: {}, execution_group_links: {}, ...extra,
});
const noSecrets = (text: string): void => {
  assert.ok(!text.includes(KEY) && !text.includes(SECRET), 'the key must not appear');
};
const ready = (source: OptionsSource): OptionsSource => ({ ...source, accountId: UID });

test('optionsCandidate takes a live mainnet workbench with nothing open, with its settings', () => {
  const source = optionsCandidate({ ...LIVE, max_risk_usd: '1200', MAX_MARGIN_USD: '3000', LEG_QTY: '0.05', STRATEGY_MODE: 'short_strangle', BBO_ORDER_TIMEOUT_SECONDS: '120' }, state());
  assert.equal(source.problem, null);
  assert.deepEqual(source.credentials, { apiKey: KEY, apiSecret: SECRET });
  assert.deepEqual(source.settings, { limits: { maxRiskUsd: 1200, maxMarginUsd: 3000 }, legQty: '0.05', strategyMode: 'short_strangle', orderTimeoutSeconds: 120 });
  // The workbench's own defaults for the limits; the older live switches reach live mainnet too.
  const defaults = optionsCandidate({ BYBIT_API_KEY: KEY, BYBIT_API_SECRET: SECRET, LIVE_TRADING: 'true', BYBIT_TESTNET: 'false', AUTO_OPEN: '0' }, state());
  assert.equal(defaults.problem, null);
  assert.deepEqual(defaults.settings, { limits: { maxRiskUsd: 2500, maxMarginUsd: 2500 } });
});

test('optionsCandidate refuses while the workbench could still trade options on the key', () => {
  const cases: [Record<string, string>, string | null, RegExp][] = [
    [{ ...LIVE, BYBIT_API_KEY: '', BYBIT_API_SECRET: '' }, state(), /没有配置 Bybit 密钥/],
    [{ ...LIVE, BYBIT_API_SECRET: '' }, state(), /不完整或格式无效/],
    [{ ...LIVE, AUTO_OPEN: 'true' }, state(), /自动开仓/],
    [{ ...LIVE, AUTO_OPEN: 'weekly' }, state(), /自动开仓/],
    [{ ...LIVE, TRADING_MODE: 'testnet' }, state(), /不是实盘主网（当前 测试网）/],
    [{ ...LIVE, TRADING_MODE: '' }, state(), /当前 模拟/],
    [{ BYBIT_API_KEY: KEY, BYBIT_API_SECRET: SECRET, AUTO_OPEN: 'off', LIVE_TRADING: 'true' }, state(), /当前 模拟/],
    [{ ...LIVE, TRADING_MODE: 'paper' }, state(), /TRADING_MODE 无法识别/],
    [{ ...LIVE, LIVE_TRADING: 'maybe', TRADING_MODE: '' }, state(), /LIVE_TRADING 不是可识别的开关值/],
    [{ ...LIVE, MAX_RISK_USD: 'lots' }, state(), /MAX_RISK_USD 不是数字/],
    [{ ...LIVE, MAX_RISK_USD: '-5' }, state(), /本服务不接受/],
    [LIVE, null, /没有找到工作台期权状态文件/],
    [LIVE, '{', /不是有效 JSON/],
    [LIVE, state({ exchange_network: 'testnet' }), /测试网/],
    [LIVE, state({ order_journal: { a: { terminal: false, status: 'working' }, b: { terminal: true, status: 'filled' } } }), /还有 1 笔订单未结束/],
    [LIVE, state({ execution_groups: { g: { task_version: 1, live: true, execution_status: 'running' } } }), /1 个执行任务未结束/],
    [LIVE, state({ rfq_state: { status: 'Active' } }), /未完成的 RFQ/],
    [LIVE, state({ rfq_state: { status: 'Filled' } }), /未完成的 RFQ/],
    [LIVE, state({ active_strategy_symbols: ['BTC-1', 'BTC-2'] }), /还在跟踪一组策略（2 腿）/],
    [LIVE, state({ surprise: 1 }), /格式无法识别/],
    [LIVE, state({ execution_groups: { g: { execution_status: 'running' } } }), /版本未知/],
  ];
  for (const [env, text, pattern] of cases) {
    const source = optionsCandidate(env, text);
    assert.match(source.problem ?? '', pattern, JSON.stringify([env, text]));
    assert.equal(source.credentials, null);
    noSecrets(source.problem ?? '');
  }
  // AUTO_OPEN left out is off, as in the workbench (config.py auto_open = False).
  const { AUTO_OPEN: _auto, ...unset } = LIVE;
  assert.equal(optionsCandidate(unset, state()).problem, null);
  // Finished records do not block.
  assert.equal(workbenchStateProblem(JSON.parse(state({
    order_journal: { a: { terminal: true, status: 'timeout_cancelled' } },
    execution_groups: { g: { task_version: 1, live: true, execution_status: 'completed' }, d: { task_version: 1, live: false, execution_status: 'running' }, old: { legs: [] } },
    rfq_state: { status: 'Filled', tracking_applied: true },
  }))), null);
});

test('readWorkbenchOptions overlays the module environment on the shared one and reads the state', () => {
  const root = mkdtempSync(join(tmpdir(), 'tp-options-'));
  try {
    const data = join(root, 'data'), module = join(data, 'modules', 'greeks');
    mkdirSync(module, { recursive: true });
    writeFileSync(join(root, 'workbench.env'), `BYBIT_API_KEY=${KEY}\nBYBIT_API_SECRET=${SECRET}\nAUTO_OPEN=false\nTRADING_MODE=live\n`);
    assert.match(readWorkbenchOptions(join(root, 'workbench.env'), data).problem ?? '', /没有找到工作台期权状态文件/);
    writeFileSync(join(module, 'engine_state.json'), state());
    writeFileSync(join(module, '.env'), 'auto_open=true\n');
    assert.match(readWorkbenchOptions(join(root, 'workbench.env'), data).problem ?? '', /自动开仓/);
    writeFileSync(join(module, '.env'), 'auto_open=off\n');
    const proc = join(root, 'proc');
    mkdirSync(proc);
    const source = readWorkbenchOptions(join(root, 'workbench.env'), data, proc);
    assert.equal(source.problem, null);
    assert.equal(source.stateFile, join(module, 'engine_state.json'));
    assert.throws(() => readWorkbenchOptions(join(root, 'workbench.env'), 'relative', proc), /绝对路径/);
    // The running module still opening on its own (its .env edited but not restarted) refuses, and drops the key.
    const process = (pid: string, env: Record<string, string>, app = 'app.main:app') => {
      mkdirSync(join(proc, pid));
      writeFileSync(join(proc, pid, 'cmdline'), ['python', '-u', 'bridge.py', app, '10', '90', ''].join('\0'));
      writeFileSync(join(proc, pid, 'environ'), Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\0') + '\0');
    };
    process('40', { STATE_FILE: join(module, 'engine_state.json'), AUTO_OPEN: 'true' }, 'other.main:app');
    process('41', { STATE_FILE: join(root, 'elsewhere.json'), AUTO_OPEN: 'true' });
    assert.equal(readWorkbenchOptions(join(root, 'workbench.env'), data, proc).problem, null);
    process('42', { STATE_FILE: join(module, 'engine_state.json'), AUTO_OPEN: 'True' });
    const running = readWorkbenchOptions(join(root, 'workbench.env'), data, proc);
    assert.match(running.problem ?? '', /进程 42.*仍开着自动开仓/);
    assert.equal(running.credentials, null);
    writeFileSync(join(proc, '42', 'environ'), `STATE_FILE=${join(module, 'engine_state.json')}\0auto_open=false\0`);
    assert.equal(runningGreeksProblem(join(module, 'engine_state.json'), proc), null);
    rmSync(join(proc, '42', 'environ'));
    mkdirSync(join(proc, '42', 'environ'));
    assert.match(runningGreeksProblem(join(module, 'engine_state.json'), proc) ?? '', /读不到进程 42/);
    // A symbolic link is not followed.
    symlinkSync(join(root, 'workbench.env'), join(root, 'linked.env'));
    assert.throws(() => readWorkbenchOptions(join(root, 'linked.env'), data, proc), /符号链接/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolveOptionsAccount reads the UID with the key, and a refusal becomes the problem', async () => {
  const fake = new FakeOptions(Date.now);
  const source = optionsCandidate(LIVE, state());
  assert.equal((await resolveOptionsAccount(source, { fetchImpl: fake.fetch, timeoutMs: 5_000 })).accountId, UID);
  fake.permissions = { ...fake.permissions, Options: [] };
  const refused = await resolveOptionsAccount(source, { fetchImpl: fake.fetch, timeoutMs: 5_000 });
  assert.equal(refused.accountId, null);
  assert.match(refused.problem ?? '', /^用工作台期权密钥读取 Bybit 账户失败：.*期权交易/);
  fake.permissions = { ...fake.permissions, Options: ['OptionsTrade'] };
  fake.uid = 'not-a-uid';
  assert.match((await resolveOptionsAccount(source, { fetchImpl: fake.fetch, timeoutMs: 5_000 })).problem ?? '', /有效的账户 UID/);
  // A source already refused makes no request.
  const calls = fake.calls.length;
  await resolveOptionsAccount(optionsCandidate({}, state()), { fetchImpl: fake.fetch });
  assert.equal(fake.calls.length, calls);
});

test('planOptions adds the account once and never overwrites', () => {
  const source = ready(optionsCandidate({ ...LIVE, LEG_QTY: '0.02' }, state()));
  const config: Record<string, unknown> = { secretsFile: '/x/secrets.json', pairs: [] }, secrets: Record<string, unknown> = { accounts: {} }, notes: string[] = [];
  const item = planOptions(source, config, secrets, () => undefined, notes);
  assert.equal(item.status, 'added');
  assert.equal(item.accountId, `***${UID.slice(-4)}`);
  assert.match(item.detail, /四腿铁鹰，每腿 0.02 BTC，最大亏损上限 2500 \/ 保证金上限 2500 USD/);
  assert.deepEqual(config.options, { accountId: UID, limits: { maxRiskUsd: 2500, maxMarginUsd: 2500 }, legQty: '0.02' });
  assert.deepEqual(secrets.bybitOptions, { apiKey: KEY, apiSecret: SECRET });
  assert.match(notes.join(), /不能再用这个 Bybit 账户/);
  noSecrets(JSON.stringify(item));

  // Workbench settings with no counterpart here are named in the notes when they differ from ours.
  // The opening time and the IOC fallback come over (G2a); the auto-open switch never does.
  const tuned = ready(optionsCandidate({ ...LIVE, OPTION_MAX_IM_FACTOR: '0.15', OPTION_MM_FACTOR: '0.03', ALLOW_MARKET_FALLBACK: 'true', OPEN_HOUR_UTC: '20', OPEN_MINUTE_UTC: '30', OPEN_WINDOW_SECONDS: '120' }, state()));
  const tunedNotes: string[] = [], tunedConfig: Record<string, unknown> = { pairs: [] };
  planOptions(tuned, tunedConfig, { accounts: {} }, () => undefined, tunedNotes);
  assert.match(tunedNotes.join(), /不导入.*OPTION_MAX_IM_FACTOR=0.15$/);
  assert.doesNotMatch(tunedNotes.join(), /OPTION_MM_FACTOR|ALLOW_MARKET_FALLBACK=/);
  assert.match(tunedNotes.join(), /定时开仓在配置里是关闭的（时间沿用周五 20:30 UTC）.*沿用那次的页面设置.*IOC 兜底已按工作台打开/);
  assert.deepEqual(tunedConfig.options, { accountId: UID, limits: { maxRiskUsd: 2500, maxMarginUsd: 2500 }, openHourUtc: 20, openMinuteUtc: 30, openWindowSeconds: 120, marketFallback: true });
  assert.match(ready(optionsCandidate({ ...LIVE, OPEN_HOUR_UTC: '24' }, state())).problem ?? '', /openHourUtc/);

  const again = planOptions(source, config, secrets, () => undefined, []);
  assert.deepEqual([again.status, again.detail], ['skipped', '已在本项目配置中，保留现有设置']);
  const stray = planOptions(source, { pairs: [] }, { accounts: {}, bybitOptions: { apiKey: 'a', apiSecret: 'b' } }, () => undefined, []);
  assert.match(stray.detail, /已有 bybitOptions/);
  assert.match(planOptions({ ...source, accountId: null }, { pairs: [] }, { accounts: {} }, () => undefined, []).detail, /未能读取/);
  const unfit = planOptions(source, { pairs: [] }, { accounts: {} }, () => { throw new Error('配置检查失败'); }, []);
  assert.deepEqual([unfit.status, unfit.detail], ['skipped', '加入后本服务不接受（配置检查失败）']);
});

test('planImport brings the options account into an empty or options-only config', () => {
  const options = ready(optionsCandidate(LIVE, state()));
  const plan = planImport({ pairs: [], accounts: [], env: {} }, null, { secretsFile: '/x/secrets.json', only: [], options });
  assert.equal(plan.options?.status, 'added');
  assert.deepEqual(plan.config.pairs, []);
  assert.equal((plan.config.options as { accountId: string }).accountId, UID);
  // An options-only config (no pairs key) reads as such, and its key is known, not stray.
  const existing = { config: { secretsFile: '/x/secrets.json', options: plan.config.options }, secrets: plan.secrets };
  const again = planImport({ pairs: [], accounts: [], env: {} }, existing, { secretsFile: '/x/secrets.json', only: [], options });
  assert.equal(again.options?.detail, '已在本项目配置中，保留现有设置');
  assert.deepEqual(again.config.pairs, []);
});

test('the page request takes options alone or beside pairs and oil', () => {
  assert.deepEqual(parseImportBody({ action: 'import', options: true }), { action: 'import', pairs: [], options: true });
  assert.throws(() => parseImportBody({ action: 'import', options: false }), /options 只能是 true/);
  assert.throws(() => parseImportBody({ action: 'preview', options: true }), /预览不选配对/);
  assert.equal(parseImportRequest({ id: '00000000-0000-4000-8000-000000000000', action: 'import', at: 1, options: true }).options, true);
});

test('the import helper previews and imports the options account without leaking the key', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tp-options-helper-'));
  const fake = new FakeOptions(Date.now);
  try {
    const wbData = join(root, 'wb'), module = join(wbData, 'modules', 'greeks');
    const conf = join(root, 'conf'), dir = join(root, 'import'), data = join(root, 'svc');
    for (const path of [module, conf, dir, data]) mkdirSync(path, { recursive: true });
    writeFileSync(join(root, 'workbench.env'), `DATA_DIR=${wbData}\nBYBIT_API_KEY=${KEY}\nBYBIT_API_SECRET=${SECRET}\nTRADING_MODE=live\nAUTO_OPEN=false\n`);
    writeFileSync(join(module, 'engine_state.json'), state());
    const configFile = join(conf, 'config.json'), secretsFile = join(conf, 'secrets.json');
    writeFileSync(secretsFile, fileText({ accounts: {} }), { mode: 0o600 });
    writeFileSync(configFile, fileText({ secretsFile, pairs: [] }), { mode: 0o600 });
    const restarts: string[] = [];
        mkdirSync(join(root, 'proc'));
    const options = { dir, configFile, dataDir: data, workbenchEnv: join(root, 'workbench.env'), log: () => undefined, checkConfig: () => 'ok', optionsFetch: fake.fetch, procDir: join(root, 'proc'),
      restart: async () => { restarts.push(readFileSync(configFile, 'utf8')); return true; } };

    submitImportRequest(dir, { action: 'preview' });
    await runImportHelper(options);
    const shown = readImportResult(dir)!;
    assert.equal(shown.phase, 'done', shown.message);
    assert.match(shown.message, /期权账户可以导入/);
    assert.deepEqual([shown.options?.status, shown.options?.accountId], ['added', `***${UID.slice(-4)}`]);
    assert.equal(readFileSync(configFile, 'utf8'), fileText({ secretsFile, pairs: [] }), '预览不写文件');
    noSecrets(readFileSync(join(dir, 'result.json'), 'utf8'));

    submitImportRequest(dir, { action: 'import', options: true });
    await runImportHelper(options);
    const done = readImportResult(dir)!;
    assert.equal(done.phase, 'done', done.message);
    assert.match(done.message, /期权账户/);
    assert.equal(restarts.length, 1);
    assert.equal((JSON.parse(readFileSync(configFile, 'utf8')) as { options: { accountId: string } }).options.accountId, UID);
    assert.ok(readFileSync(secretsFile, 'utf8').includes(KEY));
    noSecrets(readFileSync(join(dir, 'result.json'), 'utf8'));

    // Nothing left to bring: refused without a restart.
    submitImportRequest(dir, { action: 'import', options: true });
    await runImportHelper(options);
    assert.match(readImportResult(dir)!.message, /期权账户不能导入，配置未改动/);
    assert.equal(restarts.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
