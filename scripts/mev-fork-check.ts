// 在真实链状态上只读核对 MEV 执行合约与发现流程（docs/mev.md）：不部署、不签名、不发交易、不用任何密钥。
// 做法：eth_call 的状态覆盖（state override）把本版本的合约代码放到一个虚构地址上，再照引擎的步骤
// 读池子目录与状态、枚举环路、对现货价差最大的几条环路各模拟一组金额并估 gas。
// 用法：node scripts/mev-fork-check.ts [--rpc <地址>] [--top <条数>] [--min-depth <美元，默认 20000>]。默认用 Base 的公共节点（限流严，只够跑这一次核对）。
import { parseArgs } from 'node:util';
import { abiEncode, bytesOf, hexOf, toQuantity, quantity } from '../src/mev/codec.ts';
import { keccak256 } from '../src/aster/eip712.ts';
import { BASE_CHAIN_ID, DEFAULT_MIDDLE_TOKENS, FACTORIES, START_TOKENS, USDC, WETH, factoryLabel, type TokenInfo } from '../src/mev/chain.ts';
import { enumerateCycles, poolDepthUsd, rankCandidates, tokenPricesUsd } from '../src/mev/cycles.ts';
import { expectedRuntimeCode } from '../src/mev/engine.ts';
import { discoverPools, readPoolStates, readToken } from '../src/mev/pools.ts';
import { createRpc, type RpcClient } from '../src/mev/rpc.ts';
import { estimateCosts, gridSizes, simulateSizes } from '../src/mev/simulate.ts';

const { values } = parseArgs({ options: { rpc: { type: 'string', default: 'https://mainnet.base.org' }, top: { type: 'string', default: '4' }, 'min-depth': { type: 'string', default: '20000' } } });
const EXECUTOR = '0x00000000000000000000000000000000004d4556', OPERATOR = '0x000000000000000000000000000000000000a11c', OWNER = '0x000000000000000000000000000000000000b0b0';

// 合约的存储布局：slot 0 是 operator，slot 1 是 factoryKind 映射，slot 2 是 factoryFee 映射。
const slot = (index: bigint): string => '0x' + index.toString(16).padStart(64, '0');
const override = {
  [EXECUTOR]: {
    code: expectedRuntimeCode(OWNER),
    stateDiff: {
      [slot(0n)]: '0x' + OPERATOR.slice(2).padStart(64, '0'),
      ...Object.fromEntries(FACTORIES.map(factory => [hexOf(keccak256(bytesOf(abiEncode(['address', 'uint'], [factory.address, 1n])))), slot(BigInt(factory.kind))])),
      ...Object.fromEntries(FACTORIES.map(factory => [hexOf(keccak256(bytesOf(abiEncode(['address', 'uint'], [factory.address, 2n])))), slot(BigInt(factory.feeBps))])),
    },
  },
  // 亏损的环路还不上第一跳的输入，会以 TransferFailed 回滚而看不出亏了多少。核对时给虚构合约 100 WETH
  //（WETH9 的 balanceOf 映射在 slot 3），亏损就以 NoProfit 带出前后余额，路径是否走通一目了然。
  [WETH]: { stateDiff: { [hexOf(keccak256(bytesOf(abiEncode(['address', 'uint'], [EXECUTOR, 3n]))))]: slot(100n * 10n ** 18n) } },
};

const base = createRpc({ url: values.rpc!, timeoutMs: 20_000 });
/** 给发往虚构合约的 eth_call / eth_estimateGas 补上状态覆盖。 */
const withOverride = (call: { method: string; params: readonly unknown[] }) => {
  const to = (call.params[0] as { to?: string } | undefined)?.to;
  return (call.method === 'eth_call' || call.method === 'eth_estimateGas') && to === EXECUTOR ? { method: call.method, params: [...call.params, override] } : call;
};
const rpc: RpcClient = { request: (method, params, timeout) => { const call = withOverride({ method, params }); return base.request(call.method, call.params, timeout); }, batch: (calls, timeout) => base.batch(calls.map(withOverride), timeout) };

const out = (line: string) => process.stdout.write(line + '\n');
const chain = quantity(await rpc.request('eth_chainId', []));
if (chain !== BASE_CHAIN_ID) throw new Error(`节点的链号是 ${chain}，不是 Base`);

const tokens = new Map<string, TokenInfo>(START_TOKENS.map(token => [token.address, token]));
for (const address of DEFAULT_MIDDLE_TOKENS) {
  const token = await readToken(rpc, address);
  out(`代币 ${address}：${token ? `${token.symbol}，${token.decimals} 位` : '读不到（不会进白名单）'}`);
  if (token) tokens.set(token.address, token);
}
const pools = await discoverPools(rpc, [...tokens.keys()], FACTORIES, 30_000);
const block = Number(quantity(await rpc.request('eth_blockNumber', []))), tag = toQuantity(block);
const states = await readPoolStates(rpc, pools, tag, 30_000);
const prices = tokenPricesUsd(pools, states, USDC);
const usable = new Set(pools.filter(pool => poolDepthUsd(pool, states.get(pool.address), prices) >= Number(values['min-depth'])).map(pool => pool.address));
const cycles = enumerateCycles(pools, START_TOKENS.map(token => token.address));
out(`区块 ${block}：池子 ${pools.length} 个（${FACTORIES.map(factory => `${factory.label} ${pools.filter(pool => pool.factory === factory.address).length}`).join('、')}），有状态 ${states.size}，深度达标 ${usable.size}，环路 ${cycles.length} 条`);
out(`ETH 价格 ${(prices.get(WETH)! * 1e18).toFixed(2)} 美元`);

// 门槛放到 -100 基点：平时没有正价差，这里要的是让合约在真实池子上把路径走通。只看 WETH 起始的环路（上面给了余额）。
// 除了价差最大的几条，每个工厂再各取一条它作第一跳（闪电兑换与回调）、一条它作后面的跳（先付后换）的环路，每种池子的两条路径都走一遍。
const ranked = rankCandidates(cycles.filter(cycle => cycle.start === WETH), states, usable, -100, cycles.length);
const picked = new Set(ranked.slice(0, Number(values.top)));
for (const factory of FACTORIES) {
  const asFirst = ranked.find(candidate => candidate.cycle.hops[0]!.pool.factory === factory.address);
  const asLater = ranked.find(candidate => candidate.cycle.hops.slice(1).some(hop => hop.pool.factory === factory.address));
  for (const candidate of [asFirst, asLater]) if (candidate) picked.add(candidate);
  if (!asFirst || !asLater) out(`${factory.label}：深度达标的 WETH 环路里没有它作${!asFirst ? '第一跳' : ''}${!asFirst && !asLater ? '与' : ''}${!asLater ? '后面的跳' : ''}的`);
}
const candidates = [...picked];
let passed = 0;
for (const { cycle, edgeBps } of candidates) {
  const start = tokens.get(cycle.start)!, startUsd = prices.get(cycle.start)! * 10 ** start.decimals;
  const path = [cycle.hops[0]!.tokenIn, ...cycle.hops.map(hop => hop.tokenOut)].map(address => tokens.get(address)?.symbol ?? address).join(' → ');
  out(`\n${path}（${cycle.hops.map(hop => factoryLabel(hop.pool.factory)).join('、')}），现货毛收益 ${edgeBps.toFixed(2)} 基点`);
  const target = { executor: EXECUTOR, operator: OPERATOR, cycle, deadlineBlock: BigInt(block + 1_000), block: tag };
  const sizes = gridSizes(startUsd, start.decimals, 5_000);
  const profits = await simulateSizes(rpc, target, sizes, 30_000);
  sizes.forEach((size, index) => {
    const profit = profits[index];
    out(`  输入 ${(Number(size) / 10 ** start.decimals * startUsd).toFixed(0)} 美元：${profit === null || profit === undefined ? '走不通（不是 NoProfit 回滚）' : `净增量 ${(Number(profit) / 10 ** start.decimals * startUsd).toFixed(4)} 美元`}`);
  });
  if (profits.some(profit => profit !== null)) passed++;
  const costs = await estimateCosts(rpc, target, sizes[0]!, BASE_CHAIN_ID, 30_000);
  out(costs ? `  估算 gas ${costs.gas}，L1 数据费 ${costs.l1Fee} wei` : '  估不出 gas（这一刻路径亏损，execute 回滚，属正常）');
}
out(`\n${passed}/${candidates.length} 条环路在真实池子上走通并由合约给出了净增量`);
if (passed !== candidates.length) process.exitCode = 1;
