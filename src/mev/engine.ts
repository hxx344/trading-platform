// MEV 套利引擎（docs/mev.md）：按区块读池子状态、粗筛环路、用执行合约模拟定量，观察模式只记录，
// 实盘模式过风控后签名发送。实盘只存在内存里：服务重启后回到观察，须在页面重新开始。
// 私钥只在本文件签名时使用，不进日志、视图与错误文本。
import { AbiReader, addressOf, callData, isAddress, lower, quantity, selector, signTransaction, toQuantity } from './codec.ts';
import { DEFAULT_MIDDLE_TOKENS, FACTORIES, KIND_LABELS, START_TOKENS, USDC, WETH, type TokenInfo } from './chain.ts';
import { enumerateCycles, poolDepthUsd, rankCandidates, tokenPricesUsd, type Candidate, type Cycle } from './cycles.ts';
import { EXECUTOR_OWNER_OFFSETS, EXECUTOR_RUNTIME_CODE } from './executor-artifact.ts';
import { discoverPools, readPoolStates, readToken, MAX_TOKENS, type Pool, type PoolState } from './pools.ts';
import { gate, parseSettings, planTransaction, storedSettings, utcDayStart, weiToEth, type Plan, type Settings } from './risk.ts';
import type { RpcClient } from './rpc.ts';
import { MAX_OPEN_PER_NONCE, sendRecorded, settleOpen, type ChainAccount } from './sender.ts';
import { bestSize, estimateCosts, executeData } from './simulate.ts';
import type { MevStore, StoredOpportunity, StoredTx } from './store.ts';
import type { MevStateView } from './views.ts';

export class MevError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.name = 'MevError'; this.status = status; this.code = code; }
}

export interface MevEngineOptions {
  store: MevStore;
  /** 读链用的节点。 */
  rpc: RpcClient;
  /** 发交易用的节点（可以与读链相同）。 */
  sendRpc: RpcClient;
  chainId: bigint;
  executor: string;
  owner: string;
  privateKey: string;
  now?: () => number;
  log?: (line: string) => void;
  /** 飞书通知；同一个 key 只发一次。 */
  notify?: (key: string, text: string) => unknown;
  pollMs?: number;
}

/** 池子目录多久刷新一次。 */
export const DIRECTORY_REFRESH_MS = 10 * 60_000;
/** 节点最新区块的时间戳比本机慢超过这么多秒就不发现、不发送。 */
export const MAX_HEAD_LAG_SEC = 6;
/** 实盘中连续这么久没有一轮成功的读取就停实盘。 */
export const RPC_DOWN_HALT_MS = 60_000;
/** 一轮处理从读到区块算起超过这么久就不再发送（状态已旧）。 */
export const SEND_WINDOW_MS = 1_500;
/** deadlineBlock 取当前区块加几。 */
export const DEADLINE_BLOCKS = 2;
/** 节点连续拒绝发送多少次后停实盘。 */
export const SEND_REJECT_LIMIT = 3;
/** 模拟后没有任何一档盈利的环路，这么久之内不再模拟（现货价差多半来自很浅的池子，占着每区块的模拟名额）。 */
export const UNPROFITABLE_COOLDOWN_MS = 30_000;
/** 过期交易在这么久之内还按「可能仍在节点的交易池里」对待：同 nonce 的新交易以它的费用为底加价。更早的不再抬高底价；
 * 节点若仍留着它，会以 replacement underpriced 拒收，那时再按全部过期交易加价。 */
export const FEE_FLOOR_WINDOW_MS = 10 * 60_000;
/** 实盘中多久重新核对一次执行合约（owner 可能换掉了 operator）。 */
export const REVERIFY_MS = 10 * 60_000;
/** 定期核对连续多少次读不到结果才按核对不过处理。 */
export const REVERIFY_FAILURE_LIMIT = 3;
/** 同一条环路多久记一次机会（发送的那次不受限）。 */
const RECORD_EVERY_MS = 30_000;

const formatUnits = (value: bigint, decimals: number): string => {
  const negative = value < 0n, digits = (negative ? -value : value).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals), fraction = decimals ? digits.slice(digits.length - decimals).replace(/0+$/, '') : '';
  return `${negative ? '-' : ''}${whole}${fraction ? '.' + fraction : ''}`;
};
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);

/** 部署后的合约代码应有的样子：产物的 runtime 在各 immutable 处填入 owner。 */
export function expectedRuntimeCode(owner: string): string {
  let code = EXECUTOR_RUNTIME_CODE.slice(2);
  const padded = owner.slice(2).toLowerCase().padStart(64, '0');
  for (const offset of EXECUTOR_OWNER_OFFSETS) code = code.slice(0, offset * 2) + padded + code.slice(offset * 2 + 64);
  return '0x' + code;
}

export type MevEngine = ReturnType<typeof createMevEngine>;

export function createMevEngine({ store, rpc, sendRpc, chainId, executor: executorAddress, owner: ownerAddress, privateKey, now = Date.now, log = () => undefined, notify = () => undefined, pollMs = 500 }: MevEngineOptions) {
  if (!isAddress(executorAddress) || !isAddress(ownerAddress)) throw new TypeError('执行合约或 owner 地址无效');
  const executor = lower(executorAddress), owner = lower(ownerAddress), operator = addressOf(privateKey);

  let settings: Settings = storedSettings(store.readState('settings'));
  let consecutiveReverts = store.readState<number>('consecutiveReverts') ?? 0;
  let fault = store.readState<string | null>('fault') ?? null;
  let verification: { ok: boolean; reason: string | null; checkedAt: number } = { ok: false, reason: '尚未核对合约', checkedAt: 0 };
  let live = false, liveSince: number | null = null, haltReason: string | null = null, sendRejects = 0;
  let liveCommand = 0;
  /** 白名单每改一次加一：在途的目录刷新据此知道自己读的名单已经过时。 */
  let tokenGeneration = 0;
  /** 节点以 replacement underpriced 拒收过的 nonce：这个 nonce 上按全部过期交易加价。 */
  let underpricedNonce: number | null = null;
  let head: { number: number; timestamp: number; baseFee: bigint; seenAt: number } | null = null;
  let account: ChainAccount | null = null;
  let lagging = false, lastError: string | null = null, lastOkAt = 0;
  let pools: Pool[] = store.pools(), cycles: Cycle[] = [], directoryAt = 0, directoryError: string | null = null, directoryStale = true;
  let states = new Map<string, PoolState>(), prices = new Map<string, number>(), usable = new Set<string>();
  const recordedAt = new Map<string, number>(), cooldownUntil = new Map<string, number>();
  const counters = { blocks: 0, candidates: 0, simulated: 0 };

  // 首次启动：起始代币与默认的中间代币进白名单（中间代币的符号与精度在第一次刷新目录时从链上读）。
  if (!store.tokens().length) for (const token of START_TOKENS) store.putToken(token, now());
  let seedPending = store.readState<boolean>('seeded') !== true;

  // 库绑定热钱包：--set-mev 换了热钱包后，旧钱包留下的未结清交易按新钱包的 nonce 核对不出结论，这里直接结清
  // （旧钱包上它们最多因过期回滚、花旧钱包的 gas），连续回滚计数与故障记录也不带到新钱包；identityAt 之前入库的
  // 交易属于旧钱包，不参与新钱包的 nonce 比较。只换执行合约时 nonce 空间没变，未结清交易与故障照常核对。
  {
    const bound = store.readState<string>('identity');
    if (bound !== null && bound !== operator) {
      const stale = store.openTxs();
      store.transaction(() => { for (const tx of stale) store.settleTx(tx.hash, 'lost', now(), { error: '热钱包已更换，这笔交易不再核对' }); });
      consecutiveReverts = 0; fault = null;
      store.writeState('consecutiveReverts', 0, now()); store.writeState('fault', null, now());
      store.writeState('identityAt', now(), now());
      log(`mev: 热钱包已更换，结清旧钱包留下的 ${stale.length} 笔未结清交易`);
    }
    if (bound !== operator) store.writeState('identity', operator, now());
  }
  let verifyFailures = 0;
  let stopping = false;

  const tokenMap = (): Map<string, TokenInfo> => new Map(store.tokens().map(token => [token.address, token]));
  const persist = (key: string, value: unknown) => store.writeState(key, value, now());
  const say = (key: string, text: string) => { try { notify(key, text); } catch { /* 通知失败不影响引擎 */ } };

  function halt(reason: string): void {
    if (!live) return;
    live = false; liveSince = null; haltReason = reason;
    log(`mev: 实盘已停止：${reason}`);
    say(`mev:halt:${now()}`, `【MEV 套利已停止实盘】${reason}。模块回到观察模式；未结清的交易继续核对。在「MEV 套利」页处理后可重新开始`);
  }

  async function verify(tolerant = false): Promise<boolean> {
    const at = now(), command = liveCommand;
    try {
      const outcomes = await rpc.batch([
        { method: 'eth_chainId', params: [] },
        { method: 'eth_getCode', params: [executor, 'latest'] },
        { method: 'eth_call', params: [{ to: executor, data: selector('owner()') }, 'latest'] },
        { method: 'eth_call', params: [{ to: executor, data: selector('operator()') }, 'latest'] },
        ...FACTORIES.map(factory => ({ method: 'eth_call', params: [{ to: executor, data: callData('factoryKind(address)', ['address'], [factory.address]) }, 'latest'] })),
      ]);
      if (stopping || command !== liveCommand) return false;
      const value = (index: number): string => { const entry = outcomes[index]!; if (!entry.ok || typeof entry.result !== 'string') throw new MevError(502, 'verify', '读取执行合约失败（地址上可能不是执行合约）'); return entry.result; };
      // 读到明确不符：记下结论并停实盘（不在实盘时 halt 不做事）。之后即使又核对通过，也要用户重新开始。
      const fail = (reason: string) => { verification = { ok: false, reason, checkedAt: at }; halt(reason); return false; };
      if (quantity(value(0)) !== chainId) return fail(`节点的链号是 ${quantity(value(0))}，配置的是 ${chainId}`);
      if (value(1).toLowerCase() !== expectedRuntimeCode(owner)) return fail('执行合约的代码与本版本的产物不一致（或 owner 不是配置的地址）');
      if (new AbiReader(value(2)).address(0) !== owner) return fail('执行合约的 owner 不是配置的地址');
      if (new AbiReader(value(3)).address(0) !== operator) return fail('执行合约的 operator 不是配置的热钱包');
      for (const [index, factory] of FACTORIES.entries()) {
        if (new AbiReader(value(4 + index)).uint(0) !== BigInt(factory.kind)) return fail(`执行合约没有登记 ${KIND_LABELS[factory.kind]} 的工厂`);
      }
      verification = { ok: true, reason: null, checkedAt: at };
      verifyFailures = 0;
    } catch (error) {
      if (stopping || command !== liveCommand) return false;
      // 读不到不等于不符：实盘中的定期核对偶尔超时或缺项时沿用上一次通过的结论，下一轮再读；连续读不到才按不过处理。
      if (tolerant && verification.ok && ++verifyFailures < REVERIFY_FAILURE_LIMIT) { log(`mev: 定期核对合约没有读到结果（第 ${verifyFailures} 次），下一轮重试`); return true; }
      verification = { ok: false, reason: `核对合约失败：${errorText(error)}`, checkedAt: at };
    }
    if (!verification.ok) halt(verification.reason ?? '合约核对未通过');
    return verification.ok;
  }

  /** 只留两种代币都在白名单里的池子。 */
  const allowedPools = (list: readonly Pool[]): Pool[] => { const allowed = new Set(store.tokens().map(token => token.address)); return list.filter(pool => allowed.has(pool.token0) && allowed.has(pool.token1)); };
  const rebuildCycles = (): void => { cycles = enumerateCycles(pools, START_TOKENS.map(token => token.address)); cooldownUntil.clear(); recordedAt.clear(); };

  async function refreshDirectory(): Promise<void> {
    const at = now(), generation = tokenGeneration;
    try {
      if (seedPending) {
        for (const address of DEFAULT_MIDDLE_TOKENS) { const token = await readToken(rpc, address); if (token) store.putToken(token, at); }
        persist('seeded', true);
        seedPending = false;
      }
      const found = await discoverPools(rpc, store.tokens().map(token => token.address));
      store.replacePools(found, at);
      pools = found;
      directoryError = null;
    } catch (error) {
      // 刷新失败沿用上一份目录；下个周期再试。
      directoryError = errorText(error);
    }
    // 刷新失败沿用的旧目录、刷新期间白名单又变了的新目录，都按此刻的白名单过滤：移出的代币立即不再参与。
    pools = allowedPools(pools);
    rebuildCycles();
    directoryAt = at;
    // 刷新期间白名单变过：这份目录是按旧名单查的，下一轮重查。
    directoryStale = generation !== tokenGeneration;
  }

  /** 未结清交易按最坏情况预留的费用：同一个 nonce 上只可能有一笔上链，取其中最大的。 */
  function reservedWei(open: readonly StoredTx[]): bigint {
    const byNonce = new Map<number, bigint>();
    for (const tx of open) if (tx.worstCostWei > (byNonce.get(tx.nonce) ?? 0n)) byNonce.set(tx.nonce, tx.worstCostWei);
    let total = 0n;
    for (const value of byNonce.values()) total += value;
    return total;
  }

  const pathText = (cycle: Cycle, tokens: ReadonlyMap<string, TokenInfo>): string =>
    [cycle.hops[0]!.tokenIn, ...cycle.hops.map(hop => hop.tokenOut)].map(address => tokens.get(address)?.symbol ?? address.slice(0, 8)).join(' → ')
    + `（${cycle.hops.map(hop => KIND_LABELS[hop.pool.kind]).join('、')}）`;

  async function settle(at: number): Promise<void> {
    const result = await settleOpen(rpc, store, operator, executor, at);
    account = result.account;
    for (const { status } of result.settled) {
      if (status === 'success') consecutiveReverts = 0;
      else if (status === 'reverted') consecutiveReverts++;
    }
    if (result.settled.some(entry => entry.status === 'success' || entry.status === 'reverted')) persist('consecutiveReverts', consecutiveReverts);
    if (result.fault) { fault = result.fault; persist('fault', fault); halt(result.fault); }
    if (consecutiveReverts >= settings.maxConsecutiveReverts) halt(`连续 ${consecutiveReverts} 笔上链回滚`);
    if (weiToEth(account.balance) < settings.minWalletEth) halt(`热钱包余额 ${weiToEth(account.balance).toFixed(6)} ETH 低于下限 ${settings.minWalletEth}`);
  }

  async function consider(candidate: Candidate, block: { number: number; baseFee: bigint; seenAt: number }, tokens: ReadonlyMap<string, TokenInfo>, sentThisBlock: { value: boolean }): Promise<void> {
    const { cycle } = candidate, start = tokens.get(cycle.start), unitUsd = prices.get(cycle.start), ethUnit = prices.get(WETH);
    if (!start || unitUsd === undefined || ethUnit === undefined || !account) return;
    const startUsd = unitUsd * 10 ** start.decimals, ethUsd = ethUnit * 1e18;
    const target = { executor, operator, cycle, deadlineBlock: BigInt(block.number + DEADLINE_BLOCKS), block: toQuantity(block.number) };
    counters.simulated++;
    const { best } = await bestSize(rpc, target, startUsd, start.decimals, settings.maxNotionalUsd);
    if (!best) { cooldownUntil.set(cycle.id, now() + UNPROFITABLE_COOLDOWN_MS); return; }
    const costs = await estimateCosts(rpc, target, best.amountIn, chainId);
    if (!costs) return;
    const open = store.openTxs();
    const atNonce = open.filter(tx => tx.nonce === account!.nonce);
    // 加价的底：近期的同 nonce 交易可能还在节点的交易池里。久远的不再抬高底价，否则一笔高小费的过期交易会让之后的
    // 小机会永远「净利不足」；节点真的还留着它时会拒收，underpricedNonce 记下后改按全部加价。
    const floorFrom = underpricedNonce === account.nonce ? atNonce : atNonce.filter(tx => now() - tx.createdAt < FEE_FLOOR_WINDOW_MS);
    const feeFloor = floorFrom.length ? {
      maxFeePerGas: floorFrom.reduce((max, tx) => tx.maxFeePerGas > max ? tx.maxFeePerGas : max, 0n),
      maxPriorityFeePerGas: floorFrom.reduce((max, tx) => tx.maxPriorityFeePerGas > max ? tx.maxPriorityFeePerGas : max, 0n),
    } : undefined;
    const plan: Plan = planTransaction({ profit: best.profit, startDecimals: start.decimals, startUsd, ethUsd, gasEstimate: costs.gas, baseFee: block.baseFee, l1Fee: costs.l1Fee, settings, ...(feeFloor ? { feeFloor } : {}) });
    const at = now();
    const entry: Omit<StoredOpportunity, 'id'> = {
      at, block: block.number, cycleId: cycle.id, path: pathText(cycle, tokens), start: cycle.start, edgeBps: candidate.edgeBps, amountIn: best.amountIn, profit: best.profit,
      profitUsd: plan.profitUsd, costUsd: plan.costUsd, netUsd: plan.netUsd, outcome: 'observed', reason: null,
    };
    const record = (outcome: StoredOpportunity['outcome'], reason: string | null): void => {
      if (at - (recordedAt.get(cycle.id) ?? 0) < RECORD_EVERY_MS) return;
      recordedAt.set(cycle.id, at);
      store.addOpportunity({ ...entry, outcome, reason });
    };
    if (!plan.ok) return record('thin', plan.reason);
    if (!live || stopping) return record('observed', null);
    if (sentThisBlock.value) return record('blocked', '本区块已发送一笔');
    if (at - block.seenAt > SEND_WINDOW_MS) return record('blocked', '模拟完成时区块状态已旧');
    if (open.some(tx => tx.status !== 'expired')) return record('blocked', '上一笔交易还没有结论');
    if (open.some(tx => tx.nonce !== account!.nonce)) return record('blocked', '有 nonce 对不上的未结清交易，等待核对');
    // 白名单在本轮开始之后可能被改过：路径上的代币以此刻的名单为准。
    const allowedNow = new Set(store.tokens().map(token => token.address));
    if (!cycle.hops.every(hop => allowedNow.has(hop.tokenIn) && allowedNow.has(hop.tokenOut))) return record('blocked', '路径上的代币已移出白名单');
    // 回执与账户读数可能来自高度不同的后端：读到的 nonce 不比本模块已上链的大，说明读数是旧的，这一轮不发。
    const mined = store.maxMinedNonce();
    if (mined !== null && account.nonce <= mined) return record('blocked', '节点返回的 nonce 落后于已上链的交易，等待下一轮');
    // 只数本次实盘会话里过期的：熔断后用户处理完节点或费用问题、重新开始实盘，可以在这个 nonce 上再试。
    const expiredThisSession = atNonce.filter(tx => liveSince !== null && tx.createdAt >= liveSince).length;
    if (expiredThisSession >= MAX_OPEN_PER_NONCE) { halt(`同一个 nonce 上本次实盘已有 ${expiredThisSession} 笔交易过期未上链，费用或节点可能有问题`); return record('blocked', '同一 nonce 过期交易过多'); }
    const { feeWei: spentTodayWei } = store.settledSince(utcDayStart(at));
    const blocked = gate({ settings, spentTodayWei, reservedWei: reservedWei(open), worstCostWei: plan.worstCostWei, walletWei: account.balance, consecutiveReverts });
    if (blocked) { if (blocked.halt) halt(blocked.reason); return record('blocked', blocked.reason); }

    const signed = signTransaction({
      chainId, nonce: BigInt(account.nonce), maxPriorityFeePerGas: plan.maxPriorityFeePerGas, maxFeePerGas: plan.maxFeePerGas, gasLimit: plan.gasLimit,
      to: executor, value: 0n, data: executeData(cycle, best.amountIn, plan.minProfit, target.deadlineBlock),
    }, privateKey);
    // 先入库再发送：进程在两步之间退出时，重启后这笔按结果不明核对，不会凭空多出一笔不在台账里的交易。
    store.transaction(() => {
      const opportunityId = store.addOpportunity({ ...entry, outcome: 'sent', reason: null });
      recordedAt.set(cycle.id, at);
      store.recordTx({ hash: signed.hash, nonce: account!.nonce, raw: signed.raw, createdAt: at, deadlineBlock: block.number + DEADLINE_BLOCKS, maxFeePerGas: plan.maxFeePerGas,
        maxPriorityFeePerGas: plan.maxPriorityFeePerGas, worstCostWei: plan.worstCostWei, opportunityId, start: cycle.start, path: entry.path, expectedProfit: best.profit });
    });
    sentThisBlock.value = true;
    const sent = await sendRecorded(sendRpc, store, signed);
    if (sent.accepted) { sendRejects = 0; log(`mev: 已发送 ${signed.hash}，预期净利 ${plan.netUsd.toFixed(4)} 美元`); return; }
    log(`mev: 发送 ${signed.hash} 没有被确认接受：${sent.error}`);
    if (sent.rejected && /underpriced/i.test(sent.error ?? '')) underpricedNonce = account.nonce;
    if (sent.rejected && ++sendRejects >= SEND_REJECT_LIMIT) halt(`节点连续 ${sendRejects} 次拒绝发送：${sent.error}`);
  }

  function dailySummary(at: number): void {
    const today = utcDayStart(at), last = store.readState<number>('summaryDay');
    if (last === today) return;
    persist('summaryDay', today);
    if (last === null) return;
    const all = store.settledSince(today - 86_400_000), todayPart = store.settledSince(today);
    const success = all.success - todayPart.success, reverted = all.reverted - todayPart.reverted, feeWei = all.feeWei - todayPart.feeWei;
    if (!success && !reverted) return;
    const tokens = tokenMap();
    const profits = [...all.profits].map(([address, amount]) => { const token = tokens.get(address), net = amount - (todayPart.profits.get(address) ?? 0n); return token && net > 0n ? `${formatUnits(net, token.decimals)} ${token.symbol}` : null; }).filter(Boolean);
    say(`mev:daily:${today}`, `【MEV 套利日汇总】昨日（UTC）上链 ${success + reverted} 笔：成功 ${success}、回滚 ${reverted}；gas 支出 ${weiToEth(feeWei).toFixed(6)} ETH；利润 ${profits.join('、') || '无'}`);
  }

  /** 一轮：有新区块才做事。返回是否处理了新区块。 */
  async function tick(): Promise<boolean> {
    const at = now();
    if (live && lastOkAt && at - lastOkAt > RPC_DOWN_HALT_MS) halt(`节点已 ${Math.round((at - lastOkAt) / 1000)} 秒没有成功应答`);
    if (!verification.ok && at - verification.checkedAt >= 60_000) await verify();
    const raw = await rpc.request('eth_getBlockByNumber', ['latest', false]) as Record<string, unknown> | null;
    if (!raw || typeof raw !== 'object') throw new TypeError('节点没有返回最新区块');
    const block = { number: Number(quantity(raw.number)), timestamp: Number(quantity(raw.timestamp)), baseFee: quantity(raw.baseFeePerGas), seenAt: at };
    lastOkAt = at; lastError = null;
    if (head && block.number <= head.number) return false;
    head = block;
    counters.blocks++;
    lagging = at / 1000 - block.timestamp > MAX_HEAD_LAG_SEC;
    dailySummary(at);
    // 未结清的交易不论合约核对是否通过都继续核对：预留的费用不会一直占着。
    await settle(at);
    if (live && at - verification.checkedAt >= REVERIFY_MS) await verify(true);
    if (!verification.ok) return true;
    if (directoryStale || at - directoryAt >= DIRECTORY_REFRESH_MS) { await refreshDirectory(); store.prune(at); return true; }
    if (lagging || !pools.length) return true;
    const tag = toQuantity(block.number);
    states = await readPoolStates(rpc, pools, tag);
    prices = tokenPricesUsd(pools, states, USDC);
    usable = new Set(pools.filter(pool => poolDepthUsd(pool, states.get(pool.address), prices) >= settings.minDepthUsd).map(pool => pool.address));
    for (const [id, until] of cooldownUntil) if (until <= at) cooldownUntil.delete(id);
    const candidates = rankCandidates(cycles, states, usable, settings.minEdgeBps, settings.maxSimulationsPerBlock + cooldownUntil.size)
      .filter(candidate => !cooldownUntil.has(candidate.cycle.id)).slice(0, settings.maxSimulationsPerBlock);
    counters.candidates += candidates.length;
    if (!candidates.length) return true;
    const tokens = tokenMap(), sentThisBlock = { value: false };
    for (const candidate of candidates) await consider(candidate, block, tokens, sentThisBlock);
    return true;
  }

  const requireBody = (body: unknown): Record<string, unknown> => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new MevError(400, 'invalid_body', '请求体须为对象');
    return body as Record<string, unknown>;
  };

  const views = {
    state(): MevStateView {
      const at = now(), tokens = tokenMap(), today = store.settledSince(utcDayStart(at)), open = store.openTxs();
      const amount = (value: bigint | null, address: string): string | null => { const token = tokens.get(address); return value === null ? null : token ? formatUnits(value, token.decimals) : value.toString(); };
      const usd = (value: bigint | null, address: string): number | null => { const token = tokens.get(address), unit = prices.get(address); return value === null || !token || unit === undefined ? null : Number(value) * unit; };
      return {
        checkedAt: at, chainId: Number(chainId), executor, owner, operator,
        mode: live ? 'live' : 'observe', liveSince, haltReason, fault, verification,
        head: head ? { number: head.number, ageSec: Math.max(0, Math.round(at / 1000 - head.timestamp)), baseFeeGwei: Number(head.baseFee) / 1e9 } : null,
        lagging, rpcError: lastError, lastOkAt: lastOkAt || null,
        wallet: account ? { eth: weiToEth(account.balance), nonce: account.nonce } : null,
        today: {
          gasSpentEth: weiToEth(today.feeWei), reservedEth: weiToEth(reservedWei(open)), budgetEth: settings.dailyGasBudgetEth, success: today.success, reverted: today.reverted,
          profits: [...today.profits].map(([address, value]) => ({ symbol: tokens.get(address)?.symbol ?? address, amount: amount(value, address), usd: usd(value, address) })),
          observed: store.opportunityStats(utcDayStart(at)),
        },
        totals: store.txTotals(), consecutiveReverts, counters, settings,
        tokens: [...tokens.values()].map(token => ({ ...token, start: START_TOKENS.some(entry => entry.address === token.address), priceUsd: prices.has(token.address) ? prices.get(token.address)! * 10 ** token.decimals : null })),
        directory: { at: directoryAt || null, error: directoryError, pools: pools.length, usable: usable.size, cycles: cycles.length },
        pools: pools.map(pool => ({
          address: pool.address, kind: KIND_LABELS[pool.kind], token0: tokens.get(pool.token0)?.symbol ?? pool.token0, token1: tokens.get(pool.token1)?.symbol ?? pool.token1,
          feePpm: pool.feePpm, depthUsd: poolDepthUsd(pool, states.get(pool.address), prices), usable: usable.has(pool.address),
        })).sort((left, right) => right.depthUsd - left.depthUsd),
        opportunities: store.recentOpportunities(60).map(entry => ({
          id: entry.id, at: entry.at, block: entry.block, path: entry.path, edgeBps: entry.edgeBps, amountIn: amount(entry.amountIn, entry.start), symbol: tokens.get(entry.start)?.symbol ?? '',
          profit: amount(entry.profit, entry.start), profitUsd: entry.profitUsd, costUsd: entry.costUsd, netUsd: entry.netUsd, outcome: entry.outcome, reason: entry.reason,
        })),
        transactions: store.recentTxs(60).map(tx => ({
          hash: tx.hash, nonce: tx.nonce, createdAt: tx.createdAt, deadlineBlock: tx.deadlineBlock, status: tx.status, path: tx.path, symbol: tokens.get(tx.start)?.symbol ?? '',
          expectedProfit: amount(tx.expectedProfit, tx.start), profit: amount(tx.profit, tx.start), profitUsd: usd(tx.profit, tx.start),
          feeEth: tx.feeWei === null ? null : weiToEth(tx.feeWei), block: tx.block, settledAt: tx.settledAt, error: tx.error,
        })),
      };
    },
    /** 保存整份风控参数。 */
    settings(body: unknown): unknown {
      const next = parseSettings(requireBody(body).settings);
      settings = next;
      persist('settings', next);
      return { settings };
    },
    /** 开始实盘：重新核对合约，清掉上次的熔断原因与故障记录（页面的确认提示里已把它们给用户看过）。 */
    async start(body: unknown): Promise<unknown> {
      const seen = requireBody(body);
      if (seen.confirm !== operator) throw new MevError(400, 'confirm_required', '须带上热钱包地址确认');
      if (stopping) throw new MevError(503, 'stopping', '服务正在停止');
      if (live) return { mode: 'live' };
      const command = ++liveCommand;
      const verified = await verify();
      if (stopping) throw new MevError(503, 'stopping', '服务正在停止');
      if (command !== liveCommand) throw new MevError(409, 'stale', '核对期间已有新的启停操作，请刷新后重新确认');
      if (!verified || !verification.ok) throw new MevError(409, 'not_verified', verification.reason ?? '合约核对未通过');
      if (!account || !head) throw new MevError(409, 'not_ready', '还没有读到链上状态，稍后再试');
      if (lagging) throw new MevError(409, 'lagging', '节点的最新区块落后，暂不能开始');
      if (weiToEth(account.balance) < settings.minWalletEth) throw new MevError(409, 'low_balance', `热钱包余额低于下限 ${settings.minWalletEth} ETH`);
      // 确认要绑定操作者看到的状态：页面数据可能是几秒前的，另一个标签页可能停在故障发生之前。
      // 请求带上页面所见的故障记录与停止原因，和现在的不一样就不清除、不开始，让页面刷新后重新确认。
      if ((seen.fault ?? null) !== fault || (seen.haltReason ?? null) !== haltReason) throw new MevError(409, 'stale', '页面上的故障记录或停止原因已不是最新的，请刷新后重新确认');
      consecutiveReverts = 0; sendRejects = 0; fault = null; haltReason = null;
      persist('consecutiveReverts', 0); persist('fault', null);
      live = true; liveSince = now();
      log('mev: 实盘开始');
      say(`mev:start:${liveSince}`, `【MEV 套利开始实盘】热钱包 ${operator}，余额 ${weiToEth(account.balance).toFixed(6)} ETH，每日 gas 预算 ${settings.dailyGasBudgetEth} ETH`);
      return { mode: 'live' };
    },
    stop(): unknown {
      // 观察模式也可能有等待节点核对的开始请求。
      liveCommand++;
      if (live) { live = false; liveSince = null; haltReason = '用户停止'; log('mev: 用户停止实盘'); say(`mev:stop:${now()}`, '【MEV 套利已停止实盘】用户在页面停止；未结清的交易继续核对'); }
      return { mode: 'observe' };
    },
    /** 增删白名单里的中间代币；起始代币不能删。 */
    async tokens(body: unknown): Promise<unknown> {
      const { action, address } = requireBody(body);
      if (!isAddress(address)) throw new MevError(400, 'invalid_address', '代币地址无效');
      const target = lower(address);
      if (START_TOKENS.some(token => token.address === target)) throw new MevError(400, 'start_token', '起始代币固定在白名单里');
      if (action === 'remove') {
        if (!store.removeToken(target)) throw new MevError(404, 'not_found', '白名单里没有这个代币');
      } else if (action === 'add') {
        if (store.tokens().length >= MAX_TOKENS) throw new MevError(409, 'too_many', `白名单最多 ${MAX_TOKENS} 个代币`);
        let token: TokenInfo | null;
        try { token = await readToken(rpc, target); } catch (error) { throw new MevError(502, 'rpc', `读取代币失败：${errorText(error)}`); }
        if (!token) throw new MevError(400, 'not_token', '这个地址上读不到 ERC-20 的符号与精度');
        store.putToken(token, now());
      } else throw new MevError(400, 'invalid_action', 'action 须为 add 或 remove');
      // 移出立即生效：内存里的目录与环路当场按新名单过滤，不等目录刷新成功。加入的代币等下一次刷新查到池子。
      tokenGeneration++;
      directoryStale = true;
      if (action === 'remove') { pools = allowedPools(pools); rebuildCycles(); }
      return { tokens: store.tokens() };
    },
  };

  return {
    views, tick, verify, operator,
    /** 停服：不再发新交易，不发通知。之后在途的节点请求由调用方中止。 */
    quiesce(): void { stopping = true; live = false; liveSince = null; },
    isLive: (): boolean => live,
    async loop(context: { stopped(): boolean; pause(ms: number): Promise<void> }): Promise<void> {
      await verify();
      let failures = 0;
      while (!context.stopped()) {
        const started = now();
        try { await tick(); failures = 0; } catch (error) {
          lastError = errorText(error);
          if (++failures === 1 || failures % 60 === 0) log(`mev: 本轮失败（连续 ${failures} 次）：${lastError}`);
        }
        // 下一轮从本轮开始时刻起算，扣掉本轮耗时；连续失败时放慢，最长 5 秒。
        const interval = failures ? Math.min(5_000, pollMs * 2 ** Math.min(failures, 4)) : pollMs;
        await context.pause(Math.max(50, interval - (now() - started)));
      }
    },
    close(): void { store.close(); },
  };
}
