// 组合询价 (G2c) pure rules: how a venue observation moves the record, and the venue lists read into a request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { counterpartiesFrom, filledOrders, observe, rfqFinished, strategyTypeFor, validRfq, type RfqRecord, type RfqStatus } from '../src/options/rfq.ts';

const LEGS = [
  { symbol: 'BTC-15NOV26-98000-P', side: 'Sell' as const, qty: '1', expiry: 0, strike: 98_000, optionType: 'Put' as const, referencePrice: 940 },
  { symbol: 'BTC-15NOV26-84000-P', side: 'Buy' as const, qty: '1', expiry: 0, strike: 84_000, optionType: 'Put' as const, referencePrice: 260 },
];
function record(status: RfqStatus, extra: Partial<RfqRecord> = {}): RfqRecord {
  return {
    requestId: 'rfq-00000001', fingerprint: '[]', taskId: 'abcdef0123456789', linkId: 'tporfqabcdef0123456789', rfqId: 'r1', status, mode: 'iron_condor', strategyType: 'custom',
    counterparties: ['DESK1'], legs: structuredClone(LEGS), risk: { legs: {}, context: {} as never, budgetUsd: 1, reservedUsd: 1 }, feeContext: { index: 100_000, feeRate: 0.0003, feeCapPct: 0.07 },
    createdAt: 1, updatedAt: 1, expiresAt: 1_000_000, selectedQuoteId: null, selectedDesk: null, selectedPrices: null, executionChain: null,
    executionStartedAt: null, executionResolved: false, trackingApplied: false, error: null, ...extra,
  };
}
const seen = (status: RfqStatus) => ({ rfqId: 'r1', rfqLinkId: 'tporfqabcdef0123456789', status, expiresAt: 2_000_000 });

test('询价观察：滞后的 Active 不会撤销执行或取消；终态不再变化；编号不符拒绝', () => {
  const executing = record('ExecutionUnknown', { selectedQuoteId: 'q1' });
  observe(executing, seen('Active'), 5);
  assert.equal(executing.status, 'ExecutionUnknown');
  observe(executing, seen('PendingFill'), 6);
  assert.equal(executing.status, 'PendingFill');
  observe(executing, seen('Active'), 7);
  assert.equal(executing.status, 'PendingFill', 'PendingFill 不回到 Active');
  observe(executing, seen('Filled'), 8);
  assert.equal(executing.status, 'Filled');
  assert.equal(executing.executionResolved, true);
  assert.equal(observe(executing, seen('Expired'), 9), false);
  assert.equal(executing.status, 'Filled');
  const cancelling = record('CancelUnknown');
  observe(cancelling, seen('Active'), 5);
  assert.equal(cancelling.status, 'CancelUnknown');
  observe(cancelling, seen('Expired'), 6);
  assert.equal(cancelling.status, 'Expired');
  const creating = record('CreationUnknown', { rfqId: null });
  assert.equal(observe(creating, seen('Active'), 5), true);
  assert.deepEqual([creating.status, creating.rfqId, creating.expiresAt, creating.updatedAt], ['Active', 'r1', 2_000_000, 5]);
  assert.throws(() => observe(record('Active'), { ...seen('Active'), rfqId: 'other' }, 5));
});

test('询价结束判定：已成交但未跟踪、选中报价未出结果都仍锁定', () => {
  assert.equal(rfqFinished(null), true);
  assert.equal(rfqFinished(record('Active')), false);
  assert.equal(rfqFinished(record('Filled')), false);
  assert.equal(rfqFinished(record('Filled', { trackingApplied: true })), true);
  assert.equal(rfqFinished(record('Expired', { selectedQuoteId: 'q1' })), false);
  assert.equal(rfqFinished(record('Expired', { selectedQuoteId: 'q1', executionResolved: true })), true);
});

test('询价请求：做市商按 maxLP 截取且去重，没有时拒绝；铁鹰用交易所列出的组合类型，其余 custom', () => {
  assert.deepEqual(counterpartiesFrom({ maxLP: 2, counterparties: [{ deskCode: 'A' }, { deskCode: 'A' }, { deskCode: 'B' }, { deskCode: 'C' }, { deskCode: 'bad code' }] }), ['A', 'B']);
  assert.throws(() => counterpartiesFrom({ counterparties: [] }));
  assert.equal(strategyTypeFor('iron_condor', { strategyTypes: [{ strategyName: 'Strangle' }, { strategyName: 'Iron Condor' }] }), 'Iron Condor');
  assert.equal(strategyTypeFor('iron_condor', { strategyTypes: [{ strategyName: 'Strangle' }] }), 'custom');
  assert.equal(strategyTypeFor('short_strangle', { strategyTypes: [{ strategyName: 'Strangle' }] }), 'custom');
});

test('询价成交记录：每条腿数量、结果码与订单号都须对上（方向口径未实测，不比较），未到时为 null', () => {
  const rfq = record('Filled');
  const legs = [{ symbol: LEGS[0]!.symbol, side: 'Sell', qty: '1', price: '950', orderId: 'b1', resultCode: 0 }, { symbol: LEGS[1]!.symbol, side: 'Buy', qty: '1.0', price: '250', orderId: 'b2', resultCode: 0 }];
  assert.equal(filledOrders(rfq, []), null);
  assert.deepEqual(filledOrders(rfq, [{ rfqId: 'r1', status: 'Filled', legs }]), { [LEGS[0]!.symbol]: { orderId: 'b1', price: 950 }, [LEGS[1]!.symbol]: { orderId: 'b2', price: 250 } });
  assert.ok(filledOrders(rfq, [{ rfqId: 'r1', status: 'Filled', legs: [legs[0], { ...legs[1], side: 'Sell' }] }]), '报价方视角的方向不拦');
  assert.throws(() => filledOrders(rfq, [{ rfqId: 'r1', status: 'Filled', legs: [legs[0], { ...legs[1], qty: '2' }] }]));
  assert.throws(() => filledOrders(rfq, [{ rfqId: 'r1', status: 'Filled', legs: [legs[0], { ...legs[1], orderId: '' }] }]));
  assert.throws(() => filledOrders(rfq, [{ rfqId: 'r1', status: 'Filled', legs: [legs[0], { ...legs[1], resultCode: 1 }] }]));
  assert.throws(() => filledOrders(rfq, [{ rfqId: 'r1', status: 'Filled', legs: [...legs, { ...legs[0], symbol: 'X' }] }]));
});

test('询价记录还原：字段不全的记录拒绝', () => {
  assert.equal(validRfq(record('Active')), true);
  assert.equal(validRfq({ ...record('Active'), status: 'Unknown' }), false);
  assert.equal(validRfq({ ...record('Active'), legs: [] }), false);
  const { executionResolved: _, ...missing } = record('Active');
  assert.equal(validRfq(missing), false);
});
