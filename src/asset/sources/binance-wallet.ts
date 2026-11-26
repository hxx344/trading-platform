import { isObject } from '../../contracts.ts';
import { binanceSignedQuery } from '../../vendor/binance.mjs';
import { readJsonResponse } from '../../vendor/response.mjs';
import { binanceReadOnly, PositionsPermissionError } from '../positions-values.ts';
import type { BinanceCredential } from './exchanges.ts';

const paths = {
  permissions: '/sapi/v1/account/apiRestrictions', balances: '/sapi/v1/asset/wallet/balance',
  networks: '/sapi/v1/capital/config/getall', addresses: '/sapi/v1/capital/deposit/address/list',
} as const;
type Request = { kind: 'permissions' | 'balances' | 'networks' } | { kind: 'addresses'; coin: string; network: string };
const failed = 'Binance 读取失败，请检查网络、API 权限及服务器时间；已保留上次数据';
export class BinanceReadThrottle extends Error {
  readonly delay: number;
  constructor(message: string, delay: number) { super(message); this.delay = delay; }
}
export async function readBinanceWallet(c: BinanceCredential, request: Request, fetcher: typeof fetch, signal: AbortSignal, now = Date.now) {
  const params = new URLSearchParams();
  if (request.kind === 'balances') params.set('quoteAsset', 'USDT');
  if (request.kind === 'addresses') { params.set('coin', request.coin); params.set('network', request.network); }
  const start = now();
  let response: Response;
  try {
    signal.throwIfAborted();
    const { query, headers } = binanceSignedQuery(c, params, { timestamp: String(start), recvWindow: '10000' });
    response = await fetcher('https://api.binance.com' + paths[request.kind] + '?' + query,
      { method: 'GET', headers, redirect: 'manual', cache: 'no-store', signal });
  } catch { throw new Error(failed); }
  const maxBytes = request.kind === 'permissions' || request.kind === 'addresses' ? 64 * 1024 :
    request.kind === 'networks' ? 12 * 1024 * 1024 : 2 * 1024 * 1024;
  const data = await readBinanceSignedResponse(response, signal, maxBytes);
  if (data === null || typeof data !== 'object') throw new Error('Binance 返回的数据不完整；已保留上次数据');
  if (request.kind === 'permissions' && (!isObject(data) || !binanceReadOnly(data))) {
    throw new PositionsPermissionError('此 Binance API 无法确认只读权限，请使用仅启用读取的 API');
  }
  signal.throwIfAborted();
  return { data, start, headers: response.headers };
}

export async function readBinanceSignedResponse(response: Response, signal: AbortSignal, maxBytes: number, verifyProductDenial?: () => Promise<void>) {
  const status = response.status;
  const httpError = 'Binance 读取失败（HTTP ' + status + '），请检查网络、API 权限及服务器时间；已保留上次数据';
  if (response.redirected || response.headers.has('content-range') || ![200, 400, 401, 403].includes(status)) {
    void response.body?.cancel().catch(() => {});
    if (!response.redirected && (status === 429 || status === 418)) {
      const after = response.headers.get('retry-after') ?? '';
      throw new BinanceReadThrottle(httpError, Math.max(60_000, /^\d{1,9}$/.test(after) ? Number(after) * 1000 : 0));
    }
    throw new Error(httpError);
  }
  let data: unknown;
  try {
    // A response received after cancellation may still explicitly deny this credential. Never reuse a late success.
    const late = signal.aborted;
    data = await readJsonResponse(response, { maxBytes: status === 200 && !late ? maxBytes : 16 * 1024, signal: late ? AbortSignal.timeout(500) : signal });
  } catch { if (status === 200) throw new Error(failed); }
  const code = isObject(data) ? data.code : undefined;
  if (code === -2014 || code === -2015 || code === -1002 || status === 401) {
    const message = typeof code === 'number' ? 'Binance 读取失败（' + code + '），请检查 API 权限、IP 白名单及服务器时间' : httpError;
    // -2014 is an invalid key format. -2015 can refer only to the requested product (e.g. portfolio margin).
    if (verifyProductDenial && code !== -2014) {
      await verifyProductDenial();
      throw new Error(message);
    }
    throw new PositionsPermissionError(message);
  }
  if (isObject(data) && Object.hasOwn(data, 'code')) {
    const message = 'Binance 读取失败（' + (typeof code === 'number' && Number.isSafeInteger(code) ? code : '未知代码') + '），请检查 API 权限、IP 白名单及服务器时间';
    if (code === -1003) throw new BinanceReadThrottle(message, 60_000);
    throw new Error(message);
  }
  if (status !== 200) throw new Error(httpError);
  return data;
}
