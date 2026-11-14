// Oil O3: Binance local chase (post-only orders the executor moves to the best same-side price) and batched leads.
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { ContractError, parseIntent } from '../src/contracts.ts';
import { cmp } from '../src/decimal.ts';
import { splitBarrels } from '../src/barrels.ts';
import { SIM_ACCOUNTS } from '../src/simulation.ts';
import type { SimulatedVenue } from '../src/sim-venue.ts';
import { SESSION, bindAccounts, createHarness, openIntent, previewAndConfirm, settle, type Harness } from './harness.ts';

const code = (expected: string) => (error: unknown) => error instanceof ContractError && error.code === expected;
type Batches = { count: number; intervalMs: number };
/** Binance lead (local chase by default), Bybit market hedge on CLUSDT. */
const leadIntent = ({ side = 'long', quantity = '1', orderType = 'local-chase', limitPrice, batches, timeoutMs = 60_000 }: { side?: 'long' | 'short'; quantity?: string; orderType?: string; limitPrice?: string; batches?: Batches; timeoutMs?: number } = {}) => ({
  market: 'oil', preset: 'cross-exchange', symbol: 'CLUSDT', action: 'open', timeoutMs,
  legs: [
    { venue: 'binance', side, quantity, orderType, ...(limitPrice ? { limitPrice } : {}) },
    { venue: 'bybit', side: side === 'long' ? 'short' : 'long', quantity, orderType: 'market' },
  ],
  ...(batches ? { batches } : {}),
});
const ordersOf = (venue: SimulatedVenue) => [...venue.orders.values()].filter(order => order.request.symbol === 'CLUSDT');
const lastOrder = (venue: SimulatedVenue) => ordersOf(venue).at(-1)!;
const same = (a: string | null | undefined, b: string) => a != null && cmp(a, b) === 0;
async function withHarness(run: (h: Harness) => Promise<void>, options: Parameters<typeof createHarness>[0] = {}) {
  const h = createHarness(options);
  try { bindAccounts(h.ex); await run(h); } finally { h.dispose(); }
}
async function tick(h: Harness, ms = 1_000) { await h.ex.tick(); h.advance(ms); }

test('意图：本地追价只用于 Binance 首腿、可带追价界限；分批只用于首腿市价或本地追价，总间隔须短于最长执行时间', () => {
  const parsed = parseIntent(leadIntent({ limitPrice: '70.10', batches: { count: 3, intervalMs: 5_000 } }));
  assert.equal(parsed.legs[0].orderType, 'local-chase');
  assert.equal(parsed.legs[0].limitPrice, '70.1');
  assert.deepEqual(parsed.batches, { count: 3, intervalMs: 5_000 });
  assert.equal(parseIntent(leadIntent({ batches: { count: 1, intervalMs: 0 } })).batches, undefined, '一批等于不分批');
  assert.equal(parseIntent(leadIntent()).legs[0].limitPrice, null, '不填界限时用预览的价格保护界限');
  const base = leadIntent();
  assert.throws(() => parseIntent({ ...base, legs: [base.legs[0], { ...base.legs[1], orderType: 'local-chase' }] }), code('chase_unsupported'));
  assert.throws(() => parseIntent({ ...base, legs: [{ ...base.legs[0], venue: 'bybit' }, { ...base.legs[1], venue: 'binance' }] }), code('chase_unsupported'));
  assert.throws(() => parseIntent(leadIntent({ orderType: 'limit', limitPrice: '70', batches: { count: 2, intervalMs: 0 } })), code('batch_unsupported'));
  assert.throws(() => parseIntent(leadIntent({ batches: { count: 3, intervalMs: 30_000 } })), code('batch_timeout'));
  assert.throws(() => parseIntent(leadIntent({ batches: { count: 21, intervalMs: 0 } })), code('invalid_value'));
  assert.throws(() => parseIntent(leadIntent({ batches: { count: 2, intervalMs: 0, extra: 1 } as never })), code('unknown_field'));
});

test('分批：按两腿共同桶数步长均分，余数给前几批；格数少于批数时拒绝', () => {
  const cl = (step: string) => ({ symbol: 'CLUSDT', contractSize: '1', quantityStep: step, minQuantity: step, priceTick: '0.01', minNotional: '5' }) as never;
  assert.deepEqual(splitBarrels('1', 3, [cl('0.01'), cl('0.1')]), ['0.4', '0.3', '0.3']);
  assert.deepEqual(splitBarrels('0.06', 3, [cl('0.01'), cl('0.02')]), ['0.02', '0.02', '0.02']);
  assert.equal(splitBarrels('0.2', 3, [cl('0.01'), cl('0.1')]), null);
});

test('预览：本地追价需要 Binance 支持只挂单；卖出追价有挂单上限并计入名义金额；自填界限不能超出保护界限；分批每批须达最小数量', () => withHarness(async h => {
  const buy = await h.ex.preview(leadIntent(), SESSION);
  assert.equal(buy.legs[0].orderType, 'local-chase');
  assert.ok(buy.notes.some(note => /首腿本地追价/.test(note)));
  await assert.rejects(h.ex.preview(leadIntent({ limitPrice: '80' }), SESSION), code('limit_beyond_bound'));
  const sell = await h.ex.preview(leadIntent({ side: 'short' }), SESSION);
  const ceiling = sell.legs[0].chaseCeiling as string;
  assert.ok(cmp(ceiling, '70.02') > 0 && cmp(ceiling, '70.40') < 0, `卖出上限取卖一加保护基点：${ceiling}`);
  await assert.rejects(h.ex.preview(leadIntent({ side: 'short', limitPrice: '80' }), SESSION), code('limit_beyond_bound'));
  const batched = await h.ex.preview(leadIntent({ batches: { count: 3, intervalMs: 1_000 } }), SESSION);
  assert.deepEqual(batched.batches, ['0.4', '0.3', '0.3']);
  await assert.rejects(h.ex.preview(leadIntent({ quantity: '0.2', batches: { count: 3, intervalMs: 0 } }), SESSION), code('batch_size'));
  assert.equal(h.binance.calls.place + h.bybit.calls.place, 0);
}));

test('名义金额上限：卖出本地追价按挂单上限计入，所以可以使用（原生追价卖出仍拒绝）', async () => {
  await withHarness(async h => {
    const preview = await h.ex.preview(leadIntent({ side: 'short' }), SESSION);
    assert.equal(preview.legs[0].orderType, 'local-chase');
  }, { notionalLimits: { perJob: '1000', totalOpen: '5000' } });
  await withHarness(async h => {
    // 1 CL at the ask is 70.02 USDT, but the ceiling above it is what counts.
    await assert.rejects(h.ex.preview(leadIntent({ side: 'short' }), SESSION), code('notional_job_cap'));
  }, { notionalLimits: { perJob: '70.10', totalOpen: '5000' } });
});

test('本地追价买入：只挂单挂买一，挂单期间的成交先对冲，挂满 2 秒后盘口变了撤单重挂，全部成交后完成', () => withHarness(async h => {
  const { jobId } = await previewAndConfirm(h, leadIntent());
  await tick(h);
  const first = lastOrder(h.binance);
  assert.deepEqual([first.request.type, first.request.timeInForce, first.status], ['limit', 'gtx', 'new']);
  assert.ok(same(first.request.limitPrice, '70.00'), `挂在买一：${first.request.limitPrice}`);
  h.binance.fillResting(first.request.clientOrderId, '0.5');
  await tick(h);
  // Bybit's minimum quantity (0.1, about 7 USDT) is over the minimum notional with headroom, so no reserve is held.
  assert.equal(h.bybit.position(SIM_ACCOUNTS.bybit, 'CLUSDT', 'short'), '0.5', '挂单仍在时已对冲成交部分');
  assert.equal(lastOrder(h.binance), first, '对冲期间不改价');
  // The book moves; the order has rested 2 seconds by the next pass, so it is cancelled and posted again at the new bid.
  h.binance.setBook('CLUSDT', { bid: '70.05', ask: '70.07' });
  await tick(h);
  await tick(h);
  assert.equal(first.status, 'canceled');
  const second = lastOrder(h.binance);
  assert.notEqual(second, first);
  assert.ok(same(second.request.limitPrice, '70.05'));
  assert.equal(second.request.quantity, '0.5', '只挂未成交的部分');
  assert.match(second.request.clientOrderId, /-0r1$/);
  h.binance.fillResting(second.request.clientOrderId, '0.5');
  const view = await settle(h, jobId);
  assert.equal(view.status, 'completed', view.reason ?? '');
  assert.equal(view.reason, null);
  assert.equal(h.binance.position(SIM_ACCOUNTS.binance, 'CLUSDT', 'long'), '1');
  assert.equal(h.bybit.position(SIM_ACCOUNTS.bybit, 'CLUSDT', 'short'), '1');
}));

test('本地追价界限：买入最高挂到自填界限，盘口再涨也不追；未满 2 秒不改价', () => withHarness(async h => {
  const { jobId } = await previewAndConfirm(h, leadIntent({ limitPrice: '70.03' }));
  await tick(h);
  h.binance.setBook('CLUSDT', { bid: '70.20', ask: '70.22' });
  await h.ex.tick();
  assert.equal(ordersOf(h.binance).length, 1, '挂单未满 2 秒');
  h.advance(2_000);
  await tick(h);
  await tick(h);
  const posted = lastOrder(h.binance);
  assert.equal(ordersOf(h.binance).length, 2);
  assert.ok(same(posted.request.limitPrice, '70.03'), `停在界限：${posted.request.limitPrice}`);
  // At the bound already: no further cancel while the book stays above it.
  h.advance(5_000);
  await tick(h);
  assert.equal(ordersOf(h.binance).length, 2);
  h.binance.fillResting(posted.request.clientOrderId, '1');
  assert.equal((await settle(h, jobId)).status, 'completed');
}));

test('本地追价连续 3 次挂单失败即停止追价，未成交时任务失败且不发对冲腿', () => withHarness(async h => {
  h.binance.inject({ operation: 'place', mode: 'reject', times: 3 });
  const { jobId } = await previewAndConfirm(h, leadIntent());
  const view = await settle(h, jobId);
  assert.equal(view.status, 'failed');
  assert.match(view.reason ?? '', /首腿未成交（首腿连续 3 次挂单未成功/);
  assert.equal(h.binance.calls.place, 3);
  assert.equal(h.bybit.calls.place, 0);
}));

test('本地追价截止：撤掉挂单，已成交部分对冲后以完成结束，并写明成交与计划桶数', () => withHarness(async h => {
  const { jobId } = await previewAndConfirm(h, leadIntent({ timeoutMs: 30_000 }));
  await tick(h);
  h.binance.fillResting(lastOrder(h.binance).request.clientOrderId, '0.3');
  const view = await settle(h, jobId, { ticks: 60 });
  assert.equal(view.status, 'completed', view.reason ?? '');
  assert.match(view.reason ?? '', /两腿各成交 0\.3 桶，计划 1 桶/);
  assert.equal(lastOrder(h.binance).status, 'canceled');
  assert.equal(h.bybit.position(SIM_ACCOUNTS.bybit, 'CLUSDT', 'short'), '0.3');
}));

test('卖出本地追价挂卖一；盘口涨过挂单上限时不追，原挂单保留', () => withHarness(async h => {
  const { preview, jobId } = await previewAndConfirm(h, leadIntent({ side: 'short' }));
  await tick(h);
  const first = lastOrder(h.binance);
  assert.deepEqual([first.request.side, first.request.timeInForce], ['sell', 'gtx']);
  assert.ok(same(first.request.limitPrice, '70.02'));
  h.binance.setBook('CLUSDT', { bid: '71.00', ask: '71.02' });
  h.advance(2_000);
  await tick(h);
  assert.equal(ordersOf(h.binance).length, 1, `新价越过上限 ${preview.legs[0].chaseCeiling} 时不撤不挂`);
  assert.equal(first.status, 'new');
  h.binance.setBook('CLUSDT', { bid: '70.10', ask: '70.12' });
  await tick(h);
  await tick(h);
  const second = lastOrder(h.binance);
  assert.ok(same(second.request.limitPrice, '70.12'));
  h.binance.fillResting(second.request.clientOrderId, '1');
  assert.equal((await settle(h, jobId)).status, 'completed');
  assert.equal(h.bybit.position(SIM_ACCOUNTS.bybit, 'CLUSDT', 'long'), '1');
}));

test('市价分批：每批对冲后等满间隔再发下一批，任务显示当前批次', () => withHarness(async h => {
  const intent = { ...openIntent(), batches: { count: 3, intervalMs: 5_000 } };
  const { preview, jobId } = await previewAndConfirm(h, intent);
  assert.deepEqual(preview.batches, ['0.4', '0.3', '0.3']);
  const sends: number[] = [];
  let seen = 0;
  for (let i = 0; i < 40; i++) {
    await h.ex.tick();
    if (h.binance.calls.place > seen) { seen = h.binance.calls.place; sends.push(h.clock.now); }
    const view = h.ex.jobView(jobId);
    if (view.status !== 'running') break;
    h.advance(1_000);
  }
  const view = h.ex.jobView(jobId);
  assert.equal(view.status, 'completed', view.reason ?? '');
  assert.deepEqual(ordersOf(h.binance).map(order => order.request.quantity), ['0.4', '0.3', '0.3']);
  assert.deepEqual(ordersOf(h.bybit).map(order => order.request.quantity), ['0.4', '0.3', '0.3']);
  assert.equal(sends.length, 3);
  for (let i = 1; i < sends.length; i++) assert.ok(sends[i]! - sends[i - 1]! >= 5_000, `批次间隔 ${sends[i]! - sends[i - 1]!}`);
  assert.deepEqual(view.batches, { count: 3, current: 3, intervalMs: 5_000 });
}));

test('本地追价分批：一批挂满成交、对冲跟上后才挂下一批', () => withHarness(async h => {
  const { jobId } = await previewAndConfirm(h, leadIntent({ batches: { count: 2, intervalMs: 0 } }));
  await tick(h);
  const first = lastOrder(h.binance);
  assert.equal(first.request.quantity, '0.5');
  assert.equal(h.ex.jobView(jobId).batches?.current, 1);
  h.binance.fillResting(first.request.clientOrderId, '0.5');
  await tick(h);
  assert.equal(h.bybit.position(SIM_ACCOUNTS.bybit, 'CLUSDT', 'short'), '0.5');
  await tick(h);
  const second = lastOrder(h.binance);
  assert.notEqual(second, first);
  assert.equal(second.request.quantity, '0.5');
  assert.equal(h.ex.jobView(jobId).batches?.current, 2);
  h.binance.fillResting(second.request.clientOrderId, '0.5');
  const view = await settle(h, jobId);
  assert.equal(view.status, 'completed', view.reason ?? '');
  assert.equal(h.bybit.position(SIM_ACCOUNTS.bybit, 'CLUSDT', 'short'), '1');
}));

test('后续批次发送前检查不过时等待并写明原因，恢复后继续，不判失败', () => withHarness(async h => {
  const { jobId } = await previewAndConfirm(h, { ...openIntent(), batches: { count: 2, intervalMs: 0 } });
  await tick(h);
  await tick(h);
  assert.equal(h.bybit.position(SIM_ACCOUNTS.bybit, 'CLUSDT', 'short'), '0.5');
  h.binance.setBook('CLUSDT', { ageMs: 120_000 });
  await tick(h);
  await tick(h);
  let view = h.ex.jobView(jobId);
  assert.equal(view.status, 'running');
  assert.match(view.reason ?? '', /^首腿等待发送：/);
  assert.equal(h.binance.calls.place, 1);
  h.binance.setBook('CLUSDT', { ageMs: 0 });
  view = await settle(h, jobId);
  assert.equal(view.status, 'completed', view.reason ?? '');
  assert.equal(view.reason, null);
  assert.equal(h.binance.position(SIM_ACCOUNTS.binance, 'CLUSDT', 'long'), '1');
}));

test('本地追价中途换进程：撤掉挂单不再新挂，已成交部分对冲后完成', () => withHarness(async h => {
  const { jobId } = await previewAndConfirm(h, leadIntent());
  await tick(h);
  const first = lastOrder(h.binance);
  h.binance.fillResting(first.request.clientOrderId, '0.4');
  h.clock.now += 61_000; h.restart(); assert.equal(h.ex.acquire(), true);
  const view = await settle(h, jobId);
  assert.equal(view.status, 'completed', view.reason ?? '');
  assert.equal(first.status, 'canceled');
  assert.equal(ordersOf(h.binance).length, 1, '恢复后首腿不再新挂');
  assert.equal(h.bybit.position(SIM_ACCOUNTS.bybit, 'CLUSDT', 'short'), '0.4');
}));

test('本地追价停止：撤掉挂单，停止后不再补发对冲腿，未对冲的成交转人工处理', () => withHarness(async h => {
  const { jobId } = await previewAndConfirm(h, leadIntent());
  await tick(h);
  const first = lastOrder(h.binance);
  h.binance.fillResting(first.request.clientOrderId, '0.2');
  await tick(h);
  assert.equal(h.bybit.position(SIM_ACCOUNTS.bybit, 'CLUSDT', 'short'), '0.2');
  h.binance.fillResting(first.request.clientOrderId, '0.3');
  h.ex.requestStop(jobId, randomUUID(), SESSION);
  const view = await settle(h, jobId);
  assert.equal(view.status, 'attention');
  assert.match(view.reason ?? '', /已请求停止，不再补发对冲腿/);
  assert.equal(first.status, 'canceled');
  assert.equal(h.bybit.position(SIM_ACCOUNTS.bybit, 'CLUSDT', 'short'), '0.2');
}));

/** Same venue, both Binance (step 0.01): CL lead by local chase, BZ hedge. */
const sameChase = (barrels: string) => ({
  market: 'oil', preset: 'same-exchange', action: 'open', timeoutMs: 60_000,
  legs: [{ venue: 'binance', symbol: 'CLUSDT', side: 'long', orderType: 'local-chase', barrels }, { venue: 'binance', symbol: 'BZUSDT', side: 'short', orderType: 'market', barrels }],
});

test('首腿挂单期间对冲腿被拒：先撤首腿挂单再转人工，不让后续成交无人对冲', () => withHarness(async h => {
  const { jobId } = await previewAndConfirm(h, leadIntent({ quantity: '2' }));
  await tick(h);
  const lead = lastOrder(h.binance);
  h.bybit.inject({ operation: 'place', mode: 'reject' });
  h.binance.fillResting(lead.request.clientOrderId, '0.5');
  const view = await settle(h, jobId);
  assert.equal(view.status, 'attention');
  assert.match(view.reason ?? '', /对冲腿被交易所拒绝/);
  assert.equal(lead.status, 'canceled', '首腿挂单已撤');
  assert.equal(ordersOf(h.binance).length, 1);
}));

test('首腿挂单期间对冲腿结果超过观察窗仍未知：先撤首腿挂单，撤完再转人工', () => withHarness(async h => {
  const { jobId } = await previewAndConfirm(h, leadIntent({ quantity: '2', timeoutMs: 600_000 }));
  await tick(h);
  const lead = lastOrder(h.binance);
  const hedgeId = lead.request.clientOrderId.replace(/-0$/, '-1');
  h.bybit.inject({ operation: 'place', mode: 'lost-response', clientOrderId: hedgeId });
  h.bybit.inject({ operation: 'query', mode: 'read-fail', times: 1_000, clientOrderId: hedgeId });
  h.binance.fillResting(lead.request.clientOrderId, '0.5');
  const view = await settle(h, jobId, { ticks: 80, stepMs: 5_000 });
  assert.equal(view.status, 'attention', JSON.stringify([view.reason, view.legs.map(leg => leg.operation), lead.status]));
  assert.match(view.reason ?? '', /超过观察窗仍无法确认/);
  assert.equal(lead.status, 'canceled', '首腿挂单在转人工前已撤');
}));

test('首腿挂单期间对冲腿未全部成交达上限：先撤首腿挂单再转人工', () => withHarness(async h => {
  const { jobId } = await previewAndConfirm(h, leadIntent({ quantity: '2' }));
  await tick(h);
  const lead = lastOrder(h.binance);
  h.bybit.inject({ operation: 'place', mode: 'partial', filled: '0', times: 5 });
  h.binance.fillResting(lead.request.clientOrderId, '0.5');
  const view = await settle(h, jobId, { ticks: 40 });
  assert.equal(view.status, 'attention');
  assert.match(view.reason ?? '', /对冲腿已有 5 笔未全部成交/);
  assert.equal(lead.status, 'canceled');
}));

test('首腿挂单期间的零碎成交低于对冲腿最小名义金额时先攒着，够了再对冲；首腿剩余不足最小名义时结束该批', () => withHarness(async h => {
  const { jobId } = await previewAndConfirm(h, sameChase('1'));
  await tick(h);
  const lead = lastOrder(h.binance);
  assert.equal(lead.request.symbol, 'CLUSDT');
  h.binance.fillResting(lead.request.clientOrderId, '0.05');
  await tick(h);
  assert.equal(h.binance.calls.place, 1, '约 3.7 USDT 不发对冲');
  h.binance.fillResting(lead.request.clientOrderId, '0.9');
  await tick(h);
  // BZ steps 0.01: 0.09 at the 74.10 preview bid (about 6.7 USDT) stays unhedged while the lead rests.
  assert.equal(h.binance.position(SIM_ACCOUNTS.binance, 'BZUSDT', 'short'), '0.86', '留下最小名义 1.2 倍的余量');
  // 0.05 left (about 3.5 USDT): once the order moves, the batch ends instead of posting an order the venue would refuse.
  h.binance.setBook('CLUSDT', { bid: '70.01', ask: '70.03' });
  h.advance(2_000);
  const view = await settle(h, jobId);
  assert.equal(view.status, 'completed', view.reason ?? '');
  assert.match(view.reason ?? '', /两腿各成交 0\.95 桶，计划 1 桶/);
  assert.equal(ordersOf(h.binance).length, 1, '剩余不足最小名义金额不再重挂');
  assert.equal(h.binance.position(SIM_ACCOUNTS.binance, 'BZUSDT', 'short'), '0.95', '首腿结束后余量一并对冲');
}));

test('改价重挂的空档里，攒着的小额成交不拿去对冲，随首腿后续成交一起对冲', () => withHarness(async h => {
  const { jobId } = await previewAndConfirm(h, sameChase('1'));
  await tick(h);
  const first = lastOrder(h.binance);
  h.binance.fillResting(first.request.clientOrderId, '0.05');
  h.binance.setBook('CLUSDT', { bid: '70.01', ask: '70.03' });
  h.advance(2_000);
  await tick(h);
  await tick(h);
  assert.equal(first.status, 'canceled');
  const second = lastOrder(h.binance);
  assert.notEqual(second, first);
  assert.equal(second.request.quantity, '0.95');
  assert.equal(h.binance.calls.place, 2, '空档里没有发对冲单');
  h.binance.fillResting(second.request.clientOrderId, '0.95');
  const view = await settle(h, jobId);
  assert.equal(view.status, 'completed', view.reason ?? '');
  assert.equal(h.binance.position(SIM_ACCOUNTS.binance, 'BZUSDT', 'short'), '1');
}));

test('首腿结束时未对冲量低于最小名义金额：不发必被拒的对冲单，写明原因转人工', () => withHarness(async h => {
  const { jobId } = await previewAndConfirm(h, { ...sameChase('1'), timeoutMs: 30_000 });
  await tick(h);
  const lead = lastOrder(h.binance);
  h.binance.fillResting(lead.request.clientOrderId, '0.05');
  const view = await settle(h, jobId, { ticks: 60 });
  assert.equal(view.status, 'attention');
  assert.match(view.reason ?? '', /首腿结束后未对冲 0\.05.*低于Binance最小名义金额 5.*只减仓/);
  assert.equal(lead.status, 'canceled');
  assert.equal(h.binance.calls.place, 1, '没有发对冲单');
}));

test('限价首腿挂单期间的小额成交同样留余量，不发会被拒的对冲单', () => withHarness(async h => {
  const intent = sameChase('1');
  const { jobId } = await previewAndConfirm(h, { ...intent, legs: [{ ...intent.legs[0], orderType: 'limit', limitPrice: '69.00' }, intent.legs[1]] });
  await tick(h);
  const lead = lastOrder(h.binance);
  assert.equal(lead.status, 'new');
  h.binance.fillResting(lead.request.clientOrderId, '0.05');
  await tick(h);
  assert.equal(h.binance.calls.place, 1, '约 3.7 USDT 不发对冲');
  h.binance.fillResting(lead.request.clientOrderId, '0.95');
  const view = await settle(h, jobId);
  assert.equal(view.status, 'completed', view.reason ?? '');
  assert.equal(h.binance.position(SIM_ACCOUNTS.binance, 'BZUSDT', 'short'), '1');
}));

test('留余量时请求停止：撤掉挂单，余量不再补发对冲，写明未对冲桶数转人工', () => withHarness(async h => {
  const { preview, jobId } = await previewAndConfirm(h, sameChase('1'));
  assert.ok(preview.notes.some(note => /首腿挂单期间留约 6 USDT 的成交不对冲.*请求停止，这部分转人工/.test(note)), '预览提示余量');
  await tick(h);
  const lead = lastOrder(h.binance);
  h.binance.fillResting(lead.request.clientOrderId, '0.5');
  await tick(h);
  assert.equal(h.binance.position(SIM_ACCOUNTS.binance, 'BZUSDT', 'short'), '0.41');
  h.ex.requestStop(jobId, randomUUID(), SESSION);
  const view = await settle(h, jobId);
  assert.equal(view.status, 'attention');
  assert.match(view.reason ?? '', /已请求停止，不再补发对冲腿.*未对冲 0\.09 桶/);
  assert.equal(lead.status, 'canceled');
}));

test('预览放行的小额任务（名义在最小值 1–1.2 倍之间）零成交改价后照常重挂，不提前结束', () => withHarness(async h => {
  const { jobId } = await previewAndConfirm(h, sameChase('0.08'));
  await tick(h);
  const first = lastOrder(h.binance);
  h.binance.setBook('CLUSDT', { bid: '70.01', ask: '70.03' });
  h.advance(2_000);
  await tick(h);
  await tick(h);
  assert.equal(first.status, 'canceled');
  const second = lastOrder(h.binance);
  assert.notEqual(second, first);
  assert.equal(second.request.quantity, '0.08');
  h.binance.fillResting(second.request.clientOrderId, '0.08');
  const view = await settle(h, jobId);
  assert.equal(view.status, 'completed', view.reason ?? '');
}));

test('首腿挂单期间对冲腿委托达到上限：先撤首腿挂单再转人工', () => withHarness(async h => {
  const { jobId } = await previewAndConfirm(h, leadIntent({ quantity: '2' }));
  await tick(h);
  const lead = lastOrder(h.binance);
  for (let i = 0; i < 3; i++) { h.binance.fillResting(lead.request.clientOrderId, '0.3'); await tick(h); }
  assert.equal(ordersOf(h.bybit).length, 3);
  h.binance.fillResting(lead.request.clientOrderId, '0.3');
  const view = await settle(h, jobId);
  assert.equal(view.status, 'attention');
  assert.match(view.reason ?? '', /对冲腿已有 3 笔委托/);
  assert.equal(lead.status, 'canceled', '首腿挂单在转人工前已撤');
}, { budgets: { chaseOrderLimit: 3 } }));

test('预算：首腿与对冲腿委托序号最多三位，追价参数在启动时校验', () => {
  for (const budgets of [{ chaseOrderLimit: 1_000 }, { chaseOrderLimit: 0 }, { chaseFailureLimit: 0 }, { chaseRepriceMs: 100 }]) {
    assert.throws(() => createHarness({ budgets }), code('budget'), JSON.stringify(budgets));
  }
});
