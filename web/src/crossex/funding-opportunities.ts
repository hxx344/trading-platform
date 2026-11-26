// 来自 project-aggregation 工作台提交 7745181，接口与导航适配独立交易平台。
import type { Instrument } from './live-types.ts';
import { DEFAULT_CAPITAL_ASSUMPTIONS, estimatePairCapitalFromRatio, estimatePairRoc, type CapitalAssumptions } from '../../../src/vendor/capital-metrics.mjs';
import { opportunityImportPair } from './opportunity-import.ts';

export type FundingLeg = {
  exchange: string; symbol: string; quoteCurrency: string;
  rate: number; intervalHours: number; normalized8hBps: number;
  nextFundingAt: number | null; fundingAt: number;
};
export type FundingOpportunity = {
  id: string; base: string; long: FundingLeg; short: FundingLeg;
  equivalent8hBps: number; grossBps: number | null;
  asOf: number; expiresAt: number; eligible: boolean; reason: string;
};

export interface FundingCapitalRoc {
  capitalPercent: number | null;
  rocPercent: number | null;
  fundingRocAnnualizedPercent: number | null;
  reason: string;
}

/**
 * Funding-only capital efficiency. The server has no fee/slippage evidence on
 * this row, so the result is deliberately not a net-return claim. Capital uses
 * the same 3x / 20% / 24h assumptions as the Monitor default and scales the
 * short notional by the quoted gross spread when it is available.
 */
export function fundingCapitalRoc(row: FundingOpportunity, assumptions: CapitalAssumptions = DEFAULT_CAPITAL_ASSUMPTIONS): FundingCapitalRoc {
  if (!Number.isFinite(row.equivalent8hBps)) return { capitalPercent: null, rocPercent: null, fundingRocAnnualizedPercent: null, reason: '8h 等效费率差缺失' };
  const ratio = row.grossBps === null || !Number.isFinite(row.grossBps) ? null : 1 + row.grossBps / 10000;
  const capital = estimatePairCapitalFromRatio({ shortToLongRatio: ratio, ...assumptions });
  const normalized = (leg: FundingLeg) => Number.isFinite(leg.rate) && Number.isFinite(leg.intervalHours) && leg.intervalHours > 0 && leg.intervalHours <= 168 ? leg.rate * 8 / leg.intervalHours : null;
  const roc = estimatePairRoc({ netSpreadPercent: 0, longFunding8h: normalized(row.long), shortFunding8h: normalized(row.short),
    shortNotionalPercent: capital.shortNotionalPercent, capitalPercent: capital.capitalPercent, holdingHours: assumptions.holdingHours });
  return { capitalPercent: capital.capitalPercent, rocPercent: roc.fundingAvailable ? roc.rocPercent : null, fundingRocAnnualizedPercent: roc.fundingRocAnnualizedPercent, reason: capital.reason || roc.reason };
}

/** Recheck the server's independent funding/book/policy deadline as time passes. */
export function fundingStaleReason(row: FundingOpportunity, now: number, monitorStale: boolean) {
  if (monitorStale) return 'Monitor 行情待更新';
  if (!Number.isFinite(now) || !Number.isFinite(row.expiresAt) || now >= row.expiresAt
    || !Number.isFinite(row.asOf) || row.asOf > now + 1000) return '机会数据已过期，等待更新';
  return row.eligible ? '' : row.reason || '机会数据待核实';
}

/** Never substitute a similar contract when filling a funding direction. */
export function fundingPair(row: FundingOpportunity, instruments: Instrument[]) {
  // Funding quoteCurrency is native; the CrossEx symbol carries the contract's counter currency.
  return opportunityImportPair({ symbol: row.base, longExchange: row.long.exchange, shortExchange: row.short.exchange,
    longContract: row.long.symbol, shortContract: row.short.symbol, opportunityKind: 'funding', importId: 'internal-funding' }, instruments);
}
