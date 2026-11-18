import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { FRAME_LIMIT, HEARTBEAT_MS, INPUT_LIMIT, INSTANCE_HEADER, MARKET_PATH, MarketError, OPERATION_NAME, OUTPUT_LIMIT, RPC_TIMEOUT_MS, type MarketOperations } from './protocol.ts';

async function readInput(req: IncomingMessage): Promise<unknown> {
  const pieces: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > INPUT_LIMIT) throw new MarketError('行情请求过大', 413);
    pieces.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(pieces, bytes).toString('utf8')); } catch { throw new MarketError('行情请求格式无效', 400); }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.destroyed) return;
  const bytes = Buffer.from(JSON.stringify(value ?? null));
  if (bytes.length > OUTPUT_LIMIT) throw new MarketError('行情结果过大');
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': bytes.length });
  res.end(bytes);
}

export function createMarketServer(groups: Readonly<Record<string, MarketOperations>>, build: string, { callTimeoutMs = RPC_TIMEOUT_MS, maxCalls = 128 } = {}) {
  const instance = randomUUID();
  const stopped = new AbortController();
  let calls = 0, streams = 0;
  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader(INSTANCE_HEADER, instance);
    if (req.method === 'GET' && req.url === MARKET_PATH + 'status') return json(res, 200, { build, instance, protocol: 1 });
    const match = /^\/market\/v1\/(call|stream)\/([^/?]+)$/.exec(req.url ?? '');
    if (req.method !== 'POST' || !match || !OPERATION_NAME.test(match[2])) return json(res, 404, { message: '未知行情操作' });
    if (req.headers['content-type'] !== 'application/json') return json(res, 415, { message: '行情请求需要 JSON' });
    if (Number(req.headers['content-length']) > INPUT_LIMIT) return json(res, 413, { message: '行情请求过大' });
    const streaming = match[1] === 'stream', op = match[2];
    const prefix = op.split('.', 1)[0];
    const group = Object.hasOwn(groups, prefix) ? groups[prefix] : undefined;
    if (!group && !(streaming && op === 'system.epoch')) return json(res, 404, { message: '未知行情操作' });
    if (streaming ? streams >= 128 : calls >= maxCalls) return json(res, 429, { message: '行情任务已满，请稍后再试' });
    const lifetime = new AbortController();
    const signal = AbortSignal.any([stopped.signal, lifetime.signal, ...(streaming ? [] : [AbortSignal.timeout(callTimeoutMs)])]);
    const finish = () => lifetime.abort();
    res.once('close', finish);
    if (streaming) streams++; else calls++;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      const input = await readInput(req);
      if (signal.aborted) return;
      if (!streaming) {
        // The socket lifetime is bounded even if an adapter is still unwinding an upstream request.
        let abort!: () => void;
        const disconnected = new Promise<never>((_, reject) => {
          abort = () => reject(new MarketError('行情读取已中止'));
          signal.addEventListener('abort', abort, { once: true });
        });
        try { json(res, 200, await Promise.race([group!.call(op, input, signal), disconnected])); }
        finally { signal.removeEventListener('abort', abort); }
        return;
      }
      let sequence = 0;
      const write = (bytes: string) => {
        if (signal.aborted) return;
        const size = Buffer.byteLength(bytes);
        if (size > FRAME_LIMIT + 1 || res.writableLength + size > OUTPUT_LIMIT) { res.destroy(); finish(); return; }
        res.write(bytes);
      };
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
      res.flushHeaders();
      heartbeat = setInterval(() => write('\n'), HEARTBEAT_MS);
      heartbeat.unref();
      // The owner may subscribe synchronously and register its cleanup on signal, or run an asynchronous feed.
      if (group) await group.stream(op, input, value => {
        if (signal.aborted) return;
        try { write(JSON.stringify([++sequence, value]) + '\n'); }
        catch { res.destroy(); finish(); }
      }, signal);
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    } finally {
      clearInterval(heartbeat); finish(); res.off('close', finish);
      if (streaming) streams--; else calls--;
    }
  }
  const server = createServer((req, res) => {
    void handle(req, res).catch(error => {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) { res.destroy(); return; }
      const status = error?.status;
      const known = Number.isInteger(status) && status >= 400 && status <= 599;
      json(res, known ? status : 503, { message: known ? String(error.message).slice(0, 240) : '公开行情暂不可用' });
    });
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  return { server, close() {
    if (stopped.signal.aborted) return;
    stopped.abort(); server.close(); server.closeAllConnections();
    for (const group of new Set(Object.values(groups))) group.close?.();
  } };
}
