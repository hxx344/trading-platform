import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { ContractError } from './contracts.ts';
import type { WebAsset } from './web-assets.ts';

export const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'",
};
// The built page loads its scripts and styles from /assets.
export const APP_HEADERS = {
  ...PAGE_HEADERS,
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};
export const ASSET_HEADERS = { 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin' };

/** Both authenticated static-file paths serve the same in-memory representations. */
export function sendWebAsset(response: ServerResponse, asset: WebAsset, acceptEncoding: string | undefined): void {
  const weights = new Map<string, number>();
  for (const part of (acceptEncoding ?? '').toLowerCase().split(',')) {
    const [name, ...parameters] = part.trim().split(';');
    const parameter = parameters.map(item => item.trim()).find(item => /^q\s*=/.test(item));
    const weight = parameter === undefined ? 1 : Number(parameter.slice(parameter.indexOf('=') + 1).trim());
    weights.set(name!.trim(), Number.isFinite(weight) && weight >= 0 && weight <= 1 ? weight : 0);
  }
  const wildcard = weights.get('*');
  const gzipWeight = weights.get('gzip') ?? wildcard ?? 0;
  const identityWeight = weights.get('identity');
  const compressed = gzipWeight > 0 && gzipWeight >= (identityWeight ?? 0) ? asset.gzip : undefined;
  if (!compressed && (identityWeight ?? (wildcard === 0 ? 0 : 1)) === 0) {
    response.writeHead(406, { 'cache-control': 'no-store', vary: 'Accept-Encoding' });
    response.end();
    return;
  }
  const body = compressed ?? asset.body;
  response.writeHead(200, { ...ASSET_HEADERS, vary: 'Accept-Encoding', 'content-type': asset.type, 'content-length': body.length,
    ...(compressed ? { 'content-encoding': 'gzip' } : {}) });
  response.end(body);
}
export const ASSET_PATH = /^\/assets\/([^/]{1,128})$/;
export const CONTROL_HEADER = 'x-trading-platform-control';
export const EXECUTION_HEADER = 'x-trading-platform-execution';
export const CLIENT_ADDRESS_HEADER = 'x-trading-platform-client-address';
export const CONFIG_CHECK_HEADER = 'x-trading-platform-config-check';
export const CONFIG_MATCH_HEADER = 'x-trading-platform-config-match';
export const LISTEN_HEADER = 'x-trading-platform-listen';
export const LEGACY_UPDATE_HEADER = 'x-trading-platform-legacy-update';

/** On the private socket these routes return a hand-off only after the executor's normal request checks. */
export function controlRoute(method: string | undefined, pathname: string): 'page' | 'asset' | 'update' | 'check' | 'apply' | null {
  if (method === 'GET') {
    if (pathname === '/') return 'page';
    if (ASSET_PATH.test(pathname)) return 'asset';
    if (pathname === '/api/update') return 'update';
  }
  if (method === 'POST') {
    if (pathname === '/api/update/check') return 'check';
    if (pathname === '/api/update/apply') return 'apply';
  }
  return null;
}

/** Instances on different ports of one host share the browser cookie jar, so the name carries the public port. */
export const sessionCookieName = (port: number): string => `pa_executor_session_${port}`;

export function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  sendJsonText(response, status, JSON.stringify(body), headers);
}

/** sendJson for a body already serialized. */
export function sendJsonText(response: ServerResponse, status: number, payload: string, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  response.end(payload);
}

export const MAX_LOGIN_BYTES = 4 * 1024;

export function boundedHttpServer(handler: RequestListener): Server {
  const server = createServer({ headersTimeout: 10_000, requestTimeout: 30_000, keepAliveTimeout: 5_000, connectionsCheckingInterval: 1_000 }, handler);
  server.maxConnections = 256;
  return server;
}

/** Deliver the short rejection before closing the socket, including clients that never finish their body. */
export function closeAfterResponse(response: ServerResponse): void {
  const socket = response.socket;
  response.setHeader('connection', 'close');
  response.once('finish', () => socket?.destroy());
}

export function readBody(request: IncomingMessage, maxBytes: number, tooLarge = '请求体过大'): Promise<Buffer> {
  if (Number(request.headers['content-length']) > maxBytes) return Promise.reject(new ContractError(413, 'body_too_large', tooLarge));
  return new Promise((resolve, reject) => {
    let count = 0;
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer) => {
      count += chunk.length;
      if (count <= maxBytes) { chunks.push(chunk); return; }
      request.off('data', onData);
      request.pause();
      reject(new ContractError(413, 'body_too_large', tooLarge));
    };
    request.on('data', onData);
    request.once('end', () => resolve(Buffer.concat(chunks)));
    request.once('error', reject);
    request.once('close', () => { if (!request.complete) reject(new ContractError(400, 'body_incomplete', '请求未完成')); });
  });
}

export async function readJson(request: IncomingMessage, maxBytes = 16 * 1024, tooLarge = '请求体过大'): Promise<unknown> {
  const body = await readBody(request, maxBytes, tooLarge);
  try { return JSON.parse(body.toString('utf8') || 'null'); }
  catch { throw new ContractError(400, 'invalid_json', '请求体不是有效 JSON'); }
}

export interface PublicListenOptions {
  port: number;
  listen?: { address: string; urlHost: string };
  listenRetry?: { firstMs: number; maxMs: number };
  log?: (line: string) => void;
  onListening?: (port: number) => void;
  onError: (error: Error) => void;
}

/** Both addresses feed one HTTP server. Failure of the optional address leaves loopback available while it retries. */
export function listenPublic(server: Server, { port, listen, listenRetry = { firstMs: 2_000, maxMs: 30_000 }, log = line => process.stderr.write(`${line}\n`), onListening, onError }: PublicListenOptions): () => void {
  const extra = listen ? createNetServer(socket => { server.emit('connection', socket); }) : null;
  if (extra) extra.maxConnections = server.maxConnections;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  server.on('error', error => {
    if (stopped) return;
    if (server.listening) { log(`HTTP 接受连接出错：${error.message}`); return; }
    onError(error);
  });
  server.listen(port, '127.0.0.1', () => {
    if (stopped) { server.close(); return; }
    const bound = (server.address() as AddressInfo).port;
    onListening?.(bound);
    if (stopped || !extra || !listen) return;
    let failures = 0, lastCode = '', delay = listenRetry.firstMs;
    const attempt = () => { if (!stopped && !extra.listening) extra.listen(bound, listen.address); };
    extra.on('error', (error: NodeJS.ErrnoException) => {
      if (stopped) return;
      const code = error.code ?? error.message;
      if (extra.listening) { log(`${listen.urlHost}:${bound} 接受连接出错：${code}`); return; }
      if (code !== lastCode) log(`监听 ${listen.urlHost}:${bound} 失败（${code}${code === 'EADDRNOTAVAIL' ? '：该地址不在本机，Tailscale 可能尚未连上' : ''}），持续重试（间隔最长 ${listenRetry.maxMs / 1000} 秒）；127.0.0.1:${bound} 照常可用`);
      lastCode = code; failures += 1;
      retry = setTimeout(attempt, delay).unref();
      delay = Math.min(delay * 2, listenRetry.maxMs);
    });
    extra.on('listening', () => {
      if (stopped) { extra.close(); return; }
      if (failures > 0) log(`已开始监听 ${listen.urlHost}:${bound}（重试 ${failures} 次后）`);
    });
    attempt();
  });
  return () => {
    stopped = true;
    clearTimeout(retry);
    server.close();
    extra?.close();
  };
}
