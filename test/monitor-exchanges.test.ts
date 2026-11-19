// Monitor M-2c: the multi-exchange comparison for oil and Hynix. The vendored workbench parsers
// (src/vendor/exchange-comparison.mjs), the on-demand reader with its caches, the endpoint and the page's rules. Every venue
// is the stand-in in monitor-fake.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  COMPARISON_EXCHANGES, EXCHANGE_REFRESH_MS, LIGHTER_SOCKET, calculateExchangeSpread, readLighterOilSnapshot, supportsExchange, validateExchangeQuote, type Exchange, type SpreadMarket,
} from '../src/vendor/exchange-comparison.mjs';
import { createBinanceGate } from '../src/vendor/anthropic-market.mjs';
import { EXCHANGE_RESULT_TTL_MS, createExchangeReader, exchangeError } from '../src/monitor/exchanges.ts';
import { createStoredExchangeQuotes } from '../src/monitor/exchange-quote-cache.ts';
import { createMonitorStore } from '../src/monitor/store.ts';
import type { VariationalSession } from '../src/monitor/variational-session.ts';
import type { RemoteComparison } from '../src/service/remote-monitor.ts';
import { parseServiceConfig } from '../src/service/config.ts';
import { closeMonitor, monitorViews, openMonitor, stopMonitor } from '../src/service/monitor.ts';
import { createExecutorServer } from '../src/http.ts';
import { createHarness } from './harness.ts';
import { fakeAnthropicVenues, fakeVariationalToken, venuePrice } from './monitor-fake.ts';

const close = (actual: number, expected: number, label = '') => assert.ok(Math.abs(actual - expected) < 1e-9, `${label} ${actual} ≈ ${expected}`);
const count = (venues: ReturnType<typeof fakeAnthropicVenues>, key: string) => venues.requests.get(key) ?? 0;
const BASES = { oil: ['BZ', 'CL'], hynix: ['SKHY', 'SKHYNIX'] } as const;

/** A comparison reader on the stand-ins with a clock the test moves; the collectors' quotes come from the stand-ins too. */
function setup({ fetchWrap }: { fetchWrap?: (fetch: (url: string, init: RequestInit) => Promise<Response>) => (url: string, init: RequestInit) => Promise<Response> } = {}) {
  let t = Date.UTC(2026, 10, 13, 9, 0, 7);
  const now = () => t;
  const venues = fakeAnthropicVenues({ now });
  const gate = createBinanceGate(), logs: string[] = [];
  let hynixStatus: 'live' | 'snapshot' | null = 'live';
  const hynixQuote = () => {
    if (!hynixStatus) return null;
    const adr = venuePrice('hyperliquid', 'SKHY', t), ordinary = venuePrice('hyperliquid', 'SKHYNIX', t);
    return { source: 'Hyperliquid' as const, adr, ordinary, equivalent: ordinary / 10, spread: adr - ordinary / 10, premium: (adr / (ordinary / 10) - 1) * 100, fetchedAt: new Date(t).toISOString(), status: hynixStatus, staleAfterMs: 25_000, lastAttemptAt: null, lastError: null };
  };
  const reader = createExchangeReader({
    gate, now, log: line => logs.push(line), WebSocketImpl: venues.WebSocket,
    fetchImpl: fetchWrap ? fetchWrap(venues.fetch) : venues.fetch, variationalFetch: venues.variationalFetch,
    oilQuote: () => null, hynixQuote: hynixQuote as never,
  });
  return { venues, gate, logs, reader, advance: (ms: number) => { t += ms; }, now, setHynix: (status: typeof hynixStatus) => { hynixStatus = status; } };
}

test('各交易所：替身上逐家读出两腿、价差与资金费，价格来自该交易所；页面规则接受服务给出的行', async () => {
  const { reader, now } = setup();
  for (const market of ['oil', 'hynix'] as SpreadMarket[]) for (const exchange of COMPARISON_EXCHANGES[market] as readonly Exchange[]) {
    if (market === 'oil' && exchange === 'binance') continue; // From the oil collector, covered below.
    const quote = await reader.quote(market, exchange);
    const label = `${market}/${exchange}`;
    assert.deepEqual([quote.exchange, quote.monitorId], [exchange, market], label);
    close(quote.left.price, venuePrice(exchange, BASES[market][0], now()), `${label} left`);
    close(quote.right.price, venuePrice(exchange, BASES[market][1], now()), `${label} right`);
    assert.deepEqual(validateExchangeQuote(JSON.parse(JSON.stringify(quote)), exchange, market), quote, `${label} page`);
    const metrics = calculateExchangeSpread(quote);
    assert.ok(Number.isFinite(metrics.spread), label);
    // Every stand-in answers funding, so each row has both annualized figures.
    assert.ok(quote.left.fundingRate !== null && quote.right.fundingRate !== null && metrics.shortAnnualized !== null, `${label} funding`);
  }
  await assert.rejects(reader.quote('oil', 'gate'), /不支持的交易所/);
  await assert.rejects(reader.quote('hynix', 'lighter'), /不支持的交易所/);
  await assert.rejects(reader.quote('hynix', 'variational'), /不支持的交易所/);
  assert.deepEqual([supportsExchange('oil', 'variational'), supportsExchange('hynix', 'variational'), supportsExchange('hynix', 'gate'), supportsExchange('oil', 'gate')], [true, false, true, false]);
});

test('年化公式：按各腿名义与周期折算成每小时，再除以两腿总名义 × 8760；海力士左腿 10 份；任一腿缺资金费时为空', () => {
  const leg = (symbol: string, price: number, fundingRate: number | null, fundingIntervalHours: number | null, fundingPrice = price) => ({ symbol, price, fundingPrice, fundingRate, fundingIntervalHours, nextFundingAt: null });
  const at = new Date(Date.UTC(2026, 10, 13)).toISOString();
  const base = { exchange: 'bybit', monitorId: 'hynix', currency: 'USDT', priceBasis: 'mark', fundingPriceBasis: 'mark', fetchedAt: at, fundingFetchedAt: at, status: 'live', fundingError: '' } as const;
  // Short ADR (10 units at 26, +0.0001 per 8 h), long the ordinary share (1 at 240, -0.0002 per 4 h).
  const hynix = { ...base, left: leg('SKHYUSDT', 26, 0.0001, 8), right: leg('SKHYNIXUSDT', 240, -0.0002, 4) };
  const shortReceived = 10 * 26 * 0.0001 / 8, longPaid = 240 * -0.0002 / 4;
  const expected = (shortReceived - longPaid) / (10 * 26 + 240) * 8760;
  const metrics = calculateExchangeSpread(hynix as never);
  close(metrics.shortAnnualized!, expected, 'short');
  close(metrics.longAnnualized!, -expected, 'long');
  close(metrics.equivalent, 24); close(metrics.spread, 2); close(metrics.premium, (26 / 24 - 1) * 100);
  assert.ok(expected > 0, '空 ADR 收正费率、多正股收负费率，做空为正');
  // Oil: one barrel each; the funding notional may differ from the price (Hyperliquid's oracle).
  const oil = { ...base, exchange: 'hyperliquid', monitorId: 'oil', currency: 'USD', fundingPriceBasis: 'oracle', left: leg('xyz:BRENTOIL', 74, 0.00002, 1, 73.5), right: leg('xyz:CL', 70, 0.00001, 1, 70.2) };
  close(calculateExchangeSpread(oil as never).shortAnnualized!, (73.5 * 0.00002 - 70.2 * 0.00001) / (73.5 + 70.2) * 8760, 'oil');
  close(calculateExchangeSpread(oil as never).spread, 4);
  for (const right of [leg('SKHYNIXUSDT', 240, null, 4), leg('SKHYNIXUSDT', 240, -0.0002, null)]) {
    const missing = calculateExchangeSpread({ ...hynix, right } as never);
    assert.deepEqual([missing.shortAnnualized, missing.longAnnualized], [null, null], '缺一腿不按 0 算');
  }
});

test('缓存：同一交易所 5 秒内共用一次读取、并发只发一次；失败不缓存，下一次立即重读', async () => {
  const { reader, venues, advance, logs } = setup();
  const [a, b] = await Promise.all([reader.quote('hynix', 'gate'), reader.quote('hynix', 'gate')]);
  assert.equal(a, b);
  assert.equal(count(venues, 'exchange:gate'), 2, '两腿各一次');
  advance(EXCHANGE_RESULT_TTL_MS - 1);
  assert.equal(await reader.quote('hynix', 'gate'), a);
  assert.equal(count(venues, 'exchange:gate'), 2, '5 秒内不重读');
  advance(1);
  assert.notEqual(await reader.quote('hynix', 'gate'), a);
  assert.equal(count(venues, 'exchange:gate'), 4);

  advance(EXCHANGE_RESULT_TTL_MS);
  venues.exchangeDown.add('gate');
  await assert.rejects(reader.quote('hynix', 'gate'), (error: Error) => error.message === '接口返回 HTTP 500');
  await assert.rejects(reader.quote('hynix', 'gate'), /HTTP 500/);
  assert.deepEqual(logs, ['交易所对比 hynix/gate 读取失败：接口返回 HTTP 500（Exchange market HTTP 500）'], '同一原因只记一次');
  venues.exchangeDown.delete('gate');
  const before = count(venues, 'exchange:gate');
  await reader.quote('hynix', 'gate');
  assert.equal(count(venues, 'exchange:gate'), before + 2, '失败不缓存');
  assert.equal(logs.at(-1), '交易所对比 hynix/gate 已恢复');
  assert.equal(logs.length, 2);
});

test('服务端对比报价：页面共用刷新周期；重启先恢复原价与资金费，后台单次核实；停采不写入迟到应答', async () => {
  let t = Date.UTC(2026, 10, 13, 9, 0, 7);
  const now = () => t, dir = mkdtempSync(join(tmpdir(), 'tp-comparison-'));
  const venues = fakeAnthropicVenues({ now });
  const config = parseServiceConfig({ secretsFile: '/etc/tp/secrets.json', monitor: { hynix: {} } });
  const open = () => openMonitor(config.monitor!, dir, { now, fetchImpl: venues.fetch, log() {} });
  let monitor = open();
  const quote = () => monitor.exchanges!.quote('hynix', 'gate');
  const state = () => monitor.store.readState('comparison.v1.hynix.gate');
  const tick = () => new Promise<void>(resolve => setImmediate(resolve));
  try {
    const first = await quote(), stored = state();
    assert.deepEqual(stored?.value, first);
    t += EXCHANGE_REFRESH_MS - 1;
    assert.deepEqual(await quote(), first);
    assert.equal(count(venues, 'exchange:gate'), 2);
    t++;
    venues.exchangeDown.add('gate');
    const kept = await quote();
    assert.deepEqual(kept, { ...first, status: 'snapshot' });
    assert.equal(count(venues, 'exchange:gate'), 4);
    assert.deepEqual(await quote(), kept);
    assert.equal(count(venues, 'exchange:gate'), 4, '暂时失败时第二个页面不重复请求');
    assert.deepEqual(state(), stored);

    stopMonitor(monitor); closeMonitor(monitor);
    monitor = open();
    t += 60_000;
    venues.exchangeDown.clear();
    let release!: () => void;
    venues.hold = new Promise<void>(resolve => { release = resolve; });
    assert.deepEqual(await Promise.all([quote(), quote()]), [kept, kept], '两个页面都无需等待冷启动的外部读取');
    assert.equal(count(venues, 'exchange:gate'), 6, '后台双腿共一轮');
    monitor.control.update('hynix', { enabled: false, revision: 0 });
    release(); venues.hold = null; await tick();
    assert.deepEqual(state(), stored, '关闭前在途的应答不能覆盖已保存行情');
    monitor.control.update('hynix', { enabled: true, revision: 1 });
    assert.deepEqual(await quote(), kept);
    await tick();
    const next = await quote();
    assert.equal(next.status, 'live');
    assert.equal(next.fetchedAt, new Date(t).toISOString());
    assert.equal(count(venues, 'exchange:gate'), 8);
    assert.deepEqual(state()?.value, next);
  } finally { stopMonitor(monitor); closeMonitor(monitor); rmSync(dir, { recursive: true, force: true }); }
});

test('相同来源采样不重写 SQLite；同时间修订可覆盖，行情连接断开或切换时只能先读快照', async () => {
  const { reader, now } = setup();
  const first = await reader.quote('hynix', 'gate'); reader.stop();
  let sample = first, t = now(), calls = 0, epoch: string | null = 'one';
  const store = createMonitorStore({ file: ':memory:', now: () => t });
  const cache = createStoredExchangeQuotes({ store, read: async () => { calls++; return sample; }, scope: () => 'enabled', epoch: () => epoch,
    signal: new AbortController().signal, now: () => t, log() {} });
  const quote = () => cache.read('hynix', 'gate');
  const state = () => store.readState('comparison.v1.hynix.gate');
  try {
    await quote(); const firstWrite = state()!.updatedAt;
    t += EXCHANGE_REFRESH_MS; await quote();
    assert.equal(state()!.updatedAt, firstWrite);
    const price = sample.left.price + 1;
    sample = { ...first, left: { ...first.left, price, fundingPrice: price } };
    t += EXCHANGE_REFRESH_MS;
    assert.deepEqual(await quote(), sample);
    assert.equal(state()!.updatedAt, t);
    assert.equal(calls, 3);
    epoch = null;
    assert.deepEqual(await quote(), { ...sample, status: 'snapshot' });
    assert.equal(calls, 3, '断开时不使用上一次连接的实时身份，也不等待 IPC');
    epoch = 'two';
    assert.equal((await quote()).status, 'snapshot');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal((await quote()).status, 'live');
    assert.equal(calls, 4);
    assert.equal(state()!.updatedAt, t);
  } finally { store.close(); }
});

test('Var 公共行情可恢复；认证价格不落库，凭据失效后只能复用公开价格', async () => {
  let t = Date.UTC(2026, 10, 13, 9, 0, 7), token: string | null = null, revision = 0;
  const now = () => t, venues = fakeAnthropicVenues({ now });
  const store = createMonitorStore({ file: ':memory:', now });
  const session = { current: () => ({ token, revision, status: token ? 'ready' : 'expired' }), report() {} } as unknown as VariationalSession;
  const reader = createExchangeReader({ gate: createBinanceGate(), quoteStore: store, now, log() {}, variationalSession: session,
    fetchImpl: venues.fetch, variationalFetch: venues.variationalFetch, oilQuote: () => null, hynixQuote: () => null });
  const quote = () => reader.quote('oil', 'variational');
  try {
    const first = await quote();
    assert.equal(first.timestampBasis, 'received');
    const saved = store.readState('comparison.v1.oil.variational');
    token = fakeVariationalToken(t + 86_400_000); revision++;
    const auth = await quote();
    assert.equal(auth.timestampBasis, 'source');
    assert.notEqual(auth.left.price, first.left.price);
    assert.deepEqual(store.readState('comparison.v1.oil.variational'), saved);
    t += 1_000;
    const beforeExpiry = quote();
    token = null; venues.exchangeDown.add('variational');
    assert.deepEqual(await beforeExpiry, { ...first, status: 'snapshot' }, '过期之前订阅了认证缓存也不能在过期后交付');
    assert.deepEqual(await quote(), { ...first, status: 'snapshot' }, '同一修订号失去认证时立即弃用认证价格');
  } finally { reader.stop(); store.close(); }
});

test('Var 认证失败可当次恢复公开快照；换凭据时只交付新认证价，监控重开和停服作废迟到结果', async () => {
  for (const action of ['denied', 'reenabled', 'rotated', 'rotated-failed', 'stopped'] as const) {
    let t = Date.UTC(2026, 10, 13, 9, 0, 7), run = 0, revision = 0, token: string | null = null;
    const now = () => t, venues = fakeAnthropicVenues({ now }), store = createMonitorStore({ file: ':memory:', now });
    const session = { current: () => ({ token, revision, status: token ? 'ready' : 'missing' }),
      report(seen: number, status: string) { if (seen === revision && status === 'rejected') token = null; } } as unknown as VariationalSession;
    let entered!: () => void, release!: () => void, hold = false;
    const publicStarted = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const reader = createExchangeReader({ gate: createBinanceGate(), quoteStore: store, controlRevision: () => run, now, log() {},
      variationalSession: session, variationalFetch: venues.variationalFetch, oilQuote: () => null, hynixQuote: () => null,
      fetchImpl: async (url, init) => {
        if (hold) { entered(); await resume; return new Response('{}', { status: 500 }); }
        return venues.fetch(url, init);
      } });
    const quote = () => reader.quote('oil', 'variational');
    try {
      const first = await quote();
      t += 2_000; revision++; token = fakeVariationalToken(t + 86_400_000);
      hold = true; venues.variationalMode = 'reject';
      const pending = quote();
      await publicStarted;
      assert.equal(token, null, '同一请求内交易所明确拒绝了认证');
      if (action === 'reenabled') run += 2;
      if (action === 'rotated' || action === 'rotated-failed') {
        revision++; token = fakeVariationalToken(t + 86_400_000, 'another');
        venues.variationalMode = action === 'rotated' ? 'accept' : 'reject';
      }
      if (action === 'stopped') reader.stop();
      release();
      if (action === 'denied') assert.deepEqual(await pending, { ...first, status: 'snapshot' });
      else if (action === 'rotated') {
        const fresh = await pending;
        assert.equal(fresh.timestampBasis, 'source');
        assert.notEqual(fresh.left.price, first.left.price);
      } else await assert.rejects(pending, action === 'reenabled' ? /监控开关已切换/ : action === 'stopped' ? /abort|中止|停止|超时/i : /HTTP 500/);
      assert.deepEqual(store.readState('comparison.v1.oil.variational')?.value, first);
    } finally { release(); reader.stop(); store.close(); }
  }
});

test('Var 认证价格可继续显示；等待交付期间跨结算或资金费来源断开、换代都撤下旧费率', async () => {
  for (const when of ['cache-settled', 'cache-epoch', 'marks-disconnected', 'marks-reconnected'] as const) {
    let t = Date.UTC(2026, 10, 13, 9, 0, 7), epoch: string | null = 'one';
    const now = () => t, venues = fakeAnthropicVenues({ now }), store = createMonitorStore({ file: ':memory:', now });
    const token = fakeVariationalToken(t + 86_400_000);
    const session = { current: () => ({ token, revision: 1, status: 'ready' }), report() {} } as unknown as VariationalSession;
    let fundingRead!: () => void, release!: () => void, fundingCount = 0;
    const started = new Promise<void>(resolve => { fundingRead = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const cacheHit = when.startsWith('cache');
    const unused = () => { throw new Error('unexpected source'); };
    const remote: RemoteComparison = { quote: unused, history: unused, variationalMarks: unused,
      async variationalFunding() {
        fundingCount++; fundingRead();
        const nextFundingAt = new Date(t + 750).toISOString(), rate = { fundingRate: 0.0002, fundingIntervalHours: 8, nextFundingAt };
        return { left: rate, right: rate, fetchedAt: new Date(t).toISOString() };
      } };
    const reader = createExchangeReader({ gate: createBinanceGate(), quoteStore: store, remote, epoch: () => epoch, now, log() {}, variationalSession: session,
      variationalFetch: async (url, init) => { if (!cacheHit) await resume; return venues.variationalFetch(url, init); },
      oilQuote: () => null, hynixQuote: () => null });
    const quote = () => reader.quote('oil', 'variational');
    try {
      if (cacheHit) {
        const first = await quote(); assert.equal(first.left.fundingRate, 0.0002);
      }
      const pending = quote();
      await started;
      if (!cacheHit) await new Promise<void>(resolve => setImmediate(resolve));
      if (when === 'cache-settled') t += 750;
      else epoch = when === 'marks-disconnected' ? null : 'two';
      release();
      const result = await pending;
      assert.deepEqual([result.status, result.timestampBasis, result.left.fundingRate, result.right.fundingRate, result.left.nextFundingAt, result.fundingFetchedAt],
        ['live', 'source', null, null, null, null], when);
      assert.match(result.fundingError, when === 'cache-settled' ? /结算时间已到/ : /行情服务连接已切换/);
      assert.equal(calculateExchangeSpread(result).shortAnnualized, null);
      assert.equal(fundingCount, 1, '同一轮只读取一次公开资金费');
    } finally { release(); reader.stop(); store.close(); }
  }
});

test('合约目录：60 秒后才重读；重读失败时 10 分钟内沿用旧目录，超过后整行失败', async () => {
  let catalogDown = false;
  const catalogs: string[] = [];
  const { reader, advance } = setup({
    fetchWrap: fetch => async (url, init) => {
      if (url.includes('/instruments-info')) { catalogs.push(url); if (catalogDown) return new Response('{}', { status: 500 }); }
      return fetch(url, init);
    },
  });
  await reader.quote('oil', 'bybit');
  assert.equal(catalogs.length, 2);
  advance(30_000);
  await reader.quote('oil', 'bybit');
  assert.equal(catalogs.length, 2, '60 秒内沿用目录');
  advance(31_000);
  catalogDown = true;
  const quote = await reader.quote('oil', 'bybit');
  assert.equal(quote.exchange, 'bybit', '目录重读失败时沿用旧目录');
  assert.equal(catalogs.length, 4, '过期后照样去重读');
  advance(540_000);
  await assert.rejects(reader.quote('oil', 'bybit'), /HTTP 500/, '超过 10 分钟不再沿用');
  catalogDown = false;
  advance(EXCHANGE_RESULT_TTL_MS);
  await reader.quote('oil', 'bybit');
});

test('合约目录与资金费：HTTP 200 但错误码或缺合约的应答不进缓存，不顶掉旧目录', async () => {
  let broken = false;
  const { reader, advance } = setup({
    fetchWrap: fetch => async (url, init) => {
      if (broken && (url.includes('/public/instruments') || url.includes('/public/funding-rate'))) return new Response(JSON.stringify({ code: '50011', msg: 'busy', data: [] }), { status: 200 });
      return fetch(url, init);
    },
  });
  const first = await reader.quote('oil', 'okx');
  assert.ok(first.left.fundingRate !== null);
  advance(61_000);
  broken = true;
  const kept = await reader.quote('oil', 'okx');
  assert.equal(kept.exchange, 'okx', '坏目录不覆盖旧目录');
  assert.deepEqual([kept.left.fundingRate, kept.right.fundingRate], [null, null], '资金费坏应答只缺资金费');
  broken = false;
  advance(EXCHANGE_RESULT_TTL_MS);
  assert.ok((await reader.quote('oil', 'okx')).left.fundingRate !== null, '资金费坏应答没被缓存');
});

test('Binance：429/418 后整个服务共用冷却，冷却内不发请求；资金费接口失败不影响价格', async () => {
  const { reader, venues, gate, advance, now } = setup();
  venues.oilStatus = 429;
  await assert.rejects(reader.quote('hynix', 'binance'), (error: Error) => error.message === '接口限流（HTTP 429）');
  assert.deepEqual([gate.until, gate.status], [now() + 60_000, 429]);
  venues.oilStatus = null;
  const before = count(venues, 'exchange:binance');
  await assert.rejects(reader.quote('hynix', 'binance'), (error: Error) => error.message === '接口限流冷却中（HTTP 429）');
  assert.equal(count(venues, 'exchange:binance'), before, '冷却中不发请求');
  advance(60_000);
  venues.down.add('funding');
  const quote = await reader.quote('hynix', 'binance');
  assert.equal(quote.exchange, 'binance');
  assert.deepEqual([quote.left.fundingRate, quote.right.fundingRate, quote.left.fundingIntervalHours], [null, null, null], '周期缺失时两腿都不给费率');
  assert.ok(quote.fundingError.length > 0);
  assert.equal(calculateExchangeSpread(quote).shortAnnualized, null, '不按零费率算年化');

  advance(EXCHANGE_RESULT_TTL_MS);
  venues.oilStatus = 418;
  await assert.rejects(reader.quote('hynix', 'binance'), /HTTP 418/);
  assert.equal(gate.until, now() + 120_000);
});

test('Binance 原油行与 Hyperliquid 海力士行：取采集器的报价，不额外读 Binance 或 allMids；没有报价时说明在采集，不记失败日志', async () => {
  const { reader, venues, logs, setHynix } = setup();
  setHynix(null);
  await assert.rejects(reader.quote('hynix', 'hyperliquid'), (error: Error) => error.message === '尚未取得海力士报价，后台正在采集');
  await assert.rejects(reader.quote('oil', 'binance'), (error: Error) => error.message === '尚未取得原油报价，后台正在采集');
  assert.deepEqual(logs, []);
  setHynix('live');
  const live = await reader.quote('hynix', 'hyperliquid');
  assert.ok(live.left.fundingRate !== null && live.fundingFetchedAt, '实时报价接上 xyz 资金费');
  assert.equal(live.left.nextFundingEstimated, true);
  assert.equal(count(venues, 'quote:hynix'), 0, '不读 allMids');
});

test('Hyperliquid 海力士：资金费读不到或报价是旧快照时仍给价格行，不接资金费', async () => {
  const { reader, venues, advance, setHynix } = setup();
  venues.exchangeDown.add('hyperliquid');
  const missing = await reader.quote('hynix', 'hyperliquid');
  assert.deepEqual([missing.left.fundingRate, missing.right.fundingRate], [null, null]);
  venues.exchangeDown.delete('hyperliquid');
  advance(EXCHANGE_RESULT_TTL_MS);
  setHynix('snapshot');
  const reads = count(venues, 'quote:xyz');
  const snapshot = await reader.quote('hynix', 'hyperliquid');
  assert.deepEqual([snapshot.left.fundingRate, count(venues, 'quote:xyz')], [null, reads], '旧快照不读资金费');
});

test('Lighter：目录 + 只读订阅取双腿快照；被拒绝、无应答超时与停止都给中文原因', async () => {
  const { reader, venues, advance } = setup();
  const quote = await reader.quote('oil', 'lighter');
  assert.deepEqual([quote.exchange, quote.left.symbol, quote.right.symbol], ['lighter', 'BRENTOIL', 'WTI']);
  assert.equal(count(venues, 'exchange:lighter-socket'), 1);
  advance(EXCHANGE_RESULT_TTL_MS);
  venues.lighterMode = 'reject';
  await assert.rejects(reader.quote('oil', 'lighter'), (error: Error) => error.message === 'Lighter 行情订阅被拒绝');

  venues.lighterMode = 'silent';
  const markets = [{ symbol: 'BRENTOIL', marketId: 91 }, { symbol: 'WTI', marketId: 92 }];
  await assert.rejects(readLighterOilSnapshot(markets as never, { WebSocketImpl: venues.WebSocket, timeoutMs: 20 }), /Lighter 原油双腿行情读取超时/);
  assert.match(LIGHTER_SOCKET, /^wss:\/\//);
  advance(EXCHANGE_RESULT_TTL_MS);
  const pending = reader.quote('oil', 'lighter');
  setTimeout(() => reader.stop(), 10);
  await assert.rejects(pending, (error: Error) => error.message === 'Lighter 行情读取已停止');
});

test('停止：进行中的请求立即中止，之后不再记失败日志', async () => {
  const { reader, venues, logs } = setup();
  let release!: () => void;
  venues.hold = new Promise(resolve => { release = resolve; });
  const pending = reader.quote('oil', 'okx');
  await new Promise(resolve => setTimeout(resolve, 5));
  reader.stop();
  await assert.rejects(pending, (error: Error) => error.message === '请求超时');
  assert.deepEqual(logs, []);
  release();
});

test('原因文本：只给固定中文，不带上游内容', () => {
  const cases: [unknown, string][] = [
    [new Error('Exchange market HTTP 451'), '服务器所在地区被拒绝访问（HTTP 451）'],
    [new Error('Exchange market HTTP 503'), '接口返回 HTTP 503'],
    [Object.assign(new Error('x'), { name: 'TimeoutError' }), '请求超时'],
    [new Error('Lighter BRENTOIL 合约暂不可用或规格已变化'), 'Lighter BRENTOIL 合约暂不可用或规格已变化'],
    [new Error('Unsupported Bybit contract'), '合约不可用或规格已变化'],
    [new Error('Lighter oil contract unavailable'), '合约不可用或规格已变化'],
    [new Error('CEX funding history pagination exceeded page limit'), '历史分页不完整'],
    [new Error('Invalid Gate funding page'), '历史分页不完整'],
    [new Error('Gate funding page outside requested range'), '历史分页不完整'],
    [new Error('Exchange legs not synchronized'), '两腿报价时间不同步'],
    [new Error('Delayed or invalid quote time'), '报价时间过旧或无效'],
    [new SyntaxError('Unexpected token \'<\', "<html>secret-body" is not valid JSON'), '响应无效或网络失败'],
    [new Error('Lighter says hello <script>'), '响应无效或网络失败'],
    ['plain', '响应无效或网络失败'],
    [null, '响应无效或网络失败'],
  ];
  for (const [error, reason] of cases) assert.equal(exchangeError(error), reason, String((error as Error)?.message ?? error));
});

test('接口：未登录 401；未配置的市场与不支持的交易所 404；读取失败 503 带原因；成功 200 且页面规则接受', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-monitor-exchanges-'));
  const venues = fakeAnthropicVenues();
  const config = parseServiceConfig({ secretsFile: '/etc/tp/secrets.json', monitor: { hynix: {} } });
  const runtime = openMonitor(config.monitor!, dir, { fetchImpl: venues.fetch, WebSocketImpl: venues.WebSocket, log: () => undefined });
  const h = createHarness();
  const server = createExecutorServer({ executor: h.ex, accessToken: 'monitor-token-0004', views: { monitor: monitorViews(runtime) } });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const cookie = ((await fetch(`${base}/login?token=monitor-token-0004`, { redirect: 'manual' })).headers.get('set-cookie') ?? '').split(';')[0]!;
    const get = async (path: string) => { const response = await fetch(base + path, { headers: { cookie } }); return { status: response.status, body: await response.json() as Record<string, any> }; };
    assert.equal((await fetch(`${base}/api/monitor/hynix/exchanges/gate`)).status, 401);
    assert.deepEqual([(await get('/api/monitor/oil/exchanges/bybit')).status, (await get('/api/monitor/hynix/exchanges/lighter')).body.message], [404, '海力士交易所对比不支持 lighter']);
    assert.equal((await get('/api/monitor/hynix/exchanges/variational')).status, 404);
    assert.equal((await get('/api/monitor/hynix/exchanges/BYBIT')).status, 404);
    const waiting = await get('/api/monitor/hynix/exchanges/hyperliquid');
    assert.deepEqual([waiting.status, waiting.body.code, waiting.body.message], [503, 'exchange_unavailable', '尚未取得海力士报价，后台正在采集']);
    venues.exchangeDown.add('okx');
    assert.deepEqual([(await get('/api/monitor/hynix/exchanges/okx')).status, (await get('/api/monitor/hynix/exchanges/okx')).body.message], [503, '接口返回 HTTP 500']);
    const gate = await get('/api/monitor/hynix/exchanges/gate');
    assert.equal(gate.status, 200);
    assert.equal(validateExchangeQuote(gate.body, 'gate', 'hynix').exchange, 'gate');
    await runtime.hynix!.refreshQuote();
    assert.equal((await get('/api/monitor/hynix/exchanges/hyperliquid')).status, 200);
  } finally {
    await new Promise(resolve => server.close(resolve));
    h.dispose();
    stopMonitor(runtime); closeMonitor(runtime);
    rmSync(dir, { recursive: true, force: true });
  }
});
