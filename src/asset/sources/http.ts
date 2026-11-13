// Copied from project_aggregation modules/asset/lib/exchanges.ts (finite, readJson) at 0014655.
// Changes: split out of exchanges.ts; imports point at src/vendor. Logic, messages, the 12 s timeout and the 2 MB limit are unchanged.
import { ExchangeResponseError, readJsonResponse } from '../../vendor/response.mjs';

export type Json = Record<string, any>;
export type Fetcher = typeof fetch;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
export function finite(value: unknown, field: string): number {
  if (value === '' || value === null || value === undefined || typeof value === 'boolean') throw new Error(`${field} 缺少有效数值`);
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${field} 不是有效数值`);
  return n;
}
export async function readJson(url: string, init: RequestInit = {}, fetcher: Fetcher = fetch): Promise<Json> {
  let response:Response;
  const signal = AbortSignal.timeout(12000);
  try{response = await fetcher(url, { ...init, redirect: 'manual', signal });}
  catch{throw new Error('行情或交易所连接超时，请稍后重试；已保留上次数据');}
  if (!response.ok) throw new Error(`服务暂时不可用（HTTP ${response.status}），保留上次数据`);
  // The shared bounded reader (docs/evolution-plan.md E2); body text never reaches the message.
  try { return await readJsonResponse(response, { maxBytes: MAX_BODY_BYTES, signal }) as Json; }
  catch (error) {
    if (signal.aborted) throw new Error('行情或交易所连接超时，请稍后重试；已保留上次数据');
    if (error instanceof ExchangeResponseError && error.code === 'response_limit') throw new Error('服务返回的数据超过 2MB 上限，保留上次数据');
    throw new Error('服务返回的数据无法识别，保留上次数据');
  }
}
