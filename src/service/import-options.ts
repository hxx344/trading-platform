// The options part of the workbench import (docs/options.md §3): the workbench Greeks module's Bybit key and risk
// settings come over into config.json `options` and secrets.json `bybitOptions`. It reads the module's environment
// (/etc/project-aggregation.env, then <data>/modules/greeks/.env, which wins; names are not case sensitive, as in the
// module's settings) and its engine_state.json, and refuses while the workbench could still trade options on that key:
// automatic opening on, not live mainnet, an order, task or RFQ not finished, a strategy still tracked, or a state file
// it cannot read. The checks follow the workbench's own hand-off check (server/recovery/admission.mjs inspectGreeks).
// The workbench keeps running after the import, so automatic opening is also checked in the running module's own
// environment (/proc/<pid>/environ, read as root): an edited .env takes effect only when the module restarts.
// The account UID is read once with the key (query-api, the same read as the service's start check). Only the masked
// UID, settings and reasons leave this file; the key never does.
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { parseEnv } from 'node:util';
import { validCredentials, type LiveCredentials } from '../live/values.ts';
import type { FetchLike } from '../live/http.ts';
import { createOptionsClient } from '../options/client.ts';
import { parseOptionsConfig, parseOptionsSecrets } from './options-config.ts';
import { readOptionsAccount } from './options.ts';

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);
const reason = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** The workbench's options key and settings, or why they cannot come over; accountId is filled by resolveOptionsAccount. */
export interface OptionsSource {
  stateFile: string;
  credentials: LiveCredentials | null;
  /** config.json `options` without accountId. */
  settings: Json;
  problem: string | null;
  accountId: string | null;
  /** Workbench settings this service does not take, set to something other than what it uses ("NAME=value"). */
  ignored?: string[];
}
/** What the plan did with the options account; the UID is masked. */
export interface OptionsItem { accountId: string | null; status: 'added' | 'skipped'; detail: string }

/** The workbench's defaults where ours differ (config.py); the rest of our defaults are the workbench's. */
const WORKBENCH_MAX_USD = 2500;
const TASK_FINAL = new Set(['completed', 'partial', 'stopped', 'failed']);
const ORDER_FINAL = new Set(['filled', 'partial', 'timeout_cancelled', 'not_submitted']);
const RFQ_FINAL = new Set(['Canceled', 'Expired', 'Filled', 'Failed']);
const STATE_KEYS = new Set(['schema_version', 'exchange_network', 'last_open_week', 'active_strategy_symbols', 'active_strategy_sizes',
  'active_strategy_group_id', 'rfq_state', 'execution_groups', 'execution_group_links', 'pm_baseline', 'order_journal',
  'performance_executions', 'performance_start_ms', 'performance_cursor_ms', 'performance_samples']);
/** pydantic's boolean words. */
const TRUE = new Set(['1', 'true', 't', 'yes', 'y', 'on']), FALSE = new Set(['0', 'false', 'f', 'no', 'n', 'off']);
const MAX_STATE_BYTES = 64 * 1024 * 1024;
/**
 * Workbench settings with no counterpart in config.json `options`, and the value this service works with
 * (DEFAULT_ESTIMATES and the engine's constants). One changed in the workbench is named in the import notes.
 */
const FIXED_SETTINGS: Record<string, number | boolean> = {
  option_mm_factor: 0.03, option_max_im_factor: 0.10, option_min_im_factor: 0.05, option_liquidation_fee_rate: 0.002,
  option_fee_cap_pct: 0.07, quote_stale_seconds: 30, max_spread_bps: 0, target_dte_days: 2, bbo_poll_seconds: 1,
};
const own = (value: Json, key: string): boolean => Object.hasOwn(value, key);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

function flag(env: Record<string, string>, name: string, fallback: boolean): boolean {
  const value = env[name];
  if (value === undefined) return fallback;
  const word = value.trim().toLowerCase();
  if (TRUE.has(word)) return true;
  if (FALSE.has(word)) return false;
  throw new Error(`工作台期权模块的 ${name.toUpperCase()} 不是可识别的开关值`);
}
function number(env: Record<string, string>, name: string): number | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  const parsed = Number(value.trim());
  if (value.trim() === '' || !Number.isFinite(parsed)) throw new Error(`工作台期权模块的 ${name.toUpperCase()} 不是数字`);
  return parsed;
}

/**
 * Why the workbench could still trade options with this state, or null. Throws when the state is not one the workbench
 * writes (then nothing can be judged).
 */
export function workbenchStateProblem(state: unknown): string | null {
  const shape = isRecord(state) && Object.keys(state).every(key => STATE_KEYS.has(key)) && state.schema_version === 1
    && (state.exchange_network === 'mainnet' || state.exchange_network === 'testnet') && Array.isArray(state.active_strategy_symbols)
    && isRecord(state.active_strategy_sizes) && isRecord(state.order_journal) && isRecord(state.rfq_state)
    && isRecord(state.execution_groups) && isRecord(state.execution_group_links);
  if (!shape) throw new Error('工作台期权状态文件格式无法识别');
  return stateProblem(state as { exchange_network: string; active_strategy_symbols: unknown[]; order_journal: Json; rfq_state: Json; execution_groups: Json });
}
function stateProblem(state: { exchange_network: string; active_strategy_symbols: unknown[]; order_journal: Json; rfq_state: Json; execution_groups: Json }): string | null {
  if (state.exchange_network !== 'mainnet') return '工作台期权状态记录的是测试网，不是实盘主网';
  let orders = 0, tasks = 0;
  for (const entry of Object.values(state.order_journal)) {
    if (!isRecord(entry) || typeof entry.terminal !== 'boolean' || !text(entry.status)) throw new Error('工作台期权状态里有无法解析的订单记录');
    if (!entry.terminal || !ORDER_FINAL.has(entry.status)) orders++;
  }
  for (const group of Object.values(state.execution_groups)) {
    if (!isRecord(group)) throw new Error('工作台期权状态里有无法解析的执行记录');
    if (own(group, 'task_version')) {
      if (group.task_version !== 1 || typeof group.live !== 'boolean' || !text(group.execution_status)) throw new Error('工作台期权状态里有无法解析的执行任务');
      if (group.live && !TASK_FINAL.has(group.execution_status)) tasks++;
    } else if (own(group, 'execution_status')) throw new Error('工作台期权状态里有版本未知的执行任务');
  }
  if (orders) return `工作台期权还有 ${orders} 笔订单未结束；先在工作台「组合执行」里让它们成交或撤单`;
  if (tasks) return `工作台期权还有 ${tasks} 个执行任务未结束；先在工作台等它完成或停止`;
  const rfq = state.rfq_state;
  if (Object.keys(rfq).length) {
    if (!text(rfq.status)) throw new Error('工作台期权状态里的 RFQ 记录无法解析');
    if (!RFQ_FINAL.has(rfq.status) || (rfq.status === 'Filled' && rfq.tracking_applied !== true) || (rfq.selected_quote_id && rfq.execution_resolved !== true)) return '工作台期权还有未完成的 RFQ；先在工作台处理完';
  }
  if (state.active_strategy_symbols.length) return `工作台期权还在跟踪一组策略（${state.active_strategy_symbols.length} 腿）；先在工作台平仓，或确认交易所上已无这组持仓后清除跟踪`;
  return null;
}

/**
 * The workbench's options key and settings from its environment (names lower-cased, the module file winning) and its
 * state text (null when the file is not there). Pure: the tests drive it directly.
 */
export function optionsCandidate(environment: Record<string, string>, stateText: string | null, stateFile = 'engine_state.json'): OptionsSource {
  const env = Object.fromEntries(Object.entries(environment).map(([key, value]) => [key.toLowerCase(), value]));
  const source: OptionsSource = { stateFile, credentials: null, settings: {}, problem: null, accountId: null };
  try {
    const credentials = { apiKey: env.bybit_api_key ?? '', apiSecret: env.bybit_api_secret ?? '' } as LiveCredentials;
    if (!credentials.apiKey && !credentials.apiSecret) throw new Error('工作台期权模块没有配置 Bybit 密钥（BYBIT_API_KEY / BYBIT_API_SECRET）');
    if (!validCredentials(credentials)) throw new Error('工作台期权模块的 Bybit 密钥不完整或格式无效');
    // The workbench's rule for automatic opening (admission.mjs): anything but an explicit off word counts as on.
    const auto = env.auto_open;
    if (auto !== undefined && !['0', 'false', 'off', 'no'].includes(auto.trim().toLowerCase())) throw new Error('工作台期权模块开着自动开仓（AUTO_OPEN）；先在工作台关闭并重启该模块');
    const mode = env.trading_mode?.trim();
    if (mode !== undefined && mode !== '' && !['dry-run', 'testnet', 'live'].includes(mode)) throw new Error('工作台期权模块的 TRADING_MODE 无法识别');
    const environmentName = mode ? mode : flag(env, 'live_trading', false) && !flag(env, 'bybit_testnet', true) ? 'live' : 'dry-run';
    if (environmentName !== 'live') throw new Error(`工作台期权模块不是实盘主网（当前 ${environmentName === 'testnet' ? '测试网' : '模拟'}），它的密钥不导入`);
    const settings: Json = { limits: { maxRiskUsd: number(env, 'max_risk_usd') ?? WORKBENCH_MAX_USD, maxMarginUsd: number(env, 'max_margin_usd') ?? WORKBENCH_MAX_USD } };
    if (env.leg_qty !== undefined) settings.legQty = String(number(env, 'leg_qty'));
    if (env.strategy_mode !== undefined) settings.strategyMode = env.strategy_mode.trim();
    if (env.margin_mode !== undefined) settings.marginMode = env.margin_mode.trim();
    const timeout = number(env, 'bbo_order_timeout_seconds'), fee = number(env, 'estimated_taker_fee_rate'), buffer = number(env, 'portfolio_margin_buffer_pct');
    if (timeout !== undefined) settings.orderTimeoutSeconds = timeout;
    if (fee !== undefined) settings.feeRate = fee;
    if (buffer !== undefined) settings.marginBufferPct = buffer;
    // The opening time comes over; the switch does not (AUTO_OPEN is off by the time an import is allowed).
    const hour = number(env, 'open_hour_utc'), minute = number(env, 'open_minute_utc'), window = number(env, 'open_window_seconds');
    if (hour !== undefined) settings.openHourUtc = hour;
    if (minute !== undefined) settings.openMinuteUtc = minute;
    if (window !== undefined) settings.openWindowSeconds = window;
    if (flag(env, 'allow_market_fallback', false)) settings.marketFallback = true;
    const ignored = Object.entries(FIXED_SETTINGS).filter(([name, ours]) => {
      const value = env[name];
      if (value === undefined) return false;
      if (typeof ours === 'boolean') return !(ours ? TRUE : FALSE).has(value.trim().toLowerCase());
      return Number(value.trim()) !== ours;
    }).map(([name]) => `${name.toUpperCase()}=${env[name]!.trim()}`);
    // Our own checks with a placeholder UID: a setting this service does not take shows here, before any request.
    try { parseOptionsConfig({ accountId: '1', ...settings }); } catch (error) { throw new Error(`工作台期权参数本服务不接受：${reason(error)}`); }
    if (stateText === null) throw new Error('没有找到工作台期权状态文件，无法确认没有未结束的订单；请先在工作台打开一次期权模块');
    let state: unknown;
    try { state = JSON.parse(stateText); } catch { throw new Error('工作台期权状态文件不是有效 JSON'); }
    const problem = workbenchStateProblem(state);
    if (problem) throw new Error(problem);
    source.credentials = credentials;
    source.settings = settings;
    if (ignored.length) source.ignored = ignored;
  } catch (error) { source.problem = reason(error); }
  return source;
}

/** Opened without following a final symbolic link (and without blocking on a FIFO); the checks are on the open file. */
function readPlain(path: string, name: string, limit: number): string | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP') throw new Error(`工作台的${name} ${path} 是符号链接，不读取`);
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`工作台的${name} ${path} 不是普通文件，不读取`);
    if (process.getuid?.() === 0 && stat.uid === 0 && statSync(dirname(path)).uid !== 0) throw new Error(`${path} 归 root，但所在目录归其他账户，不读取；请确认文件来源`);
    if (stat.size > limit) throw new Error(`工作台的${name} ${path} 超过 ${limit} 字节，不读取`);
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    for (let read; length <= limit && (read = readSync(fd, buffer, length, limit + 1 - length, null)) > 0;) length += read;
    if (length > limit) throw new Error(`工作台的${name} ${path} 超过 ${limit} 字节，不读取`);
    return buffer.subarray(0, length).toString('utf8');
  } finally { closeSync(fd); }
}

const OFF_WORDS = ['0', 'false', 'off', 'no'];
const samePath = (a: string, b: string): boolean => {
  const real = (path: string): string => { try { return realpathSync(path); } catch { return path; } };
  return a === b || real(a) === real(b);
};
/**
 * Why a running workbench Greeks module could still open on its own, or null. The module runs as `python -u <bridge>
 * app.main:app …` (server/modules/python-module.mjs) with STATE_FILE set to its engine_state.json; its settings come only
 * from that environment (config.py: WORKSPACE_MANAGED=1 reads no .env). A candidate whose environment cannot be read
 * (not run as root) is refused rather than guessed.
 */
export function runningGreeksProblem(stateFile: string, procDir = '/proc'): string | null {
  let pids: string[];
  try { pids = readdirSync(procDir).filter(name => /^\d+$/.test(name)); } catch { return '无法列出本机进程，不能确认运行中的工作台期权模块已关闭自动开仓'; }
  for (const pid of pids) {
    let args: string[], environ: string;
    try { args = readFileSync(join(procDir, pid, 'cmdline'), 'utf8').split('\0'); } catch { continue; }
    if (!args.includes('app.main:app')) continue;
    try { environ = readFileSync(join(procDir, pid, 'environ'), 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH') continue;
      return `读不到进程 ${pid}（可能是工作台期权模块）的运行环境，不能确认自动开仓已关闭；请以 root 运行导入`;
    }
    const env = new Map(environ.split('\0').filter(item => item.includes('=')).map(item => [item.slice(0, item.indexOf('=')).toLowerCase(), item.slice(item.indexOf('=') + 1)]));
    const file = env.get('state_file');
    if (file === undefined || !samePath(file, stateFile)) continue;
    const auto = env.get('auto_open');
    if (auto !== undefined && !OFF_WORDS.includes(auto.trim().toLowerCase())) return `运行中的工作台期权模块（进程 ${pid}）仍开着自动开仓：改完环境文件后须在工作台重启该模块再导入`;
  }
  return null;
}

/** Reads the workbench Greeks module's environment and state, and checks the running module; nothing is written. */
export function readWorkbenchOptions(envFile: string, data: string, procDir = '/proc'): OptionsSource {
  if (!isAbsolute(data)) throw new Error(`工作台数据目录须为绝对路径：${data}`);
  const base = readPlain(envFile, '环境文件', 1024 * 1024), moduleText = readPlain(join(data, 'modules', 'greeks', '.env'), '期权模块环境文件', 1024 * 1024);
  const stateFile = join(data, 'modules', 'greeks', 'engine_state.json');
  const source = optionsCandidate({ ...(base === null ? {} : parseEnv(base)), ...(moduleText === null ? {} : parseEnv(moduleText)) } as Record<string, string>, readPlain(stateFile, '期权状态文件', MAX_STATE_BYTES), stateFile);
  if (source.problem !== null) return source;
  const running = runningGreeksProblem(stateFile, procDir);
  return running === null ? source : { ...source, credentials: null, settings: {}, problem: running };
}

/** Reads the key's account UID (and its permissions, IP binding and account kind) once; a failure becomes the problem. */
export async function resolveOptionsAccount(source: OptionsSource, { fetchImpl, host, timeoutMs = 15_000 }: { fetchImpl?: FetchLike; host?: string; timeoutMs?: number } = {}): Promise<OptionsSource> {
  if (source.problem !== null || !source.credentials) return source;
  try {
    const client = createOptionsClient({ credentials: source.credentials, ...(fetchImpl ? { fetchImpl } : {}), ...(host ? { host } : {}), timeoutMs });
    return { ...source, accountId: await readOptionsAccount(client, timeoutMs) };
  } catch (error) { return { ...source, problem: `用工作台期权密钥读取 Bybit 账户失败：${reason(error)}` }; }
}

const mask = (id: string | null): string | null => id === null ? null : `***${id.slice(-4)}`;

/**
 * Adds config.json `options` and secrets.json `bybitOptions` in place, or says why not. An `options` block already there
 * is kept as it is; a `bybitOptions` key without one is not overwritten.
 */
export function planOptions(source: OptionsSource, config: Json, secrets: Json, fits: (candidate: Json) => void, notes: string[]): OptionsItem {
  const item: OptionsItem = { accountId: mask(source.accountId), status: 'skipped', detail: '' };
  if (config.options !== undefined) { item.detail = '已在本项目配置中，保留现有设置'; return item; }
  if (source.problem !== null || !source.credentials) { item.detail = source.problem ?? '未能判断'; return item; }
  if (source.accountId === null) { item.detail = '未能读取密钥所属的 Bybit 账户 UID'; return item; }
  if (secrets.bybitOptions !== undefined) { item.detail = '现有密钥文件里已有 bybitOptions 但 config.json 没有 options，不覆盖；请先确认并移走它'; return item; }
  const options = { accountId: source.accountId, ...structuredClone(source.settings) };
  const key = { apiKey: source.credentials.apiKey, apiSecret: source.credentials.apiSecret };
  let parsed;
  try {
    fits({ ...config, options });
    parseOptionsSecrets({ bybitOptions: key });
    parsed = parseOptionsConfig(options);
  } catch (error) {
    // Messages built by these checks never carry a key (options-config.ts).
    item.detail = `加入后本服务不接受（${reason(error)}）`;
    return item;
  }
  config.options = options;
  secrets.bybitOptions = key;
  item.status = 'added';
  item.detail = `Bybit 账户 ${item.accountId}（${parsed.strategyMode === 'iron_condor' ? '四腿铁鹰' : '双腿卖出'}，每腿 ${parsed.legQty} BTC，最大亏损上限 ${parsed.limits.maxRiskUsd} / 保证金上限 ${parsed.limits.maxMarginUsd} USD）`;
  const time = `${String(parsed.openHourUtc).padStart(2, '0')}:${String(parsed.openMinuteUtc).padStart(2, '0')}`;
  notes.push(`期权定时开仓在配置里是关闭的（时间沿用周五 ${time} UTC），要用时在期权页打开；数据目录里若留有本服务以前的期权状态（options.sqlite）且当时在页面打开过定时开仓，会沿用那次的页面设置，导入后请先在期权页核对${parsed.marketFallback ? '；IOC 兜底已按工作台打开' : ''}；导入后工作台期权模块不能再用这个 Bybit 账户下期权单`);
  if (source.ignored?.length) notes.push(`工作台改过的这些期权参数本服务不导入，仍按本服务的默认值估算与下单：${source.ignored.join('、')}`);
  return item;
}
