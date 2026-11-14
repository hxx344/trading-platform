// Types for live-client.mjs, only what the service's TypeScript imports; loose on purpose.
export interface GateClient {
  /** GET /account/detail: user_id is the account UID (a positive safe integer). */
  getAccountDetail(): Promise<{ user_id?: number; [key: string]: unknown }>;
  [method: string]: unknown;
}
export interface GateClientOptions {
  apiKey: string; apiSecret: string;
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
  clock?: () => number; timeoutMs?: number; beforeSubmit?: unknown;
}
export function createGateClient(options: GateClientOptions): GateClient;
export class GateClientError extends Error { [key: string]: unknown }
export const GATE_ORDER_STATES: readonly string[];
export const GATE_TERMINAL_STATES: readonly string[];
export const GATE_EXCHANGES: readonly string[];
