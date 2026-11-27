import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getEventListeners, once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMarketClient, MarketError } from '../src/market/ipc.ts';
import { createMarketServer } from '../src/market/server.ts';

test('上游忽略取消时行情 RPC 仍在服务端截止，随后释放名额', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-market-rpc-')), socket = process.platform === 'win32' ? `\\\\.\\pipe\\rpc-${randomUUID()}` : join(dir, 'rpc.sock');
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const service = createMarketServer({ test: { async call(op) {
    if (op === 'test.fast') return 'ok';
    entered(); return new Promise(() => {});
  }, stream() {} } }, 'fixture', { maxCalls: 1, callTimeoutMs: 600 });
  service.server.listen(socket); await once(service.server, 'listening');
  const client = createMarketClient(socket);
  try {
    const slow = assert.rejects(client.call('test.slow', {}), error => error instanceof MarketError && error.status === 503);
    await started;
    await assert.rejects(client.call('test.fast', {}), error => error instanceof MarketError && error.status === 429);
    await slow;
    assert.equal(await client.call('test.fast', {}), 'ok');
  } finally { client.close(); service.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('多次行情 RPC 调用完成后不残留 caller 取消监听器', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-market-listeners-'));
  const socket = process.platform === 'win32' ? `\\\\.\\pipe\\rpc-clean-${randomUUID()}` : join(dir, 'rpc.sock');
  const service = createMarketServer({ test: { async call(op) { if (op === 'test.fast') return 'ok'; return 'unknown'; }, stream() {} } }, 'fixture', { maxCalls: 4, callTimeoutMs: 600 });
  service.server.listen(socket); await once(service.server, 'listening');
  const client = createMarketClient(socket);
  const caller = new AbortController();
  try {
    for (let i = 0; i < 20; i++) {
      assert.equal(await client.call('test.fast', {}, caller.signal), 'ok');
      assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
    }
    const preAborted = new AbortController();
    preAborted.abort(new Error('already'));
    await assert.rejects(client.call('test.fast', {}, preAborted.signal));
    assert.equal(getEventListeners(preAborted.signal, 'abort').length, 0);
  } finally { client.close(); service.close(); rmSync(dir, { recursive: true, force: true }); }
});
