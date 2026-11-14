// M-3d-2: the workbench's Variational session token (docs/monitor.md M-3d-2, docs/module-import.md §3).
// <workbench data>/modules/monitor/variational-session.json is read by a child running as the owner of that directory with
// no environment, under the workbench's own rules (a plain file of at most 16 KiB with mode 600); the token is checked here
// for format and expiry only (no request to Variational). This service's file is looked at, and written, by
// src/monitor/variational-import-writer.ts run as the data directory's owner; the token goes to it over stdin. Only
// expiries, revisions and reasons leave this file as text, never the token.
import { lstatSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join } from 'node:path';
import { VARIATIONAL_EXPIRY_MARGIN_MS, variationalTokenExpiry } from '../vendor/variational-market.mjs';
import { VARIATIONAL_SESSION_MAX_BYTES } from '../monitor/variational-session.ts';
import { decideVariationalImport, type ServiceVariational } from '../monitor/variational-import-writer.ts';
import { readerIdentity } from './import-workbench.ts';

type Json = Record<string, unknown>;
const reason = (error: unknown): string => error instanceof Error ? error.message : String(error);
const printable = (text: string): string => text.replace(/[\p{Cc}\p{Cf}]/gu, '');
const WRITER = join(dirname(import.meta.filename), '..', 'monitor', 'variational-import-writer.ts');
const TIMEOUT_MS = 30_000;
const FILE = 'variational-session.json';

/** The workbench's token (kept in memory, never shown) and its declared expiry, or why there is none. */
export type MonitorVariationalSource = { token: string; expiresAt: string } | { token: null; problem: string };
/** What the page and the terminal show; no token. */
export interface MonitorVariationalItem {
  status: 'added' | 'skipped';
  /** The workbench token's declared expiry (null when it cannot come over: see `problem`). */
  workbenchExpiresAt: string | null;
  problem: string | null;
  /** This service's token before the import (null when it could not be looked at: see `detail`). */
  current: ServiceVariational | null;
  replaces: boolean;
  detail: string;
}

// Run as the owner of the monitor directory: a plain file (not followed when a link) of at most 16 KiB with mode 600.
const DUMP_TOKEN = `import { lstatSync, readFileSync } from 'node:fs';
const [path] = process.argv.slice(1);
let stat, out;
try { stat = lstatSync(path); } catch (error) { stat = null; out = error && error.code === 'ENOENT' ? { missing: true } : { refused: 'unreadable' }; }
if (stat) {
  if (!stat.isFile()) out = { refused: 'not_file' };
  else if (stat.size > ${VARIATIONAL_SESSION_MAX_BYTES}) out = { refused: 'large' };
  else if ((stat.mode & 0o777) !== 0o600) out = { refused: 'mode' };
  else { try { out = { text: readFileSync(path, 'utf8') }; } catch { out = { refused: 'unreadable' }; } }
}
process.stdout.write(JSON.stringify(out));`;

const REFUSED: Record<string, string> = { not_file: '不是普通文件（符号链接等），不读取', large: '超过 16 KiB，不是工作台的文件', mode: '权限不是 600，工作台自己也不会读它，不导入', unreadable: '读不出' };

/** Reads the workbench's token; throws when the monitor directory cannot be read at all. */
export function readWorkbenchVariational(data: string, now = Date.now()): MonitorVariationalSource {
  if (!isAbsolute(data)) throw new Error(`工作台数据目录须为绝对路径：${data}`);
  const dir = join(data, 'modules', 'monitor');
  let stat;
  try { stat = lstatSync(dir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { token: null, problem: '工作台没有 Monitor 模块' };
    throw new Error(`工作台的 Monitor 模块数据目录 ${dir} 读不出：${reason(error)}`);
  }
  if (!stat.isDirectory()) throw new Error(`${dir} 不是目录（符号链接等），不读取`);
  if (process.getuid?.() === 0 && stat.uid === 0 && statSync(dirname(dir)).uid !== 0) throw new Error(`${dir} 归 root，但所在目录归其他账户，不读取；请确认来源`);
  const identity = readerIdentity(stat, process.getuid?.());
  const read = spawnSync(process.execPath, ['--input-type=module', '-e', DUMP_TOKEN, '--', join(dir, FILE)], {
    cwd: '/', env: {}, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 4 * VARIATIONAL_SESSION_MAX_BYTES, ...identity,
  });
  const as = 'uid' in identity ? `（以目录属主 uid ${identity.uid} 读取，不带附加组）` : '';
  if (read.error || read.status !== 0) throw new Error(`读取工作台 Var token ${join(dir, FILE)} 失败${as}：${printable(read.error?.message ?? (read.stderr.trim() || `退出码 ${read.status ?? read.signal}`)).slice(0, 200)}`);
  let dumped: { missing?: true; refused?: string; text?: string };
  try { dumped = JSON.parse(read.stdout) as typeof dumped; } catch { throw new Error(`读取工作台 Var token 失败${as}：输出无法解析`); }
  if (dumped?.missing) return { token: null, problem: '工作台没有保存 Var token' };
  if (typeof dumped?.text !== 'string') return { token: null, problem: `${FILE} ${REFUSED[String(dumped?.refused)] ?? REFUSED.unreadable}` };
  // Neither the parser's message nor the expiry parser's is passed on: they may quote the file.
  let saved: { version?: unknown; token?: unknown };
  try { saved = JSON.parse(dumped.text) as typeof saved; } catch { return { token: null, problem: `${FILE} 不是有效的 JSON` }; }
  if (!saved || typeof saved !== 'object' || saved.version !== 1 || typeof saved.token !== 'string') return { token: null, problem: `${FILE} 格式不符（须为工作台写入的 version 1）` };
  if (!saved.token) return { token: null, problem: '工作台没有保存 Var token' };
  let expiry: number;
  try { expiry = variationalTokenExpiry(saved.token); } catch { return { token: null, problem: '工作台的 Var token 格式无效（读不出到期时间）' }; }
  if (expiry <= now + VARIATIONAL_EXPIRY_MARGIN_MS) return { token: null, problem: `工作台的 Var token 已于 ${new Date(expiry).toISOString()} 过期（或 30 秒内到期），不导入` };
  return { token: saved.token, expiresAt: new Date(expiry).toISOString() };
}

/** Runs the writer as the data directory's owner; `input` goes over stdin. */
function runWriter(dataDir: string, command: 'inspect' | 'write', input?: string): unknown {
  if (!isAbsolute(dataDir)) throw new Error(`本服务数据目录须为绝对路径：${dataDir}`);
  const identity = readerIdentity(statSync(dataDir), process.getuid?.());
  const run = spawnSync(process.execPath, [WRITER, command, '--data-dir', dataDir], {
    cwd: '/', env: {}, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 64 * 1024, ...(input === undefined ? { stdio: ['ignore', 'pipe', 'pipe'] } : { input }), ...identity,
  });
  const as = 'uid' in identity ? `（以数据目录属主 uid ${identity.uid} 运行）` : '';
  const what = command === 'write' ? '写入 Var token 失败，原有 token 未改动' : '读取本服务的 Var token 状态失败';
  // The writer reports an error before it renames; killed (timeout) or with output that cannot be read, it may have written.
  const unknown = command === 'write' ? 'Var token 写入结果不明（可能已写入），请在行情监控页查看 Var token 的版本与到期' : what;
  if (run.error || run.status !== 0) throw new Error(`${run.error || run.signal ? unknown : what}：${printable(run.error?.message ?? (run.stderr.trim() || `退出码 ${run.status ?? run.signal}`)).slice(0, 300)}${as}`);
  try { return JSON.parse(run.stdout) as unknown; } catch { throw new Error(`${unknown}：输出无法解析${as}`); }
}

/** This service's token as it is now (no token in the answer). */
export function inspectVariationalAsService(dataDir: string): ServiceVariational {
  const answer = runWriter(dataDir, 'inspect') as Partial<ServiceVariational> | null;
  if (!answer || typeof answer.configured !== 'boolean' || !Number.isSafeInteger(answer.revision)) throw new Error('读取本服务的 Var token 状态失败：输出格式错误');
  return { configured: answer.configured, expiresAt: typeof answer.expiresAt === 'string' ? answer.expiresAt : null, revision: answer.revision as number, problem: typeof answer.problem === 'string' ? answer.problem : null };
}

export interface VariationalWriteResult { written: boolean; replaces: boolean; reason: string | null; revision: number; expiresAt: string }
/** Writes the workbench's token when the writer, looking at the file as it is then, lets it replace this service's. */
export function writeVariationalAsService(dataDir: string, token: string): VariationalWriteResult {
  const answer = runWriter(dataDir, 'write', JSON.stringify({ token })) as Partial<VariationalWriteResult> | null;
  if (!answer || typeof answer.written !== 'boolean' || !Number.isSafeInteger(answer.revision) || typeof answer.expiresAt !== 'string') throw new Error('写入 Var token 后输出格式错误');
  return { written: answer.written, replaces: answer.replaces === true, reason: typeof answer.reason === 'string' ? answer.reason : null, revision: answer.revision as number, expiresAt: answer.expiresAt };
}

/**
 * Whether the token comes over: only to a config whose monitor runs the oil market (the Var row and its session live
 * there), and by the replacement rule against `current` (null when it could not be looked at: the writer decides then).
 */
export function planMonitorVariational(source: MonitorVariationalSource, current: ServiceVariational | null, currentError: string | null, config: Json): { item: MonitorVariationalItem; write: { token: string } | null } {
  const item: MonitorVariationalItem = { status: 'skipped', workbenchExpiresAt: source.token === null ? null : source.expiresAt, problem: source.token === null ? source.problem : null, current, replaces: false, detail: '' };
  const monitor = config.monitor;
  if (!monitor || typeof monitor !== 'object') { item.detail = '行情监控未启用，Var token 不导入'; return { item, write: null }; }
  if ((monitor as Json).oil === undefined) { item.detail = '本服务的行情监控没有原油价差，Var token 不导入'; return { item, write: null }; }
  if (source.token === null) { item.detail = source.problem; return { item, write: null }; }
  if (current) {
    // The token itself is not compared here (only the writer sees both); an equal expiry is nearly always the same token.
    const decision = decideVariationalImport(current, { token: '', expiry: Date.parse(source.expiresAt) });
    if (!decision.write) { item.detail = current.expiresAt === source.expiresAt ? `本服务的 Var token 声明到期与工作台的相同（${source.expiresAt}，多半是同一个 token），保留本服务的` : decision.reason; return { item, write: null }; }
    item.replaces = decision.replaces;
  }
  item.status = 'added';
  item.detail = `导入工作台的 Var token（声明到期 ${source.expiresAt}）${item.replaces ? '，替换本服务现有的' : ''}${currentError ? `；本服务现有状态读不出（${currentError}），写入时再判断` : ''}`;
  return { item, write: { token: source.token } };
}

/** One line for the result and the log. */
export const variationalLine = (result: VariationalWriteResult): string => result.written ? `Var token（版本 ${result.revision}，声明到期 ${result.expiresAt}）` : '';
