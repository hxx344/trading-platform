// Public terminal feeds adapted from your-quantguy/gate-crossex at 423356d.
// Copyright (c) the original contributors. AGPL-3.0-only; see THIRD_PARTY_NOTICES.md.
import { AppError } from './model.mjs';
import { D, Decimal } from './money.mjs';
import { INTERVALS, CANDLE_LIMIT } from './terminal-intervals.ts';
export { INTERVALS, CANDLE_LIMIT };

export const TERMINAL_SYMBOL = /^(BINANCE|BYBIT|OKX|GATE|KRAKEN|HYPERLIQUID|DERIBIT|LIGHTER)_FUTURE_[A-Z0-9]{1,30}_(USDT|USDC|USD)$/;
export const bookChannel = symbol => symbol.startsWith('KRAKEN_') ? null : symbol.startsWith('BYBIT_') ? 'order_book_1' : 'order_book_5';
// from is an opening time. to is inclusive and may fall inside the live candle.
export function validCandleRange(interval, from, to, now) {
  const step = INTERVALS[interval];
  return typeof interval === 'string' && Object.hasOwn(INTERVALS, interval)
    && Number.isSafeInteger(from) && from > 0 && from % step === 0
    && Number.isSafeInteger(to) && to >= from && to <= now + 1000 && to - from < CANDLE_LIMIT * step;
}
export const numeric = (v, positive = false) => { try { return ['string', 'number'].includes(typeof v) && String(v).trim() && D(v).isFinite() && (!positive || D(v).gt(0)) ? D(v).toString() : null; } catch { return null; } };
export const time = v => { if (typeof v !== 'number' && (typeof v !== 'string' || !/^[0-9]+$/.test(v))) return null; const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };
export const failure = () => new AppError('公开历史行情响应无效', 502);
export function normalizeCandles(rows, interval, now, keep = CANDLE_LIMIT) {
  if (!Array.isArray(rows) || rows.length > 5000) throw failure();
  const unique = new Map();
  for (const row of rows) {
    const candle = { time: time(row.time), open: numeric(row.open, true), high: numeric(row.high, true), low: numeric(row.low, true), close: numeric(row.close, true), volume: numeric(row.volume) };
    if (!candle.time || candle.time > now + 1000 || candle.time % INTERVALS[interval] !== 0 || Object.values(candle).some(v => v === null) || D(candle.volume).lt(0)
      || D(candle.high).lt(Decimal.max(candle.open, candle.close, candle.low)) || D(candle.low).gt(Decimal.min(candle.open, candle.close, candle.high))) throw failure();
    if (unique.has(candle.time)) throw failure();
    unique.set(candle.time, candle);
  }
  // Preserve genuine gaps. The chart must not manufacture missing candles.
  return [...unique.values()].sort((a, b) => a.time - b.time).slice(-keep);
}
