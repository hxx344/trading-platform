// The monitor module inside the ASTER service: read-only market monitors named in config.json `monitor`. Started only when
// that block is there, and each market only when it is named. Their history sits in monitor.sqlite; a file that cannot be
// opened costs only the monitor page.
import { join } from 'node:path';
import { ALERT_CHECK_MS, createAlertService, createTestGate, type AlertHooks, type AlertMarket, type AlertService } from '../monitor/alerts.ts';
import { createAnthropicMonitor, type AnthropicMonitor, type LoopContext } from '../monitor/anthropic.ts';
import { createExchangeReader, type ExchangeReader } from '../monitor/exchanges.ts';
import { createHynixMonitor, type HynixMonitor } from '../monitor/hynix.ts';
import { createOilMonitor, type OilMonitor } from '../monitor/oil.ts';
import { createPerpetualMonitor, type PerpetualMonitor, type PerpetualOptions } from '../monitor/perpetual.ts';
import { createMonitorControl, type MonitorControl } from '../monitor/control.ts';
import { MONITOR_FILE, createMonitorStore, type MonitorStore } from '../monitor/store.ts';
import { createVariationalSession, type VariationalSession } from '../monitor/variational-session.ts';
import { createVariationalFetch } from '../monitor/variational-transport.ts';
import type { VariationalFetcher } from '../vendor/variational-market.mjs';
import { createBinanceGate, type AnthropicFetcher } from '../vendor/anthropic-market.mjs';
import type { Exchange } from '../vendor/exchange-comparison.mjs';
import { monitorMarkets, type MonitorConfig, type MonitorMarket } from './monitor-config.ts';

export interface MonitorRuntime {
  config: MonitorConfig; store: MonitorStore; anthropic: AnthropicMonitor | null; oil: OilMonitor | null; hynix: HynixMonitor | null;
  /** The on-demand multi-exchange comparison (M-2c); present when oil or Hynix runs. */
  exchanges: ExchangeReader | null;
  /** M-3a: each running oil / Hynix market's threshold alerts; absent without the Feishu outbox hooks (tests of the collectors). */
  alerts: Partial<Record<AlertMarket, AlertService>>;
  /** M-3c: each configured market's run switch. */
  control: MonitorControl;
  /** M-3d: the Variational token the page saves; present when oil runs. */
  variational: VariationalSession | null;
  /** M-4a: every venue's perpetual quotes, in memory only; present when `perpetual` is configured. */
  perpetual: PerpetualMonitor | null;
}

/** Opens monitor.sqlite and reads the saved history back; throws when the file cannot be opened. */
export function openMonitor(config: MonitorConfig, dir: string, { fetchImpl, now, log, WebSocketImpl, alertHooks, variationalFetch, perpetualOptions }: { fetchImpl?: AnthropicFetcher; now?: () => number; log?: (line: string) => void; WebSocketImpl?: typeof WebSocket; alertHooks?: AlertHooks;
  /** The transport to omni.variational.io; python3 and scripts/variational-request.py unless given (tests, the local preview). */
  variationalFetch?: VariationalFetcher;
  /** Stand-ins for the perpetual collector's venues (tests, the local preview). */
  perpetualOptions?: PerpetualOptions } = {}): MonitorRuntime {
  const store = createMonitorStore({ file: join(dir, MONITOR_FILE), ...(now ? { now } : {}) });
  try {
    const base = { store, ...(fetchImpl ? { fetchImpl } : {}), ...(now ? { now } : {}), ...(log ? { log } : {}) };
    // One Binance cooldown for everything that reads Binance from the same address; the Hynix collector reads Hyperliquid only.
    const gate = createBinanceGate(), options = { ...base, gate };
    const oil = config.oil ? createOilMonitor(options) : null, hynix = config.hynix ? createHynixMonitor(base) : null;
    const varFetch = oil ? variationalFetch ?? createVariationalFetch() : undefined;
    const variational = oil && varFetch ? createVariationalSession({ dir, fetcher: varFetch, ...(now ? { now } : {}), ...(log ? { log } : {}) }) : null;
    const exchanges = oil || hynix ? createExchangeReader({
      gate, oilQuote: () => oil?.quote() ?? null, hynixQuote: () => hynix?.quote() ?? null,
      ...(variational && varFetch ? { variationalSession: variational, variationalFetch: varFetch } : {}),
      ...(fetchImpl ? { fetchImpl } : {}), ...(now ? { now } : {}), ...(log ? { log } : {}), ...(WebSocketImpl ? { WebSocketImpl } : {}),
    }) : null;
    const alerts: Partial<Record<AlertMarket, AlertService>> = {};
    if (alertHooks) {
      const gate = createTestGate(now ?? Date.now), common = { store, hooks: alertHooks, gate, ...(now ? { now } : {}), ...(log ? { log } : {}) };
      if (oil) alerts.oil = createAlertService({ ...common, market: 'oil', quote: () => oil.quote() });
      if (hynix) alerts.hynix = createAlertService({ ...common, market: 'hynix', quote: () => hynix.quote() });
    }
    const control = createMonitorControl({ store, markets: monitorMarkets(config), ...(log ? { log } : {}) });
    // Built here, started by its loop once the switch is on (monitorLoops).
    const perpetual = config.perpetual ? createPerpetualMonitor({ ...(fetchImpl ? { fetchImpl } : {}), ...(now ? { now } : {}), ...(log ? { log } : {}), ...perpetualOptions }) : null;
    return { config, store, anthropic: config.anthropic ? createAnthropicMonitor(options) : null, oil, hynix, exchanges, alerts, control, variational, perpetual };
  } catch (error) { store.close(); throw error; }
}

/**
 * The page's reads: which markets run, and each market's quote and candles. A market that is not configured gives undefined
 * (the endpoint answers 404); one without data yet gives null (503).
 */
export function monitorViews(monitor: MonitorRuntime) {
  const collector = (market: CandleMarket) => monitor[market];
  return {
    state: () => ({ markets: monitorMarkets(monitor.config), anthropic: monitor.config.anthropic ? { shares: monitor.config.anthropic.shares } : null, controls: monitor.control.views() }),
    /** M-3c: whether a configured market runs (its reads answer 423 while it is off), and the page's switch. */
    enabled: (market: MonitorMarket): boolean => monitor.control.enabled(market),
    setControl: (market: MonitorMarket, body: unknown): unknown => monitor.control.update(market, body),
    quote: (market: CandleMarket): unknown => collector(market)?.quote(),
    candles: (market: CandleMarket, days: number | null): unknown => collector(market)?.candles(days),
    /** M-4a: the perpetual collector (snapshot, summary, the SSE stream); undefined when it is not configured. */
    perpetual: (): PerpetualMonitor | undefined => monitor.perpetual ?? undefined,
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
    /** M-3d: the saved Variational token's state and the page's save; undefined when oil is not configured. */
    variationalSession: (): VariationalSession | undefined => monitor.variational ?? undefined,
    /** M-3a: the market's alert service; undefined when the market is not configured. */
    alerts: (market: AlertMarket) => monitor.alerts[market],
  };
}

/** The markets with a quote and candles of their own (the perpetual collector has its own reads). */
type CandleMarket = Exclude<MonitorMarket, 'perpetual'>;

/** For the status page: each configured market's last reads and errors, and the alerts when the service runs them. */
export const monitorStatus = (monitor: MonitorRuntime) => ({ anthropic: monitor.anthropic?.status() ?? null, oil: monitor.oil?.status() ?? null, hynix: monitor.hynix?.status() ?? null,
  perpetual: monitor.perpetual ? { ...monitor.perpetual.status(), summary: monitor.perpetual.summary() } : null, controls: monitor.control.views(),
  ...(Object.keys(monitor.alerts).length ? { alerts: { oil: monitor.alerts.oil?.status() ?? null, hynix: monitor.alerts.hynix?.status() ?? null } } : {}) });

/** How often a switched-off market looks at its switch again: a market turned back on resumes within this. */
export const CONTROL_POLL_MS = 1_000;

/**
 * The loop context a market's collector runs under: after each pause it waits while the market is switched off, so the
 * loops stop before their next round (a round in flight finishes) and resume within CONTROL_POLL_MS of being turned on.
 */
function gated(context: LoopContext, on: () => boolean): LoopContext {
  return {
    stopped: context.stopped,
    pause: async ms => {
      await context.pause(ms);
      while (!on() && !context.stopped()) await context.pause(CONTROL_POLL_MS);
    },
  };
}

/** The market's loops, started only once it is on (a market off at start runs no first round). */
function marketLoops(start: (context: LoopContext) => Promise<void>[], context: LoopContext, on: () => boolean, log: (line: string) => void): Promise<void> {
  return (async () => {
    while (!on() && !context.stopped()) await context.pause(CONTROL_POLL_MS);
    if (context.stopped()) return;
    await Promise.all(start(gated(context, on)).map(loop => loop.catch(error => { log(`行情监控循环异常退出：${error instanceof Error ? error.message.slice(0, 200) : String(error)}`); })));
  })();
}

/**
 * Every 10 s each market's alerts check the collector's latest quote (no request of their own). While the market is off
 * only a tier import waiting from the workbench is applied (it would otherwise expire after 10 minutes); no threshold is judged.
 */
function alertLoop(service: AlertService, context: LoopContext, on: () => boolean, log: (line: string) => void): Promise<void> {
  return (async () => {
    while (!context.stopped()) {
      try { if (on()) service.check(); else service.applyPending(); } catch (error) { log(`告警检查出错：${error instanceof Error ? error.message.slice(0, 200) : String(error)}`); }
      if (context.stopped()) break;
      await context.pause(ALERT_CHECK_MS);
    }
  })();
}

/**
 * The perpetual collector runs on its own timers and sockets rather than rounds: this loop starts it while the switch is on
 * and stops it (connections closed, quotes dropped) within CONTROL_POLL_MS of being turned off, and at stopping.
 */
function perpetualLoop(perpetual: PerpetualMonitor, context: LoopContext, on: () => boolean): Promise<void> {
  return (async () => {
    while (!context.stopped()) {
      if (on()) perpetual.start(); else perpetual.stop();
      await context.pause(CONTROL_POLL_MS);
    }
    perpetual.stop();
  })();
}

export const monitorLoops = (monitor: MonitorRuntime, context: LoopContext, log: (line: string) => void = line => process.stderr.write(`${line}\n`)): Promise<void>[] => {
  const on = (market: MonitorMarket) => () => monitor.control.enabled(market);
  return [
    ...(['anthropic', 'oil', 'hynix'] as const).flatMap(market => {
      const collector = monitor[market];
      return collector ? [marketLoops(loopContext => collector.loops(loopContext), context, on(market), log)] : [];
    }),
    ...(Object.entries(monitor.alerts) as [AlertMarket, AlertService][]).map(([market, service]) => alertLoop(service, context, on(market), log)),
    ...(monitor.perpetual ? [perpetualLoop(monitor.perpetual, context, on('perpetual')).catch(error => { log(`合约价差循环异常退出：${error instanceof Error ? error.message.slice(0, 200) : String(error)}`); })] : []),
  ];
};

/** Ends the requests in flight (at stopping), so the loops finish within the drain. */
export const stopMonitor = (monitor: MonitorRuntime): void => { monitor.anthropic?.stop(); monitor.oil?.stop(); monitor.hynix?.stop(); monitor.exchanges?.stop(); monitor.variational?.stop(); monitor.perpetual?.stop(); };
export const closeMonitor = (monitor: MonitorRuntime): void => { try { monitor.store.close(); } catch { /* best effort */ } };
