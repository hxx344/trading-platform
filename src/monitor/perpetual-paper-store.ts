// Monitor M-5e1: the paper-position records of the perpetual collector, one JSON file in the data directory
// (perpetual-paper-positions.json; the workbench keeps the same format in <module data>/perpetual/paper-positions.json).
// The workbench's openPerpetualPaperStore (perpetual-paper-store.mjs, c84ba27) opened synchronously, as openMonitor is:
// read once at start (over 1 MB, unparsable or failing the workbench's validatePerpetualPaperState → refused with the
// workbench's message, the file left as it is; missing → empty), then each save validated, capped at 1 MB and written to
// `${file}.tmp` (0600) and renamed over it. The service process is the only writer; the paper service serializes its saves.
import { readFileSync, statSync } from 'node:fs';
import { rename, unlink, writeFile } from 'node:fs/promises';
import { PERPETUAL_PAPER_LIMITS, type PerpetualPaperState } from '../vendor/perpetual-paper.ts';
import type { PerpetualPaperStore } from '../vendor/perpetual-paper-service.mjs';
import { validatePerpetualPaperState } from '../vendor/perpetual-paper-store.mjs';

export const PERPETUAL_PAPER_FILE = 'perpetual-paper-positions.json';
export const PERPETUAL_PAPER_UNREADABLE = `持仓记录无法读取，请修复或恢复 ${PERPETUAL_PAPER_FILE}。`;

/** Throws PERPETUAL_PAPER_UNREADABLE (the cause attached) for a file that exists but cannot be used. */
export function openPerpetualPaperStore(file: string): PerpetualPaperStore {
  let state: PerpetualPaperState = { version: 1, revision: 0, positions: [] };
  try {
    if (statSync(file).size > PERPETUAL_PAPER_LIMITS.fileBytes) throw new Error('State too large');
    state = validatePerpetualPaperState(JSON.parse(readFileSync(file, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw new Error(PERPETUAL_PAPER_UNREADABLE, { cause: error });
  }
  return {
    get: () => structuredClone(state),
    async save(next) {
      const copy = validatePerpetualPaperState(next), content = `${JSON.stringify(copy)}\n`;
      if (Buffer.byteLength(content) > PERPETUAL_PAPER_LIMITS.fileBytes) throw new Error('持仓记录超过 1 MB 上限。');
      // One fixed temporary path, so an interrupted write cannot leave orphan files behind.
      const temporary = `${file}.tmp`;
      // A leftover temporary file keeps its own mode through writeFile; remove it so the new one is created 0600.
      try { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); await writeFile(temporary, content, { mode: 0o600 }); await rename(temporary, file); state = copy; }
      catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
    },
  };
}
