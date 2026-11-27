import type { Chain } from './model.ts';

export interface BitgetDepositProof {
  readonly symbol: string;
  readonly chain: Chain;
  readonly contract: string;
  readonly minDeposit: string;
  readonly at: number;
  readonly expiresAt: number;
}

export interface BitgetDepositSource {
  bitgetDepositConnected(): boolean;
  bitgetDepositProof(symbol: string, chain: Chain, contract: string, signal: AbortSignal): Promise<BitgetDepositProof>;
  bitgetDepositRecipient(proof: BitgetDepositProof): string | undefined;
  bitgetDepositCurrent(proof: BitgetDepositProof): boolean;
}

export const BITGET_DEPOSIT_TTL = 60_000;
