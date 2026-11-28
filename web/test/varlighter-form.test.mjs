// DEX 价差页（原 Var/Lighter 价差页）不依赖 DOM 的部分（web/src/varlighter/varlighter-form.ts）：表单到请求、组合与手动配对、总览排序与信号、走势图行。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readSymbolParams, readGlobalParams, DEFAULT_SYMBOL, DEFAULT_GLOBAL } from '../../src/varlighter/strategy.ts';
import { backtestRequest } from '../../src/varlighter/backtest.ts';
import { pairKey, parsePairKey } from '../../src/varlighter/model.ts';
import { readCustomPair } from '../../src/varlighter/engine.ts';
import { DEFAULT_LIVE_EXEC, DEFAULT_LIVE_SETTINGS, LIVE_EXEC_RANGES as SERVER_EXEC_RANGES, LIVE_LIMIT_RANGES as SERVER_LIMIT_RANGES, readLiveExecSettings, readLiveSettings } from '../../src/varlighter/live.ts';
import { readLeadWatcherConfig } from '../../src/varlighter/lead.ts';
import {
  DEFAULT_LEAD_FORM, applyCandidate, buildAnalyzeSeriesRows, buildAnalyzeXcorrRows, buildBucketRows, catalogSummaryText,
  formFromConfig, formatDbBytes, formatEventVenue, formatLagMs, lagTone, lagVerdict, leadWatcherRequest,
} from '../src/varlighter/varlighter-lead-form.ts';
import {
  EMPTY_PAIR_FORM, backtestBody, bps, bytesPerDay, chartRange, chartRows, comboLabel, comboShort, customPairKey, customPairRequest, directionLabel, directionShort, fundingAnnual, globalForm, globalRequest, parseState,
  SIMPLE_SORT_KEYS, directionSides, entryProgress, matchesCombo, pairLabel, readOverviewMode, rebateAudit, settingsBody, signal, sortRows, costBreakdown, symbolForm, symbolRequest, toggleConfirmed, usd, varLighterHref, AUTO_FIELDS, autoBody, autoFormPatch, quickEnableBody,
  VARLIGHTER_TABS, reasonLabel, ACCOUNT_VENUE_FILTERS, accountActivityFoot, filterAccountPositions, filterAccountTrades, filterAccountFunding, selectedEquitySeries, selectedVenuePnlCurve, formatCurrencyAmount, signedCurrencyAmount, formatRatePct, marginModeLabel, tradeDirLabel, accountHealthBadge,
  liveExecFields, liveExecForm, parseLiveExec, tradeTelemetrySummary,
  baselineMissing, blockedAtEntry, breakdownRows, firstLegMissRate, firstLegMissed, firstLegSent, followServerForm, gateNote, liveLimitsForm, liveOutcomes, liveSwitchForm, msText, orderTelemetryStats, outcomeCounts, outcomeText, parseLiveLimits, positionMarkCells, quantile, rangeFieldErrors, sameLiveForm,
  tradedPositions, untradedPositions, LIVE_EXEC_FIELDS, LIVE_EXEC_RANGES, LIVE_LIMIT_FIELDS, LIVE_LIMIT_RANGES,
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

test('总览从生效方向计算信号、进度和排序，旧应答取同一份参数，过期信号不排在机会里', () => {
  const now = 1_000_000, patch = { sampleAt: now, rich: 25, cheap: 4 };
  const old = row('A', patch), current = row('B', { ...patch, rich: 12, cheap: 30, directions: ['a_rich'] });
  const stale = row('C', { ...patch, rich: 90, sampleAt: now - 300_001, gate: { reached: true } });
  const empty = row('D', { ...patch, directions: [] }), defaults = row('E', { ...patch, rich: 11, cheap: 29 });
  const view = parseState({ rows: [old, current, stale, empty, defaults], settings: { symbols: {
    [old.key]: { directions: ['a_cheap'] }, [current.key]: { directions: ['a_cheap'] },
  } }, sources: {} });
  const [a, b, c, d, e] = view.rows;
  assert.deepEqual(signal(a), { direction: 'a_cheap', deviation: 4, gap: -6 });
  assert.equal(entryProgress(a).reached, false, '只有禁止方向过线');
  assert.equal(signal({ ...b, rich: 3 }).gap, -7, '只允许卖 A 时忽略已过线的买 A');
  assert.equal(signal(b).direction, 'a_rich');
  assert.equal(signal(e).direction, 'a_rich', '旧默认双向同时过线时跟随后端的优先次序');
  assert.equal(signal(d), null);
  assert.equal(gateNote(c, now), null);
  assert.deepEqual(sortRows(view.rows, 'gap', true, now).map(r => r.symbol), ['B', 'E', 'A', 'C', 'D']);
});

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
  assert.deepEqual(VARLIGHTER_TABS.map(item => item.id), ['overview', 'detail', 'accounts', 'ready', 'lead']);
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

test('live exec form round-trips with server readLiveExecSettings and formats trade telemetry', () => {
  const form = liveExecForm(DEFAULT_LIVE_EXEC);
  const parsed = parseLiveExec(form);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value, DEFAULT_LIVE_EXEC);
  assert.deepEqual(readLiveExecSettings(parsed.value), DEFAULT_LIVE_EXEC);
  assert.equal(parseLiveExec({ ...form, openLegASlippageBps: '31' }).ok, false);
  assert.equal(parseLiveExec({ ...form, confirmMs: '1.5' }).ok, false);
  assert.equal(parseLiveExec({ ...form, notFilledCooldownSec: '4' }).ok, false);
  assert.equal(parseLiveExec({ ...form, maxLeverage: '0.5' }).ok, false);
  assert.equal(parseLiveExec({ ...form, maxLeverage: '5.5' }).ok, false);
  assert.equal(parseLiveExec({ ...form, maxLeverage: '' }).ok, false);
  assert.equal(parseLiveExec({ ...form, hedgeWaitSec: '31' }).ok, false);
  assert.equal(parseLiveExec({ ...form, hedgeRetryMs: '199' }).ok, false);
  assert.equal(parseLiveExec({ ...form, hedgeRetryMs: '500.5' }).ok, false);
  assert.equal(parseLiveExec({ ...form, revertMinNetBps: '-101' }).ok, false);
  assert.deepEqual(parseLiveExec({ ...form, firstLeg: 'a', hedgeWaitSec: '0', revertMinNetBps: '-100' }), { ok: true, value: { ...DEFAULT_LIVE_EXEC, firstLeg: 'a', hedgeWaitSec: 0, revertMinNetBps: -100 } });
  assert.deepEqual(parseLiveExec({ ...form, revertMinNetBps: '-0.5' }), { ok: true, value: { ...DEFAULT_LIVE_EXEC, revertMinNetBps: -0.5 } });
  assert.deepEqual(parseLiveExec({ ...form, revertMinNetBps: '\u22125' }), { ok: true, value: { ...DEFAULT_LIVE_EXEC, revertMinNetBps: -5 } }, '全角减号按负号读');
  assert.equal(parseLiveExec({ ...form, revertMinNetBps: '-' }).ok, false);
  const execCases = [{ hedgeWaitSec: '31' }, { hedgeRetryMs: '199' }, { hedgeRetryMs: '500.5' }, { hedgeAbortBps: '0' }, { hedgeEdgeBps: '101' }, { revertMinNetBps: '-101' }];
  for (const patch of execCases) {
    assert.equal(parseLiveExec({ ...form, ...patch }).ok, false, JSON.stringify(patch));
    assert.throws(() => readLiveExecSettings({ ...DEFAULT_LIVE_EXEC, ...Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, Number(value)])) }), undefined, `服务端同样拒绝 ${JSON.stringify(patch)}`);
  }
  assert.throws(() => readLiveExecSettings({ ...DEFAULT_LIVE_EXEC, firstLeg: 'b' }), undefined, '服务端拒绝不认识的先发腿');
  // 旧版 DEX 价差服务的执行参数没有后加的字段：页面只列出、只提交它有的那些。
  const { firstLeg: _firstLeg, hedgeWaitSec: _wait, hedgeRetryMs: _retry, hedgeAbortBps: _abort, hedgeEdgeBps: _edge, revertMinNetBps: _revert, ...oldExec } = DEFAULT_LIVE_EXEC;
  assert.deepEqual(liveExecFields(oldExec).map(field => field.key), ['openLegASlippageBps', 'confirmMs', 'notFilledCooldownSec', 'maxLeverage']);
  assert.equal(liveExecFields(DEFAULT_LIVE_EXEC).length, LIVE_EXEC_FIELDS.length);
  assert.deepEqual(parseLiveExec(liveExecForm(oldExec), liveExecFields(oldExec)), { ok: true, value: oldExec });
  assert.deepEqual(parseLiveExec({ ...form, maxLeverage: '2.5' }), { ok: true, value: { ...DEFAULT_LIVE_EXEC, maxLeverage: 2.5 } });
  assert.deepEqual(parseLiveExec({ ...form, maxLeverage: '5' }), { ok: true, value: { ...DEFAULT_LIVE_EXEC, maxLeverage: 5 } });
  assert.equal(tradeTelemetrySummary({}), null);
  assert.equal(tradeTelemetrySummary({
    orders: [{ role: 'openA', leg: 'a', venue: 'lighter', side: 'sell', clientId: 1, qty: 1, filledQty: 1, expectedPrice: 100, limitPrice: 99.98, avgPrice: 99.99, slippageBps: 1, signalAt: 1000, sentAt: 1010, ackAt: 1050, confirmAt: 1190, confirmSource: 'ws', status: '已成交' }],
  }), 'WS · 180 ms · 第一腿滑点 +1.0 bps（共 1 笔单）');
  assert.equal(tradeTelemetrySummary({
    orders: [{ role: 'openA', leg: 'a', venue: 'lighter', side: 'sell', clientId: 1, qty: 1, filledQty: 1, expectedPrice: 100, limitPrice: 99.98, avgPrice: null, slippageBps: 280, signalAt: 1000, sentAt: 1010, ackAt: 1050, confirmAt: 1190, confirmSource: 'account', status: '已成交' }],
  }), '对账 · 180 ms（共 1 笔单）', '成交均价是估算时不把限价算出的滑点当成实际滑点');
});

test('overview gate note: why an enabled pair without a position has not opened', () => {
  const now = 1_000_000_000;
  assert.equal(gateNote({}, now), null, '旧服务没有 gate');
  assert.equal(gateNote({ gate: null }, now), null, '有持仓或未启用');
  const gate = { blocker: null, reached: false, deviation: 3, expectedNetBps: null, last: null };
  assert.equal(gateNote({ gate }, now), null, '没到入场线、没被挡、也没有最近一次：保持现状');
  assert.deepEqual(gateNote({ gate: { ...gate, blocker: '实盘关闭' } }, now), { tone: 'warn', text: '未开仓：实盘关闭', title: '未开仓：实盘关闭' });
  assert.deepEqual(gateNote({ gate: { ...gate, blocker: '可用余额不足', reached: true, deviation: 12 } }, now), { tone: 'bad', text: '未开仓：可用余额不足', title: '已到入场线，未开仓：可用余额不足' }, '到了入场线却被挡：更醒目');
  assert.deepEqual(gateNote({ gate: { ...gate, reached: true, expectedNetBps: 4.25 } }, now), { tone: 'ok', text: '已到入场线，预期净利 +4.3 基点，等待确认或下单', title: '已到入场线，预期净利 +4.3 基点，等待确认或下单' });
  assert.equal(gateNote({ gate: { ...gate, reached: true } }, now).text, '已到入场线，等待确认或下单', '缺预期净利时不写');
  const last = { at: now - 180_000, reason: '实时价差已缩窄' };
  assert.deepEqual(gateNote({ gate: { ...gate, last } }, now), { tone: 'dim', text: '最近一次没开成：3 分钟前，实时价差已缩窄', title: '最近一次没开成：3 分钟前，实时价差已缩窄' }, '只有最近一次时单独显示');
  assert.deepEqual(gateNote({ gate: { ...gate, blocker: '冷却中', last: { at: now - 30_000, reason: '单腿' } } }, now), { tone: 'warn', text: '未开仓：冷却中', title: '未开仓：冷却中\n最近一次没开成：30 秒前，单腿' }, '有挡住原因时最近一次放进悬停提示');
  assert.equal(blockedAtEntry([{ sampleAt: now }, { sampleAt: now }], now), null, '旧服务不显示到线被挡');
  const fresh = { sampleAt: now - 1_000 };
  assert.equal(blockedAtEntry([{ ...fresh, gate: null }, { ...fresh, gate: { ...gate, reached: true, blocker: 'x' } }, { ...fresh, gate: { ...gate, blocker: 'y' } }, { ...fresh, gate: { ...gate, reached: true } }], now), 1);
  assert.equal(blockedAtEntry([{ sampleAt: now - 6 * 60_000, gate: { ...gate, reached: true, blocker: 'x' } }, { sampleAt: null, gate: { ...gate, reached: true, blocker: 'x' } }], now), 0, '样本过期的行不高亮，也不计入到线被挡');
  // 策略本来就会等的、用户自己的设置（attention 为 false）：不用警示色，也不计入到线被挡。
  assert.deepEqual(gateNote({ gate: { ...gate, blocker: '冷却中', attention: false, reached: true } }, now), { tone: 'dim', text: '未开仓：冷却中', title: '已到入场线，未开仓：冷却中' });
  assert.equal(gateNote({ gate: { ...gate, blocker: '实盘总开关未开', attention: false } }, now).tone, 'dim');
  assert.equal(gateNote({ gate: { ...gate, blocker: 'Lighter 账户读数不够新', attention: true, reached: true } }, now).tone, 'bad');
  assert.equal(gateNote({ gate: { ...gate, blocker: 'Lighter 账户读数不够新', attention: true } }, now).tone, 'warn');
  assert.equal(blockedAtEntry([{ ...fresh, gate: { ...gate, reached: true, blocker: '冷却中', attention: false } }, { ...fresh, gate: { ...gate, reached: true, blocker: '余额不足', attention: true } }], now), 1);
  assert.equal(baselineMissing({ baselineWarming: true }, true), '基线预热中');
  assert.equal(baselineMissing({}, true), '平时水平统计中');
  assert.equal(baselineMissing({ baselineWarming: false }, false), '样本不足');
});

test('live limit and exec ranges match the server and reject what it rejects', () => {
  assert.deepEqual(LIVE_LIMIT_RANGES, SERVER_LIMIT_RANGES);
  assert.deepEqual(LIVE_EXEC_RANGES, SERVER_EXEC_RANGES);
  for (const field of LIVE_LIMIT_FIELDS) assert.deepEqual([field.min, field.max], [...SERVER_LIMIT_RANGES[field.key]], field.key);
  for (const field of LIVE_EXEC_FIELDS) assert.deepEqual([field.min, field.max], [...SERVER_EXEC_RANGES[field.key]], field.key);
  const form = liveLimitsForm(DEFAULT_LIVE_SETTINGS.limits);
  const parsed = parseLiveLimits(form);
  assert.ok(parsed.ok);
  assert.deepEqual(readLiveSettings({ on: false, pairs: [], limits: parsed.value }, () => true).limits, DEFAULT_LIVE_SETTINGS.limits, '服务端接受页面生成的限额');
  const cases = [
    [{ perTradeUsd: '9' }, '单笔名义（美元）须在 10 到 100000 之间'],
    [{ maxOpen: '21' }, '同时持仓（笔）须在 1 到 20 之间'],
    [{ maxOpen: '1.5' }, '同时持仓（笔）须为整数'],
    [{ dailyLossUsd: '' }, '当日亏损上限（美元）须填数字'],
    [{ slippageBps: '301' }, '第二腿与平仓限价保护（基点）须在 1 到 300 之间'],
  ];
  for (const [patch, error] of cases) {
    assert.deepEqual(parseLiveLimits({ ...form, ...patch }), { ok: false, error });
    assert.throws(() => readLiveSettings({ on: false, pairs: [], limits: { ...DEFAULT_LIVE_SETTINGS.limits, ...Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, value === '' ? null : Number(value)])) } }, () => true), undefined, `服务端同样拒绝 ${JSON.stringify(patch)}`);
  }
  assert.deepEqual(parseLiveLimits({ ...form, dailyLossUsd: ' 5e\u22120 ' }), { ok: true, value: { ...DEFAULT_LIVE_SETTINGS.limits, dailyLossUsd: 5 } }, '校验与取值用同一种写法：全角减号当负号');
  assert.deepEqual(rangeFieldErrors(LIVE_LIMIT_FIELDS, form), {});
  assert.deepEqual(rangeFieldErrors(LIVE_LIMIT_FIELDS, { ...form, maxOpen: '0', slippageBps: 'abc' }), { maxOpen: '须为 1 到 20 的整数', slippageBps: '须为 1 到 300 之间的数' });
  assert.deepEqual(rangeFieldErrors(LIVE_EXEC_FIELDS, { ...liveExecForm(DEFAULT_LIVE_EXEC), confirmMs: '10001' }), { confirmMs: '须为 0 到 10000 的整数' });
});

test('live switch form follows the server only while the user has no unsaved edits (L089)', () => {
  const settings = { on: false, pairs: ['b', 'a'], limits: DEFAULT_LIVE_SETTINGS.limits };
  const base = liveSwitchForm(settings, DEFAULT_LIVE_EXEC);
  const next = liveSwitchForm({ ...settings, limits: { ...settings.limits, maxOpen: 3 } }, DEFAULT_LIVE_EXEC);
  assert.ok(sameLiveForm(base, liveSwitchForm({ ...settings, pairs: ['a', 'b'] }, DEFAULT_LIVE_EXEC)), '配对不计顺序');
  assert.ok(sameLiveForm({ ...base, limits: { ...base.limits, perTradeUsd: '100.0' } }, base), '同一个数的不同写法相同');
  assert.equal(followServerForm(base, base, next), true, '没改过：跟随服务器');
  const edited = { ...base, limits: { ...base.limits, dailyLossUsd: '50' } };
  assert.equal(followServerForm(edited, base, next), false, '有未保存的修改：保留编辑');
  assert.equal(followServerForm(edited, base, base), false, '迟到的旧读数也不冲掉编辑');
  const submitted = { ...base, exec: { ...base.exec, maxLeverage: '2' } };
  const afterSave = liveSwitchForm(settings, { ...DEFAULT_LIVE_EXEC, maxLeverage: 2 });
  assert.equal(followServerForm(submitted, base, afterSave), true, '保存成功：表单与新值一致，跟随');
  assert.equal(followServerForm({ ...submitted, pairs: ['a'] }, base, afterSave), false, '保存期间接着改的保留');
  assert.equal(followServerForm({ ...base, exec: { ...base.exec, autoSizeByBalance: false } }, base, next), false, '勾选框也算修改');
  const otherLeg = { ...base, exec: { ...base.exec, firstLeg: 'a' } };
  assert.equal(sameLiveForm(otherLeg, base), false, '先发腿也算修改');
  assert.equal(followServerForm(otherLeg, base, next), false);
});

const order = (role, extra = {}) => ({ role, leg: role.endsWith('B') ? 'b' : 'a', venue: 'lighter', side: 'buy', clientId: 1, qty: 1, filledQty: 1, expectedPrice: 100, limitPrice: 100, avgPrice: 100, slippageBps: 1, signalAt: 900, sentAt: 1000, ackAt: 1050, confirmAt: 1200, confirmSource: 'ws', status: '已成交', ...extra });
test('order telemetry stats by role: counts, fill rate, slippage and latency quantiles, confirm sources', () => {
  assert.deepEqual(orderTelemetryStats([]), { positions: 0, orders: 0, roles: [] });
  assert.deepEqual(orderTelemetryStats([{}, { orders: [] }]), { positions: 0, orders: 0, roles: [] });
  const nulls = orderTelemetryStats([{ orders: [order('openA', { slippageBps: null, filledQty: 0 }), order('openA', { slippageBps: null, signalAt: null })] }]).roles[0];
  assert.equal(nulls.slipMean, null);
  assert.equal(nulls.slipP50, null);
  assert.equal(nulls.slipSamples, 0);
  assert.equal(nulls.fillRate, 0.5);
  assert.equal(nulls.signalP50, 100, 'signalAt 为 null 的不计');
  const single = orderTelemetryStats([{ orders: [order('closeB', { slippageBps: 2.5, confirmAt: 1300 })] }]).roles[0];
  assert.deepEqual([single.slipMean, single.slipP50, single.slipP90, single.confirmP50, single.confirmP90], [2.5, 2.5, 2.5, 300, 300], '单个样本的分位数就是它本身');
  const stats = orderTelemetryStats([
    { orders: [order('openA', { slippageBps: 1 }), order('openB', { slippageBps: -1, confirmSource: 'sync' }), order('closeA', { confirmSource: 'rest' }), order('closeB')] },
    { orders: [order('openA', { slippageBps: 3, confirmSource: 'rest', confirmAt: 1400 }), order('openB', { filledQty: 0, slippageBps: null }), order('flatten', { confirmSource: 'account' })] },
    { orders: [order('openA', { slippageBps: 5, confirmSource: 'account', confirmAt: 1600 })] },
  ]);
  assert.equal(stats.positions, 3);
  assert.equal(stats.orders, 8);
  assert.deepEqual(stats.roles.map(item => [item.role, item.label, item.orders]), [['openA', '开仓第一腿', 3], ['openB', '开仓第二腿', 2], ['closeA', '平仓 A 腿', 1], ['closeB', '平仓 B 腿', 1], ['flatten', '回补', 1]]);
  const openA = stats.roles[0];
  assert.deepEqual([openA.slipMean, openA.slipP50, openA.slipP90], [3, 3, 4.6]);
  assert.deepEqual([openA.confirmP50, openA.confirmP90], [400, 560]);
  assert.deepEqual(openA.sources.map(item => item.label), ['WS', 'REST', '对账']);
  for (const role of stats.roles) assert.ok(Math.abs(role.sources.reduce((sum, item) => sum + item.share, 0) - 1) < 1e-9, `${role.role} 来源占比合计 100%`);
  assert.equal(stats.roles[1].fillRate, 0.5);
  // 成交均价缺失（按账户持仓核对出来的成交）时服务端按限价算滑点，那是上限不是实际滑点：不计入。
  const estimated = orderTelemetryStats([{ orders: [order('flatten', { slippageBps: 2 }), order('flatten', { slippageBps: 280, avgPrice: null, confirmSource: 'account' })] }]).roles[0];
  assert.deepEqual([estimated.orders, estimated.filled, estimated.slipSamples, estimated.slipMean, estimated.slipP90], [2, 2, 1, 2, 2]);
  assert.equal(quantile([1, 3], 0.5), 2);
  assert.ok(Math.abs(quantile([1, 3], 0.9) - 2.8) < 1e-9);
  assert.equal(quantile([], 0.5), null);
  assert.equal(quantile([4, 1, 3, 2], 0.5), 2.5);
  assert.equal(msText(null), '—');
  assert.equal(msText(180.4), '180 ms');
  assert.equal(msText(2_340), '2.3 s');
});

const leg = (qty) => ({ venue: 'lighter', symbol: 'X', side: 'buy', qty, entryQuote: qty * 10, exitQty: qty, exitQuote: qty * 10, feesUsd: 0, estimated: false });
const closed = (id, closedAt, qtyA, qtyB, closeReason, singleLeg = false, extra = {}) => ({ id, symbol: 'lighter:X|entropy:X', a: leg(qtyA), b: leg(qtyB), closedAt, updatedAt: closedAt, closeReason, singleLeg, ...extra });
test('live trades: only filled positions are listed, outcomes are counted with the server rules', () => {
  const day = 86_400_000, now = 10 * day + 3_600_000;
  // nf2 的第一腿发出去没成交，nf1 是发单前就放弃的。
  const trades = [closed('nf2', now - 100, 0, 0, 'not_filled', false, { note: 'Lighter 第一腿没有成交，放弃' }), closed('nf1', now - 200, 0, 0, 'not_filled', false, { note: '开仓意图已过期，没有下单' }),
    closed('t2', now - 300, 1, 0, 'single_leg', true), closed('o1', now - 400, 0, 0, 'manual'), closed('t1', 9 * day + 5, 1, 1, 'revert')];
  const more = [closed('t0', 8 * day, 1, 1, 'stop'), closed('t1', 9 * day + 5, 1, 1, 'revert')];
  assert.deepEqual(tradedPositions({ trades, tradedMore: more }).map(item => item.id), ['t2', 't1', 't0'], '有成交的去重、新的在前');
  assert.deepEqual(tradedPositions({ trades }).map(item => item.id), ['t2', 't1'], '旧服务没有 tradedMore');
  assert.equal(tradedPositions({ trades, tradedMore: more }, 2).length, 2);
  assert.deepEqual(untradedPositions(trades).map(item => item.id), ['nf2', 'nf1', 'o1']);
  assert.deepEqual(outcomeCounts(trades), { traded: 2, notFilled: 2, other: 1, singleLeg: 1, unsent: 1 });
  const abnormal = closed('b-only', now, 0, 1, 'manual');
  assert.deepEqual(outcomeCounts([abnormal]), { traded: 1, notFilled: 0, other: 0, singleLeg: 0, unsent: 0 }, '只有 B 腿有量（先发 B 腿、A 腿没对冲上）也算有成交，与服务端汇总一致');
  assert.equal(tradedPositions({ trades: [abnormal] }).length, 1);
  assert.equal(firstLegSent(trades[0]), true);
  assert.equal(firstLegSent(trades[1]), false);
  assert.equal(firstLegSent({ note: '此刻的卖一已越过限价', orders: [{ role: 'openA' }] }), true, '逐单记录里有开仓 A 腿就是发出去过');
  assert.equal(firstLegSent({ note: '', orders: [] }), false);
  const fallback = liveOutcomes({ trades, now });
  assert.deepEqual(fallback, { today: { traded: 1, notFilled: 2, other: 1, singleLeg: 1, unsent: 1 }, total: { traded: 2, notFilled: 2, other: 1, singleLeg: 1, unsent: 1 }, recent: 5 }, '没有 outcomes 时用最近的 trades 估，今天按 UTC 日');
  // 旧服务的计数没有 unsent：第一腿没成交的全部按发出去算。
  const server = { today: { traded: 0, notFilled: 1, other: 0, singleLeg: 0 }, total: { traded: 30, notFilled: 10, other: 2, singleLeg: 3 } };
  assert.deepEqual(liveOutcomes({ trades, now, outcomes: server }), { ...server, recent: null });
  assert.equal(outcomeText(server.total), '有成交 30 · 第一腿未成交 10 · 其他未成交 2 · 单腿 3');
  assert.equal(firstLegMissRate(server.total), 0.25);
  assert.equal(firstLegMissRate({ traded: 0, notFilled: 0, other: 4, singleLeg: 0 }), null);
  // 发单前就放弃的不算第一腿未成交，也不进未成交率的分母。
  const counted = { ...server.total, unsent: 4 };
  assert.equal(firstLegMissed(counted), 6);
  assert.equal(outcomeText(counted), '有成交 30 · 第一腿未成交 6 · 发单前放弃 4 · 其他未成交 2 · 单腿 3');
  assert.equal(firstLegMissRate(counted), 6 / 36);
  assert.equal(firstLegMissRate({ traded: 0, notFilled: 3, other: 0, singleLeg: 0, unsent: 3 }), null, '一笔第一腿都没发出去过');
});

test('live position mark cells and breakdown rows degrade to dashes', () => {
  const none = positionMarkCells(undefined, 125 * 60_000);
  assert.deepEqual([none.pnl, none.entry, none.exit, none.stop, none.hold], ['—', '—', '—', '—', '2 小时 5 分']);
  const mark = { at: 1, pnlBps: 3.2, netUsd: 0.05, estimated: true, signalSpread: 12, entrySpread: 10.5, entryBaseline: 1, baseline: 1.5, deviation: 4, exitBps: 1, stopBps: 20, maxHoldMinutes: 120 };
  const cells = positionMarkCells(mark, 30 * 60_000 + 5_000);
  assert.deepEqual([cells.pnl, cells.pnlFoot, cells.pnlTone], ['+3.2', '净 +$0.05 · 估', 'up']);
  assert.deepEqual([cells.entry, cells.entryFoot], ['10.5', '信号 12.0 · 差 -1.5']);
  assert.deepEqual([cells.exit, cells.exitFoot], ['4.0 / 1.0', '还差 3.0']);
  assert.deepEqual([cells.stop, cells.stopFoot, cells.stopWarn], ['还差 23.2', '止损线 -20.0', false]);
  assert.deepEqual([cells.hold, cells.holdFoot], ['30 / 120 分钟', '还剩 90 分钟']);
  const empty = positionMarkCells({ ...mark, pnlBps: null, netUsd: null, estimated: null, signalSpread: null, entrySpread: null, deviation: null }, 200 * 60_000);
  assert.deepEqual([empty.pnl, empty.pnlFoot, empty.entry, empty.entryFoot, empty.exit, empty.exitFoot, empty.stop, empty.holdFoot], ['—', '', '—', '', '— / 1.0', '缺样本或基线', '—', '已到最长持有']);
  assert.equal(positionMarkCells({ ...mark, pnlBps: -16 }, 0).stopWarn, true, '离止损不到四分之一时警示');
  assert.equal(positionMarkCells({ ...mark, deviation: 0.5 }, 0).exitFoot, '已到出场线');
  // 入场价差比信号好还是差随方向相反：A 偏贵时卖 A，成交价差比信号小是差；A 偏便宜时买 A，成交价差比信号小是好。
  assert.equal(positionMarkCells(mark, 0, { direction: 'a_rich', state: 'open' }).entryFoot, '信号 12.0 · 比信号差 1.5');
  assert.equal(positionMarkCells(mark, 0, { direction: 'a_cheap', state: 'open' }).entryFoot, '信号 12.0 · 比信号好 1.5');
  assert.equal(positionMarkCells({ ...mark, entrySpread: 12.01 }, 0, { direction: 'a_rich', state: 'open' }).entryFoot, '信号 12.0 · 与信号一致');
  // 出场线可以是负数：偏离要降到它及以下才回归平仓。
  assert.equal(positionMarkCells({ ...mark, exitBps: -2, deviation: 1 }, 0).exitFoot, '还差 3.0');
  assert.equal(positionMarkCells({ ...mark, exitBps: -2, deviation: -2 }, 0).exitFoot, '已到出场线');
  assert.equal(positionMarkCells({ ...mark, deviation: null }, 0, { direction: 'a_rich', state: 'closing' }).exitFoot, '不在持有中，不估值');
  assert.equal(positionMarkCells({ ...mark, deviation: null }, 0, { direction: 'a_rich', state: 'open' }).exitFoot, '缺样本或基线');
  // 浮盈的颜色跟大字（不含成本的基点）走；净额在小字里。
  assert.equal(positionMarkCells({ ...mark, pnlBps: 3, netUsd: -0.02 }, 0).pnlTone, 'up');
  // 浮亏越过止损线：还差写成负数并警示。
  const past = positionMarkCells({ ...mark, pnlBps: -21 }, 0);
  assert.deepEqual([past.stop, past.stopWarn], ['还差 -1.0', true]);
  assert.deepEqual(breakdownRows(undefined, 'pair'), []);
  assert.deepEqual(breakdownRows([{ key: 'lighter:NVDA|entropy:NVDA', trades: 4, wins: 3, netUsd: 1.2 }], 'pair'), [{ key: 'lighter:NVDA|entropy:NVDA', label: 'NVDA', sub: '主网↔Entropy', trades: 4, winRate: 0.75, netUsd: 1.2 }]);
  assert.equal(breakdownRows([{ key: 'not_a_reason', trades: 0, wins: 0, netUsd: 0 }], 'reason')[0].winRate, null);
  assert.equal(breakdownRows([{ key: 'stop', trades: 1, wins: 0, netUsd: -1 }], 'reason')[0].label, '止损');
  assert.equal(breakdownRows([{ key: '2026-01-02', trades: 1, wins: 1, netUsd: 1 }], 'day')[0].label, '2026-01-02');
});

test('lead tab route, form validation matches server, candidate fill and chart rows', () => {
  assert.deepEqual(parseRoute('#/varlighter/lead'), { page: 'varlighter', tab: 'lead', symbol: null });
  assert.equal(varLighterHref('lead'), '#/varlighter/lead');

  const candidate = {
    symbol: 'NVDA',
    kind: 'us_equity',
    leads: { binance_perp: 'NVDAUSDT', binance_equity: 'NVDA', hl_xyz: 'xyz:NVDA' },
    targets: { lighter: 'NVDA', rh: 'NVDA', entropy: 'NVDA' },
    leadCount: 3,
    targetCount: 3,
  };
  const filled = applyCandidate(DEFAULT_LEAD_FORM, candidate);
  assert.equal(filled.symbol, 'NVDA');
  assert.equal(filled.binance_perp, 'NVDAUSDT');
  assert.equal(filled.binance_equity, 'NVDA');
  assert.equal(filled.hl_xyz, 'xyz:NVDA');
  assert.equal(filled.rh, 'NVDA');

  const req = leadWatcherRequest({ ...filled, symbol: ' nvda ', binance_perp: ' nvdauSdt ', hl_xyz: ' xyz:NVDA ' });
  assert.ok(req.ok);
  assert.equal(req.value.leads.hl_xyz, 'xyz:NVDA');
  assert.deepEqual(readLeadWatcherConfig(req.value), req.value, '服务端校验接受前端生成的参数');

  const invalid = [
    [{ symbol: '' }, '基础标的代码无效（应为 1–24 位大写字母或数字，如 NVDA、BTC）'],
    [{ binance_perp: '', binance_spot: '', binance_equity: '', hl_xyz: '', coinbase_spot: '', okx_perp: '', bybit_perp: '' }, '至少选择一个参考领先源并填写标的代码'],
    [{ lighter: '', rh: '', entropy: '' }, '至少选择一个目标 DEX 场所并填写标的代码'],
    [{ binance_perp: 'bad!' }, 'Binance 合约 代码格式无效'],
    [{ thresholdBps: 'abc' }, '触发阈值（基点）须填数字'],
    [{ impulseWindowMs: '50' }, '变化窗口（毫秒）须在 100 到 10000 之间'],
    [{ impulseWindowMs: '500.5' }, '变化窗口（毫秒）须为整数'],
    [{ followRatio: '1.2' }, '跟进判定比例须在 0.2 到 1 之间'],
  ];
  for (const [patch, err] of invalid) {
    assert.deepEqual(leadWatcherRequest({ ...filled, ...patch }), { ok: false, error: err });
  }

  assert.equal(formatLagMs(null), '—');
  assert.equal(formatLagMs(240), '+240 ms');
  assert.equal(formatLagMs(-150), '−150 ms');
  assert.equal(formatLagMs(1250), '+1.25 s');
  assert.equal(formatDbBytes(null), '—');
  assert.equal(formatDbBytes(2048), '2.0 KB');
  assert.equal(catalogSummaryText({
    loading: false,
    at: 1000,
    sources: {
      binance_perp: { ok: 1000, count: 10, error: null },
      binance_spot: { ok: 1000, count: 10, error: null },
      binance_equity: { ok: null, count: 0, error: null },
      hl_xyz: { ok: null, count: 0, error: 'timeout' },
      coinbase_spot: { ok: 1000, count: 5, error: null },
      okx_perp: { ok: 1000, count: 8, error: null },
      bybit_perp: { ok: 1000, count: 8, error: null },
    },
    contracts: { binance_perp: [], binance_spot: [], binance_equity: [], hl_xyz: [], coinbase_spot: [], okx_perp: [], bybit_perp: [] },
  }), '已连目录 5/6 · 异常 1');

  const analyze = {
    symbol: 'NVDA',
    activeLead: 'binance_equity',
    availableLeads: ['binance_equity', 'binance_perp'],
    from: 1000,
    to: 7000,
    xcorrFrom: 1000,
    xcorrTo: 7000,
    xcorrTruncated: false,
    gridTruncated: false,
    bucketMs: 300_000,
    computedMs: 12,
    eventCount: 4,
    dataRange: { firstAt: 1000, lastAt: 7000 },
    leaderboard: [],
    buckets: [
      { at: 1000, events: 4, venues: { lighter: { followed: 4, unfollowed: 0, followRate: 1, medianMs: 220 } } },
    ],
    venues: [
      { venue: 'lighter', name: 'Lighter 主网', symbol: 'NVDA', followed: 4, unfollowed: 0, disconnected: 0, noData: 0, cancelled: 0, pending: 0, followRate: 1, bnLeadCount: 4, dexLeadCount: 0, tieCount: 0, bnLeadRate: 1, medianMs: 220, meanMs: 220, p25Ms: 210, p75Ms: 230, p90Ms: 240, p95Ms: 240, minMs: 200, maxMs: 240, xcorr: { peakLagMs: 200, peakCorr: 0.9, zeroCorr: 0.5, samples: 100, points: [{ lagMs: 0, corr: 0.5, samples: 100 }, { lagMs: 200, corr: 0.9, samples: 100 }] }, xcorrReason: null },
    ],
    events: [],
    series: [{ t: 1000, values: { binance_equity: 0, binance_perp: 0, lighter: 0 } }, { t: 1250, values: { binance_equity: 4.2, binance_perp: 3.1, lighter: 1.2 } }],
  };
  assert.deepEqual(buildBucketRows(analyze), [{ time: 1000, lighter: 220, rh: null, entropy: null, events: 4 }]);
  assert.deepEqual(buildAnalyzeXcorrRows(analyze), [{ time: 0, lighter: 0.5, rh: null, entropy: null }, { time: 200, lighter: 0.9, rh: null, entropy: null }]);
  assert.deepEqual(buildAnalyzeSeriesRows(analyze), [
    { time: 1000, binance_perp: 0, binance_spot: null, binance_equity: 0, hl_xyz: null, coinbase_spot: null, okx_perp: null, bybit_perp: null, lighter: 0, rh: null, entropy: null },
    { time: 1250, binance_perp: 3.1, binance_spot: null, binance_equity: 4.2, hl_xyz: null, coinbase_spot: null, okx_perp: null, bybit_perp: null, lighter: 1.2, rh: null, entropy: null },
  ]);

  assert.deepEqual(formFromConfig({ ...req.value, targets: { lighter: 'NVDA' } }), {
    symbol: 'NVDA',
    binance_perp: 'NVDAUSDT',
    binance_spot: '',
    binance_equity: 'NVDA',
    hl_xyz: 'xyz:NVDA',
    coinbase_spot: '',
    okx_perp: '',
    bybit_perp: '',
    lighter: 'NVDA',
    rh: '',
    entropy: '',
    thresholdBps: '3',
    impulseWindowMs: '1000',
    followRatio: '0.5',
    maxWaitMs: '10000',
    cooldownMs: '2000',
  });
  assert.deepEqual([lagTone(50), lagTone(-50), lagTone(0), lagTone(null)], ['up', 'down', '', '']);
  assert.equal(lagVerdict({ name: 'Lighter 主网', followed: 2, medianMs: 120, xcorr: null }, 'Binance 股票'), 'Binance 股票领先约 +120 ms');
  assert.equal(lagVerdict({ name: 'Entropy', followed: 2, medianMs: -80, xcorr: null }), 'Entropy反超约 +80 ms');
  assert.equal(lagVerdict({ name: 'Lighter RH', followed: 2, medianMs: 10, xcorr: null }), '两边基本同步（±20 ms）');
  assert.equal(lagVerdict({ name: 'Entropy', followed: 0, medianMs: null, xcorr: { peakLagMs: 200, peakCorr: 0.9, zeroCorr: 0.5, samples: 80, points: [] } }, 'HL xyz'), '互相关显示HL xyz领先 200 ms');
  assert.equal(lagVerdict({ name: 'Entropy', followed: 0, medianMs: null, xcorr: null }), '等待足够波动样本');
  assert.deepEqual(formatEventVenue({ status: 'followed', lagMs: 180, maxMoveBps: 3 }), { text: '+180 ms', tone: 'ok' });
  assert.deepEqual(formatEventVenue({ status: 'followed', lagMs: -150, maxMoveBps: 3 }), { text: '−150 ms', tone: 'warn' });
  assert.deepEqual(formatEventVenue({ status: 'unfollowed', lagMs: null, maxMoveBps: 0.5 }), { text: '未跟进', tone: 'bad' });
  assert.deepEqual(formatEventVenue({ status: 'disconnected', lagMs: null, maxMoveBps: null }), { text: '中途断线', tone: 'warn' });
  assert.deepEqual(formatEventVenue(undefined), { text: '—', tone: '' });
});
