// The service's two operator files. config.json chooses the port, the request budget and the pairs by account name;
// secrets.json holds each account's wallet triple and the Feishu robot. Both are read through the same owner-and-mode
// check as the live canary files, and no message built here carries a key or a webhook.
import { isAbsolute } from 'node:path';
import { ContractError, PAIR_ID, exactKeys, integer, parseTransferConfig, type TransferConfig } from '../contracts.ts';
import { IP_CEILING, parseAsterCredentials, type AsterCredentials } from '../aster/client.ts';
import { DEFAULT_ADL_BUDGETS } from '../adl.ts';
import { parseAdlConfig, type AdlConfig } from '../adl-contracts.ts';
import { DEFAULT_POSITIONS_BUDGETS } from '../positions.ts';
import { parsePrivateJson, readPrivateFile } from '../live/setup.ts';

const ACCOUNT_NAME = /^[0-9A-Za-z_-]{1,64}$/;
const FEISHU_HOOK = /^https:\/\/open\.(feishu\.cn|larksuite\.com)\/open-apis\/bot\/v2\/hook\/[0-9A-Za-z_-]{8,128}$/;
export const DEFAULT_PORT = 4720;
export const MAX_PAIRS = 20;

/** `adl` seeds the pair's ADL settings when it is first registered; afterwards the page owns them. */
export interface ServicePair { id: string; main: string; long: string; short: string; transfer: TransferConfig; adl?: AdlConfig }
export interface ServiceConfig {
  port: number;
  budget: { limitPerMinute: number; adlReserve: number };
  secretsFile: string;
  pairs: ServicePair[];
}
export interface FeishuSecret { webhook: string; secret: string | null }
export interface ServiceSecrets { accounts: Map<string, AsterCredentials>; feishu: FeishuSecret | null }

/** Weight one pair spends a minute when idle: both balances every check, both position displays, both ADL history scans. */
export function pairWeightPerMinute(pair: ServicePair): number {
  const perMinute = (ms: number): number => Math.ceil(60_000 / ms);
  return 2 * 5 * perMinute(pair.transfer.checkIntervalMs) + 2 * 5 * perMinute(DEFAULT_POSITIONS_BUDGETS.positionsRefreshMs) + 2 * 50 * perMinute(DEFAULT_ADL_BUDGETS.adlScanIntervalMs);
}
/** Room above the idle use for takeover checks, transfers and catch-up history pages. */
const BUDGET_HEADROOM = 100;

const fail = (name: string, error: unknown): Error => new Error(`${name}无效：${error instanceof ContractError || error instanceof Error ? error.message : '格式错误'}`);

export function parseServiceConfig(raw: unknown): ServiceConfig {
  const value = exactKeys(raw, ['secretsFile', 'pairs'], ['port', 'budget']);
  if (typeof value.secretsFile !== 'string' || !isAbsolute(value.secretsFile)) throw new Error('secretsFile 必须是绝对路径');
  const port = value.port === undefined ? DEFAULT_PORT : integer(value.port, 1_024, 65_535, '端口');
  const budgetRaw = exactKeys(value.budget ?? {}, [], ['limitPerMinute', 'adlReserve']);
  if (!Array.isArray(value.pairs) || value.pairs.length < 1 || value.pairs.length > MAX_PAIRS) throw new Error(`pairs 须列出 1–${MAX_PAIRS} 个配对`);
  const pairs = value.pairs.map((item, index) => {
    const pair = exactKeys(item, ['id', 'main', 'long', 'short'], ['transfer', 'adl']);
    const name = (key: 'main' | 'long' | 'short'): string => {
      if (typeof pair[key] !== 'string' || !ACCOUNT_NAME.test(pair[key])) throw new Error(`第 ${index + 1} 个配对的 ${key} 须为账户名（字母、数字、_ 或 -）`);
      return pair[key];
    };
    if (typeof pair.id !== 'string' || !PAIR_ID.test(pair.id)) throw new Error(`第 ${index + 1} 个配对的 id 无效`);
    const result: ServicePair = { id: pair.id, main: name('main'), long: name('long'), short: name('short'), transfer: parseTransferConfig(pair.transfer) };
    if (pair.adl !== undefined) {
      try { result.adl = parseAdlConfig(pair.adl); } catch (error) { throw new Error(`配对 ${result.id} 的 adl 无效：${error instanceof Error ? error.message : '格式错误'}`); }
    }
    if (new Set([result.main, result.long, result.short]).size !== 3) throw new Error(`配对 ${result.id} 的主账户、多侧与空侧须是三个不同的账户`);
    return result;
  });
  if (new Set(pairs.map(pair => pair.id)).size !== pairs.length) throw new Error('配对 id 重复');
  // One sub-account in two pairs would have two balancers moving its money.
  const subs = pairs.flatMap(pair => [pair.long, pair.short]);
  if (new Set(subs).size !== subs.length) throw new Error('同一子账户不能出现在两个配对或同一配对两侧');
  // The routine reads must fit under the limit less the ADL reserve, or balance reads and scans are refused all the time.
  const needed = pairs.reduce((sum, pair) => sum + pairWeightPerMinute(pair), BUDGET_HEADROOM);
  const limitPerMinute = budgetRaw.limitPerMinute === undefined ? Math.max(600, Math.ceil(needed * 6 / 5)) : integer(budgetRaw.limitPerMinute, 100, IP_CEILING, '每分钟请求权重上限');
  if (limitPerMinute > IP_CEILING) throw new Error(`${pairs.length} 个配对每分钟约需请求权重 ${needed}，超过本服务可用的 ${IP_CEILING}；请减少配对或调大 checkIntervalMs`);
  const adlReserve = budgetRaw.adlReserve === undefined ? Math.floor(limitPerMinute / 6) : integer(budgetRaw.adlReserve, 0, limitPerMinute - 50, 'ADL 预留权重');
  if (limitPerMinute - adlReserve < needed) throw new Error(`${pairs.length} 个配对每分钟约需请求权重 ${needed}，而每分钟上限 ${limitPerMinute} 减去 ADL 预留 ${adlReserve} 只剩 ${limitPerMinute - adlReserve}；请调大 budget.limitPerMinute 或去掉 budget 使用自动值`);
  return { port, budget: { limitPerMinute, adlReserve }, secretsFile: value.secretsFile, pairs };
}

export function parseServiceSecrets(raw: unknown, needed: readonly string[]): ServiceSecrets {
  const value = exactKeys(raw, ['accounts'], ['feishu']);
  if (value.accounts === null || typeof value.accounts !== 'object' || Array.isArray(value.accounts)) throw new Error('accounts 须为 { 账户名: { user, signer, privateKey } }');
  const accounts = new Map<string, AsterCredentials>();
  for (const [name, item] of Object.entries(value.accounts as Record<string, unknown>)) {
    if (!ACCOUNT_NAME.test(name)) throw new Error('账户名须为字母、数字、_ 或 -');
    accounts.set(name, parseAsterCredentials(item, `账户 ${name}`));
  }
  for (const name of needed) if (!accounts.has(name)) throw new Error(`缺少账户 ${name} 的密钥`);
  const users = [...accounts.values()].map(item => item.user);
  if (new Set(users).size !== users.length) throw new Error('两个账户名指向同一个钱包地址');
  let feishu: FeishuSecret | null = null;
  if (value.feishu !== undefined && value.feishu !== null) {
    const hook = exactKeys(value.feishu, ['webhook'], ['secret']);
    if (typeof hook.webhook !== 'string' || !FEISHU_HOOK.test(hook.webhook)) throw new Error('feishu.webhook 须为飞书或 Lark 自定义机器人的 https 地址');
    if (hook.secret !== undefined && hook.secret !== null && (typeof hook.secret !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(hook.secret))) throw new Error('feishu.secret 格式无效');
    feishu = { webhook: hook.webhook, secret: typeof hook.secret === 'string' ? hook.secret : null };
  }
  return { accounts, feishu };
}

export function loadServiceConfig(path: string): ServiceConfig {
  const raw = parsePrivateJson(readPrivateFile(path, '服务配置文件'), '服务配置文件');
  try { return parseServiceConfig(raw); } catch (error) { throw fail('服务配置文件', error); }
}

/**
 * A transfer is signed by the main account's API wallet without a user, so the venue knows the account only by that
 * signer: it must not also sign for a sub-account (Python margin_balance refuses the same).
 */
export function assertDistinctSigners(config: ServiceConfig, secrets: ServiceSecrets): void {
  const signer = (name: string): string => secrets.accounts.get(name)!.signer.toLowerCase();
  const subSigners = new Map(config.pairs.flatMap(pair => [pair.long, pair.short]).map(name => [signer(name), name]));
  for (const pair of config.pairs) {
    const shared = subSigners.get(signer(pair.main));
    if (shared !== undefined) throw new Error(`主账户 ${pair.main} 与子账户 ${shared} 使用同一个 API 钱包；划转不带 user，必须为主账户单独配置 API 钱包`);
  }
}

export function loadServiceSecrets(config: ServiceConfig): ServiceSecrets {
  const raw = parsePrivateJson(readPrivateFile(config.secretsFile, '密钥文件'), '密钥文件');
  // parseAsterCredentials never quotes a key; other messages name only account names and fields.
  try {
    const secrets = parseServiceSecrets(raw, [...new Set(config.pairs.flatMap(pair => [pair.main, pair.long, pair.short]))]);
    assertDistinctSigners(config, secrets);
    return secrets;
  } catch (error) { throw fail('密钥文件', error); }
}
