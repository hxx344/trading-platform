// Local HTTP surface for the minimal page. It binds to loopback, or to one address the operator chose (a Tailscale IP),
// checks the Host header against DNS rebinding, hands the session cookie out only in exchange for the access token
// written to the data directory or for the login password, and requires that cookie plus a custom header on every
// write, so neither another site nor another process that merely reaches the port can drive it.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ContractError, TRANSFER_CONFIG_KEYS, VENUES, exactKeys, parsePage, type Venue } from './contracts.ts';
import type { Executor } from './executor.ts';
import { LIVE_PAGE, PAGE } from './page.ts';
import { LoginThrottle, MAX_PASSWORD_LENGTH, verifyPassword, type PasswordHash } from './login-password.ts';
import type { WebApp } from './web-assets.ts';
import { ANTHROPIC_RETENTION_DAYS } from './vendor/anthropic-market.mjs';
import { supportsExchange, type Exchange } from './vendor/exchange-comparison.mjs';
import { supportsFundingHistory } from './vendor/exchange-funding-history.mjs';
import type { AssetStore } from './asset/store.ts';
import type { CrossexViews } from './service/crossex.ts';
import { AssetConflict } from './asset/sync-lock.ts';
import { AssetInputError, INPUT_INVALID } from './asset/validation.ts';

const MAX_BODY_BYTES = 16 * 1024;
const MAX_LOGIN_BYTES = 4 * 1024;
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
const UUID_PATH = /^\/api\/jobs\/([0-9a-f-]{36})(?:\/(stop|acknowledge|adopt-strategy|confirm-not-created|release-strategy))?$/i;

const PAIR_PATH = /^\/api\/transfer-pairs\/([0-9A-Za-z_-]{1,64})\/(enable|disable)$/;
const PAIR_CONFIG_PATH = /^\/api\/transfer-pairs\/([0-9A-Za-z_-]{1,64})\/config$/;
const ADL_CONFIG_PATH = /^\/api\/adl\/pairs\/([0-9A-Za-z_-]{1,64})\/config$/;
const ADL_RESTART_PATH = /^\/api\/adl\/incidents\/([0-9a-f-]{36})\/restart$/;
const PAIR_READ_PATH = /^\/api\/transfer-pairs\/([0-9A-Za-z_-]{1,64})\/(balances|history)$/;
const ADL_HISTORY_PATH = /^\/api\/adl\/pairs\/([0-9A-Za-z_-]{1,64})\/incidents$/;
const TRANSFER_PAGE_MAX = 50, ADL_PAGE_MAX = 20;
const MONITOR_PATHS = new Set(['/api/monitor/state', '/api/monitor/anthropic/quote', '/api/monitor/anthropic/candles', '/api/monitor/oil/quote', '/api/monitor/oil/candles', '/api/monitor/hynix/quote', '/api/monitor/hynix/candles']);
const MONITOR_NAMES = { anthropic: 'Anthropic', oil: '原油', hynix: '海力士', perpetual: '合约价差' } as const;
type CandleMarket = Exclude<keyof typeof MONITOR_NAMES, 'perpetual'>;
const MONITOR_MAX_DAYS = ANTHROPIC_RETENTION_DAYS;
const ASSET_READS = { '/api/asset/state': 'state', '/api/asset/ledger': 'ledger', '/api/asset/history': 'history', '/api/asset/daily-changes': 'dailyChanges', '/api/asset/withdrawals': 'withdrawals', '/api/asset/cash-flows': 'cashFlows' } as const;
const ASSET_PERIOD_ID = /^[0-9A-Za-z-]{1,80}$/;
const ASSET_WRITES = { '/api/asset/assets/edit': 'edit', '/api/asset/fx': 'fx', '/api/asset/withdrawals/add': 'add', '/api/asset/withdrawals/edit': 'change', '/api/asset/withdrawals/delete': 'delete', '/api/asset/cash-flows': 'cashFlow',
  // A-3/A-4: the sync and the connections.
  '/api/asset/sync': 'sync', '/api/asset/connections': 'connect', '/api/asset/connections/delete': 'disconnect',
  '/api/asset/aster-accounts/add': 'asterAdd', '/api/asset/aster-accounts/edit': 'asterEdit', '/api/asset/aster-accounts/delete': 'asterDelete',
} as const;
/** The workbench's database and network failures (modules/asset/lib/api.ts failure at 0014655). */
const ASSET_UNAVAILABLE = /D1_|SQLITE|decrypt|OperationError|fetch failed|network|aborted|timeout/i;
/**
 * A failed asset write as the workbench answers it (lib/api.ts failure), with this service's codes: invalid input 400
 * with one fixed text, a refusal because of the ledger's state 409, a database error 503 without its SQL or text, an
 * edit refused by a ledger rule 400 with its message. Stored data that no longer parses is 500 like the reads.
 */
function assetWriteError(error: unknown): ContractError {
  if (error instanceof AssetInputError) return new ContractError(400, 'invalid_input', INPUT_INVALID);
  if (error instanceof AssetConflict) return new ContractError(409, error.code, error.message);
  if (error instanceof Error && ((error as NodeJS.ErrnoException).code === 'ERR_SQLITE_ERROR' || ASSET_UNAVAILABLE.test(error.message))) return new ContractError(503, 'asset_unavailable', '服务暂时不可用，已保留上次数据，请稍后重试');
  if (error instanceof SyntaxError) return new ContractError(500, 'asset_unreadable', '资产账本读取失败：库里有一项数据格式无效，请重新导入');
  // Only the ledger rules throw plain Errors; anything else (a TypeError) is a defect and stays the generic 500.
  if (error instanceof Error && error.constructor === Error) return new ContractError(400, 'asset_rejected', error.message.slice(0, 200));
  return new ContractError(500, 'internal', '执行器内部错误');
}

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'",
};
// The built page (the ASTER service): its script and style come from /assets only, nothing inline runs.
const APP_HEADERS = {
  ...PAGE_HEADERS,
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};
// Names carry a content hash, so a cached copy never goes stale; private, since only a logged-in browser fetches them.
const ASSET_HEADERS = { 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin' };
const ASSET_PATH = /^\/assets\/([^/]{1,128})$/;
const LOGIN_REQUIRED = '<!doctype html><meta charset="utf-8"><title>需要登录</title><p>请使用数据目录 access-url 中的登录链接打开（用 sudo bash install.sh --set-password 设置登录密码后可直接输入密码）。</p>';
const loginForm = (notice: string): string => '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>登录</title>'
  + '<style>body{font:15px/1.5 system-ui,sans-serif;max-width:22rem;margin:4rem auto;padding:0 1rem}input,button{font:inherit;padding:.45rem .6rem;width:100%;box-sizing:border-box;margin:.3rem 0}.notice{color:#b42318}</style>'
  + '<h1>统一交易平台</h1><form method="post" action="/login"><label>登录密码<input type="password" name="password" autocomplete="current-password" required autofocus maxlength="' + 2 * MAX_PASSWORD_LENGTH + '"></label><button>登录</button></form>'
  + (notice ? `<p class="notice">${notice}</p>` : '');

/** Instances on different ports of one host share the browser cookie jar for 127.0.0.1, so the name carries the port. */
export const sessionCookieName = (port: number): string => `pa_executor_session_${port}`;

/** The page's workbench import (the ASTER service only): leaves a request for the root helper and reads its answer. */
export interface ImportChannel { submit(body: unknown): { id: string; at: number }; latest(): unknown }

/** Read-only views a service adds to the page: its run status and its balance history. */
export interface ServiceViews {
  status?(): Record<string, unknown>;
  /** null for an unknown range. */
  balanceHistory?(pairId: string, range: string): unknown;
  /** The oil module's reads (books and spreads; accounts, positions, jobs, caps); absent when the service runs no oil. */
  oil?: {
    market(): unknown; state(): unknown;
    /** The spread rules (docs/oil.md section 7); a store that could not open answers its reason and refuses writes. */
    rules?: { view(): unknown; create(body: unknown): unknown; update(id: string, body: unknown): unknown; act(id: string, action: string, body: unknown): unknown };
    /** PnL, funding and ledgers (docs/oil.md section 9); null for an unknown range. */
    pnl?(range: string, page: number): unknown;
  };
  /** SK hynix trading on the oil accounts (docs/hynix.md): books and premium; accounts, positions, hynix jobs, caps. Absent without oil. */
  hynix?: { market(): unknown; state(): unknown };
  /** The read-only market monitors; a market's reads give undefined when it is not configured and null until there is data. Absent without config.monitor. */
  monitor?: {
    state(): { markets: readonly string[] }; quote(market: CandleMarket): unknown; candles(market: CandleMarket, days: number | null): unknown;
    /** The settled funding history of oil or Hynix (M-2d); before any settlement `{ notReady: <reason> | null }`. */
    funding?(market: 'oil' | 'hynix'): unknown;
    /** M-2c: one exchange's comparison row, read on demand; undefined when the market is not configured; rejects with the page's reason. */
    exchange?(market: 'oil' | 'hynix', exchange: Exchange): Promise<unknown> | undefined;
    /** M-2d-3: one exchange's settled funding history (60 days, both legs); undefined when the market is not configured; rejects with the page's reason. */
    fundingHistory?(market: 'oil' | 'hynix', exchange: Exchange): Promise<unknown> | undefined;
    /** M-3a: the market's threshold alerts; undefined when the market is not configured (or the service runs without alerts). */
    alerts?(market: 'oil' | 'hynix'): { view(): unknown; update(body: unknown): unknown; test(): Promise<unknown> } | undefined;
    /** M-3c: false for a configured market switched off (its reads answer 423); the page's switch. */
    enabled?(market: keyof typeof MONITOR_NAMES): boolean;
    setControl?(market: keyof typeof MONITOR_NAMES, body: unknown): unknown;
    /** M-3d: the saved Variational token (state without the token, and the page's save); undefined when oil is not configured. */
    variationalSession?(): { view(): unknown; update(body: unknown): Promise<unknown> } | undefined;
    /** M-4a: the perpetual collector's table, summary and SSE stream; undefined when it is not configured. */
    perpetual?(): {
      snapshot(): unknown; summary(): unknown; stream(request: IncomingMessage, response: ServerResponse): void;
      /** M-5a: one-shot public depth, the close estimate and the FX rates; refusals carry an HTTP `status`. */
      depth?(input: unknown): Promise<unknown>; exit?(input: unknown): Promise<unknown>; fx?(): Promise<unknown>; marketMetrics?(input: unknown): Promise<unknown>;
      fundingHistory?(input: unknown): Promise<unknown>; scannerData?(input: unknown): Promise<unknown>; priceHistory?(input: unknown): Promise<unknown>;
      quality?(input: unknown): Promise<unknown>;
      /** M-5e1: the paper positions' view, and a create / update / close / delete answering the new view; refusals carry an HTTP `status`. */
      paperView?(): unknown; paperUpdate?(input: unknown): Promise<unknown>;
    } | undefined;
  };
  /** The options module's reads and writes (service/options.ts); absent when the service runs no options module. */
  options?: {
    market(expiry: string | null): unknown;
    preview(quantity: string | null, mode: string | null): unknown;
    state(): unknown;
    /** The 收益 page (G2b). */
    performance(): unknown;
    plan(body: unknown): Promise<unknown>;
    start(body: unknown): Promise<unknown>;
    stop(taskId: string, body: unknown): unknown;
    autoOpen(body: unknown): unknown;
    /** 组合询价 (G2c): the RFQ with its quotes; create, execute one quote, cancel. */
    rfq(): unknown;
    rfqCreate(body: unknown): Promise<unknown>;
    rfqExecute(body: unknown): Promise<unknown>;
    rfqCancel(body: unknown): Promise<unknown>;
  };
  /** The service's log lines, newest first (service-log.ts); `before` is the last id of the previous page. */
  logs?(filter: 'all' | 'problems', before: number | null, limit: number): unknown;
  /** The scheduled summary card (summary.ts): the page's interval and a card now; both answer with its status. */
  summary?: { setInterval(minutes: number): unknown; sendNow(): unknown };
  /** The asset ledger's reads and writes (asset/store.ts); absent when the service runs without asset. */
  asset?: Omit<AssetStore, 'close'>;
  /** The Gate CrossEx module's reads and writes (service/crossex.ts); absent when the service runs without crossex, 503 while it has not started. */
  crossex?: CrossexViews;
}

/** accessToken is exchanged once per browser at /login; session is the cookie value and the executor session id. */
export interface HttpOptions {
  executor: Executor;
  accessToken: string;
  session?: string;
  /** Set with a session that outlives restarts: the cookie then outlives the browser session too. */
  sessionMaxAgeS?: number;
  /** Page served at /; defaults by environment. */
  page?: string;
  /** The built page with its files under /assets; takes the place of page. */
  app?: WebApp;
  imports?: ImportChannel;
  views?: ServiceViews;
  /** The login password's digest; without one only the access token logs in. */
  password?: PasswordHash;
  /** The address listened on besides loopback, as written in a URL (an IPv6 one in brackets); accepted in Host. */
  host?: string;
  /**
   * Answers the login-free GET /api/ready, which a watchdog on another host probes: true while the run is healthy.
   * Without it the path does not exist.
   */
  ready?: () => boolean;
  /** Tests set the clock; one throttle per server otherwise. */
  throttle?: LoginThrottle;
  log?: (line: string) => void;
}

// Hashing first gives equal-length inputs, so the comparison does not leak the token length either.
const sameSecret = (given: string, expected: string): boolean =>
  timingSafeEqual(createHash('sha256').update(given).digest(), createHash('sha256').update(expected).digest());

export function createExecutorServer({ executor, accessToken, session = randomBytes(32).toString('base64url'), sessionMaxAgeS, page, app, imports, views, password, host, ready, throttle = new LoginThrottle(), log = line => process.stderr.write(`${line}\n`) }: HttpOptions): Server {
  if (!accessToken) throw new Error('需要访问令牌');
  if (sameSecret(session, accessToken)) throw new Error('会话值不能与访问令牌相同');
  // The executor records which session asked for each command; it gets a digest, so the stored rows never hold the cookie.
  const sessionId = createHash('sha256').update(`executor-session:${session}`).digest('base64url');
  // The name follows the port actually bound, which is only known once listening (port 0 in tests).
  const cookieName = (request: IncomingMessage) => sessionCookieName(request.socket.localPort ?? 0);
  const authorized = (request: IncomingMessage): boolean => {
    const name = cookieName(request);
    const value = (request.headers.cookie ?? '').split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1);
    return value !== undefined && sameSecret(value, session);
  };
  // Loopback by any port (a tunnel may map it), the chosen address by itself or with a port.
  const allowedHost = (value: string): boolean => LOOPBACK.test(value) || (host !== undefined && (value === host || (value.startsWith(`${host}:`) && /^\d{1,5}$/.test(value.slice(host.length + 1)))));
  const sessionCookie = (request: IncomingMessage): string => `${cookieName(request)}=${session}; HttpOnly; SameSite=Strict; Path=/${sessionMaxAgeS ? `; Max-Age=${sessionMaxAgeS}` : ''}`;
  // The form's own page sends its real Origin with the post (no-referrer would make it "null", as sandboxed pages send).
  const loginPage = (response: ServerResponse, status: number, notice = '') => {
    response.writeHead(status, { ...PAGE_HEADERS, 'referrer-policy': 'same-origin' });
    response.end(password ? loginForm(notice) : LOGIN_REQUIRED);
  };
  let verifying = false;
  const readForm = (request: IncomingMessage): Promise<URLSearchParams | 'too-large' | null> => new Promise((resolve, fail) => {
    let size = 0; const chunks: Buffer[] = [];
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_LOGIN_BYTES) { chunks.push(chunk); return; }
      request.off('data', onData); resolve('too-large');
    };
    request.on('data', onData);
    request.on('end', () => { if (size <= MAX_LOGIN_BYTES) resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))); });
    // A client gone before the end leaves nothing to check; resolving twice is a no-op.
    request.on('close', () => resolve(null));
    request.on('error', fail);
  });
  // The form posts from this page only. Browsers name the fetch site on every post; an older one without it still names
  // the origin, which must be this one ("null" comes from sandboxed and data: pages). No Origin at all is not a browser.
  const sameOrigin = (request: IncomingMessage): boolean => {
    const origin = request.headers.origin, site = request.headers['sec-fetch-site'];
    if (site !== undefined) return site === 'same-origin' || site === 'none';
    return origin === undefined || origin === `http://${request.headers.host}`;
  };
  async function passwordLogin(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!password) { request.resume(); return loginPage(response, 401); }
    if (!sameOrigin(request) || !String(request.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) { request.resume(); return loginPage(response, 403, '请从登录页提交'); }
    const busy = () => loginPage(response, 429, `尝试次数过多，请 ${Math.max(1, Math.ceil(throttle.waitMs() / 1000))} 秒后再试`);
    if (throttle.waitMs() > 0) { request.resume(); return busy(); }
    // The body is read before taking the check, so a client that sends it slowly holds up nobody else.
    const form = await readForm(request);
    if (response.writableEnded || request.socket.destroyed) return;
    if (form === 'too-large') {
      response.writeHead(413, { ...PAGE_HEADERS, connection: 'close' });
      response.end('请求体过大', () => request.socket.destroy());
      return;
    }
    // One check at a time, so parallel guesses cannot outrun the counter.
    if (throttle.waitMs() > 0 || verifying) return busy();
    verifying = true;
    let ok: boolean;
    try { ok = form !== null && await verifyPassword(form.get('password') ?? '', password); }
    finally { verifying = false; }
    if (!ok) {
      throttle.failed();
      const locked = throttle.waitMs();
      log(`页面登录密码错误（来自 ${request.socket.remoteAddress ?? '未知地址'}）${locked ? `，已锁定 ${Math.ceil(locked / 1000)} 秒` : ''}`);
      return loginPage(response, 401, locked ? `密码错误，已锁定 ${Math.ceil(locked / 1000)} 秒` : '密码错误');
    }
    throttle.succeeded();
    log(`页面密码登录成功（来自 ${request.socket.remoteAddress ?? '未知地址'}）`);
    response.writeHead(303, { ...PAGE_HEADERS, location: '/', 'set-cookie': sessionCookie(request) });
    response.end();
  }
  const send = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    const payload = JSON.stringify(body);
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
    response.end(payload);
  };
  const readJson = (request: IncomingMessage): Promise<unknown> => new Promise((resolve, fail) => {
    let size = 0; const chunks: Buffer[] = [];
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) { chunks.push(chunk); return; }
      // Drain instead of destroying so the client still receives the 413; the connection closes after it.
      request.off('data', onData); request.resume();
      fail(new ContractError(413, 'body_too_large', '请求体过大'));
    };
    request.on('data', onData);
    request.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch { fail(new ContractError(400, 'invalid_json', '请求体不是有效 JSON')); } });
    request.on('error', fail);
  });

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!allowedHost(request.headers.host ?? '')) return send(response, 421, { code: 'host', message: '访问地址不在允许范围内' });
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'POST' && url.pathname === '/login') return passwordLogin(request, response);
    if (request.method === 'GET' && url.pathname === '/login') {
      const token = url.searchParams.get('token');
      // Without a token it is the password form (or the access-url notice when no password is set).
      if (token === null || !sameSecret(token, accessToken)) return loginPage(response, token === null && password ? 200 : 401, token === null ? '' : '登录链接无效或已过期');
      // Whoever reads access-url may lift a lockout a guesser left.
      throttle.succeeded();
      response.writeHead(303, { ...PAGE_HEADERS, location: '/', 'set-cookie': sessionCookie(request) });
      response.end();
      return;
    }
    // The one /api path open without a login. The answer is a single boolean: an outsider who can reach the port
    // learns that the service runs and nothing about accounts, balances, configuration or why it is not ready.
    if (ready && request.method === 'GET' && url.pathname === '/api/ready') {
      const ok = ready();
      return send(response, ok ? 200 : 503, { ready: ok });
    }
    if (request.method === 'GET' && url.pathname === '/') {
      if (!authorized(request)) return loginPage(response, 401);
      if (app) { response.writeHead(200, APP_HEADERS); response.end(app.index); return; }
      response.writeHead(200, PAGE_HEADERS);
      response.end(page ?? (executor.environment === 'mainnet' ? LIVE_PAGE : PAGE));
      return;
    }
    const assetPath = app && request.method === 'GET' ? ASSET_PATH.exec(url.pathname) : null;
    if (assetPath) {
      if (!authorized(request)) return send(response, 401, { code: 'session', message: '需要登录' });
      const asset = app!.assets.get(assetPath[1]!);
      if (!asset) return send(response, 404, { code: 'not_found', message: '不存在' });
      response.writeHead(200, { ...ASSET_HEADERS, 'content-type': asset.type, 'content-length': String(asset.body.length) });
      response.end(asset.body);
      return;
    }
    if (!url.pathname.startsWith('/api/')) return send(response, 404, { code: 'not_found', message: '不存在' });
    if (!authorized(request)) return send(response, 401, { code: 'session', message: password ? '会话无效，请刷新页面重新登录' : '会话无效，请使用数据目录 access-url 中的登录链接重新打开' });
    if (request.method === 'POST' && (request.headers['x-pa-executor'] !== '1' || !String(request.headers['content-type'] ?? '').startsWith('application/json'))) return send(response, 403, { code: 'csrf', message: '缺少本页面请求标记' });

    if (request.method === 'GET' && url.pathname === '/api/state') {
      return send(response, 200, { generation: executor.generation, retired: executor.retired, transport: executor.environment === 'mainnet' ? 'live' : 'simulated', accounts: executor.accounts(), notionalLimits: executor.notionalLimits(), jobs: executor.recentJobs(20),
        transfers: { pairs: executor.transferPairs(), corruptPairs: executor.corruptTransferPairs(), recent: executor.recentTransfers(20) },
        adl: { pairs: executor.adlPairs(), recent: executor.recentAdlIncidents(10) }, positions: executor.asterPositions() });
    }
    if (request.method === 'GET' && url.pathname === '/api/status') {
      if (!views?.status) return send(response, 404, { code: 'not_found', message: '本服务没有运行状态' });
      return send(response, 200, views.status());
    }
    if (request.method === 'GET' && (url.pathname === '/api/oil/market' || url.pathname === '/api/oil/state')) {
      if (!views?.oil) return send(response, 404, { code: 'not_found', message: '本服务没有配置原油执行' });
      return send(response, 200, url.pathname === '/api/oil/market' ? views.oil.market() : views.oil.state());
    }
    if (request.method === 'GET' && (url.pathname === '/api/hynix/market' || url.pathname === '/api/hynix/state')) {
      if (!views?.hynix) return send(response, 404, { code: 'not_found', message: '本服务没有配置海力士执行（与原油共用执行账户）' });
      return send(response, 200, url.pathname === '/api/hynix/market' ? views.hynix.market() : views.hynix.state());
    }
    if (request.method === 'GET' && url.pathname === '/api/oil/pnl') {
      if (!views?.oil?.pnl) return send(response, 404, { code: 'not_found', message: '本服务没有配置原油执行' });
      const page = Number(url.searchParams.get('page') ?? '0');
      const result = Number.isSafeInteger(page) && page >= 0 && page <= 100_000 ? views.oil.pnl(url.searchParams.get('range') ?? '7d', page) : null;
      if (result === null) return send(response, 400, { code: 'invalid_query', message: '区间或页码无效' });
      return send(response, 200, result);
    }
    if (url.pathname === '/api/oil/rules' || url.pathname.startsWith('/api/oil/rules/')) {
      if (!views?.oil?.rules) return send(response, 404, { code: 'not_found', message: '本服务没有配置原油执行' });
      const rules = views.oil.rules;
      if (url.pathname === '/api/oil/rules') {
        if (request.method === 'GET') return send(response, 200, rules.view());
        if (request.method === 'POST') return send(response, 200, rules.create(await readJson(request)));
      }
      const target = request.method === 'POST' ? /^\/api\/oil\/rules\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(update|start|stop|delete|live|enable|disable|observe|reset)$/.exec(url.pathname) : null;
      if (!target) return send(response, 404, { code: 'not_found', message: '不存在' });
      const body = await readJson(request);
      return send(response, 200, target[2] === 'update' ? rules.update(target[1]!, body) : rules.act(target[1]!, target[2]!, body));
    }
    // M-3c: the market's switch, and the reads of a market switched off (its data is kept, nothing is collected).
    const controlRoute = request.method === 'POST' ? /^\/api\/monitor\/(anthropic|oil|hynix|perpetual)\/control$/.exec(url.pathname) : null;
    if (controlRoute) {
      const market = controlRoute[1] as keyof typeof MONITOR_NAMES;
      if (!views?.monitor?.setControl) return send(response, 404, { code: 'not_found', message: '本服务没有配置行情监控' });
      if (!views.monitor.state().markets.includes(market)) return send(response, 404, { code: 'not_found', message: `本服务没有配置${MONITOR_NAMES[market]}行情监控` });
      return send(response, 200, views.monitor.setControl(market, await readJson(request)));
    }
    const marketRead = /^\/api\/monitor\/(anthropic|oil|hynix|perpetual)\//.exec(url.pathname)?.[1] as keyof typeof MONITOR_NAMES | undefined;
    if (marketRead && views?.monitor?.enabled && views.monitor.state().markets.includes(marketRead) && !views.monitor.enabled(marketRead)) {
      return send(response, 423, { code: 'monitor_disabled', message: marketRead === 'perpetual' ? '合约价差监控已关闭，行情采集已暂停；开启后重新采集' : `${MONITOR_NAMES[marketRead]}监控已关闭，行情采集与自动告警已暂停；开启后恢复` });
    }
    // M-4a: the perpetual table (whole), its summary, and the SSE stream of patches (frames as the workbench's).
    const perpetualRoute = request.method === 'GET' ? /^\/api\/monitor\/perpetual\/(quote|summary|stream)$/.exec(url.pathname)?.[1] : undefined;
    if (perpetualRoute) {
      if (!views?.monitor) return send(response, 404, { code: 'not_found', message: '本服务没有配置行情监控' });
      const perpetual = views.monitor.state().markets.includes('perpetual') ? views.monitor.perpetual?.() : undefined;
      if (!perpetual) return send(response, 404, { code: 'not_found', message: '本服务没有配置合约价差行情监控' });
      if (perpetualRoute === 'stream') return perpetual.stream(request, response);
      return send(response, 200, perpetualRoute === 'quote' ? perpetual.snapshot() : perpetual.summary());
    }
    // M-5a: the workbench's depth / exit (POST) and fx (GET) actions — one public read each, refused with the venue's reason.
    // M-5b1: metrics (POST) — the cached 24h volume and open interest of up to 30 pairs, registered for the 30 s refresh.
    // M-5b2: funding-history and scanner-data (POST) — the cached settled-funding histories, and the range filters' and full
    // sorting's summary (metrics plus net window totals), of up to 30 pairs each.
    // M-5c: price-history (POST) — the cached hourly trade closes of one pair's two legs for the pair chart.
    // M-5d2: quality (POST) — the collected quality evidence (stability, convergence, fundamentals, long/short) of up to 30 pairs.
    const inspection = /^\/api\/monitor\/perpetual\/(depth|exit|fx|metrics|funding-history|scanner-data|price-history|quality)$/.exec(url.pathname)?.[1];
    if (inspection && request.method === (inspection === 'fx' ? 'GET' : 'POST')) {
      if (!views?.monitor) return send(response, 404, { code: 'not_found', message: '本服务没有配置行情监控' });
      const perpetual = views.monitor.state().markets.includes('perpetual') ? views.monitor.perpetual?.() : undefined;
      const read = inspection === 'fx' ? perpetual?.fx?.bind(perpetual) : inspection === 'depth' ? perpetual?.depth?.bind(perpetual) : inspection === 'metrics' ? perpetual?.marketMetrics?.bind(perpetual)
        : inspection === 'funding-history' ? perpetual?.fundingHistory?.bind(perpetual) : inspection === 'scanner-data' ? perpetual?.scannerData?.bind(perpetual)
        : inspection === 'price-history' ? perpetual?.priceHistory?.bind(perpetual) : inspection === 'quality' ? perpetual?.quality?.bind(perpetual) : perpetual?.exit?.bind(perpetual);
      if (!read) return send(response, 404, { code: 'not_found', message: '本服务没有配置合约价差行情监控' });
      const body = inspection === 'fx' ? undefined : await readJson(request);
      try { return send(response, 200, await read(body)); }
      catch (error) {
        const status = (error as { status?: unknown })?.status;
        const code = status === 429 ? 'rate_limited' : status === 409 ? 'identity_changed' : status === 400 ? 'invalid_request' : status === 503 ? 'unavailable' : status === 500 ? 'internal_error' : 'upstream_error';
        return send(response, typeof status === 'number' && status >= 400 && status < 600 ? status : 502, { code, message: error instanceof Error ? error.message : inspection === 'metrics' ? '市场指标读取失败' : inspection === 'funding-history' ? '历史资金费读取失败' : inspection === 'scanner-data' ? '筛选数据读取失败' : inspection === 'price-history' ? '成交价历史读取失败' : inspection === 'quality' ? '质量资料读取失败' : '盘口查询失败' });
      }
    }
    // M-5e1: the paper positions (the workbench's paper action): GET the view, POST create / update / close / delete at a
    // revision, answering the new view. The service's 400 / 404 / 409 / 503 as they are; the exit calculator's input checks
    // (plain Errors) 400 as the workbench answers them; anything else 500. This relies on the service wrapping its own failures
    // (save errors become 503): when the vendored service is updated, check it throws no plain Error for an internal fault.
    if (url.pathname === '/api/monitor/perpetual/paper' && (request.method === 'GET' || request.method === 'POST')) {
      if (!views?.monitor) return send(response, 404, { code: 'not_found', message: '本服务没有配置行情监控' });
      const perpetual = views.monitor.state().markets.includes('perpetual') ? views.monitor.perpetual?.() : undefined;
      if (!perpetual?.paperView || !perpetual.paperUpdate) return send(response, 404, { code: 'not_found', message: '本服务没有配置合约价差行情监控' });
      if (request.method === 'GET') return send(response, 200, perpetual.paperView());
      const body = await readJson(request);
      try { return send(response, 200, await perpetual.paperUpdate(body)); }
      catch (error) {
        const raw = (error as { status?: unknown })?.status;
        const status = raw === 400 || raw === 404 || raw === 409 || raw === 503 ? raw : raw === undefined && error instanceof Error && error.constructor === Error ? 400 : 500;
        const code = status === 400 ? 'invalid_request' : status === 404 ? 'not_found' : status === 409 ? 'conflict' : status === 503 ? 'unavailable' : 'internal_error';
        return send(response, status, { code, message: status === 500 ? '持仓记录处理失败' : error instanceof Error ? error.message : '持仓记录处理失败' });
      }
    }
    const alertRoute = /^\/api\/monitor\/(oil|hynix)\/alerts(\/test)?$/.exec(url.pathname);
    if (alertRoute && (request.method === 'GET' ? !alertRoute[2] : request.method === 'POST')) {
      const market = alertRoute[1] as 'oil' | 'hynix', name = MONITOR_NAMES[market];
      if (!views?.monitor) return send(response, 404, { code: 'not_found', message: '本服务没有配置行情监控' });
      const alerts = views.monitor.state().markets.includes(market) ? views.monitor.alerts?.(market) : undefined;
      if (!alerts) return send(response, 404, { code: 'not_found', message: `本服务没有配置${name}行情监控` });
      if (request.method === 'GET') return send(response, 200, alerts.view());
      const body = await readJson(request);
      if (!alertRoute[2]) return send(response, 200, alerts.update(body));
      exactKeys(body, []);
      return send(response, 200, await alerts.test());
    }
    // M-3d: the Variational token. The state never carries the token; a save is checked with Variational before it replaces the old one.
    if (url.pathname === '/api/monitor/oil/exchanges/variational/session' && (request.method === 'GET' || request.method === 'POST')) {
      if (!views?.monitor) return send(response, 404, { code: 'not_found', message: '本服务没有配置行情监控' });
      const session = views.monitor.state().markets.includes('oil') ? views.monitor.variationalSession?.() : undefined;
      if (!session) return send(response, 404, { code: 'not_found', message: '本服务没有配置原油行情监控' });
      if (request.method === 'GET') return send(response, 200, session.view());
      return send(response, 200, await session.update(await readJson(request)));
    }
    const exchangeRoute = request.method === 'GET' ? /^\/api\/monitor\/(oil|hynix)\/exchanges\/([a-z]{1,20})$/.exec(url.pathname) : null;
    if (exchangeRoute) {
      const market = exchangeRoute[1] as 'oil' | 'hynix', exchange = exchangeRoute[2]!, name = MONITOR_NAMES[market];
      if (!views?.monitor) return send(response, 404, { code: 'not_found', message: '本服务没有配置行情监控' });
      if (!views.monitor.state().markets.includes(market)) return send(response, 404, { code: 'not_found', message: `本服务没有配置${name}行情监控` });
      if (!supportsExchange(market, exchange)) return send(response, 404, { code: 'not_found', message: `${name}交易所对比不支持 ${exchange}` });
      const read = views.monitor.exchange?.(market, exchange as Exchange);
      if (read === undefined) return send(response, 404, { code: 'not_found', message: `本服务没有配置${name}行情监控` });
      try { return send(response, 200, await read); }
      // The reader's reasons are short Chinese texts that never carry upstream content.
      catch (error) { return send(response, 503, { code: 'exchange_unavailable', message: error instanceof Error ? error.message : '交易所行情暂不可用' }); }
    }
    const historyRoute = request.method === 'GET' ? /^\/api\/monitor\/(oil|hynix)\/exchanges\/([a-z]{1,20})\/funding-history$/.exec(url.pathname) : null;
    if (historyRoute) {
      const market = historyRoute[1] as 'oil' | 'hynix', exchange = historyRoute[2]!, name = MONITOR_NAMES[market];
      if (!views?.monitor) return send(response, 404, { code: 'not_found', message: '本服务没有配置行情监控' });
      if (!views.monitor.state().markets.includes(market)) return send(response, 404, { code: 'not_found', message: `本服务没有配置${name}行情监控` });
      if (!supportsFundingHistory(market, exchange)) return send(response, 404, { code: 'not_found', message: `${name}结算历史不支持 ${exchange}` });
      const read = views.monitor.fundingHistory?.(market, exchange as Exchange);
      if (read === undefined) return send(response, 404, { code: 'not_found', message: `本服务没有配置${name}行情监控` });
      try { return send(response, 200, await read); }
      // The reader's reasons are short Chinese texts that never carry upstream content.
      catch (error) { return send(response, 503, { code: 'funding_history_unavailable', message: error instanceof Error ? error.message : '历史结算暂不可用' }); }
    }
    const fundingRoute = request.method === 'GET' ? /^\/api\/monitor\/(oil|hynix)\/funding$/.exec(url.pathname) : null;
    if (fundingRoute) {
      const market = fundingRoute[1] as 'oil' | 'hynix', name = MONITOR_NAMES[market];
      if (!views?.monitor) return send(response, 404, { code: 'not_found', message: '本服务没有配置行情监控' });
      const funding = views.monitor.state().markets.includes(market) ? views.monitor.funding?.(market) : undefined;
      if (funding === undefined) return send(response, 404, { code: 'not_found', message: `本服务没有配置${name}行情监控` });
      const notReady = funding === null ? null : (funding as { notReady?: unknown }).notReady;
      if (funding !== null && notReady === undefined) return send(response, 200, funding);
      // The reason is the collector's short Chinese text, never upstream content.
      return typeof notReady === 'string'
        ? send(response, 503, { code: 'funding_unavailable', message: `尚未取得${name}历史资金费（${notReady}），下一轮自动重试` })
        : send(response, 503, { code: 'not_ready', message: `尚未取得${name}历史资金费，后台正在回补` });
    }
    if (request.method === 'GET' && MONITOR_PATHS.has(url.pathname)) {
      if (!views?.monitor) return send(response, 404, { code: 'not_found', message: '本服务没有配置行情监控' });
      if (url.pathname === '/api/monitor/state') return send(response, 200, views.monitor.state());
      const [, , , market, read] = url.pathname.split('/') as [string, string, string, CandleMarket, 'quote' | 'candles'];
      const name = MONITOR_NAMES[market];
      // A market this service does not run answers 404 before its parameters are checked.
      if (!views.monitor.state().markets.includes(market)) return send(response, 404, { code: 'not_found', message: `本服务没有配置${name}行情监控` });
      if (read === 'quote') {
        const quote = views.monitor.quote(market);
        if (quote === undefined) return send(response, 404, { code: 'not_found', message: `本服务没有配置${name}行情监控` });
        return quote === null ? send(response, 503, { code: 'not_ready', message: `尚未取得${name}报价，后台正在采集` }) : send(response, 200, quote);
      }
      const days = url.searchParams.get('days');
      if (days !== null && (!/^[1-9]\d{0,2}$/.test(days) || Number(days) > MONITOR_MAX_DAYS)) return send(response, 400, { code: 'invalid_days', message: `days 须为 1–${MONITOR_MAX_DAYS} 的整数` });
      const candles = views.monitor.candles(market, days === null ? null : Number(days));
      if (candles === undefined) return send(response, 404, { code: 'not_found', message: `本服务没有配置${name}行情监控` });
      return candles === null ? send(response, 503, { code: 'not_ready', message: `尚未取得${name} K 线，后台正在采集` }) : send(response, 200, candles);
    }
    if (request.method === 'GET' && url.pathname.startsWith('/api/asset/')) {
      const asset = views?.asset;
      if (!asset) return send(response, 404, { code: 'not_found', message: '本服务没有配置资产账本' });
      // A database that cannot be read answers with its reason rather than the generic internal error.
      const read = async <T>(run: () => Promise<T>): Promise<T> => {
        try { return await run(); }
        catch (error) {
          // A JSON parse error quotes the text it failed on; the stored data stays out of the answer.
          const reason = error instanceof SyntaxError ? '库里有一项数据格式无效，请重新导入' : error instanceof Error ? error.message.slice(0, 200) : String(error);
          throw new ContractError(500, 'asset_unreadable', `资产账本读取失败：${reason}`);
        }
      };
      if (url.pathname === '/api/asset/period') {
        const id = url.searchParams.get('id') ?? '';
        if (!ASSET_PERIOD_ID.test(id)) return send(response, 400, { code: 'invalid_id', message: '记录编号无效' });
        const period = await read(() => asset.period(id));
        return period ? send(response, 200, period) : send(response, 404, { code: 'not_found', message: '未找到记录' });
      }
      const view = Object.hasOwn(ASSET_READS, url.pathname) ? ASSET_READS[url.pathname as keyof typeof ASSET_READS] : null;
      if (!view) return send(response, 404, { code: 'not_found', message: '不存在' });
      return send(response, 200, await read<unknown>(() => asset[view]()));
    }
    if (request.method === 'POST' && Object.hasOwn(ASSET_WRITES, url.pathname)) {
      const asset = views?.asset;
      if (!asset) return send(response, 404, { code: 'not_found', message: '本服务没有配置资产账本' });
      const body = await readJson(request);
      try {
        switch (ASSET_WRITES[url.pathname as keyof typeof ASSET_WRITES]) {
          case 'edit': return send(response, 200, await asset.editAsset(body));
          case 'fx': return send(response, 200, await asset.editFx(body));
          case 'add': return send(response, 200, await asset.saveWithdrawal(body, false));
          case 'change': return send(response, 200, await asset.saveWithdrawal(body, true));
          case 'delete': return send(response, 200, await asset.deleteWithdrawal(body));
          case 'cashFlow': return send(response, 200, await asset.saveCashFlow(body));
          case 'sync': return send(response, 200, await asset.sync(body));
          case 'connect': return send(response, 200, await asset.connect(body));
          case 'disconnect': return send(response, 200, await asset.disconnect(body));
          case 'asterAdd': return send(response, 200, await asset.saveAsterAccount(body, false));
          case 'asterEdit': return send(response, 200, await asset.saveAsterAccount(body, true));
          case 'asterDelete': return send(response, 200, await asset.deleteAsterAccount(body));
        }
      } catch (error) { throw assetWriteError(error); }
    }
    if (url.pathname.startsWith('/api/options/')) {
      if (!views?.options) return send(response, 404, { code: 'not_found', message: '本服务没有配置期权模块' });
      const options = views.options, path = url.pathname.slice('/api/options/'.length);
      if (request.method === 'GET' && path === 'market') return send(response, 200, options.market(url.searchParams.get('expiry')));
      if (request.method === 'GET' && path === 'preview') return send(response, 200, options.preview(url.searchParams.get('quantity'), url.searchParams.get('mode')));
      if (request.method === 'GET' && path === 'state') return send(response, 200, options.state());
      if (request.method === 'GET' && path === 'performance') return send(response, 200, options.performance());
      if (request.method === 'POST' && path === 'plans') return send(response, 200, await options.plan(await readJson(request)));
      if (request.method === 'POST' && path === 'tasks') return send(response, 200, await options.start(await readJson(request)));
      const stop = request.method === 'POST' ? /^tasks\/([0-9a-f]{16})\/stop$/.exec(path) : null;
      if (stop) return send(response, 200, options.stop(stop[1]!, await readJson(request)));
      if (request.method === 'POST' && path === 'auto-open') return send(response, 200, options.autoOpen(await readJson(request)));
      if (request.method === 'GET' && path === 'rfq') return send(response, 200, options.rfq());
      if (request.method === 'POST' && path === 'rfq') return send(response, 200, await options.rfqCreate(await readJson(request)));
      if (request.method === 'POST' && path === 'rfq/execute') return send(response, 200, await options.rfqExecute(await readJson(request)));
      if (request.method === 'POST' && path === 'rfq/cancel') return send(response, 200, await options.rfqCancel(await readJson(request)));
      return send(response, 404, { code: 'not_found', message: '不存在' });
    }
    if (url.pathname.startsWith('/api/crossex/')) {
      if (!views?.crossex) return send(response, 404, { code: 'not_found', message: '本服务没有配置 CrossEx 模块' });
      // The check above covers POST; settings also takes PUT (the workbench's method), which needs the same marker.
      if (request.method === 'PUT' && (request.headers['x-pa-executor'] !== '1' || !String(request.headers['content-type'] ?? '').startsWith('application/json'))) return send(response, 403, { code: 'csrf', message: '缺少本页面请求标记' });
      const crossex = views.crossex, path = url.pathname.slice('/api/crossex/'.length);
      try {
        if (request.method === 'GET' && path === 'state') return send(response, 200, crossex.state(url.searchParams.get('opportunities') !== '0', url.searchParams.get('funding') === '1'));
        if (request.method === 'GET' && path === 'bootstrap') return send(response, 200, crossex.bootstrap());
        if ((request.method === 'PUT' || request.method === 'POST') && path === 'settings') return send(response, 200, crossex.settings(await readJson(request)));
        if (request.method === 'POST' && path === 'refresh') { await readJson(request); return send(response, 200, await crossex.refresh()); }
        if (request.method === 'GET' && path === 'instruments') return send(response, 200, await crossex.instruments());
        if (request.method === 'GET' && path === 'market') return send(response, 200, await crossex.market(url.searchParams.get('symbol'), url.searchParams.get('interval') || '5m'));
        if (request.method === 'POST' && path === 'preview') return send(response, 200, await crossex.preview(await readJson(request)));
        if (request.method === 'POST' && path === 'open-capacity') return send(response, 200, await crossex.openCapacity(await readJson(request)));
        if (request.method === 'POST' && path === 'confirm') return send(response, 200, await crossex.confirm(await readJson(request)));
        if (request.method === 'POST' && path === 'cancel') return send(response, 200, await crossex.cancel(await readJson(request)));
        if (request.method === 'GET' && path.startsWith('requests/')) {
          let id: string;
          try { id = decodeURIComponent(path.slice('requests/'.length)); } catch { return send(response, 400, { code: 'crossex', message: '请求编号无效' }); }
          return send(response, 200, await crossex.request(id));
        }
      } catch (error) {
        if (error instanceof ContractError) throw error;
        const failure = crossex.failure(error);
        // Anything not raised as the runtime's own error is answered with a fixed text (it may carry internals) and logged.
        if (failure.internal) process.stderr.write(`CrossEx 接口 ${path} 出错：${error instanceof Error ? error.message.slice(0, 200) : '未知错误'}\n`);
        return send(response, failure.status, failure.body);
      }
      return send(response, 404, { code: 'not_found', message: '不存在' });
    }
    if (request.method === 'GET' && (url.pathname === '/api/logs' || url.pathname === '/api/logs/problems')) {
      if (!views?.logs) return send(response, 404, { code: 'not_found', message: '本服务没有页面日志' });
      const before = url.searchParams.get('before'), limit = url.searchParams.get('limit');
      if (before !== null && !/^[1-9]\d{0,14}$/.test(before)) return send(response, 400, { code: 'invalid_cursor', message: '翻页位置无效' });
      if (limit !== null && (!/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 200)) return send(response, 400, { code: 'invalid_limit', message: '每页条数须为 1–200' });
      return send(response, 200, views.logs(url.pathname === '/api/logs' ? 'all' : 'problems', before === null ? null : Number(before), limit === null ? 100 : Number(limit)));
    }
    const pairRead = request.method === 'GET' ? PAIR_READ_PATH.exec(url.pathname) : null;
    if (pairRead?.[2] === 'history') {
      return send(response, 200, executor.transferHistory(pairRead[1]!, parsePage(url.searchParams.get('before'), url.searchParams.get('limit'), TRANSFER_PAGE_MAX, 20)));
    }
    if (pairRead?.[2] === 'balances') {
      if (!views?.balanceHistory) return send(response, 404, { code: 'not_found', message: '本服务没有余额走势' });
      const history = views.balanceHistory(pairRead[1]!, url.searchParams.get('range') ?? '24h');
      return history === null ? send(response, 400, { code: 'invalid_range', message: '时间范围无效' }) : send(response, 200, history);
    }
    const adlHistory = request.method === 'GET' ? ADL_HISTORY_PATH.exec(url.pathname) : null;
    if (adlHistory) return send(response, 200, executor.adlHistory(adlHistory[1]!, parsePage(url.searchParams.get('before'), url.searchParams.get('limit'), ADL_PAGE_MAX, 10)));
    if (request.method === 'POST' && (url.pathname === '/api/summary/interval' || url.pathname === '/api/summary/send')) {
      if (!views?.summary) return send(response, 404, { code: 'not_found', message: '本服务没有定时运行摘要' });
      if (url.pathname === '/api/summary/send') { exactKeys(await readJson(request), []); return send(response, 200, views.summary.sendNow()); }
      const { intervalMinutes } = exactKeys(await readJson(request), ['intervalMinutes']);
      if (typeof intervalMinutes !== 'number') return send(response, 400, { code: 'summary_interval', message: '间隔须为整数分钟' });
      return send(response, 200, views.summary.setInterval(intervalMinutes));
    }
    if (url.pathname === '/api/import') {
      if (!imports) return send(response, 404, { code: 'not_found', message: '本服务没有开启页面导入' });
      if (request.method === 'GET') return send(response, 200, { result: imports.latest() });
      if (request.method === 'POST') return send(response, 200, imports.submit(await readJson(request)));
    }
    if (request.method === 'GET' && url.pathname === '/api/observe') {
      const venue = url.searchParams.get('venue') ?? '', symbol = url.searchParams.get('symbol') ?? '';
      if (!(VENUES as readonly string[]).includes(venue)) return send(response, 400, { code: 'venue', message: '交易所无效' });
      return send(response, 200, await executor.observe(venue as Venue, symbol));
    }
    if (request.method === 'POST' && url.pathname === '/api/preview') return send(response, 200, executor.publicPreview(await executor.preview(await readJson(request), sessionId)));
    if (request.method === 'POST' && url.pathname === '/api/confirm') return send(response, 200, executor.confirm(await readJson(request), sessionId));
    const pair = request.method === 'POST' ? PAIR_PATH.exec(url.pathname) : null;
    if (pair) {
      const body = exactKeys(await readJson(request), ['requestId']);
      return send(response, 200, await executor.setTransferEnabled({ pairId: pair[1], enabled: pair[2] === 'enable', requestId: body.requestId }, sessionId));
    }
    const pairConfig = request.method === 'POST' ? PAIR_CONFIG_PATH.exec(url.pathname) : null;
    if (pairConfig) {
      // `expected` is the stored settings the page's draft started from; a mismatch is refused as changed elsewhere.
      const { requestId, expected, ...config } = exactKeys(await readJson(request), ['requestId', 'expected', ...TRANSFER_CONFIG_KEYS]);
      return send(response, 200, executor.setTransferConfig({ pairId: pairConfig[1], requestId, expected, config }, sessionId));
    }
    const adlConfig = request.method === 'POST' ? ADL_CONFIG_PATH.exec(url.pathname) : null;
    if (adlConfig) {
      const body = exactKeys(await readJson(request), ['requestId', 'autoReduce', 'batchNotional']);
      return send(response, 200, executor.setAdlConfig({ pairId: adlConfig[1], ...body }, sessionId));
    }
    const adlRestart = request.method === 'POST' ? ADL_RESTART_PATH.exec(url.pathname) : null;
    if (adlRestart) {
      const body = exactKeys(await readJson(request), ['requestId']);
      return send(response, 200, executor.restartAdl({ incidentId: adlRestart[1], requestId: body.requestId }, sessionId));
    }
    const match = UUID_PATH.exec(url.pathname);
    // The path match is case-insensitive, so the action is compared lowercased; otherwise /STOP would fall through to acknowledge.
    const action = match?.[2]?.toLowerCase();
    if (match && request.method === 'GET' && !action) return send(response, 200, executor.jobView(match[1]));
    if (match && request.method === 'POST' && action === 'adopt-strategy') {
      const body = exactKeys(await readJson(request), ['requestId', 'strategyId']);
      return send(response, 200, await executor.adoptStrategy({ jobId: match[1], requestId: body.requestId, strategyId: body.strategyId }, sessionId));
    }
    if (match && request.method === 'POST' && action === 'confirm-not-created') {
      const body = exactKeys(await readJson(request), ['requestId']);
      return send(response, 200, await executor.confirmNotCreated({ jobId: match[1], requestId: body.requestId }, sessionId));
    }
    if (match && request.method === 'POST' && action === 'release-strategy') {
      const body = exactKeys(await readJson(request), ['requestId'], ['acknowledgeRisk']);
      return send(response, 200, executor.releaseStrategy({ jobId: match[1], requestId: body.requestId, acknowledgeRisk: body.acknowledgeRisk }, sessionId));
    }
    if (match && request.method === 'POST' && (action === 'stop' || action === 'acknowledge')) {
      const body = await readJson(request) as { requestId?: unknown } | null;
      const requestId = typeof body?.requestId === 'string' ? body.requestId : '';
      return send(response, 200, action === 'stop' ? executor.requestStop(match[1], requestId, sessionId) : executor.acknowledge(match[1], requestId, sessionId));
    }
    return send(response, 404, { code: 'not_found', message: '不存在' });
  }

  return createServer((request, response) => {
    route(request, response).catch((error: unknown) => {
      if (response.headersSent) { response.destroy(); return; }
      if (error instanceof ContractError) send(response, error.status, { code: error.code, message: error.message }, error.status === 413 ? { connection: 'close' } : {});
      else send(response, 500, { code: 'internal', message: '执行器内部错误' });
    });
  });
}
