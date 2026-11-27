// DEX 价差页（原 Var/Lighter 价差页）不依赖 DOM 的部分（web/src/varlighter/varlighter-form.ts）：表单到请求、组合与手动配对、总览排序与信号、走势图行。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readSymbolParams, readGlobalParams, DEFAULT_SYMBOL, DEFAULT_GLOBAL } from '../../src/varlighter/strategy.ts';
import { backtestRequest } from '../../src/varlighter/backtest.ts';
import { pairKey, parsePairKey } from '../../src/varlighter/model.ts';
import { readCustomPair } from '../../src/varlighter/engine.ts';
import {
  EMPTY_PAIR_FORM, backtestBody, bps, bytesPerDay, chartRange, chartRows, comboLabel, comboShort, customPairKey, customPairRequest, directionLabel, directionShort, fundingAnnual, globalForm, globalRequest,
  SIMPLE_SORT_KEYS, directionSides, entryProgress, matchesCombo, pairLabel, readOverviewMode, rebateAudit, settingsBody, signal, sortRows, costBreakdown, symbolForm, symbolRequest, toggleConfirmed, usd, varLighterHref, AUTO_FIELDS, autoBody, autoFormPatch, quickEnableBody,
  VARLIGHTER_TABS, reasonLabel, ACCOUNT_VENUE_FILTERS, accountActivityFoot, filterAccountPositions, filterAccountTrades, filterAccountFunding, selectedEquitySeries, selectedVenuePnlCurve, formatCurrencyAmount, signedCurrencyAmount, formatRatePct, marginModeLabel, tradeDirLabel, accountHealthBadge,
} from '../src/varlighter/varlighter-form.ts';
import { parseRoute } from '../src/route-parse.ts';

test('symbol form round-trips the saved params and the server accepts what it sends', () => {
  const form = symbolForm(DEFAULT_SYMBOL);
  assert.equal(form.entryBps, '15');
  const parsed = symbolRequest(form);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value, DEFAULT_SYMBOL);
  assert.deepEqual(readSymbolParams(parsed.value), DEFAULT_SYMBOL, '服务端校验接受页面生成的参数');
  // 详情页的“与已保存参数一致”：服务端参数的字段顺序与表单不同，两边都经 symbolRequest(symbolForm()) 规整后才比较。
  const reordered = { regimes: DEFAULT_SYMBOL.regimes, directions: DEFAULT_SYMBOL.directions, ...DEFAULT_SYMBOL };
  assert.equal(JSON.stringify(symbolRequest(symbolForm(reordered)).value), JSON.stringify(parsed.value));
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
  const parsed = symbolRequest({ ...base, exitBps: ' -3 ', regimes: ['weekend', 'rth', 'bogus'], directions: ['a_cheap', 'var_rich'] });
  assert.ok(parsed.ok);
  assert.equal(parsed.value.exitBps, -3);
  assert.deepEqual(parsed.value.regimes, ['rth', 'weekend']);
  assert.deepEqual(parsed.value.directions, ['a_cheap'], '旧方向名不认');
});

test('global form keeps paused, the four optional fees, and validates the integer fields', () => {
  const form = globalForm({ ...DEFAULT_GLOBAL, paused: true, entropyFeeBps: 2.5 });
  assert.equal(form.lighterFeeBps, '', '未填的手续费是空串');
  assert.equal(form.entropyFeeBps, '2.5');
  const parsed = globalRequest(form);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value, { ...DEFAULT_GLOBAL, paused: true, entropyFeeBps: 2.5 });
  assert.deepEqual(readGlobalParams(parsed.value), parsed.value);
  assert.equal(globalRequest({ ...form, entropyFeeBps: '' }).value.entropyFeeBps, null, '清空即按目录费率');
  assert.equal(globalRequest({ ...form, windowHours: '24.5' }).error, '基线窗口须为整数');
  assert.equal(globalRequest({ ...form, windowHours: '721' }).error, '基线窗口须在 1 到 720 之间');
});

test('settings and backtest bodies carry exactly what the server reads', () => {
  const key = 'var:AAPL|rh:AAPL', params = { ...DEFAULT_SYMBOL, enabled: true };
  assert.deepEqual(settingsBody({ revision: 7 }, { symbol: { symbol: key, params } }), { revision: 7, symbols: { [key]: params } });
  assert.deepEqual(settingsBody({ revision: 2 }, { confirmed: ['var:SPCX|rh:SPCX', 'var:ANT|rh:ANT', 'var:SPCX|rh:SPCX'] }), { revision: 2, confirmed: ['var:ANT|rh:ANT', 'var:SPCX|rh:SPCX'] });
  assert.deepEqual(settingsBody({ revision: 3 }, { combos: ['lighter|entropy', 'var|rh', 'lighter|entropy'] }), { revision: 3, combos: ['var|rh', 'lighter|entropy'] }, '组合按固定顺序、去重');
  const pair = { a: { venue: 'rh', symbol: 'ETH' }, b: { venue: 'lighter', symbol: 'ETH' }, ratio: 1, kind: 'crypto', note: '' };
  assert.deepEqual(settingsBody({ revision: 4 }, { pairs: [pair] }), { revision: 4, pairs: [pair] });
  assert.deepEqual(toggleConfirmed(['var:ANT|rh:ANT'], 'var:ANT|lighter:ANT', true), ['var:ANT|lighter:ANT', 'var:ANT|rh:ANT']);
  assert.deepEqual(toggleConfirmed(['var:ANT|rh:ANT', 'var:SPCX|rh:SPCX'], 'var:ANT|rh:ANT', false), ['var:SPCX|rh:SPCX']);

  // 总览勾选：启用并加入自动配置；取消只停用，自动配置的选择留着。
  const NVDA = 'lighter:NVDA|entropy:NVDA', saved = { revision: 5, auto: ['var:ANT|rh:ANT'] };
  assert.deepEqual(quickEnableBody(saved, NVDA, true), { revision: 5, symbols: { [NVDA]: { enabled: true } }, auto: [NVDA, 'var:ANT|rh:ANT'] });
  assert.deepEqual(quickEnableBody({ revision: 5, auto: [NVDA] }, NVDA, true).auto, [NVDA], '已在自动配置里不重复');
  assert.deepEqual(quickEnableBody({ revision: 6, auto: [NVDA] }, NVDA, false), { revision: 6, symbols: { [NVDA]: { enabled: false } } });
  // 详情页开关：打开时带一份空的改动（自动配置只认有保存参数的配对，页面上可能过期的参数不写回），关闭只改列表。
  assert.deepEqual(autoBody(saved, NVDA, true), { revision: 5, symbols: { [NVDA]: {} }, auto: [NVDA, 'var:ANT|rh:ANT'] });
  assert.deepEqual(autoBody({ revision: 5, auto: [NVDA] }, NVDA, false), { revision: 5, auto: [] });
  assert.deepEqual(AUTO_FIELDS, ['entryBps', 'exitBps', 'stopBps', 'maxHoldMinutes']);
  const filled = { ...symbolForm(DEFAULT_SYMBOL), ...autoFormPatch({ entryBps: 26, exitBps: 0, stopBps: 86, maxHoldMinutes: 72 }) };
  assert.deepEqual([filled.entryBps, filled.exitBps, filled.stopBps, filled.maxHoldMinutes, filled.notionalUsd], ['26', '0', '86', '72', String(DEFAULT_SYMBOL.notionalUsd)]);
  assert.ok(symbolRequest(filled).ok, '填入推荐值的表单可以保存与回测');
  const body = backtestBody(key, 168, symbolForm({ ...DEFAULT_SYMBOL, entryBps: 20 }), DEFAULT_GLOBAL);
  assert.ok(body.ok);
  assert.equal('enabled' in body.value.params, false, '回测请求不带启用开关');
  const request = backtestRequest(body.value, {}, DEFAULT_GLOBAL);
  assert.equal(request.params.entryBps, 20);
  assert.equal(request.hours, 168);
  assert.equal(backtestBody(key, 400, symbolForm(DEFAULT_SYMBOL), DEFAULT_GLOBAL).ok, false);
});

test('custom pair form: same key as the server, rejects what the server rejects', () => {
  const form = { ...EMPTY_PAIR_FORM, aVenue: 'rh', aSymbol: ' ETH ', bVenue: 'lighter', bSymbol: 'ETH', ratio: '0.50', kind: 'crypto', note: ' 预览 ' };
  const parsed = customPairRequest(form, []);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value, { a: { venue: 'rh', symbol: 'ETH' }, b: { venue: 'lighter', symbol: 'ETH' }, ratio: 0.5, kind: 'crypto', note: '预览' });
  assert.equal(customPairKey(parsed.value), 'rh:ETH|lighter:ETH@0.5');
  // 页面算出的键与服务端 pairKey 一致，服务端 readCustomPair 接受页面发的配对。
  assert.equal(customPairKey(parsed.value), pairKey(parsed.value.a, parsed.value.b, parsed.value.ratio));
  assert.deepEqual(readCustomPair(parsed.value), parsed.value);
  assert.equal(customPairKey({ ...parsed.value, ratio: 1 }), 'rh:ETH|lighter:ETH', '乘数 1 不写');
  assert.ok(parsePairKey(customPairKey({ ...parsed.value, ratio: 1 / 3 })), '循环小数按 10 位有效数字写，服务端认得');
  // 很小的乘数：10 位有效数字会超过键允许的 10 位小数，再限到小数 10 位，页面与服务端的键都能解析。
  const tiny = customPairRequest({ ...form, ratio: '0.000001234567891' }, []);
  assert.ok(tiny.ok);
  assert.equal(customPairKey(tiny.value), 'rh:ETH|lighter:ETH@0.0000012346');
  assert.deepEqual(parsePairKey(customPairKey(tiny.value))?.ratio, tiny.value.ratio);
  assert.equal(pairKey(readCustomPair(tiny.value).a, readCustomPair(tiny.value).b, readCustomPair(tiny.value).ratio), customPairKey(tiny.value));
  const cases = [
    [{ bVenue: 'rh' }, '两条腿须在不同场所'],
    [{ aSymbol: 'E TH' }, '代码须为 1–24 位字母、数字或 . _ -'],
    [{ ratio: '' }, '乘数须为 0.000001 到 1000000 之间的数'],
    [{ ratio: '0' }, '乘数须为 0.000001 到 1000000 之间的数'],
    [{ ratio: '1e7' }, '乘数须为 0.000001 到 1000000 之间的数'],
    [{ note: 'x'.repeat(81) }, '备注须为 80 字以内'],
  ];
  for (const [patch, error] of cases) assert.equal(customPairRequest({ ...form, ...patch }, []).error, error, JSON.stringify(patch));
  assert.equal(customPairRequest(form, ['rh:ETH|lighter:ETH@0.5']).error, 'rh:ETH|lighter:ETH@0.5 已在配对里');
});

const row = (symbol, extra = {}) => ({ key: `var:${symbol}|rh:${symbol}`, a: { venue: 'var' }, b: { venue: 'rh' }, custom: false, symbol, name: symbol, kind: 'equity', mid: null, z: null, rich: null, cheap: null, entryBps: 10, cost: null, samples24h: 0, ...extra });

test('signal picks the side nearer to entry; sorting keeps rows without data last; combo filter', () => {
  assert.equal(signal(row('A')), null);
  assert.deepEqual(signal(row('A', { rich: 12, cheap: -20 })), { direction: 'a_rich', deviation: 12, gap: 2 });
  assert.deepEqual(signal(row('A', { rich: -20, cheap: 4 })), { direction: 'a_cheap', deviation: 4, gap: -6 });
  assert.deepEqual(signal(row('A', { rich: null, cheap: 4 })), { direction: 'a_cheap', deviation: 4, gap: -6 });
  const rows = [row('C', { rich: 5, z: -3 }), row('A'), row('B', { rich: 15, z: 1 }), row('D', { cheap: 30, z: 0.5 })];
  assert.deepEqual(sortRows(rows, 'gap', true).map(item => item.symbol), ['D', 'B', 'C', 'A']);
  assert.deepEqual(sortRows(rows, 'gap', false).map(item => item.symbol), ['C', 'B', 'D', 'A'], '升序时没数据的仍在最后');
  assert.deepEqual(sortRows(rows, 'z', true).map(item => item.symbol), ['C', 'B', 'D', 'A'], '按偏离绝对值');
  assert.deepEqual(sortRows(rows, 'symbol', false).map(item => item.symbol), ['A', 'B', 'C', 'D']);
  // 同一代码在几个组合里：按配对键稳定排序；组合筛选只含该组合的自动配对，手动配对单列。
  const many = [
    row('A'), row('A', { key: 'var:A|lighter:A', b: { venue: 'lighter' } }),
    row('A', { key: 'rh:A|lighter:A', a: { venue: 'rh' }, b: { venue: 'lighter' }, custom: true }),
  ];
  assert.deepEqual(sortRows(many, 'symbol', false).map(item => item.key), ['rh:A|lighter:A', 'var:A|lighter:A', 'var:A|rh:A']);
  assert.deepEqual(many.filter(item => matchesCombo(item, 'var|lighter')).map(item => item.key), ['var:A|lighter:A']);
  assert.deepEqual(many.filter(item => matchesCombo(item, 'rh|lighter')).map(item => item.key), [], '手动配对不算进同场所的组合');
  assert.deepEqual(many.filter(item => matchesCombo(item, 'custom')).map(item => item.key), ['rh:A|lighter:A']);
  assert.equal(many.filter(item => matchesCombo(item, 'all')).length, 3);
});

test('chart rows draw the entry band around the baseline and the axis ignores a lone spike', () => {
  const points = Array.from({ length: 100 }, (_, index) => ({ t: index, mid: index === 50 ? 900 : 1, sellA: 0, buyA: 2, median: index < 10 ? null : 1, sigma: 1, regime: 'rth', estimated: false }));
  const rows = chartRows(points, 15);
  assert.deepEqual(rows[20], { time: 20, mid: 1, sellA: 0, buyA: 2, median: 1, upper: 16, lower: -14 });
  assert.equal(rows[0].upper, null, '没有基线时不画入场带');
  const [low, high] = chartRange(rows);
  assert.ok(high < 900 && low <= -14 && high >= 16, `${low} ${high}`);
  assert.equal(chartRange([]), null);
  const broken = chartRows([points[10], { ...points[20], gapBefore: true }], 15);
  assert.deepEqual(broken[1], { time: 15, mid: null, sellA: null, buyA: null, median: null, upper: null, lower: null });
  assert.equal(broken[2].time, 20);
});

test('readouts, labels and addresses', () => {
  assert.equal(bps(3.14159), '+3.1');
  assert.equal(bps(-2), '-2.0');
  assert.equal(bps(null), '—');
  assert.equal(usd(-1234.5), '−$1,234.50');
  assert.deepEqual(fundingAnnual(0.0000125, null), { a: '11.0%', b: '—' });
  assert.equal(comboLabel('lighter|entropy'), 'Lighter ↔ Entropy');
  assert.equal(comboShort('var|rh'), 'Var↔RH');
  assert.equal(directionLabel('a_rich', 'var', 'entropy'), '卖 Var · 买 Entropy');
  assert.equal(directionLabel('a_cheap', null, null), '买 A · 卖 B');
  assert.equal(directionShort('a_cheap', 'rh'), '买 RH');
  assert.equal(varLighterHref('overview'), '#/varlighter');
  assert.equal(varLighterHref('detail', 'var:AAPL|rh:AAPL'), '#/varlighter/detail/var:AAPL|rh:AAPL', '冒号、竖线与 @ 不转义，地址可读');
  assert.deepEqual(pairLabel('var:1000PEPE|lighter:1000PEPE'), { symbol: '1000PEPE', a: 'var', b: 'lighter', short: 'Var↔主网', ratio: 1 });
  assert.deepEqual(pairLabel('lighter:SOL|rh:ETH@0.05'), { symbol: 'SOL / ETH ×0.05', a: 'lighter', b: 'rh', short: '主网↔RH', ratio: 0.05 });
  assert.deepEqual(pairLabel('AAPL'), { symbol: 'AAPL', a: null, b: null, short: '', ratio: 1 });
  assert.equal(bytesPerDay(1e6, 0, 3_600_000), '24 MB/天');
  assert.equal(bytesPerDay(1e8, 0, 3_600_000), '2.40 GB/天');
  assert.equal(bytesPerDay(1e6, null, 3_600_000), '—');
  for (const tab of ['overview', 'detail', 'accounts', 'ready']) assert.equal(parseRoute(varLighterHref(tab)).tab, tab);
  assert.deepEqual(parseRoute('#/varlighter/paper'), { page: 'varlighter', tab: 'overview', symbol: null }, 'v0.112.0 去掉模拟盘页签，旧地址回到总览');
  assert.deepEqual([reasonLabel('stop'), reasonLabel('not_filled'), reasonLabel('nope'), reasonLabel(null)], ['止损', '未开成', 'nope', '—']);
  for (const key of ['var:AAPL|rh:AAPL', 'lighter:NVDA|entropy:NVDA', 'lighter:SOL|rh:ETH@0.05']) assert.deepEqual(parseRoute(varLighterHref('detail', key)), { page: 'varlighter', tab: 'detail', symbol: key }, key);
  assert.deepEqual(parseRoute('#/varlighter/detail/rh:AAPL'), { page: 'varlighter', tab: 'detail', symbol: 'var:AAPL|rh:AAPL' }, 'v0.88.0 以前的链接升级为 Var 对该场所');
  assert.deepEqual(parseRoute('#/varlighter/detail/lighter%3ABTC'), { page: 'varlighter', tab: 'detail', symbol: 'var:BTC|lighter:BTC' }, '转义过的冒号也认');
  assert.deepEqual(parseRoute('#/varlighter/detail/AAPL'), { page: 'varlighter', tab: 'detail', symbol: null }, '只有代码的旧地址回到默认配对');
  assert.deepEqual(parseRoute('#/varlighter/detail/%E0'), { page: 'varlighter', tab: 'detail', symbol: null });
  assert.deepEqual(parseRoute('#/varlighter/detail/<x>'), { page: 'varlighter', tab: 'detail', symbol: null });
});

test('overview simple view: entry progress, sell and buy venues, stored mode', () => {
  assert.equal(entryProgress({ rich: null, cheap: null, entryBps: 10 }), null);
  assert.deepEqual(entryProgress({ rich: 4, cheap: -20, entryBps: 10 }), { direction: 'a_rich', deviation: 4, entry: 10, ratio: 0.4, short: 6, reached: false });
  assert.deepEqual(entryProgress({ rich: -30, cheap: 25, entryBps: 10 }), { direction: 'a_cheap', deviation: 25, entry: 10, ratio: 1, short: 0, reached: true });
  const reverse = entryProgress({ rich: -3, cheap: -8, entryBps: 10 });
  assert.equal(reverse.ratio, 0, '两个方向都在反向时进度条为空');
  assert.equal(reverse.short, 13);
  assert.deepEqual(directionSides('a_rich', 'var', 'rh'), { sell: 'var', buy: 'rh' });
  assert.deepEqual(directionSides('a_cheap', 'lighter', 'entropy'), { sell: 'entropy', buy: 'lighter' });
  assert.equal(readOverviewMode(null), 'simple');
  assert.equal(readOverviewMode('full'), 'full');
  assert.equal(readOverviewMode('{"x":1}'), 'simple');
  assert.ok(SIMPLE_SORT_KEYS.includes('gap') && !SIMPLE_SORT_KEYS.includes('z'));
});

test('accounts tab helpers: route, filters, series selection and formatting', () => {
  assert.deepEqual(VARLIGHTER_TABS.map(item => item.id), ['overview', 'detail', 'accounts', 'ready']);
  assert.deepEqual(ACCOUNT_VENUE_FILTERS.map(item => item.id), ['all', 'lighter', 'rh', 'entropy']);
  assert.equal(varLighterHref('accounts'), '#/varlighter/accounts');
  assert.deepEqual(parseRoute('#/varlighter/accounts'), { page: 'varlighter', tab: 'accounts', symbol: null });

  const positions = [{ venue: 'lighter', symbol: 'ETH' }, { venue: 'entropy', symbol: 'io:NVDA' }];
  const trades = [{ venue: 'lighter', id: '1' }, { venue: 'rh', id: '2' }];
  const funding = [{ venue: 'rh', id: 'f1' }, { venue: 'entropy', id: 'f2' }];
  assert.equal(filterAccountPositions(positions, 'all').length, 2);
  assert.deepEqual(filterAccountPositions(positions, 'entropy').map(x => x.symbol), ['io:NVDA']);
  assert.deepEqual(filterAccountTrades(trades, 'lighter').map(x => x.id), ['1']);
  assert.deepEqual(filterAccountFunding(funding, 'rh').map(x => x.id), ['f1']);

  const view = {
    equityCurve: [{ t: 1000, equity: 400 }, { t: 2000, equity: 405 }],
    equityComplete: true,
    venues: [
      { venue: 'lighter', name: 'Lighter', collateralAsset: 'USDC', equityCurve: [{ t: 1000, equity: 300 }], pnlCurve: [{ at: 1000, pnlUsd: 2.5, equityUsd: null }], pnlError: null },
      { venue: 'rh', name: 'Lighter RH', collateralAsset: 'USDG', equityCurve: [{ t: 1000, equity: 100 }, { t: 2000, equity: 105 }], pnlCurve: [], pnlError: '未授权' },
    ],
  };
  assert.deepEqual(selectedEquitySeries(view, 'all'), { points: [{ t: 1000, value: 400 }, { t: 2000, value: 405 }], complete: true, currency: 'USD' });
  assert.deepEqual(selectedEquitySeries(view, 'rh'), { points: [{ t: 1000, value: 100 }, { t: 2000, value: 105 }], complete: true, currency: 'USDG' });
  assert.equal(selectedEquitySeries(view, 'lighter').complete, false);
  assert.equal(selectedVenuePnlCurve(view, 'all'), null);
  assert.equal(selectedVenuePnlCurve(view, 'lighter').currency, 'USDC');
  assert.equal(selectedVenuePnlCurve(view, 'rh').error, '未授权');

  assert.equal(formatCurrencyAmount(-1234.5, 'USDG'), '−1,234.50 USDG');
  assert.equal(signedCurrencyAmount(12.3, 'USDC'), '+12.30 USDC');
  assert.equal(signedCurrencyAmount(null, 'USDC'), '—');
  assert.equal(formatRatePct(0.000125), '+0.0125%');
  assert.equal(marginModeLabel('isolated'), '逐仓');
  assert.equal(marginModeLabel('cross'), '全仓');
  assert.equal(tradeDirLabel({ side: 'buy', dir: 'Close Short' }), '平空');
  assert.equal(tradeDirLabel({ side: 'sell', dir: null }), '卖出');
  assert.deepEqual(accountHealthBadge({ configured: false, at: null, stale: false, error: null }), { tone: '', label: '未配置' });
  assert.deepEqual(accountHealthBadge({ configured: true, at: null, stale: true, error: 'HTTP 500' }), { tone: 'bad', label: '读取失败' });
  assert.deepEqual(accountHealthBadge({ configured: true, at: 1000, stale: true, error: null }), { tone: 'warn', label: '读数过期' });
  assert.deepEqual(accountHealthBadge({ configured: true, at: 1000, stale: false, error: 'HTTP 502' }), { tone: 'warn', label: '上次刷新失败' });
  assert.deepEqual(accountHealthBadge({ configured: true, at: 1000, stale: false, error: null }), { tone: 'ok', label: '正常' });

  const summaryBase = { tradeCount: 2, volumeUsd: 200, feeUsd: 0.1, realizedPnlUsd: 1.45, fundingUsd: 0.02 };
  const sampleView = {
    totals: { configured: 3, tradeCount30d: 4, fundingUsd30d: 0.01, fundingVenues: ['lighter', 'entropy'], realizedPnlUsd30d: 1.45, realizedVenues: ['entropy'], liveNetUsd: 0.03 },
    venues: [
      { venue: 'lighter', configured: true, collateralAsset: 'USDC', historyAt: 1000, tradesError: null, authRequired: false, summary: { tradeCount: 2, volumeUsd: 100, feeUsd: 0, realizedPnlUsd: null, fundingUsd: -0.01 } },
      { venue: 'rh', configured: true, collateralAsset: 'USDG', historyAt: 1000, tradesError: '需要密钥', authRequired: true, summary: { tradeCount: 0, volumeUsd: 0, feeUsd: null, realizedPnlUsd: null, fundingUsd: null } },
      { venue: 'entropy', configured: true, collateralAsset: 'USDC', historyAt: 1000, tradesError: null, authRequired: false, summary: summaryBase },
    ],
  };
  assert.equal(accountActivityFoot(sampleView, 'rh'), '成交未授权');
  assert.equal(accountActivityFoot({
    totals: sampleView.totals,
    venues: [{ ...sampleView.venues[0], historyAt: null, summary: { tradeCount: 0, volumeUsd: 0, feeUsd: null, realizedPnlUsd: null, fundingUsd: null } }],
  }, 'lighter'), '成交未拉取');
  assert.equal(accountActivityFoot({
    totals: sampleView.totals,
    venues: [{ ...sampleView.venues[0], tradesError: 'HTTP 500', authRequired: false }],
  }, 'lighter'), '成交读取失败');
  assert.equal(accountActivityFoot(sampleView, 'entropy'), '成交 2 笔 · 成交额 $200 · 已实现 +1.45 USDC');
  assert.equal(accountActivityFoot(sampleView, 'all'), '已读成交 4 笔（主网、Entropy） · 资金费含 主网、Entropy · 已实现 +1.45 USD（Entropy） · 策略实盘累计 +$0.03');
  assert.equal(accountActivityFoot({ totals: { configured: 0, tradeCount30d: 0, fundingUsd30d: null, fundingVenues: [], realizedPnlUsd30d: null, realizedVenues: [], liveNetUsd: 0 }, venues: [] }, 'all'), '还没有配置实盘场所账户');
});

test('cost column separates the bid-ask spread from the round-trip fees', () => {
  assert.deepEqual(costBreakdown({ cost: 6, feeCost: 0.4, totalCost: 6.4, estimated: false }), { total: 6.4, parts: '买卖价差 6.0 + 手续费 0.4', warn: false });
  assert.deepEqual(costBreakdown({ cost: 6, feeCost: 0, totalCost: 6, estimated: true }), { total: 6, parts: '买卖价差 6.0（估算） + 手续费 0.0', warn: false }, '手续费为 0 也写出来');
  assert.deepEqual(costBreakdown({ cost: 6, feeCost: null, totalCost: null, estimated: false }), { total: 6, parts: '买卖价差 6.0 · 手续费未知', warn: true });
  assert.deepEqual(costBreakdown({ cost: null, feeCost: 0.4, totalCost: null, estimated: null }), { total: null, parts: '缺盘口 · 手续费 0.4', warn: false });
  assert.deepEqual(costBreakdown({ cost: null, feeCost: null, totalCost: null, estimated: null }), { total: null, parts: '缺盘口与手续费', warn: true });
  assert.deepEqual(costBreakdown({ cost: 6, estimated: false }), { total: 6, parts: '买卖价差 6.0 · 未计手续费', warn: false }, '旧服务没有手续费字段');
});
test('cost sorting prefers totalCost and rebateAudit calculates real fee rates', () => {
  const items = [
    row('A', { cost: 8, totalCost: 8.4 }),
    row('B', { cost: 5, totalCost: 9.0 }),
    row('C', { cost: 7, totalCost: undefined }),
    row('D', { cost: null, totalCost: null }),
  ];
  assert.deepEqual(sortRows(items, 'cost', false).map(item => item.symbol), ['C', 'A', 'B', 'D']);

  const res = rebateAudit({
    notionalUsd: 10_000, usdcFeeUsd: 0.864, assumedFeeBps: 0.2, weightedHypePriceUsd: 80,
    payoutHype: 0.00864, payoutHypePrice: 80,
  });
  assert.ok(res);
  assert.ok(Math.abs(res.rebateUsdAtPayout - 0.6912) < 1e-9);
  assert.ok(Math.abs(res.rebatePctOfTotalFee - 80) < 1e-9);
  assert.ok(Math.abs(res.rebatePctOfEntropyHalf - 160) < 1e-9);
  assert.ok(Math.abs(res.realOneWayBps - 0.1728) < 1e-9);
  assert.ok(Math.abs(res.realRoundTripBps - 0.3456) < 1e-9);
  assert.ok(Math.abs(res.deltaOneWayBps - (-0.0272)) < 1e-9);

  assert.equal(rebateAudit({ notionalUsd: 100, usdcFeeUsd: 0.01, assumedFeeBps: 0.2, weightedHypePriceUsd: 60 }), null);
  const directUsd = rebateAudit({ notionalUsd: 10_000, usdcFeeUsd: 0.864, assumedFeeBps: null, weightedHypePriceUsd: null, payoutUsd: 0.6912 });
  assert.ok(directUsd && Math.abs(directUsd.realOneWayBps - 0.1728) < 1e-9 && directUsd.deltaOneWayBps === null);
});
