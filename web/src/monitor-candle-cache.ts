import { candleKnown, mergeCandleBlocks, type CandleBlockCache } from '../../src/candle-blocks.ts';
import { MONITOR_CANDLE_BLOCK_MS, monitorCandleField, type MonitorCandleMarket, type MonitorCandleUpdate } from '../../src/monitor/candle-window.ts';
import { api, ApiError } from './api.ts';
import { readAccessDenied } from './live-resource.ts';
import { ranges } from './monitor-history.ts';

type Row = { time: number };
type History = { windowDays: number | null };
export const MONITOR_CANDLE_CHECK_MS = 60_000;
export type SavedMonitorCandles = Pick<MonitorCandleUpdate, 'first' | 'header'> & {
  days: number | null;
  blocks: CandleBlockCache<Row>;
};
type Store = {
  peek(key: string): SavedMonitorCandles | undefined;
  load(key: string): Promise<SavedMonitorCandles | undefined>;
  put(key: string, value: SavedMonitorCandles): void;
  remove(key: string): void;
};
export const candleReadDenied = (error: unknown) => error instanceof ApiError && readAccessDenied(error);
const coversCandleDays = (history: History, days: number | null) => history.windowDays === null || (days !== null && history.windowDays >= days);

/** During expansion the chart, indicator and statistics must all keep the same previously covered range. */
export function monitorCandleSelection<T extends History>(history: T | undefined, range: number | null, warmup: number, previous?: number | null) {
  const covers = (days: number | null) => history && coversCandleDays(history, days === null ? null : days + warmup);
  if (!history || covers(range)) return { data: history ?? null, range, notice: '' };
  const last = previous !== undefined && covers(previous) ? previous : ranges.findLast(item => covers(item.days))?.days;
  if (last === undefined) return { data: null, range, notice: '' };
  const label = (value: number | null) => ranges.find(item => item.days === value)?.label ?? `${value} 天`;
  return { data: history, range: last, notice: `${label(range)}行情尚未补齐，图表和区间统计暂显示${label(last)}。` };
}

/** One cache per site/market. Keep the widest requested window, so narrowing the chart can also
 * pick up an older repair without fetching its whole history again when the user widens it. */
export function createMonitorCandleReader<T extends History>(market: MonitorCandleMarket, parse: (input: unknown) => T, store: Store,
  load: (path: string, signal: AbortSignal) => Promise<unknown> = (path, signal) => api(path, { signal, timeoutMs: 30_000 }), now = Date.now) {
  const path = `/api/monitor/${market}/candles`, field = monitorCandleField(market);
  const barMs = market === 'hynix' ? 3_600_000 : 900_000;
  const views = new WeakMap<SavedMonitorCandles, T>();
  let restoring: Promise<T | undefined> | undefined;
  let generation = 0;
  let confirmation: { saved: SavedMonitorCandles; at: number; due: number } | undefined;
  function clear() { generation++; confirmation = undefined; store.remove(market); }
  function view(saved: SavedMonitorCandles) {
    const existing = views.get(saved);
    if (existing) return existing;
    if (!Number.isSafeInteger(saved.first) || (saved.days !== null && (!Number.isSafeInteger(saved.days) || saved.days < 1 || saved.days > 400))) throw Error('K 线缓存范围无效');
    const rows = saved.blocks.flatMap(block => block.rows).filter(row => row.time >= saved.first);
    if (!rows.length || rows[0]!.time !== saved.first) throw Error('K 线缓存缺少窗口起点');
    const result = parse({ ...saved.header, [field]: rows });
    if (result.windowDays !== null && result.windowDays !== saved.days) throw Error('K 线窗口与请求不符');
    views.set(saved, result);
    return result;
  }
  function restore() {
    if (!restoring) restoring = (async () => {
      const saved = store.peek(market) ?? await store.load(market);
      if (!saved) return undefined;
      try { return view(saved); } catch { store.remove(market); return undefined; }
    })().finally(() => { restoring = undefined; });
    return restoring;
  }
  return {
    path, restore,
    peek() { const saved = store.peek(market); return saved && views.get(saved); },
    clear,
    intervalAfter(start: number) {
      return confirmation ? Math.max(1, Math.min(MONITOR_CANDLE_CHECK_MS, confirmation.due - start)) : MONITOR_CANDLE_CHECK_MS;
    },
    async read(requestedDays: number | null, signal: AbortSignal, reuseConfirmed = false): Promise<T> {
      const reading = ++generation;
      const check = () => {
        signal.throwIfAborted();
        if (reading !== generation) throw new DOMException('K 线读取已失效', 'AbortError');
      };
      await restore();
      check();
      const previous = store.peek(market);
      const started = now();
      if (reuseConfirmed && previous && confirmation?.saved === previous && started >= confirmation.at && started < confirmation.due) {
        const cached = view(previous);
        if (coversCandleDays(cached, requestedDays)) return cached;
      }
      const days = requestedDays === null || previous?.days === null ? null : Math.max(requestedDays, previous?.days ?? 0);
      const known = candleKnown(previous?.blocks ?? []);
      const query = new URLSearchParams();
      if (days !== null) query.set('days', String(days));
      query.set('known', known);
      let raw: unknown;
      try { raw = await load(`${path}?${query}`, signal); }
      catch (error) {
        if (reading === generation && !signal.aborted) {
          confirmation = undefined;
          if (candleReadDenied(error)) clear();
        }
        throw error;
      }
      check();
      confirmation = undefined;
      if (!raw || typeof raw !== 'object' || !('candles' in raw)) {
        // An open tab can outlive a server rollback to the full-snapshot API.
        const result = parse(raw);
        store.remove(market);
        return result;
      }
      const { first, header, candles } = raw as MonitorCandleUpdate;
      const blocks = mergeCandleBlocks(previous?.blocks ?? [], candles, MONITOR_CANDLE_BLOCK_MS);
      const saved = previous && days === previous.days && first === previous.first && blocks === previous.blocks
        && JSON.stringify(header) === JSON.stringify(previous.header) ? previous : { days, first, header, blocks };
      const result = view(saved);
      if (saved !== previous) store.put(market, saved);
      const errors = (header.metadata as { errors?: Record<string, unknown> } | undefined)?.errors;
      if (header.status === 'live' && !header.lastError && !Object.keys(errors ?? {}).length) {
        confirmation = { saved, at: started, due: Math.min(started + MONITOR_CANDLE_CHECK_MS, (Math.floor(started / barMs) + 1) * barMs) };
      }
      return result;
    },
  };
}
