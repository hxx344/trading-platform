import type { SettledFundingRecord } from './exchange-funding-history.mjs';

const HOUR = 3_600_000;
export const FUNDING_PUBLICATION_GRACE_MS = 60_000;
export type SettlementSchedule = { interval: number; anchor: number };

/** Work from published terms, or a repeated cadence of actual settlements. Raw milliseconds stay in the ledger. */
export function settlementSchedule(records: readonly SettledFundingRecord[], hours?: number | null, next?: number | null): SettlementSchedule | null {
  let interval = typeof hours === 'number' && hours > 0 && hours <= 24 ? Math.round(hours * HOUR) : 0;
  const tail = records.slice(-4).map(row => Math.floor(row.time / 60_000) * 60_000);
  if (!interval && tail.length === 4) {
    const step = tail[1]! - tail[0]!;
    if (step >= 60_000 && step <= 24 * HOUR && tail.slice(1).every((time, i) => time - tail[i]! === step)) interval = step;
  }
  const anchor = typeof next === 'number' && Number.isSafeInteger(next) && next > 0 ? next : tail.at(-1);
  return interval > 0 && anchor !== undefined ? { interval, anchor } : null;
}

export function settlementSlot(at: number, schedule: SettlementSchedule) {
  return schedule.anchor + Math.floor((at - schedule.anchor) / schedule.interval) * schedule.interval;
}

/** Exclude the unobserved pre-listing prefix. After each repair, rotate past it to avoid starving later holes. */
export function fundingGap(records: readonly SettledFundingRecord[], schedule: SettlementSchedule, from: number, last: number, after = 0, verified: readonly { from: number; to: number }[] = []): number | null {
  if (!records.length) return null;
  const seen = new Set(records.map(row => settlementSlot(row.time, schedule)));
  const first = Math.max(settlementSlot(records[0]!.time, schedule), settlementSlot(from - 1, schedule) + schedule.interval);
  let earliest: number | null = null;
  for (let t = first; t <= last; t += schedule.interval) {
    if (seen.has(t) || verified.some(range => range.from <= t && range.to >= t + schedule.interval - 1)) continue;
    if (t > after) return t;
    earliest ??= t;
  }
  return earliest;
}
