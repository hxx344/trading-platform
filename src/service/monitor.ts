// The monitor module inside the ASTER service: read-only market monitors named in config.json `monitor`. Started only when
// that block is there, and each market only when it is named. Their history sits in monitor.sqlite; a file that cannot be
// opened costs only the monitor page.
import { join } from 'node:path';
import { createAnthropicMonitor, type AnthropicMonitor, type LoopContext } from '../monitor/anthropic.ts';
import { createExchangeReader, type ExchangeReader } from '../monitor/exchanges.ts';
import { createHynixMonitor, type HynixMonitor } from '../monitor/hynix.ts';
import { createOilMonitor, type OilMonitor } from '../monitor/oil.ts';
import { MONITOR_FILE, createMonitorStore, type MonitorStore } from '../monitor/store.ts';
import { createBinanceGate, type AnthropicFetcher } from '../vendor/anthropic-market.mjs';
import type { Exchange } from '../vendor/exchange-comparison.mjs';
import { monitorMarkets, type MonitorConfig, type MonitorMarket } from './monitor-config.ts';

export interface MonitorRuntime {
  config: MonitorConfig; store: MonitorStore; anthropic: AnthropicMonitor | null; oil: OilMonitor | null; hynix: HynixMonitor | null;
  /** The on-demand multi-exchange comparison (M-2c); present when oil or Hynix runs. */
  exchanges: ExchangeReader | null;
}

/** Opens monitor.sqlite and reads the saved history back; throws when the file cannot be opened. */
export function openMonitor(config: MonitorConfig, dir: string, { fetchImpl, now, log, WebSocketImpl }: { fetchImpl?: AnthropicFetcher; now?: () => number; log?: (line: string) => void; WebSocketImpl?: typeof WebSocket } = {}): MonitorRuntime {
  const store = createMonitorStore({ file: join(dir, MONITOR_FILE), ...(now ? { now } : {}) });
  try {
    const base = { store, ...(fetchImpl ? { fetchImpl } : {}), ...(now ? { now } : {}), ...(log ? { log } : {}) };
    // One Binance cooldown for everything that reads Binance from the same address; the Hynix collector reads Hyperliquid only.
    const gate = createBinanceGate(), options = { ...base, gate };
    const oil = config.oil ? createOilMonitor(options) : null, hynix = config.hynix ? createHynixMonitor(base) : null;
    const exchanges = oil || hynix ? createExchangeReader({
      gate, oilQuote: () => oil?.quote() ?? null, hynixQuote: () => hynix?.quote() ?? null,
      ...(fetchImpl ? { fetchImpl } : {}), ...(now ? { now } : {}), ...(log ? { log } : {}), ...(WebSocketImpl ? { WebSocketImpl } : {}),
    }) : null;
    return { config, store, anthropic: config.anthropic ? createAnthropicMonitor(options) : null, oil, hynix, exchanges };
  } catch (error) { store.close(); throw error; }
}

/**
 * The page's reads: which markets run, and each market's quote and candles. A market that is not configured gives undefined
 * (the endpoint answers 404); one without data yet gives null (503).
 */
export function monitorViews(monitor: MonitorRuntime) {
  const collector = (market: MonitorMarket) => monitor[market];
  return {
    state: () => ({ markets: monitorMarkets(monitor.config), anthropic: monitor.config.anthropic ? { shares: monitor.config.anthropic.shares } : null }),
    quote: (market: MonitorMarket): unknown => collector(market)?.quote(),
    candles: (market: MonitorMarket, days: number | null): unknown => collector(market)?.candles(days),
    /** The settled funding history (M-2d); undefined when the market is not configured; before any settlement
     * `{ notReady }` with why the last round failed (null while the first round has not failed). */
    funding: (market: 'oil' | 'hynix'): unknown => {
      const collector = monitor[market];
      return collector ? collector.funding() ?? { notReady: collector.status().fundingError } : undefined;
    },
    /** One exchange's comparison row; undefined when the market is not configured. Rejects with the page's reason. */
    exchange: (market: 'oil' | 'hynix', exchange: Exchange): Promise<unknown> | undefined =>
      monitor.exchanges && monitor.config[market] ? monitor.exchanges.quote(market, exchange) : undefined,
    /** One exchange's settled funding history (M-2d-3); undefined when the market is not configured. Rejects with the page's reason. */
    fundingHistory: (market: 'oil' | 'hynix', exchange: Exchange): Promise<unknown> | undefined =>
      monitor.exchanges && monitor.config[market] ? monitor.exchanges.fundingHistory(market, exchange) : undefined,
  };
}

/** For the status page: each configured market's last reads and errors. */
export const monitorStatus = (monitor: MonitorRuntime) => ({ anthropic: monitor.anthropic?.status() ?? null, oil: monitor.oil?.status() ?? null, hynix: monitor.hynix?.status() ?? null });

export const monitorLoops = (monitor: MonitorRuntime, context: LoopContext): Promise<void>[] => [...monitor.anthropic?.loops(context) ?? [], ...monitor.oil?.loops(context) ?? [], ...monitor.hynix?.loops(context) ?? []];

/** Ends the requests in flight (at stopping), so the loops finish within the drain. */
export const stopMonitor = (monitor: MonitorRuntime): void => { monitor.anthropic?.stop(); monitor.oil?.stop(); monitor.hynix?.stop(); monitor.exchanges?.stop(); };
export const closeMonitor = (monitor: MonitorRuntime): void => { try { monitor.store.close(); } catch { /* best effort */ } };
