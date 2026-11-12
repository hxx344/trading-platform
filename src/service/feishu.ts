// Feishu alerts for the ASTER service. The notifier reads the executor's event log by sequence number and turns the
// events that need a person into messages; the messages wait in an outbox of their own database (notify.sqlite), so a
// slow or failing robot never touches the executor's database or holds up a transfer or an ADL pass. Delivery is at
// least once: the cursor and the queued messages move in one transaction, and a send whose answer is lost is retried.
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { FeishuSecret } from './config.ts';
import { HEDGE_TOLERANCE_BPS } from '../adl-contracts.ts';

const SEND_TIMEOUT_MS = 10_000;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;
const RETENTION_MS = 7 * 24 * 3_600_000;
const EVENTS_PER_POLL = 500;
/** Messages joined into one robot post; the robot allows a few posts per second at most. */
const LINES_PER_POST = 10;
const MAX_TEXT = 1_500;
/** Repeats of one ongoing problem are posted at most this often. */
const REPEAT_MS = 30 * 60_000;
/** A switched-on pair that cannot balance for this long is reported. */
export const STUCK_AFTER_MS = 10 * 60_000;

export interface EventRow { seq: number; type: string; at: number; json: string }
export interface PairState { id: string; enabled: boolean; blocked: string | null; note: string | null }
export interface NotifierOptions {
  file: string;
  /** Reads events after a sequence number, oldest first. */
  events(after: number, limit: number): EventRow[];
  latestSeq(): number;
  pairs(): PairState[];
  /** The pair an ADL incident belongs to, or null when it cannot be read. */
  incidentPair(id: string): string | null;
  feishu: FeishuSecret | null;
  now?: () => number;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  log?: (line: string) => void;
}

const short = (value: unknown): string => typeof value === 'string' ? value.slice(0, 8) : '?';
const clip = (value: unknown, length = 300): string => (typeof value === 'string' ? value : JSON.stringify(value ?? '')).slice(0, length);
/** Residuals left by a completed ADL incident (inside the 0.5 % tolerance or below one lot): they are not hedged, so they are listed. */
const residualNote = (value: unknown): string => {
  if (!Array.isArray(value) || value.length === 0) return '';
  const items = value.slice(0, 5).map(item => {
    const row = (item ?? {}) as Record<string, unknown>;
    return `${clip(row.symbol, 64)} 多出${row.direction === 'long' ? '多' : row.direction === 'short' ? '空' : '?'}仓 ${clip(row.quantity, 32)}`;
  });
  return `剩余残差（偏差在 ${HEDGE_TOLERANCE_BPS / 100}% 容差内或不足一手，记为完成）：${items.join('、')}${value.length > 5 ? ` 等 ${value.length} 个合约` : ''}`;
};
const SETTLE_TEXT: Record<string, string> = {
  late_receipt_confirmed: '核对流水后确认已执行', nonce_expired_no_receipt: '请求过期且两侧流水都没有，确认未执行',
  nonce_expired_partial_receipt: '只在一侧流水找到记录，结果存疑', nonce_expired_ambiguous_receipt: '流水中有多条可能对应的记录，结果存疑',
  nonce_expired_unreadable: '流水无法完整读取，结果存疑', identity_changed: '配对账户已更换，按存疑处理',
};

/** A message for the event, with a key that suppresses repeats of an ongoing problem, or null for routine events. */
export function describeEvent(row: EventRow, incidentPair: (id: string) => string | null): { text: string; repeatKey?: string } | null {
  let detail: Record<string, unknown>;
  try { detail = JSON.parse(row.json) as Record<string, unknown>; } catch { detail = {}; }
  const pair = typeof detail.pair === 'string' ? detail.pair : typeof detail.incident === 'string' ? incidentPair(detail.incident) ?? '?' : '?';
  switch (row.type) {
    case 'transfer-sent':
      if (detail.state === 'unknown') return { text: `【划转结果未知】配对 ${pair} 划转 ${short(detail.transfer)} 结果未知，不会重发；原请求过期后核对两侧流水自动结算，期间该配对暂停划转` };
      if (detail.state === 'rejected') return { text: `【划转被拒】配对 ${pair} 划转 ${short(detail.transfer)} 被交易所拒绝`, repeatKey: `rejected:${pair}` };
      return null;
    case 'transfer-recovered':
      return detail.state === 'unknown' ? { text: `【划转结果未知】配对 ${pair} 划转 ${short(detail.transfer)} 在上次停止时正在发送，结果未知，不会重发；原请求过期后核对两侧流水自动结算` } : null;
    case 'transfer-settled':
      if (detail.basis === 'acknowledged' || typeof detail.basis !== 'string') return null;
      return { text: `【未知划转已结算】配对 ${pair} 划转 ${short(detail.transfer)}：${SETTLE_TEXT[detail.basis] ?? detail.basis}${detail.basis.includes('partial') || detail.basis.includes('ambiguous') || detail.basis.includes('unreadable') ? '，请人工核对两侧余额' : ''}` };
    case 'transfer-settle-failed':
      return { text: `【划转结算失败】配对 ${pair} 划转 ${short(detail.transfer)} 已连续 ${clip(detail.failures, 8)} 次无法结算：${clip(detail.reason)}`, repeatKey: `settle:${clip(detail.transfer, 64)}` };
    case 'transfer-tick-failed':
      return { text: `【划转循环出错】${clip(detail.reason)}`, repeatKey: `transfer-tick:${clip(detail.reason, 80)}` };
    case 'transfer-pair-switched':
      return { text: `【配对${detail.enabled ? '已启用' : '已停用'}】配对 ${pair}${detail.enabled ? '：本平台开始负责保证金平衡与 ADL 应急处理' : '：划转与新的 ADL 检测都已停止（未结束的 ADL 事件仍会处理完）；停用期间发生的 ADL 不会被处理'}` };
    case 'adl-incident-opened':
      return { text: `【ADL】配对 ${pair} 检测到两侧不一致：${Array.isArray(detail.symbols) ? detail.symbols.map(String).join('、') : '?'}，开始处理（事件 ${short(detail.incident)}）` };
    case 'adl-incident-blocked':
      return { text: `【ADL 受阻】配对 ${pair}：${clip(detail.reason)}`, repeatKey: `adl-blocked:${clip(detail.incident, 64)}` };
    case 'adl-incident-halted':
      return { text: `【ADL 已暂停，需人工处理】配对 ${pair}：${clip(detail.reason)}；处理后在页面重新开始` };
    case 'adl-incident-completed':
      return { text: `【ADL 已平衡】配对 ${pair} 事件 ${short(detail.incident)} ${residualNote(detail.residuals) || '两侧已一致'}${Number(detail.unknown) > 0 ? `；有 ${clip(detail.unknown, 8)} 笔减仓单结果未知，进入观察期` : ''}` };
    case 'adl-incident-restarted':
      return { text: `【ADL 重新开始】配对 ${pair} 事件 ${short(detail.incident)} 已由人工重新开始` };
    case 'adl-batch-stuck':
    case 'adl-batch-verified-unknown':
      return { text: `【ADL 减仓单结果未知】配对 ${pair} 批次 ${short(detail.batch)}，不会重发；按新现场继续核对`, repeatKey: `batch:${clip(detail.batch, 64)}` };
    case 'adl-pair-failed':
      return { text: `【ADL 读取失败】配对 ${pair}：${clip(detail.reason)}`, repeatKey: `adl-pair:${pair}:${clip(detail.reason, 80)}` };
    case 'adl-tick-failed':
      return { text: `【ADL 循环出错】${clip(detail.reason)}`, repeatKey: `adl-tick:${clip(detail.reason, 80)}` };
    case 'adl-push-dropped':
      return { text: `【ADL 推送丢弃】${Number(detail.overflow) > 0 ? `用户推送积压，丢弃 ${clip(detail.overflow, 8)} 条` : ''}${Number(detail.overflow) > 0 && Number(detail.invalid) > 0 ? '；' : ''}${Number(detail.invalid) > 0 ? `${clip(detail.invalid, 8)} 条 ADL 成交推送格式无效` : ''}；改由历史扫描补齐`, repeatKey: 'push-dropped' };
    default:
      return null;
  }
}

/** Feishu custom robot signature: base64 HMAC-SHA256 keyed by "timestamp\nsecret" over an empty message. */
export const feishuSign = (timestampSeconds: number, secret: string): string => createHmac('sha256', `${timestampSeconds}\n${secret}`).update('').digest('base64');

export function createNotifier({ file, events, latestSeq, pairs, incidentPair, feishu, now = Date.now, fetchImpl = (url, init) => fetch(url, init), log = line => process.stderr.write(`${line}\n`) }: NotifierOptions) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=2000;
    CREATE TABLE IF NOT EXISTS cursor (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, text TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, sent_at INTEGER, last_error TEXT);
    CREATE INDEX IF NOT EXISTS outbox_due ON outbox(sent_at, next_at);
    CREATE TABLE IF NOT EXISTS repeats (key TEXT PRIMARY KEY, at INTEGER NOT NULL);`);
  // A fresh outbox starts at the current end of the log: history from before the notifier existed is not replayed.
  if (!db.prepare('SELECT 1 FROM cursor').get()) db.prepare('INSERT INTO cursor(id, seq) VALUES (1, ?)').run(latestSeq());
  const tx = <T>(operation: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const insert = (text: string, at: number): void => {
    log(`告警：${text}`);
    if (feishu) db.prepare('INSERT INTO outbox(created_at, text, next_at) VALUES (?, ?, ?)').run(at, text.slice(0, MAX_TEXT), at);
  };
  /** False when the same ongoing problem was already posted within REPEAT_MS. */
  const fresh = (key: string, at: number): boolean => {
    const last = db.prepare('SELECT at FROM repeats WHERE key = ?').get(key) as { at: number } | undefined;
    if (last && at - last.at < REPEAT_MS) return false;
    db.prepare('INSERT INTO repeats(key, at) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET at = excluded.at').run(key, at);
    return true;
  };
  /** In memory: since when each switched-on pair has been unable to balance, and whether that was reported. */
  const stuck = new Map<string, { since: number; reported: boolean }>();

  function poll(): void {
    const at = now();
    for (;;) {
      const after = (db.prepare('SELECT seq FROM cursor WHERE id = 1').get() as { seq: number }).seq;
      const rows = events(after, EVENTS_PER_POLL);
      if (!rows.length) break;
      tx(() => {
        for (const row of rows) {
          const message = describeEvent(row, incidentPair);
          if (message && (!message.repeatKey || fresh(message.repeatKey, at))) insert(message.text, at);
        }
        db.prepare('UPDATE cursor SET seq = ? WHERE id = 1').run(rows.at(-1)!.seq);
      });
      if (rows.length < EVENTS_PER_POLL) break;
    }
    const seen = new Set<string>();
    for (const pair of pairs()) {
      if (!pair.enabled) continue;
      seen.add(pair.id);
      const problem = pair.blocked ?? pair.note;
      const entry = stuck.get(pair.id);
      if (!problem) {
        if (entry?.reported) tx(() => insert(`【保证金平衡恢复】配对 ${pair.id} 已恢复正常划转检查`, at));
        stuck.delete(pair.id);
        continue;
      }
      if (!entry) { stuck.set(pair.id, { since: at, reported: false }); continue; }
      if (!entry.reported && at - entry.since >= STUCK_AFTER_MS) {
        entry.reported = true;
        tx(() => insert(`【保证金平衡受阻】配对 ${pair.id} 已持续 ${Math.round((at - entry.since) / 60_000)} 分钟无法划转：${clip(problem)}`, at));
      }
    }
    for (const id of [...stuck.keys()]) if (!seen.has(id)) stuck.delete(id);
  }

  /** Queues a message that does not come from the event log (start, stop, lost lease). */
  function notify(text: string): void { tx(() => insert(text, now())); }

  async function post(text: string): Promise<void> {
    if (!feishu) return;
    const timestamp = Math.floor(now() / 1000);
    const body = { ...(feishu.secret ? { timestamp: String(timestamp), sign: feishuSign(timestamp, feishu.secret) } : {}), msg_type: 'text', content: { text } };
    const response = await fetchImpl(feishu.webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
    let answer: { code?: unknown; StatusCode?: unknown; msg?: unknown } = {};
    try { answer = await response.json() as typeof answer; } catch { /* judged by status below */ }
    const code = answer.code ?? answer.StatusCode;
    if (!response.ok || (code !== undefined && code !== 0)) throw new Error(`飞书返回 HTTP ${response.status}${code !== undefined ? ` code ${String(code).slice(0, 12)}` : ''}${typeof answer.msg === 'string' ? ` ${answer.msg.slice(0, 80)}` : ''}`);
  }

  let sending = false;
  /** Sends what is due, oldest first, several messages per post; a failure backs off the whole batch. */
  async function flush(): Promise<void> {
    if (!feishu || sending) return;
    sending = true;
    try {
      const at = now();
      db.prepare('DELETE FROM outbox WHERE created_at < ?').run(at - RETENTION_MS);
      db.prepare('DELETE FROM repeats WHERE at < ?').run(at - RETENTION_MS);
      const due = db.prepare('SELECT id, text, attempts FROM outbox WHERE sent_at IS NULL AND next_at <= ? ORDER BY id LIMIT ?').all(at, LINES_PER_POST) as { id: number; text: string; attempts: number }[];
      if (!due.length) return;
      const ids = due.map(row => row.id);
      try {
        await post(due.map(row => row.text).join('\n'));
        tx(() => { for (const id of ids) db.prepare('UPDATE outbox SET sent_at = ?, last_error = NULL WHERE id = ?').run(now(), id); });
      } catch (error) {
        const reason = error instanceof Error ? error.message.slice(0, 200) : '未知错误';
        log(`飞书发送失败：${reason}`);
        tx(() => { for (const row of due) db.prepare('UPDATE outbox SET attempts = attempts + 1, next_at = ?, last_error = ? WHERE id = ?').run(now() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** row.attempts), reason, row.id); });
      }
    } finally { sending = false; }
  }

  return {
    poll, notify, flush,
    pending: (): number => (db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE sent_at IS NULL').get() as { n: number }).n,
    close: (): void => db.close(),
  };
}
export type Notifier = ReturnType<typeof createNotifier>;
