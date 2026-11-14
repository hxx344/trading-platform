// The settled-funding reads of the monitor page (M-2d): the service's /api/monitor/<market>/funding answer, checked with the
// same rules the collector stores by, on the workbench panel's row shape (leg A `adr`, leg B `ordinary`; for oil A = Brent,
// B = WTI, as the workbench's hooks/use-oil-funding.ts maps them). The panel's time end follows settled-funding-panel.tsx.
import {
  HYNIX_FIRST_SETTLEMENT, HYNIX_FUNDING_MS, OIL_FIRST_SETTLEMENT, OIL_FUNDING_MS, validateHynixFundingRows, validateOilFundingRows,
} from '../../src/vendor/settled-funding.mjs';

export type FundingRow = { time: number; adr: number | null; ordinary: number | null };
export type FundingHistory = { rows: FundingRow[]; fetchedAt: string; status: 'live' | 'snapshot'; complete: boolean; lastError: string | null };
export type FundingMarket = 'oil' | 'hynix';
export const FUNDING_SCHEDULE: Record<FundingMarket, { intervalMs: number; firstSettlement: number }> = {
  oil: { intervalMs: OIL_FUNDING_MS, firstSettlement: OIL_FIRST_SETTLEMENT },
  hynix: { intervalMs: HYNIX_FUNDING_MS, firstSettlement: HYNIX_FIRST_SETTLEMENT },
};

const envelope = (input: unknown) => {
  const value = (input ?? {}) as { rows?: unknown; fetchedAt?: unknown; status?: unknown; complete?: unknown; lastError?: unknown };
  if (typeof value.fetchedAt !== 'string') throw new Error('Invalid funding answer');
  return { rows: value.rows, fetchedAt: value.fetchedAt, status: value.status === 'live' ? 'live' as const : 'snapshot' as const, complete: value.complete !== false, lastError: typeof value.lastError === 'string' && value.lastError ? value.lastError : null };
};

export function oilFunding(input: unknown): FundingHistory {
  const { rows, ...rest } = envelope(input);
  return { ...rest, rows: validateOilFundingRows(rows, rest.fetchedAt).map(row => ({ time: row.time, adr: row.brent, ordinary: row.wti })) };
}

export function hynixFunding(input: unknown): FundingHistory {
  const { rows, ...rest } = envelope(input);
  return { ...rest, rows: validateHynixFundingRows(rows, rest.fetchedAt) };
}

/** The service keeps 400 days (src/monitor/funding.ts FUNDING_RETENTION_DAYS; a test keeps the two equal). */
export const FUNDING_RETENTION_DAYS = 400;

/** The last settlement the panel counts: settlements get a minute to arrive, and one already received counts even if newer.
 * While the backfill still reads on, the panel ends at the last row it has instead of counting the rest as missing. */
export function fundingEnd(history: FundingHistory | null, market: FundingMarket): number {
  const { intervalMs, firstSettlement } = FUNDING_SCHEDULE[market];
  if (!history?.rows.length) return firstSettlement - intervalMs;
  if (!history.complete) return history.rows.at(-1)!.time;
  return Math.max(history.rows.at(-1)!.time, Math.floor((Date.parse(history.fetchedAt) - 60_000) / intervalMs) * intervalMs);
}

/** The first settlement the panel expects: the market's first one, or the oldest one the service still keeps. */
export function fundingFirst(history: FundingHistory | null, market: FundingMarket): number {
  const { intervalMs, firstSettlement } = FUNDING_SCHEDULE[market];
  if (!history) return firstSettlement;
  return Math.max(firstSettlement, Math.ceil((Date.parse(history.fetchedAt) - FUNDING_RETENTION_DAYS * 86_400_000) / intervalMs) * intervalMs);
}
