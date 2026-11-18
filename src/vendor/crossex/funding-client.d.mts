export function createFundingClient(options?: { fetcher?: (url: string, init?: RequestInit) => Promise<Response>; clock?: () => number; WebSocketImpl?: unknown; signal?: AbortSignal }): {
  current(quote: unknown, signal?: AbortSignal): Promise<unknown>;
  read(quote: unknown, from: number, to: number, signal?: AbortSignal): Promise<unknown>;
};
