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
// M-5d2 adds the workbench's quality service (perpetual-quality-service.mjs): a ranked sample of the current quotes every
// minute (at most 1000 pairs, 24 hours kept in perpetual-cache.sqlite quality_samples and restored on start), CoinGecko
// fundamentals of every comparable base in the background (checked each minute; the coin list kept 24 hours, market data 30
// minutes, page or not) and the public long/short account ratios of the pairs a page read in the last 3 minutes; same life.
// M-5e1 adds the workbench's paper-position service (perpetual-paper-service.mjs): simulated and manually registered positions
// (at most 20 active, 100 ended for 30 days) kept in the data directory's perpetual-paper-positions.json
// (src/monitor/perpetual-paper-store.ts), each active one valued once a minute from the in-memory books while the collector runs
// (checked on the broadcast timer, throttled by the service); built once, started and stopped with the collector.
// M-5e2: records the workbench import left pending (perpetual-paper-positions.import.json) are merged on the broadcast timer
// while the collector runs, and when it starts: the paper service is stopped (its writes drained), the store merges the file,
// and the service is built again on the merged records; page writes wait for it. While the collector is off nothing is merged.
// M-5f serves CrossEx signals from this collector. The FX and spot-transfer data come from the market process in production.
// Quotes live in memory only; a restart or a switch-off starts from empty.
// Node's own WebSocket is used (it takes request headers); like fetch it goes through Node's global dispatcher, so with
// NODE_USE_ENV_PROXY=1 and HTTPS_PROXY (README) both the directory reads and the sockets use the proxy.
import { createPerpetualAlertService, type OpportunityNotifications } from '../vendor/perpetual-alert-service.mjs';
import type { PerpetualAlertStore } from '../vendor/perpetual-alert-store.mjs';
import { randomUUID } from 'node:crypto';
import { isBaseBlocked } from '../vendor/asset-identity.mjs';
import { createCrossExFilterService, type CrossExFilterOptions } from '../vendor/perpetual-crossex-service.mjs';
import { createSpotTransferReader } from '../vendor/perpetual-spot-transfer.mjs';
import { createPerpetualOpportunities } from '../vendor/perpetual-opportunities.mjs';
import { createOpportunitiesV2Reader } from '../vendor/perpetual-opportunities-v2.mjs';
import type { PerpetualOpportunities, PerpetualOpportunitiesV2 } from '../vendor/perpetual-opportunities.ts';
import type { PerpetualFxSnapshot } from '../vendor/perpetual-fx.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { constants as zlibConstants, createGzip, type Gzip } from 'node:zlib';
import type { RemotePerpetual } from '../service/remote-monitor.ts';
import { STREAM_OBSERVATION_MS, MARKET_CATALOG_MS, MARKET_METRICS_POLL_MS, AUXILIARY_BOOK_POLL_MS } from '../vendor/perpetual-collection-policy.mjs';
import { EXCHANGES } from '../vendor/perpetual-venues.mjs';
import { createPerpetualFeed, type FeedEvent, type FeedHealth, type FeedVenue, type PerpetualFeedOptions } from './perpetual-feed.ts';
export { PERPETUAL_DISCOVERY_MS, PERPETUAL_OBSERVATION_MS, type PerpetualSocketFactory } from './perpetual-feed.ts';
import { createPerpetualExecutionService, type PerpetualExecutionOptions, type PerpetualExecutionService } from '../vendor/perpetual-depth.mjs';
import { createPerpetualMarketMetricsService, type PerpetualContractMetricsStore } from '../vendor/perpetual-market-metrics-service.mjs';
import { createPerpetualFundingHistoryService, type PerpetualFundingHistoryStore } from '../vendor/perpetual-funding-history-service.mjs';
import { createPerpetualFundingReader } from '../vendor/perpetual-funding-reader.mjs';
import { createPerpetualScannerDataService } from '../vendor/perpetual-scanner-data-service.mjs';
import { createPerpetualPriceHistoryService, type PerpetualPriceHistoryStore } from '../vendor/perpetual-price-history-service.mjs';
import { createPerpetualPriceReader } from '../vendor/perpetual-price-reader.mjs';
import type { PriceHistoryReply } from '../vendor/perpetual-price-history.ts';
import { createPerpetualQualityService, type PerpetualQualityStore } from '../vendor/perpetual-quality-service.mjs';
import { createFundamentalsClient, type FundamentalsClient } from '../vendor/perpetual-fundamentals.mjs';
import { fetchPositioning, type PositioningFetch } from '../vendor/perpetual-positioning.mjs';
import type { PerpetualQualityReport } from '../vendor/perpetual-quality.ts';
import { createPerpetualPaperService, type PerpetualPaperStore } from '../vendor/perpetual-paper-service.mjs';
import { PERPETUAL_PAPER_FILE, perpetualPaperAdoptionLine, type PerpetualPaperAdoption, type PerpetualPaperFileStore } from './perpetual-paper-store.ts';
import type { PerpetualPaperView } from '../vendor/perpetual-paper.ts';
import type { PerpetualFundingHistoryReport } from '../vendor/perpetual-funding-history.ts';
import type { PerpetualScannerDataReport } from '../vendor/perpetual-scanner-data.ts';
import { createPerpetualMetricsReader } from '../vendor/perpetual-metrics-reader.mjs';
import type { PerpetualMarketMetricsReport } from '../vendor/perpetual-market-metrics.ts';
import { MAX_FUTURE_MS, PERPETUAL_STALE_MS, createPerpetualChangedPatch, perpetualPriceIdentity, type PerpetualExchange, type PerpetualMarket, type PerpetualQuote, type PerpetualSnapshot, type PerpetualStatus } from '../vendor/perpetual-stream.mjs';

/** A reader whose unsent frames pass this is dropped (the workbench's limit). */
export const PERPETUAL_CLIENT_BACKLOG = 4_000_000;
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

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

export interface PerpetualOptions extends PerpetualFeedOptions {
  crossEx?: CrossExFilterOptions;
  fxRefreshMs?: number;
  /** IPC substitutes the complete venue collector and public data readers in the execution service. */
  remote?: RemotePerpetual;
  alerts?: { store?: PerpetualAlertStore; notifications?: OpportunityNotifications; unavailableReason?: string };
  /** The depth / exit / FX reads' venues (tests and the local preview stand in for them). */
  execution?: Pick<PerpetualExecutionOptions, 'fetchImpl' | 'WebSocketImpl' | 'maxMarkets' | 'cacheMs'>;
  /** M-5b1: the market-metrics reads' venues (tests and the local preview stand in for them) and the scheduler tick. */
  metrics?: { fetchImpl?: (url: string, init: RequestInit) => Promise<Response>; intervalMs?: number };
  /** M-5b2: the settled-funding history reads' venues (tests and the local preview stand in for them). */
  fundingHistory?: { fetchImpl?: (url: string, init: RequestInit) => Promise<Response> };
  /** M-5c: the hourly trade-close reads' venues (tests and the local preview stand in for them). */
  priceHistory?: { fetchImpl?: (url: string, init: RequestInit) => Promise<Response> };
  /**
   * M-5d2: the quality service's sources. `coinIds` / `apiKey` are PERPETUAL_COIN_IDS and COINGECKO_DEMO_API_KEY (service/monitor.ts);
   * `fetchImpl` stands in for CoinGecko and the ratio venues; `fundamentals` / `positioningFetch` replace the clients outright.
   */
  quality?: { fetchImpl?: Fetcher; coinIds?: Record<string, string>; apiKey?: string; fundamentals?: FundamentalsClient; positioningFetch?: PositioningFetch };
  /** M-5b1/M-5b2/M-5c/M-5d2: the metrics, funding and price history and quality-sample cache (perpetual-cache.sqlite); without it all live in memory. */
  cache?: (PerpetualContractMetricsStore & Partial<PerpetualFundingHistoryStore> & Partial<PerpetualPriceHistoryStore> & PerpetualQualityStore) | null;
  /** M-5b1: set when the cache file could not be opened; every metrics report then carries it as its storageError. */
  cacheUnavailable?: string;
  /**
   * M-5e1: the paper-position records (perpetual-paper-positions.json, service/monitor.ts). Without a store the records are
   * unavailable: reads show `unavailableReason`, writes answer 503 with it. M-5e2: a store with `pending` / `adoptPending`
   * (perpetual-paper-store.ts) has its pending import merged while the collector runs.
   */
  paper?: { store?: (PerpetualPaperStore & Partial<Pick<PerpetualPaperFileStore, 'pending' | 'adoptPending'>>) | undefined; unavailableReason?: string };
}

/** The quality service's refusals of an invalid batch (plain Errors there; the workbench's HTTP layer answers them 400). */
const QUALITY_INPUT_ERRORS = new Set(['每次最多评估30个平台组合', '平台组合格式无效']);

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

export function createPerpetualMonitor(options: PerpetualOptions = {}) {
  const {
    exchanges = EXCHANGES, now: clock = Date.now, log = line => process.stderr.write(`${line}\n`),
    staleAfterMs = PERPETUAL_STALE_MS, broadcastIntervalMs = STREAM_OBSERVATION_MS, fetchImpl, execution: executionOptions,
    metrics: metricsOptions, fundingHistory: fundingOptions, priceHistory: priceOptions, quality: qualityOptions, cache = null, cacheUnavailable,
    paper: paperOptions, remote,
  } = options;
  const feed = remote ? null : createPerpetualFeed(options);
  const crossEx = createCrossExFilterService({ clock, read: remote?.spotTransfer ?? createSpotTransferReader({ clock, fetchImpl }), ...options.crossEx });
  const readV2 = createOpportunitiesV2Reader();
  const fxRefreshMs = options.fxRefreshMs ?? (remote || exchanges === EXCHANGES ? 60_000 : 0);
  let sourceRevision = 0, fxGeneration = 0;
  let fxSnapshot: PerpetualFxSnapshot | null = null, fxTimer: ReturnType<typeof setInterval> | undefined;
  let fxRequest: Promise<PerpetualFxSnapshot> | null = null;
  const quotes = new Map<string, PerpetualQuote>(), publishedQuotes = new Map<string, PerpetualQuote>(), publishDirty = new Set<string>();
  const clients = new Map<ServerResponse, { output: ServerResponse | Gzip; needsSnapshot: boolean }>();
  const fresh = () => new Map<string, FeedVenue>(exchanges.map(({ id, name, kind }) => [id, { id, name, kind, marketCount: 0, lastMessageAt: null, error: null, reconnects: 0, lastProtocolError: null, online: false }]));
  let states = fresh(), connectionCount = 0, feedRun = 0, booksAfter = -Infinity;
  let feedEpoch: string | null = null;
  let unsubscribe: (() => void) | undefined;
  const catalogs = new Map<string, Map<string, PerpetualMarket>>(), assembling = new Map<string, Map<string, PerpetualMarket>>();
  const bookTimes = new Map<string, [number, number]>();
  const getMarket = (exchange: string, symbol: string) => catalogs.get(exchange)?.get(symbol);
  const connected = () => new Set([...states.values()].filter(state => state.online).map(state => state.id));
  const venueLive = (id: string) => feed ? feed.online(id) : !!feedEpoch && remote?.epoch() === feedEpoch && states.get(id)?.online === true;
  let feedHealth: FeedHealth | undefined, lastPublishMs: number | null = null, visitedQuotes: number | null = null;
  let healthEventId = 0;
  const healthEvents: { id: number; exchange: string; at: number; reason: string }[] = [];
  function receive(event: FeedEvent): void {
    if (event.type === 'reset' || event.type === 'quotes' || (event.type === 'catalog' && event.last)) sourceRevision++;
    switch (event.type) {
      case 'reset':
        feedHealth = undefined; lastPublishMs = null; visitedQuotes = null; healthEvents.length = 0;
        feedEpoch = remote?.epoch() ?? null;
        resetFx();
        if (remote) { crossEx.resetSource(); if (fxRefreshMs > 0) queueMicrotask(refreshFx); }
        for (const key of quotes.keys()) if (clients.size) publishDirty.add(key);
        quotes.clear(); bookTimes.clear(); catalogs.clear(); assembling.clear(); states = fresh(); connectionCount = 0;
        break;
      case 'catalog': {
        if (event.first) assembling.set(event.exchange, new Map());
        const group = assembling.get(event.exchange);
        if (!group) break;
        for (const market of event.markets) group.set(market.symbol, market);
        if (event.last) { catalogs.set(event.exchange, group); assembling.delete(event.exchange); }
        break;
      }
      case 'quotes':
        for (const [index, quote] of event.quotes.entries()) {
          const key = `${quote.exchange}:${quote.symbol}`;
          const times = event.bookTimes[index];
          if (times) bookTimes.set(key, times); else bookTimes.delete(key);
          quotes.set(key, quote); if (clients.size) publishDirty.add(key);
        }
        for (const key of event.removed) { quotes.delete(key); bookTimes.delete(key); if (clients.size) publishDirty.add(key); }
        break;
      case 'venues':
        feedHealth = event.health;
        for (const venue of event.venues) {
          const previous = states.get(venue.id);
          if (previous && (previous.online !== venue.online || previous.error !== venue.error)) {
            healthEvents.unshift({ id: ++healthEventId, exchange: venue.id, at: clock(), reason: venue.error ?? (venue.online ? '连接已建立' : '连接已关闭') });
          }
        }
        healthEvents.length = Math.min(60, healthEvents.length);
        states = new Map(event.venues.map(state => [state.id, state])); connectionCount = event.connections;
        break;
    }
  }
  function disconnected(): void {
    feedHealth = undefined; feedEpoch = null; booksAfter = clock(); connectionCount = 0; assembling.clear();
    resetFx(); crossEx.resetSource();
    for (const [id, state] of states) states.set(id, { ...state, online: false, error: '行情服务连接中断，等待重新订阅。' });
  }
  let running = false, sequence = 0, streamId = randomUUID();
  // A new one per start: stop() aborts its controller for good (the workbench's service is never restarted).
  let execution: Pick<PerpetualExecutionService, 'fx' | 'depth' | 'exit' | 'stop'> | null = null;
  function resetFx() { fxGeneration++; fxSnapshot = null; fxRequest = null; }
  function readFx(): Promise<PerpetualFxSnapshot> {
    if (fxRequest) return fxRequest;
    const generation = fxGeneration, epoch = remote?.epoch();
    const request = inspect(service => service.fx()).then(data => {
      if (generation !== fxGeneration || epoch !== remote?.epoch()) throw new PerpetualInspectionError(503, '行情服务连接已更新');
      fxSnapshot = data;
      return data;
    }).finally(() => { if (fxRequest === request) fxRequest = null; });
    fxRequest = request;
    return request;
  }
  function refreshFx() { if (execution && (!remote || feedEpoch)) void readFx().catch(() => undefined); }
  function opportunities(version: 1): PerpetualOpportunities;
  function opportunities(version: 2): PerpetualOpportunitiesV2;
  function opportunities(version: 1 | 2): PerpetualOpportunities | PerpetualOpportunitiesV2;
  function opportunities(version: 1 | 2) {
    const filter = crossEx.filter(), current = snapshot(), error = crossEx.storageError();
    const sourceDown = remote && (!feedEpoch || feedEpoch !== remote.epoch());
    if (error || sourceDown) { current.status = 'unavailable'; current.storageError = error || '行情服务连接中断'; current.quotes = []; }
    // Keep contracts and marks for existing positions. Only the source times of two still-connected book sides can
    // qualify an entry: the display feed also admits local receipt times and may retain a lost socket's last book.
    current.quotes = current.quotes.map(quote => {
      const times = bookTimes.get(`${quote.exchange}:${quote.symbol}`);
      const at = times && times[0] > booksAfter && times[1] <= current.generatedAt + 1_000 ? times[0] : undefined;
      return quote.bidAskAt === at ? quote : { ...quote, bidAskAt: at };
    });
    const directory = (exchange: string, symbol: string) => {
      const market = getMarket(exchange, symbol);
      return market && quotes.get(`${exchange}:${symbol}`)?.historyIdentity === perpetualPriceIdentity(market) ? market : undefined;
    };
    return version === 2 ? readV2(current, current.generatedAt, directory, sourceDown ? null : fxSnapshot, sourceRevision, filter)
      : createPerpetualOpportunities(current, current.generatedAt, directory, filter);
  }
  async function inspect<T>(read: (service: NonNullable<typeof execution>) => Promise<T>): Promise<T> {
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
    getSnapshot: () => ({ quotes: [...quotes.values()] }), getMarket,
    store: cache, clock, reader: remote?.metrics ?? createPerpetualMetricsReader({ clock, ...(metricsFetch ? { fetchImpl: metricsFetch } : {}) }),
    ...(metricsOptions?.intervalMs ? { intervalMs: metricsOptions.intervalMs } : {}),
  });
  const fundingFetch = fundingOptions?.fetchImpl ?? fetchImpl;
  const fundingHistory = createPerpetualFundingHistoryService({
    getSnapshot: () => ({ quotes: [...quotes.values()] }), getMarket,
    getQuote: (exchange, symbol) => quotes.get(`${exchange}:${symbol}`),
    store: cache, clock, reader: remote?.funding ?? createPerpetualFundingReader({ clock, requestSpacingMs: 350, ...(fundingFetch ? { fetchImpl: fundingFetch } : {}) }),
  });
  const priceFetch = priceOptions?.fetchImpl ?? fetchImpl;
  const priceHistory = createPerpetualPriceHistoryService({
    getSnapshot: () => ({ quotes: [...quotes.values()] }), getMarket,
    store: cache, clock, reader: remote?.price ?? createPerpetualPriceReader({ clock, requestSpacingMs: 350, ...(priceFetch ? { fetchImpl: priceFetch } : {}) }),
  });
  const scannerData = createPerpetualScannerDataService({
    getSnapshot: () => ({ quotes: [...quotes.values()] }), getMarket,
    marketMetrics, fundingHistory, clock,
  });
  // M-5d2: the workbench's service; its snapshot is this collector's (status, staleAfterMs, venue statuses and quotes). The
  // workbench defers the fundamentals and ratio reads while its event loop p99 passes 80 ms or its CPU 160 %; this collector
  // measures neither, so they never defer.
  const qualityFetch = qualityOptions?.fetchImpl ?? fetchImpl;
  const quality = createPerpetualQualityService({
    getSnapshot: () => snapshot(), store: cache, clock, shouldDeferAuxiliary: () => false,
    fundamentals: remote?.fundamentals ?? qualityOptions?.fundamentals ?? createFundamentalsClient({
      clock, ...(qualityOptions?.coinIds ? { coinIds: qualityOptions.coinIds } : {}), ...(qualityOptions?.apiKey ? { apiKey: qualityOptions.apiKey } : {}), ...(qualityFetch ? { fetchImpl: qualityFetch } : {}),
    }),
    positioningFetch: remote?.positioning ?? qualityOptions?.positioningFetch ?? (qualityFetch ? (quote, options) => fetchPositioning(quote, { ...options, fetchImpl: qualityFetch }) : fetchPositioning),
  });
  // Both book sides must still belong to current, connected subscriptions. Display quotes may remain after one
  // contract's socket was lost while the venue's other sockets are still online.
  function liveBookQuote(key: string): PerpetualQuote | undefined {
    const quote = running ? quotes.get(key) : undefined, times = bookTimes.get(key);
    if (!quote || !times || quote.bid === null || quote.ask === null || times[0] <= booksAfter || times[1] > clock() + 1_000 || !venueLive(quote.exchange)) return;
    const market = getMarket(quote.exchange, quote.symbol);
    if (!market || !quote.historyIdentity || perpetualPriceIdentity(market) !== quote.historyIdentity) return;
    return quote.bidAskAt === times[0] ? quote : { ...quote, bidAskAt: times[0] };
  }
  const opportunityAlerts = createPerpetualAlertService({
    ...options.alerts, getQuote: liveBookQuote, isVenueLive: venueLive, clock,
    onImportError: message => log(`机会提醒导入：${message}`),
  });
  // M-5e1: as the workbench's (perpetual-service.mjs): a leg is valued only while its venue has a connection open.
  let paperHealthy = true;
  const paperService = () => createPerpetualPaperService({
    store: paperOptions?.store, unavailableReason: paperOptions?.unavailableReason ?? (paperOptions?.store ? '' : '本服务没有配置持仓记录存放'),
    getQuote: key => quotes.get(key), isVenueLive: venueLive, clock,
  });
  // M-5e2: replaced when a pending import is merged (adoptPaper); `adopting` is the merge in progress, awaited by page writes.
  let paper = paperService(), adopting: Promise<void> | null = null;
  /** Merges a pending import, if one waits: null when there is none (or no store that takes one). */
  function adoptPaper(): Promise<void> | null {
    if (adopting) return adopting;
    const store = paperOptions?.store;
    if (!store?.adoptPending || !store.pending?.()) return null;
    const work = (async () => {
      // Stopping drains the service's queued writes (a check or a page write in flight), so the merge reads the last save.
      await paper.stop().catch(() => undefined);
      let outcome: PerpetualPaperAdoption | null;
      try { outcome = await store.adoptPending!(clock()); } catch (error) { outcome = { deferred: reason(error) }; }
      // Built again on the store's records, merged or not; started only if the collector still runs.
      paper = paperService();
      if (running) paper.start();
      if (outcome) log(perpetualPaperAdoptionLine(outcome));
    })();
    adopting = work.finally(() => { adopting = null; });
    return adopting;
  }
  let metricsStopping: Promise<void> = Promise.resolve();
  // The cached reads (metrics, funding history, scanner data, price history, quality): 503 while stopped, the service's 400 for an invalid batch, any other failure 500; the cache's
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
  let broadcastTimer: ReturnType<typeof setInterval> | undefined;

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
      return { id: state.id, name: state.name, kind: state.kind, status, marketCount: state.marketCount, quoteCount: own.fresh, freshBookCount: own.freshBook, staleBookCount: own.staleBook, missingBookCount: own.missingBook, lastMessageAt: state.lastMessageAt, error: state.error };
    });
    const liveCount = exchangeViews.filter(exchange => exchange.status === 'live').length;
    return { schemaVersion: 1, monitorId: 'perpetual', streamId, sequence, status: liveCount === states.size && liveCount > 0 ? 'live' : liveCount ? 'partial' : quotes.size ? 'snapshot' : running ? 'connecting' : 'unavailable', generatedAt: now, staleAfterMs, exchanges: exchangeViews, quotes: values, storageError: null };
  }

  function broadcast(): void {
    if (!clients.size) return;
    const begun = performance.now(); visitedQuotes = publishDirty.size;
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
    lastPublishMs = performance.now() - begun;
    if (!clients.size) { publishedQuotes.clear(); publishDirty.clear(); }
  }

  function closeStreams(): void { for (const client of clients.values()) client.output.end(); clients.clear(); publishedQuotes.clear(); publishDirty.clear(); }

  return {
    running: (): boolean => running,
    /**
     * O7 (docs/oil.md section 12): one contract's committed best bid and ask with their time (the earlier of the venue's bid and
     * ask times), for the oil and hynix book readers; null while stopped or without a book. Read only.
     */
    book(exchange: string, symbol: string): { bid: number; ask: number; at: number; multiplier: number } | null {
      const quote = liveBookQuote(`${exchange}:${symbol}`);
      return quote ? { bid: quote.bid!, ask: quote.ask!, at: quote.bidAskAt!, multiplier: quote.multiplier ?? 1 } : null;
    },
    /** Starts discovery and the connections; idempotent. */
    start(): void {
      if (running) return;
      running = true;
      const generation = ++feedRun;
      const subscribe = remote?.subscribe ?? feed!.subscribe;
      unsubscribe = subscribe(event => { if (running && generation === feedRun) receive(event); }, () => { if (running && generation === feedRun) disconnected(); });
      execution = remote?.execution((exchange, symbol) => quotes.get(`${exchange}:${symbol}`)) ?? createPerpetualExecutionService({
        getQuote: (exchange, symbol) => quotes.get(`${exchange}:${symbol}`), getMarket,
        clock, ...(fetchImpl ? { fetchImpl } : {}), ...executionOptions,
      });
      marketMetrics.start(); fundingHistory.start(); priceHistory.start(); quality.start();
      crossEx.start();
      if (fxRefreshMs > 0) { refreshFx(); fxTimer = setInterval(refreshFx, fxRefreshMs); fxTimer.unref(); }
      // A pending import is merged before the paper service starts (the merge starts the rebuilt one); a merge still running
      // from an earlier start starts it too.
      if (!adoptPaper()) paper.start();
      opportunityAlerts.start();
      // The workbench checks the paper positions on its broadcast timer too; the service observes at most once a minute.
      broadcastTimer = setInterval(() => {
        crossEx.checkImport();
        void opportunityAlerts.check().catch(() => undefined);
        // A failed save keeps the broadcast going; the log gets one line when saving starts or stops failing (the page shows it too).
        // A pending import is merged first, in the same chain, so it never runs beside a check.
        void (adoptPaper() ?? Promise.resolve()).then(() => paper.check()).catch(() => undefined).then(() => {
          const healthy = paper.healthy();
          if (healthy === paperHealthy) return;
          paperHealthy = healthy;
          log(healthy ? `合约价差：持仓记录已恢复保存` : `合约价差：持仓记录保存失败（${PERPETUAL_PAPER_FILE}），保留最后成功保存的状态，恢复前不再记录`);
        });
        broadcast();
      }, broadcastIntervalMs);
      broadcastTimer.unref?.();
    },
    /**
     * Stops everything (the switch turned off, or the service stopping): the readers' streams end, the connections close, and
     * the quotes are dropped — a later start begins with a new stream id and an empty table rather than hours-old prices.
     */
    stop(): void {
      if (!running) return;
      running = false; closeStreams();
      clearInterval(fxTimer); resetFx(); sourceRevision++;
      execution?.stop(); execution = null;
      // A merge in progress is waited for, then the service it built is stopped (unless the collector was started again).
      const paperStopping = adopting ? adopting.then(() => (running ? undefined : paper.stop())) : paper.stop();
      metricsStopping = Promise.all([marketMetrics.stop(), fundingHistory.stop(), priceHistory.stop(), quality.stop(), opportunityAlerts.stop(), paperStopping, crossEx.stop()].map(stopping => stopping.catch(() => undefined))).then(() => undefined);
      feedRun++; unsubscribe?.(); unsubscribe = undefined; clearInterval(broadcastTimer);
      quotes.clear(); bookTimes.clear(); catalogs.clear(); assembling.clear(); connectionCount = 0; booksAfter = -Infinity;
      states = fresh(); feedHealth = undefined; lastPublishMs = null; visitedQuotes = null; healthEvents.length = 0; sequence = 0; streamId = randomUUID();
    },
    snapshot,
    opportunities,
    // The in-process CrossEx consumer evaluates each funding pair independently of the top price signals.
    fundingTransferFilter: () => running && (!remote || feedEpoch) && !crossEx.storageError() ? crossEx.filter() : null,
    crossExSettings: crossEx.view,
    async updateCrossExSettings(input: unknown) {
      try { return await crossEx.update(input); }
      catch (error) { throw new PerpetualInspectionError((error as { status?: number }).status ?? 400, reason(error)); }
    },
    alerts: opportunityAlerts.view,
    async alertsUpdate(input: unknown) {
      if (!running) throw new PerpetualInspectionError(503, '合约价差采集未运行');
      return opportunityAlerts.update(input);
    },
    async alertsReview(input: unknown) {
      if (!running) throw new PerpetualInspectionError(503, '合约价差采集未运行');
      return opportunityAlerts.review(input);
    },
    /** The overview counts visible bases while the quote and venue health counts cover the whole feed. */
    summary(): PerpetualSummary {
      const now = clock(), live = connected(), freshVenues = new Set<string>(), onlineVenues = new Set<string>(), bases = new Set<string>();
      const blocked = new Set(crossEx.filter().blockedBases);
      let freshCount = 0, quoteUpdatedAt: number | null = null;
      for (const quote of quotes.values()) {
        const at = quote.bidAskAt;
        if (!isBaseBlocked(blocked, quote.base)) bases.add(quote.base);
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
    diagnostics() {
      const view = snapshot();
      const health = feedHealth && view.generatedAt - feedHealth.sampledAt <= 15_000 ? feedHealth : undefined;
      return { generatedAt: view.generatedAt,
        collection: { observationIntervalMs: options.observationIntervalMs ?? STREAM_OBSERVATION_MS, discoveryIntervalMs: options.discoveryIntervalMs ?? MARKET_CATALOG_MS,
          marketMetricsIntervalMs: metricsOptions?.intervalMs ?? MARKET_METRICS_POLL_MS, auxiliaryBookIntervalMs: AUXILIARY_BOOK_POLL_MS },
        cpuPercent: health?.cpuPercent ?? null, rssMb: health?.rssMb ?? null,
        eventLoopP99Ms: health?.eventLoopP99Ms ?? null, messagesPerSecond: health?.messagesPerSecond ?? null,
        lastPublishMs, lastPatchVisitedQuotes: visitedQuotes, quotes: quotes.size, clients: clients.size, connections: connectionCount, storageError: cacheUnavailable ?? null,
        events: healthEvents.filter(event => view.generatedAt - event.at <= 3_600_000),
        venues: view.exchanges.map(venue => {
          const state = states.get(venue.id)!;
          return { ...venue, sourceLagMs: state.sourceLagMs ?? null, sourceLagObservedAt: state.sourceLagObservedAt ?? null,
            rejectedFuture: state.rejectedFuture ?? 0, reconnects: state.reconnects, lastProtocolError: state.lastProtocolError };
        }) };
    },
    status(): PerpetualStatusView {
      const views = new Map(snapshot().exchanges.map(exchange => [exchange.id, exchange]));
      return {
        running, quotes: quotes.size, clients: clients.size, connections: connectionCount,
        venues: [...states.values()].map(state => ({ id: state.id, status: views.get(state.id)!.status, marketCount: state.marketCount, reconnects: state.reconnects, lastMessageAt: state.lastMessageAt, error: state.error, lastProtocolError: state.lastProtocolError })),
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
    fx: readFx,
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
    async priceHistory<I>(input: I): Promise<PriceHistoryReply<I>> {
      return cachedRead('合约价差采集未运行，开启后再读取成交价历史', () => priceHistory.read(input));
    },
    /**
     * M-5d2: the quality evidence of up to 30 current pairs (the workbench's quality action): spread and funding stability, quote
     * convergence, fundamentals and long/short ratios from what the service has collected; marks the pairs watched for 3 minutes.
     * 503 while stopped, 400 for an invalid batch, any other failure 500.
     */
    async quality(input: unknown): Promise<PerpetualQualityReport & { storageError?: string }> {
      return cachedRead<PerpetualQualityReport & { storageError?: string }>('合约价差采集未运行，开启后再读取质量资料', () => {
        try { return quality.read(input); }
        catch (error) { throw error instanceof Error && QUALITY_INPUT_ERRORS.has(error.message) ? Object.assign(error, { status: 400 }) : error; }
      });
    },
    /**
     * M-5e1: the paper positions (the workbench's paper GET): the records, each active one with its estimate from the current
     * books. Readable while stopped (`running: false`, every estimate invalid); `available: false` with the reason without a store.
     */
    paperView: (): PerpetualPaperView => paper.view(),
    /**
     * M-5e1: create / update / close / delete a paper position at the view's revision (the workbench's paper POST); answers the
     * new view. 503 while stopped; the service's refusals keep their `status` (400, 404, 409, 503), the exit calculator's plain
     * input errors have none (the route answers them 400, as the workbench does).
     */
    async paperUpdate(input: unknown): Promise<PerpetualPaperView> {
      if (!running) throw new PerpetualInspectionError(503, '合约价差采集未运行，开启后再登记或修改持仓');
      // M-5e2: a write during a merge waits for it and goes to the rebuilt service (which holds the merged records).
      if (adopting) {
        await adopting;
        if (!running) throw new PerpetualInspectionError(503, '合约价差采集未运行，开启后再登记或修改持仓');
      }
      return paper.update(input);
    },
    /** M-5b1/M-5e1: resolves once the last stop has written the metrics, histories and paper positions back (the cache file may close then). */
    settled: (): Promise<void> => metricsStopping,
  };
}
export type PerpetualMonitor = ReturnType<typeof createPerpetualMonitor>;
