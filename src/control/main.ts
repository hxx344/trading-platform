// Public TCP listener. Only the execution process can authenticate a browser or accept a trading command.
import { createServer, request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readComponentBuild } from '../component-build.ts';
import { ContractError, exactKeys } from '../contracts.ts';
import { APP_HEADERS, ASSET_HEADERS, ASSET_PATH, CLIENT_ADDRESS_HEADER, CONTROL_HEADER, EXECUTION_HEADER, controlRoute, listenPublic, readJson, sendJson } from '../http-public.ts';
import { parseListenConfig, urlHost } from '../service/listen-config.ts';
import { createUpdates, readInstalledVersion, updateReadyFile, type UpdateFetch } from '../service/update.ts';
import { loadWebApp } from '../web-assets.ts';
import { PROBE_HEADER, probeResponse } from './probe.ts';

const CODE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

function loadRelease(root: string, controlBuild: string) {
  if (readComponentBuild(root, 'control') !== controlBuild) throw new Error('目标版本需要重新启动控制面');
  return { root, executionBuild: readComponentBuild(root, 'executor'), version: readInstalledVersion(root), app: loadWebApp(join(root, 'web', 'dist')) };
}

// Select the end-to-end headers used by the API, including password login, session cookies and compressed SSE.
// The Host is always the browser's value. Internal headers and client addresses are supplied by this process.
function engineHeaders(request: IncomingMessage, executionBuild: string, withBody: boolean): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = { host: request.headers.host ?? '', [EXECUTION_HEADER]: executionBuild };
  for (const name of ['cookie', 'origin', 'sec-fetch-site', 'x-pa-executor', 'content-type', 'accept', 'accept-encoding', 'last-event-id']) {
    const value = request.headers[name];
    if (value !== undefined) headers[name] = value;
  }
  if (withBody && request.headers['content-length'] !== undefined) headers['content-length'] = request.headers['content-length'];
  if (request.socket.remoteAddress) headers[CLIENT_ADDRESS_HEADER] = request.socket.remoteAddress;
  return headers;
}

function relay(upstream: IncomingMessage, response: ServerResponse, proof?: string): void {
  const headers = { ...upstream.headers };
  // The two connections have independent lifetimes and transfer framing.
  for (const token of (headers.connection ?? '').split(',')) delete headers[token.trim().toLowerCase()];
  for (const name of ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'trailer', CONTROL_HEADER, EXECUTION_HEADER, PROBE_HEADER]) delete headers[name];
  if (proof) headers[PROBE_HEADER] = proof;
  response.writeHead(upstream.statusCode ?? 502, headers);
  response.flushHeaders();
  upstream.on('error', () => response.destroy());
  upstream.pipe(response);
}

function failure(response: ServerResponse, error: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) { response.destroy(); return; }
  if (error instanceof ContractError) {
    sendJson(response, error.status, { code: error.code, message: error.message }, error.status === 413 ? { connection: 'close' } : {});
  } else {
    sendJson(response, 503, { code: 'control_unavailable', message: '控制面暂时无法提供服务' });
  }
}

export function createControl(options: {
  current: string; socketPath: string; importDir?: string; updateFetch?: UpdateFetch; log?: (line: string) => void;
}) {
  const log = options.log ?? (line => process.stderr.write(`${line}\n`));
  const controlBuild = readComponentBuild(CODE_ROOT, 'control');
  let active = loadRelease(realpathSync(options.current), controlBuild);
  let previousAssets: typeof active.app.assets | undefined;
  let failedRoot: string | undefined;
  const updates = createUpdates({ current: active.version, dir: options.importDir ?? null, readyFile: updateReadyFile(active.root),
    fetchImpl: options.updateFetch, log });

  function reload(): void {
    let root = options.current;
    try {
      root = realpathSync(options.current);
      if (root === active.root) { failedRoot = undefined; return; }
      if (root === failedRoot) return;
      const next = loadRelease(root, controlBuild);
      previousAssets = active.app.assets;
      active = next;
      updates.setCurrent(next.version);
      failedRoot = undefined;
      log(`页面已切换到 ${next.version.version}`);
    } catch (error) {
      if (failedRoot !== root) log(`页面切换未完成：${error instanceof Error ? error.message : String(error)}`);
      failedRoot = root;
    }
  }

  async function serveLocal(route: NonNullable<ReturnType<typeof controlRoute>>, pathname: string, request: IncomingMessage, response: ServerResponse, release: typeof active) {
    if (route === 'page') { response.writeHead(200, APP_HEADERS); response.end(release.app.index); return; }
    if (route === 'asset') {
      const name = ASSET_PATH.exec(pathname)![1]!;
      // An index already sent to the browser can ask for its hashed scripts just after a page-only switch.
      const asset = release.app.assets.get(name) ?? previousAssets?.get(name);
      if (!asset) { sendJson(response, 404, { code: 'not_found', message: '不存在' }); return; }
      response.writeHead(200, { ...ASSET_HEADERS, 'content-type': asset.type, 'content-length': asset.body.length });
      response.end(asset.body);
      return;
    }
    if (route === 'update') { sendJson(response, 200, updates.status()); return; }
    const body = await readJson(request);
    if (route === 'check') { exactKeys(body, []); sendJson(response, 200, await updates.check()); return; }
    sendJson(response, 200, updates.apply(body));
  }

  const server = createServer((request, response) => {
    const path = request.url ?? '/';
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
      request.resume(); sendJson(response, 400, { code: 'path', message: '请求路径无效' }); return;
    }
    const pathname = new URL(path, 'http://localhost').pathname;
    const route = controlRoute(request.method, pathname);
    const readiness = pathname === '/api/ready' && request.method === 'GET';
    const challenge = request.headers[PROBE_HEADER];
    const probe = readiness && request.socket.remoteAddress === '127.0.0.1'
      && typeof challenge === 'string' && /^[a-f0-9]{48}$/.test(challenge);
    // SIGHUP applies an install immediately. Checking the link at the page/update entry points also covers a lost signal.
    if (route || probe) reload();
    const release = active;
    // One upstream request, even if a write loses its response. The caller resolves it using its original request ID.
    const backend = httpRequest({ socketPath: options.socketPath, path, method: request.method, agent: false,
      headers: engineHeaders(request, release.executionBuild, route === null) }, upstream => {
      if (!route) {
        const matched = upstream.headers[EXECUTION_HEADER] === release.executionBuild;
        if (readiness && upstream.statusCode === 503 && !matched) {
          upstream.resume(); sendJson(response, 503, { ready: false }); return;
        }
        relay(upstream, response, probe && matched ? probeResponse(challenge, controlBuild, release.root, release.version) : undefined);
        return;
      }
      if (upstream.statusCode === 204 && upstream.headers[CONTROL_HEADER] === '1') {
        upstream.resume();
        void serveLocal(route, pathname, request, response, release).catch(error => failure(response, error));
      } else {
        request.resume();
        if ((upstream.statusCode ?? 500) >= 400) relay(upstream, response);
        else { upstream.resume(); failure(response, new Error('执行面协议不匹配')); }
      }
    });
    backend.setTimeout(route ? 10_000 : 180_000, () => backend.destroy(new Error('执行面应答超时')));
    backend.on('error', () => {
      request.resume();
      if (readiness && !response.headersSent && !response.destroyed) sendJson(response, 503, { ready: false });
      else failure(response, new ContractError(503, 'execution_unavailable', '暂时无法连接交易执行面，请重新读取状态'));
    });
    request.on('error', () => backend.destroy());
    response.on('close', () => backend.destroy());
    if (route) backend.end(); // Authorize the original method and path. Its JSON body stays here.
    else request.pipe(backend);
  });
  const poll = setInterval(() => { void updates.tick().catch(error => log(`检查新版本出错：${error instanceof Error ? error.message : String(error)}`)); }, 15_000);
  poll.unref();
  return { server, reload, close() { clearInterval(poll); updates.abort(); server.closeAllConnections(); } };
}

function main(): void {
  const { values } = parseArgs({ options: { current: { type: 'string' }, socket: { type: 'string' }, 'listen-file': { type: 'string' }, 'import-dir': { type: 'string' } } });
  if (!values.current || !values.socket || !values['listen-file'] || ![values.current, values.socket, values['listen-file'], ...(values['import-dir'] ? [values['import-dir']] : [])].every(isAbsolute)) {
    throw new Error('需要绝对路径 --current、--socket、--listen-file，可选 --import-dir');
  }
  const { port, host } = parseListenConfig(JSON.parse(readFileSync(values['listen-file'], 'utf8')));
  const control = createControl({ current: values.current, socketPath: values.socket, importDir: values['import-dir'] });
  const stopListen = listenPublic(control.server, { port, ...(host ? { listen: { address: host, urlHost: urlHost(host) } } : {}),
    onListening: port => process.stdout.write(`控制面已监听 127.0.0.1:${port}\n`),
    onError: error => { process.stderr.write(`控制面监听失败：${error.message}\n`); process.exitCode = 1; stop(); } });
  function stop(): void { stopListen(); control.close(); }
  process.on('SIGHUP', control.reload);
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

if (import.meta.main) {
  try { main(); } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
