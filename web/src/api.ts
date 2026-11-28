import { isDisplayRead, READ_CACHE } from '../../src/read-view.ts';
import { notifyReadSessionExpired } from './read-cache-events.ts';
import { invalidateMutationReads, invalidateReadViews, readDisplayView } from './read-view-client.ts';

// Requests to this service. Every write carries the x-pa-executor header the server requires, besides the session cookie;
// errors come back as { code, message }. ApiError carries the HTTP status; a network failure or timeout has none, so
// callers can tell "the server answered no" from "the answer is unknown".

export class ApiError extends Error {
  status: number;
  code: string | undefined;
  /** The parsed error body, for callers that read fields besides code and message (CrossEx: requestStatus). */
  body: unknown;
  constructor(message: string, status: number, code?: string, body?: unknown) { super(message); this.status = status; this.code = code; this.body = body; }
}

// A write is a POST unless the route takes another method (CrossEx settings: PUT); either way it carries x-pa-executor.
export async function api<T>(path: string, { body, signal, timeoutMs = 15_000, method = 'POST' }: { body?: unknown; signal?: AbortSignal; timeoutMs?: number; method?: 'POST' | 'PUT' } = {}): Promise<T> {
  const controller = new AbortController();
  const verb = body === undefined ? 'GET' : method;
  const pathname = path.split('?', 1)[0];
  const display = isDisplayRead(verb, pathname);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  // Preview and apply share the same route. Only an explicit preview in the submitted JSON is read-only.
  const importPreview = verb === 'POST' && pathname === '/api/asset/import' && payload !== undefined && JSON.parse(payload)?.apply === false;
  const query = verb === 'POST' && /^\/api\/(?:preview|four-leg\/preview|options\/plans|crossex\/(?:open-capacity|preview)|read-token\/lookup|varlighter\/(?:backtest|lead\/analyze)|monitor\/perpetual\/(?:price-history|depth|exit))$/.test(pathname);
  const writing = verb !== 'GET' && !display && !query && !importPreview;
  const key = display ? path + '\n' + verb + '\n' + (payload ?? '') : undefined;
  const readTimeout = importPreview ? '原表预览超时，请重新选择文件' : '数据读取超时，稍后自动重试';
  const timeout = () => new DOMException(writing ? '请求超时，结果未知；请刷新核对后再操作' : readTimeout, 'TimeoutError');
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(timeout()), timeoutMs);
  async function request(known?: string): Promise<Response> {
    const headers: Record<string, string> = {};
    if (verb !== 'GET') { headers['content-type'] = 'application/json'; headers['x-pa-executor'] = '1'; }
    if (known) headers[READ_CACHE] = known;
    const response = await fetch(path, { method: verb === 'GET' ? undefined : verb, credentials: 'same-origin', signal: controller.signal, headers, body: payload });
    if (response.ok) return response;
    if (response.status === 401) {
      invalidateReadViews();
      notifyReadSessionExpired();
    } else if (key && [403, 404, 409, 423].includes(response.status)) invalidateReadViews(key);
    const data = await response.json().catch(() => null) as { message?: unknown; code?: unknown } | null;
    controller.signal.throwIfAborted();
    throw new ApiError(typeof data?.message === 'string' && data.message ? data.message : `请求失败（HTTP ${response.status}）`, response.status, typeof data?.code === 'string' ? data.code : undefined, data);
  }
  if (writing) invalidateMutationReads(pathname, false);
  try {
    if (key) return await readDisplayView<T>(key, request, controller.signal);
    const response = await request();
    const data = await response.json().catch(() => null);
    controller.signal.throwIfAborted();
    // Explicit empty write answers (204 or content-length: 0) succeeded; a non-empty unreadable 200 body leaves the outcome
    // unknown, like a read without a readable body: it fails without a status, and a read keeps the last data.
    if (data === null) {
      if (writing && (response.status === 204 || response.headers.get('content-length') === '0')) return {} as T;
      if (writing) throw new Error('响应无法解析，结果未知；请刷新核对后再操作');
      throw new Error(importPreview ? '未收到预览结果，请重新选择文件' : '响应无法解析，稍后自动重试');
    }
    return data as T;
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason instanceof Error) throw controller.signal.reason;
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    if (writing) invalidateMutationReads(pathname, true);
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
