import assert from 'node:assert/strict';
import test from 'node:test';
import type { DexQuote } from '../src/chain-arb/dex.ts';
import { compareChainArb } from '../src/chain-arb/estimate.ts';
import type { ChainArbInput } from '../src/chain-arb/model.ts';
import type { VenueBook } from '../src/chain-arb/venue.ts';

const now = 1_795_690_000_000;
const input: ChainArbInput = { chain: 'ethereum', address: '0x' + 'a'.repeat(40), symbol: 'TEST', amount: '1000',
  spotFeeBps: 0, perpFeeBps: 0, spotCosts: 0, perpCosts: 0, swapGas: 'auto' };
const quote = { rawQuantity: '9000', decimals: 2, at: now, swapGasUsdt: 1.5,
  evidence: { quotedRaw: '10000', transferRaw: '8100', impactBps: 100, blockNumber: '0x123' } };
const market = { step: '0.01', bids: [['11.2', '1000']] as [string, string][], at: now };
const venue = { deposit: true, withdraw: false, spot: market, perp: market };
const compare = (buy: DexQuote, books: VenueBook = venue) => compareChainArb(input, buy, books, now);

test('买税与转账税按各自在链上实收数量反映，报价的表面正收益转为整笔亏损', () => {
  const view = compare(quote);
  assert.equal(view.dex.quantity, 90);
  assert.deepEqual(view.dex.execution, { quotedQuantity: 100, receivedQuantity: 90, transferQuantity: 81, transferAmount: '81', impactBps: 100, blockNumber: '0x123' });
  for (const leg of [view.spot, view.perp]) {
    assert.ok('netUsdt' in leg);
    assert.deepEqual([leg.quantity, leg.coveredCostUsdt, leg.grossUsdt, leg.netUsdt, leg.netBps], [81, 1000, -92.8, -94.3, -943]);
  }
});

test('缺模拟、转账失败、全额转账税或异常增发不能估值；买入正滑点可按实际数量估值', () => {
  for (const evidence of [undefined, { ...quote.evidence, transferRaw: null }, { ...quote.evidence, transferRaw: '0' },
    { ...quote.evidence, transferRaw: '9001' }, { ...quote.evidence, quotedRaw: '0' }, { ...quote.evidence, blockNumber: '' },
    { ...quote.evidence, impactBps: NaN }, { ...quote.evidence, impactBps: -1 }]) {
    const view = compare({ ...quote, evidence });
    assert.ok('error' in view.spot && 'error' in view.perp);
  }
  const better = compare({ ...quote, evidence: { ...quote.evidence, quotedRaw: '8999', transferRaw: '9000' } });
  assert.ok('quantity' in better.spot && better.spot.quantity === 90);
});

test('整笔买入相对小额损耗恰好 500 bp 可估值，超过边界两条路线均拒绝', () => {
  const cutoff = compare({ ...quote, evidence: { ...quote.evidence, impactBps: 500 } });
  assert.ok('quantity' in cutoff.spot && 'quantity' in cutoff.perp);
  const over = compare({ ...quote, evidence: { ...quote.evidence, impactBps: 500.000001 } });
  assert.match('error' in over.spot ? over.spot.error : '', /500 bp/);
  assert.deepEqual(over.perp, over.spot);
});

test('两市只能按共同步长覆盖到账量；按整笔预算核算，尾数不计回收', () => {
  const buy = { ...quote, rawQuantity: '119', evidence: { ...quote.evidence, quotedRaw: '119', transferRaw: '119' } };
  const view = compare(buy, { ...venue, spot: { ...market, step: '0.06' }, perp: { ...market, step: '0.04' } });
  assert.ok('quantity' in view.spot && 'quantity' in view.perp);
  assert.deepEqual([view.spot.quantity, view.spot.remainder, view.spot.coveredCostUsdt], [1.14, 0.05, 1000]);
  assert.deepEqual([view.perp.quantity, view.perp.remainder, view.perp.coveredCostUsdt], [1.08, 0.11, 1000]);
  assert.equal(view.perp.grossUsdt, -987.904);
});

test('永续收益依赖同所现货可卖、足量深度、配对新鲜度以及开仓和平仓的单笔限额', () => {
  const failures: VenueBook[] = [
    { ...venue, spot: { error: '现货停牌' } },
    { ...venue, spot: { ...market, bids: [['11.2', '80.99']] } },
    { ...venue, perp: { ...market, bids: [['100', '80.99']] } },
    { ...venue, spot: { ...market, at: now - 14_000 }, perp: { ...market, at: now + 1000 } },
    { ...venue, perp: { ...market, bids: [['16', '100']], minNotional: '1000' } },
    { ...venue, perp: { ...market, maxQuantity: '80.99' } },
    { ...venue, spot: { ...market, minNotional: '908' } },
  ];
  for (const books of failures) assert.ok('error' in compare(quote, books).perp);
});
