// 改写自 project-aggregation 工作台 modules/monitor/hooks/use-perpetual-price-history.ts（提交 c84ba27）。改动：地址改为
// 本服务的 /api/monitor/perpetual/price-history，读取走 api.ts（401 转登录，其它失败显示服务给的原因，再由 feed 保留已取得的
// 数据、退避重试），与 use-perpetual-funding-history.ts 同一做法；read-activity 为独立页版。
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api.ts';
import { perpetualPriceCache, type ChartPriceHistory } from './perpetual-price-candles.ts';
import { startPerpetualPriceHistoryFeed } from './perpetual-price-history-feed.ts';
import { observeReadActivity, readsAllowed } from './read-activity.ts';
import { priceHistoryIsStale, type PriceHistoryDays } from '../../src/vendor/perpetual-price-history.ts';
import type { FundingHistoryPairRequest } from '../../src/vendor/perpetual-funding-history.ts';

export const PERPETUAL_PRICE_HISTORY_PATH = '/api/monitor/perpetual/price-history';

export function usePerpetualPriceHistory(pair: FundingHistoryPairRequest | null, days: PriceHistoryDays, enabled: boolean, onExpired: () => void, longIdentity: string | null | undefined, shortIdentity: string | null | undefined) {
  const [{ report, fromCache }, setData] = useState<{ report: ChartPriceHistory | null; fromCache: boolean }>({ report: null, fromCache: false });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reason, setReason] = useState('');
  const controls = useRef<ReturnType<typeof startPerpetualPriceHistoryFeed> | null>(null);
  const expired = useRef(onExpired);
  expired.current = onExpired;
  const requestKey = pair && longIdentity && shortIdentity ? JSON.stringify([pair.base, pair.longKey, pair.shortKey, longIdentity, shortIdentity]) : '';
  useEffect(() => {
    const feed = startPerpetualPriceHistoryFeed({
      cache: perpetualPriceCache,
      load: async (requested, windowDays, signal, knownBlocks) => {
        try {
          const result = await api<unknown>(PERPETUAL_PRICE_HISTORY_PATH, { body: { pair: requested, days: windowDays, knownBlocks }, signal, timeoutMs: 12_000 });
          if (!signal.aborted) setReason('');
          return result;
        } catch (cause) {
          if (!signal.aborted) {
            setReason(cause instanceof ApiError && cause.status && cause.status !== 401 ? cause.message : '');
          }
          throw cause;
        }
      },
      onData: (report, fromCache) => setData({ report, fromCache }), onError: setError, onLoading: setLoading, onExpired: () => expired.current(),
    });
    controls.current = feed;
    return () => { feed.stop(); controls.current = null; };
  }, []);
  useEffect(() => {
    const selected = requestKey ? JSON.parse(requestKey) as string[] : null;
    if (selected) {
      const [base, longKey, shortKey, longId, shortId] = selected;
      controls.current?.setSelection({ base, longKey, shortKey }, days, { [longKey]: longId, [shortKey]: shortId });
    } else controls.current?.setSelection(null, days);
  }, [requestKey, days]);
  useEffect(() => {
    const synchronize = () => controls.current?.setActive(readsAllowed(enabled));
    const stop = observeReadActivity(synchronize, () => { synchronize(); if (readsAllowed(enabled)) controls.current?.refresh(); });
    return () => { stop(); controls.current?.setActive(false); };
  }, [enabled]);
  // The render that changes selection must already hide the previous pair,
  // before effects have had an opportunity to cancel its request.
  const selectedReport = report && pair && longIdentity && shortIdentity && Object.values(report.legs).every(leg =>
    (leg.key === pair.longKey && leg.identity === longIdentity) || (leg.key === pair.shortKey && leg.identity === shortIdentity)) ? report : null;
  const states = Object.values(selectedReport?.legs ?? {}).map(leg => leg.status);
  const status = error || states.includes('error') ? 'error' : states.includes('unsupported') ? 'unsupported' : !selectedReport || states.includes('pending') ? 'pending' : 'ready';
  const failure = error && reason ? `${reason.replace(/[。.]$/, '')}。${error}` : error;
  return { report: selectedReport, fromCache: Boolean(selectedReport && fromCache), loading, error: [failure, selectedReport?.storageError].filter(Boolean).join(' '), status, isStale: Boolean((error || fromCache) && selectedReport) || priceHistoryIsStale(selectedReport) };
}
