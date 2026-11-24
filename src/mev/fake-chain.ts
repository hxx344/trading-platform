// 替身 Base 节点：给引擎测试与页面预览（scripts/dev-mev.ts）用，不联网。它按 JSON-RPC 应答引擎会发的请求：
// 链号、合约代码与只读方法、Multicall3（代币、工厂、池子状态）、execute 的模拟与 gas 估算、区块、账户、回执、发送。
// 池子只有现货状态，没有曲线：一条环路模拟出多少利润由调用方的 `profit` 决定。
import { keccak256 } from '../aster/eip712.ts';
import { AbiReader, abiEncode, bytesOf, callData, hexOf, lower, selector, toQuantity, type Hex } from './codec.ts';
import { FACTORIES, GAS_PRICE_ORACLE, KIND_AERO_V2, KIND_SLIPSTREAM, KIND_V3, MULTICALL3, type FactoryInfo, type TokenInfo } from './chain.ts';
import { expectedRuntimeCode } from './engine.ts';
import type { FetchLike } from './rpc.ts';
import { EXECUTED_TOPIC } from './simulate.ts';

export interface FakePool {
  address: string; factory: FactoryInfo; token0: string; token1: string;
  /** v3 的费率档或 Slipstream 的 tickSpacing；v2 不用。 */
  tier?: bigint;
  /** fee()（百万分比）或工厂 getFee（万分比）的返回值。 */
  fee: bigint;
  /** token1 对 token0 的现货价（最小单位之比）。 */
  price: number;
  /** v2：token0 的储备（最小单位）；v3 / Slipstream：liquidity。 */
  depth: number;
}
export interface FakeExecute { /** 第一跳的输入代币，即环路的起始代币。 */ start: string; pools: string[]; amountIn: bigint; minProfit: bigint; deadlineBlock: bigint }
export interface FakeReceipt { status: 'success' | 'reverted'; block: number; gasUsed: bigint; gasPrice: bigint; l1Fee: bigint; profit: bigint }

export interface FakeChainOptions {
  executor: string; owner: string; operator: string;
  tokens: readonly TokenInfo[];
  pools: readonly FakePool[];
  now?: () => number;
  /** 一次 execute 模拟的净增量；null 表示回滚。默认全部回滚（没有机会）。 */
  profit?: (call: FakeExecute) => bigint | null;
}

const word = (value: bigint): Hex => '0x' + value.toString(16).padStart(64, '0');
const hashOf = (raw: string): string => hexOf(keccak256(bytesOf(raw)));
const sqrtX96 = (price: number): bigint => BigInt(Math.floor(Math.sqrt(price) * 2 ** 48)) << 48n;

export function createFakeChain(options: FakeChainOptions) {
  const now = options.now ?? Date.now;
  const executor = lower(options.executor), owner = lower(options.owner), operator = lower(options.operator);
  const tokens = new Map(options.tokens.map(token => [lower(token.address), token]));
  const pools = new Map(options.pools.map(pool => [lower(pool.address), pool]));
  const lookups = new Map<string, string>();
  for (const pool of options.pools) {
    const { factory } = pool, pair = [lower(pool.token0), lower(pool.token1)] as const;
    const data = factory.kind === KIND_V3 ? callData('getPool(address,address,uint24)', ['address', 'address', 'uint'], [...pair, pool.tier ?? 0n])
      : factory.kind === KIND_SLIPSTREAM ? callData('getPool(address,address,int24)', ['address', 'address', 'int'], [...pair, pool.tier ?? 0n])
        : callData('getPool(address,address,bool)', ['address', 'address', 'bool'], [...pair, false]);
    lookups.set(`${factory.address}:${data}`, lower(pool.address));
  }
  const state = {
    chainId: 8453n, block: 1_000, timestamp: Math.floor(now() / 1000), baseFee: 5_000_000n, nonce: 0, balance: 10n ** 16n,
    /** 链上的 operator；测试里改成别的地址模拟配置不符。 */
    operator,
    /** 执行合约是否已在链上；测试页面启用时先置 false，部署「上链」后置 true。 */
    deployed: true,
    /** 置为文本时所有请求以 HTTP 503 失败。 */
    down: false,
    /** 发送的处理方式：accept 收下；reject 由节点拒绝；drop 传输失败（结果不明）。 */
    send: 'accept' as 'accept' | 'reject' | 'drop',
    sent: [] as { raw: string; hash: string }[],
    receipts: new Map<string, FakeReceipt>(),
    calls: [] as string[],
    profit: options.profit ?? (() => null),
  };

  /** 出一个新区块（时间戳跟随时钟）。 */
  function advance(blocks = 1): void { state.block += blocks; state.timestamp = Math.floor(now() / 1000); }
  /** 让一笔已发送的交易在当前区块上链，占用它的 nonce。 */
  function mine(hash: string, status: 'success' | 'reverted', detail: Partial<Omit<FakeReceipt, 'status' | 'block'>> = {}): void {
    state.receipts.set(hash, { status, block: state.block, gasUsed: 400_000n, gasPrice: state.baseFee + 1_000_000n, l1Fee: 2_000_000_000n, profit: 0n, ...detail });
    state.nonce++;
  }

  function decodeExecute(data: string): FakeExecute {
    const reader = new AbiReader('0x' + data.slice(10)), start = reader.index(0), count = reader.index(start);
    return {
      start: reader.address(start + 32 + 64),
      pools: Array.from({ length: count }, (_, index) => reader.address(start + 32 + index * 128)),
      amountIn: reader.uint(32), minProfit: reader.uint(64), deadlineBlock: reader.uint(96),
    };
  }

  function subcall(target: string, data: string): Hex | null {
    const name = data.slice(0, 10), token = tokens.get(target), pool = pools.get(target);
    if (token) {
      if (name === selector('decimals()')) return word(BigInt(token.decimals));
      if (name === selector('symbol()')) return abiEncode(['bytes'], [hexOf(new TextEncoder().encode(token.symbol))]);
      return null;
    }
    if (pool) {
      if (name === selector('token0()')) return word(BigInt(pool.token0));
      if (name === selector('token1()')) return word(BigInt(pool.token1));
      if (pool.factory.kind === KIND_AERO_V2) return name === selector('getReserves()') ? abiEncode(['uint', 'uint', 'uint'], [BigInt(Math.floor(pool.depth)), BigInt(Math.floor(pool.depth * pool.price)), BigInt(state.timestamp)]) : null;
      if (name === selector('fee()')) return word(pool.fee);
      if (name === selector('slot0()')) return abiEncode(['uint', 'int', 'uint'], [sqrtX96(pool.price), 0n, 0n]);
      if (name === selector('liquidity()')) return word(BigInt(Math.floor(pool.depth)));
      return null;
    }
    const factory = FACTORIES.find(entry => entry.address === target);
    if (factory) {
      if (name === selector('getFee(address,bool)')) { const found = pools.get(new AbiReader('0x' + data.slice(10)).address(0)); return found ? word(found.fee) : null; }
      return word(BigInt(lookups.get(`${target}:${data}`) ?? '0x0'));
    }
    return null;
  }

  function aggregate(data: string): Hex {
    const reader = new AbiReader('0x' + data.slice(10)), start = reader.index(0), count = reader.index(start), base = start + 32;
    const results = Array.from({ length: count }, (_, index) => {
      const item = base + reader.index(base + index * 32);
      const answer = subcall(reader.address(item), reader.bytesAt(item + reader.index(item + 64)));
      return [answer !== null, answer ?? '0x'];
    });
    return abiEncode([{ array: { tuple: ['bool', 'bytes'] } }], [results]);
  }

  const reverted = { code: 3, message: 'execution reverted', data: selector('TransferFailed()') };
  function call(params: readonly unknown[]): { result: unknown } | { error: unknown } {
    const { to, data } = params[0] as { to: string; data: string }, target = lower(to), name = data.slice(0, 10);
    if (target === MULTICALL3) return { result: aggregate(data) };
    if (target === GAS_PRICE_ORACLE) return { result: word(2_000_000_000n) };
    if (target !== executor) return { result: '0x' };
    if (name === selector('owner()')) return { result: word(BigInt(owner)) };
    if (name === selector('operator()')) return { result: word(BigInt(state.operator)) };
    if (name === selector('factoryKind(address)')) { const factory = FACTORIES.find(entry => entry.address === new AbiReader('0x' + data.slice(10)).address(0)); return { result: word(BigInt(factory?.kind ?? 0)) }; }
    const profit = state.profit(decodeExecute(data));
    return profit === null || profit <= 0n ? { error: reverted } : { result: word(profit) };
  }

  function receipt(hash: string): unknown {
    const entry = state.receipts.get(hash);
    if (!entry) return null;
    return {
      transactionHash: hash, status: entry.status === 'success' ? '0x1' : '0x0', blockNumber: toQuantity(entry.block), gasUsed: toQuantity(entry.gasUsed), effectiveGasPrice: toQuantity(entry.gasPrice), l1Fee: toQuantity(entry.l1Fee),
      logs: entry.status === 'success' ? [{ address: executor, topics: [EXECUTED_TOPIC, word(0n)], data: abiEncode(['uint', 'uint'], [0n, entry.profit]) }] : [],
    };
  }

  function handle(method: string, params: readonly unknown[]): { result: unknown } | { error: unknown } {
    state.calls.push(method);
    switch (method) {
      case 'eth_chainId': return { result: toQuantity(state.chainId) };
      case 'eth_getCode': return { result: state.deployed && lower(String(params[0])) === executor ? expectedRuntimeCode(owner) : '0x' };
      case 'eth_blockNumber': return { result: toQuantity(state.block) };
      case 'eth_getBlockByNumber': return { result: { number: toQuantity(state.block), timestamp: toQuantity(state.timestamp), baseFeePerGas: toQuantity(state.baseFee) } };
      case 'eth_getTransactionCount': return { result: toQuantity(state.nonce) };
      case 'eth_getBalance': return { result: toQuantity(state.balance) };
      case 'eth_getTransactionReceipt': return { result: receipt(String(params[0])) };
      case 'eth_call': return call(params);
      case 'eth_estimateGas': { if ((params[0] as { to?: unknown }).to === undefined) return { result: toQuantity(2_000_000) }; const answer = call(params); return 'error' in answer ? answer : { result: toQuantity(380_000) }; }
      case 'eth_sendRawTransaction': {
        const raw = String(params[0]), hash = hashOf(raw);
        if (state.send === 'reject') return { error: { code: -32000, message: 'nonce too low' } };
        state.sent.push({ raw, hash });
        return { result: hash };
      }
      default: return { error: { code: -32601, message: 'method not found' } };
    }
  }

  const fetchImpl: FetchLike = async (_url, init) => {
    if (state.down) return new Response('unavailable', { status: 503 });
    const body = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] } | { id: number; method: string; params: unknown[] }[];
    const answer = (entry: { id: number; method: string; params: unknown[] }) => ({ jsonrpc: '2.0', id: entry.id, ...handle(entry.method, entry.params) });
    if (!Array.isArray(body) && body.method === 'eth_sendRawTransaction' && state.send === 'drop') { state.sent.push({ raw: String(body.params[0]), hash: hashOf(String(body.params[0])) }); throw new TypeError('fetch failed'); }
    return Response.json(Array.isArray(body) ? body.map(answer) : answer(body));
  };

  return { fetchImpl, state, advance, mine };
}
