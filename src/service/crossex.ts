// The Gate CrossEx module inside the service (docs/crossex.md §3): started only when config.json has `crossex`; without
// it the service runs exactly as before. The vendored workbench market and live runtime (src/vendor/crossex) run on
// crossex/store.ts. Before anything trades, the Gate account is locked on this host (pa-executor-live/gate-crossex/<UID>),
// the key's UID is read from /account/detail and must be the configured one, and the runtime's stored connection must
// belong to that key (connected from secrets.json otherwise) and that UID. A failed start disables CrossEx only: the
// rest of the service runs, /api/crossex answers 503 with the reason, and the start is retried every 60 s
// (createCrossexSupervisor). Only config.json / secrets.json that do not parse refuse start (service/config.ts).
// Monitor is not connected: refreshSource is never called, so the opportunity list stays empty until 行情监控 M-4.
import { createHash } from 'node:crypto';
import { holdAccountLocks } from '../live/setup.ts';
import type { FetchLike } from '../live/http.ts';
import { describe, type LiveCredentials } from '../live/values.ts';
import { openCrossexStore, type CrossexStore } from '../crossex/store.ts';
import { AppError } from '../vendor/crossex/model.mjs';
import { createGateClient, type GateClientOptions } from '../vendor/crossex/live-client.mjs';
import { createMarket, type CrossexMarket } from '../vendor/crossex/market.mjs';
import { createLiveRuntime, type CrossexLiveRuntime } from '../vendor/crossex/live-runtime.mjs';
import { createTerminalMarket, type CrossexTerminalMarket } from '../vendor/crossex/terminal-market.mjs';
import { limitProblem, type CrossexServiceConfig } from './crossex-config.ts';
import type { MarketClient } from '../market/ipc.ts';
import { remoteCrossexReaders } from './remote-venue-feeds.ts';

export const CROSSEX_LOCK_VENUE = 'gate-crossex';
const PREFLIGHT_MS = 30_000;
/**
 * After a failed start, how long each part's stop is waited for before the database is closed under it anyway. The
 * runtime's stop waits for its queue, and a connection() still queued after the start deadline is bounded only by its
 * reads (12 s each, more with unknown orders to look up); it can no longer write once the database is closed.
 */
export const FAILED_STOP_WAIT_MS = 5_000;
/** A CrossEx start that failed is tried again this often until it passes or the service stops. */
export const CROSSEX_RETRY_MS = 60_000;
/** The workbench's intervalMs: the catalog tick and the account poll. */
export const CROSSEX_TICK_MS = 5_000;
/** An account read failing (or the account data not updated) this long is posted once per episode. */
export const READ_FAILURE_ALERT_MS = 5 * 60_000;
/** Executions older than this (confirmed: by creation; the rest: by last change) are not posted (feishu.ts RETENTION_MS keeps the keys 7 days). */
export const ALERT_RECENT_MS = 24 * 60 * 60_000;
const UNKNOWN_STATES = new Set(['UNKNOWN']);
const ATTENTION_STATES = new Set(['UNSENT', 'INVALID']);
const FINISHED = new Set(['completed', 'partial', 'failed']);

export interface CrossexRuntime {
  config: CrossexServiceConfig;
  store: CrossexStore;
  market: CrossexMarket;
  live: CrossexLiveRuntime;
  terminal: CrossexTerminalMarket;
  locks: { release(): void };
  /** Held legs in USDT (market.positionsNotional, FX-converted) after the last account round; null when not valued. */
  notionalUSDT?: string | null;
}

export interface CrossexOptions {
  marketClient?: MarketClient;
  /** Tests stand in for Gate (the start check and the runtime's signed reads); the network by default. */
  fetchImpl?: FetchLike;
  preflightTimeoutMs?: number;
  /** Tests replace the public readers (catalog, depth, candles). */
  marketOptions?: Record<string, unknown>;
  terminalOptions?: Record<string, unknown>;
  liveOptions?: Record<string, unknown>;
  /** Aborted when the service stops: a start in flight gives up. */
  signal?: AbortSignal;
  /** Tests shorten the retry after a failed start (CROSSEX_RETRY_MS). */
  retryMs?: number;
}

/** Why CrossEx did not start; each has one fixed text (page, log, Feishu) and one Feishu message per process. */
export type CrossexStartReason = 'locked' | 'unreachable' | 'uid' | 'rotated' | 'unverified' | 'credential' | 'store' | 'other';
export const START_REASONS: Readonly<Record<CrossexStartReason, string>> = {
  locked: '本机另一个进程正占用此 Gate 账户（同一 UID 只能由一个服务运行）',
  unreachable: '读不到 Gate 账户信息（网络不通、Gate 未在 30 秒内应答，或密钥无效）',
  uid: 'secrets.json 的 gate 密钥不属于 config.json crossex.accountUid 配置的 Gate 账户，请核对两者',
  rotated: 'secrets.json 的 gate 密钥已更换，但 Gate 上仍有挂单或本地有未结束、结果未知的订单，暂不能换用新密钥；请先在 Gate 撤掉挂单，每次重试会用当前密钥核对订单，处理完后自动启动（也可换回原密钥）',
  unverified: 'secrets.json 的 gate 密钥已更换，但用它读取账户、持仓或挂单未完成，暂不能确认可以换用；请核对密钥的 CrossEx 读取权限与网络',
  credential: 'Gate 不接受 secrets.json 的 gate 密钥（密钥无效、没有 CrossEx 读取权限，或 Gate 暂时无法访问）',
  store: '本地 CrossEx 数据库（crossex.sqlite）或运行时无法打开',
  other: '启动检查未通过',
};
export class CrossexStartError extends Error {
  readonly reason: CrossexStartReason;
  readonly detail: string;
  constructor(reason: CrossexStartReason, detail: string) { super(`CrossEx 未启动：${START_REASONS[reason]}（${detail}）`); this.reason = reason; this.detail = detail; }
}
class DeadlineError extends Error {}

/** The runtime's accountReference for a key (live-runtime.mjs hash of apiKey.trim()). */
export const keyReference = (apiKey: string): string => createHash('sha256').update(JSON.stringify(apiKey.trim())).digest('hex');

function withinDeadline<T>(promise: Promise<T>, deadline: number, what: string, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined, onAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(`${what}超时`)), Math.max(0, deadline - Date.now()));
    if (signal) { onAbort = () => reject(new Error('服务正在停止')); if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  });
  return Promise.race([promise, timeout]).finally(() => { clearTimeout(timer); if (onAbort) signal!.removeEventListener('abort', onAbort); });
}

/** Gate /account/detail: the key's UID must be the configured one. Throws what to change. */
export async function preflightCrossex(client: { getAccountDetail(): Promise<{ user_id?: number }> }, config: CrossexServiceConfig, deadline: number, signal?: AbortSignal): Promise<void> {
  let detail: { user_id?: number };
  try { detail = await withinDeadline(client.getAccountDetail(), deadline, '读取 Gate 账户信息', signal); }
  catch (error) { throw new CrossexStartError('unreachable', describe(error)); }
  const uid = typeof detail?.user_id === 'number' ? String(detail.user_id) : '';
  if (!/^[1-9]\d{0,19}$/.test(uid)) throw new CrossexStartError('unreachable', 'Gate 没有返回有效的账户 UID');
  if (uid !== config.accountUid) throw new CrossexStartError('uid', `密钥属于 Gate 账户 ***${uid.slice(-4)}，与配置的 ***${config.accountUid.slice(-4)} 不符`);
}

type ConnectionRecord = { enabled?: boolean; accountUid?: string | number | null; accountReference?: string; version?: number } | null;
const storedConnection = (store: CrossexStore): ConnectionRecord => {
  const row = store.prepare("SELECT json FROM live_connection WHERE singleton=1").get() as { json: string } | undefined;
  return row ? JSON.parse(row.json) as ConnectionRecord : null;
};

/** The runtime's connection() refusals (live-runtime.mjs connectInternal) by their fixed texts. */
function connectionReason(error: unknown): CrossexStartReason {
  if (error instanceof DeadlineError) return 'unreachable';
  const text = error instanceof Error ? error.message : '';
  // Checked before the generic text: the account read with the current key (markers resolve to secrets.json) failed.
  if (text.includes('原账户状态未核实')) return 'unverified';
  if (text.includes('不能更换凭据或账户')) return 'rotated';
  if (text.includes('账户验证未完成')) return 'credential';
  return 'other';
}

type Parts = { live?: CrossexLiveRuntime; terminal?: CrossexTerminalMarket; market?: CrossexMarket; store?: CrossexStore };
async function stopParts(parts: Parts, waitMs = Infinity): Promise<void> {
  // The workbench close order: the runtime (waits for its queue), the terminal feeds, the market readers, the database.
  for (const step of [() => parts.live?.stop(), () => parts.terminal?.stop(), () => parts.market?.stop()]) {
    const stopping = Promise.resolve().then(step).catch(() => undefined);
    if (waitMs === Infinity) { await stopping; continue; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([stopping, new Promise<void>(resolve => { timer = setTimeout(resolve, waitMs); timer.unref(); })]);
    clearTimeout(timer);
  }
  try { parts.store?.close(); } catch { /* best effort */ }
}

/**
 * Locks the account, checks the key's UID (30 s overall, no retry), opens crossex.sqlite and the vendored runtime, and
 * makes sure its connection is this key on this UID. Any failure undoes what was opened (each part's stop waited at most
 * FAILED_STOP_WAIT_MS), releases the lock and throws a CrossexStartError.
 */
export async function prepareCrossex(config: CrossexServiceConfig, credentials: LiveCredentials | undefined, dir: string, { fetchImpl, preflightTimeoutMs = PREFLIGHT_MS, marketOptions, terminalOptions, liveOptions, signal, marketClient }: CrossexOptions = {}): Promise<CrossexRuntime> {
  if (!credentials) throw new Error('配置了 crossex，但密钥文件里没有 gate');
  let locks: { release(): void };
  try { locks = await holdAccountLocks([{ venue: CROSSEX_LOCK_VENUE, accountId: config.accountUid }]); }
  catch (error) { throw new CrossexStartError(describe(error).includes('已被本机另一个实盘执行器占用') ? 'locked' : 'other', describe(error)); }
  const deadline = Date.now() + preflightTimeoutMs;
  const secret = { apiKey: credentials.apiKey.trim(), apiSecret: credentials.apiSecret.trim() };
  const clientFactory = (options: GateClientOptions) => createGateClient({ ...options, ...(fetchImpl ? { fetcher: fetchImpl as GateClientOptions['fetcher'] } : {}) });
  const parts: Parts = {};
  const stopIfAborted = () => { if (signal?.aborted) throw new CrossexStartError('other', '服务正在停止'); };
  try {
    await preflightCrossex(clientFactory({ ...secret, timeoutMs: Math.min(8_000, preflightTimeoutMs) }), config, deadline, signal);
    stopIfAborted();
    let store: CrossexStore, live: CrossexLiveRuntime;
    try {
      store = parts.store = openCrossexStore(dir, { secret, limits: config.limits });
      // The host lock above proves no other process runs this account, so a lease left by a process that died is void;
      // without this the runtime would wait out the lease (60 s) and then run without the execution lock. This relies on
      // the per-UID host lock and on one data directory per UID: a second data directory for the same UID on another
      // host would not be seen by the lock, and its lease would be deleted here.
      if (store.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='live_owner'").get()) store.prepare('DELETE FROM live_owner').run();
      const remote = marketClient ? remoteCrossexReaders(marketClient) : undefined;
      const market = parts.market = createMarket(store, { ...marketOptions, ...remote?.marketOptions });
      live = parts.live = createLiveRuntime(store, { ...liveOptions, market, clientFactory });
      parts.terminal = createTerminalMarket({ ...terminalOptions, ...remote?.terminalOptions, market });
    } catch (error) { throw new CrossexStartError('store', describe(error)); }
    let record = storedConnection(store);
    if (!record?.enabled || record.accountReference !== keyReference(secret.apiKey)) {
      try { await withinDeadline(live.connection(secret), deadline, '连接 Gate CrossEx 账户', signal); }
      catch (error) { throw new CrossexStartError(connectionReason(error), describe(error)); }
      record = storedConnection(store);
    }
    if (!record?.enabled) throw new CrossexStartError('other', 'Gate CrossEx 账户没有连上');
    if (record.accountUid !== null && record.accountUid !== undefined && String(record.accountUid) !== config.accountUid) {
      throw new CrossexStartError('uid', `已保存的连接属于 Gate 账户 ***${String(record.accountUid).slice(-4)}，与配置的 ***${config.accountUid.slice(-4)} 不符`);
    }
    stopIfAborted();
    return { config, store, market: parts.market!, live, terminal: parts.terminal!, locks, notionalUSDT: null };
  } catch (error) {
    await stopParts(parts, FAILED_STOP_WAIT_MS);
    locks.release();
    throw error instanceof CrossexStartError ? error : new CrossexStartError('other', describe(error));
  }
}

/** Shutdown after the loops ended: runtime, terminal feeds, market readers, database, then the host lock. */
export async function closeCrossex(runtime: CrossexRuntime): Promise<void> {
  await stopParts(runtime);
  runtime.locks.release();
}

type Execution = { id: string; kind?: string; action?: string; base?: string; state?: string; updatedAt?: number; createdAt?: number;
  legs?: { status?: string; side?: string; symbol?: string; quantity?: string; executedQty?: string; updatedAt?: number; error?: string | null }[] };
export interface CrossexAlert { key: string; text: string }

const KIND: Record<string, string> = { open: '开仓', close: '平仓', position: '持仓调整' };
const STATE: Record<string, string> = { completed: '全部成交', partial: '部分成交，两腿可能不一致', failed: '未成交' };
const clip = (value: unknown, limit = 80): string => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
const legLine = (execution: Execution): string => (execution.legs ?? []).map(leg => `${clip(leg.side, 8)} ${clip(leg.symbol, 40)} ${clip(leg.executedQty ?? '0', 24)}/${clip(leg.quantity, 24)}`).join('；');
const title = (execution: Execution): string => `${KIND[execution.kind ?? ''] ?? clip(execution.kind, 16)} ${clip(execution.base, 24)}（${clip(execution.id, 12)}）`;

/**
 * The messages the executions call for, each keyed per (execution, state) for notifyOnce: confirmed, finished, an
 * UNKNOWN leg, needs attention (partial, or a leg not sent / invalid). "Confirmed" only for executions created within
 * ALERT_RECENT_MS, the rest for executions changed within it. An UNKNOWN leg is rewritten (updatedAt) at every
 * reconciliation, so an order still unknown after the 7 days the `once` keys are kept is reminded about once a week.
 */
export function executionAlerts(executions: readonly Execution[], now: number): CrossexAlert[] {
  const alerts: CrossexAlert[] = [];
  for (const execution of executions) {
    if (typeof execution?.id !== 'string' || !execution.id) continue;
    const legs = execution.legs ?? [];
    const created = execution.createdAt ?? execution.updatedAt ?? 0;
    const touched = Math.max(execution.updatedAt ?? 0, execution.createdAt ?? 0, ...legs.map(leg => leg.updatedAt ?? 0));
    if (now - touched > ALERT_RECENT_MS) continue;
    const key = (state: string) => `crossex:${execution.id}:${state}`;
    if (now - created <= ALERT_RECENT_MS) alerts.push({ key: key('confirmed'), text: `【CrossEx 已确认】${title(execution)}：${legLine(execution)}` });
    if (legs.some(leg => UNKNOWN_STATES.has(leg.status ?? ''))) alerts.push({ key: key('unknown'), text: `【CrossEx 订单结果未知】${title(execution)}：不会重发，按原订单标识只读核对；核对完成前暂停交易` });
    const stuck = legs.filter(leg => ATTENTION_STATES.has(leg.status ?? ''));
    if (execution.state === 'partial' || stuck.length) {
      const why = execution.state === 'partial' ? '部分成交，两腿可能不一致' : clip(stuck[0]!.error, 80) || '有一腿未发送或状态无效';
      alerts.push({ key: key('attention'), text: `【CrossEx 需人工处理】${title(execution)}：${why}；请在 CrossEx 页面按实际持仓处理` });
    }
    if (FINISHED.has(execution.state ?? '')) alerts.push({ key: key('finished'), text: `【CrossEx 已结束】${title(execution)}：${STATE[execution.state!]}；${legLine(execution)}` });
  }
  return alerts;
}

/**
 * Tracks one account-read failure episode; returns the message to post once it has lasted READ_FAILURE_ALERT_MS. An
 * episode is a read error, or account data (asOf) older than READ_FAILURE_ALERT_MS without one: a runtime that lost its
 * execution lock throws before it writes an error, so only the age shows it.
 */
export function createReadFailureWatch(startedAt = Date.now()) {
  let since: number | null = null;
  return (error: string | null, now: number, asOf: number | null = null): CrossexAlert | null => {
    const old = asOf !== null && now - asOf > READ_FAILURE_ALERT_MS;
    if (!error && !old) { since = null; return null; }
    // Data left by an earlier process is not counted from before this one started (the downtime is not a read failure).
    since ??= old ? Math.max(Math.min(asOf!, now), Math.min(startedAt, now)) : now;
    if (now - since < READ_FAILURE_ALERT_MS) return null;
    const why = error ? clip(error, 120) : '账户数据没有更新（本服务的执行锁可能已失效，需重启服务）';
    return { key: `crossex:read-failure:${since}`, text: `【CrossEx 账户读取失败】已持续约 ${Math.round((now - since) / 60_000)} 分钟：${why}；交易已暂停，继续只读重试` };
  };
}

/** The summary card's line: held legs grouped by coin, their USDT notional (last account round) and the orders not settled. */
export function crossexSummaryLine(runtime: CrossexRuntime): string {
  try {
    const live = runtime.live.view({ includeOpportunities: false }).live as { positions?: { canonicalBase?: string }[]; stale?: boolean; partial?: boolean };
    const positions = live.positions ?? [];
    const groups = new Set(positions.map(position => position.canonicalBase).filter(Boolean)).size;
    const total = Number(runtime.notionalUSDT ?? NaN);
    const notional = !positions.length ? '0.00' : Number.isFinite(total) ? total.toFixed(2) : '部分未知';
    // liveOrders already counts every order not finished, unknown ones included; unconfirmedOrders is that subset.
    const metrics = runtime.live.summary().metrics;
    const open = metrics.find(metric => metric.key === 'liveOrders')?.value ?? 0, unknown = metrics.find(metric => metric.key === 'unconfirmedOrders')?.value ?? 0;
    return `CrossEx：持仓 ${groups} 组（${positions.length} 腿），名义合计 ${notional} USDT（标记价按汇率折算），未完成订单 ${open} 笔${unknown ? `（其中结果未知 ${unknown} 笔）` : ''}${live.stale || live.partial ? '（账户数据未同步）' : ''}`;
  } catch (error) { return `CrossEx：暂无数据（${describe(error)}）`; }
}

/** The held legs of the last account read (raw Gate positions in live_cache), valued in USDT by the market. */
async function valueHeld(runtime: CrossexRuntime): Promise<string | null> {
  try {
    const row = runtime.store.prepare('SELECT json FROM live_cache WHERE singleton=1').get() as { json: string } | undefined;
    const positions = row ? (JSON.parse(row.json) as { positions?: unknown[] }).positions ?? [] : [];
    return await runtime.market.positionsNotional(positions);
  } catch { return null; }
}

/**
 * The module's loops: the catalog every 5 s and the account poll every 5 s less the round's time (never refreshSource);
 * after each poll the held notional is valued and the Feishu messages derived from the runtime's state go out once each.
 */
export function crossexLoops(runtime: CrossexRuntime, context: { stopped(): boolean; pause(ms: number): Promise<void> }, { notifyOnce, log, now = Date.now }: { notifyOnce(key: string, text: string): unknown; log(line: string): void; now?: () => number }): Promise<void>[] {
  const readFailure = createReadFailureWatch();
  const every = (spacingMs: number, name: string, round: () => Promise<unknown>) => (async () => {
    while (!context.stopped()) {
      const started = Date.now();
      try { await round(); } catch (error) { log(`CrossEx ${name}失败：${describe(error)}`); }
      if (context.stopped()) break;
      await context.pause(Math.max(0, spacingMs - (Date.now() - started)));
    }
  })();
  return [
    every(CROSSEX_TICK_MS, '合约目录读取', () => runtime.market.refreshCatalog()),
    every(CROSSEX_TICK_MS, '账户读取', async () => {
      try { await runtime.live.refresh({ includeView: false }); }
      catch { log('CrossEx 账户本轮读取未完成，等待下一次检查'); }
      runtime.notionalUSDT = await valueHeld(runtime);
      const at = now();
      const live = runtime.live.view({ includeOpportunities: false }).live as { executions?: Execution[]; asOf?: number | null };
      for (const alert of executionAlerts(live.executions ?? [], at)) notifyOnce(alert.key, alert.text);
      const failing = readFailure(runtime.live.connectionView().error, at, typeof live.asOf === 'number' ? live.asOf : null);
      if (failing) notifyOnce(failing.key, failing.text);
    }),
  ];
}

export interface CrossexFailure { status: number; body: { code: string; message: string; requestStatus?: string }; internal: boolean }
/**
 * An error from a route, as the workbench app.mjs answers it: the runtime's AppError keeps its status and message, anything
 * else is 500 with a fixed text (it may carry internals; `internal` asks the caller to log it). Either way a write that
 * provably never left the service keeps requestStatus 'not_submitted' (and the code not_submitted).
 */
export function crossexFailure(error: unknown): CrossexFailure {
  const notSubmitted = error !== null && typeof error === 'object' && (error as { requestStatus?: unknown }).requestStatus === 'not_submitted';
  const code = notSubmitted ? 'not_submitted' : 'crossex', extra = notSubmitted ? { requestStatus: 'not_submitted' } : {};
  if (error instanceof AppError) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 400;
    return { status, body: { code, message: error.message, ...extra }, internal: false };
  }
  return { status: 500, body: { code, message: '操作未完成，请检查服务状态', ...extra }, internal: true };
}

export interface CrossexViews {
  state(opportunities: boolean, funding: boolean): unknown;
  bootstrap(): unknown;
  settings(body: unknown): unknown;
  refresh(): Promise<unknown>;
  instruments(): Promise<unknown>;
  market(symbol: string | null, interval: string): Promise<unknown>;
  preview(body: unknown): Promise<unknown>;
  openCapacity(body: unknown): Promise<unknown>;
  confirm(body: unknown): Promise<unknown>;
  cancel(body: unknown): Promise<unknown>;
  request(id: string): Promise<unknown>;
  failure(error: unknown): CrossexFailure;
}

export function crossexViews(runtime: CrossexRuntime): CrossexViews {
  const { live, market, terminal, config } = runtime;
  const limits = () => ({ ...config.limits });
  return {
    state: (opportunities, funding) => ({ ...live.view({ includeOpportunities: opportunities, ...(funding ? { includeFundingOpportunities: true } : {}) }), limits: limits() }),
    bootstrap: () => ({ now: Date.now(), config: market.config(), connection: live.connectionView(), limits: limits() }),
    settings(body) {
      // The Monitor is not connected and its password would need key storage this service does not have.
      if (body !== null && typeof body === 'object' && !Array.isArray(body) && ['monitorPassword', 'clearMonitorPassword'].some(key => Object.hasOwn(body, key))) throw new AppError('行情监控未接入，不能保存价差服务密码');
      const problem = limitProblem(body, config.limits);
      if (problem) throw new AppError(problem, 400);
      return { ...(market.settings(body) as Record<string, unknown>), limits: limits() };
    },
    async refresh() { await live.refresh({ includeView: false }); return { ...live.view({ includeOpportunities: false }), limits: limits() }; },
    instruments: () => market.instruments(),
    market: (symbol, interval) => terminal.read(symbol, interval),
    preview: body => live.preview(body),
    openCapacity: body => live.openCapacity(body),
    confirm: body => live.confirm(body),
    cancel: body => live.cancel(body),
    request: id => live.requestStatus(id),
    failure: crossexFailure,
  };
}

export interface CrossexSupervisor {
  /** One start attempt (the first at service start, then the retries); never throws. */
  start(): Promise<void>;
  runtime(): CrossexRuntime | undefined;
  /** Why CrossEx is not running; null once started (or before the first attempt ended). */
  problem(): CrossexStartError | null;
  /** The routes: the runtime's while started, 503 with the reason until then. */
  views: CrossexViews;
  summaryLine(): string;
  /** The background loop: retries the start every retryMs, then runs crossexLoops. */
  loop(context: { stopped(): boolean; pause(ms: number): Promise<void> }, deps: { notifyOnce(key: string, text: string): unknown; notify(text: string): unknown; log(line: string): void }): Promise<void>;
  /** Shutdown has begun: a start in flight gives up and no new one begins. */
  abort(): void;
  /** Aborts, waits for a start in flight and closes the runtime; once. */
  stop(): Promise<void>;
}

/**
 * CrossEx as one part of the service that may be down while the rest runs: a start that fails (Gate unreachable, the key's
 * UID not the configured one, a rotated key the runtime refuses, the account locked by another process, the database)
 * is logged, posted to Feishu once per reason per process, answered on /api/crossex as 503, and tried again every
 * retryMs. Throws only for what the config parser should have refused (no gate key).
 */
export function createCrossexSupervisor(config: CrossexServiceConfig, credentials: LiveCredentials | undefined, dir: string, { retryMs = CROSSEX_RETRY_MS, ...options }: CrossexOptions = {}, log: (line: string) => void = line => process.stderr.write(`${line}\n`)): CrossexSupervisor {
  if (!credentials) throw new Error('配置了 crossex，但密钥文件里没有 gate');
  const aborter = new AbortController(), startedAt = Date.now(), every = retryMs >= 1000 ? `每 ${Math.round(retryMs / 1000)} 秒重试` : `每 ${retryMs} 毫秒重试`;
  let runtime: CrossexRuntime | undefined, views: CrossexViews | undefined, problem: CrossexStartError | null = null;
  let attempt: Promise<void> | null = null, closing: Promise<void> | undefined;
  const start = (): Promise<void> => {
    if (runtime || aborter.signal.aborted) return Promise.resolve();
    return attempt ??= (async () => {
      const previous = problem?.reason;
      try {
        runtime = await prepareCrossex(config, credentials, dir, { ...options, signal: aborter.signal });
        views = crossexViews(runtime);
        problem = null;
      } catch (error) {
        problem = error instanceof CrossexStartError ? error : new CrossexStartError('other', describe(error));
        // Logged when the reason first appears or changes, not on every retry.
        if (!aborter.signal.aborted && previous !== problem.reason) log(`${problem.message}；其他模块照常运行，${every}`);
      } finally { attempt = null; }
    })();
  };
  const unavailable = (write: boolean): AppError => {
    const error = new AppError(`CrossEx 未启动：${problem ? START_REASONS[problem.reason] : '正在启动'}（${every}）`, 503);
    // Nothing was sent: the page may treat a confirm or cancel as not submitted.
    if (write) error.requestStatus = 'not_submitted';
    return error;
  };
  const current = (write = false): CrossexViews => { if (!views) throw unavailable(write); return views; };
  return {
    start,
    runtime: () => runtime,
    problem: () => problem,
    views: {
      state: (opportunities, funding) => current().state(opportunities, funding),
      bootstrap: () => current().bootstrap(),
      settings: body => current().settings(body),
      refresh: async () => current().refresh(),
      instruments: async () => current().instruments(),
      market: async (symbol, interval) => current().market(symbol, interval),
      preview: async body => current().preview(body),
      openCapacity: async body => current().openCapacity(body),
      confirm: async body => current(true).confirm(body),
      cancel: async body => current(true).cancel(body),
      request: async id => current().request(id),
      failure: crossexFailure,
    },
    summaryLine: () => runtime ? crossexSummaryLine(runtime) : `CrossEx：未启动（${problem ? START_REASONS[problem.reason] : '正在启动'}，${every}）`,
    async loop(context, { notifyOnce, notify, log: logLine }) {
      let failed = false;
      while (!context.stopped() && !runtime) {
        if (problem) {
          failed = true;
          // One message per reason per process start: a retry failing the same way every minute stays quiet.
          notifyOnce(`crossex:start:${problem.reason}:${startedAt}`, `【CrossEx 未启动】${START_REASONS[problem.reason]}；ASTER、原油、期权等其他模块照常运行，${every}`);
        }
        await context.pause(retryMs);
        if (context.stopped()) return;
        await start();
      }
      if (!runtime || context.stopped()) return;
      if (failed) { logLine('CrossEx 重试后已启动'); notify('【CrossEx 已启动】重试后通过启动检查，开始轮询账户'); }
      await Promise.all(crossexLoops(runtime, context, { notifyOnce, log: logLine }));
    },
    abort: () => aborter.abort(),
    stop: () => closing ??= (async () => {
      aborter.abort();
      await attempt;
      if (runtime) await closeCrossex(runtime);
    })(),
  };
}
