import { once, EventEmitter } from 'node:events';
import { request, type IncomingMessage } from 'node:http';
import { setTimeout as pause } from 'node:timers/promises';
import { FRAME_LIMIT, INPUT_LIMIT, INSTANCE_HEADER, MARKET_PATH, MarketError, OPERATION_NAME, OUTPUT_LIMIT, RPC_TIMEOUT_MS, STREAM_TIMEOUT_MS } from './protocol.ts';
import { anySignal } from '../any-signal.mjs';

export type { MarketOperations } from './protocol.ts';
export { MarketError } from './protocol.ts';
export interface MarketClient {
  /** Opaque connection lifetime. Even a reconnect to the same process invalidates previously captured evidence. */
  epoch(): string | null;
  call<T>(op: string, input: unknown, signal?: AbortSignal): Promise<T>;
  stream(op: string, input: unknown, callbacks: { data(value: unknown): void; down(): void }): () => void;
}

function encode(op: string, value: unknown): Buffer {
  if (!OPERATION_NAME.test(op)) throw new MarketError('未知行情操作', 400);
  const body = Buffer.from(JSON.stringify(value ?? null));
  if (body.length > INPUT_LIMIT) throw new MarketError('行情请求过大', 413);
  return body;
}

function open(socketPath: string, path: string, body: Buffer | null, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: body ? 'POST' : 'GET', signal, agent: false,
      headers: body ? { host: 'localhost', 'content-type': 'application/json', 'content-length': body.length } : { host: 'localhost' } }, resolve);
    req.on('error', reject);
    req.setTimeout(path.startsWith(MARKET_PATH + 'call/') ? RPC_TIMEOUT_MS : STREAM_TIMEOUT_MS, () => req.destroy(new MarketError('行情服务连接超时')));
    req.end(body);
  });
}

async function payload(res: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of res) {
    bytes += chunk.length;
    if (bytes > OUTPUT_LIMIT) throw new MarketError('行情服务应答过大');
    chunks.push(chunk);
  }
  if (!res.complete) throw new MarketError('行情服务应答不完整');
  const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (res.statusCode !== 200) throw new MarketError(typeof result?.message === 'string' ? result.message.slice(0, 240) : '行情请求失败', res.statusCode ?? 503);
  return result;
}

function instanceOf(res: IncomingMessage): string {
  const value = res.headers[INSTANCE_HEADER];
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value)) { res.destroy(); throw new MarketError('行情服务身份应答无效'); }
  return value;
}

async function frames(res: IncomingMessage, data: (value: unknown) => void): Promise<void> {
  res.setTimeout(STREAM_TIMEOUT_MS, () => res.destroy(new MarketError('行情流心跳超时')));
  let pieces: Buffer[] = [], bytes = 0, sequence = 0;
  for await (const chunk of res) {
    const block: Buffer = chunk;
    let start = 0;
    while (start < block.length) {
      const end = block.indexOf(10, start);
      const part = block.subarray(start, end < 0 ? block.length : end);
      bytes += part.length;
      if (bytes > FRAME_LIMIT) throw new MarketError('行情帧过大');
      if (part.length) pieces.push(part);
      if (end < 0) break;
      if (bytes) {
        const frame: unknown = JSON.parse(Buffer.concat(pieces, bytes).toString('utf8'));
        if (!Array.isArray(frame) || frame.length !== 2 || frame[0] !== ++sequence) throw new MarketError('行情帧序号不连续');
        data(frame[1]);
      }
      pieces = []; bytes = 0; start = end + 1;
    }
  }
}

export async function marketHealth(socketPath: string): Promise<unknown> {
  return payload(await open(socketPath, MARKET_PATH + 'status', null, AbortSignal.timeout(2500)));
}

function raceAbort(signals: readonly (AbortSignal | undefined)[], timeoutMs?: number): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const cleanups: (() => void)[] = [];
  const abort = (reason?: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  for (const sig of signals) {
    if (!sig) continue;
    if (sig.aborted) {
      while (cleanups.length) cleanups.pop()!();
      abort(sig.reason);
      return { signal: controller.signal, dispose: () => {} };
    }
    const onAbort = () => abort(sig.reason);
    sig.addEventListener('abort', onAbort, { once: true });
    cleanups.push(() => sig.removeEventListener('abort', onAbort));
  }
  if (timeoutMs !== undefined) {
    const timer = setTimeout(() => abort(new DOMException('The operation timed out', 'TimeoutError')), timeoutMs);
    timer.unref?.();
    cleanups.push(() => clearTimeout(timer));
  }
  return {
    signal: controller.signal,
    dispose() { while (cleanups.length) cleanups.pop()!(); },
  };
}

export function createMarketClient(socketPath: string): MarketClient & { close(): void } {
  const stopped = new AbortController();
  const changes = new EventEmitter();
  changes.setMaxListeners(0);
  let generation = 0;
  let active: { instance: string; key: string; life: AbortController } | null = null;

  async function follow(signal: AbortSignal, connect: () => Promise<void>, down: () => void) {
    let delay = 200;
    while (!signal.aborted) {
      const start = performance.now();
      try { await connect(); } catch { /* disconnect, service restart or an incomplete frame */ }
      try { down(); } catch (error) { process.stderr.write(`行情断开处理失败：${error instanceof Error ? error.message.slice(0, 180) : '未知错误'}\n`); }
      if (signal.aborted) break;
      if (performance.now() - start >= STREAM_TIMEOUT_MS) delay = 200;
      await pause(delay, undefined, { signal, ref: false }).catch(() => undefined);
      delay = Math.min(delay * 2, 3000);
    }
  }
  const monitor = async () => {
    const res = await open(socketPath, MARKET_PATH + 'stream/system.epoch', encode('system.epoch', null), stopped.signal);
    try {
      if (res.statusCode !== 200) throw new MarketError('行情服务未就绪');
      const instance = instanceOf(res);
      active = { instance, key: `${instance}/${++generation}`, life: new AbortController() };
      changes.emit('connected');
      await frames(res, () => {});
    } finally { res.destroy(); }
  };
  const disconnect = () => { const lost = active; active = null; lost?.life.abort(); };
  void follow(stopped.signal, monitor, disconnect);
  async function connection(signal: AbortSignal) {
    signal.throwIfAborted();
    if (!active) await once(changes, 'connected', { signal });
    if (!active || stopped.signal.aborted) throw new MarketError('行情服务暂不可用');
    return active;
  }
  return {
    epoch: () => active?.key ?? null,
    async call<T>(op: string, input: unknown, signal?: AbortSignal): Promise<T> {
      const body = encode(op, input);
      const deadlineCtrl = raceAbort([stopped.signal, signal], RPC_TIMEOUT_MS);
      const deadline = deadlineCtrl.signal;
      try {
        try {
          const waitLease = raceAbort([deadline], 1500);
          const lease = await connection(waitLease.signal).finally(() => waitLease.dispose());
          const callAbort = raceAbort([deadline, lease.life.signal]);
          try {
            const res = await open(socketPath, MARKET_PATH + 'call/' + op, body, callAbort.signal);
            // Historical backfill can legitimately take longer than a stream heartbeat to produce the first byte.
            res.setTimeout(0);
            if (instanceOf(res) !== lease.instance) { res.destroy(); throw new MarketError('行情服务已切换'); }
            const result = await payload(res);
            if (lease !== active || deadline.aborted) throw new MarketError('行情服务应答已过期');
            return result as T;
          } finally { callAbort.dispose(); }
        } finally { deadlineCtrl.dispose(); }
      } catch (error) {
        if (deadline.aborted && deadline.reason?.name === 'TimeoutError') throw new DOMException('公开行情请求超时', 'TimeoutError');
        if (signal?.aborted) throw new DOMException('公开行情请求已中止', 'AbortError');
        if (error instanceof MarketError) throw error;
        throw new MarketError('行情服务暂不可用');
      }
    },
    stream(op, input, callbacks) {
      const body = encode(op, input), local = new AbortController();
      const signal = anySignal([local.signal, stopped.signal]);
      let online = false;
      const offline = () => { if (online) { online = false; callbacks.down(); } };
      void follow(signal, async () => {
        const lease = await connection(signal);
        const res = await open(socketPath, MARKET_PATH + 'stream/' + op, body, anySignal([signal, lease.life.signal]));
        try {
          if (res.statusCode !== 200 || instanceOf(res) !== lease.instance || active !== lease) throw new MarketError('行情订阅未就绪');
          online = true;
          await frames(res, value => { if (active === lease && !signal.aborted) callbacks.data(value); });
        } finally { res.destroy(); }
      }, offline);
      return () => { local.abort(); };
    },
    close() { stopped.abort(); disconnect(); },
  };
}
