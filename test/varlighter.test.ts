// DEX 价差模块（docs/varlighter.md、docs/dexspread.md）：解析、时段、基线、策略盈亏、回测不看未来、行情流一档连续性、盘口快照、
// Entropy 目录与行情流、手动配对与乘数、旧库迁移与多场所引擎端到端。
// 行情都是假的：fetch 与 WebSocket 由测试替换，不连任何外部服务。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BUSY_BLOCK, COST_BLOCK, DECAYED, FALLBACK_BLOCK, FEE_BLOCK, NO_LIVE_TOP, THIN_BLOCK, closeSpread, confirmOpen, expectedNetBps, openEconomics, slippageBudgetBps } from '../src/varlighter/strategy.ts';
import { DEFAULT_COMBOS, SAMPLE_FIELDS, comboPairs, customPairInfo, executionSample, formatRatio, hasTokenQuote, legacyKeyOf, lighterMarket, pairKey, pairTitle, parseEntropyMarkets, upgradeKey, varMarket, type MarketSpec } from '../src/varlighter/model.ts';
import type { SamplesView } from '../src/varlighter/views.ts';
import { TOKEN_BLOCK_PAUSE_MS, TOKEN_ERROR_KEEP_MS, TOKEN_SYMBOL_PAUSE_MS, TOKEN_QUOTE_MAX_AGE_MS, createVarQuoter, parseTokenQuote, quoteQty, varInstrument, type VarQuoter } from '../src/varlighter/varquote.ts';
import { VARIATIONAL_SESSION_FILE } from '../src/monitor/variational-session.ts';
import { fakeVariationalToken } from './monitor-fake.ts';
import { pairMarkets, parsePairKey, parseRhMarkets, parseVarListings, parseVarQuote, regimeOf, spreadOf, midBasis, type Sample } from '../src/varlighter/model.ts';
import { BaselineTracker, RollingWindow, regimeStats, suggestedEntryBps } from '../src/varlighter/stats.ts';
import { DEFAULT_GLOBAL, DEFAULT_SYMBOL, closePosition, decide, openBlocker, openPosition, positionSpread, readGlobalParams, readSymbolParams, type GlobalParams, type Position, type SymbolParams } from '../src/varlighter/strategy.ts';
import { backtestRequest, runBacktest } from '../src/varlighter/backtest.ts';
import { CONNECT_TIMEOUT_MS, DEPTH_MAX_GAP_MS, HyperliquidStream, LighterStream, depthAt, depthSnapshot, parseBookOrders, vwap, type SocketLike } from '../src/varlighter/feeds.ts';
import { orderPlan } from '../src/varlighter/plan.ts';
import { MIGRATED_KEY, openVarLighterStore } from '../src/varlighter/store.ts';
import { COOLDOWN_KEY, LEGACY_UPGRADE, SETTINGS_KEY, createVarLighterEngine, customKey, downsample, readCustomPair, upgradeSettings } from '../src/varlighter/engine.ts';
import { openVarLighter, varLighterLoop, varLighterViews } from '../src/service/varlighter.ts';

const T0 = Date.parse('2026-11-23T15:00:00Z'); // 周一纽约 10:00（盘中）
const RH_BTC = 'var:BTC|rh:BTC', LIGHTER_BTC = 'var:BTC|lighter:BTC';
const ZERO_FEES = { aFeeBps: 0, bFeeBps: 0 };
const COSTS = { slippageBps: 1, ...ZERO_FEES };
/** 按行情流地址认场所。 */
const venueOf = (url: string) => url.includes('hyperliquid') ? 'entropy' : url.includes('mainnet') ? 'lighter' : 'rh';

function sample(t: number, aMid: number, bMid = 100, extra: Partial<Sample> = {}): Sample {
  return {
    symbol: RH_BTC, t, receivedAt: t + 1_000, regime: 'all', ratio: 1,
    aAt: t, aMark: aMid, aIndex: null, aFunding: 0.1 / 8760,
    aBid0: aMid - 0.01, aAsk0: aMid + 0.01, aBid1k: aMid - 0.02, aAsk1k: aMid + 0.02, aBid100k: aMid - 0.05, aAsk100k: aMid + 0.05,
    aBidRx: null, aAskRx: null, aBidTk: null, aAskTk: null, aTkAt: null,
    bAt: t - 500, bMark: bMid, bIndex: bMid, bFunding: 0.0001,
    bBid0: bMid - 0.01, bAsk0: bMid + 0.01, bBid1k: bMid - 0.02, bAsk1k: bMid + 0.02, bBid100k: null, bAsk100k: null,
    bBidRx: bMid - 0.01, bAskRx: bMid + 0.01, bBidTk: null, bAskTk: null, bTkAt: null, ...extra,
  };
}

function position(symbol: string, extra: Partial<Position> = {}): Position {
  return { id: `p-${symbol}`, symbol, direction: 'a_rich', openedAt: T0 - 3_600_000, qty: 10, notionalUsd: 1_000, entrySpread: 20, entryBaseline: 0, entryRegime: 'rth',
    aEntry: 100.3, bEntry: 100.01, estimated: false, ratio: 1, aFeeBps: 0, bFeeBps: 0, ...extra };
}

const settings2 = (symbols: Record<string, SymbolParams>, global: GlobalParams = DEFAULT_GLOBAL, combos: string[] = ['var|rh']) => ({ revision: 3, global, symbols, confirmed: [], combos, pairs: [] });

const code = (work: () => unknown) => { try { work(); } catch (error) { return [(error as { status: number }).status, (error as { code: string }).code]; } return null; };

const spec = (venue: MarketSpec['venue'], symbol: string, mark: number): MarketSpec => ({ venue, symbol, name: '', id: 0, mark, index: null, fundingHourly: null, sizeDecimals: null, priceDecimals: null, minBase: 0, minQuote: 0, takerFeeBps: null });

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

test('配对：同代码、在交易的永续；价格相差过大判为规格不同，未核对的待确认；配对键的规范写法、旧键升级与名称', () => {
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
  assert.deepEqual(pairs.map(pair => [pair.key, pair.identity, pair.kind]), [[RH_BTC, 'verified', 'crypto'], ['var:NEWCOIN|rh:NEWCOIN', 'review', 'other'], ['var:OPENAI|rh:OPENAI', 'mismatch', 'other']]);
  // 主网同一份目录格式，配对键带场所；同一代码在两个场所是两个配对。
  const main = pairMarkets([listing('BTC', 100.2)], markets, 'lighter');
  assert.deepEqual(main.map(pair => [pair.key, pair.b.venue, pair.symbol]), [[LIGHTER_BTC, 'lighter', 'BTC']]);
  assert.deepEqual(parsePairKey('var:1000PEPE|lighter:1000PEPE'), { a: { venue: 'var', symbol: '1000PEPE' }, b: { venue: 'lighter', symbol: '1000PEPE' }, ratio: 1 });
  assert.deepEqual(parsePairKey('var:OPENAI|entropy:OAI@0.137'), { a: { venue: 'var', symbol: 'OPENAI' }, b: { venue: 'entropy', symbol: 'OAI' }, ratio: 0.137 });
  for (const bad of ['BTC', 'binance:BTC|rh:BTC', 'rh:BTC', 'var:BTC|var:BTC', `${RH_BTC}@1`, `${RH_BTC}@0.1370`, `${RH_BTC}@1.0`, `${RH_BTC}@0.0000001`, `${RH_BTC}@2000000`]) assert.equal(parsePairKey(bad), null, bad);
  assert.deepEqual(['rh:BTC', 'lighter:1000PEPE', RH_BTC, 'rh:btc', 'BTC', 'entropy:BTC'].map(upgradeKey), [RH_BTC, 'var:1000PEPE|lighter:1000PEPE', RH_BTC, null, null, null]);
  assert.deepEqual([RH_BTC, LIGHTER_BTC, 'var:BTC|entropy:BTC', `${RH_BTC}@2`, 'rh:BTC|lighter:BTC', 'var:io.x|rh:io.x', 'var:A|rh:B'].map(legacyKeyOf), ['rh:BTC', 'lighter:BTC', null, null, null, null, null]);
  assert.deepEqual([RH_BTC, 'var:OPENAI|entropy:OAI@0.137', 'var:A|rh:B', 'junk'].map(pairTitle), ['BTC', 'OPENAI / OAI ×0.137', 'A / B', 'junk']);
  assert.equal(pairKey({ venue: 'var', symbol: 'BTC' }, { venue: 'rh', symbol: 'BTC' }, 1), RH_BTC);
  assert.equal(pairKey({ venue: 'var', symbol: 'OPENAI' }, { venue: 'entropy', symbol: 'OAI' }, 0.1370000000001), 'var:OPENAI|entropy:OAI@0.137');
  assert.deepEqual([formatRatio(0.000001234567891), formatRatio(0.1370000000001), formatRatio(2)], ['0.0000012346', '0.137', '2']);
  assert.throws(() => parseRhMarkets({ code: 500 }, 'lighter'), /^Error: Lighter 合约目录格式无效$/);
});

test('Entropy 目录：只收 io: 永续、跳过下架与精度越界，费率按部署方系数与增长模式，抵押资产变化拒绝；自动与手动配对的身份', () => {
  const universe = [
    { name: 'io:SNDK', szDecimals: 2, deployerFeeScale: '0.5', growthMode: 'disabled' },
    { name: 'io:OAI', szDecimals: 1, deployerFeeScale: '1', growthMode: 'enabled' },
    { name: 'io:OLD', szDecimals: 1, isDelisted: true },
    { name: 'BTC', szDecimals: 5 },
    { name: 'io:NEW', szDecimals: 0 },
    { name: 'io:BIG', szDecimals: 13 },
  ];
  const contexts = [{ markPx: '100.3', oraclePx: '100.4', funding: '0.0000125' }, { markPx: '730', oraclePx: '731', funding: '0' }, {}, {}, { markPx: '5' }, { markPx: '1' }];
  const markets = parseEntropyMarkets([{ universe, collateralToken: 0 }, contexts]);
  assert.deepEqual(markets.map(market => [market.symbol, market.id]), [['SNDK', 0], ['OAI', 1], ['NEW', 4]]);
  assert.equal(markets[0].takerFeeBps, 6.75);
  assert.ok(Math.abs(markets[1].takerFeeBps! - 0.9) < 1e-9);
  assert.equal(markets[2].takerFeeBps, null, '没有费率字段时未知');
  assert.deepEqual([markets[0].coin, markets[0].priceDecimals, markets[0].index, markets[0].mark, markets[0].fundingHourly, markets[0].minQuote], ['io:SNDK', 4, 100.4, 100.3, 0.0000125, 10]);
  assert.throws(() => parseEntropyMarkets({}), /Entropy 目录格式无效/);
  assert.throws(() => parseEntropyMarkets([{ universe, collateralToken: 1 }, contexts]), /抵押资产发生变化/);
  // Var 对 Entropy：已核对表里且 Entropy 一侧是每股合约的为已核对，其余待确认；顺序沿用 A 场所的目录。
  const auto = comboPairs('var|entropy', [spec('var', 'SNDK', 100.2), spec('var', 'AAPL', 200)], [spec('entropy', 'SNDK', 100.3), spec('entropy', 'AAPL', 200.1)]);
  assert.deepEqual(auto.map(pair => [pair.key, pair.identity]), [['var:SNDK|entropy:SNDK', 'verified'], ['var:AAPL|entropy:AAPL', 'review']]);
  // 手动配对按乘数折算后比较标记价。
  const custom = { a: { venue: 'var' as const, symbol: 'OPENAI' }, b: { venue: 'entropy' as const, symbol: 'OAI' }, ratio: 0.137, kind: 'private' as const, note: '' };
  const info = customPairInfo(custom, spec('var', 'OPENAI', 100), spec('entropy', 'OAI', 730));
  assert.ok(Math.abs(info.gapBps! + 0.9999) < 1e-3);
  assert.deepEqual([info.key, info.identity, info.symbol, info.custom, info.kind], ['var:OPENAI|entropy:OAI@0.137', 'review', 'OPENAI / OAI ×0.137', true, 'private']);
  assert.equal(customPairInfo({ ...custom, ratio: 1 }, spec('var', 'OPENAI', 100), spec('entropy', 'OAI', 730)).identity, 'mismatch');
});

test('手动配对校验：未知字段、腿、同场所、乘数、类别、备注；乘数规整与配对键', () => {
  const base = { a: { venue: 'var', symbol: 'OPENAI' }, b: { venue: 'entropy', symbol: 'OAI' } };
  const pair = readCustomPair({ ...base, ratio: 0.1370000000001, note: '  估值口径 ' });
  assert.deepEqual(pair, { a: { venue: 'var', symbol: 'OPENAI' }, b: { venue: 'entropy', symbol: 'OAI' }, ratio: 0.137, kind: 'other', note: '估值口径' });
  assert.equal(customKey(pair), 'var:OPENAI|entropy:OAI@0.137');
  assert.equal(customKey(readCustomPair(base)), 'var:OPENAI|entropy:OAI');
  assert.throws(() => readCustomPair(null), /须为对象/);
  assert.throws(() => readCustomPair({ ...base, extra: 1 }), /未知字段/);
  assert.throws(() => readCustomPair({ ...base, a: { venue: 'binance', symbol: 'X' } }), /A 腿无效/);
  assert.throws(() => readCustomPair({ ...base, b: { venue: 'rh', symbol: 'bad symbol' } }), /B 腿无效/);
  assert.throws(() => readCustomPair({ ...base, b: { venue: 'rh', symbol: 'X', id: 1 } }), /B 腿无效/);
  assert.throws(() => readCustomPair({ ...base, b: { venue: 'var', symbol: 'OAI' } }), /不同场所/);
  for (const ratio of [0, -1, 2e6, '1', Number.NaN]) assert.throws(() => readCustomPair({ ...base, ratio }), /乘数须为/, String(ratio));
  assert.throws(() => readCustomPair({ ...base, kind: 'stock' }), /类别无效/);
  assert.throws(() => readCustomPair({ ...base, note: 'x'.repeat(81) }), /80 字/);
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

test('价差口径：卖 A 用 A 买价减折算后的 B 卖价，买 A 用 A 卖价减折算后的 B 买价，相对折算后的 B 中间价', () => {
  const value = sample(T0, 100.5);
  assert.ok(Math.abs(midBasis(value) - 50) < 1e-9);
  const spread = spreadOf(value, '1k')!;
  assert.ok(Math.abs(spread.sellA - (100.48 - 100.02) / 100 * 1e4) < 1e-9);
  assert.ok(Math.abs(spread.buyA - (100.52 - 99.98) / 100 * 1e4) < 1e-9);
  assert.equal(spread.estimated, false);
  assert.equal(spreadOf(value, '100k'), null, '100k 档需要 B 腿完整盘口');
  assert.equal(spreadOf(sample(T0, 100, 100, { bBid1k: null, bAsk1k: null }), '1k')!.estimated, true);
  // 乘数 0.5：B 价 200 折成 100。
  const scaled = sample(T0, 100.5, 200, { ratio: 0.5 });
  const half = spreadOf(scaled, '1k')!;
  assert.ok(Math.abs(midBasis(scaled) - 50) < 1e-9);
  assert.ok(Math.abs(half.sellA - 47) < 1e-9);
  assert.ok(Math.abs(half.buyA - 53) < 1e-9);
  assert.ok(Math.abs(half.prices.bMid - 100) < 1e-9);
  assert.ok(Math.abs(half.prices.bAsk - 100.01) < 1e-9);
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

test('开平仓：A 偏贵卖 A 买 B，回到基线平仓，按两腿成交价与四次成交的滑点和手续费结算；乘数折算数量与 B 价', () => {
  const params: SymbolParams = { ...DEFAULT_SYMBOL, enabled: true, entryBps: 10, exitBps: 0 };
  const baseline = { regime: 'all' as const, median: 0, sigma: 2, samples: 500, since: T0, fallback: false };
  const rich = sample(T0, 100.3);
  const open = decide(rich, baseline, params, null);
  assert.equal(open.kind, 'open');
  if (open.kind !== 'open') return;
  assert.equal(open.direction, 'a_rich');
  const held = openPosition('p1', rich, params, open, baseline, ZERO_FEES);
  assert.equal(held.aEntry, 100.28);
  assert.equal(held.bEntry, 100.02);
  assert.equal(held.ratio, 1);
  assert.equal(decide(sample(T0 + 60_000, 100.1), baseline, params, held).kind, 'hold');
  const back = sample(T0 + 120_000, 99.97);
  const close = decide(back, baseline, params, held);
  assert.equal(close.kind, 'close');
  if (close.kind !== 'close') return;
  assert.equal(close.reason, 'revert');
  const trade = closePosition(held, back.t, close.spread, close.reason, { slippageBps: 1 }, null);
  const qty = 1000 / 100;
  const gross = (100.28 - 99.99) * qty + (99.98 - 100.02) * qty;
  assert.ok(Math.abs(trade.grossUsd - gross) < 1e-9);
  const cost = (qty * (100.28 + 99.99) + qty * (100.02 + 99.98)) / 1e4;
  assert.ok(Math.abs(trade.netUsd - (gross - cost)) < 1e-9);
  // 手续费按开仓时记下的每腿费率。
  const paid = openPosition('p2', rich, params, open, baseline, { aFeeBps: 2, bFeeBps: 3 });
  const feeTrade = closePosition(paid, back.t, close.spread, close.reason, { slippageBps: 1 }, null);
  assert.ok(Math.abs(feeTrade.costUsd - (qty * (100.28 + 99.99) * 3 + qty * (100.02 + 99.98) * 4) / 1e4) < 1e-9);
  assert.equal(decide(sample(T0 + 60_000, 99), baseline, { ...params, stopBps: 30 }, held).kind === 'close', true, '浮亏达到止损线平仓');
  // 乘数 0.5：数量按折算后的 B 中间价，B 成交价记折算价。
  const scaled = sample(T0, 100.3, 200, { ratio: 0.5 });
  const scaledOpen = decide(scaled, baseline, params, null);
  assert.equal(scaledOpen.kind, 'open');
  if (scaledOpen.kind !== 'open') return;
  const scaledHeld = openPosition('p3', scaled, params, scaledOpen, baseline, ZERO_FEES);
  assert.ok(Math.abs(scaledHeld.qty - 10) < 1e-9);
  assert.ok(Math.abs(scaledHeld.bEntry - 100.01) < 1e-9);
  assert.equal(scaledHeld.ratio, 0.5);
});

test('开仓风控：暂停、未确认规格、时段、报价过旧、冷却、手续费未知、同腿互斥、持仓与名义上限、当日亏损', () => {
  const params: SymbolParams = { ...DEFAULT_SYMBOL, enabled: true, regimes: ['all'] };
  const context = { openPositions: 0, openNotionalUsd: 0, dailyNetUsd: 0, cooldownUntil: 0, eligible: true };
  const value = sample(T0, 100);
  assert.equal(openBlocker(value, params, DEFAULT_GLOBAL, context), null);
  assert.equal(openBlocker(value, params, { ...DEFAULT_GLOBAL, paused: true }, context), '已暂停');
  assert.equal(openBlocker(value, { ...params, enabled: false }, DEFAULT_GLOBAL, context), '未启用');
  assert.equal(openBlocker(value, params, DEFAULT_GLOBAL, { ...context, eligible: false }), '规格未确认');
  assert.equal(openBlocker({ ...value, regime: 'rth' }, params, DEFAULT_GLOBAL, context), '当前时段不开仓');
  assert.equal(openBlocker({ ...value, receivedAt: value.t + 120_000 }, params, DEFAULT_GLOBAL, context), '报价过旧');
  assert.equal(openBlocker(value, params, DEFAULT_GLOBAL, { ...context, cooldownUntil: T0 + 1 }), '冷却中');
  assert.equal(openBlocker(value, params, DEFAULT_GLOBAL, { ...context, feeUnknown: true }), FEE_BLOCK);
  assert.equal(openBlocker(value, params, DEFAULT_GLOBAL, { ...context, legBusy: true }), BUSY_BLOCK);
  assert.equal(openBlocker(value, params, DEFAULT_GLOBAL, { ...context, openPositions: 5 }), '持仓数已满');
  assert.equal(openBlocker(value, params, DEFAULT_GLOBAL, { ...context, openNotionalUsd: 9_500 }), '名义合计将超上限');
  assert.equal(openBlocker(value, params, DEFAULT_GLOBAL, { ...context, dailyNetUsd: -100 }), '当日亏损已达上限');
});

/** 基差围绕 20 基点来回摆动：每 30 分钟冲高到 45 一次。 */
function oscillating(count: number): Sample[] {
  return Array.from({ length: count }, (_, index) => sample(T0 + index * 60_000, 100 * (1 + (index % 30 === 15 ? 45 : 20) / 1e4)));
}

test('回测：基差冲高时卖 A，回到基线平仓；只用当时以前的样本；手续费未知不开', () => {
  const samples = oscillating(600);
  const params: SymbolParams = { ...DEFAULT_SYMBOL, entryBps: 15, exitBps: 2, cooldownMinutes: 0, regimes: ['all'] };
  const global = { ...DEFAULT_GLOBAL, windowHours: 2, minSamples: 30 };
  const result = runBacktest(RH_BTC, 'crypto', samples, T0 + 60 * 60_000, T0 + 600 * 60_000, params, global, ZERO_FEES);
  assert.ok(result.trades.length >= 15, `应有约 18 笔，实际 ${result.trades.length}`);
  assert.ok(result.trades.every(trade => trade.direction === 'a_rich' && trade.reason === 'revert'));
  assert.ok(result.summary.netUsd > 0);
  assert.ok(result.trades.every(trade => trade.openedAt >= T0 + 60 * 60_000));
  // 未来的样本不能改变过去的判断：截掉后半段，前半段的成交不变。
  const half = runBacktest(RH_BTC, 'crypto', samples.slice(0, 300), T0 + 60 * 60_000, T0 + 600 * 60_000, params, global, ZERO_FEES);
  assert.deepEqual(half.trades.map(trade => trade.openedAt), result.trades.filter(trade => trade.closedAt < T0 + 300 * 60_000).map(trade => trade.openedAt));
  const unknown = runBacktest(RH_BTC, 'crypto', samples, T0 + 60 * 60_000, T0 + 600 * 60_000, params, global, null);
  assert.equal(unknown.trades.length, 0);
  assert.ok(unknown.summary.blocked[FEE_BLOCK] >= 15);
  assert.throws(() => backtestRequest({ symbol: 'rh:BTC', hours: 0 }, {}, DEFAULT_GLOBAL), /回测时长/);
  assert.throws(() => backtestRequest({ symbol: 'BTC', hours: 24 }, {}, DEFAULT_GLOBAL), /配对键无效/);
  const request = backtestRequest({ symbol: 'lighter:BTC', hours: 24, params: { entryBps: 30 } }, {}, DEFAULT_GLOBAL);
  assert.deepEqual([request.symbol, request.params.entryBps], [LIGHTER_BTC, 30]);
});

test('开仓复核：按判断时刻的 B 腿一档重算，信号消失不开、仍成立按那一刻的价成交；全天基线与预期净利不足不开仓；滑点预算', () => {
  const params: SymbolParams = { ...DEFAULT_SYMBOL, enabled: true, entryBps: 10, exitBps: 0, regimes: ['all'] };
  const baseline = { regime: 'all' as const, median: 0, sigma: 2, samples: 500, since: T0, fallback: false };
  const context = { openPositions: 0, openNotionalUsd: 0, dailyNetUsd: 0, cooldownUntil: 0, eligible: true };
  const open = (value: Sample) => { const decision = decide(value, baseline, params, null); assert.equal(decision.kind, 'open'); return decision as Extract<typeof decision, { kind: 'open' }>; };
  // 报价时刻卖 A 价差 26 基点；拿到报价时 B 已涨到 100.2，只剩约 6 基点。
  const gone = sample(T0, 100.3, 100, { bBidRx: 100.19, bAskRx: 100.21 });
  assert.equal(confirmOpen(gone, baseline, params, open(gone), true), DECAYED);
  // B 只涨了 5 分：仍有约 21 基点，按 100.07（那一刻的一档加原来的冲击）买入。
  const still = sample(T0, 100.3, 100, { bBidRx: 100.04, bAskRx: 100.06 });
  const confirmed = confirmOpen(still, baseline, params, open(still), true);
  assert.ok(typeof confirmed !== 'string');
  if (typeof confirmed === 'string') return;
  assert.ok(Math.abs(confirmed.sample.bAsk1k! - 100.07) < 1e-9);
  assert.ok(Math.abs(confirmed.decision.deviation - (100.28 - 100.07) / 100.05 * 1e4) < 1e-6);
  const held = openPosition('p1', confirmed.sample, params, confirmed.decision, baseline, ZERO_FEES);
  assert.ok(Math.abs(held.bEntry - 100.07) < 1e-9);
  // 没有记录那一刻的一档：模拟盘不开，回测旧样本沿用样本本身。
  const legacy = sample(T0, 100.3, 100, { bBidRx: null, bAskRx: null });
  assert.equal(executionSample(legacy), null);
  assert.equal(confirmOpen(legacy, baseline, params, open(legacy), true), NO_LIVE_TOP);
  assert.equal((confirmOpen(legacy, baseline, params, open(legacy), false) as { sample: Sample }).sample, legacy);
  // 平仓同样按那一刻的价：卖出 B 用 100.04 − 0.01。
  const exit = closeSpread(still, held, spreadOf(still, '1k')!);
  assert.ok(Math.abs(exit.prices.bBid - 100.03) < 1e-9);
  // 预期净利：偏离 26 − 出场 0 − 半个往返成本 4 − 四次滑点 4 = 18 基点。
  const plain = sample(T0, 100.3), net = expectedNetBps(open(plain), params, COSTS);
  assert.ok(Math.abs(net - 18) < 1e-6);
  assert.ok(Math.abs(expectedNetBps(open(plain), params, { slippageBps: 1, aFeeBps: 1, bFeeBps: 0.5 }) - 15) < 1e-6, '每腿手续费各扣两次');
  assert.equal(openBlocker(plain, params, DEFAULT_GLOBAL, { ...context, expectedNetBps: net }), null);
  assert.equal(openBlocker(plain, params, { ...DEFAULT_GLOBAL, minNetBps: 19 }, { ...context, expectedNetBps: net }), THIN_BLOCK);
  assert.equal(openBlocker(plain, params, DEFAULT_GLOBAL, { ...context, fallbackBaseline: true }), FALLBACK_BLOCK);
  assert.equal(openBlocker({ ...plain, receivedAt: plain.t + 31_000 }, params, DEFAULT_GLOBAL, context), '报价过旧', '默认时效 30 秒');
  assert.equal(openBlocker(plain, params, DEFAULT_GLOBAL, { ...context, expectedNetBps: 50, costBps: 60 }), COST_BLOCK, '往返成本达到止损线，偏离再大也不开');
  // 滑点预算：偏离刚好等于入场线、四次成交把保护用满后仍剩最低净利；每腿 1 到 10 基点。
  const fees = { minNetBps: 3, ...ZERO_FEES };
  assert.equal(slippageBudgetBps({ entryBps: 15, exitBps: 0 }, fees, 4), 2);
  assert.equal(15 - 0 - 4 - 4 * 2, 3, '用满后正好剩最低净利');
  assert.equal(slippageBudgetBps({ entryBps: 15, exitBps: 0 }, { ...fees, aFeeBps: 1, bFeeBps: 1 }, 0), 2);
  assert.equal(slippageBudgetBps({ entryBps: 4, exitBps: 2 }, fees, 4), 1);
  assert.equal(slippageBudgetBps({ entryBps: 200, exitBps: 0 }, fees, 4), 10);
});

test('回测与模拟盘同规则：按判断时刻的价开平仓，信号消失、净利不足、成本达止损线、全天基线、当时没有一档都不开', () => {
  const params: SymbolParams = { ...DEFAULT_SYMBOL, entryBps: 15, exitBps: 2, cooldownMinutes: 0 };
  const global = { ...DEFAULT_GLOBAL, windowHours: 2, minSamples: 30 };
  const run = (samples: Sample[], symbol: Partial<SymbolParams> = {}, extra: Partial<typeof global> = {}, kind: 'crypto' | 'equity' = 'crypto') =>
    runBacktest(RH_BTC, kind, samples, T0 + 60 * 60_000, T0 + 600 * 60_000, { ...params, ...symbol }, { ...global, ...extra }, ZERO_FEES);
  const spike = (index: number) => index % 30 === 15;
  // 冲高时 B 只涨 5 分，其余时刻 B 在 99.95：开仓买在 100.07，平仓卖在 99.93，都不是报价时刻的价。
  const moved = oscillating(600).map((item, index) => spike(index) ? { ...item, bBidRx: 100.04, bAskRx: 100.06 } : { ...item, bBidRx: 99.94, bAskRx: 99.96 });
  const filled = run(moved);
  assert.ok(filled.trades.length >= 15);
  assert.ok(filled.trades.every(trade => Math.abs(trade.bEntry - 100.07) < 1e-9 && Math.abs(trade.bExit - 99.93) < 1e-9));
  // 同样的行情：复核后的预期净利约 6 基点、往返成本约 8 基点。
  const thin = run(moved, {}, { minNetBps: 7 });
  assert.equal(thin.trades.length, 0);
  assert.ok(thin.summary.blocked[THIN_BLOCK] >= 15);
  const costly = run(moved, { stopBps: 7.9 });
  assert.equal(costly.trades.length, 0);
  assert.ok(costly.summary.blocked[COST_BLOCK] >= 15);
  // 每次冲高在拿到报价时 B 都已跟上。
  const chased = run(oscillating(600).map((item, index) => spike(index) ? { ...item, bBidRx: 100.24, bAskRx: 100.26 } : item));
  assert.equal(chased.trades.length, 0);
  assert.ok(chased.summary.blocked[DECAYED] >= 15);
  // 已开始记录判断时刻的一档之后，冲高时没有它（行情流当时不可用）不开；整段都没有的旧样本沿用样本本身。
  const gaps = run(oscillating(600).map((item, index) => spike(index) ? { ...item, bBidRx: null, bAskRx: null } : item));
  assert.equal(gaps.trades.length, 0);
  assert.ok(gaps.summary.blocked[NO_LIVE_TOP] >= 15);
  assert.ok(run(oscillating(600).map(item => ({ ...item, bBidRx: null, bAskRx: null }))).trades.length >= 15);
  // 美股：第 200 分钟从夜盘切到盘中，第 225 分钟的冲高时盘中样本只有 25 个，基线退回全天，不开；第 255 分钟照常开。
  const equity = run(oscillating(600).map((item, index) => ({ ...item, regime: index < 200 ? 'overnight' as const : 'rth' as const })), {}, {}, 'equity');
  assert.equal(equity.summary.blocked[FALLBACK_BLOCK], 1);
  assert.equal(equity.trades.some(trade => trade.openedAt === T0 + 225 * 60_000), false);
  assert.equal(equity.trades.some(trade => trade.openedAt === T0 + 255 * 60_000), true);
});

/** v0.87.0 以前存的全局参数：手续费是数，没有 minNetBps 等新字段。 */
const LEGACY_GLOBAL = { windowHours: 24, minSamples: 120, slippageBps: 1, varFeeBps: 0, rhFeeBps: 0, maxQuoteAgeSec: 30, maxOpenPositions: 5, maxTotalNotionalUsd: 10_000, dailyLossLimitUsd: 100, paused: false };

test('旧参数重开：globalExtra 里只取认识的键，旧采集场所换成组合', () => {
  const seeded = (globalExtra: unknown) => seededEngine(store => store.setState('settings', { revision: 3, global: LEGACY_GLOBAL, symbols: { 'rh:BTC': { enabled: true } }, confirmed: [], venues: ['rh'], globalExtra }, T0));
  for (const [extra, expected] of [[{ minNetBps: 8, futureParam: 1, paused: true }, 8], [{ minNetBps: 'x' }, 3], [{ minNetBps: -1 }, 3], [null, 3], [undefined, 3]] as const) {
    const context = seeded(extra);
    try {
      const settings = context.engine.views.state().settings;
      assert.equal(settings.revision, 3);
      assert.equal(settings.symbols[RH_BTC].enabled, true);
      assert.equal(settings.global.minNetBps, expected);
      assert.equal(settings.global.paused, false);
      assert.deepEqual(settings.combos, ['var|rh', 'var|entropy']);
    } finally { context.dispose(); }
  }
});

test('旧参数换算：键与方向换新写法、手续费 0 改为按目录、确认列表去重排序、采集场所换成组合；冷却与旧持仓的手续费', () => {
  const upgraded = upgradeSettings({
    revision: 7, global: { ...LEGACY_GLOBAL, varFeeBps: 0, rhFeeBps: 0.5 },
    symbols: { 'rh:BTC': { enabled: true, directions: ['var_cheap'] }, 'bad key': { enabled: true }, 'lighter:ETH': { entryBps: 5, exitBps: 5 } },
    confirmed: ['rh:X', 'lighter:X', 'rh:X', 'bad'], venues: ['lighter'], globalExtra: { minNetBps: 7 },
  });
  assert.equal(upgraded.revision, 7);
  assert.deepEqual([upgraded.global.varFeeBps, upgraded.global.rhFeeBps, upgraded.global.lighterFeeBps, upgraded.global.entropyFeeBps, upgraded.global.minNetBps], [null, 0.5, 0.5, null, 7]);
  assert.deepEqual(Object.keys(upgraded.symbols), [RH_BTC]);
  assert.deepEqual(upgraded.symbols[RH_BTC].directions, ['a_cheap']);
  assert.deepEqual(upgraded.confirmed, ['var:X|lighter:X', 'var:X|rh:X']);
  assert.deepEqual(upgraded.combos, ['var|lighter', 'var|entropy', 'lighter|entropy']);
  assert.deepEqual(upgraded.pairs, []);
  assert.deepEqual(upgradeSettings({ venues: ['rh'] }).combos, ['var|rh', 'var|entropy']);
  assert.deepEqual(upgradeSettings({}).combos, [...DEFAULT_COMBOS]);
  assert.deepEqual(upgradeSettings(null), { revision: 0, global: DEFAULT_GLOBAL, symbols: {}, confirmed: [], combos: [...DEFAULT_COMBOS], pairs: [] });
  assert.deepEqual(LEGACY_UPGRADE.cooldown({ 'rh:BTC': 5, bad: 6, 'lighter:ETH': 'x' }), { [RH_BTC]: 5 });
  assert.deepEqual(LEGACY_UPGRADE.cooldown(null), {});
  assert.deepEqual(LEGACY_UPGRADE.fees({ global: { varFeeBps: 1, rhFeeBps: -2 } }), { aFeeBps: 1, bFeeBps: 0 });
  assert.deepEqual(LEGACY_UPGRADE.fees(null), ZERO_FEES);
});

test('旧库迁移：持仓与成交换成两腿口径复制到新表，参数与冷却换新键，只做一次，旧表与旧键原样保留；引擎启动时迁移并记日志', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tp-varlighter-'));
  const file = path.join(dir, 'varlighter.sqlite');
  const legacyPosition = { id: 'p1', symbol: 'rh:BTC', direction: 'var_rich', openedAt: T0 - 3_600_000, qty: 10, notionalUsd: 1_000, entrySpread: 20, entryBaseline: 0, entryRegime: 'rth', varEntry: 100.3, rhEntry: 100.01, estimated: false };
  try {
    openVarLighterStore(file).close();
    const raw = new DatabaseSync(file);
    const state = raw.prepare('INSERT INTO state(key, json, updated_at) VALUES (?, ?, ?)');
    state.run('settings', JSON.stringify({ revision: 5, global: { ...LEGACY_GLOBAL, varFeeBps: 1, rhFeeBps: 2 }, symbols: { 'rh:BTC': { enabled: true, directions: ['var_rich'] } }, confirmed: [], venues: ['rh', 'lighter'], globalExtra: { minNetBps: 6 } }), T0);
    state.run('cooldown', JSON.stringify({ 'rh:BTC': T0 + 5 }), T0);
    const insertPosition = raw.prepare('INSERT INTO paper_positions(id, symbol, json) VALUES (?, ?, ?)');
    insertPosition.run('p1', 'rh:BTC', JSON.stringify(legacyPosition));
    insertPosition.run('p2', 'rh:ETH', JSON.stringify({ ...legacyPosition, id: 'p2', symbol: 'rh:ETH', direction: 'sideways' }));
    raw.prepare('INSERT INTO paper_trades(id, symbol, closed_at, net_usd, json) VALUES (?, ?, ?, ?, ?)').run('t1', 'lighter:ETH', T0 - 60_000, 1.5,
      JSON.stringify({ ...legacyPosition, id: 't1', symbol: 'lighter:ETH', direction: 'var_cheap', closedAt: T0 - 60_000, varExit: 100.2, rhExit: 100.1, exitSpread: 1, reason: 'revert', grossUsd: 2, costUsd: 0.5, netUsd: 1.5, netBps: 15, fundingUsd: null }));
    raw.close();

    const store = openVarLighterStore(file);
    try {
      assert.deepEqual(store.positions(), [], '打开库不迁移，引擎启动时才迁移');
      assert.deepEqual(store.migrateLegacy(T0, LEGACY_UPGRADE), { positions: 1, trades: 1, skipped: 1 });
      const [moved] = store.positions();
      assert.deepEqual({ ...moved }, { id: 'p1', symbol: RH_BTC, direction: 'a_rich', openedAt: T0 - 3_600_000, qty: 10, notionalUsd: 1_000, entrySpread: 20, entryBaseline: 0, entryRegime: 'rth',
        estimated: false, aEntry: 100.3, bEntry: 100.01, ratio: 1, aFeeBps: 1, bFeeBps: 2 });
      const [trade] = store.trades(10);
      assert.deepEqual([trade.symbol, trade.direction, trade.aExit, trade.bExit, 'varExit' in trade], ['var:ETH|lighter:ETH', 'a_cheap', 100.2, 100.1, false]);
      const settings = store.state<{ revision: number; combos: string[]; global: GlobalParams; symbols: Record<string, SymbolParams> }>(SETTINGS_KEY)!;
      assert.deepEqual([settings.revision, settings.combos, settings.global.minNetBps, settings.global.varFeeBps, settings.global.lighterFeeBps], [5, [...DEFAULT_COMBOS], 6, 1, 2]);
      assert.deepEqual(settings.symbols[RH_BTC].directions, ['a_rich']);
      assert.deepEqual(store.state(COOLDOWN_KEY), { [RH_BTC]: T0 + 5 });
      assert.deepEqual(store.state(MIGRATED_KEY), { at: T0, positions: 1, trades: 1, skipped: 1 });
      const event = store.events(5)[0];
      assert.deepEqual([event.kind, event.message], ['migrate', '已升级为两腿口径：持仓 1 笔、成交 1 笔，1 条无法识别未迁移']);
      assert.equal(store.migrateLegacy(T0 + 1, LEGACY_UPGRADE), false, '只迁移一次');
      assert.equal(store.positions().length, 1);
      assert.ok(store.state('settings'), '旧键保留');
    } finally { store.close(); }
    const check = new DatabaseSync(file);
    try {
      assert.deepEqual([(check.prepare('SELECT COUNT(*) AS n FROM paper_positions').get() as { n: number }).n, (check.prepare('SELECT COUNT(*) AS n FROM paper_trades').get() as { n: number }).n], [2, 1], '旧表原样保留');
    } finally { check.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }

  // 引擎启动时迁移：有旧持仓记一行日志；全新安装什么都不记。
  for (const legacy of [true, false]) {
    const lines: string[] = [];
    const context = seededEngine(() => {}, { log: line => lines.push(line), raw: legacy ? db => db.prepare('INSERT INTO paper_positions(id, symbol, json) VALUES (?, ?, ?)').run('p1', 'rh:BTC', JSON.stringify(legacyPosition)) : undefined });
    try {
      const migrated = lines.filter(line => line.includes('已升级为两腿口径'));
      assert.deepEqual(migrated, legacy ? ['varlighter: 已升级为两腿口径（持仓 1、成交 0）'] : []);
      if (legacy) assert.deepEqual(context.engine.views.paper().positions.map(item => [item.symbol, item.direction, item.aEntry]), [[RH_BTC, 'a_rich', 100.3]]);
    } finally { context.dispose(); }
  }
});

test('样本库升级：旧库补上判断时刻一档的两列，旧样本读成空，重复打开不报错', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tp-varlighter-'));
  const file = path.join(dir, 'varlighter.sqlite');
  try {
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE samples (symbol TEXT NOT NULL, t INTEGER NOT NULL, received_at INTEGER NOT NULL, regime TEXT NOT NULL,
      var_mark REAL NOT NULL, var_bid0 REAL NOT NULL, var_ask0 REAL NOT NULL, var_bid1k REAL NOT NULL, var_ask1k REAL NOT NULL, var_bid100k REAL, var_ask100k REAL, var_funding REAL,
      rh_at INTEGER NOT NULL, rh_bid0 REAL NOT NULL, rh_ask0 REAL NOT NULL, rh_mark REAL, rh_index REAL, rh_funding REAL, rh_bid1k REAL, rh_ask1k REAL, rh_bid100k REAL, rh_ask100k REAL,
      PRIMARY KEY (symbol, t)) WITHOUT ROWID;
      INSERT INTO samples(symbol, t, received_at, regime, var_mark, var_bid0, var_ask0, var_bid1k, var_ask1k, rh_at, rh_bid0, rh_ask0) VALUES ('rh:BTC', 1000, 2000, 'all', 100, 99.9, 100.1, 99.8, 100.2, 900, 99.95, 100.05);`);
    old.close();
    for (let round = 0; round < 2; round++) {
      const store = openVarLighterStore(file);
      try {
        const before = store.samples(RH_BTC, 0, 1500)[0];
        assert.deepEqual([before.symbol, before.ratio, before.aAt, before.aBid0, before.bAt, before.bBidRx], [RH_BTC, 1, 1000, 99.9, 900, null], '旧表的样本按新键读出');
        if (round === 0) assert.equal(store.addSamples([sample(5000, 100.2, 100, { symbol: RH_BTC })]), 1);
        assert.equal(store.latest(RH_BTC)!.bAskRx, 100.01);
      } finally { store.close(); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
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

test('Entropy 行情流：按配对订阅 bbo，没有一档或长时间没变化的用 l2Book 确认，定时 ping，错误频道记原因，增减市场即时订阅与退订，沉默重连', () => {
  let clock = T0;
  const sockets: FakeSocket[] = [], urls: string[] = [];
  const stream = new HyperliquidStream({ connect: url => { urls.push(url); const socket = new FakeSocket(); sockets.push(socket); return socket; }, now: () => clock });
  try {
    stream.setMarkets(new Map([[0, 'io:SNDK'], [1, 'io:OAI']]));
    stream.start();
    assert.deepEqual(urls, ['wss://api.hyperliquid.xyz/ws']);
    const socket = sockets[0];
    socket.open();
    assert.deepEqual(socket.sent, [{ method: 'subscribe', subscription: { type: 'bbo', coin: 'io:SNDK' } }, { method: 'subscribe', subscription: { type: 'bbo', coin: 'io:OAI' } }]);
    assert.equal(stream.healthySince(), null, '还没收到消息');
    socket.push({ channel: 'bbo', data: { coin: 'io:SNDK', time: T0, bbo: [{ px: '99.9', sz: '1', n: 1 }, { px: '100.1', sz: '1', n: 1 }] } });
    socket.push({ channel: 'bbo', data: { coin: 'io:OTHER', bbo: [{ px: '1', sz: '1', n: 1 }, { px: '2', sz: '1', n: 1 }] } });
    assert.deepEqual([stream.topAt(0, T0)?.bid, stream.topAt(0, T0)?.ask, stream.healthySince()], [99.9, 100.1, T0]);
    assert.equal(stream.topAt(1, T0), null, '没订阅到的市场没有一档');
    // 20 秒：先 ping；OAI 还没有一档，发 l2Book 确认；SNDK 刚有一档不确认。
    clock = T0 + 20_000;
    socket.push({ channel: 'pong' });
    socket.sent.length = 0;
    stream.tick();
    assert.deepEqual(socket.sent, [{ method: 'ping' }, { method: 'post', id: 1, request: { type: 'info', payload: { type: 'l2Book', coin: 'io:OAI' } } }]);
    const reply = (id: number, coin: string, bid: string, ask: string) => socket.push({ channel: 'post', data: { id, response: { type: 'info', payload: { type: 'l2Book', data: { coin, time: clock, levels: [[{ px: bid, sz: '2', n: 1 }], [{ px: ask, sz: '2', n: 1 }]] } } } } });
    reply(1, 'io:OAI', '730', '731');
    reply(99, 'io:OAI', '1', '2');
    assert.deepEqual([stream.topAt(1, clock)?.bid, stream.topAt(1, clock)?.ask], [730, 731], '不认识编号的回应不用');
    // 51 秒：SNDK 一档已 51 秒没变化，确认一次；OAI 刚确认过不发。
    clock = T0 + 51_000;
    socket.push({ channel: 'pong' });
    socket.sent.length = 0;
    stream.tick();
    assert.deepEqual(socket.sent, [{ method: 'ping' }, { method: 'post', id: 2, request: { type: 'info', payload: { type: 'l2Book', coin: 'io:SNDK' } } }]);
    reply(2, 'io:SNDK', '100', '100.2');
    assert.equal(stream.topAt(0, clock)?.bid, 100);
    assert.equal(stream.topAt(0, T0 + 30_000)?.bid, 99.9, '按时刻回看');
    socket.push({ channel: 'error', data: 'Invalid subscription' });
    assert.equal(stream.status(2).lastError, 'Invalid subscription');
    // 换市场：退订去掉的，订阅新加的。
    socket.sent.length = 0;
    stream.setMarkets(new Map([[1, 'io:OAI'], [4, 'io:NEW']]));
    assert.deepEqual(socket.sent, [{ method: 'unsubscribe', subscription: { type: 'bbo', coin: 'io:SNDK' } }, { method: 'subscribe', subscription: { type: 'bbo', coin: 'io:NEW' } }]);
    assert.equal(stream.marketCount, 2);
    // 45 秒没有任何消息：断开重连，区间结束，之前的历史仍可回看。
    clock += 46_000;
    stream.tick();
    assert.deepEqual([stream.status(2).lastError, stream.status(2).reconnects, stream.healthySince(), socket.readyState], ['长时间没有消息', 1, null, 3]);
    assert.equal(stream.topAt(1, T0 + 40_000)?.bid, 730);
    assert.equal(stream.topAt(1, clock), null, '断线之后的时刻没有数据');
  } finally { stream.close(); }
});

test('下单预演：按场所精度向下取整，核对最小数量与金额，连接器未接入时不就绪；Entropy 腿按 5 位有效数字限价', () => {
  const listing = { ticker: 'BTC', name: 'Bitcoin', mark: 100.3, fundingRate: null, fundingIntervalS: null, quote: null };
  const main = { symbol: 'BTC', marketId: 1, mark: 100, sizeDecimals: 2, priceDecimals: 2, minBase: 0.5, minQuote: 10, takerFeeBps: 0, makerFeeBps: 0 };
  const pair = comboPairs('var|lighter', [varMarket(listing)], [lighterMarket('lighter', main)])[0];
  const value = sample(T0, 100.3, 100, { symbol: LIGHTER_BTC });
  const plan = orderPlan(pair, value, 'a_rich', 999.7, 20, T0 + 30_000);
  assert.equal(plan.legs[1].qty, '9.99');
  assert.equal(plan.legs[1].side, 'buy');
  assert.equal(plan.legs[0].side, 'sell');
  assert.equal(plan.legs[1].fields.base_amount, 999);
  assert.equal(plan.legs[1].limit, '100.23');
  assert.equal(plan.ready, false);
  assert.ok(plan.checks.filter(check => !check.ok).every(check => /尚未接入/.test(check.label)));
  assert.equal(plan.symbol, LIGHTER_BTC);
  assert.ok(plan.sequence.some(line => line.includes('Lighter（市场 1）')), '计划写明对手场所与市场编号');
  const small = orderPlan(pair, value, 'a_cheap', 20, 20, T0 + 30_000);
  assert.ok(small.checks.some(check => !check.ok && /最小数量/.test(check.label)));
  // Entropy：sz 两位、价格小数位 6 − 2 = 4，买入限价向上取。
  const [entropy] = parseEntropyMarkets([{ universe: [{ name: 'io:SNDK', szDecimals: 2, deployerFeeScale: '0.5', growthMode: 'disabled' }], collateralToken: 0 }, [{ markPx: '100' }]]);
  const sndk = comboPairs('var|entropy', [varMarket({ ...listing, ticker: 'SNDK', name: 'Sandisk' })], [entropy])[0];
  const entropyPlan = orderPlan(sndk, sample(T0, 100.3, 100, { symbol: sndk.key }), 'a_rich', 999.7, 20, T0 + 30_000);
  assert.deepEqual(entropyPlan.legs[1].fields, { coin: 'io:SNDK', is_buy: true, sz: '9.99', limit_px: '100.2200', order_type: 'limit', tif: 'Ioc', reduce_only: false });
  assert.ok(!entropyPlan.sequence.some(line => line.includes('（市场')), 'Entropy 按代码下单，不写市场编号');
});

test('降采样：每格保留机会极值', () => {
  const points = Array.from({ length: 100 }, (_, index) => ({ t: index, mid: index % 2, sellA: index, buyA: -index, median: 0, sigma: 1 }));
  const result = downsample(points, 10);
  assert.equal(result.length, 10);
  assert.equal(result[0].sellA, 9);
  assert.equal(result[0].buyA, -9);
  assert.equal(result[0].mid, 0.5);
});

test('引擎：各组合各自对齐样本写库，盘口快照，模拟盘开平仓与同腿互斥，关闭组合，参数版本冲突与清空确认', async () => {
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
  const engine = createVarLighterEngine({ store, fetchImpl, connect: url => { const socket = new FakeSocket(); sockets.set(venueOf(url), socket); return socket; }, now: () => clock });
  const rh = () => sockets.get('rh')!, main = () => sockets.get('lighter')!;
  const row = (key: string) => engine.views.state().rows.find(item => item.key === key);
  try {
    engine.startStreams();
    assert.deepEqual([...sockets.keys()].sort(), ['entropy', 'lighter', 'rh'], '默认组合用到三个行情流场所');
    rh().open(); main().open();
    rh().push({ type: 'subscribed/market_stats', channel: 'market_stats:all', market_stats: { 1: { market_id: 1, best_bid_price: '99.99', best_ask_price: '100.01', mark_price: '100', current_funding_rate: '0.001' }, 2: { market_id: 2, best_bid_price: '49.9', best_ask_price: '50.1' } } });
    main().push({ type: 'subscribed/market_stats', channel: 'market_stats:all', market_stats: { 7: { market_id: 7, best_bid_price: '99.99', best_ask_price: '100.01', mark_price: '100' }, 8: { market_id: 8, best_bid_price: '9.999', best_ask_price: '10.001' } } });
    await engine.refreshCatalog(AbortSignal.timeout(1000), 'rh');
    await engine.refreshCatalog(AbortSignal.timeout(1000), 'lighter');
    const signal = AbortSignal.timeout(5000);
    await engine.pollVar(signal);
    assert.equal(engine.views.state().sources.var.poll?.noTop, 3, '规格不同的 OPENAI 不对齐；快照之前的 Var 报价没有对应的对手腿一档');
    assert.deepEqual(engine.views.state().rows.map(item => item.key), [RH_BTC, LIGHTER_BTC, 'var:ETH|lighter:ETH', 'var:OPENAI|rh:OPENAI']);
    assert.equal(requested.filter(url => url.includes('orderBookOrders')).length, 0, '没有启用的配对就不取盘口快照');
    const initial = engine.views.state();
    assert.throws(() => engine.views.settings({ revision: initial.settings.revision, symbols: { 'var:OPENAI|rh:OPENAI': { enabled: true } } }), /规格不同/);
    assert.throws(() => engine.views.settings({ revision: initial.settings.revision, symbols: { BTC: { enabled: true } } }), /配对键无效/);
    const enable = { enabled: true, entryBps: 15, exitBps: 2, cooldownMinutes: 0, regimes: ['all'] };
    const saved = engine.views.settings({ revision: initial.settings.revision, global: { minSamples: 10, windowHours: 2, minNetBps: 5 }, symbols: { [RH_BTC]: enable, 'lighter:BTC': enable } });
    assert.equal(saved.revision, 1);
    assert.deepEqual(Object.keys(saved.symbols).sort(), [LIGHTER_BTC, RH_BTC], '旧键写法保存时换成新键');
    // 新参数存在新键里；重开后读回。
    assert.equal(store.state<{ global: GlobalParams }>(SETTINGS_KEY)!.global.minNetBps, 5);
    assert.equal(createVarLighterEngine({ store, fetchImpl, connect: () => new FakeSocket(), now: () => clock }).views.state().settings.global.minNetBps, 5);
    assert.throws(() => engine.views.settings({ revision: 0 }), (error: unknown) => (error as { status?: number }).status === 409);
    let tick = 0;
    /** 过一分钟：两个 Lighter 场所各推一条变化（真实行情每秒都有消息），再拉一次 Var。 */
    const minute = async () => {
      clock += 60_000;
      tick++;
      rh().push({ type: 'update/market_stats', channel: 'market_stats:all', market_stats: { 1: { market_id: 1, mark_price: String(100 + tick * 0.0001) } } });
      main().push({ type: 'update/market_stats', channel: 'market_stats:all', market_stats: { 7: { market_id: 7, mark_price: String(100 + tick * 0.0001) }, 8: { market_id: 8, mark_price: String(10 + tick * 0.0001) } } });
      await engine.pollVar(signal);
    };
    for (let index = 0; index < 12; index++) await minute();
    let view = engine.views.state();
    assert.equal(row('var:OPENAI|rh:OPENAI')?.identity, 'mismatch');
    const btc = row(RH_BTC)!;
    assert.equal(btc.samples24h, 12);
    assert.equal(btc.venueName, 'Lighter RH');
    assert.deepEqual([btc.a.venue, btc.b.venue, btc.ratio, btc.custom], ['var', 'rh', 1, false]);
    assert.equal(btc.estimated, false, '启用的配对用盘口快照算成交均价');
    assert.equal(row('var:ETH|lighter:ETH')!.estimated, true, '没启用的用一档价估算');
    assert.ok(btc.baseline && Math.abs(btc.baseline.median - 20) < 0.01);
    assert.equal(row(LIGHTER_BTC)!.samples24h, 12);
    assert.equal(view.sources.var.poll?.noTop, 0);
    assert.deepEqual(view.sources.venues.map(item => [item.venue, item.depth.map(depth => depth.key), item.pairs]), [['rh', ['rh:BTC'], 2], ['lighter', ['lighter:BTC'], 2], ['entropy', [], 0]]);
    assert.ok(requested.some(url => url.startsWith('https://mainnet.zklighter.elliot.ai/api/v1/orderBookOrders?market_id=7&')));
    // 冲高：两个配对同时有信号，Var 的 BTC 腿只开一笔（RH 在前）。
    varMid = 100.5; await minute();
    assert.deepEqual(engine.views.paper().positions.map(item => [item.symbol, item.direction]), [[RH_BTC, 'a_rich']]);
    assert.equal(engine.views.state().sources.var.poll?.blocked[BUSY_BLOCK], 1, '主网配对因同一腿已持仓不开');
    assert.deepEqual(code(() => engine.views.settings({ revision: 1, combos: ['var|lighter'] })), [409, 'pair_busy']);
    varMid = 100.2; await minute();
    const paper = engine.views.paper();
    assert.equal(paper.positions.length, 0);
    assert.equal(paper.trades.length, 1);
    assert.equal(paper.trades[0].reason, 'revert');
    assert.ok(paper.trades[0].netUsd > 0);
    assert.ok(paper.events.some(event => event.kind === 'open') && paper.events.some(event => event.kind === 'close'));
    // Var 再次冲高，但拿到报价时两个场所的一档都已跟到 100.3：报价时刻有信号，复核后不开仓；样本记下了那一刻的一档。
    /** lag：推完行情后再过这么久才拉 Var（超过 5 秒就取不到判断时刻的一档）。 */
    const chase = async (mid: number, top: number, lag = 0) => {
      clock += 60_000; tick++; varMid = mid;
      const stats = (id: number) => ({ market_id: id, best_bid_price: (top - 0.01).toFixed(2), best_ask_price: (top + 0.01).toFixed(2), mark_price: String(100 + tick * 0.0001) });
      rh().push({ type: 'update/market_stats', channel: 'market_stats:all', market_stats: { 1: stats(1) } });
      main().push({ type: 'update/market_stats', channel: 'market_stats:all', market_stats: { 7: stats(7), 8: { market_id: 8, mark_price: String(10 + tick * 0.0001) } } });
      clock += lag;
      await engine.pollVar(signal);
    };
    await chase(100.5, 100.3);
    const chased = store.latest(RH_BTC)!;
    assert.deepEqual([chased.bBid0, chased.bAsk0, chased.bBidRx, chased.bAskRx], [99.99, 100.01, 100.29, 100.31]);
    assert.ok(spreadOf(chased, '1k')!.sellA - 20 >= 15, '报价时刻的样本本身达到入场偏离');
    assert.equal(engine.views.paper().positions.length, 0);
    assert.equal(engine.views.state().sources.var.poll?.blocked[DECAYED], 2, '两个配对各记一次');
    await chase(100.2, 100);
    assert.equal(engine.views.paper().positions.length, 0);
    assert.equal(engine.views.paper().trades.length, 1);
    // 行情流 6 秒没有消息：报价时刻有信号，但取不到判断时刻的一档，不开仓。
    await chase(100.5, 100, 6_000);
    assert.equal(store.latest(RH_BTC)!.bBidRx, null);
    assert.equal(engine.views.paper().positions.length, 0);
    assert.deepEqual([engine.views.state().sources.var.poll?.noLive, engine.views.state().sources.var.poll?.blocked[NO_LIVE_TOP]], [3, 2]);
    await chase(100.2, 100);
    // 拿到报价时对手只涨了 4 分：信号还在，按那一刻的卖一 100.05 买入；平仓、浮盈同样按判断时刻的买一。
    await chase(100.5, 100.04);
    const held = engine.views.paper().positions;
    assert.deepEqual(held.map(item => [item.symbol, item.bEntry]), [[RH_BTC, 100.05]]);
    assert.ok(Math.abs(row(RH_BTC)!.position!.pnlBps! - (held[0].entrySpread - (100.52 - 100.03) / 100.04 * 1e4)) < 1e-6, '浮盈按判断时刻的一档');
    await chase(100.2, 100.04);
    assert.deepEqual(engine.views.paper().trades.map(item => [item.reason, item.bEntry, item.bExit]).slice(0, 1), [['revert', 100.05, 100.03]]);
    await chase(100.2, 100);
    assert.equal(engine.views.paper().positions.length, 0);
    assert.equal(engine.views.paper().trades.length, 2);
    // 同一报价时刻不重复计入。
    const before = row(RH_BTC)!.samples24h;
    await engine.pollVar(signal);
    assert.equal(row(RH_BTC)!.samples24h, before);
    const detail = engine.views.symbol(RH_BTC, '24');
    assert.equal(detail.points.length, before);
    assert.equal(detail.venueName, 'Lighter RH');
    assert.deepEqual(detail.stats.map(item => item.regime), ['all']);
    assert.equal(detail.plans.length, 2);
    assert.equal(detail.trades.length, 2);
    assert.equal(engine.views.symbol('rh:BTC', '24').key, RH_BTC, '旧键照样能看');
    assert.throws(() => engine.views.symbol('BTC', '24'), /不是当前采集中的配对/);
    const bt = engine.views.backtest({ symbol: 'rh:BTC', hours: 1 });
    assert.equal(bt.symbol, RH_BTC);
    assert.ok(engine.views.readiness().items.some(item => item.key === 'lighter_order' && item.status === 'todo'));
    // 关掉 Var 对主网、主网对 Entropy 与 Var 对 Entropy：先要停用主网上启用的配对。
    const current = engine.views.state().settings.revision;
    assert.deepEqual(code(() => engine.views.settings({ revision: current, combos: ['var|rh'] })), [409, 'pair_busy']);
    const stopped = engine.views.settings({ revision: current, combos: ['var|rh'], symbols: { [LIGHTER_BTC]: { enabled: false } } });
    assert.deepEqual(stopped.combos, ['var|rh']);
    assert.equal(main().readyState, 3, '关闭后断开主网行情流');
    assert.equal(sockets.get('entropy')!.readyState, 3, '没有配对用到 Entropy 也断开');
    view = engine.views.state();
    assert.deepEqual(view.rows.map(item => item.key), [RH_BTC, 'var:OPENAI|rh:OPENAI']);
    assert.deepEqual(view.sources.venues.map(item => [item.venue, item.enabled, item.stream === null]), [['rh', true, false], ['lighter', false, true], ['entropy', false, true]]);
    assert.throws(() => engine.views.reset({ confirm: 'yes' }), /RESET/);
    engine.views.reset({ confirm: 'RESET' });
    assert.equal(engine.views.paper().trades.length, 0);
    view = engine.views.state();
    assert.equal(view.paper.trades, 0);
  } finally { engine.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('引擎重启：库里已启用的配对在第一次拉 Var 时就取盘口快照', async () => {
  const requested: string[] = [];
  const clock = T0;
  const fetchImpl = async (url: string) => {
    requested.push(url);
    if (url.includes('orderBookDetails')) return Response.json({ code: 200, order_book_details: [{ symbol: 'BTC', market_id: 1, market_type: 'perp', status: 'active', size_decimals: 4, price_decimals: 2, min_base_amount: '0.001', min_quote_amount: '10', taker_fee: '0', maker_fee: '0', mark_price: '100' }] });
    if (url.includes('orderBookOrders')) return Response.json({ code: 200, bids: [{ price: '99.99', remaining_base_amount: '100' }], asks: [{ price: '100.01', remaining_base_amount: '100' }] });
    return Response.json({ listings: [{ ticker: 'BTC', name: 'Bitcoin', mark_price: '100.2', quotes: { updated_at: new Date(clock - 2_000).toISOString(), base: { bid: '100.19', ask: '100.21' } } }] });
  };
  const { engine, dispose } = seededEngine(store => store.setState(SETTINGS_KEY, settings2({ [RH_BTC]: { ...DEFAULT_SYMBOL, enabled: true } }), T0), { fetchImpl });
  try {
    await engine.refreshCatalog(AbortSignal.timeout(1000), 'rh');
    await engine.pollVar(AbortSignal.timeout(1000));
    assert.equal(requested.filter(url => url.includes('orderBookOrders?market_id=1&')).length, 1);
    const depth = engine.views.state().sources.venues.find(item => item.venue === 'rh')!.depth;
    assert.deepEqual(depth.map(item => [item.key, item.at, item.error]), [['rh:BTC', T0, null]]);
  } finally { dispose(); }
});

// ---- 审查补充（docs/reviews/2026-11-22-varlighter.md）----

test('持仓取价：100k 档缺盘口快照时退回 1k 档估算，超时与止损照常判断', () => {
  const params: SymbolParams = { ...DEFAULT_SYMBOL, notionalUsd: 5_000, maxHoldMinutes: 30, stopBps: 50 };
  const held = position(RH_BTC, { openedAt: T0, qty: 50, notionalUsd: 5_000, entrySpread: 25, entryRegime: 'all', aEntry: 100.25, bEntry: 100.02 });
  const now = sample(T0 + 5 * 60_000, 100.3);
  assert.equal(spreadOf(now, '100k'), null, '100k 档缺 B 腿盘口');
  const spread = positionSpread(now, 5_000)!;
  assert.equal(spread.estimated, true);
  assert.deepEqual(spread, { ...spreadOf(now, '1k')!, estimated: true });
  assert.equal(decide(now, null, params, held).kind, 'hold');
  const late = decide(sample(T0 + 31 * 60_000, 100.3), null, params, held);
  assert.equal(late.kind === 'close' && late.reason, 'timeout', '缺 100k 档也按时超时平仓');
  const crash = decide(sample(T0 + 6 * 60_000, 100.9), null, params, held);
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

type SeedStore = ReturnType<typeof openVarLighterStore>;
function seededEngine(seed: (store: SeedStore) => void, options: { fetchImpl?: (url: string, init: RequestInit) => Promise<Response>; clock?: () => number; log?: (line: string) => void; raw?: (db: DatabaseSync) => void } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'tp-varlighter-'));
  const file = path.join(dir, 'varlighter.sqlite');
  const seeded = openVarLighterStore(file);
  seed(seeded);
  seeded.close();
  if (options.raw) { const db = new DatabaseSync(file); try { options.raw(db); } finally { db.close(); } }
  const market = { symbol: 'BTC', market_id: 1, market_type: 'perp', status: 'active', size_decimals: 4, price_decimals: 2, min_base_amount: '0.001', min_quote_amount: '10', taker_fee: '0', maker_fee: '0', mark_price: '100' };
  const now = options.clock ?? (() => T0);
  const fetchImpl = options.fetchImpl ?? (async (url: string) => {
    if (url.includes('orderBookDetails')) return Response.json({ code: 200, order_book_details: [market] });
    if (url.includes('orderBookOrders')) return Response.json({ code: 200, bids: [{ price: '99.99', remaining_base_amount: '100' }], asks: [{ price: '100.01', remaining_base_amount: '100' }] });
    return Response.json({ listings: [{ ticker: 'BTC', name: 'Bitcoin', mark_price: '100.2', quotes: { updated_at: new Date(now() - 2_000).toISOString(), base: { bid: '100.19', ask: '100.21' } } }] });
  });
  const sockets: FakeSocket[] = [];
  const engine = createVarLighterEngine({ store: openVarLighterStore(file), fetchImpl, connect: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; }, now, log: options.log });
  return { dir, file, engine, sockets, dispose(keep = false) { engine.close(); if (!keep) rmSync(dir, { recursive: true, force: true }); } };
}

const RH_SNAPSHOT = { type: 'subscribed/market_stats', channel: 'market_stats:all', market_stats: { 1: { market_id: 1, best_bid_price: '99.99', best_ask_price: '100.01', mark_price: '100' } } };

test('失联配对：总览列出，可停用，持仓按最后样本平仓并记明；手动平仓的错误码；冷却重启后仍在', async () => {
  const GONE = 'var:GONE|rh:GONE';
  const { dir, file, engine, sockets, dispose } = seededEngine(store => {
    store.setState(SETTINGS_KEY, settings2({ [RH_BTC]: { ...DEFAULT_SYMBOL, enabled: true }, [GONE]: { ...DEFAULT_SYMBOL, enabled: true, cooldownMinutes: 120 } }), T0);
    store.addSamples([sample(T0 - 30 * 60_000, 100.1, 100, { symbol: GONE }), sample(T0 - 20 * 60_000, 100.1, 100, { symbol: RH_BTC })]);
    store.savePosition(position(GONE));
    store.savePosition(position(RH_BTC));
  });
  try {
    assert.deepEqual(engine.views.state().orphans, [], '目录与 Var 报价还没取到时不判断');
    assert.throws(() => engine.views.close({ symbol: GONE }), (error: unknown) => (error as { status?: number }).status === 409, '启动期不按旧样本结算');
    engine.startStreams();
    sockets[0].open();
    sockets[0].push(RH_SNAPSHOT);
    await engine.refreshCatalog(AbortSignal.timeout(1000), 'rh');
    await engine.pollVar(AbortSignal.timeout(1000));
    const [orphan] = engine.views.state().orphans;
    assert.deepEqual({ ...orphan, position: { ...orphan.position!, pnlBps: null } }, {
      key: GONE, a: { venue: 'var', symbol: 'GONE', name: 'Var' }, b: { venue: 'rh', symbol: 'GONE', name: 'Lighter RH' }, venue: 'rh', venueName: 'Lighter RH', symbol: 'GONE',
      reason: '配对已不在目录里（或组合已关闭、手动配对已删除）', enabled: true, lastSampleAt: T0 - 30 * 60_000,
      position: { direction: 'a_rich', openedAt: T0 - 3_600_000, pnlBps: null } });
    assert.equal(typeof orphan.position!.pnlBps, 'number');
    assert.equal(engine.views.state().rows.find(row => row.key === RH_BTC)?.samples24h, 1, '近 24 小时计数含启动前的样本');

    assert.deepEqual(code(() => engine.views.close({ symbol: 'rh:ETH' })), [404, 'not_found']);
    assert.deepEqual(code(() => engine.views.close({ symbol: 'BTC' })), [400, 'invalid_symbol']);
    assert.deepEqual(code(() => engine.views.close({ symbol: RH_BTC, extra: 1 })), [400, 'invalid_body']);
    assert.deepEqual(code(() => engine.views.close({ symbol: 'rh:BTC' })), [409, 'no_quote'], '还在目录里的配对要 10 分钟内的报价（旧键照样认）');
    const trade = engine.views.close({ symbol: GONE });
    assert.equal(trade.closedAt, T0 - 30 * 60_000, '失联配对按最后样本结算');
    assert.match(engine.views.paper().events[0].message, /配对已不在目录里.*按最后样本/);
    const disabled = engine.views.settings({ revision: 3, symbols: { [GONE]: { ...DEFAULT_SYMBOL, enabled: false } } });
    assert.equal(disabled.symbols[GONE].enabled, false);
    assert.deepEqual(engine.views.state().orphans, [], '停用并平仓后不再列出');

    let revision = disabled.revision;
    for (let batch = 0; batch < 2; batch++) revision = engine.views.settings({ revision, symbols: Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`rh:K${batch}X${index}`, { ...DEFAULT_SYMBOL }])) }).revision;
    assert.deepEqual(code(() => engine.views.settings({ revision, symbols: Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`rh:K9X${index}`, { ...DEFAULT_SYMBOL }])) })), [400, 'too_many'], '保存的配对键有上限');
    assert.deepEqual(code(() => engine.views.settings({ revision, symbols: { 'not a key': { ...DEFAULT_SYMBOL } } })), [400, 'invalid_symbol']);
  } finally { dispose(true); }
  const reopened = openVarLighterStore(file);
  try { assert.equal(reopened.state<Record<string, number>>(COOLDOWN_KEY)?.[GONE], T0 - 30 * 60_000 + 120 * 60_000, '冷却写进库，重启后仍在'); } finally { reopened.close(); rmSync(dir, { recursive: true, force: true }); }
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
  const dir = mkdtempSync(path.join(tmpdir(), 'tp-varlighter-')), file = path.join(dir, 'varlighter.sqlite');
  const engines: ReturnType<typeof createVarLighterEngine>[] = [];
  /** 启动一个引擎并连上行情流；advance 拨时钟并推一条消息（行情流按消息间隔判沉默）。 */
  const start = () => {
    const sockets: FakeSocket[] = [];
    const engine = createVarLighterEngine({ store: openVarLighterStore(file), fetchImpl, connect: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; }, now: () => time });
    engines.push(engine);
    engine.startStreams();
    sockets[0].open();
    sockets[0].push(RH_SNAPSHOT);
    let tick = 0;
    const advance = (ms: number) => { time += ms; tick++; sockets[0].push({ type: 'update/market_stats', channel: 'market_stats:all', market_stats: { 1: { market_id: 1, mark_price: String(100 + tick * 0.0001) } } }); };
    /** 按服务节奏每分钟拉一次 Var。 */
    const run = async (minutes: number) => { for (let index = 0; index < minutes; index++) { advance(60_000); await engine.pollVar(AbortSignal.timeout(1000)); } };
    return { engine, socket: sockets[0], advance, run };
  };
  const poll = (engine: ReturnType<typeof createVarLighterEngine>) => engine.pollVar(AbortSignal.timeout(1000));
  const status = (work: () => unknown) => { try { work(); } catch (error) { return (error as { status: number }).status; } return 200; };
  const reasons = (engine: ReturnType<typeof createVarLighterEngine>) => engine.views.state().orphans.map(row => row.reason);
  const NO_SAMPLE = '超过 30 分钟没有新样本（某腿无报价或盘口缺失）';
  try {
    const seed = openVarLighterStore(file);
    seed.setState(SETTINGS_KEY, settings2({ [RH_BTC]: { ...DEFAULT_SYMBOL, enabled: true, entryBps: 1, exitBps: 0, cooldownMinutes: COOLDOWN_MIN } }, { ...DEFAULT_GLOBAL, minSamples: 10, varFeeBps: 0, rhFeeBps: 0 }), T0);
    seed.addSamples(Array.from({ length: 12 }, (_, index) => sample(T0 - (75 - index * 5) * 60_000, 100.1)));
    seed.savePosition(position(RH_BTC));
    seed.close();

    // 刚启动：库里最后样本 20 分钟前；Var 已拉到但场所目录未取到，也不算。
    const first = start();
    await poll(first.engine);
    assert.deepEqual(reasons(first.engine), [], '场所目录未取到不判断');
    assert.equal(status(() => first.engine.views.close({ symbol: RH_BTC })), 409, '启动期不按旧样本结算');
    await first.engine.refreshCatalog(AbortSignal.timeout(1000), 'rh');
    await first.run(11);
    assert.deepEqual(reasons(first.engine), [], '最后样本 31 分钟前，但数据源正常才 11 分钟');
    await first.run(20);
    assert.deepEqual(reasons(first.engine), [NO_SAMPLE], '数据源连续正常 31 分钟仍无样本：Var 有目录没报价');
    varFails = true; first.advance(4 * 60_000); await poll(first.engine);
    assert.deepEqual(reasons(first.engine), [], 'Var 拉取失败超过 3 分钟，整体故障不算单个配对失联');
    assert.equal(status(() => first.engine.views.close({ symbol: RH_BTC })), 409, '数据源故障时不按旧样本结算');
    varFails = false; await poll(first.engine);
    assert.deepEqual(reasons(first.engine), [], 'Var 刚恢复，从恢复时刻重新计时');
    await first.run(31);
    assert.deepEqual(reasons(first.engine), [NO_SAMPLE], '恢复后 31 分钟仍无样本');
    first.socket.onclose?.({});
    assert.deepEqual(reasons(first.engine), [], '行情流断开不算');
    assert.equal(status(() => first.engine.views.close({ symbol: RH_BTC })), 409);
    first.engine.close();

    // 停机很久后重启：第一轮 Var 报价早于行情流快照，没写入新样本，旧样本不算失联。
    time += 3_600_000; full = true;
    const restarted = start();
    await restarted.engine.refreshCatalog(AbortSignal.timeout(1000), 'rh');
    await poll(restarted.engine);
    assert.deepEqual([restarted.engine.views.state().sources.var.poll?.written, restarted.engine.views.state().sources.var.poll?.noTop], [0, 1], '第一轮没有新样本：报价时刻行情流还没有快照');
    assert.deepEqual(reasons(restarted.engine), [], '重启后第一轮');
    assert.equal(status(() => restarted.engine.views.close({ symbol: RH_BTC })), 409);
    restarted.engine.close();

    // 规格改判：按最后样本平仓并注明原因。
    varMark = '120';
    const mismatch = start();
    await mismatch.engine.refreshCatalog(AbortSignal.timeout(1000), 'rh');
    await poll(mismatch.engine);
    assert.deepEqual(reasons(mismatch.engine), ['两边价格相差超过 5%，已改判为规格不同']);
    const trade = mismatch.engine.views.close({ symbol: RH_BTC });
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

test('失联计时：行情流短暂断线再续上不重新计，断开超过 3 分钟才从续上的时刻算起；连上但没收到快照不判断', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let time = T0;
  const fetchImpl = async (url: string) => {
    if (url.includes('orderBookDetails')) return Response.json({ code: 200, order_book_details: [{ symbol: 'BTC', market_id: 1, market_type: 'perp', status: 'active', size_decimals: 4, price_decimals: 2, min_base_amount: '0.001', min_quote_amount: '10', taker_fee: '0', maker_fee: '0', mark_price: '100' }] });
    if (url.includes('orderBookOrders')) return Response.json({ code: 200, bids: [{ price: '99.99', remaining_base_amount: '1000' }], asks: [{ price: '100.01', remaining_base_amount: '1000' }] });
    // Var 有目录、没有完整报价：一直不产生新样本。
    return Response.json({ listings: [{ ticker: 'BTC', name: 'Bitcoin', mark_price: '100.2', quotes: { updated_at: new Date(time - 2_000).toISOString(), base: { bid: '100.29', ask: '100.31' } } }] });
  };
  const { engine, sockets, dispose } = seededEngine(store => {
    store.setState(SETTINGS_KEY, settings2({ [RH_BTC]: { ...DEFAULT_SYMBOL, enabled: true } }), T0);
    store.addSamples([sample(T0 - 40 * 60_000, 100.1)]);
  }, { fetchImpl, clock: () => time });
  /** 每分钟拉一次 Var；行情流连着时每分钟推一条消息。 */
  const run = async (minutes: number) => { for (let index = 0; index < minutes; index++) { time += 60_000; sockets.at(-1)!.push({ type: 'update/market_stats', channel: 'market_stats:all', market_stats: { 1: { market_id: 1, mark_price: String(100 + time % 1000 / 1e6) } } }); await engine.pollVar(AbortSignal.timeout(1000)); } };
  const lost = () => engine.views.state().orphans.length;
  try {
    engine.startStreams();
    sockets[0].open();
    sockets[0].push(RH_SNAPSHOT);
    await engine.refreshCatalog(AbortSignal.timeout(1000), 'rh');
    await engine.pollVar(AbortSignal.timeout(1000));
    await run(30);
    assert.equal(lost(), 0, '数据源正常刚满 30 分钟');
    await run(1);
    assert.equal(lost(), 1, '数据源连续正常 31 分钟没有样本');

    sockets[0].onclose?.({});
    assert.equal(lost(), 0, '断开时不判断');
    time += 5_000; t.mock.timers.tick(1_000);
    assert.equal(sockets.length, 2, '1 秒后重连');
    sockets[1].open();
    assert.equal(lost(), 0, '连上但还没收到快照，仍不判断');
    sockets[1].push(RH_SNAPSHOT);
    assert.equal(lost(), 1, '断开 5 秒再续上，不重新计时');

    sockets[1].onclose?.({});
    await run(4);
    t.mock.timers.tick(1_000);
    sockets[2].open();
    sockets[2].push(RH_SNAPSHOT);
    assert.equal(lost(), 0, '断开 4 分钟后续上，从续上的时刻重新计时');
    await run(30);
    assert.equal(lost(), 0, '续上后刚满 30 分钟');
    await run(1);
    assert.equal(lost(), 1, '续上后 31 分钟仍无样本');
  } finally {
    try { dispose(); } catch { /* 已关闭 */ }
  }
});

test('两腿行情流的配对：启用或有持仓的每 15 秒、其余每分钟按本机时刻采一条，两腿都要有一档；状态里有最近一轮', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const LE_SNDK = 'lighter:SNDK|entropy:SNDK';
  let clock = T0;
  const bodies: unknown[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    if (url.includes('orderBookDetails')) return Response.json({ code: 200, order_book_details: [{ symbol: 'SNDK', market_id: 9, market_type: 'perp', status: 'active', size_decimals: 2, price_decimals: 2, min_base_amount: '0.01', min_quote_amount: '10', taker_fee: '0', maker_fee: '0', mark_price: '100' }] });
    if (url.includes('hyperliquid')) {
      bodies.push(JSON.parse(String(init.body)));
      return Response.json([{ universe: [{ name: 'io:SNDK', szDecimals: 2, deployerFeeScale: '0.5', growthMode: 'disabled' }], collateralToken: 0 }, [{ markPx: '100.1', oraclePx: '100.15', funding: '0.0000125' }]]);
    }
    return Response.json({ listings: [] });
  };
  const sockets = new Map<string, FakeSocket>();
  const dir = mkdtempSync(path.join(tmpdir(), 'tp-varlighter-'));
  const file = path.join(dir, 'varlighter.sqlite');
  const seed = openVarLighterStore(file);
  seed.setState(SETTINGS_KEY, settings2({}, DEFAULT_GLOBAL, ['lighter|entropy']), T0);
  seed.savePosition(position(LE_SNDK, { aEntry: 100, bEntry: 100.1, bFeeBps: 6.75 }));
  seed.close();
  const store = openVarLighterStore(file);
  const engine = createVarLighterEngine({ store, fetchImpl, connect: url => { const socket = new FakeSocket(); sockets.set(venueOf(url), socket); return socket; }, now: () => clock });
  try {
    engine.startStreams();
    assert.deepEqual([...sockets.keys()].sort(), ['entropy', 'lighter'], '只连组合用到的场所');
    await engine.refreshCatalog(AbortSignal.timeout(1000), 'lighter');
    await engine.refreshCatalog(AbortSignal.timeout(1000), 'entropy');
    assert.deepEqual(bodies, [{ type: 'metaAndAssetCtxs', dex: 'io' }]);
    const main = sockets.get('lighter')!, entropy = sockets.get('entropy')!;
    main.open(); entropy.open();
    main.push({ type: 'subscribed/market_stats', channel: 'market_stats:all', market_stats: { 9: { market_id: 9, best_bid_price: '99.99', best_ask_price: '100.01', mark_price: '100' } } });
    assert.deepEqual(entropy.sent, [{ method: 'subscribe', subscription: { type: 'bbo', coin: 'io:SNDK' } }], '按配对用到的 Entropy 市场订阅');
    assert.deepEqual(engine.sampleLive(), { at: T0, due: 1, written: 0, noTop: 1, blocked: {} }, 'Entropy 还没有一档');
    const bbo = () => entropy.push({ channel: 'bbo', data: { coin: 'io:SNDK', bbo: [{ px: '100.09', sz: '1', n: 1 }, { px: '100.11', sz: '1', n: 1 }] } });
    bbo();
    assert.equal(engine.sampleLive().written, 1, '缺一档的那轮不算，下一次检查马上补采');
    const latest = store.latest(LE_SNDK)!;
    assert.deepEqual([latest.t, latest.receivedAt, latest.aBidRx, latest.bBidRx, latest.bMark, latest.bFunding, latest.ratio], [T0, T0, 99.99, 100.09, 100.1, 0.0000125, 1]);
    /** 拨到 at：两边各推一条消息再检查。 */
    const check = (at: number) => {
      clock = at;
      main.push({ type: 'update/market_stats', channel: 'market_stats:all', market_stats: { 9: { market_id: 9, mark_price: String(100 + (at - T0) / 1e9) } } });
      bbo();
      return engine.sampleLive();
    };
    assert.equal(check(T0 + 13_999).due, 0, '有持仓：15 秒一条（留 1 秒余量）');
    assert.deepEqual([check(T0 + 14_000).due, engine.sampleLive().due], [1, 0]);
    let last = T0 + 14_000;
    engine.views.reset({ confirm: 'RESET' });
    assert.equal(check(last + 58_000).due, 0, '没有持仓也没启用：每分钟一条');
    assert.equal(check(last + 59_000).written, 1);
    last += 59_000;
    engine.views.settings({ revision: 3, symbols: { [LE_SNDK]: { enabled: true } } });
    assert.equal(check(last + 13_999).due, 0);
    const stats = check(last + 14_000);
    assert.deepEqual(stats, { at: last + 14_000, due: 1, written: 1, noTop: 0, blocked: {} });
    const view = engine.views.state();
    assert.deepEqual(view.sources.live, stats);
    assert.deepEqual(view.sources.venues.map(item => [item.venue, item.enabled, item.pairs]), [['rh', false, 0], ['lighter', true, 1], ['entropy', true, 1]]);
    assert.equal(view.sources.var.enabled, false, '没有配对用到 Var');
    assert.equal(view.rows[0].bFeeBps, 6.75, 'Entropy 手续费按目录');
  } finally { engine.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('手动配对：添加、重复与自动配对重复、数量上限；启用要求在配对里、规格待确认的先确认、规格不同的不能启用；启用中的不能删；已启用的规格降级不挡无关保存', async () => {
  let oaiMark = '730';
  const fetchImpl = async (url: string, init: RequestInit) => {
    if (url.includes('orderBookDetails')) return Response.json({ code: 200, order_book_details: [{ symbol: 'BTC', market_id: 1, market_type: 'perp', status: 'active', size_decimals: 4, price_decimals: 2, min_base_amount: '0.001', min_quote_amount: '10', taker_fee: '0', maker_fee: '0', mark_price: '100' }] });
    if (url.includes('hyperliquid')) {
      assert.deepEqual(JSON.parse(String(init.body)), { type: 'metaAndAssetCtxs', dex: 'io' });
      return Response.json([{ universe: [{ name: 'io:OAI', szDecimals: 1, deployerFeeScale: '1', growthMode: 'enabled' }, { name: 'io:SNDK', szDecimals: 2, deployerFeeScale: '0.5', growthMode: 'disabled' }], collateralToken: 0 }, [{ markPx: oaiMark }, { markPx: '100.4' }]]);
    }
    return Response.json({ listings: [{ ticker: 'OPENAI', name: 'OpenAI', mark_price: '100' }, { ticker: 'BTC', name: 'Bitcoin', mark_price: '100.2' }, { ticker: 'SNDK', name: 'Sandisk', mark_price: '100.3' }] });
  };
  const { engine, dispose } = seededEngine(() => {}, { fetchImpl });
  const P = { a: { venue: 'var', symbol: 'OPENAI' }, b: { venue: 'entropy', symbol: 'OAI' }, ratio: 0.137, kind: 'private' };
  const M = { a: { venue: 'var', symbol: 'OPENAI' }, b: { venue: 'entropy', symbol: 'OAI' } };
  const P_KEY = 'var:OPENAI|entropy:OAI@0.137', M_KEY = 'var:OPENAI|entropy:OAI';
  const row = (key: string) => engine.views.state().rows.find(item => item.key === key);
  try {
    await engine.refreshCatalog(AbortSignal.timeout(1000), 'rh');
    await engine.refreshCatalog(AbortSignal.timeout(1000), 'entropy');
    await engine.pollVar(AbortSignal.timeout(1000));
    assert.equal(engine.views.state().settings.revision, 0);
    const added = engine.views.settings({ revision: 0, pairs: [P] });
    assert.equal(added.revision, 1);
    assert.deepEqual(added.pairs, [{ ...P, note: '' }]);
    const custom = row(P_KEY)!;
    assert.deepEqual([custom.custom, custom.identity, custom.symbol, custom.ratio, custom.eligible], [true, 'review', 'OPENAI / OAI ×0.137', 0.137, false]);
    assert.equal(row('var:SNDK|entropy:SNDK')?.identity, 'verified', '默认组合里的 Var 对 Entropy 自动配对');
    assert.deepEqual(code(() => engine.views.settings({ revision: 1, pairs: [P, { ...P, ratio: 0.1370000000001 }] })), [400, 'duplicate_pair'], '乘数规整后相同算重复');
    assert.deepEqual(code(() => engine.views.settings({ revision: 1, pairs: [P, { a: { venue: 'var', symbol: 'SNDK' }, b: { venue: 'entropy', symbol: 'SNDK' } }] })), [400, 'duplicate_pair'], '开着的组合已自动配对的不必手动加');
    assert.deepEqual(code(() => engine.views.settings({ revision: 1, pairs: Array.from({ length: 101 }, () => P) })), [400, 'too_many']);
    assert.deepEqual(code(() => engine.views.settings({ revision: 1, pairs: [{ ...P, ratio: 0 }] })), [400, 'invalid_params']);
    assert.deepEqual(code(() => engine.views.settings({ revision: 1, symbols: { 'var:SNDK|rh:SNDK': { enabled: true } } })), [400, 'unknown_symbol'], 'RH 目录里没有 SNDK');
    assert.deepEqual(code(() => engine.views.settings({ revision: 1, symbols: { [P_KEY]: { enabled: true } } })), [400, 'unconfirmed']);
    assert.equal(engine.views.settings({ revision: 1, confirmed: [P_KEY], symbols: { [P_KEY]: { enabled: true } } }).revision, 2);
    assert.equal(row(P_KEY)!.eligible, true);
    // 乘数 1 的同一对两边标记价差七倍多：规格不同，不能启用。
    assert.equal(engine.views.settings({ revision: 2, pairs: [P, M] }).revision, 3);
    assert.equal(row(M_KEY)!.identity, 'mismatch');
    assert.deepEqual(code(() => engine.views.settings({ revision: 3, symbols: { [M_KEY]: { enabled: true } } })), [400, 'mismatch']);
    assert.deepEqual(code(() => engine.views.settings({ revision: 3, pairs: [M] })), [409, 'pair_busy'], '启用中的手动配对不能删');
    // 已启用的配对撤销确认：保存照常，开仓由 eligible 挡住。
    assert.equal(engine.views.settings({ revision: 3, confirmed: [] }).revision, 4);
    assert.deepEqual([row(P_KEY)!.identity, row(P_KEY)!.eligible], ['review', false]);
    // 目录价格变了，已启用的手动配对改判规格不同：无关的保存不被它卡住。
    oaiMark = '1000';
    await engine.refreshCatalog(AbortSignal.timeout(1000), 'entropy');
    assert.equal(row(P_KEY)!.identity, 'mismatch');
    const saved = engine.views.settings({ revision: 4, global: { minNetBps: 4 } });
    assert.deepEqual([saved.revision, saved.global.minNetBps, saved.symbols[P_KEY].enabled], [5, 4, true]);
    assert.deepEqual([row(P_KEY)!.identity, row(P_KEY)!.eligible], ['mismatch', false]);
  } finally { dispose(); }
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
    assert.ok(engine.stream('entropy'), '默认组合也连 Entropy');
    assert.equal(aborted, false, '目录请求挂着');
    const started = Date.now();
    stopped = true;
    for (const wake of [...sleepers]) wake();
    await loop;
    assert.ok(Date.now() - started < 2_000, `停服不等 20 秒超时（${Date.now() - started} ms）`);
    assert.equal(aborted, true);
    assert.equal(engine.stream('rh'), null);
    assert.equal(engine.stream('entropy'), null);
  } finally { dispose(); }

  const dir = mkdtempSync(path.join(tmpdir(), 'tp-varlighter-'));
  try {
    const holder = openVarLighter(dir, { fetchImpl: hang, connect: () => new FakeSocket() }, () => {});
    const opened = holder.engine!;
    await varLighterLoop(holder, { stopped: () => true, pause: async () => {} });
    assert.equal(holder.engine, null);
    assert.throws(() => opened.views.state(), /not open|closed|finalized/i, '库已关闭');
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
  const KEY = encodeURIComponent(RH_BTC);
  try {
    const cookie = ((await fetch(`${base}/login?token=vl-token-000001`, { redirect: 'manual' })).headers.get('set-cookie') ?? '').split(';')[0]!;
    const get = (route: string, headers: Record<string, string> = { cookie }) => fetch(base + route, { headers });
    const post = (route: string, body: unknown, headers: Record<string, string> = { cookie, 'content-type': 'application/json', 'x-pa-executor': '1' }) => fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal((await get('/api/varlighter/state')).status, 404, '模块关闭');
    views.varlighter = varLighterViews(holder);
    assert.equal((await get('/api/varlighter/state', {})).status, 401);
    assert.equal((await get('/api/varlighter/state')).status, 200);
    assert.equal((await post('/api/varlighter/paper/reset', { confirm: 'RESET' }, { cookie, 'content-type': 'application/json' })).status, 403, '缺页面请求标记');
    const unknown = await post('/api/varlighter/paper/close', { symbol: RH_BTC });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json() as { code: string }).code, 'not_found');
    const generated = await post('/api/read-token/generate', { name: 'test', scopes: ['public', 'system', 'portfolio'] });
    assert.equal(generated.status, 200);
    const token = (await generated.json() as { token: string }).token;
    const bearer = { authorization: `Bearer ${token}` };
    // docs/mcp.md 8.3: the token reads the module and its samples, never a POST (the backtest included).
    for (const route of ['/api/varlighter/state', '/api/varlighter/paper', '/api/varlighter/readiness', `/api/varlighter/samples?symbol=${KEY}`, '/api/varlighter/samples?symbol=rh:BTC']) assert.equal((await get(route, bearer)).status, 200, route);
    for (const route of ['/api/varlighter/paper/reset', '/api/varlighter/backtest', '/api/varlighter/settings', '/api/varlighter/paper/close']) {
      assert.equal((await post(route, { confirm: 'RESET' }, { ...bearer, 'content-type': 'application/json', 'x-pa-executor': '1' })).status, 403, `只读令牌不能 POST ${route}`);
    }
    assert.equal((await get(`/api/varlighter/samples?symbol=${KEY}&extra=1`, bearer)).status, 403, '多余参数');
    // The sample export: pages after a cursor, oldest first, columns in SAMPLE_FIELDS order.
    const writer = openVarLighterStore(path.join(dir, 'varlighter.sqlite'));
    const rows = Array.from({ length: 5 }, (_, index) => sample(T0 + index * 60_000, 100.2));
    writer.addSamples([...rows, sample(T0, 50, 100, { symbol: LIGHTER_BTC })]);
    const page = async (query: string) => { const response = await get(`/api/varlighter/samples?${query}`, bearer); assert.equal(response.status, 200, query); return await response.json() as SamplesView; };
    const first = await page(`symbol=${KEY}&limit=2`);
    assert.deepEqual(first.columns, SAMPLE_FIELDS);
    assert.deepEqual(first.rows.map(row => Object.fromEntries(first.columns.map((column, index) => [column, row[index]]))), rows.slice(0, 2));
    assert.deepEqual([first.next, first.firstAt, first.retentionDays], [T0 + 60_000, T0, 14]);
    const second = await page(`symbol=${KEY}&limit=2&after=${first.next}`);
    assert.deepEqual([second.rows.map(row => row[1]), second.next], [[T0 + 120_000, T0 + 180_000], T0 + 180_000]);
    const last = await page(`symbol=rh:BTC&limit=2&after=${second.next}`);
    assert.deepEqual([last.symbol, last.rows.map(row => row[1]), last.next], [RH_BTC, [T0 + 240_000], null], '不足一页时 next 为空；旧键换成新键');
    assert.deepEqual([(await page('symbol=rh:NONE')).rows, (await page('symbol=rh:NONE')).firstAt], [[], null], '没有样本的配对返回空页');
    for (const query of ['symbol=BTC', `symbol=${KEY}&limit=0`, `symbol=${KEY}&limit=1001`, `symbol=${KEY}&after=-1`, `symbol=${KEY}&after=1.5`]) {
      assert.equal((await get(`/api/varlighter/samples?${query}`)).status, 400, query);
    }
    // A full page of long-decimal prices stays well inside the token's 512 KiB answer limit.
    writer.addSamples(Array.from({ length: 1000 }, (_, index) => sample(T0 + index * 60_000, 104523.123456789, 104520.987654321, { symbol: 'var:ETH|lighter:ETH',
      aBid100k: 104523.0712345, aAsk100k: 104523.1912345, bBid100k: 104520.9112345, bAsk100k: 104521.0612345, aBidTk: 104523.1012345, aAskTk: 104523.1512345, aTkAt: T0 + index * 60_000 - 1234 })));
    const full = await get(`/api/varlighter/samples?symbol=${encodeURIComponent('var:ETH|lighter:ETH')}`, bearer);
    assert.equal(full.status, 200);
    const fullBytes = (await full.arrayBuffer()).byteLength;
    assert.ok(fullBytes < 400 * 1024, `1000 行 ${fullBytes} 字节`);
    writer.close();
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
  const RH_A = 'var:A|rh:A', LIGHTER_A = 'var:A|lighter:A';
  try {
    const old = T0 - 15 * 86_400_000;
    store.addSamples([0, 1, 2].flatMap(minute => [RH_A, LIGHTER_A].map(symbol => sample(old + minute * 60_000, 100, 100, { symbol }))));
    store.addSamples([sample(T0 - 60_000, 100, 100, { symbol: RH_A })]);
    assert.equal(store.pruneSamples(T0, 4), 4, '一批最多 4 条');
    assert.equal(store.pruneSamples(T0, 4), 2);
    assert.equal(store.pruneSamples(T0, 4), 0);
    assert.equal(store.countSince(RH_A, T0 - 86_400_000), 1);
    assert.equal(store.countSince(LIGHTER_A, 0), 0);
    assert.equal(store.firstSampleAt(), T0 - 60_000);
    assert.equal(store.firstAt(RH_A), T0 - 60_000);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

// —— Var token 询价（v0.82.0，docs/varlighter.md 第 3 节）——

test('Var 询价：各类别的合约写法、名义金额折数量、应答核对标的、数量、价格与时刻', () => {
  assert.deepEqual(varInstrument('crypto', 'BTC'), { underlying: 'BTC', instrument_type: 'perpetual_future', settlement_asset: 'USDC', funding_interval_s: 3600 });
  assert.deepEqual(varInstrument('equity', 'AAPL'), { underlying: 'AAPL', instrument_type: 'perpetual_rwa_future', settlement_asset: 'USDC', kind: 'equity' });
  assert.deepEqual(varInstrument('commodity', 'CL'), { underlying: 'CL', instrument_type: 'perpetual_rwa_future', settlement_asset: 'USDC', kind: 'commodity' });
  assert.equal(varInstrument('other', 'XYZ'), null, '没确认过写法的类别不询价');
  assert.equal(varInstrument('crypto', 'btc/usd'), null);
  assert.deepEqual([quoteQty(1000, 100.2), quoteQty(1000, 65_000), quoteQty(1000, 0.00012345), quoteQty(500, 250)], ['9.98', '0.01538', '8100000', '2']);
  assert.deepEqual([quoteQty(1000, 0), quoteQty(1000, NaN), quoteQty(10, 1e12), quoteQty(-5, 10), quoteQty(1e15, 1), quoteQty(999_999_999_999, 1)], [null, null, null, null, null, null]);
  assert.equal(quoteQty(999_900_000_000, 1), '999900000000');

  const instrument = varInstrument('crypto', 'BTC')!;
  const answer = (extra: Record<string, unknown> = {}) => ({ instrument, qty: '9.98', bid: '100.19', ask: '100.21', mark_price: '100.2', timestamp: new Date(T0 - 400).toISOString(), ...extra });
  assert.deepEqual(parseTokenQuote(answer(), instrument, '9.98', T0), { bid: 100.19, ask: 100.21, mark: 100.2, qty: 9.98, at: T0 - 400, receivedAt: T0 });
  assert.equal(parseTokenQuote(answer({ qty: 9.98 }), instrument, '9.98', T0).qty, 9.98, '数量按数值比较');
  for (const wrong of [{ qty: '1' }, { instrument: { ...instrument, underlying: 'ETH' } }, { instrument: { ...instrument, instrument_type: 'perpetual_rwa_future' } }, { instrument: null }]) {
    assert.throws(() => parseTokenQuote(answer(wrong), instrument, '9.98', T0), /标的或数量与请求不符/);
  }
  for (const wrong of [{ ask: '100.18' }, { bid: '0' }, { bid: null }, { mark_price: 'x' }, { ask: [] }, { bid: '0x64' }, { ask: '1e3' }, { mark_price: ' 100.2' }]) assert.throws(() => parseTokenQuote(answer(wrong), instrument, '9.98', T0), /价格无效/);
  for (const stamp of [new Date(T0 - TOKEN_QUOTE_MAX_AGE_MS - 1).toISOString(), new Date(T0 + 2_001).toISOString(), '2026-11-23T15:00:00', 'x', 1]) {
    assert.throws(() => parseTokenQuote(answer({ timestamp: stamp }), instrument, '9.98', T0), /时间无效或已过期/);
  }
  assert.throws(() => parseTokenQuote(null, instrument, '9.98', T0), /标的或数量与请求不符/);
});

test('Var 询价器：没有 token 不发请求；被拒的 token 不再用、换新后恢复；被拦截只标暂不可用；应答不对不算 token 的问题；请求途中换 token 不误判', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tp-varlighter-token-'));
  const file = path.join(dir, VARIATIONAL_SESSION_FILE);
  const save = (token: string, revision: number) => writeFileSync(file, JSON.stringify({ version: 1, revision, token, updatedAt: new Date(T0).toISOString() }), { mode: 0o600 });
  let clock = T0;
  const sent: { url: string; cookie: string; body: unknown }[] = [];
  let reply: () => Response | Promise<Response> = () => new Response('{}');
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), cookie: String((init?.headers as Record<string, string>).Cookie), body: JSON.parse(String(init?.body)) });
    return reply();
  };
  const good = (extra: Record<string, unknown> = {}) => Response.json({ instrument: varInstrument('crypto', 'BTC'), qty: '9.98', bid: '100.19', ask: '100.21', mark_price: '100.2', timestamp: new Date(clock - 400).toISOString(), ...extra });
  const quoter = createVarQuoter({ dir, fetcher: fetcher as typeof fetch, now: () => clock });
  const ask = () => quoter.quote('crypto', 'BTC', 1000, 100.2, AbortSignal.timeout(1000));
  try {
    assert.deepEqual([quoter.usable(), quoter.view().status, quoter.view().statusName], [false, 'missing', '未配置']);
    await assert.rejects(ask(), /没有可用的 Var token/);
    assert.equal(sent.length, 0);

    const first = fakeVariationalToken(T0 + 86_400_000, 'a'), second = fakeVariationalToken(T0 + 2 * 86_400_000, 'b');
    save(first, 1);
    assert.deepEqual([quoter.usable(), quoter.view().status, quoter.view().expiresAt], [true, 'ready', Math.floor((T0 + 86_400_000) / 1000) * 1000]);
    reply = () => good();
    assert.deepEqual(await ask(), { bid: 100.19, ask: 100.21, mark: 100.2, qty: 9.98, at: T0 - 400, receivedAt: T0 });
    assert.deepEqual(sent[0], { url: 'https://omni.variational.io/api/quotes/indicative', cookie: `vr-token=${first}`, body: { instrument: varInstrument('crypto', 'BTC'), qty: '9.98' } });
    assert.deepEqual([quoter.view().okAt, quoter.view().lagMs, quoter.view().error], [T0, 400, null]);
    assert.ok(!JSON.stringify(quoter.view()).includes(first), '状态里不带 token');
    await assert.rejects(quoter.quote('other', 'XYZ', 1000, 10, AbortSignal.timeout(1000)), /格式未确认/);
    await assert.rejects(quoter.quote('crypto', 'BTC', 1000, 0, AbortSignal.timeout(1000)), /算不出询价数量/);
    assert.equal(sent.length, 1);

    // 应答读到了但内容不对：记下原因，token 仍可用。
    reply = () => good({ qty: '1' });
    await assert.rejects(ask(), /标的或数量与请求不符/);
    assert.deepEqual([quoter.usable(), quoter.view().status, quoter.view().error], [true, 'ready', 'BTC：Var 询价应答的标的或数量与请求不符']);
    // 这个标的停 5 分钟，别的标的与没确认写法的类别不受影响；同一轮里别的成功不盖掉原因，过 90 秒才消失。
    assert.deepEqual([quoter.wants('crypto', 'BTC'), quoter.wants('crypto', 'ETH'), quoter.wants('etf', 'QQQ'), quoter.wants('other', 'XYZ')], [false, true, false, false]);
    reply = () => good();
    await ask();
    assert.match(quoter.view().error ?? '', /与请求不符/);
    clock += TOKEN_ERROR_KEEP_MS;
    assert.equal(quoter.view().error, null);
    clock += TOKEN_SYMBOL_PAUSE_MS;
    assert.equal(quoter.wants('crypto', 'BTC'), true);

    // 被拦截（403 或 Cloudflare 质询）：暂不可用，下一轮照常再试，成功后恢复。
    reply = () => new Response('', { status: 403 });
    await assert.rejects(ask(), /被拦截/);
    assert.deepEqual([quoter.usable(), quoter.view().status, quoter.wants('crypto', 'BTC')], [false, 'unavailable', true], '被拦截后整个 token 停 5 分钟，不记在标的上');
    assert.match(quoter.view().error ?? '', /被拦截/);
    clock += TOKEN_BLOCK_PAUSE_MS;
    assert.equal(quoter.usable(), true);
    // 缺 python3 与超时各有原因；调用方中止的请求不算失败。
    reply = () => { throw Object.assign(new Error('spawn python3 ENOENT'), { code: 'VARIATIONAL_PYTHON_MISSING' }); };
    await assert.rejects(ask(), /需要 Python 3/);
    assert.match(quoter.view().error ?? '', /需要 Python 3/);
    reply = () => { throw Object.assign(new Error('slow'), { name: 'TimeoutError' }); };
    await assert.rejects(ask(), /超时/);
    assert.deepEqual([quoter.view().status, quoter.wants('crypto', 'BTC'), quoter.usable()], ['unavailable', false, true]);
    clock += TOKEN_SYMBOL_PAUSE_MS;
    reply = () => good();
    await ask();
    clock += TOKEN_ERROR_KEEP_MS;
    const stopped = new AbortController();
    stopped.abort();
    reply = () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); };
    await assert.rejects(quoter.quote('crypto', 'BTC', 1000, 100.2, stopped.signal));
    assert.deepEqual([quoter.view().status, quoter.view().error, quoter.wants('crypto', 'BTC')], ['ready', null, true]);
    // 传输用的信号中止了（引擎的阶段时限）而调用方自己的没中止：按超时记失败，标的暂停，原因带标的代码。
    await assert.rejects(quoter.quote('crypto', 'BTC', 1000, 100.2, stopped.signal, new AbortController().signal), /BTC：Variational 请求超时/);
    assert.deepEqual([quoter.view().status, quoter.wants('crypto', 'BTC'), quoter.usable()], ['unavailable', false, true]);
    assert.match(quoter.view().error ?? '', /^BTC：/);
    reply = () => new Response('', { status: 403 });
    await assert.rejects(ask(), /被拦截/);
    clock += TOKEN_BLOCK_PAUSE_MS;
    reply = () => good();
    await ask();
    assert.deepEqual([quoter.view().status, quoter.view().error], ['ready', null]);

    // 401 且 x-omni-auth: r：这个 token 不再用，也不再发请求；文件换成新 token 后恢复。
    reply = () => new Response('', { status: 401, headers: { 'x-omni-auth': 'r' } });
    await assert.rejects(ask(), /未通过会话认证/);
    assert.deepEqual([quoter.usable(), quoter.view().status, quoter.view().statusName], [false, 'rejected', '会话已失效']);
    const before = sent.length;
    await assert.rejects(ask(), /没有可用的 Var token/);
    assert.equal(sent.length, before);
    save(second, 2);
    reply = () => good();
    await ask();
    assert.deepEqual([quoter.view().status, sent.at(-1)!.cookie], ['ready', `vr-token=${second}`]);

    // 请求途中文件换了 token：旧 token 的拒绝不落到新 token 上（L089）。
    let release = (_: Response) => {};
    reply = () => new Promise<Response>(resolve => { release = resolve; });
    const pending = ask();
    await new Promise(resolve => setImmediate(resolve));
    const third = fakeVariationalToken(T0 + 3 * 86_400_000, 'c');
    save(third, 3);
    release(new Response('', { status: 401, headers: { 'x-omni-auth': 'r' } }));
    await assert.rejects(pending, /未通过会话认证/);
    assert.deepEqual([quoter.usable(), quoter.view().status], [true, 'ready']);

    // 临近到期与文件损坏。
    clock = T0 + 3 * 86_400_000;
    assert.deepEqual([quoter.usable(), quoter.view().status], [false, 'expired']);
    clock = T0;
    writeFileSync(file, 'not json', { mode: 0o600 });
    assert.deepEqual([quoter.usable(), quoter.view().status], [false, 'missing']);
    assert.match(quoter.view().error ?? '', /无法读取或内容无效/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('判断时刻的样本：有 Var 询价时 A 腿各档都换成询价，询价不完整或倒挂时不换', () => {
  const base = sample(T0, 100.3, 100, { bBidRx: 100.04, bAskRx: 100.06 });
  const quoted = executionSample({ ...base, aBidTk: 100.11, aAskTk: 100.13, aTkAt: T0 + 900 })!;
  assert.deepEqual([quoted.aBid0, quoted.aAsk0, quoted.aBid1k, quoted.aAsk1k, quoted.aBid100k, quoted.aAsk100k], [100.11, 100.13, 100.11, 100.13, 100.11, 100.13]);
  assert.equal(quoted.bAsk0, 100.06, 'B 一侧照旧换成判断时刻的一档');
  for (const extra of [{ aBidTk: 100.11 }, { aAskTk: 100.13 }, { aBidTk: 100.2, aAskTk: 100.1 }, { aBidTk: 0, aAskTk: 100.1 }] as Partial<Sample>[]) {
    assert.equal(executionSample({ ...base, ...extra })!.aBid1k, base.aBid1k);
    assert.equal(hasTokenQuote({ ...base, ...extra }), false);
  }
  assert.equal(hasTokenQuote({ ...base, aBidTk: 100.11, aAskTk: 100.13 }), true);
  assert.equal(executionSample({ ...base, bBidRx: null, aBidTk: 100.11, aAskTk: 100.13 }), null, '没有 B 腿一档时仍不出判断时刻的样本');
  // 开仓复核与平仓都按询价：公开报价偏贵 26 基点，询价只剩约 6 基点时不开。
  const params: SymbolParams = { ...DEFAULT_SYMBOL, enabled: true, entryBps: 10, exitBps: 0, regimes: ['all'] };
  const baseline = { regime: 'all' as const, median: 0, sigma: 2, samples: 500, since: T0, fallback: false };
  const decision = decide(base, baseline, params, null);
  assert.equal(decision.kind, 'open');
  if (decision.kind !== 'open') return;
  assert.equal(confirmOpen({ ...base, aBidTk: 100.11, aAskTk: 100.13 }, baseline, params, decision, true), DECAYED);
  const confirmed = confirmOpen({ ...base, aBidTk: 100.25, aAskTk: 100.27 }, baseline, params, decision, true);
  assert.ok(typeof confirmed !== 'string');
  if (typeof confirmed === 'string') return;
  const held = openPosition('p1', confirmed.sample, params, confirmed.decision, baseline, ZERO_FEES);
  assert.equal(held.aEntry, 100.25);
  // 成本门槛取复核后与报价时刻两种口径里较大的往返成本（止损仍按公开报价判断）。
  const wide = { ...decision, spread: { ...decision.spread, buyA: decision.spread.sellA + 70 } };
  const narrow = confirmed.decision.spread.buyA - confirmed.decision.spread.sellA;
  assert.ok(narrow < 10 && Math.abs(openEconomics(confirmed.decision, params, COSTS, wide).costBps - 70) < 1e-9);
  assert.equal(openEconomics(confirmed.decision, params, COSTS).costBps, narrow, '不带询价时不传报价时刻的决定，与 v0.81.0 相同');
  assert.equal(openBlocker(confirmed.sample, { ...params, stopBps: 60 }, DEFAULT_GLOBAL, { openPositions: 0, openNotionalUsd: 0, dailyNetUsd: 0, cooldownUntil: 0, eligible: true, ...openEconomics(confirmed.decision, params, COSTS, wide) }), COST_BLOCK);
  const later = sample(T0 + 60_000, 100.0, 100, { aBidTk: 100.02, aAskTk: 100.04 });
  const spread = closeSpread(later, held, positionSpread(later, held.notionalUsd)!);
  assert.equal(closePosition(held, later.t, spread, 'revert', { slippageBps: 1 }, null).aExit, 100.04);
});

test('样本库升级：v0.81 的库补上 Var 询价的三列，旧样本读成空，新样本读回，重复打开不报错', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tp-varlighter-'));
  const file = path.join(dir, 'varlighter.sqlite');
  try {
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE samples (symbol TEXT NOT NULL, t INTEGER NOT NULL, received_at INTEGER NOT NULL, regime TEXT NOT NULL,
      var_mark REAL NOT NULL, var_bid0 REAL NOT NULL, var_ask0 REAL NOT NULL, var_bid1k REAL NOT NULL, var_ask1k REAL NOT NULL, var_bid100k REAL, var_ask100k REAL, var_funding REAL,
      rh_at INTEGER NOT NULL, rh_bid0 REAL NOT NULL, rh_ask0 REAL NOT NULL, rh_mark REAL, rh_index REAL, rh_funding REAL, rh_bid1k REAL, rh_ask1k REAL, rh_bid100k REAL, rh_ask100k REAL, rh_bid_rx REAL, rh_ask_rx REAL,
      PRIMARY KEY (symbol, t)) WITHOUT ROWID;
      INSERT INTO samples(symbol, t, received_at, regime, var_mark, var_bid0, var_ask0, var_bid1k, var_ask1k, rh_at, rh_bid0, rh_ask0, rh_bid_rx, rh_ask_rx) VALUES ('rh:BTC', 1000, 2000, 'all', 100, 99.9, 100.1, 99.8, 100.2, 900, 99.95, 100.05, 99.96, 100.04);`);
    old.close();
    for (let round = 0; round < 2; round++) {
      const store = openVarLighterStore(file);
      try {
        const before = store.samples(RH_BTC, 0, 1500)[0];
        assert.deepEqual([before.bBidRx, before.aBidTk, before.aAskTk, before.aTkAt], [99.96, null, null, null]);
        if (round === 0) assert.equal(store.addSamples([sample(5000, 100.2, 100, { aBidTk: 100.18, aAskTk: 100.22, aTkAt: 5900 })]), 1);
        const latest = store.latest(RH_BTC)!;
        assert.deepEqual([latest.aBidTk, latest.aAskTk, latest.aTkAt], [100.18, 100.22, 5900]);
      } finally { store.close(); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('引擎接 Var 询价：只给已启用的配对询价，按询价复核与开平仓，询价失败、过旧或没有 token 时退回公开报价', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tp-varlighter-'));
  let clock = T0, varMid = 100.2, tick = 0;
  const sockets = new Map<string, FakeSocket>();
  const market = (symbol: string, id: number) => ({ symbol, market_id: id, market_type: 'perp', status: 'active', size_decimals: 4, price_decimals: 2, min_base_amount: '0.001', min_quote_amount: '10', taker_fee: '0', maker_fee: '0', mark_price: '100' });
  const fetchImpl = async (url: string) => {
    if (url.includes('orderBookDetails')) return Response.json({ code: 200, order_book_details: [market('BTC', url.includes('api.rh.lighter.xyz') ? 1 : 7)] });
    if (url.includes('orderBookOrders')) return Response.json({ code: 200, bids: [{ price: '99.99', remaining_base_amount: '100' }], asks: [{ price: '100.01', remaining_base_amount: '100' }] });
    return Response.json({ listings: [{ ticker: 'BTC', name: 'Bitcoin', mark_price: String(varMid), funding_rate: '0.1', funding_interval_s: 28800,
      quotes: { updated_at: new Date(clock - 2_000).toISOString(), base: { bid: String(varMid - 0.01), ask: String(varMid + 0.01) }, size_1k: { bid: String(varMid - 0.02), ask: String(varMid + 0.02) } } }] });
  };
  // 询价替身：tokenMid 为 null 时跟公开价；mode 决定这一轮的表现。
  const asked: [string, string, number, number][] = [];
  let usable = true, tokenMid: number | null = null, mode: 'ok' | 'fail' | 'stale' = 'ok';
  const skipped = new Set<string>();
  const quoter: VarQuoter = {
    usable: () => usable,
    wants: (kind, symbol) => kind === 'crypto' && !skipped.has(symbol),
    async quote(kind, symbol, notionalUsd, referencePrice) {
      asked.push([kind, symbol, notionalUsd, referencePrice]);
      if (mode === 'fail') throw new Error('Variational 暂不可用，请稍后重试。');
      const mid = tokenMid ?? varMid;
      return { bid: mid - 0.005, ask: mid + 0.005, mark: mid, qty: 9.98, at: clock - (mode === 'stale' ? TOKEN_QUOTE_MAX_AGE_MS + 1 : 300), receivedAt: clock };
    },
    view: () => ({ status: 'ready', statusName: '正常', expiresAt: T0 + 86_400_000, error: null, okAt: clock, lagMs: 300 }),
  };
  const store = openVarLighterStore(path.join(dir, 'varlighter.sqlite'));
  const engine = createVarLighterEngine({ store, fetchImpl, connect: url => { const socket = new FakeSocket(); sockets.set(venueOf(url), socket); return socket; }, now: () => clock, quoter });
  const signal = AbortSignal.timeout(5000);
  const minute = async () => {
    clock += 60_000; tick++;
    sockets.get('rh')!.push({ type: 'update/market_stats', channel: 'market_stats:all', market_stats: { 1: { market_id: 1, mark_price: String(100 + tick * 0.0001) } } });
    sockets.get('lighter')!.push({ type: 'update/market_stats', channel: 'market_stats:all', market_stats: { 7: { market_id: 7, mark_price: String(100 + tick * 0.0001) } } });
    await engine.pollVar(signal);
    return engine.views.state().sources.var.poll!;
  };
  try {
    engine.startStreams();
    for (const [name, id] of [['rh', 1], ['lighter', 7]] as const) {
      sockets.get(name)!.open();
      sockets.get(name)!.push({ type: 'subscribed/market_stats', channel: 'market_stats:all', market_stats: { [id]: { market_id: id, best_bid_price: '99.99', best_ask_price: '100.01', mark_price: '100' } } });
    }
    await engine.refreshCatalog(signal, 'rh');
    await engine.refreshCatalog(signal, 'lighter');
    await engine.pollVar(signal);
    await minute();
    assert.equal(asked.length, 0, '没有启用的配对不询价');
    assert.deepEqual(engine.views.state().sources.var.token, quoter.view());
    engine.views.settings({ revision: engine.views.state().settings.revision, global: { minSamples: 10, windowHours: 2, minNetBps: 5 }, symbols: { [RH_BTC]: { enabled: true, entryBps: 15, exitBps: 2, cooldownMinutes: 0, regimes: ['all'] } } });
    let poll = await minute();
    assert.deepEqual(asked, [['crypto', 'BTC', 1000, 100.2]], '只询已启用的 RH 配对，数量按它的名义金额与公开标记价');
    assert.deepEqual([poll.tokenOk, poll.tokenFailed], [1, 0]);
    let latest = store.latest(RH_BTC)!;
    assert.deepEqual([latest.aBidTk, latest.aAskTk, latest.aTkAt], [100.2 - 0.005, 100.2 + 0.005, clock - 300]);
    assert.equal(store.latest(LIGHTER_BTC)!.aBidTk, null, '没启用的配对样本不带询价');
    for (let index = 0; index < 11; index++) await minute();

    // 公开报价冲到 100.5，但询价显示 Var 仍在 100.22：报价时刻有信号，按询价复核后不开。
    varMid = 100.5; tokenMid = 100.22;
    poll = await minute();
    assert.equal(engine.views.paper().positions.length, 0);
    assert.equal(poll.blocked[DECAYED], 1);
    // 询价也在 100.47：开仓，Var 腿按询价的买价成交，不是公开报价 1k 档的 100.48。
    tokenMid = 100.47;
    await minute();
    const opened = engine.views.paper().positions;
    assert.deepEqual(opened.map(item => [item.symbol, item.direction]), [[RH_BTC, 'a_rich']]);
    assert.ok(Math.abs(opened[0].aEntry - 100.465) < 1e-9);
    assert.match(engine.views.paper().events.find(event => event.kind === 'open')!.message, /Var 按 token 询价/);
    // 回落：平仓的 Var 腿按询价的卖价。
    varMid = 100.2; tokenMid = 100.21;
    await minute();
    const trades = engine.views.paper().trades;
    assert.deepEqual([trades.length, trades[0].reason], [1, 'revert']);
    assert.ok(Math.abs(trades[0].aExit - 100.215) < 1e-9);

    // 询价失败：这一轮的样本不带询价，统计里记失败。
    tokenMid = null; mode = 'fail';
    poll = await minute();
    assert.deepEqual([poll.tokenOk, poll.tokenFailed], [0, 1]);
    assert.equal(store.latest(RH_BTC)!.aBidTk, null);
    // 询价的报价时刻过旧：不用。
    mode = 'stale';
    poll = await minute();
    assert.deepEqual([poll.tokenOk, store.latest(RH_BTC)!.aBidTk], [1, null]);
    // 没有可用 token：一个请求也不发，按公开报价照常开仓。
    mode = 'ok'; usable = false;
    const before = asked.length;
    varMid = 100.5;
    poll = await minute();
    assert.equal(asked.length, before);
    assert.deepEqual([poll.tokenOk, poll.tokenFailed], [0, 0]);
    latest = store.latest(RH_BTC)!;
    assert.equal(latest.aBidTk, null);
    const fallback = engine.views.paper().positions;
    assert.equal(fallback.length, 1);
    assert.ok(Math.abs(fallback[0].aEntry - 100.48) < 1e-9, '按公开报价的 1k 档');
    const opens = engine.views.paper().events.filter(event => event.kind === 'open');
    assert.deepEqual([opens.length, opens.filter(event => event.message.includes('token 询价')).length], [2, 1]);
    // 有持仓的配对在有 token 后继续询价；只有上一轮要询的都询到，就绪项才按询价的延迟算。
    usable = true;
    await minute();
    assert.equal(asked.length, before + 1);
    const latency = () => engine.views.readiness().items.find(item => item.key === 'latency')!;
    assert.match(latency().detail, /判断时刻用 token 询价/);
    mode = 'fail';
    await minute();
    assert.match(latency().detail, /上一轮成功 0、失败 1/);
    // 询价器不要的标的（写法没确认的类别、失败后暂停中的）不询也不计失败。
    mode = 'ok'; skipped.add('BTC');
    poll = await minute();
    assert.deepEqual([asked.length, poll.tokenOk, poll.tokenFailed], [before + 2, 0, 0]);
    assert.equal(poll.tokenSkipped, 1);
    assert.match(latency().detail, /成功 0、失败 0、未询 1/);
    // 上一次拉取太久以前：不再按它判断。
    skipped.clear();
    await minute();
    assert.match(latency().detail, /判断时刻用 token 询价/);
    clock += 4 * 60_000;
    assert.doesNotMatch(latency().detail, /判断时刻用 token 询价/);
  } finally { engine.close(); rmSync(dir, { recursive: true, force: true }); }
});
