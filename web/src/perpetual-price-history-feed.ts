// 复制自 project-aggregation 工作台 modules/monitor/lib/perpetual-price-history.ts 的 startPerpetualPriceHistoryFeed 部分（提交
// c84ba27）。改动：类型与校验从 src/vendor 的副本导入。
import type { FundingHistoryPairRequest } from '../../src/vendor/perpetual-funding-history.ts';
import { validatePerpetualPriceHistory, type PerpetualPriceHistoryReport, type PriceHistoryDays } from '../../src/vendor/perpetual-price-history.ts';
import { backgroundReadDelay } from './read-activity.ts';

interface PriceFeedOptions {
  load: (pair: FundingHistoryPairRequest, days: PriceHistoryDays, signal: AbortSignal) => Promise<unknown>;
  onData: (report: PerpetualPriceHistoryReport | null) => void;
  onError: (message: string) => void;
  onLoading: (value: boolean) => void;
  now?: () => number;
  schedule?: (callback: () => void, delay: number) => unknown;
  cancel?: (timer: unknown) => void;
}

/** One active HTTP read; pair generations isolate late results, even when an
 * injected loader ignores abort. Days and direction reuse the same raw legs. */
export function startPerpetualPriceHistoryFeed(options: PriceFeedOptions) {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
  const cancel = options.cancel ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const cache = new Map<string, { report: PerpetualPriceHistoryReport; nextAt: number }>();
  let pair: FundingHistoryPairRequest | null = null, days: PriceHistoryDays = 7, selection = '', generation = 0;
  let active = false, stopped = false, timer: unknown, request: { controller: AbortController; generation: number; timeout: unknown } | null = null;
  const keyOf = (value: FundingHistoryPairRequest | null) => value ? JSON.stringify([value.base, ...[value.longKey, value.shortKey].sort()]) : '';
  function clearTimer() { if (timer !== undefined) cancel(timer); timer = undefined; }
  function abort() { if (!request) return; const pending = request; request = null; cancel(pending.timeout); pending.controller.abort(); }
  function publish() { options.onData(cache.get(selection)?.report ?? null); }
  function next() {
    clearTimer();
    if (stopped || !active || !pair || request) return;
    const wait = Math.max(0, (cache.get(selection)?.nextAt ?? 0) - now());
    if (wait > 0) { timer = schedule(() => { timer = undefined; void read(); }, backgroundReadDelay(wait)); return; }
    void read();
  }
  async function read() {
    if (stopped || !active || !pair || request) return;
    const selected = selection, requestedPair = pair, controller = new AbortController();
    let timedOut = false;
    const pending = { controller, generation, timeout: schedule(() => { timedOut = true; controller.abort(); }, 12_000) };
    request = pending; options.onLoading(true);
    const current = () => !stopped && active && generation === pending.generation && selection === selected && request === pending;
    try {
      const result = await Promise.race([options.load(requestedPair, days, controller.signal), new Promise<never>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(Error('Price read aborted')), { once: true }))]);
      if (!current() || controller.signal.aborted) return;
      if (!validatePerpetualPriceHistory(result, now())) throw Error('Invalid price history');
      const keys = [requestedPair.longKey, requestedPair.shortKey];
      if (Object.keys(result.legs).length !== 2 || keys.some(key => !Object.hasOwn(result.legs, key) || JSON.parse(result.legs[key].identity)[2] !== requestedPair.base)) throw Error('Price history selection mismatch');
      const old = cache.get(selected)?.report;
      if (old && result.generatedAt < old.generatedAt) throw Error('Price history response regressed');
      const legs = Object.fromEntries(keys.map(key => {
        const incoming = result.legs[key], previous = old?.legs[key];
        // An identity change intentionally drops old prices. Failed refreshes
        // may retain only an unchanged identity's previously validated data.
        return [key, previous && previous.identity === incoming.identity && incoming.points.length === 0 && ['pending', 'error'].includes(incoming.status) && previous.points.length ? { ...previous, status: incoming.status, error: incoming.error } : incoming];
      }));
      const report = { ...result, legs };
      const waiting = Object.values(legs).some(leg => leg.status === 'pending');
      cache.delete(selected); cache.set(selected, { report, nextAt: now() + backgroundReadDelay(waiting ? 3000 : 60_000) });
      while (cache.size > 20) cache.delete(cache.keys().next().value!);
      options.onError(''); options.onData(report);
    } catch {
      if (!current() || (controller.signal.aborted && !timedOut)) return;
      const previous = cache.get(selected);
      if (previous) previous.nextAt = now() + backgroundReadDelay(60_000);
      options.onError('成交价历史更新失败，保留已取得的数据。');
      // An empty first read also backs off; it must not recurse immediately.
      timer = schedule(() => { timer = undefined; void read(); }, backgroundReadDelay(60_000));
    } finally {
      cancel(pending.timeout);
      if (request === pending) { request = null; options.onLoading(false); if (timer === undefined) next(); }
    }
  }
  return {
    setSelection(value: FundingHistoryPairRequest | null, windowDays: PriceHistoryDays) {
      days = windowDays;
      const key = keyOf(value); pair = value;
      if (key === selection || stopped) return;
      generation++; selection = key; clearTimer(); abort(); options.onLoading(false); options.onError(''); publish(); next();
    },
    setActive(value: boolean) {
      if (active === value || stopped) return;
      active = value; generation++; clearTimer();
      if (!active) { abort(); options.onLoading(false); return; }
      publish(); next();
    },
    refresh() { if (!active || stopped) return; clearTimer(); const entry = cache.get(selection); if (entry) entry.nextAt = Math.min(entry.nextAt, now()); next(); },
    stop() { stopped = true; active = false; generation++; clearTimer(); abort(); },
  };
}
