// The monitor module inside the ASTER service: read-only market monitors named in config.json `monitor`. Started only when
// that block is there, and each market only when it is named. Their history sits in monitor.sqlite; a file that cannot be
// opened costs only the monitor page.
import { join } from 'node:path';
import { createAnthropicMonitor, type AnthropicMonitor, type LoopContext } from '../monitor/anthropic.ts';
import { createHynixMonitor, type HynixMonitor } from '../monitor/hynix.ts';
import { createOilMonitor, type OilMonitor } from '../monitor/oil.ts';
import { MONITOR_FILE, createMonitorStore, type MonitorStore } from '../monitor/store.ts';
import { createBinanceGate, type AnthropicFetcher } from '../vendor/anthropic-market.mjs';
import { monitorMarkets, type MonitorConfig, type MonitorMarket } from './monitor-config.ts';

export interface MonitorRuntime { config: MonitorConfig; store: MonitorStore; anthropic: AnthropicMonitor | null; oil: OilMonitor | null; hynix: HynixMonitor | null }

/** Opens monitor.sqlite and reads the saved history back; throws when the file cannot be opened. */
export function openMonitor(config: MonitorConfig, dir: string, { fetchImpl, now, log }: { fetchImpl?: AnthropicFetcher; now?: () => number; log?: (line: string) => void } = {}): MonitorRuntime {
  const store = createMonitorStore({ file: join(dir, MONITOR_FILE), ...(now ? { now } : {}) });
  try {
    const base = { store, ...(fetchImpl ? { fetchImpl } : {}), ...(now ? { now } : {}), ...(log ? { log } : {}) };
    // One Binance cooldown for the two markets that read Binance from the same address; Hynix reads Hyperliquid only.
    const options = { ...base, gate: createBinanceGate() };
    return {
      config, store, anthropic: config.anthropic ? createAnthropicMonitor(options) : null, oil: config.oil ? createOilMonitor(options) : null,
      hynix: config.hynix ? createHynixMonitor(base) : null,
    };
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
  };
}

/** For the status page: each configured market's last reads and errors. */
export const monitorStatus = (monitor: MonitorRuntime) => ({ anthropic: monitor.anthropic?.status() ?? null, oil: monitor.oil?.status() ?? null, hynix: monitor.hynix?.status() ?? null });

export const monitorLoops = (monitor: MonitorRuntime, context: LoopContext): Promise<void>[] => [...monitor.anthropic?.loops(context) ?? [], ...monitor.oil?.loops(context) ?? [], ...monitor.hynix?.loops(context) ?? []];

/** Ends the requests in flight (at stopping), so the loops finish within the drain. */
export const stopMonitor = (monitor: MonitorRuntime): void => { monitor.anthropic?.stop(); monitor.oil?.stop(); monitor.hynix?.stop(); };
export const closeMonitor = (monitor: MonitorRuntime): void => { try { monitor.store.close(); } catch { /* best effort */ } };
