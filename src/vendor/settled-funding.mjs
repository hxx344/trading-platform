// 复制自 project-aggregation 工作台 modules/monitor：modules/oil/binance-funding-history.mjs（提交 8470785）的原油 4 小时
// 结算配对、校验与分页读取，lib/hynix-funding-history.ts（8470785）的海力士每小时结算配对、校验与分页读取，
// lib/hynix-funding-analysis.ts（8bc3bee）的 analyzeSettledFunding。与原文件不同的地方：
// - 只保留结算行（time 与两腿每次结算费率），不再包一层 metadata 快照；配对、校验、合并规则不变；
// - 请求函数接收 fetcher / timeout（原文件写死 fetch 与 10 秒、Date.now），海力士走 hynix-market.mjs 的 requestInfo；
// - 续读起点多一个 full 开关：工作台每轮都从最早的缺口或单腿结算读起，这里只在 full 时这样做（采集器每小时一次），
//   平时只从最后一次结算往前 48 小时读起；两边都从已存的第一行开始找缺口，起点不早于保留期；
// - 首次回补从首个结算读起（工作台随包附带的结算存档不带）；
// - 合并时新读到的单腿不覆盖已存的另一腿（与原文件相同），抽成 mergeFundingRows 两个市场共用；
// - analyzeFundingWindow（原油按日汇总）与 retainFundingRows（React 状态复用）不带：页面统一用 analyzeSettledFunding。
import { ASSETS, HISTORY_START, numeric, requestBinance } from './oil-market.mjs';
import { FIRST_FULL_HOUR, HYNIX_LEGS, requestInfo } from './hynix-market.mjs';

export const HOUR = 3_600_000;
/** Both oil contracts launched with four-hour settlement and are exempt from automatic interval adjustment. */
export const OIL_FUNDING_HOURS = 4;
export const OIL_FUNDING_MS = OIL_FUNDING_HOURS * HOUR;
export const OIL_FIRST_SETTLEMENT = Math.ceil(HISTORY_START / OIL_FUNDING_MS) * OIL_FUNDING_MS;
export const HYNIX_FUNDING_MS = HOUR;
/** Matches the end of the first full price hour of the spread chart. */
export const HYNIX_FIRST_SETTLEMENT = FIRST_FULL_HOUR + HYNIX_FUNDING_MS;
/** A normal round reads on from this far before the last stored settlement (both workbench readers use two days). */
export const FUNDING_RESUME_MS = 48 * HOUR;

/** Reject an unexpected schedule instead of relabeling it or inferring missing settlements as zero. */
export function pairOilFunding(brent, wti, now) {
  const collect = (rows, symbol) => {
    if (!Array.isArray(rows)) throw Error('Invalid Binance funding history');
    const result = new Map();
    for (const row of rows) {
      const stamp = numeric(row.fundingTime), time = Math.floor(stamp / OIL_FUNDING_MS) * OIL_FUNDING_MS;
      if (row.symbol !== symbol || !Number.isSafeInteger(stamp) || stamp - time >= 60_000 || time < OIL_FIRST_SETTLEMENT || (row.rateType !== undefined && row.rateType !== 'Regular')) throw Error('Unexpected Binance funding settlement');
      if (stamp > now) continue;
      const rate = numeric(row.fundingRate);
      if (Math.abs(rate) > 1 || result.has(time)) throw Error('Invalid or duplicate Binance funding rate');
      result.set(time, rate);
    }
    return result;
  };
  const left = collect(brent, ASSETS.brent.coin), right = collect(wti, ASSETS.wti.coin);
  return [...new Set([...left.keys(), ...right.keys()])].sort((a, b) => a - b).map(time => ({ time, brent: left.get(time) ?? null, wti: right.get(time) ?? null }));
}

/** Ordered settlements on the four-hour grid, each with at least one leg; `fetchedAt` bounds the newest. */
export function validateOilFundingRows(rows, fetchedAt) {
  if (!Array.isArray(rows)) throw Error('Invalid Binance funding rows');
  const received = Date.parse(fetchedAt);
  if (!Number.isFinite(received)) throw Error('Invalid funding fetch timestamp');
  let previous = -1;
  return rows.map(row => {
    if (!Number.isSafeInteger(row?.time) || row.time < OIL_FIRST_SETTLEMENT || row.time % OIL_FUNDING_MS || row.time <= previous || row.time > received) throw Error('Invalid Binance settlement time');
    previous = row.time;
    const brent = row.brent === null ? null : numeric(row.brent), wti = row.wti === null ? null : numeric(row.wti);
    if ((brent === null && wti === null) || (brent !== null && Math.abs(brent) > 1) || (wti !== null && Math.abs(wti) > 1)) throw Error('Invalid Binance settlement rates');
    return { time: row.time, brent, wti };
  });
}

/** Ordered whole UTC hours, each with at least one leg; `fetchedAt` bounds the newest. */
export function validateHynixFundingRows(rows, fetchedAt) {
  if (!Array.isArray(rows)) throw Error('Invalid funding rows');
  const received = Date.parse(fetchedAt);
  if (!Number.isFinite(received)) throw Error('Invalid funding fetch timestamp');
  let previous = -Infinity;
  return rows.map(row => {
    if (!Number.isSafeInteger(row?.time) || row.time < HYNIX_FIRST_SETTLEMENT || row.time > received || row.time % HYNIX_FUNDING_MS || row.time <= previous) throw Error('Invalid or unordered funding settlement hour');
    previous = row.time;
    const adr = row.adr === null ? null : numeric(row.adr), ordinary = row.ordinary === null ? null : numeric(row.ordinary);
    if (adr === null && ordinary === null) throw Error('Funding settlement has neither leg');
    return { time: row.time, adr, ordinary };
  });
}

/** Forward pages of one oil leg's settlements in [startTime, endTime]; never publishes a truncated history. */
export async function fetchOilFundingHistory(symbol, startTime, endTime, options = {}) {
  if (!Object.values(ASSETS).some(asset => asset.coin === symbol)) throw Error('Unsupported Binance funding symbol');
  let cursor = startTime;
  const result = [], limit = options.pageSize ?? 1000;
  for (let page = 0; page < 500 && cursor <= endTime; page++) {
    const rows = await requestBinance('/fapi/v1/fundingRate', { symbol, startTime: cursor, endTime, limit }, options);
    if (!Array.isArray(rows)) throw Error('Invalid Binance funding page');
    if (!rows.length) return result;
    let previous = cursor - 1;
    for (const row of rows) {
      if (row?.symbol !== symbol || !Number.isSafeInteger(row.fundingTime) || row.fundingTime <= previous || row.fundingTime < cursor || row.fundingTime > endTime) throw Error('Invalid Binance funding pagination');
      previous = row.fundingTime; result.push(row);
    }
    cursor = previous + 1;
    if (rows.length < limit) return result;
  }
  if (cursor <= endTime) throw Error('Binance funding pagination exceeded its limit');
  return result;
}

function readRecord(value, coin) {
  if (!value || typeof value !== 'object' || value.coin !== coin || !('time' in value) || !('fundingRate' in value)) throw Error('Unexpected historical funding record');
  const time = numeric(value.time), fundingRate = numeric(value.fundingRate);
  if (!Number.isSafeInteger(time)) throw Error('Invalid funding settlement timestamp');
  return { coin, time, fundingRate };
}

/** Settlement blocks may arrive milliseconds after the UTC hour; one hour with two different rates is rejected. */
export function pairHynixFunding(adrRecords, ordinaryRecords, now) {
  const collect = (records, coin) => {
    const collected = new Map();
    for (const record of records) {
      const { time, fundingRate } = readRecord(record, coin);
      if (time < HYNIX_FIRST_SETTLEMENT || time > now) continue;
      const hour = Math.floor(time / HYNIX_FUNDING_MS) * HYNIX_FUNDING_MS;
      if (collected.has(hour) && collected.get(hour) !== fundingRate) throw Error('Conflicting funding rates in one settlement hour');
      collected.set(hour, fundingRate);
    }
    return collected;
  };
  const adr = collect(adrRecords, HYNIX_LEGS.adr), ordinary = collect(ordinaryRecords, HYNIX_LEGS.ordinary);
  return [...new Set([...adr.keys(), ...ordinary.keys()])].sort((a, b) => a - b).map(time => ({ time, adr: adr.get(time) ?? null, ordinary: ordinary.get(time) ?? null }));
}

/** Pages one Hynix leg's settlements until an empty reply (the endpoint answers at most 500 per call). */
export async function fetchHynixFundingRecords(coin, startTime, endTime, { fetcher = fetch, timeout = 10_000 } = {}) {
  if (![HYNIX_LEGS.adr, HYNIX_LEGS.ordinary].includes(coin)) throw Error('Unsupported funding coin');
  const records = new Map();
  let cursor = startTime;
  for (let page = 0; page < 100 && cursor <= endTime; page++) {
    const body = await requestInfo({ type: 'fundingHistory', coin, startTime: cursor, endTime }, { fetcher, timeout });
    if (!Array.isArray(body)) throw Error('Invalid funding history response');
    if (!body.length) return [...records.values()].sort((a, b) => a.time - b.time);
    let last = -Infinity;
    for (const value of body) {
      const record = readRecord(value, coin);
      if (record.time > endTime) throw Error('Future funding settlement in API response');
      const old = records.get(record.time);
      if (old && old.fundingRate !== record.fundingRate) throw Error('Conflicting funding records across pages');
      if (record.time >= startTime) records.set(record.time, record);
      last = Math.max(last, record.time);
    }
    if (last < cursor) throw Error('Funding pagination did not advance');
    cursor = last + 1;
  }
  if (cursor <= endTime) throw Error('Funding pagination exceeded limit');
  return [...records.values()].sort((a, b) => a.time - b.time);
}

/**
 * Where a round starts reading: the first settlement (not before the retention cut) when nothing is stored, otherwise two
 * days before the last stored settlement, and with `full` also the earliest gap or one-sided settlement in what is stored.
 */
export function fundingStart(rows, { first, intervalMs, legs, cutoff, full, gapSince = -Infinity }) {
  const floor = Math.max(first, cutoff);
  if (!rows.length) return floor;
  let start = rows.at(-1).time - FUNDING_RESUME_MS;
  // Only gaps from `gapSince` on are read again: late records arrive within days, older gaps are taken as permanent.
  const scan = full ? rows.filter(row => row.time >= gapSince) : [];
  if (scan.length) {
    let expected = scan[0].time;
    for (const row of scan) {
      if (row.time > expected || legs.some(leg => row[leg] === null)) { start = Math.min(start, Math.min(expected, row.time)); break; }
      expected = row.time + intervalMs;
    }
  }
  return Math.max(floor, start);
}

/** Fetched settlements replace stored ones by time; a fetched missing leg keeps the stored rate of that leg. */
export function mergeFundingRows(previous, fetched, legs) {
  const merged = new Map(previous.map(row => [row.time, row]));
  for (const row of fetched) {
    const old = merged.get(row.time), next = { time: row.time };
    for (const leg of legs) next[leg] = row[leg] ?? old?.[leg] ?? null;
    merged.set(row.time, next);
  }
  return [...merged.values()].sort((a, b) => a.time - b.time);
}

/** The oil pair's settlements from `startTime` to `now`, both legs read together. */
export async function fetchOilFunding(startTime, { fetcher, timeout = 15_000, now, endTime = now }) {
  const [brent, wti] = await Promise.all([ASSETS.brent.coin, ASSETS.wti.coin].map(symbol => fetchOilFundingHistory(symbol, startTime, Math.min(endTime, now), { fetcher, timeout })));
  return pairOilFunding(brent, wti, now);
}

/** The Hynix pair's settlements from `startTime` to `endTime` (default `now`), both legs read together. */
export async function fetchHynixFunding(startTime, { fetcher, timeout = 10_000, now, endTime = now }) {
  const [adr, ordinary] = await Promise.all([HYNIX_LEGS.adr, HYNIX_LEGS.ordinary].map(coin => fetchHynixFundingRecords(coin, startTime, Math.min(endTime, now), { fetcher, timeout })));
  return pairHynixFunding(adr, ordinary, now);
}

/**
 * Settled two-leg funding over equal notionals. Each row holds the per-settlement rate of leg A (`adr`) and leg B
 * (`ordinary`); "short" is short A / long B. Rates are shown per hour and annualized over the covered settlement hours,
 * never compounded and never zero-filled.
 */
export function analyzeSettledFunding(rows, days, endTime, { intervalMs, firstSettlement }) {
  const hours = intervalMs / HOUR;
  const end = Math.floor(endTime / intervalMs) * intervalMs;
  // N days contain exactly N*24/hours settlements, not an extra boundary settlement.
  const start = days === null ? firstSettlement : Math.max(firstSettlement, end - (days * 24 / hours - 1) * intervalMs);
  const selected = rows.filter(row => row.time >= start && row.time <= end);
  const chart = [];
  let cumulative = 0, count = 0;
  const yearly = (sum, settlements) => sum / (settlements * hours) * 24 * 365;
  const gap = time => ({ time, shortRate: null, longRate: null, shortCumulative: null, longCumulative: null, shortAnnualized: null, longAnnualized: null, adr: null, ordinary: null, count });
  if (selected.length && selected[0].time > start) chart.push(gap(start));
  for (const [index, row] of selected.entries()) {
    if (index && row.time - selected[index - 1].time > intervalMs) chart.push(gap(selected[index - 1].time + intervalMs));
    const rate = row.adr === null || row.ordinary === null ? null : (row.adr - row.ordinary) / 2;
    if (rate !== null) { cumulative += rate; count++; }
    const annualized = count ? yearly(cumulative, count) : null;
    if ((rate !== null && !Number.isFinite(rate)) || !Number.isFinite(cumulative) || (annualized !== null && !Number.isFinite(annualized))) throw Error('Historical funding calculation overflow');
    const hourly = rate === null ? null : rate / hours;
    chart.push({ time: row.time, shortRate: hourly, longRate: hourly === null ? null : -hourly, shortCumulative: rate === null ? null : cumulative, longCumulative: rate === null ? null : -cumulative, shortAnnualized: rate === null ? null : annualized, longAnnualized: rate === null ? null : -annualized, adr: row.adr, ordinary: row.ordinary, count });
  }
  if (selected.length && selected.at(-1).time < end) chart.push(gap(selected.at(-1).time + intervalMs));
  const expectedHours = end < start ? 0 : Math.round((end - start) / intervalMs) + 1;
  const last = chart.findLast(point => point.shortRate !== null);
  return {
    chart, count, expectedHours, missingHours: expectedHours - count,
    firstTime: expectedHours ? start : null, lastTime: expectedHours ? end : null,
    shortCumulative: count ? cumulative : null, longCumulative: count ? -cumulative : null,
    shortAnnualized: count ? yearly(cumulative, count) : null, longAnnualized: count ? -yearly(cumulative, count) : null,
    latestShortRate: last?.shortRate ?? null, latestLongRate: last?.longRate ?? null,
  };
}
