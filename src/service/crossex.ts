// The Gate CrossEx module inside the service (docs/crossex.md §3): started only when config.json has `crossex`; without
// it the service runs exactly as before. The vendored workbench market and live runtime (src/vendor/crossex) run on
// crossex/store.ts. Before anything trades, the Gate account is locked on this host (pa-executor-live/gate-crossex/<UID>),
// the key's UID is read from /account/detail and must be the configured one, and the runtime's stored connection must
// belong to that key (connected from secrets.json otherwise) and that UID; any failure refuses start.
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

export const CROSSEX_LOCK_VENUE = 'gate-crossex';
const PREFLIGHT_MS = 30_000;
/** The workbench's intervalMs: the catalog tick and the account poll. */
export const CROSSEX_TICK_MS = 5_000;
/** An account read failing this long is posted once per episode. */
export const READ_FAILURE_ALERT_MS = 5 * 60_000;
/** Executions untouched for longer are not posted (the dedupe keys outlive this by days: feishu.ts RETENTION_MS). */
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
}

export interface CrossexOptions {
  /** Tests stand in for Gate (the start check and the runtime's signed reads); the network by default. */
  fetchImpl?: FetchLike;
  preflightTimeoutMs?: number;
  /** Tests replace the public readers (catalog, depth, candles). */
  marketOptions?: Record<string, unknown>;
  terminalOptions?: Record<string, unknown>;
  liveOptions?: Record<string, unknown>;
}

/** The runtime's accountReference for a key (live-runtime.mjs hash of apiKey.trim()). */
export const keyReference = (apiKey: string): string => createHash('sha256').update(JSON.stringify(apiKey.trim())).digest('hex');

function withinDeadline<T>(promise: Promise<T>, deadline: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}超时`)), Math.max(0, deadline - Date.now())); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Gate /account/detail: the key's UID must be the configured one. Throws what to change. */
export async function preflightCrossex(client: { getAccountDetail(): Promise<{ user_id?: number }> }, config: CrossexServiceConfig, deadline: number): Promise<void> {
  const detail = await withinDeadline(client.getAccountDetail(), deadline, '读取 Gate 账户信息');
  const uid = typeof detail?.user_id === 'number' ? String(detail.user_id) : '';
  if (!/^[1-9]\d{0,19}$/.test(uid)) throw new Error('Gate 没有返回有效的账户 UID');
  if (uid !== config.accountUid) throw new Error(`密钥属于 Gate 账户 ***${uid.slice(-4)}，与配置的 ***${config.accountUid.slice(-4)} 不符`);
}

type ConnectionRecord = { enabled?: boolean; accountUid?: string | number | null; accountReference?: string; version?: number } | null;
const storedConnection = (store: CrossexStore): ConnectionRecord => {
  const row = store.prepare("SELECT json FROM live_connection WHERE singleton=1").get() as { json: string } | undefined;
  return row ? JSON.parse(row.json) as ConnectionRecord : null;
};

async function stopParts(parts: { live?: CrossexLiveRuntime; terminal?: CrossexTerminalMarket; market?: CrossexMarket; store?: CrossexStore }): Promise<void> {
  // The workbench close order: the runtime (waits for its queue), the terminal feeds, the market readers, the database.
  for (const step of [() => parts.live?.stop(), () => parts.terminal?.stop(), () => parts.market?.stop()]) {
    try { await step(); } catch { /* best effort */ }
  }
  try { parts.store?.close(); } catch { /* best effort */ }
}

/**
 * Locks the account, checks the key's UID (30 s overall, no retry), opens crossex.sqlite and the vendored runtime, and
 * makes sure its connection is this key on this UID. Any failure undoes what was opened and throws, which refuses start.
 */
export async function prepareCrossex(config: CrossexServiceConfig, credentials: LiveCredentials | undefined, dir: string, { fetchImpl, preflightTimeoutMs = PREFLIGHT_MS, marketOptions, terminalOptions, liveOptions }: CrossexOptions = {}): Promise<CrossexRuntime> {
  if (!credentials) throw new Error('配置了 crossex，但密钥文件里没有 gate');
  const locks = await holdAccountLocks([{ venue: CROSSEX_LOCK_VENUE, accountId: config.accountUid }]);
  const deadline = Date.now() + preflightTimeoutMs;
  const secret = { apiKey: credentials.apiKey.trim(), apiSecret: credentials.apiSecret.trim() };
  const clientFactory = (options: GateClientOptions) => createGateClient({ ...options, ...(fetchImpl ? { fetcher: fetchImpl as GateClientOptions['fetcher'] } : {}) });
  const parts: { live?: CrossexLiveRuntime; terminal?: CrossexTerminalMarket; market?: CrossexMarket; store?: CrossexStore } = {};
  try {
    await preflightCrossex(clientFactory({ ...secret, timeoutMs: Math.min(8_000, preflightTimeoutMs) }), config, deadline);
    const store = parts.store = openCrossexStore(dir, { secret, limits: config.limits });
    // The host lock above proves no other process runs this account, so a lease left by a process that died is void;
    // without this the runtime would wait out the lease (60 s) and then run without the execution lock.
    if (store.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='live_owner'").get()) store.prepare('DELETE FROM live_owner').run();
    const market = parts.market = createMarket(store, marketOptions);
    const live = parts.live = createLiveRuntime(store, { ...liveOptions, market, clientFactory });
    parts.terminal = createTerminalMarket({ ...terminalOptions, market });
    let record = storedConnection(store);
    if (!record?.enabled || record.accountReference !== keyReference(secret.apiKey)) {
      await withinDeadline(live.connection(secret), deadline, '连接 Gate CrossEx 账户');
      record = storedConnection(store);
    }
    if (!record?.enabled) throw new Error('Gate CrossEx 账户没有连上');
    if (record.accountUid !== null && record.accountUid !== undefined && String(record.accountUid) !== config.accountUid) {
      throw new Error(`已保存的连接属于 Gate 账户 ***${String(record.accountUid).slice(-4)}，与配置的 ***${config.accountUid.slice(-4)} 不符`);
    }
    return { config, store, market: parts.market, live, terminal: parts.terminal, locks };
  } catch (error) {
    await stopParts(parts);
    locks.release();
    throw new Error(`CrossEx 账户启动检查未通过，拒绝启动：${describe(error)}`);
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
 * UNKNOWN leg, needs attention (partial, or a leg not sent / invalid). Only executions touched within ALERT_RECENT_MS.
 */
export function executionAlerts(executions: readonly Execution[], now: number): CrossexAlert[] {
  const alerts: CrossexAlert[] = [];
  for (const execution of executions) {
    if (typeof execution?.id !== 'string' || !execution.id) continue;
    const legs = execution.legs ?? [];
    const touched = Math.max(execution.updatedAt ?? 0, execution.createdAt ?? 0, ...legs.map(leg => leg.updatedAt ?? 0));
    if (now - touched > ALERT_RECENT_MS) continue;
    const key = (state: string) => `crossex:${execution.id}:${state}`;
    alerts.push({ key: key('confirmed'), text: `【CrossEx 已确认】${title(execution)}：${legLine(execution)}` });
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

/** Tracks one account-read failure episode; returns the message to post once it has lasted READ_FAILURE_ALERT_MS. */
export function createReadFailureWatch() {
  let since: number | null = null;
  return (error: string | null, now: number): CrossexAlert | null => {
    if (!error) { since = null; return null; }
    since ??= now;
    if (now - since < READ_FAILURE_ALERT_MS) return null;
    return { key: `crossex:read-failure:${since}`, text: `【CrossEx 账户读取失败】已持续约 ${Math.round((now - since) / 60_000)} 分钟：${clip(error, 120)}；交易已暂停，继续只读重试` };
  };
}

/** The summary card's line: held legs grouped by coin, their total notional and the orders not yet settled. */
export function crossexSummaryLine(runtime: CrossexRuntime): string {
  try {
    const live = runtime.live.view({ includeOpportunities: false }).live as { positions?: { canonicalBase?: string; notional?: string | null }[]; stale?: boolean; partial?: boolean };
    const positions = live.positions ?? [];
    const groups = new Set(positions.map(position => position.canonicalBase).filter(Boolean)).size;
    let total = 0, known = true;
    for (const position of positions) { const value = Number(position.notional); if (Number.isFinite(value)) total += value; else known = false; }
    const metrics = runtime.live.summary().metrics;
    const pending = (metrics.find(metric => metric.key === 'liveOrders')?.value ?? 0) + (metrics.find(metric => metric.key === 'unconfirmedOrders')?.value ?? 0);
    return `CrossEx：持仓 ${groups} 组（${positions.length} 腿），名义合计 ${known ? total.toFixed(2) : '部分未知'} USDT，未完成订单 ${pending} 笔${live.stale || live.partial ? '（账户数据未同步）' : ''}`;
  } catch (error) { return `CrossEx：暂无数据（${describe(error)}）`; }
}

/**
 * The module's loops: the catalog every 5 s and the account poll every 5 s less the round's time (never refreshSource);
 * after each poll the Feishu messages derived from the runtime's state go out once each.
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
      const at = now();
      const executions = (runtime.live.view({ includeOpportunities: false }).live as { executions?: Execution[] }).executions ?? [];
      for (const alert of executionAlerts(executions, at)) notifyOnce(alert.key, alert.text);
      const failing = readFailure(runtime.live.connectionView().error, at);
      if (failing) notifyOnce(failing.key, failing.text);
    }),
  ];
}

/** An error from a route: the runtime's AppError keeps its status and message (and requestStatus), anything else is 500. */
export function crossexFailure(error: unknown): { status: number; body: { code: string; message: string; requestStatus?: string } } | undefined {
  if (error instanceof AppError) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 400;
    return { status, body: { code: error.requestStatus === 'not_submitted' ? 'not_submitted' : 'crossex', message: error.message, ...(error.requestStatus === 'not_submitted' ? { requestStatus: 'not_submitted' } : {}) } };
  }
  return undefined;
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
  failure(error: unknown): ReturnType<typeof crossexFailure>;
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
