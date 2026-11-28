// DEX 价差子模块「Binance & 多参考源领先测速」低延迟 WebSocket 流、独立库写入协调与离线 Worker 调度（R2）：
// - 7 个免 Key 领先参考源（Binance 合约 / 现货 / 股票、Hyperliquid xyz、Coinbase 现货、OKX 永续、Bybit 永续）
// - 3 个 DEX 目标场所（Lighter 主网 / RH order_book 增量、Entropy bbo + l2Book）
// - 最多 3 个常驻标的，按 1s 批量事务写入 lead.sqlite、按 5m 小批清理超过 7 天的旧数据、按需派生只读 Worker 分析（<=7.5s 超时 < 10s IPC）。
import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
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
  LEAD_MAX_WATCHERS,
  LEAD_REF_NAMES,
  LEAD_REF_SOURCES,
  LEAD_RETENTION_DAYS,
  LEAD_SOURCE_NAMES,
  LEAD_VENUE_NAMES,
  LEAD_VENUES,
  LeadError,
  LeadTracker,
  buildLeadCandidates,
  parseBinanceExchangeInfo,
  parseBinanceSpotTickers,
  parseBybitLinearCatalog,
  parseCoinbaseSpotCatalog,
  parseHyperliquidXyzCatalog,
  parseOkxSwapCatalog,
  readLeadAnalyzeRequest,
  readLeadWatcherConfig,
  readLeadWatcherMutation,
  type PersistLeadEvent,
  type PersistLeadGrid,
} from './lead.ts';
import { openLeadStore, type LeadStore, type StoredWatcherRow } from './lead-store.ts';
import { analyzeLeadDatabase, type LeadAnalyzeJob } from './lead-worker.ts';
import type { MarketSpec, Venue } from './model.ts';
import type {
  LeadAnalyzeView,
  LeadCatalogEntry,
  LeadCatalogStatusView,
  LeadRefCatalogEntry,
  LeadRefSource,
  LeadSource,
  LeadStorageView,
  LeadVenue,
  LeadView,
  LeadWatcherConfig,
  LeadWatcherView,
} from './views.ts';

export const BINANCE_FAPI_EXCHANGE_INFO = 'https://fapi.binance.com/fapi/v1/exchangeInfo';
export const BINANCE_SPOT_BOOK_TICKERS = 'https://data-api.binance.vision/api/v3/ticker/bookTicker';
export const OKX_SWAP_INSTRUMENTS = 'https://www.okx.com/api/v5/public/instruments?instType=SWAP';
export const BYBIT_LINEAR_INSTRUMENTS = 'https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000';
export const COINBASE_PRODUCTS = 'https://api.exchange.coinbase.com/products';

export const BINANCE_FSTREAM_WS = 'wss://fstream.binance.com/public/ws';
export const BINANCE_SPOT_WS = 'wss://stream.binance.com:9443/ws';
export const BINANCE_EQUITY_WS = 'wss://nbstream.binance.com/equity/ws';
export const COINBASE_WS = 'wss://advanced-trade-ws.coinbase.com';
export const OKX_PUBLIC_WS = 'wss://ws.okx.com:8443/ws/v5/public';
export const BYBIT_LINEAR_WS = 'wss://stream.bybit.com/v5/public/linear';

const CATALOG_TTL_MS = 10 * 60_000;
const CATALOG_RETRY_MS = 30_000;
export const CATALOG_TIMEOUT_MS = 7_500; // 严格小于 DEX_READ_TIMEOUT_MS (10s)
export const ANALYZE_TIMEOUT_MS = 7_500; // 严格小于 DEX_READ_TIMEOUT_MS (10s)
const CATALOG_MAX_BYTES = 8_000_000;
const CATALOG_OTHER_MAX_BYTES = 6_000_000;

const BINANCE_KEEPALIVE_MS = 45_000;
const BINANCE_SILENCE_MS = 90_000;
const BINANCE_EQUITY_SILENCE_MS = 120_000;
const LIGHTER_PING_MS = 25_000;
const LIGHTER_SILENCE_MS = 60_000;
const ENTROPY_PING_MS = 15_000;
export const ENTROPY_CONFIRM_MS = 45_000;
const ENTROPY_SILENCE_MS = 45_000;
const COINBASE_SILENCE_MS = 60_000;
const OKX_PING_MS = 20_000;
const OKX_SILENCE_MS = 45_000;
const BYBIT_PING_MS = 20_000;
const BYBIT_SILENCE_MS = 45_000;

const BOOK_RESYNC_MIN_MS = 5_000;
const BOOK_RESYNC_MAX_MS = 60_000;
const BOOK_TRIM_SLACK = 1_000;
const BOOK_MESSAGE_LEVELS = 100_000;

const PRUNE_INTERVAL_MS = 5 * 60_000;
const PRUNE_BATCH_SIZE = 500;
const STORAGE_SUMMARY_TTL_MS = 30_000;
const MAX_PENDING_EVENT_BUFFER = 2_000;
const MAX_PENDING_GRID_BUFFER = 20_000;

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
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  return null;
};

const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 200);

interface LeadStreamCallbacks {
  onStatus: (connected: boolean, error: string | null, reconnects: number) => void;
  onTick: (bid: number, ask: number, exchangeMs: number | null) => void;
  onHeartbeat?: () => void;
}

export interface LeadSocketClient {
  start(): void;
  close(): void;
}

/** 公共重连、超时、文本帧与保活底座。 */
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
      if (this.onRawTextMessage(event.data)) return;
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

  protected sendRaw(raw: string): void {
    if (this.socket?.readyState === 1) this.socket.send(raw);
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

  protected onRawTextMessage(_text: string): boolean { return false; }
  protected abstract onConnected(): void;
  protected abstract onMessage(msg: unknown): void;
  protected abstract onConnectedTick(monoMs: number): void;
  protected onDropped(): void {}
}

/** 1 & 2. Binance 永续（perp）或现货（spot）单标的 `<symbol>@bookTicker` 实时流。 */
export class BinanceBookTickerStream extends BaseLeadStream {
  private readonly symbol: string;
  private reqId = 0;
  private lastKeepalive = 0;

  constructor(options: { symbol: string; mode?: 'perp' | 'spot'; url?: string; connect: Connect; monoNow: () => number; callbacks: LeadStreamCallbacks }) {
    const mode = options.mode ?? 'perp';
    const defaultUrl = mode === 'spot' ? BINANCE_SPOT_WS : BINANCE_FSTREAM_WS;
    super({ url: options.url ?? defaultUrl, connect: options.connect, monoNow: options.monoNow, silenceMs: BINANCE_SILENCE_MS, callbacks: options.callbacks });
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
    // 永续包含 e: 'bookTicker'，现货 bookTicker 推送仅有 { u, s, b, B, a, A } 无 e 字段。
    const isSpotBook = data.e === undefined && data.u !== undefined && data.b !== undefined && data.a !== undefined;
    if (data.e !== 'bookTicker' && !isSpotBook) return;
    if (typeof data.s === 'string' && data.s.toUpperCase() !== this.symbol) return;
    const bid = decimal(data.b), ask = decimal(data.a);
    const exchangeMs = safeTime(data.T) ?? safeTime(data.E);
    this.emitTop(bid, ask, exchangeMs);
  }
}

/** 3. Binance 美股/Stocks `<SYMBOL>@quote` 公开免 Key 实时一档流（`wss://nbstream.binance.com/equity/ws`）。 */
export class BinanceEquityQuoteStream extends BaseLeadStream {
  private readonly symbol: string;
  private reqId = 0;
  private lastKeepalive = 0;

  constructor(options: { symbol: string; url?: string; connect: Connect; monoNow: () => number; callbacks: LeadStreamCallbacks }) {
    super({ url: options.url ?? BINANCE_EQUITY_WS, connect: options.connect, monoNow: options.monoNow, silenceMs: BINANCE_EQUITY_SILENCE_MS, callbacks: options.callbacks });
    this.symbol = options.symbol.toUpperCase();
  }

  protected onConnected(): void {
    this.lastKeepalive = this.mono();
    this.send({ method: 'SUBSCRIBE', params: [`${this.symbol}@quote`], id: ++this.reqId });
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
    if (data.e !== 'quote') return;
    if (typeof data.s === 'string' && data.s.toUpperCase() !== this.symbol) return;
    const bid = decimal(data.bp ?? data.b), ask = decimal(data.ap ?? data.a);
    const exchangeMs = safeTime(data.T) ?? safeTime(data.E);
    this.emitTop(bid, ask, exchangeMs);
  }
}

/** 4 & DEX. Hyperliquid HIP-3 单市场 `bbo` 实时最优买卖价流（通用于 `xyz:<SYM>` 与 `io:<SYM>`）。 */
export class HyperliquidBboStream extends BaseLeadStream {
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

export { HyperliquidBboStream as EntropyBboStream };

/** 5. Coinbase Advanced Trade 公开现货一档流（`ticker` + `heartbeats`）。 */
export class CoinbaseTickerStream extends BaseLeadStream {
  private readonly productId: string;

  constructor(options: { productId: string; url?: string; connect: Connect; monoNow: () => number; callbacks: LeadStreamCallbacks }) {
    super({ url: options.url ?? COINBASE_WS, connect: options.connect, monoNow: options.monoNow, silenceMs: COINBASE_SILENCE_MS, callbacks: options.callbacks });
    this.productId = options.productId.toUpperCase();
  }

  protected onConnected(): void {
    this.send({ type: 'subscribe', product_ids: [this.productId], channel: 'ticker' });
    this.send({ type: 'subscribe', product_ids: [this.productId], channel: 'heartbeats' });
  }

  protected onConnectedTick(_monoMs: number): void {}

  protected onMessage(raw: unknown): void {
    const msg = isObject(raw) ? raw : null;
    if (!msg) return;
    if (msg.type === 'error') throw new Error(String(msg.message ?? 'Coinbase 错误').slice(0, 160));
    if (msg.channel !== 'ticker' || !Array.isArray(msg.events)) return;
    const msgTs = safeTime(msg.timestamp);
    for (const ev of msg.events) {
      if (!isObject(ev) || !Array.isArray(ev.tickers)) continue;
      for (const item of ev.tickers) {
        if (!isObject(item)) continue;
        if (typeof item.product_id === 'string' && item.product_id.toUpperCase() !== this.productId) continue;
        const bid = decimal(item.best_bid), ask = decimal(item.best_ask);
        this.emitTop(bid, ask, msgTs);
      }
    }
  }
}

/** 6. OKX V5 公开永续 `bbo-tbt` 10ms 逐笔一档流（含文本 `'ping'`/`'pong'` 心跳）。 */
export class OkxBboStream extends BaseLeadStream {
  private readonly instId: string;
  private lastPing = 0;

  constructor(options: { instId: string; url?: string; connect: Connect; monoNow: () => number; callbacks: LeadStreamCallbacks }) {
    super({ url: options.url ?? OKX_PUBLIC_WS, connect: options.connect, monoNow: options.monoNow, silenceMs: OKX_SILENCE_MS, callbacks: options.callbacks });
    this.instId = options.instId.toUpperCase();
  }

  protected onRawTextMessage(text: string): boolean {
    return text.trim() === 'pong';
  }

  protected onConnected(): void {
    this.lastPing = this.mono();
    this.send({ op: 'subscribe', args: [{ channel: 'bbo-tbt', instId: this.instId }] });
  }

  protected onConnectedTick(monoMs: number): void {
    if (monoMs - this.lastPing >= OKX_PING_MS) {
      this.lastPing = monoMs;
      this.sendRaw('ping');
    }
  }

  protected onMessage(raw: unknown): void {
    const msg = isObject(raw) ? raw : null;
    if (!msg) return;
    if (msg.event === 'error') throw new Error(String(msg.msg ?? 'OKX 错误').slice(0, 160));
    const arg = isObject(msg.arg) ? msg.arg : null;
    if (arg?.channel !== 'bbo-tbt' || arg.instId !== this.instId || !Array.isArray(msg.data)) return;
    for (const item of msg.data) {
      if (!isObject(item) || !Array.isArray(item.bids) || !Array.isArray(item.asks)) continue;
      const b0 = Array.isArray(item.bids[0]) ? item.bids[0] : null;
      const a0 = Array.isArray(item.asks[0]) ? item.asks[0] : null;
      const bid = decimal(b0?.[0]), ask = decimal(a0?.[0]);
      const ts = safeTime(item.ts);
      this.emitTop(bid, ask, ts);
    }
  }
}

/** 7. Bybit V5 线型永续 `orderbook.1.<SYMBOL>` 10ms 一档流（支持 snapshot / u===1 重置 / 单边 delta）。 */
export class BybitOrderBookTopStream extends BaseLeadStream {
  private readonly symbol: string;
  private lastPing = 0;
  private curBid: number | null = null;
  private curAsk: number | null = null;

  constructor(options: { symbol: string; url?: string; connect: Connect; monoNow: () => number; callbacks: LeadStreamCallbacks }) {
    super({ url: options.url ?? BYBIT_LINEAR_WS, connect: options.connect, monoNow: options.monoNow, silenceMs: BYBIT_SILENCE_MS, callbacks: options.callbacks });
    this.symbol = options.symbol.toUpperCase();
  }

  protected onConnected(): void {
    this.lastPing = this.mono();
    this.curBid = this.curAsk = null;
    this.send({ op: 'subscribe', args: [`orderbook.1.${this.symbol}`] });
  }

  protected onDropped(): void {
    this.curBid = this.curAsk = null;
  }

  protected onConnectedTick(monoMs: number): void {
    if (monoMs - this.lastPing >= BYBIT_PING_MS) {
      this.lastPing = monoMs;
      this.send({ op: 'ping' });
    }
  }

  protected onMessage(raw: unknown): void {
    const msg = isObject(raw) ? raw : null;
    if (!msg) return;
    if (msg.success === false && msg.op === 'subscribe') {
      throw new Error(String(msg.ret_msg ?? 'Bybit 订阅失败').slice(0, 160));
    }
    if (msg.topic !== `orderbook.1.${this.symbol}`) return;
    const data = isObject(msg.data) ? msg.data : null;
    if (!data) return;
    const isSnap = msg.type === 'snapshot' || data.u === 1;
    if (isSnap) this.curBid = this.curAsk = null;

    const applySide = (rows: unknown, current: number | null, isBid: boolean): number | null => {
      if (!Array.isArray(rows) || !rows.length) return current;
      let best: number | null = null;
      let sawCurZero = false;
      for (const entry of rows) {
        if (!Array.isArray(entry)) continue;
        const px = decimal(entry[0]), sz = decimal(entry[1]);
        if (px === null || sz === null || px <= 0) continue;
        if (sz > 0) {
          if (best === null || (isBid ? px > best : px < best)) best = px;
        } else if (current !== null && px === current) {
          sawCurZero = true;
        }
      }
      if (best !== null) return best;
      return sawCurZero ? null : current;
    };

    this.curBid = applySide(data.b, this.curBid, true);
    this.curAsk = applySide(data.a, this.curAsk, false);
    this.emitTop(this.curBid, this.curAsk, safeTime(msg.ts), isSnap);
  }
}

function trimSide(levels: Map<number, number>, descending: boolean): number {
  const kept = [...levels].sort((a, b) => descending ? b[0] - a[0] : a[0] - b[0]).slice(0, BOOK_KEEP_LEVELS);
  levels.clear();
  for (const [price, size] of kept) levels.set(price, size);
  return kept.at(-1)![0];
}

/** Lighter（主网 / RH）单市场 `order_book/{marketId}` 实时最优买卖价流（O(1) 增量维护）。 */
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

export interface LeadTesterOptions {
  leadStoreFile: string;
  fetchImpl: FetchLike;
  connect: Connect;
  now: () => number;
  monoNow: () => number;
  log: (line: string) => void;
  dexMarkets: () => Record<LeadVenue, readonly MarketSpec[]>;
  analyzeTimeoutMs?: number;
}

interface WatcherRuntime {
  runId: number;
  tracker: LeadTracker;
  streams: LeadSocketClient[];
}

function emptyCatalogRecords(): Record<LeadRefSource, LeadRefCatalogEntry[]> {
  return {
    binance_perp: [],
    binance_spot: [],
    binance_equity: [],
    hl_xyz: [],
    coinbase_spot: [],
    okx_perp: [],
    bybit_perp: [],
  };
}

function emptyCatalogStatuses(): Record<LeadRefSource, { ok: number | null; count: number; error: string | null }> {
  return {
    binance_perp: { ok: null, count: 0, error: null },
    binance_spot: { ok: null, count: 0, error: null },
    binance_equity: { ok: null, count: 0, error: null },
    hl_xyz: { ok: null, count: 0, error: null },
    coinbase_spot: { ok: null, count: 0, error: null },
    okx_perp: { ok: null, count: 0, error: null },
    bybit_perp: { ok: null, count: 0, error: null },
  };
}

/**
 * 常驻多标的、多领先源测速控制器：
 * - 从独立 lead.sqlite 恢复最多 3 个常驻标的并持续运行；
 * - 1 秒批量攒批落盘、5 分钟小批清理 7 天旧样本；
 * - 离线查库交由独立只读 Worker（<=7.5s 超时）计算，彻底不堵塞实盘线程。
 */
export function createLeadTester(options: LeadTesterOptions) {
  const { leadStoreFile, fetchImpl, connect, now, monoNow, log, dexMarkets, analyzeTimeoutMs = ANALYZE_TIMEOUT_MS } = options;
  const stopController = new AbortController();

  let leadStore: LeadStore | null = null;
  let storeAttempted = false;
  let storageError: string | null = null;
  let lastWriteError: string | null = null;
  let storageSummaryCache: { at: number; view: LeadStorageView } | null = null;

  const catalogContracts = emptyCatalogRecords();
  const catalogStatuses = emptyCatalogStatuses();
  let catalogAt: number | null = null;
  let catalogInflight: Promise<void> | null = null;

  const watchers = new Map<string, StoredWatcherRow>();
  const runtimes = new Map<string, WatcherRuntime>();
  let pendingEvents: PersistLeadEvent[] = [];
  const pendingGrids = new Map<string, PersistLeadGrid>();
  let lastFlushErrorLogAt: number | null = null;

  let nextPruneAt = now() + 60_000;
  const startRunCooldown = new Map<string, { until: number; error: string }>();
  let lastStartRunErrorLogAt: number | null = null;
  let activeWorker: Worker | null = null;
  let closed = false;

  function ensureLeadStore(): LeadStore | null {
    if (leadStore || storeAttempted || closed) return leadStore;
    storeAttempted = true;
    let opened: LeadStore | null = null;
    try {
      opened = openLeadStore(leadStoreFile);
      for (const w of opened.listWatchers().slice(0, LEAD_MAX_WATCHERS)) {
        watchers.set(w.symbol, w);
      }
      leadStore = opened;
    } catch (error) {
      try { opened?.close(); } catch { /* 已关闭 */ }
      storageError = `打不开领先测速数据库：${errorText(error)}`;
      log(`varlighter: ${storageError}`);
    }
    return leadStore;
  }

  function requireOpenStore(): LeadStore {
    if (closed) throw new LeadError(503, 'unavailable', '测速服务已停止');
    const store = ensureLeadStore();
    if (!store) throw new LeadError(503, 'storage_unavailable', storageError ?? '领先测速数据库不可用');
    return store;
  }

  // 若历史 lead.sqlite 已存在（如停机前存有常驻标的）则立即打开恢复；全新目录延迟到首次访问测速接口再建库，避免无用句柄。
  if (leadStoreFile === ':memory:' || existsSync(leadStoreFile)) {
    ensureLeadStore();
  }

  function storageView(): LeadStorageView {
    if (!leadStore) {
      return { file: 'lead.sqlite', retentionDays: LEAD_RETENTION_DAYS, error: storageError, dbBytes: null, totalEvents: 0, totalGridPoints: 0, symbols: [] };
    }
    const t = now();
    if (!storageSummaryCache || t - storageSummaryCache.at >= STORAGE_SUMMARY_TTL_MS) {
      try {
        storageSummaryCache = { at: t, view: leadStore.summary() };
        storageError = null;
      } catch (error) {
        storageError = errorText(error);
        return { file: 'lead.sqlite', retentionDays: LEAD_RETENTION_DAYS, error: storageError ?? lastWriteError, dbBytes: null, totalEvents: 0, totalGridPoints: 0, symbols: [] };
      }
    }
    const combinedError = storageError ?? lastWriteError;
    return combinedError ? { ...storageSummaryCache.view, error: combinedError } : storageSummaryCache.view;
  }

  function invalidateStorageSummary(): void {
    storageSummaryCache = null;
  }

  function enqueueGrid(pt: PersistLeadGrid): void {
    const key = `${pt.symbol}\0${pt.source}\0${pt.runId}\0${pt.gridIdx}`;
    pendingGrids.set(key, pt);
    if (pendingGrids.size > MAX_PENDING_GRID_BUFFER) {
      const drop = pendingGrids.size - MAX_PENDING_GRID_BUFFER;
      let removed = 0;
      for (const k of pendingGrids.keys()) {
        pendingGrids.delete(k);
        if (++removed >= drop) break;
      }
    }
  }

  function enqueueEvent(ev: PersistLeadEvent): void {
    pendingEvents.push(ev);
    if (pendingEvents.length > MAX_PENDING_EVENT_BUFFER) {
      pendingEvents.splice(0, pendingEvents.length - MAX_PENDING_EVENT_BUFFER);
    }
  }

  function flushNow(): void {
    if (!leadStore || (!pendingEvents.length && !pendingGrids.size)) return;
    const evs = pendingEvents;
    const grids = [...pendingGrids.values()];
    pendingEvents = [];
    pendingGrids.clear();
    try {
      leadStore.flushBatch(evs, grids);
      lastWriteError = null;
      invalidateStorageSummary();
    } catch (error) {
      const msg = errorText(error);
      lastWriteError = msg;
      const t = now();
      if (lastFlushErrorLogAt === null || t - lastFlushErrorLogAt >= 60_000) {
        lastFlushErrorLogAt = t;
        log(`varlighter: 写入 lead.sqlite 失败：${msg}`);
      }
    }
  }

  function resolveMarketsFor(config: LeadWatcherConfig): Record<LeadVenue, MarketSpec> | null {
    const allDex = dexMarkets();
    const matched = {} as Record<LeadVenue, MarketSpec>;
    for (const venue of LEAD_VENUES) {
      const sym = config.targets[venue];
      if (!sym) continue;
      const found = (allDex[venue] ?? []).find(m => m.symbol === sym || m.symbol.toUpperCase() === sym.toUpperCase());
      if (!found) return null;
      matched[venue] = found;
    }
    return matched;
  }

  function createLeadSocket(source: LeadRefSource, sym: string, callbacks: LeadStreamCallbacks): LeadSocketClient {
    switch (source) {
      case 'binance_perp':
        return new BinanceBookTickerStream({ symbol: sym, mode: 'perp', connect, monoNow, callbacks });
      case 'binance_spot':
        return new BinanceBookTickerStream({ symbol: sym, mode: 'spot', connect, monoNow, callbacks });
      case 'binance_equity':
        return new BinanceEquityQuoteStream({ symbol: sym, connect, monoNow, callbacks });
      case 'hl_xyz':
        return new HyperliquidBboStream({ coin: sym, connect, monoNow, callbacks });
      case 'coinbase_spot':
        return new CoinbaseTickerStream({ productId: sym, connect, monoNow, callbacks });
      case 'okx_perp':
        return new OkxBboStream({ instId: sym, connect, monoNow, callbacks });
      case 'bybit_perp':
        return new BybitOrderBookTopStream({ symbol: sym, connect, monoNow, callbacks });
    }
  }

  function startRuntime(w: StoredWatcherRow, ignoreCooldown = false): boolean {
    if (closed || !leadStore || !w.enabled || runtimes.has(w.symbol)) return false;
    const tNow = now();
    const cooldown = startRunCooldown.get(w.symbol);
    if (!ignoreCooldown && cooldown && tNow < cooldown.until) return false;
    const markets = resolveMarketsFor(w.config);
    if (!markets) return false;

    const startedAt = tNow;
    const startMono = monoNow();
    let runId: number;
    try {
      runId = leadStore.startRun(w.symbol, startedAt, w.config);
      startRunCooldown.delete(w.symbol);
      lastWriteError = null;
    } catch (error) {
      const msg = errorText(error);
      lastWriteError = msg;
      startRunCooldown.set(w.symbol, { until: startedAt + 30_000, error: msg });
      if (lastStartRunErrorLogAt === null || startedAt - lastStartRunErrorLogAt >= 60_000) {
        lastStartRunErrorLogAt = startedAt;
        log(`varlighter: 启动 ${w.symbol} 测速 run 失败：${msg}`);
      }
      return false;
    }

    const tracker = new LeadTracker({
      symbol: w.symbol,
      runId,
      config: w.config,
      startedAt,
      startMono,
      onSettled: enqueueEvent,
      onGridPoint: enqueueGrid,
    });

    const makeCb = (source: LeadSource): LeadStreamCallbacks => ({
      onStatus(connected, error, reconnects) {
        tracker.setConnected(source, connected, monoNow(), now(), error, reconnects);
      },
      onTick(bid, ask, exchangeMs) {
        tracker.onTick(source, { monoMs: monoNow(), wallMs: now(), bid, ask, mid: (bid + ask) / 2, exchangeMs });
      },
      onHeartbeat() {
        tracker.confirmAlive(source, monoNow(), now());
      },
    });

    const streams: LeadSocketClient[] = [];
    for (const src of LEAD_REF_SOURCES) {
      const sym = w.config.leads[src];
      if (sym) streams.push(createLeadSocket(src, sym, makeCb(src)));
    }
    for (const venue of LEAD_VENUES) {
      const market = markets[venue];
      if (!market) continue;
      if (venue === 'entropy') {
        streams.push(new HyperliquidBboStream({ coin: market.coin ?? `io:${market.symbol}`, connect, monoNow, callbacks: makeCb('entropy') }));
      } else {
        streams.push(new LighterOrderBookTopStream({ venue, marketId: market.id, connect, monoNow, callbacks: makeCb(venue) }));
      }
    }

    const rt: WatcherRuntime = { runId, tracker, streams };
    runtimes.set(w.symbol, rt);
    for (const s of streams) s.start();
    return true;
  }

  function stopRuntime(symbol: string): void {
    const rt = runtimes.get(symbol);
    if (!rt) return;
    runtimes.delete(symbol);
    for (const s of rt.streams) {
      try { s.close(); } catch { /* 忽略 */ }
    }
    const wall = now();
    rt.tracker.finalize(wall, monoNow());
    flushNow();
    try {
      leadStore?.endRun(rt.runId, wall);
      invalidateStorageSummary();
    } catch (error) {
      lastWriteError = errorText(error);
    }
  }

  function syncWaitingWatchers(): void {
    if (closed || !leadStore) return;
    for (const w of watchers.values()) {
      if (w.enabled && !runtimes.has(w.symbol)) {
        startRuntime(w);
      }
    }
  }

  function tickMaintenance(): void {
    if (closed) return;
    syncWaitingWatchers();
    const m = monoNow();
    for (const rt of runtimes.values()) {
      rt.tracker.tickTimeouts(m);
    }
    flushNow();

    const t = now();
    if (leadStore && t >= nextPruneAt) {
      try {
        const res = leadStore.pruneBatch(t - LEAD_RETENTION_DAYS * 86_400_000, PRUNE_BATCH_SIZE);
        if (res.deleted > 0) invalidateStorageSummary();
        nextPruneAt = res.more ? t + 1_000 : t + PRUNE_INTERVAL_MS;
      } catch (error) {
        nextPruneAt = t + PRUNE_INTERVAL_MS;
        lastWriteError = errorText(error);
      }
    }
  }

  const mainTimer = setInterval(tickMaintenance, 1_000);
  mainTimer.unref?.();

  // 先尝试唤醒一次已启用 watcher（若目录已有则当场启动，没有则等后台目录加载完由 tick 唤醒）。
  syncWaitingWatchers();

  function loadCatalog(force = false): Promise<void> {
    if (catalogInflight) return catalogInflight;
    const t = now();
    const allOkRecently = LEAD_REF_SOURCES
      .filter(s => s !== 'binance_equity')
      .every(s => catalogStatuses[s].ok !== null && t - catalogStatuses[s].ok! < CATALOG_TTL_MS);
    if (!force && allOkRecently) return Promise.resolve();
    if (!force && catalogAt !== null && t - catalogAt < CATALOG_RETRY_MS) return Promise.resolve();

    catalogAt = t;
    const signal = anySignal([stopController.signal], CATALOG_TIMEOUT_MS);

    const fetchTask = async <T>(
      src: Exclude<LeadRefSource, 'binance_equity'>,
      loader: () => Promise<T>,
      parser: (raw: T) => LeadRefCatalogEntry[],
    ) => {
      try {
        const raw = await loader();
        const entries = parser(raw);
        catalogContracts[src] = entries;
        catalogStatuses[src] = { ok: now(), count: entries.length, error: null };
      } catch (error) {
        catalogStatuses[src] = { ...catalogStatuses[src], error: errorText(error) };
      }
    };

    catalogInflight = Promise.allSettled([
      fetchTask('binance_perp', () => readJson(fetchImpl, BINANCE_FAPI_EXCHANGE_INFO, signal, CATALOG_MAX_BYTES, {}), parseBinanceExchangeInfo),
      fetchTask('binance_spot', () => readJson(fetchImpl, BINANCE_SPOT_BOOK_TICKERS, signal, CATALOG_OTHER_MAX_BYTES, {}), parseBinanceSpotTickers),
      fetchTask('hl_xyz', () => readJson(fetchImpl, ENTROPY_ENDPOINTS.info, signal, CATALOG_OTHER_MAX_BYTES, {}, { type: 'metaAndAssetCtxs', dex: 'xyz' }), parseHyperliquidXyzCatalog),
      fetchTask('okx_perp', () => readJson(fetchImpl, OKX_SWAP_INSTRUMENTS, signal, CATALOG_OTHER_MAX_BYTES, {}), parseOkxSwapCatalog),
      fetchTask('bybit_perp', () => readJson(fetchImpl, BYBIT_LINEAR_INSTRUMENTS, signal, CATALOG_OTHER_MAX_BYTES, {}), parseBybitLinearCatalog),
      fetchTask('coinbase_spot', () => readJson(fetchImpl, COINBASE_PRODUCTS, signal, CATALOG_OTHER_MAX_BYTES, {}), parseCoinbaseSpotCatalog),
    ]).then(() => { /* 各任务自行记录成功或错误 */ }).finally(() => {
      catalogInflight = null;
    });
    return catalogInflight;
  }

  function catalogView(): LeadCatalogStatusView {
    return {
      loading: catalogInflight !== null,
      at: catalogAt,
      sources: { ...catalogStatuses },
      contracts: { ...catalogContracts },
    };
  }

  function view(): LeadView {
    if (closed) throw new LeadError(503, 'unavailable', '测速服务已停止');
    ensureLeadStore();
    void loadCatalog(false);
    syncWaitingWatchers();
    const allDex = dexMarkets();
    const candidates = buildLeadCandidates(catalogContracts, allDex);
    const dexCatalogs = {
      lighter: (allDex.lighter ?? []).map((m): LeadCatalogEntry => ({ symbol: m.symbol, mark: m.mark })),
      rh: (allDex.rh ?? []).map((m): LeadCatalogEntry => ({ symbol: m.symbol, mark: m.mark })),
      entropy: (allDex.entropy ?? []).map((m): LeadCatalogEntry => ({ symbol: m.symbol, mark: m.mark })),
    };

    const wall = now();
    const mono = monoNow();
    const watcherViews: LeadWatcherView[] = [];
    for (const w of watchers.values()) {
      const rt = runtimes.get(w.symbol);
      if (rt) {
        watcherViews.push(rt.tracker.watcherView({ enabled: w.enabled, status: 'running', createdAt: w.createdAt, updatedAt: w.updatedAt }, wall, mono));
      } else {
        const status: LeadWatcherView['status'] = w.enabled ? 'waiting_catalog' : 'paused';
        const runCd = startRunCooldown.get(w.symbol);
        const waitReason = status !== 'waiting_catalog'
          ? null
          : runCd && wall < runCd.until
            ? `写库失败，等待退避重试（${runCd.error}）`
            : '等待 DEX 市场目录同步';
        watcherViews.push({
          symbol: w.symbol,
          config: w.config,
          enabled: w.enabled,
          status,
          createdAt: w.createdAt,
          updatedAt: w.updatedAt,
          startedAt: null,
          runId: null,
          recentWindowSec: 1800,
          recentEventCount: 0,
          streams: [
            ...LEAD_REF_SOURCES.filter(s => Boolean(w.config.leads[s])).map(source => ({
              source, name: LEAD_SOURCE_NAMES[source], symbol: w.config.leads[source]!,
              connected: false, lastError: waitReason,
              reconnects: 0, ticks: 0, ticksPerSec: 0, bid: null, ask: null, mid: null, spreadBps: null, lastTickAt: null, exchangeLagMs: null, basisBps: null,
            })),
            ...LEAD_VENUES.filter(v => Boolean(w.config.targets[v])).map(venue => ({
              source: venue, name: LEAD_VENUE_NAMES[venue], symbol: w.config.targets[venue]!,
              connected: false, lastError: waitReason,
              reconnects: 0, ticks: 0, ticksPerSec: 0, bid: null, ask: null, mid: null, spreadBps: null, lastTickAt: null, exchangeLagMs: null, basisBps: null,
            })),
          ],
          recentSummary: LEAD_REF_SOURCES.filter(s => Boolean(w.config.leads[s])).map(leadSource => ({
            leadSource,
            name: LEAD_REF_NAMES[leadSource],
            symbol: w.config.leads[leadSource]!,
            events: 0,
            venues: {},
          })),
        });
      }
    }

    return {
      now: wall,
      maxWatchers: LEAD_MAX_WATCHERS,
      retentionDays: LEAD_RETENTION_DAYS,
      catalog: catalogView(),
      dexCatalogs,
      candidates,
      storage: storageView(),
      watchers: watcherViews,
    };
  }

  function addWatcher(body: unknown): LeadView {
    const store = requireOpenStore();
    const config = readLeadWatcherConfig(body);
    if (watchers.has(config.symbol)) {
      throw new LeadError(409, 'duplicate_watcher', `${config.symbol} 已在常驻测速列表中`);
    }
    if (watchers.size >= LEAD_MAX_WATCHERS) {
      throw new LeadError(409, 'max_watchers', `最多同时常驻 ${LEAD_MAX_WATCHERS} 个标的，请先移除不用的标的`);
    }

    const allDex = dexMarkets();
    for (const venue of LEAD_VENUES) {
      const sym = config.targets[venue];
      if (!sym) continue;
      const found = (allDex[venue] ?? []).find(m => m.symbol === sym || m.symbol.toUpperCase() === sym.toUpperCase());
      if (!found) {
        throw new LeadError(400, 'unknown_market', `${LEAD_VENUE_NAMES[venue]} 目录中找不到标的 ${sym}`);
      }
      config.targets[venue] = found.symbol;
    }

    const t = now();
    store.upsertWatcher(config, true, t);
    const row: StoredWatcherRow = { symbol: config.symbol, config, enabled: true, createdAt: t, updatedAt: t };
    watchers.set(config.symbol, row);
    startRunCooldown.delete(config.symbol);
    invalidateStorageSummary();
    startRuntime(row, true);
    return view();
  }

  function toggleWatcher(body: unknown): LeadView {
    const store = requireOpenStore();
    const req = readLeadWatcherMutation(body, true);
    const cur = watchers.get(req.symbol);
    if (!cur) throw new LeadError(404, 'not_found', `找不到常驻标的 ${req.symbol}`);
    if (cur.updatedAt !== req.updatedAt) {
      throw new LeadError(409, 'watcher_conflict', '标的运行状态已变化，请刷新后再试');
    }
    const nextAt = Math.max(now(), cur.updatedAt + 1);
    if (!store.setWatcherEnabled(req.symbol, req.enabled, req.updatedAt, nextAt)) {
      throw new LeadError(409, 'watcher_conflict', '标的运行状态已变化，请刷新后再试');
    }
    const updated: StoredWatcherRow = { ...cur, enabled: req.enabled, updatedAt: nextAt };
    watchers.set(req.symbol, updated);
    if (req.enabled) {
      startRunCooldown.delete(req.symbol);
      startRuntime(updated, true);
    } else {
      stopRuntime(req.symbol);
    }
    return view();
  }

  function removeWatcher(body: unknown): LeadView {
    const store = requireOpenStore();
    const req = readLeadWatcherMutation(body, false);
    const cur = watchers.get(req.symbol);
    if (!cur) throw new LeadError(404, 'not_found', `找不到常驻标的 ${req.symbol}`);
    if (cur.updatedAt !== req.updatedAt) {
      throw new LeadError(409, 'watcher_conflict', '标的运行状态已变化，请刷新后再试');
    }
    if (!store.deleteWatcher(req.symbol, req.updatedAt)) {
      throw new LeadError(409, 'watcher_conflict', '标的运行状态已变化，请刷新后再试');
    }
    stopRuntime(req.symbol);
    watchers.delete(req.symbol);
    startRunCooldown.delete(req.symbol);
    invalidateStorageSummary();
    return view();
  }

  async function analyze(body: unknown): Promise<LeadAnalyzeView> {
    const store = requireOpenStore();
    const req = readLeadAnalyzeRequest(body, now());
    if (activeWorker) {
      throw new LeadError(429, 'lead_analyze_busy', '已有离线分析在执行，请稍后再试');
    }

    // 查询前先把内存中刚结算的事件与网格刷入 lead.sqlite（L054）。
    flushNow();

    const job: LeadAnalyzeJob = {
      file: store.file,
      symbol: req.symbol,
      leadSource: req.leadSource,
      from: req.from,
      to: req.to,
    };

    if (store.file === ':memory:') {
      return analyzeLeadDatabase(store.db, job);
    }

    const worker = new Worker(new URL('./lead-worker.ts', import.meta.url), { workerData: job, env: {}, execArgv: [] });
    activeWorker = worker;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void worker.terminate();
    }, analyzeTimeoutMs);
    try {
      return await new Promise<LeadAnalyzeView>((resolve, reject) => {
        let result: LeadAnalyzeView | undefined;
        worker.once('message', msg => { result = msg as LeadAnalyzeView; });
        worker.once('error', err => reject(new LeadError(500, 'analyze_failed', `离线分析失败：${errorText(err)}`)));
        worker.once('exit', code => {
          if (timedOut) {
            reject(new LeadError(504, 'analyze_timeout', '分析窗口数据量大，计算超时，请缩短查询时段'));
          } else if (code === 0 && result) {
            resolve(result);
          } else {
            reject(new LeadError(500, 'analyze_failed', '离线分析未正常完成'));
          }
        });
      });
    } finally {
      clearTimeout(timer);
      if (activeWorker === worker) activeWorker = null;
    }
  }

  function clearData(body: unknown): LeadView {
    const store = requireOpenStore();
    let symbol: string | undefined;
    if (isObject(body) && typeof body.symbol === 'string' && body.symbol.trim()) {
      symbol = body.symbol.trim().toUpperCase();
    }
    flushNow();
    store.clearData(symbol);
    lastWriteError = null;
    invalidateStorageSummary();
    return view();
  }

  async function refreshCatalog(): Promise<LeadView> {
    if (closed) throw new LeadError(503, 'unavailable', '测速服务已停止');
    await loadCatalog(true);
    return view();
  }

  function close(): void {
    if (closed) return;
    closed = true;
    clearInterval(mainTimer);
    stopController.abort();
    if (activeWorker) {
      void activeWorker.terminate();
      activeWorker = null;
    }
    for (const symbol of [...runtimes.keys()]) {
      stopRuntime(symbol);
    }
    flushNow();
    const opened = leadStore;
    leadStore = null;
    try { opened?.close(); } catch { /* 已关闭 */ }
  }

  return {
    view,
    addWatcher,
    toggleWatcher,
    removeWatcher,
    analyze,
    clearData,
    refreshCatalog,
    tickMaintenance,
    close,
  };
}
