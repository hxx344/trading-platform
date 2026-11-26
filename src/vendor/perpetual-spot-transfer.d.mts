export interface SpotAsset {
  base: string; spotSymbols: string[]; networks: { network: string; contract: string; deposit: boolean; withdraw: boolean }[];
}
export type SpotTransferVenue = 'binance' | 'gate';
export type SpotTransferReader = (exchange: SpotTransferVenue, signal: AbortSignal) => Promise<{ at: number; assets: Map<string, SpotAsset> }>;
export function createSpotTransferReader(options?: { clock?: () => number; fetchImpl?: (url: string, init: RequestInit) => Promise<Response> }): SpotTransferReader;
