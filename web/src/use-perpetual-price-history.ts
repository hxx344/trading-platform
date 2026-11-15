// 改写自 project-aggregation 工作台 modules/monitor/hooks/use-perpetual-price-history.ts（提交 c84ba27）。改动：地址改为
// 本服务的 /api/monitor/perpetual/price-history，读取走 api.ts（401 转登录，其它失败显示服务给的原因，再由 feed 保留已取得的
// 数据、退避重试），与 use-perpetual-funding-history.ts 同一做法；read-activity 为独立页版。
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api.ts';
import { startPerpetualPriceHistoryFeed } from './perpetual-price-history-feed.ts';
import { observeReadActivity, readsAllowed } from './read-activity.ts';
import { priceHistoryIsStale, type PerpetualPriceHistoryReport, type PriceHistoryDays } from '../../src/vendor/perpetual-price-history.ts';
import type { FundingHistoryPairRequest } from '../../src/vendor/perpetual-funding-history.ts';

export const PERPETUAL_PRICE_HISTORY_PATH = '/api/monitor/perpetual/price-history';

export function usePerpetualPriceHistory(pair: FundingHistoryPairRequest | null, days: PriceHistoryDays, enabled: boolean, onExpired: () => void) {
  const [report, setReport] = useState<PerpetualPriceHistoryReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reason, setReason] = useState('');
  const controls = useRef<ReturnType<typeof startPerpetualPriceHistoryFeed> | null>(null);
  const expired = useRef(onExpired);
  expired.current = onExpired;
  const requestKey = pair ? JSON.stringify([pair.base, pair.longKey, pair.shortKey]) : '';
  useEffect(() => {
    const feed = startPerpetualPriceHistoryFeed({
      load: async (requested, windowDays, signal) => {
        try {
          const result = await api<PerpetualPriceHistoryReport>(PERPETUAL_PRICE_HISTORY_PATH, { body: { pair: requested, days: windowDays }, signal, timeoutMs: 12_000 });
          setReason('');
          return result;
        } catch (cause) {
          if (cause instanceof ApiError && cause.status === 401) expired.current();
          setReason(cause instanceof ApiError && cause.status && cause.status !== 401 ? cause.message : '');
          throw cause;
        }
      },
      onData: setReport, onError: setError, onLoading: setLoading,
    });
    controls.current = feed;
    return () => { feed.stop(); controls.current = null; };
  }, []);
  useEffect(() => {
    const selected = requestKey ? JSON.parse(requestKey) as string[] : null;
    controls.current?.setSelection(selected ? { base: selected[0]!, longKey: selected[1]!, shortKey: selected[2]! } : null, days);
  }, [requestKey, days]);
  useEffect(() => {
    const synchronize = () => controls.current?.setActive(readsAllowed(enabled));
    const stop = observeReadActivity(synchronize, () => { synchronize(); if (readsAllowed(enabled)) controls.current?.refresh(); });
    return () => { stop(); controls.current?.setActive(false); };
  }, [enabled]);
  // The render that changes selection must already hide the previous pair,
  // before effects have had an opportunity to cancel its request.
  const selectedReport = report && pair && report.legs[pair.longKey] && report.legs[pair.shortKey]
    && JSON.parse(report.legs[pair.longKey]!.identity)[2] === pair.base ? report : null;
  const states = Object.values(selectedReport?.legs ?? {}).map(leg => leg.status);
  const status = error || states.includes('error') ? 'error' : states.includes('unsupported') ? 'unsupported' : !selectedReport || states.includes('pending') ? 'pending' : 'ready';
  const failure = error && reason ? `${reason.replace(/[。.]$/, '')}。${error}` : error;
  return { report: selectedReport, loading, error: [failure, selectedReport?.storageError].filter(Boolean).join(' '), status, isStale: Boolean(error && selectedReport) || priceHistoryIsStale(selectedReport) };
}
