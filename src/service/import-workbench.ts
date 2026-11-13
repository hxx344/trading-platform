// Brings the workbench's ASTER margin-balance pairs over into this service's two operator files, so a switch does not
// start from hand-copied settings. It only reads: the workbench's trading.sqlite3 (opened read-only, as its owner) and the
// environment it runs with (/etc/project-aggregation.env, then <data>/modules/aster/.env, which wins as it does in the
// workbench). Imported pairs are registered switched off like any configured pair; taking one over still needs the
// workbench pair deleted and the takeover checks passed in the page. Nothing is sent to ASTER or to the workbench.
//
//   node import-workbench.ts --config /etc/trading-platform/config.json [--workbench-env FILE] [--workbench-data DIR]
//                            [--pairs id,id] [--dry-run]
//
// An existing config.json is extended: its pairs, accounts and robot stay as they are, and only pairs it does not have
// yet are added. Output names pairs and account names only; keys and webhooks never appear in it.
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, fchownSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs, parseEnv } from 'node:util';
import { parseAsterCredentials, type AsterCredentials } from '../aster/client.ts';
import { parseTransferConfig, type Venue } from '../contracts.ts';
import { parseAdlConfig } from '../adl-contracts.ts';
import { parsePrivateJson } from '../live/setup.ts';
import { assertDistinctSigners, parseServiceConfig, parseServiceSecrets } from './config.ts';

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
/** One workbench pair the plan looked at; `detail` is the reason it was skipped or the accounts it brings. */
export interface ImportItem { id: string; status: 'added' | 'skipped'; detail: string }
export interface ImportPlan {
  config: Json;
  secrets: Json;
  /** "label：detail" lines for a terminal. */
  added: string[];
  skipped: string[];
  items: ImportItem[];
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

/** The robot the workbench's ASTER module sends events with: the split event channel when configured, else the legacy one. */
function feishuOf(env: WorkbenchSource['env']): Json | null {
  const split = ['EVENT', 'SCHEDULED'].some(channel => env[`FEISHU_${channel}_WEBHOOK_URL`] !== undefined || env[`FEISHU_${channel}_SIGN_SECRET`] !== undefined);
  const [hook, sign] = split ? ['FEISHU_EVENT_WEBHOOK_URL', 'FEISHU_EVENT_SIGN_SECRET'] : ['FEISHU_WEBHOOK_URL', 'FEISHU_SIGN_SECRET'];
  const webhook = env[hook]?.trim(), secret = env[sign]?.trim();
  return webhook ? { webhook, ...(secret ? { secret } : {}) } : null;
}

/**
 * Works out the files after the import. `existing` is the current config.json and secrets.json (raw JSON), or null on a
 * first setup. Throws when the result would not load: the caller then writes nothing.
 */
export function planImport(source: WorkbenchSource, existing: { config: Json; secrets: Json } | null, options: { secretsFile: string; only?: readonly string[]; known?: ReadonlyMap<string, AsterCredentials>; requireMargin?: boolean }): ImportPlan {
  const config: Json = existing ? structuredClone(existing.config) : { secretsFile: options.secretsFile, pairs: [] };
  const secrets: Json = existing ? structuredClone(existing.secrets) : { accounts: {} };
  // An oil-only config has no pairs yet; its oil block and the oil keys are carried over untouched.
  if (existing && config.pairs === undefined && config.oil !== undefined) config.pairs = [];
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
  let oilVenues: Venue[] = [];
  try { oilVenues = parseServiceConfig(config).oil?.accounts.map(account => account.venue) ?? []; } catch { oilVenues = []; }
  try { known = new Map(options.known ?? parseServiceSecrets(secrets, [], oilVenues).accounts); }
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

  // Each added pair passed the checks with everything before it, and every key was derived once, so the result passes.
  return { config, secrets, added, skipped, items, notes };
}

/**
 * Each workbench pair planned on its own against the existing files, so the page can show which pairs could come over
 * and why the others cannot. Pairs that only fit one at a time (the request budget) show up when the selection is
 * imported. Throws when the existing files fail their checks: nothing could be imported then.
 */
export function previewImport(source: WorkbenchSource, existing: { config: Json; secrets: Json } | null, options: { secretsFile: string }): { items: PreviewItem[]; notes: string[] } {
  const base = planImport(source, existing, { secretsFile: options.secretsFile, only: [], requireMargin: true });
  const known = new Map(parseServiceSecrets(base.secrets, [], parseServiceConfig(base.config).oil?.accounts.map(account => account.venue) ?? []).accounts);
  const items = source.pairs.map((pair): PreviewItem => {
    const id = String(pair.id);
    const name = typeof pair.name === 'string' ? printable(pair.name).slice(0, 80) : null;
    const marginEnabled = isRecord(pair.margin) && pair.margin.enabled === true;
    let item: ImportItem | undefined;
    try { item = planImport(source, existing, { secretsFile: options.secretsFile, only: [id], known, requireMargin: true }).items[0]; }
    catch (error) { item = { id, status: 'skipped', detail: error instanceof Error ? error.message : String(error) }; }
    return { id: printable(id).slice(0, 64), name, marginEnabled, importable: item?.status === 'added', detail: printable(item?.detail ?? '未能判断').slice(0, 300) };
  });
  return { items, notes: base.notes };
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
export function readWorkbench(envFile: string, dataDir: string | undefined): WorkbenchSource & { database: string } {
  const base = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
  const data = dataDir ?? base.DATA_DIR ?? WORKBENCH_DATA;
  if (!isAbsolute(data)) throw new Error(`工作台数据目录须为绝对路径：${data}`);
  const moduleEnv = join(data, 'modules', 'aster', '.env');
  const env = { ...base, ...(existsSync(moduleEnv) ? parseEnv(readFileSync(moduleEnv, 'utf8')) : {}) };
  const database = join(data, 'modules', 'aster', 'trading.sqlite3');
  if (!existsSync(database)) throw new Error(`没有找到工作台的 ASTER 数据库 ${database}；工作台数据目录不在默认位置时用 --workbench-data 指定`);
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
  return { pairs: pairs.filter(isRecord), accounts: parse(dumped.accounts).filter(isRecord), env, database, unreadablePairs: pairs.filter(item => !isRecord(item)).length };
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

function main(): void {
  const { values } = parseArgs({ options: {
    config: { type: 'string' }, 'workbench-env': { type: 'string' }, 'workbench-data': { type: 'string' }, pairs: { type: 'string' }, 'dry-run': { type: 'boolean' },
  } });
  const only = values.pairs ? values.pairs.split(',').map(item => item.trim()).filter(Boolean) : undefined;
  const source = readWorkbench(values['workbench-env'] ?? WORKBENCH_ENV, values['workbench-data']);
  const { configFile, secretsFile, existing } = readExisting(values.config ?? '');

  const plan = planImport(source, existing, { secretsFile, ...(only ? { only } : {}) });
  const out = (line: string): void => { process.stdout.write(line + '\n'); };
  out(`工作台数据库：${source.database}（只读）`);
  for (const line of plan.added) out(`导入配对 ${line}`);
  for (const line of plan.skipped) out(`跳过 ${line}`);
  for (const line of plan.notes) out(line);
  if (plan.added.length === 0) {
    if (!existing) throw new Error('工作台里没有可导入的配对（需开启保证金平衡、配好主账户凭据前缀且凭据齐全），未生成配置');
    out('没有新的配对，配置未改动');
    return;
  }
  if (values['dry-run']) { out('试运行：未写入任何文件'); return; }
  // Keys first, so the config never names a key file that lacks its accounts.
  writeBoth(secretsFile, fileText(plan.secrets), configFile, fileText(plan.config));
  out(`已写入 ${configFile} 与 ${secretsFile}；导入的配对登记为停用，在工作台删除该配对后到本项目页面启用`);
}

if (import.meta.main) {
  try { main(); } catch (error) { process.stderr.write(`导入失败：${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
