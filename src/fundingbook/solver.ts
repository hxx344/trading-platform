// 资金费组合的求解器（docs/fundingbook.md 第 4 节）。变量是每个账户每个标的的带符号名义金额 w[账户][标的]
// （多为正），每个标的各账户合计为零（对冲）。目标是持有期内的资金费收入减去新开仓位的往返成本，约束是各账户
// 所需资金之和不超过可用本金、总名义金额不超过上限。一个账户所需资金 = max(安全倍数 × 1 日波动金额 + 维持保证金,
// 名义金额 ÷ 最大杠杆)，是 w 的凸函数，所以整个问题是凸的。
//
// 解法：给「所需资金」一个价格 λ（每一美元本金在持有期内值多少），在所需资金不超过预算的硬约束下，沿「同一标的
// 在两个账户之间挪 δ」的方向对「净收入 − λ × 所需资金」做坐标上升（步长逐级减半）。收益接近零但能降低账户波动的
// 仓位（相关性对冲）就是这样进来的：它自己的 Δ收入 ≤ 0，但 −λ × Δ所需资金 > 0，腾出的预算再被息差仓位用掉。
// 单一标的时目标对 w 是线性的，λ 稍高就一点不做、稍低就做满，没法靠二分 λ 收敛到预算上；所以对 λ 取一组值各解
// 一遍（每个解都满足预算），留下净收入最高的那个。
export interface SolveAccount { id: string; mmr: number; maxLeverage: number; /** 单边成交成本（手续费加滑点，小数）。 */ costRate: number }
export interface SolveInput {
  accounts: readonly SolveAccount[];
  /** 日收益协方差，下标与 apr、current 的标的一致。 */
  cov: readonly (readonly number[])[];
  /** apr[账户][标的]：这条腿的调整后资金费年化（多头付为正）；null 表示这个账户做不了这个标的。 */
  apr: readonly (readonly (number | null)[])[];
  current: readonly (readonly number[])[];
  capital: number;
  /** 不参与分配的本金比例（小数）。 */
  reserve: number;
  sigmas: number;
  horizonDays: number;
  maxGross: number;
  minLeg: number;
  /** 解释用：不许持有这个标的（它的仓位全部平掉）。 */
  excludeBase?: number;
  /** hold[标的]：这个标的保持当前仓位不动（有持仓的腿这一轮拿不到数据，既不能加也不该因此平掉）。 */
  hold?: readonly boolean[];
  /** 不交易带（小数）：一个标的各腿的调整都小于它单边名义金额的这个比例时保持原样。 */
  band?: number;
}
export interface AccountRisk { gross: number; sigma: number; mm: number; required: number }
export interface Solution {
  w: number[][];
  risk: AccountRisk[];
  /** 持有期内的资金费收入（美元）。 */
  income: number;
  /** 相对当前仓位新增敞口的往返成本（美元）。 */
  cost: number;
  required: number;
  lambda: number;
}

export function accountRisk(row: readonly number[], account: SolveAccount, cov: readonly (readonly number[])[], sigmas: number): AccountRisk {
  let gross = 0, variance = 0;
  for (let i = 0; i < row.length; i++) {
    const wi = row[i];
    if (wi === 0) continue;
    gross += Math.abs(wi);
    for (let j = 0; j < row.length; j++) variance += wi * row[j] * cov[i][j];
  }
  const sigma = Math.sqrt(Math.max(0, variance)), mm = gross * account.mmr;
  return { gross, sigma, mm, required: Math.max(sigmas * sigma + mm, gross / account.maxLeverage) };
}

/** 新增敞口：同方向只算超出原仓位的部分，反方向整笔都算。减仓不计成本（它的成本在开仓时已按往返计入）。 */
const increase = (value: number, base: number): number => value * base > 0 ? Math.max(0, Math.abs(value) - Math.abs(base)) : Math.abs(value);

export async function solve(input: SolveInput, pause: () => Promise<void> = async () => {}): Promise<Solution> {
  const { accounts, cov, apr, current, capital, sigmas, minLeg, excludeBase } = input;
  const A = accounts.length, B = cov.length, hz = input.horizonDays / 365;
  const budget = capital * (1 - input.reserve), grossCap = capital * input.maxGross;
  const kept = (b: number): boolean => input.hold?.[b] === true && b !== excludeBase;
  const tradable = (a: number, b: number): boolean => apr[a][b] !== null && b !== excludeBase && !kept(b);

  // 起点是当前仓位；某个标的有做不了的腿、或各账户合计不为零时，这个标的从全部平掉开始。保持不动的标的不清零，
  // 下面按比例缩回预算时也不缩。
  const w = current.map(row => row.slice());
  for (let b = 0; b < B; b++) {
    let net = 0, gross = 0, blocked = false;
    for (let a = 0; a < A; a++) { net += w[a][b]; gross += Math.abs(w[a][b]); if (w[a][b] !== 0 && !tradable(a, b) && !kept(b)) blocked = true; }
    if (!kept(b) && (blocked || Math.abs(net) > 0.01 * gross)) for (let a = 0; a < A; a++) w[a][b] = 0;
  }

  const carry = (a: number, row: readonly number[]): number => {
    let value = 0;
    for (let b = 0; b < B; b++) if (row[b] !== 0) value += -row[b] * (apr[a][b] ?? 0) * hz - accounts[a].costRate * 2 * increase(row[b], current[a][b]);
    return value;
  };
  let risk = w.map((row, a) => accountRisk(row, accounts[a], cov, sigmas));
  // 已有仓位的所需资金超过预算时（手续费、亏损或波动率上升吃掉了余量）：超得不多（还在预留的一半以内）就留着不动，
  // 只是不许再加；超得多就先按比例缩到预算以内。所需资金对仓位是一次齐次的，按比例缩正好落在预算上。固定 λ 的
  // 坐标上升做不了这件事：单一息差时目标是线性的，λ 小了一点不减，大了全部减光。
  const before = risk.reduce((sum, item) => sum + item.required, 0);
  if (before > capital * (1 - input.reserve / 2)) {
    const scale = budget / before * 0.999;
    for (const row of w) for (let b = 0; b < B; b++) if (!kept(b)) row[b] *= scale;
    risk = w.map((row, a) => accountRisk(row, accounts[a], cov, sigmas));
  }
  const carried = w.map((row, a) => carry(a, row));
  let totalGross = risk.reduce((sum, item) => sum + item.gross, 0), totalRequired = risk.reduce((sum, item) => sum + item.required, 0);
  const limit = Math.max(budget, totalRequired);

  const floor = Math.max(minLeg, capital / 1000), top = Math.max(floor, grossCap / 8), epsilon = 1e-7 * capital;
  /** 固定 λ 的坐标上升；`bounded` 时所需资金不许超过预算（已经超了的只许往下走）。 */
  async function run(lambda: number, bounded: boolean): Promise<void> {
    for (let step = top; step >= floor; step /= 2) {
      for (let sweep = 0; sweep < 60; sweep++) {
        let moved = false;
        for (let b = 0; b < B; b++) for (let i = 0; i < A; i++) {
          if (!tradable(i, b)) continue;
          for (let j = 0; j < A; j++) {
            if (j === i || !tradable(j, b)) continue;
            const wi = w[i][b], wj = w[j][b];
            w[i][b] = Math.abs(wi + step) < 1e-9 ? 0 : wi + step;
            w[j][b] = Math.abs(wj - step) < 1e-9 ? 0 : wj - step;
            const ri = accountRisk(w[i], accounts[i], cov, sigmas), rj = accountRisk(w[j], accounts[j], cov, sigmas);
            const ci = carry(i, w[i]), cj = carry(j, w[j]);
            const gross = totalGross - risk[i].gross - risk[j].gross + ri.gross + rj.gross;
            const required = totalRequired - risk[i].required - risk[j].required + ri.required + rj.required;
            const gain = ci + cj - carried[i] - carried[j] - lambda * (required - totalRequired);
            if (gain > epsilon && (gross <= grossCap || gross <= totalGross) && (!bounded || required <= budget || required <= totalRequired)) {
              risk[i] = ri; risk[j] = rj; carried[i] = ci; carried[j] = cj; totalGross = gross; totalRequired = required; moved = true;
            } else { w[i][b] = wi; w[j][b] = wj; }
          }
        }
        await pause();
        if (!moved) break;
      }
    }
  }
  const snapshot = () => ({ w: w.map(row => row.slice()), risk: risk.slice(), carried: carried.slice(), totalGross, totalRequired });
  const restore = (saved: ReturnType<typeof snapshot>): void => {
    for (let a = 0; a < A; a++) { w[a] = saved.w[a].slice(); risk[a] = saved.risk[a]; carried[a] = saved.carried[a]; }
    totalGross = saved.totalGross; totalRequired = saved.totalRequired;
  };

  const initial = snapshot();
  let best: { saved: ReturnType<typeof snapshot>; net: number; lambda: number } | null = null;
  /** 从起点按这个 λ 解一遍；满足预算且净收入更高就留下。返回解出来的总名义金额。 */
  async function attempt(lambda: number): Promise<number> {
    restore(initial);
    await run(lambda, true);
    const net = carried.reduce((sum, value) => sum + value, 0);
    if (totalRequired <= limit + 1e-6 && (!best || net > best.net + epsilon)) best = { saved: snapshot(), net, lambda };
    return totalGross;
  }
  await attempt(0);
  // λ 的上界：加倍到一点仓位都不留为止（减仓不计成本，λ 够大时所有仓位都会被减掉）。
  let high = 0.02;
  while (high < 64 && await attempt(high) > 0) high *= 2;
  const grid = 16;
  for (let index = 1; index < grid; index++) await attempt(high * index / grid);
  const found = best as { lambda: number } | null, center = found?.lambda ?? 0, width = high / grid;
  for (let index = -4; index <= 4; index++) if (index !== 0 && center + width * index / 5 > 0) await attempt(center + width * index / 5);
  const chosen = best as { saved: ReturnType<typeof snapshot>; lambda: number } | null;
  let lambda = 0;
  if (chosen) { restore(chosen.saved); lambda = chosen.lambda; }
  else {
    // 没有一个解满足预算（当前仓位本身就超了，且哪个 λ 都没把它减下来）：全部平掉。
    for (let a = 0; a < A; a++) { w[a].fill(0); risk[a] = accountRisk(w[a], accounts[a], cov, sigmas); carried[a] = 0; }
    totalGross = 0; totalRequired = 0;
  }

  // 小于最小单腿金额的腿去掉；由此多出的净敞口从同方向最大的那条腿上减掉，减不掉就整个标的不做。
  for (let b = 0; b < B; b++) {
    if (kept(b)) continue;
    for (let a = 0; a < A; a++) if (w[a][b] !== 0 && Math.abs(w[a][b]) < minLeg) w[a][b] = 0;
    let net = 0;
    for (let a = 0; a < A; a++) net += w[a][b];
    if (Math.abs(net) < 1e-9) continue;
    let target = -1;
    for (let a = 0; a < A; a++) if (w[a][b] * net > 0 && (target < 0 || Math.abs(w[a][b]) > Math.abs(w[target][b]))) target = a;
    if (target >= 0 && Math.abs(w[target][b]) - Math.abs(net) >= minLeg) w[target][b] -= net;
    else for (let a = 0; a < A; a++) w[a][b] = 0;
  }
  const requiredOf = (rows: readonly (readonly number[])[]): number => rows.reduce((sum, row, a) => sum + accountRisk(row, accounts[a], cov, sigmas).required, 0);
  const grossOf = (rows: readonly (readonly number[])[]): number => rows.reduce((sum, row) => sum + row.reduce((part, value) => part + Math.abs(value), 0), 0);
  // 不交易带：一个标的各腿的调整都小于它单边名义金额的 band（且小于最小单腿金额的也算）时保持原样。没有它，
  // 价格每跌一点、所需资金每降一点就会加一点仓，涨回来又按比例缩，手续费来回付。保持原样后超出预算就不用它。
  const band = input.band ?? 0;
  if (band > 0) {
    const banded = w.map(row => row.slice());
    let reverted = false;
    for (let b = 0; b < B; b++) {
      if (kept(b) || b === excludeBase) continue;
      let side = 0, delta = 0, open = false;
      for (let a = 0; a < A; a++) { side += Math.abs(current[a][b]) / 2; delta = Math.max(delta, Math.abs(w[a][b] - current[a][b])); if (w[a][b] !== 0) open = true; }
      if (!open || side === 0 || delta === 0 || delta >= Math.max(minLeg, band * side)) continue;
      for (let a = 0; a < A; a++) banded[a][b] = current[a][b];
      reverted = true;
    }
    if (reverted && requiredOf(banded) <= limit + 1e-6 && grossOf(banded) <= Math.max(grossCap, grossOf(w)) + 1e-6) for (let a = 0; a < A; a++) w[a] = banded[a];
  }
  // 去掉小腿可能去掉了对冲、让账户的波动金额变大：复核一遍，超出就按比例缩回（保持不动的标的不缩）。
  const after = requiredOf(w);
  if (after > limit + 1e-6) {
    const scale = limit / after * 0.999;
    for (let a = 0; a < A; a++) for (let b = 0; b < B; b++) if (!kept(b)) w[a][b] *= scale;
  }  const finalRisk = w.map((row, a) => accountRisk(row, accounts[a], cov, sigmas));
  let income = 0, cost = 0;
  for (let a = 0; a < A; a++) for (let b = 0; b < B; b++) {
    if (w[a][b] === 0) continue;
    income += -w[a][b] * (apr[a][b] ?? 0) * hz;
    cost += accounts[a].costRate * 2 * increase(w[a][b], current[a][b]);
  }
  return { w, risk: finalRisk, income, cost, required: finalRisk.reduce((sum, item) => sum + item.required, 0), lambda };
}

/** 把本金分给各账户：先给够所需资金，余下的按所需资金的比例分；没有仓位时全部放在第一个账户。 */
export function allocate(risk: readonly AccountRisk[], capital: number): number[] {
  const required = risk.reduce((sum, item) => sum + item.required, 0);
  if (required <= 0) return risk.map((_, index) => index === 0 ? capital : 0);
  return risk.map(item => item.required * capital / required);
}
