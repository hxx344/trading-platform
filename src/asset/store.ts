// The service's reads of asset.sqlite. The file is opened read-only on first use and only if it exists, so a service
// started before the first import serves "not imported" and picks the data up once import.ts has written it (WAL lets
// the import commit while this connection stays open). Nothing here writes.
import { existsSync } from 'node:fs';
import { openAssetDb, type AssetDb } from './db.ts';
import type { QueryDatabase } from './query.ts';
import type { Asset, Connection, Ledger } from './types.ts';
import { seedLedger, type SourceLedger } from './seed.ts';
import { EXAMPLE_SOURCE } from './source-ledger.ts';
import { readSnapshotHistory } from './snapshot-history.ts';
import { readAsterAccounts } from './aster-accounts.ts';
import { knownAssetValue } from './asset-values.ts';
import { chinaDay } from './withdrawals.ts';
import { CASH_FLOW_KEY, readCashFlowAudit, type CashFlowRecord } from './cash-flows.ts';
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

export interface AssetReader {
  state(): Promise<AssetState>;
  ledger(): Promise<AssetLedgerView>;
  history(): Promise<AssetHistoryView>;
  dailyChanges(): Promise<AssetDailyChangesView>;
  withdrawals(): Promise<AssetWithdrawalsView>;
  cashFlows(): Promise<AssetCashFlowsView>;
  /** null: imported, but no such period. */
  period(id: string): Promise<AssetPeriodView | null>;
  close(): void;
}

export function createAssetReader(file: string, { now = Date.now }: { now?: () => number } = {}): AssetReader {
  let handle: AssetDb | null = null;
  const today = (): string => chinaDay(new Date(now()));
  /** The open file and its import record; null until an import has committed. */
  async function current(): Promise<{ database: AssetDb; info: ImportInfo } | null> {
    if (!handle) {
      if (!existsSync(file)) return null;
      handle = openAssetDb(file, { readOnly: true });
    }
    let row: { value: string } | null;
    // An import creating the file has the tables only once it commits.
    try { row = await handle.prepare("SELECT value FROM settings WHERE key = 'import-info'").first<{ value: string }>(); }
    catch (error) { if (error instanceof Error && /no such table/.test(error.message)) return null; throw error; }
    return row ? { database: handle, info: parseImportInfo(row.value) } : null;
  }
  const stamp = (info: ImportInfo) => ({ imported: true, importedAt: info.importedAt });
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
    async ledger() {
      const found = await current(), day = today();
      if (!found) return notImported.ledger(day);
      return { ...stamp(found.info), today: day, ...ledgerView(await readLedger(found.database, false), day) };
    },
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
    async cashFlows() {
      const found = await current();
      if (!found) return notImported.cashFlows();
      return { ...stamp(found.info), ...cashFlowsView(await loadCashFlows(found.database)) };
    },
    async period(id) {
      const found = await current();
      if (!found) return { imported: false, importedAt: null, rows: [] };
      const rows = await readPeriodRows(found.database, id);
      return rows === null ? null : { ...stamp(found.info), rows };
    },
    close() { handle?.close(); handle = null; },
  };
}
