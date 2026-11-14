// Types for market.mjs, only what the service's TypeScript uses; loose on purpose.
import type { CrossexConfig } from './model.mjs';
export interface CrossexMarket {
  view(options?: Record<string, unknown>): Record<string, unknown>;
  config(): Partial<CrossexConfig> & Record<string, unknown>;
  revision(): string;
  refresh(...args: unknown[]): Promise<unknown>;
  /** Reads the Monitor feed; this service never calls it (Monitor is not connected). */
  refreshSource(): Promise<unknown>;
  refreshCatalog(): Promise<unknown>;
  instruments(): Promise<unknown>;
  settings(input: unknown): unknown;
  /** Held legs (raw Gate positions) valued in USDT at mark price and the live FX rates; throws when one cannot be valued. */
  positionsNotional(positions: readonly unknown[]): Promise<string>;
  stop(): Promise<void>;
  [method: string]: unknown;
}
export function createMarket(store: unknown, options?: Record<string, unknown>): CrossexMarket;
