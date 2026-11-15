// The writing half of the workbench's paper-position import (M-5e2, docs/monitor.md), run by
// src/service/import-monitor-paper.ts as the owner of this service's data directory, never as root, with no environment:
//   node perpetual-paper-import-writer.ts inspect --data-dir <dir>   counts and ids of what this service holds (records and pending)
//   node perpetual-paper-import-writer.ts write --data-dir <dir>     stdin: the workbench's paper-positions.json state
// `write` checks the state again, plans it against the records (read only) and an existing pending file by the rules of
// mergePerpetualPaperImport, and writes perpetual-paper-positions.import.json (600, renamed into place) holding the pending
// records with the new ones; the service merges it on its next check (perpetual-paper-store.ts). perpetual-paper-positions.json
// itself is never written here: the service process stays its only writer. Output is one JSON line of counts and reasons.
import { lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { assertDedicatedDataDir } from '../data-dir.ts';
import { PERPETUAL_PAPER_LIMITS, type PerpetualPaperState } from '../vendor/perpetual-paper.ts';
import { validatePerpetualPaperState } from '../vendor/perpetual-paper-store.mjs';
import { PERPETUAL_PAPER_FILE, PERPETUAL_PAPER_IMPORT_FILE, PERPETUAL_PAPER_LOADING_FILE, mergePerpetualPaperImport, planPerpetualPaperImport, readPerpetualPaperImportFile, summarizePerpetualPaper } from './perpetual-paper-store.ts';

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** This service's side as the preview sees it: the records and the pending file together; no record content. */
export interface ServicePaper { active: number; closed: number; pending: number; ids: string[] }
export interface PaperWriteResult {
  written: boolean; reason: string | null;
  /** New records from the workbench now pending, and all records the pending file holds. */
  added: number; pending: number;
  skipped: number; expired: number; stripped: number;
  /** The counts the service will have once it loads the pending file. */
  active: number; closed: number;
}

/** The file, when present, is a plain file of the service account (a link or someone else's file is not used). */
function assertOwnFile(file: string, uid = process.getuid?.()): void {
  let stat;
  try { stat = lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (!stat.isFile()) throw new Error(`${file} 不是普通文件（符号链接等），未改动`);
  if (uid !== undefined && stat.uid !== uid) throw new Error(`${file} 归 uid ${stat.uid}，不归服务账户（uid ${uid}），未改动；请把它改回服务账户所有（chown）后重试`);
}

/**
 * The records and the pending file as they are now; throws when either cannot be used. `pending` keeps only records the
 * records file does not hold (a pending file a load could not remove, or one written while a load ran, may repeat some).
 * `records` also holds what a claimed file kept for the next start adds (the service loads it before the pending file); a
 * claimed file that cannot be read is left out (the service sets it aside).
 */
function current(dataDir: string, now: number): { records: PerpetualPaperState; pending: PerpetualPaperState | null } {
  const recordsFile = join(dataDir, PERPETUAL_PAPER_FILE), pendingFile = join(dataDir, PERPETUAL_PAPER_IMPORT_FILE);
  assertOwnFile(recordsFile); assertOwnFile(pendingFile);
  let records: PerpetualPaperState;
  try { records = readPerpetualPaperImportFile(recordsFile) ?? { version: 1, revision: 0, positions: [] }; }
  catch (error) { throw new Error(`本服务的 ${PERPETUAL_PAPER_FILE} ${message(error)}，未写入；请先在行情监控页确认持仓记录可用`); }
  let pending: PerpetualPaperState | null;
  try { pending = readPerpetualPaperImportFile(pendingFile); }
  catch (error) { throw new Error(`已有的待载入文件 ${PERPETUAL_PAPER_IMPORT_FILE} ${message(error)}，未改动；删除它后重试`); }
  let claimed: PerpetualPaperState | null = null;
  try { claimed = readPerpetualPaperImportFile(join(dataDir, PERPETUAL_PAPER_LOADING_FILE)); } catch { /* set aside by the service */ }
  // Merged as the service will merge it; a claimed file it would set aside adds nothing.
  if (claimed) records = mergePerpetualPaperImport(records, claimed.positions, now).state ?? records;
  const held = new Set(records.positions.map(position => position.id));
  return { records, pending: pending && { ...pending, positions: pending.positions.filter(position => !held.has(position.id)) } };
}

export function inspectServicePaper(dataDir: string, now = Date.now()): ServicePaper {
  const { records, pending } = current(dataDir, now);
  const all = [...records.positions, ...(pending?.positions ?? [])], summary = summarizePerpetualPaper(all, now);
  return { active: summary.active, closed: summary.closed, pending: pending?.positions.length ?? 0, ids: [...summary.ids] };
}

/** Plans the workbench's state against the records and the pending file as they are now and, when new records come, writes the pending file. */
export function writeImportedPaper(dataDir: string, input: unknown, now = Date.now()): PaperWriteResult {
  let workbench: PerpetualPaperState;
  try { workbench = validatePerpetualPaperState(input); } catch { throw new Error('传入的持仓记录未通过校验'); }
  const { records, pending } = current(dataDir, now);
  const held = [...records.positions, ...(pending?.positions ?? [])];
  // What the workbench adds, counted as the preview counts it (against both files).
  const plan = planPerpetualPaperImport(summarizePerpetualPaper(held, now), workbench.positions, now);
  const result = { added: 0, pending: pending?.positions.length ?? 0, skipped: plan.skipped, expired: plan.expired, stripped: 0, active: plan.active, closed: plan.closed };
  if (plan.status !== 'add') return { written: false, reason: plan.reason, ...result };
  // The pending file as the service will merge it: its records with the new ones, checked against the records.
  const merged = mergePerpetualPaperImport(records, [...(pending?.positions ?? []), ...plan.add], now);
  if (merged.status !== 'add') return { written: false, reason: merged.reason, ...result };
  const next = validatePerpetualPaperState({ version: 1, revision: (pending?.revision ?? 0) + 1, positions: merged.add });
  const content = `${JSON.stringify(next)}\n`;
  if (Buffer.byteLength(content) > PERPETUAL_PAPER_LIMITS.fileBytes) return { written: false, reason: '待载入的持仓记录超过 1 MB 上限，整批不导入', ...result };
  const file = join(dataDir, PERPETUAL_PAPER_IMPORT_FILE), temporary = `${file}.tmp`;
  try {
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  } catch (error) { try { unlinkSync(temporary); } catch { /* already gone */ } throw error; }
  // New records whose requestId was taken here already (they came over without it).
  const asMerged = new Map(merged.add.map(position => [position.id, position]));
  const stripped = plan.add.filter(position => position.requestId !== undefined && asMerged.get(position.id)?.requestId === undefined).length;
  return { written: true, reason: null, ...result, added: plan.add.length, pending: next.positions.length, stripped, active: merged.active, closed: merged.closed };
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { 'data-dir': { type: 'string' } } });
  const command = positionals[0];
  if ((command !== 'write' && command !== 'inspect') || positionals.length !== 1 || !values['data-dir']) throw new Error('用法：inspect|write --data-dir <本服务数据目录的绝对路径>（write 的持仓记录从标准输入传入）');
  const dataDir = assertDedicatedDataDir(values['data-dir']);
  if (command === 'inspect') { process.stdout.write(JSON.stringify(inspectServicePaper(dataDir))); return; }
  process.umask(0o077);
  const text = readFileSync(0);
  if (text.length > PERPETUAL_PAPER_LIMITS.fileBytes) throw new Error('传入的内容过大');
  let input: unknown;
  // The parser's message may quote the input: not passed on.
  try { input = JSON.parse(text.toString('utf8')); } catch { throw new Error('传入的内容不是有效的 JSON'); }
  process.stdout.write(JSON.stringify(writeImportedPaper(dataDir, input)));
}

if (import.meta.main) { main().catch((error: unknown) => { process.stderr.write(message(error).split('\n')[0]!); process.exitCode = 1; }); }
