// The writing half of the page's (and install.sh's) asset ledger import, run by src/service/import-modules.ts as the
// owner of this service's data directory, never as root (root would be writing into a directory the service account
// controls), with no environment:
//   node import-writer.ts write --data-dir <dir> --owner <user> --file <name>   see below
//   node import-writer.ts info --data-dir <dir>                                 the last import record, or null
// write reads one owner's rows as JSON on fd 3 (from the helper), then that owner's workbench connections, decrypted, as
// JSON on stdin: stdin is the pipe the connection reader (import-modules.ts DUMP_CONNECTIONS, run as the workbench
// ledger's owner) writes into, and the helper (root) closes its end before anything is written, so the plaintext passes
// from the reader to this process only. The rows are checked again here (prepareLedger); each connection is checked
// as the connect API checks a body (parseConnection) and sealed again with this data directory's key, the additional
// data being the connection name (credentials.ts), and asset.sqlite is replaced with both in one transaction. A
// connection that is not valid is left out, and when the reader brought none (no workbench key) the ledger comes over
// without connections. The output is one JSON line with the import record and the connection names imported or left
// out with the reason, never ledger content or a credential; error text never quotes stdin.
import { lstatSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ASSET_DB_FILE, assertOwnFiles, openAssetDb } from './db.ts';
import { prepareLedger, writeLedger, type PreparedLedger, type SealedConnection } from './import.ts';
import { credentialTail, seal, credentialKey } from './credentials.ts';
import { asterKey } from './aster-accounts.ts';
import { AssetInputError, connectionExchange, parseConnection, type Credentials } from './validation.ts';
import { parseImportInfo } from './store.ts';
import { assertDedicatedDataDir } from '../data-dir.ts';
import type { ImportInfo } from './views.ts';

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Same bound as the reader's maxBuffer in import-modules.ts, stated here too. */
const MAX_ROWS_BYTES = 64 * 1024 * 1024;
/** At most 8 exchanges and 10 Aster accounts, each a few hundred bytes (a Var session token up to 4 KiB). */
const MAX_CONNECTIONS_BYTES = 1024 * 1024;
const pause = new Int32Array(new SharedArrayBuffer(4));
/** Everything up to end of file on `fd`; a pipe the parent left non-blocking is waited on (EAGAIN). */
function readAll(fd: number, limit: number, tooLarge: string): string {
  const chunks: Buffer[] = [], buffer = Buffer.alloc(1 << 20);
  let total = 0;
  for (;;) {
    let read: number;
    try { read = readSync(fd, buffer, 0, buffer.length, null); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EAGAIN') { Atomics.wait(pause, 0, 0, 5); continue; }
      throw error;
    }
    if (read === 0) break;
    total += read;
    if (total > limit) throw new Error(tooLarge);
    chunks.push(Buffer.from(buffer.subarray(0, read)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** What the connection reader writes: the decrypted connections, the ones it could not open, or why it opened none. */
type Dumped = { connections?: unknown; skipped?: unknown; problem?: unknown };
export interface ConnectionImport {
  imported: string[];
  skipped: { exchange: string; reason: string }[];
  /** Why no connection came over, or null. */
  problem: string | null;
}
const READER_PROBLEMS: Record<string, string> = {
  missing: '工作台资产模块的 config.json 不存在，连接未导入（账本照常导入），请在资产页重新连接',
  unreadable: '工作台资产模块的 config.json 读不出，连接未导入（账本照常导入），请在资产页重新连接',
  invalid: '工作台资产模块的 config.json 没有有效的 credentialKey（64 位十六进制），连接未导入（账本照常导入），请在资产页重新连接',
  read: '读取工作台的连接表失败，连接未导入（账本照常导入），请在资产页重新连接',
};
const SKIP_REASONS: Record<string, string> = { decrypt: '无法用工作台密钥解密（密钥换过或数据损坏）', name: '连接名不是工作台写的', invalid: '凭据格式不符合连接接口的要求', orphan: '账本里没有对应的 Aster 账号（页面上无法管理）' };
const shownName = (value: unknown): string => typeof value === 'string' ? value.replace(/[^0-9A-Za-z:_-]/g, '').slice(0, 48) : '';

/**
 * The reader's connections checked and sealed with this data directory's key (created if needed), and the settings with
 * the tails the import took out put back from the credentials: the exchanges' `label`, and each Aster account's (its
 * wallet's last four). Wallet addresses stay out of the settings; the connect paths read them from the connections.
 */
export function sealConnections(dataDir: string, ledger: PreparedLedger, text: string): { ledger: PreparedLedger; sealed: SealedConnection[]; report: ConnectionImport } {
  const report: ConnectionImport = { imported: [], skipped: [], problem: null };
  let dumped: Dumped;
  // The parser's message may quote the text, which is plaintext credentials: never pass it on.
  try { dumped = text.trim() ? JSON.parse(text) as Dumped : { problem: 'read' }; } catch { dumped = { problem: 'read' }; }
  if (!dumped || typeof dumped !== 'object') dumped = { problem: 'read' };
  if (dumped.problem !== null && dumped.problem !== undefined) {
    report.problem = READER_PROBLEMS[String(dumped.problem)] ?? READER_PROBLEMS.read!;
    return { ledger, sealed: [], report };
  }
  if (Array.isArray(dumped.skipped)) for (const item of dumped.skipped as { exchange?: unknown }[]) report.skipped.push({ exchange: shownName(item?.exchange), reason: SKIP_REASONS.decrypt! });
  const accepted: { name: string; credential: Credentials }[] = [];
  const seen = new Set<string>();
  // An `aster:<id>` connection without its account would be invisible on the page and block that wallet from being added again.
  const asterIds = new Set<string>();
  try {
    const saved = JSON.parse(ledger.settings.find(row => row.key === 'aster-accounts')?.value ?? '[]') as unknown;
    if (Array.isArray(saved)) for (const account of saved) if (typeof account?.id === 'string') asterIds.add(account.id);
  } catch { /* prepareLedger checked the settings; an unreadable list keeps no Aster account connection. */ }
  for (const item of Array.isArray(dumped.connections) ? dumped.connections as { exchange?: unknown; credential?: unknown }[] : []) {
    const name = item?.exchange, exchange = connectionExchange(name);
    if (!exchange || seen.has(name as string)) { report.skipped.push({ exchange: shownName(name), reason: SKIP_REASONS.name! }); continue; }
    if ((name as string).startsWith('aster:') && !asterIds.has((name as string).slice('aster:'.length))) { report.skipped.push({ exchange: shownName(name), reason: SKIP_REASONS.orphan! }); continue; }
    const stored = item.credential;
    try {
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new AssetInputError('credential');
      accepted.push({ name: name as string, credential: parseConnection({ ...stored, exchange }) });
      seen.add(name as string);
    } catch (error) {
      if (!(error instanceof AssetInputError)) throw error;
      report.skipped.push({ exchange: shownName(name), reason: SKIP_REASONS.invalid! });
    }
  }
  if (!accepted.length) return { ledger, sealed: [], report };
  const key = credentialKey(dataDir, { create: true });
  const sealed = accepted.map(({ name, credential }) => ({ exchange: name, encrypted: seal(credential, name, key) }));
  report.imported = accepted.map(({ name }) => name);
  const tails = new Map(accepted.map(({ name, credential }) => [name, credentialTail(credential)]));
  const settings = ledger.settings.map(row => {
    if (row.key === 'aster-accounts') {
      const accounts = JSON.parse(row.value) as { id?: unknown; label?: string }[];
      return { ...row, value: JSON.stringify(accounts.map(account => {
        const tail = typeof account.id === 'string' ? tails.get(asterKey(account.id)) : undefined;
        return tail === undefined ? account : { ...account, label: tail };
      })) };
    }
    const exchange = row.key.endsWith('-status') ? row.key.slice(0, -'-status'.length) : '';
    const tail = exchange && exchange !== 'variational' ? tails.get(exchange) : undefined;
    return tail === undefined ? row : { ...row, value: JSON.stringify({ ...JSON.parse(row.value) as object, label: tail }) };
  });
  return { ledger: { ...ledger, settings }, sealed, report };
}

/** The record of the last import in <dataDir>/asset.sqlite; null when nothing was imported yet. */
export async function readImportRecord(dataDir: string): Promise<ImportInfo | null> {
  const path = join(dataDir, ASSET_DB_FILE);
  try { lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const database = openAssetDb(path, { readOnly: true });
  try {
    const row = await database.prepare("SELECT value FROM settings WHERE key = 'import-info'").first<{ value: string }>();
    return row ? parseImportInfo(row.value) : null;
  } catch (error) {
    if (/no such table/.test(message(error))) return null;
    throw error;
  } finally { database.close(); }
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { 'data-dir': { type: 'string' }, owner: { type: 'string' }, file: { type: 'string' } } });
  if (!values['data-dir']) throw new Error('需要 --data-dir <本服务数据目录的绝对路径>');
  const dataDir = assertDedicatedDataDir(values['data-dir']);
  const out = (value: unknown): void => { process.stdout.write(JSON.stringify(value)); };
  if (positionals[0] === 'info' && positionals.length === 1) { out({ info: await readImportRecord(dataDir) }); return; }
  if (positionals[0] !== 'write' || positionals.length !== 1 || !values.owner || !values.file) throw new Error('用法：write --data-dir <目录> --owner <用户> --file <文件名>，或 info --data-dir <目录>');
  // A new asset.sqlite (and its -wal / -shm) is the service account's alone, whatever umask started this.
  process.umask(0o077);
  assertOwnFiles(dataDir);
  let rows: unknown;
  try { rows = JSON.parse(readAll(3, MAX_ROWS_BYTES, '账本行过大')); } catch (error) { throw new Error(`传入的账本行无效：${message(error)}`); }
  const prepared = prepareLedger(rows, { file: values.file, owner: values.owner });
  let connections: string;
  try { connections = readAll(0, MAX_CONNECTIONS_BYTES, 'too large'); } catch { connections = ''; }
  const { ledger, sealed, report } = sealConnections(dataDir, prepared, connections);
  out({ info: writeLedger(dataDir, ledger, sealed), connections: report });
}

if (import.meta.main) main().catch((error: unknown) => { process.stderr.write(message(error).split('\n')[0]!); process.exitCode = 1; });
