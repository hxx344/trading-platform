// DEX 价差子模块「Binance 领先测速」测试：Binance exchangeInfo 解析、自动匹配、参数校验、双方法测速统计、
// 三个单标的 WS 客户端与 DEX 服务路由/引擎集成测试。全部使用内存替身，不连外部网络。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { localDexForward, openVarLighter, varLighterViews } from '../src/dex/host.ts';
import {
  DEFAULT_LEAD_CONFIG,
  LeadTracker,
  buildLeadCandidates,
  matchDexTargets,
  parseBinanceExchangeInfo,
  readLeadConfig,
} from '../src/varlighter/lead.ts';
import {
  BINANCE_FAPI_EXCHANGE_INFO,
  BinanceBookTickerStream,
  CATALOG_TIMEOUT_MS,
  ENTROPY_CONFIRM_MS,
  EntropyBboStream,
  LEAD_HISTORY_KEY,
  LighterOrderBookTopStream,
  createLeadTester,
} from '../src/varlighter/lead-streams.ts';
import { BOOK_KEEP_LEVELS, CONNECT_TIMEOUT_MS, type SocketLike } from '../src/varlighter/feeds.ts';
import type { MarketSpec } from '../src/varlighter/model.ts';
import { openVarLighterStore } from '../src/varlighter/store.ts';
import { createVarLighterEngine } from '../src/varlighter/engine.ts';
import { ParamsError } from '../src/varlighter/strategy.ts';
import type { LeadView } from '../src/varlighter/views.ts';

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
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sent: string[] = [];
  closed = false;

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  push(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
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

test('Binance exchangeInfo 解析与 DEX 标的自动匹配（含 TradFi、别名与 1000 倍缩尺）', () => {
  const contracts = parseBinanceExchangeInfo({
    symbols: [
      { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', marginAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING' },
      { symbol: 'NVDAUSDT', baseAsset: 'NVDA', quoteAsset: 'USDT', marginAsset: 'USDT', contractType: 'TRADIFI_PERPETUAL', status: 'TRADING' },
      { symbol: 'ANTUSDT', baseAsset: 'ANT', quoteAsset: 'USDT', marginAsset: 'USDT', contractType: 'TRADIFI_PERPETUAL', status: 'TRADING' },
      { symbol: '1000PEPEUSDT', baseAsset: '1000PEPE', quoteAsset: 'USDT', marginAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING' },
      { symbol: 'OLDUSDT', baseAsset: 'OLD', quoteAsset: 'USDT', marginAsset: 'USDT', contractType: 'PERPETUAL', status: 'SETTLING' },
      { symbol: 'BTCBUSD', baseAsset: 'BTC', quoteAsset: 'BUSD', marginAsset: 'BUSD', contractType: 'PERPETUAL', status: 'TRADING' },
      { symbol: 'ETHUSDC_2606', baseAsset: 'ETH', quoteAsset: 'USDC', marginAsset: 'USDC', contractType: 'CURRENT_QUARTER', status: 'TRADING' },
    ],
  });
  assert.deepEqual(contracts.map(c => c.symbol), ['1000PEPEUSDT', 'ANTUSDT', 'BTCUSDT', 'NVDAUSDT']);
  assert.throws(() => parseBinanceExchangeInfo({}), /Binance 合约目录格式无效/);

  const dex = {
    lighter: [spec('lighter', 'BTC', 1), spec('lighter', 'NVDA', 110), spec('lighter', 'ANTHROPIC', 50), spec('lighter', 'PEPE', 77)],
    rh: [spec('rh', 'NVDA', 3), spec('rh', 'ANTHROPIC', 8)],
    entropy: [spec('entropy', 'NVDA', 2, { coin: 'io:NVDA' }), spec('entropy', 'ANTH', 9, { coin: 'io:ANTH' })],
  };

  assert.deepEqual(matchDexTargets(contracts[2]!, dex), { lighter: 'BTC' });
  assert.deepEqual(matchDexTargets(contracts[3]!, dex), { lighter: 'NVDA', rh: 'NVDA', entropy: 'NVDA' });
  assert.deepEqual(matchDexTargets(contracts[1]!, dex), { lighter: 'ANTHROPIC', rh: 'ANTHROPIC', entropy: 'ANTH' });
  assert.deepEqual(matchDexTargets(contracts[0]!, dex), { lighter: 'PEPE' });

  const candidates = buildLeadCandidates(contracts, dex);
  assert.equal(candidates[0]!.symbol, 'ANTUSDT');
  assert.equal(candidates[1]!.symbol, 'NVDAUSDT');
  assert.equal(candidates.length, 4);
});

test('readLeadConfig 校验合法参数与全部非法边界', () => {
  const valid = readLeadConfig({ binanceSymbol: ' btcusdt ', targets: { lighter: 'BTC', rh: '', entropy: undefined } });
  assert.deepEqual(valid, {
    ...DEFAULT_LEAD_CONFIG,
    binanceSymbol: 'BTCUSDT',
    targets: { lighter: 'BTC' },
  });

  const badCases = [
    null,
    { binanceSymbol: 'BTCUSDT', targets: { lighter: 'BTC' }, extra: 1 },
    { binanceSymbol: 'A', targets: { lighter: 'BTC' } },
    { binanceSymbol: 'BTCUSDT', targets: {} },
    { binanceSymbol: 'BTCUSDT', targets: { var: 'BTC' } },
    { binanceSymbol: 'BTCUSDT', targets: { lighter: 'bad symbol' } },
    { binanceSymbol: 'BTCUSDT', targets: { lighter: 'BTC' }, durationSec: 29 },
    { binanceSymbol: 'BTCUSDT', targets: { lighter: 'BTC' }, durationSec: 120.5 },
    { binanceSymbol: 'BTCUSDT', targets: { lighter: 'BTC' }, thresholdBps: 0.1 },
    { binanceSymbol: 'BTCUSDT', targets: { lighter: 'BTC' }, impulseWindowMs: 50 },
    { binanceSymbol: 'BTCUSDT', targets: { lighter: 'BTC' }, followRatio: 1.5 },
    { binanceSymbol: 'BTCUSDT', targets: { lighter: 'BTC' }, maxWaitMs: 500 },
    { binanceSymbol: 'BTCUSDT', targets: { lighter: 'BTC' }, cooldownMs: 100 },
  ];
  for (const raw of badCases) {
    assert.throws(() => readLeadConfig(raw), error => error instanceof ParamsError);
  }
});

test('LeadTracker：同门槛跃动对齐、多场所滞后、负延迟、超时/断线/缺数据与 500ms 互相关', () => {
  const config = readLeadConfig({
    binanceSymbol: 'NVDAUSDT',
    targets: { lighter: 'NVDA', rh: 'NVDA', entropy: 'NVDA' },
    durationSec: 180,
    thresholdBps: 4,
    impulseWindowMs: 1_000,
    followRatio: 0.5, // followBps = 2 bps
    maxWaitMs: 5_000,
    cooldownMs: 2_000,
  });
  const wall0 = 1_700_000_000_000;
  const tracker = new LeadTracker('lead-1', config, wall0, 0);

  for (const s of ['binance', 'lighter', 'rh', 'entropy'] as const) tracker.setConnected(s, true, 0);

  // 初始化稳定基准价 100
  const tick = (source: 'binance' | 'lighter' | 'rh' | 'entropy', mono: number, mid: number) =>
    tracker.onTick(source, { monoMs: mono, wallMs: wall0 + mono, bid: mid - 0.01, ask: mid + 0.01, mid, exchangeMs: null });

  tick('binance', 500, 100);
  tick('lighter', 500, 100);
  tick('rh', 500, 100);
  tick('entropy', 500, 100);

  // 事件 1：Binance 在 1000ms 先涨 +2.5 bps (跨越 2 bps 跟进线)，在 1200ms 涨到 +5 bps (触发 4 bps 阈值)
  // 若不做同门槛对齐（用触发点 1200ms 减），会错把 1120ms 跟进算成 -80ms；同门槛对齐应以 1000ms 为基准！
  tick('binance', 1_000, 100.025); // +2.5 bps => bnCrossMono = 1000
  tick('entropy', 1_120, 100.025); // 相对 1000ms 滞后 +120 ms
  tick('binance', 1_200, 100.05);  // +5.0 bps => triggerMono = 1200
  tick('lighter', 1_350, 100.03);  // 相对 1000ms 滞后 +350 ms
  tick('rh', 1_800, 100.04);       // 相对 1000ms 滞后 +800 ms

  // 事件 2（5000ms）：测试 DEX 提前于 Binance 变动（负延迟）与 RH 超时未跟进、Entropy 中途断线
  tick('binance', 4_500, 100.05);
  tick('lighter', 4_500, 100.05);
  tick('rh', 4_500, 100.05);
  tick('entropy', 4_500, 100.05);

  tick('lighter', 4_850, 100.025); // Lighter 在 Binance 暴跌前 150ms 提前跌 > 2 bps
  tick('binance', 5_000, 100.00);  // Binance 跌 5 bps => bnCrossMono = 5000, lighter lag = -150 ms
  tracker.setConnected('entropy', false, 5_200, '断线'); // Entropy 跟踪期间断线 => disconnected
  tracker.tickTimeouts(10_500); // RH 超过 5000ms 未跟进 => unfollowed

  const view = tracker.view(wall0 + 11_000, 11_000);
  assert.equal(view.eventCount, 2);

  const lStats = view.venues.find(v => v.venue === 'lighter')!;
  assert.equal(lStats.followed, 2);
  assert.equal(lStats.minMs, -150);
  assert.equal(lStats.maxMs, 350);
  assert.equal(lStats.medianMs, 100);
  assert.equal(lStats.bnLeadCount, 1);
  assert.equal(lStats.dexLeadCount, 1);
  assert.equal(lStats.followRate, 1);

  const rStats = view.venues.find(v => v.venue === 'rh')!;
  assert.equal(rStats.followed, 1);
  assert.equal(rStats.unfollowed, 1);
  assert.equal(rStats.medianMs, 800);
  assert.equal(rStats.followRate, 0.5);

  const eStats = view.venues.find(v => v.venue === 'entropy')!;
  assert.equal(eStats.followed, 1);
  assert.equal(eStats.disconnected, 1);
  assert.equal(eStats.followRate, 1, '中途断线不计入未跟进分母');

  // 验证最终结束将 pending 标为 cancelled
  tracker.finalize(wall0 + 12_000, 12_000, 'manual');
  const fin = tracker.view(wall0 + 12_000, 12_000);
  assert.equal(fin.status, 'stopped');
});

test('LeadTracker：合成 300ms 延迟波形的 500ms 互相关峰值精确命中 +300ms，不同面值不影响归一化与延迟', () => {
  const config = readLeadConfig({
    binanceSymbol: 'ANTUSDT',
    targets: { entropy: 'ANTH' },
    durationSec: 120,
    thresholdBps: 5,
    impulseWindowMs: 1000,
    followRatio: 0.5,
    maxWaitMs: 5000,
    cooldownMs: 2000,
  });
  const wall0 = 1_700_000_000_000;
  const tracker = new LeadTracker('lead-xcorr', config, wall0, 0);
  tracker.setConnected('binance', true, 0);
  tracker.setConnected('entropy', true, 0);

  // 制造 30 秒每 100ms 波动的序列，Entropy 滞后精确 300ms，且价格是 17.68 倍（模拟不同合约单位）
  const wave = (tMs: number) => 100 * (1 + 0.002 * Math.sin(tMs / 700) + 0.001 * Math.cos(tMs / 350));
  for (let t = 0; t <= 30_000; t += 100) {
    const bnMid = wave(t);
    const exMid = 17.68 * wave(Math.max(0, t - 300));
    tracker.onTick('binance', { monoMs: t, wallMs: wall0 + t, bid: bnMid - 0.01, ask: bnMid + 0.01, mid: bnMid, exchangeMs: null });
    tracker.onTick('entropy', { monoMs: t, wallMs: wall0 + t, bid: exMid - 0.1, ask: exMid + 0.1, mid: exMid, exchangeMs: null });
  }

  const view = tracker.view(wall0 + 30_000, 30_000);
  const ent = view.venues[0]!;
  assert.ok(ent.xcorr, '有效波形应算出互相关曲线');
  assert.equal(ent.xcorr!.peakLagMs, 300);
  assert.ok(ent.xcorr!.peakCorr > 0.95);
  // 差 17.68 倍单位时，不应给出错误基差
  assert.equal(view.streams.find(s => s.source === 'entropy')!.basisBps, null);
});

test('三个专用单标的 WS 客户端：Binance 过滤仅挂单量变化、Lighter O(1) 增量盘口与断档重订、Entropy 首档与 bbo', () => {
  const sockets: MockSocket[] = [];
  const connect = () => {
    const s = new MockSocket();
    sockets.push(s);
    return s;
  };
  let mono = 1000;

  // 1. BinanceBookTickerStream
  const bnTicks: [number, number][] = [];
  const bn = new BinanceBookTickerStream({
    symbol: 'BTCUSDT',
    connect,
    monoNow: () => mono,
    callbacks: { onStatus: () => {}, onTick: (b, a) => bnTicks.push([b, a]) },
  });
  bn.start();
  const bnSock = sockets[0]!;
  bnSock.open();
  assert.match(bnSock.sent[0]!, /btcusdt@bookTicker/);
  bnSock.push({ e: 'bookTicker', s: 'BTCUSDT', b: '100.0', B: '1', a: '100.2', A: '1', T: 10, E: 11 });
  bnSock.push({ e: 'bookTicker', s: 'BTCUSDT', b: '100.0', B: '9', a: '100.2', A: '8', T: 12, E: 13 }); // 仅量变，价格未变
  bnSock.push({ e: 'bookTicker', s: 'BTCUSDT', b: '100.1', B: '1', a: '100.2', A: '1', T: 14, E: 15 });
  assert.deepEqual(bnTicks, [[100, 100.2], [100.1, 100.2]]);
  bn.close();

  // 2. LighterOrderBookTopStream
  const ltTicks: [number, number][] = [];
  const lt = new LighterOrderBookTopStream({
    venue: 'lighter',
    marketId: 110,
    connect,
    monoNow: () => mono,
    callbacks: { onStatus: () => {}, onTick: (b, a) => ltTicks.push([b, a]) },
  });
  lt.start();
  const ltSock = sockets[1]!;
  ltSock.open();
  assert.match(ltSock.sent[0]!, /order_book\/110/);
  ltSock.push({
    type: 'subscribed/order_book',
    channel: 'order_book:110',
    order_book: { code: 0, nonce: 1, bids: [{ price: '100', size: '5' }, { price: '99', size: '5' }], asks: [{ price: '102', size: '5' }] },
  });
  // 删掉最优买档 100，应回扫得出 99
  ltSock.push({
    type: 'update/order_book',
    channel: 'order_book:110',
    order_book: { begin_nonce: 1, nonce: 2, bids: [{ price: '100', size: '0' }], asks: [] },
  });
  assert.deepEqual(ltTicks, [[100, 102], [99, 102]]);
  // nonce 断档应触发退订重订（过了退避期）
  mono += 10_000;
  ltSock.push({
    type: 'update/order_book',
    channel: 'order_book:110',
    order_book: { begin_nonce: 99, nonce: 100, bids: [{ price: '98', size: '1' }], asks: [] },
  });
  assert.ok(ltSock.sent.some(m => m.includes('unsubscribe')));
  lt.close();

  // 3. EntropyBboStream
  const entTicks: [number, number][] = [];
  const ent = new EntropyBboStream({
    coin: 'io:NVDA',
    connect,
    monoNow: () => mono,
    callbacks: { onStatus: () => {}, onTick: (b, a) => entTicks.push([b, a]) },
  });
  ent.start();
  const entSock = sockets[2]!;
  entSock.open();
  assert.ok(entSock.sent.some(m => m.includes('"type":"bbo"')));
  assert.ok(entSock.sent.some(m => m.includes('"type":"l2Book"')));
  entSock.push({ channel: 'post', data: { id: 1, response: { type: 'info', payload: { type: 'l2Book', data: { coin: 'io:NVDA', time: 10, levels: [[{ px: '180.1', sz: '1', n: 1 }], [{ px: '180.3', sz: '1', n: 1 }]] } } } } });
  entSock.push({ channel: 'bbo', data: { coin: 'io:NVDA', time: 20, bbo: [{ px: '180.2', sz: '1', n: 1 }, { px: '180.3', sz: '1', n: 1 }] } });
  assert.deepEqual(entTicks, [[180.1, 180.3], [180.2, 180.3]]);
  ent.close();
});

test('LeadTracker：静默 3 秒后单跳触发、提前抢跑排除旧噪声，以及 20 秒长静默基准结转', () => {
  const config = readLeadConfig({
    binanceSymbol: 'NVDAUSDT',
    targets: { lighter: 'NVDA', entropy: 'NVDA' },
    durationSec: 180,
    thresholdBps: 5,
    impulseWindowMs: 1_000,
    followRatio: 0.5, // followBps = 2.5 bps
    maxWaitMs: 5_000,
    cooldownMs: 2_000,
  });
  const wall0 = 1_700_000_000_000;
  const tracker = new LeadTracker('lead-silent', config, wall0, 0);
  for (const s of ['binance', 'lighter', 'entropy'] as const) tracker.setConnected(s, true, 0);

  const tick = (source: 'binance' | 'lighter' | 'entropy', mono: number, mid: number) =>
    tracker.onTick(source, { monoMs: mono, wallMs: wall0 + mono, bid: mid - 0.01, ask: mid + 0.01, mid, exchangeMs: null });

  // t=500 三方静默在 100
  tick('binance', 500, 100);
  tick('lighter', 500, 100);
  tick('entropy', 500, 100);

  // t=1000..1500 Entropy 有一次向下噪声后回到 100（距离未来 Binance 跃动 2.5s，超过 PRE_WINDOW）
  tick('entropy', 1_000, 99.95);
  tick('entropy', 1_500, 100);
  // Entropy 在 t=3300（Binance 前 200ms）先涨 +6 bps
  tick('entropy', 3_300, 100.06);

  // 静默 3 秒后 Binance 在 t=3500 单跳 +10 bps
  tick('binance', 3_500, 100.10);
  // Lighter 在 t=3680 滞后 +180ms 跟进
  tick('lighter', 3_680, 100.06);

  const v1 = tracker.view(wall0 + 4_000, 4_000);
  assert.equal(v1.eventCount, 1);
  assert.equal(v1.venues.find(v => v.venue === 'lighter')!.medianMs, 180);
  assert.equal(v1.venues.find(v => v.venue === 'entropy')!.medianMs, -200);

  // 再静默 20 秒（超过原 15s 错误窗口），在 t=23_500 单跳回落 -10 bps
  tick('lighter', 23_000, 100.06);
  tick('binance', 23_500, 100.00);
  tick('lighter', 23_620, 100.01);

  const v2 = tracker.view(wall0 + 24_000, 24_000);
  assert.equal(v2.eventCount, 2);
  assert.equal(v2.events[0]!.venues.lighter!.lagMs, 120);
});

test('LeadTracker：安静在线 20 秒走势不假断线，真正断线区间留空，盘口倒挂不发错误报价', () => {
  const config = readLeadConfig({
    binanceSymbol: 'BTCUSDT',
    targets: { lighter: 'BTC', entropy: 'BTC' },
    durationSec: 120,
    thresholdBps: 5,
    impulseWindowMs: 1_000,
    followRatio: 0.5,
    maxWaitMs: 5_000,
    cooldownMs: 2_000,
  });
  const wall0 = 1_700_000_000_000;
  const tracker = new LeadTracker('lead-series', config, wall0, 0);
  for (const s of ['binance', 'lighter', 'entropy'] as const) tracker.setConnected(s, true, 0);
  const tick = (source: 'binance' | 'lighter' | 'entropy', mono: number, mid: number) =>
    tracker.onTick(source, { monoMs: mono, wallMs: wall0 + mono, bid: mid - 0.1, ask: mid + 0.1, mid, exchangeMs: null });

  tick('binance', 0, 100);
  tick('lighter', 0, 100);
  tick('entropy', 0, 100);

  // Entropy 在 t=5000 断线，t=8000 重连并直到 t=8500 才收到报价
  tracker.setConnected('entropy', false, 5_000, '网络断开');
  tracker.setConnected('entropy', true, 8_000);
  tick('entropy', 8_500, 100.05);

  // Lighter 和 Binance 安静保持 20 秒无新 tick，仅于 t=20000 推进视图
  const view = tracker.view(wall0 + 20_000, 20_000);
  assert.ok(view.series.length >= 100);
  assert.ok(view.series.every(pt => pt.binance !== null && pt.lighter !== null), '在线静默 20s 走势不应出现 null 假断线');
  const downStartWall = wall0 + 5_200;
  const downEndWall = wall0 + 7_800;
  const gapPts = view.series.filter(pt => pt.t >= downStartWall && pt.t <= downEndWall);
  assert.ok(gapPts.length > 0 && gapPts.every(pt => pt.entropy === null), '真实断线区间应留空');
  assert.ok(view.series.at(-1)!.entropy !== null, '重连后曲线应恢复');

  // Lighter 盘口倒挂保护：不撤旧卖一时 bestBid > bestAsk，拒绝发错价
  const ltTicks: [number, number][] = [];
  let mono = 1000;
  const sockList: MockSocket[] = [];
  const lt = new LighterOrderBookTopStream({
    venue: 'lighter',
    marketId: 1,
    connect: () => {
      const s = new MockSocket();
      sockList.push(s);
      return s;
    },
    monoNow: () => mono,
    callbacks: { onStatus: () => {}, onTick: (b, a) => ltTicks.push([b, a]) },
  });
  lt.start();
  sockList[0]!.open();
  sockList[0]!.push({ type: 'subscribed/order_book', channel: 'order_book:1', order_book: { code: 0, nonce: 1, bids: [{ price: '180.00', size: '5' }], asks: [{ price: '180.02', size: '5' }] } });
  sockList[0]!.push({ type: 'update/order_book', channel: 'order_book:1', order_book: { begin_nonce: 1, nonce: 2, bids: [{ price: '180.10', size: '5' }], asks: [{ price: '180.12', size: '5' }] } });
  assert.deepEqual(ltTicks, [[180, 180.02]]);
  lt.close();
});

test('引擎与 DEX 路由端到端：拉取目录、启动、单活拦截(409)、错误 sessionId 停止拦截(L202)、落盘历史、到期结算与关闭清理', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tp-lead-e2e-'));
  const sockets: MockSocket[] = [];
  let wall = 1_700_000_000_000;
  let engine: ReturnType<typeof createVarLighterEngine> | undefined;
  let eng2: ReturnType<typeof createVarLighterEngine> | undefined;
  try {
    const fetchImpl = async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === BINANCE_FAPI_EXCHANGE_INFO) {
        return Response.json({
          symbols: [
            { symbol: 'NVDAUSDT', baseAsset: 'NVDA', quoteAsset: 'USDT', marginAsset: 'USDT', contractType: 'TRADIFI_PERPETUAL', status: 'TRADING' },
          ],
        });
      }
      if (url.includes('orderBookDetails')) {
        return Response.json({
          code: 200,
          order_book_details: [
            { symbol: 'NVDA', market_id: 110, market_type: 'perp', status: 'active', size_decimals: 2, price_decimals: 2, min_base_amount: '0.1', min_quote_amount: '10', taker_fee: '0', maker_fee: '0', mark_price: '180' },
          ],
        });
      }
      if (url.includes('hyperliquid')) {
        return Response.json([{ universe: [{ name: 'io:NVDA', szDecimals: 2 }], collateralToken: 0 }, [{ markPx: '180', oraclePx: '180', funding: '0' }]]);
      }
      return Response.json({ listings: [] });
    };

    const holder = openVarLighter(dir, {
      fetchImpl: fetchImpl as typeof fetch,
      connect: () => {
        const s = new MockSocket();
        sockets.push(s);
        return s;
      },
      now: () => wall,
      monoNow: () => wall - 1_700_000_000_000,
    }, () => {});
    engine = holder.engine!;
    await engine.refreshCatalog(AbortSignal.timeout(5_000), 'lighter');
    const views = varLighterViews(holder);
    const forward = localDexForward(views, () => {});

    const refreshed = await forward.page({ method: 'POST', path: 'lead/catalog', query: [] });
    assert.equal(refreshed.status, 200);
    const lead0 = refreshed.body as LeadView;
    assert.equal(lead0.catalog.count, 1);
    assert.equal(lead0.candidates[0]!.symbol, 'NVDAUSDT');

    // 未知市场拒绝 400
    const badStart = await forward.page({ method: 'POST', path: 'lead/start', query: [], body: { binanceSymbol: 'NVDAUSDT', targets: { lighter: 'UNKNOWN' } } });
    assert.equal(badStart.status, 400);

    // 启动（durationSec=30 验证最短合规边界与自动到期结算）
    const started = await forward.page({ method: 'POST', path: 'lead/start', query: [], body: { binanceSymbol: 'NVDAUSDT', targets: { lighter: 'NVDA' }, durationSec: 30 } });
    assert.equal(started.status, 200);
    const sView = started.body as LeadView;
    assert.ok(sView.active);
    const sessionId = sView.active!.id;
    assert.equal(sockets.length, 2);
    for (const s of sockets) s.open();

    // 运行中重复启动拦截 409
    const dupStart = await forward.page({ method: 'POST', path: 'lead/start', query: [], body: { binanceSymbol: 'NVDAUSDT', targets: { lighter: 'NVDA' } } });
    assert.equal(dupStart.status, 409);

    // 错 sessionId 停止拦截 409 (L202)
    const wrongStop = await forward.page({ method: 'POST', path: 'lead/stop', query: [], body: { sessionId: 'wrong-id' } });
    assert.equal(wrongStop.status, 409);

    // 推入行情脉冲（清掉旧买卖一档避免倒挂）并正确停止
    sockets[0]!.push({ e: 'bookTicker', s: 'NVDAUSDT', b: '180.00', B: '1', a: '180.02', A: '1' });
    sockets[1]!.push({ type: 'subscribed/order_book', channel: 'order_book:110', order_book: { code: 0, nonce: 1, bids: [{ price: '180.00', size: '5' }], asks: [{ price: '180.02', size: '5' }] } });
    wall += 500;
    sockets[0]!.push({ e: 'bookTicker', s: 'NVDAUSDT', b: '180.10', B: '1', a: '180.12', A: '1' });
    wall += 200;
    sockets[1]!.push({
      type: 'update/order_book',
      channel: 'order_book:110',
      order_book: {
        begin_nonce: 1,
        nonce: 2,
        bids: [{ price: '180.00', size: '0' }, { price: '180.10', size: '5' }],
        asks: [{ price: '180.02', size: '0' }, { price: '180.12', size: '5' }],
      },
    });

    const stopped = await forward.page({ method: 'POST', path: 'lead/stop', query: [], body: { sessionId } });
    assert.equal(stopped.status, 200);
    const endView = stopped.body as LeadView;
    assert.equal(endView.active, null);
    assert.ok(endView.last);
    assert.equal(endView.last!.venues[0]!.medianMs, 200);
    assert.equal(endView.history.length, 1);
    assert.ok(sockets.every(s => s.closed), '停止后关闭全部 WS');

    // 验证到期自动结算（推进虚拟单调时间超过 30 秒，等待 1s 定时周期触发 completed）
    const started2 = await forward.page({ method: 'POST', path: 'lead/start', query: [], body: { binanceSymbol: 'NVDAUSDT', targets: { lighter: 'NVDA' }, durationSec: 30 } });
    assert.equal(started2.status, 200);
    wall += 31_000;
    await new Promise(resolve => setTimeout(resolve, 1_150));
    const afterExpire = engine.views.lead() as LeadView;
    assert.equal(afterExpire.active, null);
    assert.equal(afterExpire.last?.status, 'completed');
    assert.equal(afterExpire.history.length, 2);
    assert.ok(sockets.slice(2).every(s => s.closed), '到期自动结算应关闭全部 WS');

    engine.close();
    engine = undefined;

    // 重新打开库，历史仍在；清空历史后删空
    const reopened = openVarLighterStore(path.join(dir, 'varlighter.sqlite'));
    eng2 = createVarLighterEngine({ store: reopened, fetchImpl: fetchImpl as typeof fetch, now: () => wall });
    const v2 = eng2.views.lead() as LeadView;
    assert.equal(v2.history.length, 2);
    const cleared = eng2.views.leadClear() as LeadView;
    assert.equal(cleared.history.length, 0);
    eng2.close();
    eng2 = undefined;
  } finally {
    try { engine?.close(); } catch { /* 已关闭 */ }
    try { eng2?.close(); } catch { /* 已关闭 */ }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('P1 #1 回归与保活：静默后微调点差前 DEX 抢跑精准捕获 −300ms，confirmAlive 超 60s 保活不膨胀频次，互相关缓存一致', () => {
  const config = readLeadConfig({
    binanceSymbol: 'NVDAUSDT',
    targets: { entropy: 'NVDA' },
    durationSec: 180,
    thresholdBps: 5,
    impulseWindowMs: 1_000,
    followRatio: 0.5, // followBps = 2.5 bps
    maxWaitMs: 5_000,
    cooldownMs: 2_000,
  });
  const wall0 = 1_700_000_000_000;
  const tracker = new LeadTracker('lead-p1', config, wall0, 0);
  tracker.setConnected('binance', true, 0);
  tracker.setConnected('entropy', true, 0);
  const tick = (source: 'binance' | 'entropy', mono: number, mid: number) =>
    tracker.onTick(source, { monoMs: mono, wallMs: wall0 + mono, bid: mid - 0.01, ask: mid + 0.01, mid, exchangeMs: null });

  // t=500 静默，DEX t=3200 提前抢跑 +6bps；Binance 在 t=3450 收到微幅点差更新 99.998，t=3500 跃动 100.10
  tick('binance', 500, 100.00);
  tick('entropy', 500, 100.00);
  tick('entropy', 3_200, 100.06);
  tick('binance', 3_450, 99.998);
  tick('binance', 3_500, 100.10);

  const v1 = tracker.view(wall0 + 3_600, 3_600);
  assert.equal(v1.eventCount, 1);
  assert.equal(v1.venues[0]!.medianMs, -300, 't=3450 微幅更新后仍须回延到 preFloor=2000 捕获 t=3200 抢跑');

  // 停摆期间 Binance 在 t=40s 仍停在 100.10，而 Entropy 自 3.2s 起长达 67s 无真价变，仅于 45s 触发 confirmAlive 保活
  tick('binance', 40_000, 100.10);
  tracker.confirmAlive('entropy', 45_000, wall0 + 45_000);
  const vSilent = tracker.view(wall0 + 70_000, 70_000);
  const entStream = vSilent.streams.find(s => s.source === 'entropy')!;
  assert.equal(entStream.ticks, 2, 'confirmAlive 不得虚增价变计数');
  assert.equal(entStream.ticksPerSec, 0, '最近 10s 无真价变时频次应为 0');
  assert.ok(vSilent.series.at(-1)!.entropy !== null, '保活后近 60s 曲线末尾应保持在线不留空');

  // 第 2 次触发跃动，Entropy 67s 无真价变仍应有有效的 baseMid（非 no_data）
  tick('binance', 70_500, 100.20);
  tick('entropy', 70_650, 100.12);
  const v2 = tracker.view(wall0 + 71_000, 71_000);
  assert.equal(v2.venues[0]!.noData, 0);
  assert.equal(v2.venues[0]!.followed, 2);

  // 同快照下互相关结果在缓存命中与重算间完全一致
  const v2Repeat = tracker.view(wall0 + 71_000, 71_000);
  assert.deepEqual(v2Repeat.venues[0]!.xcorr, v2.venues[0]!.xcorr);
});

test('P1 #2 目录边界与历史过滤：超限 8MB、并发去重、30s 退避、anySignal 超时与损坏历史剔除', async t => {
  assert.ok(CATALOG_TIMEOUT_MS < 10_000, '目录请求超时须严格小于 DEX IPC 读超时 10s');
  const dir = mkdtempSync(path.join(tmpdir(), 'tp-lead-cat-'));
  let store: ReturnType<typeof openVarLighterStore> | undefined;
  let tester: ReturnType<typeof createLeadTester> | undefined;
  try {
    store = openVarLighterStore(path.join(dir, 'varlighter.sqlite'));
    const validHist = {
      id: 'ok-1', status: 'stopped',
      config: readLeadConfig({ binanceSymbol: 'BTCUSDT', targets: { lighter: 'BTC' } }),
      startedAt: 1000, finishedAt: 2000, elapsedMs: 1000, eventCount: 0, venues: [],
    };
    const badNestedHist = { ...validHist, id: 'bad-nested', venues: [null] };
    store.setState(LEAD_HISTORY_KEY, [null, { id: 'broken' }, badNestedHist, validHist], 1000);

    let wall = 1_700_000_000_000;
    let mode: 'big' | 'ok' | 'hang' = 'ok';
    let fetchCount = 0;
    let lastSignalAborted = false;
    const fetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
      fetchCount++;
      if (mode === 'big') {
        const chunk = new Uint8Array(2 * 1024 * 1024);
        let n = 0;
        return new Response(new ReadableStream({
          pull(controller) {
            if (n++ < 5) controller.enqueue(chunk);
            else controller.close();
          },
        }), { status: 200 });
      }
      if (mode === 'hang') {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            lastSignalAborted = true;
            reject(new Error('请求已中止'));
          }, { once: true });
        });
      }
      return Response.json({
        symbols: [{ symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', marginAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING' }],
      });
    };

    tester = createLeadTester({
      store,
      fetchImpl: fetchImpl as typeof fetch,
      connect: () => new MockSocket(),
      now: () => wall,
      monoNow: () => wall - 1_700_000_000_000,
      log: () => {},
      dexMarkets: () => ({ lighter: [spec('lighter', 'BTC', 1)], rh: [], entropy: [] }),
    });

    assert.deepEqual(tester.view().history.map(h => h.id), ['ok-1'], '损坏历史记录应被剔除');

    // view() 触发的 loadCatalog 与手动 refreshCatalog() 并发去重复用
    await tester.refreshCatalog();
    assert.equal(fetchCount, 1);

    // 8MB 超限报错与 30s 节流退避
    mode = 'big';
    wall += 600_001;
    const bigView = await tester.refreshCatalog();
    assert.ok(bigView.catalog.error, '超过 8MB 应记入错误');
    assert.equal(fetchCount, 2);
    tester.view();
    assert.equal(fetchCount, 2, '30 秒退避期内 view() 不得重复请求');

    // 超过 30 秒且换回正常目录后 view() 重新发起并恢复
    mode = 'ok';
    wall += 31_000;
    tester.view();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(fetchCount, 3);
    assert.equal(tester.view().catalog.error, null);

    // anySignal 在 CATALOG_TIMEOUT_MS 触发超时中止
    mode = 'hang';
    wall += 600_001;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pendingRefresh = tester.refreshCatalog();
    t.mock.timers.tick(CATALOG_TIMEOUT_MS + 50);
    const timedOutView = await pendingRefresh;
    t.mock.timers.reset();
    assert.ok(lastSignalAborted, 'anySignal 超时应中止底层 fetch');
    assert.ok(timedOutView.catalog.error);
  } finally {
    tester?.close();
    store?.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('P2 流状态机：在连错误保留、Dead 连接超时与静默重连、Entropy 45s l2Book 保活与 Lighter 裁盘重订', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const sockets: MockSocket[] = [];
  const connect = () => {
    const s = new MockSocket();
    sockets.push(s);
    return s;
  };
  let mono = 0;

  // 1. Binance 在连错误帧保留 lastError，新 tick 到来后清除；不握手超时重连
  const tracker = new LeadTracker('lead-err', readLeadConfig({ binanceSymbol: 'BTCUSDT', targets: { entropy: 'BTC' } }), 1_700_000_000_000, 0);
  const bn = new BinanceBookTickerStream({
    symbol: 'BTCUSDT',
    connect,
    monoNow: () => mono,
    callbacks: {
      onStatus: (c, e, r) => tracker.setConnected('binance', c, mono, e, r),
      onTick: (b, a, ex) => tracker.onTick('binance', { monoMs: mono, wallMs: 1_700_000_000_000 + mono, bid: b, ask: a, mid: (b + a) / 2, exchangeMs: ex }),
    },
  });
  bn.start();
  const s0 = sockets[0]!;
  s0.open();
  s0.push({ error: { code: -1121, msg: 'Invalid symbol.' } });
  const vErr = tracker.view(1_700_000_000_000, mono);
  const bnErr = vErr.streams.find(s => s.source === 'binance')!;
  assert.equal(bnErr.connected, true);
  assert.match(bnErr.lastError ?? '', /Invalid symbol/);
  mono += 100;
  s0.push({ e: 'bookTicker', s: 'BTCUSDT', b: '100', B: '1', a: '101', A: '1' });
  assert.equal(tracker.view(1_700_000_000_100, mono).streams.find(s => s.source === 'binance')!.lastError, null, '收到正常 tick 后应清除错误');
  bn.close();

  // 死连接（一直不触发 open）在 CONNECT_TIMEOUT_MS 后超时并调度重连
  const beforeDead = sockets.length;
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
  assert.ok(sockets.length > beforeDead && deadStatuses.some(x => x[1] === '连接超时' && x[2] >= 1));
  dead.close();

  // 2. EntropyBboStream 在 45s 无价格变化后发出定期 l2Book 保活，同价触发 onHeartbeat
  let heartbeats = 0;
  const ent = new EntropyBboStream({
    coin: 'io:BTC', connect, monoNow: () => mono,
    callbacks: { onStatus: () => {}, onTick: () => {}, onHeartbeat: () => { heartbeats++; } },
  });
  ent.start();
  const entSock = sockets.at(-1)!;
  entSock.open();
  entSock.push({ channel: 'post', data: { id: 1, response: { type: 'info', payload: { type: 'l2Book', data: { coin: 'io:BTC', time: 10, levels: [[{ px: '100', sz: '1', n: 1 }], [{ px: '101', sz: '1', n: 1 }]] } } } } });
  const initialPosts = entSock.sent.filter(m => m.includes('"l2Book"')).length;
  for (let i = 0; i < Math.ceil(ENTROPY_CONFIRM_MS / 1_000) + 1; i++) {
    mono += 1_000;
    t.mock.timers.tick(1_000);
    // 每 10 秒模拟 pong 保住 silenceMs，仅检验无报价变动触发 l2Book 保活
    if (i % 10 === 0) entSock.push({ channel: 'pong' });
  }
  const afterPosts = entSock.sent.filter(m => m.includes('"l2Book"')).length;
  assert.ok(afterPosts > initialPosts, '静默超过 ENTROPY_CONFIRM_MS 应补发 l2Book 保活');
  entSock.push({ channel: 'post', data: { id: 2, response: { type: 'info', payload: { type: 'l2Book', data: { coin: 'io:BTC', time: 20, levels: [[{ px: '100', sz: '1', n: 1 }], [{ px: '101', sz: '1', n: 1 }]] } } } } });
  assert.equal(heartbeats, 1, '同价 l2Book 确认帧应走 onHeartbeat 而非丢弃');
  ent.close();

  // 3. LighterOrderBookTopStream 超阈值裁盘后变浅触发退订重订
  const lt = new LighterOrderBookTopStream({
    venue: 'lighter', marketId: 9, connect, monoNow: () => mono,
    callbacks: { onStatus: () => {}, onTick: () => {} },
  });
  lt.start();
  const ltSock = sockets.at(-1)!;
  ltSock.open();
  const manyBids = Array.from({ length: BOOK_KEEP_LEVELS + 1_005 }, (_, i) => ({ price: String(10_000 - i * 0.01), size: '1' }));
  ltSock.push({ type: 'subscribed/order_book', channel: 'order_book:9', order_book: { code: 0, nonce: 1, bids: manyBids, asks: [{ price: '10100', size: '1' }] } });
  mono += 10_000; // 越过 BOOK_RESYNC_MIN_MS 以便立即重订
  const dropBids = manyBids.slice(0, 3_600).map(b => ({ price: b.price, size: '0' }));
  ltSock.push({ type: 'update/order_book', channel: 'order_book:9', order_book: { begin_nonce: 1, nonce: 2, bids: dropBids, asks: [] } });
  assert.ok(ltSock.sent.some(m => m.includes('unsubscribe')), '裁盘后有效档位低于半数应退订重订');
  lt.close();

  // 4. 无效/倒挂 bbo 不得延后 Entropy lastTopAt 保活探测；跨断线 segId 不得算出伪相关性
  const invEnt = new EntropyBboStream({ coin: 'io:NVDA', connect, monoNow: () => mono, callbacks: { onStatus: () => {}, onTick: () => {} } });
  invEnt.start();
  const invSock = sockets.at(-1)!;
  invSock.open();
  invSock.push({ channel: 'post', data: { id: 1, response: { type: 'info', payload: { type: 'l2Book', data: { coin: 'io:NVDA', time: 1, levels: [[{ px: '100', sz: '1', n: 1 }], [{ px: '101', sz: '1', n: 1 }]] } } } } });
  for (let i = 0; i < 40; i++) {
    mono += 1_000;
    t.mock.timers.tick(1_000);
    if (i % 10 === 0) invSock.push({ channel: 'pong' });
  }
  const postsBeforeInvalid = invSock.sent.filter(m => m.includes('"l2Book"')).length;
  // 在第 40s 推一条倒挂 bbo（bid > ask），emitTop 丢弃且不应重置 lastTopAt
  invSock.push({ channel: 'bbo', data: { coin: 'io:NVDA', time: 2, bbo: [{ px: '105', sz: '1', n: 1 }, { px: '101', sz: '1', n: 1 }] } });
  for (let i = 0; i < 7; i++) {
    mono += 1_000;
    t.mock.timers.tick(1_000);
  }
  assert.ok(invSock.sent.filter(m => m.includes('"l2Book"')).length > postsBeforeInvalid, '倒挂无效 bbo 不应推迟 l2Book 保活');
  invEnt.close();

  // 跨断线 segId 互相关保护：两段均为平台价、中间因断线跳价 200bps，不得把跨断线跳变算成高度相关
  const segTracker = new LeadTracker('lead-seg', readLeadConfig({ binanceSymbol: 'BTCUSDT', targets: { lighter: 'BTC' } }), 1_700_000_000_000, 0);
  for (const s of ['binance', 'lighter'] as const) segTracker.setConnected(s, true, 0);
  for (let ts = 0; ts <= 8_000; ts += 100) {
    segTracker.onTick('binance', { monoMs: ts, wallMs: ts, bid: 100, ask: 100.1, mid: 100, exchangeMs: null });
    segTracker.onTick('lighter', { monoMs: ts, wallMs: ts, bid: 100, ask: 100.1, mid: 100, exchangeMs: null });
  }
  segTracker.setConnected('binance', false, 8_200, 'drop');
  segTracker.setConnected('lighter', false, 8_200, 'drop');
  segTracker.setConnected('binance', true, 10_000);
  segTracker.setConnected('lighter', true, 10_000);
  for (let ts = 10_000; ts <= 18_000; ts += 100) {
    segTracker.onTick('binance', { monoMs: ts, wallMs: ts, bid: 102, ask: 102.1, mid: 102, exchangeMs: null });
    segTracker.onTick('lighter', { monoMs: ts, wallMs: ts, bid: 102, ask: 102.1, mid: 102, exchangeMs: null });
  }
  const segXcorr = segTracker.view(1_700_000_018_000, 18_000).venues[0]!;
  assert.equal(segXcorr.xcorr, null, '跨断线两段平稳期不得用断线跳变计算互相关');
  assert.match(segXcorr.xcorrReason ?? '', /波动/);

  t.mock.timers.reset();
});
