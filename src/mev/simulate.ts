// 用执行合约的 eth_call 给环路定量（docs/mev.md 第 2 节）：一组输入金额各模拟一次，取净增量最大的一档，
// 再估 gas 与 L1 数据费。eth_call 的 from 是热钱包地址（合约只接受 operator），不签名、不上链。
import { AbiReader, callData, eventTopic, hexOf, selector, unsignedTransaction, concatBytes, quantity, type Hex } from './codec.ts';
import { GAS_PRICE_ORACLE } from './chain.ts';
import type { Cycle } from './cycles.ts';
import { RpcError, type RpcClient } from './rpc.ts';

const EXECUTE = 'execute((address,address,address,address)[],uint256,uint256,uint256)';
const NO_PROFIT = selector('NoProfit(uint256,uint256)');
export const EXECUTED_TOPIC = eventTopic('Executed(address,uint256,uint256)');

export function executeData(cycle: Cycle, amountIn: bigint, minProfit: bigint, deadlineBlock: bigint): Hex {
  return callData(EXECUTE, [{ array: { tuple: ['address', 'address', 'address', 'address'] } }, 'uint', 'uint', 'uint'],
    [cycle.hops.map(hop => [hop.pool.address, hop.pool.factory, hop.tokenIn, hop.tokenOut]), amountIn, minProfit, deadlineBlock]);
}

/** 节点在 eth_call 回滚时给的回滚数据：geth 放在 error.data，有的节点再套一层。 */
function revertData(error: RpcError): Hex | null {
  const data = error.data;
  if (typeof data === 'string' && /^0x[0-9a-fA-F]*$/.test(data)) return data;
  if (data && typeof data === 'object' && typeof (data as { data?: unknown }).data === 'string') return (data as { data: string }).data;
  return null;
}

export interface SimulationTarget { executor: string; operator: string; cycle: Cycle; deadlineBlock: bigint; block: string }

/**
 * 每个金额模拟一次，返回起始代币的净增量：正数是利润；null 是这一档不成立。合约不持有本金，亏损的环路
 * 还不上第一跳的输入，以 TransferFailed 回滚，和流动性不够、池子拒绝一样记为 null。只有合约里恰好有余额时
 * （scripts/mev-fork-check.ts 用状态覆盖给的），亏损才以 NoProfit 带出前后余额，这里返回负数。传输失败整批抛出。
 */
export async function simulateSizes(rpc: RpcClient, target: SimulationTarget, sizes: readonly bigint[], timeoutMs?: number): Promise<(bigint | null)[]> {
  const outcomes = await rpc.batch(sizes.map(size => ({
    method: 'eth_call', params: [{ from: target.operator, to: target.executor, data: executeData(target.cycle, size, 0n, target.deadlineBlock) }, target.block],
  })), timeoutMs);
  return outcomes.map(entry => {
    try {
      if (entry.ok) return typeof entry.result === 'string' ? new AbiReader(entry.result).uint(0) : null;
      const data = revertData(entry.error);
      if (!data || !data.startsWith(NO_PROFIT)) return null;
      const reader = new AbiReader('0x' + data.slice(10));
      return reader.uint(0) - reader.uint(32);
    } catch { return null; }
  });
}

/** 起始代币的一组试算金额：按美元名义从小到大，不超过上限。 */
export function gridSizes(startUsd: number, decimals: number, maxNotionalUsd: number): bigint[] {
  if (!(startUsd > 0)) return [];
  return [50, 150, 500, 1_500, 5_000, 15_000, 50_000, 150_000, 500_000].filter(usd => usd <= maxNotionalUsd)
    .map(usd => BigInt(Math.floor(usd / startUsd * 10 ** decimals))).filter(amount => amount > 0n);
}

/** 在最优一档附近再取几档（不超过上限）。 */
export function refineSizes(best: bigint, maxAmount: bigint): bigint[] {
  return [...new Set([best * 6n / 10n, best * 8n / 10n, best * 5n / 4n, best * 8n / 5n].filter(amount => amount > 0n && amount <= maxAmount && amount !== best))];
}

export interface Sized { amountIn: bigint; profit: bigint }

/** 两轮试算后净增量最大的一档；没有任何一档盈利返回 null。 */
export async function bestSize(rpc: RpcClient, target: SimulationTarget, startUsd: number, decimals: number, maxNotionalUsd: number, timeoutMs?: number): Promise<{ best: Sized | null; tried: { amountIn: bigint; profit: bigint | null }[] }> {
  const grid = gridSizes(startUsd, decimals, maxNotionalUsd);
  const tried: { amountIn: bigint; profit: bigint | null }[] = [];
  let best: Sized | null = null;
  const run = async (sizes: readonly bigint[]) => {
    if (!sizes.length) return;
    const profits = await simulateSizes(rpc, target, sizes, timeoutMs);
    sizes.forEach((amountIn, index) => {
      const profit = profits[index]!;
      tried.push({ amountIn, profit });
      if (profit !== null && profit > 0n && (!best || profit > best.profit)) best = { amountIn, profit };
    });
  };
  await run(grid);
  const first = best as Sized | null;
  if (first) await run(refineSizes(first.amountIn, BigInt(Math.floor(maxNotionalUsd / startUsd * 10 ** decimals))));
  return { best, tried };
}

/** 估一笔 execute 的 gas 与 L1 数据费；估不出（这一刻已经回滚）返回 null。 */
export async function estimateCosts(rpc: RpcClient, target: SimulationTarget, amountIn: bigint, chainId: bigint, timeoutMs?: number): Promise<{ gas: bigint; l1Fee: bigint } | null> {
  const data = executeData(target.cycle, amountIn, 0n, target.deadlineBlock);
  // L1 数据费按交易字节算：用同样长度的未签名交易加 65 字节占位签名（非零字节，不低估）。
  const shaped = concatBytes(unsignedTransaction({ chainId, nonce: 1_000n, maxPriorityFeePerGas: 10n ** 9n, maxFeePerGas: 10n ** 10n, gasLimit: 1_000_000n, to: target.executor, value: 0n, data }), new Uint8Array(67).fill(0xff));
  const [gas, l1Fee] = await rpc.batch([
    { method: 'eth_estimateGas', params: [{ from: target.operator, to: target.executor, data }, target.block] },
    { method: 'eth_call', params: [{ to: GAS_PRICE_ORACLE, data: callData('getL1Fee(bytes)', ['bytes'], [hexOf(shaped)]) }, target.block] },
  ], timeoutMs);
  if (!gas!.ok || !l1Fee!.ok) return null;
  try { return { gas: quantity(gas!.result), l1Fee: new AbiReader(l1Fee!.result as string).uint(0) }; } catch { return null; }
}
