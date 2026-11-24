// MEV 套利在运维文件里的部分（src/service/mev-config.ts）、install.sh --set-mev 的助手（src/service/mev-setup.ts）
// 与 /api/mev 路由：配置与密钥的校验不泄露原文，热钱包必须专用，改动前按服务启动的规则完整校验。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FACTORIES, USDC, WETH, type FactoryInfo } from '../src/mev/chain.ts';
import { addressOf } from '../src/mev/codec.ts';
import { deploymentData } from '../src/mev/deploy-data.ts';
import { createFakeChain } from '../src/mev/fake-chain.ts';
import { loadServiceSecrets, parseServiceConfig } from '../src/service/config.ts';
import { assertDedicatedWallet, mevSummary, parseMevConfig, parseMevSecrets } from '../src/service/mev-config.ts';
import { parseSetupInput, planMev } from '../src/service/mev-setup.ts';

const KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const OPERATOR = addressOf(KEY), EXECUTOR = '0x00000000000000000000000000000000004d4556', OWNER = '0x000000000000000000000000000000000000b0b0';
const RPC = 'https://base.example.invalid/v2/rpc-key-secret', SEND = 'https://send.example.invalid/key-two';
const message = (run: () => unknown): string => { try { run(); } catch (error) { return error instanceof Error ? error.message : String(error); } return ''; };

test('config.json 的 mev：只接受 executor 与 owner 两个地址，统一成小写', () => {
  assert.deepEqual(parseMevConfig({ executor: EXECUTOR.toUpperCase().replace('0X', '0x'), owner: OWNER }), { executor: EXECUTOR, owner: OWNER });
  assert.throws(() => parseMevConfig({ executor: EXECUTOR }), /mev 无效/);
  assert.throws(() => parseMevConfig({ executor: EXECUTOR, owner: OWNER, rpcUrl: RPC }), /mev 无效/);
  assert.throws(() => parseMevConfig({ executor: '0x12', owner: OWNER }), /40 位十六进制地址/);
  assert.throws(() => parseMevConfig({ executor: EXECUTOR, owner: EXECUTOR }), /不能是同一个地址/);
  assert.throws(() => parseMevConfig([]), /mev 无效/);
});

test('密钥文件的 mev：节点地址须 https（内网可 http），私钥须 64 位十六进制；报错不带原文', () => {
  assert.equal(parseMevSecrets({}), undefined);
  assert.deepEqual(parseMevSecrets({ mev: { rpcUrl: RPC, privateKey: KEY } }), { rpcUrl: RPC, privateKey: KEY });
  assert.deepEqual(parseMevSecrets({ mev: { rpcUrl: 'http://127.0.0.1:8545', sendRpcUrl: SEND, privateKey: KEY } }), { rpcUrl: 'http://127.0.0.1:8545', sendRpcUrl: SEND, privateKey: KEY });
  for (const ok of ['http://localhost:8545', 'http://10.0.0.8:8545', 'http://192.168.1.2:8545', 'http://100.64.0.3:8545', 'http://100.127.255.1:8545']) assert.ok(parseMevSecrets({ mev: { rpcUrl: ok, privateKey: KEY } }));
  const bad: Record<string, unknown>[] = [
    { rpcUrl: 'http://base.example.invalid/rpc-key-secret', privateKey: KEY }, { rpcUrl: 'https://user:pass-secret@base.example.invalid', privateKey: KEY },
    { rpcUrl: 'wss://base.example.invalid/rpc-key-secret', privateKey: KEY }, { rpcUrl: 'not a url rpc-key-secret', privateKey: KEY }, { rpcUrl: RPC, sendRpcUrl: 'http://8.8.8.8/rpc-key-secret', privateKey: KEY }, { rpcUrl: 'http://100.63.0.1/rpc-key-secret', privateKey: KEY }, { rpcUrl: 'http://100.128.0.1/rpc-key-secret', privateKey: KEY }, { rpcUrl: 'http://172.16.0.1/rpc-key-secret', privateKey: KEY },
    { rpcUrl: RPC, privateKey: KEY.slice(0, -2) }, { rpcUrl: RPC, privateKey: KEY.slice(2) }, { rpcUrl: RPC, privateKey: '0x' + '0'.repeat(64) }, { rpcUrl: RPC, privateKey: 7 },
    { rpcUrl: RPC }, { rpcUrl: RPC, privateKey: KEY, extra: 1 },
  ];
  for (const mev of bad) {
    const text = message(() => parseMevSecrets({ mev }));
    assert.match(text, /^mev 的/, JSON.stringify(Object.keys(mev)));
    assert.ok(!/rpc-key-secret|pass-secret|4c0883a6|example\.invalid/.test(text), text);
  }
});

test('热钱包必须专用：不能是 owner、执行合约或任何 ASTER 账户的钱包', () => {
  const config = { executor: EXECUTOR, owner: OWNER }, secrets = { rpcUrl: RPC, privateKey: KEY };
  assertDedicatedWallet(config, secrets, ['0x00000000000000000000000000000000000000a1']);
  assert.throws(() => assertDedicatedWallet({ executor: EXECUTOR, owner: OPERATOR }, secrets, []), /不能是 owner 或执行合约/);
  assert.throws(() => assertDedicatedWallet({ executor: OPERATOR, owner: OWNER }, secrets, []), /不能是 owner 或执行合约/);
  assert.throws(() => assertDedicatedWallet(config, secrets, [OPERATOR.toUpperCase().replace('0X', '0x')]), /必须专用/);
  assert.equal(mevSummary(undefined, undefined), '');
  assert.equal(mevSummary(config, undefined), '');
  assert.equal(mevSummary(config, secrets), `，MEV 套利（Base，执行合约 0x0000…4556，热钱包 ${OPERATOR.slice(0, 6)}…${OPERATOR.slice(-4)}）`);
});

test('服务配置：有 mev 才开模块；配了 mev 而密钥文件没有时拒绝，报错不带密钥', () => {
  const base = { secretsFile: '/etc/tp/secrets.json' };
  assert.ok(!('mev' in parseServiceConfig({ ...base, pairs: [] })), '没有 mev 时配置与之前相同');
  const config = parseServiceConfig({ ...base, mev: { executor: EXECUTOR, owner: OWNER } });
  assert.deepEqual(config.mev, { executor: EXECUTOR, owner: OWNER });
  assert.throws(() => parseServiceConfig({ ...base, mev: {} }), /mev 无效/);
  const secrets = loadServiceSecrets(config, () => JSON.stringify({ accounts: {}, mev: { rpcUrl: RPC, privateKey: KEY } }));
  assert.deepEqual(secrets.mev, { rpcUrl: RPC, privateKey: KEY });
  assert.throws(() => loadServiceSecrets(config, () => JSON.stringify({ accounts: {} })), /密钥文件须有 mev/);
  const text = message(() => loadServiceSecrets(config, () => JSON.stringify({ accounts: {}, mev: { rpcUrl: RPC, privateKey: KEY + 'zz' } })));
  assert.match(text, /私钥格式无效/);
  assert.ok(!text.includes('4c0883a6') && !text.includes('rpc-key-secret'), text);
  // 没配 mev 的服务读到留在密钥文件里的 mev 不报「不支持的字段」。
  assert.deepEqual(loadServiceSecrets(parseServiceConfig({ ...base, pairs: [] }), () => JSON.stringify({ accounts: {}, mev: { rpcUrl: RPC, privateKey: KEY } })).mev, { rpcUrl: RPC, privateKey: KEY });
});

test('设置助手：第一次须给全，之后空项沿用已保存的值，结果不含私钥与节点地址原文', () => {
  const empty = { config: { secretsFile: '/etc/tp/secrets.json', port: 8443 }, secrets: { accounts: {} } };
  const set = (existing: typeof empty | { config: Record<string, unknown>; secrets: Record<string, unknown> }, change: Partial<{ executor: string; owner: string; rpcUrl: string | null; sendRpcUrl: string | null | 'none'; privateKey: string | null }>) =>
    planMev(existing, { executor: EXECUTOR, owner: OWNER, rpcUrl: null, sendRpcUrl: null, privateKey: null, ...change });
  assert.throws(() => set(empty, { privateKey: KEY }), /还没有保存过节点地址/);
  assert.throws(() => set(empty, { rpcUrl: RPC }), /还没有保存过热钱包私钥/);
  const first = set(empty, { rpcUrl: RPC, privateKey: KEY });
  assert.equal(first.changed, true);
  assert.deepEqual(first.config, { ...empty.config, mev: { executor: EXECUTOR, owner: OWNER } });
  assert.deepEqual(first.secrets, { accounts: {}, mev: { rpcUrl: RPC, privateKey: KEY } });
  assert.equal(first.summary, `MEV 套利：执行合约 ${EXECUTOR}，利润收款 ${OWNER}，热钱包 ${OPERATOR}，节点 base.example.invalid`);
  assert.deepEqual(empty.config, { secretsFile: '/etc/tp/secrets.json', port: 8443 }, '不改传入的对象');
  // 再执行一次相同内容：未改动。
  assert.equal(set(first, {}).changed, false);
  assert.equal(set(first, { rpcUrl: RPC, privateKey: KEY }).changed, false);
  // 只换 owner 并加发送节点：其余沿用。
  const other = '0x000000000000000000000000000000000000c0c0';
  const second = set(first, { owner: other, sendRpcUrl: SEND });
  assert.equal(second.changed, true);
  assert.deepEqual(second.secrets.mev, { rpcUrl: RPC, privateKey: KEY, sendRpcUrl: SEND });
  assert.match(second.summary, /利润收款 0x000000000000000000000000000000000000c0c0.*节点 base\.example\.invalid，发送走 send\.example\.invalid$/);
  assert.ok(!second.summary.includes('rpc-key-secret') && !second.summary.includes('key-two') && !second.summary.includes('4c0883a6'));
  // 「-」去掉发送节点。
  assert.deepEqual(set(second, { owner: other, sendRpcUrl: 'none' }).secrets.mev, { rpcUrl: RPC, privateKey: KEY });
  // 服务会拒绝的内容不会生成：热钱包与 owner 相同、与 ASTER 账户共用、节点地址不合规。
  assert.throws(() => set(first, { owner: OPERATOR }), /不能是 owner 或执行合约/);
  const bad = message(() => set(first, { rpcUrl: 'http://base.example.invalid/rpc-key-secret' }));
  assert.match(bad, /节点地址须为 https/);
  assert.ok(!bad.includes('rpc-key-secret'));
  assert.ok(!message(() => set(first, { privateKey: KEY + 'ab' })).includes('4c0883a6'));
  // 关闭：两个文件都去掉 mev；本来没有时未改动。
  const off = planMev(second, 'off');
  assert.deepEqual([off.changed, off.config, off.secrets], [true, empty.config, empty.secrets]);
  assert.equal(planMev(empty, 'off').changed, false);
});

test('设置助手的标准输入：三行，空行沿用，「-」去掉发送节点，私钥可不带 0x，多出的行拒绝', () => {
  assert.deepEqual(parseSetupInput(`${RPC}\n\n${KEY}\n`), { rpcUrl: RPC, sendRpcUrl: null, privateKey: KEY });
  assert.deepEqual(parseSetupInput(`  ${RPC} \r\n-\r\n${KEY.slice(2)}\r\n`), { rpcUrl: RPC, sendRpcUrl: 'none', privateKey: KEY });
  assert.deepEqual(parseSetupInput(''), { rpcUrl: null, sendRpcUrl: null, privateKey: null });
  assert.deepEqual(parseSetupInput(`\n${SEND}`), { rpcUrl: null, sendRpcUrl: SEND, privateKey: null });
  assert.throws(() => parseSetupInput(`${RPC}\n\n${KEY}\nextra\n`), /须为三行/);
});

test('部署数据：拒绝无效、相同或零地址，参数里带全部登记的工厂', () => {
  const data = deploymentData(OWNER, OPERATOR);
  assert.match(data, /^0x[0-9a-f]+$/);
  for (const factory of FACTORIES) assert.ok(data.includes(factory.address.slice(2)), factory.address);
  assert.ok(data.includes(OWNER.slice(2)) && data.includes(OPERATOR.slice(2)));
  assert.throws(() => deploymentData('0x12', OPERATOR), /40 位十六进制地址/);
  assert.throws(() => deploymentData(OPERATOR, OPERATOR), /不能是同一个地址/);
  assert.throws(() => deploymentData('0x' + '0'.repeat(40), OPERATOR), /不能是零地址/);
});

test('/api/mev：没配时是待启用状态，录入接口校验且不回显私钥；配了以后状态不带私钥与节点地址，写入要确认', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-mev-http-'));
  t.after(() => { process.removeAllListeners('SIGINT'); process.removeAllListeners('SIGTERM'); rmSync(dir, { recursive: true, force: true }); });
  const freePort = () => new Promise<number>(resolve => { const probe = createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address() as { port: number }; probe.close(() => resolve(port)); }); });
  const { startService } = await import('../src/service/main.ts');
  const app = { index: Buffer.from('<!doctype html><title>统一交易平台</title><script type="module" src="/assets/app-1.js"></script>'), assets: new Map([['app-1.js', { body: Buffer.from('void 0;'), type: 'text/javascript; charset=utf-8' }]]) };
  const outside: typeof fetch = async () => { throw new TypeError('fetch failed'); };
  const session = async (data: string, port: number) => {
    let link = '';
    for (let i = 0; i < 200 && !link; i++) { try { link = readFileSync(join(data, 'access-url'), 'utf8').trim().split('\n').at(-1)!; } catch { await new Promise(resolve => setTimeout(resolve, 20)); } }
    const cookie = (await fetch(link, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]!;
    const base = `http://127.0.0.1:${port}`;
    return {
      get: (route: string) => fetch(base + route, { headers: { cookie } }),
      raw: (route: string, init: { method: string; headers: Record<string, string>; body: string }) => fetch(base + route, { ...init, headers: { ...init.headers, cookie } }),
      post: (route: string, body: unknown) => fetch(base + route, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-pa-executor': '1' }, body: JSON.stringify(body) }),
    };
  };

  {
    const port = await freePort(), data = join(dir, 'plain');
    const run = await startService({ config: parseServiceConfig({ secretsFile: '/etc/tp/secrets.json', pairs: [] }), secrets: { accounts: new Map(), feishu: null }, dir: data, port, fetchImpl: outside, app });
    try {
      const { get, post } = await session(data, port);
      const idle = await get('/api/mev/state');
      assert.equal(idle.status, 200);
      assert.deepEqual(((await idle.json()) as { setup: { stage: string; managed: boolean } }).setup.stage, 'none');
      assert.equal(((await (await get('/api/shell')).json()) as { modules: { mev: boolean } }).modules.mev, true);
      // 还没启用时引擎的接口不可用；录入接口校验格式，应答不回显提交的私钥。
      assert.equal((await post('/api/mev/settings', { settings: {} })).status, 503);
      const bad = await post('/api/mev/setup', { privateKey: KEY + 'ab', owner: OWNER });
      const badText = await bad.text();
      assert.deepEqual([bad.status, (JSON.parse(badText) as { code: string }).code], [400, 'invalid_key']);
      assert.ok(!badText.includes('4c0883a6'), badText);
      assert.equal(((await (await post('/api/mev/setup', { privateKey: KEY, owner: OPERATOR })).json()) as { code: string }).code, 'same_wallet');
      assert.equal((await post('/api/mev/setup/deploy', { confirm: OPERATOR })).status, 409);
      // 录入成功的应答同样不带私钥；节点连不上只记在 rpcError 里。
      const saved = await post('/api/mev/setup', { privateKey: KEY, owner: OWNER });
      const savedText = await saved.text();
      assert.deepEqual([saved.status, (JSON.parse(savedText) as { setup: { stage: string; operator: string } }).setup.stage, (JSON.parse(savedText) as { setup: { operator: string } }).setup.operator], [200, 'wallet', OPERATOR]);
      assert.ok(!savedText.includes('4c0883a6'), savedText);
      assert.ok(!(await (await get('/api/mev/state')).text()).includes('4c0883a6'));
      const gone = await post('/api/mev/setup/reset', { confirm: OPERATOR });
      assert.deepEqual([gone.status, ((await gone.json()) as { setup: { stage: string } }).setup.stage], [200, 'none']);
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/mev/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
    } finally { await run.shutdown(); await run.done; }
  }

  const [uniswap] = FACTORIES as unknown as [FactoryInfo];
  const [token0, token1] = WETH < USDC ? [WETH, USDC] : [USDC, WETH];
  const chain = createFakeChain({
    executor: EXECUTOR, owner: OWNER, operator: OPERATOR, now: () => Date.now(), profit: () => null,
    tokens: [{ address: WETH, symbol: 'WETH', decimals: 18 }, { address: USDC, symbol: 'USDC', decimals: 6 }],
    pools: [{ address: '0x00000000000000000000000000000000feed0001', factory: uniswap, token0, token1, tier: 500n, fee: 500n, price: token0 === WETH ? 3400e-12 : 1e12 / 3400, depth: 1e15 }],
  });
  const port = await freePort(), data = join(dir, 'mev');
  const run = await startService({
    config: parseServiceConfig({ secretsFile: '/etc/tp/secrets.json', mev: { executor: EXECUTOR, owner: OWNER } }),
    secrets: { accounts: new Map(), feishu: null, mev: { rpcUrl: RPC, privateKey: KEY } }, dir: data, port, fetchImpl: outside, app, mevOptions: { fetchImpl: chain.fetchImpl, pollMs: 20 },
  });
  try {
    const { get, post, raw } = await session(data, port);
    assert.equal(((await (await get('/api/shell')).json()) as { modules: { mev: boolean } }).modules.mev, true);
    const answer = await get('/api/mev/state');
    assert.equal(answer.status, 200);
    const text = await answer.text(), state = JSON.parse(text) as { executor: string; owner: string; operator: string; mode: string; chainId: number; setup: { stage: string; managed: boolean } };
    assert.deepEqual([state.setup.stage, state.setup.managed], ['ready', true]);
    assert.equal(((await (await post('/api/mev/setup', { privateKey: KEY, owner: OWNER })).json()) as { code: string }).code, 'managed');
    assert.deepEqual([state.executor, state.owner, state.operator, state.mode, state.chainId], [EXECUTOR, OWNER, OPERATOR, 'observe', 8453]);
    assert.ok(!text.includes(KEY.slice(2)) && !text.includes('rpc-key-secret') && !text.includes('https://'), '状态里没有私钥与节点地址原文');
    assert.equal((JSON.parse(text) as { setup: { rpcHost: string } }).setup.rpcHost, 'base.example.invalid', '节点只给主机名');
    assert.equal((await get('/api/mev/unknown')).status, 404);
    const badSettings = await post('/api/mev/settings', { settings: { minNetUsd: -1 } });
    assert.equal(badSettings.status, 400);
    assert.equal(((await badSettings.json()) as { code: string }).code, 'invalid_settings');
    const unconfirmed = await post('/api/mev/live/start', {});
    assert.equal(unconfirmed.status, 400);
    assert.equal(((await unconfirmed.json()) as { code: string }).code, 'confirm_required');
    const wrong = await post('/api/mev/live/start', { confirm: OWNER });
    assert.equal(((await wrong.json()) as { code: string }).code, 'confirm_required');
    // 不带执行头的写入被拒绝，和其他模块一样。
    const bare = await fetch(`http://127.0.0.1:${port}/api/mev/live/stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(bare.status, 401);
    // 登录了但不带执行头的写入按 csrf 拒绝。
    const headless = await raw('/api/mev/live/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(headless.status, 403);
    assert.equal(((await headless.json()) as { code: string }).code, 'csrf');
    assert.equal((await post('/api/mev/live/stop', {})).status, 200);
    assert.equal(((await (await get('/api/mev/state')).json()) as { mode: string }).mode, 'observe');
  } finally { await run.shutdown(); await run.done; }
});
