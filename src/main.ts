// Independent entry point of the executor. It owns a separate data directory,
// refuses the legacy workbench data directory and listens on loopback only
// (plan 1, 8). Without --live-config it runs simulated venues; with it, the
// live canary (3.0c): one Binance and one Bybit account, notional caps, no
// shared writer registry and no ASTER transfers or ADL.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { openStore } from './store.ts';
import { createExecutor, type Executor } from './executor.ts';
import { DATABASE_FILES, assertDedicatedDataDir, claimDataDirEnvironment, writeAccessUrl } from './data-dir.ts';
import { createLiveConnectors, holdAccountLocks, loadLiveConfig, loadLiveCredentials, preflightLive } from './live/setup.ts';
import { SIM_BINDINGS, SIM_TRANSFER_PAIR, createSimulatedVenues } from './simulation.ts';
import { runExecutor } from './runtime.ts';

export { DATABASE_FILES, assertDedicatedDataDir, claimDataDirEnvironment, writeAccessUrl };

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'data-dir': { type: 'string' }, port: { type: 'string', default: '4710' }, 'live-config': { type: 'string' } } });
  if (!values['data-dir']) throw new Error('需要 --data-dir <独立目录的绝对路径>');
  const dir = assertDedicatedDataDir(values['data-dir']);
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('--port 无效');
  const live = values['live-config'] === undefined ? null : loadLiveConfig(values['live-config']);
  // Held for the life of the process; the kernel drops them on exit.
  if (live) await holdAccountLocks(live.accounts);
  // Keys are read and every account checked before the data directory is touched, so a bad key leaves nothing behind.
  const liveConnectors = live ? createLiveConnectors(live, loadLiveCredentials(live.credentialsFile)) : null;
  if (live && liveConnectors) await preflightLive(live, liveConnectors);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  claimDataDirEnvironment(dir, live ? 'mainnet' : 'simulated');

  const store = openStore(join(dir, DATABASE_FILES[live ? 'mainnet' : 'simulated']));
  let executor!: Executor;
  try {
    if (live && liveConnectors) {
      executor = createExecutor({ store, connectors: liveConnectors, environment: 'mainnet', notionalLimits: live.notionalLimits });
      if (!executor.acquire()) throw new Error('另一个执行器实例持有写入租约；等待其租约过期后再启动');
      for (const binding of live.accounts) executor.registerAccount(binding);
    } else {
      const { binance, bybit, aster, asterTrading } = createSimulatedVenues(Date.now);
      executor = createExecutor({ store, connectors: [binance, bybit], transfers: aster, adl: asterTrading, positions: asterTrading });
      if (!executor.acquire()) throw new Error('另一个执行器实例持有写入租约；等待其租约过期后再启动');
      for (const binding of SIM_BINDINGS) executor.registerAccount(binding);
      // A new pair starts disabled; an existing one keeps its switch and settings.
      if (!executor.transferPairs().some(pair => pair.id === SIM_TRANSFER_PAIR.id) && !executor.corruptTransferPairs().includes(SIM_TRANSFER_PAIR.id)) executor.registerTransferPair(SIM_TRANSFER_PAIR);
    }
  } catch (error) {
    // A start that fails after taking the lease hands it back at once instead of leaving the next start to wait it out.
    try { (executor as Executor | undefined)?.close(); } finally { store.close(); }
    throw error;
  }

  runExecutor({ executor, store, dir, port,
    startedMessage: live ? `执行器（实盘金丝雀：单笔上限 ${live.notionalLimits.perJob} USDT，累计开仓上限 ${live.notionalLimits.totalOpen} USDT）已启动` : '执行器原型（模拟传输）已启动' });
}

if (import.meta.main) main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
