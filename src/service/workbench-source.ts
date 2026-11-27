import { spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

type Owner = { uid: number; gid: number };
type SourceIssue = 'not_dir' | 'not_file' | 'linked' | 'owner' | 'large' | 'mode' | 'unreadable';
const issues: Record<SourceIssue, string> = {
  not_dir: '不是目录（符号链接等），不读取', not_file: '不是普通文件（符号链接等），不读取',
  linked: '存在其他硬链接，不读取', owner: '所有者或写权限与工作台目录不符，不读取', large: '超过大小限制，不读取', mode: '权限不符，不读取', unreadable: '无法读取',
};
class SourceError extends Error {
  issue: SourceIssue;
  constructor(issue: SourceIssue, path: string) { super(path + ' ' + issues[issue]); this.issue = issue; }
}

function inside(root: string, path: string) {
  if (!isAbsolute(root) || !isAbsolute(path)) throw new Error('工作台数据目录须为绝对路径');
  const sub = relative(root, path);
  if (sub === '..' || sub.startsWith('..' + sep) || isAbsolute(sub)) throw new Error('路径不在工作台目录中');
}

// Only a trusted ancestor may nominate a new identity. After the first non-root directory, every
// descendant must belong to it. Below the configured data root, even a root owner cannot change.
function walkDirectory<T>(root: string, dir: string, use: (owner: Owner, directory: string, privateDirectory: boolean) => T): T {
  inside(root, dir);
  dir = resolve(dir);
  const anchor = resolve(root), fsRoot = parse(dir).root;
  const parts = relative(fsRoot, dir).split(sep).filter(Boolean);
  let current = fsRoot, fd: number | undefined;
  let owner: Owner | undefined;
  let privateDirectory = false;
  try {
    for (const part of ['', ...parts]) {
      current = join(current, part);
      let stat: Stats;
      if (process.platform === 'linux') {
        // Linux O_PATH allows traversal of execute-only ancestors without directory read permission.
        const flags = 0o10000000 | constants.O_DIRECTORY | constants.O_NOFOLLOW;
        let next: number;
        try { next = openSync(fd === undefined ? current : '/proc/self/fd/' + fd + '/' + part, flags); }
        catch (error) {
          if (['ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new SourceError('not_dir', current);
          throw error;
        }
        if (fd !== undefined) closeSync(fd);
        fd = next;
        stat = fstatSync(fd);
      } else { stat = lstatSync(current); }
      if (!stat.isDirectory()) throw new SourceError('not_dir', current);
      if (owner && stat.uid !== owner.uid) throw new SourceError('owner', current);
      if (process.getuid) {
        // Once only the owner can traverse a directory, ordinary single-link files below it
        // can retain group write bits. A reachable group/world-writable ancestor is unsafe.
        if ((stat.mode & 0o011) === 0) privateDirectory = true;
        const stickyAncestor = stat.uid === 0 && !owner && current !== anchor && (stat.mode & 0o1000) !== 0;
        if (!privateDirectory && (stat.mode & 0o022) && !stickyAncestor) throw new SourceError('owner', current);
      }
      if (!owner && (stat.uid !== 0 || current === anchor)) owner = { uid: stat.uid, gid: stat.gid };
    }
    return use(owner!, fd === undefined ? dir : '/proc/self/fd/' + fd, privateDirectory);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function workbenchIdentity(root: string, dir = root): Partial<Owner> {
  const owner = walkDirectory(root, dir, value => value);
  return process.getuid?.() === 0 && owner.uid !== 0 ? owner : {};
}

/** Read metadata for preview without following either an ancestor link or the last component. */
export function sourceEntry(root: string, file: string): Stats | undefined {
  try { return walkDirectory(root, dirname(file), (_, folder) => lstatSync(join(folder, basename(file)), { throwIfNoEntry: false })); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function checkFile(stat: Stats, uid: number, path: string, privateDirectory: boolean) {
  if (!stat.isFile()) throw new SourceError('not_file', path);
  if (stat.nlink !== 1) throw new SourceError('linked', path);
  if (stat.uid !== uid || (process.getuid && !privateDirectory && (stat.mode & 0o022))) throw new SourceError('owner', path);
}

/** SQLite needs sibling paths for locking and WAL. Keep their parent pinned throughout the read. */
export function withDatabasePath<T>(root: string, file: string, read: (path: string) => T): T {
  return walkDirectory(root, dirname(file), (owner, folder, privateDirectory) => {
    if (process.getuid?.() === 0 && owner.uid !== 0) throw new SourceError('owner', file);
    const path = join(folder, basename(file));
    checkFile(lstatSync(path), owner.uid, file, privateDirectory);
    for (const suffix of ['-journal', '-wal', '-shm']) {
      const stat = lstatSync(path + suffix, { throwIfNoEntry: false });
      if (stat) checkFile(stat, owner.uid, file + suffix, privateDirectory);
    }
    return read(path);
  });
}

/** Runs in the source account. Pin each Linux directory before opening its child, including the
 * final parent; fstat checks the same non-blocking descriptor used for the bounded read. */
export function sourceBytes(root: string, file: string, limit: number, mode?: number): Buffer {
  return walkDirectory(root, dirname(file), (owner, folder, privateDirectory) => {
    if (process.getuid?.() === 0 && owner.uid !== 0) throw new SourceError('owner', file);
    const leaf = join(folder, basename(file));
    checkFile(lstatSync(leaf), owner.uid, file, privateDirectory);
    const fd = openSync(leaf, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      checkFile(stat, owner.uid, file, privateDirectory);
      if (mode !== undefined && (stat.mode & 0o777) !== mode) throw new SourceError('mode', file);
      if (stat.size > limit) throw new SourceError('large', file);
      const buffer = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const n = readSync(fd, buffer, length, buffer.length - length, null);
        if (n === 0) break;
        length += n;
      }
      if (length > stat.size) throw new SourceError(length > limit ? 'large' : 'unreadable', file);
      return buffer.subarray(0, length);
    } finally { closeSync(fd); }
  });
}

function readFileResult(root: string, file: string, limit: number, mode?: number): { bytes: Buffer } | { missing: true } | { refused: SourceIssue } {
  try { return { bytes: sourceBytes(root, file, limit, mode) }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { missing: true };
    return { refused: error instanceof SourceError ? error.issue : 'unreadable' };
  }
}

function readAsOwner(root: string, file: string, limit: number, mode?: number): ReturnType<typeof readFileResult> {
  let identity;
  try { identity = workbenchIdentity(root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { missing: true };
    throw error;
  }
  if (identity.uid === undefined) return readFileResult(root, file, limit, mode);
  const child = spawnSync(process.execPath, [import.meta.filename, root, file, String(limit), String(mode ?? '')], {
    ...identity, cwd: '/', env: {}, timeout: 30_000, maxBuffer: limit + 4096,
  });
  if (!child.error && child.status === 0) return { bytes: child.stdout };
  if (!child.error && child.status === 3) return { missing: true };
  const code = child.stderr?.toString();
  return { refused: code && Object.hasOwn(issues, code) ? code as SourceIssue : 'unreadable' };
}

export function sourceText(root: string, file: string, limit: number, mode?: number): { text: string } | { missing: true } | { refused: SourceIssue } {
  const result = readAsOwner(root, file, limit, mode);
  return 'bytes' in result ? { text: result.bytes.toString('utf8') } : result;
}

export function optionalSourceBytes(root: string, file: string, limit: number): Buffer | null {
  const result = readAsOwner(root, file, limit);
  if ('refused' in result) throw new SourceError(result.refused, file);
  return 'bytes' in result ? result.bytes : null;
}

export function optionalSourceText(root: string, file: string, limit: number): string | null {
  return optionalSourceBytes(root, file, limit)?.toString('utf8') ?? null;
}

/** An optional custom env under the workbench account can select only data owned by that account. */
export function operatorEnv(file: string): { text: string | null; owner?: number } {
  const path = resolve(file), parent = dirname(path);
  const text = optionalSourceText(parent, path, 1024 * 1024);
  const identity = text === null ? {} : workbenchIdentity(parent);
  return { text, ...(identity.uid === undefined ? {} : { owner: identity.uid }) };
}

export const sourceWorkerImport = 'import { withDatabasePath, sourceBytes } from ' + JSON.stringify(import.meta.url) + ';\n';

if (import.meta.main) {
  const [, , root, file, limit, mode] = process.argv;
  const result = readFileResult(root!, file!, Number(limit), mode ? Number(mode) : undefined);
  if ('bytes' in result) process.stdout.write(result.bytes);
  else if ('missing' in result) process.exitCode = 3;
  else { process.stderr.write(result.refused); process.exitCode = 1; }
}
