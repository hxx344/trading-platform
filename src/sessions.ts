// Page sessions: one per login (the access-url link or the password), each with its own cookie, so one browser can be
// logged out without the others and a copied cookie stops working when its session is removed. A session ends 30 days
// after its login (SESSION_LIFETIME_MS) or after SESSION_IDLE_MS without a request, checked on every request.
//
// The service keeps them in <data dir>/http-session (0600), so a restart leaves open pages logged in. The file holds only
// digests of the cookie values. It is bound to the login password: a session made under another password (or before
// one was set) is dropped on load, so `install.sh --set-password` logs every browser out even if the running service
// rewrites the file after the installer removed it. A file in the old single-session format (one cookie value, v0.74
// and earlier) is taken over as one session; an older release finds the new format malformed and replaces it, which
// only logs the browser out.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** A session ends this long after its login; also the cookie's Max-Age. */
export const SESSION_LIFETIME_MS = 30 * 24 * 3_600_000;
/** A session with no request for this long ends. */
export const SESSION_IDLE_MS = 7 * 24 * 3_600_000;
/** Beyond this the session least recently used is dropped. */
export const MAX_SESSIONS = 32;
/** Last use is written to the file at most this often per session (it only matters to the idle limit). */
const SEEN_WRITE_MS = 3_600_000;
const FILE_VERSION = 1;
const LEGACY = /^[A-Za-z0-9_-]{43}$/;

export interface SessionInfo {
  /** The executor's session id: a digest of the cookie value, the same one older releases derived. */
  id: string;
  createdAt: number;
  seenAt: number;
  expiresAt: number;
}

interface Entry { executorId: string; createdAt: number; seenAt: number; writtenSeenAt: number }

export interface SessionStore {
  /** A new session; its cookie value. */
  create(): string;
  /** The live session for a cookie value, its last use updated; null when there is none or it ended. */
  check(token: string): SessionInfo | null;
  /** Ends one session; false when it was not there. */
  remove(token: string): boolean;
  /** Ends every session; how many there were. */
  removeAll(): number;
  count(): number;
  /** The cookie's Max-Age in seconds; undefined for a store that does not outlive the process (a browser-session cookie). */
  readonly maxAgeS: number | undefined;
}

const digest = (token: string) => createHash('sha256').update(`page-session:${token}`).digest('base64url');
export const executorSessionId = (token: string) => createHash('sha256').update(`executor-session:${token}`).digest('base64url');
/** What binds the stored sessions to the login password (its digest, or no password). */
export const sessionEpoch = (password: { salt: Buffer; key: Buffer } | undefined) =>
  createHash('sha256').update('session-epoch:').update(password ? Buffer.concat([password.salt, password.key]) : Buffer.from('none')).digest('base64url');

export interface SessionStoreOptions {
  /** The file to keep them in; without it they live only as long as the process. */
  file?: string;
  /** sessionEpoch() of the password in effect; required with a file. */
  epoch?: string;
  /** Cookie values that are sessions from the start (tests, and a process without a file); they never expire. */
  seed?: readonly string[];
  now?: () => number;
  log?: (line: string) => void;
  /** Writes the new file's text to a temporary path (tests make it fail). */
  writeTemp?: (path: string, text: string) => void;
}

export function openSessionStore({ file, epoch = '', seed = [], now = Date.now, log = line => process.stderr.write(`${line}\n`),
  writeTemp = (path, text) => writeFileSync(path, text, { mode: 0o600, flag: 'wx' }) }: SessionStoreOptions = {}): SessionStore {
  const sessions = new Map<string, Entry>();
  const permanent = new Set<string>();
  for (const token of seed) {
    const key = digest(token);
    permanent.add(key);
    sessions.set(key, { executorId: executorSessionId(token), createdAt: now(), seenAt: now(), writtenSeenAt: now() });
  }
  let dirty = false;
  if (file) dirty = load(file);

  function load(path: string): boolean {
    let text: string;
    try { text = readFileSync(path, 'utf8'); } catch { return false; }
    const legacy = text.trim();
    if (LEGACY.test(legacy)) {
      // v0.74 and earlier: one cookie value, as old as the file. Kept while within its 30 days, under the current password
      // (install.sh removed the file when it set one).
      let mtime = 0;
      try { mtime = statSync(path).mtimeMs; } catch { /* treated as expired */ }
      if (now() - mtime < SESSION_LIFETIME_MS) sessions.set(digest(legacy), { executorId: executorSessionId(legacy), createdAt: mtime, seenAt: now(), writtenSeenAt: 0 });
      return true;
    }
    try {
      const data = JSON.parse(text) as { version?: unknown; epoch?: unknown; sessions?: unknown };
      if (data.version !== FILE_VERSION || data.epoch !== epoch || !Array.isArray(data.sessions)) return true;
      for (const item of data.sessions.slice(0, MAX_SESSIONS) as Record<string, unknown>[]) {
        if (typeof item?.key !== 'string' || typeof item.executorId !== 'string' || typeof item.createdAt !== 'number' || typeof item.seenAt !== 'number') continue;
        sessions.set(item.key, { executorId: item.executorId, createdAt: item.createdAt, seenAt: item.seenAt, writtenSeenAt: item.seenAt });
      }
      return false;
    } catch { return true; }
  }

  /** `ending`: the write drops sessions (logout, expiry); if it fails the file goes, so a restart cannot bring them back. */
  function save(ending = false): void {
    dirty = false;
    if (!file) return;
    const rows = [...sessions].filter(([key]) => !permanent.has(key)).map(([key, entry]) => {
      entry.writtenSeenAt = entry.seenAt;
      return { key, executorId: entry.executorId, createdAt: entry.createdAt, seenAt: entry.seenAt };
    });
    const temp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    try {
      writeTemp(temp, `${JSON.stringify({ version: FILE_VERSION, epoch, sessions: rows })}\n`);
      renameSync(temp, file);
    } catch (error) {
      try { rmSync(temp, { force: true }); } catch { /* nothing more to do */ }
      const reason = error instanceof Error ? error.message.slice(0, 160) : String(error);
      if (!ending) { log(`页面会话文件写入失败：${reason}`); return; }
      // The file still lists the ended sessions: without it a restart logs every browser out instead of reviving them.
      try { rmSync(file, { force: true }); log(`页面会话文件写入失败，已删除该文件（下次重启后需重新登录）：${reason}`); }
      catch { log(`页面会话文件写入失败且无法删除，重启前请手动删除 ${basename(file)}：${reason}`); }
    }
  }

  const expiresAt = (entry: Entry) => Math.min(entry.createdAt + SESSION_LIFETIME_MS, entry.seenAt + SESSION_IDLE_MS);
  function prune(): void {
    const at = now();
    for (const [key, entry] of sessions) if (!permanent.has(key) && at >= expiresAt(entry)) { sessions.delete(key); dirty = true; }
  }
  prune();
  if (dirty) save(true);

  return {
    maxAgeS: file ? SESSION_LIFETIME_MS / 1000 : undefined,
    create(): string {
      prune();
      const token = randomBytes(32).toString('base64url');
      const at = now();
      sessions.set(digest(token), { executorId: executorSessionId(token), createdAt: at, seenAt: at, writtenSeenAt: at });
      // Oldest use first among the ones that can go.
      const removable = [...sessions].filter(([key]) => !permanent.has(key)).sort((a, b) => a[1].seenAt - b[1].seenAt);
      while (removable.length > MAX_SESSIONS) sessions.delete(removable.shift()![0]);
      save();
      return token;
    },
    check(token: string): SessionInfo | null {
      if (!token || token.length > 200) return null;
      const key = digest(token), entry = sessions.get(key);
      if (!entry) return null;
      const at = now();
      if (!permanent.has(key)) {
        if (at >= expiresAt(entry)) { sessions.delete(key); save(true); return null; }
        entry.seenAt = at;
        if (at - entry.writtenSeenAt >= SEEN_WRITE_MS) save();
      }
      return { id: entry.executorId, createdAt: entry.createdAt, seenAt: entry.seenAt, expiresAt: permanent.has(key) ? Number.MAX_SAFE_INTEGER : expiresAt(entry) };
    },
    remove(token: string): boolean {
      const key = digest(token);
      if (!sessions.delete(key)) return false;
      permanent.delete(key);
      save(true);
      return true;
    },
    removeAll(): number {
      const count = sessions.size;
      sessions.clear(); permanent.clear();
      save(true);
      return count;
    },
    count: () => sessions.size,
  };
}
