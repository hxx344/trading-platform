import { createHmac } from 'node:crypto';
import { BITGET_DEPOSIT_TTL } from '../../chain-arb/bitget-deposit-proof.ts';
import { bitgetDepositMinimum } from '../../chain-arb/bitget-network.ts';
import { CHAIN_ARB_CLOCK_SKEW_MS, isGateBaseSymbol, type Chain } from '../../chain-arb/model.ts';
import { isSettlementOrNative } from '../../chain-arb/networks.ts';
import { isObject } from '../../contracts.ts';
import { readJsonResponse } from '../../vendor/response.mjs';
import { PositionsPermissionError } from '../positions-values.ts';
import type { Credentials } from '../validation.ts';
import { evmAddress, type WalletNetwork, type WalletRead } from '../wallet-deposit-source.ts';

export type BitgetCredential = Extract<Credentials, { exchange: 'bitget' }>;
type Context = WalletRead<BitgetCredential>;
const paths = {
  uta: { permission: '/api/v3/account/info', coins: '/api/v3/market/coins', address: '/api/v3/account/deposit-address' },
  classic: { permission: '/api/v2/spot/account/info', coins: '/api/v2/spot/public/coins', address: '/api/v2/spot/wallet/deposit-address' },
} as const;
const settings = '/api/v3/account/settings';
const classicRead = new Set(['coor', 'cpor', 'stor', 'smor', 'ttor', 'wtor', 'taxr', 'chor', 'p2pr', 'pllr']);
const utaRead = new Set(['uta_mgt', 'uta_trade', 'copy_futures_position', 'copy_futures_order']);
// Signed replies identifying a blocked account, API key or missing permission invalidate all proofs for this key.
const refused = new Set(['25620', '40006', '40009', '40012', '40013', '40014', '40018', '40022', '40023', '40024', '40025',
  '40026', '40031', '40035', '40036', '40037', '40038', '40040', '40041', '40042', '40061', '40065', '40068']);
const networkIds = new Map<string, Chain>([['erc20', 'ethereum'], ['arbitrumone', 'arbitrum'], ['bep20', 'bsc']]);
export const bitgetDepositUnavailable = () => new Error('Bitget 充值条件或收款地址无法核实，请检查账本连接、账户模式与只读权限');
const invalid = bitgetDepositUnavailable;
const denied = () => new PositionsPermissionError('Bitget 当前账户模式或 API 权限不符合要求，请使用所选账户的只读 API');
export class BitgetReadThrottle extends Error {
  readonly delay: number;
  constructor(delay: number) { super('Bitget 请求受限，请稍后重试'); this.delay = delay; }
}

function checkRights(data: unknown, mode: BitgetCredential['accountMode']) {
  if (!isObject(data)) throw invalid();
  if (mode === 'uta' && data.permType === 'read-and-write') throw denied();
  const rights = mode === 'classic' ? data.authorities : data.permissions;
  if (!Array.isArray(rights) || rights.length > 64 || rights.some(p => typeof p !== 'string')) throw invalid();
  const permitted = mode === 'classic' ? classicRead : utaRead;
  if (!rights.length || !rights.every(p => permitted.has(p)) ||
    (mode === 'uta' && (data.permType !== 'read-only' || !rights.includes('uta_mgt')))) throw denied();
}

async function get(ctx: Context, kind: 'permission' | 'settings' | 'coins' | 'address', params?: URLSearchParams) {
  ctx.check();
  const c = ctx.credential, path = kind === 'settings' ? settings : paths[c.accountMode][kind];
  const target = path + (params ? '?' + params.toString() : ''), signed = kind !== 'coins';
  const start = ctx.now(), headers: Record<string, string> = { Accept: 'application/json' };
  if (signed) {
    headers['Content-Type'] = 'application/json';
    headers['ACCESS-KEY'] = c.apiKey;
    headers['ACCESS-TIMESTAMP'] = String(start);
    headers['ACCESS-PASSPHRASE'] = c.passphrase;
    headers['ACCESS-SIGN'] = createHmac('sha256', c.apiSecret).update(start + 'GET' + target).digest('base64');
  }
  let response: Response;
  try {
    response = await ctx.fetcher('https://api.bitget.com' + target,
      { method: 'GET', headers, redirect: 'manual', cache: 'no-store', signal: ctx.signal });
  } catch { throw invalid(); }
  if (response.redirected || response.headers.has('content-range') || ![200, 400, 401, 403].includes(response.status)) {
    void response.body?.cancel().catch(() => {});
    if (!response.redirected && response.status === 429) {
      const retry = response.headers.get('retry-after') ?? '';
      throw new BitgetReadThrottle(Math.max(60_000, /^\d{1,7}$/.test(retry) ? Number(retry) * 1000 : 0));
    }
    throw invalid();
  }
  if (signed && (response.status === 401 || response.status === 403)) {
    void response.body?.cancel().catch(() => {});
    throw denied();
  }
  let body: unknown;
  try {
    // An account refusal can arrive after the last waiter left. Read only a bounded denial and never reuse a late success.
    const late = ctx.signal.aborted;
    const maxBytes = late || response.status !== 200 ? 16 * 1024 : kind === 'coins' ? 8 * 1024 * 1024 : 128 * 1024;
    body = await readJsonResponse(response, { signal: late ? AbortSignal.timeout(500) : ctx.signal, maxBytes });
  } catch { throw invalid(); }
  if (!isObject(body)) throw invalid();
  if (signed && typeof body.code === 'string' && refused.has(body.code)) throw denied();
  if (body.code === '429') throw new BitgetReadThrottle(60_000);
  if (response.status !== 200 || body.code !== '00000') throw invalid();
  if (kind === 'permission') checkRights(body.data, c.accountMode);
  if (kind === 'settings' && isObject(body.data) && ['hybrid', 'upgrading', 'switching'].includes(String(body.data.accountMode))) throw denied();
  ctx.check();
  const received = ctx.now(), server = body.requestTime, rawAge = response.headers.get('age');
  const date = Date.parse(response.headers.get('date') ?? '');
  if (typeof server !== 'number' || !Number.isSafeInteger(server) || server > received + CHAIN_ARB_CLOCK_SKEW_MS ||
    (rawAge !== null && !/^\d{1,9}$/.test(rawAge)) || date > received + CHAIN_ARB_CLOCK_SKEW_MS || received < start) throw invalid();
  const at = Math.min(start, server, date, rawAge === null ? start : start - Number(rawAge) * 1000 - 999);
  if (!Number.isSafeInteger(at) || at <= ctx.deniedAt || received - at >= BITGET_DEPOSIT_TTL) throw invalid();
  return { at, data: body.data };
}

export async function verifyBitgetAccount(ctx: Context) {
  const info = await get(ctx, 'permission');
  if (!isObject(info.data) || typeof info.data.userId !== 'string' || !/^\d{1,32}$/.test(info.data.userId)) throw invalid();
  if (ctx.credential.accountMode === 'classic') return info.at;
  const mode = await get(ctx, 'settings');
  if (!isObject(mode.data) || typeof mode.data.uid !== 'string') throw invalid();
  if (mode.data.uid !== info.data.userId || mode.data.accountMode !== 'unified') throw denied();
  return Math.min(info.at, mode.at);
}

export async function readBitgetNetworks(ctx: Context) {
  const accountAt = await verifyBitgetAccount(ctx);
  const { at: coinAt, data } = await get(ctx, 'coins');
  if (!Array.isArray(data) || !data.length || data.length > 12_000) throw invalid();
  const seenSymbols = new Set<string>(), duplicateSymbols = new Set<string>();
  const seenContracts = new Set<string>(), duplicateContracts = new Set<string>();
  const rows = new Map<string, WalletNetwork>();
  for (const coin of data) {
    if (!isObject(coin) || typeof coin.coin !== 'string' || !coin.coin || !Array.isArray(coin.chains) || coin.chains.length > 128) throw invalid();
    const symbol = coin.coin;
    if (seenSymbols.has(symbol)) duplicateSymbols.add(symbol);
    seenSymbols.add(symbol);
    const seen = new Set<Chain>();
    for (const n of coin.chains) {
      if (!isObject(n) || typeof n.chain !== 'string' || !n.chain) throw invalid();
      const chain = networkIds.get(n.chain.toLowerCase());
      if (!chain) continue;
      const key = symbol + ':' + chain, contract = evmAddress(n.contractAddress) ? n.contractAddress.toLowerCase() : undefined;
      if (contract) {
        const identity = chain + ':' + contract;
        if (seenContracts.has(identity)) duplicateContracts.add(identity);
        seenContracts.add(identity);
      }
      if (seen.has(chain)) { rows.delete(key); continue; }
      seen.add(chain);
      if (!contract || !isGateBaseSymbol(symbol) || /^(?:10{2,}|\d+[MK])(?=\p{L})/u.test(symbol) || isSettlementOrNative(chain, contract)) continue;
      const minDeposit = bitgetDepositMinimum(coin, n);
      if (minDeposit !== undefined) rows.set(key, { symbol, chain, network: n.chain, contract, minDeposit });
    }
  }
  for (const [key, row] of rows) if (duplicateSymbols.has(row.symbol) || duplicateContracts.has(row.chain + ':' + row.contract)) rows.delete(key);
  const at = Math.min(accountAt, coinAt);
  return { at, expiresAt: at + BITGET_DEPOSIT_TTL, rows };
}

export async function readBitgetAddress(ctx: Context, row: WalletNetwork) {
  const { at, data } = await get(ctx, 'address', new URLSearchParams({ coin: row.symbol, chain: row.network }));
  if (!isObject(data) || data.coin !== row.symbol || typeof data.chain !== 'string' || data.chain.toLowerCase() !== row.network.toLowerCase() ||
    (data.tag !== '' && data.tag !== null) || (Object.hasOwn(data, 'memo') && data.memo !== null && data.memo !== '') ||
    !evmAddress(data.address) || isSettlementOrNative(row.chain, data.address) || data.address.toLowerCase() === row.contract) throw invalid();
  return { at, address: data.address.toLowerCase() };
}
