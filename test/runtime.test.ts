// The shared run loop with a stand-in executor: an orderly stop sends nothing new, lets a pass that is writing finish
// before the lease is handed back, and a process without the jobs pass still prunes history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExecutor } from '../src/runtime.ts';
import type { Executor } from '../src/executor.ts';
import type { Store } from '../src/store.ts';

function standIn(writeMs: number) {
  const events: string[] = [];
  let maintained = 0, writing: Promise<void> | null = null;
  const executor = {
    budgets: { leaseTtlMs: 60_000, positionsRefreshMs: 15_000 },
    retired: false,
    acquire: () => true,
    // The first transfer pass is a write that takes writeMs; later passes return at once.
    tickTransfers: () => {
      if (writing) return Promise.resolve();
      events.push('write-start');
      writing = new Promise(resolve => setTimeout(() => { events.push('write-done'); resolve(); }, writeMs));
      return writing;
    },
    tickAdl: async () => undefined,
    maintain: () => { maintained++; },
    refreshPositions: async () => undefined,
    stopSending: () => { events.push('stop-sending'); },
    close: () => { events.push('close'); },
  } as unknown as Executor;
  const store = { maintainWal: () => ({ walBytes: 0 }), close: () => { events.push('store-close'); } } as unknown as Store;
  return { executor, store, events, maintained: () => maintained };
}

async function stopDuringWrite(drainMs: number) {
  const dir = mkdtempSync(join(tmpdir(), 'tp-runtime-'));
  const { executor, store, events, maintained } = standIn(300);
  const lines: string[] = [];
  try {
    const run = runExecutor({ executor, store, dir, port: 0, passes: ['transfers', 'adl'], startedMessage: 'test', drainMs, log: line => lines.push(line) });
    for (let i = 0; i < 50 && !events.includes('write-start'); i++) await new Promise(resolve => setTimeout(resolve, 5));
    await run.shutdown();
    return { events, lines, maintained: maintained() };
  } finally {
    process.removeAllListeners('SIGINT'); process.removeAllListeners('SIGTERM');
    rmSync(dir, { recursive: true, force: true });
  }
}

test('运行循环：停止时先等进行中的写入完成再交还租约；没有两腿任务循环时也清理历史', async () => {
  const drained = await stopDuringWrite(5_000);
  assert.deepEqual(drained.events, ['write-start', 'stop-sending', 'write-done', 'close', 'store-close']);
  assert.ok(drained.maintained >= 1, '服务进程应运行历史清理');

  // Without draining (the prototype entry), the lease goes first and the write ends after it.
  const immediate = await stopDuringWrite(0);
  assert.deepEqual(immediate.events, ['write-start', 'close', 'write-done', 'store-close']);

  // A write that outlasts the drain limit is left to the next start, and the operator is told.
  const dir = mkdtempSync(join(tmpdir(), 'tp-runtime-'));
  const slow = standIn(400);
  const lines: string[] = [];
  try {
    const run = runExecutor({ executor: slow.executor, store: slow.store, dir, port: 0, passes: ['transfers'], startedMessage: 'test', drainMs: 100, log: line => lines.push(line) });
    for (let i = 0; i < 50 && !slow.events.includes('write-start'); i++) await new Promise(resolve => setTimeout(resolve, 5));
    await run.shutdown();
    assert.deepEqual(slow.events.slice(0, 3), ['write-start', 'stop-sending', 'close']);
    assert.ok(lines.some(line => /仍有循环未结束/.test(line)));
  } finally {
    process.removeAllListeners('SIGINT'); process.removeAllListeners('SIGTERM');
    rmSync(dir, { recursive: true, force: true });
  }
});
