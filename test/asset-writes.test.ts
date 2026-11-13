// The asset writes of A-2 (src/asset/store.ts, writes.ts) on an imported ledger, and their HTTP routes: each write's
// result and refusals as the workbench store.ts rules them, the daily snapshot written with it, the lock released
// afterwards, the 409s (not imported, read-only file, lock busy) and the HTTP answers (CSRF 403, 400, 409, 503).
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import { createExecutorServer, type ServiceViews } from '../src/http.ts';
import { ASSET_DB_FILE, assertOwnFiles, openAssetDb } from '../src/asset/db.ts';
import { importLedger } from '../src/asset/import.ts';
import { createAssetStore, readLedger, READ_ONLY } from '../src/asset/store.ts';
import { acquireSyncLock, LOCK_BUSY, NOT_IMPORTED } from '../src/asset/sync-lock.ts';
import { AssetInputError } from '../src/asset/validation.ts';
import { dailySnapshot } from '../src/asset/writes.ts';
import type { Asset } from '../src/asset/types.ts';
import { bindAccounts, createHarness } from './harness.ts';
import { OWNER, dayBefore, writeWorkbenchLedger } from './asset-fixture.ts';

const NOW = Date.parse('2026-11-10T04:00:00Z');
const TODAY = '2026-11-10';
const WITHDRAWAL = '8e7a9b2c-4d3f-4e5a-9b0c-3c4d5e6f7081';
const NEW_ID = '3f2a1b0c-9d8e-4f7a-8b6c-5d4e3f2a1b0c';

function imported(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'tp-asset-writes-'));
  const from = join(root, 'ledger.sqlite'), dataDir = join(root, 'data'), file = join(dataDir, ASSET_DB_FILE);
  writeWorkbenchLedger(from, { now: NOW });
  const load = () => importLedger({ from, owner: OWNER, dataDir, now: () => NOW });
  load();
  const clock = { at: NOW };
  const store = createAssetStore(file, { now: () => clock.at });
  /** A second connection, the way another process (the import) sees the file. */
  const peek = <T>(run: (database: ReturnType<typeof openAssetDb>) => T): T => { const database = openAssetDb(file, { readOnly: true }); try { return run(database); } finally { database.close(); } };
  const snapshot = (date = TODAY) => peek(database => database.prepare('SELECT data FROM snapshots WHERE date = ?').bind(date).get<{ data: string }>());
  const locks = () => peek(database => database.prepare('SELECT COUNT(*) AS count FROM sync_locks').get<{ count: number }>()!.count);
  t.after(() => { store.close(); for (const name of readdirSync(dataDir)) chmodSync(join(dataDir, name), 0o644); rmSync(root, { recursive: true, force: true }); });
  return { root, file, dataDir, store, clock, load, peek, snapshot, locks };
}
/** The snapshot as the workbench's snapshot() computes it from the ledger read back after the write. */
async function expectedSnapshot(w: ReturnType<typeof imported>, at = NOW) {
  const database = openAssetDb(w.file, { readOnly: true });
  try { return dailySnapshot(await readLedger(database, false), at).data; } finally { database.close(); }
}
const row = (rows: Asset[], id: string) => rows.find(asset => asset.id === id)!;

test('资产写入：编辑手动行，返回与 GET 账本相同的新视图，并写当天日快照（不带 positions）', async t => {
  const w = imported(t);
  assert.equal(w.snapshot(), null, '导入的快照只到昨天');
  const answer = await w.store.editAsset({ id: 'row-3', quantity: 2_500, price: 1 });
  assert.deepEqual(answer, await w.store.ledger(), '同一连接，写后立刻读到');
  const edited = row(answer.rows, 'row-3');
  assert.deepEqual([edited.quantity, edited.price, edited.value, edited.status, edited.updatedAt], [2_500, 1, 2_500, '手动估值', new Date(NOW).toISOString()]);
  assert.equal(answer.summary!.valuation.total, 24_250 - 500);
  const stored = JSON.parse(w.snapshot()!.data);
  assert.deepEqual(stored, await expectedSnapshot(w));
  assert.equal(stored.id, 'daily-' + TODAY);
  assert.equal(stored.total, 24_250 - 500, '六行资产（含原表出金行）之和');
  assert.equal('positions' in stored, false);
  assert.equal(w.locks(), 0, '写完释放锁');
});

test('资产写入：market 行只改数量（单价沿用行情），交易所行、未知行与缺单价被拒且不写入', async t => {
  const w = imported(t);
  const before = row((await w.store.ledger()).rows, 'row-4');
  const answer = await w.store.editAsset({ id: 'row-4', quantity: 1, price: 1 });
  const market = row(answer.rows, 'row-4');
  assert.deepEqual([market.quantity, market.price, market.value], [1, before.price, before.price]);
  assert.equal(market.updatedAt, before.updatedAt, '行情行的更新时间不随编辑改');
  // The ledger rules are plain errors with the workbench's messages.
  const snapshot = w.snapshot()!.data;
  await assert.rejects(w.store.editAsset({ id: 'row-1', quantity: 1, price: 1 }), { message: '交易所资产由只读接口维护' });
  await assert.rejects(w.store.editAsset({ id: 'row-99', quantity: 1, price: 1 }), { message: '未找到该资产' });
  await assert.rejects(w.store.editAsset({ id: 'row-3', quantity: 1, price: null }), { message: '数量大于零时，请填写单价' });
  await assert.rejects(w.store.editAsset({ id: 'row-3', quantity: 1, price: 1, mode: 'manual' }), AssetInputError);
  assert.equal(w.snapshot()!.data, snapshot);
  assert.equal(row((await w.store.ledger()).rows, 'row-3').value, 3_000);
  assert.equal(w.locks(), 0, '失败后同样释放锁');
  assert.equal(row((await w.store.editAsset({ id: 'row-3', quantity: 0, price: null })).rows, 'row-3').value, 0, '数量为 0 时单价可空');
});

test('资产写入：汇率记为手动并进入当天快照', async t => {
  const w = imported(t);
  const answer = await w.store.editFx({ fx: 7.25 });
  assert.equal(answer.ledger!.fx, 7.25);
  assert.deepEqual(answer.ledger!.fxStatus, { source: 'manual', fetchedAt: new Date(NOW).toISOString(), rateDate: null, error: null });
  const stored = JSON.parse(w.snapshot()!.data);
  assert.deepEqual(stored, await expectedSnapshot(w));
  assert.deepEqual([stored.fx, stored.cny], [7.25, stored.total * 7.25]);
  await assert.rejects(w.store.editFx({ fx: 0 }), AssetInputError);
});

test('资产写入：出金登记、重复提交、修改、删除，以及日期与编号的拒绝', async t => {
  const w = imported(t);
  const baselineDate = dayBefore(NOW, 40);
  const input = { id: NEW_ID, date: dayBefore(NOW, 1), amount: 120.5, note: ' 转出 ' };
  const added = await w.store.saveWithdrawal(input, false);
  assert.deepEqual(added.ledger!.withdrawals.at(-1), { id: NEW_ID, date: input.date, amount: 120.5, note: '转出', createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString() });
  assert.deepEqual(JSON.parse(w.snapshot()!.data), await expectedSnapshot(w));
  // A retried add (the answer was lost) is a success that changes nothing; other content under the id is refused.
  w.clock.at = NOW + 60_000;
  assert.deepEqual((await w.store.saveWithdrawal(input, false)).ledger!.withdrawals, added.ledger!.withdrawals);
  await assert.rejects(w.store.saveWithdrawal({ ...input, amount: 121 }, false), { message: '出金记录编号重复，请刷新页面' });
  const changed = await w.store.saveWithdrawal({ ...input, amount: 130 }, true);
  const record = changed.ledger!.withdrawals.find(row => row.id === NEW_ID)!;
  assert.deepEqual([record.amount, record.createdAt, record.updatedAt], [130, new Date(NOW).toISOString(), new Date(NOW + 60_000).toISOString()]);
  await assert.rejects(w.store.saveWithdrawal({ ...input, id: '00000000-0000-4000-8000-000000000000' }, true), { message: '未找到出金记录，请刷新页面' });
  await assert.rejects(w.store.saveWithdrawal({ ...input, date: dayBefore(NOW, 41) }, false), { message: `新增出金日期不能早于原表基准日 ${baselineDate}，原表出金已单独计入` });
  await assert.rejects(w.store.saveWithdrawal({ ...input, id: '00000000-0000-4000-8000-000000000001', date: '2026-11-11' }, false), { message: '不能登记尚未发生的出金' });
  // Beijing day: 16:00 UTC is the next day there.
  w.clock.at = Date.parse('2026-11-10T16:00:00Z');
  assert.equal((await w.store.saveWithdrawal({ ...input, id: '00000000-0000-4000-8000-000000000002', date: '2026-11-11' }, false)).ledger!.withdrawals.length, 3);
  const deleted = await w.store.deleteWithdrawal({ id: WITHDRAWAL });
  assert.deepEqual(deleted.ledger!.withdrawals.map(row => row.id), [NEW_ID, '00000000-0000-4000-8000-000000000002']);
  // Deleting an id that is gone still answers the ledger (workbench deleteWithdrawal).
  assert.equal((await w.store.deleteWithdrawal({ id: WITHDRAWAL })).ledger!.withdrawals.length, 2);
  assert.ok(w.snapshot('2026-11-11'), '跨过北京时间零点后写的是新一天的快照');
  await assert.rejects(w.store.deleteWithdrawal({ id: 'row-1' }), AssetInputError);
  assert.equal((await w.store.withdrawals()).withdrawals.length, 2);
});

test('资产写入：资金流登记返回资金流视图，不写日快照', async t => {
  const w = imported(t);
  const body = { id: NEW_ID, revision: 0, date: TODAY, account: 'bank', currency: 'USD', amount: '-50', kind: 'external', transferId: null, usdRate: null, rateAt: null, reference: 'statement:9', reason: '核对流水', void: false };
  const answer = await w.store.saveCashFlow(body);
  assert.deepEqual(answer, await w.store.cashFlows());
  assert.deepEqual(answer.audit.at(-1), { ...body, revision: 1, recordedAt: new Date(NOW).toISOString() });
  assert.equal(w.snapshot(), null);
  await assert.rejects(w.store.saveCashFlow(body).then(() => w.store.saveCashFlow({ ...body, amount: '-51' })), { message: '资金流记录已被修改，请重新读取后再保存' });
  await assert.rejects(w.store.saveCashFlow({ ...body, extra: 1 }), { message: '资金流字段无效；请填写账户、币种、原始凭证及修改原因' });
});

test('资产写入：未导入 409、锁被占 409、库只读 409（读取照常），属主恢复后不用重启即可写', async t => {
  const empty = mkdtempSync(join(tmpdir(), 'tp-asset-writes-empty-'));
  const none = createAssetStore(join(empty, ASSET_DB_FILE), { now: () => NOW });
  try { await assert.rejects(none.editFx({ fx: 7 }), { name: 'AssetConflict', code: 'not_imported', message: NOT_IMPORTED }); }
  finally { none.close(); rmSync(empty, { recursive: true, force: true }); }

  const w = imported(t);
  await w.store.ledger();
  const other = openAssetDb(w.file, { mode: 'service' });
  const lease = await acquireSyncLock(other, { now: () => NOW });
  try { await assert.rejects(w.store.editFx({ fx: 7 }), { name: 'AssetConflict', code: 'busy', message: LOCK_BUSY }); }
  finally { await lease.release(); other.close(); }
  assert.equal((await w.store.editFx({ fx: 7 })).ledger!.fx, 7);

  w.store.close();
  chmodSync(w.file, 0o444);
  const reader = createAssetStore(w.file, { now: () => NOW });
  try {
    assert.equal((await reader.ledger()).ledger!.fx, 7, '只读打开，读取照常');
    await assert.rejects(reader.editFx({ fx: 8 }), { name: 'AssetConflict', code: 'read_only', message: READ_ONLY });
    // SQLite gives the -wal/-shm it creates the main file's mode; the owner is fixed for all of them (as with chown).
    for (const name of readdirSync(w.dataDir)) chmodSync(join(w.dataDir, name), 0o644);
    assert.equal((await reader.editFx({ fx: 8 })).ledger!.fx, 8);
  } finally { reader.close(); }
});

test('资产写入：库文件不归服务账户或不是普通文件时不接管（退回只读）', { skip: process.getuid === undefined }, t => {
  const dir = mkdtempSync(join(tmpdir(), 'asset-owner-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const uid = process.getuid!();
  writeFileSync(join(dir, ASSET_DB_FILE), '');
  assertOwnFiles(dir, uid);
  assert.throws(() => assertOwnFiles(dir, uid + 1), /不归服务账户.*chown/);
  writeFileSync(join(dir, 'elsewhere'), '');
  symlinkSync(join(dir, 'elsewhere'), join(dir, ASSET_DB_FILE + '-wal'));
  assert.throws(() => assertOwnFiles(dir, uid), /-wal 不是普通文件/);
});

test('资产写入：首次打开时导入正占着写锁，读取照常，写入报忙而不是只读，之后自动恢复', async t => {
  const w = imported(t);
  w.store.close();
  const reader = createAssetStore(w.file, { now: () => NOW });
  t.after(() => reader.close());
  // What the import does while it replaces the ledger: hold the write lock (the service waits 1 s, then gives up).
  const raw = new DatabaseSync(w.file);
  raw.exec('BEGIN IMMEDIATE');
  try {
    assert.ok((await reader.ledger()).ledger, '读取照常');
    await assert.rejects(reader.editFx({ fx: 8 }), { name: 'AssetConflict', code: 'busy', message: LOCK_BUSY });
  } finally { raw.exec('ROLLBACK'); raw.close(); }
  assert.equal((await reader.editFx({ fx: 8 })).ledger!.fx, 8, '锁放开后写入照常');
});

test('资产写入：导入替换账本后，已打开的服务读写都看到新账本', async t => {
  const w = imported(t);
  await w.store.editFx({ fx: 7.5 });
  w.load();
  assert.equal((await w.store.ledger()).ledger!.fx, 7.1, '重新导入覆盖了本地修改');
  assert.equal((await w.store.editFx({ fx: 7.4 })).ledger!.fx, 7.4);
});

const TOKEN = 'asset-access-token-0002';
const SESSION = 'asset-session-value-0002';
type Post = (path: string, body: unknown, headers?: Record<string, string>) => Promise<Response>;
async function withServer(views: ServiceViews, run: (post: Post, get: (path: string) => Promise<Response>) => Promise<void>) {
  const h = createHarness();
  bindAccounts(h.ex);
  const server = createExecutorServer({ executor: h.ex, accessToken: TOKEN, session: SESSION, views });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const login = await fetch(`${base}/login?token=${TOKEN}`, { redirect: 'manual' });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    await run(
      (path, body, headers = { 'x-pa-executor': '1', 'content-type': 'application/json' }) => fetch(base + path, { method: 'POST', headers: { cookie, ...headers }, body: JSON.stringify(body) }),
      path => fetch(base + path, { headers: { cookie } }),
    );
  } finally { await new Promise(resolve => server.close(resolve)); h.dispose(); }
}

test('资产写接口：POST 成功返回 GET 账本同形；缺页面标记 403；校验 400；业务拒绝 400；冲突 409', async t => {
  const w = imported(t);
  await withServer({ asset: w.store }, async (post, get) => {
    const csrf = await post('/api/asset/fx', { fx: 7.2 }, { 'content-type': 'application/json' });
    assert.equal(csrf.status, 403);
    assert.equal(((await csrf.json()) as { code: string }).code, 'csrf');
    assert.equal((await get('/api/asset/fx')).status, 404, '写接口只收 POST');

    const fx = await post('/api/asset/fx', { fx: 7.2 });
    assert.equal(fx.status, 200);
    assert.deepEqual(await fx.json(), await (await get('/api/asset/ledger')).json());
    assert.equal((await post('/api/asset/assets/edit', { id: 'row-3', quantity: 10, price: 1 })).status, 200);
    assert.equal((await post('/api/asset/withdrawals/add', { id: NEW_ID, date: TODAY, amount: 1 })).status, 200);
    assert.equal((await post('/api/asset/withdrawals/edit', { id: NEW_ID, date: TODAY, amount: 2, note: 'x' })).status, 200);
    assert.equal((await post('/api/asset/withdrawals/delete', { id: NEW_ID })).status, 200);
    const flows = await post('/api/asset/cash-flows', { id: NEW_ID, revision: 0, date: TODAY, account: 'bank', currency: 'USD', amount: '5', kind: 'external', transferId: null, usdRate: null, rateAt: null, reference: 'r', reason: 'x', void: false });
    assert.equal(flows.status, 200);
    assert.deepEqual(await flows.json(), await (await get('/api/asset/cash-flows')).json());

    const invalid = await post('/api/asset/fx', { fx: 7, extra: true });
    assert.deepEqual([invalid.status, await invalid.json()], [400, { code: 'invalid_input', message: '输入格式不正确，请检查数值和连接信息' }]);
    const rejected = await post('/api/asset/assets/edit', { id: 'row-1', quantity: 1, price: 1 });
    assert.deepEqual([rejected.status, await rejected.json()], [400, { code: 'asset_rejected', message: '交易所资产由只读接口维护' }]);
    assert.equal((await post('/api/asset/fx', 'not json')).status, 400);

    const other = openAssetDb(w.file, { mode: 'service' });
    const lease = await acquireSyncLock(other, { now: () => NOW });
    try {
      const busy = await post('/api/asset/withdrawals/delete', { id: NEW_ID });
      assert.deepEqual([busy.status, await busy.json()], [409, { code: 'busy', message: LOCK_BUSY }]);
    } finally { await lease.release(); other.close(); }
  });
});

test('资产写接口：库错误 503 且不回显 SQL；其他异常 500；没有 asset 时 404', async () => {
  const sqlite = Object.assign(new Error('UNIQUE constraint failed: snapshots.date (INSERT INTO snapshots ...)'), { code: 'ERR_SQLITE_ERROR' });
  const failing = {
    ...createAssetStore(join(tmpdir(), 'tp-asset-none', ASSET_DB_FILE)),
    editFx: async () => { throw sqlite; },
    editAsset: async () => { throw new TypeError('x is undefined'); },
    deleteWithdrawal: async () => { throw new Error('fetch failed'); },
  };
  await withServer({ asset: failing }, async post => {
    const unavailable = await post('/api/asset/fx', { fx: 7 });
    assert.deepEqual([unavailable.status, await unavailable.json()], [503, { code: 'asset_unavailable', message: '服务暂时不可用，已保留上次数据，请稍后重试' }]);
    assert.equal((await post('/api/asset/withdrawals/delete', { id: NEW_ID })).status, 503, '工作台把这类文字也当作暂时不可用');
    const defect = await post('/api/asset/assets/edit', {});
    assert.deepEqual([defect.status, ((await defect.json()) as { code: string }).code], [500, 'internal']);
  });
  await withServer({}, async post => assert.equal((await post('/api/asset/fx', { fx: 7 })).status, 404));
});
