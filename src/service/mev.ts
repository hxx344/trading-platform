// MEV 套利模块接进执行服务（docs/mev.md）。模块总是加载：热钱包、收款地址与节点由页面录入（存数据目录的
// mev-wallet.json，执行合约由热钱包自己部署，见 src/mev/setup.ts），或沿用运维文件里的 `mev`（--set-mev 写入，
// 此时页面不能改）。模块只写自己的 mev.sqlite 与 mev-wallet.json，打不开库或节点不通都不影响执行服务本身；
// 引擎启动后是观察模式，实盘只能从页面开始，重启后回到观察模式。
import { join } from 'node:path';
import { BASE_CHAIN_ID } from '../mev/chain.ts';
import { AbiReader, addressOf, quantity, selector } from '../mev/codec.ts';
import { createMevEngine, expectedRuntimeCode, MevError, type MevEngine } from '../mev/engine.ts';
import { SettingsError, weiToEth } from '../mev/risk.ts';
import { createRpc, RpcError, type FetchLike, type RpcClient } from '../mev/rpc.ts';
import { cleanWalletTemps, contractAddress, DEFAULT_RPC_URL, parseRpcUrl, parseSetup, planDeployment, readKnown, readWallet, REDEPLOY_AFTER_MS, removeWallet, rpcHost, signDeployment, WALLET_FILE, writeKnown, writeWallet, type MevWallet } from '../mev/setup.ts';
import { MEV_FILE, openMevStore } from '../mev/store.ts';
import type { MevSetupView } from '../mev/views.ts';
import type { MevSecrets, MevServiceConfig } from './mev-config.ts';

/** 测试里替换节点传输与时钟。 */
export interface MevOptions { fetchImpl?: FetchLike; now?: () => number; pollMs?: number }
/** 运维文件里的 `mev`（两处都有才算）与本服务其他用途的钱包地址（热钱包必须专用）。 */
export interface MevSource { config?: MevServiceConfig | undefined; secrets?: MevSecrets | undefined; others?: readonly string[] }
interface Hooks { log: (line: string) => void; notify: (key: string, text: string) => unknown }
interface LoopContext { stopped(): boolean; pause(ms: number): Promise<void> }

export interface MevViews {
  state(): unknown;
  settings(body: unknown): unknown;
  start(body: unknown): Promise<unknown>;
  stop(): unknown;
  tokens(body: unknown): Promise<unknown>;
  setup(body: unknown): Promise<unknown>;
  deploy(body: unknown): Promise<unknown>;
  reset(body: unknown): unknown;
  rpc(body: unknown): unknown;
  failure(error: unknown): { status: number; body: { code: string; message: string }; internal: boolean };
}
export interface MevManager { views: MevViews; loop(context: LoopContext): Promise<void>; shutdown(): void; engine(): MevEngine | null }

/** 未就绪时多久读一次热钱包的余额与部署结果。 */
export const SETUP_POLL_MS = 3_000;
/** 链上 nonce 已越过部署交易、合约地址上却没有预期代码，连续这么多轮才判定部署没成（容忍落后的节点）。 */
export const DEPLOY_MISSING_LIMIT = 3;
/** 录入钱包后往回找多少个 nonce，看这个钱包是否已经为同一个收款地址部署过合约。 */
export const ADOPT_SCAN = 16;
/** 扫描时每批查几个地址（每个地址两个调用）：公共节点与部分服务商的批量上限很小。 */
export const ADOPT_BATCH = 4;

const short = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`;
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);
const record = (body: unknown): Record<string, unknown> => body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};

export function openMev(source: MevSource, dir: string, options: MevOptions, hooks: Hooks): MevManager {
  const now = options.now ?? Date.now, others = source.others ?? [];
  const managed = source.config && source.secrets ? { config: source.config, secrets: source.secrets } : null;
  const say = (key: string, text: string) => { try { hooks.notify(key, text); } catch { /* 通知失败不影响模块 */ } };

  let wallet: MevWallet | null = null, error: string | null = null;
  cleanWalletTemps(dir);
  if (!managed) try { wallet = readWallet(dir); } catch (cause) { error = errorText(cause); hooks.log(`mev: ${error}，模块等待在页面重新录入`); }
  // 专用钱包的检查在录入时做过；之后新增的账户若与热钱包相同，这里不再采用它。
  if (wallet && others.some(address => address.toLowerCase() === addressOf(wallet!.privateKey))) {
    wallet = null; error = '已录入的热钱包与本平台的某个账户共用同一个钱包，未采用；请录入一个专用的热钱包';
    hooks.log(`mev: ${error}`);
  }

  // 每换一次钱包或节点就是新的一代：旧一代的节点请求被中止，引擎循环在下一轮退出并关库。
  let generation = 0, abort = new AbortController(), rpc: RpcClient | null = null, sendRpc: RpcClient | null = null;
  let engine: MevEngine | null = null, shut = false, busy = false;
  let chain: { eth: number; nonce: number; checkedAt: number } | null = null, rpcError: string | null = null;
  // scannedAt：上一次完整扫描「这个钱包是否已部署过」时的链上 nonce；nonce 变了就重扫。
  let missing = 0, scannedAt: number | null = null;

  const transport = () => ({ ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}), signal: abort.signal });
  function connect(): void {
    abort.abort(); abort = new AbortController(); generation += 1;
    engine?.quiesce(); engine = null;
    chain = null; rpcError = null; missing = 0; scannedAt = null;
    if (managed) {
      rpc = createRpc({ url: managed.secrets.rpcUrl, ...transport() });
      sendRpc = managed.secrets.sendRpcUrl ? createRpc({ url: managed.secrets.sendRpcUrl, ...transport() }) : rpc;
    } else if (wallet) { rpc = sendRpc = createRpc({ url: wallet.rpcUrl ?? DEFAULT_RPC_URL, ...transport() }); }
    else rpc = sendRpc = null;
  }
  connect();

  const identity = (): { executor: string; owner: string; privateKey: string } | null =>
    managed ? { executor: managed.config.executor, owner: managed.config.owner, privateKey: managed.secrets.privateKey }
      : wallet?.executor ? { executor: wallet.executor, owner: wallet.owner, privateKey: wallet.privateKey } : null;
  const operator = (): string | null => managed ? addressOf(managed.secrets.privateKey) : wallet ? addressOf(wallet.privateKey) : null;

  function setupView(): MevSetupView {
    const url = managed ? managed.secrets.rpcUrl : wallet ? wallet.rpcUrl ?? DEFAULT_RPC_URL : null, address = operator();
    const deploy = !managed && wallet?.deploy && address ? { hash: wallet.deploy.hash, nonce: wallet.deploy.nonce, at: wallet.deploy.at, address: contractAddress(address, wallet.deploy.nonce) } : null;
    return {
      stage: identity() ? 'ready' : !wallet ? 'none' : deploy ? 'deploying' : 'wallet',
      managed: !!managed, operator: address, owner: managed ? managed.config.owner : wallet?.owner ?? null,
      rpcHost: url ? rpcHost(url) : null, defaultRpc: !managed && !!wallet && wallet.rpcUrl === undefined,
      wallet: chain, rpcError, deploy, error, checkedAt: now(),
    };
  }

  const pageWallet = (): MevWallet => {
    if (managed) throw new MevError(409, 'managed', '热钱包与节点由服务器上的配置文件管理（install.sh --set-mev），不能在页面修改');
    if (!wallet) throw new MevError(409, 'not_setup', '还没有录入热钱包');
    return wallet;
  };
  const notLive = (): void => { if (engine?.isLive()) throw new MevError(409, 'live', '实盘进行中，先停止实盘'); };
  const save = (next: MevWallet | null): void => {
    try { if (next) writeWallet(dir, next); else removeWallet(dir); } catch (cause) { throw new MevError(500, 'storage', errorText(cause)); }
    wallet = next;
  };
  const confirmed = (body: unknown, current: MevWallet): void => {
    if (record(body).confirm !== addressOf(current.privateKey)) throw new MevError(400, 'confirm_required', '须带上热钱包地址确认');
  };

  function adopt(current: MevWallet, executor: string, how: string): void {
    const address = addressOf(current.privateKey);
    save({ privateKey: current.privateKey, owner: current.owner, ...(current.rpcUrl ? { rpcUrl: current.rpcUrl } : {}), executor });
    error = null;
    hooks.log(`mev: ${how} ${executor}`);
    say(`mev:deployed:${executor}`, `【MEV 套利】执行合约${how} ${executor}，热钱包 ${address}，利润收款地址 ${current.owner}。现在是观察模式，实盘须在页面开始`);
    connect();
  }

  /**
   * 找这个热钱包为同一个收款地址部署过、operator 仍是它的合约：移除时留下的地址，加上最近 ADOPT_SCAN 个 nonce 的
   * CREATE 地址。返回 null 是确实没有，undefined 是没读全（不能当作没有）。
   */
  async function findDeployed(client: RpcClient, current: MevWallet, nonce: number): Promise<string | null | undefined> {
    const address = addressOf(current.privateKey), code = expectedRuntimeCode(current.owner), known = readKnown(dir);
    const candidates = [...new Set([
      ...(known && known.operator === address && known.owner === current.owner ? [known.executor] : []),
      ...Array.from({ length: Math.min(nonce, ADOPT_SCAN) }, (_, index) => contractAddress(address, nonce - 1 - index)),
    ])];
    let complete = true;
    for (let start = 0; start < candidates.length; start += ADOPT_BATCH) {
      const part = candidates.slice(start, start + ADOPT_BATCH);
      // 每批带上 nonce：与调用方读到的不同，说明这一批出自另一个进度的节点后端（或链上刚变），不能据此说「没有」。
      const answers = await client.batch([
        ...part.flatMap(target => [
          { method: 'eth_getCode', params: [target, 'latest'] },
          { method: 'eth_call', params: [{ to: target, data: selector('operator()') }, 'latest'] },
        ]),
        { method: 'eth_getTransactionCount', params: [address, 'latest'] },
      ]);
      const seen = answers[part.length * 2]!;
      if (!seen.ok || Number(quantity(seen.result)) !== nonce) return undefined;
      for (const [index, target] of part.entries()) {
        const found = answers[index * 2]!, role = answers[index * 2 + 1]!;
        if (!found.ok) { complete = false; continue; }
        if (String(found.result).toLowerCase() !== code) continue;
        // owner 换掉过 operator 的旧合约（停用方式就是 setOperator）不能沿用：引擎的核对永远过不了。
        if (!role.ok) { complete = false; continue; }
        try { if (new AbiReader(String(role.result)).address(0) === address) return target; } catch { complete = false; }
      }
    }
    return complete ? null : undefined;
  }

  /** 未就绪时读热钱包余额与 nonce，并看部署是否已经上链。读不到只记在 rpcError 里。 */
  async function poll(): Promise<void> {
    const current = wallet, client = rpc, at = generation;
    if (managed || !current || current.executor || !client) return;
    const address = addressOf(current.privateKey), code = expectedRuntimeCode(current.owner);
    try {
      const target = current.deploy ? contractAddress(address, current.deploy.nonce) : null;
      const answers = await client.batch([
        { method: 'eth_getBalance', params: [address, 'latest'] },
        { method: 'eth_getTransactionCount', params: [address, 'latest'] },
        ...(target ? [{ method: 'eth_getCode', params: [target, 'latest'] }] : []),
      ]);
      if (at !== generation || wallet !== current) return;
      if (!answers[0]!.ok || !answers[1]!.ok) throw new Error('节点没有返回余额或 nonce');
      const nonce = Number(quantity(answers[1]!.result));
      chain = { eth: weiToEth(quantity(answers[0]!.result)), nonce, checkedAt: now() }; rpcError = null;
      if (target && current.deploy) {
        const found = answers[2]!;
        if (found.ok && String(found.result).toLowerCase() === code) return adopt(current, target, '已部署并核对，地址');
        if (found.ok && nonce > current.deploy.nonce) {
          if (++missing >= DEPLOY_MISSING_LIMIT) {
            missing = 0; scannedAt = null;
            save({ privateKey: current.privateKey, owner: current.owner, ...(current.rpcUrl ? { rpcUrl: current.rpcUrl } : {}) });
            error = '部署交易没有成功：这个 nonce 已被用掉，合约地址上却没有预期的代码（部署回滚，或热钱包另发了交易）。可以重新部署';
            hooks.log(`mev: 部署没有成功（nonce ${current.deploy.nonce}）`);
          }
        } else missing = 0;
        return;
      }
      // 这个钱包以前为同一个收款地址部署过（例如移除后重新录入）：直接沿用，不再花一次部署的 gas。
      if (scannedAt !== nonce) {
        const found = await findDeployed(client, current, nonce);
        if (at !== generation || wallet !== current) return;
        if (found) return adopt(current, found, '沿用这个热钱包已部署的合约，地址');
        if (found === null) scannedAt = nonce;
      }
    } catch (cause) {
      if (at === generation) rpcError = errorText(cause);
    }
  }

  function startEngine(): MevEngine | null {
    const current = identity();
    if (!current || !rpc || !sendRpc) return null;
    try {
      const store = openMevStore(join(dir, MEV_FILE));
      try {
        const created = createMevEngine({
          store, rpc, sendRpc, chainId: BASE_CHAIN_ID, ...current, log: hooks.log, notify: hooks.notify,
          ...(options.now ? { now: options.now } : {}), ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
        });
        error = null;
        return created;
      } catch (cause) { store.close(); throw cause; }
    } catch (cause) {
      const message = `打不开 ${MEV_FILE}：${errorText(cause)}`;
      if (error !== message) hooks.log(`mev: ${message}，模块停用`);
      error = message;
      return null;
    }
  }

  const current = (): MevEngine => engine ?? (() => { throw new MevError(503, 'unavailable', identity() ? `MEV 套利模块不可用：${error ?? '正在启动'}` : '还没有完成启用：先在页面录入热钱包并部署执行合约'); })();
  const state = (): unknown => engine ? { ...engine.views.state(), setup: setupView() } : { setup: setupView() };

  const views: MevViews = {
    state,
    settings: body => current().views.settings(body),
    start: body => current().views.start(body),
    stop: () => current().views.stop(),
    tokens: body => current().views.tokens(body),
    async setup(body) {
      if (managed) pageWallet();
      if (shut) throw new MevError(503, 'stopping', '服务正在停止');
      if (wallet) throw new MevError(409, 'exists', '已经录入过热钱包；要更换先在页面移除');
      const input = parseSetup(body, others);
      save(input);
      error = null;
      const address = addressOf(input.privateKey);
      hooks.log(`mev: 页面录入了热钱包 ${short(address)}，收款地址 ${short(input.owner)}`);
      say(`mev:setup:${address}:${now()}`, `【MEV 套利】页面录入了热钱包 ${address}，利润收款地址 ${input.owner}`);
      connect();
      await poll();
      return state();
    },
    async deploy(body) {
      const before = pageWallet();
      confirmed(body, before);
      if (shut) throw new MevError(503, 'stopping', '服务正在停止');
      if (before.executor) throw new MevError(409, 'deployed', '执行合约已经部署');
      if (before.deploy && now() - before.deploy.at < REDEPLOY_AFTER_MS) throw new MevError(409, 'pending', '部署交易已发出，还在等待上链');
      if (busy || !rpc || !sendRpc) throw new MevError(409, 'busy', '上一次部署请求还没有结束');
      busy = true;
      const at = generation, client = sendRpc;
      try {
        let plan;
        try { plan = await planDeployment(rpc, before, BASE_CHAIN_ID, before.deploy); } catch (cause) {
          if (cause instanceof MevError) throw cause;
          if (at !== generation) throw new MevError(409, 'stale', '热钱包或节点刚被修改，刷新后重试');
          throw new MevError(502, 'rpc', `读取链上状态失败：${errorText(cause)}`);
        }
        if (at !== generation || wallet !== before) throw new MevError(409, 'stale', '热钱包或节点刚被修改，刷新后重试');
        if (before.deploy && plan.nonce > before.deploy.nonce) throw new MevError(409, 'pending', '之前那笔部署交易的 nonce 已经用掉，正在核对结果');
        if (before.deploy && plan.nonce < before.deploy.nonce) throw new MevError(409, 'node_behind', '节点读到的 nonce 比已发出的部署交易还小（节点落后或没同步完），稍后重试');
        if (!before.deploy) {
          // 签名前按当前 nonce 再找一遍已部署的合约：有就沿用，读不全就不发（「没读到」不等于没有）。
          let found;
          try { found = await findDeployed(rpc, before, plan.nonce); } catch (cause) { if (at !== generation) throw new MevError(409, 'stale', '热钱包或节点刚被修改，刷新后重试'); throw new MevError(502, 'rpc', `读取链上状态失败：${errorText(cause)}`); }
          if (at !== generation || wallet !== before) throw new MevError(409, 'stale', '热钱包或节点刚被修改，刷新后重试');
          if (found === undefined) throw new MevError(502, 'rpc', '没能确认这个热钱包是否已经部署过合约（节点应答不全），稍后重试');
          if (found) { adopt(before, found, '沿用这个热钱包已部署的合约，地址'); return state(); }
        }
        if (plan.balance < plan.costWei) throw new MevError(409, 'low_balance', `热钱包余额 ${weiToEth(plan.balance).toFixed(6)} ETH 不够部署：按费用上限需要约 ${weiToEth(plan.costWei).toFixed(6)} ETH。给热钱包转入 ETH（Base 链）后重试`);
        if (shut) throw new MevError(503, 'stopping', '服务正在停止');
        const signed = signDeployment(plan, before.privateKey), priorError = error;
        // 先落盘再发送：发送结果不明时，重启后仍知道该去哪个地址核对。同一个 nonce 上不论哪一笔上链，合约地址都一样。
        const next: MevWallet = { ...before, deploy: { nonce: plan.nonce, hash: signed.hash, maxFeePerGas: plan.tx.maxFeePerGas.toString(), maxPriorityFeePerGas: plan.tx.maxPriorityFeePerGas.toString(), at: now() } };
        save(next); missing = 0; error = null;
        try { await client.request('eth_sendRawTransaction', [signed.raw]); } catch (cause) {
          // 节点明确拒收（不是超时或断连）：这一笔没有进交易池。恢复发送前的记录（首次发送即撤掉，可以马上重试；
          // 重发则保留原来那笔的哈希与时间），把拒收原因交给页面。链上 nonce 变化后会重新扫描已部署的合约。
          if (cause instanceof RpcError) {
            if (wallet === next) { save(before); scannedAt = null; error = before.deploy ? priorError : null; }
            hooks.log(`mev: 节点拒收部署交易 ${signed.hash}：${errorText(cause)}`);
            throw new MevError(502, 'rejected', `节点拒收部署交易：${errorText(cause)}`);
          }
          hooks.log(`mev: 部署交易 ${signed.hash} 发送结果不明：${errorText(cause)}`);
          if (wallet === next) error = '部署交易的发送结果不明（超时或断连），正在按合约地址核对；5 分钟后仍没有上链可以加价重发';
          return state();
        }
        hooks.log(`mev: 已发出部署交易 ${signed.hash}（nonce ${plan.nonce}）`);
        return state();
      } finally { busy = false; }
    },
    reset(body) {
      const before = pageWallet();
      confirmed(body, before);
      notLive();
      if (shut) throw new MevError(503, 'stopping', '服务正在停止');
      const address = addressOf(before.privateKey);
      // 留下合约地址（在途的部署留它将落在的地址）：同一把私钥与收款地址重新录入时沿用，不再部署一次。
      const executor = before.executor ?? (before.deploy ? contractAddress(address, before.deploy.nonce) : null);
      if (executor) writeKnown(dir, { operator: address, owner: before.owner, executor });
      save(null);
      error = null;
      hooks.log(`mev: 页面移除了热钱包 ${short(address)}`);
      say(`mev:reset:${address}:${now()}`, `【MEV 套利】页面移除了热钱包 ${address}。私钥已从服务器删除；链上的执行合约与钱包余额不受影响`);
      connect();
      return state();
    },
    rpc(body) {
      const before = pageWallet();
      notLive();
      if (shut) throw new MevError(503, 'stopping', '服务正在停止');
      const rpcUrl = parseRpcUrl(record(body).rpcUrl);
      const { rpcUrl: _old, ...rest } = before;
      save({ ...rest, ...(rpcUrl ? { rpcUrl } : {}) });
      hooks.log(`mev: 页面把节点改为 ${rpcHost(rpcUrl ?? DEFAULT_RPC_URL)}`);
      connect();
      return state();
    },
    failure(cause) {
      if (cause instanceof MevError) return { status: cause.status, body: { code: cause.code, message: cause.message }, internal: false };
      if (cause instanceof SettingsError) return { status: 400, body: { code: 'invalid_settings', message: cause.message }, internal: false };
      return { status: 500, body: { code: 'internal', message: 'MEV 套利模块内部错误' }, internal: true };
    },
  };

  return {
    views,
    engine: () => engine,
    /** 停服：不再签名与发送，中止在途的节点请求。已发出的交易留在库里，下次启动按回执、nonce 与区块号核对。 */
    shutdown(): void { shut = true; engine?.quiesce(); abort.abort(); },
    async loop(context: LoopContext): Promise<void> {
      try {
        while (!context.stopped() && !shut) {
          const at = generation;
          const started = identity() ? startEngine() : null;
          if (started) {
            if (at !== generation) { started.close(); continue; }
            engine = started;
            try { await started.loop({ stopped: () => context.stopped() || shut || generation !== at, pause: ms => context.pause(ms) }); }
            finally { if (engine === started) engine = null; started.close(); }
            continue;
          }
          if (!identity()) await poll();
          if (at === generation) await context.pause(identity() ? 5_000 : options.pollMs ?? SETUP_POLL_MS);
        }
      } finally { shut = true; engine?.quiesce(); engine = null; abort.abort(); if (!error) error = '服务正在停止'; }
    },
  };
}

export { WALLET_FILE };
