import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createResourceStore, readFailure, type DisplayRetention, type ResourceSnapshot } from '../web/src/live-resource.ts';
import { displayExchangeQuote, exchangeHistoryRetention, exchangeQuoteRetention, fundingRetention, mainQuoteDisplay, mainQuoteRetention, quoteIsCurrent } from '../web/src/monitor-display.ts';
import { ApiError } from '../web/src/api.ts';
import { hyperliquidOilQuote } from '../src/vendor/exchange-comparison.mjs';
import type { ExchangeFundingHistory } from '../src/vendor/exchange-funding-history.mjs';

const base = Date.parse('2026-11-19T03:59:50Z');
const iso = (time: number) => new Date(time).toISOString();
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const sample = (fetchedAt = base) => ({ fetchedAt: iso(fetchedAt), status: 'live' as const, lastError: null, staleAfterMs: 35_000 });
type Sample = ReturnType<typeof sample>;

test('报价首读区分等待、采集失败和连接失败，旧报价重试时沿用来源时间', () => {
  const live: ResourceSnapshot<Sample> = { data: null, status: 'loading', error: null, receivedAt: null };
  assert.match(mainQuoteDisplay(live, 10_000).label, /正在获取/);
  live.error = new ApiError('后台正在采集', 503, 'not_ready');
  assert.match(mainQuoteDisplay(live, 10_000).label, /等待后台首次报价/);
  for (const code of ['quote_unavailable', 'execution_unavailable']) {
    live.error = new ApiError('行情暂不可用', 503, code);
    assert.deepEqual(mainQuoteDisplay(live, 10_000), { current: false, label: '实时报价暂不可用 · 每 10 秒自动重试', notice: '行情暂不可用' });
  }
  live.data = sample();
  assert.match(mainQuoteDisplay(live, 10_000).label, /上次获取/);
  live.error = null;
  live.status = 'ready';
  assert.equal(mainQuoteDisplay({ ...live, data: { ...sample(), status: 'snapshot' } }, 10_000).current, false);
  assert.equal(mainQuoteDisplay({ ...live, data: sample(Date.now()) }, 10_000).current, true);
});

function fixture() {
  let now = base, online = true, wake: (() => void) | undefined;
  const timers = new Map<() => void, number>();
  const store = createResourceStore({ now: () => now, online: () => online, hidden: () => false,
    listen: callback => { wake = callback; return () => { wake = undefined; }; },
    setTimer: (callback, ms) => { timers.set(callback, now + ms); return callback; }, clearTimer: timer => { timers.delete(timer as () => void); } });
  const requests: Array<{ key: string; signal: AbortSignal; resolve: (value: Sample) => void; reject: (error: Error) => void }> = [];
  function watch(key: string, retain?: DisplayRetention<Sample>, intervalMs = 10_000) {
    let snapshot: ResourceSnapshot<Sample>;
    const leave = store.subscribe(key, { intervalMs, retain, read: signal => new Promise<Sample>((resolve, reject) => requests.push({ key, resolve, reject, signal })) }, value => { snapshot = value; });
    return { leave, value: () => snapshot };
  }
  return { store, requests, watch, timers, online: (value: boolean) => { online = value; wake?.(); },
    advance: (ms: number) => { now += ms; for (const [callback, due] of timers) if (due <= now) { timers.delete(callback); callback(); } } };
}

test('returning to fresh display data keeps its source, original poll deadline and separate keys', async () => {
  const h = fixture(), oil = h.watch('oil', mainQuoteRetention);
  h.advance(2_000); h.requests[0].resolve(sample()); await flush(); oil.leave();
  assert.equal(h.timers.size, 0);
  const other = h.watch('hynix', mainQuoteRetention);
  assert.equal(other.value().data, null); other.leave();
  h.advance(3_000);
  const restored = h.watch('oil', mainQuoteRetention, 30_000);
  assert.equal(h.requests.length, 2);
  assert.equal(restored.value().receivedAt, base + 2_000);
  assert.equal(restored.value().data?.fetchedAt, iso(base));
  assert.equal(restored.value().cached, true);
  assert.equal(quoteIsCurrent(restored.value(), 10_000, base + 5_000), false);
  h.advance(4_999); assert.equal(h.requests.length, 2);
  h.advance(1); assert.equal(h.requests.length, 3);
  const manual = h.store.refresh('oil');
  assert.ok(h.requests[2].signal.aborted);
  h.requests[3].resolve(sample(base + 10_000)); await manual;
  h.requests[2].resolve(sample(base - 100_000)); await flush();
  assert.equal(restored.value().data?.fetchedAt, iso(base + 10_000));
  assert.equal(restored.value().cached, false);
});

test('freshness is checked again on entry, and a restored snapshot cannot survive an access denial or overwrite a new scope', async () => {
  for (const status of [401, 403, 404, 409, 423]) {
    const h = fixture(), history = { ...mainQuoteRetention, history: true }, first = h.watch('funding', history);
    h.requests[0].resolve(sample()); await flush(); first.leave();
    h.advance(20_000);
    const refreshed = h.watch('funding', history);
    assert.equal(refreshed.value().data?.fetchedAt, iso(base)); assert.equal(refreshed.value().status, 'loading');
    const denial = Object.assign(new Error('已拒绝'), { status, code: status === 409 ? 'monitor_changed' : undefined });
    h.requests[1].reject(denial); await flush();
    assert.equal(refreshed.value().data, null); assert.equal(refreshed.value().receivedAt, null);
    refreshed.leave();
    const after = h.watch('funding', history);
    assert.equal(after.value().data, null);
    h.store.invalidate(key => key === 'funding', denial);
    assert.ok(h.requests[2].signal.aborted);
    h.requests[2].resolve(sample()); await flush();
    assert.equal(after.value().data, null);
    if (status === 401) { h.store.resumeSession(); assert.equal(h.requests.length, 4); }
  }
  const h = fixture(), price = h.watch('quote', mainQuoteRetention);
  h.requests[0].resolve(sample(base - 33_000)); await flush(); price.leave(); h.advance(3_000);
  assert.equal(h.watch('quote', mainQuoteRetention).value().data, null);
  assert.equal(h.requests.length, 2, 'the source expired before the polling interval did');
});

test('offline and interrupted reads require confirmation, history remains labeled with its original time', async () => {
  const h = fixture(), history = { ...mainQuoteRetention, history: true };
  const price = h.watch('quote', mainQuoteRetention), funding = h.watch('funding', history);
  h.requests[0].resolve(sample()); h.requests[1].resolve(sample()); await flush(); price.leave(); funding.leave();
  h.online(false); h.advance(1_000);
  const offline = h.watch('funding', history);
  assert.equal(offline.value().status, 'offline'); assert.equal(offline.value().cached, true);
  const unconfirmed = h.watch('quote', mainQuoteRetention);
  assert.equal(unconfirmed.value().data, null); assert.equal(h.requests.length, 2);
  h.online(true); assert.equal(h.requests.length, 4);
  unconfirmed.leave(); h.requests[3].resolve(sample()); await flush();
  const retry = h.watch('quote', mainQuoteRetention);
  assert.equal(retry.value().data, null);
  h.requests[2].reject(new Error('断线')); await flush(); offline.leave();
  const kept = h.watch('funding', history);
  assert.equal(kept.value().data?.fetchedAt, iso(base));
  assert.equal(kept.value().cached, true);
  assert.equal(h.requests.at(-1)?.key, 'funding');
});

test('private subscriptions always recheck on entry, and retained history is bounded by count, age and market', async () => {
  const h = fixture(), history = { ...mainQuoteRetention, history: true };
  const privateView = h.watch('positions'); h.requests[0].resolve(sample()); await flush(); privateView.leave();
  const again = h.watch('positions'); assert.equal(again.value().data, null); again.leave();
  for (let i = 0; i < 33; i++) {
    const scope = h.watch('oil/' + i, history);
    h.requests.at(-1)!.resolve(sample()); await flush(); scope.leave();
  }
  assert.equal(h.watch('oil/0', history).value().data, null);
  const kept = h.watch('oil/32', history); assert.equal(kept.value().cached, true); kept.leave();
  h.store.invalidate(key => key.startsWith('oil/'), new Error('停采'));
  assert.equal(h.watch('oil/32', history).value().data, null);
  const old = h.watch('hynix', history); h.requests.at(-1)!.resolve(sample()); await flush(); old.leave();
  h.advance(30 * 60_000);
  assert.equal(h.watch('hynix', history).value().data, null);
});

test('旧成交和关联持仓在失败后的补读期间仍显示读取失败，直到新结果到达', async () => {
  const h = fixture(), trades = h.watch('/api/asset/fills?market=hynix');
  h.requests[0].resolve(sample()); await flush();
  h.advance(10_000);
  h.requests[1].reject(new Error('读取暂不可用')); await flush();
  h.advance(10_000);
  assert.equal(trades.value().status, 'loading');
  assert.equal(trades.value().data?.fetchedAt, iso(base));
  assert.equal(readFailure(trades.value()), '读取暂不可用');
  h.requests[2].resolve(sample(base + 20_000)); await flush();
  assert.equal(readFailure(trades.value()), null);
  trades.leave();
});

test('quote errors, settlement boundaries and individual source deadlines constrain reuse', () => {
  assert.equal(mainQuoteRetention.fresh({ ...sample(), lastError: '未采到' }, base), false);
  assert.equal(mainQuoteRetention.fresh({ ...sample(), errors: { rh: '缺报价' } }, base), false);
  assert.equal(mainQuoteRetention.fresh(sample(base + 100), base), false);
  assert.equal(mainQuoteRetention.fresh({ ...sample(), status: 'snapshot' }, base), false);
  assert.equal(quoteIsCurrent({ data: sample(base - 30_000), status: 'ready', error: null, receivedAt: base }, 10_000, base), false);
  const context = (coin: string) => ({ coin, markPx: 70, oraclePx: 70, funding: 0.001 });
  const quote = hyperliquidOilQuote([{ universe: [{ name: 'xyz:BRENTOIL' }, { name: 'xyz:CL' }] }, [context('xyz:BRENTOIL'), context('xyz:CL')]], base);
  assert.equal(exchangeQuoteRetention.fresh(quote, base), true);
  assert.equal(exchangeQuoteRetention.fresh({ ...quote, left: { ...quote.left, nextFundingAt: iso(base + 1) } }, base + 2), false);
  assert.equal(exchangeQuoteRetention.fresh({ ...quote, fundingFetchedAt: iso(base - 80_000) }, base), false);
  const privateQuote = { ...quote, exchange: 'variational' as const, timestampBasis: 'source' as const };
  const denied = { data: privateQuote, status: 'error' as const, error: new Error('Var 认证价格不可用'), receivedAt: base };
  assert.equal(displayExchangeQuote(denied), null);
  assert.equal(displayExchangeQuote({ ...denied, status: 'loading' }), null);
  assert.equal(displayExchangeQuote({ ...denied, status: 'ready', error: null }), privateQuote);
  const publicQuote = { ...privateQuote, timestampBasis: 'received' as const };
  assert.equal(displayExchangeQuote({ ...denied, data: publicQuote }), publicQuote);
  const settled = { status: 'live' as const, rows: [], complete: true, fetchedAt: iso(base), lastError: null };
  assert.equal(fundingRetention.oil.fresh(settled, base + 9_999), true);
  assert.equal(fundingRetention.oil.fresh(settled, base + 10_000), false);
  assert.equal(fundingRetention.hynix.fresh({ ...settled, complete: false }, base), false);
  const leg = { symbol: 'example', fetchedAt: iso(base), error: '', coverage: null, freshUntil: base + 1 };
  const history: ExchangeFundingHistory = { exchange: 'binance', monitorId: 'oil', currency: 'USDT', fetchedAt: iso(base), status: 'live', left: leg, right: leg, rows: [], reason: '' };
  assert.equal(exchangeHistoryRetention.fresh(history, base), true);
  assert.equal(exchangeHistoryRetention.fresh(history, base + 2), false);
  assert.equal(exchangeHistoryRetention.fresh({ ...history, left: { ...leg, error: '采集失败' } }, base), false);
});
