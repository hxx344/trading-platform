import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { CREDENTIAL_KEY_FILE } from '../src/asset/credentials.ts';
import { ASSET_DB_FILE, openAssetDb } from '../src/asset/db.ts';
import { importLedger } from '../src/asset/import.ts';
import { historyGeneration } from '../src/asset/history-cache.ts';
import { PositionsPermissionError } from '../src/asset/positions-values.ts';
import { revisionOf } from '../src/asset/positions-service.ts';
import { positionsGet } from '../src/asset/positions-readers.ts';
import { binanceGet } from '../src/asset/sources/exchanges.ts';
import { createAssetStore } from '../src/asset/store.ts';
import { OWNER, writeWorkbenchLedger } from './asset-fixture.ts';

const NOW = Date.parse('2026-11-10T04:00:00Z');
const key = { exchange: 'binance', apiKey: 'test-binance-deposit-key', apiSecret: 'test-binance-deposit-secret' };
const PERMISSION = '/sapi/v1/account/apiRestrictions', NETWORKS = '/sapi/v1/capital/config/getall', ADDRESS = '/sapi/v1/capital/deposit/address/list';
const account = '0x' + 'ab'.repeat(20), token = '0x' + 'cd'.repeat(20), bscToken = '0x' + 'ef'.repeat(20);
const secret = 'private-balance-and-signature';
const permissions = { enableReading: true, enableWithdrawals: false, enableInternalTransfer: false, enableMargin: false,
  enableFutures: false, permitsUniversalTransfer: false, enableVanillaOptions: false, enableSpotAndMarginTrading: false };
const net = { network: 'ARBITRUM', coin: 'ARB', depositEnable: true, denomination: 1, contractAddress: token, memoRegex: '',
  busy: false, resetAddressStatus: false, depositDust: '0.000000000000000017' };
const coin = { coin: 'ARB', free: secret, locked: secret, depositAllEnable: true, networkList: [net, { ...net, network: 'BSC', contractAddress: bscToken }] };
const current = { coin: 'ETH', address: account, isDefault: 1, tag: '' };
const addressList = [{ coin: 'ETH', address: token, isDefault: 0, tag: '' }, current];
const body = (path: string) => path === PERMISSION ? permissions : path === NETWORKS ? [coin] : addressList;
const response = (data: unknown, at: number, extra: Record<string, string> = {}) => Response.json(data, { headers: { date: new Date(at).toUTCString(), ...extra } });
const fresh = () => new AbortController().signal;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { resolve, promise };
}
function safe(error: unknown) {
  assert.ok(error instanceof Error && error.message.includes('币安充值网络'));
  for (const value of [account, secret, key.apiKey, key.apiSecret, 'signature=']) assert.ok(!String(error.stack).includes(value));
  assert.equal(error.cause, undefined);
  return true;
}
type Handler = (path: string, signal: AbortSignal) => Response | Promise<Response>;
async function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'tp-binance-proof-')), from = join(root, 'ledger.sqlite'), dataDir = join(root, 'data');
  const file = join(dataDir, ASSET_DB_FILE);
  writeWorkbenchLedger(from, { now: NOW }); importLedger({ from, owner: OWNER, dataDir, now: () => NOW });
  writeFileSync(join(dataDir, CREDENTIAL_KEY_FILE), '1'.repeat(64), { flag: 'wx', mode: 0o600 });
  const w = { at: NOW, balanceStatus: 200, calls: [] as string[], handle: null as Handler | null };
  const store = createAssetStore(file, { now: () => w.at, fetch: async (raw, init = {}) => {
    const url = new URL(String(raw)), path = url.pathname;
    assert.ok([PERMISSION, NETWORKS, ADDRESS].includes(path));
    assert.equal(url.origin, 'https://api.binance.com'); assert.equal(init.method, 'GET'); assert.equal(init.body, undefined);
    assert.equal(init.redirect, 'manual'); assert.equal(init.cache, 'no-store');
    assert.equal(new Headers(init.headers).get('X-MBX-APIKEY'), key.apiKey);
    const params = url.searchParams, query = url.search.slice(1, url.search.lastIndexOf('&signature='));
    assert.deepEqual([...params.keys()], [...(path === ADDRESS ? ['coin', 'network'] : []), 'timestamp', 'recvWindow', 'signature']);
    assert.equal(params.get('timestamp'), String(w.at));
    assert.equal(params.get('signature'), createHmac('sha256', key.apiSecret).update(query).digest('hex'));
    if (path === ADDRESS) { assert.equal(params.get('coin'), 'ARB'); assert.ok(['ARBITRUM', 'BSC'].includes(params.get('network')!)); }
    w.calls.push(path);
    return w.handle ? w.handle(path, init.signal!) : response(body(path), w.at);
  }, sources: {
    syncBinance: async c => {
      if (w.balanceStatus !== 200) await binanceGet(c, PERMISSION, async () => Response.json({ code: -2015, msg: secret }, { status: w.balanceStatus }));
      return { total: 0, details: [], updatedAt: new Date(w.at).toISOString() };
    },
    quotes: async () => ({ VIRTUAL: { at: new Date(w.at).toISOString(), price: 1, source: 'fixture' } }),
    yuanQuote: async () => ({ rate: 7, status: { source: 'Frankfurter', fetchedAt: new Date(w.at).toISOString(), rateDate: null, error: null } }),
  }, positions: { cycle: null, read: async () => [], permission: async () => {} } });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const read = (signal = fresh()) => store.binanceDepositProof('ARB', 'arbitrum', token, signal);
  await assert.rejects(read(), safe); assert.deepEqual(w.calls, []);
  await store.connect(key);
  return { store, w, read, file };
}

test('币安私有凭据只签固定读取，目录跨链合并，证明保留最早时间及精确最低额且无法复制', async t => {
  const { store, w, read } = await setup(t);
  w.handle = path => response(body(path), w.at, path === PERMISSION ? { age: '6' } : {});
  const [a, same, b] = await Promise.all([read(), read(), store.binanceDepositProof('ARB', 'bsc', bscToken, fresh())]);
  assert.equal(a, same);
  assert.deepEqual(w.calls, [PERMISSION, NETWORKS, ADDRESS, ADDRESS]);
  assert.deepEqual(a, { symbol: 'ARB', chain: 'arbitrum', contract: token, minDeposit: net.depositDust, at: NOW - 6999, expiresAt: NOW + 53001 });
  assert.equal(Object.isFrozen(a), true);
  assert.equal(store.binanceDepositRecipient(a), account); assert.equal(store.binanceDepositRecipient(b), account);
  assert.equal(store.binanceDepositCurrent({ ...a }), false);
  assert.ok(!JSON.stringify(a).includes(account) && !JSON.stringify(a).includes(secret));
  await assert.rejects(store.binanceDepositProof('ARB', 'arbitrum', bscToken, fresh()), safe);
  assert.equal(w.calls.length, 4);
  w.at = a.expiresAt; assert.equal(store.binanceDepositCurrent(a), false);
  w.at -= 2000; assert.equal(store.binanceDepositCurrent(a), false);
});

test('币安私有目录拒绝歧义、充值受限、单位或最低数量缺失；历史、备注和含糊的默认地址不能出证', async t => {
  const { w, read } = await setup(t);
  const changed = (overrides: Record<string, unknown>) => [{ ...coin, networkList: [{ ...net, ...overrides }] }];
  for (const raw of [
    [coin, coin], [{ ...coin, depositAllEnable: false }], [{ ...coin, networkList: [net, { ...net, contractAddress: bscToken }] }],
    [coin, { coin: 'COPY', networkList: [{ ...net, coin: 'COPY', depositEnable: false }] }],
    ...[{ coin: 'OTHER' }, { network: 'ETH' }, { contractAddress: bscToken }, { denomination: 1000 }, { denomination: undefined },
      { depositEnable: false }, { depositDust: undefined }, { depositDust: '1e-2' }, { memoRegex: '.+' }, { busy: true },
      { resetAddressStatus: true }, { depositFee: '0.001' }].map(changed),
  ]) {
    w.at += 65_000; w.calls.length = 0;
    w.handle = path => response(path === NETWORKS ? raw : body(path), w.at);
    await assert.rejects(read(), safe); assert.deepEqual(w.calls, [PERMISSION, NETWORKS]);
  }
  for (const raw of [
    [current, current], [], [{ ...current, isDefault: 0 }], [{ ...current, isDefault: '1' }], [{ ...current, tag: '2' }],
    [{ ...current, memo: '2' }], [{ ...current, coin: 'ARB' }], [{ ...current, network: 'BSC' }],
    [{ ...current, address: token }], [{ ...current, address: '0x' + '0'.repeat(40) }], [current, { ...current, isDefault: null }],
  ]) {
    w.at += 65_000;
    w.handle = path => response(path === ADDRESS ? raw : body(path), w.at);
    await assert.rejects(read(), safe);
  }
});

test('币安明确拒权撤销同账户历史证明，外部导入、断开和过期回包不得恢复原地址', async t => {
  const { store, w, read, file } = await setup(t);
  const old = await read(); w.balanceStatus = 400;
  await assert.rejects(store.connect({ ...key, apiSecret: 'different-secret' }), /2015/);
  assert.ok(store.binanceDepositCurrent(old));
  await assert.rejects(store.connect(key), /2015/);
  assert.equal(store.binanceDepositCurrent(old), false);
  w.balanceStatus = 200;
  for (const path of [PERMISSION, NETWORKS, ADDRESS]) {
    w.at += 4000;
    w.handle = p => response(body(p), p === path ? NOW : w.at);
    await assert.rejects(read(), safe);
    // Allow the next attempt to see a new directory even when only the address observation failed.
    w.at += 60_000;
  }
  w.handle = null;
  const next = await read(); assert.ok(store.binanceDepositCurrent(next));
  const db = openAssetDb(file, { mode: 'service' });
  try { db.prepare("UPDATE settings SET value=json_set(value,'$.importedAt','replacement') WHERE key='import-info'").run(); }
  finally { db.close(); }
  assert.equal(store.binanceDepositCurrent(next), false);
  w.at += 4000;
  const recovered = await read();
  await store.disconnect({ exchange: 'binance' }); assert.equal(store.binanceDepositCurrent(recovered), false);
  await assert.rejects(read(), safe);
});

test('币安显式限流跨币链退避；响应缺 Date、超过 Age 或网络拒权时不采信', async t => {
  const { store, w, read } = await setup(t);
  for (const headers of [{}, { date: 'invalid' }, { date: new Date(NOW).toUTCString(), age: '01x' }, { date: new Date(NOW + 400_000).toUTCString() }]) {
    w.at += 4000;
    w.handle = () => Response.json(permissions, { headers: new Headers(headers as Record<string, string>) });
    await assert.rejects(read(), safe);
  }
  w.at += 4000;
  w.handle = path => response(path === PERMISSION ? { ...permissions, enableSpotAndMarginTrading: true } : body(path), w.at);
  w.calls.length = 0; await assert.rejects(read(), safe); assert.deepEqual(w.calls, [PERMISSION]);
  w.at += 4000;
  w.handle = path => path === NETWORKS ? new Response(secret, { status: 429, headers: { 'retry-after': '90' } }) : response(body(path), w.at);
  await assert.rejects(read(), safe);
  w.at += 65_000; w.handle = null; const before = w.calls.length;
  await assert.rejects(store.binanceDepositProof('ARB', 'bsc', bscToken, fresh()), safe); assert.equal(w.calls.length, before);
  w.at += 26_000; const a = await read();
  w.handle = () => Response.json({ code: -2015, msg: secret }, { status: 400 });
  await assert.rejects(store.binanceDepositProof('ARB', 'bsc', bscToken, fresh()), safe);
  assert.equal(store.binanceDepositCurrent(a), false);
});

test('共享币安读取允许单个调用撤销；最后一个等待者退出或账户断开时丢弃在途结果', async t => {
  const { store, w, read } = await setup(t);
  const entered = deferred(), release = deferred();
  let active: AbortSignal | undefined;
  w.handle = async (path, signal) => {
    if (path === NETWORKS) { active = signal; entered.resolve(); await release.promise; }
    return response(body(path), w.at);
  };
  const first = new AbortController(), second = new AbortController();
  const a = read(first.signal), b = read(second.signal);
  await entered.promise; first.abort(); await assert.rejects(a, safe); assert.equal(active?.aborted, false);
  second.abort(); await assert.rejects(b, safe); assert.equal(active?.aborted, true);
  release.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(w.calls, [PERMISSION, NETWORKS]);
  const addressing = deferred(), finish = deferred();
  w.at += 4000;
  w.handle = async path => { if (path === ADDRESS) { addressing.resolve(); await finish.promise; } return response(body(path), w.at); };
  const pending = read(); await addressing.promise;
  await store.disconnect({ exchange: 'binance' }); await assert.rejects(pending, safe); finish.resolve();
});

test('同一币安连接恢复后，在途请求迟到的明确拒权仍撤销新证明', async t => {
  const { store, w, read } = await setup(t);
  await read();
  const entered = deferred(), release = deferred(), arrived = deferred();
  w.handle = async () => {
    entered.resolve(); await release.promise; arrived.resolve();
    return Response.json({ code: -2015, msg: secret }, { status: 400 });
  };
  const pending = assert.rejects(store.binanceDepositProof('ARB', 'bsc', bscToken, fresh()), safe);
  await entered.promise; w.balanceStatus = 401;
  await assert.rejects(store.connect(key), /2015|401/); await pending;
  w.at += 4000; w.balanceStatus = 200; w.handle = null;
  const recovered = await read(); assert.ok(store.binanceDepositCurrent(recovered));
  release.resolve(); await arrived.promise; await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.binanceDepositCurrent(recovered), false);
});

test('旧 apiRestrictions 的 HTTP 200 明确写权到达后，撤回重新验证的目录和当前地址', async t => {
  const { store, w, read } = await setup(t);
  const original = await read();
  w.at = original.expiresAt + 1000;
  const entered = deferred(), release = deferred(), arrived = deferred();
  w.handle = async path => {
    assert.equal(path, PERMISSION);
    entered.resolve(); await release.promise; arrived.resolve();
    return response({ ...permissions, enableWithdrawals: true }, w.at);
  };
  const pending = assert.rejects(read(), safe);
  await entered.promise; w.balanceStatus = 401;
  await assert.rejects(store.connect(key), /2015|401/); await pending;
  w.at += 4000; w.balanceStatus = 200; w.handle = null; w.calls.length = 0;
  const renewed = await read();
  assert.deepEqual(w.calls, [PERMISSION, NETWORKS, ADDRESS]);
  assert.equal(store.binanceDepositRecipient(renewed), account);
  w.at += 1000;
  release.resolve(); await arrived.promise; await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.binanceDepositCurrent(renewed), false);
  assert.equal(store.binanceDepositRecipient(renewed), undefined);
  w.at += 4000; w.handle = path => response(body(path), renewed.at);
  await assert.rejects(read(), safe);
  w.at += 4000; w.handle = null;
  assert.ok(store.binanceDepositCurrent(await read()));
});

test('币安签名产品端的 -2015 复核账户级权限，公开行情和 WAF 不误撤权', async () => {
  const product = '/papi/v1/um/positionRisk', publicPath = '/fapi/v1/exchangeInfo';
  for (const [path, status, code, permissionStatus, denied, count] of [
    [product, 401, -2015, 200, false, 2], [product, 400, -2015, 401, true, 2],
    [product, 200, -2014, 200, true, 1], [product, 403, undefined, 200, false, 1],
    [publicPath, 200, -2014, 200, false, 1],
  ] as const) {
    const calls: string[] = [];
    const fetcher: typeof fetch = async url => {
      const target = new URL(String(url)).pathname; calls.push(target);
      if (target === PERMISSION) return Response.json(permissionStatus === 200 ? permissions : { code: -2015 }, { status: permissionStatus });
      return Response.json(code === undefined ? { msg: secret } : { code, msg: secret }, { status });
    };
    await assert.rejects(positionsGet('binance', key, path, new URLSearchParams(), fetcher),
      e => { assert.equal(e instanceof PositionsPermissionError, denied); return true; });
    assert.deepEqual(calls, count === 1 ? [path] : [path, PERMISSION]);
  }
});

test('迟到的币安账户拒权仅作用于当下仍完全相同的凭据版本；多个等待者只处理一次', async t => {
  const { file } = await setup(t);
  const db = openAssetDb(file, { mode: 'service' });
  try {
    const access = (revision = 'original') => historyGeneration(() => db, 'binance', revision);
    const late = access(); late.deny(new PositionsPermissionError());
    const renewed = access(); await renewed.verify(async () => {});
    const second = new PositionsPermissionError();
    late.deny(second); assert.equal(renewed.current(), false);
    const third = access(); await third.verify(async () => {});
    late.deny(second); assert.ok(third.current());
    const rotated = access('rotated'); late.deny(new PositionsPermissionError()); assert.ok(rotated.current());
  } finally { db.close(); }
});

test('旧权限请求迟到的空响应不会撤销重新核实的充值地址或清空同账户成交', async t => {
  const { store, file, w, read } = await setup(t);
  const stop = new AbortController(), entered = deferred(), release = deferred(), replied = deferred();
  w.handle = async path => {
    assert.equal(path, PERMISSION);
    entered.resolve(); await release.promise; replied.resolve(); return response(null, w.at);
  };
  const stale = assert.rejects(read(stop.signal), safe);
  await entered.promise; stop.abort(); await stale;
  w.handle = null; w.at += 3000;
  const renewed = await read();
  assert.equal(store.binanceDepositRecipient(renewed), account);
  const db = openAssetDb(file, { mode: 'service' });
  try {
    const saved = db.prepare("SELECT encrypted FROM connections WHERE exchange='binance'").get<{encrypted: string}>()!;
    db.prepare("INSERT INTO fill_cache(account,scope,revision,data,updated_at) VALUES('binance','um',?,'[]',?)")
      .bind(revisionOf(saved.encrypted), w.at).run();
    release.resolve(); await replied.promise; await new Promise(resolve => setImmediate(resolve));
    assert.equal(store.binanceDepositRecipient(renewed), account);
    assert.equal(db.prepare("SELECT data FROM fill_cache WHERE account='binance' AND scope='um'").get<{data: string}>()?.data, '[]');
  } finally { db.close(); }
});

test('权限接口返回空值或字符串时只报告应答无效', async () => {
  for (const malformed of [null, 'bad response']) {
    await assert.rejects(binanceGet(key, PERMISSION, async () => Response.json(malformed)),
      error => error instanceof Error && !(error instanceof PositionsPermissionError) && error.message.includes('数据不完整'));
  }
});
