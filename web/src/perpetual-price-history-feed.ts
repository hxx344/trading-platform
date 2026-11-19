// 改写自 project-aggregation 的 modules/monitor/lib/perpetual-price-history.ts（提交 c84ba27）。
import type { FundingHistoryPairRequest } from '../../src/vendor/perpetual-funding-history.ts';
import type { PriceHistoryDays } from '../../src/vendor/perpetual-price-history.ts';
import { ApiError } from './api.ts';
import { decodePriceHistory, knownPriceBlocks, priceBlocksChanged, readSavedPriceLeg, restoredPriceReport, retainUnscannedPriceBlocks, unscannedPrices, type ChartPriceHistory, type perpetualPriceCache, type SavedPriceLegs } from './perpetual-price-candles.ts';
import { backgroundReadDelay } from './read-activity.ts';

interface PriceFeedOptions {
  load: (pair: FundingHistoryPairRequest, days: PriceHistoryDays, signal: AbortSignal, known: Record<string, string>) => Promise<unknown>;
  cache?: typeof perpetualPriceCache;
  onData: (report: ChartPriceHistory | null, fromCache: boolean) => void;
  onError: (message: string) => void;
  onLoading: (value: boolean) => void;
  onExpired?: () => void;
  now?: () => number;
  schedule?: (callback: () => void, delay: number) => unknown;
  cancel?: (timer: unknown) => void;
}

/** One active HTTP read. Window/direction changes reuse both legs; catalog changes invalidate even a same-symbol request. */
export function startPerpetualPriceHistoryFeed(options: PriceFeedOptions) {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
  const cancel = options.cancel ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const saved: SavedPriceLegs = new Map();
  let pair: FundingHistoryPairRequest | null = null, days: PriceHistoryDays = 7, selection = '', identities: Record<string, string> = {};
  let report: ChartPriceHistory | null = null, nextAt = 0, failed = false;
  let active = false, stopped = false, restoring: object | null = null, timer: unknown;
  let request: { controller: AbortController; timeout: unknown } | null = null;
  function clearTimer() { if (timer !== undefined) cancel(timer); timer = undefined; }
  function abort() { if (!request) return; const pending = request; request = null; cancel(pending.timeout); pending.controller.abort(); }
  function next() {
    clearTimer();
    if (stopped || !active || !pair || request || restoring) return;
    const wait = nextAt - now();
    if (wait > 0) timer = schedule(() => { timer = undefined; void read(); }, backgroundReadDelay(wait));
    else void read();
  }
  function restoreSelection() {
    const cache = options.cache;
    if (!cache || !pair) return;
    const token = {}, loads: Promise<void>[] = [];
    restoring = token;
    for (const key of [pair.longKey, pair.shortKey]) {
      const identity = identities[key];
      if (!identity) continue;
      const restore = (entry: ReturnType<typeof cache.peek>) => {
        if (stopped || restoring !== token || !entry) return;
        try { saved.set(key, readSavedPriceLeg(key, identity, entry, now())); }
        catch { cache.remove(identity); }
      };
      const memory = cache.peek(identity);
      if (memory) restore(memory);
      else loads.push(cache.load(identity).then(restore));
    }
    function finish() {
      if (stopped || restoring !== token) return;
      restoring = null;
      report = restoredPriceReport(saved);
      if (report) options.onData(report, true);
      next();
    }
    if (loads.length) void Promise.allSettled(loads).then(finish);
    else finish();
  }
  async function read() {
    if (stopped || !active || !pair || request || restoring) return;
    const requestedPair = pair, controller = new AbortController();
    let timedOut = false;
    const pending = { controller, timeout: schedule(() => { timedOut = true; controller.abort(); }, 12_000) };
    request = pending; options.onLoading(true);
    const current = () => !stopped && active && request === pending;
    try {
      const result = await Promise.race([
        options.load(requestedPair, days, controller.signal, knownPriceBlocks(saved)),
        new Promise<never>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(Error('Price read aborted')), { once: true })),
      ]);
      if (!current() || controller.signal.aborted) return;
      const { report: incoming, updates } = decodePriceHistory(result, requestedPair, identities, saved, now());
      if (report && incoming.generatedAt < report.generatedAt) throw Error('Price history response regressed');
      let retained = false;
      const legs = { ...incoming.legs }, unscanned: ChartPriceHistory['unscanned'] = {};
      for (const [key, leg] of Object.entries(legs)) {
        const previous = report?.legs[key], oldBlocks = saved.get(key), update = updates.get(key);
        if (previous?.identity === leg.identity && (previous.points.length || report?.unscanned[key]?.length) && leg.from === null && (leg.status === 'pending' || leg.status === 'error')) {
          legs[key] = { ...previous, status: leg.status, error: leg.error };
          if (report?.unscanned[key]) unscanned[key] = report.unscanned[key];
          retained = true;
        }
        if (update) {
          const cached = retainUnscannedPriceBlocks(oldBlocks, update, leg.status, incoming.generatedAt);
          if (cached.archived) { unscanned[key] = unscannedPrices(cached); retained = true; }
          if (priceBlocksChanged(oldBlocks, cached)) options.cache?.put(cached.identity, cached);
          saved.set(key, cached);
        } else if (oldBlocks && (oldBlocks.identity !== leg.identity || leg.status === 'unsupported')) {
          saved.delete(key);
          if (oldBlocks.identity === leg.identity) options.cache?.remove(leg.identity);
        }
      }
      report = { ...incoming, legs, unscanned };
      const waiting = Object.values(legs).some(leg => leg.status === 'pending');
      failed = false; nextAt = now() + backgroundReadDelay(waiting ? 3000 : 60_000);
      options.onError(''); options.onData(report, retained);
    } catch (cause) {
      if (!current() || (controller.signal.aborted && !timedOut)) return;
      failed = true; nextAt = now() + backgroundReadDelay(60_000);
      if (cause instanceof ApiError && [401, 403, 404, 423].includes(cause.status)) {
        for (const id of new Set([...Object.values(identities), ...[...saved.values()].map(leg => leg.identity)])) options.cache?.remove(id);
        saved.clear(); report = null; options.onData(null, false);
        options.onError('当前无法读取此组合的成交价历史。');
        if (cause.status === 401) options.onExpired?.();
      } else options.onError('成交价历史更新失败，保留已取得的数据。');
    } finally {
      cancel(pending.timeout);
      if (request === pending) { request = null; options.onLoading(false); next(); }
    }
  }
  return {
    setSelection(value: FundingHistoryPairRequest | null, windowDays: PriceHistoryDays, currentIdentities: Record<string, string> = {}) {
      days = windowDays; pair = value;
      const key = value ? JSON.stringify([value.base, ...[value.longKey, value.shortKey].sort().map(key => [key, currentIdentities[key]])]) : '';
      if (key === selection || stopped) return;
      selection = key; identities = currentIdentities; restoring = null;
      clearTimer(); abort(); saved.clear(); report = null; nextAt = 0; failed = false;
      options.onLoading(false); options.onError(''); options.onData(null, false);
      restoreSelection(); next();
    },
    setActive(value: boolean) {
      if (active === value || stopped) return;
      active = value; clearTimer();
      if (!active) { abort(); options.onLoading(false); }
      else next();
    },
    refresh() { if (!active || stopped) return; if (!failed) nextAt = 0; next(); },
    stop() { stopped = true; active = false; restoring = null; clearTimer(); abort(); },
  };
}
