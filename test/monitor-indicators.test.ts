// The chart indicators (src/vendor/indicators.mjs, the workbench's lib/indicators.ts with its tests/indicators.test.mjs
// cases), each market's indicator windows, the warmup a windowed read carries, and the range-only gap counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateIndicators } from '../src/vendor/indicators.mjs';
import { OIL_SPREAD_CHART, OIL_WARMUP_DAYS } from '../web/src/monitor-oil.ts';
import { HYNIX_SPREAD_CHART, HYNIX_WARMUP_DAYS } from '../web/src/monitor-hynix.ts';
import { ANTHROPIC_WARMUP_DAYS, anthropicChartConfig, rangeGaps, savedToggles, selectRange } from '../web/src/monitor-history.ts';

const HOUR = 3_600_000, START = Date.parse('2026-09-01T00:00:00Z');
const series = (values: number[], step = HOUR) => values.map((value, i) => ({ time: START + i * step, adr: 100 + value, ordinary: 1000, equivalent: 100, spread: value * 2, premium: value }));
const close = (actual: number | null, expected: number) => assert.ok(actual !== null && Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('hand-calculated SMA, population Bollinger bands and Z-score; zero variance leaves Z-score empty', () => {
  const points = calculateIndicators(series([1, 2, 3, 4, 5]), 'premium', { sma: 3, bands: 5 });
  assert.equal(points[1]!.sma, null);
  assert.equal(points[2]!.sma, 2);
  assert.equal(points[3]!.basis, null);
  const last = points.at(-1)!;
  assert.deepEqual([last.sma, last.basis], [4, 3]);
  close(last.deviation, Math.sqrt(2));
  close(last.upper, 3 + 2 * Math.sqrt(2));
  close(last.lower, 3 - 2 * Math.sqrt(2));
  close(last.zscore, Math.sqrt(2));
  assert.equal(last.adr, 105, 'the row keeps its own fields');
  const flat = calculateIndicators(series([8, 8, 8, 8, 8]), 'premium', { sma: 3, bands: 5 }).at(-1)!;
  assert.deepEqual([flat.band, flat.deviation, flat.zscore], [[8, 8], 0, null]);
  const usd = calculateIndicators(series([1, 2, 3, 4, 5]), 'spread', { sma: 3, bands: 5 }).at(-1)!;
  assert.deepEqual([usd.sma, usd.basis], [8, 6], 'the spread tab recalculates in its own unit');
  close(usd.zscore, Math.sqrt(2));
  assert.throws(() => calculateIndicators(series([1, 2]), 'premium', { sma: 1, bands: 5 }), /at least two/);
});

test('a missing bar or an invalid value restarts both windows', () => {
  const raw = series(Array.from({ length: 12 }, (_, i) => i));
  raw.splice(5, 1);
  const points = calculateIndicators(raw, 'premium', { sma: 3, bands: 5 });
  assert.deepEqual([points[5]!.sma, points[6]!.sma, points[7]!.sma, points[8]!.basis, points[9]!.basis], [null, null, 7, null, 8]);
  raw[5]!.premium = NaN;
  const invalid = calculateIndicators(raw, 'premium', { sma: 3, bands: 5 });
  assert.deepEqual([invalid[5]!.sma, invalid[6]!.sma, invalid[8]!.sma], [null, null, 8]);
});

test('each market\'s windows are 7 and 20 natural days of its bars; a 15-minute series restarts on an hourly step', () => {
  const quarter = 15 * 60_000;
  for (const config of [OIL_SPREAD_CHART, anthropicChartConfig('xyz')]) {
    assert.deepEqual([config.intervalMs, config.periods], [quarter, { sma: 7 * 96, bands: 20 * 96 }]);
    assert.equal(config.bars(1920), '1,920 根连续 15 分钟 K 线');
  }
  assert.deepEqual([HYNIX_SPREAD_CHART.intervalMs, HYNIX_SPREAD_CHART.periods, HYNIX_SPREAD_CHART.bars(480)], [HOUR, { sma: 168, bands: 480 }, '480 个连续小时']);
  assert.deepEqual(new Set([OIL_SPREAD_CHART.preferenceKey, anthropicChartConfig('xyz').preferenceKey, anthropicChartConfig('io').preferenceKey, HYNIX_SPREAD_CHART.preferenceKey]).size, 3, 'one saved choice per market, shared by the Anthropic legs');
  const bars = calculateIndicators(series(Array(20 * 96).fill(1), quarter), 'spread', OIL_SPREAD_CHART.periods, quarter);
  assert.deepEqual([bars[7 * 96 - 2]!.sma, bars[7 * 96 - 1]!.sma, bars[20 * 96 - 2]!.basis, bars[20 * 96 - 1]!.basis], [null, 2, null, 2]);
  assert.equal(calculateIndicators(series(Array(5).fill(1)), 'spread', { sma: 2, bands: 2 }, quarter)[4]!.sma, null, 'hourly rows are gaps on a 15-minute chart');
});

test('a windowed read (range plus warmup) gives the range the same indicators as the complete history', () => {
  const raw = series(Array.from({ length: 60 * 24 }, (_, i) => Math.sin(i / 10) + i / 500));
  const all = calculateIndicators(raw, 'premium', HYNIX_SPREAD_CHART.periods);
  for (const days of [7, 30]) {
    const read = selectRange(raw, days + HYNIX_WARMUP_DAYS);
    const shown = selectRange(calculateIndicators(read, 'premium', HYNIX_SPREAD_CHART.periods), days);
    assert.notEqual(shown[0]!.basis, null, `${days} days: the first bar shown has its window`);
    assert.deepEqual(shown, all.slice(all.length - shown.length));
  }
  assert.deepEqual([OIL_WARMUP_DAYS, ANTHROPIC_WARMUP_DAYS, HYNIX_WARMUP_DAYS], [21, 21, 21]);
});

test('gap counts cover only the bars a range shows, not the warmup read before it', () => {
  const raw = series(Array(40 * 24).fill(1)).filter((_, i) => i !== 24 && i !== 25 && i !== 39 * 24);
  assert.deepEqual(rangeGaps(raw, HOUR), { gaps: 2, missing: 3 });
  assert.deepEqual(rangeGaps(selectRange(raw, 7), HOUR), { gaps: 1, missing: 1 });
  assert.deepEqual(rangeGaps([], HOUR), { gaps: 0, missing: 0 });
});

test('saved toggles: missing, broken or unavailable storage means all on; only an explicit false turns one off', () => {
  const saved = new Map<string, string>();
  const storage = { getItem: (key: string) => saved.get(key) ?? null };
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  try {
    assert.deepEqual(savedToggles('k'), { sma: true, bands: true, zscore: true });
    saved.set('k', JSON.stringify({ sma: false, bands: 0, zscore: 'no' }));
    assert.deepEqual(savedToggles('k'), { sma: false, bands: true, zscore: true });
    saved.set('k', '{broken');
    assert.deepEqual(savedToggles('k'), { sma: true, bands: true, zscore: true });
    Object.defineProperty(globalThis, 'localStorage', { get() { throw new Error('blocked'); }, configurable: true });
    assert.deepEqual(savedToggles('k'), { sma: true, bands: true, zscore: true });
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original); else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});
