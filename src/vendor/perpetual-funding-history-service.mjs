// 复制自 project-aggregation 工作台 modules/monitor/server/perpetual-funding-history.mjs（提交 c84ba27；改名免得与同目录的
// perpetual-funding-history.ts 混淆），只改导入路径。
import { createPerpetualFundingReader } from './perpetual-funding-reader.mjs';
import { PERPETUAL_FUNDING_REFRESH_MS, PERPETUAL_FUNDING_STALE_MS, PERPETUAL_FUNDING_LOOKBACK_MS } from './perpetual-funding-history.ts';
import { FUNDING_PUBLICATION_GRACE_MS, fundingGap, settlementSchedule, settlementSlot } from './funding-schedule.ts';

const DAY = 86_400_000, CHUNK_MS = 4 * DAY, GAP_RETRY_MS = 3_600_000;
const keyOf = quote => `${quote.exchange}:${quote.symbol}`;
const identityOf = quote => JSON.stringify([quote.exchange, quote.symbol, quote.base, quote.quoteCurrency, quote.marketId ?? null, quote.multiplier ?? 1, quote.contractUnit ?? null, quote.collateralCurrency ?? null]);
const hostOf = exchange => exchange === 'entropy' ? 'hyperliquid' : exchange;
const invalid = () => Object.assign(new Error('历史资金费请求必须包含至多 30 个有效的当前合约组合'), { status: 400 });
const timestamp = value => Number.isSafeInteger(value) && value >= 0;
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}

/** One durable history per contract. HTTP reads return caches; the scheduler owns
 * incremental refresh and resumable, contiguous backfill independently of tabs. */
export function createPerpetualFundingHistoryService({ getSnapshot, getMarket = () => null, getQuote, store, clock = Date.now, reader, cacheLimit = 500, maxConcurrent = 3, hostSpacingMs = 350 } = {}) {
  reader ??= createPerpetualFundingReader({ clock, requestSpacingMs: hostSpacingMs });
  const cache = new Map(), hostUntil = new Map(), busyHosts = new Set(), jobs = new Set();
  let running = false, timer, order = 0, storageError = '', storageRetryAt = 0;
  function empty(quote) {
    return { key: keyOf(quote), exchange: quote.exchange, symbol: quote.symbol, identity: identityOf(quote), status: 'pending', fetchedAt: null, coverage: null, records: [], error: '', backfillComplete: false, nextRefreshAt: 0, cacheUpdatedAt: 0 };
  }
  function normalize(records, range) {
    if (!range || !timestamp(range.from) || !timestamp(range.to) || range.from > range.to || !Array.isArray(records) || records.length > 2000) throw Error('历史结算记录格式异常');
    const values = new Map();
    for (const row of records) {
      if (!row || !timestamp(row.time) || row.time < range.from || row.time > range.to || typeof row.rate !== 'number' || !Number.isFinite(row.rate) || Math.abs(row.rate) > 1) throw Error('历史结算记录超出有效范围');
      if (values.has(row.time) && values.get(row.time) !== row.rate) throw Error('历史结算记录冲突');
      values.set(row.time, row.rate);
    }
    return [...values].sort(([a], [b]) => a - b).map(([time, rate]) => ({ time, rate }));
  }
  function restore(saved) {
    try {
      if (!saved || !saved.market || saved.key !== keyOf(saved.market) || saved.identity !== identityOf(saved.market) || saved.value?.key !== saved.key || saved.value.identity !== saved.identity || !timestamp(saved.lastAccessAt)) return null;
      const value = saved.value;
      if (!['pending', 'ready', 'error', 'unsupported'].includes(value.status) || typeof value.error !== 'string' || (value.fetchedAt !== null && !timestamp(value.fetchedAt)) || value.coverage?.to > clock() + 5000) return null;
      const records = value.coverage ? normalize(value.records, value.coverage) : [];
      if (!value.coverage && (value.status === 'ready' || value.records?.length)) return null;
      const entry = { ...saved, value: { ...value, records }, retryAt: timestamp(saved.retryAt) ? saved.retryAt : 0, backfillDueAt: timestamp(saved.backfillDueAt) ? saved.backfillDueAt : clock(), failures: Number.isInteger(saved.failures) ? Math.max(0, Math.min(saved.failures, 10)) : 0, lastScheduled: 0, controller: null, dirty: false };
      entry.gapRetryAt = timestamp(saved.gapRetryAt) ? saved.gapRetryAt : clock();
      if (timestamp(saved.hostRetryAt) && saved.hostRetryAt <= clock() + 900_000) hostUntil.set(hostOf(saved.market.exchange), Math.max(hostUntil.get(hostOf(saved.market.exchange)) ?? 0, saved.hostRetryAt));
      if (value.coverage) planSettlements(entry, false);
      return entry;
    } catch { return null; }
  }
  function persist(entry) {
    if (!entry.dirty || clock() < storageRetryAt) return;
    try {
      const { key, identity, market, value, retryAt, backfillDueAt, failures, lastAccessAt, gapRetryAt, gapCursor, hostRetryAt } = entry;
      store?.saveFundingHistory?.({ key, identity, market, value, retryAt, backfillDueAt, failures, lastAccessAt, gapRetryAt, gapCursor, hostRetryAt });
      entry.dirty = false; storageError = '';
    } catch { storageError = '历史缓存保存失败，当前保留内存记录并重试保存。'; storageRetryAt = clock() + 5000; }
  }
  try {
    for (const saved of store?.loadFundingHistory?.(undefined, cacheLimit) ?? []) {
      const entry = restore(saved);
      if (entry && cache.size < cacheLimit) cache.set(entry.key, entry);
    }
  } catch { storageError = '历史缓存读取失败，重新采集后自动保存。'; }
  function prune(protectedKeys) {
    if (cache.size < cacheLimit) return;
    const removable = [...cache.values()].filter(entry => !entry.controller && !entry.dirty && !protectedKeys.has(entry.key)).sort((a, b) => a.lastAccessAt - b.lastAccessAt);
    while (cache.size >= cacheLimit && removable.length) cache.delete(removable.shift().key);
  }
  function reset(entry, market) {
    entry.controller?.abort();
    Object.assign(entry, { market, identity: identityOf(market), value: empty(market), retryAt: 0, backfillDueAt: clock(), gapRetryAt: 0, gapCursor: 0, gap: null, late: null, failures: 0, dirty: true });
  }
  function planSettlements(entry, tailChecked) {
    const value = entry.value, { from, to } = value.coverage;
    const schedule = settlementSchedule(value.records, entry.market.fundingIntervalHours, entry.market.nextFundingAt);
    entry.gap = entry.late = null;
    const last = value.records.at(-1);
    if (!schedule) {
      value.freshUntil = to + PERPETUAL_FUNDING_STALE_MS;
      value.nextRefreshAt = to + PERPETUAL_FUNDING_REFRESH_MS;
      return;
    }
    const slot = settlementSlot(to, schedule);
    if (slot >= from && (!last || last.time < slot)) entry.late = slot;
    const due = entry.late ?? slot + schedule.interval;
    value.freshUntil = (last && entry.late !== null ? settlementSlot(last.time, schedule) + schedule.interval : due) + PERPETUAL_FUNDING_STALE_MS;
    value.nextRefreshAt = entry.late !== null && to >= due + FUNDING_PUBLICATION_GRACE_MS
      ? Math.max(to + PERPETUAL_FUNDING_REFRESH_MS, tailChecked ? clock() + PERPETUAL_FUNDING_REFRESH_MS : 0)
      : due + FUNDING_PUBLICATION_GRACE_MS;
    if (value.backfillComplete) {
      const gap = fundingGap(value.records, schedule, from, slot - schedule.interval, entry.gapCursor);
      if (gap !== null) entry.gap = { from: gap, to: Math.min(to, gap + schedule.interval - 1) };
    }
  }
  function taskFor(entry, now) {
    const previous = entry.value.coverage;
    // Bitget has page numbers only. Read its initial window once and publish
    // safe page progress; other venues use bounded time chunks.
    const chunk = entry.market.exchange === 'bitget' ? PERPETUAL_FUNDING_LOOKBACK_MS : CHUNK_MS;
    if (!previous || previous.to < now - PERPETUAL_FUNDING_LOOKBACK_MS) return { priority: 1, dueAt: entry.backfillDueAt, reset: true, range: { from: Math.max(0, now - chunk), to: now } };
    const target = Math.max(0, previous.to - PERPETUAL_FUNDING_LOOKBACK_MS);
    const start = entry.late ?? previous.to;
    const refresh = now >= (entry.value.nextRefreshAt ?? 0) && now > previous.to
      ? { priority: 0, dueAt: entry.value.nextRefreshAt ?? 0, range: { from: start, to: Math.min(now, start + CHUNK_MS) } } : null;
    // Refresh has a short head start, but cannot indefinitely displace either
    // another contract or this contract's older, unfinished backfill.
    const backfill = previous.from > target
      ? { priority: 2, dueAt: entry.backfillDueAt + 30_000, range: { from: Math.max(target, previous.from - chunk), to: previous.from } } : null;
    const repair = entry.gap && now >= entry.gapRetryAt ? { priority: 3, dueAt: entry.gapRetryAt, range: entry.gap } : null;
    const history = backfill ?? repair;
    return !refresh ? history : history && history.dueAt < refresh.dueAt ? history : refresh;
  }
  function accept(entry, records, range, replace = false, repaired = false) {
    const incoming = normalize(records, range), previous = replace ? null : entry.value.coverage;
    if (previous && (range.from > previous.to || range.to < previous.from)) throw Error('历史结算覆盖存在空档');
    const coverage = previous ? { from: Math.min(previous.from, range.from), to: Math.max(previous.to, range.to) } : { ...range };
    const combined = new Map((previous ? entry.value.records : []).map(row => [row.time, row.rate]));
    for (const row of incoming) {
      if (combined.has(row.time) && combined.get(row.time) !== row.rate) throw Error('历史结算记录冲突');
      combined.set(row.time, row.rate);
    }
    // Retain real anchors before the longest 30-day window, not an unbounded log.
    coverage.from = Math.max(coverage.from, coverage.to - PERPETUAL_FUNDING_LOOKBACK_MS);
    const kept = normalize([...combined].filter(([time]) => time >= coverage.from && time <= coverage.to).map(([time, rate]) => ({ time, rate })), coverage);
    entry.value = { ...entry.value, status: 'ready', fetchedAt: clock(), coverage, records: kept, error: '', cacheUpdatedAt: clock(), backfillComplete: coverage.from <= coverage.to - PERPETUAL_FUNDING_LOOKBACK_MS,
    };
    if (repaired || !entry.gapRetryAt) entry.gapRetryAt = clock() + GAP_RETRY_MS;
    if (repaired) entry.gapCursor = range.from;
    planSettlements(entry, range.to === coverage.to);
    entry.failures = 0; entry.retryAt = 0; entry.dirty = true;
    persist(entry);
  }
  async function collect() {
    if (!running) return;
    const now = clock(), candidates = [];
    for (const entry of cache.values()) {
      persist(entry);
      if (entry.controller || now < entry.retryAt) continue;
      const market = getMarket(entry.market.exchange, entry.market.symbol);
      // Stored metadata is not an authority: wait for current discovery.
      if (!market || keyOf(market) !== entry.key || market.comparable === false) continue;
      if (identityOf(market) !== entry.identity) reset(entry, market);
      else {
        const live = getQuote?.(market.exchange, market.symbol);
        const terms = live ? { fundingIntervalHours: live.fundingIntervalHours, nextFundingAt: live.nextFundingAt } : {};
        const current = { ...entry.market, ...market, ...terms };
        const changed = current.fundingIntervalHours !== entry.market.fundingIntervalHours || current.nextFundingAt !== entry.market.nextFundingAt;
        entry.market = current;
        if (changed && entry.value.coverage) { planSettlements(entry, false); entry.dirty = true; }
      }
      const task = taskFor(entry, now);
      if (task) candidates.push({ entry, task, dueAt: Math.max(task.dueAt, entry.retryAt) });
    }
    candidates.sort((a, b) => a.dueAt - b.dueAt || a.entry.lastScheduled - b.entry.lastScheduled);
    const launched = [];
    for (const { entry, task } of candidates) {
      const host = hostOf(entry.market.exchange);
      if (jobs.size >= maxConcurrent) break;
      if (busyHosts.has(host) || clock() < (hostUntil.get(host) ?? 0)) continue;
      const controller = new AbortController(), identity = entry.identity;
      entry.controller = controller; entry.lastScheduled = ++order;
      if (task.priority !== 0) entry.backfillDueAt = clock();
      busyHosts.add(host); hostUntil.set(host, clock() + hostSpacingMs);
      let progressed = false;
      const current = () => running && !controller.signal.aborted && cache.get(entry.key) === entry && entry.identity === identity;
      const job = Promise.resolve().then(() => abortable(reader(entry.market, task.range, { signal: controller.signal, onProgress(progress) {
        if (!current()) return;
        if (!progress?.coverage || progress.coverage.from < task.range.from || progress.coverage.to > task.range.to) throw Error('历史回补进度无效');
        accept(entry, progress.records, progress.coverage, task.reset && !progressed); progressed = true;
      } }), controller.signal)).then(records => {
        if (!current()) return;
        accept(entry, records, task.range, task.reset && !progressed, task.priority === 3);
      }).catch(error => {
        if (!current()) return;
        const unsupported = error?.code === 'UNSUPPORTED';
        entry.value = { ...entry.value, status: unsupported ? 'unsupported' : 'error', error: unsupported ? error.message : '本合约历史读取失败，保留已完成记录并稍后重试', cacheUpdatedAt: clock() };
        entry.retryAt = clock() + (unsupported ? 3_600_000 : Math.min(300_000, 60_000 * 2 ** Math.min(entry.failures++, 3)));
        if (error?.status === 429 || error?.status === 418) {
          const retry = Number.isFinite(error.retryAfterMs) ? Math.max(60_000, Math.min(900_000, error.retryAfterMs)) : 60_000;
          entry.hostRetryAt = Math.max(hostUntil.get(host) ?? 0, clock() + retry); hostUntil.set(host, entry.hostRetryAt);
        }
        entry.dirty = true; persist(entry);
      }).finally(() => { entry.controller = null; busyHosts.delete(host); jobs.delete(job); });
      jobs.add(job); launched.push(job);
    }
    await Promise.all(launched);
  }
  return {
    start() { if (running) return; running = true; timer = setInterval(() => { void collect(); }, 1000); timer.unref?.(); queueMicrotask(() => { void collect(); }); },
    async stop() { running = false; clearInterval(timer); for (const entry of cache.values()) entry.controller?.abort(); await Promise.allSettled([...jobs]); storageRetryAt = 0; for (const entry of cache.values()) persist(entry); },
    collect,
    read(input) {
      if (!input || !Array.isArray(input.pairs) || input.pairs.length > 30) throw invalid();
      const quotes = new Map(getSnapshot().quotes.map(quote => [keyOf(quote), quote])), requested = new Map();
      // Validate the complete batch before creating any cache registration.
      for (const pair of input.pairs) {
        if (!pair || typeof pair.base !== 'string' || pair.base.length > 100 || typeof pair.longKey !== 'string' || pair.longKey.length > 160 || typeof pair.shortKey !== 'string' || pair.shortKey.length > 160) throw invalid();
        const long = quotes.get(pair.longKey), short = quotes.get(pair.shortKey);
        if (!long || !short || long.exchange === short.exchange || long.base !== pair.base || short.base !== pair.base || long.comparable === false || short.comparable === false) throw invalid();
        for (const quote of [long, short]) {
          const catalog = getMarket(quote.exchange, quote.symbol);
          if (catalog && (catalog.exchange !== quote.exchange || catalog.symbol !== quote.symbol || catalog.base !== quote.base || catalog.quoteCurrency !== quote.quoteCurrency || catalog.comparable === false)) throw invalid();
          requested.set(keyOf(quote), { ...quote, ...catalog });
        }
      }
      const now = clock(), legs = Object.create(null);
      let registered = false;
      for (const [key, market] of requested) {
        let entry = cache.get(key);
        if (!entry) {
          try { entry = restore(store?.loadFundingHistory?.(key)?.[0]); }
          catch { storageError = '历史缓存读取失败，重新采集后自动保存。'; }
          prune(requested);
          if (cache.size >= cacheLimit) { legs[key] = { ...empty(market), error: '历史查询队列繁忙，稍后重试' }; continue; }
          entry ??= { key, identity: identityOf(market), market, value: empty(market), lastAccessAt: now, retryAt: 0, backfillDueAt: now, failures: 0, controller: null, lastScheduled: 0, dirty: true };
          cache.set(key, entry);
          registered = true;
        }
        if (entry.identity !== identityOf(market)) { reset(entry, market); registered = true; }
        if (entry.value.coverage && (entry.market.fundingIntervalHours !== market.fundingIntervalHours || entry.market.nextFundingAt !== market.nextFundingAt)) {
          entry.market = market; planSettlements(entry, false); entry.dirty = true;
        }
        entry.lastAccessAt = now; entry.market = market;
        legs[key] = structuredClone(entry.value);
      }
      if (running && registered) queueMicrotask(() => { void collect(); });
      return { schemaVersion: 1, generatedAt: now, legs, ...(storageError ? { storageError } : {}) };
    },
    metrics: () => ({ cached: cache.size, inFlight: jobs.size, backfilling: [...cache.values()].filter(entry => entry.value.backfillComplete === false).length, storageError }),
  };
}
