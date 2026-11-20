// Monitor M-3d-2: the workbench's Var token coming over (docs/monitor.md M-3d-2): reading the workbench file under its own
// rules, the replacement rule and the plan, the writer run as the data directory's owner, the running session taking a
// token written by someone else, the import helper and the command line. The token never shows in answers or logs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { variationalTokenExpiry } from '../src/vendor/variational-market.mjs';
import { VARIATIONAL_SESSION_FILE, createVariationalSession, variationalFileIdentity, writeVariationalSessionFile } from '../src/monitor/variational-session.ts';
import { decideVariationalImport } from '../src/monitor/variational-import-writer.ts';
import { inspectVariationalAsService, planMonitorVariational, readWorkbenchVariational, writeVariationalAsService } from '../src/service/import-monitor-variational.ts';
import { fileText, filesUnchanged, planImport, variationalInput } from '../src/service/import-workbench.ts';
import { readImportResult, submitImportRequest } from '../src/service/import-channel.ts';
import { runImportHelper } from '../src/service/import-helper.ts';
import { fakeAnthropicVenues, fakeVariationalToken } from './monitor-fake.ts';

const DAY = 86_400_000;
const iso = (token: string) => new Date(variationalTokenExpiry(token)).toISOString();
const saved = (token: string, revision = 4) => `${JSON.stringify({ version: 1, revision, token, updatedAt: '2026-11-14T00:00:00.000Z' })}\n`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tp-var-import-'));
  const wb = join(root, 'wb'), dir = join(wb, 'modules', 'monitor'), svc = join(root, 'svc');
  for (const path of [dir, svc]) mkdirSync(path, { recursive: true });
  const put = (text: string, mode = 0o600) => { const file = join(dir, 'variational-session.json'); rmSync(file, { force: true }); writeFileSync(file, text, { mode }); chmodSync(file, mode); };
  return { root, wb, dir, svc, put, done: () => rmSync(root, { recursive: true, force: true }) };
}
const noToken = (text: string, ...tokens: string[]) => { for (const token of tokens) assert.ok(!text.includes(token) && !text.includes(token.split('.')[1]!), '输出含 token'); };

test('读取：只读 600 的普通文件；缺失、权限、过大、链接、坏 JSON、格式、过期各给原因，不带内容；没有 Monitor 目录时说明', () => {
  const f = fixture();
  try {
    const token = fakeVariationalToken(Date.now() + DAY, 'wb');
    assert.deepEqual(readWorkbenchVariational(f.wb), { token: null, problem: '工作台没有保存 Var token' });
    f.put(saved(token));
    assert.deepEqual(readWorkbenchVariational(f.wb), { token, expiresAt: iso(token) });
    const reasons: string[] = [];
    const check = (pattern: RegExp) => { const read = readWorkbenchVariational(f.wb); assert.equal(read.token, null); const problem = (read as { problem: string }).problem; assert.match(problem, pattern); reasons.push(problem); };
    f.put(saved(token), 0o644); check(/权限不是 600，工作台自己也不会读它/);
    f.put(saved(token) + ' '.repeat(17_000)); check(/超过 16 KiB/);
    f.put(`{"version":1,"token":"${token}"`); check(/不是有效的 JSON/);
    f.put(JSON.stringify({ version: 2, token })); check(/格式不符/);
    f.put(JSON.stringify({ version: 1, token: 'abc' })); check(/格式无效（读不出到期时间）/);
    f.put(saved(fakeVariationalToken(Date.now() + 10_000, 'old'))); check(/过期（或 30 秒内到期），不导入/);
    rmSync(join(f.dir, 'variational-session.json'));
    writeFileSync(join(f.root, 'elsewhere.json'), saved(token), { mode: 0o600 });
    symlinkSync(join(f.root, 'elsewhere.json'), join(f.dir, 'variational-session.json'));
    check(/不是普通文件（符号链接等），不读取/);
    noToken(reasons.join('\n'), token);
    rmSync(join(f.wb, 'modules'), { recursive: true });
    assert.deepEqual(readWorkbenchVariational(f.wb), { token: null, problem: '工作台没有 Monitor 模块' });
    assert.throws(() => readWorkbenchVariational('relative/path'), /须为绝对路径/);
  } finally { f.done(); }
});

test('取舍与计划：没有或过期则导入，同一个或本服务到期不早于工作台则保留；须有原油监控；本服务状态读不出时交给写入方', () => {
  const now = Date.now(), token = fakeVariationalToken(now + DAY, 'wb'), expiry = variationalTokenExpiry(token);
  const none = { configured: false, expiresAt: null, revision: 0, problem: null };
  assert.deepEqual(decideVariationalImport(none, { token, expiry }), { write: true, replaces: false });
  assert.deepEqual(decideVariationalImport({ configured: true, expiresAt: new Date(expiry).toISOString(), revision: 2, problem: null, token }, { token, expiry }), { write: false, reason: '本服务已是同一个 Var token' });
  const later = { configured: true, expiresAt: new Date(expiry + 1000).toISOString(), revision: 2, problem: null };
  assert.match((decideVariationalImport(later, { token, expiry }) as { reason: string }).reason, /不早于工作台的，保留本服务的/);
  assert.deepEqual(decideVariationalImport({ ...later, expiresAt: new Date(expiry - 1000).toISOString() }, { token, expiry }), { write: true, replaces: true });
  assert.deepEqual(decideVariationalImport({ ...later, problem: '本服务的 Var token 已过期' }, { token, expiry }), { write: true, replaces: true });

  const source = { token, expiresAt: new Date(expiry).toISOString() };
  const config = { monitor: { anthropic: {}, oil: {}, goldoil: {}, hynix: {}, perpetual: {} } };
  assert.equal(planMonitorVariational(source, none, null, {}).item.detail, '行情监控未启用，Var token 不导入');
  assert.equal(planMonitorVariational(source, none, null, { monitor: { anthropic: {} } }).item.detail, '本服务的行情监控没有原油价差，Var token 不导入');
  assert.deepEqual(planMonitorVariational({ token: null, problem: '工作台没有保存 Var token' }, null, null, config).item.status, 'skipped');
  const added = planMonitorVariational(source, none, null, config);
  assert.deepEqual([added.item.status, added.item.replaces, added.write?.token === token], ['added', false, true]);
  assert.equal(planMonitorVariational(source, later, null, config).item.status, 'skipped');
  const blind = planMonitorVariational(source, null, '读不出', config);
  assert.equal(blind.item.status, 'added');
  assert.match(blind.item.detail, /本服务现有状态读不出（读不出），写入时再判断/);
  noToken(JSON.stringify([added.item, blind.item]), token);

  // planImport: the token follows the monitor's own plan, and leaves the files as they are.
  const existing = { config: { secretsFile: '/x/secrets.json', pairs: [], ...config }, secrets: { accounts: {} } };
  const plan = planImport({ pairs: [], accounts: [], env: {} }, existing, { secretsFile: '/x/secrets.json', only: [], monitor: { workbench: true }, monitorVariational: { source, current: none, currentError: null } });
  assert.deepEqual([plan.monitor?.status, plan.monitorVariational?.status, plan.variationalWrite?.token === token], ['skipped', 'added', true]);
  assert.ok(filesUnchanged(plan, existing));
  const fresh = planImport({ pairs: [], accounts: [], env: {} }, null, { secretsFile: '/x/secrets.json', only: [], monitor: { workbench: true }, monitorVariational: { source, current: none, currentError: null } });
  assert.equal(fresh.monitorVariational?.status, 'added', '同次启用的行情监控含原油');
  assert.deepEqual(variationalInput(source, '/svc', () => { throw new Error('读不出'); }), { source, current: null, currentError: '读不出' });
});

test('写入方（以当前账户运行，降权路径同 M-3b）：版本加一、600；同一个或本服务更新的不写；拒写符号链接；输出不含 token', async () => {
  const f = fixture();
  try {
    const first = fakeVariationalToken(Date.now() + DAY, 'one'), second = fakeVariationalToken(Date.now() + 2 * DAY, 'two');
    assert.deepEqual(inspectVariationalAsService(f.svc), { configured: false, expiresAt: null, revision: 0, problem: null });
    const written = writeVariationalAsService(f.svc, first);
    assert.deepEqual(written, { written: true, replaces: false, reason: null, revision: 1, expiresAt: iso(first) });
    const file = join(f.svc, VARIATIONAL_SESSION_FILE);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual([JSON.parse(readFileSync(file, 'utf8')).token, JSON.parse(readFileSync(file, 'utf8')).revision], [first, 1]);
    assert.deepEqual(inspectVariationalAsService(f.svc), { configured: true, expiresAt: iso(first), revision: 1, problem: null });
    assert.deepEqual(writeVariationalAsService(f.svc, first), { written: false, replaces: false, reason: '本服务已是同一个 Var token', revision: 1, expiresAt: iso(first) });
    assert.deepEqual(writeVariationalAsService(f.svc, second), { written: true, replaces: true, reason: null, revision: 2, expiresAt: iso(second) });
    const older = writeVariationalAsService(f.svc, first);
    assert.deepEqual([older.written, older.revision], [false, 2]);
    assert.match(older.reason ?? '', /不早于工作台的/);
    // A bad file of the service account is replaced; a link is not.
    writeFileSync(file, 'not json', { mode: 0o600 });
    assert.deepEqual(writeVariationalAsService(f.svc, first).revision, 1);
    rmSync(file); writeFileSync(join(f.root, 'target.json'), saved(second), { mode: 0o600 });
    symlinkSync(join(f.root, 'target.json'), file);
    assert.throws(() => writeVariationalAsService(f.svc, first), /不是普通文件（符号链接等），未改动/);
    assert.equal(readFileSync(join(f.root, 'target.json'), 'utf8'), saved(second));
    // The writer itself: refuses an expired token or anything but {token}, without quoting stdin.
    const writer = join(import.meta.dirname, '..', 'src', 'monitor', 'variational-import-writer.ts');
    rmSync(file);
    for (const input of [JSON.stringify({ token: fakeVariationalToken(Date.now() + 5_000, 'gone') }), JSON.stringify({ token: first, extra: 1 }), `{"token":"${first}"`]) {
      const run = spawnSync(process.execPath, [writer, 'write', '--data-dir', f.svc], { input, encoding: 'utf8' });
      assert.notEqual(run.status, 0);
      noToken(run.stderr + run.stdout, first);
    }
    assert.throws(() => statSync(file), /ENOENT/);
  } finally { f.done(); }
});

test('运行中的会话：文件被换成新 token 时下一次取用即换上并记日志；无效或删掉时保留内存中的；换上的 token 版本号不重复；页面保存与导入交错时后保存者在后；判断后文件被改动则放弃写入', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-var-refresh-'));
  const T0 = Date.UTC(2026, 10, 14, 9, 0, 7);
  const logs: string[] = [];
  try {
    const venues = fakeAnthropicVenues({ now: () => T0 });
    const session = createVariationalSession({ dir, fetcher: venues.variationalFetch, now: () => T0, log: line => logs.push(line) });
    assert.equal(session.current().token, null);
    const imported = fakeVariationalToken(T0 + DAY, 'imported');
    await writeVariationalSessionFile(join(dir, VARIATIONAL_SESSION_FILE), { version: 1, revision: 1, token: imported, updatedAt: new Date(T0).toISOString() });
    assert.deepEqual([session.current().token, session.current().revision, session.view().status], [imported, 1, 'ready']);
    assert.deepEqual(logs, [`行情监控：已载入数据目录中的 Var token（版本 1，声明到期 ${iso(imported)}）`]);
    // The page's own save: a later revision, no re-read logged.
    const typed = fakeVariationalToken(T0 + 2 * DAY, 'typed');
    await session.update({ token: typed, revision: 1 });
    assert.deepEqual([session.current().token, session.view().revision], [typed, 2]);
    assert.equal(logs.filter(line => line.includes('已载入')).length, 1);
    // A bad file (wrong mode) or none: the token in memory stays; logged once each.
    const file = join(dir, VARIATIONAL_SESSION_FILE);
    chmodSync(file, 0o644);
    writeFileSync(file, saved(imported, 9));
    assert.equal(session.current().token, typed);
    assert.equal(logs.filter(line => line.includes('权限不是 600')).length, 1);
    rmSync(file);
    assert.equal(session.current().token, typed);
    assert.equal(logs.at(-1), '行情监控：Var token 文件已被删除，继续用内存中的 token。');
    // The import writes revision 1 over a deleted file: taken on under a revision above any used (readers key results by it).
    const second = fakeVariationalToken(T0 + 3 * DAY, 'second');
    await writeVariationalSessionFile(file, { version: 1, revision: 1, token: second, updatedAt: new Date(T0).toISOString() });
    assert.deepEqual([session.current().token, session.current().revision], [second, 3]);
    // An import landing while the page's save asks Variational: the save comes after it, under a later revision, and its own
    // write does not pass for a re-read (the next import after it is still taken on).
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const slow = createVariationalSession({ dir, fetcher: async (href, init) => { await gate; return venues.variationalFetch(href, init); }, now: () => T0 + 10_000, log: line => logs.push(line) });
    assert.equal(slow.current().revision, 1);
    const typed2 = fakeVariationalToken(T0 + 4 * DAY, 'typed2'), raced = fakeVariationalToken(T0 + 5 * DAY, 'raced');
    const saving = slow.update({ token: typed2, revision: 1 });
    await new Promise(resolve => setImmediate(resolve));
    await writeVariationalSessionFile(file, { version: 1, revision: 2, token: raced, updatedAt: new Date(T0).toISOString() });
    assert.deepEqual([slow.current().token, slow.current().revision], [raced, 2]);
    release();
    assert.equal((await saving).revision, 3);
    assert.deepEqual([slow.current().token, JSON.parse(readFileSync(file, 'utf8')).revision], [typed2, 3]);
    const third = fakeVariationalToken(T0 + 6 * DAY, 'third');
    await writeVariationalSessionFile(file, { version: 1, revision: 4, token: third, updatedAt: new Date(T0).toISOString() });
    assert.equal(slow.current().token, third);
    // A writer that read the file before someone else replaced it gives up rather than overwrite.
    const stale = variationalFileIdentity(file);
    await writeVariationalSessionFile(file, { version: 1, revision: 5, token: typed, updatedAt: new Date(T0).toISOString() });
    await assert.rejects(writeVariationalSessionFile(file, { version: 1, revision: 5, token: second, updatedAt: new Date(T0).toISOString() }, stale), /在判断后被改动/);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).token, typed);
    noToken(logs.join('\n'), imported, typed, second, typed2, raced, third);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('导入助手：预览列出 Var token；勾选后写入、不改配置不重启；再导入同一个时说明不导入；读取失败给原因；token 不进结果与日志', async () => {
  const f = fixture();
  try {
    const token = fakeVariationalToken(Date.now() + DAY, 'helper');
    f.put(saved(token));
    const conf = join(f.root, 'conf'), dir = join(f.root, 'import');
    for (const path of [conf, dir, join(f.root, 'proc')]) mkdirSync(path, { recursive: true });
    writeFileSync(join(f.root, 'workbench.env'), `DATA_DIR=${f.wb}\n`);
    const configFile = join(conf, 'config.json'), secretsFile = join(conf, 'secrets.json');
    const config = fileText({ secretsFile, pairs: [], monitor: { anthropic: {}, oil: {}, goldoil: {}, hynix: {}, perpetual: {} } });
    writeFileSync(secretsFile, fileText({ accounts: {} }), { mode: 0o600 });
    writeFileSync(configFile, config, { mode: 0o600 });
    const restarts: number[] = [], logs: string[] = [];
    const base = { dir, configFile, dataDir: f.svc, workbenchEnv: join(f.root, 'workbench.env'), log: (line: string) => { logs.push(line); }, checkConfig: () => 'ok', procDir: join(f.root, 'proc'),
      restart: async () => { restarts.push(1); return true; } };
    const run = async (body: unknown, options: Partial<Parameters<typeof runImportHelper>[0]> = {}) => {
      submitImportRequest(dir, body);
      await runImportHelper({ ...base, ...options });
      return { result: readImportResult(dir)!, text: readFileSync(join(dir, 'result.json'), 'utf8') };
    };

    const shown = await run({ action: 'preview' });
    assert.equal(shown.result.phase, 'done', shown.result.message);
    assert.match(shown.result.message, /Var token 可以导入/);
    assert.deepEqual([shown.result.monitorVariational?.status, shown.result.monitorVariational?.workbenchExpiresAt, shown.result.monitorVariational?.current?.configured], ['added', iso(token), false]);
    noToken(shown.text, token);

    const failed = await run({ action: 'import', monitor: true, monitorVariational: true }, { writeVariational: () => { throw new Error('写入 Var token 失败，原有 token 未改动：磁盘已满'); } });
    assert.equal(failed.result.phase, 'failed');
    assert.match(failed.result.message, /磁盘已满；配置未改动，本次没有导入任何内容，可重试/);

    const done = await run({ action: 'import', monitor: true, monitorVariational: true });
    assert.equal(done.result.phase, 'done', done.result.message);
    assert.match(done.result.message, /^已导入Var token（版本 1，声明到期 .*）；配置未改动，未重启服务，行情监控下一次读取即用导入的 Var token$/);
    assert.equal(JSON.parse(readFileSync(join(f.svc, VARIATIONAL_SESSION_FILE), 'utf8')).token, token);
    assert.deepEqual([restarts.length, readFileSync(configFile, 'utf8')], [0, config]);
    noToken(done.text, token);

    const again = await run({ action: 'import', monitor: true, monitorVariational: true });
    assert.equal(again.result.phase, 'failed');
    assert.match(again.result.message, /行情监控与Var token都不能导入，配置未改动/);
    assert.match(again.result.monitorVariational?.detail ?? '', /声明到期与工作台的相同（.*多半是同一个 token），保留本服务的/);

    // Decided at write time: the preview's view said yes, the file then said no.
    rmSync(join(f.svc, VARIATIONAL_SESSION_FILE));
    const raced = await run({ action: 'import', monitor: true, monitorVariational: true }, { writeVariational: () => ({ written: false, replaces: false, reason: '本服务已是同一个 Var token', revision: 3, expiresAt: iso(token) }) });
    assert.equal(raced.result.phase, 'done', raced.result.message);
    assert.match(raced.result.message, /^未写入 Var token：本服务已是同一个 Var token；配置未改动，未重启服务$/);

    // The config changes (the monitor comes on) and the writer then declines: the answer does not claim the token.
    writeFileSync(configFile, fileText({ secretsFile, pairs: [] }), { mode: 0o600 });
    const declined = await run({ action: 'import', monitor: true, monitorVariational: true }, { writeVariational: () => ({ written: false, replaces: false, reason: '本服务已是同一个 Var token', revision: 3, expiresAt: iso(token) }) });
    assert.equal(declined.result.phase, 'done', declined.result.message);
    assert.match(declined.result.message, /^已导入 行情监控，服务已重启。行情监控已生效[^]*。未写入 Var token：本服务已是同一个 Var token$/);
    assert.deepEqual([declined.result.monitorVariational?.status, declined.result.monitorVariational?.detail], ['skipped', '本服务已是同一个 Var token']);
    assert.equal(restarts.length, 1);

    // The monitor directory is a link: not read, the reason is answered and nothing comes over.
    rmSync(f.dir, { recursive: true });
    symlinkSync(f.svc, f.dir);
    const unread = await run({ action: 'import', monitor: true, monitorVariational: true });
    assert.equal(unread.result.phase, 'failed');
    assert.match(unread.result.monitorVariationalError ?? '', /不是目录（符号链接等），不读取/);
    assert.ok(unread.result.notes?.some(note => note.startsWith('Var token 未导入：')));
    noToken(logs.join('\n'), token);
  } finally { f.done(); }
});

test('命令行：--monitor-variational 须带本服务数据目录；带上时导入并只输出到期时间', () => {
  const f = fixture();
  try {
    const token = fakeVariationalToken(Date.now() + DAY, 'cli');
    f.put(saved(token));
    writeFileSync(join(f.root, 'workbench.env'), `DATA_DIR=${f.wb}\n`);
    const cli = join(import.meta.dirname, '..', 'src', 'service', 'import-workbench.ts');
    const args = ['--config', join(f.root, 'config.json'), '--workbench-env', join(f.root, 'workbench.env'), '--monitor-variational'];
    const bare = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.notEqual(bare.status, 0);
    assert.match(bare.stderr, /--monitor-variational 需要 --data-dir/);
    const run = spawnSync(process.execPath, [cli, ...args, '--data-dir', f.svc], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /启用行情监控 .*原油价差/);
    assert.match(run.stdout, new RegExp(`已写入Var token（版本 1，声明到期 ${iso(token).replace(/[.]/g, '\\.')}），行情监控下一次读取即用它`));
    noToken(run.stdout + run.stderr, token);
  } finally { f.done(); }
});
