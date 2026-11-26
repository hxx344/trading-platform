import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { ASSET_DB_FILE, openAssetDb } from '../src/asset/db.ts';
import { CREDENTIAL_KEY_FILE } from '../src/asset/credentials.ts';
import { importLedger } from '../src/asset/import.ts';
import { PositionsPermissionError } from '../src/asset/positions-values.ts';
import { createAssetStore } from '../src/asset/store.ts';
import { OKX_DIRECTORY_TTL } from '../src/chain-arb/okx-network.ts';
import { OWNER, writeWorkbenchLedger } from './asset-fixture.ts';

const NOW = Date.parse('2026-11-10T04:00:00Z');
const okx = { exchange: 'okx', apiKey: 'test-directory-key', apiSecret: 'test-directory-secret', passphrase: 'test-directory-phrase' };
const CONFIG = '/api/v5/account/config', CURRENCIES = '/api/v5/asset/currencies';
const address = '0x' + 'a'.repeat(40);
const currency = { ccy: 'ARB', chain: 'ARB-Arbitrum One', ctAddr: address, canDep: true, canWd: false, minDep: '0.0001',
  needTag: false, burningFeeRate: '', depEstOpenTime: '', depQuotaFixed: '', usedDepQuotaFixed: '', depQuoteDailyLayer2: '' };
const config = [{ perm: 'read_only', uid: 'private-account-id' }];
const response = (rows: unknown[], headers?: Record<string, string>) => Response.json({ code: '0', data: rows }, { headers });
const fresh = () => new AbortController().signal;
function wait() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { resolve, promise };
}
type Handler = (path: string, init: RequestInit) => Response | Promise<Response>;

async function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'tp-okx-directory-')), from = join(root, 'ledger.sqlite'), dataDir = join(root, 'data');
  const file = join(dataDir, ASSET_DB_FILE);
  writeWorkbenchLedger(from, { now: NOW });
  importLedger({ from, owner: OWNER, dataDir, now: () => NOW });
  writeFileSync(join(dataDir, CREDENTIAL_KEY_FILE), '1'.repeat(64) + '\n', { mode: 0o600, flag: 'wx' });
  const w = { at: NOW, handler: ((path: string) => response(path === CONFIG ? config : [currency])) as Handler, calls: [] as string[],
    permissionDenied: false, positionsDenied: false };
  const store = createAssetStore(file, { now: () => w.at, fetch: async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://openapi.okx.com');
    assert.ok([CONFIG, CURRENCIES].includes(url.pathname)); assert.equal(url.search, '');
    assert.equal(init?.method, 'GET'); assert.equal(init.body, undefined);
    assert.equal(init.redirect, 'manual'); assert.equal(init.cache, 'no-store');
    const headers = new Headers(init.headers), timestamp = headers.get('OK-ACCESS-TIMESTAMP');
    assert.equal(headers.get('OK-ACCESS-KEY'), okx.apiKey); assert.equal(headers.get('OK-ACCESS-PASSPHRASE'), okx.passphrase);
    assert.equal(headers.get('OK-ACCESS-SIGN'), createHmac('sha256', okx.apiSecret).update(timestamp + 'GET' + url.pathname).digest('base64'));
    w.calls.push(url.pathname);
    return w.handler(url.pathname, init);
  }, sources: {
    quotes: async () => ({ VIRTUAL: { at: new Date(w.at).toISOString(), price: 1, source: 'fixture' } }),
    yuanQuote: async () => ({ rate: 7, status: { source: 'Frankfurter', fetchedAt: new Date(w.at).toISOString(), rateDate: null, error: null } }),
    syncOkx: async () => {
      if (w.permissionDenied) throw new PositionsPermissionError();
      return { total: 0, details: [], updatedAt: new Date(w.at).toISOString() };
    },
  }, positions: { cycle: null, read: async () => [], permission: async () => {
    if (w.positionsDenied) throw new PositionsPermissionError();
  } } });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const read = (signal = fresh()) => store.okxScanDirectory(signal);
  await assert.rejects(read(), /资产账本/);
  assert.deepEqual(w.calls, []);
  await store.connect(okx);
  return { w, store, file, read };
}

test('OKX 目录只输出核实的币链字段；两端 Age 均限制授权有效期，过期刷新先复核权限', async t => {
  const { w, store, read } = await setup(t);
  w.handler = path => path === CONFIG ? response(config, { age: '41' }) : response([{ ...currency, ctAddr: '0x' + 'A'.repeat(40),
    addr: 'private-deposit-address', usedWdQuota: 'private-withdraw-quota' }], { age: '10' });
  const dir = await read();
  assert.deepEqual(dir.rows, [{ symbol: 'ARB', chain: 'arbitrum', address, deposit: true, withdraw: false, depositEligible: true, minDeposit: '0.0001' }]);
  assert.match(dir.connection, /^[0-9a-f]{32}$/); assert.equal(dir.at, NOW - 41_000); assert.equal(dir.expiresAt, NOW + 19_000);
  assert.ok(!/private-|test-directory-|passphrase|apiKey|encrypted/.test(JSON.stringify(dir)));
  assert.ok(store.okxScanDirectoryCurrent(dir)); assert.equal(await read(), dir); assert.deepEqual(w.calls, [CONFIG, CURRENCIES]);
  w.at = dir.expiresAt; assert.equal(store.okxScanDirectoryCurrent(dir), false);
  const disallowed = [[{ perm: 'read_only,trade' }], [{ perm: 'read_only ' }], [config[0], config[0]], []];
  for (const rows of disallowed) {
    w.at += 1000;
    w.handler = () => response(rows);
    await assert.rejects(read(), /只读权限/);
    assert.equal(store.okxScanDirectoryCurrent(dir), false);
  }
  assert.equal(w.calls.filter(path => path === CURRENCIES).length, 1);
});

test('OKX 先统计同链歧义，再排除错误身份、原生币和结算币；充值限制只关闭现货', async t => {
  const { w, read } = await setup(t);
  const row = (symbol: string, net: string, number: number, fields: Record<string, unknown> = {}) => ({ ...currency, ccy: symbol,
    chain: symbol + '-' + net, ctAddr: '0x' + number.toString(16).padStart(40, '0'), ...fields });
  const limits = { MEMO: { memo: 'private-memo' }, ATTACH: { addrEx: { comment: 'private-memo' } }, MINIMUM: { minDep: '1e-4' },
    FEE: { depFee: '0.01' }, DAILY: { depQuoteDailyLayer2: '10000' }, QUOTA: { depQuotaFixed: '1000' },
    SCHEDULE: { depEstOpenTime: String(NOW + 1000) }, UNKNOWNQUOTA: { usedDepQuotaFixed: undefined } };
  const rows = [...Object.entries(limits).map(([symbol, fields], i) => row(symbol, 'ERC20', 1 + i, fields)), currency,
    row('WITHDRAWFEE', 'ERC20', 41, { fee: '0.05', burningFeeRate: '0.02', needTag: true, canWd: true }),
    row('WITHDRAWUNKNOWN', 'ERC20', 42, { canWd: undefined, needTag: undefined, burningFeeRate: undefined }),
    row('CLOSED', 'ERC20', 43, { canDep: false, canWd: true }), row('UNKNOWN', 'ERC20', 44, { canDep: 'true', canWd: 'false' }),
    row('BEP', 'BSC', 90), row('TWIN', 'BSC', 91), row('TWIN', 'BNB Smart Chain', 92), row('SHORT', 'ERC20', 50),
    row('SHORT', 'ERC20', 50, { ctAddr: '00abcd' }), row('ALIAS', 'ERC20', 51),
    row('BAD!SYMBOL', 'ERC20', 51, { ctAddr: row('ALIAS', 'ERC20', 51).ctAddr.toUpperCase() }),
    row('NOTARB', 'Arbitrum Nova', 66), row('ETH', 'Arbitrum One', 100), row('BNB', 'BSC', 102),
    row('USDT', 'BSC', 104), row('FAKE', 'BSC', 103, { ctAddr: '0x55d398326f99059ff775485246999027b3197955' }),
    row('MIXED', 'ERC20', 64), row('OTHER', 'ERC20', 65, { chain: 'MIXED-ERC20' })];
  w.handler = path => response(path === CONFIG ? config : rows.reverse());
  const directory = await read();
  assert.deepEqual(directory.rows.filter(net => net.depositEligible).map(net => net.symbol).sort(), ['ARB', 'BEP', 'WITHDRAWFEE', 'WITHDRAWUNKNOWN']);
  assert.deepEqual(directory.rows.filter(net => !net.depositEligible).map(net => net.symbol).sort(), [...Object.keys(limits), 'CLOSED', 'UNKNOWN'].sort());
  const bySymbol = new Map(directory.rows.map(net => [net.symbol, net]));
  for (const symbol of Object.keys(limits)) assert.equal(bySymbol.get(symbol)?.deposit, true, symbol);
  assert.equal(bySymbol.get('MINIMUM')?.minDeposit, '0');
  assert.equal(bySymbol.get('WITHDRAWFEE')?.withdraw, true); assert.equal(bySymbol.get('WITHDRAWUNKNOWN')?.withdraw, null);
  assert.equal(bySymbol.get('CLOSED')?.deposit, false); assert.equal(bySymbol.get('CLOSED')?.withdraw, true);
  assert.equal(bySymbol.get('UNKNOWN')?.deposit, null); assert.equal(bySymbol.get('UNKNOWN')?.withdraw, null);
  assert.ok(!JSON.stringify(directory).includes('private-memo'));
});

test('OKX 签名请求拒绝重定向、旧数据、部分和超大响应；异常不转发原文', async t => {
  const { w, read } = await setup(t);
  const secret = Object.values(okx).join('/') + '/private-url';
  const bad = [() => new Response(secret, { status: 302, headers: { location: 'https://example.invalid' } }),
    () => { const res = response(config); Object.defineProperty(res, 'redirected', { value: true }); return res; },
    () => response(config, { age: '60' }), () => response(config, { age: '0.5' }),
    () => response(config, { date: new Date(NOW - 60_000).toUTCString() }),
    () => response(config, { date: new Date(NOW + 10_000).toUTCString() }),
    () => response(config, { 'content-range': 'bytes 0-5/99' }), () => response(config, { 'content-length': '9000000' }),
    () => Response.json({ code: secret, msg: secret, data: [] }), () => { throw new Error(secret); }];
  for (const broken of bad) {
    w.handler = broken;
    await assert.rejects(read(), error => error instanceof Error && !error.message.includes('private-url') && /只读权限/.test(error.message));
  }
  assert.deepEqual(w.calls, Array(bad.length).fill(CONFIG));
  w.handler = path => path === CONFIG ? response(config) : response([currency], { age: '60' });
  await assert.rejects(read()); assert.equal(w.calls.at(-1), CURRENCIES);
});

test('OKX 共享在途目录，单个等待者取消不影响同伴；最后一个取消后迟到回包不能覆盖新结论', async t => {
  const { w, read, store } = await setup(t);
  const entered = wait(), release = wait();
  let running: AbortSignal | null | undefined;
  w.handler = async (path, init) => {
    if (path === CONFIG) return response(config);
    running = init.signal; entered.resolve(); await release.promise; return response([currency]);
  };
  const first = new AbortController(), last = new AbortController();
  const a = read(first.signal), b = read(last.signal);
  await entered.promise;
  first.abort(); await assert.rejects(a); assert.equal(running?.aborted, false);
  assert.deepEqual(w.calls, [CONFIG, CURRENCIES]);
  last.abort(); await assert.rejects(b); assert.equal(running?.aborted, true);
  w.handler = path => response(path === CONFIG ? config : [{ ...currency, canDep: false }]);
  const newer = await read(); assert.equal(newer.rows[0].deposit, false);
  release.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.ok(store.okxScanDirectoryCurrent(newer)); assert.equal(await read(), newer);
});

test('OKX 断开、同密钥重连、导入替换、账本权限撤销和关闭立即作废此前回包', async t => {
  const { w, store, read, file } = await setup(t);
  const old = await read(); await store.disconnect({ exchange: 'okx' });
  assert.equal(store.okxScanDirectoryCurrent(old), false); await assert.rejects(read());
  await store.connect(okx);
  const reconnected = await read(); assert.notEqual(reconnected.connection, old.connection);
  const db = openAssetDb(file, { mode: 'service' });
  try { db.prepare("UPDATE settings SET value=json_set(value, '$.importedAt', 'new-import') WHERE key='import-info'").run(); } finally { db.close(); }
  assert.equal(store.okxScanDirectoryCurrent(reconnected), false);
  const imported = await read(); assert.notEqual(imported.connection, reconnected.connection);
  w.permissionDenied = true;
  await store.sync({});
  assert.equal(store.okxScanDirectoryCurrent(imported), false);
  w.at += OKX_DIRECTORY_TTL;
  const entry = wait(), release = wait();
  w.handler = async path => {
    assert.equal(path, CONFIG); entry.resolve(); await release.promise; return response(config);
  };
  const pending = read();
  await entry.promise; store.close(); await assert.rejects(pending);
  release.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(w.calls.at(-1), CONFIG); await assert.rejects(read());
});

test('外部导入在权限或币链请求期间撤掉凭据，旧请求不能读取下一接口或发布目录', async t => {
  const { w, store, read, file } = await setup(t);
  for (const held of [CONFIG, CURRENCIES]) {
    const entered = wait(), release = wait();
    w.calls.length = 0;
    w.handler = async path => {
      if (path === held) { entered.resolve(); await release.promise; }
      return response(path === CONFIG ? config : [currency]);
    };
    const pending = read(); await entered.promise;
    const db = openAssetDb(file, { mode: 'service' });
    try { db.prepare("DELETE FROM connections WHERE exchange='okx'").run(); } finally { db.close(); }
    release.resolve();
    await assert.rejects(pending, /资产账本/); await assert.rejects(read());
    assert.deepEqual(w.calls, held === CONFIG ? [CONFIG] : [CONFIG, CURRENCIES]);
    await store.connect(okx);
  }
});

test('权限撤销后两个签名响应都必须来自撤销之后，旧 Age 或 Date 不能恢复同一密钥', async t => {
  for (const source of ['币链', '余额', '持仓']) await t.test(source, async t => {
    const { w, read, store, file } = await setup(t);
    const old = await read();
    if (source === '币链') {
      w.at = old.expiresAt; w.handler = () => response([{ perm: 'trade' }]); await assert.rejects(read());
    } else if (source === '余额') {
      w.permissionDenied = true; await store.sync({});
    } else {
      const db = openAssetDb(file, { mode: 'service' });
      try { db.prepare("UPDATE settings SET value='[]' WHERE key='aster-accounts'").run(); } finally { db.close(); }
      w.positionsDenied = true; await store.positions();
      for (let turn = 0; turn < 10 && store.okxScanDirectoryCurrent(old); turn++) await new Promise(done => setImmediate(done));
    }
    const denied = w.at;
    assert.equal(store.okxScanDirectoryCurrent(old), false);
    w.at = denied + 800; w.handler = () => response(config, { age: '0' });
    const count = w.calls.length;
    await assert.rejects(read());
    w.at = denied + 3_000;
    w.handler = () => response(config, { age: '4' }); await assert.rejects(read());
    w.handler = () => response(config, { date: new Date(denied).toUTCString() }); await assert.rejects(read());
    assert.deepEqual(w.calls.slice(count), [CONFIG, CONFIG, CONFIG]);
    w.handler = path => path === CONFIG ? response(config) : response([currency], { age: '4' });
    await assert.rejects(read()); assert.equal(w.calls.at(-1), CURRENCIES);
    w.handler = path => response(path === CONFIG ? config : [currency], { date: new Date(w.at).toUTCString(), age: '0' });
    const restored = await read();
    assert.equal(store.okxScanDirectoryCurrent(old), false); assert.equal(store.okxScanDirectoryCurrent(restored), true);
    assert.ok(restored.at > denied && restored.rows[0].depositEligible);
  });
});
