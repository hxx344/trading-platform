import { anySignal } from '../any-signal.mjs';
import { isObject } from '../contracts.ts';
import { fromUnits, min, units } from '../decimal.ts';
import { readJsonResponse } from '../vendor/response.mjs';
import { CHAIN_ARB_CLOCK_SKEW_MS, CHAIN_ARB_TTL_MS, isGateBaseSymbol, type Chain, type ChainArbInput } from './model.ts';

const NETWORKS: Record<Chain, readonly string[]> = {
  ethereum: ['ETH'],
  arbitrum: ['ARBEVM', 'ARB', 'ARBITRUM'],
  bsc: ['BSC'],
};
export function gateChain(name: unknown): Chain | undefined {
  if (typeof name !== 'string') return undefined;
  return (Object.keys(NETWORKS) as Chain[]).find(chain => NETWORKS[chain].includes(name));
}
type Input = Pick<ChainArbInput, 'chain' | 'address' | 'symbol'>;
type Row = Record<string, unknown>;
type GateValue = string | number;
type Limits<T extends GateValue> = { step: T; minQuantity?: T; minNotional?: T; maxQuantity?: T; maxNotional?: T };
export type GateLeg = ({ bids: [GateValue, GateValue][]; at: number } & Limits<GateValue>) | { error: string; rateLimited?: true };
const LEVELS = 100;
const METADATA_TTL = 30_000;
const LIMIT_ERROR = 'Gate 下单数量或金额限制无效';
const BOOK_ERROR = 'Gate 买盘价格、数量或排序异常';
const IDENTITY_ERROR = 'Gate 未能唯一匹配所选链与代币合约地址';
const PROTECTION_ERROR = 'Gate 市价单价格保护参数或基准价无效';
const ONE = units('1');
const PRODUCT_SCALE = ONE * ONE;
const PRODUCT_DIGITS = PRODUCT_SCALE.toString().length - 1;

class GateError extends Error {}
class GateRateLimit extends GateError { readonly status = 429; }
function fail(message: string): never { throw new GateError(message); }
function timestamp(value: unknown): number {
  if (typeof value === 'number') return value;
  return typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
}
function scaled(value: unknown, error: string): bigint {
  // Gate publishes decimals as strings. Older integer number fields are safe only in this range.
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value))) fail(error);
  try { return units(String(value)); } catch { fail(error); }
}
function positive(value: unknown, error: string): string {
  const n = scaled(value, error);
  return n > 0n ? fromUnits(n) : fail(error);
}
function baseUnits(contracts: unknown, multiplier: unknown, error: string): string {
  const size = scaled(contracts, error), unit = scaled(multiplier, error);
  if (size <= 0n || unit <= 0n) fail(error);
  // Both venue operands may have 18 decimal places; keep all 36 places of their product.
  const product = size * unit;
  const integer = String(product / PRODUCT_SCALE);
  const fraction = String(product % PRODUCT_SCALE).padStart(PRODUCT_DIGITS, '0').replace(/0+$/, '');
  return fraction ? integer + '.' + fraction : integer;
}
// Compare bid × 1 against reference × (1 - ratio) in fixed-point units, including exact boundary prices.
function sellFloor(reference: unknown, ratio: unknown): bigint {
  const price = scaled(reference, PROTECTION_ERROR), fraction = scaled(ratio, PROTECTION_ERROR);
  if (price <= 0n || fraction < 0n || fraction >= ONE) fail(PROTECTION_ERROR);
  return price * (ONE - fraction);
}
function limit(value: unknown, zeroUnlimited = false): string | undefined {
  if (value == null || (zeroUnlimited && scaled(value, LIMIT_ERROR) === 0n)) return undefined;
  return positive(value, LIMIT_ERROR);
}
function smaller(a?: string, b?: string): string | undefined {
  return a === undefined ? b : b === undefined ? a : min(a, b);
}
function started(seconds: unknown, now: number) {
  return seconds === undefined || (typeof seconds === 'number' && Number.isSafeInteger(seconds)
    && seconds >= 0 && seconds * 1000 <= now);
}
function enabled(...disabled: unknown[]): boolean | null {
  if (disabled.includes(true)) return false;
  return disabled.every(value => value === false) ? true : null;
}

function verifyIdentity(currency: Row, input: Input): Row {
  if (currency.currency !== input.symbol || !Array.isArray(currency.chains)) fail(IDENTITY_ERROR);
  const selected = currency.chains.filter((chain: unknown): chain is Row =>
    isObject(chain) && gateChain(chain.name) === input.chain);
  if (selected.length !== 1 || typeof selected[0].addr !== 'string'
    || selected[0].addr.toLowerCase() !== input.address.toLowerCase()) fail(IDENTITY_ERROR);
  return selected[0];
}

export function gateSpotSellable(pair: Row, currency: Row, now: number): boolean {
  return currency.trade_disabled === false && currency.delisted === false && pair.type === 'normal'
    && (pair.trade_status === 'tradable' || pair.trade_status === 'sellable') && started(pair.sell_start, now)
    && (pair.delisting_time === undefined || pair.delisting_time === 0);
}

function spotLimits(pair: Row, currency: Row, symbol: string, now: number): Limits<string> {
  if (pair.id !== symbol + '_USDT' || pair.base !== symbol || pair.quote !== 'USDT') fail('Gate 现货交易对身份不符');
  if (!gateSpotSellable(pair, currency, now)) fail('Gate 现货已停牌、待退市或未开放卖出');
  const precision = pair.amount_precision;
  if (typeof precision !== 'number' || !Number.isInteger(precision) || precision < 0 || precision > 18) fail('Gate 现货数量精度无效');
  return {
    step: fromUnits(ONE / (10n ** BigInt(precision))),
    minQuantity: limit(pair.min_base_amount), minNotional: limit(pair.min_quote_amount),
    maxQuantity: smaller(limit(pair.max_base_amount), limit(pair.market_order_max_stock, true)),
    maxNotional: smaller(limit(pair.max_quote_amount), limit(pair.market_order_max_money, true)),
  };
}

function perpLimits(contract: Row, pair: string, now: number): Limits<string> {
  if (contract.name !== pair || contract.type !== 'direct' || (contract.contract_type !== '' && contract.contract_type !== 'crypto')) {
    fail('Gate 未确认同币 USDT 线性永续合约');
  }
  if (contract.in_delisting !== false || contract.status !== 'trading' || contract.is_pre_market !== false
    || !started(contract.launch_time, now) || (contract.delisting_time !== undefined && contract.delisting_time !== 0)
    || (contract.delisted_time !== undefined && contract.delisted_time !== 0)) fail('Gate 永续已停牌、待退市或未开放开仓');
  const unit = positive(contract.quanto_multiplier, 'Gate 永续合约乘数无效');
  const max = positive(contract.order_size_max, LIMIT_ERROR);
  const marketMax = limit(contract.market_order_size_max, true);
  const maxQuantity = baseUnits(marketMax === undefined ? max : min(max, marketMax), unit, LIMIT_ERROR);
  // Gate documents min/max, but no fractional order increment. Estimate openings in whole contracts.
  return { step: unit, minQuantity: baseUnits(contract.order_size_min, contract.quanto_multiplier, LIMIT_ERROR), maxQuantity };
}

function readBook(book: Row, limits: Limits<string>, market: 'spot' | 'perp', meta: Row, referenceAt: number, now: number): GateLeg {
  // Both timestamps come from Gate. Spot uses milliseconds, perpetuals use fractional seconds.
  // update is the last book change; a fresh current (response generation) cannot revive an old book.
  const scale = market === 'spot' ? 1 : 1000;
  const update = Math.floor(timestamp(book.update) * scale);
  const current = Math.floor(timestamp(book.current) * scale);
  if (!Number.isSafeInteger(update) || !Number.isSafeInteger(current) || update <= 0 || update > current
    || current > now + CHAIN_ARB_CLOCK_SKEW_MS) fail('Gate 盘口时间异常');
  const at = Math.min(update, referenceAt);
  if (now - at >= CHAIN_ARB_TTL_MS) fail('Gate 盘口已过期');
  if (!Array.isArray(book.bids) || book.bids.length === 0) fail('Gate 买盘深度不足');
  if (book.bids.length > LEVELS) fail(BOOK_ERROR);
  let previous: bigint | undefined;
  // Gate's spot example uses best bid (announcement 48909). For perpetuals, help article 22083
  // applies both the best-bid slippage cutoff and a separate mark-price deviation cutoff.
  let floor = market === 'perp' ? sellFloor(meta.mark_price, meta.order_price_deviate) : 0n;
  const slip = market === 'perp' ? meta.market_order_slip_ratio : meta.slippage;
  const bids: [string, string][] = [];
  for (const row of book.bids) {
    let rawPrice: unknown, quantity: string;
    if (market === 'spot') {
      if (!Array.isArray(row) || row.length !== 2) fail(BOOK_ERROR);
      rawPrice = row[0];
      quantity = positive(row[1], BOOK_ERROR);
    } else {
      if (!isObject(row)) fail(BOOK_ERROR);
      rawPrice = row.p;
      quantity = baseUnits(row.s, meta.quanto_multiplier, BOOK_ERROR);
    }
    const price = scaled(rawPrice, BOOK_ERROR);
    if (price <= 0n || (previous !== undefined && price >= previous)) fail(BOOK_ERROR);
    if (previous === undefined) {
      const bidFloor = sellFloor(rawPrice, slip);
      if (bidFloor > floor) floor = bidFloor;
    }
    previous = price;
    if (price * ONE >= floor) bids.push([fromUnits(price), quantity]);
  }
  if (!bids.length) fail('Gate 市价单保护范围内没有可成交买盘');
  return { bids, at, ...limits };
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
type Snapshot = { row: Row; at: number };
export function createGateReader({ fetcher = fetch, clock = Date.now }: { fetcher?: Fetcher; clock?: () => number } = {}) {
  const cache = new Map<string, Snapshot>();

  async function get(path: string, signal: AbortSignal, metadata: boolean, failure: string): Promise<Snapshot> {
    const startedAt = clock();
    const cached = cache.get(path);
    if (metadata && cached && startedAt < cached.at + METADATA_TTL) return cached;
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (path.startsWith('/futures/')) headers['X-Gate-Size-Decimal'] = '1';
      const response = await fetcher('https://api.gateio.ws/api/v4' + path, { method: 'GET', signal, redirect: 'error', cache: 'no-store', headers });
      const age = Number(response.headers.get('age') ?? 0) * 1000;
      const ttl = metadata ? METADATA_TTL : CHAIN_ARB_TTL_MS;
      if (!response.ok || !Number.isFinite(age) || age < 0 || age >= ttl) {
        void response.body?.cancel().catch(() => undefined);
        if (response.status === 429) throw new GateRateLimit('Gate 请求受限，请稍后刷新');
        fail(response.ok ? 'Gate 接口缓存已过期' : failure);
      }
      const row = await readJsonResponse(response, { signal, maxBytes: 128 * 1024, reviver(_key, value, context) {
        // A bare JSON fraction can round to a different integer before a field validator runs.
        // Keep its original token; unsafe bare integers stay numbers and are rejected by scaled().
        if (typeof value === 'number' && Math.abs(value) <= Number.MAX_SAFE_INTEGER && context?.source
          && !/^-?\d+(?:\.0+)?$/.test(context.source)) return context.source;
        return value;
      } });
      if (!isObject(row)) fail(failure);
      let at = startedAt - age;
      if (!metadata && path.startsWith('/futures/usdt/contracts/')) {
        // Gate's contract snapshot includes the live mark but no mark timestamp in the body.
        const generated = Date.parse(response.headers.get('date') ?? '');
        if (!Number.isSafeInteger(generated) || generated > clock() + CHAIN_ARB_CLOCK_SKEW_MS) fail('Gate 标记价响应时间异常');
        at = Math.min(at, generated);
        if (clock() - at >= CHAIN_ARB_TTL_MS) fail('Gate 标记价已过期');
      }
      const snapshot = { row, at };
      if (metadata) {
        if (cache.size >= 192) cache.delete(cache.keys().next().value!);
        cache.set(path, snapshot);
      }
      return snapshot;
    } catch (error) {
      if (error instanceof GateError) throw error;
      if (signal.aborted) fail('Gate 公开接口读取超时或已取消');
      fail(failure);
    }
  }

  return async function readGate(input: Input, signal: AbortSignal, reuseMetadata = true) {
    signal.throwIfAborted();
    if (typeof input.chain !== 'string' || !Object.hasOwn(NETWORKS, input.chain)
      || !isGateBaseSymbol(input.symbol)
      || typeof input.address !== 'string' || !/^0x[0-9a-f]{40}$/i.test(input.address) || /^0x0{40}$/i.test(input.address)) fail(IDENTITY_ERROR);
    const deadline = anySignal([signal], 8_000);
    const { row: currency } = await get('/spot/currencies/' + encodeURIComponent(input.symbol), deadline, reuseMetadata, 'Gate 币种目录不可用或未收录此币');
    const chain = verifyIdentity(currency, input);
    const pair = input.symbol + '_USDT';
    const encodedPair = encodeURIComponent(pair);
    async function readLeg(market: 'spot' | 'perp'): Promise<GateLeg> {
      try {
        if (market === 'spot') {
          const { row: meta } = await get('/spot/currency_pairs/' + encodedPair, deadline, reuseMetadata, 'Gate USDT 现货交易对不可用');
          const limits = spotLimits(meta, currency, input.symbol, clock());
          const book = await get('/spot/order_book?currency_pair=' + encodedPair + '&limit=' + LEVELS, deadline, false, 'Gate 盘口读取失败');
          return readBook(book.row, limits, market, meta, book.at, clock());
        }
        const [contract, book] = await Promise.all([
          get('/futures/usdt/contracts/' + encodedPair, deadline, false, 'Gate USDT 永续合约不可用'),
          get('/futures/usdt/order_book?contract=' + encodedPair + '&limit=' + LEVELS, deadline, false, 'Gate 盘口读取失败'),
        ]);
        const limits = perpLimits(contract.row, pair, clock());
        return readBook(book.row, limits, market, contract.row, Math.min(book.at, contract.at), clock());
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof GateRateLimit) return { error: error.message, rateLimited: true };
        return { error: error instanceof GateError ? error.message : 'Gate 盘口读取超时或不可用' };
      }
    }
    const [spot, perp] = await Promise.all([readLeg('spot'), readLeg('perp')]);
    return { deposit: enabled(currency.deposit_disabled, chain.deposit_disabled),
      withdraw: enabled(currency.withdraw_disabled, currency.withdraw_delayed, chain.withdraw_disabled, chain.withdraw_delayed), spot, perp };
  };
}
