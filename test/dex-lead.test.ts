// DEX 价差子模块「Binance & 多参考源领先测速」测试：
// 覆盖 6 公开目录解析与美股识别、7 个领先参考源 + 3 个 DEX 目标低延迟 WS 流、多源常驻滑窗与稀疏网格断线哨兵、
// 独立数据库 lead.sqlite 事务/清理/损坏降级、真实只读 Worker 离线分析、与 DEX 服务路由/引擎生命周期集成。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { localDexForward, openVarLighter, varLighterViews } from '../src/dex/host.ts';
import {
  BinanceBookTickerStream,
  BinanceEquityQuoteStream,
  BybitOrderBookTopStream,
  CoinbaseTickerStream,
  ENTROPY_CONFIRM_MS,
  EntropyBboStream,
  HyperliquidBboStream,
  LighterOrderBookTopStream,
  OkxBboStream,
  createLeadTester,
} from '../src/varlighter/lead-streams.ts';
import {
  DEFAULT_LEAD_WATCHER_PARAMS,
  LEAD_GRID_STEP_MS,
  LEAD_MAX_WATCHERS,
  LEAD_RETENTION_DAYS,
  LeadError,
  LeadTracker,
  buildLeadCandidates,
  parseBinanceExchangeInfo,
  parseBinanceSpotTickers,
  parseBybitLinearCatalog,
  parseCoinbaseSpotCatalog,
  parseHyperliquidXyzCatalog,
  parseOkxSwapCatalog,
  readLeadAnalyzeRequest,
  readLeadWatcherConfig,
  readLeadWatcherMutation,
  type PersistLeadEvent,
  type PersistLeadGrid,
} from '../src/varlighter/lead.ts';
import { LEAD_DB_FILE, openLeadStore } from '../src/varlighter/lead-store.ts';
import { analyzeLeadDatabase } from '../src/varlighter/lead-worker.ts';
import { BOOK_KEEP_LEVELS, type SocketLike } from '../src/varlighter/feeds.ts';
import type { MarketSpec } from '../src/varlighter/model.ts';
import { ParamsError } from '../src/varlighter/strategy.ts';
import type { LeadAnalyzeView, LeadView } from '../src/varlighter/views.ts';

const spec = (venue: MarketSpec['venue'], symbol: string, id = 1, extra: Partial<MarketSpec> = {}): MarketSpec => ({
  venue,
  symbol,
  name: symbol,
  id,
  mark: 100,
  index: null,
  fundingHourly: null,
  sizeDecimals: 2,
  priceDecimals: 2,
  minBase: 0.1,
  minQuote: 10,
  takerFeeBps: 0,
  ...extra,
});

class MockSocket implements SocketLike {
  readonly url: string;
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sent: string[] = [];
  closed = false;

  constructor(url = 'wss://mock') {
    this.url = url;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  push(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
  pushRaw(text: string): void {
    this.onmessage?.({ data: text });
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({});
  }
}

test('6 个参考源公开目录解析、美股自动补全 Binance Equity 与多源候选构建', () => {
  const perp = parseBinanceExchangeInfo({
    symbols: [
      { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', marginAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING' },
      { symbol: 'NVDAUSDT', baseAsset: 'NVDA', quoteAsset: 'USDT', marginAsset: 'USDT', contractType: 'TRADIFI_PERPETUAL', status: 'TRADING' },
      { symbol: 'ANTUSDT', baseAsset: 'ANT', quoteAsset: 'USDT', marginAsset: 'USDT', contractType: 'TRADIFI_PERPETUAL', status: 'TRADING' },
      { symbol: '1000PEPEUSDT', baseAsset: '1000PEPE', quoteAsset: 'USDT', marginAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING' },
      { symbol: 'OLDUSDT', baseAsset: 'OLD', quoteAsset: 'USDT', marginAsset: 'USDT', contractType: 'PERPETUAL', status: 'SETTLING' },
      { symbol: 'BTCBUSD', baseAsset: 'BTC', quoteAsset: 'BUSD', marginAsset: 'BUSD', contractType: 'PERPETUAL', status: 'TRADING' },
    ],
  });
  assert.deepEqual(perp.map(c => c.symbol), ['1000PEPEUSDT', 'ANTUSDT', 'BTCUSDT', 'NVDAUSDT']);
  assert.throws(() => parseBinanceExchangeInfo({}), /Binance 合约目录格式无效/);

  const spot = parseBinanceSpotTickers([
    { symbol: 'BTCUSDT', bidPrice: '98000', askPrice: '98005' },
    { symbol: 'ETHUSDC', bidPrice: '3500', askPrice: '3501' },
    { symbol: 'DEADUSDT', bidPrice: '0', askPrice: '0' },
    { symbol: 'BTCBNB', bidPrice: '150', askPrice: '151' },
  ]);
  assert.deepEqual(spot.map(c => c.symbol), ['BTCUSDT', 'ETHUSDC']);
  assert.throws(() => parseBinanceSpotTickers({}), /Binance 现货目录格式无效/);

  const hlXyz = parseHyperliquidXyzCatalog([
    {
      universe: [
        { name: 'xyz:NVDA' },
        { name: 'AAPL' },
        { name: 'xyz:DELIST', isDelisted: true },
      ],
    },
  ]);
  assert.deepEqual(hlXyz.map(c => c.symbol), ['xyz:AAPL', 'xyz:NVDA']);
  assert.throws(() => parseHyperliquidXyzCatalog([]), /Hyperliquid xyz 目录格式无效/);

  const okx = parseOkxSwapCatalog({
    data: [
      { instType: 'SWAP', state: 'live', settleCcy: 'USDT', instId: 'BTC-USDT-SWAP' },
      { instType: 'SWAP', state: 'live', settleCcy: 'USDT', instId: 'NVDA-USDT-SWAP' },
      { instType: 'SWAP', state: 'suspend', settleCcy: 'USDT', instId: 'OLD-USDT-SWAP' },
      { instType: 'SWAP', state: 'live', settleCcy: 'BTC', instId: 'BTC-USD-SWAP' },
    ],
  });
  assert.deepEqual(okx.map(c => c.symbol), ['BTC-USDT-SWAP', 'NVDA-USDT-SWAP']);
  assert.throws(() => parseOkxSwapCatalog({}), /OKX 永续目录格式无效/);

  const bybit = parseBybitLinearCatalog({
    result: {
      list: [
        { symbol: 'BTCUSDT', baseCoin: 'BTC', quoteCoin: 'USDT', contractType: 'LinearPerpetual', status: 'Trading' },
        { symbol: 'ETHUSDC', baseCoin: 'ETH', quoteCoin: 'USDC', contractType: 'LinearPerpetual', status: 'Trading' },
        { symbol: 'BTCUSD', baseCoin: 'BTC', quoteCoin: 'USD', contractType: 'InversePerpetual', status: 'Trading' },
      ],
    },
  });
  assert.deepEqual(bybit.map(c => c.symbol), ['BTCUSDT', 'ETHUSDC']);
  assert.throws(() => parseBybitLinearCatalog({}), /Bybit 永续目录格式无效/);

  const cb = parseCoinbaseSpotCatalog([
    { id: 'BTC-USD', base_currency: 'BTC', quote_currency: 'USD', status: 'online' },
    { id: 'BTC-USDC', base_currency: 'BTC', quote_currency: 'USDC', status: 'online' },
    { id: 'OFF-USD', base_currency: 'OFF', quote_currency: 'USD', status: 'delisted' },
    { id: 'DIS-USD', base_currency: 'DIS', quote_currency: 'USD', status: 'online', trading_disabled: true },
  ]);
  assert.deepEqual(cb.map(c => c.symbol), ['BTC-USD']);
  assert.throws(() => parseCoinbaseSpotCatalog(null), /Coinbase 现货目录格式无效/);

  const dex = {
    lighter: [spec('lighter', 'BTC', 1), spec('lighter', 'NVDA', 110), spec('lighter', 'ANTHROPIC', 50), spec('lighter', 'PEPE', 77)],
    rh: [spec('rh', 'NVDA', 3), spec('rh', 'ANTHROPIC', 8)],
    entropy: [spec('entropy', 'NVDA', 2, { coin: 'io:NVDA' }), spec('entropy', 'ANTH', 9, { coin: 'io:ANTH' })],
  };
  const candidates = buildLeadCandidates({
    binance_perp: perp,
    binance_spot: spot,
    binance_equity: [],
    hl_xyz: hlXyz,
    coinbase_spot: cb,
    okx_perp: okx,
    bybit_perp: bybit,
  }, dex);

  const nvda = candidates.find(c => c.symbol === 'NVDA')!;
  assert.equal(nvda.kind, 'us_equity');
  assert.equal(nvda.leads.binance_equity, 'NVDA', '美股应自动补全 Binance 股票 @quote 通道');
  assert.equal(nvda.leads.binance_perp, 'NVDAUSDT');
  assert.equal(nvda.leads.hl_xyz, 'xyz:NVDA');
  assert.equal(nvda.leads.okx_perp, 'NVDA-USDT-SWAP');
  assert.deepEqual(nvda.targets, { lighter: 'NVDA', rh: 'NVDA', entropy: 'NVDA' });

  const btc = candidates.find(c => c.symbol === 'BTC')!;
  assert.equal(btc.kind, 'crypto');
  assert.equal(btc.leads.binance_equity, undefined, '非美股不应配对 Binance 股票流');
  assert.equal(btc.leads.coinbase_spot, 'BTC-USD');
  assert.equal(btc.leads.bybit_perp, 'BTCUSDT');

  const anth = candidates.find(c => c.symbol === 'ANTHROPIC')!;
  assert.equal(anth.leads.binance_perp, 'ANTUSDT');
  assert.equal(candidates.filter(c => c.targets.lighter === 'PEPE').length, 1, 'PEPE 与 1000PEPEUSDT 不应生成重复候选');
  assert.equal(candidates[0]!.targetCount, 3);

  // 跨 DEX 分别挂牌 1000PEPE 与 PEPE 时，同样应归并去重为单条候选
  const crossDex = buildLeadCandidates({
    binance_perp: perp,
    binance_spot: [],
    binance_equity: [],
    hl_xyz: [],
    coinbase_spot: [],
    okx_perp: [],
    bybit_perp: [],
  }, {
    lighter: [spec('lighter', '1000PEPE', 77)],
    rh: [spec('rh', 'PEPE', 78)],
    entropy: [],
  });
  assert.equal(crossDex.length, 1, '跨所 1000PEPE 与 PEPE 不应生成两条重复候选');
  assert.deepEqual(crossDex[0]!.targets, { lighter: '1000PEPE', rh: 'PEPE' });
  assert.equal(crossDex[0]!.kind, 'crypto');
});

test('参数校验：readLeadWatcherConfig / readLeadAnalyzeRequest / readLeadWatcherMutation 边界', () => {
  const valid = readLeadWatcherConfig({
    symbol: ' nvda ',
    leads: { binance_perp: ' nvdausdt ', hl_xyz: ' xyz:NVDA ', binance_equity: ' nvda ' },
    targets: { lighter: 'NVDA', rh: '', entropy: undefined },
  });
  assert.deepEqual(valid, {
    ...DEFAULT_LEAD_WATCHER_PARAMS,
    symbol: 'NVDA',
    leads: { binance_perp: 'NVDAUSDT', hl_xyz: 'xyz:NVDA', binance_equity: 'NVDA' },
    targets: { lighter: 'NVDA' },
  });

  const badConfigs = [
    null,
    { symbol: 'NVDA', leads: { binance_perp: 'NVDAUSDT' }, targets: { lighter: 'NVDA' }, extra: 1 },
    { symbol: '', leads: { binance_perp: 'NVDAUSDT' }, targets: { lighter: 'NVDA' } },
    { symbol: 'NVDA', leads: {}, targets: { lighter: 'NVDA' } },
    { symbol: 'NVDA', leads: { unknown: 'NVDA' }, targets: { lighter: 'NVDA' } },
    { symbol: 'NVDA', leads: { binance_perp: 'NVDAUSDT' }, targets: {} },
    { symbol: 'NVDA', leads: { binance_perp: 'NVDAUSDT' }, targets: { lighter: 'bad symbol' } },
    { symbol: 'NVDA', leads: { binance_perp: 'NVDAUSDT' }, targets: { lighter: 'NVDA' }, thresholdBps: 0.1 },
    { symbol: 'NVDA', leads: { binance_perp: 'NVDAUSDT' }, targets: { lighter: 'NVDA' }, impulseWindowMs: 50 },
    { symbol: 'NVDA', leads: { binance_perp: 'NVDAUSDT' }, targets: { lighter: 'NVDA' }, followRatio: 1.5 },
    { symbol: 'NVDA', leads: { binance_perp: 'NVDAUSDT' }, targets: { lighter: 'NVDA' }, maxWaitMs: 500 },
    { symbol: 'NVDA', leads: { binance_perp: 'NVDAUSDT' }, targets: { lighter: 'NVDA' }, cooldownMs: 100 },
  ];
  for (const raw of badConfigs) assert.throws(() => readLeadWatcherConfig(raw), e => e instanceof ParamsError);

  const nowMs = 1_700_000_000_000;
  const aq = readLeadAnalyzeRequest({ symbol: 'nvda', leadSource: 'hl_xyz', hours: 24 }, nowMs);
  assert.deepEqual(aq, { symbol: 'NVDA', leadSource: 'hl_xyz', from: nowMs - 24 * 3_600_000, to: nowMs });
  assert.throws(() => readLeadAnalyzeRequest({ symbol: 'NVDA', from: 1000, to: 10_000 }, nowMs), e => e instanceof ParamsError);
  assert.throws(() => readLeadAnalyzeRequest({ symbol: 'NVDA', from: 0, to: (LEAD_RETENTION_DAYS + 1) * 86_400_000 }, nowMs), e => e instanceof ParamsError);

  assert.deepEqual(readLeadWatcherMutation({ symbol: 'nvda', enabled: false, updatedAt: 123 }, true), { symbol: 'NVDA', enabled: false, updatedAt: 123 });
  assert.throws(() => readLeadWatcherMutation({ symbol: 'NVDA', updatedAt: -1 }, false), e => e instanceof ParamsError);
  assert.throws(() => readLeadWatcherMutation({ symbol: 'NVDA', updatedAt: 10 }, true), e => e instanceof ParamsError);
});

test('7 个领先源 + 3 个 DEX 目标低延迟 WS 流：协议解析、单边更新、保活与断线重试', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  try {
    let mono = 1_000;
    const sockets: MockSocket[] = [];
    const connect = (url: string) => {
      const s = new MockSocket(url);
      sockets.push(s);
      return s;
    };

    // 1. Binance Perp (含 e) 与 Binance Spot (无 e 字段)
    const spotTicks: [number, number][] = [];
    const perpTicks: [number, number][] = [];
    const perp = new BinanceBookTickerStream({
      symbol: 'BTCUSDT', mode: 'perp', connect, monoNow: () => mono,
      callbacks: { onStatus: () => {}, onTick: (b, a) => perpTicks.push([b, a]) },
    });
    const spot = new BinanceBookTickerStream({
      symbol: 'BTCUSDT', mode: 'spot', connect, monoNow: () => mono,
      callbacks: { onStatus: () => {}, onTick: (b, a) => spotTicks.push([b, a]) },
    });
    perp.start();
    spot.start();
    assert.ok(sockets[0]!.url.includes('fstream.binance.com'));
    assert.ok(sockets[1]!.url.includes('stream.binance.com'));
    sockets[0]!.open();
    sockets[1]!.open();
    sockets[0]!.push({ e: 'bookTicker', u: 1, s: 'BTCUSDT', b: '98000', B: '1', a: '98002', A: '1' });
    sockets[1]!.push({ u: 10, s: 'BTCUSDT', b: '98001', B: '2', a: '98003', A: '2' }); // Spot 无 e 字段
    assert.deepEqual(perpTicks, [[98000, 98002]]);
    assert.deepEqual(spotTicks, [[98001, 98003]]);
    perp.close();
    spot.close();

    // 2. Binance Equity @quote
    const eqTicks: [number, number][] = [];
    const eq = new BinanceEquityQuoteStream({
      symbol: 'NVDA', connect, monoNow: () => mono,
      callbacks: { onStatus: () => {}, onTick: (b, a) => eqTicks.push([b, a]) },
    });
    eq.start();
    const eqSock = sockets.at(-1)!;
    assert.ok(eqSock.url.includes('nbstream.binance.com/equity/ws'));
    eqSock.open();
    assert.ok(eqSock.sent.some(m => m.includes('NVDA@quote')));
    eqSock.push({ e: 'quote', s: 'NVDA', bp: '182.10', ap: '182.14', T: 1_700_000_000_000 });
    assert.deepEqual(eqTicks, [[182.1, 182.14]]);
    eq.close();

    // 3. Coinbase Ticker + Heartbeats
    const cbTicks: [number, number][] = [];
    const cb = new CoinbaseTickerStream({
      productId: 'BTC-USD', connect, monoNow: () => mono,
      callbacks: { onStatus: () => {}, onTick: (b, a) => cbTicks.push([b, a]) },
    });
    cb.start();
    const cbSock = sockets.at(-1)!;
    cbSock.open();
    assert.ok(cbSock.sent.some(m => m.includes('"channel":"ticker"')));
    assert.ok(cbSock.sent.some(m => m.includes('"channel":"heartbeats"')));
    cbSock.push({
      channel: 'ticker',
      timestamp: '2026-11-28T00:00:00Z',
      events: [{ tickers: [{ product_id: 'BTC-USD', best_bid: '98100.5', best_ask: '98101.5' }] }],
    });
    assert.deepEqual(cbTicks, [[98100.5, 98101.5]]);
    cb.close();

    // 4. OKX bbo-tbt + 文本 'ping'/'pong' 保活
    const okxTicks: [number, number][] = [];
    const okxErrs: (string | null)[] = [];
    const okx = new OkxBboStream({
      instId: 'BTC-USDT-SWAP', connect, monoNow: () => mono,
      callbacks: { onStatus: (_c, err) => okxErrs.push(err), onTick: (b, a) => okxTicks.push([b, a]) },
    });
    okx.start();
    const okxSock = sockets.at(-1)!;
    okxSock.open();
    assert.ok(okxSock.sent.some(m => m.includes('"channel":"bbo-tbt"')));
    okxSock.push({ arg: { channel: 'bbo-tbt', instId: 'BTC-USDT-SWAP' }, data: [{ bids: [['98050', '1']], asks: [['98051', '1']], ts: '1700000000100' }] });
    assert.deepEqual(okxTicks, [[98050, 98051]]);
    for (let i = 0; i < 22; i++) {
      mono += 1_000;
      t.mock.timers.tick(1_000);
    }
    assert.ok(okxSock.sent.includes('ping'), 'OKX 超过 20s 应发送文本 ping');
    okxSock.pushRaw('pong');
    assert.equal(okxErrs.at(-1), null, 'OKX 原生 pong 文本帧不应触发 JSON 解析报错');
    okx.close();

    // 5. Bybit orderbook.1：snapshot、单边 delta 更新与删档重置
    const bybitTicks: [number, number][] = [];
    const bybit = new BybitOrderBookTopStream({
      symbol: 'BTCUSDT', connect, monoNow: () => mono,
      callbacks: { onStatus: () => {}, onTick: (b, a) => bybitTicks.push([b, a]) },
    });
    bybit.start();
    const bybitSock = sockets.at(-1)!;
    bybitSock.open();
    bybitSock.push({ topic: 'orderbook.1.BTCUSDT', type: 'snapshot', ts: 1000, data: { b: [['98000', '1']], a: [['98002', '1']], u: 1 } });
    bybitSock.push({ topic: 'orderbook.1.BTCUSDT', type: 'delta', ts: 1050, data: { b: [['98001', '2']], a: [], u: 2 } });
    bybitSock.push({ topic: 'orderbook.1.BTCUSDT', type: 'delta', ts: 1100, data: { b: [['98001', '0']], a: [], u: 3 } }); // 删去当前买一后缺档，应等待新档而非沿用旧价
    bybitSock.push({ topic: 'orderbook.1.BTCUSDT', type: 'delta', ts: 1200, data: { b: [['97999', '3']], a: [['98001', '3']], u: 1 } }); // u===1 重置快照
    assert.deepEqual(bybitTicks, [[98000, 98002], [98001, 98002], [97999, 98001]]);
    bybit.close();

    // 6. HyperliquidBboStream / EntropyBboStream 兼容 + 45s l2Book 保活 + 倒挂 BBO 忽略
    assert.equal(EntropyBboStream, HyperliquidBboStream);
    let heartbeats = 0;
    const ent = new HyperliquidBboStream({
      coin: 'xyz:NVDA', connect, monoNow: () => mono,
      callbacks: { onStatus: () => {}, onTick: () => {}, onHeartbeat: () => { heartbeats++; } },
    });
    ent.start();
    const entSock = sockets.at(-1)!;
    entSock.open();
    entSock.push({ channel: 'post', data: { id: 1, response: { type: 'info', payload: { type: 'l2Book', data: { coin: 'xyz:NVDA', time: 10, levels: [[{ px: '100', sz: '1', n: 1 }], [{ px: '101', sz: '1', n: 1 }]] } } } } });
    const postsBefore = entSock.sent.filter(m => m.includes('"l2Book"')).length;
    entSock.push({ channel: 'bbo', data: { coin: 'xyz:NVDA', time: 15, bbo: [{ px: '105', sz: '1', n: 1 }, { px: '101', sz: '1', n: 1 }] } }); // 倒挂忽略
    for (let i = 0; i < Math.ceil(ENTROPY_CONFIRM_MS / 1_000) + 1; i++) {
      mono += 1_000;
      t.mock.timers.tick(1_000);
      if (i % 10 === 0) entSock.push({ channel: 'pong' });
    }
    assert.ok(entSock.sent.filter(m => m.includes('"l2Book"')).length > postsBefore);
    entSock.push({ channel: 'post', data: { id: 2, response: { type: 'info', payload: { type: 'l2Book', data: { coin: 'xyz:NVDA', time: 20, levels: [[{ px: '100', sz: '1', n: 1 }], [{ px: '101', sz: '1', n: 1 }]] } } } } });
    assert.equal(heartbeats, 1);
    ent.close();

    // 7. LighterOrderBookTopStream 超阈值裁盘变浅触发重订 & 死连接超时重连
    const lt = new LighterOrderBookTopStream({
      venue: 'lighter', marketId: 9, connect, monoNow: () => mono,
      callbacks: { onStatus: () => {}, onTick: () => {} },
    });
    lt.start();
    const ltSock = sockets.at(-1)!;
    ltSock.open();
    const manyBids = Array.from({ length: BOOK_KEEP_LEVELS + 1_005 }, (_, i) => ({ price: String(10_000 - i * 0.01), size: '1' }));
    ltSock.push({ type: 'subscribed/order_book', channel: 'order_book:9', order_book: { code: 0, nonce: 1, bids: manyBids, asks: [{ price: '10100', size: '1' }] } });
    mono += 10_000;
    ltSock.push({ type: 'update/order_book', channel: 'order_book:9', order_book: { begin_nonce: 1, nonce: 2, bids: manyBids.slice(0, 3_600).map(b => ({ price: b.price, size: '0' })), asks: [] } });
    assert.ok(ltSock.sent.some(m => m.includes('unsubscribe')));
    lt.close();

    const deadStatuses: [boolean, string | null, number][] = [];
    const dead = new BinanceBookTickerStream({
      symbol: 'BTCUSDT', connect, monoNow: () => mono,
      callbacks: { onStatus: (c, e, r) => deadStatuses.push([c, e, r]), onTick: () => {} },
    });
    dead.start();
    for (let i = 0; i < 22; i++) {
      mono += 1_000;
      t.mock.timers.tick(1_000);
    }
    assert.ok(deadStatuses.some(x => x[1] === '连接超时' && x[2] >= 1));
    dead.close();
  } finally {
    t.mock.timers.reset();
  }
});

test('LeadTracker：多源独立事件冷却、30m 滑动窗口淘汰、稀疏网格锚点与断线哨兵', () => {
  const wall0 = 1_700_000_000_000;
  const settled: PersistLeadEvent[] = [];
  const grids: PersistLeadGrid[] = [];
  const config = readLeadWatcherConfig({
    symbol: 'NVDA',
    leads: { binance_equity: 'NVDA', binance_perp: 'NVDAUSDT' },
    targets: { lighter: 'NVDA', entropy: 'NVDA' },
    thresholdBps: 4,
    impulseWindowMs: 1_000,
    followRatio: 0.5,
    maxWaitMs: 5_000,
    cooldownMs: 3_000,
  });

  const tracker = new LeadTracker({
    symbol: 'NVDA',
    runId: 7,
    config,
    startedAt: wall0,
    startMono: 0,
    onSettled: ev => settled.push(ev),
    onGridPoint: pt => grids.push(pt),
  });
  for (const s of ['binance_equity', 'binance_perp', 'lighter', 'entropy'] as const) tracker.setConnected(s, true, 0, wall0);
  const tick = (source: 'binance_equity' | 'binance_perp' | 'lighter' | 'entropy', mono: number, mid: number) =>
    tracker.onTick(source, { monoMs: mono, wallMs: wall0 + mono, bid: mid - 0.01, ask: mid + 0.01, mid, exchangeMs: null });

  tick('binance_equity', 500, 100);
  tick('binance_perp', 500, 100);
  tick('lighter', 500, 100);
  tick('entropy', 500, 100);

  // binance_equity 在 2000ms 先跃动 +6bps
  tick('binance_equity', 2_000, 100.06);
  // 处于 binance_equity 冷却期内，binance_perp 跃动不应被屏蔽（多源冷却各自独立）
  tick('binance_perp', 2_200, 100.06);
  // entropy 在 2250ms 跟进 (+250ms / +50ms)，lighter 在 2400ms 跟进 (+400ms / +200ms)
  tick('entropy', 2_250, 100.03);
  tick('lighter', 2_400, 100.03);

  assert.equal(settled.length, 2, '两个参考源应各自独立结算一次事件');
  const eqEv = settled.find(e => e.leadSource === 'binance_equity')!;
  const perpEv = settled.find(e => e.leadSource === 'binance_perp')!;
  assert.equal(eqEv.venues.entropy!.lagMs, 250);
  assert.equal(eqEv.venues.lighter!.lagMs, 400);
  assert.equal(perpEv.venues.entropy!.lagMs, 50);
  assert.equal(perpEv.venues.lighter!.lagMs, 200);

  // 推进 30s+ 仅应在 <= 30s 处产生单轮锚点，配合 Worker 30s 最大前向填充确保总静默外推严格 <= 60s
  const gridsBeforeAnchor = grids.length;
  tracker.tickTimeouts(35_000);
  assert.ok(grids.length > gridsBeforeAnchor, '推进 30s+ 应生成稀疏心跳锚点');
  const maxAnchorAt35 = Math.max(...grids.map(g => g.gridIdx));
  tracker.tickTimeouts(95_000);
  const countAt95 = grids.length;
  tracker.tickTimeouts(140_000);
  assert.equal(grids.length, countAt95, '超过静默外推上限后不应继续补写心跳锚点');
  assert.ok(maxAnchorAt35 <= 350, `静默超过 30s 后不应继续落新锚点（实得 maxIdx=${maxAnchorAt35}）`);

  // 断线应产出 mid === null 哨兵并重置段 segId
  const gridsBeforeDrop = grids.length;
  tracker.setConnected('lighter', false, 150_000, wall0 + 150_000, 'drop');
  const sentinel = grids.slice(gridsBeforeDrop).find(g => g.source === 'lighter' && g.mid === null);
  assert.ok(sentinel, '断线应向 lead_grid 写入 mid=null 哨兵');
  tracker.setConnected('lighter', true, 160_000, wall0 + 160_000);
  tick('lighter', 160_000, 102);
  const afterReconnect = grids.at(-1)!;
  assert.ok(afterReconnect.segId > sentinel!.segId);

  // 推进超过 30 分钟滑窗，旧事件淘汰，recentEventCount 须等于 recentSettled.length
  const futureMono = 35 * 60_000;
  for (const s of ['binance_equity', 'binance_perp', 'lighter', 'entropy'] as const) tick(s, futureMono, 102);
  tick('binance_equity', futureMono + 200, 102.08);
  tick('lighter', futureMono + 350, 102.05);
  tick('entropy', futureMono + 300, 102.05);
  const wView = tracker.watcherView({ enabled: true, status: 'running', createdAt: wall0, updatedAt: wall0 }, wall0 + futureMono + 400, futureMono + 400);
  assert.equal(wView.recentEventCount, 1, '30 分钟滑窗外的旧事件应被淘汰');
  assert.equal(wView.recentSummary.find(r => r.leadSource === 'binance_perp')!.events, 0);
});

test('lead-store.ts：WITHOUT ROWID 建表、run 收口、7 天分批清理、L202 乐观锁与损坏库降级', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tp-lead-store-'));
  try {
    const dbFile = path.join(dir, LEAD_DB_FILE);
    const store = openLeadStore(dbFile);
    const tbl = store.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'lead_grid'").get() as { sql: string };
    assert.match(tbl.sql, /WITHOUT ROWID/);
    const idxNames = (store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('lead_events_run', 'lead_grid_run')").all() as { name: string }[]).map(r => r.name);
    assert.deepEqual(idxNames.sort(), ['lead_events_run', 'lead_grid_run'], '应建好 run_id 清理索引');

    const cfg = readLeadWatcherConfig({ symbol: 'NVDA', leads: { binance_perp: 'NVDAUSDT' }, targets: { lighter: 'NVDA' } });
    const now = 1_700_000_000_000;
    store.upsertWatcher(cfg, true, now);
    assert.equal(store.setWatcherEnabled('NVDA', false, now - 1, now + 1), false, '旧 updatedAt 应被 L202 拒绝');
    assert.equal(store.deleteWatcher('NVDA', now - 1), false, '旧 updatedAt 删除应被拒绝');
    assert.equal(store.setWatcherEnabled('NVDA', false, now, now + 1), true);

    // startRun 自动收口历史未关闭 run
    const run1 = store.startRun('NVDA', now - 10_000_000, cfg);
    const oldAt = now - (LEAD_RETENTION_DAYS + 1) * 86_400_000;
    const recentAt = now - 60_000;
    const oldGrid: PersistLeadGrid[] = Array.from({ length: 12 }, (_, i) => ({
      symbol: 'NVDA', at: oldAt + i * 100, source: 'binance_perp', runId: run1, gridIdx: i, segId: 1, mid: 180 + i * 0.01,
    }));
    const oldEvents: PersistLeadEvent[] = Array.from({ length: 6 }, (_, i) => ({
      symbol: 'NVDA', runId: run1, leadSource: 'binance_perp', at: oldAt + i * 1_000, direction: 1,
      baseMid: 180, triggerMid: 180.1, moveBps: 5.5, thresholdBps: 3, followBps: 1.5,
      venues: { lighter: { status: 'followed', lagMs: 200, maxMoveBps: 4 } },
    }));
    store.flushBatch(oldEvents, oldGrid);

    const run2 = store.startRun('NVDA', recentAt, cfg);
    const run1Row = store.db.prepare('SELECT ended_at AS endedAt FROM lead_runs WHERE id = ?').get(run1) as { endedAt: number | null };
    assert.ok(run1Row.endedAt !== null, '新起 run 时历史未收口 run 应自动关闭');

    store.flushBatch(
      [{ symbol: 'NVDA', runId: run2, leadSource: 'binance_perp', at: recentAt, direction: 1, baseMid: 181, triggerMid: 181.1, moveBps: 5.5, thresholdBps: 3, followBps: 1.5, venues: { lighter: { status: 'followed', lagMs: 180, maxMoveBps: 3.5 } } }],
      [{ symbol: 'NVDA', at: recentAt, source: 'binance_perp', runId: run2, gridIdx: 0, segId: 1, mid: 181 }],
    );

    const cutoff = now - LEAD_RETENTION_DAYS * 86_400_000;
    const step1 = store.pruneBatch(cutoff, 5);
    assert.equal(step1.more, true);
    let safety = 0;
    while (safety++ < 10) {
      const next = store.pruneBatch(cutoff, 5);
      if (!next.more) break;
    }
    const sum = store.summary();
    assert.equal(sum.totalEvents, 1);
    assert.equal(sum.totalGridPoints, 1);
    const oldRunGone = store.db.prepare('SELECT COUNT(*) AS cnt FROM lead_runs WHERE id = ?').get(run1) as { cnt: number };
    assert.equal(oldRunGone.cnt, 0, '无残余数据的过期 run 记录也应清理');

    // clearData 按标的隔离清除
    const btcCfg = readLeadWatcherConfig({ symbol: 'BTC', leads: { binance_perp: 'BTCUSDT' }, targets: { lighter: 'BTC' } });
    const runBtc = store.startRun('BTC', recentAt, btcCfg);
    store.flushBatch(
      [{ symbol: 'BTC', runId: runBtc, leadSource: 'binance_perp', at: recentAt, direction: 1, baseMid: 98000, triggerMid: 98060, moveBps: 6, thresholdBps: 3, followBps: 1.5, venues: { lighter: { status: 'followed', lagMs: 150, maxMoveBps: 4 } } }],
      [],
    );
    store.clearData('BTC');
    assert.equal(store.summary().totalEvents, 1, '仅清空 BTC 不应误删 NVDA');
    store.clearData();
    assert.equal(store.summary().totalEvents, 0);
    store.close();

    // 损坏数据库文件应触发 createLeadTester 优雅降级而非崩溃
    const corruptFile = path.join(dir, 'corrupt.sqlite');
    writeFileSync(corruptFile, 'not-a-valid-sqlite-database-header');
    const tester = createLeadTester({
      leadStoreFile: corruptFile,
      fetchImpl: (async () => Response.json({})) as unknown as typeof fetch,
      connect: () => new MockSocket(),
      now: () => now,
      monoNow: () => 0,
      log: () => {},
      dexMarkets: () => ({ lighter: [], rh: [], entropy: [] }),
    });
    const degraded = tester.view();
    assert.ok(degraded.storage.error, '损坏数据库应暴露 storage.error 且不阻断 view()');
    assert.throws(() => tester.addWatcher(cfg), e => e instanceof LeadError && e.status === 503 && e.code === 'storage_unavailable');
    tester.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lead-worker.ts：真实只读 Worker 离线分析、Leaderboard/vsBinancePerpMs、6h 互相关截断、跨段/断线隔离与 429 互斥', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tp-lead-worker-'));
  let tester: ReturnType<typeof createLeadTester> | undefined;
  try {
    const dbFile = path.join(dir, LEAD_DB_FILE);
    const store = openLeadStore(dbFile);
    const cfg = readLeadWatcherConfig({
      symbol: 'NVDA',
      leads: { binance_equity: 'NVDA', binance_perp: 'NVDAUSDT' },
      targets: { lighter: 'NVDA', entropy: 'NVDA' },
    });
    const now = 1_700_100_000_000;
    store.upsertWatcher(cfg, false, now - 10 * 3_600_000);

    // Run 1（已结束且带跨段价格跳变）：不得把断线/已结束点向后续时刻填充
    const run1 = store.startRun('NVDA', now - 120_000, cfg);
    const grid1: PersistLeadGrid[] = [
      { symbol: 'NVDA', at: now - 120_000, source: 'binance_perp', runId: run1, gridIdx: 0, segId: 1, mid: 150 },
      { symbol: 'NVDA', at: now - 115_000, source: 'binance_perp', runId: run1, gridIdx: 50, segId: 2, mid: null },
      { symbol: 'NVDA', at: now - 120_000, source: 'lighter', runId: run1, gridIdx: 0, segId: 1, mid: 150 },
      { symbol: 'NVDA', at: now - 115_000, source: 'lighter', runId: run1, gridIdx: 50, segId: 2, mid: null },
    ];
    store.flushBatch([], grid1);
    store.endRun(run1, now - 110_000);

    // Run 2：最近 25 秒生成清晰的领先序列：
    // binance_equity 比 binance_perp 快 +100ms（1格）；entropy 滞后 binance_perp 100ms；lighter 滞后 300ms
    const run2 = store.startRun('NVDA', now - 40_000, cfg);
    const grid2: PersistLeadGrid[] = [];
    const origin = Math.floor((now - 25_000) / LEAD_GRID_STEP_MS) * LEAD_GRID_STEP_MS;
    const priceAt = (tMs: number): number => 180 * (1 + Math.sin((tMs - origin) / 1_200) * 0.002 + ((tMs - origin) % 5_000 < 2_500 ? 0.0008 : -0.0008));
    for (let idx = 0; idx <= 200; idx++) {
      const t = origin + idx * LEAD_GRID_STEP_MS;
      grid2.push(
        { symbol: 'NVDA', at: t, source: 'binance_equity', runId: run2, gridIdx: idx, segId: 1, mid: Number(priceAt(t + 100).toFixed(5)) },
        { symbol: 'NVDA', at: t, source: 'binance_perp', runId: run2, gridIdx: idx, segId: 1, mid: Number(priceAt(t).toFixed(5)) },
        { symbol: 'NVDA', at: t, source: 'entropy', runId: run2, gridIdx: idx, segId: 1, mid: Number(priceAt(t - 100).toFixed(5)) },
        { symbol: 'NVDA', at: t, source: 'lighter', runId: run2, gridIdx: idx, segId: 1, mid: Number(priceAt(t - 300).toFixed(5)) },
      );
    }
    const events2: PersistLeadEvent[] = [
      {
        symbol: 'NVDA', runId: run2, leadSource: 'binance_equity', at: now - 8 * 3_600_000, direction: 1,
        baseMid: 180, triggerMid: 180.1, moveBps: 5.5, thresholdBps: 3, followBps: 1.5,
        venues: { entropy: { status: 'followed', lagMs: 200, maxMoveBps: 5 }, lighter: { status: 'followed', lagMs: 400, maxMoveBps: 4.5 } },
      },
      {
        symbol: 'NVDA', runId: run2, leadSource: 'binance_perp', at: now - 8 * 3_600_000 + 30_000, direction: 1,
        baseMid: 180, triggerMid: 180.1, moveBps: 5.5, thresholdBps: 3, followBps: 1.5,
        venues: { entropy: { status: 'followed', lagMs: 100, maxMoveBps: 5 }, lighter: { status: 'followed', lagMs: 300, maxMoveBps: 4.5 } },
      },
    ];
    store.flushBatch(events2, grid2);
    store.endRun(run2, origin + 20_100);

    // 验证直调 analyzeLeadDatabase 对纯空事件排序不会出现 NaN / 顺序混乱
    const emptyEventsRes = analyzeLeadDatabase(store.db, { file: dbFile, symbol: 'UNKNOWN', leadSource: null, from: now - 3_600_000, to: now });
    assert.equal(emptyEventsRes.eventCount, 0);
    store.close();

    // 通过 createLeadTester 真实启动 node:worker_threads Worker 进行分析，并检验并发 429 互斥
    tester = createLeadTester({
      leadStoreFile: dbFile,
      fetchImpl: (async () => Response.json({})) as unknown as typeof fetch,
      connect: () => new MockSocket(),
      now: () => now,
      monoNow: () => 0,
      log: () => {},
      dexMarkets: () => ({ lighter: [], rh: [], entropy: [] }),
    });

    const p1 = tester.analyze({ symbol: 'NVDA', hours: 24 });
    await assert.rejects(() => tester!.analyze({ symbol: 'NVDA', hours: 6 }), e => e instanceof LeadError && e.status === 429 && e.code === 'lead_analyze_busy');
    const res = await p1;

    assert.equal(res.symbol, 'NVDA');
    assert.equal(res.xcorrTruncated, true, '24h 查询应将网格互相关窗口截断至近 6 小时');
    assert.equal(res.leaderboard.length, 2);
    assert.equal(res.leaderboard[0]!.leadSource, 'binance_equity', '综合最快的 BN 美股应排在首位');
    assert.equal(res.leaderboard[0]!.vsBinancePerpMs, 100, 'vsBinancePerpMs 应精确识别快 Binance 合约 +100 ms');
    assert.equal(res.leaderboard[1]!.leadSource, 'binance_perp');
    assert.equal(res.leaderboard[1]!.vsBinancePerpMs, 0);
    const ltStats = res.venues.find(v => v.venue === 'lighter')!;
    assert.equal(ltStats.xcorr?.peakLagMs, 400, '主基准为 BN 美股时，Lighter 互相关峰值应约为 +400 ms');
    assert.ok(res.buckets.length >= 1 && res.series.length >= 2);

    // 验证静默锚点最大总外推严格 <= 60s（不延续到 120s）
    const capStore = openLeadStore(dbFile);
    try {
      const capCfg = readLeadWatcherConfig({ symbol: 'TESTCAP', leads: { binance_perp: 'TESTUSDT' }, targets: { lighter: 'TEST' } });
      const capRun = capStore.startRun('TESTCAP', now - 200_000, capCfg);
      const capTracker = new LeadTracker({
        symbol: 'TESTCAP', runId: capRun, config: capCfg, startedAt: now - 200_000, startMono: 0,
        onGridPoint: pt => capStore.flushBatch([], [pt]),
      });
      capTracker.setConnected('binance_perp', true, 0, now - 200_000);
      capTracker.onTick('binance_perp', { monoMs: 0, wallMs: now - 200_000, bid: 100, ask: 100.1, mid: 100.05, exchangeMs: null });
      capTracker.setConnected('lighter', true, 0, now - 200_000);
      capTracker.onTick('lighter', { monoMs: 0, wallMs: now - 200_000, bid: 100, ask: 100.1, mid: 100.05, exchangeMs: null });
      capTracker.tickTimeouts(40_000);
      capTracker.tickTimeouts(80_000);
      const capRes = analyzeLeadDatabase(capStore.db, { file: dbFile, symbol: 'TESTCAP', leadSource: null, from: now - 200_000, to: now - 50_000 });
      const lastValidAt = Math.max(...capRes.series.filter(p => p.values.binance_perp !== null).map(p => p.t));
      assert.ok(lastValidAt <= now - 200_000 + 60_500, `静默总外推不应超过 60s（lastValidOffset=${lastValidAt - (now - 200_000)}ms）`);
    } finally {
      capStore.close();
    }

    // 验证 analyzeTimeoutMs 超时返回 504 且 close() 拦截后续调用返回 503
    const timeoutTester = createLeadTester({
      leadStoreFile: dbFile,
      analyzeTimeoutMs: 1,
      fetchImpl: (async () => Response.json({})) as unknown as typeof fetch,
      connect: () => new MockSocket(),
      now: () => now,
      monoNow: () => 0,
      log: () => {},
      dexMarkets: () => ({ lighter: [], rh: [], entropy: [] }),
    });
    try {
      await assert.rejects(
        () => timeoutTester.analyze({ symbol: 'NVDA', hours: 6 }),
        e => e instanceof LeadError && e.status === 504 && e.code === 'analyze_timeout',
      );
    } finally {
      timeoutTester.close();
    }
    assert.throws(() => timeoutTester.view(), e => e instanceof LeadError && e.status === 503 && e.code === 'unavailable');
    await assert.rejects(
      () => timeoutTester.analyze({ symbol: 'NVDA', hours: 6 }),
      e => e instanceof LeadError && e.status === 503 && e.code === 'unavailable',
    );
  } finally {
    tester?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('写库错误隔离与退避：startRun / flush 失败不被 summary() 清零，且 30s 内不重复刷日志', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tp-lead-writeerr-'));
  let tester: ReturnType<typeof createLeadTester> | undefined;
  try {
    const dbFile = path.join(dir, LEAD_DB_FILE);
    let wall = 1_700_300_000_000;
    const logs: string[] = [];
    const sockets: MockSocket[] = [];
    const cfg = readLeadWatcherConfig({ symbol: 'NVDA', leads: { binance_perp: 'NVDAUSDT' }, targets: { lighter: 'NVDA' } });

    const prep = openLeadStore(dbFile);
    prep.upsertWatcher(cfg, true, wall);
    prep.db.exec("CREATE TRIGGER fail_run BEFORE INSERT ON lead_runs BEGIN SELECT RAISE(ABORT, 'disk full'); END;");
    prep.close();

    tester = createLeadTester({
      leadStoreFile: dbFile,
      fetchImpl: (async () => Response.json({})) as unknown as typeof fetch,
      connect: url => { const s = new MockSocket(url); sockets.push(s); return s; },
      now: () => wall,
      monoNow: () => wall - 1_700_300_000_000,
      log: line => logs.push(line),
      dexMarkets: () => ({ lighter: [spec('lighter', 'NVDA', 110)], rh: [], entropy: [] }),
    });

    // 初次 view() 触发 startRuntime -> 触及 fail_run：写错应保留且 watcher 显示写库退避提示
    const v1 = tester.view();
    assert.match(v1.storage.error ?? '', /disk full/);
    assert.match(v1.watchers[0]!.streams[0]!.lastError ?? '', /写库失败/);
    assert.equal(logs.length, 1);

    // 冷却期内多次维护不触发重复日志
    wall += 5_000;
    tester.tickMaintenance();
    wall += 5_000;
    tester.tickMaintenance();
    assert.equal(logs.length, 1, '写库失败冷却期内不应每秒重复写日志');

    tester.close();
    tester = undefined;

    // 去掉 fail_run、改用 fail_events 检验 flushBatch 失败后即使 35s 刷新 summary() 仍保留 lastWriteError
    const prep2 = openLeadStore(dbFile);
    prep2.db.exec('DROP TRIGGER fail_run;');
    prep2.db.exec("CREATE TRIGGER fail_events BEFORE INSERT ON lead_events BEGIN SELECT RAISE(ABORT, 'readonly events'); END;");
    prep2.close();

    const sockets2: MockSocket[] = [];
    tester = createLeadTester({
      leadStoreFile: dbFile,
      fetchImpl: (async () => Response.json({})) as unknown as typeof fetch,
      connect: url => { const s = new MockSocket(url); sockets2.push(s); return s; },
      now: () => wall,
      monoNow: () => wall - 1_700_300_000_000,
      log: line => logs.push(line),
      dexMarkets: () => ({ lighter: [spec('lighter', 'NVDA', 110)], rh: [], entropy: [] }),
    });
    for (const s of sockets2) s.open();
    sockets2[0]!.push({ e: 'bookTicker', s: 'NVDAUSDT', b: '180.00', B: '1', a: '180.02', A: '1' });
    sockets2[1]!.push({ type: 'subscribed/order_book', channel: 'order_book:110', order_book: { code: 0, nonce: 1, bids: [{ price: '180.00', size: '5' }], asks: [{ price: '180.02', size: '5' }] } });
    wall += 400;
    sockets2[0]!.push({ e: 'bookTicker', s: 'NVDAUSDT', b: '180.12', B: '1', a: '180.14', A: '1' });
    wall += 200;
    sockets2[1]!.push({ type: 'update/order_book', channel: 'order_book:110', order_book: { begin_nonce: 1, nonce: 2, bids: [{ price: '180.00', size: '0' }, { price: '180.12', size: '5' }], asks: [{ price: '180.02', size: '0' }, { price: '180.14', size: '5' }] } });
    tester.tickMaintenance();
    const afterWriteErr = tester.view();
    assert.match(afterWriteErr.storage.error ?? '', /readonly events/);
    // 推进 35s 让 STORAGE_SUMMARY_TTL_MS 过期并重新执行只读 summary()
    wall += 35_000;
    const afterSummaryRefresh = tester.view();
    assert.match(afterSummaryRefresh.storage.error ?? '', /readonly events/, '只读 summary() 刷新不得抹掉未恢复的写库错误');
  } finally {
    tester?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DEX 服务路由与引擎全生命周期：3 标的上限制约、L202 冲突、L054 查前刷盘与重启恢复', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tp-dex-lead-'));
  let holder: ReturnType<typeof openVarLighter> | undefined;
  let holder2: ReturnType<typeof openVarLighter> | undefined;
  try {
    let wall = 1_700_200_000_000;
    const sockets: MockSocket[] = [];
    let allowDexCatalog = true;

    const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('fapi.binance.com')) {
        return Response.json({
          symbols: ['NVDA', 'BTC', 'ETH', 'SOL'].map(s => ({
            symbol: `${s}USDT`, baseAsset: s, quoteAsset: 'USDT', marginAsset: 'USDT', contractType: s === 'NVDA' ? 'TRADIFI_PERPETUAL' : 'PERPETUAL', status: 'TRADING',
          })),
        });
      }
      if (url.includes('data-api.binance.vision')) {
        return Response.json(['BTC', 'ETH', 'SOL'].map(s => ({ symbol: `${s}USDT`, bidPrice: '100', askPrice: '101' })));
      }
      if (url.includes('okx.com')) {
        return Response.json({ code: '0', data: ['NVDA', 'BTC', 'ETH', 'SOL'].map(s => ({ instType: 'SWAP', state: 'live', settleCcy: 'USDT', instId: `${s}-USDT-SWAP` })) });
      }
      if (url.includes('bybit.com')) {
        return Response.json({ retCode: 0, result: { list: ['BTC', 'ETH', 'SOL'].map(s => ({ symbol: `${s}USDT`, baseCoin: s, quoteCoin: 'USDT', contractType: 'LinearPerpetual', status: 'Trading' })) } });
      }
      if (url.includes('coinbase.com')) {
        return Response.json(['BTC', 'ETH', 'SOL'].map(s => ({ id: `${s}-USD`, base_currency: s, quote_currency: 'USD', status: 'online' })));
      }
      if (url.includes('hyperliquid')) {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { dex?: string } : {};
        if (body.dex === 'xyz') {
          return Response.json([{ universe: [{ name: 'xyz:NVDA' }], collateralToken: 0 }, [{ markPx: '180' }]]);
        }
        return Response.json([{ universe: [{ name: 'io:NVDA', szDecimals: 2 }], collateralToken: 0 }, [{ markPx: '180', oraclePx: '180', funding: '0' }]]);
      }
      if (url.includes('orderBookDetails')) {
        if (!allowDexCatalog) return Response.json({ code: 200, order_book_details: [] });
        return Response.json({
          code: 200,
          order_book_details: [
            { symbol: 'NVDA', market_id: 110, market_type: 'perp', status: 'active', size_decimals: 2, price_decimals: 2, min_base_amount: '0.1', min_quote_amount: '10', taker_fee: '0', maker_fee: '0', mark_price: '180' },
            { symbol: 'BTC', market_id: 1, market_type: 'perp', status: 'active', size_decimals: 4, price_decimals: 1, min_base_amount: '0.001', min_quote_amount: '10', taker_fee: '0', maker_fee: '0', mark_price: '98000' },
            { symbol: 'ETH', market_id: 2, market_type: 'perp', status: 'active', size_decimals: 3, price_decimals: 2, min_base_amount: '0.01', min_quote_amount: '10', taker_fee: '0', maker_fee: '0', mark_price: '3600' },
            { symbol: 'SOL', market_id: 3, market_type: 'perp', status: 'active', size_decimals: 2, price_decimals: 2, min_base_amount: '0.1', min_quote_amount: '10', taker_fee: '0', maker_fee: '0', mark_price: '180' },
          ],
        });
      }
      return Response.json({ listings: [] });
    };

    holder = openVarLighter(dir, {
      fetchImpl: fetchImpl as typeof fetch,
      connect: url => { const s = new MockSocket(url); sockets.push(s); return s; },
      now: () => wall,
      monoNow: () => wall - 1_700_200_000_000,
    }, () => {});
    const engine = holder.engine!;
    await engine.refreshCatalog(AbortSignal.timeout(5_000), 'lighter');
    const views = varLighterViews(holder);
    const forward = localDexForward(views, () => {});

    // 刷新 6 个参考源目录并构建候选
    const catRes = await forward.page({ method: 'POST', path: 'lead/catalog', query: [] });
    assert.equal(catRes.status, 200);
    const lead0 = catRes.body as LeadView;
    assert.ok(lead0.candidates.some(c => c.symbol === 'NVDA' && c.leads.binance_equity === 'NVDA' && c.leads.hl_xyz === 'xyz:NVDA'));

    // 未知 DEX 标的拒绝 400
    const badTarget = await forward.page({
      method: 'POST', path: 'lead/watchers/add', query: [],
      body: { symbol: 'NVDA', leads: { binance_perp: 'NVDAUSDT' }, targets: { lighter: 'UNKNOWN' } },
    });
    assert.equal(badTarget.status, 400);

    // 添加第 1 个常驻标的 NVDA（binance_equity + binance_perp -> lighter）
    const addNvda = await forward.page({
      method: 'POST', path: 'lead/watchers/add', query: [],
      body: { symbol: 'NVDA', leads: { binance_equity: 'NVDA', binance_perp: 'NVDAUSDT' }, targets: { lighter: 'NVDA' } },
    });
    assert.equal(addNvda.status, 200);
    const nvdaView = (addNvda.body as LeadView).watchers[0]!;
    assert.equal(nvdaView.status, 'running');
    assert.equal(sockets.length, 3);
    for (const s of sockets) s.open();

    // 重复添加 409
    const dup = await forward.page({
      method: 'POST', path: 'lead/watchers/add', query: [],
      body: { symbol: 'NVDA', leads: { binance_perp: 'NVDAUSDT' }, targets: { lighter: 'NVDA' } },
    });
    assert.equal(dup.status, 409);
    assert.equal((dup.body as { code: string }).code, 'duplicate_watcher');

    // 推送行情并在不满 1s 定时器时直接调用 lead/analyze 验证 L054 pre-analyze 刷盘
    const eqSock = sockets.find(s => s.url.includes('nbstream.binance.com'))!;
    const perpSock = sockets.find(s => s.url.includes('fstream.binance.com'))!;
    const ltSock = sockets.find(s => !s.url.includes('binance.com'))!;
    eqSock.push({ e: 'quote', s: 'NVDA', bp: '180.00', ap: '180.02' });
    perpSock.push({ e: 'bookTicker', s: 'NVDAUSDT', b: '180.00', B: '1', a: '180.02', A: '1' });
    ltSock.push({ type: 'subscribed/order_book', channel: 'order_book:110', order_book: { code: 0, nonce: 1, bids: [{ price: '180.00', size: '5' }], asks: [{ price: '180.02', size: '5' }] } });
    wall += 500;
    eqSock.push({ e: 'quote', s: 'NVDA', bp: '180.10', ap: '180.12' });
    wall += 100;
    perpSock.push({ e: 'bookTicker', s: 'NVDAUSDT', b: '180.10', B: '1', a: '180.12', A: '1' });
    wall += 150;
    ltSock.push({ type: 'update/order_book', channel: 'order_book:110', order_book: { begin_nonce: 1, nonce: 2, bids: [{ price: '180.00', size: '0' }, { price: '180.10', size: '5' }], asks: [{ price: '180.02', size: '0' }, { price: '180.12', size: '5' }] } });

    const analyzeRes = await forward.page({ method: 'POST', path: 'lead/analyze', query: [], body: { symbol: 'NVDA', hours: 1 } });
    assert.equal(analyzeRes.status, 200);
    const analyzed = analyzeRes.body as LeadAnalyzeView;
    assert.equal(analyzed.eventCount, 1, 'L054: lead/analyze 应在调用前刷盘，刚结算未满 1s 的事件立即可查');
    assert.equal(analyzed.leaderboard[0]!.leadSource, 'binance_equity');

    // 再加第 2、第 3 个常驻标的并检验第 4 个超出上限 409
    assert.equal(LEAD_MAX_WATCHERS, 3);
    assert.equal((await forward.page({ method: 'POST', path: 'lead/watchers/add', query: [], body: { symbol: 'BTC', leads: { binance_perp: 'BTCUSDT' }, targets: { lighter: 'BTC' } } })).status, 200);
    assert.equal((await forward.page({ method: 'POST', path: 'lead/watchers/add', query: [], body: { symbol: 'ETH', leads: { binance_perp: 'ETHUSDT' }, targets: { lighter: 'ETH' } } })).status, 200);
    const overMax = await forward.page({ method: 'POST', path: 'lead/watchers/add', query: [], body: { symbol: 'SOL', leads: { binance_perp: 'SOLUSDT' }, targets: { lighter: 'SOL' } } });
    assert.equal(overMax.status, 409);
    assert.equal((overMax.body as { code: string }).code, 'max_watchers');

    // L202：过期 updatedAt toggle 返回 409；正确 updatedAt 暂停与恢复
    const curState = (await forward.page({ method: 'GET', path: 'lead', query: [] })).body as LeadView;
    const btcWatcher = curState.watchers.find(w => w.symbol === 'BTC')!;
    const staleToggle = await forward.page({
      method: 'POST', path: 'lead/watchers/toggle', query: [],
      body: { symbol: 'BTC', enabled: false, updatedAt: btcWatcher.updatedAt - 1 },
    });
    assert.equal(staleToggle.status, 409);
    const pausedRes = await forward.page({
      method: 'POST', path: 'lead/watchers/toggle', query: [],
      body: { symbol: 'BTC', enabled: false, updatedAt: btcWatcher.updatedAt },
    });
    assert.equal(pausedRes.status, 200);
    assert.equal((pausedRes.body as LeadView).watchers.find(w => w.symbol === 'BTC')!.status, 'paused');

    const ethWatcher = (pausedRes.body as LeadView).watchers.find(w => w.symbol === 'ETH')!;
    const openEthBeforeConflict = sockets.filter(s => !s.closed).length;
    const staleRemove = await forward.page({
      method: 'POST', path: 'lead/watchers/remove', query: [],
      body: { symbol: 'ETH', updatedAt: ethWatcher.updatedAt - 1 },
    });
    assert.equal(staleRemove.status, 409, '过期 updatedAt 移除应拦截并返回 409');
    assert.equal(sockets.filter(s => !s.closed).length, openEthBeforeConflict, '409 移除失败不应误停 ETH 在连流');
    const removedRes = await forward.page({
      method: 'POST', path: 'lead/watchers/remove', query: [],
      body: { symbol: 'ETH', updatedAt: ethWatcher.updatedAt },
    });
    assert.equal(removedRes.status, 200);
    assert.equal((removedRes.body as LeadView).watchers.length, 2);

    engine.close();
    holder.engine = null;
    assert.ok(sockets.every(s => s.closed), '停服应关闭全部常驻 WS 连接');

    // 重启恢复：先在无 DEX 目录时处于 waiting_catalog，同步目录后自动拉起并创建新 runId
    allowDexCatalog = false;
    const sockets2: MockSocket[] = [];
    holder2 = openVarLighter(dir, {
      fetchImpl: fetchImpl as typeof fetch,
      connect: url => { const s = new MockSocket(url); sockets2.push(s); return s; },
      now: () => wall,
      monoNow: () => wall - 1_700_200_000_000,
    }, () => {});
    const engine2 = holder2.engine!;
    const forward2 = localDexForward(varLighterViews(holder2), () => {});
    const beforeCat = (await forward2.page({ method: 'GET', path: 'lead', query: [] })).body as LeadView;
    assert.equal(beforeCat.watchers.find(w => w.symbol === 'NVDA')!.status, 'waiting_catalog');
    assert.equal(beforeCat.watchers.find(w => w.symbol === 'BTC')!.status, 'paused');
    assert.equal(sockets2.length, 0);

    allowDexCatalog = true;
    await engine2.refreshCatalog(AbortSignal.timeout(5_000), 'lighter');
    const afterCat = (await forward2.page({ method: 'GET', path: 'lead', query: [] })).body as LeadView;
    assert.equal(afterCat.watchers.find(w => w.symbol === 'NVDA')!.status, 'running');
    assert.ok(sockets2.length >= 3, '目录同步后 waiting_catalog 的常驻标的应自动恢复拉流');

    const cleared = await forward2.page({ method: 'POST', path: 'lead/clear', query: [], body: {} });
    assert.equal(cleared.status, 200);
    assert.equal((cleared.body as LeadView).storage.totalEvents, 0);

    engine2.close();
    holder2.engine = null;

    // 停服后所有 lead_runs.ended_at 均应已关闭
    const checkDb = new DatabaseSync(path.join(dir, LEAD_DB_FILE), { readOnly: true });
    try {
      const openRuns = checkDb.prepare('SELECT COUNT(*) AS cnt FROM lead_runs WHERE ended_at IS NULL').get() as { cnt: number };
      assert.equal(openRuns.cnt, 0, '停服后 lead_runs 不应遗留未闭合的 ended_at IS NULL');
    } finally {
      checkDb.close();
    }
  } finally {
    holder?.engine?.close();
    holder2?.engine?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
