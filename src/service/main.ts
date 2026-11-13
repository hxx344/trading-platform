// The ASTER service entry: margin-balance transfers and ADL emergency handling of the configured pairs on mainnet.
// It owns a dedicated data directory, listens on loopback (and on the one address config.host names) and takes no pair over by itself: a configured pair is
// registered switched off, and only switching it on in the page (after the takeover checks) hands its accounts to this
// service. Pairs dropped from the config are switched off at start.
import { randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { openStore } from '../store.ts';
import { createExecutor, type Executor } from '../executor.ts';
import type { PairRecord } from '../transfer.ts';
import { DATABASE_FILES, assertDedicatedDataDir, claimDataDirEnvironment, keptSession } from '../data-dir.ts';
import { holdAccountLocks } from '../live/setup.ts';
import { AsterClient, RequestBudget, type AsterCredentials } from '../aster/client.ts';
import { AsterTransferConnector } from '../aster/transfer.ts';
import { AsterTradingConnector } from '../aster/trading.ts';
import { loadWebApp, type WebApp } from '../web-assets.ts';
import { runExecutor } from '../runtime.ts';
import { assertDistinctSigners, checkIntervalBudget, enableBudget, idleWeight, loadServiceConfig, loadServiceSecrets, urlHost, type ServiceConfig, type ServiceSecrets } from './config.ts';
import { TRANSFER_CONFIG_KEYS, parseTransferConfig, type TransferConfig } from '../contracts.ts';
import { PASSWORD_FILE, hashPassword, loadPasswordHash, type PasswordHash } from '../login-password.ts';
import { createTakeoverGuard } from './takeover.ts';
import { createNotifier, type EventRow, type Notifier } from './feishu.ts';
import { createStreamStatus, runUserStream, type SocketLike } from './stream.ts';
import { balanceWindow, createBalanceSamples, type BalanceSamples } from './balance-samples.ts';
import { readImportResult, submitImportRequest } from './import-channel.ts';

const NOTIFY_MS = 2_000;
/** How often the stored balances are looked at for the trend chart; a pair gets at most one sample a minute. */
const SAMPLE_MS = 30_000;
const FINAL_FLUSH_MS = 5_000;
const CONFIG_SESSION = 'service-config';
/** Under systemd's TimeoutStopSec (30 s), leaving time for the final alert flush. */
const DRAIN_MS = 20_000;
/** Longer than the lease a crashed instance leaves behind (60 s). */
const LEASE_WAIT_MS = 65_000;

export interface ServiceWiring {
  executor: Executor;
  trading: AsterTradingConnector;
  client: AsterClient;
  /** Address → credentials of every configured account. */
  byAddress: Map<string, AsterCredentials>;
  /** Sub-account addresses with a user stream. */
  streamed: string[];
  /** Accounts of the configured pairs and of left-over pairs that may still write (enabled or ADL open); all locked. */
  writable: string[];
  /** Config changes that did not apply, for the operator. */
  warnings: string[];
}

/** Builds the connectors and the executor on an open store and brings the registered pairs in line with the config. */
export async function wireService(config: ServiceConfig, secrets: ServiceSecrets, store: ReturnType<typeof openStore>, { fetchImpl, now = Date.now, log = (line: string) => process.stderr.write(`${line}\n`), leaseWaitMs = LEASE_WAIT_MS }: { fetchImpl?: (url: string, init: RequestInit) => Promise<Response>; now?: () => number; log?: (line: string) => void; leaseWaitMs?: number } = {}): Promise<ServiceWiring> {
  assertDistinctSigners(config, secrets);
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
  const takeoverGuard = createTakeoverGuard({ transfers, trading, now });
  const configured = new Set(config.pairs.map(pair => pair.id));
  // A pair left in the database but no longer in config.json can still be switched on from the page; the budget was
  // sized without it, so it must fit on top before the takeover checks spend any weight.
  const enableGuard = async (pair: Readonly<PairRecord>): Promise<void> => {
    if (!configured.has(pair.id)) enableBudget(config, executor.transferPairSettings(), pair.id);
    await takeoverGuard(pair);
  };
  // A new check interval from the page must fit the request budget, like the config's do at start.
  const transferConfigGuard = (pairId: string, next: Readonly<TransferConfig>, pairs: readonly { id: string; enabled: boolean; config: TransferConfig }[]): void => checkIntervalBudget(config, pairs, pairId, next.checkIntervalMs);
  const executor: Executor = createExecutor({ store, connectors: [], environment: 'mainnet', now, transfers, adl: trading, positions: trading, enableGuard, transferConfigGuard, adlOnlyEnabledPairs: true });
  const warnings: string[] = [];
  try {
    // A crashed instance leaves its lease for up to a minute; wait it out here rather than crash-looping under systemd.
    const deadline = Date.now() + leaseWaitMs;
    let waiting = false;
    while (!executor.acquire()) {
      if (Date.now() >= deadline) throw new Error('另一个实例持有写入租约，等待后仍未释放；请确认没有其他实例在运行');
      if (!waiting) { log('上一实例的写入租约尚未过期，等待中'); waiting = true; }
      await new Promise(resolve => setTimeout(resolve, 2_000));
    }
    for (const pair of executor.transferPairs()) {
      if (configured.has(pair.id) || !pair.enabled) continue;
      await executor.setTransferEnabled({ pairId: pair.id, enabled: false, requestId: randomUUID() }, CONFIG_SESSION);
      log(`配对 ${pair.id} 已不在配置中，已停用`);
    }
    const known = new Map(executor.transferPairSettings().map(pair => [pair.id, pair.config]));
    for (const pair of config.pairs) {
      // A new pair starts switched off; changing its accounts switches it off.
      // Its transfer and ADL settings from the config are only a starting value: after the first registration the page
      // owns them, so a known pair is registered with what is stored (a pair dropped and added back keeps them too).
      // Stored settings the current rules no longer accept would fail the registration and with it an account change;
      // the config's take their place, and the operator is told.
      const saved = ((stored: TransferConfig | undefined): TransferConfig | undefined => {
        if (!stored) return undefined;
        try { parseTransferConfig(stored, { strict: true }); return stored; }
        catch (error) {
          // Sent to Feishu at startup with the other warnings, so the operator sees what the page values were replaced with.
          const changed = TRANSFER_CONFIG_KEYS.filter(key => String(stored[key]) !== String(pair.transfer[key])).map(key => `${key} ${String(stored[key]).slice(0, 40)} → ${pair.transfer[key]}`);
          const text = `配对 ${pair.id} 库里的划转参数不符合当前规则（${error instanceof Error ? error.message : String(error)}），已改用 config.json 的 transfer${changed.length ? `（${changed.join('、')}）` : ''}；请在设置页核对`;
          log(text); warnings.push(text);
          return undefined;
        }
      })(known.get(pair.id));
      try {
        executor.registerTransferPair({ id: pair.id, mainAccountId: address(pair.main), long: address(pair.long), short: address(pair.short), config: saved ?? pair.transfer });
      } catch (error) {
        const text = `配对 ${pair.id} 登记失败，保持原记录：${error instanceof Error ? error.message : String(error)}`;
        log(text); warnings.push(text);
        continue;
      }
      // Logged only, like the ADL line below: it holds at every start until the config matches the page.
      const differs = saved ? TRANSFER_CONFIG_KEYS.filter(key => saved[key] !== pair.transfer[key]) : [];
      if (saved && differs.length) log(`配对 ${pair.id} 配置里的 transfer 只在首次登记时作为初始值，页面当前为 ${differs.map(key => `${key}=${saved[key]}`).join('、')}，以页面为准`);
      // The workbench's settings may have turned automatic reduction off; a pair already known keeps the page's.
      if (pair.adl && !known.has(pair.id)) {
        try { executor.setAdlConfig({ pairId: pair.id, requestId: randomUUID(), ...pair.adl }, CONFIG_SESSION); }
        catch (error) {
          // Not retried at the next start (the pair is known by then), so the operator sets it in the page.
          const text = `配对 ${pair.id} 已登记，但配置里的 ADL 初始值未写入（${error instanceof Error ? error.message : String(error)}），当前为自动减仓开、单批 1000；请在页面设置`;
          log(text); warnings.push(text);
        }
      } else if (pair.adl) {
        // Logged only (not an alert): it holds at every start until the config line is removed or matches the page.
        // Only a hint: an unreadable record is the ADL pass's to report, never a reason not to start.
        let saved: { autoReduce?: boolean; batchNotional?: string } | undefined;
        try {
          const row = store.db.prepare('SELECT json FROM adl_pairs WHERE pair_id = ?').get(pair.id) as { json: string } | undefined;
          saved = row ? (JSON.parse(row.json) as { config?: typeof saved }).config : undefined;
        } catch { saved = undefined; }
        if (saved && (saved.autoReduce !== pair.adl.autoReduce || saved.batchNotional !== pair.adl.batchNotional)) {
          log(`配对 ${pair.id} 配置里的 adl 只在首次登记时作为初始值，页面当前为自动减仓${saved.autoReduce ? '开' : '关'}、单批 ${saved.batchNotional}，以页面为准`);
        }
      }
    }
    // The stored intervals may need more than the config's did; the limiter still refuses the excess, so the service starts.
    const weight = idleWeight(config, executor.transferPairSettings());
    if (weight.needed > weight.available) log(`按页面上的检查间隔，配对空闲时每分钟约需请求权重 ${weight.needed}，超过每分钟上限 ${weight.limitPerMinute} 减去 ADL 预留 ${weight.adlReserve} 后的 ${weight.available}；超出部分的请求会被限速器拒绝，请在设置页调大检查间隔或调大 budget.limitPerMinute`);
  } catch (error) { executor.close(); throw error; }
  // transferPairs() masks the accounts; the locks need the real addresses.
  const writable = [...new Set([...config.pairs.flatMap(pair => [address(pair.main), address(pair.long), address(pair.short)]), ...executor.writableAccounts()])];
  return { executor, trading, client, byAddress, streamed: subAccounts, writable, warnings };
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
  leaseWaitMs?: number;
  /** The hand-off directory of the root import helper (install.sh sets it up); without it the page offers no import. */
  importDir?: string;
  password?: PasswordHash;
  /** The built page (loadWebApp); main reads it before the config check, so a release without it never switches in. */
  app: WebApp;
}

/** Opens the data directory, wires the executor and runs it with the alerts and the user streams until shutdown. */
export async function startService({ config, secrets, dir, fetchImpl, connect, notifyFetch, port = config.port, leaseWaitMs, importDir, password, app }: StartOptions): Promise<ReturnType<typeof runExecutor>> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  claimDataDirEnvironment(dir, 'mainnet');
  const session = keptSession(dir);
  const store = openStore(join(dir, DATABASE_FILES.mainnet));
  let wiring: ServiceWiring;
  try { wiring = await wireService(config, secrets, store, { ...(fetchImpl ? { fetchImpl } : {}), ...(leaseWaitMs === undefined ? {} : { leaseWaitMs }) }); }
  catch (error) { store.close(); throw error; }
  const { executor, trading, client, byAddress, streamed, writable, warnings } = wiring;
  // One process per account on this host, covering pairs left in the database as well as configured ones; the kernel
  // drops the locks on exit.
  let locks: { release(): void };
  try { locks = await holdAccountLocks(writable.map(accountId => ({ venue: 'aster', accountId }))); }
  catch (error) { executor.close(); store.close(); throw error; }

  let notifier: Notifier;
  try {
    notifier = createNotifier({
      file: join(dir, 'notify.sqlite'), feishu: secrets.feishu, ...(notifyFetch ? { fetchImpl: notifyFetch } : {}),
      events: (after, limit) => store.db.prepare('SELECT seq, type, at, json FROM events WHERE seq > ? ORDER BY seq LIMIT ?').all(after, limit) as unknown as EventRow[],
      latestSeq: () => (store.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get() as { seq: number }).seq,
      pairs: () => executor.transferPairs().map(pair => ({ id: pair.id, enabled: pair.enabled, blocked: pair.blocked, note: pair.note, noteIdle: pair.noteIdle, balances: pair.balances, balancesFresh: pair.balancesFresh, threshold: pair.config.threshold })),
      incidentPair: id => { try { return executor.adlIncident(id).pairId; } catch { return null; } },
    });
  } catch (error) { executor.close(); store.close(); locks.release(); throw error; }
  // Only the trend chart depends on it: a file that cannot be opened is reported on the status page, the service runs on.
  let samples: BalanceSamples | null = null, samplesError: string | null = null;
  try { samples = createBalanceSamples({ file: join(dir, 'samples.sqlite') }); }
  catch (error) { samplesError = error instanceof Error ? error.message.slice(0, 200) : String(error); process.stderr.write(`余额采样库无法打开，走势图不可用：${samplesError}\n`); }
  const streams = createStreamStatus(streamed);
  const enabled = executor.transferPairs().filter(pair => pair.enabled).length;
  try {
    notifier.notify(`【服务启动】ASTER 保证金平衡与 ADL：配置 ${config.pairs.length} 个配对，已启用 ${enabled} 个`);
    for (const text of warnings) notifier.notify(`【配置未生效】${text}`);
  } catch (error) { samples?.close(); notifier.close(); executor.close(); store.close(); locks.release(); throw error; }

  return runExecutor({
    executor, store, dir, port, app, session,
    ...(config.host ? { listen: { address: config.host, urlHost: urlHost(config.host) } } : {}), ...(password ? { password } : {}), passes: ['transfers', 'adl'], drainMs: DRAIN_MS,
    views: {
      status: () => ({ budget: client.requestBudget.state(), idleWeight: idleWeight(config, executor.transferPairSettings()), streams: streams.view(), feishu: notifier.status(), samples: { available: samples !== null, error: samplesError } }),
      balanceHistory: (pairId, range) => {
        if (samples) return samples.history(pairId, range);
        const window = balanceWindow(range, Date.now());
        return window && { pairId, range, ...window, points: [], unavailable: `余额采样库无法打开，走势图不可用：${samplesError ?? '未知原因'}（不影响划转与 ADL）` };
      },
    },
    ...(importDir ? { imports: { submit: (body: unknown) => submitImportRequest(importDir, body), latest: () => readImportResult(importDir) } } : {}),
    startedMessage: `ASTER 服务已启动（${config.pairs.length} 个配对，已启用 ${enabled} 个）`,
    background: context => [
      (async () => {
        while (!context.stopped()) {
          try { notifier.poll(); await notifier.flush(); }
          catch (error) { process.stderr.write(`告警处理失败：${error instanceof Error ? error.message : String(error)}\n`); }
          await context.pause(NOTIFY_MS);
        }
      })(),
      (async () => {
        while (!context.stopped() && samples) {
          try { samples.record(executor.transferPairs()); samples.prune(); }
          catch (error) { process.stderr.write(`余额采样失败：${error instanceof Error ? error.message : String(error)}\n`); }
          await context.pause(SAMPLE_MS);
        }
      })(),
      ...streamed.map(accountId => runUserStream({
        client, credentials: byAddress.get(accountId)!, accountId, stopped: context.stopped, pause: context.pause, ...(connect ? { connect } : {}),
        push: (id, event) => { streams.onMessage(id); trading.push(id, event); }, onState: (connected, reason) => streams.onState(accountId, connected, reason),
      })),
    ],
    onStopping: (reason, detail) => {
      const text = reason === 'signal' ? '【服务停止】收到停止信号，正常退出' : `【服务异常停止】${detail || reason}；systemd 会在 5 秒后自动重启，请查看日志`;
      try { notifier.poll(); notifier.notify(text); } catch { /* best effort */ }
    },
    onStopped: async () => {
      // Events from the drain (an unknown transfer, an ADL batch) go out now rather than at the next start.
      try { notifier.poll(); } catch { /* best effort */ }
      await Promise.race([notifier.flush(), new Promise(resolve => setTimeout(resolve, FINAL_FLUSH_MS).unref())]);
      notifier.close();
      samples?.close();
      locks.release();
    },
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { config: { type: 'string' }, 'data-dir': { type: 'string' }, 'import-dir': { type: 'string' }, 'check-config': { type: 'boolean' }, 'hash-password': { type: 'boolean' } } });
  if (values['hash-password']) {
    // install.sh --set-password: the password arrives on stdin (one line), only the digest leaves on stdout.
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    process.stdout.write(`${await hashPassword(Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, ''))}\n`);
    return;
  }
  if (!values.config) throw new Error('需要 --config <服务配置文件的绝对路径>');
  const config = loadServiceConfig(values.config);
  const secrets = loadServiceSecrets(config);
  // Next to the config, written by install.sh --set-password; no file means no password.
  const password = loadPasswordHash(join(dirname(values.config), PASSWORD_FILE));
  // Part of the check: a release whose page is missing or would break under the CSP is refused before it switches in.
  const app = loadWebApp();
  if (values['check-config']) {
    // Read and validated offline (keys must derive their signers); nothing is sent anywhere.
    // Only noted, not refused: at boot or with Tailscale logged out the address is missing, and 127.0.0.1 still serves.
    const local = config.host === null || Object.values(networkInterfaces()).flat().some(item => item?.address === config.host);
    process.stdout.write(`配置有效：${config.pairs.length} 个配对（${config.pairs.map(pair => pair.id).join('、') || '尚未导入'}），${secrets.accounts.size} 个账户，端口 ${config.port}，飞书${secrets.feishu ? '已配置' : '未配置'}，监听 127.0.0.1${config.host ? ` 与 ${urlHost(config.host)}` : ''}，登录密码${password ? '已设置' : '未设置'}，页面 ${app.assets.size} 个文件\n`);
    if (!local) process.stdout.write(`注意：${config.host} 现在不在本机网卡上（地址写错，或 Tailscale 尚未连接）；服务会持续重试，在此之前页面只能经 127.0.0.1 打开\n`);
    return;
  }
  if (!values['data-dir']) throw new Error('需要 --data-dir <独立目录的绝对路径>');
  const dir = assertDedicatedDataDir(values['data-dir']);
  const importDir = values['import-dir'];
  if (importDir !== undefined && !isAbsolute(importDir)) throw new Error('--import-dir 必须是绝对路径');
  await startService({ config, secrets, dir, app, ...(importDir ? { importDir } : {}), ...(password ? { password } : {}) });
}

if (import.meta.main) main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
