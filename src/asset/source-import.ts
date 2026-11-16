// The workbook import (A08, batch A-6). Adapted from project_aggregation modules/asset/lib/import-ledger.ts at 7745181
// (importPlan, importLedger; same at 0014655) and app/api/import/route.ts (the body). The rules and messages are the
// workbench's. Changes:
// - no owner; the caller (store.ts) holds the sync lock (the workbench's withLock) and passes the ledger read under it;
// - the body is checked strictly ({source, apply, fingerprint}): an unknown key refuses it, as the other asset writes do;
// - apply needs the fingerprint the preview returned, and refuses (409) when the file sent differs from the previewed one
//   (the workbench applies whatever is sent the second time);
// - the backup: node:sqlite's online backup (the workbench's better-sqlite3 db.backup(), into .data/backups, chmod after),
//   here into a temporary file created empty with mode 600 in <data dir>/asset-backups (700), in one step that runs in
//   the thread pool so the service's other loops keep running; checked with PRAGMA quick_check, fsynced, renamed to its
//   final name and the directory fsynced before anything is written. A failed backup writes nothing (AssetBackupError, answered 503). After a successful import only
//   the newest BACKUP_KEEP backups stay;
// - the write re-checks, in its transaction, that the source ledger it planned from is still there (the lease already
//   refuses once the ledger was imported again from the workbench, import-info);
// - today's snapshot is written by writes.ts saveSnapshot (the workbench's snapshot(): it also carries `withdrawn` and
//   the cached positions) instead of the hand-built row of importLedger, which lacks those two fields;
// - the clock is injected.
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import type { AssetDb } from './db.ts';
import type { SyncLease } from './sync-lock.ts';
import { AssetConflict } from './sync-lock.ts';
import type { Asset, Ledger } from './types.ts';
import type { ImportSummary } from './views.ts';
export type { ImportSummary } from './views.ts';
import { seedLedger } from './seed.ts';
import { EXAMPLE_SOURCE, isGateProject, isHyperliquidProject, parseSource, type SourceLedger } from './source-ledger.ts';
import { quantityValue, withMarketQuantity, UNKNOWN_QUANTITY_ERROR } from './asset-values.ts';
import { AssetInputError } from './validation.ts';
import { saveSetting, saveSnapshot, type PositionsPeek } from './writes.ts';

export const BACKUP_DIR = 'asset-backups';
/** The backups kept after a successful import (the newest by time); older ones are removed then. */
export const BACKUP_KEEP = 5;
/**
 * The backup copies every page in one step (-1). Copied in several steps, a write to the source from another connection
 * between two steps restarts the copy from the start, without bound while the source is written often (fill_cache and the
 * workbench import write without the sync lock). The one step runs in the thread pool and holds only a WAL read
 * transaction, so neither the event loop nor the writers wait for it.
 */
export const BACKUP_PAGES_PER_STEP = -1;
const BACKUP_NAME = /^before-import-[0-9a-f-]{36}\.sqlite$/;
/** A copy still being made; outside BACKUP_NAME so a leftover (the process stopped mid-copy) never counts as a backup. */
const PARTIAL_NAME = /^\.partial-[0-9a-f-]{36}\.sqlite(-wal|-shm|-journal)?$/;
export const IMPORT_FINGERPRINT_KEY = 'source-import-hash';
export const IMPORT_CHANGED = '导入文件与预览时不同，请重新选择文件并预览';
export const BACKUP_FAILED = '导入前备份数据库失败，未执行导入，已有数据保持不变';
/** The backup could not be made (or checked); nothing was written. */
export class AssetBackupError extends Error {
  constructor() { super(BACKUP_FAILED); this.name = 'AssetBackupError'; }
}

export type ImportInput = { source: unknown; apply: boolean; fingerprint: string | null };

/** The body of POST /api/asset/import: {source, apply: boolean, fingerprint?: sha256 hex}; apply needs the fingerprint. */
export function parseImportBody(value: unknown): ImportInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AssetInputError('请求体须为对象');
  const body = value as Record<string, unknown>;
  const extra = Object.keys(body).find(key => !['source', 'apply', 'fingerprint'].includes(key));
  if (extra !== undefined) throw new AssetInputError(`不认识的字段 ${extra.slice(0, 40)}`);
  if (!Object.hasOwn(body, 'source')) throw new AssetInputError('缺少字段 source');
  if (typeof body.apply !== 'boolean') throw new AssetInputError('apply 须为布尔值');
  const fingerprint = body.fingerprint === undefined ? null : body.fingerprint;
  if (fingerprint !== null && (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint))) throw new AssetInputError('fingerprint 格式不正确');
  if (body.apply && fingerprint === null) throw new AssetInputError('缺少字段 fingerprint');
  return { source: body.source, apply: body.apply, fingerprint };
}

/** Copied from importPlan: which saved rows survive the import (synced balances, manual edits, the current rate). */
export function importPlan(source: SourceLedger, current: Ledger, previous: SourceLedger, at: number) {
  const imported = seedLedger(source), old = seedLedger(previous);
  const retained: string[] = [], matched = new Set<string>();
  const key = (asset: Asset) => asset.mode === 'manual' ? isGateProject(asset.project) ? 'gate' : isHyperliquidProject(asset.project) ? 'hyperliquid' : asset.project + '\0' + asset.kind : asset.mode;
  const edited = (asset: Asset) => {
    const base = old.assets.find(a => a.id === asset.id);
    return !base || asset.quantity !== base.quantity || (asset.mode === 'manual' && (asset.price !== base.price || asset.value !== base.value));
  };
  imported.assets = imported.assets.map(asset => {
    const existing = current.assets.filter(a => key(a) === key(asset));
    if (existing.length > 1) throw new Error('已有资产名称和类型重复，无法安全合并');
    const saved = existing[0];
    if (!saved) return asset;
    matched.add(saved.id);
    if ((asset.mode === 'bybit' || asset.mode === 'aster' || asset.mode === 'binance' || asset.mode === 'okx' || asset.mode === 'gate' || asset.mode === 'variational' || asset.mode === 'hyperliquid' || asset.mode === 'rh-lighter') && (current.connections[asset.mode].configured || current.connections[asset.mode].lastSync)) {
      retained.push(asset.project + ' 已同步余额');
      return { ...saved, id: asset.id, cell: asset.cell };
    }
    if (saved.mode === 'manual' && edited(saved)) {
      retained.push(asset.project + ' 手动修改');
      return { ...saved, id: asset.id, cell: asset.cell };
    }
    if (asset.mode === 'market') {
      const quantity = edited(saved) ? saved.quantity : asset.quantity;
      if (edited(saved)) retained.push(asset.project + ' 手动数量');
      const fresh = saved.price !== null && (!saved.error || saved.error === UNKNOWN_QUANTITY_ERROR) && at - Date.parse(saved.updatedAt) < 900000;
      if (fresh) return withMarketQuantity({ ...saved, id: asset.id, cell: asset.cell }, quantity);
      return { ...asset, quantity, value: quantityValue(quantity, asset.price) };
    }
    return asset;
  });
  let nextId = Math.max(...imported.assets.map(a => Number(a.id.slice(4)))) + 1;
  for (const asset of current.assets) {
    const syncedWallet = (asset.mode === 'binance' || asset.mode === 'okx' || asset.mode === 'gate' || asset.mode === 'variational' || asset.mode === 'hyperliquid' || asset.mode === 'rh-lighter') && (current.connections[asset.mode].configured || current.connections[asset.mode].lastSync);
    if (!matched.has(asset.id) && (edited(asset) || syncedWallet)) {
      imported.assets.push({ ...asset, id: 'row-' + nextId++ });
      retained.push(asset.project + (syncedWallet ? ' 已同步余额（额外保留）' : ' 手动修改（额外保留）'));
    }
  }
  if (current.fx !== old.fx || current.fxStatus.source !== 'saved') { imported.fx = current.fx; imported.fxStatus = current.fxStatus; retained.push('当前汇率'); }
  return { ledger: imported, retained };
}

const fsyncPath = (path: string, flags: string) => { const handle = openSync(path, flags); try { fsyncSync(handle); } finally { closeSync(handle); } };

/**
 * A consistent copy of the database next to it, made with SQLite's online backup in one step from a connection of its own
 * (a snapshot of the last commit; writes from other connections meanwhile go on and are not in the copy). It is written
 * under a temporary .partial- name and renamed only once checked and synced, so the backup name always means a complete
 * copy. Throws AssetBackupError and leaves no file behind on failure.
 */
export async function backupDatabase(dbFile: string, name: string): Promise<string> {
  const directory = join(dirname(dbFile), BACKUP_DIR), path = join(directory, name), partial = join(directory, `.partial-${randomUUID()}.sqlite`);
  let created = false;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('not a directory');
    // An existing directory (made by hand, or by an older umask) is narrowed to the service account too.
    if ((stat.mode & 0o777) !== 0o700) chmodSync(directory, 0o700);
    removePartials(directory);
    // Created empty and private before SQLite writes into it, so the copy is never readable by others.
    closeSync(openSync(partial, 'wx', 0o600)); created = true;
    const from = new DatabaseSync(dbFile, { readOnly: true });
    try { await backup(from, partial, { rate: BACKUP_PAGES_PER_STEP }); } finally { from.close(); }
    // The copy carries the source's WAL mode; a rollback journal keeps it one self-contained file (no -wal, -shm beside it).
    const check = new DatabaseSync(partial);
    try {
      check.exec('PRAGMA journal_mode = DELETE');
      if ((check.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined)?.quick_check !== 'ok') throw new Error('backup check failed');
    } finally { check.close(); }
    fsyncPath(partial, 'r+');
    // The final name carries a fresh uuid (importSource), so the rename replaces nothing.
    renameSync(partial, path);
    fsyncPath(directory, 'r');
    return path;
  } catch {
    if (created) for (const file of [partial, partial + '-wal', partial + '-shm', partial + '-journal']) try { rmSync(file, { force: true }); } catch { /* removed before the next import */ }
    throw new AssetBackupError();
  }
}

/** Removes copies a stopped process left half made (only the .partial- names this module writes). */
function removePartials(directory: string): void {
  for (const name of readdirSync(directory)) if (PARTIAL_NAME.test(name)) rmSync(join(directory, name), { force: true });
}

/** Keeps the newest BACKUP_KEEP import backups (by modification time); a file that cannot be removed stays. */
export function pruneBackups(dbFile: string, keep = BACKUP_KEEP): void {
  const directory = join(dirname(dbFile), BACKUP_DIR);
  let names: string[];
  try { names = readdirSync(directory).filter(name => BACKUP_NAME.test(name)); } catch { return; }
  const dated = names.flatMap(name => { try { return [{ name, at: statSync(join(directory, name)).mtimeMs }]; } catch { return []; } })
    .sort((a, b) => b.at - a.at || (a.name < b.name ? 1 : -1));
  for (const { name } of dated.slice(keep)) try { rmSync(join(directory, name), { force: true }); } catch { /* left for the next import */ }
}

export type ImportResult =
  | { kind: 'already' }
  | { kind: 'preview'; summary: ImportSummary; fingerprint: string }
  | { kind: 'applied'; summary: ImportSummary; backupName: string };

/** importLedger under the caller's lease: import once into the example ledger; never overwrite a personal one. */
export async function importSource(database: AssetDb, lease: SyncLease, current: Ledger, input: ImportInput, options: { dbFile: string; now: () => number; peek?: PositionsPeek }): Promise<ImportResult> {
  const source = parseSource(input.source);
  if (source.source === EXAMPLE_SOURCE) throw new Error('请选择从原表生成的导入文件，不能再次导入示例');
  const fingerprint = createHash('sha256').update(JSON.stringify(source)).digest('hex');
  const prior = database.prepare('SELECT value FROM settings WHERE key = ?').bind(IMPORT_FINGERPRINT_KEY).get<{ value: string }>();
  if (prior?.value === fingerprint) return { kind: 'already' };
  if (current.dataKind !== 'example') throw new Error('此账本已含原表数据，已停止导入以保留现有记录');
  const original = database.prepare("SELECT value FROM settings WHERE key = 'source-ledger'").get<{ value: string }>();
  if (!original) throw new Error('无法读取原有记录，未执行导入');
  const previous = JSON.parse(original.value) as SourceLedger;
  const at = options.now();
  const plan = importPlan(source, current, previous, at);
  const summary: ImportSummary = {
    source: source.source, rows: seedLedger(source).assets.length, periods: source.periods.length,
    baselineDate: source.baselineDate, baselineTotal: plan.ledger.baselineTotal,
    resultingRows: plan.ledger.assets.length, retained: plan.retained,
  };
  if (!input.apply) return { kind: 'preview', summary, fingerprint };
  if (input.fingerprint !== fingerprint) throw new AssetConflict('import_changed', IMPORT_CHANGED);

  const batchId = randomUUID(), backupName = 'before-import-' + batchId + '.sqlite';
  await backupDatabase(options.dbFile, backupName);
  lease.write(() => {
    // The lease refuses a re-import from the workbench; this refuses any other change of the planned-from source.
    if (database.prepare("SELECT value FROM settings WHERE key = 'source-ledger'").get<{ value: string }>()?.value !== original.value) throw new Error('无法读取原有记录，未执行导入');
    const snapshots = database.prepare('SELECT data FROM snapshots').rows<{ data: string }>();
    // Keep pre-import snapshots readable, but exclude example values from the real trend.
    const archived = [
      ...previous.periods.map(({ rows, ...period }) => ({ ...period, assets: rows })),
      ...snapshots.map(row => JSON.parse(row.data) as Record<string, unknown>),
    ].map((period, index) => ({ ...period, id: `archive-${batchId}-${index}`, archived: true }));
    database.prepare('DELETE FROM assets').run();
    for (const asset of plan.ledger.assets) database.prepare('INSERT INTO assets(id,data) VALUES(?,?)').bind(asset.id, JSON.stringify(asset)).run();
    const settings: Record<string, string> = { 'source-ledger': JSON.stringify(source), [IMPORT_FINGERPRINT_KEY]: fingerprint, fx: String(plan.ledger.fx), 'fx-status': JSON.stringify(plan.ledger.fxStatus), 'last-attempt': '0' };
    for (const [key, value] of Object.entries(settings)) saveSetting(database, key, value);
    database.prepare('DELETE FROM snapshots').run();
    for (const period of archived) database.prepare('INSERT INTO snapshots(date,data) VALUES(?,?)').bind(period.id, JSON.stringify(period)).run();
    saveSnapshot(database, { ...plan.ledger, connections: current.connections }, at, options.peek);
  });
  pruneBackups(options.dbFile);
  return { kind: 'applied', summary, backupName };
}
