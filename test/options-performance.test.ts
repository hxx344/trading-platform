// The 收益 arithmetic, ported from the workbench's tests/test_performance.py (modules/greeks, commit 0c5a219) with the
// service's own additions: finished openings that filled nothing, evidence without amounts, exponent floats, thinning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { units } from '../src/decimal.ts';
import { parseExecution, type ExecutionRecord, type Position } from '../src/options/account.ts';
import { buildPerformance, exact, optionExpiry, thinPoints, type GroupInput, type JournalInput, type Sample } from '../src/options/performance.ts';

const NOW = Date.UTC(2026, 8, 1);
const DAY = 86_400_000, HOUR = 3_600_000;
const SYMBOL = 'BTC-6SEP26-100000-C-USDT';
const PUT = 'BTC-6SEP26-95000-P-USDT';

function fill(id: string, side: 'Buy' | 'Sell', qty: number, price: number, fee: number, day: number, group = 'a', opening: string | null = null, symbol = SYMBOL): ExecutionRecord {
  return {
    execId: id, symbol, side, orderId: id, orderLinkId: `tpo-${group}-${id}`, execFee: fee, feeCurrency: symbol.endsWith('USDT') ? 'USDT' : 'USDC',
    execPrice: price, execQty: qty, execTime: NOW + day * DAY, feeRate: null, closedSize: null, execType: 'Trade',
    reduceOnly: opening !== null, taskId: group, openingGroup: opening, chainPrice: null, chainPriceDiff: null,
  };
}
const group = (value: Partial<GroupInput> = {}): GroupInput => ({ type: 'open', status: 'completed', acceptedAt: NOW, strategyStatus: null, mode: 'iron_condor', legs: {}, closureEvidence: {}, openingGroup: null, ...value });
const entry = (taskId: string, side: 'Buy' | 'Sell', filledQty: string, reduceOnly: boolean, terminal: boolean, symbol = SYMBOL): JournalInput => ({ taskId, symbol, side, filledQty, reduceOnly, terminal });
const position = (size: string, markPrice: number): Position => ({ symbol: SYMBOL, side: 'Buy', size, avgPrice: 100, markPrice, unrealisedPnl: 30 });

function report(groups: Record<string, GroupInput>, executions: ExecutionRecord[], journal: Record<string, JournalInput> = {}, { positions = null, samples = new Map() }: { positions?: Position[] | null; samples?: Map<string, Sample[]> } = {}) {
  return buildPerformance({ groups, executions, journal, positions, samples, sampleSeconds: 60 });
}
const byId = (value: ReturnType<typeof report>) => Object.fromEntries(value.groups.map(row => [row.id, row]));

function expiryGroup({ total = 97, earlyFee = 0, closeTime = NOW + 5 * DAY + 8 * HOUR }: { total?: number; earlyFee?: number; closeTime?: number } = {}): GroupInput {
  const row = { symbol: SYMBOL, side: 'Sell', qty: '1', openTime: String(NOW), closeTime: String(closeTime), avgEntryPrice: '100', totalPnl: String(total), totalOpenFee: '1', totalCloseFee: String(earlyFee), deliveryFee: '2' };
  return group({ strategyStatus: 'closed', legs: { [SYMBOL]: { side: 'Sell', qty: '1' } }, closureEvidence: { [`${SYMBOL}|Sell`]: [row] } });
}

test('收益：只有持有到期的组合进入采样曲线，回撤按采样计算', () => {
  const partial = expiryGroup({ total: 333, earlyFee: 1 });
  // Distinct position history identities avoid ambiguous evidence reuse.
  partial.closureEvidence[`${SYMBOL}|Sell`]![0]!.openTime = String(NOW + 1_000);
  const samples = new Map<string, Sample[]>([
    ['held', [{ time: NOW + HOUR, pnl: '-1' }, { time: NOW + 2 * HOUR, pnl: '120' }, { time: NOW + 3 * HOUR, pnl: '40' }]],
    ['early', [{ time: NOW + 2 * HOUR, pnl: '999' }]],
  ]);
  const value = report({ held: expiryGroup(), early: expiryGroup({ total: 999, closeTime: NOW + 2 * DAY }), partial }, [], {}, { samples });
  assert.equal(value.series.length, 1);
  const series = value.series[0]!;
  assert.equal(series.closedCount, 1);
  assert.equal(series.totalPnl, 97);
  assert.deepEqual(series.points.map(point => point.cumulative), [-1, 120, 40, 97]);
  assert.equal(series.maxDrawdown, 80);
  assert.equal(series.sampledCount, 3);
  assert.deepEqual(value.groups.filter(row => row.eligible).map(row => row.id), ['held']);
});

test('收益：零手续费的提前部分减仓让整组到期后也不纳入', () => {
  const value = report({ a: expiryGroup() }, [fill('open', 'Sell', 1, 100, 1, 0), fill('partial', 'Buy', 0.2, 50, 0, 1, 'c', 'a')]);
  assert.equal(value.groups[0]!.status, 'closed');
  assert.equal(value.groups[0]!.closureKind, 'early');
  assert.equal(value.groups[0]!.eligible, false);
  assert.deepEqual(value.series, []);
});

test('收益：到期后手动平仓、没有交割证据，不算到期结束', () => {
  const row = report({}, [fill('open', 'Sell', 1, 100, 1, 0), fill('late', 'Buy', 1, 50, 1, 6, 'c', 'a')]).groups[0]!;
  assert.equal(row.closureKind, 'unknown');
  assert.equal(row.eligible, false);
});

test('收益：非有限数值在入账前被拒绝；指数形式的小数按原值换算', () => {
  assert.throws(() => exact(Number.NaN));
  assert.throws(() => parseExecution({ execId: 'x', symbol: SYMBOL, side: 'Buy', execQty: '1', execPrice: 'nan', execFee: '0', execTime: '1' }));
  assert.equal(exact(1e-7), units('0.0000001'));
  assert.equal(exact(-2.5e-8), units('-0.000000025'));
  assert.equal(exact(1.5e21), units('1500000000000000000000'));
  assert.equal(optionExpiry('BTC-31FEB26-100000-C'), null);
  assert.equal(optionExpiry('BTC-6SEP26-100000-C-USDT'), Date.UTC(2026, 8, 6, 8));
});

test('收益：部分平仓、手续费返还与重复成交只算一次', () => {
  const records = [fill('open', 'Sell', 2, 100, 2, 0), fill('close1', 'Buy', 0.5, 80, -0.1, 1, 'close', 'a')];
  let value = report({}, [...records, ...records]);
  assert.equal(value.groups[0]!.netPnl, 9.6);
  assert.equal(value.groups[0]!.remainingQty, 1.5);
  assert.equal(value.groups[0]!.status, 'open');
  assert.deepEqual(value.series, []);
  records.push(fill('close2', 'Buy', 1.5, 120, 0.3, 2, 'close', 'a'));
  value = report({}, records);
  assert.equal(value.groups[0]!.netPnl, -22.2);
  assert.deepEqual(value.series, []);
  assert.equal(value.groups[0]!.closureKind, 'early');
});

test('收益：组合与结算币种互不混合', () => {
  const usdc = SYMBOL.slice(0, -5);
  const value = report({}, [fill('a-open', 'Buy', 1, 100, 1, 0), fill('b-open', 'Buy', 1, 100, 1, 1, 'b'), fill('b-close', 'Sell', 1, 120, 1, 2, 'bc', 'b'),
    fill('a-close', 'Sell', 1, 90, 1, 3, 'ac', 'a'), fill('c-open', 'Buy', 1, 100, 1, 0, 'c', null, usdc), fill('c-close', 'Sell', 1, 130, 1, 4, 'cc', 'c', usdc)]);
  assert.deepEqual(value.series, []);
  assert.deepEqual(new Set(value.groups.map(row => row.currency)), new Set(['USDT', 'USDC']));
  assert.ok(value.groups.every(row => row.closureKind === 'early'));
});

test('收益：成交历史不全或手动平仓无法归属时不算收益', () => {
  const records = [fill('open', 'Buy', 1, 100, 1, 0), fill('close', 'Sell', 1, 120, 1, 1, 'c', 'a')];
  let value = report({ a: group() }, records, { link: entry('a', 'Buy', '2', false, true) });
  assert.equal(value.groups[0]!.status, 'pending');
  assert.equal(value.groups[0]!.netPnl, null);
  assert.deepEqual(value.series, []);
  records.splice(1, 0, fill('other', 'Buy', 1, 100, 1, 0, 'b'));
  records[records.length - 1] = { ...records.at(-1)!, openingGroup: null, closedSize: 1 };
  value = report({}, records);
  assert.equal(value.unassignedCloses, 1);
  assert.deepEqual(value.series, []);
});

test('收益：交易所交割证据已含手续费，不与成交收益重复计算', () => {
  const evidence = { symbol: SYMBOL, side: 'Sell', qty: '1', openTime: String(NOW), closeTime: String(NOW + 5 * DAY + 8 * HOUR), avgEntryPrice: '100', totalPnl: '97', totalOpenFee: '1', totalCloseFee: '0', deliveryFee: '2' };
  const groups = { a: group({ strategyStatus: 'closed', legs: { [SYMBOL]: { side: 'Sell', qty: '1' } }, closureEvidence: { [`${SYMBOL}|Sell`]: [evidence, { ...evidence }] } }) };
  const value = report(groups, [fill('open', 'Sell', 1, 100, 1, 0), { ...fill('close', 'Buy', 1, 0, 0, 5, 'c', 'a'), execTime: NOW + 5 * DAY + 8 * HOUR }]);
  assert.equal(value.groups[0]!.netPnl, 97);
  assert.equal(value.groups[0]!.deliveryFee, 2);
  assert.equal(value.series[0]!.totalPnl, 97);
  // Complete, verified closure records alone are enough.
  assert.equal(report(groups, []).series[0]!.totalPnl, 97);
  for (const row of groups.a.closureEvidence[`${SYMBOL}|Sell`]!) row.qty = '2';
  assert.deepEqual(report(groups, []).series, []);
});

test('收益：v0.14 之前退役、没有金额字段的证据显示待核对，不纳入', () => {
  const old = { symbol: SYMBOL, side: 'Sell', qty: '1', openTime: String(NOW), closeTime: String(NOW + 5 * DAY + 8 * HOUR) };
  const value = report({ a: group({ strategyStatus: 'closed', legs: { [SYMBOL]: { side: 'Sell', qty: '1' } }, closureEvidence: { [`${SYMBOL}|Sell`]: [old] } }) }, [fill('open', 'Sell', 1, 100, 1, 0)]);
  assert.equal(value.groups[0]!.status, 'pending');
  assert.ok(value.groups[0]!.issues.includes('交割或平仓收益待核对'));
  assert.deepEqual(value.series, []);
});

test('收益：浮动盈亏需要唯一匹配的实时持仓', () => {
  const records = [fill('open', 'Buy', 1, 100, 1, 0)];
  assert.equal(report({}, records, {}, { positions: [position('1', 130)] }).groups[0]!.floatingPnl, 30);
  assert.equal(report({}, records, {}, { positions: null }).groups[0]!.floatingPnl, null);
  assert.equal(report({}, records, {}, { positions: [position('2', 130)] }).groups[0]!.floatingPnl, null);
  // Mark to market subtracts the open fee still carried by the holding.
  assert.equal(report({}, records, {}, { positions: [position('1', 130)] }).groups[0]!.markToMarketPnl, 29);
});

test('收益：已知组合缺腿时不能算完整', () => {
  const value = report({ a: group({ legs: { [SYMBOL]: { side: 'Buy', qty: '1' }, [PUT]: { side: 'Sell', qty: '1' } } }) }, [fill('open', 'Buy', 1, 100, 1, 0), fill('close', 'Sell', 1, 120, 1, 1, 'c', 'a')]);
  assert.equal(value.groups[0]!.status, 'pending');
  assert.deepEqual(value.series, []);
});

test('收益：同一合约被两组持有时不估浮动，平掉一组后重新判断', () => {
  const records = [fill('a-open', 'Buy', 1, 100, 1, 0), fill('b-open', 'Buy', 1, 120, 1, 0, 'b')];
  const live = position('1', 130);
  assert.ok(report({}, records, {}, { positions: [live] }).groups.every(row => row.floatingPnl === null));
  records.push(fill('b-close', 'Sell', 1, 125, 1, 1, 'bc', 'b'));
  const current = byId(report({}, records, {}, { positions: [live] }));
  assert.equal(current.a!.floatingPnl, 30);
  assert.equal(current.b!.netPnl, 3);
  assert.equal(current.b!.floatingPnl, null);
  // Duplicate live observations never prove unique ownership.
  assert.ok(report({}, records, {}, { positions: [live, live] }).groups.every(row => row.floatingPnl === null));
  assert.equal(byId(report({}, records, {}, { positions: [{ ...live, markPrice: 140 }] })).a!.floatingPnl, 40);
});

test('收益：订单未结束与数量更正留在所属组合', () => {
  const groups = { a: group(), b: group(), ac: group({ type: 'close', openingGroup: 'a' }) };
  const records = [fill('a-open', 'Buy', 1, 100, 1, 0), fill('b-open', 'Sell', 1, 120, 1, 0, 'b')];
  const journal = {
    'a-journal': entry('a', 'Buy', '1', false, true), 'b-journal': entry('b', 'Sell', '1', false, false), 'close-journal': entry('ac', 'Sell', '0', true, false),
    unrelated: entry('elsewhere', 'Buy', '1', false, false),
  };
  let value = byId(report(groups, records, journal));
  assert.deepEqual(value.a!.issues, ['平仓成交仍待确认']);
  assert.deepEqual(value.b!.issues, ['开仓成交仍待确认']);
  journal['b-journal'].terminal = journal['close-journal'].terminal = true;
  assert.ok(report(groups, records, journal).groups.filter(row => row.id !== 'elsewhere').every(row => row.status === 'open'));
  journal['b-journal'].filledQty = '2';
  value = byId(report(groups, records, journal));
  assert.deepEqual(value.a!.issues, []);
  assert.deepEqual(value.b!.issues, ['开仓成交历史尚未补齐']);
});

test('收益：先进先出、手续费精确分摊，乱序与缺归属的平仓', () => {
  const records = [fill('open1', 'Sell', 2, 100, 2, 0), fill('open2', 'Sell', 1, 120, 1, 1), fill('close1', 'Buy', 2.5, 90, 0.5, 2, 'c', 'a'),
    fill('unknown', 'Buy', 1, 90, 1, 2, 'c2', 'missing'), { ...fill('manual', 'Buy', 1, 90, 1, 2, 'c3'), reduceOnly: true }];
  const value = report({}, [...[...records].reverse(), records[0]!]);
  assert.equal(value.unassignedCloses, 2);
  assert.equal(value.groups.length, 1);
  assert.equal(value.groups[0]!.netPnl, 32);
  assert.equal(value.groups[0]!.remainingQty, 0.5);
  assert.equal(value.groups[0]!.status, 'open');
  records.push(fill('close2', 'Buy', 0.5, 130, -0.1, 3, 'c4', 'a'));
  const closed = report({}, records).groups[0]!;
  assert.equal(closed.netPnl, 26.6);
  assert.equal(closed.remainingQty, 0);
});

test('收益：数量对不上的提前减仓也让到期证据不纳入', () => {
  const value = report({ a: expiryGroup(), close: group({ type: 'close', openingGroup: 'a' }) }, [fill('open', 'Sell', 1, 100, 1, 0), fill('oversized', 'Buy', 2, 50, 0, 1, 'close')]);
  assert.equal(value.groups[0]!.status, 'closed');
  assert.equal(value.groups[0]!.closureKind, 'early');
  assert.deepEqual(value.series, []);
});

test('收益：一笔没成交就结束的开仓任务不算组合开仓', () => {
  const journal = { 'tpo-f-0': entry('f', 'Buy', '0', false, true), 'tpo-s-0': entry('s', 'Buy', '0', false, true) };
  const value = report({ f: group({ status: 'failed' }), s: group({ status: 'stopped' }), r: group({ status: 'running' }) }, [], journal);
  // A running opening without fills yet is still listed (pending).
  assert.deepEqual(value.groups.map(row => [row.id, row.status]), [['r', 'pending']]);
});

test('收益：抽稀保留首尾、结束点、缺口两侧与每段最高最低', () => {
  const points = Array.from({ length: 1_000 }, (_, index) => ({ time: index * 60_000 + (index >= 500 ? 600_000 : 0), pnl: index === 250 ? 999 : index === 750 ? -999 : index % 7, ...(index === 999 ? { terminal: true as const } : {}) }));
  const thinned = thinPoints(points, 100, 180_000, point => point.pnl);
  assert.ok(thinned.length <= 110, String(thinned.length));
  assert.equal(thinned[0]!.time, 0);
  assert.equal(thinned.at(-1)!.terminal, true);
  assert.ok(thinned.some(point => point.pnl === 999) && thinned.some(point => point.pnl === -999));
  // The break sits on the first point after the gap and nowhere else.
  assert.deepEqual(thinned.filter(point => point.gapBefore).map(point => point.time), [500 * 60_000 + 600_000]);
  assert.ok(thinned.some(point => point.time === 499 * 60_000));
  // Short series pass through whole, still marking the gap.
  assert.deepEqual(thinPoints([{ time: 0, pnl: 1 }, { time: 60_000, pnl: 2 }, { time: 600_000, pnl: 3 }], 100, 180_000, point => point.pnl).map(point => point.gapBefore ?? false), [false, false, true]);
});
