// Monitor M-3d: the Variational session token the page saves, as the workbench's modules/monitor/server/variational-session.mjs
// (8470785). Kept in <data>/monitor-variational-session.json (service account, 600, written to a temporary file and renamed).
// Changed from the workbench: a file that cannot be read does not stop the monitor (the workbench refuses to start it); it is
// left alone, logged, and shown on the form until the page saves a new token over it. Errors are ContractErrors for the
// HTTP layer; a save is logged with its revision and declared expiry, never the token.
import { readFileSync, statSync } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ContractError } from '../contracts.ts';
import { VARIATIONAL_EXPIRY_MARGIN_MS, requestVariational, variationalReasonNote, variationalTokenExpiry, type VariationalFetcher } from '../vendor/variational-market.mjs';

export const VARIATIONAL_SESSION_FILE = 'monitor-variational-session.json';
/** Two saves this close together are refused: each one asks Variational once. */
export const VARIATIONAL_SAVE_INTERVAL_MS = 3_000;
const MAX_FILE_BYTES = 16_384;

export type VariationalStatus = 'missing' | 'expired' | 'ready' | 'rejected' | 'unavailable';
export interface VariationalSessionView {
  available: true; configured: boolean; revision: number; expiresAt: string | null; updatedAt: string | null; status: VariationalStatus; error: string;
}
interface Saved { version: 1; revision: number; token: string; updatedAt: string | null }

/** Reads the saved token; a bad file gives an empty state and the reason (shown on the form, never its content). */
function load(file: string): { state: Saved; problem: string } {
  const empty: Saved = { version: 1, revision: 0, token: '', updatedAt: null };
  try {
    const metadata = statSync(file);
    if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES) return { state: empty, problem: '保存的 Var token 文件无效（不是普通文件或过大），已忽略；请重新保存 token。' };
    if (metadata.mode & 0o077) return { state: empty, problem: '保存的 Var token 文件权限不是 600，已忽略；请重新保存 token。' };
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Partial<Saved>;
    if (saved.version !== 1 || !Number.isSafeInteger(saved.revision) || (saved.revision as number) < 1 || typeof saved.updatedAt !== 'string' || !Number.isFinite(Date.parse(saved.updatedAt))) throw new Error();
    variationalTokenExpiry(saved.token);
    return { state: { version: 1, revision: saved.revision as number, token: saved.token as string, updatedAt: saved.updatedAt }, problem: '' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: empty, problem: '' };
    return { state: empty, problem: '保存的 Var token 文件无法读取或内容无效，已忽略；请重新保存 token。' };
  }
}

async function save(file: string, next: Saved): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(next)}\n`, 'utf8');
    await handle.sync();
    await handle.close(); handle = null;
    await rename(temporary, file);
  } finally { await handle?.close().catch(() => undefined); await unlink(temporary).catch(() => undefined); }
}

export function createVariationalSession({ dir, fetcher, now = Date.now, log = line => process.stderr.write(`${line}\n`) }: {
  dir: string; fetcher: VariationalFetcher; now?: () => number; log?: (line: string) => void;
}) {
  const file = join(dir, VARIATIONAL_SESSION_FILE);
  const loaded = load(file);
  let state = loaded.state, problem = loaded.problem, queue: Promise<unknown> = Promise.resolve(), lastAttempt = -Infinity;
  // The last reader's verdict on the current revision ('' until one has been reported).
  let observation: '' | 'ready' | 'rejected' | 'unavailable' = '', observationReason = '';
  if (problem) log(`行情监控：${problem}`);
  const stopping = new AbortController();

  const status = (): VariationalStatus => {
    if (!state.token) return 'missing';
    if (variationalTokenExpiry(state.token) <= now() + VARIATIONAL_EXPIRY_MARGIN_MS) return 'expired';
    return observation || 'ready';
  };
  const view = (): VariationalSessionView => {
    const current = status();
    return { available: true, configured: Boolean(state.token), revision: state.revision,
      expiresAt: state.token ? new Date(variationalTokenExpiry(state.token)).toISOString() : null, updatedAt: state.updatedAt, status: current,
      error: problem || (current === 'expired' ? 'Var token 已过期，请更新；公开行情不受影响。' : current === 'rejected' ? 'Variational 未通过会话认证，请更新 token；公开行情不受影响。' : current === 'unavailable' ? `认证行情暂不可用${variationalReasonNote(observationReason)}，后台将自动重试；公开行情不受影响。` : '') };
  };
  return {
    view,
    /** The token a reader may use now (null when missing, expired or rejected) and the revision it belongs to. */
    current(): { token: string | null; revision: number; status: VariationalStatus } {
      const current = status(), usable = !['missing', 'expired', 'rejected'].includes(current);
      return { token: usable ? state.token : null, revision: state.revision, status: current };
    },
    /** A reader's verdict and, when unavailable, its reason (a fixed text); ignored when the token changed since that read began. */
    report(revision: number, next: 'ready' | 'rejected' | 'unavailable', reason = ''): void { if (state.revision === revision) { observation = next; observationReason = next === 'unavailable' ? reason : ''; } },
    /** The page's save: `{ token, revision }`; checks the token with Variational (/me) before it replaces the saved one. */
    update(input: unknown): Promise<VariationalSessionView> {
      const operation = queue.then(async () => {
        const previous = state;
        const body = input as { token?: unknown; revision?: unknown } | null;
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['token', 'revision'].includes(key)) || !Number.isSafeInteger(body.revision) || (body.revision as number) < 0) throw new ContractError(400, 'invalid_session', '请提供 Var token 和有效配置版本号。');
        if (body.revision !== previous.revision) throw new ContractError(409, 'session_conflict', 'Var token 已被另一页面更新，请重新读取状态后再保存。');
        const token = typeof body.token === 'string' ? body.token.trim() : body.token;
        let expiry: number;
        try { expiry = variationalTokenExpiry(token); } catch (error) { throw new ContractError(400, 'invalid_session', (error as Error).message); }
        if (expiry <= now() + VARIATIONAL_EXPIRY_MARGIN_MS) throw new ContractError(400, 'invalid_session', 'Var token 已过期或即将过期，请重新获取。');
        if (now() - lastAttempt < VARIATIONAL_SAVE_INTERVAL_MS) throw new ContractError(429, 'session_rate_limited', '验证过于频繁，请稍等 3 秒再试。');
        lastAttempt = now();
        let result: unknown;
        try { result = await requestVariational('/me', token as string, { fetcher, signal: AbortSignal.any([AbortSignal.timeout(12_000), stopping.signal]) }); }
        catch (error) {
          const failure = error as { message?: string; status?: number; variational?: boolean };
          const message = failure?.variational ? failure.message : 'Variational 暂不可用，请稍后重试。';
          throw new ContractError(failure?.status === 400 ? 400 : 502, failure?.status === 400 ? 'session_rejected' : 'session_unverified', `${message} 原配置未修改。`);
        }
        try {
          const confirmed = (result as { token?: unknown } | null)?.token;
          if (variationalTokenExpiry(confirmed) <= now() || variationalTokenExpiry(token) <= now() + VARIATIONAL_EXPIRY_MARGIN_MS) throw new Error();
        } catch { throw new ContractError(400, 'session_rejected', 'Variational 未确认有效会话，请重新获取 Var token。原配置未修改。'); }
        const next: Saved = { version: 1, revision: previous.revision + 1, token: token as string, updatedAt: new Date(now()).toISOString() };
        try { await save(file, next); }
        catch { throw new ContractError(503, 'session_unsaved', 'Var token 保存失败，原配置已保留；请检查数据目录权限和磁盘空间。'); }
        state = next; problem = ''; observation = ''; observationReason = '';
        log(`行情监控：已更新 Var token（版本 ${next.revision}，声明到期 ${new Date(expiry).toISOString()}）`);
        return view();
      });
      queue = operation.catch(() => undefined);
      return operation;
    },
    /** Ends a check in flight (at stopping). */
    stop(): void { stopping.abort(); },
  };
}
export type VariationalSession = ReturnType<typeof createVariationalSession>;
