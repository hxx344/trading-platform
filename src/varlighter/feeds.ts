// 各场所的公开行情（docs/varlighter.md 第 3 节、docs/dexspread.md 第 3 节）：Var metadata/stats 轮询；每个 Lighter 场所（RH 链、主网）各自的合约目录、
// WebSocket（market_stats/all 的全市场一档与资金费）与启用配对的盘口快照（REST，每分钟一次）；Entropy（Hyperliquid HIP-3 `io`）的
// 目录与市场状态（metaAndAssetCtxs，每分钟一次）、WebSocket（bbo）与盘口快照（l2Book）。只读公开接口，不带任何凭据。
// 行情流的一档按本机收到时刻记成历史，Var 报价最多晚一分多钟才拿到，对齐时回看那一刻的行情流状态。
// 完整盘口不走 WebSocket 订阅：主网 BTC 一个市场的增量压缩后约 550 MB/天，快照每分钟一次约 22 KB。
import { ExchangeResponseError, readJsonResponse } from '../vendor/response.mjs';
import { VARIATIONAL_STATS, VARIATIONAL_USER_AGENT } from '../vendor/variational-market.mjs';
import { VENUE_NAMES, parseEntropyMarkets, parseRhMarkets, parseVarListings, type MarketSpec, type RhMarket, type VarListing, type Venue } from './model.ts';

export const LIGHTER_ENDPOINTS: Record<Venue, { rest: string; stream: string }> = {
  rh: { rest: 'https://api.rh.lighter.xyz/api/v1', stream: 'wss://api.rh.lighter.xyz/stream?readonly=true' },
  lighter: { rest: 'https://mainnet.zklighter.elliot.ai/api/v1', stream: 'wss://mainnet.zklighter.elliot.ai/stream?readonly=true' },
};
export const ENTROPY_ENDPOINTS = { info: 'https://api.hyperliquid.xyz/info', stream: 'wss://api.hyperliquid.xyz/ws', dex: 'io' } as const;
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

async function readJson(fetchImpl: FetchLike, url: string, signal: AbortSignal, limit: number, headers: Record<string, string>, body?: unknown): Promise<unknown> {
  const response = await fetchImpl(url, body === undefined ? { headers: { accept: 'application/json', ...headers }, signal }
    : { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
  if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error(`HTTP ${response.status}`); }
  try { return await readJsonResponse(response, { maxBytes: limit, signal }) as unknown; } catch (error) {
    if (!(error instanceof ExchangeResponseError)) throw error;
    const code = error.code;
    throw code === 'response_limit' ? new Error('响应过大') : code === 'invalid_data' ? new Error('响应不是有效的 JSON') : code === 'aborted' ? new Error('请求已中止') : error;
  }
}
export async function fetchVarListings(fetchImpl: FetchLike, signal: AbortSignal, now: () => number): Promise<VarListing[]> {
  const body = await readJson(fetchImpl, VARIATIONAL_STATS, signal, 4_000_000, { 'user-agent': VARIATIONAL_USER_AGENT });
  return parseVarListings(body, now());
}
export async function fetchRhMarkets(fetchImpl: FetchLike, signal: AbortSignal, venue: Venue = 'rh'): Promise<RhMarket[]> {
  return parseRhMarkets(await readJson(fetchImpl, `${LIGHTER_ENDPOINTS[venue].rest}/orderBookDetails`, signal, 4_000_000, {}), venue);
}
/** Entropy 目录与每个市场的标记价、预言机价、每小时资金费（一次请求）。 */
export async function fetchEntropyMarkets(fetchImpl: FetchLike, signal: AbortSignal): Promise<MarketSpec[]> {
  return parseEntropyMarkets(await readJson(fetchImpl, ENTROPY_ENDPOINTS.info, signal, 4_000_000, {}, { type: 'metaAndAssetCtxs', dex: ENTROPY_ENDPOINTS.dex }));
}

// ---- 盘口快照 ----
/** 一次盘口快照：最优买卖价与 1k / 100k 美元的成交均价（深度不足为 null）。 */
export interface DepthSnapshot { at: number; bid: number; ask: number; bid1k: number | null; ask1k: number | null; bid100k: number | null; ask100k: number | null }
/** 快照与 Var 报价时刻相差不超过这个值才把它的冲击用到样本上。 */
export const DEPTH_MAX_GAP_MS = 120_000;
/** 每个场所同时取快照的配对上限（启用的与有持仓的）。 */
export const MAX_DEPTH_MARKETS = 10;
const BOOK_ORDERS = 50;

/** orderBookOrders 的挂单（逐笔）按价格合并，从最优到最差排好。 */
export function parseBookOrders(input: unknown): { bids: [number, number][]; asks: [number, number][] } {
  const value = object(input);
  if (!value || value.code !== 200 || !Array.isArray(value.bids) || !Array.isArray(value.asks)) throw new Error('Lighter 盘口格式无效');
  const side = (rows: unknown[], descending: boolean) => {
    const levels = new Map<number, number>();
    for (const raw of rows.slice(0, 500)) {
      const row = object(raw), price = decimal(row?.price), size = decimal(row?.remaining_base_amount);
      if (price === null || size === null || price <= 0 || size <= 0) continue;
      levels.set(price, (levels.get(price) ?? 0) + size);
    }
    return [...levels].sort((a, b) => descending ? b[0] - a[0] : a[0] - b[0]);
  };
  return { bids: side(value.bids, true), asks: side(value.asks, false) };
}
export function depthSnapshot(book: { bids: [number, number][]; asks: [number, number][] }, at: number): DepthSnapshot {
  if (!book.bids.length || !book.asks.length) throw new Error('盘口为空');
  if (book.bids[0][0] >= book.asks[0][0]) throw new Error('盘口倒挂');
  return { at, bid: book.bids[0][0], ask: book.asks[0][0], bid1k: vwap(book.bids, 1_000), ask1k: vwap(book.asks, 1_000), bid100k: vwap(book.bids, 100_000), ask100k: vwap(book.asks, 100_000) };
}
export async function fetchDepth(fetchImpl: FetchLike, venue: Venue, marketId: number, signal: AbortSignal, now: () => number): Promise<DepthSnapshot> {
  const body = await readJson(fetchImpl, `${LIGHTER_ENDPOINTS[venue].rest}/orderBookOrders?market_id=${marketId}&limit=${BOOK_ORDERS}`, signal, 400_000, {});
  return depthSnapshot(parseBookOrders(body), now());
}
/** Hyperliquid l2Book 的 levels（[买, 卖]，每档 {px, sz, n}，已从最优排好，各 20 档）。 */
export function parseL2Levels(input: unknown): { bids: [number, number][]; asks: [number, number][] } {
  const levels = object(input)?.levels;
  if (!Array.isArray(levels) || levels.length !== 2 || !Array.isArray(levels[0]) || !Array.isArray(levels[1])) throw new Error('Entropy 盘口格式无效');
  const side = (rows: unknown[]) => rows.slice(0, 100).flatMap(raw => {
    const row = object(raw), price = decimal(row?.px), size = decimal(row?.sz);
    return price !== null && size !== null && price > 0 && size > 0 ? [[price, size] as [number, number]] : [];
  });
  return { bids: side(levels[0]), asks: side(levels[1]) };
}
export async function fetchEntropyDepth(fetchImpl: FetchLike, coin: string, signal: AbortSignal, now: () => number): Promise<DepthSnapshot> {
  return depthSnapshot(parseL2Levels(await readJson(fetchImpl, ENTROPY_ENDPOINTS.info, signal, 400_000, {}, { type: 'l2Book', coin })), now());
}
/**
 * 把快照里的价格冲击（成交均价相对最优价的距离）套到对齐时刻的一档价上。冲击比一档价变化慢得多，
 * 这样 Var 报价时刻的一档与一分钟内的深度结合，不必为每个市场长期订阅增量盘口。
 */
export function depthAt(snapshot: DepthSnapshot | null | undefined, top: { bid: number; ask: number }, t: number): { bid1k: number | null; ask1k: number | null; bid100k: number | null; ask100k: number | null } | null {
  if (!snapshot || Math.abs(snapshot.at - t) > DEPTH_MAX_GAP_MS) return null;
  const bid = (value: number | null) => value === null ? null : top.bid - Math.max(0, snapshot.bid - value);
  const ask = (value: number | null) => value === null ? null : top.ask + Math.max(0, value - snapshot.ask);
  return { bid1k: bid(snapshot.bid1k), ask1k: ask(snapshot.ask1k), bid100k: bid(snapshot.bid100k), ask100k: ask(snapshot.ask100k) };
}

// ---- Lighter WebSocket ----
export interface SocketLike {
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}
export type Connect = (url: string) => SocketLike;

export interface TopPoint { at: number; bid: number; ask: number; mark: number | null; index: number | null; funding: number | null }
interface Segment { start: number; end: number | null }

/** 历史保留时长：覆盖 Var 报价的最大可用年龄（maxQuoteAgeSec 上限 600 秒）再留余量。 */
const HISTORY_MS = 12 * 60_000;
/** market_stats/all 只推变化的字段；定期重订阅拿一次全量快照，确认未变化的市场。 */
export const STATS_REFRESH_MS = 60_000;
/** 一档状态最近一次确认（变化或快照）距对齐时刻不超过这个值才可用。 */
export const TOP_MAX_AGE_MS = STATS_REFRESH_MS + 15_000;
/** 这么久没有任何消息就认为连接已断，主动重连。 */
const SILENCE_MS = 20_000;
/** 发起连接后这么久还没连上就放弃重连。 */
export const CONNECT_TIMEOUT_MS = 20_000;
/** 断线不超过这么久再续上，「一档连续可用」的起点不重新计（与 Var 拉取失败的口径一致）。 */
export const STREAM_GAP_MS = 3 * 60_000;
const PING_MS = 25_000;
const LIVE_SLACK_MS = 5_000;
const decimal = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.length > 40 || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** 按美元金额吃单的成交均价；深度不足返回 null。levels 已按最优到最差排好。 */
export function vwap(levels: readonly (readonly [number, number])[], notional: number): number | null {
  let quote = 0, base = 0;
  for (const [price, size] of levels) {
    const value = price * size;
    if (quote + value >= notional) { base += (notional - quote) / price; return notional / base; }
    quote += value; base += size;
  }
  return null;
}

function lastAtOrBefore<T extends { at: number }>(points: readonly T[], t: number): T | null {
  let low = 0, high = points.length;
  while (low < high) { const middle = (low + high) >>> 1; if (points[middle].at <= t) low = middle + 1; else high = middle; }
  return low ? points[low - 1] : null;
}
function prune<T extends { at: number }>(points: T[], cutoff: number): void {
  let index = 0;
  while (index < points.length - 1 && points[index + 1].at < cutoff) index++;
  if (index) points.splice(0, index);
}

/** 行情流的共同接口（Lighter 两个场所与 Entropy）：按市场编号回看某一时刻的一档。 */
export interface LiveStream {
  readonly venueName: string;
  readonly running: boolean;
  start(): void;
  close(): void;
  status(markets: number): StreamStatus;
  healthySince(): number | null;
  topAt(marketId: number, t: number): TopPoint | null;
}

export interface StreamStatus {
  connected: boolean; connectedAt: number | null; lastMessageAt: number | null; reconnects: number; lastError: string | null;
  /** 目录里的市场数。 */ markets: number;
  /** 本次启动以来收到的消息文本字节数（解压后；实测线上流量约为它的 1/4.5）与开始计数的时刻。 */ bytes: number; bytesSince: number | null;
}

/**
 * 一个 Lighter 场所的只读行情流：订阅 market_stats/all 拿全市场一档、标记价、指数价与资金费。
 * 首个快照开一个连续区间，断线或长时间沉默结束区间；区间外的时刻不对齐，避免拿断线前的旧价当当时的行情。
 */
export class LighterStream implements LiveStream {
  private socket: SocketLike | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private retry: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private attempt = 0;
  private readonly top = new Map<number, TopPoint[]>();
  private readonly current = new Map<number, Omit<TopPoint, 'at'>>();
  /** 一档数据的有效区间：快照（subscribed）开始，断线或沉默结束。 */
  private readonly topSegments: Segment[] = [];
  private since: number | null = null;
  private state: Omit<StreamStatus, 'markets'> = { connected: false, connectedAt: null, lastMessageAt: null, reconnects: 0, lastError: null, bytes: 0, bytesSince: null };
  private lastPing: number | null = null;
  private lastRefresh: number | null = null;
  /** 本次连接发起的时刻；握手迟迟不完成也不报错时按它超时重连。 */
  private connectingAt: number | null = null;

  private readonly options: { url?: string; venue?: Venue; connect: Connect; now?: () => number; log?: (line: string) => void };
  constructor(options: { url?: string; venue?: Venue; connect: Connect; now?: () => number; log?: (line: string) => void }) { this.options = options; }
  private now(): number { return (this.options.now ?? Date.now)(); }
  get venueName(): string { return VENUE_NAMES[this.options.venue ?? 'rh']; }
  get running(): boolean { return !this.closed && (this.socket !== null || this.retry !== null); }

  start(): void {
    if (this.socket || this.closed) return;
    let socket: SocketLike;
    try { socket = this.options.connect(this.options.url ?? LIGHTER_ENDPOINTS[this.options.venue ?? 'rh'].stream); } catch (error) { this.fail(error); return; }
    this.socket = socket;
    this.connectingAt = this.now();
    this.state.bytesSince ??= this.now();
    socket.onopen = () => {
      this.state.connected = true; this.state.connectedAt = this.now(); this.state.lastMessageAt = this.now();
      this.send({ type: 'subscribe', channel: 'market_stats/all' });
    };
    socket.onmessage = event => { try { this.receive(event.data); } catch (error) { this.state.lastError = error instanceof Error ? error.message : String(error); } };
    socket.onerror = event => { this.state.lastError = (object(event)?.message as string | undefined) ?? 'WebSocket 错误'; };
    socket.onclose = () => { if (this.socket === socket) this.drop('连接关闭'); };
    const timer = setInterval(() => this.tick(), 1_000);
    timer.unref?.();
    this.timers.push(timer);
  }

  close(): void {
    this.closed = true;
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    this.drop(null);
  }

  status(markets: number): StreamStatus { return { ...this.state, markets }; }

  /** 一档连续可用的起点：断线或还没收到快照时为 null；断线不超过 STREAM_GAP_MS 再续上的沿用之前的起点。 */
  healthySince(): number | null { return this.topSegments.at(-1)?.end === null ? this.since : null; }

  /** t 时刻有效的一档状态：t 落在某个连续区间内，且该区间内最近一次确认不早于 TOP_MAX_AGE_MS。 */
  topAt(marketId: number, t: number): TopPoint | null {
    const segment = this.segmentAt(this.topSegments, t);
    if (!segment) return null;
    const point = lastAtOrBefore(this.top.get(marketId) ?? [], t);
    return point && point.at >= segment.start && t - point.at <= TOP_MAX_AGE_MS ? point : null;
  }

  /** 仍在进行的区间以最近一条消息再加 LIVE_SLACK_MS 为止（Var 报价时刻可能略晚于 Lighter 最近一条消息）。 */
  private segmentAt(segments: readonly Segment[], t: number): Segment | null {
    const live = this.state.lastMessageAt;
    for (let index = segments.length - 1; index >= 0; index--) {
      const segment = segments[index];
      const end = segment.end ?? (live === null ? segment.start : Math.max(live, segment.start) + LIVE_SLACK_MS);
      if (segment.start <= t && t <= end) return segment;
    }
    return null;
  }

  private send(message: unknown): void {
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(message));
  }

  private tick(): void {
    const now = this.now();
    if (this.state.connected && this.state.lastMessageAt !== null && now - this.state.lastMessageAt > SILENCE_MS) { this.drop('长时间没有消息'); return; }
    if (!this.state.connected && this.socket && this.connectingAt !== null && now - this.connectingAt > CONNECT_TIMEOUT_MS) { this.drop('连接超时'); return; }
    if (this.state.connected && now - (this.lastPing ?? 0) >= PING_MS) { this.lastPing = now; this.send({ type: 'ping' }); }
    if (this.state.connected && now - (this.lastRefresh ?? now) >= STATS_REFRESH_MS) {
      this.lastRefresh = now;
      this.send({ type: 'unsubscribe', channel: 'market_stats/all' });
      this.send({ type: 'subscribe', channel: 'market_stats/all' });
    }
    const cutoff = now - HISTORY_MS;
    for (const points of this.top.values()) prune(points, cutoff);
    while (this.topSegments.length > 1 && (this.topSegments[0].end ?? now) < cutoff) this.topSegments.shift();
  }

  private receive(data: unknown): void {
    if (typeof data !== 'string') return;
    const now = this.now();
    this.state.lastMessageAt = now;
    this.state.bytes += data.length;
    const message = object(JSON.parse(data));
    if (!message) return;
    const type = message.type, channel = typeof message.channel === 'string' ? message.channel : '';
    if (type === 'ping') { this.send({ type: 'pong' }); return; }
    if (type === 'error' || object(message.error)) { this.state.lastError = JSON.stringify(message).slice(0, 200); return; }
    if ((type === 'subscribed/market_stats' || type === 'update/market_stats') && channel === 'market_stats:all') {
      if (type === 'subscribed/market_stats') {
        // 快照之后的状态才可用；首个快照开新区间，定期重订阅的快照延续当前区间。
        const last = this.topSegments.at(-1);
        if (!last || last.end !== null) {
          if (!last || now - last.end! > STREAM_GAP_MS) this.since = now;
          this.topSegments.push({ start: now, end: null });
        }
        this.lastRefresh = now;
        this.attempt = 0;
      }
      if (!this.topSegments.length || this.topSegments.at(-1)!.end !== null) return;
      const stats = object(message.market_stats);
      if (!stats) return;
      for (const raw of Object.values(stats)) this.mergeTop(object(raw), now, type === 'subscribed/market_stats');
    }
  }

  private mergeTop(item: Record<string, unknown> | null, now: number, snapshot: boolean): void {
    if (!item || !Number.isSafeInteger(item.market_id)) return;
    const id = item.market_id as number;
    const previous = this.current.get(id);
    const field = (key: string) => key in item ? decimal(item[key]) : undefined;
    const rate = field('current_funding_rate');
    const next = {
      bid: field('best_bid_price') ?? previous?.bid ?? 0, ask: field('best_ask_price') ?? previous?.ask ?? 0,
      mark: field('mark_price') ?? previous?.mark ?? null, index: field('index_price') ?? previous?.index ?? null,
      funding: rate === undefined ? previous?.funding ?? null : rate === null ? null : rate / 100,
    };
    this.current.set(id, next);
    const changed = !previous || previous.bid !== next.bid || previous.ask !== next.ask || previous.mark !== next.mark || previous.index !== next.index || previous.funding !== next.funding;
    if (!(next.bid > 0 && next.ask >= next.bid)) return;
    if (changed || snapshot) {
      const points = this.top.get(id) ?? [];
      points.push({ at: now, ...next });
      this.top.set(id, points);
    }
  }

  private drop(reason: string | null): void {
    const now = this.now();
    const socket = this.socket;
    this.socket = null;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    if (this.state.connected || socket) {
      const last = this.topSegments.at(-1);
      if (last && last.end === null) last.end = this.state.lastMessageAt ?? now;
      this.current.clear();
    }
    this.state.connected = false;
    this.lastRefresh = null;
    if (socket) { socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null; try { socket.close(); } catch { /* 已关闭 */ } }
    if (reason) { this.state.lastError = reason; this.state.reconnects++; }
    if (!this.closed && reason !== null) this.schedule();
  }
  private fail(error: unknown): void {
    this.state.lastError = error instanceof Error ? error.message : String(error);
    this.schedule();
  }
  private schedule(): void {
    if (this.retry || this.closed) return;
    const delay = Math.min(60_000, 1_000 * 2 ** Math.min(this.attempt++, 6));
    this.retry = setTimeout(() => { this.retry = null; this.start(); }, delay);
    this.retry.unref?.();
  }
}

// ---- Entropy（Hyperliquid）WebSocket ----
/** Hyperliquid 的 bbo 只在最优价变化时推送；这么久没有变化的市场用一次 l2Book 查询（WebSocket post）确认当前一档。 */
export const ENTROPY_CONFIRM_MS = 50_000;
/** 每分钟最多发这么多次确认查询（l2Book 权重 2，IP 每分钟 1200 权重，留足余量给目录与快照）。 */
const ENTROPY_CONFIRM_PER_MIN = 60;
const ENTROPY_PING_MS = 15_000;
/** Hyperliquid 空闲连接 60 秒断开；每 15 秒 ping 一次，45 秒没有任何消息就重连。 */
const ENTROPY_SILENCE_MS = 45_000;

/**
 * Entropy 的只读行情流：订阅配对用到的每个 `io:` 市场的 bbo（最优买卖价）。标记价、预言机价与资金费不在流里，
 * 由每分钟的目录请求补上。连上后第一条消息开一个连续区间，断线或沉默结束区间（与 LighterStream 同样的对齐规则）。
 */
export class HyperliquidStream implements LiveStream {
  private socket: SocketLike | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private retry: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private attempt = 0;
  private readonly top = new Map<number, TopPoint[]>();
  private readonly segments: Segment[] = [];
  private since: number | null = null;
  private state: Omit<StreamStatus, 'markets'> = { connected: false, connectedAt: null, lastMessageAt: null, reconnects: 0, lastError: null, bytes: 0, bytesSince: null };
  private connectingAt: number | null = null;
  private lastPing: number | null = null;
  /** 订阅的市场：编号 → 完整代码（io:AAPL）。 */
  private coins = new Map<number, string>();
  private readonly byCoin = new Map<string, number>();
  private readonly subscribed = new Set<string>();
  private readonly confirmAt = new Map<number, number>();
  private confirms: number[] = [];
  private postId = 0;
  private readonly posts = new Map<number, number>();
  private readonly options: { url?: string; connect: Connect; now?: () => number; log?: (line: string) => void };
  constructor(options: { url?: string; connect: Connect; now?: () => number; log?: (line: string) => void }) { this.options = options; }
  private now(): number { return (this.options.now ?? Date.now)(); }
  get venueName(): string { return VENUE_NAMES.entropy; }
  get running(): boolean { return !this.closed && (this.socket !== null || this.retry !== null); }
  get marketCount(): number { return this.coins.size; }

  /** 更新要订阅的市场；新加的立即订阅，去掉的退订（历史保留到过期）。 */
  setMarkets(markets: ReadonlyMap<number, string>): void {
    this.coins = new Map(markets);
    this.byCoin.clear();
    for (const [id, coin] of markets) this.byCoin.set(coin, id);
    if (!this.state.connected) return;
    for (const coin of [...this.subscribed]) if (!this.byCoin.has(coin)) { this.send({ method: 'unsubscribe', subscription: { type: 'bbo', coin } }); this.subscribed.delete(coin); }
    for (const coin of this.byCoin.keys()) if (!this.subscribed.has(coin)) { this.send({ method: 'subscribe', subscription: { type: 'bbo', coin } }); this.subscribed.add(coin); }
  }

  start(): void {
    if (this.socket || this.closed) return;
    let socket: SocketLike;
    try { socket = this.options.connect(this.options.url ?? ENTROPY_ENDPOINTS.stream); } catch (error) { this.fail(error); return; }
    this.socket = socket;
    this.connectingAt = this.now();
    this.state.bytesSince ??= this.now();
    socket.onopen = () => {
      this.state.connected = true; this.state.connectedAt = this.now(); this.state.lastMessageAt = this.now();
      this.subscribed.clear();
      this.setMarkets(this.coins);
    };
    socket.onmessage = event => { try { this.receive(event.data); } catch (error) { this.state.lastError = error instanceof Error ? error.message : String(error); } };
    socket.onerror = event => { this.state.lastError = (object(event)?.message as string | undefined) ?? 'WebSocket 错误'; };
    socket.onclose = () => { if (this.socket === socket) this.drop('连接关闭'); };
    const timer = setInterval(() => this.tick(), 1_000);
    timer.unref?.();
    this.timers.push(timer);
  }
  close(): void {
    this.closed = true;
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    this.drop(null);
  }
  status(markets: number): StreamStatus { return { ...this.state, markets }; }
  healthySince(): number | null { return this.segments.at(-1)?.end === null ? this.since : null; }
  topAt(marketId: number, t: number): TopPoint | null {
    const live = this.state.lastMessageAt;
    let segment: Segment | null = null;
    for (let index = this.segments.length - 1; index >= 0 && !segment; index--) {
      const item = this.segments[index], end = item.end ?? (live === null ? item.start : Math.max(live, item.start) + LIVE_SLACK_MS);
      if (item.start <= t && t <= end) segment = item;
    }
    if (!segment) return null;
    const point = lastAtOrBefore(this.top.get(marketId) ?? [], t);
    return point && point.at >= segment.start && t - point.at <= TOP_MAX_AGE_MS ? point : null;
  }

  private send(message: unknown): void {
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(message));
  }
  /** 测试用：按当前时刻跑一次定时检查。 */
  tick(): void {
    const now = this.now();
    if (this.state.connected && this.state.lastMessageAt !== null && now - this.state.lastMessageAt > ENTROPY_SILENCE_MS) { this.drop('长时间没有消息'); return; }
    if (!this.state.connected && this.socket && this.connectingAt !== null && now - this.connectingAt > CONNECT_TIMEOUT_MS) { this.drop('连接超时'); return; }
    if (!this.state.connected) return;
    if (now - (this.lastPing ?? 0) >= ENTROPY_PING_MS) { this.lastPing = now; this.send({ method: 'ping' }); }
    // 长时间没变化（或刚连上还没有一档）的市场发一次 l2Book 确认，每个市场每分钟最多一次，总数限流。
    this.confirms = this.confirms.filter(at => now - at < 60_000);
    const segmentStart = this.segments.at(-1)?.end === null ? this.segments.at(-1)!.start : Infinity;
    for (const [id, coin] of this.coins) {
      if (this.confirms.length >= ENTROPY_CONFIRM_PER_MIN) break;
      const last = this.top.get(id)?.at(-1)?.at ?? -Infinity, asked = this.confirmAt.get(id) ?? -Infinity;
      if ((last >= segmentStart && now - last < ENTROPY_CONFIRM_MS) || now - asked < 60_000) continue;
      this.confirmAt.set(id, now); this.confirms.push(now);
      const postId = ++this.postId;
      this.posts.set(postId, id);
      this.send({ method: 'post', id: postId, request: { type: 'info', payload: { type: 'l2Book', coin } } });
    }
    if (this.posts.size > 500) this.posts.clear();
    const cutoff = now - HISTORY_MS;
    for (const points of this.top.values()) prune(points, cutoff);
    while (this.segments.length > 1 && (this.segments[0].end ?? now) < cutoff) this.segments.shift();
  }
  private receive(data: unknown): void {
    if (typeof data !== 'string') return;
    const now = this.now();
    this.state.lastMessageAt = now;
    this.state.bytes += data.length;
    // 连上后第一条消息开区间（断线不超过 STREAM_GAP_MS 续上的沿用之前的起点）。
    const last = this.segments.at(-1);
    if (!last || last.end !== null) {
      if (!last || now - last.end! > STREAM_GAP_MS) this.since = now;
      this.segments.push({ start: now, end: null });
      this.attempt = 0;
    }
    const message = object(JSON.parse(data));
    if (!message) return;
    const channel = message.channel, payload = object(message.data);
    if (channel === 'error') { this.state.lastError = String(message.data).slice(0, 200); return; }
    if (channel === 'bbo' && payload) {
      const id = typeof payload.coin === 'string' ? this.byCoin.get(payload.coin) : undefined, bbo = payload.bbo;
      if (id === undefined || !Array.isArray(bbo)) return;
      this.record(id, now, decimal(object(bbo[0])?.px), decimal(object(bbo[1])?.px));
      return;
    }
    if (channel === 'post' && payload) {
      const id = typeof payload.id === 'number' ? this.posts.get(payload.id) : undefined;
      if (id === undefined) return;
      this.posts.delete(payload.id as number);
      const response = object(payload.response);
      if (response?.type === 'error') { this.state.lastError = String(response.payload).slice(0, 200); return; }
      const book = object(object(response?.payload)?.data);
      if (!book) return;
      try {
        const levels = parseL2Levels(book);
        this.record(id, now, levels.bids[0]?.[0] ?? null, levels.asks[0]?.[0] ?? null);
      } catch { /* 格式不对的回应跳过 */ }
    }
  }
  private record(id: number, now: number, bid: number | null, ask: number | null): void {
    if (bid === null || ask === null || !(bid > 0 && ask >= bid)) return;
    const points = this.top.get(id) ?? [];
    points.push({ at: now, bid, ask, mark: null, index: null, funding: null });
    this.top.set(id, points);
  }
  private drop(reason: string | null): void {
    const now = this.now(), socket = this.socket;
    this.socket = null;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    if (this.state.connected || socket) {
      const last = this.segments.at(-1);
      if (last && last.end === null) last.end = this.state.lastMessageAt ?? now;
    }
    this.state.connected = false;
    this.subscribed.clear(); this.posts.clear(); this.confirmAt.clear();
    if (socket) { socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null; try { socket.close(); } catch { /* 已关闭 */ } }
    if (reason) { this.state.lastError = reason; this.state.reconnects++; }
    if (!this.closed && reason !== null) this.schedule();
  }
  private fail(error: unknown): void {
    this.state.lastError = error instanceof Error ? error.message : String(error);
    this.schedule();
  }
  private schedule(): void {
    if (this.retry || this.closed) return;
    const delay = Math.min(60_000, 1_000 * 2 ** Math.min(this.attempt++, 6));
    this.retry = setTimeout(() => { this.retry = null; this.start(); }, delay);
    this.retry.unref?.();
  }
}
