// M-5e2: the workbench's perpetual paper-position records (docs/monitor.md M-5e2, docs/module-import.md §3).
// <workbench data>/modules/monitor/perpetual/paper-positions.json is read by a child running as the owner of the monitor
// directory with no environment, under the workbench's own limit (a plain file of at most 1 MB; not a secret, any mode), and
// must pass the workbench's validatePerpetualPaperState. This service's side is looked at, and the pending file written, by
// src/monitor/perpetual-paper-import-writer.ts run as the data directory's owner; the state goes to it over stdin. Only
// counts and reasons leave this file as text.
import { statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join } from 'node:path';
import { PERPETUAL_PAPER_LIMITS, type PerpetualPaperState } from '../vendor/perpetual-paper.ts';
import { validatePerpetualPaperState } from '../vendor/perpetual-paper-store.mjs';
import { planPerpetualPaperImport } from '../monitor/perpetual-paper-store.ts';
import type { PaperWriteResult, ServicePaper } from '../monitor/perpetual-paper-import-writer.ts';
import { sourceEntry, sourceText, workbenchIdentity } from './workbench-source.ts';
import { readerIdentity } from './import-workbench.ts';

type Json = Record<string, unknown>;
const reason = (error: unknown): string => error instanceof Error ? error.message : String(error);
const printable = (text: string): string => text.replace(/[\p{Cc}\p{Cf}]/gu, '');
const WRITER = join(dirname(import.meta.filename), '..', 'monitor', 'perpetual-paper-import-writer.ts');
const TIMEOUT_MS = 30_000;
const FILE = 'perpetual/paper-positions.json';

/** The workbench's records (kept in the helper), or why there are none to bring. */
export type MonitorPaperSource = { state: PerpetualPaperState } | { state: null; problem: string };
/** What the page and the terminal show: counts and reasons only. */
export interface MonitorPaperItem {
  status: 'added' | 'skipped';
  /** The workbench's active / ended records (null when they cannot come over: see `problem`). */
  workbench: { active: number; closed: number } | null;
  problem: string | null;
  /** This service's records with its pending ones before the import (null when they could not be looked at). */
  current: { active: number; closed: number; pending: number } | null;
  /** The new records that come over (or came over). */
  added: number;
  detail: string;
}

// Run as the workbench account: perpetual/ a directory and the file a plain one (neither followed when a link),
// the file at most the workbench's 1 MB.
const REFUSED: Record<string, string> = { not_dir: 'perpetual 不是目录（符号链接等），不读取', not_file: `${FILE} 不是普通文件（符号链接等），不读取`, large: `${FILE} 超过 1 MB（工作台自己的上限），不读取`, unreadable: `${FILE} 读不出` };

/** Reads the workbench's records; throws when the monitor directory cannot be read at all. */
export function readWorkbenchPaper(data: string): MonitorPaperSource {
  if (!isAbsolute(data)) throw new Error(`工作台数据目录须为绝对路径：${data}`);
  const dir = join(data, 'modules', 'monitor');
  const stat = sourceEntry(data, dir);
  if (!stat) return { state: null, problem: '工作台没有 Monitor 模块' };
  if (!stat.isDirectory()) throw new Error(`${dir} 不是目录（符号链接等），不读取`);
  workbenchIdentity(data, dir);
  const dumped = sourceText(data, join(dir, FILE), PERPETUAL_PAPER_LIMITS.fileBytes);
  if ('missing' in dumped) return { state: null, problem: '工作台没有持仓记录' };
  if ('refused' in dumped) return { state: null, problem: REFUSED[dumped.refused] ?? REFUSED.unreadable! };
  // Neither the parser's message nor the validator's is passed on: they may quote the file.
  let parsed: unknown;
  try { parsed = JSON.parse(dumped.text); } catch { return { state: null, problem: `${FILE} 不是有效的 JSON` }; }
  try { return { state: validatePerpetualPaperState(parsed) }; } catch { return { state: null, problem: `${FILE} 未通过工作台的持仓记录校验，不导入` }; }
}

/** Runs the writer as the data directory's owner; `input` goes over stdin. */
function runWriter(dataDir: string, command: 'inspect' | 'write', input?: string): unknown {
  if (!isAbsolute(dataDir)) throw new Error(`本服务数据目录须为绝对路径：${dataDir}`);
  const identity = readerIdentity(statSync(dataDir), process.getuid?.());
  const run = spawnSync(process.execPath, [WRITER, command, '--data-dir', dataDir], {
    cwd: '/', env: {}, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 256 * 1024, ...(input === undefined ? { stdio: ['ignore', 'pipe', 'pipe'] } : { input }), ...identity,
  });
  const as = 'uid' in identity ? `（以数据目录属主 uid ${identity.uid} 运行）` : '';
  const what = command === 'write' ? '写入待载入的持仓记录失败，本服务的持仓记录未改动' : '读取本服务的持仓记录失败';
  // The writer reports an error before it renames; killed (timeout) or with output that cannot be read, it may have written.
  const unknown = command === 'write' ? '持仓记录写入结果不明（可能已写入待载入文件），请在行情监控页的持仓记录中核对' : what;
  if (run.error || run.status !== 0) throw new Error(`${run.error || run.signal ? unknown : what}：${printable(run.error?.message ?? (run.stderr.trim() || `退出码 ${run.status ?? run.signal}`)).slice(0, 300)}${as}`);
  try { return JSON.parse(run.stdout) as unknown; } catch { throw new Error(`${unknown}：输出无法解析${as}`); }
}

const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** This service's records and pending ones: counts and ids. */
export function inspectPaperAsService(dataDir: string): ServicePaper {
  const answer = runWriter(dataDir, 'inspect') as Partial<ServicePaper> | null;
  if (!answer || !count(answer.active) || !count(answer.closed) || !count(answer.pending) || !Array.isArray(answer.ids) || !answer.ids.every(id => typeof id === 'string')) throw new Error('读取本服务的持仓记录失败：输出格式错误');
  return { active: answer.active, closed: answer.closed, pending: answer.pending, ids: answer.ids };
}

/** Hands the workbench's state to the writer, which plans it again against the files as they are then. */
export function writePaperAsService(dataDir: string, state: PerpetualPaperState): PaperWriteResult {
  const answer = runWriter(dataDir, 'write', JSON.stringify(state)) as Partial<PaperWriteResult> | null;
  if (!answer || typeof answer.written !== 'boolean' || ![answer.added, answer.pending, answer.skipped, answer.expired, answer.stripped, answer.active, answer.closed].every(count)) throw new Error('写入持仓记录后输出格式错误');
  return answer as PaperWriteResult;
}

/** The workbench's records with this service's side, or why that could not be looked at. */
export interface PaperInput { source: MonitorPaperSource; current: ServicePaper | null; currentError: string | null }
export function paperInput(source: MonitorPaperSource, dataDir: string, inspect: (dir: string) => ServicePaper = inspectPaperAsService): PaperInput {
  if (source.state === null) return { source, current: null, currentError: null };
  try { return { source, current: inspect(dataDir), currentError: null }; }
  catch (error) { return { source, current: null, currentError: reason(error) }; }
}

const describe = (added: number, active: number, skipped: number, expired: number): string =>
  `导入 ${added} 条持仓记录（活动 ${active} 条、已结束 ${added - active} 条）${skipped ? `，${skipped} 条本服务已有` : ''}${expired ? `，${expired} 条已结束超过 30 天不导入` : ''}`;

/**
 * Whether the records come over: only to a config whose monitor runs the perpetual collector (after the monitor's own
 * plan, which may add it), and by the import rule against `current` (null when it could not be looked at: the writer
 * decides then).
 */
export function planMonitorPaper(input: PaperInput, config: Json, now = Date.now()): { item: MonitorPaperItem; write: { state: PerpetualPaperState } | null } {
  const { source, current, currentError } = input;
  const workbench = source.state ? { active: source.state.positions.filter(position => position.status === 'active').length, closed: source.state.positions.filter(position => position.status !== 'active').length } : null;
  const item: MonitorPaperItem = { status: 'skipped', workbench, problem: source.state === null ? source.problem : null, current: current ? { active: current.active, closed: current.closed, pending: current.pending } : null, added: 0, detail: '' };
  const monitor = config.monitor;
  if (!monitor || typeof monitor !== 'object') { item.detail = '行情监控未启用，持仓记录不导入'; return { item, write: null }; }
  if ((monitor as Json).perpetual === undefined) { item.detail = '本服务的行情监控没有合约价差，持仓记录不导入'; return { item, write: null }; }
  if (source.state === null) { item.detail = source.problem; return { item, write: null }; }
  const plan = planPerpetualPaperImport(current ? { ids: new Set(current.ids), active: current.active, closed: current.closed } : { ids: new Set(), active: 0, closed: 0 }, source.state.positions, now);
  if (plan.status !== 'add') { item.detail = plan.reason; return { item, write: null }; }
  item.status = 'added';
  item.added = plan.add.length;
  item.detail = `${describe(plan.add.length, plan.add.filter(position => position.status === 'active').length, plan.skipped, plan.expired)}${currentError ? `；本服务现有记录读不出（${currentError}），写入时再判断` : ''}`;
  return { item, write: { state: source.state } };
}

/** One line for the result and the log. */
export const paperLine = (result: PaperWriteResult): string => result.written ? `持仓记录 ${result.added} 条` : '';
/** The item's detail after the writer has written (it may differ from the plan: the files may have changed since). */
export const paperWrittenDetail = (result: PaperWriteResult): string =>
  `导入 ${result.added} 条持仓记录${result.skipped ? `，${result.skipped} 条本服务已有` : ''}${result.expired ? `，${result.expired} 条已结束超过 30 天不导入` : ''}${result.stripped ? `，其中 ${result.stripped} 条的登记请求编号与本服务已有的重复，已去掉` : ''}；写入待载入文件，等本服务载入（运行中下一次检查，或服务启动时）`;
