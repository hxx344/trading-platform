// 池子目录与逐区块状态读取（docs/mev.md 第 2 节）。都经 Multicall3 批量 eth_call，只读。
// 现货价只用来粗筛环路；是否下单由 simulate.ts 用执行合约的 eth_call 结果决定。
import { AbiReader, callData, decodeAggregate3, selector, lower, type Hex } from './codec.ts';
import { FACTORIES, KIND_AERO_V2, KIND_SLIPSTREAM, KIND_V2, KIND_V3, MULTICALL3, START_TOKENS, type FactoryInfo, type PoolKind, type TokenInfo } from './chain.ts';
import type { RpcClient } from './rpc.ts';

export interface Pool {
  address: string;
  factory: string;
  kind: PoolKind;
  token0: string;
  token1: string;
  /** 手续费，百万分比。 */
  feePpm: number;
}

export interface PoolState {
  /** token1 对 token0 的现货价（最小单位之比）。 */
  price: number;
  /** 当前价附近的虚拟储备（最小单位），用来估深度；v2 就是真实储备。 */
  reserve0: number;
  reserve1: number;
}

const ZERO = '0x' + '0'.repeat(40);
const AGGREGATE3 = 'aggregate3((address,bool,bytes)[])';
/** 每个 Multicall 里的子调用数上限：公共节点对 eth_call 的 gas 与应答大小有限制。 */
export const MULTICALL_CHUNK = 300;
/** 每个 HTTP 批量请求最多带几块 Multicall。 */
export const BATCH_CHUNKS = 8;
export const MAX_TOKENS = 32;
/** 目录里最多留的池子数（按深度从高到低，见 engine.ts）：每区块都要读它们的状态。 */
export const MAX_POOLS = 600;
/** 恒定乘积池子（Aerodrome v2 与 v2 类）：状态是储备，读 getReserves。 */
export const isReservePool = (kind: PoolKind): boolean => kind === KIND_AERO_V2 || kind === KIND_V2;

interface SubCall { target: string; data: Hex }
type SubResult = { success: boolean; data: Hex };

/** 把子调用分块发出；`block` 固定读取的区块，同一轮的各块读到同一个状态。 */
export async function multicall(rpc: RpcClient, calls: readonly SubCall[], block: string, timeoutMs?: number): Promise<SubResult[]> {
  const chunks: SubCall[][] = [];
  for (let index = 0; index < calls.length; index += MULTICALL_CHUNK) chunks.push(calls.slice(index, index + MULTICALL_CHUNK));
  // 目录查询有几十块：每个 HTTP 批量请求最多带 BATCH_CHUNKS 块，依次发出，单个应答不超过节点与本地的大小上限。
  const outcomes: Awaited<ReturnType<RpcClient['batch']>> = [];
  for (let index = 0; index < chunks.length; index += BATCH_CHUNKS) {
    outcomes.push(...await rpc.batch(chunks.slice(index, index + BATCH_CHUNKS).map(chunk => ({
      method: 'eth_call',
      params: [{ to: MULTICALL3, data: callData(AGGREGATE3, [{ array: { tuple: ['address', 'bool', 'bytes'] } }], [chunk.map(call => [call.target, true, call.data])]) }, block],
    })), timeoutMs));
  }
  return outcomes.flatMap((entry, index) => {
    if (!entry.ok) throw entry.error;
    if (typeof entry.result !== 'string') throw new RangeError('Multicall 应答不是十六进制文本');
    return decodeAggregate3(entry.result, chunks[index]!.length);
  });
}

const word = (result: SubResult, offset = 0): bigint | null => {
  if (!result.success) return null;
  try { return new AbiReader(result.data).uint(offset); } catch { return null; }
};

/** 从链上读一个代币的符号与精度；读不到（没有代码、不是 ERC-20）返回 null。 */
export async function readToken(rpc: RpcClient, address: string): Promise<TokenInfo | null> {
  const [decimals, symbol] = await multicall(rpc, [{ target: address, data: selector('decimals()') }, { target: address, data: selector('symbol()') }], 'latest');
  const places = word(decimals!);
  if (places === null || places > 36n || !symbol!.success) return null;
  let text: string;
  try {
    const reader = new AbiReader(symbol!.data);
    text = Buffer.from(reader.bytesAt(reader.index(0)).slice(2), 'hex').toString('utf8');
  } catch { return null; }
  // 符号只用于显示：去掉控制字符并截短，页面按文本渲染。
  const clean = text.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 16);
  return clean ? { address: lower(address), symbol: clean, decimals: Number(places) } : null;
}

/** 按白名单代币两两组合向各工厂查询池子，再读每个池子的费率。返回的池子两种代币都在白名单里。 */
export async function discoverPools(rpc: RpcClient, tokens: readonly string[], factories: readonly FactoryInfo[] = FACTORIES, timeoutMs = 10_000): Promise<Pool[]> {
  // 超过上限时先保留起始代币（WETH、USDC 是环路起点与美元定价的锚），再按传入顺序取。
  const starts = START_TOKENS.map(token => token.address), unique = [...new Set(tokens.map(lower))];
  const list = [...starts.filter(address => unique.includes(address)), ...unique.filter(address => !starts.includes(address))].slice(0, MAX_TOKENS).sort();
  const queries: { call: SubCall; factory: FactoryInfo; token0: string; token1: string }[] = [];
  for (let left = 0; left < list.length; left++) for (let right = left + 1; right < list.length; right++) {
    const token0 = list[left]!, token1 = list[right]!;
    for (const factory of factories) {
      const push = (data: Hex) => queries.push({ call: { target: factory.address, data }, factory, token0, token1 });
      if (factory.kind === KIND_V3) for (const tier of factory.tiers) push(callData('getPool(address,address,uint24)', ['address', 'address', 'uint'], [token0, token1, tier]));
      else if (factory.kind === KIND_SLIPSTREAM) for (const tier of factory.tiers) push(callData('getPool(address,address,int24)', ['address', 'address', 'int'], [token0, token1, tier]));
      else if (factory.kind === KIND_V2) push(callData('getPair(address,address)', ['address', 'address'], [token0, token1]));
      else push(callData('getPool(address,address,bool)', ['address', 'address', 'bool'], [token0, token1, false]));
    }
  }
  const found = await multicall(rpc, queries.map(query => query.call), 'latest', timeoutMs);
  const candidates: (Omit<Pool, 'feePpm'> & { feeBps: number })[] = [];
  const seen = new Set<string>();
  found.forEach((result, index) => {
    if (!result.success) return;
    let address: string;
    try { address = new AbiReader(result.data).address(0); } catch { return; }
    if (address === ZERO || seen.has(address)) return;
    seen.add(address);
    const { factory, token0, token1 } = queries[index]!;
    candidates.push({ address, factory: factory.address, kind: factory.kind, token0, token1, feeBps: factory.feeBps });
  });
  // v3 式与 Slipstream 读池子自己的 fee()（Slipstream 的费率可调）；Aerodrome v2 读工厂的 getFee（万分比）；v2 类的费率是
  // 池子代码里的常数，用登记表里的值（与部署时登记进执行合约的一致），这一项读 token0() 占位。同时核对池子自报的两种代币。
  const details = await multicall(rpc, candidates.flatMap(pool => [
    pool.kind === KIND_AERO_V2 ? { target: pool.factory, data: callData('getFee(address,bool)', ['address', 'bool'], [pool.address, false]) }
      : { target: pool.address, data: selector(pool.kind === KIND_V2 ? 'token0()' : 'fee()') },
    { target: pool.address, data: selector('token0()') },
    { target: pool.address, data: selector('token1()') },
  ]), 'latest', timeoutMs);
  const pools: Pool[] = [];
  candidates.forEach((pool, index) => {
    const fee = word(details[index * 3]!), token0 = word(details[index * 3 + 1]!), token1 = word(details[index * 3 + 2]!);
    if (fee === null || token0 === null || token1 === null) return;
    if (token0 !== BigInt(pool.token0) || token1 !== BigInt(pool.token1)) return;
    const feePpm = pool.kind === KIND_V2 ? pool.feeBps * 100 : pool.kind === KIND_AERO_V2 ? Number(fee) * 100 : Number(fee);
    // 费率不合常理（≥ 10%）的池子不用。
    if (!(feePpm >= 0 && feePpm < 100_000)) return;
    const { feeBps: _feeBps, ...rest } = pool;
    pools.push({ ...rest, feePpm });
  });
  // 不在这里截断：截哪些取决于查询顺序而不是深度。引擎读一次状态后按深度筛到 MAX_POOLS。
  return pools;
}

const Q96 = 2 ** 96;

/** 读一批池子在 `block` 的状态；读不到或没有流动性的池子不在结果里。 */
export async function readPoolStates(rpc: RpcClient, pools: readonly Pool[], block: string, timeoutMs?: number): Promise<Map<string, PoolState>> {
  const calls = pools.flatMap(pool => isReservePool(pool.kind)
    ? [{ target: pool.address, data: selector('getReserves()') }]
    : [{ target: pool.address, data: selector('slot0()') }, { target: pool.address, data: selector('liquidity()') }]);
  const results = await multicall(rpc, calls, block, timeoutMs);
  const states = new Map<string, PoolState>();
  let cursor = 0;
  for (const pool of pools) {
    if (isReservePool(pool.kind)) {
      const result = results[cursor++]!, reserve0 = word(result, 0), reserve1 = word(result, 32);
      if (reserve0 && reserve1) states.set(pool.address, { price: Number(reserve1) / Number(reserve0), reserve0: Number(reserve0), reserve1: Number(reserve1) });
      continue;
    }
    const sqrtPrice = word(results[cursor++]!, 0), liquidity = word(results[cursor++]!, 0);
    if (!sqrtPrice || !liquidity) continue;
    const root = Number(sqrtPrice) / Q96, depth = Number(liquidity);
    if (!(root > 0) || !Number.isFinite(root)) continue;
    states.set(pool.address, { price: root * root, reserve0: depth / root, reserve1: depth * root });
  }
  return states;
}
