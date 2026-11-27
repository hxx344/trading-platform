import { isObject } from '../contracts.ts';
import { decimal, fromUnits, units } from '../decimal.ts';
import { bitgetDecimal as numeric } from './bitget-book.ts';
import type { ScanCandidate } from './catalog.ts';
import { bitgetDepositMinimum } from './bitget-network.ts';
import { bitgetTimestamp as fresh, createBitgetSnapshots, type BitgetMarket as Market, type BitgetSocketFactory } from './bitget-streams.ts';
import { isSettlementOrNative } from './dex.ts';
import { CHAIN_ARB_TTL_MS, isGateBaseSymbol, type Chain } from './model.ts';
import { createVenueCatalog, readVenueJson, type VenueBook, type VenueReader, type VenueReaderOptions } from './venue.ts';

type Row = Record<string, unknown>;
type Leg = VenueBook[Market];
const COINS = '/api/v2/spot/public/coins', PAIRS = '/api/v2/spot/public/symbols';
const CONTRACTS = '/api/v2/mix/market/contracts?productType=USDT-FUTURES';
const NETWORKS: Record<string, Chain> = { ERC20: 'ethereum', ArbitrumOne: 'arbitrum', BEP20: 'bsc' };
const TTL = 300_000, ONE = units('1');
const INVALID = 'Bitget 目录应答不完整', IDENTITY = 'Bitget 未能唯一匹配所选链与代币合约地址';
const fail = (message: string): never => { throw new Error(message); };

function rows(value: unknown): Row[] {
  return Array.isArray(value) && value.length <= 12_000 && value.every(isObject) ? value : fail(INVALID);
}
function single(value: unknown): Row {
  const list = rows(value);
  return list.length === 1 ? list[0] : fail('Bitget 未返回唯一的币种或市场记录');
}
function networkRows(coin: Row) {
  if (!Array.isArray(coin.chains) || coin.chains.length > 128 || !coin.chains.every(isObject)) throw new Error(INVALID);
  return coin.chains as Row[];
}
function chainOf(name: unknown) { return typeof name === 'string' && Object.hasOwn(NETWORKS, name) ? NETWORKS[name] : undefined; }
function enabled(value: unknown) { return value === 'true' ? true : value === 'false' ? false : null; }
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
      identities.set(chain + ':' + address, { chain, symbol, address, spot: bitgetDepositMinimum(coin, network) !== undefined && tradable(spot.get(pair), symbol, 'spot'),
        perp: tradable(perp.get(pair), symbol, 'perp') });
    }
  }
  for (const [key, row] of identities) {
    if (duplicateSymbols.has(row.symbol) || duplicateAddresses.has(key)) identities.delete(key);
  }
  return identities;
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
function protectedBids(levels: [string, string][], reference: unknown, ratio: unknown): [string, string][] {
  const ref = units(numeric(reference, 'Bitget 价格保护基准价无效'));
  const spread = units(decimal(ratio, 'nonnegative'));
  if (spread >= ONE) return fail('Bitget 卖价保护参数无效');
  const floor = ref * (ONE - spread);
  const result = levels.filter(([price]) => units(price) * ONE >= floor);
  return result.length ? result : fail('Bitget 价格保护范围内没有可成交买盘');
}

export function createBitgetReader({ fetchImpl, now, bitgetSocket }: VenueReaderOptions & { bitgetSocket?: BitgetSocketFactory }): VenueReader {
  const streams = createBitgetSnapshots(now, bitgetSocket);
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
    close: streams.close,
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
      const minDeposit = bitgetDepositMinimum(coin, network);
      const markets: Market[] = ['spot', 'perp'];
      const prepared = await Promise.all(markets.map(async market => {
        try {
          if (market === 'spot' && minDeposit === undefined) throw new Error('Bitget 未确认该网络可正常充值、免费到账并划转交易');
          const path = market === 'spot' ? PAIRS + '?symbol=' : CONTRACTS + '&symbol=';
          const metadata = await get(path + encoded, signal);
          const product = single(metadata.data);
          if (!tradable(product, symbol, market)) throw new Error(market === 'spot' ? 'Bitget 普通 USDT 现货当前不可卖出' : 'Bitget 同币 USDT 永续当前不可开仓');
          return { market, size: limits(product, market), ratio: product.sellLimitPriceRatio, at: Math.min(currency.at, metadata.at) };
        } catch (error) { signal.throwIfAborted(); return { market, issue: error }; }
      }));
      const available = prepared.filter(meta => meta.size).map(meta => meta.market);
      const quotes = available.length ? await streams.read(pair, available, signal).catch(error => {
        signal.throwIfAborted();
        return new Map(available.map(market => [market, error instanceof Error ? error : new Error('Bitget 行情不可用')]));
      }) : undefined;
      const [spot, perp] = prepared.map((meta): Leg => {
        try {
          if (!meta.size) throw meta.issue;
          const quote = quotes?.get(meta.market);
          if (!quote || quote instanceof Error) throw quote;
          const at = fresh(Math.min(quote.at, meta.at), now());
          return { ...meta.size, bids: protectedBids(quote.bids, quote.reference, meta.ratio), at };
        } catch (error) {
          const limited = error instanceof Error && 'status' in error && error.status === 429;
          return { error: error instanceof Error ? error.message : 'Bitget 行情不可用', ...(limited ? { rateLimited: true as const } : {}) };
        }
      });
      return { deposit: enabled(network.rechargeable), withdraw: enabled(network.withdrawable), minDeposit, spot, perp };
    },
  };
}
