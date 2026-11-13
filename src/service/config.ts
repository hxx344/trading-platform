// The service's two operator files. config.json chooses the listen address and port, the request budget and the pairs by account name;
// secrets.json holds each account's wallet triple and the Feishu robot. Both are read through the same owner-and-mode
// check as the live canary files, and no message built here carries a key or a webhook.
import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import { ContractError, PAIR_ID, exactKeys, integer, parseTransferConfig, reject, type TransferConfig } from '../contracts.ts';
import { IP_CEILING, parseAsterCredentials, type AsterCredentials } from '../aster/client.ts';
import { DEFAULT_ADL_BUDGETS } from '../adl.ts';
import { parseAdlConfig, type AdlConfig } from '../adl-contracts.ts';
import { DEFAULT_POSITIONS_BUDGETS } from '../positions.ts';
import { parsePrivateJson, readPrivateFile } from '../live/setup.ts';
import type { Venue } from '../contracts.ts';
import type { LiveCredentials } from '../live/values.ts';
import { parseOilConfig, parseOilSecrets, type OilConfig } from './oil-config.ts';

const ACCOUNT_NAME = /^[0-9A-Za-z_-]{1,64}$/;
const FEISHU_HOOK = /^https:\/\/open\.(feishu\.cn|larksuite\.com)\/open-apis\/bot\/v2\/hook\/[0-9A-Za-z_-]{8,128}$/;
export const DEFAULT_PORT = 4720;
export const MAX_PAIRS = 20;

/** `adl` seeds the pair's ADL settings when it is first registered; afterwards the page owns them. */
export interface ServicePair { id: string; main: string; long: string; short: string; transfer: TransferConfig; adl?: AdlConfig }
export interface ServiceConfig {
  port: number;
  /** One more address listened on besides 127.0.0.1 (say the server's Tailscale IP); null for loopback only. */
  host: string | null;
  budget: { limitPerMinute: number; adlReserve: number };
  secretsFile: string;
  pairs: ServicePair[];
  /** The oil module's Binance/Bybit execution accounts and caps; absent means the service runs as before (oil-config.ts). */
  oil?: OilConfig;
  /** The scheduled ASTER summary card (summary.ts); absent: every 60 minutes. 0 turns it off. */
  summary?: { intervalMinutes: number };
}
export interface FeishuSecret { webhook: string; secret: string | null }
export interface ServiceSecrets {
  accounts: Map<string, AsterCredentials>; feishu: FeishuSecret | null;
  /** The robot for the scheduled summary (the workbench's 定时 channel); without one the summary goes to `feishu`. */
  feishuScheduled?: FeishuSecret | null;
  /** Keys of the oil accounts' venues; only with oil configured. */ exchanges?: Map<Venue, LiveCredentials>;
}

const perMinute = (ms: number): number => Math.ceil(60_000 / ms);
/** The part of a pair's idle weight that does not depend on its check interval: both position displays, both ADL history scans. */
const FIXED_PAIR_WEIGHT = 2 * 5 * perMinute(DEFAULT_POSITIONS_BUDGETS.positionsRefreshMs) + 2 * 50 * perMinute(DEFAULT_ADL_BUDGETS.adlScanIntervalMs);
/** Both balances (weight 5 each) at every check. */
const checkWeight = (checkIntervalMs: number): number => 2 * 5 * perMinute(checkIntervalMs);
/** Weight one pair spends a minute when idle: both balances every check, both position displays, both ADL history scans. */
export function pairWeightPerMinute(pair: ServicePair): number {
  return checkWeight(pair.transfer.checkIntervalMs) + FIXED_PAIR_WEIGHT;
}
/** Room above the idle use for takeover checks, transfers and catch-up history pages. */
const BUDGET_HEADROOM = 100;

/** A registered pair as far as the budget is concerned (a pair view or a stored record). */
export interface BudgetedPair { id: string; enabled: boolean; config: { checkIntervalMs: number } }
export interface IdleWeight { needed: number; available: number; limitPerMinute: number; adlReserve: number }
/**
 * The idle weight of the pairs at their stored check intervals, against the limit less the ADL reserve. Counted are
 * the configured pairs (what the budget was sized for at start) and any other registered pair still switched on.
 * `change` puts one pair at another interval.
 */
export function idleWeight(config: ServiceConfig, pairs: readonly BudgetedPair[], change?: { pairId: string; checkIntervalMs: number }): IdleWeight {
  const stored = new Map(pairs.map(pair => [pair.id, pair]));
  const intervals = new Map(config.pairs.map(pair => [pair.id, stored.get(pair.id)?.config.checkIntervalMs ?? pair.transfer.checkIntervalMs]));
  for (const pair of pairs) if (pair.enabled && !intervals.has(pair.id)) intervals.set(pair.id, pair.config.checkIntervalMs);
  if (change && intervals.has(change.pairId)) intervals.set(change.pairId, change.checkIntervalMs);
  let needed = BUDGET_HEADROOM;
  for (const ms of intervals.values()) needed += checkWeight(ms) + FIXED_PAIR_WEIGHT;
  return { needed, available: config.budget.limitPerMinute - config.budget.adlReserve, limitPerMinute: config.budget.limitPerMinute, adlReserve: config.budget.adlReserve };
}
/**
 * Refuses a check interval that would push the idle weight over the limit less the ADL reserve, naming the shortest
 * interval that fits. A change that adds nothing (the same or a longer interval) always passes, so a database whose
 * intervals already overrun the budget at start still takes edits; the pair's current interval is therefore always
 * usable, and the shortest named is never longer than it.
 */
export function checkIntervalBudget(config: ServiceConfig, pairs: readonly BudgetedPair[], pairId: string, checkIntervalMs: number): void {
  const before = idleWeight(config, pairs), after = idleWeight(config, pairs, { pairId, checkIntervalMs });
  if (after.needed <= after.available || after.needed <= before.needed) return;
  const current = pairs.find(pair => pair.id === pairId)?.config.checkIntervalMs ?? checkIntervalMs;
  // The others' use stays; what is left buys this many balance checks a minute.
  const checks = Math.floor((after.available - (before.needed - checkWeight(current))) / 10);
  const limit = `每分钟上限 ${after.limitPerMinute} 减去 ADL 预留 ${after.adlReserve} 后的 ${after.available}`;
  const over = `检查间隔 ${checkIntervalMs} 毫秒会使空闲请求权重约为每分钟 ${after.needed}，超过${limit}`;
  if (checks < 1) reject('budget_exceeded', `${over}；其余配对已用满，不得短于当前的 ${current} 毫秒（约 ${seconds(current)} 秒）；要更短请调大 config.json 的 budget.limitPerMinute`, 409);
  const shortest = Math.min(current, Math.max(1_000, Math.ceil(60_000 / checks)));
  reject('budget_exceeded', `${over}；当前最短可用 ${shortest} 毫秒（约 ${seconds(shortest)} 秒）`, 409);
}
const seconds = (ms: number): number => Math.ceil(ms / 100) / 10;

/**
 * Refuses to switch on a pair that is not in config.json when its idle use would push the weight over the limit less
 * the ADL reserve: the budget was sized for the configured pairs only, and an enabled left-over pair is counted on top.
 * A pair already counted (configured, or already on) adds nothing and passes.
 */
export function enableBudget(config: ServiceConfig, pairs: readonly BudgetedPair[], pairId: string): void {
  const pair = pairs.find(item => item.id === pairId);
  if (!pair) return;
  const before = idleWeight(config, pairs), after = idleWeight(config, pairs.map(item => item.id === pairId ? { ...item, enabled: true } : item));
  if (after.needed <= after.available || after.needed <= before.needed) return;
  reject('budget_exceeded', `配对 ${pairId} 不在 config.json 中，启用后按它的检查间隔 ${pair.config.checkIntervalMs} 毫秒计入，配对空闲时每分钟约需请求权重 ${after.needed}，超过每分钟上限 ${after.limitPerMinute} 减去 ADL 预留 ${after.adlReserve} 后的 ${after.available}；请先在设置页调大它的检查间隔，或把它写进 config.json 并调大 budget.limitPerMinute`, 409);
}

/**
 * One specific address of this server, normalised as a URL writes it (so it matches the browser's Host header). The
 * wildcard addresses are refused: the page would then answer on every interface, the public one included.
 */
export function parseListenHost(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || isIP(value) === 0) throw new Error('host 须为本机的一个 IP 地址（例如 Tailscale 的 100.x.y.z），不能是域名');
  const v6 = isIP(value) === 6;
  const hostname = new URL(`http://${v6 ? `[${value}]` : value}/`).hostname;
  const normalised = v6 ? hostname.slice(1, -1) : hostname;
  if (/^0\./.test(normalised) || normalised === '::' || normalised === '::ffff:0:0' || normalised === '255.255.255.255') throw new Error('host 不能是 0.0.0.0、:: 等通配地址，须写本机的一个具体 IP');
  // 127.0.0.1 is always listened on: the same port again would never bind.
  if (/^127\./.test(normalised) || normalised === '::1' || /^::ffff:7f[0-9a-f]{2}:/.test(normalised)) throw new Error('host 不用写回环地址（总会监听 127.0.0.1），须写 Tailscale 等其它本机 IP');
  return normalised;
}
/** The listen address as written in a URL or a Host header. */
export const urlHost = (host: string): string => isIP(host) === 6 ? `[${host}]` : host;

const fail = (name: string, error: unknown): Error => new Error(`${name}无效：${error instanceof ContractError || error instanceof Error ? error.message : '格式错误'}`);

export function parseServiceConfig(raw: unknown): ServiceConfig {
  // pairs may be left out only when oil is there: one of the two modules must be configured.
  const hasOil = raw !== null && typeof raw === 'object' && Object.hasOwn(raw, 'oil');
  const value = exactKeys(raw, hasOil ? ['secretsFile'] : ['secretsFile', 'pairs'], ['port', 'host', 'budget', 'summary', ...(hasOil ? ['pairs', 'oil'] : [])]);
  const oil = hasOil ? parseOilConfig(value.oil) : undefined;
  const pairsInput: unknown = oil && value.pairs === undefined ? [] : value.pairs;
  if (typeof value.secretsFile !== 'string' || !isAbsolute(value.secretsFile)) throw new Error('secretsFile 必须是绝对路径');
  const port = value.port === undefined ? DEFAULT_PORT : integer(value.port, 1_024, 65_535, '端口');
  const host = parseListenHost(value.host);
  const budgetRaw = exactKeys(value.budget ?? {}, [], ['limitPerMinute', 'adlReserve']);
  // No pair at all is a valid start: the page is up, and pairs come in from the workbench import there.
  if (!Array.isArray(pairsInput) || pairsInput.length > MAX_PAIRS) throw new Error(`pairs 须为列表，最多 ${MAX_PAIRS} 个配对`);
  const pairs = pairsInput.map((item, index) => {
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
  if (limitPerMinute > IP_CEILING) throw new Error(`${pairs.length} 个配对每分钟约需请求权重 ${needed}，加两成余量为 ${limitPerMinute}，超过本服务可用的 ${IP_CEILING}；请减少配对或调大 checkIntervalMs`);
  const adlReserve = budgetRaw.adlReserve === undefined ? Math.floor(limitPerMinute / 6) : integer(budgetRaw.adlReserve, 0, limitPerMinute - 50, 'ADL 预留权重');
  if (limitPerMinute - adlReserve < needed) throw new Error(`${pairs.length} 个配对每分钟约需请求权重 ${needed}，而每分钟上限 ${limitPerMinute} 减去 ADL 预留 ${adlReserve} 只剩 ${limitPerMinute - adlReserve}；请调大 budget.limitPerMinute 或去掉 budget 使用自动值`);
  const summary = value.summary === undefined ? undefined : { intervalMinutes: integer(exactKeys(value.summary, ['intervalMinutes'], []).intervalMinutes, 0, 1_440, '定时摘要间隔（分钟，0 为关闭）') };
  return { port, host, budget: { limitPerMinute, adlReserve }, secretsFile: value.secretsFile, pairs, ...(oil ? { oil } : {}), ...(summary ? { summary } : {}) };
}

export function parseServiceSecrets(raw: unknown, needed: readonly string[], oilVenues: readonly Venue[] = []): ServiceSecrets {
  const value = exactKeys(raw, ['accounts'], ['feishu', 'feishuScheduled', ...(oilVenues.length ? ['binance', 'bybit'] : [])]);
  if (value.accounts === null || typeof value.accounts !== 'object' || Array.isArray(value.accounts)) throw new Error('accounts 须为 { 账户名: { user, signer, privateKey } }');
  const accounts = new Map<string, AsterCredentials>();
  for (const [name, item] of Object.entries(value.accounts as Record<string, unknown>)) {
    if (!ACCOUNT_NAME.test(name)) throw new Error('账户名须为字母、数字、_ 或 -');
    accounts.set(name, parseAsterCredentials(item, `账户 ${name}`));
  }
  for (const name of needed) if (!accounts.has(name)) throw new Error(`缺少账户 ${name} 的密钥`);
  const users = [...accounts.values()].map(item => item.user);
  if (new Set(users).size !== users.length) throw new Error('两个账户名指向同一个钱包地址');
  const feishu = parseFeishu(value.feishu, 'feishu');
  const feishuScheduled = parseFeishu(value.feishuScheduled, 'feishuScheduled');
  return { accounts, feishu, ...(feishuScheduled ? { feishuScheduled } : {}), ...(oilVenues.length ? { exchanges: parseOilSecrets(value, oilVenues) } : {}) };
}

function parseFeishu(raw: unknown, name: string): FeishuSecret | null {
  if (raw === undefined || raw === null) return null;
  const hook = exactKeys(raw, ['webhook'], ['secret']);
  if (typeof hook.webhook !== 'string' || !FEISHU_HOOK.test(hook.webhook)) throw new Error(`${name}.webhook 须为飞书或 Lark 自定义机器人的 https 地址`);
  if (hook.secret !== undefined && hook.secret !== null && (typeof hook.secret !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(hook.secret))) throw new Error(`${name}.secret 格式无效`);
  return { webhook: hook.webhook, secret: typeof hook.secret === 'string' ? hook.secret : null };
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
    const secrets = parseServiceSecrets(raw, [...new Set(config.pairs.flatMap(pair => [pair.main, pair.long, pair.short]))], config.oil?.accounts.map(account => account.venue) ?? []);
    assertDistinctSigners(config, secrets);
    return secrets;
  } catch (error) { throw fail('密钥文件', error); }
}
