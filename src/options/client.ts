// Bybit V5 options client for the options module (docs/options.md). Endpoints, parameters and the codes that prove a
// refusal follow the workbench client modules/greeks/app/bybit.py (commit 160e932). Every HTTP exchange has its own
// timeout; reads are never retried here (the loops read again next round); a signed write is sent a second time only after
// a timestamp refusal (10002), which proves the first one did not execute.
import { bybitAuthHeaders } from '../vendor/bybit.mjs';
import { VenueError } from '../connector.ts';
import { exchange, isRecord, type FetchLike, type HttpReply } from '../live/http.ts';
import { describe, validCredentials, type LiveCredentials } from '../live/values.ts';

export const BYBIT_HOST = 'https://api.bybit.com';
const RECV_WINDOW = '5000';
const MAX_CLOCK_OFFSET_MS = 300_000;
const MAX_PAGES = 100;
const DAY_MS = 86_400_000;

// Only codes that prove a refusal before execution; anything else (server timeout or internal error, duplicate request,
// orderLinkId already exists, order still processing, undocumented codes) stays unknown. Copied from bybit.py.
const COMMON_REFUSALS = [10001, 10002, 10003, 10004, 10005, 10006, 10007, 10008, 10009, 10010, 10017, 10018, 10024, 10027, 10029];
const ORDER_STATE = [110001, 110008, 110010];
const ORDER_PRICE = [110003, 110120, 110121];
const TRADING_CLOSED = [110063, 110066, 110074, 110134];
const TRADE_REFUSALS: Record<string, readonly number[]> = {
  '/v5/order/create': [...ORDER_PRICE, ...TRADING_CLOSED, 110004, 110006, 110007, 110012, 110044, 110045, 110017, 110094, 110020, 110021, 110023, 110042, 110032, 110040],
  '/v5/order/amend': [...ORDER_STATE, ...ORDER_PRICE, ...TRADING_CLOSED, 110022, 110064],
  '/v5/order/cancel': ORDER_STATE,
};
export const isRefusal = (code: number, path: string): boolean => COMMON_REFUSALS.includes(code) || (TRADE_REFUSALS[path] ?? []).includes(code);

// Fixed wording per documented code; the venue's own message may carry request details and is never echoed.
const CODE_TEXT: Record<number, string> = {
  10002: '请求时间戳超出接收窗口，请校准服务器时钟', 10003: 'API 密钥无效或与环境不匹配', 10004: '签名校验失败，请核对 API 密钥与私钥',
  10005: 'API 密钥权限不足', 10006: '请求过于频繁，已被限频', 10009: 'Bybit 服务受限，本服务器所在地区当前不可访问',
  10010: '本服务器 IP 不在该 API 密钥的白名单内', 10024: '触发 Bybit 合规限制',
};

/** A refusal of a write, with the venue's code so the engine can tell "order already gone" from others. */
export class BybitRefusal extends VenueError {
  readonly code: number;
  constructor(code: number, message: string) { super('rejected', message); this.code = code; }
}

function codeOf(reply: HttpReply): number | undefined {
  const raw = isRecord(reply.data) ? reply.data.retCode : undefined;
  return Number.isSafeInteger(raw) && (raw as number) >= 0 && (raw as number) < 10_000_000 ? raw as number : undefined;
}
function failureText(reply: HttpReply, code: number | undefined): string {
  const http = reply.status >= 200 && reply.status < 300 ? 'Bybit' : `Bybit HTTP ${reply.status}`;
  if (code === undefined) return reply.status === 403 ? `${http}（无错误码）：本服务器 IP 可能被临时封禁或所在地区受限` : `${http}（应答没有错误码）`;
  return `${http} 错误码 ${code}${CODE_TEXT[code] ? `：${CODE_TEXT[code]}` : ''}`;
}

export type Row = Record<string, unknown>;
export interface OptionsClient {
  syncClock(signal: AbortSignal): Promise<void>;
  instruments(signal: AbortSignal): Promise<Row[]>;
  tickers(signal: AbortSignal): Promise<Row[]>;
  ticker(symbol: string, signal: AbortSignal): Promise<Row | null>;
  underlying(signal: AbortSignal): Promise<Row>;
  queryApi(signal: AbortSignal): Promise<Row>;
  accountInfo(signal: AbortSignal): Promise<Row>;
  walletBalance(signal: AbortSignal): Promise<Row>;
  portfolioMargin(signal: AbortSignal): Promise<Row>;
  positions(signal: AbortSignal): Promise<Row[]>;
  openOrders(signal: AbortSignal): Promise<Row[]>;
  /** The order by its link id from the open list, then the history; null when neither has it (unknown, not cancelled). */
  order(symbol: string, link: string, signal: AbortSignal): Promise<Row | null>;
  executions(link: string, signal: AbortSignal): Promise<Row[]>;
  closedPositions(symbol: string, startMs: number, endMs: number, signal: AbortSignal): Promise<Row[]>;
  create(order: { symbol: string; side: 'Buy' | 'Sell'; qty: string; price: string; link: string; reduceOnly: boolean }, signal: AbortSignal): Promise<Row>;
  amend(symbol: string, link: string, price: string, signal: AbortSignal): Promise<Row>;
  cancel(symbol: string, link: string, signal: AbortSignal): Promise<Row>;
}

export interface OptionsClientOptions { credentials: LiveCredentials; fetchImpl?: FetchLike; now?: () => number; timeoutMs?: number; host?: string }

export function createOptionsClient({ credentials, fetchImpl = (url, init) => fetch(url, init), now = Date.now, timeoutMs = 10_000, host = BYBIT_HOST }: OptionsClientOptions): OptionsClient {
  if (!validCredentials(credentials)) throw new Error('Bybit 期权密钥不完整或格式无效');
  let offset = 0;

  const result = (reply: HttpReply, kind: 'read-failed' | 'uncertain'): Row => {
    const value = isRecord(reply.data) ? reply.data.result : undefined;
    if (!isRecord(value)) throw new VenueError(kind, 'Bybit 应答没有 result');
    return value;
  };

  async function publicGet(path: string, params: Record<string, string>, signal: AbortSignal): Promise<Row> {
    const reply = await exchange(fetchImpl, timeoutMs, { url: `${host}${path}?${new URLSearchParams(params)}`, method: 'GET' }, { signal });
    const code = codeOf(reply);
    if (reply.status < 200 || reply.status >= 300 || code !== 0) throw new VenueError('read-failed', failureText(reply, code));
    return result(reply, 'read-failed');
  }

  async function syncClock(signal: AbortSignal): Promise<void> {
    const before = now();
    const reply = await exchange(fetchImpl, timeoutMs, { url: `${host}/v5/market/time`, method: 'GET', maxBytes: 4096 }, { signal });
    const after = now();
    const nano = codeOf(reply) === 0 && isRecord(reply.data) && isRecord(reply.data.result) ? reply.data.result.timeNano : undefined;
    if (typeof nano !== 'string' || !/^\d{1,25}$/.test(nano) || after - before > 5_000) throw new VenueError('read-failed', 'Bybit 服务器时间读取失败');
    const next = Math.round(Number(BigInt(nano) / 1_000_000n) - (before + after) / 2);
    if (!Number.isSafeInteger(next) || Math.abs(next) > MAX_CLOCK_OFFSET_MS) throw new VenueError('read-failed', `本机时钟与 Bybit 相差 ${next} 毫秒，超过上限`);
    offset = next;
  }

  async function signed(method: 'GET' | 'POST', path: string, params: Record<string, string | boolean>, signal: AbortSignal): Promise<Row> {
    const write = method === 'POST';
    const query = write ? '' : new URLSearchParams(params as Record<string, string>).toString();
    const body = write ? JSON.stringify(params) : undefined;
    for (let attempt = 0; ; attempt++) {
      let headers: Record<string, string>;
      try { headers = { ...bybitAuthHeaders(credentials, { timestamp: String(Math.round(now() + offset)), recvWindow: RECV_WINDOW, payload: body ?? query }), ...(write ? { 'Content-Type': 'application/json' } : {}) }; }
      catch (error) { throw new VenueError(!write ? 'read-failed' : attempt > 0 ? 'rejected' : 'not-sent', `Bybit 请求签名失败：${describe(error)}`); }
      let reply: HttpReply;
      try { reply = await exchange(fetchImpl, timeoutMs, { url: `${host}${path}${query ? `?${query}` : ''}`, method, headers, ...(body === undefined ? {} : { body }) }, { signal, ...(write ? { beforeSend: () => undefined } : {}) }); }
      catch (error) {
        // The first transmission was refused for its timestamp; a resend stopped before sending leaves that refusal.
        if (attempt > 0 && error instanceof VenueError && error.kind === 'not-sent') throw new BybitRefusal(10002, `Bybit 时间戳被拒后未重发：${error.message}`);
        throw error;
      }
      const code = codeOf(reply);
      if (reply.status >= 200 && reply.status < 300 && code === 0) return result(reply, write ? 'uncertain' : 'read-failed');
      if (code === 10002 && attempt === 0 && reply.status < 500) {
        try { await syncClock(signal); } catch (error) {
          if (write) throw new BybitRefusal(10002, `${failureText(reply, code)}；时钟同步失败：${describe(error)}`);
          throw new VenueError('read-failed', `${failureText(reply, code)}；时钟同步失败：${describe(error)}`);
        }
        continue;
      }
      if (!write) throw new VenueError('read-failed', failureText(reply, code));
      if (code !== undefined && reply.status < 500 && isRefusal(code, path)) throw new BybitRefusal(code, failureText(reply, code));
      throw new VenueError('uncertain', failureText(reply, code));
    }
  }

  /** Every page of a listing; a repeated or malformed cursor, a missing identity or too many pages fails the read. */
  async function pages(path: string, params: Record<string, string>, identity: readonly string[], signal: AbortSignal, isPublic = false): Promise<Row[]> {
    const rows: Row[] = [], seenRows = new Set<string>(), seenCursors = new Set<string>();
    let cursor = '';
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = { ...params, ...(cursor ? { cursor } : {}) };
      const data = isPublic ? await publicGet(path, query, signal) : await signed('GET', path, query, signal);
      if (!Array.isArray(data.list) || data.list.some(item => !isRecord(item))) throw new VenueError('read-failed', 'Bybit 列表格式无效');
      for (const row of data.list as Row[]) {
        const values = identity.map(field => row[field]);
        if (values.some(value => typeof value !== 'string') || !values[0]) throw new VenueError('read-failed', 'Bybit 列表行缺少标识');
        const key = JSON.stringify(values);
        if (!seenRows.has(key)) { seenRows.add(key); rows.push(row); }
      }
      const next = data.nextPageCursor;
      if (next === undefined || next === null || next === '') return rows;
      if (typeof next !== 'string' || next.length > 2000 || seenCursors.has(next)) throw new VenueError('read-failed', 'Bybit 分页游标无效或重复');
      seenCursors.add(next); cursor = next;
    }
    throw new VenueError('read-failed', `Bybit 列表超过 ${MAX_PAGES} 页`);
  }

  const listOf = (data: Row, name: string): Row[] => {
    if (!Array.isArray(data.list) || data.list.some(item => !isRecord(item))) throw new VenueError('read-failed', `${name}格式无效`);
    return data.list as Row[];
  };

  return {
    syncClock,
    instruments: signal => pages('/v5/market/instruments-info', { category: 'option', baseCoin: 'BTC', limit: '1000' }, ['symbol'], signal, true),
    tickers: async signal => listOf(await publicGet('/v5/market/tickers', { category: 'option', baseCoin: 'BTC' }, signal), '期权报价'),
    ticker: async (symbol, signal) => listOf(await publicGet('/v5/market/tickers', { category: 'option', symbol }, signal), '期权报价').find(row => row.symbol === symbol) ?? null,
    underlying: async signal => {
      const rows = listOf(await publicGet('/v5/market/tickers', { category: 'linear', symbol: 'BTCUSDT' }, signal), 'BTC 指数');
      const row = rows.find(item => item.symbol === 'BTCUSDT');
      if (!row) throw new VenueError('read-failed', 'Bybit 没有返回 BTCUSDT 报价');
      return row;
    },
    queryApi: signal => signed('GET', '/v5/user/query-api', {}, signal),
    accountInfo: signal => signed('GET', '/v5/account/info', {}, signal),
    walletBalance: async signal => {
      const rows = listOf(await signed('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED', coin: 'USDT,USDC' }, signal), '钱包余额');
      if (!rows.length) throw new VenueError('read-failed', '钱包余额为空');
      return rows[0]!;
    },
    portfolioMargin: signal => signed('GET', '/v5/asset/portfolio-margin', { baseCoin: 'BTC' }, signal),
    positions: signal => pages('/v5/position/list', { category: 'option', baseCoin: 'BTC', limit: '200' }, ['symbol', 'side'], signal),
    openOrders: signal => pages('/v5/order/realtime', { category: 'option', baseCoin: 'BTC', limit: '50' }, ['orderId'], signal),
    order: async (symbol, link, signal) => {
      // Closed records can leave the open list after a venue restart; absence from both is unknown, never a cancellation.
      for (const path of ['/v5/order/realtime', '/v5/order/history']) {
        const rows = listOf(await signed('GET', path, { category: 'option', symbol, orderLinkId: link }, signal), '订单');
        const match = rows.find(row => row.orderLinkId === link && row.symbol === symbol);
        if (match) return match;
      }
      return null;
    },
    executions: (link, signal) => pages('/v5/execution/list', { category: 'option', baseCoin: 'BTC', orderLinkId: link, limit: '50' }, ['execId'], signal),
    closedPositions: async (symbol, startMs, endMs, signal) => {
      // At most seven days per query.
      const rows: Row[] = [];
      for (let start = startMs; start <= endMs; start += 7 * DAY_MS) {
        const stop = Math.min(endMs, start + 7 * DAY_MS - 1), seen = new Set<string>();
        let cursor = '', done = false;
        for (let page = 0; page < MAX_PAGES && !done; page++) {
          const data = await signed('GET', '/v5/position/get-closed-positions', { category: 'option', symbol, startTime: String(start), endTime: String(stop), limit: '100', ...(cursor ? { cursor } : {}) }, signal);
          rows.push(...listOf(data, '平仓历史'));
          const next = data.nextPageCursor;
          if (next === undefined || next === null || next === '') { done = true; break; }
          if (typeof next !== 'string' || seen.has(next)) throw new VenueError('read-failed', '平仓历史分页游标无效或重复');
          seen.add(next); cursor = next;
        }
        if (!done) throw new VenueError('read-failed', '平仓历史超过页数上限');
      }
      return rows;
    },
    create: ({ symbol, side, qty, price, link, reduceOnly }, signal) => signed('POST', '/v5/order/create', { category: 'option', symbol, side, orderType: 'Limit', qty, price, timeInForce: 'GTC', orderLinkId: link, reduceOnly }, signal),
    amend: (symbol, link, price, signal) => signed('POST', '/v5/order/amend', { category: 'option', symbol, orderLinkId: link, price }, signal),
    cancel: (symbol, link, signal) => signed('POST', '/v5/order/cancel', { category: 'option', symbol, orderLinkId: link }, signal),
  };
}
