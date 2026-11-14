// Copies one workbench user's ledger into asset.sqlite: node src/asset/import.ts --from <ledger.sqlite> --owner <user> --data-dir <dir>.
// The workbench file is opened read-only and only read; everything is read and checked before the target is touched,
// and the target is replaced in one transaction, so a failed import leaves the previous data as it was. Credentials
// (the connections table) are never read here, and the settings are copied by an allow-list with the account identifiers
// dropped: Aster wallet addresses, and the key or wallet tails (`label`) the accounts and exchange statuses show. Every
// import replaces this service's connections too (A-3): this command brings none, so the saved connections are cleared
// and the exchanges are connected again on the page; the page's and install.sh's import (src/service/import-modules.ts)
// brings them over re-sealed with this service's key (import-writer.ts).
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { ASSET_DB_FILE, openAssetDb } from './db.ts';
import { readCashFlowAudit } from './cash-flows.ts';
import { assertDedicatedDataDir } from '../data-dir.ts';
import type { ImportInfo } from './views.ts';

const EXCHANGES = ['bybit', 'aster', 'binance', 'okx', 'gate', 'variational', 'hyperliquid', 'rh-lighter'] as const;
/** Settings the read-only pages use; everything else of the workbench (sync state, import hashes) stays behind. */
export const IMPORTED_SETTINGS: readonly string[] = ['initialized', 'fx', 'fx-status', 'source-ledger', 'withdrawals', 'cash-flow-audit-v1', 'aster-accounts', 'last-attempt', ...EXCHANGES.map(name => `${name}-status`)];
const ASTER_ACCOUNT_FIELDS = ['id', 'name', 'value', 'details', 'updatedAt', 'includeSpot', 'configured', 'lastSync', 'error', 'scope'] as const;
const STATUS_FIELDS = ['configured', 'lastSync', 'error', 'scope'] as const;
/** Key names that only credentials or account identifiers use; any of them left after the allow-list refuses the import. */
const CREDENTIAL_KEYS = new Set(['apikey', 'apisecret', 'apisecretkey', 'secret', 'secretkey', 'privatekey', 'passphrase', 'password', 'mnemonic', 'seedphrase', 'vrtoken', 'accesstoken', 'authtoken', 'walletaddress', 'encrypted', 'credential', 'credentials', 'signer']);
/** A wallet address or a 64-digit hex string (a private key or a transaction hash) inside an exchange's error text. */
const IDENTIFIER_TEXT = /\b(?:0x)?[0-9a-fA-F]{64}\b|\b0x[0-9a-fA-F]{40}\b/g;
/** Exchange error text is free-form and can quote the account it was about; the identifier is cut out, the rest kept. */
export const redactError = <T extends Record<string, unknown>>(value: T): T =>
  typeof value.error === 'string' ? { ...value, error: value.error.replace(IDENTIFIER_TEXT, '（已隐去）') } : value;

export interface ImportOptions { from: string; owner: string; dataDir: string; now?: () => number }
export type ImportSummary = ImportInfo;
/** One owner's rows of the three workbench tables, as read (the import helper gets them as JSON from a reader process). */
export interface SourceRows { assets: { id: string; data: string }[]; snapshots: { date: string; data: string }[]; settings: { key: string; value: string }[] }
/** The rows checked and cleaned, ready to replace asset.sqlite, with the import record written beside them. */
export interface PreparedLedger { assets: { id: string; data: string }[]; snapshots: { date: string; data: string }[]; settings: { key: string; value: string }[]; info: ImportInfo }

const pick = (value: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(fields.filter(field => Object.hasOwn(value, field)).map(field => [field, value[field]]));
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function parseJson(text: string, what: string): unknown {
  try { return JSON.parse(text); } catch { throw new Error(`${what}不是有效的 JSON`); }
}

/** Throws naming the key (never its value) when a credential-like key is anywhere in `value`. */
export function assertNoCredentials(value: unknown, where: string): void {
  const stack: unknown[] = [value];
  while (stack.length) {
    const item = stack.pop();
    if (Array.isArray(item)) { stack.push(...item); continue; }
    if (!isRecord(item)) continue;
    for (const [key, child] of Object.entries(item)) {
      // Separators are dropped first, so api_key and vr-token read as apiKey and vrToken.
      if (CREDENTIAL_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''))) throw new Error(`${where}含有凭据或账户标识字段 ${key}，已拒绝导入`);
      stack.push(child);
    }
  }
}

/** The allow-listed settings with the identifiers removed; the stored text keeps the workbench's JSON otherwise. */
function cleanSetting(key: string, value: string): string {
  if (key === 'initialized' || key === 'last-attempt') return value;
  if (key === 'fx') {
    if (!(Number(value) > 0)) throw new Error('设置 fx 不是正数');
    return value;
  }
  const parsed = parseJson(value, `设置 ${key} `);
  let cleaned: unknown = parsed;
  if (key === 'aster-accounts') {
    if (!Array.isArray(parsed) || !parsed.every(isRecord)) throw new Error('设置 aster-accounts 不是账号列表');
    cleaned = parsed.map(account => redactError(pick(account, ASTER_ACCOUNT_FIELDS)));
  } else if (key.endsWith('-status') && key !== 'fx-status') {
    if (!isRecord(parsed)) throw new Error(`设置 ${key} 格式无效`);
    cleaned = redactError(pick(parsed, STATUS_FIELDS));
  } else if (key === 'withdrawals') {
    if (!Array.isArray(parsed)) throw new Error('设置 withdrawals 不是列表');
  } else if (key === 'cash-flow-audit-v1') {
    try { readCashFlowAudit(value); } catch (error) { throw new Error(`设置 cash-flow-audit-v1 无效：${error instanceof Error ? error.message : String(error)}`); }
  } else if (key === 'source-ledger') {
    const source = parsed as { periods?: unknown; baselineId?: unknown };
    if (!isRecord(parsed) || !Array.isArray(source.periods) || !source.periods.some(period => isRecord(period) && period.id === source.baselineId && Array.isArray(period.rows)))
      throw new Error('设置 source-ledger 缺少起始快照');
  }
  assertNoCredentials(cleaned, `设置 ${key} `);
  return JSON.stringify(cleaned);
}

const missingLedger = (owner: string): Error => new Error(`工作台库里没有用户 ${owner} 的账本（缺少原表数据），请确认用户名，或先在工作台打开一次资产页`);

/** One owner's rows of a workbench ledger.sqlite, opened read-only; the connections table is never read. */
export function readLedgerRows(from: string, owner: string): SourceRows {
  const source = new DatabaseSync(from, { readOnly: true });
  try {
    const tables = new Set((source.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(row => row.name));
    for (const table of ['assets', 'settings', 'snapshots']) if (!tables.has(table)) throw new Error(`${basename(from)} 不是工作台的资产库（缺少 ${table} 表）`);
    const placeholders = IMPORTED_SETTINGS.map(() => '?').join(', ');
    const settings = source.prepare(`SELECT key, value FROM settings WHERE owner = ? AND key IN (${placeholders}) ORDER BY key`).all(owner, ...IMPORTED_SETTINGS) as { key: string; value: string }[];
    if (!settings.some(row => row.key === 'source-ledger')) throw missingLedger(owner);
    return {
      settings,
      assets: source.prepare('SELECT id, data FROM assets WHERE owner = ? ORDER BY id').all(owner) as { id: string; data: string }[],
      snapshots: source.prepare('SELECT date, data FROM snapshots WHERE owner = ? ORDER BY date').all(owner) as { date: string; data: string }[],
    };
  } finally { source.close(); }
}

const isText = (value: unknown): value is string => typeof value === 'string';
/** Rows that came through JSON are checked for shape first: two text columns each, settings only of the allow-list, each once. */
function assertRows(rows: unknown): asserts rows is SourceRows {
  const list = (value: unknown, a: string, b: string): boolean => Array.isArray(value) && value.every(row => isRecord(row) && Object.keys(row).length === 2 && isText(row[a]) && isText(row[b]));
  if (!isRecord(rows) || !list(rows.assets, 'id', 'data') || !list(rows.snapshots, 'date', 'data') || !list(rows.settings, 'key', 'value')) throw new Error('工作台账本的行格式无效');
  const keys = (rows.settings as { key: string }[]).map(row => row.key);
  if (keys.some(key => !IMPORTED_SETTINGS.includes(key)) || new Set(keys).size !== keys.length) throw new Error('工作台账本的设置不在导入范围内或有重复');
  for (const [name, field] of [['assets', 'id'], ['snapshots', 'date']] as const) {
    const ids = (rows[name] as Record<string, string>[]).map(row => row[field]);
    if (new Set(ids).size !== ids.length) throw new Error('工作台账本的行有重复');
  }
}

/** Checks and cleans one owner's rows; throws naming the row or setting (never its content). Nothing is written. */
export function prepareLedger(rows: unknown, { file, owner, now = Date.now }: { file: string; owner: string; now?: () => number }): PreparedLedger {
  assertRows(rows);
  if (!rows.settings.some(row => row.key === 'source-ledger')) throw missingLedger(owner);
  const assets = rows.assets.map(row => {
    const data = parseJson(row.data, `资产 ${row.id} `);
    if (!isRecord(data) || data.id !== row.id || typeof data.project !== 'string') throw new Error(`资产 ${row.id} 格式无效`);
    assertNoCredentials(data, `资产 ${row.id} `);
    return { id: row.id, data: row.data };
  });
  const snapshots = rows.snapshots.map(row => {
    const data = parseJson(row.data, `快照 ${row.date} `);
    if (!isRecord(data) || typeof data.date !== 'string' || typeof data.total !== 'number') throw new Error(`快照 ${row.date} 格式无效`);
    assertNoCredentials(data, `快照 ${row.date} `);
    return { date: row.date, data: row.data };
  });
  const settings = rows.settings.map(row => ({ key: row.key, value: cleanSetting(row.key, row.value) }));
  const info: ImportInfo = { importedAt: new Date(now()).toISOString(), importId: randomUUID(), file, owner, assets: assets.length, snapshots: snapshots.length, settings: settings.map(row => row.key) };
  return { assets, snapshots, settings, info };
}

/** A connection sealed with this data directory's key (credentials.ts), as the connections table stores it. */
export interface SealedConnection { exchange: string; encrypted: string }
/** Replaces the ledger tables and the connections of <dataDir>/asset.sqlite in one transaction, with the import record. */
export function writeLedger(dataDir: string, ledger: PreparedLedger, connections: readonly SealedConnection[] = [], at = Date.parse(ledger.info.importedAt)): ImportInfo {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const database = openAssetDb(resolve(dataDir, ASSET_DB_FILE));
  try {
    database.replace(() => {
      for (const table of ['assets', 'settings', 'snapshots', 'connections']) database.prepare(`DELETE FROM ${table}`).run();
      for (const row of connections) database.prepare('INSERT INTO connections (exchange, encrypted, updated_at) VALUES (?, ?, ?)').bind(row.exchange, row.encrypted, new Date(at).toISOString()).run();
      for (const row of ledger.assets) database.prepare('INSERT INTO assets (id, data) VALUES (?, ?)').bind(row.id, row.data).run();
      for (const row of ledger.snapshots) database.prepare('INSERT INTO snapshots (date, data) VALUES (?, ?)').bind(row.date, row.data).run();
      for (const row of ledger.settings) database.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').bind(row.key, row.value).run();
      database.prepare("INSERT INTO settings (key, value) VALUES ('import-info', ?)").bind(JSON.stringify(ledger.info)).run();
    });
  } finally { database.close(); }
  return ledger.info;
}

export function importLedger({ from, owner, dataDir, now = Date.now }: ImportOptions): ImportSummary {
  if (!owner) throw new Error('需要 --owner <工作台用户名>');
  const sourcePath = resolve(from), target = resolve(dataDir, ASSET_DB_FILE);
  if (!existsSync(sourcePath)) throw new Error(`找不到工作台的库文件 ${sourcePath}`);
  if (existsSync(target) && realpathSync(sourcePath) === realpathSync(target)) throw new Error('--from 不能是本服务自己的 asset.sqlite');
  return writeLedger(dataDir, prepareLedger(readLedgerRows(sourcePath, owner), { file: basename(sourcePath), owner, now }));
}

function main(): void {
  const { values } = parseArgs({ options: { from: { type: 'string' }, owner: { type: 'string' }, 'data-dir': { type: 'string' } } });
  if (!values.from) throw new Error('需要 --from <工作台 ledger.sqlite 的路径>');
  if (!values.owner) throw new Error('需要 --owner <工作台用户名>');
  if (!values['data-dir'] || !isAbsolute(values['data-dir'])) throw new Error('需要 --data-dir <本服务数据目录的绝对路径>');
  const dataDir = assertDedicatedDataDir(values['data-dir']);
  const result = importLedger({ from: values.from, owner: values.owner, dataDir });
  process.stdout.write(`已导入用户 ${result.owner} 的资产账本：资产 ${result.assets} 条，快照 ${result.snapshots} 条，设置 ${result.settings.length} 项（${result.settings.join('、')}）；导入时刻 ${result.importedAt}，写入 ${join(dataDir, ASSET_DB_FILE)}\n`);
}

if (import.meta.main) {
  try { main(); } catch (error) { process.stderr.write(`导入失败，未改动已有数据：${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
