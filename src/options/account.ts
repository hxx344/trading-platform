// What the options page shows about the account: positions, their Greeks, wallet and portfolio-margin health, and
// recent executions. Ported from the workbench (reconciliation.py _parse_positions, position_greeks.py, engine.py
// load_account_health / _portfolio_margin_metrics, performance.py parse_execution). Nothing missing is invented: a blank
// field stays null, and a total with one unknown leg is unknown.
import { decimal, isZero } from '../decimal.ts';
import { describe } from '../live/values.ts';
import type { OptionsClient, Row } from './client.ts';
import type { Greeks } from './market.ts';
import type { Side } from './strategy.ts';

export interface Position { symbol: string; side: Side; size: string; avgPrice: number; markPrice: number; unrealisedPnl: number }

const finite = (value: unknown): number => {
  const parsed = value === undefined || value === null || value === '' ? 0 : Number(value);
  if (!Number.isFinite(parsed)) throw new Error('交易所返回的持仓价格无效');
  return parsed;
};
const optional = (value: unknown): number | null => {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Non-zero option positions; a bad size, side or a duplicate refuses the whole list (it is used to retire legs). */
export function parsePositions(raw: Row[]): Position[] {
  const seen = new Set<string>(), positions: Position[] = [];
  for (const item of raw) {
    const symbol = item.symbol, side = item.side;
    let size: string;
    try { size = decimal(item.size, 'nonnegative'); } catch { throw new Error('交易所返回的持仓数量无效'); }
    if (typeof symbol !== 'string' || !symbol) throw new Error('交易所返回的持仓合约无效');
    if (isZero(size)) continue;
    if ((side !== 'Buy' && side !== 'Sell') || seen.has(`${symbol}|${side}`)) throw new Error('交易所返回的持仓方向无效或重复');
    seen.add(`${symbol}|${side}`);
    positions.push({ symbol, side, size, avgPrice: finite(item.avgPrice), markPrice: finite(item.markPrice), unrealisedPnl: finite(item.unrealisedPnl) });
  }
  return positions;
}

export const GREEK_NAMES = ['delta', 'gamma', 'vega', 'theta'] as const;
export const GREEK_UNITS = { delta: 'BTC', gamma: 'BTC / USD', vega: 'USD / 1% IV', theta: 'USD / 天' };
export type GreekTotals = Record<(typeof GREEK_NAMES)[number], number | null>;

/** Signed sums: a long (Buy) adds, a short subtracts; a total with any unknown leg is null. */
export function summarizeGreeks(positions: readonly Position[] | null, greeks: ReadonlyMap<string, Greeks>, { marketAt, now, staleMs }: { marketAt: number | null; now: number; staleMs: number }) {
  const available = positions !== null;
  const counted = (positions ?? []).filter(position => !isZero(position.size));
  const stale = !available || marketAt === null || now - marketAt < 0 || now - marketAt > staleMs;
  const empty: GreekTotals = { delta: null, gamma: null, vega: null, theta: null };
  const base = { positionCount: counted.length, positionsAvailable: available, marketAt, stale, units: GREEK_UNITS };
  if (!counted.length) return { ...base, status: available ? 'empty' : 'unavailable', totals: empty, missing: { delta: [], gamma: [], vega: [], theta: [] } };
  const totals: GreekTotals = { delta: 0, gamma: 0, vega: 0, theta: 0 };
  const missing: Record<string, Set<string>> = { delta: new Set(), gamma: new Set(), vega: new Set(), theta: new Set() };
  for (const position of counted) {
    const sign = position.side === 'Buy' ? 1 : -1, values = greeks.get(position.symbol);
    for (const name of GREEK_NAMES) {
      const value = values?.[name];
      if (marketAt === null || value === null || value === undefined || !Number.isFinite(value)) { missing[name]!.add(position.symbol); continue; }
      totals[name] = totals[name]! + sign * Number(position.size) * value;
    }
  }
  for (const name of GREEK_NAMES) if (missing[name]!.size) totals[name] = null;
  const known = GREEK_NAMES.filter(name => totals[name] !== null).length;
  return { ...base, status: known === GREEK_NAMES.length ? 'ok' : known === 0 ? 'unavailable' : 'partial', totals, missing: Object.fromEntries(GREEK_NAMES.map(name => [name, [...missing[name]!].sort()])) };
}

export interface PmMetrics { accountIm: number | null; accountMm: number | null; assetIm: number | null; assetMm: number | null; contingency: number | null; maxLossPriceMove: number | null; maxLossIvShock: number | null }
export interface PmBaseline extends PmMetrics { capturedAt: number; context: string }

export function pmMetrics(payload: Row): PmMetrics {
  const wallet = (payload.wallet ?? {}) as Row;
  const assets = Array.isArray(payload.assetPnlRange) ? payload.assetPnlRange as Row[] : [];
  const btc = assets.find(item => item?.baseCoin === 'BTC') ?? {};
  const asset = (btc.asset ?? {}) as Row, contingency = (btc.contingency ?? {}) as Row;
  return {
    accountIm: optional(wallet.accountIM), accountMm: optional(wallet.accountMM), assetIm: optional(asset.assetIM), assetMm: optional(asset.assetMM),
    contingency: optional(contingency.contingencyComponents), maxLossPriceMove: optional(btc.maxLossPriceMove), maxLossIvShock: optional(btc.maxLossIvShock),
  };
}

export interface AccountHealth {
  available: boolean; message?: string; updatedAt: number;
  availableBalanceUsd?: number | null; marginBalanceUsd?: number | null; totalEquityUsd?: number | null; walletBalanceUsd?: number | null;
  initialMarginUsd?: number | null; maintenanceMarginUsd?: number | null; initialMarginRate?: number | null; maintenanceMarginRate?: number | null;
  marginMode?: string | null;
  portfolioMargin?: (PmMetrics & { incrementalImUsd: number | null; incrementalMmUsd: number | null; baselineAt: number | null; baselineContext: string | null }) | null;
  portfolioMarginMessage?: string;
}

/** One health read: wallet and account mode, then the BTC portfolio-margin detail for a portfolio-margin account. */
export async function readAccountHealth(client: OptionsClient, baseline: PmBaseline | null, now: number, signal: AbortSignal): Promise<AccountHealth> {
  try {
    const [account, wallet] = await Promise.all([client.accountInfo(signal), client.walletBalance(signal)]);
    const health: AccountHealth = {
      available: true, updatedAt: now,
      availableBalanceUsd: optional(wallet.totalAvailableBalance), marginBalanceUsd: optional(wallet.totalMarginBalance), totalEquityUsd: optional(wallet.totalEquity),
      walletBalanceUsd: optional(wallet.totalWalletBalance), initialMarginUsd: optional(wallet.totalInitialMargin), maintenanceMarginUsd: optional(wallet.totalMaintenanceMargin),
      initialMarginRate: optional(wallet.accountIMRate), maintenanceMarginRate: optional(wallet.accountMMRate),
      marginMode: typeof account.marginMode === 'string' ? account.marginMode : null, portfolioMargin: null,
    };
    if (account.marginMode === 'PORTFOLIO_MARGIN') {
      try {
        const metrics = pmMetrics(await client.portfolioMargin(signal));
        const diff = (value: number | null, base: number | null | undefined) => value !== null && base !== null && base !== undefined ? value - base : null;
        health.portfolioMargin = { ...metrics, incrementalImUsd: diff(metrics.accountIm, baseline?.accountIm), incrementalMmUsd: diff(metrics.accountMm, baseline?.accountMm), baselineAt: baseline?.capturedAt ?? null, baselineContext: baseline?.context ?? null };
      } catch (error) { health.portfolioMarginMessage = describe(error); }
    }
    return health;
  } catch (error) { return { available: false, message: describe(error), updatedAt: now }; }
}

export interface ExecutionRecord {
  execId: string; symbol: string; side: Side; orderId: string; orderLinkId: string; execFee: number; feeCurrency: string;
  execPrice: number; execQty: number; execTime: number; feeRate: number | null; closedSize: number | null; execType: string;
  reduceOnly: boolean; taskId: string | null; openingGroup: string | null; chainPrice: number | null; chainPriceDiff: number | null;
}

export function parseExecution(row: Row): Omit<ExecutionRecord, 'reduceOnly' | 'taskId' | 'openingGroup' | 'chainPrice' | 'chainPriceDiff'> {
  const qty = Number(row.execQty), price = Number(row.execPrice), fee = Number(row.execFee), time = Number(row.execTime);
  if (typeof row.execId !== 'string' || !row.execId || typeof row.symbol !== 'string' || !(qty > 0) || !(price >= 0) || !Number.isFinite(fee) || !Number.isSafeInteger(time) || (row.side !== 'Buy' && row.side !== 'Sell')) throw new Error('成交记录格式无效');
  const text = (value: unknown) => typeof value === 'string' ? value : '';
  return {
    execId: row.execId, symbol: row.symbol, side: row.side, orderId: text(row.orderId), orderLinkId: text(row.orderLinkId), execFee: fee, feeCurrency: text(row.feeCurrency),
    execPrice: price, execQty: qty, execTime: time, feeRate: optional(row.feeRate), closedSize: optional(row.closedSize), execType: text(row.execType) || 'Trade',
  };
}
