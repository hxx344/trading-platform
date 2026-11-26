// 复制自 project-aggregation 工作台 modules/crossex/server/clients.mjs（提交 7745181），改动：npm 包 ws 改为本仓 ./node-ws.mjs；
// asset-identity 路径改为同目录；删去 embedded-request（Monitor 私有管道）及 createPublicClients 的 monitorTransport 参数；
// loadFeed 改为固定抛出 AppError（503）「本服务未提供合约价差机会源」，不再请求 Monitor。其余未改动。
import WebSocket from './node-ws.mjs';
import { AppError, monitorUrl, validIdentity, validManualIdentity } from './model.mjs';
import { createDepthReader } from './depth-reader.mjs';
import { positive, failure, HYPERLIQUID_INFO, sourceTime } from './public-values.mjs';
import { readSignal, sharedRead } from './shared-read.mjs';
import { D } from './money.mjs';
import { canonicalBase } from './asset-identity.mjs';

export const CATALOG_URL = 'https://api.gateio.ws/api/v4/crossex/rule/symbols';
const LIGHTER_MARKETS = 'https://mainnet.zklighter.elliot.ai/api/v1/orderBookDetails';
const KRAKEN_MARKETS = 'https://futures.kraken.com/derivatives/api/v3/instruments';
const BINANCE_MARKETS = 'https://fapi.binance.com/fapi/v1/exchangeInfo';
// Official contract/quantity and snapshot formats, checked 2026-09-22:
// https://www.okx.com/docs-v5/en/#public-data-rest-api-get-instruments
// https://www.gate.com/docs/developers/apiv4/en/#get-a-single-contract
// https://docs.kraken.com/api-reference/instrument-details/get-instruments
// https://docs.kraken.com/exchange/api-reference/futures-websocket/book
// https://hyperliquid.gitbook.io/hyperliquid-docs/trading/contract-specifications
// https://apidocs.lighter.xyz/docs/websocket-reference
const MAX_BYTES = 8 * 1024 * 1024, FX_MAX_AGE = 180_000;
// Native classifications, documented by OKX /public/instruments and Gate
// /futures/{settle}/contracts (checked 2026-10-09). Unknown classes stay blocked.
const okxClasses = new Map([['1', 'crypto'], ['3', 'stock'], ['4', 'commodity'], ['5', 'forex'], ['6', 'bond']]);
const gateClasses = new Map([['', 'crypto'], ['crypto', 'crypto'], ['stocks', 'stock'], ['metals', 'commodity'], ['commodities', 'commodity'], ['forex', 'forex'], ['indices', 'index']]);

// Match Monitor's crypto classification at the final depth boundary as well.
// A saved identityVerified flag is insufficient when the current feed is absent.
function binanceCrypto(row) {
  return row?.underlyingType === 'COIN' && row.contractType === 'PERPETUAL' && row.status === 'TRADING'
    && ['USDT', 'USDC'].includes(row.quoteAsset) && row.marginAsset === row.quoteAsset
    && row.symbol === `${row.baseAsset}${row.quoteAsset}` && Array.isArray(row.underlyingSubType)
    && row.underlyingSubType.every(value => typeof value === 'string'
      && !/pre.?launch|pre.?market|pre.?ipo/.test(value.toLowerCase())
      && !['stock', 'etf', 'commodities', 'commodity', 'forex', 'index', 'indices', 'tradfi'].includes(value.toLowerCase()));
}

async function readJson(url, init, { fetcher = fetch, maxBytes = MAX_BYTES, timeoutMs = 8000, signal } = {}) {
  signal?.throwIfAborted();
  const response = await fetcher(url, { ...init, redirect: 'error', signal: readSignal(signal, AbortSignal.timeout(timeoutMs)) });
  if (!response.ok) {
    await response.body?.cancel();
    const error = failure(response.status === 401 ? '来源认证失败，请检查价差模块登录信息' : `只读来源响应 ${response.status}`);
    error.sourceStatus = response.status; throw error;
  }
  const chunks = []; let length = 0;
  if (response.body) for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maxBytes) throw failure('来源响应过大');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure('来源没有返回有效 JSON'); }
}

/** The generic reader remains GET-only. Public POST is confined to Hyperliquid /info below. */
export function getJson(url, { headers = {}, ...options } = {}) {
  return readJson(url, { method: 'GET', headers: { Accept: 'application/json', ...headers } }, options);
}

/** Public, bounded one-shot readers. No API key, account endpoint, signer or order endpoint. */
export function createPublicClients({ fetcher = fetch, WebSocketImpl = WebSocket, clock = Date.now, timeoutMs = 8000, signal } = {}) {
  const options = { fetcher, timeoutMs }, metadata = new Map();
  let fxSnapshot = null, fxFlight = null, fxAttemptAt = -Infinity;
  const get = (url, headers, request) => getJson(url, { ...options, signal: readSignal(signal, request), ...(headers ? { headers } : {}) });
  const info = (type, coin, request) => {
    if (!['meta', 'l2Book'].includes(type)) throw new AppError('不支持的公开查询');
    return readJson(HYPERLIQUID_INFO, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(type === 'meta' ? { type } : { type, coin }) }, { ...options, signal: readSignal(signal, request) });
  };
  async function cached(key, loader, refresh = false, request) {
    request?.throwIfAborted();
    const previous = metadata.get(key), now = clock();
    if (previous?.flight && !previous.flight.signal.aborted) return previous.flight.wait(request);
    if (!refresh && previous?.value && now >= previous.at && now - previous.at < 300_000) return previous.value;
    if (metadata.size >= 128 && !metadata.has(key)) {
      const oldest = [...metadata].find(([, entry]) => !entry.flight);
      if (!oldest) throw failure('公开目录查询繁忙，请稍后重试');
      metadata.delete(oldest[0]);
    }
    const entry = { at: now, value: null, flight: null };
    entry.flight = sharedRead(async shared => {
      try { const value = await loader(shared); shared.throwIfAborted(); entry.value = value; entry.at = clock(); return value; }
      finally { entry.flight = null; }
    });
    metadata.set(key, entry); return entry.flight.wait(request);
  }
  async function contract(quote, manual = false, refresh = false, request) {
    const { exchange, symbol, quoteCurrency } = quote, rawBase = quote.rawBase ?? quote.base;
    const baseName = name => canonicalBase(exchange, name), base = baseName(quote.base);
    const settle = quote.settlementCurrency ?? quote.collateralCurrency, encoded = encodeURIComponent(symbol);
    const native = (key, url) => cached(key, shared => get(url, undefined, shared), refresh, request);
    let row, unit = 1, assetClass = 'crypto';
    if (exchange === 'binance') {
      const data = await native('binance', BINANCE_MARKETS);
      row = data.symbols?.find(item => item.symbol === symbol);
      if (!binanceCrypto(row) || row.baseAsset !== rawBase || baseName(row.baseAsset) !== base || row.quoteAsset !== quoteCurrency || row.marginAsset !== settle) throw failure('Binance 合约身份或交易状态未确认');
    } else if (exchange === 'bybit') {
      const data = await native(`bybit:${symbol}`, `https://api.bybit.com/v5/market/instruments-info?category=linear&symbol=${encoded}`);
      row = data.result?.list?.find(item => item.symbol === symbol);
      if (data.retCode !== 0 || data.result?.category !== 'linear' || !row || row.baseCoin !== rawBase || baseName(row.baseCoin) !== base || row.quoteCoin !== quoteCurrency || row.settleCoin !== settle || row.contractType !== 'LinearPerpetual' || row.status !== 'Trading' || row.isPreListing === true || Number(row.deliveryTime) > 0 || (typeof row.symbolType !== 'string' || !['', 'crypto', 'innovation'].includes(row.symbolType.toLowerCase())) || row.marketRegion || row.underlyingTicker) throw failure('Bybit 合约身份或交易状态未确认');
    } else if (exchange === 'okx') {
      const data = await native(`okx:${symbol}`, `https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId=${encoded}`);
      row = data.data?.find(item => item.instId === symbol);
      if (data.code !== '0' || !row || row.instType !== 'SWAP' || row.ctType !== 'linear' || row.ctValCcy !== rawBase || baseName(row.ctValCcy) !== base || row.settleCcy !== settle || row.state !== 'live' || row.ruleType !== 'normal' || Number(row.expTime) > 0 || (manual ? !okxClasses.has(row.instCategory) : !['1', '2'].includes(row.instCategory)) || row.instId !== `${rawBase}-${quoteCurrency}-SWAP` || !positive(row.ctVal) || Number(row.ctMult) !== 1) throw failure('OKX 合约数量单位或身份未确认');
      unit = row.ctVal;
      if (manual) assetClass = okxClasses.get(row.instCategory);
    } else if (exchange === 'gate') {
      row = await native(`gate:${symbol}`, `https://api.gateio.ws/api/v4/futures/usdt/contracts/${encoded}`);
      if (quoteCurrency !== 'USDT' || settle !== 'USDT' || row.name !== symbol || symbol !== `${rawBase}_USDT` || baseName(rawBase) !== base || row.type !== 'direct' || row.in_delisting !== false || (manual ? !gateClasses.has(row.contract_type) : !['', 'crypto'].includes(row.contract_type)) || row.is_pre_market !== false || (row.status !== undefined && row.status !== 'trading') || !positive(row.quanto_multiplier)) throw failure('Gate 合约数量单位或身份未确认');
      unit = row.quanto_multiplier;
      if (manual) assetClass = gateClasses.get(row.contract_type);
    } else if (exchange === 'kraken') {
      const data = await native('kraken', KRAKEN_MARKETS);
      row = data.instruments?.find(item => item.symbol === symbol);
      if (data.result !== 'success' || !row || row.type !== 'flexible_futures' || row.tradeable !== true || row.isExpired !== false || row.postOnly === true || row.tradfi !== false || baseName(row.base) !== base || baseName(rawBase) !== base || row.quote !== 'USD' || quoteCurrency !== 'USD' || settle !== 'USD' || Number(row.contractSize) !== 1) throw failure('Kraken 线性永续合约身份或数量单位未确认');
    } else if (exchange === 'hyperliquid') {
      const data = await cached('hyperliquid', shared => info('meta', undefined, shared), refresh, request);
      row = data.universe?.find(item => item.name === symbol);
      if (!row || row.name !== rawBase || baseName(row.name) !== base || row.isDelisted === true || !Number.isInteger(row.szDecimals) || row.szDecimals < 0 || !positive(row.maxLeverage) || data.collateralToken !== 0 || settle !== 'USDC' || quoteCurrency !== (['HYPE', 'PURR'].includes(symbol) ? 'USDC' : 'USDT')) throw failure('Hyperliquid 合约身份或结算币未确认');
    } else if (exchange === 'deribit') {
      const data = await native(`deribit:${symbol}`, `https://www.deribit.com/api/v2/public/get_instrument?instrument_name=${encoded}`);
      row = data.result;
      if (data.error || !row || row.instrument_name !== symbol || row.kind !== 'future' || row.is_active !== true || (row.instrument_type ?? row.future_type) !== 'linear' || row.instrument_type && row.future_type && row.instrument_type !== row.future_type || row.underlying_type !== 'crypto' || row.state !== undefined && row.state !== 'open' || row.settlement_period !== 'perpetual' || row.base_currency !== base || row.quote_currency !== 'USDC' || row.settlement_currency !== 'USDC' || settle !== 'USDC' || quoteCurrency !== 'USDC') throw failure('Deribit 线性永续合约身份未确认');
    } else if (exchange === 'lighter') {
      const data = await native('lighter', LIGHTER_MARKETS);
      row = data.order_book_details?.find(item => item.symbol === symbol && item.market_type === 'perp');
      if (data.code !== 200 || !row || row.symbol !== rawBase || baseName(row.symbol) !== base || row.status !== 'active' || row.is_frozen === true || row.market_config?.force_reduce_only === true || Number(row.funding_premium_multiplier) !== 100 || quoteCurrency !== 'USDC' || settle !== 'USDC' || Number(row.multiplier) !== 1 || !Number.isInteger(row.market_id) || row.market_id < 0 || row.market_id !== quote.marketId) throw failure('Lighter 合约身份、单位或 market_id 已变化');
    } else throw new AppError('不支持的深度合约');
    if (!manual && exchange !== 'binance') {
      const independent = await cached('binance', shared => get(BINANCE_MARKETS, undefined, shared), false, request);
      if (!independent.symbols?.some(item => item.baseAsset === base && binanceCrypto(item))) throw failure('缺少当前独立 Binance COIN 基础币身份，不能确认跨所合约');
    }
    return { row, unit, assetClass };
  }
  const depth = createDepthReader({ contract, get, info, clock, WebSocketImpl, timeoutMs, signal });
  function validRate(rate, now) {
    return rate && positive(rate.bid) && positive(rate.ask) && rate.bid <= rate.ask && Number.isFinite(rate.at) && rate.at >= 1e12 && rate.at <= now + 1000 && now - rate.at <= FX_MAX_AGE;
  }
  async function loadFx() {
    if (fxFlight) return fxFlight;
    const now = clock();
    if (fxSnapshot && now >= fxAttemptAt && now - fxAttemptAt < 60_000) return fxSnapshot;
    fxAttemptAt = now;
    fxFlight = (async () => {
      const rates = { USDT: { bid: 1, ask: 1, at: now, source: 'USDT 计价基准' } }, reasons = {};
      await Promise.all(['USDC', 'USD'].map(async currency => {
        const source = currency === 'USDC' ? 'https://api.gateio.ws/api/v4/spot/order_book?currency_pair=USDC_USDT&limit=1' : 'https://api.kraken.com/0/public/Depth?pair=USDTUSD&count=1';
        try {
          const data = await get(source);
          let bid, ask, at;
          if (currency === 'USDC') {
            bid = data.bids?.[0]; ask = data.asks?.[0]; at = sourceTime(data.update, clock(), FX_MAX_AGE);
          } else {
            if (!Array.isArray(data.error) || data.error.length || !data.result?.USDTZUSD) throw failure('Kraken USD 汇率响应无效');
            bid = data.result.USDTZUSD.bids?.[0]; ask = data.result.USDTZUSD.asks?.[0];
            at = Math.min(sourceTime(Number(bid?.[2]) * 1000, clock(), FX_MAX_AGE), sourceTime(Number(ask?.[2]) * 1000, clock(), FX_MAX_AGE));
          }
          if (![bid?.[0], bid?.[1], ask?.[0], ask?.[1]].every(positive) || Number(bid[0]) > Number(ask[0])) throw failure('汇率盘口缺失或交叉');
          const rate = currency === 'USD' ? { bid: 1 / Number(ask[0]), ask: 1 / Number(bid[0]), at, source } : { bid: Number(bid[0]), ask: Number(ask[0]), at, source };
          if (!validRate(rate, clock())) throw failure('汇率盘口无效或过期');
          if (fxSnapshot?.rates?.[currency]?.at > rate.at) throw failure('汇率来源时间回退');
          rates[currency] = rate;
        } catch (error) {
          const previous = fxSnapshot?.rates?.[currency];
          if (validRate(previous, clock())) rates[currency] = previous;
          reasons[currency] = `${rates[currency] ? '更新失败，沿用未过期的来源汇率：' : ''}${error instanceof AppError ? error.message : '公开汇率读取失败'}`;
        }
      }));
      return fxSnapshot = { baseCurrency: 'USDT', generatedAt: clock(), staleAfterMs: FX_MAX_AGE, rates, reasons };
    })().finally(() => { fxFlight = null; });
    return fxFlight;
  }
  // Native manual identities are isolated from the cross-venue Monitor proof.
  // Re-read metadata at each manual resolution so preview confirmation cannot
  // silently retain a changed unit or instrument classification for five minutes.
  async function resolveQuote(crossexSymbol, manual, request) {
    const match = /^(BINANCE|BYBIT|OKX|GATE|KRAKEN|HYPERLIQUID|DERIBIT|LIGHTER)_FUTURE_([A-Z0-9]{1,30})_(USDT|USDC|USD)$/.exec(crossexSymbol);
    if (!match) throw failure('该持仓合约不在支持的永续范围内');
    const exchange = match[1].toLowerCase(), base = match[2], counterCurrency = match[3];
    const quoteCurrency = exchange === 'hyperliquid' && !['HYPE', 'PURR'].includes(base) ? 'USDT' : counterCurrency;
    const symbol = exchange === 'binance' ? `${base}${quoteCurrency}`
      : exchange === 'bybit' ? quoteCurrency === 'USDC' ? `${base}PERP` : `${base}${quoteCurrency}`
      : exchange === 'okx' ? `${base}-${quoteCurrency}-SWAP`
      : exchange === 'gate' ? `${base}_USDT`
      : exchange === 'deribit' ? `${base}_USDC-PERPETUAL`
      : exchange === 'kraken' ? `PF_${base === 'BTC' ? 'XBT' : base}USD` : base;
    const q = { exchange, symbol, base: canonicalBase(exchange, base), rawBase: base, quoteCurrency, counterCurrency,
      settlementCurrency: counterCurrency, collateralCurrency: exchange === 'kraken' ? 'MULTI' : counterCurrency,
      contractKind: exchange === 'hyperliquid' && quoteCurrency !== counterCurrency ? 'quanto' : 'linear',
      crossexSymbol, multiplier: 1, assetClass: 'crypto', identityVerified: true, identitySource: 'exchange-instrument-metadata',
      ...(manual ? { identityScope: 'manual', nativeUnit: '1', comparable: false } : {}) };
    if (exchange === 'lighter') {
      const data = await cached('lighter', shared => get(LIGHTER_MARKETS, undefined, shared), false, request);
      q.marketId = data.order_book_details?.find(item => item.symbol === symbol && item.market_type === 'perp')?.market_id;
    }
    if (!(manual ? validManualIdentity(q) : validIdentity(q))) throw failure('持仓的合约币种或数量身份不受支持');
    const { unit, assetClass } = await contract(q, manual, manual, request);
    if (manual) Object.assign(q, { nativeUnit: D(unit).toString(), assetClass,
      comparable: assetClass === 'crypto' && !(exchange === 'gate' && base === 'EDGE') && !(exchange === 'lighter' && base === 'AI') });
    return q;
  }
  const loadDepth = (quote, request) => depth(quote, false, request);
  const loadManualDepth = (quote, request) => depth(quote, true, request);
  const resolveCrossexQuote = (symbol, request) => resolveQuote(symbol, false, request);
  const resolveManualQuote = (symbol, request) => resolveQuote(symbol, true, request);
  const loadCatalog = () => get(CATALOG_URL);
  // The service supplies its local public feed. Without it no opportunities are available.
  async function loadFeed() { throw new AppError('本服务未提供合约价差机会源', 503); }
  return { loadCatalog, loadFeed, loadDepth, loadManualDepth, loadFx, resolveCrossexQuote, resolveManualQuote };
}

const clients = createPublicClients();
export const loadCatalog = clients.loadCatalog;
export const loadFeed = clients.loadFeed;
export const loadDepth = clients.loadDepth;
export const loadManualDepth = clients.loadManualDepth;
export const loadFx = clients.loadFx;
export const resolveCrossexQuote = clients.resolveCrossexQuote;
export const resolveManualQuote = clients.resolveManualQuote;
