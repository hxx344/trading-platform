// 复制自 project-aggregation 工作台 modules/monitor：lib/exchange-quotes.ts（提交 568a20d）的交易所清单、合约定义、报价校验
// 与价差/年化计算，lib/exchange-service.ts（c4c7910）的 Bybit / Binance 解析，lib/oil-cex.ts（1fdb6e8）的 OKX / Bitget / Gate
// 解析，lib/oil-dex.ts（8470785）的 Lighter 合约目录、market_stats 解析与只读快照订阅，modules/oil/hyperliquid.mjs（c534894）
// 的 metaAndAssetCtxs 解析。只放数据规则，服务端读取器（src/monitor/exchanges.ts）与页面共用。与原文件不同的地方：
// - Hyperliquid 两个市场都走同一个校验（工作台原油走单独的 validateComparisonQuote、海力士只作主报价不校验）：Hyperliquid
//   每小时整点结算，下次结算时间按下一个整点推算并标 nextFundingEstimated，于是资金费字段完整，通用校验可用；
// - 原油 Hyperliquid 的 fetchedAt 是服务收到应答的时间（接口不带行情时间），标 timestampBasis: 'received'；
// - 海力士 Hyperliquid 价格仍是采集器的 allMids 中间价，资金费另取 metaAndAssetCtxs 的预言机价与小时费率；
// - 各交易所改为按合约请求（工作台读整个市场的合约目录与报价列表，单次几百 KB 到几 MB），所以 Bybit 两腿各一个
//   tickers 应答：各自校验时间、取较早者，两腿相差超过 15 秒作废（与其它交易所同一口径）；
// - Binance 海力士不读 exchangeInfo（整个合约目录约数 MB）：按合约读 premiumIndex，不再核对合约状态与类型，合约下架时
//   接口报错，本轮失败；
// - Variational 需要登录会话，不接入：页面显示「未接入」，服务端不支持该交易所；
// - Lighter 快照订阅多接一个中止信号（服务停止时立即结束）。
import { oilSpread } from './oil-market.mjs';

export const EXCHANGE_REFRESH_MS = 15_000;
export const EXCHANGE_STALE_MS = 45_000;
const HOUR = 3_600_000;

/** 页面展示顺序；Variational 只占一行「未接入」。 */
export const DISPLAY_EXCHANGES = Object.freeze({
  oil: Object.freeze(['hyperliquid', 'bybit', 'binance', 'lighter', 'variational', 'okx', 'bitget']),
  hynix: Object.freeze(['hyperliquid', 'bybit', 'binance', 'okx', 'bitget', 'gate']),
});
/** 服务端能读的交易所。 */
export const COMPARISON_EXCHANGES = Object.freeze({
  oil: Object.freeze(['hyperliquid', 'bybit', 'binance', 'lighter', 'okx', 'bitget']),
  hynix: Object.freeze(['hyperliquid', 'bybit', 'binance', 'okx', 'bitget', 'gate']),
});
export const supportsExchange = (market, exchange) => Object.hasOwn(COMPARISON_EXCHANGES, market) && COMPARISON_EXCHANGES[market].includes(exchange);
export const EXCHANGE_NAMES = Object.freeze({ hyperliquid: 'Hyperliquid', bybit: 'Bybit', binance: 'Binance', lighter: 'Lighter', variational: 'Variational', okx: 'OKX', bitget: 'Bitget', gate: 'Gate' });
export const EXCHANGE_CONTRACTS = Object.freeze({
  oil: Object.freeze({ left: 'BZUSDT', right: 'CLUSDT', leftBase: 'BZ', rightBase: 'CL', leftLabel: '布伦特', rightLabel: 'WTI', leftUnits: 1 }),
  hynix: Object.freeze({ left: 'SKHYUSDT', right: 'SKHYNIXUSDT', leftBase: 'SKHY', rightBase: 'SKHYNIX', leftLabel: 'ADR', rightLabel: '正股', leftUnits: 10 }),
});
const DEFINITIONS = {
  oil: {
    hyperliquid: { left: 'xyz:BRENTOIL', right: 'xyz:CL', currency: 'USD', priceBasis: 'mark', fundingPriceBasis: 'oracle' },
    bybit: { left: 'BZUSDT', right: 'CLUSDT', currency: 'USDT', priceBasis: 'mark', fundingPriceBasis: 'mark' },
    binance: { left: 'BZUSDT', right: 'CLUSDT', currency: 'USDT', priceBasis: 'mark', fundingPriceBasis: 'mark' },
    lighter: { left: 'BRENTOIL', right: 'WTI', currency: 'USDC', priceBasis: 'mark', fundingPriceBasis: 'index' },
    variational: { left: 'BZ', right: 'CL', currency: 'USDC', priceBasis: 'mark', fundingPriceBasis: 'mark' },
    okx: { left: 'BZ-USDT-SWAP', right: 'CL-USDT-SWAP', currency: 'USDT', priceBasis: 'mark', fundingPriceBasis: 'mark' },
    bitget: { left: 'BZUSDT', right: 'CLUSDT', currency: 'USDT', priceBasis: 'mark', fundingPriceBasis: 'mark' },
  },
  // All Hynix CEX contracts quote one ADR or one ordinary share per unit of mark price.
  hynix: {
    hyperliquid: { left: 'xyz:SKHY', right: 'xyz:SKHX', currency: 'USD', priceBasis: 'mid', fundingPriceBasis: 'oracle' },
    bybit: { left: 'SKHYUSDT', right: 'SKHYNIXUSDT', currency: 'USDT', priceBasis: 'mark', fundingPriceBasis: 'mark' },
    binance: { left: 'SKHYUSDT', right: 'SKHYNIXUSDT', currency: 'USDT', priceBasis: 'mark', fundingPriceBasis: 'mark' },
    okx: { left: 'SKHY-USDT-SWAP', right: 'SKHYNIX-USDT-SWAP', currency: 'USDT', priceBasis: 'mark', fundingPriceBasis: 'mark' },
    bitget: { left: 'SKHYUSDT', right: 'SKHYNIXUSDT', currency: 'USDT', priceBasis: 'mark', fundingPriceBasis: 'mark' },
    gate: { left: 'SKHY_USDT', right: 'SKHYNIX_USDT', currency: 'USDT', priceBasis: 'mark', fundingPriceBasis: 'mark' },
  },
};
export function exchangeDefinition(exchange, market) {
  const definition = Object.hasOwn(DEFINITIONS, market) && Object.hasOwn(DEFINITIONS[market], exchange) ? DEFINITIONS[market][exchange] : null;
  if (!definition) throw new Error('Unsupported exchange comparison market');
  return definition;
}

export function calculateExchangeSpread(quote) {
  const units = EXCHANGE_CONTRACTS[quote.monitorId].leftUnits;
  const left = quote.left, right = quote.right;
  const equivalent = right.price / units;
  // Oil compares the absolute Brent − WTI spread on decimal quotes; `premium` only serves Hynix.
  const spread = quote.monitorId === 'oil' ? oilSpread(left.price, right.price) ?? NaN : left.price - equivalent, premium = (left.price / equivalent - 1) * 100;
  const hasFunding = [left, right].every(leg => leg.fundingRate !== null && Number.isFinite(leg.fundingRate) && leg.fundingPrice !== null && leg.fundingPrice > 0 && leg.fundingIntervalHours !== null && leg.fundingIntervalHours > 0);
  const grossNotional = hasFunding ? units * left.fundingPrice + right.fundingPrice : null;
  const hourlyCashflow = hasFunding ? units * left.fundingPrice * left.fundingRate / left.fundingIntervalHours - right.fundingPrice * right.fundingRate / right.fundingIntervalHours : null;
  const shortAnnualized = grossNotional !== null && hourlyCashflow !== null ? hourlyCashflow / grossNotional * 8760 : null;
  if (![equivalent, spread, premium].every(Number.isFinite) || (shortAnnualized !== null && !Number.isFinite(shortAnnualized))) throw new Error('Invalid spread calculation');
  return { equivalent, spread, premium, shortAnnualized, longAnnualized: shortAnnualized === null ? null : -shortAnnualized };
}

export function externalQuoteStale(quote, now) {
  const maxAge = quote.exchange === 'hyperliquid' ? quote.monitorId === 'oil' ? 75_000 : 25_000 : EXCHANGE_STALE_MS;
  // OKX publishes funding snapshots every 30–90s; quote freshness stays at 45s.
  const fundingMaxAge = quote.exchange === 'okx' ? 120_000 : maxAge;
  return quote.status === 'snapshot' || now - Date.parse(quote.fetchedAt) > maxAge || (quote.fundingFetchedAt !== null && now - Date.parse(quote.fundingFetchedAt) > fundingMaxAge);
}

/** Runtime boundary shared by the service and the page. Derived numbers are recomputed. */
export function validateExchangeQuote(input, exchange, monitorId) {
  if (!input || typeof input !== 'object') throw new Error('Invalid exchange quote');
  if (!supportsExchange(monitorId, exchange)) throw new Error('Unsupported exchange comparison market');
  const value = input, contracts = exchangeDefinition(exchange, monitorId);
  const stamp = time => typeof time === 'string' && Number.isFinite(Date.parse(time));
  if (value.exchange !== exchange || value.monitorId !== monitorId || value.currency !== contracts.currency || value.priceBasis !== contracts.priceBasis || value.fundingPriceBasis !== contracts.fundingPriceBasis || !['live', 'snapshot'].includes(value.status) || !stamp(value.fetchedAt) || (value.fundingFetchedAt !== null && !stamp(value.fundingFetchedAt)) || (value.timestampBasis !== undefined && !['source', 'received'].includes(value.timestampBasis))) throw new Error('Exchange quote identity mismatch');
  const leg = (input, symbol) => {
    if (!input || input.symbol !== symbol || typeof input.price !== 'number' || !Number.isFinite(input.price) || input.price <= 0) throw new Error('Invalid exchange contract price');
    if (contracts.fundingPriceBasis === 'mark' ? input.fundingPrice !== input.price : input.fundingPrice !== null && (typeof input.fundingPrice !== 'number' || !Number.isFinite(input.fundingPrice) || input.fundingPrice <= 0)) throw new Error('Invalid exchange funding price');
    if (input.fundingRate !== null && (typeof input.fundingRate !== 'number' || !Number.isFinite(input.fundingRate) || Math.abs(input.fundingRate) > 1)) throw new Error('Invalid exchange funding rate');
    if (input.fundingIntervalHours !== null && (!Number.isInteger(input.fundingIntervalHours) || input.fundingIntervalHours < 1 || input.fundingIntervalHours > 24)) throw new Error('Invalid funding interval');
    if (input.nextFundingAt !== null && (!stamp(input.nextFundingAt) || Date.parse(input.nextFundingAt) < Date.parse(value.fetchedAt) - 60_000 || Date.parse(input.nextFundingAt) > Date.parse(value.fetchedAt) + 25 * HOUR)) throw new Error('Invalid funding settlement time');
    if (input.nextFundingEstimated !== undefined && typeof input.nextFundingEstimated !== 'boolean') throw new Error('Invalid settlement time basis');
    return { symbol, price: input.price, fundingPrice: input.fundingPrice, fundingRate: input.fundingRate, fundingIntervalHours: input.fundingIntervalHours, nextFundingAt: input.nextFundingAt, ...(input.nextFundingEstimated !== undefined ? { nextFundingEstimated: input.nextFundingEstimated } : {}) };
  };
  if (value.fundingFetchedAt !== null && Date.parse(value.fundingFetchedAt) > Date.parse(value.fetchedAt) + 60_000) throw new Error('Invalid funding receipt time');
  const quote = { exchange, monitorId, currency: contracts.currency, priceBasis: contracts.priceBasis, fundingPriceBasis: contracts.fundingPriceBasis, fetchedAt: value.fetchedAt, ...(value.timestampBasis ? { timestampBasis: value.timestampBasis } : {}), fundingFetchedAt: value.fundingFetchedAt, status: value.status === 'snapshot' ? 'snapshot' : 'live', left: leg(value.left, contracts.left), right: leg(value.right, contracts.right), fundingError: typeof value.fundingError === 'string' ? value.fundingError : '' };
  if ([quote.left, quote.right].some(leg => leg.fundingRate !== null && (leg.fundingPrice === null || leg.fundingIntervalHours === null || leg.nextFundingAt === null || quote.fundingFetchedAt === null))) throw new Error('Incomplete funding metadata');
  calculateExchangeSpread(quote);
  return quote;
}

// ---- shared parsing helpers (lib/exchange-service.ts, lib/oil-cex.ts) ----
const obj = value => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid exchange response'); return value; };
const list = value => { if (!Array.isArray(value)) throw new Error('Invalid exchange list'); return value.map(obj); };
const finite = value => { if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '' || !Number.isFinite(Number(value))) throw new Error('Invalid exchange number'); return Number(value); };
const positive = value => { const result = finite(value); if (result <= 0) throw new Error('Invalid exchange price'); return result; };
const optionalNumber = value => { try { return finite(value); } catch { return null; } };
const interval = value => { const hours = optionalNumber(value); return hours !== null && Number.isInteger(hours) && hours > 0 && hours <= 24 ? hours : null; };
function unique(items, field, symbol) { const matches = items.filter(item => item[field] === symbol); if (matches.length !== 1) throw new Error(`Missing or duplicate contract ${symbol}`); return matches[0]; }
function sourceTime(value, now) { const result = finite(value); if (!Number.isSafeInteger(result) || result <= 0 || result < now - 120_000 || result > now + 60_000) throw new Error('Delayed or invalid exchange quote'); return result; }
function timestamp(value) { const result = finite(value); if (!Number.isSafeInteger(result) || result <= 0) throw new Error('Invalid exchange timestamp'); return result; }
function synchronized(times) { if (Math.max(...times) - Math.min(...times) > 15_000) throw new Error('Exchange quote legs are not synchronized'); }
const marketBases = monitorId => [EXCHANGE_CONTRACTS[monitorId].leftBase, EXCHANGE_CONTRACTS[monitorId].rightBase];
const nextHour = time => new Date((Math.floor(time / HOUR) + 1) * HOUR).toISOString();
const FUNDING_MISSING = '资金费或结算周期暂不可用，价格仍正常更新。';

/** USDT-margined mark-price venues: missing current settlement metadata must not fabricate a funding estimate. */
function finishMark(exchange, monitorId, times, left, right, fundingFetchedAt = null, timestampBasis) {
  synchronized(times);
  const complete = [left, right].every(leg => leg.fundingRate !== null && leg.fundingIntervalHours !== null && leg.nextFundingAt !== null);
  if (!complete) { left = { ...left, fundingRate: null }; right = { ...right, fundingRate: null }; }
  const fetchedAt = new Date(Math.min(...times)).toISOString();
  return validateExchangeQuote({ exchange, monitorId, currency: 'USDT', priceBasis: 'mark', fundingPriceBasis: 'mark', fetchedAt, ...(timestampBasis ? { timestampBasis } : {}), fundingFetchedAt: complete ? fundingFetchedAt ?? fetchedAt : null, status: 'live', left, right, fundingError: complete ? '' : FUNDING_MISSING }, exchange, monitorId);
}

// ---- Bybit (lib/exchange-service.ts parseBybitQuote) ----
function bybit(response) { const value = obj(response); if (value.retCode !== 0) throw new Error('Bybit market response failed'); const result = obj(value.result); if (result.category !== 'linear') throw new Error('Unexpected Bybit contract category'); return { value, result, items: list(result.list) }; }
/** `instruments`: the instruments-info items of both legs; `tickers`: one tickers reply per leg. */
export function parseBybitQuote(monitorId, instruments, tickers, now = Date.now()) {
  const contracts = EXCHANGE_CONTRACTS[monitorId], replies = list(tickers).map(bybit), times = replies.map(reply => sourceTime(reply.value.time, now));
  const items = replies.flatMap(reply => reply.items), fetchedAt = Math.min(...times);
  const leg = (symbol, base) => {
    const metadata = unique(list(instruments), 'symbol', symbol), ticker = unique(items, 'symbol', symbol);
    if (metadata.status !== 'Trading' || metadata.contractType !== 'LinearPerpetual' || metadata.baseCoin !== base || metadata.quoteCoin !== 'USDT' || metadata.settleCoin !== 'USDT' || metadata.isPreListing === true) throw new Error('Unsupported Bybit contract');
    const price = positive(ticker.markPrice);
    const fundingIntervalHours = ticker.fundingIntervalHour === undefined ? interval(optionalNumber(metadata.fundingInterval) === null ? null : finite(metadata.fundingInterval) / 60) : interval(ticker.fundingIntervalHour);
    const fundingRate = optionalNumber(ticker.fundingRate), next = optionalNumber(ticker.nextFundingTime);
    return { symbol, price, fundingPrice: price, fundingRate: fundingRate !== null && Math.abs(fundingRate) <= 1 ? fundingRate : null, fundingIntervalHours, nextFundingAt: next !== null && next >= fetchedAt - 60_000 && next <= now + 25 * HOUR ? new Date(next).toISOString() : null };
  };
  return finishMark('bybit', monitorId, times, leg(contracts.left, contracts.leftBase), leg(contracts.right, contracts.rightBase));
}
/** Bybit instruments-info items of one symbol's reply. */
export const bybitInstruments = response => bybit(response).items;

// ---- Binance (lib/exchange-service.ts parseBinanceQuote, without the exchangeInfo contract check) ----
/** `tickers`: the per-symbol premiumIndex replies of both legs; `fundingInfo`: the fundingInfo list, null when it failed. */
export function parseBinanceQuote(monitorId, tickers, fundingInfo, now = Date.now()) {
  const contracts = EXCHANGE_CONTRACTS[monitorId], items = list(tickers);
  const funding = fundingInfo === null ? [] : list(fundingInfo), times = [];
  const leg = symbol => {
    const ticker = unique(items, 'symbol', symbol), source = sourceTime(ticker.time, now);
    times.push(source);
    const price = positive(ticker.markPrice), specs = funding.filter(item => item.symbol === symbol);
    if (specs.length > 1) throw new Error('Duplicate funding metadata');
    const fundingRate = optionalNumber(ticker.lastFundingRate), next = optionalNumber(ticker.nextFundingTime);
    return { symbol, price, fundingPrice: price, fundingRate: fundingRate !== null && Math.abs(fundingRate) <= 1 ? fundingRate : null, fundingIntervalHours: interval(specs[0]?.fundingIntervalHours), nextFundingAt: next !== null && next >= source - 60_000 && next <= now + 25 * HOUR ? new Date(next).toISOString() : null };
  };
  const left = leg(contracts.left), right = leg(contracts.right);
  return finishMark('binance', monitorId, times, left, right);
}

/** The oil collector's validated Binance market (oil-market.mjs validateMarket) as a comparison row. */
export function binanceOilExchangeQuote(market, stale = false) {
  const leg = item => ({ symbol: item.coin, price: item.markPx, fundingPrice: item.markPx, fundingRate: item.fundingRate, fundingIntervalHours: item.fundingIntervalHours, nextFundingAt: item.nextFundingAt });
  const complete = market.brent.fundingRate !== null && market.wti.fundingRate !== null;
  const hasFunding = market.brent.fundingRate !== null || market.wti.fundingRate !== null;
  return validateExchangeQuote({ exchange: 'binance', monitorId: 'oil', currency: 'USDT', priceBasis: 'mark', fundingPriceBasis: 'mark', fetchedAt: market.fetchedAt, fundingFetchedAt: hasFunding ? market.fetchedAt : null, status: stale ? 'snapshot' : 'live', left: leg(market.brent), right: leg(market.wti), fundingError: complete ? '' : FUNDING_MISSING }, 'binance', 'oil');
}

// ---- OKX / Bitget / Gate (lib/oil-cex.ts) ----
function envelope(value, code) {
  const response = obj(value);
  if (response.code !== code || !Array.isArray(response.data)) throw new Error('Exchange market response failed');
  return { response, items: response.data.map(obj) };
}
// Keep official response envelopes, including Bitget's server requestTime.
const envelopes = value => Array.isArray(value) ? value : [value];
const rows = (value, code) => envelopes(value).flatMap(item => envelope(item, code).items);
const priceLeg = (symbol, value) => ({ symbol, price: positive(value), fundingPrice: positive(value), fundingRate: null, fundingIntervalHours: null, nextFundingAt: null });
function fundingFields(rate, hours, next, time, priceTime, now) {
  const fundingRate = finite(rate), fundingIntervalHours = finite(hours), nextTime = timestamp(next);
  if (Math.abs(fundingRate) > 1 || !Number.isInteger(fundingIntervalHours) || fundingIntervalHours < 1 || fundingIntervalHours > 24) throw new Error('Invalid funding rate or interval');
  if (nextTime < Math.max(time, now, priceTime) - 60_000 || nextTime > priceTime + 25 * HOUR) throw new Error('Invalid funding settlement time');
  return { fundingRate, fundingIntervalHours, nextFundingAt: new Date(nextTime).toISOString(), sourceTime: time };
}
function optionalFunding(load, priceTime) {
  try {
    const result = load();
    if (result.length !== 2) throw new Error('Missing funding leg');
    // Funding snapshots update independently (OKX every 30–90s). Each leg already passed its own freshness check; only
    // prices need the 15s gap.
    if (Math.max(...result.map(item => item.sourceTime)) > priceTime + 60_000) throw new Error('Funding source is ahead of mark prices');
    return result;
  } catch { return null; }
}
function finishCex(exchange, monitorId, times, legs, funding, timestampBasis) {
  const apply = (leg, index) => { const item = funding?.[index]; return item ? { ...leg, fundingRate: item.fundingRate, fundingIntervalHours: item.fundingIntervalHours, nextFundingAt: item.nextFundingAt } : leg; };
  const fundingFetchedAt = funding ? new Date(Math.min(...funding.map(item => item.sourceTime))).toISOString() : null;
  return finishMark(exchange, monitorId, times, apply(legs[0], 0), apply(legs[1], 1), fundingFetchedAt, timestampBasis);
}

/** Official OKX envelopes (one or several); funding may contain one response per contract, null entries when one failed. */
export function parseOkxQuote(monitorId, instruments, marks, funding, now = Date.now()) {
  const metadata = rows(instruments, '0'), prices = rows(marks, '0'), times = [];
  const legs = marketBases(monitorId).map(base => {
    const symbol = `${base}-USDT-SWAP`, spec = unique(metadata, 'instId', symbol), mark = unique(prices, 'instId', symbol);
    if (spec.state !== 'live' || spec.instType !== 'SWAP' || spec.ctType !== 'linear' || spec.settleCcy !== 'USDT' || spec.ctValCcy !== base || spec.instFamily !== `${base}-USDT` || spec.uly !== `${base}-USDT` || spec.ruleType !== 'normal' || mark.instType !== 'SWAP') throw new Error('Unsupported OKX contract');
    times.push(sourceTime(mark.ts, now));
    // ctVal is contract size; markPx already quotes one unit in USDT.
    return priceLeg(symbol, mark.markPx);
  });
  const priceTime = Math.min(...times);
  const completeFunding = optionalFunding(() => {
    const rates = rows(funding, '0');
    return legs.map(leg => {
      const item = unique(rates, 'instId', leg.symbol);
      if (item.instType !== 'SWAP' || item.method !== 'current_period') throw new Error('Unsupported OKX funding contract');
      const time = sourceTime(item.ts, now), settlement = timestamp(item.fundingTime);
      // fundingTime settles fundingRate; nextFundingTime is the following cycle.
      return fundingFields(item.fundingRate, (timestamp(item.nextFundingTime) - settlement) / HOUR, settlement, time, priceTime, now);
    });
  }, priceTime);
  return finishCex('okx', monitorId, times, legs, completeFunding);
}

/** Official Bitget USDT-FUTURES envelopes; rates are decimal values, not percentages. */
export function parseBitgetQuote(monitorId, instruments, tickers, funding, now = Date.now()) {
  const metadata = rows(instruments, '00000'), prices = rows(tickers, '00000'), times = [];
  const legs = marketBases(monitorId).map(base => {
    const symbol = `${base}USDT`, spec = unique(metadata, 'symbol', symbol), ticker = unique(prices, 'symbol', symbol);
    if (spec.symbolStatus !== 'normal' || spec.symbolType !== 'perpetual' || spec.baseCoin !== base || spec.quoteCoin !== 'USDT' || !Array.isArray(spec.supportMarginCoins) || spec.supportMarginCoins.length !== 1 || spec.supportMarginCoins[0] !== 'USDT') throw new Error('Unsupported Bitget contract');
    times.push(sourceTime(ticker.ts, now));
    return priceLeg(symbol, ticker.markPrice);
  });
  const priceTime = Math.min(...times);
  const completeFunding = optionalFunding(() => {
    const rates = envelopes(funding).flatMap(value => {
      const { response, items } = envelope(value, '00000'), time = sourceTime(response.requestTime, now);
      return items.map(item => ({ item, time }));
    });
    return legs.map(leg => {
      const matches = rates.filter(rate => rate.item.symbol === leg.symbol);
      if (matches.length !== 1) throw new Error('Missing or duplicate Bitget funding contract');
      const { item, time } = matches[0];
      return fundingFields(item.fundingRate, item.fundingRateInterval, item.nextUpdate, time, priceTime, now);
    });
  }, priceTime);
  return finishCex('bitget', monitorId, times, legs, completeFunding);
}

/**
 * Gate USDT contract details, one object per leg. Gate publishes no quote timestamp, so the receipt time is reported as such.
 * funding_rate is the decimal rate applied at funding_next_apply (Unix seconds).
 * https://www.gate.com/docs/developers/apiv4/en/futures/#get-a-single-contract
 */
export function parseGateQuote(monitorId, details, receivedAt) {
  if (!Array.isArray(details) || details.length !== 2) throw new Error('Invalid Gate contract response');
  const now = timestamp(receivedAt);
  const specs = marketBases(monitorId).map((base, index) => {
    const symbol = `${base}_USDT`, spec = obj(details[index]);
    if (spec.name !== symbol || spec.status !== 'trading' || spec.in_delisting !== false || spec.type !== 'direct') throw new Error('Unsupported Gate contract');
    return { symbol, spec };
  });
  const legs = specs.map(({ symbol, spec }) => priceLeg(symbol, spec.mark_price));
  const completeFunding = optionalFunding(() => specs.map(({ spec }) => fundingFields(spec.funding_rate, finite(spec.funding_interval) / 3600, timestamp(spec.funding_next_apply) * 1000, now, now, now)), now);
  return finishCex('gate', monitorId, [now, now], legs, completeFunding, 'received');
}

// ---- Hyperliquid (modules/oil/hyperliquid.mjs parseMarketResponse, generalised to any xyz coins) ----
/** markPx, oraclePx and the hourly funding of each coin in a metaAndAssetCtxs reply. */
export function parseHyperliquidContexts(response, coins) {
  if (!Array.isArray(response) || !Array.isArray(response[0]?.universe) || !Array.isArray(response[1])) throw new Error('Invalid market response');
  return coins.map(coin => {
    const index = response[0].universe.findIndex(item => item?.name === coin);
    if (index < 0 || !response[1][index]) throw new Error(`Missing ${coin}`);
    if (response[0].universe[index].isDelisted) throw new Error(`Inactive ${coin}`);
    const context = obj(response[1][index]);
    return { coin, markPx: positive(context.markPx), oraclePx: positive(context.oraclePx), funding: finite(context.funding) };
  });
}
const hyperliquidLeg = (symbol, price, context, at) => ({ symbol, price, fundingPrice: context?.oraclePx ?? null, fundingRate: context && Math.abs(context.funding) <= 1 ? context.funding : null, fundingIntervalHours: context ? 1 : null, nextFundingAt: context ? nextHour(at) : null, ...(context ? { nextFundingEstimated: true } : {}) });
/** Oil on Hyperliquid xyz: marks and oracle-priced hourly funding from one metaAndAssetCtxs reply received at `receivedAt`. */
export function hyperliquidOilQuote(response, receivedAt) {
  const [brent, wti] = parseHyperliquidContexts(response, ['xyz:BRENTOIL', 'xyz:CL']), fetchedAt = new Date(receivedAt).toISOString();
  return validateExchangeQuote({ exchange: 'hyperliquid', monitorId: 'oil', currency: 'USD', priceBasis: 'mark', fundingPriceBasis: 'oracle', fetchedAt, timestampBasis: 'received', fundingFetchedAt: fetchedAt, status: 'live', left: hyperliquidLeg('xyz:BRENTOIL', brent.markPx, brent, receivedAt), right: hyperliquidLeg('xyz:CL', wti.markPx, wti, receivedAt), fundingError: '' }, 'hyperliquid', 'oil');
}
/**
 * Hynix on Hyperliquid xyz: the collector's allMids quote (hynix-market.mjs) with the funding of a metaAndAssetCtxs reply;
 * `contexts` null (not read, failed, or the quote is a snapshot) leaves the funding empty.
 */
export function hyperliquidHynixQuote(quote, contexts, stale = false) {
  const funding = contexts ? { adr: contexts.contexts[0], ordinary: contexts.contexts[1], at: contexts.receivedAt } : null;
  const at = Date.parse(quote.fetchedAt);
  return validateExchangeQuote({ exchange: 'hyperliquid', monitorId: 'hynix', currency: 'USD', priceBasis: 'mid', fundingPriceBasis: 'oracle', fetchedAt: quote.fetchedAt, fundingFetchedAt: funding ? new Date(funding.at).toISOString() : null, status: stale ? 'snapshot' : 'live', left: hyperliquidLeg('xyz:SKHY', quote.adr, funding?.adr, at), right: hyperliquidLeg('xyz:SKHX', quote.ordinary, funding?.ordinary, at), fundingError: funding ? '' : '资金费暂不可用' }, 'hyperliquid', 'hynix');
}

// ---- Lighter (lib/oil-dex.ts) ----
export const LIGHTER_ORIGIN = 'https://mainnet.zklighter.elliot.ai';
export const LIGHTER_SOCKET = 'wss://mainnet.zklighter.elliot.ai/stream?readonly=true';
const optionalPositive = value => { const parsed = optionalNumber(value); return parsed !== null && parsed > 0 ? parsed : null; };

/** Discover IDs on each metadata refresh: deployments can change IDs. https://apidocs.lighter.xyz/reference/orderbookdetails */
export function parseLighterOilMarkets(input) {
  const response = obj(input);
  if (response.code !== 200) throw new Error('Lighter 原油合约目录读取失败');
  const items = list(response.order_book_details);
  const markets = ['BRENTOIL', 'WTI'].map(symbol => {
    const row = unique(items, 'symbol', symbol), marketId = optionalNumber(row.market_id);
    if (row.market_type !== 'perp' || row.status !== 'active' || optionalNumber(row.multiplier) !== 1 || row.is_frozen === true || marketId === null || !Number.isSafeInteger(marketId) || marketId < 0 || marketId > 32_767) throw new Error(`Lighter ${symbol} 合约暂不可用或规格已变化`);
    return { symbol, marketId };
  });
  if (markets[0].marketId === markets[1].marketId) throw new Error('Lighter 原油合约编号重复');
  return markets;
}

/**
 * current_funding_rate is upcoming hourly funding in percentage points; funding_rate/funding_timestamp describe the last
 * payment and are never fallback. Payment uses index price: https://docs.lighter.xyz/trading/funding
 */
export function parseLighterOilObservation(input, market, now = Date.now()) {
  const message = obj(input), row = obj(message.market_stats);
  if (!['subscribed/market_stats', 'update/market_stats'].includes(String(message.type)) || message.channel !== `market_stats:${market.marketId}` || row.symbol !== market.symbol || row.market_id !== market.marketId) throw new Error('Lighter 原油行情合约不匹配');
  const time = sourceTime(message.timestamp, now), price = optionalPositive(row.mark_price);
  if (price === null) throw new Error(`Lighter ${market.symbol} 标记价格不可用`);
  const fundingPrice = optionalPositive(row.index_price), percentage = optionalNumber(row.current_funding_rate);
  const fundingRate = fundingPrice !== null && percentage !== null && Math.abs(percentage) <= 100 ? percentage / 100 : null;
  return { marketId: market.marketId, sourceTime: time, leg: { symbol: market.symbol, price, fundingPrice, fundingRate, fundingIntervalHours: 1, nextFundingAt: nextHour(time), nextFundingEstimated: true } };
}

export function parseLighterOilQuote(observations, now = Date.now()) {
  const leg = symbol => {
    const matches = observations.filter(row => row.leg.symbol === symbol);
    if (matches.length !== 1) throw new Error(`Lighter ${symbol} 行情缺失或重复`);
    sourceTime(matches[0].sourceTime, now);
    return matches[0];
  };
  const brent = leg('BRENTOIL'), wti = leg('WTI');
  if (Math.abs(brent.sourceTime - wti.sourceTime) > 15_000) throw new Error('Lighter 原油双腿行情不同步');
  const fetchedAt = new Date(Math.min(brent.sourceTime, wti.sourceTime)).toISOString();
  // Across an hour boundary the two estimates can refer to different payments.
  const complete = [brent, wti].every(row => row.leg.fundingRate !== null) && brent.leg.nextFundingAt === wti.leg.nextFundingAt;
  return validateExchangeQuote({
    exchange: 'lighter', monitorId: 'oil', currency: 'USDC', priceBasis: 'mark', fundingPriceBasis: 'index', timestampBasis: 'source', fetchedAt,
    fundingFetchedAt: complete ? fetchedAt : null, status: 'live',
    left: { ...brent.leg, fundingRate: complete ? brent.leg.fundingRate : null },
    right: { ...wti.leg, fundingRate: complete ? wti.leg.fundingRate : null },
    fundingError: complete ? '' : '当前资金费率或指数价格暂不可用，价格仍正常更新。',
  }, 'lighter', 'oil');
}

/** A bounded, unauthenticated snapshot subscription; no trading/account channels. */
export function readLighterOilSnapshot(markets, { clock = Date.now, WebSocketImpl = globalThis.WebSocket, timeoutMs = 9_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Lighter 行情读取已停止')); return; }
    if (typeof WebSocketImpl !== 'function') { reject(new Error('Lighter 行情连接暂不可用')); return; }
    let socket;
    try { socket = new WebSocketImpl(LIGHTER_SOCKET); }
    catch { reject(new Error('Lighter 行情连接失败')); return; }
    let settled = false;
    const observations = new Map();
    const stop = () => finish(new Error('Lighter 行情读取已停止'));
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      socket.onopen = null; socket.onmessage = null; socket.onerror = null; socket.onclose = null;
      try { socket.close(); } catch { /* A failed connection may already be closed. */ }
    };
    function finish(error, quote) {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve(quote);
    }
    const timer = setTimeout(() => finish(new Error('Lighter 原油双腿行情读取超时')), Math.min(10_000, Math.max(1, timeoutMs)));
    signal?.addEventListener('abort', stop, { once: true });
    socket.onopen = () => {
      try { for (const market of markets) socket.send(JSON.stringify({ type: 'subscribe', channel: `market_stats/${market.marketId}` })); }
      catch { finish(new Error('Lighter 行情订阅失败')); }
    };
    socket.onerror = () => finish(new Error('Lighter 行情连接失败'));
    socket.onclose = () => finish(new Error('Lighter 行情连接已关闭，双腿快照不完整'));
    socket.onmessage = event => {
      if (settled) return;
      try {
        const message = obj(JSON.parse(String(event.data)));
        if (message.type === 'ping') { socket.send(JSON.stringify({ type: 'pong' })); return; }
        if (message.type === 'error' || message.error !== undefined) throw new Error('Lighter 行情订阅被拒绝');
        const market = markets.find(row => message.channel === `market_stats:${row.marketId}`);
        if (!market) return;
        observations.set(market.marketId, parseLighterOilObservation(message, market, clock()));
        if (observations.size === 2) finish(undefined, parseLighterOilQuote([...observations.values()], clock()));
      } catch (error) { finish(error instanceof Error ? error : new Error('Lighter 原油行情响应无效')); }
    };
  });
}
