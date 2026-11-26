import { anySignal } from '../any-signal.mjs';
import { isObject } from '../contracts.ts';
import { ExchangeResponseError, readJsonResponse } from '../vendor/response.mjs';

import { networks, isSettlementOrNative } from './networks.ts';

export { isSettlementOrNative } from './networks.ts';
type DexInput = { chain: keyof typeof networks; address: string; amount: string };
export interface DexQuote { rawQuantity: string; decimals: number; at: number; swapGasUsdt?: number | null }
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
const maxUint256 = (1n << 256n) - 1n;

function usdtUnits(value: string, decimals: number): string {
  const match = typeof value === 'string' && /^(\d{1,78})(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) throw new Error('USDT 金额须为正的十进制数，最多保留六位小数');
  const amount = BigInt(match[1] + (match[2] ?? '').padEnd(decimals, '0'));
  if (amount === 0n || amount > maxUint256) throw new Error('USDT 金额超出可报价范围');
  return amount.toString();
}

async function readSource(fetcher: Fetcher, url: string, init: RequestInit, signal: AbortSignal, name: string, maxBytes: number) {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, signal, redirect: 'error', cache: 'no-store' });
  } catch {
    throw new Error(`${name}连接失败`);
  }
  // Kyber 的 400 响应含有可区分「无路由」与「代币未收录」的数字代码。
  if (!response.ok && !(name === 'KyberSwap' && response.status === 400)) {
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

async function tokenDecimals(fetcher: Fetcher, rpc: string, address: string, signal: AbortSignal) {
  const { data } = await readSource(fetcher, rpc, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: address, data: '0x313ce567' }, 'latest'] }),
  }, signal, '链上节点', 16_384);
  // ERC-20 decimals() 的返回类型是 uint8，ABI 占满一个 32 字节槽。
  if (!isObject(data) || data.jsonrpc !== '2.0' || data.id !== 1 || 'error' in data ||
    typeof data.result !== 'string' || !/^0x0{62}[\da-f]{2}$/i.test(data.result)) {
    throw new Error('无法读取目标代币的 ERC-20 精度，请核对链与合约地址');
  }
  return Number(data.result);
}

async function quote(fetcher: Fetcher, chain: keyof typeof networks, address: string, amountIn: string, signal: AbortSignal) {
  const tokenIn = networks[chain].usdt;
  const query = new URLSearchParams({ tokenIn, tokenOut: address, amountIn });
  const { ok, data } = await readSource(fetcher, `https://aggregator-api.kyberswap.com/${chain}/api/v1/routes?${query}`, {
    method: 'GET', headers: { Accept: 'application/json', 'X-Client-Id': 'trading-platform' },
  }, signal, 'KyberSwap', 512 * 1024);
  if (!isObject(data)) throw new Error('KyberSwap 报价格式无效');
  if (!ok || data.code !== 0) {
    if (data.code === 4008 || data.code === 4010) throw new Error('KyberSwap 找不到该金额的可用兑换路线');
    if (data.code === 4011) throw new Error('KyberSwap 未收录所选代币');
    throw new Error('KyberSwap 未返回可用报价');
  }
  const route = isObject(data.data) ? data.data.routeSummary : undefined;
  if (!isObject(route)) throw new Error('KyberSwap 缺少兑换报价');
  if (typeof route.tokenIn !== 'string' || route.tokenIn.toLowerCase() !== tokenIn ||
    typeof route.tokenOut !== 'string' || route.tokenOut.toLowerCase() !== address || route.amountIn !== amountIn) {
    throw new Error('KyberSwap 返回的币种或输入金额不符');
  }
  if (typeof route.amountOut !== 'string' || !/^[1-9]\d{0,77}$/.test(route.amountOut) || BigInt(route.amountOut) > maxUint256) {
    throw new Error('KyberSwap 返回的买入数量无效');
  }
  // 线上返回 Unix 秒数，规范还允许以十进制字符串传输。
  const timestamp = route.timestamp;
  if ((typeof timestamp !== 'string' && typeof timestamp !== 'number') || !/^[1-9]\d{0,9}$/.test(String(timestamp))) {
    throw new Error('KyberSwap 缺少有效报价时间');
  }
  // Convert the route's USD gas estimate using its own USD valuation of the USDT input.
  const usd = (value: unknown) => typeof value === 'string' && /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)
    && value.length <= 80 ? Number(value) : NaN;
  const gasUsd = usd(route.gasUsd), amountInUsd = usd(route.amountInUsd);
  const gas = (Number(amountIn) / 10 ** networks[chain].decimals) * gasUsd / amountInUsd;
  const swapGasUsdt = gasUsd > 0 && amountInUsd > 0 && Number.isFinite(gas) && gas > 0 ? gas : null;
  return { rawQuantity: route.amountOut, at: Number(timestamp) * 1000, swapGasUsdt };
}

export async function readDex(input: DexInput, signal: AbortSignal, fetcher: Fetcher = fetch): Promise<DexQuote> {
  if (typeof input.chain !== 'string' || !Object.hasOwn(networks, input.chain)) throw new Error('不支持所选网络');
  const network = networks[input.chain];
  if (typeof input.address !== 'string' || !/^0x[a-f\d]{40}$/i.test(input.address)) throw new Error('目标代币的合约地址无效');
  const address = input.address.toLowerCase();
  if (isSettlementOrNative(input.chain, address)) throw new Error('请选择 USDT 以外的 ERC-20 代币合约');
  const amountIn = usdtUnits(input.amount, network.decimals);
  if (signal.aborted) throw new Error('链上报价请求已中止');
  const local = new AbortController();
  const active = anySignal([signal, local.signal], 8_000);
  try {
    const [route, decimals] = await Promise.all([
      quote(fetcher, input.chain, address, amountIn, active),
      tokenDecimals(fetcher, network.rpc, address, active),
    ]);
    active.throwIfAborted();
    return { ...route, decimals };
  } catch (error) {
    if (signal.aborted) throw new Error('链上报价请求已中止');
    if (active.aborted) throw new Error('链上报价读取超时');
    throw error;
  } finally {
    local.abort();
  }
}
