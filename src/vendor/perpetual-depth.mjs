// 复制自 project-aggregation 工作台 modules/monitor/server/perpetual-depth.mjs（提交 c84ba27）：按需读一次公开盘口，估算
// 按金额开仓的成交价差（depth）与按持仓平仓的收益（exit），以及现货汇率（fx）。与原文件不同的地方：
// - lib 改从同目录的副本导入（src/vendor/perpetual-{fx,fees,exit}.ts）；
// - 原文件用 ws 包的 PerpetualWebSocket（perpetual-socket.mjs，自带 https-proxy-agent），本服务不带 ws 依赖，改用下面的
//   NodeWebSocket：复用本仓库的 ws 兼容适配（crossex/node-ws.mjs，消息同 ws 以 Buffer 交付，文本帧与二进制帧都能
//   String() 解码），选项取原文件的 maxPayload 8 MB 与握手 20 秒。Node 的 WebSocket 与 fetch 一样走全局 dispatcher，
//   设了 NODE_USE_ENV_PROXY=1 与 HTTPS_PROXY（README）时同样经过代理。
// - AbortSignal.any 改用 ../any-signal.mjs（Node 24.15 下与长期信号组合会泄漏内存）。
import { quoteCurrencyFx } from './perpetual-fx.ts';
import { createPerpetualEstimates, positive, failure, validTime } from './perpetual-estimates.mjs';
import { anySignal } from '../any-signal.mjs';
export { estimateDepthPair, estimateExitPair } from './perpetual-estimates.mjs';
import { perpetualContractIdentity } from './perpetual-exit.ts';
import WsCompatibleSocket from './crossex/node-ws.mjs';

/** The workbench PerpetualWebSocket's limits on the ws-compatible adapter over Node's WebSocket. */
export class NodeWebSocket extends WsCompatibleSocket {
  constructor(url) { super(url, { maxPayload: 8 * 1024 * 1024, handshakeTimeout: 20_000 }); }
}

// One-shot public depth inspection only: no full-market subscriptions or history.
// Official formats verified 2026-09-21:
// https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Order-Book
// https://bybit-exchange.github.io/docs/v5/market/orderbook
// https://www.okx.com/docs-v5/en/#order-book-trading-market-data-get-order-book
// https://www.bitget.com/docs/catalog/classic-contract-market
// https://www.gate.com/docs/developers/apiv4/en/futures/
// https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint#l2-book-snapshot
// https://apidocs.lighter.xyz/docs/websocket-reference
// https://apidocs.rh.lighter.xyz/docs/websocket
// https://asterdex.github.io/aster-api-website/futures/market-data/#order-book
// https://docs.kraken.com/exchange/api-reference/futures-websocket/book
// https://docs.kraken.com/api-reference/market-data/get-order-book
const LEVELS = 50;

/** Shared bounded budget for depth, metadata and FX. Errors never grow a queue. */
export function createInspectionBudget({ clock = Date.now, spacingMs = 500, maxPerMinute = 60, concurrency = 2, maxQueue = 12 } = {}) {
  const queue = [], starts = []; let running = 0, lastStart = -Infinity, timer = null, stopped = false, blockedUntil = 0;
  function pump() {
    if (stopped || timer || running >= concurrency || !queue.length) return;
    const now = clock();
    while (starts.length && starts[0] <= now - 60_000) starts.shift();
    if (now < blockedUntil || starts.length >= maxPerMinute) {
      for (const item of queue.splice(0)) item.reject(failure('盘口查询已达限额，请稍后重试', 429));
      return;
    }
    const delay = Math.max(0, lastStart + spacingMs - now);
    if (delay) { timer = setTimeout(() => { timer = null; pump(); }, delay); return; }
    const item = queue.shift(); starts.push(now); lastStart = now; running++;
    Promise.resolve().then(item.task).then(item.resolve, item.reject).finally(() => { running--; pump(); });
    pump();
  }
  return {
    run(task) {
      if (stopped) return Promise.reject(failure('盘口服务已停止', 503));
      if (queue.length >= maxQueue) return Promise.reject(failure('盘口查询繁忙，请稍后重试', 429));
      return new Promise((resolve, reject) => { queue.push({ task, resolve, reject }); pump(); });
    },
    backoff(ms = 30_000) { blockedUntil = Math.max(blockedUntil, clock() + Math.min(300_000, Math.max(1_000, ms))); },
    metrics: () => ({ inFlight: running, queued: queue.length, recentRequests: starts.length, blockedUntil }),
    stop() { stopped = true; clearTimeout(timer); timer = null; for (const item of queue.splice(0)) item.reject(failure('盘口服务已停止', 503)); },
  };
}

export function normalizeDepthLevels(rows, { multiplier = 1, contractSize = 1, side = 'asks', limit = LEVELS } = {}) {
  if (!Array.isArray(rows) || !positive(multiplier) || !positive(contractSize)) throw failure('盘口数量或合约单位缺失');
  const levels = new Map();
  // Guard untrusted upstream payloads and aggregate repeated order prices.
  for (const row of rows.slice(0, 250)) {
    if (!row || typeof row !== 'object') continue;
    const rawPrice = positive(Array.isArray(row) ? row[0] : row.p ?? row.px ?? row.price);
    const rawSize = positive(Array.isArray(row) ? row[1] : row.s ?? row.sz ?? row.size ?? row.remaining_base_amount);
    if (!rawPrice || !rawSize) continue;
    const price = rawPrice / multiplier, size = rawSize * contractSize * multiplier;
    if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || size <= 0) continue;
    levels.set(price, (levels.get(price) ?? 0) + size);
  }
  return [...levels].sort((a, b) => side === 'asks' ? a[0] - b[0] : b[0] - a[0]).slice(0, limit);
}

export function createPerpetualExecutionService({ getQuote, getMarket = () => null, fetchImpl = fetch, clock = Date.now, WebSocketImpl = NodeWebSocket, budget: suppliedBudget, maxMarkets = 10, cacheMs = 5_000 } = {}) {
  const budget = suppliedBudget ?? createInspectionBudget({ clock });
  const books = new Map(), metadata = new Map(), controller = new AbortController();
  let fxSnapshot = null, fxFlight = null, fxAttemptAt = -Infinity;
  async function json(url, body) {
    return budget.run(async () => {
      const response = await fetchImpl(url, { signal: anySignal([controller.signal], 8_000), headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
      if (!response.ok) {
        if ([418, 429].includes(response.status)) budget.backoff((positive(response.headers?.get?.('retry-after')) ?? 30) * 1_000);
        throw failure(`公开接口 HTTP ${response.status}`, 502);
      }
      const data = await response.json();
      const code = data?.retCode ?? data?.code;
      if (code !== undefined && !['0', '00000', '200'].includes(String(code))) {
        if (['429', '10006', '50011', '-1003'].includes(String(code))) budget.backoff();
        throw failure(`公开接口返回错误 ${String(code).slice(0, 25)}`, 502);
      }
      return data;
    });
  }
  async function contractSize(quote) {
    if (!['gate', 'okx'].includes(quote.exchange)) return 1;
    const key = `${quote.exchange}:${quote.symbol}`, cached = metadata.get(key);
    const identity = perpetualContractIdentity(quote);
    if (cached && cached.identity === identity && clock() - cached.at < 300_000) return cached.value;
    let value;
    if (quote.exchange === 'gate') {
      const row = await json(`https://api.gateio.ws/api/v4/futures/usdt/contracts/${encodeURIComponent(quote.symbol)}`);
      if (row.name !== quote.symbol || row.type !== 'direct') throw failure('Gate 合约数量单位未确认');
      value = positive(row.quanto_multiplier);
    } else {
      const data = await json(`https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId=${encodeURIComponent(quote.symbol)}`);
      const row = data.data?.find(row => row.instId === quote.symbol);
      if (!row || row.ctType !== 'linear' || row.ctValCcy !== quote.symbol.split('-')[0]) throw failure('OKX 合约数量单位未确认');
      value = positive(row.ctVal); // Official linear size × ctVal, quoted in ctValCcy.
      if (row.ctMult && Number(row.ctMult) !== 1) throw failure('OKX 非标准 ctMult 暂不支持盘口金额估算');
    }
    if (!value) throw failure('合约数量乘数缺失');
    if (metadata.size >= maxMarkets && !metadata.has(key)) metadata.delete(metadata.keys().next().value);
    metadata.set(key, { value, identity, at: clock() }); return value;
  }
  function lighterSnapshot(quote, market) {
    if (!Number.isInteger(market?.marketId)) return Promise.reject(failure('合约目录缺少 Lighter market_id'));
    const host = quote.exchange === 'lighter' ? 'mainnet.zklighter.elliot.ai' : 'api.rh.lighter.xyz';
    return budget.run(() => new Promise((resolve, reject) => {
      const socket = new WebSocketImpl(`wss://${host}/stream?readonly=true`);
      let done = false;
      const finish = (error, data) => {
        if (done) return; done = true; clearTimeout(timer); controller.signal.removeEventListener('abort', aborted);
        socket.terminate(); if (error) reject(error); else resolve({ data, source: `https://${host}`, transport: 'ws' });
      };
      const aborted = () => finish(failure('盘口查询已取消', 503));
      const timer = setTimeout(() => finish(failure('盘口快照连接超时', 502)), 8_000);
      controller.signal.addEventListener('abort', aborted, { once: true });
      socket.on('open', () => socket.send(JSON.stringify({ type: 'subscribe', channel: `order_book/${market.marketId}` })));
      socket.on('error', () => finish(failure('盘口快照连接失败', 502)));
      socket.on('close', () => finish(failure('盘口快照连接关闭', 502)));
      socket.on('message', raw => {
        let data; try { data = JSON.parse(String(raw)); } catch { return; }
        if (data.type === 'ping') { socket.send(JSON.stringify({ type: 'pong' })); return; }
        // Delta frames are never treated as a full order book.
        if (data.channel === `order_book:${market.marketId}` && data.type === 'subscribed/order_book') finish(null, data);
      });
    }));
  }
  function krakenIdentity(quote, market) {
    if (!market || market.exchange !== 'kraken' || market.symbol !== quote.symbol || market.base !== quote.base
      || market.quoteCurrency !== 'USD' || quote.quoteCurrency !== 'USD' || market.collateralCurrency !== 'MULTI'
      || market.settlementCurrency !== 'USD' || market.contractKind !== 'linear' || market.multiplier !== 1
      || market.identityVerified !== true || market.comparable === false
      || perpetualContractIdentity(quote) !== perpetualContractIdentity(market)) throw failure('Kraken 当前合约目录身份或数量单位未确认');
    return JSON.stringify([perpetualContractIdentity(market), market.contractKind, market.settlementCurrency, market.identityVerified]);
  }
  function krakenSnapshot(quote, market) {
    const identity = krakenIdentity(quote, market);
    return budget.run(() => new Promise((resolve, reject) => {
      if (controller.signal.aborted) { reject(failure('盘口查询已取消', 503)); return; }
      const socket = new WebSocketImpl('wss://futures.kraken.com/ws/v1');
      let done = false;
      const finish = (error, data) => {
        if (done) return; done = true; clearTimeout(timer); controller.signal.removeEventListener('abort', aborted);
        socket.terminate();
        if (!error) {
          try { if (identity !== krakenIdentity(quote, getMarket(quote.exchange, quote.symbol))) error = failure('Kraken 查询期间合约身份或数量单位已变化'); }
          catch (cause) { error = cause; }
        }
        if (error) reject(error); else resolve({ data, source: 'https://futures.kraken.com', transport: 'ws' });
      };
      const aborted = () => finish(failure('盘口查询已取消', 503));
      const timer = setTimeout(() => finish(failure('Kraken 盘口快照连接超时', 502)), 8_000);
      controller.signal.addEventListener('abort', aborted, { once: true });
      socket.on('open', () => socket.send(JSON.stringify({ event: 'subscribe', feed: 'book', product_ids: [quote.symbol] })));
      socket.on('error', () => finish(failure('Kraken 盘口快照连接失败', 502)));
      socket.on('close', () => finish(failure('Kraken 盘口快照连接关闭', 502)));
      socket.on('message', raw => {
        let data; try { data = JSON.parse(String(raw)); } catch { return; }
        if (['error', 'subscribed_failed', 'unsubscribed_failed'].includes(data.event)) { finish(failure('Kraken 盘口订阅失败', 502)); return; }
        if (data.feed !== 'book_snapshot') return; // Never treat a delta as a complete book.
        if (data.product_id !== quote.symbol) { finish(failure('Kraken 返回合约与请求不一致', 502)); return; }
        finish(null, data);
      });
    }));
  }
  async function loadBook(quote, market) {
    const { exchange, symbol } = quote, symbolParam = encodeURIComponent(symbol);
    let data, source, sourceTime, bids, asks, transport = 'rest';
    const unit = await contractSize(quote);
    if (['binance', 'aster'].includes(exchange)) {
      source = `https://fapi.${exchange === 'binance' ? 'binance.com' : 'asterdex.com'}/fapi/v1/depth?symbol=${symbolParam}&limit=${LEVELS}`;
      data = await json(source); ({ bids, asks } = data); sourceTime = data.E;
    } else if (exchange === 'bybit') {
      source = `https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${symbolParam}&limit=${LEVELS}`;
      data = (await json(source)).result;
      if (data?.s !== symbol) throw failure('Bybit 返回合约与请求不一致');
      bids = data.b; asks = data.a; sourceTime = data.ts;
    } else if (exchange === 'okx') {
      source = `https://www.okx.com/api/v5/market/books?instId=${symbolParam}&sz=${LEVELS}`;
      data = (await json(source)).data?.[0]; bids = data?.bids; asks = data?.asks; sourceTime = data?.ts;
    } else if (exchange === 'bitget') {
      if (!['USDT', 'USDC'].includes(quote.quoteCurrency)) throw failure('Bitget 该计价币盘口暂未接入');
      source = `https://api.bitget.com/api/v2/mix/market/merge-depth?symbol=${symbolParam}&productType=${quote.quoteCurrency}-FUTURES&limit=${LEVELS}&precision=scale0`;
      data = (await json(source)).data; bids = data?.bids; asks = data?.asks; sourceTime = data?.ts;
    } else if (exchange === 'gate') {
      source = `https://api.gateio.ws/api/v4/futures/usdt/order_book?contract=${symbolParam}&limit=${LEVELS}`;
      data = await json(source); ({ bids, asks } = data); sourceTime = Number(data.current) * 1_000;
    } else if (exchange === 'kraken') {
      const result = await krakenSnapshot(quote, market); ({ data, source, transport } = result);
      bids = Array.isArray(data.bids) ? data.bids.slice(0, 250).map(row => [row.price, row.qty]) : null;
      asks = Array.isArray(data.asks) ? data.asks.slice(0, 250).map(row => [row.price, row.qty]) : null;
      sourceTime = data.timestamp;
    } else if (['hyperliquid', 'entropy'].includes(exchange)) {
      source = 'https://api.hyperliquid.xyz/info'; data = await json(source, { type: 'l2Book', coin: symbol });
      if (data.coin !== symbol) throw failure('Hyperliquid 返回合约与请求不一致');
      [bids, asks] = data.levels ?? []; sourceTime = data.time;
    } else if (['lighter', 'rh-lighter'].includes(exchange)) {
      const result = await lighterSnapshot(quote, market); ({ data, source, transport } = result);
      bids = data.order_book?.bids; asks = data.order_book?.asks; sourceTime = data.timestamp;
    } else throw failure('该交易所的盘口暂未接入');
    const receivedAt = clock();
    return { exchange, symbol, base: quote.base, quoteCurrency: quote.quoteCurrency, source, sourceTime: validTime(sourceTime, receivedAt), receivedAt, transport,
      bids: normalizeDepthLevels(bids, { multiplier: positive(market?.multiplier ?? quote.multiplier) ?? 1, contractSize: unit, side: 'bids' }),
      asks: normalizeDepthLevels(asks, { multiplier: positive(market?.multiplier ?? quote.multiplier) ?? 1, contractSize: unit, side: 'asks' }) };
  }
  function book(quote) {
    const key = `${quote.exchange}:${quote.symbol}`, cached = books.get(key), now = clock(), market = getMarket(quote.exchange, quote.symbol);
    const identity = JSON.stringify([perpetualContractIdentity(quote), market?.marketId ?? null, market?.multiplier ?? quote.multiplier ?? 1,
      ...(quote.exchange === 'kraken' ? [market ? perpetualContractIdentity(market) : null, market?.contractKind, market?.settlementCurrency, market?.identityVerified, market?.comparable] : [])]);
    if (cached?.identity === identity && cached.flight) return cached.flight;
    if (cached?.identity === identity && cached.value && now - cached.at < (cached.value.reason ? 10_000 : cacheMs)) return Promise.resolve(cached.value);
    // Active market leases prevent many browsers cycling through the whole market.
    for (const [id, item] of books) if (!item.flight && now - item.at > 30_000) books.delete(id);
    if (!books.has(key) && books.size >= maxMarkets) return Promise.resolve({ reason: '全站最多同时校验 10 个合约，请 30 秒后重试' });
    const entry = { at: now, identity, value: null, flight: null };
    entry.flight = loadBook(quote, market).catch(error => ({ reason: error.message })).then(value => { entry.value = value; entry.at = clock(); entry.flight = null; return value; });
    books.set(key, entry); return entry.flight;
  }
  async function fx() {
    if (fxFlight) return fxFlight;
    if (fxSnapshot && clock() - fxAttemptAt < 60_000) return fxSnapshot;
    fxAttemptAt = clock();
    fxFlight = (async () => {
      const rates = { USDT: { bid: 1, ask: 1, at: clock(), source: 'USDT 计价基准' } }, reasons = {};
      await Promise.all(['USDC', 'USD1', 'USDG', 'USD'].map(async currency => {
        const previous = quoteCurrencyFx(currency, fxSnapshot, clock());
        if (previous) rates[currency] = previous;
        const source = currency === 'USD' ? 'https://api.kraken.com/0/public/Depth?pair=USDTUSD&count=1'
          : `https://api.gateio.ws/api/v4/spot/order_book?currency_pair=${currency}_USDT&limit=1`;
        try {
          const data = await json(source);
          let bid, ask, at;
          if (currency === 'USD') {
            const keys = data.result && typeof data.result === 'object' && !Array.isArray(data.result) ? Object.keys(data.result) : [];
            if (!Array.isArray(data.error) || data.error.length || keys.length !== 1 || keys[0] !== 'USDTZUSD') throw failure('USD 汇率交易对或响应无效');
            const spot = data.result.USDTZUSD, rawBid = positive(spot.bids?.[0]?.[0]), rawAsk = positive(spot.asks?.[0]?.[0]);
            const bidAt = validTime(Number(spot.bids?.[0]?.[2]) * 1000, clock()), askAt = validTime(Number(spot.asks?.[0]?.[2]) * 1000, clock());
            if (!rawBid || !rawAsk || rawBid > rawAsk || !bidAt || !askAt || !positive(spot.bids?.[0]?.[1]) || !positive(spot.asks?.[0]?.[1])) throw failure('USD 汇率盘口缺失或过期');
            // Spot is USD per USDT; invert AND swap sides to express USDT per USD.
            bid = 1 / rawAsk; ask = 1 / rawBid; at = Math.min(bidAt, askAt);
          } else {
            bid = positive(data.bids?.[0]?.[0]); ask = positive(data.asks?.[0]?.[0]);
            at = validTime(data.update, clock()); // `current` is response time, not a new order-book version.
            if (!positive(data.bids?.[0]?.[1]) || !positive(data.asks?.[0]?.[1])) throw failure('汇率盘口缺失或过期');
          }
          if (!bid || !ask || !Number.isFinite(bid) || !Number.isFinite(ask) || bid > ask || !at || clock() - at > 180_000) throw failure('汇率盘口缺失或过期');
          if (previous && at < previous.at) throw failure('汇率盘口时间回退');
          rates[currency] = { bid, ask, at, source };
        } catch (error) {
          // Retain last valid exchange timestamp across temporary errors; never
          // rejuvenate old FX with the latest batch or local receipt time.
          if (!quoteCurrencyFx(currency, { baseCurrency: 'USDT', staleAfterMs: 180_000, rates }, clock())) delete rates[currency];
          reasons[currency] = previous ? `更新失败，沿用上次有效汇率：${error.message}` : error.message;
        }
      }));
      fxSnapshot = { baseCurrency: 'USDT', generatedAt: clock(), staleAfterMs: 180_000, rates, reasons }; return fxSnapshot;
    })().finally(() => { fxFlight = null; });
    return fxFlight;
  }
  const booksFor = legs => Promise.all(legs.map(book));
  return {
    ...createPerpetualEstimates({ getQuote, books: booksFor, fx, clock }),
    peekFx: () => fxSnapshot,
    async books(keys) {
      function current() {
        return keys.map(key => {
          const quote = getQuote(key.exchange, key.symbol);
          if (!quote || quote.comparable === false || !quote.historyIdentity || quote.historyIdentity !== key.identity) throw failure('查询期间合约身份或数量单位已变化，请重新确认', 409);
          return quote;
        });
      }
      const result = await booksFor(current());
      current();
      return result;
    },
    metrics: () => ({ ...budget.metrics(), cachedMarkets: books.size, maxMarkets, metadataMarkets: metadata.size, fxAt: fxSnapshot?.generatedAt ?? null }),
    stop() { controller.abort(); if (!suppliedBudget) budget.stop(); books.clear(); metadata.clear(); },
  };
}
