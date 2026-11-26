import type { Chain } from './model.ts';

export interface BinanceDepositProof {
  readonly symbol: string;
  readonly chain: Chain;
  readonly contract: string;
  readonly minDeposit: string;
  readonly at: number;
  readonly expiresAt: number;
}

export interface BinanceDepositSource {
  binanceDepositProof(symbol: string, chain: Chain, contract: string, signal: AbortSignal): Promise<BinanceDepositProof>;
  binanceDepositRecipient(proof: BinanceDepositProof): string | undefined;
  binanceDepositCurrent(proof: BinanceDepositProof): boolean;
}

export const BINANCE_DEPOSIT_TTL = 60_000;
