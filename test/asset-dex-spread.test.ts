import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createExecutorServer } from '../src/http.ts';
import { ASSET_DB_FILE, openAssetDb, type AssetDb } from '../src/asset/db.ts';
import { CREDENTIAL_KEY_FILE } from '../src/asset/credentials.ts';
import { importLedger } from '../src/asset/import.ts';
import { createAssetStore, currentLedger } from '../src/asset/store.ts';
import type { AssetSources } from '../src/asset/sync.ts';
import { aggregateDexSpread, hashAddress, hashLighterIndex, hashRhIndex } from '../src/asset/dex-spread.ts';
import { importPlan } from '../src/asset/source-import.ts';
import { EXAMPLE_SOURCE, parseSource } from '../src/asset/source-ledger.ts';
import type { Balance, FxStatus } from '../src/asset/types.ts';
import type { DexAccountsState } from '../src/dex/keys.ts';
import { bindAccounts, createHarness } from './harness.ts';
import { OWNER, dayBefore, writeWorkbenchLedger } from './asset-fixture.ts';

const NOW = Date.parse('2026-11-10T04:00:00Z');
const ADDR_A = '0x' + 'aa'.repeat(20);
const ADDR_B = '0x' + 'bb'.repeat(20);
const L1_X = '0x' + '11'.repeat(20);
const L1_Y = '0x' + '22'.repeat(20);

function setup(t: TestContext, { emptyExample = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tp-dex-spread-'));
  const from = join(root, 'ledger.sqlite'), dataDir = join(root, 'data'), file = join(dataDir, ASSET_DB_FILE);
  writeWorkbenchLedger(from, { now: NOW });
  importLedger({ from, owner: OWNER, dataDir, now: () => NOW });
  if (process.platform === 'win32') writeFileSync(join(dataDir, CREDENTIAL_KEY_FILE), '1'.repeat(64) + '\n', { mode: 0o600, flag: 'wx' });
  const writable = (run: (db: AssetDb) => void) => { const db = openAssetDb(file, { mode: 'service' }); try { run(db); } finally { db.close(); } };
  if (emptyExample) {
    writable(db => {
      const source = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'source-ledger'").get<{ value: string }>()!.value);
      db.prepare("UPDATE settings SET value = ? WHERE key = 'source-ledger'").bind(JSON.stringify({ ...source, source: EXAMPLE_SOURCE })).run();
    });
  }
  const control = {
    dexState: { accounts: {}, problem: null } as DexAccountsState,
    dexThrows: null as Error | null,
    hlValues: new Map<string, number | Error>(),
    hlCalls: [] as string[],
    rhWalletValues: new Map<string, number | Error>(),
    rhWalletIndices: new Map<string, number[]>(),
    rhWalletCalls: [] as string[],
    rhSingleValues: new Map<number, { l1Address: string; total: number } | Error>(),
    rhSingleCalls: [] as number[],
    lighterValues: new Map<number, { l1Address: string; total: number } | Error>(),
    lighterCalls: [] as number[],
    onBeforeLighter: null as null | (() => Promise<void> | void),
  };
  const nowIso = () => new Date(Date.now()).toISOString();
  const sources: Partial<AssetSources> = {
    async quotes() { const at = nowIso(); return { VIRTUAL: { price: 75_000, at, source: 'test' }, USDC: { price: 1, at, source: 'test' }, USDT: { price: 1, at, source: 'test' } }; },
    async yuanQuote(): Promise<{ rate: number; status: FxStatus }> { return { rate: 7.2, status: { source: 'Coinbase', fetchedAt: nowIso(), rateDate: null, error: null } }; },
    syncAster: async () => ({ total: 5400, details: [{ coin: 'USDT', account: '合约', quantity: 5400, price: 1, value: 5400 }] }),
    syncBybit: async () => ({ total: 13600, details: [{ coin: 'USDT', account: '统一账户', quantity: 13600, price: 1, value: 13600 }] }),
    syncHyperliquid: async c => {
      const addr = c.walletAddress.toLowerCase();
      control.hlCalls.push(addr);
      const val = control.hlValues.get(addr);
      if (val instanceof Error) throw val;
      const total = val ?? 0;
      return { total, details: [{ coin: 'USDC', account: '永续 · io（Entropy） · 账户权益（含未实现盈亏）', quantity: total, price: 1, value: total }] as Balance[], updatedAt: nowIso() };
    },
    syncRhLighter: async c => {
      const addr = c.walletAddress.toLowerCase();
      control.rhWalletCalls.push(addr);
      const val = control.rhWalletValues.get(addr);
      if (val instanceof Error) throw val;
      const total = val ?? 0;
      return { total, details: [{ coin: 'USDG', account: '账户总值（含未实现盈亏）', quantity: total, price: 1, value: total }], updatedAt: nowIso() };
    },
    rhLighterAccountIndices: async c => control.rhWalletIndices.get(c.walletAddress.toLowerCase()) ?? [],
    syncRhLighterAccount: async accountIndex => {
      control.rhSingleCalls.push(accountIndex);
      const val = control.rhSingleValues.get(accountIndex);
      if (val instanceof Error) throw val;
      if (!val) throw new Error('Lighter RH 未找到该编号的账户：请确认填写的账户编号正确');
      return { accountIndex, l1Address: val.l1Address, total: val.total, details: [{ coin: 'USDG', account: '账户总值（含未实现盈亏）', quantity: val.total, price: 1, value: val.total }], updatedAt: nowIso() };
    },
    syncLighterAccount: async accountIndex => {
      if (control.onBeforeLighter) await control.onBeforeLighter();
      control.lighterCalls.push(accountIndex);
      const val = control.lighterValues.get(accountIndex);
      if (val instanceof Error) throw val;
      if (!val) throw new Error('Lighter 主网 未找到该编号的账户：请确认填写的账户编号正确');
      return { accountIndex, l1Address: val.l1Address, total: val.total, details: [{ coin: 'USDC', account: '账户总值（含未实现盈亏）', quantity: val.total, price: 1, value: val.total }], updatedAt: nowIso() };
    },
  };
  const store = createAssetStore(file, {
    now: () => Date.now(),
    fetch: async () => { throw new Error('no network in tests'); },
    sources,
    dexAccounts: async () => {
      if (control.dexThrows) throw control.dexThrows;
      return control.dexState;
    },
  });
  const peek = <T>(run: (db: AssetDb) => T): T => { const db = openAssetDb(file, { readOnly: true }); try { return run(db); } finally { db.close(); } };
  t.after(() => {
    store.close();
    for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
      chmodSync(join(dataDir, entry.name), entry.isDirectory() ? 0o700 : 0o644);
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, dataDir, file, store, control, writable, peek };
}

test('DEX 价差纯聚合：单向指纹区分场所，多账户取最早更新时间与局部错误语义', () => {
  assert.notEqual(hashAddress(ADDR_A), hashRhIndex(7));
  assert.notEqual(hashRhIndex(7), hashLighterIndex(7));
  assert.equal(hashAddress(ADDR_A.toUpperCase()), hashAddress(ADDR_A));

  assert.equal(aggregateDexSpread({ accounts: [], deduped: ['entropy'] }, undefined, () => ({ id: 'row-9', cell: 'E9' }), '2026-11-10T04:00:00Z'), null);

  const asset = aggregateDexSpread({
    accounts: [
      { venue: 'lighter', accountHash: hashLighterIndex(1), value: 300, details: [{ coin: 'USDC', account: '账户总值', quantity: 300, price: 1, value: 300 }], updatedAt: '2026-11-10T03:50:00.000Z', error: null },
      { venue: 'rh', accountHash: hashRhIndex(2), value: 200, details: [{ coin: 'USDG', account: '账户总值', quantity: 200, price: 1, value: 200 }], updatedAt: '2026-11-10T03:55:00.000Z', error: 'Lighter RH 限流' },
    ],
    deduped: ['entropy'],
  }, undefined, () => ({ id: 'row-9', cell: 'E9' }), '2026-11-10T04:00:00.000Z')!;
  assert.equal(asset.id, 'row-9');
  assert.equal(asset.mode, 'dex-spread');
  assert.equal(asset.value, 500);
  assert.equal(asset.updatedAt, '2026-11-10T03:50:00.000Z');
  assert.equal(asset.status, '部分账号未更新 · 保留旧值');
  assert.match(asset.error!, /Lighter RH：Lighter RH 限流/);
  assert.equal(asset.details?.at(-1)?.coin, '—');
  assert.match(asset.details?.at(-1)?.account ?? '', /已去重（已在资产连接中计入）：Entropy（Hyperliquid）/);
});

test('DEX 价差计入资产总计、分交易所合计、日快照与日变化归因，且库与接口不含明文标识', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: NOW + 3_600_000 });
  const w = setup(t);
  const baseLedger = await w.store.ledger();
  const baseTotal = baseLedger.summary!.valuation.total;

  w.control.dexState = {
    accounts: { lighter: { accountIndex: 918273 }, rh: { accountIndex: 827364 }, entropy: { address: ADDR_A } },
    problem: null,
  };
  w.control.lighterValues.set(918273, { l1Address: L1_X, total: 1000 });
  w.control.rhSingleValues.set(827364, { l1Address: L1_Y, total: 500 });
  w.control.hlValues.set(ADDR_A, 300);

  const synced = await w.store.sync({});
  const dexRow = synced.ledger!.assets.find(a => a.mode === 'dex-spread')!;
  assert.ok(dexRow);
  assert.deepEqual([dexRow.project, dexRow.value, dexRow.status], ['DEX 价差', 1800, '只读同步 · 3 个账号']);
  assert.equal(synced.summary!.valuation.total, baseTotal + 1800);
  assert.equal(synced.summary!.exchanges.total, baseLedger.summary!.exchanges.total + 1800);
  assert.equal(synced.summary!.measures.held, baseLedger.summary!.measures.held + 1800);
  assert.equal(synced.summary!.measures.adjusted, baseLedger.summary!.measures.adjusted + 1800);
  assert.deepEqual(synced.summary!.byExchange.find(item => item.mode === 'dex-spread'), { mode: 'dex-spread', name: 'DEX 价差', total: 1800, partial: false, rows: 1 });
  await assert.rejects(w.store.editAsset({ id: dexRow.id, quantity: 1, price: 1 }), /只读接口/);

  const history = await w.store.history();
  assert.equal(history.trend.at(-1)?.adjusted, synced.summary!.measures.adjusted);
  const changes = await w.store.dailyChanges();
  assert.ok(changes.days[0]?.sources.some(s => s.project === 'DEX 价差' && s.current === 1800));

  // Verify zero plaintext identifiers in SQLite or ledger response.
  const rawDb = w.peek(db => JSON.stringify([
    db.prepare('SELECT id, data FROM assets').rows(),
    db.prepare('SELECT key, value FROM settings').rows(),
    db.prepare('SELECT date, data FROM snapshots').rows(),
  ]));
  const rawView = JSON.stringify(synced);
  for (const sensitive of [ADDR_A, L1_X, L1_Y, '918273', '827364']) {
    assert.equal(rawDb.toLowerCase().includes(sensitive), false, `db leaks ${sensitive}`);
    assert.equal(rawView.toLowerCase().includes(sensitive), false, `view leaks ${sensitive}`);
  }
});

test('DEX 价差去重矩阵：HL 同地址去重与异地址保留；RH 第一道与第二道去重', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: NOW + 7_200_000 });
  const w = setup(t);
  w.control.hlValues.set(ADDR_A, 2000);
  w.control.hlValues.set(ADDR_B, 400);
  w.control.rhWalletValues.set(L1_X, 3000);
  w.control.rhWalletIndices.set(L1_X, [7, 8]);
  w.control.rhSingleValues.set(7, { l1Address: L1_X, total: 3000 });
  w.control.rhSingleValues.set(99, { l1Address: L1_Y, total: 600 });

  await w.store.connect({ exchange: 'hyperliquid', walletAddress: ADDR_A });
  await w.store.connect({ exchange: 'rh-lighter', walletAddress: L1_X });

  // 1) Entropy = ADDR_A (same), RH = #7 (first-pass dedup via rhLighterAccountIndices -> 0 by=index calls)
  w.control.dexState = { accounts: { entropy: { address: ADDR_A }, rh: { accountIndex: 7 } }, problem: null };
  w.control.hlCalls.length = 0;
  w.control.rhSingleCalls.length = 0;
  t.mock.timers.tick(31_000);
  let view = await w.store.sync({});
  assert.equal(view.ledger!.assets.some(a => a.mode === 'dex-spread'), false, '全部去重后不生成 DEX 价差行');
  assert.deepEqual(w.control.hlCalls, [ADDR_A], 'Entropy 未重复请求');
  assert.deepEqual(w.control.rhSingleCalls, [], '第一道去重命中，未发 RH by=index 请求');

  // 2) Entropy = ADDR_B (different), RH = #99 (different L1_Y) -> both kept
  w.control.dexState = { accounts: { entropy: { address: ADDR_B }, rh: { accountIndex: 99 } }, problem: null };
  t.mock.timers.tick(31_000);
  view = await w.store.sync({});
  let dexRow = view.ledger!.assets.find(a => a.mode === 'dex-spread')!;
  assert.deepEqual([dexRow.value, dexRow.status], [1000, '只读同步 · 2 个账号']);
  assert.deepEqual(w.control.rhSingleCalls, [99]);

  // 3) RH syncRhLighter fails this round, DEX has RH #7 -> second-pass dedup via l1Address === L1_X
  w.control.rhWalletValues.set(L1_X, new Error('Lighter RH 读取失败：网络请求未完成或超时，请稍后重试；已保留上次数据'));
  w.control.dexState = { accounts: { entropy: { address: ADDR_B }, rh: { accountIndex: 7 } }, problem: null };
  // Clear saved indexHashes to explicitly exercise second-pass l1Address dedup when rh-lighter fails!
  w.writable(db => db.prepare("UPDATE settings SET value = ? WHERE key = 'dex-dedup-identities'").bind(JSON.stringify({ hyperliquid: { walletHash: hashAddress(ADDR_A) }, 'rh-lighter': { walletHash: hashAddress(L1_X) } })).run());
  w.control.rhSingleCalls.length = 0;
  t.mock.timers.tick(31_000);
  view = await w.store.sync({});
  dexRow = view.ledger!.assets.find(a => a.mode === 'dex-spread')!;
  assert.deepEqual(w.control.rhSingleCalls, [7], '走第二道 by=index 查得 L1 后去重');
  assert.equal(dexRow.value, 400, 'RH #7 被第二道去重剔除，仅计入 Entropy B');
  assert.match(dexRow.details?.at(-1)?.account ?? '', /Lighter RH/);
});

test('原子防瞬间双算与断开保留：先同步 DEX 再连 HL/RH 立即剔除，断开保留旧值仍防双算', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: NOW + 10_800_000 });
  const w = setup(t);
  w.control.dexState = {
    accounts: { lighter: { accountIndex: 101 }, rh: { accountIndex: 7 }, entropy: { address: ADDR_A } },
    problem: null,
  };
  w.control.lighterValues.set(101, { l1Address: L1_X, total: 1000 });
  w.control.rhSingleValues.set(7, { l1Address: L1_X, total: 500 });
  w.control.hlValues.set(ADDR_A, 300);

  let view = await w.store.sync({});
  assert.equal(view.ledger!.assets.find(a => a.mode === 'dex-spread')?.value, 1800);

  // Connect HL ADDR_A -> atomically drops Entropy 300 from dex-spread in the same commit + snapshot!
  view = await w.store.connect({ exchange: 'hyperliquid', walletAddress: ADDR_A });
  assert.equal(view.ledger!.assets.find(a => a.mode === 'hyperliquid')?.value, 300);
  assert.equal(view.ledger!.assets.find(a => a.mode === 'dex-spread')?.value, 1500);
  const snap1 = JSON.parse(w.peek(db => db.prepare("SELECT data FROM snapshots WHERE date GLOB '[0-9]*' ORDER BY date DESC LIMIT 1").get<{ data: string }>()!.data)) as { assets: { mode: string; value: number }[] };
  assert.equal(snap1.assets.find(a => a.mode === 'dex-spread')?.value, 1500, '日快照同样无瞬间双算');

  // Connect RH L1_X -> atomically drops RH 500 from dex-spread!
  w.control.rhWalletValues.set(L1_X, 500);
  w.control.rhWalletIndices.set(L1_X, [7]);
  view = await w.store.connect({ exchange: 'rh-lighter', walletAddress: L1_X });
  assert.equal(view.ledger!.assets.find(a => a.mode === 'rh-lighter')?.value, 500);
  assert.equal(view.ledger!.assets.find(a => a.mode === 'dex-spread')?.value, 1000);

  // Disconnect HL (retains 300 on HL row) -> sync must still dedup Entropy ADDR_A!
  await w.store.disconnect({ exchange: 'hyperliquid' });
  t.mock.timers.tick(31_000);
  view = await w.store.sync({});
  assert.equal(view.ledger!.assets.find(a => a.mode === 'hyperliquid')?.value, 300);
  assert.equal(view.ledger!.assets.find(a => a.mode === 'dex-spread')?.value, 1000, '断开保留旧值期间仍去重');

  // Reconnect HL to a DIFFERENT address ADDR_B -> next sync restores Entropy ADDR_A into dex-spread!
  w.control.hlValues.set(ADDR_B, 900);
  await w.store.connect({ exchange: 'hyperliquid', walletAddress: ADDR_B });
  t.mock.timers.tick(31_000);
  view = await w.store.sync({});
  assert.equal(view.ledger!.assets.find(a => a.mode === 'hyperliquid')?.value, 900);
  assert.equal(view.ledger!.assets.find(a => a.mode === 'dex-spread')?.value, 1300);

  // Disconnect RH (retains 500 on RH row) -> sync must still dedup RH #7!
  await w.store.disconnect({ exchange: 'rh-lighter' });
  t.mock.timers.tick(31_000);
  view = await w.store.sync({});
  assert.equal(view.ledger!.assets.find(a => a.mode === 'rh-lighter')?.value, 500);
  assert.equal(view.ledger!.assets.find(a => a.mode === 'dex-spread')?.value, 1300, 'RH 断开保留旧值期间仍去重');

  // Reconnect RH to a DIFFERENT L1 address L1_Y -> next sync restores RH #7 (500) into dex-spread!
  w.control.rhWalletValues.set(L1_Y, 650);
  w.control.rhWalletIndices.set(L1_Y, [99]);
  await w.store.connect({ exchange: 'rh-lighter', walletAddress: L1_Y });
  t.mock.timers.tick(31_000);
  view = await w.store.sync({});
  assert.equal(view.ledger!.assets.find(a => a.mode === 'rh-lighter')?.value, 650);
  assert.equal(view.ledger!.assets.find(a => a.mode === 'dex-spread')?.value, 1800);
});

test('失败与边界场景：密文损坏保守拒绝、移除账号删行、DEX 故障保留旧行/无行不建、新账号失败不继承旧值、导入保留', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: NOW + 14_400_000 });
  const w = setup(t);

  // 1) DEX unavailable when no dex-spread row exists -> creates nothing.
  w.control.dexThrows = new Error('socket ENOENT');
  let view = await w.store.sync({});
  assert.equal(view.ledger!.assets.some(a => a.mode === 'dex-spread'), false);

  // 2) Normal sync creates dex-spread row.
  w.control.dexThrows = null;
  w.control.dexState = { accounts: { lighter: { accountIndex: 101 }, entropy: { address: ADDR_A } }, problem: null };
  w.control.lighterValues.set(101, { l1Address: L1_X, total: 1000 });
  w.control.hlValues.set(ADDR_A, 400);
  t.mock.timers.tick(31_000);
  view = await w.store.sync({});
  assert.equal(view.ledger!.assets.find(a => a.mode === 'dex-spread')?.value, 1400);

  // 3) DEX returns problem -> preserves 1400, marks sync failure & partial snapshot.
  w.control.dexState = { accounts: {}, problem: '实盘凭据文件读不懂' };
  t.mock.timers.tick(31_000);
  view = await w.store.sync({});
  let dexRow = view.ledger!.assets.find(a => a.mode === 'dex-spread')!;
  assert.deepEqual([dexRow.value, dexRow.status, dexRow.error], [1400, '同步失败 · 保留旧值', '实盘凭据文件读不懂']);
  const partialSnap = JSON.parse(w.peek(db => db.prepare("SELECT data FROM snapshots WHERE date GLOB '[0-9]*' ORDER BY date DESC LIMIT 1").get<{ data: string }>()!.data)) as { partial: boolean };
  assert.equal(partialSnap.partial, true);

  // 4) Change Lighter to a NEW index 888 whose first read fails -> must NOT inherit 1000 from 101!
  w.control.dexState = { accounts: { lighter: { accountIndex: 888 }, entropy: { address: ADDR_A } }, problem: null };
  w.control.lighterValues.set(888, new Error('Lighter 主网 读取受到限流：60 秒内不再请求，请减少手动刷新；已保留上次数据'));
  t.mock.timers.tick(31_000);
  view = await w.store.sync({});
  dexRow = view.ledger!.assets.find(a => a.mode === 'dex-spread')!;
  assert.deepEqual([dexRow.value, dexRow.status], [null, '部分账号估值缺失']);
  assert.equal(view.summary!.valuation.partial, true);

  // 5) Restore 101 and corrupt HL ciphertext -> conservative refusal for Entropy, never silently double-counts!
  w.control.dexState = { accounts: { lighter: { accountIndex: 101 }, entropy: { address: ADDR_A } }, problem: null };
  await w.store.connect({ exchange: 'hyperliquid', walletAddress: ADDR_B });
  w.writable(db => db.prepare("UPDATE connections SET encrypted = 'corrupt' WHERE exchange = 'hyperliquid'").run());
  t.mock.timers.tick(31_000);
  view = await w.store.sync({});
  dexRow = view.ledger!.assets.find(a => a.mode === 'dex-spread')!;
  assert.equal(dexRow.value, null);
  assert.match(dexRow.error!, /无法核对与 Hyperliquid 连接是否重复/);

  // Fix HL back, corrupt RH ciphertext -> conservative refusal for RH, never silently double-counts!
  await w.store.connect({ exchange: 'hyperliquid', walletAddress: ADDR_B });
  w.control.dexState = { accounts: { lighter: { accountIndex: 101 }, rh: { accountIndex: 7 } }, problem: null };
  await w.store.connect({ exchange: 'rh-lighter', walletAddress: L1_X });
  w.writable(db => db.prepare("UPDATE connections SET encrypted = 'corrupt' WHERE exchange = 'rh-lighter'").run());
  t.mock.timers.tick(31_000);
  view = await w.store.sync({});
  dexRow = view.ledger!.assets.find(a => a.mode === 'dex-spread')!;
  assert.equal(dexRow.value, null);
  assert.match(dexRow.error!, /无法核对与 Lighter RH 连接是否重复/);

  // Fix RH back and test single remaining account + removing all DEX accounts deletes the dex-spread row.
  await w.store.connect({ exchange: 'rh-lighter', walletAddress: L1_X });
  w.control.dexState = { accounts: { lighter: { accountIndex: 101 } }, problem: null };
  t.mock.timers.tick(31_000);
  view = await w.store.sync({});
  assert.equal(view.ledger!.assets.find(a => a.mode === 'dex-spread')?.value, 1000);

  w.control.dexState = { accounts: {}, problem: null };
  t.mock.timers.tick(31_000);
  view = await w.store.sync({});
  assert.equal(view.ledger!.assets.some(a => a.mode === 'dex-spread'), false);
});

test('原表导入保留 DEX 价差已同步余额，HTTP 接口返回的账本不含敏感信息', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: NOW + 18_000_000 });
  const w = setup(t, { emptyExample: true });
  w.control.dexState = { accounts: { lighter: { accountIndex: 101 } }, problem: null };
  w.control.lighterValues.set(101, { l1Address: L1_X, total: 750 });
  await w.store.sync({});

  const rows = [
    { id: 'row-2', project: 'bybit', kind: '交易所', quantity: null, price: null, value: 12_000, cell: 'G2', formula: null },
    { id: 'row-3', project: 'aster', kind: '交易所', quantity: null, price: null, value: 6_000, cell: 'G3', formula: null },
    { id: 'row-4', project: 'virtual', kind: 'VIRTUAL', quantity: 1000, price: 0.9, value: 900, cell: 'G4', formula: null },
  ];
  const sum = 18_900;
  const wb = {
    source: '实盘统计.xlsx',
    sheet: 'Sheet1',
    startedAt: dayBefore(NOW, 3),
    baselineId: 'H1',
    baselineDate: dayBefore(NOW, 5),
    fx: 7.2,
    periods: [{ id: 'H1', date: dayBefore(NOW, 5), total: sum, fx: 7.2, cny: sum * 7.2, rows, future: false, rowSum: sum, difference: 0 }],
  };
  const preview = await w.store.importSource({ source: wb, apply: false });
  assert.equal(preview.preview, true);
  if (!preview.preview) return;
  assert.ok(preview.summary.retained.includes('DEX 价差 已同步余额（额外保留）'));

  const current = w.peek(db => currentLedger(db, Date.now()));
  const previous = w.peek(db => JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'source-ledger'").get<{ value: string }>()!.value));
  const planned = importPlan(parseSource(wb), current, previous, Date.now());
  assert.ok(planned.retained.includes('DEX 价差 已同步余额（额外保留）'));
  assert.equal(planned.ledger.assets.find(a => a.mode === 'dex-spread')?.value, 750);

  if (process.platform !== 'win32') {
    const applied = await w.store.importSource({ source: wb, apply: true, fingerprint: preview.fingerprint });
    assert.equal(applied.preview, false);
    if (!applied.preview) assert.equal(applied.ledger!.assets.find(a => a.mode === 'dex-spread')?.value, 750);
  }

  const h = createHarness();
  bindAccounts(h.ex);
  const server = createExecutorServer({ executor: h.ex, accessToken: 'dex-spread-http-tok', session: 'dex-spread-http-ses', views: { asset: w.store } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const cookie = ((await fetch(`${base}/login?token=dex-spread-http-tok`, { redirect: 'manual' })).headers.get('set-cookie') ?? '').split(';')[0]!;
    const res = await fetch(`${base}/api/asset/ledger`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const bodyText = await res.text();
    const parsed = JSON.parse(bodyText);
    assert.equal(parsed.summary.byExchange.find((item: { mode: string }) => item.mode === 'dex-spread')?.total, 750);
    assert.equal(bodyText.includes('101'), false);
    assert.equal(bodyText.toLowerCase().includes(L1_X), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
    h.dispose();
  }
});

test('并发保护：DEX 拉取期间连接密文变动时放弃陈旧写入', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: NOW + 21_600_000 });
  const w = setup(t);
  w.control.hlValues.set(ADDR_A, 300);
  w.control.dexState = { accounts: { lighter: { accountIndex: 101 }, entropy: { address: ADDR_A } }, problem: null };
  w.control.lighterValues.set(101, { l1Address: L1_X, total: 1000 });
  await w.store.connect({ exchange: 'hyperliquid', walletAddress: ADDR_A });

  // Simulate HL ciphertext rotating concurrently after refresh snapshot start and before final commit.
  w.control.onBeforeLighter = () => {
    w.writable(db => db.prepare("UPDATE connections SET encrypted = 'mutated-during-sync' WHERE exchange = 'hyperliquid'").run());
  };
  t.mock.timers.tick(31_000);
  const view = await w.store.sync({});
  assert.equal(view.ledger!.assets.some(a => a.mode === 'dex-spread'), false);
  const storedDex = w.peek(db => db.prepare("SELECT value FROM settings WHERE key = 'dex-spread-accounts'").get<{ value: string }>());
  assert.equal(storedDex, null);
});
