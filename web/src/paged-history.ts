import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.ts';
import { emptyHistory, mergeLive, mergeOlder, type HistoryView } from './history-merge.ts';
import { readAccessDenied } from './live-resource.ts';
import { useLiveResource } from './use-live-resource.ts';
import type { HistoryPage, Unreadable } from './types.ts';

// A history list: the newest page is read live; older pages are read once, on demand, and not refreshed. The merge
// rules are in history-merge.ts.
type Row = { id: string };
export type HistoryRow<T> = T | Unreadable;
export const isUnreadable = (row: object): row is Unreadable => (row as Partial<Unreadable>).unreadable === true;

export function usePagedHistory<T extends Row>(path: string, { limit, intervalMs, at, onExpired }: { limit: number; intervalMs: number; at: (row: HistoryRow<T>) => number; onExpired: () => void }) {
  const live = useLiveResource<HistoryPage<T>>(`${path}?limit=${limit}`, { intervalMs, onExpired });
  const [view, setView] = useState<{ path: string; history: HistoryView<HistoryRow<T>> }>(() => ({ path, history: emptyHistory() }));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const older = useRef<AbortController | null>(null);
  const denied = readAccessDenied(live.error);
  useEffect(() => {
    setLoading(false); setError(null);
    setView({ path, history: emptyHistory() });
    return () => { older.current?.abort(); older.current = null; };
  }, [path, denied]);
  const page = live.data;
  useEffect(() => {
    if (denied || !page) return;
    setView(current => ({ path, history: mergeLive(current.path === path ? current.history : emptyHistory(), page) }));
  }, [page, path, denied]);
  const history = page && !denied && view.path === path ? view.history : emptyHistory<HistoryRow<T>>();
  const rows = useMemo(() => [...history.rows.values()].sort((a, b) => at(b) - at(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)), [history, at]);
  const next = history.next;
  const loadMore = useCallback(async () => {
    if (!next || older.current) return;
    const controller = new AbortController();
    older.current = controller;
    setLoading(true); setError(null);
    try {
      const result = await api<HistoryPage<T>>(`${path}?limit=${limit}&before=${encodeURIComponent(next)}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setView(current => current.path === path ? { path, history: mergeOlder(current.history, next, result) } : current);
    } catch (failure) {
      if (controller.signal.aborted) return;
      if (readAccessDenied(failure)) { setView({ path, history: emptyHistory() }); void live.refresh(); }
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (older.current === controller) { older.current = null; setLoading(false); }
    }
  }, [next, path, limit, live.refresh]);
  return { live, rows, more: next !== null, loadMore, loading, error };
}
