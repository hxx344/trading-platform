// DEX 价差服务的本机套接字（docs/dexspread.md 第 11.2 节）：status、page（页面接口转发）、var-token（执行面推送 token）。
// 读完整个请求体才处理、才应答；不认识会话与只读令牌，鉴权都在执行面。
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { DEX_INPUT_LIMIT, DEX_INSTANCE_HEADER, DEX_OUTPUT_LIMIT, DEX_PAGE_PATH, DEX_PATH, DEX_PROTOCOL, DexError,
  type DexCrashView, type DexPageAnswer, type DexPageRequest, type DexStatus, type DexTokenPush } from './protocol.ts';

export interface DexHandlers {
  page(request: DexPageRequest): Promise<DexPageAnswer>;
  /** 收下推送；比已收到的旧时返回假（不生效）。 */
  token(push: DexTokenPush): boolean;
  /** 当前生效的 token 的摘要（租约过期或没收到时为 null）。 */
  tokenDigest(): string | null;
  crash(): DexCrashView | null;
  /** 实盘告警，由执行服务代发飞书。 */
  alerts?(): { key: string; text: string }[];
}

async function readInput(req: IncomingMessage): Promise<unknown> {
  const pieces: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > DEX_INPUT_LIMIT) throw new DexError('DEX 请求过大', 413);
    pieces.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(pieces, bytes).toString('utf8')); } catch { throw new DexError('DEX 请求格式无效', 400); }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.destroyed) return;
  const bytes = Buffer.from(JSON.stringify(value ?? null));
  if (bytes.length > DEX_OUTPUT_LIMIT) throw new DexError('DEX 应答过大');
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': bytes.length });
  res.end(bytes);
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function parsePageRequest(input: unknown): DexPageRequest {
  const value = record(input);
  const { method, path, query } = value;
  if ((method !== 'GET' && method !== 'POST') || typeof path !== 'string' || !DEX_PAGE_PATH.test(path) || path.includes('//')) throw new DexError('DEX 页面请求无效', 400);
  if (!Array.isArray(query) || query.length > 32 || !query.every(pair => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && typeof pair[1] === 'string')) throw new DexError('DEX 页面请求的参数无效', 400);
  return { method, path, query: query as [string, string][], ...(method === 'POST' ? { body: value.body ?? null } : {}) };
}

export function parseTokenPush(input: unknown): DexTokenPush {
  const { seq, token, problem } = record(input);
  if (!Number.isSafeInteger(seq) || (seq as number) < 0 || typeof token !== 'string' || token.length > 16 * 1024 || typeof problem !== 'string' || problem.length > 300) throw new DexError('token 推送格式无效', 400);
  return { seq: seq as number, token, problem };
}

export function createDexServer(handlers: DexHandlers, build: string) {
  const instance = randomUUID();
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  let loopReset = Date.now(), lastLoopMs: number | null = null;
  const processStatus = () => {
    // 一分钟一个窗口；读的是上一个完整窗口的 p99（刚启动时是当前窗口）。
    if (Date.now() - loopReset >= 60_000) { lastLoopMs = loop.count ? loop.percentile(99) / 1e6 : null; loop.reset(); loopReset = Date.now(); }
    const memory = process.memoryUsage();
    return { rss: memory.rss, heapUsed: memory.heapUsed, loopDelayMs: lastLoopMs ?? (loop.count ? loop.percentile(99) / 1e6 : null) };
  };
  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader(DEX_INSTANCE_HEADER, instance);
    if (req.method === 'GET' && req.url === DEX_PATH + 'status') {
      const status: DexStatus = { build, instance, protocol: DEX_PROTOCOL, process: processStatus(), crash: handlers.crash(), token: handlers.tokenDigest(), alerts: handlers.alerts?.() ?? [] };
      return json(res, 200, status);
    }
    const op = req.method === 'POST' && req.url?.startsWith(DEX_PATH) ? req.url.slice(DEX_PATH.length) : '';
    if (op !== 'page' && op !== 'var-token') return json(res, 404, { message: '未知 DEX 操作' });
    if (req.headers['content-type'] !== 'application/json') return json(res, 415, { message: 'DEX 请求需要 JSON' });
    if (Number(req.headers['content-length']) > DEX_INPUT_LIMIT) return json(res, 413, { message: 'DEX 请求过大' });
    const input = await readInput(req);
    if (op === 'var-token') {
      const push = parseTokenPush(input);
      const accepted = handlers.token(push);
      return json(res, 200, { accepted, token: handlers.tokenDigest() });
    }
    return json(res, 200, await handlers.page(parsePageRequest(input)));
  }
  const server = createServer((req, res) => {
    void handle(req, res).catch(error => {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) { res.destroy(); return; }
      const status = error?.status;
      const known = error instanceof DexError && Number.isInteger(status) && status >= 400 && status <= 599;
      if (!known) process.stderr.write(`DEX 请求处理失败：${error instanceof Error ? error.message.slice(0, 200) : '未知错误'}\n`);
      json(res, known ? status : 500, { message: known ? String(error.message).slice(0, 240) : 'DEX 价差服务内部错误' });
    });
  });
  // 回测最长约 2 分钟（执行面读超时 120 秒）。
  server.requestTimeout = 150_000;
  server.headersTimeout = 10_000;
  return { server, instance, close() { loop.disable(); server.close(); server.closeAllConnections(); } };
}
