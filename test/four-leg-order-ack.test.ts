import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createExecutor } from '../src/executor.ts';
import { createBybitConnector } from '../src/live/bybit.ts';
import { createOkxConnector, toClOrdId } from '../src/live/okx.ts';
import { openStore } from '../src/store.ts';
import { SESSION } from './harness.ts';
import { FakeBybit, KEY, SECRET, binding as bybitBinding, fail as bybitFail, instrumentRow, ok as bybitOk } from './live-fake-bybit.ts';
import { CREDENTIALS, FakeOkx, binding as okxBinding, fail as okxFail, ok as okxOk } from './live-fake-okx.ts';

const OKX_CREATE = 'POST /api/v5/trade/order', OKX_QUERY = 'GET /api/v5/trade/order', OKX_CANCEL = 'POST /api/v5/trade/cancel-order';
const BYBIT_CREATE = 'POST /v5/order/create', BYBIT_QUERY = 'GET /v5/order/realtime';

/** An oil four-leg group driven through the two production connectors, with all HTTP served by the venues below. */
async function fourLeg(t: TestContext, first: 'okx' | 'bybit', firstBybitLookup: (venue: FakeBybit) => Response = () => bybitFail(10016, 'server error', 500)) {
  const okx = new FakeOkx(), bybit = new FakeBybit();
  okx.fill = 'rest';
  bybit.instruments.push(instrumentRow({ symbol: 'BZUSDT', baseCoin: 'BZ' }));
  bybit.script(BYBIT_CREATE, call => {
    const receipt = bybit.create(call.body!);
    Object.assign(bybit.orders.at(-1)!, { orderStatus: 'Created', cumExecQty: '0', avgPrice: '' });
    bybit.script(BYBIT_QUERY, () => firstBybitLookup(bybit));
    return receipt;
  });
  const now = () => okx.clock;
  const connectors = [
    createOkxConnector({ credentials: () => CREDENTIALS, now, fetchImpl: okx.fetch }),
    createBybitConnector({ credentials: () => ({ apiKey: KEY, apiSecret: SECRET }), now, fetchImpl: bybit.fetch }),
  ];
  const dir = mkdtempSync(join(tmpdir(), 'four-leg-ack-')), store = openStore(join(dir, 'executor.sqlite'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const ex = createExecutor({ store, environment: 'mainnet', connectors, now });
  assert.ok(ex.acquire());
  ex.registerAccount(okxBinding()); ex.registerAccount(bybitBinding());
  const okxLegs = [
    { venue: 'okx', symbol: 'CLUSDT', side: 'long', barrels: '2', orderType: 'local-chase' },
    { venue: 'okx', symbol: 'BZUSDT', side: 'short', barrels: '2', orderType: 'market' },
  ];
  const bybitLegs = [
    { venue: 'bybit', symbol: 'CLUSDT', side: 'short', barrels: '2', orderType: 'limit', limitPrice: '70.12' },
    { venue: 'bybit', symbol: 'BZUSDT', side: 'long', barrels: '2', orderType: 'market' },
  ];
  const legs = first === 'okx' ? [...okxLegs, ...bybitLegs] : [...bybitLegs, ...okxLegs];
  const preview = await ex.previewFourLeg({ market: 'oil', preset: 'four-leg', action: 'open', timeoutMs: 60_000, legs }, SESSION);
  const { jobs } = ex.confirmFourLeg({ previewId: preview.id, requestId: randomUUID(), confirmLive: true }, SESSION);
  const tick = async (ms = 100) => { okx.clock += ms; bybit.clock = okx.clock; await ex.tickJobs(); };
  return { okx, bybit, ex, store, tick, firstId: jobs[0].id, lead: () => ex.jobView(jobs[0].id).legs[0].operation! };
}

/** Only the next book read is stale. The peer's own checks later in the same scheduler pass see fresh books. */
function staleBybitBook(bybit: FakeBybit): void {
  bybit.script('GET /v5/market/orderbook', call => bybitOk({
    s: call.params.get('symbol'), b: [['70.10', '31']], a: [['70.12', '12.5']], ts: bybit.clock - 60_000,
  }));
}

test('四腿 OKX 只挂单回执后查无，再查到零成交过期，两所重新取价才发首单或重挂', async t => {
  const { okx, bybit, ex, store, firstId, tick, lead } = await fourLeg(t, 'okx');
  okx.crossPostOnly = true;
  okx.script(OKX_QUERY, () => okxFail('51603', 'Order does not exist'), () => okxFail('50001', 'busy', 503));
  await tick();
  const create = okx.last(OKX_CREATE).body!, row = okx.orders.get(create.clOrdId as string)!;
  assert.deepEqual([create.ordType, lead().state, lead().remoteId, toClOrdId(lead().clientOrderId)], ['post_only', 'open', row.ordId, create.clOrdId]);
  assert.equal(bybit.count(BYBIT_CREATE), 0, '单有 OKX 订单编号时 Bybit 首单等待');

  // An older executor persisted the same unverified ACK as new and observedResting.
  store.db.prepare(`UPDATE operations SET json = json_set(json_remove(json, '$.verifiedWorking'),
    '$.venueStatus', 'new', '$.observedResting', json('true')) WHERE job_id = ? AND leg = 0`).run(firstId);
  await tick();
  assert.deepEqual([okx.count(OKX_CREATE), bybit.count(BYBIT_CREATE), lead().state, lead().remoteId], [1, 0, 'open', row.ordId]);

  staleBybitBook(bybit);
  await tick();
  assert.deepEqual([lead().state, lead().filledQuantity, okx.count(OKX_CREATE), bybit.count(BYBIT_CREATE)], ['canceled', '0', 1, 0]);
  assert.match(ex.jobView(firstId).reason ?? '', /Bybit.*盘口已过期/);
  assert.deepEqual(okx.calls.filter(call => call.method === 'GET' && call.path === '/api/v5/trade/order')
    .map(call => [call.params.get('ordId'), call.params.has('clOrdId')]), Array(3).fill([row.ordId, false]));

  okx.script('GET /api/v5/market/books', () => okxOk([{ bids: [['70.10', '31']], asks: [['70.12', '12.5']], ts: String(okx.clock - 60_000) }]));
  await tick();
  assert.deepEqual([okx.count(OKX_CREATE), bybit.count(BYBIT_CREATE)], [1, 0]);
  assert.match(ex.jobView(firstId).reason ?? '', /OKX.*盘口已过期/);

  okx.crossPostOnly = false;
  await tick();
  assert.deepEqual([okx.count(OKX_CREATE), bybit.count(BYBIT_CREATE)], [2, 1]);
  assert.notEqual(okx.last(OKX_CREATE).body!.clOrdId, create.clOrdId);
});

test('四腿 OKX 按原编号核实挂单后 Bybit 放行，随后可按原编号撤单，另一所行情过期时仍可改价重挂', async t => {
  const { okx, bybit, tick, lead } = await fourLeg(t, 'okx');
  okx.script(OKX_QUERY, () => okxFail('50001', 'busy', 503));
  await tick();
  const original = okx.last(OKX_CREATE).body!, row = okx.orders.get(original.clOrdId as string)!;
  assert.deepEqual([okx.count(OKX_CREATE), bybit.count(BYBIT_CREATE), lead().remoteId], [1, 0, row.ordId]);
  okx.script(OKX_QUERY, () => okxOk([{ ...row, ordId: '80000001' }]));
  await tick();
  assert.deepEqual([okx.count(OKX_CREATE), bybit.count(BYBIT_CREATE), lead().remoteId], [1, 0, row.ordId], '同一客户编号下的另一个交易所编号不能解锁');
  await tick();
  assert.deepEqual([okx.last(OKX_QUERY).params.get('ordId'), okx.last(OKX_QUERY).params.has('clOrdId')], [row.ordId, false]);
  assert.deepEqual([okx.count(OKX_CREATE), bybit.count(BYBIT_CREATE), lead().state, lead().filledQuantity], [1, 1, 'open', '0']);

  okx.book = { bid: '70.15', ask: '70.17' };
  await tick(2_000);
  assert.deepEqual([okx.count(OKX_CANCEL), okx.count(OKX_CREATE), lead().state], [1, 1, 'canceled']);
  assert.deepEqual(okx.last(OKX_CANCEL).body, { instId: row.instId, ordId: row.ordId });
  assert.equal(bybit.orders[0].orderStatus, 'Created');
  staleBybitBook(bybit);
  await tick();
  const repost = okx.last(OKX_CREATE).body!;
  assert.deepEqual([okx.count(OKX_CREATE), bybit.count(BYBIT_CREATE), repost.ordType, repost.px, okx.overlaps], [2, 1, 'post_only', '70.15', 0]);
  assert.notEqual(repost.clOrdId, original.clOrdId);
});

test('四腿 Bybit 限价单仅获编号或查到 Created 时 OKX 等待，同一单变为 New 后 OKX 才发首单', async t => {
  const { okx, bybit, ex, firstId, tick, lead } = await fourLeg(t, 'bybit');
  await tick();
  const order = bybit.orders[0], id = order.orderLinkId;
  assert.deepEqual([bybit.count(BYBIT_CREATE), bybit.last(BYBIT_CREATE).body!.timeInForce, okx.count(OKX_CREATE)], [1, 'GTC', 0]);
  assert.deepEqual([lead().state, lead().clientOrderId, lead().remoteId], ['open', id, order.orderId]);
  await tick();
  assert.deepEqual([bybit.last(BYBIT_QUERY).params.get('orderId'), bybit.last(BYBIT_QUERY).params.has('orderLinkId')], [order.orderId, false]);
  assert.deepEqual([order.orderStatus, bybit.count(BYBIT_CREATE), okx.count(OKX_CREATE)], ['Created', 1, 0]);
  order.orderStatus = 'New';
  await tick();
  assert.deepEqual([bybit.count(BYBIT_CREATE), okx.count(OKX_CREATE), lead().filledQuantity], [1, 1, '0']);
  ex.requestStop(firstId, randomUUID(), SESSION);
  await tick();
  assert.deepEqual(bybit.last('POST /v5/order/cancel').body, { symbol: order.symbol, category: 'linear', orderId: order.orderId });
  assert.deepEqual([lead().remoteId, lead().state], [order.orderId, 'canceled']);
});

test('四腿 OKX 首查前已保存 ordId，连续查到同客户号的另一单挂单和成交都不放行，停止只撤原单', async t => {
  const { okx, bybit, ex, firstId, tick, lead } = await fourLeg(t, 'okx');
  const otherId = '80000001';
  let savedAtFirstRead: string | null = null;
  okx.script(OKX_QUERY, () => {
    savedAtFirstRead = lead().remoteId;
    const original = [...okx.orders.values()][0];
    return okxOk([{ ...original, ordId: otherId }]);
  });
  await tick();
  const original = [...okx.orders.values()][0];
  const other = { ...original, ordId: otherId, state: 'live' };
  assert.equal(savedAtFirstRead, original.ordId);
  assert.deepEqual([lead().remoteId, lead().state, lead().filledQuantity, bybit.count(BYBIT_CREATE)], [original.ordId, 'open', '0', 0]);
  okx.script(OKX_QUERY, () => okxOk([{ ...other, state: 'filled', accFillSz: original.sz, avgPx: '70.11' }]));
  await tick();
  assert.deepEqual([lead().remoteId, lead().filledQuantity, okx.count(OKX_CREATE), bybit.count(BYBIT_CREATE)], [original.ordId, '0', 1, 0]);
  const lookups = okx.calls.filter(call => call.method === 'GET' && call.path === '/api/v5/trade/order');
  assert.deepEqual(lookups.map(call => [call.params.get('ordId'), call.params.has('clOrdId')]), Array(2).fill([original.ordId, false]));

  // The client ID now resolves to the other open order. Only the venue ID can cancel the original.
  okx.orders.set(original.ordId as string, original);
  okx.orders.set(original.clOrdId as string, other);
  ex.requestStop(firstId, randomUUID(), SESSION);
  await tick();
  assert.deepEqual(okx.last(OKX_CANCEL).body, { instId: original.instId, ordId: original.ordId });
  assert.deepEqual([original.state, other.state, lead().remoteId, lead().state, bybit.count(BYBIT_CREATE)], ['canceled', 'live', original.ordId, 'canceled', 0]);
});

test('四腿 Bybit 首查前已保存 orderId，连续查到其他编号的成交和挂单都不计入，撤单按原编号送达', async t => {
  const otherId = '0000-99';
  let savedAtFirstRead: string | null = null;
  const h = await fourLeg(t, 'bybit', venue => {
    savedAtFirstRead = h.lead().remoteId;
    const original = venue.orders[0];
    return bybitOk({ category: 'linear', list: [{ ...original, orderId: otherId, orderStatus: 'Filled', cumExecQty: original.qty, avgPrice: '70.11' }], nextPageCursor: '' });
  });
  const { okx, bybit, ex, firstId, tick, lead } = h;
  await tick();
  const original = bybit.orders[0], other = { ...original, orderId: otherId, orderStatus: 'New' };
  assert.equal(savedAtFirstRead, original.orderId);
  assert.deepEqual([lead().remoteId, lead().state, lead().filledQuantity, okx.count(OKX_CREATE)], [original.orderId, 'open', '0', 0]);
  bybit.script(BYBIT_QUERY, () => bybitOk({ category: 'linear', list: [other], nextPageCursor: '' }));
  await tick();
  assert.deepEqual([lead().remoteId, lead().filledQuantity, bybit.count(BYBIT_CREATE), okx.count(OKX_CREATE)], [original.orderId, '0', 1, 0]);
  const lookups = bybit.calls.filter(call => call.path === '/v5/order/realtime' && (call.params.has('orderId') || call.params.has('orderLinkId')));
  assert.deepEqual(lookups.map(call => [call.params.get('orderId'), call.params.has('orderLinkId')]), Array(2).fill([original.orderId, false]));

  original.orderStatus = 'New';
  bybit.orders.push(other);
  ex.requestStop(firstId, randomUUID(), SESSION);
  await tick();
  assert.deepEqual(bybit.last('POST /v5/order/cancel').body, { symbol: original.symbol, category: 'linear', orderId: original.orderId });
  assert.deepEqual([original.orderStatus, other.orderStatus, lead().remoteId, lead().state, okx.count(OKX_CREATE)], ['Cancelled', 'New', original.orderId, 'canceled', 0]);
});
