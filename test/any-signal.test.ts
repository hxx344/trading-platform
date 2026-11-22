import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { anySignal } from '../src/any-signal.mjs';

const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('anySignal：先中止的来源决定原因，缺省来源跳过，已中止的来源立即生效', () => {
  const a = new AbortController(), b = new AbortController();
  const signal = anySignal([a.signal, undefined, b.signal, null]);
  assert.equal(signal.aborted, false);
  b.abort(new Error('b'));
  assert.equal(signal.aborted, true);
  assert.equal((signal.reason as Error).message, 'b');
  a.abort(new Error('a'));
  assert.equal((signal.reason as Error).message, 'b', '已中止的结果不再改写原因');
  const early = anySignal([a.signal, new AbortController().signal], 10);
  assert.equal(early.aborted, true);
  assert.equal((early.reason as Error).message, 'a');
});

test('anySignal：超时按 AbortSignal.timeout 的方式以 TimeoutError 中止，来源先中止时不再触发', async () => {
  const source = new AbortController();
  const timed = anySignal([source.signal], 10), alone = anySignal([undefined], 10);
  const stop = new AbortController(), early = anySignal([stop.signal], 10);
  stop.abort('stopped');
  await settle(30);
  for (const signal of [timed, alone]) {
    assert.equal(signal.aborted, true);
    assert.ok(signal.reason instanceof DOMException);
    assert.equal(signal.reason.name, 'TimeoutError');
  }
  assert.equal(early.reason, 'stopped');
  assert.equal(source.signal.aborted, false);
});

test('anySignal：长期来源只挂一个监听器，来源中止时转发给仍在等待的结果', () => {
  const stopped = new AbortController();
  const pending = Array.from({ length: 1000 }, () => anySignal([stopped.signal, new AbortController().signal]));
  for (let i = 0; i < 1000; i++) anySignal([stopped.signal], 60_000);
  assert.equal(getEventListeners(stopped.signal, 'abort').length, 1);
  stopped.abort('stop');
  assert.ok(pending.every(signal => signal.aborted && signal.reason === 'stop'));
});

test('anySignal：与长期信号反复组合时内存不随调用次数增长（Node 24.15 的 AbortSignal.any 会）', async () => {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  const stopped = new AbortController();
  const heap = async () => { await settle(50); gc(); await settle(10); gc(); return process.memoryUsage().heapUsed; };
  const round = () => { for (let i = 0; i < 30_000; i++) anySignal([stopped.signal], 5).addEventListener('abort', () => {}); };
  round();
  const before = await heap();
  for (let i = 0; i < 3; i++) round();
  const grown = (await heap()) - before;
  // AbortSignal.any keeps about 1.7 KB per such call: 90 000 calls would add ~150 MB.
  assert.ok(grown < 20 * 2 ** 20, `9 万次组合后堆增长 ${(grown / 2 ** 20).toFixed(1)} MiB`);
  assert.equal(getEventListeners(stopped.signal, 'abort').length, 1);
});

test('anySignal：带超时的结果只被自身监听器引用时，回收后仍能收到来源的中止', { timeout: 10_000 }, async () => {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  const stopped = new AbortController();
  let aborted = 0;
  const pending = Array.from({ length: 100 }, () => new Promise<void>(resolve => {
    anySignal([stopped.signal], 60_000).addEventListener('abort', () => { aborted++; resolve(); }, { once: true });
  }));
  for (let i = 0; i < 3; i++) { gc(); await settle(10); }
  stopped.abort('stop');
  await Promise.all(pending);
  assert.equal(aborted, 100);
});

test('anySignal：不带超时、请求结束时没有来源中止的组合，监听器移除并回收后不留在长期来源上', async () => {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  const stopped = new AbortController();
  const heap = async () => { for (let i = 0; i < 3; i++) { gc(); await settle(20); } return process.memoryUsage().heapUsed; };
  const round = () => {
    for (let i = 0; i < 30_000; i++) {
      // A finished request: its reader listened and stopped listening (fetch does so once the request is collected).
      const signal = anySignal([stopped.signal, new AbortController().signal]), listener = () => {};
      signal.addEventListener('abort', listener);
      signal.removeEventListener('abort', listener);
      anySignal([stopped.signal, anySignal([stopped.signal])]);
    }
  };
  round();
  const before = await heap();
  for (let i = 0; i < 3; i++) { round(); await heap(); }
  const grown = (await heap()) - before;
  // Holding these strongly keeps about 1.6 KB per combination: 90 000 rounds (270 000 calls) would add well over 100 MB.
  assert.ok(grown < 20 * 2 ** 20, `9 万轮组合后堆增长 ${(grown / 2 ** 20).toFixed(1)} MiB`);
  stopped.abort('stop');
});

test('anySignal：不带超时的结果只被等待中止的监听器引用时（Promise 只靠中止结束），回收后仍能收到中止', { timeout: 10_000 }, async () => {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  const stopped = new AbortController();
  // The signal, its listener, the promise and the suspended frame only reference each other, as with a fake fetch.
  const wait = async () => {
    const signal = anySignal([stopped.signal, new AbortController().signal]);
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  };
  const outcomes = Array.from({ length: 50 }, () => wait().catch((error: unknown) => error));
  for (let i = 0; i < 3; i++) { gc(); await settle(20); }
  stopped.abort('stop');
  assert.deepEqual(new Set(await Promise.all(outcomes)), new Set(['stop']));
});

test('anySignal：不带超时的结果只交给在途的 fetch、http.request 时，回收后仍能把来源的中止传过去', { timeout: 20_000 }, async () => {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  // Half the requests get headers and a body that never ends, half get nothing: both phases must keep the signal.
  let served = 0;
  const server = createServer((_req, res) => { if (served++ % 2) { res.writeHead(200); res.write('x'); } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  try {
    const stopped = new AbortController();
    const viaFetch = (index: number) => fetch(url + index, { signal: anySignal([stopped.signal, new AbortController().signal]) })
      .then(response => response.text());
    const viaHttp = (index: number) => new Promise<void>((resolve, reject) => {
      const req = request(url + index, { signal: anySignal([stopped.signal, new AbortController().signal]) },
        response => { response.on('error', reject); response.resume(); response.on('end', resolve); });
      req.on('error', reject); req.end();
    });
    const outcomes = Array.from({ length: 40 }, (_, i) => (i % 2 ? viaHttp(i) : viaFetch(i)).then(() => 'finished', (error: unknown) => error));
    while (served < 40) await settle(10);
    await settle(50);
    for (let i = 0; i < 3; i++) { gc(); await settle(20); }
    stopped.abort(new Error('stop'));
    const results = await Promise.all(outcomes);
    assert.equal(results.filter(result => result instanceof Error && (result.message === 'stop' || result.name === 'AbortError')).length, 40);
  } finally {
    server.closeAllConnections(); server.close();
  }
});

test('服务端代码不直接调用 AbortSignal.any（改用 src/any-signal.mjs）', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const offenders = globSync('src/**/*.{ts,mts,mjs,js}', { cwd: root })
    .filter(file => !['src/any-signal.mjs', 'src/any-signal.d.mts'].includes(file) && /AbortSignal\.any\s*\(/.test(readFileSync(`${root}/${file}`, 'utf8')));
  assert.deepEqual(offenders, []);
});
