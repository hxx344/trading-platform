// Monitor M-2d-3: the settlement history under the comparison table. The vendored workbench rules
// (src/vendor/exchange-funding-history.mjs), the on-demand reader in src/monitor/exchanges.ts and the endpoint. Every venue is
// the stand-in in monitor-fake.ts unless a test hands the reader its own replies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { COMPARISON_EXCHANGES, exchangeDefinition, type Exchange, type SpreadMarket } from '../src/vendor/exchange-comparison.mjs';
import {
  HISTORY_LEG_LIMIT, HISTORY_REFRESH_MS, HISTORY_WINDOW_MS, analyzeFundingRange, createFundingLegReader, fundingRangeInput, mergeFundingHistory,
  normalizeSettledFunding, parseCexFundingHistory, parseFundingRangeInput, parseGateFundingHistory, parseHyperliquidFundingHistory, parseLighterFundingHistory,
  validateExchangeFundingHistory, type ExchangeFundingHistory, type FundingLegReader,
} from '../src/vendor/exchange-funding-history.mjs';
import { createBinanceGate } from '../src/vendor/anthropic-market.mjs';
import { FUNDING_HISTORY_DEADLINE_MS, FUNDING_HISTORY_SNAPSHOT_MS, createExchangeReader } from '../src/monitor/exchanges.ts';
import { parseServiceConfig } from '../src/service/config.ts';
import { monitorViews, openMonitor, stopMonitor } from '../src/service/monitor.ts';
import { createExecutorServer } from '../src/http.ts';
import { createHarness } from './harness.ts';
import { SETTLE_HOURS, fakeAnthropicVenues, venueSettledRate } from './monitor-fake.ts';

const NOW = Date.UTC(2026, 9, 1, 10), HOUR = 3_600_000, DAY = 86_400_000;
const BASES = { oil: ['BZ', 'CL'], hynix: ['SKHY', 'SKHYNIX'] } as const;

function snapshot(exchange: Exchange = 'hyperliquid', now = NOW, market: SpreadMarket = 'oil'): ExchangeFundingHistory {
  const definition = exchangeDefinition(exchange, market), fetchedAt = new Date(now).toISOString();
  return validateExchangeFundingHistory({ exchange, monitorId: market, currency: definition.currency, fetchedAt, status: 'live', reason: '',
    left: { symbol: definition.left, fetchedAt, error: '', coverage: { from: now - HISTORY_WINDOW_MS, to: now } }, right: { symbol: definition.right, fetchedAt, error: '', coverage: { from: now - HISTORY_WINDOW_MS, to: now } },
    rows: [{ time: now - HOUR + 21, leftRate: 0, rightRate: null }, { time: now - HOUR + 32, leftRate: null, rightRate: -0.0001 }] }, exchange, market);
}

test('整理：60 天内超过 200 条全部保留；超过上限、同一时间两个费率、非法费率都拒绝，不截断', () => {
  const rows = Array.from({ length: 1441 }, (_, index) => ({ time: NOW - index * HOUR, rate: index ? -0.0001 : 0 }));
  const parsed = normalizeSettledFunding([...rows, rows[0]!, { time: NOW + 1, rate: 0.01 }, { time: NOW - HISTORY_WINDOW_MS - 1, rate: 0.01 }], NOW);
  assert.equal(parsed.length, 1441);
  assert.deepEqual(parsed[0], { time: NOW, rate: 0 });
  assert.equal(parsed.at(-1)!.time, NOW - HISTORY_WINDOW_MS);
  assert.throws(() => normalizeSettledFunding(Array.from({ length: HISTORY_LEG_LIMIT + 1 }, (_, i) => ({ time: NOW - i, rate: 0 })), NOW), /Too many/);
  assert.throws(() => normalizeSettledFunding([{ time: NOW, rate: 0 }, { time: NOW, rate: 1 }], NOW), /Conflicting/);
  for (const value of [NaN, Infinity, null, '0', 1.1]) assert.throws(() => normalizeSettledFunding([{ time: NOW, rate: value as number }], NOW));
});

test('解析：Hyperliquid 取结算费率；Lighter 百分点 + 付款方向；Gate 秒级时间；CEX 要官方成功信封，OKX 只取实际费率，Binance 接受 Special', () => {
  assert.deepEqual(parseHyperliquidFundingHistory([{ coin: 'xyz:BRENTOIL', time: NOW - HOUR + 21, fundingRate: '0' }], 'xyz:BRENTOIL', NOW), [{ time: NOW - HOUR + 21, rate: 0 }]);
  assert.throws(() => parseHyperliquidFundingHistory([{ coin: 'xyz:BRENTOIL', time: NOW, fundingRate: '0' }], 'xyz:CL', NOW), /mismatch/);
  assert.throws(() => parseHyperliquidFundingHistory([], 'xyz:ANT', NOW), /Unknown/);
  const lighter = { code: 200, fundings: [{ timestamp: NOW / 1000 - 3600, rate: '0.0003', direction: 'short' }, { timestamp: NOW / 1000 - 7200, rate: '0.0007', direction: 'long' }, { timestamp: NOW / 1000 - 10800, rate: '0', direction: 'short' }] };
  const parsed = parseLighterFundingHistory(lighter, 145, NOW);
  assert.ok(Math.abs(parsed[0]!.rate + 0.000003) < 1e-15);
  assert.ok(Math.abs(parsed[1]!.rate - 0.000007) < 1e-15);
  assert.equal(parsed[2]!.rate, 0);
  for (const patch of [{ rate: '-0.001' }, { rate: '' }, { direction: 'unknown' }, { market_id: 159 }, { timestamp: NOW }]) {
    assert.throws(() => parseLighterFundingHistory({ code: 200, fundings: [{ ...lighter.fundings[0], ...patch }] }, 145, NOW));
  }
  assert.throws(() => parseLighterFundingHistory({ code: 400, fundings: [] }, 145, NOW));
  assert.deepEqual(parseGateFundingHistory([{ t: NOW / 1000 - 3600, r: '0.0001' }], NOW), [{ time: NOW - HOUR, rate: 0.0001 }]);
  assert.throws(() => parseGateFundingHistory([{ t: NOW - HOUR, r: '0.0001' }], NOW), /Invalid Gate/);

  assert.throws(() => parseCexFundingHistory('bybit', 'BZUSDT', { retCode: 10001, result: { list: [] } }, NOW), /Bybit/);
  assert.throws(() => parseCexFundingHistory('okx', 'BZ-USDT-SWAP', { code: '51001', data: [] }, NOW));
  assert.throws(() => parseCexFundingHistory('bitget', 'BZUSDT', { code: '40034', data: [] }, NOW));
  assert.throws(() => parseCexFundingHistory('binance', 'BZUSDT', { code: -1121, msg: 'Invalid symbol.' }, NOW));
  const okx = parseCexFundingHistory('okx', 'BZ-USDT-SWAP', { code: '0', data: [{ instId: 'BZ-USDT-SWAP', instType: 'SWAP', fundingTime: String(NOW - HOUR), fundingRate: '0.0009', realizedRate: '0', method: 'next_period' }] }, NOW);
  assert.deepEqual(okx, [{ time: NOW - HOUR, rate: 0 }]);
  assert.deepEqual(parseCexFundingHistory('binance', 'SKHYUSDT', [{ symbol: 'SKHYUSDT', fundingTime: NOW - HOUR, fundingRate: '-0.0125', rateType: 'Special' }], NOW), [{ time: NOW - HOUR, rate: -0.0125 }]);
  assert.throws(() => parseCexFundingHistory('binance', 'SKHYUSDT', [{ symbol: 'SKHYUSDT', fundingTime: NOW - HOUR, fundingRate: '0', rateType: 'Forecast' }], NOW), /rate type/);
  assert.throws(() => parseCexFundingHistory('bybit', 'BZUSDT', { retCode: 0, result: { list: [{ symbol: 'CLUSDT', fundingRate: '0', fundingRateTimestamp: String(NOW) }] } }, NOW), /mismatch/);
  // A seconds timestamp must not pass as a 1970 settlement.
  assert.throws(() => parseCexFundingHistory('bitget', 'BZUSDT', { code: '00000', data: [{ symbol: 'BZUSDT', fundingRate: '0', fundingTime: String(NOW / 1000) }] }, NOW), /timestamp/);
  assert.throws(() => parseCexFundingHistory('bybit', 'SKHY_USDT', { retCode: 0, result: { list: [] } }, NOW), /Unsupported/);
});

test('快照校验：合约、币种、未来结算、重复时间、覆盖范围外的记录都拒绝；页面规则只接受本服务支持的交易所', () => {
  const value = snapshot();
  for (const patch of [{ exchange: 'binance' }, { monitorId: 'hynix' }, { currency: 'USDT' }, { left: { ...value.left, fetchedAt: null } }, { left: { ...value.left, symbol: 'xyz:CL' } },
    { rows: [{ time: NOW + 1, leftRate: 0, rightRate: null }] }, { rows: [{ time: NOW, leftRate: '', rightRate: null }] }, { rows: [{ time: NOW, leftRate: null, rightRate: null }] }, { rows: [...value.rows, value.rows[0]] }, { status: 'cached' }]) {
    assert.throws(() => validateExchangeFundingHistory({ ...value, ...patch }, 'hyperliquid', 'oil'), JSON.stringify(patch));
  }
  for (const coverage of [{ from: NOW, to: NOW - 1 }, { from: NOW - HOUR, to: NOW + 1 }, { from: NOW - 1, to: NOW }]) assert.throws(() => validateExchangeFundingHistory({ ...value, left: { ...value.left, coverage } }, 'hyperliquid', 'oil'));
  assert.throws(() => validateExchangeFundingHistory(value, 'variational', 'oil'), /Unsupported/);
  assert.throws(() => validateExchangeFundingHistory(snapshot('gate', NOW, 'hynix'), 'gate', 'oil'), /Unsupported/);
  assert.equal(validateExchangeFundingHistory(JSON.parse(JSON.stringify(snapshot('gate', NOW, 'hynix'))), 'gate', 'hynix').left.symbol, 'SKHY_USDT');
});

test('区间统计：UTC 输入；含开始不含结束；超过 200 条全部累计；无记录不是零费率；覆盖不全如实标注', () => {
  assert.equal(parseFundingRangeInput('2026-10-01T10:00'), NOW);
  assert.equal(fundingRangeInput(NOW), '2026-10-01T10:00');
  for (const input of ['2026-02-30T10:00', '2026-10-01 10:00', '2026-10-01T24:00', '']) assert.equal(parseFundingRangeInput(input), null, input);
  const definition = exchangeDefinition('bybit', 'hynix'), fetchedAt = new Date(NOW).toISOString();
  const rows = Array.from({ length: 300 }, (_, i) => ({ time: NOW - i * HOUR, leftRate: 0.0001, rightRate: i % 2 ? null : -0.0002 }));
  const history = validateExchangeFundingHistory({ exchange: 'bybit', monitorId: 'hynix', currency: definition.currency, fetchedAt, status: 'live', reason: '',
    left: { symbol: definition.left, fetchedAt, error: '', coverage: { from: NOW - 299 * HOUR, to: NOW } }, right: { symbol: definition.right, fetchedAt, error: '', coverage: null }, rows }, 'bybit', 'hynix');
  const short = analyzeFundingRange(history, { from: NOW - 300 * HOUR, to: NOW }, 'short');
  // [from, to): the row at NOW is outside, the one at NOW - 299 h inside.
  assert.equal(short.left.count, 299);
  assert.ok(Math.abs(short.left.rawRate! - 0.0299) < 1e-15);
  assert.equal(short.left.positionRate, short.left.rawRate, '做空左腿：正费率收款');
  assert.equal(short.left.coverage, 'partial');
  assert.equal(short.right.coverage, 'unknown');
  const long = analyzeFundingRange(history, { from: NOW - 50 * HOUR, to: NOW }, 'long');
  assert.equal(long.left.coverage, 'queried');
  assert.equal(long.left.positionRate, -long.left.rawRate!);
  assert.ok(long.right.positionRate! < 0, '做多价差空右腿：负费率付款');
  const empty = analyzeFundingRange({ ...history, rows: [] }, { from: NOW - HOUR, to: NOW }, 'short');
  assert.deepEqual([empty.left.rawRate, empty.left.positionRate, empty.left.count], [null, null, 0]);
  assert.throws(() => analyzeFundingRange(history, { from: NOW - HISTORY_WINDOW_MS - 1, to: NOW }, 'short'), /60 天/);
  assert.throws(() => analyzeFundingRange(history, { from: NOW, to: NOW }, 'short'));
});

test('两腿合并：一腿失败保留旧记录与旧采集时间、覆盖随 60 天窗口收缩；两腿都失败才报错；增量只回读最后一天', async () => {
  let now = NOW, fail = '';
  const ranges: Record<string, { from: number; to: number }[]> = {};
  const readLeg: FundingLegReader = async (_exchange, symbol, range) => {
    (ranges[symbol] ??= []).push(range);
    if (fail === 'all' || symbol === fail) throw new Error('Exchange market HTTP 503');
    return [{ time: now - HOUR + (symbol.endsWith('CL') ? 32 : 21), rate: symbol.endsWith('CL') ? -0.0001 : 0 }];
  };
  const initial = await mergeFundingHistory({ exchange: 'hyperliquid', monitorId: 'oil', readLeg, clock: () => now });
  assert.equal(initial.rows.length, 2);
  assert.ok(initial.rows.every(row => (row.leftRate === null) !== (row.rightRate === null)), '两腿各自的结算时间，不按时间桶配对');
  assert.deepEqual(ranges['xyz:CL']![0], { from: NOW - HISTORY_WINDOW_MS, to: NOW });
  now += HISTORY_REFRESH_MS; fail = 'xyz:CL';
  const partial = await mergeFundingHistory({ exchange: 'hyperliquid', monitorId: 'oil', previous: initial, readLeg, clock: () => now });
  assert.deepEqual(ranges['xyz:BRENTOIL']![1], { from: NOW - DAY, to: now }, '增量从上次覆盖终点前一天读起');
  assert.equal(partial.left.fetchedAt, new Date(now).toISOString());
  assert.equal(partial.right.fetchedAt, initial.right.fetchedAt);
  assert.ok(partial.right.error && partial.reason);
  assert.deepEqual(partial.right.coverage, { from: now - HISTORY_WINDOW_MS, to: NOW });
  assert.deepEqual(partial.rows.find(row => row.rightRate !== null), initial.rows.find(row => row.rightRate !== null));
  const fresh = await mergeFundingHistory({ exchange: 'hyperliquid', monitorId: 'oil', readLeg, clock: () => now });
  assert.equal(fresh.right.fetchedAt, null);
  assert.equal(fresh.right.coverage, null);
  // Once the old coverage leaves the window, the failed leg claims nothing and its expired rows are gone.
  now = NOW + HISTORY_WINDOW_MS + HOUR;
  const expired = await mergeFundingHistory({ exchange: 'hyperliquid', monitorId: 'oil', previous: partial, readLeg, clock: () => now });
  assert.equal(expired.right.coverage, null);
  assert.ok(expired.rows.every(row => row.rightRate === null));
  fail = 'all';
  await assert.rejects(mergeFundingHistory({ exchange: 'hyperliquid', monitorId: 'oil', previous: partial, readLeg, clock: () => now }), /unavailable/);
});

test('分页：Bybit 按 endTime 往前翻到覆盖起点；空历史算查过；超大页、不前进、页数上限都按读取不完整报错', async () => {
  const urls: string[] = [];
  let page: (url: URL) => unknown = () => ({ retCode: 0, result: { list: [] } });
  const reader = createFundingLegReader({ request: async url => { urls.push(url); return page(new URL(url)); }, clock: () => NOW, lighterMarkets: async () => [] });
  const range = { from: NOW - HISTORY_WINDOW_MS, to: NOW };
  assert.deepEqual(await reader('bybit', 'BZUSDT', range), []);
  // 8-hourly settlements across 60 days: 181 rows, one full page of 200 is never reached, so a second scenario uses hourly.
  const hourly = (end: number) => Array.from({ length: 200 }, (_, i) => end - (end % HOUR) - i * HOUR).filter(t => t >= NOW - 70 * DAY);
  page = url => ({ retCode: 0, result: { category: 'linear', list: hourly(Number(url.searchParams.get('endTime'))).map(t => ({ symbol: 'BZUSDT', fundingRate: '0.0001', fundingRateTimestamp: String(t) })) } });
  urls.length = 0;
  const rows = await reader('bybit', 'BZUSDT', range);
  assert.equal(rows.length, 1441);
  assert.equal(urls.length, 8);
  assert.equal(new URL(urls[1]!).searchParams.get('endTime'), String(NOW - 199 * HOUR - 1), '下一页从本页最早一条前 1 毫秒读起');
  // Binance pages forward from startTime (next page from the newest + 1 ms), OKX backwards with an exclusive `after`.
  const grid = (from: number, to: number) => Array.from({ length: Math.floor(to / HOUR) - Math.ceil(from / HOUR) + 1 }, (_, i) => Math.ceil(from / HOUR) * HOUR + i * HOUR);
  page = url => grid(Number(url.searchParams.get('startTime')), Number(url.searchParams.get('endTime'))).slice(0, 1000).map(t => ({ symbol: 'SKHYUSDT', fundingTime: t, fundingRate: '0.0001' }));
  urls.length = 0;
  assert.equal((await reader('binance', 'SKHYUSDT', range)).length, 1441);
  assert.equal(urls.length, 2);
  assert.equal(new URL(urls[1]!).searchParams.get('startTime'), String(NOW - HISTORY_WINDOW_MS + 999 * HOUR + 1), 'Binance 下一页从本页最新一条后 1 毫秒读起');
  page = url => ({ code: '0', data: grid(NOW - 70 * DAY, Number(url.searchParams.get('after')) - 1).reverse().slice(0, 400).map(t => ({ instId: 'SKHY-USDT-SWAP', instType: 'SWAP', fundingTime: String(t), fundingRate: '0.0001', realizedRate: '0.0001', method: 'current_period' })) });
  urls.length = 0;
  assert.equal((await reader('okx', 'SKHY-USDT-SWAP', range)).length, 1441);
  assert.equal(urls.length, 4);
  assert.equal(new URL(urls[1]!).searchParams.get('after'), String(NOW - 399 * HOUR), 'OKX 下一页以本页最早一条为界（after 不含）');
  page = () => ({ retCode: 0, result: { list: Array.from({ length: 201 }, (_, i) => ({ symbol: 'BZUSDT', fundingRate: '0', fundingRateTimestamp: String(NOW - i * HOUR) })) } });
  await assert.rejects(reader('bybit', 'BZUSDT', range), /page size/);
  page = () => ({ retCode: 0, result: { list: Array.from({ length: 200 }, (_, i) => ({ symbol: 'BZUSDT', fundingRate: '0', fundingRateTimestamp: String(NOW - i * HOUR) })) } });
  await assert.rejects(reader('bybit', 'BZUSDT', range), /did not advance/);
  page = url => ({ code: '00000', data: Array.from({ length: 100 }, (_, i) => ({ symbol: 'BZUSDT', fundingRate: '0', fundingTime: String(NOW - ((Number(url.searchParams.get('pageNo')) - 1) * 100 + i) * 60_000) })) });
  await assert.rejects(reader('bitget', 'BZUSDT', range), /page limit/);
  page = () => { throw new Error('Exchange market HTTP 500'); };
  await assert.rejects(reader('okx', 'BZ-USDT-SWAP', range), /HTTP 500/);
});

/** A comparison reader on the stand-ins with a clock the test moves. */
function setup(fetchWrap?: (fetch: (url: string, init: RequestInit) => Promise<Response>) => (url: string, init: RequestInit) => Promise<Response>) {
  let t = Date.UTC(2026, 10, 13, 9, 0, 7);
  const now = () => t;
  const venues = fakeAnthropicVenues({ now });
  const logs: string[] = [];
  const reader = createExchangeReader({ gate: createBinanceGate(), now, log: line => logs.push(line), WebSocketImpl: venues.WebSocket, fetchImpl: fetchWrap ? fetchWrap(venues.fetch) : venues.fetch, oilQuote: () => null, hynixQuote: () => null });
  return { venues, logs, reader, now, advance: (ms: number) => { t += ms; } };
}

test('各交易所：替身上逐家读出两腿 60 天实际结算，费率来自该交易所该合约；页面规则接受服务给出的快照', async () => {
  const { reader, now } = setup();
  for (const market of ['oil', 'hynix'] as SpreadMarket[]) for (const exchange of COMPARISON_EXCHANGES[market] as readonly Exchange[]) {
    const label = `${market}/${exchange}`;
    const history = await reader.fundingHistory(market, exchange);
    assert.deepEqual([history.exchange, history.monitorId, history.status, history.reason], [exchange, market, 'live', ''], label);
    assert.deepEqual(validateExchangeFundingHistory(JSON.parse(JSON.stringify(history)), exchange, market), history, `${label} page`);
    for (const [index, side] of (['left', 'right'] as const).entries()) {
      const leg = history[side], rates = history.rows.filter(row => row[`${side}Rate`] !== null);
      assert.deepEqual([leg.error, leg.coverage], ['', { from: now() - HISTORY_WINDOW_MS, to: now() }], `${label} ${side}`);
      // Every settlement of the window, none lost to paging: the comparison venues settle on an exact grid; the collectors'
      // stand-ins (oil on Binance, Hynix on Hyperliquid) start later, so for them the rows must be gapless and reach now.
      const step = (market === 'hynix' && exchange === 'hyperliquid' ? 1 : SETTLE_HOURS[exchange]!) * HOUR, times = rates.map(row => row.time).sort((a, b) => a - b);
      if (market === 'oil' && exchange === 'binance' || market === 'hynix' && exchange === 'hyperliquid') {
        assert.ok(times.length > 20 && now() - times.at(-1)! < step, `${label} ${side} rows ${times.length}`);
        assert.ok(times.every((time, i) => !i || time - times[i - 1]! === step), `${label} ${side} gapless`);
      } else assert.equal(times.length, Math.floor(now() / step) - Math.ceil((now() - HISTORY_WINDOW_MS) / step) + 1, `${label} ${side} rows`);
      // Oil on Binance and Hynix on Hyperliquid are the collectors' stand-ins (their own waves); the rest follow the comparison venues' wave.
      if (!(market === 'oil' && exchange === 'binance') && !(market === 'hynix' && exchange === 'hyperliquid')) {
        const row = rates[0]!;
        assert.equal(row[`${side}Rate`], venueSettledRate(exchange, BASES[market][index]!, row.time), `${label} ${side} rate`);
      }
    }
  }
});

test('缓存：同一交易所 5 分钟内共用、并发只读一次；之后只回读最后一天，记录保留', async () => {
  const { venues, reader, advance } = setup();
  const count = () => venues.requests.get('exchange:bybit') ?? 0;
  const [a, b] = await Promise.all([reader.fundingHistory('hynix', 'bybit'), reader.fundingHistory('hynix', 'bybit')]);
  assert.equal(a, b);
  const first = count();
  assert.equal(first, 2, '8 小时结算 60 天不满一页：两腿各一次');
  advance(HISTORY_REFRESH_MS - 1);
  assert.equal(await reader.fundingHistory('hynix', 'bybit'), a);
  assert.equal(count(), first);
  advance(8 * HOUR);
  const next = await reader.fundingHistory('hynix', 'bybit');
  assert.equal(count(), first + 2);
  assert.ok(next.rows.length >= a.rows.length, '增量合并不丢旧记录');
  assert.ok(Date.parse(next.fetchedAt) > Date.parse(a.fetchedAt));
  // The hourly Hyperliquid history pages 500 at a time on the first read, then reads one page.
  const before = venues.requests.get('settled:skhy') ?? 0;
  await reader.fundingHistory('hynix', 'hyperliquid');
  const pages = (venues.requests.get('settled:skhy') ?? 0) - before;
  assert.ok(pages >= 2, `首次分页 ${pages}`);
  advance(HISTORY_REFRESH_MS);
  await reader.fundingHistory('hynix', 'hyperliquid');
  assert.equal((venues.requests.get('settled:skhy') ?? 0) - before, pages + 1);
});

test('失败：一腿失败给部分快照并记日志；两腿都失败时有旧快照就标旧 15 秒，没有就给中文原因；恢复记一次', async () => {
  const { venues, reader, logs, advance } = setup();
  venues.historyDown.add('okx:SKHYNIX');
  const partial = await reader.fundingHistory('hynix', 'okx');
  assert.equal(partial.status, 'live');
  assert.ok(partial.right.error && partial.reason);
  assert.equal(partial.right.fetchedAt, null);
  assert.equal(logs.filter(line => line.includes('hynix/okx/funding-history')).length, 1);
  assert.match(logs.at(-1)!, /接口返回 HTTP 500/);
  venues.historyDown.delete('okx:SKHYNIX');
  venues.exchangeDown.add('okx');
  advance(HISTORY_REFRESH_MS);
  const kept = await reader.fundingHistory('hynix', 'okx');
  assert.deepEqual([kept.status, kept.reason, kept.rows], ['snapshot', '历史结算费率暂时更新失败，保留上次成功记录。', partial.rows]);
  assert.equal(logs.filter(line => line.includes('hynix/okx/funding-history')).length, 1, '原因不变不重复记');
  advance(FUNDING_HISTORY_SNAPSHOT_MS - 1);
  assert.equal(await reader.fundingHistory('hynix', 'okx'), kept);
  venues.exchangeDown.delete('okx');
  advance(1);
  const back = await reader.fundingHistory('hynix', 'okx');
  assert.deepEqual([back.status, back.reason, back.right.error], ['live', '', '']);
  assert.match(logs.at(-1)!, /hynix\/okx\/funding-history 已恢复/);
  venues.exchangeDown.add('gate');
  await assert.rejects(reader.fundingHistory('hynix', 'gate'), { name: 'Error', message: '接口返回 HTTP 500' });
  // Nothing to keep: the failure is held 15 s, so pages retrying every 30 s do not each start a 60-day read.
  const gate = () => venues.requests.get('exchange:gate') ?? 0, sent = gate();
  venues.exchangeDown.delete('gate');
  await assert.rejects(reader.fundingHistory('hynix', 'gate'), /HTTP 500/);
  assert.equal(gate(), sent);
  advance(FUNDING_HISTORY_SNAPSHOT_MS);
  assert.equal((await reader.fundingHistory('hynix', 'gate')).status, 'live');
  assert.ok(gate() > sent);
  await assert.rejects(reader.fundingHistory('oil', 'gate'), /不支持的交易所/);
  await assert.rejects(reader.fundingHistory('oil', 'variational'), /不支持的交易所/);
});

test('时限：停止时进行中的历史读取给「请求超时」；Binance 限流后共用冷却，冷却中不发请求', async () => {
  const { venues, reader } = setup();
  // The 60 s whole-read deadline (FUNDING_HISTORY_DEADLINE_MS) aborts through the same signal as stopping; a real 60 s wait is not run here.
  assert.equal(FUNDING_HISTORY_DEADLINE_MS, 60_000);
  let release!: () => void;
  venues.hold = new Promise(resolve => { release = resolve; });
  const pending = reader.fundingHistory('hynix', 'bitget');
  await new Promise(resolve => setTimeout(resolve, 10));
  reader.stop();
  await assert.rejects(pending, (error: Error) => error.message === '请求超时');
  release();
  const fresh = setup();
  fresh.venues.oilStatus = 418;
  await assert.rejects(fresh.reader.fundingHistory('hynix', 'binance'), /限流/);
  fresh.venues.oilStatus = null;
  const before = fresh.venues.requests.get('exchange:binance') ?? 0;
  await assert.rejects(fresh.reader.fundingHistory('hynix', 'binance'), /限流（HTTP 418）/, '15 秒内给保留的失败');
  fresh.advance(FUNDING_HISTORY_SNAPSHOT_MS);
  await assert.rejects(fresh.reader.fundingHistory('hynix', 'binance'), /冷却/);
  assert.equal(fresh.venues.requests.get('exchange:binance') ?? 0, before);
});

test('接口：未配置的市场与不支持的交易所 404；读取失败 503 带原因；成功 200 且页面规则接受', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-monitor-history-'));
  const venues = fakeAnthropicVenues();
  const config = parseServiceConfig({ secretsFile: '/etc/tp/secrets.json', monitor: { hynix: {} } });
  const runtime = openMonitor(config.monitor!, dir, { fetchImpl: venues.fetch, WebSocketImpl: venues.WebSocket, log: () => undefined });
  const h = createHarness();
  const server = createExecutorServer({ executor: h.ex, accessToken: 'monitor-token-0005', views: { monitor: monitorViews(runtime) } });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const cookie = ((await fetch(`${base}/login?token=monitor-token-0005`, { redirect: 'manual' })).headers.get('set-cookie') ?? '').split(';')[0]!;
    const get = async (path: string) => { const response = await fetch(base + path, { headers: { cookie } }); return { status: response.status, body: await response.json() as Record<string, any> }; };
    assert.equal((await fetch(`${base}/api/monitor/hynix/exchanges/gate/funding-history`)).status, 401);
    assert.equal((await get('/api/monitor/oil/exchanges/bybit/funding-history')).status, 404);
    assert.deepEqual([(await get('/api/monitor/hynix/exchanges/lighter/funding-history')).status, (await get('/api/monitor/hynix/exchanges/lighter/funding-history')).body.message], [404, '海力士结算历史不支持 lighter']);
    assert.equal((await get('/api/monitor/hynix/exchanges/variational/funding-history')).status, 404);
    venues.exchangeDown.add('okx');
    const failed = await get('/api/monitor/hynix/exchanges/okx/funding-history');
    assert.deepEqual([failed.status, failed.body.code, failed.body.message], [503, 'funding_history_unavailable', '接口返回 HTTP 500']);
    const ok = await get('/api/monitor/hynix/exchanges/gate/funding-history');
    assert.equal(ok.status, 200);
    assert.equal(validateExchangeFundingHistory(ok.body, 'gate', 'hynix').left.symbol, 'SKHY_USDT');
  } finally {
    await new Promise(resolve => server.close(resolve));
    h.dispose();
    stopMonitor(runtime);
    rmSync(dir, { recursive: true, force: true });
  }
});
