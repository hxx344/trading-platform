export const CHAIN_ARB_TTL_MS = 15_000;
export const CHAIN_ARB_CLOCK_SKEW_MS = 2_000;
export type Chain = 'ethereum' | 'arbitrum' | 'bsc';
export interface ChainArbInput {
  chain: Chain; address: string; symbol: string; amount: string;
  spotFeeBps: number; perpFeeBps: number; spotCosts: number | null; perpCosts: number | null;
}
export type ArbResult = { error: string } | {
  quantity: number; price: number; grossUsdt: number; spreadBps: number; netUsdt: number | null;
  at: number; remainder: number;
};
export interface ChainArbView {
  asOf: number; expiresAt: number; dex: { quantity: number; price: number; at: number };
  deposit: boolean | null; withdraw: boolean | null; spot: ArbResult; perp: ArbResult;
}

function invalid(message: string): never { throw Object.assign(new Error(message), { status: 400 }); }
function decimal(value: unknown, max: number, label: string): number {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,6})(?:\.\d{1,6})?$/.test(value) || Number(value) > max) invalid(label + '超出范围或格式无效');
  return Number(value);
}

export function parseChainArb(raw: unknown): ChainArbInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('查询参数无效');
  const p = raw as Record<string, unknown>;
  const keys = ['chain', 'address', 'symbol', 'amount', 'spotFeeBps', 'perpFeeBps', 'spotCosts', 'perpCosts'];
  if (Object.keys(p).some(key => !keys.includes(key))) invalid('查询含未知参数');
  if (p.chain !== 'ethereum' && p.chain !== 'arbitrum' && p.chain !== 'bsc') invalid('请选择支持的链');
  if (typeof p.address !== 'string' || !/^0x[0-9a-f]{40}$/i.test(p.address) || /^0x0{40}$/i.test(p.address)) invalid('请输入链上的代币合约地址');
  if (typeof p.symbol !== 'string' || !/^[A-Z0-9]{1,24}$/.test(p.symbol) || p.symbol === 'USDT') invalid('请输入 Gate 基础币代码');
  const amount = p.amount;
  if (typeof amount !== 'string' || decimal(amount, 1_000_000, '买入金额') <= 0) invalid('买入金额必须大于零');
  const costs = (value: unknown) => value === undefined || value === '' ? null : decimal(value, 1_000_000, '其他成本');
  return {
    chain: p.chain, address: p.address.toLowerCase(), symbol: p.symbol, amount,
    spotFeeBps: decimal(p.spotFeeBps, 100, '现货费率'), perpFeeBps: decimal(p.perpFeeBps, 100, '合约费率'),
    spotCosts: costs(p.spotCosts), perpCosts: costs(p.perpCosts),
  };
}
