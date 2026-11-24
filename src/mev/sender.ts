// 交易的发送与结清（docs/mev.md 第 1.4 节）。规则：
// - 交易先入库再发送；发送结果不明或被节点拒绝都记为 unknown，不换 nonce 重发，等链上给结论。
// - 结论只来自同一批读取里的三样：回执、热钱包的已上链交易数（nonce）、节点的最新区块号。
//   没有回执不等于没上链：nonce 没被占用且节点区块已越过 deadlineBlock 加宽限，才记为 expired
//   （此后上链只会因过期回滚）；nonce 已被占用却连续多次查不到本模块任何一笔的回执，才记为 lost 并报故障。
import { AbiReader, lower, quantity } from './codec.ts';
import { RpcError, type RpcClient } from './rpc.ts';
import { EXECUTED_TOPIC } from './simulate.ts';
import type { MevStore, StoredTx, TxStatus } from './store.ts';

/** 过了 deadlineBlock 之后再等多少个区块才认定过期（Base 约 2 秒一块）。 */
export const EXPIRE_GRACE_BLOCKS = 15;
/** nonce 已被占用但没有回执时，连续查多少轮才认定不是本模块的交易。 */
export const MISSING_LIMIT = 5;
/** 同一个 nonce 上最多留几笔未结清（过期后替换）的交易。 */
export const MAX_OPEN_PER_NONCE = 3;

export interface ChainAccount { head: number; nonce: number; balance: bigint }
export interface Settled { tx: StoredTx; status: TxStatus }
export interface SettleResult { account: ChainAccount; settled: Settled[]; fault: string | null }

interface Receipt { status: TxStatus; block: number; feeWei: bigint; profit: bigint | null }

function parseReceipt(raw: unknown, hash: string, executor: string): Receipt | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object') throw new TypeError('回执格式无效');
  const receipt = raw as Record<string, unknown>;
  if (typeof receipt.transactionHash !== 'string' || lower(receipt.transactionHash) !== hash) throw new TypeError('回执的交易哈希对不上');
  if (receipt.status !== '0x1' && receipt.status !== '0x0') throw new TypeError('回执没有状态');
  const l1Fee = receipt.l1Fee === undefined || receipt.l1Fee === null ? 0n : quantity(receipt.l1Fee);
  const feeWei = quantity(receipt.gasUsed) * quantity(receipt.effectiveGasPrice) + l1Fee;
  let profit: bigint | null = null;
  if (receipt.status === '0x1' && Array.isArray(receipt.logs)) for (const log of receipt.logs as Record<string, unknown>[]) {
    if (typeof log?.address !== 'string' || lower(log.address) !== executor || !Array.isArray(log.topics) || log.topics[0] !== EXECUTED_TOPIC || typeof log.data !== 'string') continue;
    profit = new AbiReader(log.data).uint(32);
  }
  return { status: receipt.status === '0x1' ? 'success' : 'reverted', block: Number(quantity(receipt.blockNumber)), feeWei, profit };
}

/** 读一次账户与全部未结清交易的回执，并把能下结论的结清。传输失败或应答无效时抛出，库不变。 */
export async function settleOpen(rpc: RpcClient, store: MevStore, operator: string, executor: string, now: number, timeoutMs?: number): Promise<SettleResult> {
  const open = store.openTxs();
  const outcomes = await rpc.batch([
    { method: 'eth_blockNumber', params: [] },
    { method: 'eth_getTransactionCount', params: [operator, 'latest'] },
    { method: 'eth_getBalance', params: [operator, 'latest'] },
    ...open.map(tx => ({ method: 'eth_getTransactionReceipt', params: [tx.hash] })),
  ], timeoutMs);
  for (const entry of outcomes) if (!entry.ok) throw entry.error;
  const results = outcomes.map(entry => (entry as { result: unknown }).result);
  const account: ChainAccount = { head: Number(quantity(results[0])), nonce: Number(quantity(results[1])), balance: quantity(results[2]) };
  // 先把全部回执解析完再动库：任何一份无效都整轮不结清。
  const receipts = open.map((tx, index) => parseReceipt(results[3 + index], tx.hash, executor));
  const settled: Settled[] = [];
  let fault: string | null = null;
  // 库里已上链的最大 nonce：回执与账户读数可能来自高度不同的后端，本模块自己上过链的 nonce 不会是「被别人占用」。
  const ownMined = store.maxMinedNonce() ?? -1;
  store.transaction(() => {
    const minedNonces = new Set<number>();
    open.forEach((tx, index) => {
      const receipt = receipts[index];
      if (!receipt) return;
      store.settleTx(tx.hash, receipt.status, now, { block: receipt.block, feeWei: receipt.feeWei, profit: receipt.profit, error: tx.error });
      settled.push({ tx, status: receipt.status });
      minedNonces.add(tx.nonce);
    });
    open.forEach((tx, index) => {
      if (receipts[index]) return;
      if (minedNonces.has(tx.nonce) || tx.nonce <= ownMined) { store.settleTx(tx.hash, 'replaced', now, { error: tx.error }); settled.push({ tx, status: 'replaced' }); return; }
      if (tx.nonce < account.nonce) {
        // nonce 已被占用，但这一笔没有回执：可能是回执索引滞后，也可能是别的交易占了这个 nonce。
        const checks = tx.missingChecks + 1;
        if (checks < MISSING_LIMIT) { store.setMissingChecks(tx.hash, checks); return; }
        store.settleTx(tx.hash, 'lost', now, { error: '该 nonce 已被占用，但查不到本模块这笔交易的回执' });
        settled.push({ tx, status: 'lost' });
        fault = `热钱包的 nonce ${tx.nonce} 被不属于本模块的交易占用（或节点丢了回执）。这把钥匙可能在别处被使用，请核对后再开始实盘`;
        return;
      }
      if (tx.missingChecks) store.setMissingChecks(tx.hash, 0);
      if (tx.status !== 'expired' && account.head > tx.deadlineBlock + EXPIRE_GRACE_BLOCKS) { store.setTxStatus(tx.hash, 'expired', tx.error); settled.push({ tx, status: 'expired' }); }
    });
  });
  return { account, settled, fault };
}

/** 发出一笔已入库的交易。返回节点是否接受；不接受或结果不明时状态记为 unknown，由 settleOpen 给结论。 */
export async function sendRecorded(rpc: RpcClient, store: MevStore, tx: { hash: string; raw: string }, timeoutMs?: number): Promise<{ accepted: boolean; error: string | null; rejected: boolean }> {
  try {
    await rpc.request('eth_sendRawTransaction', [tx.raw], timeoutMs);
    store.setTxStatus(tx.hash, 'sent');
    return { accepted: true, error: null, rejected: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    // 节点说已经有这笔交易：之前那次发送其实到了。
    if (error instanceof RpcError && /already known|known transaction|already imported/i.test(message)) { store.setTxStatus(tx.hash, 'sent'); return { accepted: true, error: null, rejected: false }; }
    store.setTxStatus(tx.hash, 'unknown', message.slice(0, 200));
    return { accepted: false, error: message.slice(0, 200), rejected: error instanceof RpcError };
  }
}
