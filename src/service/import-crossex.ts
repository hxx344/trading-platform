// The CrossEx part of the workbench import (docs/crossex.md §3, docs/module-import.md): the workbench CrossEx module's
// Gate key comes over into secrets.json `gate` and its account into config.json `crossex` ({ accountUid,
// credentialVersion, limits }). It reads <data>/modules/crossex/crossex.sqlite (live_connection, live_executions,
// live_orders, live_owner, settings) and credentials.key as the workbench data directory's owner, in a child process, under the same
// rules as the other workbench databases (LESSONS L063: an unfinished -journal is refused, pending WAL pages are read
// only while the workbench runs, otherwise the file is opened immutable; no symbolic links). It refuses while the
// workbench could still be trading on that key: not connected, an execution or order not finished, an open order in its
// cached account view, or a record it cannot read. A live lease of the workbench runtime is only a warning: the workbench
// must be disconnected after the import.
// On the first import (no `crossex` in config.json yet) the caps come from the workbench's stored settings, and its page
// settings are copied into this service's crossex.sqlite (as the data directory's owner, only when none are there).
// Only the masked UID, settings and reasons leave this file; the key never does.
import { spawnSync } from 'node:child_process';
import { createDecipheriv, createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { validCredentials, type LiveCredentials } from '../live/values.ts';
import { PAGE_SETTING_KEYS, type CrossexLimits } from '../crossex/store.ts';
import { configuration, defaults } from '../vendor/crossex/model.mjs';
import { parseCrossexConfig, parseCrossexLimits, parseCrossexSecrets } from './crossex-config.ts';
import { sourceEntry, sourceWorkerImport, workbenchIdentity } from './workbench-source.ts';
import { readerIdentity } from './import-workbench.ts';

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);
const reason = (error: unknown): string => error instanceof Error ? error.message : String(error);
const printable = (text: string): string => text.replace(/[\p{Cc}\p{Cf}]/gu, '');
const mask = (id: string | null): string | null => id === null ? null : `***${id.slice(-4)}`;

/** The workbench's CrossEx account, or why it cannot come over. */
export interface CrossexSource {
  database: string;
  credentials: LiveCredentials | null;
  accountUid: string | null;
  credentialVersion: number | null;
  /** The caps for a first import: the workbench's stored notionalPerLeg / maxOpen / maxTotalNotional. */
  limits: CrossexLimits | null;
  /** The page settings to copy on a first import (PAGE_SETTING_KEYS); null when they did not pass the checks. */
  settings: Json | null;
  /** The workbench runtime still holds its execution lease: it must be disconnected there after the import. */
  leaseActive: boolean;
  problem: string | null;
}
/** What the plan did with the CrossEx account; the UID is masked. */
export interface CrossexItem { accountId: string | null; status: 'added' | 'skipped'; detail: string; warning?: string }

export const LEASE_WARNING = '导入后在工作台 CrossEx 设置页断开账户';
const TERMINAL = ['FILLED', 'CANCELLED', 'FAIL', 'REJECT', 'UNSENT'];

/**
 * Prints the credential key and the rows the import needs; run with no environment, as the workbench data directory's owner, under the
 * same rule as DUMP_HUB in import-workbench.ts. A refusal is a code on stdout.
 */
const DUMP_CROSSEX = sourceWorkerImport + `import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [file, keyFile, terminal, root] = process.argv.slice(1);
const out = value => process.stdout.write(JSON.stringify(value));
try {
  withDatabasePath(root, file, path => {
    const size = suffix => { try { return statSync(path + suffix).size; } catch (error) { if (error && error.code === 'ENOENT') return null; throw error; } };
    const pending = Boolean(size('-wal')), shared = size('-shm') !== null;
    if (size('-journal')) out({ refused: 'journal' });
    else if (pending && !shared) out({ refused: 'wal' });
    else {
      const key = sourceBytes(root, keyFile, 32);
      if (key.length !== 32) out({ refused: 'key' });
      else {
        const db = new DatabaseSync(pending || shared ? path : pathToFileURL(path).href + '?immutable=1', { readOnly: true });
        try {
          db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=750');
          const has = name => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
          const final = JSON.parse(terminal), marks = final.map(() => '?').join(',');
          const connection = has('live_connection') ? db.prepare('SELECT json FROM live_connection WHERE singleton=1').get()?.json ?? null : null;
          const orders = has('live_orders') ? Number(db.prepare('SELECT count(*) AS n FROM live_orders WHERE state NOT IN (' + marks + ')').get(...final).n) : 0;
          // An execution with an order not final, or with no order at all (never seen from the workbench), is unfinished.
          const executions = has('live_executions') ? Number(db.prepare(has('live_orders')
            ? 'SELECT count(*) AS n FROM live_executions e WHERE NOT EXISTS (SELECT 1 FROM live_orders o WHERE o.execution_id=e.id) OR EXISTS (SELECT 1 FROM live_orders o WHERE o.execution_id=e.id AND o.state NOT IN (' + marks + '))'
            : 'SELECT count(*) AS n FROM live_executions').get(...(has('live_orders') ? final : [])).n) : 0;
          // The exchange's open orders as the workbench last saw them (its disconnect refuses on these too).
          const cache = has('live_cache') ? db.prepare('SELECT json FROM live_cache WHERE singleton=1').get()?.json ?? null : null;
          let open = 0;
          if (cache !== null) { try { const list = JSON.parse(cache)?.openOrders; open = Array.isArray(list) ? list.filter(o => !final.includes(o?.state)).length : 0; } catch { open = -1; } }
          const lease = has('live_owner') ? db.prepare('SELECT expires_at FROM live_owner WHERE singleton=1').get()?.expires_at ?? null : null;
          const config = has('settings') ? db.prepare("SELECT value FROM settings WHERE key='config'").get()?.value ?? null : null;
          out({ key: key.toString('base64'), connection, orders, executions, open, lease: lease === null ? null : Number(lease), config });
        } finally { db.close(); }
      }
    }
  });
} catch (error) { process.stderr.write(String(error && error.message || error).split('\\n')[0]); process.exitCode = 1; }`;

const DECRYPT_FAILED = 'decrypt_failed';
/**
 * The workbench CrossEx store's cipher (modules/crossex/server/store.mjs encrypt): base64 of iv(12) + AES-256-GCM
 * ciphertext + tag(16) of the raw string. Any failure is one fixed error, so nothing of either text reaches a message.
 */
export function decryptCrossex(key: Buffer, blob: string): string {
  try {
    const buffer = Buffer.from(blob, 'base64');
    if (key.length !== 32 || buffer.length < 29) throw new Error(DECRYPT_FAILED);
    const decipher = createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12), { authTagLength: 16 });
    decipher.setAuthTag(buffer.subarray(-16));
    return Buffer.concat([decipher.update(buffer.subarray(12, -16)), decipher.final()]).toString('utf8');
  } catch { throw new Error(DECRYPT_FAILED); }
}

/** What DUMP_CROSSEX prints, minus the refusals; exported for the tests, which build the rows themselves. */
export interface CrossexDump { key: Buffer; connection: string | null; orders: number; executions: number; /** Open orders in live_cache; -1 when unreadable. */ open: number; lease: number | null; config: string | null }

/** The candidate from the dumped rows (pure: the tests drive it directly). */
export function crossexCandidate(dump: CrossexDump, database: string, now = Date.now()): CrossexSource {
  const source: CrossexSource = { database, credentials: null, accountUid: null, credentialVersion: null, limits: null, settings: null, leaseActive: false, problem: null };
  try {
    source.leaseActive = dump.lease !== null && Number.isFinite(dump.lease) && dump.lease > now;
    if (dump.connection === null) throw new Error('工作台 CrossEx 没有连接实盘账户');
    let record: unknown;
    try { record = JSON.parse(dump.connection); } catch { throw new Error('工作台 CrossEx 的连接记录格式错误'); }
    if (!isRecord(record)) throw new Error('工作台 CrossEx 的连接记录格式错误');
    if (record.enabled !== true || record.apiKey === null || record.apiSecret === null) throw new Error('工作台 CrossEx 没有连接实盘账户（已断开）');
    if (typeof record.apiKey !== 'string' || typeof record.apiSecret !== 'string' || typeof record.version !== 'number' || !Number.isSafeInteger(record.version) || record.version < 1) throw new Error('工作台 CrossEx 的连接记录格式错误');
    let credentials: LiveCredentials;
    try { credentials = { apiKey: decryptCrossex(dump.key, record.apiKey).trim(), apiSecret: decryptCrossex(dump.key, record.apiSecret).trim() }; }
    catch { throw new Error('凭据无法解密（credentials.key 与 crossex.sqlite 不匹配，或记录已损坏）'); }
    if (!validCredentials(credentials)) throw new Error('工作台 CrossEx 凭据里的 API 密钥不完整或格式无效');
    // The runtime's own reference of the key it connected with (live-runtime.mjs hash); another value is a mixed-up record.
    if (typeof record.accountReference === 'string' && record.accountReference !== createHash('sha256').update(JSON.stringify(credentials.apiKey)).digest('hex')) throw new Error('工作台 CrossEx 的连接记录与凭据不一致');
    const uid = typeof record.accountUid === 'number' ? String(record.accountUid) : record.accountUid;
    if (typeof uid !== 'string' || !/^[1-9]\d{0,19}$/.test(uid)) throw new Error('工作台没有记录该 Gate 账户的 UID，须在工作台重新验证（断开后重新连接）再导入');
    if (dump.executions > 0) throw new Error(`工作台 CrossEx 还有 ${dump.executions} 笔执行未结束；先在工作台处理完`);
    if (dump.orders > 0) throw new Error(`工作台 CrossEx 还有 ${dump.orders} 笔订单未结束或结果未知；先在工作台核实成交或撤单`);
    if (dump.open < 0) throw new Error('工作台 CrossEx 的账户缓存无法解析，不能确认没有挂单');
    if (dump.open > 0) throw new Error(`工作台 CrossEx 账户还有 ${dump.open} 笔挂单；先在工作台撤单或等其结束`);
    let stored: unknown = {};
    if (dump.config !== null) { try { stored = JSON.parse(dump.config); } catch { stored = null; } }
    if (!isRecord(stored)) throw new Error('工作台 CrossEx 的页面设置无法解析');
    const merged = { ...defaults, ...stored } as Json;
    try { source.limits = parseCrossexLimits({ notionalPerLeg: merged.notionalPerLeg, maxOpen: merged.maxOpen, maxTotalNotional: merged.maxTotalNotional }, '工作台额度'); }
    catch (error) { throw new Error(`工作台 CrossEx 的额度本服务不接受：${reason(error)}`); }
    const settings = Object.fromEntries(PAGE_SETTING_KEYS.map(key => [key, merged[key]]));
    try { configuration(settings); source.settings = settings; } catch { source.settings = null; }
    source.credentials = credentials;
    source.accountUid = uid;
    source.credentialVersion = record.version;
  } catch (error) { source.problem = reason(error); }
  return source;
}

/** Reads the workbench CrossEx module without writing to it; the key never leaves this call. */
export function readWorkbenchCrossex(data: string, now = Date.now()): CrossexSource {
  if (!isAbsolute(data)) throw new Error(`工作台数据目录须为绝对路径：${data}`);
  const dir = join(data, 'modules', 'crossex'), database = join(dir, 'crossex.sqlite'), keyFile = join(dir, 'credentials.key');
  for (const [path, name] of [[database, 'CrossEx 数据库'], [keyFile, 'CrossEx 凭据密钥']] as const) {
    const stat = sourceEntry(data, path);
    if (!stat) throw new Error(`没有找到工作台的${name} ${path}；工作台数据目录不在默认位置时用 --workbench-data 指定`);
    if (!stat.isFile()) throw new Error(`工作台的${name} ${path} 不是普通文件（符号链接等），不读取`);
  }
  const identity = workbenchIdentity(data, dir);
  const read = spawnSync(process.execPath, ['--input-type=module', '-e', DUMP_CROSSEX, '--', database, keyFile, JSON.stringify(TERMINAL), data], {
    cwd: '/', env: {}, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024, ...identity,
  });
  const as = 'uid' in identity ? `（以工作台账户 uid ${identity.uid} 读取，不带附加组）` : '';
  if (read.error || read.status !== 0) {
    const why = printable(read.error?.message ?? (read.stderr.trim() || `退出码 ${read.status ?? read.signal}`)).slice(0, 200);
    throw new Error(`读取工作台 CrossEx 数据库 ${database} 失败${as}：${why}`);
  }
  let dumped: { refused?: string; key?: string; connection?: unknown; orders?: unknown; executions?: unknown; open?: unknown; lease?: unknown; config?: unknown };
  try { dumped = JSON.parse(read.stdout) as typeof dumped; } catch { throw new Error(`读取工作台 CrossEx 数据库 ${database} 失败${as}：输出无法解析`); }
  if (dumped.refused === 'journal') throw new Error(`${database} 有未完成的回滚日志（-journal），不读取；等工作台写完（或重启工作台）后再导入`);
  if (dumped.refused === 'wal') throw new Error(`${database} 有未合并的 WAL 而工作台未在运行，不读取；先启动工作台（它会合并 WAL）再导入`);
  if (dumped.refused === 'key') throw new Error(`${keyFile} 长度不是 32 字节，不是工作台 CrossEx 的凭据密钥`);
  if (typeof dumped.key !== 'string' || typeof dumped.orders !== 'number' || typeof dumped.executions !== 'number' || typeof dumped.open !== 'number'
    || !(dumped.connection === null || typeof dumped.connection === 'string') || !(dumped.config === null || typeof dumped.config === 'string')
    || !(dumped.lease === null || typeof dumped.lease === 'number')) throw new Error(`读取工作台 CrossEx 数据库 ${database} 失败${as}：输出格式错误`);
  const key = Buffer.from(dumped.key, 'base64');
  try { return crossexCandidate({ key, connection: dumped.connection, orders: dumped.orders, executions: dumped.executions, open: dumped.open, lease: dumped.lease, config: dumped.config }, database, now); }
  finally { key.fill(0); }
}

/**
 * Adds config.json `crossex` and secrets.json `gate` in place, or says why not. A `crossex` block already there is kept as
 * it is; a `gate` key without one is not overwritten. `settings` on the item's return is what to copy into crossex.sqlite.
 */
export function planCrossex(source: CrossexSource, config: Json, secrets: Json, fits: (candidate: Json) => void, notes: string[]): { item: CrossexItem; settings: Json | null } {
  const item: CrossexItem = { accountId: mask(source.accountUid), status: 'skipped', detail: '' };
  if (source.leaseActive) item.warning = LEASE_WARNING;
  const skip = (detail: string) => { item.detail = detail; return { item, settings: null }; };
  if (config.crossex !== undefined) return skip('已在本项目配置中，保留现有设置');
  if (source.problem !== null || !source.credentials || source.accountUid === null || source.credentialVersion === null || source.limits === null) return skip(source.problem ?? '未能判断');
  if (secrets.gate !== undefined) return skip('现有密钥文件里已有 gate 但 config.json 没有 crossex，不覆盖；请先确认并移走它');
  const crossex = { accountUid: source.accountUid, credentialVersion: source.credentialVersion, limits: { ...source.limits } };
  const key = { apiKey: source.credentials.apiKey, apiSecret: source.credentials.apiSecret };
  try {
    fits({ ...config, crossex });
    parseCrossexSecrets({ gate: key });
    parseCrossexConfig(crossex);
  } catch (error) {
    // Messages built by these checks never carry a key (crossex-config.ts).
    return skip(`加入后本服务不接受（${reason(error)}）`);
  }
  config.crossex = crossex;
  secrets.gate = key;
  item.status = 'added';
  item.detail = `Gate 账户 ${item.accountId}（单腿上限 ${crossex.limits.notionalPerLeg} USDT，最多 ${crossex.limits.maxOpen} 组，总额上限 ${crossex.limits.maxTotalNotional} USDT，沿用工作台设置）`;
  if (source.settings === null) notes.push('工作台 CrossEx 的页面设置未通过检查，未复制；本服务按默认值，请到 CrossEx 设置页核对');
  if (source.leaseActive) notes.push(`工作台 CrossEx 仍在运行这个账户：${LEASE_WARNING}，避免两边同时交易`);
  return { item, settings: source.settings };
}

const WRITER = join(dirname(import.meta.filename), '..', 'crossex', 'import-writer.ts');
const WRITE_TIMEOUT_MS = 60_000;

/**
 * Copies the page settings into this service's crossex.sqlite, as the data directory's owner (root never opens a
 * database there), only when it has none yet. Returns whether they were written; throws why not.
 */
export function writeCrossexSettingsAsService(dataDir: string, settings: Json): boolean {
  if (!isAbsolute(dataDir)) throw new Error(`本服务数据目录须为绝对路径：${dataDir}`);
  const identity = readerIdentity(statSync(dataDir), process.getuid?.());
  const run = spawnSync(process.execPath, [WRITER, 'seed', '--data-dir', dataDir], {
    cwd: '/', env: {}, encoding: 'utf8', timeout: WRITE_TIMEOUT_MS, maxBuffer: 1024 * 1024, input: JSON.stringify(settings), ...identity,
  });
  const as = 'uid' in identity ? `（以数据目录属主 uid ${identity.uid} 运行）` : '';
  if (run.error || run.status !== 0) throw new Error(`写入 CrossEx 页面设置失败${as}：${printable(run.error?.message ?? (run.stderr.trim() || `退出码 ${run.status ?? run.signal}`)).slice(0, 300)}`);
  let answer: unknown;
  try { answer = JSON.parse(run.stdout); } catch { throw new Error(`写入 CrossEx 页面设置失败${as}：输出无法解析`); }
  if (!isRecord(answer) || typeof answer.seeded !== 'boolean') throw new Error(`写入 CrossEx 页面设置失败${as}：输出格式错误`);
  return answer.seeded;
}
