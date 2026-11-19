// Public Monitor operations. This process owns the venue sockets, abortable network reads, catalogs, rate limits and pagination.
import type { MarketOperations } from './ipc.ts';
import { createPerpetualFeed } from '../monitor/perpetual-feed.ts';
import { createMarketReaders } from '../monitor/market-readers.ts';
import { OIL_CANDLE_WINDOW_MS, marketRead } from '../monitor/market-contract.ts';
import { createExchangeReader } from '../monitor/exchanges.ts';
import { createSharedMarketReads } from '../monitor/shared-reads.ts';
import { perpetualQualityEnv } from '../monitor/quality-config.ts';
import { createVariationalFetch } from '../monitor/variational-transport.ts';
import type { PerpetualOptions } from '../monitor/perpetual.ts';
import { ANTHROPIC_LEG_KEYS, createBinanceGate, type AnthropicCandleStarts, type AnthropicFetcher } from '../vendor/anthropic-market.mjs';
import { supportsExchange, type Exchange } from '../vendor/exchange-comparison.mjs';
import { validateHynixQuote } from '../vendor/hynix-market.mjs';
import { createPerpetualExecutionService } from '../vendor/perpetual-depth.mjs';
import { createPerpetualFundingReader } from '../vendor/perpetual-funding-reader.mjs';
import { createPerpetualMetricsReader } from '../vendor/perpetual-metrics-reader.mjs';
import { perpetualMetricsIdentity } from '../vendor/perpetual-market-metrics-service.mjs';
import { perpetualPriceIdentity } from '../vendor/perpetual-stream.mjs';
import { createPerpetualPriceReader } from '../vendor/perpetual-price-reader.mjs';
import { createFundamentalsClient } from '../vendor/perpetual-fundamentals.mjs';
import { fetchPositioning } from '../vendor/perpetual-positioning.mjs';
import { readVariationalPublicFunding, type VariationalFetcher } from '../vendor/variational-market.mjs';

const DAY = 86_400_000;
function fields(input: unknown, names: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !names.includes(key))) throw new Error('公开行情请求字段无效');
  return input as Record<string, unknown>;
}
function timestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('行情时间范围无效');
  return value;
}
function none(value: unknown): void { if (value !== null) throw new Error('公开行情请求字段无效'); }

/** Tests can stand in for individual public venues without opening an account or a database. */
export function createMonitorData({ fetchImpl, now = Date.now, log = (line: string) => process.stderr.write(`${line}\n`), WebSocketImpl,
  perpetual: options = {}, variationalFetch = createVariationalFetch(), env = process.env,
}: { fetchImpl?: AnthropicFetcher; now?: () => number; log?: (line: string) => void; WebSocketImpl?: typeof WebSocket;
  perpetual?: PerpetualOptions; variationalFetch?: VariationalFetcher; env?: Record<string, string | undefined> } = {}): MarketOperations {
  const gate = createBinanceGate(), common = { now, ...(fetchImpl ? { fetchImpl } : {}) };
  const feed = createPerpetualFeed({ ...common, log, ...options });
  const stopped = new AbortController(), subscriptions = new Set<() => void>();
  // The cards, the comparison and the collector live in this process, so they share what they would each read (monitor/shared-reads.ts).
  const shared = createSharedMarketReads({ ...common, gate, quote: feed.quote, signal: stopped.signal });
  const readers = createMarketReaders({ ...common, gate, shared });
  const exchanges = createExchangeReader({ ...common, log, gate, shared, oilQuote: () => null, hynixQuote: () => null, ...(WebSocketImpl ? { WebSocketImpl } : {}) });
  const source = (fetcher = fetchImpl) => ({ clock: now, ...(fetcher ? { fetchImpl: fetcher } : {}) });
  const metric = createPerpetualMetricsReader(source(options.metrics?.fetchImpl));
  const funding = createPerpetualFundingReader({ ...source(options.fundingHistory?.fetchImpl), requestSpacingMs: 350 });
  const price = createPerpetualPriceReader({ ...source(options.priceHistory?.fetchImpl), requestSpacingMs: 350 });
  const aux = options.quality;
  const fundamentals = aux?.fundamentals ?? createFundamentalsClient({ ...source(aux?.fetchImpl), ...perpetualQualityEnv(env, log) });
  let execution: ReturnType<typeof createPerpetualExecutionService> | null = null;

  function roundTime(input: unknown): number {
    const at = timestamp(input);
    if (Math.abs(now() - at) > 180_000) throw new Error('回补轮次时间无效');
    return at;
  }
  function range(input: Record<string, unknown>, at: number) {
    const start = timestamp(input.start), end = input.end === undefined ? at : timestamp(input.end);
    if (start > end || end > at) throw new Error('回补范围无效');
    return { start, end };
  }
  function contract(p: Record<string, unknown>, identity = perpetualPriceIdentity) {
    const market = typeof p.exchange === 'string' && typeof p.symbol === 'string' ? feed.market(p.exchange, p.symbol) : undefined;
    if (!market || typeof p.identity !== 'string' || p.identity !== identity(market)) throw new Error('行情合约目录或身份已变化');
    return market;
  }
  async function read(op: string, input: unknown, signal: AbortSignal): Promise<unknown> {
    switch (op) {
      case 'monitor.anthropic.quote': none(input); return readers.anthropicQuote(signal);
      case 'monitor.oil.quote': none(input); return readers.oilQuote(signal);
      case 'monitor.hynix.quote': none(input); return readers.hynixQuote(signal);
      case 'monitor.anthropic.candles': {
        const p = fields(input, ['starts', 'at', 'ends']), at = roundTime(p.at), starts = fields(p.starts, [...ANTHROPIC_LEG_KEYS]);
        const ends = p.ends === undefined ? undefined : fields(p.ends, [...ANTHROPIC_LEG_KEYS]);
        for (const key of ANTHROPIC_LEG_KEYS) {
          const end = ends ? timestamp(ends[key]) : at;
          if (timestamp(starts[key]) > end || end > at) throw new Error('K 线回补范围无效');
        }
        return readers.anthropicCandles(starts as AnthropicCandleStarts, at, signal, ends as AnthropicCandleStarts | undefined);
      }
      case 'monitor.oil.candles': {
        const p = fields(input, ['start', 'end']), start = timestamp(p.start), end = timestamp(p.end);
        if (end <= start || end > now() || end - start > OIL_CANDLE_WINDOW_MS) throw new Error('原油 K 线回补范围无效');
        return readers.oilCandles(start, end, signal);
      }
      case 'monitor.hynix.candles': {
        const p = fields(input, ['start', 'at', 'end']), at = roundTime(p.at), { start, end } = range(p, at);
        return readers.hynixCandles(start, at, signal, p.end === undefined ? undefined : end);
      }
      case 'monitor.variational.marks': none(input); return exchanges.publicVariational();
      case 'monitor.variational.funding': none(input); return readVariationalPublicFunding({ clock: now, fetcher: variationalFetch, signal });
      case 'monitor.exchange.quote':
      case 'monitor.exchange.historyLeg': {
        const p = fields(input, op.endsWith('.quote') ? ['market', 'exchange', 'hynix'] : ['market', 'exchange', 'side', 'range']);
        if ((p.market !== 'hynix' && p.market !== 'oil') || typeof p.exchange !== 'string' || p.exchange === 'variational' || !supportsExchange(p.market, p.exchange)) throw new Error('不支持的交易所');
        const exchange = p.exchange as Exchange;
        if (op.endsWith('.historyLeg')) {
          const bounds = fields(p.range, ['from', 'to']), from = timestamp(bounds.from), to = timestamp(bounds.to);
          if ((p.side !== 'left' && p.side !== 'right') || from > to || to > now() || to - from > (p.market === 'oil' && exchange === 'binance' ? 400 : 60) * DAY) throw Error('资金费回补范围无效');
          return exchanges.rawFunding(p.market, exchange, p.side, { from, to }, signal);
        }
        const saved = p.hynix == null ? null : fields(p.hynix, ['source', 'fetchedAt', 'adr', 'ordinary', 'equivalent', 'spread', 'premium', 'status', 'staleAfterMs', 'lastAttemptAt', 'lastError']);
        const quote = saved ? { ...validateHynixQuote(saved), status: saved.status === 'live' ? 'live' as const : 'snapshot' as const } : null;
        return exchanges.quote(p.market, exchange, quote);
      }
      case 'monitor.perpetual.fx':
      case 'monitor.perpetual.books': {
        if (!execution) throw Object.assign(new Error('合约价差采集未运行'), { status: 503 });
        if (op.endsWith('.fx')) { none(input); return execution.fx(); }
        const { legs } = fields(input, ['legs']);
        if (!Array.isArray(legs) || legs.length !== 2) throw new Error('需要两个公开合约');
        const keys = legs.map(leg => {
          const key = fields(leg, ['exchange', 'symbol', 'identity']);
          if (typeof key.exchange !== 'string' || typeof key.symbol !== 'string' || typeof key.identity !== 'string') throw new Error('公开合约身份无效');
          return { exchange: key.exchange, symbol: key.symbol, identity: key.identity };
        });
        return execution.books(keys);
      }
      case 'monitor.perpetual.metrics': {
        const p = fields(input, ['exchange', 'symbol', 'identity', 'readerState']), market = contract(p, perpetualMetricsIdentity);
        const reading = await marketRead(() => metric(market, { readerState: p.readerState, signal }));
        return { reading, cached: metric.cachedUntil?.(market) ?? [], retryAt: metric.retryAt(market) };
      }
      case 'monitor.perpetual.fundingPage':
      case 'monitor.perpetual.funding':
      case 'monitor.perpetual.price': {
        const page = op.endsWith('.fundingPage'), p = fields(input, page ? ['exchange', 'symbol', 'identity', 'range', 'cursor'] : ['exchange', 'symbol', 'identity', 'range']);
        const market = contract(p), bounds = fields(p.range, ['from', 'to']);
        const window = { from: timestamp(bounds.from), to: timestamp(bounds.to) };
        if (op.endsWith('.price')) return price(market, window, { signal });
        if (!page) {
          if (market.exchange === 'bitget') throw new Error('Bitget 资金费需逐页读取');
          return funding(market, window, { signal });
        }
        const cursor = p.cursor === null ? null : fields(p.cursor, ['page', 'before']);
        return funding.bitgetPage(market, window, cursor && { page: timestamp(cursor.page), before: timestamp(cursor.before) }, { signal });
      }
      case 'monitor.perpetual.positioning': {
        const p = fields(input, ['exchange', 'symbol', 'identity']);
        const quote = typeof p.exchange === 'string' && typeof p.symbol === 'string' ? feed.quote(p.exchange, p.symbol) : null;
        if (!quote || !quote.historyIdentity || quote.historyIdentity !== p.identity) throw new Error('行情合约目录或身份已变化');
        return (aux?.positioningFetch ?? fetchPositioning)(quote, { ...source(aux?.fetchImpl), signal, now: now() });
      }
      case 'monitor.perpetual.fundamentals': {
        const { bases } = fields(input, ['bases']);
        if (!Array.isArray(bases) || bases.length > 32_768 || bases.some(base => typeof base !== 'string' || base.length > 160)) throw new Error('基本面币种列表无效');
        await fundamentals.refresh(bases, { signal });
        return bases.map(base => ({ description: fundamentals.describe(base), value: fundamentals.get(base) ?? null, expiresAt: fundamentals.expiresAt ? fundamentals.expiresAt(base) ?? 0 : now() + 30 * 60_000 }));
      }
      default: throw new Error('未知公开行情操作');
    }
  }
  return {
    async call(op, input, signal) {
      const life = AbortSignal.any([signal, stopped.signal]); life.throwIfAborted();
      const result = await marketRead(() => read(op, input, life));
      life.throwIfAborted();
      return result;
    },
    stream(op, input, emit, signal) {
      none(input);
      if (op !== 'monitor.perpetual.quotes') throw new Error('未知公开行情订阅');
      signal.throwIfAborted(); stopped.signal.throwIfAborted();
      if (!execution) execution = createPerpetualExecutionService({ ...source(), getQuote: feed.quote, getMarket: feed.market, ...options.execution });
      const release = feed.subscribe(event => { if (!signal.aborted && !stopped.signal.aborted) emit(event); });
      function end() {
        signal.removeEventListener('abort', end); subscriptions.delete(end); release();
        if (!subscriptions.size) { execution?.stop(); execution = null; metric.stop(); }
      }
      subscriptions.add(end); signal.addEventListener('abort', end, { once: true });
      if (signal.aborted || stopped.signal.aborted) end();
    },
    close() {
      stopped.abort();
      for (const end of subscriptions) end();
      exchanges.stop(); feed.close();
    },
  };
}
