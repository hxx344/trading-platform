// Base 主网上本模块用到的地址与池型（docs/mev.md 第 7 节）。2026-11-25 与 2026-11-28 在链上逐个核对：工厂的 getPool / getPair /
// isPool 应答、费率档、池子实现里的 swap 与回调选择器、v2 类池子代码里的费率常数（与各自路由的 getAmountOut 一致）、
// Multicall3 与 GasPriceOracle 有代码。换链或加工厂时同样先核对再写进来。
export const BASE_CHAIN_ID = 8453n;

export const WETH = '0x4200000000000000000000000000000000000006';
export const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
/** Multicall3，各链同一地址。 */
export const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
/** OP Stack 预部署的 GasPriceOracle：`getL1Fee(bytes)` 给出一笔交易的 L1 数据费。 */
export const GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000f';

/** 与执行合约里的 KIND_* 一致。v3 式（含 SushiSwap v3、PancakeSwap v3）按 fee 查池子，Slipstream 按 tickSpacing 查。 */
export const KIND_V3 = 1, KIND_SLIPSTREAM = 2, KIND_AERO_V2 = 3, KIND_V2 = 4;
export type PoolKind = typeof KIND_V3 | typeof KIND_SLIPSTREAM | typeof KIND_AERO_V2 | typeof KIND_V2;

export interface FactoryInfo {
  address: string; kind: PoolKind;
  /** 页面与通知里显示的场所名。 */
  label: string;
  /** v3 的费率档（百万分比）或 Slipstream 的 tickSpacing；v2 类与 Aerodrome v2 不用。 */
  tiers: readonly bigint[];
  /** v2 类池子的费率（万分比），部署时登记进执行合约；其他池型为 0。 */
  feeBps: number;
}

export const FACTORIES: readonly FactoryInfo[] = [
  { address: '0x33128a8fc17869897dce68ed026d694621f6fdfd', kind: KIND_V3, label: 'Uniswap v3', tiers: [100n, 200n, 300n, 400n, 500n, 3000n, 10000n], feeBps: 0 },
  { address: '0xc35dadb65012ec5796536bd9864ed8773abc74c4', kind: KIND_V3, label: 'SushiSwap v3', tiers: [100n, 500n, 3000n, 10000n], feeBps: 0 },
  // PancakeSwap v3 的池子回调 pancakeV3SwapCallback，执行合约有同名入口。
  { address: '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865', kind: KIND_V3, label: 'PancakeSwap v3', tiers: [100n, 500n, 2500n, 10000n], feeBps: 0 },
  { address: '0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a', kind: KIND_SLIPSTREAM, label: 'Aerodrome Slipstream', tiers: [1n, 10n, 50n, 100n, 200n, 2000n], feeBps: 0 },
  { address: '0xade65c38cd4849adba595a4323a8c7ddfe89716a', kind: KIND_SLIPSTREAM, label: 'Aerodrome Slipstream 2', tiers: [1n, 10n, 50n, 100n, 200n, 2000n], feeBps: 0 },
  // 只用波动池（stable = false）：稳定池的曲线不同，现货价粗筛不适用，登记在 docs/mev.md「本次不做」。
  { address: '0x420dd381b31aef6683db6b902084cb0ffece40da', kind: KIND_AERO_V2, label: 'Aerodrome v2', tiers: [], feeBps: 0 },
  { address: '0x8909dc15e40173ff4699343b6eb8132c65e18ec6', kind: KIND_V2, label: 'Uniswap v2', tiers: [], feeBps: 30 },
  { address: '0x71524b4f93c58fcbf659783284e38825f0622859', kind: KIND_V2, label: 'SushiSwap v2', tiers: [], feeBps: 30 },
  // BaseSwap 的池子回调 pancakeCall。
  { address: '0xfda619b6d20975be80a10332cd39b9a4b0faa8bb', kind: KIND_V2, label: 'BaseSwap', tiers: [], feeBps: 25 },
  { address: '0x3e84d913803b02a4a7f027165e8ca42c14c0fde7', kind: KIND_V2, label: 'AlienBase', tiers: [], feeBps: 16 },
];

const LABELS = new Map(FACTORIES.map(factory => [factory.address, factory.label]));
/** 池子所属工厂的场所名；不在登记表里的显示地址前缀。 */
export const factoryLabel = (address: string): string => LABELS.get(address) ?? address.slice(0, 10);

export interface TokenInfo { address: string; symbol: string; decimals: number }

/** 环路的起止代币：利润按它们计。 */
export const START_TOKENS: readonly TokenInfo[] = [
  { address: WETH, symbol: 'WETH', decimals: 18 },
  { address: USDC, symbol: 'USDC', decimals: 6 },
];

/**
 * 默认的中间代币：首次启动写进白名单，之后以页面上的白名单为准。精度与符号在加入时从链上读取并核对。
 * 后来加进这张表的代币，已初始化过的库在下次刷新目录时补入一次；用户移除过的不再加回（engine.ts 的 seededTokens）。
 */
export const DEFAULT_MIDDLE_TOKENS: readonly string[] = [
  '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf', // cbBTC
  '0x940181a94a35a4569e4529a3cdfb74e38fd98631', // AERO
  '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22', // cbETH
  '0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452', // wstETH
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb', // DAI
  '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2', // USDT
  // v0.116.0 起
  '0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42', // EURC
  '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca', // USDbC
  '0x820c137fa70c8691f0e44dc420a5e53c168921dc', // USDS
  '0x04c0599ae5a44757c0af6f9ec3b93da8976c150a', // weETH
  '0x2416092f143378750bb29b79ed961ab195cceea5', // ezETH
  '0xb6fe221fe9eef5aba221c348ba20a1bf5e73624c', // rETH
  '0xecac9c5f704e954931349da37f60e39f515c11c1', // LBTC
  '0x236aa50979d5f3de3bd1eeb40e81137f22ab794b', // tBTC
  '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b', // VIRTUAL
  '0x4ed4e862860bed51a9570b96d89af5e1b0efefed', // DEGEN
  '0x532f27101965dd16442e59d40670faf5ebb142e4', // BRETT
  '0xac1bd2486aaf3b5c0fc3fd868558b082a531b2b4', // TOSHI
  '0xbaa5cc21fd487b8fcc2f632f3f4e8d37262a0842', // MORPHO
  '0x4f9fd6be4a90f2620860d680c0d4d5fb53d1a825', // AIXBT
  '0x1111111111166b7fe7bd91427724b487980afc69', // ZORA
  '0xa88594d404727625a9437c3f886c7643872296ae', // WELL
];
