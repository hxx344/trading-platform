// Copied from project_aggregation modules/asset/lib/positions-types.ts at 7745181 (same as 0014655). Changes:
// - CycleEvidence and CycleEvidenceRow are inlined from project_aggregation server/cycle-evidence.d.mts (same commit)
//   instead of being imported from the workbench host;
// - (until A-5 the live reader types were left out; A-5 adds them back unchanged).
export type CycleEvidenceRow = {
  id: string; time: string; kind: 'fill' | 'funding' | 'realized'; status: 'included' | 'partial' | 'excluded';
  quantity: string | null; price: string | null; fraction: string | null;
  /** Absent from earlier v1 evidence; absence is unknown, not zero. */
  side?: 'buy' | 'sell' | null; closingQuantity?: string | null;
  realizedPnl: string | null; fee: string | null; feeCurrency: string | null;
  amount: string | null; currency: string | null; reason: string | null;
};
export type CycleEvidence = {
  version: 1; coverageStart: string; coverageEnd: string; openingFound: boolean;
  totalRows: number; truncated: boolean; rows: CycleEvidenceRow[];
};
/** Decimal strings preserve exchange precision; quantities are absolute. */
export type Position = {
  id: string;
  symbol: string;
  instrumentId: string;
  side: 'long' | 'short';
  /** Exchange leg identity retained for fill replay; older providers may omit it. */
  positionSide?: 'long' | 'short' | 'net';
  quantity: string;
  quantityUnit: string;
  contractSize: string | null;
  entryPrice: string | null;
  markPrice: string | null;
  notional: string | null;
  unrealizedPnl: string | null;
  leverage: string | null;
  liquidationPrice: string | null;
  priceCurrency: string | null;
  notionalCurrency: string | null;
  pnlCurrency: string | null;
  marginMode: string | null;
  sourceUpdatedAt: string | null;
  /** Fills and cash flows since this position last opened from zero; absent where not supported. */
  cycle?: PositionCycle | null;
};

/** Signed cash flows in `currency`; `net` = realizedPnl + fees + funding and is null when any part is unknown. */
export type PositionCycle = {
  evidence?: CycleEvidence;
  status: 'loading' | 'complete' | 'partial' | 'unavailable';
  since: string | null;
  closedQuantity: string | null;
  closePrice: string | null;
  realizedPnl: string | null;
  fees: string | null;
  funding: string | null;
  net: string | null;
  currency: string | null;
  note: string | null;
  updatedAt: string | null;
};

export type PositionsStatus = 'unconfigured' | 'loading' | 'live' | 'stale' | 'error' | 'unsupported';
export type PositionsScope = {
  id: string;
  label: string;
  status: PositionsStatus;
  refreshing: boolean;
  fetchedAt: string | null;
  error: string | null;
  positions: Position[];
};
export type PositionsAccount = {
  id: string;
  name: string;
  configured: boolean;
  revision: string | null;
  scopes: PositionsScope[];
};
export type PositionsExchange = { id: string; name: string; accounts: PositionsAccount[] };
export type HubPositions = { schemaVersion: 1; generatedAt: string; exchanges: PositionsExchange[] };
