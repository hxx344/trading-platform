// Types for perpetual-depth.mjs (the workbench's execution service, c84ba27): only what this service calls.
import type { PerpetualFxSnapshot } from './perpetual-fx.ts';
import type { PerpetualDepthEstimate } from './perpetual-execution.ts';
import type { PerpetualExitEstimate } from './perpetual-exit.ts';
import type { PerpetualMarket, PerpetualQuote } from './perpetual-stream.mjs';

export interface InspectionSocket {
  on(type: 'open' | 'error' | 'close', listener: () => void): void;
  on(type: 'message', listener: (data: unknown) => void): void;
  send(data: string): void;
  terminate(): void;
}
export type InspectionSocketFactory = new (url: string) => InspectionSocket;
export declare class NodeWebSocket implements InspectionSocket {
  constructor(url: string);
  on(type: 'open' | 'error' | 'close', listener: () => void): void;
  on(type: 'message', listener: (data: unknown) => void): void;
  send(data: string): void;
  terminate(): void;
}

export interface PerpetualExecutionOptions {
  getQuote: (exchange: string, symbol: string) => PerpetualQuote | undefined;
  getMarket?: (exchange: string, symbol: string) => PerpetualMarket | undefined | null;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  clock?: () => number;
  WebSocketImpl?: InspectionSocketFactory;
  maxMarkets?: number; cacheMs?: number;
}
export interface PerpetualExecutionService {
  fx(): Promise<PerpetualFxSnapshot>;
  peekFx(): PerpetualFxSnapshot | null;
  depth(input: unknown): Promise<PerpetualDepthEstimate>;
  exit(input: unknown): Promise<PerpetualExitEstimate>;
  metrics(): { inFlight: number; queued: number; recentRequests: number; blockedUntil: number; cachedMarkets: number; maxMarkets: number; metadataMarkets: number; fxAt: number | null };
  stop(): void;
}
export declare function createPerpetualExecutionService(options: PerpetualExecutionOptions): PerpetualExecutionService;
