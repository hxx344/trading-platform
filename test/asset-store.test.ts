// The service's asset reads: "not imported" answers before the first import, the imported ledger read through the
// copied workbench functions after it, and an import picked up by a reader that is already open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ASSET_DB_FILE, openAssetDb, SNAPSHOT_CLOSED } from '../src/asset/db.ts';
import { importLedger } from '../src/asset/import.ts';
import { createAssetStore, parseImportInfo } from '../src/asset/store.ts';
import { notImported } from '../src/asset/views.ts';
import { parseServiceConfig } from '../src/service/config.ts';
import { assetSummary } from '../src/service/asset-config.ts';
import { OTHER_OWNER, OWNER, dayBefore, writeWorkbenchLedger } from './asset-fixture.ts';

const NOW = Date.parse('2026-11-10T04:00:00Z');
const TODAY = '2026-11-10';

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'tp-asset-store-'));
  const from = join(root, 'ledger.sqlite'), dataDir = join(root, 'data');
  writeWorkbenchLedger(from, { now: NOW });
  const reader = createAssetStore(join(dataDir, ASSET_DB_FILE), { now: () => NOW });
  const load = (owner = OWNER) => importLedger({ from, owner, dataDir, now: () => NOW });
  return { root, from, dataDir, reader, load, done: () => { reader.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('资产读取：未导入时每个接口都给空数据并标明 imported:false', async () => {
  const w = workspace();
  try {
    assert.deepEqual(await w.reader.state(), notImported.state());
    assert.deepEqual(await w.reader.ledger(), notImported.ledger(TODAY));
    assert.deepEqual(await w.reader.history(), notImported.history(TODAY));
    assert.deepEqual(await w.reader.withdrawals(), notImported.withdrawals());
    assert.deepEqual(await w.reader.cashFlows(), notImported.cashFlows());
    assert.deepEqual(await w.reader.dailyChanges(), { imported: false, importedAt: null, today: TODAY, windowStart: '2026-08-13', days: [] });
    assert.deepEqual(await w.reader.period('P1'), { imported: false, importedAt: null, rows: [] });
    // An empty file of a crashed first import (no tables yet) reads as not imported too.
    const empty = mkdtempSync(join(tmpdir(), 'tp-asset-empty-'));
    new DatabaseSync(join(empty, ASSET_DB_FILE)).close();
    const reader = createAssetStore(join(empty, ASSET_DB_FILE), { now: () => NOW });
    try { assert.equal((await reader.state()).imported, false); } finally { reader.close(); rmSync(empty, { recursive: true, force: true }); }
  } finally { w.done(); }
});

test('资产读取：导入后各接口按工作台口径给出账本、历史、每日变化、出金与资金流', async () => {
  const w = workspace();
  try {
    w.load();
    const importedAt = new Date(NOW).toISOString();
    const state = await w.reader.state();
    assert.deepEqual(state, { imported: true, importedAt, source: { file: 'ledger.sqlite', owner: OWNER }, dataKind: 'personal', assets: 6,
      snapshots: { count: 9, first: dayBefore(NOW, 9), last: dayBefore(NOW, 1), archived: 1 } });

    const ledger = await w.reader.ledger();
    assert.equal(ledger.imported, true);
    assert.equal(ledger.today, TODAY);
    // The registered withdrawal is shown as one more row, the way assetDisplayRows does in the workbench.
    assert.equal(ledger.rows.length, 7);
    assert.equal(ledger.rows.filter(row => row.project.trim() === '出金').reduce((sum, row) => sum + (row.value ?? 0), 0), 800);
    assert.deepEqual(ledger.rows.map(row => row.value), [...ledger.rows.map(row => row.value)].sort((a, b) => (b ?? 0) - (a ?? 0)), '按估值从高到低');
    const summary = ledger.summary!;
    assert.equal(summary.valuation.total, 13_600 + 6_200 + 3_000 + 750 + 200 + 500);
    assert.equal(summary.exchanges.total, 13_600 + 6_200);
    assert.deepEqual(summary.byExchange.map(item => [item.mode, item.total, item.rows]), [['bybit', 13_600, 1], ['aster', 6_200, 1]]);
    assert.equal(summary.points.total, 200);
    assert.equal(summary.withdrawals.total, 500);
    assert.equal(ledger.ledger!.fx, 7.1);
    assert.equal(ledger.ledger!.withdrawals.length, 1);
    assert.ok(Object.values(ledger.ledger!.connections).every(connection => connection.configured === false && connection.label === undefined), '命令行导入不带连接，连接一律显示未配置、没有尾号');
    assert.equal(ledger.ledger!.asterAccounts.length, 1);
    assert.ok(!('walletAddress' in ledger.ledger!.asterAccounts[0]!));

    const history = await w.reader.history();
    assert.deepEqual(history.periods.map(period => period.id).slice(0, 3), [`daily-${dayBefore(NOW, 1)}`, `daily-${dayBefore(NOW, 2)}`, `daily-${dayBefore(NOW, 3)}`]);
    assert.ok(history.periods.some(period => period.id === 'P1') && history.periods.some(period => period.archived && !period.included), '原表期次与导入前记录都在，导入前记录不进曲线');
    assert.ok(history.trend.length >= 10, '曲线含原表期次与每日快照');
    assert.ok(history.trend.every(point => Number.isFinite(point.adjusted)));
    assert.ok(history.annualized, '有年化指标');

    const daily = await w.reader.dailyChanges();
    assert.equal(daily.imported, true);
    assert.equal(daily.today, TODAY);
    assert.ok(daily.days.length >= 8, '每个有快照的日子都有一行');

    const withdrawals = await w.reader.withdrawals();
    assert.deepEqual(withdrawals.withdrawals.map(item => [item.date, item.amount]), [[dayBefore(NOW, 5), 300]]);
    assert.equal(withdrawals.embedded.total, 500);

    const flows = await w.reader.cashFlows();
    assert.equal(flows.audit.length, 3, '审计历史含全部版本');
    assert.deepEqual(flows.evidence.map(row => [row.amount, row.status]), [['1000', 'external']], '作废的不计入');
    assert.deepEqual(flows.voided.map(row => row.amount), ['-200']);

    assert.equal((await w.reader.period('P1'))!.rows.length, 6);
    assert.equal((await w.reader.period(`daily-${dayBefore(NOW, 2)}`))!.rows.length, 6);
    assert.deepEqual((await w.reader.period('archive-0f1e2d3c-4b5a-4968-8776-655443322110-1'))!.rows, []);
    assert.equal(await w.reader.period('P9'), null);
    assert.equal(await w.reader.period('daily-2030-01-01'), null);
  } finally { w.done(); }
});

test('资产读取：服务先启动后导入、再次导入换用户，已打开的读取都能看到新数据', async () => {
  const w = workspace();
  try {
    assert.equal((await w.reader.state()).imported, false);
    w.load();
    assert.equal((await w.reader.state()).source!.owner, OWNER);
    w.load(OTHER_OWNER);
    const state = await w.reader.state();
    assert.deepEqual([state.source!.owner, state.assets, state.snapshots.count], [OTHER_OWNER, 1, 1]);
    assert.equal((await w.reader.ledger()).rows.length, 1);
  } finally { w.done(); }
});

test('资产读取：导入记录损坏时读取报错，不当作未导入', async () => {
  assert.throws(() => parseImportInfo('{"importedAt":1}'), /import-info/);
  assert.deepEqual(parseImportInfo(JSON.stringify({ importedAt: 'x', file: 'f', owner: 'o', assets: '3', settings: ['a', 1] })), { importedAt: 'x', file: 'f', owner: 'o', assets: 3, snapshots: 0, settings: ['a'] });
  const w = workspace();
  try {
    w.load();
    const db = new DatabaseSync(join(w.dataDir, ASSET_DB_FILE));
    db.prepare("DELETE FROM settings WHERE key = 'source-ledger'").run();
    db.close();
    await assert.rejects(w.reader.ledger(), /缺少原表数据/);
  } finally { w.done(); }
});

/**
 * Runs `commit` right before the statement that follows the next import-info read, on whatever connection: an import by
 * another process landing between the metadata and the data of one answer (issue #11).
 */
function commitAfterImportInfo(commit: () => void) {
  const original = DatabaseSync.prototype.prepare;
  let armed = false, fired = false;
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, ...args: Parameters<typeof original>) {
    if (armed) { armed = false; fired = true; commit(); }
    else if (!fired && /^SELECT value FROM settings WHERE key = 'import-info'$/.test(args[0])) armed = true;
    return original.apply(this, args);
  } as typeof original;
  return { fired: () => fired, restore: () => { DatabaseSync.prototype.prepare = original; } };
}

test('资产读取：另一连接在导入记录与数据之间提交整体替换，每个接口只给完整的一代（#11）', async () => {
  const w = workspace();
  try {
    const later = NOW + 60_000;
    const a = new Date(NOW).toISOString(), b = new Date(later).toISOString();
    const loadA = () => importLedger({ from: w.from, owner: OWNER, dataDir: w.dataDir, now: () => NOW });
    const loadB = () => importLedger({ from: w.from, owner: OTHER_OWNER, dataDir: w.dataDir, now: () => later });
    const kept = `daily-${dayBefore(NOW, 2)}`;
    // Each answer names its generation (importedAt) and carries data that differs between ledger A (alice) and B (bob).
    const reads: [string, () => Promise<unknown>, (answer: any) => [string | null, unknown]][] = [
      ['state', () => w.reader.state(), s => [s.importedAt, [s.source.owner, s.assets, s.snapshots.count]]],
      ['ledger', () => w.reader.ledger(), l => [l.importedAt, l.rows.length]],
      ['history', () => w.reader.history(), h => [h.importedAt, h.periods.filter((p: { id: string }) => p.id.startsWith('daily-')).length]],
      ['dailyChanges', () => w.reader.dailyChanges(), d => [d.importedAt, d.days.length]],
      ['withdrawals', () => w.reader.withdrawals(), d => [d.importedAt, d.withdrawals.length]],
      ['cashFlows', () => w.reader.cashFlows(), c => [c.importedAt, c.audit.length]],
      ['period', () => w.reader.period(kept), p => [p?.importedAt ?? null, p?.rows.length ?? null]],
    ];
    // The whole answers of A and B, read without interference; each endpoint's data differs between them.
    loadA();
    const ofA = await Promise.all(reads.map(([, read, pick]) => read().then(pick)));
    loadB();
    const ofB = await Promise.all(reads.map(([, read, pick]) => read().then(pick)));
    reads.forEach(([name], index) => {
      assert.equal(ofA[index]![0], a, name);
      // B has no daily snapshot of that day: its period answer is null.
      assert.equal(ofB[index]![0], name === 'period' ? null : b, name);
      assert.notDeepEqual(ofA[index]![1], ofB[index]![1], `${name}：A 与 B 的数据可区分`);
    });
    for (const [index, [name, read, pick]] of reads.entries()) {
      loadA();
      const hook = commitAfterImportInfo(loadB);
      let answer: unknown;
      try { answer = await read(); } finally { hook.restore(); }
      assert.ok(hook.fired(), `${name}：B 在这次应答的导入记录与数据之间提交`);
      assert.deepEqual(pick(answer), ofA[index], `${name}：应答整份属于提交前的 A，不混入 B`);
      assert.deepEqual(pick(await read()), ofB[index], `${name}：下一次读取整份是 B`);
    }
  } finally { w.done(); }
});

test('资产读取：读取事务出错即释放，不挡另一连接的写入，之后的读取看到最新提交（#11）', async () => {
  const w = workspace();
  try {
    w.load();
    const file = join(w.dataDir, ASSET_DB_FILE);
    const other = new DatabaseSync(file);
    try {
      // The import record breaks: the read fails inside its transaction, and the transaction is released.
      other.prepare("UPDATE settings SET value = '{}' WHERE key = 'import-info'").run();
      await assert.rejects(w.reader.state(), /import-info/);
      await assert.rejects(w.reader.ledger(), /import-info/);
      // A leftover transaction would keep the reader on the old state (or fail the next BEGIN); the next import shows at once.
      importLedger({ from: w.from, owner: OTHER_OWNER, dataDir: w.dataDir, now: () => NOW + 1 });
      assert.equal((await w.reader.state()).source!.owner, OTHER_OWNER);
    } finally { other.close(); }

    // db.ts snapshot(): a statement issued after the transaction ended throws instead of reading a later state; an
    // exception rolls the transaction back; a writer commits while a snapshot is open (WAL, nothing waits).
    const reader = openAssetDb(file, { mode: 'snapshot' });
    const writer = openAssetDb(file);
    try {
      const owner = (database: { prepare(sql: string): { get<T>(): T | null } }) => JSON.parse(database.prepare("SELECT value FROM settings WHERE key = 'import-info'").get<{ value: string }>()!.value).owner as string;
      await assert.rejects(reader.snapshot(async database => { await null; return database.prepare('SELECT 1 AS one').first(); }), new RegExp(SNAPSHOT_CLOSED));
      assert.throws(() => reader.snapshot(() => { throw new Error('读取中途失败'); }), /读取中途失败/);
      const seen = reader.snapshot(database => {
        const before = owner(database);
        writer.replace(() => { writer.prepare("UPDATE settings SET value = json_set(value, '$.owner', 'carol') WHERE key = 'import-info'").run(); });
        return [before, owner(database)];
      });
      assert.deepEqual(seen, [OTHER_OWNER, OTHER_OWNER], '同一读取事务内看不到中途提交的写入');
      assert.equal(reader.snapshot(owner), 'carol', '事务结束后的下一次读取看到它');
    } finally { reader.close(); writer.close(); }
  } finally { w.done(); }
});

test('服务配置：asset 可选，只接受空对象；只配 asset 时可以不写 pairs', () => {
  const base = { secretsFile: '/etc/tp/secrets.json' };
  const only = parseServiceConfig({ ...base, asset: {} });
  assert.deepEqual([only.asset, only.pairs, only.oil], [{}, [], undefined]);
  assert.ok(!('asset' in parseServiceConfig({ ...base, pairs: [] })), '没有 asset 时配置与之前相同');
  assert.deepEqual(parseServiceConfig({ ...base, pairs: [{ id: 'p1', main: 'main', long: 'a', short: 'b' }], asset: {} }).pairs.map(pair => pair.id), ['p1']);
  assert.throws(() => parseServiceConfig({ ...base, asset: { dataDir: '/x' } }), /asset 无效（本版本只接受空对象 \{\}）/);
  assert.throws(() => parseServiceConfig({ ...base, asset: [] }), /asset 无效/);
  assert.throws(() => parseServiceConfig({ ...base, asset: null }), /asset 无效/);
  assert.throws(() => parseServiceConfig(base), /pairs/, '一个模块都没有时仍须写 pairs');
  assert.equal(assetSummary(undefined), '');
  assert.match(assetSummary({}), /资产账本已启用/);
});
