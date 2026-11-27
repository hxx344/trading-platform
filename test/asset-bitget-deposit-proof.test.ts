import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { CREDENTIAL_KEY_FILE } from '../src/asset/credentials.ts';
import { ASSET_DB_FILE, openAssetDb } from '../src/asset/db.ts';
import { importLedger } from '../src/asset/import.ts';
import { createAssetStore } from '../src/asset/store.ts';
import { connectionExchange, parseConnection } from '../src/asset/validation.ts';
import { OWNER, writeWorkbenchLedger } from './asset-fixture.ts';

const initial = Date.parse('2026-11-15T12:00:00Z');
const token = '0x' + 'c1'.repeat(20), recipient = '0x' + 'f2'.repeat(20), other = '0x' + 'a3'.repeat(20);
const key = { exchange: 'bitget', apiKey: 'example-key', apiSecret: 'example-secret', passphrase: 'example-phrase' };
const userId = '123456789', signal = () => new AbortController().signal;
const net = { chain: 'ArbitrumOne', contractAddress: token, minDepositAmount: '0.000000000000000003', needTag: 'false', rechargeable: 'true',
  withdrawable: 'false', congestion: 'normal', withdrawFee: '15', extraWithdrawFee: '0.02' };
const coin = { coin: 'ARB', transfer: 'true', chains: [net, { ...net, chain: 'BEP20', contractAddress: other }] };
const rights = { userId, permType: 'read-only', permissions: ['uta_mgt', 'uta_trade'] };
const classic = { userId, authorities: ['stor', 'wtor', 'p2pr'] };
const settings = { uid: userId, accountMode: 'unified' };
const info3 = '/api/v3/account/info', mode = '/api/v3/account/settings', addr3 = '/api/v3/account/deposit-address', coins3 = '/api/v3/market/coins';
const info2 = '/api/v2/spot/account/info', addr2 = '/api/v2/spot/wallet/deposit-address', coins2 = '/api/v2/spot/public/coins';
const address = { coin: 'ARB', chain: 'arbitrumone', address: recipient, tag: null };
const fixtures = new Map<string, unknown>([[info3, rights], [mode, settings], [info2, classic], [coins2, [coin]], [coins3, [coin]], [addr2, address], [addr3, address]]);
const success = (data: unknown, at: number, headers: Record<string, string> = {}) => Response.json({ code: '00000', requestTime: at, data },
  { headers: { date: new Date(at).toUTCString(), ...headers } });
type Handler = (url: URL, at: number, abort: AbortSignal) => Response | Promise<Response>;
async function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'tp-bitget-proof-')), from = join(root, 'ledger.sqlite'), dataDir = join(root, 'data');
  writeWorkbenchLedger(from, { now: initial }); importLedger({ from, owner: OWNER, dataDir, now: () => initial });
  writeFileSync(join(dataDir, CREDENTIAL_KEY_FILE), '1'.repeat(64), { flag: 'wx', mode: 0o600 });
  const file = join(dataDir, ASSET_DB_FILE), w = { at: initial, calls: [] as string[], handle: null as Handler | null };
  const store = createAssetStore(file, { now: () => w.at, fetch: async (raw, init = {}) => {
    const url = new URL(String(raw)), path = url.pathname, headers = new Headers(init.headers);
    assert.equal(url.origin, 'https://api.bitget.com'); assert.ok(fixtures.has(path));
    assert.equal(init.method, 'GET'); assert.equal(init.body, undefined); assert.equal(init.redirect, 'manual'); assert.equal(init.cache, 'no-store');
    if (path === addr2 || path === addr3) {
      assert.deepEqual([...url.searchParams.keys()], ['coin', 'chain']); assert.equal(url.searchParams.get('coin'), coin.coin);
      assert.ok(['ArbitrumOne', 'BEP20'].includes(url.searchParams.get('chain')!));
    } else assert.equal(url.search, '');
    if (path === coins2 || path === coins3) assert.deepEqual([...headers.keys()], ['accept']);
    else {
      assert.equal(headers.get('ACCESS-KEY'), key.apiKey);
      assert.equal(headers.get('ACCESS-PASSPHRASE'), key.passphrase);
      assert.equal(headers.get('ACCESS-TIMESTAMP'), String(w.at));
      assert.equal(headers.get('ACCESS-SIGN'), createHmac('sha256', key.apiSecret).update(w.at + 'GET' + path + url.search).digest('base64'));
    }
    w.calls.push(path);
    return w.handle ? w.handle(url, w.at, init.signal!) : success(fixtures.get(path), w.at);
  } });
  const db = openAssetDb(file, { mode: 'service' });
  t.after(() => { db.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const read = (abort = signal()) => store.bitgetDepositProof('ARB', 'arbitrum', token, abort);
  const saved = () => db.prepare("SELECT encrypted FROM connections WHERE exchange='bitget'").get<{ encrypted: string }>()?.encrypted;
  return { store, db, w, read, saved };
}

test('Bitget 只保存经验证的充值连接，同一凭据保留代际，资产总值、手动资产与快照保持原值', async t => {
  const { store, db, read, w, saved } = await setup(t);
  const before = await store.ledger();
  const snapshots = () => db.prepare('SELECT date,data FROM snapshots ORDER BY date').rows();
  const original = snapshots();
  assert.equal(before.ledger?.connections.bitget.configured, false);
  await assert.rejects(read(), /Bitget/); assert.deepEqual(w.calls, []);
  assert.equal(connectionExchange('bitget'), null);
  assert.throws(() => parseConnection({ ...key, accountMode: 'auto' }), /accountMode/);
  const connected = await store.connect(key);
  assert.deepEqual(w.calls, [info3, mode]);
  assert.deepEqual(connected.rows, before.rows); assert.deepEqual(connected.summary, before.summary);
  assert.deepEqual(snapshots(), original);
  assert.deepEqual(connected.ledger?.connections.bitget, { configured: true, lastSync: new Date(w.at).toISOString(), scope: '统一账户充值核验', accountMode: 'uta', error: null });
  const encrypted = saved()!;
  assert.ok(encrypted.length > 64);
  for (const privateValue of [key.apiKey, key.apiSecret, key.passphrase, userId, recipient]) {
    assert.ok(!JSON.stringify(connected).includes(privateValue)); assert.ok(!encrypted.includes(privateValue));
  }
  w.at += 2000;
  const [proof, same] = await Promise.all([read(), read()]);
  assert.equal(proof, same);
  assert.deepEqual(proof, { symbol: 'ARB', chain: 'arbitrum', contract: token, minDeposit: net.minDepositAmount, at: w.at, expiresAt: w.at + 60_000 });
  assert.deepEqual(w.calls, [info3, mode, info3, mode, coins3, addr3]);
  assert.equal(store.bitgetDepositRecipient(proof), recipient); assert.equal(store.bitgetDepositCurrent({ ...proof }), false);
  w.at += 2000; await store.connect(key); assert.equal(saved(), encrypted); assert.ok(store.bitgetDepositCurrent(proof));
  const disconnected = await store.disconnect({ exchange: 'bitget' });
  assert.equal(disconnected.ledger?.connections.bitget.configured, false);
  assert.equal(store.bitgetDepositCurrent(proof), false); assert.equal(saved(), undefined); assert.deepEqual(snapshots(), original);
});

test('Bitget Classic 只接受明确的只读权限，UTA 严格验证账户模式、UID 与管理读权，不跨版本回退', async t => {
  const { store, w, read, saved } = await setup(t);
  for (const [path, value, accountMode, expected] of [
    [info3, { ...rights, permType: 'read-and-write' }, 'uta', [info3]],
    [info3, { ...rights, permType: 'readonly' }, 'uta', [info3]],
    [info3, { ...rights, permissions: ['uta_mgt', 'withdraw'] }, 'uta', [info3]],
    [info3, { ...rights, permissions: [] }, 'uta', [info3]],
    [mode, { ...settings, uid: '999' }, 'uta', [info3, mode]],
    ...['upgrading', 'switching', 'hybrid'].map(accountMode => [mode, { ...settings, accountMode }, 'uta', [info3, mode]] as const),
    ...[[], ['stor', 'p2p'], ['future_read'], ['stor', 'wwow']].map(authorities => [info2, { ...classic, authorities }, 'classic', [info2]] as const),
  ] as const) {
    w.calls.length = 0;
    w.handle = (url, at) => success(url.pathname === path ? value : fixtures.get(url.pathname), at);
    await assert.rejects(store.connect({ ...key, accountMode }), /Bitget/);
    assert.deepEqual(w.calls, expected); assert.equal(saved(), undefined);
    w.at += 2000;
  }
  w.calls.length = 0; w.handle = null;
  await store.connect({ ...key, accountMode: 'classic' }); w.at += 2000;
  assert.equal(store.bitgetDepositRecipient(await read()), recipient);
  assert.deepEqual(w.calls, [info2, info2, coins2, addr2]);
});

test('Bitget 充值逐链核对，拒绝重复身份、费用、最低额缺失、附言、停充和默认链，提现费用不影响证明', async t => {
  const { store, w, read } = await setup(t); await store.connect(key);
  const network = (fields: Record<string, unknown>) => [{ ...coin, chains: [{ ...net, ...fields }] }];
  for (const data of [
    [coin, coin], [{ ...coin, transfer: 'false' }], [{ ...coin, chains: [net, { ...net, chain: 'arbitrumone' }] }],
    [coin, { coin: 'OTHER', chains: [{ ...net, rechargeable: 'false' }] }],
    ...[{ minDepositAmount: null }, { minDepositAmount: '1e-3' }, { needTag: 'true' }, { rechargeable: 'false' },
      { contractAddress: other }, { chain: 'ARBITRUM' }, { congestion: 'congested' }, { depositFee: '0.25' }, { extraDepositFee: '' }].map(network),
  ]) {
    w.at += 65_000; w.calls.length = 0;
    w.handle = (url, at) => success(url.pathname === coins3 ? data : fixtures.get(url.pathname), at);
    await assert.rejects(read(), /Bitget/); assert.ok(!w.calls.includes(addr3));
  }
  for (const fields of [{ coin: 'OTHER' }, { coin: undefined }, { chain: 'Arbitrum' }, { chain: undefined }, { address: token },
    { address: '0x' + '00'.repeat(20) }, { address: '0xf' }, { tag: '0' }, { memo: 'memo' }, { tag: undefined }]) {
    w.at += 65_000; w.handle = (url, at) => success(url.pathname === addr3 ? { ...address, ...fields } : fixtures.get(url.pathname), at);
    await assert.rejects(read(), /Bitget/);
  }
  w.at += 65_000;
  w.handle = (url, at) => success(fixtures.get(url.pathname), at, url.pathname === mode ? { age: '2' } : {});
  const proof = await read();
  assert.equal(w.at - proof.at, 2999); assert.equal(store.bitgetDepositRecipient(proof), recipient);
  w.at = proof.expiresAt; assert.equal(store.bitgetDepositCurrent(proof), false);
  w.at -= 1000; assert.equal(store.bitgetDepositCurrent(proof), false);
});

test('Bitget 明确拒权撤销已发证明，拒绝前的权限缓存无法恢复连接或地址', async t => {
  const { store, w, read } = await setup(t); await store.connect(key); w.at += 2000;
  const original = await read();
  w.handle = (url, at) => success(url.pathname === info3 ? { ...rights, permType: 'read-and-write' } : fixtures.get(url.pathname), at);
  await assert.rejects(store.connect(key), /只读/);
  assert.equal(store.bitgetDepositRecipient(original), undefined);
  const deniedAt = w.at; w.at += 4000;
  w.handle = (url, at) => success(fixtures.get(url.pathname), url.pathname === info3 ? deniedAt : at);
  await assert.rejects(store.connect(key), /Bitget/); await assert.rejects(read(), /Bitget/);
  w.at += 4000; w.handle = null;
  const renewed = await read();
  assert.ok(store.bitgetDepositCurrent(renewed));
  w.handle = () => Response.json({ code: '40037', msg: key.apiSecret }, { status: 400 });
  const failure = await store.bitgetDepositProof('ARB', 'bsc', other, signal()).then(() => '', error => String(error.stack));
  assert.ok(failure.includes('Bitget') && !failure.includes(key.apiSecret)); assert.equal(store.bitgetDepositCurrent(renewed), false);
  for (const rejection of [new Response(null, { status: 401 }), new Response(null, { status: 403 }),
    ...['25620', '40024', '40026', '40031'].map(code => Response.json({ code }, { status: 400 }))]) {
    w.at += 4000; w.handle = null;
    const active = await read();
    w.handle = () => rejection;
    await assert.rejects(store.bitgetDepositProof('ARB', 'bsc', other, signal()), /Bitget/);
    assert.equal(store.bitgetDepositRecipient(active), undefined);
  }
  w.at += 4000; w.handle = null;
  const active = await read();
  w.handle = (url, at) => success(url.pathname === mode ? { ...settings, uid: '999' } : fixtures.get(url.pathname), at);
  await assert.rejects(store.connect(key), /Bitget/);
  assert.equal(store.bitgetDepositCurrent(active), false);
});

test('Bitget 连接验证和币链扫描共用限流退避，重试期限到达才再发请求', async t => {
  const { store, w, read } = await setup(t);
  await store.connect(key); w.at += 2000;
  const limited = () => new Response(key.passphrase, { status: 429, headers: { 'retry-after': '90' } });
  const safe = (e: unknown) => e instanceof Error && e.message.includes('Bitget') &&
    ![key.passphrase, key.apiSecret, key.apiKey].some(secret => String(e.stack).includes(secret));
  w.handle = limited;
  await assert.rejects(store.connect(key), safe);
  const afterConnect = w.calls.length;
  w.at += 89_999;
  await assert.rejects(read(), safe); await assert.rejects(store.connect(key), safe);
  assert.equal(w.calls.length, afterConnect);
  w.at++; w.handle = null;
  const first = await read();
  assert.equal(store.bitgetDepositRecipient(first), recipient);
  w.handle = limited;
  await assert.rejects(store.bitgetDepositProof('ARB', 'bsc', other, signal()), safe);
  const afterScan = w.calls.length;
  w.at += 89_999;
  await assert.rejects(store.connect(key), safe); await assert.rejects(read(), safe);
  assert.equal(w.calls.length, afterScan);
  w.at++; w.handle = null;
  await store.connect(key); assert.deepEqual(w.calls.slice(afterScan), [info3, mode]);
});

test('Bitget 配置状态只读本地库和密钥，损坏、断开和关闭后均不可用', async t => {
  const { store, w, db, saved } = await setup(t);
  assert.equal(store.bitgetDepositConnected(), false); assert.deepEqual(w.calls, []);
  await store.connect(key); w.calls.length = 0;
  assert.ok(store.bitgetDepositConnected());
  const ciphertext = saved()!;
  const replace = (encrypted: string) => db.prepare("UPDATE connections SET encrypted=? WHERE exchange='bitget'").bind(encrypted).run();
  replace('malformed'); assert.equal(store.bitgetDepositConnected(), false);
  replace(ciphertext); assert.ok(store.bitgetDepositConnected());
  await store.disconnect({ exchange: 'bitget' }); assert.equal(store.bitgetDepositConnected(), false);
  store.close(); assert.equal(store.bitgetDepositConnected(), false);
  assert.deepEqual(w.calls, []);
});
