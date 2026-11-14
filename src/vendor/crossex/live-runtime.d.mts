// Types for live-runtime.mjs, only what the service's TypeScript uses; loose on purpose.
import type { CrossexMarket } from './market.mjs';
import type { GateClient, GateClientOptions } from './live-client.mjs';
export interface CrossexConnectionView {
  configured: boolean; connected: boolean; status: string; accountId: string | null;
  keySuffix: string | null; apiKeySuffix: string | null; version: number; positionMode: string | null;
  permissions: { read: string; trade: string }; lastVerifiedAt: number | null; error: string | null;
}
export interface CrossexLiveRuntime {
  connection(input: { apiKey: string; apiSecret: string; exchangeType?: string }): Promise<unknown>;
  disconnect(): Promise<unknown>;
  refresh(options?: { includeView?: boolean; [key: string]: unknown }): Promise<unknown>;
  preview(input: unknown): Promise<unknown>;
  openCapacity(input: unknown): Promise<unknown>;
  confirm(input: unknown): Promise<unknown>;
  cancel(input: unknown): Promise<unknown>;
  requestStatus(requestId: unknown): Promise<unknown>;
  refreshDetails(): Promise<unknown>;
  view(options?: Record<string, unknown>): Record<string, any>;
  connectionView(): CrossexConnectionView;
  summary(): { updatedAt: string | null; health: { state: string; message: string }; metrics: { key: string; label: string; value: number; unit: string }[]; [key: string]: unknown };
  updateStatus(): { busy: boolean; reason?: string };
  stop(): Promise<void>;
}
export interface CrossexLiveOptions {
  market: CrossexMarket;
  clientFactory?: (options: GateClientOptions) => GateClient;
  clock?: () => number;
  [key: string]: unknown;
}
export function createLiveRuntime(store: unknown, options: CrossexLiveOptions): CrossexLiveRuntime;
