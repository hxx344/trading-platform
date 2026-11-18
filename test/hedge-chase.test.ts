// Oil O8 (docs/oil.md 13): a hedge leg that chases with post-only orders and sends the rest to market once its time is up.
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { ContractError, parseFourLegIntent, parseIntent, parsePairIntent } from '../src/contracts.ts';
import { cmp } from '../src/decimal.ts';
import { SIM_ACCOUNTS } from '../src/simulation.ts';
import type { SimulatedVenue } from '../src/sim-venue.ts';
import type { Budgets } from '../src/executor.ts';
import { SESSION, bindAccounts, createHarness, previewAndConfirm, settle, type Harness } from './harness.ts';

const code = (expected: string) => (error: unknown) => error instanceof ContractError && error.code === expected;
/** Bybit market lead buying CL, Binance hedge selling CL by local chase. */
const hedgeIntent = ({ quantity = '1', timeoutMs = 60_000, chaseTimeoutMs, leadType = 'market' }: { quantity?: string; timeoutMs?: number; chaseTimeoutMs?: number; leadType?: string } = {}) => ({
  market: 'oil', preset: 'cross-exchange', symbol: 'CLUSDT', action: 'open', timeoutMs,
  legs: [
    { venue: 'bybit', side: 'long', quantity, orderType: leadType },
    { venue: 'binance', side: 'short', quantity, orderType: 'local-chase', ...(chaseTimeoutMs !== undefined ? { chaseTimeoutMs } : {}) },
  ],
});
const ordersOf = (venue: SimulatedVenue, symbol = 'CLUSDT') => [...venue.orders.values()].filter(order => order.request.symbol === symbol);
const lastOrder = (venue: SimulatedVenue, symbol = 'CLUSDT') => ordersOf(venue, symbol).at(-1)!;
const same = (a: string | null | undefined, b: string) => a != null && cmp(a, b) === 0;
async function withHarness(run: (h: Harness) => Promise<void>, budgets: Partial<Budgets> = {}) {
  const h = createHarness({ budgets });
  try { bindAccounts(h.ex); await run(h); } finally { h.dispose(); }
}
async function tick(h: Harness, ms = 1_000) { await h.ex.tick(); h.advance(ms); }
const binanceShort = (h: Harness) => h.binance.position(SIM_ACCOUNTS.binance, 'CLUSDT', 'short');

test('意图：对冲腿本地追价只限 Binance、OKX，默认追价时限 10 秒，不收界限；时限只用于本地追价对冲腿；四腿不支持', () => {
  const parsed = parsePairIntent(hedgeIntent());
  assert.equal(parsed.legs[1].orderType, 'local-chase');
  assert.equal(parsed.legs[1].chaseTimeoutMs, 10_000);
  assert.equal(parsePairIntent(hedgeIntent({ chaseTimeoutMs: 3_000 })).legs[1].chaseTimeoutMs, 3_000);
  const base = hedgeIntent();
  const okx = { ...base, legs: [base.legs[0], { ...base.legs[1], venue: 'okx' }] };
  assert.equal(parsePairIntent(okx).legs[1].orderType, 'local-chase');
  assert.throws(() => parseIntent({ ...base, legs: [{ ...base.legs[0], venue: 'binance' }, { ...base.legs[1], venue: 'bybit' }] }), code('chase_unsupported'));
  assert.throws(() => parseIntent({ ...base, legs: [base.legs[0], { ...base.legs[1], limitPrice: '70' }] }), code('limit_price'));
  assert.throws(() => parseIntent({ ...base, legs: [base.legs[0], { ...base.legs[1], orderType: 'market', chaseTimeoutMs: 5_000 }] }), code('invalid_value'));
  assert.throws(() => parseIntent({ ...base, legs: [{ ...base.legs[0], chaseTimeoutMs: 5_000 }, base.legs[1]] }), code('invalid_value'));
  assert.throws(() => parseIntent(hedgeIntent({ chaseTimeoutMs: 999 })), code('invalid_value'));
  assert.throws(() => parseIntent(hedgeIntent({ chaseTimeoutMs: 600_001 })), code('invalid_value'));
  assert.throws(() => parseIntent({ ...base, legs: [base.legs[0], { ...base.legs[1], orderType: 'chase' }] }), code('chase_unsupported'));
  const four = (hedgeType: string) => ({
    market: 'oil', preset: 'four-leg', action: 'open', timeoutMs: 60_000,
    legs: [
      { venue: 'binance', symbol: 'CLUSDT', side: 'long', orderType: 'market', barrels: '1' }, { venue: 'binance', symbol: 'BZUSDT', side: 'short', orderType: hedgeType, barrels: '1' },
      { venue: 'bybit', symbol: 'CLUSDT', side: 'short', orderType: 'market', barrels: '1' }, { venue: 'bybit', symbol: 'BZUSDT', side: 'long', orderType: 'market', barrels: '1' },
    ],
  });
  assert.equal(parseFourLegIntent(four('market')).legs[1].orderType, 'market');
  assert.throws(() => parseFourLegIntent(four('local-chase')), code('chase_unsupported'));
});

test('预览：对冲腿带追价时限、卖出挂单上限，说明写明超时转市价', () => withHarness(async h => {
  const preview = await h.ex.preview(hedgeIntent({ chaseTimeoutMs: 5_000 }), SESSION);
  const hedge = preview.legs[1]!;
  assert.equal(hedge.orderType, 'local-chase');
  assert.equal(hedge.chaseTimeoutMs, 5_000);
  assert.ok(hedge.chaseCeiling, '卖出对冲有挂单上限');
  assert.ok(preview.notes.some(note => /对冲腿本地追价/.test(note) && /超过 5 秒/.test(note) && /按市价补齐/.test(note)), preview.notes.join('\n'));
  assert.ok(!preview.notes.some(note => /^对冲腿按市价发送/.test(note)));
  assert.equal(h.binance.calls.place + h.bybit.calls.place, 0);
}));

test('对冲腿本地追价：首腿成交后对冲只挂单挂卖一，成交后完成，不发市价单', () => withHarness(async h => {
  const { jobId } = await previewAndConfirm(h, hedgeIntent());
  await tick(h);
  await tick(h);
  const hedge = lastOrder(h.binance);
  assert.deepEqual([hedge.request.type, hedge.request.timeInForce, hedge.status], ['limit', 'gtx', 'new']);
  assert.ok(same(hedge.request.limitPrice, '70.02'), `挂在卖一：${hedge.request.limitPrice}`);
  assert.equal(hedge.request.quantity, '1');
  h.binance.fillResting(hedge.request.clientOrderId, '1');
  const view = await settle(h, jobId);
  assert.equal(view.status, 'completed', view.reason ?? '');
  assert.equal(binanceShort(h), '1');
  assert.equal(ordersOf(h.binance).length, 1);
  assert.equal(view.legs[1].orderType, 'local-chase');
}));

test('对冲腿改价：挂满 2 秒后盘口变了撤单，按未成交部分在新卖一重挂；未满 2 秒不改', () => withHarness(async h => {
  const { jobId } = await previewAndConfirm(h, hedgeIntent({ chaseTimeoutMs: 60_000 }));
  await tick(h);
  await h.ex.tick();
  const first = lastOrder(h.binance);
  h.binance.fillResting(first.request.clientOrderId, '0.3');
  h.binance.setBook('CLUSDT', { bid: '69.95', ask: '69.97' });
  await h.ex.tick();
  assert.equal(first.status, 'partially-filled', '挂单未满 2 秒不改价');
  h.advance(2_000);
  await tick(h);
  await tick(h);
  assert.equal(first.status, 'canceled');
  const second = lastOrder(h.binance);
  assert.notEqual(second, first);
  assert.ok(same(second.request.limitPrice, '69.97'), `重挂在新卖一：${second.request.limitPrice}`);
  assert.equal(second.request.quantity, '0.7');
  assert.match(second.request.clientOrderId, /-1r1$/);
  h.binance.fillResting(second.request.clientOrderId, '0.7');
  const view = await settle(h, jobId);
  assert.equal(view.status, 'completed', view.reason ?? '');
  assert.equal(binanceShort(h), '1');
}));

test('对冲腿追价超时：撤掉挂单，剩余按市价补齐后完成', () => withHarness(async h => {
  const { jobId } = await previewAndConfirm(h, hedgeIntent({ chaseTimeoutMs: 3_000 }));
  await tick(h);
  await tick(h);
  const posted = lastOrder(h.binance);
  h.binance.fillResting(posted.request.clientOrderId, '0.4');
  const view = await settle(h, jobId);
  assert.equal(view.status, 'completed', view.reason ?? '');
  assert.equal(posted.status, 'canceled');
  const market = lastOrder(h.binance);
  assert.deepEqual([market.request.type, market.request.timeInForce, market.request.quantity], ['market', 'ioc', '0.6']);
  assert.equal(binanceShort(h), '1');
  const events = view.events.filter(event => event.type === 'cancel-sent').map(event => String(event.reason ?? ''));
  assert.ok(events.some(reason => /超过 3 秒，撤单后剩余按市价补齐/.test(reason)), events.join('\n'));
}));

test('对冲腿挂单连续 3 次被拒：改按市价补齐，不转人工', () => withHarness(async h => {
  const { jobId } = await previewAndConfirm(h, hedgeIntent({ chaseTimeoutMs: 60_000 }));
  await tick(h);
  h.binance.inject({ operation: 'place', mode: 'reject', times: 3 });
  const view = await settle(h, jobId);
  assert.equal(view.status, 'completed', view.reason ?? '');
  assert.equal(h.binance.calls.place, 4);
  assert.equal(lastOrder(h.binance).request.type, 'market');
  assert.equal(binanceShort(h), '1');
}));

test('对冲腿盘口读不到时不挂单、写明等待原因，追价时限到后按市价补齐', () => withHarness(async h => {
  const { jobId } = await previewAndConfirm(h, hedgeIntent({ chaseTimeoutMs: 3_000 }));
  await tick(h);
  h.binance.setBook('CLUSDT', { ageMs: 60_000 });
  await tick(h);
  assert.equal(ordersOf(h.binance).length, 0);
  assert.match(h.ex.jobView(jobId).reason ?? '', /对冲腿等待挂单/);
  const view = await settle(h, jobId);
  assert.equal(view.status, 'completed', view.reason ?? '');
  assert.deepEqual(ordersOf(h.binance).map(order => order.request.type), ['market']);
  assert.equal(binanceShort(h), '1');
}));

test('对冲腿挂单时请求停止：撤掉挂单，不再补发对冲，未对冲部分转人工', () => withHarness(async h => {
  const { jobId } = await previewAndConfirm(h, hedgeIntent({ chaseTimeoutMs: 60_000 }));
  await tick(h);
  await tick(h);
  const posted = lastOrder(h.binance);
  h.binance.fillResting(posted.request.clientOrderId, '0.2');
  h.ex.requestStop(jobId, randomUUID(), SESSION);
  const view = await settle(h, jobId);
  assert.equal(view.status, 'attention');
  assert.match(view.reason ?? '', /已请求停止，不再补发对冲腿/);
  assert.equal(posted.status, 'canceled');
  assert.equal(ordersOf(h.binance).length, 1);
  assert.equal(binanceShort(h), '0.2');
}));

test('对冲腿挂单时到截止时间：撤掉挂单，剩余立即按市价补齐', () => withHarness(async h => {
  const { jobId } = await previewAndConfirm(h, hedgeIntent({ timeoutMs: 30_000, chaseTimeoutMs: 600_000 }));
  await tick(h);
  await tick(h);
  const posted = lastOrder(h.binance);
  const view = await settle(h, jobId, { ticks: 60 });
  assert.equal(view.status, 'completed', view.reason ?? '');
  assert.equal(posted.status, 'canceled');
  assert.equal(lastOrder(h.binance).request.type, 'market');
  assert.equal(binanceShort(h), '1');
}));

test('对冲腿挂单时换进程：接管后撤掉挂单，剩余按市价补齐', () => withHarness(async h => {
  const { jobId } = await previewAndConfirm(h, hedgeIntent({ chaseTimeoutMs: 600_000 }));
  await tick(h);
  await tick(h);
  const posted = lastOrder(h.binance);
  h.binance.fillResting(posted.request.clientOrderId, '0.5');
  h.clock.now += 61_000; h.restart(); assert.equal(h.ex.acquire(), true);
  const view = await settle(h, jobId);
  assert.equal(view.status, 'completed', view.reason ?? '');
  assert.equal(posted.status, 'canceled');
  const market = lastOrder(h.binance);
  assert.deepEqual([market.request.type, market.request.quantity], ['market', '0.5']);
  assert.equal(binanceShort(h), '1');
}));

test('同所两腿都追价：首腿挂单成交后对冲挂单期间首腿不改价；首腿再成交时对冲改量重挂，补齐后首腿照常改价', () => withHarness(async h => {
  // Binance CL lead long by local chase, Binance BZ hedge short by local chase; 1 barrel each (BZ step 0.01, so a reserve of
  // about 1.2 × 5 USDT stays unhedged while the lead rests).
  const intent = {
    market: 'oil', preset: 'same-exchange', action: 'open', timeoutMs: 120_000,
    legs: [{ venue: 'binance', symbol: 'CLUSDT', side: 'long', orderType: 'local-chase', barrels: '1' }, { venue: 'binance', symbol: 'BZUSDT', side: 'short', orderType: 'local-chase', barrels: '1', chaseTimeoutMs: 60_000 }],
  };
  const { jobId } = await previewAndConfirm(h, intent);
  await tick(h);
  const lead = lastOrder(h.binance, 'CLUSDT');
  assert.equal(lead.request.timeInForce, 'gtx');
  h.binance.fillResting(lead.request.clientOrderId, '0.5');
  await tick(h);
  const hedge = lastOrder(h.binance, 'BZUSDT');
  assert.equal(hedge.request.timeInForce, 'gtx');
  assert.ok(same(hedge.request.limitPrice, '74.12'), `对冲挂卖一：${hedge.request.limitPrice}`);
  const firstHedge = hedge.request.quantity;
  assert.ok(cmp(firstHedge, '0.5') < 0 && cmp(firstHedge, '0.3') > 0, `留余量后对冲 ${firstHedge}`);
  // The lead's book moves while the hedge rests: the lead is not repriced.
  h.binance.setBook('CLUSDT', { bid: '70.05', ask: '70.07' });
  h.advance(3_000);
  await tick(h);
  assert.equal(ordersOf(h.binance, 'CLUSDT').length, 1, '对冲挂单期间首腿不改价');
  // More of the lead fills: the hedge, rested 2 seconds, is withdrawn and posted again for the larger gap.
  h.binance.fillResting(lead.request.clientOrderId, '0.3');
  await tick(h);
  await tick(h);
  assert.equal(hedge.status, 'canceled');
  const second = lastOrder(h.binance, 'BZUSDT');
  assert.notEqual(second, hedge);
  assert.ok(cmp(second.request.quantity, firstHedge) > 0, `改量重挂：${second.request.quantity}`);
  h.binance.fillResting(second.request.clientOrderId, second.request.quantity);
  await tick(h);
  await tick(h);
  // The hedge caught up (but for its reserve): the lead follows its book again.
  assert.equal(lead.status, 'canceled', '对冲补齐后首腿照常改价');
  const repost = lastOrder(h.binance, 'CLUSDT');
  assert.ok(same(repost.request.limitPrice, '70.05'));
  h.binance.fillResting(repost.request.clientOrderId, repost.request.quantity);
  for (let i = 0; i < 10 && h.ex.jobView(jobId).status === 'running'; i++) {
    await tick(h);
    const resting = ordersOf(h.binance, 'BZUSDT').find(order => order.status === 'new' || order.status === 'partially-filled');
    if (resting) h.binance.fillResting(resting.request.clientOrderId, resting.request.quantity);
  }
  const view = await settle(h, jobId);
  assert.equal(view.status, 'completed', view.reason ?? '');
  assert.equal(h.binance.position(SIM_ACCOUNTS.binance, 'CLUSDT', 'long'), '1');
  assert.equal(h.binance.position(SIM_ACCOUNTS.binance, 'BZUSDT', 'short'), '1');
}));

test('对冲腿市价补齐被拒：照原规则转人工；改价撤掉的挂单不计入对冲失败次数，市价补齐照常发出', () => withHarness(async h => {
  const { jobId } = await previewAndConfirm(h, hedgeIntent({ chaseTimeoutMs: 30_000 }));
  await tick(h);
  await tick(h);
  // Three reprices: more cancelled posts than hedgeAttempts (2) allows short market hedges.
  for (const [bid, ask] of [['69.90', '69.92'], ['69.80', '69.82'], ['69.70', '69.72']] as const) {
    h.binance.setBook('CLUSDT', { bid, ask });
    h.advance(2_000);
    await tick(h);
    await tick(h);
  }
  assert.ok(ordersOf(h.binance).filter(order => order.status === 'canceled').length >= 2, '至少两笔挂单被改价撤销');
  // The chase times out; its market fallback is still sent, and its refusal ends hedging as before.
  h.binance.inject({ operation: 'place', mode: 'reject', times: 1, clientOrderId: undefined });
  const placed = h.binance.calls.place;
  assert.equal(h.ex.jobView(jobId).status, 'running');
  h.advance(30_000);
  const view = await settle(h, jobId);
  assert.equal(h.binance.calls.place, placed + 1, '市价补齐发出一次');
  assert.equal(view.status, 'attention');
  assert.match(view.reason ?? '', /对冲腿被交易所拒绝/);
}, { hedgeAttempts: 2 }));

test('对冲挂单撤销后账户快照仍列着它：视为本任务的委托，照常按市价补齐（L054）', () => withHarness(async h => {
  const { jobId } = await previewAndConfirm(h, hedgeIntent({ chaseTimeoutMs: 3_000 }));
  await tick(h);
  await tick(h);
  const posted = lastOrder(h.binance);
  h.binance.fillResting(posted.request.clientOrderId, '0.4');
  const read = h.binance.account.bind(h.binance);
  h.binance.account = async (...args: Parameters<typeof read>) => {
    const snapshot = await read(...args);
    // The venue still lists the post after it was cancelled.
    return posted.status === 'canceled' ? { ...snapshot, openOrders: [...snapshot.openOrders, { symbol: 'CLUSDT', clientOrderId: posted.request.clientOrderId, remoteId: posted.remoteId }] } : snapshot;
  };
  const view = await settle(h, jobId);
  assert.equal(view.status, 'completed', view.reason ?? '');
  assert.deepEqual([lastOrder(h.binance).request.type, lastOrder(h.binance).request.quantity], ['market', '0.6']);
  assert.equal(binanceShort(h), '1');
}));

test('对冲挂单撤单一直未确认：撤单次数用完即转人工，不等到截止', () => withHarness(async h => {
  const { jobId } = await previewAndConfirm(h, hedgeIntent({ chaseTimeoutMs: 2_000, timeoutMs: 600_000 }));
  await tick(h);
  await tick(h);
  const posted = lastOrder(h.binance);
  h.binance.inject({ operation: 'cancel', mode: 'reject', times: 100 });
  h.advance(2_000);
  for (let i = 0; i < 12 && h.ex.jobView(jobId).status !== 'attention'; i++) await tick(h, 10_000);
  const view = h.ex.jobView(jobId);
  assert.equal(view.status, 'attention', view.reason ?? '');
  assert.match(view.reason ?? '', /对冲腿追价挂单撤单 \d+ 次仍未确认/);
  assert.equal(posted.status, 'new', '挂单仍在，交人工核对');
  assert.equal(ordersOf(h.binance).length, 1, '没有发市价补齐');
}));

test('对冲委托数接近任务上限时不再挂单，剩下的名额用于市价补齐', () => withHarness(async h => {
  const { jobId } = await previewAndConfirm(h, hedgeIntent({ chaseTimeoutMs: 600_000 }));
  await tick(h);
  await tick(h);
  for (let i = 0; i < 10 && lastOrder(h.binance).request.type !== 'market'; i++) {
    h.binance.setBook('CLUSDT', { bid: `69.${90 - i * 5}`, ask: `69.${92 - i * 5}` });
    h.advance(2_000);
    await tick(h);
    await tick(h);
  }
  const view = await settle(h, jobId);
  assert.equal(view.status, 'completed', view.reason ?? '');
  const orders = ordersOf(h.binance);
  assert.equal(orders.filter(order => order.request.timeInForce === 'gtx').length, 4, '上限 6 减市价名额 2');
  assert.equal(orders.at(-1)!.request.type, 'market');
  assert.equal(binanceShort(h), '1');
}, { chaseOrderLimit: 6, hedgeAttempts: 2 }));

test('开仓对冲挂单部分成交后剩余低于最小名义金额：不再改价撤单，到追价时限后撤单转人工', () => withHarness(async h => {
  const { jobId } = await previewAndConfirm(h, hedgeIntent({ chaseTimeoutMs: 6_000 }));
  await tick(h);
  await tick(h);
  const posted = lastOrder(h.binance);
  h.binance.fillResting(posted.request.clientOrderId, '0.95');
  h.binance.setBook('CLUSDT', { bid: '69.90', ask: '69.92' });
  h.advance(2_000);
  await tick(h);
  await tick(h);
  assert.equal(posted.status, 'partially-filled', '剩余 0.05（约 3.5 USDT）重挂会被拒，留在原价');
  // It may still fill where it rests.
  h.advance(4_000);
  const view = await settle(h, jobId);
  assert.equal(posted.status, 'canceled');
  assert.equal(view.status, 'attention');
  assert.match(view.reason ?? '', /低于Binance最小名义金额/);
  assert.equal(ordersOf(h.binance).length, 1);
}));
