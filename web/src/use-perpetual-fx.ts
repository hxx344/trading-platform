// 改写自 project-aggregation 工作台 modules/monitor/hooks/use-perpetual-fx.ts（提交 c84ba27）。改动：地址改为本服务的
// /api/monitor/perpetual/fx，读取走 api.ts（401 转登录，其它失败给服务的原因）；工作台的 read-activity 在独立打开时
// 一直可读，本服务同样只看 active，页面隐藏时不额外放慢（间隔本来就是 60 秒）。
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api.ts';
import type { PerpetualFxSnapshot } from './perpetual-fx.ts';

export const PERPETUAL_FX_PATH = '/api/monitor/perpetual/fx';
const fallback = '换汇行情暂不可用，缺失或过期汇率的组合暂不参与排名。';

/** One low-frequency read only when cross-currency comparison is requested. */
export function usePerpetualFx(active: boolean, onExpired: () => void) {
  const [data, setData] = useState<PerpetualFxSnapshot | null>(null);
  const [error, setError] = useState('');
  const expired = useRef(onExpired);
  expired.current = onExpired;
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    async function read() {
      try {
        const result = await api<PerpetualFxSnapshot>(PERPETUAL_FX_PATH, { signal: controller.signal, timeoutMs: 12_000 });
        if (result?.baseCurrency !== 'USDT' || !Number.isFinite(result.generatedAt) || !result.rates || typeof result.rates !== 'object' || Array.isArray(result.rates)) throw new Error('invalid');
        if (!controller.signal.aborted) { setData(result); setError(''); }
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiError && cause.status === 401) { expired.current(); return; }
        setError(cause instanceof ApiError ? `${cause.message}；缺失或过期汇率的组合暂不参与排名。` : fallback);
      }
      if (!controller.signal.aborted) timer = setTimeout(read, 60_000);
    }
    void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [active]);
  return { data, error };
}
