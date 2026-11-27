import { applyBitgetDepth, bitgetBookBids, type BitgetDepth } from './bitget-book.ts';
import { isObject } from '../contracts.ts';
import { CHAIN_ARB_CLOCK_SKEW_MS, CHAIN_ARB_TTL_MS } from './model.ts';

export type BitgetSocketFactory = (url: string) => WebSocket;
export type BitgetMarket = 'spot' | 'perp';

type Row = Record<string, unknown>;
type Observation = { bids: [string, string][]; reference: unknown; at: number };
type Pending = {
  error?: Error;
  depth?: BitgetDepth;
  ticker?: { reference: unknown; at: number };
};
type Arg = { symbol: string; instType: string; topic: string };
type Request = { args: Arg[]; receive: (arg: Row, msg: Row) => void; finish: (error: Error) => void };
const invalid = () => new Error('Bitget 未收到有效且连续的完整行情快照');
const limited = () => Object.assign(new Error('Bitget 公开行情请求受限'), { status: 429 });

export function bitgetTimestamp(value: unknown, now: number, ttl = CHAIN_ARB_TTL_MS): number {
  const at = typeof value === 'string' && /^\d{13}$/.test(value) ? Number(value) : value;
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at <= 0 || at > now + CHAIN_ARB_CLOCK_SKEW_MS || now - at >= ttl) {
    throw new Error('Bitget 行情已过期或时间异常');
  }
  return at;
}

function observe(state: Pending, market: BitgetMarket, arg: Row, msg: Row, now: number): void {
  if (msg.event !== undefined || !Array.isArray(msg.data) || msg.data.length !== 1 || !isObject(msg.data[0])) throw invalid();
  const row = msg.data[0], pushAt = bitgetTimestamp(msg.ts, now);
  if (row.symbol !== undefined && row.symbol !== arg.symbol || row.instType !== undefined && row.instType !== arg.instType) throw invalid();
  // v3 ticker carries the exchange timestamp in the envelope. Depth also has a matching-engine timestamp.
  if (arg.topic === 'ticker' && msg.action === 'snapshot') {
    const at = row.ts === undefined ? pushAt : Math.min(pushAt, bitgetTimestamp(row.ts, now));
    if (state.ticker && at < state.ticker.at) throw invalid();
    state.ticker = { reference: market === 'spot' ? row.lastPrice : row.markPrice, at };
  } else if (arg.topic === 'books') {
    const sourceAt = bitgetTimestamp(row.ts, now);
    state.depth = applyBitgetDepth(state.depth, msg.action, row, Math.min(pushAt, sourceAt), sourceAt);
  } else throw invalid();
}

export function createBitgetSnapshots(now: () => number, makeSocket: BitgetSocketFactory = url => new WebSocket(url)) {
  const clients = new Set<ReturnType<typeof connect>>(), attempts: number[] = [];
  let closed = false, blockedUntil = 0;
  function connect() {
    const start = performance.now();
    while (attempts.length && attempts[0] <= start - 300_000) attempts.shift();
    if (clients.size >= 8) [...clients].find(item => item.idle())?.disconnect();
    if (clients.size >= 8 || attempts.length >= 240) throw limited();
    attempts.push(start);
    const socket = makeSocket('wss://ws.bitget.com/v3/ws/public');
    const used = new Set<string>(), requests = new Map<string, Request>(), sent = new Map<string, Arg[]>();
    let nextControl = 0, timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = setTimeout(() => disconnect(), 25_000);
    expiry.unref();
    function disconnect(error = new Error('Bitget 公开行情连接断开')) {
      if (!clients.delete(client)) return;
      clearTimeout(timer); clearTimeout(expiry);
      for (const request of requests.values()) request.finish(error);
      requests.clear(); sent.clear();
      socket.onmessage = socket.onopen = socket.onclose = socket.onerror = null;
      socket.close();
    }
    function flush() {
      if (!clients.has(client) || socket.readyState !== 1 || timer) return;
      const remove = [...sent.keys()].filter(key => !requests.has(key));
      const symbols = remove.length ? remove : [...requests.keys()].filter(key => !sent.has(key));
      if (!symbols.length) return;
      const delay = Math.ceil(nextControl - performance.now());
      if (delay > 0) { timer = setTimeout(() => { timer = undefined; flush(); }, delay); return; }
      const args = symbols.flatMap(key => {
        if (remove.length) { const previous = sent.get(key)!; sent.delete(key); return previous; }
        const topics = requests.get(key)!.args; sent.set(key, topics); return topics;
      });
      nextControl = performance.now() + 200;
      try { socket.send(JSON.stringify({ op: remove.length ? 'unsubscribe' : 'subscribe', args })); } catch { disconnect(); }
      flush();
    }
    // Never resubscribe a symbol on this socket: a late push from a previous subscription cannot fulfill a later review.
    // Rotate before the first 30s heartbeat. Up to eight distinct symbols (32 topics) share one handshake.
    const client = {
      idle: () => requests.size === 0,
      accepts: (symbol: string) => used.size < 8 && !used.has(symbol) && performance.now() - start < 18_000,
      add(symbol: string, request: Request) { used.add(symbol); requests.set(symbol, request); flush(); },
      remove(symbol: string) {
        requests.delete(symbol);
        if (!requests.size && (used.size === 8 || socket.readyState !== 1)) disconnect();
        else flush();
      },
      disconnect,
    };
    clients.add(client);
    socket.onopen = flush;
    socket.onerror = socket.onclose = () => disconnect();
    socket.onmessage = ({ data }) => {
      try {
        if (typeof data !== 'string' || data.length > 512 * 1024 || Buffer.byteLength(data) > 512 * 1024) throw invalid();
        const msg: unknown = JSON.parse(data, (_key, value, context?: { source?: string }) =>
          typeof value === 'number' && context?.source && (!Number.isSafeInteger(value) || /[.eE]/.test(context.source)) ? context.source : value);
        if (!isObject(msg)) throw invalid();
        if (msg.event === 'error' && ['429', '30006', '30007'].includes(String(msg.code))) {
          blockedUntil = performance.now() + 60_000;
          for (const item of clients) item.disconnect(limited());
          return;
        }
        const arg = msg.arg;
        if (!isObject(arg) || typeof arg.symbol !== 'string' || !used.has(arg.symbol)) throw invalid();
        if (msg.event === 'subscribe' || msg.event === 'unsubscribe') return;
        if (sent.has(arg.symbol)) requests.get(arg.symbol)?.receive(arg, msg);
      } catch { disconnect(invalid()); }
    };
    return client;
  }
  return {
    async read(symbol: string, markets: BitgetMarket[], signal: AbortSignal) {
      signal.throwIfAborted();
      if (closed) throw invalid();
      if (performance.now() < blockedUntil) throw limited();
      const client = [...clients].find(item => item.accepts(symbol)) ?? connect();
      const states = new Map<BitgetMarket, Pending>(markets.map(market => [market, {}]));
      let wake!: () => void;
      const done = new Promise<void>(resolve => { wake = resolve; });
      function finish(error: Error) {
        for (const state of states.values()) state.error = error;
        wake();
      }
      const abort = () => finish(invalid());
      const timeout = setTimeout(() => {
        for (const state of states.values()) {
          if (!state.error && (!state.ticker || !state.depth)) state.error = new Error('Bitget 公开行情响应超时');
        }
        wake();
      }, 5500);
      signal.addEventListener('abort', abort, { once: true });
      try {
        const args = markets.flatMap(market => ['books', 'ticker'].map(topic => ({ symbol, instType: market === 'spot' ? 'spot' : 'usdt-futures', topic })));
        client.add(symbol, { args, finish, receive(arg, msg) {
          const market = arg.instType === 'spot' ? 'spot' : arg.instType === 'usdt-futures' ? 'perp' : undefined;
          if (!market || !states.has(market)) { finish(invalid()); return; }
          const state = states.get(market)!;
          if (state.error) return;
          try { observe(state, market, arg, msg, now()); }
          catch (error) { state.error = error instanceof Error ? error : invalid(); }
          // Keep consuming updates for a ready market until every requested market has reached the same read boundary.
          if ([...states.values()].every(s => s.error || s.ticker && s.depth)) wake();
        } });
        await done;
        signal.throwIfAborted();
        const results = new Map<BitgetMarket, Observation | Error>();
        for (const [market, state] of states) {
          const { depth, ticker } = state;
          if (state.error || !ticker || !depth?.levels.size) { results.set(market, state.error ?? invalid()); continue; }
          try {
            const at = bitgetTimestamp(Math.min(depth.at, ticker.at), now());
            results.set(market, { bids: bitgetBookBids(depth), reference: ticker.reference, at });
          } catch (error) { results.set(market, error instanceof Error ? error : invalid()); }
        }
        return results;
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
        client.remove(symbol);
      }
    },
    close() { closed = true; for (const client of clients) client.disconnect(); },
  };
}
