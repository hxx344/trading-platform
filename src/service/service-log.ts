// The service's own log lines, kept for the page's 日志 tab. Everything the service writes to stdout and stderr (which
// systemd puts in the journal) is copied here line by line, so the page shows the same text as `journalctl -u trading-platform`
// without a shell on the server. The journal stays the complete record: this copy keeps 14 days and at most 50000
// lines, and drops lines past 1200 a minute (noted once the minute is over).
import { DatabaseSync } from 'node:sqlite';

export const LOG_RETENTION_MS = 14 * 86_400_000;
const MAX_ROWS = 50_000;
const MAX_LINE = 2_000;
const MAX_PER_MINUTE = 1_200;
const MAX_PARTIAL = 8_192;
const PAGE_MAX = 200;
const PRUNE_EVERY_MS = 10 * 60_000;

export type LogLevel = 'alert' | 'problem' | 'info';
export interface LogRow { id: string; at: number; level: LogLevel; text: string }
export type LogFilter = 'all' | 'problems';

/** Alerts are the lines the robot also sends; problems are failures, refusals and disconnects worth a look. */
export function logLevel(text: string): LogLevel {
  if (text.startsWith('告警：')) return 'alert';
  return /失败|出错|错误|异常|无法|拒绝|超时|断开|过期|受阻|不一致|未知/.test(text) ? 'problem' : 'info';
}

export function createServiceLog({ file, now = Date.now }: { file: string; now?: () => number }) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 2000;
    CREATE TABLE IF NOT EXISTS lines (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, level TEXT NOT NULL, text TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS lines_level ON lines (level, id);`);
  const insert = db.prepare('INSERT INTO lines (at, level, text) VALUES (?, ?, ?)');
  let minute = Math.floor(now() / 60_000), written = 0, dropped = 0, prunedAt = 0;
  // Unfinished lines, one per source, so a half line on stdout never joins a line on stderr.
  const partials = new Map<string, string>();

  const write = (text: string, at: number) => { insert.run(at, logLevel(text), text); };
  function append(raw: string): void {
    const at = now();
    const current = Math.floor(at / 60_000);
    if (current !== minute) {
      if (dropped) write(`日志过多：上一分钟有 ${dropped} 行未写入页面日志（服务日志 journalctl 里完整）`, at);
      minute = current; written = 0; dropped = 0;
    }
    // Control characters (escape sequences included) are not shown; tabs become spaces.
    const text = raw.replace(/[\x00-\x1f\x7f]+/g, ' ').trimEnd().slice(0, MAX_LINE);
    if (!text.trim()) return;
    if (written >= MAX_PER_MINUTE) { dropped += 1; return; }
    written += 1;
    write(text, at);
    if (at - prunedAt >= PRUNE_EVERY_MS) prune();
  }
  function prune(): void {
    prunedAt = now();
    db.prepare('DELETE FROM lines WHERE at < ?').run(prunedAt - LOG_RETENTION_MS);
    db.prepare('DELETE FROM lines WHERE id <= (SELECT MAX(id) FROM lines) - ?').run(MAX_ROWS);
  }

  return {
    append,
    /** Text written to a stream in pieces: whole lines are kept, the rest waits for its newline (bounded, per source). */
    take(chunk: string, source = ''): void {
      const lines = ((partials.get(source) ?? '') + chunk).split('\n');
      let rest = lines.pop() ?? '';
      if (rest.length > MAX_PARTIAL) { lines.push(rest); rest = ''; }
      if (rest) partials.set(source, rest); else partials.delete(source);
      for (const line of lines) append(line);
    },
    /** Newest first; `before` is the id the previous page ended with. */
    page({ filter = 'all', before = null, limit = 100 }: { filter?: LogFilter; before?: number | null; limit?: number }): { items: LogRow[]; next: string | null } {
      const size = Math.max(1, Math.min(PAGE_MAX, Math.floor(limit)));
      const where = [...(before === null ? [] : ['id < ?']), ...(filter === 'problems' ? ["level IN ('alert', 'problem')"] : [])];
      const rows = db.prepare(`SELECT id, at, level, text FROM lines ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`)
        .all(...(before === null ? [] : [before]), size + 1) as { id: number; at: number; level: LogLevel; text: string }[];
      const items = rows.slice(0, size).map(row => ({ id: String(row.id), at: row.at, level: row.level, text: row.text }));
      return { items, next: rows.length > size ? items.at(-1)!.id : null };
    },
    prune,
    close(): void { for (const rest of partials.values()) append(rest); partials.clear(); db.close(); },
  };
}
export type ServiceLog = ReturnType<typeof createServiceLog>;

/**
 * Copies what is written to `stream` into `log` as well; returns the undo. A failure to store a line never affects the
 * write itself. Undo only restores the original when no one replaced the write function since.
 */
export function teeStream(stream: NodeJS.WriteStream, log: ServiceLog): () => void {
  const original = stream.write;
  const source = String((stream as { fd?: number }).fd ?? '');
  const tee = function (this: NodeJS.WriteStream, chunk: unknown, ...rest: unknown[]): boolean {
    try { log.take(typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) || chunk instanceof Uint8Array ? Buffer.from(chunk).toString('utf8') : '', source); }
    catch { /* the journal still has the line */ }
    return (original as (...args: unknown[]) => boolean).call(this, chunk, ...rest);
  } as typeof stream.write;
  stream.write = tee;
  return () => { if (stream.write === tee) stream.write = original; };
}
