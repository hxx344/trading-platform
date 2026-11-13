// The options module inside the service (docs/options.md §3): started only when config.json has `options`; without it
// the service runs exactly as before. Before anything is opened the Bybit account is locked on this host and its key
// passes the start check (read-write, IP bound, options trading on, nothing else risky; unified account; UID as
// configured), so a bad key, another account's state or a second process refuses start.
import { join } from 'node:path';
import { exactKeys, reject } from '../contracts.ts';
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
export async function readOptionsAccount(client: OptionsClient, timeoutMs = PREFLIGHT_MS): Promise<string> {
  const signal = AbortSignal.timeout(timeoutMs);
  await client.syncClock(signal);
  const info = await client.queryApi(signal);
  const problem = bybitPermissionProblem(info, { options: true }) ?? bybitIpProblem(info);
  if (problem) throw new Error(problem);
  const uid = typeof info.userID === 'number' || typeof info.userID === 'string' ? String(info.userID) : '';
  const accountProblem = bybitAccountProblem((await client.accountInfo(signal)).unifiedMarginStatus);
  if (accountProblem) throw new Error(accountProblem);
  if (!/^[1-9]\d{0,19}$/.test(uid)) throw new Error('Bybit 没有返回有效的账户 UID');
  return uid;
}

/** The start check: readOptionsAccount, and the key must belong to the configured UID. */
export async function preflightOptions(client: OptionsClient, config: OptionsConfig, timeoutMs = PREFLIGHT_MS): Promise<void> {
  const uid = await readOptionsAccount(client, timeoutMs);
  if (uid !== config.accountId) throw new Error(`密钥属于 Bybit 账户 ***${uid.slice(-4) || '?'}，与配置的 ***${config.accountId.slice(-4)} 不符`);
}

/**
 * Locks pa-options/bybit/<UID>, runs the start check (30 s, no retry) and opens options.sqlite. Any failure releases the
 * lock and throws, which refuses start.
 */
export async function prepareOptions(config: OptionsConfig, credentials: LiveCredentials | undefined, dir: string, { fetchImpl, now = Date.now, preflightTimeoutMs, host }: { fetchImpl?: FetchLike; now?: () => number; preflightTimeoutMs?: number; host?: string } = {}): Promise<OptionsRuntime> {
  if (!credentials) throw new Error('配置了 options，但密钥文件里没有 bybitOptions');
  const locks = await holdAccountLocks([{ venue: 'bybit', accountId: config.accountId }], 'pa-options');
  try {
    const client = createOptionsClient({ credentials, now, ...(fetchImpl ? { fetchImpl } : {}), ...(host ? { host } : {}) });
    await preflightOptions(client, config, preflightTimeoutMs);
    const store = openOptionsStore(join(dir, OPTIONS_DATABASE));
    return { config, client, market: createOptionMarket(client, { now, log: line => process.stderr.write(`${line}\n`) }), store, locks };
  } catch (error) { locks.release(); throw new Error(`期权账户启动检查未通过，拒绝启动：${describe(error)}`); }
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
