import { anySignal } from '../any-signal.mjs';
import { isObject } from '../contracts.ts';
import { decimal, fromUnits, units } from '../decimal.ts';
import { createBinanceStreams, depthSequence, type BinanceSocketFactory } from './binance-streams.ts';
import type { ScanCandidate } from './catalog.ts';
import { isSettlementOrNative } from './dex.ts';
import type { GateLeg } from './gate.ts';
import { CHAIN_ARB_CLOCK_SKEW_MS, CHAIN_ARB_TTL_MS, isGateBaseSymbol, type Chain } from './model.ts';
import { createVenueCatalog, readVenueJson, type VenueReader, type VenueReaderOptions } from './venue.ts';

// Public data behind Binance's Network Status page. The signed wallet API also returns account balances.
const NETWORK_URL = 'https://www.binance.com/bapi/capital/v1/public/capital/getNetworkCoinAll';
const FUTURES = 'https://fapi.binance.com/fapi/v1/';
const NETWORKS: Record<string, Chain> = { ETH: 'ethereum', ARBITRUM: 'arbitrum', BSC: 'bsc' };
const META_TTL = 60_000, LEVELS = 100, ONE = units('1');
const INVALID_DIRECTORY = '币安公开目录不完整或格式无效';
const INVALID_LIMIT = '币安市价单交易规则未核实';
const INVALID_BOOK = '币安买盘档位或时间无效';
const ADDRESS = /^0x[0-9a-f]{40}$/i;
type Row = Record<string, unknown>;
type Asset = { candidate: ScanCandidate; deposit: boolean | null; withdraw: boolean | null; minDeposit?: string; spot?: Row; perp?: Row };
function fail(message: string): never { throw new Error(message); }
function row(value: unknown, message: string): Row { return isObject(value) ? value : fail(message); }
function rows(value: unknown, max = 12000, empty = false): Row[] {
  if (!Array.isArray(value) || (!empty && !value.length) || value.length > max || !value.every(isObject)) fail(INVALID_DIRECTORY);
  return value;
}
function nonNegative(value: unknown): bigint {
  try { return units(decimal(value, 'nonnegative')); } catch { return fail(INVALID_LIMIT); }
}
function positive(value: unknown): bigint { const n = nonNegative(value); return n > 0n ? n : fail(INVALID_LIMIT); }
function fresh(value: unknown, now: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    && now - value < CHAIN_ARB_TTL_MS && value - now <= CHAIN_ARB_CLOCK_SKEW_MS ? value : fail('币安行情时间异常或已过期');
}
function transferStatus(all: unknown, hiddenAll: unknown, enabled: unknown, hidden: unknown): boolean | null {
  if (all === false || hiddenAll === true || enabled === false || hidden === true) return false;
  return all === true && hiddenAll === false && enabled === true && hidden === false ? true : null;
}
function instruments(raw: unknown, perp: boolean, now: number) {
  const result = new Map<string, Row | null>();
  for (const item of rows(row(raw, INVALID_DIRECTORY).symbols)) {
    if (typeof item.baseAsset !== 'string' || typeof item.symbol !== 'string' || typeof item.quoteAsset !== 'string'
      || typeof item.status !== 'string') fail(INVALID_DIRECTORY);
    if (item.quoteAsset !== 'USDT' || item.symbol !== item.baseAsset + 'USDT') continue;
    const market = Array.isArray(item.orderTypes) && item.orderTypes.includes('MARKET') && item.status === 'TRADING';
    const eligible = market && (perp
      ? item.pair === item.symbol && item.marginAsset === 'USDT' && item.contractType === 'PERPETUAL'
        && item.underlyingType === 'COIN' && item.deliveryDate === 4133404800000
        && typeof item.onboardDate === 'number' && Number.isSafeInteger(item.onboardDate) && item.onboardDate > 0 && item.onboardDate <= now
      : item.isSpotTradingAllowed === true);
    result.set(item.baseAsset, !result.has(item.baseAsset) && eligible ? item : null);
  }
  return result;
}
function directory(wallet: unknown, spot: unknown, perp: unknown, now: number) {
  const body = row(wallet, INVALID_DIRECTORY);
  if (body.code !== '000000') fail(INVALID_DIRECTORY);
  const spots = instruments(spot, false, now), perps = instruments(perp, true, now);
  const identities = new Map<string, Asset>(), candidates: ScanCandidate[] = [];
  const symbols = new Set<string>(), duplicateSymbols = new Set<string>();
  const addresses = new Set<string>(), duplicateAddresses = new Set<string>();
  for (const coin of rows(body.data)) {
    const symbol = coin.coin;
    if (typeof symbol !== 'string' || !symbol || !Array.isArray(coin.networkList)) fail(INVALID_DIRECTORY);
    if (symbols.has(symbol)) duplicateSymbols.add(symbol);
    symbols.add(symbol);
    const chains = new Map<Chain, Row | null>();
    for (const n of rows(coin.networkList, 128, true)) {
      if (typeof n.network !== 'string' || n.coin !== symbol) fail(INVALID_DIRECTORY);
      if (!Object.hasOwn(NETWORKS, n.network)) continue;
      const chain = NETWORKS[n.network];
      chains.set(chain, chains.has(chain) ? null : n);
      if (typeof n.contractAddress !== 'string' || !ADDRESS.test(n.contractAddress)) continue;
      const key = chain + ':' + n.contractAddress.toLowerCase();
      if (addresses.has(key)) duplicateAddresses.add(key);
      addresses.add(key);
    }
    if (!isGateBaseSymbol(symbol)) continue;
    for (const [chain, n] of chains) {
      if (!n || n.denomination !== 1 || typeof n.contractAddress !== 'string' || !ADDRESS.test(n.contractAddress)) continue;
      const address = n.contractAddress.toLowerCase();
      if (isSettlementOrNative(chain, address)) continue;
      const deposit = transferStatus(coin.depositAllEnable, coin.depositHideAll, n.depositEnable, n.depositHideEnable);
      const withdraw = transferStatus(coin.withdrawAllEnable, coin.withdrawHideAll, n.withdrawEnable, n.withdrawHideEnable);
      // The quote and deposit must refer to the same number of on-chain base units.
      const transferable = typeof n.depositFee === 'string' && /^0(?:\.0+)?$/.test(n.depositFee)
        && typeof n.depositDust === 'string' && /^\d{1,60}(?:\.\d{1,18})?$/.test(n.depositDust);
      const spot = spots.get(symbol) ?? undefined, perp = perps.get(symbol) ?? undefined;
      const candidate = { chain, address, symbol, spot: !!spot && deposit === true && transferable, perp: !!perp };
      identities.set(chain + ':' + address, { candidate, deposit, withdraw, spot: transferable ? spot : undefined, perp,
        ...(transferable ? { minDeposit: n.depositDust as string } : {}) });
    }
  }
  for (const [key, entry] of identities) {
    if (duplicateAddresses.has(key) || duplicateSymbols.has(entry.candidate.symbol)) identities.delete(key);
    else if (entry.candidate.spot || entry.candidate.perp) candidates.push(entry.candidate);
  }
  candidates.sort((a, b) => a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : a.chain.localeCompare(b.chain));
  return { candidates, identities };
}

function filters(meta: Row) {
  const result = new Map<string, Row>();
  for (const item of rows(meta.filters, 64)) {
    if (typeof item.filterType !== 'string' || result.has(item.filterType)) fail(INVALID_LIMIT);
    result.set(item.filterType, item);
  }
  return result;
}
function limits(meta: Row, reference: (filter: Row) => bigint, perp: boolean) {
  const rules = filters(meta), lot = rules.get('LOT_SIZE'), market = rules.get('MARKET_LOT_SIZE');
  if (!lot || !market) fail(INVALID_LIMIT);
  const lotStep = positive(lot.stepSize), marketStep = nonNegative(market.stepSize);
  const larger = lotStep > marketStep ? lotStep : marketStep, smaller = lotStep > marketStep ? marketStep : lotStep;
  if (smaller && larger % smaller) fail(INVALID_LIMIT);
  const minQty = positive(lot.minQty), maxQty = positive(lot.maxQty);
  const marketMin = nonNegative(market.minQty), marketMax = nonNegative(market.maxQty);
  // USD-M describes increments relative to the minimum; omit an unsupported nonzero offset.
  if (perp && (minQty % lotStep || (marketStep && marketMin % marketStep))) fail(INVALID_LIMIT);
  let lower = minQty > marketMin ? minQty : marketMin, upper = marketMax && marketMax < maxQty ? marketMax : maxQty;
  const accountLimit = rules.get('POSITION_RISK_CONTROL');
  if (accountLimit && accountLimit.positionControlSide !== 'NONE') fail('币安合约存在仓位限制，未确认开放做空');
  // Market-order notional filters use the venue's reference price (USD-M: mark), not the simulated fill VWAP.
  const minimum = rules.get('MIN_NOTIONAL'), range = rules.get('NOTIONAL');
  if (!minimum && !range) fail(INVALID_LIMIT);
  const enforce = (filter: Row, value: unknown, min: boolean) => {
    const numerator = positive(value) * ONE, denominator = reference(filter) * larger;
    const bound = (min ? (numerator + denominator - 1n) / denominator : numerator / denominator) * larger;
    if (min && bound > lower) lower = bound;
    if (!min && bound < upper) upper = bound;
  };
  if (minimum) {
    if (!perp && typeof minimum.applyToMarket !== 'boolean') fail(INVALID_LIMIT);
    if (perp || minimum.applyToMarket) enforce(minimum, perp ? minimum.notional : minimum.minNotional, true);
  }
  if (range) {
    if (typeof range.applyMinToMarket !== 'boolean' || typeof range.applyMaxToMarket !== 'boolean') fail(INVALID_LIMIT);
    if (range.applyMinToMarket) enforce(range, range.minNotional, true);
    if (range.applyMaxToMarket) enforce(range, range.maxNotional, false);
  }
  if (upper < lower) fail(INVALID_LIMIT);
  return { step: fromUnits(larger), minQuantity: fromUnits(lower), maxQuantity: fromUnits(upper) };
}
function bidLevels(raw: unknown, floor: bigint, ceiling?: bigint): [string, string][] {
  if (!Array.isArray(raw) || !raw.length || raw.length > LEVELS) fail(INVALID_BOOK);
  const bids: [string, string][] = [];
  let previous: bigint | undefined, permitted = true;
  for (const level of raw) {
    if (!Array.isArray(level) || level.length !== 2) fail(INVALID_BOOK);
    const price = positive(level[0]), size = positive(level[1]);
    if (previous !== undefined && price >= previous) fail(INVALID_BOOK);
    previous = price;
    // Crossing a bound expires the remaining order; prices behind it cannot be counted.
    if (price * ONE < floor || (ceiling !== undefined && price * ONE > ceiling)) permitted = false;
    if (permitted) bids.push([fromUnits(price), fromUnits(size)]);
  }
  if (!bids.length) fail('币安市价单保护范围内没有可成交买盘');
  return bids;
}
export function createBinanceReader({ fetchImpl, now, binanceSocket }: VenueReaderOptions & { binanceSocket?: BinanceSocketFactory }): VenueReader {
  const streams = createBinanceStreams(now, binanceSocket);
  const publicFetch: typeof fetchImpl = async (url, init) => {
    const throttle = url.startsWith(FUTURES) ? streams.perpThrottle : streams.spotThrottle;
    throttle.check();
    const response = await fetchImpl(url, init);
    if (response.status === 429 || response.status === 418) {
      const after = response.headers.get('retry-after') ?? '';
      const deadline = /^\d{1,9}$/.test(after) ? now() + Number(after) * 1000 : Date.parse(after);
      throttle.block(response.status, deadline);
    }
    return response;
  };
  const products = createVenueCatalog(async signal => {
    const [spot, perp] = await Promise.all([streams.directory(signal),
      readVenueJson(publicFetch, FUTURES + 'exchangeInfo', signal, 8 * 1024 * 1024, META_TTL, now)]);
    spot.check();
    return { spot: spot.body, perp: perp.body, expires: Math.min(spot.at, perp.at) + META_TTL };
  }, now, META_TTL, value => value.expires);
  async function load(signal: AbortSignal) {
    const [wallet, instruments] = await Promise.all([
      readVenueJson(publicFetch, NETWORK_URL, signal, 8 * 1024 * 1024, CHAIN_ARB_TTL_MS, now), products(signal)]);
    return { ...directory(wallet.body, instruments.spot, instruments.perp, now()), depositAt: wallet.at,
      expires: Math.min(wallet.at + CHAIN_ARB_TTL_MS, instruments.expires) };
  }
  const metadata = createVenueCatalog(load, now, CHAIN_ARB_TTL_MS, result => result.expires);
  // With no engine reference price, PRICE_RANGE is inactive. Each active notional filter
  // independently specifies a VWAP window, with zero indicating the latest trade.
  async function spotPrices(pair: string, meta: Row, signal: AbortSignal) {
    const response = await streams.spot('referencePrice', { symbol: pair }, signal);
    const mark = row(response.body, INVALID_LIMIT);
    let at = response.at;
    if (mark.code !== -2043) {
      if (mark.symbol !== pair) fail(INVALID_LIMIT);
      if (mark.referencePrice !== null) {
        at = Math.min(at, fresh(mark.timestamp, now()));
        const ref = positive(mark.referencePrice);
        return { band: ref, reference: () => ref, at, check: response.check };
      }
      // With no current reference, this timestamp can refer to its last valid value.
      if (mark.timestamp !== null && !(typeof mark.timestamp === 'number' && Number.isSafeInteger(mark.timestamp)
        && mark.timestamp > 0 && mark.timestamp <= now() + CHAIN_ARB_CLOCK_SKEW_MS)) fail(INVALID_LIMIT);
    }
    const windows = new Set<number>();
    for (const [type, filter] of filters(meta)) {
      if (!(type === 'MIN_NOTIONAL' && filter.applyToMarket === true || type === 'NOTIONAL'
        && (filter.applyMinToMarket === true || filter.applyMaxToMarket === true))) continue;
      const minutes = filter.avgPriceMins;
      if (typeof minutes !== 'number' || !Number.isSafeInteger(minutes) || minutes < 0) fail(INVALID_LIMIT);
      windows.add(minutes);
    }
    const prices = new Map<number, bigint>();
    await Promise.all([...windows].map(async minutes => {
      const data = minutes ? await streams.spot('avgPrice', { symbol: pair }, signal)
        : await streams.spot('trades.recent', { symbol: pair, limit: 1 }, signal);
      const price = minutes ? row(data.body, INVALID_LIMIT) : rows(data.body, 1)[0];
      if (minutes && price.mins !== minutes) fail(INVALID_LIMIT);
      prices.set(minutes, positive(price.price));
      at = Math.min(at, data.at, fresh(minutes ? price.closeTime : price.time, now()));
    }));
    response.check();
    return { band: null, reference: (filter: Row) => prices.get(filter.avgPriceMins as number) ?? fail(INVALID_LIMIT),
      at, check: response.check };
  }
  type PricedLeg = Exclude<GateLeg, { error: string }> & { check(): void };
  async function spotLeg(pair: string, meta: Row, signal: AbortSignal): Promise<PricedLeg> {
    const snapshot = async () => {
      const anchor = await streams.spotEvent(pair, signal);
      const event = row(anchor.body, INVALID_BOOK);
      if (event.e !== 'depthUpdate' || event.s !== pair || depthSequence(event.U) > depthSequence(event.u)
        || !Array.isArray(event.b) || !Array.isArray(event.a) || !event.b.length && !event.a.length) fail(INVALID_BOOK);
      const eventAt = fresh(event.E, now());
      const response = await streams.spot('depth', { symbol: pair, limit: LEVELS }, signal);
      const book = row(response.body, INVALID_BOOK);
      if (depthSequence(book.lastUpdateId) < depthSequence(event.u)) fail('币安现货快照落后于盘口更新');
      return { book, at: Math.min(eventAt, response.at), check() { anchor.check(); response.check(); } };
    };
    const [depth, prices, rules] = await Promise.all([snapshot(), spotPrices(pair, meta, signal),
      streams.spot('executionRules', { symbol: pair }, signal)]);
    const entries = rows(row(rules.body, INVALID_LIMIT).symbolRules);
    if (entries.length !== 1 || entries[0].symbol !== pair) fail(INVALID_LIMIT);
    const bands = rows(entries[0].rules, 16, true);
    if (bands.length > 1 || bands.some(rule => rule.ruleType !== 'PRICE_RANGE')) fail(INVALID_LIMIT);
    const band = bands[0], lower = band?.askLimitMultDown, upper = band?.askLimitMultUp;
    const at = fresh(Math.min(depth.at, prices.at, rules.at), now());
    return { at, bids: bidLevels(depth.book.bids, prices.band === null || lower === undefined ? 0n : prices.band * positive(lower),
      prices.band === null || upper === undefined ? undefined : prices.band * positive(upper)), ...limits(meta, prices.reference, false),
      check() { prices.check(); depth.check(); rules.check(); } };
  }
  async function perpLeg(pair: string, meta: Row, signal: AbortSignal): Promise<PricedLeg> {
    const [depth, reference] = await Promise.all([streams.perpDepth(pair, LEVELS, signal), streams.mark(pair, signal)]);
    const book = row(depth.body, INVALID_BOOK), mark = row(reference.body, INVALID_LIMIT);
    if (mark.s !== pair || mark.e !== 'markPriceUpdate') fail(INVALID_LIMIT);
    depthSequence(book.lastUpdateId);
    const changed = fresh(book.T, now()), sent = fresh(book.E, now());
    if (changed > sent) fail(INVALID_BOOK);
    const ref = positive(mark.p), band = nonNegative(meta.marketTakeBound);
    if (band >= ONE) fail(INVALID_LIMIT);
    const at = fresh(Math.min(depth.at, changed, fresh(mark.E, now())), now());
    return { at, bids: bidLevels(book.bids, ref * (ONE - band)), ...limits(meta, () => ref, true),
      check() { depth.check(); reference.check(); } };
  }
  return {
    close: streams.close,
    catalog: async signal => (await metadata(signal)).candidates,
    async read(input, signal, reuseMetadata = true) {
      signal.throwIfAborted();
      const stop = new AbortController(), life = anySignal([signal, stop.signal], 8_000);
      try {
        const data = await (reuseMetadata ? metadata(life) : load(life));
        const asset = data.identities.get(input.chain + ':' + input.address.toLowerCase());
        if (!asset || input.symbol !== asset.candidate.symbol) fail('币安未能唯一匹配所选链、面额和合约地址');
        const pair = input.symbol + 'USDT';
        const [spot, perp] = await Promise.allSettled([
          asset.spot && asset.deposit === true ? spotLeg(pair, asset.spot, life) : Promise.reject(new Error('币安未开放可核实的现货充值卖出路线')),
          asset.perp ? perpLeg(pair, asset.perp, life) : Promise.reject(new Error('币安未开放同币 USDT 线性永续')),
        ]);
        signal.throwIfAborted();
        if (now() >= data.expires) fail('币安网络或交易目录已过期');
        function deliver(result: PromiseSettledResult<PricedLeg>): GateLeg {
          try {
            if (result.status === 'rejected') throw result.reason;
            const { check, ...quote } = result.value;
            check();
            quote.at = fresh(Math.min(quote.at, data.depositAt), now());
            return quote;
          } catch (error) {
            if (isObject(error) && error.status === 429) return { error: '币安公开行情请求受限', rateLimited: true };
            return { error: error instanceof Error && error.message.includes('币安') ? error.message : '币安公开行情超时或不可用' };
          }
        }
        return { deposit: asset.deposit, withdraw: asset.withdraw, minDeposit: asset.minDeposit, spot: deliver(spot), perp: deliver(perp) };
      } finally { stop.abort(); }
    },
  };
}
