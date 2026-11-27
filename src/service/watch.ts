// The heartbeat this service pushes to a second server's main-watch (docs/watch.md): every 30 seconds a signed POST
// saying whether the run loop is ready. The second server alerts through Feishu when the beats stop or say "not ready",
// so it needs no route into this server. The wire format is main-watch's (deploy/main-watch/main_watch.py): the body
// {sent_at, ready, detail} and its HMAC-SHA256 under the shared token; the token itself is never sent.
import { createHmac } from 'node:crypto';
import { exactKeys, exactSecretKeys } from '../contracts.ts';
import { anySignal } from '../any-signal.mjs';

export const WATCH_INTERVAL_MS = 30_000;
/** The first beat waits for the loops' first rounds, so a restart does not report itself as not ready. */
export const WATCH_FIRST_MS = 10_000;
const WATCH_TIMEOUT_MS = 10_000;
export const SIGNATURE_HEADER = 'X-Main-Watch-Signature';
const TOKEN = /^[A-Za-z0-9_-]{32,256}$/;
const MAX_URL = 300;
/** main-watch keeps this much of the reason. */
const MAX_DETAIL = 200;

export interface WatchConfig { url: string }
export interface WatchSecret { token: string }

/** config.json `watch`: { url } — the receiver's address, e.g. http://<second server>:8792/heartbeat. */
export function parseWatchConfig(raw: unknown): WatchConfig {
  const value = exactKeys(raw, ['url']);
  if (typeof value.url !== 'string' || value.url.length > MAX_URL) throw new Error('watch.url 须为副服务器心跳地址，如 http://<副服务器 IP>:8792/heartbeat');
  let parsed: URL;
  try { parsed = new URL(value.url); } catch { throw new Error('watch.url 须为副服务器心跳地址，如 http://<副服务器 IP>:8792/heartbeat'); }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname || parsed.username || parsed.password || parsed.hash) throw new Error('watch.url 须为 http(s) 地址，不能带账号或 # 片段');
  return { url: value.url };
}

/** secrets.json `watch`: { token } — the same value as the receiver's HEARTBEAT_TOKEN. Messages never quote it. */
export function parseWatchSecret(raw: unknown): WatchSecret {
  const value = exactSecretKeys(raw, ['token']);
  if (typeof value.token !== 'string' || !TOKEN.test(value.token)) throw new Error('watch.token 须为 32~256 位字母、数字、- 或 _（与副服务器的 HEARTBEAT_TOKEN 相同）');
  return { token: value.token };
}

export const watchSummary = (config: WatchConfig | undefined): string => config ? `，巡检心跳推送到 ${config.url}` : '';

/** `problem` null means ready; otherwise it is the reason the second server puts in its alert. */
export function heartbeatBody(sentAt: number, problem: string | null): string {
  return JSON.stringify({ sent_at: sentAt, ready: problem === null, detail: problem === null ? '' : Array.from(problem).slice(0, MAX_DETAIL).join('') });
}
export const heartbeatSignature = (token: string, body: string): string => createHmac('sha256', token).update(body, 'utf8').digest('hex');

export interface WatchStatus {
  url: string;
  lastOkAt: number | null;
  /** What the last delivered beat said. */
  lastReady: boolean | null;
  /** Pushes failed in a row. */
  failures: number;
  lastError: string | null;
  lastErrorAt: number | null;
}
export interface Watch { push(): Promise<void>; abort(): void; status(): WatchStatus }

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.name === 'TimeoutError') return `${WATCH_TIMEOUT_MS / 1000} 秒内没有应答`;
  const cause = (error as { cause?: { code?: unknown; message?: unknown } }).cause;
  const detail = typeof cause?.code === 'string' ? cause.code : typeof cause?.message === 'string' ? cause.message : '';
  return detail ? `${error.message}（${detail}）` : error.message;
}

/**
 * One push per call, never retried inside it: the next beat is the retry. A failure is logged when it starts and when
 * it ends, not every 30 seconds; the status page carries the rest.
 */
export function createWatch({ config, secret, problem, fetchImpl = fetch, now = Date.now, log }: {
  config: WatchConfig; secret: WatchSecret;
  /** Why the service is not ready, or null (runtime.ts notReady). */
  problem: () => string | null;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  log: (line: string) => void;
}): Watch {
  const state: WatchStatus = { url: config.url, lastOkAt: null, lastReady: null, failures: 0, lastError: null, lastErrorAt: null };
  const stop = new AbortController();
  let lastSent = 0;
  return {
    async push() {
      // The receiver refuses a beat that is not newer than the last one it took, so a clock step back must not repeat a stamp.
      const sentAt = lastSent = Math.max(now(), lastSent + 1);
      const reason = problem();
      const body = heartbeatBody(sentAt, reason);
      try {
        const response = await fetchImpl(config.url, {
          method: 'POST', body, redirect: 'manual', signal: anySignal([stop.signal], WATCH_TIMEOUT_MS),
          headers: { 'content-type': 'application/json; charset=utf-8', [SIGNATURE_HEADER]: heartbeatSignature(secret.token, body) },
        });
        await response.body?.cancel().catch(() => undefined);
        if (!response.ok) throw new Error(response.status === 403 ? 'HTTP 403：副服务器拒绝了心跳，请核对两端令牌是否一致、两台服务器的时钟是否准确' : `HTTP ${response.status}`);
        if (state.failures > 0) log(`巡检心跳已恢复送达（此前连续失败 ${state.failures} 次）`);
        state.failures = 0; state.lastOkAt = now(); state.lastReady = reason === null;
      } catch (error) {
        if (stop.signal.aborted) return;
        const text = describe(error).slice(0, 200);
        if (state.failures === 0) log(`巡检心跳推送失败：${text}；每 ${WATCH_INTERVAL_MS / 1000} 秒重试，恢复时再记一条（不影响划转与 ADL）`);
        state.failures += 1; state.lastError = text; state.lastErrorAt = now();
      }
    },
    abort() { stop.abort(); },
    status: () => ({ ...state }),
  };
}

/** Beats at a fixed cadence whatever a push takes: the receiver counts a beat stale after 90 seconds. */
export async function watchLoop(watch: Pick<Watch, 'push'>, context: { stopped(): boolean; pause(ms: number): Promise<void> }, { firstMs = WATCH_FIRST_MS, intervalMs = WATCH_INTERVAL_MS }: { firstMs?: number; intervalMs?: number } = {}): Promise<void> {
  await context.pause(firstMs);
  while (!context.stopped()) {
    const started = performance.now();
    await watch.push();
    if (context.stopped()) break;
    await context.pause(Math.max(1_000, intervalMs - (performance.now() - started)));
  }
}
