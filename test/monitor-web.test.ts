// The monitor page's data rules (web/src/monitor-history.ts, monitor-oil.ts): which candle reads it accepts, when a read
// covers a range, and the chart's rows, ranges and sampling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANTHROPIC_CANDLE_MS, anthropicCandleWindow, anthropicPremium, createAnthropicCandles, perShare } from '../src/vendor/anthropic-market.mjs';
import { OIL_CANDLE_MS, createIntradaySnapshot, intradayWindow, oilSpread } from '../src/vendor/oil-market.mjs';
import { OIL_SPREAD_CHART, OIL_WARMUP_DAYS, coversOilRange, oilHistory, oilQuote } from '../web/src/monitor-oil.ts';
import { ANTHROPIC_WARMUP_DAYS, anthropicChartConfig, anthropicHistory, anthropicPoints, anthropicQuote, coversAnthropicRange, dailyPoints, sampleChartPoints, selectRange, type Point } from '../web/src/monitor-history.ts';

const DAY = 86_400_000, BAR = ANTHROPIC_CANDLE_MS;
const START = Date.parse('2026-09-01T00:00:00Z');
const shares = { outstanding: 12.7, diluted: 16.7 };
const rowsFor = (days: number) => Array.from({ length: days * 96 }, (_, i) => ({ time: START + i * BAR, binance: 1270 + i % 50, xyz: 99 + i % 3, io: 1670, rh: i % 10 ? 1600 : null }));
const snapshotOf = (days: number) => { const rows = rowsFor(days); return createAnthropicCandles(rows, new Date(rows.at(-1)!.time + BAR + 60_000).toISOString()); };

test('a complete read is its own coverage; a windowed read must carry the complete history it came from', () => {
  const snapshot = snapshotOf(40);
  const full = anthropicHistory({ ...snapshot, coverage: { ...snapshot.metadata } });
  assert.equal(full.windowDays, null);
  assert.equal(full.rows.length, 40 * 96);
  assert.deepEqual(full.coverage, { firstObservation: snapshot.metadata.firstObservation, lastObservation: snapshot.metadata.lastObservation, rows: 40 * 96 });
  const window = anthropicCandleWindow(snapshot, 7 + ANTHROPIC_WARMUP_DAYS);
  const windowed = anthropicHistory(window);
  assert.equal(windowed.windowDays, 28);
  assert.ok(windowed.rows.length < full.rows.length);
  assert.deepEqual(windowed.coverage, full.coverage, 'the coverage stays the complete history');
  assert.throws(() => anthropicHistory({ ...window, coverage: { ...window.coverage, lastObservation: snapshot.metadata.firstObservation } }), /coverage/);
  assert.throws(() => anthropicHistory({ ...window, coverage: { ...window.coverage, rows: 3 } }), /coverage/);
  assert.throws(() => anthropicHistory({ ...window, windowDays: 0 }), /window/);
  assert.throws(() => anthropicHistory({ ...snapshot, data: [] }));
  // A window wider than the history comes back as the history itself.
  assert.equal(anthropicHistory(anthropicCandleWindow(snapshotOf(10), 37)).windowDays, null);
});

test('a read covers a range only with the warmup days before it; only a complete read covers all of it', () => {
  const full = anthropicHistory(snapshotOf(40)), week = anthropicHistory(anthropicCandleWindow(snapshotOf(40), 7 + ANTHROPIC_WARMUP_DAYS));
  for (const range of [7, 30, null]) assert.equal(coversAnthropicRange(full, range), true);
  assert.equal(coversAnthropicRange(week, 7), true);
  assert.equal(coversAnthropicRange(week, 30), false);
  assert.equal(coversAnthropicRange(week, null), false);
});

test('chart rows are per share with the configured shares and match the quote premium', () => {
  const history = anthropicHistory(snapshotOf(2));
  const io = anthropicPoints(history.rows, 'io', shares), rh = anthropicPoints(history.rows, 'rh', shares);
  const first = history.rows[0];
  assert.equal(io[0].adr, perShare('binance', first.binance!, shares));
  assert.equal(io[0].equivalent, perShare('io', first.io!, shares));
  assert.ok(Math.abs(io[0].premium - anthropicPremium(first.binance, first.io, 'io', shares)!) < 1e-9);
  assert.equal(rh.length, history.rows.filter(row => row.rh !== null).length, 'a bar missing one leg is left out, not filled');
  assert.deepEqual(anthropicPoints(history.rows, 'io', null), [], 'without shares nothing is converted');
  assert.equal(anthropicChartConfig('rh').units.premium, '% · Binance 相对 Lighter RH');
  assert.equal(anthropicChartConfig('xyz').tick.premium!(1.234), '1.23%');
});

test('the quote keeps only the service\'s snapshot mark beside the validated marks', () => {
  const raw = { fetchedAt: new Date(START).toISOString(), binance: { markPx: 1270, fundingRate: 0.0001, nextFundingTime: null }, xyz: null, io: null, rh: null, errors: { xyz: '响应无效或网络失败' } };
  assert.equal(anthropicQuote({ ...raw, status: 'snapshot' }).status, 'snapshot');
  assert.equal(anthropicQuote({ ...raw, status: 'live' }).status, 'live');
  assert.equal(anthropicQuote({ ...raw, status: 'whatever' }).status, 'snapshot', 'anything but live is shown as stale');
  assert.equal(anthropicQuote(raw).status, 'snapshot');
  assert.throws(() => anthropicQuote({ ...raw, fetchedAt: 'never' }));
});

test('ranges count back from the last bar; the daily table keeps each UTC day\'s last bar', () => {
  const points = anthropicPoints(anthropicHistory(snapshotOf(10)).rows, 'xyz', shares);
  const week = selectRange(points, 7);
  assert.equal(week[0].time, points.at(-1)!.time - 7 * DAY);
  assert.equal(selectRange(points, null), points);
  const days = dailyPoints(points);
  assert.equal(days.length, 10);
  assert.equal(days[0].time, START + DAY - BAR);
});

test('sampling keeps short series whole and long ones with their extremes and both sides of every gap', () => {
  const short = Array.from({ length: 1200 }, (_, i) => ({ time: i, premium: i }));
  assert.equal(sampleChartPoints(short, ['premium']), short);
  type Row = { time: number; premium: number | null };
  const long: Row[] = Array.from({ length: 20_000 }, (_, i) => ({ time: i, premium: Math.sin(i / 30) }));
  long[5000] = { time: 5000, premium: 9 };
  long[7000] = { time: 7000, premium: null };
  const sampled = sampleChartPoints(long, ['premium']);
  assert.ok(sampled.length < 2000);
  const times = new Set(sampled.map(row => row.time));
  for (const time of [0, 5000, 6999, 7000, 7001, 19_999]) assert.ok(times.has(time), `keeps ${time}`);
  const plain: Point[] = [];
  assert.equal(sampleChartPoints(plain, ['premium']), plain);
});

// The oil page's data rules (web/src/monitor-oil.ts).
const OIL_BAR = OIL_CANDLE_MS, OIL_START = Date.parse('2026-09-01T00:00:00Z');
const oilSnapshot = (days: number, gapAt = -1) => {
  const rows = Array.from({ length: days * 96 }, (_, i) => ({ time: OIL_START + i * OIL_BAR, brent: 74 + (i % 9) / 100, wti: i === gapAt ? null : 70 + (i % 5) / 100 }));
  return createIntradaySnapshot(rows, new Date(OIL_START + days * DAY + 60_000).toISOString());
};

test('oil: chart points pair Brent and WTI, leave out a bar missing one leg, and keep the exact spread', () => {
  const snapshot = oilSnapshot(2, 5), history = oilHistory({ ...snapshot, lastError: null });
  assert.equal(history.points.length, 2 * 96 - 1, 'the bar without WTI is left out, not filled');
  const first = history.points[0]!;
  assert.deepEqual([first.adr, first.equivalent, first.spread], [74, 70, 4]);
  assert.ok(Number.isNaN(first.premium), 'oil has no percentage view');
  assert.equal(history.points.find(p => p.time === OIL_START + 3 * OIL_BAR)!.spread, oilSpread(74.03, 70.03));
  assert.deepEqual([history.windowDays, history.status, history.lastError, history.metadata.missingObservationRows], [null, 'live', null, 1]);
  assert.equal(oilHistory({ ...snapshot, status: 'snapshot', lastError: 'K 线读取失败：请求超时' }).lastError, 'K 线读取失败：请求超时');
  assert.throws(() => oilHistory({ ...snapshot, status: 'whatever' }), 'the vendored check accepts only live or snapshot');
});

test('oil: a windowed read must carry the complete history it came from, and covers a range only with the warmup days', () => {
  const snapshot = oilSnapshot(40), full = oilHistory(snapshot);
  const window = intradayWindow(snapshot, 7 + OIL_WARMUP_DAYS), week = oilHistory(window);
  assert.equal(week.windowDays, 28);
  assert.ok(week.points.length < full.points.length);
  assert.deepEqual(week.coverage, full.coverage);
  assert.throws(() => oilHistory({ ...window, coverage: { ...window.coverage, lastCommonObservation: snapshot.metadata.firstCommonObservation } }), /coverage/);
  assert.throws(() => oilHistory({ ...window, coverage: { ...window.coverage, pairedObservationRows: 3 } }), /coverage/);
  assert.throws(() => oilHistory({ ...window, windowDays: 1.5 }), /window/);
  for (const range of [7, 30, null]) assert.equal(coversOilRange(full, range), true);
  assert.deepEqual([coversOilRange(week, 7), coversOilRange(week, 30), coversOilRange(week, null)], [true, false, false]);
  assert.deepEqual(OIL_SPREAD_CHART.modes, ['spread', 'price']);
  assert.equal(OIL_SPREAD_CHART.tick.spread(4.071), '4.07');
});

test('oil: the quote keeps the validated marks, the service\'s freshness and its last error', () => {
  const leg = (coin: string, markPx: number) => ({ coin, markPx, fundingRate: 0.0001, fundingIntervalHours: 4, nextFundingAt: '2026-11-13T12:00:00.000Z' });
  const raw = { source: 'Binance', currency: 'USDT', fetchedAt: '2026-11-13T08:00:00.000Z', brent: leg('BZUSDT', 74.12), wti: leg('CLUSDT', 70.05), staleAfterMs: 35_000, lastAttemptAt: null };
  const live = oilQuote({ ...raw, status: 'live', lastError: null });
  assert.deepEqual([live.status, live.lastError, oilSpread(live.brent.markPx, live.wti.markPx)], ['live', null, 4.07]);
  assert.deepEqual([oilQuote({ ...raw, status: 'snapshot', lastError: '接口返回 HTTP 500' }).lastError, oilQuote(raw).status], ['接口返回 HTTP 500', 'snapshot']);
  assert.throws(() => oilQuote({ ...raw, wti: leg('BZUSDT', 70) }), /contract/);
  assert.throws(() => oilQuote({ ...raw, brent: { ...leg('BZUSDT', 74), nextFundingAt: null } }), /Incomplete/);
});
