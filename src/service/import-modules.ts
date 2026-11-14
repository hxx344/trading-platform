// The monitor and asset parts of the workbench import (docs/module-import.md). The market monitor needs nothing from
// the workbench: importing it writes config.json `monitor` with every market, the Anthropic one with the default share
// counts (the workbench keeps its share setting in the browser only); an enabled monitor only gains the markets it lacks. The asset ledger comes from the workbench's <data>/modules/asset/ledger.sqlite: one
// user's rows are read as the file's owner (as the ASTER database is), checked here with the rules of
// src/asset/import.ts, and written into this service's asset.sqlite by src/asset/import-writer.ts run as the owner of
// this service's data directory. Only user names, counts, dates, paths and reasons leave this file; ledger content and
// credentials never do. Since A-3 the user's connections come along: the preview lists their names only; at the write
// the connection reader (DUMP_CONNECTIONS, as the ledger's owner) decrypts them with the workbench's config.json
// credentialKey and writes them straight into the writer's stdin, so this process (root in the helper) never holds the
// plaintext; the writer seals them again with this service's key in the transaction that replaces the ledger.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type { Writable } from 'node:stream';
import { existsSync, lstatSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { IMPORTED_SETTINGS, prepareLedger, type SourceRows } from '../asset/import.ts';
import type { ConnectionImport } from '../asset/import-writer.ts';
import type { ImportInfo } from '../asset/views.ts';
import { ANTHROPIC_SHARES } from '../vendor/anthropic-market.mjs';
import { MONITOR_LABELS, MONITOR_MARKETS, monitorMarkets, parseMonitorConfig, type MonitorConfig } from './monitor-config.ts';
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
  /** The markets that run after this import (MONITOR_MARKETS names). */
  markets: string[];
  workbench: boolean;
  detail: string;
}

export const readWorkbenchMonitor = (data: string): MonitorSource => ({ workbench: existsSync(join(data, 'modules', 'monitor')) });

/**
 * Adds config.json `monitor` with every market in place (Anthropic with the default share counts), or the markets an enabled
 * monitor lacks; the settings already there are kept. Says why not when the result would not be accepted.
 */
export function planMonitor(source: MonitorSource, config: Json, fits: (candidate: Json) => void, notes: string[]): MonitorItem {
  const defaults = { outstanding: ANTHROPIC_SHARES.outstanding, diluted: ANTHROPIC_SHARES.diluted };
  const item: MonitorItem = { status: 'skipped', enabled: config.monitor !== undefined, shares: defaults, markets: [], workbench: source.workbench, detail: '' };
  let current: Json = {};
  if (item.enabled) {
    let parsed: MonitorConfig;
    try { parsed = parseMonitorConfig(config.monitor); } catch (error) { item.detail = `现有设置无效，未改动（${reason(error)}）`; return item; }
    if (parsed.anthropic) item.shares = { ...parsed.anthropic.shares };
    item.markets = monitorMarkets(parsed);
    current = config.monitor as Json;
  }
  const missing = MONITOR_MARKETS.filter(market => current[market] === undefined);
  const names = (markets: readonly string[]) => markets.map(market => MONITOR_LABELS[market as keyof typeof MONITOR_LABELS]).join('、');
  if (!missing.length) {
    item.detail = `已启用（${names(item.markets)}；流通 ${item.shares.outstanding} / 完全稀释 ${item.shares.diluted} 十亿股），保留现有设置`;
    return item;
  }
  const monitor: Json = { ...current, ...Object.fromEntries(missing.map(market => [market, {}])) };
  try { fits({ ...config, monitor }); } catch (error) { item.detail = `加入后本服务不接受（${reason(error)}）`; return item; }
  config.monitor = monitor;
  item.status = 'added';
  item.markets = monitorMarkets(parseMonitorConfig(monitor));
  const reads = missing.map(market => market === 'anthropic'
    ? `Anthropic 价差（股数取默认值：流通 ${defaults.outstanding} / 完全稀释 ${defaults.diluted} 十亿股；每 10 秒读报价、每 60 秒读 K 线，Binance、Hyperliquid、Lighter RH 的公开行情）`
    : market === 'oil' ? '原油价差（每 10 秒读报价、每 60 秒读 K 线，Binance 的公开行情）' : '海力士溢价（每 10 秒读报价、每 60 秒读 K 线，Hyperliquid 的公开行情）');
  item.detail = `${item.enabled ? `补上 ${reads.join('、')}，已有的${names(MONITOR_MARKETS.filter(market => !missing.includes(market)))}保留现有设置` : reads.join('、')}；不需要密钥`;
  if (missing.includes('anthropic')) notes.push('行情监控的股数取默认值：工作台的股数设置只存在浏览器里，没有带过来；要改股数请改 config.json 的 monitor.anthropic.shares 后执行 sudo bash install.sh');
  if (source.workbench) notes.push('工作台 Monitor 模块的本地行情记录不导入；本服务启用后从交易所回补（Anthropic 最近约 50 天，原油从 2026-04-01 起，海力士从 2026-07-10 上市起，最多最近 5000 小时）');
  return item;
}

/** One workbench user with a ledger, as the page lists it. */
export interface LedgerOwner {
  owner: string; assets: number; snapshots: number; lastDaily: string | null; importable: boolean; detail: string;
  /** The names of the user's saved workbench connections ('binance', 'aster:<id>'); never their content. */
  connections: string[];
}
/** The import record of this service's asset.sqlite, without the settings list. */
export interface LastImport { importedAt: string; owner: string; assets: number; snapshots: number }
export interface AssetSource {
  ledger: string;
  /** Why the ledger cannot be read at all, or null. */
  problem: string | null;
  owners: LedgerOwner[];
  /** Users with a ledger beyond those listed. */
  more: number;
  /** Why the workbench's connections cannot be decrypted (config.json missing, no valid credentialKey), or null. */
  connectionProblem: string | null;
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
export interface LedgerWrite {
  owner: string; file: string; rows: SourceRows;
  /** The workbench ledger.sqlite, whose owner's connections the connection reader decrypts (config.json beside it). */
  ledger: string;
}
/** A finished import: the record, and which connections came over. */
export type WrittenLedger = LastImport & { connections: ConnectionImport };

/**
 * Prints the users with a ledger and the rows of the wanted one (or of the first users), in one read transaction; run
 * with no environment, as the file's owner, so a -wal or -shm SQLite adds is the workbench's. Like the ASTER read, a
 * normal read-only open: pending WAL pages are read. A missing table is a code on stdout.
 */
const DUMP_LEDGER = `import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const [file, keysText, limitText, wanted] = process.argv.slice(1);
const out = value => process.stdout.write(JSON.stringify(value));
let key = 'ok';
try {
  const raw = JSON.parse(readFileSync(join(dirname(file), 'config.json'), 'utf8'));
  if (!raw || typeof raw.credentialKey !== 'string' || !/^[0-9a-f]{64}$/i.test(raw.credentialKey)) key = 'invalid';
} catch (error) { key = error && error.code === 'ENOENT' ? 'missing' : 'unreadable'; }
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
      const rows = {}, names = {};
      const listed = tables.has('connections') ? db.prepare('SELECT exchange FROM connections WHERE owner = ? ORDER BY exchange') : null;
      for (const owner of picked) names[owner] = listed ? listed.all(owner).map(row => text(row.exchange)) : [];
      for (const owner of picked) rows[owner] = {
        assets: db.prepare('SELECT id, data FROM assets WHERE owner = ? ORDER BY id').all(owner).map(row => ({ id: text(row.id), data: text(row.data) })),
        snapshots: db.prepare('SELECT date, data FROM snapshots WHERE owner = ? ORDER BY date').all(owner).map(row => ({ date: text(row.date), data: text(row.data) })),
        settings: db.prepare('SELECT key, value FROM settings WHERE owner = ? AND key IN (' + marks + ') ORDER BY key').all(owner, ...keys).map(row => ({ key: text(row.key), value: text(row.value) })),
      };
      db.exec('COMMIT');
      out({ owners, rows, connections: names, key });
    }
  } finally { db.close(); }
} catch (error) { process.stderr.write(String(error && error.message || error).split('\\n')[0]); process.exitCode = 1; }`;

/**
 * One user's connections decrypted with the workbench's key (modules/asset/lib/vault.ts: AES-GCM, additional data
 * owner + ':' + name), written as JSON to stdout, which is the writer's stdin. Run with no environment as the ledger's
 * owner. A connection that does not open is listed by name; without a usable key, or when the table cannot be read, the
 * output says why and carries no connection. Nothing is written to stderr but the first line of an unexpected error,
 * which never comes from a decrypted value.
 */
const DUMP_CONNECTIONS = `import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const [file, owner] = process.argv.slice(1);
const result = { connections: [], skipped: [], problem: null };
let raw;
try { raw = JSON.parse(readFileSync(join(dirname(file), 'config.json'), 'utf8')).credentialKey; }
catch (error) { result.problem = error && error.code === 'ENOENT' ? 'missing' : 'unreadable'; }
if (!result.problem && (typeof raw !== 'string' || !/^[0-9a-f]{64}$/i.test(raw))) result.problem = 'invalid';
let rows = [];
if (!result.problem) {
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      const present = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'connections'").get();
      rows = present ? db.prepare('SELECT exchange, encrypted FROM connections WHERE owner = ? ORDER BY exchange').all(owner) : [];
    } finally { db.close(); }
  } catch { result.problem = 'read'; }
}
if (!result.problem) {
  const key = await crypto.subtle.importKey('raw', Buffer.from(raw, 'hex'), 'AES-GCM', false, ['decrypt']);
  for (const row of rows) {
    const exchange = String(row.exchange);
    try {
      const data = JSON.parse(String(row.encrypted));
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(data.iv), additionalData: new TextEncoder().encode(owner + ':' + exchange) }, key, new Uint8Array(data.cipher));
      result.connections.push({ exchange, credential: JSON.parse(new TextDecoder().decode(plain)) });
    } catch { result.skipped.push({ exchange }); }
  }
}
process.stdout.write(JSON.stringify(result));`;
const KEY_PROBLEMS: Record<string, string> = {
  missing: '工作台资产模块没有 config.json',
  unreadable: '工作台资产模块的 config.json 读不出',
  invalid: '工作台资产模块的 config.json 没有有效的 credentialKey',
};

const countOf = (rows: unknown, name: 'assets' | 'snapshots'): number => {
  const list = rows !== null && typeof rows === 'object' ? (rows as Record<string, unknown>)[name] : null;
  return Array.isArray(list) ? list.length : 0;
};
const lastDailyOf = (rows: SourceRows): string | null => rows.snapshots.map(row => row.date).filter(date => typeof date === 'string' && DAILY.test(date)).sort().at(-1) ?? null;

/** One user's rows judged by the import's own checks; the reason names a row or setting, never its content. */
export function ledgerOwner(owner: string, rows: SourceRows, connections: readonly string[] = []): LedgerOwner {
  const names = connections.filter(name => typeof name === 'string').map(name => printable(name).slice(0, 48)).slice(0, 40);
  const entry: LedgerOwner = { owner: printable(owner).slice(0, 64), assets: countOf(rows, 'assets'), snapshots: countOf(rows, 'snapshots'), lastDaily: null, importable: false, detail: '', connections: names };
  try {
    const prepared = prepareLedger(rows, { file: LEDGER_FILE, owner });
    entry.assets = prepared.assets.length; entry.snapshots = prepared.snapshots.length; entry.lastDaily = lastDailyOf(rows);
  } catch (error) { entry.detail = printable(reason(error)).slice(0, 300); return entry; }
  if (!ASSET_OWNER.test(owner)) { entry.detail = '用户名含页面不支持的字符（只允许字母、数字和 . _ @ -，以字母或数字开头，至多 64 个字符）；请用 src/asset/import.ts 单独导入'; return entry; }
  entry.importable = true;
  entry.detail = `资产 ${entry.assets} 条、快照 ${entry.snapshots} 条${entry.lastDaily ? `，最近的日快照 ${entry.lastDaily}` : ''}${names.length ? `，连接 ${names.length} 个（${names.join('、')}）` : ''}`;
  return entry;
}

/** The workbench's ledger users and the rows of `owner` (or of the first users); a ledger that cannot be read is the problem. */
export function readWorkbenchLedger(data: string, { owner }: { owner?: string } = {}): Pick<AssetSource, 'ledger' | 'problem' | 'owners' | 'more' | 'rows' | 'connectionProblem'> {
  if (!isAbsolute(data)) throw new Error(`工作台数据目录须为绝对路径：${data}`);
  const ledger = join(data, 'modules', 'asset', LEDGER_FILE);
  const refused = (problem: string) => ({ ledger, problem, owners: [], more: 0, rows: new Map<string, SourceRows>(), connectionProblem: null });
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
  let dumped: { missing?: string; owners?: unknown; rows?: unknown; connections?: unknown; key?: unknown };
  try { dumped = JSON.parse(read.stdout) as typeof dumped; } catch { return refused(`读取工作台资产账本 ${ledger} 失败${as}：输出无法解析`); }
  if (typeof dumped.missing === 'string') return refused(`${ledger} 不是工作台的资产库（缺少 ${printable(dumped.missing).slice(0, 40)} 表）`);
  if (!Array.isArray(dumped.owners) || !dumped.owners.every(name => typeof name === 'string') || dumped.rows === null || typeof dumped.rows !== 'object') return refused(`读取工作台资产账本 ${ledger} 失败${as}：输出格式错误`);
  const names = dumped.owners as string[];
  if (!names.length) return refused('工作台资产账本里没有任何用户的账本（没有原表数据）；先在工作台打开一次资产页');
  const rows = new Map(Object.entries(dumped.rows as Record<string, SourceRows>).filter(([name]) => names.includes(name)));
  const listed = owner === undefined ? names.slice(0, MAX_LEDGER_OWNERS) : names.filter(name => name === owner);
  const connections = dumped.connections !== null && typeof dumped.connections === 'object' ? dumped.connections as Record<string, unknown> : {};
  const namesOf = (name: string): string[] => { const list = Object.hasOwn(connections, name) ? connections[name] : null; return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : []; };
  const keyProblem = typeof dumped.key === 'string' && dumped.key !== 'ok' ? KEY_PROBLEMS[dumped.key] ?? KEY_PROBLEMS.unreadable! : null;
  return {
    ledger, problem: null, more: names.length - listed.length, rows,
    owners: listed.map(name => ledgerOwner(name, rows.get(name) ?? { assets: [], snapshots: [], settings: [] }, namesOf(name))),
    connectionProblem: keyProblem && listed.some(name => namesOf(name).length) ? `${keyProblem}，已保存的连接无法解密，导入时只导入账本、不带连接，导入后在资产页重新连接` : null,
  };
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

/** The first line of a child's stderr, bounded, as printable text. */
const firstLine = (chunks: Buffer[]): string => printable(Buffer.concat(chunks).toString('utf8').trim().split('\n')[0] ?? '').slice(0, 300);
const collect = (child: ChildProcess, name: 'stdout' | 'stderr', limit: number): Buffer[] => {
  const chunks: Buffer[] = []; let size = 0;
  child[name]?.on('data', (chunk: Buffer) => { size += chunk.length; if (size <= limit) chunks.push(chunk); });
  return chunks;
};
const finished = (child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }> => new Promise(resolve => {
  let error: Error | undefined;
  child.once('error', failure => { error = failure; if (child.pid === undefined) resolve({ code: null, signal: null, error }); });
  child.once('close', (code, signal) => resolve({ code, signal, error }));
});

/**
 * Replaces asset.sqlite with the planned rows and the user's workbench connections, as the data directory's owner;
 * throws with the reason (nothing changed then). The writer gets the rows on fd 3 from here and the connections on its
 * stdin straight from the connection reader: this process passes the writer's stdin to the reader and closes its own
 * end before the reader starts writing, and never reads it.
 */
export async function writeLedgerAsService(dataDir: string, write: LedgerWrite): Promise<WrittenLedger> {
  const fail = (detail: string) => new Error(`写入资产账本失败，已有账本未改动：${detail}`);
  const identity = writerIdentity(dataDir), as = 'uid' in identity ? `（以数据目录属主 uid ${identity.uid} 运行）` : '';
  const writer = spawn(process.execPath, [WRITER, 'write', '--owner', write.owner, '--file', write.file, '--data-dir', dataDir], { cwd: '/', env: {}, stdio: ['pipe', 'pipe', 'pipe', 'pipe'], ...identity });
  const writerDone = finished(writer), out = collect(writer, 'stdout', 1024 * 1024), err = collect(writer, 'stderr', 64 * 1024);
  let reader: ChildProcess | null = null, readerDone: ReturnType<typeof finished> | null = null, readerErr: Buffer[] = [];
  let refusedReader: string | null = null;
  try {
    let stat;
    try { stat = lstatSync(write.ledger); } catch { stat = null; }
    // The preview's rule again (readWorkbenchLedger): the file may have been swapped since.
    if (stat?.isFile() && process.getuid?.() === 0 && stat.uid === 0) {
      let dirUid: number | null = null;
      try { dirUid = statSync(dirname(write.ledger)).uid; } catch { /* unreadable directory: refused below */ }
      if (dirUid !== 0) { refusedReader = `${write.ledger} 归 root，但所在目录归其他账户，连接未导入（账本照常导入）；请确认文件来源`; stat = null; }
    }
    // A ledger that is gone or no longer a plain file gives no connections: the writer reads end of file and says so.
    if (stat?.isFile() && writer.stdin) {
      reader = spawn(process.execPath, ['--input-type=module', '-e', DUMP_CONNECTIONS, '--', write.ledger, write.owner], { cwd: '/', env: {}, stdio: ['ignore', writer.stdin, 'pipe'], ...readerIdentity(stat, process.getuid?.()) });
      readerDone = finished(reader); readerErr = collect(reader, 'stderr', 16 * 1024);
    }
  } finally { writer.stdin?.destroy(); }
  const timer = setTimeout(() => { writer.kill('SIGKILL'); reader?.kill('SIGKILL'); }, WRITE_TIMEOUT_MS);
  try {
    const rows = writer.stdio[3] as Writable | null;
    rows?.on('error', () => undefined);
    rows?.end(JSON.stringify(write.rows));
    const [result, readResult] = await Promise.all([writerDone, readerDone]);
    if (result.error || result.code !== 0) throw fail(`${printable(result.error?.message ?? (firstLine(err) || `退出码 ${result.code ?? result.signal}`)).slice(0, 300)}${as}`);
    let answer: { info?: ImportInfo; connections?: ConnectionImport };
    try { answer = JSON.parse(Buffer.concat(out).toString('utf8')) as typeof answer; } catch { throw fail(`输出无法解析${as}`); }
    if (!answer?.info) throw new Error('写入资产账本后没有拿到导入记录，请在资产页核对');
    const report: ConnectionImport = answer.connections ?? { imported: [], skipped: [], problem: null };
    if (refusedReader) report.problem = refusedReader;
    if (readResult && (readResult.error || readResult.code !== 0) && !report.imported.length)
      report.problem = `读取工作台的连接失败，连接未导入（账本照常导入），请在资产页重新连接：${printable(readResult.error?.message ?? (firstLine(readerErr) || `退出码 ${readResult.code ?? readResult.signal}`)).slice(0, 200)}`;
    return { ...lastOf(answer.info), connections: report };
  } finally { clearTimeout(timer); }
}

/** The lines a finished import adds for its connections. */
export function connectionLines(report: ConnectionImport): string[] {
  const lines: string[] = [];
  if (report.imported.length) lines.push(`已导入连接 ${report.imported.length} 个（${report.imported.map(name => printable(name)).join('、')}），已用本服务的密钥重新加密`);
  if (report.skipped.length) lines.push(`未导入的连接：${report.skipped.map(item => `${printable(item.exchange) || '（名称无效）'}（${printable(item.reason)}）`).join('、')}；请在资产页重新连接`);
  if (report.problem) lines.push(printable(report.problem));
  return lines;
}

/**
 * Adds config.json `asset` in place (kept when there) and picks the user whose rows are written, or says why not.
 * Without `owner`, a ledger of one user is that user's; with several, the caller must name one.
 */
export function planAsset(source: AssetSource, config: Json, fits: (candidate: Json) => void, owner: string | undefined, notes: string[]): { item: AssetItem; write: LedgerWrite | null } {
  const { rows: _rows, problem, ...shown } = source, { connectionProblem } = source;
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
  if (source.last) notes.push(`本服务资产库上次导入：用户 ${source.last.owner}，${source.last.importedAt}；再次导入整体替换（含已保存的连接）`);
  if (entry.connections.length) notes.push(connectionProblem ?? `资产账本的连接（${entry.connections.join('、')}）一并导入：由工作台账本属主解密后直接交给写入进程，用本服务的密钥重新加密；解密失败的单个连接不导入，导入后在资产页重新连接`);
  return { item, write: { owner: chosen!, file: LEDGER_FILE, rows, ledger: source.ledger } };
}
