// 风控参数与一笔套利的收支测算（docs/mev.md 第 1.4 节）。纯计算，不联网、不读库。
// 金额的链上部分（gas、小费、minProfit）用整数；美元只用来和门槛比较。

export interface Settings {
  /** 扣掉 gas 与小费后的最低净利（美元）。 */
  minNetUsd: number;
  /** 净利至少是基础费用（L2 基础费加 L1 数据费）的多少倍。 */
  gasMultiple: number;
  /** 单笔 gas 上限。 */
  maxGasLimit: number;
  /** 每个 UTC 日的 gas 支出上限（ETH）。 */
  dailyGasBudgetEth: number;
  /** 连续多少笔上链回滚后停实盘。 */
  maxConsecutiveReverts: number;
  /** 热钱包余额低于它（ETH）即停实盘。 */
  minWalletEth: number;
  /** 单笔闪电兑换的名义上限（美元）。 */
  maxNotionalUsd: number;
  /** 现货价上毛收益超过多少基点才模拟。 */
  minEdgeBps: number;
  /** 池子两侧虚拟储备合计低于它（美元）不参与。 */
  minDepthUsd: number;
  /** 预期利润里拿去做小费的比例。 */
  tipShare: number;
  /** 链上 minProfit 取模拟利润的比例（另不低于费用）。 */
  minProfitRatio: number;
  /** 每个区块最多模拟多少条环路。 */
  maxSimulationsPerBlock: number;
}

export const DEFAULT_SETTINGS: Settings = {
  minNetUsd: 0.3, gasMultiple: 2, maxGasLimit: 1_200_000, dailyGasBudgetEth: 0.003, maxConsecutiveReverts: 5, minWalletEth: 0.002,
  maxNotionalUsd: 50_000, minEdgeBps: 5, minDepthUsd: 20_000, tipShare: 0.3, minProfitRatio: 0.5, maxSimulationsPerBlock: 3,
};

/** 每项的允许范围：[下限, 上限, 是否整数]。上限是防止手误的硬界，不是建议值。 */
const RANGES: Record<keyof Settings, readonly [number, number, boolean]> = {
  minNetUsd: [0.01, 10_000, false], gasMultiple: [1, 100, false], maxGasLimit: [200_000, 3_000_000, true], dailyGasBudgetEth: [0.0001, 1, false],
  maxConsecutiveReverts: [1, 50, true], minWalletEth: [0.0001, 1, false], maxNotionalUsd: [100, 1_000_000, false], minEdgeBps: [0, 500, false],
  minDepthUsd: [1_000, 100_000_000, false], tipShare: [0, 0.9, false], minProfitRatio: [0.1, 1, false], maxSimulationsPerBlock: [1, 10, true],
};
const LABELS: Record<keyof Settings, string> = {
  minNetUsd: '最低净利', gasMultiple: '净利对基础费用倍数', maxGasLimit: '单笔 gas 上限', dailyGasBudgetEth: '每日 gas 预算', maxConsecutiveReverts: '连续回滚熔断笔数',
  minWalletEth: '钱包余额下限', maxNotionalUsd: '单笔名义上限', minEdgeBps: '粗筛毛收益门槛', minDepthUsd: '池子最小深度', tipShare: '小费占利润比例',
  minProfitRatio: '链上最低利润比例', maxSimulationsPerBlock: '每区块模拟条数',
};

export class SettingsError extends Error {
  constructor(message: string) { super(message); this.name = 'SettingsError'; }
}

/** 校验一整份参数（页面每次保存整份）；多出的键、缺的键、越界的值都拒绝。 */
export function parseSettings(raw: unknown): Settings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SettingsError('参数须为对象');
  const keys = Object.keys(RANGES) as (keyof Settings)[];
  const unknown = Object.keys(raw).filter(key => !(key in RANGES));
  if (unknown.length) throw new SettingsError(`不认识的参数：${unknown.join('、').slice(0, 100)}`);
  const result = {} as Settings;
  for (const key of keys) {
    const value = (raw as Record<string, unknown>)[key], [low, high, integer] = RANGES[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high || (integer && !Number.isInteger(value))) {
      throw new SettingsError(`${LABELS[key]}须为 ${low} 到 ${high} 之间的${integer ? '整数' : '数'}`);
    }
    result[key] = value;
  }
  return result;
}

/** 读库里存的参数：缺的项补默认值（升级后新增的参数），整份不合规时退回默认值。 */
export function storedSettings(raw: unknown): Settings {
  try { return parseSettings({ ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.fromEntries(Object.entries(raw).filter(([key]) => key in RANGES)) : {}) }); } catch { return { ...DEFAULT_SETTINGS }; }
}

const WEI = 1e18;
export const weiToEth = (wei: bigint): number => Number(wei) / WEI;
/** 小费下限：0.001 gwei。Base 的基础费常在这个量级，零小费的交易排在同区块的最后。 */
export const MIN_TIP_WEI = 1_000_000n;
/** gas 上限取估算值的 1.3 倍：状态在两个区块之间会变，路径上的 tick 穿越数不同。 */
const gasLimitOf = (estimate: bigint): bigint => estimate * 13n / 10n;

export interface PlanInput {
  /** 模拟得到的利润（起始代币最小单位）。 */
  profit: bigint;
  startDecimals: number;
  /** 一个起始代币的美元价。 */
  startUsd: number;
  ethUsd: number;
  gasEstimate: bigint;
  baseFee: bigint;
  l1Fee: bigint;
  settings: Settings;
  /** 同一个 nonce 上已发过交易时的费用下限（替换交易须加价）。 */
  feeFloor?: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
}

export type Plan =
  | { ok: true; gasLimit: bigint; maxPriorityFeePerGas: bigint; maxFeePerGas: bigint; minProfit: bigint; profitUsd: number; costUsd: number; netUsd: number; worstCostWei: bigint }
  | { ok: false; reason: string; profitUsd: number; costUsd: number; netUsd: number };

/** 一笔套利值不值得发、发的话费用与链上最低利润各是多少。 */
export function planTransaction({ profit, startDecimals, startUsd, ethUsd, gasEstimate, baseFee, l1Fee, settings, feeFloor }: PlanInput): Plan {
  const profitUsd = Number(profit) / 10 ** startDecimals * startUsd;
  const fail = (reason: string, costUsd = 0): Plan => ({ ok: false, reason, profitUsd, costUsd, netUsd: profitUsd - costUsd });
  if (!(ethUsd > 0) || !(startUsd > 0) || profit <= 0n || gasEstimate <= 0n || baseFee < 0n || l1Fee < 0n) return fail('测算依据无效');
  const gasLimit = gasLimitOf(gasEstimate);
  if (gasLimit > BigInt(settings.maxGasLimit)) return fail(`预估 gas ${gasLimit} 超过单笔上限 ${settings.maxGasLimit}`);
  const profitWei = BigInt(Math.floor(profitUsd / ethUsd * WEI));
  let tip = profitWei * BigInt(Math.round(settings.tipShare * 10_000)) / 10_000n / gasEstimate;
  if (tip < MIN_TIP_WEI) tip = MIN_TIP_WEI;
  let maxFee = baseFee * 3n + tip;
  if (feeFloor) {
    // 节点要求替换交易的两项费用都至少加 10%；取 25% 留余量。
    const bump = (value: bigint) => value * 5n / 4n + 1n;
    if (tip < bump(feeFloor.maxPriorityFeePerGas)) tip = bump(feeFloor.maxPriorityFeePerGas);
    if (maxFee < bump(feeFloor.maxFeePerGas)) maxFee = bump(feeFloor.maxFeePerGas);
    if (maxFee < baseFee + tip) maxFee = baseFee + tip;
  }
  const usdOf = (wei: bigint): number => weiToEth(wei) * ethUsd;
  const baseCostUsd = usdOf(gasEstimate * baseFee + l1Fee);
  const costUsd = usdOf(gasEstimate * (baseFee + tip) + l1Fee);
  const netUsd = profitUsd - costUsd;
  if (netUsd < settings.minNetUsd) return fail(`净利 ${netUsd.toFixed(4)} 美元低于门槛 ${settings.minNetUsd}`, costUsd);
  if (netUsd < settings.gasMultiple * baseCostUsd) return fail(`净利不到基础费用的 ${settings.gasMultiple} 倍`, costUsd);
  // 链上最低利润：不低于模拟利润的一个比例，也不低于这笔的费用，保证上链即不亏。
  const ratio = profit * BigInt(Math.round(settings.minProfitRatio * 10_000)) / 10_000n;
  const cost = BigInt(Math.ceil(costUsd / startUsd * 10 ** startDecimals));
  const minProfit = ratio > cost ? ratio : cost;
  if (minProfit > profit) return fail('费用超过模拟利润', costUsd);
  return { ok: true, gasLimit, maxPriorityFeePerGas: tip, maxFeePerGas: maxFee, minProfit, profitUsd, costUsd, netUsd, worstCostWei: gasLimit * maxFee + l1Fee * 2n };
}

export interface GateInput {
  settings: Settings;
  /** 今天（UTC）已结清交易的 gas 支出。 */
  spentTodayWei: bigint;
  /** 还没结清的交易按最坏情况预留的费用。 */
  reservedWei: bigint;
  /** 这一笔的最坏费用。 */
  worstCostWei: bigint;
  walletWei: bigint;
  consecutiveReverts: number;
}

/** 发送前的账户级检查：返回拦下的原因，可以发返回 null。`halt` 为真的原因同时停掉实盘。 */
export function gate({ settings, spentTodayWei, reservedWei, worstCostWei, walletWei, consecutiveReverts }: GateInput): { reason: string; halt: boolean } | null {
  if (consecutiveReverts >= settings.maxConsecutiveReverts) return { reason: `连续 ${consecutiveReverts} 笔上链回滚`, halt: true };
  if (weiToEth(walletWei) < settings.minWalletEth) return { reason: `热钱包余额 ${weiToEth(walletWei).toFixed(6)} ETH 低于下限 ${settings.minWalletEth}`, halt: true };
  if (weiToEth(spentTodayWei + reservedWei + worstCostWei) > settings.dailyGasBudgetEth) {
    // 预算真的用完才停实盘；只是这一笔放不进剩余预算时跳过这一笔。
    return { reason: `今日 gas 预算 ${settings.dailyGasBudgetEth} ETH 不够这一笔`, halt: weiToEth(spentTodayWei) >= settings.dailyGasBudgetEth };
  }
  if (walletWei < reservedWei + worstCostWei) return { reason: '热钱包余额不够支付这一笔的最坏费用', halt: false };
  return null;
}

/** UTC 日的起点（毫秒）。 */
export const utcDayStart = (at: number): number => Math.floor(at / 86_400_000) * 86_400_000;
