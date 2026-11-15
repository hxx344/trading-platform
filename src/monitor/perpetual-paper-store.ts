// Monitor M-5e1: the paper-position records of the perpetual collector, one JSON file in the data directory
// (perpetual-paper-positions.json; the workbench keeps the same format in <module data>/perpetual/paper-positions.json).
// The workbench's openPerpetualPaperStore (perpetual-paper-store.mjs, c84ba27) opened synchronously, as openMonitor is:
// read once at start (over 1 MB, unparsable or failing the workbench's validatePerpetualPaperState → refused with the
// workbench's message, the file left as it is; missing → empty), then each save validated, capped at 1 MB and written to
// `${file}.tmp` (0600) and renamed over it. The service process is the only writer; the paper service serializes its saves.
// M-5e2 adds the workbench import's pending file (perpetual-paper-positions.import.json, written by
// perpetual-paper-import-writer.ts as the data directory's owner): merged into the records by the rules of
// mergePerpetualPaperImport when the store opens and, while the collector runs, when adoptPending is called with the paper
// service stopped. A load first claims the file (renames it to perpetual-paper-positions.import.loading.json), so a pending
// file the writer puts in place meanwhile is a new one, never removed or set aside with it; the claimed file is then removed,
// or renamed to perpetual-paper-positions.import.rejected.json when it cannot be merged, or kept (tried again when the service
// starts) when the records could not be written.
import { lstatSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PERPETUAL_PAPER_LIMITS, type PerpetualPaperPosition, type PerpetualPaperState } from '../vendor/perpetual-paper.ts';
import type { PerpetualPaperStore } from '../vendor/perpetual-paper-service.mjs';
import { validatePerpetualPaperState } from '../vendor/perpetual-paper-store.mjs';

export const PERPETUAL_PAPER_FILE = 'perpetual-paper-positions.json';
export const PERPETUAL_PAPER_UNREADABLE = `持仓记录无法读取，请修复或恢复 ${PERPETUAL_PAPER_FILE}。`;
/** M-5e2: the records the workbench import left for the service to merge, and where one that could not be merged goes. */
export const PERPETUAL_PAPER_IMPORT_FILE = 'perpetual-paper-positions.import.json';
export const PERPETUAL_PAPER_REJECTED_FILE = 'perpetual-paper-positions.import.rejected.json';
export const PERPETUAL_PAPER_LOADING_FILE = 'perpetual-paper-positions.import.loading.json';

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const retained = (position: PerpetualPaperPosition, now: number): boolean => position.status === 'active' || (position.close?.closedAt ?? 0) > now - PERPETUAL_PAPER_LIMITS.closedRetentionMs;

/**
 * What a side already holds: every record id, and the active / ended counts. With `now`, ended records past the retention
 * are not counted (the service drops them on its next check, and a merge drops them first); their ids still are.
 */
export interface PerpetualPaperSummary { ids: ReadonlySet<string>; active: number; closed: number }
export function summarizePerpetualPaper(positions: readonly PerpetualPaperPosition[], now?: number): PerpetualPaperSummary {
  const counted = now === undefined ? positions : positions.filter(position => retained(position, now));
  const active = counted.filter(position => position.status === 'active').length;
  return { ids: new Set(positions.map(position => position.id)), active, closed: counted.length - active };
}

/** What an import brings: `add` the records that come over (in order), or why none (`none`) or the batch (`rejected`) does not. */
export interface PerpetualPaperImportPlan {
  status: 'add' | 'none' | 'rejected'; reason: string; add: PerpetualPaperPosition[];
  /** Incoming records whose id is already held, and ended ones past the 30-day retention (the service would drop them). */
  skipped: number; expired: number;
  /** The counts after the merge. */
  active: number; closed: number;
}

/**
 * The import rule on ids and counts (the preview has no more of this service's side): a held id is skipped, an ended record
 * past the retention does not come over, and the whole batch is refused when the result passes 20 active or 100 ended.
 */
export function planPerpetualPaperImport(existing: PerpetualPaperSummary, incoming: readonly PerpetualPaperPosition[], now: number): PerpetualPaperImportPlan {
  const seen = new Set(existing.ids), add: PerpetualPaperPosition[] = [];
  let skipped = 0, expired = 0;
  for (const position of incoming) {
    if (seen.has(position.id)) { skipped++; continue; }
    if (!retained(position, now)) { expired++; continue; }
    seen.add(position.id); add.push(position);
  }
  const newActive = add.filter(position => position.status === 'active').length;
  const active = existing.active + newActive, closed = existing.closed + add.length - newActive;
  const days = PERPETUAL_PAPER_LIMITS.closedRetentionMs / 86_400_000;
  const base = { add, skipped, expired, active, closed };
  if (!add.length) {
    const reason = !incoming.length ? '工作台没有持仓记录' : skipped ? `本服务已有这些记录${expired ? `（另有 ${expired} 条已结束超过 ${days} 天，不导入）` : ''}` : `工作台的 ${expired} 条记录都已结束超过 ${days} 天，不导入`;
    return { status: 'none', reason, ...base, add: [], active: existing.active, closed: existing.closed };
  }
  if (active > PERPETUAL_PAPER_LIMITS.active) return { status: 'rejected', reason: `导入后活动持仓 ${active} 个，超过上限 ${PERPETUAL_PAPER_LIMITS.active} 个，整批不导入`, ...base };
  if (closed > PERPETUAL_PAPER_LIMITS.closed) return { status: 'rejected', reason: `导入后已结束记录 ${closed} 条，超过上限 ${PERPETUAL_PAPER_LIMITS.closed} 条，整批不导入`, ...base };
  return { status: 'add', reason: '', ...base };
}

/**
 * The merge of incoming records into `current` (writer, service load): ended records past the retention are dropped first (as
 * the service's prune does), then the plan above, then an imported `requestId` already used here loses it and its fingerprint
 * (only the workbench page's retry key), and the result, at revision + 1, must pass validatePerpetualPaperState and the 1 MB cap.
 * `add` holds the records as merged; `state` is set only for `add`.
 */
export function mergePerpetualPaperImport(current: PerpetualPaperState, incoming: readonly PerpetualPaperPosition[], now: number): PerpetualPaperImportPlan & { state: PerpetualPaperState | null; stripped: number } {
  const plan = planPerpetualPaperImport(summarizePerpetualPaper(current.positions, now), incoming, now);
  if (plan.status !== 'add') return { ...plan, state: null, stripped: 0 };
  const kept = current.positions.filter(position => retained(position, now));
  const used = new Set(kept.flatMap(position => position.requestId ? [position.requestId] : []));
  let stripped = 0;
  const add = plan.add.map(position => {
    const copy = structuredClone(position);
    if (copy.requestId !== undefined && used.has(copy.requestId)) { delete copy.requestId; delete copy.requestFingerprint; stripped++; }
    else if (copy.requestId !== undefined) used.add(copy.requestId);
    return copy;
  });
  let state: PerpetualPaperState;
  try { state = validatePerpetualPaperState({ version: 1, revision: current.revision + 1, positions: [...kept, ...add] }); }
  catch { return { ...plan, add, status: 'rejected', reason: '合并后的持仓记录未通过校验，整批不导入', state: null, stripped }; }
  if (Buffer.byteLength(`${JSON.stringify(state)}\n`) > PERPETUAL_PAPER_LIMITS.fileBytes) return { ...plan, add, status: 'rejected', reason: '合并后的持仓记录超过 1 MB 上限，整批不导入', state: null, stripped };
  return { ...plan, add, state, stripped };
}

/**
 * A pending (or other import) file: null when there is none; otherwise a plain file of at most 1 MB holding a valid state.
 * Errors carry a reason of their own (never the parser's, which may quote the file).
 */
export function readPerpetualPaperImportFile(file: string): PerpetualPaperState | null {
  let stat;
  try { stat = lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error(`读不出（${(error as NodeJS.ErrnoException).code ?? 'error'}）`); }
  if (!stat.isFile()) throw new Error('不是普通文件（符号链接等）');
  if (stat.size > PERPETUAL_PAPER_LIMITS.fileBytes) throw new Error('超过 1 MB 上限');
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error('不是有效的 JSON'); }
  try { return validatePerpetualPaperState(parsed); } catch { throw new Error('未通过持仓记录校验'); }
}

/**
 * What loading a pending file did: records added (0 with the plan's reason when none came over) and whether the claimed file
 * was removed; or why it was set aside (renamed to the rejected file, or left claimed when that failed); or, when the records
 * could not be written (or the file not claimed), that it was kept for the next start.
 */
export type PerpetualPaperAdoption = { added: number; reason: string; removed: boolean } | { rejected: string; renamed: boolean } | { deferred: string };
/** The log line for a load (service/monitor.ts at open, the collector while it runs). */
export function perpetualPaperAdoptionLine(outcome: PerpetualPaperAdoption): string {
  const later = '服务重启后再试，在此之前不载入新的导入';
  if ('deferred' in outcome) return `合约价差：从工作台导入的持仓记录暂未载入（${outcome.deferred}），待载入文件保留，${later}；${PERPETUAL_PAPER_FILE} 未改动`;
  if ('rejected' in outcome) return `合约价差：从工作台导入的持仓记录未载入（${outcome.rejected}），${outcome.renamed ? `待载入文件已改名为 ${PERPETUAL_PAPER_REJECTED_FILE}` : `待载入文件留在 ${PERPETUAL_PAPER_LOADING_FILE}，${later}`}，${PERPETUAL_PAPER_FILE} 未改动`;
  const head = outcome.added ? `合约价差：已载入从工作台导入的持仓记录 ${outcome.added} 条` : `合约价差：待载入的持仓记录没有可载入的（${outcome.reason}）`;
  return outcome.removed ? (outcome.added ? head : `${head}，已删除待载入文件`) : `${head}；删除 ${PERPETUAL_PAPER_LOADING_FILE} 失败，${later}`;
}

/** The store with the M-5e2 pending-file load. */
export interface PerpetualPaperFileStore extends PerpetualPaperStore {
  /** What the open did: a file a load left claimed first, then a pending file; empty when there was none. */
  readonly opened: readonly PerpetualPaperAdoption[];
  /** Whether a pending file waits (one lstat; a file that could not be set aside is not offered again). */
  pending(): boolean;
  /** Merges a pending file into the records; call only with no save in flight (the paper service stopped). */
  adoptPending(now?: number): Promise<PerpetualPaperAdoption | null>;
}

/** Throws PERPETUAL_PAPER_UNREADABLE (the cause attached) for a file that exists but cannot be used. */
export function openPerpetualPaperStore(file: string, { now = Date.now }: { now?: () => number } = {}): PerpetualPaperFileStore {
  let state: PerpetualPaperState = { version: 1, revision: 0, positions: [] };
  try {
    if (statSync(file).size > PERPETUAL_PAPER_LIMITS.fileBytes) throw new Error('State too large');
    state = validatePerpetualPaperState(JSON.parse(readFileSync(file, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw new Error(PERPETUAL_PAPER_UNREADABLE, { cause: error });
  }
  // One fixed temporary path, so an interrupted write cannot leave orphan files behind.
  const temporary = `${file}.tmp`;
  const pendingFile = join(dirname(file), PERPETUAL_PAPER_IMPORT_FILE), loadingFile = join(dirname(file), PERPETUAL_PAPER_LOADING_FILE);
  const rejectedFile = join(dirname(file), PERPETUAL_PAPER_REJECTED_FILE);
  // A file that could not be claimed, merged, removed or set aside: not tried again every second while it stays the same
  // (until the service starts again).
  let stuck: string | null = null;
  const identity = (path: string): string | null => { try { const stat = lstatSync(path); return `${path}:${stat.ino}:${stat.size}:${stat.mtimeMs}`; } catch { return null; } };
  // A claimed file left by an earlier load comes first: a pending file is not claimed over it.
  const waiting = (): string | null => identity(loadingFile) ?? identity(pendingFile);
  const reject = (reason: string, claimed: string | null): PerpetualPaperAdoption => {
    try { renameSync(loadingFile, rejectedFile); return { rejected: reason, renamed: true }; }
    catch (error) { stuck = claimed; return { rejected: `${reason}；改名也失败了：${message(error).slice(0, 120)}`, renamed: false }; }
  };
  // Synchronous: at open (as the rest of openMonitor) and, while running, with the paper service stopped (no save in flight).
  function adopt(at: number): PerpetualPaperAdoption | null {
    const seen = waiting();
    if (seen === null || seen === stuck) return null;
    if (identity(loadingFile) === null) {
      try { renameSync(pendingFile, loadingFile); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        stuck = seen;
        return { deferred: `认领待载入文件失败：${message(error).slice(0, 120)}` };
      }
    }
    const claimed = identity(loadingFile);
    let incoming: PerpetualPaperState | null;
    try { incoming = readPerpetualPaperImportFile(loadingFile); } catch (error) { return reject(`待载入文件${message(error)}`, claimed); }
    if (!incoming) return null;
    const merged = mergePerpetualPaperImport(state, incoming.positions, at);
    if (merged.status === 'rejected') return reject(merged.reason, claimed);
    if (merged.state) {
      try {
        try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        writeFileSync(temporary, `${JSON.stringify(merged.state)}\n`, { mode: 0o600 });
        renameSync(temporary, file);
      } catch (error) {
        try { unlinkSync(temporary); } catch { /* already gone */ }
        // Likely passing (a full disk): kept claimed, so the next start merges it.
        stuck = claimed;
        return { deferred: `写入 ${PERPETUAL_PAPER_FILE} 失败：${message(error).slice(0, 120)}` };
      }
      state = merged.state;
    }
    // Merged but not removed: not offered again while it stays; a later load finds every id here already and adds nothing.
    let removed = true;
    try { unlinkSync(loadingFile); } catch { removed = false; stuck = claimed; }
    return { added: merged.state ? merged.add.length : 0, reason: merged.state ? '' : merged.reason, removed };
  }
  // Every branch above catches its own failures; anything else (a bug) is kept as a deferral too, not retried every second.
  function attempt(at: number): PerpetualPaperAdoption | null {
    try { return adopt(at); } catch (error) { stuck = waiting(); return { deferred: `载入出错：${message(error).slice(0, 120)}` }; }
  }
  // At most two: a file an interrupted load left claimed, then a pending file.
  const opened: PerpetualPaperAdoption[] = [];
  for (let outcome = attempt(now()); outcome && opened.push(outcome) < 2; outcome = attempt(now())) { /* next */ }
  return {
    opened,
    get: () => structuredClone(state),
    async save(next) {
      const copy = validatePerpetualPaperState(next), content = `${JSON.stringify(copy)}\n`;
      if (Buffer.byteLength(content) > PERPETUAL_PAPER_LIMITS.fileBytes) throw new Error('持仓记录超过 1 MB 上限。');
      // A leftover temporary file keeps its own mode through writeFile; remove it so the new one is created 0600.
      try { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); await writeFile(temporary, content, { mode: 0o600 }); await rename(temporary, file); state = copy; }
      catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
    },
    pending: () => { const seen = waiting(); return seen !== null && seen !== stuck; },
    adoptPending: async (at = now()) => attempt(at),
  };
}
