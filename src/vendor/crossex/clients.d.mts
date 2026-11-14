// Types for clients.mjs, only what the service's TypeScript imports; loose on purpose.
export type CrossexFetcher = (url: string, init?: RequestInit) => Promise<Response>;
export interface PublicClients {
  loadCatalog(): Promise<unknown>;
  loadFeed(...args: unknown[]): Promise<unknown>;
  loadDepth(quote: unknown): Promise<unknown>;
  loadManualDepth(quote: unknown): Promise<unknown>;
  loadFx(...args: unknown[]): Promise<unknown>;
  resolveCrossexQuote(symbol: string): Promise<unknown>;
  resolveManualQuote(symbol: string): Promise<unknown>;
}
export function createPublicClients(options?: { fetcher?: CrossexFetcher; WebSocketImpl?: unknown; clock?: () => number; timeoutMs?: number }): PublicClients;
export const CATALOG_URL: string;
