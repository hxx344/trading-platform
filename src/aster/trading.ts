// Real ASTER trading connector for the ADL emergency handling and the read-only position display. Every call is made
// with the named sub-account's own API wallet. Endpoints, weights, the reduce-only rule and the ADL evidence fields
// mirror the workbench's Python implementation (modules/aster/trading/adl.py, adl_exchange.py, adl_events.py).
import { VenueError, type CallOptions, type SendOptions } from '../connector.ts';
import { ADL_CLIENT_ID, type AdlCapabilities, type AdlConnector, type AdlOrderRequest } from '../adl-contracts.ts';
import type { AsterPositionsConnector } from '../positions.ts';
import { cmp, decimal, isZero } from '../decimal.ts';
import { isRecord } from '../live/http.ts';
import { ShapeError, describe, identifier, list, record } from '../live/values.ts';
import { classify, ORDER_REJECTIONS, TRANSFER_REJECTIONS, type AsterClient, type AsterCredentials, type Failure, type Priority } from './client.ts';

/** forceOrders answers at most this many rows per page (weight 50). */
export const FORCE_ORDER_PAGE = 100;
const RULE_TTL_MS = 30_000;
/** More symbols than this read every open order at once (weight 40) instead of one request per symbol (weight 1 each). */
const PER_SYMBOL_ORDER_READS = 10;
const ORDER_STATUS: Record<string, 'new' | 'partially-filled' | 'filled' | 'canceled' | 'expired' | 'rejected'> = {
  NEW: 'new', PENDING_NEW: 'new', PARTIALLY_FILLED: 'partially-filled', FILLED: 'filled', CANCELED: 'canceled', EXPIRED: 'expired', EXPIRED_IN_MATCH: 'expired', REJECTED: 'rejected',
};

export interface AsterTradingOptions {
  client: AsterClient;
  /** Credentials by account address (lower case); a throw refuses the call before anything is sent. */
  credentials: (accountId: string) => AsterCredentials;
  now?: () => number;
}

const fail = (failure: Failure, write: boolean): VenueError => new VenueError(write ? (failure.kind === 'rejected' ? 'rejected' : 'uncertain') : 'read-failed', failure.message);
function num(value: unknown, name: string, sign: 'any' | 'nonnegative' | 'positive' = 'nonnegative'): string {
  const textual = typeof value === 'number' && Number.isFinite(value) && !/e/i.test(String(value)) ? String(value) : value;
  try { if (typeof textual !== 'string') throw new Error(); return decimal(textual, sign); } catch { throw new ShapeError(`${name}无效`); }
}
function time(value: unknown, name: string): number {
  const parsed = typeof value === 'string' && /^\d{1,16}$/.test(value) ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 0) throw new ShapeError(`${name}无效`);
  return parsed;
}
const price = (value: unknown, name: string): string | null => { if (value === undefined || value === null || value === '') return null; const parsed = num(value, name); return isZero(parsed) ? null : parsed; };
const sideOf = (value: unknown): 'buy' | 'sell' => value === 'BUY' ? 'buy' : value === 'SELL' ? 'sell' : (() => { throw new ShapeError('买卖方向无效'); })();
const positionSideOf = (value: unknown): 'LONG' | 'SHORT' | 'BOTH' => value === 'LONG' || value === 'SHORT' || value === 'BOTH' ? value : (() => { throw new ShapeError('持仓方向无效'); })();

/** One order answer in the executor's report shape. */
export function orderReport(data: unknown): Record<string, unknown> {
  const row = record(data, '委托回报');
  const status = ORDER_STATUS[String(row.status)];
  if (!status) throw new ShapeError('委托状态无效');
  const filledQuantity = num(row.executedQty, '成交数量');
  return {
    clientOrderId: typeof row.clientOrderId === 'string' ? row.clientOrderId : '', orderId: identifier(row.orderId, '交易所订单号'),
    symbol: typeof row.symbol === 'string' ? row.symbol : '', side: sideOf(row.side), positionSide: positionSideOf(row.positionSide),
    quantity: num(row.origQty, '委托数量', 'positive'), filledQuantity,
    averagePrice: isZero(filledQuantity) ? null : price(row.avgPrice, '成交均价'), status,
    updateTime: time(row.updateTime ?? row.time, '委托更新时间'),
  };
}

const EVIDENCE_STATUS: Record<string, string> = { NEW: 'new', NEW_ADL: 'new-adl', PARTIALLY_FILLED: 'partially-filled', FILLED: 'filled', CANCELED: 'canceled', EXPIRED: 'expired', EXPIRED_IN_MATCH: 'expired' };
/** A rejected ADL order filled nothing and never will, which is what a canceled one with no fill says. */
function evidenceStatus(status: unknown, filled: string): string {
  if (status === 'REJECTED' && isZero(filled)) return 'canceled';
  const mapped = EVIDENCE_STATUS[String(status)];
  if (!mapped) throw new ShapeError('ADL 订单状态无效');
  return mapped;
}

/** One forceOrders row (autoCloseType=ADL) in the executor's evidence shape. */
export function restEvidence(row: unknown): Record<string, unknown> {
  const item = record(row, 'ADL 历史行');
  const filledQuantity = num(item.executedQty, 'ADL 累计成交');
  return {
    clientOrderId: item.clientOrderId, symbol: item.symbol, orderId: identifier(item.orderId, 'ADL 订单号'), positionSide: positionSideOf(item.positionSide), side: sideOf(item.side),
    quantity: num(item.origQty, 'ADL 原始数量', 'positive'), filledQuantity, status: evidenceStatus(item.status, filledQuantity),
    averagePrice: isZero(filledQuantity) ? null : price(item.avgPrice, 'ADL 成交均价'), time: time(item.time, 'ADL 创建时间'), updateTime: time(item.updateTime, 'ADL 更新时间'),
  };
}

/** An ORDER_TRADE_UPDATE push for an ADL close in the evidence shape, or null for any other event. */
export function streamEvidence(event: unknown): Record<string, unknown> | null {
  if (!isRecord(event) || event.e !== 'ORDER_TRADE_UPDATE' || !isRecord(event.o) || event.o.c !== ADL_CLIENT_ID) return null;
  const order = event.o;
  try {
    const filledQuantity = num(order.z, 'ADL 累计成交');
    const created = time(order.T, 'ADL 订单时间');
    const updated = Math.max(created, time(event.T ?? event.E, 'ADL 事件时间'));
    return {
      clientOrderId: ADL_CLIENT_ID, symbol: order.s, orderId: identifier(order.i, 'ADL 订单号'), positionSide: positionSideOf(order.ps), side: sideOf(order.S),
      quantity: num(order.q, 'ADL 原始数量', 'positive'), filledQuantity, status: evidenceStatus(order.X, filledQuantity),
      averagePrice: isZero(filledQuantity) ? null : price(order.ap, 'ADL 成交均价'), time: created, updateTime: updated,
    };
  } catch { return { clientOrderId: ADL_CLIENT_ID, malformed: true }; }
}

/** LOT_SIZE and MARKET_LOT_SIZE combined, as the Python client does: common step, largest minimum, smallest maximum. */
export function marketRule(row: Record<string, unknown>): { quantityStep: string; minQuantity: string; maxMarketQuantity: string } {
  const filters = new Map<string, Record<string, unknown>>();
  for (const item of list(row.filters, '交易过滤器', 100)) {
    const filter = record(item, '交易过滤器');
    if (typeof filter.filterType !== 'string' || filters.has(filter.filterType)) throw new ShapeError('交易过滤器无效或重复');
    filters.set(filter.filterType, filter);
  }
  const lots = [filters.get('LOT_SIZE'), filters.get('MARKET_LOT_SIZE')].filter((item): item is Record<string, unknown> => item !== undefined);
  if (!filters.has('LOT_SIZE')) throw new ShapeError('缺少数量过滤器');
  const steps: string[] = [], minimums: string[] = [], maximums: string[] = [];
  for (const lot of lots) {
    const step = num(lot.stepSize, '数量步长'), minimum = num(lot.minQty, '最小数量'), maximum = num(lot.maxQty, '最大数量');
    if (!isZero(step)) {
      if (!isZero(minimum) && !isMultipleOf(minimum, step)) throw new ShapeError('数量下限与步长不对齐');
      steps.push(step);
    }
    minimums.push(minimum);
    if (!isZero(maximum)) maximums.push(maximum);
  }
  if (!steps.length || !maximums.length) throw new ShapeError('缺少有效的数量步长或上限');
  const quantityStep = commonStep(steps);
  const minQuantity = [...minimums, quantityStep].reduce((a, b) => cmp(a, b) >= 0 ? a : b);
  const maxMarketQuantity = maximums.reduce((a, b) => cmp(a, b) <= 0 ? a : b);
  return { quantityStep, minQuantity, maxMarketQuantity };
}
const SCALE = 18;
const toUnits = (value: string): bigint => { const [whole, fraction = ''] = value.split('.'); return BigInt(whole! + fraction.padEnd(SCALE, '0').slice(0, SCALE)); };
const fromBig = (value: bigint): string => { const digits = value.toString().padStart(SCALE + 1, '0'); const whole = digits.slice(0, -SCALE), fraction = digits.slice(-SCALE).replace(/0+$/, ''); return fraction ? `${whole}.${fraction}` : whole; };
const gcd = (a: bigint, b: bigint): bigint => { while (b) [a, b] = [b, a % b]; return a; };
const isMultipleOf = (value: string, step: string): boolean => toUnits(value) % toUnits(step) === 0n;
/** Least common multiple of decimal steps, exact on the 18-place grid. */
function commonStep(steps: string[]): string {
  return fromBig(steps.map(toUnits).reduce((a, b) => a / gcd(a, b) * b));
}

export class AsterTradingConnector implements AdlConnector, AsterPositionsConnector {
  readonly venue = 'aster' as const;
  readonly capabilities: AdlCapabilities & { transport: 'live' } = { transport: 'live', historyPageLimit: FORCE_ORDER_PAGE };
  private readonly client: AsterClient;
  private readonly credentials: (accountId: string) => AsterCredentials;
  private readonly now: () => number;
  private readonly listeners = new Set<(accountId: string, row: unknown) => void>();
  private exchangeInfo: { at: number; symbols: Map<string, Record<string, unknown>> } | null = null;
  constructor({ client, credentials, now = Date.now }: AsterTradingOptions) {
    this.client = client; this.credentials = credentials; this.now = now;
  }

  private creds(accountId: string, write: boolean): AsterCredentials {
    try {
      const found = this.credentials(accountId);
      if (found.user !== accountId) throw new Error('凭据的账户地址与请求不一致');
      return found;
    } catch (error) { throw new VenueError(write ? 'not-sent' : 'read-failed', `账户 ***${accountId.slice(-4)} 没有可用凭据：${describe(error)}`); }
  }
  private async read(accountId: string, path: string, params: Record<string, string>, weight: number, signal: AbortSignal, priority: Priority): Promise<unknown> {
    const reply = await this.client.signed(this.creds(accountId, false), { method: 'GET', path, params, weight, priority, withUser: true }, { signal });
    const failure = classify(reply, TRANSFER_REJECTIONS, this.client.requestBudget, path);
    if (failure?.kind === 'not-found') return null;
    if (failure) throw fail(failure, false);
    return reply.data;
  }
  private shaped<T>(build: () => T, write: boolean): T {
    try { return build(); }
    catch (error) {
      if (error instanceof ShapeError) throw new VenueError(write ? 'uncertain' : 'read-failed', `ASTER 应答无法解析：${error.message}`);
      throw error;
    }
  }

  private async openOrders(accountId: string, symbols: readonly string[], signal: AbortSignal): Promise<unknown[]> {
    if (symbols.length > PER_SYMBOL_ORDER_READS) {
      const all = await this.read(accountId, '/fapi/v3/openOrders', {}, 40, signal, 'adl');
      return this.shaped(() => list(all, '挂单列表', 10_000), false);
    }
    const rows: unknown[] = [];
    for (const symbol of symbols) {
      const answer = await this.read(accountId, '/fapi/v3/openOrders', { symbol }, 1, signal, 'adl');
      rows.push(...this.shaped(() => list(answer, '挂单列表', 10_000), false));
    }
    return rows;
  }

  /** Positions from positionRisk cross-checked against the account's own position list, plus canTrade and open orders. */
  async account(accountId: string, symbols: readonly string[], { signal }: CallOptions): Promise<unknown> {
    const wanted = new Set(symbols);
    const account = await this.read(accountId, '/fapi/v3/accountWithJoinMargin', {}, 5, signal, 'adl');
    const risk = await this.read(accountId, '/fapi/v3/positionRisk', {}, 5, signal, 'adl');
    const orders = await this.openOrders(accountId, [...wanted], signal);
    return this.shaped(() => {
      const info = record(account, '账户信息');
      if (typeof info.canTrade !== 'boolean') throw new ShapeError('账户交易权限无效');
      const own = new Map<string, string>();
      for (const item of list(info.positions ?? [], '账户持仓', 10_000)) {
        const row = record(item, '账户持仓行');
        if (!wanted.has(String(row.symbol))) continue;
        const amount = num(row.positionAmt, '账户持仓数量', 'any');
        if (!isZero(amount)) own.set(`${String(row.symbol)}|${positionSideOf(row.positionSide)}`, amount);
      }
      const positions: Record<string, unknown>[] = [];
      const seen = new Map<string, string>();
      for (const item of list(risk, '持仓风险', 10_000)) {
        const row = record(item, '持仓行');
        if (!wanted.has(String(row.symbol))) continue;
        const positionSide = positionSideOf(row.positionSide), amount = num(row.positionAmt, '持仓数量', 'any');
        positions.push({ symbol: row.symbol, positionSide, amount, markPrice: num(row.markPrice, '标记价格', 'positive'), updateTime: time(row.updateTime ?? 0, '持仓更新时间') });
        if (!isZero(amount)) seen.set(`${String(row.symbol)}|${positionSide}`, amount);
      }
      // The two projections must agree on every non-zero position, or the scene has not settled yet (Python check).
      if (own.size !== seen.size || [...seen].some(([key, amount]) => own.get(key) === undefined || cmp(own.get(key)!, amount) !== 0)) throw new ShapeError('账户与持仓接口的非零仓位尚未同步');
      const openOrders = orders.map(item => { const row = record(item, '挂单行'); return { symbol: row.symbol, clientOrderId: row.clientOrderId }; })
        .filter(row => wanted.has(String(row.symbol)));
      return { accountId, canTrade: info.canTrade, positions, openOrders, receivedAt: this.now() };
    }, false);
  }

  /** Every position row of the account (display only, normal priority). */
  async positions(accountId: string, { signal }: CallOptions): Promise<unknown> {
    const risk = await this.read(accountId, '/fapi/v3/positionRisk', {}, 5, signal, 'normal');
    return this.shaped(() => ({
      accountId, receivedAt: this.now(),
      positions: list(risk, '持仓风险', 10_000).map(item => {
        const row = record(item, '持仓行');
        return {
          symbol: row.symbol, positionSide: positionSideOf(row.positionSide), amount: num(row.positionAmt, '持仓数量', 'any'), entryPrice: num(row.entryPrice, '开仓均价'),
          markPrice: num(row.markPrice, '标记价格'), unrealizedProfit: num(row.unRealizedProfit ?? row.unrealizedProfit, '未实现盈亏', 'any'), updateTime: time(row.updateTime ?? 0, '持仓更新时间'),
        };
      }),
    }), false);
  }

  async rule(symbol: string, { signal }: CallOptions): Promise<unknown> {
    const at = this.now();
    if (!this.exchangeInfo || at - this.exchangeInfo.at >= RULE_TTL_MS || at < this.exchangeInfo.at) {
      const reply = await this.client.public('/fapi/v3/exchangeInfo', {}, 1, 'adl', signal);
      const failure = classify(reply, TRANSFER_REJECTIONS, this.client.requestBudget, 'exchangeInfo');
      if (failure) throw fail(failure, false);
      const symbols = this.shaped(() => {
        const map = new Map<string, Record<string, unknown>>();
        for (const item of list(record(reply.data, '交易规则').symbols, '合约列表', 5_000)) {
          const row = record(item, '合约规则');
          if (typeof row.symbol !== 'string' || map.has(row.symbol)) throw new ShapeError('合约规则缺少代码或重复');
          map.set(row.symbol, row);
        }
        return map;
      }, false);
      // Cached for RULE_TTL_MS from the read's start; a failed or malformed read is never cached.
      this.exchangeInfo = { at, symbols };
    }
    const row = this.exchangeInfo.symbols.get(symbol);
    if (!row) throw new VenueError('read-failed', `ASTER 没有 ${symbol} 合约`);
    return this.shaped(() => {
      const types = row.orderTypes ?? row.OrderType;
      if (!Array.isArray(types) || types.some(kind => typeof kind !== 'string')) throw new ShapeError(`${symbol} 委托类型无效`);
      if (typeof row.quoteAsset !== 'string') throw new ShapeError(`${symbol} 计价资产无效`);
      return { symbol, ...marketRule(row), tradable: row.status === 'TRADING' && types.includes('MARKET'), quoteAsset: row.quoteAsset };
    }, false);
  }

  /** Hedge mode reduces through positionSide alone (ASTER refuses reduceOnly there); one-way mode sends reduceOnly. */
  async place(accountId: string, request: AdlOrderRequest, { signal, beforeSend }: SendOptions): Promise<unknown> {
    const params: Record<string, string> = {
      symbol: request.symbol, side: request.side === 'buy' ? 'BUY' : 'SELL', positionSide: request.positionSide, type: 'MARKET',
      quantity: request.quantity, newClientOrderId: request.clientOrderId, newOrderRespType: 'RESULT',
      ...(request.positionSide === 'BOTH' ? { reduceOnly: 'true' } : {}),
    };
    return this.write(accountId, 'POST', params, signal, beforeSend);
  }
  async query(accountId: string, symbol: string, clientOrderId: string, { signal }: CallOptions): Promise<unknown> {
    const data = await this.read(accountId, '/fapi/v3/order', { symbol, origClientOrderId: clientOrderId }, 1, signal, 'adl');
    return data === null ? null : this.shaped(() => orderReport(data), false);
  }
  async cancel(accountId: string, symbol: string, clientOrderId: string, { signal, beforeSend }: SendOptions): Promise<unknown> {
    return this.write(accountId, 'DELETE', { symbol, origClientOrderId: clientOrderId }, signal, beforeSend);
  }
  private async write(accountId: string, method: 'POST' | 'DELETE', params: Record<string, string>, signal: AbortSignal, beforeSend: () => void): Promise<unknown> {
    const reply = await this.client.signed(this.creds(accountId, true), { method, path: '/fapi/v3/order', params, weight: 1, priority: 'adl', withUser: true }, { signal, beforeSend });
    const failure = classify(reply, ORDER_REJECTIONS, this.client.requestBudget, method === 'POST' ? '下单' : '撤单');
    if (failure) throw fail(failure.kind === 'not-found' ? { ...failure, kind: 'unknown' } : failure, true);
    return this.shaped(() => orderReport(reply.data), true);
  }

  /** One forceOrders page (autoCloseType=ADL), oldest update first. */
  async adlHistory(accountId: string, { from, to }: { from: number; to: number }, limit: number, { signal }: CallOptions): Promise<unknown[]> {
    const size = Math.min(Math.max(1, Math.floor(limit)), FORCE_ORDER_PAGE);
    const data = await this.read(accountId, '/fapi/v3/forceOrders', { autoCloseType: 'ADL', startTime: String(from), endTime: String(to), limit: String(size) }, 50, signal, 'adl');
    return this.shaped(() => list(data, 'ADL 历史', size).map(restEvidence).sort((a, b) => (a.updateTime as number) - (b.updateTime as number)), false);
  }

  subscribe(listener: (accountId: string, row: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  /** Feeds one raw user-stream message of an account; only ADL closes reach the listeners. */
  push(accountId: string, event: unknown): void {
    const row = streamEvidence(event);
    if (row) for (const listener of this.listeners) listener(accountId, row);
  }
}
