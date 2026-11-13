// The ledger edits of A-2. Adapted from project_aggregation modules/asset/lib/store.ts at 0014655 (snapshot, editAsset,
// editFx, saveWithdrawal, deleteWithdrawal) and lib/cash-flow-store.ts (saveCashFlow). The rules and messages are
// unchanged. Changes:
// - no owner; the caller (store.ts) parses the body, holds the sync lock and passes the ledger it read under the lock;
// - an edit and its daily snapshot are written in one transaction: the snapshot is computed from the ledger read under
//   the lock with the edit applied in memory, the way readLedger would read it back (the workbench commits the edit,
//   reads the ledger again and commits the snapshot in a second transaction);
// - the snapshot carries no `positions` (this service keeps no positions cache yet, A-5);
// - timestamps come from the injected clock.
// Like the workbench, a cash-flow annotation writes no snapshot (it does not change any asset value).
import type { AssetDb } from './db.ts';
import type { SyncLease } from './sync-lock.ts';
import type { Asset, FxStatus, Ledger, Withdrawal } from './types.ts';
import { configuredExchanges, knownAssetValue, snapshotValues, withMarketQuantity } from './asset-values.ts';
import { chinaDay, embeddedWithdrawals } from './withdrawals.ts';
import { amendCashFlows, CASH_FLOW_KEY, type CashFlowInput, type CashFlowRecord } from './cash-flows.ts';
import { isExchangeMode } from './views.ts';
import { editValue, type EditInput, type WithdrawalInput } from './validation.ts';

type Database = Pick<AssetDb, 'prepare'>;
export const WITHDRAWAL_LIMIT = 2000;

export const saveSetting = (database: Database, key: string, value: unknown) =>
  database.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key, typeof value === 'string' ? value : JSON.stringify(value)).run();

/** The daily snapshot the workbench's snapshot() stores for this ledger at `at`; the ledger's assets as readLedger returns them. */
export function dailySnapshot(ledger: Pick<Ledger, 'assets' | 'fx' | 'fxStatus' | 'connections'>, at: number) {
  const assets = ledger.assets.map(asset => ({ ...asset, value: knownAssetValue(asset) }));
  const { total, partial, missingValues } = snapshotValues(assets, ledger.fxStatus, at, configuredExchanges(ledger.connections));
  const date = chinaDay(new Date(at)), updatedAt = new Date(at).toISOString();
  return { date, data: { id: 'daily-' + date, date, total, fx: ledger.fx, fxStatus: ledger.fxStatus, cny: total * ledger.fx, future: false, difference: 0, partial, missingValues, withdrawn: embeddedWithdrawals(assets), updatedAt, assets } };
}
export function saveSnapshot(database: Database, ledger: Pick<Ledger, 'assets' | 'fx' | 'fxStatus' | 'connections'>, at: number) {
  const { date, data } = dailySnapshot(ledger, at);
  database.prepare('INSERT INTO snapshots(date,data) VALUES(?,?) ON CONFLICT(date) DO UPDATE SET data=excluded.data').bind(date, JSON.stringify(data)).run();
}

export function editAsset(database: Database, lease: SyncLease, ledger: Ledger, input: EditInput, at: number): void {
  const asset = ledger.assets.find(a => a.id === input.id);
  if (!asset) throw new Error('未找到该资产');
  if (isExchangeMode(asset.mode)) throw new Error('交易所资产由只读接口维护');
  const price = asset.mode === 'market' ? asset.price : input.price;
  const edited = asset.mode === 'market' ? withMarketQuantity(asset, input.quantity) : asset;
  const status = asset.mode === 'manual' ? '手动估值' : edited.status;
  const next: Asset = { ...edited, quantity: input.quantity, price, value: editValue(input.quantity, price), status };
  if (asset.mode === 'manual') next.updatedAt = new Date(at).toISOString();
  // What readLedger reads back: the stored JSON drops undefined keys.
  const stored = JSON.parse(JSON.stringify(next)) as Asset;
  lease.write(() => {
    database.prepare('UPDATE assets SET data = ? WHERE id = ?').bind(JSON.stringify(next), next.id).run();
    saveSnapshot(database, { ...ledger, assets: ledger.assets.map(a => a.id === next.id ? stored : a) }, at);
  });
}

export function editFx(database: Database, lease: SyncLease, ledger: Ledger, fx: number, at: number): void {
  const fxStatus: FxStatus = { source: 'manual', fetchedAt: new Date(at).toISOString(), rateDate: null, error: null };
  lease.write(() => {
    saveSetting(database, 'fx', String(fx));
    saveSetting(database, 'fx-status', fxStatus);
    saveSnapshot(database, { ...ledger, fx, fxStatus }, at);
  });
}

/** false: the same withdrawal was already saved under this id (a retried add), nothing written. */
export function saveWithdrawal(database: Database, lease: SyncLease, ledger: Ledger, input: WithdrawalInput, editing: boolean, at: number): boolean {
  if (input.date < ledger.baselineDate) throw new Error('新增出金日期不能早于原表基准日 ' + ledger.baselineDate + '，原表出金已单独计入');
  if (input.date > chinaDay(new Date(at))) throw new Error('不能登记尚未发生的出金');
  const existing = ledger.withdrawals.find(row => row.id === input.id);
  if (editing && !existing) throw new Error('未找到出金记录，请刷新页面');
  if (!editing && existing) {
    if (existing.date === input.date && existing.amount === input.amount && existing.note === input.note) return false;
    throw new Error('出金记录编号重复，请刷新页面');
  }
  if (!editing && ledger.withdrawals.length >= WITHDRAWAL_LIMIT) throw new Error('出金记录已达到 2000 条上限');
  const now = new Date(at).toISOString();
  const record: Withdrawal = { ...input, createdAt: existing?.createdAt ?? now, updatedAt: now };
  const withdrawals = editing ? ledger.withdrawals.map(row => row.id === input.id ? record : row) : [...ledger.withdrawals, record];
  lease.write(() => { saveSetting(database, 'withdrawals', withdrawals); saveSnapshot(database, ledger, at); });
  return true;
}

/** Deleting an id that is not there still succeeds, as in the workbench. */
export function deleteWithdrawal(database: Database, lease: SyncLease, ledger: Ledger, id: string, at: number): void {
  lease.write(() => { saveSetting(database, 'withdrawals', ledger.withdrawals.filter(row => row.id !== id)); saveSnapshot(database, ledger, at); });
}

export function saveCashFlow(database: Database, lease: SyncLease, audit: readonly CashFlowRecord[], input: CashFlowInput, at: number): CashFlowRecord[] {
  const next = amendCashFlows(audit, input, at);
  lease.write(() => saveSetting(database, CASH_FLOW_KEY, next));
  return next;
}
