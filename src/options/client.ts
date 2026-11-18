// Bybit V5 options client for the options module (docs/options.md). Endpoints, parameters and the codes that prove a
// refusal follow the workbench client modules/greeks/app/bybit.py (commit 160e932). Every HTTP exchange has its own
// timeout; reads are never retried here (the loops read again next round); a signed write is sent a second time only after
// a timestamp refusal (10002), which proves the first one did not execute.
import { bybitAuthHeaders } from '../vendor/bybit.mjs';
import { VenueError } from '../connector.ts';
import type { MarketClient } from '../market/ipc.ts';
import type { OptionRead, OptionReply } from '../market/options-data.ts';
import { bybitPages, MAX_PAGES } from './listing.ts';
import { exchange, isRecord, type FetchLike, type HttpReply } from '../live/http.ts';
import { describe, validCredentials, type LiveCredentials } from '../live/values.ts';

export const BYBIT_HOST = 'https://api.bybit.com';
const RECV_WINDOW = '5000';
const MAX_CLOCK_OFFSET_MS = 300_000;
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
  // RFQ codes from Bybit's RFQ error table that refuse the request before anything is created, executed or canceled.
  '/v5/rfq/create-rfq': [110302, 110303, 110308, 110309, 110310, 110311, 110313, 110314, 110315, 110316, 110317, 110318, 110319, 110321],
  '/v5/rfq/execute-quote': [110300, 110301, 110302, 110304, 110312],
  '/v5/rfq/cancel-rfq': [110300],
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
  /** Current market connection and the original time of an actual price read. */
  marketEpoch?(): string | null;
  publicAt?(data: object): number;
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
  /** A limit order: GTC (the default) follows the book; IOC is the bounded fallback for an opening leg's remainder. */
  create(order: { symbol: string; side: 'Buy' | 'Sell'; qty: string; price: string; link: string; reduceOnly: boolean; timeInForce?: 'GTC' | 'IOC' }, signal: AbortSignal, beforeSend?: () => void): Promise<Row>;
  /** An order's fills by its id: a block trade (RFQ) leg has no orderLinkId of ours. */
  executionsByOrder(orderId: string, signal: AbortSignal): Promise<Row[]>;
  // ---- RFQ (G2c): this account as the requester -------------------------------------------------------------------
  rfqConfig(signal: AbortSignal): Promise<Row>;
  createRfq(request: { rfqLinkId: string; strategyType: string; counterparties: readonly string[]; legs: readonly { symbol: string; side: 'Buy' | 'Sell'; qty: string }[] }, signal: AbortSignal): Promise<Row>;
  /** The live list, or the history when `history`; by id when known, else by our link id. */
  rfqs(by: { rfqId: string } | { rfqLinkId: string }, history: boolean, signal: AbortSignal): Promise<Row[]>;
  quotes(rfqId: string, signal: AbortSignal): Promise<Row[]>;
  /** quoteSide Sell: each leg trades in the direction the RFQ asked for (the docs: for the taker, a Sell quote executes as the legs say). */
  executeQuote(rfqId: string, quoteId: string, signal: AbortSignal, beforeSend?: () => void): Promise<Row>;
  cancelRfq(rfqId: string, signal: AbortSignal): Promise<Row>;
  rfqTrades(rfqId: string, signal: AbortSignal): Promise<Row[]>;
  amend(symbol: string, link: string, price: string, signal: AbortSignal, beforeSend?: () => void): Promise<Row>;
  cancel(symbol: string, link: string, signal: AbortSignal): Promise<Row>;
}

export interface OptionsClientOptions { marketClient?: MarketClient; credentials: LiveCredentials; fetchImpl?: FetchLike; now?: () => number; timeoutMs?: number; host?: string }

export function createOptionsClient({ credentials, marketClient, fetchImpl = (url, init) => fetch(url, init), now = Date.now, timeoutMs = 10_000, host = BYBIT_HOST }: OptionsClientOptions): OptionsClient {
  if (!validCredentials(credentials)) throw new Error('Bybit 期权密钥不完整或格式无效');
  let offset = 0;

  const result = (reply: HttpReply, kind: 'read-failed' | 'uncertain'): Row => {
    const value = isRecord(reply.data) ? reply.data.result : undefined;
    if (!isRecord(value)) throw new VenueError(kind, 'Bybit 应答没有 result');
    return value;
  };

  const stamps = new WeakMap<object, { epoch: string | null; source: number; received: number }>();
  function publicAt(data: object): number {
    const stamp = stamps.get(data), time = now();
    if (!stamp || (marketClient && (stamp.epoch === null || stamp.epoch !== marketClient.epoch()))
      || Math.max(stamp.received, stamp.source) > time + 1000 || time - Math.min(stamp.received, stamp.source) > 30_000) {
      throw new VenueError('not-sent', '期权盘口已过期或行情连接已切换');
    }
    return Math.min(stamp.received, stamp.source);
  }
  async function publicData(op: OptionRead, signal: AbortSignal, symbol?: string) {
    const reply = marketClient ? await marketClient.call<OptionReply>('options.' + op, symbol === undefined ? {} : { symbol }, signal)
      : await (await import('../market/options-data.ts')).readOptionData(op, symbol, signal, { fetchImpl, now, timeoutMs, host });
    const value = reply?.value;
    if ((op === 'instruments' || op === 'tickers') ? (!Array.isArray(value) || value.some(row => !isRecord(row)))
      : (value === null ? op !== 'ticker' : !isRecord(value) || value.symbol !== (symbol ?? 'BTCUSDT'))) throw new VenueError('read-failed', 'Bybit 行情合约与请求不一致');
    if (value && op !== 'instruments') {
      if (!Number.isSafeInteger(reply.receivedAt) || (marketClient && !Number.isSafeInteger(reply.sourceAt))) throw new VenueError('read-failed', 'Bybit 行情缺少来源时间');
      stamps.set(value, { epoch: marketClient?.epoch() ?? null, source: reply.sourceAt ?? reply.receivedAt, received: reply.receivedAt });
      publicAt(value);
    }
    return value;
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

  async function signed(method: 'GET' | 'POST', path: string, params: Record<string, unknown>, signal: AbortSignal, guard?: () => void): Promise<Row> {
    const write = method === 'POST';
    const query = write ? '' : new URLSearchParams(params as Record<string, string>).toString();
    const body = write ? JSON.stringify(params) : undefined;
    for (let attempt = 0; ; attempt++) {
      let headers: Record<string, string>;
      try { headers = { ...bybitAuthHeaders(credentials, { timestamp: String(Math.round(now() + offset)), recvWindow: RECV_WINDOW, payload: body ?? query }), ...(write ? { 'Content-Type': 'application/json' } : {}) }; }
      catch (error) { throw new VenueError(!write ? 'read-failed' : attempt > 0 ? 'rejected' : 'not-sent', `Bybit 请求签名失败：${describe(error)}`); }
      let reply: HttpReply;
      try { reply = await exchange(fetchImpl, timeoutMs, { url: `${host}${path}${query ? `?${query}` : ''}`, method, headers, ...(body === undefined ? {} : { body }) }, { signal, ...(write ? { beforeSend: guard ?? (() => undefined) } : {}) }); }
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
  function pages(path: string, params: Record<string, string>, identity: readonly string[], signal: AbortSignal): Promise<Row[]> {
    return bybitPages(cursor => signed('GET', path, { ...params, ...(cursor ? { cursor } : {}) }, signal), identity);
  }

  const listOf = (data: Row, name: string): Row[] => {
    if (!Array.isArray(data.list) || data.list.some(item => !isRecord(item))) throw new VenueError('read-failed', `${name}格式无效`);
    return data.list as Row[];
  };

  return {
    syncClock,
    ...(marketClient ? { marketEpoch: () => marketClient.epoch() } : {}),
    publicAt,
    instruments: signal => publicData('instruments', signal) as Promise<Row[]>,
    tickers: signal => publicData('tickers', signal) as Promise<Row[]>,
    ticker: (symbol, signal) => publicData('ticker', signal, symbol) as Promise<Row | null>,
    underlying: signal => publicData('underlying', signal) as Promise<Row>,
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
    create: ({ symbol, side, qty, price, link, reduceOnly, timeInForce = 'GTC' }, signal, guard) => signed('POST', '/v5/order/create', { category: 'option', symbol, side, orderType: 'Limit', qty, price, timeInForce, orderLinkId: link, reduceOnly }, signal, guard),
    amend: (symbol, link, price, signal, guard) => signed('POST', '/v5/order/amend', { category: 'option', symbol, orderLinkId: link, price }, signal, guard),
    cancel: (symbol, link, signal) => signed('POST', '/v5/order/cancel', { category: 'option', symbol, orderLinkId: link }, signal),
    executionsByOrder: (orderId, signal) => pages('/v5/execution/list', { category: 'option', orderId, limit: '50' }, ['execId'], signal),
    rfqConfig: signal => signed('GET', '/v5/rfq/config', {}, signal),
    createRfq: ({ rfqLinkId, strategyType, counterparties, legs }, signal) => signed('POST', '/v5/rfq/create-rfq', { counterparties, rfqLinkId, strategyType, list: legs.map(leg => ({ category: 'option', symbol: leg.symbol, side: leg.side, qty: leg.qty })) }, signal),
    // One RFQ per query (by id or link): no paging.
    rfqs: async (by, history, signal) => listOf(await signed('GET', history ? '/v5/rfq/rfq-list' : '/v5/rfq/rfq-realtime', { traderType: 'request', ...by }, signal), '询价'),
    quotes: async (rfqId, signal) => listOf(await signed('GET', '/v5/rfq/quote-realtime', { traderType: 'request', rfqId }, signal), '询价报价'),
    executeQuote: (rfqId, quoteId, signal, guard) => signed('POST', '/v5/rfq/execute-quote', { rfqId, quoteId, quoteSide: 'Sell' }, signal, guard),
    cancelRfq: (rfqId, signal) => signed('POST', '/v5/rfq/cancel-rfq', { rfqId }, signal),
    rfqTrades: async (rfqId, signal) => listOf(await signed('GET', '/v5/rfq/trade-list', { traderType: 'request', rfqId }, signal), '询价成交'),
  };
}
