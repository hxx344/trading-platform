// The monitor and asset parts of the workbench import (docs/module-import.md). The market monitor needs nothing from
// the workbench: importing it writes config.json `monitor` with the default share counts (the workbench keeps its share
// setting in the browser only). The asset ledger comes from the workbench's <data>/modules/asset/ledger.sqlite: one
// user's rows are read as the file's owner (as the ASTER database is), checked here with the rules of
// src/asset/import.ts, and written into this service's asset.sqlite by src/asset/import-writer.ts run as the owner of
// this service's data directory. Only user names, counts, dates, paths and reasons leave this file; ledger content and
// credentials never do (the connections table is not read).
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { IMPORTED_SETTINGS, prepareLedger, type SourceRows } from '../asset/import.ts';
import type { ImportInfo } from '../asset/views.ts';
import { ANTHROPIC_SHARES } from '../vendor/anthropic-market.mjs';
import { parseMonitorConfig } from './monitor-config.ts';
import { readerIdentity } from './import-workbench.ts';
import { ASSET_OWNER } from './import-channel.ts';

type Json = Record<string, unknown>;
const reason = (error: unknown): string => error instanceof Error ? error.message : String(error);
/** Workbench text goes to a root terminal and to the page: control and format characters are dropped. */
const printable = (text: string): string => text.replace(/[\p{Cc}\p{Cf}]/gu, '');

/** Users listed (and checked) in a preview; the others are only counted. */
export const MAX_LEDGER_OWNERS = 20;
const LEDGER_FILE = 'ledger.sqlite';
const WRITER = join(dirname(import.meta.filename), '..', 'asset', 'import-writer.ts');
const WRITE_TIMEOUT_MS = 60_000;
const DAILY = /^\d{4}-\d{2}-\d{2}$/;

export interface MonitorSource { /** The workbench has a Monitor module data directory (shown only; nothing is read from it). */ workbench: boolean }
export interface MonitorItem {
  status: 'added' | 'skipped';
  /** config.json already has `monitor`. */
  enabled: boolean;
  /** The share counts in use (already enabled) or written (the defaults). */
  shares: { outstanding: number; diluted: number };
  workbench: boolean;
  detail: string;
}

export const readWorkbenchMonitor = (data: string): MonitorSource => ({ workbench: existsSync(join(data, 'modules', 'monitor')) });

/** Adds config.json `monitor` with the default share counts in place, or says why not; one already there is kept. */
export function planMonitor(source: MonitorSource, config: Json, fits: (candidate: Json) => void, notes: string[]): MonitorItem {
  const defaults = { outstanding: ANTHROPIC_SHARES.outstanding, diluted: ANTHROPIC_SHARES.diluted };
  const item: MonitorItem = { status: 'skipped', enabled: config.monitor !== undefined, shares: defaults, workbench: source.workbench, detail: '' };
  if (item.enabled) {
    try { item.shares = { ...parseMonitorConfig(config.monitor).anthropic.shares }; } catch { /* the existing-config check reports it */ }
    item.detail = `已启用（流通 ${item.shares.outstanding} / 完全稀释 ${item.shares.diluted} 十亿股），保留现有设置`;
    return item;
  }
  const monitor = { anthropic: {} };
  try { fits({ ...config, monitor }); } catch (error) { item.detail = `加入后本服务不接受（${reason(error)}）`; return item; }
  config.monitor = monitor;
  item.status = 'added';
  item.detail = `Anthropic 价差，股数取默认值（流通 ${defaults.outstanding} / 完全稀释 ${defaults.diluted} 十亿股）；不需要密钥，服务器每 10 秒读报价、每 60 秒读 K 线（Binance、Hyperliquid、Lighter RH 的公开行情）`;
  notes.push('行情监控的股数取默认值：工作台的股数设置只存在浏览器里，没有带过来；要改股数请改 config.json 的 monitor.anthropic.shares 后执行 sudo bash install.sh');
  if (source.workbench) notes.push('工作台 Monitor 模块的本地行情记录不导入；本服务启用后从交易所回补最近约 50 天的 K 线');
  return item;
}

/** One workbench user with a ledger, as the page lists it. */
export interface LedgerOwner { owner: string; assets: number; snapshots: number; lastDaily: string | null; importable: boolean; detail: string }
/** The import record of this service's asset.sqlite, without the settings list. */
export interface LastImport { importedAt: string; owner: string; assets: number; snapshots: number }
export interface AssetSource {
  ledger: string;
  /** Why the ledger cannot be read at all, or null. */
  problem: string | null;
  owners: LedgerOwner[];
  /** Users with a ledger beyond those listed. */
  more: number;
  /** The rows read, by user (only the users listed); they stay in the helper. */
  rows: Map<string, SourceRows>;
  last: LastImport | null;
  /** Why the last import record could not be read. */
  lastProblem: string | null;
}
/** What the plan did with the asset ledger; no row content. */
export interface AssetItem extends Omit<AssetSource, 'rows' | 'problem'> {
  status: 'added' | 'skipped';
  /** config.json already has `asset`. */
  enabled: boolean;
  /** The user whose ledger comes over (or was asked for). */
  owner: string | null;
  detail: string;
}
/** The rows to write into asset.sqlite before the config is written. */
export interface LedgerWrite { owner: string; file: string; rows: SourceRows }

/**
 * Prints the users with a ledger and the rows of the wanted one (or of the first users), in one read transaction; run
 * with no environment, as the file's owner, so a -wal or -shm SQLite adds is the workbench's. Like the ASTER read, a
 * normal read-only open: pending WAL pages are read. A missing table is a code on stdout.
 */
const DUMP_LEDGER = `import { DatabaseSync } from 'node:sqlite';
const [file, keysText, limitText, wanted] = process.argv.slice(1);
const out = value => process.stdout.write(JSON.stringify(value));
try {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000; BEGIN');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
    const missing = ['assets', 'settings', 'snapshots'].find(name => !tables.has(name));
    if (missing) out({ missing });
    else {
      const keys = JSON.parse(keysText), marks = keys.map(() => '?').join(', ');
      const owners = db.prepare("SELECT owner FROM settings WHERE key = 'source-ledger' GROUP BY owner ORDER BY owner").all().map(row => String(row.owner));
      const picked = wanted ? owners.filter(owner => owner === wanted) : owners.slice(0, Number(limitText));
      const text = value => typeof value === 'string' ? value : null;
      const rows = {};
      for (const owner of picked) rows[owner] = {
        assets: db.prepare('SELECT id, data FROM assets WHERE owner = ? ORDER BY id').all(owner).map(row => ({ id: text(row.id), data: text(row.data) })),
        snapshots: db.prepare('SELECT date, data FROM snapshots WHERE owner = ? ORDER BY date').all(owner).map(row => ({ date: text(row.date), data: text(row.data) })),
        settings: db.prepare('SELECT key, value FROM settings WHERE owner = ? AND key IN (' + marks + ') ORDER BY key').all(owner, ...keys).map(row => ({ key: text(row.key), value: text(row.value) })),
      };
      db.exec('COMMIT');
      out({ owners, rows });
    }
  } finally { db.close(); }
} catch (error) { process.stderr.write(String(error && error.message || error).split('\\n')[0]); process.exitCode = 1; }`;

const countOf = (rows: unknown, name: 'assets' | 'snapshots'): number => {
  const list = rows !== null && typeof rows === 'object' ? (rows as Record<string, unknown>)[name] : null;
  return Array.isArray(list) ? list.length : 0;
};
const lastDailyOf = (rows: SourceRows): string | null => rows.snapshots.map(row => row.date).filter(date => typeof date === 'string' && DAILY.test(date)).sort().at(-1) ?? null;

/** One user's rows judged by the import's own checks; the reason names a row or setting, never its content. */
export function ledgerOwner(owner: string, rows: SourceRows): LedgerOwner {
  const entry: LedgerOwner = { owner: printable(owner).slice(0, 64), assets: countOf(rows, 'assets'), snapshots: countOf(rows, 'snapshots'), lastDaily: null, importable: false, detail: '' };
  try {
    const prepared = prepareLedger(rows, { file: LEDGER_FILE, owner });
    entry.assets = prepared.assets.length; entry.snapshots = prepared.snapshots.length; entry.lastDaily = lastDailyOf(rows);
  } catch (error) { entry.detail = printable(reason(error)).slice(0, 300); return entry; }
  if (!ASSET_OWNER.test(owner)) { entry.detail = '用户名含页面不支持的字符（只允许字母、数字和 . _ @ -，以字母或数字开头，至多 64 个字符）；请用 src/asset/import.ts 单独导入'; return entry; }
  entry.importable = true;
  entry.detail = `资产 ${entry.assets} 条、快照 ${entry.snapshots} 条${entry.lastDaily ? `，最近的日快照 ${entry.lastDaily}` : ''}`;
  return entry;
}

/** The workbench's ledger users and the rows of `owner` (or of the first users); a ledger that cannot be read is the problem. */
export function readWorkbenchLedger(data: string, { owner }: { owner?: string } = {}): Pick<AssetSource, 'ledger' | 'problem' | 'owners' | 'more' | 'rows'> {
  if (!isAbsolute(data)) throw new Error(`工作台数据目录须为绝对路径：${data}`);
  const ledger = join(data, 'modules', 'asset', LEDGER_FILE);
  const refused = (problem: string) => ({ ledger, problem, owners: [], more: 0, rows: new Map<string, SourceRows>() });
  let stat;
  try { stat = lstatSync(ledger); } catch { return refused(`没有找到工作台的资产账本 ${ledger}（工作台没有用过资产模块，或数据目录不在默认位置）`); }
  if (!stat.isFile()) return refused(`工作台的资产账本 ${ledger} 不是普通文件（符号链接等），不读取`);
  if (process.getuid?.() === 0 && stat.uid === 0 && statSync(dirname(ledger)).uid !== 0) return refused(`${ledger} 归 root，但所在目录归其他账户，不读取；请确认文件来源`);
  const identity = readerIdentity(stat, process.getuid?.());
  const as = 'uid' in identity ? `（以账本属主 uid ${identity.uid} 读取，不带附加组）` : '';
  const read = spawnSync(process.execPath, ['--input-type=module', '-e', DUMP_LEDGER, '--', ledger, JSON.stringify(IMPORTED_SETTINGS), String(MAX_LEDGER_OWNERS), owner ?? ''], {
    cwd: '/', env: {}, encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024, ...identity,
  });
  if (read.error || read.status !== 0) return refused(`读取工作台资产账本 ${ledger} 失败${as}：${printable(read.error?.message ?? (read.stderr.trim() || `退出码 ${read.status ?? read.signal}`)).slice(0, 200)}`);
  let dumped: { missing?: string; owners?: unknown; rows?: unknown };
  try { dumped = JSON.parse(read.stdout) as typeof dumped; } catch { return refused(`读取工作台资产账本 ${ledger} 失败${as}：输出无法解析`); }
  if (typeof dumped.missing === 'string') return refused(`${ledger} 不是工作台的资产库（缺少 ${printable(dumped.missing).slice(0, 40)} 表）`);
  if (!Array.isArray(dumped.owners) || !dumped.owners.every(name => typeof name === 'string') || dumped.rows === null || typeof dumped.rows !== 'object') return refused(`读取工作台资产账本 ${ledger} 失败${as}：输出格式错误`);
  const names = dumped.owners as string[];
  if (!names.length) return refused('工作台资产账本里没有任何用户的账本（没有原表数据）；先在工作台打开一次资产页');
  const rows = new Map(Object.entries(dumped.rows as Record<string, SourceRows>).filter(([name]) => names.includes(name)));
  const listed = owner === undefined ? names.slice(0, MAX_LEDGER_OWNERS) : names.filter(name => name === owner);
  return { ledger, problem: null, owners: listed.map(name => ledgerOwner(name, rows.get(name) ?? { assets: [], snapshots: [], settings: [] })), more: names.length - listed.length, rows };
}

const writerIdentity = (dataDir: string) => readerIdentity(statSync(dataDir), process.getuid?.());

/** Runs import-writer.ts as the owner of the data directory; its one JSON line, or the reason it failed. */
function runWriter(dataDir: string, args: string[], input?: string): unknown {
  const identity = writerIdentity(dataDir);
  const run = spawnSync(process.execPath, [WRITER, ...args, '--data-dir', dataDir], {
    cwd: '/', env: {}, encoding: 'utf8', timeout: WRITE_TIMEOUT_MS, maxBuffer: 1024 * 1024, ...(input === undefined ? {} : { input }), ...identity,
  });
  const as = 'uid' in identity ? `（以数据目录属主 uid ${identity.uid} 运行）` : '';
  if (run.error || run.status !== 0) throw new Error(`${printable(run.error?.message ?? (run.stderr.trim() || `退出码 ${run.status ?? run.signal}`)).slice(0, 300)}${as}`);
  try { return JSON.parse(run.stdout) as unknown; } catch { throw new Error(`输出无法解析${as}`); }
}

const lastOf = (info: ImportInfo): LastImport => ({ importedAt: info.importedAt, owner: printable(info.owner).slice(0, 64), assets: info.assets, snapshots: info.snapshots });

/** The last import into this service's asset.sqlite, read as the service account (root opens no database there). */
export function readLastImport(dataDir: string): Pick<AssetSource, 'last' | 'lastProblem'> {
  try {
    const answer = runWriter(dataDir, ['info']) as { info?: ImportInfo | null };
    return { last: answer?.info ? lastOf(answer.info) : null, lastProblem: null };
  } catch (error) { return { last: null, lastProblem: `读不到本服务资产库的上次导入记录：${reason(error)}` }; }
}

/** Both halves: the workbench's ledger and this service's last import. */
export function readWorkbenchAsset(data: string, dataDir: string, options: { owner?: string } = {}): AssetSource {
  if (!isAbsolute(dataDir)) throw new Error(`本服务数据目录须为绝对路径：${dataDir}`);
  return { ...readWorkbenchLedger(data, options), ...readLastImport(dataDir) };
}

/** Replaces asset.sqlite with the planned rows, as the data directory's owner; throws with the reason (nothing changed then). */
export function writeLedgerAsService(dataDir: string, write: LedgerWrite): LastImport {
  let answer: { info?: ImportInfo };
  try { answer = runWriter(dataDir, ['write', '--owner', write.owner, '--file', write.file], JSON.stringify(write.rows)) as { info?: ImportInfo }; }
  catch (error) { throw new Error(`写入资产账本失败，已有账本未改动：${reason(error)}`); }
  if (!answer?.info) throw new Error('写入资产账本后没有拿到导入记录，请在资产页核对');
  return lastOf(answer.info);
}

/**
 * Adds config.json `asset` in place (kept when there) and picks the user whose rows are written, or says why not.
 * Without `owner`, a ledger of one user is that user's; with several, the caller must name one.
 */
export function planAsset(source: AssetSource, config: Json, fits: (candidate: Json) => void, owner: string | undefined, notes: string[]): { item: AssetItem; write: LedgerWrite | null } {
  const { rows: _rows, problem, ...shown } = source;
  const item: AssetItem = { ...shown, status: 'skipped', enabled: config.asset !== undefined, owner: owner === undefined ? null : printable(owner).slice(0, 64), detail: '' };
  const skip = (detail: string) => { item.detail = detail; return { item, write: null }; };
  if (problem !== null) return skip(problem);
  let chosen = owner;
  if (chosen === undefined) {
    if (source.owners.length + source.more > 1) return skip(`工作台资产账本有 ${source.owners.length + source.more} 个用户，导入时须选择其中一个`);
    chosen = source.owners[0]?.owner;
  }
  const entry = chosen === undefined ? undefined : source.owners.find(candidate => candidate.owner === chosen);
  if (!entry) return skip(`工作台资产账本里没有用户 ${item.owner ?? ''} 的账本`);
  item.owner = entry.owner;
  if (!entry.importable) return skip(entry.detail);
  const rows = source.rows.get(chosen);
  if (!rows) return skip(`读取用户 ${entry.owner} 的账本行失败`);
  if (!item.enabled) {
    try { fits({ ...config, asset: {} }); } catch (error) { return skip(`加入后本服务不接受（${reason(error)}）`); }
    config.asset = {};
  }
  item.status = 'added';
  item.detail = `用户 ${entry.owner}：${entry.detail}${item.enabled ? '；本服务已启用资产账本，整体替换已有账本' : ''}`;
  if (source.last) notes.push(`本服务资产库上次导入：用户 ${source.last.owner}，${source.last.importedAt}；再次导入整体替换`);
  return { item, write: { owner: chosen!, file: LEDGER_FILE, rows } };
}
