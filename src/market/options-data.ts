import { MarketError, type MarketOperations } from './protocol.ts';
import { exchange, isRecord, type FetchLike } from '../live/http.ts';
import { bybitPages } from '../options/listing.ts';
import type { Row } from '../options/client.ts';
import { exactKeys } from '../contracts.ts';

export type OptionRead = 'instruments' | 'tickers' | 'ticker' | 'underlying';
export interface OptionReply { value: Row | Row[] | null; sourceAt: number | null; receivedAt: number }

export async function readOptionData(op: OptionRead, symbol: string | undefined, signal: AbortSignal,
  { fetchImpl = fetch, now = Date.now, timeoutMs = 10000, host = 'https://api.bybit.com' }: { fetchImpl?: FetchLike; now?: () => number; timeoutMs?: number; host?: string } = {}): Promise<OptionReply> {
  const started = now();
  let sourceAt: number | null = null;
  async function get(path: string, params: Record<string, string>) {
    const reply = await exchange(fetchImpl, timeoutMs, { method: 'GET', url: host + path + '?' + new URLSearchParams(params) }, { signal });
    const body = reply.data;
    if (reply.status !== 200 || !isRecord(body) || body.retCode !== 0 || !isRecord(body.result)) throw new MarketError('Bybit 期权公开行情暂不可用');
    if (Number.isSafeInteger(body.time) && (body.time as number) > 0) sourceAt = Math.min(sourceAt ?? Infinity, body.time as number);
    return body.result;
  }
  let value: OptionReply['value'];
  if (op === 'instruments') {
    value = await bybitPages(cursor => get('/v5/market/instruments-info', { category: 'option', baseCoin: 'BTC', limit: '1000', ...(cursor ? { cursor } : {}) }), ['symbol']);
  } else {
    const params: Record<string, string> = op === 'underlying' ? { category: 'linear', symbol: 'BTCUSDT' }
      : op === 'ticker' && symbol ? { category: 'option', symbol } : { category: 'option', baseCoin: 'BTC' };
    const result = await get('/v5/market/tickers', params);
    if (!Array.isArray(result.list) || result.list.some(row => !isRecord(row))) throw new MarketError('Bybit 期权行情格式无效');
    const list: Row[] = result.list;
    value = op === 'tickers' ? list : list.find(row => row.symbol === params.symbol) ?? null;
    if (op === 'underlying' && !value) throw new MarketError('Bybit 没有返回 BTCUSDT 报价');
  }
  // Take the beginning of the uncached read, so transport, paging and IPC can only age a snapshot.
  return { value, sourceAt, receivedAt: started };
}

export function createOptionData(): MarketOperations {
  return {
    async call(op, input, signal) {
      if (!['options.instruments', 'options.tickers', 'options.ticker', 'options.underlying'].includes(op)) throw new MarketError('未知期权行情操作', 404);
      const kind = op.slice('options.'.length) as OptionRead;
      const { symbol } = exactKeys(input, kind === 'ticker' ? ['symbol'] : []);
      if (kind === 'ticker' && (typeof symbol !== 'string' || !/^BTC-\d{1,2}[A-Z]{3}\d{2}-\d+(?:\.\d+)?-[CP](?:-USDT|-USDC)?$/.test(symbol) || symbol.length > 80)) throw new MarketError('期权合约无效', 400);
      return readOptionData(kind, typeof symbol === 'string' ? symbol : undefined, signal);
    },
    stream() { throw new MarketError('期权链使用定时快照', 404); },
  };
}
