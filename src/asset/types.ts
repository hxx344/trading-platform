// Copied from project_aggregation modules/asset/lib/types.ts at 0014655. Change: Asset has the optional `quote` (issue #63).
export type Balance = { coin: string; account: string; quantity: number; value: number; price: number };
/**
 * The USD price of `coin` a source converted this row's total with, kept with the row and so with each daily snapshot:
 * the price, where it came from, the source's own time of the price (`at`) and when this service received it. Only the
 * Hyperliquid read writes it (its USDC/USD quote); a row without it is read as before.
 */
export type QuoteEvidence = { coin: string; usd: number; source: string; at: string; receivedAt: string };
export type Asset = { id: string; project: string; kind: string; quantity: number | null; price: number | null; value: number | null; cell: string; mode: 'manual' | 'market' | 'bybit' | 'aster' | 'binance' | 'okx' | 'gate' | 'variational' | 'hyperliquid' | 'rh-lighter'; updatedAt: string; status: string; error?: string; details?: Balance[]; quote?: QuoteEvidence };
export type FxStatus = { source: 'Coinbase' | 'Frankfurter' | 'manual' | 'saved'; fetchedAt: string | null; rateDate: string | null; error: string | null };
export type Period = { id: string; date: string; total: number; fx: number; cny: number; future: boolean; difference: number; partial?: boolean; missingValues?: number; archived?: boolean; withdrawn?: number; fxStatus?: FxStatus };
export type Withdrawal = { id: string; date: string; amount: number; note: string; createdAt: string; updatedAt: string };
export type Connection = { configured: boolean; lastSync: string | null; error: string | null; scope: string; label?: string };
export type AsterAccount = Connection & { id: string; name: string; value: number | null; details: Balance[]; updatedAt: string; includeSpot: boolean; walletAddress?: string };
export type Ledger = { dataKind: 'example' | 'personal'; assets: Asset[]; history: Period[]; withdrawals: Withdrawal[]; asterAccounts: AsterAccount[]; fx: number; fxStatus: FxStatus; baselineDate: string; startedAt: string; baselineTotal: number; connections: { bybit: Connection; aster: Connection; binance: Connection; okx: Connection; gate: Connection; variational: Connection; hyperliquid: Connection; 'rh-lighter': Connection } };
