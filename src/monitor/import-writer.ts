// The writing half of the page's (and install.sh's) alert import (M-3b), run by src/service/import-monitor-alerts.ts as the
// owner of this service's data directory, never as root, with no environment:
//   node import-writer.ts write --data-dir <dir>      stdin: {"oil"?: config, "hynix"?: config}
// The tiers are checked again (alerts.ts validateAlertConfig) and written into monitor.sqlite under alerts.<market>.import
// in one transaction; the running service applies them on its next check (alerts.ts applyPending). The output is one JSON
// line with the markets written and their tier counts; error text never quotes stdin.
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { assertDedicatedDataDir } from '../data-dir.ts';
import { parseAlertImport } from './alert-import.ts';
import { pendingImportKey, type AlertMarket, type PendingImport } from './alerts.ts';
import { MONITOR_FILE, createMonitorStore } from './store.ts';

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
/** Two markets of at most 50 tiers, each a few hundred bytes. */
const MAX_INPUT_BYTES = 256 * 1024;

/** monitor.sqlite and its side files, when present, are plain files of the service account (as asset.sqlite's are checked). */
export function assertOwnMonitorFiles(dataDir: string, uid = process.getuid?.()): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const path = join(dataDir, MONITOR_FILE + suffix);
    let stat;
    try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (!stat.isFile()) throw new Error(`${path} 不是普通文件，未改动`);
    if (uid !== undefined && stat.uid !== uid) throw new Error(`${path} 归 uid ${stat.uid}，不归服务账户（uid ${uid}），未改动；请把它改回服务账户所有（chown）后重试`);
  }
}

/** Writes the waiting imports; the markets written with their tier counts. */
export function writePendingImports(dataDir: string, input: unknown, now = Date.now): { markets: { market: AlertMarket; rules: number; enabled: boolean }[] } {
  const parsed = parseAlertImport(input);
  assertOwnMonitorFiles(dataDir);
  const importedAt = new Date(now()).toISOString();
  const entries = (['oil', 'hynix'] as const).flatMap(market => {
    const config = parsed[market];
    return config ? [[market, { version: 1, importedAt, source: 'workbench', config } satisfies PendingImport] as const] : [];
  });
  const store = createMonitorStore({ file: join(dataDir, MONITOR_FILE), now });
  try { store.commitStates(entries.map(([market, value]) => [pendingImportKey(market), value] as const)); }
  finally { store.close(); }
  return { markets: entries.map(([market, value]) => ({ market, rules: value.config.rules.length, enabled: value.config.enabled })) };
}

function main(): void {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { 'data-dir': { type: 'string' } } });
  if (positionals[0] !== 'write' || positionals.length !== 1 || !values['data-dir']) throw new Error('用法：write --data-dir <本服务数据目录的绝对路径>（档位从标准输入传入）');
  const dataDir = assertDedicatedDataDir(values['data-dir']);
  // A new monitor.sqlite (and its -wal / -shm) is the service account's alone, whatever umask started this.
  process.umask(0o077);
  const text = readFileSync(0);
  if (text.length > MAX_INPUT_BYTES) throw new Error('传入的档位过大');
  let input: unknown;
  // The parser's message may quote the input: not passed on.
  try { input = JSON.parse(text.toString('utf8')); } catch { throw new Error('传入的档位不是有效的 JSON'); }
  process.stdout.write(JSON.stringify(writePendingImports(dataDir, input)));
}

if (import.meta.main) { try { main(); } catch (error) { process.stderr.write(message(error).split('\n')[0]!); process.exitCode = 1; } }
