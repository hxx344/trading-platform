// The executor data directory: the dedicated-directory check, the login link, the environment marker and the database
// names, shared by the entries (main.ts, service/main.ts) and the workbench-driven live canary (live/canary.ts).
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Environment } from './contracts.ts';

const ENVIRONMENT_MARKER = 'environment';
/**
 * The live database has its own name, so code that predates the marker (a rollback) opens an empty database in a live
 * directory instead of reconciling real jobs against simulated venues.
 */
export const DATABASE_FILES: Readonly<Record<Environment, string>> = { simulated: 'executor.sqlite', mainnet: 'executor-live.sqlite' };
/**
 * Binds the data directory to one environment for good: jobs, accounts and ledgers of simulated venues must never be read
 * as real ones, nor the other way round. A directory used before the marker existed ran simulated venues only.
 */
export function claimDataDirEnvironment(dir: string, environment: Environment): void {
  const marker = join(dir, ENVIRONMENT_MARKER);
  let recorded: string | null = null;
  try { recorded = readFileSync(marker, 'utf8').trim(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`数据目录环境标记无法读取：${(error as Error).message}`); }
  // Without a marker the database file tells: one predating the marker, or a marker lost in a crash before it reached disk.
  const current = recorded ?? (existsSync(join(dir, DATABASE_FILES.mainnet)) ? 'mainnet' : existsSync(join(dir, DATABASE_FILES.simulated)) ? 'simulated' : null);
  if (current !== null && current !== environment) throw new Error(`数据目录已用于${current === 'mainnet' ? '实盘' : current === 'simulated' ? '模拟' : `未知环境（${current.slice(0, 32)}）`}，不能以${environment === 'mainnet' ? '实盘' : '模拟'}模式启动；请另用一个数据目录`);
  if (recorded !== null) return;
  let fd: number;
  try { fd = openSync(marker, 'wx', 0o600); }
  catch (error) {
    // Another start wrote it first: judge again by what it wrote.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return claimDataDirEnvironment(dir, environment);
    throw new Error(`数据目录环境标记无法写入：${(error as Error).message}`);
  }
  try { writeSync(fd, `${environment}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  const dirFd = openSync(dir, 'r');
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
}

const LEGACY_MARKERS = ['hub.sqlite', 'execution-control.sqlite', 'credentials.key', 'modules'];

/**
 * The directory and every ancestor are checked after resolving links, so neither a
 * subdirectory of the workbench data directory nor a link into it is accepted.
 * Names compare case-insensitively because Windows and macOS file systems do.
 */
export function assertDedicatedDataDir(dir: string): string {
  if (!isAbsolute(dir)) throw new Error('--data-dir 必须是绝对路径');
  const path = resolve(dir);
  let existing = path;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  for (let current = realpathSync.native(existing); ; current = dirname(current)) {
    let names: string[] = [];
    try { names = readdirSync(current); } catch { /* an unreadable ancestor cannot be the workbench data directory of this user */ }
    const found = names.find(name => LEGACY_MARKERS.includes(name.toLowerCase()));
    if (found) throw new Error(`拒绝使用工作台数据目录（${current} 含 ${found}）；执行器必须使用独立数据目录，且不能位于工作台代码或数据目录之下`);
    if (dirname(current) === current) break;
  }
  return path;
}

/** How long a kept page session lasts: the cookie's Max-Age, and the age at which the file is replaced. */
export const SESSION_LIFETIME_MS = 30 * 24 * 3600 * 1000;

/**
 * The page session kept in <dir>/http-session, so a restart (an upgrade, the page's own import) does not log the open
 * page out. Made once, private to the data directory's account; an unreadable or malformed one is replaced, which only
 * logs the browser out.
 */
export function keptSession(dir: string, now = Date.now()): string {
  const path = join(dir, 'http-session');
  try {
    const value = readFileSync(path, 'utf8').trim();
    // Replaced after the cookie's own 30 days, so a copied cookie stops working on the first start after that.
    if (/^[A-Za-z0-9_-]{43}$/.test(value) && now - statSync(path).mtimeMs < SESSION_LIFETIME_MS) return value;
  } catch { /* missing or unreadable: replaced below; a path that cannot be replaced fails there */ }
  const value = randomBytes(32).toString('base64url');
  const temp = join(dir, `.http-session.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    writeFileSync(temp, `${value}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temp, path);
  } catch (error) { rmSync(temp, { force: true }); throw error; }
  return value;
}

/**
 * Writes the login link to <dir>/access-url and returns that path. The token never
 * reaches stdout or logs; whoever can read the data directory can log in. The
 * temporary file plus rename keeps a reader from seeing a half-written link.
 */
export function writeAccessUrl(dir: string, port: number, token: string): string {
  const target = join(dir, 'access-url');
  const temp = join(dir, `.access-url.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    writeFileSync(temp, `http://127.0.0.1:${port}/login?token=${token}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temp, target);
  } catch (error) { rmSync(temp, { force: true }); throw error; }
  return target;
}
