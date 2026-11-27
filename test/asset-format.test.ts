// The asset page's wording rules (web/src/asset-format.ts, taken from the workbench pages): stale badges, the fx state,
// the trend headline, the monthly hint, the order of the daily change lines and the wallet detail lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { badge, dailyItems, detailLine, detailNote, detailSubtitle, detailTitle, fxView, dailyProfitBars, monthlyHint, periodSource, priceText, quantityText, statusTone, trendPlotPoints, trendSummary } from '../web/src/asset-format.ts';
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

test('资产走势作图：跨度超过两个月每 3 天、超过半年每 7 天取一点，留首点、优先完整快照，不改数值', () => {
  const at = (date: string, adjusted: number, missingValues = 0) => ({ date, time: Date.parse(date + 'T00:00:00+08:00'), adjusted, missingValues }) as unknown as TrendPoint;
  const days = (from: string, count: number) => Array.from({ length: count }, (_, i) => at(new Date(Date.parse(from + 'T00:00:00Z') + i * 86_400_000).toISOString().slice(0, 10), 100 + i));
  const short = days('2026-09-01', 60);
  assert.equal(trendPlotPoints(short).length, 60, '两个月内保留每日');
  const year = days('2026-01-01', 300);
  const weekly = trendPlotPoints(year);
  assert.equal(weekly[0], year[0]);
  assert.equal(weekly.at(-1), year.at(-1));
  assert.deepEqual(weekly.slice(1).map(point => point.adjusted).slice(-3), [385, 392, 399], '桶以最新快照为终点，每 7 天一点');
  assert.equal(weekly.length, 44);
  const mid = trendPlotPoints(days('2026-06-01', 90));
  assert.deepEqual(mid.slice(-2).map(point => point.adjusted), [186, 189]);
  const partial = [...year.slice(0, -1), at('2026-10-27', 1, 3)];
  assert.equal(trendPlotPoints(partial).at(-1)!.adjusted, 398, '桶内最新快照估值不全时取较早的完整快照');
  assert.deepEqual(trendPlotPoints([]), []);
});

test('每日盈亏柱：只有相邻两天且估值完整才画柱，隔天的变化只留给提示，不摊到缺失日期', () => {
  const at = (date: string, adjusted: number, missingValues = 0) => ({ date, time: Date.parse(date + 'T00:00:00+08:00'), adjusted, missingValues }) as unknown as TrendPoint;
  const bars = dailyProfitBars([at('2026-11-01', 100), at('2026-11-02', 130), at('2026-11-03', 110), at('2026-11-06', 150), at('2026-11-07', 1, 2), at('2026-11-08', 160), at('2026-11-09', 160)]);
  assert.deepEqual(bars.map(bar => bar.date), ['2026-11-02', '2026-11-03', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09'], '首份快照没有前值');
  assert.deepEqual(bars.map(bar => bar.bar), [30, -20, null, null, null, 0]);
  assert.deepEqual(bars.map(bar => bar.change), [30, -20, 40, null, null, 0], '隔天的变化保留，估值不完整的两侧都不算');
  assert.deepEqual([bars[2].gapDays, bars[2].previousDate], [3, '2026-11-03']);
  assert.deepEqual(dailyProfitBars([at('2026-11-01', 100)]), []);
  assert.deepEqual(dailyProfitBars([]), []);
});

test('资产页文案：当月表现的提示按快照数、间隔与收益率是否可算区分', () => {
  const month = (extra: Partial<MonthlyPerformance>) => ({ snapshotCount: 5, daysSpan: 28, returnRate: 0.0123, startDate: '2026-10-01', endDate: '2026-10-29', ...extra }) as MonthlyPerformance;
  assert.equal(monthlyHint(null), '本月还没有快照');
  assert.match(monthlyHint(month({ snapshotCount: 1 })), /需要两个不同日期，首末快照间隔至少 7 天/);
  assert.match(monthlyHint(month({ daysSpan: 6 })), /至少 7 天/);
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

test('资产页文案：DEX 价差聚合行与明细口径', () => {
  const row = asset({ project: 'DEX 价差', kind: '资产', mode: 'dex-spread', value: 1200, status: '只读同步 · 2 个账号' });
  assert.equal(quantityText(row, true), '账户总值');
  assert.equal(priceText(row, true), '—');
  assert.equal(detailTitle('dex-spread'), '账户总值明细');
  assert.match(detailSubtitle(row), /^估值时间 .* · 账户总值 \/ USD$/);
  assert.deepEqual(detailLine('dex-spread', { coin: '—', account: '已去重（已在资产连接中计入）：Entropy（Hyperliquid）', quantity: 0, value: 0, price: 0 }), { coin: null, quantity: '—', value: '—' });
  assert.deepEqual(detailLine('dex-spread', { coin: 'USDG', account: 'Lighter RH / 账户总值（含未实现盈亏）', quantity: 500, value: 500, price: 1 }), { coin: 'USDG', quantity: '500.000000', value: '500.00' });
  assert.match(detailNote('dex-spread'), /DEX 价差/);
  assert.match(detailNote('dex-spread'), /去重/);
});
