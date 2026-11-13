// The service's asset reads: "not imported" answers before the first import, the imported ledger read through the
// copied workbench functions after it, and an import picked up by a reader that is already open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ASSET_DB_FILE } from '../src/asset/db.ts';
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
