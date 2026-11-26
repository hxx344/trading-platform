// Local HTTP surface for the minimal page. It binds to loopback, or to one address the operator chose (a Tailscale IP),
// checks the Host header against DNS rebinding, hands the session cookie out only in exchange for the access token
// written to the data directory or for the login password, and requires that cookie plus a custom header on every
// write, so neither another site nor another process that merely reaches the port can drive it.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { ContractError, TRANSFER_CONFIG_KEYS, VENUES, exactKeys, parsePage, type Venue } from './contracts.ts';
import type { Executor } from './executor.ts';
import { APP_HEADERS, CLIENT_ADDRESS_HEADER, CONFIG_CHECK_HEADER, CONFIG_MATCH_HEADER, CONTROL_HEADER, EXECUTION_HEADER, LEGACY_UPDATE_HEADER, LISTEN_HEADER, PAGE_HEADERS, controlRoute, readJson, sendJson, sendJsonText, sendWebAsset, sessionCookieName } from './http-public.ts';
import { GLOBAL_LOGIN_LIMITS, LoginThrottle, MAX_PASSWORD_LENGTH, verifyPassword, type PasswordHash, type ThrottleLimits } from './login-password.ts';
import { openSessionStore, type SessionInfo, type SessionStore } from './sessions.ts';
import { READ_SCOPE_NAMES, READ_TOKEN_MAX_BYTES, ReadTokenError, readTokenNewsView, readTokenScope, readTokenSystemStatus, readTokenUpdateView, type ReadScope, type ReadTokens } from './read-token.ts';
import type { Redactor } from './read-redact.ts';
import type { WebApp } from './web-assets.ts';
import type { UpdateView } from './service/update-types.ts';
import { ANTHROPIC_RETENTION_DAYS } from './vendor/anthropic-market.mjs';
import { encodeCandleBlocks } from './candle-blocks-server.ts';
import { isDisplayRead, READ_CACHE, ReadViewCache, versionLength } from './read-view.ts';
import { readViewReply } from './read-view-server.ts';
import { monitorScopes, type ShellView } from './shell-view.ts';
import { MONITOR_CANDLE_BLOCK_MS, monitorCandleField, type MonitorCandleUpdate } from './monitor/candle-window.ts';
import { supportsExchange, type Exchange } from './vendor/exchange-comparison.mjs';
import { supportsFundingHistory } from './vendor/exchange-funding-history.mjs';
import type { AssetStore } from './asset/store.ts';
import type { CrossexViews } from './service/crossex.ts';
import type { OndoViews } from './service/ondo.ts';
import { DexOutcomeUnknown } from './dex/ipc.ts';
import type { DexForward } from './service/dex.ts';
import type { MevViews } from './service/mev.ts';
import { AssetConflict } from './asset/sync-lock.ts';
import { AssetInputError, INPUT_INVALID } from './asset/validation.ts';
import { AssetBackupError } from './asset/source-import.ts';
import { IMPORT_MAX_BYTES } from './asset/source-ledger.ts';
import { fillsQueryMarket } from './asset/fills-service.ts';

export { sessionCookieName } from './http-public.ts';

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
const MONITOR_PATHS = new Set(['/api/monitor/state', '/api/monitor/anthropic/quote', '/api/monitor/anthropic/candles', '/api/monitor/oil/quote', '/api/monitor/oil/candles', '/api/monitor/goldoil/quote', '/api/monitor/goldoil/candles', '/api/monitor/hynix/quote', '/api/monitor/hynix/candles']);
const MONITOR_NAMES = { anthropic: 'Anthropic', oil: '原油', goldoil: '金油比', hynix: '海力士', perpetual: '合约价差' } as const;
type CandleMarket = Exclude<keyof typeof MONITOR_NAMES, 'perpetual'>;
const MONITOR_MAX_DAYS = ANTHROPIC_RETENTION_DAYS;
const ASSET_READS = { '/api/asset/state': 'state', '/api/asset/ledger': 'ledger', '/api/asset/history': 'history', '/api/asset/daily-changes': 'dailyChanges', '/api/asset/withdrawals': 'withdrawals', '/api/asset/cash-flows': 'cashFlows' } as const;
const ASSET_PERIOD_ID = /^[0-9A-Za-z-]{1,80}$/;
const ASSET_WRITES = { '/api/asset/assets/edit': 'edit', '/api/asset/fx': 'fx', '/api/asset/withdrawals/add': 'add', '/api/asset/withdrawals/edit': 'change', '/api/asset/withdrawals/delete': 'delete', '/api/asset/cash-flows': 'cashFlow',
  // A-3/A-4: the sync and the connections.
  '/api/asset/sync': 'sync', '/api/asset/connections': 'connect', '/api/asset/connections/delete': 'disconnect',
  '/api/asset/aster-accounts/add': 'asterAdd', '/api/asset/aster-accounts/edit': 'asterEdit', '/api/asset/aster-accounts/delete': 'asterDelete',
  // A-6: the workbook import (the workbench's POST /api/import); its body may be up to IMPORT_MAX_BYTES.
  '/api/asset/import': 'import',
} as const;
const IMPORT_TOO_LARGE = '导入文件不能超过 5 MB';
/** The workbench's database and network failures (modules/asset/lib/api.ts failure at 0014655). */
const ASSET_UNAVAILABLE = /D1_|SQLITE|decrypt|OperationError|fetch failed|network|aborted|timeout/i;
/**
 * A failed asset write as the workbench answers it (lib/api.ts failure), with this service's codes: invalid input 400
 * with one fixed text, a refusal because of the ledger's state 409, a database error 503 without its SQL or text, an
 * edit refused by a ledger rule 400 with its message. Stored data that no longer parses is 500 like the reads.
 */
function assetWriteError(error: unknown): ContractError {
  if (error instanceof AssetInputError) return new ContractError(400, 'invalid_input', INPUT_INVALID);
  if (error instanceof AssetBackupError) return new ContractError(503, 'backup_failed', error.message);
  if (error instanceof AssetConflict) return new ContractError(409, error.code, error.message);
  if (error instanceof Error && ((error as NodeJS.ErrnoException).code === 'ERR_SQLITE_ERROR' || ASSET_UNAVAILABLE.test(error.message))) return new ContractError(503, 'asset_unavailable', '服务暂时不可用，已保留上次数据，请稍后重试');
  if (error instanceof SyntaxError) return new ContractError(500, 'asset_unreadable', '资产账本读取失败：库里有一项数据格式无效，请重新导入');
  // Only the ledger rules throw plain Errors; anything else (a TypeError) is a defect and stays the generic 500.
  if (error instanceof Error && error.constructor === Error) return new ContractError(400, 'asset_rejected', error.message.slice(0, 200));
  return new ContractError(500, 'internal', '执行器内部错误');
}

const LOGIN_REQUIRED = '<!doctype html><meta charset="utf-8"><title>需要登录</title><p>请使用数据目录 access-url 中的登录链接打开（用 sudo bash install.sh --set-password 设置登录密码后可直接输入密码）。</p>';
const loginForm = (notice: string): string => '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>登录</title>'
  + '<style>body{font:15px/1.5 system-ui,sans-serif;max-width:22rem;margin:4rem auto;padding:0 1rem}input,button{font:inherit;padding:.45rem .6rem;width:100%;box-sizing:border-box;margin:.3rem 0}.notice{color:#b42318}</style>'
  + '<h1>统一交易平台</h1><form method="post" action="/login"><label>登录密码<input type="password" name="password" autocomplete="current-password" required autofocus maxlength="' + 2 * MAX_PASSWORD_LENGTH + '"></label><button>登录</button></form>'
  + (notice ? `<p class="notice">${notice}</p>` : '');

/** The page's workbench import (the ASTER service only): leaves a request for the root helper and reads its answer. */
export interface ImportChannel { submit(body: unknown): { id: string; at: number }; latest(): unknown; legacyUpdate?(): UpdateView['job'] }

/** Read-only views a service adds to the page: its run status and its balance history. */
export interface ServiceViews {
  status?(): Record<string, unknown>;
  /** Server load and what the service is connected to, for the page's top bar (host-status.ts). */
  host?(): Promise<unknown>;
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
  /** SK hynix trading on the oil accounts (docs/hynix.md): books and premium; accounts, positions, hynix jobs, the legs' balance. Absent without oil. */
  hynix?: {
    market(): unknown; state(): unknown;
    /** The balance thresholds (docs/hynix.md 7.4); a store that could not open refuses with 503. */
    saveBalanceSettings?(body: unknown): unknown;
  };
  /** Gold against oil on the oil accounts (docs/goldoil.md): books and ratios; accounts, positions, gold-oil jobs. Absent without oil. */
  goldoil?: { market(): unknown; state(): unknown };
  /** The read-only market monitors; a market's reads give undefined when it is not configured and null until there is data. Absent without config.monitor. */
  monitor?: {
    state(): { markets: readonly string[]; controls?: Partial<Record<keyof typeof MONITOR_NAMES, { enabled: boolean; revision: number }>> }; quote(market: CandleMarket): unknown; candles(market: CandleMarket, days: number | null): unknown;
    /** The settled funding history of oil or Hynix (M-2d); before any settlement `{ notReady: <reason> | null }`. */
    funding?(market: 'oil' | 'hynix'): unknown;
    /** M-2c: one exchange's comparison row, read on demand; undefined when the market is not configured; rejects with the page's reason. */
    exchange?(market: 'oil' | 'hynix', exchange: Exchange): Promise<unknown> | undefined;
    /** M-2d-3: one exchange's settled funding history (60 days, both legs); undefined when the market is not configured; rejects with the page's reason. */
    fundingHistory?(market: 'oil' | 'hynix', exchange: Exchange): Promise<unknown> | undefined;
    /** M-3a: the market's threshold alerts; undefined when the market is not configured (or the service runs without alerts). */
    alerts?(market: 'oil' | 'goldoil' | 'hynix'): { view(): unknown; update(body: unknown): unknown; test(): Promise<unknown> } | undefined;
    /** M-3c: false for a configured market switched off (its reads answer 423); the page's switch. */
    enabled?(market: keyof typeof MONITOR_NAMES): boolean;
    chainArb?(input: unknown, signal: AbortSignal): Promise<unknown>;
    scanChainArb?(input: unknown, scope: string, signal: AbortSignal): Promise<unknown>;
    chainArbBackground?: { view(): unknown; update(body: unknown): unknown; enabled(): boolean };
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
  /** The Ondo maker-reward module (service/ondo.ts, docs/ondo.md); absent without config.ondo. */
  ondo?: OndoViews;
  /** The online update (service/update.ts): versions, a manual check, and the request to the root update helper. */
  update?: { status(): unknown; check(): Promise<unknown>; apply(body: unknown): unknown };
  /** EQN 快讯与异动行情（service/news.ts，docs/news.md）；config.json 写了 `"news": false` 时没有。读取在连接开始前为 null。 */
  news?: { flash(): { items: readonly { url: string | null }[] } | null; moves(): { items: readonly { url: string | null }[] } | null };
  /** DEX 价差（docs/dexspread.md 第 11 节）：转发给 DEX 价差服务；config.json 写了 `"varLighter": false` 或没有 DEX 套接字时没有。 */
  varlighter?: DexForward;
  /** MEV 套利（service/mev.ts，docs/mev.md）；执行服务总是提供，还没启用时只有启用向导的状态。 */
  mev?: MevViews;
}

/** accessToken is exchanged at /login for a session of its own, as is the password (sessions.ts). */
export interface HttpOptions {
  executor: Executor;
  accessToken: string;
  /** The page sessions; without them a store that lives as long as the server, holding `session` if given. */
  sessions?: SessionStore;
  /** A cookie value that is a session from the start, for a store made here (tests). */
  session?: string;
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
  /** The browser port when this server listens on the private control socket. */
  browserPort?: number;
  /** The executor component fingerprint of the running process, fixed until the next start. */
  executionBuild?: string;
  /** Fingerprint of the configuration, credentials and password actually loaded by this process. */
  configBuild?: string;
  /**
   * Answers the login-free GET /api/ready, which a watchdog on another host probes: true while the run is healthy.
   * Without it the path does not exist.
   */
  ready?: () => boolean;
  /**
   * Wrong passwords are counted per client address, so a guesser elsewhere cannot lock the owner out; a loose counter over
   * all addresses only slows a guesser who has many. Tests give the throttles a clock.
   */
  throttle?: (limits?: ThrottleLimits) => LoginThrottle;
  /**
   * The read-only API token (docs/mcp.md): without it a request with an Authorization header gets 401, as before.
   * Wrong tokens are counted per client address, apart from wrong passwords; tests give the throttles a clock.
   */
  readTokens?: ReadTokens;
  tokenThrottle?: () => LoginThrottle;
  log?: (line: string) => void;
}

const TOKEN_THROTTLES = 1_024;

// Hashing first gives equal-length inputs, so the comparison does not leak the token length either.
const sameSecret = (given: string, expected: string): boolean =>
  timingSafeEqual(createHash('sha256').update(given).digest(), createHash('sha256').update(expected).digest());

export function createExecutorServer({ executor, accessToken, sessions: given, session, page, app, imports, views, password, host, browserPort, executionBuild = 'development', configBuild, ready, throttle: makeThrottle = limits => new LoginThrottle(Date.now, limits), readTokens, tokenThrottle = () => new LoginThrottle(), log = line => process.stderr.write(`${line}\n`) }: HttpOptions): Server {
  if (!accessToken) throw new Error('需要访问令牌');
  if (session !== undefined && sameSecret(session, accessToken)) throw new Error('会话值不能与访问令牌相同');
  const sessions = given ?? openSessionStore({ seed: session === undefined ? [] : [session] });
  // The executor records which session asked for each command; it gets a digest, so the stored rows never hold the cookie.
  const requestSessions = new WeakMap<IncomingMessage, SessionInfo>();
  const sessionId = (request: IncomingMessage): string => {
    const found = requestSessions.get(request);
    if (!found) throw new ContractError(401, 'session', '需要登录');
    return found.id;
  };
  const privateSocket = browserPort !== undefined;
  const cookieName = (request: IncomingMessage) => sessionCookieName(browserPort ?? request.socket.localPort ?? 0);
  const clientAddress = (request: IncomingMessage): string => {
    const address = privateSocket ? request.headers[CLIENT_ADDRESS_HEADER] : request.socket.remoteAddress;
    return typeof address === 'string' && isIP(address) ? address : '未知地址';
  };
  const cookieValue = (request: IncomingMessage): string | undefined => {
    const name = cookieName(request);
    return (request.headers.cookie ?? '').split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1);
  };
  /** Whether the request carries a live session; the session is then remembered for the request (sessionId). */
  const authorized = (request: IncomingMessage): boolean => {
    const value = cookieValue(request);
    const found = value === undefined ? null : sessions.check(value);
    if (found) requestSessions.set(request, found);
    return found !== null;
  };
  // Loopback by any port (a tunnel may map it), the chosen address by itself or with a port.
  const allowedHost = (value: string): boolean => LOOPBACK.test(value) || (host !== undefined && (value === host || (value.startsWith(`${host}:`) && /^\d{1,5}$/.test(value.slice(host.length + 1)))));
  /** A new session for the browser, with its cookie; the one the browser still carried, if any, ends (it is replaced). */
  const sessionCookie = (request: IncomingMessage): string => {
    const previous = cookieValue(request);
    if (previous) sessions.remove(previous);
    return `${cookieName(request)}=${sessions.create()}; HttpOnly; SameSite=Strict; Path=/${sessions.maxAgeS ? `; Max-Age=${sessions.maxAgeS}` : ''}`;
  };
  const clearedCookie = (request: IncomingMessage): string => `${cookieName(request)}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
  // Wrong passwords per client address (at most TOKEN_THROTTLES of them, the oldest goes first), and a loose count over all.
  const loginThrottles = new Map<string, LoginThrottle>();
  const globalThrottle = makeThrottle(GLOBAL_LOGIN_LIMITS);
  const loginThrottleFor = (address: string): LoginThrottle => {
    let found = loginThrottles.get(address);
    if (!found) {
      found = makeThrottle();
      loginThrottles.set(address, found);
      if (loginThrottles.size > TOKEN_THROTTLES) loginThrottles.delete(loginThrottles.keys().next().value!);
    }
    return found;
  };
  const loginWaitMs = (address: string): number => Math.max(loginThrottleFor(address).waitMs(), globalThrottle.waitMs());
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
    const address = clientAddress(request), throttle = loginThrottleFor(address);
    const busy = () => loginPage(response, 429, `尝试次数过多，请 ${Math.max(1, Math.ceil(loginWaitMs(address) / 1000))} 秒后再试`);
    if (loginWaitMs(address) > 0) { request.resume(); return busy(); }
    // The body is read before taking the check, so a client that sends it slowly holds up nobody else.
    const form = await readForm(request);
    if (response.writableEnded || request.socket.destroyed) return;
    if (form === 'too-large') {
      response.writeHead(413, { ...PAGE_HEADERS, connection: 'close' });
      response.end('请求体过大', () => request.socket.destroy());
      return;
    }
    // One check at a time, so parallel guesses cannot outrun the counter.
    if (loginWaitMs(address) > 0 || verifying) return busy();
    verifying = true;
    let ok: boolean;
    try { ok = form !== null && await verifyPassword(form.get('password') ?? '', password); }
    finally { verifying = false; }
    if (!ok) {
      throttle.failed(); globalThrottle.failed();
      const locked = loginWaitMs(address);
      log(`页面登录密码错误（来自 ${address}）${locked ? `，已锁定 ${Math.ceil(locked / 1000)} 秒` : ''}`);
      return loginPage(response, 401, locked ? `密码错误，已锁定 ${Math.ceil(locked / 1000)} 秒` : '密码错误');
    }
    throttle.succeeded();
    const cookie = sessionCookie(request);
    log(`页面密码登录成功（来自 ${address}，当前 ${sessions.count()} 个会话）`);
    response.writeHead(303, { ...PAGE_HEADERS, location: '/', 'set-cookie': cookie });
    response.end();
  }
  // A read-only token's answers are masked and size-capped on their way out; a session's pass unchanged (docs/mcp.md 3).
  const tokenAnswers = new WeakMap<ServerResponse, { redact: Redactor; bytes: number; scopes: readonly ReadScope[] }>();
  const readViews = new ReadViewCache();
  const negotiated = new WeakMap<ServerResponse, { key: string; known: string }>();
  const monitorReads = new WeakMap<ServerResponse, { market: keyof typeof MONITOR_NAMES; revision?: number }>();
  const scanInstance = randomBytes(12).toString('hex');
  function negotiate(request: IncomingMessage, response: ServerResponse, url: URL, body?: unknown): void {
    const known = request.headers[READ_CACHE];
    if (typeof known !== 'string' || (known !== '1' && versionLength(known) < 0) || !isDisplayRead(request.method!, url.pathname)) return;
    const key = createHash('sha256').update(JSON.stringify([request.method, url.pathname, url.search, body])).digest('base64url');
    negotiated.set(response, { key, known });
  }
  const send = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
    const observation = monitorReads.get(response);
    if (observation && views?.monitor && status !== 401 && status !== 403) {
      const { market, revision } = observation;
      const state = views.monitor.state(), control = state.controls?.[market];
      if (!state.markets.includes(market)) { status = 404; body = { code: 'not_found', message: '该行情监控未配置' }; }
      else if (control?.enabled === false || views.monitor.enabled?.(market) === false) { status = 423; body = { code: 'monitor_disabled', message: '行情监控已关闭' }; }
      else if (revision !== control?.revision) { status = 409; body = { code: 'monitor_changed', message: '行情监控已重新开启，请重新读取' }; }
    }
    const answer = tokenAnswers.get(response);
    if (!answer) {
      const read = negotiated.get(response);
      if (read && status === 200) {
        const reply = readViewReply(readViews, read.key, read.known, body);
        return sendJsonText(response, reply.status, reply.text, { ...headers, ...reply.headers });
      }
      if (read && [401, 403, 404, 409, 423].includes(status)) readViews.delete(read.key);
      return sendJson(response, status, body, headers);
    }
    const payload = JSON.stringify(answer.redact(body));
    const bytes = Buffer.byteLength(payload);
    if (bytes > READ_TOKEN_MAX_BYTES) {
      const refusal = JSON.stringify({ code: 'too_large', message: `应答超过 ${READ_TOKEN_MAX_BYTES / 1024} KiB，请缩小查询范围（如减小 limit）` });
      answer.bytes = Buffer.byteLength(refusal);
      return sendJsonText(response, 413, refusal);
    }
    answer.bytes = bytes;
    sendJsonText(response, status, payload, headers);
  };
  /**
   * A request with an Authorization header (docs/mcp.md 3): never a session, only a valid token, only a GET on the
   * whitelist, within the limits. Each step answers on its own and the whitelist check comes before any route runs.
   */
  async function tokenRoute(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    request.resume();
    const started = performance.now();
    const address = clientAddress(request);
    let tokenId: string | null = null;
    // A locked address is answered without a log line, so wrong tokens cannot fill the log (as with the password).
    const throttle = throttleFor(address);
    const wait = throttle.waitMs();
    if (wait > 0) return sendJson(response, 429, { code: 'token_locked', message: `令牌错误次数过多，请 ${Math.ceil(wait / 1000)} 秒后再试` }, { 'retry-after': String(Math.ceil(wait / 1000)) });
    // One line per request, in the service log (logs.sqlite, 14 days); never the token itself. Only a request with the
    // valid token counts as a use on the page.
    response.once('close', () => {
      if (tokenId) readTokens?.record(tokenId);
      const bytes = tokenAnswers.get(response)?.bytes ?? Number(response.getHeader('content-length') ?? 0);
      const outcome = response.writableFinished ? `${response.statusCode}，${bytes} 字节` : '连接中断';
      log(`只读令牌${tokenId ? ` ${tokenId}` : '（无效）'} ${request.method ?? '?'} ${url.pathname} → ${outcome}，${Math.round(performance.now() - started)} ms（来自 ${address}）`);
    });
    if (request.headers.cookie !== undefined) return sendJson(response, 403, { code: 'token_cookie', message: '令牌请求不能同时带会话 cookie' });
    const bearer = /^Bearer ([^\s]{1,200})$/.exec(String(request.headers.authorization));
    const checked = readTokens && bearer ? readTokens.check(bearer[1]!) : { ok: false as const, reason: 'invalid' as const };
    if (!checked.ok) {
      throttle.failed();
      return sendJson(response, 401, { code: 'token', message: checked.reason === 'expired' ? '令牌已到期，请在设置页重新生成' : '令牌无效或已吊销' });
    }
    throttle.succeeded();
    tokenId = checked.id;
    // The token's own name, scopes and expiry, for the MCP server to list only the tools it may call; the session gets 404.
    // Not on the whitelist and needing no scope, but under the same limits as every other token request.
    const self = request.method === 'GET' && url.pathname === '/api/read-token/self' && !url.search;
    const scope = !self && request.method === 'GET' ? readTokenScope(url) : null;
    if (!self && scope === null) return sendJson(response, 403, { code: 'read_only', message: '只读令牌不能访问这个接口' });
    if (scope !== null && !checked.scopes.includes(scope)) return sendJson(response, 403, { code: 'token_scope', scope, message: `这个令牌没有「${READ_SCOPE_NAMES[scope]}」（${scope}）范围，请在设置页生成带这个范围的令牌` });
    const release = readTokens!.admit(checked.id);
    if (!release) return sendJson(response, 429, { code: 'token_rate', message: '请求过于频繁：每个令牌每分钟最多 30 次、同时 2 个，全部令牌同时最多 4 个' }, { 'retry-after': '5' });
    response.once('close', release);
    if (self) {
      const answer = readTokens!.self(checked.id);
      return answer ? sendJson(response, 200, answer) : sendJson(response, 401, { code: 'token', message: '令牌无效或已吊销' });
    }
    const redact = readTokens!.redactor();
    if (!redact) { release(); return sendJson(response, 401, { code: 'token', message: '令牌无效或已吊销' }); }
    tokenAnswers.set(response, { redact, bytes: 0, scopes: checked.scopes });
    return serve(request, response, url, controlRoute(request.method, url.pathname));
  }
  // One throttle per client address, at most TOKEN_THROTTLES of them (the oldest goes first).
  const tokenThrottles = new Map<string, LoginThrottle>();
  const throttleFor = (address: string): LoginThrottle => {
    let throttle = tokenThrottles.get(address);
    if (!throttle) {
      throttle = tokenThrottle();
      tokenThrottles.set(address, throttle);
      if (tokenThrottles.size > TOKEN_THROTTLES) tokenThrottles.delete(tokenThrottles.keys().next().value!);
    }
    return throttle;
  };
  const handOff = (response: ServerResponse): void => {
    response.writeHead(204, { [CONTROL_HEADER]: '1', 'cache-control': 'no-store' });
    response.end();
  };

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!allowedHost(request.headers.host ?? '')) return send(response, 421, { code: 'host', message: '访问地址不在允许范围内' });
    if (privateSocket && request.headers[EXECUTION_HEADER] !== executionBuild) return send(response, 503, { code: 'execution_version', message: '页面与执行器版本尚未匹配，请稍后重试' }, { [EXECUTION_HEADER]: executionBuild });
    const url = new URL(request.url ?? '/', 'http://localhost');
    // Before the login and the cookie: a token never logs in, opens the page or acts as a session.
    if (request.headers.authorization !== undefined) return tokenRoute(request, response, url);
    if (request.method === 'POST' && url.pathname === '/login') return passwordLogin(request, response);
    if (request.method === 'GET' && url.pathname === '/login') {
      const token = url.searchParams.get('token');
      // Without a token it is the password form (or the access-url notice when no password is set).
      if (token === null || !sameSecret(token, accessToken)) return loginPage(response, token === null && password ? 200 : 401, token === null ? '' : '登录链接无效或已过期');
      // Whoever reads access-url may lift a lockout a guesser left, anywhere.
      for (const item of loginThrottles.values()) item.succeeded();
      globalThrottle.succeeded();
      const cookie = sessionCookie(request);
      log(`登录链接登录成功（来自 ${clientAddress(request)}，当前 ${sessions.count()} 个会话）`);
      response.writeHead(303, { ...PAGE_HEADERS, location: '/', 'set-cookie': cookie });
      response.end();
      return;
    }
    // The one /api path open without a login. The answer is a single boolean: an outsider who can reach the port
    // learns that the service runs and nothing about accounts, balances, configuration or why it is not ready.
    if (ready && request.method === 'GET' && url.pathname === '/api/ready') {
      const ok = ready();
      const headers: Record<string, string> = {};
      if (privateSocket) {
        headers[EXECUTION_HEADER] = executionBuild;
        headers[LISTEN_HEADER] = JSON.stringify([browserPort, host ?? null]);
        const check = request.headers[CONFIG_CHECK_HEADER];
        if (configBuild && typeof check === 'string' && /^[a-f0-9]{64}$/.test(check)) headers[CONFIG_MATCH_HEADER] = sameSecret(check, configBuild) ? '1' : '0';
      }
      return send(response, ok ? 200 : 503, { ready: ok }, headers);
    }
    const kind = controlRoute(request.method, url.pathname);
    if (kind === 'page') {
      if (!authorized(request)) return loginPage(response, 401);
      if (privateSocket) return handOff(response);
      if (app) { response.writeHead(200, APP_HEADERS); response.end(app.index); return; }
      const fallback = page ?? (await import('./page.ts'))[executor.environment === 'mainnet' ? 'LIVE_PAGE' : 'PAGE'];
      response.writeHead(200, PAGE_HEADERS);
      response.end(fallback);
      return;
    }
    if (kind === 'asset' && (app || privateSocket)) {
      if (!authorized(request)) return send(response, 401, { code: 'session', message: '需要登录' });
      if (privateSocket) return handOff(response);
      const asset = app?.assets.get(url.pathname.slice('/assets/'.length));
      if (!asset) return send(response, 404, { code: 'not_found', message: '不存在' });
      sendWebAsset(response, asset, request.headers['accept-encoding']);
      return;
    }
    if (!url.pathname.startsWith('/api/')) return send(response, 404, { code: 'not_found', message: '不存在' });
    if (!authorized(request)) return send(response, 401, { code: 'session', message: password ? '会话无效，请刷新页面重新登录' : '会话无效，请使用数据目录 access-url 中的登录链接重新打开' });
    if (request.method === 'POST' && (request.headers['x-pa-executor'] !== '1' || !String(request.headers['content-type'] ?? '').startsWith('application/json'))) return send(response, 403, { code: 'csrf', message: '缺少本页面请求标记' });
    // The page's own session: what it is, logging this browser out, or every browser (sessions.ts).
    if (url.pathname === '/api/session' && request.method === 'GET') {
      const current = requestSessions.get(request)!;
      return send(response, 200, { createdAt: current.createdAt, expiresAt: current.expiresAt === Number.MAX_SAFE_INTEGER ? null : current.expiresAt, count: sessions.count() });
    }
    if (request.method === 'POST' && (url.pathname === '/api/session/logout' || url.pathname === '/api/session/logout-all')) {
      exactKeys(await readJson(request), []);
      const all = url.pathname.endsWith('-all');
      const removed = all ? sessions.removeAll() : Number(sessions.remove(cookieValue(request) ?? ''));
      // The sessions are gone from this process either way, so the cookie is cleared either way. Only a removal on disk
      // is reported as done: otherwise a restart would bring them back (sessions.ts persisted()).
      if (!sessions.persisted()) {
        log(`${all ? `注销全部 ${removed} 个页面会话` : '页面会话退出'}未能写入会话文件，服务重启后可能恢复（来自 ${clientAddress(request)}）`);
        return send(response, 500, { code: 'session_not_persisted', message: `${all ? '已注销的会话' : '本会话'}在当前服务中已失效，但会话文件无法写入、删除或改写，服务重启后可能恢复。请修复数据目录的写权限后重新登录（登录时会补写会话文件），或在重启服务前手动删除数据目录中的 http-session 文件。` }, { 'set-cookie': clearedCookie(request) });
      }
      log(`${all ? `已注销全部 ${removed} 个页面会话` : '页面会话已退出'}（来自 ${clientAddress(request)}）`);
      return send(response, 200, { removed }, { 'set-cookie': clearedCookie(request) });
    }
    // The token's own management: the logged-in page only, never the token (docs/mcp.md 2).
    if (url.pathname === '/api/read-token' || url.pathname.startsWith('/api/read-token/')) {
      if (!readTokens) return send(response, 404, { code: 'not_found', message: '本服务没有只读接口令牌' });
      if (request.method === 'GET' && url.pathname === '/api/read-token') return send(response, 200, readTokens.view());
      // generate takes a name and the scopes (docs/mcp.md 8.4); revoke one id, or every token only with { all: true }.
      const manage = (work: () => unknown) => {
        try { return send(response, 200, work()); }
        catch (error) {
          if (!(error instanceof ReadTokenError)) throw error;
          return send(response, error.code === 'token_limit' ? 409 : error.code === 'token_unknown' ? 404 : 400, { code: error.code, message: error.message });
        }
      };
      if (request.method === 'POST' && url.pathname === '/api/read-token/generate') {
        const { name, scopes } = exactKeys(await readJson(request), ['name', 'scopes']);
        return manage(() => readTokens.generate({ name, scopes }));
      }
      if (request.method === 'POST' && url.pathname === '/api/read-token/revoke') {
        // One token by its id, or every token only when asked for in so many words: an empty body (a page from before
        // v0.85.0 revoking its single token) is refused rather than taken as "all".
        const { id, all } = exactKeys(await readJson(request), [], ['id', 'all']);
        if (all === true && id === undefined) return manage(() => readTokens.revoke());
        if (all !== undefined || typeof id !== 'string' || !/^[0-9a-f]{8}$/.test(id)) return send(response, 400, { code: 'token_input', message: '须给出 id（令牌编号，8 位十六进制），或只给 all: true 吊销全部' });
        return manage(() => readTokens.revoke(id));
      }
      if (request.method === 'POST' && url.pathname === '/api/read-token/lookup') {
        const { alias } = exactKeys(await readJson(request), ['alias']);
        if (typeof alias !== 'string' || !/^(acct|addr|tx)-[0-9a-f]{8}$/.test(alias.trim())) return send(response, 400, { code: 'invalid_alias', message: '别名格式应为 acct-、addr- 或 tx- 加 8 位十六进制' });
        return send(response, 200, { alias: alias.trim(), original: readTokens.lookup(alias) });
      }
      return send(response, 404, { code: 'not_found', message: '不存在' });
    }
    if (request.method === 'GET') negotiate(request, response, url);
    return serve(request, response, url, kind);
  }

  /** The routes behind the session (or the read-only token's whitelist), once the caller is let in. */
  async function serve(request: IncomingMessage, response: ServerResponse, url: URL, kind: ReturnType<typeof controlRoute>): Promise<void> {
    if (request.method === 'GET' && url.pathname === '/api/shell') {
      return send(response, 200, {
        generation: executor.generation, retired: executor.retired, transport: executor.environment === 'mainnet' ? 'live' : 'simulated',
        modules: { oil: !!views?.oil, options: !!views?.options, asset: !!views?.asset,
          crossex: !!views?.crossex, ondo: !!views?.ondo, news: !!views?.news, varlighter: !!views?.varlighter, mev: !!views?.mev },
        monitor: monitorScopes(views?.monitor?.state()),
      } satisfies ShellView);
    }
    if (request.method === 'GET' && url.pathname === '/api/state') {
      // The built page shows neither the jobs nor the notional limits of this view and reads it every two seconds, so it
      // passes jobs=0. The fallback page, the read-only MCP tool and every other caller get the full view.
      const withJobs = url.searchParams.get('jobs') !== '0';
      return send(response, 200, { generation: executor.generation, retired: executor.retired, transport: executor.environment === 'mainnet' ? 'live' : 'simulated', accounts: executor.accounts(),
        ...(withJobs ? { notionalLimits: executor.notionalLimits(), jobs: executor.recentJobs(20) } : {}),
        transfers: { pairs: executor.transferPairs(), corruptPairs: executor.corruptTransferPairs(), recent: executor.recentTransfers(20) },
        adl: { pairs: executor.adlPairs(), recent: executor.recentAdlIncidents(10) }, positions: executor.asterPositions() });
    }
    if (request.method === 'GET' && url.pathname === '/api/host') {
      if (!views?.host) return send(response, 404, { code: 'not_found', message: '本服务没有服务器状态' });
      return send(response, 200, await views.host());
    }
    if (request.method === 'GET' && url.pathname === '/api/status') {
      if (!views?.status) return send(response, 404, { code: 'not_found', message: '本服务没有运行状态' });
      const view = views.status();
      const token = tokenAnswers.get(response);
      return send(response, 200, token && !token.scopes.includes('portfolio') ? readTokenSystemStatus(view) : view);
    }
    if (request.method === 'GET' && (url.pathname === '/api/oil/market' || url.pathname === '/api/oil/state')) {
      if (!views?.oil) return send(response, 404, { code: 'not_found', message: '本服务没有配置原油执行' });
      return send(response, 200, url.pathname === '/api/oil/market' ? views.oil.market() : views.oil.state());
    }
    if (request.method === 'GET' && (url.pathname === '/api/hynix/market' || url.pathname === '/api/hynix/state')) {
      if (!views?.hynix) return send(response, 404, { code: 'not_found', message: '本服务没有配置海力士执行（与原油共用执行账户）' });
      return send(response, 200, url.pathname === '/api/hynix/market' ? views.hynix.market() : views.hynix.state());
    }
    if (request.method === 'POST' && url.pathname === '/api/hynix/balance/settings') {
      if (!views?.hynix?.saveBalanceSettings) return send(response, 404, { code: 'not_found', message: '本服务没有配置海力士执行（与原油共用执行账户）' });
      return send(response, 200, views.hynix.saveBalanceSettings(await readJson(request)));
    }
    if (request.method === 'GET' && (url.pathname === '/api/goldoil/market' || url.pathname === '/api/goldoil/state')) {
      if (!views?.goldoil) return send(response, 404, { code: 'not_found', message: '本服务没有配置金油执行（与原油共用执行账户）' });
      return send(response, 200, url.pathname === '/api/goldoil/market' ? views.goldoil.market() : views.goldoil.state());
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
    const monitorControl = request.method === 'POST' ? /^\/api\/monitor\/(anthropic|oil|goldoil|hynix|perpetual)\/control$/.exec(url.pathname) : null;
    if (monitorControl) {
      const market = monitorControl[1] as keyof typeof MONITOR_NAMES;
      if (!views?.monitor?.setControl) return send(response, 404, { code: 'not_found', message: '本服务没有配置行情监控' });
      if (!views.monitor.state().markets.includes(market)) return send(response, 404, { code: 'not_found', message: `本服务没有配置${MONITOR_NAMES[market]}行情监控` });
      return send(response, 200, views.monitor.setControl(market, await readJson(request)));
    }
    const marketRead = /^\/api\/monitor\/(anthropic|oil|goldoil|hynix|perpetual)\//.exec(url.pathname)?.[1] as keyof typeof MONITOR_NAMES | undefined;
    if (marketRead && views?.monitor) {
      const state = views.monitor.state();
      if (state.markets.includes(marketRead)) {
        if (views.monitor.enabled?.(marketRead) === false) return send(response, 423, { code: 'monitor_disabled', message: marketRead === 'perpetual' ? '合约价差监控已关闭，行情采集已暂停；开启后重新采集' : `${MONITOR_NAMES[marketRead]}监控已关闭，行情采集与自动告警已暂停；开启后恢复` });
        if (isDisplayRead(request.method!, url.pathname)) monitorReads.set(response, { market: marketRead, revision: state.controls?.[marketRead]?.revision });
      }
    }
    const scanChainArb = url.pathname === '/api/monitor/perpetual/chain-arb-scan';
    if (url.pathname === '/api/monitor/perpetual/chain-arb-background' && (request.method === 'GET' || request.method === 'POST')) {
      const monitor = views?.monitor, background = monitor?.chainArbBackground;
      if (!background || !monitor?.state().markets.includes('perpetual')) return send(response, 404, { code: 'not_found', message: '请先在设置中启用行情监控的合约价差' });
      return send(response, 200, request.method === 'POST' ? background.update(await readJson(request)) : background.view());
    }
    if (request.method === 'GET' && (scanChainArb || url.pathname === '/api/monitor/perpetual/chain-arb')) {
      const monitor = views?.monitor;
      const state = monitor?.state();
      if (!state?.markets.includes('perpetual') || !(scanChainArb ? monitor?.scanChainArb : monitor?.chainArb)) return send(response, 404, { code: 'not_found', message: '请先在设置中启用行情监控的合约价差' });
      if (scanChainArb && monitor?.chainArbBackground?.enabled()) return send(response, 409, { code: 'background_enabled', message: '后台扫描已开启，请刷新页面查看后台榜单' });
      monitorReads.set(response, { market: 'perpetual', revision: state.controls?.perpetual?.revision });
      const query = Object.fromEntries(url.searchParams);
      if (Object.keys(query).length !== url.searchParams.size) return send(response, 400, { code: 'invalid_query', message: '查询参数重复' });
      const controller = new AbortController();
      const cancel = () => controller.abort();
      response.once('close', cancel);
      try {
        const view = scanChainArb
          ? await monitor!.scanChainArb!(query, scanInstance + ':' + (state.controls?.perpetual?.revision ?? 0), controller.signal)
          : await monitor!.chainArb!(query, controller.signal);
        if (!response.destroyed) send(response, 200, view);
      } catch (error) {
        if (!response.destroyed) {
          const status = (error as { status?: number })?.status;
          const code = status === 400 ? 'invalid_query' : status === 429 ? 'rate_limited' : 'quote_unavailable';
          send(response, status === 400 || status === 429 || status === 503 ? status : 502, {
            code, message: error instanceof Error ? error.message.slice(0, 200) : '链上价差暂时不可用',
          });
        }
      } finally { response.off('close', cancel); }
      return;
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
      if (request.method === 'POST') negotiate(request, response, url, body);
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
    const alertRoute = /^\/api\/monitor\/(oil|goldoil|hynix)\/alerts(\/test)?$/.exec(url.pathname);
    if (alertRoute && (request.method === 'GET' ? !alertRoute[2] : request.method === 'POST')) {
      const market = alertRoute[1] as 'oil' | 'goldoil' | 'hynix', name = MONITOR_NAMES[market];
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
      if (candles === null) return send(response, 503, { code: 'not_ready', message: `尚未取得${name} K 线，后台正在采集` });
      const known = url.searchParams.get('known');
      if (known === null) return send(response, 200, candles);
      const field = monitorCandleField(market);
      type History = Record<typeof field, { time: number }[]> & { windowDays?: number };
      const { [field]: selected, ...header } = candles as History;
      // Use complete UTC blocks, including the start of the first week. Its content tag survives
      // moving the visible boundary and widening the window to include the preceding weeks.
      const full = header.windowDays === undefined ? selected : (views.monitor.candles(market, null) as History)[field];
      const first = selected[0]!.time;
      const update: MonitorCandleUpdate = { first, header, candles: encodeCandleBlocks(full, MONITOR_CANDLE_BLOCK_MS, known, first) };
      return send(response, 200, update);
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
      // A-5: the workbench's app/api/hub/positions and hub/fills routes at 7745181 (their checks and messages; any failure is 503).
      if (url.pathname === '/api/asset/positions') {
        const version = url.searchParams.get('schemaVersion');
        if (version !== null && version !== '1') return send(response, 400, { code: 'invalid_version', message: '不支持的仓位版本' });
        try { return send(response, 200, await asset.positions()); }
        catch { return send(response, 503, { code: 'unavailable', message: '仓位服务暂不可用，请稍后重试' }); }
      }
      if (url.pathname === '/api/asset/fills') {
        const market = fillsQueryMarket(url.searchParams);
        if (!market) return send(response, 400, { code: 'invalid_query', message: '不支持的成交查询参数' });
        try { return send(response, 200, await asset.fills(market)); }
        catch { return send(response, 503, { code: 'unavailable', message: '成交服务暂不可用，请稍后重试' }); }
      }
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
      const action = ASSET_WRITES[url.pathname as keyof typeof ASSET_WRITES];
      const body = action === 'import' ? await readJson(request, IMPORT_MAX_BYTES, IMPORT_TOO_LARGE) : await readJson(request);
      try {
        switch (action) {
          case 'import': return send(response, 200, await asset.importSource(body));
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
        if (request.method === 'GET' && path === 'market') return send(response, 200, await crossex.market(url.searchParams.get('symbol'), url.searchParams.get('interval') || '5m', {
          candles: url.searchParams.get('candles'), identity: url.searchParams.get('identity'), known: url.searchParams.get('known'),
        }));
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
    if (url.pathname.startsWith('/api/ondo/')) {
      if (!views?.ondo) return send(response, 404, { code: 'not_found', message: '本服务没有配置 Ondo 模块' });
      // Settings are PUT, as in the workbench; they need the same marker as a POST.
      if (request.method === 'PUT' && (request.headers['x-pa-executor'] !== '1' || !String(request.headers['content-type'] ?? '').startsWith('application/json'))) return send(response, 403, { code: 'csrf', message: '缺少本页面请求标记' });
      const ondo = views.ondo, path = url.pathname.slice('/api/ondo/'.length);
      try {
        if (request.method === 'GET' && path === 'state') return send(response, 200, ondo.state());
        if (request.method === 'PUT' && path === 'config') return send(response, 200, ondo.save(await readJson(request)));
        if (request.method === 'POST' && path === 'start') return send(response, 200, await ondo.start(await readJson(request)));
        if (request.method === 'POST' && path === 'stop') return send(response, 200, await ondo.stop(await readJson(request)));
        if (request.method === 'POST' && path === 'cleanup') return send(response, 200, await ondo.cleanup(await readJson(request)));
        if (request.method === 'POST' && path === 'recovery/discard') return send(response, 200, ondo.discardRecovery(await readJson(request)));
        if (request.method === 'GET' && path === 'rewards') {
          const window = url.searchParams.get('window');
          return send(response, 200, ondo.rewards(window !== null && /^\d{1,4}$/.test(window) ? Number(window) : undefined));
        }
        if (request.method === 'PUT' && path === 'rewards/config') return send(response, 200, ondo.saveRewards(await readJson(request)));
        if (request.method === 'GET' && path === 'rewards/book') return send(response, 200, await ondo.book(url.searchParams.get('market') ?? ''));
      } catch (error) {
        if (error instanceof ContractError) throw error;
        const failure = ondo.failure(error);
        if (failure.internal) process.stderr.write(`Ondo 接口 ${path} 出错：${error instanceof Error ? error.message.slice(0, 200) : '未知错误'}\n`);
        return send(response, failure.status, failure.body);
      }
      return send(response, 404, { code: 'not_found', message: '不存在' });
    }
    if (url.pathname.startsWith('/api/varlighter/')) {
      if (!views?.varlighter) return send(response, 404, { code: 'not_found', message: '本服务没有开启 Var/Lighter 价差模块' });
      const path = url.pathname.slice('/api/varlighter/'.length);
      if (request.method !== 'GET' && request.method !== 'POST') return send(response, 404, { code: 'not_found', message: '不存在' });
      // 请求体在这里读完（上限与原来一致：参数 64 KB，其余 16 KB），DEX 服务读完整个请求体才处理。
      const body = request.method === 'POST' ? await readJson(request, path === 'settings' ? 64 * 1024 : undefined) : undefined;
      let answer;
      try { answer = await views.varlighter.page({ method: request.method, path, query: [...url.searchParams], ...(request.method === 'POST' ? { body } : {}) }); }
      catch (error) {
        if (!(error instanceof DexOutcomeUnknown)) throw error;
        // 写请求已经发到 DEX、应答丢了：结果未知，断开连接让页面显示「结果未知」，不重试、不改成 503（L204）。
        process.stderr.write(`DEX 价差接口 ${path} 的应答丢失，已断开页面连接：${error.message}\n`);
        response.destroy();
        return;
      }
      return send(response, answer.status, answer.body);
    }
    if (url.pathname.startsWith('/api/mev/')) {
      if (!views?.mev) return send(response, 404, { code: 'not_found', message: '本服务没有配置 MEV 套利模块' });
      const mev = views.mev, path = url.pathname.slice('/api/mev/'.length);
      try {
        if (request.method === 'GET' && path === 'state') return send(response, 200, mev.state());
        if (request.method === 'POST' && path === 'settings') return send(response, 200, mev.settings(await readJson(request)));
        if (request.method === 'POST' && path === 'live/start') return send(response, 200, await mev.start(await readJson(request)));
        if (request.method === 'POST' && path === 'live/stop') { await readJson(request); return send(response, 200, mev.stop()); }
        if (request.method === 'POST' && path === 'tokens') return send(response, 200, await mev.tokens(await readJson(request)));
        // 启用（docs/mev.md 第 6 节）：setup 的请求体带私钥，这里与 failure 都不记录请求体。
        if (request.method === 'POST' && path === 'setup') return send(response, 200, await mev.setup(await readJson(request)));
        if (request.method === 'POST' && path === 'setup/deploy') return send(response, 200, await mev.deploy(await readJson(request)));
        if (request.method === 'POST' && path === 'setup/reset') return send(response, 200, mev.reset(await readJson(request)));
        if (request.method === 'POST' && path === 'setup/rpc') return send(response, 200, mev.rpc(await readJson(request)));
      } catch (error) {
        if (error instanceof ContractError) throw error;
        const failure = mev.failure(error);
        if (failure.internal) process.stderr.write(`MEV 接口 ${path} 出错：${error instanceof Error ? error.message.slice(0, 200) : '未知错误'}\n`);
        return send(response, failure.status, failure.body);
      }
      return send(response, 404, { code: 'not_found', message: '不存在' });
    }
    if (request.method === 'GET' && (url.pathname === '/api/news' || url.pathname === '/api/news/moves')) {
      if (!views?.news) return send(response, 404, { code: 'not_found', message: '本服务没有开启 EQN 快讯' });
      const view = url.pathname === '/api/news' ? views.news.flash() : views.news.moves();
      if (view === null) return send(response, 503, { code: 'not_ready', message: 'EQN 快讯正在启动' });
      return send(response, 200, tokenAnswers.has(response) ? readTokenNewsView(view) : view);
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
    if (url.pathname === '/api/update' || url.pathname === '/api/update/check' || url.pathname === '/api/update/apply') {
      if (privateSocket && kind !== null) {
        if (request.headers[LEGACY_UPDATE_HEADER] === '1') {
          const job = imports?.legacyUpdate?.();
          if (job && (kind === 'update' || kind === 'check')) return send(response, 200, { job }, { [CONTROL_HEADER]: '1' });
          const since = Number(request.headers['x-trading-platform-update-since'] ?? 0);
          if (job?.phase === 'running' && !job.stale && job.startedAt >= since) return send(response, 409, { code: 'update_busy', message: '正在更新，请等待结束' });
        }
        return handOff(response);
      }
      if (!views?.update) return send(response, 404, { code: 'not_found', message: '本服务没有在线更新' });
      if (kind === 'update') { const view = views.update.status(); return send(response, 200, tokenAnswers.has(response) ? readTokenUpdateView(view as UpdateView) : view); }
      if (kind === 'check') { exactKeys(await readJson(request), []); return send(response, 200, await views.update.check()); }
      if (kind === 'apply') return send(response, 200, views.update.apply(await readJson(request)));
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
    if (request.method === 'POST' && url.pathname === '/api/preview') return send(response, 200, executor.publicPreview(await executor.preview(await readJson(request), sessionId(request))));
    if (request.method === 'POST' && url.pathname === '/api/confirm') return send(response, 200, executor.confirm(await readJson(request), sessionId(request)));
    // Four legs (docs/oil.md 11.3): one preview of both venues' plans, one confirm that creates both jobs or neither.
    if (request.method === 'POST' && url.pathname === '/api/four-leg/preview') return send(response, 200, executor.publicFourLegPreview(await executor.previewFourLeg(await readJson(request), sessionId(request))));
    if (request.method === 'POST' && url.pathname === '/api/four-leg/confirm') return send(response, 200, executor.confirmFourLeg(await readJson(request), sessionId(request)));
    const pair = request.method === 'POST' ? PAIR_PATH.exec(url.pathname) : null;
    if (pair) {
      const body = exactKeys(await readJson(request), ['requestId']);
      return send(response, 200, await executor.setTransferEnabled({ pairId: pair[1], enabled: pair[2] === 'enable', requestId: body.requestId }, sessionId(request)));
    }
    const pairConfig = request.method === 'POST' ? PAIR_CONFIG_PATH.exec(url.pathname) : null;
    if (pairConfig) {
      // `expected` is the stored settings the page's draft started from; a mismatch is refused as changed elsewhere.
      const { requestId, expected, ...config } = exactKeys(await readJson(request), ['requestId', 'expected', ...TRANSFER_CONFIG_KEYS]);
      return send(response, 200, executor.setTransferConfig({ pairId: pairConfig[1], requestId, expected, config }, sessionId(request)));
    }
    const adlConfig = request.method === 'POST' ? ADL_CONFIG_PATH.exec(url.pathname) : null;
    if (adlConfig) {
      const body = exactKeys(await readJson(request), ['requestId', 'autoReduce', 'batchNotional']);
      return send(response, 200, executor.setAdlConfig({ pairId: adlConfig[1], ...body }, sessionId(request)));
    }
    const adlRestart = request.method === 'POST' ? ADL_RESTART_PATH.exec(url.pathname) : null;
    if (adlRestart) {
      const body = exactKeys(await readJson(request), ['requestId']);
      return send(response, 200, executor.restartAdl({ incidentId: adlRestart[1], requestId: body.requestId }, sessionId(request)));
    }
    const match = UUID_PATH.exec(url.pathname);
    // The path match is case-insensitive, so the action is compared lowercased; otherwise /STOP would fall through to acknowledge.
    const action = match?.[2]?.toLowerCase();
    if (match && request.method === 'GET' && !action) return send(response, 200, executor.jobView(match[1]));
    if (match && request.method === 'POST' && action === 'adopt-strategy') {
      const body = exactKeys(await readJson(request), ['requestId', 'strategyId']);
      return send(response, 200, await executor.adoptStrategy({ jobId: match[1], requestId: body.requestId, strategyId: body.strategyId }, sessionId(request)));
    }
    if (match && request.method === 'POST' && action === 'confirm-not-created') {
      const body = exactKeys(await readJson(request), ['requestId']);
      return send(response, 200, await executor.confirmNotCreated({ jobId: match[1], requestId: body.requestId }, sessionId(request)));
    }
    if (match && request.method === 'POST' && action === 'release-strategy') {
      const body = exactKeys(await readJson(request), ['requestId'], ['acknowledgeRisk']);
      return send(response, 200, executor.releaseStrategy({ jobId: match[1], requestId: body.requestId, acknowledgeRisk: body.acknowledgeRisk }, sessionId(request)));
    }
    if (match && request.method === 'POST' && (action === 'stop' || action === 'acknowledge')) {
      const body = await readJson(request) as { requestId?: unknown } | null;
      const requestId = typeof body?.requestId === 'string' ? body.requestId : '';
      return send(response, 200, action === 'stop' ? executor.requestStop(match[1], requestId, sessionId(request)) : executor.acknowledge(match[1], requestId, sessionId(request)));
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
