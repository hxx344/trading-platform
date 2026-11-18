// Executed beside the user's paper positions and fee settings; only public contract identities reach the book reader.
import { quoteCurrencyFx } from './perpetual-fx.ts';
import { pairTakerFees } from './perpetual-fees.ts';
import { calculatePerpetualExitPnl, perpetualExitIdentity, validatePerpetualExitPosition } from './perpetual-exit.ts';
import { EXCHANGES } from './perpetual-venues.mjs';

const IDS = new Set(EXCHANGES.map(exchange => exchange.id));
const MAX_BOOK_AGE = 10_000, MAX_SKEW = 5_000;
export const positive = value => (typeof value === 'number' || (typeof value === 'string' && value.trim())) && Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
export const failure = (message, status = 400) => Object.assign(new Error(message), { status });
export const validTime = (value, now) => Number.isFinite(Number(value)) && Number(value) >= 1e12 && Number(value) <= now + 5_000 ? Number(value) : null;

/** Budget is a long-leg USDT notional; both legs hold the same underlying amount. */
export function estimateDepthPair(longBook, shortBook, notional, fx, now = Date.now()) {
  const base = { notional, notionalCurrency: 'USDT', generatedAt: now, staleAfterMs: MAX_BOOK_AGE, complete: false, estimatedSpreadPct: null, entrySlippagePct: null, quantity: null, long: null, short: null, reasons: [] };
  if (!positive(notional) || notional > 10_000_000) throw failure('单腿目标金额需大于 0 且不超过 10,000,000 USDT');
  for (const [name, book] of [['做多', longBook], ['做空', shortBook]]) {
    if (!book || book.reason) base.reasons.push(`${name}腿：${book?.reason || '盘口缺失'}`);
    else if (!validTime(book.sourceTime, now) || !validTime(book.receivedAt, now) || now - book.sourceTime > MAX_BOOK_AGE || now - book.receivedAt > MAX_BOOK_AGE) base.reasons.push(`${name}腿：盘口时间缺失或超过 10 秒`);
    else if (!book.asks?.length || !book.bids?.length || book.bids[0][0] > book.asks[0][0]) base.reasons.push(`${name}腿：盘口为空或买卖价格倒挂`);
  }
  if (base.reasons.length) return base;
  if (Math.abs(longBook.sourceTime - shortBook.sourceTime) > MAX_SKEW) { base.reasons.push('两腿盘口时间相差超过 5 秒，请重新校验'); return base; }
  const longFx = quoteCurrencyFx(longBook.quoteCurrency, fx, now), shortFx = quoteCurrencyFx(shortBook.quoteCurrency, fx, now);
  if (!longFx || !shortFx) { base.reasons.push('计价币兑 USDT 汇率缺失或过期，无法按统一金额校验'); return base; }
  const asks = longBook.asks.map(([price, size]) => [price * longFx.ask, size]);
  const bids = shortBook.bids.map(([price, size]) => [price * shortFx.bid, size]);
  let remaining = notional, quantity = 0, longValue = 0;
  for (const [price, size] of asks) { const used = Math.min(size, remaining / price); quantity += used; longValue += used * price; remaining = Math.max(0, remaining - used * price); if (remaining < notional * 1e-10) break; }
  const longComplete = remaining <= notional * 1e-8;
  let shortRemaining = quantity, shortValue = 0, shortQuantity = 0;
  for (const [price, size] of bids) { const used = Math.min(size, shortRemaining); shortQuantity += used; shortValue += used * price; shortRemaining = Math.max(0, shortRemaining - used); if (shortRemaining < quantity * 1e-10) break; }
  const shortComplete = shortRemaining <= quantity * 1e-8;
  const view = (book, levels, filledQuantity, filledNotional, complete) => ({ exchange: book.exchange, symbol: book.symbol, quoteCurrency: book.quoteCurrency, sourceTime: book.sourceTime, receivedAt: book.receivedAt, transport: book.transport, source: book.source, levels: levels.length, complete, filledQuantity, filledNotional, vwap: filledQuantity > 0 ? filledNotional / filledQuantity : null, capacityQuantity: levels.reduce((sum, row) => sum + row[1], 0), capacityNotional: levels.reduce((sum, row) => sum + row[0] * row[1], 0) });
  base.long = view(longBook, asks, quantity, longValue, longComplete);
  base.short = view(shortBook, bids, shortQuantity, shortValue, shortComplete);
  base.quantity = quantity;
  if (!longComplete) base.reasons.push(`做多腿公开 ${asks.length} 档盘口不足目标金额`);
  if (!shortComplete) base.reasons.push(`做空腿公开 ${bids.length} 档盘口不足以匹配做多数量`);
  base.complete = longComplete && shortComplete;
  if (base.complete) {
    base.estimatedSpreadPct = (shortValue / longValue - 1) * 100;
    base.entrySlippagePct = Math.max(0, (bids[0][0] / asks[0][0] - 1) * 100 - base.estimatedSpreadPct);
  }
  return base;
}

/** Same-asset, linear USDT close: sell the long into bids, buy the short from asks. */
export function estimateExitPair(longBook, shortBook, input, quotes, now = Date.now()) {
  validatePerpetualExitPosition(input);
  const { quantity, entryLongPrice, entryShortPrice, entryFeePaid, settledFunding, capital } = input;
  const position = { quantity, entryLongPrice, entryShortPrice, entryFeePaid, settledFunding, capital };
  const fees = pairTakerFees({ long: quotes[0], short: quotes[1] }, input.takerOverrides ?? {}, now);
  const result = { kind: 'exit', identity: perpetualExitIdentity(quotes[0], quotes[1]), base: quotes[0].base, currency: 'USDT', position,
    generatedAt: now, staleAfterMs: MAX_BOOK_AGE, bookComplete: false, complete: false,
    entryLongNotional: quantity * entryLongPrice, entryShortNotional: quantity * entryShortPrice, entryNotional: quantity * entryLongPrice,
    longPnl: null, shortPnl: null, rawPnl: null, entryFeePaid, closeFeePaid: null, settledFunding, netPnl: null, notionalReturnPercent: null, capitalReturnPercent: null,
    fees, long: null, short: null, reasons: [] };
  if (input.identity !== undefined && input.identity !== result.identity) { result.reasons.push('合约身份或数量单位已变化，请重新确认持仓'); return result; }
  if (quotes[0].base !== quotes[1].base || quotes[0].exchange === quotes[1].exchange || quotes.some(quote => quote.comparable === false)) {
    result.reasons.push('两腿需为可比较的相同标的、不同交易所'); return result;
  }
  if (quotes.some(quote => quote.quoteCurrency !== 'USDT' || (quote.collateralCurrency != null && quote.collateralCurrency !== 'USDT'))) {
    result.reasons.push('平仓测算当前仅支持两腿均以 USDT 计价及结算的线性合约，跨币种资金流暂不估算'); return result;
  }
  for (const [index, book] of [longBook, shortBook].entries()) {
    const name = index === 0 ? '做多' : '做空', quote = quotes[index];
    if (!book || book.reason) result.reasons.push(`${name}腿：${book?.reason || '盘口缺失'}`);
    else if (book.exchange !== quote.exchange || book.symbol !== quote.symbol || book.base !== quote.base || book.quoteCurrency !== 'USDT') result.reasons.push(`${name}腿：盘口合约与持仓身份不符`);
    else if (!validTime(book.sourceTime, now) || !validTime(book.receivedAt, now) || now - book.sourceTime > MAX_BOOK_AGE || now - book.receivedAt > MAX_BOOK_AGE) result.reasons.push(`${name}腿：盘口时间缺失或超过 10 秒`);
    else if (![book.asks, book.bids].every(levels => Array.isArray(levels) && levels.length > 0 && levels.every(row => Array.isArray(row) && positive(row[0]) && positive(row[1]))) || book.bids[0][0] > book.asks[0][0]) result.reasons.push(`${name}腿：盘口为空或买卖价格倒挂`);
  }
  if (result.reasons.length) return result;
  if (Math.abs(longBook.sourceTime - shortBook.sourceTime) > MAX_SKEW) { result.reasons.push('两腿盘口时间相差超过 5 秒，请重新校验'); return result; }
  const fill = (book, levels, action, fee, entryPrice) => {
    let remaining = quantity, filledQuantity = 0, filledNotional = 0;
    for (const [price, size] of levels) {
      const used = Math.min(remaining, size); filledQuantity += used; filledNotional += used * price; remaining = Math.max(0, remaining - used);
      if (remaining <= quantity * 1e-10) break;
    }
    const complete = remaining <= quantity * 1e-8;
    return { exchange: book.exchange, symbol: book.symbol, quoteCurrency: 'USDT', sourceTime: book.sourceTime, receivedAt: book.receivedAt, transport: book.transport, source: book.source,
      levels: levels.length, complete, filledQuantity, filledNotional, vwap: filledQuantity > 0 ? filledNotional / filledQuantity : null,
      capacityQuantity: levels.reduce((sum, row) => sum + row[1], 0), capacityNotional: levels.reduce((sum, row) => sum + row[0] * row[1], 0),
      action, fee, pnl: complete ? (action === 'sell' ? filledNotional - quantity * entryPrice : quantity * entryPrice - filledNotional) : null,
      closeFee: complete && fee.percent !== null ? filledNotional * fee.percent / 100 : null };
  };
  result.long = fill(longBook, longBook.bids, 'sell', fees.long, entryLongPrice);
  result.short = fill(shortBook, shortBook.asks, 'buy', fees.short, entryShortPrice);
  result.longPnl = result.long.pnl; result.shortPnl = result.short.pnl;
  for (const [name, leg] of [['做多', result.long], ['做空', result.short]]) {
    if (!leg.complete) result.reasons.push(`${name}腿公开 ${leg.levels} 档盘口不足以全部平仓，已显示部分容量`);
    if (leg.fee.percent === null) result.reasons.push(`${name}腿：${leg.fee.detail}`);
  }
  result.bookComplete = result.long.complete && result.short.complete;
  if (result.bookComplete) {
    Object.assign(result, calculatePerpetualExitPnl(position, result.long.vwap, result.short.vwap, fees));
    result.complete = result.netPnl !== null;
  }
  if (quotes.some(quote => quote.delistingAt && quote.delistingAt <= now)) result.reasons.push('合约已到公告下架时间；此处仅为盘口估值，请核实平台是否仍允许平仓');
  return result;
}

export function createPerpetualEstimates({ getQuote, books, fx, clock = Date.now }) {
  function selectLegs(input, closing = false) {
      const legs = ['long', 'short'].map(side => {
        const leg = input?.[side];
        if (!leg || !IDS.has(leg.exchange) || typeof leg.symbol !== 'string' || !/^[A-Za-z0-9:_.-]{1,100}$/.test(leg.symbol)) throw failure('请选择有效的交易所与合约');
        const quote = getQuote?.(leg.exchange, leg.symbol);
        if (!quote || quote.comparable === false) throw failure('合约不在当前可比较目录中');
        if (!closing && quote.delistingAt && quote.delistingAt <= clock()) throw failure('该合约已到下架时间');
        return { ...quote };
      });
      if (legs[0].base !== legs[1].base || legs[0].exchange === legs[1].exchange) throw failure('两腿需为相同标的、不同交易所');
      return legs;
  }
  return {
    fx,
    async exit(input) {
      try { validatePerpetualExitPosition(input); } catch (error) { throw failure(error.message); }
      const legs = selectLegs(input, true), identity = perpetualExitIdentity(legs[0], legs[1]);
      if (input.identity !== undefined && (typeof input.identity !== 'string' || input.identity !== identity)) throw failure('合约身份或数量单位已变化，请重新确认持仓', 409);
      if (legs.some(quote => quote.quoteCurrency !== 'USDT' || (quote.collateralCurrency != null && quote.collateralCurrency !== 'USDT'))) throw failure('平仓测算当前仅支持两腿均以 USDT 计价及结算的线性合约，跨币种资金流暂不估算');
      if (input.takerOverrides !== undefined && (!input.takerOverrides || typeof input.takerOverrides !== 'object' || Array.isArray(input.takerOverrides))) throw failure('账户手续费设置格式无效');
      const [longBook, shortBook] = await books(legs);
      const latest = selectLegs(input, true);
      if (identity !== perpetualExitIdentity(latest[0], latest[1])) throw failure('查询期间合约身份或数量单位已变化，请重新确认持仓', 409);
      return estimateExitPair(longBook, shortBook, input, latest, clock());
    },
    async depth(input) {
      const legs = selectLegs(input);
      const notional = positive(input?.notional);
      if (!notional || notional > 10_000_000) throw failure('单腿目标金额需大于 0 且不超过 10,000,000 USDT');
      // Obtain FX first: depth must not age while waiting for extra FX requests.
      const rates = legs.every(leg => leg.quoteCurrency === 'USDT') ? null : await fx();
      const [longBook, shortBook] = await books(legs);
      return estimateDepthPair(longBook, shortBook, notional, rates, clock());
    },
  };
}
