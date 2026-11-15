// The options module inside the service (docs/options.md §3): started only when config.json has `options`; without it
// the service runs exactly as before. Before anything is opened the Bybit account is locked on this host and its key
// passes the start check (read-write, IP bound, options trading on, nothing else risky; unified account; UID as
// configured). A failed start (a bad key, Bybit unreachable, another process on the account, a state that cannot be
// restored) disables options only: the rest of the service runs, /api/options answers 503 with the reason and the start
// is retried every 60 s (createOptionsSupervisor). Only config.json / secrets.json that do not parse refuse start.
import { join } from 'node:path';
import { ContractError, exactKeys, reject } from '../contracts.ts';
import { holdAccountLocks } from '../live/setup.ts';
import type { FetchLike } from '../live/http.ts';
import { bybitAccountProblem, bybitIpProblem, bybitPermissionProblem } from '../live/permissions.ts';
import { describe, type LiveCredentials } from '../live/values.ts';
import { createOptionsClient, type OptionsClient } from '../options/client.ts';
import { SCHEDULE_TICK_MS, createOptionsEngine, type OptionsEngine } from '../options/engine.ts';
import { MARKET_REFRESH_MS, createOptionMarket, type OptionMarket } from '../options/market.ts';
import { openOptionsStore, type OptionsStore } from '../options/store.ts';
import { DEFAULT_ESTIMATES, STRATEGY_MODES, type StrategyMode } from '../options/strategy.ts';
import type { OptionsConfig } from './options-config.ts';

export const OPTIONS_DATABASE = 'options.sqlite';
const PREFLIGHT_MS = 30_000;
const RECONCILE_MS = 15_000;
const HEALTH_MS = 15_000;
const PERFORMANCE_TICK_MS = 15_000;
/** An unfinished RFQ (G2c) is read every 3 s, as the workbench page polls it. */
const RFQ_TICK_MS = 3_000;
/** The shortest gap between two rounds, so a round that took its whole timeout does not start the next at once. */
const MIN_GAP_MS = 500;
/** How long a stopping service waits between looks at shutdown; the pause is woken by the stop itself. */
const IDLE_MS = 60_000;
/** An options start that failed is tried again this often until it passes or the service stops. */
export const OPTIONS_RETRY_MS = 60_000;

export type OptionsStartReason = 'locked' | 'unreachable' | 'key' | 'state' | 'other';
/** Said on the page (503) and in Feishu; the detail goes to the log only. */
export const OPTIONS_START_REASONS: Readonly<Record<OptionsStartReason, string>> = {
  locked: '本机另一个进程正占用此 Bybit 期权账户（同一 UID 只能由一个服务运行）',
  unreachable: '读不到 Bybit 账户信息（网络不通、Bybit 未在 30 秒内应答，或密钥无效）',
  key: 'Bybit 期权密钥没有通过启动检查（权限、IP 绑定、统一账户，或 UID 与 config.json options.accountId 不符），详见服务日志',
  state: 'options.sqlite 无法打开或期权状态无法恢复（例如属于另一个账户），详见服务日志',
  other: '期权模块启动失败，详见服务日志',
};
export class OptionsStartError extends Error {
  readonly reason: OptionsStartReason;
  readonly detail: string;
  constructor(reason: OptionsStartReason, detail: string) { super(`期权未启动：${OPTIONS_START_REASONS[reason]}（${detail}）`); this.reason = reason; this.detail = detail; }
}
/** What the key or account itself fails (as opposed to a read that did not get an answer). */
class OptionsKeyProblem extends Error {}

export interface OptionsRuntime {
  config: OptionsConfig;
  client: OptionsClient;
  market: OptionMarket;
  store: OptionsStore;
  locks: { release(): void };
}

/**
 * query-api and account/info: the key's permissions and IP binding and the account kind; returns the UID. Throws what to
 * change. The start check and the workbench import (import-options.ts) share it.
 */
export async function readOptionsAccount(client: OptionsClient, timeoutMs = PREFLIGHT_MS, stop?: AbortSignal): Promise<string> {
  const signal = stop ? AbortSignal.any([AbortSignal.timeout(timeoutMs), stop]) : AbortSignal.timeout(timeoutMs);
  await client.syncClock(signal);
  const info = await client.queryApi(signal);
  const problem = bybitPermissionProblem(info, { options: true }) ?? bybitIpProblem(info);
  if (problem) throw new OptionsKeyProblem(problem);
  const uid = typeof info.userID === 'number' || typeof info.userID === 'string' ? String(info.userID) : '';
  const accountProblem = bybitAccountProblem((await client.accountInfo(signal)).unifiedMarginStatus);
  if (accountProblem) throw new OptionsKeyProblem(accountProblem);
  if (!/^[1-9]\d{0,19}$/.test(uid)) throw new OptionsKeyProblem('Bybit 没有返回有效的账户 UID');
  return uid;
}

/** The start check: readOptionsAccount, and the key must belong to the configured UID. */
export async function preflightOptions(client: OptionsClient, config: OptionsConfig, timeoutMs = PREFLIGHT_MS, stop?: AbortSignal): Promise<void> {
  const uid = await readOptionsAccount(client, timeoutMs, stop);
  if (uid !== config.accountId) throw new OptionsKeyProblem(`密钥属于 Bybit 账户 ***${uid.slice(-4) || '?'}，与配置的 ***${config.accountId.slice(-4)} 不符`);
}

/**
 * Locks pa-options/bybit/<UID>, runs the start check (30 s, no retry; `signal` gives up at once) and opens options.sqlite.
 * Any failure releases the lock and throws an OptionsStartError.
 */
export async function prepareOptions(config: OptionsConfig, credentials: LiveCredentials | undefined, dir: string, { fetchImpl, now = Date.now, preflightTimeoutMs, host, signal }: { fetchImpl?: FetchLike; now?: () => number; preflightTimeoutMs?: number; host?: string; signal?: AbortSignal } = {}): Promise<OptionsRuntime> {
  if (!credentials) throw new Error('配置了 options，但密钥文件里没有 bybitOptions');
  let locks: { release(): void };
  try { locks = await holdAccountLocks([{ venue: 'bybit', accountId: config.accountId }], 'pa-options'); }
  catch (error) { throw new OptionsStartError(describe(error).includes('已被本机另一个实盘执行器占用') ? 'locked' : 'other', describe(error)); }
  try {
    const client = createOptionsClient({ credentials, now, ...(fetchImpl ? { fetchImpl } : {}), ...(host ? { host } : {}) });
    try { await preflightOptions(client, config, preflightTimeoutMs, signal); }
    catch (error) { throw new OptionsStartError(error instanceof OptionsKeyProblem ? 'key' : 'unreachable', signal?.aborted ? '服务正在停止' : describe(error)); }
    if (signal?.aborted) throw new OptionsStartError('unreachable', '服务正在停止');
    let store: OptionsStore;
    try { store = openOptionsStore(join(dir, OPTIONS_DATABASE)); } catch (error) { throw new OptionsStartError('state', describe(error)); }
    return { config, client, market: createOptionMarket(client, { now, log: line => process.stderr.write(`${line}\n`) }), store, locks };
  } catch (error) { locks.release(); throw error; }
}

export function createEngineFor(runtime: OptionsRuntime, { notify, log, now = Date.now, sleep }: { notify: (text: string) => void; log: (line: string) => void; now?: () => number; sleep?: (ms: number) => Promise<void> }): OptionsEngine {
  const { config } = runtime;
  return createOptionsEngine({
    client: runtime.client, market: runtime.market, store: runtime.store, uid: config.accountId, now, log, notify, ...(sleep ? { sleep } : {}),
    settings: {
      maxRiskUsd: config.limits.maxRiskUsd, maxMarginUsd: config.limits.maxMarginUsd, legQty: config.legQty, strategyMode: config.strategyMode,
      orderTimeoutMs: config.orderTimeoutSeconds * 1000, estimates: { ...DEFAULT_ESTIMATES, feeRate: config.feeRate, marginBufferPct: config.marginBufferPct, marginMode: config.marginMode },
      autoOpen: { enabled: config.autoOpen, hourUtc: config.openHourUtc, minuteUtc: config.openMinuteUtc, windowSeconds: config.openWindowSeconds },
      marketFallback: config.marketFallback,
    },
  });
}

const QUANTITY = /^\d{1,4}(\.\d{1,8})?$/;
const mode = (value: unknown, name = 'mode'): StrategyMode | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!STRATEGY_MODES.includes(value as StrategyMode)) reject('invalid_value', `${name}须为 iron_condor 或 short_strangle`);
  return value as StrategyMode;
};
const quantity = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !QUANTITY.test(value) || !(Number(value) > 0)) return reject('invalid_value', '数量须为正数（最多 8 位小数）');
  return value;
};
const usd = (value: unknown, name: string): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 10_000_000) return reject('invalid_value', `${name}须为有限数字`);
  return value;
};

/** The page's reads and writes; request bodies are checked here, the engine answers ContractError on a refusal. */
export function optionsViews(engine: OptionsEngine) {
  return {
    market: (expiry: string | null) => engine.marketView(expiry !== null && /^\d{13}$/.test(expiry) ? Number(expiry) : null),
    preview: (qty: string | null, strategy: string | null) => engine.previewView(quantity(qty ?? undefined) ?? null, mode(strategy ?? undefined) ?? null),
    state: () => engine.stateView(),
    performance: () => engine.performanceView(),
    plan: async (body: unknown) => {
      const value = exactKeys(body, ['operation'], ['quantity', 'mode']);
      if (value.operation !== 'open' && value.operation !== 'close') reject('invalid_value', 'operation 须为 open 或 close');
      if (value.operation === 'close' && (value.quantity !== undefined || value.mode !== undefined)) reject('invalid_value', '平仓计划不接受数量或策略');
      const qty = quantity(value.quantity), strategy = mode(value.mode);
      return engine.createPlan({ operation: value.operation as 'open' | 'close', ...(qty ? { quantity: qty } : {}), ...(strategy ? { mode: strategy } : {}) });
    },
    start: async (body: unknown) => {
      const value = exactKeys(body, ['planId', 'requestId', 'confirmLive'], ['minNetIncomeUsd', 'maxNetCostUsd']);
      if (typeof value.planId !== 'string' || !/^[0-9a-f]{32}$/.test(value.planId)) reject('invalid_value', 'planId 无效');
      if (typeof value.requestId !== 'string' || !/^[\w-]{8,80}$/.test(value.requestId)) reject('invalid_value', 'requestId 无效');
      if (typeof value.confirmLive !== 'boolean') reject('invalid_value', 'confirmLive 须为 true / false');
      const min = usd(value.minNetIncomeUsd, '最低净收入'), max = usd(value.maxNetCostUsd, '最高净支出');
      return engine.startTask({ planId: value.planId as string, requestId: value.requestId as string, confirmLive: value.confirmLive as boolean, ...(min === undefined ? {} : { minNetIncomeUsd: min }), ...(max === undefined ? {} : { maxNetCostUsd: max }) });
    },
    stop: (taskId: string, body: unknown) => { exactKeys(body ?? {}, []); return engine.stopTask(taskId); },
    autoOpen: (body: unknown) => {
      const value = exactKeys(body, ['enabled']);
      if (typeof value.enabled !== 'boolean') reject('invalid_value', 'enabled 须为 true / false');
      return engine.setAutoOpen(value.enabled as boolean);
    },
    // 组合询价 (G2c)
    rfq: () => engine.rfqView(),
    rfqCreate: async (body: unknown) => {
      const value = exactKeys(body, ['requestId', 'confirmLive'], ['quantity', 'mode']);
      if (typeof value.requestId !== 'string' || !/^[\w-]{8,80}$/.test(value.requestId)) reject('invalid_value', 'requestId 无效');
      if (typeof value.confirmLive !== 'boolean') reject('invalid_value', 'confirmLive 须为 true / false');
      const qty = quantity(value.quantity), strategy = mode(value.mode);
      return engine.createRfq({ requestId: value.requestId as string, confirmLive: value.confirmLive as boolean, ...(qty ? { quantity: qty } : {}), ...(strategy ? { mode: strategy } : {}) });
    },
    rfqExecute: async (body: unknown) => {
      const value = exactKeys(body, ['rfqId', 'quoteId', 'confirmLive']);
      for (const key of ['rfqId', 'quoteId'] as const) if (typeof value[key] !== 'string' || !/^[\w-]{1,80}$/.test(value[key] as string)) reject('invalid_value', `${key} 无效`);
      if (typeof value.confirmLive !== 'boolean') reject('invalid_value', 'confirmLive 须为 true / false');
      return engine.executeQuote({ rfqId: value.rfqId as string, quoteId: value.quoteId as string, confirmLive: value.confirmLive as boolean });
    },
    rfqCancel: async (body: unknown) => {
      const value = exactKeys(body, ['rfqId']);
      if (typeof value.rfqId !== 'string' || !/^[\w-]{1,80}$/.test(value.rfqId)) reject('invalid_value', 'rfqId 无效');
      return engine.cancelRfq({ rfqId: value.rfqId as string });
    },
  };
}
export type OptionsViews = ReturnType<typeof optionsViews>;

/**
 * The chain every 10 s, reconciliation every 15 s, account health every 15 s, the Friday scheduler every 5 s, the 收益 ledger and samples every 15 s and an unfinished RFQ every 3 s; each round's reads carry their own
 * timeout and a failure only marks the view. On stop, running tasks are stopped and their orders cancelled and read back.
 */
export function optionsLoops(runtime: OptionsRuntime, engine: OptionsEngine, context: { stopped(): boolean; pause(ms: number): Promise<void> }, log: (line: string) => void): Promise<void>[] {
  const every = (spacingMs: number, name: string, round: () => Promise<unknown>) => (async () => {
    while (!context.stopped()) {
      const started = Date.now();
      try { await round(); } catch (error) { log(`期权${name}失败：${describe(error)}`); }
      if (context.stopped()) break;
      await context.pause(Math.max(MIN_GAP_MS, spacingMs - (Date.now() - started)));
    }
  })();
  return [
    every(MARKET_REFRESH_MS, '行情刷新', () => runtime.market.refresh()),
    every(RECONCILE_MS, '对账', engine.reconcileOnce),
    every(HEALTH_MS, '账户健康度读取', engine.refreshHealth),
    every(SCHEDULE_TICK_MS, '定时开仓', engine.autoOpenTick),
    every(PERFORMANCE_TICK_MS, '收益采样', engine.performanceTick),
    every(RFQ_TICK_MS, '询价核对', engine.rfqTick),
    (async () => {
      while (!context.stopped()) await context.pause(IDLE_MS);
      await engine.close();
    })(),
  ];
}

export interface OptionsSupervisor {
  /** One start attempt (the first at service start, then the retries); never throws. */
  start(): Promise<void>;
  running(): { runtime: OptionsRuntime; engine: OptionsEngine } | undefined;
  /** Why options is not running; null once started (or before the first attempt ended). */
  problem(): OptionsStartError | null;
  /** The routes: the engine's while started, 503 options_unavailable with the reason until then. */
  views: OptionsViews;
  /** The background loop: retries the start every retryMs, then runs optionsLoops (whose last part closes the engine). */
  loop(context: { stopped(): boolean; pause(ms: number): Promise<void> }, deps: { notifyOnce(key: string, text: string): unknown; notify(text: string): unknown }): Promise<void>;
  /** Shutdown has begun: a start in flight gives up and no new one begins. */
  abort(): void;
  /** After the loops ended: aborts, waits for a start in flight, closes options.sqlite and releases the account lock; once. */
  stop(): Promise<void>;
}

/**
 * Options as one part of the service that may be down while the rest runs (as CrossEx, crossex.ts): a start that fails
 * (lock, start check, options.sqlite, the state document) is logged, posted to Feishu once per reason per process,
 * answered on /api/options as 503 and tried again every retryMs. A failed module holds no lock, has no engine and sends
 * nothing; each retry is a whole new start (lock, start check, state restored as at a service start). Throws only for what
 * the config parser should have refused (no bybitOptions key).
 */
export function createOptionsSupervisor(config: OptionsConfig, credentials: LiveCredentials | undefined, dir: string,
  { retryMs = OPTIONS_RETRY_MS, fetchImpl, preflightTimeoutMs, now }: { retryMs?: number; fetchImpl?: FetchLike; preflightTimeoutMs?: number; now?: () => number } = {},
  { notify, log }: { notify: (text: string) => void; log: (line: string) => void }): OptionsSupervisor {
  if (!credentials) throw new Error('配置了 options，但密钥文件里没有 bybitOptions');
  const aborter = new AbortController(), startedAt = Date.now(), every = retryMs >= 1000 ? `每 ${Math.round(retryMs / 1000)} 秒重试` : `每 ${retryMs} 毫秒重试`;
  let running: { runtime: OptionsRuntime; engine: OptionsEngine; views: OptionsViews } | undefined, problem: OptionsStartError | null = null;
  let attempt: Promise<void> | null = null, closing: Promise<void> | undefined;
  const start = (): Promise<void> => {
    if (running || aborter.signal.aborted) return Promise.resolve();
    return attempt ??= (async () => {
      const previous = problem?.reason;
      try {
        const runtime = await prepareOptions(config, credentials, dir, { ...(fetchImpl ? { fetchImpl } : {}), ...(now ? { now } : {}), ...(preflightTimeoutMs === undefined ? {} : { preflightTimeoutMs }), signal: aborter.signal });
        let engine: OptionsEngine;
        try {
          if (aborter.signal.aborted) throw new OptionsStartError('unreachable', '服务正在停止');
          try { engine = createEngineFor(runtime, { notify, log, ...(now ? { now } : {}) }); } catch (error) { throw new OptionsStartError('state', describe(error)); }
        } catch (error) {
          try { runtime.store.close(); } catch { /* best effort */ }
          runtime.locks.release();
          throw error;
        }
        running = { runtime, engine, views: optionsViews(engine) };
        problem = null;
      } catch (error) {
        problem = error instanceof OptionsStartError ? error : new OptionsStartError('other', describe(error));
        // Logged when the reason first appears or changes, not on every retry.
        if (!aborter.signal.aborted && previous !== problem.reason) log(`${problem.message}；其他模块照常运行，${every}`);
      } finally { attempt = null; }
    })();
  };
  const current = (): OptionsViews => {
    if (running) return running.views;
    // Nothing was sent: a refused write is one the page may treat as not submitted.
    throw new ContractError(503, 'options_unavailable', `期权未启动：${problem ? OPTIONS_START_REASONS[problem.reason] : '正在启动'}（${every}）；其他模块照常运行`);
  };
  return {
    start,
    running: () => running && { runtime: running.runtime, engine: running.engine },
    problem: () => problem,
    views: {
      market: expiry => current().market(expiry),
      preview: (qty, strategy) => current().preview(qty, strategy),
      state: () => current().state(),
      performance: () => current().performance(),
      plan: async body => current().plan(body),
      start: async body => current().start(body),
      stop: (taskId, body) => current().stop(taskId, body),
      autoOpen: body => current().autoOpen(body),
      rfq: () => current().rfq(),
      rfqCreate: async body => current().rfqCreate(body),
      rfqExecute: async body => current().rfqExecute(body),
      rfqCancel: async body => current().rfqCancel(body),
    },
    async loop(context, { notifyOnce, notify: post }) {
      let failed = false;
      while (!context.stopped() && !running) {
        if (problem) {
          failed = true;
          // One message per reason per process start: a retry failing the same way every minute stays quiet.
          notifyOnce(`options:start:${problem.reason}:${startedAt}`, `【期权未启动】${OPTIONS_START_REASONS[problem.reason]}；ASTER 划转与 ADL 等其他模块照常运行，${every}`);
        }
        await context.pause(retryMs);
        if (context.stopped()) break;
        await start();
      }
      if (!running) return;
      if (failed && !context.stopped()) { log('期权重试后已启动'); post('【期权已启动】重试后通过启动检查，开始轮询账户'); }
      // Also when stopping: the loops end at once and the last one closes the engine (stops its tasks, cancels their orders).
      await Promise.all(optionsLoops(running.runtime, running.engine, context, log));
    },
    abort: () => aborter.abort(),
    stop: () => closing ??= (async () => {
      aborter.abort();
      await attempt;
      if (running) { try { running.runtime.store.close(); } catch { /* best effort */ } running.runtime.locks.release(); }
    })(),
  };
}
