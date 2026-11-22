// Var/Lighter 价差页不依赖 DOM 的部分（web/src/varlighter/varlighter-form.ts）：表单到请求、总览排序与信号、走势图行。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readSymbolParams, readGlobalParams, DEFAULT_SYMBOL, DEFAULT_GLOBAL } from '../../src/varlighter/strategy.ts';
import { backtestRequest } from '../../src/varlighter/backtest.ts';
import {
  backtestBody, bps, bytesPerDay, chartRange, chartRows, fundingAnnual, globalForm, globalRequest, matchesVenue, pairLabel, settingsBody, signal, sortRows, symbolForm, symbolRequest, toggleConfirmed, usd, varLighterHref,
} from '../src/varlighter/varlighter-form.ts';
import { parseRoute } from '../src/route-parse.ts';

test('symbol form round-trips the saved params and the server accepts what it sends', () => {
  const form = symbolForm(DEFAULT_SYMBOL);
  assert.equal(form.entryBps, '15');
  const parsed = symbolRequest(form);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value, DEFAULT_SYMBOL);
  assert.deepEqual(readSymbolParams(parsed.value), DEFAULT_SYMBOL, '服务端校验接受页面生成的参数');
});

test('symbol form rejects what the server would reject, with the field named', () => {
  const base = symbolForm(DEFAULT_SYMBOL);
  const cases = [
    [{ entryBps: '' }, '入场偏离须填数字'],
    [{ entryBps: 'abc' }, '入场偏离须填数字'],
    [{ notionalUsd: '5' }, '每笔名义金额须在 10 到 100000 之间'],
    [{ maxHoldMinutes: '1.5' }, '最长持有须为整数'],
    [{ entryBps: '10', exitBps: '10' }, '出场偏离须小于入场偏离'],
    [{ regimes: [] }, '至少选择一个时段'],
    [{ directions: [] }, '至少选择一个方向'],
  ];
  for (const [patch, error] of cases) {
    const parsed = symbolRequest({ ...base, ...patch });
    assert.equal(parsed.ok, false, JSON.stringify(patch));
    assert.equal(parsed.error, error);
  }
  // 负的出场偏离（要求越过基线）是允许的；时段与方向按固定顺序、去掉未知值。
  const parsed = symbolRequest({ ...base, exitBps: ' -3 ', regimes: ['weekend', 'rth', 'bogus'], directions: ['var_cheap'] });
  assert.ok(parsed.ok);
  assert.equal(parsed.value.exitBps, -3);
  assert.deepEqual(parsed.value.regimes, ['rth', 'weekend']);
  assert.deepEqual(parsed.value.directions, ['var_cheap']);
});

test('global form keeps paused and validates the integer fields', () => {
  const form = globalForm({ ...DEFAULT_GLOBAL, paused: true });
  const parsed = globalRequest(form);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value, { ...DEFAULT_GLOBAL, paused: true });
  assert.deepEqual(readGlobalParams(parsed.value), parsed.value);
  assert.equal(globalRequest({ ...form, windowHours: '24.5' }).error, '基线窗口须为整数');
  assert.equal(globalRequest({ ...form, windowHours: '721' }).error, '基线窗口须在 1 到 720 之间');
});

test('settings and backtest bodies carry exactly what the server reads', () => {
  const params = { ...DEFAULT_SYMBOL, enabled: true };
  assert.deepEqual(settingsBody({ revision: 7 }, { symbol: { symbol: 'rh:AAPL', params } }), { revision: 7, symbols: { 'rh:AAPL': params } });
  assert.deepEqual(settingsBody({ revision: 2 }, { confirmed: ['rh:SPCX', 'rh:ANT', 'rh:SPCX'] }), { revision: 2, confirmed: ['rh:ANT', 'rh:SPCX'] });
  assert.deepEqual(settingsBody({ revision: 3 }, { venues: ['lighter', 'rh', 'lighter'] }), { revision: 3, venues: ['rh', 'lighter'] }, '场所按固定顺序、去重');
  assert.deepEqual(toggleConfirmed(['rh:ANT'], 'lighter:ANT', true), ['lighter:ANT', 'rh:ANT']);
  assert.deepEqual(toggleConfirmed(['rh:ANT', 'rh:SPCX'], 'rh:ANT', false), ['rh:SPCX']);
  const body = backtestBody('rh:AAPL', 168, symbolForm({ ...DEFAULT_SYMBOL, entryBps: 20 }), DEFAULT_GLOBAL);
  assert.ok(body.ok);
  assert.equal('enabled' in body.value.params, false, '回测请求不带启用开关');
  const request = backtestRequest(body.value, {}, DEFAULT_GLOBAL);
  assert.equal(request.params.entryBps, 20);
  assert.equal(request.hours, 168);
  assert.equal(backtestBody('rh:AAPL', 400, symbolForm(DEFAULT_SYMBOL), DEFAULT_GLOBAL).ok, false);
});

const row = (symbol, extra = {}) => ({ key: `rh:${symbol}`, venue: 'rh', symbol, name: symbol, kind: 'equity', mid: null, z: null, rich: null, cheap: null, entryBps: 10, cost: null, samples24h: 0, ...extra });

test('signal picks the side nearer to entry; sorting keeps rows without data last', () => {
  assert.equal(signal(row('A')), null);
  assert.deepEqual(signal(row('A', { rich: 12, cheap: -20 })), { direction: 'var_rich', deviation: 12, gap: 2 });
  assert.deepEqual(signal(row('A', { rich: -20, cheap: 4 })), { direction: 'var_cheap', deviation: 4, gap: -6 });
  assert.deepEqual(signal(row('A', { rich: null, cheap: 4 })), { direction: 'var_cheap', deviation: 4, gap: -6 });
  const rows = [row('C', { rich: 5, z: -3 }), row('A'), row('B', { rich: 15, z: 1 }), row('D', { cheap: 30, z: 0.5 })];
  assert.deepEqual(sortRows(rows, 'gap', true).map(item => item.symbol), ['D', 'B', 'C', 'A']);
  assert.deepEqual(sortRows(rows, 'gap', false).map(item => item.symbol), ['C', 'B', 'D', 'A'], '升序时没数据的仍在最后');
  assert.deepEqual(sortRows(rows, 'z', true).map(item => item.symbol), ['C', 'B', 'D', 'A'], '按偏离绝对值');
  assert.deepEqual(sortRows(rows, 'symbol', false).map(item => item.symbol), ['A', 'B', 'C', 'D']);
  // 同一代码在两个场所：按配对键稳定排序；场所筛选。
  const both = [row('A', { key: 'rh:A' }), row('A', { key: 'lighter:A', venue: 'lighter' })];
  assert.deepEqual(sortRows(both, 'symbol', false).map(item => item.key), ['lighter:A', 'rh:A']);
  assert.deepEqual(both.filter(item => matchesVenue(item, 'lighter')).map(item => item.key), ['lighter:A']);
  assert.equal(both.filter(item => matchesVenue(item, 'all')).length, 2);
});

test('chart rows draw the entry band around the baseline and the axis ignores a lone spike', () => {
  const points = Array.from({ length: 100 }, (_, index) => ({ t: index, mid: index === 50 ? 900 : 1, sellVar: 0, buyVar: 2, median: index < 10 ? null : 1, sigma: 1, regime: 'rth', estimated: false }));
  const rows = chartRows(points, 15);
  assert.deepEqual(rows[20], { time: 20, mid: 1, sellVar: 0, buyVar: 2, median: 1, upper: 16, lower: -14 });
  assert.equal(rows[0].upper, null, '没有基线时不画入场带');
  const [low, high] = chartRange(rows);
  assert.ok(high < 900 && low <= -14 && high >= 16, `${low} ${high}`);
  assert.equal(chartRange([]), null);
});

test('readouts and addresses', () => {
  assert.equal(bps(3.14159), '+3.1');
  assert.equal(bps(-2), '-2.0');
  assert.equal(bps(null), '—');
  assert.equal(usd(-1234.5), '−$1,234.50');
  assert.deepEqual(fundingAnnual(0.1095, 0.0000125), { var: '10.9%', rh: '11.0%' });
  assert.equal(varLighterHref('overview'), '#/varlighter');
  assert.equal(varLighterHref('detail', 'rh:AAPL'), '#/varlighter/detail/rh:AAPL');
  assert.deepEqual(pairLabel('lighter:1000PEPE'), { symbol: '1000PEPE', venue: 'lighter', short: '主网' });
  assert.deepEqual(pairLabel('AAPL'), { symbol: 'AAPL', venue: null, short: '' });
  assert.equal(bytesPerDay(1e6, 0, 3_600_000), '24 MB/天');
  assert.equal(bytesPerDay(1e8, 0, 3_600_000), '2.40 GB/天');
  assert.equal(bytesPerDay(1e6, null, 3_600_000), '—');
  for (const tab of ['overview', 'detail', 'paper', 'ready']) assert.equal(parseRoute(varLighterHref(tab)).tab, tab);
  assert.deepEqual(parseRoute('#/varlighter/detail/rh:AAPL'), { page: 'varlighter', tab: 'detail', symbol: 'rh:AAPL' });
  assert.deepEqual(parseRoute('#/varlighter/detail/lighter%3ABTC'), { page: 'varlighter', tab: 'detail', symbol: 'lighter:BTC' }, '转义过的冒号也认');
  assert.deepEqual(parseRoute('#/varlighter/detail/AAPL'), { page: 'varlighter', tab: 'detail', symbol: null }, '旧地址只有代码，回到默认配对');
  assert.deepEqual(parseRoute('#/varlighter/detail/%E0'), { page: 'varlighter', tab: 'detail', symbol: null });
  assert.deepEqual(parseRoute('#/varlighter/detail/<x>'), { page: 'varlighter', tab: 'detail', symbol: null });
});
