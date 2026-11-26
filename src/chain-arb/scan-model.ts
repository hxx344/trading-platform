import { CHAIN_ARB_MAX_IMPACT_BPS, isChainArbVenue, parseChainArbBudget, type Chain, type ChainArbVenue } from './model.ts';
import { isObject } from '../contracts.ts';

export const SCAN_HISTORY_MS = 5 * 60_000;
export interface ScanExecution { receivedQuantity: number; transferQuantity: number; transferAmount?: string | null; impactBps: number; blockNumber: string }
export function isVerifiedExecution(value: unknown): value is ScanExecution {
  return isObject(value) && typeof value.receivedQuantity === 'number' && Number.isFinite(value.receivedQuantity)
    && typeof value.transferQuantity === 'number' && value.transferQuantity > 0 && value.receivedQuantity >= value.transferQuantity
    && typeof value.impactBps === 'number' && value.impactBps >= 0 && value.impactBps <= CHAIN_ARB_MAX_IMPACT_BPS
    && typeof value.blockNumber === 'string' && /^0x[1-9a-f][0-9a-f]{0,63}$/i.test(value.blockNumber);
}

export interface ScanInput {
  venue?: ChainArbVenue;
  chain: Chain | 'all'; amount: string; spotFeeBps: string; perpFeeBps: string; spotCosts: string; perpCosts: string;
}
export interface ScanRow {
  venue?: ChainArbVenue;
  chain: Chain; symbol: string; address: string; kind: 'spot' | 'perp'; netBps: number; netUsdt: number;
  dexPrice: number; gatePrice: number; at: number; expiresAt: number; gasUsdt: number;
  execution?: ScanExecution;
}
export interface ScanView {
  asOf: number; phase: 'loading' | 'scanning' | 'cooldown' | 'error'; cycle: number; total: number;
  checked: number; failed: number; message: string | null; rows: ScanRow[]; history: ScanRow[];
}

function invalid(message: string): never { throw Object.assign(new Error(message), { status: 400 }); }

export function parseChainArbScan(raw: unknown): ScanInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('扫描参数无效');
  const fields = raw as Record<string, unknown>;
  const keys = ['chain', 'amount', 'spotFeeBps', 'perpFeeBps', 'spotCosts', 'perpCosts', 'venue'];
  if (Object.keys(fields).some(key => !keys.includes(key))) invalid('扫描含未知参数');
  const chain = fields.chain;
  if (fields.venue !== undefined && !isChainArbVenue(fields.venue)) invalid('交易所无效');
  if (chain !== 'all' && chain !== 'ethereum' && chain !== 'arbitrum' && chain !== 'bsc') invalid('请选择支持的链');
  const input = parseChainArbBudget(fields);
  if (input.spotCosts === null || input.perpCosts === null) invalid('请填写两条路线的其他成本，可明确填 0');
  return { ...(fields.venue === undefined ? {} : { venue: fields.venue }), chain, amount: String(Number(input.amount)),
    spotFeeBps: String(input.spotFeeBps), perpFeeBps: String(input.perpFeeBps),
    spotCosts: String(input.spotCosts), perpCosts: String(input.perpCosts) };
}
