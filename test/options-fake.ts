// Stateful stand-in for Bybit's BTC option API, shared by the options tests. No network is used. The chain is a fixed
// grid around a 100 000 index with deltas linear in the strike, so the iron condor is 84k/98k/102k/116k.
export type Row = Record<string, unknown>;
export const UID = '12345678';
/** Friday 2026-11-13 10:00 UTC; the chain expires on Sunday 2026-11-15 08:00 UTC. */
export const FRIDAY = Date.UTC(2026, 10, 13, 10);
export const EXPIRY = Date.UTC(2026, 10, 15, 8);
const NEXT_EXPIRY = Date.UTC(2026, 10, 22, 8);
const DAY = '15NOV26';

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
export const ok = (result: unknown): Response => json({ retCode: 0, retMsg: 'OK', result });
export const fail = (retCode: number, status = 200): Response => json({ retCode, retMsg: 'refused', result: {} }, status);

/** dropped: the create never reaches the venue (a 503 with no order behind it). */
export type FillMode = 'fill' | 'rest' | 'partial' | 'lost-create' | 'invisible' | 'dropped';
export interface FakeOrder { symbol: string; side: 'Buy' | 'Sell'; qty: string; price: string; link: string; reduceOnly: boolean; orderId: string; status: string; cumExecQty: string; visible: boolean }

export const symbolOf = (strike: number, type: 'C' | 'P', day = DAY) => `BTC-${day}-${strike}-${type}`;

export class FakeOptions {
  index = 100_000;
  /** Shift applied to every quote (bid, ask, mark) on top of the grid. */
  quoteShift = 0;
  /** Per symbol shift on top of quoteShift. */
  shifts = new Map<string, number>();
  fillMode: FillMode = 'fill';
  /** Per symbol override of fillMode. */
  modes = new Map<string, FillMode>();
  orders = new Map<string, FakeOrder>();
  positions = new Map<string, { symbol: string; side: 'Buy' | 'Sell'; size: number }>();
  executions: Row[] = [];
  closed: Row[] = [];
  /** Positions hidden from the list (a transient empty read). */
  hidePositions = false;
  /** The fills endpoint refuses every read (a lost read the 收益 backfill has to repeat). */
  failExecutions = false;
  permissions: Row = { ContractTrade: [], Derivatives: [], Wallet: [], Spot: [], Options: ['OptionsTrade'] };
  ips: unknown = ['203.0.113.7'];
  uid: unknown = Number(UID);
  marginMode = 'REGULAR_MARGIN';
  calls: { method: string; path: string; params: URLSearchParams; body: Row | null }[] = [];
  creates = 0;
  /** How an IOC (the fallback) fares: fill, partial, rest (cancelled at once, nothing filled) or lost (fills, but the answer is a 5xx and the order cannot be read). */
  iocMode: 'fill' | 'partial' | 'rest' | 'lost' = 'fill';
  private seq = 0;
  /** Returns the fake's clock (ms); the tests shift it to a Friday. */
  private readonly clock: () => number;
  constructor(clock: () => number) { this.clock = clock; }

  rows(): Row[] {
    const rows: Row[] = [];
    for (const [expiry, day] of [[EXPIRY, DAY], [NEXT_EXPIRY, '22NOV26']] as const) {
      for (let strike = 80_000; strike <= 120_000; strike += 2_000) {
        for (const type of ['C', 'P'] as const) rows.push({ symbol: symbolOf(strike, type, day), strike, type, expiry });
      }
    }
    return rows;
  }
  delta(strike: number, type: 'C' | 'P'): number {
    const raw = 0.5 - (strike - this.index) / 40_000 * (type === 'C' ? 1 : -1);
    return Math.max(0.01, Math.min(0.99, raw)) * (type === 'C' ? 1 : -1);
  }
  quote(symbol: string) {
    const [, , strikeText, type] = symbol.split('-');
    const strike = Number(strikeText), delta = this.delta(strike, type as 'C' | 'P');
    const mark = Math.round(Math.abs(delta) * 2_000 + 50) + this.quoteShift + (this.shifts.get(symbol) ?? 0);
    return { symbol, markPrice: String(mark), bid1Price: String(mark - 10), ask1Price: String(mark + 10), bid1Size: '5', ask1Size: '5', delta: String(delta), gamma: '0.00001', vega: '20', theta: '-30', markIv: '0.5', volume24h: '10', openInterest: '100' };
  }

  private fill(order: FakeOrder, qty: number): void {
    const done = Number(order.cumExecQty) + qty;
    order.cumExecQty = String(Number(done.toFixed(8)));
    this.executions.push({ execId: `e${++this.seq}`, symbol: order.symbol, side: order.side, orderId: order.orderId, orderLinkId: order.link, execFee: '0.5', feeCurrency: order.symbol.endsWith('-USDT') ? 'USDT' : 'USDC', execPrice: order.price, execQty: String(qty), execTime: String(this.clock()), feeRate: '0.0003', closedSize: '', execType: 'Trade' });
    const side = order.reduceOnly ? (order.side === 'Buy' ? 'Sell' : 'Buy') : order.side, key = `${order.symbol}|${side}`;
    const position = this.positions.get(key) ?? { symbol: order.symbol, side, size: 0 };
    position.size = Number((position.size + (order.reduceOnly ? -qty : qty)).toFixed(8));
    if (position.size <= 0) {
      this.positions.delete(key);
      this.closed.push({ symbol: order.symbol, side, qty: order.qty, openTime: String(this.clock() - 1_000), closeTime: String(this.clock()), avgEntryPrice: '100', totalPnl: '1', totalOpenFee: '0.5', totalCloseFee: '0.5', deliveryFee: '0' });
    } else this.positions.set(key, position);
  }

  fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const parsed = new URL(url), path = parsed.pathname, params = parsed.searchParams;
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as Row : null;
    this.calls.push({ method: init.method ?? 'GET', path, params, body });
    const list = (rows: Row[]) => ok({ list: rows, nextPageCursor: '' });
    switch (path) {
      case '/v5/market/time': return ok({ timeNano: `${BigInt(Date.now()) * 1_000_000n}` });
      case '/v5/market/instruments-info': return list(this.rows().map(row => ({ symbol: row.symbol, deliveryTime: String(row.expiry), optionsType: row.type === 'C' ? 'Call' : 'Put', lotSizeFilter: { minOrderQty: '0.01', qtyStep: '0.01', maxOrderQty: '500' }, priceFilter: { tickSize: '5' } })));
      case '/v5/market/tickers': {
        if (params.get('category') === 'linear') return list([{ symbol: 'BTCUSDT', indexPrice: String(this.index), markPrice: String(this.index) }]);
        const symbol = params.get('symbol');
        return list((symbol ? [symbol] : this.rows().map(row => row.symbol as string)).map(item => this.quote(item)));
      }
      case '/v5/user/query-api': return ok({ readOnly: 0, permissions: this.permissions, ips: this.ips, userID: this.uid });
      case '/v5/account/info': return ok({ unifiedMarginStatus: 5, marginMode: this.marginMode });
      case '/v5/account/wallet-balance': return list([{ totalEquity: '10000', totalAvailableBalance: '8000', totalMarginBalance: '9000', totalWalletBalance: '10000', totalInitialMargin: '1000', totalMaintenanceMargin: '500', accountIMRate: '0.1', accountMMRate: '0.05' }]);
      case '/v5/asset/portfolio-margin': return ok({ wallet: { accountIM: '1200', accountMM: '600' }, assetPnlRange: [] });
      case '/v5/position/list': return list(this.hidePositions ? [] : [...this.positions.values()].map(item => ({ symbol: item.symbol, side: item.side, size: String(item.size), avgPrice: '100', markPrice: '100', unrealisedPnl: '0' })));
      case '/v5/order/realtime': case '/v5/order/history': {
        const order = this.orders.get(params.get('orderLinkId') ?? '');
        const open = order && !['Filled', 'Cancelled', 'PartiallyFilledCanceled'].includes(order.status);
        const show = order && order.visible && (path === '/v5/order/realtime' ? open : !open);
        return list(show ? [{ symbol: order.symbol, side: order.side, qty: order.qty, orderLinkId: order.link, orderId: order.orderId, orderStatus: order.status, cumExecQty: order.cumExecQty, price: order.price }] : []);
      }
      case '/v5/execution/list': if (this.failExecutions) return fail(10016, 503); return list(this.executions.filter(row => row.orderLinkId === params.get('orderLinkId')));
      case '/v5/position/get-closed-positions': {
        const start = Number(params.get('startTime')), end = Number(params.get('endTime'));
        return list(this.closed.filter(row => row.symbol === params.get('symbol') && Number(row.closeTime) >= start && Number(row.closeTime) <= end));
      }
      case '/v5/order/create': {
        this.creates++;
        const mode = this.modes.get(String(body!.symbol)) ?? this.fillMode;
        if (mode === 'dropped') return fail(10016, 503);
        const order: FakeOrder = { symbol: String(body!.symbol), side: body!.side as 'Buy' | 'Sell', qty: String(body!.qty), price: String(body!.price), link: String(body!.orderLinkId), reduceOnly: body!.reduceOnly === true, orderId: `o${++this.seq}`, status: 'New', cumExecQty: '0', visible: mode !== 'invisible' };
        this.orders.set(order.link, order);
        if (body!.timeInForce === 'IOC') {
          if (this.iocMode === 'fill' || this.iocMode === 'lost') { this.fill(order, Number(order.qty)); order.status = 'Filled'; }
          else if (this.iocMode === 'partial') { this.fill(order, Number(order.qty) / 2); order.status = 'PartiallyFilledCanceled'; }
          else order.status = 'Cancelled';
          if (this.iocMode === 'lost') { order.visible = false; return fail(10016, 503); }
          return ok({ orderId: order.orderId, orderLinkId: order.link });
        }
        if (mode === 'fill') { this.fill(order, Number(order.qty)); order.status = 'Filled'; }
        if (mode === 'partial') { this.fill(order, Number(order.qty) / 2); order.status = 'PartiallyFilled'; }
        if (mode === 'lost-create') return fail(10016, 503);
        return ok({ orderId: order.orderId, orderLinkId: order.link });
      }
      case '/v5/order/amend': {
        const order = this.orders.get(String(body!.orderLinkId));
        if (!order) return fail(110001);
        order.price = String(body!.price);
        return ok({ orderId: order.orderId });
      }
      case '/v5/order/cancel': {
        const order = this.orders.get(String(body!.orderLinkId));
        if (!order) return fail(110001);
        if (order.status === 'New') order.status = 'Cancelled';
        if (order.status === 'PartiallyFilled') order.status = 'PartiallyFilledCanceled';
        return ok({ orderId: order.orderId });
      }
      default: return fail(10001, 404);
    }
  };
}
