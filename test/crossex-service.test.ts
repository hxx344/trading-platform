// The service side of the Gate CrossEx module: config.json `crossex` and its caps, secrets.json `gate`, the store's
// key markers and clamped config, the start check, the /api/crossex routes, and the workbench import. Gate is a fake
// fetch here and the workbench a temp directory: nothing reaches an exchange.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import { createExecutorServer, type ServiceViews } from '../src/http.ts';
import { KEY_MARKER, SECRET_MARKER, openCrossexStore } from '../src/crossex/store.ts';
import { crossexSummary, limitProblem, parseCrossexConfig, parseCrossexSecrets } from '../src/service/crossex-config.ts';
import { closeCrossex, crossexViews, executionAlerts, preflightCrossex, prepareCrossex, type CrossexRuntime } from '../src/service/crossex.ts';
import { parseServiceConfig, parseServiceSecrets } from '../src/service/config.ts';
import { LEASE_WARNING, planCrossex, readWorkbenchCrossex, writeCrossexSettingsAsService } from '../src/service/import-crossex.ts';
import { fileText, planImport } from '../src/service/import-workbench.ts';
import { parseImportBody, readImportResult, submitImportRequest } from '../src/service/import-channel.ts';
import { runImportHelper } from '../src/service/import-helper.ts';
import { bindAccounts, createHarness } from './harness.ts';

const KEY = 'gate-crossex-test-key-0001aaaa';
const SECRET = 'gate-crossex-test-secret-0001bbbbbbbbbbbb';
const LIMITS = { notionalPerLeg: 100, maxOpen: 3, maxTotalNotional: 1000 };
// A UID per start test, so the host account lock of one never meets another.
let uidSeed = 900_000_000 + Math.floor(Math.random() * 1_000_000);
const nextUid = (): string => String(++uidSeed);
const noKey = (text: string): void => {
  assert.ok(!text.includes(KEY) && !text.includes(SECRET), 'the key must not appear');
  assert.ok(!text.includes(KEY_MARKER) && !text.includes(SECRET_MARKER), 'no key marker either');
};

test('config.json crossex：UID 与三项上限的检查；--check-config 只显示 UID 末四位', () => {
  const crossex = { accountUid: '123456789', credentialVersion: 2, limits: LIMITS };
  const parsed = parseServiceConfig({ secretsFile: '/etc/tp/secrets.json', crossex });
  assert.deepEqual(parsed.crossex, crossex);
  assert.deepEqual(parsed.pairs, []);
  assert.throws(() => parseCrossexConfig({ ...crossex, accountUid: 123456789 }), /UID/);
  assert.throws(() => parseCrossexConfig({ ...crossex, accountUid: '0123' }), /UID/);
  assert.throws(() => parseCrossexConfig({ ...crossex, extra: 1 }), /crossex 无效/);
  assert.throws(() => parseCrossexConfig({ ...crossex, credentialVersion: 0 }), /正整数/);
  assert.throws(() => parseCrossexConfig({ ...crossex, limits: { ...LIMITS, notionalPerLeg: 100_001 } }), /notionalPerLeg 须为 5–100000/);
  assert.throws(() => parseCrossexConfig({ ...crossex, limits: { ...LIMITS, maxOpen: 1.5 } }), /maxOpen 须为 1–20 的整数/);
  assert.throws(() => parseCrossexConfig({ ...crossex, limits: { ...LIMITS, maxTotalNotional: 150 } }), /两倍/);
  assert.throws(() => parseCrossexConfig({ ...crossex, limits: { notionalPerLeg: 100, maxOpen: 3 } }), /crossex.limits 无效/);
  const line = crossexSummary(parsed.crossex);
  assert.match(line, /Gate \*\*\*6789（单腿上限 100 USDT，最多 3 组，总额上限 1000 USDT）/);
  assert.ok(!line.includes('123456789'));
  assert.equal(crossexSummary(undefined), '');
});

test('secrets.json gate：只在配置了 crossex 时接受；字段与格式错误不回显密钥', () => {
  const secrets = parseServiceSecrets({ accounts: {}, gate: { apiKey: KEY, apiSecret: SECRET } }, [], [], false, true);
  assert.deepEqual(secrets.gate, { apiKey: KEY, apiSecret: SECRET });
  assert.throws(() => parseServiceSecrets({ accounts: {}, gate: { apiKey: KEY, apiSecret: SECRET } }, []), /不支持的字段|gate/);
  assert.throws(() => parseCrossexSecrets({}), /缺少 gate 的密钥/);
  for (const gate of [{ apiKey: KEY }, { apiKey: KEY, apiSecret: SECRET, extra: KEY }, [KEY, SECRET]]) {
    assert.throws(() => parseCrossexSecrets({ gate }), (error: Error) => { noKey(error.message); return /apiKey、apiSecret/.test(error.message); });
  }
  assert.throws(() => parseCrossexSecrets({ gate: { apiKey: `${KEY} with space`, apiSecret: SECRET } }), (error: Error) => { noKey(error.message); return /格式无效/.test(error.message); });
});

test('store：只为配置的密钥写标记、只从标记读回；config() 不超过 config.json 的上限；文件仅属主可读写', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-crossex-store-'));
  try {
    const store = openCrossexStore(dir, { secret: { apiKey: ` ${KEY} `, apiSecret: SECRET }, limits: LIMITS });
    try {
      assert.equal(store.encrypt(KEY), KEY_MARKER);
      assert.equal(store.encrypt(SECRET), SECRET_MARKER);
      assert.equal(store.decrypt(KEY_MARKER), KEY);
      assert.equal(store.decrypt(SECRET_MARKER), SECRET);
      assert.equal(store.decrypt(''), '');
      assert.equal(store.decrypt(null), '');
      assert.throws(() => store.encrypt('monitor-password'), /本服务不保存密钥/);
      assert.throws(() => store.decrypt('c29tZS1jaXBoZXJ0ZXh0'), /凭据标记无法识别/);
      store.set('config', { notionalPerLeg: 500, maxOpen: 10, maxTotalNotional: 5000, slippageBps: 7 });
      const raised = store.config();
      assert.deepEqual([raised.notionalPerLeg, raised.maxOpen, raised.maxTotalNotional, raised.slippageBps], [100, 3, 1000, 7]);
      store.set('config', { notionalPerLeg: 20, maxOpen: 1, maxTotalNotional: 40 });
      const lowered = store.config();
      assert.deepEqual([lowered.notionalPerLeg, lowered.maxOpen, lowered.maxTotalNotional], [20, 1, 40]);
      assert.equal(store.transaction(() => 5), 5);
      assert.throws(() => store.transaction(() => { store.set('x', 1); throw new Error('roll back'); }), /roll back/);
      assert.equal(store.get('x', null), null);
    } finally { store.close(); }
    assert.equal(statSync(join(dir, 'crossex.sqlite')).mode & 0o777, 0o600);
    const raw = new DatabaseSync(join(dir, 'crossex.sqlite'));
    try { assert.equal((raw.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal'); } finally { raw.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('启动检查：密钥的 UID 不是配置的 UID、Gate 没给 UID、超时都拒绝', async () => {
  const config = { accountUid: '123456789', limits: LIMITS };
  await preflightCrossex({ getAccountDetail: async () => ({ user_id: 123456789 }) }, config, Date.now() + 1000);
  await assert.rejects(preflightCrossex({ getAccountDetail: async () => ({ user_id: 987654321 }) }, config, Date.now() + 1000), /Gate 账户 \*\*\*4321，与配置的 \*\*\*6789 不符/);
  await assert.rejects(preflightCrossex({ getAccountDetail: async () => ({}) }, config, Date.now() + 1000), /没有返回有效的账户 UID/);
  await assert.rejects(preflightCrossex({ getAccountDetail: () => new Promise(() => undefined) }, config, Date.now() + 20), /超时/);
});

/** Gate as the runtime's connection reads it: one cross-exchange account, nothing open. */
function fakeGate(uid: string, calls: string[] = []) {
  const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    assert.equal(url.origin, 'https://api.gateio.ws');
    assert.notEqual(init?.method, 'POST', 'the start check never places an order');
    if (url.pathname === '/api/v4/account/detail') return json({ user_id: Number(uid) });
    if (url.pathname === '/api/v4/crossex/accounts') return json({ user_id: uid, position_mode: 'SINGLE', account_mode: 'CROSS_EXCHANGE', exchange_type: 'CROSSEX', available_margin: '100', margin_balance: '100', initial_margin: '0', maintenance_margin: '0', initial_margin_rate: '0', maintenance_margin_rate: '0', assets: [] });
    return json([]);
  };
}
const offline = async () => { throw new Error('offline in tests'); };
const OFFLINE_MARKET = { catalogReader: offline, feedReader: offline, depthReader: offline, fxReader: offline, identityReader: offline, currentFundingReader: offline };

async function started(uid: string, dir: string, keyUid = uid): Promise<CrossexRuntime> {
  return prepareCrossex({ accountUid: uid, limits: LIMITS }, { apiKey: KEY, apiSecret: SECRET }, dir, { fetchImpl: fakeGate(keyUid), marketOptions: OFFLINE_MARKET, preflightTimeoutMs: 5000 });
}

test('启动：连上配置的 UID，库里只留标记；UID 不符拒绝启动并释放账户锁', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-crossex-start-')), uid = nextUid();
  try {
    await assert.rejects(started(uid, dir, '111111111'), /CrossEx 账户启动检查未通过，拒绝启动：密钥属于 Gate 账户 \*\*\*1111/);
    // The lock was released: the next start takes it.
    const runtime = await started(uid, dir);
    try {
      await assert.rejects(started(uid, dir), /已被本机另一个实盘执行器占用/, 'a second process on the same account is refused');
      const db = runtime.store.db;
      const row = db.prepare('SELECT json FROM live_connection WHERE singleton=1').get() as { json: string };
      const record = JSON.parse(row.json) as Record<string, unknown>;
      assert.deepEqual([record.enabled, record.apiKey, record.apiSecret, String(record.accountUid)], [true, KEY_MARKER, SECRET_MARKER, uid]);
      assert.equal(record.accountReference, createHash('sha256').update(JSON.stringify(KEY)).digest('hex'));
      const all = db.prepare("SELECT group_concat(value, '|') AS text FROM settings").get() as { text: string | null };
      assert.ok(!(all.text ?? '').includes(KEY) && !(all.text ?? '').includes(SECRET));
    } finally { await closeCrossex(runtime); }
    // A restart on the saved connection keeps it (no second connect) and holds the lock again.
    const again = await started(uid, dir);
    await closeCrossex(again);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const TOKEN = 'crossex-access-token-0001';
const SESSION = 'crossex-session-value-0001';
async function withServer(views: ServiceViews | undefined, run: (call: (method: string, path: string, body?: unknown, extra?: { cookie?: boolean; marker?: boolean }) => Promise<Response>) => Promise<void>) {
  const h = createHarness();
  bindAccounts(h.ex);
  const server = createExecutorServer({ executor: h.ex, accessToken: TOKEN, session: SESSION, ...(views ? { views } : {}) });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const login = await fetch(`${base}/login?token=${TOKEN}`, { redirect: 'manual' });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    await run((method, path, body, { cookie: withCookie = true, marker = true } = {}) => fetch(base + path, {
      method, headers: { ...(withCookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(marker ? { 'x-pa-executor': '1' } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
  } finally { await new Promise(resolve => server.close(resolve)); h.dispose(); }
}

test('路由：没有 crossex 时 404；须登录；写请求须带请求标记', () => withServer(undefined, async call => {
  const missing = await call('GET', '/api/crossex/state');
  assert.equal(missing.status, 404);
  assert.match(((await missing.json()) as { message: string }).message, /没有配置 CrossEx/);
  assert.equal((await call('GET', '/api/crossex/bootstrap', undefined, { cookie: false })).status, 401);
}));

test('路由：bootstrap / state 不含密钥；超过上限的设置 400；页面设置可保存；未知路径 404', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-crossex-routes-')), uid = nextUid();
  const runtime = await started(uid, dir);
  try {
    await withServer({ crossex: crossexViews(runtime) }, async call => {
      assert.equal((await call('GET', '/api/crossex/state', undefined, { cookie: false })).status, 401);
      const boot = await call('GET', '/api/crossex/bootstrap');
      assert.equal(boot.status, 200);
      const bootText = await boot.text();
      noKey(bootText);
      const parsed = JSON.parse(bootText) as { limits: unknown; connection: { enabled?: boolean; keySuffix?: string } };
      assert.deepEqual(parsed.limits, LIMITS);
      assert.equal(parsed.connection.keySuffix, KEY.slice(-4));
      const state = await call('GET', '/api/crossex/state?opportunities=0');
      assert.equal(state.status, 200);
      const stateText = await state.text();
      noKey(stateText);
      assert.deepEqual((JSON.parse(stateText) as { limits: unknown }).limits, LIMITS);

      const over = await call('PUT', '/api/crossex/settings', { config: { notionalPerLeg: 101 } });
      assert.equal(over.status, 400);
      assert.match(((await over.json()) as { message: string }).message, /单腿名义额度不能超过服务配置的上限 100 USDT/);
      const tooMany = await call('POST', '/api/crossex/settings', { config: { maxOpen: 4 } });
      assert.equal(tooMany.status, 400);
      assert.match(((await tooMany.json()) as { message: string }).message, /最多同时持仓组数不能超过服务配置的上限 3 组/);
      assert.equal((await call('PUT', '/api/crossex/settings', { monitorPassword: 'x' })).status, 400);
      assert.equal((await call('PUT', '/api/crossex/settings', { config: { notionalPerLeg: 50 } }, { marker: false })).status, 403);
      const saved = await call('PUT', '/api/crossex/settings', { config: { notionalPerLeg: 50, maxTotalNotional: 400 } });
      assert.equal(saved.status, 200, await saved.clone().text());
      const config = runtime.store.config();
      assert.deepEqual([config.notionalPerLeg, config.maxTotalNotional], [50, 400]);
      assert.equal((await call('GET', '/api/crossex/nothing-here')).status, 404);
      assert.equal((await call('GET', '/api/crossex/requests/%E0%A4%A')).status, 400);
    });
  } finally { await closeCrossex(runtime); rmSync(dir, { recursive: true, force: true }); }
});

test('limitProblem 只看三项上限，其他设置不受影响', () => {
  assert.equal(limitProblem({ config: { slippageBps: 99 } }, LIMITS), undefined);
  assert.equal(limitProblem({ config: { notionalPerLeg: 100, maxOpen: 3, maxTotalNotional: 1000 } }, LIMITS), undefined);
  assert.match(limitProblem({ config: { maxTotalNotional: 1001 } }, LIMITS) ?? '', /总双腿名义额度不能超过服务配置的上限 1000 USDT/);
  assert.equal(limitProblem(null, LIMITS), undefined);
});

test('飞书提醒：每笔执行每类只一条键，超过 24 小时的不提', () => {
  const now = Date.now();
  const alerts = executionAlerts([
    { id: 'e1', kind: 'open', base: 'BTC', state: 'completed', updatedAt: now, legs: [{ status: 'FILLED' }, { status: 'FILLED' }] },
    { id: 'e2', kind: 'open', base: 'ETH', state: 'reconciling', updatedAt: now, legs: [{ status: 'FILLED' }, { status: 'UNKNOWN' }] },
    { id: 'old', kind: 'open', base: 'SOL', state: 'partial', updatedAt: now - 25 * 3_600_000, legs: [{ status: 'FILLED' }, { status: 'UNSENT' }] },
  ], now);
  const keys = alerts.map(alert => alert.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.includes('crossex:e1:finished'));
  assert.ok(keys.includes('crossex:e2:unknown'));
  assert.ok(!keys.some(key => key.startsWith('crossex:old:')));
});

// ---- workbench import ----

const WB_UID = '4455667788';
const encryptWb = (key: Buffer, value: string): string => {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]).toString('base64');
};
interface WorkbenchShape { connection?: Record<string, unknown> | null | ((key: Buffer) => Record<string, unknown>); executions?: { id: string; orders: string[] }[]; cacheOrders?: string[]; lease?: number; config?: Record<string, unknown> }
/** A workbench data directory with modules/crossex as the workbench CrossEx module leaves it (schema of live-runtime.mjs). */
function writeWorkbench(root: string, shape: WorkbenchShape = {}): { data: string; key: Buffer } {
  const data = join(root, 'wb'), dir = join(data, 'modules', 'crossex');
  mkdirSync(dir, { recursive: true });
  const key = randomBytes(32);
  writeFileSync(join(dir, 'credentials.key'), key, { mode: 0o600 });
  const db = new DatabaseSync(join(dir, 'crossex.sqlite'));
  try {
    db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE live_connection (singleton INTEGER PRIMARY KEY CHECK(singleton=1), json TEXT NOT NULL);
      CREATE TABLE live_cache (singleton INTEGER PRIMARY KEY CHECK(singleton=1), json TEXT NOT NULL);
      CREATE TABLE live_owner (singleton INTEGER PRIMARY KEY CHECK(singleton=1), owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE live_executions (id TEXT PRIMARY KEY, preview_id TEXT UNIQUE NOT NULL, updated_at INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE live_orders (id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, text TEXT UNIQUE NOT NULL, version INTEGER NOT NULL, state TEXT NOT NULL, updated_at INTEGER NOT NULL, json TEXT NOT NULL);`);
    const connection = typeof shape.connection === 'function' ? shape.connection(key) : shape.connection === undefined
      ? { enabled: true, version: 3, accountUid: WB_UID, accountReference: createHash('sha256').update(JSON.stringify(KEY)).digest('hex'), keySuffix: KEY.slice(-4), apiKey: encryptWb(key, KEY), apiSecret: encryptWb(key, SECRET), exchangeType: undefined, verifiedAt: 1, tradePermission: 'unknown' }
      : shape.connection;
    if (connection !== null) db.prepare('INSERT INTO live_connection VALUES (1, ?)').run(JSON.stringify(connection));
    let n = 0;
    for (const execution of shape.executions ?? []) {
      db.prepare('INSERT INTO live_executions VALUES (?,?,?,?)').run(execution.id, `p-${execution.id}`, 1, '{}');
      for (const state of execution.orders) db.prepare('INSERT INTO live_orders VALUES (?,?,?,?,?,?,?)').run(`o${++n}`, execution.id, `cx-${n}`, 3, state, 1, '{}');
    }
    db.prepare('INSERT INTO live_cache VALUES (1, ?)').run(JSON.stringify({ openOrders: (shape.cacheOrders ?? []).map(state => ({ state })) }));
    if (shape.lease !== undefined) db.prepare("INSERT INTO live_owner VALUES (1, 'workbench', ?)").run(shape.lease);
    if (shape.config) db.prepare("INSERT INTO settings VALUES ('config', ?)").run(JSON.stringify(shape.config));
  } finally { db.close(); }
  return { data, key };
}
const withWorkbench = (shape: WorkbenchShape, run: (data: string, root: string, key: Buffer) => void | Promise<void>) => async () => {
  const root = mkdtempSync(join(tmpdir(), 'tp-crossex-import-'));
  try { const { data, key } = writeWorkbench(root, shape); await run(data, root, key); } finally { rmSync(root, { recursive: true, force: true }); }
};

test('导入：解密工作台的 Gate 密钥，额度与页面设置沿用工作台', withWorkbench({ config: { notionalPerLeg: 80, maxOpen: 2, maxTotalNotional: 500, slippageBps: 12, entryPaused: true } }, data => {
  const source = readWorkbenchCrossex(data);
  assert.equal(source.problem, null);
  assert.deepEqual(source.credentials, { apiKey: KEY, apiSecret: SECRET });
  assert.deepEqual([source.accountUid, source.credentialVersion, source.leaseActive], [WB_UID, 3, false]);
  assert.deepEqual(source.limits, { notionalPerLeg: 80, maxOpen: 2, maxTotalNotional: 500 });
  assert.deepEqual([source.settings?.slippageBps, source.settings?.entryPaused, source.settings?.maxOpen], [12, true, 2]);
  assert.deepEqual(Object.keys(source.settings ?? {}).sort(), ['cooldownSeconds', 'entryPaused', 'feeBps', 'feeSchedule', 'maxOpen', 'maxTotalNotional', 'minNetBps', 'notionalPerLeg', 'slippageBps']);

  const plan = planImport({ pairs: [], accounts: [], env: {} }, null, { secretsFile: '/x/secrets.json', only: [], crossex: source });
  assert.equal(plan.crossex?.status, 'added', plan.crossex?.detail);
  assert.equal(plan.crossex?.accountId, `***${WB_UID.slice(-4)}`);
  assert.deepEqual(plan.config.crossex, { accountUid: WB_UID, credentialVersion: 3, limits: { notionalPerLeg: 80, maxOpen: 2, maxTotalNotional: 500 } });
  assert.deepEqual(plan.secrets.gate, { apiKey: KEY, apiSecret: SECRET });
  assert.equal(plan.crossexSettings?.slippageBps, 12);
  noKey(JSON.stringify({ item: plan.crossex, notes: plan.notes }));
  // The files it would write pass the service's own checks.
  const parsed = parseServiceConfig(plan.config);
  assert.equal(parseServiceSecrets(plan.secrets, [], [], false, parsed.crossex !== undefined).gate?.apiKey, KEY);
}));

test('导入：缺省设置时额度取工作台默认值', withWorkbench({}, data => {
  const source = readWorkbenchCrossex(data);
  assert.equal(source.problem, null);
  assert.ok(source.limits && source.limits.maxTotalNotional >= 2 * source.limits.notionalPerLeg);
}));

for (const [name, shape, reason] of [
  ['没有连接', { connection: null }, /没有连接实盘账户/],
  ['已断开', { connection: { enabled: false, version: 4, accountUid: WB_UID, apiKey: null, apiSecret: null } }, /已断开/],
  ['记录格式错误', { connection: { enabled: true, version: 'x', apiKey: 'a', apiSecret: 'b' } }, /格式错误/],
  ['没有 UID', { connection: (key: Buffer) => ({ enabled: true, version: 2, accountUid: null, apiKey: encryptWb(key, KEY), apiSecret: encryptWb(key, SECRET) }) }, /须在工作台重新验证/],
  ['执行未结束', { executions: [{ id: 'e1', orders: ['FILLED', 'UNKNOWN'] }] }, /1 笔执行未结束/],
  ['执行没有订单', { executions: [{ id: 'e1', orders: [] }] }, /1 笔执行未结束/],
  ['账户挂单', { cacheOrders: ['OPEN'] }, /1 笔挂单/],
] as [string, WorkbenchShape, RegExp][]) {
  test(`导入拒绝：${name}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'tp-crossex-refuse-'));
    try {
      const { data } = writeWorkbench(root, shape);
      const source = readWorkbenchCrossex(data);
      assert.match(source.problem ?? '', reason);
      assert.equal(source.credentials, null);
      const plan = planImport({ pairs: [], accounts: [], env: {} }, null, { secretsFile: '/x/secrets.json', only: [], crossex: source });
      assert.equal(plan.crossex?.status, 'skipped');
      assert.equal(plan.config.crossex, undefined);
      assert.equal(plan.secrets.gate, undefined);
      noKey(JSON.stringify(plan.crossex));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('导入拒绝：订单未结束（不论属于哪笔执行）', withWorkbench({ executions: [{ id: 'e1', orders: ['FILLED'] }] }, data => {
  const db = new DatabaseSync(join(data, 'modules', 'crossex', 'crossex.sqlite'));
  try { db.prepare("INSERT INTO live_orders VALUES ('stray', 'gone', 'cx-stray', 3, 'SENDING', 1, '{}')").run(); } finally { db.close(); }
  assert.match(readWorkbenchCrossex(data).problem ?? '', /1 笔订单未结束或结果未知/);
}));

test('导入拒绝：credentials.key 与库不匹配时不能解密，信息不含密文', withWorkbench({}, data => {
  writeFileSync(join(data, 'modules', 'crossex', 'credentials.key'), randomBytes(32));
  const source = readWorkbenchCrossex(data);
  assert.match(source.problem ?? '', /凭据无法解密/);
  assert.equal(source.credentials, null);
  writeFileSync(join(data, 'modules', 'crossex', 'credentials.key'), randomBytes(16));
  assert.throws(() => readWorkbenchCrossex(data), /长度不是 32 字节/);
}));

test('导入：工作台仍持有执行租约只提示断开，不拒绝', withWorkbench({ lease: Date.now() + 60_000 }, data => {
  const source = readWorkbenchCrossex(data);
  assert.equal(source.problem, null);
  assert.equal(source.leaseActive, true);
  const plan = planImport({ pairs: [], accounts: [], env: {} }, null, { secretsFile: '/x/secrets.json', only: [], crossex: source });
  assert.equal(plan.crossex?.status, 'added');
  assert.equal(plan.crossex?.warning, LEASE_WARNING);
  assert.ok(plan.notes.some(note => note.includes(LEASE_WARNING)));
  // A lease that ran out is no warning.
  assert.equal(readWorkbenchCrossex(data, Date.now() + 120_000).leaseActive, false);
}));

test('导入不覆盖：已有 crossex 保留现有设置；只有 gate 没有 crossex 也不覆盖', withWorkbench({}, data => {
  const source = readWorkbenchCrossex(data);
  const existing = { config: { secretsFile: '/x/secrets.json', pairs: [], crossex: { accountUid: '111222333', limits: LIMITS } }, secrets: { accounts: {}, gate: { apiKey: 'other-key-0000', apiSecret: 'other-secret' } } };
  const kept = planImport({ pairs: [], accounts: [], env: {} }, existing, { secretsFile: '/x/secrets.json', only: [], crossex: source });
  assert.equal(kept.crossex?.status, 'skipped');
  assert.match(kept.crossex?.detail ?? '', /保留现有设置/);
  assert.deepEqual(kept.config.crossex, existing.config.crossex);
  assert.deepEqual(kept.secrets.gate, existing.secrets.gate);
  assert.equal(kept.crossexSettings, null);

  const config: Record<string, unknown> = { secretsFile: '/x/secrets.json', pairs: [] }, secrets: Record<string, unknown> = { accounts: {}, gate: { apiKey: 'other-key-0000', apiSecret: 'other-secret' } };
  const { item, settings } = planCrossex(source, config, secrets, () => undefined, []);
  assert.equal(item.status, 'skipped');
  assert.match(item.detail, /已有 gate/);
  assert.equal(settings, null);
  assert.equal(config.crossex, undefined);
  assert.deepEqual(secrets.gate, { apiKey: 'other-key-0000', apiSecret: 'other-secret' });
}));

test('导入：页面设置只在本服务没有设置时写入 crossex.sqlite', withWorkbench({ config: { slippageBps: 9 } }, (data, root) => {
  const source = readWorkbenchCrossex(data), dataDir = join(root, 'svc');
  mkdirSync(dataDir, { mode: 0o700 });
  assert.equal(writeCrossexSettingsAsService(dataDir, source.settings!), true);
  assert.equal(writeCrossexSettingsAsService(dataDir, { ...source.settings!, slippageBps: 30 }), false);
  const store = openCrossexStore(dataDir, { secret: { apiKey: KEY, apiSecret: SECRET }, limits: LIMITS });
  try { assert.equal(store.config().slippageBps, 9); } finally { store.close(); }
  assert.throws(() => writeCrossexSettingsAsService(dataDir, { slippageBps: 9 }), /字段不符/);
  assert.equal(statSync(join(dataDir, 'crossex.sqlite')).mode & 0o777, 0o600);
}));

test('页面请求：crossex 只能是 true，可单独导入', () => {
  assert.deepEqual(parseImportBody({ action: 'import', crossex: true }), { action: 'import', pairs: [], crossex: true });
  assert.throws(() => parseImportBody({ action: 'import', crossex: 1 }), /crossex 只能是 true/);
  assert.throws(() => parseImportBody({ action: 'preview', crossex: true }), /预览不选配对/);
});

test('导入助手：预览与导入 CrossEx 账户，结果文件不含密钥', withWorkbench({ config: { slippageBps: 11 } }, async (data, root) => {
  const conf = join(root, 'conf'), dir = join(root, 'import'), svc = join(root, 'svc');
  for (const path of [conf, dir, svc]) mkdirSync(path, { recursive: true });
  writeFileSync(join(root, 'workbench.env'), `DATA_DIR=${data}\n`);
  const configFile = join(conf, 'config.json'), secretsFile = join(conf, 'secrets.json');
  writeFileSync(secretsFile, fileText({ accounts: {} }), { mode: 0o600 });
  writeFileSync(configFile, fileText({ secretsFile, pairs: [] }), { mode: 0o600 });
  const restarts: string[] = [];
  const options = { dir, configFile, dataDir: svc, workbenchEnv: join(root, 'workbench.env'), log: () => undefined, checkConfig: () => 'ok',
    restart: async () => { restarts.push(readFileSync(configFile, 'utf8')); return true; } };

  submitImportRequest(dir, { action: 'preview' });
  await runImportHelper(options);
  const shown = readImportResult(dir)!;
  assert.equal(shown.phase, 'done', shown.message);
  assert.match(shown.message, /CrossEx 账户可以导入/);
  assert.deepEqual([shown.crossex?.status, shown.crossex?.accountId], ['added', `***${WB_UID.slice(-4)}`]);
  assert.equal(readFileSync(configFile, 'utf8'), fileText({ secretsFile, pairs: [] }), '预览不写文件');
  noKey(readFileSync(join(dir, 'result.json'), 'utf8'));

  submitImportRequest(dir, { action: 'import', crossex: true });
  await runImportHelper(options);
  const done = readImportResult(dir)!;
  assert.equal(done.phase, 'done', done.message);
  assert.match(done.message, /CrossEx 账户（Gate \*\*\*7788）/);
  assert.equal(restarts.length, 1);
  assert.equal((JSON.parse(readFileSync(configFile, 'utf8')) as { crossex: { accountUid: string } }).crossex.accountUid, WB_UID);
  assert.ok(readFileSync(secretsFile, 'utf8').includes(KEY));
  noKey(readFileSync(join(dir, 'result.json'), 'utf8'));
  const store = openCrossexStore(svc, { secret: { apiKey: KEY, apiSecret: SECRET }, limits: LIMITS });
  try { assert.equal(store.config().slippageBps, 11); } finally { store.close(); }

  // Already configured: kept, refused without a restart.
  submitImportRequest(dir, { action: 'import', crossex: true });
  await runImportHelper(options);
  assert.match(readImportResult(dir)!.message, /CrossEx 账户不能导入，配置未改动/);
  assert.equal(restarts.length, 1);
}));
