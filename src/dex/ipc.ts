// 执行服务连 DEX 价差服务的客户端（docs/dexspread.md 第 11.2 节）。只导入协议，不导入 src/varlighter/**（11.3 的打包断言）。
import { request, type IncomingMessage } from 'node:http';
import { anySignal } from '../any-signal.mjs';
import { DEX_BACKTEST_TIMEOUT_MS, DEX_INPUT_LIMIT, DEX_OUTPUT_LIMIT, DEX_PATH, DEX_PROTOCOL, DEX_READ_TIMEOUT_MS, DexError,
  type DexPageAnswer, type DexPageRequest, type DexStatus, type DexTokenPush } from './protocol.ts';

export { DEX_PROTOCOL } from './protocol.ts';
export type { DexPageAnswer, DexPageRequest, DexStatus, DexTokenPush } from './protocol.ts';

/** POST 已经发到 DEX、应答丢了或超时：结果未知，调用方断开浏览器连接，不重试（L204）。 */
export class DexOutcomeUnknown extends Error {}

export const DEX_UNAVAILABLE: DexPageAnswer = { status: 503, body: { code: 'dex_unavailable', message: 'DEX 价差服务未就绪' } };

interface Exchange { res: IncomingMessage; body: Buffer }

/** 发一个请求、读完应答。`sent` 在连接建立、请求体交给套接字之后为真。 */
function exchange(socketPath: string, path: string, body: Buffer | null, signal: AbortSignal, state: { sent: boolean }): Promise<Exchange> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: body ? 'POST' : 'GET', signal, agent: false,
      headers: body ? { host: 'localhost', 'content-type': 'application/json', 'content-length': body.length } : { host: 'localhost' } }, res => {
      const chunks: Buffer[] = []; let bytes = 0;
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > DEX_OUTPUT_LIMIT) { res.destroy(new DexError('DEX 价差服务应答过大')); return; }
        chunks.push(chunk);
      });
      res.on('end', () => res.complete ? resolve({ res, body: Buffer.concat(chunks, bytes) }) : reject(new DexError('DEX 价差服务应答不完整')));
      res.on('error', reject);
      res.on('aborted', () => reject(new DexError('DEX 价差服务应答中断')));
    });
    req.on('socket', socket => {
      const mark = () => { state.sent = true; };
      if ((socket as { connecting?: boolean }).connecting) socket.once('connect', mark); else mark();
    });
    req.on('error', reject);
    req.end(body);
  });
}

function parse(bytes: Buffer): unknown {
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw new DexError('DEX 价差服务应答格式无效'); }
}

export async function dexStatus(socketPath: string, timeoutMs = 2500): Promise<DexStatus> {
  const { res, body } = await exchange(socketPath, DEX_PATH + 'status', null, AbortSignal.timeout(timeoutMs), { sent: false });
  const value = parse(body) as DexStatus;
  if (res.statusCode !== 200 || !value || typeof value.instance !== 'string' || typeof value.build !== 'string') throw new DexError('DEX 价差服务状态应答无效');
  return value;
}

export interface DexClient {
  /** 转发一个页面请求。确定没发出的失败返回 503 dex_unavailable；POST 发出后结果未知时抛 DexOutcomeUnknown。 */
  page(input: DexPageRequest, signal?: AbortSignal): Promise<DexPageAnswer>;
  /** 返回 DEX 当前生效的 token 摘要，执行面以它为准判断是否送达。 */
  pushToken(push: DexTokenPush): Promise<{ instance: string; token: string | null }>;
  status(): Promise<DexStatus>;
  /** 依赖巡检读到的协议版本不认识时置为假，之后页面请求一律返回 503。 */
  setCompatible(compatible: boolean): void;
  close(): void;
}

export function createDexClient(socketPath: string): DexClient {
  const stopped = new AbortController();
  let compatible = true;
  return {
    async page(input, signal) {
      if (!compatible) return { status: 503, body: { code: 'dex_unavailable', message: 'DEX 价差服务版本与执行服务不匹配' } };
      const body = Buffer.from(JSON.stringify(input));
      if (body.length > DEX_INPUT_LIMIT) return { status: 413, body: { code: 'body_too_large', message: '请求体过大' } };
      const timeout = input.method === 'POST' && input.path === 'backtest' ? DEX_BACKTEST_TIMEOUT_MS : DEX_READ_TIMEOUT_MS;
      const state = { sent: false };
      try {
        const { res, body: answer } = await exchange(socketPath, DEX_PATH + 'page', body, anySignal([stopped.signal, signal], timeout), state);
        const value = parse(answer) as Partial<DexPageAnswer> & { message?: unknown };
        if (res.statusCode === 200 && Number.isInteger(value?.status) && value.status! >= 200 && value.status! <= 599) return { status: value.status!, body: value.body ?? null };
        // DEX 在处理之前就拒绝了（格式、大小）或自己出错：页面按确定失败显示。
        const message = typeof value?.message === 'string' ? value.message.slice(0, 240) : 'DEX 价差服务未能处理请求';
        if (res.statusCode === 400 || res.statusCode === 404) return { status: 404, body: { code: 'not_found', message: '不存在' } };
        return { status: res.statusCode === 413 ? 413 : 503, body: { code: res.statusCode === 413 ? 'body_too_large' : 'dex_unavailable', message } };
      } catch (error) {
        if (input.method !== 'POST' || !state.sent) return DEX_UNAVAILABLE;
        // 回测不改数据：发出后超时或应答丢失直接告诉页面，不必按结果未知处理。
        if (input.path === 'backtest') return { status: 504, body: { code: 'dex_timeout', message: '回测没有在限时内完成，请缩短区间后重试' } };
        throw new DexOutcomeUnknown(error instanceof Error ? error.message.slice(0, 200) : 'DEX 价差服务应答丢失');
      }
    },
    async pushToken(push) {
      const { res, body } = await exchange(socketPath, DEX_PATH + 'var-token', Buffer.from(JSON.stringify(push)), anySignal([stopped.signal], DEX_READ_TIMEOUT_MS), { sent: false });
      const value = parse(body) as { token?: unknown };
      const instance = res.headers['x-dex-instance'];
      if (res.statusCode !== 200 || (typeof value?.token !== 'string' && value?.token !== null) || typeof instance !== 'string') throw new DexError('DEX 价差服务没有确认 token');
      return { instance, token: value.token };
    },
    status: () => dexStatus(socketPath),
    setCompatible(value) { compatible = value; },
    close() { stopped.abort(); },
  };
}

export const dexCompatible = (status: DexStatus): boolean => status.protocol === DEX_PROTOCOL;
