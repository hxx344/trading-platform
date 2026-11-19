export const INTERVALS: Readonly<Record<string, number>> = Object.freeze({
  '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000,
});
export const CANDLE_LIMIT = 240;
export const terminalBlockSpan = (interval: string): number => INTERVALS[interval] * 16;
