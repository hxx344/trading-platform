export const TERMINAL_SYMBOL: RegExp;
export const INTERVALS: Readonly<Record<string, number>>;
export function validCandleRange(interval: string, from: unknown, to: unknown, now: number): boolean;
