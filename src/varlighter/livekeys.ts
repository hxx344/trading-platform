// DEX 价差实盘的交易凭据（docs/dexspread.md 第 13 节）：在实盘准备页录入，存在 DEX 价差服务自己的数据目录里
// （live-keys.json，服务账户所有、权限 600）。私钥只在本进程内存与这个文件里：不进环境变量（L211）、日志、接口应答与报错，
// 页面只能看到「哪个场所已配置」。删除文件或在页面移除即吊销，每次取用都核对文件仍在（L207）。
// 这里放的应当是不能提币的交易密钥：Lighter 的 API 私钥、Hyperliquid 的 API 钱包（agent）私钥，不是主钱包私钥。
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { addressOf } from '../aster/eip712.ts';
import { KEY_VENUES, parseEntropyAccount, parseLighterAccount, type DexAccounts, type KeyVenue } from '../dex/keys.ts';

export const LIVE_KEYS_FILE = 'live-keys.json';
const VERSION = 1;

export interface LighterKey { accountIndex: number; apiKeyIndex: number; /** 40 字节，十六进制，不带 0x。 */ privateKey: string }
export interface EntropyKey { /** 主账户地址（小写）。 */ address: string; /** API 钱包私钥，0x 加 64 位十六进制。 */ privateKey: string }
export interface LiveKeys { lighter?: LighterKey; rh?: LighterKey; entropy?: EntropyKey }
/** 页面能看到的：每个场所是否已配置，不带任何标识。 */
export type LiveKeysView = Record<KeyVenue, boolean>;

export class LiveKeysError extends Error {}
const fail = (message: string): never => { throw new LiveKeysError(message); };
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value: Record<string, unknown>, keys: string[], what: string) => { for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${what}含有不认识的字段`); };

/** Lighter 的 API 密钥编号：0 到 3 留给官方前端，RH 上 157 也保留，255 只用于查询。 */
function apiKeyIndex(value: unknown, venue: 'lighter' | 'rh'): number {
  const index = typeof value === 'string' && /^\d{1,3}$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 4 || index > 254 || (venue === 'rh' && index === 157)) return fail(venue === 'rh' ? 'API 密钥编号须为 4 到 254 的整数（Lighter RH 上 157 保留）' : 'API 密钥编号须为 4 到 254 的整数');
  return index;
}
function lighterKey(value: unknown, venue: 'lighter' | 'rh'): LighterKey {
  const name = venue === 'rh' ? 'Lighter RH' : 'Lighter';
  if (!isRecord(value)) return fail(`${name} 凭据格式无效`);
  only(value, ['accountIndex', 'apiKeyIndex', 'privateKey'], `${name} 凭据`);
  let accountIndex: number;
  try { accountIndex = parseLighterAccount(String(value.accountIndex ?? '').trim(), name).accountIndex; } catch (error) { return fail(error instanceof Error ? error.message : `${name} 账户编号无效`); }
  // 签名器要求账户编号大于 0。
  if (accountIndex === 0) return fail(`${name} 账户编号须大于 0`);
  const key = typeof value.privateKey === 'string' ? value.privateKey.trim().replace(/^0x/i, '').toLowerCase() : '';
  if (!/^[0-9a-f]{80}$/.test(key)) return fail(`${name} API 私钥须为 80 位十六进制（40 字节）；这是 API 密钥的私钥，不是钱包私钥`);
  return { accountIndex, apiKeyIndex: apiKeyIndex(value.apiKeyIndex, venue), privateKey: key };
}
function entropyKey(value: unknown): EntropyKey {
  if (!isRecord(value)) return fail('Entropy 凭据格式无效');
  only(value, ['address', 'privateKey'], 'Entropy 凭据');
  let address: string;
  try { address = parseEntropyAccount(String(value.address ?? '').trim()).address; } catch (error) { return fail(error instanceof Error ? error.message : 'Entropy 账户地址无效'); }
  const raw = typeof value.privateKey === 'string' ? value.privateKey.trim().toLowerCase() : '';
  const key = /^[0-9a-f]{64}$/.test(raw) ? '0x' + raw : raw;
  if (!/^0x[0-9a-f]{64}$/.test(key)) return fail('Entropy API 钱包私钥须为 64 位十六进制');
  let agent: string;
  try { agent = addressOf(key); } catch { return fail('Entropy API 钱包私钥无效'); }
  // 主钱包私钥能提币，不该放在服务器上：填的私钥对应的地址就是主账户地址时拒绝。
  if (agent === address) return fail('这把私钥就是主账户的钱包私钥。请在 Hyperliquid 的 API 页面生成 API 钱包，填 API 钱包的私钥');
  return { address, privateKey: key };
}

export function parseLiveKeys(value: unknown): LiveKeys {
  if (!isRecord(value) || value.version !== VERSION) return fail('实盘凭据文件格式无效');
  only(value, ['version', ...KEY_VENUES], '实盘凭据文件');
  const keys: LiveKeys = {};
  if (value.lighter !== undefined) keys.lighter = lighterKey(value.lighter, 'lighter');
  if (value.rh !== undefined) keys.rh = lighterKey(value.rh, 'rh');
  if (value.entropy !== undefined) keys.entropy = entropyKey(value.entropy);
  return keys;
}

type Mark = { ino: number; size: number; mtimeMs: number; ctimeMs: number };
export interface LiveKeysStore {
  /** 当前可用的凭据；文件不在、读不懂时为空并给出原因。每次调用都核对文件。 */
  read(): { keys: LiveKeys; problem: string | null };
  view(): LiveKeysView;
  /** 只读用的账户标识（不含私钥）。 */
  accounts(): DexAccounts;
  /** 录入或替换一个场所的凭据。 */
  set(venue: KeyVenue, value: unknown): void;
  remove(venue: KeyVenue): void;
}

export function createLiveKeysStore(dir: string): LiveKeysStore {
  const file = join(dir, LIVE_KEYS_FILE);
  let cache: { mark: Mark; keys: LiveKeys } | null = null;
  const markOf = (): Mark | null => {
    try { const info = statSync(file); return info.isFile() ? { ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs } : null; } catch { return null; }
  };
  const same = (a: Mark, b: Mark) => a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
  function read(): { keys: LiveKeys; problem: string | null } {
    const mark = markOf();
    if (!mark) { cache = null; return { keys: {}, problem: null }; }
    if (cache && same(cache.mark, mark)) return { keys: cache.keys, problem: null };
    try {
      const keys = parseLiveKeys(JSON.parse(readFileSync(file, 'utf8')));
      // 读完再看一眼：读的过程中被换过就下次再读。
      const after = markOf();
      if (after && same(after, mark)) cache = { mark, keys };
      return { keys, problem: null };
    } catch (error) {
      cache = null;
      return { keys: {}, problem: `实盘凭据文件读不懂，未使用：${error instanceof LiveKeysError ? error.message : '不是有效的 JSON'}` };
    }
  }
  function write(keys: LiveKeys): void {
    cache = null;
    if (!KEY_VENUES.some(venue => keys[venue] !== undefined)) { rmSync(file, { force: true }); return; }
    const temp = join(dirname(file), `.live-keys.${randomBytes(6).toString('hex')}.tmp`);
    const handle = openSync(temp, 'wx', 0o600);
    try {
      try { writeSync(handle, JSON.stringify({ version: VERSION, ...keys }) + '\n'); fsyncSync(handle); } finally { closeSync(handle); }
      renameSync(temp, file);
    } catch (error) { rmSync(temp, { force: true }); throw error; }
  }
  /** 改之前的现状：文件读不懂时拒绝改动，不悄悄丢掉其他场所的凭据。 */
  const current = (): LiveKeys => { const { keys, problem } = read(); if (problem) fail(`${problem}。请先在服务器上删除 ${LIVE_KEYS_FILE} 再重新录入`); return keys; };
  return {
    read,
    view: () => { const { keys } = read(); return { lighter: !!keys.lighter, rh: !!keys.rh, entropy: !!keys.entropy }; },
    accounts: () => {
      const { keys } = read(), accounts: DexAccounts = {};
      if (keys.lighter) accounts.lighter = { accountIndex: keys.lighter.accountIndex };
      if (keys.rh) accounts.rh = { accountIndex: keys.rh.accountIndex };
      if (keys.entropy) accounts.entropy = { address: keys.entropy.address };
      return accounts;
    },
    set(venue, value) {
      const keys = { ...current() };
      if (venue === 'entropy') keys.entropy = entropyKey(value); else keys[venue] = lighterKey(value, venue);
      write(keys);
    },
    remove(venue) { const keys = { ...current() }; delete keys[venue]; write(keys); },
  };
}
