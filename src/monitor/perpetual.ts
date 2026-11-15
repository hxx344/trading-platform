// Monitor M-4a: the perpetual-contract quote collector — public order books, marks and funding of every perpetual on the
// workbench's venues (perpetual-exchanges.mjs), merged into one quote per contract and pushed to the page as SSE patches.
// The core of the workbench's createPerpetualService (modules/monitor/server/perpetual-service.mjs, c84ba27): discovery every
// 5 minutes, one WebSocket per subscription plan with backoff, watchdog, heartbeats, the shared-host poll budget and REST
// book snapshots; quotes are committed once a second and broadcast as patches against what every reader last got.
// M-5a adds the workbench's execution service (perpetual-depth.mjs): one-shot public depth for an amount (depth), the close
// estimate of a position (exit) and the spot FX rates (fx), created on start and stopped with the collector.
// M-5b1 adds the workbench's market-metrics service (perpetual-market-metrics.mjs): 24h volume and open interest of the
// contracts a page has read, refreshed every 30 s; built once, started and stopped with the collector, cached in
// perpetual-cache.sqlite (src/monitor/perpetual-cache.ts) so a restart or a switch-off keeps the figures.
// M-5b2 adds the workbench's settled-funding history (perpetual-funding-history.mjs: the same life and cache as the metrics,
// 30 days per contract, backfilled in 4-day chunks) and its scanner-data summary (perpetual-scanner-data.mjs: one validated
// batch registered with both services, answering metrics and net window totals for range filters and full sorting).
// M-5c adds the workbench's hourly trade-close history (perpetual-price-history.mjs: one pair per read, the selected legs
// leased for 10 minutes, 3 days first then 30 days in 7-day pages; same life and cache file) for the pair chart.
// Left out (later batches, docs/monitor.md M-4/M-5): the saved quotes (market.sqlite), quality, alerts,
// paper trading, CrossEx filters. Quotes live in memory only; a restart or a switch-off starts from empty.
// Node's own WebSocket is used (it takes request headers); like fetch it goes through Node's global dispatcher, so with
// NODE_USE_ENV_PROXY=1 and HTTPS_PROXY (README) both the directory reads and the sockets use the proxy.
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { constants as zlibConstants, createGzip, type Gzip } from 'node:zlib';
import { EXCHANGES, createSubscriptions, discoverMarkets, getControlResponse, parseMessage, type PerpetualRequestOptions, type PerpetualSpec, type PerpetualVenue } from '../vendor/perpetual-exchanges.mjs';
import { createPerpetualExecutionService, type PerpetualExecutionOptions, type PerpetualExecutionService } from '../vendor/perpetual-depth.mjs';
import { createPerpetualMarketMetricsService, type PerpetualContractMetricsStore } from '../vendor/perpetual-market-metrics-service.mjs';
import { createPerpetualFundingHistoryService, type PerpetualFundingHistoryStore } from '../vendor/perpetual-funding-history-service.mjs';
import { createPerpetualFundingReader } from '../vendor/perpetual-funding-reader.mjs';
import { createPerpetualScannerDataService } from '../vendor/perpetual-scanner-data-service.mjs';
import { createPerpetualPriceHistoryService, type PerpetualPriceHistoryStore } from '../vendor/perpetual-price-history-service.mjs';
import { createPerpetualPriceReader } from '../vendor/perpetual-price-reader.mjs';
import type { PerpetualPriceHistoryReport } from '../vendor/perpetual-price-history.ts';
import type { PerpetualFundingHistoryReport } from '../vendor/perpetual-funding-history.ts';
import type { PerpetualScannerDataReport } from '../vendor/perpetual-scanner-data.ts';
import { createPerpetualMetricsReader } from '../vendor/perpetual-metrics-reader.mjs';
import type { PerpetualMarketMetricsReport } from '../vendor/perpetual-market-metrics.ts';
import { MAX_FUTURE_MS, PERPETUAL_STALE_MS, createPerpetualChangedPatch, mergePerpetualQuote, withMarketMetadata, type PerpetualExchange, type PerpetualMarket, type PerpetualQuote, type PerpetualSnapshot, type PerpetualStatus, type PerpetualUpdate } from '../vendor/perpetual-stream.mjs';

/** The workbench's collection policy (collection-policy.mjs). */
export const PERPETUAL_DISCOVERY_MS = 300_000;
export const PERPETUAL_OBSERVATION_MS = 1_000;
/** A reader whose unsent frames pass this is dropped (the workbench's limit). */
export const PERPETUAL_CLIENT_BACKLOG = 4_000_000;
const CONNECT_TIMEOUT_MS = 20_000, SNAPSHOT_TIMEOUT_MS = 8_000, DISCOVERY_RETRY_MS = 30_000, DISCOVERY_ERROR = '合约列表获取失败，正在重试。';
/** Directory fields that reach readers without a new price and without resubscribing (the workbench's catalogFields). */
const CATALOG_FIELDS = new Set(['delisting', 'delistingAt', 'takerFeeRate', 'takerFeeAt', 'takerFeeSource', 'assetClass', 'identitySource', 'identityVerified']);

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
interface SocketLike {
  readyState: number; binaryType?: string;
  send(data: string): void; close(): void;
  addEventListener(type: 'open' | 'error' | 'close', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}
export type PerpetualSocketFactory = new (url: string, options?: { headers?: Record<string, string> }) => SocketLike;

export interface PerpetualSummary {
  /** Always true, as the workbench's (its page's summary parser requires it); `running` says whether the collector runs. */
  schemaVersion: 1; monitorId: 'perpetual'; available: true; running: boolean; staleAfterMs: number; status: PerpetualStatus;
  state: 'offline' | 'stale' | 'partial' | 'online'; baseCount: number; quoteCount: number; exchangeCount: number;
  onlineExchangeCount: number; liveExchangeCount: number; quoteUpdatedAt: number | null; updatedAt: number | null; message: string;
}
export interface PerpetualStatusView {
  running: boolean; quotes: number; clients: number; connections: number;
  venues: { id: string; status: PerpetualExchange['status']; marketCount: number; reconnects: number; lastMessageAt: number | null; error: string | null; lastProtocolError: string | null }[];
}

interface VenueState {
  id: string; name: string; kind: PerpetualExchange['kind']; marketCount: number; lastMessageAt: number | null; error: string | null; snapshotError: string | null;
  discovering: boolean; retryPending: boolean; discoveryFailing: boolean; markets?: Map<string, PerpetualMarket>; signature?: string; generation: number; reconnects: number; lastProtocolError: string | null;
}
interface Connection { exchange: string; socket: SocketLike | null; timers: Set<ReturnType<typeof setTimeout>>; closed: boolean; lastMessageAt: number; lastQuoteAt: number; snapshotController?: AbortController; dispose(): void }
interface PollBudget { startedAt: number; sent: number; nextAt: number; blockedUntil: number; failures: number }
type GenerationSpec = PerpetualSpec & { generation: number };

export interface PerpetualOptions {
  exchanges?: readonly Pick<PerpetualVenue, 'id' | 'name' | 'kind'>[];
  discover?: (exchange: string, options: PerpetualRequestOptions) => Promise<PerpetualMarket[]>;
  subscriptions?: (exchange: string, markets: PerpetualMarket[]) => PerpetualSpec[];
  parse?: typeof parseMessage; control?: typeof getControlResponse;
  /** Public REST reads (discovery, book snapshots); tests stand in for the venues. */
  fetchImpl?: Fetcher;
  WebSocketImpl?: PerpetualSocketFactory;
  now?: () => number; log?: (line: string) => void;
  staleAfterMs?: number; retryMs?: number; discoveryIntervalMs?: number; observationIntervalMs?: number; broadcastIntervalMs?: number;
  watchdogIntervalMs?: number; quoteTimeoutMs?: number;
  /** The depth / exit / FX reads' venues (tests and the local preview stand in for them). */
  execution?: Pick<PerpetualExecutionOptions, 'fetchImpl' | 'WebSocketImpl' | 'maxMarkets' | 'cacheMs'>;
  /** M-5b1: the market-metrics reads' venues (tests and the local preview stand in for them) and the scheduler tick. */
  metrics?: { fetchImpl?: (url: string, init: RequestInit) => Promise<Response>; intervalMs?: number };
  /** M-5b2: the settled-funding history reads' venues (tests and the local preview stand in for them). */
  fundingHistory?: { fetchImpl?: (url: string, init: RequestInit) => Promise<Response> };
  /** M-5c: the hourly trade-close reads' venues (tests and the local preview stand in for them). */
  priceHistory?: { fetchImpl?: (url: string, init: RequestInit) => Promise<Response> };
  /** M-5b1/M-5b2/M-5c: the metrics, funding and price history cache (perpetual-cache.sqlite); without it all live in memory. */
  cache?: (PerpetualContractMetricsStore & Partial<PerpetualFundingHistoryStore> & Partial<PerpetualPriceHistoryStore>) | null;
  /** M-5b1: set when the cache file could not be opened; every metrics report then carries it as its storageError. */
  cacheUnavailable?: string;
}

/** A refusal of the depth, exit or FX read, with the HTTP status the workbench gives it. */
export class PerpetualInspectionError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** Whether Accept-Encoding allows gzip (`gzip;q=0` refuses it). */
export function acceptsGzip(header: string | string[] | undefined): boolean {
  return String(header ?? '').split(',').some(part => {
    const [name, ...params] = part.split(';').map(item => item.trim().toLowerCase());
    if (name !== 'gzip') return false;
    const q = params.map(param => param.replace(/\s+/g, '')).find(param => param.startsWith('q='));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);

export function createPerpetualMonitor({
  exchanges = EXCHANGES, discover = discoverMarkets, subscriptions = createSubscriptions, parse = parseMessage, control = getControlResponse,
  fetchImpl, WebSocketImpl = globalThis.WebSocket as unknown as PerpetualSocketFactory, now: clock = Date.now, log = line => process.stderr.write(`${line}\n`),
  staleAfterMs = PERPETUAL_STALE_MS, retryMs = 5_000, discoveryIntervalMs = PERPETUAL_DISCOVERY_MS, observationIntervalMs = PERPETUAL_OBSERVATION_MS,
  broadcastIntervalMs = PERPETUAL_OBSERVATION_MS, watchdogIntervalMs = 10_000, quoteTimeoutMs = 45_000, execution: executionOptions,
  metrics: metricsOptions, fundingHistory: fundingOptions, priceHistory: priceOptions, cache = null, cacheUnavailable,
}: PerpetualOptions = {}) {
  const quotes = new Map<string, PerpetualQuote>(), pendingQuotes = new Map<string, PerpetualQuote>(), publishedQuotes = new Map<string, PerpetualQuote>(), publishDirty = new Set<string>();
  const connections = new Set<Connection>(), timers = new Set<ReturnType<typeof setTimeout>>(), pollBudgets = new Map<string, PollBudget>();
  const discoveries = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  const clients = new Map<ServerResponse, { output: ServerResponse | Gzip; needsSnapshot: boolean }>();
  const fresh = (): Map<string, VenueState> => new Map(exchanges.map(exchange => [exchange.id, { id: exchange.id, name: exchange.name, kind: exchange.kind, marketCount: 0, lastMessageAt: null, error: null, snapshotError: null, discovering: false, retryPending: false, discoveryFailing: false, generation: 0, reconnects: 0, lastProtocolError: null }]));
  let states = fresh();
  let running = false, sequence = 0, streamId = randomUUID();
  // A new one per start: stop() aborts its controller for good (the workbench's service is never restarted).
  let execution: PerpetualExecutionService | null = null;
  async function inspect<T>(read: (service: PerpetualExecutionService) => Promise<T>): Promise<T> {
    if (!execution) throw new PerpetualInspectionError(503, '合约价差采集未运行，开启后再查询盘口');
    try { return await read(execution); }
    catch (error) {
      const status = (error as { status?: unknown })?.status;
      throw new PerpetualInspectionError(typeof status === 'number' && status >= 400 && status < 600 ? status : 502, reason(error));
    }
  }
  // One for the collector's life (its registrations and cache outlive a switch-off); its stop is async (the in-flight reads
  // settle, then the dirty entries are written back), awaited by settled() before the cache file closes.
  const metricsFetch = metricsOptions?.fetchImpl ?? fetchImpl;
  const marketMetrics = createPerpetualMarketMetricsService({
    getSnapshot: () => ({ quotes: [...quotes.values()] }), getMarket: (exchange, symbol) => states.get(exchange)?.markets?.get(symbol),
    store: cache, clock, reader: createPerpetualMetricsReader({ clock, ...(metricsFetch ? { fetchImpl: metricsFetch } : {}) }),
    ...(metricsOptions?.intervalMs ? { intervalMs: metricsOptions.intervalMs } : {}),
  });
  const fundingFetch = fundingOptions?.fetchImpl ?? fetchImpl;
  const fundingHistory = createPerpetualFundingHistoryService({
    getSnapshot: () => ({ quotes: [...quotes.values()] }), getMarket: (exchange, symbol) => states.get(exchange)?.markets?.get(symbol),
    store: cache, clock, reader: createPerpetualFundingReader({ clock, requestSpacingMs: 350, ...(fundingFetch ? { fetchImpl: fundingFetch } : {}) }),
  });
  const priceFetch = priceOptions?.fetchImpl ?? fetchImpl;
  const priceHistory = createPerpetualPriceHistoryService({
    getSnapshot: () => ({ quotes: [...quotes.values()] }), getMarket: (exchange, symbol) => states.get(exchange)?.markets?.get(symbol),
    store: cache, clock, reader: createPerpetualPriceReader({ clock, requestSpacingMs: 350, ...(priceFetch ? { fetchImpl: priceFetch } : {}) }),
  });
  const scannerData = createPerpetualScannerDataService({
    getSnapshot: () => ({ quotes: [...quotes.values()] }), getMarket: (exchange, symbol) => states.get(exchange)?.markets?.get(symbol),
    marketMetrics, fundingHistory, clock,
  });
  let metricsStopping: Promise<void> = Promise.resolve();
  // The cached reads (metrics, funding history, scanner data, price history): 503 while stopped, the service's 400 for an invalid batch, any other failure 500; the cache's
  // unavailability rides along as the report's storageError.
  function cachedRead<T extends { storageError?: string }>(stopped: string, read: () => T): T {
    if (!running) throw new PerpetualInspectionError(503, stopped);
    try {
      const report = read();
      return cacheUnavailable && !report.storageError ? { ...report, storageError: cacheUnavailable } : report;
    } catch (error) {
      const status = (error as { status?: unknown })?.status;
      throw new PerpetualInspectionError(status === 400 ? 400 : 500, reason(error));
    }
  }
  let observationTimer: ReturnType<typeof setInterval> | undefined, broadcastTimer: ReturnType<typeof setInterval> | undefined, refreshTimer: ReturnType<typeof setInterval> | undefined;
  const venue = (exchange: string): VenueState => states.get(exchange)!;

  function changedQuote(key: string, quote: PerpetualQuote): void { quotes.set(key, quote); if (clients.size) publishDirty.add(key); }
  function observe(): void {
    // Directory metadata may change after receipt but before this commit.
    for (const [key, quote] of pendingQuotes) changedQuote(key, withMarketMetadata(quote, states.get(quote.exchange)?.markets?.get(quote.symbol)));
    pendingQuotes.clear();
  }
  const later = (fn: () => void, ms: number): ReturnType<typeof setTimeout> => {
    const timer = setTimeout(() => { timers.delete(timer); if (running) fn(); }, ms);
    timer.unref?.(); timers.add(timer); return timer;
  };
  const connected = (): Set<string> => new Set([...connections].filter(connection => connection.socket?.readyState === 1).map(connection => connection.exchange));

  function snapshot(): PerpetualSnapshot {
    const now = clock();
    const isFresh = (time: number | undefined) => Number.isFinite(time) && time! >= now - staleAfterMs && time! <= now + MAX_FUTURE_MS;
    const values = [...quotes.values()], counts = new Map<string, { all: number; fresh: number; freshBook: number; staleBook: number; missingBook: number }>();
    for (const quote of values) {
      const own = counts.get(quote.exchange) ?? { all: 0, fresh: 0, freshBook: 0, staleBook: 0, missingBook: 0 }; own.all++;
      const book = (quote.bid ?? 0) > 0 && (quote.ask ?? 0) >= quote.bid! && Number.isFinite(quote.bidAskAt) && quote.bidAskAt! <= now + MAX_FUTURE_MS;
      if (book) { if (isFresh(quote.bidAskAt)) own.freshBook++; else own.staleBook++; } else own.missingBook++;
      if ((book && isFresh(quote.bidAskAt)) || ((quote.mark ?? 0) > 0 && isFresh(quote.markAt))) own.fresh++;
      counts.set(quote.exchange, own);
    }
    const live = connected();
    const exchangeViews: PerpetualExchange[] = [...states.values()].map(state => {
      const own = counts.get(state.id) ?? { all: 0, fresh: 0, freshBook: 0, staleBook: 0, missingBook: 0 };
      const status = !running ? 'disabled' : live.has(state.id) && own.fresh ? 'live' : own.all ? 'stale' : state.error ? 'error' : 'connecting';
      return { id: state.id, name: state.name, kind: state.kind, status, marketCount: state.marketCount, quoteCount: own.fresh, freshBookCount: own.freshBook, staleBookCount: own.staleBook, missingBookCount: own.missingBook, lastMessageAt: state.lastMessageAt, error: state.error || state.snapshotError || null };
    });
    const liveCount = exchangeViews.filter(exchange => exchange.status === 'live').length;
    return { schemaVersion: 1, monitorId: 'perpetual', streamId, sequence, status: liveCount === states.size && liveCount > 0 ? 'live' : liveCount ? 'partial' : quotes.size ? 'snapshot' : running ? 'connecting' : 'unavailable', generatedAt: now, staleAfterMs, exchanges: exchangeViews, quotes: values, storageError: null };
  }

  function send(connection: Connection, value: unknown): void {
    if (connection.socket?.readyState === 1) connection.socket.send(typeof value === 'string' ? value : JSON.stringify(value));
  }

  function connect(exchange: string, spec: GenerationSpec, attempt = 0): void {
    const state = states.get(exchange);
    if (!running || !state || spec.generation !== state.generation) return;
    const connection: Connection = { exchange, socket: null, timers: new Set(), closed: false, lastMessageAt: clock(), lastQuoteAt: clock(), dispose: () => undefined };
    const context = structuredClone(spec.context ?? {});
    const pollHost = new URL(spec.url).host;
    let pollCursor = 0;
    if (spec.poll && !pollBudgets.has(pollHost)) pollBudgets.set(pollHost, { startedAt: clock(), sent: 0, nextAt: 0, blockedUntil: 0, failures: 0 });
    const clear = () => { for (const timer of connection.timers) { clearTimeout(timer); clearInterval(timer); timers.delete(timer); } connections.delete(connection); };
    const scheduleTask = (fn: () => void, ms: number) => { const timer = later(() => { connection.timers.delete(timer); if (!connection.closed) fn(); }, ms); connection.timers.add(timer); return timer; };
    connection.dispose = () => { connection.closed = true; clear(); connection.snapshotController?.abort(); try { connection.socket?.close(); } catch { /* already closed */ } };
    const fail = (message: string) => {
      if (connection.closed) return;
      state.error = message; state.reconnects++; connection.dispose();
      if (running) later(() => connect(exchange, spec, attempt + 1), Math.min(60_000, retryMs * 2 ** Math.min(attempt, 4)) + Math.floor(Math.random() * retryMs / 4));
    };
    const acceptUpdates = (updates: PerpetualUpdate[], now: number, transport: 'ws' | 'rest' = 'ws') => {
      for (const update of updates) {
        if (update.exchange !== exchange) continue;
        if (Number.isFinite(update.sourceTime) && now - update.sourceTime! < -MAX_FUTURE_MS) state.error = '行情时间领先服务器，请检查服务器时钟。';
        const key = `${exchange}:${update.symbol}`, previous = pendingQuotes.get(key) ?? quotes.get(key);
        const next = mergePerpetualQuote(previous, transport === 'rest' ? { ...update, transport } : update, now);
        if (next && next !== previous) {
          pendingQuotes.set(key, withMarketMetadata(next, state.markets?.get(update.symbol)));
          if (observationIntervalMs <= 0) observe();
          if (transport === 'ws') connection.lastQuoteAt = now;
          state.lastMessageAt = now; state.error = null; attempt = 0;
        }
      }
    };
    const requestSnapshot = async () => {
      const controller = new AbortController(); connection.snapshotController = controller;
      try {
        const updates = await spec.snapshot!({ signal: AbortSignal.any([controller.signal, AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS)]), now: clock(), ...(fetchImpl ? { fetchImpl } : {}) });
        if (running && !connection.closed) { acceptUpdates(updates, clock(), 'rest'); state.snapshotError = null; }
      } catch { if (running && !connection.closed) state.snapshotError = '盘口补充快照暂不可用，正在重试。'; }
      finally { if (running && !connection.closed) scheduleTask(() => { void requestSnapshot(); }, spec.snapshotIntervalMs ?? 10_000); }
    };
    const poll = () => {
      const plan = spec.poll!, started = clock(), messages = plan.messages, budget = pollBudgets.get(pollHost)!;
      if (budget.blockedUntil > started) { scheduleTask(poll, budget.blockedUntil - started); return; }
      let remaining = messages.length;
      const next = () => {
        const now = clock();
        if (budget.blockedUntil > now) { scheduleTask(poll, budget.blockedUntil - now); return; }
        if (plan.maxPerMinute && budget.nextAt > now) { scheduleTask(next, budget.nextAt - now); return; }
        if (now < budget.startedAt || now - budget.startedAt >= 60_000) { budget.startedAt = now; budget.sent = 0; }
        if (plan.maxPerMinute && budget.sent >= plan.maxPerMinute) { scheduleTask(poll, Math.max(100, budget.startedAt + 60_000 - now)); return; }
        while (remaining > 0) {
          const message = messages[pollCursor++ % messages.length]!; remaining--;
          const symbol = message.request?.payload?.coin, quote = pendingQuotes.get(`${exchange}:${symbol}`) ?? quotes.get(`${exchange}:${symbol}`);
          // A book still fresh from the stream needs no auxiliary read.
          if (plan.staleBookAfterMs && quote && (quote.bid ?? 0) > 0 && (quote.ask ?? 0) >= quote.bid! && Number.isFinite(quote.bidAskAt)
            && quote.bidAskAt! >= now - plan.staleBookAfterMs && quote.bidAskAt! <= now + MAX_FUTURE_MS) continue;
          try {
            send(connection, message); budget.sent++;
            if (plan.maxPerMinute) budget.nextAt = now + Math.ceil(60_000 / plan.maxPerMinute);
          } catch { fail('WebSocket 快照请求失败，正在重连。'); return; }
          break;
        }
        if (remaining > 0) scheduleTask(next, plan.sendIntervalMs ?? 100);
        else scheduleTask(poll, Math.max(plan.sendIntervalMs ?? 100, (plan.intervalMs ?? 10_000) - (clock() - started)));
      };
      if (messages.length) next();
    };
    try {
      const socket = new WebSocketImpl(spec.url, spec.headers ? { headers: spec.headers } : undefined);
      connection.socket = socket;
      try { socket.binaryType = 'arraybuffer'; } catch { /* a stand-in without it */ }
      connections.add(connection);
      scheduleTask(() => { if (socket.readyState !== 1) fail('WebSocket 连接超时，正在重连。'); }, CONNECT_TIMEOUT_MS);
      socket.addEventListener('open', () => {
        if (connection.closed || !running) return connection.dispose();
        (spec.subscribe ?? []).forEach((message, index) => scheduleTask(() => {
          try { send(connection, message); } catch { fail('WebSocket 订阅失败，正在重连。'); }
        }, index * (spec.sendIntervalMs ?? 100)));
        if (spec.poll) scheduleTask(poll, ((spec.subscribe?.length ?? 0) + 1) * (spec.sendIntervalMs ?? 100));
        if (spec.snapshot) scheduleTask(() => { void requestSnapshot(); }, 500);
        if (spec.heartbeat) {
          const heartbeat = setInterval(() => { try { send(connection, spec.heartbeat); } catch { fail('WebSocket 心跳失败，正在重连。'); } }, spec.heartbeatMs ?? 20_000);
          heartbeat.unref?.(); connection.timers.add(heartbeat);
        }
        const watchdog = setInterval(() => {
          if (clock() - connection.lastMessageAt > quoteTimeoutMs) fail('WebSocket 未收到数据，正在重连。');
          else if (clock() - connection.lastQuoteAt > quoteTimeoutMs) fail('WebSocket 只有心跳，未收到有效行情，正在重订阅。');
        }, watchdogIntervalMs);
        watchdog.unref?.(); connection.timers.add(watchdog);
      });
      socket.addEventListener('message', event => {
        if (connection.closed || !running) return;
        const now = clock(); connection.lastMessageAt = now;
        let payload: unknown;
        try { payload = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data as ArrayBuffer).toString()); }
        catch { payload = event.data; }
        try {
          // An auxiliary read's error (a 429) backs off only the shared-host poller, never the healthy book stream.
          const post = payload as { channel?: string; data?: { response?: { type?: string; payload?: unknown } } } | null;
          if (spec.poll && post?.channel === 'post' && post.data?.response?.type === 'error') {
            const budget = pollBudgets.get(pollHost)!;
            budget.failures++;
            budget.blockedUntil = now + Math.min(300_000, 60_000 * 2 ** Math.min(budget.failures - 1, 3));
            state.lastProtocolError = `${exchange} auxiliary snapshot: ${String(post.data.response.payload).slice(0, 230)}`;
            return;
          }
          if (spec.poll && post?.channel === 'post' && post.data?.response?.type === 'info') pollBudgets.get(pollHost)!.failures = 0;
          const reply = control(exchange, payload);
          if (reply != null) send(connection, reply);
          acceptUpdates(parse(exchange, payload, spec.markets ?? [], now, context), now);
        } catch (error) { state.lastProtocolError = reason(error).slice(0, 300); fail('行情消息无效，正在重新订阅。'); }
      });
      socket.addEventListener('error', () => fail('WebSocket 暂不可用，正在重连。'));
      socket.addEventListener('close', () => fail('WebSocket 已断开，正在重连。'));
    } catch { fail('无法建立 WebSocket，正在重试。'); }
  }

  async function refresh(exchange: string): Promise<void> {
    const state = venue(exchange);
    if (!running || state.discovering) return;
    state.discovering = true;
    const controller = new AbortController(), owner = states;
    const promise = (async () => {
      try {
        const markets = await discover(exchange, { signal: controller.signal, ...(fetchImpl ? { fetchImpl } : {}) });
        if (!running || states !== owner) return;
        if (!markets.length) throw new Error('No active markets');
        const specs = subscriptions(exchange, markets);
        if (!specs.length) throw new Error('No subscriptions');
        if (state.discoveryFailing) { state.discoveryFailing = false; log(`合约价差：${state.name} 合约列表已恢复`); }
        if (state.error === DISCOVERY_ERROR) state.error = null;
        state.marketCount = markets.length;
        // Funding intervals, multipliers and channel ids may change while symbols stay; lifecycle, fee and classification
        // fields reach readers without a new price and without resubscribing.
        const identities = new Map(markets.map(market => [market.symbol, market]));
        const signature = JSON.stringify([...markets].sort((left, right) => left.symbol.localeCompare(right.symbol)), (key, value) => CATALOG_FIELDS.has(key) ? undefined : value);
        state.markets = identities;
        for (const [key, quote] of quotes) {
          if (quote.exchange !== exchange || !identities.has(quote.symbol)) continue;
          const current = withMarketMetadata(quote, identities.get(quote.symbol));
          if (current !== quote) changedQuote(key, current);
        }
        if (signature === state.signature) return;
        // A retired subscription generation must not publish a buffered quote of an old contract.
        for (const [key, quote] of pendingQuotes) if (quote.exchange === exchange) pendingQuotes.delete(key);
        for (const [key, quote] of quotes) {
          if (quote.exchange !== exchange) continue;
          const market = identities.get(quote.symbol);
          if (!market || quote.base !== market.base || quote.quoteCurrency !== market.quoteCurrency || (quote.multiplier ?? 1) !== (market.multiplier ?? 1)
            || (market.contractUnit && market.contractUnit !== quote.contractUnit) || (market.comparable === false && quote.comparable !== false)) {
            quotes.delete(key); if (clients.size) publishDirty.add(key);
          }
        }
        // Retire the previous generation's reconnect timers as well as its live connections.
        state.generation++;
        for (const connection of [...connections]) if (connection.exchange === exchange) connection.dispose();
        state.signature = signature;
        for (const spec of specs) {
          const current = { ...spec, generation: state.generation };
          later(() => connect(exchange, current), spec.startDelayMs ?? 0);
        }
      } catch (error) {
        if (running && states === owner) {
          // Logged once per run of failures (a venue blocked from this address fails every 30 s for good), apart from the
          // status error, which an older generation's quotes clear while the directory keeps failing.
          if (!state.discoveryFailing) log(`合约价差：${state.name} 合约列表获取失败（${reason(error)}），每 ${DISCOVERY_RETRY_MS / 1000} 秒重试，恢复前不再记录`);
          state.discoveryFailing = true; state.error = DISCOVERY_ERROR;
          // One pending retry per venue: the 5-minute refresh failing again must not start a second 30-second chain.
          if (!state.retryPending) { state.retryPending = true; later(() => { state.retryPending = false; void refresh(exchange); }, DISCOVERY_RETRY_MS); }
        }
      } finally { state.discovering = false; if (discoveries.get(exchange)?.controller === controller) discoveries.delete(exchange); }
    })();
    discoveries.set(exchange, { controller, promise });
    await promise;
  }

  function broadcast(): void {
    if (!clients.size) return;
    const baseSequence = sequence++, current = snapshot();
    const delta = createPerpetualChangedPatch(current, quotes, publishedQuotes, publishDirty);
    publishDirty.clear();
    const message = `data: ${JSON.stringify({ ...delta, baseSequence })}\n\n`;
    let fullMessage: string | null = null;
    for (const [response, client] of clients) {
      const { output } = client;
      if (response.destroyed || response.writableEnded) { clients.delete(response); continue; }
      if (response.writableLength + output.writableLength > PERPETUAL_CLIENT_BACKLOG) { response.destroy(); clients.delete(response); continue; }
      if (response.writableNeedDrain || output.writableNeedDrain) { client.needsSnapshot = true; continue; }
      // A slow reader cannot skip a patch and continue from a broken baseline: it gets the whole table again.
      if (client.needsSnapshot) { fullMessage ??= `data: ${JSON.stringify({ ...current, quotes: [...publishedQuotes.values()] })}\n\n`; output.write(fullMessage); client.needsSnapshot = false; }
      else output.write(message);
    }
    if (!clients.size) { publishedQuotes.clear(); publishDirty.clear(); }
  }

  function closeStreams(): void { for (const client of clients.values()) client.output.end(); clients.clear(); publishedQuotes.clear(); publishDirty.clear(); }

  return {
    running: (): boolean => running,
    /** Starts discovery and the connections; idempotent. */
    start(): void {
      if (running) return;
      running = true;
      execution = createPerpetualExecutionService({
        getQuote: (exchange, symbol) => quotes.get(`${exchange}:${symbol}`), getMarket: (exchange, symbol) => states.get(exchange)?.markets?.get(symbol),
        clock, ...(fetchImpl ? { fetchImpl } : {}), ...executionOptions,
      });
      marketMetrics.start(); fundingHistory.start(); priceHistory.start();
      if (observationIntervalMs > 0) { observationTimer = setInterval(observe, observationIntervalMs); observationTimer.unref?.(); }
      for (const exchange of states.keys()) void refresh(exchange);
      refreshTimer = setInterval(() => { for (const exchange of states.keys()) void refresh(exchange); }, discoveryIntervalMs);
      broadcastTimer = setInterval(broadcast, broadcastIntervalMs);
      refreshTimer.unref?.(); broadcastTimer.unref?.();
    },
    /**
     * Stops everything (the switch turned off, or the service stopping): the readers' streams end, the connections close, and
     * the quotes are dropped — a later start begins with a new stream id and an empty table rather than hours-old prices.
     */
    stop(): void {
      if (!running) return;
      running = false; closeStreams();
      execution?.stop(); execution = null;
      metricsStopping = Promise.all([marketMetrics.stop(), fundingHistory.stop(), priceHistory.stop()].map(stopping => stopping.catch(() => undefined))).then(() => undefined);
      for (const timer of [observationTimer, refreshTimer, broadcastTimer]) clearInterval(timer);
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const item of discoveries.values()) item.controller.abort();
      discoveries.clear();
      for (const connection of [...connections]) connection.dispose();
      quotes.clear(); pendingQuotes.clear(); pollBudgets.clear();
      states = fresh(); sequence = 0; streamId = randomUUID();
    },
    snapshot,
    /** The status page's and the overview's one-line view (the workbench's summary, without the CrossEx filter). */
    summary(): PerpetualSummary {
      const now = clock(), live = connected(), freshVenues = new Set<string>(), onlineVenues = new Set<string>(), bases = new Set<string>();
      let freshCount = 0, quoteUpdatedAt: number | null = null;
      for (const quote of quotes.values()) {
        const at = quote.bidAskAt;
        bases.add(quote.base);
        const book = (quote.bid ?? 0) > 0 && (quote.ask ?? 0) >= quote.bid! && Number.isFinite(at) && at! <= now + MAX_FUTURE_MS;
        const mark = (quote.mark ?? 0) > 0 && Number.isFinite(quote.markAt) && quote.markAt! <= now + MAX_FUTURE_MS;
        // Funding and receipt times never renew a retained price.
        if (book && at! > 0) quoteUpdatedAt = Math.max(quoteUpdatedAt ?? 0, at!);
        if (mark && quote.markAt! > 0) quoteUpdatedAt = Math.max(quoteUpdatedAt ?? 0, quote.markAt!);
        if (!live.has(quote.exchange)) continue;
        if (book && now - at! <= staleAfterMs) { freshCount++; freshVenues.add(quote.exchange); }
        if ((book && now - at! <= staleAfterMs) || (mark && now - quote.markAt! <= staleAfterMs)) onlineVenues.add(quote.exchange);
      }
      const missing = [...states.values()].filter(state => !freshVenues.has(state.id)).map(state => state.name);
      const times = [...states.values()].map(state => state.lastMessageAt);
      const updatedAt = times.length && times.every(at => Number.isFinite(at) && at! > 0 && at! <= now + MAX_FUTURE_MS) ? Math.min(...times as number[]) : null;
      return {
        schemaVersion: 1, monitorId: 'perpetual', available: true, running, staleAfterMs,
        status: onlineVenues.size === states.size && onlineVenues.size > 0 ? 'live' : onlineVenues.size ? 'partial' : quotes.size ? 'snapshot' : running ? 'connecting' : 'unavailable',
        state: !quotes.size ? 'offline' : !freshCount ? 'stale' : missing.length || freshCount < quotes.size ? 'partial' : 'online',
        baseCount: bases.size, quoteCount: quotes.size, exchangeCount: states.size, onlineExchangeCount: onlineVenues.size, liveExchangeCount: freshVenues.size, quoteUpdatedAt, updatedAt,
        message: [missing.length ? `行情待更新：${missing.join('、')}` : '', freshCount < quotes.size ? `${quotes.size - freshCount} 条盘口过期或缺失` : ''].filter(Boolean).join('；'),
      };
    },
    status(): PerpetualStatusView {
      const views = new Map(snapshot().exchanges.map(exchange => [exchange.id, exchange]));
      return {
        running, quotes: quotes.size, clients: clients.size, connections: connections.size,
        venues: [...states.values()].map(state => ({ id: state.id, status: views.get(state.id)!.status, marketCount: state.marketCount, reconnects: state.reconnects, lastMessageAt: state.lastMessageAt, error: state.error || state.snapshotError || null, lastProtocolError: state.lastProtocolError })),
      };
    },
    /**
     * One reader's SSE stream: `retry: 5000` and the whole table first, then each second a patch with `baseSequence`
     * (frames as the workbench's). gzip when the reader accepts it (one sync-flushed stream per reader).
     */
    stream(request: IncomingMessage, response: ServerResponse): void {
      const gzip = acceptsGzip(request.headers['accept-encoding']);
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff', vary: 'Accept-Encoding', ...(gzip ? { 'content-encoding': 'gzip' } : {}) });
      const output = gzip ? createGzip({ level: 1, flush: zlibConstants.Z_SYNC_FLUSH }) : response;
      if (gzip) { output.pipe(response); output.on('error', () => response.destroy()); }
      const initial = snapshot();
      if (!clients.size) { publishedQuotes.clear(); publishDirty.clear(); for (const quote of initial.quotes) publishedQuotes.set(`${quote.exchange}:${quote.symbol}`, quote); }
      // Join the shared patch baseline exactly: a newer quote sent now could reverse before the next patch, which would then
      // omit that field and leave this reader with a wrong price despite a continuous sequence.
      else initial.quotes = [...publishedQuotes.values()];
      output.write(`retry: 5000\ndata: ${JSON.stringify(initial)}\n\n`);
      clients.set(response, { output, needsSnapshot: false });
      response.once('close', () => { clients.delete(response); if (!clients.size) { publishedQuotes.clear(); publishDirty.clear(); } if (gzip) output.destroy(); });
      if (!running) closeStreams();
    },
    closeStreams,
    /** M-5a: the public books for a long-leg USDT amount on both legs (the workbench's depth action). */
    depth: (input: unknown) => inspect(service => service.depth(input)),
    /** M-5a: closing a position into the current public books (the workbench's exit action). */
    exit: (input: unknown) => inspect(service => service.exit(input)),
    /** M-5a: the spot FX rates of USDC, USD1, USDG and USD in USDT (cached a minute). */
    fx: () => inspect(service => service.fx()),
    /**
     * M-5b1: the 24h volume and open interest of up to 30 current pairs (the workbench's metrics action); registers the legs
     * for the 30 s refresh and answers from the cache at once. 503 while stopped, 400 for an invalid batch.
     */
    async marketMetrics(input: unknown): Promise<PerpetualMarketMetricsReport> {
      return cachedRead('合约价差采集未运行，开启后再读取市场指标', () => marketMetrics.read(input));
    },
    /**
     * M-5b2: the settled-funding histories of up to 30 current pairs (the workbench's funding-history action); registers the
     * legs for backfill and refresh and answers from the cache at once. 503 while stopped, 400 for an invalid batch.
     */
    async fundingHistory(input: unknown): Promise<PerpetualFundingHistoryReport> {
      return cachedRead('合约价差采集未运行，开启后再读取历史资金费', () => fundingHistory.read(input));
    },
    /**
     * M-5b2: the range filters' and full sorting's data for up to 30 current pairs (the workbench's scanner-data action):
     * metrics and the requested net window totals, registering the legs with both services. 503 / 400 as above.
     */
    async scannerData(input: unknown): Promise<PerpetualScannerDataReport> {
      return cachedRead('合约价差采集未运行，开启后再读取筛选数据', () => scannerData.read(input));
    },
    /**
     * M-5c: the hourly trade closes of one current pair's two legs (the workbench's price-history action) for a 3, 7 or 30 day
     * chart; leases both legs for 10 minutes and answers from the cache at once. 503 while stopped, 400 for an invalid pair.
     */
    async priceHistory(input: unknown): Promise<PerpetualPriceHistoryReport> {
      return cachedRead('合约价差采集未运行，开启后再读取成交价历史', () => priceHistory.read(input));
    },
    /** M-5b1: resolves once the last stop has written the metrics and histories back (the cache file may close then). */
    settled: (): Promise<void> => metricsStopping,
  };
}
export type PerpetualMonitor = ReturnType<typeof createPerpetualMonitor>;
