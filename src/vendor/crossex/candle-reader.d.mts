export function createCandleReader(options?: { fetcher?: (url: string, init?: RequestInit) => Promise<Response>; clock?: () => number }): (quote: unknown, interval: string) => Promise<unknown[]>;
