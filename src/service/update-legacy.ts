// The only data the private executor reads for online updates is a previous single-process install's result.
import { join } from 'node:path';
import { readBounded } from './handoff-file.ts';
import type { UpdateResult, UpdateView } from './update-types.ts';

export const UPDATE_RESULT_FILE = 'update-result.json';
/** Helper TimeoutStartSec + TimeoutStopSec and a margin. */
export const UPDATE_RUNNING_STALE_MS = 2_160_000;
export const VERSION = /^v(\d{1,4})\.(\d{1,4})\.(\d{1,6})$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isVersion = (value: unknown): value is string => typeof value === 'string' && VERSION.test(value);
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Only the fields written by the update helper cross the account boundary. */
export function readUpdateResult(dir: string, owner?: number): UpdateResult | null {
  const text = readBounded(join(dir, UPDATE_RESULT_FILE), 64 * 1024, stat => {
    if (stat.nlink !== 1 || (owner !== undefined && stat.uid !== owner)) throw new Error('更新结果文件的链接数或属主无效');
  });
  if (text === null) return null;
  const raw = JSON.parse(text) as Partial<UpdateResult> | null;
  if (!raw || typeof raw !== 'object') throw new Error('更新结果格式不对');
  const { id, version, from, startedAt, at, phase, step, message, output, installed } = raw;
  if ((id !== null && (typeof id !== 'string' || !UUID.test(id))) || (version !== null && !isVersion(version)) || (from !== null && !isVersion(from))
    || !timestamp(startedAt) || !timestamp(at) || (phase !== 'running' && phase !== 'done' && phase !== 'failed')
    || (step !== undefined && step !== 'download' && step !== 'install') || typeof message !== 'string'
    || !Array.isArray(output) || !output.every(line => typeof line === 'string') || (installed !== undefined && !isVersion(installed))) throw new Error('更新结果格式不对');
  return { id, version, from, startedAt, at, phase, message, output, ...(step ? { step } : {}), ...(installed ? { installed } : {}) };
}

export function updateJob(result: UpdateResult | null, now: number): UpdateView['job'] {
  return result?.phase === 'running' && now - result.startedAt > UPDATE_RUNNING_STALE_MS ? { ...result, stale: true } : result;
}

/** An unusable legacy result must leave the new control service's update path available. */
export function legacyUpdateJob(dir: string): UpdateView['job'] {
  try { return updateJob(readUpdateResult(dir, process.getuid?.()), Date.now()); }
  catch { return null; }
}
