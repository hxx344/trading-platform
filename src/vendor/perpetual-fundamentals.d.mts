// Types for perpetual-fundamentals.mjs (the workbench's CoinGecko fundamentals client, c84ba27).
import type { TokenFundamentals } from './perpetual-quality.ts';

export interface FundamentalsDescription {
  base: string; coinId: string | null;
  status: 'pending' | 'unsupported' | 'unmapped' | 'ambiguous' | 'stale' | 'missing' | 'ready';
  reason: string | null; updatedAt?: number | null; candidates?: unknown[];
}
export interface FundamentalsClient {
  /** Fetches the markets of the bases whose cache expired; rejects with `status` (and `retryAfter`) on an HTTP refusal. */
  refresh(bases: string[], options?: { signal?: AbortSignal }): Promise<unknown>;
  get(base: string): TokenFundamentals | null | undefined;
  describe(base: string): FundamentalsDescription;
}
export interface FundamentalsClientOptions {
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  /** Base to CoinGecko id, on top of the built-in canonical ids. */
  coinIds?: Record<string, string>;
  /** CoinGecko demo key (x-cg-demo-api-key); empty for the keyless public limit. */
  apiKey?: string;
  clock?: () => number;
}
export declare function createFundamentalsClient(options?: FundamentalsClientOptions): FundamentalsClient;
