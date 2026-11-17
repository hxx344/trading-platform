// The service side of the Ondo module (docs/ondo.md): config.json `ondo` and secrets.json `ondo`, the workbench import,
// the /api/ondo routes and the module's stop. Ondo is a fake client here and the workbench a temp directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createExecutorServer, type ServiceViews } from '../src/http.ts';
import { parseServiceConfig, parseServiceSecrets } from '../src/service/config.ts';
import { ondoSummary, parseOndoConfig, parseOndoSecrets } from '../src/service/ondo-config.ts';
import { createOndoModule } from '../src/service/ondo.ts';
import { LIVE_WARNING, SESSION_PROBLEM, ondoCandidate, planOndo, readWorkbenchOndo, type OndoSource } from '../src/service/import-ondo.ts';
import { planImport } from '../src/service/import-workbench.ts';
import { parseImportBody } from '../src/service/import-channel.ts';
import { ONDO_MM_DEFAULTS } from '../src/vendor/ondo/mm.mjs';
import type { OndoObservationEarnings } from '../src/ondo/reward-types.ts';
import type { OndoClient } from '../src/vendor/ondo/client.mjs';
import type { OndoStreamFactory, OndoStreamOptions } from '../src/vendor/ondo/stream.mjs';
import { bindAccounts, createHarness } from './harness.ts';

const SECRET = 'ondo-secret-fixture-value-0001';
const KEY = { keyId: 'ondo-key-fixture-4321', secret: SECRET };
const LIVE = { ...structuredClone(ONDO_MM_DEFAULTS), mode: 'live', markets: ['NVDA-USD.P', 'TSLA-USD.P'], orderUsd: '250', maxPositionUsd: '250' };
const encrypt = (key: Buffer, value: unknown): string => {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
};

test('配置：ondo 只收 initial，导入的设置总以观察模式启动；密钥字段恰好为 keyId、secret 且报错不带值', () => {
  assert.deepEqual(parseOndoConfig({}), {});
  assert.equal(parseOndoConfig({ initial: LIVE }).initial?.mode, 'observe');
  assert.throws(() => parseOndoConfig({ extra: 1 }), /ondo 无效/);
  assert.throws(() => parseOndoConfig({ initial: { ...LIVE, maxBps: '40' } }), /ondo.initial 无效/);
  assert.equal(parseOndoSecrets({}), undefined);
  assert.deepEqual(parseOndoSecrets({ ondo: KEY }), KEY);
  for (const bad of [{ keyId: KEY.keyId }, { ...KEY, extra: SECRET }, { keyId: 'short', secret: SECRET }, { keyId: KEY.keyId, secret: 'x y' }, 'text']) {
    assert.throws(() => parseOndoSecrets({ ondo: bad }), (error: Error) => !error.message.includes(SECRET) && !error.message.includes('extra'), JSON.stringify(bad));
  }
  assert.equal(ondoSummary(undefined, undefined), '');
  assert.equal(ondoSummary({}, KEY), '，Ondo 挂单奖励（API Key ***4321）');
  assert.equal(ondoSummary({}, undefined), '，Ondo 挂单奖励（未配置 API Key，只能观察）');
  // The key file takes `ondo` only beside config.json `ondo`.
  assert.equal(parseServiceConfig({ secretsFile: '/etc/tp/secrets.json', pairs: [], ondo: {} }).ondo !== undefined, true);
  assert.throws(() => parseServiceSecrets({ accounts: {}, ondo: KEY }, [], [], false, false, false));
  assert.deepEqual(parseServiceSecrets({ accounts: {}, ondo: KEY }, [], [], false, false, true).ondo, KEY);
});

test('导入：工作台的设置以观察模式带来；会话记录在时不带 API Key；解不开或格式不对时说明原因', () => {
  const key = randomBytes(32), config = JSON.stringify({ revision: 3, config: LIVE });
  const credentials = JSON.stringify({ hint: '4321', value: encrypt(key, KEY) });
  const ok = ondoCandidate({ config, credentials, session: false, key });
  assert.deepEqual(ok.credentials, KEY); assert.equal(ok.initial?.mode, 'observe'); assert.equal(ok.initial?.orderUsd, '250'); assert.equal(ok.problem, null);
  const live = ondoCandidate({ config, credentials, session: true, key });
  assert.equal(live.credentials, null); assert.equal(live.problem, SESSION_PROBLEM);
  assert.match(ondoCandidate({ config: null, credentials, session: false, key: randomBytes(32) }).problem!, /无法解密/);
  assert.match(ondoCandidate({ config: null, credentials: '{"value":1}', session: false, key }).problem!, /记录格式错误/);
  assert.match(ondoCandidate({ config: null, credentials: JSON.stringify({ value: encrypt(key, { keyId: 'x', secret: 'y' }) }), session: false, key }).problem!, /不完整或格式无效/);
  const odd = ondoCandidate({ config: '{"config":{"mode":"live"}}', credentials: null, session: false, key: null });
  assert.equal(odd.initial, null); assert.match(odd.settingsProblem!, /按默认值/); assert.equal(odd.problem, null);
  for (const source of [ok, live, odd]) assert.ok(!JSON.stringify({ ...source, credentials: null }).includes(SECRET));
});

test('导入：从数据目录读取，拒绝符号链接；没有 ondo-mm 时只启用观察', () => {
  const data = mkdtempSync(join(tmpdir(), 'tp-ondo-wb-')), key = randomBytes(32);
  assert.deepEqual(readWorkbenchOndo(data), { present: false, credentials: null, initial: null, problem: null, settingsProblem: null });
  assert.throws(() => readWorkbenchOndo('relative/dir'), /绝对路径/);
  mkdirSync(join(data, 'ondo-mm'));
  writeFileSync(join(data, 'credentials.key'), key, { mode: 0o600 });
  writeFileSync(join(data, 'ondo-mm', 'config.json'), JSON.stringify({ revision: 1, config: LIVE }));
  writeFileSync(join(data, 'ondo-mm', 'credentials.json'), JSON.stringify({ hint: '4321', value: encrypt(key, KEY) }));
  const read = readWorkbenchOndo(data);
  assert.deepEqual(read.credentials, KEY); assert.deepEqual(read.initial?.markets, ['NVDA-USD.P', 'TSLA-USD.P']);
  writeFileSync(join(data, 'ondo-mm', 'session.json'), '{}');
  assert.equal(readWorkbenchOndo(data).problem, SESSION_PROBLEM);
  const linked = mkdtempSync(join(tmpdir(), 'tp-ondo-wb-'));
  mkdirSync(join(linked, 'ondo-mm'));
  symlinkSync(join(data, 'ondo-mm', 'config.json'), join(linked, 'ondo-mm', 'config.json'));
  assert.throws(() => readWorkbenchOndo(linked), /不是普通文件/);
  // A key record without the key file cannot be decrypted, and is not looked for elsewhere.
  const keyless = mkdtempSync(join(tmpdir(), 'tp-ondo-wb-'));
  mkdirSync(join(keyless, 'ondo-mm'));
  writeFileSync(join(keyless, 'ondo-mm', 'credentials.json'), '{}');
  assert.throws(() => readWorkbenchOndo(keyless), /没有找到工作台的凭据密钥/);
  writeFileSync(join(keyless, 'credentials.key'), Buffer.alloc(16));
  assert.throws(() => readWorkbenchOndo(keyless), /不是 32 字节/);
});

test('导入计划：首次写入 config 与 secrets；已启用时只补缺少的 API Key；不覆盖现有密钥', () => {
  const source: OndoSource = { present: true, credentials: KEY, initial: { ...LIVE, mode: 'observe' } as OndoSource['initial'], problem: null, settingsProblem: null };
  const plan = planImport({ pairs: [], accounts: [], env: {} }, null, { secretsFile: '/x/secrets.json', only: [], ondo: source });
  assert.equal(plan.ondo?.status, 'added'); assert.equal(plan.ondo?.keyId, '***4321'); assert.equal(plan.ondo?.warning, LIVE_WARNING);
  assert.equal((plan.config.ondo as { initial: { mode: string } }).initial.mode, 'observe');
  assert.deepEqual(plan.secrets.ondo, KEY);
  assert.ok(!JSON.stringify(plan.ondo).includes(SECRET) && !plan.notes.join().includes(SECRET));
  // Enabled already without a key: the key is added, the settings kept.
  const existing = { config: { secretsFile: '/x/secrets.json', pairs: [], ondo: {} }, secrets: { accounts: {} } };
  const filled = planImport({ pairs: [], accounts: [], env: {} }, existing, { secretsFile: '/x/secrets.json', only: [], ondo: source });
  assert.equal(filled.ondo?.status, 'added'); assert.match(filled.ondo!.detail, /补入 API Key \*\*\*4321/); assert.deepEqual(filled.config.ondo, {});
  const kept = planImport({ pairs: [], accounts: [], env: {} }, { config: filled.config, secrets: filled.secrets }, { secretsFile: '/x/secrets.json', only: [], ondo: { ...source, credentials: { keyId: 'another-key-0000', secret: SECRET } } });
  assert.equal(kept.ondo?.status, 'skipped'); assert.deepEqual(kept.secrets.ondo, KEY);
  // A key without the module is the operator's to look at.
  const config: Record<string, unknown> = { pairs: [] }, secrets: Record<string, unknown> = { ondo: KEY };
  assert.match(planOndo(source, config, secrets, () => {}, []).detail, /不覆盖/); assert.equal(config.ondo, undefined);
  // Without a workbench key the module still comes on, for watching.
  const watchOnly = planImport({ pairs: [], accounts: [], env: {} }, null, { secretsFile: '/x/secrets.json', only: [], ondo: { present: false, credentials: null, initial: null, problem: null, settingsProblem: null } });
  assert.equal(watchOnly.ondo?.status, 'added'); assert.deepEqual(watchOnly.config.ondo, {}); assert.equal(watchOnly.secrets.ondo, undefined);
  assert.match(watchOnly.ondo!.detail, /工作台没有 Ondo 挂单模块的数据，只能观察/);
});

test('导入请求：ondo 只能是 true，可单独导入', () => {
  assert.deepEqual(parseImportBody({ action: 'import', ondo: true }), { action: 'import', pairs: [], ondo: true });
  assert.throws(() => parseImportBody({ action: 'import', ondo: false }), /ondo 只能是 true/);
  assert.throws(() => parseImportBody({ action: 'preview', ondo: true }), /预览不选配对/);
});

const TOKEN = 'ondo-access-token-0001', SESSION = 'ondo-session-value-0001';
async function withServer(views: ServiceViews | undefined, run: (call: (method: string, path: string, body?: unknown, extra?: { marker?: boolean }) => Promise<Response>) => Promise<void>) {
  const h = createHarness();
  bindAccounts(h.ex);
  const server = createExecutorServer({ executor: h.ex, accessToken: TOKEN, session: SESSION, ...(views ? { views } : {}) });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const login = await fetch(`${base}/login?token=${TOKEN}`, { redirect: 'manual' });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    await run((method, path, body, { marker = true } = {}) => fetch(base + path, {
      method, headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(marker ? { 'x-pa-executor': '1' } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
  } finally { await new Promise(resolve => server.close(resolve)); h.dispose(); }
}

const depthClient = (): OndoClient => ({
  async markets() { return new Map([['NVDA-USD.P', { tick: '0.01', step: '0.01', trading: true, makerFee: null }]]); },
  async depth(name: string) { return { market: name, bids: [['100.00', '3']], asks: [['100.02', '4']] }; },
  close() {},
} as unknown as OndoClient);

test('路由：没有 ondo 时 404，写操作校验标记、字段、专户确认和凭据', async () => {
  await withServer(undefined, async call => { assert.equal((await call('GET', '/api/ondo/state')).status, 404); });
  const dataDir = mkdtempSync(join(tmpdir(), 'tp-ondo-routes-'));
  const silent = (): void => {};
  const watching = await createOndoModule({ initial: { ...LIVE, mode: 'observe' } as never }, undefined, dataDir, { log: silent, rewardsClient: depthClient, mmIntervalMs: 0 });
  try {
    await withServer({ ondo: watching.views }, async call => {
      const state = await (await call('GET', '/api/ondo/state')).json() as { config: { orderUsd: string; mode: string }; credentials: { configured: boolean }; revision: number };
      assert.equal(state.config.orderUsd, '250'); assert.equal(state.config.mode, 'observe'); assert.equal(state.credentials.configured, false);
      assert.equal((await call('PUT', '/api/ondo/config', { config: LIVE }, { marker: false })).status, 403);
      const extra = await call('PUT', '/api/ondo/config', { config: LIVE, extra: 1 });
      assert.equal(extra.status, 400); assert.equal(((await extra.json()) as { message: string }).message, '请求包含未知字段');
      assert.equal((await call('PUT', '/api/ondo/config', { config: { ...LIVE, maxBps: '40' } })).status, 400);
      const saved = await (await call('PUT', '/api/ondo/config', { config: LIVE })).json() as { revision: number };
      const oldConfirmation = await call('POST', '/api/ondo/start', { revision: saved.revision, confirmLive: true });
      assert.equal(oldConfirmation.status, 400);
      assert.match(((await oldConfirmation.json()) as { message: string }).message, /专用账户/);
      const refused = await call('POST', '/api/ondo/start', { revision: saved.revision, confirmLive: true, confirmAccountWide: true });
      assert.equal(refused.status, 409); assert.match(((await refused.json()) as { message: string }).message, /没有配置 Ondo API Key/);
      assert.equal((await call('POST', '/api/ondo/start', { revision: saved.revision, confirmLive: true, confirmAccountWide: true, force: true })).status, 400);
      assert.equal((await call('POST', '/api/ondo/stop', { extra: 1 })).status, 400);
      assert.equal(((await (await call('POST', '/api/ondo/stop', {})).json()) as { phase: string }).phase, 'stopped');
      // An empty JSON body (readJson gives null) is the same as {}; a body with fields is not.
      assert.equal(((await watching.views.stop(null)) as { phase: string }).phase, 'stopped');
      assert.throws(() => watching.views.discardRecovery({ x: 1 }), /请求包含未知字段/);
      const rewards = await (await call('GET', '/api/ondo/rewards?window=15')).json() as { windowMin: number; markets: unknown[] };
      assert.equal(rewards.windowMin, 15); assert.equal(rewards.markets.length, 20);
      assert.equal((await call('PUT', '/api/ondo/rewards/config', { markets: [] })).status, 400);
      assert.equal((await call('GET', '/api/ondo/rewards/book?market=bad')).status, 400);
      const book = await (await call('GET', '/api/ondo/rewards/book?market=NVDA-USD.P')).json() as { levels: { bid: { usd: number }[] } };
      assert.equal(book.levels.bid[0]!.usd, 300);
      assert.equal((await call('GET', '/api/ondo/missing')).status, 404);
    });
  } finally { await watching.close(); }
});

test('路由：并行观察保持原交易市场和奖池假设，停止时冻结虚挂与收益快照', async () => {
  const first = 'NVDA-USD.P', second = 'TSLA-USD.P', closed = 'HALT-USD.P', missing = 'OLD-USD.P';
  const rule = { tick: '0.01', step: '0.01', trading: true, makerFee: '0.0002' };
  const client = (): OndoClient => ({ ...depthClient(), cooldownUntil: () => 0, async markets() {
    return new Map([[first, rule], [second, rule], [closed, { ...rule, trading: false }]]);
  } });
  const streams: string[][] = [];
  const stream: OndoStreamFactory = input => ({
    start() { streams.push(input.markets); assert.equal(input.credentials, null); assert.equal(typeof input.onTrade, 'function');
      for (const name of input.markets) { const at = Date.now(); input.onBook(name, { time: at, bids: [[99n * 10n ** 18n, 10n ** 18n]], asks: [[101n * 10n ** 18n, 10n ** 18n]] }, at); }
    }, close() {}, status: () => ({ publicReady: true, connected: true, privateReady: false, lastFrameAt: Date.now(), error: null }),
  });
  const service = await createOndoModule({}, undefined, mkdtempSync(join(tmpdir(), 'tp-ondo-observe-')), { log: () => {}, rewardsClient: client,
    observeFeed: { client, stream }, mmIntervalMs: 0 });
  type Reply = { sessionId: string; revision: number; config: { markets: string[] }; activeConfig: { markets: string[] }; observation: { endedAt: number | null; earnings: OndoObservationEarnings } };
  try {
    await withServer({ ondo: service.views }, async call => {
      const names = [second, first, closed, missing];
      const run = await call('POST', '/api/ondo/start', { revision: 0, observeMarkets: names });
      assert.equal(run.status, 200);
      const started = await run.json() as Reply;
      assert.deepEqual(started.config.markets, [first]); assert.deepEqual(started.activeConfig.markets, names); assert.deepEqual(streams, [[second, first]]);
      const earnings = started.observation.earnings;
      assert.deepEqual([earnings.orderUsd, earnings.referenceCapitalUsd, earnings.poolUsd], [100, 200, 125000]);
      assert.deepEqual(earnings.markets.map(row => row.market), names); assert.equal(earnings.markets[0].makerFee, 0.0002);
      assert.match(earnings.markets[0].tiers[0].reason!, /完整的奖励分钟样本/); assert.match(earnings.markets[2].tiers[0].reason!, /休市/);
      assert.match(earnings.markets[3].tiers[0].reason!, /未上市/);
      assert.ok(earnings.markets.every(m => m.tiers.length === 3 && m.tiers.every(t => t.rewardDay === null && t.netDay === null)));
      const rewardConfig = { markets: [first], poolUsd: '700', eligible: 3 };
      assert.equal((await call('PUT', '/api/ondo/rewards/config', rewardConfig)).status, 200);
      const end = await (await call('POST', '/api/ondo/stop', { sessionId: started.sessionId, live: false })).json() as Reply;
      assert.equal(end.observation.earnings.poolUsd, 125000); assert.equal(end.observation.earnings.eligible, 20);
      assert.equal(end.observation.earnings.asOf, end.observation.endedAt);
      const saved = await (await call('PUT', '/api/ondo/config', { config: { ...LIVE, markets: [first] } })).json() as Reply;
      assert.deepEqual(saved.observation, end.observation);
      const refused = await call('POST', '/api/ondo/start', { revision: saved.revision, confirmLive: true, confirmAccountWide: true, observeMarkets: [second] });
      assert.equal(refused.status, 400); assert.match(((await refused.json()) as { message: string }).message, /不能指定观察市场/);
    });
  } finally { await service.close(); }
});

test('模块：完整的公开样本与连续有效报价产出三档净收益，停止后数值不随采样、配置或时钟改变', async t => {
  const market = 'NVDA-USD.P', epoch = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ['Date'], now: epoch });
  const open = new Set<OndoStreamOptions>();
  const feed: OndoStreamFactory = input => ({ start() { open.add(input); }, close() { open.delete(input); },
    status: () => ({ connected: true, publicReady: true, privateReady: false, lastFrameAt: Date.now(), error: null }) });
  const client = (): OndoClient => ({ ...depthClient(), cooldownUntil: () => 0,
    async markets() { return new Map([[market, { tick: '0.0001', step: '0.01', trading: true, makerFee: '0.0002' }]]); } });
  const service = await createOndoModule({}, undefined, mkdtempSync(join(tmpdir(), 'tp-ondo-income-')), { log: () => {},
    rewardsClient: client, rewardsStream: feed, observeFeed: { client, stream: feed }, mmIntervalMs: 0 });
  service.views.saveRewards({ markets: [market], poolUsd: '700', eligible: 1 });
  const pending = new Map<() => void, number>();
  let stopped = false;
  const loop = service.loop({ stopped: () => stopped, pause: ms => new Promise(resolve => { pending.set(resolve, Date.now() + ms); }) });
  const advance = async (seconds: number) => {
    for (let i = 0; i < seconds; i++) {
      await new Promise<void>(resolve => setImmediate(resolve));
      t.mock.timers.tick(1000);
      const at = Date.now(), mid = 1_000_000n + BigInt(Math.round(5 * Math.sin((at - epoch) / 5000)));
      const levels = (sign: bigint): [bigint, bigint][] => [50n, 310n, 620n, 1200n, 2800n].map(offset => [(mid + sign * offset) * 10n ** 14n, 100n * 10n ** 18n]);
      for (const stream of open) stream.onBook(market, { time: at, bids: levels(-1n), asks: levels(1n) }, at);
      for (const [wake, due] of pending) if (at >= due) { pending.delete(wake); wake(); }
    }
  };
  type Reply = { sessionId: string; observation: { endedAt: number | null; earnings: OndoObservationEarnings } };
  try {
    await advance(11 * 60);
    const run = await service.views.start({ revision: 0, observeMarkets: [market] }) as Reply;
    await advance(65);
    const active = service.views.state() as Reply;
    const result = active.observation.earnings.markets[0];
    assert.ok(result.samples >= 11 && result.returns >= 20);
    for (const tier of result.tiers) { assert.ok(tier.buyUptime > 0.95 && tier.sellUptime > 0.95); assert.ok(tier.netDay! > 0); assert.equal(tier.reason, null); }
    const end = await service.views.stop({ sessionId: run.sessionId, live: false }) as Reply;
    assert.deepEqual(end.observation.earnings, active.observation.earnings);
    await advance(125);
    service.views.saveRewards({ markets: [market], poolUsd: '7', eligible: 20 });
    service.views.save({ config: { ...ONDO_MM_DEFAULTS, orderUsd: '50' } });
    assert.deepEqual((service.views.state() as Reply).observation, end.observation);
  } finally {
    stopped = true;
    for (const wake of pending.keys()) wake();
    await loop;
  }
});

test('专用账户的本机进程锁防止重复启动，状态和错误不返回密钥', async () => {
  const silent = (): void => {};
  const keyed = await createOndoModule({}, KEY, mkdtempSync(join(tmpdir(), 'tp-ondo-routes-')), { log: silent, rewardsClient: depthClient, mmIntervalMs: 0 });
  try {
    await withServer({ ondo: keyed.views }, async call => {
      const text = await (await call('GET', '/api/ondo/state')).text();
      assert.ok(!text.includes(SECRET) && !text.includes(KEY.keyId));
      assert.equal((JSON.parse(text) as { credentials: { hint: string } }).credentials.hint, '4321');
    });
    // Anything not the module's own refusal is answered with a fixed text.
    assert.deepEqual(keyed.views.failure(new TypeError('secret detail')), { status: 500, body: { code: 'internal', message: 'Ondo 模块内部错误' }, internal: true });
    assert.equal(keyed.views.failure(Object.assign(new Error('奖励设置无法保存'), { status: 503 })).status, 503);
    // One process per key on this host: a second one is refused before it reads or withdraws anything.
    await assert.rejects(createOndoModule({}, KEY, mkdtempSync(join(tmpdir(), 'tp-ondo-routes-')), { log: silent, rewardsClient: depthClient, mmIntervalMs: 0 }),
      (error: Error) => /\*\*\*4321 已被本机另一个服务进程使用/.test(error.message) && !error.message.includes(KEY.keyId));
  } finally { await keyed.close(); }
  // Released on close.
  const again = await createOndoModule({}, KEY, mkdtempSync(join(tmpdir(), 'tp-ondo-routes-')), { log: silent, rewardsClient: depthClient, mmIntervalMs: 0 });
  await again.close();
  // And when the module fails to start after taking it (here the data directory is a file).
  const notDir = join(mkdtempSync(join(tmpdir(), 'tp-ondo-routes-')), 'file');
  writeFileSync(notDir, '');
  await assert.rejects(createOndoModule({}, KEY, notDir, { log: silent, rewardsClient: depthClient, mmIntervalMs: 0 }), (error: Error) => !/已被本机另一个服务进程使用/.test(error.message));
  const after = await createOndoModule({}, KEY, mkdtempSync(join(tmpdir(), 'tp-ondo-routes-')), { log: silent, rewardsClient: depthClient, mmIntervalMs: 0 });
  await after.close();
});

test('模块：服务停止时立即关闭推送、中止进行中的盘口读取并关闭挂单，不等读取超时', async () => {
  const lines: string[] = [];
  let closed = 0, reads = 0;
  const aborts: (() => void)[] = [];
  const hanging = (): OndoClient => ({
    async markets() { return new Map(); },
    depth() { reads += 1; return new Promise((_, reject) => { aborts.push(() => reject(new Error('closed'))); }); },
    close() { closed += 1; for (const abort of aborts.splice(0)) abort(); },
  } as unknown as OndoClient);
  const feed = { started: 0, closed: 0 };
  const rewardsStream: OndoStreamFactory = () => ({ start() { feed.started += 1; }, close() { feed.closed += 1; },
    status: () => ({ connected: true, publicReady: true, privateReady: false, lastFrameAt: null, error: null }) });
  const module = await createOndoModule({}, undefined, mkdtempSync(join(tmpdir(), 'tp-ondo-loop-')), { log: line => lines.push(line), rewardsClient: hanging, rewardsStream, mmIntervalMs: 0 });
  let stopped = false;
  const wakers = new Set<() => void>();
  const pause = (ms: number) => new Promise<void>(resolve => {
    if (stopped) { resolve(); return; }
    const wake = () => { clearTimeout(timer); wakers.delete(wake); resolve(); };
    const timer = setTimeout(wake, ms);
    wakers.add(wake);
  });
  const loop = module.loop({ stopped: () => stopped, pause });
  // Stopped mid-burst with the page's REST read hanging.
  const page = module.views.book('NVDA-USD.P').catch(() => null);
  while (reads === 0 || feed.started === 0) await new Promise(resolve => setTimeout(resolve, 5));
  const at = Date.now();
  stopped = true;
  for (const wake of [...wakers]) wake();
  await Promise.all([loop, page]);
  assert.ok(Date.now() - at < 1000, `${Date.now() - at} ms`);
  assert.ok(closed >= 1); assert.ok(feed.closed >= 1);
  // A second close is the same one.
  await module.close();
  assert.deepEqual(lines.filter(line => line.includes('出错') || line.includes('异常')), []);
});
