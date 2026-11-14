// 改编自工作台 modules/crossex/src/use-open-capacity.ts（提交 7745181）：地址改为 /api/crossex/open-capacity，经 api.ts 发出，去掉 CSRF 令牌。
import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { CROSSEX_API } from './crossex-api.ts';
import type { LiveView } from './live-types.ts';
import type { OpenCapacity, OpenCapacityInput } from './open-capacity.ts';
import { capacityIsFresh, parseOpenCapacity } from './open-capacity.ts';
import { createLatestRead } from './latest-read.ts';
import { observeReadWake, readPollDelay } from './page-activity.ts';

export type CapacityContext = { live: LiveView; active: boolean; background: boolean; revision: string; now: number; readNow: () => number };

export function useOpenCapacity(input: OpenCapacityInput | null, { live, active, background, revision, now, readNow }: CapacityContext) {
  const inputKey = input ? JSON.stringify(input) : '';
  const version = live.connection.version;
  const scope = JSON.stringify([inputKey, version, revision]);
  const enabled = !!inputKey && active && live.connection.configured && !live.stale && !live.partial;
  const [result, setResult] = useState<{ scope: string; data: OpenCapacity | null; error: string }>({ scope: '', data: null, error: '' });
  useEffect(() => {
    if (!enabled) return;
    let disposed = false, epoch = 0, nextDelay = 4000, timer: ReturnType<typeof setTimeout> | undefined;
    const request: OpenCapacityInput = JSON.parse(inputKey);
    const reader = createLatestRead<OpenCapacity>({
      canRead: () => !disposed,
      load: async signal => {
        const data = await api<unknown>(`${CROSSEX_API}/open-capacity`, { body: request, signal, timeoutMs: 12_000 });
        return parseOpenCapacity(data, request, version);
      },
      onData: data => {
        nextDelay = data.status === 'unavailable' ? 5000 : Math.max(1000, Math.min(4000, data.expiresAt - readNow() - 700));
        setResult({ scope, data, error: '' });
      },
      onError: cause => { nextDelay = 5000; setResult({ scope, data: null, error: cause instanceof Error && cause.name !== 'TimeoutError' ? cause.message : '开仓估算读取超时，稍后自动重试' }); },
    });
    const synchronize = () => {
      const own = ++epoch; clearTimeout(timer); reader.cancel();
      setResult({ scope, data: null, error: '' });
      const poll = async () => {
        if (disposed || own !== epoch) return;
        await reader.refresh();
        if (!disposed && own === epoch) timer = setTimeout(poll, readPollDelay(nextDelay, background));
      };
      timer = setTimeout(() => void poll(), 300);
    };
    synchronize(); const stopWake = observeReadWake(synchronize);
    return () => { disposed = true; epoch++; clearTimeout(timer); reader.cancel(); stopWake(); };
  }, [enabled, inputKey, version, revision, scope, background, readNow]);

  const current = enabled && result.scope === scope ? result : null;
  const data = current?.data && capacityIsFresh(current.data, now) ? current.data : null;
  const error = !live.connection.configured ? '连接账户后显示可开仓额度'
    : live.stale || live.partial ? '账户数据待更新，暂不能估算'
      : !active ? '页面暂停读取，返回后重新估算'
        : !input ? '选择合约并填写有效参数后估算'
          : current?.error || (current?.data?.status === 'unavailable' ? current.data.reason || '开仓估算暂不可用'
            : current?.data && !data ? '估算已过期，等待更新' : '');
  return { data, error, loading: enabled && !current?.data && !current?.error };
}
