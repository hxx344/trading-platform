// The connection writes and the sync of A-3/A-4 (src/asset/sync.ts through store.ts) on an imported ledger, with the
// external reads replaced (no network). The first four tests are project_aggregation
// modules/asset/tests/store-sync-lock.test.ts at 0014655 with its expected values; the inputs follow this service's
// request checks (UUID account ids, 40-digit wallets, 64-digit keys) and the clock is the store's. Then this service's
// cases: the 30 s throttle, a credential replaced while its read is out, the ledger imported again mid-sync, the
// connect and Aster account paths, the sealed rows, and the HTTP answers (403, 400, 409, 503) with no credential in any.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createExecutorServer } from '../src/http.ts';
import { ASSET_DB_FILE, openAssetDb, type AssetDb } from '../src/asset/db.ts';
import { importLedger } from '../src/asset/import.ts';
import { createAssetStore, currentLedger } from '../src/asset/store.ts';
import { acquireSyncLock, LEDGER_REIMPORTED, LOCK_BUSY, LOCK_LOST } from '../src/asset/sync-lock.ts';
import { CREDENTIAL_KEY_FILE, credentialKey, unseal } from '../src/asset/credentials.ts';
import type { AssetSources } from '../src/asset/sync.ts';
import type { Balance, FxStatus } from '../src/asset/types.ts';
import { bindAccounts, createHarness } from './harness.ts';
import { OWNER, writeWorkbenchLedger } from './asset-fixture.ts';

const NOW = Date.parse('2026-11-10T04:00:00Z');
const PRIVATE_KEY = '0x' + '1'.repeat(64);
const uuid = (id: string) => `00000000-0000-4000-8000-${id.padStart(12, '0')}`;
const wallet = (id: string) => '0x' + id.padStart(40, '0');
const input = (id: string, walletAddress = wallet(id)) => ({ id: uuid(id), name: id.toUpperCase(), walletAddress, privateKey: PRIVATE_KEY, includeSpot: false });
const settle = () => new Promise(resolve => setImmediate(resolve));
async function until(condition: () => boolean) {
  for (let i = 0; i < 500 && !condition(); i++) await settle();
  assert.ok(condition(), 'fixture did not reach the expected state');
}
type Pending = { wallet: string; resolve: (total: number) => void; reject: (error: Error) => void };
type Deferred = { resolve: (total: number) => void; reject: (error: Error) => void };

/** The workbench's tests/fixtures/store-fakes.ts as an AssetSources, plus Binance and OKX. */
function fakeSources() {
  const control = {
    held: new Set<string>(), values: new Map<string, number>(), pending: [] as Pending[], usdc: 1,
    hyperliquid: 0 as number | Error, hyperliquidCalls: [] as { walletAddress: string; verifyRole: boolean }[],
    rhLighter: 0 as number | Error, rhLighterCalls: [] as string[],
    binance: 0 as number | Error, okx: 0 as number | Error | 'hold', okxPending: [] as Deferred[],
    reads: 0,
  };
  const now = () => new Date(Date.now()).toISOString();
  const sources: Partial<AssetSources> = {
    async quotes() { control.reads++; const at = now(); return { VIRTUAL: { price: 1, at, source: 'test' }, USDC: { price: control.usdc, at, source: 'test' } }; },
    async yuanQuote(): Promise<{ rate: number; status: FxStatus }> { return { rate: 7.25, status: { source: 'Frankfurter', fetchedAt: now(), rateDate: null, error: null } }; },
    validateAsterWallet: c => ({ address: c.walletAddress }),
    syncAster(c) {
      const answer = (total: number) => ({ total, details: [] as Balance[] });
      if (!control.held.has(c.walletAddress)) return Promise.resolve(answer(control.values.get(c.walletAddress) ?? 0));
      return new Promise((resolve, reject) => control.pending.push({ wallet: c.walletAddress, resolve: total => resolve(answer(total)), reject }));
    },
    async syncHyperliquid(c, options) {
      control.hyperliquidCalls.push({ walletAddress: c.walletAddress, verifyRole: !!options.verifyRole });
      if (control.hyperliquid instanceof Error) throw control.hyperliquid;
      return { total: control.hyperliquid, details: [], updatedAt: now() };
    },
    async syncRhLighter(c) {
      control.rhLighterCalls.push(c.walletAddress);
      if (control.rhLighter instanceof Error) throw control.rhLighter;
      return { total: control.rhLighter, details: [], updatedAt: now() };
    },
    async syncBinance() {
      if (control.binance instanceof Error) throw control.binance;
      return { total: control.binance, details: [] };
    },
    syncOkx() {
      const value = control.okx;
      if (value === 'hold') return new Promise((resolve, reject) => control.okxPending.push({ resolve: total => resolve({ total, details: [], updatedAt: now() }), reject }));
      return value instanceof Error ? Promise.reject(value) : Promise.resolve({ total: value, details: [], updatedAt: now() });
    },
  };
  return { control, sources };
}

function imported(t: TestContext, { emptyAster = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tp-asset-sync-'));
  const from = join(root, 'ledger.sqlite'), dataDir = join(root, 'data'), file = join(dataDir, ASSET_DB_FILE);
  writeWorkbenchLedger(from, { now: NOW });
  const load = () => importLedger({ from, owner: OWNER, dataDir, now: () => NOW });
  load();
  // The fixture's Aster account has a non-UUID id the page could not address; these tests add their own.
  const writable = (run: (database: AssetDb) => void) => { const database = openAssetDb(file, { mode: 'service' }); try { run(database); } finally { database.close(); } };
  if (emptyAster) writable(database => database.prepare("UPDATE settings SET value = '[]' WHERE key = 'aster-accounts'").run());
  const { control, sources } = fakeSources();
  const store = createAssetStore(file, { now: () => Date.now(), fetch: async () => { throw new Error('no network in tests'); }, sources });
  const peek = <T>(run: (database: AssetDb) => T): T => { const database = openAssetDb(file, { readOnly: true }); try { return run(database); } finally { database.close(); } };
  const lockRow = () => peek(database => database.prepare('SELECT token FROM sync_locks WHERE id = 1').get<{ token: string }>());
  const full = () => peek(database => currentLedger(database, Date.now()));
  const connections = () => peek(database => database.prepare('SELECT exchange, encrypted FROM connections ORDER BY exchange').rows<{ exchange: string; encrypted: string }>());
  const latestDaily = () => peek(database => database.prepare("SELECT data FROM snapshots WHERE date GLOB '[0-9]*' ORDER BY date DESC LIMIT 1").get<{ data: string }>());
  t.after(() => { store.close(); for (const name of readdirSync(dataDir)) chmodSync(join(dataDir, name), 0o644); rmSync(root, { recursive: true, force: true }); });
  return { root, file, dataDir, store, control, load, writable, peek, lockRow, full, connections, latestDaily };
}
type World = ReturnType<typeof imported>;

function answer(w: World, match: (wallet: string) => boolean, total: number | Error) {
  const ready = w.control.pending.filter(p => match(p.wallet));
  w.control.pending = w.control.pending.filter(p => !match(p.wallet));
  for (const p of ready) if (total instanceof Error) p.reject(total); else p.resolve(total);
}
/** Answer outstanding reads in waves (the refresh keeps three in flight) until `task` settles. */
async function drain(w: World, task: Promise<unknown>, match: (wallet: string) => boolean, total: number | ((wallet: string) => number | Error)) {
  let done = false;
  task.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 500 && !done; i++) {
    for (const p of w.control.pending.filter(p => match(p.wallet))) answer(w, x => x === p.wallet, typeof total === 'function' ? total(p.wallet) : total);
    await settle();
  }
  assert.ok(done, 'task did not settle');
}
async function seedAccounts(w: World, ids: string[]) {
  for (const id of ids) { w.control.values.set(wallet(id), 100); await w.store.saveAsterAccount(input(id), false); }
  for (const id of ids) w.control.held.add(wallet(id));
}

test('a refresh that outlives its lease cannot restore a removed account, overwrite newer credentials or release the newer lock', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: NOW + 3_600_000 });
  const w = imported(t), ids = Array.from({ length: 10 }, (_, i) => 'a' + i);
  await seedAccounts(w, ids);
  const stale = w.store.sync({});
  stale.catch(() => {});
  await until(() => w.control.pending.length === 3);
  // The exchange reads outlast the ten-minute hold limit, so the lease lapses despite renewals.
  for (let elapsed = 0; elapsed <= 600_000; elapsed += 30_000) t.mock.timers.tick(30_000);

  await w.store.deleteAsterAccount({ id: uuid('a9'), action: 'remove' });
  w.control.values.set(wallet('b0'), 50);
  await w.store.saveAsterAccount(input('b0'), false);
  w.control.held.add(wallet('c1'));
  const rekey = w.store.saveAsterAccount(input('a1', wallet('c1')), true);
  await until(() => w.control.pending.some(p => p.wallet === wallet('c1')));
  const newerLock = w.lockRow();
  assert.ok(newerLock);

  await drain(w, stale, x => x !== wallet('c1'), 200);
  await assert.rejects(stale, { message: LOCK_LOST });
  assert.deepEqual(w.lockRow(), newerLock, 'The old refresh must not release the lock held by the credential update');
  await assert.rejects(w.store.deleteAsterAccount({ id: uuid('a2'), action: 'remove' }), { message: LOCK_BUSY });

  answer(w, x => x === wallet('c1'), 300);
  await rekey;
  assert.equal(w.lockRow(), null);
  const ledger = w.full();
  assert.deepEqual(ledger.asterAccounts.map(a => [a.id, a.walletAddress, a.value]), [
    [uuid('a0'), wallet('a0'), 100], [uuid('a1'), wallet('c1'), 300], ...ids.slice(2, 9).map(id => [uuid(id), wallet(id), 100]), [uuid('b0'), wallet('b0'), 50],
  ]);
  assert.equal(ledger.assets.find(a => a.mode === 'aster')!.value, 1150);
  const latest = JSON.parse(w.latestDaily()!.data);
  assert.equal(latest.assets.find((a: { mode: string }) => a.mode === 'aster').value, 1150, 'Snapshots keep the newer ledger too');
  // Sources finished while the lease was valid stay saved.
  assert.equal(ledger.fx, 7.25);
  assert.match(ledger.assets.find(a => a.mode === 'market')!.status, /^test · /);
});

test('a live refresh renews its lease past the TTL, keeps edits out and releases only on completion', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: NOW + 7_200_000 });
  const w = imported(t), ids = ['d0', 'd1', 'd2', 'd3'];
  await seedAccounts(w, ids);
  const running = w.store.sync({});
  running.catch(() => {});
  await until(() => w.control.pending.length === 3);
  for (let elapsed = 0; elapsed < 132_000; elapsed += 30_000) t.mock.timers.tick(30_000);
  await assert.rejects(w.store.deleteAsterAccount({ id: uuid('d3'), action: 'remove' }), { message: LOCK_BUSY });

  await drain(w, running, x => ids.map(wallet).includes(x), x => x === wallet('d2') ? new Error('Aster 请求超时') : 200);
  const ledger = await running;
  assert.equal(w.lockRow(), null);
  assert.deepEqual(ledger.ledger!.asterAccounts.map(a => [a.id, a.value, a.error]), [[uuid('d0'), 200, null], [uuid('d1'), 200, null], [uuid('d2'), 100, 'Aster 请求超时'], [uuid('d3'), 200, null]]);
  await w.store.deleteAsterAccount({ id: uuid('d3'), action: 'remove' });
  assert.deepEqual((await w.store.ledger()).ledger!.asterAccounts.map(a => a.id), [uuid('d0'), uuid('d1'), uuid('d2')]);
});

test('Hyperliquid connects by address, keeps the last value on failed refreshes and hides unexpected errors', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: NOW + 10_800_000 });
  const w = imported(t), walletAddress = '0x' + 'ab'.repeat(19) + 'c1';
  w.control.hyperliquid = 123.4;
  let ledger = (await w.store.connect({ exchange: 'hyperliquid', walletAddress })).ledger!;
  const created = ledger.assets.find(a => a.mode === 'hyperliquid')!;
  assert.deepEqual([created.project, created.value, created.status], ['Hyperliquid', 123.4, '只读同步 · 估值时间']);
  assert.deepEqual([ledger.connections.hyperliquid.configured, ledger.connections.hyperliquid.label], [true, 'abc1']);
  assert.deepEqual(w.control.hyperliquidCalls.splice(0), [{ walletAddress, verifyRole: true }]);
  await assert.rejects(w.store.editAsset({ id: created.id, quantity: 1, price: 1 }), /只读接口/);

  w.control.hyperliquid = new Error('Hyperliquid 读取受到限流（HTTP 429）：请稍后重试并减少手动刷新；已保留上次数据');
  ledger = (await w.store.sync({})).ledger!;
  let asset = ledger.assets.find(a => a.mode === 'hyperliquid')!;
  assert.deepEqual([asset.value, asset.status, asset.error], [123.4, '同步失败 · 保留旧值', w.control.hyperliquid.message]);
  assert.equal(ledger.connections.hyperliquid.error, w.control.hyperliquid.message);
  assert.deepEqual(w.control.hyperliquidCalls.splice(0), [{ walletAddress, verifyRole: false }]);

  t.mock.timers.tick(31_000);
  w.control.hyperliquid = new Error('connect ETIMEDOUT secret-host');
  asset = (await w.store.sync({})).ledger!.assets.find(a => a.mode === 'hyperliquid')!;
  assert.equal(asset.error, 'Hyperliquid 同步失败，请更新连接或稍后重试；已保留上次数据');

  t.mock.timers.tick(31_000);
  w.control.hyperliquid = 200;
  ledger = (await w.store.sync({})).ledger!;
  asset = ledger.assets.find(a => a.mode === 'hyperliquid')!;
  assert.deepEqual([asset.value, asset.status, asset.error, ledger.connections.hyperliquid.error], [200, '只读同步 · 估值时间', undefined, null]);
  assert.equal(ledger.assets.filter(a => a.mode === 'hyperliquid').length, 1, 'refresh and reconnect reuse one asset row');

  ledger = (await w.store.disconnect({ exchange: 'hyperliquid' })).ledger!;
  asset = ledger.assets.find(a => a.mode === 'hyperliquid')!;
  assert.deepEqual([ledger.connections.hyperliquid.configured, asset.value, asset.status], [false, 200, '已断开 · 保留旧值']);
});

test('Lighter RH connects by address, keeps the last value on failed refreshes and hides unexpected errors', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: NOW + 14_400_000 });
  const w = imported(t), walletAddress = '0x' + 'cd'.repeat(19) + 'e2';
  w.control.rhLighter = 77.5;
  let ledger = (await w.store.connect({ exchange: 'rh-lighter', walletAddress })).ledger!;
  const created = ledger.assets.find(a => a.mode === 'rh-lighter')!;
  assert.deepEqual([created.project, created.value, created.status], ['Lighter RH', 77.5, '只读同步 · 获取时间']);
  assert.deepEqual([ledger.connections['rh-lighter'].configured, ledger.connections['rh-lighter'].label], [true, 'cde2']);
  assert.deepEqual(w.control.rhLighterCalls.splice(0), [walletAddress]);
  await assert.rejects(w.store.editAsset({ id: created.id, quantity: 1, price: 1 }), /只读接口/);

  w.control.rhLighter = new Error('Lighter RH 读取受到限流：60 秒内不再请求，请减少手动刷新；已保留上次数据');
  ledger = (await w.store.sync({})).ledger!;
  let asset = ledger.assets.find(a => a.mode === 'rh-lighter')!;
  assert.deepEqual([asset.value, asset.status, asset.error], [77.5, '同步失败 · 保留旧值', w.control.rhLighter.message]);
  assert.equal(ledger.connections['rh-lighter'].error, w.control.rhLighter.message);
  assert.deepEqual(w.control.rhLighterCalls.splice(0), [walletAddress]);

  t.mock.timers.tick(31_000);
  w.control.rhLighter = new Error('connect ECONNRESET secret-host');
  asset = (await w.store.sync({})).ledger!.assets.find(a => a.mode === 'rh-lighter')!;
  assert.equal(asset.error, 'Lighter RH 同步失败，请更新连接或稍后重试；已保留上次数据');

  t.mock.timers.tick(31_000);
  w.control.rhLighter = 90;
  ledger = (await w.store.sync({})).ledger!;
  asset = ledger.assets.find(a => a.mode === 'rh-lighter')!;
  assert.deepEqual([asset.value, asset.status, asset.error, ledger.connections['rh-lighter'].error], [90, '只读同步 · 获取时间', undefined, null]);
  assert.equal(ledger.assets.filter(a => a.mode === 'rh-lighter').length, 1, 'refresh and reconnect reuse one asset row');

  ledger = (await w.store.disconnect({ exchange: 'rh-lighter' })).ledger!;
  asset = ledger.assets.find(a => a.mode === 'rh-lighter')!;
  assert.deepEqual([ledger.connections['rh-lighter'].configured, asset.value, asset.status], [false, 90, '已断开 · 保留旧值']);
  w.control.rhLighterCalls.length = 0;
  await w.store.sync({});
  assert.deepEqual(w.control.rhLighterCalls, [], 'a disconnected address is not read');
});

test('同步：距上次尝试不足 30 秒时直接返回当前账本，不读任何外部接口；满 30 秒再读', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: NOW });
  const w = imported(t);
  await w.store.sync({});
  assert.equal(w.control.reads, 1);
  t.mock.timers.tick(29_000);
  assert.deepEqual(await w.store.sync({}), await w.store.ledger());
  assert.equal(w.control.reads, 1, '节流期内不读行情');
  t.mock.timers.tick(1_000);
  await w.store.sync({});
  assert.equal(w.control.reads, 2);
  assert.equal(w.lockRow(), null);
});

test('同步：读取途中凭据被换掉时，旧凭据读到的结果不写入；同步照常完成', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: NOW });
  const w = imported(t);
  w.control.okx = 10;
  await w.store.connect({ exchange: 'okx', apiKey: 'okx-key-0001', apiSecret: 'okx-secret-0001', passphrase: 'pass' });
  t.mock.timers.tick(31_000);
  w.control.okx = 'hold';
  const running = w.store.sync({});
  await until(() => w.control.okxPending.length === 1);
  // Another writer (a lapsed lease's successor) saved a newer credential while the read was out.
  w.writable(database => database.prepare("UPDATE connections SET encrypted = 'newer' WHERE exchange = 'okx'").run());
  w.control.okxPending[0]!.resolve(999);
  const ledger = (await running).ledger!;
  const okx = ledger.assets.find(a => a.mode === 'okx')!;
  assert.deepEqual([okx.value, okx.status], [10, '只读同步']);
  assert.equal(ledger.fx, 7.25, '其他来源照常写入');
  assert.equal(w.lockRow(), null);
});

test('同步：读取途中账本被重新导入时 409（reimported），不写任何结果，锁照常释放', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: NOW });
  const w = imported(t);
  w.control.okx = 10;
  await w.store.connect({ exchange: 'okx', apiKey: 'okx-key-0001', apiSecret: 'okx-secret-0001', passphrase: 'pass' });
  t.mock.timers.tick(31_000);
  w.control.okx = 'hold';
  const running = w.store.sync({});
  running.catch(() => {});
  await until(() => w.control.okxPending.length === 1);
  w.load();
  w.control.okxPending[0]!.resolve(999);
  await assert.rejects(running, { code: 'reimported', message: LEDGER_REIMPORTED });
  const ledger = w.full();
  assert.equal(ledger.assets.find(a => a.mode === 'okx'), undefined, '重新导入的账本没有被旧同步改动');
  assert.deepEqual(w.connections(), [], '命令行导入不带连接，已保存的连接一并替换');
  assert.equal(w.lockRow(), null);
});

test('连接：验证通过才保存（用本服务密钥加密，附加数据为连接名）；验证失败什么都不改；断开保留旧值', async t => {
  const w = imported(t);
  const credential = { exchange: 'binance', apiKey: 'binance-key-B1N4', apiSecret: 'binance-secret-0001' };
  w.control.binance = new Error('Binance API Key 无效或权限不足');
  const before = w.full();
  await assert.rejects(w.store.connect(credential), { message: 'Binance API Key 无效或权限不足' });
  assert.deepEqual(w.connections(), []);
  assert.deepEqual(w.full().assets, before.assets);

  w.control.binance = 4_321;
  const view = await w.store.connect(credential);
  const asset = view.ledger!.assets.find(a => a.mode === 'binance')!;
  assert.deepEqual([asset.project, asset.value, asset.status], ['binance', 4_321, '只读同步']);
  assert.deepEqual([view.ledger!.connections.binance.configured, view.ledger!.connections.binance.label], [true, 'B1N4']);
  const [row] = w.connections();
  assert.equal(row!.exchange, 'binance');
  assert.deepEqual(unseal(row!.encrypted, 'binance', credentialKey(w.dataDir)), credential);
  assert.ok(JSON.parse(w.latestDaily()!.data).assets.some((a: { mode: string; value: number }) => a.mode === 'binance' && a.value === 4_321), '连接与当天快照一起写入');

  const off = await w.store.disconnect({ exchange: 'binance' });
  assert.deepEqual([off.ledger!.connections.binance.configured, off.ledger!.assets.find(a => a.mode === 'binance')!.status], [false, '已断开 · 保留旧值']);
  assert.deepEqual(w.connections(), []);
  // A connect on a ledger with two rows of one exchange is refused before anything is read.
  await assert.rejects(w.store.connect({ exchange: 'gate', apiKey: 'gate-key-01', apiSecret: 'gatesecret' }), /not configured|no network|Gate/);
});

test('Aster 账号：新增、重名、重复钱包、更新不存在的账号、断开与移除，按工作台的规则与文字', async t => {
  const w = imported(t);
  w.control.values.set(wallet('e0'), 40);
  await w.store.saveAsterAccount(input('e0'), false);
  await assert.rejects(w.store.saveAsterAccount(input('e0'), false), { message: '账号已存在，请使用更新连接' });
  await assert.rejects(w.store.saveAsterAccount({ ...input('e1'), name: 'E0' }, false), { message: '账号名称已存在' });
  await assert.rejects(w.store.saveAsterAccount(input('e1', wallet('e0')), false), { message: '该 API 钱包已存在，请更新或移除已有账号' });
  await assert.rejects(w.store.saveAsterAccount(input('e2'), true), { message: '未找到该 Aster 账号，请刷新页面' });
  // The saved account list lost its wallet (as an import leaves it): the check reads the sealed connection.
  w.writable(database => database.prepare("UPDATE settings SET value = json_remove(value, '$[0].walletAddress') WHERE key = 'aster-accounts'").run());
  await assert.rejects(w.store.saveAsterAccount(input('e1', wallet('e0')), false), { message: '该 API 钱包已连接，请更新已有账号' });
  let view = await w.store.ledger();
  assert.deepEqual(view.ledger!.asterAccounts.map(a => [a.name, a.value, a.label, a.configured]), [['E0', 40, '00e0', true]]);
  assert.ok(!('walletAddress' in view.ledger!.asterAccounts[0]!), '页面视图不带钱包地址');
  assert.deepEqual(w.connections().map(row => row.exchange), [`aster:${uuid('e0')}`]);

  view = await w.store.deleteAsterAccount({ id: uuid('e0'), action: 'disconnect' });
  assert.deepEqual([view.ledger!.asterAccounts[0]!.configured, view.ledger!.connections.aster.configured], [false, false]);
  assert.deepEqual(w.connections(), []);
  view = await w.store.deleteAsterAccount({ id: uuid('e0'), action: 'remove' });
  assert.deepEqual(view.ledger!.asterAccounts, []);
  await assert.rejects(w.store.deleteAsterAccount({ id: uuid('e0'), action: 'remove' }), { message: '未找到该 Aster 账号，请刷新页面' });
  // Without an Aster row nothing is read and the account is refused.
  w.writable(database => database.prepare("DELETE FROM assets WHERE json_extract(data, '$.mode') = 'aster'").run());
  await assert.rejects(w.store.saveAsterAccount(input('e3'), false), { message: '未找到交易所资产' });
});

test('同步：保存的连接解不开（密钥文件丢了）时记为该来源的失败并保留旧值，不中断同步', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: NOW });
  const w = imported(t);
  w.control.okx = 10;
  await w.store.connect({ exchange: 'okx', apiKey: 'okx-key-0001', apiSecret: 'okx-secret-0001', passphrase: 'pass' });
  rmSync(join(w.dataDir, CREDENTIAL_KEY_FILE));
  t.mock.timers.tick(31_000);
  const ledger = (await w.store.sync({})).ledger!;
  const okx = ledger.assets.find(a => a.mode === 'okx')!;
  assert.deepEqual([okx.value, okx.status], [10, '同步失败 · 保留旧值']);
  assert.match(okx.error ?? '', /decrypt failed/);
  assert.equal(ledger.fx, 7.25);
});

const TOKEN = 'asset-access-token-0003';
const SESSION = 'asset-session-value-0003';
test('连接与同步接口：POST 成功返回 GET 账本同形；403、400、409、503；任何回应都不含凭据', async t => {
  const w = imported(t);
  const secrets = ['binance-secret-0001', 'binance-key-B1N4', PRIVATE_KEY, wallet('f0'), 'okx-secret-0001'];
  const h = createHarness();
  bindAccounts(h.ex);
  const server = createExecutorServer({ executor: h.ex, accessToken: TOKEN, session: SESSION, views: { asset: w.store } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const texts: string[] = [];
  try {
    const cookie = ((await fetch(`${base}/login?token=${TOKEN}`, { redirect: 'manual' })).headers.get('set-cookie') ?? '').split(';')[0]!;
    const post = async (path: string, body: unknown, headers: Record<string, string> = { 'x-pa-executor': '1', 'content-type': 'application/json' }) => {
      const response = await fetch(base + path, { method: 'POST', headers: { cookie, ...headers }, body: JSON.stringify(body) });
      const text = await response.text(); texts.push(text);
      return { status: response.status, body: JSON.parse(text) as Record<string, unknown> };
    };
    const ledger = async () => (await fetch(base + '/api/asset/ledger', { headers: { cookie } })).json();

    assert.equal((await post('/api/asset/sync', {}, { 'content-type': 'application/json' })).status, 403);
    assert.equal((await post('/api/asset/connections', { exchange: 'binance', apiKey: 'binance-key-B1N4', apiSecret: 'binance-secret-0001' }, { 'content-type': 'application/json' })).status, 403);
    assert.equal((await fetch(base + '/api/asset/sync', { headers: { cookie } })).status, 404, '只收 POST');

    w.control.binance = 50;
    const connected = await post('/api/asset/connections', { exchange: 'binance', apiKey: 'binance-key-B1N4', apiSecret: 'binance-secret-0001' });
    assert.equal(connected.status, 200);
    assert.deepEqual(connected.body, await ledger());
    const synced = await post('/api/asset/sync', null);
    assert.equal(synced.status, 200);
    assert.deepEqual(synced.body, await ledger());
    w.control.values.set(wallet('f0'), 5);
    assert.equal((await post('/api/asset/aster-accounts/add', input('f0'))).status, 200);
    assert.equal((await post('/api/asset/aster-accounts/edit', { ...input('f0'), includeSpot: true })).status, 200);
    assert.equal((await post('/api/asset/aster-accounts/delete', { id: uuid('f0'), action: 'disconnect' })).status, 200);
    assert.equal((await post('/api/asset/connections/delete', { exchange: 'binance' })).status, 200);

    const invalid = await post('/api/asset/connections', { exchange: 'binance', apiKey: 'k', apiSecret: 'binance-secret-0001' });
    assert.deepEqual([invalid.status, invalid.body], [400, { code: 'invalid_input', message: '输入格式不正确，请检查数值和连接信息' }]);
    assert.equal((await post('/api/asset/aster-accounts/delete', { id: uuid('f0'), action: 'purge' })).status, 400);
    w.control.binance = new Error('Binance API Key 无效或权限不足');
    const refused = await post('/api/asset/connections', { exchange: 'binance', apiKey: 'binance-key-B1N4', apiSecret: 'binance-secret-0001' });
    assert.deepEqual([refused.status, refused.body], [400, { code: 'asset_rejected', message: 'Binance API Key 无效或权限不足' }]);
    w.control.binance = new TypeError('fetch failed');
    const network = await post('/api/asset/connections', { exchange: 'binance', apiKey: 'binance-key-B1N4', apiSecret: 'binance-secret-0001' });
    assert.deepEqual([network.status, network.body], [503, { code: 'asset_unavailable', message: '服务暂时不可用，已保留上次数据，请稍后重试' }]);
    w.control.okx = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    assert.equal((await post('/api/asset/connections', { exchange: 'okx', apiKey: 'okx-key-0001', apiSecret: 'okx-secret-0001', passphrase: 'p' })).status, 503);

    const other = openAssetDb(w.file, { mode: 'service' });
    const lease = await acquireSyncLock(other, { now: () => Date.now() });
    try {
      const busy = await post('/api/asset/sync', {});
      assert.deepEqual([busy.status, busy.body], [409, { code: 'busy', message: LOCK_BUSY }]);
    } finally { await lease.release(); other.close(); }

    texts.push(JSON.stringify(await ledger()), JSON.stringify(await (await fetch(base + '/api/asset/history', { headers: { cookie } })).json()));
    for (const secret of secrets) assert.ok(!texts.some(text => text.includes(secret)), `回应含 ${secret.slice(0, 10)}…`);
  } finally { await new Promise(resolve => server.close(resolve)); h.dispose(); }
});
