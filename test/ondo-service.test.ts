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
import type { OndoClient } from '../src/vendor/ondo/client.mjs';
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

test('路由：没有 ondo 时 404；设置须带请求标记；未知字段 400；没有 API Key 不能实盘；不返回 Secret', async () => {
  await withServer(undefined, async call => { assert.equal((await call('GET', '/api/ondo/state')).status, 404); });
  const dataDir = mkdtempSync(join(tmpdir(), 'tp-ondo-routes-'));
  const silent = (): void => {};
  const watching = createOndoModule({ initial: { ...LIVE, mode: 'observe' } as never }, undefined, dataDir, { log: silent, rewardsClient: depthClient, mmIntervalMs: 0 });
  try {
    await withServer({ ondo: watching.views }, async call => {
      const state = await (await call('GET', '/api/ondo/state')).json() as { config: { orderUsd: string; mode: string }; credentials: { configured: boolean }; revision: number };
      assert.equal(state.config.orderUsd, '250'); assert.equal(state.config.mode, 'observe'); assert.equal(state.credentials.configured, false);
      assert.equal((await call('PUT', '/api/ondo/config', { config: LIVE }, { marker: false })).status, 403);
      const extra = await call('PUT', '/api/ondo/config', { config: LIVE, extra: 1 });
      assert.equal(extra.status, 400); assert.equal(((await extra.json()) as { message: string }).message, '请求包含未知字段');
      assert.equal((await call('PUT', '/api/ondo/config', { config: { ...LIVE, maxBps: '40' } })).status, 400);
      const saved = await (await call('PUT', '/api/ondo/config', { config: LIVE })).json() as { revision: number };
      const refused = await call('POST', '/api/ondo/start', { revision: saved.revision, confirmLive: true });
      assert.equal(refused.status, 409); assert.match(((await refused.json()) as { message: string }).message, /没有配置 Ondo API Key/);
      assert.equal((await call('POST', '/api/ondo/start', { revision: saved.revision, confirmLive: true, force: true })).status, 400);
      assert.equal((await call('POST', '/api/ondo/stop', { extra: 1 })).status, 400);
      assert.equal(((await (await call('POST', '/api/ondo/stop', {})).json()) as { phase: string }).phase, 'stopped');
      const rewards = await (await call('GET', '/api/ondo/rewards?window=15')).json() as { windowMin: number; markets: unknown[] };
      assert.equal(rewards.windowMin, 15); assert.equal(rewards.markets.length, 20);
      assert.equal((await call('PUT', '/api/ondo/rewards/config', { markets: [] })).status, 400);
      assert.equal((await call('GET', '/api/ondo/rewards/book?market=bad')).status, 400);
      const book = await (await call('GET', '/api/ondo/rewards/book?market=NVDA-USD.P')).json() as { levels: { bid: { usd: number }[] } };
      assert.equal(book.levels.bid[0]!.usd, 300);
      assert.equal((await call('GET', '/api/ondo/missing')).status, 404);
    });
  } finally { await watching.close(); }
  const keyed = createOndoModule({}, KEY, mkdtempSync(join(tmpdir(), 'tp-ondo-routes-')), { log: silent, rewardsClient: depthClient, mmIntervalMs: 0 });
  try {
    await withServer({ ondo: keyed.views }, async call => {
      const text = await (await call('GET', '/api/ondo/state')).text();
      assert.ok(!text.includes(SECRET) && !text.includes(KEY.keyId));
      assert.equal((JSON.parse(text) as { credentials: { hint: string } }).credentials.hint, '4321');
    });
    // Anything not the module's own refusal is answered with a fixed text.
    assert.deepEqual(keyed.views.failure(new TypeError('secret detail')), { status: 500, body: { code: 'internal', message: 'Ondo 模块内部错误' }, internal: true });
    assert.equal(keyed.views.failure(Object.assign(new Error('奖励设置无法保存'), { status: 503 })).status, 503);
  } finally { await keyed.close(); }
});

test('模块：服务停止时采集结束并关闭挂单', async () => {
  const lines: string[] = [];
  const module = createOndoModule({}, undefined, mkdtempSync(join(tmpdir(), 'tp-ondo-loop-')), { log: line => lines.push(line), rewardsClient: depthClient, mmIntervalMs: 0 });
  let stopped = false, pauses = 0;
  await module.loop({ stopped: () => stopped, pause: async () => { pauses += 1; if (pauses >= 3) stopped = true; } });
  assert.equal(pauses, 3);
  assert.equal(module.views.state() !== null, true);
  // A second close is the same one.
  await module.close();
  assert.deepEqual(lines.filter(line => line.includes('出错')), []);
});
