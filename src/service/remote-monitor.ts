// Execution-side public data adapters. Page projections, resume checkpoints, paper positions and tokens remain local.
import type { MarketClient } from '../market/ipc.ts';
import type { MarketReaders } from '../monitor/market-readers.ts';
import type { HynixQuoteView } from '../monitor/hynix.ts';
import type { FeedEvent, SubscribeFeed } from '../monitor/perpetual-feed.ts';
import { unwrapMarketRead, type MarketRead, type FundingBatch, type MetricBatch, type FundamentalRow } from '../monitor/market-contract.ts';
import type { Exchange, ExchangeQuote, SpreadMarket } from '../vendor/exchange-comparison.mjs';
import type { ExchangeFundingHistory } from '../vendor/exchange-funding-history.mjs';
import type { VariationalPublicFunding } from '../vendor/variational-market.mjs';
import { createPerpetualEstimates } from '../vendor/perpetual-estimates.mjs';
import { perpetualPriceIdentity, type PerpetualQuote } from '../vendor/perpetual-stream.mjs';
import type { PerpetualExecutionService } from '../vendor/perpetual-depth.mjs';
import type { FundamentalsClient } from '../vendor/perpetual-fundamentals.mjs';
import type { PerpetualFundingReader } from '../vendor/perpetual-funding-reader.mjs';
import { perpetualMetricsCacheKeys } from '../vendor/perpetual-metrics-reader.mjs';
import { perpetualMetricsIdentity, type PerpetualMarketMetricsServiceOptions } from '../vendor/perpetual-market-metrics-service.mjs';
import type { PositioningFetch } from '../vendor/perpetual-positioning.mjs';
import type { PerpetualPriceReader } from '../vendor/perpetual-price-reader.mjs';
import type { PerpetualMarket } from '../vendor/perpetual-stream.mjs';

export interface RemoteComparison {
  quote(market: SpreadMarket, exchange: Exchange, hynix: HynixQuoteView | null, signal: AbortSignal): Promise<ExchangeQuote>;
  history(market: SpreadMarket, exchange: Exchange, signal: AbortSignal): Promise<ExchangeFundingHistory>;
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
  const rounds: MarketReaders = {
    epoch: () => client.epoch(),
    anthropicQuote: signal => read('anthropic.quote', null, signal),
    anthropicCandles: (starts, at, signal) => read('anthropic.candles', { starts, at }, signal),
    oilQuote: signal => read('oil.quote', null, signal),
    oilCandles: (start, at, signal) => read('oil.candles', { start, at }, signal),
    oilFunding: (start, end, at, signal) => read('oil.funding', { start, end, at }, signal),
    hynixQuote: signal => read('hynix.quote', null, signal),
    hynixCandles: (start, at, signal) => read('hynix.candles', { start, at }, signal),
    hynixFunding: (start, end, at, signal) => read('hynix.funding', { start, end, at }, signal),
  };
  const comparison: RemoteComparison = {
    quote: (market, exchange, hynix, signal) => read('exchange.quote', { market, exchange, hynix }, signal),
    history: (market, exchange, signal) => read('exchange.history', { market, exchange }, signal),
    variationalMarks: signal => read('variational.marks', null, signal),
    variationalFunding: signal => read('variational.funding', null, signal),
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
      const batch = await read<FundingBatch>('perpetual.funding', { ...contract(market), range }, options?.signal);
      // A later failing Bitget page still commits the contiguous portion the worker proved.
      if (batch.progress) options?.onProgress?.(batch.progress);
      return unwrapMarketRead(batch.records);
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
