// O6 four legs (docs/oil.md 11): one preview of two same-exchange plans, one confirm that creates both jobs and their four
// locks or nothing, the stop of either job stopping both, and the other job's linked halt when one ends without completing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ContractError, parseFourLegIntent } from '../src/contracts.ts';
import { SIM_ACCOUNTS } from '../src/simulation.ts';
import type { SimulatedVenue } from '../src/sim-venue.ts';
import { describeJob, type JobSummary } from '../src/service/feishu.ts';
import { SESSION, bindAccounts, createHarness, previewAndConfirm, type Harness } from './harness.ts';

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
async function withHarness(run: (h: Harness) => Promise<void>) {
  const h = createHarness();
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
const locks = (h: Harness) => (h.store.db.prepare('SELECT resource, job_id FROM locks ORDER BY resource').all() as { resource: string; job_id: string }[]);
const jobCount = (h: Harness) => (h.store.db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n;
const pos = (venue: SimulatedVenue, symbol: string, side: Side) => venue.position(SIM_ACCOUNTS[venue.venue as 'binance' | 'bybit'], symbol, side);
const ordersOf = (venue: SimulatedVenue) => [...venue.orders.values()];

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

test('四腿停止：停止任一个子任务同时停止另一个；同一请求编号重放不报错', () => withHarness(async h => {
  const { ids } = await confirmFour(h);
  const stopId = randomUUID();
  const view = h.ex.requestStop(ids[1]!, stopId, SESSION);
  assert.equal(view.stopRequested, true);
  assert.equal(h.ex.jobView(ids[0]!).stopRequested, true);
  assert.equal(h.ex.requestStop(ids[1]!, stopId, SESSION).stopRequested, true);
  const views = await settleAll(h, ids);
  assert.deepEqual(views.map(item => [item.status, item.reason]), [['stopped', '已停止，未发送任何委托'], ['stopped', '已停止，未发送任何委托']]);
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
