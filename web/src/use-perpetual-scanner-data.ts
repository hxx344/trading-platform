// 改写自 project-aggregation 工作台 modules/monitor/hooks/use-perpetual-scanner-data.ts（提交 c84ba27）。改动：地址改为
// 本服务的 /api/monitor/perpetual/scanner-data，读取走 api.ts（401 转登录，其它失败显示服务给的原因），与
// use-perpetual-market-metrics.ts 同一做法；read-activity 为独立页版。
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from './api.ts';
import { startPerpetualScannerDataFeed } from './perpetual-scanner-data-feed.ts';
import { observeReadActivity, readsAllowed } from './read-activity.ts';
import { scannerDataRequirementsKey, scannerDataSelectionKey, type PerpetualScannerDataReport, type ScannerDataPair, type ScannerDataRequirements } from '../../src/vendor/perpetual-scanner-data.ts';

export const PERPETUAL_SCANNER_DATA_PATH = '/api/monitor/perpetual/scanner-data';

export function usePerpetualScannerData(pairs: ScannerDataPair[], requirements: ScannerDataRequirements, active: boolean, onExpired: () => void) {
  const [report, setReport] = useState<PerpetualScannerDataReport | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [reason, setReason] = useState('');
  const controls = useRef<ReturnType<typeof startPerpetualScannerDataFeed> | null>(null);
  const expired = useRef(onExpired);
  expired.current = onExpired;
  const selectionKey = useMemo(() => scannerDataSelectionKey(pairs), [pairs]);
  const requirementsKey = useMemo(() => scannerDataRequirementsKey(requirements), [requirements]);
  useEffect(() => {
    const feed = startPerpetualScannerDataFeed({
      load: async (request, signal) => {
        try {
          const result = await api<PerpetualScannerDataReport>(PERPETUAL_SCANNER_DATA_PATH, { body: request, signal, timeoutMs: 12_000 });
          setReason('');
          return result;
        } catch (cause) {
          if (cause instanceof ApiError && cause.status === 401) expired.current();
          setReason(cause instanceof ApiError && cause.status && cause.status !== 401 ? cause.message : '');
          throw cause;
        }
      },
      onData: setReport, onLoading: setLoading, onError: setError,
    });
    controls.current = feed;
    return () => { feed.stop(); controls.current = null; };
  }, []);
  useEffect(() => { controls.current?.setSelection(JSON.parse(selectionKey) as ScannerDataPair[], JSON.parse(requirementsKey) as ScannerDataRequirements); }, [selectionKey, requirementsKey]);
  useEffect(() => {
    const synchronize = () => controls.current?.setActive(readsAllowed(active));
    const stop = observeReadActivity(synchronize, () => { synchronize(); if (readsAllowed(active)) controls.current?.refresh(); });
    return () => { stop(); controls.current?.setActive(false); };
  }, [active]);
  return { report, loading, error: [error && reason ? `${reason.replace(/[。.]$/, '')}。${error}` : error, report?.storageError].filter(Boolean).join(' ') };
}
