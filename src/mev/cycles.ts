// 环路枚举与现货价粗筛（docs/mev.md 第 2 节）。纯计算，不联网。
// 粗筛只挑出值得模拟的环路：现货价不含价格冲击，真正的利润以执行合约的 eth_call 为准。
import type { Pool, PoolState } from './pools.ts';

export interface Hop { pool: Pool; tokenIn: string; tokenOut: string }
export interface Cycle { id: string; start: string; hops: readonly Hop[] }

export const MAX_CYCLES = 6_000;

/** 从每个起始代币出发的两跳与三跳环路；同一个池子在一条环路里只出现一次。 */
export function enumerateCycles(pools: readonly Pool[], starts: readonly string[], limit = MAX_CYCLES): Cycle[] {
  const edges = new Map<string, Hop[]>();
  const add = (pool: Pool, tokenIn: string, tokenOut: string) => { const list = edges.get(tokenIn) ?? []; list.push({ pool, tokenIn, tokenOut }); edges.set(tokenIn, list); };
  for (const pool of pools) { add(pool, pool.token0, pool.token1); add(pool, pool.token1, pool.token0); }
  const cycles: Cycle[] = [];
  const push = (start: string, hops: Hop[]) => { cycles.push({ id: hops.map(hop => `${hop.pool.address}:${hop.tokenIn === hop.pool.token0 ? 0 : 1}`).join('>'), start, hops }); };
  // 先收全部两跳（数量少、gas 低），再收三跳，超过上限时丢的是三跳。
  for (const start of starts) for (const first of edges.get(start) ?? []) for (const second of edges.get(first.tokenOut) ?? []) {
    if (second.tokenOut === start && second.pool !== first.pool && cycles.length < limit) push(start, [first, second]);
  }
  for (const start of starts) for (const first of edges.get(start) ?? []) for (const second of edges.get(first.tokenOut) ?? []) {
    if (second.tokenOut === start || second.pool === first.pool) continue;
    for (const third of edges.get(second.tokenOut) ?? []) {
      if (third.tokenOut !== start || third.pool === first.pool || third.pool === second.pool) continue;
      if (cycles.length >= limit) return cycles;
      push(start, [first, second, third]);
    }
  }
  return cycles;
}

/** 一跳的现货兑换率（扣手续费，最小单位之比）；没有状态返回 null。 */
function hopRate(hop: Hop, states: ReadonlyMap<string, PoolState>): number | null {
  const state = states.get(hop.pool.address);
  if (!state) return null;
  const price = hop.tokenIn === hop.pool.token0 ? state.price : 1 / state.price;
  return price * (1 - hop.pool.feePpm / 1_000_000);
}

/** 环路沿现货价走一圈的毛收益率减一（基点）；任何一跳没有状态返回 null。 */
export function cycleEdgeBps(cycle: Cycle, states: ReadonlyMap<string, PoolState>): number | null {
  let rate = 1;
  for (const hop of cycle.hops) { const next = hopRate(hop, states); if (next === null) return null; rate *= next; }
  return Number.isFinite(rate) ? (rate - 1) * 10_000 : null;
}

/**
 * 各代币以美元计的单价（每个最小单位）。USDC 记 1 美元；其余代币沿深度最大的池子逐层推出来。
 * 推不出价格的代币不在结果里，含它的池子也就没有深度。
 */
export function tokenPricesUsd(pools: readonly Pool[], states: ReadonlyMap<string, PoolState>, usdc: string, usdcDecimals = 6): Map<string, number> {
  const prices = new Map<string, number>([[usdc, 1 / 10 ** usdcDecimals]]);
  for (let round = 0; round < 3; round++) {
    const best = new Map<string, { price: number; depth: number }>();
    for (const pool of pools) {
      const state = states.get(pool.address);
      if (!state) continue;
      const known0 = prices.get(pool.token0), known1 = prices.get(pool.token1);
      if ((known0 === undefined) === (known1 === undefined)) continue;
      const [token, price, depth] = known0 !== undefined
        ? [pool.token1, known0 / state.price, state.reserve0 * known0]
        : [pool.token0, known1! * state.price, state.reserve1 * known1!];
      if (!(price > 0) || !Number.isFinite(price)) continue;
      const current = best.get(token);
      if (!current || depth > current.depth) best.set(token, { price, depth });
    }
    if (!best.size) break;
    for (const [token, entry] of best) prices.set(token, entry.price);
  }
  return prices;
}

/** 池子两侧虚拟储备的美元价值之和；任何一侧没有价格返回 0。 */
export function poolDepthUsd(pool: Pool, state: PoolState | undefined, prices: ReadonlyMap<string, number>): number {
  const price0 = prices.get(pool.token0), price1 = prices.get(pool.token1);
  if (!state || price0 === undefined || price1 === undefined) return 0;
  const depth = state.reserve0 * price0 + state.reserve1 * price1;
  return Number.isFinite(depth) ? depth : 0;
}

export interface Candidate { cycle: Cycle; edgeBps: number }

/** 现货价上毛收益超过 `minEdgeBps` 的环路，按收益从高到低取前 `limit` 条；`usable` 之外的池子不参与。 */
export function rankCandidates(cycles: readonly Cycle[], states: ReadonlyMap<string, PoolState>, usable: ReadonlySet<string>, minEdgeBps: number, limit: number): Candidate[] {
  const found: Candidate[] = [];
  for (const cycle of cycles) {
    if (!cycle.hops.every(hop => usable.has(hop.pool.address))) continue;
    const edgeBps = cycleEdgeBps(cycle, states);
    // 现货价上超过 20% 的「收益」不是套利机会，是读数或池子有问题。
    if (edgeBps !== null && edgeBps > minEdgeBps && edgeBps < 2_000) found.push({ cycle, edgeBps });
  }
  return found.sort((left, right) => right.edgeBps - left.edgeBps).slice(0, limit);
}
