import { isObject } from '../contracts.ts';
import { decimal, fromUnits, units } from '../decimal.ts';
import Decimal from '../vendor/decimal.mjs';
import type { ScanCandidate } from './catalog.ts';
import { CHAIN_ARB_CLOCK_SKEW_MS, CHAIN_ARB_TTL_MS } from './model.ts';
import { assertOkxDirectory, type OkxDirectory } from './okx-network.ts';
import { createVenueCatalog, readVenueJson, type VenueBook, type VenueReader, type VenueReaderOptions } from './venue.ts';

type Row = Record<string, unknown>;
type Market = 'SPOT' | 'SWAP';
const INSTRUMENTS = '/api/v5/public/instruments?instType=';
const TTL = 300_000, LEVELS = 100, ONE = units('1');
// Three OKX decimal fields can each contain up to 78 digits (ctVal × ctMult × contracts).
const D = Decimal.clone({ precision: 240 });
const INVALID = 'OKX 公开市场记录无效', BOOK = 'OKX 买盘价格、数量或排序异常';
function fail(message: string): never { throw new Error(message); }
function timestamp(value: unknown) {
  return typeof value === 'string' && /^\d{13}$/.test(value) ? Number(value) : NaN;
}
function fresh(value: unknown, now: number): number {
  const at = typeof value === 'number' ? value : timestamp(value);
  if (!Number.isSafeInteger(at) || at <= 0 || at > now + CHAIN_ARB_CLOCK_SKEW_MS || now - at >= CHAIN_ARB_TTL_MS) {
    fail('OKX 行情已过期或时间异常');
  }
  return at;
}
function single(rows: Row[]) { return rows.length === 1 ? rows[0] : fail(INVALID); }
function productId(symbol: string, market: Market) { return symbol + (market === 'SPOT' ? '-USDT' : '-USDT-SWAP'); }
function tradable(row: Row | null | undefined, symbol: string, market: Market, now: number) {
  if (!row || row.instId !== productId(symbol, market) || row.instType !== market || row.instCategory !== '1'
    || row.state !== 'live' || row.ruleType !== 'normal' || row.expTime !== '' || !(timestamp(row.listTime) <= now)) return false;
  if (market === 'SPOT') return row.baseCcy === symbol && row.quoteCcy === 'USDT'
    && Array.isArray(row.tradeQuoteCcyList) && row.tradeQuoteCcyList.includes('USDT')
    && (row.contTdSwTime === '' || timestamp(row.contTdSwTime) <= now);
  const underlying = symbol + '-USDT';
  return row.uly === underlying && row.instFamily === underlying && row.ctValCcy === symbol
    && row.settleCcy === 'USDT' && row.ctType === 'linear';
}
function productMap(rows: Row[]) {
  const products = new Map<string, Row | null>();
  for (const row of rows) {
    if (typeof row.instId !== 'string' || !row.instId) fail(INVALID);
    products.set(row.instId, products.has(row.instId) ? null : row);
  }
  return products;
}
function sellFloor(limit: Row, id: string, market: Market) {
  // Spot and margin share the cash order book and OKX labels many of their price bands MARGIN.
  if (limit.instId !== id || (limit.instType !== market && !(market === 'SPOT' && limit.instType === 'MARGIN'))) fail(INVALID);
  if (limit.enabled === false && limit.sellLmt === '') return 0n;
  if (limit.enabled !== true) fail('OKX 卖价保护状态无效');
  return units(decimal(limit.sellLmt, 'positive'));
}
function bids(raw: unknown, market: Market, floor: bigint, face: Decimal): [string, string][] {
  if (!Array.isArray(raw) || !raw.length || raw.length > LEVELS) fail(BOOK);
  const result: [string, string][] = [];
  let previous: bigint | undefined, best = 0n, surplus = 0n;
  for (const level of raw) {
    if (!Array.isArray(level) || level.length !== 4) fail(BOOK);
    const price = decimal(level[0], 'positive'), quantity = decimal(level[1], 'positive'), px = units(price);
    if (previous !== undefined && px >= previous) fail(BOOK);
    if (previous === undefined) best = px;
    previous = px;
    if (px < floor) continue;
    if (market === 'SWAP') {
      result.push([price, face.times(quantity).toFixed()]);
      continue;
    }
    // OKX cancels a whole spot sell if its estimated average price is below 95% of the best bid.
    // Retain exactly the available prefix whose weighted average still meets that limit.
    const delta = 100n * px - 95n * best;
    let size = units(quantity);
    if (delta < 0n && size * -delta > surplus) size = surplus / -delta;
    surplus += delta * size;
    if (size > 0n) result.push([price, fromUnits(size)]);
  }
  return result.length ? result : fail('OKX 卖价保护范围内没有可成交买盘');
}

export function createOkxReader({ fetchImpl, now }: VenueReaderOptions, wallet: () => OkxDirectory): VenueReader {
  async function get(path: string, signal: AbortSignal, ttl = CHAIN_ARB_TTL_MS) {
    const { body, at } = await readVenueJson(fetchImpl, 'https://www.okx.com' + path, signal,
      ttl === TTL ? 5 * 1024 * 1024 : 160 * 1024, ttl, now);
    if (isObject(body) && body.code === '50011') throw Object.assign(new Error('OKX 公开行情请求受限'), { status: 429 });
    if (!isObject(body) || body.code !== '0' || !Array.isArray(body.data) || !body.data.length
      || body.data.length > 12_000 || !body.data.every(isObject)) fail(INVALID);
    return { rows: body.data as Row[], at };
  }
  async function record(path: string, signal: AbortSignal) {
    const { rows, at } = await get(path, signal);
    return { row: single(rows), at };
  }
  const markets = createVenueCatalog(async signal => {
    const [spot, perp] = await Promise.all([get(INSTRUMENTS + 'SPOT', signal, TTL), get(INSTRUMENTS + 'SWAP', signal, TTL)]);
    return { spot: productMap(spot.rows), perp: productMap(perp.rows), expires: Math.min(spot.at, perp.at) + TTL };
  }, now, TTL, value => value.expires);
  function combine(networks: OkxDirectory, listed: Awaited<ReturnType<typeof markets>>) {
    assertOkxDirectory(networks, now());
    const entries = new Map<string, { network: OkxDirectory['rows'][number]; candidate: ScanCandidate }>();
    const candidates: ScanCandidate[] = [];
    for (const network of networks.rows) {
      const { symbol, chain, address } = network;
      if (/^(?:10{2,}|\d+[MK])(?=\p{L})/u.test(symbol)) continue;
      const spot = network.depositEligible && tradable(listed.spot.get(productId(symbol, 'SPOT')), symbol, 'SPOT', now());
      const perp = tradable(listed.perp.get(productId(symbol, 'SWAP')), symbol, 'SWAP', now());
      const candidate = { symbol, chain, address, spot, perp };
      entries.set(chain + ':' + address, { network, candidate });
      if (spot || perp) candidates.push(candidate);
    }
    return { networks, listed, entries, candidates };
  }
  let combined: ReturnType<typeof combine> | undefined;
  async function index(signal: AbortSignal) {
    const listed = await markets(signal), networks = wallet();
    if (networks.at > now() || networks.expiresAt <= now()) fail('OKX 链目录已过期');
    if (!combined || combined.listed !== listed || combined.networks !== networks) combined = combine(networks, listed);
    return combined;
  }
  async function leg(market: Market, symbol: string, available: boolean, expires: number, signal: AbortSignal): Promise<VenueBook['spot']> {
    try {
      const unavailable = market === 'SPOT' ? 'OKX 普通 USDT 现货当前不可充值卖出' : 'OKX 同币 USDT 永续当前不可开仓';
      if (!available) fail(unavailable);
      const id = productId(symbol, market), query = 'instId=' + encodeURIComponent(id);
      const meta = await record(INSTRUMENTS + market + '&' + query, signal), row = meta.row;
      if (!tradable(row, symbol, market, now())) fail(unavailable);
      // A known rule change cannot be crossed by a quote based on the old instrument parameters.
      if (!Array.isArray(row.upcChg) || !row.upcChg.every(isObject)) fail(INVALID);
      for (const change of row.upcChg) {
        const at = timestamp(change.effTime);
        if (!Number.isFinite(at)) fail(INVALID);
        expires = Math.min(expires, at);
      }
      const face = market === 'SPOT' ? new D(1) : new D(decimal(row.ctVal, 'positive')).times(decimal(row.ctMult, 'positive'));
      const step = face.times(decimal(row.lotSz, 'positive')).toFixed();
      const minQuantity = face.times(decimal(row.minSz, 'positive')).toFixed();
      const [book, band, fx, interest] = await Promise.all([
        record('/api/v5/market/books?' + query + '&sz=' + LEVELS, signal),
        record('/api/v5/public/price-limit?' + query, signal),
        market === 'SPOT' ? record('/api/v5/market/index-tickers?instId=USDT-USD', signal) : undefined,
        market === 'SWAP' && (row.maxPlatOILmt !== '' || row.maxPlatOICoinLmt !== '')
          ? record('/api/v5/public/open-interest?instType=SWAP&' + query, signal) : undefined,
      ]);
      const sourceAt = (value: typeof book) => Math.min(value.at, fresh(value.row.ts, now()));
      const at = fresh(Math.min(meta.at, sourceAt(book), sourceAt(band), fx ? sourceAt(fx) : Infinity,
        interest ? sourceAt(interest) : Infinity, expires - CHAIN_ARB_TTL_MS), now());
      if (interest) {
        if (interest.row.instId !== id || interest.row.instType !== market) fail(INVALID);
        for (const [cap, used] of [[row.maxPlatOILmt, interest.row.oiUsd], [row.maxPlatOICoinLmt, interest.row.oiCcy]]) {
          if (cap !== '' && units(decimal(used, 'nonnegative')) >= units(decimal(cap, 'positive'))) fail('OKX 永续平台持仓已达开仓上限');
        }
      }
      const levels = bids(book.row.bids, market, sellFloor(band.row, id, market), face);
      if (!fx) return { at, bids: levels, step, minQuantity, maxQuantity: face.times(decimal(row.maxMktSz, 'positive')).toFixed() };
      if (fx.row.instId !== 'USDT-USD') fail('OKX 美元指数身份不符');
      // Cash maxMktSz is in USDT and maxMktAmt is in USD, even for a sell sized in base currency.
      const usdCap = units(decimal(row.maxMktAmt, 'positive')) * ONE / units(decimal(fx.row.idxPx, 'positive'));
      const usdtCap = row.maxMktSz === '' ? usdCap : units(decimal(row.maxMktSz, 'positive'));
      return { at, bids: levels, step, minQuantity, maxNotional: fromUnits(usdCap < usdtCap ? usdCap : usdtCap) };
    } catch (error) {
      signal.throwIfAborted();
      if (isObject(error) && error.status === 429) return { error: 'OKX 公开行情请求受限', rateLimited: true };
      return { error: error instanceof Error && error.message.startsWith('OKX') ? error.message : 'OKX 行情或市场规则无效' };
    }
  }
  return {
    async catalog(signal) { return (await index(signal)).candidates; },
    async read(input, signal) {
      const data = await index(signal);
      const asset = data.entries.get(input.chain + ':' + input.address.toLowerCase());
      if (!asset || asset.network.symbol !== input.symbol) fail('OKX 未能唯一匹配所选链与代币合约地址');
      const expires = Math.min(data.networks.expiresAt, data.listed.expires);
      const [spot, perp] = await Promise.all([asset.network.deposit === true && !asset.network.depositEligible
        ? { error: 'OKX 已开放充值，但该网络的到账条件或费用无法完整测算' }
        : leg('SPOT', input.symbol, asset.candidate.spot, expires, signal),
        leg('SWAP', input.symbol, asset.candidate.perp, expires, signal)]);
      signal.throwIfAborted();
      if (wallet() !== data.networks || now() < data.networks.at || now() >= expires) fail('OKX 链或市场目录已更新或过期');
      const { deposit, withdraw, minDeposit } = asset.network;
      return { spot, perp, deposit, withdraw, minDeposit };
    },
  };
}
