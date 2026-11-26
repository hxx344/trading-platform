import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
const CONFIG = '/api/v5/account/config', CURRENCIES = '/api/v5/asset/currencies', DEPOSIT = '/api/v5/asset/deposit-address';
const POSITIONS = '/api/v5/account/positions', INSTRUMENTS = '/api/v5/public/instruments';
const TRADES = '/api/v5/trade/fills-history', BILLS = '/api/v5/account/bills-archive';
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

async function setup(t: TestContext, defaultPermission = false, liveCycles = false) {
  const root = mkdtempSync(join(tmpdir(), 'tp-okx-directory-')), from = join(root, 'ledger.sqlite'), dataDir = join(root, 'data');
  const file = join(dataDir, ASSET_DB_FILE);
  writeWorkbenchLedger(from, { now: NOW });
  importLedger({ from, owner: OWNER, dataDir, now: () => NOW });
  writeFileSync(join(dataDir, CREDENTIAL_KEY_FILE), '1'.repeat(64) + '\n', { mode: 0o600, flag: 'wx' });
  const w = { at: NOW, handler: ((path: string) => response(path === CONFIG ? config : [currency])) as Handler, calls: [] as string[],
    permissionDenied: false, positionsDenied: false, credentials: okx };
  const store = createAssetStore(file, { now: () => w.at, fetch: async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://openapi.okx.com');
    if (liveCycles) {
      assert.ok([CONFIG, CURRENCIES, DEPOSIT, POSITIONS, INSTRUMENTS, TRADES, BILLS].includes(url.pathname));
    } else {
      assert.ok([CONFIG, CURRENCIES, DEPOSIT].includes(url.pathname));
      assert.equal(url.search, url.pathname === DEPOSIT ? '?ccy=' + encodeURIComponent(url.searchParams.get('ccy')!) : '');
    }
    assert.equal(init?.method, 'GET'); assert.equal(init.body, undefined);
    assert.equal(init.redirect, 'manual'); assert.equal(init.cache, 'no-store');
    const headers = new Headers(init.headers), timestamp = headers.get('OK-ACCESS-TIMESTAMP');
    if (url.pathname === INSTRUMENTS) assert.equal(headers.has('OK-ACCESS-KEY'), false);
    else {
      assert.equal(headers.get('OK-ACCESS-KEY'), w.credentials.apiKey); assert.equal(headers.get('OK-ACCESS-PASSPHRASE'), w.credentials.passphrase);
      assert.equal(headers.get('OK-ACCESS-SIGN'), createHmac('sha256', w.credentials.apiSecret).update(timestamp + 'GET' + url.pathname + url.search).digest('base64'));
    }
    w.calls.push(url.pathname);
    return w.handler(url.pathname + url.search, init);
  }, sources: {
    quotes: async () => ({ VIRTUAL: { at: new Date(w.at).toISOString(), price: 1, source: 'fixture' } }),
    yuanQuote: async () => ({ rate: 7, status: { source: 'Frankfurter', fetchedAt: new Date(w.at).toISOString(), rateDate: null, error: null } }),
    syncOkx: async () => {
      if (w.permissionDenied) throw new PositionsPermissionError();
      return { total: 0, details: [], updatedAt: new Date(w.at).toISOString() };
    },
  }, positions: liveCycles ? undefined : { cycle: null, read: async () => [], permission: defaultPermission ? undefined : async () => {
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
  w.at += 2000; const reconnected = await read(); assert.notEqual(reconnected.connection, old.connection);
  const db = openAssetDb(file, { mode: 'service' });
  try { db.prepare("UPDATE settings SET value=json_set(value, '$.importedAt', 'new-import') WHERE key='import-info'").run(); } finally { db.close(); }
  assert.equal(store.okxScanDirectoryCurrent(reconnected), false);
  w.at += 2000; const imported = await read(); assert.notEqual(imported.connection, reconnected.connection);
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
    await store.connect(okx); w.at += 2000;
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

const receiving = '0x' + 'cd'.repeat(20);
const selected = { addr: receiving, ccy: 'ARB', chain: 'ARB-Arbitrum One', ctAddr: address.slice(-6), selected: true, to: '6',
  verifiedName: 'sensitive-user-name' };
const deposited = (rows: unknown[], at: number, headers: Record<string, string> = {}) =>
  response(rows, { date: new Date(at).toUTCString(), ...headers });
const privateFailure = (error: unknown) => error instanceof Error && /未核实 OKX/.test(error.message)
  && ![receiving, 'sensitive-user-name', okx.apiSecret, okx.passphrase].some(s => error.stack?.includes(s));

test('OKX 按完整目录合约、当前选择与唯一网络取私有收款地址，历史、其他链及账户身份字段不进入公开结果', async t => {
  const { store, w, read } = await setup(t);
  w.handler = path => path === CONFIG ? response(config) : path === CURRENCIES ? response([currency, { ...currency, chain: 'ARB-ERC20' }])
    : deposited([{ ...selected, selected: false, addr: 'historical' }, selected, { ...selected, chain: 'ARB-ERC20', to: '18', addr: '0x' + '3'.repeat(40) }], w.at, { age: '15' });
  const dir = await read();
  await assert.rejects(store.okxDepositRecipient!(dir, 'OTHER', 'arbitrum', address, fresh()), privateFailure);
  await assert.rejects(store.okxDepositRecipient!(dir, 'ARB', 'arbitrum', '0x' + 'b'.repeat(34) + address.slice(-6), fresh()), privateFailure);
  assert.deepEqual(w.calls, [CONFIG, CURRENCIES]);
  const [one, two] = await Promise.all([store.okxDepositRecipient!(dir, 'ARB', 'arbitrum', address, fresh()),
    store.okxDepositRecipient!(dir, 'ARB', 'ethereum', address, fresh())]);
  assert.deepEqual(w.calls, [CONFIG, CURRENCIES, DEPOSIT]); assert.equal(one.address, receiving); assert.equal(two.address, '0x' + '3'.repeat(40));
  assert.equal(one.expiresAt, NOW + 44_001); assert.equal(store.okxDepositRecipientCurrent!(dir, one), true);
  assert.equal(store.okxDepositRecipientCurrent!(dir, { ...one }), false);
  assert.ok(![receiving, 'sensitive-user-name', 'historical'].some(v => JSON.stringify([dir, one, two]).includes(v)));
  w.at = one.expiresAt; assert.equal(store.okxDepositRecipientCurrent!(dir, one), false);
  w.handler = () => deposited([{ ...selected, addr: '0x' + '4'.repeat(40) }], w.at);
  const newer = await store.okxDepositRecipient!(dir, 'ARB', 'arbitrum', address, fresh()); assert.equal(newer.address, '0x' + '4'.repeat(40));
  assert.equal(store.okxDepositRecipientCurrent!(dir, one), false);
  // Rolling back into the same directory's lifetime cannot revive the previous selected address.
  w.at = NOW + 10_000;
  assert.equal(store.okxDepositRecipientCurrent!(dir, newer), false);
  assert.equal(store.okxDepositRecipientCurrent!(dir, one), false);
  w.at += 40_000; assert.equal(store.okxDepositRecipientCurrent!(dir, newer), false);
});

test('OKX 对未选、冲突、错后缀、备注、异常响应或过期地址关闭相应候选', async t => {
  const { w, read, store } = await setup(t);
  for (const rows of [
    [{ ...selected, selected: false }], [selected, selected], [selected, { ...selected, chain: 'WRONG-Arbitrum One' }],
    [selected, { ...selected, selected: undefined }], [{ ...selected, ccy: 'OTHER' }], [{ ...selected, chain: 'ARB-ERC20' }],
    ...[{ ctAddr: '' }, { ctAddr: 'badbad' }, { ctAddr: address }, { to: '0' }, { selected: 'true' }, { addr: '0x' + '0'.repeat(40) },
      { tag: '12' }, { memo: 'xyz' }, { pmtId: 'x' }, { addrEx: { comment: 'foo' } }].map(fields => [{ ...selected, ...fields }]),
  ]) {
    const dir = await read();
    w.handler = () => deposited(rows, w.at);
    await assert.rejects(store.okxDepositRecipient!(dir, 'ARB', 'arbitrum', address, fresh()), privateFailure);
    w.at = dir.expiresAt + 1000;
    w.handler = path => response(path === CONFIG ? config : [currency]);
  }
  const dir = await read();
  for (const bad of [() => deposited([selected], w.at - 61_000), () => response([selected]),
    () => deposited([selected], w.at + 3000), () => deposited([selected], w.at, { 'content-range': 'bytes 1-2/3' }),
    () => { throw new Error(receiving + okx.apiSecret); }]) {
    w.handler = bad; await assert.rejects(store.okxDepositRecipient!(dir, 'ARB', 'arbitrum', address, fresh()), privateFailure);
    w.at += 4000;
  }
});

test('OKX 地址拒权撤销同账户其他币及在途读取，凭据文件替换或同凭据试连拒权立即撤销', async t => {
  const { w, read, store, file } = await setup(t);
  const key = join(dirname(file), CREDENTIAL_KEY_FILE);
  const source = (path: string) => path === CONFIG ? response(config) : path === CURRENCIES ?
    response(['ARB', 'LATE', 'OTHER'].map((ccy, i) => ({ ...currency, ccy, chain: ccy + '-Arbitrum One',
      ctAddr: i ? '0x' + String(i).repeat(40) : address }))) : deposited([selected], w.at);
  for (const denial of ['403', '50120', '50119', 'try-connect', 'key-file']) {
    w.handler = source;
    const dir = await read(); const first = await store.okxDepositRecipient!(dir, 'ARB', 'arbitrum', address, fresh());
    const entered = wait(), release = wait();
    w.handler = async path => {
      if (path.endsWith('ccy=LATE')) {
        entered.resolve(); await release.promise;
        return deposited([{ ...selected, ccy: 'LATE', chain: 'LATE-Arbitrum One', ctAddr: '111111' }], w.at);
      }
      return denial === '403' ? new Response(null, { status: 403 }) : Response.json({ code: denial, msg: receiving, data: [] });
    };
    const late = assert.rejects(store.okxDepositRecipient!(dir, 'LATE', 'arbitrum', '0x' + '1'.repeat(40), fresh()), privateFailure);
    await entered.promise;
    try {
      if (denial === 'try-connect') {
        w.permissionDenied = true;
        await assert.rejects(store.connect({ ...okx, passphrase: okx.passphrase + '-different' })); assert.ok(store.okxDepositRecipientCurrent!(dir, first));
        await assert.rejects(store.connect(okx)); w.permissionDenied = false;
      } else if (denial === 'key-file') renameSync(key, key + '.held');
      else await assert.rejects(store.okxDepositRecipient!(dir, 'OTHER', 'arbitrum', '0x' + '2'.repeat(40), fresh()), privateFailure);
      assert.equal(store.okxDepositRecipientCurrent!(dir, first), false);
      assert.equal(store.okxScanDirectoryCurrent(dir), false);
    } finally { release.resolve(); if (denial === 'key-file') renameSync(key + '.held', key); }
    await late;
    w.at += 4000;
  }
});

test('OKX 地址查询限流与取消按币合并，退避后可恢复', async t => {
  const { w, read, store } = await setup(t);
  const directory = await read(), entered = wait(), release = wait(), caller = new AbortController();
  let request: AbortSignal | null | undefined;
  w.handler = async (_path, init) => { request = init.signal; entered.resolve(); await release.promise; return new Response(null, { status: 429 }); };
  const a = assert.rejects(store.okxDepositRecipient!(directory, 'ARB', 'arbitrum', address, caller.signal), privateFailure);
  const b = assert.rejects(store.okxDepositRecipient!(directory, 'ARB', 'arbitrum', address, fresh()), privateFailure);
  await entered.promise; caller.abort(); await a; assert.equal(request?.aborted, false);
  release.resolve(); await b;
  const calls = w.calls.length; w.at += 5000;
  await assert.rejects(store.okxDepositRecipient!(directory, 'ARB', 'arbitrum', address, fresh()), privateFailure);
  assert.equal(w.calls.length, calls);
  w.at = NOW + 61_000; w.handler = path => path === CONFIG ? response(config) : path === CURRENCIES ? response([currency]) : deposited([selected], w.at);
  const next = await read(); assert.equal((await store.okxDepositRecipient!(next, 'ARB', 'arbitrum', address, fresh())).address, receiving);
});

test('生产持仓权限读取中的 HTTP 或业务拒权会立即撤销已取得的 OKX 真实充值地址', async t => {
  for (const status of [200, 400, 403]) await t.test(String(status), async t => {
    const { w, read, store, file } = await setup(t, true);
    w.handler = path => path === CONFIG ? response(config) : path === CURRENCIES ? response([currency]) : deposited([selected], w.at);
    const dir = await read(), proof = await store.okxDepositRecipient!(dir, 'ARB', 'arbitrum', address, fresh());
    const db = openAssetDb(file, { mode: 'service' });
    try { db.prepare("UPDATE settings SET value='[]' WHERE key='aster-accounts'").run(); } finally { db.close(); }
    w.handler = () => Response.json({ code: '50120', msg: 'private' }, { status });
    await store.positions();
    for (let turn = 0; turn < 20 && store.okxDepositRecipientCurrent!(dir, proof); turn++) await new Promise(done => setImmediate(done));
    assert.equal(store.okxDepositRecipientCurrent!(dir, proof), false);
    assert.equal(store.okxScanDirectoryCurrent(dir), false);
  });
});

test('资产页持仓本轮历史明确拒权时，撤销同账户充值地址；普通错误、公开目录及旧账户的拒绝不影响当前地址', async t => {
  for (const variant of ['fills-forbidden', 'bills-permission', 'history-unavailable', 'public-forbidden', 'rotated', 'same-credential-restored'] as const) await t.test(variant, async t => {
    const { w, store, file, read } = await setup(t, false, true);
    const db = openAssetDb(file, { mode: 'service' });
    try { db.prepare("UPDATE settings SET value='[]' WHERE key='aster-accounts'").run(); } finally { db.close(); }
    const entered = wait(), release = wait();
    const failingPath = variant === 'bills-permission' ? BILLS : variant === 'public-forbidden' ? INSTRUMENTS : TRADES;
    const symbol = 'ARB-USDT-SWAP';
    w.handler = async path => {
      const url = new URL(path, 'https://openapi.okx.com');
      if (url.pathname === failingPath) {
        entered.resolve(); await release.promise;
        if (variant === 'bills-permission') return Response.json({ code: '50120', data: [] });
        return new Response(null, { status: variant === 'history-unavailable' ? 503 : 403 });
      }
      switch (url.pathname) {
        case CONFIG: return response(config);
        case CURRENCIES: return response([currency]);
        case DEPOSIT: return deposited([selected], w.at);
        case POSITIONS: return response(url.searchParams.get('instType') === 'FUTURES' ? [] :
          [{ instType: 'SWAP', instId: symbol, pos: '1', posSide: 'net', posId: '1', mgnMode: 'cross' }]);
        case INSTRUMENTS: return response([{ instType: 'SWAP', instId: symbol, ctVal: '1', ctMult: '1', ctValCcy: 'ARB', settleCcy: 'USDT', uly: 'ARB-USDT' }]);
        case TRADES: return response([{ instId: symbol, billId: '1', ts: String(w.at - 60_000), side: 'buy', posSide: 'net',
          fillSz: '1', fillPx: '1', fillPnl: '0', fee: '0', feeCcy: 'USDT' }]);
        default: return response([]);
      }
    };
    let dir = await read(), proof = await store.okxDepositRecipient!(dir, 'ARB', 'arbitrum', address, fresh());
    await store.positions();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([entered.promise, new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error('目标读取未发生：' + failingPath + '，实际 ' + w.calls.join(' '))), 4000);
      })]);
      if (variant === 'same-credential-restored') {
        w.permissionDenied = true;
        await assert.rejects(store.connect(okx), PositionsPermissionError);
        assert.equal(store.okxDepositRecipientCurrent!(dir, proof), false);
        const previous = proof;
        w.permissionDenied = false;
        w.at += 3000;
        dir = await read(); proof = await store.okxDepositRecipient!(dir, 'ARB', 'arbitrum', address, fresh());
        assert.notEqual(proof, previous);
        assert.ok(store.okxDepositRecipientCurrent!(dir, proof));
        w.at += 1000;
      }
      if (variant === 'rotated') {
        w.credentials = { ...okx, apiKey: 'other-okx-key', apiSecret: 'other-okx-secret' };
        await store.connect(w.credentials); w.at += 3000;
        dir = await read(); proof = await store.okxDepositRecipient!(dir, 'ARB', 'arbitrum', address, fresh());
      }
    } finally { clearTimeout(timer); release.resolve(); }
    await new Promise<void>(done => setImmediate(done));
    const stillCurrent = variant === 'history-unavailable' || variant === 'public-forbidden' || variant === 'rotated';
    assert.equal(store.okxDepositRecipientCurrent!(dir, proof), stillCurrent);
    assert.equal(store.okxScanDirectoryCurrent(dir), stillCurrent);
  });
});
