export function createFundingClient(options?: { fetcher?: (url: string, init?: RequestInit) => Promise<Response>; clock?: () => number; WebSocketImpl?: unknown; signal?: AbortSignal }): {
  current(quote: unknown): Promise<unknown>;
  read(quote: unknown, from: number, to: number): Promise<unknown>;
};
