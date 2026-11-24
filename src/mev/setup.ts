// 页面启用（docs/mev.md 第 6 节）：热钱包私钥、收款地址与节点地址由页面录入，存在数据目录的 mev-wallet.json
// （服务账户 600，服务对 config.json 与密钥文件没有写权限）；执行合约由热钱包自己部署。
// 这里的任何报错与返回值都不带私钥或节点地址原文。
import { closeSync, fsyncSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { keccak256 } from '../aster/eip712.ts';
import { GAS_PRICE_ORACLE } from './chain.ts';
import { AbiReader, addressOf, bytesOf, callData, concatBytes, hexOf, isAddress, lower, minimalBytes, quantity, rlpEncode, signTransaction, unsignedTransaction, type Eip1559Transaction } from './codec.ts';
import { deploymentData } from './deploy-data.ts';
import { MevError } from './engine.ts';
import { MIN_TIP_WEI } from './risk.ts';
import type { RpcClient } from './rpc.ts';
import { validRpcUrl } from '../service/mev-config.ts';

export const WALLET_FILE = 'mev-wallet.json';
/** 没填节点地址时用的 Base 官方公共节点：有限速，够启用与观察，实盘建议换成自己的。 */
export const DEFAULT_RPC_URL = 'https://mainnet.base.org';
/** 部署交易发出后多久还没上链，才允许在同一个 nonce 上加价重发。 */
export const REDEPLOY_AFTER_MS = 5 * 60_000;

export interface PendingDeploy { nonce: number; hash: string; maxFeePerGas: string; maxPriorityFeePerGas: string; at: number }
export interface MevWallet {
  privateKey: string;
  /** 利润收款地址，也是执行合约的 owner。 */
  owner: string;
  /** 没有就用 DEFAULT_RPC_URL。 */
  rpcUrl?: string;
  /** 部署完成并核对过代码后才有。 */
  executor?: string;
  deploy?: PendingDeploy;
}

const validWallet = (value: unknown): value is MevWallet => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>, deploy = raw.deploy as Record<string, unknown> | undefined;
  return typeof raw.privateKey === 'string' && /^0x[0-9a-fA-F]{64}$/.test(raw.privateKey) && isAddress(raw.owner)
    && (raw.rpcUrl === undefined || validRpcUrl(raw.rpcUrl)) && (raw.executor === undefined || isAddress(raw.executor))
    && (deploy === undefined || (!!deploy && typeof deploy === 'object' && Number.isSafeInteger(deploy.nonce) && typeof deploy.hash === 'string'
      && typeof deploy.maxFeePerGas === 'string' && typeof deploy.maxPriorityFeePerGas === 'string' && Number.isFinite(deploy.at)));
};

/** 没有文件返回 null；读不懂时抛错（不带文件内容）。 */
export function readWallet(dir: string): MevWallet | null {
  let text: string;
  try { text = readFileSync(join(dir, WALLET_FILE), 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`读不到 ${WALLET_FILE}`);
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error(`${WALLET_FILE} 不是有效的 JSON`); }
  if (!validWallet(value)) throw new Error(`${WALLET_FILE} 的内容无效`);
  return value;
}

/** 写钱包文件中途被杀会留下带私钥的临时文件：启动时与移除时清掉。 */
export function cleanWalletTemps(dir: string): void {
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) if (name.startsWith(`${WALLET_FILE}.`) && name.endsWith('.tmp')) rmSync(join(dir, name), { force: true });
}

/** 先写临时文件（落盘）再改名：中途断电或被杀时，钱包文件要么是旧内容要么是新内容。 */
export function writeWallet(dir: string, wallet: MevWallet): void {
  const file = join(dir, WALLET_FILE), temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const handle = openSync(temp, 'wx', 0o600);
    try { writeSync(handle, `${JSON.stringify(wallet)}\n`); fsyncSync(handle); } finally { closeSync(handle); }
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw new Error(`写不了 ${WALLET_FILE}：${(error as NodeJS.ErrnoException).code ?? '未知错误'}`);
  }
}

export function removeWallet(dir: string): void { rmSync(join(dir, WALLET_FILE), { force: true }); cleanWalletTemps(dir); }

/** 移除热钱包时留下的合约地址（不含私钥）：同一把私钥与收款地址重新录入时先核对它，不受「最近几个 nonce」的限制。 */
export const KNOWN_FILE = 'mev-contract.json';
export interface KnownContract { operator: string; owner: string; executor: string }
export function readKnown(dir: string): KnownContract | null {
  try {
    const value = JSON.parse(readFileSync(join(dir, KNOWN_FILE), 'utf8')) as Record<string, unknown>;
    return isAddress(value.operator) && isAddress(value.owner) && isAddress(value.executor) ? { operator: lower(value.operator), owner: lower(value.owner), executor: lower(value.executor) } : null;
  } catch { return null; }
}
export function writeKnown(dir: string, known: KnownContract): void {
  try { writeFileSync(join(dir, KNOWN_FILE), `${JSON.stringify(known)}\n`, { mode: 0o600 }); } catch { /* 只是省一次部署费用的线索，写不了不影响移除 */ }
}

/** CREATE 部署出的合约地址只由发送方与 nonce 决定：同一个 nonce 上不论哪一笔部署交易上链，地址都是它。 */
export function contractAddress(sender: string, nonce: number): string {
  return hexOf(keccak256(rlpEncode([bytesOf(lower(sender)), minimalBytes(BigInt(nonce))])).subarray(12));
}

export interface SetupInput { privateKey: string; owner: string; rpcUrl?: string }

/** 页面提交的启用表单。`others` 是本服务其他用途的钱包地址：热钱包必须专用。 */
export function parseSetup(body: unknown, others: readonly string[]): SetupInput {
  const raw = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const key = typeof raw.privateKey === 'string' ? raw.privateKey.trim() : '';
  const privateKey = /^[0-9a-fA-F]{64}$/.test(key) ? `0x${key}` : key;
  let operator: string;
  try {
    if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('format');
    operator = addressOf(privateKey);
  } catch { throw new MevError(400, 'invalid_key', '私钥格式无效：须为 64 位十六进制（可带 0x）'); }
  const owner = typeof raw.owner === 'string' ? raw.owner.trim() : '';
  if (!isAddress(owner) || /^0x0{40}$/.test(owner)) throw new MevError(400, 'invalid_owner', '收款地址须为 0x 开头的 40 位十六进制地址');
  if (lower(owner) === operator) throw new MevError(400, 'same_wallet', '收款地址不能是热钱包自己：利润要转到另一个由你保管的地址');
  if (others.some(address => lower(address) === operator)) throw new MevError(400, 'shared_wallet', '这把私钥已在本平台的其他账户上使用；热钱包必须专用');
  const rpcUrl = parseRpcUrl(raw.rpcUrl);
  return { privateKey, owner: lower(owner), ...(rpcUrl ? { rpcUrl } : {}) };
}

/** 空表示用默认公共节点。 */
export function parseRpcUrl(value: unknown): string | undefined {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return undefined;
  const text = typeof value === 'string' ? value.trim() : value;
  if (!validRpcUrl(text)) throw new MevError(400, 'invalid_rpc', '节点地址须为 https 地址（本机或内网自建节点可用 http）');
  return text;
}

export const rpcHost = (url: string): string => { try { return new URL(url).host; } catch { return '—'; } };

export interface DeployPlan { tx: Eip1559Transaction; costWei: bigint; balance: bigint; nonce: number }

/** 估出部署交易的 gas 与费用上限；`floor` 是同一个 nonce 上已发过的那一笔，替换时两项费用各加 25% 以上。 */
export async function planDeployment(rpc: RpcClient, wallet: MevWallet, chainId: bigint, floor?: PendingDeploy): Promise<DeployPlan> {
  const operator = addressOf(wallet.privateKey), data = deploymentData(wallet.owner, operator);
  const first = await rpc.batch([
    { method: 'eth_getBlockByNumber', params: ['latest', false] },
    { method: 'eth_getTransactionCount', params: [operator, 'latest'] },
    { method: 'eth_getBalance', params: [operator, 'latest'] },
    { method: 'eth_estimateGas', params: [{ from: operator, data }] },
  ]);
  const value = (index: number): unknown => { const entry = first[index]!; if (!entry.ok) throw new MevError(502, 'rpc', index === 3 ? '节点估不出部署的 gas（余额可能不足）' : '读取链上状态失败'); return entry.result; };
  const block = value(0) as { baseFeePerGas?: unknown } | null;
  if (!block || typeof block !== 'object') throw new MevError(502, 'rpc', '节点没有返回最新区块');
  const baseFee = quantity(block.baseFeePerGas), nonce = Number(quantity(value(1))), balance = quantity(value(2));
  const bump = (text: string): bigint => BigInt(text) * 5n / 4n + 1n;
  let maxPriorityFeePerGas = MIN_TIP_WEI, maxFeePerGas = baseFee * 3n + maxPriorityFeePerGas;
  if (floor && floor.nonce === nonce) {
    if (maxPriorityFeePerGas < bump(floor.maxPriorityFeePerGas)) maxPriorityFeePerGas = bump(floor.maxPriorityFeePerGas);
    if (maxFeePerGas < bump(floor.maxFeePerGas)) maxFeePerGas = bump(floor.maxFeePerGas);
  }
  const tx: Eip1559Transaction = { chainId, nonce: BigInt(nonce), maxPriorityFeePerGas, maxFeePerGas, gasLimit: quantity(value(3)) * 12n / 10n, to: null, value: 0n, data };
  // L1 数据费按带 65 字节占位签名的交易体估；部署数据有十几 KB，这一项通常比 L2 gas 大。
  const shaped = concatBytes(unsignedTransaction(tx), new Uint8Array(65).fill(0xff));
  const l1 = await rpc.request('eth_call', [{ to: GAS_PRICE_ORACLE, data: callData('getL1Fee(bytes)', ['bytes'], [hexOf(shaped)]) }, 'latest']);
  const l1Fee = new AbiReader(String(l1)).uint(0);
  return { tx, costWei: tx.gasLimit * maxFeePerGas + l1Fee * 2n, balance, nonce };
}

export const signDeployment = (plan: DeployPlan, privateKey: string): { raw: string; hash: string } => signTransaction(plan.tx, privateKey);
