// The workbook import (A-6): src/asset/source-ledger.ts parseSource, src/asset/source-import.ts and its route
// POST /api/asset/import. The expectations follow the workbench's importLedger (modules/asset/lib/import-ledger.ts at 7745181).
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import { createExecutorServer, type ServiceViews } from '../src/http.ts';
import { ASSET_DB_FILE, openAssetDb } from '../src/asset/db.ts';
import { importLedger } from '../src/asset/import.ts';
import { createAssetStore, type ImportReply } from '../src/asset/store.ts';
import { acquireSyncLock, LOCK_BUSY } from '../src/asset/sync-lock.ts';
import { AssetInputError } from '../src/asset/validation.ts';
import { EXAMPLE_SOURCE, parseSource } from '../src/asset/source-ledger.ts';
import { BACKUP_DIR, BACKUP_FAILED, IMPORT_CHANGED, IMPORT_FINGERPRINT_KEY } from '../src/asset/source-import.ts';
import { bindAccounts, createHarness } from './harness.ts';
import { OWNER, dayBefore, writeWorkbenchLedger } from './asset-fixture.ts';

const NOW = Date.parse('2026-11-10T04:00:00Z');
const TODAY = '2026-11-10';

type Row = { id: string; project: string; kind: string; quantity: number | null; price: number | null; value: number | null; cell: string; formula?: string | number | null };
const row = (n: number, project: string, kind: string, value: number | null, extra: Partial<Row> = {}): Row =>
  ({ id: `row-${n}`, project, kind, quantity: null, price: null, value, cell: `G${n}`, formula: null, ...extra });
/** A file as scripts/import-workbook.py writes it: two past periods and one future one. */
function workbook(overrides: Record<string, unknown> = {}) {
  const rows = [row(2, 'bybit', '交易所', 12_000), row(3, 'aster', '交易所', 6_000), row(4, 'virtual', 'VIRTUAL', 900, { quantity: 1000, price: 0.9 }), row(5, '银行', 'USD', 2_100)];
  const sum = rows.reduce((total, item) => total + (item.value ?? 0), 0);
  const period = (id: string, date: string, items: Row[], total: number) => ({ id, date, total, fx: 7.2, cny: total * 7.2, rows: items, future: false, rowSum: total, difference: 0 });
  return {
    source: '资产统计.xlsx', sheet: 'Sheet1', startedAt: dayBefore(NOW, 3), baselineId: 'H1', baselineDate: dayBefore(NOW, 5), fx: 7.2,
    periods: [period('E1', dayBefore(NOW, 20), rows.map(item => ({ ...item, cell: 'E' + item.id.slice(4) })), sum), period('H1', dayBefore(NOW, 5), rows, sum), period('K1', dayBefore(NOW, -10), rows, sum)],
    ...overrides,
  };
}

/** A ledger imported from the workbench whose source ledger is still the example one, as the workbench starts. */
function exampleLedger(t: TestContext, { example = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tp-asset-source-import-'));
  const from = join(root, 'ledger.sqlite'), dataDir = join(root, 'data'), file = join(dataDir, ASSET_DB_FILE);
  writeWorkbenchLedger(from, { now: NOW });
  importLedger({ from, owner: OWNER, dataDir, now: () => NOW });
  if (example) {
    const raw = new DatabaseSync(file);
    try {
      const source = JSON.parse((raw.prepare("SELECT value FROM settings WHERE key = 'source-ledger'").get() as { value: string }).value);
      raw.prepare("UPDATE settings SET value = ? WHERE key = 'source-ledger'").run(JSON.stringify({ ...source, source: EXAMPLE_SOURCE }));
    } finally { raw.close(); }
  }
  const store = createAssetStore(file, { now: () => NOW });
  const peek = <T>(run: (database: ReturnType<typeof openAssetDb>) => T): T => { const database = openAssetDb(file, { readOnly: true }); try { return run(database); } finally { database.close(); } };
  const count = (sql: string) => peek(database => database.prepare(sql).get<{ count: number }>()!.count);
  const state = () => ({
    assets: peek(database => database.prepare('SELECT id, data FROM assets ORDER BY id').rows()),
    snapshots: peek(database => database.prepare('SELECT date, data FROM snapshots ORDER BY date').rows()),
    settings: peek(database => database.prepare('SELECT key, value FROM settings ORDER BY key').rows()),
  });
  const backups = () => existsSync(join(dataDir, BACKUP_DIR)) ? readdirSync(join(dataDir, BACKUP_DIR)) : [];
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, dataDir, file, store, peek, count, state, backups };
}
const preview = async (store: ReturnType<typeof createAssetStore>, source: unknown) => {
  const reply = await store.importSource({ source, apply: false });
  assert.equal(reply.preview, true);
  return reply as Extract<ImportReply, { preview: true }>;
};

test('parseSource keeps the workbench schema: unknown keys dropped, text trimmed, totals recomputed, ledger rules enforced', () => {
  const parsed = parseSource({ ...workbook(), extra: 'x', periods: workbook().periods.map(period => ({ ...period, note: 1, rows: period.rows.map(item => ({ ...item, project: ` ${item.project} `, kind: item.kind + ' ' })) })) });
  assert.equal('extra' in parsed, false); assert.equal('note' in parsed.periods[0]!, false);
  assert.equal(parsed.periods[1]!.rows[0]!.project, 'bybit'); assert.equal(parsed.periods[1]!.rows[0]!.kind, '交易所');
  assert.equal(parsed.periods[2]!.future, true, 'future is recomputed from startedAt');
  assert.deepEqual(Object.keys(parsed), ['source', 'sheet', 'startedAt', 'baselineId', 'baselineDate', 'fx', 'periods'], 'built in schema key order (the fingerprint)');
  const { formula: _formula, ...noFormula } = workbook().periods[1]!.rows[0]!;
  assert.equal('formula' in parseSource({ ...workbook(), periods: workbook().periods.map(period => ({ ...period, rows: [noFormula, ...period.rows.slice(1)] })) }).periods[0]!.rows[0]!, false);

  for (const broken of [null, [], { ...workbook(), fx: 0 }, { ...workbook(), startedAt: '2026-02-30' }, { ...workbook(), periods: [] }, { ...workbook(), source: '' },
    { ...workbook(), periods: workbook().periods.map(period => ({ ...period, rows: [{ ...period.rows[0]!, quantity: '1' }] })) },
    { ...workbook(), periods: workbook().periods.map(period => ({ ...period, rows: [{ ...period.rows[0]!, project: '   ' }] })) },
    { ...workbook(), periods: workbook().periods.map(period => ({ ...period, id: 'H2' })) }]) {
    assert.throws(() => parseSource(broken), AssetInputError);
  }
  assert.throws(() => parseSource({ ...workbook(), baselineId: 'E1' }), { message: '原表起始快照与日期或汇率不一致' });
  assert.throws(() => parseSource({ ...workbook(), periods: workbook().periods.map(period => ({ ...period, total: period.total + 1 })) }), { message: '原表起始快照的行合计与总额不一致' });
  assert.throws(() => parseSource({ ...workbook(), periods: workbook().periods.map(period => ({ ...period, rows: period.rows.filter(item => item.project !== 'aster'), total: period.total - 6_000 })) }), { message: '原表必须各有一条 virtual、bybit 和 aster 资产' });
});

test('preview writes nothing; apply backs up first, replaces the ledger, archives old snapshots and the same file again changes nothing', async t => {
  const w = exampleLedger(t);
  const before = w.state();
  const shown = await preview(w.store, workbook());
  assert.match(shown.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(shown.summary.source, '资产统计.xlsx'); assert.equal(shown.summary.rows, 4); assert.equal(shown.summary.periods, 3);
  assert.equal(shown.summary.baselineDate, dayBefore(NOW, 5)); assert.equal(shown.summary.baselineTotal, 21_000);
  assert.ok(shown.summary.retained.includes('bybit 已同步余额'), 'a synced exchange balance is kept');
  assert.deepEqual(w.state(), before, 'a preview changes nothing'); assert.deepEqual(w.backups(), []);
  assert.equal(w.count('SELECT COUNT(*) AS count FROM sync_locks'), 0, 'the lock is released after a preview');

  const applied = await w.store.importSource({ source: workbook(), apply: true, fingerprint: shown.fingerprint });
  assert.equal(applied.preview, false);
  if (applied.preview) return;
  assert.equal(applied.alreadyImported, false); assert.deepEqual(applied.import!.summary, shown.summary);
  assert.equal(applied.ledger!.dataKind, 'personal');
  assert.deepEqual(applied, { ...await w.store.ledger(), preview: false, alreadyImported: false, import: applied.import }, 'the answer carries the new ledger view');
  // The backup holds the ledger as it was, private to the service account.
  const [backup] = w.backups();
  assert.equal(backup, applied.import!.backupName); assert.match(backup!, /^before-import-[0-9a-f-]{36}\.sqlite$/);
  assert.equal(statSync(join(w.dataDir, BACKUP_DIR)).mode & 0o777, 0o700); assert.equal(statSync(join(w.dataDir, BACKUP_DIR, backup!)).mode & 0o777, 0o600);
  const copy = new DatabaseSync(join(w.dataDir, BACKUP_DIR, backup!), { readOnly: true });
  try { assert.deepEqual(copy.prepare('SELECT id, data FROM assets ORDER BY id').all().map(item => ({ ...item })), before.assets.map(item => ({ ...item }))); } finally { copy.close(); }

  const settings = Object.fromEntries(w.state().settings.map(item => [item.key as string, item.value as string]));
  assert.equal(settings[IMPORT_FINGERPRINT_KEY], shown.fingerprint); assert.equal(JSON.parse(settings['source-ledger']!).source, '资产统计.xlsx');
  assert.equal(settings['last-attempt'], '0');
  // Every earlier snapshot and the example periods are archived; today's daily snapshot is the imported ledger.
  const snapshots = w.state().snapshots.map(item => ({ date: item.date as string, data: JSON.parse(item.data as string) }));
  const archived = snapshots.filter(item => item.date.startsWith('archive-'));
  assert.equal(archived.length, before.snapshots.length + 2, 'old snapshots plus the two example periods');
  assert.ok(archived.every(item => item.data.archived === true && item.data.id === item.date));
  assert.deepEqual(snapshots.filter(item => !item.date.startsWith('archive-')).map(item => item.date), [TODAY]);
  const history = await w.store.history();
  assert.ok(history.periods!.filter(period => period.archived).every(period => !period.included), 'archived periods stay out of the trend');

  const again = await w.store.importSource({ source: workbook(), apply: false });
  assert.equal(again.preview, false);
  if (!again.preview) { assert.equal(again.alreadyImported, true); assert.equal(again.import, null); }
  assert.equal(w.backups().length, 1, 'the same file again makes no new backup');
});

test('refusals write nothing: the example file, a personal ledger, a changed file and a failed backup', async t => {
  const w = exampleLedger(t);
  const before = w.state();
  await assert.rejects(w.store.importSource({ source: workbook({ source: EXAMPLE_SOURCE }), apply: false }), { message: '请选择从原表生成的导入文件，不能再次导入示例' });
  const shown = await preview(w.store, workbook());
  const changed = workbook({ sheet: 'Sheet2' });
  await assert.rejects(w.store.importSource({ source: changed, apply: true, fingerprint: shown.fingerprint }), { name: 'AssetConflict', code: 'import_changed', message: IMPORT_CHANGED });
  await assert.rejects(w.store.importSource({ source: workbook(), apply: true }), AssetInputError, 'apply without the previewed fingerprint');
  await assert.rejects(w.store.importSource({ source: workbook(), apply: true, fingerprint: shown.fingerprint, extra: 1 }), AssetInputError);
  assert.deepEqual(w.state(), before); assert.deepEqual(w.backups(), []);

  // The backup directory cannot be made: the import stops before writing anything.
  writeFileSync(join(w.dataDir, BACKUP_DIR), 'not a directory');
  await assert.rejects(w.store.importSource({ source: workbook(), apply: true, fingerprint: shown.fingerprint }), { name: 'AssetBackupError', message: BACKUP_FAILED });
  assert.deepEqual(w.state(), before);
  assert.equal(w.count('SELECT COUNT(*) AS count FROM sync_locks'), 0, 'the lock is released after a failed backup');
  rmSync(join(w.dataDir, BACKUP_DIR));

  const personal = exampleLedger(t, { example: false });
  const kept = personal.state();
  await assert.rejects(personal.store.importSource({ source: workbook(), apply: false }), { message: '此账本已含原表数据，已停止导入以保留现有记录' });
  assert.deepEqual(personal.state(), kept);
});

test('the import and the other ledger writes exclude each other through the sync lock', async t => {
  const w = exampleLedger(t);
  const shown = await preview(w.store, workbook());
  const before = w.state();
  // A sync or edit holding the lock (another connection, as a second page would): the import is refused.
  const other = openAssetDb(w.file, { mode: 'service' });
  const lease = await acquireSyncLock(other, { now: () => NOW });
  try {
    await assert.rejects(w.store.importSource({ source: workbook(), apply: true, fingerprint: shown.fingerprint }), { name: 'AssetConflict', code: 'busy', message: LOCK_BUSY });
    await assert.rejects(w.store.importSource({ source: workbook(), apply: false }), { code: 'busy' }, 'a preview takes the lock too (the workbench withLock)');
  } finally { await lease.release(); other.close(); }
  assert.deepEqual(w.state(), before); assert.deepEqual(w.backups(), []);
  // Started together, the import holds the lock and the edit is refused rather than landing inside the import.
  const [imported, edit] = await Promise.allSettled([w.store.importSource({ source: workbook(), apply: true, fingerprint: shown.fingerprint }), w.store.editFx({ fx: 7.3 })]);
  assert.equal(imported.status, 'fulfilled');
  assert.equal(edit.status, 'rejected'); assert.equal((edit as PromiseRejectedResult).reason.message, LOCK_BUSY);
  assert.notEqual((await w.store.ledger()).ledger!.fx, 7.3);
  assert.equal(w.count('SELECT COUNT(*) AS count FROM sync_locks'), 0);
});

const TOKEN = 'asset-access-token-0006';
const SESSION = 'asset-session-value-0006';
async function withServer(views: ServiceViews, run: (post: (path: string, body: string, headers?: Record<string, string>) => Promise<Response>) => Promise<void>) {
  const h = createHarness();
  bindAccounts(h.ex);
  const server = createExecutorServer({ executor: h.ex, accessToken: TOKEN, session: SESSION, views });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const login = await fetch(`${base}/login?token=${TOKEN}`, { redirect: 'manual' });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    await run((path, body, headers = { cookie, 'x-pa-executor': '1', 'content-type': 'application/json' }) => fetch(base + path, { method: 'POST', headers, body }));
  } finally { await new Promise(resolve => server.close(resolve)); h.dispose(); }
}

test('POST /api/asset/import: login and page marker first, 5 MB body limit, preview and apply, errors as the workbench answers', async t => {
  const w = exampleLedger(t);
  await withServer({ asset: w.store }, async post => {
    assert.equal((await post('/api/asset/import', JSON.stringify({ source: workbook(), apply: false }), { 'x-pa-executor': '1', 'content-type': 'application/json' })).status, 401, 'login comes first');
    const large = JSON.stringify({ source: workbook({ padding: 'x'.repeat(5 * 1024 * 1024) }), apply: false });
    const tooLarge = await post('/api/asset/import', large);
    assert.deepEqual([tooLarge.status, await tooLarge.json()], [413, { code: 'body_too_large', message: '导入文件不能超过 5 MB' }]);
    // Below the limit but above the other writes' 16 KB: only the import gets the larger body.
    const padded = JSON.stringify({ source: workbook({ padding: 'x'.repeat(100_000) }), apply: false });
    const shown = await post('/api/asset/import', padded);
    assert.equal(shown.status, 200);
    const { fingerprint } = await shown.json() as { fingerprint: string };
    assert.equal((await post('/api/asset/fx', JSON.stringify({ fx: 7, padding: 'x'.repeat(20_000) }))).status, 413);
    const invalid = await post('/api/asset/import', JSON.stringify({ source: { ...workbook(), fx: -1 }, apply: false }));
    assert.deepEqual([invalid.status, await invalid.json()], [400, { code: 'invalid_input', message: '输入格式不正确，请检查数值和连接信息' }]);
    const changed = await post('/api/asset/import', JSON.stringify({ source: workbook({ sheet: 'other' }), apply: true, fingerprint }));
    assert.deepEqual([changed.status, await changed.json()], [409, { code: 'import_changed', message: IMPORT_CHANGED }]);
    mkdirBlocked(w.dataDir);
    const failed = await post('/api/asset/import', JSON.stringify({ source: workbook(), apply: true, fingerprint }));
    assert.deepEqual([failed.status, await failed.json()], [503, { code: 'backup_failed', message: BACKUP_FAILED }]);
    rmSync(join(w.dataDir, BACKUP_DIR));
    const applied = await post('/api/asset/import', JSON.stringify({ source: workbook(), apply: true, fingerprint }));
    assert.equal(applied.status, 200);
    assert.equal(((await applied.json()) as { ledger: { dataKind: string } }).ledger.dataKind, 'personal');
    const refused = await post('/api/asset/import', JSON.stringify({ source: workbook({ sheet: 'next' }), apply: false }));
    assert.deepEqual([refused.status, await refused.json()], [400, { code: 'asset_rejected', message: '此账本已含原表数据，已停止导入以保留现有记录' }]);
  });
});
const mkdirBlocked = (dataDir: string) => { writeFileSync(join(dataDir, BACKUP_DIR), ''); chmodSync(join(dataDir, BACKUP_DIR), 0o600); };
