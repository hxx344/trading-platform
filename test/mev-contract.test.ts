// MEV 执行合约（contracts/MevExecutor.sol）：入库的编译产物与源码一致；在进程内的 EVM（@ethereumjs/vm，开发依赖）里
// 对着替身池子（contracts/test/Mocks.sol）跑它的行为：赚钱时利润归 owner、不赚钱整笔回滚、只有热钱包能调、
// 回调只认本次兑换的池子、工厂没登记的池子不用。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ARTIFACT_FILE, EXECUTOR_SOURCE, MOCKS_SOURCE, compile, readSource, sourceHash } from '../scripts/mev-compile.ts';
import { EXECUTOR_CREATION_CODE, EXECUTOR_OWNER_OFFSETS, EXECUTOR_RUNTIME_CODE, EXECUTOR_SOURCE_SHA256 } from '../src/mev/executor-artifact.ts';
import { AbiReader, abiEncode, callData, selector, type AbiType, type AbiValue } from '../src/mev/codec.ts';
import { FACTORIES, KIND_AERO_V2, KIND_SLIPSTREAM, KIND_V3 } from '../src/mev/chain.ts';
import { deploymentData } from '../src/mev/deploy-data.ts';
import { expectedRuntimeCode } from '../src/mev/engine.ts';
import { EXECUTED_TOPIC } from '../src/mev/simulate.ts';

// 只有 @ethereumjs/vm 是直接依赖；它自己的依赖从它的位置解析，保证用的是同一份类。
const require = createRequire(import.meta.url);
const fromVm = createRequire(require.resolve('@ethereumjs/vm'));
/* eslint-disable @typescript-eslint/no-explicit-any */
const { createVM } = require('@ethereumjs/vm') as any;
const util = fromVm('@ethereumjs/util') as any;
const { createBlock } = fromVm('@ethereumjs/block') as any;
const { Common, Mainnet, Hardfork } = fromVm('@ethereumjs/common') as any;

const compiled = compile([EXECUTOR_SOURCE, MOCKS_SOURCE]);
const DEPLOYER = '0x' + '11'.repeat(20), OWNER = '0x' + 'aa'.repeat(20), OPERATOR = '0x' + 'bb'.repeat(20), STRANGER = '0x' + 'cc'.repeat(20);
const UNIT = 10n ** 18n;
const EXECUTE = 'execute((address,address,address,address)[],uint256,uint256,uint256)';
type Hop = readonly [pool: string, factory: string, tokenIn: string, tokenOut: string];

interface CallResult { ok: boolean; data: string; logs: { address: string; topics: string[]; data: string }[] }

async function world() {
  const common = new Common({ chain: Mainnet, hardfork: Hardfork.Cancun });
  const vm = await createVM({ common });
  let blockNumber = 100n;
  async function call(from: string, to: string | null, data: string): Promise<CallResult & { created: string | null }> {
    const result = await vm.evm.runCall({
      caller: util.createAddressFromString(from), ...(to ? { to: util.createAddressFromString(to) } : {}), data: util.hexToBytes(data), gasLimit: 30_000_000n,
      block: createBlock({ header: { number: blockNumber } }, { common }),
    });
    const exec = result.execResult;
    return {
      ok: exec.exceptionError === undefined, data: util.bytesToHex(exec.returnValue), created: result.createdAddress ? String(result.createdAddress) : null,
      logs: (exec.logs ?? []).map((log: [Uint8Array, Uint8Array[], Uint8Array]) => ({ address: util.bytesToHex(log[0]), topics: log[1].map((topic: Uint8Array) => util.bytesToHex(topic)), data: util.bytesToHex(log[2]) })),
    };
  }
  async function deploy(name: string, types: readonly AbiType[] = [], values: readonly AbiValue[] = []): Promise<string> {
    const made = await call(DEPLOYER, null, compiled.get(name)!.creation + abiEncode(types, values).slice(2));
    assert.ok(made.ok && made.created, `部署 ${name} 失败`);
    return made.created!;
  }
  async function send(from: string, to: string, signature: string, types: readonly AbiType[] = [], values: readonly AbiValue[] = []): Promise<CallResult> {
    return call(from, to, callData(signature, types, values));
  }
  async function must(to: string, signature: string, types: readonly AbiType[] = [], values: readonly AbiValue[] = []): Promise<void> {
    assert.ok((await send(DEPLOYER, to, signature, types, values)).ok, `${signature} 失败`);
  }
  const balance = async (token: string, account: string): Promise<bigint> => new AbiReader((await send(DEPLOYER, token, 'balanceOf(address)', ['address'], [account])).data).uint(0);
  const code = async (address: string): Promise<string> => util.bytesToHex(await vm.stateManager.getCode(util.createAddressFromString(address)));

  // 两种代币（b 的 transfer 不返回值），三个工厂各一种池子。
  const a = await deploy('MockToken', ['bool'], [false]), b = await deploy('MockToken', ['bool'], [true]);
  const v3Factory = await deploy('MockFactory'), slipFactory = await deploy('MockFactory'), aeroFactory = await deploy('MockFactory');
  const v3Pool = await deploy('MockV3Pool', ['address', 'address', 'uint', 'int'], [a, b, 500n, 10n]);
  const slipPool = await deploy('MockV3Pool', ['address', 'address', 'uint', 'int'], [a, b, 400n, 100n]);
  const aeroPool = await deploy('MockAeroPool', ['address', 'address', 'uint'], [a, b, 30n]);
  await must(v3Factory, 'registerFee(address)', ['address'], [v3Pool]);
  await must(slipFactory, 'registerSpacing(address)', ['address'], [slipPool]);
  await must(aeroFactory, 'registerPool(address)', ['address'], [aeroPool]);
  async function fund(pool: string, amountA: bigint, amountB: bigint): Promise<void> {
    await must(a, 'mint(address,uint256)', ['address', 'uint'], [pool, amountA]);
    await must(b, 'mint(address,uint256)', ['address', 'uint'], [pool, amountB]);
    await must(pool, 'sync()');
  }
  const made = await call(DEPLOYER, null, EXECUTOR_CREATION_CODE + abiEncode(['address', 'address', { array: 'address' }, { array: 'uint' }],
    [OWNER, OPERATOR, [v3Factory, slipFactory, aeroFactory], [BigInt(KIND_V3), BigInt(KIND_SLIPSTREAM), BigInt(KIND_AERO_V2)]]).slice(2));
  assert.ok(made.ok && made.created, '部署执行合约失败');
  const executor = made.created!;
  const execute = (from: string, hops: readonly Hop[], amountIn: bigint, minProfit = 0n, deadline = 1_000n): Promise<CallResult> =>
    send(from, executor, EXECUTE, [{ array: { tuple: ['address', 'address', 'address', 'address'] } }, 'uint', 'uint', 'uint'], [hops.map(hop => [...hop]), amountIn, minProfit, deadline]);
  return {
    a, b, v3Factory, slipFactory, aeroFactory, v3Pool, slipPool, aeroPool, executor, call, deploy, send, must, balance, code, fund, execute,
    setBlock(value: bigint): void { blockNumber = value; },
  };
}
const errorOf = (result: CallResult): string => result.data.slice(0, 10);

test('入库的编译产物与合约源码一致（改了合约须重新运行 node scripts/mev-compile.ts）', () => {
  const built = compiled.get('MevExecutor')!;
  assert.equal(EXECUTOR_SOURCE_SHA256, sourceHash(readSource(EXECUTOR_SOURCE)), `${ARTIFACT_FILE} 记的源码摘要与 ${EXECUTOR_SOURCE} 不符`);
  assert.equal(EXECUTOR_CREATION_CODE, built.creation);
  assert.equal(EXECUTOR_RUNTIME_CODE, built.runtime);
  assert.deepEqual([...EXECUTOR_OWNER_OFFSETS], built.immutables);
  assert.ok(EXECUTOR_OWNER_OFFSETS.length > 0);
});

test('部署数据：链上代码等于按 owner 填好的预期代码，工厂表按登记写入', async () => {
  const w = await world();
  assert.equal(await w.code(w.executor), expectedRuntimeCode(OWNER));
  assert.notEqual(await w.code(w.executor), expectedRuntimeCode(STRANGER));
  const made = await w.call(DEPLOYER, null, deploymentData(OWNER, OPERATOR));
  assert.ok(made.ok && made.created);
  assert.equal(await w.code(made.created!), expectedRuntimeCode(OWNER));
  for (const factory of FACTORIES) assert.equal(new AbiReader((await w.send(DEPLOYER, made.created!, 'factoryKind(address)', ['address'], [factory.address])).data).uint(0), BigInt(factory.kind));
  assert.equal(new AbiReader((await w.send(DEPLOYER, made.created!, 'operator()')).data).address(0), OPERATOR);
  assert.equal(new AbiReader((await w.send(DEPLOYER, made.created!, 'owner()')).data).address(0), OWNER);
  assert.throws(() => deploymentData(OWNER, OWNER), /不能是同一个地址/);
  assert.throws(() => deploymentData('0x' + '0'.repeat(40), OPERATOR), /零地址/);
  assert.throws(() => deploymentData('0x12', OPERATOR), /40 位/);
});

test('两个 v3 式池子之间有价差：闪电兑换走完一圈，利润全数转给 owner，合约不留余额', async () => {
  const w = await world();
  await w.fund(w.v3Pool, 1_000n * UNIT, 1_000n * UNIT);
  await w.fund(w.slipPool, 1_000n * UNIT, 1_100n * UNIT);
  // a 在 slipPool 换出更多 b，再到 v3Pool 换回 a。
  const hops: Hop[] = [[w.slipPool, w.slipFactory, w.a, w.b], [w.v3Pool, w.v3Factory, w.b, w.a]];
  const result = await w.execute(OPERATOR, hops, 10n * UNIT);
  assert.ok(result.ok, `execute 回滚：${result.data}`);
  const profit = new AbiReader(result.data).uint(0);
  assert.ok(profit > UNIT / 2n && profit < UNIT, `利润 ${profit} 不在预期范围`);
  assert.equal(await w.balance(w.a, OWNER), profit);
  assert.equal(await w.balance(w.a, w.executor), 0n);
  assert.equal(await w.balance(w.b, w.executor), 0n);
  const log = result.logs.find(entry => entry.topics[0] === EXECUTED_TOPIC);
  assert.ok(log && log.address === w.executor);
  assert.equal(new AbiReader(log!.data).uint(0), 10n * UNIT);
  assert.equal(new AbiReader(log!.data).uint(32), profit);
});

test('不赚钱或赚得不到 minProfit 时整笔回滚，池子与账户余额不变', async () => {
  const w = await world();
  await w.fund(w.v3Pool, 1_000n * UNIT, 1_000n * UNIT);
  await w.fund(w.slipPool, 1_000n * UNIT, 1_100n * UNIT);
  const forward: Hop[] = [[w.slipPool, w.slipFactory, w.a, w.b], [w.v3Pool, w.v3Factory, w.b, w.a]];
  const backward: Hop[] = [[w.v3Pool, w.v3Factory, w.a, w.b], [w.slipPool, w.slipFactory, w.b, w.a]];
  const before = [await w.balance(w.a, w.slipPool), await w.balance(w.b, w.slipPool), await w.balance(w.a, w.v3Pool), await w.balance(w.b, w.v3Pool)];
  // 反方向是亏的：第一跳的池子收不回借出的数量，或余额核对不过，总之回滚。
  assert.equal((await w.execute(OPERATOR, backward, 10n * UNIT)).ok, false);
  const tooGreedy = await w.execute(OPERATOR, forward, 10n * UNIT, 5n * UNIT);
  assert.equal(tooGreedy.ok, false);
  assert.equal(errorOf(tooGreedy), selector('NoProfit(uint256,uint256)'));
  assert.deepEqual([await w.balance(w.a, w.slipPool), await w.balance(w.b, w.slipPool), await w.balance(w.a, w.v3Pool), await w.balance(w.b, w.v3Pool)], before);
  assert.equal(await w.balance(w.a, OWNER), 0n);
  // 回滚之后同一条路仍然能做（没有留下「执行中」的状态）。
  assert.ok((await w.execute(OPERATOR, forward, 10n * UNIT, UNIT / 2n)).ok);
});

test('Aerodrome v2 式池子：作第一跳（hook 回调）与作后面的跳都能走通；b 的 transfer 不返回值也接受', async () => {
  const w = await world();
  await w.fund(w.v3Pool, 1_000n * UNIT, 1_000n * UNIT);
  await w.fund(w.aeroPool, 1_000n * UNIT, 1_100n * UNIT);
  const first = await w.execute(OPERATOR, [[w.aeroPool, w.aeroFactory, w.a, w.b], [w.v3Pool, w.v3Factory, w.b, w.a]], 5n * UNIT);
  assert.ok(first.ok, `v2 作第一跳回滚：${first.data}`);
  const gained = await w.balance(w.a, OWNER);
  assert.equal(gained, new AbiReader(first.data).uint(0));
  assert.ok(gained > 0n);
  // 起始代币换成 b，v2 池子在第二跳：b 在 v3Pool 换 a，再到 aeroPool 换回更多的 b。
  const second = await w.execute(OPERATOR, [[w.v3Pool, w.v3Factory, w.b, w.a], [w.aeroPool, w.aeroFactory, w.a, w.b]], 5n * UNIT);
  assert.ok(second.ok, `v2 作第二跳回滚：${second.data}`);
  assert.equal(await w.balance(w.b, OWNER), new AbiReader(second.data).uint(0));
  assert.equal(await w.balance(w.a, w.executor), 0n);
  assert.equal(await w.balance(w.b, w.executor), 0n);
});

test('只有热钱包能调 execute；过了截止区块、路径不成环、跳数不对都拒绝', async () => {
  const w = await world();
  await w.fund(w.v3Pool, 1_000n * UNIT, 1_000n * UNIT);
  await w.fund(w.slipPool, 1_000n * UNIT, 1_100n * UNIT);
  const hops: Hop[] = [[w.slipPool, w.slipFactory, w.a, w.b], [w.v3Pool, w.v3Factory, w.b, w.a]];
  for (const caller of [STRANGER, OWNER, DEPLOYER]) assert.equal(errorOf(await w.execute(caller, hops, UNIT)), selector('NotOperator()'));
  w.setBlock(500n);
  assert.equal(errorOf(await w.execute(OPERATOR, hops, UNIT, 0n, 499n)), selector('Expired()'));
  assert.ok((await w.execute(OPERATOR, hops, UNIT, 0n, 500n)).ok, '截止区块当块仍可执行');
  assert.equal(errorOf(await w.execute(OPERATOR, [hops[0]!], UNIT)), selector('BadPath()'));
  assert.equal(errorOf(await w.execute(OPERATOR, [hops[0]!, hops[0]!], UNIT)), selector('BadPath()'));
  assert.equal(errorOf(await w.execute(OPERATOR, [hops[0]!, [w.v3Pool, w.v3Factory, w.a, w.b]], UNIT)), selector('BadPath()'));
  assert.equal(errorOf(await w.execute(OPERATOR, hops, 0n)), selector('BadPath()'));
  assert.equal(errorOf(await w.execute(OPERATOR, [...hops, ...hops, hops[0]!], UNIT)), selector('BadPath()'));
});

test('工厂没登记、不是该工厂创建、代币对不上的池子一律不用', async () => {
  const w = await world();
  await w.fund(w.v3Pool, 1_000n * UNIT, 1_000n * UNIT);
  await w.fund(w.slipPool, 1_000n * UNIT, 1_100n * UNIT);
  const good: Hop = [w.v3Pool, w.v3Factory, w.b, w.a];
  // 一个没人登记过的工厂，和一个不在工厂里的同类池子。
  const rogueFactory = await w.deploy('MockFactory');
  const roguePool = await w.deploy('MockV3Pool', ['address', 'address', 'uint', 'int'], [w.a, w.b, 500n, 100n]);
  await w.fund(roguePool, 1_000n * UNIT, 2_000n * UNIT);
  await w.must(rogueFactory, 'registerSpacing(address)', ['address'], [roguePool]);
  assert.equal(errorOf(await w.execute(OPERATOR, [[roguePool, rogueFactory, w.a, w.b], good], UNIT)), selector('BadPool()'));
  assert.equal(errorOf(await w.execute(OPERATOR, [[roguePool, w.slipFactory, w.a, w.b], good], UNIT)), selector('BadPool()'));
  assert.equal(errorOf(await w.execute(OPERATOR, [[roguePool, w.aeroFactory, w.a, w.b], good], UNIT)), selector('BadPool()'));
  // 工厂种类与池子不符（v3 池子挂在 Slipstream 工厂名下）。
  assert.equal(errorOf(await w.execute(OPERATOR, [[w.v3Pool, w.slipFactory, w.a, w.b], [w.slipPool, w.slipFactory, w.b, w.a]], UNIT)), selector('BadPool()'));
  // 这一跳写的代币不是池子的两种代币。
  const c = await w.deploy('MockToken', ['bool'], [false]);
  assert.equal(errorOf(await w.execute(OPERATOR, [[w.slipPool, w.slipFactory, c, w.b], [w.v3Pool, w.v3Factory, w.b, c]], UNIT)), selector('BadPool()'));
  // owner 登记这个工厂之后才可用。
  assert.equal(errorOf(await w.send(STRANGER, w.executor, 'setFactory(address,uint8)', ['address', 'uint'], [rogueFactory, 2n])), selector('NotOwner()'));
  assert.ok((await w.send(OWNER, w.executor, 'setFactory(address,uint8)', ['address', 'uint'], [rogueFactory, 2n])).ok);
  assert.ok((await w.execute(OPERATOR, [[roguePool, rogueFactory, w.a, w.b], good], UNIT)).ok);
});

test('不在兑换中时谁调回调都拒绝，合约里的代币拿不走；owner 才能取回与换热钱包', async () => {
  const w = await world();
  await w.must(w.a, 'mint(address,uint256)', ['address', 'uint'], [w.executor, 7n * UNIT]);
  const evil = await w.deploy('EvilPool');
  const payload = abiEncode([{ array: { tuple: ['address', 'address', 'address', 'address'] } }, 'address', 'uint'], [[], w.a, UNIT]);
  for (const method of ['callSwapCallback(address,bytes)', 'callHook(address,bytes)']) {
    const result = await w.send(STRANGER, evil, method, ['address', 'bytes'], [w.executor, payload]);
    assert.equal(result.ok, false);
    assert.equal(errorOf(result), selector('BadCallback()'));
  }
  const direct = await w.send(STRANGER, w.executor, 'uniswapV3SwapCallback(int256,int256,bytes)', ['int', 'int', 'bytes'], [UNIT, -1n, payload]);
  assert.equal(errorOf(direct), selector('BadCallback()'));
  assert.equal(await w.balance(w.a, w.executor), 7n * UNIT);
  // 热钱包也不能取回或换人。
  assert.equal(errorOf(await w.send(OPERATOR, w.executor, 'rescue(address)', ['address'], [w.a])), selector('NotOwner()'));
  assert.equal(errorOf(await w.send(OPERATOR, w.executor, 'setOperator(address)', ['address'], [STRANGER])), selector('NotOwner()'));
  assert.ok((await w.send(OWNER, w.executor, 'rescue(address)', ['address'], [w.a])).ok);
  assert.equal(await w.balance(w.a, OWNER), 7n * UNIT);
  assert.equal(await w.balance(w.a, w.executor), 0n);
  // 换掉热钱包后旧的立即失效；设为零地址即停用。
  await w.fund(w.v3Pool, 1_000n * UNIT, 1_000n * UNIT);
  await w.fund(w.slipPool, 1_000n * UNIT, 1_100n * UNIT);
  const hops: Hop[] = [[w.slipPool, w.slipFactory, w.a, w.b], [w.v3Pool, w.v3Factory, w.b, w.a]];
  assert.ok((await w.send(OWNER, w.executor, 'setOperator(address)', ['address'], [STRANGER])).ok);
  assert.equal(errorOf(await w.execute(OPERATOR, hops, UNIT)), selector('NotOperator()'));
  assert.ok((await w.execute(STRANGER, hops, UNIT)).ok);
  assert.ok((await w.send(OWNER, w.executor, 'setOperator(address)', ['address'], ['0x' + '0'.repeat(40)])).ok);
  assert.equal(errorOf(await w.execute(STRANGER, hops, UNIT)), selector('NotOperator()'));
});
