// The reward view's wire shape (GET /api/ondo/rewards, docs/ondo.md §5), shared by the service and the page.

/** Width of one depth bucket and how many there are: 0–25 bps from the mid, the farthest any band scores. */
export const BUCKET_BPS = 0.5;
export const BUCKETS = 50;

export interface OndoRewardConfig {
  /** The markets to watch, in order. */
  markets: string[];
  /** The weekly liquidity pool in USD (decimal string), as Ondo announces it. */
  poolUsd: string;
  /** How many markets the pool is split across (Ondo: equally per eligible market). */
  eligible: number;
}

/** One price level within 5 bps of the mid in the latest snapshot. usd and cumUsd count other makers only. */
export interface OndoLevel { price: string; size: string; usd: number; bps: number; cumUsd: number; oursUsd: number }

export interface OndoRewardMarket {
  market: string;
  /** From GET /v1/markets: null until the rules are read; listed false when the venue has no such market. */
  listed: boolean | null; trading: boolean | null; tick: string | null; makerFee: string | null;
  /** The latest snapshot (ms since epoch), its mid and best prices. */
  at: number | null; mid: number | null; bid: number | null; ask: number | null; spreadBps: number | null;
  /** Levels within 5 bps of the mid, best first; null before the first snapshot. */
  levels: { bid: OndoLevel[]; ask: OndoLevel[] } | null;
  /** USD resting within 0–5 bps now, others only. */
  depth5: { bid: number; ask: number } | null;
  /** How far from the mid the snapshot's 100 levels reached, per side, in bps (25 or more covers every band). */
  cover: { bid: number | null; ask: number | null };
  /** Averages over the window: USD per BUCKET_BPS bucket, others only; cover is the window's smallest. */
  avg: { samples: number; from: number | null; bid: number[]; ask: number[]; cover: { bid: number | null; ask: number | null } };
  /** Standard deviation of one-minute log returns of the mid over the window; null with fewer than MIN_RETURNS. */
  sigma1m: number | null;
  returns: number;
  error: string | null;
}

export interface OndoRewardsView {
  schema: 1;
  serverNow: number;
  config: OndoRewardConfig;
  revision: number;
  /** Minutes averaged; the samples kept span at most maxWindowMin. */
  windowMin: number;
  maxWindowMin: number;
  /** How often each market is sampled. */
  cycleMs: number;
  startedAt: number;
  rulesError: string | null;
  loadError: string | null;
  markets: OndoRewardMarket[];
}
