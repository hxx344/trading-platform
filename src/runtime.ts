// The run loop shared by the prototype entry and the ASTER service: lease heartbeat, WAL upkeep, the three passes on
// their own schedules, the position reads, the loopback page and an orderly shutdown.
import { randomBytes } from 'node:crypto';
import { WAL_SIZE_LIMIT_BYTES, type Store } from './store.ts';
import type { Executor } from './executor.ts';
import { createExecutorServer } from './http.ts';
import { writeAccessUrl } from './data-dir.ts';

const TICK_MS = 1_000;
const WAL_CHECK_MS = 1_000;
/** Consecutive failed passes before the entry gives up the lease and exits, so another instance can take over. */
const MAX_TICK_FAILURES = 5;

export interface RunContext {
  /** True once shutdown has begun or the lease is gone. */
  stopped(): boolean;
  /** A wait that shutdown cuts short. */
  pause(ms: number): Promise<void>;
}

export interface RunOptions {
  executor: Executor;
  store: Store;
  dir: string;
  port: number;
  page?: string;
  /** Which passes run; the service has no two-leg jobs. */
  passes?: readonly ('jobs' | 'transfers' | 'adl')[];
  startedMessage: string;
  /** Extra loops started after the server; each must end soon after `stopped()` turns true. */
  background?: (context: RunContext) => Promise<void>[];
  /** Why the run is ending, before anything is closed: 'signal', 'lease-lost', 'pass-failed', 'listen-failed'. */
  onStopping?: (reason: string, detail: string) => void;
  /** Runs after the executor is closed and before the store is. */
  onStopped?: () => Promise<void> | void;
  log?: (line: string) => void;
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function runExecutor({ executor, store, dir, port, page, passes = ['jobs', 'transfers', 'adl'], startedMessage, background, onStopping, onStopped, log = line => process.stderr.write(`${line}\n`) }: RunOptions): { shutdown(reason?: string, detail?: string): Promise<void>; done: Promise<void> } {
  let stopping = false;
  let finished!: () => void;
  const done = new Promise<void>(resolve => { finished = resolve; });
  // Lease renewal runs apart from the passes so a slow venue call cannot let the lease lapse.
  const heartbeat = setInterval(() => {
    try { if (!executor.acquire() && !stopping) { log('执行器已失去写入租约，停止'); process.exitCode = 1; void shutdown('lease-lost', '写入租约已失去'); } }
    catch (error) { log(`续租失败：${message(error)}`); }
  }, Math.floor(executor.budgets.leaseTtlMs / 3));
  // Automatic checkpoints cannot reset the WAL while some reader is always active; the owner truncates it past a threshold.
  let walOverLimit = false;
  const walCheck = setInterval(() => {
    // An instance that lost the lease leaves the database to its new owner.
    if (stopping || executor.retired) return;
    try {
      const { walBytes } = store.maintainWal();
      const over = walBytes > WAL_SIZE_LIMIT_BYTES;
      if (over && !walOverLimit) log(`WAL 已达 ${Math.round(walBytes / 2 ** 20)} MiB，超过 64 MiB 上限：有读取方长时间占用快照，截断无法完成`);
      walOverLimit = over;
    } catch (error) { log(`WAL 维护失败：${message(error)}`); }
  }, WAL_CHECK_MS);
  let loops: Promise<void>[] = [];
  const sleepers = new Set<() => void>();
  const pause = (ms: number) => new Promise<void>(resolve => {
    const wake = () => { clearTimeout(timer); sleepers.delete(wake); resolve(); };
    const timer = setTimeout(wake, ms);
    sleepers.add(wake);
  });
  const context: RunContext = { stopped: () => stopping || executor.retired, pause };
  // Each pass runs on its own schedule, so a venue that answers slowly holds up only its own loop (2.4a).
  // A loop that no longer runs must not keep the lease alive: exit and let another instance take over.
  const passLoop = (label: string, pass: () => Promise<void>) => (async () => {
    let failures = 0, last = '';
    while (!context.stopped()) {
      try { await pass(); failures = 0; }
      catch (error) {
        failures += 1; last = message(error);
        log(`${label}失败（${failures}/${MAX_TICK_FAILURES}）：${last}`);
        if (executor.retired || failures >= MAX_TICK_FAILURES) break;
      }
      if (context.stopped()) break;
      await pause(TICK_MS * (failures + 1));
    }
    if (!stopping) { process.exitCode = 1; void shutdown(executor.retired ? 'lease-lost' : 'pass-failed', executor.retired ? '写入租约已失去' : `${label}连续失败：${last}`); }
  })();
  const accessToken = randomBytes(32).toString('base64url');
  const server = createExecutorServer({ executor, accessToken, ...(page ? { page } : {}) });
  server.on('error', error => { log(`HTTP 监听失败：${error.message}`); process.exitCode = 1; void shutdown('listen-failed', error.message); });
  server.listen(port, '127.0.0.1', () => {
    try { process.stdout.write(`${startedMessage}，登录链接已写入 ${writeAccessUrl(dir, port, accessToken)}\n`); }
    catch (error) { log(`写入登录链接失败：${message(error)}`); process.exitCode = 1; void shutdown('listen-failed', message(error)); }
  });
  const passFns = { jobs: ['两腿任务循环', executor.tickJobs], transfers: ['划转循环', executor.tickTransfers], adl: ['ADL 循环', executor.tickAdl] } as const;
  loops = passes.map(name => passLoop(passFns[name][0], passFns[name][1]));
  // The position display reads on its own schedule, so a slow read neither waits for the passes nor holds them up (L049).
  loops.push((async () => {
    while (!context.stopped()) {
      const started = Date.now();
      try { await executor.refreshPositions(); }
      catch (error) { log(`持仓读取轮失败：${message(error)}`); }
      if (context.stopped()) break;
      await pause(Math.max(TICK_MS, executor.budgets.positionsRefreshMs - (Date.now() - started)));
    }
  })());
  if (background) loops.push(...background(context).map(loop => loop.catch(error => { log(`后台循环异常退出：${message(error)}`); })));

  async function shutdown(reason = 'signal', detail = ''): Promise<void> {
    if (stopping) return done;
    stopping = true;
    try { onStopping?.(reason, detail); } catch (error) { log(`停止通知失败：${message(error)}`); }
    clearInterval(heartbeat);
    clearInterval(walCheck);
    executor.close();
    server.close();
    for (const wake of [...sleepers]) wake();
    await Promise.all(loops);
    try { await onStopped?.(); } catch (error) { log(`停止收尾失败：${message(error)}`); }
    store.close();
    finished();
  }
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  return { shutdown, done };
}
