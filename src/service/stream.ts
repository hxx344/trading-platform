// One ASTER user-data stream per sub-account, after the workbench's PrivateAccountStream
// (modules/aster/trading/user_stream.py): a signed listen key, a keepalive every 30 minutes, a planned reconnect before
// the 24-hour limit and a doubling back-off. Messages only speed up ADL evidence; the REST history scan stays the
// source of truth, so a stream that is down delays nothing but the push.
//
// Keepalive traffic: the first live run saw both sub-accounts' streams drop every ~6 minutes (only "连接出错"). A local
// reproduction (docs/live-results.md《用户推送断开的原因》) showed ASTER closing, with code 1006, any connection whose
// client has sent nothing for about 4–7 minutes; answering the venue's pings does not count. Node's built-in WebSocket
// cannot send ping frames, so every 30 seconds the stream asks the venue for its subscriptions (ASTER answers
// `{"id":n,"result":[…]}`); once the venue has answered, a connection that stays silent for 95 seconds is treated as
// dead and reopened. Every disconnect is logged with its close code, error text and how long it was up.
import { classify, type AsterClient, type AsterCredentials } from '../aster/client.ts';

export const STREAM_BASE = 'wss://fstream.asterdex.com/ws/';
const LISTEN_PATH = '/fapi/v3/listenKey';
const LISTEN_KEY = /^[A-Za-z0-9_-]{1,512}$/;
const EVENT_KIND = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
const KEEPALIVE_MS = 30 * 60_000;
const RECONNECT_MS = (23 * 60 + 50) * 60_000;
const OPEN_TIMEOUT_MS = 10_000;
const RETRY_INITIAL_MS = 500;
const RETRY_MAX_MS = 30_000;
const STABLE_MS = 30_000;
const MAX_MESSAGE = 64 * 1024;
const REST_TIMEOUT_MS = 8_000;
const HEARTBEAT_MS = 30_000;
const SILENT_MS = 95_000;
/** How long an error waits for the close that carries its code before the connection is ended anyway. */
const CLOSE_GRACE_MS = 3_000;

/** The parts of a WebSocket the stream uses, so tests can stand in for the venue. */
export interface SocketLike {
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'close', listener: (event: { code?: unknown; reason?: unknown }) => void): void;
  addEventListener(type: 'error', listener: (event: { message?: unknown }) => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  send(data: string): void;
  close(): void;
}

export interface StreamOptions {
  client: AsterClient;
  credentials: AsterCredentials;
  /** The account's address; pushes are tagged with it. */
  accountId: string;
  push(accountId: string, event: unknown): void;
  stopped(): boolean;
  pause(ms: number): Promise<void>;
  connect?: (url: string) => SocketLike;
  now?: () => number;
  log?: (line: string) => void;
  /** Connected, or disconnected with why (null after a clean end: shutdown or a planned renewal). */
  onState?: (connected: boolean, reason?: string | null) => void;
}

const mask = (id: string): string => `***${id.slice(-4)}`;
/** Venue text in a log line: printable, single line, bounded. */
const clip = (value: unknown, max: number): string => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max) : '';

export async function runUserStream({ client, credentials, accountId, push, stopped, pause, connect = url => new WebSocket(url) as unknown as SocketLike, now = Date.now, log = line => process.stderr.write(`${line}\n`), onState }: StreamOptions): Promise<void> {
  const call = async (method: 'POST' | 'PUT'): Promise<unknown> => {
    const reply = await client.signed(credentials, { method, path: LISTEN_PATH, params: {}, weight: 1, priority: 'normal', withUser: true }, { signal: AbortSignal.timeout(REST_TIMEOUT_MS) });
    const failure = classify(reply, new Set(), client.requestBudget, '用户推送密钥');
    if (failure) throw new Error(`用户推送密钥请求失败：${failure.message}`);
    return reply.data;
  };
  let retry = RETRY_INITIAL_MS;
  while (!stopped()) {
    const opened: { at: number | null } = { at: null };
    let reason: string | null = null;
    try {
      const answer = await call('POST') as { listenKey?: unknown } | null;
      const key = answer && typeof answer === 'object' ? answer.listenKey : undefined;
      if (typeof key !== 'string' || !LISTEN_KEY.test(key)) throw new Error('用户推送密钥格式无效');
      if (stopped()) return;
      await session(key, opened);
    } catch (error) {
      reason = error instanceof Error ? error.message.slice(0, 160) : '未知错误';
      log(`用户推送 ${mask(accountId)} 断开：${reason}`);
    }
    onState?.(false, reason);
    if (stopped()) return;
    if (opened.at !== null && now() - opened.at >= STABLE_MS) retry = RETRY_INITIAL_MS;
    await pause(retry);
    retry = Math.min(retry * 2, RETRY_MAX_MS);
  }

  /** One connection until it closes, fails or is due for renewal; records when it opened. */
  function session(key: string, opened: { at: number | null }): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = connect(STREAM_BASE + key);
      let openedAt: number | null = null, renewedAt = 0, ended = false;
      let lastInbound = 0, lastBeat = 0, beats = 0, answered = false, oddAnswer = false, errorText: string | null = null;
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error) => {
        if (ended) return;
        ended = true; clearInterval(timer); clearTimeout(openTimer); clearTimeout(graceTimer);
        try { socket.close(); } catch { /* already closed */ }
        if (error) reject(error); else resolve();
      };
      /** A disconnect we did not ask for, with what the venue said and how long the connection lasted. */
      const lost = (what: string, detail: string[] = []): Error => {
        const parts = [...detail, ...(openedAt === null ? [] : [`已连接 ${Math.round((now() - openedAt) / 1000)} 秒`])];
        return new Error(parts.length ? `${what}（${parts.join('，')}）` : what);
      };
      const openTimer = setTimeout(() => finish(new Error('连接超时')), OPEN_TIMEOUT_MS);
      let renewing = false;
      // Checks shutdown, keepalive, the heartbeat and the planned reconnect once a second.
      const timer = setInterval(() => {
        if (stopped()) return finish();
        if (openedAt === null) return;
        if (now() - openedAt >= RECONNECT_MS) return finish();
        // Only a venue that has answered a heartbeat is expected to keep answering; otherwise silence is normal.
        if (answered && now() - lastInbound >= SILENT_MS) return finish(lost('连接无响应', [`${Math.round((now() - lastInbound) / 1000)} 秒没有收到消息`]));
        if (now() - lastBeat >= HEARTBEAT_MS) {
          lastBeat = now(); beats += 1;
          try { socket.send(JSON.stringify({ method: 'LIST_SUBSCRIPTIONS', id: beats })); }
          catch { return finish(lost('保活发送失败')); }
        }
        if (renewing) return;
        if (now() - renewedAt >= KEEPALIVE_MS) {
          renewing = true;
          call('PUT').then(answer => {
            if (!answer || typeof answer !== 'object' || Object.keys(answer).length) throw new Error('续期应答无效');
            renewedAt = now();
          }).catch(error => finish(error instanceof Error ? error : new Error('续期失败'))).finally(() => { renewing = false; });
        }
      }, 1_000);
      socket.addEventListener('open', () => { clearTimeout(openTimer); opened.at = openedAt = renewedAt = lastInbound = lastBeat = now(); onState?.(true); });
      socket.addEventListener('close', ({ code, reason }) => {
        const detail = [...(typeof code === 'number' ? [`代码 ${code}${clip(reason, 60) ? ` ${clip(reason, 60)}` : ''}`] : []), ...(errorText ? [errorText] : [])];
        finish(lost(errorText !== null ? '连接出错' : '连接被关闭', detail));
      });
      // The error comes first; the close after it carries the code, so wait briefly for it.
      socket.addEventListener('error', ({ message }) => {
        if (ended || errorText !== null) return;
        errorText = clip(message, 80);
        graceTimer = setTimeout(() => finish(lost('连接出错', errorText ? [errorText] : [])), CLOSE_GRACE_MS);
      });
      socket.addEventListener('message', ({ data }) => {
        if (ended) return;
        if (typeof data !== 'string' || data.length > MAX_MESSAGE) return finish(new Error('推送消息无效'));
        let event: unknown;
        try { event = JSON.parse(data); } catch { return finish(new Error('推送消息不是 JSON')); }
        lastInbound = now();
        const record = event && typeof event === 'object' && !Array.isArray(event) ? event as Record<string, unknown> : null;
        // The answer to a heartbeat (a result or an error) only proves the connection is alive. Only the public streams
        // were seen answering; on a user stream an answer in another shape (no id, or an error object) is noted once and
        // never ends the connection, since the request was sent either way.
        if (record && record.e === undefined && ['id', 'result', 'error', 'code'].some(key => key in record)) {
          answered = true;
          if ((typeof record.id !== 'number' || 'error' in record || 'code' in record) && !oddAnswer) { oddAnswer = true; log(`用户推送 ${mask(accountId)} 保活应答格式不同：${clip(data, 120)}`); }
          return;
        }
        const kind = record ? record.e : undefined;
        if (typeof kind !== 'string' || !EVENT_KIND.test(kind)) return finish(new Error('推送消息类型无效'));
        if (kind === 'listenKeyExpired') return finish(new Error('推送密钥过期'));
        try { push(accountId, event); } catch (error) { log(`用户推送处理失败：${error instanceof Error ? error.message.slice(0, 160) : '未知错误'}`); }
      });
    });
  }
}

/** What the status page shows of each user stream: connected or not, since when, its last message and its last failure. */
export function createStreamStatus(accounts: readonly string[], now: () => number = Date.now) {
  const rows = new Map(accounts.map(accountId => [accountId, { connected: false, since: null as number | null, lastMessageAt: null as number | null, disconnects: 0, lastError: null as string | null, lastErrorAt: null as number | null }]));
  return {
    onState(accountId: string, connected: boolean, reason?: string | null): void {
      const row = rows.get(accountId);
      if (!row) return;
      if (connected) { row.connected = true; row.since = now(); return; }
      if (row.connected) row.disconnects += 1;
      row.connected = false; row.since = now();
      if (reason) { row.lastError = reason; row.lastErrorAt = now(); }
    },
    onMessage(accountId: string): void { const row = rows.get(accountId); if (row) row.lastMessageAt = now(); },
    view: () => [...rows].map(([accountId, row]) => ({ account: mask(accountId), ...row })),
  };
}
