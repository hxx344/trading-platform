import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_SETTINGS, parseSettings, SettingsError, storedSettings } from '../src/fundingbook/model.ts';
import { accountEquity, accrueFunding, applyPlan, newBook, occupiedAccounts, reconcileAccounts } from '../src/fundingbook/paper.ts';
import { buildPlan } from '../src/fundingbook/plan.ts';
import { DAY, fundingStats, HOUR, riskModel } from '../src/fundingbook/stats.ts';
import { openFundingBookStore } from '../src/fundingbook/store.ts';

const NOW = Date.UTC(2026, 0, 15, 12);
const hourly = (from: number, to: number, rate: number) => { const list = []; for (let time = Math.ceil(from / HOUR) * HOUR; time <= to; time += HOUR) list.push({ time, rate }); return list; };
const OPTIONS = { shortDays: 9, longDays: 30, shortWeight: 0.5 };

test('资金费年化：短、长窗口按权重混合；每小时 0.001% 折年化 8.76%', () => {
  const stats = fundingStats(hourly(NOW - 30 * DAY + 1, NOW, 0.00001), NOW - 30 * DAY, NOW, OPTIONS)!;
  assert.ok(Math.abs(stats.shortApr - 0.0876) < 1e-9 && Math.abs(stats.longApr! - 0.0876) < 1e-9 && Math.abs(stats.adjustedApr - 0.0876) < 1e-9);
  assert.equal(stats.count, 9 * 24);
  // 最近 9 天翻倍：短窗口 17.52%，长窗口 = (21×1 + 9×2) ÷ 30 倍。
  const mixed = fundingStats([...hourly(NOW - 30 * DAY + 1, NOW - 9 * DAY, 0.00001), ...hourly(NOW - 9 * DAY + 1, NOW, 0.00002)], NOW - 30 * DAY, NOW, OPTIONS)!;
  assert.ok(Math.abs(mixed.shortApr - 0.1752) < 1e-9);
  assert.ok(Math.abs(mixed.longApr! - 0.0876 * 39 / 30) < 1e-9);
  assert.ok(Math.abs(mixed.adjustedApr - (0.1752 + 0.0876 * 39 / 30) / 2) < 1e-9);
});

test('资金费年化：没覆盖长窗口时把短窗口向零收缩；没覆盖短窗口或没有结算时不给结果', () => {
  const partial = fundingStats(hourly(NOW - 10 * DAY, NOW, 0.00001), NOW - 10 * DAY, NOW, OPTIONS)!;
  assert.equal(partial.longApr, null);
  assert.ok(Math.abs(partial.adjustedApr - 0.0438) < 1e-9);
  assert.equal(fundingStats(hourly(NOW - 5 * DAY, NOW, 0.00001), NOW - 5 * DAY, NOW, OPTIONS), null);
  assert.equal(fundingStats([], NOW - 30 * DAY, NOW, OPTIONS), null);
  assert.equal(fundingStats(hourly(NOW - 30 * DAY, NOW, 0.00001), null, NOW, OPTIONS), null);
  // 新上市的合约：查询范围覆盖了窗口，窗口前段本来就没有结算，照常给结果。
  assert.ok(fundingStats(hourly(NOW - 3 * DAY, NOW, 0.00001), NOW - 30 * DAY, NOW, OPTIONS));
});

test('风险模型：日波动率是小时收益标准差乘 √24；同向为正相关、反向为负相关；样本不足的标的不进模型', () => {
  const series = (sign: number, scale: number, hours: number) => {
    const points = []; let level = 0;
    for (let index = hours; index >= 0; index--) { level += sign * scale * (index % 2 ? 1 : -1) + 0; points.push({ time: NOW - index * HOUR, close: 100 * Math.exp(level) }); }
    return points;
  };
  const model = riskModel(new Map([['A', series(1, 0.01, 400)], ['B', series(1, 0.02, 400)], ['C', series(-1, 0.01, 400)], ['D', series(1, 0.01, 100)]]), NOW, 30);
  assert.deepEqual(model.bases, ['A', 'B', 'C']);
  // 收益在 ±1% 之间交替：样本标准差约 1%，日波动率约 1% × √24。
  assert.ok(Math.abs(model.vol[0]! - 0.01 * Math.sqrt(24)) < 0.001, String(model.vol[0]));
  assert.ok(Math.abs(model.vol[1]! / model.vol[0]! - 2) < 1e-6);
  assert.ok(model.corr[0]![1]! > 0.999 && model.corr[0]![2]! < -0.999);
  assert.ok(Math.abs(model.cov[0]![1]! - model.vol[0]! * model.vol[1]! * model.corr[0]![1]!) < 1e-12);
  // 缺了一根小时线：跨缺口的那一段不算收益。
  const gapped = series(1, 0.01, 400).filter(point => point.time !== NOW - 10 * HOUR);
  assert.equal(riskModel(new Map([['A', gapped]]), NOW, 30).samples[0], 398);
});

test('路径规划：先减仓、再划转、最后加仓；小于最小金额的调整不出单，平仓总是出单', () => {
  const steps = buildPlan({
    accounts: ['a', 'b', 'c'], bases: ['BTC', 'ETH'],
    legs: [[{ symbol: 'BTC', price: 100_000 }, { symbol: 'ETH', price: 2_000 }], [{ symbol: 'BTCUSDT', price: 100_000 }, { symbol: 'ETHUSDT', price: 2_000 }], [{ symbol: 'BTCUSDT', price: 100_000 }, null]],
    current: [[-1000, 30], [1000, -30], [0, 0]],
    target: [[-3000, 0], [1004, 0], [1996, 0]],
    equity: [900, 100, 0], targetEquity: [500, 200, 300], minOrder: 10, minTransfer: 50,
  });
  assert.deepEqual(steps.map(step => step.kind === 'transfer' ? `transfer:${step.account}>${step.to}:${Math.round(step.notional)}` : `order:${step.account}:${step.base}:${step.side}:${Math.round(step.notional)}`), [
    'order:a:ETH:sell:30', 'order:b:ETH:buy:30',
    'transfer:a>c:300', 'transfer:a>b:100',
    'order:a:BTC:sell:2000', 'order:c:BTC:buy:1996',
  ]);
  assert.ok(steps[0]!.close && steps[0]!.reduce && !steps[4]!.reduce);
  assert.equal(steps[4]!.qty, 0.02);
});

test('模拟盘：开仓扣成本、加仓算均价、减仓结算盈亏、反手按新价开仓、全平不留零头', () => {
  const book = newBook(['a', 'b'], 1000, NOW), cost = () => 0.001;
  applyPlan(book, [
    { kind: 'transfer', account: 'a', to: 'b', notional: 400 },
    { kind: 'order', account: 'a', base: 'BTC', symbol: 'BTC', side: 'sell', qty: 0.01, price: 100_000, notional: 1000 },
  ], cost, NOW);
  assert.equal(book.accounts.a!.cash, 599);
  assert.equal(book.accounts.b!.cash, 400);
  assert.deepEqual(book.accounts.a!.positions.BTC, { symbol: 'BTC', qty: -0.01, entry: 100_000, fundingAt: NOW });
  // 加仓：均价 = (100000×0.01 + 110000×0.01) ÷ 0.02。
  applyPlan(book, [{ kind: 'order', account: 'a', base: 'BTC', symbol: 'BTC', side: 'sell', qty: 0.01, price: 110_000, notional: 1100 }], cost, NOW);
  assert.equal(book.accounts.a!.positions.BTC!.entry, 105_000);
  // 空头在 100000 平掉一半：盈利 0.01 × 5000。
  applyPlan(book, [{ kind: 'order', account: 'a', base: 'BTC', symbol: 'BTC', side: 'buy', qty: 0.01, price: 100_000, notional: 1000, reduce: true }], cost, NOW);
  assert.ok(Math.abs(book.accounts.a!.realized - 50) < 1e-9);
  assert.ok(Math.abs(book.accounts.a!.positions.BTC!.qty + 0.01) < 1e-12);
  assert.ok(Math.abs(accountEquity(book.accounts.a!, () => 100_000)! - (book.accounts.a!.cash + 50)) < 1e-9);
  assert.equal(accountEquity(book.accounts.a!, () => null), null);
  // 反手：买 0.03，平掉 0.01 的空头，剩下 0.02 的多头按这笔的价格开。
  applyPlan(book, [{ kind: 'order', account: 'a', base: 'BTC', symbol: 'BTC', side: 'buy', qty: 0.03, price: 100_000, notional: 3000 }], cost, NOW + 1);
  const flipped = book.accounts.a!.positions.BTC!;
  assert.ok(Math.abs(flipped.qty - 0.02) < 1e-12 && flipped.entry === 100_000 && flipped.fundingAt === NOW + 1);
  // 全平：数量与持仓差一点零头时按持仓整笔平。
  applyPlan(book, [{ kind: 'order', account: 'a', base: 'BTC', symbol: 'BTC', side: 'sell', qty: 0.019999, price: 100_000, notional: 2000, reduce: true, close: true }], cost, NOW + 2);
  assert.deepEqual(book.accounts.a!.positions, {});
  const total = book.accounts.a!.cash + book.accounts.b!.cash;
  assert.ok(Math.abs(total - (1000 + book.accounts.a!.realized - book.accounts.a!.fees)) < 1e-9, '现金合计 = 本金 + 已实现盈亏 − 成本');
});

test('模拟盘：资金费空头收、多头付，同一笔结算不重复计；有资金的账户不能删', () => {
  const book = newBook(['a', 'b'], 1000, NOW);
  book.accounts.a!.positions.BTC = { symbol: 'BTC', qty: -0.01, entry: 100_000, fundingAt: NOW };
  const records = [{ time: NOW, rate: 0.0001 }, { time: NOW + HOUR, rate: 0.0001 }, { time: NOW + 2 * HOUR, rate: -0.0002 }, { time: NOW + 9 * HOUR, rate: 1 }];
  // 开仓那一刻及之前的结算不计；晚于现在的不计。
  assert.ok(Math.abs(accrueFunding(book.accounts.a!, 'BTC', records, 100_000, NOW + 3 * HOUR) - (0.1 - 0.2)) < 1e-9);
  assert.equal(accrueFunding(book.accounts.a!, 'BTC', records, 100_000, NOW + 3 * HOUR), 0);
  assert.equal(book.accounts.a!.positions.BTC!.fundingAt, NOW + 2 * HOUR);
  assert.ok(Math.abs(book.accounts.a!.cash - 999.9) < 1e-9);
  assert.deepEqual(occupiedAccounts(book, ['b']), ['a']);
  reconcileAccounts(book, ['a', 'c']);
  assert.deepEqual(Object.keys(book.accounts), ['a', 'c']);
});

test('库：资金费与覆盖范围一起写；规划与模拟盘一起落库；重置清掉两者，行情历史留着', t => {
  const dir = mkdtempSync(join(tmpdir(), 'fundingbook-store-'));
  const store = openFundingBookStore(join(dir, 'fundingbook.sqlite'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(store.coverage('funding:x'), null);
  store.addFunding('x', [{ time: 1, rate: 0.1 }, { time: 2, rate: 0.2 }], 'funding:x', { from: 0, to: 2, error: null, retryAt: 0 });
  store.addFunding('x', [{ time: 2, rate: 0.3 }], 'funding:x', { from: 0, to: 3, error: null, retryAt: 0 });
  assert.deepEqual(store.funding('x', 0).map(row => ({ ...row })), [{ time: 1, rate: 0.1 }, { time: 2, rate: 0.3 }]);
  assert.deepEqual(store.coverage('funding:x'), { from: 0, to: 3, error: null, retryAt: 0 });
  store.setCoverage('funding:x', { from: 0, to: 3, error: '超时', retryAt: 9 });
  assert.equal(store.coverage('funding:x')!.error, '超时');
  store.addPrices('BTC', [{ time: 5, close: 100 }], 'price:BTC', { from: 4, to: 5, error: null, retryAt: 0 });
  assert.deepEqual(store.prices('BTC', 4).map(row => ({ ...row })), [{ time: 5, close: 100 }]);

  const book = newBook(['a'], 100, 7);
  const id = store.commitRound(book, 7, { capital: 100 }, { steps: [] });
  assert.deepEqual(store.book(), book);
  assert.deepEqual(store.rounds(10), [{ id, at: 7, summary: { capital: 100 } }]);
  assert.deepEqual(store.round(id), { steps: [] });
  assert.deepEqual(store.latestRound(), { id, at: 7, detail: { steps: [] } });
  store.resetPaper();
  assert.equal(store.book(), null);
  assert.deepEqual(store.rounds(10), []);
  assert.equal(store.funding('x', 0).length, 2);
  store.prune(2);
  assert.equal(store.funding('x', 0).length, 1);
});

test('参数：整份校验，越界、多余的键、重复的账户都拒绝；默认不启用；库里缺的键补默认值', () => {
  assert.equal(DEFAULT_SETTINGS.enabled, false);
  assert.deepEqual(parseSettings(structuredClone(DEFAULT_SETTINGS)), DEFAULT_SETTINGS);
  const bad = (patch: Record<string, unknown>) => assert.throws(() => parseSettings({ ...structuredClone(DEFAULT_SETTINGS), ...patch }), SettingsError);
  bad({ capital: 1 }); bad({ safetySigma: 0 }); bad({ shortDays: 40 }); bad({ shortDays: 20, longDays: 10 }); bad({ extra: 1 }); bad({ bases: ['btc'] }); bad({ bases: ['BTC', 'BTC'] });
  bad({ accounts: [{ ...DEFAULT_SETTINGS.accounts[0]!, venue: 'nowhere' }] });
  bad({ accounts: [DEFAULT_SETTINGS.accounts[0], DEFAULT_SETTINGS.accounts[0]] });
  bad({ enabled: true, accounts: [DEFAULT_SETTINGS.accounts[0]] });
  assert.throws(() => parseSettings(null), SettingsError);
  const { paperAuto: _dropped, ...older } = DEFAULT_SETTINGS;
  assert.deepEqual(storedSettings({ ...older, capital: 5000 }), { ...DEFAULT_SETTINGS, capital: 5000 });
  assert.deepEqual(storedSettings({ ...DEFAULT_SETTINGS, capital: 'x' }), DEFAULT_SETTINGS);
  assert.deepEqual(storedSettings(null), DEFAULT_SETTINGS);
});

test('风险模型：相关性只用共同时刻，矩阵半正定；与别的标的没有足够共同时刻的标的不进模型', () => {
  const wave = (phase: number, amplitude: number, from: number, count: number) => Array.from({ length: count }, (_, index) => {
    const time = NOW - (from - index) * HOUR;
    return { time, close: 100 * Math.exp(amplitude * Math.sin(time / HOUR * 1.3 + phase)) };
  });
  // C 只与 A、B 重叠最后 100 小时：按各对自己的样本拼矩阵时这一对会被记成 0。
  const model = riskModel(new Map([['A', wave(0, 0.01, 600, 601)], ['B', wave(0.4, 0.01, 600, 601)], ['C', wave(0.8, 0.01, 100, 101).concat(wave(0.8, 0.01, 1_400, 300))]]), NOW, 60);
  assert.deepEqual(model.bases, ['A', 'B']);
  const full = riskModel(new Map([['A', wave(0, 0.01, 600, 601)], ['B', wave(0.4, 0.01, 600, 601)], ['C', wave(0.8, 0.01, 600, 601)]]), NOW, 60);
  assert.deepEqual(full.bases, ['A', 'B', 'C']);
  // 任意组合的方差都不为负。
  for (const weights of [[1, -1, 0], [1, -2, 1], [-1, 1, -1], [3, -1, -2]]) {
    const variance = weights.reduce((sum, wi, i) => sum + weights.reduce((part, wj, j) => part + wi * wj * full.cov[i]![j]!, 0), 0);
    assert.ok(variance >= -1e-15, `组合 ${weights} 的方差 ${variance}`);
  }
});

test('风险模型：共同时刻不足时去掉让大家对不上的那个标的，而不是样本最少的', () => {
  const wave = (phase: number, from: number, count: number) => Array.from({ length: count }, (_, index) => {
    const time = NOW - (from - index) * HOUR;
    return { time, close: 100 * Math.exp(0.01 * Math.sin(time / HOUR * 1.3 + phase)) };
  });
  // A、B 只有最近 300 小时；C 有 700 小时但最近 150 小时没有。
  const model = riskModel(new Map([['A', wave(0, 300, 301)], ['B', wave(0.4, 300, 301)], ['C', wave(0.8, 850, 701)]]), NOW, 60);
  assert.deepEqual(model.bases, ['A', 'B']);
});
