import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MarketClient } from '../src/market/ipc.ts';
import { createOptionsClient } from '../src/options/client.ts';
import { iocOrder } from '../src/options/orders.ts';

test('期权新单在真正发出前仍须持有同一代新鲜行情，订单与撤单使用私有客户端', async () => {
  let epoch: string | null = 'first', now = 1_800_000_000_000, source = now;
  const symbol = 'BTC-20NOV26-80000-C', requests: string[] = [];
  const market: MarketClient = {
    epoch: () => epoch, stream: () => { throw new Error('unexpected stream'); },
    async call<T>(op: string) {
      assert.equal(op, 'options.ticker');
      return { value: { symbol, bid1Price: '10', ask1Price: '11' }, receivedAt: now, sourceAt: source } as T;
    },
  };
  const client = createOptionsClient({ credentials: { apiKey: 'test-option', apiSecret: 'synthetic-test-secret' }, now: () => now, marketClient: market,
    fetchImpl: async url => {
      requests.push(new URL(url).pathname);
      return Response.json({ retCode: 0, result: { list: [], orderId: '123' } });
    } });
  const spec = { symbol, side: 'Buy' as const, qty: '1', link: 'test-link', tick: '1', reduceOnly: false };
  for (const invalidate of [() => { epoch = 'replacement'; }, () => { now += 30_001; }]) {
    source = now;
    const result = await iocOrder(client, spec, { checkStop() {}, checkPrice: invalidate, record() {}, log() {}, sleep: async () => {} });
    assert.equal(result.status, 'not_submitted');
    assert.match(result.message ?? '', /过期|切换/);
  }
  assert.deepEqual(requests, []);
  epoch = null;
  assert.equal(await client.order(symbol, spec.link, AbortSignal.timeout(1000)), null);
  await client.cancel(symbol, spec.link, AbortSignal.timeout(1000));
  assert.deepEqual(requests, ['/v5/order/realtime', '/v5/order/history', '/v5/order/cancel']);
});
