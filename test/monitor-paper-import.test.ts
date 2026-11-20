// M-5e2 (docs/monitor.md): the workbench's paper records come over through a pending file the service merges; the import
// never writes perpetual-paper-positions.json itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PERPETUAL_PAPER_LIMITS, type PerpetualPaperState } from '../src/vendor/perpetual-paper.ts';
import { PERPETUAL_PAPER_FILE, PERPETUAL_PAPER_IMPORT_FILE, PERPETUAL_PAPER_LOADING_FILE, PERPETUAL_PAPER_REJECTED_FILE, mergePerpetualPaperImport, openPerpetualPaperStore, perpetualPaperAdoptionLine, planPerpetualPaperImport, summarizePerpetualPaper } from '../src/monitor/perpetual-paper-store.ts';
import { inspectServicePaper, writeImportedPaper } from '../src/monitor/perpetual-paper-import-writer.ts';
import { inspectPaperAsService, paperInput, planMonitorPaper, readWorkbenchPaper, writePaperAsService } from '../src/service/import-monitor-paper.ts';
import { fileText } from '../src/service/import-workbench.ts';
import { parseImportBody, readImportResult, submitImportRequest } from '../src/service/import-channel.ts';
import { runImportHelper } from '../src/service/import-helper.ts';
import { paperPosition, paperState } from './monitor-paper-fixture.ts';

const DAY = 86_400_000;
const NOW = Date.now();
const text = (state: PerpetualPaperState) => `${JSON.stringify(state)}\n`;
const read = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as PerpetualPaperState;
const ids = (state: PerpetualPaperState) => state.positions.map(position => position.id);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tp-paper-import-'));
  const wb = join(root, 'wb'), dir = join(wb, 'modules', 'monitor'), svc = join(root, 'svc');
  for (const path of [join(dir, 'perpetual'), svc]) mkdirSync(path, { recursive: true });
  const source = join(dir, 'perpetual', 'paper-positions.json');
  const put = (content: string) => { rmSync(source, { force: true }); writeFileSync(source, content, { mode: 0o644 }); };
  return { root, wb, dir, svc, source, put, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('读取工作台：没有 Monitor 目录、没有文件、过大、链接、坏 JSON、校验不过各给原因，不带内容；有效的原样读出', () => {
  const f = fixture();
  try {
    const empty = join(f.root, 'empty');
    mkdirSync(empty);
    assert.deepEqual(readWorkbenchPaper(empty), { state: null, problem: '工作台没有 Monitor 模块' });
    assert.deepEqual(readWorkbenchPaper(f.wb), { state: null, problem: '工作台没有持仓记录' });
    const state = paperState([paperPosition('a1'), paperPosition('s1', { closedAt: NOW - DAY })], 7);
    f.put(text(state));
    assert.deepEqual(readWorkbenchPaper(f.wb), { state });
    f.put('{"version":1,"secret-looking":');
    assert.deepEqual(readWorkbenchPaper(f.wb), { state: null, problem: 'perpetual/paper-positions.json 不是有效的 JSON' });
    f.put(JSON.stringify({ version: 1, revision: 1, positions: [{ id: 'quoted-content' }] }));
    const invalid = readWorkbenchPaper(f.wb);
    assert.deepEqual(invalid, { state: null, problem: 'perpetual/paper-positions.json 未通过工作台的持仓记录校验，不导入' });
    f.put(' '.repeat(PERPETUAL_PAPER_LIMITS.fileBytes + 1));
    assert.match((readWorkbenchPaper(f.wb) as { problem: string }).problem, /超过 1 MB/);
    rmSync(f.source); writeFileSync(join(f.root, 'elsewhere.json'), text(state)); symlinkSync(join(f.root, 'elsewhere.json'), f.source);
    assert.match((readWorkbenchPaper(f.wb) as { problem: string }).problem, /不是普通文件（符号链接等），不读取/);
    rmSync(join(f.dir, 'perpetual'), { recursive: true }); symlinkSync(f.root, join(f.dir, 'perpetual'));
    assert.match((readWorkbenchPaper(f.wb) as { problem: string }).problem, /perpetual 不是目录/);
  } finally { f.done(); }
});

test('合并规则：已有编号跳过；已结束超过 30 天不导入；登记请求编号重复的去掉；超过上限整批不导入；没有新记录时说明', () => {
  const held = paperState([paperPosition('a1', { requestId: 'req-1' })], 4);
  const incoming = [paperPosition('a1'), paperPosition('a2', { requestId: 'req-1' }), paperPosition('s1', { closedAt: NOW - DAY, requestId: 'req-2' }), paperPosition('old', { at: NOW - 40 * DAY, closedAt: NOW - 31 * DAY })];
  const merged = mergePerpetualPaperImport(held, incoming, NOW);
  assert.deepEqual([merged.status, merged.skipped, merged.expired, merged.stripped, merged.active, merged.closed], ['add', 1, 1, 1, 2, 1]);
  assert.deepEqual(ids(merged.state!), ['a1', 'a2', 's1']);
  assert.equal(merged.state!.revision, 5);
  const [, a2, s1] = merged.state!.positions;
  assert.deepEqual([a2!.requestId, a2!.requestFingerprint, s1!.requestId], [undefined, undefined, 'req-2']);
  assert.equal(incoming[1]!.requestId, 'req-1', '不改传入的记录');

  const again = mergePerpetualPaperImport(merged.state!, incoming, NOW);
  assert.deepEqual([again.status, again.reason, again.state], ['none', '本服务已有这些记录（另有 1 条已结束超过 30 天，不导入）', null]);
  assert.equal(planPerpetualPaperImport(summarizePerpetualPaper([]), [], NOW).reason, '工作台没有持仓记录');
  assert.equal(planPerpetualPaperImport(summarizePerpetualPaper([]), [incoming[3]!], NOW).reason, '工作台的 1 条记录都已结束超过 30 天，不导入');

  const full = paperState(Array.from({ length: PERPETUAL_PAPER_LIMITS.active }, (_, i) => paperPosition(`a${i}`)));
  const over = mergePerpetualPaperImport(full, [paperPosition('extra'), paperPosition('s9', { closedAt: NOW - DAY })], NOW);
  assert.deepEqual([over.status, over.reason, over.state], ['rejected', `导入后活动持仓 ${PERPETUAL_PAPER_LIMITS.active + 1} 个，超过上限 ${PERPETUAL_PAPER_LIMITS.active} 个，整批不导入`, null]);
  const closed = paperState(Array.from({ length: PERPETUAL_PAPER_LIMITS.closed }, (_, i) => paperPosition(`s${i}`, { closedAt: NOW - DAY })));
  assert.match(mergePerpetualPaperImport(closed, [paperPosition('s-new', { closedAt: NOW - DAY })], NOW).reason, /导入后已结束记录 101 条，超过上限 100 条，整批不导入/);
});

test('写入方：只写 600 的待载入文件、不碰持仓记录；与已有待载入文件合并；没有新记录或超过上限不写；拒写链接与坏的待载入文件', () => {
  const f = fixture();
  try {
    const records = join(f.svc, PERPETUAL_PAPER_FILE), pending = join(f.svc, PERPETUAL_PAPER_IMPORT_FILE);
    assert.deepEqual(inspectServicePaper(f.svc), { active: 0, closed: 0, pending: 0, ids: [] });
    writeFileSync(records, text(paperState([paperPosition('a1', { requestId: 'req-1' })], 3)), { mode: 0o600 });
    const before = readFileSync(records, 'utf8');
    const workbench = paperState([paperPosition('a1'), paperPosition('a2', { requestId: 'req-1' })]);
    const first = writeImportedPaper(f.svc, workbench, NOW);
    assert.deepEqual(first, { written: true, reason: null, added: 1, pending: 1, skipped: 1, expired: 0, stripped: 1, active: 2, closed: 0 });
    assert.equal(statSync(pending).mode & 0o777, 0o600);
    assert.deepEqual([ids(read(pending)), read(pending).revision, read(pending).positions[0]!.requestId], [['a2'], 1, undefined]);
    assert.equal(readFileSync(records, 'utf8'), before, '持仓记录本身不写');
    assert.deepEqual(inspectServicePaper(f.svc), { active: 2, closed: 0, pending: 1, ids: ['a1', 'a2'] });

    const second = writeImportedPaper(f.svc, paperState([paperPosition('a2'), paperPosition('s1', { closedAt: NOW - DAY })]), NOW);
    assert.deepEqual([second.written, second.added, second.pending, second.skipped, second.active, second.closed], [true, 1, 2, 1, 2, 1]);
    assert.deepEqual([ids(read(pending)), read(pending).revision], [['a2', 's1'], 2]);
    const same = writeImportedPaper(f.svc, workbench, NOW);
    assert.deepEqual([same.written, same.reason], [false, '本服务已有这些记录']);
    const over = writeImportedPaper(f.svc, paperState(Array.from({ length: PERPETUAL_PAPER_LIMITS.active }, (_, i) => paperPosition(`n${i}`))), NOW);
    assert.deepEqual([over.written, over.reason], [false, `导入后活动持仓 ${PERPETUAL_PAPER_LIMITS.active + 2} 个，超过上限 ${PERPETUAL_PAPER_LIMITS.active} 个，整批不导入`]);
    assert.deepEqual(ids(read(pending)), ['a2', 's1'], '不写时待载入文件不变');
    assert.throws(() => writeImportedPaper(f.svc, { version: 1, revision: 1, positions: [{}] }, NOW), /^Error: 传入的持仓记录未通过校验$/);

    // A pending file that is not valid is not overwritten; links are not followed.
    const kept = readFileSync(pending, 'utf8');
    writeFileSync(pending, 'not json', { mode: 0o600 });
    assert.throws(() => writeImportedPaper(f.svc, paperState([paperPosition('z1')]), NOW), /已有的待载入文件 perpetual-paper-positions\.import\.json 不是有效的 JSON，未改动；删除它后重试/);
    rmSync(pending); writeFileSync(join(f.root, 'target.json'), kept); symlinkSync(join(f.root, 'target.json'), pending);
    assert.throws(() => writeImportedPaper(f.svc, paperState([paperPosition('z1')]), NOW), /不是普通文件（符号链接等），未改动/);
    assert.equal(readFileSync(join(f.root, 'target.json'), 'utf8'), kept);
    rmSync(pending); rmSync(records); symlinkSync(join(f.root, 'target.json'), records);
    assert.throws(() => writeImportedPaper(f.svc, paperState([paperPosition('z1')]), NOW), /不是普通文件（符号链接等），未改动/);
    rmSync(records); writeFileSync(records, 'broken', { mode: 0o600 });
    assert.throws(() => inspectServicePaper(f.svc), /本服务的 perpetual-paper-positions\.json 不是有效的 JSON，未写入/);
    rmSync(records);

    // Through the subprocess (as the data directory's owner, here the current account), and its refusals of stdin.
    assert.deepEqual(writePaperAsService(f.svc, paperState([paperPosition('p1')])), { written: true, reason: null, added: 1, pending: 1, skipped: 0, expired: 0, stripped: 0, active: 1, closed: 0 });
    assert.deepEqual(inspectPaperAsService(f.svc), { active: 1, closed: 0, pending: 1, ids: ['p1'] });
    const writer = join(import.meta.dirname, '..', 'src', 'monitor', 'perpetual-paper-import-writer.ts');
    const bad = spawnSync(process.execPath, [writer, 'write', '--data-dir', f.svc], { input: '{"secret-looking":', encoding: 'utf8' });
    assert.deepEqual([bad.status, bad.stderr, bad.stdout], [1, '传入的内容不是有效的 JSON', '']);
  } finally { f.done(); }
});

test('服务打开时载入待载入文件：合并写盘、删除待载入文件；都已有时只删除；不能用的改名为 rejected，持仓记录不变', async () => {
  const f = fixture();
  try {
    const records = join(f.svc, PERPETUAL_PAPER_FILE), pending = join(f.svc, PERPETUAL_PAPER_IMPORT_FILE), rejected = join(f.svc, PERPETUAL_PAPER_REJECTED_FILE);
    writeFileSync(records, text(paperState([paperPosition('a1')], 6)), { mode: 0o600 });
    writeFileSync(pending, text(paperState([paperPosition('a2'), paperPosition('s1', { closedAt: NOW - DAY })])), { mode: 0o600 });
    const store = openPerpetualPaperStore(records, { now: () => NOW });
    assert.deepEqual(store.opened, [{ added: 2, reason: '', removed: true }]);
    assert.equal(perpetualPaperAdoptionLine(store.opened[0]!), '合约价差：已载入从工作台导入的持仓记录 2 条');
    assert.deepEqual([ids(store.get()), store.get().revision, existsSync(pending), store.pending()], [['a1', 'a2', 's1'], 7, false, false]);
    assert.deepEqual([ids(read(records)), statSync(records).mode & 0o777], [['a1', 'a2', 's1'], 0o600]);

    writeFileSync(pending, text(paperState([paperPosition('a2')])), { mode: 0o600 });
    assert.equal(store.pending(), true);
    const none = await store.adoptPending(NOW);
    assert.deepEqual(none, { added: 0, reason: '本服务已有这些记录', removed: true });
    assert.equal(perpetualPaperAdoptionLine(none!), '合约价差：待载入的持仓记录没有可载入的（本服务已有这些记录），已删除待载入文件');
    assert.deepEqual([existsSync(pending), store.get().revision], [false, 7]);
    assert.equal(await store.adoptPending(NOW), null, '没有待载入文件');

    const kept = readFileSync(records, 'utf8');
    writeFileSync(pending, text(paperState(Array.from({ length: PERPETUAL_PAPER_LIMITS.active }, (_, i) => paperPosition(`n${i}`)))), { mode: 0o600 });
    const over = await store.adoptPending(NOW);
    assert.deepEqual(over, { rejected: `导入后活动持仓 ${PERPETUAL_PAPER_LIMITS.active + 2} 个，超过上限 ${PERPETUAL_PAPER_LIMITS.active} 个，整批不导入`, renamed: true });
    assert.match(perpetualPaperAdoptionLine(over!), /未载入（导入后活动持仓 22 个[^]*待载入文件已改名为 perpetual-paper-positions\.import\.rejected\.json，perpetual-paper-positions\.json 未改动$/);
    assert.deepEqual([existsSync(pending), existsSync(rejected), readFileSync(records, 'utf8')], [false, true, kept]);

    writeFileSync(pending, 'not json', { mode: 0o600 });
    const reopened = openPerpetualPaperStore(records, { now: () => NOW });
    assert.deepEqual(reopened.opened, [{ rejected: '待载入文件不是有效的 JSON', renamed: true }]);
    assert.deepEqual([existsSync(pending), readFileSync(rejected, 'utf8'), ids(reopened.get())], [false, 'not json', ['a1', 'a2', 's1']]);
    assert.deepEqual(openPerpetualPaperStore(records).opened, []);
  } finally { f.done(); }
});

test('载入先认领待载入文件：认领后写入方新放的待载入文件不被删除或改名；中断留下的认领文件在启动时先载入', async () => {
  const f = fixture();
  try {
    const records = join(f.svc, PERPETUAL_PAPER_FILE), pending = join(f.svc, PERPETUAL_PAPER_IMPORT_FILE), loading = join(f.svc, PERPETUAL_PAPER_LOADING_FILE);
    writeFileSync(records, text(paperState([paperPosition('a1')], 4)), { mode: 0o600 });
    // An interrupted load left a claimed file (its records partly written already); the writer put a new pending file since.
    writeFileSync(loading, text(paperState([paperPosition('a1'), paperPosition('c1')])), { mode: 0o600 });
    writeFileSync(pending, text(paperState([paperPosition('c1'), paperPosition('p1')])), { mode: 0o600 });
    const store = openPerpetualPaperStore(records, { now: () => NOW });
    assert.deepEqual(store.opened, [{ added: 1, reason: '', removed: true }, { added: 1, reason: '', removed: true }], '认领文件先、待载入文件后');
    assert.deepEqual([ids(store.get()), store.get().revision, existsSync(loading), existsSync(pending)], [['a1', 'c1', 'p1'], 6, false, false]);

    // While a load holds its claim, a pending file put in place is not touched by it, and is the next load's.
    writeFileSync(loading, text(paperState([paperPosition('d1')])), { mode: 0o600 });
    writeFileSync(pending, text(paperState([paperPosition('d2')])), { mode: 0o600 });
    assert.deepEqual(await store.adoptPending(NOW), { added: 1, reason: '', removed: true });
    assert.deepEqual([ids(store.get()), existsSync(pending), store.pending()], [['a1', 'c1', 'p1', 'd1'], true, true]);
    assert.deepEqual(await store.adoptPending(NOW), { added: 1, reason: '', removed: true });
    assert.deepEqual([ids(read(records)), existsSync(pending), existsSync(loading)], [['a1', 'c1', 'p1', 'd1', 'd2'], false, false]);
  } finally { f.done(); }
});

test('写主文件失败时不改名为 rejected：保留认领文件、不再每秒重试，重启后载入', async () => {
  const f = fixture();
  try {
    const records = join(f.svc, PERPETUAL_PAPER_FILE), pending = join(f.svc, PERPETUAL_PAPER_IMPORT_FILE), loading = join(f.svc, PERPETUAL_PAPER_LOADING_FILE);
    writeFileSync(records, text(paperState([paperPosition('a1')], 2)), { mode: 0o600 });
    const store = openPerpetualPaperStore(records, { now: () => NOW });
    // The fixed temporary path taken by a directory: the write fails as a full disk would.
    mkdirSync(`${records}.tmp`);
    writeFileSync(pending, text(paperState([paperPosition('b1')])), { mode: 0o600 });
    const failed = await store.adoptPending(NOW);
    assert.ok(failed && 'deferred' in failed && failed.deferred.startsWith(`写入 ${PERPETUAL_PAPER_FILE} 失败：`), JSON.stringify(failed));
    assert.match(perpetualPaperAdoptionLine(failed), /暂未载入（写入 perpetual-paper-positions\.json 失败：.*），待载入文件保留，服务重启后再试，在此之前不载入新的导入；perpetual-paper-positions\.json 未改动$/);
    assert.deepEqual([existsSync(loading), existsSync(join(f.svc, PERPETUAL_PAPER_REJECTED_FILE)), ids(store.get()), ids(read(records))], [true, false, ['a1'], ['a1']]);
    assert.deepEqual([store.pending(), await store.adoptPending(NOW)], [false, null], '同一文件不再每秒重试');

    rmSync(`${records}.tmp`, { recursive: true });
    const restarted = openPerpetualPaperStore(records, { now: () => NOW });
    assert.deepEqual([restarted.opened, ids(restarted.get()), existsSync(loading)], [[{ added: 1, reason: '', removed: true }], ['a1', 'b1'], false]);
  } finally { f.done(); }
});

test('改名为 rejected 失败时：认领文件留着、不再每秒重试，日志写明；写入方计数算上认领文件；重启后照常处理', async () => {
  const f = fixture();
  try {
    const records = join(f.svc, PERPETUAL_PAPER_FILE), pending = join(f.svc, PERPETUAL_PAPER_IMPORT_FILE), loading = join(f.svc, PERPETUAL_PAPER_LOADING_FILE), rejected = join(f.svc, PERPETUAL_PAPER_REJECTED_FILE);
    writeFileSync(records, text(paperState([paperPosition('a1')])), { mode: 0o600 });
    const store = openPerpetualPaperStore(records, { now: () => NOW });
    // A directory where the rejected file goes, with something in it: the rename fails.
    mkdirSync(rejected); writeFileSync(join(rejected, 'x'), '');
    writeFileSync(pending, 'not json', { mode: 0o600 });
    const outcome = await store.adoptPending(NOW);
    assert.ok(outcome && 'rejected' in outcome && !outcome.renamed && outcome.rejected.startsWith('待载入文件不是有效的 JSON；改名也失败了：'), JSON.stringify(outcome));
    assert.match(perpetualPaperAdoptionLine(outcome), /待载入文件留在 perpetual-paper-positions\.import\.loading\.json，服务重启后再试，在此之前不载入新的导入，perpetual-paper-positions\.json 未改动$/);
    assert.deepEqual([existsSync(loading), store.pending(), await store.adoptPending(NOW)], [true, false, null]);

    // A claimed file kept for the next start counts as held for the writer (here a valid one with b1).
    writeFileSync(loading, text(paperState([paperPosition('b1')])), { mode: 0o600 });
    assert.deepEqual(inspectServicePaper(f.svc, NOW), { active: 2, closed: 0, pending: 0, ids: ['a1', 'b1'] });
    const written = writeImportedPaper(f.svc, paperState([paperPosition('b1'), paperPosition('b2')]), NOW);
    assert.deepEqual([written.added, written.skipped, written.active, ids(read(pending))], [1, 1, 3, ['b2']]);

    rmSync(rejected, { recursive: true });
    const restarted = openPerpetualPaperStore(records, { now: () => NOW });
    assert.deepEqual([restarted.opened.length, ids(restarted.get()), existsSync(loading), existsSync(pending)], [2, ['a1', 'b1', 'b2'], false, false]);
  } finally { f.done(); }
});

test('合并前先去掉过期的已结束记录，上限按去掉后的数目算；写入方的计数不重复算主文件已有的待载入记录', () => {
  const f = fixture();
  try {
    const expired = Array.from({ length: PERPETUAL_PAPER_LIMITS.closed }, (_, i) => paperPosition(`old${i}`, { closedAt: NOW - 29 * DAY }));
    const later = NOW + 2 * DAY;
    const merged = mergePerpetualPaperImport(paperState(expired), [paperPosition('s1', { closedAt: NOW })], later);
    assert.deepEqual([merged.status, merged.closed, merged.state && ids(merged.state)], ['add', 1, ['s1']]);

    const records = join(f.svc, PERPETUAL_PAPER_FILE), pending = join(f.svc, PERPETUAL_PAPER_IMPORT_FILE);
    writeFileSync(records, text(paperState([paperPosition('a1'), paperPosition('a2')])), { mode: 0o600 });
    // A pending file whose records were loaded but which could not be removed: a1 again, plus one not loaded yet.
    writeFileSync(pending, text(paperState([paperPosition('a1'), paperPosition('a3')])), { mode: 0o600 });
    assert.deepEqual(inspectServicePaper(f.svc, NOW), { active: 3, closed: 0, pending: 1, ids: ['a1', 'a2', 'a3'] });
    const written = writeImportedPaper(f.svc, paperState([paperPosition('a4')]), NOW);
    assert.deepEqual([written.active, written.pending, ids(read(pending))], [4, 2, ['a3', 'a4']]);
  } finally { f.done(); }
});

test('计划：须有行情监控与合约价差；本服务现有记录读不出时交给写入方；导入请求须和 monitor 一起', () => {
  const state = paperState([paperPosition('a1'), paperPosition('s1', { closedAt: NOW - DAY }), paperPosition('old', { at: NOW - 40 * DAY, closedAt: NOW - 31 * DAY })]);
  const input = { source: { state }, current: { active: 0, closed: 0, pending: 0, ids: ['a1'] }, currentError: null };
  const monitor = { monitor: { perpetual: {} } };
  assert.equal(planMonitorPaper(input, {}).item.detail, '行情监控未启用，持仓记录不导入');
  assert.equal(planMonitorPaper(input, { monitor: { oil: {} } }).item.detail, '本服务的行情监控没有合约价差，持仓记录不导入');
  const planned = planMonitorPaper(input, monitor, NOW);
  assert.deepEqual([planned.item.status, planned.item.added, planned.item.workbench, planned.item.detail, planned.write?.state], ['added', 1, { active: 1, closed: 2 }, '导入 1 条持仓记录（活动 0 条、已结束 1 条），1 条本服务已有，1 条已结束超过 30 天不导入', state]);
  const blind = planMonitorPaper(paperInput({ state }, '/nowhere', () => { throw new Error('读不出'); }), monitor, NOW);
  assert.deepEqual([blind.item.status, blind.item.added, blind.item.current], ['added', 2, null]);
  assert.match(blind.item.detail, /；本服务现有记录读不出（读不出），写入时再判断$/);
  assert.equal(planMonitorPaper({ source: { state: null, problem: '工作台没有持仓记录' }, current: null, currentError: null }, monitor).item.detail, '工作台没有持仓记录');

  assert.throws(() => parseImportBody({ action: 'import', monitorPaper: true }), /monitorPaper 只能是 true，且须和 monitor 一起使用/);
  assert.throws(() => parseImportBody({ action: 'import', monitor: true, monitorPaper: 1 }), /monitorPaper 只能是 true/);
  assert.equal(parseImportBody({ action: 'import', monitor: true, monitorPaper: true }).monitorPaper, true);
});

test('导入助手：预览列出持仓记录；勾选后写待载入文件、不改配置不重启；再导入时说明本服务已有；写入方不写时如实回答', async () => {
  const f = fixture();
  try {
    f.put(text(paperState([paperPosition('a1'), paperPosition('s1', { closedAt: NOW - DAY })])));
    const conf = join(f.root, 'conf'), dir = join(f.root, 'import');
    for (const path of [conf, dir, join(f.root, 'proc')]) mkdirSync(path, { recursive: true });
    writeFileSync(join(f.root, 'workbench.env'), `DATA_DIR=${f.wb}\n`);
    const configFile = join(conf, 'config.json'), secretsFile = join(conf, 'secrets.json');
    const config = fileText({ secretsFile, pairs: [], monitor: { anthropic: {}, oil: {}, goldoil: {}, hynix: {}, perpetual: {} } });
    writeFileSync(secretsFile, fileText({ accounts: {} }), { mode: 0o600 });
    writeFileSync(configFile, config, { mode: 0o600 });
    const restarts: number[] = [];
    const base = { dir, configFile, dataDir: f.svc, workbenchEnv: join(f.root, 'workbench.env'), log: () => undefined, checkConfig: () => 'ok', procDir: join(f.root, 'proc'),
      restart: async () => { restarts.push(1); return true; } };
    const run = async (body: unknown, options: Partial<Parameters<typeof runImportHelper>[0]> = {}) => {
      submitImportRequest(dir, body);
      await runImportHelper({ ...base, ...options });
      return readImportResult(dir)!;
    };

    const shown = await run({ action: 'preview' });
    assert.equal(shown.phase, 'done', shown.message);
    assert.match(shown.message, /持仓记录可以导入 2 条/);
    assert.deepEqual([shown.monitorPaper?.status, shown.monitorPaper?.workbench, shown.monitorPaper?.current], ['added', { active: 1, closed: 1 }, { active: 0, closed: 0, pending: 0 }]);

    const done = await run({ action: 'import', monitor: true, monitorPaper: true });
    assert.equal(done.phase, 'done', done.message);
    assert.equal(done.message, '已导入持仓记录 2 条；配置未改动，未重启服务，行情监控下一次检查时载入导入的持仓记录（合约价差采集关闭时在下次开启时）');
    assert.match(done.monitorPaper?.detail ?? '', /^导入 2 条持仓记录；写入待载入文件/);
    assert.deepEqual(ids(read(join(f.svc, PERPETUAL_PAPER_IMPORT_FILE))), ['a1', 's1']);
    assert.deepEqual([restarts.length, readFileSync(configFile, 'utf8'), existsSync(join(f.svc, PERPETUAL_PAPER_FILE))], [0, config, false]);

    const again = await run({ action: 'import', monitor: true, monitorPaper: true });
    assert.equal(again.phase, 'failed');
    assert.match(again.message, /持仓记录都不能导入，配置未改动/);
    assert.equal(again.monitorPaper?.detail, '本服务已有这些记录');

    rmSync(join(f.svc, PERPETUAL_PAPER_IMPORT_FILE));
    const raced = await run({ action: 'import', monitor: true, monitorPaper: true }, { writePaper: () => ({ written: false, reason: '本服务已有这些记录', added: 0, pending: 0, skipped: 2, expired: 0, stripped: 0, active: 1, closed: 1 }) });
    assert.equal(raced.phase, 'done', raced.message);
    assert.equal(raced.message, '未写入持仓记录：本服务已有这些记录；配置未改动，未重启服务');
    assert.deepEqual([raced.monitorPaper?.status, raced.monitorPaper?.detail], ['skipped', '本服务已有这些记录']);

    const failed = await run({ action: 'import', monitor: true, monitorPaper: true }, { writePaper: () => { throw new Error('写入待载入的持仓记录失败，本服务的持仓记录未改动：磁盘已满'); } });
    assert.equal(failed.phase, 'failed');
    assert.match(failed.message, /磁盘已满/);
    assert.equal(restarts.length, 0);
  } finally { f.done(); }
});

test('命令行：--monitor-paper 须带本服务数据目录；带上时写待载入文件', () => {
  const f = fixture();
  try {
    f.put(text(paperState([paperPosition('a1')])));
    writeFileSync(join(f.root, 'workbench.env'), `DATA_DIR=${f.wb}\n`);
    const cli = join(import.meta.dirname, '..', 'src', 'service', 'import-workbench.ts');
    const args = ['--config', join(f.root, 'config.json'), '--workbench-env', join(f.root, 'workbench.env'), '--monitor-paper'];
    const bare = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.notEqual(bare.status, 0);
    assert.match(bare.stderr, /--monitor-paper 需要 --data-dir/);
    const run = spawnSync(process.execPath, [cli, ...args, '--data-dir', f.svc], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /导入 1 条持仓记录（活动 1 条、已结束 0 条）/);
    assert.match(run.stdout, /已写入持仓记录 1 条（待载入文件），行情监控下一次检查时载入/);
    assert.deepEqual(ids(read(join(f.svc, PERPETUAL_PAPER_IMPORT_FILE))), ['a1']);
    const again = spawnSync(process.execPath, [cli, ...args, '--data-dir', f.svc], { encoding: 'utf8' });
    assert.match(again.stdout, /跳过持仓记录：本服务已有这些记录/);
  } finally { f.done(); }
});
