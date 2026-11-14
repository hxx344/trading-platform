// Monitor M-3b: the workbench's market alert tiers and robot coming over (docs/monitor.md M-3b): converting the three
// files, reading them, the plan, the writer run as the data directory's owner, the monitor taking a waiting import once,
// the alerts' own outbox when `feishuMonitor` is set, the page request, the import helper's order and the command line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertHynixAlerts, convertOilAlerts, convertRobot, parseAlertImport } from '../src/monitor/alert-import.ts';
import { createNotifier } from '../src/service/feishu.ts';
import { PENDING_IMPORT_MAX_AGE_MS, createAlertService, createTestGate, pendingImportKey, type AlertHooks, type AlertRule } from '../src/monitor/alerts.ts';
import { createMonitorStore, type MonitorStore } from '../src/monitor/store.ts';
import { planMonitorAlerts, readWorkbenchAlerts, writeMonitorAlertsAsService, type MonitorAlertsSource } from '../src/service/import-monitor-alerts.ts';
import { fileText, filesUnchanged, planImport } from '../src/service/import-workbench.ts';
import { readImportResult, submitImportRequest } from '../src/service/import-channel.ts';
import { runImportHelper } from '../src/service/import-helper.ts';
import { marketAlertHooks } from '../src/service/main.ts';

const NOW = Date.parse('2026-11-14T08:00:00Z');
const HOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/monitor-import-hook-0001';
const SIGN = 'monitor-import-sign-0001';
const oilRule = (values: Record<string, unknown> = {}) => ({ id: 'r1', label: '价差 5', metric: 'spread', operator: 'gte', threshold: 5, cooldownMinutes: 30, hysteresis: 0.1, enabled: true, ...values });
const oilFile = (rules: unknown[], enabled = true) => ({ schemaVersion: 1, config: { enabled, rules } });
const hynixFile = () => ({
  version: 2, config: {
    enabled: false, cooldownSeconds: 300, hysteresis: 0.5, rules: [
      { id: 'h1', name: '溢价 40', enabled: true, direction: 'above', threshold: 40 },
      { id: 'h2', name: '溢价 30 下', enabled: true, direction: 'below', threshold: 30, cooldownSeconds: 90, hysteresis: 1 },
      { id: 'h3', name: '重复的 40', enabled: false, direction: 'above', threshold: 40 },
      { id: 'h4', name: '双向 35', enabled: true, direction: 'both', threshold: 35 },
    ],
  },
});
const robotFile = (webhookUrl = HOOK, signingSecret = SIGN, candidates: unknown[] = []) => ({ version: 1, config: { webhookUrl, signingSecret }, candidates });
const noSecrets = (text: string): void => { for (const secret of [HOOK, 'monitor-import-hook', SIGN]) assert.ok(!text.includes(secret), `输出含 ${secret.slice(0, 16)}…`); };

test('转换：原油档位照搬；旧的百分比档改为关闭的绝对价差档并加后缀，与已有档重复的不导入', () => {
  const converted = convertOilAlerts(oilFile([
    oilRule(),
    oilRule({ id: 'p1', label: '旧百分比 5', metric: 'spreadPercent' }),
    oilRule({ id: 'p2', label: '旧百分比 6', metric: 'spreadPercent', threshold: 6 }),
    oilRule({ id: 'b1', label: '布伦特 70', metric: 'brent', operator: 'lte', threshold: 70, enabled: false }),
  ]));
  assert.ok(converted.config, 'problem' in converted ? converted.problem : '');
  assert.deepEqual(converted.config.rules.map(rule => [rule.id, rule.metric, rule.label, rule.enabled]), [['r1', 'spread', '价差 5', true], ['p2', 'spread', '旧百分比 6（原百分比）', false], ['b1', 'brent', '布伦特 70', false]]);
  assert.equal(converted.config.enabled, true);
  assert.match(converted.notes.join(), /1 档旧的百分比价差档改为同数值的绝对价差档并关闭/);
  assert.match(converted.notes.join(), /1 档旧的百分比价差档换算后与已有档重复/);
  // A label at the limit is cut on whole code points to fit the suffix.
  const long = convertOilAlerts(oilFile([oilRule({ metric: 'spreadPercent', label: '档'.repeat(60) })]));
  assert.ok(long.config);
  assert.equal(long.config.rules[0]!.label.length, 60);
  assert.ok(long.config.rules[0]!.label.endsWith('（原百分比）'));
  assert.match((convertOilAlerts({ schemaVersion: 2, config: {} }) as { problem: string }).problem, /格式无法识别/);
  assert.match((convertOilAlerts(oilFile([oilRule({ threshold: 'x' })])) as { problem: string }).problem, /^档位未通过本服务的检查：/);
});

test('转换：海力士方向对应、各档冷却与回差或统一值、秒换分钟、重复档不导入；机器人与待选两个的情况', () => {
  const converted = convertHynixAlerts(hynixFile());
  assert.ok(converted.config, 'problem' in converted ? converted.problem : '');
  assert.deepEqual(converted.config.rules.map(rule => [rule.id, rule.metric, rule.operator, rule.threshold, rule.cooldownMinutes, rule.hysteresis, rule.label]),
    [['h1', 'premium', 'gte', 40, 5, 0.5, '溢价 40'], ['h2', 'premium', 'lte', 30, 1.5, 1, '溢价 30 下'], ['h4', 'premium', 'both', 35, 5, 0.5, '双向 35']]);
  assert.equal(converted.config.enabled, false);
  assert.match(converted.notes.join(), /1 档与前面的档方向、阈值相同/);
  assert.match((convertHynixAlerts({ version: 2, config: { enabled: true, rules: [] } }) as { problem: string }).problem, /缺少统一的冷却时间或回差/);
  const tooLong = hynixFile(); tooLong.config.cooldownSeconds = 2 * 86_400;
  assert.match((convertHynixAlerts(tooLong) as { problem: string }).problem, /冷却时间需在 0–1440 分钟内/);

  assert.deepEqual(convertRobot(robotFile(` ${HOOK} `, '')), { robot: { webhook: HOOK, secret: null } });
  assert.deepEqual(convertRobot(robotFile()), { robot: { webhook: HOOK, secret: SIGN } });
  assert.match((convertRobot(robotFile('', '', [{ webhookUrl: HOOK }, { webhookUrl: HOOK }])) as { problem: string }).problem, /两个待选的机器人/);
  assert.match((convertRobot(robotFile('', '')) as { problem: string }).problem, /没有配置行情告警机器人/);
  assert.match((convertRobot({ version: 2 }) as { problem: string }).problem, /格式无法识别/);
  assert.throws(() => parseAlertImport({}), /没有要导入的档位/);
  assert.throws(() => parseAlertImport({ anthropic: {} }), /未知的市场/);
});

function workbench(files: { oil?: unknown; hynix?: unknown; robot?: unknown } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tp-monitor-import-'));
  const wb = join(root, 'wb'), dir = join(wb, 'modules', 'monitor'), svc = join(root, 'svc');
  for (const path of [join(dir, 'oil'), join(dir, 'hynix'), svc]) mkdirSync(path, { recursive: true });
  if (files.oil !== undefined) writeFileSync(join(dir, 'oil', 'monitor.json'), typeof files.oil === 'string' ? files.oil : JSON.stringify(files.oil));
  if (files.hynix !== undefined) writeFileSync(join(dir, 'hynix', 'alerts.json'), JSON.stringify(files.hynix));
  if (files.robot !== undefined) writeFileSync(join(dir, 'notifications.json'), JSON.stringify(files.robot));
  return { root, wb, dir, svc, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('读取：三个文件逐个转换；缺文件、不是 JSON、符号链接各给原因，不带文件内容；没有 Monitor 目录时三项都是“没有”', () => {
  const w = workbench({ oil: oilFile([oilRule()]), hynix: hynixFile(), robot: robotFile() });
  try {
    const source = readWorkbenchAlerts(w.wb);
    assert.deepEqual([source.oil.config?.rules.length, source.hynix.config?.rules.length, source.robot.robot?.webhook], [1, 3, HOOK]);
    writeFileSync(join(w.dir, 'oil', 'monitor.json'), `{"webhook": "${HOOK}"`);
    rmSync(join(w.dir, 'hynix', 'alerts.json'));
    rmSync(join(w.dir, 'notifications.json'));
    symlinkSync('/etc/hostname', join(w.dir, 'notifications.json'));
    const broken = readWorkbenchAlerts(w.wb);
    assert.deepEqual([(broken.oil as { problem: string }).problem, (broken.hynix as { problem: string }).problem, (broken.robot as { problem: string }).problem],
      ['oil/monitor.json 不是有效的 JSON', '工作台没有 hynix/alerts.json', 'notifications.json 不是普通文件（符号链接等），不读取']);
    noSecrets(JSON.stringify(broken));
    const none = readWorkbenchAlerts(join(w.root, 'nowhere'));
    assert.deepEqual([(none.oil as { problem: string }).problem, (none.hynix as { problem: string }).problem, (none.robot as { problem: string }).problem], ['工作台没有 Monitor 模块', '工作台没有 Monitor 模块', '工作台没有 Monitor 模块']);
    assert.throws(() => readWorkbenchAlerts('relative'), /绝对路径/);
  } finally { w.done(); }
});

const sourceOf = (oil = true, hynix = true, robot = true): MonitorAlertsSource => ({
  oil: oil ? convertOilAlerts(oilFile([oilRule()])) : { config: null, problem: '工作台没有 oil/monitor.json' },
  hynix: hynix ? convertHynixAlerts(hynixFile()) : { config: null, problem: '工作台没有 hynix/alerts.json' },
  robot: robot ? { robot: { webhook: HOOK, secret: SIGN } } : { robot: null, problem: '工作台没有配置行情告警机器人' },
});

test('计划：没有行情监控时不导入；机器人写入 feishuMonitor，相同的不算改动，不同的替换；地址不合格不导入', () => {
  const notes: string[] = [];
  const off = planMonitorAlerts(sourceOf(), { pairs: [] }, { accounts: {} }, notes);
  assert.deepEqual([off.item.status, off.write, off.item.detail], ['skipped', null, '行情监控未启用，告警不导入']);
  const secrets: Record<string, unknown> = { accounts: {} };
  const ON = { monitor: { oil: {}, hynix: {} } };
  const planned = planMonitorAlerts(sourceOf(), ON, secrets, notes);
  assert.deepEqual([planned.item.status, Object.keys(planned.write ?? {}), planned.item.robot], ['added', ['oil', 'hynix'], { imported: true, problem: null, replaces: false, changes: true }]);
  assert.deepEqual(secrets.feishuMonitor, { webhook: HOOK, secret: SIGN });
  assert.match(planned.item.detail, /^替换本服务的原油 1 档（启用 1，总开关开）、海力士 3 档（启用 3，总开关关）；机器人写入 secrets\.json 的 feishuMonitor$/);
  assert.match(notes.join(), /越线状态从头算.*两边都会发/);
  assert.match(notes.join(), /回滚到更早版本前须先删掉 feishuMonitor/);
  noSecrets(JSON.stringify(planned.item) + notes.join());
  const same = planMonitorAlerts(sourceOf(), ON, secrets, []);
  assert.deepEqual(same.item.robot, { imported: true, problem: null, replaces: false, changes: false });
  const reordered = { accounts: {}, feishuMonitor: { secret: SIGN, webhook: HOOK } };
  assert.equal(planMonitorAlerts(sourceOf(), ON, reordered, []).item.robot.changes, false, '键顺序不同不算改动');
  const nullSecret = { accounts: {}, feishuMonitor: { webhook: HOOK, secret: null } };
  const unsigned: MonitorAlertsSource = { ...sourceOf(), robot: { robot: { webhook: HOOK, secret: null } } };
  assert.equal(planMonitorAlerts(unsigned, ON, nullSecret, []).item.robot.changes, false, 'secret: null 与没有签名相同');
  // Only the markets the config runs get tiers.
  const oilOnly = planMonitorAlerts(sourceOf(), { monitor: { oil: {} } }, { accounts: {} }, []);
  assert.deepEqual([Object.keys(oilOnly.write ?? {}), oilOnly.item.markets[1]!.problem, oilOnly.item.markets[1]!.rules], [['oil'], '本服务的行情监控没有海力士，档位不导入', 0]);
  assert.match(oilOnly.item.detail, /^替换本服务的原油 1 档/);
  const neither = planMonitorAlerts(sourceOf(true, true, false), { monitor: { anthropic: {} } }, { accounts: {} }, []);
  assert.deepEqual([neither.item.status, neither.write], ['skipped', null]);
  const other = { accounts: {}, feishuMonitor: { webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/other-hook-0002' } };
  assert.equal(planMonitorAlerts(sourceOf(), ON, other, []).item.robot.replaces, true);
  assert.equal((other.feishuMonitor as { webhook: string }).webhook, HOOK);
  const bad: MonitorAlertsSource = { ...sourceOf(), robot: { robot: { webhook: 'https://example.com/hook', secret: null } } };
  const refused = planMonitorAlerts(bad, ON, { accounts: {} }, []);
  assert.deepEqual([refused.item.status, refused.item.robot.imported], ['added', false]);
  assert.match(refused.item.robot.problem ?? '', /不是飞书或 Lark 自定义机器人/);
  const robotOnly = planMonitorAlerts(sourceOf(false, false, true), ON, { accounts: {} }, []);
  assert.deepEqual([robotOnly.item.status, robotOnly.write], ['added', null]);
  const nothing = planMonitorAlerts(sourceOf(false, false, false), ON, { accounts: {} }, []);
  assert.equal(nothing.item.status, 'skipped');
  assert.match(nothing.item.detail, /^没有可导入的告警：原油：工作台没有 oil\/monitor\.json；海力士：.*；机器人：工作台没有配置行情告警机器人$/);
});

const hooks = (): AlertHooks => ({ notify: () => 1, delivery: () => new Map(), robot: () => 'feishu', test: async () => undefined });
const gate = createTestGate(() => NOW);

test('写入与应用：写入方只留待应用的键；监控在启动与每轮检查时应用一次，替换档位、版本加一、记一条导入', () => {
  const w = workbench();
  try {
    const source = sourceOf();
    const written = writeMonitorAlertsAsService(w.svc, { oil: source.oil.config!, hynix: source.hynix.config! });
    assert.deepEqual(written, [{ market: 'oil', rules: 1, enabled: true }, { market: 'hynix', rules: 3, enabled: false }]);
    const store = createMonitorStore({ file: join(w.svc, 'monitor.sqlite'), now: () => NOW });
    try {
      assert.ok(store.readState(pendingImportKey('oil')));
      const logs: string[] = [];
      const oil = createAlertService({ market: 'oil', store, quote: () => null, hooks: hooks(), gate, now: () => NOW, log: line => logs.push(line) });
      const view = oil.view();
      assert.deepEqual([view.revision, view.config.rules.map(rule => rule.id), view.config.enabled], [1, ['r1'], true]);
      assert.deepEqual([view.history[0]?.kind, view.history[0]?.status, (view.history[0] as { count?: number }).count], ['import', 'applied', 1]);
      assert.equal(store.readState(pendingImportKey('oil')), null, '应用后删掉待应用的键');
      assert.match(logs.join(), /已应用从工作台导入的档位（1 档，总开关开）/);
      oil.check();
      assert.equal(oil.view().revision, 1, '只应用一次');
      // A page save in between does not stop a later import: the next check takes it.
      oil.update({ revision: 1, config: { enabled: false, rules: [] } });
      writeMonitorAlertsAsService(w.svc, { oil: source.oil.config! });
      oil.check();
      assert.deepEqual([oil.view().revision, oil.view().config.rules.length, oil.view().history.filter(item => item.kind === 'import').length], [3, 1, 2]);
      const hynix = createAlertService({ market: 'hynix', store, quote: () => null, hooks: hooks(), gate, now: () => NOW, log: () => undefined });
      assert.deepEqual([hynix.view().config.rules.length, hynix.view().config.enabled], [3, false]);
    } finally { store.close(); }
    assert.throws(() => writeMonitorAlertsAsService(w.svc, {} as never), /写入告警档位失败，已有档位未改动：没有要导入的档位/);
    assert.throws(() => writeMonitorAlertsAsService('relative', { oil: source.oil.config! }), /绝对路径/);
  } finally { w.done(); }
});

test('应用：待应用的值无效或超过 10 分钟时丢弃并记日志；写入失败时显示原因、每轮重试，恢复后应用', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-monitor-pending-'));
  const real = createMonitorStore({ file: join(dir, 'monitor.sqlite'), now: () => NOW });
  try {
    const fails = { on: false };
    const store = { ...real, commitStates: (writes: readonly (readonly [string, unknown])[], removes: readonly string[] = []) => { if (fails.on && writes.length) throw new Error('disk full'); real.commitStates(writes, removes); } } as MonitorStore;
    real.writeState(pendingImportKey('oil'), { version: 1, importedAt: 'x', source: 'workbench', config: {} });
    const logs: string[] = [];
    const service = createAlertService({ market: 'oil', store, quote: () => null, hooks: hooks(), gate, now: () => NOW, log: line => logs.push(line) });
    assert.equal(real.readState(pendingImportKey('oil')), null);
    assert.match(logs.join(), /未应用，已丢弃：导入记录格式无效/);
    assert.equal(service.view().revision, 0);
    // Left by an import whose config change failed: must not overwrite tiers when the market starts later.
    real.writeState(pendingImportKey('oil'), { version: 1, importedAt: new Date(NOW - PENDING_IMPORT_MAX_AGE_MS - 1000).toISOString(), source: 'workbench', config: { enabled: true, rules: [oilRule()] } });
    service.check();
    assert.deepEqual([real.readState(pendingImportKey('oil')), service.view().revision], [null, 0]);
    assert.match(logs.join(), /已超过 10 分钟未应用/);
    fails.on = true;
    const rules: AlertRule[] = [oilRule() as AlertRule];
    real.writeState(pendingImportKey('oil'), { version: 1, importedAt: new Date(NOW).toISOString(), source: 'workbench', config: { enabled: true, rules } });
    service.check(); service.check();
    assert.match(service.view().error ?? '', /导入的档位暂未应用/);
    assert.equal(logs.filter(line => line.includes('暂未应用')).length, 1, '只记一次');
    fails.on = false;
    service.check();
    assert.doesNotMatch(service.view().error ?? '', /暂未应用/);
    assert.deepEqual([service.view().revision, service.view().config.rules.length], [1, 1]);
  } finally { real.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('机器人：有 feishuMonitor 时入行情告警自己的队列，没有时入 feishu 的队列；送达按各自入队的队列读；队列打不开时报错', async () => {
  const queue = (name: string) => {
    const sent: string[] = [], asked: number[][] = [];
    return { sent, asked, outbox: { notify: (text: string) => { sent.push(text); return sent.length; }, delivery: (ids: readonly number[]) => { asked.push([...ids]); return new Map(ids.map(id => [id, { sentAt: NOW, attempts: 1, lastError: name, nextAt: NOW }])); } } };
  };
  const aster = queue('aster'), monitor = queue('monitor'), posted: string[] = [];
  const send = async (secret: { webhook: string }, text: string) => { posted.push(`${secret.webhook} ${text}`); };
  const own = marketAlertHooks({ secrets: { feishu: { webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/aster-hook-0003', secret: null }, feishuMonitor: { webhook: HOOK, secret: SIGN } }, notifier: aster.outbox, monitorOutbox: monitor.outbox, monitorOutboxError: null, send });
  assert.equal(own.robot(), 'feishuMonitor');
  assert.equal(own.notify('告警'), 1);
  assert.deepEqual([aster.sent, monitor.sent], [[], ['告警']]);
  assert.equal(own.delivery([1], 'feishu').get(1)?.lastError, 'aster', '之前入 feishu 队列的仍从那里读');
  assert.equal(own.delivery([1], 'feishuMonitor').get(1)?.lastError, 'monitor');
  await own.test('测试');
  assert.deepEqual(posted, [`${HOOK} 测试`]);
  const shared = marketAlertHooks({ secrets: { feishu: { webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/aster-hook-0003', secret: null } }, notifier: aster.outbox, monitorOutbox: null, monitorOutboxError: null, send });
  assert.equal(shared.robot(), 'feishu');
  shared.notify('告警 2');
  assert.deepEqual(aster.sent, ['告警 2']);
  assert.throws(() => shared.delivery([1], 'feishuMonitor'), /notify-monitor\.sqlite 无法打开：文件不存在/);
  const broken = marketAlertHooks({ secrets: { feishu: null, feishuMonitor: { webhook: HOOK, secret: null } }, notifier: aster.outbox, monitorOutbox: null, monitorOutboxError: 'database is locked', send });
  assert.throws(() => broken.notify('x'), /无法打开：database is locked/);
  const none = marketAlertHooks({ secrets: { feishu: null }, notifier: aster.outbox, monitorOutbox: null, monitorOutboxError: null, send });
  assert.deepEqual([none.robot(), none.notify('x')], [null, null]);
});

test('队列：机器人删掉后残留的消息照样按 7 天保留期清除', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-monitor-outbox-'));
  let at = NOW;
  const base = { file: join(dir, 'notify-monitor.sqlite'), events: () => [], latestSeq: () => 0, pairs: () => [], incidentPair: () => null, now: () => at, log: () => undefined };
  try {
    const before = createNotifier({ ...base, feishu: { webhook: HOOK, secret: null }, fetchImpl: async () => new Response('{}', { status: 500 }) });
    const id = before.notify('告警')!;
    before.close();
    const after = createNotifier({ ...base, feishu: null });
    try {
      await after.flush();
      assert.equal(after.delivery([id]).size, 1, '保留期内不删');
      at += 8 * 86_400_000;
      await after.flush();
      assert.equal(after.delivery([id]).size, 0);
    } finally { after.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('planImport：告警跟在行情监控之后；只换档位时配置不变；机器人变化时 secrets 改动', () => {
  const source = { pairs: [], accounts: [], env: {} };
  const fresh = planImport(source, null, { secretsFile: '/x/secrets.json', only: [], monitor: { workbench: true }, monitorAlerts: sourceOf() });
  assert.deepEqual([fresh.monitor?.status, fresh.monitorAlerts?.status, Object.keys(fresh.alertWrite ?? {})], ['added', 'added', ['oil', 'hynix']]);
  assert.deepEqual(fresh.secrets.feishuMonitor, { webhook: HOOK, secret: SIGN });
  const existing = { config: { secretsFile: '/x/secrets.json', pairs: [], monitor: { anthropic: {}, oil: {}, hynix: {} } }, secrets: { accounts: {}, feishuMonitor: { webhook: HOOK, secret: SIGN } } };
  const again = planImport(source, existing, { secretsFile: '/x/secrets.json', only: [], monitor: { workbench: true }, monitorAlerts: sourceOf() });
  assert.deepEqual([again.monitor?.status, again.monitorAlerts?.status, again.monitorAlerts?.robot.changes], ['skipped', 'added', false]);
  assert.ok(filesUnchanged(again, existing), '只换档位');
  const off = planImport(source, { ...existing, config: { secretsFile: '/x/secrets.json', pairs: [] } }, { secretsFile: '/x/secrets.json', only: [], monitorAlerts: sourceOf() });
  assert.equal(off.monitorAlerts?.status, 'skipped');
});

test('导入助手：预览列出告警；只换档位不重启；机器人变化时重启；档位写入失败什么都不改；读取失败给原因', async () => {
  const w = workbench({ oil: oilFile([oilRule()]), hynix: hynixFile(), robot: robotFile() });
  try {
    const conf = join(w.root, 'conf'), dir = join(w.root, 'import');
    for (const path of [conf, dir, join(w.root, 'proc')]) mkdirSync(path, { recursive: true });
    writeFileSync(join(w.root, 'workbench.env'), `DATA_DIR=${w.wb}\n`);
    const configFile = join(conf, 'config.json'), secretsFile = join(conf, 'secrets.json');
    const first = fileText({ secretsFile, pairs: [], monitor: { anthropic: {}, oil: {}, hynix: {} } });
    writeFileSync(secretsFile, fileText({ accounts: {} }), { mode: 0o600 });
    writeFileSync(configFile, first, { mode: 0o600 });
    const restarts: string[] = [], writes: string[][] = [];
    const helperLogs: string[] = [];
    const base = { dir, configFile, dataDir: w.svc, workbenchEnv: join(w.root, 'workbench.env'), log: (line: string) => { helperLogs.push(line); }, checkConfig: () => 'ok', procDir: join(w.root, 'proc'),
      restart: async () => { restarts.push(readFileSync(secretsFile, 'utf8')); return true; } };
    const run = async (body: unknown, options: Partial<Parameters<typeof runImportHelper>[0]> = {}) => {
      submitImportRequest(dir, body);
      await runImportHelper({ ...base, ...options });
      return readImportResult(dir)!;
    };
    const record = (_dataDir: string, write: Record<string, { rules: unknown[]; enabled: boolean }>) => {
      writes.push(Object.keys(write));
      return Object.entries(write).map(([market, config]) => ({ market: market as 'oil', rules: config.rules.length, enabled: config.enabled }));
    };

    const shown = await run({ action: 'preview' });
    assert.equal(shown.phase, 'done', shown.message);
    assert.match(shown.message, /行情告警可以导入/);
    assert.deepEqual([shown.monitorAlerts?.status, shown.monitorAlerts?.markets.map(item => item.rules)], ['added', [1, 3]]);
    noSecrets(readFileSync(join(dir, 'result.json'), 'utf8'));
    assert.equal(writes.length, 0);

    const failed = await run({ action: 'import', monitor: true, monitorAlerts: true }, { writeAlerts: () => { throw new Error('写入告警档位失败，已有档位未改动：库被占用'); } });
    assert.equal(failed.phase, 'failed');
    assert.match(failed.message, /库被占用；配置未改动，本次没有导入任何内容，可重试/);
    assert.equal(readFileSync(secretsFile, 'utf8'), fileText({ accounts: {} }));
    assert.equal(restarts.length, 0);

    // Tiers and a new robot: the tiers are written first, then secrets.json, then the restart.
    const done = await run({ action: 'import', monitor: true, monitorAlerts: true }, { writeAlerts: record });
    assert.equal(done.phase, 'done', done.message);
    assert.match(done.message, /已导入 行情告警档位与机器人，服务已重启。行情监控 10 秒内换上导入的告警档位/);
    assert.deepEqual(writes, [['oil', 'hynix']]);
    assert.equal(restarts.length, 1);
    assert.deepEqual(JSON.parse(readFileSync(secretsFile, 'utf8')).feishuMonitor, { webhook: HOOK, secret: SIGN });
    noSecrets(readFileSync(join(dir, 'result.json'), 'utf8'));

    // Again with the same robot: only the tiers, no restart.
    const tiers = await run({ action: 'import', monitor: true, monitorAlerts: true }, { writeAlerts: record });
    assert.equal(tiers.phase, 'done', tiers.message);
    assert.match(tiers.message, /^已重新导入告警档位（原油 1 档、海力士 3 档）；配置未改动，未重启服务，行情监控 10 秒内换上新档位$/);
    assert.equal(restarts.length, 1);

    // Robot only, the same one: nothing to change.
    rmSync(join(w.dir, 'oil', 'monitor.json')); rmSync(join(w.dir, 'hynix', 'alerts.json'));
    const same = await run({ action: 'import', monitor: true, monitorAlerts: true }, { writeAlerts: record });
    assert.equal(same.phase, 'done', same.message);
    assert.match(same.message, /机器人已在本服务配置中，配置未改动/);
    assert.equal(writes.length, 2);

    // The monitor directory is a link: it is not read, the reason is shown and nothing is imported.
    rmSync(w.dir, { recursive: true });
    symlinkSync(w.svc, w.dir);
    const unread = await run({ action: 'import', monitor: true, monitorAlerts: true }, { writeAlerts: record });
    assert.equal(unread.phase, 'failed', JSON.stringify(unread));
    assert.match(unread.monitorAlertsError ?? '', /不是目录（符号链接等），不读取/, unread.message);
    assert.match(unread.message, /行情监控与行情告警都不能导入，配置未改动/);
    assert.ok(helperLogs.length > 0);
    noSecrets(helperLogs.join('\n'));
  } finally { w.done(); }
});

test('命令行：--monitor-alerts 须带本服务数据目录', () => {
  const w = workbench();
  try {
    writeFileSync(join(w.root, 'workbench.env'), `DATA_DIR=${w.wb}\n`);
    const run = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'src', 'service', 'import-workbench.ts'), '--config', join(w.root, 'config.json'), '--workbench-env', join(w.root, 'workbench.env'), '--monitor-alerts'], { encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /--monitor-alerts 需要 --data-dir/);
  } finally { w.done(); }
});

test('页面：告警视图读出所用机器人与导入记录；旧服务没有 robot 字段时按 feishu 读', async () => {
  const { alertView, historyText, STATUS_LABELS } = await import('../web/src/monitor-alerts.ts');
  const base = { market: 'oil', revision: 2, config: { enabled: true, rules: [oilRule()] }, robotConfigured: true, checkedAt: null, lastValidAt: null, values: null, error: null, notice: null };
  const imported = { id: 'e1', time: new Date(NOW).toISOString(), kind: 'import', status: 'applied', rules: [], error: '', count: 3, enabled: false };
  const view = alertView({ ...base, robot: 'feishuMonitor', history: [imported] });
  assert.equal(view.robot, 'feishuMonitor');
  assert.equal(historyText('oil', view.history[0]!), '从工作台导入 3 档（总开关关），替换了原有档位');
  assert.equal(STATUS_LABELS[view.history[0]!.status], '已导入');
  assert.equal(alertView({ ...base, history: [] }).robot, 'feishu');
  assert.equal(alertView({ ...base, robotConfigured: false, history: [] }).robot, null);
  assert.throws(() => alertView({ ...base, robot: null, history: [] }), /格式无法识别/);
  assert.throws(() => alertView({ ...base, robot: 'feishuMonitor', history: [{ ...imported, status: 'sent' }] }), /格式无法识别/);
  assert.throws(() => alertView({ ...base, robot: 'feishuMonitor', history: [{ ...imported, count: undefined }] }), /格式无法识别/);
});
