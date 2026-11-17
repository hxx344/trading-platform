// 改编自 project-aggregation 工作台 src/ondo-mm-types.ts（提交 7745181）；挂单配置与服务共用类型。
import type { OndoMmConfig } from '../../../src/vendor/ondo/mm.mjs';
import type { OndoLatencySnapshot } from '../../../src/vendor/ondo/latency.mjs';
import type { OndoObservationEarnings } from '../../../src/ondo/reward-types.ts';
export type { OndoMmConfig };
export type OndoMmSide = {
  role: 'quote' | 'close'; state: 'none' | 'planned' | 'sending' | 'open' | 'canceling' | 'unknown';
  price?: string; size?: string; bps?: number; mode?: 'wall' | 'close' | 'ioc' | null; protection?: string; reason?: string;
};
export type OndoMmMarket = {
  market: string; hold: string | null; listed: boolean; trading: boolean | null; tick: string | null; bid: string | null; ask: string | null; bookAt: number | null;
  position: string | null; synced: boolean; buy: OndoMmSide; sell: OndoMmSide; lastCancel: string | null; error: string | null;
  exitStatus?: string | null;
};
export type OndoMmEvent = { at: string; market: string | null; kind: string; text: string };
export type OndoObservation = {
  startedAt: number; endedAt: number | null;
  earnings?: OndoObservationEarnings;
  rows: {
    market: string; side: 'buy' | 'sell'; distanceBps: 4 | 8 | 15; activeMs: number;
    touches: number; sweeps: number; touchesPerHour: number | null; sweepsPerHour: number | null;
  }[];
};
export type OndoMmSnapshot = {
  schema: 1; phase: 'stopped' | 'running' | 'stopping'; sessionId: string | null; live: boolean; startedAt: string | null;
  config: OndoMmConfig; revision: number; activeConfig: OndoMmConfig | null;
  credentials: { configured: boolean; hint: string | null; error: string | null };
  paused: boolean; pauseReason: string | null; halt: string | null; lastError: string | null; cooldownUntil: number | null;
  stream: { connected: boolean; publicReady: boolean; privateReady: boolean; deadManReady: boolean; lastFrameAt: number | null; error: string | null } | null;
  syncError: string | null; rulesError: string | null;
  totals: { placed: number; canceled: number; rejected: number; postOnly: number; fills: number } | null;
  markets: OndoMmMarket[];
  leftPositions: { market: string; position: string }[];
  incident: { at: number; market: string; reason: string } | null;
  observation: OndoObservation | null;
  latency?: OndoLatencySnapshot | null;
  recovery: { startedAt: string | null; error: string | null; cleaning: boolean } | null;
  events: OndoMmEvent[]; loadError: string | null; serverNow: number;
};
