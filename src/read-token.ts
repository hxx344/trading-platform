// The read-only API token (docs/mcp.md 2 and 3): one token at a time, made and revoked only from the logged-in page.
// <data dir>/read-token.json keeps its digest (never the token), the key its aliases are made with, its dates, the
// request counts the page shows, which expiry reminders went out and the aliases handed out (for the page's lookup).
// Deleting the file and restarting the service revokes the token as well.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRedactor, type Redactor } from './read-redact.ts';
import type { UpdateView } from './service/update-types.ts';

export const READ_TOKEN_FILE = 'read-token.json';
export const READ_TOKEN_TTL_MS = 90 * 86_400_000;
/** The page and the sidebar warn from this long before expiry; the robot sends at 7 days and at 1 day. */
export const READ_TOKEN_WARN_MS = 7 * 86_400_000;
const REMINDERS = [{ key: '7d', beforeMs: 7 * 86_400_000 }, { key: '1d', beforeMs: 86_400_000 }] as const;
export const READ_TOKEN_PER_MINUTE = 30;
export const READ_TOKEN_CONCURRENT = 2;
/** A token answer larger than this is refused with 413 rather than cut, so the caller narrows the query. */
export const READ_TOKEN_MAX_BYTES = 512 * 1024;
export const READ_TOKEN_PATTERN = /^tpr_[A-Za-z0-9_-]{43}$/;
const HOUR_MS = 3_600_000;
const FLUSH_MS = 60_000;
const MAX_ALIASES = 5_000;

interface Stored {
  version: 1; id: string; digest: string; redactKey: string; createdAt: number; expiresAt: number;
  lastUsedAt: number | null; hours: [number, number][]; reminded: string[]; aliases: [string, string][];
}

export interface ReadTokenView {
  state: 'none' | 'active' | 'expired';
  id: string | null; createdAt: number | null; expiresAt: number | null; lastUsedAt: number | null;
  /** Requests in the last 24 hours (whole hours), rejected ones included. */
  requests24h: number;
  /** Active and within READ_TOKEN_WARN_MS of expiry, or expired: the page and the sidebar show a notice. */
  warn: boolean;
  error: string | null;
}

const digestOf = (token: string): Buffer => createHash('sha256').update(token).digest();

function parse(raw: unknown): Stored {
  const value = raw as Partial<Stored> | null;
  const ok = value !== null && typeof value === 'object' && value.version === 1
    && typeof value.id === 'string' && /^[0-9a-f]{8}$/.test(value.id) && typeof value.digest === 'string' && /^[0-9a-f]{64}$/.test(value.digest)
    && typeof value.redactKey === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value.redactKey)
    && Number.isSafeInteger(value.createdAt) && Number.isSafeInteger(value.expiresAt)
    && (value.lastUsedAt === null || Number.isSafeInteger(value.lastUsedAt))
    && Array.isArray(value.hours) && value.hours.every(row => Array.isArray(row) && row.length === 2 && row.every(Number.isSafeInteger))
    && Array.isArray(value.reminded) && value.reminded.every(key => typeof key === 'string')
    && Array.isArray(value.aliases) && value.aliases.every(row => Array.isArray(row) && row.length === 2 && row.every(part => typeof part === 'string'));
  if (!ok) throw new Error('read-token.json 格式无效');
  return value as Stored;
}

export interface ReadTokens {
  view(): ReadTokenView;
  /** Replaces any token; the plain token is returned once and never stored. */
  generate(): { token: string; view: ReadTokenView };
  revoke(): ReadTokenView;
  /** The token's id when it matches the stored digest and has not expired. */
  check(token: string): { ok: true; id: string } | { ok: false; reason: 'none' | 'invalid' | 'expired' };
  /** A slot under the per-minute and concurrent limits, or null; release it when the answer is done. */
  admit(): (() => void) | null;
  /** Counts one request (rejected ones too) for the page's statistics. */
  record(): void;
  /** The masking of the current token's answers; null without a token. */
  redactor(): Redactor | null;
  /** The original behind an alias handed out with the current token. */
  lookup(alias: string): string | null;
  /**
   * Expiry reminders now due, each returned once (kept across restarts). With `send`, each is passed to it first and
   * marked only once it returned: a send that throws leaves the reminder due for the next call.
   */
  dueReminders(send?: (text: string) => void): string[];
  flush(): void;
}

export function createReadTokens({ dir, now = Date.now, log = line => process.stderr.write(`${line}\n`) }: { dir: string; now?: () => number; log?: (line: string) => void }): ReadTokens {
  const file = join(dir, READ_TOKEN_FILE);
  let stored: Stored | null = null;
  let loadError: string | null = null;
  try { stored = parse(JSON.parse(readFileSync(file, 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // An unreadable file accepts no token; the page shows why and generating a new one replaces it.
      loadError = error instanceof Error ? error.message : String(error);
      log(`只读接口令牌文件无法读取，令牌已停用：${loadError}`);
    }
  }
  const aliases = new Map<string, string>(stored?.aliases ?? []);
  let redact: Redactor | null = null;
  let dirty = false, flushedAt = 0;
  const recent: number[] = [];
  let running = 0;

  const write = (value: Stored | null) => {
    if (value === null) { rmSync(file, { force: true }); return; }
    const temp = join(dir, `.read-token.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    try {
      writeFileSync(temp, `${JSON.stringify({ ...value, aliases: [...aliases] })}\n`, { mode: 0o600, flag: 'wx' });
      renameSync(temp, file);
    } catch (error) { rmSync(temp, { force: true }); throw error; }
  };
  const flush = () => {
    if (!dirty || !stored) return;
    dirty = false; flushedAt = now();
    try { write(stored); } catch (error) { log(`只读接口令牌统计写入失败：${error instanceof Error ? error.message : String(error)}`); }
  };
  const touch = () => { dirty = true; if (now() - flushedAt >= FLUSH_MS) flush(); };
  const makeRedactor = () => {
    if (!stored) return null;
    return createRedactor(Buffer.from(stored.redactKey, 'base64url'), (alias, original) => {
      if (aliases.get(alias) === original) return;
      aliases.delete(alias);
      aliases.set(alias, original);
      while (aliases.size > MAX_ALIASES) aliases.delete(aliases.keys().next().value!);
      touch();
    });
  };
  redact = makeRedactor();

  const view = (): ReadTokenView => {
    if (!stored) return { state: 'none', id: null, createdAt: null, expiresAt: null, lastUsedAt: null, requests24h: 0, warn: false, error: loadError };
    const at = now(), since = Math.floor(at / HOUR_MS) * HOUR_MS - 23 * HOUR_MS;
    const expired = at >= stored.expiresAt;
    return {
      state: expired ? 'expired' : 'active', id: stored.id, createdAt: stored.createdAt, expiresAt: stored.expiresAt, lastUsedAt: stored.lastUsedAt,
      requests24h: stored.hours.filter(([hour]) => hour >= since).reduce((sum, [, count]) => sum + count, 0),
      warn: expired || stored.expiresAt - at <= READ_TOKEN_WARN_MS, error: null,
    };
  };

  return {
    view,
    generate() {
      const token = `tpr_${randomBytes(32).toString('base64url')}`;
      const at = now();
      const next: Stored = { version: 1, id: randomBytes(4).toString('hex'), digest: digestOf(token).toString('hex'), redactKey: randomBytes(32).toString('base64url'),
        createdAt: at, expiresAt: at + READ_TOKEN_TTL_MS, lastUsedAt: null, hours: [], reminded: [], aliases: [] };
      aliases.clear();
      write(next);
      stored = next; loadError = null; dirty = false;
      redact = makeRedactor();
      recent.length = 0;
      log(`只读接口令牌已生成：编号 ${next.id}，${new Date(next.expiresAt).toISOString().slice(0, 10)} 到期`);
      return { token, view: view() };
    },
    revoke() {
      const id = stored?.id;
      write(null);
      stored = null; loadError = null; redact = null; dirty = false;
      aliases.clear();
      if (id) log(`只读接口令牌已吊销：编号 ${id}`);
      return view();
    },
    check(token) {
      if (!stored) return { ok: false, reason: 'none' };
      if (!READ_TOKEN_PATTERN.test(token) || !timingSafeEqual(digestOf(token), Buffer.from(stored.digest, 'hex'))) return { ok: false, reason: 'invalid' };
      if (now() >= stored.expiresAt) return { ok: false, reason: 'expired' };
      return { ok: true, id: stored.id };
    },
    admit() {
      const at = now();
      while (recent.length && at - recent[0]! >= 60_000) recent.shift();
      if (recent.length >= READ_TOKEN_PER_MINUTE || running >= READ_TOKEN_CONCURRENT) return null;
      recent.push(at);
      running += 1;
      let released = false;
      return () => { if (!released) { released = true; running -= 1; } };
    },
    record() {
      if (!stored) return;
      const at = now(), hour = Math.floor(at / HOUR_MS) * HOUR_MS;
      stored.lastUsedAt = at;
      const last = stored.hours.at(-1);
      if (last && last[0] === hour) last[1] += 1; else stored.hours.push([hour, 1]);
      stored.hours = stored.hours.filter(([start]) => start > hour - 24 * HOUR_MS);
      touch();
    },
    redactor: () => redact,
    lookup: alias => aliases.get(alias.trim()) ?? null,
    dueReminders(send) {
      if (!stored) return [];
      const at = now(), left = stored.expiresAt - at;
      if (left <= 0) return [];
      // Only the nearest reminder due: a token generated 3 days before expiry gets the 1-day one, not both at once.
      const due = REMINDERS.filter(reminder => left <= reminder.beforeMs).at(-1);
      if (!due || stored.reminded.includes(due.key)) return [];
      const days = Math.max(1, Math.ceil(left / 86_400_000));
      const text = `【只读接口令牌即将到期】编号 ${stored.id} 将在 ${days} 天内到期（${new Date(stored.expiresAt).toISOString().replace('T', ' ').slice(0, 16)} UTC）。到期后 MCP 客户端无法读取，请在「设置 → 只读接口令牌」重新生成并更新客户端的令牌文件。`;
      send?.(text);
      // Marking the farther ones too keeps a restart from sending the 7-day one after the 1-day one.
      for (const reminder of REMINDERS) if (reminder.beforeMs >= due.beforeMs && !stored.reminded.includes(reminder.key)) stored.reminded.push(reminder.key);
      dirty = true; flush();
      return [text];
    },
    flush,
  };
}

/**
 * The GET routes a read-only token may call (docs/mcp.md 3.1), with the query parameters each takes; anything else,
 * another parameter included, is refused with 403. Kept apart from the routes so the list is reviewed as one table:
 * each entry reads only this process's memory or local databases and answers no credential.
 */
export const READ_TOKEN_ROUTES: readonly { path: string | RegExp; query: readonly string[] }[] = [
  { path: '/api/status', query: [] },
  { path: '/api/state', query: [] },
  { path: /^\/api\/transfer-pairs\/[0-9A-Za-z_-]{1,64}\/history$/, query: ['before', 'limit'] },
  { path: /^\/api\/adl\/pairs\/[0-9A-Za-z_-]{1,64}\/incidents$/, query: ['before', 'limit'] },
  { path: '/api/logs', query: ['before', 'limit'] },
  { path: '/api/logs/problems', query: ['before', 'limit'] },
  { path: '/api/oil/state', query: [] },
  { path: '/api/hynix/state', query: [] },
  { path: '/api/goldoil/state', query: [] },
  { path: '/api/oil/pnl', query: ['range', 'page'] },
  { path: '/api/oil/rules', query: [] },
  { path: '/api/monitor/state', query: [] },
  { path: '/api/monitor/oil/alerts', query: [] },
  { path: '/api/monitor/hynix/alerts', query: [] },
  { path: '/api/monitor/goldoil/alerts', query: [] },
  { path: '/api/options/state', query: [] },
  { path: '/api/options/performance', query: [] },
  { path: '/api/crossex/state', query: ['opportunities'] },
  { path: '/api/ondo/state', query: [] },
  { path: '/api/update', query: [] },
  // docs/mcp.md 8.3: Var/Lighter (public market data and the paper strategy, local database only), the server's own load,
  // the monitors' quote snapshots and the EQN feed. None asks an exchange; Var/Lighter's POSTs (backtest included) stay out.
  { path: '/api/varlighter/state', query: [] },
  { path: '/api/varlighter/symbol', query: ['symbol', 'hours'] },
  { path: '/api/varlighter/paper', query: [] },
  { path: '/api/varlighter/readiness', query: [] },
  { path: '/api/varlighter/samples', query: ['symbol', 'after', 'limit'] },
  { path: '/api/host', query: [] },
  { path: /^\/api\/monitor\/(oil|goldoil|hynix|anthropic)\/quote$/, query: [] },
  { path: '/api/news', query: [] },
  { path: '/api/news/moves', query: [] },
];

/** Whether a read-only token may GET this URL: the path in READ_TOKEN_ROUTES and only its query parameters. */
export function readTokenAllows(url: URL): boolean {
  const route = READ_TOKEN_ROUTES.find(({ path }) => typeof path === 'string' ? path === url.pathname : path.test(url.pathname));
  if (!route) return false;
  for (const name of url.searchParams.keys()) if (!route.query.includes(name)) return false;
  return true;
}

/**
 * What a token reads of the online update: versions, state and times, without the install output, messages and release
 * notes. In split mode the control process answers this itself, past the masking, so it carries no free text at all.
 */
export function readTokenUpdateView(view: UpdateView): unknown {
  const job = view.job;
  return {
    current: view.current ? { version: view.current.version, commit: view.current.commit, packaged: view.current.packaged } : null,
    latest: view.latest ? { version: view.latest.version, publishedAt: view.latest.publishedAt } : null,
    checkedAt: view.checkedAt ?? null, checking: view.checking ?? false, checkFailed: Boolean(view.error), available: view.available ?? false,
    enabled: view.enabled ?? false,
    pending: view.pending ? { version: view.pending.version, at: view.pending.at, stale: view.pending.stale } : null,
    job: job ? { version: job.version, from: job.from, startedAt: job.startedAt, at: job.at, phase: job.phase, step: job.step ?? null, installed: job.installed ?? null, stale: job.stale ?? false } : null,
  };
}
