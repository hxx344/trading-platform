// MEV 套利的页面启用（src/mev/setup.ts、src/service/mev.ts，docs/mev.md 第 6 节）：录入热钱包、由热钱包部署执行合约、
// 部署结果的核对、更换节点与移除；私钥与节点地址原文不出现在状态、日志、通知与报错里。节点是替身，不联网。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transaction } from 'ethers';
import { USDC, WETH } from '../src/mev/chain.ts';
import { addressOf } from '../src/mev/codec.ts';
import { deploymentData } from '../src/mev/deploy-data.ts';
import { MevError } from '../src/mev/engine.ts';
import { createFakeChain } from '../src/mev/fake-chain.ts';
import { contractAddress, KNOWN_FILE, parseRpcUrl, parseSetup, readKnown, readWallet, REDEPLOY_AFTER_MS, WALLET_FILE, writeWallet } from '../src/mev/setup.ts';
import type { MevSetupView } from '../src/mev/views.ts';
import { openMev, type MevSource } from '../src/service/mev.ts';

const KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const OPERATOR = addressOf(KEY), OWNER = '0x000000000000000000000000000000000000b0b0';
const SECRET_RPC = 'https://base.example.invalid/v2/rpc-key-secret';
const LEAK = /4c0883a6|rpc-key-secret/i;
type State = { setup: MevSetupView; mode?: string; executor?: string };

const code = async (run: () => unknown): Promise<string> => {
  try { await run(); } catch (error) { assert.ok(error instanceof MevError, String(error)); assert.ok(!LEAK.test(error.message), error.message); return error.code; }
  return '';
};

function setup(t: { after(fn: () => void): void }, source: MevSource = {}, chainNonce = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'tp-mev-setup-'));
  let clock = 1_800_000_000_000;
  const chain = createFakeChain({
    executor: contractAddress(OPERATOR, chainNonce), owner: OWNER, operator: OPERATOR, now: () => clock, profit: () => null,
    tokens: [{ address: WETH, symbol: 'WETH', decimals: 18 }, { address: USDC, symbol: 'USDC', decimals: 6 }], pools: [],
  });
  chain.state.deployed = false; chain.state.nonce = chainNonce;
  const lines: string[] = [];
  let stopped = false, running: Promise<void> | null = null;
  const open = () => openMev(source, dir, { fetchImpl: chain.fetchImpl, now: () => clock, pollMs: 5 }, { log: line => lines.push(line), notify: (_key, text) => lines.push(text) });
  let mev = open();
  const start = () => { stopped = false; running = mev.loop({ stopped: () => stopped, pause: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 5))) }); };
  const stop = async () => { stopped = true; mev.shutdown(); await running; running = null; };
  t.after(() => { stopped = true; mev.shutdown(); rmSync(dir, { recursive: true, force: true }); });
  const state = () => mev.views.state() as State;
  const until = async (done: (view: State) => boolean, what: string) => {
    for (let i = 0; i < 2_000; i++) { if (done(state())) return state(); await new Promise(resolve => setTimeout(resolve, 5)); }
    throw new Error(`等不到：${what}（${JSON.stringify(state().setup)}）`);
  };
  return { dir, chain, lines, state, until, start, stop, views: () => mev.views, reopen: () => { mev = open(); }, tick: (ms: number) => { clock += ms; }, file: () => join(dir, WALLET_FILE) };
}

test('合约地址：CREATE 地址与 ethers 的算法一致', async () => {
  const { getCreateAddress } = await import('ethers');
  for (const nonce of [0, 1, 127, 128, 255, 256, 70_000]) assert.equal(contractAddress(OPERATOR, nonce), getCreateAddress({ from: OPERATOR, nonce }).toLowerCase(), String(nonce));
});

test('启用表单：私钥可不带 0x；收款地址不能是热钱包自己或零地址；热钱包须专用；节点地址须合规；报错不带原文', async () => {
  assert.deepEqual(parseSetup({ privateKey: ` ${KEY.slice(2)} `, owner: OWNER.toUpperCase().replace('0X', '0x') }, []), { privateKey: KEY, owner: OWNER });
  assert.deepEqual(parseSetup({ privateKey: KEY, owner: OWNER, rpcUrl: ` ${SECRET_RPC} ` }, []), { privateKey: KEY, owner: OWNER, rpcUrl: SECRET_RPC });
  assert.deepEqual(parseSetup({ privateKey: KEY, owner: OWNER, rpcUrl: '  ' }, []), { privateKey: KEY, owner: OWNER });
  assert.equal(await code(() => parseSetup({ privateKey: KEY + 'ab', owner: OWNER }, [])), 'invalid_key');
  assert.equal(await code(() => parseSetup({ privateKey: '0x' + '0'.repeat(64), owner: OWNER }, [])), 'invalid_key');
  assert.equal(await code(() => parseSetup({ owner: OWNER }, [])), 'invalid_key');
  assert.equal(await code(() => parseSetup(null, [])), 'invalid_key');
  assert.equal(await code(() => parseSetup({ privateKey: KEY, owner: '0x12' }, [])), 'invalid_owner');
  assert.equal(await code(() => parseSetup({ privateKey: KEY, owner: '0x' + '0'.repeat(40) }, [])), 'invalid_owner');
  assert.equal(await code(() => parseSetup({ privateKey: KEY, owner: OPERATOR }, [])), 'same_wallet');
  assert.equal(await code(() => parseSetup({ privateKey: KEY, owner: OWNER }, [OPERATOR.toUpperCase().replace('0X', '0x')])), 'shared_wallet');
  for (const bad of ['http://base.example.invalid/rpc-key-secret', 'https://user:rpc-key-secret@base.example.invalid', 'wss://x.invalid/rpc-key-secret', 7])
    assert.equal(await code(() => parseSetup({ privateKey: KEY, owner: OWNER, rpcUrl: bad }, [])), 'invalid_rpc');
  assert.equal(parseRpcUrl(null), undefined);
  assert.equal(parseRpcUrl('http://127.0.0.1:8545'), 'http://127.0.0.1:8545');
});

test('钱包文件：600、原子替换不留临时文件；内容无效时报错不带内容', t => {
  const { dir, file } = setup(t);
  assert.equal(readWallet(dir), null);
  writeWallet(dir, { privateKey: KEY, owner: OWNER });
  writeWallet(dir, { privateKey: KEY, owner: OWNER, rpcUrl: SECRET_RPC });
  assert.deepEqual(readWallet(dir), { privateKey: KEY, owner: OWNER, rpcUrl: SECRET_RPC });
  assert.deepEqual(readdirSync(dir), [WALLET_FILE]);
  if (process.platform !== 'win32') assert.equal(statSync(file()).mode & 0o777, 0o600);
  for (const bad of ['{', JSON.stringify({ privateKey: KEY }), JSON.stringify({ privateKey: KEY.slice(0, 20), owner: OWNER }), JSON.stringify({ privateKey: KEY, owner: OWNER, rpcUrl: 'http://8.8.8.8/rpc-key-secret' })]) {
    writeFileSync(file(), bad);
    assert.throws(() => readWallet(dir), (error: Error) => /mev-wallet\.json/.test(error.message) && !LEAK.test(error.message));
  }
});

test('页面启用全程：录入 → 部署 → 上链核对后引擎以观察模式启动；状态、日志与通知里没有私钥', async t => {
  const { chain, lines, state, until, start, views, file, dir } = setup(t);
  assert.deepEqual([state().setup.stage, state().setup.managed, state().setup.operator], ['none', false, null]);
  assert.equal(await code(() => views().settings({})), 'unavailable');
  assert.equal(await code(() => views().deploy({ confirm: OPERATOR })), 'not_setup');
  start();
  const saved = await views().setup({ privateKey: KEY, owner: OWNER }) as State;
  assert.deepEqual([saved.setup.stage, saved.setup.operator, saved.setup.owner, saved.setup.rpcHost, saved.setup.defaultRpc], ['wallet', OPERATOR, OWNER, 'mainnet.base.org', true]);
  assert.deepEqual(saved.setup.wallet && [saved.setup.wallet.eth, saved.setup.wallet.nonce], [0.01, 0], '保存时就读到余额');
  assert.deepEqual(readWallet(dir), { privateKey: KEY, owner: OWNER });
  assert.equal(await code(() => views().setup({ privateKey: KEY, owner: OWNER })), 'exists');
  assert.equal(await code(() => views().deploy({})), 'confirm_required');
  assert.equal(await code(() => views().deploy({ confirm: OWNER })), 'confirm_required');
  assert.equal(chain.state.sent.length, 0);

  const sent = await views().deploy({ confirm: OPERATOR }) as State;
  assert.equal(sent.setup.stage, 'deploying');
  assert.equal(chain.state.sent.length, 1);
  // 发出的是一笔由热钱包签名、to 为空、data 为部署数据的交易。
  const tx = Transaction.from(chain.state.sent[0]!.raw);
  assert.deepEqual([tx.from?.toLowerCase(), tx.to, tx.nonce, tx.value, tx.data, tx.chainId], [OPERATOR, null, 0, 0n, deploymentData(OWNER, OPERATOR), 8453n]);
  assert.equal(tx.gasLimit, 2_400_000n);
  assert.deepEqual([sent.setup.deploy?.hash, sent.setup.deploy?.address, sent.setup.deploy?.nonce], [chain.state.sent[0]!.hash, contractAddress(OPERATOR, 0), 0]);
  assert.equal(readWallet(dir)?.deploy?.hash, chain.state.sent[0]!.hash, '部署记录已落盘');
  assert.equal(await code(() => views().deploy({ confirm: OPERATOR })), 'pending');

  chain.state.deployed = true; chain.mine(chain.state.sent[0]!.hash, 'success'); chain.advance();
  const ready = await until(view => view.mode === 'observe', '引擎启动');
  assert.deepEqual([ready.setup.stage, ready.executor, ready.setup.deploy], ['ready', contractAddress(OPERATOR, 0), null]);
  assert.deepEqual(readWallet(dir), { privateKey: KEY, owner: OWNER, executor: contractAddress(OPERATOR, 0) });
  assert.equal(await code(() => views().deploy({ confirm: OPERATOR })), 'deployed');
  assert.ok(lines.some(line => line.includes('页面录入了热钱包')) && lines.some(line => line.includes('已部署并核对')));
  assert.ok(!LEAK.test(lines.join('\n')) && !LEAK.test(JSON.stringify(state())), '日志、通知与状态里没有私钥');
  assert.ok(existsSync(file()));
});

test('更换节点与移除：实盘外才行；节点地址原文不出现；移除删掉私钥，重新录入沿用已部署的合约', async t => {
  const { chain, lines, state, until, start, views, file, dir } = setup(t, {}, 3);
  chain.state.deployed = true; chain.state.nonce = 4; // 这个钱包在 nonce 3 上部署过
  start();
  await views().setup({ privateKey: KEY, owner: OWNER, rpcUrl: SECRET_RPC });
  const adopted = await until(view => view.mode === 'observe', '沿用已部署的合约');
  assert.deepEqual([adopted.executor, adopted.setup.rpcHost, adopted.setup.defaultRpc], [contractAddress(OPERATOR, 3), 'base.example.invalid', false]);
  assert.equal(chain.state.sent.length, 0, '没有再部署一次');

  assert.equal(await code(() => views().rpc({ rpcUrl: 'http://8.8.8.8/rpc-key-secret' })), 'invalid_rpc');
  const changed = views().rpc({ rpcUrl: null }) as State;
  assert.deepEqual([changed.setup.rpcHost, changed.setup.defaultRpc], ['mainnet.base.org', true]);
  await until(view => view.mode === 'observe', '换节点后引擎重新启动');

  assert.equal(await code(() => views().reset({})), 'confirm_required');
  // 实盘中不能换节点、不能移除。
  chain.advance();
  await until(view => (view as { head?: unknown }).head != null && (view as { verification?: { ok: boolean } }).verification?.ok === true, '合约核对通过');
  const view = state() as State & { fault: string | null; haltReason: string | null };
  await views().start({ confirm: OPERATOR, fault: view.fault, haltReason: view.haltReason });
  assert.equal(await code(() => views().reset({ confirm: OPERATOR })), 'live');
  assert.equal(await code(() => views().rpc({ rpcUrl: null })), 'live');
  views().stop();

  const gone = views().reset({ confirm: OPERATOR }) as State;
  assert.deepEqual([gone.setup.stage, gone.setup.operator, gone.mode], ['none', null, undefined]);
  assert.ok(!existsSync(file()), '钱包文件已删除');
  assert.ok(lines.some(line => line.includes('移除了热钱包')));
  // 移除时留下合约地址（不含私钥）：之后这个钱包又发过很多交易、超出扫描范围，重新录入仍然沿用。
  assert.deepEqual(readKnown(dir), { operator: OPERATOR, owner: OWNER, executor: contractAddress(OPERATOR, 3) });
  assert.ok(!LEAK.test(readFileSync(join(dir, KNOWN_FILE), 'utf8')));
  chain.state.nonce = 40;
  await views().setup({ privateKey: KEY, owner: OWNER });
  const again = await until(view => view.mode === 'observe', '按留下的地址沿用');
  assert.equal(again.executor, contractAddress(OPERATOR, 3));
  assert.equal(chain.state.sent.length, 0);
  assert.ok(!LEAK.test(lines.join('\n')) && !LEAK.test(JSON.stringify(state())));
});

test('部署在途时可以换节点、可以移除：记录不丢；移除后重新录入，原来那笔上链后沿用，不再部署', async t => {
  const { chain, state, until, start, views, dir, file } = setup(t);
  start();
  await views().setup({ privateKey: KEY, owner: OWNER });
  await views().deploy({ confirm: OPERATOR });
  const hash = chain.state.sent[0]!.hash;
  const changed = views().rpc({ rpcUrl: SECRET_RPC }) as State;
  assert.deepEqual([changed.setup.stage, changed.setup.deploy?.hash, changed.setup.rpcHost], ['deploying', hash, 'base.example.invalid']);
  assert.equal(readWallet(dir)?.deploy?.hash, hash);

  const gone = views().reset({ confirm: OPERATOR }) as State;
  assert.equal(gone.setup.stage, 'none');
  assert.ok(!existsSync(file()));
  assert.deepEqual(readKnown(dir), { operator: OPERATOR, owner: OWNER, executor: contractAddress(OPERATOR, 0) });

  const back = await views().setup({ privateKey: KEY, owner: OWNER }) as State;
  assert.equal(back.setup.stage, 'wallet', '还没上链：不沿用');
  chain.state.deployed = true; chain.mine(hash, 'success'); chain.advance();
  const ready = await until(view => view.mode === 'observe', '原来那笔上链后沿用');
  assert.equal(ready.executor, contractAddress(OPERATOR, 0));
  assert.equal(chain.state.sent.length, 1, '没有再部署一次');
  assert.equal(state().setup.deploy, null);
});

test('沿用的条件：合约的 operator 须仍是这个热钱包；节点应答不全或 nonce 对不上时不部署', async t => {
  // 不开循环：录入时读一次，之后只由部署请求自己核对。
  const { chain, state, views } = setup(t, {}, 3);
  const other = '0x000000000000000000000000000000000000c0de';
  chain.state.deployed = true; chain.state.nonce = 4; chain.state.operator = other; // owner 用 setOperator 停用过这个合约
  const saved = await views().setup({ privateKey: KEY, owner: OWNER }) as State;
  assert.deepEqual([saved.setup.stage, saved.mode], ['wallet', undefined], 'operator 不是这个热钱包：不沿用');

  chain.state.failCode = true;
  assert.equal(await code(() => views().deploy({ confirm: OPERATOR })), 'rpc');
  assert.equal(chain.state.sent.length, 0, '没确认是否部署过：不发');
  chain.state.failCode = false;

  // 代码相符但读不到 operator()：同样不算查完。
  chain.state.operator = OPERATOR; chain.state.failCall = true;
  assert.equal(await code(() => views().deploy({ confirm: OPERATOR })), 'rpc');
  chain.state.failCall = false; chain.state.operator = other;
  // 扫描那一批读到的 nonce 与测算时不同（节点后端进度不一，或链上刚变）：不下「没有」的结论。
  chain.state.hook = method => { if (method === 'eth_getCode') chain.state.nonce = 5; };
  assert.equal(await code(() => views().deploy({ confirm: OPERATOR })), 'rpc');
  chain.state.hook = null; chain.state.nonce = 4;
  assert.equal(chain.state.sent.length, 0);

  // operator 换回来以后，部署请求在签名前自己找到它并沿用。
  chain.state.operator = OPERATOR;
  const adopted = await views().deploy({ confirm: OPERATOR }) as State;
  assert.deepEqual([adopted.setup.stage, chain.state.sent.length], ['ready', 0]);
  assert.equal(state().setup.error, null);
});

test('留下的合约地址：收款地址或热钱包不同、文件损坏、地址上没有预期代码时都不采用', async t => {
  const { chain, views, dir, state } = setup(t, {}, 3);
  const known = join(dir, KNOWN_FILE), executor = contractAddress(OPERATOR, 3), other = '0x000000000000000000000000000000000000c0de';
  chain.state.deployed = true; chain.state.nonce = 40; // 超出扫描范围：只有留下的地址能找到它
  writeFileSync(known, '{"operator":');
  assert.equal(readKnown(dir), null);
  writeFileSync(known, JSON.stringify({ operator: OPERATOR, owner: other, executor }));
  assert.equal((await views().setup({ privateKey: KEY, owner: OWNER }) as State).setup.stage, 'wallet', '收款地址不同');
  views().reset({ confirm: OPERATOR });
  writeFileSync(known, JSON.stringify({ operator: other, owner: OWNER, executor }));
  assert.equal((await views().setup({ privateKey: KEY, owner: OWNER }) as State).setup.stage, 'wallet', '热钱包不同');
  views().reset({ confirm: OPERATOR });
  writeFileSync(known, JSON.stringify({ operator: OPERATOR, owner: OWNER, executor: other }));
  assert.equal((await views().setup({ privateKey: KEY, owner: OWNER }) as State).setup.stage, 'wallet', '地址上没有预期代码');
  views().reset({ confirm: OPERATOR });
  writeFileSync(known, JSON.stringify({ operator: OPERATOR, owner: OWNER, executor }));
  assert.equal((await views().setup({ privateKey: KEY, owner: OWNER }) as State).setup.stage, 'ready');
  assert.equal(state().setup.error, null);
});

test('请求途中被改动：扫描期间换节点返回 stale、不发；发送期间换节点，部署记录仍在', async t => {
  const { chain, views, dir } = setup(t, {}, 2);
  await views().setup({ privateKey: KEY, owner: OWNER });
  let once = true;
  chain.state.hook = method => { if (method === 'eth_getCode' && once) { once = false; views().rpc({ rpcUrl: SECRET_RPC }); } };
  assert.equal(await code(() => views().deploy({ confirm: OPERATOR })), 'stale');
  assert.deepEqual([chain.state.sent.length, readWallet(dir)!.deploy], [0, undefined]);

  once = true;
  chain.state.hook = method => { if (method === 'eth_sendRawTransaction' && once) { once = false; views().rpc({ rpcUrl: null }); } };
  const after = await views().deploy({ confirm: OPERATOR }) as State;
  chain.state.hook = null;
  assert.equal(chain.state.sent.length, 1);
  assert.deepEqual([after.setup.stage, after.setup.deploy?.hash, readWallet(dir)!.deploy?.hash, after.setup.defaultRpc], ['deploying', chain.state.sent[0]!.hash, chain.state.sent[0]!.hash, true]);
});

test('并发与重发：同时两次部署只发一笔；重发被拒收保留原记录；节点 nonce 倒退或已用掉时不发；停止后不接受写入', async t => {
  const { chain, state, views, tick, dir, stop } = setup(t, {}, 2);
  await views().setup({ privateKey: KEY, owner: OWNER });
  chain.state.send = 'drop';
  const first = views().deploy({ confirm: OPERATOR });
  assert.equal(await code(() => views().deploy({ confirm: OPERATOR })), 'busy');
  const unknown = await first as State;
  assert.equal(chain.state.sent.length, 1);
  assert.match(unknown.setup.error!, /结果不明/);
  const original = readWallet(dir)!.deploy!;
  assert.equal(original.nonce, 2);

  tick(REDEPLOY_AFTER_MS);
  chain.state.send = 'reject';
  assert.equal(await code(() => views().deploy({ confirm: OPERATOR })), 'rejected');
  assert.deepEqual([state().setup.stage, readWallet(dir)!.deploy], ['deploying', original], '重发被拒收：原来那笔的记录还在');
  assert.match(state().setup.error!, /结果不明/, '原来那笔仍是结果不明');

  chain.state.send = 'accept';
  chain.state.nonce = 1;
  assert.equal(await code(() => views().deploy({ confirm: OPERATOR })), 'node_behind');
  chain.state.nonce = 3;
  assert.equal(await code(() => views().deploy({ confirm: OPERATOR })), 'pending');
  assert.equal(chain.state.sent.length, 1);
  assert.deepEqual(readWallet(dir)!.deploy, original);

  await stop();
  for (const run of [() => views().deploy({ confirm: OPERATOR }), () => views().reset({ confirm: OPERATOR }), () => views().rpc({ rpcUrl: null })])
    assert.equal(await code(run), 'stopping');
  assert.deepEqual(readWallet(dir)!.deploy, original);
});

test('部署：余额不足不发；节点拒收撤掉记录可重试；结果不明保留记录，5 分钟后同 nonce 加价重发；重启后继续核对', async t => {
  const { chain, state, until, start, stop, views, reopen, tick, dir } = setup(t);
  start();
  await views().setup({ privateKey: KEY, owner: OWNER });
  chain.state.balance = 10n ** 13n;
  assert.equal(await code(() => views().deploy({ confirm: OPERATOR })), 'low_balance');
  chain.state.balance = 10n ** 16n;
  chain.state.send = 'reject';
  assert.equal(await code(() => views().deploy({ confirm: OPERATOR })), 'rejected');
  assert.deepEqual([state().setup.stage, readWallet(dir)?.deploy], ['wallet', undefined]);

  chain.state.send = 'drop';
  const unknown = await views().deploy({ confirm: OPERATOR }) as State;
  assert.equal(unknown.setup.stage, 'deploying', '发送结果不明：记录保留');
  const first = Transaction.from(chain.state.sent[0]!.raw);
  assert.equal(await code(() => views().deploy({ confirm: OPERATOR })), 'pending');
  tick(REDEPLOY_AFTER_MS);
  chain.state.send = 'accept';
  await views().deploy({ confirm: OPERATOR });
  const second = Transaction.from(chain.state.sent[1]!.raw);
  assert.equal(second.nonce, first.nonce, '同一个 nonce');
  assert.ok(second.maxFeePerGas! * 4n >= first.maxFeePerGas! * 5n && second.maxPriorityFeePerGas! * 4n >= first.maxPriorityFeePerGas! * 5n, '两项费用各加 25% 以上');
  assert.equal(state().setup.deploy?.hash, chain.state.sent[1]!.hash);

  // 重启：部署记录在文件里，接着核对；先上链的是第一笔，合约地址一样。
  await stop(); reopen();
  assert.equal(state().setup.stage, 'deploying');
  chain.state.deployed = true; chain.mine(chain.state.sent[0]!.hash, 'success'); chain.advance();
  start();
  const ready = await until(view => view.mode === 'observe', '重启后核对到部署');
  assert.equal(ready.executor, contractAddress(OPERATOR, 0));
});

test('部署没成：nonce 被用掉而地址上没有预期代码，连续几轮后清掉记录并说明，可以重新部署', async t => {
  const { chain, state, until, start, views } = setup(t);
  start();
  await views().setup({ privateKey: KEY, owner: OWNER });
  await views().deploy({ confirm: OPERATOR });
  // 读不到代码的轮次不算「没有代码」：节点应答不全时一直等。
  chain.state.failCode = true;
  chain.mine(chain.state.sent[0]!.hash, 'reverted'); // nonce 前进，合约不存在
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(state().setup.stage, 'deploying');
  chain.state.failCode = false;
  const failed = await until(view => view.setup.stage === 'wallet' && view.setup.error !== null, '判定部署没成');
  assert.match(failed.setup.error!, /部署交易没有成功/);
  assert.equal(state().setup.deploy, null);
});

test('由配置文件管理时：页面不能录入、部署、换节点或移除；数据目录里的钱包文件不被采用', async t => {
  const executor = '0x00000000000000000000000000000000004d4556';
  const { dir, state, views, lines } = setup(t, { config: { executor, owner: OWNER }, secrets: { rpcUrl: SECRET_RPC, privateKey: KEY } });
  assert.deepEqual([state().setup.stage, state().setup.managed, state().setup.operator, state().setup.rpcHost], ['ready', true, OPERATOR, 'base.example.invalid']);
  for (const run of [() => views().setup({ privateKey: KEY, owner: OWNER }), () => views().deploy({ confirm: OPERATOR }), () => views().reset({ confirm: OPERATOR }), () => views().rpc({ rpcUrl: null })])
    assert.equal(await code(run), 'managed');
  assert.equal(readWallet(dir), null);
  assert.ok(!LEAK.test(JSON.stringify(state())) && !LEAK.test(lines.join('\n')));
});

test('启动时：清掉写钱包文件留下的临时文件；热钱包与平台账户相同时不采用', t => {
  const { dir, file } = setup(t);
  writeWallet(dir, { privateKey: KEY, owner: OWNER });
  writeFileSync(`${file()}.abc123.tmp`, JSON.stringify({ privateKey: KEY, owner: OWNER }));
  const lines: string[] = [];
  const mev = openMev({ others: [OPERATOR.toUpperCase().replace('0X', '0x')] }, dir, { fetchImpl: async () => { throw new TypeError('fetch failed'); } }, { log: line => lines.push(line), notify: () => undefined });
  const view = mev.views.state() as State;
  assert.deepEqual(readdirSync(dir), [WALLET_FILE]);
  assert.deepEqual([view.setup.stage, view.setup.operator], ['none', null]);
  assert.match(view.setup.error!, /专用/);
  assert.ok(!LEAK.test(lines.join('\n')));
  mev.shutdown();
});

test('钱包文件损坏：模块回到未录入并说明原因，重新录入会覆盖它', async t => {
  const { dir, file } = setup(t);
  writeFileSync(file(), '{"privateKey":"4c0883a6');
  const lines: string[] = [];
  const mev = openMev({}, dir, { fetchImpl: async () => { throw new TypeError('fetch failed'); } }, { log: line => lines.push(line), notify: () => undefined });
  const view = mev.views.state() as State;
  assert.equal(view.setup.stage, 'none');
  assert.match(view.setup.error!, /mev-wallet\.json/);
  assert.ok(!LEAK.test(JSON.stringify(view)) && !LEAK.test(lines.join('\n')));
  const saved = await mev.views.setup({ privateKey: KEY, owner: OWNER }) as State;
  assert.deepEqual([saved.setup.stage, saved.setup.error, saved.setup.wallet], ['wallet', null, null]);
  assert.match(saved.setup.rpcError!, /./);
  assert.deepEqual(readWallet(dir), { privateKey: KEY, owner: OWNER });
  assert.equal(JSON.parse(readFileSync(file(), 'utf8')).owner, OWNER);
  mev.shutdown();
});
