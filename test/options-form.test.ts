// The options page's conversions (web/src/options-form.ts): the bodies it sends pass the server's own checks
// (optionsViews), and the payoff, chain rows and task summaries read the way the workbench Greeks page shows them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContractError } from '../src/contracts.ts';
import type { OptionsEngine } from '../src/options/engine.ts';
import { optionsViews } from '../src/service/options.ts';
import { autoOpenConfirm, chainLines, coverageLine, groupLabel, markedRows, performanceStatus, plotRows, plotTick, utcMinute, selectedSeries, orderState, parseQuantity, payoffCurve, planBody, scheduleTime, startBody, startRefused, taskSummary } from '../web/src/options-form.ts';
import type { ChainRow, Execution, OrderRow, PerformanceGroup, PerformanceView, Plan, PreviewLeg, Task } from '../web/src/options-types.ts';

const PLAN: Plan = {
  planId: 'a'.repeat(32), operation: 'open', mode: 'iron_condor', createdAt: 0, expiresAt: 30_000, legs: [], estimatedGrossUsd: 100, estimatedFeeUsd: 2,
  estimatedNetUsd: 98, estimatedMarginUsd: 500, unboundedLoss: false, minNetIncomeUsd: 98, maxNetCostUsd: null,
};

function captured() {
  const calls: unknown[] = [];
  const engine = { createPlan: async (request: unknown) => { calls.push(request); return {}; }, startTask: async (request: unknown) => { calls.push(request); return {}; } } as unknown as OptionsEngine;
  return { calls, views: optionsViews(engine) };
}

test('期权页面表单：数量只收正数（最多 8 位小数），计划与启动请求体通过服务端校验，净价限制按开仓 / 平仓换字段', async () => {
  assert.equal(parseQuantity(' 0.25 '), '0.25');
  assert.equal(parseQuantity('01'), '1');
  for (const bad of ['0', '-1', '1e2', '0.123456789', 'abc', '']) assert.equal(parseQuantity(bad), null);
  const { calls, views } = captured();
  await views.plan(planBody('open', '0.5', 'short_strangle'));
  await views.plan(planBody('close', '0.5', 'iron_condor'));
  assert.deepEqual(calls, [{ operation: 'open', quantity: '0.5', mode: 'short_strangle' }, { operation: 'close' }]);

  const kept = startBody(PLAN, 'req-0000-0001', '');
  assert.ok('body' in kept);
  await views.start(kept.body);
  const typed = startBody(PLAN, 'req-0000-0002', ' 90.5 ');
  assert.ok('body' in typed && typed.body.minNetIncomeUsd === 90.5);
  await views.start(typed.body);
  const closing = startBody({ ...PLAN, operation: 'close', minNetIncomeUsd: null, maxNetCostUsd: 40 }, 'req-0000-0003', '-5');
  assert.ok('body' in closing && closing.body.maxNetCostUsd === -5 && !('minNetIncomeUsd' in closing.body));
  await views.start(closing.body);
  assert.equal(calls.length, 5);
  for (const bad of ['abc', '1e3', '99999999', '--1']) assert.ok('error' in startBody(PLAN, 'req-0000-0004', bad));
});

test('期权页面表单：只有服务端对启动本身的拒绝才换请求编号；无应答、401/403 与 5xx 保留编号', () => {
  assert.equal(startRefused(new ContractError(409, 'plan_used', 'x')), true);
  assert.equal(startRefused({ status: 400 }), true);
  for (const unknown of [new Error('timeout'), { status: 401 }, { status: 403 }, { status: 503 }]) assert.equal(startRefused(unknown), false);
});

const leg = (symbol: string, side: 'Buy' | 'Sell', optionType: 'Call' | 'Put', strike: number): PreviewLeg => ({ symbol, side, optionType, strike, delta: 0, qty: '1', mark: 0, targetDelta: 0, estimatedFeeUsd: 0, feeCapUsd: 0, feeBasisPrice: 0 });

test('期权页面：到期盈亏曲线照工作台取样，铁鹰平衡点在卖出行权价外侧净权利金处', () => {
  const legs = [leg('p1', 'Buy', 'Put', 84_000), leg('p2', 'Sell', 'Put', 98_000), leg('c2', 'Sell', 'Call', 102_000), leg('c1', 'Buy', 'Call', 116_000)];
  const curve = payoffCurve({ netCreditUsd: 1_000, legs })!;
  assert.equal(curve.samples.length, 121);
  assert.equal(curve.max, 1_000);
  assert.equal(curve.min, -13_000);
  assert.deepEqual(curve.breakevens.map(Math.round), [97_000, 103_000]);
  assert.equal(payoffCurve({ netCreditUsd: 0, legs: [] }), null);
});

const row = (strike: number, optionType: 'Call' | 'Put'): ChainRow => ({ symbol: `BTC-${strike}-${optionType[0]}`, expiry: 1, strike, optionType, delta: 0, mark: 1, bid: 1, ask: 1, iv: 0, volume: 0, openInterest: 0, bidSize: 0, askSize: 0 });

test('期权页面：期权链显示离指数最近的 12 个行权价，加上策略腿的行权价，并标出平值与策略行', () => {
  const rows = Array.from({ length: 30 }, (_, index) => 60_000 + index * 2_000).flatMap(strike => [row(strike, 'Call'), row(strike, 'Put')]);
  const lines = chainLines(rows, 100_500, ['BTC-60000-P']);
  assert.equal(lines.length, 13);
  assert.equal(lines[0]!.strike, 60_000);
  assert.ok(lines[0]!.selected);
  assert.deepEqual(lines.filter(line => line.atm).map(line => line.strike), [100_000]);
  assert.deepEqual(chainLines([], null, []), []);
});

const TASK = {
  id: 't1', type: 'open', status: 'running', planId: 'p', requestId: 'r', acceptedAt: 0, startedAt: 0, finishedAt: null, stopRequested: false, stopRequestedAt: null,
  mode: 'iron_condor', links: [], minNetIncomeUsd: null, maxNetCostUsd: null, netBlocked: false, riskBlocked: false, openingGroup: null, strategyStatus: null, closedAt: null, closeReason: null, error: null,
  legs: { A: { symbol: 'A', side: 'Sell', qty: '1', expiry: 0, strike: 1, optionType: 'Call', referencePrice: 0, chainPrice: 0 }, B: { symbol: 'B', side: 'Buy', qty: '1', expiry: 0, strike: 2, optionType: 'Call', referencePrice: 0, chainPrice: 0 } },
} as Task;
const order = (symbol: string, filledQty: string, terminal: boolean, status = terminal ? 'filled' : 'unknown'): OrderRow => ({ link: `l-${symbol}`, taskId: 't1', symbol, side: 'Sell', qty: '1', reduceOnly: false, status, terminal, filledQty, orderId: 'o', createdAt: 0, updatedAt: 0 });
const fill = (symbol: string, side: 'Buy' | 'Sell', execQty: number, execPrice: number, feeCurrency = 'USDT'): Execution => ({ execId: `${symbol}${execQty}`, symbol, side, orderId: 'o', orderLinkId: 'l', execFee: 0.5, feeCurrency, execPrice, execQty, execTime: 0, reduceOnly: false, taskId: 't1', chainPrice: null, chainPriceDiff: null });

test('期权页面：组合进度按委托成交数量，金额只在各腿成交明细齐全且同一币种时显示，结束后未终结的委托为待核对', () => {
  const orders = [order('A', '1', true), order('B', '0.5', false)];
  const summary = taskSummary(TASK, orders, [fill('A', 'Sell', 1, 100), fill('B', 'Buy', 0.5, 20)]);
  assert.deepEqual([summary.completedLegs, summary.totalLegs, summary.ratio], [1, 2, 0.75]);
  assert.equal(summary.amountsComplete, true);
  assert.deepEqual([summary.gross, summary.fee, summary.net], [90, 1, 89]);
  assert.equal(summary.legs[1]!.unknown, false);
  assert.equal(orderState(orders[1]!, TASK).label, '挂单中');
  // A fill missing from the list (only the latest are kept) or two currencies: the amounts read 待核对.
  assert.equal(taskSummary(TASK, orders, [fill('A', 'Sell', 1, 100)]).amountsComplete, false);
  assert.equal(taskSummary(TASK, orders, [fill('A', 'Sell', 1, 100), fill('B', 'Buy', 0.5, 20, 'USDC')]).amountsComplete, false);
  const ended = { ...TASK, status: 'failed' } as Task;
  assert.equal(taskSummary(ended, orders, []).legs[1]!.unknown, true);
  assert.equal(orderState(orders[1]!, ended).label, '状态未知 · 待核对');
  assert.equal(orderState(order('A', '0.3', true, 'timeout_cancelled'), ended).label, '部分成交 · 已结束');
  assert.equal(orderState(order('A', '0', true, 'timeout_cancelled'), ended).label, '已撤单');
});

test('the auto-open confirmation names the window, the strategy, the limits and what IOC can and cannot do', () => {
  const settings = { maxRiskUsd: 1500, maxMarginUsd: 8000, legQty: '0.05', strategyMode: 'iron_condor' as const, orderTimeoutSeconds: 60, feeRate: 0.0003, marginBufferPct: 10, marginMode: 'PORTFOLIO_MARGIN' };
  const schedule = { enabled: false, source: 'config' as const, configEnabled: false, hourUtc: 8, minuteUtc: 5, windowSeconds: 60, marketFallback: false, nextAt: 0, inWindow: false, waiting: false, lastOpenWeek: null, lastError: null };
  assert.equal(scheduleTime(schedule), '周五 08:05 UTC');
  const text = autoOpenConfirm(settings, schedule);
  assert.match(text, /每周五 08:05 UTC 起 60 秒内/);
  assert.match(text, /四腿铁鹰，每腿 0\.05 BTC，最大亏损上限 \$1,500，保证金上限 \$8,000/);
  assert.match(text, /不补单/);
  assert.doesNotMatch(text, /5 秒内就会实盘开仓/);
  assert.match(autoOpenConfirm(settings, { ...schedule, waiting: true }).split('\n')[0]!, /确认后约 5 秒内就会实盘开仓/);
  assert.match(autoOpenConfirm(settings, { ...schedule, marketFallback: true }), /补发一次 IOC.*通常会把 IOC 拦下/);
});

// The page reads the engine's view with these types; a field renamed on either side fails the type check here.
const _performanceViewMatches = (engine: OptionsEngine): PerformanceView => engine.performanceView();
void _performanceViewMatches;

test('期权收益页：缺口前插入断开行，鼠标只落在真实点上；结束点不算采样', () => {
  const { rows, hover, gaps, sampled } = plotRows([{ time: 0, pnl: 1, gapBefore: true }, { time: 60_000, pnl: 2 }, { time: 600_000, pnl: 3, gapBefore: true }, { time: 660_000, pnl: 4, terminal: true }], point => point.pnl);
  // A leading gap flag has nothing before it to break from.
  assert.deepEqual(rows.map(row => row.value), [1, 2, null, 3, 4]);
  assert.deepEqual(hover.map(row => row.value), [1, 2, 3, 4]);
  assert.deepEqual([gaps, sampled], [1, 3]);
});

test('期权收益页：综合曲线只取全部点属于纳入组合的币种曲线；状态与覆盖说明同工作台', () => {
  const group = (id: string, value: Partial<PerformanceGroup>) => ({ id, currency: 'USDC', eligible: false, status: 'closed', closureKind: 'early', ...value }) as PerformanceGroup;
  const series = { currency: 'USDC', points: [{ time: 1, pnl: 2, cumulative: 2, groupId: 'a', terminal: true as const }], totalPnl: 2, closedCount: 1, wins: 1, maxDrawdown: 0, sampleSeconds: 60, sampledCount: 0, unsampledCount: 1 };
  const groups = [group('a', { eligible: true, closureKind: 'expiry' }), group('b', { status: 'pending', closureKind: 'unknown' }), group('c', { status: 'open', closureKind: 'early' })];
  assert.equal(selectedSeries({ series: [series], groups }, 'USDC').totalPnl, 2);
  assert.equal(selectedSeries({ series: [series], groups: groups.slice(1) }, 'USDC').closedCount, 0);
  assert.equal(selectedSeries({ series: [series], groups }, 'USDT').points.length, 0);
  assert.deepEqual(groups.map(groupLabel), ['到期结束', '待核对', '提前减仓 · 持仓中']);
  assert.equal(coverageLine(groups, 0), '3 次组合开仓 · 1 组到期纳入 · 1 组提前平仓排除 · 1 组待核对');
  assert.match(coverageLine(groups, 2), /2 笔平仓尚未可靠归属$/);
  const view = { error: null, ledger: { count: 4, firstAt: Date.UTC(2026, 10, 13, 10) } };
  assert.deepEqual(performanceStatus(view, null), { text: '台账起始 2026-11-13 UTC · 4 笔成交 · 按订单同步成交与手续费', warning: false });
  assert.equal(performanceStatus(view, '超时').warning, true);
  assert.deepEqual(performanceStatus({ ...view, error: '部分订单的成交明细补读失败，下次再读' }, null).warning, true);
  assert.equal(performanceStatus(null, null).text, '正在同步收益台账…');
  assert.deepEqual(performanceStatus(null, '超时'), { text: '收益台账读取失败：超时', warning: true });
  assert.deepEqual(performanceStatus(view, '超时').text, '收益台账同步失败，等待重试；下方为上次快照。');
  const more = [group('d', { status: 'open', closureKind: 'unknown' }), group('e', {}), group('f', { closureKind: 'unknown' })];
  assert.deepEqual(more.map(groupLabel), ['持仓中', '提前平仓', '结束待验证']);
});

test('期权收益页：时间刻度跨一天改显示日期；无时间显示 --；圆点约 80 个且保留最后与结束点', () => {
  const at = Date.UTC(2026, 10, 13, 9, 5);
  assert.equal(plotTick(86_400_000 - 1)(at), '09:05');
  assert.equal(plotTick(86_400_000)(at), '11-13');
  assert.equal(utcMinute(null), '--');
  assert.equal(utcMinute(at), '2026-11-13 09:05');
  const rows = Array.from({ length: 200 }, (_, index) => ({ time: index, value: index, point: index === 101 ? { time: index, pnl: index, terminal: true as const } : { time: index, pnl: index } }));
  const marked = markedRows(rows).map(row => row.time);
  assert.ok(marked.length <= 82, String(marked.length));
  assert.deepEqual([marked[0], marked.includes(101), marked.at(-1)], [0, true, 199]);
  assert.deepEqual(markedRows(rows.slice(0, 5)).map(row => row.time), [0, 1, 2, 3, 4]);
});
