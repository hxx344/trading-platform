// Var/Lighter 价差模块（docs/varlighter.md）：解析、时段、基线、策略盈亏、回测不看未来、Lighter 一档连续性、盘口快照与多场所引擎端到端。
// 行情都是假的：fetch 与 WebSocket 由测试替换，不连任何外部服务。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pairMarkets, parsePairKey, parseRhMarkets, parseVarListings, parseVarQuote, regimeOf, spreadOf, midBasis, type Sample } from '../src/varlighter/model.ts';
import { BaselineTracker, RollingWindow, regimeStats, suggestedEntryBps } from '../src/varlighter/stats.ts';
import { DEFAULT_GLOBAL, DEFAULT_SYMBOL, closePosition, decide, openBlocker, openPosition, positionSpread, readGlobalParams, readSymbolParams, type Position, type SymbolParams } from '../src/varlighter/strategy.ts';
import { backtestRequest, runBacktest } from '../src/varlighter/backtest.ts';
import { CONNECT_TIMEOUT_MS, DEPTH_MAX_GAP_MS, LighterStream, depthAt, depthSnapshot, parseBookOrders, vwap, type SocketLike } from '../src/varlighter/feeds.ts';
import { orderPlan } from '../src/varlighter/plan.ts';
import { openVarLighterStore } from '../src/varlighter/store.ts';
import { createVarLighterEngine, downsample } from '../src/varlighter/engine.ts';
import { openVarLighter, varLighterLoop, varLighterViews } from '../src/service/varlighter.ts';

const T0 = Date.parse('2026-11-23T15:00:00Z'); // 周一纽约 10:00（盘中）

function sample(t: number, varMid: number, rhMid = 100, extra: Partial<Sample> = {}): Sample {
  return {
    symbol: 'BTC', t, receivedAt: t + 1_000, regime: 'all', varMark: varMid,
    varBid0: varMid - 0.01, varAsk0: varMid + 0.01, varBid1k: varMid - 0.02, varAsk1k: varMid + 0.02, varBid100k: varMid - 0.05, varAsk100k: varMid + 0.05, varFunding: 0.1,
    rhAt: t - 500, rhBid0: rhMid - 0.01, rhAsk0: rhMid + 0.01, rhMark: rhMid, rhIndex: rhMid, rhFunding: 0.0001,
    rhBid1k: rhMid - 0.02, rhAsk1k: rhMid + 0.02, rhBid100k: null, rhAsk100k: null, ...extra,
  };
}

test('Var 报价：三档完整且不倒挂才用，过旧或时刻在未来的不用', () => {
  const now = T0;
  const quotes = (at: number, base = { bid: '99', ask: '101' }) => ({ updated_at: new Date(at).toISOString(), base, size_1k: { bid: '98.9', ask: '101.1' }, size_100k: { bid: '98', ask: '102' } });
  assert.deepEqual(parseVarQuote(quotes(now - 30_000), now), { at: now - 30_000, bid0: 99, ask0: 101, bid1k: 98.9, ask1k: 101.1, bid100k: 98, ask100k: 102 });
  assert.equal(parseVarQuote(quotes(now - 11 * 60_000), now), null);
  assert.equal(parseVarQuote(quotes(now + 10_000), now), null);
  assert.equal(parseVarQuote(quotes(now, { bid: '98.95', ask: '101' }), now)?.bid0, 98.95);
  assert.equal(parseVarQuote(quotes(now, { bid: '98.8', ask: '101' }), now), null, '1k 档买价高于一档买价说明不是同一时刻');
  const listings = parseVarListings({ listings: [{ ticker: 'BTC', name: 'Bitcoin', mark_price: '100', funding_rate: '0.1095', funding_interval_s: 28800, quotes: quotes(now) }, { ticker: 'bad ticker', mark_price: '1' }, { ticker: 'ETH', mark_price: 'x' }] }, now);
  assert.equal(listings.length, 1);
  assert.equal(listings[0].fundingRate, 0.1095);
  assert.throws(() => parseVarListings({}, now), /listings/);
});

test('配对：同代码、在交易的永续；价格相差过大判为规格不同，未核对的待确认', () => {
  const markets = parseRhMarkets({ code: 200, order_book_details: [
    { symbol: 'BTC', market_id: 1, market_type: 'perp', status: 'active', size_decimals: 5, price_decimals: 1, min_base_amount: '0.0002', min_quote_amount: '10', taker_fee: '0.0000', maker_fee: '0.0000', mark_price: '100' },
    { symbol: 'OPENAI', market_id: 2, market_type: 'perp', status: 'active', size_decimals: 2, price_decimals: 3, min_base_amount: '1', min_quote_amount: '10', mark_price: '100' },
    { symbol: 'NEWCOIN', market_id: 3, market_type: 'perp', status: 'active', size_decimals: 0, price_decimals: 4, min_base_amount: '1', min_quote_amount: '10', mark_price: '1' },
    { symbol: 'OLD', market_id: 4, market_type: 'perp', status: 'inactive', size_decimals: 0, price_decimals: 4 },
    { symbol: 'SPOT', market_id: 5, market_type: 'spot', status: 'active', size_decimals: 0, price_decimals: 4 },
  ] });
  assert.deepEqual(markets.map(market => market.symbol), ['BTC', 'OPENAI', 'NEWCOIN']);
  assert.equal(markets[0].takerFeeBps, 0);
  const listing = (ticker: string, mark: number) => ({ ticker, name: ticker, mark, fundingRate: null, fundingIntervalS: null, quote: null });
  const pairs = pairMarkets([listing('BTC', 100.2), listing('OPENAI', 92), listing('NEWCOIN', 1.001), listing('ETH', 3000)], markets);
  assert.deepEqual(pairs.map(pair => [pair.key, pair.identity, pair.kind]), [['rh:BTC', 'verified', 'crypto'], ['rh:NEWCOIN', 'review', 'other'], ['rh:OPENAI', 'mismatch', 'other']]);
  // 主网同一份目录格式，配对键带场所；同一代码在两个场所是两个配对。
  const main = pairMarkets([listing('BTC', 100.2)], markets, 'lighter');
  assert.deepEqual(main.map(pair => [pair.key, pair.venue, pair.symbol]), [['lighter:BTC', 'lighter', 'BTC']]);
  assert.deepEqual(parsePairKey('lighter:1000PEPE'), { venue: 'lighter', symbol: '1000PEPE' });
  assert.equal(parsePairKey('BTC'), null);
  assert.equal(parsePairKey('binance:BTC'), null);
  assert.throws(() => parseRhMarkets({ code: 500 }, 'lighter'), /^Error: Lighter 合约目录格式无效$/);
});

test('时段：纽约时间的美股盘中、盘前盘后、夜盘、周末，夏令时与贵金属周末', () => {
  const at = (iso: string) => Date.parse(iso);
  assert.equal(regimeOf('equity', at('2026-11-23T15:00:00Z')), 'rth');        // 周一 10:00 EST
  assert.equal(regimeOf('equity', at('2026-11-23T14:29:00Z')), 'ext');        // 9:29
  assert.equal(regimeOf('equity', at('2026-11-23T21:30:00Z')), 'ext');        // 16:30
  assert.equal(regimeOf('equity', at('2026-11-24T03:00:00Z')), 'overnight');  // 周一 22:00
  assert.equal(regimeOf('equity', at('2026-11-23T02:00:00Z')), 'overnight');  // 周日 21:00
  assert.equal(regimeOf('equity', at('2026-11-22T23:00:00Z')), 'weekend');    // 周日 18:00
  assert.equal(regimeOf('equity', at('2026-11-28T02:00:00Z')), 'weekend');    // 周五 21:00
  assert.equal(regimeOf('equity', at('2026-07-06T14:00:00Z')), 'rth');        // 周一 10:00 EDT
  assert.equal(regimeOf('metal', at('2026-11-27T22:30:00Z')), 'weekend');     // 周五 17:30
  assert.equal(regimeOf('metal', at('2026-11-29T23:30:00Z')), 'weekday');     // 周日 18:30
  assert.equal(regimeOf('crypto', at('2026-11-28T12:00:00Z')), 'all');
});

test('价差口径：卖 Var 用 Var 买价减 Lighter 卖价，买 Var 用 Var 卖价减 Lighter 买价，相对 Lighter 中间价', () => {
  const value = sample(T0, 100.5);
  assert.ok(Math.abs(midBasis(value) - 50) < 1e-9);
  const spread = spreadOf(value, '1k')!;
  assert.ok(Math.abs(spread.sellVar - (100.48 - 100.02) / 100 * 1e4) < 1e-9);
  assert.ok(Math.abs(spread.buyVar - (100.52 - 99.98) / 100 * 1e4) < 1e-9);
  assert.equal(spread.estimated, false);
  assert.equal(spreadOf(value, '100k'), null, '100k 档需要 Lighter 完整盘口');
  assert.equal(spreadOf(sample(T0, 100, 100, { rhBid1k: null, rhAsk1k: null }), '1k')!.estimated, true);
});

test('滚动基线：精确中位数、按时间淘汰，当前时段不足时退回全天', () => {
  const window = new RollingWindow(10 * 60_000);
  for (let index = 0; index < 20; index++) window.push(T0 + index * 60_000, index);
  assert.equal(window.size, 11);
  assert.equal(window.median(), 14);
  const tracker = new BaselineTracker('equity', 3_600_000, 5);
  for (let index = 0; index < 6; index++) tracker.push({ ...sample(T0 + index * 60_000, 100.1), regime: 'rth' });
  assert.equal(tracker.value('rth', T0 + 6 * 60_000)?.fallback, false);
  const fallback = tracker.value('ext', T0 + 6 * 60_000)!;
  assert.equal(fallback.regime, 'all');
  assert.equal(fallback.fallback, true);
  assert.equal(tracker.value('rth', T0 + 3 * 3_600_000), null, '窗口外的样本全部淘汰');
});

test('基线统计：AR(1) 半衰期与入场建议', () => {
  const phi = 0.8, samples: Sample[] = [];
  let x = 0, seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31 - 0.5; };
  for (let index = 0; index < 2000; index++) { x = phi * x + random() * 4; samples.push(sample(T0 + index * 60_000, 100 * (1 + (10 + x) / 1e4))); }
  const stats = regimeStats('all', samples, 5);
  const expected = -Math.log(2) / Math.log(phi);
  assert.ok(stats.halfLifeMin !== null && Math.abs(stats.halfLifeMin - expected) < 0.8, `半衰期 ${stats.halfLifeMin}，应约 ${expected}`);
  assert.ok(Math.abs(stats.median! - 10) < 0.5);
  assert.ok(stats.costMedian! > 7 && stats.costMedian! < 9);
  assert.ok(stats.crossingsPerDay! > 10);
  assert.ok(suggestedEntryBps(stats)! >= 5);
});

test('参数校验：出场须小于入场，未知字段与越界拒绝', () => {
  assert.throws(() => readSymbolParams({ entryBps: 5, exitBps: 5 }), /出场偏离/);
  assert.throws(() => readSymbolParams({ foo: 1 }), /未知字段/);
  assert.throws(() => readSymbolParams({ notionalUsd: 1e9 }), /名义金额/);
  assert.throws(() => readSymbolParams({ directions: [] }), /方向/);
  assert.equal(readSymbolParams({ entryBps: 20 }).entryBps, 20);
  assert.equal(readGlobalParams({ paused: true }).paused, true);
  assert.throws(() => readGlobalParams({ windowHours: 0 }), /基线窗口/);
});

test('开平仓：Var 偏贵卖 Var 买 Lighter，回到基线平仓，按两腿成交价与四次成交成本结算', () => {
  const params: SymbolParams = { ...DEFAULT_SYMBOL, enabled: true, entryBps: 10, exitBps: 0 };
  const baseline = { regime: 'all' as const, median: 0, sigma: 2, samples: 500, since: T0, fallback: false };
  const rich = sample(T0, 100.3);
  const open = decide(rich, baseline, params, null);
  assert.equal(open.kind, 'open');
  if (open.kind !== 'open') return;
  assert.equal(open.direction, 'var_rich');
  const position = openPosition('p1', rich, params, open, baseline);
  assert.equal(position.varEntry, 100.28);
  assert.equal(position.rhEntry, 100.02);
  assert.equal(decide(sample(T0 + 60_000, 100.1), baseline, params, position).kind, 'hold');
  const back = sample(T0 + 120_000, 99.97);
  const close = decide(back, baseline, params, position);
  assert.equal(close.kind, 'close');
  if (close.kind !== 'close') return;
  assert.equal(close.reason, 'revert');
  const trade = closePosition(position, back.t, close.spread, close.reason, { slippageBps: 1, varFeeBps: 0, rhFeeBps: 0 }, null);
  const qty = 1000 / 100;
  const gross = (100.28 - 99.99) * qty + (99.98 - 100.02) * qty;
  assert.ok(Math.abs(trade.grossUsd - gross) < 1e-9);
  const cost = (qty * (100.28 + 99.99) + qty * (100.02 + 99.98)) / 1e4;
  assert.ok(Math.abs(trade.netUsd - (gross - cost)) < 1e-9);
  assert.equal(decide(sample(T0 + 60_000, 99), baseline, { ...params, stopBps: 30 }, position).kind === 'close', true, '浮亏达到止损线平仓');
});

test('开仓风控：暂停、未确认规格、时段、报价过旧、冷却、持仓与名义上限、当日亏损', () => {
  const params: SymbolParams = { ...DEFAULT_SYMBOL, enabled: true, regimes: ['all'] };
  const context = { openPositions: 0, openNotionalUsd: 0, dailyNetUsd: 0, cooldownUntil: 0, eligible: true };
  const value = sample(T0, 100);
  assert.equal(openBlocker(value, params, DEFAULT_GLOBAL, context), null);
  assert.equal(openBlocker(value, params, { ...DEFAULT_GLOBAL, paused: true }, context), '已暂停');
  assert.equal(openBlocker(value, params, DEFAULT_GLOBAL, { ...context, eligible: false }), '规格未确认');
  assert.equal(openBlocker({ ...value, regime: 'rth' }, params, DEFAULT_GLOBAL, context), '当前时段不开仓');
  assert.equal(openBlocker({ ...value, receivedAt: value.t + 120_000 }, params, DEFAULT_GLOBAL, context), 'Var 报价过旧');
  assert.equal(openBlocker(value, params, DEFAULT_GLOBAL, { ...context, cooldownUntil: T0 + 1 }), '冷却中');
  assert.equal(openBlocker(value, params, DEFAULT_GLOBAL, { ...context, varBusy: true }), '同一 Var 代码已在另一场所持仓');
  assert.equal(openBlocker(value, params, DEFAULT_GLOBAL, { ...context, openPositions: 5 }), '持仓数已满');
  assert.equal(openBlocker(value, params, DEFAULT_GLOBAL, { ...context, openNotionalUsd: 9_500 }), '名义合计将超上限');
  assert.equal(openBlocker(value, params, DEFAULT_GLOBAL, { ...context, dailyNetUsd: -100 }), '当日亏损已达上限');
});

/** 基差围绕 20 基点来回摆动：偶数小时 20，奇数分钟里每 30 分钟冲高到 45 一次。 */
function oscillating(count: number): Sample[] {
  return Array.from({ length: count }, (_, index) => sample(T0 + index * 60_000, 100 * (1 + (index % 30 === 15 ? 45 : 20) / 1e4)));
}

test('回测：基差冲高时卖 Var，回到基线平仓；只用当时以前的样本', () => {
  const samples = oscillating(600);
  const params: SymbolParams = { ...DEFAULT_SYMBOL, entryBps: 15, exitBps: 2, cooldownMinutes: 0, regimes: ['all'] };
  const global = { ...DEFAULT_GLOBAL, windowHours: 2, minSamples: 30 };
  const result = runBacktest('BTC', 'crypto', samples, T0 + 60 * 60_000, T0 + 600 * 60_000, params, global);
  assert.ok(result.trades.length >= 15, `应有约 18 笔，实际 ${result.trades.length}`);
  assert.ok(result.trades.every(trade => trade.direction === 'var_rich' && trade.reason === 'revert'));
  assert.ok(result.summary.netUsd > 0);
  assert.ok(result.trades.every(trade => trade.openedAt >= T0 + 60 * 60_000));
  // 未来的样本不能改变过去的判断：截掉后半段，前半段的成交不变。
  const half = runBacktest('BTC', 'crypto', samples.slice(0, 300), T0 + 60 * 60_000, T0 + 600 * 60_000, params, global);
  assert.deepEqual(half.trades.map(trade => trade.openedAt), result.trades.filter(trade => trade.closedAt < T0 + 300 * 60_000).map(trade => trade.openedAt));
  assert.throws(() => backtestRequest({ symbol: 'rh:BTC', hours: 0 }, {}, DEFAULT_GLOBAL), /回测时长/);
  assert.throws(() => backtestRequest({ symbol: 'BTC', hours: 24 }, {}, DEFAULT_GLOBAL), /配对键无效/);
  assert.equal(backtestRequest({ symbol: 'lighter:BTC', hours: 24, params: { entryBps: 30 } }, {}, DEFAULT_GLOBAL).params.entryBps, 30);
});

test('按金额的成交均价：深度不足为空', () => {
  assert.equal(vwap([[100, 5], [101, 5]], 500), 100);
  assert.ok(Math.abs(vwap([[100, 5], [101, 5]], 1000)! - 1000 / (5 + 500 / 101)) < 1e-9);
  assert.equal(vwap([[100, 1]], 1000), null);
});

test('盘口快照：逐笔挂单按价合并排序，冲击套到对齐时刻的一档价上，相隔过久不用', () => {
  const book = parseBookOrders({ code: 200, asks: [{ price: '100.2', remaining_base_amount: '20' }, { price: '100.1', remaining_base_amount: '3' }, { price: '100.1', remaining_base_amount: '2' }, { price: 'x', remaining_base_amount: '1' }],
    bids: [{ price: '99.8', remaining_base_amount: '50' }, { price: '99.9', remaining_base_amount: '5' }] });
  assert.deepEqual(book.asks, [[100.1, 5], [100.2, 20]]);
  assert.deepEqual(book.bids, [[99.9, 5], [99.8, 50]]);
  const snapshot = depthSnapshot(book, T0);
  assert.equal(snapshot.bid, 99.9);
  assert.ok(snapshot.ask1k! > 100.1 && snapshot.ask1k! < 100.2);
  assert.equal(snapshot.ask100k, null, '深度不足');
  // 对齐时刻的一档已上移 0.5，冲击不变。
  const aligned = depthAt(snapshot, { bid: 100.4, ask: 100.6 }, T0 - 30_000)!;
  assert.ok(Math.abs(aligned.ask1k! - (100.6 + snapshot.ask1k! - 100.1)) < 1e-9);
  assert.ok(Math.abs(aligned.bid1k! - (100.4 - (99.9 - snapshot.bid1k!))) < 1e-9);
  assert.equal(aligned.bid100k, null);
  assert.equal(depthAt(snapshot, { bid: 100.4, ask: 100.6 }, T0 - DEPTH_MAX_GAP_MS - 1), null);
  assert.equal(depthAt(null, { bid: 1, ask: 2 }, T0), null);
  assert.throws(() => depthSnapshot({ bids: [[100.2, 1]], asks: [[100.1, 1]] }, T0), /倒挂/);
  assert.throws(() => parseBookOrders({ code: 200, asks: [] }), /格式无效/);
});

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.({}); }
  push(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

test('Lighter 行情流：快照后的一档可按时刻回看，定期重订阅延续区间，断线后不再覆盖', () => {
  let clock = T0;
  const sockets: FakeSocket[] = [], urls: string[] = [];
  const stream = new LighterStream({ venue: 'lighter', connect: url => { urls.push(url); const socket = new FakeSocket(); sockets.push(socket); return socket; }, now: () => clock });
  stream.start();
  assert.deepEqual(urls, ['wss://mainnet.zklighter.elliot.ai/stream?readonly=true']);
  const socket = sockets[0];
  socket.open();
  assert.deepEqual(socket.sent.map(item => item.channel), ['market_stats/all']);
  assert.equal(stream.topAt(1, clock), null, '快照前没有数据');
  socket.push({ type: 'subscribed/market_stats', channel: 'market_stats:all', market_stats: { 1: { market_id: 1, symbol: 'BTC', best_bid_price: '99.9', best_ask_price: '100.1', mark_price: '100', index_price: '100', current_funding_rate: '0.0012' } } });
  clock += 2_000;
  socket.push({ type: 'update/market_stats', channel: 'market_stats:all', market_stats: { 1: { market_id: 1, best_bid_price: '100.0' } } });
  assert.equal(stream.topAt(1, T0 + 1_000)?.bid, 99.9);
  assert.equal(stream.topAt(1, T0 + 2_500)?.bid, 100);
  assert.equal(stream.topAt(1, T0 + 2_500)?.ask, 100.1);
  assert.ok(Math.abs(stream.topAt(1, T0 + 2_500)!.funding! - 0.000012) < 1e-12);
  assert.equal(stream.topAt(1, T0 - 1), null);
  assert.ok(stream.status(1).bytes > 0);
  // 定期重订阅：快照延续当前区间，之前的历史仍可回看。
  clock += 60_000;
  socket.push({ type: 'update/market_stats', channel: 'market_stats:all', market_stats: {} });
  socket.sent.length = 0;
  (stream as unknown as { tick(): void }).tick();
  assert.deepEqual(socket.sent.map(item => `${item.type} ${item.channel}`), ['ping undefined', 'unsubscribe market_stats/all', 'subscribe market_stats/all']);
  socket.push({ type: 'subscribed/market_stats', channel: 'market_stats:all', market_stats: { 1: { market_id: 1, best_bid_price: '100.0', best_ask_price: '100.1' } } });
  assert.equal(stream.topAt(1, T0 + 2_500)?.bid, 100);
  assert.equal(stream.topAt(1, clock)?.bid, 100);

  clock += 1_000;
  socket.onclose?.({});
  assert.equal(stream.status(1).connected, false);
  assert.equal(stream.topAt(1, clock + 10_000), null, '断线之后的时刻没有数据');
  assert.equal(stream.topAt(1, T0 + 2_500)?.bid, 100, '断线前的历史仍可回看');
  stream.close();
});

test('下单预演：按 Lighter 精度向下取整，核对最小数量与金额，连接器未接入时不就绪', () => {
  const rh = { symbol: 'BTC', marketId: 1, mark: 100, sizeDecimals: 2, priceDecimals: 2, minBase: 0.5, minQuote: 10, takerFeeBps: 0, makerFeeBps: 0 };
  const pair = { key: 'lighter:BTC', venue: 'lighter' as const, symbol: 'BTC', name: 'Bitcoin', kind: 'crypto' as const, identity: 'verified' as const, gapBps: 1, marketId: 1, rh };
  const plan = orderPlan(pair, sample(T0, 100.3, 100), 'var_rich', 999.7, 20, T0 + 30_000);
  assert.equal(plan.legs[1].qty, '9.99');
  assert.equal(plan.legs[1].side, 'buy');
  assert.equal(plan.legs[0].side, 'sell');
  assert.equal(plan.legs[1].fields.base_amount, 999);
  assert.equal(plan.legs[1].limit, '100.23');
  assert.equal(plan.ready, false);
  assert.ok(plan.checks.filter(check => !check.ok).every(check => /尚未接入/.test(check.label)));
  assert.equal(plan.symbol, 'lighter:BTC');
  assert.ok(plan.sequence.some(line => line.includes('Lighter（市场 1）')), '计划写明对手场所与市场编号');
  const small = orderPlan(pair, sample(T0, 100.3, 100), 'var_cheap', 20, 20, T0 + 30_000);
  assert.ok(small.checks.some(check => !check.ok && /最小数量/.test(check.label)));
});

test('降采样：每格保留机会极值', () => {
  const points = Array.from({ length: 100 }, (_, index) => ({ t: index, mid: index % 2, sellVar: index, buyVar: -index, median: 0, sigma: 1 }));
  const result = downsample(points, 10);
  assert.equal(result.length, 10);
  assert.equal(result[0].sellVar, 9);
  assert.equal(result[0].buyVar, -9);
  assert.equal(result[0].mid, 0.5);
});

test('引擎：两个场所各自对齐样本写库，盘口快照，模拟盘开平仓与同代码互斥，停采场所，参数版本冲突与清空确认', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tp-varlighter-'));
  let clock = T0;
  const sockets = new Map<string, FakeSocket>();
  const requested: string[] = [];
  let varMid = 100.2;
  const market = (symbol: string, id: number, mark: string) => ({ symbol, market_id: id, market_type: 'perp', status: 'active', size_decimals: 4, price_decimals: 2, min_base_amount: '0.001', min_quote_amount: '10', taker_fee: '0', maker_fee: '0', mark_price: mark });
  const fetchImpl = async (url: string) => {
    requested.push(url);
    if (url.includes('orderBookDetails')) return Response.json({ code: 200, order_book_details: url.includes('api.rh.lighter.xyz')
      ? [market('BTC', 1, '100'), market('OPENAI', 2, '50')]
      : [market('BTC', 7, '100'), market('ETH', 8, '10')] });
    if (url.includes('orderBookOrders')) return Response.json({ code: 200, bids: [{ price: '99.99', remaining_base_amount: '100' }], asks: [{ price: '100.01', remaining_base_amount: '100' }] });
    const quote = (mid: number) => ({ updated_at: new Date(clock - 2_000).toISOString(), base: { bid: String(mid - 0.01), ask: String(mid + 0.01) }, size_1k: { bid: String(mid - 0.02), ask: String(mid + 0.02) } });
    return Response.json({ listings: [
      { ticker: 'BTC', name: 'Bitcoin', mark_price: String(varMid), funding_rate: '0.1', funding_interval_s: 28800, quotes: quote(varMid) },
      { ticker: 'OPENAI', name: 'OpenAI', mark_price: '100', quotes: quote(100) },
      { ticker: 'ETH', name: 'Ethereum', mark_price: '10.01', quotes: quote(10.01) },
    ] });
  };
  const store = openVarLighterStore(path.join(dir, 'varlighter.sqlite'));
  const engine = createVarLighterEngine({ store, fetchImpl, connect: url => { const socket = new FakeSocket(); sockets.set(url.includes('mainnet') ? 'lighter' : 'rh', socket); return socket; }, now: () => clock });
  const rh = () => sockets.get('rh')!, main = () => sockets.get('lighter')!;
  const row = (key: string) => engine.views.state().rows.find(item => item.key === key);
  try {
    engine.startStreams();
    assert.deepEqual([...sockets.keys()].sort(), ['lighter', 'rh'], '默认两个场所都采集');
    rh().open(); main().open();
    rh().push({ type: 'subscribed/market_stats', channel: 'market_stats:all', market_stats: { 1: { market_id: 1, best_bid_price: '99.99', best_ask_price: '100.01', mark_price: '100', current_funding_rate: '0.001' }, 2: { market_id: 2, best_bid_price: '49.9', best_ask_price: '50.1' } } });
    main().push({ type: 'subscribed/market_stats', channel: 'market_stats:all', market_stats: { 7: { market_id: 7, best_bid_price: '99.99', best_ask_price: '100.01', mark_price: '100' }, 8: { market_id: 8, best_bid_price: '9.999', best_ask_price: '10.001' } } });
    await engine.refreshCatalog(AbortSignal.timeout(1000), 'rh');
    await engine.refreshCatalog(AbortSignal.timeout(1000), 'lighter');
    const signal = AbortSignal.timeout(5000);
    await engine.pollVar(signal);
    assert.equal(engine.views.state().sources.var.poll?.noLighter, 3, '规格不同的 OPENAI 不对齐；快照之前的 Var 报价没有对应的 Lighter 盘口');
    assert.deepEqual(engine.views.state().rows.map(item => item.key), ['rh:BTC', 'lighter:BTC', 'lighter:ETH', 'rh:OPENAI']);
    assert.equal(requested.filter(url => url.includes('orderBookOrders')).length, 0, '没有启用的标的就不取盘口快照');
    const initial = engine.views.state();
    assert.throws(() => engine.views.settings({ revision: initial.settings.revision, symbols: { 'rh:OPENAI': { enabled: true } } }), /规格不同/);
    assert.throws(() => engine.views.settings({ revision: initial.settings.revision, symbols: { BTC: { enabled: true } } }), /配对键无效/);
    const enable = { enabled: true, entryBps: 15, exitBps: 2, cooldownMinutes: 0, regimes: ['all'] };
    const saved = engine.views.settings({ revision: initial.settings.revision, global: { minSamples: 10, windowHours: 2 }, symbols: { 'rh:BTC': enable, 'lighter:BTC': enable } });
    assert.equal(saved.revision, 1);
    assert.throws(() => engine.views.settings({ revision: 0 }), (error: unknown) => (error as { status?: number }).status === 409);
    let tick = 0;
    /** 过一分钟：两个场所各推一条变化（真实行情每秒都有消息），再拉一次 Var。 */
    const minute = async () => {
      clock += 60_000;
      tick++;
      rh().push({ type: 'update/market_stats', channel: 'market_stats:all', market_stats: { 1: { market_id: 1, mark_price: String(100 + tick * 0.0001) } } });
      main().push({ type: 'update/market_stats', channel: 'market_stats:all', market_stats: { 7: { market_id: 7, mark_price: String(100 + tick * 0.0001) }, 8: { market_id: 8, mark_price: String(10 + tick * 0.0001) } } });
      await engine.pollVar(signal);
    };
    for (let index = 0; index < 12; index++) await minute();
    let view = engine.views.state();
    assert.equal(view.rows.find(item => item.key === 'rh:OPENAI')?.identity, 'mismatch');
    const btc = row('rh:BTC')!;
    assert.equal(btc.samples24h, 12);
    assert.equal(btc.venueName, 'Lighter RH');
    assert.equal(btc.estimated, false, '启用的配对用盘口快照算成交均价');
    assert.equal(row('lighter:ETH')!.estimated, true, '没启用的用一档价估算');
    assert.ok(btc.baseline && Math.abs(btc.baseline.median - 20) < 0.01);
    assert.equal(row('lighter:BTC')!.samples24h, 12);
    assert.equal(view.sources.var.poll?.noLighter, 0);
    assert.deepEqual(view.sources.venues.map(item => [item.venue, item.depth.map(depth => depth.key), item.pairs]), [['rh', ['rh:BTC'], 2], ['lighter', ['lighter:BTC'], 2]]);
    assert.ok(requested.some(url => url.startsWith('https://mainnet.zklighter.elliot.ai/api/v1/orderBookOrders?market_id=7&')));
    // 冲高：两个场所同时有信号，同一 Var 代码只开一笔（RH 在前）。
    varMid = 100.5; await minute();
    assert.deepEqual(engine.views.paper().positions.map(item => [item.symbol, item.direction]), [['rh:BTC', 'var_rich']]);
    assert.throws(() => engine.views.settings({ revision: 1, venues: ['lighter'] }), /Lighter RH 上还有启用的标的或模拟持仓/);
    varMid = 100.2; await minute();
    const paper = engine.views.paper();
    assert.equal(paper.positions.length, 0);
    assert.equal(paper.trades.length, 1);
    assert.equal(paper.trades[0].reason, 'revert');
    assert.ok(paper.trades[0].netUsd > 0);
    assert.ok(paper.events.some(event => event.kind === 'open') && paper.events.some(event => event.kind === 'close'));
    // 同一报价时刻不重复计入。
    const before = row('rh:BTC')!.samples24h;
    await engine.pollVar(signal);
    assert.equal(row('rh:BTC')!.samples24h, before);
    const detail = engine.views.symbol('rh:BTC', '24');
    assert.equal(detail.points.length, before);
    assert.equal(detail.venueName, 'Lighter RH');
    assert.deepEqual(detail.stats.map(item => item.regime), ['all']);
    assert.equal(detail.plans.length, 2);
    assert.equal(detail.trades.length, 1);
    assert.throws(() => engine.views.symbol('BTC', '24'), /不是两边共有的标的/);
    const bt = engine.views.backtest({ symbol: 'rh:BTC', hours: 1 });
    assert.equal(bt.symbol, 'rh:BTC');
    assert.ok(engine.views.readiness().items.some(item => item.key === 'lighter_order' && item.status === 'todo'));
    // 停采主网：先要停用主网上启用的标的。
    const current = engine.views.state().settings.revision;
    assert.throws(() => engine.views.settings({ revision: current, venues: ['rh'] }), /venue_busy|Lighter 上还有启用的标的/);
    assert.throws(() => engine.views.settings({ revision: current, venues: [] }), /至少保留一个/);
    const stopped = engine.views.settings({ revision: current, venues: ['rh'], symbols: { 'lighter:BTC': { enabled: false } } });
    assert.deepEqual(stopped.venues, ['rh']);
    assert.equal(main().readyState, 3, '停采后关闭主网行情流');
    view = engine.views.state();
    assert.deepEqual(view.rows.map(item => item.key), ['rh:BTC', 'rh:OPENAI']);
    assert.deepEqual(view.sources.venues.map(item => [item.venue, item.enabled, item.stream === null]), [['rh', true, false], ['lighter', false, true]]);
    assert.throws(() => engine.views.reset({ confirm: 'yes' }), /RESET/);
    engine.views.reset({ confirm: 'RESET' });
    assert.equal(engine.views.paper().trades.length, 0);
    view = engine.views.state();
    assert.equal(view.paper.trades, 0);
  } finally { engine.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('引擎重启：库里已启用的配对在第一次拉 Var 时就取盘口快照', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tp-varlighter-'));
  const clock = T0;
  const requested: string[] = [];
  const fetchImpl = async (url: string) => {
    requested.push(url);
    if (url.includes('orderBookDetails')) return Response.json({ code: 200, order_book_details: [{ symbol: 'BTC', market_id: 1, market_type: 'perp', status: 'active', size_decimals: 4, price_decimals: 2, min_base_amount: '0.001', min_quote_amount: '10', taker_fee: '0', maker_fee: '0', mark_price: '100' }] });
    if (url.includes('orderBookOrders')) return Response.json({ code: 200, bids: [{ price: '99.99', remaining_base_amount: '100' }], asks: [{ price: '100.01', remaining_base_amount: '100' }] });
    return Response.json({ listings: [{ ticker: 'BTC', name: 'Bitcoin', mark_price: '100.2', quotes: { updated_at: new Date(clock - 2_000).toISOString(), base: { bid: '100.19', ask: '100.21' } } }] });
  };
  const file = path.join(dir, 'varlighter.sqlite');
  const seeded = openVarLighterStore(file);
  seeded.setState('settings', { revision: 3, global: DEFAULT_GLOBAL, symbols: { 'rh:BTC': { ...DEFAULT_SYMBOL, enabled: true } }, confirmed: [], venues: ['rh'] }, T0);
  seeded.close();
  const engine = createVarLighterEngine({ store: openVarLighterStore(file), fetchImpl, connect: () => new FakeSocket(), now: () => clock });
  try {
    await engine.refreshCatalog(AbortSignal.timeout(1000), 'rh');
    await engine.pollVar(AbortSignal.timeout(1000));
    assert.equal(requested.filter(url => url.includes('orderBookOrders?market_id=1&')).length, 1);
    const depth = engine.views.state().sources.venues.find(item => item.venue === 'rh')!.depth;
    assert.deepEqual(depth.map(item => [item.key, item.at, item.error]), [['rh:BTC', T0, null]]);
  } finally { engine.close(); rmSync(dir, { recursive: true, force: true }); }
});

// ---- 审查补充（docs/reviews/2026-11-22-varlighter.md）----

test('持仓取价：100k 档缺盘口快照时退回 1k 档估算，超时与止损照常判断', () => {
  const params: SymbolParams = { ...DEFAULT_SYMBOL, notionalUsd: 5_000, maxHoldMinutes: 30, stopBps: 50 };
  const position: Position = { id: 'p', symbol: 'BTC', direction: 'var_rich', openedAt: T0, qty: 50, notionalUsd: 5_000, entrySpread: 25, entryBaseline: 0, entryRegime: 'all', varEntry: 100.25, rhEntry: 100.02, estimated: false };
  const now = sample(T0 + 5 * 60_000, 100.3);
  assert.equal(spreadOf(now, '100k'), null, '100k 档缺 Lighter 盘口');
  const spread = positionSpread(now, 5_000)!;
  assert.equal(spread.estimated, true);
  assert.deepEqual(spread, { ...spreadOf(now, '1k')!, estimated: true });
  assert.equal(decide(now, null, params, position).kind, 'hold');
  const late = decide(sample(T0 + 31 * 60_000, 100.3), null, params, position);
  assert.equal(late.kind === 'close' && late.reason, 'timeout', '缺 100k 档也按时超时平仓');
  const crash = decide(sample(T0 + 6 * 60_000, 100.9), null, params, position);
  assert.equal(crash.kind === 'close' && crash.reason, 'stop');
  assert.equal(decide(now, null, params, null).kind, 'wait', '开仓仍要求该档完整报价');
});

test('Lighter 行情流：握手不完成按超时重连，沉默重连，退避增长且封顶 60 秒', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let clock = T0;
  const sockets: FakeSocket[] = [];
  const stream = new LighterStream({ venue: 'rh', connect: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; }, now: () => clock });
  try {
    stream.start();
    clock += CONNECT_TIMEOUT_MS + 1; t.mock.timers.tick(1_000);
    assert.equal(stream.status(0).lastError, '连接超时');
    assert.equal(sockets[0].readyState, 3, '放弃的连接被关掉');
    t.mock.timers.tick(1_000);
    assert.equal(sockets.length, 2, '1 秒后重连');
    sockets[1].open();
    sockets[1].push({ type: 'subscribed/market_stats', channel: 'market_stats:all', market_stats: {} });
    clock += 21_000; t.mock.timers.tick(1_000);
    assert.equal(stream.status(0).lastError, '长时间没有消息');
    t.mock.timers.tick(1_000);
    assert.equal(sockets.length, 3, '收到过快照，退避从 1 秒重新开始');
    clock += CONNECT_TIMEOUT_MS + 1; t.mock.timers.tick(1_000);
    t.mock.timers.tick(1_000);
    assert.equal(sockets.length, 3, '连续失败：第二次等 2 秒');
    t.mock.timers.tick(1_000);
    assert.equal(sockets.length, 4);
    (stream as unknown as { attempt: number }).attempt = 20;
    clock += CONNECT_TIMEOUT_MS + 1; t.mock.timers.tick(1_000);
    t.mock.timers.tick(59_999);
    assert.equal(sockets.length, 4);
    t.mock.timers.tick(1);
    assert.equal(sockets.length, 5, '退避封顶 60 秒');
    assert.equal(stream.status(0).reconnects, 4);
  } finally { stream.close(); }
  assert.equal(stream.running, false);
});

function seededEngine(seed: (store: ReturnType<typeof openVarLighterStore>) => void, options: { fetchImpl?: (url: string, init: RequestInit) => Promise<Response>; clock?: () => number } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'tp-varlighter-'));
  const file = path.join(dir, 'varlighter.sqlite');
  const seeded = openVarLighterStore(file);
  seed(seeded);
  seeded.close();
  const market = { symbol: 'BTC', market_id: 1, market_type: 'perp', status: 'active', size_decimals: 4, price_decimals: 2, min_base_amount: '0.001', min_quote_amount: '10', taker_fee: '0', maker_fee: '0', mark_price: '100' };
  const now = options.clock ?? (() => T0);
  const fetchImpl = options.fetchImpl ?? (async (url: string) => {
    if (url.includes('orderBookDetails')) return Response.json({ code: 200, order_book_details: [market] });
    if (url.includes('orderBookOrders')) return Response.json({ code: 200, bids: [{ price: '99.99', remaining_base_amount: '100' }], asks: [{ price: '100.01', remaining_base_amount: '100' }] });
    return Response.json({ listings: [{ ticker: 'BTC', name: 'Bitcoin', mark_price: '100.2', quotes: { updated_at: new Date(now() - 2_000).toISOString(), base: { bid: '100.19', ask: '100.21' } } }] });
  });
  const sockets: FakeSocket[] = [];
  const engine = createVarLighterEngine({ store: openVarLighterStore(file), fetchImpl, connect: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; }, now });
  return { dir, file, engine, sockets, dispose(keep = false) { engine.close(); if (!keep) rmSync(dir, { recursive: true, force: true }); } };
}

test('失联配对：总览列出，可停用，持仓按最后样本平仓并记明；手动平仓的错误码；冷却重启后仍在', async () => {
  const position = (symbol: string): Position => ({ id: `p-${symbol}`, symbol, direction: 'var_rich', openedAt: T0 - 3_600_000, qty: 10, notionalUsd: 1_000, entrySpread: 20, entryBaseline: 0, entryRegime: 'rth', varEntry: 100.3, rhEntry: 100.01, estimated: false });
  const { dir, file, engine, dispose } = seededEngine(store => {
    store.setState('settings', { revision: 3, global: DEFAULT_GLOBAL, symbols: { 'rh:BTC': { ...DEFAULT_SYMBOL, enabled: true }, 'rh:GONE': { ...DEFAULT_SYMBOL, enabled: true, cooldownMinutes: 120 } }, confirmed: [], venues: ['rh'] }, T0);
    store.addSamples([{ ...sample(T0 - 30 * 60_000, 100.1), symbol: 'rh:GONE' }, { ...sample(T0 - 20 * 60_000, 100.1), symbol: 'rh:BTC' }]);
    store.savePosition(position('rh:GONE'));
    store.savePosition(position('rh:BTC'));
  });
  try {
    assert.deepEqual(engine.views.state().orphans, [], '目录与 Var 报价还没取到时不判断');
    assert.throws(() => engine.views.close({ symbol: 'rh:GONE' }), (error: unknown) => (error as { status?: number }).status === 409, '启动期不按旧样本结算');
    await engine.refreshCatalog(AbortSignal.timeout(1000), 'rh');
    await engine.pollVar(AbortSignal.timeout(1000));
    const [orphan] = engine.views.state().orphans;
    assert.deepEqual({ ...orphan, position: { ...orphan.position!, pnlBps: null } }, { key: 'rh:GONE', venue: 'rh', venueName: 'Lighter RH', symbol: 'GONE', reason: '配对已不在目录里', enabled: true, lastSampleAt: T0 - 30 * 60_000,
      position: { direction: 'var_rich', openedAt: T0 - 3_600_000, pnlBps: null } });
    assert.equal(typeof orphan.position!.pnlBps, 'number');
    assert.equal(engine.views.state().rows.find(row => row.key === 'rh:BTC')?.samples24h, 1, '近 24 小时计数含启动前的样本');

    const code = (work: () => unknown) => { try { work(); } catch (error) { return [(error as { status: number }).status, (error as { code: string }).code]; } return null; };
    assert.deepEqual(code(() => engine.views.close({ symbol: 'rh:ETH' })), [404, 'not_found']);
    assert.deepEqual(code(() => engine.views.close({ symbol: 'rh:BTC', extra: 1 })), [400, 'invalid_body']);
    assert.deepEqual(code(() => engine.views.close({ symbol: 'rh:BTC' })), [409, 'no_quote'], '还在目录里的配对要 10 分钟内的报价');
    const trade = engine.views.close({ symbol: 'rh:GONE' });
    assert.equal(trade.closedAt, T0 - 30 * 60_000, '失联配对按最后样本结算');
    assert.match(engine.views.paper().events[0].message, /配对已不在目录里，按最后样本/);
    const disabled = engine.views.settings({ revision: 3, symbols: { 'rh:GONE': { ...DEFAULT_SYMBOL, enabled: false } } });
    assert.equal(disabled.symbols['rh:GONE'].enabled, false);
    assert.deepEqual(engine.views.state().orphans, [], '停用并平仓后不再列出');

    let revision = disabled.revision;
    for (let batch = 0; batch < 2; batch++) revision = engine.views.settings({ revision, symbols: Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`rh:K${batch}X${index}`, { ...DEFAULT_SYMBOL }])) }).revision;
    assert.deepEqual(code(() => engine.views.settings({ revision, symbols: Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`rh:K9X${index}`, { ...DEFAULT_SYMBOL }])) })), [400, 'too_many'], '保存的配对键有上限');
  } finally { dispose(true); }
  const reopened = openVarLighterStore(file);
  try { assert.equal(reopened.state<Record<string, number>>('cooldown')?.['rh:GONE'], T0 - 30 * 60_000 + 120 * 60_000, '冷却写进库，重启后仍在'); } finally { reopened.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('失联判定：规格改判、数据源连续正常 30 分钟仍无样本才算；Var 失败、目录未取到、行情流断开、刚重启都不算，平仓等恢复；冷却重启后照样挡开仓', async () => {
  const COOLDOWN_MIN = 600;
  let time = T0, varMark = '100.2', varFails = false, full = false;
  const fetchImpl = async (url: string) => {
    if (url.includes('orderBookDetails')) return Response.json({ code: 200, order_book_details: [{ symbol: 'BTC', market_id: 1, market_type: 'perp', status: 'active', size_decimals: 4, price_decimals: 2, min_base_amount: '0.001', min_quote_amount: '10', taker_fee: '0', maker_fee: '0', mark_price: '100' }] });
    if (url.includes('orderBookOrders')) return Response.json({ code: 200, bids: [{ price: '99.99', remaining_base_amount: '1000' }], asks: [{ price: '100.01', remaining_base_amount: '1000' }] });
    if (varFails) return new Response('down', { status: 502 });
    const tiers = full ? { size_1k: { bid: '100.29', ask: '100.31' }, size_100k: { bid: '100.28', ask: '100.32' } } : {};
    return Response.json({ listings: [{ ticker: 'BTC', name: 'Bitcoin', mark_price: varMark, quotes: { updated_at: new Date(time - 2_000).toISOString(), base: { bid: '100.29', ask: '100.31' }, ...tiers } }] });
  };
  const position: Position = { id: 'p-btc', symbol: 'rh:BTC', direction: 'var_rich', openedAt: T0 - 3_600_000, qty: 10, notionalUsd: 1_000, entrySpread: 20, entryBaseline: 0, entryRegime: 'rth', varEntry: 100.3, rhEntry: 100.01, estimated: false };
  const dir = mkdtempSync(path.join(tmpdir(), 'tp-varlighter-')), file = path.join(dir, 'varlighter.sqlite');
  const engines: ReturnType<typeof createVarLighterEngine>[] = [];
  /** 启动一个引擎并连上行情流；advance 拨时钟并推一条消息（行情流按消息间隔判沉默）。 */
  const start = () => {
    const sockets: FakeSocket[] = [];
    const engine = createVarLighterEngine({ store: openVarLighterStore(file), fetchImpl, connect: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; }, now: () => time });
    engines.push(engine);
    engine.startStreams();
    sockets[0].open();
    sockets[0].push({ type: 'subscribed/market_stats', channel: 'market_stats:all', market_stats: { 1: { market_id: 1, best_bid_price: '99.99', best_ask_price: '100.01', mark_price: '100' } } });
    let tick = 0;
    const advance = (ms: number) => { time += ms; tick++; sockets[0].push({ type: 'update/market_stats', channel: 'market_stats:all', market_stats: { 1: { market_id: 1, mark_price: String(100 + tick * 0.0001) } } }); };
    /** 按服务节奏每分钟拉一次 Var。 */
    const run = async (minutes: number) => { for (let index = 0; index < minutes; index++) { advance(60_000); await engine.pollVar(AbortSignal.timeout(1000)); } };
    return { engine, socket: sockets[0], advance, run };
  };
  const poll = (engine: ReturnType<typeof createVarLighterEngine>) => engine.pollVar(AbortSignal.timeout(1000));
  const status = (work: () => unknown) => { try { work(); } catch (error) { return (error as { status: number }).status; } return 200; };
  const reasons = (engine: ReturnType<typeof createVarLighterEngine>) => engine.views.state().orphans.map(row => row.reason);
  const NO_SAMPLE = '超过 30 分钟没有新样本（Var 无报价或对手盘口缺失）';
  try {
    const seed = openVarLighterStore(file);
    seed.setState('settings', { revision: 1, global: { ...DEFAULT_GLOBAL, minSamples: 10 }, symbols: { 'rh:BTC': { ...DEFAULT_SYMBOL, enabled: true, entryBps: 1, exitBps: 0, cooldownMinutes: COOLDOWN_MIN } }, confirmed: [], venues: ['rh'] }, T0);
    seed.addSamples(Array.from({ length: 12 }, (_, index) => ({ ...sample(T0 - (75 - index * 5) * 60_000, 100.1), symbol: 'rh:BTC' })));
    seed.savePosition(position);
    seed.close();

    // 刚启动：库里最后样本 20 分钟前；Var 已拉到但场所目录未取到，也不算。
    const first = start();
    await poll(first.engine);
    assert.deepEqual(reasons(first.engine), [], '场所目录未取到不判断');
    assert.equal(status(() => first.engine.views.close({ symbol: 'rh:BTC' })), 409, '启动期不按旧样本结算');
    await first.engine.refreshCatalog(AbortSignal.timeout(1000), 'rh');
    await first.run(11);
    assert.deepEqual(reasons(first.engine), [], '最后样本 31 分钟前，但数据源正常才 11 分钟');
    await first.run(20);
    assert.deepEqual(reasons(first.engine), [NO_SAMPLE], '数据源连续正常 31 分钟仍无样本：Var 有目录没报价');
    varFails = true; first.advance(4 * 60_000); await poll(first.engine);
    assert.deepEqual(reasons(first.engine), [], 'Var 拉取失败超过 3 分钟，整体故障不算单个配对失联');
    assert.equal(status(() => first.engine.views.close({ symbol: 'rh:BTC' })), 409, '数据源故障时不按旧样本结算');
    varFails = false; await poll(first.engine);
    assert.deepEqual(reasons(first.engine), [], 'Var 刚恢复，从恢复时刻重新计时');
    await first.run(31);
    assert.deepEqual(reasons(first.engine), [NO_SAMPLE], '恢复后 31 分钟仍无样本');
    first.socket.onclose?.({});
    assert.deepEqual(reasons(first.engine), [], '行情流断开不算');
    assert.equal(status(() => first.engine.views.close({ symbol: 'rh:BTC' })), 409);
    first.engine.close();

    // 停机很久后重启：第一轮 Var 报价早于行情流快照，没写入新样本，旧样本不算失联。
    time += 3_600_000;
    const restarted = start();
    await restarted.engine.refreshCatalog(AbortSignal.timeout(1000), 'rh');
    await poll(restarted.engine);
    assert.equal(restarted.engine.views.state().sources.var.poll?.written, 0, '第一轮没有新样本');
    assert.deepEqual(reasons(restarted.engine), [], '重启后第一轮');
    assert.equal(status(() => restarted.engine.views.close({ symbol: 'rh:BTC' })), 409);
    restarted.engine.close();

    // 规格改判：按最后样本平仓并注明原因。
    varMark = '120';
    const mismatch = start();
    await mismatch.engine.refreshCatalog(AbortSignal.timeout(1000), 'rh');
    await poll(mismatch.engine);
    assert.deepEqual(reasons(mismatch.engine), ['两边价格相差超过 5%，已改判为规格不同']);
    const trade = mismatch.engine.views.close({ symbol: 'rh:BTC' });
    assert.equal(trade.closedAt, T0 - 20 * 60_000);
    assert.match(mismatch.engine.views.paper().events[0].message, /规格不同，按最后样本/);
    mismatch.engine.close();

    // 冷却写库，重启后照样挡开仓；清空模拟盘（连冷却一起清）后同样的行情会开仓，作为对照。
    varMark = '100.3'; full = true;
    const third = start();
    await third.engine.refreshCatalog(AbortSignal.timeout(1000), 'rh');
    await third.run(3);
    const row = third.engine.views.state().rows[0];
    assert.equal(row.cooldownUntil, T0 - 20 * 60_000 + COOLDOWN_MIN * 60_000, '重启后读回冷却');
    assert.ok(third.engine.views.state().sources.var.poll!.written > 0 && row.baseline !== null && (row.rich ?? 0) > row.entryBps, '有新样本且达到入场条件');
    assert.equal(third.engine.views.paper().positions.length, 0, '冷却中不开仓');
    third.engine.views.reset({ confirm: 'RESET' });
    await third.run(1);
    assert.equal(third.engine.views.paper().positions.length, 1, '对照：没有冷却就开仓');
  } finally {
    for (const engine of engines) { try { engine.close(); } catch { /* 已关闭 */ } }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('后台循环：停服时中断进行中的请求、关掉行情流；启动时已在停服也关库', async () => {
  let aborted = false;
  const hang = (_url: string, init: RequestInit) => new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => { aborted = true; reject(init.signal!.reason); }));
  const { engine, dispose } = seededEngine(() => {}, { fetchImpl: hang, clock: Date.now });
  let stopped = false;
  const sleepers = new Set<() => void>();
  const context = { stopped: () => stopped, pause: (ms: number) => new Promise<void>(resolve => {
    if (stopped) { resolve(); return; }
    const wake = () => { clearTimeout(timer); sleepers.delete(wake); resolve(); };
    const timer = setTimeout(wake, ms);
    sleepers.add(wake);
  }) };
  try {
    const loop = engine.loop(context);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(engine.stream('rh'), '循环里连上行情流');
    assert.equal(aborted, false, '目录请求挂着');
    const started = Date.now();
    stopped = true;
    for (const wake of [...sleepers]) wake();
    await loop;
    assert.ok(Date.now() - started < 2_000, `停服不等 20 秒超时（${Date.now() - started} ms）`);
    assert.equal(aborted, true);
    assert.equal(engine.stream('rh'), null);
  } finally { dispose(); }

  const dir = mkdtempSync(path.join(tmpdir(), 'tp-varlighter-'));
  try {
    const holder = openVarLighter(dir, { fetchImpl: hang, connect: () => new FakeSocket() }, () => {});
    const engine = holder.engine!;
    await varLighterLoop(holder, { stopped: () => true, pause: async () => {} });
    assert.equal(holder.engine, null);
    assert.throws(() => engine.views.state(), /not open|closed|finalized/i, '库已关闭');
    assert.equal(varLighterViews(holder).failure(new Error('x')).status, 500);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('接口：未登录 401、POST 缺页面标记 403、只读令牌不能读写、模块关闭 404、内部错误 500 不带原文', async () => {
  const { createExecutorServer } = await import('../src/http.ts');
  const { LoginThrottle } = await import('../src/login-password.ts');
  const { createReadTokens } = await import('../src/read-token.ts');
  const { bindAccounts, createHarness } = await import('./harness.ts');
  const dir = mkdtempSync(path.join(tmpdir(), 'tp-varlighter-api-'));
  const h = createHarness();
  bindAccounts(h.ex);
  const holder = openVarLighter(dir, { fetchImpl: async () => Response.json({}), connect: () => new FakeSocket() }, () => {});
  const views: { varlighter?: ReturnType<typeof varLighterViews> } = {};
  const lines: string[] = [];
  const server = createExecutorServer({ executor: h.ex, accessToken: 'vl-token-000001', session: 'vl-session-000001', views, log: line => lines.push(line),
    readTokens: createReadTokens({ dir, now: Date.now, log: () => {} }), tokenThrottle: () => new LoginThrottle(Date.now) });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const stderr = process.stderr.write;
  try {
    const cookie = ((await fetch(`${base}/login?token=vl-token-000001`, { redirect: 'manual' })).headers.get('set-cookie') ?? '').split(';')[0]!;
    const get = (route: string, headers: Record<string, string> = { cookie }) => fetch(base + route, { headers });
    const post = (route: string, body: unknown, headers: Record<string, string> = { cookie, 'content-type': 'application/json', 'x-pa-executor': '1' }) => fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal((await get('/api/varlighter/state')).status, 404, '模块关闭');
    views.varlighter = varLighterViews(holder);
    assert.equal((await get('/api/varlighter/state', {})).status, 401);
    assert.equal((await get('/api/varlighter/state')).status, 200);
    assert.equal((await post('/api/varlighter/paper/reset', { confirm: 'RESET' }, { cookie, 'content-type': 'application/json' })).status, 403, '缺页面请求标记');
    const unknown = await post('/api/varlighter/paper/close', { symbol: 'rh:BTC' });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json() as { code: string }).code, 'not_found');
    const generated = await post('/api/read-token/generate', {});
    assert.equal(generated.status, 200);
    const token = (await generated.json() as { token: string }).token;
    const bearer = { authorization: `Bearer ${token}` };
    assert.notEqual((await get('/api/varlighter/state', bearer)).status, 200, '只读令牌读不到本模块');
    assert.notEqual((await post('/api/varlighter/paper/reset', { confirm: 'RESET' }, { ...bearer, 'content-type': 'application/json', 'x-pa-executor': '1' })).status, 200, '只读令牌不能写');
    views.varlighter = { ...varLighterViews(holder), state: () => { throw new Error('secret /path/inside'); } };
    const written: string[] = [];
    process.stderr.write = ((chunk: string) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
    const failed = await get('/api/varlighter/state');
    process.stderr.write = stderr;
    assert.equal(failed.status, 500);
    assert.doesNotMatch(await failed.text(), /secret/);
    assert.ok(written.some(line => line.includes('secret')), '原文只进服务端日志');
  } finally {
    process.stderr.write = stderr;
    await new Promise(resolve => server.close(resolve)); h.dispose(); holder.engine?.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('样本库：过期样本分批删、只删保留期以前的；近期计数按配对', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tp-varlighter-'));
  const store = openVarLighterStore(path.join(dir, 'varlighter.sqlite'));
  try {
    const old = T0 - 15 * 86_400_000;
    store.addSamples([0, 1, 2].flatMap(minute => ['rh:A', 'lighter:A'].map(symbol => ({ ...sample(old + minute * 60_000, 100), symbol }))));
    store.addSamples([{ ...sample(T0 - 60_000, 100), symbol: 'rh:A' }]);
    assert.equal(store.pruneSamples(T0, 4), 4, '一批最多 4 条');
    assert.equal(store.pruneSamples(T0, 4), 2);
    assert.equal(store.pruneSamples(T0, 4), 0);
    assert.equal(store.countSince('rh:A', T0 - 86_400_000), 1);
    assert.equal(store.countSince('lighter:A', 0), 0);
    assert.equal(store.firstSampleAt(), T0 - 60_000);
    assert.equal(store.firstAt('rh:A'), T0 - 60_000);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
