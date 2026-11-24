// MEV 套利模块在运维文件里的部分（docs/mev.md 第 1.6 节）：config.json 的 `mev: { executor, owner }` 开启模块，
// secrets.json 的 `mev: { rpcUrl, privateKey, sendRpcUrl? }` 是节点地址与热钱包私钥。节点地址可能带服务商密钥，
// 所以和私钥一样放在密钥文件里。这里的任何报错都不带地址原文、私钥或从密钥文件读到的字段值。
import { ContractError, exactKeys } from '../contracts.ts';
import { addressOf, isAddress, lower } from '../mev/codec.ts';

export interface MevServiceConfig { executor: string; owner: string }
export interface MevSecrets { rpcUrl: string; sendRpcUrl?: string; privateKey: string }

const reason = (error: unknown): string => error instanceof ContractError || error instanceof Error ? error.message : '格式错误';

export function parseMevConfig(value: unknown): MevServiceConfig {
  let raw: Record<string, unknown>;
  try { raw = exactKeys(value, ['executor', 'owner'], []); } catch (error) { throw new Error(`mev 无效：${reason(error)}`); }
  if (!isAddress(raw.executor) || !isAddress(raw.owner)) throw new Error('mev.executor 与 mev.owner 须为 0x 开头的 40 位十六进制地址');
  if (lower(raw.executor) === lower(raw.owner)) throw new Error('mev.executor 与 mev.owner 不能是同一个地址');
  return { executor: lower(raw.executor), owner: lower(raw.owner) };
}

/** 节点地址：https，或本机 / 内网自建节点的 http。不带账号密码段。 */
function validRpcUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 512) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.username || url.password || url.hash) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|100\.\d+\.\d+\.\d+)$/.test(url.hostname);
}

/** secrets.json 的 `mev`；没有这个键返回 undefined。 */
export function parseMevSecrets(value: Record<string, unknown>): MevSecrets | undefined {
  if (value.mev === undefined) return undefined;
  let raw: Record<string, unknown>;
  try { raw = exactKeys(value.mev, ['rpcUrl', 'privateKey'], ['sendRpcUrl']); } catch { throw new Error('mev 的字段须为 rpcUrl、privateKey，可另有 sendRpcUrl'); }
  if (!validRpcUrl(raw.rpcUrl) || (raw.sendRpcUrl !== undefined && !validRpcUrl(raw.sendRpcUrl))) throw new Error('mev 的节点地址须为 https 地址（本机或内网自建节点可用 http）');
  if (typeof raw.privateKey !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(raw.privateKey)) throw new Error('mev 的私钥格式无效');
  try { addressOf(raw.privateKey); } catch { throw new Error('mev 的私钥格式无效'); }
  return { rpcUrl: raw.rpcUrl, privateKey: raw.privateKey, ...(typeof raw.sendRpcUrl === 'string' ? { sendRpcUrl: raw.sendRpcUrl } : {}) };
}

/** 热钱包必须专用：不能是任何 ASTER 账户的钱包或签名钱包，也不能是合约或 owner 的地址。 */
export function assertDedicatedWallet(config: MevServiceConfig, secrets: MevSecrets, others: readonly string[]): void {
  const operator = addressOf(secrets.privateKey);
  if (operator === config.owner || operator === config.executor) throw new Error('mev 的热钱包不能是 owner 或执行合约的地址');
  if (others.some(address => lower(address) === operator)) throw new Error('mev 的热钱包与某个 ASTER 账户共用同一个钱包；热钱包必须专用');
}

const short = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`;

/** 给 --check-config 用；没有 mev 时为空，输出与以前一样。 */
export function mevSummary(config: MevServiceConfig | undefined, secrets: MevSecrets | undefined): string {
  if (!config || !secrets) return '';
  return `，MEV 套利（Base，执行合约 ${short(config.executor)}，热钱包 ${short(addressOf(secrets.privateKey))}）`;
}
