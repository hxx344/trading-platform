// The oil module inside the ASTER service: Binance/Bybit execution accounts named in config.json `oil`. Started only when
// that block is there; the service without it runs exactly as before. Before anything is opened the accounts are locked
// on this host and every account passes its venue's key and identity check, so a bad key or a second process refuses start.
import type { VenueConnector } from '../connector.ts';
import { VENUE_NAMES, type Venue } from '../contracts.ts';
import type { Executor } from '../executor.ts';
import { createLiveConnectors, holdAccountLocks, preflightLive } from '../live/setup.ts';
import type { FetchLike } from '../live/http.ts';
import type { LiveCredentials } from '../live/values.ts';
import { createOilMarket, MARKET_READ_MS, POSITIONS_READ_MS, type OilMarket } from '../oil/market.ts';
import { createOilRules, OIL_RULES_DATABASE } from '../oil/rules.ts';
import { ContractError } from '../contracts.ts';
import { join } from 'node:path';
import type { OilConfig } from './oil-config.ts';

/** The shortest gap between two book rounds, so a round that took its whole timeout does not start the next at once. */
const MIN_GAP_MS = 500;

export interface OilRuntime {
  config: OilConfig;
  connectors: VenueConnector[];
  market: OilMarket;
  locks: { release(): void };
}

/**
 * Locks the oil accounts (one live executor per real account on this host), builds the configured venues' connectors and
 * runs their start checks (preflightLive: one signed read set per account, 30 s timeout each, no retry). Any failure
 * releases the locks and throws, which refuses start.
 */
export async function prepareOil(config: OilConfig, keys: Map<Venue, LiveCredentials> | undefined, { fetchImpl, now = Date.now, preflightTimeoutMs }: { fetchImpl?: FetchLike; now?: () => number; preflightTimeoutMs?: number } = {}): Promise<OilRuntime> {
  if (!keys) throw new Error('配置了 oil，但密钥文件里没有对应交易所的密钥');
  const locks = await holdAccountLocks(config.accounts);
  try {
    const venues = new Set(config.accounts.map(account => account.venue));
    const connectors = createLiveConnectors(config, keys, { ...(fetchImpl ? { fetchImpl } : {}), now }).filter(connector => venues.has(connector.venue));
    await preflightLive(config, connectors, ...(preflightTimeoutMs === undefined ? [] : [preflightTimeoutMs]));
    return { config, connectors, market: createOilMarket({ connectors, accounts: config.accounts, now }), locks };
  } catch (error) { locks.release(); throw new Error(`原油执行账户启动检查未通过，拒绝启动：${error instanceof Error ? error.message : String(error)}`); }
}

/** Binds the oil accounts in the executor (after it holds the lease); a binding change refused there refuses start. */
export function registerOilAccounts(oil: OilRuntime, executor: Executor): void {
  for (const account of oil.config.accounts) executor.registerAccount(account);
}

/**
 * Oil jobs still open while oil, or one of their venues, is no longer configured: no loop drives or reconciles them and the
 * page cannot show them, so the operator hears it (log and Feishu) at every start until oil is configured again.
 */
export function strandedOilJobs(executor: Pick<Executor, 'unfinished' | 'jobView'>, config: OilConfig | undefined): string[] {
  const configured = new Set<Venue>(config?.accounts.map(account => account.venue) ?? []);
  return executor.unfinished().flatMap(id => {
    const missing = [...new Set(executor.jobView(id).legs.map(leg => leg.venue))].filter(venue => !configured.has(venue));
    if (!missing.length) return [];
    const where = config ? `没有 ${missing.map(venue => VENUE_NAMES[venue]).join('、')} 执行账户` : '已没有 oil';
    return [`原油任务 ${id} 尚未结束，但配置里${where}：本服务不再推进或核对它，交易所上可能仍有敞口；请把配置加回后重启，处理完再删除`];
  });
}

/** The spread rules as the page and the market loop use them; a store that cannot open leaves orders and jobs alone. */
export interface OilRulesRuntime {
  view(): unknown;
  create(body: unknown): unknown;
  update(id: string, body: unknown): unknown;
  act(id: string, action: string, body: unknown): unknown;
  tick(): void;
  close(): void;
}

/** Opens oil-rules.sqlite in the data directory. A failure is logged and shown on the page; the rest of oil runs on. */
export function openOilRules(oil: OilRuntime, dir: string, { now = Date.now, log = (line: string) => process.stderr.write(`${line}\n`) }: { now?: () => number; log?: (line: string) => void } = {}): OilRulesRuntime {
  try {
    return createOilRules({ file: join(dir, OIL_RULES_DATABASE), venues: oil.config.accounts.map(account => account.venue), books: () => oil.market.view().books, now });
  } catch (error) {
    const reason = `原油自动规则库无法打开，自动规则不可用（下单与任务不受影响）：${error instanceof Error ? error.message.slice(0, 200) : String(error)}`;
    log(reason);
    const refuse = () => { throw new ContractError(503, 'rules_unavailable', reason); };
    return { view: () => ({ available: false, error: reason, rules: [] }), create: refuse, update: refuse, act: refuse, tick: () => {}, close: () => {} };
  }
}

/** The page's oil reads: the books and spreads, the accounts, venue positions, jobs and cap use, and the spread rules. */
export function oilViews(oil: OilRuntime, executor: Executor, rules?: OilRulesRuntime) {
  return {
    market: () => oil.market.view(),
    state: () => ({ accounts: executor.accounts(), positions: oil.market.positionsView(), jobs: executor.recentJobs(20), notionalLimits: executor.notionalLimits() }),
    ...(rules ? { rules } : {}),
  };
}

/** The market loops: books every 3 s (then the spread rules), positions every 15 s. Each round's reads carry their own timeout; a failure only marks the view. */
export function oilLoops(oil: OilRuntime, context: { stopped(): boolean; pause(ms: number): Promise<void> }, log: (line: string) => void, rules?: OilRulesRuntime): Promise<void>[] {
  const every = (spacingMs: number, name: string, round: () => Promise<void>) => (async () => {
    while (!context.stopped()) {
      const started = Date.now();
      try { await round(); } catch (error) { log(`原油${name}失败：${error instanceof Error ? error.message : String(error)}`); }
      if (context.stopped()) break;
      await context.pause(Math.max(MIN_GAP_MS, spacingMs - (Date.now() - started)));
    }
  })();
  // The rules judge each round's books as soon as they are read; their own failure is logged apart from the read's.
  const quotes = async () => {
    await oil.market.refreshQuotes();
    try { rules?.tick(); } catch (error) { log(`原油自动规则判断失败：${error instanceof Error ? error.message : String(error)}`); }
  };
  return [every(MARKET_READ_MS, '盘口读取', quotes), every(POSITIONS_READ_MS, '持仓读取', oil.market.refreshPositions)];
}
