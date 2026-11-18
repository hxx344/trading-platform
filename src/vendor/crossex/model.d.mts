// Types for model.mjs, only what the service's TypeScript imports; loose on purpose.
export class AppError extends Error {
  constructor(message: string, status?: number);
  status: number;
  /** Set by the live runtime when a write provably never left the service. */
  requestStatus?: string;
}
export interface CrossexConfig {
  enabled: boolean; entryPaused: boolean; monitorUrl: string; monitorUsername: string;
  notionalPerLeg: number; maxOpen: number; maxTotalNotional: number;
  feeBps: number; feeSchedule: unknown[]; slippageBps: number; minNetBps: number; cooldownSeconds: number;
  [key: string]: unknown;
}
export const defaults: Readonly<CrossexConfig>;
export function validIdentity(quote: unknown): boolean;
export function validManualIdentity(quote: unknown): boolean;
export function validateBooks(books: unknown[], now: number): void;
export function configuration(input: Record<string, unknown>, previous?: Record<string, unknown>): CrossexConfig;
