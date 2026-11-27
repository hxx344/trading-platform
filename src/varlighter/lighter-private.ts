// Lighter（主网、RH）私有订单 WebSocket（account_all_orders）：主路径实时接收成交通知，减少查单等待；
// 断线、鉴权失效或超时无结果时无缝回退到 orders.ts 的 REST 查单（docs/dexspread.md 第 19 节）。
// 严格脱敏：任何错误文案、日志与视图状态均不带 auth token、私钥与账户索引（L207）；不使用 AbortSignal.any（L206）。
import { LIGHTER_ENDPOINTS, type Connect, type SocketLike } from './feeds.ts';
import type { LighterSigner } from './lighter-signer.ts';
import { AUTH_RENEW_MS, AUTH_TTL_SEC, lighterFinal, scrub, type OrderOutcome } from './orders.ts';

export type LighterPrivateVenue = 'lighter' | 'rh';

export interface LighterPrivateStatus {
  venue: LighterPrivateVenue;
  connected: boolean;
  subscribed: boolean;
  connectedAt: number | null;
  lastMessageAt: number | null;
  reconnects: number;
  wsHits: number;
  restFallbacks: number;
  lastError: string | null;
}

export interface PrivateOrderEvent {
  clientId: number;
  outcome: Extract<OrderOutcome, { kind: 'done' }> & { confirmAt: number; confirmSource: 'ws' };
  confirmAt: number;
}

export interface LighterOrderWaiter {
  cancel(): void;
  wait(waitMs: number, signalFor: () => AbortSignal): Promise<PrivateOrderEvent | null>;
}

export interface LighterPrivateOptions {
  venue: LighterPrivateVenue;
  accountIndex: number;
  connect: Connect;
  signer: () => Promise<LighterSigner>;
  now?: () => number;
  url?: string;
  log?: (line: string) => void;
}

const PING_MS = 25_000;
const SILENCE_MS = 60_000;
const CONNECT_TIMEOUT_MS = 15_000;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const RECENT_MAX = 200;

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const numberOf = (value: unknown): number | null => {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(number) ? number : null;
};

export function lighterPrivateUrl(venue: LighterPrivateVenue): string {
  const url = new URL(LIGHTER_ENDPOINTS[venue].stream);
  url.searchParams.delete('readonly');
  return url.toString();
}

interface PendingWait {
  clientId: number;
  event: PrivateOrderEvent | null;
  wake: (() => void) | null;
  settled: boolean;
}

export class LighterPrivateStream {
  private socket: SocketLike | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private attempt = 0;
  private connectingAt: number | null = null;
  private lastPingAt: number | null = null;
  private subscribedAt: number | null = null;
  private auth: { token: string; at: number } | null = null;
  private authPromise: Promise<string> | null = null;
  private readonly recent = new Map<number, PrivateOrderEvent>();
  private readonly waiters = new Map<number, PendingWait>();
  private state: Omit<LighterPrivateStatus, 'venue'> = {
    connected: false,
    subscribed: false,
    connectedAt: null,
    lastMessageAt: null,
    reconnects: 0,
    wsHits: 0,
    restFallbacks: 0,
    lastError: null,
  };

  private readonly options: LighterPrivateOptions;
  constructor(options: LighterPrivateOptions) {
    this.options = options;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  get venue(): LighterPrivateVenue {
    return this.options.venue;
  }

  isSubscribed(): boolean {
    return !this.closed && this.state.connected && this.state.subscribed;
  }

  status(): LighterPrivateStatus {
    return { venue: this.options.venue, ...this.state };
  }

  noteRestFallback(): void {
    this.state.restFallbacks++;
  }

  getRecent(clientId: number): PrivateOrderEvent | null {
    return this.recent.get(clientId) ?? null;
  }

  start(): void {
    if (this.socket || this.closed) return;
    let socket: SocketLike;
    try {
      socket = this.options.connect(this.options.url ?? lighterPrivateUrl(this.options.venue));
    } catch (error) {
      this.failConnect(error);
      return;
    }
    this.socket = socket;
    this.connectingAt = this.now();
    this.state.subscribed = false;
    socket.onopen = () => {
      if (this.socket !== socket || this.closed) return;
      const time = this.now();
      this.state.connected = true;
      this.state.connectedAt = time;
      this.state.lastMessageAt = time;
      this.attempt = 0;
      void this.subscribeSocket(socket);
    };
    socket.onmessage = event => {
      if (this.socket !== socket || this.closed) return;
      try {
        this.receive(event.data);
      } catch (error) {
        this.state.lastError = this.cleanError(error);
      }
    };
    socket.onerror = event => {
      if (this.socket !== socket || this.closed) return;
      const raw = isRecord(event) && typeof event.message === 'string' ? event.message : 'WebSocket 错误';
      this.state.lastError = this.cleanText(raw);
    };
    socket.onclose = () => {
      if (this.socket === socket) this.drop('连接关闭');
    };
    this.tickTimer = setInterval(() => this.tick(), 1_000);
    this.tickTimer.unref?.();
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.drop(null);
    this.auth = null;
  }

  /** 发单前提前登记 waiter，避免 sendTx HTTP 往返期间推送已到但错过事件。 */
  prepareWait(clientId: number): LighterOrderWaiter {
    const pre = this.recent.get(clientId) ?? null;
    const entry: PendingWait = { clientId, event: pre, wake: null, settled: pre !== null };
    if (!pre) this.waiters.set(clientId, entry);

    const cancel = () => {
      entry.settled = true;
      if (this.waiters.get(clientId) === entry) this.waiters.delete(clientId);
      const wake = entry.wake;
      entry.wake = null;
      wake?.();
    };

    const wait = async (waitMs: number, signalFor: () => AbortSignal): Promise<PrivateOrderEvent | null> => {
      const early = entry.event ?? this.recent.get(clientId);
      if (early) {
        cancel();
        this.state.wsHits++;
        return early;
      }
      if (!this.isSubscribed() || waitMs <= 0 || this.closed) {
        cancel();
        return null;
      }
      let hit: PrivateOrderEvent | null = null;
      try {
        const signal = signalFor();
        if (signal.aborted) return null;
        await new Promise<void>(resolve => {
          let done = false;
          let timer: ReturnType<typeof setTimeout> | null = null;
          const finish = () => {
            if (done) return;
            done = true;
            if (timer) {
              clearTimeout(timer);
              timer = null;
            }
            signal.removeEventListener('abort', finish);
            entry.wake = null;
            resolve();
          };
          entry.wake = finish;
          signal.addEventListener('abort', finish, { once: true });
          timer = setTimeout(finish, waitMs);
          timer.unref?.();
          // 注册瞬间可能已被回调唤醒，立即再核对一遍。
          if (entry.event || entry.settled || !this.isSubscribed() || signal.aborted) finish();
        });
        hit = entry.event ?? this.recent.get(clientId) ?? null;
      } finally {
        cancel();
      }
      if (hit) {
        this.state.wsHits++;
        return hit;
      }
      return null;
    };

    return { cancel, wait };
  }

  private maskSecrets(text: string): string {
    let masked = text;
    if (this.auth?.token) masked = masked.replaceAll(this.auth.token, '…');
    const accountText = String(this.options.accountIndex);
    if (accountText.length >= 3) masked = masked.replace(new RegExp(`\\b${accountText}\\b`, 'g'), '…');
    return masked;
  }

  private cleanText(text: string): string {
    return scrub(this.maskSecrets(text));
  }

  private cleanError(error: unknown): string {
    return this.cleanText(error instanceof Error ? error.message : String(error));
  }

  private async getToken(forceRefresh = false): Promise<string> {
    const time = this.now();
    if (!forceRefresh && this.auth && time - this.auth.at < AUTH_RENEW_MS) return this.auth.token;
    if (this.authPromise) return this.authPromise;
    const job = (async () => {
      const token = (await this.options.signer()).createAuthToken(Math.floor(this.now() / 1000) + AUTH_TTL_SEC);
      if (!this.closed) this.auth = { token, at: this.now() };
      return token;
    })();
    this.authPromise = job;
    try {
      return await job;
    } finally {
      if (this.authPromise === job) this.authPromise = null;
    }
  }

  private async subscribeSocket(socket: SocketLike, forceRefresh = false): Promise<void> {
    try {
      const token = !forceRefresh && this.auth && this.now() - this.auth.at < AUTH_RENEW_MS
        ? this.auth.token
        : await this.getToken(forceRefresh);
      if (this.socket !== socket || this.closed || socket.readyState !== 1) return;
      this.subscribedAt = this.now();
      socket.send(JSON.stringify({
        type: 'subscribe',
        channel: `account_all_orders/${this.options.accountIndex}`,
        auth: token,
      }));
    } catch (error) {
      if (this.socket === socket && !this.closed) {
        const text = `私有流订阅失败：${this.cleanError(error)}`;
        this.state.lastError = text;
        this.options.log?.(`varlighter: ${text}`);
        this.drop(text);
      }
    }
  }

  private send(payload: unknown): void {
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(payload));
  }

  private tick(): void {
    if (this.closed) return;
    const time = this.now();
    if (this.state.connected && this.state.lastMessageAt !== null && time - this.state.lastMessageAt > SILENCE_MS) {
      this.drop('长时间没有消息');
      return;
    }
    if (!this.state.connected && this.socket && this.connectingAt !== null && time - this.connectingAt > CONNECT_TIMEOUT_MS) {
      this.drop('连接超时');
      return;
    }
    if (this.state.connected && time - (this.lastPingAt ?? 0) >= PING_MS) {
      this.lastPingAt = time;
      this.send({ type: 'ping' });
    }
    if (this.state.connected && this.state.subscribed && this.subscribedAt !== null && time - this.subscribedAt >= AUTH_RENEW_MS) {
      this.state.subscribed = false;
      this.subscribedAt = time;
      const socket = this.socket;
      if (socket) {
        this.send({ type: 'unsubscribe', channel: `account_all_orders/${this.options.accountIndex}` });
        void this.subscribeSocket(socket, true);
      }
    }
  }

  private receive(data: unknown): void {
    if (typeof data !== 'string') return;
    const time = this.now();
    this.state.lastMessageAt = time;
    const parsed = JSON.parse(data) as unknown;
    if (!isRecord(parsed)) return;
    const type = parsed.type;
    if (type === 'ping') {
      this.send({ type: 'pong' });
      return;
    }
    if (type === 'pong' || type === 'connected') return;
    if (type === 'error' || parsed.error !== undefined) {
      const masked = this.maskSecrets(JSON.stringify(parsed));
      this.state.lastError = scrub(masked);
      if (/auth|token|unauthoriz|expired|forbidden/i.test(masked)) {
        this.auth = null;
        this.state.subscribed = false;
        this.drop('私有流鉴权失败，准备重连');
      }
      return;
    }
    if (type === 'subscribed/account_all_orders' || type === 'update/account_all_orders') {
      const channel = typeof parsed.channel === 'string' ? parsed.channel : '';
      if (channel && !channel.startsWith('account_all_orders')) return;
      if (type === 'subscribed/account_all_orders') {
        this.state.subscribed = true;
        this.subscribedAt ??= time;
        this.state.lastError = null;
      }
      const rawOrders = parsed.orders;
      const groups = Array.isArray(rawOrders) ? [rawOrders] : isRecord(rawOrders) ? Object.values(rawOrders) : [];
      for (const group of groups) {
        if (!Array.isArray(group)) continue;
        for (const row of group) {
          if (!isRecord(row) || !lighterFinal(row.status)) continue;
          const clientId = numberOf(row.client_order_index);
          const filled = numberOf(row.filled_base_amount);
          const quote = numberOf(row.filled_quote_amount);
          if (clientId === null || !Number.isSafeInteger(clientId) || clientId <= 0) continue;
          if (filled === null || filled < 0) continue;
          const event: PrivateOrderEvent = {
            clientId,
            confirmAt: time,
            outcome: {
              kind: 'done',
              filledQty: filled,
              avgPrice: filled > 0 && quote !== null && quote > 0 ? quote / filled : null,
              note: row.status === 'filled' ? '已成交' : `交易所撤销：${scrub(row.status)}`,
              confirmAt: time,
              confirmSource: 'ws',
            },
          };
          this.recordRecent(event);
          const waiter = this.waiters.get(clientId);
          if (waiter) {
            waiter.event = event;
            waiter.settled = true;
            this.waiters.delete(clientId);
            const wake = waiter.wake;
            waiter.wake = null;
            wake?.();
          }
        }
      }
    }
  }

  private recordRecent(event: PrivateOrderEvent): void {
    if (this.recent.has(event.clientId)) this.recent.delete(event.clientId);
    this.recent.set(event.clientId, event);
    while (this.recent.size > RECENT_MAX) {
      const oldest = this.recent.keys().next().value;
      if (oldest === undefined) break;
      this.recent.delete(oldest);
    }
  }

  private drop(reason: string | null): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      try {
        socket.close();
      } catch {
        /* 已关闭 */
      }
    }
    this.state.connected = false;
    this.state.subscribed = false;
    this.connectingAt = null;
    this.subscribedAt = null;
    if (reason) {
      this.state.lastError = this.cleanText(reason);
      this.state.reconnects++;
    }
    // 断线时立刻唤醒在等 WS 的下单线程，转入快速 REST 查单而不空等超时。
    for (const waiter of this.waiters.values()) {
      const wake = waiter.wake;
      waiter.wake = null;
      wake?.();
    }
    if (!this.closed) this.scheduleReconnect();
  }

  private failConnect(error: unknown): void {
    this.state.lastError = this.cleanError(error);
    this.state.reconnects++;
    if (!this.closed) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.retryTimer || this.closed) return;
    const delay = Math.min(RETRY_MIN_MS * 2 ** Math.min(this.attempt++, 10), RETRY_MAX_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.start();
    }, delay);
    this.retryTimer.unref?.();
  }
}
