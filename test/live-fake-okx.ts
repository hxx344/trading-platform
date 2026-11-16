// Stateful OKX v5 stand-in shared by the connector tests and the executor end-to-end tests. No network is used.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { OrderRequest } from '../src/connector.ts';
import type { AccountBinding } from '../src/contracts.ts';

export const KEY = 'okx-test-key', SECRET = 'okx-test-secret', PASSPHRASE = 'okx-pass-phrase', NOW = 1_800_000_000_000, UID = '5551234567';
export const CREDENTIALS = { apiKey: KEY, apiSecret: SECRET, passphrase: PASSPHRASE };
export type Row = Record<string, unknown>;
export interface Call { method: string; path: string; params: URLSearchParams; body: Row | null; apiKey: string | null }
export const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
export const ok = (data: unknown[]): Response => json({ code: '0', msg: '', data });
/** A refusal of a whole request (code in the envelope). */
export const fail = (code: string, msg = 'error', status = 200): Response => json({ code, msg, data: [] }, status);
/** A refused write: code 1 with the one row's sCode, as OKX answers order requests. */
export const failWrite = (sCode: string, sMsg = 'refused', status = 200): Response => json({ code: '1', msg: 'All operations failed', data: [{ clOrdId: '', ordId: '', sCode, sMsg, tag: '' }] }, status);
export const binding = (overrides: Partial<AccountBinding> = {}): AccountBinding => ({ venue: 'okx', environment: 'mainnet', accountId: UID, accountMode: 'cross', credentialVersion: 1, ...overrides });
export const order = (overrides: Partial<OrderRequest> = {}): OrderRequest => ({
  clientOrderId: 'pa1-0123456789abcdef01234567-0', symbol: 'CLUSDT', side: 'buy', positionSide: 'long', quantity: '20', type: 'limit', limitPrice: '70.5', timeInForce: 'ioc', reduceOnly: false, ...overrides,
});
export const INST: Record<string, string> = { CLUSDT: 'CL-USDT-SWAP', BZUSDT: 'BZ-USDT-SWAP', SKHYUSDT: 'SKHY-USDT-SWAP', SKHYNIXUSDT: 'SKHYNIX-USDT-SWAP' };
export const instrumentRow = (instId: string, overrides: Row = {}): Row => ({
  instType: 'SWAP', instId, uly: instId.replace('-SWAP', ''), ctType: 'linear', settleCcy: 'USDT', ctValCcy: instId.split('-')[0], ctVal: '0.1', ctMult: '1',
  tickSz: '0.01', lotSz: '1', minSz: '1', maxLmtSz: '100000', maxMktSz: '5000', maxLmtAmt: '20000000', maxMktAmt: '1000000', state: 'live', ...overrides,
});

export class FakeOkx {
  clock = NOW;
  serverSkew = 0;
  calls: Call[] = [];
  posMode: 'net_mode' | 'long_short_mode' = 'net_mode';
  config: Row = { uid: UID, mainUid: UID, acctLv: '2', perm: 'read_only,trade', ip: '203.0.113.7', label: 'pa', level: 'Lv1' };
  instruments: Row[] = Object.values(INST).map(instId => instrumentRow(instId));
  orders = new Map<string, Row>();
  /** Position rows reported as they are; null reports the one-way `net` position kept per symbol (or flat). */
  positions: Row[] | null = null;
  algos: Row[] = [];
  bills: Row[] = [];
  /** How a non-market order fills: in full, one contract then the rest canceled (IOC) or resting, or not at all. */
  fill: 'full' | 'partial' | 'rest' = 'full';
  /** A post-only order that would take liquidity is canceled by the venue (cancelSource 31). */
  crossPostOnly = false;
  /** Every order moves the one-way position kept per symbol (in contracts). */
  net = new Map<string, number>();
  scripted = new Map<string, ((call: Call) => Response | Promise<Response>)[]>();
  nextOrderId = 700_000_000_000_000_001n;

  script(route: string, ...replies: ((call: Call) => Response | Promise<Response>)[]): void { this.scripted.set(route, [...(this.scripted.get(route) ?? []), ...replies]); }
  count(route: string): number { return this.calls.filter(call => `${call.method} ${call.path}` === route).length; }
  last(route: string): Call { return this.calls.filter(call => `${call.method} ${call.path}` === route).at(-1)!; }
  move(instId: string, side: unknown, quantity: number): void { this.net.set(instId, (this.net.get(instId) ?? 0) + (side === 'buy' ? quantity : -quantity)); }

  fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const parsed = new URL(url), headers = new Headers(init.headers), body = typeof init.body === 'string' ? init.body : '';
    assert.equal(parsed.origin, 'https://www.okx.com');
    assert.equal(init.redirect, 'error');
    const call: Call = { method: init.method ?? 'GET', path: parsed.pathname, params: parsed.searchParams, body: body ? JSON.parse(body) as Row : null, apiKey: headers.get('OK-ACCESS-KEY') };
    this.calls.push(call);
    const route = `${call.method} ${call.path}`, queue = this.scripted.get(route), p = call.params;
    if (call.path.startsWith('/api/v5/public/') || call.path.startsWith('/api/v5/market/')) {
      assert.equal(headers.get('OK-ACCESS-KEY'), null, '公共接口不带密钥');
      if (queue?.length) return queue.shift()!(call);
      if (call.path === '/api/v5/public/time') return ok([{ ts: String(this.clock + this.serverSkew) }]);
      if (call.path === '/api/v5/public/instruments') return ok(this.instruments.filter(row => row.instId === p.get('instId')));
      if (call.path === '/api/v5/market/books') return ok([{ asks: [['70.12', '125', '0', '3']], bids: [['70.10', '310', '0', '5']], ts: String(this.clock - 250) }]);
    }
    const refused = this.checkSignature(headers, call.method, `${parsed.pathname}${parsed.search}`, body);
    if (refused) return refused;
    if (call.method === 'POST') assert.equal(headers.get('Content-Type'), 'application/json');
    if (queue?.length) return queue.shift()!(call);
    switch (route) {
      case 'GET /api/v5/account/config': return ok([{ ...this.config, posMode: this.posMode }]);
      case 'GET /api/v5/account/positions': {
        const instId = p.get('instId')!;
        if (this.positions) return ok(this.positions.filter(row => row.instId === instId));
        const size = this.net.get(instId) ?? 0;
        return ok(size === 0 ? [] : [{ instType: 'SWAP', instId, mgnMode: 'cross', posSide: 'net', pos: String(size), avgPx: '70.11', markPx: '70.2', upl: '0.5', ccy: 'USDT' }]);
      }
      case 'GET /api/v5/trade/orders-pending': return ok([...this.orders.values()].filter(row => row.instId === p.get('instId') && ['live', 'partially_filled'].includes(row.state as string)));
      case 'GET /api/v5/trade/orders-algo-pending': return ok(this.algos.filter(row => row.instId === p.get('instId') && row.ordType === p.get('ordType')));
      case 'GET /api/v5/trade/order': {
        const row = this.orders.get(p.get('clOrdId')!);
        return row && row.instId === p.get('instId') ? ok([row]) : fail('51603', 'Order does not exist');
      }
      case 'POST /api/v5/trade/order': return this.create(call.body!);
      case 'POST /api/v5/trade/cancel-order': {
        const row = this.orders.get(call.body!.clOrdId as string);
        if (!row) return failWrite('51603', 'Order does not exist');
        if (!['live', 'partially_filled'].includes(row.state as string)) return failWrite('51400', 'Order cancellation failed as the order has been filled, canceled or does not exist');
        Object.assign(row, { state: 'canceled', cancelSource: '1', uTime: String(this.clock) });
        return ok([{ clOrdId: row.clOrdId, ordId: row.ordId, sCode: '0', sMsg: '' }]);
      }
      case 'GET /api/v5/account/bills-archive': {
        const after = p.get('after'), begin = Number(p.get('begin')), end = Number(p.get('end')), limit = Number(p.get('limit'));
        assert.deepEqual([p.get('instType'), p.get('ccy'), p.get('ctType')], ['SWAP', 'USDT', 'linear']);
        const rows = this.bills.filter(row => row.instId === p.get('instId') && Number(row.ts) >= begin && Number(row.ts) <= end && (after === null || BigInt(row.billId as string) < BigInt(after)))
          .sort((a, b) => (BigInt(b.billId as string) > BigInt(a.billId as string) ? 1 : -1));
        return ok(rows.slice(0, limit));
      }
    }
    return fail('50000', `unknown path ${route}`, 404);
  };

  checkSignature(headers: Headers, method: string, requestPath: string, body: string): Response | null {
    const timestamp = headers.get('OK-ACCESS-TIMESTAMP')!;
    assert.equal(headers.get('OK-ACCESS-KEY'), KEY);
    assert.equal(headers.get('OK-ACCESS-PASSPHRASE'), PASSPHRASE);
    assert.equal(headers.get('OK-ACCESS-SIGN'), createHmac('sha256', SECRET).update(timestamp + method + requestPath + body).digest('base64'));
    assert.match(timestamp, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    if (Math.abs(Date.parse(timestamp) - (this.clock + this.serverSkew)) > 30_000) return fail('50102', 'Timestamp request expired', 401);
    return null;
  }

  create(b: Row): Response {
    if (this.orders.has(b.clOrdId as string)) return failWrite('51016', 'Duplicated clOrdId');
    const sz = Number(b.sz), market = b.ordType === 'market', postOnly = b.ordType === 'post_only';
    let filled: number, state: string, cancelSource = '';
    if (market || this.fill === 'full') { filled = sz; state = 'filled'; }
    else if (postOnly && this.crossPostOnly) { filled = 0; state = 'canceled'; cancelSource = '31'; }
    else if (this.fill === 'partial') { filled = 1; state = b.ordType === 'ioc' ? 'canceled' : 'partially_filled'; if (state === 'canceled') cancelSource = '14'; }
    else { filled = 0; state = b.ordType === 'ioc' ? 'canceled' : 'live'; }
    if (filled) this.move(b.instId as string, b.side, filled);
    const ordId = String(this.nextOrderId++);
    this.orders.set(b.clOrdId as string, {
      instType: 'SWAP', instId: b.instId, ordId, clOrdId: b.clOrdId, tag: '', px: market ? '' : b.px, sz: b.sz, ordType: b.ordType, side: b.side, posSide: b.posSide, tdMode: b.tdMode,
      accFillSz: String(filled), fillPx: filled ? '70.11' : '', avgPx: filled ? '70.11' : '', state, reduceOnly: String(b.reduceOnly ?? false), cancelSource, cTime: String(this.clock), uTime: String(this.clock),
    });
    return ok([{ clOrdId: b.clOrdId, ordId, tag: '', ts: String(this.clock), sCode: '0', sMsg: 'Order placed' }]);
  }
}
