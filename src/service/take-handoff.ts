import { randomUUID } from 'node:crypto';
import { lstatSync, renameSync, unlinkSync } from 'node:fs';
import { readBounded } from './handoff-file.ts';

/** Refuse root-owned hand-off targets when running as root so child writes always drop privileges. */
export function assertNonRootOwner(owner: { uid: number }, label: string, currentUid = process.getuid?.()): void {
  if (currentUid === 0 && owner.uid === 0) throw new Error(`${label} 的属主不能是 root`);
}

/** Claim one name before reading it. A newer request at the watched path belongs to the next run. */
export function takeHandoff(path: string, maxBytes: number, uid: number): string | null {
  const claimed = `${path}.taken-${randomUUID()}`;
  try { renameSync(path, claimed); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    return readBounded(claimed, maxBytes, stat => {
      if (stat.uid !== uid) throw new Error('请求文件不属于服务账户');
      if (stat.nlink !== 1) throw new Error('请求文件有多个硬链接');
    });
  } finally {
    // A directory in the queue is invalid. Leave its contents in quarantine and free the watched name.
    try { if (!lstatSync(claimed).isDirectory()) unlinkSync(claimed); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
