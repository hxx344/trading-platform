// 复制自 project-aggregation 工作台 modules/monitor/modules/oil/ 下三个文件，按顺序拼接：binance.mjs（提交 8470785，
// 去掉 marketFromExchangeQuote 与 fetchDailySnapshot：工作台交易所对比的接口形状与日线任务，本服务不用）、
// spread.mjs（568a20d，原样）、intraday.mjs（89f26e5，去掉开头两行对前两个文件的 import）；其余内容未改。

// ---- binance.mjs ----
export const API_URL = 'https://fapi.binance.com';
export const SOURCE = 'Binance';
export const DAY = 86_400_000;
export const HISTORY_START = Date.UTC(2026, 3, 1, 9);
export const ASSETS = Object.freeze({
  brent: { coin: 'BZUSDT', label: '布伦特', page: 'https://www.binance.com/en/futures/BZUSDT' },
  wti: { coin: 'CLUSDT', label: 'WTI', page: 'https://www.binance.com/en/futures/CLUSDT' },
});

export function numeric(value, positive = false) {
  if (!['string', 'number'].includes(typeof value) || String(value).trim() === '' || !Number.isFinite(Number(value)) || (positive && Number(value) <= 0)) throw Error('Invalid Binance number');
  return Number(value);
}

export async function requestBinance(path, params = {}, { fetcher = fetch, timeout = 15_000 } = {}) {
  const url = new URL(path, API_URL);
  url.search = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)])).toString();
  const response = await fetcher(url.href, { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw Error(`Binance HTTP ${response.status}`);
  return response.json();
}

export function validateMarket(input) {
  if (input?.source !== SOURCE || input.currency !== 'USDT' || !Number.isFinite(Date.parse(input.fetchedAt))) throw Error('Expected Binance oil quote');
  const leg = key => {
    const item = input[key];
    if (item?.coin !== ASSETS[key].coin) throw Error('Unexpected Binance oil contract');
    const rate = item.fundingRate === null ? null : numeric(item.fundingRate);
    const hours = item.fundingIntervalHours === null ? null : numeric(item.fundingIntervalHours, true);
    if ((rate !== null && Math.abs(rate) > 1) || (hours !== null && (!Number.isInteger(hours) || hours > 24))) throw Error('Invalid Binance funding terms');
    if (item.nextFundingAt !== null && !Number.isFinite(Date.parse(item.nextFundingAt))) throw Error('Invalid Binance settlement time');
    if (rate !== null && (hours === null || item.nextFundingAt === null)) throw Error('Incomplete Binance funding terms');
    return { coin: item.coin, markPx: numeric(item.markPx, true), fundingRate: rate, fundingIntervalHours: hours, nextFundingAt: item.nextFundingAt };
  };
  return { source: SOURCE, currency: 'USDT', fetchedAt: input.fetchedAt, brent: leg('brent'), wti: leg('wti') };
}

/** Positive = short Brent receives minus long WTI pays, over both legs' mark notionals. */
export function calculateShortSpreadFunding(market, basis = 'quantity') {
  if (!['quantity', 'notional'].includes(basis)) throw Error('Invalid funding basis');
  const validated = validateMarket(market);
  const brentNotional = basis === 'quantity' ? validated.brent.markPx : 1;
  const wtiNotional = basis === 'quantity' ? validated.wti.markPx : 1;
  const grossNotional = brentNotional + wtiNotional;
  const brentRate = validated.brent.fundingRate === null ? null : validated.brent.fundingRate / validated.brent.fundingIntervalHours;
  const wtiRate = validated.wti.fundingRate === null ? null : validated.wti.fundingRate / validated.wti.fundingIntervalHours;
  const brentCashflow = brentRate === null ? null : brentNotional * brentRate;
  const wtiCashflow = wtiRate === null ? null : -wtiNotional * wtiRate;
  const hourlyCashflow = brentCashflow === null || wtiCashflow === null ? null : brentCashflow + wtiCashflow;
  const hourlyRate = hourlyCashflow === null ? null : hourlyCashflow / grossNotional;
  return { basis, brentNotional, wtiNotional, grossNotional, brentRate, wtiRate, brentCashflow, wtiCashflow, hourlyCashflow, hourlyRate, annualizedRate: hourlyRate === null ? null : hourlyRate * 8760, cashflowPer10k: hourlyRate === null ? null : hourlyRate * 10_000 };
}

/** Bounded ascending pages. Never silently publish a truncated history. */
export async function fetchCandles(symbol, interval, startTime, endTime, options = {}) {
  if (!Object.values(ASSETS).some(asset => asset.coin === symbol) || !['15m', '1d'].includes(interval)) throw Error('Unsupported Binance oil candles');
  const step = interval === '15m' ? 900_000 : DAY, limit = options.pageSize ?? 1500;
  let cursor = startTime;
  const result = [];
  for (let page = 0; page < 500 && cursor <= endTime; page++) {
    const rows = await requestBinance('/fapi/v1/klines', { symbol, interval, startTime: cursor, endTime, limit }, options);
    if (!Array.isArray(rows)) throw Error('Invalid Binance candle page');
    if (!rows.length) return result;
    let previous = cursor - 1;
    for (const row of rows) {
      if (!Array.isArray(row) || !Number.isSafeInteger(row[0]) || row[0] <= previous || row[0] < cursor || row[0] > endTime || row[0] % step || row[6] !== row[0] + step - 1) throw Error('Invalid Binance candle pagination');
      numeric(row[4], true); previous = row[0]; result.push(row);
    }
    cursor = previous + step;
    if (rows.length < limit) return result;
  }
  if (cursor <= endTime) throw Error('Binance candle pagination exceeded its limit');
  return result;
}

// ---- spread.mjs ----
/** Brent − WTI in USDT per barrel, subtracted on the decimal quotes; null means the pair is unavailable. */
export function oilSpread(brent, wti) {
  if (![brent, wti].every(value => typeof value === 'number' && Number.isFinite(value) && value > 0)) return null;
  const value = decimalDifference(brent, wti);
  return Number.isFinite(value) ? value : null;
}

// Powers of ten up to 1e22 are exact doubles.
const POWERS_OF_TEN = Array.from({ length: 23 }, (_, exponent) => Number(`1e${exponent}`));

export function decimalDifference(left, right) {
  const parts = value => {
    const [mantissa, exponent = '0'] = String(value).split('e');
    const [whole, fraction = ''] = mantissa.split('.');
    return { digits: whole + fraction, scale: fraction.length - Number(exponent) };
  };
  const a = parts(left), b = parts(right), scale = Math.max(0, a.scale, b.scale);
  const shiftA = scale - a.scale, shiftB = scale - b.scale;
  if (scale < POWERS_OF_TEN.length && shiftA < POWERS_OF_TEN.length && shiftB < POWERS_OF_TEN.length) {
    // Safe-integer products and differences are exact, and one IEEE division rounds the
    // exact decimal quotient exactly like Number() parses the BigInt path's decimal string.
    const x = Number(a.digits) * POWERS_OF_TEN[shiftA], y = Number(b.digits) * POWERS_OF_TEN[shiftB], difference = x - y;
    if (Number.isSafeInteger(x) && Number.isSafeInteger(y) && Number.isSafeInteger(difference)) return difference / POWERS_OF_TEN[scale];
  }
  const difference = BigInt(a.digits) * 10n ** BigInt(shiftA) - BigInt(b.digits) * 10n ** BigInt(shiftB);
  const digits = (difference < 0n ? -difference : difference).toString().padStart(scale + 1, '0');
  return Number((difference < 0n ? '-' : '') + (scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits));
}

// ---- intraday.mjs ----
export const OIL_CANDLE_INTERVAL = '15m';
export const OIL_CANDLE_MS = 900_000;
export const OIL_CANDLE_ACTION = 'candles/15m';
export const OIL_CANDLE_REFRESH_MS = 60_000;
const price = value => {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '' || !Number.isFinite(Number(value)) || Number(value) <= 0) throw Error('Invalid oil candle close');
  return Number(value);
};

/** Each spread observation pairs the two completed trade-candle closes at the same UTC start. */
export function pairIntradayCandles(brent, wti, now = Date.now()) {
  const collect = rows => {
    if (!Array.isArray(rows)) throw Error('Invalid oil candle response');
    const result = new Map();
    for (const row of rows) {
      if (!Array.isArray(row) || !Number.isSafeInteger(row[0]) || row[0] < HISTORY_START || row[0] % OIL_CANDLE_MS || row[6] !== row[0] + OIL_CANDLE_MS - 1) throw Error('Unexpected oil candle');
      if (row[6] >= now) continue;
      if (result.has(row[0])) throw Error('Duplicate oil candle');
      result.set(row[0], price(row[4]));
    }
    return result;
  };
  const left = collect(brent), right = collect(wti);
  if (!left.size || !right.size) throw Error('No completed oil candles');
  return [...new Set([...left.keys(), ...right.keys()])].sort((a, b) => a - b).map(time => ({ time, brent: left.get(time) ?? null, wti: right.get(time) ?? null }));
}

/** @param {'live' | 'snapshot'} status */
export function createIntradaySnapshot(rows, fetchedAt, status = 'live') {
  const received = Date.parse(fetchedAt);
  if (!Number.isFinite(received) || !['live', 'snapshot'].includes(status) || !Array.isArray(rows) || !rows.length) throw Error('Invalid oil intraday snapshot');
  let previous = -1;
  const data = rows.map(row => {
    if (!Number.isSafeInteger(row.time) || row.time < HISTORY_START || row.time % OIL_CANDLE_MS || row.time + OIL_CANDLE_MS > received || row.time <= previous) throw Error('Invalid oil candle timestamp');
    previous = row.time;
    const brent = row.brent === null ? null : price(row.brent), wti = row.wti === null ? null : price(row.wti);
    if (brent === null && wti === null) throw Error('Empty oil candle');
    return { time: row.time, brent, wti };
  });
  const paired = data.filter(row => row.brent !== null && row.wti !== null);
  if (!paired.length) throw Error('No paired 15-minute candles');
  const first = paired[0].time, last = paired.at(-1).time, expected = (last - first) / OIL_CANDLE_MS + 1;
  return { status, metadata: { source: SOURCE, api: API_URL, currency: 'USDT', symbols: [ASSETS.brent.coin, ASSETS.wti.coin], interval: OIL_CANDLE_INTERVAL, timezone: 'UTC', priceBasis: 'Paired completed 15-minute trade candle closes', fetchedAt, firstCommonObservation: new Date(first).toISOString(), lastCommonObservation: new Date(last).toISOString(), pairedObservationRows: paired.length, expectedObservationRows: expected, missingObservationRows: expected - paired.length }, data };
}

export function validateIntradaySnapshot(input) {
  if (input?.metadata?.source !== SOURCE || input.metadata.currency !== 'USDT' || JSON.stringify(input.metadata.symbols) !== JSON.stringify([ASSETS.brent.coin, ASSETS.wti.coin]) || input.metadata.interval !== OIL_CANDLE_INTERVAL || input?.metadata?.timezone !== 'UTC' || !['live', 'snapshot'].includes(input?.status)) throw Error('Expected Binance 15-minute UTC candles');
  const snapshot = createIntradaySnapshot(input.data, input.metadata.fetchedAt, input.status);
  for (const field of ['firstCommonObservation', 'lastCommonObservation', 'pairedObservationRows', 'expectedObservationRows', 'missingObservationRows']) if (snapshot.metadata[field] !== input.metadata[field]) throw Error('Oil intraday metadata mismatch');
  return snapshot;
}

const DAY_MS = 86_400_000, MAX_WINDOW_DAYS = 400;

/** `days` query of a windowed candle read; null reads the complete history. */
export function parseCandleWindowDays(value) {
  if (value === null || value === undefined) return null;
  const days = /^\d{1,3}$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(days) || days < 1 || days > MAX_WINDOW_DAYS) throw Object.assign(Error('Invalid candle window'), { status: 400 });
  return days;
}

/**
 * Rows opening within `days` before the last paired bar, as a validated snapshot of their own.
 * `coverage` keeps the complete history's range; a window covering everything returns the snapshot unchanged.
 */
export function intradayWindow(snapshot, days) {
  const { data, metadata } = validateIntradaySnapshot(snapshot);
  const start = Date.parse(metadata.lastCommonObservation) - days * DAY_MS;
  if (data[0].time >= start) return snapshot;
  const window = createIntradaySnapshot(data.filter(row => row.time >= start), metadata.fetchedAt, snapshot.status);
  return { ...snapshot, ...window, windowDays: days, coverage: { firstCommonObservation: metadata.firstCommonObservation, lastCommonObservation: metadata.lastCommonObservation, pairedObservationRows: metadata.pairedObservationRows } };
}

/**
 * Resume from SQLite, overlap recent bars, and repair recoverable older gaps without trimming saved history.
 * @param {ReturnType<typeof createIntradaySnapshot> | null} existing
 */
export async function fetchIntradaySnapshot(existing = null, options = {}) {
  const now = options.now ?? Date.now(), previous = existing ? validateIntradaySnapshot(existing) : null;
  const earliestAvailable = HISTORY_START;
  let missing = Infinity, expected = previous?.data[0]?.time;
  for (const row of previous?.data ?? []) {
    if (row.time > expected && row.time > earliestAvailable) missing = Math.min(missing, Math.max(expected, earliestAvailable));
    if ((row.brent === null || row.wti === null) && row.time >= earliestAvailable) missing = Math.min(missing, row.time);
    expected = row.time + OIL_CANDLE_MS;
  }
  const startTime = Math.max(0, earliestAvailable, previous ? Math.min(previous.data.at(-1).time - 96 * OIL_CANDLE_MS, missing) : earliestAvailable);
  const [brent, wti] = await Promise.all(Object.values(ASSETS).map(asset => fetchCandles(asset.coin, OIL_CANDLE_INTERVAL, startTime, now, options)));
  const merged = new Map((previous?.data ?? []).map(row => [row.time, row]));
  for (const row of pairIntradayCandles(brent, wti, now)) {
    const old = merged.get(row.time);
    merged.set(row.time, { time: row.time, brent: row.brent ?? old?.brent ?? null, wti: row.wti ?? old?.wti ?? null });
  }
  return createIntradaySnapshot([...merged.values()].sort((a, b) => a.time - b.time), new Date(now).toISOString());
}

/** `spread` is Brent − WTI in USDT per barrel; rows missing either leg are not charted. */
function chartRow(row) {
  if (row.brent === null || row.wti === null) return null;
  const spread = oilSpread(row.brent, row.wti);
  return spread === null ? null : { ...row, spread };
}

/**
 * Chart rows of a snapshot that `validateIntradaySnapshot` already returned; skips a second validation.
 * @param {ReturnType<typeof validateIntradaySnapshot>} snapshot
 */
export function validatedIntradayChartRows(snapshot) {
  return snapshot.data.flatMap(row => chartRow(row) ?? []);
}

export function intradayChartRows(snapshot) {
  return validatedIntradayChartRows(validateIntradaySnapshot(snapshot));
}

/** Chart rows opening within `durationMs` before the end of the last charted bar, the window a trend keeps. */
export function recentIntradayChartRows(snapshot, durationMs) {
  const { data } = validateIntradaySnapshot(snapshot), rows = [];
  let start = -Infinity;
  for (let index = data.length - 1; index >= 0 && data[index].time >= start; index--) {
    const row = chartRow(data[index]);
    if (row === null) continue;
    if (!rows.length) start = row.time + OIL_CANDLE_MS - durationMs;
    if (row.time >= start) rows.push(row);
  }
  return rows.reverse();
}
