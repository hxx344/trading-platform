// What the /api/asset/* reads answer, and the pure parts that shape them from a ledger. Free of node:* so the page can
// import the types (and the tests can call the builders without a database). The figures are computed with the copied
// workbench functions exactly as dashboard.tsx, asset-trend.tsx, withdrawals-panel.tsx and cash-flows-panel.tsx of
// project_aggregation modules/asset/app (0014655) compute them in the browser.
import type { Asset, Ledger, Period, Withdrawal } from './types.ts';
import { sumKnownValues } from './asset-values.ts';
import { assetDisplayRows, assetMeasures, assetTrend, embeddedWithdrawals, periodMeasures } from './withdrawals.ts';
import { calculateAnnualizedReturns, calculateMonthlyPerformance, type AnnualizedMetrics, type MonthlyPerformance } from './performance-metrics.ts';
import { cashFlowEvidence, type CashFlowEvidence, type CashFlowRecord } from './cash-flows.ts';
import type { DailyChangeReport } from './daily-changes.ts';

/** Kept in the `import-info` setting by import.ts. */
export type ImportInfo = { importedAt: string; file: string; owner: string; assets: number; snapshots: number; settings: string[] };
export type Imported = { imported: boolean; importedAt: string | null };
export type Valuation = { total: number; missingValues: number; partial: boolean };

export const EXCHANGE_NAMES = { bybit: 'Bybit', binance: 'Binance', okx: 'OKX', gate: 'Gate', aster: 'Aster', variational: 'Var · Variational', hyperliquid: 'Hyperliquid', 'rh-lighter': 'Lighter RH' } as const;
export type Exchange = keyof typeof EXCHANGE_NAMES;
// Same test as dashboard.tsx isExchangeMode.
export const isExchangeMode = (mode: Asset['mode']): mode is Exchange => Object.hasOwn(EXCHANGE_NAMES, mode);

export type AssetState = Imported & {
  source: { file: string; owner: string } | null;
  dataKind: Ledger['dataKind'] | null;
  assets: number;
  /** Daily snapshots (YYYY-MM-DD keys); archived pre-import records are counted apart. */
  snapshots: { count: number; first: string | null; last: string | null; archived: number };
};

export type ExchangeTotal = { mode: Exchange; name: string; total: number; partial: boolean; rows: number };
export type LedgerSummary = {
  valuation: Valuation; exchanges: Valuation; points: Valuation; withdrawals: Valuation;
  measures: ReturnType<typeof assetMeasures>;
  byExchange: ExchangeTotal[];
};
export type AssetLedgerView = Imported & { today: string; ledger: Omit<Ledger, 'history'> | null; rows: Asset[]; summary: LedgerSummary | null };

export type TrendPoint = ReturnType<typeof assetTrend>[number];
/** One row of the history table: the period and, for periods the curve counts, its measures. */
export type HistoryRow = Period & { included: boolean; held: number; withdrawn: number; adjusted: number };
export type AssetHistoryView = Imported & {
  today: string; baselineDate: string | null; startedAt: string | null;
  periods: HistoryRow[]; trend: TrendPoint[]; monthly: MonthlyPerformance[]; annualized: AnnualizedMetrics | null;
};
export type AssetDailyChangesView = Imported & DailyChangeReport;
export type AssetWithdrawalsView = Imported & { baselineDate: string | null; embedded: Valuation; withdrawals: Withdrawal[] };
export type AssetCashFlowsView = Imported & { audit: CashFlowRecord[]; evidence: CashFlowEvidence[]; voided: CashFlowRecord[] };
export type AssetPeriodView = Imported & { rows: Asset[] };

const NONE: Valuation = { total: 0, missingValues: 0, partial: false };

export function ledgerView(ledger: Ledger, today: string): Pick<AssetLedgerView, 'ledger' | 'rows' | 'summary'> {
  const { history: _history, ...current } = ledger;
  const exchangeRows = ledger.assets.filter(asset => isExchangeMode(asset.mode));
  const byExchange = (Object.keys(EXCHANGE_NAMES) as Exchange[]).flatMap(mode => {
    const rows = exchangeRows.filter(asset => asset.mode === mode);
    if (!rows.length) return [];
    const { total, partial } = sumKnownValues(rows);
    return [{ mode, name: EXCHANGE_NAMES[mode], total, partial, rows: rows.length }];
  });
  const valuation = sumKnownValues(ledger.assets);
  return {
    ledger: current,
    rows: assetDisplayRows(ledger.assets, ledger.withdrawals, today).sort((a, b) => (b.value ?? 0) - (a.value ?? 0)),
    summary: {
      valuation, exchanges: sumKnownValues(exchangeRows),
      points: sumKnownValues(ledger.assets.filter(asset => asset.kind.includes('积分'))),
      withdrawals: sumKnownValues(ledger.assets.filter(asset => asset.project.trim() === '出金')),
      measures: assetMeasures(valuation.total, embeddedWithdrawals(ledger.assets), ledger.withdrawals, today),
      byExchange,
    },
  };
}

export function historyView(ledger: Ledger, today: string): Omit<AssetHistoryView, keyof Imported | 'today'> {
  const trend = assetTrend(ledger, today);
  const monthly = calculateMonthlyPerformance(trend);
  return {
    baselineDate: ledger.baselineDate, startedAt: ledger.startedAt,
    periods: [...ledger.history].sort((a, b) => b.date.localeCompare(a.date)).map(period => ({ ...period, included: !period.future && !period.archived, ...periodMeasures(period, ledger) })),
    trend, monthly, annualized: calculateAnnualizedReturns(trend, monthly, today),
  };
}

export function withdrawalsView(ledger: Pick<Ledger, 'assets' | 'withdrawals' | 'baselineDate'>): Omit<AssetWithdrawalsView, keyof Imported> {
  const embedded = sumKnownValues(ledger.assets.filter(asset => asset.project.trim() === '出金'));
  return {
    baselineDate: ledger.baselineDate,
    embedded: { ...embedded, total: embeddedWithdrawals(ledger.assets) },
    withdrawals: [...ledger.withdrawals].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)),
  };
}

export function cashFlowsView(audit: CashFlowRecord[]): Omit<AssetCashFlowsView, keyof Imported> {
  return {
    audit,
    evidence: cashFlowEvidence(audit).sort((a, b) => b.date.localeCompare(a.date)),
    voided: [...new Map(audit.map(row => [row.id, row])).values()].filter(row => row.void),
  };
}

/** The answers before anything was imported: empty, and saying so. */
export const notImported = {
  state: (): AssetState => ({ imported: false, importedAt: null, source: null, dataKind: null, assets: 0, snapshots: { count: 0, first: null, last: null, archived: 0 } }),
  ledger: (today: string): AssetLedgerView => ({ imported: false, importedAt: null, today, ledger: null, rows: [], summary: null }),
  history: (today: string): AssetHistoryView => ({ imported: false, importedAt: null, today, baselineDate: null, startedAt: null, periods: [], trend: [], monthly: [], annualized: null }),
  withdrawals: (): AssetWithdrawalsView => ({ imported: false, importedAt: null, baselineDate: null, embedded: NONE, withdrawals: [] }),
  cashFlows: (): AssetCashFlowsView => ({ imported: false, importedAt: null, audit: [], evidence: [], voided: [] }),
};
