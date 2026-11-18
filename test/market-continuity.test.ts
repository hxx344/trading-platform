import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { test } from 'node:test';
import { createExecutor } from '../src/executor.ts';
import { runExecutor } from '../src/runtime.ts';
import { createMarketClient } from '../src/market/ipc.ts';
import { useMarketBooks } from '../src/service/market-books.ts';
import { createSimulatedVenues, SIM_BINDINGS } from '../src/simulation.ts';
import { openStore } from '../src/store.ts';
import { bindAccounts, createHarness, openIntent, SESSION } from './harness.ts';

async function until<T>(what: string, read: () => T | null): Promise<T> {
  const deadline = performance.now() + 12_000;
  do { const value = read(); if (value !== null) return value; await pause(30); } while (performance.now() < deadline);
  throw new Error(what);
}

test('行情进程重启期间按原委托编号结清，在途签名、过期和未来报价均不能发出新单', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-market-test-'));
  const socket = process.platform === 'win32' ? `\\\\.\\pipe\\tp-market-${randomUUID()}` : join(dir, 'market.sock');
  let child: ChildProcess | null = null;
  async function startMarket(mode: string) {
    child = fork(new URL('./fixtures/market-venue.ts', import.meta.url), [socket, mode], { execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const [reply] = await once(child, 'message', { signal: AbortSignal.timeout(6000) });
    assert.equal(reply, 'ready');
    return child.pid!;
  }
  async function killMarket() {
    if (!child) return;
    const exited = once(child, 'exit');
    child.kill('SIGKILL'); await exited; child = null;
    // systemd removes the service's RuntimeDirectory between instances on Linux.
    if (process.platform !== 'win32') { try { unlinkSync(socket); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } }
  }
  async function setTime(offset: number) {
    const reply = once(child!, 'message', { signal: AbortSignal.timeout(5000) });
    child!.send(offset); assert.equal((await reply)[0], 'changed');
  }
  const client = createMarketClient(socket);
  const store = openStore(join(dir, 'execution.sqlite'));
  const { binance, bybit } = createSimulatedVenues(Date.now);
  for (const connector of [binance, bybit]) useMarketBooks(connector, client);
  const ex = createExecutor({ store, connectors: [binance, bybit] });
  assert.ok(ex.acquire()); for (const binding of SIM_BINDINGS) ex.registerAccount(binding);
  const generation = ex.generation;
  const run = runExecutor({ executor: ex, store, dir, port: 0, startedMessage: '模拟执行器', log: () => {} });
  // Delay a priced POST after the executor read both fresh books but before the matching engine sees beforeSend.
  let unblock!: () => void, entered = false;
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  const place = binance.place.bind(binance);
  binance.place = async (...args) => {
    if (args[1].symbol === 'BZUSDT') { entered = true; await blocked; }
    return place(...args);
  };
  try {
    const oldPid = await startMarket('live');
    const oldEpoch = await until('第一次行情连接未建立', () => client.epoch());
    const rest = await ex.preview(openIntent({ orderType: 'limit', limitPrice: '70', timeoutMs: 60_000 }), SESSION);
    const resting = ex.confirm({ previewId: rest.id, requestId: randomUUID(), confirmLive: true }, SESSION).job;
    const original = await until('首腿未挂出', () => ex.jobView(resting.id).legs[0].operation?.state === 'open' ? ex.jobView(resting.id).legs[0].operation! : null);
    const other = { ...openIntent(), symbol: 'BZUSDT' };
    const pending = await ex.preview(other, SESSION);
    const held = ex.confirm({ previewId: pending.id, requestId: randomUUID(), confirmLive: true }, SESSION).job;
    await until('未到达发送前守卫', () => entered ? true : null);
    await killMarket();
    await until('旧行情代次未失效', () => client.epoch() === null ? true : null);
    unblock();
    binance.fillResting(original.clientOrderId, '1');
    const final = await until('断行情后原单未结清', () => ex.jobView(resting.id).status === 'completed' ? ex.jobView(resting.id) : null);
    const noSend = await until('旧代次仍可能发送', () => ex.jobView(held.id).legs[0].operation?.state === 'not-sent' ? ex.jobView(held.id) : null);
    assert.equal(final.legs[0].operation?.clientOrderId, original.clientOrderId);
    assert.match(noSend.legs[0].operation!.note ?? '', /行情连接已切换/);
    assert.equal(ex.generation, generation);
    assert.deepEqual([binance.arrived.place, bybit.arrived.place], [1, 1]);
    const newPid = await startMarket('stale');
    const newEpoch = await until('新行情代次未建立', () => client.epoch());
    assert.notEqual(newPid, oldPid); assert.notEqual(newEpoch, oldEpoch);
    const closing = openIntent({ action: 'close' });
    await assert.rejects(ex.preview(closing, SESSION), /盘口已过期/);
    await setTime(60_000);
    await assert.rejects(ex.preview(closing, SESSION), /盘口时间超前/);
    assert.deepEqual([binance.arrived.place, bybit.arrived.place], [1, 1]);
    await setTime(0);
    const fresh = await ex.preview(closing, SESSION);
    const resumed = ex.confirm({ previewId: fresh.id, requestId: randomUUID(), confirmLive: true }, SESSION).job;
    await until('新鲜盘口恢复后未完成', () => ex.jobView(resumed.id).status === 'completed' ? true : null);
    assert.deepEqual([binance.arrived.place, bybit.arrived.place], [2, 2]);
  } finally {
    unblock(); client.close(); await killMarket(); await run.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('两腿盘口在签名等待中过期，即使连接正常也不能发送首腿', async () => {
  const h = createHarness();
  try {
    bindAccounts(h.ex);
    const book = await h.ex.preview(openIntent(), SESSION);
    const { job } = h.ex.confirm({ previewId: book.id, requestId: randomUUID(), confirmLive: true }, SESSION);
    const place = h.binance.place.bind(h.binance);
    h.binance.place = (...args) => { h.advance(h.ex.budgets.sendQuoteMaxAgeMs + 1); return place(...args); };
    await h.ex.tickJobs();
    const op = h.ex.jobView(job.id).legs[0].operation;
    assert.equal(op?.state, 'not-sent');
    assert.match(op?.note ?? '', /过期/);
    assert.deepEqual([h.binance.arrived.place, h.bybit.arrived.place], [0, 0]);
  } finally { h.dispose(); }
});
