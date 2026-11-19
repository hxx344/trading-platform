// 来自 project-aggregation 工作台 modules/monitor/lib/perpetual-price-history.ts（提交 c84ba27）。轮询留在页面，服务和页面共用合约身份与收盘记录校验。
import type { CandleBlocks } from '../candle-blocks.ts';

export const PRICE_HOUR_MS = 3_600_000;
export const PRICE_BLOCK_MS = 24 * PRICE_HOUR_MS;
export const PRICE_HISTORY_LOOKBACK_MS = 30 * 24 * PRICE_HOUR_MS;
export const PRICE_HISTORY_STALE_MS = 75 * 60_000;
export type PriceHistoryDays = 3 | 7 | 30;
export interface PerpetualPricePoint { time: number; close: number }
export interface PerpetualPriceLeg {
  key: string;
  identity: string;
  exchange: string;
  symbol: string;
  currency: string;
  status: 'pending' | 'ready' | 'error' | 'unsupported';
  fetchedAt: number | null;
  /** Successfully scanned (from,to] hour-end timestamps; missing candles stay missing. */
  from: number | null;
  to: number | null;
  points: PerpetualPricePoint[];
  error: string;
  backfillComplete: boolean;
}
export interface PerpetualPriceHistoryReport {
  schemaVersion: 1;
  generatedAt: number;
  intervalMs: number;
  legs: Record<string, PerpetualPriceLeg>;
  storageError?: string;
}
/** UTC day manifests for the two current identities. Existing readers still receive complete legs. */
export interface PerpetualPriceBlockReport extends Omit<PerpetualPriceHistoryReport, 'legs'> {
  blockSpanMs: number;
  legs: Record<string, Omit<PerpetualPriceLeg, 'points'> & CandleBlocks<PerpetualPricePoint>>;
}
export type PriceHistoryReply<I> = I extends { knownBlocks: unknown } ? PerpetualPriceBlockReport
  : I extends { pair: unknown; days: unknown } ? PerpetualPriceHistoryReport : PerpetualPriceHistoryReport | PerpetualPriceBlockReport;
interface PriceMarketIdentity {
  exchange: string; symbol: string; base: string; quoteCurrency: string;
  marketId?: number; multiplier?: number; contractUnit?: string; collateralCurrency?: string;
}
export const perpetualPriceIdentity = (market: PriceMarketIdentity) => JSON.stringify([market.exchange, market.symbol, market.base, market.quoteCurrency, market.marketId ?? null, market.multiplier ?? 1, market.contractUnit ?? null, market.collateralCurrency ?? null]);
const time = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= Date.UTC(2020, 0, 1);
const hour = (value: unknown): value is number => time(value) && value % PRICE_HOUR_MS === 0;

/** Validate untrusted transport/cache records before a chart can consume them. */
export function validatePerpetualPriceHistory(value: unknown, now = Date.now()): value is PerpetualPriceHistoryReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const report = value as PerpetualPriceHistoryReport;
  if (report.schemaVersion !== 1 || report.intervalMs !== PRICE_HOUR_MS || !time(report.generatedAt) || report.generatedAt > now + 5000 || !report.legs || typeof report.legs !== 'object' || Array.isArray(report.legs) || Object.keys(report.legs).length > 2 || (report.storageError !== undefined && typeof report.storageError !== 'string')) return false;
  return Object.entries(report.legs).every(([key, leg]) => {
    if (!leg || typeof leg !== 'object' || typeof leg.exchange !== 'string' || typeof leg.symbol !== 'string' || key !== `${leg.exchange}:${leg.symbol}` || leg.key !== key || key.length > 200 || typeof leg.identity !== 'string' || !leg.identity || leg.identity.length > 2000 || !['USD', 'USDT', 'USDC', 'USD1', 'USDG'].includes(leg.currency) || !['pending', 'ready', 'error', 'unsupported'].includes(leg.status) || typeof leg.error !== 'string' || typeof leg.backfillComplete !== 'boolean' || !Array.isArray(leg.points) || leg.points.length > 720) return false;
    try {
      const identity = JSON.parse(leg.identity);
      if (!Array.isArray(identity) || identity.length !== 8 || identity[0] !== leg.exchange || identity[1] !== leg.symbol || typeof identity[2] !== 'string' || identity[3] !== leg.currency || !Number.isFinite(identity[5]) || identity[5] <= 0) return false;
    } catch { return false; }
    if (leg.fetchedAt !== null && (!time(leg.fetchedAt) || leg.fetchedAt > report.generatedAt)) return false;
    if (leg.from === null || leg.to === null) return leg.from === null && leg.to === null && leg.fetchedAt === null && leg.points.length === 0 && leg.status !== 'ready' && !leg.backfillComplete;
    if (!hour(leg.from) || !hour(leg.to) || leg.from >= leg.to || leg.to > report.generatedAt || leg.to - leg.from > PRICE_HISTORY_LOOKBACK_MS || leg.fetchedAt === null || leg.to > leg.fetchedAt || (leg.backfillComplete && leg.to - leg.from !== PRICE_HISTORY_LOOKBACK_MS)) return false;
    let previous = leg.from;
    return leg.points.every(point => {
      if (!point || !hour(point.time) || point.time <= previous || point.time > leg.to! || typeof point.close !== 'number' || !Number.isFinite(point.close) || point.close <= 0 || point.close > 1e20) return false;
      previous = point.time; return true;
    });
  });
}

export function priceHistoryIsStale(report: PerpetualPriceHistoryReport | null, now = Date.now()) {
  return Boolean(report && Object.values(report.legs).some(leg => leg.points.length > 0 && (leg.status === 'error' || leg.fetchedAt === null || now - leg.fetchedAt > PRICE_HISTORY_STALE_MS || leg.to === null || now - leg.to > PRICE_HISTORY_STALE_MS)));
}
