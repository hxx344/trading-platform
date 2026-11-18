// Types for clients.mjs, only what the service's TypeScript imports; loose on purpose.
export type CrossexFetcher = (url: string, init?: RequestInit) => Promise<Response>;
export interface PublicClients {
  loadCatalog(): Promise<unknown>;
  loadFeed(...args: unknown[]): Promise<unknown>;
  loadDepth(quote: unknown, signal?: AbortSignal): Promise<unknown>;
  loadManualDepth(quote: unknown, signal?: AbortSignal): Promise<unknown>;
  loadFx(...args: unknown[]): Promise<unknown>;
  resolveCrossexQuote(symbol: string, signal?: AbortSignal): Promise<unknown>;
  resolveManualQuote(symbol: string, signal?: AbortSignal): Promise<unknown>;
}
export function createPublicClients(options?: { fetcher?: CrossexFetcher; WebSocketImpl?: unknown; clock?: () => number; timeoutMs?: number; signal?: AbortSignal }): PublicClients;
export const loadDepth: PublicClients['loadDepth'];
export const loadManualDepth: PublicClients['loadManualDepth'];
export const CATALOG_URL: string;
