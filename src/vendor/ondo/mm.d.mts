// Types for mm.mjs, only what the service's TypeScript uses; the snapshot the page reads stays loose.
export class HttpError extends Error { status: number; constructor(status: number, message: string) }
export interface OndoMmConfig {
  mode: 'observe' | 'live'; markets: string[]; orderUsd: string; targetBps: string; minBps: string; maxBps: string;
  wallEnabled: boolean; wallUsd: string; maxPositionUsd: string; maxTotalUsd: string; dwellMs: number; rps: number;
  maxHoldSec: number; maxLossBps: string; exitSlippageBps: string; exitMode: 'makerThenIoc' | 'makerThenManual';
}
export const ONDO_MM_DEFAULTS: Readonly<OndoMmConfig>;
export function validateOndoMmConfig(value: unknown): OndoMmConfig;
export function readOndoMmConfig(value: unknown): OndoMmConfig;
type ExitKey = 'maxHoldSec' | 'maxLossBps' | 'exitSlippageBps' | 'exitMode';
export function splitOndoMmConfig(config: OndoMmConfig): { config: Omit<OndoMmConfig, ExitKey>; exit: Pick<OndoMmConfig, ExitKey> };
export function validateCredentials(value: unknown): { keyId: string; secret: string };
export interface OndoRestingOrder { market: string; side: 'buy' | 'sell'; price: string; size: string }
export interface OndoMarketMaker {
  state(): Record<string, unknown> & { config: OndoMmConfig; phase: 'stopped' | 'stopping' | 'running'; live: boolean; latency: import('./latency.mjs').OndoLatencySnapshot | null };
  tick(): Promise<void>;
  initialize(): void;
  save(value: unknown): Record<string, unknown>;
  start(input?: unknown, options?: { signal?: AbortSignal }): Promise<Record<string, unknown>>;
  stop(expected?: { sessionId?: unknown; live?: unknown }): Promise<Record<string, unknown>>;
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
  notifyRisk?: (key: string, text: string) => void;
  createObservationEstimator?: (config: OndoMmConfig) => import('../../ondo/observation-earnings.ts').ObservationEstimator;
  closeWaitMs?: number;
  log?: { info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void; debug?(...args: unknown[]): void };
  now?: () => number; monotonicNow?: () => number; intervalMs?: number; fetchImpl?: typeof fetch; WebSocketImpl?: unknown;
  clientFactory?: (options: Record<string, unknown>) => unknown; streamFactory?: import('./stream.mjs').OndoStreamFactory;
  sleep?: (ms: number) => Promise<void>;
}): OndoMarketMaker;
