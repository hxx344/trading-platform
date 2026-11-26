// MEV 套利引擎（src/mev/engine.ts）对着替身节点（src/mev/fake-chain.ts）的全流程：观察、开始实盘的确认、先入库再发送、
// 按回执与 nonce 结清、结果不明不重发、过期后同 nonce 加价、连续回滚与外来 nonce 的熔断、重启恢复、预算与余额。
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transaction } from 'ethers';
import { BASE_CHAIN_ID, FACTORIES, KIND_AERO_V2, USDC, WETH, type FactoryInfo, type TokenInfo } from '../src/mev/chain.ts';
import { AbiReader, addressOf, signTransaction } from '../src/mev/codec.ts';
import { DEADLINE_BLOCKS, FEE_FLOOR_WINDOW_MS, MevError, REVERIFY_MS, createMevEngine } from '../src/mev/engine.ts';
import { createFakeChain, type FakeExecute, type FakePool } from '../src/mev/fake-chain.ts';
import { DEFAULT_SETTINGS, SettingsError, type Settings } from '../src/mev/risk.ts';
import { createRpc } from '../src/mev/rpc.ts';
import { EXPIRE_GRACE_BLOCKS, MISSING_LIMIT } from '../src/mev/sender.ts';
import { MEV_FILE, openMevStore } from '../src/mev/store.ts';

const KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const OPERATOR = addressOf(KEY), EXECUTOR = '0x00000000000000000000000000000000004d4556', OWNER = '0x000000000000000000000000000000000000b0b0';
const AERO = '0x940181a94a35a4569e4529a3cdfb74e38fd98631';
const TOKENS: TokenInfo[] = [{ address: WETH, symbol: 'WETH', decimals: 18 }, { address: USDC, symbol: 'USDC', decimals: 6 }, { address: AERO, symbol: 'AERO', decimals: 18 }];
const USD: Record<string, number> = { [WETH]: 3_400, [USDC]: 1, [AERO]: 1.1 };
const decimalsOf = (address: string): number => TOKENS.find(token => token.address === address)!.decimals;
const [uniswap, slipstream, aeroV2] = FACTORIES as unknown as [FactoryInfo, FactoryInfo, FactoryInfo];

function makePools(): FakePool[] {
  let serial = 0;
  const pool = (factory: FactoryInfo, a: string, b: string, tier: bigint | undefined, fee: bigint, depthUsd: number, skew = 0): FakePool => {
    const [token0, token1] = a < b ? [a, b] : [b, a];
    const price = USD[token0]! / USD[token1]! * 10 ** (decimalsOf(token1) - decimalsOf(token0)) * (1 + skew);
    const reserve0 = depthUsd / USD[token0]! * 10 ** decimalsOf(token0);
    return { address: '0x' + (0xfeed0000 + ++serial).toString(16).padStart(40, '0'), factory, token0, token1, ...(tier === undefined ? {} : { tier }), fee, price,
      depth: factory.kind === KIND_AERO_V2 ? reserve0 : reserve0 * Math.sqrt(price) };
  };
  // 两个 WETH/USDC 池子之间留了约 32 个基点的价差。
  return [pool(uniswap, WETH, USDC, 500n, 500n, 6_000_000), pool(slipstream, WETH, USDC, 100n, 400n, 4_500_000, 0.0032), pool(aeroV2, WETH, AERO, undefined, 30n, 1_400_000)];
}
/** 两跳环路的利润随输入先增后减，约在 5000 美元名义处最大（约 5 美元）。 */
const profitable = (call: FakeExecute): bigint | null => {
  if (call.pools.length !== 2) return null;
  const unit = 10 ** decimalsOf(call.start), notional = Number(call.amountIn) / unit * USD[call.start]!;
  const usd = notional * 0.0021 - notional ** 2 / 4_800_000;
  return usd > 0 ? BigInt(Math.floor(usd / USD[call.start]! * unit)) : null;
};

function setup(t: TestContext, options: { dir?: string; profit?: (call: FakeExecute) => bigint | null } = {}) {
  let clock = Date.UTC(2026, 10, 25, 12);
  const now = () => clock;
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'tp-mev-engine-'));
  const engines = new Set<ReturnType<typeof createMevEngine>>();
  t.after(() => {
    for (const engine of engines) engine.close();
    if (!options.dir) rmSync(dir, { recursive: true, force: true });
  });
  const chain = createFakeChain({ executor: EXECUTOR, owner: OWNER, operator: OPERATOR, tokens: TOKENS, pools: makePools(), now, profit: options.profit ?? profitable });
  const logs: string[] = [], notices: string[] = [];
  const open = (privateKey = KEY) => {
    const store = openMevStore(join(dir, MEV_FILE));
    // 白名单已就绪：不去读默认的中间代币。
    if (!store.tokens().length) { for (const token of TOKENS) store.putToken(token, now()); store.writeState('seeded', true, now()); }
    const rpc = createRpc({ url: 'https://fake.invalid', fetchImpl: chain.fetchImpl });
    const engine = createMevEngine({ store, rpc, sendRpc: rpc, chainId: BASE_CHAIN_ID, executor: EXECUTOR, owner: OWNER, privateKey, now, log: line => logs.push(line), notify: (_key, text) => { notices.push(text); } });
    engines.add(engine);
    return { store, engine, rpc };
  };
  const first = open();
  /** 出若干个新区块（时钟每块走两秒），引擎处理一轮。 */
  const step = async (engine = first.engine, blocks = 1): Promise<void> => { clock += 2_000 * blocks; chain.advance(blocks); await engine.tick(); };
  return {
    ...first, chain, dir, logs, notices, step, open,
    advanceClock(ms: number): void { clock += ms; },
    closeFirst(): void { first.engine.close(); engines.delete(first.engine); },
    /** 核对合约并走到目录就绪。 */
    async ready(engine = first.engine): Promise<void> { await engine.verify(); await step(engine); await step(engine); },
    async goLive(engine = first.engine): Promise<void> { const seen = engine.views.state(); assert.deepEqual(await engine.views.start({ confirm: OPERATOR, fault: seen.fault, haltReason: seen.haltReason }), { mode: 'live' }); },
  };
}
const sends = (chain: ReturnType<typeof createFakeChain>): number => chain.state.calls.filter(method => method === 'eth_sendRawTransaction').length;
const rejectsWith = (code: string, status: number) => (error: unknown): boolean => error instanceof MevError && error.code === code && error.status === status;

/** Hold just the next node reply so another operator can act before that verification completes. */
function holdNextVerification(s: ReturnType<typeof setup>): (fail?: boolean) => void {
  const batch = s.rpc.batch;
  let release!: (fail?: boolean) => void;
  const held = new Promise<boolean | undefined>(resolve => { release = resolve; });
  s.rpc.batch = async (...args) => {
    s.rpc.batch = batch;
    const reply = await batch(...args);
    if (await held) throw new Error('测试节点暂不可读');
    return reply;
  };
  return release;
}

test('观察模式：发现并记录机会，不签名也不发送；合约核对通过', async t => {
  const s = setup(t);
  await s.ready();
  for (let i = 0; i < 3; i++) await s.step();
  const view = s.engine.views.state();
  assert.equal(view.mode, 'observe');
  assert.deepEqual(view.verification.ok, true);
  assert.equal(view.operator, OPERATOR);
  assert.equal(view.chainId, 8453);
  assert.ok(view.directory.pools === 3 && view.directory.cycles > 0, '目录应含三个池子与若干环路');
  assert.ok(view.opportunities.length > 0 && view.opportunities.every(entry => entry.outcome === 'observed'), '应记录到观察到的机会');
  assert.ok(view.opportunities[0]!.netUsd > 0.3);
  assert.equal(sends(s.chain), 0);
  assert.equal(s.store.recentTxs(10).length, 0);
  assert.ok(view.wallet && view.wallet.eth === 0.01 && view.wallet.nonce === 0);
  assert.ok(view.tokens.some(token => token.symbol === 'WETH' && token.start && token.priceUsd !== null && Math.abs(token.priceUsd - 3_400) < 40));
  // 序列化给页面时不含私钥，也没有 bigint。
  const text = JSON.stringify(view);
  assert.ok(!text.includes(KEY.slice(2)));
});

test('没有盈利的档位时不记录机会，环路进入冷却', async t => {
  const s = setup(t, { profit: () => null });
  await s.ready();
  await s.step();
  const simulated = s.engine.views.state().counters.simulated;
  assert.ok(simulated > 0);
  await s.step();
  assert.equal(s.engine.views.state().counters.simulated, simulated, '冷却期内不再模拟同一条环路');
  assert.equal(s.engine.views.state().opportunities.length, 0);
});

test('开始实盘须带热钱包地址确认；发送一笔、等结论、上链成功后结清并继续', async t => {
  const s = setup(t);
  await s.ready();
  await assert.rejects(async () => s.engine.views.start({}), rejectsWith('confirm_required', 400));
  await assert.rejects(async () => s.engine.views.start({ confirm: OWNER }), rejectsWith('confirm_required', 400));
  assert.equal(s.engine.isLive(), false);
  await s.goLive();
  assert.ok(s.notices.some(text => text.includes('开始实盘')));
  await s.step();
  assert.equal(sends(s.chain), 1, '一个区块只发一笔');
  const [stored] = s.store.recentTxs(10);
  assert.ok(stored && stored.status === 'sent' && stored.nonce === 0);
  const parsed = Transaction.from(stored!.raw);
  assert.equal(parsed.hash, stored!.hash);
  assert.equal(parsed.from?.toLowerCase(), OPERATOR);
  assert.equal(parsed.to?.toLowerCase(), EXECUTOR);
  assert.equal(parsed.chainId, 8453n);
  assert.equal(parsed.value, 0n);
  assert.ok(parsed.gasLimit <= BigInt(DEFAULT_SETTINGS.maxGasLimit));
  // 调用数据里的截止区块是发现时的区块加 DEADLINE_BLOCKS，minProfit 大于零且不超过模拟利润。
  const args = new AbiReader('0x' + parsed.data.slice(10));
  assert.equal(args.uint(96), BigInt(s.chain.state.block + DEADLINE_BLOCKS));
  assert.equal(Number(args.uint(96)), stored!.deadlineBlock);
  assert.ok(args.uint(64) > 0n && args.uint(64) <= stored!.expectedProfit);
  // 上一笔没有结论之前不发下一笔。
  await s.step();
  assert.equal(sends(s.chain), 1);
  s.chain.mine(stored!.hash, 'success', { profit: stored!.expectedProfit });
  await s.step();
  const settled = s.store.recentTxs(10).find(tx => tx.hash === stored!.hash)!;
  assert.equal(settled.status, 'success');
  assert.equal(settled.profit, stored!.expectedProfit);
  assert.ok(settled.feeWei !== null && settled.feeWei > 0n);
  assert.equal(sends(s.chain), 2, '结清后的同一轮里可以发下一笔');
  assert.equal(s.store.openTxs()[0]!.nonce, 1);
  const view = s.engine.views.state();
  assert.equal(view.mode, 'live');
  assert.equal(view.today.success, 1);
  assert.ok(view.today.gasSpentEth > 0 && view.today.reservedEth > 0);
  assert.ok(view.transactions.some(tx => tx.status === 'success' && tx.profit !== null));
  // 用户停止：回到观察，未结清的照常核对。
  assert.deepEqual(s.engine.views.stop(), { mode: 'observe' });
  s.chain.mine(s.store.openTxs()[0]!.hash, 'reverted');
  await s.step();
  assert.equal(s.store.openTxs().length, 0);
  assert.equal(sends(s.chain), 2);
  assert.equal(s.engine.views.state().today.reverted, 1);
});

test('发送结果不明时不重发；过期后在同一个 nonce 上加价重发，先上链的一笔成功，另一笔记为被替换', async t => {
  const s = setup(t);
  await s.ready();
  await s.goLive();
  s.chain.state.send = 'drop';
  await s.step();
  const [first] = s.store.recentTxs(10);
  assert.ok(first && first.status === 'unknown' && first.error);
  s.chain.state.send = 'accept';
  for (let i = 0; i < 3; i++) await s.step();
  assert.equal(sends(s.chain), 0, '结果不明的交易不重发，也不发新的');
  assert.equal(s.engine.isLive(), true);
  // 截止区块过去 EXPIRE_GRACE_BLOCKS 之后记为过期，同一轮里在同一个 nonce 上加价发新的一笔。
  await s.step(s.engine, DEADLINE_BLOCKS + EXPIRE_GRACE_BLOCKS + 1);
  const txs = s.store.recentTxs(10);
  assert.equal(txs.length, 2);
  const second = txs.find(tx => tx.hash !== first!.hash)!;
  assert.equal(txs.find(tx => tx.hash === first!.hash)!.status, 'expired');
  assert.equal(second.nonce, first!.nonce);
  assert.equal(second.status, 'sent');
  assert.ok(second.maxFeePerGas * 100n >= first!.maxFeePerGas * 125n && second.maxPriorityFeePerGas * 100n >= first!.maxPriorityFeePerGas * 125n, '替换交易两项费用都至少加 25%');
  s.chain.mine(second.hash, 'success', { profit: 5n });
  await s.step();
  const after = s.store.recentTxs(10);
  assert.equal(after.find(tx => tx.hash === second.hash)!.status, 'success');
  assert.equal(after.find(tx => tx.hash === first!.hash)!.status, 'replaced');
});

test('节点拒绝发送：记为结果不明并等过期；连续拒绝到上限停实盘', async t => {
  const s = setup(t);
  await s.ready();
  await s.goLive();
  s.chain.state.send = 'reject';
  for (let round = 0; round < 3; round++) {
    assert.equal(s.engine.isLive(), true);
    await s.step(s.engine, round === 0 ? 1 : DEADLINE_BLOCKS + EXPIRE_GRACE_BLOCKS + 1);
  }
  assert.equal(s.engine.isLive(), false);
  assert.match(s.engine.views.state().haltReason ?? '', /连续 3 次拒绝发送/);
  assert.ok(s.notices.some(text => text.includes('已停止实盘')));
});

test('久远的过期交易不再抬高加价的底', async t => {
  const s = setup(t);
  await s.ready();
  await s.goLive();
  s.chain.state.send = 'drop';
  await s.step();
  const [old] = s.store.openTxs();
  assert.ok(old);
  // 过了加价窗口它才过期：同一轮里发出的新一笔按正常费用出价，不以那笔过期交易为底。
  // 时钟分步走（两轮之间超过 60 秒会按节点无应答停实盘），期间区块数还不到过期线。
  const rounds = Math.ceil(FEE_FLOOR_WINDOW_MS / 50_000);
  assert.ok(rounds < DEADLINE_BLOCKS + EXPIRE_GRACE_BLOCKS);
  for (let i = 0; i < rounds; i++) { s.advanceClock(50_000); await s.step(); }
  assert.deepEqual(s.store.openTxs().map(tx => tx.status), ['unknown']);
  assert.equal(s.engine.isLive(), true);
  await s.step(s.engine, DEADLINE_BLOCKS + EXPIRE_GRACE_BLOCKS + 1);
  assert.deepEqual(s.store.openTxs().map(tx => tx.status), ['expired', 'unknown']);
  const fresh = s.store.recentTxs(1)[0]!;
  assert.notEqual(fresh.hash, old.hash);
  assert.ok(fresh.maxPriorityFeePerGas < old.maxPriorityFeePerGas * 5n / 4n, '没有按 25% 加价');
});

test('开始实盘的确认绑定页面所见：故障记录或停止原因已变时拒绝，不清除故障', async t => {
  const s = setup(t);
  await s.ready();
  await s.goLive();
  s.engine.views.stop();
  const halted = s.engine.views.state().haltReason;
  assert.ok(halted);
  // 旧页面（还没看到停止原因）的请求。
  await assert.rejects(async () => s.engine.views.start({ confirm: OPERATOR }), rejectsWith('stale', 409));
  await assert.rejects(async () => s.engine.views.start({ confirm: OPERATOR, fault: '别的故障', haltReason: halted }), rejectsWith('stale', 409));
  assert.equal(s.engine.isLive(), false);
  assert.equal(s.engine.views.state().haltReason, halted);
  await s.goLive();
  assert.equal(s.engine.isLive(), true);
});

test('换了热钱包：旧钱包的未结清交易直接结清，它的上链记录不挡新钱包从 nonce 0 发送', async t => {
  const s = setup(t);
  await s.ready();
  await s.goLive();
  await s.step();
  const [mined] = s.store.openTxs();
  assert.ok(mined);
  s.chain.mine(mined.hash, 'success', { profit: 5n });
  await s.step();
  assert.equal(s.store.maxMinedNonce(), 0);
  s.chain.state.send = 'drop';
  await s.step();
  assert.equal(s.store.openTxs().length, 1);
  s.closeFirst();
  // 旧钱包在链上已到 nonce 1；新钱包从 0 开始。
  const otherKey = '0x' + '11'.repeat(32), other = addressOf(otherKey);
  s.chain.state.operator = other;
  s.chain.state.nonce = 0;
  s.chain.state.send = 'accept';
  s.advanceClock(60_000);
  const next = s.open(otherKey);
  assert.equal(next.store.openTxs().length, 0);
  assert.deepEqual(next.store.recentTxs(1).map(tx => [tx.status, tx.error]), [['lost', '热钱包已更换，这笔交易不再核对']]);
  assert.equal(next.store.maxMinedNonce(), null, '旧钱包的上链记录不算进新钱包的 nonce 比较');
  assert.deepEqual([next.engine.views.state().operator, next.engine.views.state().fault], [other, null]);
  await s.ready(next.engine);
  const before = sends(s.chain), seen = next.engine.views.state();
  assert.deepEqual(await next.engine.views.start({ confirm: other, fault: seen.fault, haltReason: seen.haltReason }), { mode: 'live' });
  await s.step(next.engine);
  assert.equal(sends(s.chain), before + 1);
  assert.deepEqual(next.store.openTxs().map(tx => tx.nonce), [0]);
});

test('停服：quiesce 之后不再发送', async t => {
  const s = setup(t);
  await s.ready();
  await s.goLive();
  s.engine.quiesce();
  for (let i = 0; i < 3; i++) await s.step();
  assert.equal(sends(s.chain), 0);
  assert.equal(s.store.recentTxs(5).length, 0);
  await assert.rejects(async () => s.engine.views.start({ confirm: OPERATOR, fault: null, haltReason: null }), rejectsWith('stopping', 503));
  assert.ok(!s.notices.some(text => text.includes('已停止实盘')), '停服不发熔断通知');
});

test('开始核对途中停止或停服：迟到的开始不能开启实盘', async t => {
  const s = setup(t);
  await s.ready();
  let release = holdNextVerification(s);
  const start = s.engine.views.start({ confirm: OPERATOR });
  assert.deepEqual(s.engine.views.stop(), { mode: 'observe' });
  assert.deepEqual(s.engine.views.stop(), { mode: 'observe' });
  release();
  await assert.rejects(start, rejectsWith('stale', 409));
  await s.step();
  assert.equal(s.engine.views.state().mode, 'observe');
  assert.equal(sends(s.chain), 0);
  release = holdNextVerification(s);
  const shuttingDown = s.engine.views.start({ confirm: OPERATOR });
  s.engine.quiesce();
  release();
  await assert.rejects(shuttingDown, rejectsWith('stopping', 503));
  assert.equal(s.notices.filter(n => n.includes('开始实盘')).length, 0);
});

for (const stopBetween of [false, true]) {
  test(`并发开始${stopBetween ? '、中途停止再开始' : ''}：只有最新确认能创建实盘会话`, async t => {
    const s = setup(t);
    await s.ready();
    const release = holdNextVerification(s);
    const old = s.engine.views.start({ confirm: OPERATOR });
    if (stopBetween) s.engine.views.stop();
    await s.goLive();
    const since = s.engine.views.state().liveSince;
    s.advanceClock(1_000);
    release(stopBetween);
    await assert.rejects(old, rejectsWith('stale', 409));
    assert.equal(s.engine.views.state().mode, 'live');
    assert.equal(s.engine.views.state().liveSince, since);
    assert.equal(s.engine.views.state().verification.ok, true);
    assert.equal(s.notices.filter(n => n.includes('开始实盘')).length, 1);
    await s.step();
    assert.equal(sends(s.chain), 1);
  });
}

test('启动与后台同时重查合约时使用同一份核对结果', async t => {
  const s = setup(t);
  await s.ready();
  s.chain.state.operator = OWNER;
  await s.engine.verify();
  assert.equal(s.engine.views.state().verification.ok, false);
  for (const matches of [false, true]) {
    s.advanceClock(60_001);
    if (matches) s.chain.state.operator = OPERATOR;
    const reads = () => s.chain.state.calls.filter(method => method === 'eth_chainId').length;
    const before = reads();
    const release = holdNextVerification(s);
    const start = s.engine.views.start({ confirm: OPERATOR });
    const tick = s.engine.tick();
    release();
    if (matches) assert.deepEqual(await start, { mode: 'live' });
    else await assert.rejects(start, rejectsWith('not_verified', 409));
    await tick;
    assert.equal(reads() - before, 1);
    assert.equal(s.engine.isLive(), matches);
    assert.equal(s.engine.views.state().verification.ok, matches);
  }
});

test('连续上链回滚到上限即停实盘；重新开始后计数清零', async t => {
  const s = setup(t);
  await s.ready();
  const settings: Settings = { ...DEFAULT_SETTINGS, maxConsecutiveReverts: 2 };
  assert.deepEqual(s.engine.views.settings({ settings }), { settings });
  await s.goLive();
  await s.step();
  s.chain.mine(s.store.openTxs()[0]!.hash, 'reverted');
  await s.step();
  assert.equal(s.engine.isLive(), true);
  assert.equal(s.engine.views.state().consecutiveReverts, 1);
  s.chain.mine(s.store.openTxs()[0]!.hash, 'reverted');
  await s.step();
  assert.equal(s.engine.isLive(), false);
  assert.match(s.engine.views.state().haltReason ?? '', /连续 2 笔上链回滚/);
  const sentBefore = sends(s.chain);
  await s.step();
  assert.equal(sends(s.chain), sentBefore, '停实盘后不再发送');
  assert.equal(s.store.openTxs().length, 0);
  await s.goLive();
  assert.equal(s.engine.views.state().consecutiveReverts, 0);
  assert.equal(s.engine.views.state().haltReason, null);
});

test('nonce 被不属于本模块的交易占用：核对几轮后记为丢失、停实盘并留下故障记录，重启后仍在', async t => {
  const s = setup(t);
  await s.ready();
  await s.goLive();
  await s.step();
  const [tx] = s.store.openTxs();
  assert.ok(tx);
  s.chain.state.nonce++;
  for (let i = 0; i < MISSING_LIMIT - 1; i++) { await s.step(); assert.equal(s.engine.isLive(), true, '回执可能只是滞后，先不下结论'); }
  await s.step();
  assert.equal(s.engine.isLive(), false);
  assert.equal(s.store.recentTxs(10).find(entry => entry.hash === tx!.hash)!.status, 'lost');
  assert.match(s.engine.views.state().fault ?? '', /nonce 0 被不属于本模块的交易占用/);
  assert.equal(sends(s.chain), 1);
  s.closeFirst();
  const again = s.open();
  assert.match(again.engine.views.state().fault ?? '', /nonce 0/);
  assert.equal(again.engine.isLive(), false, '重启后总是观察模式');
  await s.ready(again.engine);
  await s.goLive(again.engine);
  assert.equal(again.engine.views.state().fault, null, '用户确认开始后清掉故障记录');
});

test('重启恢复：入库后还没发出去就退出的交易，重启后按回执结清，不重发、不自动恢复实盘', async t => {
  const s = setup(t);
  const signed = signTransaction({ chainId: BASE_CHAIN_ID, nonce: 0n, maxPriorityFeePerGas: 1_000_000n, maxFeePerGas: 16_000_000n, gasLimit: 494_000n, to: EXECUTOR, value: 0n, data: '0x' }, KEY);
  s.store.recordTx({ hash: signed.hash, nonce: 0, raw: signed.raw, createdAt: Date.UTC(2026, 10, 25, 11), deadlineBlock: 900, maxFeePerGas: 16_000_000n, maxPriorityFeePerGas: 1_000_000n, worstCostWei: 10n ** 13n,
    opportunityId: null, start: WETH, path: 'WETH → USDC → WETH', expectedProfit: 10n ** 15n });
  s.closeFirst();
  const again = s.open();
  assert.equal(again.store.openTxs()[0]!.status, 'recorded');
  assert.ok(again.engine.views.state().today.reservedEth > 0, '未结清的交易占着预算');
  s.chain.mine(signed.hash, 'success', { profit: 9n * 10n ** 14n });
  await s.ready(again.engine);
  const [settled] = again.store.recentTxs(10);
  assert.equal(settled!.status, 'success');
  assert.equal(settled!.profit, 9n * 10n ** 14n);
  assert.equal(sends(s.chain), 0);
  assert.equal(again.engine.isLive(), false);
});

test('合约核对不过不能开始实盘：链号、operator、代码任一不符', async t => {
  const s = setup(t);
  s.chain.state.operator = OWNER;
  await s.ready();
  assert.match(s.engine.views.state().verification.reason ?? '', /operator 不是配置的热钱包/);
  await assert.rejects(async () => s.engine.views.start({ confirm: OPERATOR }), rejectsWith('not_verified', 409));
  assert.equal(s.engine.views.state().opportunities.length, 0, '核对不过时不做发现');
  s.chain.state.operator = OPERATOR;
  s.chain.state.chainId = 1n;
  await s.engine.verify();
  assert.match(s.engine.views.state().verification.reason ?? '', /链号是 1/);
  s.chain.state.chainId = 8453n;
  await s.engine.verify();
  assert.equal(s.engine.views.state().verification.ok, true);
});

test('实盘中合约核对转为不过（owner 换了热钱包）时在开始前被拦下；余额低于下限不能开始、实盘中跌破即停', async t => {
  const s = setup(t);
  await s.ready();
  s.chain.state.balance = 10n ** 15n;
  await s.step();
  await assert.rejects(async () => s.engine.views.start({ confirm: OPERATOR }), rejectsWith('low_balance', 409));
  s.chain.state.balance = 10n ** 16n;
  await s.step();
  await s.goLive();
  s.chain.state.balance = 10n ** 15n;
  await s.step();
  assert.equal(s.engine.isLive(), false);
  assert.match(s.engine.views.state().haltReason ?? '', /热钱包余额 .* 低于下限/);
  assert.equal(sends(s.chain), 0);
  s.chain.state.balance = 10n ** 16n;
  s.chain.state.operator = OWNER;
  await s.step();
  await assert.rejects(async () => s.engine.views.start({ confirm: OPERATOR }), rejectsWith('not_verified', 409));
});

test('实盘中定期核对读到 operator 已被换掉：停实盘并通知，之后核对恢复也不自动重开', async t => {
  const s = setup(t, { profit: () => null });
  await s.ready();
  await s.goLive();
  s.chain.state.operator = OWNER;
  for (let i = 0; i < Math.ceil(REVERIFY_MS / 50_000); i++) { s.advanceClock(50_000); await s.step(); }
  assert.equal(s.engine.isLive(), false);
  assert.match(s.engine.views.state().haltReason ?? '', /operator 不是配置的热钱包/);
  assert.ok(s.notices.some(text => text.includes('已停止实盘')));
  s.chain.state.operator = OPERATOR;
  for (let i = 0; i < 3; i++) { s.advanceClock(50_000); await s.step(); }
  assert.equal(s.engine.views.state().verification.ok, true);
  assert.equal(s.engine.isLive(), false);
});

test('每日 gas 预算放不下这一笔时跳过并记录原因，不停实盘；节点长时间不应答则停', async t => {
  const s = setup(t);
  await s.ready();
  s.engine.views.settings({ settings: { ...DEFAULT_SETTINGS, dailyGasBudgetEth: 0.0001 } });
  // 小费封顶在预算的四分之一，光靠小费撑不破预算：把基础费抬到这一笔的费用上限本身就超过预算。
  s.chain.state.baseFee = 100_000_000n;
  await s.goLive();
  // 同一条环路 30 秒内只记一条机会：让它过去，这一轮被拦下的原因才会入库。
  s.advanceClock(31_000);
  await s.step();
  assert.equal(sends(s.chain), 0);
  assert.equal(s.engine.isLive(), true);
  assert.ok(s.engine.views.state().opportunities.some(entry => entry.outcome === 'blocked' && /今日 gas 预算/.test(entry.reason ?? '')));
  s.chain.state.down = true;
  await assert.rejects(async () => s.step());
  assert.equal(s.engine.isLive(), true);
  s.advanceClock(61_000);
  await assert.rejects(async () => s.step());
  assert.equal(s.engine.isLive(), false);
  assert.match(s.engine.views.state().haltReason ?? '', /没有成功应答/);
  // 节点地址不出现在报错里。
  assert.ok(!JSON.stringify(s.engine.views.state()).includes('fake.invalid'));
});

test('节点的最新区块落后时不发现也不能开始', async t => {
  const s = setup(t);
  await s.ready();
  s.advanceClock(60_000);
  await s.engine.tick();
  s.chain.state.block++;
  await s.engine.tick();
  assert.equal(s.engine.views.state().lagging, true);
  await assert.rejects(async () => s.engine.views.start({ confirm: OPERATOR }), rejectsWith('lagging', 409));
});

test('参数与白名单：越界的参数整份拒绝；起始代币不能删；加入的代币从链上读符号与精度', async t => {
  const s = setup(t);
  await s.ready();
  assert.throws(() => s.engine.views.settings({ settings: { ...DEFAULT_SETTINGS, tipShare: 0.95 } }), SettingsError);
  assert.throws(() => s.engine.views.settings({ settings: { ...DEFAULT_SETTINGS, extra: 1 } }), /不认识的参数/);
  assert.throws(() => s.engine.views.settings(null), rejectsWith('invalid_body', 400));
  assert.deepEqual(s.engine.views.state().settings, DEFAULT_SETTINGS);
  await assert.rejects(async () => s.engine.views.tokens({ action: 'remove', address: WETH }), rejectsWith('start_token', 400));
  await assert.rejects(async () => s.engine.views.tokens({ action: 'add', address: '0x12' }), rejectsWith('invalid_address', 400));
  await assert.rejects(async () => s.engine.views.tokens({ action: 'add', address: '0x' + '9'.repeat(40) }), rejectsWith('not_token', 400));
  await assert.rejects(async () => s.engine.views.tokens({ action: 'drop', address: AERO }), rejectsWith('invalid_action', 400));
  assert.deepEqual(await s.engine.views.tokens({ action: 'remove', address: AERO.toUpperCase().replace('0X', '0x') }), { tokens: TOKENS.slice(0, 2) });
  await assert.rejects(async () => s.engine.views.tokens({ action: 'remove', address: AERO }), rejectsWith('not_found', 404));
  assert.equal(s.engine.views.state().directory.pools, 2, '移出立即生效，不等目录刷新');
  await s.step();
  assert.equal(s.engine.views.state().directory.pools, 2, '去掉代币后目录里不再有它的池子');
  const added = await s.engine.views.tokens({ action: 'add', address: AERO }) as { tokens: TokenInfo[] };
  assert.deepEqual(added.tokens.find(token => token.address === AERO), TOKENS[2]);
  await s.step();
  assert.equal(s.engine.views.state().directory.pools, 3);
});
