// Oil spread rules (docs/oil.md section 7). A rule watches one venue's same-venue BZ − CL executable spread on the books the
// oil page already reads every 3 s. In observe mode (O2a) it only records when its open or close condition would have fired;
// in live mode (O2b, rule-live.ts) it opens and closes through the executor's own preview and confirm.
//
// The semantics follow the workbench's server/trading-auto.mjs (commit 31242e0): open and close are counted on their own,
// a hit needs a new book read, one record per continuous qualifying streak, and every start, stop, edit, book gap and
// restart clears the count and waits for the next fresh books. Counts live in memory only; the rules and their records
// live in oil-rules.sqlite beside the main database, which an older version never opens.
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ContractError, VENUES, VENUE_NAMES, exactKeys, integer, oneOf, reject, type Venue } from '../contracts.ts';
import { cmp, decimal, sub } from '../decimal.ts';
import {
  FAILURE_LIMIT, PHASE_NAMES, RETRY_MS, actionName, beijingDay, idleLive, isFinal, liveOf, opensOn, planLegs, planRows, ruleIntent, ruleSession, sameAccount, settleJob,
  type LiveState, type RuleExecutor, type Tracked,
} from './rule-live.ts';

export const OIL_RULES_DATABASE = 'oil-rules.sqlite';
/** 2: live mode (state JSON gains `live`); v0.18.0–v0.20.0 refuse a version-2 store rather than read live rules as observe ones. */
export const RULES_SCHEMA_VERSION = 2;
export const MAX_RULES = 12;
export const MAX_EVENTS = 30;
/** Books older than this, or a gap this long between two readings, are not judged (the workbench's QUOTE_MAX_AGE). */
export const QUOTE_MAX_AGE_MS = 10_000;
/** A book stamped further ahead of the server clock than this is not trusted. */
export const QUOTE_FUTURE_MS = 1_000;
const THRESHOLD_LIMIT = '1000', BARRELS_LIMIT = '10000';
const BZ = 'BZUSDT', CL = 'CLUSDT';

export type Direction = 'short' | 'long';
export type RuleAction = 'open' | 'close';
export interface RuleConfig {
  name: string;
  venue: Venue;
  direction: Direction;
  /** USDT per barrel, decimal strings. */
  openThreshold: string;
  closeThreshold: string;
  /** Per leg; used by the live mode only. */
  barrels: string;
  confirmSamples: number;
  /** Beijing calendar day; used by the live mode only. */
  maxOpensPerDay: number;
}
export interface RuleEvent {
  at: number;
  kind: 'signal' | 'reset' | 'note';
  message: string;
  action?: RuleAction;
  /** The executable spread that met the threshold, USDT per barrel. */
  value?: string;
  threshold?: string;
  hits?: number;
  bzAt?: number;
  clAt?: number;
  revision?: number;
}
interface RuleState { mode: 'observe' | 'live'; observing: boolean; live: LiveState; events: RuleEvent[]; observations: RuleEvent[] }
interface Rule { id: string; revision: number; createdAt: number; config: RuleConfig; state: RuleState }

/** The slice of the oil market view a rule reads: one row per venue and contract. */
export interface BookRow { venue: Venue; symbol: string; bid: string | null; ask: string | null; receivedAt: number | null; error: string | null }
export interface Reading { value: string; met: boolean; side: 'sell' | 'buy'; sample: string; at: number; bzAt: number; clAt: number }
interface Counted extends Reading { hits: number; signaled: boolean }
interface Observed { open?: Counted; close?: Counted; note: string | null }

const CONFIG_KEYS = ['name', 'venue', 'direction', 'openThreshold', 'closeThreshold', 'barrels', 'confirmSamples', 'maxOpensPerDay'] as const;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function bounded(value: unknown, name: string, low: string, high: string, sign: 'any' | 'positive'): string {
  let result: string;
  try {
    if (typeof value !== 'string' || value.length > 24) throw new Error();
    result = decimal(value, sign);
  } catch { return reject('invalid_decimal', `${name}须为${sign === 'positive' ? '正的' : ''}十进制数值`); }
  if (cmp(result, low) < 0 || cmp(result, high) > 0) reject('invalid_value', `${name}须在 ${low} 至 ${high} 之间`);
  return result;
}

/** Checks a rule's settings; `venues` are the configured oil venues (a rule elsewhere could never be judged). */
export function parseRuleConfig(value: unknown, venues: readonly Venue[]): RuleConfig {
  const raw = exactKeys(value, [...CONFIG_KEYS]);
  const name = raw.name;
  if (typeof name !== 'string' || name.trim().length > 40 || CONTROL.test(name)) reject('invalid_value', '规则名称最多 40 个字符');
  const venue = oneOf(raw.venue, VENUES, '交易所');
  if (!venues.includes(venue)) reject('venue_not_configured', `没有配置 ${VENUE_NAMES[venue]} 原油执行账户`);
  const direction = oneOf(raw.direction, ['short', 'long'] as const, '开仓方向');
  const openThreshold = bounded(raw.openThreshold, '开仓阈值', `-${THRESHOLD_LIMIT}`, THRESHOLD_LIMIT, 'any');
  const closeThreshold = bounded(raw.closeThreshold, '平仓阈值', `-${THRESHOLD_LIMIT}`, THRESHOLD_LIMIT, 'any');
  const order = cmp(closeThreshold, openThreshold);
  if (direction === 'short' ? order >= 0 : order <= 0) reject('threshold_order', direction === 'short' ? '做空价差时，平仓阈值须低于开仓阈值' : '做多价差时，平仓阈值须高于开仓阈值');
  return {
    name: (name as string).trim(), venue, direction, openThreshold, closeThreshold,
    barrels: bounded(raw.barrels, '每腿桶数', '0', BARRELS_LIMIT, 'positive'),
    confirmSamples: integer(raw.confirmSamples, 1, 30, '连续满足次数'),
    maxOpensPerDay: integer(raw.maxOpensPerDay, 1, 50, '每日最多开仓次数'),
  };
}

/** A complete stand-in for stored settings that no longer parse: each field kept only when it has the right type. */
function placeholderConfig(text: string): RuleConfig {
  let raw: Record<string, unknown> = {};
  try { const value: unknown = JSON.parse(text); if (value && typeof value === 'object' && !Array.isArray(value)) raw = value as Record<string, unknown>; } catch { /* nothing to keep */ }
  const text24 = (value: unknown) => typeof value === 'string' && value.length <= 24 ? value : '';
  const whole = (value: unknown) => Number.isSafeInteger(value) ? value as number : 0;
  return {
    name: typeof raw.name === 'string' && raw.name.length <= 40 && !CONTROL.test(raw.name) ? raw.name : '',
    venue: (VENUES as readonly unknown[]).includes(raw.venue) ? raw.venue as Venue : 'binance',
    direction: raw.direction === 'long' ? 'long' : 'short',
    openThreshold: text24(raw.openThreshold), closeThreshold: text24(raw.closeThreshold), barrels: text24(raw.barrels),
    confirmSamples: whole(raw.confirmSamples), maxOpensPerDay: whole(raw.maxOpensPerDay),
  };
}

/** Stored state read defensively: anything that is not the expected shape becomes a stopped rule with the records it can keep. */
function stateOf(text: string): RuleState {
  let raw: Record<string, unknown> | null = null;
  try { const value: unknown = JSON.parse(text); if (value && typeof value === 'object' && !Array.isArray(value)) raw = value as Record<string, unknown>; } catch { /* nothing to keep */ }
  const valid = (item: unknown): item is RuleEvent => {
    if (!item || typeof item !== 'object') return false;
    const record = item as Record<string, unknown>;
    if (!Number.isFinite(record.at) || typeof record.message !== 'string' || !['signal', 'reset', 'note'].includes(record.kind as string)) return false;
    // A signal is shown with its value, threshold, count and both book times.
    return record.kind !== 'signal' || (typeof record.value === 'string' && typeof record.threshold === 'string' && ['hits', 'bzAt', 'clAt'].every(key => Number.isFinite(record[key])));
  };
  const records = (value: unknown): RuleEvent[] => Array.isArray(value) ? value.filter(valid).slice(-MAX_EVENTS) : [];
  // A state that cannot be read, or names no known mode, may belong to a live rule holding a position: it is held for review
  // (not deletable until reset) rather than read as an observe rule. Rules from before live mode have no mode at all.
  if (!raw || (raw.mode !== undefined && raw.mode !== 'observe' && raw.mode !== 'live')) {
    return { mode: 'live', observing: false, live: { ...idleLive(), phase: 'review', reason: '规则状态无法读取；请在执行进度与交易所核对后重置' }, events: records(raw?.events), observations: [] };
  }
  const mode = raw.mode === 'live' ? 'live' : 'observe';
  // An observe rule keeps the day's opens it made while live, so switching modes does not clear the daily limit.
  const live = mode === 'live' ? liveOf(raw.live) : { ...idleLive(), opens: liveOf(raw.live).opens };
  return { mode, observing: mode === 'observe' && raw.observing === true, live, events: records(raw.events), observations: records(raw.observations) };
}

export const ruleTitle = (config: RuleConfig): string => config.name || `${VENUE_NAMES[config.venue]} 原油${config.direction === 'short' ? '做空' : '做多'}价差`;

/**
 * The executable spread for one condition and whether it meets its threshold, or why it cannot be judged. Selling the
 * spread (short open, long close) gets BZ bid − CL ask and must reach the threshold; buying it (short close, long open)
 * pays BZ ask − CL bid and must not exceed it.
 */
export function evaluateRule(config: RuleConfig, action: RuleAction, books: readonly BookRow[], now: number): Reading | { error: string } {
  const read = (symbol: string): { bid: string; ask: string; at: number } | { error: string } => {
    const row = books.find(item => item.venue === config.venue && item.symbol === symbol);
    if (!row || row.bid === null || row.ask === null || row.receivedAt === null) return { error: `${symbol} 未取得盘口` };
    if (row.error) return { error: `${symbol} 盘口读取失败` };
    if (row.receivedAt - now > QUOTE_FUTURE_MS) return { error: `${symbol} 盘口时间超前，请检查时钟` };
    if (now - row.receivedAt > QUOTE_MAX_AGE_MS) return { error: `${symbol} 盘口已过期` };
    return { bid: row.bid, ask: row.ask, at: row.receivedAt };
  };
  const bz = read(BZ), cl = read(CL);
  if ('error' in bz) return bz;
  if ('error' in cl) return cl;
  const sell = (config.direction === 'short') === (action === 'open');
  const value = sell ? sub(bz.bid, cl.ask) : sub(bz.ask, cl.bid);
  const sign = cmp(value, action === 'open' ? config.openThreshold : config.closeThreshold);
  return { value, met: sell ? sign >= 0 : sign <= 0, side: sell ? 'sell' : 'buy', sample: `${bz.at}|${cl.at}`, at: Math.min(bz.at, cl.at), bzAt: bz.at, clAt: cl.at };
}

function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  try {
    const mode = (db.prepare('PRAGMA journal_mode=WAL').get() as { journal_mode: string }).journal_mode;
    if (mode !== 'wal') throw new Error(`未能进入 WAL 模式：${mode}`);
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > RULES_SCHEMA_VERSION) throw new Error(`库版本 ${version} 比本版本能读的 ${RULES_SCHEMA_VERSION} 新`);
    db.exec('PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS rules (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at INTEGER NOT NULL, config TEXT NOT NULL, state TEXT NOT NULL)');
    // A table left by something else is refused before the version is stamped on it.
    const columns = (db.prepare('PRAGMA table_info(rules)').all() as { name: string }[]).map(column => column.name).join(',');
    if (columns !== 'id,revision,created_at,config,state') throw new Error(`rules 表结构不符：${columns}`);
    db.exec(`PRAGMA user_version=${RULES_SCHEMA_VERSION}`);
  } catch (error) { db.close(); throw error; }
  return db;
}

export interface OilRulesOptions {
  file: string;
  /** Configured oil venues. */
  venues: readonly Venue[];
  /** The oil market's current books (OilMarket.view().books). */
  books: () => readonly BookRow[];
  now?: () => number;
  /** The executor live rules order through; without it rules can only observe. */
  executor?: RuleExecutor;
}

/**
 * Opens the rules store. Observing and enabled live rules get a restart record and wait for fresh books: hits are never
 * carried over a restart. A live rule's pending confirm or running job is followed on from the next round. A rule whose
 * stored settings no longer parse is kept and shown, but not judged, until it is edited or deleted.
 */
export function createOilRules({ file, venues, books, now = Date.now, executor }: OilRulesOptions) {
  const db = openDatabase(file);
  try { return rulesOn(db, venues, books, now, executor); } catch (error) { db.close(); throw error; }
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);
/** Codes a preview or confirm answers that mean the books moved or the plan aged: count again, no failure. */
const RECOUNT = new Set(['quote_stale', 'quote_incomplete', 'quote_future', 'quote_window', 'preview_invalid', 'preview_generation']);

function rulesOn(db: DatabaseSync, venues: readonly Venue[], books: () => readonly BookRow[], now: () => number, executor: RuleExecutor | undefined) {
  const selectAll = db.prepare('SELECT id, revision, created_at AS createdAt, config, state FROM rules ORDER BY created_at, rowid');
  const selectOne = db.prepare('SELECT id, revision, created_at AS createdAt, config, state FROM rules WHERE id = ?');
  const insert = db.prepare('INSERT INTO rules (id, revision, created_at, config, state) VALUES (?, ?, ?, ?, ?)');
  const write = db.prepare('UPDATE rules SET revision = ?, config = ?, state = ? WHERE id = ?');
  // Rounds write state only onto the revision they read: a page action in between wins and the round's result is dropped.
  const writeState = db.prepare('UPDATE rules SET state = ? WHERE id = ? AND revision = ?');
  // Page actions leave the stored settings as they are (a rule whose settings no longer parse keeps the original text).
  const writeRevision = db.prepare('UPDATE rules SET revision = ?, state = ? WHERE id = ?');
  const remove = db.prepare('DELETE FROM rules WHERE id = ?');
  const count = db.prepare('SELECT COUNT(*) AS n FROM rules');
  const observed = new Map<string, Observed>();
  /** Books read at or before this time do not count for the rule (set at start, edit, reset, restart and after each try). */
  const freshAfter = new Map<string, number>();
  const invalid = new Map<string, string>();

  type Row = { id: string; revision: number; createdAt: number; config: string; state: string };
  const parse = (row: Row | undefined): Rule | null => {
    if (!row) return null;
    let config: RuleConfig, state: RuleState;
    state = stateOf(row.state);
    try { config = parseRuleConfig(JSON.parse(row.config), VENUES); invalid.delete(row.id); }
    catch (error) {
      invalid.set(row.id, `规则参数无法读取：${error instanceof Error ? error.message.slice(0, 120) : String(error)}；请修改或删除`);
      config = placeholderConfig(row.config);
    }
    return { id: row.id, revision: Number(row.revision), createdAt: Number(row.createdAt), config, state };
  };
  const rows = (): Rule[] => (selectAll.all() as Row[]).map(row => parse(row)!);
  const find = (id: string): Rule | null => parse(selectOne.get(id) as Row | undefined);
  const ruleFor = (id: string): Rule => {
    const rule = find(id);
    if (!rule) throw new ContractError(404, 'not_found', '自动规则不存在');
    return rule;
  };
  const push = (list: RuleEvent[], event: Omit<RuleEvent, 'at'>): RuleEvent[] => [...list, { at: now(), ...event }].slice(-MAX_EVENTS);
  const event = (state: RuleState, message: string) => { state.events = push(state.events, { kind: 'note', message }); };
  const observation = (state: RuleState, message: string, fields: Partial<RuleEvent> = {}) => { state.observations = push(state.observations, { kind: 'reset', message, ...fields }); };
  const save = (rule: Rule) => {
    if (Number(writeState.run(JSON.stringify(rule.state), rule.id, rule.revision).changes) === 0) throw new Error('规则已被页面修改或删除，本轮结果没有写入');
  };
  const checkRevision = (rule: Rule, revision: unknown) => { if (!Number.isSafeInteger(revision) || rule.revision !== revision) throw new ContractError(409, 'stale_revision', '规则已被更新，请刷新后重试'); };
  const restart = (id: string) => { observed.delete(id); freshAfter.set(id, now()); };
  /** A live rule that judges books: enabled, waiting to open or holding, nothing pending or running. */
  const judging = (rule: Rule) => rule.state.mode === 'live' && rule.state.live.enabled && (rule.state.live.phase === 'idle' || rule.state.live.phase === 'holding') && !rule.state.live.pending && !rule.state.live.job;
  const busy = (live: LiveState) => live.phase === 'opening' || live.phase === 'closing' || live.pending !== null || live.job !== null;

  for (const rule of rows()) {
    freshAfter.set(rule.id, now());
    if (rule.state.observing || judging(rule)) { observation(rule.state, '服务重启，连续次数已清零，等待新盘口'); save(rule); }
    else if (rule.state.live.pending) { event(rule.state, '服务重启：有待确认的下单，将用同一请求编号向执行器核对'); save(rule); }
  }

  /** Clears the counts with a reason; the same reason in a row is recorded once. */
  function resetObservation(rule: Rule, message: string): void {
    const recorded = observed.get(rule.id)?.note === message;
    // The counts are cleared first, whatever the write does; the reason only counts as recorded once it is saved, so a
    // failed write tries it again next round.
    observed.set(rule.id, { note: null });
    freshAfter.set(rule.id, now());
    if (!recorded) { observation(rule.state, `${message}；连续次数清零`); save(rule); }
    observed.set(rule.id, { note: message });
  }
  /** A wait that clears the counts without a record (shown on the page only). */
  const hold = (rule: Rule, note: string) => { observed.set(rule.id, { note }); freshAfter.set(rule.id, now()); };

  /**
   * Counts the given conditions on the books just read. Observe mode records one signal per qualifying streak; live mode
   * leaves the record to the order that follows. Returns the counts, or null when the books cannot be judged.
   */
  function countOn(rule: Rule, current: readonly BookRow[], actions: readonly RuleAction[]): Observed | null {
    if (invalid.has(rule.id)) { observed.set(rule.id, { note: invalid.get(rule.id)! }); return null; }
    if (!venues.includes(rule.config.venue)) { resetObservation(rule, `配置里没有 ${VENUE_NAMES[rule.config.venue]} 原油执行账户`); return null; }
    const time = now();
    const readings: Partial<Record<RuleAction, Reading>> = {};
    for (const action of actions) {
      const reading = evaluateRule(rule.config, action, current, time);
      if ('error' in reading) { resetObservation(rule, reading.error); return null; }
      readings[action] = reading;
    }
    const first = readings[actions[0]!]!;
    if (first.at <= (freshAfter.get(rule.id) ?? -Infinity)) { observed.set(rule.id, { note: '等待开始或清零后的两腿新盘口' }); return null; }
    const previous = observed.get(rule.id), last = previous?.open ?? previous?.close;
    if (last && time - last.at > QUOTE_MAX_AGE_MS) { resetObservation(rule, '盘口更新间隔超过 10 秒'); return null; }
    const next: Observed = { note: null };
    let recorded = false;
    for (const action of actions) {
      const reading = readings[action]!, old = previous?.[action];
      // One count per distinct book read: the same sample read again keeps the count.
      const hits = !reading.met ? 0 : old?.sample === reading.sample ? old.hits : (old?.met ? old.hits : 0) + 1;
      // One record per continuous qualifying streak, not an invented trading cycle.
      const signaled = reading.met && (old?.signaled === true || hits >= rule.config.confirmSamples);
      next[action] = { ...reading, hits, signaled };
      if (rule.state.mode === 'observe' && signaled && !old?.signaled) {
        rule.state.observations = push(rule.state.observations, { kind: 'signal', message: `${actionName(action)}条件本会触发；仅记录信号，未下单`, action, value: reading.value, threshold: action === 'open' ? rule.config.openThreshold : rule.config.closeThreshold, hits, bzAt: reading.bzAt, clAt: reading.clAt, revision: rule.revision });
        recorded = true;
      }
    }
    if (recorded) save(rule);
    observed.set(rule.id, next);
    return next;
  }

  // ---- live mode -----------------------------------------------------------------------------------------------------
  /** Rule state as it stands after an await: the same revision, still live and judging, or null (this try is dropped). */
  function unchanged(id: string, revision: number, phase: LiveState['phase']): Rule | null {
    const rule = find(id);
    return rule && rule.revision === revision && judging(rule) && rule.state.live.phase === phase && !invalid.has(id) ? rule : null;
  }
  /** After a rejection: a locked contract waits, moved books count again, anything else is a failure (three disable). */
  function rejected(rule: Rule, action: RuleAction, step: string, error: unknown): void {
    const live = rule.state.live, code = error instanceof ContractError ? error.code : '';
    const text = `${actionName(action)}${step}未通过：${message(error)}`;
    // A locked contract, or an executor that lost its writer (stopping or replaced), says nothing about the rule: wait.
    if (code === 'symbol_locked' || code === 'writer_lost') { live.retryAt = now() + RETRY_MS; event(rule.state, `${text}；等待 ${RETRY_MS / 1000} 秒，不计失败`); }
    else if (RECOUNT.has(code)) event(rule.state, `${text}；重新计数，不计失败`);
    else {
      live.failures += 1;
      live.retryAt = now() + RETRY_MS;
      if (live.failures >= FAILURE_LIMIT) {
        live.enabled = false;
        live.reason = `连续 ${live.failures} 次失败，规则已停用：${message(error)}`;
        event(rule.state, `${text}；连续 ${live.failures} 次失败，规则已停用`);
      } else event(rule.state, `${text}；第 ${live.failures} 次失败，${RETRY_MS / 1000} 秒后再判断`);
    }
    save(rule);
  }
  /** Stops the rule and keeps what it holds for a person to check on the venue. */
  function toReview(rule: Rule, text: string): void {
    const live = rule.state.live;
    live.phase = 'review'; live.enabled = false; live.pending = null; live.job = null; live.reason = text;
    event(rule.state, text);
    save(rule);
  }
  /** Gives back an open that never reached the venue (same Beijing day only). */
  const giveBack = (live: LiveState, day: string) => { if (live.opens.day === day && live.opens.count > 0) live.opens = { day, count: live.opens.count - 1 }; };

  /**
   * Calls the executor's confirm for the pending record. It is idempotent on the request id: a replay after a restart or an
   * unknown answer returns the job already created. A rejection before the job is written means none was created; any other
   * error leaves the pending record for the next round.
   */
  function submit(rule: Rule): void {
    const live = rule.state.live, pending = live.pending!;
    let result: ReturnType<RuleExecutor['confirm']>;
    try { result = executor!.confirm({ previewId: pending.previewId, requestId: pending.requestId, confirmLive: true }, ruleSession(rule.id)); }
    catch (error) {
      if (error instanceof ContractError && error.status < 500 && error.code !== 'request_reused') {
        live.phase = pending.action === 'open' ? 'idle' : 'holding';
        live.pending = null;
        if (pending.action === 'open') giveBack(live, pending.day);
        rejected(rule, pending.action, '确认', error);
        return;
      }
      if (error instanceof ContractError && error.code === 'request_reused') { toReview(rule, `${actionName(pending.action)}确认的请求编号被占用（${message(error)}）；规则已停用，请在执行进度核对后重置`); return; }
      // The same unknown answer every round is recorded once.
      const text = `${actionName(pending.action)}确认结果未知：${message(error)}；下一轮用同一请求编号核对，不会另发任务`;
      if (rule.state.events.at(-1)?.message !== text) { event(rule.state, text); save(rule); }
      throw error;
    }
    track(rule, result.job.id, `${result.duplicate ? '核对到' : '已确认'}${actionName(pending.action)}任务 ${result.job.id}，执行器正在执行`);
  }
  /** Moves the pending record to the job it created. */
  function track(rule: Rule, jobId: string, text: string): void {
    const live = rule.state.live, pending = live.pending!;
    live.job = { id: jobId, action: pending.action, at: pending.at, day: pending.day, accounts: pending.accounts } satisfies Tracked;
    live.pending = null; live.retryAt = null;
    event(rule.state, text);
    save(rule);
  }
  /**
   * A rule disabled with a pending record does not confirm again: it only looks up whether the executor already created the
   * job. Found, the job is followed to its end; not found, the order is dropped and nothing is sent.
   */
  function withdraw(rule: Rule): void {
    const live = rule.state.live, pending = live.pending!;
    let jobId: string | null;
    try { jobId = executor!.confirmedJob(pending.requestId, pending.previewId, ruleSession(rule.id)); }
    catch (error) {
      if (error instanceof ContractError && error.code === 'request_reused') { toReview(rule, `${actionName(pending.action)}确认的请求编号被占用（${message(error)}）；规则已停用，请在执行进度核对后重置`); return; }
      throw error;
    }
    if (jobId) { track(rule, jobId, `规则已停用；核对到停用前已建的${actionName(pending.action)}任务 ${jobId}，跟踪到结束`); return; }
    live.phase = pending.action === 'open' ? 'idle' : 'holding';
    live.pending = null;
    if (pending.action === 'open') giveBack(live, pending.day);
    event(rule.state, `规则已停用；待确认的${actionName(pending.action)}在执行器里没有任务，已放弃，不再下单`);
    save(rule);
  }

  /** Preview, recheck and confirm one open or close; the counts start again whatever happens. */
  async function trigger(rule: Rule, action: RuleAction, reading: Counted): Promise<void> {
    const id = rule.id, revision = rule.revision, phase = rule.state.live.phase;
    hold(rule, `${actionName(action)}条件已满足，正在预览`);
    rule.state.observations = push(rule.state.observations, { kind: 'signal', message: `${actionName(action)}条件连续满足，预览下单`, action, value: reading.value, threshold: action === 'open' ? rule.config.openThreshold : rule.config.closeThreshold, hits: reading.hits, bzAt: reading.bzAt, clAt: reading.clAt, revision });
    save(rule);
    let plan: Awaited<ReturnType<RuleExecutor['preview']>>;
    try { plan = await executor!.preview(ruleIntent(rule.config, action, rule.state.live.held), ruleSession(id)); }
    catch (error) {
      const current = unchanged(id, revision, phase);
      if (current) rejected(current, action, '预览', error);
      hold(rule, `${actionName(action)}预览未通过`);
      return;
    }
    // The page may have edited, disabled or deleted the rule while the preview read the venue: then this try is dropped
    // and the preview simply expires.
    const current = unchanged(id, revision, phase);
    hold(rule, `${actionName(action)}已处理，等待新盘口`);
    if (!current) return;
    const live = current.state.live, legs = planLegs(plan);
    if (!legs) { rejected(current, action, '预览', new Error('预览的两腿不是 CL、BZ')); return; }
    const time = now(), day = beijingDay(time);
    // Recheck on the books the plan was priced on: the executor protects the price, this protects the threshold.
    const again = evaluateRule(current.config, action, planRows(current.config.venue, legs), time);
    if ('error' in again || !again.met) {
      event(current.state, `下单前复核未通过（${'error' in again ? again.error : `预览盘口价差 ${again.value}，阈值 ${action === 'open' ? current.config.openThreshold : current.config.closeThreshold}`}），不下单，重新计数`);
      save(current);
      return;
    }
    if (action === 'close' && !current.state.live.held!.every((leg, index) => sameAccount(leg, legs[index]!))) {
      toReview(current, '平仓预览的执行账户或凭据版本与开仓时不同，没有向新账户平仓；规则已停用，请在交易所核对后重置');
      return;
    }
    if (action === 'open' && opensOn(live, day) >= current.config.maxOpensPerDay) { event(current.state, `今日已开仓 ${opensOn(live, day)} 次，达到上限，不下单`); save(current); return; }
    live.phase = action === 'open' ? 'opening' : 'closing';
    live.pending = { action, requestId: randomUUID(), previewId: plan.id, at: time, day, accounts: legs.map(leg => ({ accountKey: leg.accountKey, credentialVersion: leg.credentialVersion })) };
    if (action === 'open') live.opens = { day, count: opensOn(live, day) + 1 };
    event(current.state, `${actionName(action)}预览通过：价差 ${again.value}，CL ${legs[0].quantity}、BZ ${legs[1].quantity}${plan.barrels ? `（每腿 ${plan.barrels} 桶）` : ''}${plan.notional ? `，名义 ${plan.notional} USDT` : ''}；确认下单`);
    // Written before the confirm, so a restart in between replays the same request instead of sending another.
    save(current);
    submit(current);
  }

  /** Follows the rule's job to its end and moves the rule on from what it filled. */
  function follow(rule: Rule): void {
    const live = rule.state.live, tracked = live.job!;
    let job: ReturnType<RuleExecutor['jobView']>;
    try { job = executor!.jobView(tracked.id); }
    catch (error) {
      if (error instanceof ContractError && error.status === 404) { toReview(rule, `${actionName(tracked.action)}任务 ${tracked.id} 记录读不到；规则已停用，请在交易所核对后重置`); return; }
      throw error;
    }
    if (!isFinal(job.status)) { observed.set(rule.id, { note: `${actionName(tracked.action)}任务执行中` }); return; }
    const outcome = settleJob(job, tracked, live.held, rule.config.direction);
    if (outcome.kind === 'review') { toReview(rule, outcome.message); return; }
    live.job = null;
    let text = outcome.message;
    if (outcome.kind === 'hold') { live.phase = 'holding'; live.held = outcome.held; live.failures = 0; }
    else if (outcome.kind === 'flat') { live.phase = 'idle'; live.held = null; live.failures = 0; }
    else {
      live.phase = tracked.action === 'open' ? 'idle' : 'holding';
      live.retryAt = now() + RETRY_MS;
      if (tracked.action === 'open') giveBack(live, tracked.day);
      // A job stopped from the page is a person stepping in: the rule stops too. A job the venue refused counts as a failure,
      // so a venue that keeps refusing disables the rule instead of being tried every minute.
      if (job.status === 'stopped') { live.enabled = false; live.reason = '任务被手动停止，规则已停用'; text += '；任务是手动停止的，规则已停用'; }
      else if (++live.failures >= FAILURE_LIMIT) { live.enabled = false; live.reason = `连续 ${live.failures} 次失败，规则已停用：${outcome.message.slice(0, 200)}`; text += `；连续 ${live.failures} 次失败，规则已停用`; }
      else text += `（第 ${live.failures} 次失败）`;
    }
    event(rule.state, text);
    save(rule);
    restart(rule.id);
  }

  async function liveStep(rule: Rule, current: readonly BookRow[]): Promise<void> {
    const live = rule.state.live;
    if ((live.pending || live.job || judging(rule)) && !executor) { hold(rule, '本服务没有接入执行器，实盘规则不能执行'); return; }
    if (live.pending) { if (live.enabled) submit(rule); else withdraw(rule); return; }
    if (live.job) { follow(rule); return; }
    if (!judging(rule)) { observed.delete(rule.id); return; }
    const time = now();
    if (live.retryAt !== null && time < live.retryAt) { hold(rule, `等待重试，${new Date(live.retryAt).toISOString().slice(11, 19)} UTC 后再判断`); return; }
    const action: RuleAction = live.phase === 'idle' ? 'open' : 'close';
    if (action === 'open' && opensOn(live, beijingDay(time)) >= rule.config.maxOpensPerDay) { hold(rule, `今日已开仓 ${opensOn(live, beijingDay(time))} 次，达到每日上限`); return; }
    const counts = countOn(rule, current, [action]);
    const reading = counts?.[action];
    if (reading && reading.hits >= rule.config.confirmSamples) await trigger(rule, action, reading);
  }

  let running: Promise<void> | null = null;
  async function round(stopped: () => boolean): Promise<void> {
    const current = books(), active = new Set<string>();
    let cut = false;
    // One rule's failure (say a write) does not stop the others; the failures are thrown together for the loop's log.
    const failed: string[] = [];
    // Each rule is read again at its turn: an earlier rule's preview awaits, and the page may act on later ones meanwhile.
    for (const id of rows().map(rule => rule.id)) {
      // Stopping: the rule in flight finishes, the rest wait for the next start (no new preview or job while shutting down).
      if (stopped()) { cut = true; break; }
      const rule = find(id);
      if (!rule) continue;
      if (rule.state.observing || rule.state.mode === 'live') active.add(id);
      try {
        if (rule.state.mode === 'live') await liveStep(rule, current);
        else if (rule.state.observing) countOn(rule, current, ['open', 'close']);
      } catch (error) { failed.push(`${ruleTitle(rule.config)}（${rule.id}）：${error instanceof Error ? error.message : String(error)}`); }
    }
    if (!cut) for (const id of observed.keys()) if (!active.has(id)) observed.delete(id);
    if (failed.length) throw new Error(failed.join('；'));
  }
  /**
   * Judges every active rule on the books just read; called after each market round. Rounds never overlap. `stopped` is
   * checked between rules, so a stopping service waits for one preview at most.
   */
  function tick(stopped: () => boolean = () => false): Promise<void> {
    if (!running) running = round(stopped).finally(() => { running = null; });
    return running;
  }

  function readingView(reading: Counted | undefined, time: number) {
    if (!reading) return null;
    const stale = time - reading.at > QUOTE_MAX_AGE_MS;
    return { value: reading.value, met: reading.met && !stale, side: reading.side, hits: stale ? 0 : reading.hits, signaled: reading.signaled && !stale, at: reading.at, stale };
  }
  function liveView(live: LiveState, time: number) {
    return {
      enabled: live.enabled, phase: live.phase, phaseName: PHASE_NAMES[live.phase],
      held: live.held?.map(({ symbol, side, quantity, barrels }) => ({ symbol, side, quantity, barrels })) ?? null,
      pending: live.pending ? { action: live.pending.action, at: live.pending.at } : null,
      job: live.job ? { id: live.job.id, action: live.job.action, at: live.job.at } : null,
      opensToday: opensOn(live, beijingDay(time)), failures: live.failures, retryAt: live.retryAt !== null && live.retryAt > time ? live.retryAt : null, reason: live.reason,
    };
  }
  function ruleView(rule: Rule, time: number) {
    const seen = observed.get(rule.id), live = rule.state.mode === 'live';
    return {
      id: rule.id, revision: rule.revision, createdAt: rule.createdAt, title: ruleTitle(rule.config), mode: rule.state.mode, observing: rule.state.observing, config: rule.config,
      problem: invalid.get(rule.id) ?? null,
      observation: rule.state.observing || (live && (judging(rule) || busy(rule.state.live))) ? { open: readingView(seen?.open, time), close: readingView(seen?.close, time), note: seen ? seen.note : '等待读取盘口' } : null,
      live: live ? liveView(rule.state.live, time) : null,
      observations: rule.state.observations, events: rule.state.events,
    };
  }
  function view() {
    const time = now();
    return { available: true as const, liveAvailable: executor !== undefined, now: time, maxRules: MAX_RULES, quoteMaxAgeMs: QUOTE_MAX_AGE_MS, failureLimit: FAILURE_LIMIT, venues, rules: rows().map(rule => ruleView(rule, time)) };
  }

  function create(body: unknown) {
    const raw = exactKeys(body, ['config'], ['observing']);
    const config = parseRuleConfig(raw.config, venues);
    if (raw.observing !== undefined && typeof raw.observing !== 'boolean') reject('invalid_value', '观察状态无效');
    if ((count.get() as { n: number }).n >= MAX_RULES) throw new ContractError(409, 'too_many_rules', `最多保存 ${MAX_RULES} 条自动规则`);
    const observing = raw.observing === true, id = randomUUID();
    // Only observe rules are created: live is entered with its own confirmation and a revision, so a resent create can never
    // add a live rule.
    const state: RuleState = { mode: 'observe', observing, live: idleLive(), events: [], observations: [] };
    event(state, '规则已创建（观察模式，不下单）');
    observation(state, observing ? '开始只观察，等待新盘口' : '观察规则已保存，尚未开始');
    insert.run(id, 0, now(), JSON.stringify(config), JSON.stringify(state));
    restart(id);
    return view();
  }
  function update(id: string, body: unknown) {
    const raw = exactKeys(body, ['revision', 'config']);
    const rule = ruleFor(id);
    checkRevision(rule, raw.revision);
    const config = parseRuleConfig(raw.config, venues);
    const live = rule.state.live;
    if (rule.state.mode === 'live') {
      if (busy(live)) throw new ContractError(409, 'rule_busy', '规则正在开仓或平仓，结束后再修改');
      // Size, thresholds and limits were confirmed when the rule was enabled: changing them takes a disable and a new enable.
      if (live.enabled) throw new ContractError(409, 'rule_enabled', '启用中的实盘规则请先停用再修改，改完重新启用确认');
      if (live.phase !== 'idle' && (config.venue !== rule.config.venue || config.direction !== rule.config.direction)) throw new ContractError(409, 'rule_holding', '规则持仓或待核对时不能修改交易所与方向');
    }
    event(rule.state, '规则参数已修改');
    if (rule.state.observing || judging(rule)) observation(rule.state, '规则参数已修改，连续次数已清零，等待新盘口');
    write.run(rule.revision + 1, JSON.stringify(config), JSON.stringify(rule.state), id);
    invalid.delete(id);
    restart(id);
    return view();
  }
  function act(id: string, action: string, body: unknown) {
    const confirming = action === 'live' || action === 'enable';
    const raw = exactKeys(body, ['revision'], confirming ? ['confirmLive'] : []);
    const rule = ruleFor(id);
    checkRevision(rule, raw.revision);
    const state = rule.state, live = state.live, isLive = state.mode === 'live';
    const refuse = (code: string, text: string): never => { throw new ContractError(409, code, text); };
    if (confirming) {
      if (raw.confirmLive !== true) reject('confirm_required', '实盘规则须明确确认（confirmLive: true）');
      if (!executor) throw new ContractError(503, 'live_unavailable', '本服务没有接入执行器，不能启用实盘规则');
      if (invalid.has(id)) refuse('invalid_rule', invalid.get(id)!);
      if (!venues.includes(rule.config.venue)) refuse('venue_not_configured', `配置里没有 ${VENUE_NAMES[rule.config.venue]} 原油执行账户`);
    }
    if (action === 'delete') {
      if (isLive && (busy(live) || live.phase !== 'idle' || live.held)) refuse('rule_holding', '只有等待开仓且没有持仓的规则能删除');
      remove.run(id);
      observed.delete(id); freshAfter.delete(id); invalid.delete(id);
      return view();
    }
    if (action === 'start' || action === 'stop') {
      if (isLive) refuse('live_rule', '实盘规则请用启用或停用');
      if (action === 'start') {
        if (state.observing) refuse('already_observing', '规则已在观察中');
        if (invalid.has(id)) refuse('invalid_rule', invalid.get(id)!);
        state.observing = true;
        event(state, '开始只观察');
        observation(state, '开始只观察，连续次数已清零，等待新盘口');
      } else {
        if (!state.observing) refuse('not_observing', '规则没有在观察');
        state.observing = false;
        event(state, '已停止观察');
        observation(state, '观察已停止，连续次数已清零');
      }
    } else if (action === 'live') {
      if (isLive) refuse('already_live', '规则已是实盘模式');
      state.mode = 'live'; state.observing = false;
      // The day's opens survive a trip back to observe, so the daily limit cannot be cleared by switching modes.
      state.live = { ...idleLive(), enabled: true, opens: live.opens };
      event(state, '已转为实盘模式并启用：条件满足后会通过执行器下单');
      observation(state, '实盘启用，连续次数已清零，等待新盘口');
    } else if (action === 'enable') {
      if (!isLive) refuse('not_live', '观察规则请先转为实盘');
      if (live.enabled) refuse('already_enabled', '规则已启用');
      if (live.phase === 'review') refuse('rule_review', '规则待核对，请先在交易所核对后重置');
      live.enabled = true; live.failures = 0; live.retryAt = null; live.reason = null;
      event(state, '实盘规则已启用');
      if (judging(rule)) observation(state, '实盘启用，连续次数已清零，等待新盘口');
    } else if (action === 'disable') {
      if (!isLive) refuse('not_live', '观察规则请用停止观察');
      if (!live.enabled) refuse('not_enabled', '规则没有启用');
      live.enabled = false;
      event(state, busy(live) ? '实盘规则已停用；执行中的任务继续，结束后照常记录结果' : '实盘规则已停用');
    } else if (action === 'observe') {
      if (!isLive) refuse('not_live', '规则已是观察模式');
      if (live.enabled || busy(live) || live.phase !== 'idle' || live.held) refuse('rule_holding', '只有已停用、等待开仓且没有持仓的实盘规则能改回观察');
      state.mode = 'observe'; state.observing = false; state.live = { ...idleLive(), opens: live.opens };
      event(state, '已改回观察模式（未开始观察）');
    } else if (action === 'reset') {
      if (!isLive || (live.phase !== 'review' && live.phase !== 'holding') || busy(live)) refuse('not_resettable', '只有待核对或持仓中的实盘规则能重置');
      const was = PHASE_NAMES[live.phase];
      state.live = { ...idleLive(), opens: live.opens };
      event(state, `已从${was}重置为等待开仓（未启用）：规则不再记录之前的持仓，交易所上的仓位须已人工处理`);
    } else throw new ContractError(404, 'not_found', '自动规则操作不存在');
    writeRevision.run(rule.revision + 1, JSON.stringify(state), id);
    restart(id);
    return view();
  }
  return { view, tick, create, update, act, close: () => db.close() };
}
export type OilRules = ReturnType<typeof createOilRules>;
