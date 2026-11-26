import { isObject } from '../contracts.ts';
import { CHAIN_ARB_CLOCK_SKEW_MS, CHAIN_ARB_TTL_MS } from './model.ts';

export type BinanceSocketFactory = (url: string) => WebSocket;
type Reply = { body: unknown; at: number; check: () => void };
type Waiter = { resolve: (value: unknown) => void; reject: (error: Error) => void };
type Subscription = { waiters: Set<Waiter>; latest?: Record<string, unknown> };
type SpotMethod = 'depth' | 'executionRules' | 'referencePrice' | 'avgPrice' | 'trades.recent';
const SMALL_FRAME = 256 * 1024, CATALOG_FRAME = 8 * 1024 * 1024;
const unavailable = () => new Error('币安公开行情连接已断开');
const limited = () => Object.assign(new Error('币安公开行情请求受限'), { status: 429 });

export function depthSequence(value: unknown): bigint {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return BigInt(value);
  if (typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value)) return BigInt(value);
  throw new Error('币安盘口更新序号无效');
}

// The two public request APIs and two push-stream endpoints use distinct wire protocols.
// Each opens lazily, multiplexes symbols, and owns all data and waiters for its connection.
type Throttle = { check(): void; block(status: number, retryAfter: unknown): void };
function channel(url: string, makeSocket: BinanceSocketFactory, now: () => number, throttle: Throttle) {
  let socket: WebSocket | undefined, closed = false, retryAt = 0, id = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined, controlTimer: ReturnType<typeof setTimeout> | undefined;
  let connectTimer: ReturnType<typeof setTimeout> | undefined, nextControl = 0, lastMessage = 0;
  const requests = new Map<number, Waiter & { frame: string; sent: boolean; catalog: boolean }>();
  // A cancelled caller releases its waiter immediately. Its already-sent directory request still
  // owns exactly one large response on this socket; consume the ID on receipt or disconnect.
  const catalogReplies = new Set<number>();
  const streams = new Map<string, Subscription>(), subscribed = new Set<string>(), controls = new Set<number>();

  function disconnect(error = unavailable()) {
    const old = socket;
    socket = undefined;
    clearTimeout(connectTimer); clearTimeout(idleTimer); clearTimeout(controlTimer);
    controlTimer = undefined;
    for (const waiter of requests.values()) waiter.reject(error);
    for (const stream of streams.values()) for (const waiter of stream.waiters) waiter.reject(error);
    requests.clear(); catalogReplies.clear(); streams.clear(); subscribed.clear(); controls.clear();
    if (old) {
      old.onmessage = old.onopen = old.onclose = old.onerror = null;
      old.close();
    }
  }
  function flush() {
    if (socket?.readyState !== 1) return;
    try {
      for (const [key, request] of requests) if (!request.sent) {
        if (request.catalog) {
          // Rotate a connection which has accumulated unanswered directory requests.
          if (catalogReplies.size >= 48) { disconnect(limited()); return; }
          catalogReplies.add(key);
        }
        request.sent = true;
        socket.send(request.frame);
      }
      if (controlTimer) return;
      const remove = [...subscribed].filter(key => !streams.has(key));
      const params = remove.length ? remove : [...streams.keys()].filter(key => !subscribed.has(key));
      if (!params.length) return;
      const delay = Math.max(0, nextControl - performance.now());
      if (delay) {
        controlTimer = setTimeout(() => { controlTimer = undefined; flush(); }, Math.ceil(delay));
        return;
      }
      // Batch symbol changes and leave room under Spot's 5 frames/s limit for automatic pong frames.
      nextControl = performance.now() + 400;
      for (const key of params) { if (remove.length) subscribed.delete(key); else subscribed.add(key); }
      if (controls.size >= 32) { disconnect(); return; }
      controls.add(++id);
      socket.send(JSON.stringify({ method: remove.length ? 'UNSUBSCRIBE' : 'SUBSCRIBE', params, id }));
      if (remove.length) flush();
    } catch { disconnect(); }
  }
  function connect() {
    if (closed) throw unavailable();
    throttle.check();
    if (!socket) {
      if (performance.now() < retryAt) throw limited();
      lastMessage = performance.now();
      retryAt = lastMessage + 5500;
      const current = socket = makeSocket(url);
      connectTimer = setTimeout(() => disconnect(), 5000);
      current.onopen = () => { if (socket === current) { clearTimeout(connectTimer); flush(); } };
      current.onerror = current.onclose = () => { if (socket === current) disconnect(); };
      current.onmessage = event => {
        if (socket !== current) return;
        try {
          if (typeof event.data !== 'string') throw unavailable();
          const bytes = Buffer.byteLength(event.data);
          if (bytes > CATALOG_FRAME || bytes > SMALL_FRAME && !catalogReplies.size) throw unavailable();
          const msg: unknown = JSON.parse(event.data, (_key, value, context?: { source?: string }) =>
            typeof value === 'number' && !Number.isSafeInteger(value) && context?.source ? context.source : value);
          if (!isObject(msg) || msg.e === 'serverShutdown' || isObject(msg.data) && msg.data.e === 'serverShutdown') throw unavailable();
          const catalogReply = typeof msg.id === 'number' && catalogReplies.delete(msg.id);
          if (bytes > SMALL_FRAME && !catalogReply) throw unavailable();
          if (msg.status === 429 || msg.status === 418) {
            const data = isObject(msg.error) && isObject(msg.error.data) ? msg.error.data : undefined;
            throttle.block(msg.status, data?.retryAfter ?? msg.retryAfter);
            return;
          }
          lastMessage = performance.now();
          if (typeof msg.stream === 'string') {
            const stream = streams.get(msg.stream);
            if (!stream || !subscribed.has(msg.stream)) return;
            if (!isObject(msg.data)) throw unavailable();
            // A duplicate book update cannot renew its original source timestamp. Full snapshots
            // are requested independently, so skipped diff IDs need no local-book reconstruction.
            if (stream.latest && msg.stream.endsWith('@depth@100ms')) {
              const previous = depthSequence(stream.latest.u), next = depthSequence(msg.data.u);
              if (next < previous) throw unavailable();
              if (next === previous) return;
            }
            stream.latest = msg.data;
            for (const waiter of stream.waiters) waiter.resolve(msg.data);
          } else if (typeof msg.id === 'number') {
            const request = requests.get(msg.id);
            if (request) {
              if (msg.status === 200) request.resolve(msg.result);
              else if (isObject(msg.error) && msg.status === 400 && msg.error.code === -2043) request.resolve(msg.error);
              else request.reject(new Error('币安公开行情请求失败'));
            } else if (controls.delete(msg.id) && (msg.code !== undefined || msg.error !== undefined || msg.result !== null)) {
              throw unavailable();
            }
            // A cancelled or timed-out request can still return an error. It has no other consumers.
          } else throw unavailable();
        } catch { disconnect(); }
      };
    }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => disconnect(), 30_000);
    idleTimer.unref();
    return socket;
  }
  async function observe(signal: AbortSignal, start: (waiter: Waiter) => () => void): Promise<Reply> {
    signal.throwIfAborted();
    const current = connect(), at = now();
    const check = () => { if (socket !== current) throw unavailable(); };
    let cleanup: (() => void) | undefined, abort: (() => void) | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const body = await new Promise<unknown>((resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        timeout = setTimeout(() => {
          reject(new Error('币安公开行情响应超时'));
          if (socket === current && performance.now() - lastMessage >= 6500) disconnect();
        }, 6500);
        cleanup = start({ resolve, reject });
        flush();
      });
      check();
      return { body, at, check };
    } finally {
      clearTimeout(timeout);
      cleanup?.();
      if (abort) signal.removeEventListener('abort', abort);
    }
  }
  return {
    request(method: string, params: Record<string, unknown>, signal: AbortSignal) {
      return observe(signal, waiter => {
        if (requests.size >= 48) throw limited();
        const key = ++id;
        requests.set(key, { ...waiter, frame: JSON.stringify({ id: key, method, params }), sent: false, catalog: method === 'exchangeInfo' });
        return () => { requests.delete(key); };
      });
    },
    event(key: string, signal: AbortSignal) {
      return observe(signal, waiter => {
        let stream = streams.get(key);
        if (!stream) {
          if (streams.size >= 32) {
            const unused = [...streams].find(([, item]) => !item.waiters.size);
            if (!unused) throw limited();
            streams.delete(unused[0]);
          }
          stream = { waiters: new Set() };
        }
        streams.delete(key); streams.set(key, stream);
        const time = stream.latest?.E;
        if (typeof time === 'number' && now() - time < CHAIN_ARB_TTL_MS && time - now() <= CHAIN_ARB_CLOCK_SKEW_MS) {
          waiter.resolve(stream.latest);
        } else {
          if (stream.waiters.size >= 16) throw limited();
          stream.waiters.add(waiter);
        }
        return () => { stream.waiters.delete(waiter); };
      });
    },
    suspend: () => disconnect(limited()),
    close() { closed = true; disconnect(); },
  };
}

export function createBinanceStreams(now: () => number, makeSocket: BinanceSocketFactory = url => new WebSocket(url)) {
  function group(requestUrl: string, pushUrl: string) {
    let retryAt = 0;
    const throttle: Throttle = {
      check() { if (now() < retryAt) throw limited(); },
      block(status, retryAfter) {
        const at = now();
        const fallback = status === 418 ? 120_000 : 60_000;
        const until = typeof retryAfter === 'number' && Number.isSafeInteger(retryAfter) && retryAfter > at ? retryAfter : at + fallback;
        retryAt = Math.max(retryAt, until);
        request.suspend(); push.suspend();
      },
    };
    const request = channel(requestUrl, makeSocket, now, throttle), push = channel(pushUrl, makeSocket, now, throttle);
    return { request, push, throttle };
  }
  const spotGroup = group('wss://ws-api.binance.com:443/ws-api/v3', 'wss://data-stream.binance.vision/stream');
  const perpGroup = group('wss://ws-fapi.binance.com/ws-fapi/v1', 'wss://fstream.binance.com/market/stream');
  const { request: spot, push: spotPush } = spotGroup, { request: perp, push: perpPush } = perpGroup;
  return {
    spotThrottle: spotGroup.throttle, perpThrottle: perpGroup.throttle,
    directory: (signal: AbortSignal) => spot.request('exchangeInfo', { permissions: ['SPOT'], showPermissionSets: false, symbolStatus: 'TRADING' }, signal),
    spot: (method: SpotMethod, params: { symbol: string; limit?: number }, signal: AbortSignal) => spot.request(method, params, signal),
    perpDepth: (symbol: string, limit: number, signal: AbortSignal) => perp.request('depth', { symbol, limit }, signal),
    spotEvent: (pair: string, signal: AbortSignal) => spotPush.event(pair.toLowerCase() + '@depth@100ms', signal),
    mark: (pair: string, signal: AbortSignal) => perpPush.event(pair.toLowerCase() + '@markPrice@1s', signal),
    close() { for (const client of [spot, perp, spotPush, perpPush]) client.close(); },
  };
}
