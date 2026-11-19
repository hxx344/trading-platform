// Public terminal feeds adapted from your-quantguy/gate-crossex at 423356d.
// Copyright (c) the original contributors. AGPL-3.0-only; see THIRD_PARTY_NOTICES.md.
import { getJson } from './clients.mjs';
import { AppError } from './model.mjs';
import { D, Decimal } from './money.mjs';
import { numeric, normalizeCandles, failure, INTERVALS, CANDLE_LIMIT, validCandleRange } from './terminal-data.mjs';
import { readSignal } from './shared-read.mjs';

const BARS = { '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '4h': '240', '1d': 'D' };
export function createCandleReader({ fetcher = fetch, clock = Date.now } = {}) {
  return async function candles(q, interval, signal, range) {
    signal?.throwIfAborted();
    const get = url => getJson(url, { fetcher, maxBytes: 4000000, signal });
    if (typeof interval !== 'string' || !Object.hasOwn(INTERVALS, interval)) throw new AppError('不支持的 K 线周期');
    const now = clock(), step = INTERVALS[interval];
    if (range !== undefined && !validCandleRange(interval, range?.from, range?.to, now)) throw new AppError('K 线时间区间无效');
    const encoded = encodeURIComponent(q.symbol), end = range?.to ?? now, start = range?.from ?? end - step * CANDLE_LIMIT;
    const limit = range ? Math.floor((end - start) / step) + 1 : CANDLE_LIMIT;
    let data, rows;
    if (q.exchange === 'binance') {
      data = await get(`https://fapi.binance.com/fapi/v1/klines?symbol=${encoded}&interval=${interval}&limit=${limit}${range ? `&startTime=${start}&endTime=${end}` : ''}`);
      rows = data?.map?.(r => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }));
    } else if (q.exchange === 'bybit') {
      data = await get(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${encoded}&interval=${BARS[interval]}&limit=${limit}${range ? `&start=${start}&end=${end}` : ''}`);
      if (data.retCode !== 0 || data.result?.symbol !== q.symbol || data.result?.category !== 'linear') throw failure();
      rows = data.result?.list?.map(r => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }));
    } else if (q.exchange === 'okx') {
      const bar = interval.endsWith('h') ? interval.toUpperCase() : interval === '1d' ? '1Dutc' : interval;
      data = await get(`https://www.okx.com/api/v5/market/candles?instId=${encoded}&bar=${bar}&limit=${limit}${range ? `&before=${start - 1}&after=${end + 1}` : ''}`);
      if (data.code !== '0') throw failure();
      // OKX's seventh column is volume in base currency; column six is contracts.
      rows = data.data?.filter(r => r[8] !== '0' || Number(r[0]) + step > now)
        .map(r => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[6] }));
    } else if (q.exchange === 'gate') {
      // Gate rejects limit together with from/to. The volume multiplier must still match the resolved identity.
      const bounds = range ? `from=${Math.floor(start / 1000)}&to=${Math.floor(end / 1000)}` : `limit=${limit}`;
      const [candles, contract] = await Promise.all([get(`https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${encoded}&interval=${interval}&${bounds}`), get(`https://api.gateio.ws/api/v4/futures/usdt/contracts/${encoded}`)]);
      const unit = numeric(contract.quanto_multiplier, true);
      if (!unit || contract.name !== q.symbol || q.nativeUnit !== undefined && unit !== numeric(q.nativeUnit, true)) throw failure();
      rows = candles?.filter?.(r => r.w !== false || Number(r.t) * 1000 + step > now)
        .map(r => ({ time: Number(r.t) * 1000, open: r.o, high: r.h, low: r.l, close: r.c, volume: D(r.v).times(unit).toString() }));
    } else if (q.exchange === 'kraken') {
      data = await get(`https://futures.kraken.com/api/charts/v1/trade/${encoded}/${interval}?count=${limit}${range ? `&from=${Math.floor(start / 1000)}&to=${Math.floor(end / 1000)}` : ''}`);
      rows = data.candles?.map(r => ({ time: r.time, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }));
    } else if (q.exchange === 'hyperliquid') {
      // Public read-only POST. No account, authentication or order payload exists here.
      const response = await fetcher('https://api.hyperliquid.xyz/info', { method: 'POST', redirect: 'error', signal: readSignal(signal, AbortSignal.timeout(8000)), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'candleSnapshot', req: { coin: q.symbol, interval, startTime: start, endTime: end } }) });
      if (!response.ok) { await response.body?.cancel(); throw failure(); }
      const chunks = []; let length = 0;
      for await (const chunk of response.body || []) { length += chunk.length; if (length > 4000000) throw failure(); chunks.push(chunk); }
      data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!Array.isArray(data) || data.some(r => r?.s !== q.symbol || r.i !== interval)) throw failure();
      rows = data?.map?.(r => ({ time: r.t, open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v }));
    } else if (q.exchange === 'lighter') {
      if (!Number.isInteger(q.marketId) || q.marketId < 0) throw failure();
      data = await get(`https://mainnet.zklighter.elliot.ai/api/v1/candles?market_id=${q.marketId}&resolution=${interval}&start_timestamp=${start}&end_timestamp=${end + 1}&count_back=${limit}`);
      if (data.code !== 200 || data.r !== undefined && data.r !== interval || data.resolution !== undefined && data.resolution !== interval) throw failure();
      rows = data.c?.map(r => ({ time: r.t, open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v }));
    } else if (q.exchange === 'deribit') {
      data = await get(`https://www.deribit.com/api/v2/public/get_tradingview_chart_data?instrument_name=${encoded}&start_timestamp=${start}&end_timestamp=${end}&resolution=${interval === '4h' ? '60' : interval === '1d' ? '1D' : BARS[interval]}`);
      const r = data.result;
      if (data.error || !r || !['ok', 'no_data'].includes(r.status)) throw failure();
      if (r.status === 'no_data') return [];
      if (!Array.isArray(r.ticks) || ['open', 'high', 'low', 'close', 'volume'].some(k => r[k]?.length !== r.ticks.length)) throw failure();
      rows = r.ticks.map((t, i) => ({ time: t, open: r.open[i], high: r.high[i], low: r.low[i], close: r.close[i], volume: r.volume[i] }));
      if (interval === '4h') {
        const hours = normalizeCandles(rows, '1h', now, 960), buckets = new Map();
        for (const c of hours) { const t = Math.floor(c.time / INTERVALS['4h']) * INTERVALS['4h']; const list = buckets.get(t) || []; list.push(c); buckets.set(t, list); }
        // Only complete four-hour groups or a contiguous current partial bar are shown.
        rows = [...buckets].flatMap(([t, list]) => list[0].time === t && list.every((c, i) => c.time === t + i * INTERVALS['1h']) && (list.length === 4 || t + INTERVALS['4h'] > now)
          ? [{ time: t, open: list[0].open, high: Decimal.max(...list.map(c => c.high)).toString(), low: Decimal.min(...list.map(c => c.low)).toString(), close: list.at(-1).close, volume: list.reduce((v, c) => v.plus(c.volume), D(0)).toString() }] : []);
      }
    } else throw new AppError('不支持此公开行情来源');
    const validated = normalizeCandles(rows, interval, now, 5000);
    return validated.filter(c => !range || c.time >= start && c.time <= end).slice(-limit);
  };
}
