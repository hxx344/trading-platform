// 资金费组合的统计口径（docs/fundingbook.md 第 3 节）：每条腿的资金费年化均值，各标的的日波动率与相关性。
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export interface FundingRecord { time: number; rate: number }
export interface PricePoint { time: number; close: number }

export interface FundingStats {
  /** 短窗口内已结算费率之和折年化（小数，0.1 即 10%）。多头付、空头收为正。 */
  shortApr: number;
  /** 长窗口的年化；查询范围还没覆盖长窗口时为 null。 */
  longApr: number | null;
  /** 调整均值：短、长窗口按权重混合；没有长窗口时把短窗口按权重向零收缩。 */
  adjustedApr: number;
  count: number;
  coverageDays: number;
  lastAt: number | null;
}

/** 窗口起点容许晚这么久：回补按整段查询，段的边界不会正好落在窗口起点上。 */
const COVERAGE_SLACK = 2 * HOUR;

/**
 * `coveredFrom` 是已查询范围的起点（不是第一条记录的时间：新上市的合约窗口前段本来就没有结算）。
 * 查询范围没覆盖短窗口、或短窗口里一次结算都没有时返回 null，这条腿本轮不参与。
 */
export function fundingStats(records: readonly FundingRecord[], coveredFrom: number | null, now: number, options: { shortDays: number; longDays: number; shortWeight: number }): FundingStats | null {
  if (coveredFrom === null) return null;
  const { shortDays, longDays, shortWeight } = options;
  const shortFrom = now - shortDays * DAY, longFrom = now - longDays * DAY;
  if (coveredFrom > shortFrom + COVERAGE_SLACK) return null;
  let shortSum = 0, longSum = 0, count = 0, lastAt: number | null = null;
  for (const { time, rate } of records) {
    if (time > now || time <= longFrom) continue;
    longSum += rate;
    if (time > shortFrom) { shortSum += rate; count += 1; }
    if (lastAt === null || time > lastAt) lastAt = time;
  }
  if (!count) return null;
  const shortApr = shortSum / shortDays * 365;
  const longApr = coveredFrom <= longFrom + COVERAGE_SLACK ? longSum / longDays * 365 : null;
  const adjustedApr = longApr === null ? shortApr * shortWeight : shortApr * shortWeight + longApr * (1 - shortWeight);
  return { shortApr, longApr, adjustedApr, count, coverageDays: Math.min(longDays, (now - coveredFrom) / DAY), lastAt };
}

export interface RiskModel {
  bases: string[];
  /** 日波动率（小数）。 */
  vol: number[];
  corr: number[][];
  /** 日收益的协方差：cov[i][j] = vol[i] * vol[j] * corr[i][j]。 */
  cov: number[][];
  samples: number[];
}

/** 一个标的至少要有这么多个小时收益才进风险模型（7 天）。 */
export const MIN_RETURNS = 168;

function hourlyReturns(points: readonly PricePoint[], from: number, now: number): Map<number, number> {
  const sorted = points.filter(point => point.time > from && point.time <= now && point.close > 0).sort((a, b) => a.time - b.time);
  const returns = new Map<number, number>();
  for (let index = 1; index < sorted.length; index++) {
    const previous = sorted[index - 1], current = sorted[index];
    if (current.time - previous.time === HOUR) returns.set(current.time, Math.log(current.close / previous.close));
  }
  return returns;
}

/**
 * 小时对数收益的样本标准差乘 √24 作日波动率。相关性只用全部标的共同的时刻来算：同一组样本算出的相关矩阵一定
 * 半正定，任何组合的方差都不会算成负数（各对分别取样本拼出来的矩阵没有这个保证）。自己的样本不足、或让共同时刻
 * 不足 MIN_RETURNS 的标的不进模型。
 */
export function riskModel(series: ReadonlyMap<string, readonly PricePoint[]>, now: number, volDays: number): RiskModel {
  const from = now - volDays * DAY;
  let entries = [...series].map(([base, points]) => ({ base, returns: hourlyReturns(points, from, now) })).filter(entry => entry.returns.size >= MIN_RETURNS);
  let common: number[] = [];
  for (;;) {
    common = entries.length ? [...entries[0].returns.keys()].filter(time => entries.every(entry => entry.returns.has(time))) : [];
    if (entries.length <= 1 || common.length >= MIN_RETURNS) break;
    // 去掉之后剩下的标的共同时刻最多的那个（它是让大家对不上的原因）；一样多时去掉自己样本最少的。
    const overlap = (without: typeof entries[number]): number => {
      const rest = entries.filter(entry => entry !== without);
      return [...rest[0].returns.keys()].filter(time => rest.every(entry => entry.returns.has(time))).length;
    };
    const scored = entries.map(entry => ({ entry, left: overlap(entry) }));
    const drop = scored.reduce((worst, item) => item.left > worst.left || (item.left === worst.left && item.entry.returns.size < worst.entry.returns.size) ? item : worst).entry;
    entries = entries.filter(entry => entry !== drop);
  }
  const deviation = (values: readonly number[]): number => {
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
  };
  const vol = entries.map(entry => deviation([...entry.returns.values()]) * Math.sqrt(24));
  const centered = entries.map(entry => {
    const values = common.map(time => entry.returns.get(time)!), mean = values.reduce((sum, value) => sum + value, 0) / (values.length || 1);
    return values.map(value => value - mean);
  });
  const dot = (a: readonly number[], b: readonly number[]): number => a.reduce((sum, value, index) => sum + value * b[index], 0);
  const corr = centered.map((left, i) => centered.map((right, j) => {
    if (i === j) return 1;
    const squareA = dot(left, left), squareB = dot(right, right);
    return squareA > 0 && squareB > 0 ? Math.max(-1, Math.min(1, dot(left, right) / Math.sqrt(squareA * squareB))) : 0;
  }));
  return { bases: entries.map(entry => entry.base), vol, corr, cov: corr.map((row, i) => row.map((value, j) => value * vol[i] * vol[j])), samples: entries.map(entry => entry.returns.size) };
}
