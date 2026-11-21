// The run loop shared by the prototype entry and the ASTER service: lease heartbeat, WAL upkeep, the three passes on
// their own schedules, the position reads, the loopback page and an orderly shutdown.
import { randomBytes } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { WAIT_BUCKETS_MS, WAL_SIZE_LIMIT_BYTES, type Store } from './store.ts';
import type { Executor } from './executor.ts';
import { createExecutorServer, type ImportChannel, type ServiceViews } from './http.ts';
import { listenPublic, type PublicListenOptions } from './http-public.ts';
import { writeAccessUrl } from './data-dir.ts';
import type { SessionStore } from './sessions.ts';
import type { PasswordHash } from './login-password.ts';
import type { ReadTokens } from './read-token.ts';
import type { WebApp } from './web-assets.ts';

const TICK_MS = 1_000;
const WAL_CHECK_MS = 1_000;
/** Consecutive failed passes before the entry gives up the lease and exits, so another instance can take over. */
const MAX_TICK_FAILURES = 5;
/**
 * A loop without a finished round for this long counts as stuck in /api/ready. Rounds are bounded by pass budgets and
 * per-call limits and normally end far sooner; the watchdog probes once a minute and alerts after several misses.
 */
export const READY_STALE_MS = 180_000;
/**
 * Whether every tracked loop finished a round within READY_STALE_MS; one that has never finished a round is not ready.
 * Ticks are performance.now() readings, so a step of the wall clock neither hides a stuck loop nor reports one.
 */
export function loopsReady(loops: Iterable<{ okTick: number | null }>, tick: number): boolean {
  for (const loop of loops) if (loop.okTick === null || tick - loop.okTick > READY_STALE_MS) return false;
  return true;
}

export interface RunContext {
  /** True once shutdown has begun or the lease is gone. */
  stopped(): boolean;
  /** A wait that shutdown cuts short. */
  pause(ms: number): Promise<void>;
  /** Why /api/ready would answer 503 right now, or null when ready; for the heartbeat pushed to an outside watchdog. */
  notReady(): string | null;
}

export interface RunOptions {
  executor: Executor;
  store: Store;
  dir: string;
  port: number;
  /** Listen only on this local socket. The control service owns the browser port. */
  socketPath?: string;
  executionBuild?: string;
  configBuild?: string;
  /** One more address to listen on besides 127.0.0.1 (the Tailscale IP), with its URL form (an IPv6 one in brackets). */
  listen?: PublicListenOptions['listen'];
  /** The login password's digest; without one only the access-url link logs in. */
  password?: PasswordHash;
  /**
   * Retry spacing for that address while it cannot be bound (Tailscale not connected yet, or logged out): doubling from
   * firstMs up to maxMs, for as long as it takes. It never stops the run; the page stays on 127.0.0.1 meanwhile.
   */
  listenRetry?: PublicListenOptions['listenRetry'];
  page?: string;
  /** The built page; takes the place of page. */
  app?: WebApp;
  /** The page sessions, kept across restarts so open pages stay logged in; held in memory only when absent. */
  sessions?: SessionStore;
  imports?: ImportChannel;
  /** The read-only API token (docs/mcp.md); absent, a request with a token gets 401. */
  readTokens?: ReadTokens;
  /** The service's own read-only views; the status one is shown under the run's health (start, database, loops). */
  views?: ServiceViews;
  /** Which passes run; the service has no two-leg jobs. */
  passes?: readonly ('jobs' | 'transfers' | 'adl')[];
  startedMessage: string;
  /** Extra loops started after the server; each must end soon after `stopped()` turns true. */
  background?: (context: RunContext) => Promise<void>[];
  /** Why the run is ending, before anything is closed: 'signal', 'lease-lost', 'pass-failed', 'listen-failed'. */
  onStopping?: (reason: string, detail: string) => void;
  /** Runs before the store closes. Includes a loss first detected while draining an already announced stop. */
  onStopped?: (lateLeaseLoss: string | null) => Promise<void> | void;
  log?: (line: string) => void;
  /**
   * How long a stop waits, still renewing the lease, for running passes to finish before closing the executor.
   * 0 closes at once: a write in flight then ends unknown and the next instance checks it.
   */
  drainMs?: number;
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function checkSocketOptions(socketPath: string, port: number): void {
  if (!isAbsolute(socketPath)) throw new Error('--socket 必须是绝对路径');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('使用 --socket 时需要有效的页面端口');
}

export function runExecutor({ executor, store, dir, port, socketPath, executionBuild, configBuild, listen, password, listenRetry, page, app, sessions, imports, readTokens, views, passes = ['jobs', 'transfers', 'adl'], startedMessage, background, onStopping, onStopped, log = line => process.stderr.write(`${line}\n`), drainMs = 0 }: RunOptions): { shutdown(reason?: string, detail?: string): Promise<void>; done: Promise<void> } {
  if (socketPath !== undefined) checkSocketOptions(socketPath, port);
  let stopping = false;
  let finished!: () => void;
  const done = new Promise<void>(resolve => { finished = resolve; });
  // Lease renewal runs apart from the passes so a slow venue call cannot let the lease lapse.
  const heartbeat = setInterval(() => {
    try { if (!executor.acquire() && !stopping) void shutdown('lease-lost'); }
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
    if (stopping) { resolve(); return; }
    const wake = () => { clearTimeout(timer); sleepers.delete(wake); resolve(); };
    const timer = setTimeout(wake, ms);
    sleepers.add(wake);
  });
  const startedAt = Date.now();
  /** Per loop, for the status page: its last good round and its failures in a row; okTick is that round on the monotonic clock. */
  const loopStatus = new Map<string, { lastOkAt: number | null; okTick: number | null; failures: number; lastError: string | null; lastErrorAt: number | null }>();
  const loopOk = (label: string) => { const row = loopStatus.get(label); if (row) { row.lastOkAt = Date.now(); row.okTick = performance.now(); row.failures = 0; } };
  const loopFailed = (label: string, error: string) => { const row = loopStatus.get(label); if (row) { row.failures += 1; row.lastError = error.slice(0, 300); row.lastErrorAt = Date.now(); } };
  const loopTracked = (label: string) => { loopStatus.set(label, { lastOkAt: null, okTick: null, failures: 0, lastError: null, lastErrorAt: null }); };
  const notReady = (): string | null => {
    if (stopping) return '服务正在停止';
    if (executor.retired) return '已失去写入租约';
    const tick = performance.now();
    const stuck = [...loopStatus].filter(([, row]) => !loopsReady([row], tick)).map(([name, row]) => row.okTick === null ? `${name}尚未完成一轮` : `${name}已 ${Math.round((tick - row.okTick) / 1000)} 秒未完成一轮`);
    return stuck.length ? stuck.join('；') : null;
  };
  const context: RunContext = { stopped: () => stopping || executor.retired, pause, notReady };
  // Each pass runs on its own schedule, so a venue that answers slowly holds up only its own loop (2.4a).
  // A loop that no longer runs must not keep the lease alive: exit and let another instance take over.
  const passLoop = (label: string, pass: () => Promise<void>) => (async () => {
    let failures = 0, last = '';
    loopTracked(label);
    while (!context.stopped()) {
      try { await pass(); failures = 0; loopOk(label); }
      catch (error) {
        failures += 1; last = message(error); loopFailed(label, last);
        log(`${label}失败（${failures}/${MAX_TICK_FAILURES}）：${last}`);
        if (executor.retired || failures >= MAX_TICK_FAILURES) break;
      }
      if (context.stopped()) break;
      await pause(TICK_MS * (failures + 1));
    }
    if (!stopping) {
      if (executor.retired) void shutdown('lease-lost');
      else { process.exitCode = 1; void shutdown('pass-failed', `${label}连续失败：${last}`); }
    }
  })();
  const accessToken = randomBytes(32).toString('base64url');
  const status = (): Record<string, unknown> => {
    const writes = store.stats();
    return {
      health: {
        startedAt, now: Date.now(), generation: executor.generation, retired: executor.retired, schemaVersion: store.schemaVersion(), walBytes: store.walBytes(), walLimitBytes: WAL_SIZE_LIMIT_BYTES,
        writes: { transactions: writes.transactions, busy: writes.busy, waitBucketsMs: [...WAIT_BUCKETS_MS], waitBuckets: writes.waitBuckets, maxWaitMs: writes.maxWaitMs, maxHoldMs: writes.maxHoldMs },
        loops: [...loopStatus].map(([name, { okTick: _, ...row }]) => ({ name, ...row })),
      },
      ...(views?.status?.() ?? {}),
    };
  };
  const ready = (): boolean => notReady() === null;
  const server = createExecutorServer({ executor, accessToken, log, ready, ...(listen ? { host: listen.urlHost } : {}), ...(password ? { password } : {}),
    ...(socketPath !== undefined ? { browserPort: port, executionBuild, configBuild } : { page: page || undefined, app }), ...(sessions ? { sessions } : {}), ...(imports ? { imports } : {}), ...(readTokens ? { readTokens } : {}), views: { ...views, status } });
  const publishAccess = (bound: number) => {
    try { process.stdout.write(`${startedMessage}，登录链接已写入 ${writeAccessUrl(dir, bound, accessToken, listen?.urlHost)}\n`); }
    catch (error) { log(`写入登录链接失败：${message(error)}`); process.exitCode = 1; void shutdown('listen-failed', message(error)); }
  };
  const listenFailed = (error: Error) => { log(`HTTP 监听失败：${error.message}`); process.exitCode = 1; void shutdown('listen-failed', error.message); };
  let closeListener: () => void;
  if (socketPath !== undefined) {
    server.on('error', error => {
      if (stopping) return;
      if (server.listening) log(`HTTP 接受连接出错：${error.message}`);
      else listenFailed(error);
    });
    // The service manager owns this private runtime directory. Never unlink another listener's socket.
    server.listen({ path: socketPath }, () => {
      if (stopping) { server.close(); return; }
      // The setgid runtime directory grants its IPC group traverse access only. The data files keep UMask=0077.
      if (process.platform !== 'win32') {
        try { chmodSync(socketPath, 0o660); }
        catch (error) { listenFailed(error as Error); return; }
      }
      publishAccess(port);
    });
    closeListener = () => { server.close(); };
  } else {
    closeListener = listenPublic(server, { port, listen, listenRetry, log, onListening: publishAccess, onError: listenFailed });
  }
  const passFns = { jobs: ['两腿任务循环', executor.tickJobs], transfers: ['划转循环', executor.tickTransfers], adl: ['ADL 循环', executor.tickAdl] } as const;
  loops = passes.map(name => passLoop(passFns[name][0], passFns[name][1]));
  // The jobs pass prunes history; a process without it prunes on its own schedule.
  if (!passes.includes('jobs')) loops.push(passLoop('历史清理', async () => { executor.maintain(); }));
  // The position display reads on its own schedule, so a slow read neither waits for the passes nor holds them up (L049).
  loopTracked('持仓读取');
  loops.push((async () => {
    while (!context.stopped()) {
      const started = Date.now();
      try { await executor.refreshPositions(); loopOk('持仓读取'); }
      catch (error) { log(`持仓读取轮失败：${message(error)}`); loopFailed('持仓读取', message(error)); }
      if (context.stopped()) break;
      await pause(Math.max(TICK_MS, executor.budgets.positionsRefreshMs - (Date.now() - started)));
    }
  })());
  if (background) loops.push(...background(context).map(loop => loop.catch(error => { log(`后台循环异常退出：${message(error)}`); })));

  async function shutdown(reason = 'signal', detail = ''): Promise<void> {
    if (stopping) return done;
    stopping = true;
    if (executor.leaseLossDetail || reason === 'lease-lost') {
      reason = 'lease-lost';
      process.exitCode = 1;
      detail = executor.leaseLossDetail ?? '写入租约已失去';
      log(detail);
    }
    try { onStopping?.(reason, detail); } catch (error) { log(`停止通知失败：${message(error)}`); }
    clearInterval(walCheck);
    closeListener();
    for (const wake of [...sleepers]) wake();
    if (drainMs > 0 && !executor.retired) {
      // Sends already out finish and are written; nothing new goes out meanwhile.
      executor.stopSending();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const drained = await Promise.race([Promise.all(loops).then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), drainMs); })]);
      clearTimeout(timer);
      if (!drained) log(`停止时等待 ${drainMs / 1000} 秒后仍有循环未结束，直接关闭；进行中的写入由下次启动核对`);
    }
    clearInterval(heartbeat);
    executor.close();
    await Promise.all(loops);
    const lateLeaseLoss = reason === 'lease-lost' ? null : executor.leaseLossDetail ?? null;
    if (lateLeaseLoss) log(lateLeaseLoss);
    try { await onStopped?.(lateLeaseLoss); } catch (error) { log(`停止收尾失败：${message(error)}`); }
    store.close();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    finished();
  }
  function onSignal(): void { void shutdown(); }
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  return { shutdown, done };
}
