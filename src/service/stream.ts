// One ASTER user-data stream per sub-account, after the workbench's PrivateAccountStream
// (modules/aster/trading/user_stream.py): a signed listen key, a keepalive every 30 minutes, a planned reconnect before
// the 24-hour limit and a doubling back-off. Messages only speed up ADL evidence; the REST history scan stays the
// source of truth, so a stream that is down delays nothing but the push.
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

/** The parts of a WebSocket the stream uses, so tests can stand in for the venue. */
export interface SocketLike {
  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
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
  onState?: (connected: boolean) => void;
}

const mask = (id: string): string => `***${id.slice(-4)}`;

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
    try {
      const answer = await call('POST') as { listenKey?: unknown } | null;
      const key = answer && typeof answer === 'object' ? answer.listenKey : undefined;
      if (typeof key !== 'string' || !LISTEN_KEY.test(key)) throw new Error('用户推送密钥格式无效');
      if (stopped()) return;
      await session(key, opened);
    } catch (error) {
      log(`用户推送 ${mask(accountId)} 断开：${error instanceof Error ? error.message.slice(0, 160) : '未知错误'}`);
    }
    onState?.(false);
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
      const finish = (error?: Error) => {
        if (ended) return;
        ended = true; clearInterval(timer); clearTimeout(openTimer);
        try { socket.close(); } catch { /* already closed */ }
        if (error) reject(error); else resolve();
      };
      const openTimer = setTimeout(() => finish(new Error('连接超时')), OPEN_TIMEOUT_MS);
      let renewing = false;
      // Checks shutdown, keepalive and the planned reconnect once a second.
      const timer = setInterval(() => {
        if (stopped()) return finish();
        if (openedAt === null || renewing) return;
        if (now() - openedAt >= RECONNECT_MS) return finish(new Error('计划重连'));
        if (now() - renewedAt >= KEEPALIVE_MS) {
          renewing = true;
          call('PUT').then(answer => {
            if (!answer || typeof answer !== 'object' || Object.keys(answer).length) throw new Error('续期应答无效');
            renewedAt = now();
          }).catch(error => finish(error instanceof Error ? error : new Error('续期失败'))).finally(() => { renewing = false; });
        }
      }, 1_000);
      socket.addEventListener('open', () => { clearTimeout(openTimer); opened.at = openedAt = renewedAt = now(); onState?.(true); });
      socket.addEventListener('close', () => finish(openedAt === null ? new Error('连接被关闭') : undefined));
      socket.addEventListener('error', () => finish(new Error('连接出错')));
      socket.addEventListener('message', ({ data }) => {
        if (ended) return;
        if (typeof data !== 'string' || data.length > MAX_MESSAGE) return finish(new Error('推送消息无效'));
        let event: unknown;
        try { event = JSON.parse(data); } catch { return finish(new Error('推送消息不是 JSON')); }
        const kind = event && typeof event === 'object' && !Array.isArray(event) ? (event as { e?: unknown }).e : undefined;
        if (typeof kind !== 'string' || !EVENT_KIND.test(kind)) return finish(new Error('推送消息类型无效'));
        if (kind === 'listenKeyExpired') return finish(new Error('推送密钥过期'));
        try { push(accountId, event); } catch (error) { log(`用户推送处理失败：${error instanceof Error ? error.message.slice(0, 160) : '未知错误'}`); }
      });
    });
  }
}
