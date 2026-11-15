// 改写自 project-aggregation 工作台 modules/monitor/hooks/use-perpetual-quality.ts（提交 c84ba27）。改动：地址改为本服务的
// /api/monitor/perpetual/quality，读取走 api.ts（401 转登录，其它失败显示服务给的原因，再由 feed 保留上次记录、稍后重试），
// 与 use-perpetual-price-history.ts 同一做法；回复格式校验同工作台；read-activity 为独立页版。
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api.ts';
import { qualityRequestKey, startPerpetualQualityFeed, type QualityPairRequest } from './perpetual-quality-feed.ts';
import { observeReadActivity, readsAllowed } from './read-activity.ts';
import type { PerpetualQualityReport } from '../../src/vendor/perpetual-quality.ts';

export const PERPETUAL_QUALITY_PATH = '/api/monitor/perpetual/quality';

export function usePerpetualQuality(pairs: QualityPairRequest[], active: boolean, onExpired: () => void) {
  const [report, setReport] = useState<(PerpetualQualityReport & { storageError?: string }) | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reason, setReason] = useState('');
  const controls = useRef<ReturnType<typeof startPerpetualQualityFeed> | null>(null);
  const expired = useRef(onExpired);
  expired.current = onExpired;
  const requestKey = qualityRequestKey(pairs);

  useEffect(() => {
    const feed = startPerpetualQualityFeed({
      load: async (requested, signal) => {
        let value: PerpetualQualityReport & { storageError?: string };
        try {
          value = await api<PerpetualQualityReport & { storageError?: string }>(PERPETUAL_QUALITY_PATH, { body: { pairs: requested }, signal, timeoutMs: 12_000 });
          setReason('');
        } catch (cause) {
          if (cause instanceof ApiError && cause.status === 401) expired.current();
          setReason(cause instanceof ApiError && cause.status && cause.status !== 401 ? cause.message : '');
          throw cause;
        }
        const records = [value?.pairs, value?.assets, value?.assetErrors, value?.positioning, value?.positioningErrors];
        if (value?.schemaVersion !== 1 || !Number.isFinite(value.generatedAt) || records.some(record => !record || typeof record !== 'object' || Array.isArray(record))) { setReason('质量资料格式异常'); throw new Error('质量资料格式异常'); }
        return value;
      },
      onData: setReport, onError: setError, onLoading: setLoading,
    });
    controls.current = feed;
    return () => { feed.stop(); controls.current = null; };
  }, []);

  useEffect(() => { controls.current?.setPairs(JSON.parse(requestKey) as QualityPairRequest[]); }, [requestKey]);

  useEffect(() => {
    const synchronize = () => controls.current?.setActive(readsAllowed(active));
    const stop = observeReadActivity(synchronize, () => { synchronize(); if (readsAllowed(active)) controls.current?.refresh(); });
    return () => { stop(); controls.current?.setActive(false); };
  }, [active]);
  const failure = error && reason ? `${reason.replace(/[。.]$/, '')}。${error}` : error;
  return { report, loading, error: failure };
}
