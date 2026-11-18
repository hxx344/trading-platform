import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { ContractError } from './contracts.ts';

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
export const ASSET_PATH = /^\/assets\/([^/]{1,128})$/;
export const CONTROL_HEADER = 'x-trading-platform-control';
export const EXECUTION_HEADER = 'x-trading-platform-execution';
export const CLIENT_ADDRESS_HEADER = 'x-trading-platform-client-address';

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
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  response.end(payload);
}

export function readJson(request: IncomingMessage, maxBytes = 16 * 1024, tooLarge = '请求体过大'): Promise<unknown> {
  return new Promise((resolve, fail) => {
    let size = 0; const chunks: Buffer[] = [];
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size <= maxBytes) { chunks.push(chunk); return; }
      // Drain instead of destroying so the client still receives the 413; the connection closes after it.
      request.off('data', onData); request.resume();
      fail(new ContractError(413, 'body_too_large', tooLarge));
    };
    request.on('data', onData);
    request.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch { fail(new ContractError(400, 'invalid_json', '请求体不是有效 JSON')); } });
    request.on('error', fail);
  });
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
