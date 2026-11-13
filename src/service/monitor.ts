// The monitor module inside the ASTER service: read-only market monitors named in config.json `monitor`. Started only when
// that block is there. Its history sits in monitor.sqlite; a file that cannot be opened costs only the monitor page.
import { join } from 'node:path';
import { createAnthropicMonitor, type AnthropicMonitor, type LoopContext } from '../monitor/anthropic.ts';
import { MONITOR_FILE, createMonitorStore, type MonitorStore } from '../monitor/store.ts';
import type { AnthropicFetcher } from '../vendor/anthropic-market.mjs';
import type { MonitorConfig } from './monitor-config.ts';

export interface MonitorRuntime { config: MonitorConfig; store: MonitorStore; anthropic: AnthropicMonitor }

/** Opens monitor.sqlite and reads the saved history back; throws when the file cannot be opened. */
export function openMonitor(config: MonitorConfig, dir: string, { fetchImpl, now, log }: { fetchImpl?: AnthropicFetcher; now?: () => number; log?: (line: string) => void } = {}): MonitorRuntime {
  const store = createMonitorStore({ file: join(dir, MONITOR_FILE), ...(now ? { now } : {}) });
  try {
    return { config, store, anthropic: createAnthropicMonitor({ store, ...(fetchImpl ? { fetchImpl } : {}), ...(now ? { now } : {}), ...(log ? { log } : {}) }) };
  } catch (error) { store.close(); throw error; }
}

/** The page's reads: which markets run, and the Anthropic quote and candles (null until there is data). */
export function monitorViews(monitor: MonitorRuntime) {
  return {
    state: () => ({ markets: ['anthropic'], anthropic: { shares: monitor.config.anthropic.shares } }),
    anthropicQuote: () => monitor.anthropic.quote(),
    anthropicCandles: (days: number | null) => monitor.anthropic.candles(days),
  };
}

export const monitorLoops = (monitor: MonitorRuntime, context: LoopContext): Promise<void>[] => monitor.anthropic.loops(context);

/** Ends the requests in flight (at stopping), so the loops finish within the drain. */
export const stopMonitor = (monitor: MonitorRuntime): void => monitor.anthropic.stop();
export const closeMonitor = (monitor: MonitorRuntime): void => { try { monitor.store.close(); } catch { /* best effort */ } };
