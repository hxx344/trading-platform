// Requests to this service. Every write carries the x-pa-executor header the server requires, besides the session cookie;
// errors come back as { code, message }. ApiError carries the HTTP status; a network failure or timeout has none, so
// callers can tell "the server answered no" from "the answer is unknown".

export class ApiError extends Error {
  status: number;
  code: string | undefined;
  constructor(message: string, status: number, code?: string) { super(message); this.status = status; this.code = code; }
}

export async function api<T>(path: string, { body, signal, timeoutMs = 15_000 }: { body?: unknown; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
  const controller = new AbortController();
  const writing = body !== undefined;
  const timeout = () => new DOMException(writing ? '请求超时，结果未知；请刷新核对后再操作' : '数据读取超时，稍后自动重试', 'TimeoutError');
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(timeout()), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(path, writing
        ? { method: 'POST', credentials: 'same-origin', signal: controller.signal, headers: { 'content-type': 'application/json', 'x-pa-executor': '1' }, body: JSON.stringify(body) }
        : { credentials: 'same-origin', signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason instanceof Error) throw controller.signal.reason;
      throw error instanceof Error ? error : new Error(String(error));
    }
    const data = await response.json().catch(() => null) as { message?: unknown; code?: unknown } | null;
    // Cut off while the body was arriving: like a lost answer, the outcome is unknown.
    if (controller.signal.aborted) throw controller.signal.reason instanceof Error ? controller.signal.reason : new Error('请求已中止');
    if (!response.ok) throw new ApiError(typeof data?.message === 'string' && data.message ? data.message : `请求失败（HTTP ${response.status}）`, response.status, typeof data?.code === 'string' ? data.code : undefined);
    // A write answered with success went through even if its body cannot be read; the page refreshes to show it. A read
    // without a readable body has no result: it fails without a status, like a lost answer, and the last data stays.
    if (data === null) {
      if (writing) return {} as T;
      throw new Error('响应无法解析，稍后自动重试');
    }
    return data as T;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
