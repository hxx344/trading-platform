// 复制自 project-aggregation 工作台 modules/monitor：lib/exchange-funding-history.ts（提交 1fdb6e8）的常量、结算记录整理与
// 快照校验，lib/exchange-funding-analysis.ts（8470785）的区间统计，lib/exchange-funding-cex.ts（ee3942c）的 Binance / Bybit /
// OKX / Bitget 分页读取与解析，lib/exchange-funding-service.ts（1fdb6e8）的 Hyperliquid / Gate / Lighter 解析与分页、两腿合并。
// 只放数据规则，服务端读取器（src/monitor/exchanges.ts）与页面共用。与原文件不同的地方：
// - 不带 Variational（本服务不接入，页面不给它入口），于是去掉 availability 字段与「不支持」分支；交易所清单沿用
//   exchange-comparison.mjs 的 COMPARISON_EXCHANGES，合约取 exchangeDefinition；
// - 不带 Aster、Bitget USDC 合约、调用方自带合约目录与 onProgress（工作台其它页面才用）；
// - 页面统一用 UTC：区间输入框按 UTC 解析与显示（工作台按北京时间）；
// - Lighter 合约目录由调用方传入（读取器复用 M-2c 已缓存的目录），请求函数与时钟都由调用方注入；
// - 两腿合并抽成 mergeFundingHistory（工作台写在读取器闭包里），不再接收 monitorId 默认值。
import { COMPARISON_EXCHANGES, exchangeDefinition, supportsExchange } from './exchange-comparison.mjs';

export const HISTORY_REFRESH_MS = 300_000;
export const HISTORY_STALE_MS = HISTORY_REFRESH_MS * 2 + 15_000;
export const HISTORY_WINDOW_MS = 60 * 24 * 3_600_000;
export const HISTORY_PAGE_SIZE = 200;
// A guard against malformed responses, never a display or aggregation limit.
export const HISTORY_LEG_LIMIT = 2_000;
const EARLIEST = Date.UTC(2020, 0, 1);

export const fundingHistoryExchanges = market => COMPARISON_EXCHANGES[market];
export const supportsFundingHistory = (market, exchange) => supportsExchange(market, exchange);

/** Preserve the original settlement timestamps; asynchronous legs are never paired by a time bucket. */
export function normalizeSettledFunding(records, now) {
  const unique = new Map();
  for (const { time, rate } of records) {
    if (!Number.isSafeInteger(time) || time < EARLIEST || typeof rate !== 'number' || !Number.isFinite(rate) || Math.abs(rate) > 1) throw new Error('Invalid settled funding record');
    if (time > now || time < now - HISTORY_WINDOW_MS) continue;
    if (unique.has(time) && unique.get(time) !== rate) throw new Error('Conflicting settled funding records');
    unique.set(time, rate);
  }
  if (unique.size > HISTORY_LEG_LIMIT) throw new Error('Too many settled funding records');
  return [...unique].sort(([a], [b]) => b - a).map(([time, rate]) => ({ time, rate }));
}

export function validateExchangeFundingHistory(input, exchange, monitorId) {
  const value = input;
  if (!supportsFundingHistory(monitorId, exchange)) throw new Error('Unsupported exchange funding history');
  const definition = exchangeDefinition(exchange, monitorId);
  const stamp = time => typeof time === 'string' && Number.isFinite(Date.parse(time));
  if (!value || value.exchange !== exchange || value.monitorId !== monitorId || value.currency !== definition.currency || !stamp(value.fetchedAt) || !['live', 'snapshot'].includes(value.status) || typeof value.reason !== 'string' || !Array.isArray(value.rows) || value.rows.length > HISTORY_LEG_LIMIT * 2) throw new Error('Invalid exchange funding history');
  const now = Date.parse(value.fetchedAt);
  for (const [side, symbol] of [['left', definition.left], ['right', definition.right]]) {
    const leg = value[side];
    if (!leg || leg.symbol !== symbol || typeof leg.error !== 'string' || (leg.fetchedAt !== null && (!stamp(leg.fetchedAt) || Date.parse(leg.fetchedAt) > now))) throw new Error('Invalid history leg metadata');
    const coverage = leg.coverage;
    if (coverage != null && (!Number.isSafeInteger(coverage.from) || !Number.isSafeInteger(coverage.to) || coverage.from < EARLIEST || coverage.from > coverage.to || leg.fetchedAt === null || coverage.to > Date.parse(leg.fetchedAt))) throw new Error('Invalid funding query coverage');
  }
  const seen = new Set(), counts = { left: 0, right: 0 };
  for (const row of value.rows) {
    if (!row || !Number.isSafeInteger(row.time) || row.time < now - HISTORY_WINDOW_MS || row.time > now || seen.has(row.time) || (row.leftRate === null && row.rightRate === null)) throw new Error('Invalid history settlement time');
    seen.add(row.time);
    for (const side of ['left', 'right']) {
      const rate = row[`${side}Rate`];
      if (rate === null) continue;
      if (typeof rate !== 'number' || !Number.isFinite(rate) || Math.abs(rate) > 1 || value[side].fetchedAt === null || row.time > Date.parse(value[side].fetchedAt) || ++counts[side] > HISTORY_LEG_LIMIT) throw new Error('Invalid settled funding rate');
      const coverage = value[side].coverage;
      if (coverage != null && (row.time < coverage.from || row.time > coverage.to)) throw new Error('Settlement outside funding query coverage');
    }
  }
  const leg = side => ({ symbol: value[side].symbol, fetchedAt: value[side].fetchedAt, error: value[side].error, coverage: value[side].coverage == null ? null : { from: value[side].coverage.from, to: value[side].coverage.to } });
  return { exchange, monitorId, currency: definition.currency, fetchedAt: value.fetchedAt, status: value.status, reason: value.reason,
    left: leg('left'), right: leg('right'), rows: value.rows.map(row => ({ time: row.time, leftRate: row.leftRate, rightRate: row.rightRate })).sort((a, b) => b.time - a.time) };
}

/** datetime-local values are UTC on this page, regardless of the browser's timezone. */
export function fundingRangeInput(time) {
  return new Date(time).toISOString().slice(0, 16);
}
export function parseFundingRangeInput(input) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(input)) return null;
  const time = Date.parse(`${input}:00Z`);
  return Number.isFinite(time) && fundingRangeInput(time) === input ? time : null;
}

/** Simple sums of all actual settlements in [from,to), not compounding or annualization.
 * Each leg retains its own notional denominator. Historical prices are unavailable,
 * so these sums must not be presented as the equal-barrel spread's historical P&L.
 */
export function analyzeFundingRange(history, range, direction) {
  if (!Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to) || range.from >= range.to || range.to - range.from > HISTORY_WINDOW_MS || !['short', 'long'].includes(direction)) throw new Error('请选择有效的起止时间，区间不能超过 60 天。');
  const leg = side => {
    const metadata = history[side];
    const records = history.rows.flatMap(row => {
      const rate = row[`${side}Rate`];
      return rate !== null && row.time >= range.from && row.time < range.to ? [{ time: row.time, rate }] : [];
    }).sort((a, b) => b.time - a.time);
    // Compensated summation avoids accumulated rounding error over many tiny rates.
    let sum = 0, compensation = 0;
    for (const { rate } of records) {
      const adjusted = rate - compensation, next = sum + adjusted;
      compensation = next - sum - adjusted; sum = next;
    }
    const rawRate = records.length ? (sum === 0 ? 0 : sum) : null;
    const short = side === 'left' ? direction === 'short' : direction === 'long';
    const positionRate = rawRate === null ? null : rawRate === 0 ? 0 : short ? rawRate : -rawRate;
    const queried = metadata.coverage;
    return { records, count: records.length, rawRate, positionRate, coverage: !queried ? 'unknown' : range.from >= queried.from && range.to - 1 <= queried.to ? 'queried' : 'partial', fetchedAt: metadata.fetchedAt, error: metadata.error };
  };
  return { left: leg('left'), right: leg('right') };
}

// ---- Parsers -----------------------------------------------------------------------------------------------------------

const CEX_PAGE_SIZES = { binance: 1000, bybit: 200, okx: 400, bitget: 100 };
const CEX_MAX_PAGES = 32;
const CEX_SYMBOLS = {
  binance: ['BZUSDT', 'CLUSDT', 'SKHYUSDT', 'SKHYNIXUSDT'],
  bybit: ['BZUSDT', 'CLUSDT', 'SKHYUSDT', 'SKHYNIXUSDT'],
  okx: ['BZ-USDT-SWAP', 'CL-USDT-SWAP', 'SKHY-USDT-SWAP', 'SKHYNIX-USDT-SWAP'],
  bitget: ['BZUSDT', 'CLUSDT', 'SKHYUSDT', 'SKHYNIXUSDT'],
};
const HYPERLIQUID_SYMBOLS = ['xyz:BRENTOIL', 'xyz:CL', 'xyz:SKHY', 'xyz:SKHX'];

function validateCexContract(exchange, symbol) {
  if (!Object.hasOwn(CEX_PAGE_SIZES, exchange) || !CEX_SYMBOLS[exchange].includes(symbol)) throw new Error('Unsupported CEX oil funding contract');
}
function cexObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid CEX funding response');
  return value;
}
function cexNumber(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))) throw new Error('Invalid CEX funding number');
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error('Invalid CEX funding number');
  return result;
}
function cexTimestamp(value) {
  const time = cexNumber(value);
  // These APIs use Unix milliseconds. A seconds timestamp must not become a
  // plausible-looking 1970 settlement, and sub-millisecond data is invalid.
  if (!Number.isSafeInteger(time) || time < 1_000_000_000_000) throw new Error('Invalid CEX funding timestamp');
  return time;
}
function cexRows(exchange, input) {
  if (exchange === 'binance') {
    if (!Array.isArray(input)) throw new Error('Binance funding history response failed');
    return input;
  }
  const response = cexObject(input);
  if (exchange === 'bybit') {
    if (response.retCode !== 0) throw new Error('Bybit funding history response failed');
    const result = cexObject(response.result);
    if (result.category !== undefined && result.category !== 'linear') throw new Error('Invalid Bybit funding category');
    if (!Array.isArray(result.list)) throw new Error('Invalid Bybit funding history list');
    return result.list;
  }
  if (response.code !== (exchange === 'okx' ? '0' : '00000') || !Array.isArray(response.data)) throw new Error('CEX funding history response failed');
  return response.data;
}

/** Rates are decimal amounts for the actual settlement, never hourly forecasts. */
export function parseCexFundingHistory(exchange, symbol, input, now = Date.now()) {
  validateCexContract(exchange, symbol);
  return parseCexPage(exchange, symbol, input, now);
}
function parseCexPage(exchange, symbol, input, now) {
  cexTimestamp(now);
  const records = new Map();
  for (const value of cexRows(exchange, input)) {
    const row = cexObject(value), identity = exchange === 'okx' ? row.instId : row.symbol;
    if (identity !== undefined && identity !== symbol) throw new Error('CEX funding contract mismatch');
    // Special is a real one-off settlement, e.g. Binance equity-perpetual dividend funding at the ex-date.
    if (exchange === 'binance' && row.rateType !== undefined && row.rateType !== 'Regular' && row.rateType !== 'Special') throw new Error('Unsupported funding rate type');
    if (exchange === 'okx' && row.instType !== undefined && row.instType !== 'SWAP') throw new Error('Invalid OKX funding instrument');
    const time = cexTimestamp(exchange === 'bybit' ? row.fundingRateTimestamp : row.fundingTime);
    // OKX calls fundingRate predicted and realizedRate actual. A historical
    // next_period method still has an actual realizedRate; no forecast fallback.
    const rate = cexNumber(exchange === 'okx' ? row.realizedRate : row.fundingRate);
    if (Math.abs(rate) > 1) throw new Error('Invalid CEX funding rate');
    if (time > now) continue;
    if (records.has(time) && records.get(time) !== rate) throw new Error('Conflicting CEX funding settlements');
    records.set(time, rate);
  }
  return [...records].sort(([a], [b]) => a - b).map(([time, rate]) => ({ time, rate }));
}

const object = input => { if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Invalid funding response'); return input; };
const list = input => { if (!Array.isArray(input)) throw Error('Invalid funding history'); return input.map(object); };
const number = input => { if ((typeof input !== 'number' && typeof input !== 'string') || String(input).trim() === '' || !Number.isFinite(Number(input))) throw Error('Invalid funding number'); return Number(input); };

/** https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint#retrieve-historical-funding-rates */
export function parseHyperliquidFundingHistory(input, symbol, now) {
  if (!HYPERLIQUID_SYMBOLS.includes(symbol)) throw Error('Unknown Hyperliquid comparison contract');
  return normalizeSettledFunding(list(input).map(row => {
    if (row.coin !== symbol) throw Error('Funding contract mismatch');
    return { time: number(row.time), rate: number(row.fundingRate) };
  }), now);
}

/** REST rate is the magnitude in percentage points, with payer in direction.
 * Cross-checked against market_stats.funding_rate (last actual paid), never current_funding_rate.
 * https://apidocs.lighter.xyz/reference/fundings
 * https://apidocs.lighter.xyz/docs/websocket-reference#market-stats
 */
export function parseLighterFundingHistory(input, marketId, now) {
  const value = object(input);
  if (value.code !== 200 || (value.market_id !== undefined && number(value.market_id) !== marketId)) throw Error('Lighter funding response failed');
  return normalizeSettledFunding(list(value.fundings).map(row => {
    const magnitude = number(row.rate), seconds = number(row.timestamp);
    if (magnitude < 0 || magnitude > 100 || !Number.isSafeInteger(seconds) || seconds < 1_000_000_000 || seconds >= 100_000_000_000 || !['long', 'short'].includes(String(row.direction)) || (row.market_id !== undefined && number(row.market_id) !== marketId)) throw Error('Invalid Lighter funding settlement');
    return { time: seconds * 1000, rate: magnitude === 0 ? 0 : magnitude / 100 * (row.direction === 'short' ? -1 : 1) };
  }), now);
}

/** Gate reports settlement times in Unix seconds and rates as decimal strings.
 * https://www.gate.com/docs/developers/apiv4/en/futures/#futures-market-historical-funding-rate
 */
export function parseGateFundingHistory(input, now) {
  return normalizeSettledFunding(list(input).map(row => {
    const seconds = number(row.t);
    if (!Number.isSafeInteger(seconds) || seconds < 1_000_000_000 || seconds >= 100_000_000_000) throw Error('Invalid Gate funding settlement');
    return { time: seconds * 1000, rate: number(row.r) };
  }), now);
}

// ---- Readers -----------------------------------------------------------------------------------------------------------

/**
 * One leg's complete settlements in `range`; throws when any page fails, is malformed, does not advance or the page limit is
 * reached, so an incomplete read never claims coverage. `request` owns HTTP checks, timeouts and cooldowns.
 */
export function createFundingLegReader({ request, clock = Date.now, lighterMarkets }) {
  async function readCex(exchange, symbol, range) {
    validateCexContract(exchange, symbol);
    const now = cexTimestamp(clock());
    const from = cexTimestamp(range.from), to = cexTimestamp(range.to);
    if (from > to || to > now) throw new Error('Invalid CEX funding history range');
    const pageSize = CEX_PAGE_SIZES[exchange], records = new Map();
    const forward = exchange === 'binance';
    let cursor = forward ? from : exchange === 'okx' ? to + 1 : to;
    let previousOldest = Infinity;
    for (let page = 1; page <= CEX_MAX_PAGES; page++) {
      let url;
      if (forward) {
        // Binance returns the earliest results from an inclusive startTime.
        url = new URL('https://fapi.binance.com/fapi/v1/fundingRate');
        url.search = new URLSearchParams({ symbol, limit: String(pageSize), startTime: String(cursor), endTime: String(to) }).toString();
      } else if (exchange === 'bybit') {
        url = new URL('https://api.bybit.com/v5/market/funding/history');
        url.search = new URLSearchParams({ category: 'linear', symbol, limit: String(pageSize), endTime: String(cursor) }).toString();
      } else if (exchange === 'okx') {
        // OKX after means strictly earlier; to + 1 includes a settlement at to.
        url = new URL('https://www.okx.com/api/v5/public/funding-rate-history');
        url.search = new URLSearchParams({ instId: symbol, limit: String(pageSize), after: String(cursor) }).toString();
      } else {
        // Bitget has no time cursor. Deduplication also handles page offsets
        // shifting when a new settlement appears during this read.
        url = new URL('https://api.bitget.com/api/v2/mix/market/history-fund-rate');
        url.search = new URLSearchParams({ symbol, productType: 'USDT-FUTURES', pageSize: String(pageSize), pageNo: String(page) }).toString();
      }
      const response = await request(url.toString()), rawCount = cexRows(exchange, response).length;
      if (!rawCount) break;
      if (rawCount > pageSize) throw new Error('Invalid CEX funding history page size');
      const settlements = parseCexPage(exchange, symbol, response, now);
      if (!settlements.length) throw new Error('CEX funding history pagination did not advance');
      const oldest = settlements[0].time, newest = settlements[settlements.length - 1].time;
      if (exchange !== 'bitget' && newest > to) throw new Error('Invalid CEX funding history page range');
      for (const { time, rate } of settlements) {
        if (records.has(time) && records.get(time) !== rate) throw new Error('Conflicting CEX funding settlements');
        records.set(time, rate);
      }
      if (forward ? newest < cursor : oldest >= previousOldest || (exchange === 'bybit' && oldest > cursor) || (exchange === 'okx' && oldest >= cursor)) {
        throw new Error('CEX funding history pagination did not advance');
      }
      if (rawCount < pageSize || (forward ? newest >= to : oldest <= from)) break;
      if (page === CEX_MAX_PAGES) throw new Error('CEX funding history pagination exceeded page limit');
      previousOldest = oldest;
      cursor = forward ? newest + 1 : exchange === 'okx' ? oldest : oldest - 1;
    }
    return [...records].filter(([time]) => time >= from && time <= to).sort(([a], [b]) => a - b).map(([time, rate]) => ({ time, rate }));
  }

  return async function readLeg(exchange, symbol, range) {
    if (exchange === 'hyperliquid') {
      const records = [];
      let cursor = range.from;
      // Time-range info responses contain at most 500 records. Keep exact ms.
      // https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint#pagination
      for (let page = 0; page < 10; page++) {
        const input = await request('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'fundingHistory', coin: symbol, startTime: cursor, endTime: range.to }) });
        const parsed = parseHyperliquidFundingHistory(input, symbol, range.to);
        if (!Array.isArray(input)) throw Error('Invalid Hyperliquid funding page');
        if (parsed.some(row => row.time < cursor)) throw Error('Hyperliquid funding pagination did not advance');
        records.push(...parsed);
        if (input.length < 500) return normalizeSettledFunding(records, range.to);
        if (!parsed.length) throw Error('Hyperliquid funding pagination did not advance');
        const next = Math.max(...parsed.map(row => row.time)) + 1;
        if (next <= cursor) throw Error('Hyperliquid funding pagination did not advance');
        if (next > range.to) return normalizeSettledFunding(records, range.to);
        cursor = next;
      }
      throw Error('Hyperliquid funding pagination limit exceeded');
    }
    if (exchange === 'gate') {
      const records = new Map();
      // `to` is exclusive in seconds; walk backwards from just past the range end.
      let cursor = Math.floor(range.to / 1000) + 1;
      for (let page = 0; page < 32; page++) {
        const query = new URLSearchParams({ contract: symbol, limit: '100', from: String(Math.floor(range.from / 1000)), to: String(cursor) });
        const input = await request(`https://api.gateio.ws/api/v4/futures/usdt/funding_rate?${query}`);
        if (!Array.isArray(input) || input.length > 100) throw Error('Invalid Gate funding page');
        const parsed = parseGateFundingHistory(input, range.to), times = list(input).map(row => number(row.t) * 1000);
        if (!times.length) break;
        if (times.some(time => time >= cursor * 1000)) throw Error('Gate funding page outside requested range');
        for (const { time, rate } of parsed) {
          if (records.has(time) && records.get(time) !== rate) throw Error('Conflicting Gate funding settlements');
          records.set(time, rate);
        }
        const oldest = Math.min(...times);
        if (input.length < 100 || oldest <= range.from) break;
        if (oldest / 1000 >= cursor) throw Error('Gate funding pagination did not advance');
        if (page === 31) throw Error('Gate funding pagination limit exceeded');
        cursor = oldest / 1000;
      }
      return normalizeSettledFunding([...records].filter(([time]) => time >= range.from).map(([time, rate]) => ({ time, rate })), range.to);
    }
    if (exchange === 'lighter') {
      const market = (await lighterMarkets()).find(item => item.symbol === symbol);
      if (!market) throw Error('Lighter oil contract unavailable');
      const records = [];
      // 25-day hourly windows stay below the documented 750-record response cap.
      for (let from = range.from; from <= range.to;) {
        const to = Math.min(range.to, from + 25 * 86_400_000);
        // fundings applies candle-style start boundaries: a fractional-hour start
        // skips the next settlement. Request from the preceding whole hour, then
        // filter exact bounds locally so neither the first row nor a seam is lost.
        const requestStart = Math.floor(from / 3_600_000) * 3600 - 3600;
        const query = new URLSearchParams({ market_id: String(market.marketId), resolution: '1h', start_timestamp: String(requestStart), end_timestamp: String(Math.floor(to / 1000)), count_back: '0' });
        const input = await request(`https://mainnet.zklighter.elliot.ai/api/v1/fundings?${query}`);
        const parsed = parseLighterFundingHistory(input, market.marketId, range.to);
        if (list(object(input).fundings).length >= 750 || parsed.some(row => row.time > to)) throw Error('Incomplete Lighter funding time window');
        records.push(...parsed.filter(row => row.time >= from && row.time <= to));
        from = to + 1;
      }
      return normalizeSettledFunding(records, range.to);
    }
    if (Object.hasOwn(CEX_PAGE_SIZES, exchange)) return readCex(exchange, symbol, range);
    throw Error('Unsupported funding history exchange');
  };
}

/**
 * The next snapshot of one exchange's two legs: each leg reads from a day before its previous coverage end (the whole
 * 60-day window when there is none), keeps its old records and receipt time when its read fails, and the snapshot rejects
 * only when both legs fail.
 */
export async function mergeFundingHistory({ exchange, monitorId, previous, readLeg, clock = Date.now }) {
  const definition = exchangeDefinition(exchange, monitorId);
  const startedAt = clock();
  const old = previous ? validateExchangeFundingHistory(previous, exchange, monitorId) : null;
  const coverage = { from: startedAt - HISTORY_WINDOW_MS, to: startedAt };
  const ranges = ['left', 'right'].map(side => {
    const previousCoverage = old?.[side].coverage;
    // New snapshots backfill the whole window; later updates overlap a day.
    const from = previousCoverage && previousCoverage.from <= coverage.from && previousCoverage.to >= coverage.from ? Math.max(coverage.from, previousCoverage.to - 86_400_000) : coverage.from;
    return { from, to: coverage.to };
  });
  const results = await Promise.allSettled([readLeg(exchange, definition.left, ranges[0]), readLeg(exchange, definition.right, ranges[1])]);
  if (results.every(result => result.status === 'rejected')) throw Error('Actual funding history unavailable');
  // The snapshot is anchored to the requested end, excluding settlements that
  // happened during pagination and keeping a stable 60-day window for all pages.
  const fetchedAt = new Date(startedAt).toISOString(), rows = new Map();
  const legs = ['left', 'right'].map((side, index) => {
    const result = results[index], symbol = definition[side];
    const previousRecords = (old?.rows ?? []).filter(row => row[`${side}Rate`] !== null).map(row => ({ time: row.time, rate: row[`${side}Rate`] }));
    const merged = new Map(previousRecords.map(row => [row.time, row]));
    if (result.status === 'fulfilled') for (const row of result.value) merged.set(row.time, row);
    const records = normalizeSettledFunding([...merged.values()], startedAt);
    for (const record of records) {
      const row = rows.get(record.time) ?? { time: record.time, leftRate: null, rightRate: null };
      row[`${side}Rate`] = record.rate; rows.set(record.time, row);
    }
    const previousCoverage = old?.[side].coverage;
    // Expired rows were pruned above, so their former coverage cannot be claimed.
    const retainedCoverage = previousCoverage && previousCoverage.to >= coverage.from ? { from: Math.max(previousCoverage.from, coverage.from), to: previousCoverage.to } : null;
    return { symbol, fetchedAt: result.status === 'fulfilled' ? fetchedAt : old?.[side].fetchedAt ?? null, error: result.status === 'fulfilled' ? '' : '本合约历史结算费率暂时读取失败，保留上次成功记录。', coverage: result.status === 'fulfilled' ? coverage : retainedCoverage };
  });
  return validateExchangeFundingHistory({ exchange, monitorId, currency: definition.currency, fetchedAt, status: 'live', reason: legs.some(leg => leg.error) ? '部分合约更新失败，请查看各合约采集时间。' : '', left: legs[0], right: legs[1], rows: [...rows.values()] }, exchange, monitorId);
}
