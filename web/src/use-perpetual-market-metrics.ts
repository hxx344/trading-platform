// 改写自 project-aggregation 工作台 modules/monitor/hooks/use-perpetual-market-metrics.ts（提交 c84ba27）。改动：地址改为
// 本服务的 /api/monitor/perpetual/metrics，读取走 api.ts（带 x-pa-executor 的 POST；401 转登录，其它失败显示服务给的
// 原因，再由 feed 保留上次数值、60 秒后重试）；read-activity 为独立页版。
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api.ts';
import { marketMetricsRequestKey, startPerpetualMarketMetricsFeed } from './perpetual-market-metrics-feed.ts';
import { observeReadActivity, readsAllowed } from './read-activity.ts';
import type { FundingHistoryPairRequest } from '../../src/vendor/perpetual-funding-history.ts';
import type { PerpetualMarketMetricsReport } from '../../src/vendor/perpetual-market-metrics.ts';

export const PERPETUAL_METRICS_PATH = '/api/monitor/perpetual/metrics';

export function usePerpetualMarketMetrics(pairs: FundingHistoryPairRequest[], active: boolean, onExpired: () => void) {
  const [report, setReport] = useState<PerpetualMarketMetricsReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reason, setReason] = useState('');
  const controls = useRef<ReturnType<typeof startPerpetualMarketMetricsFeed> | null>(null);
  const expired = useRef(onExpired);
  expired.current = onExpired;
  const requestKey = marketMetricsRequestKey(pairs);

  useEffect(() => {
    const feed = startPerpetualMarketMetricsFeed({
      load: async (requested, signal) => {
        try {
          const result = await api<PerpetualMarketMetricsReport>(PERPETUAL_METRICS_PATH, { body: { pairs: requested }, signal, timeoutMs: 12_000 });
          setReason('');
          return result;
        } catch (cause) {
          // 401 keeps the feed's bounded 60 s retry: the panel stays mounted behind the login notice and resumes by itself
          // once the session is back. A timeout or network failure has no service reason, so an older one is dropped.
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

  useEffect(() => { controls.current?.setPairs(JSON.parse(requestKey) as FundingHistoryPairRequest[]); }, [requestKey]);
  useEffect(() => {
    const synchronize = () => controls.current?.setActive(readsAllowed(active));
    const stop = observeReadActivity(synchronize, () => { synchronize(); if (readsAllowed(active)) controls.current?.refresh(); });
    return () => { stop(); controls.current?.setActive(false); };
  }, [active]);
  return { report, loading, error: [error && reason ? `${reason.replace(/[。.]$/, "")}。${error}` : error, report?.storageError].filter(Boolean).join(' ') };
}
