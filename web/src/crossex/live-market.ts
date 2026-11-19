// 改编自工作台 modules/crossex/src/live-market.ts（提交 7745181）：地址改为 /api/crossex/instruments 与 /api/crossex/market，经 api.ts 读取。
import { useEffect, useState } from 'react';
import { api, ApiError } from '../api.ts';
import { CROSSEX_API } from './crossex-api.ts';
import type { Instrument } from './live-types.ts';
import { createLatestRead } from './latest-read.ts';
import { observeReadWake, readPollDelay } from './page-activity.ts';
import { CATALOG_CACHE_MS, createTimedCache, readRetryDelay } from './live-loading.ts';
import { createPublicCandleCache } from '../public-candle-cache.ts';
import { acceptTerminalRead, lastTerminalObservation, marketReadPath, pauseTerminalRead, readTerminalChart, rememberTerminalObservation, terminalCacheKey, terminalObservation, type SavedTerminalHistory, type TerminalChart, type TerminalMarketResponse, type TerminalRead } from './terminal-candles.ts';

const instrumentCache = createTimedCache<Instrument[]>(CATALOG_CACHE_MS);
const candleCache = createPublicCandleCache<SavedTerminalHistory>('crossex-closed-v1', 32);
const catalogRefresh = new Set<() => void>();

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
    synchronize(); const stopWake = observeReadWake(synchronize); catalogRefresh.add(synchronize);
    return () => { disposed = true; epoch++; clearTimeout(timer); reader.cancel(); stopWake(); catalogRefresh.delete(synchronize); };
  }, [active, background]);
  return { items, error };
}

/** The directory selects the display units. Only a market response can supply a ticker, book or native candle identity. */
export function useMarket(instrument: Instrument | undefined, interval: string, active: boolean, background: boolean, candles: 'blocks' | 'none') {
  const scope = instrument ? terminalCacheKey(instrument, interval) : '', symbol = instrument?.symbol, listing = instrument?.candleListing;
  const listingScope = instrument ? terminalCacheKey(instrument, '') : '';
  const [result, setResult] = useState<TerminalRead | null>(null), [error, setError] = useState('');
  useEffect(() => {
    setResult(previous => previous?.listingScope === listingScope ? active && !background ? previous : pauseTerminalRead(previous) : null); setError('');
    if (!symbol || !active || background) return;
    let epoch = 0, disposed = false, timer: ReturnType<typeof setTimeout> | undefined, abort: AbortController | undefined;
    let latest: ReturnType<typeof terminalObservation>;
    const retain = () => rememberTerminalObservation(scope, latest);
    const useCache = candles === 'blocks' && !!listing;
    let cached = useCache ? candleCache.peek(scope) : undefined;
    let restored = !useCache || !!cached, refreshedDirectory = false;
    const restoring = restored ? undefined : candleCache.load(scope).then(value => {
      if (!disposed) cached = value;
      restored = true;
    });
    const reloadDirectory = () => {
      if (refreshedDirectory) return;
      refreshedDirectory = true; instrumentCache.invalidate();
      for (const refresh of catalogRefresh) refresh();
    };
    const synchronize = () => {
      const version = ++epoch; clearTimeout(timer); abort?.abort();
      if (disposed || document.hidden || navigator.onLine === false) return;
      const poll = async () => {
        if (version !== epoch || disposed) return;
        abort = new AbortController(); const request = abort; const started = performance.now();
        // IndexedDB can be slow or blocked. Read the book immediately, then negotiate history with the restored versions.
        const mode = restored ? candles : 'none';
        const baseline = cached;
        let delay = 2000;
        try {
          const next = await api<TerminalMarketResponse>(marketReadPath(symbol, interval, mode, baseline), { signal: request.signal, timeoutMs: 10_000 });
          if (version !== epoch || disposed) return;
          if (next.symbol !== symbol || next.interval !== interval || next.candleListing !== undefined && next.candleListing !== listing) {
            setResult(null);
            reloadDirectory();
            throw new Error('行情合约与所选目录不匹配，正在更新目录');
          }
          let chart: TerminalChart | null = null;
          if (candles === 'blocks') {
            try {
              const merged = readTerminalChart(next, mode === 'blocks' ? baseline : cached);
              chart = merged.chart;
              if (mode === 'blocks' && useCache && merged.saved && merged.saved !== cached) {
                cached = merged.saved;
                if (cached.blocks.length) candleCache.put(scope, cached);
                else candleCache.remove(scope);
              }
            } catch {
              cached = undefined; candleCache.remove(scope);
              chart = { closed: [], asOf: null, error: '正在重新核对历史 K 线', base: next.base, quote: next.quoteCurrency };
            }
          }
          const sampled = terminalObservation(next, chart);
          if (sampled && latest && sampled.identity !== latest.identity) retain();
          if (sampled && (!latest || sampled.identity !== latest.identity || sampled.at > latest.at)) latest = sampled;
          const onMount = candles === 'blocks' ? lastTerminalObservation(scope, next.candleIdentity) : undefined;
          setResult(previous => acceptTerminalRead(previous, { scope, listingScope, data: next, chart }, onMount)); setError('');
          if (candles === 'blocks' && mode === 'none') {
            // The first quote is already on screen. The bounded disk read completes before the usual 2 s quote cadence.
            await restoring;
            delay = 0;
          }
        } catch (cause) {
          if (!request.signal.aborted && version === epoch && !disposed) {
            setError(cause instanceof Error ? cause.message : '行情连接中断');
            const denied = cause instanceof ApiError && [400, 404, 409].includes(cause.status);
            if (denied) reloadDirectory();
            setResult(previous => previous?.listingScope === listingScope && !denied ? pauseTerminalRead(previous) : null);
          }
        } finally { if (version === epoch && !disposed) timer = setTimeout(poll, readPollDelay(Math.max(0, delay - (performance.now() - started)), background)); }
      };
      void poll();
    };
    synchronize(); const stopWake = observeReadWake(() => {
      if (document.hidden || navigator.onLine === false) setResult(previous => previous?.scope === scope ? pauseTerminalRead(previous) : previous);
      synchronize();
    });
    if (candles === 'blocks') window.addEventListener('pagehide', retain);
    return () => {
      disposed = true; epoch++; clearTimeout(timer); abort?.abort(); stopWake();
      if (candles === 'blocks') { window.removeEventListener('pagehide', retain); retain(); }
    };
  }, [symbol, interval, scope, listingScope, listing, candles, active, background]);
  const native = result?.listingScope === listingScope ? result.data.candleIdentity : null;
  return { data: result?.scope === scope ? result.data : null, chart: result?.scope === scope ? result.chart : null,
    marketIdentity: JSON.stringify([listingScope, native]), error };
}
