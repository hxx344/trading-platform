import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { anthropicHistory } from './monitor-history.ts';
import { hynixHistory } from './monitor-hynix.ts';
import { oilHistory } from './monitor-oil.ts';
import { goldOilHistory } from './monitor-goldoil.ts';
import { MONITOR_CANDLE_CHECK_MS, candleReadDenied, createMonitorCandleReader, monitorCandleSelection, type SavedMonitorCandles } from './monitor-candle-cache.ts';
import { createPublicCandleCache } from './public-candle-cache.ts';
import { useLiveResource } from './use-live-resource.ts';

const cache = createPublicCandleCache<SavedMonitorCandles>('monitor-spread-v1', 4);
export const anthropicCandles = createMonitorCandleReader('anthropic', anthropicHistory, cache);
export const hynixCandles = createMonitorCandleReader('hynix', hynixHistory, cache);
export const oilCandles = createMonitorCandleReader('oil', oilHistory, cache);
export const goldOilCandles = createMonitorCandleReader('goldoil', goldOilHistory, cache);

export function useMonitorCandles<T extends { windowDays: number | null }>(reader: ReturnType<typeof createMonitorCandleReader<T>>, range: number | null, warmup: number,
  onExpired: () => void, quoteError: Error | null) {
  const days = range === null ? null : range + warmup;
  const lastRange = useRef<number | null | undefined>(undefined);
  const [, restored] = useReducer(value => value + 1, 0);
  const [interval, setIntervalMs] = useState(MONITOR_CANDLE_CHECK_MS);
  const quoteFailure = useRef(quoteError);
  quoteFailure.current = quoteError;
  const deniedByQuote = candleReadDenied(quoteError);
  useEffect(() => {
    if (deniedByQuote) { reader.clear(); return; }
    if (reader.peek()) return;
    let active = true;
    void reader.restore().then(value => { if (active && value) restored(); });
    return () => { active = false; };
  }, [reader, deniedByQuote]);
  const path = days === null ? `${reader.path}?known=` : `${reader.path}?days=${days}&known=`;
  // Only entry/selection may reuse an in-memory confirmation. Polls, wakeups and explicit refreshes contact the service.
  const entry = useMemo(() => ({ first: true }), [reader, days]);
  const read = useCallback(async (signal: AbortSignal) => {
    const reuse = entry.first && !quoteFailure.current;
    entry.first = false;
    const start = Date.now();
    try { return await reader.read(days, signal, reuse); }
    finally { if (!signal.aborted) setIntervalMs(reader.intervalAfter(start)); }
  }, [reader, days, entry]);
  const live = useLiveResource<T>(path, { intervalMs: interval, onExpired, enabled: !deniedByQuote, read });
  const refresh = useCallback(() => { entry.first = false; return live.refresh(); }, [entry, live.refresh]);
  const allowed = !deniedByQuote && !candleReadDenied(live.error);
  const selected = allowed ? reader.peek() ?? (live.status === 'ready' ? live.data ?? undefined : undefined) : undefined;
  const shown = monitorCandleSelection(selected, range, warmup, lastRange.current);
  useEffect(() => { if (shown.data) lastRange.current = shown.range; }, [shown.data, shown.range]);
  const cached = !!shown.data && (!live.data || live.error !== null || live.status === 'offline' || live.status === 'paused'
    || live.receivedAt === null || Date.now() - live.receivedAt > 2 * MONITOR_CANDLE_CHECK_MS);
  return { ...shown, cached, error: live.error, refresh };
}
