// Copied from project_aggregation modules/asset/lib/variational-python-client.ts at 0014655 (same at 7745181).
// Changes: only the 'sync-portfolio' and (since A-5) 'sync-positions' operations are kept (diagnostics are not ported);
// the zod schemas (syncSchema, positionsSchema) are replaced by equivalent hand-written strict checks (the server has no runtime dependencies); the helper is
// scripts/variational-balance.py, located relative to this file rather than the working directory (the service runs
// from /opt/trading-platform/current); the child environment keeps only PATH. The 23 s deadline, the 8192-byte output
// limit (2 MB for positions), SIGTERM then SIGKILL after 250 ms, stdin-only credentials and the result checks are unchanged.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hasValidVariationalBalance, validateVariationalCredential, VARIATIONAL_ERRORS } from './variational-shared.ts';
import type { VariationalCredential } from './variational-shared.ts';
import type { Position } from '../positions-types.ts';

export type VariationalPythonOperation = 'sync-portfolio' | 'sync-positions';
export type VariationalOutcome = 'ok' | 'challenge' | 'unauthorized' | 'forbidden' | 'rate_limited' | 'redirect' | 'html' | 'invalid_data' | 'timeout' | 'network_error' | 'cancelled' | 'client_unavailable' | 'client_error';
export type VariationalPythonResult = {
  endpoint: 'portfolio'; path: string; status: number | null; contentType: 'json' | 'html' | 'other' | 'missing' | null;
  challenge: boolean; elapsedMs: number; structureOk: boolean | null; outcome: VariationalOutcome;
};
type PythonResult = { result: VariationalPythonResult; balance: number | string | null; positions?: Position[] | null };
const TARGETS = {
  'sync-portfolio': { endpoint: 'portfolio', path: '/api/portfolio?compute_margin=true' },
  'sync-positions': { endpoint: 'portfolio', path: '/api/positions' },
} as const;
const MAX_OUTPUT_BYTES = 8192;
const DEADLINE_MS = 23_000;
/** Absolute path of the helper, shipped next to src/ in the release package (deploy/package.sh). */
export const VARIATIONAL_HELPER = fileURLToPath(new URL('../../../scripts/variational-balance.py', import.meta.url));

const ENDPOINTS = new Set(['session', 'portfolio']);
const PATHS = new Set(['/api/me', '/api/portfolio?compute_margin=true', '/api/positions']);
const CONTENT_TYPES = new Set(['json', 'html', 'other', 'missing']);
const OUTCOMES = new Set(['ok', 'challenge', 'unauthorized', 'forbidden', 'rate_limited', 'redirect', 'html', 'invalid_data', 'timeout', 'network_error', 'cancelled']);
const RESULT_KEYS = ['challenge', 'contentType', 'elapsedMs', 'endpoint', 'outcome', 'path', 'status', 'structureOk'];
const integer = (value: unknown, min: number, max: number): boolean => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

type Parsed = Omit<VariationalPythonResult, 'endpoint'> & { endpoint: string };
/** The workbench's zod `resultSchema` extended with `extra` and made strict: every key present, no other key. */
function parseResult(raw: unknown, extra: string): Parsed & Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error();
  const data = raw as Record<string, unknown>;
  const keys = Object.keys(data).sort(), expected = [...RESULT_KEYS, extra].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error();
  if (typeof data.endpoint !== 'string' || !ENDPOINTS.has(data.endpoint) || typeof data.path !== 'string' || !PATHS.has(data.path)) throw new Error();
  if (data.status !== null && !integer(data.status, 100, 599)) throw new Error();
  if (data.contentType !== null && (typeof data.contentType !== 'string' || !CONTENT_TYPES.has(data.contentType))) throw new Error();
  if (typeof data.challenge !== 'boolean' || !integer(data.elapsedMs, 0, DEADLINE_MS + 1000)) throw new Error();
  if (data.structureOk !== null && typeof data.structureOk !== 'boolean') throw new Error();
  if (typeof data.outcome !== 'string' || !OUTCOMES.has(data.outcome)) throw new Error();
  return data as Parsed & Record<string, unknown>;
}
/** The workbench's zod `syncSchema` (resultSchema.extend({ balance }).strict()). */
function parseSync(raw: unknown): Parsed & { balance: number | string | null } {
  const data = parseResult(raw, 'balance');
  const balance = data.balance;
  if (balance !== null && !((typeof balance === 'number' && Number.isFinite(balance)) || (typeof balance === 'string' && balance.length <= 128))) throw new Error();
  if (balance !== null && !hasValidVariationalBalance(balance)) throw new Error();
  return data as Parsed & { balance: number | string | null };
}
const DECIMAL = /^-?\d+(?:\.\d+)?$/, PUBLIC_TEXT = /^[A-Za-z0-9_.:/ -]+$/;
const POSITION_KEYS = ['contractSize', 'entryPrice', 'id', 'instrumentId', 'leverage', 'liquidationPrice', 'marginMode', 'markPrice', 'notional', 'notionalCurrency',
  'pnlCurrency', 'priceCurrency', 'quantity', 'quantityUnit', 'side', 'sourceUpdatedAt', 'symbol', 'unrealizedPnl'];
const isDecimal = (value: unknown): value is string => typeof value === 'string' && value.length <= 128 && DECIMAL.test(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value.length >= 1 && value.length <= 160 && PUBLIC_TEXT.test(value);
/** zod's z.string().datetime(): UTC "Z" ISO 8601 with optional fractional seconds. */
const isDatetime = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value));
/** The workbench's zod `positionSchema` (strict). */
function parsePosition(raw: unknown): Position {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error();
  const item = raw as Record<string, unknown>, keys = Object.keys(item).sort();
  if (keys.length !== POSITION_KEYS.length || keys.some((key, index) => key !== POSITION_KEYS[index])) throw new Error();
  if (typeof item.id !== 'string' || !/^[a-f0-9]{64}$/.test(item.id) || !isText(item.symbol) || !isText(item.instrumentId) || !isText(item.quantityUnit)) throw new Error();
  if (item.side !== 'long' && item.side !== 'short') throw new Error();
  if (!isDecimal(item.quantity) || item.quantity.startsWith('-') || !/[1-9]/.test(item.quantity)) throw new Error();
  for (const key of ['contractSize', 'entryPrice', 'markPrice', 'notional', 'unrealizedPnl', 'leverage', 'liquidationPrice']) if (item[key] !== null && !isDecimal(item[key])) throw new Error();
  for (const key of ['priceCurrency', 'notionalCurrency', 'pnlCurrency', 'marginMode']) if (item[key] !== null && !isText(item[key])) throw new Error();
  if (item.sourceUpdatedAt !== null && !isDatetime(item.sourceUpdatedAt)) throw new Error();
  return item as unknown as Position;
}
/** The workbench's zod `positionsSchema` (resultSchema.extend({ positions: array(positionSchema).max(1000).nullable() }).strict()). */
function parsePositions(raw: unknown): Parsed & { positions: Position[] | null } {
  const data = parseResult(raw, 'positions');
  if (data.positions !== null && (!Array.isArray(data.positions) || data.positions.length > 1000)) throw new Error();
  return { ...data, positions: data.positions === null ? null : (data.positions as unknown[]).map(parsePosition) };
}

export async function runVariationalPython(c: VariationalCredential, operation: VariationalPythonOperation, signal?: AbortSignal, launch: typeof spawn = spawn): Promise<PythonResult> {
  validateVariationalCredential(c);
  if (!Object.hasOwn(TARGETS, operation)) throw new Error(VARIATIONAL_ERRORS.invalid_data);
  const target = TARGETS[operation];
  const started = performance.now();
  const fallback = (outcome: VariationalOutcome): PythonResult => ({
    result: { ...target, status: null, contentType: null, challenge: false,
      elapsedMs: Math.max(0, Math.round(performance.now() - started)), structureOk: null, outcome },
    balance: null, ...(operation === 'sync-positions' ? { positions: null } : {}),
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
      if (bytes > (operation === 'sync-positions' ? 2_000_000 : MAX_OUTPUT_BYTES)) { stop('client_error'); return; }
      chunks.push(chunk);
    });
    child.stdin?.on('error', () => stop('client_error'));
    child.once('close', code => {
      closed = true;
      clearTimeout(deadline); clearTimeout(hardKill);
      signal?.removeEventListener('abort', cancel);
      if (failure || code !== 0) { done(fallback(failure ?? 'client_error')); return; }
      try {
        const raw: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const syncData = operation === 'sync-portfolio' ? parseSync(raw) : null;
        const positionsData = operation === 'sync-positions' ? parsePositions(raw) : null;
        const data: Parsed = (syncData ?? positionsData)!;
        if (data.endpoint !== target.endpoint || data.path !== target.path) throw new Error();
        if (data.outcome === 'ok' && (data.status === null || data.status < 200 || data.status >= 300 || data.contentType !== 'json' || data.challenge || data.structureOk !== true)) throw new Error();
        const balance = syncData?.balance ?? null;
        if (operation === 'sync-portfolio' && (data.outcome === 'ok' ? balance === null : balance !== null)) throw new Error();
        if (positionsData && (data.outcome === 'ok' ? positionsData.positions === null : positionsData.positions !== null)) throw new Error();
        if (positionsData?.positions && new Set(positionsData.positions.map(item => item.id)).size !== positionsData.positions.length) throw new Error();
        // Rebuild the DTO so nothing but these fields leaves the subprocess boundary.
        done({ result: { ...target, status: data.status, contentType: data.contentType,
          challenge: data.challenge, elapsedMs: data.elapsedMs, structureOk: data.structureOk, outcome: data.outcome as VariationalOutcome }, balance,
          ...(positionsData ? { positions: positionsData.positions } : {}) });
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

export async function readVariationalPythonPositions(c: VariationalCredential, signal?: AbortSignal, launch: typeof spawn = spawn): Promise<Position[]> {
  const { result, positions } = await runVariationalPython(c, 'sync-positions', signal, launch);
  if (result.outcome !== 'ok') throw new Error(VARIATIONAL_ERRORS[result.outcome]);
  if (!positions) throw new Error(VARIATIONAL_ERRORS.invalid_data);
  return positions;
}
