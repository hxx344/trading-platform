import { anySignal } from '../any-signal.mjs';
import { isObject } from '../contracts.ts';
import { decimal, fromUnits, units } from '../decimal.ts';
import type { ScanCandidate } from './catalog.ts';
import { isSettlementOrNative } from './dex.ts';
import type { GateLeg } from './gate.ts';
import { CHAIN_ARB_CLOCK_SKEW_MS, CHAIN_ARB_TTL_MS, isGateBaseSymbol, type Chain } from './model.ts';
import { createVenueCatalog, readVenueJson, type VenueReader, type VenueReaderOptions } from './venue.ts';

// Public data behind Binance's Network Status page. The signed wallet API also returns account balances.
const NETWORK_URL = 'https://www.binance.com/bapi/capital/v1/public/capital/getNetworkCoinAll';
const SPOT = 'https://api.binance.com/api/v3/', FUTURES = 'https://fapi.binance.com/fapi/v1/';
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

// The spot REST snapshot only contains a sequence number. A preceding matching-engine depth event
// proves a lower bound on its age once the REST sequence has caught up. No local arrival timestamp can do this.
type DepthEvent = (pair: string, signal: AbortSignal) => Promise<unknown>;
const depthEvent: DepthEvent = (pair, signal) => new Promise((resolve, reject) => {
  signal.throwIfAborted();
  const socket = new WebSocket('wss://data-stream.binance.vision/ws/' + encodeURIComponent(pair.toLowerCase()) + '@depth@100ms');
  const cleanup = () => { signal.removeEventListener('abort', abort); socket.onerror = null; socket.onclose = null; socket.onmessage = null; socket.close(); };
  const unavailable = () => { cleanup(); reject(new Error('无法核实币安现货盘口更新时间')); };
  const abort = () => { cleanup(); reject(signal.reason); };
  socket.onerror = unavailable;
  socket.onclose = unavailable;
  socket.onmessage = event => {
    if (typeof event.data !== 'string' || event.data.length > 256 * 1024) { unavailable(); return; }
    try { const message: unknown = JSON.parse(event.data); cleanup(); resolve(message); } catch { unavailable(); }
  };
  signal.addEventListener('abort', abort, { once: true });
});
function filters(meta: Row) {
  const result = new Map<string, Row>();
  for (const item of rows(meta.filters, 64)) {
    if (typeof item.filterType !== 'string' || result.has(item.filterType)) fail(INVALID_LIMIT);
    result.set(item.filterType, item);
  }
  return result;
}
function limits(meta: Row, reference: bigint, perp: boolean) {
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
  const enforce = (value: unknown, min: boolean) => {
    const numerator = positive(value) * ONE, denominator = reference * larger;
    const bound = (min ? (numerator + denominator - 1n) / denominator : numerator / denominator) * larger;
    if (min && bound > lower) lower = bound;
    if (!min && bound < upper) upper = bound;
  };
  if (minimum) {
    if (!perp && typeof minimum.applyToMarket !== 'boolean') fail(INVALID_LIMIT);
    if (perp || minimum.applyToMarket) enforce(perp ? minimum.notional : minimum.minNotional, true);
  }
  if (range) {
    if (typeof range.applyMinToMarket !== 'boolean' || typeof range.applyMaxToMarket !== 'boolean') fail(INVALID_LIMIT);
    if (range.applyMinToMarket) enforce(range.minNotional, true);
    if (range.applyMaxToMarket) enforce(range.maxNotional, false);
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
function sequence(value: unknown): bigint {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return BigInt(value);
  if (typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value)) return BigInt(value);
  return fail(INVALID_BOOK);
}
export function createBinanceReader({ fetchImpl, now, spotDepthEvent = depthEvent }: VenueReaderOptions & { spotDepthEvent?: DepthEvent }): VenueReader {
  const get = (url: string, signal: AbortSignal, metadata = false) =>
    readVenueJson(fetchImpl, url, signal, metadata ? 8 * 1024 * 1024 : 192 * 1024, metadata ? META_TTL : CHAIN_ARB_TTL_MS, now);
  async function load(signal: AbortSignal) {
    const [wallet, spot, perp] = await Promise.all([get(NETWORK_URL, signal, true),
      get(SPOT + 'exchangeInfo?permissions=SPOT&showPermissionSets=false&symbolStatus=TRADING', signal, true),
      get(FUTURES + 'exchangeInfo', signal, true)]);
    return { ...directory(wallet.body, spot.body, perp.body, now()), expires: Math.min(wallet.at, spot.at, perp.at) + META_TTL };
  }
  const metadata = createVenueCatalog(load, now, META_TTL, result => result.expires);
  // Binance caps new spot stream connections per IP in a rolling five-minute window.
  let connections: number[] = [];
  async function spotLeg(pair: string, meta: Row, signal: AbortSignal): Promise<GateLeg> {
    const time = now();
    connections = connections.filter(at => at <= time && time - at < 300_000);
    if (connections.length >= 240) throw Object.assign(new Error('币安现货行情连接受限'), { status: 429 });
    connections.push(time);
    const query = '?symbol=' + encodeURIComponent(pair);
    const snapshot = async () => {
      const event = row(await spotDepthEvent(pair, signal), INVALID_BOOK);
      if (event.e !== 'depthUpdate' || event.s !== pair || sequence(event.U) > sequence(event.u)
        || !Array.isArray(event.b) || !Array.isArray(event.a) || !event.b.length && !event.a.length) fail(INVALID_BOOK);
      const eventAt = fresh(event.E, now());
      const response = await get(SPOT + 'depth' + query + '&limit=' + LEVELS, signal);
      const book = row(response.body, INVALID_BOOK);
      if (sequence(book.lastUpdateId) < sequence(event.u)) fail('币安现货快照落后于盘口更新');
      return { book, at: Math.min(eventAt, response.at) };
    };
    const [depth, reference, rules] = await Promise.all([snapshot(), get(SPOT + 'referencePrice' + query, signal),
      get(SPOT + 'executionRules' + query, signal)]);
    const mark = row(reference.body, INVALID_LIMIT), entries = rows(row(rules.body, INVALID_LIMIT).symbolRules);
    if (mark.symbol !== pair || entries.length !== 1 || entries[0].symbol !== pair) fail(INVALID_LIMIT);
    const ref = positive(mark.referencePrice);
    const bands = rows(entries[0].rules, 16, true);
    if (bands.length > 1 || bands.some(rule => rule.ruleType !== 'PRICE_RANGE')) fail(INVALID_LIMIT);
    const band = bands[0], lower = band?.askLimitMultDown, upper = band?.askLimitMultUp;
    const at = fresh(Math.min(depth.at, reference.at, rules.at, fresh(mark.timestamp, now())), now());
    return { at, bids: bidLevels(depth.book.bids, lower === undefined ? 0n : ref * positive(lower),
      upper === undefined ? undefined : ref * positive(upper)), ...limits(meta, ref, false) };
  }
  async function perpLeg(pair: string, meta: Row, signal: AbortSignal): Promise<GateLeg> {
    const query = '?symbol=' + encodeURIComponent(pair);
    const [depth, reference] = await Promise.all([get(FUTURES + 'depth' + query + '&limit=' + LEVELS, signal),
      get(FUTURES + 'premiumIndex' + query, signal)]);
    const book = row(depth.body, INVALID_BOOK), mark = row(reference.body, INVALID_LIMIT);
    if (mark.symbol !== pair) fail(INVALID_LIMIT);
    sequence(book.lastUpdateId);
    const changed = fresh(book.T, now()), sent = fresh(book.E, now());
    if (changed > sent) fail(INVALID_BOOK);
    const ref = positive(mark.markPrice), band = nonNegative(meta.marketTakeBound);
    if (band >= ONE) fail(INVALID_LIMIT);
    const at = fresh(Math.min(depth.at, reference.at, changed, fresh(mark.time, now())), now());
    return { at, bids: bidLevels(book.bids, ref * (ONE - band)), ...limits(meta, ref, true) };
  }
  return {
    catalog: async signal => (await metadata(signal)).candidates,
    async read(input, signal, reuseMetadata = true) {
      signal.throwIfAborted();
      const stop = new AbortController(), life = anySignal([signal, stop.signal], 8_000);
      try {
        const data = await (reuseMetadata ? metadata(life) : load(life));
        const asset = data.identities.get(input.chain + ':' + input.address.toLowerCase());
        if (!asset || input.symbol !== asset.candidate.symbol) fail('币安未能唯一匹配所选链、面额和合约地址');
        const pair = input.symbol + 'USDT';
        async function leg(enabled: boolean, read: () => Promise<GateLeg>, missing: string): Promise<GateLeg> {
          if (!enabled) return { error: missing };
          try { return await read(); } catch (error) {
            signal.throwIfAborted();
            if (isObject(error) && error.status === 429) return { error: '币安公开行情请求受限', rateLimited: true };
            return { error: error instanceof Error && error.message.includes('币安') ? error.message : '币安公开行情超时或不可用' };
          }
        }
        const [spot, perp] = await Promise.all([
          leg(!!asset.spot && asset.deposit === true, () => spotLeg(pair, asset.spot!, life), '币安未开放可核实的现货充值卖出路线'),
          leg(!!asset.perp, () => perpLeg(pair, asset.perp!, life), '币安未开放同币 USDT 线性永续'),
        ]);
        signal.throwIfAborted();
        if (now() >= data.expires) fail('币安网络或交易目录已过期');
        return { deposit: asset.deposit, withdraw: asset.withdraw, minDeposit: asset.minDeposit, spot, perp };
      } finally { stop.abort(); }
    },
  };
}
