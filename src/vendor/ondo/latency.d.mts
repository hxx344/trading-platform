export interface OndoLatencyMetric {
  lastMs: number | null; p50Ms: number | null; p95Ms: number | null; n: number;
  lastAt: number | null; failed: number; lastFailureAt: number | null;
}
export interface OndoLatencyMarket {
  market: string; clockAheadN: number;
  bboAge: OndoLatencyMetric; bookInterval: OndoLatencyMetric; restQueue: OndoLatencyMetric;
  cancelAck: OndoLatencyMetric; placeAck: OndoLatencyMetric; withdraw: OndoLatencyMetric; replace: OndoLatencyMetric;
}
export interface OndoLatencySnapshot {
  mode: 'observe' | 'live'; startedAt: number; stoppedAt: number | null; windowMs: number; maxSamples: number;
  wsRtt: OndoLatencyMetric; markets: OndoLatencyMarket[];
}
export interface OndoLatencyStamp { wall: number; mono: number }
export interface OndoLatencyObserver {
  stamp(): OndoLatencyStamp | null;
  missedPings?(count: number): void;
  elapsed(market: string | null, metric: 'wsRtt' | 'restQueue' | 'cancelAck' | 'placeAck',
    start: OndoLatencyStamp | null, end: OndoLatencyStamp | null, success?: boolean): void;
  book(market: string, sourceAt: number, received: OndoLatencyStamp): void;
  down(): void;
}
