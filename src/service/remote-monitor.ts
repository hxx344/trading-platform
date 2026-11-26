// Execution-side public data adapters. Page projections, resume checkpoints, paper positions and tokens remain local.
import type { MarketClient } from '../market/ipc.ts';
import type { MarketReaders } from '../monitor/market-readers.ts';
import type { HynixQuoteView } from '../monitor/hynix.ts';
import type { FeedEvent, SubscribeFeed } from '../monitor/perpetual-feed.ts';
import { unwrapMarketRead, type MarketRead, type MetricBatch, type FundamentalRow } from '../monitor/market-contract.ts';
import type { Exchange, ExchangeQuote, SpreadMarket } from '../vendor/exchange-comparison.mjs';
import type { ReadFundingLeg } from '../monitor/funding-archive.ts';
import { variationalRequestError, type VariationalPublicFunding } from '../vendor/variational-market.mjs';
import { createPerpetualEstimates } from '../vendor/perpetual-estimates.mjs';
import { perpetualPriceIdentity, type PerpetualQuote } from '../vendor/perpetual-stream.mjs';
import type { PerpetualExecutionService } from '../vendor/perpetual-depth.mjs';
import type { FundamentalsClient } from '../vendor/perpetual-fundamentals.mjs';
import { collectBitgetPages } from '../vendor/perpetual-funding-pages.ts';
import type { PerpetualFundingReader } from '../vendor/perpetual-funding-reader.mjs';
import { perpetualMetricsCacheKeys } from '../vendor/perpetual-metrics-reader.mjs';
import { perpetualMetricsIdentity, type PerpetualMarketMetricsServiceOptions } from '../vendor/perpetual-market-metrics-service.mjs';
import type { PositioningFetch } from '../vendor/perpetual-positioning.mjs';
import type { PerpetualPriceReader } from '../vendor/perpetual-price-reader.mjs';
import type { PerpetualMarket } from '../vendor/perpetual-stream.mjs';

export interface RemoteComparison {
  quote(market: SpreadMarket, exchange: Exchange, hynix: HynixQuoteView | null, signal: AbortSignal): Promise<ExchangeQuote>;
  history: ReadFundingLeg;
  variationalMarks(signal: AbortSignal): Promise<ExchangeQuote>;
  variationalFunding(signal: AbortSignal): Promise<VariationalPublicFunding>;
}
export interface RemotePerpetual {
  subscribe: SubscribeFeed;
  epoch(): string | null;
  execution: (getQuote: (exchange: string, symbol: string) => PerpetualQuote | undefined) => Pick<PerpetualExecutionService, 'depth' | 'exit' | 'fx' | 'stop'>;
  metrics: NonNullable<PerpetualMarketMetricsServiceOptions['reader']>;
  funding: PerpetualFundingReader;
  price: PerpetualPriceReader;
  fundamentals: FundamentalsClient;
  positioning: PositioningFetch;
}
const contract = (market: PerpetualMarket) => ({ exchange: market.exchange, symbol: market.symbol, identity: perpetualPriceIdentity(market) });

export function createRemoteMonitor(client: MarketClient, clock: () => number = Date.now) {
  async function read<T>(name: string, input: unknown, signal?: AbortSignal): Promise<T> {
    return unwrapMarketRead(await client.call<MarketRead<T>>('monitor.' + name, input, signal));
  }
  async function readAnthropic<T>(name: 'quote' | 'candles', input: unknown, signal: AbortSignal): Promise<T> {
    const reply = await client.call<MarketRead<T>>('monitor.anthropic.ANTUSDT.' + name, input, signal);
    // v0.91.0 及更早的行情服务只认旧操作。采集端仍按回包中的 binanceSymbol 核对计价口径。
    if (!reply.ok && reply.error.message === '未知公开行情操作') return read('anthropic.' + name, input, signal);
    return unwrapMarketRead(reply);
  }
  const history: ReadFundingLeg = (market, exchange, side, range, signal) => read('exchange.historyLeg', { market, exchange, side, range }, signal);
  const rounds: MarketReaders = {
    epoch: () => client.epoch(),
    anthropicQuote: signal => readAnthropic('quote', null, signal),
    anthropicCandles: (starts, at, signal, ends) => readAnthropic('candles', { starts, at, ends }, signal),
    oilQuote: signal => read('oil.quote', null, signal),
    oilCandles: (start, end, signal) => read('oil.candles', { start, end }, signal),
    oilFunding: (side, range, signal) => history('oil', 'binance', side, range, signal),
    goldOilQuote: signal => read('goldoil.quote', null, signal),
    goldOilListing: signal => read('goldoil.listing', null, signal),
    goldOilCandles: (start, end, signal) => read('goldoil.candles', { start, end }, signal),
    hynixQuote: signal => read('hynix.quote', null, signal),
    hynixCandles: (start, at, signal, end) => read('hynix.candles', { start, at, end }, signal),
    hynixFunding: (side, range, signal) => history('hynix', 'hyperliquid', side, range, signal),
  };
  const comparison: RemoteComparison = {
    quote: (market, exchange, hynix, signal) => read('exchange.quote', { market, exchange, hynix }, signal),
    history,
    variationalMarks: signal => read('variational.marks', null, signal),
    async variationalFunding(signal) {
      try { return await read<VariationalPublicFunding>('variational.funding', null, signal); }
      catch (error) {
        if (signal.aborted && signal.reason?.name === 'TimeoutError') throw variationalRequestError(signal.reason);
        throw error;
      }
    },
  };
  // A batch ticker read warms other registered contracts. Carry the worker's actual expiry back to the scheduler.
  const cached = new Map<string, number>(), retries = new Map<string, number>();
  const metrics: RemotePerpetual['metrics'] = Object.assign(async (market: PerpetualMarket, { signal, readerState }: { signal: AbortSignal; readerState?: unknown }) => {
    const batch = await read<MetricBatch>('perpetual.metrics', { ...contract(market), identity: perpetualMetricsIdentity(market), readerState }, signal);
    retries.set(market.exchange, batch.retryAt);
    for (const [key, expires] of batch.cached) cached.set(key, expires);
    if (cached.size > 800) for (const [key, expires] of cached) if (expires <= clock() || cached.size > 800) cached.delete(key);
    return unwrapMarketRead(batch.reading);
  }, {
    retryAt: (market: PerpetualMarket) => retries.get(market.exchange) ?? 0,
    isCached(market: PerpetualMarket) {
      const now = clock(), keys = perpetualMetricsCacheKeys(market, now);
      return keys.length > 0 && keys.every(key => (cached.get(key) ?? 0) > now);
    },
    stop() { cached.clear(); retries.clear(); },
  });
  const assets = new Map<string, FundamentalRow>();
  const perpetual: RemotePerpetual = {
    epoch: () => client.epoch(),
    subscribe: (receive, down) => client.stream('monitor.perpetual.quotes', null, {
      data: value => receive(value as FeedEvent),
      down() { cached.clear(); down(); },
    }),
    execution(getQuote) {
      const stop = new AbortController();
      return {
        ...createPerpetualEstimates({ getQuote, clock,
          books: legs => read('perpetual.books', { legs: legs.map(({ exchange, symbol, historyIdentity }) => ({ exchange, symbol, identity: historyIdentity })) }, stop.signal),
          fx: () => read('perpetual.fx', null, stop.signal),
        }),
        stop: () => stop.abort(),
      };
    },
    metrics,
    async funding(market, range, options) {
      const input = { ...contract(market), range };
      if (market.exchange !== 'bitget') return read('perpetual.funding', input, options?.signal);
      return collectBitgetPages(range, cursor => read('perpetual.fundingPage', { ...input, cursor }, options?.signal), options?.onProgress);
    },
    price: (market, range, options) => read('perpetual.price', { ...contract(market), range }, options?.signal),
    fundamentals: {
      async refresh(bases, options) {
        const rows = await read<FundamentalRow[]>('perpetual.fundamentals', { bases }, options?.signal);
        assets.clear();
        for (const row of rows) assets.set(row.description.base, row);
      },
      get(base) { const row = assets.get(base); return row && row.expiresAt > clock() ? row.value : null; },
      describe(base) {
        const row = assets.get(base);
        if (!row) return { base, coinId: null, status: 'pending', reason: '等待基本面数据' };
        if (row.description.status === 'ready' && row.expiresAt <= clock()) return { ...row.description, status: 'stale', reason: '基本面缓存已过期' };
        return row.description;
      },
    },
    positioning: (quote, options) => read('perpetual.positioning', { exchange: quote.exchange, symbol: quote.symbol, identity: quote.historyIdentity }, options?.signal),
  };
  return { rounds, perpetual, comparison };
}
