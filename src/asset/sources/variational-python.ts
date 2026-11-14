// Copied from project_aggregation modules/asset/lib/variational-python-client.ts at 0014655, balance reading only.
// Changes: only the 'sync-portfolio' operation is kept (diagnostics and positions are not ported); the zod schema is
// replaced by an equivalent hand-written strict check (the server has no runtime dependencies); the helper is
// scripts/variational-balance.py, located relative to this file rather than the working directory (the service runs
// from /opt/trading-platform/current); the child environment keeps only PATH. The 23 s deadline, the 8192-byte output
// limit, SIGTERM then SIGKILL after 250 ms, stdin-only credentials and the result checks are unchanged.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hasValidVariationalBalance, validateVariationalCredential, VARIATIONAL_ERRORS } from './variational-shared.ts';
import type { VariationalCredential } from './variational-shared.ts';

export type VariationalPythonOperation = 'sync-portfolio';
export type VariationalOutcome = 'ok' | 'challenge' | 'unauthorized' | 'forbidden' | 'rate_limited' | 'redirect' | 'html' | 'invalid_data' | 'timeout' | 'network_error' | 'cancelled' | 'client_unavailable' | 'client_error';
export type VariationalPythonResult = {
  endpoint: 'portfolio'; path: string; status: number | null; contentType: 'json' | 'html' | 'other' | 'missing' | null;
  challenge: boolean; elapsedMs: number; structureOk: boolean | null; outcome: VariationalOutcome;
};
type PythonResult = { result: VariationalPythonResult; balance: number | string | null };
const TARGETS = { 'sync-portfolio': { endpoint: 'portfolio', path: '/api/portfolio?compute_margin=true' } } as const;
const MAX_OUTPUT_BYTES = 8192;
const DEADLINE_MS = 23_000;
/** Absolute path of the helper, shipped next to src/ in the release package (deploy/package.sh). */
export const VARIATIONAL_HELPER = fileURLToPath(new URL('../../../scripts/variational-balance.py', import.meta.url));

const ENDPOINTS = new Set(['session', 'portfolio']);
const PATHS = new Set(['/api/me', '/api/portfolio?compute_margin=true', '/api/positions']);
const CONTENT_TYPES = new Set(['json', 'html', 'other', 'missing']);
const OUTCOMES = new Set(['ok', 'challenge', 'unauthorized', 'forbidden', 'rate_limited', 'redirect', 'html', 'invalid_data', 'timeout', 'network_error', 'cancelled']);
const KEYS = ['balance', 'challenge', 'contentType', 'elapsedMs', 'endpoint', 'outcome', 'path', 'status', 'structureOk'];
const integer = (value: unknown, min: number, max: number): boolean => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

/** The workbench's zod `syncSchema` (resultSchema.extend({ balance }).strict()): every key present, no other key. */
function parseSync(raw: unknown): Omit<VariationalPythonResult, 'endpoint'> & { endpoint: string; balance: number | string | null } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error();
  const data = raw as Record<string, unknown>;
  const keys = Object.keys(data).sort();
  if (keys.length !== KEYS.length || keys.some((key, index) => key !== KEYS[index])) throw new Error();
  if (typeof data.endpoint !== 'string' || !ENDPOINTS.has(data.endpoint) || typeof data.path !== 'string' || !PATHS.has(data.path)) throw new Error();
  if (data.status !== null && !integer(data.status, 100, 599)) throw new Error();
  if (data.contentType !== null && (typeof data.contentType !== 'string' || !CONTENT_TYPES.has(data.contentType))) throw new Error();
  if (typeof data.challenge !== 'boolean' || !integer(data.elapsedMs, 0, DEADLINE_MS + 1000)) throw new Error();
  if (data.structureOk !== null && typeof data.structureOk !== 'boolean') throw new Error();
  if (typeof data.outcome !== 'string' || !OUTCOMES.has(data.outcome)) throw new Error();
  const balance = data.balance;
  if (balance !== null && !((typeof balance === 'number' && Number.isFinite(balance)) || (typeof balance === 'string' && balance.length <= 128))) throw new Error();
  if (balance !== null && !hasValidVariationalBalance(balance)) throw new Error();
  return data as unknown as ReturnType<typeof parseSync>;
}

export async function runVariationalPython(c: VariationalCredential, operation: VariationalPythonOperation, signal?: AbortSignal, launch: typeof spawn = spawn): Promise<PythonResult> {
  validateVariationalCredential(c);
  if (!Object.hasOwn(TARGETS, operation)) throw new Error(VARIATIONAL_ERRORS.invalid_data);
  const target = TARGETS[operation];
  const started = performance.now();
  const fallback = (outcome: VariationalOutcome): PythonResult => ({
    result: { ...target, status: null, contentType: null, challenge: false,
      elapsedMs: Math.max(0, Math.round(performance.now() - started)), structureOk: null, outcome },
    balance: null,
  });
  return new Promise<PythonResult>(done => {
    if (signal?.aborted) { done(fallback('cancelled')); return; }
    // Credentials only enter stdin; do not inherit application secrets or Python hooks.
    const env: NodeJS.ProcessEnv = {};
    if (process.env.PATH) env.PATH = process.env.PATH;
    let child: ReturnType<typeof spawn>;
    try {
      child = launch(process.platform === 'win32' ? 'python' : 'python3', ['-I', '-B', VARIATIONAL_HELPER], {
        shell: false, windowsHide: true, env, stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch (error) {
      done(fallback(error instanceof Error && 'code' in error && error.code === 'ENOENT' ? 'client_unavailable' : 'client_error'));
      return;
    }
    let failure: VariationalOutcome | undefined;
    let bytes = 0;
    const chunks: Buffer[] = [];
    let hardKill: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const stop = (outcome: VariationalOutcome) => {
      if (failure || closed) return;
      failure = outcome;
      child.stdin?.destroy();
      hardKill = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 250);
      child.kill('SIGTERM');
    };
    const cancel = () => stop('cancelled');
    const deadline = setTimeout(() => stop('timeout'), DEADLINE_MS);
    signal?.addEventListener('abort', cancel, { once: true });
    child.on('error', (error: NodeJS.ErrnoException) => {
      failure ??= error.code === 'ENOENT' ? 'client_unavailable' : 'client_error';
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (failure) return;
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) { stop('client_error'); return; }
      chunks.push(chunk);
    });
    child.stdin?.on('error', () => stop('client_error'));
    child.once('close', code => {
      closed = true;
      clearTimeout(deadline); clearTimeout(hardKill);
      signal?.removeEventListener('abort', cancel);
      if (failure || code !== 0) { done(fallback(failure ?? 'client_error')); return; }
      try {
        const data = parseSync(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        if (data.endpoint !== target.endpoint || data.path !== target.path) throw new Error();
        if (data.outcome === 'ok' && (data.status === null || data.status < 200 || data.status >= 300 || data.contentType !== 'json' || data.challenge || data.structureOk !== true)) throw new Error();
        const balance = data.balance;
        if (data.outcome === 'ok' ? balance === null : balance !== null) throw new Error();
        // Rebuild the DTO so nothing but these fields leaves the subprocess boundary.
        done({ result: { ...target, status: data.status, contentType: data.contentType,
          challenge: data.challenge, elapsedMs: data.elapsedMs, structureOk: data.structureOk, outcome: data.outcome }, balance });
      } catch { done(fallback('client_error')); }
    });
    if (signal?.aborted) cancel();
    else child.stdin?.end(JSON.stringify({ vrToken: c.vrToken, operation }));
  });
}

export async function readVariationalPythonBalance(c: VariationalCredential, signal?: AbortSignal, launch: typeof spawn = spawn): Promise<number | string> {
  const { result, balance } = await runVariationalPython(c, 'sync-portfolio', signal, launch);
  if (result.outcome !== 'ok') throw new Error(VARIATIONAL_ERRORS[result.outcome]);
  if (balance === null) throw new Error(VARIATIONAL_ERRORS.invalid_data);
  return balance;
}
