export interface CandleRange { from: number; to: number }
export function createCandleReader(options?: { fetcher?: (url: string, init?: RequestInit) => Promise<Response>; clock?: () => number }): (quote: unknown, interval: string, signal?: AbortSignal, range?: CandleRange) => Promise<unknown[]>;
