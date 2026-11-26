import { ExchangeResponseError, readJsonResponse } from '../vendor/response.mjs';

export type DexFetcher = (url: string, init: RequestInit) => Promise<Response>;

export async function readSource(fetcher: DexFetcher, url: string, init: RequestInit, signal: AbortSignal, name: string, maxBytes: number) {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, signal, redirect: 'error', cache: 'no-store' });
  } catch {
    throw new Error(`${name}连接失败`);
  }
  // Kyber 的 400 响应含有可区分「无路由」与「代币未收录」的数字代码。
  if ((response.status !== 200 || response.headers.has('content-range')) && !(name === 'KyberSwap' && response.status === 400)) {
    void response.body?.cancel().catch(() => {});
    if (response.status === 429) throw Object.assign(new Error(`${name}请求受限，请稍后刷新`), { status: 429 });
    throw new Error(`${name}不可用（HTTP ${response.status}）`);
  }
  try {
    const data = await readJsonResponse(response, { maxBytes, signal });
    return { ok: response.ok, data };
  } catch (error) {
    if (error instanceof ExchangeResponseError && error.code === 'response_limit') throw new Error(`${name}响应过大`);
    throw new Error(`${name}响应无效`);
  }
}
