import type { CrossExSettings } from './perpetual-crossex-eligibility.ts';
import type { SavedCrossExSettings } from '../monitor/perpetual-crossex-store.ts';
import type { SpotTransferReader } from './perpetual-spot-transfer.mjs';
import type { PerpetualQuote } from './perpetual-stream.mjs';
export interface CrossExFilterOptions {
  store?: { get(): SavedCrossExSettings; save(state: SavedCrossExSettings): void | Promise<void>; adoptPending?(): SavedCrossExSettings | null };
  read?: SpotTransferReader; unavailableReason?: string; intervalMs?: number; clock?: () => number;
}
export interface CrossExFilter {
  enabled: boolean; requireSpotTransfer: boolean; blockedBases: string[]; revision: number; version: string;
  evaluate(long: PerpetualQuote, short: PerpetualQuote, at: number): null | { networks?: string[]; checkedAt?: number; expiresAt?: number };
}
export function createCrossExFilterService(options: CrossExFilterOptions): {
  start(): void; stop(): Promise<void>; checkImport(): void; resetSource(): void; storageError(): string;
  view(): CrossExSettings; update(input: unknown): Promise<CrossExSettings>; filter(): CrossExFilter;
};
