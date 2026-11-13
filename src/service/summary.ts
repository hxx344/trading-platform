// The scheduled ASTER summary card, after the workbench's hourly summary (modules/aster/trading/hourly_summary.py and
// hourly_notifications.py, b2fae14): one Feishu card per period with the total unrealized PnL, then per pair the two
// sub-accounts' available margin and margin usage, positions, transfer and ADL state; pairs that need a person first.
// It goes to the scheduled robot (secrets.feishuScheduled), or the alert robot when there is none, as the workbench's
// single-robot mode did. The schedule is kept in notify.sqlite: a restart keeps the next due time, missed periods are
// skipped rather than sent in a burst, and a send that keeps failing gives up on its period after three tries. The
// interval comes from config.json until it is set on the 设置 page, which then wins; the page can also ask for a card now.
import { DatabaseSync } from 'node:sqlite';
import type { FeishuSecret } from './config.ts';
import { sendFeishu } from './feishu.ts';
import { reject } from '../contracts.ts';
import { add, cmp, decimal, sub } from '../decimal.ts';

/** The first card after a fresh start, once balances and positions have been read. */
export const FIRST_SUMMARY_MS = 2 * 60_000;
const RETRY_MS = 60_000;
const TRIES = 3;
/** Feishu takes 20 KB per post; the workbench kept the card under 18000 bytes, 600 of them for the footer. */
const MAX_CARD_BYTES = 18_000 - 600;
/** Balances older than this (or three checks, when checks are slower) are marked as such. */
const STALE_MS = 15_000;

type Side = 'long' | 'short';
export interface SummaryPair {
  id: string; enabled: boolean; blocked: string | null; note: string | null; noteIdle: boolean; cooldownUntil: number; checkIntervalMs: number;
  /** Account names from config.json (the masked addresses mean nothing in a chat). */
  names: Record<Side, string>;
  balances: Record<Side, { available: string; equity: string; receivedAt: number }> | null;
  /** The balances were read after the last settled transfer. */
  balancesFresh: boolean;
  current: { sourceSide: Side; destinationSide: Side; amount: string; asset: string; state: string } | null;
  positions: {
    long: { state: string; positions: { unrealizedProfit: string }[] }; short: { state: string; positions: { unrealizedProfit: string }[] };
    totals: { symbol: string; long: string; short: string; balanced: boolean | null; gapPercent: string }[] | null;
  } | null;
  adl: { incident: { status: string; symbols: string[] } | null; shared: string | null } | null;
}
export interface SummaryInput {
  pairs: SummaryPair[];
  streams: { connected: boolean; lastError: string | null }[];
  budget: { usedLastMinute: number; limitPerMinute: number; coolingUntil: number | null; reason?: string | null };
  intervalMinutes: number;
}

const TRANSFER_STATE: Record<string, string> = { prepared: '准备中', sending: '发送中', acknowledged: '已受理待结算', unknown: '结果未知' };
const ADL_STATUS: Record<string, string> = { active: '自动减仓中', blocked: '受阻', halted: '已停止', watching: '观察中', completed: '已完成' };
const SIDE: Record<Side, string> = { long: 'A 多', short: 'B 空' };

const text = (value: unknown, limit = 64): string => typeof value === 'string' && value.trim() ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '待同步';
const amount = (value: string | null | undefined, places = 2): string => {
  if (value === null || value === undefined) return '待同步';
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString('en-US', { minimumFractionDigits: places, maximumFractionDigits: places }) : '待同步';
};
/** Quantities as the workbench printed them: thousands separators, up to six places, trailing zeros dropped. */
const quantity = (value: string): string => {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString('en-US', { maximumFractionDigits: 6 }) : '待同步';
};
const label = (content: string, size = 'normal', color = 'default') => ({ tag: 'div', text: { tag: 'plain_text', content, text_size: size, text_color: color } });
const columns = (parts: unknown[][], background = 'default', padding = '0px') => ({
  tag: 'column_set', flex_mode: parts.length === 2 ? 'bisect' : 'none', horizontal_spacing: '12px', background_style: background,
  columns: parts.map(elements => ({ tag: 'column', width: 'weighted', weight: 1, background_style: background, vertical_align: 'top', vertical_spacing: '4px', padding, elements })),
});
const metric = (title: string, value: string, size = 'heading-2', color = 'default') => [label(title, 'notation', 'grey'), label(value, size, color)];
/** Clock time in UTC+8, as the workbench's subtitle. */
const china = (at: number): Date => new Date(at + 8 * 3_600_000);
const two = (value: number): string => String(value).padStart(2, '0');

function usage(balance: { available: string; equity: string }): string {
  try {
    const equity = decimal(balance.equity), used = sub(equity, decimal(balance.available));
    if (cmp(equity, '0') <= 0 || cmp(used, '0') < 0) return '待同步';
    return `${(Number(used) / Number(equity) * 100).toFixed(2)}%`;
  } catch { return '待同步'; }
}

function phase(pair: SummaryPair, now: number): string {
  if (!pair.enabled) return '已停用';
  if (pair.adl?.incident) return `ADL ${ADL_STATUS[pair.adl.incident.status] ?? pair.adl.incident.status}`;
  if (pair.blocked) return '划转受阻';
  if (pair.current) return '划转进行中';
  if (pair.cooldownUntil > now) return '冷却中';
  return '运行中';
}

/** Needs a person: shown first, and its reasons in orange. */
function urgent(pair: SummaryPair): boolean {
  return Boolean(pair.blocked || pair.adl?.incident || pair.current?.state === 'unknown' || (pair.enabled && pair.note && !pair.noteIdle)
    || pair.positions?.totals?.some(row => row.balanced === false));
}

function accountCard(pair: SummaryPair, side: Side, now: number) {
  const color = side === 'long' ? 'blue' : 'red', background = side === 'long' ? 'blue-50' : 'red-50';
  const balance = pair.balances?.[side] ?? null;
  const elements: unknown[] = [
    label(`${SIDE[side]} · ${text(pair.names[side])}（实盘）`, 'heading', color),
    columns([metric('可用保证金', amount(balance?.available)), metric('保证金占用率', balance ? usage(balance) : '待同步')], background),
  ];
  const age = balance ? now - balance.receivedAt : null;
  const limit = Math.max(STALE_MS, 3 * pair.checkIntervalMs);
  if (age === null) elements.push(label(pair.enabled ? '资金余额待同步' : '资金余额待同步 · 已停用', 'notation', 'orange'));
  else if (!pair.enabled || age > limit || !pair.balancesFresh) {
    elements.push(label(`资金余额 ${Math.max(0, Math.round(age / 1000))} 秒前 · ${!pair.enabled ? '已停用' : '待刷新'}`, 'notation', 'orange'));
  }
  return columns([elements], background, '12px');
}

function pairBlock(pair: SummaryPair, now: number): { urgent: boolean; elements: unknown[] } {
  const symbols = pair.positions?.totals?.map(row => row.symbol) ?? [];
  const elements: unknown[] = [label(`${text(pair.id)} · ${symbols.length ? text(symbols.join('、')) : '无持仓'}  |  ${phase(pair, now)}`, 'heading')];
  if (pair.adl?.incident) elements.push(label(`ADL 事件：${text(pair.adl.incident.symbols.join('、') || '合约待确认')} · ${ADL_STATUS[pair.adl.incident.status] ?? text(pair.adl.incident.status)}`, 'normal', 'red'));
  if (pair.adl?.shared) elements.push(label(text(pair.adl.shared, 120), 'normal', 'orange'));
  if (pair.blocked) elements.push(label(text(pair.blocked, 160), 'normal', 'orange'));
  else if (pair.enabled && pair.note && !pair.noteIdle) elements.push(label(text(pair.note, 160), 'normal', 'orange'));
  elements.push(accountCard(pair, 'long', now), accountCard(pair, 'short', now));
  const totals = pair.positions?.totals;
  if (!totals) elements.push(label('持仓  待同步', 'notation'));
  else if (!totals.length) elements.push(label('持仓  空仓', 'notation'));
  else for (const row of totals) {
    elements.push(label(`持仓${totals.length > 1 ? ` ${text(row.symbol, 24)}` : ''}  多 ${quantity(row.long)} / 空 ${quantity(row.short)}${row.balanced === false ? ` · 偏差 ${row.gapPercent}%` : ''}`, 'notation', row.balanced === false ? 'orange' : 'default'));
  }
  if (pair.current) {
    const { sourceSide, destinationSide, amount: value, asset, state } = pair.current;
    elements.push(label(`划转 ${SIDE[sourceSide]} → ${SIDE[destinationSide]}：${amount(value)} ${text(asset, 12)} · ${TRANSFER_STATE[state] ?? text(state, 20)}`, 'normal', state === 'unknown' ? 'orange' : 'default'));
  } else if (pair.enabled && pair.cooldownUntil > now) {
    elements.push(label(`划转冷却 ${Math.ceil((pair.cooldownUntil - now) / 1000)} 秒`, 'notation'));
  }
  return { urgent: urgent(pair), elements };
}

/** Sum of the unrealized PnL on every pair's two sides; null while a side has not been read. */
function totalPnl(pairs: SummaryPair[]): { value: string | null; stale: boolean } {
  let value = '0', stale = false;
  for (const pair of pairs) {
    if (!pair.positions) return { value: null, stale };
    for (const side of [pair.positions.long, pair.positions.short]) {
      if (side.state === 'pending' || side.state === 'unavailable') return { value: null, stale };
      if (side.state === 'retained') stale = true;
      try { value = add(value, ...side.positions.map(row => decimal(row.unrealizedProfit))); } catch { return { value: null, stale }; }
    }
  }
  return { value, stale };
}

/** The card (Feishu card JSON 2.0) for `input` at `now`. */
export function summaryCard(input: SummaryInput, now: number): Record<string, unknown> {
  const pnl = totalPnl(input.pairs);
  const sign = pnl.value === null ? 0 : cmp(pnl.value, '0');
  let elements: unknown[] = metric('实盘合计浮盈亏 · USD1', amount(pnl.value), 'heading-1', sign < 0 ? 'red' : sign > 0 ? 'green' : 'default');
  if (pnl.stale) elements.push(label('浮盈亏含未刷新快照', 'notation', 'orange'));
  const blocks = input.pairs.map(pair => pairBlock(pair, now)).sort((a, b) => Number(b.urgent) - Number(a.urgent));
  const connected = input.streams.filter(stream => stream.connected).length;
  const footer = [`推送 ${input.streams.length ? `已连接 ${connected} / ${input.streams.length}` : '未配置'}`, `API 近一分钟 ${input.budget.usedLastMinute} / ${input.budget.limitPerMinute}`];
  const day = new Date(now).toISOString().slice(0, 10);
  const tail: unknown[] = [{ tag: 'hr' }, label(footer.join(' · '), 'notation'), label(`金额 USD1 · UTC 日期 ${day} · 每 ${input.intervalMinutes} 分钟`, 'notation', 'grey')];
  const lastError = input.streams.find(stream => !stream.connected && stream.lastError)?.lastError;
  if (lastError) tail.splice(1, 0, label(`推送：${text(lastError, 120)}`, 'normal', 'orange'));
  if (input.budget.coolingUntil !== null && input.budget.coolingUntil > now) tail.splice(1, 0, label(`API 冷却等待 ${Math.ceil((input.budget.coolingUntil - now) / 1000)} 秒${input.budget.reason ? `：${text(input.budget.reason, 80)}` : ''}`, 'normal', 'orange'));
  const at = china(now);
  const card = {
    schema: '2.0', config: { summary: { content: 'ASTER 定时运行摘要' } },
    header: { template: 'turquoise', title: { tag: 'plain_text', content: 'ASTER 运行摘要' }, subtitle: { tag: 'plain_text', content: `${two(at.getUTCMonth() + 1)}-${two(at.getUTCDate())} ${two(at.getUTCHours())}:${two(at.getUTCMinutes())}:${two(at.getUTCSeconds())} UTC+8` } },
    body: { direction: 'vertical', padding: '16px', vertical_spacing: '12px', elements: [] as unknown[] },
  };
  let omitted = 0;
  for (const block of blocks) {
    const candidate = [...elements, { tag: 'hr' }, ...block.elements];
    card.body.elements = [...candidate, ...tail];
    if (Buffer.byteLength(JSON.stringify(card)) <= MAX_CARD_BYTES) elements = candidate; else omitted += 1;
  }
  if (omitted) elements.push(label(`另有 ${omitted} 个配对未展开，请在页面查看；异常优先。`, 'notation'));
  card.body.elements = [...elements, ...tail];
  return card;
}

export interface SummaryOptions {
  /** notify.sqlite: the schedule sits next to the alert outbox. */
  file: string;
  /** config.json's value: used until the page sets one. 0: off. */
  intervalMinutes: number;
  robot: { secret: FeishuSecret; kind: 'scheduled' | 'event' } | null;
  collect(): SummaryInput;
  now?: () => number;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  log?: (line: string) => void;
}

export const MAX_SUMMARY_MINUTES = 1_440;
const ROBOT_NAME = { scheduled: '定时机器人', event: '告警机器人' } as const;

export function createSummary({ file, intervalMinutes, robot, collect, now = Date.now, fetchImpl, log = line => process.stderr.write(`${line}\n`) }: SummaryOptions) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=2000;
    CREATE TABLE IF NOT EXISTS summary_schedule (id INTEGER PRIMARY KEY CHECK (id = 1), next_due_at INTEGER NOT NULL, interval_ms INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER, last_sent_at INTEGER, last_error TEXT, last_error_at INTEGER);`);
  // Added in v0.10.1, after the table: the page's interval (null: follow config.json), the robot the schedule was made
  // for and the one the last card went to. v0.10.0 names its columns and ignores these.
  const columns = new Set((db.prepare('PRAGMA table_info(summary_schedule)').all() as { name: string }[]).map(column => column.name));
  for (const [name, type] of [['page_interval_ms', 'INTEGER'], ['robot', 'TEXT'], ['last_sent_robot', 'TEXT']] as const) {
    if (!columns.has(name)) db.exec(`ALTER TABLE summary_schedule ADD COLUMN ${name} ${type}`);
  }
  const configInterval = intervalMinutes * 60_000;
  type Row = { nextDueAt: number; intervalMs: number; pageIntervalMs: number | null; attempts: number; retryAt: number | null; lastSentAt: number | null; lastSentRobot: 'scheduled' | 'event' | null; robot: string | null; lastError: string | null; lastErrorAt: number | null };
  const read = (): Row => db.prepare(`SELECT next_due_at AS nextDueAt, interval_ms AS intervalMs, page_interval_ms AS pageIntervalMs, attempts, retry_at AS retryAt,
    last_sent_at AS lastSentAt, last_sent_robot AS lastSentRobot, robot, last_error AS lastError, last_error_at AS lastErrorAt FROM summary_schedule WHERE id = 1`).get() as Row;
  const intervalOf = (row: Row): number => row.pageIntervalMs ?? configInterval;
  const first = (interval: number): number => Math.min(FIRST_SUMMARY_MS, interval);
  const startedAt = now();
  // The first minutes after a start (a clock set back before the start does not stretch them).
  const warming = (at: number, interval: number): boolean => at >= startedAt && at < startedAt + first(interval);
  // A fresh schedule sends its first card soon after start, and so does one whose robot changed (a card to the new group
  // instead of waiting a whole period); a changed interval starts over one interval from now.
  {
    const existing = db.prepare('SELECT 1 FROM summary_schedule WHERE id = 1').get();
    if (!existing) db.prepare('INSERT INTO summary_schedule (id, next_due_at, interval_ms, robot) VALUES (1, ?, ?, ?)').run(startedAt + first(configInterval), configInterval, robot?.kind ?? null);
    else {
      const row = read(), interval = intervalOf(row);
      // A new robot, or a schedule that was off, starts like a fresh one (also when the interval changed with it).
      const fresh = interval > 0 && ((robot !== null && row.robot !== robot.kind) || row.intervalMs <= 0);
      if (fresh || row.intervalMs !== interval) db.prepare('UPDATE summary_schedule SET next_due_at = ?, interval_ms = ?, attempts = 0, retry_at = NULL WHERE id = 1').run(startedAt + (fresh ? first(interval) : interval), interval);
      db.prepare('UPDATE summary_schedule SET robot = ? WHERE id = 1').run(robot?.kind ?? null);
    }
  }
  let sending = false;

  async function tick(): Promise<void> {
    if (!robot || sending) return;
    const at = now();
    const row = read();
    const interval = intervalOf(row);
    if (interval <= 0) return;
    // A clock that ran ahead and came back would push the next card out by the jump; start the grid over from now.
    if (row.nextDueAt - at > interval) { db.prepare('UPDATE summary_schedule SET next_due_at = ?, retry_at = NULL WHERE id = 1').run(at + interval); return; }
    // Right after a start the positions and balances are still being read: a period that fell due while the service was
    // down waits as long as a fresh schedule would, so the card on the way back carries numbers rather than 待同步.
    if (warming(at, interval) || at < row.nextDueAt || (row.retryAt !== null && at < row.retryAt)) return;
    // The period this send belongs to; the ones missed while the service was down are skipped.
    const periodAt = row.nextDueAt + Math.floor((at - row.nextDueAt) / interval) * interval;
    const boundary = periodAt + interval;
    // The schedule moves on only if the page did not change it while the card was on its way.
    const advance = (sql: string, ...values: (number | string | null)[]) =>
      db.prepare(`UPDATE summary_schedule SET ${sql} WHERE id = 1 AND next_due_at = ? AND interval_ms = ?`).run(...values, row.nextDueAt, row.intervalMs);
    sending = true;
    try {
      const input = collect();
      // A service that runs oil only has nothing for an ASTER card: the period passes without a post.
      if (!input.pairs.length) { advance('next_due_at = ?, attempts = 0, retry_at = NULL', boundary); return; }
      await sendFeishu(robot.secret, { msg_type: 'interactive', card: summaryCard({ ...input, intervalMinutes: interval / 60_000 }, at) }, { now, ...(fetchImpl ? { fetchImpl } : {}) });
      db.prepare('UPDATE summary_schedule SET last_sent_at = ?, last_sent_robot = ? WHERE id = 1').run(now(), robot.kind);
      advance('next_due_at = ?, attempts = 0, retry_at = NULL', boundary);
      log(`定时运行摘要已发送（${input.pairs.length} 个配对，${ROBOT_NAME[robot.kind]}）`);
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 200) : '未知错误';
      const attempts = row.attempts + 1;
      const giveUp = attempts >= TRIES;
      db.prepare('UPDATE summary_schedule SET last_error = ?, last_error_at = ? WHERE id = 1').run(reason, now());
      if (giveUp) advance('next_due_at = ?, attempts = 0, retry_at = NULL', boundary);
      else advance('attempts = ?, retry_at = ?', attempts, now() + RETRY_MS);
      log(`定时运行摘要发送失败（第 ${attempts} 次）：${reason}${giveUp ? '；本期不再重试，下期照常' : `；${RETRY_MS / 1000} 秒后重试`}`);
    } finally { sending = false; }
  }

  function status() {
    const row = read(), interval = intervalOf(row);
    const enabled = robot !== null && interval > 0;
    return {
      enabled, intervalMinutes: interval / 60_000, configIntervalMinutes: intervalMinutes, fromPage: row.pageIntervalMs !== null,
      robot: robot?.kind ?? null,
      nextDueAt: enabled ? Math.max(row.nextDueAt, row.retryAt ?? 0, warming(now(), interval) ? startedAt + first(interval) : 0) : null,
      lastSentAt: row.lastSentAt, lastSentRobot: row.lastSentRobot,
      lastError: row.lastError, lastErrorAt: row.lastErrorAt,
    };
  }

  return {
    tick,
    /** For the status and settings pages. */
    status,
    /** The page's interval, kept over config.json from now on; the next card comes one interval from now (0: off). */
    setInterval(minutes: number) {
      if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_SUMMARY_MINUTES) reject('summary_interval', `间隔须为 0–${MAX_SUMMARY_MINUTES} 的整数分钟（0 关闭）`);
      const interval = minutes * 60_000;
      db.prepare('UPDATE summary_schedule SET page_interval_ms = ?, interval_ms = ?, next_due_at = ?, attempts = 0, retry_at = NULL WHERE id = 1').run(interval, interval, now() + interval);
      log(`定时运行摘要间隔已在页面改为${minutes ? ` ${minutes} 分钟` : '关闭'}`);
      return status();
    },
    /** One card as soon as the loop next looks (within seconds); the periods then count from it. A card already on its
     * way or already due is that card: asking again does not add a second. */
    sendNow() {
      const row = read();
      if (!robot) reject('summary_no_robot', '未配置飞书机器人，无法发送');
      if (intervalOf(row) <= 0) reject('summary_off', '定时运行摘要已关闭，先设置间隔');
      if (sending || (row.nextDueAt <= now() && row.retryAt === null)) return status();
      db.prepare('UPDATE summary_schedule SET next_due_at = ?, attempts = 0, retry_at = NULL WHERE id = 1').run(now());
      return status();
    },
    close: (): void => db.close(),
  };
}
export type Summary = ReturnType<typeof createSummary>;
