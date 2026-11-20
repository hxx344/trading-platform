import { externalQuoteStale, type ExchangeQuote } from '../../src/vendor/exchange-comparison.mjs';
import { fundingLegStale, type ExchangeFundingHistory } from '../../src/vendor/exchange-funding-history.mjs';
import { FUNDING_SCHEDULE, type FundingHistory, type FundingMarket } from './monitor-funding.ts';
import type { DisplayRetention, ResourceSnapshot } from './live-resource.ts';
import { ApiError } from './api.ts';

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

export function monitorReadError(error: Error | null, hasData: boolean, fallback: string): string {
  if (!error || !hasData && error instanceof ApiError && error.status === 503 && error.code === 'not_ready') return '';
  return /[一-鿿]/.test(error.message) ? error.message : fallback;
}

export function mainQuoteDisplay(live: ResourceSnapshot<MainQuote>, intervalMs: number) {
  const quote = live.data;
  const current = quoteIsCurrent(live, intervalMs);
  const failure = monitorReadError(live.error, quote !== null, '实时报价读取失败');
  const retry = `每 ${intervalMs / 1000} 秒自动重试`;
  if (!quote) {
    if (live.status === 'offline') return { current, label: '网络离线 · 恢复连接后更新报价', notice: '' };
    if (live.error instanceof ApiError && live.error.status === 401) return { current, label: '请重新登录以读取报价', notice: '' };
    if (failure) return { current, label: `实时报价暂不可用 · ${retry}`, notice: failure };
    return { current, label: live.error ? `等待后台首次报价 · ${retry}` : '正在获取实时报价', notice: '' };
  }
  const notice = failure || quote.lastError || (quote.status === 'snapshot' ? '后台尚未取得新报价，显示上次保存的数据。' : '');
  const label = notice ? '实时更新中断 · 上次获取' : current ? '实时报价 · 获取于' : '上次报价 · 采集于';
  return { current, label, notice };
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
