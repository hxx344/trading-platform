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

test('Bybit 调时重试前即使单合约报价仍新，组合风险或停止状态不允许也不会发送第二个 POST', async () => {
  for (const refusal of ['新的组合保证金超预算', '任务已停止']) {
    const now = Date.now(), symbol = 'BTC-20NOV26-80000-C';
    let sends = 0, resynced = false;
    const market: MarketClient = { epoch: () => 'one', stream: () => () => {}, call: async <T>() => ({
      value: { symbol, bid1Price: '10', ask1Price: '11' }, receivedAt: now, sourceAt: now,
    }) as T };
    const client = createOptionsClient({ marketClient: market, now: () => now, credentials: { apiKey: 'demo', apiSecret: 'test-only-secret' },
      fetchImpl: async url => {
        if (new URL(url).pathname === '/v5/market/time') {
          resynced = true; return Response.json({ retCode: 0, result: { timeNano: String(BigInt(now) * 1_000_000n) } });
        }
        sends++; return Response.json({ retCode: 10002, retMsg: 'timestamp', result: {} });
      } });
    const result = await iocOrder(client, { symbol, side: 'Buy', qty: '1', link: 'retry-test', tick: '1', reduceOnly: false }, {
      checkStop() { if (resynced && refusal === '任务已停止') throw new Error(refusal); },
      checkPrice() { if (resynced && refusal !== '任务已停止') throw new Error(refusal); },
      record() {}, log() {}, sleep: async () => {},
    });
    assert.equal(sends, 1);
    assert.equal(result.status, 'not_submitted');
    assert.match(result.message ?? '', new RegExp(refusal));
  }
});
