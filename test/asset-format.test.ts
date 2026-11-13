// The asset page's wording rules (web/src/asset-format.ts, taken from the workbench pages): stale badges, the fx state,
// the trend headline, the monthly hint, the order of the daily change lines and the wallet detail lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { badge, dailyItems, detailLine, fxView, monthlyHint, periodSource, statusTone, trendSummary } from '../web/src/asset-format.ts';
import type { Asset, Period } from '../src/asset/types.ts';
import type { DailyChange } from '../src/asset/daily-changes.ts';
import type { MonthlyPerformance } from '../src/asset/performance-metrics.ts';
import type { TrendPoint } from '../src/asset/views.ts';

const NOW = Date.parse('2026-11-10T04:00:00Z');
const asset = (extra: Partial<Asset>): Asset => ({ id: 'row-1', project: 'bybit', kind: '交易所', quantity: null, price: null, value: 100, cell: 'D2', mode: 'bybit', updatedAt: new Date(NOW).toISOString(), status: '已同步', ...extra });

test('资产页文案：同步值超过 5 分钟、行情超过 15 分钟显示过期，手动估值与读取失败不改标签', () => {
  assert.equal(badge(asset({ updatedAt: new Date(NOW - 299_000).toISOString() }), NOW), '已同步');
  assert.equal(badge(asset({ updatedAt: new Date(NOW - 301_000).toISOString() }), NOW), '数据已过期 · 保留旧值');
  assert.equal(badge(asset({ updatedAt: new Date(NOW - 301_000).toISOString(), error: '超时' }), NOW), '已同步');
  assert.equal(badge(asset({ mode: 'market', status: '行情已更新', updatedAt: new Date(NOW - 901_000).toISOString() }), NOW), '行情已过期 · 保留旧值');
  assert.equal(badge(asset({ mode: 'manual', status: '手动估值', updatedAt: '2020-01-01T00:00:00Z' }), NOW), '手动估值');
  assert.equal(statusTone(asset({ mode: 'manual' }), '手动估值'), '');
  assert.equal(statusTone(asset({}), '数据已过期 · 保留旧值'), 'amber');
  assert.equal(statusTone(asset({}), '已同步'), 'live');
});

test('资产页文案：汇率超过 5 分钟或失败时标为待更新或保留旧值', () => {
  const fetchedAt = new Date(NOW - 60_000).toISOString();
  assert.deepEqual(fxView({ source: 'Coinbase', fetchedAt, rateDate: null, error: null }, NOW).state, '自动更新');
  assert.equal(fxView({ source: 'Coinbase', fetchedAt: new Date(NOW - 301_000).toISOString(), rateDate: null, error: null }, NOW).state, '待更新');
  assert.equal(fxView({ source: 'Coinbase', fetchedAt, rateDate: null, error: '超时' }, NOW).state, '更新失败 · 保留旧值');
  assert.deepEqual(fxView({ source: 'Frankfurter', fetchedAt, rateDate: '2026-11-09', error: null }, NOW), { stale: false, source: 'Frankfurter / ECB（日度参考）', state: '自动更新', when: '报价日期 2026-11-09' });
  assert.equal(fxView({ source: 'saved', fetchedAt: null, rateDate: null, error: null }, NOW).stale, true);
});

test('资产页文案：走势首末点有缺失估值时不给变化额并说明缺在哪', () => {
  const point = (date: string, adjusted: number, missingValues = 0) => ({ date, adjusted, missingValues }) as unknown as TrendPoint;
  assert.equal(trendSummary([point('2026-11-01', 100), point('2026-11-09', 160)]).change, 60);
  const gap = trendSummary([point('2026-11-01', 100, 2), point('2026-11-09', 160)]);
  assert.deepEqual([gap.change, gap.incomplete], [null, '起点 2026-11-01 有 2 项估值缺失']);
  assert.deepEqual(trendSummary([point('2026-11-01', 100, 1)]).incomplete, '起点 2026-11-01 有 1 项估值缺失', '只有一点时不重复说终点');
  assert.equal(trendSummary([]).change, null);
});

test('资产页文案：上月表现的提示按快照数、间隔与收益率是否可算区分', () => {
  const month = (extra: Partial<MonthlyPerformance>) => ({ snapshotCount: 5, daysSpan: 28, returnRate: 0.0123, startDate: '2026-10-01', endDate: '2026-10-29', ...extra }) as MonthlyPerformance;
  assert.equal(monthlyHint(null), '上个自然月没有快照');
  assert.match(monthlyHint(month({ snapshotCount: 1 })), /需要两个不同日期，首末快照间隔至少 25 天/);
  assert.match(monthlyHint(month({ daysSpan: 10 })), /至少 25 天/);
  assert.match(monthlyHint(month({ returnRate: null })), /估值须完整/);
  assert.equal(monthlyHint(month({})), '当月 +1.23% · 2026-10-01 — 2026-10-29 · 28 天');
});

test('资产页文案：每日变化按金额绝对值排序，出金与未归因单列', () => {
  const day = {
    sources: [
      { id: 'row-1', project: 'bybit', kind: '交易所', previous: 100, current: 90, change: -10, details: [] },
      { id: 'row-2', project: '冷钱包', kind: '', previous: null, current: null, change: 0, details: [] },
    ],
    withdrawnChange: 50, unattributed: 3, partial: true,
  } as unknown as DailyChange;
  const items = dailyItems(day);
  assert.deepEqual(items.map(item => item.key), ['withdrawn', 'row:row-1', 'unattributed', 'row:row-2']);
  assert.equal(items.find(item => item.key === 'row:row-2')!.detail, '估值缺失');
  assert.equal(items.find(item => item.key === 'unattributed')!.label, '未归因变化');
  assert.equal(dailyItems({ ...day, partial: false }).find(item => item.key === 'unattributed')!.label, '原表合计差异');
});

test('资产页文案：钱包类明细的备注行不带币种，无报价的代币显示未估值', () => {
  assert.deepEqual(detailLine('hyperliquid', { coin: '—', account: '说明', quantity: 0, value: 0, price: 0 }), { coin: null, quantity: '—', value: '—' });
  assert.deepEqual(detailLine('hyperliquid', { coin: 'PURR', account: '现货', quantity: 2, value: 0, price: 0 }), { coin: 'PURR', quantity: '2.000000', value: '未估值' });
  assert.deepEqual(detailLine('bybit', { coin: 'USDT', account: '统一账户', quantity: 2, value: 0, price: 0 }), { coin: 'USDT', quantity: '2.000000', value: '0.00' });
});

test('资产页文案：历史记录的来源说明', () => {
  const period = (extra: Partial<Period>): Period => ({ id: 'P1', date: '2026-10-01', total: 1, fx: 7, cny: 7, future: false, difference: 0, ...extra });
  assert.equal(periodSource(period({})), '原表 P1');
  assert.equal(periodSource(period({ missingValues: 1 })), '原表 P1 · 部分估值');
  assert.equal(periodSource(period({ future: true })), '原表预填');
  assert.equal(periodSource(period({ archived: true })), '导入前示例记录');
  assert.equal(periodSource(period({ id: 'daily-2026-11-01' })), '当日最后更新');
  assert.equal(periodSource(period({ id: 'daily-2026-11-01', partial: true })), '当日快照 · 含旧值');
});
