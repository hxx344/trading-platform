// The ASTER service entry: margin-balance transfers and ADL emergency handling of the configured pairs on mainnet.
// It owns a dedicated data directory, listens on loopback only and takes no pair over by itself: a configured pair is
// registered switched off, and only switching it on in the page (after the takeover checks) hands its accounts to this
// service. Pairs dropped from the config are switched off at start.
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { openStore } from '../store.ts';
import { createExecutor, type Executor } from '../executor.ts';
import { DATABASE_FILES, assertDedicatedDataDir, claimDataDirEnvironment } from '../data-dir.ts';
import { holdAccountLocks } from '../live/setup.ts';
import { AsterClient, RequestBudget, type AsterCredentials } from '../aster/client.ts';
import { AsterTransferConnector } from '../aster/transfer.ts';
import { AsterTradingConnector } from '../aster/trading.ts';
import { ASTER_PAGE } from '../page.ts';
import { runExecutor } from '../runtime.ts';
import { loadServiceConfig, loadServiceSecrets, type ServiceConfig, type ServiceSecrets } from './config.ts';
import { createTakeoverGuard } from './takeover.ts';
import { createNotifier, type EventRow, type Notifier } from './feishu.ts';
import { runUserStream, type SocketLike } from './stream.ts';

const NOTIFY_MS = 2_000;
const FINAL_FLUSH_MS = 5_000;
const CONFIG_SESSION = 'service-config';

export interface ServiceWiring {
  executor: Executor;
  trading: AsterTradingConnector;
  client: AsterClient;
  /** Address → credentials of every configured account. */
  byAddress: Map<string, AsterCredentials>;
  /** Sub-account addresses with a user stream. */
  streamed: string[];
}

/** Builds the connectors and the executor on an open store and brings the registered pairs in line with the config. */
export async function wireService(config: ServiceConfig, secrets: ServiceSecrets, store: ReturnType<typeof openStore>, { fetchImpl, now = Date.now, log = (line: string) => process.stderr.write(`${line}\n`) }: { fetchImpl?: (url: string, init: RequestInit) => Promise<Response>; now?: () => number; log?: (line: string) => void } = {}): Promise<ServiceWiring> {
  const address = (name: string): string => secrets.accounts.get(name)!.user;
  const byAddress = new Map([...secrets.accounts.values()].map(item => [item.user, item]));
  const credentials = (accountId: string): AsterCredentials => {
    const found = byAddress.get(accountId);
    if (!found) throw new Error(`账户 ***${accountId.slice(-4)} 没有配置密钥`);
    return found;
  };
  const budget = new RequestBudget({ ...config.budget, now });
  const client = new AsterClient({ budget, ...(fetchImpl ? { fetchImpl } : {}) });
  const subAccounts = [...new Set(config.pairs.flatMap(pair => [address(pair.long), address(pair.short)]))];
  const transfers = new AsterTransferConnector({ client, credentials, knownAccounts: () => subAccounts, now });
  const trading = new AsterTradingConnector({ client, credentials, now });
  const enableGuard = createTakeoverGuard({ transfers, trading, now });
  const executor = createExecutor({ store, connectors: [], environment: 'mainnet', now, transfers, adl: trading, positions: trading, enableGuard, adlOnlyEnabledPairs: true });
  try {
    if (!executor.acquire()) throw new Error('另一个实例持有写入租约；等待其租约过期后再启动');
    const configured = new Set(config.pairs.map(pair => pair.id));
    for (const pair of executor.transferPairs()) {
      if (configured.has(pair.id) || !pair.enabled) continue;
      await executor.setTransferEnabled({ pairId: pair.id, enabled: false, requestId: randomUUID() }, CONFIG_SESSION);
      log(`配对 ${pair.id} 已不在配置中，已停用`);
    }
    for (const pair of config.pairs) {
      // A new pair starts switched off; changing its accounts switches it off; changed settings apply at once.
      try { executor.registerTransferPair({ id: pair.id, mainAccountId: address(pair.main), long: address(pair.long), short: address(pair.short), config: pair.transfer }); }
      catch (error) { log(`配对 ${pair.id} 登记失败，保持原记录：${error instanceof Error ? error.message : String(error)}`); }
    }
  } catch (error) { executor.close(); throw error; }
  return { executor, trading, client, byAddress, streamed: subAccounts };
}

export interface StartOptions {
  config: ServiceConfig;
  secrets: ServiceSecrets;
  dir: string;
  /** Tests stand in for ASTER, the user streams and the robot; production uses the network. */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  connect?: (url: string) => SocketLike;
  notifyFetch?: (url: string, init: RequestInit) => Promise<Response>;
  port?: number;
}

/** Opens the data directory, wires the executor and runs it with the alerts and the user streams until shutdown. */
export async function startService({ config, secrets, dir, fetchImpl, connect, notifyFetch, port = config.port }: StartOptions): Promise<ReturnType<typeof runExecutor>> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  claimDataDirEnvironment(dir, 'mainnet');
  const store = openStore(join(dir, DATABASE_FILES.mainnet));
  let wiring: ServiceWiring;
  try { wiring = await wireService(config, secrets, store, fetchImpl ? { fetchImpl } : {}); }
  catch (error) { store.close(); throw error; }
  const { executor, trading, client, byAddress, streamed } = wiring;

  let notifier: Notifier;
  try {
    notifier = createNotifier({
      file: join(dir, 'notify.sqlite'), feishu: secrets.feishu, ...(notifyFetch ? { fetchImpl: notifyFetch } : {}),
      events: (after, limit) => store.db.prepare('SELECT seq, type, at, json FROM events WHERE seq > ? ORDER BY seq LIMIT ?').all(after, limit) as unknown as EventRow[],
      latestSeq: () => (store.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get() as { seq: number }).seq,
      pairs: () => executor.transferPairs().map(pair => ({ id: pair.id, enabled: pair.enabled, blocked: pair.blocked, note: pair.note })),
      incidentPair: id => { try { return executor.adlIncident(id).pairId; } catch { return null; } },
    });
  } catch (error) { executor.close(); store.close(); throw error; }
  const enabled = executor.transferPairs().filter(pair => pair.enabled).length;
  notifier.notify(`【服务启动】ASTER 保证金平衡与 ADL：配置 ${config.pairs.length} 个配对，已启用 ${enabled} 个`);

  return runExecutor({
    executor, store, dir, port, page: ASTER_PAGE, passes: ['transfers', 'adl'],
    startedMessage: `ASTER 服务已启动（${config.pairs.length} 个配对，已启用 ${enabled} 个）`,
    background: context => [
      (async () => {
        while (!context.stopped()) {
          try { notifier.poll(); await notifier.flush(); }
          catch (error) { process.stderr.write(`告警处理失败：${error instanceof Error ? error.message : String(error)}\n`); }
          await context.pause(NOTIFY_MS);
        }
      })(),
      ...streamed.map(accountId => runUserStream({ client, credentials: byAddress.get(accountId)!, accountId, push: (id, event) => trading.push(id, event), stopped: context.stopped, pause: context.pause, ...(connect ? { connect } : {}) })),
    ],
    onStopping: (reason, detail) => {
      const text = reason === 'signal' ? '【服务停止】收到停止信号，正常退出' : `【服务异常停止】${detail || reason}；systemd 会自动重启，请查看日志`;
      try { notifier.poll(); notifier.notify(text); } catch { /* best effort */ }
    },
    onStopped: async () => {
      await Promise.race([notifier.flush(), new Promise(resolve => setTimeout(resolve, FINAL_FLUSH_MS).unref())]);
      notifier.close();
    },
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { config: { type: 'string' }, 'data-dir': { type: 'string' }, 'check-config': { type: 'boolean' } } });
  if (!values.config) throw new Error('需要 --config <服务配置文件的绝对路径>');
  const config = loadServiceConfig(values.config);
  const secrets = loadServiceSecrets(config);
  if (values['check-config']) {
    // Read and validated offline (keys must derive their signers); nothing is sent anywhere.
    process.stdout.write(`配置有效：${config.pairs.length} 个配对（${config.pairs.map(pair => pair.id).join('、')}），${secrets.accounts.size} 个账户，端口 ${config.port}，飞书${secrets.feishu ? '已配置' : '未配置'}\n`);
    return;
  }
  if (!values['data-dir']) throw new Error('需要 --data-dir <独立目录的绝对路径>');
  const dir = assertDedicatedDataDir(values['data-dir']);
  // One process per account on this host; the kernel drops the locks on exit.
  await holdAccountLocks([...new Set(config.pairs.flatMap(pair => [pair.main, pair.long, pair.short]))].map(name => ({ venue: 'aster', accountId: secrets.accounts.get(name)!.user })));
  await startService({ config, secrets, dir });
}

if (import.meta.main) main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
