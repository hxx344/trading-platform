import { isGateBaseSymbol, type Chain } from './model.ts';

export interface GateDepositProof { symbol: string; chain: Chain; minDeposit: string; at: number; expiresAt: number }
export interface GateDepositSource {
  gateDepositProof(symbol: string, chain: Chain, signal: AbortSignal): Promise<GateDepositProof>;
  gateDepositRecipient?(proof: GateDepositProof): string | undefined;
  gateDepositCurrent(proof: GateDepositProof): boolean;
}
export const GATE_DEPOSIT_TTL = 60_000;

export function isGateDepositRequest(symbol: unknown, chain: unknown): boolean {
  return isGateBaseSymbol(symbol) && (chain === 'ethereum' || chain === 'arbitrum' || chain === 'bsc');
}
