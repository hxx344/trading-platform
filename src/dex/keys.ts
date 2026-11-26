// DEX 价差实盘的场所账户（docs/dexspread.md 第 12.13 节）。文件由 root 持有（0600），服务账户打不开：
// systemd 以 EnvironmentFile 把它交给 DEX 服务，服务启动时取走并从环境里删掉（子进程不再继承；但启动时的环境块仍在
// /proc/<pid>/environ，同账户的进程读得到，所以这条通道只能放账户编号与地址，放私钥之前必须换投递方式）。服务只能看到这个文件在不在、变没变，
// 文件被删除或改过之后（吊销、换账户）不再使用启动时拿到的内容，等安装脚本重启（L207）。
// 这一版只有账户编号与地址；私钥在下单连接器接入时加进同一个文件。
import { statSync } from 'node:fs';

export const DEX_KEYS_ENV = 'TP_DEX_KEYS';
export const DEX_KEYS_VERSION = 1;
/** 一行环境变量的上限：systemd 与本模块都按这个长度拒绝。 */
const KEYS_TEXT_LIMIT = 8192;

export type KeyVenue = 'lighter' | 'rh' | 'entropy';
export const KEY_VENUES: readonly KeyVenue[] = ['lighter', 'rh', 'entropy'];
/** Lighter 主网与 RH 是两套账户，编号互不通用；Entropy 是 Hyperliquid 主账户（或子账户）地址。 */
export interface DexAccounts { lighter?: { accountIndex: number }; rh?: { accountIndex: number }; entropy?: { address: string } }
/** 引擎每次要用账户时取一次：`problem` 不为空时不得使用 `accounts`。 */
export interface DexAccountsState { accounts: DexAccounts; problem: string | null }
export type DexAccountsSource = () => DexAccountsState;

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** 主账户从 0 往上编号，子账户从 2^48−2 往下。 */
const LIGHTER_ACCOUNT_MAX = 2 ** 48 - 2;

function onlyKeys(value: Record<string, unknown>, allowed: string[], where: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${where} 有不认识的字段 ${key.slice(0, 40)}`);
}

export function parseLighterAccount(text: string, name: string): { accountIndex: number } {
  if (!/^(0|[1-9][0-9]{0,14})$/.test(text)) throw new Error(`${name} 账户编号须为非负整数`);
  const accountIndex = Number(text);
  if (accountIndex > LIGHTER_ACCOUNT_MAX) throw new Error(`${name} 账户编号超出范围`);
  return { accountIndex };
}

export function parseEntropyAccount(text: string): { address: string } {
  if (!/^0x[0-9a-fA-F]{40}$/.test(text)) throw new Error('Entropy 账户地址须为 0x 开头的 40 位十六进制');
  return { address: text.toLowerCase() };
}

/** 严格解析：不认识的字段、版本一律拒绝，不猜。 */
export function parseDexAccounts(value: unknown): DexAccounts {
  if (!isRecord(value)) throw new Error('场所账户须为对象');
  onlyKeys(value, ['version', ...KEY_VENUES], '场所账户');
  if (value.version !== DEX_KEYS_VERSION) throw new Error('场所账户的版本不认识');
  const accounts: DexAccounts = {};
  for (const venue of ['lighter', 'rh'] as const) {
    const item = value[venue];
    if (item === undefined) continue;
    const name = venue === 'rh' ? 'Lighter RH' : 'Lighter';
    if (!isRecord(item)) throw new Error(`${name} 账户须为对象`);
    onlyKeys(item, ['accountIndex'], `${name} 账户`);
    if (typeof item.accountIndex !== 'number' || !Number.isSafeInteger(item.accountIndex)) throw new Error(`${name} 账户编号须为非负整数`);
    accounts[venue] = parseLighterAccount(String(item.accountIndex), name);
  }
  if (value.entropy !== undefined) {
    if (!isRecord(value.entropy)) throw new Error('Entropy 账户须为对象');
    onlyKeys(value.entropy, ['address'], 'Entropy 账户');
    if (typeof value.entropy.address !== 'string') throw new Error('Entropy 账户地址须为字符串');
    accounts.entropy = parseEntropyAccount(value.entropy.address);
  }
  return accounts;
}

export const configuredVenues = (accounts: DexAccounts): KeyVenue[] => KEY_VENUES.filter(venue => accounts[venue] !== undefined);

/** 文件内容：一行 `TP_DEX_KEYS=<base64url 的 JSON>`，不含引号与空白，systemd 的 EnvironmentFile 原样读入。 */
export function encodeDexKeys(accounts: DexAccounts): string {
  const json = JSON.stringify({ version: DEX_KEYS_VERSION, ...parseDexAccounts({ version: DEX_KEYS_VERSION, ...accounts }) });
  return `${DEX_KEYS_ENV}=${Buffer.from(json, 'utf8').toString('base64url')}\n`;
}

export function decodeDexKeysValue(value: string): DexAccounts {
  if (value.length > KEYS_TEXT_LIMIT || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('场所账户的编码无效');
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { throw new Error('场所账户的编码无效'); }
  return parseDexAccounts(parsed);
}

/** 解析整个文件（安装脚本的录入助手用）：只接受恰好一行本模块写出的内容。 */
export function decodeDexKeysFile(text: string): DexAccounts {
  const match = /^TP_DEX_KEYS=([A-Za-z0-9_-]+)\n?$/.exec(text.length > KEYS_TEXT_LIMIT + 32 ? '' : text);
  if (!match) throw new Error('场所账户文件不是本程序写出的格式');
  return decodeDexKeysValue(match[1]);
}

/**
 * 启动时从环境里取走场所账户并删掉这个变量：之后启动的子进程（Var 询价的传输脚本）拿不到它。
 * 没有这个变量就是没有配置；内容无效时不使用，只报告问题。
 */
export interface TakenDexKeys { accounts: DexAccounts; present: boolean; problem: string | null; /** 录入助手写出这份内容时文件应有的字节数。 */ fileSize?: number }
export function takeDexKeys(env: NodeJS.ProcessEnv): TakenDexKeys {
  const value = env[DEX_KEYS_ENV];
  delete env[DEX_KEYS_ENV];
  if (value === undefined || value === '') return { accounts: {}, present: false, problem: null };
  const fileSize = Buffer.byteLength(`${DEX_KEYS_ENV}=${value}\n`);
  try { return { accounts: decodeDexKeysValue(value), present: true, problem: null, fileSize }; }
  catch (error) { return { accounts: {}, present: true, problem: error instanceof Error ? error.message : '场所账户无效', fileSize }; }
}

type FileMark = { ino: number; size: number; mtimeMs: number; ctimeMs: number } | null;
type StatLike = (path: string) => { ino: number; size: number; mtimeMs: number; ctimeMs: number; isFile(): boolean };

/**
 * 启动时取到的账户只在文件原样还在时可用。每次取用都重新看一眼文件（L207）：不在了就是已吊销，变了就是换过内容，
 * 两种情况都不再用内存里的旧值，等安装脚本重启服务后读新的。启动时文件就看不到（或环境里有值而文件不在）同样不用。
 * 比较项含 ctime：原地改写后把 mtime 改回去也瞒不过。启动时文件的大小要与拿到的内容对得上：systemd 读完文件到
 * 本进程第一次看文件之间被换成别的内容时，不把换过的文件当基准。这段空隙里换成等长内容的情形挡不住（docs/dexspread.md 12.13）。
 */
export function guardedAccounts(taken: TakenDexKeys, file: string | null, stat: StatLike = statSync): DexAccountsSource {
  const mark = (): FileMark => {
    if (file === null) return null;
    try { const info = stat(file); return info.isFile() ? { ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs } : null; } catch { return null; }
  };
  const initial = mark();
  const none: DexAccounts = {};
  const changed = '场所账户文件已更换，等 DEX 价差服务重启后生效';
  return () => {
    if (!taken.present) return { accounts: none, problem: mark() === null ? null : '场所账户文件已写入，等 DEX 价差服务重启后生效' };
    if (taken.problem) return { accounts: none, problem: `场所账户文件无效：${taken.problem}` };
    if (file === null || initial === null) return { accounts: none, problem: '启动时看不到场所账户文件，未使用其中的账户' };
    if (taken.fileSize !== undefined && initial.size !== taken.fileSize) return { accounts: none, problem: changed };
    const current = mark();
    if (current === null) return { accounts: none, problem: '场所账户文件已删除，已停止使用其中的账户' };
    if (current.ino !== initial.ino || current.size !== initial.size || current.mtimeMs !== initial.mtimeMs || current.ctimeMs !== initial.ctimeMs) return { accounts: none, problem: changed };
    return { accounts: taken.accounts, problem: null };
  };
}
