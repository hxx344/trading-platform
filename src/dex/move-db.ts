// 在执行面数据目录与 DEX 状态目录之间复制 varlighter.sqlite（docs/dexspread.md 11.5）。安装器以 root 运行，但不按路径碰这两个
// 服务账户可写目录里的任何文件（L201）：本工具总以目录属主身份运行（runuser），root 只把 export 的标准输出接到 import 的标准输入。
//   export --dir <源目录>：在源目录里做一份单文件的在线备份并核对，标准输出先写一行头（JSON），再写库的字节。
//   import --dir <目标目录>：读头与字节到目标目录的临时文件，核对字节数、摘要与各表行数，再把原有的库与旁路文件改名为备份，
//     最后把临时文件改名为 varlighter.sqlite。源端没有库时，目标处原有的库也改名为备份（以源端为准）。
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, openSync, readdirSync, readSync, renameSync, rmSync, statfsSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';

export const DB_FILE = 'varlighter.sqlite';
const SIDE_FILES = ['', '-wal', '-shm', '-journal'];
export const KEEP_BACKUPS = 3;
const CHUNK = 1 << 20;

export interface Header { missing: boolean; bytes: number; sha256: string; counts: Record<string, number> }

/** 打开一个已有文件：不跟随符号链接，必须是普通文件、只有一个链接、属于当前账户。不存在返回 null。 */
function openOwned(path: string, flags: number): number | null {
  let fd: number;
  try { fd = openSync(path, flags | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error(`${path} 无法安全打开：${(error as Error).message}`); }
  const stat = fstatSync(fd);
  const uid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid) { closeSync(fd); throw new Error(`${path} 不是本账户独有的普通文件，已拒绝`); }
  return fd;
}

/** 库里每张表的行数（按名字排序），两端用它核对复制结果。 */
export function tableCounts(db: DatabaseSync): Record<string, number> {
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(row => row.name);
  return Object.fromEntries(names.map(name => [name, Number((db.prepare(`SELECT COUNT(*) AS n FROM "${name.replaceAll('"', '""')}"`).get() as { n: number | bigint }).n)]));
}

/** 目录所在文件系统的可用空间至少是 need 字节的两倍（临时副本加上保留的备份），否则拒绝。 */
export function ensureSpace(dir: string, need: number): void {
  if (process.platform === 'win32') return;
  const { bavail, bsize } = statfsSync(dir);
  const free = Number(bavail) * Number(bsize);
  if (free < 2 * need) throw new Error(`${dir} 可用空间 ${Math.floor(free / 1048576)} MB，不足库大小的两倍（${Math.ceil(2 * need / 1048576)} MB）`);
}

function check(db: DatabaseSync): void {
  const rows = db.prepare('PRAGMA quick_check').all() as { quick_check: string }[];
  if (rows.length !== 1 || rows[0]!.quick_check !== 'ok') throw new Error('库的完整性检查没有通过');
}

const temporary = (dir: string) => join(dir, `.${DB_FILE}.${randomBytes(6).toString('hex')}.tmp`);

/** 源账户身份：返回要写到标准输出的头和临时文件（调用方写完后删除）。 */
export function exportDb(dir: string): { header: Header; file: string | null } {
  const main = join(dir, DB_FILE);
  // 主文件与旁路文件都先核对一遍：本账户放的链接或共享 inode 不跟随。
  const fds = SIDE_FILES.map(suffix => openOwned(main + suffix, constants.O_RDONLY));
  const size = fds.reduce<number>((sum, fd) => sum + (fd === null ? 0 : fstatSync(fd).size), 0);
  for (const fd of fds) if (fd !== null) closeSync(fd);
  if (fds[0] === null) return { header: { missing: true, bytes: 0, sha256: '', counts: {} }, file: null };
  ensureSpace(dir, size);
  const out = temporary(dir);
  // 按 L063：以真实 WAL 打开（不用 immutable），在线备份会带上 WAL 里还没回写的页。
  const source = new DatabaseSync(main);
  try {
    // 安装器复制前已停掉 DEX；这里再拿独占锁（不等待），万一还有别的连接就直接失败，WAL 回写也在锁内完成。
    source.exec('PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT');
    check(source);
    source.prepare('VACUUM INTO ?').run(out);
  } finally { source.close(); }
  try {
    const copy = new DatabaseSync(out);
    let counts: Record<string, number>;
    try { copy.exec('PRAGMA journal_mode=DELETE'); check(copy); counts = tableCounts(copy); } finally { copy.close(); }
    const fd = openOwned(out, constants.O_RDONLY)!;
    const hash = createHash('sha256'), buffer = Buffer.alloc(CHUNK);
    let bytes = 0, n: number;
    try { while ((n = readSync(fd, buffer, 0, CHUNK, null)) > 0) { hash.update(buffer.subarray(0, n)); bytes += n; } } finally { closeSync(fd); }
    return { header: { missing: false, bytes, sha256: hash.digest('hex'), counts }, file: out };
  } catch (error) { rmSync(out, { force: true }); throw error; }
}

function writeAll(fd: number, data: Buffer): void {
  for (let offset = 0; offset < data.length;) offset += writeSync(fd, data, offset, data.length - offset);
}

/** 把一个文件写到标准输出（同步，管道满时等待）。 */
function streamFile(file: string, out: number): void {
  const fd = openOwned(file, constants.O_RDONLY)!;
  const buffer = Buffer.alloc(CHUNK);
  try {
    let n: number;
    while ((n = readSync(fd, buffer, 0, CHUNK, null)) > 0) {
      for (let offset = 0; offset < n;) {
        try { offset += writeSync(out, buffer, offset, n - offset); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error; }
      }
    }
  } finally { closeSync(fd); }
}

/** 从输入读到第一个换行（头），返回头和已经多读到的字节。 */
function readHeader(input: number): { header: Header; rest: Buffer } {
  const chunks: Buffer[] = []; const buffer = Buffer.alloc(64 * 1024);
  let total = 0;
  for (;;) {
    let n: number;
    try { n = readSync(input, buffer, 0, buffer.length, null); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EAGAIN') continue; throw error; }
    if (n === 0) throw new Error('输入在头之前就结束了');
    chunks.push(Buffer.from(buffer.subarray(0, n))); total += n;
    const all = Buffer.concat(chunks, total), end = all.indexOf(10);
    if (end >= 0) {
      const value = JSON.parse(all.subarray(0, end).toString('utf8')) as Header;
      if (typeof value?.missing !== 'boolean' || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || typeof value.sha256 !== 'string' || !value.counts || typeof value.counts !== 'object') throw new Error('头格式无效');
      return { header: value, rest: all.subarray(end + 1) };
    }
    if (total > 1 << 20) throw new Error('头过长');
  }
}

/** 目标处原有的库与旁路文件改名为带时间戳的备份；只保留最近 KEEP_BACKUPS 份。 */
export function backupExisting(dir: string, stamp: string): string[] {
  const moved: string[] = [];
  for (const suffix of SIDE_FILES) {
    const from = join(dir, DB_FILE + suffix);
    const fd = openOwned(from, constants.O_RDONLY);
    if (fd === null) continue;
    closeSync(fd);
    const to = join(dir, `${DB_FILE}.bak-${stamp}${suffix}`);
    renameSync(from, to);
    moved.push(to);
  }
  const stamps = [...new Set(readdirSync(dir).map(name => /^varlighter\.sqlite\.bak-(\d{8}T\d{6}Z)(?:-wal|-shm|-journal)?$/.exec(name)?.[1]).filter((value): value is string => !!value))].sort().reverse();
  for (const old of stamps.slice(KEEP_BACKUPS)) for (const suffix of SIDE_FILES) rmSync(join(dir, `${DB_FILE}.bak-${old}${suffix}`), { force: true });
  return moved;
}

const fsyncDir = (dir: string) => { const fd = openSync(dir, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); } };

/** 目标账户身份：读输入、核对、替换。返回目标处的结果说明。 */
export function importDb(dir: string, input: number, stamp: string): string {
  const { header, rest } = readHeader(input);
  if (header.missing) {
    const moved = backupExisting(dir, stamp);
    fsyncDir(dir);
    return moved.length ? `源端没有库，目标处原有的库已改名为备份（${moved.length} 个文件）` : '源端没有库，目标处也没有';
  }
  ensureSpace(dir, header.bytes);
  const out = temporary(dir);
  const fd = openSync(out, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const hash = createHash('sha256'); let bytes = 0;
    const take = (data: Buffer) => { if (bytes + data.length > header.bytes) throw new Error('输入比头里写的长'); hash.update(data); writeAll(fd, data); bytes += data.length; };
    take(rest);
    const buffer = Buffer.alloc(CHUNK);
    for (;;) {
      let n: number;
      try { n = readSync(input, buffer, 0, CHUNK, null); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EAGAIN') continue; throw error; }
      if (n === 0) break;
      take(buffer.subarray(0, n));
    }
    if (bytes !== header.bytes || hash.digest('hex') !== header.sha256) throw new Error('收到的库与源端不一致（字节数或摘要）');
    fsyncSync(fd);
  } catch (error) { closeSync(fd); rmSync(out, { force: true }); throw error; }
  closeSync(fd);
  try {
    const copy = new DatabaseSync(out);
    try {
      check(copy);
      if (JSON.stringify(tableCounts(copy)) !== JSON.stringify(header.counts)) throw new Error('各表行数与源端不一致');
    } finally { copy.close(); }
    backupExisting(dir, stamp);
    renameSync(out, join(dir, DB_FILE));
    fsyncDir(dir);
  } catch (error) { rmSync(out, { force: true }); throw error; }
  const rows = Object.values(header.counts).reduce((sum, n) => sum + n, 0);
  return `已复制 ${header.bytes} 字节、${rows} 行`;
}

const stampOf = (at: Date) => at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

if (import.meta.main) {
  try {
    const { positionals, values } = parseArgs({ allowPositionals: true, options: { dir: { type: 'string' } } });
    const dir = values.dir;
    if (!dir || !dir.startsWith('/') && process.platform !== 'win32') throw new Error('需要绝对路径 --dir');
    if (positionals[0] === 'export' && positionals.length === 1) {
      const { header, file } = exportDb(dir);
      try {
        writeAll(1, Buffer.from(JSON.stringify(header) + '\n'));
        if (file) streamFile(file, 1);
      } finally { if (file) rmSync(file, { force: true }); }
    } else if (positionals[0] === 'import' && positionals.length === 1) {
      process.stderr.write(importDb(dir, 0, stampOf(new Date())) + '\n');
    } else throw new Error('用法：move-db.ts export|import --dir <目录>');
  } catch (error) {
    process.stderr.write(`复制 DEX 价差库失败：${error instanceof Error ? error.message.slice(0, 300) : String(error)}\n`);
    process.exitCode = 1;
  }
}
