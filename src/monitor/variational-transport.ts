// Monitor M-3d: the requests to omni.variational.io go through scripts/variational-request.py (Python standard library), as
// in the workbench. Copied from project_aggregation modules/monitor/server/variational-transport.mjs at 8470785. Changed: typed;
// the helper is found relative to this file and runs as `python3 -I -B`; the platform switch (Windows) is left out.
// The request is checked against the same fixed allowlist the helper checks again; the token only travels on the helper's
// stdin, and nothing the helper prints except its JSON answer is read (stderr is counted, never kept).
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VARIATIONAL_ORIGIN, VARIATIONAL_USER_AGENT, type VariationalFetcher } from '../vendor/variational-market.mjs';

export const VARIATIONAL_HELPER = fileURLToPath(new URL('../../scripts/variational-request.py', import.meta.url));
const ORIGIN = VARIATIONAL_ORIGIN;
const PATHS = new Map([
  ['/api/me', 'GET'],
  ['/api/quotes/indicative', 'POST'],
  ['/api/funding/v2?underlying=BZ&instrument_type=perpetual_rwa_future', 'GET'],
  ['/api/funding/v2?underlying=CL&instrument_type=perpetual_rwa_future', 'GET'],
]);
const HEADER_NAMES = new Set(['accept', 'user-agent', 'cache-control', 'referer', 'content-type', 'cookie']);
const RESPONSE_HEADERS = new Set(['content-type', 'x-omni-auth', 'cf-mitigated']);
const MAX_BODY_BYTES = 2_000_000, MAX_STDOUT_BYTES = 3_000_000, MAX_STDERR_BYTES = 16_384;
const fail = (message = 'Variational 标准行情传输暂不可用，请稍后重试。', code = 'VARIATIONAL_TRANSPORT_FAILURE', name = 'Error') => Object.assign(new Error(message), { code, name });
const invalid = () => fail('不支持的 Variational 数据请求。', 'VARIATIONAL_REQUEST_INVALID');
const timeoutError = () => fail('Variational 数据请求超时，请稍后重试。', 'VARIATIONAL_TIMEOUT', 'TimeoutError');
const abortError = (signal: AbortSignal) => signal.reason?.name === 'TimeoutError' ? timeoutError() : fail('Variational 数据请求已取消。', 'VARIATIONAL_ABORTED', 'AbortError');
const plainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const sameKeys = (value: unknown, names: string[]): value is Record<string, unknown> => plainObject(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const jwtCookie = (value: string | null): boolean => typeof value === 'string' && value.length <= 8201 && /^vr-token=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);

/**
 * The only instruments an indicative quote may name, rebuilt field by field (scripts/variational-request.py checks again):
 * the oil pair as before (M-3d), and since v0.82.0 the three shapes the Var/Lighter module quotes (docs/varlighter.md 第 3 节).
 */
const UNDERLYING = /^[A-Z0-9]{1,16}$/;
function indicativeInstrument(definition: unknown): Record<string, string | number> {
  if (!plainObject(definition) || typeof definition.underlying !== 'string' || !UNDERLYING.test(definition.underlying) || definition.settlement_asset !== 'USDC') throw invalid();
  if (definition.instrument_type === 'perpetual_rwa_future' && sameKeys(definition, ['underlying', 'instrument_type', 'settlement_asset', 'kind']) && (definition.kind === 'commodity' || definition.kind === 'equity')) {
    return { underlying: definition.underlying, instrument_type: 'perpetual_rwa_future', settlement_asset: 'USDC', kind: definition.kind };
  }
  if (definition.instrument_type === 'perpetual_future' && sameKeys(definition, ['underlying', 'instrument_type', 'settlement_asset', 'funding_interval_s']) && definition.funding_interval_s === 3600) {
    return { underlying: definition.underlying, instrument_type: 'perpetual_future', settlement_asset: 'USDC', funding_interval_s: 3600 };
  }
  throw invalid();
}
/** A positive decimal with at most 12 integer and 8 fraction digits. */
function indicativeQty(qty: unknown): string {
  if (typeof qty !== 'string' || !/^(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/.test(qty) || !/[1-9]/.test(qty)) throw invalid();
  return qty;
}

function requestPayload(input: string, init: RequestInit): string {
  try {
    const url = new URL(input), path = url.pathname + url.search, method = PATHS.get(path);
    if (url.origin !== ORIGIN || url.username || url.password || url.hash || !method || (init.method !== undefined && String(init.method).toUpperCase() !== method)) throw invalid();
    if (init.redirect !== undefined && init.redirect !== 'error') throw invalid();
    const incoming = new Headers(init.headers);
    for (const [name, value] of incoming) {
      if (!HEADER_NAMES.has(name) || !/^[\x20-\x7e]*$/.test(value) || value.length > (name === 'cookie' ? 8201 : 1024)) throw invalid();
    }
    for (const [name, expected] of [['accept', 'application/json'], ['content-type', 'application/json'], ['cache-control', 'no-cache'], ['referer', `${ORIGIN}/`]] as const) {
      if (incoming.has(name) && incoming.get(name) !== expected) throw invalid();
    }
    const cookie = incoming.get('cookie');
    const authenticated = path === '/api/me' || path === '/api/quotes/indicative';
    if (authenticated ? !jwtCookie(cookie) : cookie !== null) throw invalid();
    const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': VARIATIONAL_USER_AGENT, 'Cache-Control': 'no-cache', Referer: `${ORIGIN}/` };
    if (cookie !== null) headers.Cookie = cookie;
    let body: unknown = null;
    if (method === 'POST') {
      if (typeof init.body !== 'string' || Buffer.byteLength(init.body) > 16_384) throw invalid();
      const submitted: unknown = JSON.parse(init.body);
      if (!sameKeys(submitted, ['instrument', 'qty'])) throw invalid();
      body = { instrument: indicativeInstrument(submitted.instrument), qty: indicativeQty(submitted.qty) };
      headers['Content-Type'] = 'application/json';
    } else if (init.body !== undefined && init.body !== null) throw invalid();
    return JSON.stringify({ url: `${ORIGIN}${path}`, method, headers, body });
  } catch { throw invalid(); }
}

function responseFromOutput(output: string): Response {
  try {
    const value: unknown = JSON.parse(output);
    if (!sameKeys(value, ['status', 'headers', 'body']) || !Number.isInteger(value.status) || (value.status as number) < 200 || (value.status as number) > 599 || !plainObject(value.headers) || typeof value.body !== 'string' || value.body.length > Math.ceil(MAX_BODY_BYTES / 3) * 4) throw fail();
    const headers: Record<string, string> = {};
    for (const [name, item] of Object.entries(value.headers)) {
      if (!RESPONSE_HEADERS.has(name) || typeof item !== 'string' || item.length > 1024 || !/^[\x20-\x7e]*$/.test(item)) throw fail();
      headers[name] = item;
    }
    const body = Buffer.from(value.body, 'base64');
    if (body.length > MAX_BODY_BYTES || body.toString('base64') !== value.body) throw fail();
    return new Response(body.length ? body : null, { status: value.status as number, headers });
  } catch { throw fail(); }
}

export type SpawnImpl = (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;

/** The fetch-shaped transport; `spawnImpl` and `helper` are for the tests, production uses python3 and the shipped helper. */
export function createVariationalFetch({ spawnImpl = spawn as unknown as SpawnImpl, helper = VARIATIONAL_HELPER, timeoutMs = 10_000 }: { spawnImpl?: SpawnImpl; helper?: string; timeoutMs?: number } = {}): VariationalFetcher {
  const duration = Number.isFinite(timeoutMs) ? Math.min(10_000, Math.max(1, timeoutMs)) : 10_000;
  return async function fetchVariational(input: string, init: RequestInit = {}): Promise<Response> {
    if (typeof input !== 'string') throw invalid();
    const payload = requestPayload(input, init), signal = init.signal;
    if (signal !== undefined && signal !== null && !(signal instanceof AbortSignal)) throw invalid();
    if (signal?.aborted) throw abortError(signal);
    return new Promise<Response>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams | undefined, timer: NodeJS.Timeout | undefined, settled = false, stdoutSize = 0, stderrSize = 0;
      const chunks: Buffer[] = [];
      const finish = (error: Error | undefined, response?: Response, kill = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (kill) { try { child?.kill('SIGKILL'); } catch { /* Error details may contain caller input. */ } }
        child?.stdin?.destroy();
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        if (error) reject(error); else resolve(response!);
      };
      const onAbort = () => finish(abortError(signal!), undefined, true);
      const processError = (error: unknown) => finish((error as { code?: string } | null)?.code === 'ENOENT'
        ? fail('Variational 行情传输需要 Python 3，当前服务未找到运行环境；请重新运行一键部署或安装 Python 3。', 'VARIATIONAL_PYTHON_MISSING')
        : fail(), undefined, true);
      try {
        // As the asset ledger's Var helper: only PATH, so no service secret or proxy setting reaches the child.
        const env: NodeJS.ProcessEnv = {};
        if (process.env.PATH) env.PATH = process.env.PATH;
        child = spawnImpl('python3', ['-I', '-B', helper], { shell: false, windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
        child.once('error', processError);
        child.stdin.on('error', () => finish(fail(), undefined, true));
        child.stdout.on('error', () => finish(fail(), undefined, true));
        child.stderr.on('error', () => finish(fail(), undefined, true));
        child.stdout.on('data', (chunk: Buffer | string) => {
          if (settled) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          stdoutSize += buffer.length;
          if (stdoutSize > MAX_STDOUT_BYTES) { finish(fail(), undefined, true); return; }
          chunks.push(buffer);
        });
        child.stderr.on('data', (chunk: Buffer | string) => {
          if (settled) return;
          stderrSize += Buffer.byteLength(chunk);
          if (stderrSize > MAX_STDERR_BYTES) finish(fail(), undefined, true);
        });
        child.once('close', (code: number | null) => {
          if (settled) return;
          if (code !== 0) { finish(code === 3 ? timeoutError() : fail()); return; }
          try { finish(undefined, responseFromOutput(Buffer.concat(chunks).toString('utf8'))); }
          catch { finish(fail()); }
        });
        timer = setTimeout(() => finish(timeoutError(), undefined, true), duration);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) { onAbort(); return; }
        child.stdin.end(payload);
      } catch (error) { processError(error); }
    });
  };
}
