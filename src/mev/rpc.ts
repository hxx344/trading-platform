// JSON-RPC 客户端（docs/mev.md）。每个请求有超时、应答有字节上限；批量请求按 id 对回，缺一项即整批失败。
// 地址可能带服务商密钥，所以错误文本里从不出现地址本身。
import { anySignal } from '../any-signal.mjs';
import { readJsonResponse } from '../vendor/response.mjs';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** 节点明确返回的 JSON-RPC 错误（请求已被节点处理并拒绝）；网络失败、超时、应答不合规是 RpcTransportError。 */
export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data: unknown) { super(message.slice(0, 300)); this.name = 'RpcError'; this.code = code; this.data = data; }
}
export class RpcTransportError extends Error {
  constructor(message: string) { super(message); this.name = 'RpcTransportError'; }
}

export interface RpcCall { method: string; params: readonly unknown[] }
export type RpcOutcome = { ok: true; result: unknown } | { ok: false; error: RpcError };

export interface RpcOptions { url: string; fetchImpl?: FetchLike; timeoutMs?: number; maxBytes?: number; signal?: AbortSignal }
export type RpcClient = ReturnType<typeof createRpc>;

export function createRpc({ url, fetchImpl = (target, init) => fetch(target, init), timeoutMs = 4_000, maxBytes = 8 * 1024 * 1024, signal: stop }: RpcOptions) {
  let nextId = 1;

  async function post(body: unknown, timeout: number): Promise<unknown> {
    const signal = anySignal([stop], timeout);
    let response: Response;
    try {
      response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal, redirect: 'error' });
    } catch (error) {
      throw new RpcTransportError(signal.aborted ? (stop?.aborted ? 'RPC 请求已取消' : `RPC 请求超过 ${timeout} 毫秒`) : `RPC 连接失败：${error instanceof Error ? error.name : '未知错误'}`);
    }
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new RpcTransportError(`RPC 返回 HTTP ${response.status}`); }
    try { return await readJsonResponse(response, { maxBytes, signal }); } catch { throw new RpcTransportError(signal.aborted ? `RPC 应答超过 ${timeout} 毫秒` : 'RPC 应答不是有效的 JSON 或超过大小上限'); }
  }

  function outcome(entry: unknown): RpcOutcome {
    if (!entry || typeof entry !== 'object') throw new RpcTransportError('RPC 应答格式无效');
    const { error, result } = entry as { error?: { code?: unknown; message?: unknown; data?: unknown }; result?: unknown };
    if (error && typeof error === 'object') return { ok: false, error: new RpcError(typeof error.code === 'number' ? error.code : 0, typeof error.message === 'string' ? error.message : 'RPC 错误', error.data) };
    if (result === undefined) throw new RpcTransportError('RPC 应答既没有结果也没有错误');
    return { ok: true, result };
  }

  /** 一批请求一次往返；每项各自成功或被节点拒绝。传输失败整批抛出。 */
  async function batch(calls: readonly RpcCall[], timeout = timeoutMs): Promise<RpcOutcome[]> {
    if (!calls.length) return [];
    const first = nextId;
    nextId += calls.length;
    const answer = await post(calls.map((call, index) => ({ jsonrpc: '2.0', id: first + index, method: call.method, params: call.params })), timeout);
    if (!Array.isArray(answer)) {
      // 有的节点在整批被拒（限流、批量超限）时只回一个错误对象。
      const single = outcome(answer);
      throw new RpcTransportError(single.ok ? 'RPC 批量应答不是数组' : `RPC 拒绝了批量请求：${single.error.message}`);
    }
    const byId = new Map<number, unknown>();
    for (const entry of answer) if (entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'number') byId.set((entry as { id: number }).id, entry);
    return calls.map((_, index) => {
      if (!byId.has(first + index)) throw new RpcTransportError('RPC 批量应答缺项');
      return outcome(byId.get(first + index));
    });
  }

  /** 单个请求；节点拒绝时抛 RpcError。 */
  async function request(method: string, params: readonly unknown[], timeout = timeoutMs): Promise<unknown> {
    const id = nextId++;
    const answer = await post({ jsonrpc: '2.0', id, method, params }, timeout);
    if (!answer || typeof answer !== 'object' || (answer as { id?: unknown }).id !== id) throw new RpcTransportError('RPC 应答的编号对不上');
    const result = outcome(answer);
    if (!result.ok) throw result.error;
    return result.result;
  }

  return { request, batch };
}

/** 一批里必须全部成功时用：任何一项被拒就抛出那一项的错误。 */
export function unwrap(outcomes: readonly RpcOutcome[]): unknown[] {
  return outcomes.map(entry => { if (!entry.ok) throw entry.error; return entry.result; });
}
