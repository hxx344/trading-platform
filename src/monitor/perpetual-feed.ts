// Shared venue collector. One owner runs the catalog, WS generations, REST supplements and source-time merge.
// Subscribers receive a baseline and bounded incremental batches. Receipt in another process never timestamps a book.
import { EXCHANGES, createSubscriptions, discoverMarkets, getControlResponse, parseMessage, type PerpetualRequestOptions, type PerpetualSpec, type PerpetualVenue } from '../vendor/perpetual-exchanges.mjs';
import { MAX_FUTURE_MS, mergePerpetualQuote, withMarketMetadata, type PerpetualExchange, type PerpetualMarket, type PerpetualQuote, type PerpetualUpdate } from '../vendor/perpetual-stream.mjs';

export const PERPETUAL_DISCOVERY_MS = 300_000;
export const PERPETUAL_OBSERVATION_MS = 1_000;
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

interface VenueState {
  id: string; name: string; kind: PerpetualExchange['kind']; marketCount: number; lastMessageAt: number | null; error: string | null; snapshotError: string | null;
  discovering: boolean; retryPending: boolean; discoveryFailing: boolean; markets?: Map<string, PerpetualMarket>; signature?: string; generation: number; reconnects: number; lastProtocolError: string | null;
}
interface BookSide { connection: Connection; at: number; source: number | null }
interface Connection { exchange: string; socket: SocketLike | null; timers: Set<ReturnType<typeof setTimeout>>; closed: boolean; lastMessageAt: number; lastQuoteAt: number; snapshotController?: AbortController; dispose(): void }
interface PollBudget { startedAt: number; sent: number; nextAt: number; blockedUntil: number; failures: number }
type GenerationSpec = PerpetualSpec & { generation: number };

export interface PerpetualFeedOptions {
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
}

export interface FeedVenue {
  id: string; name: string; kind: PerpetualExchange['kind']; marketCount: number; lastMessageAt: number | null;
  error: string | null; reconnects: number; lastProtocolError: string | null; online: boolean;
}
export type FeedEvent =
  | { type: 'reset' }
  | { type: 'catalog'; exchange: string; first: boolean; last: boolean; markets: PerpetualMarket[] }
  | { type: 'quotes'; quotes: PerpetualQuote[]; removed: string[]; bookTimes: ([number, number] | null)[] }
  | { type: 'venues'; venues: FeedVenue[]; connections: number };
export type SubscribeFeed = (receive: (event: FeedEvent) => void, down: () => void) => () => void;

const BATCH_SIZE = 256;
const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);

export function createPerpetualFeed({
  exchanges = EXCHANGES, discover = discoverMarkets, subscriptions = createSubscriptions, parse = parseMessage, control = getControlResponse,
  fetchImpl, WebSocketImpl = globalThis.WebSocket as unknown as PerpetualSocketFactory, now: clock = Date.now, log = line => process.stderr.write(`${line}\n`),
  retryMs = 5_000, discoveryIntervalMs = PERPETUAL_DISCOVERY_MS, observationIntervalMs = PERPETUAL_OBSERVATION_MS,
  watchdogIntervalMs = 10_000, quoteTimeoutMs = 45_000,
}: PerpetualFeedOptions = {}) {
  const quotes = new Map<string, PerpetualQuote>(), pendingQuotes = new Map<string, PerpetualQuote>();
  const dirty = new Set<string>(), listeners = new Set<(event: FeedEvent) => void>();
  const sides = new Map<string, { bid?: BookSide; ask?: BookSide }>();
  const connections = new Set<Connection>(), timers = new Set<ReturnType<typeof setTimeout>>(), pollBudgets = new Map<string, PollBudget>();
  const discoveries = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  const fresh = (): Map<string, VenueState> => new Map(exchanges.map(exchange => [exchange.id, { id: exchange.id, name: exchange.name, kind: exchange.kind, marketCount: 0, lastMessageAt: null, error: null, snapshotError: null, discovering: false, retryPending: false, discoveryFailing: false, generation: 0, reconnects: 0, lastProtocolError: null }]));
  let states = fresh();
  let running = false;
  let observationTimer: ReturnType<typeof setInterval> | undefined, refreshTimer: ReturnType<typeof setInterval> | undefined;

  function publish(event: FeedEvent): void { for (const listener of listeners) listener(event); }
  function publishVenues(emit: (event: FeedEvent) => void = publish): void {
    const online = new Set([...connections].filter(connection => connection.socket?.readyState === 1).map(connection => connection.exchange));
    emit({ type: 'venues', connections: connections.size, venues: [...states.values()].map(state => ({
      id: state.id, name: state.name, kind: state.kind, marketCount: state.marketCount, lastMessageAt: state.lastMessageAt,
      error: state.error || state.snapshotError || null, reconnects: state.reconnects, lastProtocolError: state.lastProtocolError, online: online.has(state.id),
    })) });
  }
  function publishMarkets(exchange: string, values: PerpetualMarket[], emit: (event: FeedEvent) => void): void {
    for (let index = 0; index < values.length; index += BATCH_SIZE) {
      emit({ type: 'catalog', exchange, first: index === 0, last: index + BATCH_SIZE >= values.length, markets: values.slice(index, index + BATCH_SIZE) });
    }
  }
  function publishQuotes(keys: Iterable<string>, emit: (event: FeedEvent) => void): void {
    let updated: PerpetualQuote[] = [], removed: string[] = [], bookTimes: ([number, number] | null)[] = [];
    for (const key of keys) {
      const quote = quotes.get(key);
      if (quote) {
        updated.push(quote);
        const owner = sides.get(key);
        const bid = owner?.bid, ask = owner?.ask;
        // Display timestamps may use local receipt for sources without a clock. Only original exchange times qualify for execution.
        bookTimes.push(bid && ask && bid.connection.socket?.readyState === 1 && ask.connection.socket?.readyState === 1 && !bid.connection.closed && !ask.connection.closed && bid.at === quote.bidAt && ask.at === quote.askAt && bid.source !== null && ask.source !== null
          ? [Math.min(bid.source, ask.source), Math.max(bid.source, ask.source)] : null);
      } else removed.push(key);
      if (updated.length + removed.length === BATCH_SIZE) { emit({ type: 'quotes', quotes: updated, removed, bookTimes }); updated = []; removed = []; bookTimes = []; }
    }
    if (updated.length || removed.length) emit({ type: 'quotes', quotes: updated, removed, bookTimes });
  }
  const venue = (exchange: string): VenueState => states.get(exchange)!;
  function changedQuote(key: string, quote: PerpetualQuote): void { quotes.set(key, quote); dirty.add(key); }
  function observe(): void {
    // Directory metadata may change after receipt but before this commit.
    for (const [key, quote] of pendingQuotes) changedQuote(key, withMarketMetadata(quote, states.get(quote.exchange)?.markets?.get(quote.symbol)));
    pendingQuotes.clear();
    publishQuotes(dirty, publish); dirty.clear();
    publishVenues();
  }
  const later = (fn: () => void, ms: number): ReturnType<typeof setTimeout> => {
    const timer = setTimeout(() => { timers.delete(timer); if (running) fn(); }, ms);
    timer.unref?.(); timers.add(timer); return timer;
  };
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
    connection.dispose = () => {
      connection.closed = true; clear(); connection.snapshotController?.abort();
      try { connection.socket?.close(); } catch { /* already closed */ }
      if (!running) return;
      const lost = [];
      for (const [key, owner] of sides) {
        if (owner.bid?.connection !== connection && owner.ask?.connection !== connection) continue;
        if (owner.bid?.connection === connection) delete owner.bid;
        if (owner.ask?.connection === connection) delete owner.ask;
        if (!owner.bid && !owner.ask) sides.delete(key);
        lost.push(key);
      }
      publishQuotes(lost, publish);
    };
    const fail = (message: string) => {
      if (connection.closed) return;
      state.error = message; state.reconnects++; connection.dispose(); publishVenues();
      if (running) later(() => connect(exchange, spec, attempt + 1), Math.min(60_000, retryMs * 2 ** Math.min(attempt, 4)) + Math.floor(Math.random() * retryMs / 4));
    };
    const acceptUpdates = (updates: PerpetualUpdate[], now: number, transport: 'ws' | 'rest' = 'ws') => {
      for (const update of updates) {
        if (update.exchange !== exchange) continue;
        if (Number.isFinite(update.sourceTime) && now - update.sourceTime! < -MAX_FUTURE_MS) state.error = '行情时间领先服务器，请检查服务器时钟。';
        const key = `${exchange}:${update.symbol}`, previous = pendingQuotes.get(key) ?? quotes.get(key);
        const next = mergePerpetualQuote(previous, transport === 'rest' ? { ...update, transport } : update, now);
        if (next && next !== previous) {
          const source = Number.isSafeInteger(update.sourceTime) && update.sourceTime! > 0 ? update.sourceTime! : null;
          const stamped = source === null ? now : Math.min(now, source);
          const owner = sides.get(key) ?? {};
          if (update.bid != null && update.bid === next.bid && next.bidAt === stamped) owner.bid = { connection, at: stamped, source };
          if (update.ask != null && update.ask === next.ask && next.askAt === stamped) owner.ask = { connection, at: stamped, source };
          if (owner.bid || owner.ask) sides.set(key, owner);
          pendingQuotes.set(key, withMarketMetadata(next, state.markets?.get(update.symbol)));
          if (transport === 'ws') connection.lastQuoteAt = now;
          state.lastMessageAt = now; state.error = null; attempt = 0;
          if (observationIntervalMs <= 0) observe();
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
      connections.add(connection); publishVenues();
      scheduleTask(() => { if (socket.readyState !== 1) fail('WebSocket 连接超时，正在重连。'); }, CONNECT_TIMEOUT_MS);
      socket.addEventListener('open', () => {
        if (connection.closed || !running) return connection.dispose();
        publishVenues();
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
        publishMarkets(exchange, markets, publish);
        for (const [key, quote] of quotes) {
          if (quote.exchange !== exchange || !identities.has(quote.symbol)) continue;
          const current = withMarketMetadata(quote, identities.get(quote.symbol));
          if (current !== quote) changedQuote(key, current);
        }
        if (signature === state.signature) { if (observationIntervalMs <= 0) observe(); return; }
        // A retired subscription generation must not publish a buffered quote of an old contract.
        for (const [key, quote] of pendingQuotes) if (quote.exchange === exchange) pendingQuotes.delete(key);
        for (const [key, quote] of quotes) {
          if (quote.exchange !== exchange) continue;
          const market = identities.get(quote.symbol);
          if (!market || quote.base !== market.base || quote.quoteCurrency !== market.quoteCurrency || (quote.multiplier ?? 1) !== (market.multiplier ?? 1)
            || (market.contractUnit && market.contractUnit !== quote.contractUnit) || (market.comparable === false && quote.comparable !== false)) {
            quotes.delete(key); sides.delete(key); dirty.add(key);
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
      } finally { if (running && states === owner) { if (observationIntervalMs <= 0) observe(); else publishVenues(); } state.discovering = false; if (discoveries.get(exchange)?.controller === controller) discoveries.delete(exchange); }
    })();
    discoveries.set(exchange, { controller, promise });
    await promise;
  }

  function stop(): void {
    running = false;
    clearInterval(observationTimer); clearInterval(refreshTimer);
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const item of discoveries.values()) item.controller.abort();
    discoveries.clear();
    for (const connection of [...connections]) connection.dispose();
    quotes.clear(); pendingQuotes.clear(); dirty.clear(); sides.clear(); pollBudgets.clear();
    states = fresh();
  }
  return {
    online: (exchange: string) => [...connections].some(item => item.exchange === exchange && item.socket?.readyState === 1),
    quote: (exchange: string, symbol: string) => quotes.get(`${exchange}:${symbol}`),
    market: (exchange: string, symbol: string) => states.get(exchange)?.markets?.get(symbol),
    /** The last subscription leaving stops the venue sockets. A replacement service can reconnect to the same owner. */
    subscribe(emit: (event: FeedEvent) => void): () => void {
      listeners.add(emit);
      emit({ type: 'reset' });
      for (const state of states.values()) if (state.markets) publishMarkets(state.id, [...state.markets.values()], emit);
      publishQuotes(quotes.keys(), emit);
      publishVenues(emit);
      if (!running) {
        running = true;
        if (observationIntervalMs > 0) { observationTimer = setInterval(observe, observationIntervalMs); observationTimer.unref?.(); }
        for (const id of states.keys()) void refresh(id);
        refreshTimer = setInterval(() => { for (const id of states.keys()) void refresh(id); }, discoveryIntervalMs);
        refreshTimer.unref?.();
      }
      return () => { if (listeners.delete(emit) && !listeners.size) stop(); };
    },
    close(): void { listeners.clear(); stop(); },
  };
}
