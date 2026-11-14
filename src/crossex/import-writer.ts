// The writing half of the workbench CrossEx import (src/service/import-crossex.ts), run as the owner of this service's
// data directory, never as root, with no environment:
//   node import-writer.ts seed --data-dir <dir>
// seed reads the workbench page settings as JSON on stdin (only PAGE_SETTING_KEYS, checked again with the workbench
// model's configuration()) and stores them under crossex.sqlite `config` only when no settings are there yet, so a later
// import never replaces what the page saved. The output is one JSON line { seeded }; error text never quotes stdin.
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { assertDedicatedDataDir } from '../data-dir.ts';
import { configuration } from '../vendor/crossex/model.mjs';
import { CROSSEX_DATABASE, PAGE_SETTING_KEYS, openCrossexDatabase } from './store.ts';

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const MAX_INPUT_BYTES = 64 * 1024;

/** crossex.sqlite and its -wal / -shm / -journal must be plain files of this account, as in asset/db.ts. */
function assertOwnFiles(dataDir: string, uid = process.getuid?.()): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const path = join(dataDir, CROSSEX_DATABASE + suffix);
    let stat;
    try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (!stat.isFile()) throw new Error(`${path} 不是普通文件，未改动`);
    if (uid !== undefined && stat.uid !== uid) throw new Error(`${path} 归 uid ${stat.uid}，不归服务账户（uid ${uid}），未改动；请把它改回服务账户所有（chown）后重试`);
  }
}

/** The settings as stored: exactly the page keys, each accepted by the workbench model. */
export function seedSettings(text: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('页面设置不是有效的 JSON'); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('页面设置须为对象');
  const keys = Object.keys(value);
  if (keys.length !== PAGE_SETTING_KEYS.length || !PAGE_SETTING_KEYS.every(key => Object.hasOwn(value, key))) throw new Error('页面设置的字段不符');
  try { configuration(value as Record<string, unknown>); } catch { throw new Error('页面设置未通过 CrossEx 设置检查'); }
  return Object.fromEntries(PAGE_SETTING_KEYS.map(key => [key, (value as Record<string, unknown>)[key]]));
}

/** Stores the settings when crossex.sqlite has none; true when they were written. */
export function seed(dataDir: string, settings: Record<string, unknown>): boolean {
  const db = openCrossexDatabase(join(dataDir, CROSSEX_DATABASE));
  try { return Number(db.prepare("INSERT OR IGNORE INTO settings VALUES ('config', ?)").run(JSON.stringify(settings)).changes) === 1; }
  finally { db.close(); }
}

function main(): void {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { 'data-dir': { type: 'string' } } });
  if (positionals.length !== 1 || positionals[0] !== 'seed' || values['data-dir'] === undefined) throw new Error('用法：import-writer.ts seed --data-dir <dir>');
  const dataDir = assertDedicatedDataDir(values['data-dir']);
  const input = readFileSync(0);
  if (input.length > MAX_INPUT_BYTES) throw new Error('页面设置过大');
  const settings = seedSettings(input.toString('utf8'));
  // A new crossex.sqlite (and its -wal / -shm) is the service account's alone, whatever umask started this.
  process.umask(0o077);
  assertOwnFiles(dataDir);
  process.stdout.write(JSON.stringify({ seeded: seed(dataDir, settings) }));
}

if (import.meta.main) { try { main(); } catch (error) { process.stderr.write(message(error).split('\n')[0]!); process.exitCode = 1; } }
