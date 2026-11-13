// The service's reads and writes of asset.sqlite. The file is opened on first use and only if it exists, so a service
// started before the first import serves "not imported" and picks the data up once import.ts has written it (WAL lets
// the import commit while this connection stays open). Since A-2 it is opened read-write (one connection, so a write
// shows in the next read) and falls back to read-only when the service cannot write it; the writes (writes.ts) run under
// the sync lock (sync-lock.ts).
import { statSync } from 'node:fs';
import { dirname } from 'node:path';
import { assertOwnFiles, openAssetDb, type AssetDb } from './db.ts';
import type { QueryDatabase } from './query.ts';
import type { Asset, Connection, Ledger } from './types.ts';
import { seedLedger, type SourceLedger } from './seed.ts';
import { EXAMPLE_SOURCE } from './source-ledger.ts';
import { readSnapshotHistory } from './snapshot-history.ts';
import { readAsterAccounts } from './aster-accounts.ts';
import { knownAssetValue } from './asset-values.ts';
import { chinaDay } from './withdrawals.ts';
import { CASH_FLOW_KEY, parseCashFlow, readCashFlowAudit, type CashFlowRecord } from './cash-flows.ts';
import { acquireSyncLock, AssetConflict, LOCK_BUSY, NOT_IMPORTED, type SyncLease } from './sync-lock.ts';
import { parseEdit, parseFx, parseWithdrawal, parseWithdrawalId } from './validation.ts';
import * as writes from './writes.ts';
import { DAILY_CHANGE_DAYS, readDailyChanges, shiftDay } from './daily-changes.ts';
import {
  cashFlowsView, historyView, ledgerView, notImported, withdrawalsView,
  type AssetCashFlowsView, type AssetDailyChangesView, type AssetHistoryView, type AssetLedgerView, type AssetPeriodView, type AssetState, type AssetWithdrawalsView, type ImportInfo,
} from './views.ts';

const EXCHANGES = ['bybit', 'aster', 'binance', 'okx', 'gate', 'variational', 'hyperliquid', 'rh-lighter'] as const;
const DAILY_KEY = "date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'";

/**
 * Adapted from readLedger in project_aggregation modules/asset/lib/store.ts (0014655). Changes: no owner and no
 * initialize() (the data comes from the import); the source ledger must be there instead of falling back to example
 * data; no credentials are kept here, so every connection and Aster account reads as not configured (the workbench
 * takes `configured` from its connections table); the Aster connection keeps its imported status instead of being
 * re-aggregated over the accounts (that aggregate only feeds the connections view, which this batch does not show).
 */
export async function readLedger(database: QueryDatabase, includeHistory: boolean): Promise<Ledger> {
  const [rows, settings, snapshotRows] = await Promise.all([
    database.prepare('SELECT data FROM assets').all<{ data: string }>(),
    database.prepare('SELECT key,value FROM settings').all<{ key: string; value: string }>(),
    includeHistory ? readSnapshotHistory(database) : Promise.resolve([]),
  ]);
  const source = settings.results.find(s => s.key === 'source-ledger');
  if (!source) throw new Error('资产库缺少原表数据（source-ledger），请重新导入');
  const ledger = seedLedger(JSON.parse(source.value) as SourceLedger, includeHistory);
  ledger.assets = rows.results.map(r => { const asset = JSON.parse(r.data) as Asset; return { ...asset, value: knownAssetValue(asset) }; }).sort((a, b) => Number(a.id.slice(4)) - Number(b.id.slice(4)));
  ledger.fx = Number(settings.results.find(s => s.key === 'fx')?.value ?? ledger.fx);
  ledger.fxStatus = JSON.parse(settings.results.find(s => s.key === 'fx-status')?.value ?? 'null') ?? ledger.fxStatus;
  for (const name of EXCHANGES) {
    const meta = settings.results.find(s => s.key === name + '-status');
    ledger.connections[name] = { ...ledger.connections[name], ...(meta ? JSON.parse(meta.value) : {}), configured: false } as Connection;
  }
  const savedAccounts = settings.results.find(s => s.key === 'aster-accounts')?.value;
  ledger.asterAccounts = readAsterAccounts(savedAccounts, [], ledger.assets.find(a => a.mode === 'aster'), ledger.connections.aster);
  ledger.history.push(...snapshotRows);
  ledger.withdrawals = JSON.parse(settings.results.find(s => s.key === 'withdrawals')?.value ?? '[]');
  return ledger;
}

/** Adapted from loadCashFlows in project_aggregation modules/asset/lib/cash-flow-store.ts (0014655): no owner. */
export async function loadCashFlows(database: QueryDatabase): Promise<CashFlowRecord[]> {
  const row = await database.prepare('SELECT value FROM settings WHERE key = ?').bind(CASH_FLOW_KEY).first<{ value: string }>();
  return readCashFlowAudit(row?.value);
}

/**
 * The rows of one recorded period. Adapted from GET in project_aggregation modules/asset/app/api/history/route.ts
 * (0014655): no owner; null where the workbench answers 404.
 */
export async function readPeriodRows(database: QueryDatabase, id: string): Promise<Asset[] | null> {
  const source = await database.prepare("SELECT value FROM settings WHERE key = 'source-ledger'").first<{ value: string }>();
  const raw: SourceLedger | null = source ? JSON.parse(source.value) : null;
  const original = raw?.periods.find(p => p.id === id);
  if (original) return original.rows.map(row => ({ ...row, value: knownAssetValue(row) })) as Asset[];
  if (!/^daily-\d{4}-\d{2}-\d{2}$/.test(id) && !/^archive-[a-f0-9-]{36}-\d+$/.test(id)) return null;
  const row = await database.prepare('SELECT data FROM snapshots WHERE date = ?').bind(id.startsWith('daily-') ? id.slice(6) : id).first<{ data: string }>();
  if (!row) return null;
  const rows = JSON.parse(row.data).assets as Asset[] | undefined;
  return rows?.map(asset => ({ ...asset, value: knownAssetValue(asset) })) ?? [];
}

export function parseImportInfo(value: string): ImportInfo {
  const info = JSON.parse(value) as Partial<ImportInfo>;
  if (typeof info.importedAt !== 'string' || typeof info.file !== 'string' || typeof info.owner !== 'string') throw new Error('资产库的导入记录（import-info）无效，请重新导入');
  return { importedAt: info.importedAt, file: info.file, owner: info.owner, assets: Number(info.assets) || 0, snapshots: Number(info.snapshots) || 0, settings: Array.isArray(info.settings) ? info.settings.filter(key => typeof key === 'string') : [] };
}


export interface AssetStore {
  state(): Promise<AssetState>;
  ledger(): Promise<AssetLedgerView>;
  history(): Promise<AssetHistoryView>;
  dailyChanges(): Promise<AssetDailyChangesView>;
  withdrawals(): Promise<AssetWithdrawalsView>;
  cashFlows(): Promise<AssetCashFlowsView>;
  /** null: imported, but no such period. */
  period(id: string): Promise<AssetPeriodView | null>;
  /**
   * The writes (A-2) take the request body as it came: invalid input throws AssetInputError, a refusal because of the
   * ledger's state (not imported, read-only file, lock busy or lost, imported again) AssetConflict, a refused edit a
   * plain Error with the workbench's message. Each answers with the view the page shows next.
   */
  editAsset(body: unknown): Promise<AssetLedgerView>;
  editFx(body: unknown): Promise<AssetLedgerView>;
  saveWithdrawal(body: unknown, editing: boolean): Promise<AssetLedgerView>;
  deleteWithdrawal(body: unknown): Promise<AssetLedgerView>;
  saveCashFlow(body: unknown): Promise<AssetCashFlowsView>;
  close(): void;
}
/** A write refused because the service may not write the file (opened read-only). */
export const READ_ONLY = '资产库不可写：asset.sqlite 或其 -wal/-shm 不归服务账户或没有写权限，请把它们改回服务账户所有（chown）并可写后重试';
/** SQLite's answers for a file this account may not write: READONLY, PERM, CANTOPEN (primary result codes). */
const NOT_WRITABLE_CODES = new Set([8, 3, 14]);
const sqliteCode = (error: unknown): number | undefined => { const code = (error as { errcode?: unknown } | null)?.errcode; return typeof code === 'number' ? code & 0xff : undefined; };

export function createAssetStore(file: string, { now = Date.now }: { now?: () => number } = {}): AssetStore {
  // Why the open handle is read-only: the files are not the service's to write, or another writer held the file too long.
  let handle: AssetDb | null = null, opened = '', writable = false, busy = false;
  /** Which file is at the path: a file deleted and imported again is a new one, and the open handle would keep reading the deleted one. */
  const identity = (): string | null => {
    try { const stat = statSync(file, { bigint: true }); return `${stat.dev}:${stat.ino}`; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  };
  const today = (): string => chinaDay(new Date(now()));
  const drop = () => { handle?.close(); handle = null; writable = false; busy = false; };
  /** Read-write when the service owns the files and can write them; otherwise read-only, so the reads still work. */
  function open(present: string) {
    try { assertOwnFiles(dirname(file)); }
    catch { handle = openAssetDb(file, { readOnly: true }); writable = false; opened = present; return; }
    try { handle = openAssetDb(file, { mode: 'service' }); writable = true; }
    catch (error) {
      const code = sqliteCode(error);
      // Only a file SQLite cannot write is read-only; busy (an import mid-transaction) keeps the reads and says so on a write.
      if (code === undefined || !(NOT_WRITABLE_CODES.has(code) || code === 5)) throw error;
      handle = openAssetDb(file, { readOnly: true }); writable = false; busy = code === 5;
    }
    opened = present;
  }
  /** The open file and its import record; null until an import has committed. */
  async function current(): Promise<{ database: AssetDb; info: ImportInfo } | null> {
    const present = identity();
    if (handle && present !== opened) drop();
    if (!handle) {
      if (present === null) return null;
      open(present);
    }
    let row: { value: string } | null;
    // An import creating the file has the tables only once it commits.
    try { row = await handle!.prepare("SELECT value FROM settings WHERE key = 'import-info'").first<{ value: string }>(); }
    catch (error) { if (error instanceof Error && /no such table/.test(error.message)) return null; throw error; }
    return row ? { database: handle!, info: parseImportInfo(row.value) } : null;
  }
  /** The file for a write; a read-only handle is opened again once (its owner may have been fixed since). */
  async function forWrite(): Promise<AssetDb> {
    if (handle && !writable) drop();
    const found = await current();
    if (!found) throw new AssetConflict('not_imported', NOT_IMPORTED);
    if (!writable) throw busy ? new AssetConflict('busy', LOCK_BUSY) : new AssetConflict('read_only', READ_ONLY);
    return found.database;
  }
  /** Serialize ledger changes (store.ts withLock): the lease is released however the change ends. */
  async function locked<T>(change: (database: AssetDb, lease: SyncLease) => Promise<T>): Promise<T> {
    const database = await forWrite();
    const lease = await acquireSyncLock(database, { now });
    try { return await change(database, lease); }
    // A failed release must not turn a saved change into an error; the lock then runs out after its TTL.
    finally { await lease.release().catch(() => undefined); }
  }
  const stamp = (info: ImportInfo) => ({ imported: true, importedAt: info.importedAt });
  async function ledger(): Promise<AssetLedgerView> {
    const found = await current(), day = today();
    if (!found) return notImported.ledger(day);
    return { ...stamp(found.info), today: day, ...ledgerView(await readLedger(found.database, false), day) };
  }
  async function cashFlows(): Promise<AssetCashFlowsView> {
    const found = await current();
    if (!found) return notImported.cashFlows();
    return { ...stamp(found.info), ...cashFlowsView(await loadCashFlows(found.database)) };
  }
  return {
    async state() {
      const found = await current();
      if (!found) return notImported.state();
      const { database, info } = found;
      const [assets, daily, archived, source] = await Promise.all([
        database.prepare('SELECT COUNT(*) AS count FROM assets').first<{ count: number }>(),
        database.prepare(`SELECT COUNT(*) AS count, MIN(date) AS first, MAX(date) AS last FROM snapshots WHERE ${DAILY_KEY}`).first<{ count: number; first: string | null; last: string | null }>(),
        database.prepare(`SELECT COUNT(*) AS count FROM snapshots WHERE NOT (${DAILY_KEY})`).first<{ count: number }>(),
        database.prepare("SELECT json_extract(value, '$.source') AS source FROM settings WHERE key = 'source-ledger'").first<{ source: string | null }>(),
      ]);
      return {
        ...stamp(info), source: { file: info.file, owner: info.owner },
        dataKind: !source ? null : source.source === EXAMPLE_SOURCE ? 'example' : 'personal',
        assets: Number(assets?.count ?? 0),
        snapshots: { count: Number(daily?.count ?? 0), first: daily?.first ?? null, last: daily?.last ?? null, archived: Number(archived?.count ?? 0) },
      };
    },
    ledger,
    async history() {
      const found = await current(), day = today();
      if (!found) return notImported.history(day);
      return { ...stamp(found.info), today: day, ...historyView(await readLedger(found.database, true), day) };
    },
    async dailyChanges() {
      const found = await current();
      if (!found) {
        const day = today();
        return { imported: false, importedAt: null, today: day, windowStart: shiftDay(day, -(DAILY_CHANGE_DAYS - 1)), days: [] };
      }
      return { ...stamp(found.info), ...await readDailyChanges(found.database, now()) };
    },
    async withdrawals() {
      const found = await current();
      if (!found) return notImported.withdrawals();
      return { ...stamp(found.info), ...withdrawalsView(await readLedger(found.database, false)) };
    },
    cashFlows,
    async period(id) {
      const found = await current();
      if (!found) return { imported: false, importedAt: null, rows: [] };
      const rows = await readPeriodRows(found.database, id);
      return rows === null ? null : { ...stamp(found.info), rows };
    },
    async editAsset(body) {
      const input = parseEdit(body);
      await locked(async (database, lease) => writes.editAsset(database, lease, await readLedger(database, false), input, now()));
      return ledger();
    },
    async editFx(body) {
      const fx = parseFx(body);
      await locked(async (database, lease) => writes.editFx(database, lease, await readLedger(database, false), fx, now()));
      return ledger();
    },
    async saveWithdrawal(body, editing) {
      const input = parseWithdrawal(body);
      await locked(async (database, lease) => writes.saveWithdrawal(database, lease, await readLedger(database, false), input, editing, now()));
      return ledger();
    },
    async deleteWithdrawal(body) {
      const id = parseWithdrawalId(body);
      await locked(async (database, lease) => writes.deleteWithdrawal(database, lease, await readLedger(database, false), id, now()));
      return ledger();
    },
    async saveCashFlow(body) {
      // The workbench parses before taking the lock (cash-flow-store.ts); its messages are business errors (400).
      const input = parseCashFlow(body, now());
      await locked(async (database, lease) => writes.saveCashFlow(database, lease, await loadCashFlows(database), input, now()));
      return cashFlows();
    },
    close() { drop(); },
  };
}
