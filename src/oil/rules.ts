// Oil spread rules (docs/oil.md section 7), observe mode (O2a). A rule watches one venue's same-venue BZ − CL executable
// spread on the books the oil page already reads every 3 s, and records when its open or its close condition would have
// fired. Nothing here places, previews or sizes an order; the live mode (O2b) comes after review.
//
// The semantics follow the workbench's server/trading-auto.mjs (commit 31242e0): open and close are counted on their own,
// a hit needs a new book read, one record per continuous qualifying streak, and every start, stop, edit, book gap and
// restart clears the count and waits for the next fresh books. Counts live in memory only; the rules and their records
// live in oil-rules.sqlite beside the main database, which an older version never opens.
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ContractError, VENUES, VENUE_NAMES, exactKeys, integer, oneOf, reject, type Venue } from '../contracts.ts';
import { cmp, decimal, sub } from '../decimal.ts';

export const OIL_RULES_DATABASE = 'oil-rules.sqlite';
export const RULES_SCHEMA_VERSION = 1;
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
interface RuleState { mode: 'observe'; observing: boolean; events: RuleEvent[]; observations: RuleEvent[] }
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
  let raw: Record<string, unknown> = {};
  try { const value: unknown = JSON.parse(text); if (value && typeof value === 'object' && !Array.isArray(value)) raw = value as Record<string, unknown>; } catch { /* nothing to keep */ }
  const valid = (item: unknown): item is RuleEvent => {
    if (!item || typeof item !== 'object') return false;
    const record = item as Record<string, unknown>;
    if (!Number.isFinite(record.at) || typeof record.message !== 'string' || !['signal', 'reset', 'note'].includes(record.kind as string)) return false;
    // A signal is shown with its value, threshold, count and both book times.
    return record.kind !== 'signal' || (typeof record.value === 'string' && typeof record.threshold === 'string' && ['hits', 'bzAt', 'clAt'].every(key => Number.isFinite(record[key])));
  };
  const records = (value: unknown): RuleEvent[] => Array.isArray(value) ? value.filter(valid).slice(-MAX_EVENTS) : [];
  return { mode: 'observe', observing: raw.observing === true, events: records(raw.events), observations: records(raw.observations) };
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
}

/**
 * Opens the rules store. Observing rules get a restart record and wait for fresh books: hits are never carried over a
 * restart. A rule whose stored settings no longer parse is kept and shown, but not judged, until it is edited or deleted.
 */
export function createOilRules({ file, venues, books, now = Date.now }: OilRulesOptions) {
  const db = openDatabase(file);
  try { return rulesOn(db, venues, books, now); } catch (error) { db.close(); throw error; }
}

function rulesOn(db: DatabaseSync, venues: readonly Venue[], books: () => readonly BookRow[], now: () => number) {
  const selectAll = db.prepare('SELECT id, revision, created_at AS createdAt, config, state FROM rules ORDER BY created_at, rowid');
  const selectOne = db.prepare('SELECT id, revision, created_at AS createdAt, config, state FROM rules WHERE id = ?');
  const insert = db.prepare('INSERT INTO rules (id, revision, created_at, config, state) VALUES (?, ?, ?, ?, ?)');
  const write = db.prepare('UPDATE rules SET revision = ?, config = ?, state = ? WHERE id = ?');
  const writeState = db.prepare('UPDATE rules SET state = ? WHERE id = ?');
  // Start and stop leave the stored settings as they are (a rule whose settings no longer parse keeps the original text).
  const writeRevision = db.prepare('UPDATE rules SET revision = ?, state = ? WHERE id = ?');
  const remove = db.prepare('DELETE FROM rules WHERE id = ?');
  const count = db.prepare('SELECT COUNT(*) AS n FROM rules');
  const observed = new Map<string, Observed>();
  /** Books read at or before this time do not count for the rule (set at start, edit, reset and restart). */
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
  const ruleFor = (id: string): Rule => {
    const rule = parse(selectOne.get(id) as Row | undefined);
    if (!rule) throw new ContractError(404, 'not_found', '自动规则不存在');
    return rule;
  };
  const push = (list: RuleEvent[], event: Omit<RuleEvent, 'at'>): RuleEvent[] => [...list, { at: now(), ...event }].slice(-MAX_EVENTS);
  const event = (state: RuleState, message: string) => { state.events = push(state.events, { kind: 'note', message }); };
  const observation = (state: RuleState, message: string, fields: Partial<RuleEvent> = {}) => { state.observations = push(state.observations, { kind: 'reset', message, ...fields }); };
  const save = (rule: Rule) => { writeState.run(JSON.stringify(rule.state), rule.id); };
  const checkRevision = (rule: Rule, revision: unknown) => { if (!Number.isSafeInteger(revision) || rule.revision !== revision) throw new ContractError(409, 'stale_revision', '规则已被更新，请刷新后重试'); };
  const restart = (id: string) => { observed.delete(id); freshAfter.set(id, now()); };

  for (const rule of rows()) {
    freshAfter.set(rule.id, now());
    if (rule.state.observing) { observation(rule.state, '服务重启，连续次数已清零，等待新盘口'); save(rule); }
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
  function observe(rule: Rule, current: readonly BookRow[]): void {
    if (invalid.has(rule.id)) { observed.set(rule.id, { note: invalid.get(rule.id)! }); return; }
    if (!venues.includes(rule.config.venue)) { resetObservation(rule, `配置里没有 ${VENUE_NAMES[rule.config.venue]} 原油执行账户`); return; }
    const time = now();
    const readings = { open: evaluateRule(rule.config, 'open', current, time), close: evaluateRule(rule.config, 'close', current, time) };
    if ('error' in readings.open) { resetObservation(rule, readings.open.error); return; }
    if ('error' in readings.close) { resetObservation(rule, readings.close.error); return; }
    if (readings.open.at <= (freshAfter.get(rule.id) ?? -Infinity)) { observed.set(rule.id, { note: '等待开始或清零后的两腿新盘口' }); return; }
    const previous = observed.get(rule.id);
    if (previous?.open && time - previous.open.at > QUOTE_MAX_AGE_MS) { resetObservation(rule, '盘口更新间隔超过 10 秒'); return; }
    const next: Observed = { note: null };
    let recorded = false;
    for (const action of ['open', 'close'] as const) {
      const reading = readings[action] as Reading, old = previous?.[action];
      // One count per distinct book read: the same sample read again keeps the count.
      const hits = !reading.met ? 0 : old?.sample === reading.sample ? old.hits : (old?.met ? old.hits : 0) + 1;
      // One record per continuous qualifying streak, not an invented trading cycle.
      const signaled = reading.met && (old?.signaled === true || hits >= rule.config.confirmSamples);
      next[action] = { ...reading, hits, signaled };
      if (signaled && !old?.signaled) {
        rule.state.observations = push(rule.state.observations, { kind: 'signal', message: `${action === 'open' ? '开仓' : '平仓'}条件本会触发；仅记录信号，未下单`, action, value: reading.value, threshold: action === 'open' ? rule.config.openThreshold : rule.config.closeThreshold, hits, bzAt: reading.bzAt, clAt: reading.clAt, revision: rule.revision });
        recorded = true;
      }
    }
    if (recorded) save(rule);
    observed.set(rule.id, next);
  }

  /** Judges every observing rule on the books just read; called after each market round. */
  function tick(): void {
    const current = books(), observing = rows().filter(rule => rule.state.observing);
    // One rule's failure (say a write) does not stop the others; the failures are thrown together for the loop's log.
    const failed: string[] = [];
    for (const rule of observing) {
      try { observe(rule, current); } catch (error) { failed.push(`${ruleTitle(rule.config)}（${rule.id}）：${error instanceof Error ? error.message : String(error)}`); }
    }
    for (const id of observed.keys()) if (!observing.some(rule => rule.id === id)) observed.delete(id);
    if (failed.length) throw new Error(failed.join('；'));
  }

  function readingView(reading: Counted | undefined, time: number) {
    if (!reading) return null;
    const stale = time - reading.at > QUOTE_MAX_AGE_MS;
    return { value: reading.value, met: reading.met && !stale, side: reading.side, hits: stale ? 0 : reading.hits, signaled: reading.signaled && !stale, at: reading.at, stale };
  }
  function ruleView(rule: Rule, time: number) {
    const seen = observed.get(rule.id);
    return {
      id: rule.id, revision: rule.revision, createdAt: rule.createdAt, title: ruleTitle(rule.config), mode: rule.state.mode, observing: rule.state.observing, config: rule.config,
      problem: invalid.get(rule.id) ?? null,
      observation: rule.state.observing ? { open: readingView(seen?.open, time), close: readingView(seen?.close, time), note: seen ? seen.note : '等待读取盘口' } : null,
      observations: rule.state.observations, events: rule.state.events,
    };
  }
  function view() {
    const time = now();
    return { available: true as const, now: time, maxRules: MAX_RULES, quoteMaxAgeMs: QUOTE_MAX_AGE_MS, venues, rules: rows().map(rule => ruleView(rule, time)) };
  }

  function create(body: unknown) {
    const raw = exactKeys(body, ['config'], ['observing']);
    const config = parseRuleConfig(raw.config, venues);
    if (raw.observing !== undefined && typeof raw.observing !== 'boolean') reject('invalid_value', '观察状态无效');
    if ((count.get() as { n: number }).n >= MAX_RULES) throw new ContractError(409, 'too_many_rules', `最多保存 ${MAX_RULES} 条自动规则`);
    const observing = raw.observing === true, id = randomUUID();
    const state: RuleState = { mode: 'observe', observing, events: [], observations: [] };
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
    event(rule.state, '规则参数已修改');
    if (rule.state.observing) observation(rule.state, '规则参数已修改，连续次数已清零，等待新盘口');
    write.run(rule.revision + 1, JSON.stringify(config), JSON.stringify(rule.state), id);
    invalid.delete(id);
    restart(id);
    return view();
  }
  function act(id: string, action: string, body: unknown) {
    const raw = exactKeys(body, ['revision']);
    const rule = ruleFor(id);
    checkRevision(rule, raw.revision);
    if (action === 'delete') {
      remove.run(id);
      observed.delete(id); freshAfter.delete(id); invalid.delete(id);
      return view();
    }
    if (action === 'start') {
      if (rule.state.observing) throw new ContractError(409, 'already_observing', '规则已在观察中');
      if (invalid.has(id)) throw new ContractError(409, 'invalid_rule', invalid.get(id)!);
      rule.state.observing = true;
      event(rule.state, '开始只观察');
      observation(rule.state, '开始只观察，连续次数已清零，等待新盘口');
    } else if (action === 'stop') {
      if (!rule.state.observing) throw new ContractError(409, 'not_observing', '规则没有在观察');
      rule.state.observing = false;
      event(rule.state, '已停止观察');
      observation(rule.state, '观察已停止，连续次数已清零');
    } else throw new ContractError(404, 'not_found', '自动规则操作不存在');
    writeRevision.run(rule.revision + 1, JSON.stringify(rule.state), id);
    restart(id);
    return view();
  }
  return { view, tick, create, update, act, close: () => db.close() };
}
export type OilRules = ReturnType<typeof createOilRules>;
