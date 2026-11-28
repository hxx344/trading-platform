// DEX 价差子模块「Binance 领先测速」按需单标的低延迟 WebSocket 流与会话控制器（R2）：
// - Binance：<lowercase>@bookTicker 实时一档推送（非 5 秒聚合 !bookTicker），LIST_SUBSCRIPTIONS 定期保活；
// - Lighter 主网 / RH：order_book/{marketId} 增量盘口，O(1) 维护最优买卖价（不用滞后较大的 market_stats/all）；
// - Entropy：bbo 实时一档，连上立刻发一次 post l2Book 拉取初始一档。
// 全部流仅在测速运行期按需打开，停止或到期即刻断开清理；组合超时信号统一走 src/any-signal.mjs（L206）。
import { anySignal } from '../any-signal.mjs';
import {
  BOOK_KEEP_LEVELS,
  BOOK_SYNC_TIMEOUT_MS,
  CONNECT_TIMEOUT_MS,
  ENTROPY_ENDPOINTS,
  LIGHTER_ENDPOINTS,
  parseL2Levels,
  readJson,
  type Connect,
  type FetchLike,
  type SocketLike,
} from './feeds.ts';
import {
  LEAD_HISTORY_MAX,
  LEAD_VENUE_NAMES,
  LEAD_VENUES,
  LeadError,
  LeadTracker,
  buildLeadCandidates,
  parseBinanceExchangeInfo,
  readLeadConfig,
  type BinanceContract,
} from './lead.ts';
import type { MarketSpec, Venue } from './model.ts';
import type { VarLighterStore } from './store.ts';
import type { LeadCatalogEntry, LeadHistoryItem, LeadSessionView, LeadSource, LeadVenue, LeadView } from './views.ts';

export const BINANCE_FAPI_EXCHANGE_INFO = 'https://fapi.binance.com/fapi/v1/exchangeInfo';
export const BINANCE_FSTREAM_WS = 'wss://fstream.binance.com/public/ws';
export const LEAD_HISTORY_KEY = 'lead_history';
const CATALOG_TTL_MS = 10 * 60_000;
const CATALOG_RETRY_MS = 30_000;
export const CATALOG_TIMEOUT_MS = 7_500; // 必须严格小于 DEX IPC 读超时（DEX_READ_TIMEOUT_MS=10s）
const CATALOG_MAX_BYTES = 8_000_000;

const BINANCE_KEEPALIVE_MS = 45_000;
const BINANCE_SILENCE_MS = 90_000;
const LIGHTER_PING_MS = 25_000;
const LIGHTER_SILENCE_MS = 60_000;
const ENTROPY_PING_MS = 15_000;
export const ENTROPY_CONFIRM_MS = 45_000;
const ENTROPY_SILENCE_MS = 45_000;
const BOOK_RESYNC_MIN_MS = 5_000;
const BOOK_RESYNC_MAX_MS = 60_000;
const BOOK_TRIM_SLACK = 1_000;
const BOOK_MESSAGE_LEVELS = 100_000;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const decimal = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.length > 40 || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const safeTime = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  return null;
};

const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 200);

interface LeadStreamCallbacks {
  onStatus: (connected: boolean, error: string | null, reconnects: number) => void;
  onTick: (bid: number, ask: number, exchangeMs: number | null) => void;
  onHeartbeat?: () => void;
}

interface LeadSocketClient {
  start(): void;
  close(): void;
}

/** 公共重连与生命周期底座，避免三个场所重复定时器与 socket 状态管理。 */
abstract class BaseLeadStream implements LeadSocketClient {
  protected socket: SocketLike | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private attempt = 0;
  protected connected = false;
  protected reconnects = 0;
  protected lastMessageAt: number | null = null;
  private connectingAt: number | null = null;
  private lastBid: number | null = null;
  private lastAsk: number | null = null;

  private readonly url: string;
  private readonly connectFn: Connect;
  private readonly monoNowFn: () => number;
  private readonly silenceMs: number;
  private readonly cb: LeadStreamCallbacks;

  constructor(options: { url: string; connect: Connect; monoNow: () => number; silenceMs: number; callbacks: LeadStreamCallbacks }) {
    this.url = options.url;
    this.connectFn = options.connect;
    this.monoNowFn = options.monoNow;
    this.silenceMs = options.silenceMs;
    this.cb = options.callbacks;
  }

  protected mono(): number {
    return this.monoNowFn();
  }

  start(): void {
    if (this.socket || this.closed) return;
    let socket: SocketLike;
    try {
      socket = this.connectFn(this.url);
    } catch (error) {
      this.cb.onStatus(false, errorText(error), this.reconnects);
      this.schedule();
      return;
    }
    this.socket = socket;
    this.connectingAt = this.mono();
    socket.onopen = () => {
      if (this.socket !== socket || this.closed) return;
      this.connected = true;
      this.attempt = 0;
      this.lastMessageAt = this.mono();
      this.cb.onStatus(true, null, this.reconnects);
      this.onConnected();
    };
    socket.onmessage = event => {
      if (this.socket !== socket || this.closed) return;
      if (typeof event.data !== 'string') return;
      this.lastMessageAt = this.mono();
      try {
        const parsed = JSON.parse(event.data) as unknown;
        this.onMessage(parsed);
      } catch (error) {
        this.cb.onStatus(this.connected, errorText(error), this.reconnects);
      }
    };
    socket.onerror = event => {
      if (this.socket !== socket || this.closed) return;
      const msg = (isObject(event) && typeof event.message === 'string' ? event.message : null) ?? 'WebSocket 错误';
      this.cb.onStatus(this.connected, msg, this.reconnects);
    };
    socket.onclose = () => {
      if (this.socket === socket) this.drop('连接关闭');
    };
    this.timer = setInterval(() => this.onInterval(), 1_000);
    this.timer.unref?.();
  }

  close(): void {
    this.closed = true;
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    this.drop(null);
  }

  protected send(payload: unknown): void {
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(payload));
  }

  protected emitTop(bid: number | null, ask: number | null, exchangeMs: number | null, confirm = false): boolean {
    if (bid === null || ask === null || !(bid > 0 && ask >= bid)) return false;
    if (this.lastBid === bid && this.lastAsk === ask) {
      if (confirm) this.cb.onHeartbeat?.();
      return true;
    }
    this.lastBid = bid;
    this.lastAsk = ask;
    this.cb.onTick(bid, ask, exchangeMs);
    return true;
  }

  protected resetTopCache(): void {
    this.lastBid = null;
    this.lastAsk = null;
  }

  private onInterval(): void {
    if (this.closed) return;
    const m = this.mono();
    if (this.connected && this.lastMessageAt !== null && m - this.lastMessageAt > this.silenceMs) {
      this.drop('长时间没有消息');
      return;
    }
    if (!this.connected && this.socket && this.connectingAt !== null && m - this.connectingAt > CONNECT_TIMEOUT_MS) {
      this.drop('连接超时');
      return;
    }
    if (this.connected) this.onConnectedTick(m);
  }

  protected drop(reason: string | null): void {
    const socket = this.socket;
    this.socket = null;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.connected = false;
    this.connectingAt = null;
    this.resetTopCache();
    this.onDropped();
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      try { socket.close(); } catch { /* 已关闭 */ }
    }
    if (reason !== null) {
      this.reconnects++;
      this.cb.onStatus(false, reason, this.reconnects);
      if (!this.closed) this.schedule();
    }
  }

  private schedule(): void {
    if (this.retry || this.closed) return;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.attempt++, 5));
    this.retry = setTimeout(() => { this.retry = null; this.start(); }, delay);
    this.retry.unref?.();
  }

  protected abstract onConnected(): void;
  protected abstract onMessage(msg: unknown): void;
  protected abstract onConnectedTick(monoMs: number): void;
  protected onDropped(): void {}
}

/** Binance U 本位永续单标的 `<symbol>@bookTicker` 实时推送客户端。 */
export class BinanceBookTickerStream extends BaseLeadStream {
  private readonly symbol: string;
  private reqId = 0;
  private lastKeepalive = 0;

  constructor(options: { symbol: string; url?: string; connect: Connect; monoNow: () => number; callbacks: LeadStreamCallbacks }) {
    super({ url: options.url ?? BINANCE_FSTREAM_WS, connect: options.connect, monoNow: options.monoNow, silenceMs: BINANCE_SILENCE_MS, callbacks: options.callbacks });
    this.symbol = options.symbol.toUpperCase();
  }

  protected onConnected(): void {
    this.lastKeepalive = this.mono();
    this.send({ method: 'SUBSCRIBE', params: [`${this.symbol.toLowerCase()}@bookTicker`], id: ++this.reqId });
  }

  protected onConnectedTick(monoMs: number): void {
    if (monoMs - this.lastKeepalive >= BINANCE_KEEPALIVE_MS) {
      this.lastKeepalive = monoMs;
      this.send({ method: 'LIST_SUBSCRIPTIONS', id: ++this.reqId });
    }
  }

  protected onMessage(raw: unknown): void {
    if (!isObject(raw)) return;
    if (raw.error !== undefined) {
      const msg = isObject(raw.error) && typeof raw.error.msg === 'string' ? raw.error.msg : JSON.stringify(raw.error);
      throw new Error(msg.slice(0, 160));
    }
    const data = typeof raw.stream === 'string' && isObject(raw.data) ? raw.data : raw;
    if (data.e !== 'bookTicker') return;
    if (typeof data.s === 'string' && data.s.toUpperCase() !== this.symbol) return;
    const bid = decimal(data.b), ask = decimal(data.a);
    const exchangeMs = safeTime(data.T) ?? safeTime(data.E);
    this.emitTop(bid, ask, exchangeMs);
  }
}

function trimSide(levels: Map<number, number>, descending: boolean): number {
  const kept = [...levels].sort((a, b) => descending ? b[0] - a[0] : a[0] - b[0]).slice(0, BOOK_KEEP_LEVELS);
  levels.clear();
  for (const [price, size] of kept) levels.set(price, size);
  return kept.at(-1)![0];
}

/** Lighter（主网 / RH）单市场 `order_book/{marketId}` 实时最优买卖价流（O(1) 增量维护，仅删最优档时回扫）。 */
export class LighterOrderBookTopStream extends BaseLeadStream {
  private readonly marketId: number;
  private readonly bids = new Map<number, number>();
  private readonly asks = new Map<number, number>();
  private bestBid: number | null = null;
  private bestAsk: number | null = null;
  private bidFloor: number | null = null;
  private askCeil: number | null = null;
  private synced = false;
  private nonce: number | null = null;
  private askedAt = 0;
  private due: number | null = null;
  private retries = 0;
  private lastPing = 0;

  constructor(options: { venue: Venue; marketId: number; url?: string; connect: Connect; monoNow: () => number; callbacks: LeadStreamCallbacks }) {
    super({ url: options.url ?? LIGHTER_ENDPOINTS[options.venue].stream, connect: options.connect, monoNow: options.monoNow, silenceMs: LIGHTER_SILENCE_MS, callbacks: options.callbacks });
    this.marketId = options.marketId;
  }

  protected onConnected(): void {
    this.lastPing = this.mono();
    this.subscribeBook(0);
  }

  protected onDropped(): void {
    this.bids.clear();
    this.asks.clear();
    this.bestBid = this.bestAsk = null;
    this.bidFloor = this.askCeil = null;
    this.synced = false;
    this.nonce = null;
    this.due = null;
    this.retries = 0;
  }

  private subscribeBook(retries: number): void {
    this.bids.clear();
    this.asks.clear();
    this.bestBid = this.bestAsk = null;
    this.bidFloor = this.askCeil = null;
    this.synced = false;
    this.nonce = null;
    this.askedAt = this.mono();
    this.due = null;
    this.retries = retries;
    this.send({ type: 'subscribe', channel: `order_book/${this.marketId}` });
  }

  private resyncBook(): void {
    const m = this.mono();
    const wait = Math.min(BOOK_RESYNC_MIN_MS * 2 ** this.retries, BOOK_RESYNC_MAX_MS);
    if (m - this.askedAt < wait) {
      this.synced = false;
      this.bids.clear();
      this.asks.clear();
      this.bestBid = this.bestAsk = null;
      this.bidFloor = this.askCeil = null;
      this.nonce = null;
      this.due ??= this.askedAt + wait;
      return;
    }
    this.send({ type: 'unsubscribe', channel: `order_book/${this.marketId}` });
    this.subscribeBook(this.retries + 1);
  }

  protected onConnectedTick(monoMs: number): void {
    if (monoMs - this.lastPing >= LIGHTER_PING_MS) {
      this.lastPing = monoMs;
      this.send({ type: 'ping' });
    }
    if (this.due !== null && monoMs >= this.due) {
      this.resyncBook();
    } else if (this.due === null && !this.synced && monoMs - this.askedAt > BOOK_SYNC_TIMEOUT_MS) {
      this.resyncBook();
    }
  }

  protected onMessage(raw: unknown): void {
    const msg = isObject(raw) ? raw : null;
    if (!msg) return;
    const type = msg.type, channel = typeof msg.channel === 'string' ? msg.channel : '';
    if (type === 'ping') { this.send({ type: 'pong' }); return; }
    if (type === 'error' || isObject(msg.error)) throw new Error(JSON.stringify(msg).slice(0, 160));
    if ((type === 'subscribed/order_book' || type === 'update/order_book') && channel === `order_book:${this.marketId}`) {
      const value = isObject(msg.order_book) ? msg.order_book : null;
      if (!value) return;
      this.mergeBook(value, type === 'subscribed/order_book');
    }
  }

  private mergeBook(value: Record<string, unknown>, snapshot: boolean): void {
    if (snapshot) {
      if (value.code !== undefined && value.code !== 0) { this.resyncBook(); return; }
      this.bids.clear();
      this.asks.clear();
      this.bestBid = this.bestAsk = null;
      this.bidFloor = this.askCeil = null;
      this.synced = true;
      this.due = null;
      this.retries = 0;
    } else {
      if (!this.synced) return;
      if (Number.isSafeInteger(value.begin_nonce) && this.nonce !== null && value.begin_nonce !== this.nonce) {
        this.resyncBook();
        return;
      }
    }
    if ([value.bids, value.asks].some(rows => Array.isArray(rows) && rows.length > BOOK_MESSAGE_LEVELS)) {
      this.resyncBook();
      return;
    }

    const apply = (
      levels: Map<number, number>,
      rows: unknown,
      outside: (price: number) => boolean,
      best: number | null,
      better: (price: number, current: number) => boolean,
    ): { best: number | null; rescan: boolean } => {
      let rescan = false;
      if (!Array.isArray(rows)) return { best, rescan };
      for (const raw of rows) {
        const row = isObject(raw) ? raw : null;
        const price = decimal(row?.price), size = decimal(row?.size);
        if (price === null || size === null || price <= 0 || outside(price)) continue;
        if (size <= 0) {
          if (levels.delete(price) && price === best) rescan = true;
        } else {
          levels.set(price, size);
          if (best === null || better(price, best)) best = price;
        }
      }
      return { best, rescan };
    };
    const extreme = (levels: ReadonlyMap<number, number>, better: (price: number, current: number) => boolean): number | null => {
      let best: number | null = null;
      for (const price of levels.keys()) if (best === null || better(price, best)) best = price;
      return best;
    };
    const higher = (price: number, best: number) => price > best;
    const lower = (price: number, best: number) => price < best;

    const bids = apply(this.bids, value.bids, p => this.bidFloor !== null && p < this.bidFloor, this.bestBid, higher);
    const asks = apply(this.asks, value.asks, p => this.askCeil !== null && p > this.askCeil, this.bestAsk, lower);
    this.bestBid = bids.rescan ? extreme(this.bids, higher) : bids.best;
    this.bestAsk = asks.rescan ? extreme(this.asks, lower) : asks.best;
    this.nonce = Number.isSafeInteger(value.nonce) ? value.nonce as number : null;

    if (this.bids.size > BOOK_KEEP_LEVELS + BOOK_TRIM_SLACK) this.bidFloor = trimSide(this.bids, true);
    if (this.asks.size > BOOK_KEEP_LEVELS + BOOK_TRIM_SLACK) this.askCeil = trimSide(this.asks, false);
    if ((this.bidFloor !== null && this.bids.size < BOOK_KEEP_LEVELS / 2) || (this.askCeil !== null && this.asks.size < BOOK_KEEP_LEVELS / 2)) {
      this.resyncBook();
      return;
    }

    if (this.bestBid !== null && this.bestAsk !== null && this.bestBid > 0 && this.bestAsk >= this.bestBid) {
      this.emitTop(this.bestBid, this.bestAsk, safeTime(value.timestamp));
    }
  }
}

/** Entropy（Hyperliquid HIP-3 `io`）单市场 `bbo` 实时最优买卖价流。 */
export class EntropyBboStream extends BaseLeadStream {
  private readonly coin: string;
  private postId = 0;
  private lastPing = 0;
  private lastTopAt = 0;
  private lastConfirmSentAt = 0;

  constructor(options: { coin: string; url?: string; connect: Connect; monoNow: () => number; callbacks: LeadStreamCallbacks }) {
    super({ url: options.url ?? ENTROPY_ENDPOINTS.stream, connect: options.connect, monoNow: options.monoNow, silenceMs: ENTROPY_SILENCE_MS, callbacks: options.callbacks });
    this.coin = options.coin;
  }

  protected onConnected(): void {
    const m = this.mono();
    this.lastPing = m;
    this.lastTopAt = m;
    this.lastConfirmSentAt = m;
    this.send({ method: 'subscribe', subscription: { type: 'bbo', coin: this.coin } });
    // bbo 只在价格变化时推；连接伊始立刻发一次 l2Book 查询补初始一档。
    this.send({ method: 'post', id: ++this.postId, request: { type: 'info', payload: { type: 'l2Book', coin: this.coin } } });
  }

  protected onConnectedTick(monoMs: number): void {
    if (monoMs - this.lastPing >= ENTROPY_PING_MS) {
      this.lastPing = monoMs;
      this.send({ method: 'ping' });
    }
    if (monoMs - this.lastTopAt >= ENTROPY_CONFIRM_MS && monoMs - this.lastConfirmSentAt >= ENTROPY_CONFIRM_MS) {
      this.lastConfirmSentAt = monoMs;
      this.send({ method: 'post', id: ++this.postId, request: { type: 'info', payload: { type: 'l2Book', coin: this.coin } } });
    }
  }

  protected onMessage(raw: unknown): void {
    const msg = isObject(raw) ? raw : null;
    if (!msg) return;
    const channel = msg.channel, payload = isObject(msg.data) ? msg.data : null;
    if (channel === 'error') throw new Error(String(msg.data ?? 'Hyperliquid 错误').slice(0, 160));
    if (channel === 'bbo' && payload) {
      if (payload.coin !== this.coin || !Array.isArray(payload.bbo)) return;
      const bid = decimal((isObject(payload.bbo[0]) ? payload.bbo[0].px : null));
      const ask = decimal((isObject(payload.bbo[1]) ? payload.bbo[1].px : null));
      if (this.emitTop(bid, ask, safeTime(payload.time))) this.lastTopAt = this.mono();
      return;
    }
    if (channel === 'post' && payload) {
      const response = isObject(payload.response) ? payload.response : null;
      if (response?.type === 'error') return;
      const inner = isObject(response?.payload) ? response.payload : null;
      const book = isObject(inner?.data) ? inner.data : null;
      if (!book || book.coin !== this.coin) return;
      try {
        const levels = parseL2Levels(book);
        if (this.emitTop(levels.bids[0]?.[0] ?? null, levels.asks[0]?.[0] ?? null, safeTime(book.time), true)) {
          this.lastTopAt = this.mono();
        }
      } catch { /* 格式不对的回应跳过 */ }
    }
  }
}

export interface LeadTesterOptions {
  store: VarLighterStore;
  fetchImpl: FetchLike;
  connect: Connect;
  now: () => number;
  monoNow: () => number;
  log: (line: string) => void;
  dexMarkets: () => Record<LeadVenue, readonly MarketSpec[]>;
}

interface ActiveSession {
  id: string;
  tracker: LeadTracker;
  streams: LeadSocketClient[];
  timer: ReturnType<typeof setInterval>;
}

function toHistoryItem(view: LeadSessionView): LeadHistoryItem {
  return {
    id: view.id,
    status: view.status === 'completed' ? 'completed' : 'stopped',
    config: view.config,
    startedAt: view.startedAt,
    finishedAt: view.finishedAt ?? view.startedAt,
    elapsedMs: view.elapsedMs,
    eventCount: view.eventCount,
    venues: view.venues.map(v => ({
      venue: v.venue,
      name: v.name,
      symbol: v.symbol,
      followed: v.followed,
      unfollowed: v.unfollowed,
      followRate: v.followRate,
      bnLeadRate: v.bnLeadRate,
      medianMs: v.medianMs,
      meanMs: v.meanMs,
      p90Ms: v.p90Ms,
      peakLagMs: v.xcorr?.peakLagMs ?? null,
      peakCorr: v.xcorr?.peakCorr ?? null,
    })),
  };
}

/**
 * 领先测速会话控制器：按需拉取 Binance 永续目录、管理单活会话生命周期与历史记录。
 */
export function createLeadTester(options: LeadTesterOptions) {
  const { store, fetchImpl, connect, now, monoNow, log, dexMarkets } = options;
  const stopController = new AbortController();
  let seq = 0;

  let binanceContracts: BinanceContract[] = [];
  let catalogAt: number | null = null;
  let catalogOkAt: number | null = null;
  let catalogError: string | null = null;
  let catalogInflight: Promise<void> | null = null;

  let history: LeadHistoryItem[] = [];
  try {
    const saved = store.state<unknown>(LEAD_HISTORY_KEY);
    if (Array.isArray(saved)) {
      history = saved.filter((item): item is LeadHistoryItem =>
        isObject(item)
        && typeof item.id === 'string'
        && typeof item.startedAt === 'number'
        && typeof item.elapsedMs === 'number'
        && isObject(item.config)
        && typeof item.config.binanceSymbol === 'string'
        && Array.isArray(item.venues)
        && item.venues.every(isObject)).slice(0, LEAD_HISTORY_MAX);
    }
  } catch { /* 无效历史忽略 */ }

  let active: ActiveSession | null = null;
  let lastSession: LeadSessionView | null = null;

  function loadCatalog(force = false): Promise<void> {
    if (catalogInflight) return catalogInflight;
    const t = now();
    if (!force && catalogOkAt !== null && t - catalogOkAt < CATALOG_TTL_MS) return Promise.resolve();
    if (!force && catalogAt !== null && t - catalogAt < CATALOG_RETRY_MS) return Promise.resolve();

    catalogAt = t;
    const signal = anySignal([stopController.signal], CATALOG_TIMEOUT_MS);
    catalogInflight = (async () => {
      try {
        const raw = await readJson(fetchImpl, BINANCE_FAPI_EXCHANGE_INFO, signal, CATALOG_MAX_BYTES, {});
        binanceContracts = parseBinanceExchangeInfo(raw);
        catalogOkAt = now();
        catalogError = null;
      } catch (error) {
        catalogError = errorText(error);
      } finally {
        catalogInflight = null;
      }
    })();
    return catalogInflight;
  }

  function finish(reason: 'completed' | 'manual' | 'shutdown'): LeadSessionView | null {
    const session = active;
    if (!session) return null;
    active = null;
    clearInterval(session.timer);
    for (const s of session.streams) {
      try { s.close(); } catch { /* 忽略 */ }
    }
    const wall = now();
    const mono = monoNow();
    session.tracker.finalize(wall, mono, reason);
    const snapshot = session.tracker.view(wall, mono);
    lastSession = snapshot;

    history = [toHistoryItem(snapshot), ...history.filter(item => item.id !== snapshot.id)].slice(0, LEAD_HISTORY_MAX);
    try {
      store.setState(LEAD_HISTORY_KEY, history, wall);
    } catch (error) {
      log(`varlighter: 保存领先测速历史失败：${errorText(error)}`);
    }
    return snapshot;
  }

  function view(): LeadView {
    // 打开页签时触发按需目录加载（不阻塞本次 GET 返回）。
    void loadCatalog(false);
    const allDex = dexMarkets();
    const candidates = buildLeadCandidates(binanceContracts, allDex);
    const dexCatalogs = {
      lighter: (allDex.lighter ?? []).map((m): LeadCatalogEntry => ({ symbol: m.symbol, mark: m.mark })),
      rh: (allDex.rh ?? []).map((m): LeadCatalogEntry => ({ symbol: m.symbol, mark: m.mark })),
      entropy: (allDex.entropy ?? []).map((m): LeadCatalogEntry => ({ symbol: m.symbol, mark: m.mark })),
    };
    const activeView = active ? active.tracker.view(now(), monoNow()) : null;
    return {
      now: now(),
      catalog: {
        loading: catalogInflight !== null,
        at: catalogAt,
        ok: catalogOkAt,
        error: catalogError,
        count: binanceContracts.length,
        contracts: binanceContracts,
      },
      dexCatalogs,
      candidates,
      active: activeView,
      last: activeView ? null : lastSession,
      history,
    };
  }

  function start(body: unknown): LeadView {
    if (active) throw new LeadError(409, 'busy', '已有正在进行的领先测速，请先停止当前测试');
    const config = readLeadConfig(body);
    if (catalogOkAt !== null && !binanceContracts.some(c => c.symbol === config.binanceSymbol)) {
      throw new LeadError(400, 'unknown_binance_symbol', `Binance 目录中找不到合约 ${config.binanceSymbol}`);
    }

    const allDex = dexMarkets();
    const resolvedTargets: { venue: LeadVenue; market: MarketSpec }[] = [];
    for (const venue of LEAD_VENUES) {
      const sym = config.targets[venue];
      if (!sym) continue;
      const found = (allDex[venue] ?? []).find(m => m.symbol === sym || m.symbol.toUpperCase() === sym.toUpperCase());
      if (!found) {
        throw new LeadError(400, 'unknown_market', `${LEAD_VENUE_NAMES[venue]} 目录中找不到标的 ${sym}`);
      }
      config.targets[venue] = found.symbol;
      resolvedTargets.push({ venue, market: found });
    }

    const startedAt = now();
    const startMono = monoNow();
    const id = `lead-${startedAt.toString(36)}-${(++seq).toString(36)}`;
    const tracker = new LeadTracker(id, config, startedAt, startMono);

    const makeCb = (source: LeadSource): LeadStreamCallbacks => ({
      onStatus(connected, error, reconnects) {
        tracker.setConnected(source, connected, monoNow(), error, reconnects);
      },
      onTick(bid, ask, exchangeMs) {
        tracker.onTick(source, {
          monoMs: monoNow(),
          wallMs: now(),
          bid,
          ask,
          mid: (bid + ask) / 2,
          exchangeMs,
        });
      },
      onHeartbeat() {
        tracker.confirmAlive(source, monoNow(), now());
      },
    });

    const streams: LeadSocketClient[] = [
      new BinanceBookTickerStream({ symbol: config.binanceSymbol, connect, monoNow, callbacks: makeCb('binance') }),
    ];
    for (const { venue, market } of resolvedTargets) {
      if (venue === 'entropy') {
        streams.push(new EntropyBboStream({ coin: market.coin ?? `io:${market.symbol}`, connect, monoNow, callbacks: makeCb('entropy') }));
      } else {
        streams.push(new LighterOrderBookTopStream({ venue, marketId: market.id, connect, monoNow, callbacks: makeCb(venue) }));
      }
    }

    const timer = setInterval(() => {
      if (!active || active.id !== id) return;
      const mono = monoNow();
      active.tracker.tickTimeouts(mono);
      if (mono - active.tracker.startMono >= config.durationSec * 1_000) {
        finish('completed');
      }
    }, 1_000);
    timer.unref?.();

    active = { id, tracker, streams, timer };
    for (const s of streams) s.start();
    return view();
  }

  function stop(body: unknown): LeadView {
    const reqId = isObject(body) && typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    if (!reqId) throw new LeadError(400, 'invalid_body', '停止测试需要传入当前会话编号 sessionId');
    if (!active || active.id !== reqId) {
      throw new LeadError(409, 'session_mismatch', '当前测试会话已变化或已结束，请刷新页面核对');
    }
    finish('manual');
    return view();
  }

  function clearHistory(): LeadView {
    history = [];
    if (!active) lastSession = null;
    store.setState(LEAD_HISTORY_KEY, [], now());
    return view();
  }

  async function refreshCatalog(): Promise<LeadView> {
    await loadCatalog(true);
    return view();
  }

  function close(): void {
    stopController.abort();
    if (active) finish('shutdown');
  }

  return { view, start, stop, clearHistory, refreshCatalog, close };
}
