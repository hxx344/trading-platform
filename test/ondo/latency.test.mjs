import test from 'node:test';
import assert from 'node:assert/strict';
import { createOndoLatency } from '../../src/vendor/ondo/latency.mjs';

test('latency quantiles and signed ages use the bounded session window and freeze when stopped', () => {
  const market = 'NVDA-USD.P', epoch = 1_800_000_000_000;
  let mono = 0, wall = epoch;
  const stats = createOndoLatency({ markets: [market, 'TSLA-USD.P'], mode: 'observe', startedAt: wall, now: () => wall, monotonicNow: () => mono });
  assert.equal(stats.snapshot().markets[0].bboAge.p95Ms, null);
  for (let i = 0; i < 1100; i++) {
    mono++; wall++;
    stats.book(market, wall - (i - 100), stats.stamp());
  }
  let marketRow = stats.snapshot().markets[0];
  // The bounded ring contains signed ages -24 .. 999. Quantiles use nearest rank.
  assert.deepEqual([marketRow.bboAge.n, marketRow.bboAge.p50Ms, marketRow.bboAge.p95Ms, marketRow.clockAheadN], [1024, 487, 948, 24]);
  assert.equal(stats.snapshot().markets[1].bboAge.n, 0);
  mono += 300_001; wall -= 60_000;
  marketRow = stats.snapshot().markets[0];
  assert.equal(marketRow.bboAge.lastAt, null); assert.equal(marketRow.clockAheadN, 0);
  stats.down(); stats.book(market, wall, stats.stamp());
  const frozen = stats.snapshot(true);
  assert.deepEqual([frozen.markets[0].bboAge.lastMs, frozen.markets[0].bookInterval.n, frozen.stoppedAt], [0, 0, wall]);
  mono += 600_000; stats.book(market, wall + 200, stats.stamp());
  assert.deepEqual(stats.snapshot(), frozen);
});

test('protective withdrawal includes retry backoff and never splices a span across a disconnect', () => {
  let ms = 0;
  const name = 'NVDA-USD.P', stats = createOndoLatency({ markets: [name], mode: 'live', prefix: 'tpo-test-', startedAt: 0, now: () => ms, monotonicNow: () => ms });
  const order = { role: 'quote', clientId: 'tpo-test-1', side: 'buy', cancelFailures: 0 };
  const refused = stats.cancel(name, order, 'unprotected');
  ms = 10; order.cancelFailures++; refused();
  ms = 1010; const retry = stats.cancel(name, order, 'too_close');
  ms = 1030; retry({ status: 'canceled', filled: '0' });
  const before = stats.snapshot().markets[0].withdraw;
  assert.deepEqual([before.n, before.lastMs, before.failed], [1, 1030, 1]);
  const next = { ...order, clientId: 'tpo-test-2', cancelFailures: 0 };
  stats.cancel(name, next, 'unprotected')(); next.cancelFailures++;
  stats.down(); ms += 2000;
  stats.cancel(name, next, 'unprotected')({ status: 'canceled', filled: '0' });
  assert.equal(stats.snapshot().markets[0].withdraw.n, 1);
});
