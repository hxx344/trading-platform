// Types for mm.mjs, only what the service's TypeScript uses; the snapshot the page reads stays loose.
export class HttpError extends Error { status: number; constructor(status: number, message: string) }
export interface OndoMmConfig {
  mode: 'observe' | 'live'; markets: string[]; orderUsd: string; targetBps: string; minBps: string; maxBps: string;
  wallEnabled: boolean; wallUsd: string; maxPositionUsd: string; maxTotalUsd: string; dwellMs: number; rps: number;
}
export const ONDO_MM_DEFAULTS: Readonly<OndoMmConfig>;
export function validateOndoMmConfig(value: unknown): OndoMmConfig;
export function validateCredentials(value: unknown): { keyId: string; secret: string };
export interface OndoRestingOrder { market: string; side: 'buy' | 'sell'; price: string; size: string }
export interface OndoMarketMaker {
  state(): Record<string, unknown> & { config: OndoMmConfig; phase: 'stopped' | 'stopping' | 'running'; live: boolean };
  tick(): Promise<void>;
  initialize(): void;
  save(value: unknown): Record<string, unknown>;
  start(input?: unknown, options?: { signal?: AbortSignal }): Promise<Record<string, unknown>>;
  stop(): Promise<Record<string, unknown>>;
  cleanup(): Promise<Record<string, unknown>>;
  discardRecovery(): Record<string, unknown>;
  prepareStop(): Promise<void>;
  restingOrders(): OndoRestingOrder[];
  close(waitMs?: number): Promise<void>;
}
export function createOndoMarketMaker(options: {
  dataDir: string;
  readCredentials?: () => { keyId: string; secret: string } | null;
  initialConfig?: unknown;
  closeWaitMs?: number;
  log?: { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void; debug?(...args: unknown[]): void };
  now?: () => number; intervalMs?: number; fetchImpl?: typeof fetch; WebSocketImpl?: unknown;
  clientFactory?: (options: Record<string, unknown>) => unknown; streamFactory?: (options: Record<string, unknown>) => unknown;
  sleep?: (ms: number) => Promise<void>;
}): OndoMarketMaker;
