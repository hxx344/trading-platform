// 改编自工作台 modules/crossex/src/live-market.ts（提交 7745181）：地址改为 /api/crossex/instruments 与 /api/crossex/market，经 api.ts 读取。
import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { CROSSEX_API } from './crossex-api.ts';
import type { Instrument, MarketData } from './live-types.ts';
import { createLatestRead } from './latest-read.ts';
import { observeReadWake, readPollDelay } from './page-activity.ts';
import { CATALOG_CACHE_MS, createTimedCache, readRetryDelay } from './live-loading.ts';

const instrumentCache = createTimedCache<Instrument[]>(CATALOG_CACHE_MS);

export function useInstruments(active: boolean, background = false) {
  const [items, setItems] = useState<Instrument[]>(() => instrumentCache.peek().value || []), [error, setError] = useState('');
  useEffect(() => {
    if (!active) return;
    let disposed = false, epoch = 0, failures = 0, timer: ReturnType<typeof setTimeout> | undefined;
    const reader = createLatestRead<Instrument[]>({
      canRead: () => !disposed,
      load: async signal => {
        const data = await api<{ items?: unknown }>(`${CROSSEX_API}/instruments`, { signal, timeoutMs: 12_000 });
        if (!Array.isArray(data.items)) throw new Error('合约目录格式不可用');
        return data.items as Instrument[];
      },
      onData: next => { instrumentCache.put(next); failures = 0; setItems(next); setError(''); },
      onError: cause => { failures++; setError(cause instanceof Error && cause.name !== 'TimeoutError' ? cause.message : '合约目录读取超时，稍后自动重试'); },
    });
    const synchronize = () => {
      const version = ++epoch; clearTimeout(timer); reader.cancel();
      if (disposed) return;
      const poll = async () => {
        if (version !== epoch || disposed) return;
        const cached = instrumentCache.peek();
        if (cached.fresh && cached.value) { setItems(cached.value); setError(''); }
        else await reader.refresh();
        if (version === epoch && !disposed) timer = setTimeout(poll, readPollDelay(failures ? readRetryDelay(failures) : Math.max(1000, instrumentCache.peek().remaining), background));
      };
      void poll();
    };
    synchronize(); const stopWake = observeReadWake(synchronize);
    return () => { disposed = true; epoch++; clearTimeout(timer); reader.cancel(); stopWake(); };
  }, [active, background]);
  return { items, error };
}

/** Read only while the mounted route needs the symbol; a new symbol never displays the old symbol's book. */
export function useMarket(symbol: string, interval: string, active: boolean, background = false) {
  const [data, setData] = useState<MarketData | null>(null), [error, setError] = useState('');
  useEffect(() => {
    setData(previous => previous?.symbol === symbol && previous.interval === interval ? active ? previous : { ...previous, status: 'stale' } : null); setError('');
    if (!symbol || !active) return;
    let epoch = 0, disposed = false, timer: ReturnType<typeof setTimeout> | undefined, abort: AbortController | undefined;
    const synchronize = () => {
      const version = ++epoch; clearTimeout(timer); abort?.abort();
      if (disposed) return;
      const poll = async () => {
        if (version !== epoch || disposed) return;
        abort = new AbortController(); const request = abort; const started = performance.now();
        try {
          const next = await api<MarketData>(`${CROSSEX_API}/market?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}`, { signal: request.signal, timeoutMs: 10_000 });
          if (next.symbol !== symbol) throw new Error('行情合约不匹配');
          if (version === epoch && !disposed) { setData(next); setError(''); }
        } catch (cause) {
          if (!request.signal.aborted && version === epoch && !disposed) {
            setError(cause instanceof Error ? cause.message : '行情连接中断'); setData(previous => previous ? { ...previous, status: 'stale' } : null);
          }
        } finally { if (version === epoch && !disposed) timer = setTimeout(poll, readPollDelay(Math.max(0, 2000 - (performance.now() - started)), background)); }
      };
      void poll();
    };
    synchronize(); const stopWake = observeReadWake(synchronize);
    return () => { disposed = true; epoch++; clearTimeout(timer); abort?.abort(); stopWake(); };
  }, [symbol, interval, active, background]);
  return { data: data?.symbol === symbol && data.interval === interval ? data : null, error };
}
