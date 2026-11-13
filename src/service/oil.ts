// The oil module inside the ASTER service: Binance/Bybit execution accounts named in config.json `oil`. Started only when
// that block is there; the service without it runs exactly as before. Before anything is opened the accounts are locked
// on this host and every account passes its venue's key and identity check, so a bad key or a second process refuses start.
import type { VenueConnector } from '../connector.ts';
import type { Venue } from '../contracts.ts';
import type { Executor } from '../executor.ts';
import { createLiveConnectors, holdAccountLocks, preflightLive } from '../live/setup.ts';
import type { FetchLike } from '../live/http.ts';
import type { LiveCredentials } from '../live/values.ts';
import { createOilMarket, MARKET_READ_MS, POSITIONS_READ_MS, type OilMarket } from '../oil/market.ts';
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

/** The page's two oil reads: the books and spreads, and the accounts, venue positions, jobs and cap use. */
export function oilViews(oil: OilRuntime, executor: Executor) {
  return {
    market: () => oil.market.view(),
    state: () => ({ accounts: executor.accounts(), positions: oil.market.positionsView(), jobs: executor.recentJobs(20), notionalLimits: executor.notionalLimits() }),
  };
}

/** The market loops: books every 3 s, positions every 15 s. Each round's reads carry their own timeout; a failure only marks the view. */
export function oilLoops(oil: OilRuntime, context: { stopped(): boolean; pause(ms: number): Promise<void> }, log: (line: string) => void): Promise<void>[] {
  const every = (spacingMs: number, name: string, round: () => Promise<void>) => (async () => {
    while (!context.stopped()) {
      const started = Date.now();
      try { await round(); } catch (error) { log(`原油${name}失败：${error instanceof Error ? error.message : String(error)}`); }
      if (context.stopped()) break;
      await context.pause(Math.max(MIN_GAP_MS, spacingMs - (Date.now() - started)));
    }
  })();
  return [every(MARKET_READ_MS, '盘口读取', oil.market.refreshQuotes), every(POSITIONS_READ_MS, '持仓读取', oil.market.refreshPositions)];
}
