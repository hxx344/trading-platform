// O6 four legs (docs/oil.md 11): one preview of two same-exchange plans, one confirm that creates both jobs and their four
// locks or nothing, the stop of either job stopping both, and the other job's linked halt when one ends without completing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ContractError, parseFourLegIntent } from '../src/contracts.ts';
import { SIM_ACCOUNTS, SIM_BINDINGS } from '../src/simulation.ts';
import type { SimulatedVenue } from '../src/sim-venue.ts';
import { describeEvent, describeJob, type JobSummary } from '../src/service/feishu.ts';
import { SESSION, bindAccounts, createHarness, openIntent, previewAndConfirm, type Harness } from './harness.ts';
import { fillGaps, fillGapText, type FillLeg } from '../src/four-leg-fill.ts';
import { DEFAULT_FORM, describeFourLeg, fourLegFormToIntent, type OilForm } from '../web/src/oil-form.ts';
import { DEFAULT_HYNIX_FORM, describeHynixFourLeg, hynixFourLegFormToIntent } from '../web/src/hynix-form.ts';
import { groupJobs, groupStatus } from '../web/src/four-leg.ts';
import type { OilJob } from '../web/src/oil-types.ts';

const code = (expected: string) => (error: unknown) => error instanceof ContractError && error.code === expected;
type Side = 'long' | 'short';
const leg = (venue: string, symbol: string, side: Side, size: Record<string, string>, orderType = 'market') => ({ venue, symbol, side, orderType, ...size });
/** Binance short BZ / long CL, Bybit long BZ / short CL (the BZ leg first on each venue). */
const fourIntent = ({ barrels = '1', action = 'open', bzSide = 'short' as Side, binanceLead = 'market', timeoutMs = 60_000 }: { barrels?: string; action?: 'open' | 'close'; bzSide?: Side; binanceLead?: string; timeoutMs?: number } = {}) => {
  const flip = (side: Side): Side => side === 'long' ? 'short' : 'long';
  return {
    market: 'oil', preset: 'four-leg', action, timeoutMs,
    legs: [
      leg('binance', 'BZUSDT', bzSide, { barrels }, binanceLead), leg('binance', 'CLUSDT', flip(bzSide), { barrels }),
      leg('bybit', 'BZUSDT', flip(bzSide), { barrels }), leg('bybit', 'CLUSDT', bzSide, { barrels }),
    ],
  };
};
const hynixIntent = (notional = '100') => ({
  market: 'hynix', preset: 'four-leg', action: 'open', timeoutMs: 60_000,
  legs: [leg('binance', 'SKHYUSDT', 'long', { notional }), leg('binance', 'SKHYNIXUSDT', 'short', { notional }), leg('bybit', 'SKHYUSDT', 'short', { notional }), leg('bybit', 'SKHYNIXUSDT', 'long', { notional })],
});
async function withHarness(run: (h: Harness) => Promise<void>, options: Parameters<typeof createHarness>[0] = {}) {
  const h = createHarness(options);
  bindAccounts(h.ex);
  try { await run(h); } finally { h.dispose(); }
}
const tick = async (h: Harness, ms = 1_000) => { await h.ex.tick(); h.advance(ms); };
async function settleAll(h: Harness, ids: string[], ticks = 30) {
  for (let i = 0; i < ticks && !ids.every(id => ['completed', 'failed', 'stopped', 'attention'].includes(h.ex.jobView(id).status)); i++) await tick(h);
  return ids.map(id => h.ex.jobView(id));
}
async function confirmFour(h: Harness, intent: unknown = fourIntent()) {
  const preview = await h.ex.previewFourLeg(intent, SESSION);
  const requestId = randomUUID();
  const result = h.ex.confirmFourLeg({ previewId: preview.id, requestId, confirmLive: true }, SESSION);
  return { preview, requestId, result, ids: result.jobs.map(job => job.id) };
}

test('四腿首次发送在签名中丢失行情依据时，另一所不能把明确未发送当作已受理', () => withHarness(async h => {
  await confirmFour(h);
  let delayed = false;
  for (const venue of [h.binance, h.bybit]) {
    const place = venue.place.bind(venue);
    venue.place = (...args) => {
      if (!delayed) { delayed = true; h.advance(h.ex.budgets.sendQuoteMaxAgeMs + 1); }
      return place(...args);
    };
  }
  await h.ex.tickJobs();
  assert.equal(delayed, true);
  assert.deepEqual([h.binance.arrived.place, h.bybit.arrived.place], [0, 0]);
}));

test('本地追价首笔明确未发后，同批重挂仍须取得另一所的两个有效盘口', () => withHarness(async h => {
  await confirmFour(h, fourIntent({ binanceLead: 'local-chase' }));
  const place = h.binance.place.bind(h.binance);
  let first = true;
  h.binance.place = (...args) => {
    if (first) { first = false; h.advance(h.ex.budgets.sendQuoteMaxAgeMs + 1); }
    return place(...args);
  };
  await h.ex.tickJobs();
  assert.equal(first, false);
  assert.deepEqual([h.binance.arrived.place, h.bybit.arrived.place], [0, 0]);
  h.bybit.setBook('BZUSDT', { ageMs: 60_000 });
  h.advance(1000);
  await h.ex.tickJobs();
  assert.deepEqual([h.binance.arrived.place, h.bybit.arrived.place], [0, 0]);
}));

test('只挂单立即过期且零成交不能当作实际挂上，另一所首单与本所重挂均须重新取价', () => withHarness(async h => {
  await confirmFour(h, fourIntent({ binanceLead: 'local-chase' }));
  let expired = 0;
  h.binance.place = async (_account, order, options) => {
    options.beforeSend(); expired++;
    h.binance.setBook('BZUSDT', { ageMs: 60_000 });
    return { clientOrderId: order.clientOrderId, remoteId: 'never-rested', symbol: order.symbol, side: order.side, quantity: order.quantity,
      filledQuantity: '0', averagePrice: null, status: 'expired', terminal: true, updatedAt: h.clock.now };
  };
  await h.ex.tickJobs();
  assert.deepEqual([expired, h.bybit.arrived.place], [1, 0]);
  h.binance.setBook('BZUSDT', { ageMs: 0 });
  h.bybit.setBook('BZUSDT', { ageMs: 60_000 });
  h.advance(1000); await h.ex.tickJobs();
  assert.deepEqual([expired, h.bybit.arrived.place], [1, 0]);
}));
const locks = (h: Harness) => (h.store.db.prepare('SELECT resource, job_id FROM locks ORDER BY resource').all() as { resource: string; job_id: string }[]);
const jobCount = (h: Harness) => (h.store.db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n;
const pos = (venue: SimulatedVenue, symbol: string, side: Side) => venue.position(SIM_ACCOUNTS[venue.venue as 'binance' | 'bybit'], symbol, side);
const ordersOf = (venue: SimulatedVenue) => [...venue.orders.values()];

for (const firstStatus of ['paused', 'terminal', 'working'] as const) {
  test(`四腿原生追价零成交，首次查到 ${firstStatus} 时按实际工作记录放行另一所`, () => withHarness(async h => {
    const intent = fourIntent();
    intent.legs = [...intent.legs.slice(2), ...intent.legs.slice(0, 2)];
    intent.legs[0].orderType = 'chase';
    const { ids } = await confirmFour(h, intent);
    h.bybit.inject({ operation: 'strategy-place', mode: 'partial', filled: '0' });
    const place = h.bybit.placeChase.bind(h.bybit);
    h.bybit.placeChase = async (...args) => {
      const ack = await place(...args);
      const strategy = h.bybit.strategies.get(ack.strategyId)!;
      Object.assign(strategy, { status: firstStatus, childrenSettled: false, lagQueries: 2 });
      // Delay the peer for one pass so its first send sees a strategy that has since begun ending.
      if (firstStatus === 'working') h.binance.inject({ operation: 'quote', mode: 'read-fail' });
      return ack;
    };
    await tick(h);
    const lead = h.ex.jobView(ids[0]).legs[0].operation!;
    assert.deepEqual([lead.state, lead.strategyStatus, lead.filledQuantity, lead.childrenSettled], ['open', firstStatus, '0', false]);
    assert.equal(h.binance.arrived.place, 0);
    if (firstStatus === 'working') {
      h.bybit.strategies.get(lead.remoteId!)!.status = 'terminal';
      await tick(h);
      assert.equal(h.ex.jobView(ids[0]).legs[0].operation?.strategyStatus, 'terminal');
      assert.equal(h.binance.arrived.place, 1, '此前已核实运行，另一所可以发首单');
    }
  }));
}

test('四腿意图：两个不同交易所、所内方向相反、同合约跨所方向相反、四腿同一桶数或名义金额', () => {
  const parsed = parseFourLegIntent(fourIntent());
  assert.deepEqual(parsed.parts.map(part => [part.preset, part.legs.map(item => `${item.venue}:${item.symbol}:${item.side}`)]), [
    ['same-exchange', ['binance:BZUSDT:short', 'binance:CLUSDT:long']], ['same-exchange', ['bybit:BZUSDT:long', 'bybit:CLUSDT:short']],
  ]);
  const base = fourIntent();
  const swap = (index: number, change: Record<string, unknown>) => ({ ...base, legs: base.legs.map((item, i) => (i === index ? { ...item, ...change } : item)) });
  assert.throws(() => parseFourLegIntent({ ...base, legs: base.legs.slice(0, 3) }), code('leg_count'));
  assert.throws(() => parseFourLegIntent({ ...base, preset: 'same-exchange' }), code('invalid_value'));
  assert.throws(() => parseFourLegIntent({ ...base, legs: [...base.legs.slice(0, 2), ...base.legs.slice(0, 2)] }), code('same_venue'));
  // Bybit's pair the same way round as Binance's: every contract on one side across venues.
  assert.throws(() => parseFourLegIntent({ ...base, legs: [...base.legs.slice(0, 2), { ...base.legs[2]!, side: 'short' }, { ...base.legs[3]!, side: 'long' }] }), code('same_side'));
  assert.throws(() => parseFourLegIntent({ ...base, legs: [...base.legs.slice(0, 2), { ...base.legs[2]!, barrels: '2' }, { ...base.legs[3]!, barrels: '2' }] }), code('unbalanced'));
  const quantity = ({ barrels: _b, ...rest }: Record<string, unknown>) => ({ ...rest, quantity: '1' });
  assert.throws(() => parseFourLegIntent({ ...base, legs: [...base.legs.slice(0, 2), quantity(base.legs[2]!), quantity(base.legs[3]!)] }), code('quantity_mode'));
  // Each venue's pair keeps its own rules: a chase only on a lead.
  assert.throws(() => parseFourLegIntent(swap(3, { orderType: 'chase' })), code('chase_unsupported'));
  const hynix = parseFourLegIntent(hynixIntent());
  assert.equal(hynix.market, 'hynix');
  assert.throws(() => parseFourLegIntent({ ...hynixIntent(), legs: [...hynixIntent().legs.slice(0, 2), ...hynixIntent('90').legs.slice(2)] }), code('unbalanced'));
});

test('四腿开仓与平仓：一个预览带四腿，确认原子建两个关联任务与四个锁，各自完成；同一请求编号重放返回同一组', () => withHarness(async h => {
  const { preview, requestId, result, ids } = await confirmFour(h);
  assert.equal(preview.parts.length, 2);
  assert.equal(preview.barrels, '1');
  assert.deepEqual(preview.parts.map(part => part.legs.map(item => `${item.venue}:${item.symbol}`)), [['binance:BZUSDT', 'binance:CLUSDT'], ['bybit:BZUSDT', 'bybit:CLUSDT']]);
  assert.equal(result.duplicate, false);
  assert.deepEqual(result.jobs.map(job => job.group), [{ id: result.group, index: 0, peer: ids[1] }, { id: result.group, index: 1, peer: ids[0] }]);
  assert.equal(locks(h).length, 4);
  assert.deepEqual(new Set(locks(h).map(row => row.job_id)), new Set(ids));
  // The four-leg preview is not a two-leg one, and is consumed once.
  assert.throws(() => h.ex.confirm({ previewId: preview.id, requestId: randomUUID(), confirmLive: true }, SESSION), code('preview_invalid'));
  const again = h.ex.confirmFourLeg({ previewId: preview.id, requestId, confirmLive: true }, SESSION);
  assert.deepEqual([again.duplicate, again.group, again.jobs.map(job => job.id)], [true, result.group, ids]);
  assert.throws(() => h.ex.confirmFourLeg({ previewId: preview.id, requestId: randomUUID(), confirmLive: true }, SESSION), code('preview_invalid'));
  // The request id of a four-leg confirm is not a two-leg confirm's.
  assert.throws(() => h.ex.confirm({ previewId: preview.id, requestId, confirmLive: true }, SESSION), code('request_reused'));
  assert.equal(jobCount(h), 2);
  const views = await settleAll(h, ids);
  assert.deepEqual(views.map(view => view.status), ['completed', 'completed']);
  assert.equal(locks(h).length, 0);
  assert.deepEqual([pos(h.binance, 'BZUSDT', 'short'), pos(h.binance, 'CLUSDT', 'long'), pos(h.bybit, 'BZUSDT', 'long'), pos(h.bybit, 'CLUSDT', 'short')], ['1', '1', '1', '1']);
  const close = await confirmFour(h, fourIntent({ action: 'close' }));
  assert.ok(close.preview.parts.every(part => part.legs.every(item => item.reduceOnly)));
  const closed = await settleAll(h, close.ids);
  assert.deepEqual(closed.map(view => view.status), ['completed', 'completed']);
  assert.deepEqual([pos(h.binance, 'BZUSDT', 'short'), pos(h.binance, 'CLUSDT', 'long'), pos(h.bybit, 'BZUSDT', 'long'), pos(h.bybit, 'CLUSDT', 'short')], ['0', '0', '0', '0']);
  // The alert names the other venue's job.
  assert.match(describeJob(closed[0] as unknown as JobSummary, close.ids[0]!, 'completed', null), new RegExp(`四腿，另一交易所任务 ${close.ids[1]!.slice(0, 8)}`));
}));

test('海力士四腿：每腿相同名义金额，两个交易所各按比例结算', () => withHarness(async h => {
  const { ids } = await confirmFour(h, hynixIntent());
  const views = await settleAll(h, ids);
  assert.deepEqual(views.map(view => [view.market, view.preset, view.status]), [['hynix', 'same-exchange', 'completed'], ['hynix', 'same-exchange', 'completed']]);
}));

test('四腿锁冲突：预览后另一交易所的合约被别的任务占用，确认整体拒绝，一个任务也不建、不留锁', () => withHarness(async h => {
  const preview = await h.ex.previewFourLeg(fourIntent(), SESSION);
  const other = await previewAndConfirm(h, { market: 'oil', preset: 'same-exchange', action: 'open', timeoutMs: 60_000, legs: [leg('bybit', 'CLUSDT', 'long', { barrels: '1' }), leg('bybit', 'BZUSDT', 'short', { barrels: '1' })] });
  assert.throws(() => h.ex.confirmFourLeg({ previewId: preview.id, requestId: randomUUID(), confirmLive: true }, SESSION), (error: unknown) => code('symbol_locked')(error) && /四腿整体不确认/.test((error as Error).message));
  assert.equal(jobCount(h), 1);
  assert.deepEqual(new Set(locks(h).map(row => row.job_id)), new Set([other.jobId]));
  // A new preview is refused up front, naming the venue.
  await assert.rejects(h.ex.previewFourLeg(fourIntent(), SESSION), (error: unknown) => code('symbol_locked')(error) && /^Bybit：/.test((error as Error).message));
  // The first preview is still unconsumed: once the other job is over it can be confirmed.
  await settleAll(h, [other.jobId]);
  const ok = h.ex.confirmFourLeg({ previewId: preview.id, requestId: randomUUID(), confirmLive: true }, SESSION);
  assert.equal(ok.jobs.length, 2);
}));

test('四腿一边失败：先推进的交易所盘口越过界限未发送，另一边联动停止、不再发送首腿；锁各自释放', () => withHarness(async h => {
  // After the preview Binance's BZ book moves past the lead's bound, so that job fails before sending; Bybit's job, processed
  // after it in the same pass, then sends nothing.
  const preview = await h.ex.previewFourLeg(fourIntent(), SESSION);
  h.binance.setBook('BZUSDT', { bid: '60.00', ask: '60.02' });
  const ids = h.ex.confirmFourLeg({ previewId: preview.id, requestId: randomUUID(), confirmLive: true }, SESSION).jobs.map(job => job.id);
  const [binance, bybit] = await settleAll(h, ids);
  assert.deepEqual([binance!.status, binance!.endCode], ['failed', 'price_moved']);
  assert.equal(ordersOf(h.binance).length, 0);
  assert.equal(bybit!.status, 'stopped');
  assert.match(bybit!.reason ?? '', /^四腿联动停止（Binance 任务失败/);
  assert.equal(ordersOf(h.bybit).length, 0);
  assert.ok(bybit!.peerHalt);
  assert.equal(locks(h).length, 0);
}));

test('四腿一边失败时另一边首腿正挂单：撤首腿挂单，已成交部分照常对冲后结束', () => withHarness(async h => {
  // Binance chases locally and rests; Bybit's market lead goes out after it and is refused.
  h.bybit.inject({ operation: 'place', mode: 'reject' });
  const { ids } = await confirmFour(h, fourIntent({ barrels: '2', binanceLead: 'local-chase' }));
  await tick(h);
  const resting = ordersOf(h.binance).at(-1)!;
  assert.equal(resting.status, 'new');
  h.binance.fillResting(resting.request.clientOrderId, '0.5');
  const [binance, bybit] = await settleAll(h, ids);
  assert.equal(bybit!.status, 'failed');
  assert.equal(resting.status, 'canceled', '首腿挂单已撤');
  assert.equal(binance!.status, 'completed');
  assert.match(binance!.reason ?? '', /四腿联动停止（Bybit 任务失败.*首腿不再发送.*两腿各成交 0\.5 桶，计划 2 桶/);
  assert.deepEqual([pos(h.binance, 'BZUSDT', 'short'), pos(h.binance, 'CLUSDT', 'long')], ['0.5', '0.5'], '已成交的首腿照常对冲');
  assert.equal(ordersOf(h.binance).filter(order => order.request.symbol === 'BZUSDT').length, 1, '撤单后不再挂新的首腿');
  assert.equal(locks(h).length, 0);
}));

test('四腿停止：停止任一个子任务，另一个记联动停止（不是普通停止）；同一请求编号重放不报错', () => withHarness(async h => {
  const { ids } = await confirmFour(h);
  const stopId = randomUUID();
  const view = h.ex.requestStop(ids[1]!, stopId, SESSION);
  assert.equal(view.stopRequested, true);
  const peer = h.ex.jobView(ids[0]!);
  assert.equal(peer.stopRequested, false);
  assert.equal(peer.peerHalt, 'Bybit 任务已请求停止');
  assert.equal(h.ex.requestStop(ids[1]!, stopId, SESSION).stopRequested, true);
  const views = await settleAll(h, ids);
  assert.deepEqual(views.map(item => [item.status, item.reason]), [['stopped', '四腿联动停止（Bybit 任务已请求停止），未发送任何委托'], ['stopped', '已停止，未发送任何委托']]);
  assert.equal(ordersOf(h.binance).length + ordersOf(h.bybit).length, 0);
  assert.equal(locks(h).length, 0);
}));

test('四腿一边转人工：另一边照常对冲完成，待人工的任务保留自己的两个锁到人工确认', () => withHarness(async h => {
  const { ids } = await confirmFour(h);
  await tick(h);
  // Both leads are out; Bybit's hedge is then refused, so its BZ lead stays unhedged and that job needs a person.
  h.bybit.inject({ operation: 'place', mode: 'reject' });
  const views = await settleAll(h, ids);
  assert.deepEqual(views.map(view => view.status), ['completed', 'attention']);
  assert.deepEqual([pos(h.binance, 'BZUSDT', 'short'), pos(h.binance, 'CLUSDT', 'long')], ['1', '1']);
  assert.deepEqual(locks(h).map(row => [row.resource.split(':').at(-1), row.job_id]), [['BZUSDT', ids[1]], ['CLUSDT', ids[1]]]);
  h.ex.acknowledge(ids[1]!, randomUUID(), SESSION);
  assert.equal(locks(h).length, 0);
}));

test('四腿页面表单：甲所按所选价差、乙所反向，两所都先下所选合约，各自首腿方式；通过执行器校验，页面先拒绝同所与追价分批', () => {
  const form: OilForm = { ...DEFAULT_FORM, preset: 'four-leg', venue: 'binance', hedgeVenue: 'bybit', fourSpread: 'long', leadSymbol: 'BZUSDT', barrels: '10', leadOrderType: 'local-chase', peerLeadOrderType: 'chase', chaseLimit: '70' };
  const built = fourLegFormToIntent(form);
  assert.ok('intent' in built);
  const parsed = parseFourLegIntent(built.intent);
  assert.deepEqual(parsed.legs.map(item => [item.venue, item.symbol, item.side, item.orderType, item.barrels, item.limitPrice ?? null]), [
    ['binance', 'BZUSDT', 'long', 'local-chase', '10', null], ['binance', 'CLUSDT', 'short', 'market', '10', null],
    ['bybit', 'BZUSDT', 'short', 'chase', '10', null], ['bybit', 'CLUSDT', 'long', 'market', '10', null],
  ]);
  assert.equal(describeFourLeg(built.intent), '开仓四腿 Binance 做多价差 / Bybit 做空价差');
  assert.match((fourLegFormToIntent({ ...form, hedgeVenue: 'binance' }) as { error: string }).error, /两个不同/);
  // No direction until one is picked (the page clears it on a preset or venue-pair change and disables the preview).
  assert.equal((fourLegFormToIntent({ ...form, fourSpread: '' }) as { error: string }).error, '请先选择方向');
  assert.equal((hynixFourLegFormToIntent({ ...DEFAULT_HYNIX_FORM, preset: 'four-leg', venue: 'binance', hedgeVenue: 'okx', notional: '500', sizing: 'notional' }) as { error: string }).error, '请先选择方向');
  assert.match((fourLegFormToIntent({ ...form, batchCount: '2', batchIntervalSeconds: '5' }) as { error: string }).error, /^Bybit：分批只用于/);
  const hynix = hynixFourLegFormToIntent({ ...DEFAULT_HYNIX_FORM, preset: 'four-leg', venue: 'binance', hedgeVenue: 'okx', fourPremium: 'short', notional: '500', sizing: 'notional' });
  assert.ok('intent' in hynix);
  assert.deepEqual(parseFourLegIntent(hynix.intent).legs.map(item => [item.venue, item.symbol, item.side, item.notional]), [
    ['binance', 'SKHYUSDT', 'short', '500'], ['binance', 'SKHYNIXUSDT', 'long', '500'], ['okx', 'SKHYUSDT', 'long', '500'], ['okx', 'SKHYNIXUSDT', 'short', '500'],
  ]);
  assert.equal(describeHynixFourLeg(hynix.intent), '开仓四腿 Binance 做空溢价 / OKX 做多溢价');
  assert.match((hynixFourLegFormToIntent({ ...DEFAULT_HYNIX_FORM, preset: 'four-leg', action: 'close', sizing: 'quantity', leadQuantity: '1', hedgeQuantity: '1' }) as { error: string }).error, /名义金额/);
});

test('四腿任务列表：两个子任务按组排在一起；整体状态为执行中、已完成、两所成交不等、四腿不完整或另一所未列出', () => {
  const job = (id: string, venue: string, status: string, filled: [string, string], group?: { id: string; index: number; peer: string }) => ({
    id, market: 'oil', preset: 'same-exchange', action: 'open', status, group: group ?? null,
    legs: (['BZUSDT', 'CLUSDT'] as const).map((symbol, index) => ({ venue, symbol, filledBarrels: filled[index], plannedBarrels: '10', filledQuantity: filled[index], plannedQuantity: '10', quantityStep: '1' })),
  }) as unknown as OilJob;
  const a = job('a', 'binance', 'completed', ['10', '10'], { id: 'g', index: 0, peer: 'b' });
  const b = job('b', 'bybit', 'running', ['4', '4'], { id: 'g', index: 1, peer: 'a' });
  const lone = job('c', 'okx', 'completed', ['1', '1']);
  const entries = groupJobs([b, lone, a]);
  assert.deepEqual(entries.map(entry => [entry.group, entry.jobs.map(item => item.id)]), [['g', ['a', 'b']], [null, ['c']]]);
  assert.deepEqual(groupStatus([a, b]), { status: 'running', text: '执行中', details: [] });
  assert.equal(groupStatus([a, { ...b, status: 'completed', legs: a.legs.map(item => ({ ...item, venue: 'bybit' })) }]).status, 'completed');
  const stopped = groupStatus([a, { ...b, status: 'stopped' }]);
  assert.equal(stopped.text, '四腿不完整');
  assert.deepEqual(stopped.details, ['Bybit 任务已停止', 'BZ 两所成交不等：Binance 10 / 10 桶，Bybit 4 / 10 桶', 'CL 两所成交不等：Binance 10 / 10 桶，Bybit 4 / 10 桶']);
  // Both completed, one short: the same rule as the executor's alert; one quantity step apart is not a gap.
  assert.deepEqual(groupStatus([a, { ...b, status: 'completed' }]).status, 'unbalanced');
  assert.deepEqual(groupStatus([a, job('b', 'bybit', 'completed', ['9', '10'], { id: 'g', index: 1, peer: 'a' })]), { status: 'completed', text: '已完成', details: [] });
  assert.deepEqual(groupStatus([{ ...a, status: 'failed' }, { ...b, status: 'attention' }]).details.slice(0, 2), ['Bybit 任务需人工处理，请先处理', 'Binance 任务失败']);
  assert.deepEqual(groupStatus([a]), { status: 'unlisted', text: '另一所未列出', details: ['另一交易所的任务不在当前列表中，可在该交易所的成交记录里核对'] });
  assert.equal(groupStatus([b]).status, 'running');
});

test('四腿预览：过期、接管换代次后确认被拒绝；四腿确认不接受普通预览', () => withHarness(async h => {
  const expired = await h.ex.previewFourLeg(fourIntent(), SESSION);
  h.advance(121_000);
  assert.throws(() => h.ex.confirmFourLeg({ previewId: expired.id, requestId: randomUUID(), confirmLive: true }, SESSION), code('preview_invalid'));
  const plain = await h.ex.preview(openIntent(), SESSION);
  assert.throws(() => h.ex.confirmFourLeg({ previewId: plain.id, requestId: randomUUID(), confirmLive: true }, SESSION), (error: unknown) => code('preview_invalid')(error) && /这不是四腿预览/.test((error as Error).message));
  const old = await h.ex.previewFourLeg(fourIntent(), SESSION);
  h.clock.now += 61_000;
  h.restart();
  assert.equal(h.ex.acquire(), true);
  assert.throws(() => h.ex.confirmFourLeg({ previewId: old.id, requestId: randomUUID(), confirmLive: true }, SESSION), code('preview_generation'));
  assert.equal(jobCount(h), 0);
}, { budgets: { previewTtlMs: 120_000 } }));

test('四腿接管恢复：组关系与联动停止在重启后保留，恢复时一边结束写下的联动停止不被另一边的旧快照覆盖', () => withHarness(async h => {
  const { ids, result } = await confirmFour(h);
  // Nothing was sent before the old writer went away: the takeover fails both jobs, the first one halting the second.
  h.clock.now += 61_000;
  h.restart();
  assert.equal(h.ex.acquire(), true);
  const [binance, bybit] = ids.map(id => h.ex.jobView(id));
  assert.deepEqual([binance!.status, bybit!.status], ['failed', 'failed']);
  assert.deepEqual([binance!.group, bybit!.group], [{ id: result.group, index: 0, peer: ids[1] }, { id: result.group, index: 1, peer: ids[0] }]);
  assert.match(bybit!.peerHalt ?? '', /^Binance 任务失败/);
  assert.equal(locks(h).length, 0);
}));

test('四腿组内顺序反过来：后处理的交易所盘口越过界限时，先处理的交易所也不发送首腿', () => withHarness(async h => {
  // Bybit (index 1) is processed after Binance in a pass; its BZ book moves past its bound after the preview.
  const preview = await h.ex.previewFourLeg(fourIntent(), SESSION);
  h.bybit.setBook('BZUSDT', { bid: '90.00', ask: '90.02' });
  const ids = h.ex.confirmFourLeg({ previewId: preview.id, requestId: randomUUID(), confirmLive: true }, SESSION).jobs.map(job => job.id);
  await tick(h);
  assert.equal(ordersOf(h.binance).length, 0, 'Binance 等另一所也能发送');
  const [binance, bybit] = await settleAll(h, ids);
  assert.deepEqual([bybit!.status, bybit!.endCode], ['failed', 'price_moved']);
  assert.equal(binance!.status, 'stopped');
  assert.match(binance!.peerHalt ?? '', /^Bybit 任务失败/);
  assert.equal(ordersOf(h.binance).length + ordersOf(h.bybit).length, 0);
  assert.equal(locks(h).length, 0);
}));

test('四腿停止一所时另一所首腿已成交未对冲：另一所只记联动停止，对冲照常发送', () => withHarness(async h => {
  // After the first pass both leads have filled and no hedge has gone out yet.
  const { ids } = await confirmFour(h);
  await tick(h);
  assert.deepEqual([pos(h.bybit, 'BZUSDT', 'long'), pos(h.bybit, 'CLUSDT', 'short')], ['1', '0'], '首腿已成交、对冲未发');
  h.ex.requestStop(ids[0]!, randomUUID(), SESSION);
  const bybit = h.ex.jobView(ids[1]!);
  assert.deepEqual([bybit.stopRequested, bybit.peerHalt], [false, 'Binance 任务已请求停止']);
  const views = await settleAll(h, ids);
  assert.equal(pos(h.bybit, 'CLUSDT', 'short'), '1', 'Bybit 对冲照常发送');
  assert.equal(views[1]!.status, 'completed');
  assert.equal(locks(h).filter(row => row.job_id === ids[1]).length, 0);
}));

test('四腿一所完成但首腿成交实质性少于计划（IOC 只成交一半）：另一所联动停止；两边结束后成交不等记一条飞书告警', () => withHarness(async h => {
  // Binance's local chase rests unfilled; Bybit's market lead fills half and its job completes short.
  h.bybit.inject({ operation: 'place', mode: 'partial', filled: '0.5', times: 1 });
  const { ids, result } = await confirmFour(h, fourIntent({ binanceLead: 'local-chase' }));
  const [binance, bybit] = await settleAll(h, ids);
  assert.equal(bybit!.status, 'completed');
  assert.equal(binance!.peerHalt, 'Bybit 第 1 批首腿发出 1，成交 0.5');
  assert.equal(binance!.status, 'stopped');
  assert.equal(ordersOf(h.binance).filter(order => order.status === 'new').length, 0, 'Binance 首腿挂单已撤');
  const alerts = h.store.db.prepare("SELECT seq, at, job_id, json FROM events WHERE type = 'four-leg-unbalanced'").all() as { seq: number; at: number; job_id: string; json: string }[];
  assert.equal(alerts.length, 1);
  const message = describeEvent({ seq: alerts[0]!.seq, at: alerts[0]!.at, type: 'four-leg-unbalanced', json: alerts[0]!.json, jobId: alerts[0]!.job_id }, () => null);
  assert.equal(message?.onceKey, `four-leg:${result.group}`);
  // With a job needing a person its orders are still being reconciled: the text says the fills are as of the end.
  assert.match(describeEvent({ seq: 1, at: 0, type: 'four-leg-unbalanced', json: JSON.stringify({ ...JSON.parse(alerts[0]!.json), attention: true }), jobId: alerts[0]!.job_id }, () => null)?.text ?? '', /有任务需人工处理，委托仍在核对，成交以结束时为准/);
  assert.match(message?.text ?? '', /^【四腿成交不等】.*BZ 两所成交不等：Binance 0 \/ 1 桶，Bybit 0\.5 \/ 1 桶.*（以两个任务结束时为准）；请到交易所核对两所敞口$/);
  const detail = JSON.parse(alerts[0]!.json) as { group: string; details: string[] };
  assert.equal(detail.group, result.group);
  assert.deepEqual(detail.details, ['BZ 两所成交不等：Binance 0 / 1 桶，Bybit 0.5 / 1 桶', 'CL 两所成交不等：Binance 0 / 1 桶，Bybit 0.5 / 1 桶']);
  assert.equal(locks(h).length, 0);
}));

test('四腿成交比较：按各所计划的成交比例比较，容差是一个下单步长加两所实际记录的跳过量；计划无效记无法比较', () => {
  // Hynix sizes each venue by notional, so the two venues' plans differ in contracts.
  const legs = (venue: string, [sky, sk]: [string, string], [skyPlan, skPlan] = ['4', '30'], skipped = '0'): FillLeg[] => [
    { venue, symbol: 'SKHYUSDT', filled: sky, planned: skyPlan, step: '1', skipped, shown: `${sky} / ${skyPlan}` },
    { venue, symbol: 'SKHYNIXUSDT', filled: sk, planned: skPlan, step: '1', skipped, shown: `${sk} / ${skPlan}` },
  ];
  assert.deepEqual(fillGaps(legs('Binance', ['4', '30']), legs('Bybit', ['5', '24'], ['5', '24'])), [], '全部成交');
  assert.deepEqual(fillGaps(legs('Binance', ['2', '15']), legs('Bybit', ['3', '12'], ['5', '24'])), [], '同比例部分成交，相差在一步内');
  assert.deepEqual(fillGaps(legs('Binance', ['4', '29']), legs('Bybit', ['5', '24'], ['5', '24'])), [], '相差一步');
  const gaps = fillGaps(legs('Binance', ['4', '30']), legs('Bybit', ['2', '12'], ['5', '24']));
  assert.deepEqual(gaps.map(fillGapText), ['SKHY 两所成交不等：Binance 4 / 4，Bybit 2 / 5', 'SKHYNIX 两所成交不等：Binance 30 / 30，Bybit 12 / 24']);
  const one = (venue: string, filled: string, extra: Partial<FillLeg> = {}): FillLeg[] => [{ venue, symbol: 'BZUSDT', filled, planned: '1', step: '0.1', skipped: '0', shown: '', ...extra }];
  // Bybit split into five batches, each IOC filling half: 0.5 of 1 against Binance's 1 is a gap, whatever the batch count.
  assert.equal(fillGaps(one('Binance', '1', { step: '0.01' }), one('Bybit', '0.5')).length, 1);
  assert.equal(fillGaps(one('Binance', '1', { step: '0.01' }), one('Bybit', '0.8')).length, 1);
  // What a local chase actually skipped by design widens the tolerance by that much, no more.
  assert.equal(fillGaps(one('Binance', '0.95', { step: '0.01', skipped: '0.05' }), one('Bybit', '1', { step: '0.01' })).length, 0);
  assert.equal(fillGaps(one('Binance', '0.95', { step: '0.01' }), one('Bybit', '1', { step: '0.01' })).length, 1);
  // A plan that is not a finite positive number cannot be compared and is reported; a step that is not a number counts as none.
  assert.deepEqual(fillGaps(legs('Binance', ['0', '0'], ['0', '30']), legs('Bybit', ['0', '0'])).map(gap => [gap.symbol, gap.comparable]), [['SKHYUSDT', false]]);
  assert.deepEqual(fillGaps(one('Binance', '1', { planned: 'abc' }), one('Bybit', '1')).map(gap => gap.comparable), [false]);
  assert.equal(fillGaps(one('Binance', '1', { step: 'abc' }), one('Bybit', '0.99', { step: 'abc' })).length, 1);
  assert.deepEqual(fillGaps(one('Binance', 'Infinity'), one('Bybit', '1')).map(gap => gap.comparable), [false]);
  assert.equal(fillGaps(one('Binance', '1', { skipped: 'abc' }), one('Bybit', '0.89', { skipped: '-1' })).length, 1);
});

test('四腿成交比较：两所实际跳过比例之和含循环小数时，严格越过容差的最小十进制差额也能区分', () => {
  const a = [
    { symbol: 'SKHYUSDT', filled: '2.9', planned: '3', step: '0.01', skipped: '0.1', venue: 'Binance', shown: '' },
    { symbol: 'SKHYNIXUSDT', filled: '0.966', planned: '1', step: '0.001', skipped: '0.033333333333333333', venue: 'Binance', shown: '' },
  ];
  for (const [filled, unequal] of [['2.758000000000000001', false], ['2.758', false], ['2.757999999999999999', true]] as const) {
    const b = [
      { symbol: 'SKHYUSDT', filled: '4.455', planned: '4.5', step: '0.1', skipped: '0.045', venue: 'OKX', shown: '' },
      { symbol: 'SKHYNIXUSDT', filled, planned: '3', step: '0.01', skipped: '0.03', venue: 'OKX', shown: '' },
    ];
    // Equality: 0.966 − 2.758/3 = 0.01/3 (the larger step) + 0.1/3 + 0.045/4.5.
    assert.deepEqual(fillGaps(a, b).map(gap => gap.symbol), unequal ? ['SKHYNIXUSDT'] : [], filled);
  }
});

test('四腿任务列表：组内另一任务落在最近 20 条之外时随列表一起返回', () => withHarness(async h => {
  const { ids } = await confirmFour(h);
  await settleAll(h, ids);
  // 19 later jobs: the group's second job is the 20th listed, its first one the 21st.
  for (let i = 0; i < 19; i++) { const { jobId } = await previewAndConfirm(h); await settleAll(h, [jobId]); }
  const listed = h.ex.recentJobs(20).map(job => job.id);
  assert.equal(listed.length, 21);
  assert.ok(listed.includes(ids[0]!) && listed.includes(ids[1]!));
  // The other job's row not found (its id pointing nowhere): the list still comes back, with the group's one job.
  h.store.db.prepare("UPDATE jobs SET json = json_set(json, '$.group.peer', ?) WHERE id = ?").run(randomUUID(), ids[1]!);
  assert.deepEqual(h.ex.recentJobs(20).filter(job => job.group).map(job => job.id), [ids[1]]);
}));

test('四腿一所本地追价留下发不出的零头完成：另一所仍在追价不被停，结束后不算成交不等', () => withHarness(async h => {
  // Binance's local chase fills 0.95 of 1 BZ; the 0.05 left is under the minimum notional with its margin, so the batch ends.
  // Bybit's chase strategy is still working with nothing filled.
  h.bybit.inject({ operation: 'strategy-place', mode: 'partial', filled: '0' });
  const { ids } = await confirmFour(h, { ...fourIntent({ binanceLead: 'local-chase' }), legs: fourIntent({ binanceLead: 'local-chase' }).legs.map((item, index) => index === 2 ? { ...item, orderType: 'chase' } : item) });
  await tick(h);
  const resting = ordersOf(h.binance).at(-1)!;
  h.binance.fillResting(resting.request.clientOrderId, '0.95');
  // The book moves, so the chase withdraws the 0.05 left resting and finds it too small to send again.
  h.binance.setBook('BZUSDT', { bid: '74.05', ask: '74.07' });
  for (let i = 0; i < 10 && h.ex.jobView(ids[0]!).status !== 'completed'; i++) await tick(h);
  const [binance, bybit] = ids.map(id => h.ex.jobView(id));
  assert.equal(binance!.status, 'completed');
  assert.equal(binance!.legs[0]!.filledQuantity, '0.95');
  assert.deepEqual([binance!.leadSkipped, binance!.leadDeviation], ['0.05', null], '记下按设计跳过的 0.05，不算偏离');
  assert.deepEqual([bybit!.status, bybit!.peerHalt], ['running', null], 'Bybit 不被联动停止');
  const strategy = [...h.bybit.strategies.values()].find(item => item.status === 'working')!;
  h.bybit.fillStrategy(strategy.id, '1');
  const views = await settleAll(h, ids);
  assert.deepEqual(views.map(view => view.status), ['completed', 'completed']);
  assert.equal(h.store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'four-leg-unbalanced'").get()!.n, 0, '0.05 是记下的跳过量');
  assert.equal(locks(h).length, 0);
}));

/** The client order id of a job's lead order number attempt (0 for the first), as the executor names it. */
const leadOrderId = (jobId: string, attempt: number) => `pa1-${jobId.replace(/-/g, '').slice(0, 24)}-0${attempt ? `r${attempt}` : ''}`;
const eventCount = (h: Harness, type: string) => (h.store.db.prepare('SELECT COUNT(*) AS n FROM events WHERE type = ?').get(type) as { n: number }).n;
function assertGroupGaps(views: ReturnType<Harness['ex']['jobView']>[], symbols: readonly string[]) {
  assert.deepEqual(views.map(view => view.status), ['completed', 'completed']);
  const alerts = views.flatMap(view => view.events).filter(event => event.type === 'four-leg-unbalanced');
  assert.equal(alerts.length, symbols.length ? 1 : 0);
  const details: string[] = alerts[0]?.details ?? [];
  assert.deepEqual(details.map(line => line.split(' ')[0]), symbols);
  const page = groupStatus(views);
  assert.deepEqual([page.status, page.details], [symbols.length ? 'unbalanced' : 'completed', details]);
}

test('四腿偏离：Bybit 市价分 5 批、每批只成交一半，第 1 批就联动停止 Binance；结束后成交不等告警', () => withHarness(async h => {
  const { ids } = await confirmFour(h, { ...fourIntent({ barrels: '5', binanceLead: 'local-chase' }), batches: { count: 5, intervalMs: 0 } });
  for (let attempt = 0; attempt < 5; attempt++) h.bybit.inject({ operation: 'place', mode: 'partial', filled: '0.5', clientOrderId: leadOrderId(ids[1]!, attempt) });
  const [binance, bybit] = await settleAll(h, ids);
  assert.equal(bybit!.leadDeviation, 'Bybit 第 1 批首腿发出 1，成交 0.5');
  // Bybit itself sends no further batch either: both venues stop where they filled.
  assert.deepEqual([bybit!.status, bybit!.legs[0]!.filledQuantity, bybit!.legs[1]!.filledQuantity, bybit!.peerHalt], ['completed', '0.5', '0.5', null]);
  assert.equal(ordersOf(h.bybit).filter(order => order.request.clientOrderId.endsWith('-0r1')).length, 0, '不发第 2 批');
  assert.equal(binance!.peerHalt, 'Bybit 第 1 批首腿发出 1，成交 0.5');
  assert.equal(binance!.legs[0]!.filledQuantity, '0');
  assert.equal(eventCount(h, 'four-leg-deviation'), 1);
  assert.equal(eventCount(h, 'four-leg-unbalanced'), 1);
  assert.equal(locks(h).length, 0);
}));

test('四腿偏离：分 2 批，第 2 批只成交 0.3 / 0.5，Binance 第 2 批联动停止；结束后成交不等告警', () => withHarness(async h => {
  const { ids } = await confirmFour(h, { ...fourIntent({ binanceLead: 'local-chase' }), batches: { count: 2, intervalMs: 0 } });
  h.bybit.inject({ operation: 'place', mode: 'partial', filled: '0.3', clientOrderId: leadOrderId(ids[1]!, 1) });
  await tick(h);
  // Binance's first batch fills in full while Bybit goes on to its second.
  h.binance.fillResting(leadOrderId(ids[0]!, 0), '0.5');
  const [binance, bybit] = await settleAll(h, ids);
  assert.equal(bybit!.legs[0]!.filledQuantity, '0.8');
  assert.equal(binance!.peerHalt, 'Bybit 第 2 批首腿发出 0.5，成交 0.3');
  assert.equal(binance!.legs[0]!.filledQuantity, '0.5');
  assert.equal(binance!.legs[1]!.filledQuantity, '0.5', '已成交部分照常对冲');
  assert.equal(eventCount(h, 'four-leg-unbalanced'), 1);
  assert.equal(locks(h).length, 0);
}));

test('四腿偏离：本地追价成交一半后连续挂单失败提前放弃，另一所追价策略被联动停止；结束后成交不等告警', () => withHarness(async h => {
  h.bybit.inject({ operation: 'strategy-place', mode: 'partial', filled: '0' });
  const { ids } = await confirmFour(h, { ...fourIntent({ binanceLead: 'local-chase' }), legs: fourIntent({ binanceLead: 'local-chase' }).legs.map((item, index) => index === 2 ? { ...item, orderType: 'chase' } : item) });
  for (let attempt = 1; attempt <= 3; attempt++) h.binance.inject({ operation: 'place', mode: 'reject', clientOrderId: leadOrderId(ids[0]!, attempt) });
  await tick(h);
  h.binance.fillResting(leadOrderId(ids[0]!, 0), '0.5');
  // The book moves, so the chase withdraws the half left and posts again; the venue refuses it three times.
  h.binance.setBook('BZUSDT', { bid: '74.05', ask: '74.07' });
  const [binance, bybit] = await settleAll(h, ids);
  assert.equal(binance!.status, 'completed');
  assert.equal(binance!.legs[0]!.filledQuantity, '0.5');
  assert.equal(binance!.leadSkipped, null, '提前放弃不记为按设计跳过');
  assert.equal(binance!.leadDeviation, 'Binance 首腿提前结束：计划 1，成交 0.5，未发 0.5');
  assert.equal(bybit!.peerHalt, 'Binance 首腿提前结束：计划 1，成交 0.5，未发 0.5');
  assert.equal([...h.bybit.strategies.values()].filter(item => item.status === 'working').length, 0, 'Bybit 追价策略已撤');
  assert.equal(eventCount(h, 'four-leg-unbalanced'), 1);
  assert.equal(locks(h).length, 0);
}));

test('四腿偏离：本地追价按设计跳过的零头与提前结束的偏离在重启后保留', () => withHarness(async h => {
  // Bybit fills at once; Binance's first batch fills 0.45 of 0.5 and skips the 0.05 left, then its second batch rests.
  const { ids } = await confirmFour(h, { ...fourIntent({ binanceLead: 'local-chase', timeoutMs: 600_000 }), batches: { count: 2, intervalMs: 0 } });
  await tick(h);
  h.binance.fillResting(leadOrderId(ids[0]!, 0), '0.45');
  h.binance.setBook('BZUSDT', { bid: '74.05', ask: '74.07' });
  for (let i = 0; i < 10 && h.ex.jobView(ids[0]!).leadSkipped === null; i++) await tick(h);
  await tick(h);
  assert.equal(ordersOf(h.binance).filter(order => order.status === 'new').length, 1, '第 2 批挂单中');
  assert.equal(h.ex.jobView(ids[0]!).leadSkipped, '0.05');
  // The service restarts with the second batch resting: recovery withdraws it, and the job ends short of its plan.
  h.clock.now += 61_000;
  h.restart();
  assert.equal(h.ex.acquire(), true);
  const [binance] = await settleAll(h, ids);
  assert.equal(binance!.leadSkipped, '0.05');
  assert.deepEqual(binance!.legs.map(item => item.skippedQuantity), ['0.05', '0.05']);
  assert.equal(binance!.leadDeviation, 'Binance 首腿提前结束：计划 1，成交 0.45，按设计跳过 0.05，未发 0.5');
  h.clock.now += 61_000;
  h.restart();
  assert.equal(h.ex.acquire(), true);
  const again = h.ex.jobView(ids[0]!);
  assert.deepEqual([again.leadSkipped, again.leadDeviation], ['0.05', binance!.leadDeviation]);
  assert.equal(eventCount(h, 'four-leg-unbalanced'), 1);
}));

for (const recovery of ['截止', '接管'] as const) {
  test(`四腿本地追价：对冲回报待核对时${recovery}，末批已结清的零头只登记一次，另一所继续对冲`, () => withHarness(async h => {
    // 0.08 is worth more than the 5 USDT minimum but less than its 1.2 margin. The takeover case uses only minQuantity.
    if (recovery === '接管') Object.assign(h.binance.instruments.get('BZUSDT')!, { minQuantity: '0.1', minNotional: '0' });
    // A final 0.08 gap is larger than either venue's step and needs the actual skip to reconcile.
    for (const symbol of ['BZUSDT', 'CLUSDT']) h.bybit.instruments.get(symbol)!.quantityStep = '0.01';
    const { ids } = await confirmFour(h, fourIntent({ binanceLead: 'local-chase', timeoutMs: recovery === '截止' ? 30_000 : 600_000 }));
    await tick(h);
    const lead = ordersOf(h.binance)[0]!;
    h.binance.fillResting(lead.request.clientOrderId, '0.92');
    for (const venue of [h.binance, h.bybit]) venue.inject({ operation: 'place', mode: 'lost-response' });
    await tick(h);
    const hedge = h.ex.jobView(ids[0]!).legs[1]!.operation!;
    const peerHedge = h.ex.jobView(ids[1]!).legs[1]!.operation!;
    assert.deepEqual([hedge.state, peerHedge.state], ['unknown', 'unknown']);
    // The venue closes the lead before the worker next runs. The original hedge is still at the venue under its own id.
    await h.binance.cancel(SIM_BINDINGS[0], lead.request, { signal: new AbortController().signal, beforeSend() {} });
    h.binance.inject({ operation: 'query', mode: 'read-fail', clientOrderId: hedge.clientOrderId, times: 2 });
    h.bybit.inject({ operation: 'query', mode: 'read-fail', clientOrderId: peerHedge.clientOrderId, times: 10 });
    if (recovery === '截止') h.advance(30_000);
    else { h.clock.now += 61_000; h.restart(); assert.equal(h.ex.acquire(), true); }
    for (let pass = 0; pass < 2; pass++) {
      await tick(h);
      const view = h.ex.jobView(ids[0]!);
      assert.deepEqual(view.legs.map(item => item.operation!.state), ['canceled', 'unknown']);
      assert.equal(view.leadSkipped, '0.08', '首腿已结清，对冲仍待核对');
    }
    const [own] = await settleAll(h, [ids[0]!]);
    assert.deepEqual([own.status, own.leadSkipped, own.leadDeviation, own.legs[1]!.filledQuantity], ['completed', '0.08', null, '0.92']);
    assert.deepEqual([h.ex.jobView(ids[1]!).status, h.ex.jobView(ids[1]!).peerHalt], ['running', null]);
    assert.deepEqual(ordersOf(h.binance).map(order => [order.request.symbol, order.request.quantity]), [['BZUSDT', '1'], ['CLUSDT', '0.83'], ['CLUSDT', '0.09']]);
    assert.equal(h.binance.arrived.place, 3, '两次对冲合计等于首腿成交，零头没有送往交易所');
    h.bybit.clearFaults();
    const [, peer] = await settleAll(h, ids);
    assert.deepEqual([peer.status, peer.legs[1]!.filledQuantity], ['completed', '1']);
    assert.deepEqual([eventCount(h, 'four-leg-deviation'), eventCount(h, 'four-leg-halted'), eventCount(h, 'four-leg-unbalanced')], [0, 0, 0]);
    if (recovery === '接管') {
      h.clock.now += 61_000; h.restart(); assert.equal(h.ex.acquire(), true);
      assert.equal(h.ex.jobView(ids[0]!).leadSkipped, '0.08');
    }
  }));
}

test('四腿本地追价：首腿确认撤余的同一轮对冲核对超时，转人工时也保留实际零头及合约锁', () => withHarness(async h => {
  const { ids } = await confirmFour(h, fourIntent({ binanceLead: 'local-chase' }));
  await tick(h);
  const lead = ordersOf(h.binance)[0]!;
  h.binance.fillResting(lead.request.clientOrderId, '0.95');
  h.binance.inject({ operation: 'place', mode: 'lost-response' });
  await tick(h);
  const hedge = h.ex.jobView(ids[0]!).legs[1]!.operation!;
  await h.binance.cancel(SIM_BINDINGS[0], lead.request, { signal: new AbortController().signal, beforeSend() {} });
  h.binance.inject({ operation: 'query', mode: 'read-fail', clientOrderId: hedge.clientOrderId, times: 2 });
  h.advance(190_000);
  await tick(h);
  const own = h.ex.jobView(ids[0]!);
  assert.deepEqual([own.status, own.locked, own.legs[1]!.operation!.state, own.leadSkipped, own.leadDeviation], ['attention', true, 'unknown', '0.05', null]);
  assert.equal(h.binance.arrived.place, 2);
}));

test('四腿本地追价：委托数已达上限时按提前放弃结算，即使末批余量恰好发不出', () => withHarness(async h => {
  // No hedge reserve is needed here, so the one allowed hedge covers the lead's entire fill.
  h.binance.instruments.get('CLUSDT')!.minNotional = '0';
  const intent = fourIntent({ binanceLead: 'local-chase' });
  intent.legs[2]!.orderType = 'chase';
  h.bybit.inject({ operation: 'strategy-place', mode: 'partial', filled: '0.3' });
  const { ids } = await confirmFour(h, intent);
  await tick(h);
  h.binance.fillResting(leadOrderId(ids[0]!, 0), '0.95');
  h.binance.setBook('BZUSDT', { bid: '74.05', ask: '74.07' });
  const [own, peer] = await settleAll(h, ids);
  assert.deepEqual([own.status, own.leadSkipped, own.leadDeviation], ['completed', null, 'Binance 首腿提前结束：计划 1，成交 0.95，未发 0.05']);
  assert.deepEqual([peer.peerHalt, peer.legs[1]!.filledQuantity], [own.leadDeviation, '0.3']);
  assert.equal(eventCount(h, 'four-leg-deviation'), 1);
}, { budgets: { chaseOrderLimit: 1 } }));

for (const [filled, halts, expectedGaps] of [
  ['2.300000000000000001', false, []], ['2.3', true, []], ['2.299999999999999999', true, ['SKHY', 'SKHYNIX']],
] as const) {
  test(`四腿单笔 IOC：发出 2.4、成交 ${filled}，分别核对一步联动和最终两所严格容差`, () => withHarness(async h => {
    const { ids, preview } = await confirmFour(h, hynixIntent());
    assert.deepEqual(preview.parts.map(part => part.legs.map(item => [item.quantity, item.instrument.quantityStep])), [
      [['2.42', '0.01'], ['0.249', '0.001']], [['2.4', '0.1'], ['0.24', '0.01']],
    ]);
    h.bybit.inject({ operation: 'place', mode: 'partial', filled, clientOrderId: leadOrderId(ids[1]!, 0) });
    await tick(h); await tick(h);
    const why = halts ? `Bybit 第 1 批首腿发出 2.4，成交 ${filled}` : null;
    assert.deepEqual([h.ex.jobView(ids[1]!).leadDeviation, h.ex.jobView(ids[0]!).peerHalt], [why, why]);
    const views = await settleAll(h, ids);
    assert.deepEqual([views[1].leadDeviation, eventCount(h, 'four-leg-deviation')], [why, Number(halts)], '终态仍按原笔委托判断');
    assertGroupGaps(views, expectedGaps);
  }));
}

for (const end of ['截止', '拒单'] as const) {
  test(`四腿市价分批：首批少于一步，第二批${end}，只把未被交易所接受的第二批算作提前结束`, () => withHarness(async h => {
    const { ids, preview } = await confirmFour(h, { ...hynixIntent(), batches: { count: 2, intervalMs: 0 } });
    assert.deepEqual(preview.parts[0].batches, ['1.21', '1.21']);
    h.binance.inject({ operation: 'place', mode: 'partial', filled: '1.205', clientOrderId: leadOrderId(ids[0]!, 0) });
    await tick(h); await tick(h);
    assert.equal(h.ex.jobView(ids[0]!).leadDeviation, null);
    if (end === '截止') h.advance(60_000);
    else h.binance.inject({ operation: 'place', mode: 'reject', clientOrderId: leadOrderId(ids[0]!, 1) });
    const [own, peer] = await settleAll(h, ids);
    const why = 'Binance 首腿提前结束：计划 2.42，成交 1.205，未发 1.21';
    assert.deepEqual([own.status, own.legs[0].attempts, own.leadDeviation, peer.peerHalt], ['completed', end === '截止' ? 1 : 2, why, why]);
    assert.equal(eventCount(h, 'four-leg-deviation'), 1);
  }));
}

for (const [bybitFilled, expectedGaps] of [['4', []], ['3.68', ['SKHYNIX']]] as const) {
  test(`海力士四腿：真实跳过 0.1 / 3，按两所各自步长和非整数比例比较对冲腿（Bybit 首腿 ${bybitFilled}）`, () => withHarness(async h => {
    h.binance.setBook('SKHYUSDT', { bid: '39.99', ask: '40.01' }); h.binance.setBook('SKHYNIXUSDT', { bid: '119.99', ask: '120.01' });
    h.bybit.setBook('SKHYUSDT', { bid: '29.99', ask: '30.01' }); h.bybit.setBook('SKHYNIXUSDT', { bid: '59.99', ask: '60.01' });
    const intent = hynixIntent('120');
    intent.legs[0]!.orderType = 'local-chase'; intent.legs[2]!.orderType = 'chase';
    h.bybit.inject({ operation: 'strategy-place', mode: 'partial', filled: bybitFilled });
    const { ids, preview } = await confirmFour(h, intent);
    assert.deepEqual(preview.parts.map(part => part.legs.map(item => item.quantity)), [['3', '1'], ['4', '2']]);
    await tick(h);
    h.binance.fillResting(leadOrderId(ids[0]!, 0), '2.9');
    h.binance.setBook('SKHYUSDT', { bid: '39.98', ask: '40' });
    const [own] = await settleAll(h, [ids[0]!]);
    assert.deepEqual([own.status, own.leadSkipped, own.leadDeviation], ['completed', '0.1', null]);
    assert.deepEqual(own.legs.map(item => [item.filledQuantity, item.skippedQuantity]), [['2.9', '0.1'], ['0.966', '0.033333333333333333']]);
    h.advance(60_000);
    const views = await settleAll(h, ids);
    assertGroupGaps(views, expectedGaps);
  }));
}

test('四腿 IOC 回报从核对中到部分成交、重复部分成交再到撤余：按累计量补对冲，一次偏离，另一所的已成交部分照常对冲', () => withHarness(async h => {
  const { ids } = await confirmFour(h, fourIntent({ binanceLead: 'local-chase' }));
  const id = leadOrderId(ids[1]!, 0);
  h.bybit.inject({ operation: 'place', mode: 'partial', filled: '0.6', clientOrderId: id });
  const place = h.bybit.place.bind(h.bybit), query = h.bybit.query.bind(h.bybit);
  h.bybit.place = async (binding, request, options) => {
    const result = await place(binding, request, options);
    if (request.clientOrderId === id) throw new Error('模拟 IOC 成交后应答丢失');
    return result;
  };
  let partialReads = 0;
  h.bybit.query = async (binding, request, options) => {
    const report = await query(binding, request, options);
    if (request.clientOrderId === id && report && partialReads++ < 2) return { ...report, status: 'partially-filled', terminal: false, filledQuantity: '0.4' };
    return report;
  };
  await tick(h);
  assert.equal(h.ex.jobView(ids[1]!).legs[0]!.operation!.state, 'unknown');
  h.binance.fillResting(leadOrderId(ids[0]!, 0), '0.3');
  for (let pass = 0; pass < 2; pass++) {
    await tick(h);
    const view = h.ex.jobView(ids[1]!);
    assert.deepEqual([view.legs[0]!.operation!.state, view.legs[0]!.filledQuantity, view.legs[1]!.filledQuantity, view.legs[1]!.attempts], ['open', '0.4', '0.4', 1]);
    assert.equal(h.ex.jobView(ids[0]!).peerHalt, null);
  }
  const [peer, own] = await settleAll(h, ids);
  assert.deepEqual([own.status, own.legs[0]!.operation!.state, own.legs[0]!.filledQuantity, own.legs[1]!.filledQuantity], ['completed', 'canceled', '0.6', '0.6']);
  assert.deepEqual(ordersOf(h.bybit).map(order => order.request.quantity), ['1', '0.4', '0.2']);
  assert.deepEqual([peer.status, peer.legs[0]!.attempts, peer.legs[0]!.filledQuantity, peer.legs[1]!.filledQuantity, peer.peerHalt], ['completed', 1, '0.3', '0.3', own.leadDeviation]);
  await tick(h);
  assert.deepEqual([eventCount(h, 'four-leg-deviation'), eventCount(h, 'four-leg-halted'), eventCount(h, 'four-leg-unbalanced')], [1, 1, 1]);
  assert.equal(partialReads, 3, '核对两次相同的部分成交，再核对一次最终成交后即结清');
}));

for (const [planned, skipped] of [['0', null], ['invalid', '0.1']] as const) {
  test(`海力士四腿旧任务：已结束一所的计划为 ${planned} 时，另一所仍能结清并登记无法比较`, () => withHarness(async h => {
    const intent = hynixIntent();
    intent.legs[2]!.orderType = 'chase';
    h.bybit.inject({ operation: 'strategy-place', mode: 'partial', filled: '0' });
    const { ids } = await confirmFour(h, intent);
    const [finished] = await settleAll(h, [ids[0]!]);
    assert.equal(finished.status, 'completed');
    const row = h.store.db.prepare('SELECT json FROM jobs WHERE id = ?').get(ids[0]!)!;
    const historical = JSON.parse(row.json as string);
    historical.legs[0].quantity = planned;
    if (skipped) historical.leadSkipped = { 0: skipped };
    h.store.db.prepare('UPDATE jobs SET json = ? WHERE id = ?').run(JSON.stringify(historical), ids[0]!);
    const strategy = [...h.bybit.strategies.values()][0]!;
    h.bybit.fillStrategy(strategy.id, strategy.request.quantity);
    const [peer] = await settleAll(h, [ids[1]!]);
    assert.equal(peer.status, 'completed');
    assert.deepEqual(peer.events.filter(event => event.type === 'four-leg-unbalanced').flatMap(event => event.details), [
      `SKHY 计划或成交数量无效，无法比较两所成交：Binance 2.42 / ${planned}，Bybit 2.4 / 2.4`,
    ]);
    const listed = groupJobs(h.ex.recentJobs(1, 'hynix'))[0].jobs;
    assert.deepEqual(groupStatus(listed).details, peer.events.find(event => event.type === 'four-leg-unbalanced')!.details);
  }));
}

for (const field of ['计划', '成交', '跳过量'] as const) {
  test(`原油四腿旧任务：${field}损坏仍能结清健康对手、释放锁和读取整组`, () => withHarness(async h => {
    const intent = fourIntent();
    intent.legs[2].orderType = 'chase';
    h.bybit.inject({ operation: 'strategy-place', mode: 'partial', filled: '0' });
    const { ids } = await confirmFour(h, intent);
    const [archived] = await settleAll(h, [ids[0]]);
    assert.equal(archived.status, 'completed');
    if (field === '成交') {
      h.store.db.prepare("UPDATE operations SET json = json_set(json, '$.filledQuantity', 'broken') WHERE job_id = ? AND leg = 0").run(ids[0]);
    } else if (field === '计划') {
      h.store.db.prepare("UPDATE jobs SET json = json_set(json, '$.legs[0].quantity', 'broken') WHERE id = ?").run(ids[0]);
    } else {
      h.store.db.prepare("UPDATE jobs SET json = json_set(json, '$.leadSkipped', json(?)) WHERE id = ?").run(JSON.stringify({ 0: '0.03', 1: 'broken', 2: '-0.1' }), ids[0]);
    }
    const strategy = [...h.bybit.strategies.values()][0];
    h.bybit.fillStrategy(strategy.id, field === '跳过量' ? '0.5' : '1');
    if (field === '跳过量') h.advance(60_000);
    const [healthy] = await settleAll(h, [ids[1]], 5);
    assert.deepEqual([healthy.status, locks(h).length], ['completed', 0]);
    const group = groupJobs(h.ex.recentJobs(20, 'oil'))[0].jobs;
    const state = groupStatus(group);
    assert.deepEqual(state.details, healthy.events.find(event => event.type === 'four-leg-unbalanced')!.details);
    if (field === '跳过量') {
      assert.equal(h.ex.jobView(ids[0]).leadSkipped, '0.03');
      assert.equal(state.details.length, 2);
      assert.ok(state.details.every(line => line.includes('两所成交不等')));
    } else {
      assert.equal(state.details.length, 1);
      assert.match(state.details[0], /BZ 计划或成交数量无效，无法比较两所成交/);
      if (field === '成交') assert.equal(group[0].legs[0].averagePrice, null);
    }
  }));
}

for (const kind of ['IOC', '原生追价'] as const) {
  test(`四腿首笔${kind}应答即撤余：同一轮联动停止后处理的交易所，避免其发送首腿`, () => withHarness(async h => {
    const intent = fourIntent();
    if (kind === 'IOC') h.binance.inject({ operation: 'place', mode: 'partial', filled: '0.5' });
    else {
      intent.legs = [...intent.legs.slice(2), ...intent.legs.slice(0, 2)];
      intent.legs[0].orderType = 'chase';
      h.bybit.inject({ operation: 'strategy-place', mode: 'partial', filled: '0.5' });
      const place = h.bybit.placeChase.bind(h.bybit);
      h.bybit.placeChase = async (binding, request, options) => {
        const ack = await place(binding, request, options);
        await h.bybit.stopStrategy(binding, ack.strategyId, options);
        return ack;
      };
    }
    const { ids } = await confirmFour(h, intent);
    await tick(h);
    const why = `${kind === 'IOC' ? 'Binance' : 'Bybit'} 第 1 批首腿发出 1，成交 0.5`;
    const other = kind === 'IOC' ? h.bybit : h.binance;
    assert.deepEqual([h.ex.jobView(ids[0]).leadDeviation, h.ex.jobView(ids[1]).peerHalt, other.arrived.place], [why, why, 0]);
    const [own, peer] = await settleAll(h, ids);
    assert.deepEqual([own.status, own.legs[1].filledQuantity, peer.status, other.arrived.place], ['completed', '0.5', 'stopped', 0]);
    assert.deepEqual([eventCount(h, 'four-leg-deviation'), eventCount(h, 'four-leg-halted'), eventCount(h, 'four-leg-unbalanced')], [1, 1, 1]);
  }));
}

for (const peerSent of [true, false]) {
  test(`四腿旧写者只落盘了首腿终态：对方${peerSent ? '已发' : '未发'}时接管补记单笔偏离，继续对冲实际成交`, () => withHarness(async h => {
    const { ids } = await confirmFour(h);
    const leadId = leadOrderId(ids[0], 0);
    h.binance.inject({ operation: 'place', mode: 'partial', filled: '0.5', clientOrderId: leadId });
    const place = h.binance.place.bind(h.binance);
    h.binance.place = async (binding, request, options) => {
      const report = await place(binding, request, options);
      if (request.clientOrderId !== leadId) return report;
      if (!peerSent) h.bybit.inject({ operation: 'quote', mode: 'read-fail' });
      return { ...report, status: 'partially-filled', terminal: false };
    };
    await tick(h);
    assert.equal(h.ex.jobView(ids[0]).leadDeviation, null);
    // The old writer stored the venue's actual terminal report and stopped before its next progress pass.
    h.store.db.prepare("UPDATE operations SET state = 'canceled', settled = 1, json = json_set(json, '$.state', 'canceled', '$.venueStatus', 'canceled') WHERE client_order_id = ?").run(leadId);
    h.clock.now += 61_000; h.restart(); assert.equal(h.ex.acquire(), true);
    const [own, peer] = await settleAll(h, ids);
    const why = 'Binance 第 1 批首腿发出 1，成交 0.5';
    assert.deepEqual([own.leadDeviation, own.legs[1].filledQuantity, peer.peerHalt, peer.legs[1].filledQuantity], [why, '0.5', why, peerSent ? '1' : '0']);
    assert.equal(eventCount(h, 'four-leg-deviation'), 1);
  }));
}

test('四腿首腿核对到累计 0.6 撤余的同一轮对冲核对超时：先登记单笔偏离，再保留人工处理及锁', () => withHarness(async h => {
  const { ids } = await confirmFour(h);
  const leadId = leadOrderId(ids[0], 0);
  h.binance.inject({ operation: 'place', mode: 'partial', filled: '0.6', clientOrderId: leadId });
  const place = h.binance.place.bind(h.binance);
  h.binance.place = async (binding, request, options) => {
    const report = await place(binding, request, options);
    return request.clientOrderId === leadId ? { ...report, status: 'partially-filled', terminal: false, filledQuantity: '0.4' } : report;
  };
  await tick(h);
  h.binance.inject({ operation: 'query', mode: 'read-fail', clientOrderId: leadId });
  h.binance.inject({ operation: 'place', mode: 'lost-response' });
  h.bybit.inject({ operation: 'place', mode: 'lost-response' });
  await tick(h);
  const [own, peer] = ids.map(id => h.ex.jobView(id));
  assert.deepEqual([own.legs[0].filledQuantity, own.legs[1].operation!.state, own.leadDeviation], ['0.4', 'unknown', null]);
  h.binance.inject({ operation: 'query', mode: 'read-fail', clientOrderId: own.legs[1].operation!.clientOrderId, times: 2 });
  h.advance(190_000);
  await tick(h);
  const done = h.ex.jobView(own.id), why = 'Binance 第 1 批首腿发出 1，成交 0.6';
  assert.deepEqual([done.status, done.locked, done.legs[0].filledQuantity, done.leadDeviation, h.ex.jobView(peer.id).peerHalt], ['attention', true, '0.6', why, why]);
  assert.equal(h.ex.jobView(peer.id).legs[1].filledQuantity, '1');
  await tick(h);
  assert.deepEqual([eventCount(h, 'four-leg-deviation'), eventCount(h, 'four-leg-halted')], [1, 1]);
}));

test('接管旧四腿时在途任务的首腿终态数量损坏：该组保留人工处理与锁，另一组正常对冲完成', () => withHarness(async h => {
  const oil = await confirmFour(h);
  const hynix = await confirmFour(h, hynixIntent());
  await tick(h);
  h.store.db.prepare("UPDATE operations SET json = json_set(json, '$.filledQuantity', 'broken') WHERE job_id = ? AND leg = 0").run(oil.ids[0]);
  h.clock.now += 61_000;
  h.restart();
  assert.equal(h.ex.acquire(), true);
  const [damaged, peer] = await settleAll(h, oil.ids);
  assert.deepEqual([damaged.status, damaged.locked, damaged.legs[0].filledQuantity, damaged.legs[1].attempts], ['attention', true, '无效', 0]);
  assert.match(damaged.reason ?? '', /恢复.*首腿.*数量无效/);
  assert.match(peer.peerHalt ?? '', /Binance 任务需人工处理/);
  assert.deepEqual([peer.status, peer.legs[1].filledQuantity], ['completed', '1']);
  const healthy = await settleAll(h, hynix.ids);
  assert.deepEqual(healthy.map(job => [job.status, job.locked, job.legs[1].filledQuantity]), [['completed', false, '0.249'], ['completed', false, '0.24']]);
  assert.deepEqual(locks(h).map(item => item.job_id), [damaged.id, damaged.id]);
}));

for (const [damage, value, flag, restart] of [
  ['fill', '2', null, true], ['fill', '-1', 'peerHalt', true], ['fill', 'broken', 'leadDeviation', true],
  ['fill', '2', null, false], ['request', '0', null, true], ['request', '1e2', null, false],
  ['leadPlan', '0', null, true], ['hedgePlan', 'broken', 'peerHalt', false], ['leadStep', '0', 'leadDeviation', true], ['hedgeStep', 'broken', null, false],
] as const) {
  test(`四腿执行前核对原委托：${restart ? '接管' : '正常推进'}的 ${damage}=${value}，已有 ${flag ?? '无'} 标记也不能据此补单`, () => withHarness(async h => {
    const { ids } = await confirmFour(h);
    await tick(h);
    if (damage === 'fill' || damage === 'request') {
      const path = damage === 'fill' ? '$.filledQuantity' : '$.request.quantity';
      h.store.db.prepare('UPDATE operations SET json = json_set(json, ?, ?) WHERE job_id = ? AND leg = 0').run(path, value, ids[0]);
    } else {
      const path = `$.legs[${damage.startsWith('lead') ? 0 : 1}].${damage.endsWith('Plan') ? 'quantity' : 'instrument.quantityStep'}`;
      h.store.db.prepare('UPDATE jobs SET json = json_set(json, ?, ?) WHERE id = ?').run(path, value, ids[0]);
    }
    if (flag) h.store.db.prepare('UPDATE jobs SET json = json_set(json, ?, ?) WHERE id = ?').run(`$.${flag}`, '旧任务记录', ids[0]);
    if (restart) { h.clock.now += 61_000; h.restart(); assert.equal(h.ex.acquire(), true); }
    await tick(h);
    const [own, peer] = await settleAll(h, ids);
    assert.deepEqual([own.status, own.locked, own.legs[1].attempts, h.binance.arrived.place], ['attention', true, 0, 1]);
    assert.deepEqual([peer.status, peer.legs[1].filledQuantity], ['completed', '1']);
    if (damage === 'fill' || damage === 'request') {
      assert.equal(own.legs[0].filledQuantity, '无效');
      if (damage === 'fill') assert.equal(own.legs[0].operation!.filledQuantity, value);
      assert.ok(groupStatus(groupJobs(h.ex.recentJobs())[0].jobs).details.some(detail => detail.includes('无法比较')));
    }
  }));
}

test('四腿接管：两个子任务分别有过量的首腿与对冲回报，保留四把锁，独立市场照常完成', () => withHarness(async h => {
  const oil = await confirmFour(h);
  const hynix = await confirmFour(h, hynixIntent());
  await tick(h); await tick(h);
  h.store.db.prepare("UPDATE operations SET json = json_set(json, '$.filledQuantity', '2') WHERE job_id = ? AND leg = 0 OR job_id = ? AND leg = 1").run(oil.ids[0], oil.ids[1]);
  const counts = [h.binance.arrived.place, h.bybit.arrived.place];
  h.clock.now += 61_000; h.restart(); assert.equal(h.ex.acquire(), true);
  const bad = oil.ids.map(id => h.ex.jobView(id));
  assert.deepEqual(bad.map(job => [job.status, job.locked]), [['attention', true], ['attention', true]]);
  assert.deepEqual([bad[0].legs[0].filledQuantity, bad[1].legs[1].filledQuantity], ['无效', '无效']);
  assert.equal(groupStatus(groupJobs(h.ex.recentJobs(20, 'oil'))[0].jobs).details.filter(text => text.includes('无法比较')).length, 2);
  assert.deepEqual((await settleAll(h, hynix.ids)).map(job => job.status), ['completed', 'completed']);
  assert.deepEqual([h.binance.arrived.place, h.bybit.arrived.place], counts);
  assert.equal(locks(h).length, 4);
}));

for (const identity of ['已核实', '不符'] as const) {
  test(`四腿异常数量转人工：对冲限价单结果未知只查询，身份${identity}后按原单处理`, () => withHarness(async h => {
    const intent = fourIntent();
    Object.assign(intent.legs[1], { orderType: 'limit', limitPrice: '69.9' });
    const { ids } = await confirmFour(h, intent);
    await tick(h);
    h.binance.inject({ operation: 'place', mode: 'lost-response' });
    await tick(h);
    const hedge = h.ex.jobView(ids[0]).legs[1].operation!;
    assert.equal(hedge.state, 'unknown');
    h.store.db.prepare("UPDATE operations SET json = json_set(json, '$.filledQuantity', '2') WHERE job_id = ? AND leg = 0").run(ids[0]);
    if (identity === '不符') h.store.db.prepare("UPDATE operations SET json = json_set(json, '$.request.clientOrderId', 'foreign') WHERE job_id = ? AND leg = 1").run(ids[0]);
    h.binance.inject({ operation: 'query', mode: 'read-fail', clientOrderId: hedge.clientOrderId });
    h.clock.now += 61_000; h.restart(); assert.equal(h.ex.acquire(), true);
    await tick(h);
    assert.deepEqual([h.ex.jobView(ids[0]).status, h.binance.arrived.cancel, h.binance.arrived.place], ['attention', 0, 2]);
    await tick(h); await tick(h);
    const own = h.ex.jobView(ids[0]);
    assert.deepEqual([own.locked, h.binance.arrived.cancel, h.binance.orders.get(hedge.clientOrderId)!.status, h.binance.arrived.place],
      [true, identity === '已核实' ? 1 : 0, identity === '已核实' ? 'canceled' : 'new', 2]);
  }));
}

test('本地追价重挂的跨单实际成交才受批量上界约束；活动委托新回报触及旧数据损坏时停止补单', () => withHarness(async h => {
  const { ids } = await confirmFour(h, fourIntent({ binanceLead: 'local-chase' }));
  await tick(h);
  const first = leadOrderId(ids[0], 0), second = leadOrderId(ids[0], 1);
  h.binance.fillResting(first, '0.3');
  h.binance.setBook('BZUSDT', { bid: '74.05', ask: '74.07' });
  for (let pass = 0; pass < 10 && !h.binance.orders.has(second); pass++) await tick(h);
  assert.deepEqual([h.binance.orders.get(first)!.request.quantity, h.binance.orders.get(second)!.request.quantity], ['1', '0.7']);
  h.store.db.prepare("UPDATE operations SET json = json_set(json, '$.filledQuantity', '0.6') WHERE client_order_id = ?").run(first);
  h.binance.fillResting(second, '0.7');
  const before = h.binance.arrived.place;
  await tick(h);
  const own = h.ex.jobView(ids[0]);
  assert.deepEqual([own.status, own.locked, own.legs[0].filledQuantity, h.binance.arrived.place], ['attention', true, '无效', before]);
}));

for (const stop of ['预算', '人工确认'] as const) {
  test(`四腿损坏组仍有本地追价挂单：撤单未送达按${stop}结束，不补单`, () => withHarness(async h => {
    const { ids } = await confirmFour(h, fourIntent({ binanceLead: 'local-chase' }));
    await tick(h);
    const lead = leadOrderId(ids[0], 0);
    h.binance.fillResting(lead, '0.3');
    await tick(h);
    h.store.db.prepare("UPDATE operations SET json = json_set(json, '$.filledQuantity', '3') WHERE job_id = ? AND leg = 1").run(ids[0]);
    h.binance.inject({ operation: 'cancel', mode: 'not-sent', times: 10 });
    const before = h.binance.arrived.place;
    h.clock.now += 61_000; h.restart(); assert.equal(h.ex.acquire(), true);
    await tick(h);
    assert.deepEqual([h.ex.jobView(ids[0]).status, h.ex.jobView(ids[0]).locked, h.binance.calls.cancel], ['attention', true, 1]);
    if (stop === '人工确认') h.ex.acknowledge(ids[0], randomUUID(), SESSION);
    for (let n = 0; n < 4; n++) await tick(h);
    assert.equal(h.binance.calls.cancel, stop === '预算' ? 2 : 1);
    assert.equal(h.ex.jobView(ids[0]).locked, stop === '预算');
    assert.deepEqual([h.binance.orders.get(lead)!.status, h.binance.arrived.place], ['partially-filled', before]);
  }, { budgets: { cancelAttempts: 2, cancelRetryMs: 1_000 } }));
}

test('四腿损坏组的原生追价：仍在工作的原策略经身份核对后有界停止，不按坏计划发对冲', () => withHarness(async h => {
  const intent = fourIntent(); intent.legs[2].orderType = 'chase';
  h.bybit.inject({ operation: 'strategy-place', mode: 'partial', filled: '0.4' });
  const { ids } = await confirmFour(h, intent);
  await tick(h);
  h.store.db.prepare("UPDATE jobs SET json = json_set(json, '$.legs[1].quantity', '0') WHERE id = ?").run(ids[1]);
  h.clock.now += 61_000; h.restart(); assert.equal(h.ex.acquire(), true);
  await tick(h); await tick(h);
  const bad = h.ex.jobView(ids[1]);
  assert.deepEqual([bad.status, bad.locked, bad.legs[0].operation!.state, bad.legs[0].filledQuantity, bad.legs[1].attempts], ['attention', true, 'canceled', '0.4', 0]);
  assert.deepEqual([h.bybit.arrived['strategy-stop'], h.bybit.arrived.place], [1, 0]);
}));

test('本地追价已撤余且历史成交损坏：接管仍保留锁和原始回报，跳过量不能由坏成交推算', () => withHarness(async h => {
  const { ids } = await confirmFour(h, fourIntent({ binanceLead: 'local-chase' }));
  await tick(h);
  h.binance.fillResting(leadOrderId(ids[0], 0), '1');
  await tick(h);
  h.store.db.prepare("UPDATE operations SET json = json_set(json, '$.filledQuantity', 'broken') WHERE job_id = ? AND leg = 0").run(ids[0]);
  const before = h.binance.arrived.place;
  h.clock.now += 61_000; h.restart(); assert.equal(h.ex.acquire(), true);
  await tick(h);
  const bad = h.ex.jobView(ids[0]);
  assert.deepEqual([bad.status, bad.locked, bad.leadSkipped, bad.legs[0].filledQuantity, bad.legs[0].operation!.filledQuantity, h.binance.arrived.place], ['attention', true, null, '无效', 'broken', before]);
}));
