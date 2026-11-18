import { closeSync, constants, fstatSync, openSync, readSync, type Stats } from 'node:fs';

/** Reads at most `limit` bytes of a plain file without following a link; null when it is not there. */
export function readBounded(path: string, limit: number, check?: (stat: Stats) => void): string | null {
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
