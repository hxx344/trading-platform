import { randomUUID } from 'node:crypto';
import type { MarketOperations } from './protocol.ts';
import { checkIdentity, depthLimit, fields, ondoName, packBook, timestamp } from './venue-protocol.ts';
import { createOndoClient } from '../vendor/ondo/client.mjs';
import { decimalUnits } from '../vendor/ondo/decimal.mjs';
import { createOndoStream, createOndoTopStream, type OndoBook } from '../vendor/ondo/stream.mjs';
import { createPublicClients } from '../vendor/crossex/clients.mjs';
import { createFundingClient } from '../vendor/crossex/funding-client.mjs';
import { createCandleReader } from '../vendor/crossex/candle-reader.mjs';
import { INTERVALS, TERMINAL_SYMBOL } from '../vendor/crossex/terminal-data.mjs';
import { createTerminalFeed } from '../vendor/crossex/terminal-feed.mjs';

interface VenueReaders {
  ondo?: ReturnType<typeof createOndoClient>;
  ondoStream?: typeof createOndoStream;
  ondoTopStream?: typeof createOndoTopStream;
  depth?: Pick<ReturnType<typeof createPublicClients>, 'loadManualDepth' | 'loadDepth'>;
  funding?: ReturnType<typeof createFundingClient>;
  candles?: ReturnType<typeof createCandleReader>;
  terminal?: ReturnType<typeof createTerminalFeed>;
  resolveLighter?: (symbol: string, signal: AbortSignal) => Promise<unknown>;
}

/** Public collection only. No account files, API credentials, URL input or trading transports are accepted. */
export function createVenueFeeds(readers: VenueReaders = {}): MarketOperations {
  const stopped = new AbortController();
  const fetcher: typeof fetch = (url, init) => fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([stopped.signal, init.signal]) : stopped.signal });
  const ondo = readers.ondo ?? createOndoClient({ fetchImpl: fetcher, rps: 2, timeoutMs: 5000 });
  const ondoStream = readers.ondoStream ?? createOndoStream;
  const ondoTopStream = readers.ondoTopStream ?? createOndoTopStream;
  const clients = createPublicClients({ fetcher, signal: stopped.signal });
  const depths = readers.depth ?? clients, funding = readers.funding ?? createFundingClient({ fetcher, signal: stopped.signal });
  const candles = readers.candles ?? createCandleReader({ fetcher }), terminal = readers.terminal ?? createTerminalFeed();
  const subscriptions = new Set<() => void>();
  async function checkLighterMarket(q: Record<string, unknown>, signal: AbortSignal) {
    if (q.exchange !== 'lighter') return;
    // These feeds can return a market ID alone. Verify its native symbol before using the channel or candle endpoint.
    const resolved = await (readers.resolveLighter ?? clients.resolveManualQuote)(String(q.crossexSymbol), signal);
    const native = resolved as Record<string, unknown> | null;
    if (!native || native.symbol !== q.symbol || native.marketId !== q.marketId) throw new Error('Lighter 行情合约身份已变化');
  }
  async function read(op: string, input: unknown, signal: AbortSignal) {
    if (op === 'ondo.markets') {
      fields(input, []);
      const rules = await ondo.markets(signal);
      if (rules.size > 4096) throw new Error('Ondo 合约目录过大');
      return [...rules];
    }
    if (op === 'ondo.depth') {
      const p = fields(input, ['market', 'levels']), name = ondoName(p.market), limit = depthLimit(p.levels);
      const depth = await ondo.depth(name, limit, signal);
      if (depth.market !== name || !timestamp(typeof depth.time === 'string' && depth.time.length <= 48 ? Date.parse(depth.time) : depth.time)) throw new Error('Ondo 盘口无效');
      const side = (rows: unknown) => {
        if (!Array.isArray(rows) || rows.length > limit) throw new Error('Ondo 盘口档数无效');
        return rows.map(row => {
          if (!Array.isArray(row) || row.length < 2) throw new Error('Ondo 盘口格式无效');
          return row.slice(0, 2).map(value => {
            if (!['string', 'number'].includes(typeof value) || decimalUnits(String(value)) <= 0n) throw new Error('Ondo 盘口数量或价格无效');
            return String(value);
          });
        });
      };
      return { market: name, time: depth.time, bids: side(depth.bids), asks: side(depth.asks) };
    }
    if (op === 'crossex.depth' || op === 'crossex.manualDepth') {
      const p = fields(input, ['quote']), manual = op === 'crossex.manualDepth';
      const quote = checkIdentity(p.quote, manual ? 'manual' : 'comparable');
      return manual ? depths.loadManualDepth(quote, signal) : depths.loadDepth(quote, signal);
    }
    if (op === 'crossex.candles') {
      const p = fields(input, ['quote', 'interval']), quote = checkIdentity(p.quote, 'manual');
      if (typeof p.interval !== 'string' || !Object.hasOwn(INTERVALS, p.interval)) throw new Error('不支持的 K 线周期');
      await checkLighterMarket(quote, signal);
      return candles(quote, p.interval, signal);
    }
    if (op === 'crossex.currentFunding') {
      const p = fields(input, ['quote']), quote = checkIdentity(p.quote, 'either');
      await checkLighterMarket(quote, signal);
      return funding.current(quote, signal);
    }
    if (op === 'crossex.fundingHistory') {
      const p = fields(input, ['quote', 'from', 'to']), quote = checkIdentity(p.quote, 'comparable');
      if (!timestamp(p.from) || !timestamp(p.to) || p.from < 1e12 || p.from > p.to || p.to > Date.now()
        || p.to - p.from > 366 * 86_400_000) throw new Error('公开资金费时间区间无效');
      return funding.read(quote, p.from, p.to, signal);
    }
    throw new Error('未知公开行情操作');
  }
  return {
    async call(op, input, signal) {
      const active = AbortSignal.any([signal, stopped.signal]);
      active.throwIfAborted();
      const result = await read(op, input, active);
      active.throwIfAborted();
      return result;
    },
    stream(op, input, emit, signal) {
      signal.throwIfAborted(); stopped.signal.throwIfAborted();
      const send = (value: unknown) => { if (!signal.aborted && !stopped.signal.aborted) emit(value); };
      let release: () => void;
      if (op === 'ondo.public' || op === 'ondo.top') {
        const top = op === 'ondo.top', p = fields(input, top ? ['markets'] : ['markets', 'depth', 'trades', 'metrics']);
        if (!Array.isArray(p.markets) || !p.markets.length || p.markets.length > 40 || new Set(p.markets).size !== p.markets.length) throw new Error('Ondo 订阅无效');
        if (!top && (typeof p.trades !== 'boolean' || p.metrics !== undefined && typeof p.metrics !== 'boolean')) throw new Error('Ondo 订阅无效');
        const markets = p.markets.map(ondoName);
        let generation: string | null = null;
        const ready = (at: number) => { generation = randomUUID(); send({ type: 'ready', generation, at }); };
        const down = () => { send({ type: 'down', generation }); generation = null; };
        const snapshot = (market: string, book: OndoBook | null, at: number) => {
          if (generation) send({ type: top ? 'top' : 'book', generation, market, at, book: book ? packBook(book, top ? 1 : undefined) : null });
        };
        const stream = top ? ondoTopStream({ markets, onReady: ready, onDown: down, onTop: snapshot,
          onState(steady) { if (steady && generation) send({ type: 'steady', generation }); },
        }) : ondoStream({ markets, depth: depthLimit(p.depth), onPublicReady: ready, onBook: snapshot, onDown: down,
          ...(p.trades ? { onTrade(market, trade, at) {
            if (generation) send({ type: 'trade', generation, market, at, trade: { ...trade, price: trade.price.toString() } });
          } } : {}),
          ...(p.metrics ? {
            latency: {
              stamp: () => ({ wall: Date.now(), mono: performance.now() }), down() {},
              book(market, sourceAt, stamp) {
                if (generation) send({ type: 'bbo', generation, market, at: stamp.wall, mono: stamp.mono, sourceAt });
              },
              missedPings(count) { if (generation && p.trades) send({ type: 'missed', generation, count }); },
              elapsed(_market, metric, start, end) {
                if (generation && p.trades && metric === 'wsRtt' && start && end) send({ type: 'rtt', generation, ms: end.mono - start.mono, at: end.wall });
              },
            },
          } : {}),
        });
        release = () => stream.close();
        stream.start();
      } else if (op === 'crossex.terminal') {
        const p = fields(input, ['symbol']);
        if (typeof p.symbol !== 'string' || !TERMINAL_SYMBOL.test(p.symbol)) throw new Error('CrossEx 订阅合约无效');
        release = terminal.subscribe(p.symbol, { data(frame) { send({ type: 'frame', frame }); }, down() { send({ type: 'down' }); } });
      } else throw new Error('未知公开行情订阅');
      function stop() {
        signal.removeEventListener('abort', stop); subscriptions.delete(stop); release();
      }
      subscriptions.add(stop); signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted || stopped.signal.aborted) stop();
    },
    close() {
      stopped.abort();
      for (const stop of subscriptions) stop();
      terminal.close(); ondo.close();
    },
  };
}
