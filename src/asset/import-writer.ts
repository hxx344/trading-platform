// The writing half of the page's (and install.sh's) asset ledger import, run by src/service/import-modules.ts as the
// owner of this service's data directory, never as root (root would be writing into a directory the service account
// controls), with no environment:
//   node import-writer.ts write --data-dir <dir> --owner <user> --file <name>   one owner's rows as JSON on stdin
//   node import-writer.ts info --data-dir <dir>                                 the last import record, or null
// The rows are checked again here (prepareLedger) before asset.sqlite is replaced in one transaction. The output is one
// JSON line with the import record, never ledger content.
import { lstatSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ASSET_DB_FILE, openAssetDb } from './db.ts';
import { prepareLedger, writeLedger } from './import.ts';
import { parseImportInfo } from './store.ts';
import { assertDedicatedDataDir } from '../data-dir.ts';
import type { ImportInfo } from './views.ts';

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Same bound as the reader's maxBuffer in import-modules.ts, stated here too. */
const MAX_STDIN_BYTES = 64 * 1024 * 1024;
function readStdin(limit: number): string {
  const chunks: Buffer[] = [], buffer = Buffer.alloc(1 << 20);
  let total = 0;
  for (;;) {
    const read = readSync(0, buffer, 0, buffer.length, null);
    if (read === 0) break;
    total += read;
    if (total > limit) throw new Error('账本行过大');
    chunks.push(Buffer.from(buffer.subarray(0, read)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** asset.sqlite and its side files must be plain files of this account: one left by root (a hand import) is not taken over. */
export function assertOwnFiles(dataDir: string, uid = process.getuid?.()): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const path = join(dataDir, ASSET_DB_FILE + suffix);
    let stat;
    try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (!stat.isFile()) throw new Error(`${path} 不是普通文件，未改动`);
    if (uid !== undefined && stat.uid !== uid) throw new Error(`${path} 归 uid ${stat.uid}，不归服务账户（uid ${uid}），未改动；请把它改回服务账户所有（chown）后重试`);
  }
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
  try { rows = JSON.parse(readStdin(MAX_STDIN_BYTES)); } catch (error) { throw new Error(`传入的账本行无效：${message(error)}`); }
  out({ info: writeLedger(dataDir, prepareLedger(rows, { file: values.file, owner: values.owner })) });
}

if (import.meta.main) main().catch((error: unknown) => { process.stderr.write(message(error).split('\n')[0]!); process.exitCode = 1; });
