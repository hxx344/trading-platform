// 复制自 project-aggregation 工作台 modules/monitor：lib/market.ts（提交 8470785）的常量与 alignCandles，lib/quote-service.ts
// （8470785）的 allMids 解析，lib/market-service.ts（8470785）的 1 小时 K 线请求、校验与续读起点，lib/market-validation.ts
// （c534894）的价格换算校验。与原文件不同的地方：
// - K 线只存两腿收盘价（time、adr、ordinary），正股折算价、价差、溢价率在读取时由 hynixPrices 算出；
// - 请求函数接收 fetcher / timeout / 起止时刻（原文件写死 fetch 与 Date.now），工作台随包附带的 archive.json 基线不带，
//   首次从上市首个整点回补，起点不早于接口保留的最近 5000 根；
// - 续读起点多一个 full 开关：工作台每轮都从最早的缺口读起，这里只在 full 时这样做（采集器每小时一次），且只在
//   接口仍保留的最近 5000 根里找缺口；配对时另要求整点已过（t + 1 小时 ≤ now），与读回校验同一口径；
// - allMids 两腿价格须为字符串（接口原样返回字符串）；
// - 资金费（metaAndAssetCtxs）不读，随 M-2d。
const HYPERLIQUID_API_URL = 'https://api.hyperliquid.xyz/info';

export const SOURCE = 'Hyperliquid';
export const HYNIX_LEGS = Object.freeze({ adr: 'xyz:SKHY', ordinary: 'xyz:SKHX' });
export const LISTING_DATE = '2026-07-10';
/** The first full hour after the ADR's first trade; earlier contract trading is left out. */
export const FIRST_FULL_HOUR = Date.parse('2026-07-10T14:00:00Z');
/** One ordinary share = 10 ADRs (Citi ADR ratio). */
export const ADR_PER_SHARE = 10;
export const HYNIX_CANDLE_MS = 3_600_000;
/** Hyperliquid serves only the most recent 5000 candles of an interval. */
export const HYNIX_MAX_CANDLES = 5000;
/** A round reads on from this far before the last stored hour (lib/market-service.ts). */
export const HYNIX_RESUME_MS = 48 * HYNIX_CANDLE_MS;

const object = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid market object');
  return value;
};
const stamp = value => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('Invalid market timestamp');
  return value;
};

/** ADR against the ordinary share in ADR units (lib/market-validation.ts prices). */
export function hynixPrices(adr, ordinary) {
  if (typeof adr !== 'number' || !Number.isFinite(adr) || adr <= 0 || typeof ordinary !== 'number' || !Number.isFinite(ordinary) || ordinary <= 0) throw new Error('Invalid market number');
  const equivalent = ordinary / ADR_PER_SHARE, spread = adr - equivalent, premium = (adr / equivalent - 1) * 100;
  if (![equivalent, spread, premium].every(Number.isFinite) || equivalent <= 0) throw new Error('Invalid market conversion');
  return { adr, ordinary, equivalent, spread, premium };
}

export async function requestInfo(payload, { fetcher = fetch, timeout = 10_000 } = {}) {
  const response = await fetcher(HYPERLIQUID_API_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), credentials: 'omit', signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`Hyperliquid HTTP ${response.status}`);
  return response.json();
}

/** The xyz dex's allMids reply as a quote; allMids has no exchange time, so `fetchedAt` is when the pair was received. */
export function parseHynixMids(mids, receivedAt) {
  if (!mids || typeof mids !== 'object' || Array.isArray(mids)) throw new Error('Invalid quote response');
  const raw = [mids[HYNIX_LEGS.ordinary], mids[HYNIX_LEGS.adr]];
  if (!raw.every(v => typeof v === 'string')) throw new Error('Incomplete quote pair');
  const [ordinary, adr] = raw.map(Number);
  if (![ordinary, adr].every(v => Number.isFinite(v) && v > 0)) throw new Error('Incomplete quote pair');
  return { source: SOURCE, fetchedAt: new Date(receivedAt).toISOString(), ...hynixPrices(adr, ordinary) };
}

export async function fetchHynixQuote({ fetcher = fetch, timeout = 5_000, now = Date.now } = {}) {
  return parseHynixMids(await requestInfo({ type: 'allMids', dex: 'xyz' }, { fetcher, timeout }), now());
}

/** A quote as stored or sent; the derived fields are recomputed from the two prices. */
export function validateHynixQuote(input) {
  const quote = object(input);
  if (quote.source !== SOURCE) throw new Error('Expected a Hyperliquid quote');
  return { source: SOURCE, fetchedAt: stamp(quote.fetchedAt), ...hynixPrices(quote.adr, quote.ordinary) };
}

function validCandles(result, coin) {
  if (!Array.isArray(result) || !result.length || !result.every(c => c && c.s === coin && c.i === '1h' && Number.isFinite(c.t) && Number.isFinite(c.T) && c.T >= c.t && c.T < c.t + HYNIX_CANDLE_MS && Number.isFinite(Number(c.c)) && Number(c.c) > 0)) throw new Error('Unexpected candle response');
  return result;
}

/** Identical completed UTC hours of both legs; a missing quote is never forward-filled. */
export function alignHynixCandles(ordinary, adr, now) {
  const valid = c => Number.isSafeInteger(c.t) && c.t >= FIRST_FULL_HOUR && c.t % HYNIX_CANDLE_MS === 0 && c.T < now && c.t + HYNIX_CANDLE_MS <= now && Number.isFinite(Number(c.c)) && Number(c.c) > 0;
  const byTime = new Map(ordinary.filter(valid).map(c => [c.t, Number(c.c)]));
  return [...new Map(adr.filter(valid).flatMap(c => {
    const base = byTime.get(c.t);
    return base === undefined ? [] : [[c.t, { time: c.t, adr: Number(c.c), ordinary: base }]];
  })).values()].sort((a, b) => a.time - b.time);
}

/**
 * Where a round starts reading: 48 hours before the last stored hour, or (when `full`) the first missing hour if earlier;
 * never before the first full hour or the oldest of the 5000 candles Hyperliquid still serves. Gaps are looked for only
 * from that floor on: hours older than it cannot be read again.
 */
export function hynixCandleStart(rows, now, full) {
  const floor = Math.max(FIRST_FULL_HOUR, Math.floor(now / HYNIX_CANDLE_MS) * HYNIX_CANDLE_MS - (HYNIX_MAX_CANDLES - 1) * HYNIX_CANDLE_MS);
  if (!rows.length) return floor;
  let start = rows.at(-1).time - HYNIX_RESUME_MS;
  if (full) {
    let expected = floor;
    for (const row of rows) {
      if (row.time < floor) continue;
      if (row.time > expected) { start = Math.min(start, expected); break; }
      expected = row.time + HYNIX_CANDLE_MS;
    }
  }
  return Math.max(floor, start);
}

/** Both legs' completed hours from `startTime`, paired; a one-sided or misaligned reply fails the round. */
export async function fetchHynixCandles(startTime, { fetcher = fetch, timeout = 10_000, now }) {
  const candles = async coin => validCandles(await requestInfo({ type: 'candleSnapshot', req: { coin, interval: '1h', startTime, endTime: now } }, { fetcher, timeout }), coin);
  const [ordinary, adr] = await Promise.all([candles(HYNIX_LEGS.ordinary), candles(HYNIX_LEGS.adr)]);
  const rows = alignHynixCandles(ordinary, adr, now);
  if (!rows.length) throw new Error('No shared closed candles');
  return rows;
}

/** Stored or sent rows: whole hours from the first full hour, strictly rising, each closed by `fetchedAt`. */
export function validateHynixRows(input, fetchedAt) {
  const received = Date.parse(stamp(fetchedAt));
  if (!Array.isArray(input) || input.length > 100_000) throw new Error('Invalid market series');
  let previous = -Infinity;
  return input.map(item => {
    const row = object(item), time = row.time;
    if (!Number.isSafeInteger(time) || time < FIRST_FULL_HOUR || time % HYNIX_CANDLE_MS || time + HYNIX_CANDLE_MS > received || time <= previous) throw new Error('Invalid historical hour');
    previous = time;
    hynixPrices(row.adr, row.ordinary);
    return { time, adr: row.adr, ordinary: row.ordinary };
  });
}

/** Chart rows: the ADR (`adr`) against the ordinary share in ADR units (`equivalent`). */
export const hynixChartRows = rows => rows.map(({ time, adr, ordinary }) => ({ time, ...hynixPrices(adr, ordinary) }));
