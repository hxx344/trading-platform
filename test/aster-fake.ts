// ASTER futures v3 stand-in for the real connectors: verifies every signature like the venue would (EIP-712 over the
// Python-style urlencoded parameters, signer recovered from the signature), keeps nonces strictly increasing per
// signer and answers from plain test-owned state. No network is used.
import { recoverAddress } from 'ethers';
import { addressOf, asterDigest, pythonUrlencode } from '../src/aster/eip712.ts';
import type { AsterCredentials } from '../src/aster/client.ts';

export type Row = Record<string, unknown>;
export interface AsterCall { method: string; path: string; params: Record<string, string>; signed: boolean }
export const NOW = 1_800_000_000_000;

const key = (byte: string): string => '0x' + byte.repeat(32);
function wallet(user: string, signerByte: string): AsterCredentials {
  const privateKey = key(signerByte);
  return { user, signer: addressOf(privateKey), privateKey };
}
export const MAIN = wallet('0x' + '1a'.repeat(20), '21');
export const LONG = wallet('0x' + '2b'.repeat(20), '22');
export const SHORT = wallet('0x' + '3c'.repeat(20), '23');
export const CREDENTIALS = new Map([MAIN, LONG, SHORT].map(item => [item.user, item]));

// BigInt values are written as bare JSON numbers, like the venue's 64-bit ids.
export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body, (_key, value) => typeof value === 'bigint' ? `__big${value}__` : value).replace(/"__big(\d+)__"/g, '$1'), { status, headers: { 'content-type': 'application/json', ...headers } });

export function symbolInfo(overrides: Row = {}): Row {
  return {
    symbol: 'BTCUSDT', status: 'TRADING', quoteAsset: 'USDT', marginAsset: 'USDT', orderTypes: ['LIMIT', 'MARKET'],
    filters: [
      { filterType: 'PRICE_FILTER', tickSize: '0.1' },
      { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '1000' },
      { filterType: 'MARKET_LOT_SIZE', stepSize: '0.002', minQty: '0.002', maxQty: '120' },
      { filterType: 'MIN_NOTIONAL', notional: '5' },
    ],
    ...overrides,
  };
}

export class FakeAster {
  calls: AsterCall[] = [];
  /** Requests whose signature or nonce the venue would refuse. */
  refused: string[] = [];
  lastNonce = new Map<string, bigint>();
  subAccounts: Row[] = [
    { parentAccount: true, accountId: 1, address: MAIN.user },
    { parentAccount: false, accountId: 2, address: LONG.user, status: 'NORMAL' },
    { parentAccount: false, accountId: 3, address: SHORT.user },
  ];
  accounts = new Map<string, Row>([
    [LONG.user, { accountId: 2, canTrade: true, assets: [{ asset: 'USD1', availableBalance: '120.5', maxWithdrawAmount: '110', marginBalance: '150' }, { asset: 'USDT', availableBalance: '9' }], positions: [] }],
    [SHORT.user, { accountId: 3, canTrade: true, assets: [{ asset: 'USD1', availableBalance: '80', maxWithdrawAmount: '80', walletBalance: '90', unrealizedProfit: '-5.5' }], positions: [] }],
  ]);
  income = new Map<string, Row[]>();
  risk = new Map<string, Row[]>();
  openOrders = new Map<string, Row[]>();
  orders = new Map<string, Row>();
  forceOrders = new Map<string, Row[]>();
  info: Row[] = [symbolInfo()];
  /** One-shot replies by "METHOD path", consumed in order. */
  scripted = new Map<string, ((call: AsterCall) => Response | Promise<Response>)[]>();

  script(route: string, ...replies: ((call: AsterCall) => Response | Promise<Response>)[]): void { this.scripted.set(route, [...(this.scripted.get(route) ?? []), ...replies]); }
  count(path: string): number { return this.calls.filter(call => call.path === path).length; }

  fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const parsed = new URL(url);
    if (parsed.origin !== 'https://fapi.asterdex.com') throw new Error(`unexpected host ${parsed.origin}`);
    const method = init.method ?? 'GET';
    const raw = method === 'GET' ? parsed.search.slice(1) : String(init.body ?? '');
    if (method !== 'GET' && (init.headers as Record<string, string>)['Content-Type'] !== 'application/x-www-form-urlencoded') throw new Error('body must be form encoded');
    if (method !== 'GET' && parsed.search) throw new Error('mutation params must be in the body');
    const params: Record<string, string> = {};
    for (const [name, value] of new URLSearchParams(raw)) params[name] = value;
    const signed = 'signature' in params;
    const call: AsterCall = { method, path: parsed.pathname, params, signed };
    this.calls.push(call);
    if (signed) {
      const problem = this.verify(raw, params);
      if (problem) { this.refused.push(problem); return json({ code: -1022, msg: problem }, 400); }
    }
    const scripted = this.scripted.get(`${method} ${parsed.pathname}`)?.shift();
    if (scripted) return scripted(call);
    return this.route(call);
  };

  /** Same check the venue makes: the signature over everything before it recovers the signer, and the nonce moves forward. */
  private verify(raw: string, params: Record<string, string>): string | null {
    const signature = params.signature!;
    if (!raw.endsWith(`&signature=${encodeURIComponent(signature)}`) && !raw.endsWith(`&signature=${signature}`)) return 'signature must be last';
    const { signature: _drop, ...rest } = params;
    if (pythonUrlencode(rest) !== raw.slice(0, raw.lastIndexOf('&signature='))) return 'parameter encoding differs';
    let recovered: string;
    try { recovered = recoverAddress(asterDigest(raw.slice(0, raw.lastIndexOf('&signature='))), signature).toLowerCase(); } catch { return 'bad signature'; }
    if (recovered !== params.signer) return 'signer mismatch';
    const nonce = BigInt(params.nonce ?? '0');
    const last = this.lastNonce.get(recovered) ?? 0n;
    if (nonce <= last) return 'nonce reused';
    this.lastNonce.set(recovered, nonce);
    return null;
  }

  private owner(call: AsterCall): string {
    const user = call.params.user;
    if (!user) throw new Error(`${call.path} needs user`);
    const credentials = CREDENTIALS.get(user);
    if (!credentials || credentials.signer !== call.params.signer) throw new Error('signer not authorized for user');
    return user;
  }

  private route(call: AsterCall): Response {
    const { method, path, params } = call;
    switch (`${method} ${path}`) {
      case 'GET /fapi/v3/getSubAccountList': this.owner(call); return json(this.subAccounts);
      case 'GET /fapi/v3/accountWithJoinMargin': return json(this.accounts.get(this.owner(call)) ?? { assets: [] });
      case 'GET /fapi/v3/income': {
        const from = Number(params.startTime), to = params.endTime === undefined ? Number.MAX_SAFE_INTEGER : Number(params.endTime);
        const rows = (this.income.get(this.owner(call)) ?? []).filter(row => (row.time as number) >= from && (row.time as number) <= to);
        return json(rows.slice(0, Number(params.limit)));
      }
      case 'POST /fapi/v3/subAccountTransfer':
        if ('user' in params) throw new Error('transfer must be signed without user');
        if (params.signer !== MAIN.signer) throw new Error('transfer must be signed by the main account');
        return json({ code: 200, msg: 'success' });
      case 'GET /fapi/v3/positionRisk': return json(this.risk.get(this.owner(call)) ?? []);
      case 'GET /fapi/v3/openOrders': {
        const rows = this.openOrders.get(this.owner(call)) ?? [];
        return json(params.symbol ? rows.filter(row => row.symbol === params.symbol) : rows);
      }
      case 'POST /fapi/v3/order': {
        this.owner(call);
        const report = { clientOrderId: params.newClientOrderId, orderId: 9_000_000_001, symbol: params.symbol, side: params.side, positionSide: params.positionSide, origQty: params.quantity, executedQty: params.quantity, avgPrice: '100.5', status: 'FILLED', updateTime: NOW };
        this.orders.set(params.newClientOrderId!, report);
        return json(report);
      }
      case 'GET /fapi/v3/order': {
        this.owner(call);
        const found = this.orders.get(params.origClientOrderId!);
        return found ? json(found) : json({ code: -2013, msg: 'Order does not exist.' }, 400);
      }
      case 'DELETE /fapi/v3/order': {
        this.owner(call);
        const found = this.orders.get(params.origClientOrderId!);
        return found ? json({ ...found, status: 'CANCELED' }) : json({ code: -2011, msg: 'Unknown order sent.' }, 400);
      }
      case 'GET /fapi/v3/forceOrders': {
        if (params.autoCloseType !== 'ADL') throw new Error('ADL history must ask for autoCloseType=ADL');
        const from = Number(params.startTime), to = Number(params.endTime);
        return json((this.forceOrders.get(this.owner(call)) ?? []).filter(row => (row.updateTime as number) >= from && (row.updateTime as number) <= to).slice(0, Number(params.limit)));
      }
      case 'GET /fapi/v3/exchangeInfo': return json({ symbols: this.info });
      case 'POST /fapi/v3/listenKey': this.owner(call); return json({ listenKey: `key${this.count('/fapi/v3/listenKey')}` });
      case 'PUT /fapi/v3/listenKey': this.owner(call); return json({});
      default: return json({ code: -1000, msg: `no route ${method} ${path}` }, 404);
    }
  }
}
