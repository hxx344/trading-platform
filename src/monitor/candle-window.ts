import type { CandleBlocks } from '../candle-blocks.ts';

export type MonitorCandleMarket = 'anthropic' | 'oil' | 'goldoil' | 'hynix';
export const MONITOR_CANDLE_BLOCK_MS = 7 * 86_400_000;
export const monitorCandleField = (market: MonitorCandleMarket) => market === 'hynix' ? 'rows' : 'data';

/** first is the first row of the requested window. Its first transport block can start earlier. */
export type MonitorCandleUpdate = {
  first: number;
  header: Record<string, unknown>;
  candles: CandleBlocks<{ time: number }>;
};
