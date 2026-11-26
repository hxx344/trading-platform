import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { ASSET_DB_FILE, openAssetDb } from '../src/asset/db.ts';
import { CREDENTIAL_KEY_FILE, dataDirVault } from '../src/asset/credentials.ts';
import { importLedger } from '../src/asset/import.ts';
import { gateGet } from '../src/asset/sources/gate.ts';
import { createAssetStore } from '../src/asset/store.ts';
import { type Chain } from '../src/chain-arb/model.ts';
import { OWNER, writeWorkbenchLedger } from './asset-fixture.ts';

const NOW = Date.parse('2026-11-10T04:00:00Z');
const gate = { exchange: 'gate', apiKey: 'test-gate-deposit-key', apiSecret: 'test-gate-deposit-secret' };
const FEE = '/api/v4/wallet/withdraw_status', ADDRESS = '/api/v4/wallet/deposit_address';
const account = '0x' + 'abcde'.repeat(8), privateText = 'confidential-account-and-signature';
const network = { chain: 'ARBEVM', address: account, payment_name: '', payment_id: '', obtain_failed: 0 };
const currency = (symbol: string) => ({ currency: symbol, address: privateText, min_deposit_amount: '0.000000000000000017',
  multichain_addresses: [network, { ...network, chain: 'ETH' }] });
const fee = (symbol: string) => [{ currency: symbol, deposit: '0%', withdraw_amount_mini: '1234', withdraw_day_limit_remain: privateText }];
const response = (data: unknown, at: number, headers: Record<string, string> = {}) =>
  Response.json(data, { headers: { date: new Date(at).toUTCString(), ...headers } });
type Handler = (path: string, symbol: string, init: RequestInit) => Response | Promise<Response>;
const fresh = () => new AbortController().signal;
function wait() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { resolve, promise }; }
function sanitized(error: unknown) {
  assert.ok(error instanceof Error);
  assert.match(error.message, /Gate 充值网络/);
  for (const secret of [account, privateText, gate.apiKey, gate.apiSecret]) assert.ok(!String(error.stack).includes(secret));
  assert.equal(error.cause, undefined);
  return true;
}
async function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'tp-gate-proof-')), from = join(root, 'ledger.sqlite'), dataDir = join(root, 'data');
  const file = join(dataDir, ASSET_DB_FILE), key = join(dataDir, CREDENTIAL_KEY_FILE);
  writeWorkbenchLedger(from, { now: NOW }); importLedger({ from, owner: OWNER, dataDir, now: () => NOW });
  writeFileSync(key, '1'.repeat(64) + '\n', { flag: 'wx', mode: 0o600 });
  const w = { at: NOW, calls: [] as string[], balanceFailure: null as Response | (() => Promise<Response>) | null, auth: gate, handler: null as Handler | null };
  const store = createAssetStore(file, { now: () => w.at, fetch: async (input, init = {}) => {
    const url = new URL(String(input)), symbol = url.searchParams.get('currency')!;
    assert.ok([FEE, ADDRESS].includes(url.pathname));
    assert.equal(url.href, 'https://api.gateio.ws' + url.pathname + '?currency=' + encodeURIComponent(symbol));
    assert.equal(init.method, 'GET'); assert.equal(init.body, undefined); assert.equal(init.redirect, 'manual'); assert.equal(init.cache, 'no-store');
    const headers = new Headers(init.headers), timestamp = String(Math.floor(w.at / 1000));
    assert.equal(headers.get('key'), w.auth.apiKey); assert.equal(headers.get('timestamp'), timestamp);
    const prehash = ['GET', url.pathname, url.search.slice(1), createHash('sha512').update('').digest('hex'), timestamp].join('\n');
    assert.equal(headers.get('sign'), createHmac('sha512', w.auth.apiSecret).update(prehash).digest('hex'));
    w.calls.push(url.pathname);
    return w.handler ? w.handler(url.pathname, symbol, init) : response(url.pathname === FEE ? fee(symbol) : currency(symbol), w.at);
  }, sources: {
    syncGate: async c => {
      const failure = w.balanceFailure;
      if (failure) await gateGet(c, '/api/v4/wallet/total_balance', async () => typeof failure === 'function' ? failure() : failure);
      return { total: 0, details: [], updatedAt: new Date(w.at).toISOString() };
    },
    quotes: async () => ({ VIRTUAL: { at: new Date(w.at).toISOString(), price: 1, source: 'fixture' } }),
    yuanQuote: async () => ({ rate: 7, status: { source: 'Frankfurter', fetchedAt: new Date(w.at).toISOString(), rateDate: null, error: null } }),
  }, positions: { cycle: null, read: async () => [], permission: async () => {} } });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const read = (symbol = 'ARB', chain: Chain = 'arbitrum', signal = fresh()) => store.gateDepositProof(symbol, chain, signal);
  await assert.rejects(read(), sanitized); assert.deepEqual(w.calls, []);
  await store.connect(gate);
  return { root, file, key, store, w, read };
}

test('Gate 两次固定签名 GET 以原币精确最低额、最早响应时间出证；同币多链共用且只返回最小投影', async t => {
  const { store, w, read } = await setup(t);
  w.handler = (path, symbol) => response(path === FEE ? fee(symbol) : currency(symbol), w.at, path === FEE ? { age: '18' } : {});
  const [arb, eth] = await Promise.all([read('链币'), read('链币', 'ethereum')]);
  assert.deepEqual(arb, { symbol: '链币', chain: 'arbitrum', minDeposit: '0.000000000000000017', at: NOW - 18_999, expiresAt: NOW + 41_001 });
  assert.equal(eth.chain, 'ethereum'); assert.equal(eth.expiresAt, arb.expiresAt); assert.ok(Object.isFrozen(arb));
  assert.equal(store.gateDepositCurrent({ ...arb }), false); assert.ok(store.gateDepositCurrent(arb));
  await assert.rejects(read('链币', 'bsc'), sanitized); assert.equal(await read('链币'), arb);
  assert.deepEqual(w.calls, [FEE, ADDRESS]);
  for (const symbol of ['USDT', 'x/y', 'ABC&foo=1', 'a%20']) await assert.rejects(read(symbol), sanitized);
  await assert.rejects(read('ARB', '__proto__' as Chain), sanitized);
  assert.deepEqual(w.calls, [FEE, ADDRESS]);
  w.at = eth.expiresAt; assert.equal(store.gateDepositCurrent(arb), false); assert.notEqual(await read('链币'), arb);
});

test('Gate 缺失、非零或歧义充值费、不可核实的链和最低额均拒绝；异常响应与传输错误不泄漏', async t => {
  const { w, read } = await setup(t);
  const badFees = [[], [...fee('ARB'), ...fee('ARB')], fee('DIFF'), ...['', undefined, 0, '0.00001%', '0.1', 'free', privateText].map(deposit => [{ currency: 'ARB', deposit }])];
  for (const rows of badFees) {
    w.at += 4000; w.calls.length = 0; w.handler = () => response(rows, w.at);
    await assert.rejects(read(), sanitized); assert.deepEqual(w.calls, [FEE]);
  }
  const base = currency('ARB'), badAddresses = [
    { ...base, currency: 'DIFF' }, { ...base, multichain_addresses: [network, { ...network, chain: 'ARB', address: '' }] },
    { ...base, multichain_addresses: [{ ...network, chain: 'ARBEVM-OTHER' }] },
    ...[undefined, -1, 0.1, '', '1e-3', '-1', '0.0000000000000000001', privateText].map(min => ({ ...base, min_deposit_amount: min })),
    ...[{ address: '0x' + '0'.repeat(40) }, { address: '0x123' }, { payment_name: 'Memo' }, { payment_id: privateText },
      { payment_id: undefined }, { memo: privateText }, { obtain_failed: 1 }, { obtain_failed: undefined }, { obtain_failed: '0' },
      { min_deposit_amount: '12' }].map(fields => ({ ...base, multichain_addresses: [{ ...network, ...fields }] })),
  ];
  for (const body of badAddresses) {
    w.at += 4000; w.handler = path => response(path === FEE ? fee('ARB') : body, w.at); await assert.rejects(read(), sanitized);
  }
  const bad: (() => Response)[] = [
    () => Response.json(fee('ARB')), () => response(fee('ARB'), w.at - 60_000), () => response(fee('ARB'), w.at + 3000),
    () => response(fee('ARB'), w.at, { age: privateText }), () => response(fee('ARB'), w.at, { 'content-range': 'bytes 0-10/20' }),
    () => Response.redirect('https://example.invalid/' + privateText, 302), () => response(privateText.repeat(4000), w.at),
    () => { throw new Error(gate.apiKey + ' ' + privateText); },
  ];
  for (const fixture of bad) { w.at += 4000; w.handler = fixture; await assert.rejects(read(), sanitized); }
});

test('Gate 账本撤权和任一充值证据 401/403 撤销同一连接的全部币；两个时间都须晚于撤权', async t => {
  for (const source of [FEE, ADDRESS, 'balance']) await t.test(source, async t => {
    const { store, w, read } = await setup(t);
    const old = await read();
    if (source === 'balance') {
      w.balanceFailure = Response.json({ label: 'INVALID_KEY', message: privateText }, { status: 403 });
      await store.sync({});
    }
    else {
      w.handler = (path, symbol) => path === source ? new Response(privateText, { status: source === FEE ? 401 : 403 }) : response(fee(symbol), w.at);
      await assert.rejects(read('OTHER'), sanitized);
    }
    assert.equal(store.gateDepositCurrent(old), false);
    const denied = w.at;
    for (const path of [FEE, ADDRESS]) {
      w.at += 4000;
      w.handler = (p, symbol) => response(p === FEE ? fee(symbol) : currency(symbol), p === path ? denied : w.at);
      await assert.rejects(read(), sanitized);
      w.at += 4000;
      w.handler = (p, symbol) => response(p === FEE ? fee(symbol) : currency(symbol), w.at, p === path ? { age: String((w.at - denied) / 1000) } : {});
      await assert.rejects(read(), sanitized);
    }
    w.at += 4000; w.handler = null;
    const latest = await read(); assert.ok(store.gateDepositCurrent(latest)); assert.equal(store.gateDepositCurrent(old), false);
  });
});

test('Gate 钱包三个入口在 HTTP 200 返回明确拒绝时撤销其他币的证明和在途读取', async t => {
  for (const source of [FEE, ADDRESS, 'balance']) await t.test(source, async t => {
    const { w, store, read } = await setup(t);
    const old = await read(), entered = wait(), release = wait();
    const errorBody = () => Response.json({ label: 'FORBIDDEN', message: privateText });
    w.handler = async (path, symbol) => {
      if (symbol === 'LATE' && path === ADDRESS) { entered.resolve(); await release.promise; }
      if (symbol === 'CHECK' && path === source) return errorBody();
      return response(path === FEE ? fee(symbol) : currency(symbol), w.at);
    };
    const late = assert.rejects(read('LATE'), sanitized);
    await entered.promise;
    try {
      if (source === 'balance') { w.balanceFailure = errorBody(); await store.sync({}); }
      else await assert.rejects(read('CHECK'), sanitized);
      assert.equal(store.gateDepositCurrent(old), false);
    } finally { release.resolve(); }
    await late;
    w.at += 4000;
    const restored = await read('LATE'); assert.ok(store.gateDepositCurrent(restored));
    assert.equal(store.gateDepositCurrent(old), false);
  });
});

test('Gate 业务或间歇错误只拒绝本次币种读取', async t => {
  const { w, store, read } = await setup(t);
  const old = await read();
  for (const [i, label] of ['FUTURE_GATE_ERROR', 'SERVER_TIMEOUT', 'ACCOUNT_EXCEPTION', 'REQUEST_EXPIRED'].entries()) {
    w.at += 1000;
    w.handler = (path, symbol) => path === (i % 2 ? FEE : ADDRESS)
      ? Response.json({ label, message: privateText }) : response(fee(symbol), w.at);
    await assert.rejects(read('ASSET' + i), sanitized); assert.ok(store.gateDepositCurrent(old));
  }
  w.balanceFailure = Response.json({ label: 'TOO_BUSY', message: privateText });
  await store.sync({}); assert.ok(store.gateDepositCurrent(old));
});

test('Gate 试连拒权只撤销完全匹配的已存凭据；相同凭据的旧回包不能重建证明', async t => {
  const { w, store, read } = await setup(t);
  const old = await read();
  const refuse = (label = 'FORBIDDEN') => Response.json({ label, message: privateText });
  for (const [candidate, label] of [
    [{ ...gate, apiKey: 'different-key' }, 'FORBIDDEN'], [{ ...gate, apiSecret: 'different-secret' }, 'FORBIDDEN'],
    [gate, 'UNLISTED_ERROR'], [gate, 'SERVER_TIMEOUT'],
  ] as const) {
    w.balanceFailure = refuse(label);
    await assert.rejects(store.connect(candidate), /Gate 读取失败/);
    assert.ok(store.gateDepositCurrent(old));
  }
  const entered = wait(), release = wait();
  w.handler = async (path, symbol) => {
    if (path === ADDRESS) { entered.resolve(); await release.promise; }
    return response(path === FEE ? fee(symbol) : currency(symbol), w.at);
  };
  const late = assert.rejects(read('LATE'), sanitized);
  await entered.promise;
  w.balanceFailure = refuse();
  try { await assert.rejects(store.connect({ ...gate }), /FORBIDDEN/); assert.equal(store.gateDepositCurrent(old), false); }
  finally { release.resolve(); }
  await late;
  const denied = w.at;
  w.at += 4000; w.handler = (path, symbol) => response(path === FEE ? fee(symbol) : currency(symbol), denied);
  await assert.rejects(read(), sanitized);
  w.at += 4000; w.handler = null;
  assert.ok(store.gateDepositCurrent(await read())); assert.equal(store.gateDepositCurrent(old), false);
});

test('Gate 同凭据试连的旧拒绝不能撤销外部导入的新账户', async t => {
  const { w, store, file, read } = await setup(t);
  const old = await read(), entered = wait(), release = wait();
  w.balanceFailure = async () => {
    entered.resolve(); await release.promise;
    return Response.json({ label: 'FORBIDDEN', message: privateText });
  };
  const attempt = assert.rejects(store.connect(gate), /FORBIDDEN/);
  await entered.promise;
  try {
    const other = { ...gate, apiKey: 'new-import-key', apiSecret: 'new-import-secret' };
    const db = openAssetDb(file, { mode: 'service' });
    try {
      const cipher = dataDirVault(dirname(file)).seal(other, 'gate');
      db.prepare("UPDATE connections SET encrypted=? WHERE exchange='gate'").bind(cipher).run();
    } finally { db.close(); }
    assert.equal(store.gateDepositCurrent(old), false);
    w.auth = other; w.at += 4000;
    const imported = await read();
    release.resolve(); await attempt;
    assert.ok(store.gateDepositCurrent(imported));
  } finally { release.resolve(); }
});

test('Gate 同一连接恢复后收到试连拒绝时撤销新证明，并以第二次拒绝时间拦截旧回包', async t => {
  const { w, store, read } = await setup(t);
  const old = await read(), entered = wait(), release = wait();
  w.balanceFailure = async () => {
    entered.resolve(); await release.promise;
    return Response.json({ label: 'FORBIDDEN' });
  };
  const attempt = assert.rejects(store.connect(gate), /FORBIDDEN/);
  await entered.promise;
  try {
    w.handler = () => Response.json({ label: 'INVALID_KEY' });
    await assert.rejects(read('OTHER'), sanitized); assert.equal(store.gateDepositCurrent(old), false);
    w.at += 4000; w.handler = null;
    const recovered = await read(); assert.ok(store.gateDepositCurrent(recovered));
    w.at += 1000;
    release.resolve(); await attempt;
    assert.equal(store.gateDepositCurrent(recovered), false);
    w.at += 4000;
    w.handler = (path, symbol) => response(path === FEE ? fee(symbol) : currency(symbol), recovered.at);
    await assert.rejects(read(), sanitized);
    w.at += 4000; w.handler = null;
    assert.ok(store.gateDepositCurrent(await read()));
  } finally { release.resolve(); }
});

test('Gate 按币合并读取和取消；轮询和 429 有界且过期后可恢复', async t => {
  const { w, read } = await setup(t);
  const release = wait(), controllers = [new AbortController(), new AbortController()];
  let active: AbortSignal | undefined;
  w.handler = async (path, symbol, init) => {
    if (path === FEE) { active = init.signal!; await release.promise; }
    return response(path === FEE ? fee(symbol) : currency(symbol), w.at);
  };
  const a = read('ARB', 'arbitrum', controllers[0].signal), b = read('ARB', 'ethereum', controllers[1].signal);
  controllers[0].abort(); await assert.rejects(a, sanitized); assert.equal(active?.aborted, false);
  const other = read('OTHER');
  await assert.rejects(read('EXTRA'), sanitized); assert.deepEqual(w.calls, [FEE, FEE]);
  controllers[1].abort(); await assert.rejects(b, sanitized);
  release.resolve(); await other;
  assert.deepEqual(w.calls, [FEE, FEE, ADDRESS]);
  w.at += 3000; w.handler = () => new Response(privateText, { status: 429 });
  await assert.rejects(read('X'), sanitized); const attempts = w.calls.length;
  await assert.rejects(read('Y'), sanitized); assert.equal(w.calls.length, attempts);
  w.at += 60_000; w.handler = (path, symbol) => response(path === FEE ? [{ currency: symbol, deposit: '0.00' }] : currency(symbol), w.at);
  for (const s of ['A', 'B', 'C', 'D']) await read(s);
  await assert.rejects(read('E'), sanitized); assert.equal(w.calls.length, attempts + 8);
  w.at += 1000; await read('E');
});

test('Gate 轮换、断开、导入和凭据文件替换使缓存失效；撤掉在途连接后停止签名并拒绝旧回包', async t => {
  const { store, w, file, key, read } = await setup(t);
  const old = await read();
  const rotated = { ...gate, apiKey: 'test-gate-replaced-key' };
  await store.connect(rotated); w.auth = rotated; assert.equal(store.gateDepositCurrent(old), false);
  w.at += 4000; const next = await read(); assert.ok(store.gateDepositCurrent(next));
  const db = openAssetDb(file, { mode: 'service' });
  try { db.prepare("UPDATE settings SET value=json_set(value, '$.importedAt', 'new-import') WHERE key='import-info'").run(); } finally { db.close(); }
  assert.equal(store.gateDepositCurrent(next), false); w.at += 4000;
  const imported = await read();
  renameSync(key, key + '.old'); writeFileSync(key, '2'.repeat(64), { mode: 0o600 });
  assert.equal(store.gateDepositCurrent(imported), false);
  w.at += 4000; const before = w.calls.length; await assert.rejects(read(), sanitized); assert.equal(w.calls.length, before);
  rmSync(key); renameSync(key + '.old', key);
  for (const held of [FEE, ADDRESS]) {
    w.at += 4000; const entered = wait(), release = wait(); w.calls.length = 0;
    w.handler = async (path, symbol) => {
      if (path === held) { entered.resolve(); await release.promise; }
      return response(path === FEE ? fee(symbol) : currency(symbol), w.at);
    };
    const pending = read('HELD'); await entered.promise;
    if (held === FEE) {
      // An external import cannot call store.reset(). The next boundary must observe the changed SQLite row itself.
      const writer = openAssetDb(file, { mode: 'service' });
      try { writer.prepare("DELETE FROM connections WHERE exchange='gate'").run(); } finally { writer.close(); }
      release.resolve(); await assert.rejects(pending, sanitized);
    } else {
      await store.disconnect({ exchange: 'gate' }); await assert.rejects(pending, sanitized);
      release.resolve();
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(w.calls, held === FEE ? [FEE] : [FEE, ADDRESS]);
    await assert.rejects(read(), sanitized); await store.connect(rotated);
  }
  w.handler = null; w.at += 4000;
  const restored = await read(); store.close();
  assert.equal(store.gateDepositCurrent(restored), false); await assert.rejects(read(), sanitized);
});
