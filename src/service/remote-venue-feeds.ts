import type { MarketClient } from '../market/ipc.ts';
import type { CandleRange } from '../vendor/crossex/candle-reader.mjs';
import { fields, fixedUnits, ondoName, publicIdentity, timestamp, unpackBook } from '../market/venue-protocol.ts';
import { createOndoClient, type OndoClient, type OndoDepth, type OndoRules } from '../vendor/ondo/client.mjs';
import { decimalUnits } from '../vendor/ondo/decimal.mjs';
import { sample } from '../vendor/ondo/latency.mjs';
import { createOndoStream, type OndoBook, type OndoStreamFactory, type OndoStreamOptions, type OndoTopStream, type OndoTopStreamOptions } from '../vendor/ondo/stream.mjs';
import { AppError, validateBooks } from '../vendor/crossex/model.mjs';
import type { TerminalFeed } from '../vendor/crossex/terminal-feed.mjs';

/** Signed REST stays on the executor. Observation/reward clients only need these two public reads. */
export function remoteOndoClient(market: MarketClient, options?: Parameters<typeof createOndoClient>[0]): OndoClient {
  const account = options?.credentials ? createOndoClient(options) : null, stopped = new AbortController();
  const signal = (caller?: AbortSignal) => AbortSignal.any([stopped.signal, AbortSignal.timeout(5500), ...(caller ? [caller] : [])]);
  return { ...account, cooldownUntil: () => account?.cooldownUntil() ?? 0,
    async markets(caller) {
      const rows = await market.call<unknown>('ondo.markets', {}, signal(caller)), rules = new Map<string, OndoRules>();
      if (!Array.isArray(rows) || rows.length > 4096) throw new Error('Ondo 合约目录无效');
      for (const row of rows) {
        if (!Array.isArray(row) || row.length !== 2) throw new Error('Ondo 合约目录无效');
        const name = ondoName(row[0]), r = fields(row[1], ['tick', 'step', 'trading', 'makerFee']);
        if (rules.has(name) || typeof r.trading !== 'boolean' || typeof r.tick !== 'string' || decimalUnits(r.tick) <= 0n
          || typeof r.step !== 'string' || decimalUnits(r.step) <= 0n || !(r.makerFee === null || typeof r.makerFee === 'string')) throw new Error('Ondo 合约规则无效');
        if (r.makerFee !== null) decimalUnits(r.makerFee);
        rules.set(name, { trading: r.trading, tick: r.tick, step: r.step, makerFee: r.makerFee });
      }
      return rules;
    },
    async depth(name, levels = 100, caller) {
      const result = await market.call<OndoDepth>('ondo.depth', { market: name, levels }, signal(caller));
      if (result?.market !== name) throw new Error('Ondo 盘口市场不符');
      return result;
    },
    close() { stopped.abort(); account?.close(); },
  };
}

/** Joins two independent lifetimes. A public outage invalidates every book while the private socket still receives fills. */
export function remoteOndoStream(market: MarketClient, options: OndoStreamOptions, privateFactory: OndoStreamFactory = createOndoStream) {
  const { markets, onBook, onTrade, onDown, latency, now = Date.now, depth = 50 } = options;
  const observing = !options.credentials && !!onTrade;
  const wanted = new Set(markets), previousSource = new Map<string, number>(), obsoleteThrough = new Map<string, number>();
  let generation: string | null = null, lease: string | null = null, since = 0, lastAt: number | null = null, closed = false;
  let error: string | null = null, unsubscribe: (() => void) | undefined;
  let clockOffset: number | undefined;
  const account = options.credentials ? privateFactory({ ...options, privateOnly: true, markets: [], onBook() {}, onTrade: undefined }) : null;
  const ready = () => !!generation && lease !== null && market.epoch() === lease;
  function down() {
    if (closed || !generation && error) return;
    generation = null; lease = null; error = 'public_feed_down'; lastAt = null; clockOffset = undefined;
    for (const [name, at] of previousSource) obsoleteThrough.set(name, at);
    sample(latency?.down); onDown?.('public_feed_down');
  }
  function data(value: unknown) {
    if (closed || !value || typeof value !== 'object' || Array.isArray(value)) return;
    const msg = value as Record<string, unknown>;
    if (msg.type === 'ready') {
      if (typeof msg.generation !== 'string' || !/^[a-f0-9-]{36}$/.test(msg.generation) || !timestamp(msg.at) || msg.at < since || msg.at > now() + 1000) return;
      if (generation && msg.generation !== generation) down();
      generation = msg.generation; lease = market.epoch(); since = msg.at; error = null; return;
    }
    if (msg.type === 'down') { if (msg.generation === generation) down(); return; }
    if (!ready() || msg.generation !== generation) return;
    const received = now();
    if (msg.type === 'book') {
      if (typeof msg.market !== 'string' || !wanted.has(msg.market)) return;
      const name = msg.market, at = msg.at;
      let book = null;
      if (timestamp(at) && at >= since && at <= received && received - at <= 1500) {
        try { book = unpackBook(msg.book, depth); } catch { /* A malformed snapshot revokes protection immediately. */ }
        if (book && book.time <= (obsoleteThrough.get(name) ?? 0)) {
          // Replayed depth from before a disconnect must not close a newer observation interval.
          if (observing) return;
          book = null;
        }
        if (book && (!observing && book.time < (previousSource.get(name) ?? 0)
          || book.time > at + 1500 || received - book.time > 10000)) book = null;
      }
      if (book && timestamp(at)) {
        previousSource.set(name, Math.max(previousSource.get(name) ?? 0, book.time));
        // Observation replays even an empty side at its venue time alongside trades that can arrive out of order.
        if (observing || book.bids.length && book.asks.length) {
          lastAt = Math.max(lastAt ?? 0, at);
          onBook(name, book, at);
          return;
        }
      }
      // A fresh empty side proves the previous depth disappeared at this venue time, even across reconnects.
      obsoleteThrough.set(name, previousSource.get(name) ?? 0);
      onBook(name, null, received);
      return;
    }
    if (msg.type === 'missed') {
      if (Number.isInteger(msg.count) && Number(msg.count) > 0 && Number(msg.count) <= 1024) sample(latency?.missedPings, Number(msg.count));
      return;
    }
    if (!timestamp(msg.at) || msg.at < since || msg.at > now() + 1000) return;
    const at = msg.at;
    if (msg.type === 'rtt') {
      const end = sample(latency?.stamp);
      if (end && typeof msg.ms === 'number' && Number.isFinite(msg.ms) && msg.ms >= 0 && msg.ms <= 15000) {
        sample(latency?.elapsed, null, 'wsRtt', { wall: end.wall - msg.ms, mono: end.mono - msg.ms }, end);
      }
      return;
    }
    if (typeof msg.market !== 'string' || !wanted.has(msg.market) || at < received - 1500) return;
    const name = msg.market;
    lastAt = Math.max(lastAt ?? 0, at);
    if (msg.type === 'bbo') {
      const stamp = sample(latency?.stamp);
      if (stamp && timestamp(msg.sourceAt) && typeof msg.mono === 'number' && Number.isFinite(msg.mono)) {
        // Each market's complete BBO is sampled once per upstream frame. Both ends keep their own monotonic clocks.
        clockOffset ??= stamp.mono - msg.mono;
        sample(latency?.book, name, msg.sourceAt, { wall: at, mono: msg.mono + clockOffset });
      }
    } else if (msg.type === 'trade' && onTrade) {
      try {
        const t = fields(msg.trade, ['id', 'price', 'time', 'aggressorSide']);
        if (typeof t.id !== 'string' || !t.id || t.id.length > 256 || !timestamp(t.time) || !['buy', 'sell'].includes(String(t.aggressorSide))) return;
        onTrade(name, { id: t.id, time: t.time, price: fixedUnits(t.price), aggressorSide: t.aggressorSide as 'buy' | 'sell' }, at);
      } catch { /* Invalid public print cannot count as a touch. */ }
    }
  }
  return {
    start() {
      if (closed || unsubscribe) return;
      if (markets.length) unsubscribe = market.stream('ondo.public', { markets, depth, trades: !!onTrade, ...(latency ? { metrics: true } : {}) }, { data, down });
      account?.start();
    },
    status() {
      const a = account?.status();
      return { connected: ready() && (!a || a.connected), publicReady: ready(), privateReady: a?.privateReady ?? false,
        deadManReady: a?.deadManReady ?? false, lastFrameAt: Math.max(a?.lastFrameAt ?? 0, lastAt ?? 0) || null, error: a?.error ?? error };
    },
    expireOrders(confirmedClear: () => boolean) { account?.expireOrders?.(confirmedClear); },
    close() { closed = true; generation = null; unsubscribe?.(); account?.close(); },
  };
}

/** Optional early cancellation feed. Neither its prices nor its connection state enter the depth or account stream. */
export function remoteOndoTopStream(market: MarketClient, { markets, onTop, onReady, onDown, onState, now = Date.now }: OndoTopStreamOptions): OndoTopStream {
  const wanted = new Set(markets), latest = new Map<string, { source: number; at: number }>();
  let generation: string | null = null, lease: string | null = null, since = 0, lastAt: number | null = null;
  let closed = false, steady = false, error: string | null = null, unsubscribe: (() => void) | undefined;
  function down() {
    if (closed || !lease) return;
    lease = null; lastAt = null; error = 'public_feed_down';
    const wasSteady = steady; steady = false;
    sample(onDown);
    if (wasSteady) sample(onState, false);
  }
  function data(value: unknown) {
    if (closed || !value || typeof value !== 'object' || Array.isArray(value)) return;
    const msg = value as Record<string, unknown>, epoch = market.epoch(), received = now();
    if (lease !== epoch) down();
    if (!epoch) return;
    if (msg.type === 'ready') {
      if (typeof msg.generation !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(msg.generation)
        || msg.generation === generation || !timestamp(msg.at) || msg.at <= since || msg.at > received) return;
      down(); generation = msg.generation; lease = epoch; since = msg.at; lastAt = since; error = null;
      onReady?.(since);
      return;
    }
    if (lease !== epoch || msg.generation !== generation) return;
    if (msg.type === 'down') { down(); return; }
    if (msg.type === 'steady') {
      if (!steady) { steady = true; sample(onState, true); }
      return;
    }
    if (msg.type !== 'top' || typeof msg.market !== 'string' || !wanted.has(msg.market)
      || !timestamp(msg.at) || msg.at < since || msg.at > received || received - msg.at > 1500) return;
    let book: OndoBook;
    try { book = unpackBook(msg.book, 1); } catch { return; }
    const previous = latest.get(msg.market);
    // Keep the source watermark across upstream and IPC reconnects. Empty sides carry the venue's loss of protection.
    if (book.time > msg.at + 1500 || received - book.time > 1500
      || previous && (book.time <= previous.source || msg.at < previous.at)) return;
    latest.set(msg.market, { source: book.time, at: msg.at }); lastAt = Math.max(lastAt ?? 0, msg.at);
    onTop(msg.market, book, msg.at);
  }
  return {
    start() { if (!closed && !unsubscribe) unsubscribe = market.stream('ondo.top', { markets }, { data, down }); },
    status() {
      const ready = lease !== null && lease === market.epoch();
      return { connected: ready, ready, lastFrameAt: ready ? lastAt : null, error };
    },
    close() { if (!closed) { closed = true; lease = null; unsubscribe?.(); } },
  };
}

export function remoteCrossexReaders(market: MarketClient) {
  const stopped = new AbortController();
  const signal = () => AbortSignal.any([stopped.signal, AbortSignal.timeout(25_000)]);
  const previousBooks = new Map<string, { lease: string; at: number }>();
  const call = <T>(op: string, input: unknown, request?: AbortSignal) => market.call<T>(op, input, request ? AbortSignal.any([request, signal()]) : signal()).catch(error => {
    const status = typeof error?.status === 'number' && error.status >= 400 && error.status <= 599 ? error.status : 503;
    throw new AppError('CrossEx 公开行情读取失败', status);
  });
  const depth = (op: string) => async (quote: Record<string, unknown>) => {
    const lease = market.epoch();
    const book = await call<Record<string, unknown>>(op, { quote: publicIdentity(quote) });
    if (!lease || market.epoch() !== lease || !book || ['exchange', 'symbol', 'base', 'quoteCurrency'].some(key => book[key] !== quote[key])) throw new AppError('CrossEx 深度连接或合约身份已变化', 503);
    const at = Date.now(), key = JSON.stringify([quote.exchange, quote.symbol]), previous = previousBooks.get(key);
    validateBooks([book, book], at);
    if (typeof book.at !== 'number' || previous && (book.at < previous.at || lease !== previous.lease && book.at === previous.at)) throw new AppError('CrossEx 深度来源时间回退或重复', 503);
    if (previousBooks.size >= 256 && !previous) {
      for (const [name, seen] of previousBooks) if (seen.at + 10000 < at) previousBooks.delete(name);
      if (previousBooks.size >= 256) throw new AppError('CrossEx 行情查询繁忙', 429);
    }
    previousBooks.set(key, { at: book.at, lease });
    return { ...book, at: book.at, isCurrent: () => market.epoch() === lease };
  };
  const publicFeed: TerminalFeed = {
    subscribe(symbol, listener) {
      return market.stream('crossex.terminal', { symbol }, { down: listener.down, data(value) {
        if (!value || typeof value !== 'object') return;
        const msg = value as Record<string, unknown>;
        if (msg.type === 'down') listener.down();
        else if (msg.type === 'frame') listener.data(msg.frame);
      } });
    },
    close() { stopped.abort(); },
  };
  const manualDepthReader = depth('crossex.manualDepth');
  return {
    marketOptions: { depthReader: depth('crossex.depth'), manualDepthReader,
      currentFundingReader: (quote: Record<string, unknown>) => call('crossex.currentFunding', { quote: publicIdentity(quote) }) },
    terminalOptions: { publicFeed, depthReader: manualDepthReader,
      candleReader: (quote: Record<string, unknown>, interval: string, request?: AbortSignal, range?: CandleRange) =>
        call('crossex.candles', { quote: publicIdentity(quote), interval, ...range }, request) },
  };
}
