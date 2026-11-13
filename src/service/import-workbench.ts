// Brings the workbench's ASTER margin-balance pairs over into this service's two operator files, so a switch does not
// start from hand-copied settings. It only reads: the workbench's trading.sqlite3 (opened read-only, as its owner) and the
// environment it runs with (/etc/project-aggregation.env, then <data>/modules/aster/.env, which wins as it does in the
// workbench). Imported pairs are registered switched off like any configured pair; taking one over still needs the
// workbench pair deleted and the takeover checks passed in the page. Nothing is sent to ASTER or to the workbench.
//
// With --oil it also brings the workbench's Binance/Bybit execution accounts over for the oil module: <data>/hub.sqlite
// execution_accounts, decrypted with <data>/credentials.key (read the same way, as the database's owner). Only then: --oil
// alone imports the oil accounts only, --oil --pairs id,id both.
//
// With --options it also brings the workbench Greeks module's Bybit key and risk settings over (import-options.ts); it
// reads the module's .env and engine_state.json and asks Bybit once for the key's account UID. Like --oil, alone it
// imports no pair.
//
//   node import-workbench.ts --config /etc/trading-platform/config.json [--workbench-env FILE] [--workbench-data DIR]
//                            [--pairs id,id] [--oil] [--options] [--dry-run]
//
// An existing config.json is extended: its pairs, accounts and robot stay as they are, and only pairs it does not have
// yet are added; an oil venue it already names keeps its settings. Output names pairs, account names and masked account
// ids only; keys, ciphertext and webhooks never appear in it.
import { spawnSync } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';
import { closeSync, existsSync, fchownSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs, parseEnv } from 'node:util';
import { parseAsterCredentials, type AsterCredentials } from '../aster/client.ts';
import { ACCOUNT_MODES, VENUES, VENUE_NAMES, parseTransferConfig, type Venue } from '../contracts.ts';
import { parseAdlConfig } from '../adl-contracts.ts';
import { parsePrivateJson } from '../live/setup.ts';
import { validCredentials, type LiveCredentials } from '../live/values.ts';
import { assertDistinctSigners, parseServiceConfig, parseServiceSecrets } from './config.ts';
import { parseOilSecrets } from './oil-config.ts';
import { planOptions, readWorkbenchOptions, resolveOptionsAccount, type OptionsItem, type OptionsSource } from './import-options.ts';

export const WORKBENCH_ENV = '/etc/project-aggregation.env';
export const WORKBENCH_DATA = '/var/lib/project-aggregation';
const PREFIX = /^[A-Z][A-Z0-9_]{1,40}$/;
/** The workbench's own defaults (margin_balance.DEFAULT_MARGIN, adl_config.DEFAULT_ADL) for fields a record left out. */
const MARGIN_DEFAULTS = { enabled: false, master_env_prefix: '', check_interval_seconds: 5, threshold: '10', min_transfer: '1', max_transfer: '1000',
  buffer_ratio: '0.05', absolute_reserve_enabled: false, long_reserve: '0', short_reserve: '0', cooldown_seconds: 30 };
const ADL_DEFAULTS = { enabled: true, batch_notional: '1000' };

type Json = Record<string, unknown>;

/** Workbench names go to a root terminal: control and format characters are dropped. */
const printable = (text: string): string => text.replace(/[\p{Cc}\p{Cf}]/gu, '');

export interface WorkbenchSource {
  pairs: Json[];
  accounts: Json[];
  env: Record<string, string | undefined>;
  /** Pair rows whose JSON did not parse; they cannot be imported. */
  unreadablePairs?: number;
}

/** The caps written with the first oil account; the operator raises them in config.json. */
export const OIL_DEFAULT_LIMITS = { perJob: '200', openPer24h: '1000' } as const;
/** One workbench execution account of a venue this service trades oil on; `problem` says why it cannot come over. */
export interface OilCandidate {
  venue: Venue;
  accountMode: string | null;
  /** The workbench's verified identity (Binance UID, Bybit userID), unmasked: it becomes accountId. */
  accountId: string | null;
  credentialVersion: number | null;
  credentials: LiveCredentials | null;
  problem: string | null;
}
/**
 * A workbench auto rule, reduced to what decides whether it trades oil on its own right now. `active`: the rule has a job
 * running or awaiting review (phase opening / closing / review), enabled or not.
 */
export interface OilRule { name: string; venue: string | null; oil: boolean; live: boolean; active: boolean }
/** A workbench execution job not yet completed or stopped, with the venues its legs use. */
export interface WorkbenchJob { id: string; status: string; venues: string[] }
export interface OilSource { hub: string; accounts: OilCandidate[]; rules: OilRule[]; unreadableRules: number; jobs: WorkbenchJob[]; unreadableJobs: number }
/** What the plan did with one oil account; only the masked account id leaves this file. */
export interface OilItem { venue: Venue; accountMode: string | null; accountId: string | null; blockedBy: string[]; status: 'added' | 'skipped'; detail: string }
/** One workbench pair the plan looked at; `detail` is the reason it was skipped or the accounts it brings. */
export interface ImportItem { id: string; status: 'added' | 'skipped'; detail: string }
export interface ImportPlan {
  config: Json;
  secrets: Json;
  /** "label：detail" lines for a terminal. */
  added: string[];
  skipped: string[];
  items: ImportItem[];
  /** The oil accounts looked at (empty without options.oil). */
  oil: OilItem[];
  /** The options account looked at (null without options.options). */
  options: OptionsItem | null;
  notes: string[];
}
/** What the page shows for each workbench pair before anything is written: whether it could come over on its own. */
export interface PreviewItem { id: string; name: string | null; marginEnabled: boolean; importable: boolean; detail: string }

const isRecord = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);
const tail = (address: string): string => `***${address.slice(-4)}`;

/** The workbench's credentials for one environment prefix, or why there are none (never the values). */
function credentialsFor(env: WorkbenchSource['env'], prefix: string): AsterCredentials | string {
  const user = env[`${prefix}_USER`], signer = env[`${prefix}_SIGNER`], privateKey = env[`${prefix}_PRIVATE_KEY`];
  if (!user || !signer || !privateKey) return `服务器环境里没有 ${prefix} 的完整凭据（${prefix}_USER / _SIGNER / _PRIVATE_KEY）`;
  try { return parseAsterCredentials({ user, signer, privateKey }, prefix); } catch (error) { return error instanceof Error ? error.message : `${prefix} 凭据无效`; }
}

/**
 * The robot the workbench's ASTER module sends with: events go to the split event channel when configured, else the
 * legacy one; the scheduled summary has its own robot only in split mode (in legacy mode it shares the one robot, which
 * is what this service does without `feishuScheduled`).
 */
function feishuOf(env: WorkbenchSource['env'], channel: 'EVENT' | 'SCHEDULED' = 'EVENT'): Json | null {
  const split = ['EVENT', 'SCHEDULED'].some(name => env[`FEISHU_${name}_WEBHOOK_URL`] !== undefined || env[`FEISHU_${name}_SIGN_SECRET`] !== undefined);
  if (!split && channel === 'SCHEDULED') return null;
  const [hook, sign] = split ? [`FEISHU_${channel}_WEBHOOK_URL`, `FEISHU_${channel}_SIGN_SECRET`] : ['FEISHU_WEBHOOK_URL', 'FEISHU_SIGN_SECRET'];
  const webhook = env[hook]?.trim(), secret = env[sign]?.trim();
  return webhook ? { webhook, ...(secret ? { secret } : {}) } : null;
}

/**
 * Works out the files after the import. `existing` is the current config.json and secrets.json (raw JSON), or null on a
 * first setup. Throws when the result would not load: the caller then writes nothing.
 */
export function planImport(source: WorkbenchSource, existing: { config: Json; secrets: Json } | null, options: { secretsFile: string; only?: readonly string[]; known?: ReadonlyMap<string, AsterCredentials>; requireMargin?: boolean; oil?: OilSource; options?: OptionsSource }): ImportPlan {
  const config: Json = existing ? structuredClone(existing.config) : { secretsFile: options.secretsFile, pairs: [] };
  const secrets: Json = existing ? structuredClone(existing.secrets) : { accounts: {} };
  // An oil-only or options-only config has no pairs yet; its module blocks and their keys are carried over untouched.
  if (existing && config.pairs === undefined && (config.oil !== undefined || config.options !== undefined)) config.pairs = [];
  if (!Array.isArray(config.pairs)) throw new Error('现有 config.json 的 pairs 不是列表');
  if (!isRecord(secrets.accounts)) throw new Error('现有密钥文件的 accounts 不是对象');
  const pairs = config.pairs as Json[], accounts = secrets.accounts as Record<string, Json>;
  const added: string[] = [], skipped: string[] = [], items: ImportItem[] = [], notes: string[] = [];

  const byId = new Map(source.accounts.filter(isRecord).map(account => [account.id, account]));
  const usedSubs = new Set(pairs.flatMap(pair => [pair.long, pair.short]));
  const wanted = options.only ? new Set(options.only) : null;
  const unreadable = source.unreadablePairs ?? 0;
  if (wanted) for (const id of wanted) {
    if (!source.pairs.some(pair => pair.id === id)) throw new Error(`工作台里没有配对 ${printable(id)}${unreadable ? `（另有 ${unreadable} 条配对记录无法解析，可能就是它）` : ''}`);
  }
  if (unreadable) notes.push(`工作台有 ${unreadable} 条配对记录无法解析，未导入`);

  // The existing keys are checked once (every signer derived, about 20 ms a key); the per-candidate checks below and
  // the wallet matching use these normalised entries.
  // A caller planning many times (the page's preview, one pair at a time) passes them in, already checked.
  let known: Map<string, AsterCredentials>;
  // The oil venues' keys are allowed in the key file only when config.json names oil accounts (an invalid oil block is the
  // existing-config check's to report below).
  let oilVenues: Venue[] = [], hasOptions = false;
  try { const parsed = parseServiceConfig(config); oilVenues = parsed.oil?.accounts.map(account => account.venue) ?? []; hasOptions = parsed.options !== undefined; } catch { oilVenues = []; }
  try { known = new Map(options.known ?? parseServiceSecrets(secrets, [], oilVenues, hasOptions).accounts); }
  catch (error) { throw new Error(`现有密钥文件未通过检查，先修好再导入：${error instanceof Error ? error.message : String(error)}`); }
  /** Throws when this service would not start on these files: its config checks, with the signers already in hand. */
  const fits = (candidate: Json): void => {
    const parsed = parseServiceConfig(candidate);
    for (const name of parsed.pairs.flatMap(pair => [pair.main, pair.long, pair.short])) if (!known.has(name)) throw new Error(`缺少账户 ${name} 的密钥`);
    assertDistinctSigners(parsed, { accounts: known, feishu: null });
  };
  // Every pair is checked against what is there already; a config the service rejects now is not extended.
  if (existing) {
    try { fits(config); } catch (error) { throw new Error(`现有配置未通过检查，先修好再导入：${error instanceof Error ? error.message : String(error)}`); }
  }

  /** The account name for a wallet: the existing entry with that address, else the workbench prefix. */
  const nameFor = (prefix: string, credentials: AsterCredentials): string | null => {
    for (const [name, entry] of known) if (entry.user === credentials.user) return name;
    return known.has(prefix) || accounts[prefix] !== undefined ? null : prefix;
  };

  for (const pair of source.pairs) {
    const id = String(pair.id), label = printable(typeof pair.name === 'string' ? `${id}（${pair.name}）` : id);
    const skip = (reason: string): void => { skipped.push(`${label}：${reason}`); items.push({ id, status: 'skipped', detail: reason }); };
    const margin = { ...MARGIN_DEFAULTS, ...(isRecord(pair.margin) ? pair.margin : {}) };
    if (wanted ? !wanted.has(id) : margin.enabled !== true) {
      if (!wanted) skip('工作台未开启保证金平衡');
      continue;
    }
    // The page imports only pairs the workbench balances: the service account asks for them, so it gets no other keys.
    if (options.requireMargin && margin.enabled !== true) { skip('工作台未开启保证金平衡，页面只导入已开启的配对'); continue; }
    if (pairs.some(item => item.id === id)) { skip(`已在本项目配置中，保留现有设置`); continue; }
    const long = byId.get(pair.long_account_id), short = byId.get(pair.short_account_id);
    if (!long || !short) { skip(`工作台里找不到它的子账户`); continue; }
    if (long.mode !== 'live' || short.mode !== 'live') { skip(`子账户不是实盘模式`); continue; }
    const master = margin.master_env_prefix, prefixes = [master, long.env_prefix, short.env_prefix];
    if (typeof master !== 'string' || !PREFIX.test(master)) { skip(`没有配置主账户凭据前缀`); continue; }
    if (!prefixes.every(prefix => typeof prefix === 'string' && PREFIX.test(prefix)) || new Set(prefixes).size !== 3) { skip(`主账户与两个子账户的凭据前缀须各不相同`); continue; }
    const creds = prefixes.map(prefix => credentialsFor(source.env, prefix as string));
    const missing = creds.find(item => typeof item === 'string');
    if (missing !== undefined) { skip(`${missing}`); continue; }
    const [mainCreds, longCreds, shortCreds] = creds as AsterCredentials[];
    if (new Set([mainCreds!.user, longCreds!.user, shortCreds!.user]).size !== 3) { skip(`主账户与两个子账户的钱包地址须各不相同`); continue; }
    if (mainCreds!.signer === longCreds!.signer || mainCreds!.signer === shortCreds!.signer) { skip(`主账户与子账户使用同一个 API 钱包，划转须为主账户单独配置`); continue; }
    const names = prefixes.map((prefix, index) => nameFor(prefix as string, [mainCreds, longCreds, shortCreds][index]!));
    if (names.some(name => name === null)) { skip(`现有密钥文件里已有同名账户但钱包地址不同`); continue; }
    const [mainName, longName, shortName] = names as string[];
    if (usedSubs.has(longName) || usedSubs.has(shortName)) { skip(`子账户已属于本项目的另一个配对`); continue; }

    const reserves = margin.absolute_reserve_enabled === true;
    const adlRaw = { ...ADL_DEFAULTS, ...(isRecord(pair.adl) ? pair.adl : {}) };
    const transfer = {
      threshold: String(margin.threshold), minTransfer: String(margin.min_transfer), maxTransfer: String(margin.max_transfer),
      bufferRatio: String(margin.buffer_ratio), longReserve: reserves ? String(margin.long_reserve) : '0', shortReserve: reserves ? String(margin.short_reserve) : '0',
      cooldownMs: Math.round(Number(margin.cooldown_seconds) * 1000), checkIntervalMs: Math.round(Number(margin.check_interval_seconds) * 1000),
    };
    const adl = { autoReduce: adlRaw.enabled === true, batchNotional: String(adlRaw.batch_notional) };
    // One pair this service would not accept is skipped with its reason rather than failing the whole import.
    try { parseTransferConfig(transfer); parseAdlConfig(adl); } catch (error) { skip(`设置无法沿用（${error instanceof Error ? error.message : '格式错误'}）`); continue; }

    const entry = { id, main: mainName, long: longName, short: shortName, transfer, adl };
    const fresh = ([[mainName, mainCreds], [longName, longCreds], [shortName, shortCreds]] as const).filter(([name]) => !known.has(name));
    for (const [name, credentials] of fresh) known.set(name, credentials!);
    // Limits over the whole file (the request budget, MAX_PAIRS, a main wallet that signs for another pair's
    // sub-account) skip the pair that crosses them, so the rest still come over.
    try { fits({ ...config, pairs: [...pairs, entry] }); }
    catch (error) {
      for (const [name] of fresh) known.delete(name);
      const message = error instanceof Error ? error.message : '格式错误';
      // Only a budget overrun is helped by bringing pairs over in batches (the existing file passed its checks above).
      const hint = /请求权重/.test(message) ? '；可分批导入' : '';
      skip(`加入后本服务不接受（${message}）${hint}`); continue;
    }
    for (const [name, credentials] of fresh) accounts[name] = { user: credentials!.user, signer: credentials!.signer, privateKey: credentials!.privateKey };
    pairs.push(entry);
    usedSubs.add(longName); usedSubs.add(shortName);
    const detail = `主账户 ${mainName}（${tail(mainCreds!.user)}），多侧 ${longName}（${tail(longCreds!.user)}），空侧 ${shortName}（${tail(shortCreds!.user)}）`;
    added.push(`${label}：${detail}`); items.push({ id, status: 'added', detail });
  }

  // The robot only comes along with a pair: with nothing imported the files are not written at all.
  if (added.length > 0 && (secrets.feishu === undefined || secrets.feishu === null)) {
    const feishu = feishuOf(source.env);
    if (feishu) {
      try { parseServiceSecrets({ accounts: {}, feishu }, []); secrets.feishu = feishu; notes.push('飞书机器人沿用工作台 ASTER 事件通知的机器人'); }
      catch { notes.push('工作台的飞书机器人地址不是自定义机器人的 https 地址，未导入；需要告警时请在密钥文件里自行填写 feishu'); }
    } else notes.push('工作台没有配置飞书机器人，告警只写日志');
  }
  if (added.length > 0 && (secrets.feishuScheduled === undefined || secrets.feishuScheduled === null)) {
    const scheduled = feishuOf(source.env, 'SCHEDULED');
    if (scheduled) {
      try { parseServiceSecrets({ accounts: {}, feishuScheduled: scheduled }, []); secrets.feishuScheduled = scheduled; notes.push('定时运行摘要沿用工作台 ASTER 定时通知的机器人'); }
      catch { notes.push('工作台的定时通知机器人地址不是自定义机器人的 https 地址，未导入；定时摘要改发告警机器人'); }
    }
  }

  const oil = options.oil ? planOil(options.oil, config, secrets, fits, notes) : [];
  const optionsItem = options.options ? planOptions(options.options, config, secrets, fits, notes) : null;
  // Each added pair passed the checks with everything before it, and every key was derived once, so the result passes.
  return { config, secrets, added, skipped, items, oil, options: optionsItem, notes };
}

const mask = (id: string | null): string | null => id === null ? null : `***${id.slice(-4)}`;

/**
 * Adds the workbench's oil execution accounts to `config` / `secrets` in place. A venue config.json already names keeps
 * its settings; the caps are written only with the oil block itself. An account the workbench still trades with is
 * refused: an enabled live oil rule, an oil rule whose job is still running or awaiting review (disabling a rule leaves
 * its job running), or any unfinished workbench execution job on that venue. Both programs would then send orders on it.
 */
function planOil(source: OilSource, config: Json, secrets: Json, fits: (candidate: Json) => void, notes: string[]): OilItem[] {
  const items: OilItem[] = [];
  const current = isRecord(config.oil) ? config.oil : null;
  const configured = new Set(current && Array.isArray(current.accounts) ? current.accounts.filter(isRecord).map(account => account.venue) : []);
  const fresh: { item: OilItem; binding: Json; credentials: LiveCredentials }[] = [];
  if (source.accounts.length === 0) notes.push('工作台没有连接 Binance / Bybit 执行账户，没有原油执行账户可导入');
  for (const candidate of source.accounts) {
    // A rule whose venue cannot be read could be on this one; any unreadable rule could be a live oil rule.
    const blockedBy = source.rules.filter(rule => rule.oil && (rule.live || rule.active) && (rule.venue === candidate.venue || rule.venue === null)).map(rule => rule.name);
    const busy = source.jobs.filter(job => job.venues.includes(candidate.venue));
    const item: OilItem = { venue: candidate.venue, accountMode: candidate.accountMode, accountId: mask(candidate.accountId), blockedBy, status: 'skipped', detail: '' };
    items.push(item);
    if (configured.has(candidate.venue)) { item.detail = '已在本项目配置中，保留现有设置'; continue; }
    if (candidate.problem !== null || !candidate.credentials || candidate.accountId === null || candidate.credentialVersion === null || candidate.accountMode === null) { item.detail = candidate.problem ?? '未能判断'; continue; }
    if (source.unreadableRules > 0) { item.detail = `工作台有 ${source.unreadableRules} 条自动规则无法解析，无法确认没有实盘启用的原油自动规则；先在工作台停用原油自动规则`; continue; }
    if (blockedBy.length) { item.detail = `先在工作台停用原油自动规则（${blockedBy.join('、')}），并等它执行中的任务结束、待核对的处理完，两边同时下单会抢同一个账户`; continue; }
    if (source.unreadableJobs > 0) { item.detail = `工作台有 ${source.unreadableJobs} 个执行任务无法解析，无法确认该账户上没有进行中的任务；先在工作台执行进度里核对`; continue; }
    if (busy.length) { item.detail = `工作台还有未结束的执行任务在用该账户（${busy.slice(0, 3).map(job => `${job.id.slice(0, 8)} ${job.status}`).join('、')}${busy.length > 3 ? ` 等 ${busy.length} 个` : ''}）；先在工作台执行进度里让它们完成或停止再导入`; continue; }
    if (secrets[candidate.venue] !== undefined) { item.detail = `现有密钥文件里已有 ${candidate.venue} 的密钥但 config.json 没有对应账户，不覆盖；请先确认并移走它`; continue; }
    fresh.push({ item, credentials: candidate.credentials, binding: { venue: candidate.venue, accountId: candidate.accountId, accountMode: candidate.accountMode, credentialVersion: candidate.credentialVersion } });
  }
  if (fresh.length === 0) return items;
  const accounts = [...(current && Array.isArray(current.accounts) ? current.accounts : []), ...fresh.map(entry => entry.binding)];
  const oil = current ? { ...current, accounts } : { notionalLimits: { ...OIL_DEFAULT_LIMITS }, accounts };
  const keys: Json = { ...secrets };
  for (const entry of fresh) keys[entry.item.venue] = { apiKey: entry.credentials.apiKey, apiSecret: entry.credentials.apiSecret };
  try {
    fits({ ...config, oil });
    parseOilSecrets(keys, accounts.filter(isRecord).map(account => account.venue as Venue));
  } catch (error) {
    // Messages built by these checks never carry a key (oil-config.ts).
    const reason = `加入后本服务不接受（${error instanceof Error ? error.message : '格式错误'}）`;
    for (const entry of fresh) entry.item.detail = reason;
    return items;
  }
  config.oil = oil;
  for (const entry of fresh) {
    secrets[entry.item.venue] = keys[entry.item.venue];
    entry.item.status = 'added';
    entry.item.detail = `${VENUE_NAMES[entry.item.venue]} ${entry.binding.accountMode} 账户 ${entry.item.accountId}，凭据版本 ${String(entry.binding.credentialVersion)}`;
  }
  if (!current) notes.push(`首次写入原油配置，名义金额上限取默认值：单笔 ${OIL_DEFAULT_LIMITS.perJob} USDT、24 小时开仓 ${OIL_DEFAULT_LIMITS.openPer24h} USDT；要调整请改 config.json 的 oil.notionalLimits 后执行 sudo bash install.sh`);
  return items;
}

/**
 * Each workbench pair planned on its own against the existing files, so the page can show which pairs could come over
 * and why the others cannot. Pairs that only fit one at a time (the request budget) show up when the selection is
 * imported. Throws when the existing files fail their checks: nothing could be imported then.
 */
export function previewImport(source: WorkbenchSource, existing: { config: Json; secrets: Json } | null, options: { secretsFile: string; oil?: OilSource; options?: OptionsSource }): { items: PreviewItem[]; oil: OilItem[]; options: OptionsItem | null; notes: string[] } {
  // The oil and options accounts are planned once, with no pair: the page imports them together or on their own.
  const base = planImport(source, existing, { secretsFile: options.secretsFile, only: [], requireMargin: true, ...(options.oil ? { oil: options.oil } : {}), ...(options.options ? { options: options.options } : {}) });
  const parsedBase = parseServiceConfig(base.config);
  const known = new Map(parseServiceSecrets(base.secrets, [], parsedBase.oil?.accounts.map(account => account.venue) ?? [], parsedBase.options !== undefined).accounts);
  const items = source.pairs.map((pair): PreviewItem => {
    const id = String(pair.id);
    const name = typeof pair.name === 'string' ? printable(pair.name).slice(0, 80) : null;
    const marginEnabled = isRecord(pair.margin) && pair.margin.enabled === true;
    let item: ImportItem | undefined;
    try { item = planImport(source, existing, { secretsFile: options.secretsFile, only: [id], known, requireMargin: true }).items[0]; }
    catch (error) { item = { id, status: 'skipped', detail: error instanceof Error ? error.message : String(error) }; }
    return { id: printable(id).slice(0, 64), name, marginEnabled, importable: item?.status === 'added', detail: printable(item?.detail ?? '未能判断').slice(0, 300) };
  });
  return { items, oil: base.oil, options: base.options, notes: base.notes };
}

/** Prints the raw data column of both tables; run with no environment, as the database's owner when that matters. */
const DUMP_ROWS = `import { DatabaseSync } from 'node:sqlite';
try {
  const db = new DatabaseSync(process.argv[1], { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const rows = table => db.prepare('SELECT data FROM ' + table + ' ORDER BY id').all().map(row => String(row.data));
    process.stdout.write(JSON.stringify({ pairs: rows('pairs'), accounts: rows('accounts') }));
  } finally { db.close(); }
} catch (error) { process.stderr.write(String(error && error.message || error).split('\\n')[0]); process.exitCode = 1; }`;

/** Root reads as the owner of the database (so any file SQLite adds is the workbench's); anyone else reads as itself. */
export function readerIdentity(owner: { uid: number; gid: number }, uid: number | undefined): { uid: number; gid: number } | Record<string, never> {
  return uid === 0 && owner.uid !== 0 ? { uid: owner.uid, gid: owner.gid } : {};
}

/** Reads the workbench's ASTER pairs and accounts without writing to its database. */
export function readWorkbench(envFile: string, dataDir: string | undefined, options: { asterOptional?: boolean } = {}): WorkbenchSource & { database: string; data: string } {
  const base = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
  const data = dataDir ?? base.DATA_DIR ?? WORKBENCH_DATA;
  if (!isAbsolute(data)) throw new Error(`工作台数据目录须为绝对路径：${data}`);
  const moduleEnv = join(data, 'modules', 'aster', '.env');
  const env = { ...base, ...(existsSync(moduleEnv) ? parseEnv(readFileSync(moduleEnv, 'utf8')) : {}) };
  const database = join(data, 'modules', 'aster', 'trading.sqlite3');
  if (!existsSync(database)) {
    // An oil or options import does not need the ASTER module: a workbench that never ran it has no pairs to bring.
    if (options.asterOptional && (existsSync(join(data, 'hub.sqlite')) || existsSync(join(data, 'modules', 'greeks')))) return { pairs: [], accounts: [], env, database, data };
    throw new Error(`没有找到工作台的 ASTER 数据库 ${database}；工作台数据目录不在默认位置时用 --workbench-data 指定`);
  }
  // A read-only connection still creates -wal and -shm when it is the first one on a WAL database (the workbench opens
  // and closes one per operation, so that is the usual state). Made by root they would leave the workbench unable to
  // write, so a root import reads as the database's owner, in a child process that only prints the rows.
  // A link could point root's read at another file: only the plain file is read, and a root-owned one in a directory
  // someone else owns (the workbench account could have swapped it in) is refused.
  const owner = lstatSync(database);
  if (!owner.isFile()) throw new Error(`工作台的 ASTER 数据库 ${database} 不是普通文件（符号链接等），不读取`);
  if (process.getuid?.() === 0 && owner.uid === 0 && statSync(dirname(database)).uid !== 0) throw new Error(`${database} 归 root，但所在目录归其他账户，不读取；请确认文件来源`);
  const identity = readerIdentity(owner, process.getuid?.());
  const read = spawnSync(process.execPath, ['--input-type=module', '-e', DUMP_ROWS, '--', database], {
    cwd: '/', env: {}, encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024, ...identity,
  });
  if (read.error || read.status !== 0) {
    const reason = printable(read.error?.message ?? (read.stderr.trim() || `退出码 ${read.status ?? read.signal}`)).slice(0, 200);
    const as = 'uid' in identity ? `（以数据库属主 uid ${identity.uid} 读取，不带附加组）` : '';
    throw new Error(`读取工作台数据库 ${database} 失败${as}：${reason}`);
  }
  const dumped = JSON.parse(read.stdout) as { pairs: string[]; accounts: string[] };
  const parse = (rows: string[]): unknown[] => rows.map(row => { try { return JSON.parse(row) as unknown; } catch { return null; } });
  const pairs = parse(dumped.pairs);
  return { pairs: pairs.filter(isRecord), accounts: parse(dumped.accounts).filter(isRecord), env, database, data, unreadablePairs: pairs.filter(item => !isRecord(item)).length };
}

/**
 * Prints the credential key and the rows of the two tables the oil import needs; run with no environment, as the
 * database's owner. The workbench's own rule for reading hub.sqlite from outside (contract-probes workbench-accounts.ts,
 * LESSONS L063): an unfinished rollback journal is refused; pending WAL pages are read only while the workbench runs (its
 * -shm is there, so nothing new is created), and without them the file is opened immutable. A refusal is a code on stdout.
 */
const DUMP_HUB = `import { DatabaseSync } from 'node:sqlite';
import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [hub, keyFile] = process.argv.slice(1);
const out = value => process.stdout.write(JSON.stringify(value));
const size = suffix => { try { return statSync(hub + suffix).size; } catch (error) { if (error && error.code === 'ENOENT') return null; throw error; } };
try {
  const pending = Boolean(size('-wal')), shared = size('-shm') !== null;
  if (size('-journal')) out({ refused: 'journal' });
  else if (pending && !shared) out({ refused: 'wal' });
  else {
    const key = readFileSync(keyFile);
    if (key.length !== 32) out({ refused: 'key' });
    else {
      // immutable (no locking, no change detection) only when nothing can be writing: no WAL content and no -shm. A
      // running workbench keeps -shm even right after a checkpoint empties the WAL; then a normal read-only open.
      const db = new DatabaseSync(pending || shared ? hub : pathToFileURL(hub).href + '?immutable=1', { readOnly: true });
      try {
        db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=750');
        const has = name => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
        const accounts = has('execution_accounts') ? db.prepare('SELECT * FROM execution_accounts ORDER BY exchange').all()
          .map(row => ({ exchange: row.exchange, revision: row.revision, credentials: row.credentials ?? null, account_mode: row.account_mode, identity: row.identity ?? null })) : [];
        const rules = has('execution_auto_rules') ? db.prepare('SELECT enabled, config, state FROM execution_auto_rules ORDER BY created_at, rowid').all()
          .map(row => ({ enabled: row.enabled, config: row.config, state: row.state })) : [];
        // Unfinished jobs only (the workbench's FINAL_EXECUTION: completed, stopped); a row that is not JSON is kept so
        // it counts as unreadable. CASE keeps json_extract off invalid rows.
        const jobs = has('execution_jobs') ? db.prepare("SELECT id, json FROM execution_jobs WHERE CASE WHEN json_valid(json) THEN coalesce(json_extract(json,'$.status'),'') NOT IN ('completed','stopped') ELSE 1 END ORDER BY rowid").all()
          .map(row => ({ id: row.id, json: row.json })) : [];
        out({ key: key.toString('base64'), accounts, rules, jobs });
      } finally { db.close(); }
    }
  }
} catch (error) { process.stderr.write(String(error && error.message || error).split('\\n')[0]); process.exitCode = 1; }`;

const DECRYPT_FAILED = 'decrypt_failed';
/**
 * The workbench's credential cipher (server/runtime/credentials.mjs): base64 of iv(12) + tag(16) + AES-256-GCM ciphertext
 * of a JSON value. Any failure is one fixed error, so nothing of the ciphertext or the plaintext reaches a message.
 */
export function decryptCredential(key: Buffer, blob: string): unknown {
  try {
    const buffer = Buffer.from(blob, 'base64');
    if (key.length !== 32 || buffer.length < 29) throw new Error(DECRYPT_FAILED);
    const decipher = createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12), { authTagLength: 16 });
    decipher.setAuthTag(buffer.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString('utf8')) as unknown;
  } catch { throw new Error(DECRYPT_FAILED); }
}

const ACCOUNT_ID = /^[0-9A-Za-z_-]{1,64}$/;
const MODE_TEXT = /^[a-z][a-z0-9-]{0,31}$/;

/** The Binance/Bybit rows of execution_accounts as import candidates; other venues (OKX) are not this service's. */
export function oilCandidates(key: Buffer, rows: readonly unknown[]): OilCandidate[] {
  const candidates: OilCandidate[] = [];
  for (const row of rows) {
    if (!isRecord(row) || typeof row.exchange !== 'string' || !(VENUES as readonly string[]).includes(row.exchange)) continue;
    const venue = row.exchange as Venue;
    const accountMode = typeof row.account_mode === 'string' && MODE_TEXT.test(row.account_mode) ? row.account_mode : null;
    const accountId = typeof row.identity === 'string' && ACCOUNT_ID.test(row.identity) ? row.identity : null;
    const credentialVersion = typeof row.revision === 'number' && Number.isSafeInteger(row.revision) && row.revision >= 1 ? row.revision : null;
    const base = { venue, accountMode, accountId, credentialVersion };
    const refuse = (problem: string): void => { candidates.push({ ...base, credentials: null, problem }); };
    if (row.credentials === null || row.credentials === '') { refuse('工作台未连接该执行账户'); continue; }
    if (typeof row.credentials !== 'string') { refuse('工作台的凭据记录格式错误'); continue; }
    let value: unknown;
    try { value = decryptCredential(key, row.credentials); } catch { refuse('凭据无法解密（credentials.key 与 hub.sqlite 不匹配，或记录已损坏）'); continue; }
    if (!isRecord(value) || value.purpose !== 'execution') { refuse('凭据用途不是执行账户（purpose 须为 execution），不导入'); continue; }
    if (value.exchange !== venue) { refuse('凭据所属交易所与记录不一致，不导入'); continue; }
    const credentials = { apiKey: value.apiKey, apiSecret: value.apiSecret } as LiveCredentials;
    if (!validCredentials(credentials)) { refuse('凭据里的 API 密钥不完整或格式无效'); continue; }
    if (credentialVersion === null) { refuse('工作台记录的凭据版本无效（须为正整数）'); continue; }
    if (accountMode === null || !ACCOUNT_MODES[venue].includes(accountMode)) {
      refuse(`账户模式${accountMode ? ` ${accountMode} ` : '未知，'}不支持：Binance 只支持 standard / portfolio-margin，Bybit 只支持 unified`); continue;
    }
    if (accountId === null) { refuse('工作台没有记录该账户的身份（UID），须先在工作台重新验证该执行账户再导入'); continue; }
    candidates.push({ ...base, credentials: { apiKey: credentials.apiKey, apiSecret: credentials.apiSecret }, problem: null });
  }
  return candidates;
}

/** The auto rules as the workbench reads them (trading-auto.mjs parse): live unless state.mode is observe, enabled only then. */
export function oilRules(rows: readonly unknown[]): { rules: OilRule[]; unreadable: number } {
  const rules: OilRule[] = [];
  let unreadable = 0;
  for (const row of rows) {
    let config: unknown, state: unknown;
    try { if (!isRecord(row)) throw new Error(); config = JSON.parse(String(row.config)); state = JSON.parse(String(row.state)); } catch { unreadable++; continue; }
    if (!isRecord(row) || !isRecord(config) || !isRecord(state)) { unreadable++; continue; }
    const venue = typeof config.exchange === 'string' ? config.exchange : null;
    const title = typeof config.name === 'string' && config.name.trim() ? config.name.trim() : `${venue ?? '未知交易所'} 原油价差`;
    rules.push({ name: printable(title).slice(0, 60), venue, oil: config.market === 'oil', live: state.mode !== 'observe' && Boolean(row.enabled), active: ['opening', 'closing', 'review'].includes(state.phase as string) });
  }
  return { rules, unreadable };
}

/** Unfinished workbench jobs (trading-execution.mjs: plan.legs[] and totals[] carry `exchange`); a job without any is unreadable. */
export function workbenchJobs(rows: readonly unknown[]): { jobs: WorkbenchJob[]; unreadable: number } {
  const jobs: WorkbenchJob[] = [];
  let unreadable = 0;
  for (const row of rows) {
    let job: unknown;
    try { if (!isRecord(row)) throw new Error(); job = JSON.parse(String(row.json)); } catch { unreadable++; continue; }
    if (!isRecord(row) || !isRecord(job)) { unreadable++; continue; }
    const legs = [...(isRecord(job.plan) && Array.isArray(job.plan.legs) ? job.plan.legs : []), ...(Array.isArray(job.totals) ? job.totals : [])];
    const venues = [...new Set(legs.filter(isRecord).map(leg => leg.exchange).filter((venue): venue is string => typeof venue === 'string'))];
    if (!venues.length) { unreadable++; continue; }
    jobs.push({ id: printable(String(row.id)).slice(0, 64), status: typeof job.status === 'string' ? printable(job.status).slice(0, 20) : '未知状态', venues });
  }
  return { jobs, unreadable };
}

/** Reads the workbench's execution accounts and auto rules without writing to hub.sqlite; the key never leaves this call. */
export function readWorkbenchOil(data: string): OilSource {
  if (!isAbsolute(data)) throw new Error(`工作台数据目录须为绝对路径：${data}`);
  const hub = join(data, 'hub.sqlite'), keyFile = join(data, 'credentials.key');
  for (const [path, name] of [[hub, '数据库'], [keyFile, '凭据密钥']] as const) {
    let stat;
    try { stat = lstatSync(path); } catch { throw new Error(`没有找到工作台的${name} ${path}；工作台数据目录不在默认位置时用 --workbench-data 指定`); }
    if (!stat.isFile()) throw new Error(`工作台的${name} ${path} 不是普通文件（符号链接等），不读取`);
    if (process.getuid?.() === 0 && stat.uid === 0 && statSync(dirname(path)).uid !== 0) throw new Error(`${path} 归 root，但所在目录归其他账户，不读取；请确认文件来源`);
  }
  const identity = readerIdentity(lstatSync(hub), process.getuid?.());
  const read = spawnSync(process.execPath, ['--input-type=module', '-e', DUMP_HUB, '--', hub, keyFile], {
    cwd: '/', env: {}, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024, ...identity,
  });
  const as = 'uid' in identity ? `（以数据库属主 uid ${identity.uid} 读取，不带附加组）` : '';
  if (read.error || read.status !== 0) {
    const reason = printable(read.error?.message ?? (read.stderr.trim() || `退出码 ${read.status ?? read.signal}`)).slice(0, 200);
    throw new Error(`读取工作台执行账户 ${hub} 失败${as}：${reason}`);
  }
  let dumped: { refused?: string; key?: string; accounts?: unknown[]; rules?: unknown[]; jobs?: unknown[] };
  try { dumped = JSON.parse(read.stdout) as typeof dumped; } catch { throw new Error(`读取工作台执行账户 ${hub} 失败${as}：输出无法解析`); }
  if (dumped.refused === 'journal') throw new Error(`${hub} 有未完成的回滚日志（-journal），不读取；等工作台写完（或重启工作台）后再导入`);
  if (dumped.refused === 'wal') throw new Error(`${hub} 有未合并的 WAL 而工作台未在运行，不读取；先启动工作台（它会合并 WAL）再导入`);
  if (dumped.refused === 'key') throw new Error(`${keyFile} 长度不是 32 字节，不是工作台的凭据密钥`);
  if (typeof dumped.key !== 'string' || !Array.isArray(dumped.accounts) || !Array.isArray(dumped.rules) || !Array.isArray(dumped.jobs)) throw new Error(`读取工作台执行账户 ${hub} 失败${as}：输出格式错误`);
  const key = Buffer.from(dumped.key, 'base64');
  try {
    const { rules, unreadable } = oilRules(dumped.rules);
    const { jobs, unreadable: unreadableJobs } = workbenchJobs(dumped.jobs);
    return { hub, accounts: oilCandidates(key, dumped.accounts), rules, unreadableRules: unreadable, jobs, unreadableJobs };
  } finally { key.fill(0); }
}

/** A synced private temporary file next to `path`, to be renamed over it. */
function stage(path: string, text: string, owner?: FileOwner): string {
  const temporary = `${path}.import.${process.pid}`;
  // Run as root on its own, the file keeps the owner of the one it replaces (or of the directory), not root's; the page's
  // helper names the service account, so a key file it creates is readable by the service.
  const reference = owner ?? statSync(present(path) ? path : dirname(path));
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    if (process.getuid?.() === 0) fchownSync(fd, reference.uid, reference.gid);
    writeSync(fd, text); fsyncSync(fd);
  } catch (error) { closeSync(fd); rmSync(temporary, { force: true }); throw error; }
  closeSync(fd);
  return temporary;
}

/** Present without following a link: a dangling link counts, so it is refused rather than replaced. */
const present = (path: string): boolean => { try { lstatSync(path); return true; } catch { return false; } };

/** The text written for one of the two files. */
export const fileText = (value: Json): string => JSON.stringify(value, null, 2) + '\n';

/**
 * Replaces both files, or neither: when the config cannot be replaced the key file goes back as it was, the same inode
 * with its owner and mode. Temporary files (they hold keys) never stay behind. Takes the exact text, so the helper can
 * put back what was there before an import byte for byte.
 */
export interface FileOwner { uid: number; gid: number }

export function writeBoth(secretsFile: string, secrets: string, configFile: string, config: string, owner?: FileOwner): void {
  const previous = present(secretsFile) ? `${secretsFile}.import-old.${process.pid}` : null;
  const staged: string[] = [];
  try {
    staged.push(stage(secretsFile, secrets, owner));
    staged.push(stage(configFile, config, owner));
    if (previous) linkSync(secretsFile, previous);
    renameSync(staged[0]!, secretsFile);
    try { renameSync(staged[1]!, configFile); } catch (error) {
      if (previous) renameSync(previous, secretsFile); else rmSync(secretsFile, { force: true });
      throw error;
    }
  } finally {
    for (const file of staged) rmSync(file, { force: true });
    if (previous) rmSync(previous, { force: true });
  }
}

/** Puts both files back to the text they had before an import; null means the file was not there. */
export function restoreFiles(files: Pick<ExistingFiles, 'configFile' | 'secretsFile' | 'text'>, owner?: FileOwner): void {
  const { configFile, secretsFile, text } = files;
  // Config first: an import only adds accounts, so the old config never names one the newer key file lacks, and a stop
  // between the two leaves files the service still starts on.
  if (text.config === null) rmSync(configFile, { force: true }); else replaceOne(configFile, text.config, owner);
  if (text.secrets === null) rmSync(secretsFile, { force: true }); else replaceOne(secretsFile, text.secrets, owner);
}

export function replaceOne(path: string, text: string, owner?: FileOwner): void {
  const staged = stage(path, text, owner);
  try { renameSync(staged, path); } finally { rmSync(staged, { force: true }); }
}

/** Reads one of this service's files as JSON; a parse error never quotes the text (it holds keys). */
function readText(path: string, name: string): string {
  // A link is not ours to replace (install.sh does not take linked files over either).
  if (lstatSync(path).isSymbolicLink()) throw new Error(`${name} ${path} 是符号链接，不自动改写；请换成普通文件或手动合并`);
  return readFileSync(path, 'utf8');
}

/** This service's files as they are now: parsed for planning, and the exact text for putting them back. */
export interface ExistingFiles {
  configFile: string;
  secretsFile: string;
  /** Null on a first setup (no config.json). */
  existing: { config: Json; secrets: Json } | null;
  /** The text of each file that exists, null for one that does not. */
  text: { config: string | null; secrets: string | null };
}

export function readExisting(configPath: string): ExistingFiles {
  if (!isAbsolute(configPath)) throw new Error('需要 --config <本项目 config.json 的绝对路径>');
  const configFile = resolve(configPath), confDir = dirname(configFile);
  let secretsFile = join(confDir, 'secrets.json');
  if (present(configFile)) {
    const configText = readText(configFile, '现有 config.json');
    const config = parsePrivateJson(configText, '现有 config.json');
    if (!isRecord(config) || typeof config.secretsFile !== 'string') throw new Error('现有 config.json 无法读取 secretsFile');
    secretsFile = config.secretsFile;
    // Only a key file of this directory is rewritten; one elsewhere (say the workbench's) is left alone.
    if (dirname(resolve(secretsFile)) !== confDir) throw new Error(`现有 secretsFile ${secretsFile} 不在 ${confDir} 下，不自动改写；请手动合并`);
    const secretsText = present(secretsFile) ? readText(secretsFile, '现有密钥文件') : null;
    const secrets = secretsText === null ? { accounts: {} } : parsePrivateJson(secretsText, '现有密钥文件');
    if (!isRecord(secrets)) throw new Error('现有密钥文件不是 JSON 对象');
    return { configFile, secretsFile, existing: { config, secrets }, text: { config: configText, secrets: secretsText } };
  }
  if (present(secretsFile)) throw new Error(`${secretsFile} 已存在但没有 config.json；请先确认它的内容，移走后再导入`);
  return { configFile, secretsFile, existing: null, text: { config: null, secrets: null } };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    config: { type: 'string' }, 'workbench-env': { type: 'string' }, 'workbench-data': { type: 'string' }, pairs: { type: 'string' }, oil: { type: 'boolean' }, options: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
  } });
  const withOil = values.oil === true, withOptions = values.options === true, modules = withOil || withOptions;
  // --oil / --options alone bring their accounts only; pairs come along when named.
  const only = values.pairs ? values.pairs.split(',').map(item => item.trim()).filter(Boolean) : modules ? [] : undefined;
  const envFile = values['workbench-env'] ?? WORKBENCH_ENV;
  const source = readWorkbench(envFile, values['workbench-data'], { asterOptional: modules && (only?.length ?? 0) === 0 });
  const oilSource = withOil ? readWorkbenchOil(source.data) : undefined;
  const optionsSource = withOptions ? await resolveOptionsAccount(readWorkbenchOptions(envFile, source.data)) : undefined;
  const { configFile, secretsFile, existing } = readExisting(values.config ?? '');

  const plan = planImport(source, existing, { secretsFile, ...(only ? { only } : {}), ...(oilSource ? { oil: oilSource } : {}), ...(optionsSource ? { options: optionsSource } : {}) });
  const out = (line: string): void => { process.stdout.write(line + '\n'); };
  if (!modules || (only?.length ?? 0) > 0) out(`工作台数据库：${source.database}（只读）`);
  if (oilSource) out(`工作台执行账户：${oilSource.hub}（只读）`);
  if (optionsSource) out(`工作台期权状态：${optionsSource.stateFile}（只读）`);
  for (const line of plan.added) out(`导入配对 ${line}`);
  for (const line of plan.skipped) out(`跳过 ${line}`);
  for (const item of plan.oil) out(item.status === 'added' ? `导入原油执行账户 ${item.detail}` : `跳过原油执行账户 ${VENUE_NAMES[item.venue]}${item.accountId ? ` ${item.accountId}` : ''}：${item.detail}`);
  if (plan.options) out(plan.options.status === 'added' ? `导入期权账户 ${plan.options.detail}` : `跳过期权账户${plan.options.accountId ? ` ${plan.options.accountId}` : ''}：${plan.options.detail}`);
  for (const line of plan.notes) out(line);
  const oilAdded = plan.oil.filter(item => item.status === 'added').length, optionsAdded = plan.options?.status === 'added';
  if (plan.added.length === 0 && oilAdded === 0 && !optionsAdded) {
    const what = only?.length || !modules ? '配对' : [withOil ? '原油执行账户' : '', withOptions ? '期权账户' : ''].filter(Boolean).join('或');
    if (!existing) throw new Error(only?.length || !modules ? '工作台里没有可导入的配对（需开启保证金平衡、配好主账户凭据前缀且凭据齐全），未生成配置' : `工作台里没有可导入的${what}，未生成配置`);
    out(`没有新的${what}，配置未改动`);
    return;
  }
  if (values['dry-run']) { out('试运行：未写入任何文件'); return; }
  // Keys first, so the config never names a key file that lacks its accounts.
  writeBoth(secretsFile, fileText(plan.secrets), configFile, fileText(plan.config));
  const what = [plan.added.length ? '导入的配对登记为停用，在工作台删除该配对后到本项目页面启用' : '', oilAdded ? '原油执行账户已写入，服务启动后页面出现「原油」标签' : '', optionsAdded ? '期权账户已写入，服务启动后页面出现「期权」标签' : ''].filter(Boolean).join('；');
  out(`已写入 ${configFile} 与 ${secretsFile}；${what}`);
}

if (import.meta.main) {
  main().catch((error: unknown) => { process.stderr.write(`导入失败：${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
