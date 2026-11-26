export const CHAIN_ARB_TTL_MS = 15_000;
export const CHAIN_ARB_CLOCK_SKEW_MS = 2_000;
export const CHAIN_ARB_MAX_IMPACT_BPS = 500;
export type Chain = 'ethereum' | 'arbitrum' | 'bsc';
export const VENUE_NAMES = { gate: 'Gate', binance: 'Binance', bitget: 'Bitget', okx: 'OKX' } as const;
export type DepositVenue = 'gate' | 'okx' | 'binance';
export function isDepositVenue(venue: unknown): venue is DepositVenue {
  return venue === 'gate' || venue === 'okx' || venue === 'binance';
}
export type ChainArbVenue = keyof typeof VENUE_NAMES;
export function isChainArbVenue(value: unknown): value is ChainArbVenue {
  return typeof value === 'string' && Object.hasOwn(VENUE_NAMES, value);
}
export interface ChainArbInput {
  venue?: ChainArbVenue;
  chain: Chain; address: string; symbol: string; amount: string;
  spotFeeBps: number; perpFeeBps: number; spotCosts: number | null; perpCosts: number | null;
  swapGas?: 'auto';
  source?: 'scan';
}
export type ArbResult = { error: string; rateLimited?: true } | {
  quantity: number; price: number; grossUsdt: number; spreadBps: number; netUsdt: number | null;
  netBps: number | null; coveredCostUsdt: number;
  at: number; remainder: number;
};

export function isConsistentArbEstimate(leg: ArbResult): leg is Exclude<ArbResult, { error: string }> {
  if ('error' in leg || ![leg.coveredCostUsdt, leg.quantity, leg.price].every(value => Number.isFinite(value) && value > 0)) return false;
  // Each decimal result is rounded independently for display. Allow that rounding when reconciling USDT with bp.
  const matchesRate = (amount: number, rate: number) => {
    const expected = amount / leg.coveredCostUsdt * 10_000;
    return Number.isFinite(expected) && Number.isFinite(rate) && Math.sign(amount) === Math.sign(rate)
      && Math.abs(expected - rate) <= 4 * Number.EPSILON * Math.max(Math.abs(expected), Math.abs(rate));
  };
  if (!matchesRate(leg.grossUsdt, leg.spreadBps)) return false;
  if (leg.netUsdt === null || leg.netBps === null) return leg.netUsdt === null && leg.netBps === null;
  return matchesRate(leg.netUsdt, leg.netBps) && leg.netUsdt <= leg.grossUsdt && leg.netBps <= leg.spreadBps;
}

export function isManualEstimate(leg: ArbResult): boolean {
  return isConsistentArbEstimate(leg) && (leg.netUsdt === null || leg.netUsdt <= 0);
}

export interface ChainArbView {
  screenedUnprofitable?: true;
  manualEstimateOnly?: true;
  asOf: number; expiresAt: number; dex: {
    quantity: number; price: number; at: number; swapGasUsdt: number | null;
    execution?: { depositVenue?: DepositVenue; depositExpiresAt?: number; quotedQuantity: number; receivedQuantity: number; transferQuantity: number | null; transferAmount?: string | null; impactBps: number; blockNumber: string };
  };
  deposit: boolean | null; withdraw: boolean | null; spot: ArbResult; perp: ArbResult;
}

function invalid(message: string): never { throw Object.assign(new Error(message), { status: 400 }); }
// Gate lists literal Unicode tickers. Keep their exact spelling and the existing uppercase convention for ASCII.
export function isGateBaseSymbol(value: unknown): value is string {
  if (typeof value !== 'string' || value === 'USDT' || value.length > 48) return false;
  if (/^[a-z0-9]+$/i.test(value)) return /^[A-Z0-9]{1,24}$/.test(value);
  return /^[\p{L}\p{Nd}]{1,24}$/u.test(value) && !/\p{Default_Ignorable_Code_Point}/u.test(value);
}

function decimal(value: unknown, max: number, label: string): number {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,6})(?:\.\d{1,6})?$/.test(value) || Number(value) > max) invalid(label + '超出范围或格式无效');
  return Number(value);
}

export function parseChainArbBudget(p: Record<string, unknown>) {
  const amount = p.amount;
  if (typeof amount !== 'string' || decimal(amount, 1_000_000, '买入金额') <= 0) invalid('买入金额必须大于零');
  const costs = (value: unknown) => value === undefined || value === '' ? null : decimal(value, 1_000_000, '其他成本');
  return { amount, spotFeeBps: decimal(p.spotFeeBps, 100, '现货费率'), perpFeeBps: decimal(p.perpFeeBps, 100, '合约费率'),
    spotCosts: costs(p.spotCosts), perpCosts: costs(p.perpCosts) };
}

export function parseChainArb(raw: unknown): ChainArbInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('查询参数无效');
  const p = raw as Record<string, unknown>;
  const keys = ['chain', 'address', 'symbol', 'amount', 'spotFeeBps', 'perpFeeBps', 'spotCosts', 'perpCosts', 'swapGas', 'source', 'venue'];
  if (Object.keys(p).some(key => !keys.includes(key))) invalid('查询含未知参数');
  if (p.swapGas !== undefined && p.swapGas !== 'auto') invalid('链上 Gas 模式无效');
  if (p.source !== undefined && p.source !== 'scan') invalid('查询来源无效');
  if (p.venue !== undefined && !isChainArbVenue(p.venue)) invalid('交易所无效');
  if (p.chain !== 'ethereum' && p.chain !== 'arbitrum' && p.chain !== 'bsc') invalid('请选择支持的链');
  if (typeof p.address !== 'string' || !/^0x[0-9a-f]{40}$/i.test(p.address) || /^0x0{40}$/i.test(p.address)) invalid('请输入链上的代币合约地址');
  if (!isGateBaseSymbol(p.symbol)) invalid('请输入交易所基础币代码');
  return { ...parseChainArbBudget(p), chain: p.chain, address: p.address.toLowerCase(), symbol: p.symbol,
    ...(p.venue === undefined ? {} : { venue: p.venue }), ...(p.swapGas === 'auto' ? { swapGas: 'auto' } : {}), ...(p.source === 'scan' ? { source: 'scan' } : {}) };
}
