import { externalQuoteStale, type ExchangeQuote } from '../../src/vendor/exchange-comparison.mjs';
import { fundingLegStale, type ExchangeFundingHistory } from '../../src/vendor/exchange-funding-history.mjs';
import { FUNDING_SCHEDULE, type FundingHistory, type FundingMarket } from './monitor-funding.ts';
import type { DisplayRetention, ResourceSnapshot } from './live-resource.ts';

type QuoteStatus = { status: 'live' | 'snapshot'; staleAfterMs: number; lastError: string | null };
type MainQuote = QuoteStatus & { fetchedAt: string; errors?: Record<string, string> };

/** Retain the collector's deadline and errors alongside the validated prices. */
export function quoteStatus(input: unknown): QuoteStatus {
  const value = input as Partial<QuoteStatus>;
  return { status: value.status === 'live' ? 'live' : 'snapshot',
    staleAfterMs: typeof value.staleAfterMs === 'number' && Number.isFinite(value.staleAfterMs) && value.staleAfterMs > 0 ? value.staleAfterMs : 0,
    lastError: typeof value.lastError === 'string' && value.lastError ? value.lastError : null };
}

export const mainQuoteRetention: DisplayRetention<MainQuote> = {
  fresh(quote, now) {
    const at = Date.parse(quote.fetchedAt);
    return quote.status === 'live' && !quote.lastError && !Object.keys(quote.errors ?? {}).length && at <= now && now < at + quote.staleAfterMs;
  },
};

/** Show the source time on every price. Unconfirmed or expiring prices must not read as live during the next poll. */
export function quoteIsCurrent(live: ResourceSnapshot<MainQuote>, intervalMs: number, now = Date.now()) {
  const quote = live.data;
  return !!quote && !live.cached && live.status === 'ready' && mainQuoteRetention.fresh(quote, now) && now + intervalMs <= Date.parse(quote.fetchedAt) + quote.staleAfterMs;
}

export const exchangeQuoteRetention: DisplayRetention<ExchangeQuote> = {
  fresh: (quote, now) => !quote.fundingError && quote.fundingFetchedAt !== null && Date.parse(quote.fetchedAt) <= now
    && Date.parse(quote.fundingFetchedAt) <= now && !externalQuoteStale(quote, now),
};

export function displayExchangeQuote(live: ResourceSnapshot<ExchangeQuote>): ExchangeQuote | null {
  const quote = live.data;
  if (quote?.exchange === 'variational' && quote.timestampBasis === 'source' && (live.status !== 'ready' || live.error)) return null;
  return quote;
}

const settled = (market: FundingMarket): DisplayRetention<FundingHistory> => ({
  history: true,
  fresh(history, now) {
    const at = Date.parse(history.fetchedAt), interval = FUNDING_SCHEDULE[market].intervalMs;
    return history.status === 'live' && history.complete && !history.lastError && at <= now && Math.floor(at / interval) === Math.floor(now / interval);
  },
});
export const fundingRetention = { oil: settled('oil'), hynix: settled('hynix') };

export const exchangeHistoryRetention: DisplayRetention<ExchangeFundingHistory> = {
  history: true,
  fresh: (history, now) => history.status === 'live' && !history.reason && Date.parse(history.fetchedAt) <= now
    && [history.left, history.right].every(leg => leg.fetchedAt !== null && !leg.error && !fundingLegStale(leg, now)),
};
