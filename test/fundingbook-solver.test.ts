// 资金费组合的求解器（src/fundingbook/solver.ts）：息差仓位、相关性对冲、预算与起点。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountRisk, allocate, solve, type SolveAccount, type SolveInput } from '../src/fundingbook/solver.ts';

const account = (id: string, mmr = 0.01): SolveAccount => ({ id, mmr, maxLeverage: 10, costRate: 0.0007 });
const accounts = [account('lighter-1', 0.02), account('bybit-1'), account('bitget-1')];
// 日波动率 BTC 2.81%、BNB 3.02%，相关系数 0.888。
const cov = [[0.0281 ** 2, 0.888 * 0.0281 * 0.0302], [0.888 * 0.0281 * 0.0302, 0.0302 ** 2]];
const zero = [[0, 0], [0, 0], [0, 0]];
const base: SolveInput = {
  accounts, cov, current: zero, capital: 10_000, reserve: 0.05, sigmas: 5, horizonDays: 90, maxGross: 12, minLeg: 50,
  // BTC：lighter 多头付 10%，bybit 2.83%，bitget 1.44%。BNB：三处几乎一样。
  apr: [[0.10, 0.030], [0.0283, 0.0411], [0.0144, 0.0328]],
};
const net = (w: number[][], b: number) => w.reduce((sum, row) => sum + row[b], 0);

test('息差：在资金费高的账户做空、低的账户做多，每个标的各账户合计为零，所需资金不超过预算', async () => {
  const result = await solve(base);
  assert.ok(result.w[0][0] < -1_000, 'lighter 做空 BTC');
  assert.ok(result.w[1][0] + result.w[2][0] > 1_000, 'bybit 与 bitget 做多 BTC');
  assert.ok(Math.abs(net(result.w, 0)) < 1e-6 && Math.abs(net(result.w, 1)) < 1e-6);
  assert.ok(result.required <= 9_500 + 1e-6, `所需资金 ${result.required}`);
  assert.ok(result.income > 0 && result.cost > 0 && result.income > result.cost);
  for (const [a, row] of result.w.entries()) assert.deepEqual(result.risk[a], accountRisk(row, accounts[a], cov, 5));
});

test('相关性对冲：BNB 自身息差几乎为零，仍被反向开出来，BTC 仓位因此比不许做 BNB 时更大', async () => {
  const withHedge = await solve(base), withoutHedge = await solve({ ...base, excludeBase: 1 });
  assert.ok(withHedge.w[0][1] > 500, `lighter 做多 BNB ${withHedge.w[0][1]}`);
  assert.ok(withHedge.w[1][1] + withHedge.w[2][1] < -500);
  assert.equal(withoutHedge.w.every(row => row[1] === 0), true);
  assert.ok(Math.abs(withHedge.w[0][0]) > Math.abs(withoutHedge.w[0][0]) * 1.15, `${withHedge.w[0][0]} 对 ${withoutHedge.w[0][0]}`);
  assert.ok(withHedge.income - withHedge.cost > withoutHedge.income - withoutHedge.cost);
  // 对冲把 lighter 账户的 1 日波动金额压到了单持 BTC 时的水平以下。
  const alone = accountRisk([withHedge.w[0][0], 0], accounts[0], cov, 5);
  assert.ok(withHedge.risk[0].sigma < alone.sigma * 0.8);
});

test('没有息差时不开仓；本金全部留在第一个账户', async () => {
  const flat = await solve({ ...base, apr: [[0.05, 0.03], [0.05, 0.03], [0.05, 0.03]] });
  assert.equal(flat.w.flat().every(value => value === 0), true);
  assert.equal(flat.income, 0);
  assert.deepEqual(allocate(flat.risk, 10_000), [10_000, 0, 0]);
});

test('已有仓位：息差还在就留着不动（不重复计成本），息差反了就平掉', async () => {
  const first = await solve(base);
  const kept = await solve({ ...base, current: first.w });
  assert.ok(kept.cost < 1, `保持仓位的新增成本 ${kept.cost}`);
  for (const [a, row] of kept.w.entries()) for (const [b, value] of row.entries()) assert.ok(Math.abs(value - first.w[a][b]) <= 100, `${a}/${b}: ${value} 对 ${first.w[a][b]}`);
  const reversed = await solve({ ...base, current: first.w, apr: [[-0.10, 0.030], [0.0283, 0.0411], [0.0144, 0.0328]] });
  assert.ok(reversed.w[0][0] >= 0, 'lighter 不再做空 BTC');
});

test('做不了的腿不会被分到仓位；当前持有它时这个标的先全部平掉', async () => {
  const result = await solve({ ...base, apr: [[0.10, null], [0.0283, 0.0411], [0.0144, 0.0328]], current: [[0, 300], [0, -300], [0, 0]] });
  assert.equal(result.w[0][1], 0);
  assert.ok(Math.abs(net(result.w, 1)) < 1e-6);
});

test('总名义上限与最小单腿：仓位合计不超过本金乘倍数，留下的腿都不小于最小金额', async () => {
  const result = await solve({ ...base, maxGross: 2, minLeg: 400 });
  const gross = result.w.flat().reduce((sum, value) => sum + Math.abs(value), 0);
  assert.ok(gross <= 20_000 + 1e-6, `名义合计 ${gross}`);
  assert.ok(result.w.flat().every(value => value === 0 || Math.abs(value) >= 400));
});

test('分配本金：先给够所需资金，余量按比例分，合计等于本金', async () => {
  const result = await solve(base), equity = allocate(result.risk, 10_000);
  assert.ok(Math.abs(equity.reduce((sum, value) => sum + value, 0) - 10_000) < 1e-6);
  for (const [a, value] of equity.entries()) assert.ok(value >= result.risk[a].required - 1e-6);
});

test('已有仓位略超预算时留着不动；超过预留的一半时按比例缩回预算，不会全部平掉', async () => {
  const opened = await solve(base);
  // 本金被手续费吃掉 0.5%：所需资金略高于新预算，但还在预留的一半以内。
  const slightly = await solve({ ...base, current: opened.w, capital: 9_950 });
  assert.deepEqual(slightly.w, opened.w);
  // 本金少了 10%：缩到新预算以内，各腿同比例减，方向不变。
  const shrunk = await solve({ ...base, current: opened.w, capital: 9_000 });
  assert.ok(shrunk.required <= 9_000 * 0.95 + 1e-6 && shrunk.required > 9_000 * 0.9, `所需资金 ${shrunk.required}`);
  assert.ok(shrunk.w[0][0] < 0 && Math.abs(shrunk.w[0][0]) < Math.abs(opened.w[0][0]) && Math.abs(shrunk.w[0][0]) > Math.abs(opened.w[0][0]) * 0.8);
  assert.ok(shrunk.cost < 1, `缩仓本身不计成本，实际 ${shrunk.cost}`);
});

test('单一标的两个账户：仓位做到预算用满为止，与解析解一致', async () => {
  // 每个账户所需资金 = |w| × (5 × 2% + 1%)，两个账户合计 0.22|w| = 9500。
  const result = await solve({
    accounts: [account('a'), account('b')], cov: [[0.02 ** 2]], apr: [[0.10], [0.01]], current: [[0], [0]],
    capital: 10_000, reserve: 0.05, sigmas: 5, horizonDays: 90, maxGross: 50, minLeg: 10,
  });
  const exact = 9_500 / 0.22;
  assert.ok(result.w[0][0] < 0 && Math.abs(result.w[0][0] + result.w[1][0]) < 1e-9);
  assert.ok(exact - Math.abs(result.w[0][0]) >= 0 && exact - Math.abs(result.w[0][0]) < 20, `仓位 ${result.w[0][0]}，解析解 ${exact}`);
});

test('不交易带：仓位只偏离目标一点时保持原样；偏离大了才调', async () => {
  const first = await solve(base);
  // 价格整体跌 0.3%：所需资金随之下降，空出一点预算。
  const drifted = first.w.map(row => row.map(value => value * 0.997));
  const held = await solve({ ...base, current: drifted, band: 0.03 });
  assert.deepEqual(held.w, drifted, '0.3% 的漂移不该出单');
  const loose = await solve({ ...base, current: drifted });
  assert.notDeepEqual(loose.w, drifted, '没有不交易带时会去补这一点');
  const far = first.w.map(row => row.map(value => value * 0.8));
  const moved = await solve({ ...base, current: far, band: 0.03 });
  assert.ok(Math.abs(moved.w[0][0]) > Math.abs(far[0][0]) * 1.1, '偏离 20% 时加回去');
  assert.ok(moved.required <= 9_500 + 1e-6);
});

test('保持不动：有持仓的腿拿不到数据时，这个标的原样留着，其余照常求解', async () => {
  const current = [[-20_000, 3_000], [20_000, -3_000], [0, 0]];
  const blocked: SolveInput = { ...base, current, apr: [[0.10, null], [0.0283, 0.0411], [0.0144, 0.0328]] };
  const closed = await solve(blocked);
  assert.equal(closed.w.every(row => row[1] === 0), true, '不保持时整个标的被平掉');
  const kept = await solve({ ...blocked, hold: [false, true] });
  assert.deepEqual(kept.w.map(row => row[1]), [3_000, -3_000, 0]);
  assert.ok(kept.w[0][0] < -20_000 && Math.abs(net(kept.w, 0)) < 1e-6, 'BTC 照常加仓');
  assert.ok(kept.required <= 9_500 + 1e-6);
});

test('随机起点：合计为零、预算、总名义上限与最小单腿都成立', async () => {
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let round = 0; round < 40; round++) {
    const btc = (random() - 0.5) * 80_000, bnb = (random() - 0.5) * 30_000, split = random();
    const current = [[btc, bnb], [-btc * split, -bnb], [-btc * (1 - split), 0]];
    const apr = [[0.02 + random() * 0.1, random() * 0.06], [random() * 0.05, random() * 0.06], [random() * 0.05, random() * 0.06]];
    for (const band of [0, 0.03]) {
      const result = await solve({ ...base, current, apr, band });
      const before = current.reduce((sum, row, a) => sum + accountRisk(row, accounts[a], cov, 5).required, 0);
      const limit = before > 10_000 * 0.975 ? 9_500 : Math.max(9_500, before);
      assert.ok(result.required <= limit + 1e-6, `第 ${round} 组所需资金 ${result.required} 超出 ${limit}`);
      for (const b of [0, 1]) assert.ok(Math.abs(net(result.w, b)) < 1e-6, `第 ${round} 组标的 ${b} 合计 ${net(result.w, b)}`);
      const gross = result.w.flat().reduce((sum, value) => sum + Math.abs(value), 0);
      assert.ok(gross <= Math.max(120_000, current.flat().reduce((sum, value) => sum + Math.abs(value), 0)) + 1e-6);
    }
  }
});

test('保持不动的标的在超预算缩仓与合计不为零时也不动', async () => {
  const first = await solve(base);
  const big = first.w.map(row => row.map(value => value * 1.3));
  const kept = await solve({ ...base, current: big, hold: [false, true] });
  assert.deepEqual(kept.w.map(row => row[1]), big.map(row => row[1]), '超预算时只缩别的标的');
  assert.ok(Math.abs(kept.w[0][0]) < Math.abs(big[0][0]));
  const uneven = first.w.map(row => row.slice());
  uneven[0][1] *= 1.05;
  const still = await solve({ ...base, current: uneven, hold: [false, true] });
  assert.deepEqual(still.w.map(row => row[1]), uneven.map(row => row[1]), '合计偏了也不清掉');
});
