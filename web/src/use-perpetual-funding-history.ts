// 改写自 project-aggregation 工作台 modules/monitor/hooks/use-perpetual-funding-history.ts（提交 c84ba27）。改动：地址改为
// 本服务的 /api/monitor/perpetual/funding-history，读取走 api.ts（401 转登录，其它失败显示服务给的原因，再由 feed 保留上次
// 结算、退避重试），与 use-perpetual-market-metrics.ts 同一做法；read-activity 为独立页版。
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api.ts';
import { fundingHistoryRequestKey, startPerpetualFundingHistoryFeed } from './perpetual-funding-history-feed.ts';
import { observeReadActivity, readsAllowed } from './read-activity.ts';
import type { FundingHistoryPairRequest, PerpetualFundingHistoryReport } from '../../src/vendor/perpetual-funding-history.ts';

export const PERPETUAL_FUNDING_HISTORY_PATH = '/api/monitor/perpetual/funding-history';

export function usePerpetualFundingHistory(pairs: FundingHistoryPairRequest[], active: boolean, onExpired: () => void) {
  const [report, setReport] = useState<PerpetualFundingHistoryReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reason, setReason] = useState('');
  const controls = useRef<ReturnType<typeof startPerpetualFundingHistoryFeed> | null>(null);
  const expired = useRef(onExpired);
  expired.current = onExpired;
  const requestKey = fundingHistoryRequestKey(pairs);

  useEffect(() => {
    const feed = startPerpetualFundingHistoryFeed({
      load: async (requested, signal) => {
        try {
          const result = await api<PerpetualFundingHistoryReport>(PERPETUAL_FUNDING_HISTORY_PATH, { body: { pairs: requested }, signal, timeoutMs: 12_000 });
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

  useEffect(() => { controls.current?.setPairs(JSON.parse(requestKey) as FundingHistoryPairRequest[]); }, [requestKey]);
  useEffect(() => {
    const synchronize = () => controls.current?.setActive(readsAllowed(active));
    const stop = observeReadActivity(synchronize, () => { synchronize(); if (readsAllowed(active)) controls.current?.refresh(); });
    return () => { stop(); controls.current?.setActive(false); };
  }, [active]);
  return { report, loading, error: [error && reason ? `${reason.replace(/[。.]$/, '')}。${error}` : error, report?.storageError].filter(Boolean).join(' ') };
}
