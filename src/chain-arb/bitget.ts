import { isObject } from '../contracts.ts';
import { decimal, fromUnits, units } from '../decimal.ts';
import Decimal from '../vendor/decimal.mjs';
import type { ScanCandidate } from './catalog.ts';
import { isSettlementOrNative } from './dex.ts';
import { CHAIN_ARB_CLOCK_SKEW_MS, CHAIN_ARB_TTL_MS, isGateBaseSymbol, type Chain } from './model.ts';
import { createVenueCatalog, readVenueJson, type VenueBook, type VenueReader, type VenueReaderOptions } from './venue.ts';

type Row = Record<string, unknown>;
type Market = 'spot' | 'perp';
type Leg = VenueBook[Market];
const COINS = '/api/v2/spot/public/coins', PAIRS = '/api/v2/spot/public/symbols';
const CONTRACTS = '/api/v2/mix/market/contracts?productType=USDT-FUTURES';
const NETWORKS: Record<string, Chain> = { ERC20: 'ethereum', ArbitrumOne: 'arbitrum', BEP20: 'bsc' };
const TTL = 300_000, LEVELS = 100, ONE = units('1');
const INVALID = 'Bitget 目录应答不完整', IDENTITY = 'Bitget 未能唯一匹配所选链与代币合约地址';
const BOOK = 'Bitget 买盘价格、数量或排序异常';
const fail = (message: string): never => { throw new Error(message); };

function rows(value: unknown): Row[] {
  return Array.isArray(value) && value.length <= 12_000 && value.every(isObject) ? value : fail(INVALID);
}
function single(value: unknown): Row {
  const list = rows(value);
  return list.length === 1 ? list[0] : fail('Bitget 未返回唯一的币种或市场记录');
}
function fresh(value: unknown, now: number, ttl: number): number {
  const at = typeof value === 'string' && /^\d{13}$/.test(value) ? Number(value) : value;
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at <= 0 || at > now + CHAIN_ARB_CLOCK_SKEW_MS || now - at >= ttl) {
    fail('Bitget 行情已过期或时间异常');
  }
  return at as number;
}
function networkRows(coin: Row) {
  if (!Array.isArray(coin.chains) || coin.chains.length > 128 || !coin.chains.every(isObject)) throw new Error(INVALID);
  return coin.chains as Row[];
}
function chainOf(name: unknown) { return typeof name === 'string' && Object.hasOwn(NETWORKS, name) ? NETWORKS[name] : undefined; }
function enabled(value: unknown) { return value === 'true' ? true : value === 'false' ? false : null; }
function depositMinimum(network: Row): string | undefined {
  try { return decimal(network.minDepositAmount, 'nonnegative'); } catch { return undefined; }
}
function depositRoute(network: Row) {
  return enabled(network.rechargeable) === true && network.needTag === 'false' && depositMinimum(network) !== undefined;
}
function tradable(row: Row | null | undefined, base: string, market: Market): row is Row {
  if (!row || row.symbol !== base + 'USDT' || row.baseCoin !== base || row.quoteCoin !== 'USDT') return false;
  if (market === 'spot') return row.status === 'online' && row.areaSymbol === 'no' && row.offTime === '';
  return row.symbolType === 'perpetual' && row.symbolStatus === 'normal' && row.isRwa === 'NO'
    && row.offTime === '-1' && row.limitOpenTime === '-1'
    && Array.isArray(row.supportMarginCoins) && row.supportMarginCoins.includes('USDT');
}
function uniqueProducts(products: Row[]) {
  const available = new Map<string, Row | null>();
  for (const row of products) {
    if (typeof row.symbol !== 'string' || !row.symbol) throw new Error(INVALID);
    available.set(row.symbol, available.has(row.symbol) ? null : row);
  }
  return available;
}
function directory(coins: Row[], pairs: Row[], contracts: Row[]) {
  if (!coins.length || !pairs.length || !contracts.length) throw new Error(INVALID);
  const spot = uniqueProducts(pairs), perp = uniqueProducts(contracts);
  const symbols = new Set<string>(), duplicateSymbols = new Set<string>();
  const addresses = new Set<string>(), duplicateAddresses = new Set<string>();
  const identities = new Map<string, ScanCandidate>();
  for (const coin of coins) {
    const symbol = coin.coin;
    if (typeof symbol !== 'string' || !symbol) throw new Error(INVALID);
    if (symbols.has(symbol)) duplicateSymbols.add(symbol);
    symbols.add(symbol);
    const networks = new Map<Chain, Row | null>();
    for (const network of networkRows(coin)) {
      const chain = chainOf(network.chain);
      if (!chain) continue;
      networks.set(chain, networks.has(chain) ? null : network);
      if (typeof network.contractAddress === 'string' && /^0x[0-9a-f]{40}$/i.test(network.contractAddress)) {
        const key = chain + ':' + network.contractAddress.toLowerCase();
        if (addresses.has(key)) duplicateAddresses.add(key);
        addresses.add(key);
      }
    }
    // Bitget has synthetic 1000-/1M-coin denominations. The wallet API supplies no unit conversion for them.
    if (!isGateBaseSymbol(symbol) || /^(?:10{2,}|\d+[MK])(?=\p{L})/u.test(symbol)) continue;
    const pair = symbol + 'USDT';
    for (const [chain, network] of networks) {
      if (!network || typeof network.contractAddress !== 'string' || !/^0x[0-9a-f]{40}$/i.test(network.contractAddress)) continue;
      const address = network.contractAddress.toLowerCase();
      if (isSettlementOrNative(chain, address)) continue;
      identities.set(chain + ':' + address, { chain, symbol, address, spot: depositRoute(network) && tradable(spot.get(pair), symbol, 'spot'),
        perp: tradable(perp.get(pair), symbol, 'perp') });
    }
  }
  for (const [key, row] of identities) {
    if (duplicateSymbols.has(row.symbol) || duplicateAddresses.has(key)) identities.delete(key);
  }
  return identities;
}

function numeric(value: unknown, error: string): string {
  // The v3 book encodes prices and sizes as bare JSON numbers. readVenueJson retains each original fractional token.
  let raw = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof raw !== 'string' || raw.length > 80) return fail(error);
  if (/^\d+(?:\.\d+)?[eE][+-]?\d{1,2}$/.test(raw)) raw = new Decimal(raw).toFixed();
  try { return decimal(raw, 'positive'); } catch { return fail(error); }
}
function step(precision: unknown) {
  if (typeof precision !== 'string' || !/^\d{1,2}$/.test(precision) || Number(precision) > 18) return fail('Bitget 数量精度无效');
  return fromUnits(ONE / (10n ** BigInt(precision)));
}
function limits(row: Row, market: Market) {
  const limit = (v: unknown) => numeric(v, 'Bitget 下单数量或金额限制无效');
  const minNotional = limit(row.minTradeUSDT);
  if (market === 'spot') return { step: step(row.quantityPrecision), minNotional, maxNotional: limit(row.maxMarketOrderValue) };
  // USDT-M depth and sizeMultiplier are in base coin. sizeMultiplier is the lot increment, not a contract face value.
  const increment = limit(row.sizeMultiplier);
  if (units(increment) % units(step(row.volumePlace)) !== 0n) return fail('Bitget 合约数量步长与精度不符');
  return { step: increment, minNotional, minQuantity: limit(row.minTradeNum), maxQuantity: limit(row.maxMarketOrderQty) };
}
function bids(value: unknown, reference: unknown, ratio: unknown): [string, string][] {
  if (!Array.isArray(value) || !value.length || value.length > LEVELS) return fail(BOOK);
  const ref = units(numeric(reference, 'Bitget 价格保护基准价无效'));
  const spread = units(decimal(ratio, 'nonnegative'));
  if (spread >= ONE) return fail('Bitget 卖价保护参数无效');
  const result: [string, string][] = [];
  const floor = ref * (ONE - spread);
  let previous: bigint | undefined;
  for (const level of value) {
    if (!Array.isArray(level) || level.length !== 2) return fail(BOOK);
    const price = numeric(level[0], BOOK), size = numeric(level[1], BOOK), px = units(price);
    if (previous !== undefined && px >= previous) return fail(BOOK);
    if (px * ONE >= floor) result.push([price, size]);
    previous = px;
  }
  return result.length ? result : fail('Bitget 价格保护范围内没有可成交买盘');
}

export function createBitgetReader({ fetchImpl, now }: VenueReaderOptions): VenueReader {
  async function get(path: string, signal: AbortSignal, ttl = CHAIN_ARB_TTL_MS) {
    const { body, at } = await readVenueJson(fetchImpl, 'https://api.bitget.com' + path, signal,
      ttl === TTL ? 5 * 1024 * 1024 : 160 * 1024, ttl, now);
    if (!isObject(body) || body.code !== '00000') {
      if (isObject(body) && body.code === '429') throw Object.assign(new Error('Bitget 请求受限'), { status: 429 });
      throw new Error('Bitget 公开接口未返回有效数据');
    }
    return { data: body.data, at: Math.min(at, fresh(body.requestTime, now(), ttl)) };
  }
  const index = createVenueCatalog(async signal => {
    const [coins, spots, perps] = await Promise.all([COINS, PAIRS, CONTRACTS].map(path => get(path, signal, TTL)));
    const entries = directory(rows(coins.data), rows(spots.data), rows(perps.data));
    const candidates = [...entries.values()].filter(row => row.spot || row.perp);
    return { entries, candidates, expires: Math.min(coins.at, spots.at, perps.at) + TTL };
  }, now, TTL, snapshot => snapshot.expires);

  return {
    async catalog(signal) { return (await index(signal)).candidates; },
    async read(input, signal): Promise<VenueBook> {
      const { chain, symbol } = input;
      const address = input.address.toLowerCase(), key = chain + ':' + address;
      if ((await index(signal)).entries.get(key)?.symbol !== symbol) throw new Error(IDENTITY);
      const currency = await get(COINS + '?coin=' + encodeURIComponent(symbol), signal);
      const coin = single(currency.data), matches = networkRows(coin).filter(row => chainOf(row.chain) === chain);
      if (coin.coin !== symbol || matches.length !== 1 || typeof matches[0].contractAddress !== 'string'
        || matches[0].contractAddress.toLowerCase() !== address) throw new Error(IDENTITY);
      const network = matches[0], pair = symbol + 'USDT', encoded = encodeURIComponent(pair);
      async function leg(market: Market): Promise<Leg> {
        try {
          if (market === 'spot' && !depositRoute(network)) throw new Error('Bitget 未确认该网络支持普通代币充值及最低充值量');
          const path = market === 'spot' ? PAIRS + '?symbol=' : CONTRACTS + '&symbol=';
          const metadata = await get(path + encoded, signal);
          const product = single(metadata.data);
          if (!tradable(product, symbol, market)) throw new Error(market === 'spot' ? 'Bitget 普通 USDT 现货当前不可卖出' : 'Bitget 同币 USDT 永续当前不可开仓');
          const size = limits(product, market), category = market === 'spot' ? 'SPOT' : 'USDT-FUTURES';
          const query = '?category=' + category + '&symbol=' + encoded;
          const [book, tick] = await Promise.all([get('/api/v3/market/orderbook' + query + '&limit=' + LEVELS, signal),
            get('/api/v3/market/tickers' + query, signal)]);
          const ticker = single(tick.data);
          if (!isObject(book.data) || ticker.symbol !== pair || ticker.category !== category) throw new Error('Bitget 盘口或基准价身份不符');
          const at = Math.min(currency.at, metadata.at, book.at, tick.at, fresh(book.data.ts, now(), CHAIN_ARB_TTL_MS), fresh(ticker.ts, now(), CHAIN_ARB_TTL_MS));
          fresh(at, now(), CHAIN_ARB_TTL_MS);
          return { ...size, bids: bids(book.data.b, market === 'spot' ? ticker.lastPrice : ticker.markPrice, product.sellLimitPriceRatio), at };
        } catch (error) {
          signal.throwIfAborted();
          const limited = error instanceof Error && 'status' in error && error.status === 429;
          return { error: error instanceof Error ? error.message : 'Bitget 行情不可用', ...(limited ? { rateLimited: true as const } : {}) };
        }
      }
      const [spot, perp] = await Promise.all([leg('spot'), leg('perp')]);
      return { deposit: enabled(network.rechargeable), withdraw: enabled(network.withdrawable), minDeposit: depositMinimum(network), spot, perp };
    },
  };
}
