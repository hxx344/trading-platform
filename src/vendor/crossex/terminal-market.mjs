// Public terminal feeds adapted from your-quantguy/gate-crossex at 423356d.
// Copyright (c) the original contributors. AGPL-3.0-only; see THIRD_PARTY_NOTICES.md.
import { createTerminalFeed } from './terminal-feed.mjs';
import { createCandleReader } from './candle-reader.mjs';
import { bookChannel, numeric, time, TERMINAL_SYMBOL, normalizeCandles, INTERVALS } from './terminal-data.mjs';
import { createTerminalHistory } from './terminal-history.mjs';
import { loadManualDepth } from './clients.mjs';
import { AppError, contractIdentity, validateBooks } from './model.mjs';
import { D } from './money.mjs';

export { createCandleReader, normalizeCandles, INTERVALS };

/** Authenticated HTTP readers share one bounded, credential-free public stream. */
export function createTerminalMarket({ market, store, depthReader = loadManualDepth, candleReader = createCandleReader(), WebSocketImpl, clock = Date.now, publicFeed = createTerminalFeed({ WebSocketImpl, clock }) } = {}) {
  const entries = new Map(), historyFlights = new Set(), archive = createTerminalHistory(store, candleReader, clock);
  let stopped = false;
  const active = e => clock() - e.touched < 120000;
  const freshAt = (at, age = 10000) => time(at) && at <= clock() + 1000 && clock() - at <= age;
  const unitOf = e => ['gate', 'okx'].includes(e.display.quote.exchange) ? numeric(e.quote?.nativeUnit, true) : '1';
  function clearCandles(e) {
    for (const history of e.candles.values()) history.controller.abort();
    e.candles.clear();
  }
  function release(e) { e.unsubscribe?.(); clearCandles(e); }
  // Keep the raw stream so a newly confirmed multiplier never mixes units.
  const streamBook = e => {
    if (!e.streamBook) return null;
    const unit = unitOf(e);
    return { ...e.streamBook, quantityUnit: unit ? 'base' : 'contracts', ...Object.fromEntries(['bids', 'asks'].map(side => [side, e.streamBook[side].map(([p, q]) => [p, unit ? D(q).times(unit).toString() : q])])) };
  };
  async function briefly(promise) {
    if (!promise) return;
    let timer;
    try { await Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, 150); })]); }
    finally { clearTimeout(timer); }
  }
  function watch(symbol, e) {
    if (e.unsubscribe) return;
    e.unsubscribe = publicFeed.subscribe(symbol, { data(m) {
      try {
        const r = m.result;
        if (stopped || entries.get(symbol) !== e || r?.s !== symbol || m.event !== 'update' || !e.display || !active(e)) return;
        if (m.channel === 'ticker' && numeric(r.lp, true) && numeric(r.bp, true) && numeric(r.ap, true) && time(r.ts) && r.ts <= clock() + 1000 && clock() - r.ts <= 10000) {
          if (e.tickerAt && r.ts < e.tickerAt || D(r.bp).gt(r.ap)) return;
          e.ticker = { ...e.ticker, lastPrice: numeric(r.lp), change24h: numeric(r.o, true) ? D(r.lp).div(r.o).minus(1).toString() : null,
            // Volume units differ by venue on WS; do not label unknown units as base.
            volume24h: null, bidPrice: numeric(r.bp), askPrice: numeric(r.ap) }; e.tickerAt = time(r.ts);
        } else if (m.channel === bookChannel(r.s) && freshAt(r.ts) && (!e.streamBook || r.ts >= e.streamBook.at)) {
          const sides = {};
          for (const [side, rows] of [['bids', r.b], ['asks', r.a]]) {
            const limit = m.channel === 'order_book_1' ? 1 : 5;
            if (!Array.isArray(rows) || !rows.length || rows.length > limit) return;
            sides[side] = rows.map(row => Array.isArray(row) && row.length >= 2 ? [numeric(row[0], true), numeric(row[1], true)] : [null, null]);
            if (sides[side].some(row => row.some(v => v === null))) return;
            for (let i = 1; i < sides[side].length; i++) if (side === 'bids' ? D(sides[side][i][0]).gte(sides[side][i - 1][0]) : D(sides[side][i][0]).lte(sides[side][i - 1][0])) return;
          }
          if (D(sides.bids[0][0]).gt(sides.asks[0][0])) return;
          e.streamBook = { ...sides, at: time(r.ts) };
        } else if (m.channel === 'mark_price' && numeric(r.mp, true) && freshAt(m.time_ms) && (!e.mark || m.time_ms >= e.mark.at)) {
          e.mark = { price: numeric(r.mp), at: time(m.time_ms) };
        } else if (m.channel === 'funding_rate' && numeric(r.r) !== null && time(r.T) && r.T > clock() && time(m.time_ms)
          && m.time_ms <= clock() + 1000 && clock() - m.time_ms < 60000 && (!e.funding || m.time_ms >= e.funding.at)) {
          e.funding = { fundingRate: numeric(r.r), nextFundingAt: time(r.T), at: time(m.time_ms) };
        } else if (m.channel === 'trade' && typeof r.i === 'string' && r.i.length > 0 && r.i.length < 200 && numeric(r.p, true) && numeric(r.q, true) && ['BUY', 'SELL'].includes(r.S) && time(r.ts) && r.ts <= clock() + 1000 && clock() - r.ts < 300000) {
          if (!e.trades.some(t => t.id === r.i)) e.trades = [{ id: r.i, price: numeric(r.p), quantity: numeric(r.q), side: r.S, at: time(r.ts) }, ...e.trades].sort((a, b) => b.at - a.at).slice(0, 60);
        }
      } catch { /* Invalid public frames never replace validated data. */ }
    }, down() {
      e.epoch++; e.ticker = {}; e.tickerAt = 0; e.streamBook = null; e.book = null; e.mark = null; e.funding = null; e.trades = [];
      e.error = '公开行情连接已中断'; e.bookAttempt = -Infinity;
    } });
  }
  const sweep = setInterval(() => {
    for (const [symbol, e] of entries) if (!active(e) && !e.flight && !e.displayFlight) { release(e); entries.delete(symbol); }
  }, 25000); sweep.unref();
  async function read(symbol, interval = '5m') {
    if (stopped) throw new AppError('行情服务已停止', 503);
    if (!Object.hasOwn(INTERVALS, interval)) throw new AppError('不支持的 K 线周期');
    if (typeof symbol !== 'string' || !TERMINAL_SYMBOL.test(symbol)) throw new AppError('合约格式无效');
    let e = entries.get(symbol);
    if (!e) {
      if (entries.size >= 12) {
        const oldest = [...entries].filter(([, x]) => !x.flight && !x.displayFlight).sort((a, b) => a[1].touched - b[1].touched)[0];
        if (!oldest) throw new AppError('行情查询繁忙，请稍后重试', 429);
        release(oldest[1]); entries.delete(oldest[0]);
      }
      e = { touched: clock(), epoch: 0, book: null, bookAttempt: -Infinity, identityAttempt: -Infinity, flight: null, ticker: {}, tickerAt: 0, trades: [], candles: new Map() }; entries.set(symbol, e);
    }
    e.touched = clock();
    // A current CrossEx listing authorizes public subscription, not execution.
    if (!e.displayFlight) e.displayFlight = Promise.resolve().then(() => (market.resolveDisplaySymbol ?? market.resolveSymbol)(symbol)).finally(() => { e.displayFlight = null; });
    try { e.display = await e.displayFlight; }
    catch (error) { if (entries.get(symbol) === e) { release(e); entries.delete(symbol); } throw error; }
    if (stopped) throw new AppError('行情服务已停止', 503);
    if (entries.get(symbol) !== e) throw new AppError('行情查询已失效，请重试', 409);
    watch(symbol, e);
    if (!e.flight && clock() - e.bookAttempt >= 1500) {
      e.bookAttempt = clock();
      e.flight = (async () => {
        try {
          // Display metadata has a bounded retry interval. Actual preview and
          // confirmation resolve current native metadata independently.
          if (clock() - e.identityAttempt >= 30000) {
            e.identityAttempt = clock();
            let resolved;
            try { resolved = await market.resolveSymbol(symbol); }
            catch (error) { e.quote = null; clearCandles(e); e.tradingError = error instanceof AppError ? error.message : '原生合约身份暂未确认'; throw error; }
            const { quote, rule } = resolved;
            const identity = contractIdentity(quote);
            if (e.identity && e.identity !== identity) { e.book = null; clearCandles(e); }
            e.identity = identity; e.identityAt = e.identityAttempt;
            e.quote = quote; e.rule = rule;
          }
          if (!e.quote) throw new AppError(e.tradingError || '原生合约身份暂未确认');
          if (stopped) return;
          e.tradingError = null;
          if (e.streamBook && freshAt(e.streamBook.at)) return;
          const epoch = e.epoch, book = await depthReader(e.quote);
          if (epoch !== e.epoch) return;
          validateBooks([book, book], clock());
          if (e.book && book.at < e.book.at) throw new AppError('盘口来源时间回退');
          e.book = { bids: book.bids.map(r => r.map(String)), asks: book.asks.map(r => r.map(String)), at: book.at, quantityUnit: 'base' }; e.error = null;
        } catch (error) { e.error = error instanceof AppError ? error.message : '公开盘口暂不可用';
          if (!e.quote) e.tradingError = e.error;
        }
      })().finally(() => { e.flight = null; });
    }
    await briefly(e.flight);
    if (stopped) throw new AppError('行情服务已停止', 503);
    let history, historyError = null;
    if (e.quote && clock() - e.identityAt < 30000) {
      history = e.candles.get(interval);
      try { history = archive.restore(e.identity, interval, history); e.candles.set(interval, history); }
      catch { historyError = '已保存的历史 K 线暂不可读'; }
      if (history && !historyError && !history.flight && (clock() < history.attempt || clock() - history.attempt >= 15000)) {
        const h = history;
        h.attempt = clock();
        const flight = archive.refresh(h, e.identity, e.quote, interval).finally(() => { h.flight = null; historyFlights.delete(flight); });
        h.flight = flight; historyFlights.add(flight);
      }
      if (!history?.closed.size) await briefly(history?.flight);
      if (!e.quote || e.candles.get(interval) !== history) history = null;
    } else historyError = '尚未确认原生历史 K 线来源';
    const publicBook = streamBook(e), book = publicBook && (!e.book || publicBook.at >= e.book.at) ? publicBook : e.book;
    const bookFresh = book && freshAt(book.at), tickerFresh = freshAt(e.tickerAt);
    const currentBbo = tickerFresh && (!bookFresh || e.tickerAt > book.at);
    const fresh = (bookFresh && (book === publicBook || !e.error)) || tickerFresh, asOf = currentBbo ? e.tickerAt : book?.at ?? null;
    const unit = unitOf(e), tradingAvailable = !!e.quote && !e.tradingError;
    return { symbol, exchange: e.quote?.exchange ?? symbol.split('_')[0].toLowerCase(), base: e.quote?.base ?? symbol.split('_')[2], quoteCurrency: e.quote?.quoteCurrency ?? symbol.split('_').at(-1),
      status: fresh ? 'live' : book ? 'stale' : 'unavailable', asOf, error: fresh ? null : e.error ?? '等待公开盘口',
      tradingAvailable, tradingReason: tradingAvailable ? null : `暂不可交易：${e.tradingError || '正在确认原生合约身份和数量单位'}`,
      ticker: { lastPrice: null, change24h: null, volume24h: null, ...(tickerFresh ? e.ticker : {}),
        bidPrice: currentBbo ? e.ticker.bidPrice : book?.bids[0]?.[0] ?? null, askPrice: currentBbo ? e.ticker.askPrice : book?.asks[0]?.[0] ?? null,
        markPrice: e.mark && freshAt(e.mark.at) ? e.mark.price : null, markPriceAt: e.mark && freshAt(e.mark.at) ? e.mark.at : null,
        ...(e.funding && freshAt(e.funding.at, 60000) && e.funding.nextFundingAt > clock() ? { fundingRate: e.funding.fundingRate, nextFundingAt: e.funding.nextFundingAt } : { fundingRate: null, nextFundingAt: null }) },
      book, candles: history ? archive.data(history, interval) : [], candleError: historyError ?? history?.error ?? null, candleAsOf: history?.asOf ?? null,
      trades: e.trades.filter(t => clock() - t.at < 300000).map(t => ({ ...t, quantity: unit ? D(t.quantity).times(unit).toString() : t.quantity, quantityUnit: unit ? 'base' : 'contracts' })), interval };
  }
  return { read, async stop() { stopped = true; clearInterval(sweep); for (const e of entries.values()) release(e); publicFeed.close(); await Promise.allSettled([...historyFlights, ...[...entries.values()].flatMap(e => [e.displayFlight, e.flight])]); entries.clear(); } };
}
