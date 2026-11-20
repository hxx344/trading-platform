// 改编自 project-aggregation 工作台 src/use-live-resource.ts（提交 056e9c3）：请求层换成本服务的 api.ts；增加 background。
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api.ts';
import { createResourceStore, monitorGenerationChanged, readAccessDenied, type DisplayRetention, type ResourceSnapshot, type Subscription } from './live-resource.ts';
import { READ_SESSION_EXPIRED } from './read-cache-events.ts';

// 工作台只读页面的共享读取入口，调度与失效规则见 live-resource.ts。
const store = createResourceStore({
  now: () => Date.now(), hidden: () => document.hidden, online: () => navigator.onLine,
  setTimer: (callback, ms) => setTimeout(callback, ms), clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
  listen: wake => {
    document.addEventListener('visibilitychange', wake);
    for (const name of ['online', 'offline', 'focus', 'pageshow']) window.addEventListener(name, wake);
    return () => {
      document.removeEventListener('visibilitychange', wake);
      for (const name of ['online', 'offline', 'focus', 'pageshow']) window.removeEventListener(name, wake);
    };
  },
});

if (typeof window !== 'undefined') window.addEventListener(READ_SESSION_EXPIRED, () => {
  store.invalidate(() => true, new ApiError('会话已失效，请重新登录。', 401));
});

export function invalidateMonitorDisplay(market: string, error: Error | null, reload = false) {
  const prefix = `/api/monitor/${market}/`;
  store.invalidate(key => key.startsWith(prefix), error, reload);
}

/** Replace the in-flight read, keeping metadata for markets whose collector has not changed. */
export const revalidateMonitorState = () => store.refresh('/api/monitor/state');

export type LiveResource<T> = ResourceSnapshot<T> & {
  // 立即重读，之前发出的读取作废。
  refresh: () => Promise<void>;
  // 写操作确认后的结果直接成为当前值，之前发出的读取作废。
  commit: (data: T) => void;
};

type Options<T> = {
  // null 表示只在打开时读取一次，之后靠 refresh；变化时只调整计时。
  intervalMs: number | null;
  timeoutMs?: number;
  // 边界校验：抛错按读取失败处理，不覆盖上次结果。
  parse?: (raw: unknown) => T;
  // A conditional history read can use its own transport while sharing the same polling lifecycle.
  read?: (signal: AbortSignal) => Promise<T>;
  // 只有明确列入的只读展示数据可以跨页面复用；私有账户、执行盘口与预览不传此项。
  retain?: DisplayRetention<T>;
  // false 时不订阅，重新启用后从当前范围的订阅取数。
  enabled?: boolean;
  // true 时页面隐藏也照常轮询（离线仍暂停）；变化时只调整本订阅者，不重新订阅。
  background?: boolean;
  onExpired: () => void;
};

const initial = <T,>(enabled: boolean): ResourceSnapshot<T> => ({ data: null, error: null, status: enabled ? 'loading' : 'paused', receivedAt: null });

// 同一 path 的订阅者共享请求与结果，读取函数、超时与校验以第一个订阅者为准，
// 所以共享同一 path 的页面须使用相同的 timeoutMs 与 parse。
export function useLiveResource<T>(path: string, { intervalMs, timeoutMs = 10_000, parse, read: customRead, retain, enabled = true, background = false, onExpired }: Options<T>): LiveResource<T> {
  const [state, setState] = useState<{ path: string; snapshot: ResourceSnapshot<T> }>(() => ({ path, snapshot: initial<T>(enabled) }));
  const expired = useRef(onExpired);
  expired.current = onExpired;
  const parser = useRef(parse);
  parser.current = parse;
  const handled = useRef<Error | null>(null);
  const interval = useRef(intervalMs);
  interval.current = intervalMs;
  const inBackground = useRef(background);
  inBackground.current = background;
  const subscription = useRef<Subscription | null>(null);
  useEffect(() => {
    if (!enabled) {
      setState({ path, snapshot: initial<T>(false) });
      return undefined;
    }
    const read = async (signal: AbortSignal) => {
      try {
        if (customRead) return await customRead(signal);
        const raw = await api<unknown>(path, { signal, timeoutMs });
        return parser.current ? parser.current(raw) : raw as T;
      } catch (error) {
        const market = /^\/api\/monitor\/(anthropic|oil|goldoil|hynix)\//.exec(path)?.[1];
        if (market && !signal.aborted && error instanceof ApiError && (error.status === 423 || monitorGenerationChanged(error) || path.endsWith('/quote') && readAccessDenied(error))) {
          store.invalidate(key => key !== path && key.startsWith(`/api/monitor/${market}/`), error);
        }
        throw error;
      }
    };
    const current = store.subscribe<T>(path, { read, retain, intervalMs: interval.current, background: inBackground.current }, snapshot => {
      if (snapshot.error instanceof ApiError && snapshot.error.status === 401 && snapshot.error !== handled.current) { handled.current = snapshot.error; expired.current(); }
      if (path === '/api/shell' && snapshot.status === 'ready') store.resumeSession();
      setState({ path, snapshot });
    });
    subscription.current = current;
    return () => { if (subscription.current === current) subscription.current = null; current(); };
  }, [path, enabled, timeoutMs, customRead, retain]);
  // 间隔随页面状态变化时只调整计时，不重新订阅。
  useEffect(() => { subscription.current?.retune(intervalMs); }, [intervalMs]);
  useEffect(() => { subscription.current?.setBackground(background); }, [background]);
  const refresh = useCallback(() => store.refresh(path), [path]);
  const commit = useCallback((data: T) => store.commit(path, data), [path]);
  return { ...(enabled && state.path === path ? state.snapshot : initial<T>(enabled)), refresh, commit };
}
