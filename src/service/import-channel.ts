// The hand-off between the page and the root import helper. The service (its own account) drops one request file into
// a directory root owns and the service's group may write; a systemd path unit starts the helper as root, which takes
// the request, reads the workbench, writes this service's two files, restarts the service and leaves its answer as one
// result file. Only names, ids, account tails and reasons go through here; keys and webhooks never do.
import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, constants, fchownSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, renameSync, rmSync, unlinkSync, writeSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { ContractError, PAIR_ID, exactKeys } from '../contracts.ts';
import { MAX_PAIRS } from './config.ts';
import type { ImportItem, PreviewItem } from './import-workbench.ts';

export const REQUEST_FILE = 'request.json';
export const RESULT_FILE = 'result.json';
const MAX_REQUEST_BYTES = 4 * 1024;
const MAX_RESULT_BYTES = 256 * 1024;
/** A request nobody took within this long (no helper installed, or it failed first) is replaced by the next one. */
export const REQUEST_STALE_MS = 120_000;
/** The helper's own limit (TimeoutStartSec=720 in its unit): a result still "running" past it was cut short. */
export const RUNNING_STALE_MS = 750_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type ImportAction = 'preview' | 'import';
export interface ImportRequest { id: string; action: ImportAction; pairs?: string[]; at: number }
export interface ImportResult {
  /** The request answered; null when the request file itself could not be read. */
  id: string | null;
  action: ImportAction | null;
  at: number;
  /** running: taken; restarting: files written, the service is being restarted; done / failed: final. */
  phase: 'running' | 'restarting' | 'done' | 'failed';
  message: string;
  database?: string;
  preview?: PreviewItem[];
  imported?: ImportItem[];
  notes?: string[];
}

/** What the page may ask for: a preview of every workbench pair, or importing the chosen ones. */
export function parseImportBody(raw: unknown): { action: ImportAction; pairs?: string[] } {
  const value = exactKeys(raw, ['action'], ['pairs']);
  if (value.action === 'preview') {
    if (value.pairs !== undefined) throw new ContractError(400, 'import_pairs', '预览不选配对');
    return { action: 'preview' };
  }
  if (value.action !== 'import') throw new ContractError(400, 'import_action', '导入操作无效');
  const pairs = value.pairs;
  if (!Array.isArray(pairs) || pairs.length < 1 || pairs.length > MAX_PAIRS) throw new ContractError(400, 'import_pairs', `请选择 1–${MAX_PAIRS} 个配对`);
  if (!pairs.every(id => typeof id === 'string' && PAIR_ID.test(id))) throw new ContractError(400, 'import_pairs', '配对 id 无效');
  if (new Set(pairs).size !== pairs.length) throw new ContractError(400, 'import_pairs', '配对重复');
  return { action: 'import', pairs: pairs as string[] };
}

export function parseImportRequest(raw: unknown): ImportRequest {
  const value = exactKeys(raw, ['id', 'action', 'at'], ['pairs']);
  if (typeof value.id !== 'string' || !UUID.test(value.id)) throw new Error('请求编号无效');
  if (typeof value.at !== 'number' || !Number.isSafeInteger(value.at)) throw new Error('请求时间无效');
  const body = parseImportBody(value.pairs === undefined ? { action: value.action } : { action: value.action, pairs: value.pairs });
  return { id: value.id, at: value.at, ...body };
}

const lstatOrNull = (path: string): Stats | null => {
  try { return lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
};

/** Reads at most `limit` bytes of a plain file without following a link; null when it is not there. */
function readBounded(path: string, limit: number, check?: (stat: Stats) => void): string | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw new Error(code === 'ELOOP' ? `${path} 是符号链接` : `${path} 无法打开：${code ?? '未知错误'}`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${path} 不是普通文件`);
    check?.(stat);
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    for (let read; length < buffer.length && (read = readSync(fd, buffer, length, buffer.length - length, null)) > 0;) length += read;
    if (length > limit) throw new Error(`${path} 超过 ${limit} 字节`);
    return buffer.toString('utf8', 0, length);
  } finally { closeSync(fd); }
}

/** The helper's latest answer, as it wrote it; null before the first one. */
export function readImportResult(dir: string): ImportResult | null {
  let text: string | null;
  try { text = readBounded(join(dir, RESULT_FILE), MAX_RESULT_BYTES); }
  catch (error) { throw new ContractError(503, 'import_unavailable', `无法读取导入结果：${error instanceof Error ? error.message : String(error)}`); }
  if (text === null) return null;
  try { return JSON.parse(text) as ImportResult; } catch { throw new ContractError(503, 'import_unavailable', '导入结果不是有效 JSON'); }
}

/**
 * Leaves a request for the helper and returns its id. One at a time: a request not yet taken, or one the helper is
 * still working on (or restarting the service for), is not replaced.
 */
export function submitImportRequest(dir: string, body: unknown, now: () => number = Date.now): { id: string; at: number } {
  const parsed = parseImportBody(body);
  const path = join(dir, REQUEST_FILE);
  let pending: Stats | null;
  try { pending = lstatOrNull(path); } catch (error) { throw new ContractError(503, 'import_unavailable', `导入目录无法访问：${(error as NodeJS.ErrnoException).code ?? '未知错误'}`); }
  if (pending && now() - pending.mtimeMs < REQUEST_STALE_MS) throw new ContractError(409, 'import_busy', '上一个导入请求还没有被处理，请稍候');
  const latest = readImportResult(dir);
  if (latest && (latest.phase === 'running' || latest.phase === 'restarting') && now() - latest.at < RUNNING_STALE_MS) {
    throw new ContractError(409, 'import_busy', latest.phase === 'restarting' ? '上一次导入正在重启服务，请稍候' : '上一个导入请求正在处理，请稍候');
  }
  const request: ImportRequest = { id: randomUUID(), ...parsed, at: now() };
  const temporary = join(dir, `.request.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeSync(fd, JSON.stringify(request)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new ContractError(503, 'import_unavailable', `无法提交导入请求：${(error as NodeJS.ErrnoException).code ?? '未知错误'}`);
  }
  return { id: request.id, at: request.at };
}

/**
 * Takes the pending request, if any, as root: only a plain file of the service account with one link, small enough,
 * is read. The request is removed either way, so a bad one is answered once and not taken again.
 */
export function takeImportRequest(dir: string, owner: { uid: number }): ImportRequest | { invalid: string } | null {
  const path = join(dir, REQUEST_FILE);
  let seen: Stats | null = null;
  let text: string | null;
  try {
    text = readBounded(path, MAX_REQUEST_BYTES, stat => {
      seen = stat;
      if (stat.uid !== owner.uid) throw new Error('请求文件不属于服务账户');
      if (stat.nlink !== 1) throw new Error('请求文件有多个硬链接');
    });
  } catch (error) {
    // Whatever is there (a link, a directory, someone else's file) is not a request: removed without following it.
    try { const now = lstatOrNull(path); if (now && !now.isDirectory()) unlinkSync(path); } catch { /* the next request replaces it */ }
    return { invalid: error instanceof Error ? error.message : String(error) };
  }
  if (text === null) return null;
  // Removed only while it is still the file read; a newer request that replaced it meanwhile stays for the next round.
  const read = seen as Stats | null, current = lstatOrNull(path);
  if (read && current && current.ino === read.ino && current.dev === read.dev) unlinkSync(path);
  try { return parseImportRequest(JSON.parse(text)); }
  catch (error) { return { invalid: error instanceof SyntaxError ? '请求不是有效 JSON' : error instanceof Error ? error.message : String(error) }; }
}

/** Replaces the result file as root: a fresh private file of the service account, renamed over whatever is there. */
export function writeImportResult(dir: string, result: ImportResult, owner: { uid: number; gid: number }): void {
  const temporary = join(dir, `.result.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      if (process.getuid?.() === 0) fchownSync(fd, owner.uid, owner.gid);
      writeSync(fd, JSON.stringify(result)); fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temporary, join(dir, RESULT_FILE));
  } catch (error) { rmSync(temporary, { force: true }); throw error; }
}
