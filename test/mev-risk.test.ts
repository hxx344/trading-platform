// MEV 套利的出价与风控（src/mev/risk.ts）、环路枚举与粗筛（src/mev/cycles.ts）、试算档位（src/mev/simulate.ts）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KIND_AERO_V2, KIND_V3 } from '../src/mev/chain.ts';
import { cycleEdgeBps, enumerateCycles, poolDepthUsd, rankCandidates, tokenPricesUsd } from '../src/mev/cycles.ts';
import type { Pool, PoolState } from '../src/mev/pools.ts';
import { DEFAULT_SETTINGS, MIN_TIP_WEI, SettingsError, gate, parseSettings, planTransaction, storedSettings, utcDayStart, type PlanInput } from '../src/mev/risk.ts';
import { gridSizes, refineSizes } from '../src/mev/simulate.ts';

const base: PlanInput = { profit: 2n * 10n ** 15n, startDecimals: 18, startUsd: 3_400, ethUsd: 3_400, gasEstimate: 380_000n, baseFee: 5_000_000n, l1Fee: 2_000_000_000n, settings: DEFAULT_SETTINGS };

test('出价：小费取利润的一份，净利过两道门槛才发；链上最低利润不低于费用', () => {
  const plan = planTransaction(base);
  assert.ok(plan.ok);
  if (!plan.ok) return;
  assert.equal(plan.gasLimit, 494_000n);
  // 利润 0.002 ETH 的 30% 摊到估算 gas 上。
  assert.equal(plan.maxPriorityFeePerGas, 2n * 10n ** 15n * 3n / 10n / 380_000n);
  assert.equal(plan.maxFeePerGas, 15_000_000n + plan.maxPriorityFeePerGas);
  assert.equal(plan.worstCostWei, plan.gasLimit * plan.maxFeePerGas + 4_000_000_000n);
  assert.ok(Math.abs(plan.profitUsd - 6.8) < 1e-9);
  assert.ok(Math.abs(plan.netUsd - (plan.profitUsd - plan.costUsd)) < 1e-9);
  assert.ok(plan.costUsd > 2.04 && plan.costUsd < 2.06, '费用约为利润的三成加基础费用');
  // minProfit 取模拟利润的一半；它换成美元高于费用，上链即不亏。
  assert.equal(plan.minProfit, 10n ** 15n);
  assert.ok(Number(plan.minProfit) / 1e18 * 3_400 >= plan.costUsd);
});

test('出价：净利不足、gas 超限、依据无效、费用超过利润时不发并给出原因', () => {
  const thin = planTransaction({ ...base, profit: 10n ** 14n });
  assert.ok(!thin.ok && /低于门槛/.test(thin.reason) && thin.netUsd < 0.3 && thin.costUsd > 0);
  const multiple = planTransaction({ ...base, profit: 10n ** 14n, settings: { ...DEFAULT_SETTINGS, minNetUsd: 0.01, gasMultiple: 100 } });
  assert.ok(!multiple.ok && /基础费用的 100 倍/.test(multiple.reason));
  const heavy = planTransaction({ ...base, gasEstimate: 1_000_000n });
  assert.ok(!heavy.ok && /超过单笔上限/.test(heavy.reason));
  for (const bad of [{ ethUsd: 0 }, { startUsd: Number.NaN }, { profit: 0n }, { gasEstimate: 0n }, { baseFee: -1n }]) {
    const result = planTransaction({ ...base, ...bad });
    assert.ok(!result.ok && result.reason === '测算依据无效');
  }
  // 小费比例很低时 minProfit 由费用决定；费用比模拟利润还高就不发。
  const costly = planTransaction({ ...base, profit: 4n * 10n ** 14n, l1Fee: 3n * 10n ** 14n, settings: { ...DEFAULT_SETTINGS, minNetUsd: 0.01, gasMultiple: 1, minProfitRatio: 0.1, tipShare: 0 } });
  assert.ok(!costly.ok);
  const floor = planTransaction({ ...base, profit: 10n ** 12n, settings: { ...DEFAULT_SETTINGS, minNetUsd: 0.01, gasMultiple: 1 } });
  assert.ok(!floor.ok, '利润太小时小费取下限，净利为负');
  assert.equal(MIN_TIP_WEI, 1_000_000n);
});

test('出价：同一个 nonce 上的替换交易两项费用都比上一笔高出 25% 以上', () => {
  const first = planTransaction(base);
  assert.ok(first.ok);
  if (!first.ok) return;
  const second = planTransaction({ ...base, feeFloor: { maxFeePerGas: first.maxFeePerGas, maxPriorityFeePerGas: first.maxPriorityFeePerGas } });
  assert.ok(second.ok);
  if (!second.ok) return;
  assert.equal(second.maxPriorityFeePerGas, first.maxPriorityFeePerGas * 5n / 4n + 1n);
  assert.equal(second.maxFeePerGas, first.maxFeePerGas * 5n / 4n + 1n);
  assert.ok(second.maxFeePerGas >= base.baseFee + second.maxPriorityFeePerGas);
  assert.ok(second.costUsd > first.costUsd && second.netUsd < first.netUsd, '加价的费用算进净利');
  // 加价后不划算就不发。
  const pricey = planTransaction({ ...base, feeFloor: { maxFeePerGas: 10n ** 11n, maxPriorityFeePerGas: 5n * 10n ** 10n } });
  assert.ok(!pricey.ok);
});

test('发送前的账户级检查：熔断与余额停实盘，预算只是放不下这一笔时不停', () => {
  const input = { settings: DEFAULT_SETTINGS, spentTodayWei: 0n, reservedWei: 0n, worstCostWei: 6n * 10n ** 14n, walletWei: 10n ** 16n, consecutiveReverts: 0 };
  assert.equal(gate(input), null);
  assert.deepEqual(gate({ ...input, consecutiveReverts: 5 }), { reason: '连续 5 笔上链回滚', halt: true });
  const low = gate({ ...input, walletWei: 10n ** 15n });
  assert.ok(low && low.halt && /低于下限/.test(low.reason));
  // 预算 0.003 ETH：已花 0.002、预留 0.0005，再来 0.0006 放不下，但预算没用完。
  const tight = gate({ ...input, spentTodayWei: 2n * 10n ** 15n, reservedWei: 5n * 10n ** 14n });
  assert.ok(tight && !tight.halt && /预算/.test(tight.reason));
  const spent = gate({ ...input, spentTodayWei: 3n * 10n ** 15n });
  assert.ok(spent && spent.halt);
  assert.equal(gate({ ...input, spentTodayWei: 2n * 10n ** 15n, reservedWei: 4n * 10n ** 14n }), null, '刚好等于预算可以发');
  const short = gate({ ...input, settings: { ...DEFAULT_SETTINGS, dailyGasBudgetEth: 1 }, walletWei: 3n * 10n ** 15n, reservedWei: 25n * 10n ** 14n });
  assert.deepEqual(short, { reason: '热钱包余额不够支付这一笔的最坏费用', halt: false });
  assert.equal(utcDayStart(Date.UTC(2026, 10, 25, 23, 59)), Date.UTC(2026, 10, 25));
});

test('参数校验：整份校验，缺项、多项、越界、非整数都拒绝；库里的旧参数补默认值', () => {
  assert.deepEqual(parseSettings({ ...DEFAULT_SETTINGS }), DEFAULT_SETTINGS);
  const missing = Object.fromEntries(Object.entries(DEFAULT_SETTINGS).filter(([key]) => key !== 'minNetUsd'));
  for (const bad of [null, [], 'x', missing, { ...DEFAULT_SETTINGS, other: 1 }, { ...DEFAULT_SETTINGS, maxGasLimit: 500_000.5 }, { ...DEFAULT_SETTINGS, minNetUsd: '1' }, { ...DEFAULT_SETTINGS, dailyGasBudgetEth: 2 },
    { ...DEFAULT_SETTINGS, minWalletEth: 0 }, { ...DEFAULT_SETTINGS, maxSimulationsPerBlock: 11 }, { ...DEFAULT_SETTINGS, minProfitRatio: 0.05 }, { ...DEFAULT_SETTINGS, tipShare: Number.NaN }]) {
    assert.throws(() => parseSettings(bad), SettingsError);
  }
  assert.deepEqual(storedSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(storedSettings({ minNetUsd: 2, retired: true }), { ...DEFAULT_SETTINGS, minNetUsd: 2 });
  assert.deepEqual(storedSettings({ minNetUsd: -5 }), DEFAULT_SETTINGS);
});

const A = '0x00000000000000000000000000000000000000a1', B = '0x00000000000000000000000000000000000000b2', C = '0x00000000000000000000000000000000000000c3';
const pool = (address: string, token0: string, token1: string, feePpm: number, kind: Pool['kind'] = KIND_V3): Pool => ({ address, factory: '0x' + 'f'.repeat(40), kind, token0, token1, feePpm });

test('环路：两跳走同一对代币的两个池子，三跳经过第三种代币；只从起始代币出发，不重复用池子', () => {
  const pools = [pool('0x01', A, B, 500), pool('0x02', A, B, 3000), pool('0x03', B, C, 500), pool('0x04', A, C, 500, KIND_AERO_V2)];
  const cycles = enumerateCycles(pools, [A]);
  assert.ok(cycles.length > 0);
  for (const cycle of cycles) {
    assert.equal(cycle.start, A);
    assert.equal(cycle.hops[0]!.tokenIn, A);
    assert.equal(cycle.hops.at(-1)!.tokenOut, A);
    assert.ok(cycle.hops.length >= 2 && cycle.hops.length <= 4);
    cycle.hops.forEach((hop, index) => { if (index) assert.equal(hop.tokenIn, cycle.hops[index - 1]!.tokenOut); });
    assert.equal(new Set(cycle.hops.map(hop => hop.pool.address)).size, cycle.hops.length);
  }
  assert.equal(new Set(cycles.map(cycle => cycle.id)).size, cycles.length, '环路编号不重复');
  assert.equal(cycles.filter(cycle => cycle.hops.length === 2).length, 2, '两个 A/B 池子给出两个方向');
  assert.ok(cycles.some(cycle => cycle.hops.length === 3 && cycle.hops.some(hop => hop.pool.address === '0x04')));
  assert.equal(enumerateCycles(pools, [C]).every(cycle => cycle.start === C), true);
  assert.equal(enumerateCycles(pools, [A], 3).length, 3, '数量封顶');
  assert.deepEqual(enumerateCycles([pools[0]!], [A]), []);
});

test('粗筛：按现货价与手续费估毛收益，只留超过门槛且池子都够深的环路，按收益从高到低', () => {
  const pools = [pool('0x01', A, B, 500), pool('0x02', A, B, 500), pool('0x03', A, B, 500)];
  const state = (price: number): PoolState => ({ price, reserve0: 1e24, reserve1: 1e24 * price });
  const states = new Map([['0x01', state(1)], ['0x02', state(1.004)], ['0x03', state(1.01)]]);
  const cycles = enumerateCycles(pools, [A]);
  const usable = new Set(pools.map(entry => entry.address));
  const ranked = rankCandidates(cycles, states, usable, 5, 10);
  assert.ok(ranked.length >= 3);
  assert.ok(ranked.every((entry, index) => entry.edgeBps >= 5 && (index === 0 || ranked[index - 1]!.edgeBps >= entry.edgeBps)));
  // 最好的一条：在最贵的池子（0x03）把 A 换成 B，再到最便宜的池子（0x01）换回，约 100 − 10 个基点。
  const best = ranked[0]!;
  assert.deepEqual(best.cycle.hops.map(hop => hop.pool.address), ['0x03', '0x01']);
  assert.ok(best.edgeBps > 85 && best.edgeBps < 92);
  assert.equal(cycleEdgeBps(best.cycle, states), best.edgeBps);
  assert.equal(cycleEdgeBps(best.cycle, new Map([['0x01', state(1)]])), null, '缺状态的环路不估');
  assert.equal(rankCandidates(cycles, states, usable, 5, 1).length, 1);
  assert.ok(rankCandidates(cycles, states, new Set(['0x01', '0x02']), 5, 10).every(entry => entry.cycle.hops.every(hop => hop.pool.address !== '0x03')));
  assert.deepEqual(rankCandidates(cycles, states, usable, 500, 10), []);
});

test('美元价与深度：从含 USDC 的池子推出各代币价格，深度是两侧储备的美元合计', () => {
  const usdc = B, weth = A;
  // weth 18 位、usdc 6 位：price 是 token1（usdc）对 token0（weth）最小单位之比。
  const deep = pool('0x01', weth, usdc, 500), states = new Map<string, PoolState>([['0x01', { price: 3_400e6 / 1e18, reserve0: 100e18, reserve1: 340_000e6 }]]);
  const prices = tokenPricesUsd([deep], states, usdc);
  assert.ok(Math.abs(prices.get(usdc)! * 1e6 - 1) < 1e-9);
  assert.ok(Math.abs(prices.get(weth)! * 1e18 - 3_400) < 1e-6);
  assert.ok(Math.abs(poolDepthUsd(deep, states.get('0x01'), prices) - 680_000) < 1);
  assert.equal(poolDepthUsd(deep, undefined, prices), 0);
  assert.equal(poolDepthUsd(pool('0x09', C, weth, 500), { price: 1, reserve0: 1e18, reserve1: 1e18 }, new Map()), 0, '没有价格的代币不计深度');
});

test('试算档位：按美元名义从小到大且不超过上限；细化档位围绕最优一档', () => {
  const grid = gridSizes(3_400, 18, 50_000);
  assert.equal(grid.length, 7);
  assert.ok(grid.every((amount, index) => amount > 0n && (index === 0 || amount > grid[index - 1]!)));
  assert.ok(Math.abs(Number(grid.at(-1)) / 1e18 * 3_400 - 50_000) < 1e-6);
  assert.deepEqual(gridSizes(0, 18, 50_000), []);
  assert.deepEqual(gridSizes(1, 6, 40), []);
  assert.deepEqual(refineSizes(1_000n, 1_500n), [600n, 800n, 1_250n]);
  assert.deepEqual(refineSizes(1n, 10n), []);
});
