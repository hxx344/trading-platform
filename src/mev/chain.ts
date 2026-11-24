// Base 主网上本模块用到的地址与池型（docs/mev.md 第 7 节）。2026-11-25 在链上逐个核对：工厂的 getPool / isPool 应答、
// 池子实现里的 swap 与回调选择器、Multicall3 与 GasPriceOracle 有代码。换链或加工厂时同样先核对再写进来。
export const BASE_CHAIN_ID = 8453n;

export const WETH = '0x4200000000000000000000000000000000000006';
export const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
/** Multicall3，各链同一地址。 */
export const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
/** OP Stack 预部署的 GasPriceOracle：`getL1Fee(bytes)` 给出一笔交易的 L1 数据费。 */
export const GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000f';

/** 与执行合约里的 KIND_* 一致。 */
export const KIND_V3 = 1, KIND_SLIPSTREAM = 2, KIND_AERO_V2 = 3;
export type PoolKind = typeof KIND_V3 | typeof KIND_SLIPSTREAM | typeof KIND_AERO_V2;
export const KIND_LABELS: Record<PoolKind, string> = { [KIND_V3]: 'Uniswap v3', [KIND_SLIPSTREAM]: 'Aerodrome Slipstream', [KIND_AERO_V2]: 'Aerodrome v2' };

export interface FactoryInfo { address: string; kind: PoolKind; /** v3 的费率档（百万分比）或 Slipstream 的 tickSpacing；v2 不用。 */ tiers: readonly bigint[] }

export const FACTORIES: readonly FactoryInfo[] = [
  { address: '0x33128a8fc17869897dce68ed026d694621f6fdfd', kind: KIND_V3, tiers: [100n, 500n, 3000n, 10000n] },
  { address: '0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a', kind: KIND_SLIPSTREAM, tiers: [1n, 50n, 100n, 200n, 2000n] },
  // 只用波动池（stable = false）：稳定池的曲线不同，现货价粗筛不适用，登记在 docs/mev.md「本次不做」。
  { address: '0x420dd381b31aef6683db6b902084cb0ffece40da', kind: KIND_AERO_V2, tiers: [] },
];

export interface TokenInfo { address: string; symbol: string; decimals: number }

/** 环路的起止代币：利润按它们计。 */
export const START_TOKENS: readonly TokenInfo[] = [
  { address: WETH, symbol: 'WETH', decimals: 18 },
  { address: USDC, symbol: 'USDC', decimals: 6 },
];

/** 首次启动时写进白名单的中间代币；之后以页面上的白名单为准。精度与符号在加入时从链上读取并核对。 */
export const DEFAULT_MIDDLE_TOKENS: readonly string[] = [
  '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf', // cbBTC
  '0x940181a94a35a4569e4529a3cdfb74e38fd98631', // AERO
  '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22', // cbETH
  '0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452', // wstETH
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb', // DAI
  '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2', // USDT
];
