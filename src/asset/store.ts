// The service's reads and writes of asset.sqlite. The file is opened on first use and only if it exists, so a service
// started before the first import serves "not imported" and picks the data up once import.ts has written it (WAL lets
// the import commit while this connection stays open). Since A-2 it is opened read-write and falls back to read-only
// when the service cannot write it; the writes (writes.ts) run under the sync lock (sync-lock.ts). The answers of the
// read endpoints come from a second, read-only connection to the same file, each in one short synchronous read
// transaction (db.ts snapshot()): the import record and the data of one answer are read from one committed state, so an
// import committed by another process between two of its statements cannot mix two ledgers (issue #11). A write commits
// before its answer is read, so the answer shows it. Since A-5 it also holds the positions and fills services (positions-service.ts,
// fills-service.ts): they read the saved connections of the open file on every use and live as long as the store.
import { statSync } from 'node:fs';
import { dirname } from 'node:path';
import { assertOwnFiles, openAssetDb, type AssetDb, type SnapshotDb } from './db.ts';
import type { QueryDatabase } from './query.ts';
import type { Asset, Connection, Ledger } from './types.ts';
import { seedLedger, type SourceLedger } from './seed.ts';
import { EXAMPLE_SOURCE } from './source-ledger.ts';
import { readSnapshotHistory } from './snapshot-history.ts';
import { aggregateAster, readAsterAccounts } from './aster-accounts.ts';
import { knownAssetValue } from './asset-values.ts';
import { chinaDay } from './withdrawals.ts';
import { CASH_FLOW_KEY, parseCashFlow, readCashFlowAudit, type CashFlowRecord } from './cash-flows.ts';
import { acquireSyncLock, AssetConflict, LOCK_BUSY, NOT_IMPORTED, type SyncLease } from './sync-lock.ts';
import { parseAsterAccount, parseAsterAccountDelete, parseConnection, parseDisconnect, parseEdit, parseFx, parseWithdrawal, parseWithdrawalId } from './validation.ts';
import { dataDirVault } from './credentials.ts';
import * as sync from './sync.ts';
import { createPositionsService, type PositionsServiceOptions } from './positions-service.ts';
import { createFillsService, type FillsServiceOptions } from './fills-service.ts';
import type { HubPositions } from './positions-types.ts';
import type { FillMarket, HubFills } from './fills-types.ts';
import { liveSources, type AssetSources, type SyncContext } from './sync.ts';
import { sharePublicReads } from './sources/shared-reads.ts';
import type { Fetcher } from './sources/http.ts';
import * as writes from './writes.ts';
import { importSource, parseImportBody } from './source-import.ts';
import type { ImportReply } from './views.ts';
export type { ImportReply } from './views.ts';
import { DAILY_CHANGE_DAYS, readDailyChanges, shiftDay } from './daily-changes.ts';
import {
  cashFlowsView, historyView, ledgerView, notImported, withdrawalsView,
  type AssetCashFlowsView, type AssetDailyChangesView, type AssetHistoryView, type AssetLedgerView, type AssetPeriodView, type AssetState, type AssetWithdrawalsView, type ImportInfo,
} from './views.ts';

const EXCHANGES = ['bybit', 'aster', 'binance', 'okx', 'gate', 'variational', 'hyperliquid', 'rh-lighter'] as const;
const DAILY_KEY = "date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'";

type LedgerRows = { assets: { data: string }[]; settings: { key: string; value: string }[]; connections: string[]; snapshots: Ledger['history'] };

/**
 * Adapted from readLedger in project_aggregation modules/asset/lib/store.ts (0014655). Changes: no owner and no
 * initialize() (the data comes from the import); the source ledger must be there instead of falling back to example
 * data; the clock is passed in (the Aster aggregate's time). Since A-3 `configured` comes from the connections table as
 * in the workbench, and saved Aster accounts are aggregated into the Aster connection the same way.
 */
function assembleLedger(rows: LedgerRows, includeHistory: boolean, at: number): Ledger {
  const { settings, connections } = rows;
  const source = settings.find(s => s.key === 'source-ledger');
  if (!source) throw new Error('资产库缺少原表数据（source-ledger），请重新导入');
  const ledger = seedLedger(JSON.parse(source.value) as SourceLedger, includeHistory);
  ledger.assets = rows.assets.map(r => { const asset = JSON.parse(r.data) as Asset; return { ...asset, value: knownAssetValue(asset) }; }).sort((a, b) => Number(a.id.slice(4)) - Number(b.id.slice(4)));
  ledger.fx = Number(settings.find(s => s.key === 'fx')?.value ?? ledger.fx);
  ledger.fxStatus = JSON.parse(settings.find(s => s.key === 'fx-status')?.value ?? 'null') ?? ledger.fxStatus;
  for (const name of EXCHANGES) {
    const meta = settings.find(s => s.key === name + '-status');
    ledger.connections[name] = { ...ledger.connections[name], ...(meta ? JSON.parse(meta.value) : {}), configured: connections.includes(name) } as Connection;
  }
  const savedAccounts = settings.find(s => s.key === 'aster-accounts')?.value;
  const asterAsset = ledger.assets.find(a => a.mode === 'aster');
  ledger.asterAccounts = readAsterAccounts(savedAccounts, connections, asterAsset, ledger.connections.aster);
  if (savedAccounts !== undefined && asterAsset) ledger.connections.aster = aggregateAster(ledger.asterAccounts, asterAsset, new Date(at).toISOString()).connection;
  ledger.history.push(...rows.snapshots);
  ledger.withdrawals = JSON.parse(settings.find(s => s.key === 'withdrawals')?.value ?? '[]');
  return ledger;
}
/** A file imported before A-3 and opened read-only has no connections table: nothing is connected. */
const noConnectionsTable = (error: unknown): string[] => { if (error instanceof Error && /no such table: connections/.test(error.message)) return []; throw error; };
const CONNECTION_NAMES = 'SELECT exchange FROM connections';
const IMPORT_INFO = "SELECT value FROM settings WHERE key = 'import-info'";

export async function readLedger(database: QueryDatabase, includeHistory: boolean, at = Date.now()): Promise<Ledger> {
  const [rows, settings, connections, snapshotRows] = await Promise.all([
    database.prepare('SELECT data FROM assets').all<{ data: string }>(),
    database.prepare('SELECT key,value FROM settings').all<{ key: string; value: string }>(),
    database.prepare(CONNECTION_NAMES).all<{ exchange: string }>().then(found => found.results.map(row => row.exchange), noConnectionsTable),
    includeHistory ? readSnapshotHistory(database) : Promise.resolve([]),
  ]);
  return assembleLedger({ assets: rows.results, settings: settings.results, connections, snapshots: snapshotRows }, includeHistory, at);
}

/** readLedger without history, synchronously: for a write that reads the ledger inside its transaction. */
export function currentLedger(database: Pick<AssetDb, 'prepare'>, at: number): Ledger {
  let connections: string[];
  try { connections = database.prepare(CONNECTION_NAMES).rows<{ exchange: string }>().map(row => row.exchange); } catch (error) { connections = noConnectionsTable(error); }
  return assembleLedger({
    assets: database.prepare('SELECT data FROM assets').rows<{ data: string }>(),
    settings: database.prepare('SELECT key,value FROM settings').rows<{ key: string; value: string }>(),
    connections, snapshots: [],
  }, false, at);
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
  const recorded = /^daily-\d{4}-\d{2}-\d{2}$/.test(id) || /^archive-[a-f0-9-]{36}-\d+$/.test(id);
  // Both statements start before the first await, so a snapshot read (db.ts) runs them in one read transaction.
  const [source, row] = await Promise.all([
    database.prepare("SELECT value FROM settings WHERE key = 'source-ledger'").first<{ value: string }>(),
    recorded ? database.prepare('SELECT data FROM snapshots WHERE date = ?').bind(id.startsWith('daily-') ? id.slice(6) : id).first<{ data: string }>() : Promise.resolve(null),
  ]);
  const raw: SourceLedger | null = source ? JSON.parse(source.value) : null;
  const original = raw?.periods.find(p => p.id === id);
  if (original) return original.rows.map(row => ({ ...row, value: knownAssetValue(row) })) as Asset[];
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
  /**
   * The workbook import (A-6, the workbench's POST /api/import): a preview answers the summary and the fingerprint to
   * apply with; an applied import (or the same file again) answers the new ledger view, with the summary and the backup.
   */
  importSource(body: unknown): Promise<ImportReply>;
  /**
   * The connection writes and the sync (A-3/A-4), same contract. A failed exchange verification is a plain Error with the
   * exchange's message (nothing saved); a credential that cannot be opened, the network and the database are errors the
   * HTTP layer answers with 503. The sync answers the ledger as it is when the last attempt was less than 30 s ago.
   */
  sync(body: unknown): Promise<AssetLedgerView>;
  connect(body: unknown): Promise<AssetLedgerView>;
  disconnect(body: unknown): Promise<AssetLedgerView>;
  saveAsterAccount(body: unknown, editing: boolean): Promise<AssetLedgerView>;
  deleteAsterAccount(body: unknown): Promise<AssetLedgerView>;
  /**
   * The positions and fills of the saved connections (A-5), read-only and cached (the workbench's hub positions and
   * fills). Before the import every account is unconfigured. A failure throws (the HTTP layer answers 503).
   */
  positions(): Promise<HubPositions>;
  fills(market: FillMarket): Promise<HubFills>;
  close(): void;
}
/** A write refused because the service may not write the file (opened read-only). */
export const READ_ONLY = '资产库不可写：asset.sqlite 或其 -wal/-shm 不归服务账户或没有写权限，请把它们改回服务账户所有（chown）并可写后重试';
/** SQLite's answers for a file this account may not write: READONLY, PERM, CANTOPEN (primary result codes). */
const NOT_WRITABLE_CODES = new Set([8, 3, 14]);
const sqliteCode = (error: unknown): number | undefined => { const code = (error as { errcode?: unknown } | null)?.errcode; return typeof code === 'number' ? code & 0xff : undefined; };

export interface AssetStoreOptions {
  now?: () => number;
  /** The fetch every external read goes through (tests pass a fake one). */
  fetch?: Fetcher;
  /** Replaces single external readers (tests). */
  sources?: Partial<AssetSources>;
  /** Options of the positions and fills services (tests); their fetch defaults to `fetch` above. */
  positions?: PositionsServiceOptions;
  fills?: FillsServiceOptions;
}
export function createAssetStore(file: string, { now = Date.now, fetch: fetcher = fetch, sources: replaced = {}, positions: positionsOptions = {}, fills: fillsOptions = {} }: AssetStoreOptions = {}): AssetStore {
  const shared = sharePublicReads(fetcher, now);
  const sources: AssetSources = { ...liveSources(fetcher, shared), ...replaced };
  const vault = dataDirVault(dirname(file));
  const positionsService = createPositionsService({ now, fetcher: shared.fetcher, ...positionsOptions });
  const fillsService = createFillsService({ now, fetcher, ...fillsOptions });
  // Other ledger writes only peek. An asset sync refreshes the same cache alongside balance reads.
  const context = (database: AssetDb, lease: SyncLease): SyncContext => ({ database, lease, vault, sources, now, positions: positionsService.peek });
  const peek = positionsService.peek;
  // Why the open handle is read-only: the files are not the service's to write, or another writer held the file too long.
  let handle: AssetDb | null = null, opened = '', writable = false, busy = false;
  /** The read-only connection the read answers come from (snapshot() below); opened after `handle`, closed with it. */
  let reader: AssetDb | null = null;
  const dropReader = () => { const open = reader; reader = null; open?.close(); };
  /** Which file is at the path: a file deleted and imported again is a new one, and the open handle would keep reading the deleted one. */
  const identity = (): string | null => {
    try { const stat = statSync(file, { bigint: true }); return `${stat.dev}:${stat.ino}`; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  };
  const today = (): string => chinaDay(new Date(now()));
  const drop = () => { dropReader(); handle?.close(); handle = null; writable = false; busy = false; };
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
  /** Opens the file at the path (again, once it was replaced); false while there is none. */
  function attach(): boolean {
    const present = identity();
    if (handle && present !== opened) drop();
    if (!handle) {
      if (present === null) return false;
      open(present);
    }
    return true;
  }
  /** The import record; null until an import has committed (an import creating the file has the tables only then). */
  function importInfo(database: Pick<AssetDb, 'prepare'> | SnapshotDb): ImportInfo | null {
    let row: { value: string } | null;
    try { row = database.prepare(IMPORT_INFO).get<{ value: string }>(); }
    catch (error) { if (error instanceof Error && /no such table/.test(error.message)) return null; throw error; }
    return row ? parseImportInfo(row.value) : null;
  }
  /** The open file and its import record, for the writes and the positions and fills services. */
  async function current(): Promise<{ database: AssetDb; info: ImportInfo } | null> {
    if (!attach()) return null;
    const info = importInfo(handle!);
    return info ? { database: handle!, info } : null;
  }
  /**
   * One read answer from one committed state of the file: the import record and every statement `read` starts before
   * returning run in one read transaction of the read-only connection; null until an import has committed. A failure
   * closes that connection (closing ends any transaction left open); the next read opens it again.
   */
  function snapshot<T>(read: (database: SnapshotDb, info: ImportInfo) => Promise<T>): Promise<T> | null {
    if (!attach()) return null;
    try {
      reader ??= openAssetDb(file, { mode: 'snapshot' });
      return reader.snapshot(database => { const info = importInfo(database); return info ? read(database, info) : null; });
    } catch (error) { dropReader(); throw error; }
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
  /** The open file for the positions and fills services, read again on every use (a re-import reopens it); null before the import. */
  async function source(): Promise<() => AssetDb | null> {
    const found = await current();
    return found ? () => handle : () => null;
  }
  const stamp = (info: ImportInfo) => ({ imported: true, importedAt: info.importedAt });
  async function ledger(): Promise<AssetLedgerView> {
    const day = today();
    return await snapshot(async (database, info) => ({ ...stamp(info), today: day, ...ledgerView(await readLedger(database, false), day) })) ?? notImported.ledger(day);
  }
  async function cashFlows(): Promise<AssetCashFlowsView> {
    return await snapshot(async (database, info) => ({ ...stamp(info), ...cashFlowsView(await loadCashFlows(database)) })) ?? notImported.cashFlows();
  }
  return {
    async state() {
      return await snapshot(async (database, info): Promise<AssetState> => {
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
      }) ?? notImported.state();
    },
    ledger,
    async history() {
      const day = today();
      return await snapshot(async (database, info) => ({ ...stamp(info), today: day, ...historyView(await readLedger(database, true), day) })) ?? notImported.history(day);
    },
    async dailyChanges() {
      const at = now();
      const found = snapshot(async (database, info) => ({ ...stamp(info), ...await readDailyChanges(database, at) }));
      if (found) return found;
      const day = today();
      return { imported: false, importedAt: null, today: day, windowStart: shiftDay(day, -(DAILY_CHANGE_DAYS - 1)), days: [] };
    },
    async withdrawals() {
      return await snapshot(async (database, info) => ({ ...stamp(info), ...withdrawalsView(await readLedger(database, false)) })) ?? notImported.withdrawals();
    },
    cashFlows,
    async period(id) {
      const found = snapshot(async (database, info) => {
        const rows = await readPeriodRows(database, id);
        return rows === null ? null : { ...stamp(info), rows };
      });
      return found ? await found : { imported: false, importedAt: null, rows: [] };
    },
    async editAsset(body) {
      const input = parseEdit(body);
      await locked(async (database, lease) => writes.editAsset(database, lease, await readLedger(database, false), input, now(), peek));
      return ledger();
    },
    async editFx(body) {
      const fx = parseFx(body);
      await locked(async (database, lease) => writes.editFx(database, lease, await readLedger(database, false), fx, now(), peek));
      return ledger();
    },
    async sync() {
      await locked(async (database, lease) => {
        await sync.refresh(context(database, lease), () => positionsService.refreshForSnapshot(() => handle, vault.unseal));
      });
      return ledger();
    },
    async connect(body) {
      const input = parseConnection(body);
      await locked((database, lease) => sync.connect(context(database, lease), input));
      return ledger();
    },
    async disconnect(body) {
      const exchange = parseDisconnect(body);
      await locked((database, lease) => sync.disconnect(context(database, lease), exchange));
      return ledger();
    },
    async saveAsterAccount(body, editing) {
      const input = parseAsterAccount(body);
      await locked((database, lease) => sync.connectAsterAccount(context(database, lease), input, editing));
      return ledger();
    },
    async deleteAsterAccount(body) {
      const { id, action } = parseAsterAccountDelete(body);
      await locked((database, lease) => sync.deleteAsterAccount(context(database, lease), id, action));
      return ledger();
    },
    async saveWithdrawal(body, editing) {
      const input = parseWithdrawal(body);
      await locked(async (database, lease) => writes.saveWithdrawal(database, lease, await readLedger(database, false), input, editing, now(), peek));
      return ledger();
    },
    async deleteWithdrawal(body) {
      const id = parseWithdrawalId(body);
      await locked(async (database, lease) => writes.deleteWithdrawal(database, lease, await readLedger(database, false), id, now(), peek));
      return ledger();
    },
    async importSource(body) {
      const input = parseImportBody(body);
      const result = await locked(async (database, lease) => importSource(database, lease, await readLedger(database, false, now()), input, { dbFile: file, now, peek }));
      if (result.kind === 'preview') return { preview: true, summary: result.summary, fingerprint: result.fingerprint };
      return { ...await ledger(), preview: false, alreadyImported: result.kind === 'already', import: result.kind === 'applied' ? { summary: result.summary, backupName: result.backupName } : null };
    },
    async saveCashFlow(body) {
      // The workbench parses before taking the lock (cash-flow-store.ts); its messages are business errors (400).
      const input = parseCashFlow(body, now());
      await locked(async (database, lease) => writes.saveCashFlow(database, lease, await loadCashFlows(database), input, now()));
      return cashFlows();
    },
    async positions() { return positionsService.read(await source(), vault.unseal); },
    async fills(market) { return fillsService.read(await source(), vault.unseal, market); },
    close() { positionsService.close(); fillsService.close(); shared.reset(); drop(); },
  };
}
