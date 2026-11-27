// The read-only API tokens (docs/mcp.md 2, 3 and 8.4): up to READ_TOKEN_MAX tokens, each with a name and the scopes it
// may read, made and revoked only from the logged-in page. <data dir>/read-token.json (version 2) keeps each token's
// digest (never the token), dates, request counts and sent reminders, plus one masking key and one alias table shared by
// all tokens, so every token reads the same aliases. A version 1 file (one token, before v0.85.0) is read as one token
// named MCP with every scope and rewritten as version 2 on the next write. Deleting the file revokes every token: the
// statistics flush never recreates it, and a restart reads none.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRedactor, type Redactor } from './read-redact.ts';
import type { UpdateView } from './service/update-types.ts';

export const READ_TOKEN_FILE = 'read-token.json';
export const READ_TOKEN_TTL_MS = 90 * 86_400_000;
/** The page and the sidebar warn from this long before expiry; the robot sends at 7 days and at 1 day. */
export const READ_TOKEN_WARN_MS = 7 * 86_400_000;
const REMINDERS = [{ key: '7d', beforeMs: 7 * 86_400_000 }, { key: '1d', beforeMs: 86_400_000 }] as const;
/** Per token. */
export const READ_TOKEN_PER_MINUTE = 30;
export const READ_TOKEN_CONCURRENT = 2;
/** All tokens together, so several cannot crowd out the trading work. */
export const READ_TOKEN_TOTAL_CONCURRENT = 4;
export const READ_TOKEN_MAX = 8;
/** A token answer larger than this is refused with 413 rather than cut, so the caller narrows the query. */
export const READ_TOKEN_MAX_BYTES = 512 * 1024;
export const READ_TOKEN_PATTERN = /^tpr_[A-Za-z0-9_-]{43}$/;
export const READ_SCOPES = ['public', 'system', 'portfolio'] as const;
export type ReadScope = typeof READ_SCOPES[number];
export const READ_SCOPE_NAMES: Record<ReadScope, string> = { public: '公开行情', system: '系统状态', portfolio: '账户与策略' };
const NAME_MAX = 40;
const HOUR_MS = 3_600_000;
const FLUSH_MS = 60_000;
const MAX_ALIASES = 5_000;
const CONTROL = /[\u0000-\u001f\u007f]/;

interface StoredToken {
  id: string; name: string; scopes: ReadScope[]; digest: string; createdAt: number; expiresAt: number;
  lastUsedAt: number | null; hours: [number, number][]; reminded: string[];
}
interface Stored { version: 2; redactKey: string; aliases: [string, string][]; tokens: StoredToken[] }

export interface ReadTokenItem {
  id: string; name: string; scopes: ReadScope[]; state: 'active' | 'expired';
  createdAt: number; expiresAt: number; lastUsedAt: number | null;
  /** Requests in the last 24 hours (whole hours), refused ones included. */
  requests24h: number;
  /** Within READ_TOKEN_WARN_MS of expiry, or expired: the page and the sidebar show a notice. */
  warn: boolean;
}
export interface ReadTokenView { tokens: ReadTokenItem[]; max: number; error: string | null }
/** What a token reads about itself (GET /api/read-token/self): no digest, no key. */
export interface ReadTokenSelf { id: string; name: string; scopes: ReadScope[]; expiresAt: number }

const digestOf = (token: string): Buffer => createHash('sha256').update(token).digest();
const isInt = (value: unknown): value is number => Number.isSafeInteger(value);
const isHours = (value: unknown) => Array.isArray(value) && value.every(row => Array.isArray(row) && row.length === 2 && row.every(isInt));
const isStrings = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === 'string');
const isAliases = (value: unknown) => Array.isArray(value) && value.every(row => Array.isArray(row) && row.length === 2 && row.every(part => typeof part === 'string'));

/** The name as stored, or null: 1–40 characters after trimming, no control characters. */
export function readTokenName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name.length >= 1 && [...name].length <= NAME_MAX && !CONTROL.test(name) ? name : null;
}
/** The scopes as stored (in READ_SCOPES order, no repeats), or null for an empty list or an unknown scope. */
export function readTokenScopes(value: unknown): ReadScope[] | null {
  if (!Array.isArray(value) || !value.length || !value.every(scope => (READ_SCOPES as readonly unknown[]).includes(scope))) return null;
  return READ_SCOPES.filter(scope => value.includes(scope));
}

function parseToken(raw: unknown): StoredToken | null {
  const value = raw as Partial<StoredToken> | null;
  if (value === null || typeof value !== 'object') return null;
  const scopes = readTokenScopes(value.scopes);
  const ok = typeof value.id === 'string' && /^[0-9a-f]{8}$/.test(value.id) && readTokenName(value.name) === value.name && scopes !== null && scopes.length === value.scopes!.length
    && typeof value.digest === 'string' && /^[0-9a-f]{64}$/.test(value.digest) && isInt(value.createdAt) && isInt(value.expiresAt)
    && (value.lastUsedAt === null || isInt(value.lastUsedAt)) && isHours(value.hours) && isStrings(value.reminded);
  return ok ? value as StoredToken : null;
}

function parse(raw: unknown): Stored {
  const value = raw as Record<string, unknown> | null;
  const invalid = new Error('read-token.json 格式无效');
  if (value === null || typeof value !== 'object' || typeof value.redactKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.redactKey) || !isAliases(value.aliases)) throw invalid;
  if (value.version === 1) {
    // The single token before v0.85.0 keeps working as it was: every scope, same id, dates, key and aliases.
    const token = parseToken({ ...value, name: 'MCP', scopes: [...READ_SCOPES] });
    if (!token) throw invalid;
    const { id, name, scopes, digest, createdAt, expiresAt, lastUsedAt, hours, reminded } = token;
    return { version: 2, redactKey: value.redactKey, aliases: value.aliases as [string, string][], tokens: [{ id, name, scopes, digest, createdAt, expiresAt, lastUsedAt, hours, reminded }] };
  }
  if (value.version !== 2 || !Array.isArray(value.tokens) || !value.tokens.length || value.tokens.length > READ_TOKEN_MAX) throw invalid;
  const tokens = value.tokens.map(parseToken);
  if (tokens.some(token => token === null) || new Set(tokens.map(token => token!.id)).size !== tokens.length) throw invalid;
  return { version: 2, redactKey: value.redactKey, aliases: value.aliases as [string, string][], tokens: tokens as StoredToken[] };
}

export class ReadTokenError extends Error {
  readonly code: 'token_input' | 'token_limit' | 'token_unknown';
  constructor(code: ReadTokenError['code'], message: string) { super(message); this.code = code; }
}

export type ReadTokenCheck = { ok: true; id: string; name: string; scopes: ReadScope[] } | { ok: false; reason: 'none' | 'invalid' | 'expired' };

export interface ReadTokens {
  view(): ReadTokenView;
  /** Adds a token (at most READ_TOKEN_MAX); the plain token is returned once and never stored. */
  generate(input: { name: unknown; scopes: unknown }): { token: string; id: string; view: ReadTokenView };
  /** Revokes one token, or every token without an id; with the last one gone the aliases and the key go too. */
  revoke(id?: string): ReadTokenView;
  /** The token behind this bearer when it matches a stored digest and has not expired. */
  check(token: string): ReadTokenCheck;
  /** What the token with this id reads about itself, or null once revoked. */
  self(id: string): ReadTokenSelf | null;
  /** A slot under the token's per-minute and concurrent limits and the total concurrent one, or null; release it when the answer is done. */
  admit(id: string): (() => void) | null;
  /** Counts one request (refused ones too) for the page's statistics. */
  record(id: string): void;
  /** The masking of token answers (one key for all tokens); null without a token. */
  redactor(): Redactor | null;
  /** The original behind an alias handed out to any token. */
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
  const limits = new Map<string, { recent: number[]; running: number }>();
  let running = 0;

  const write = (value: Stored | null) => {
    if (value === null) { rmSync(file, { force: true }); return; }
    const temp = join(dir, `.read-token.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    try {
      writeFileSync(temp, `${JSON.stringify({ ...value, aliases: [...aliases] })}\n`, { mode: 0o600, flag: 'wx' });
      renameSync(temp, file);
    } catch (error) { rmSync(temp, { force: true }); throw error; }
  };
  const forget = () => { stored = null; redact = null; dirty = false; aliases.clear(); limits.clear(); };
  /**
   * Deleted from outside (install.sh --set-password, or by hand) revokes every token: each entry point that reads or
   * writes the tokens checks this first, so none of them shows, reminds about or writes back a revoked token.
   */
  const vanished = () => {
    if (stored && !existsSync(file)) { log('只读接口令牌文件已被删除，全部令牌已吊销'); forget(); }
  };
  const flush = () => {
    vanished();
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
  const find = (id: string) => stored?.tokens.find(token => token.id === id) ?? null;

  const item = (token: StoredToken, at: number): ReadTokenItem => {
    const since = Math.floor(at / HOUR_MS) * HOUR_MS - 23 * HOUR_MS, expired = at >= token.expiresAt;
    return {
      id: token.id, name: token.name, scopes: [...token.scopes], state: expired ? 'expired' : 'active',
      createdAt: token.createdAt, expiresAt: token.expiresAt, lastUsedAt: token.lastUsedAt,
      requests24h: token.hours.filter(([hour]) => hour >= since).reduce((sum, [, count]) => sum + count, 0),
      warn: expired || token.expiresAt - at <= READ_TOKEN_WARN_MS,
    };
  };
  const view = (): ReadTokenView => {
    vanished();
    const at = now();
    return { tokens: stored ? stored.tokens.map(token => item(token, at)) : [], max: READ_TOKEN_MAX, error: stored ? null : loadError };
  };

  return {
    view,
    generate({ name: rawName, scopes: rawScopes }) {
      vanished();
      const name = readTokenName(rawName), scopes = readTokenScopes(rawScopes);
      if (name === null) throw new ReadTokenError('token_input', `名称须为 1–${NAME_MAX} 个字，不含控制字符`);
      if (scopes === null) throw new ReadTokenError('token_input', `范围须从 ${READ_SCOPES.join('、')} 中至少选一个`);
      if (stored && stored.tokens.length >= READ_TOKEN_MAX) throw new ReadTokenError('token_limit', `最多 ${READ_TOKEN_MAX} 个令牌，请先吊销不用的`);
      const token = `tpr_${randomBytes(32).toString('base64url')}`;
      const at = now();
      let id: string;
      do id = randomBytes(4).toString('hex'); while (find(id));
      const entry: StoredToken = { id, name, scopes, digest: digestOf(token).toString('hex'), createdAt: at, expiresAt: at + READ_TOKEN_TTL_MS, lastUsedAt: null, hours: [], reminded: [] };
      // The first token (or the first after a damaged file) starts a new key and an empty alias table.
      const fresh = !stored;
      if (fresh) aliases.clear();
      const next: Stored = stored ? { ...stored, tokens: [...stored.tokens, entry] } : { version: 2, redactKey: randomBytes(32).toString('base64url'), aliases: [], tokens: [entry] };
      write(next);
      stored = next; loadError = null; dirty = false;
      if (fresh) redact = makeRedactor();
      log(`只读接口令牌已生成：编号 ${id}（${name}，范围 ${scopes.join('、')}），${new Date(entry.expiresAt).toISOString().slice(0, 10)} 到期`);
      return { token, id, view: view() };
    },
    revoke(id) {
      vanished();
      if (id !== undefined && !find(id)) throw new ReadTokenError('token_unknown', `没有编号为 ${id} 的令牌`);
      const gone = stored ? stored.tokens.filter(token => id === undefined || token.id === id) : [];
      const left = stored ? stored.tokens.filter(token => !gone.includes(token)) : [];
      if (left.length) {
        const next: Stored = { ...stored!, tokens: left };
        write(next);
        stored = next; dirty = false;
        for (const token of gone) limits.delete(token.id);
      } else {
        write(null);
        forget(); loadError = null;
      }
      for (const token of gone) log(`只读接口令牌已吊销：编号 ${token.id}（${token.name}）`);
      return view();
    },
    check(token) {
      // Deleted from outside: refused from the next request on, not only after a restart.
      vanished();
      if (!stored) return { ok: false, reason: 'none' };
      if (!READ_TOKEN_PATTERN.test(token)) return { ok: false, reason: 'invalid' };
      const digest = digestOf(token);
      const match = stored.tokens.find(entry => timingSafeEqual(digest, Buffer.from(entry.digest, 'hex')));
      if (!match) return { ok: false, reason: 'invalid' };
      if (now() >= match.expiresAt) return { ok: false, reason: 'expired' };
      return { ok: true, id: match.id, name: match.name, scopes: [...match.scopes] };
    },
    self(id) {
      const token = find(id);
      return token ? { id: token.id, name: token.name, scopes: [...token.scopes], expiresAt: token.expiresAt } : null;
    },
    admit(id) {
      const at = now();
      let limit = limits.get(id);
      if (!limit) { limit = { recent: [], running: 0 }; limits.set(id, limit); }
      while (limit.recent.length && at - limit.recent[0]! >= 60_000) limit.recent.shift();
      if (limit.recent.length >= READ_TOKEN_PER_MINUTE || limit.running >= READ_TOKEN_CONCURRENT || running >= READ_TOKEN_TOTAL_CONCURRENT) return null;
      limit.recent.push(at);
      limit.running += 1; running += 1;
      const held = limit;
      let released = false;
      return () => { if (!released) { released = true; held.running -= 1; running -= 1; } };
    },
    record(id) {
      const token = find(id);
      if (!token) return;
      const at = now(), hour = Math.floor(at / HOUR_MS) * HOUR_MS;
      token.lastUsedAt = at;
      const last = token.hours.at(-1);
      if (last && last[0] === hour) last[1] += 1; else token.hours.push([hour, 1]);
      token.hours = token.hours.filter(([start]) => start > hour - 24 * HOUR_MS);
      touch();
    },
    redactor: () => redact,
    lookup: alias => { vanished(); return aliases.get(alias.trim()) ?? null; },
    dueReminders(send) {
      vanished();
      if (!stored) return [];
      const at = now(), texts: string[] = [];
      for (const token of stored.tokens) {
        const left = token.expiresAt - at;
        if (left <= 0) continue;
        // Only the nearest reminder due: a token generated 3 days before expiry gets the 1-day one, not both at once.
        const due = REMINDERS.filter(reminder => left <= reminder.beforeMs).at(-1);
        if (!due || token.reminded.includes(due.key)) continue;
        const days = Math.max(1, Math.ceil(left / 86_400_000));
        const text = `【只读接口令牌即将到期】「${token.name}」（编号 ${token.id}）将在 ${days} 天内到期（${new Date(token.expiresAt).toISOString().replace('T', ' ').slice(0, 16)} UTC）。到期后用它的 MCP 客户端无法读取，请在「设置 → 只读接口令牌」生成新令牌并更新客户端的令牌文件。`;
        send?.(text);
        // Marking the farther ones too keeps a restart from sending the 7-day one after the 1-day one.
        for (const reminder of REMINDERS) if (reminder.beforeMs >= due.beforeMs && !token.reminded.includes(reminder.key)) token.reminded.push(reminder.key);
        dirty = true; flush();
        texts.push(text);
      }
      return texts;
    },
    flush,
  };
}

/**
 * The GET routes a read-only token may call (docs/mcp.md 3.1), with the scope a token needs (8.4) and the query
 * parameters each takes; anything else, another parameter included, is refused with 403. Kept apart from the routes so
 * the list is reviewed as one table: each entry reads only this process's memory or local databases and answers no
 * credential. public: market quotes and the news feed; system: the platform's own health; portfolio: accounts, positions,
 * the modules' records and Var/Lighter's strategy data.
 */
export const READ_TOKEN_ROUTES: readonly { path: string | RegExp; scope: ReadScope; query: readonly string[] }[] = [
  { path: '/api/status', scope: 'system', query: [] },
  { path: '/api/state', scope: 'portfolio', query: [] },
  { path: /^\/api\/transfer-pairs\/[0-9A-Za-z_-]{1,64}\/history$/, scope: 'portfolio', query: ['before', 'limit'] },
  { path: /^\/api\/adl\/pairs\/[0-9A-Za-z_-]{1,64}\/incidents$/, scope: 'portfolio', query: ['before', 'limit'] },
  { path: '/api/logs', scope: 'portfolio', query: ['before', 'limit'] },
  { path: '/api/logs/problems', scope: 'portfolio', query: ['before', 'limit'] },
  { path: '/api/oil/state', scope: 'portfolio', query: [] },
  { path: '/api/hynix/state', scope: 'portfolio', query: [] },
  { path: '/api/goldoil/state', scope: 'portfolio', query: [] },
  { path: '/api/oil/pnl', scope: 'portfolio', query: ['range', 'page'] },
  { path: '/api/oil/rules', scope: 'portfolio', query: [] },
  { path: '/api/monitor/state', scope: 'portfolio', query: [] },
  { path: '/api/monitor/oil/alerts', scope: 'portfolio', query: [] },
  { path: '/api/monitor/hynix/alerts', scope: 'portfolio', query: [] },
  { path: '/api/monitor/goldoil/alerts', scope: 'portfolio', query: [] },
  { path: '/api/options/state', scope: 'portfolio', query: [] },
  { path: '/api/options/performance', scope: 'portfolio', query: [] },
  { path: '/api/crossex/state', scope: 'portfolio', query: ['opportunities'] },
  { path: '/api/ondo/state', scope: 'portfolio', query: [] },
  { path: '/api/update', scope: 'system', query: [] },
  // docs/mcp.md 8.3: Var/Lighter (public market data and the strategy state, local database only), the server's own load,
  // the monitors' quote snapshots and the EQN feed. None asks an exchange; Var/Lighter's POSTs (backtest included) stay out.
  { path: '/api/varlighter/state', scope: 'portfolio', query: [] },
  { path: '/api/varlighter/symbol', scope: 'portfolio', query: ['symbol', 'hours'] },
  { path: '/api/varlighter/readiness', scope: 'portfolio', query: [] },
  { path: '/api/varlighter/samples', scope: 'portfolio', query: ['symbol', 'after', 'limit'] },
  { path: '/api/host', scope: 'system', query: [] },
  { path: /^\/api\/monitor\/(oil|goldoil|hynix|anthropic)\/quote$/, scope: 'public', query: [] },
  // Reading the moves keeps the EQN poll going for another 90 seconds (src/news/feed.ts): public, bounded, no credential.
  { path: '/api/news', scope: 'public', query: [] },
  { path: '/api/news/moves', scope: 'public', query: [] },
];

/**
 * What a token reads of the EQN feed: each item's `url` (eqn.news's page for it) renamed `link`. `url` is an identifier
 * field for the masking, so the links would become aliases, and a few hundred a read would push real accounts' aliases
 * out of the lookup table (docs/mcp.md 8.3).
 */
export function readTokenNewsView<T extends { items: readonly { url: string | null }[] }>(view: T): unknown {
  return { ...view, items: view.items.map(({ url, ...item }) => ({ ...item, link: url })) };
}

/**
 * What a token without the portfolio scope reads of /api/status (docs/mcp.md 8.4): only the listed fields. The full
 * answer carries the Feishu outbox's recent texts (fills, alerts, executions), the account streams, the transfer
 * settings and the monitors' summaries, which are account and strategy data; a top-level field added later stays out.
 * The execution loops keep their counts and times but not the last error's text, which is the same line the (portfolio)
 * log has.
 */
export function readTokenSystemStatus(view: Record<string, unknown>): Record<string, unknown> {
  const pick = (value: unknown, keys: readonly string[]) => value !== null && typeof value === 'object'
    ? Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, (value as Record<string, unknown>)[key]])) : value ?? null;
  const dependencies = view.dependencies !== null && typeof view.dependencies === 'object' ? (() => {
    const dep = view.dependencies as Record<string, unknown>;
    return Array.isArray(dep.incidents)
      ? { ...dep, incidents: dep.incidents.filter(item => !(item !== null && typeof item === 'object' && typeof (item as { key?: unknown }).key === 'string' && (item as { key: string }).key.startsWith('stream:'))) }
      : dep;
  })() : view.dependencies ?? null;
  return {
    health: view.health !== null && typeof view.health === 'object'
      ? { ...view.health as Record<string, unknown>, loops: Array.isArray((view.health as { loops?: unknown }).loops)
        ? ((view.health as { loops: unknown[] }).loops).map(row => row !== null && typeof row === 'object' ? (({ lastError: _, ...rest }) => rest)(row as Record<string, unknown>) : row) : undefined }
      : null,
    dependencies,
    samples: view.samples ?? null,
    ...(view.watch !== undefined ? { watch: view.watch } : {}),
    feishu: pick(view.feishu, ['configured', 'pending', 'retrying', 'lastSentAt', 'lastError', 'nextRetryAt', 'retentionMs']),
    ...(view.monitor !== undefined ? { monitor: pick(view.monitor, ['available', 'error']) } : {}),
    omitted: '令牌没有 portfolio 范围：飞书消息原文、账户行情流、划转设置与各监控摘要不提供',
  };
}

/** Strips portfolio-level ASTER account streams from /api/host for system-scoped read-only tokens. */
export function readTokenHostView(view: Record<string, unknown>): Record<string, unknown> {
  return Array.isArray(view.connections)
    ? { ...view, connections: view.connections.filter(row => !(row !== null && typeof row === 'object' && (row as { id?: unknown }).id === 'streams')) }
    : view;
}

/** The scope a read-only token needs to GET this URL, or null when no token may: the path in READ_TOKEN_ROUTES and only its query parameters. */
export function readTokenScope(url: URL): ReadScope | null {
  const route = READ_TOKEN_ROUTES.find(({ path }) => typeof path === 'string' ? path === url.pathname : path.test(url.pathname));
  if (!route) return null;
  for (const name of url.searchParams.keys()) if (!route.query.includes(name)) return null;
  return route.scope;
}
/** Whether some read-only token may GET this URL (its scopes aside). */
export const readTokenAllows = (url: URL): boolean => readTokenScope(url) !== null;

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
