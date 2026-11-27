// DEX 价差模块（docs/varlighter.md、docs/dexspread.md）：解析、时段、基线、策略盈亏、回测不看未来、行情流一档连续性、盘口快照、
// Entropy 目录与行情流、手动配对与乘数、旧库迁移与多场所引擎端到端。
// 行情都是假的：fetch 与 WebSocket 由测试替换，不连任何外部服务。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BUSY_BLOCK, COST_BLOCK, DECAYED, FALLBACK_BLOCK, FEE_BLOCK, NO_LIVE_TOP, NO_QUOTE_TIME, STALE_QUOTE, THIN_BLOCK, closeSpread, confirmOpen, expectedNetBps, openEconomics, slippageBudgetBps } from '../src/varlighter/strategy.ts';
import { DEFAULT_COMBOS, SAMPLE_FIELDS, comboPairs, customPairInfo, sameSymbol, sizeBucket, targetSpread, formatRatio, varQuoteQty, legacyKeyOf, lighterMarket, pairKey, pairTitle, parseEntropyMarkets, upgradeKey, varMarket, type MarketSpec } from '../src/varlighter/model.ts';
import type { SamplesView } from '../src/varlighter/views.ts';
import { TOKEN_BLOCK_PAUSE_MS, TOKEN_ERROR_KEEP_MS, TOKEN_SYMBOL_PAUSE_MS, TOKEN_QUOTE_MAX_AGE_MS, TOKEN_QUOTE_PHASE_MS, createVarQuoter, parseTokenQuote, varInstrument, type VarQuoter } from '../src/varlighter/varquote.ts';
import { VARIATIONAL_SESSION_FILE } from '../src/monitor/variational-session.ts';
import { fakeVariationalToken } from './monitor-fake.ts';
import { pairMarkets, parsePairKey, parseRhMarkets, parseVarListings, parseVarQuote, regimeOf, spreadOf, midBasis, type Sample } from '../src/varlighter/model.ts';
import { BaselineTracker, RollingWindow, regimeStats, suggestedEntryBps } from '../src/varlighter/stats.ts';
import { AUTO_BLOCK, DEFAULT_GLOBAL, DEFAULT_SYMBOL, closePosition, decide, markToMarket, openBlocker, openPosition, positionSpread, readGlobalParams, readSymbolParams, recommendParams, type GlobalParams, type Position, type SymbolParams } from '../src/varlighter/strategy.ts';
import { backtestRequest, chartEquity, runBacktest } from '../src/varlighter/backtest.ts';
import { BOOK_KEEP_LEVELS, CONNECT_TIMEOUT_MS, DEPTH_MAX_GAP_MS, HyperliquidStream, LighterStream, depthAt, depthSnapshot, vwap, type SocketLike } from '../src/varlighter/feeds.ts';
import { orderPlan } from '../src/varlighter/plan.ts';
import { MIGRATED_KEY, openVarLighterStore } from '../src/varlighter/store.ts';
import { COOLDOWN_KEY, ENTROPY_FEE_DEFAULT_MIGRATED_KEY, LEGACY_UPGRADE, SETTINGS_KEY, createVarLighterEngine, customKey, downsample, readCustomPair, upgradeSettings } from '../src/varlighter/engine.ts';
import { READ_TOKEN_MAX_BYTES } from '../src/read-token.ts';
import { localDexForward, openVarLighter, varLighterLoop, varLighterViews } from '../src/dex/host.ts';
import { createLiveKeysStore } from '../src/varlighter/livekeys.ts';
import { LIVE_SETTINGS_KEY, type LivePosition } from '../src/varlighter/live.ts';

const T0 = Date.parse('2026-11-23T15:00:00Z'); // 周一纽约 10:00（盘中）
const RH_BTC = 'var:BTC|rh:BTC', LIGHTER_BTC = 'var:BTC|lighter:BTC';
const ZERO_FEES = { aFeeBps: 0, bFeeBps: 0 };
const COSTS = { slippageBps: 1, ...ZERO_FEES };
/** 按行情流地址认场所。 */
const venueOf = (url: string) => url.includes('hyperliquid') ? 'entropy' : url.includes('mainnet') ? 'lighter' : 'rh';

function sample(t: number, aMid: number, bMid = 100, extra: Partial<Sample> = {}): Sample {
  return {
    symbol: RH_BTC, t, receivedAt: t + 1_000, regime: 'all', ratio: 1, captureKind: 'decision', decisionAt: t + 1_000,
    aRxAt: null, bRxAt: t + 1_000, aTkQty: null, bTkQty: null, aTkReceivedAt: null, bTkReceivedAt: null,
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
  assert.deepEqual([markets[0].deployerFeeScale, markets[0].growthMode, markets[1].growthMode, markets[2].growthMode], [0.5, 'disabled', 'enabled', null]);
  assert.deepEqual([markets[0].coin, markets[0].priceDecimals, markets[0].index, markets[0].mark, markets[0].fundingHourly, markets[0].minQuote], ['io:SNDK', 4, 100.4, 100.3, 0.0000125, 10]);
  assert.throws(() => parseEntropyMarkets({}), /Entropy 目录格式无效/);
  assert.throws(() => parseEntropyMarkets([{ universe, collateralToken: 1 }, contexts]), /抵押资产发生变化/);
  // Var 对 Entropy：已核对表里且 Entropy 一侧是每股合约的为已核对，其余待确认；顺序沿用 A 场所的目录。
  const auto = comboPairs('var|entropy', [spec('var', 'SNDK', 100.2), spec('var', 'AAPL', 200)], [spec('entropy', 'SNDK', 100.3), spec('entropy', 'AAPL', 200.1)]);
  assert.deepEqual(auto.map(pair => [pair.key, pair.identity]), [['var:SNDK|entropy:SNDK', 'verified'], ['var:AAPL|entropy:AAPL', 'review']]);
  // 代码别名：Lighter 的 ANTHROPIC 与 Entropy 的 ANTH 同一计价，自动配成一对（乘数 1、待确认）；每股计价的 ANT 不配。
  const alias = comboPairs('lighter|entropy', [spec('lighter', 'ANTHROPIC', 1472.5), spec('lighter', 'ANT', 83.55)], [spec('entropy', 'ANTH', 1471.4)]);
  assert.deepEqual(alias.map(pair => [pair.key, pair.symbol, pair.ratio, pair.kind, pair.identity, pair.custom]), [['lighter:ANTHROPIC|entropy:ANTH', 'ANTHROPIC / ANTH', 1, 'private', 'review', false]]);
  assert.equal(comboPairs('rh|entropy', [spec('rh', 'ANTHROPIC', 1000)], [spec('entropy', 'ANTH', 1471.4)])[0].identity, 'mismatch', '别名配对价差超 5% 仍为规格不同');
  assert.deepEqual(comboPairs('lighter|entropy', [spec('lighter', 'ANTH', 1470)], [spec('entropy', 'ANTHROPIC', 1471)]).map(pair => pair.key), ['lighter:ANTH|entropy:ANTHROPIC'], '别名两个方向都认');
  assert.ok(sameSymbol('ANTHROPIC', 'ANTH') && sameSymbol('ANTH', 'ANTHROPIC') && sameSymbol('BTC', 'BTC') && !sameSymbol('ANT', 'ANTH') && !sameSymbol('BTC', 'ETH'));
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

test('开仓风控：暂停、未确认规格、时段、冷却、手续费未知、同腿互斥、持仓与名义上限、当日亏损', () => {
  const params: SymbolParams = { ...DEFAULT_SYMBOL, enabled: true, regimes: ['all'] };
  const context = { openPositions: 0, openNotionalUsd: 0, dailyNetUsd: 0, cooldownUntil: 0, eligible: true };
  const value = sample(T0, 100);
  assert.equal(openBlocker(value, params, DEFAULT_GLOBAL, context), null);
  assert.equal(openBlocker(value, params, { ...DEFAULT_GLOBAL, paused: true }, context), '已暂停');
  assert.equal(openBlocker(value, { ...params, enabled: false }, DEFAULT_GLOBAL, context), '未启用');
  assert.equal(openBlocker(value, params, DEFAULT_GLOBAL, { ...context, eligible: false }), '规格未确认');
  assert.equal(openBlocker({ ...value, regime: 'rth' }, params, DEFAULT_GLOBAL, context), '当前时段不开仓');
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
  assert.equal(confirmOpen(gone, baseline, params, open(gone), 30), DECAYED);
  // B 只涨了 5 分：仍有约 21 基点，按 100.07（那一刻的一档加原来的冲击）买入。
  const still = sample(T0, 100.3, 100, { bBidRx: 100.04, bAskRx: 100.06 });
  const confirmed = confirmOpen(still, baseline, params, open(still), 30);
  assert.ok(typeof confirmed !== 'string');
  if (typeof confirmed === 'string') return;
  assert.ok(Math.abs(confirmed.spread.prices.bAsk - 100.07) < 1e-9);
  assert.ok(Math.abs(confirmed.deviation - (100.28 - 100.07) / 100.05 * 1e4) < 1e-6);
  const held = openPosition('p1', still, params, confirmed, baseline, ZERO_FEES);
  assert.ok(Math.abs(held.bEntry - 100.07) < 1e-9);
  // 已有决策时刻却缺行情流一档，或旧样本缺来源时间，分别说明原因。
  const legacy = sample(T0, 100.3, 100, { bBidRx: null, bAskRx: null });
  assert.equal(confirmOpen(legacy, baseline, params, open(legacy), 30), NO_LIVE_TOP);
  assert.equal(confirmOpen({ ...legacy, decisionAt: null, captureKind: null }, baseline, params, open(legacy), 30), NO_QUOTE_TIME);
  // 平仓同样按那一刻的价：卖出 B 用 100.04 − 0.01。
  const exit = closeSpread(still, held)!;
  assert.ok(Math.abs(exit.prices.bBid - 100.03) < 1e-9);
  // 预期净利：偏离 26 − 出场 0 − 半个往返成本 4 − 四次滑点 4 = 18 基点。
  const plain = sample(T0, 100.3), net = expectedNetBps(open(plain), params, COSTS);
  assert.ok(Math.abs(net - 18) < 1e-6);
  assert.ok(Math.abs(expectedNetBps(open(plain), params, { slippageBps: 1, aFeeBps: 1, bFeeBps: 0.5 }) - 15) < 1e-6, '每腿手续费各扣两次');
  assert.equal(openBlocker(plain, params, DEFAULT_GLOBAL, { ...context, expectedNetBps: net }), null);
  assert.equal(openBlocker(plain, params, { ...DEFAULT_GLOBAL, minNetBps: 19 }, { ...context, expectedNetBps: net }), THIN_BLOCK);
  assert.equal(openBlocker(plain, params, DEFAULT_GLOBAL, { ...context, fallbackBaseline: true }), FALLBACK_BLOCK);
  assert.equal(confirmOpen({ ...plain, decisionAt: plain.t + 31_000 }, baseline, params, open(plain), DEFAULT_GLOBAL.maxQuoteAgeSec), STALE_QUOTE, '默认时效 30 秒');
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
  // 新样本缺一档、整段全空都拒绝开仓。
  const gaps = run(oscillating(600).map((item, index) => spike(index) ? { ...item, bBidRx: null, bAskRx: null } : item));
  assert.equal(gaps.trades.length, 0);
  assert.ok(gaps.summary.blocked[NO_LIVE_TOP] >= 15);
  assert.ok(run(oscillating(600).map(item => ({ ...item, bBidRx: null, bAskRx: null }))).summary.blocked[NO_LIVE_TOP] >= 15);
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
  assert.deepEqual([upgraded.global.varFeeBps, upgraded.global.rhFeeBps, upgraded.global.lighterFeeBps, upgraded.global.entropyFeeBps, upgraded.global.minNetBps], [null, 0.5, 0.5, 0.2, 7]);
  assert.equal(upgradeSettings({ global: { ...LEGACY_GLOBAL, entropyFeeBps: null } }).global.entropyFeeBps, null, '显式留空保持按目录');
  assert.deepEqual(Object.keys(upgraded.symbols), [RH_BTC]);
  assert.deepEqual(upgraded.symbols[RH_BTC].directions, ['a_cheap']);
  assert.deepEqual(upgraded.confirmed, ['var:X|lighter:X', 'var:X|rh:X']);
  assert.deepEqual(upgraded.combos, ['var|lighter', 'var|entropy', 'lighter|entropy']);
  assert.deepEqual(upgraded.pairs, []);
  assert.deepEqual(upgradeSettings({ venues: ['rh'] }).combos, ['var|rh', 'var|entropy']);
  assert.deepEqual(upgradeSettings({}).combos, [...DEFAULT_COMBOS]);
  assert.deepEqual(upgradeSettings(null), { revision: 0, global: DEFAULT_GLOBAL, symbols: {}, confirmed: [], combos: [...DEFAULT_COMBOS], pairs: [], auto: [] });
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

  // 迁移失败：整体回滚、模块不可用并关库；问题排除后下次启动重试成功。
  const failDir = mkdtempSync(path.join(tmpdir(), 'tp-varlighter-'));
  try {
    const failFile = path.join(failDir, 'varlighter.sqlite');
    openVarLighterStore(failFile).close();
    const raw = new DatabaseSync(failFile);
    raw.prepare('INSERT INTO paper_positions(id, symbol, json) VALUES (?, ?, ?)').run('p1', 'rh:BTC', JSON.stringify(legacyPosition));
    raw.exec("CREATE TRIGGER fail_migrate BEFORE INSERT ON leg_positions BEGIN SELECT RAISE(ABORT, 'disk says no'); END");
    raw.close();
    const lines: string[] = [];
    const failed = openVarLighter(failDir, { connect: () => new FakeSocket() }, line => lines.push(line));
    assert.equal(failed.engine, null);
    assert.match(failed.error ?? '', /disk says no/);
    assert.ok(lines.some(line => line.includes('模块停用')));
    const unavailable = (() => { try { varLighterViews(failed).state(); } catch (error) { return varLighterViews(failed).failure(error); } return null; })();
    assert.deepEqual([unavailable?.status, unavailable?.body.code], [503, 'unavailable'], '模块不可用时接口 503');
    const fix = new DatabaseSync(failFile);
    assert.equal((fix.prepare('SELECT COUNT(*) AS n FROM leg_positions').get() as { n: number }).n, 0, '回滚，没有半截迁移');
    fix.exec('DROP TRIGGER fail_migrate');
    fix.close();
    const retried = openVarLighter(failDir, { connect: () => new FakeSocket() }, () => {});
    try {
      assert.equal(retried.error, null);
    } finally { retried.engine?.close(); }
    const check = openVarLighterStore(failFile);
    try { assert.deepEqual(check.positions().map(item => item.symbol), [RH_BTC], '下次启动重试成功（旧持仓留在库里，页面不再显示）'); } finally { check.close(); }
  } finally { rmSync(failDir, { recursive: true, force: true }); }

  // 引擎启动时迁移：有旧持仓记一行日志；全新安装什么都不记。
  for (const legacy of [true, false]) {
    const lines: string[] = [];
    const context = seededEngine(() => {}, { log: line => lines.push(line), raw: legacy ? db => db.prepare('INSERT INTO paper_positions(id, symbol, json) VALUES (?, ?, ?)').run('p1', 'rh:BTC', JSON.stringify(legacyPosition)) : undefined });
    try {
      const migrated = lines.filter(line => line.includes('已升级为两腿口径'));
      assert.deepEqual(migrated, legacy ? ['varlighter: 已升级为两腿口径（持仓 1、成交 0）'] : []);
      if (legacy) assert.deepEqual(context.store.positions().map(item => [item.symbol, item.direction, item.aEntry]), [[RH_BTC, 'a_rich', 100.3]]);
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
        const before = store.samples(RH_BTC, 1000, 1500)[0];
        assert.deepEqual([before.symbol, before.ratio, before.aAt, before.aBid0, before.bAt, before.bBidRx], [RH_BTC, 1, 1000, 99.9, 900, null], '旧表的样本按新键读出');
        assert.deepEqual([before.captureKind, before.decisionAt], ['aligned', null], '升级前确实没有决策盘口列，不改写旧报价时刻');
        if (round === 0) {
          assert.equal(store.addSamples([sample(5000, 100.2, 100, { symbol: RH_BTC })]), 1);
          // 回退版本仍按旧列名写；即使写入的时刻更早，也不能继承旧行的来源标记。
          const rollback = new DatabaseSync(file);
          try { rollback.exec("INSERT INTO samples(symbol,t,received_at,regime,var_mark,var_bid0,var_ask0,var_bid1k,var_ask1k,rh_at,rh_bid0,rh_ask0) VALUES ('rh:BTC',500,600,'all',100,99,101,99,101,450,99,101)"); } finally { rollback.close(); }
        }
        assert.equal(store.samples(RH_BTC, 0, 900)[0].captureKind, null);
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

test('盘口快照：冲击套到对齐时刻的一档价上，相隔过久不用', () => {
  const snapshot = depthSnapshot({ asks: [[100.1, 5], [100.2, 20]], bids: [[99.9, 5], [99.8, 50]] }, T0);
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
  assert.throws(() => depthSnapshot({ bids: [[100, 1]], asks: [] }, T0), /为空/);
});

test('Lighter 盘口行情流：订阅 order_book，快照加增量（数量 0 删档），nonce 断档与倒挂重新订阅，快照超时重订，连续重订退避，退订与断线清空', () => {
  let clock = T0;
  const sockets: FakeSocket[] = [];
  const stream = new LighterStream({ venue: 'rh', connect: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; }, now: () => clock });
  const tick = () => (stream as unknown as { tick(): void }).tick();
  try {
    stream.setDepthMarkets(new Map([[1, '1']]));
    stream.start();
    const socket = sockets[0];
    socket.open();
    assert.deepEqual(socket.sent.map(item => `${item.type} ${item.channel}`), ['subscribe market_stats/all', 'subscribe order_book/1'], '连上后订阅全市场一档与盘口');
    socket.push({ type: 'subscribed/market_stats', channel: 'market_stats:all', market_stats: {} });
    assert.equal(stream.depth(1), null);
    assert.equal(stream.depthError(1), '等待盘口快照');
    assert.equal(stream.depthError(2), '未订阅盘口');
    const book = (type: string, value: Record<string, unknown>) => socket.push({ type, channel: 'order_book:1', order_book: value });
    book('update/order_book', { bids: [{ price: '99', size: '1' }], asks: [], nonce: 1 });
    assert.equal(stream.depth(1), null, '快照前的增量不用');
    book('subscribed/order_book', { code: 0, bids: [{ price: '99.9', size: '5' }, { price: '99.8', size: '50' }], asks: [{ price: '100.1', size: '5' }, { price: '100.2', size: '20' }], nonce: 10 });
    clock += 5_000;
    const first = stream.depth(1)!;
    assert.deepEqual([first.at, first.bid, first.ask], [clock, 99.9, 100.1], '快照时刻为取用时刻');
    book('update/order_book', { bids: [{ price: '99.9', size: '0' }, { price: '99.85', size: '2' }], asks: [{ price: '100.05', size: '1' }], begin_nonce: 10, nonce: 11 });
    assert.deepEqual([stream.depth(1)!.bid, stream.depth(1)!.ask], [99.85, 100.05], '数量 0 删档，新档加入');
    socket.sent.length = 0;
    book('update/order_book', { bids: [], asks: [{ price: '100.3', size: '1' }], begin_nonce: 12, nonce: 13 });
    assert.deepEqual(socket.sent.map(item => `${item.type} ${item.channel}`), ['unsubscribe order_book/1', 'subscribe order_book/1'], 'nonce 断档重新订阅');
    assert.equal(stream.depth(1), null);
    assert.equal(stream.depthError(1), '盘口增量不连续，重新订阅');
    book('subscribed/order_book', { code: 0, bids: [{ price: '100.2', size: '1' }], asks: [{ price: '100.1', size: '1' }], nonce: 20 });
    clock += 6_000;
    socket.sent.length = 0;
    const sent = () => socket.sent.filter(item => item.type !== 'ping').map(item => `${item.type} ${item.channel}`);
    const resent = ['unsubscribe order_book/1', 'subscribe order_book/1'];
    assert.equal(stream.depth(1), null, '倒挂的盘口不用');
    assert.deepEqual(sent(), [], '连续第二次重订要等 10 秒，先作废盘口、推迟');
    assert.equal(stream.depthError(1), '盘口倒挂，重新订阅');
    assert.equal(stream.depth(1), null, '推迟期间不再算、不再重订');
    assert.deepEqual(sent(), []);
    clock += 4_000;
    tick();
    assert.deepEqual(sent(), resent, '到期再订');
    // 快照迟迟不到：15 秒超时，但连续第三次重订要等 20 秒。
    socket.sent.length = 0;
    clock += 16_000;
    socket.push({ type: 'update/market_stats', channel: 'market_stats:all', market_stats: {} });
    tick();
    assert.deepEqual(sent(), [], '超时但未到退避时刻');
    assert.equal(stream.depthError(1), '盘口快照超时，重新订阅');
    clock += 4_000;
    socket.push({ type: 'update/market_stats', channel: 'market_stats:all', market_stats: {} });
    tick();
    assert.deepEqual(sent(), resent);
    book('subscribed/order_book', { code: 0, bids: [{ price: '99.9', size: '5' }], asks: [{ price: '100.1', size: '5' }], nonce: 30 });
    assert.equal(stream.depth(1)?.bid, 99.9);
    // 算出过盘口后退避清零：5 秒后断档立即重订。
    clock += 5_000;
    socket.sent.length = 0;
    book('update/order_book', { bids: [], asks: [], begin_nonce: 99, nonce: 100 });
    assert.deepEqual(sent(), resent, '退避清零');
    // 深盘口（如 RH 的 BTC 一侧超过 5000 档）：只留最近的 5000 档、不重订；裁剪边界外的增量不收，边界内照常合并。
    socket.sent.length = 0;
    const huge = Array.from({ length: 7_000 }, (_, index) => ({ price: (99 - index * 0.001).toFixed(3), size: '0.01' }));
    book('subscribed/order_book', { code: 0, bids: huge, asks: [{ price: '100.1', size: '5' }], nonce: 40 });
    assert.equal(stream.depth(1)?.bid, 99, '深盘口照样算出');
    assert.equal(stream.depthError(1), null);
    const floor = (99 - (BOOK_KEEP_LEVELS - 1) * 0.001).toFixed(3);
    // 边界那一档本身照常更新与删除：改成大单后 10 万美元冲击算得出，删掉后又算不出。
    book('update/order_book', { bids: [{ price: floor, size: '2000' }], asks: [], begin_nonce: 40, nonce: 41 });
    assert.notEqual(stream.depth(1)?.bid100k, null, '边界档的增量照收');
    book('update/order_book', { bids: [{ price: '90', size: '2000' }, { price: floor, size: '0' }, { price: '99.5', size: '1' }], asks: [], begin_nonce: 41, nonce: 42 });
    assert.equal(stream.depth(1)?.bid, 99.5, '边界内的增量照常合并');
    assert.equal(stream.depth(1)?.bid100k, null, '边界外的大单不收：留下的 5000 档合计不到 10 万美元，冲击未知');
    assert.deepEqual(sent(), [], '深盘口不重订');
    // 裁过的一侧被吃掉一半以上：重订拿完整快照，离上次订阅不够久就推迟。
    book('update/order_book', { bids: huge.slice(0, 3_000).map(level => ({ price: level.price, size: '0' })), asks: [], begin_nonce: 42, nonce: 43 });
    assert.deepEqual(sent(), [], '受限速');
    assert.equal(stream.depthError(1), '裁剪后的盘口变浅，重新订阅');
    book('subscribed/order_book', { code: 0, bids: [{ price: '99.9', size: '5' }], asks: [{ price: '100.1', size: '5' }], nonce: 50 });
    assert.equal(stream.depth(1)?.bid, 99.9, '正常快照到了就恢复');
    clock += 11_000;
    socket.push({ type: 'update/market_stats', channel: 'market_stats:all', market_stats: {} });
    tick();
    assert.deepEqual(sent(), [], '快照到了就取消推迟的重订，过了旧到期时刻也不再订');
    // 换订阅：退订去掉的，新加的立即订阅。
    socket.sent.length = 0;
    stream.setDepthMarkets(new Map([[2, '2']]));
    assert.deepEqual(socket.sent.map(item => `${item.type} ${item.channel}`), ['unsubscribe order_book/1', 'subscribe order_book/2']);
    assert.equal(stream.depth(1), null);
    // 断线：盘口清空，重连后重新订阅。
    socket.push({ type: 'subscribed/order_book', channel: 'order_book:2', order_book: { code: 0, bids: [{ price: '9', size: '1' }], asks: [{ price: '10', size: '1' }] } });
    assert.equal(stream.depth(2)?.ask, 10);
    socket.onclose?.({});
    assert.equal(stream.depth(2), null);
    assert.equal(stream.depthError(2), '行情流未连接');
  } finally { stream.close(); }
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
    const sub = (type: string, coin: string, method = 'subscribe') => ({ method, subscription: { type, coin } });
    assert.deepEqual(socket.sent, [sub('bbo', 'io:SNDK'), sub('activeAssetCtx', 'io:SNDK'), sub('bbo', 'io:OAI'), sub('activeAssetCtx', 'io:OAI')]);
    assert.equal(stream.healthySince(), null, '还没收到消息');
    socket.push({ channel: 'bbo', data: { coin: 'io:SNDK', time: T0, bbo: [{ px: '99.9', sz: '1', n: 1 }, { px: '100.1', sz: '1', n: 1 }] } });
    socket.push({ channel: 'bbo', data: { coin: 'io:OTHER', bbo: [{ px: '1', sz: '1', n: 1 }, { px: '2', sz: '1', n: 1 }] } });
    assert.deepEqual([stream.topAt(0, T0)?.bid, stream.topAt(0, T0)?.ask, stream.topAt(0, T0)?.mark, stream.healthySince()], [99.9, 100.1, null, T0]);
    // 市场状态：标记价、预言机价与资金费按时刻并到一档上。
    socket.push({ channel: 'activeAssetCtx', data: { coin: 'io:SNDK', ctx: { markPx: '100.02', oraclePx: '100.01', funding: '0.0000125' } } });
    assert.deepEqual([stream.topAt(0, T0)?.mark, stream.topAt(0, T0)?.index, stream.topAt(0, T0)?.funding], [100.02, 100.01, 0.0000125]);
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
    assert.deepEqual(socket.sent, [sub('bbo', 'io:SNDK', 'unsubscribe'), sub('activeAssetCtx', 'io:SNDK', 'unsubscribe'), sub('bbo', 'io:NEW'), sub('activeAssetCtx', 'io:NEW')]);
    assert.equal(stream.marketCount, 2);
    // 目录重排：编号 1 换成另一币种，旧一档清掉；换之前发出的 OAI 确认按币种对回，不记到新币种名下。
    clock += 61_000;
    socket.push({ channel: 'pong' });
    socket.sent.length = 0;
    stream.tick();
    const inflight = (socket.sent as { method: string; id?: number; request?: { payload: { coin: string } } }[]).find(item => item.method === 'post' && item.request?.payload.coin === 'io:OAI');
    assert.ok(inflight, 'OAI 一档已旧，发确认');
    stream.setMarkets(new Map([[1, 'io:SWAP'], [4, 'io:NEW'], [7, 'io:OAI']]));
    assert.equal(stream.topAt(1, T0 + 40_000), null, '换了币种的编号清掉旧一档');
    reply(inflight.id!, 'io:OAI', '740', '741');
    assert.equal(stream.topAt(1, clock), null, '在途确认不记到新币种');
    assert.equal(stream.topAt(7, clock)?.bid, 740, '按币种记到 OAI 的新编号');
    // 45 秒没有任何消息：断开重连，区间结束，之前的历史仍可回看。
    clock += 46_000;
    stream.tick();
    assert.deepEqual([stream.status(2).lastError, stream.status(2).reconnects, stream.healthySince(), socket.readyState], ['长时间没有消息', 1, null, 3]);
    assert.equal(stream.topAt(7, clock - 46_000)?.bid, 740);
    assert.equal(stream.topAt(7, clock), null, '断线之后的时刻没有数据');
  } finally { stream.close(); }
});

test('下单预演：按场所精度向下取整，核对最小数量与金额，带 Var 腿的不就绪、两腿都是下单场所的可以就绪；Entropy 腿按 5 位有效数字限价', () => {
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
  assert.deepEqual(plan.checks.filter(check => !check.ok).map(check => check.label), ['Var 没有下单接口，带 Var 腿的配对不上实盘'], '只剩 Var 腿这一条恒假的检查');
  assert.ok(!plan.checks.some(check => /尚未接入/.test(check.label)), '下单连接器已接入，不再有这类检查');
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
  assert.equal(entropyPlan.ready, false, '带 Var 腿');
  // 两腿都是下单场所（Lighter 主网对 Entropy）：没有恒假的检查，条件都满足时就绪；数量不够或报价太旧时仍不就绪。
  const both = comboPairs('lighter|entropy', [lighterMarket('lighter', { ...main, symbol: 'SNDK' })], [entropy])[0];
  const bothSample = sample(T0, 100.3, 100, { symbol: both.key });
  const bothPlan = orderPlan(both, bothSample, 'a_rich', 999.7, 20, T0 + 30_000);
  assert.deepEqual([bothPlan.ready, bothPlan.checks.filter(check => !check.ok).map(check => check.label)], [true, []]);
  assert.deepEqual([bothPlan.legs[0].side, bothPlan.legs[0].qty, bothPlan.legs[1].side, bothPlan.legs[1].qty], ['sell', '9.99', 'buy', '9.99']);
  assert.equal(orderPlan(both, bothSample, 'a_rich', 20, 20, T0 + 30_000).ready, false, '小于 Lighter 最小数量');
  assert.equal(orderPlan(both, bothSample, 'a_rich', 999.7, 20, T0 + 200_000).ready, false, '报价太旧');
});

test('回测曲线保留完整周期、峰谷和时间顺序', () => {
  const points = Array.from({length: 2100}, (_, t) => ({ t, net: t === 81 ? 99 : t === 82 ? -101 : 0 }));
  const result = chartEquity(points);
  assert.ok(result.length <= 1000 && result.every((p, i) => !i || p.t > result[i - 1].t));
  assert.deepEqual([result[0].t, result.at(-1)!.t, Math.max(...result.map(p => p.net)), Math.min(...result.map(p => p.net))], [0, 2099, 99, -101]);
});

test('降采样：每格保留机会极值', () => {
  const points = Array.from({ length: 100 }, (_, index) => ({ t: index, mid: index % 2, sellA: index, buyA: -index, median: 0, sigma: 1 }));
  const result = downsample(points, 10);
  assert.equal(result.length, 10);
  assert.equal(result[0].sellA, 9);
  assert.equal(result[0].buyA, -9);
  assert.equal(result[0].mid, 0.5);
  const broken = points.map((point, i) => ({ ...point, sellA: i === 3 ? 1001 : point.sellA, gapBefore: i === 5 }));
  const segments = downsample(broken, 10);
  assert.deepEqual(segments.slice(0, 2).map(p => [p.sellA, p.gapBefore]), [[1001, false], [9, true]]);
});

test('引擎：各组合各自对齐样本写库，盘口快照，Var 配对只采集不开仓，关闭组合，参数版本冲突', async () => {
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
    const bookSubs = (socket: FakeSocket) => socket.sent.filter(item => item.type === 'subscribe' && String(item.channel).startsWith('order_book/')).map(item => item.channel);
    assert.deepEqual([...bookSubs(rh()), ...bookSubs(main())], [], '没有启用的配对就不订阅盘口');
    const initial = engine.views.state();
    assert.throws(() => engine.views.settings({ revision: initial.settings.revision, symbols: { 'var:OPENAI|rh:OPENAI': { enabled: true } } }), /规格不同/);
    assert.throws(() => engine.views.settings({ revision: initial.settings.revision, symbols: { BTC: { enabled: true } } }), /配对键无效/);
    const enable = { enabled: true, entryBps: 15, exitBps: 2, cooldownMinutes: 0, regimes: ['all'] };
    const saved = engine.views.settings({ revision: initial.settings.revision, global: { minSamples: 10, windowHours: 2, minNetBps: 5 }, symbols: { [RH_BTC]: enable, 'lighter:BTC': enable } });
    assert.equal(saved.revision, 1);
    assert.deepEqual(Object.keys(saved.symbols).sort(), [LIGHTER_BTC, RH_BTC], '旧键写法保存时换成新键');
    assert.deepEqual([bookSubs(rh()), bookSubs(main())], [['order_book/1'], ['order_book/7']], '启用后订阅两条行情流腿的盘口');
    const fullBook = { code: 0, bids: [{ price: '99.99', size: '100' }], asks: [{ price: '100.01', size: '100' }], nonce: 1 };
    rh().push({ type: 'subscribed/order_book', channel: 'order_book:1', order_book: fullBook });
    main().push({ type: 'subscribed/order_book', channel: 'order_book:7', order_book: fullBook });
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
    assert.deepEqual(view.sources.venues.flatMap(item => item.depth.map(depth => [depth.key, depth.at, depth.error])), [['rh:BTC', clock, null], ['lighter:BTC', clock, null]]);
    assert.ok(!requested.some(url => url.includes('orderBookOrders')), '盘口不走 REST');
    // 冲高：Var 配对只采集与回测，不上实盘，也不留持仓或成交。
    varMid = 100.5; await minute();
    assert.deepEqual([engine.views.state().trading.open, row(RH_BTC)!.position], [0, null]);
    varMid = 100.2; await minute();
    // 同一报价时刻不重复计入。
    const before = row(RH_BTC)!.samples24h;
    await engine.pollVar(signal);
    assert.equal(row(RH_BTC)!.samples24h, before);
    const detail = engine.views.symbol(RH_BTC, '24');
    assert.equal(detail.points.length, before);
    assert.equal(detail.venueName, 'Lighter RH');
    assert.deepEqual(detail.stats.map(item => item.regime), ['all']);
    assert.equal(detail.plans.length, 2);
    assert.equal(detail.trades.length, 0);
    assert.equal(engine.views.symbol('rh:BTC', '24').key, RH_BTC, '旧键照样能看');
    assert.throws(() => engine.views.symbol('BTC', '24'), /不是当前采集中的配对/);
    const bt = await engine.views.backtest({ symbol: 'rh:BTC', hours: 1 });
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
  } finally { engine.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('引擎重启：库里已启用的配对在目录与 Var 报价一到就订阅盘口，断线后写明原因', async () => {
  const { engine, sockets, dispose } = seededEngine(store => store.setState(SETTINGS_KEY, settings2({ [RH_BTC]: { ...DEFAULT_SYMBOL, enabled: true } }), T0));
  const rhDepth = () => engine.views.state().sources.venues.find(item => item.venue === 'rh')!.depth.map(item => [item.key, item.at, item.error]);
  try {
    engine.startStreams();
    const rh = sockets[0];
    rh.open();
    rh.push(RH_SNAPSHOT);
    assert.ok(!rh.sent.some(item => item.channel === 'order_book/1'), '目录到之前不知道市场编号');
    await engine.refreshCatalog(AbortSignal.timeout(1000), 'rh');
    assert.ok(!rh.sent.some(item => item.channel === 'order_book/1'), 'Var 报价到之前配对还没建好');
    await engine.pollVar(AbortSignal.timeout(1000));
    assert.deepEqual(rh.sent.filter(item => item.channel === 'order_book/1').map(item => item.type), ['subscribe']);
    assert.deepEqual(rhDepth(), [['rh:BTC', null, '等待盘口快照']]);
    rh.push({ type: 'subscribed/order_book', channel: 'order_book:1', order_book: { code: 0, bids: [{ price: '99.99', size: '100' }], asks: [{ price: '100.01', size: '100' }] } });
    assert.deepEqual(rhDepth(), [['rh:BTC', T0, null]]);
    // 断线：盘口失效，原因写明；保留上一份快照的时刻。
    rh.onclose?.({});
    assert.deepEqual(rhDepth(), [['rh:BTC', T0, '行情流未连接']]);
  } finally { dispose(); }
});

test('Entropy 盘口与市场状态：l2Book 推送算冲击并确认一档，换市场退订，断线清空', () => {
  let clock = T0;
  const sockets: FakeSocket[] = [];
  const stream = new HyperliquidStream({ connect: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; }, now: () => clock });
  try {
    stream.setMarkets(new Map([[0, 'io:SNDK'], [1, 'io:OAI']]));
    stream.setDepthMarkets(new Map([[0, 'io:SNDK']]));
    stream.start();
    const socket = sockets[0];
    socket.open();
    assert.deepEqual(socket.sent.filter(item => (item.subscription as { type: string }).type === 'l2Book'), [{ method: 'subscribe', subscription: { type: 'l2Book', coin: 'io:SNDK' } }]);
    assert.equal(stream.depthError(0), '等待盘口推送');
    assert.equal(stream.depthError(1), '未订阅盘口');
    const push = (coin: string, bid: string, ask: string) => socket.push({ channel: 'l2Book', data: { coin, time: clock, levels: [[{ px: bid, sz: '100', n: 1 }, { px: String(Number(bid) - 0.1), sz: '1000', n: 2 }], [{ px: ask, sz: '100', n: 1 }, { px: String(Number(ask) + 0.1), sz: '1000', n: 2 }]] } });
    push('io:SNDK', '99.9', '100.1');
    clock += 30_000;
    const book = stream.depth(0)!;
    assert.deepEqual([book.at, book.bid, book.ask], [clock, 99.9, 100.1], '连接在就是当前盘口');
    assert.deepEqual([Math.abs(book.ask1k! - 100.1) < 1e-9, book.ask100k! > 100.1], [true, true], '1k 在第一档内成交，100k 吃到第二档');
    assert.equal(stream.topAt(0, T0)?.bid, 99.9, '盘口推送也记一档');
    // 一档没变的推送 10 秒内不重复记。
    push('io:SNDK', '99.9', '100.1');
    clock += 1_000;
    push('io:SNDK', '99.9', '100.1');
    assert.equal((stream as unknown as { top: Map<number, unknown[]> }).top.get(0)!.length, 2);
    // 换盘口订阅：退订旧的、旧快照清掉。
    socket.sent.length = 0;
    stream.setDepthMarkets(new Map([[1, 'io:OAI']]));
    assert.deepEqual(socket.sent, [{ method: 'unsubscribe', subscription: { type: 'l2Book', coin: 'io:SNDK' } }, { method: 'subscribe', subscription: { type: 'l2Book', coin: 'io:OAI' } }]);
    assert.equal(stream.depth(0), null);
    push('io:OAI', '730', '731');
    assert.equal(stream.depth(1)?.bid, 730);
    socket.onclose?.({});
    assert.equal(stream.depth(1), null);
    assert.equal(stream.depthError(1), '行情流未连接');
  } finally { stream.close(); }
});

// ---- 审查补充（docs/reviews/2026-11-22-varlighter.md）----

test('持仓取价：100k 档缺盘口快照时退回 1k 档估算，超时与止损照常判断', () => {
  const params: SymbolParams = { ...DEFAULT_SYMBOL, notionalUsd: 5_000, maxHoldMinutes: 30, stopBps: 50 };
  const held = position(RH_BTC, { openedAt: T0, qty: 50, notionalUsd: 5_000, entrySpread: 25, entryRegime: 'all', aEntry: 100.25, bEntry: 100.02 });
  const now = sample(T0 + 5 * 60_000, 100.3);
  assert.equal(spreadOf(now, '100k'), null, '100k 档缺 B 腿盘口');
  const spread = positionSpread(now, held)!;
  assert.equal(spread.estimated, true);
  assert.deepEqual([spread.varSource, spread.prices.aAsk, spread.prices.bBid], ['100k', now.aAsk100k, now.bBid1k], '保留有深度那条腿的档位，只有缺盘口的一腿退小档');
  assert.equal(decide(now, null, params, held).kind, 'hold');
  const late = decide(sample(T0 + 31 * 60_000, 100.3), null, params, held);
  assert.equal(late.kind === 'close' && late.reason, 'timeout', '缺 100k 档也按时超时平仓');
  const crash = decide(sample(T0 + 6 * 60_000, 100.9), null, params, held);
  assert.equal(crash.kind === 'close' && crash.reason, 'stop');
  assert.equal(decide(now, null, params, null).kind, 'wait', '开仓仍要求该档完整报价');
});

test('持仓取档：1000 美元的仓市值漂过分档线仍按 1k 档平仓与止损，超出名义金额两成才按市值换档', () => {
  // 开仓后两腿各涨 0.3%：市值 1003 美元。B 腿 100k 档的冲击约 50 基点，1k 档 1 基点。
  const key = 'rh:NVDA|entropy:NVDA', params: SymbolParams = { ...DEFAULT_SYMBOL, stopBps: 50 };
  const held = position(key, { direction: 'a_cheap', openedAt: T0, qty: 10, notionalUsd: 1_000, entrySpread: -12, aEntry: 100, bEntry: 100.12 });
  const live = (aMid: number, bMid: number) => sample(T0 + 5_000, aMid, bMid, { symbol: key, aBidRx: aMid - 0.01, aAskRx: aMid + 0.01, aRxAt: T0 + 5_000,
    aBid100k: aMid - 0.05, aAsk100k: aMid + 0.05, bBid100k: bMid - 0.5, bAsk100k: bMid + 0.5 });
  const drifted = live(100.3, 100.42);
  assert.deepEqual([sizeBucket(1000.03, 1000), sizeBucket(1200, 1000), sizeBucket(1200.01, 1000), sizeBucket(999, 1100), sizeBucket(800, 1100)], ['1k', '1k', '100k', '100k', '1k']);
  const mark = positionSpread(drifted, held)!, exit = closeSpread(drifted, held)!;
  assert.deepEqual([mark.prices.aBid, mark.prices.bAsk, mark.estimated], [drifted.aBid1k, drifted.bAsk1k, false], '止损判断用 1k 档');
  assert.deepEqual([exit.prices.aBid, exit.prices.bAsk, exit.estimated], [drifted.aBid1k, drifted.bAsk1k, false], '平仓成交用 1k 档');
  assert.equal(decide(drifted, null, params, held).kind, 'hold', '1k 档浮亏约 4 基点');
  const wrong = targetSpread(drifted, { ...held, notionalUsd: 100_000, qty: 1_000 }, false)!.spread;
  assert.ok(markToMarket(held, wrong).pnlBps < -params.stopBps, '同一样本按 100k 档是约 −55 基点，会越过止损线');
  const trade = closePosition(held, drifted.t, exit, 'manual', { slippageBps: 0 }, null);
  assert.ok(Math.abs(trade.grossUsd - (drifted.aBid1k! - 100 + 100.12 - drifted.bAsk1k!) * 10) < 1e-9);
  // 真的亏到止损线照常止损；市值涨过两成（B 腿 125）才按 100k 档。
  const crash = decide(live(99.5, 100.42), null, params, held);
  assert.equal(crash.kind === 'close' && crash.reason, 'stop');
  const doubled = live(125, 125);
  assert.deepEqual([positionSpread(doubled, held)?.prices.bAsk, closeSpread(doubled, held)?.prices.bAsk], [doubled.bAsk100k, doubled.bAsk100k]);
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
  const store = openVarLighterStore(file);
  const engine = createVarLighterEngine({ store, fetchImpl, connect: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; }, now, log: options.log });
  return { dir, file, store, engine, sockets, dispose(keep = false) { engine.close(); if (!keep) rmSync(dir, { recursive: true, force: true }); } };
}

test('详情滑窗经过已落盘的未来报价时及时更新走势', async () => {
  let clock = T0;
  const fixture = seededEngine(store => { store.addSamples([sample(T0 - 10_000, 100), sample(T0 + 4_000, 101)]); }, { clock: () => clock });
  try {
    await fixture.engine.refreshCatalog(AbortSignal.timeout(1000), 'rh');
    await fixture.engine.pollVar(AbortSignal.timeout(1000));
    const before = fixture.engine.views.symbol(RH_BTC, 1);
    assert.ok(before.points.some(point => point.t === T0 - 10_000));
    assert.ok(!before.points.some(point => point.t > T0));
    clock += 4_000;
    assert.ok(fixture.engine.views.symbol(RH_BTC, 1).points.some(point => point.t === clock));
  } finally { fixture.dispose(); }
});

const RH_SNAPSHOT = { type: 'subscribed/market_stats', channel: 'market_stats:all', market_stats: { 1: { market_id: 1, best_bid_price: '99.99', best_ask_price: '100.01', mark_price: '100' } } };

test('失联配对：总览列出，可停用；保存的配对键有上限', async () => {
  const GONE = 'var:GONE|rh:GONE';
  const { engine, sockets, dispose } = seededEngine(store => {
    store.setState(SETTINGS_KEY, settings2({ [RH_BTC]: { ...DEFAULT_SYMBOL, enabled: true }, [GONE]: { ...DEFAULT_SYMBOL, enabled: true, cooldownMinutes: 120 } }), T0);
    store.addSamples([sample(T0 - 30 * 60_000, 100.1, 100, { symbol: GONE }), sample(T0 - 20 * 60_000, 100.1, 100, { symbol: RH_BTC })]);
    // v0.111.1 以前的模拟持仓留在库里，不再显示，也不让配对算作有持仓。
    store.savePosition(position(GONE));
  });
  try {
    assert.deepEqual(engine.views.state().orphans, [], '目录与 Var 报价还没取到时不判断');
    engine.startStreams();
    sockets[0].open();
    sockets[0].push(RH_SNAPSHOT);
    await engine.refreshCatalog(AbortSignal.timeout(1000), 'rh');
    await engine.pollVar(AbortSignal.timeout(1000));
    assert.deepEqual(engine.views.state().orphans, [{
      key: GONE, a: { venue: 'var', symbol: 'GONE', name: 'Var' }, b: { venue: 'rh', symbol: 'GONE', name: 'Lighter RH' }, venue: 'rh', venueName: 'Lighter RH', symbol: 'GONE',
      reason: '配对已不在目录里（或组合已关闭、手动配对已删除）', enabled: true, lastSampleAt: T0 - 30 * 60_000, position: null }]);
    assert.equal(engine.views.state().rows.find(row => row.key === RH_BTC)?.samples24h, 1, '近 24 小时计数含启动前的样本');
    const disabled = engine.views.settings({ revision: 3, symbols: { [GONE]: { ...DEFAULT_SYMBOL, enabled: false } } });
    assert.equal(disabled.symbols[GONE].enabled, false);
    assert.deepEqual(engine.views.state().orphans, [], '停用后不再列出');

    let revision = disabled.revision;
    for (let batch = 0; batch < 2; batch++) revision = engine.views.settings({ revision, symbols: Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`rh:K${batch}X${index}`, { ...DEFAULT_SYMBOL }])) }).revision;
    assert.deepEqual(code(() => engine.views.settings({ revision, symbols: Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`rh:K9X${index}`, { ...DEFAULT_SYMBOL }])) })), [400, 'too_many'], '保存的配对键有上限');
    assert.deepEqual(code(() => engine.views.settings({ revision, symbols: { 'not a key': { ...DEFAULT_SYMBOL } } })), [400, 'invalid_symbol']);
  } finally { dispose(); }
});

test('失联判定：规格改判、数据源连续正常 30 分钟仍无样本才算；Var 失败、目录未取到、行情流断开、刚重启都不算', async () => {
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
    const advance = (ms: number) => {
      time += ms; tick++;
      sockets[0].push({ type: 'update/market_stats', channel: 'market_stats:all', market_stats: { 1: { market_id: 1, mark_price: String(100 + tick * 0.0001) } } });
      // 订阅了盘口才收（没订阅的快照被忽略）。
      sockets[0].push({ type: 'subscribed/order_book', channel: 'order_book:1', order_book: { code: 0, bids: [{ price: '99.99', size: '1000' }], asks: [{ price: '100.01', size: '1000' }] } });
    };
    /** 按服务节奏每分钟拉一次 Var。 */
    const run = async (minutes: number) => { for (let index = 0; index < minutes; index++) { advance(60_000); await engine.pollVar(AbortSignal.timeout(1000)); } };
    return { engine, socket: sockets[0], advance, run };
  };
  const poll = (engine: ReturnType<typeof createVarLighterEngine>) => engine.pollVar(AbortSignal.timeout(1000));
  const reasons = (engine: ReturnType<typeof createVarLighterEngine>) => engine.views.state().orphans.map(row => row.reason);
  const NO_SAMPLE = '超过 30 分钟没有新样本（某腿无报价或盘口缺失）';
  try {
    const seed = openVarLighterStore(file);
    seed.setState(SETTINGS_KEY, settings2({ [RH_BTC]: { ...DEFAULT_SYMBOL, enabled: true, entryBps: 1, exitBps: 0, cooldownMinutes: COOLDOWN_MIN } }, { ...DEFAULT_GLOBAL, minSamples: 10, varFeeBps: 0, rhFeeBps: 0 }), T0);
    seed.addSamples(Array.from({ length: 12 }, (_, index) => sample(T0 - (75 - index * 5) * 60_000, 100.1)));
    seed.close();

    // 刚启动：库里最后样本 20 分钟前；Var 已拉到但场所目录未取到，也不算。
    const first = start();
    await poll(first.engine);
    assert.deepEqual(reasons(first.engine), [], '场所目录未取到不判断');
    await first.engine.refreshCatalog(AbortSignal.timeout(1000), 'rh');
    await first.run(11);
    assert.deepEqual(reasons(first.engine), [], '最后样本 31 分钟前，但数据源正常才 11 分钟');
    await first.run(20);
    assert.deepEqual(reasons(first.engine), [NO_SAMPLE], '数据源连续正常 31 分钟仍无样本：Var 有目录没报价');
    varFails = true; first.advance(4 * 60_000); await poll(first.engine);
    assert.deepEqual(reasons(first.engine), [], 'Var 拉取失败超过 3 分钟，整体故障不算单个配对失联');
    varFails = false; await poll(first.engine);
    assert.deepEqual(reasons(first.engine), [], 'Var 刚恢复，从恢复时刻重新计时');
    await first.run(31);
    assert.deepEqual(reasons(first.engine), [NO_SAMPLE], '恢复后 31 分钟仍无样本');
    first.socket.onclose?.({});
    assert.deepEqual(reasons(first.engine), [], '行情流断开不算');
    first.engine.close();

    // 停机很久后重启：第一轮 Var 报价早于行情流快照，没写入新样本，旧样本不算失联。
    time += 3_600_000; full = true;
    const restarted = start();
    await restarted.engine.refreshCatalog(AbortSignal.timeout(1000), 'rh');
    await poll(restarted.engine);
    assert.deepEqual([restarted.engine.views.state().sources.var.poll?.written, restarted.engine.views.state().sources.var.poll?.noTop], [0, 1], '第一轮没有新样本：报价时刻行情流还没有快照');
    assert.deepEqual(reasons(restarted.engine), [], '重启后第一轮');
    restarted.engine.close();

    // 规格改判：列出原因。
    varMark = '120';
    const mismatch = start();
    await mismatch.engine.refreshCatalog(AbortSignal.timeout(1000), 'rh');
    await poll(mismatch.engine);
    assert.deepEqual(reasons(mismatch.engine), ['两边价格相差超过 5%，已改判为规格不同']);
    mismatch.engine.close();
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

test('两腿行情流的配对：启用或有持仓的每 5 秒、其余每 20 秒按本机时刻采一条，两腿都要有一档；状态里有最近一轮', async t => {
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
  seed.setState(SETTINGS_KEY, settings2({ [LE_SNDK]: { ...DEFAULT_SYMBOL, enabled: true } }, { ...DEFAULT_GLOBAL, entropyFeeBps: null }, ['lighter|entropy']), T0);
  seed.setState(ENTROPY_FEE_DEFAULT_MIGRATED_KEY, { at: T0, applied: false }, T0);
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
    assert.deepEqual(entropy.sent, ['bbo', 'activeAssetCtx', 'l2Book'].map(type => ({ method: 'subscribe', subscription: { type, coin: 'io:SNDK' } })), '按配对用到的 Entropy 市场订阅一档与市场状态，有持仓的另订盘口');
    assert.ok(main.sent.some(item => item.type === 'subscribe' && item.channel === 'order_book/9'), '有持仓的 Lighter 腿订阅盘口');
    assert.deepEqual(engine.sampleLive(), { at: T0, due: 1, written: 0, noTop: 1, blocked: {} }, 'Entropy 还没有一档');
    const bbo = () => entropy.push({ channel: 'bbo', data: { coin: 'io:SNDK', bbo: [{ px: '100.09', sz: '1', n: 1 }, { px: '100.11', sz: '1', n: 1 }] } });
    bbo();
    assert.equal(engine.sampleLive().written, 1, '缺一档的那轮不算，下一次检查马上补采');
    const latest = store.latest(LE_SNDK)!;
    assert.deepEqual([latest.t, latest.receivedAt, latest.aBidRx, latest.bBidRx, latest.bMark, latest.bFunding, latest.ratio], [T0, T0, 99.99, 100.09, 100.1, 0.0000125, 1], '行情流还没有市场状态时用目录的标记价与资金费');
    entropy.push({ channel: 'activeAssetCtx', data: { coin: 'io:SNDK', ctx: { markPx: '100.12', oraclePx: '100.13', funding: '0.00002' } } });
    /** 拨到 at：两边各推一条消息再检查。 */
    const check = (at: number) => {
      clock = at;
      main.push({ type: 'update/market_stats', channel: 'market_stats:all', market_stats: { 9: { market_id: 9, mark_price: String(100 + (at - T0) / 1e9) } } });
      bbo();
      return engine.sampleLive();
    };
    assert.equal(check(T0 + 4_499).due, 0, '启用：5 秒一条（留半秒余量）');
    assert.deepEqual(engine.views.state().sources.live, { at: T0, due: 1, written: 1, noTop: 0, blocked: {} }, '没有配对到期的检查不顶掉状态里的最近一轮');
    assert.deepEqual([check(T0 + 4_500).due, engine.sampleLive().due], [1, 0]);
    assert.deepEqual([store.latest(LE_SNDK)!.bMark, store.latest(LE_SNDK)!.bIndex, store.latest(LE_SNDK)!.bFunding], [100.12, 100.13, 0.00002], '标记价、预言机价与资金费取行情流');
    let last = T0 + 4_500;
    engine.views.settings({ revision: 3, symbols: { [LE_SNDK]: { enabled: false } } });
    assert.equal(check(last + 19_499).due, 0, '没有持仓也没启用：20 秒一条');
    assert.equal(check(last + 19_500).written, 1);
    last += 19_500;
    engine.views.settings({ revision: 4, symbols: { [LE_SNDK]: { enabled: true } } });
    assert.equal(check(last + 4_499).due, 0);
    const stats = check(last + 4_500);
    assert.deepEqual(stats, { at: last + 4_500, due: 1, written: 1, noTop: 0, blocked: {} });
    const view = engine.views.state();
    assert.deepEqual(view.sources.live, stats);
    assert.deepEqual(view.sources.venues.map(item => [item.venue, item.enabled, item.pairs]), [['rh', false, 0], ['lighter', true, 1], ['entropy', true, 1]]);
    assert.equal(view.sources.var.enabled, false, '没有配对用到 Var');
    assert.equal(view.rows[0].bFeeBps, 6.75, 'Entropy 手续费按目录');
  } finally { engine.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('自动配置的推荐参数：入场取偏离 95 分位减半个往返成本、不低于保本加最低净利，止损随往返成本与入场，最长持有按半衰期', () => {
  const costs = { slippageBps: 1, minNetBps: 3, ...ZERO_FEES };
  assert.deepEqual(recommendParams({ costMedian: 8, deviation95: 30, halfLifeMin: 12 }, costs), { entryBps: 26, exitBps: 0, stopBps: 86, maxHoldMinutes: 72 });
  assert.deepEqual(recommendParams({ costMedian: 8, deviation95: 6, halfLifeMin: null }, costs), { entryBps: 11, exitBps: 0, stopBps: 41, maxHoldMinutes: 720 }, '偏离小：入场抬到 半个往返成本 4 + 滑点 4 + 最低净利 3');
  assert.equal(recommendParams({ costMedian: 8, deviation95: 6, halfLifeMin: 1 }, { ...costs, aFeeBps: 2, bFeeBps: 2 })!.entryBps, 19, '手续费计入保本线');
  assert.deepEqual(recommendParams({ costMedian: 0, deviation95: 1, halfLifeMin: 1 }, { slippageBps: 0, minNetBps: 0, ...ZERO_FEES }), { entryBps: 5, exitBps: 0, stopBps: 20, maxHoldMinutes: 60 }, '各项下限');
  assert.equal(recommendParams({ costMedian: 8, deviation95: 30, halfLifeMin: 500 }, costs)!.maxHoldMinutes, 1440);
  assert.equal(recommendParams({ costMedian: null, deviation95: 30, halfLifeMin: 12 }, costs), null, '没有可成交价时不给推荐');
  const gate = { openPositions: 0, openNotionalUsd: 0, dailyNetUsd: 0, cooldownUntil: 0, eligible: true };
  assert.equal(openBlocker(sample(T0, 100.3), { ...DEFAULT_SYMBOL, enabled: true }, DEFAULT_GLOBAL, { ...gate, autoPending: true }), AUTO_BLOCK);
  assert.equal(openBlocker(sample(T0, 100.3), { ...DEFAULT_SYMBOL, enabled: true }, DEFAULT_GLOBAL, gate), null);
});

test('自动配置：总览勾选即启用并按推荐参数运行，保存的参数留作手动值；推荐值 10 分钟重算、随成本参数即时变；样本不足时标出并不给推荐；列表只留有参数的键', async () => {
  let clock = T0;
  const wave = (count: number) => Array.from({ length: count }, (_, index) => sample(T0 - (count - index) * 60_000, 100 * (1 + (10 + 40 * Math.sin(index / 5)) / 1e4)));
  const global = { ...DEFAULT_GLOBAL, minSamples: 10 };
  const { file, dir, engine, sockets, dispose } = seededEngine(store => {
    store.setState(SETTINGS_KEY, { ...settings2({}, global), auto: [RH_BTC, 'var:NOPE|rh:NOPE', 7] }, T0);
    store.addSamples(wave(300));
  }, { clock: () => clock });
  try {
    engine.startStreams();
    sockets[0].open();
    sockets[0].push(RH_SNAPSHOT);
    await engine.refreshCatalog(AbortSignal.timeout(1000), 'rh');
    await engine.pollVar(AbortSignal.timeout(1000));
    const row = () => engine.views.state().rows.find(item => item.key === RH_BTC)!;
    assert.deepEqual(engine.views.state().settings.auto, [], '读回时丢掉没有保存参数的键与无效项');
    assert.deepEqual([row().enabled, row().auto, row().autoPending, row().entryBps], [false, false, false, DEFAULT_SYMBOL.entryBps]);
    const preview = engine.views.symbol(RH_BTC, 24).auto;
    assert.equal(preview.on, false, '没开自动配置时详情页也给出推荐值');
    assert.ok(preview.params !== null && preview.params.entryBps >= 25 && preview.params.entryBps <= 50, `入场 ${preview.params?.entryBps} 应接近偏离 95 分位`);

    assert.deepEqual(code(() => engine.views.settings({ revision: 3, auto: 'x' })), [400, 'invalid_body']);
    const saved = engine.views.settings({ revision: 3, symbols: { [RH_BTC]: { enabled: true } }, auto: [RH_BTC, 'rh:BTC', 'var:ETH|rh:ETH'] });
    assert.deepEqual(saved.auto, [RH_BTC], '旧写法的键规整、去重，没有保存参数的键不留');
    assert.deepEqual([row().enabled, row().auto, row().autoPending, row().entryBps, row().exitBps], [true, true, false, preview.params.entryBps, 0]);
    const view = engine.views.symbol(RH_BTC, 24);
    assert.deepEqual([view.params.entryBps, view.params.stopBps, view.params.maxHoldMinutes], [DEFAULT_SYMBOL.entryBps, DEFAULT_SYMBOL.stopBps, DEFAULT_SYMBOL.maxHoldMinutes], '保存的参数不变');
    assert.deepEqual({ entryBps: view.effective.entryBps, exitBps: view.effective.exitBps, stopBps: view.effective.stopBps, maxHoldMinutes: view.effective.maxHoldMinutes }, view.auto.params);
    assert.deepEqual([view.auto.on, view.auto.reason, view.auto.at, view.effective.notionalUsd, view.effective.cooldownMinutes], [true, null, T0, DEFAULT_SYMBOL.notionalUsd, DEFAULT_SYMBOL.cooldownMinutes]);

    clock = T0 + 10 * 60_000 - 1;
    assert.equal(engine.views.symbol(RH_BTC, 24).auto.at, T0, '10 分钟内沿用同一份统计');
    clock = T0 + 10 * 60_000;
    assert.equal(engine.views.symbol(RH_BTC, 24).auto.at, clock, '到点重算');
    const raised = engine.views.settings({ revision: saved.revision, global: { minNetBps: 200 } });
    const lifted = recommendParams({ costMedian: 0, deviation95: 0, halfLifeMin: null }, { ...raised.global, aFeeBps: row().aFeeBps ?? 0, bFeeBps: row().bFeeBps ?? 0 })!.entryBps;
    assert.ok(row().entryBps >= lifted && row().entryBps > preview.params.entryBps, `最低净利调高，入场线马上抬高（${row().entryBps}）`);
    const manual = engine.views.settings({ revision: raised.revision, auto: [] });
    assert.deepEqual([row().enabled, row().auto, row().entryBps], [true, false, DEFAULT_SYMBOL.entryBps], '关掉自动配置回到保存的参数，启用状态不变');
    const removed = engine.views.settings({ revision: manual.revision, auto: [RH_BTC], symbols: { [RH_BTC]: null } });
    assert.deepEqual(removed.auto, [], '参数删掉的配对不留在自动配置里');
  } finally { dispose(true); }
  const reopened = openVarLighterStore(file);
  try { assert.deepEqual(reopened.state<{ auto: string[] }>(SETTINGS_KEY)!.auto, []); } finally { reopened.close(); rmSync(dir, { recursive: true, force: true }); }

  const thin = seededEngine(store => {
    store.setState(SETTINGS_KEY, { ...settings2({ [RH_BTC]: { ...DEFAULT_SYMBOL, enabled: true } }, global), auto: [RH_BTC] }, T0);
    store.addSamples(wave(3));
  });
  try {
    thin.engine.startStreams();
    thin.sockets[0].open();
    thin.sockets[0].push(RH_SNAPSHOT);
    await thin.engine.refreshCatalog(AbortSignal.timeout(1000), 'rh');
    await thin.engine.pollVar(AbortSignal.timeout(1000));
    const row = thin.engine.views.state().rows.find(item => item.key === RH_BTC)!;
    assert.deepEqual([row.auto, row.autoPending, row.entryBps], [true, true, DEFAULT_SYMBOL.entryBps], '样本不足：标出，读数按保存的参数');
    const auto = thin.engine.views.symbol(RH_BTC, 24).auto;
    assert.deepEqual([auto.on, auto.params], [true, null]);
    assert.match(auto.reason!, /近期样本不足（\d+ \/ 10）/);
  } finally { thin.dispose(); }
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
    // 只开组合也查重：手动配对 RH↔主网 BTC 存在时不能打开 RH↔主网组合。
    const R = { a: { venue: 'rh', symbol: 'BTC' }, b: { venue: 'lighter', symbol: 'BTC' } };
    assert.equal(engine.views.settings({ revision: 1, pairs: [P, R] }).revision, 2);
    assert.deepEqual(code(() => engine.views.settings({ revision: 2, combos: [...engine.views.state().settings.combos, 'rh|lighter'] })), [400, 'duplicate_pair'], '只改组合也不能与手动配对同键');
    assert.equal(engine.views.settings({ revision: 2, pairs: [P] }).revision, 3);
    assert.deepEqual(code(() => engine.views.settings({ revision: 3, pairs: Array.from({ length: 101 }, () => P) })), [400, 'too_many']);
    assert.deepEqual(code(() => engine.views.settings({ revision: 3, pairs: [{ ...P, ratio: 0 }] })), [400, 'invalid_params']);
    assert.deepEqual(code(() => engine.views.settings({ revision: 3, symbols: { 'var:SNDK|rh:SNDK': { enabled: true } } })), [400, 'unknown_symbol'], 'RH 目录里没有 SNDK');
    assert.deepEqual(code(() => engine.views.settings({ revision: 3, symbols: { [P_KEY]: { enabled: true } } })), [400, 'unconfirmed']);
    assert.equal(engine.views.settings({ revision: 3, confirmed: [P_KEY], symbols: { [P_KEY]: { enabled: true } } }).revision, 4);
    assert.equal(row(P_KEY)!.eligible, true);
    // 乘数 1 的同一对两边标记价差七倍多：规格不同，不能启用。
    assert.equal(engine.views.settings({ revision: 4, pairs: [P, M] }).revision, 5);
    assert.equal(row(M_KEY)!.identity, 'mismatch');
    assert.deepEqual(code(() => engine.views.settings({ revision: 5, symbols: { [M_KEY]: { enabled: true } } })), [400, 'mismatch']);
    assert.deepEqual(code(() => engine.views.settings({ revision: 5, pairs: [M] })), [409, 'pair_busy'], '启用中的手动配对不能删');
    // 已启用的配对撤销确认：保存照常，开仓由 eligible 挡住。
    assert.equal(engine.views.settings({ revision: 5, confirmed: [] }).revision, 6);
    assert.deepEqual([row(P_KEY)!.identity, row(P_KEY)!.eligible], ['review', false]);
    // 目录价格变了，已启用的手动配对改判规格不同：无关的保存不被它卡住。
    oaiMark = '1000';
    await engine.refreshCatalog(AbortSignal.timeout(1000), 'entropy');
    assert.equal(row(P_KEY)!.identity, 'mismatch');
    const saved = engine.views.settings({ revision: 6, global: { minNetBps: 4 } });
    assert.deepEqual([saved.revision, saved.global.minNetBps, saved.symbols[P_KEY].enabled], [7, 4, true]);
    assert.deepEqual([row(P_KEY)!.identity, row(P_KEY)!.eligible], ['mismatch', false]);
  } finally { dispose(); }
});

test('代码别名：主网 ANTHROPIC 与 Entropy ANTH 自动配对；升级前已有的同键手动配对不挡无关保存，新加的同键手动配对拒绝', async () => {
  const fetchImpl = async (url: string) => {
    if (url.includes('orderBookDetails')) return Response.json({ code: 200, order_book_details: [{ symbol: 'ANTHROPIC', market_id: 193, market_type: 'perp', status: 'active', size_decimals: 3, price_decimals: 2, min_base_amount: '0.01', min_quote_amount: '10', taker_fee: '0', maker_fee: '0', mark_price: '1472.5' }] });
    if (url.includes('hyperliquid')) return Response.json([{ universe: [{ name: 'io:ANTH', szDecimals: 2, deployerFeeScale: '1', growthMode: 'enabled' }], collateralToken: 0 }, [{ markPx: '1471.4' }]]);
    return Response.json({ listings: [] });
  };
  const KEY = 'lighter:ANTHROPIC|entropy:ANTH';
  const A = { a: { venue: 'lighter', symbol: 'ANTHROPIC' }, b: { venue: 'entropy', symbol: 'ANTH' } };
  const old = seededEngine(store => store.setState(SETTINGS_KEY, { ...settings2({}, DEFAULT_GLOBAL, ['lighter|entropy']), pairs: [{ ...A, ratio: 1, kind: 'private', note: '' }] }, T0), { fetchImpl });
  try {
    await old.engine.refreshCatalog(AbortSignal.timeout(1000), 'lighter');
    await old.engine.refreshCatalog(AbortSignal.timeout(1000), 'entropy');
    const row = old.engine.views.state().rows.find(item => item.key === KEY)!;
    assert.deepEqual([row.custom, row.identity, row.symbol], [false, 'review', 'ANTHROPIC / ANTH'], '自动配对优先');
    assert.equal(old.engine.views.settings({ revision: 3, global: { minNetBps: 4 } }).revision, 4, '升级前就有的同键手动配对不挡无关保存');
    assert.equal(old.engine.views.settings({ revision: 4, combos: [] }).revision, 5, '关掉组合照常');
    assert.deepEqual(code(() => old.engine.views.settings({ revision: 5, combos: ['lighter|entropy'] })), [400, 'duplicate_pair'], '关掉后再开组合要先删手动配对');
    assert.equal(old.engine.views.settings({ revision: 5, combos: ['lighter|entropy'], pairs: [] }).revision, 6, '删手动配对同时开组合');
    assert.deepEqual(code(() => old.engine.views.settings({ revision: 6, pairs: [A] })), [400, 'duplicate_pair'], '删掉后不能再按同键加回');
  } finally { old.dispose(); }
  // 遗留手动配对已启用：删掉它由自动配对接管，不报 pair_busy。
  const busy = seededEngine(store => store.setState(SETTINGS_KEY, { ...settings2({ [KEY]: { ...DEFAULT_SYMBOL, enabled: true } }, DEFAULT_GLOBAL, ['lighter|entropy']), confirmed: [KEY], pairs: [{ ...A, ratio: 1, kind: 'private', note: '' }] }, T0), { fetchImpl });
  try {
    assert.equal(busy.engine.views.settings({ revision: 3, pairs: [] }).revision, 4);
    assert.equal(busy.engine.views.state().settings.symbols[KEY]?.enabled, true, '启用参数保留');
  } finally { busy.dispose(); }
});

test('腿数上限：升级前留下的超额状态不挡无关保存，只挡让腿变多的保存', () => {
  const symbols = Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`var:S${index}|rh:S${index}`, { ...DEFAULT_SYMBOL, enabled: true }]));
  const { engine, dispose } = seededEngine(store => store.setState(SETTINGS_KEY, settings2(symbols), T0));
  try {
    const saved = engine.views.settings({ revision: 3, global: { minNetBps: 4 } });
    assert.equal(saved.revision, 4, '只改全局参数照常保存');
    assert.deepEqual(code(() => engine.views.settings({ revision: 4, symbols: { 'var:S11|rh:S11': { enabled: true } } })), [400, 'too_many'], '再多一条 RH 腿被挡');
    assert.equal(engine.views.settings({ revision: 4, symbols: { 'var:S10|rh:S10': { enabled: false } } }).revision, 5, '减少照常');
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
    assert.equal(sleepers.size, 2, '目录请求挂着时循环照常进入下一轮等待（不被请求拖住，行情流采样照常检查）');
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
  const views: { varlighter?: ReturnType<typeof localDexForward> } = {};
  const lines: string[] = [];
  const server = createExecutorServer({ executor: h.ex, accessToken: 'vl-token-000001', session: 'vl-session-000001', views, log: line => lines.push(line),
    readTokens: createReadTokens({ dir, now: Date.now, log: () => {} }), tokenThrottle: () => new LoginThrottle(Date.now) });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const stderr = process.stderr.write;
  const KEY = encodeURIComponent(RH_BTC);
  const writer = openVarLighterStore(path.join(dir, 'varlighter.sqlite'));
  try {
    const cookie = ((await fetch(`${base}/login?token=vl-token-000001`, { redirect: 'manual' })).headers.get('set-cookie') ?? '').split(';')[0]!;
    const get = (route: string, headers: Record<string, string> = { cookie }) => fetch(base + route, { headers });
    const post = (route: string, body: unknown, headers: Record<string, string> = { cookie, 'content-type': 'application/json', 'x-pa-executor': '1' }) => fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal((await get('/api/varlighter/state')).status, 404, '模块关闭');
    views.varlighter = localDexForward(varLighterViews(holder));
    assert.equal((await get('/api/varlighter/state', {})).status, 401);
    assert.equal((await get('/api/varlighter/state')).status, 200);
    assert.equal((await post('/api/varlighter/settings', { revision: 0 }, { cookie, 'content-type': 'application/json' })).status, 403, '缺页面请求标记');
    // v0.112.0 去掉了模拟盘：旧的查看、平仓与清空接口都不在了。
    for (const route of ['/api/varlighter/paper/close', '/api/varlighter/paper/reset']) assert.equal((await post(route, { symbol: RH_BTC })).status, 404, route);
    assert.equal((await get('/api/varlighter/paper')).status, 404);
    const generated = await post('/api/read-token/generate', { name: 'test', scopes: ['public', 'system', 'portfolio'] });
    assert.equal(generated.status, 200);
    const token = (await generated.json() as { token: string }).token;
    const bearer = { authorization: `Bearer ${token}` };
    // docs/mcp.md 8.3: the token reads the module and its samples, never a POST (the backtest included).
    for (const route of ['/api/varlighter/state', '/api/varlighter/readiness', `/api/varlighter/samples?symbol=${KEY}`, '/api/varlighter/samples?symbol=rh:BTC']) assert.equal((await get(route, bearer)).status, 200, route);
    for (const route of ['/api/varlighter/backtest', '/api/varlighter/settings', '/api/varlighter/live/close']) {
      assert.equal((await post(route, { confirm: 'RESET' }, { ...bearer, 'content-type': 'application/json', 'x-pa-executor': '1' })).status, 403, `只读令牌不能 POST ${route}`);
    }
    assert.equal((await get(`/api/varlighter/samples?symbol=${KEY}&extra=1`, bearer)).status, 403, '多余参数');
    // The sample export: pages after a cursor, oldest first, columns in SAMPLE_FIELDS order.
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
    // 新增时间和数量证据后，长小数的千行可能超过 512 KiB；按游标续页可读完且不丢样本。
    writer.addSamples(Array.from({ length: 1000 }, (_, index) => sample(T0 + index * 60_000, 104523.123456789, 104520.987654321, { symbol: 'var:ETH|lighter:ETH',
      aBid100k: 104523.0712345, aAsk100k: 104523.1912345, bBid100k: 104520.9112345, bAsk100k: 104521.0612345, aBidTk: 104523.1012345, aAskTk: 104523.1512345, aTkAt: T0 + index * 60_000 - 1234 })));
    const full = await get(`/api/varlighter/samples?symbol=${encodeURIComponent('var:ETH|lighter:ETH')}`, bearer);
    assert.equal(full.status, 200);
    const fullText = await full.text(), fullBytes = Buffer.byteLength(fullText);
    const packed = JSON.parse(fullText) as SamplesView;
    assert.ok(packed.next !== null && packed.rows.length < 1000, '较大样本按实际字节提前分页');
    const tail = await page(`symbol=${encodeURIComponent('var:ETH|lighter:ETH')}&after=${packed.next}`);
    assert.deepEqual([packed.rows.length + tail.rows.length, tail.next], [1000, null]);
    assert.ok(fullBytes < READ_TOKEN_MAX_BYTES * 0.95, `1000 行 ${fullBytes} 字节`);
    views.varlighter = localDexForward({ ...varLighterViews(holder), state: () => { throw new Error('secret /path/inside'); } });
    const written: string[] = [];
    process.stderr.write = ((chunk: string) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
    const failed = await get('/api/varlighter/state');
    process.stderr.write = stderr;
    assert.equal(failed.status, 500);
    assert.doesNotMatch(await failed.text(), /secret/);
    assert.ok(written.some(line => line.includes('secret')), '原文只进服务端日志');
  } finally {
    process.stderr.write = stderr;
    writer.close();
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
  const quoteQty = (notionalUsd: number, price: number) => varQuoteQty({ notionalUsd }, 'a', 1, price);
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
  let pushed = { token: '', problem: '' };
  const save = (token: string, revision: number) => {
    pushed = { token, problem: '' };
    writeFileSync(file, JSON.stringify({ version: 1, revision, token, updatedAt: new Date(T0).toISOString() }), { mode: 0o600 });
  };
  let clock = T0;
  const sent: { url: string; cookie: string; body: unknown }[] = [];
  let reply: () => Response | Promise<Response> = () => new Response('{}');
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), cookie: String((init?.headers as Record<string, string>).Cookie), body: JSON.parse(String(init?.body)) });
    return reply();
  };
  const good = (extra: Record<string, unknown> = {}) => Response.json({ instrument: varInstrument('crypto', 'BTC'), qty: '9.98', bid: '100.19', ask: '100.21', mark_price: '100.2', timestamp: new Date(clock - 400).toISOString(), ...extra });
  // DEX 服务使用内存推送。Windows 没有 POSIX 0600，Linux 同时走真实的文件来源。
  const quoter = createVarQuoter({ dir, source: process.platform === 'win32' ? () => pushed : undefined, fetcher: fetcher as typeof fetch, now: () => clock });
  const ask = () => quoter.quote('crypto', 'BTC', '9.98', AbortSignal.timeout(1000));
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
    await assert.rejects(quoter.quote('other', 'XYZ', '100', AbortSignal.timeout(1000)), /格式未确认/);
    await assert.rejects(quoter.quote('crypto', 'BTC', '0', AbortSignal.timeout(1000)), /询价数量无效/);
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
    await assert.rejects(quoter.quote('crypto', 'BTC', '9.98', stopped.signal));
    assert.deepEqual([quoter.view().status, quoter.view().error, quoter.wants('crypto', 'BTC')], ['ready', null, true]);
    // 传输用的信号中止了（引擎的阶段时限）而调用方自己的没中止：按超时记失败，标的暂停，原因带标的代码。
    await assert.rejects(quoter.quote('crypto', 'BTC', '9.98', stopped.signal, new AbortController().signal), /BTC：Variational 请求超时/);
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
    pushed = { token: '', problem: '推送的 token 无法读取或内容无效' };
    assert.deepEqual([quoter.usable(), quoter.view().status], [false, 'missing']);
    assert.match(quoter.view().error ?? '', /无法读取或内容无效/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('按实际数量选择 Var 询价：复核与持仓成交共用，其他金额、时间或数量缺证时用公共档', () => {
  const base = sample(T0, 100.3, 100, { bBidRx: 100.04, bAskRx: 100.06, aTkAt: T0 + 900, aTkReceivedAt: T0 + 950, aTkQty: 9.97 });
  const params = { ...DEFAULT_SYMBOL, enabled: true, entryBps: 10, exitBps: 0 };
  const token = { ...base, aBidTk: 100.25, aAskTk: 100.27 };
  const fill = (item: Sample, notionalUsd = 1000) => targetSpread(item, { notionalUsd }, true)?.spread;
  assert.deepEqual([fill(token)?.prices.aBid, fill(token)?.varQtyA, fill(token)?.varSource], [100.25, 9.97, 'token']);
  for (const extra of [{ aBidTk: null }, { aAskTk: 100.2 }, { aTkQty: null }, { aTkQty: 10 }, { aTkAt: null }, { aTkReceivedAt: null }]) {
    assert.equal(fill({ ...token, ...extra })?.varSource, '1k');
  }
  assert.equal(fill({ ...token, bBidRx: null }), undefined);
  const large = fill({ ...token, bBid100k: 99.9, bAsk100k: 100.1 }, 100_000)!;
  assert.deepEqual([large.prices.aBid, large.varSource, large.varQtyA], [base.aBid100k, '100k', undefined]);

  const baseline = { regime: 'all' as const, median: 0, sigma: 2, samples: 500, since: T0, fallback: false };
  const decision = decide(base, baseline, params, null);
  assert.ok(decision.kind === 'open');
  assert.equal(confirmOpen({ ...token, aBidTk: 100.11, aAskTk: 100.13 }, baseline, params, decision, 30), DECAYED);
  const confirmed = confirmOpen(token, baseline, params, decision, 30);
  assert.ok(typeof confirmed !== 'string');
  const held = openPosition('p1', token, params, confirmed, baseline, ZERO_FEES);
  assert.deepEqual([held.aEntry, held.qty, held.entryVarSource], [100.25, 9.97, 'token']);
  const wide = { ...decision, spread: { ...decision.spread, buyA: decision.spread.sellA + 70 } };
  assert.equal(openEconomics(confirmed, params, COSTS, wide).costBps, 70);
  const later = sample(T0 + 60_000, 100, 100, { aBidTk: 100.02, aAskTk: 100.04, aTkQty: held.qty, aTkAt: T0 + 60_500, aTkReceivedAt: T0 + 60_800 });
  const trade = closePosition(held, later.t, closeSpread(later, held)!, 'manual', { slippageBps: 1 }, null);
  assert.deepEqual([trade.aExit, trade.exitVarSource], [100.04, 'token']);
  assert.equal(closeSpread({ ...later, aTkQty: 10 }, held)?.varSource, '1k');

  // A 便宜方向：询价数量 10.1（1000 ÷ 99 取四位有效数字），对冲腿市值 1010 美元，仍按名义金额的 1k 档成交（B 腿没有 100k 档盘口）。
  const cheap = sample(T0, 99, 100, { bBidRx: 99.99, bAskRx: 100.01, aBidTk: 98.99, aAskTk: 99.01, aTkQty: 10.1, aTkAt: T0 + 900, aTkReceivedAt: T0 + 950 });
  const cheapSignal = decide(cheap, baseline, params, null);
  assert.ok(cheapSignal.kind === 'open' && cheapSignal.direction === 'a_cheap');
  const hedged = confirmOpen(cheap, baseline, params, cheapSignal, 30);
  assert.ok(typeof hedged !== 'string', `对冲腿不应因市值略过 1000 美元被挡：${String(hedged)}`);
  assert.deepEqual([hedged.spread.varQtyA, hedged.spread.varSource, hedged.spread.estimated], [10.1, 'token', false]);
  assert.ok(Math.abs(hedged.spread.prices.bBid - 99.98) < 1e-9, 'B 腿按 1k 档的冲击成交');
});

test('逐腿决策年龄：Var 在任一侧，对手一档和公开价的时效都含等待，边界等于上限可用', () => {
  const params = { ...DEFAULT_SYMBOL, enabled: true, entryBps: 10 };
  const baseline = { regime: 'all' as const, median: 0, sigma: 2, samples: 10, since: T0, fallback: false };
  for (const venue of ['rh', 'lighter', 'entropy']) for (const varSide of ['a', 'b'] as const) {
    const liveSide = varSide === 'a' ? 'b' : 'a';
    const base = sample(T0, varSide === 'a' ? 101 : 99, 100, {
      symbol: varSide === 'a' ? `var:BTC|${venue}:BTC` : `${venue}:BTC|var:BTC`,
      receivedAt: T0 + 29_000, decisionAt: T0 + 30_000, aAt: T0, bAt: T0,
      [`${liveSide}BidRx`]: liveSide === 'a' ? 98.99 : 99.99, [`${liveSide}AskRx`]: liveSide === 'a' ? 99.01 : 100.01,
      [`${liveSide}RxAt`]: T0 + 29_500,
    });
    const decision = decide(base, baseline, params, null);
    assert.ok(decision.kind === 'open');
    const check = (extra: Partial<Sample>) => confirmOpen({ ...base, ...extra }, baseline, params, decision, 30);
    assert.notEqual(typeof check({}), 'string');
    assert.equal(check({ decisionAt: T0 + 30_001 }), STALE_QUOTE);
    assert.equal(check({ [`${liveSide}RxAt`]: T0 - 1 }), STALE_QUOTE);
    assert.equal(check({ [`${liveSide}RxAt`]: null }), NO_QUOTE_TIME);
    const mark = base[`${varSide}Mark`]!;
    const token = { decisionAt: T0 + 37_000, [`${varSide}BidTk`]: mark - 0.01, [`${varSide}AskTk`]: mark + 0.01,
      [`${varSide}TkQty`]: Number(varQuoteQty(params, varSide, 1, mark)), [`${varSide}TkAt`]: T0 + 36_000, [`${varSide}TkReceivedAt`]: T0 + 36_500 };
    assert.notEqual(typeof check(token), 'string', '有效询价的来源时间独立于旧的公开价');
    assert.equal(check({ ...token, [`${varSide}TkQty`]: 12345 }), STALE_QUOTE, '数量不对改用公开价，时效也必须改用公开来源');
    assert.equal(check({ ...token, [`${liveSide}RxAt`]: T0 }), STALE_QUOTE, '新鲜 token 不能盖住另一腿的旧盘口');
  }
});

test('Var 为 B 且乘数为 2：1k/100k 回放分别成交，按持仓实际单位估值、平仓，仓位大于公开档时标估算', () => {
  const key = 'entropy:COIN|var:BTC@2', global = { ...DEFAULT_GLOBAL, minSamples: 10, maxTotalNotionalUsd: 100_000, minNetBps: 0 };
  const params = { ...DEFAULT_SYMBOL, entryBps: 25, exitBps: 2, stopBps: 1500, cooldownMinutes: 0 };
  const row = (i: number, a: number, extra: Partial<Sample> = {}) => {
    const t = T0 + i * 60_000;
    return sample(t, a, 50, { symbol: key, ratio: 2, aBidRx: a - 0.01, aAskRx: a + 0.01, aRxAt: t + 800,
      bAt: t, bBidRx: null, bAskRx: null, bRxAt: null, bBid100k: 49.8, bAsk100k: 50.2,
      bBidTk: 49.99, bAskTk: 50.01, bTkQty: 20, bTkAt: t + 600, bTkReceivedAt: t + 750, ...extra });
  };
  const warm = Array.from({ length: 10 }, (_, i) => row(i, 100));
  const spike = row(10, 103), held = row(11, 102, { bMark: 55, bBidTk: 49.95, bAskTk: 50.05 });
  const end = row(12, 100, { bMark: 55, bBidTk: 49.95, bAskTk: 50.05 });
  const run = (more: Sample[], notionalUsd: number) => runBacktest(key, 'crypto', [...warm, spike, ...more], spike.t, more.at(-1)?.t ?? spike.t, { ...params, notionalUsd }, global, ZERO_FEES);
  const small = run([held], 1000), large = run([held], 100_000);
  assert.deepEqual([small.open?.qty, small.open?.bEntry, small.open?.entryVarSource, small.summary.openMarkVarSource], [10, 100.02, 'token', 'token']);
  assert.deepEqual([large.open?.qty, large.open?.bEntry, large.open?.entryVarSource, large.summary.openMarkVarSource], [1000, 100.4, '100k', '100k']);
  assert.equal(small.summary.openMarkUsd, closePosition(small.open!, held.t, closeSpread(held, small.open!)!, 'manual', global, null).netUsd);
  const mismatched = run([{ ...held, bTkQty: 2000, bBidTk: 1, bAskTk: 2000 }], 1000);
  assert.equal(mismatched.summary.openMarkVarSource, '1k');
  const trade = run([held, end], 1000).trades[0];
  assert.deepEqual([trade.direction, trade.reason, trade.bExit, trade.exitVarSource, trade.qty], ['a_rich', 'revert', 99.9, 'token', 10]);
  assert.equal(trade.grossUsd, (trade.aEntry - trade.aExit + trade.bExit - trade.bEntry) * trade.qty);
  const changed = { ...end, bBid0: 119.9, bAsk0: 120.1, bBid100k: 119, bAsk100k: 121, bTkQty: null };
  assert.deepEqual([closeSpread(changed, small.open!)?.varSource, closeSpread(changed, large.open!)?.estimated], ['100k', true]);
  assert.equal(varQuoteQty({ notionalUsd: 1000, qty: 1.234567891 }, 'b', 2, 60), null, '历史持仓不能按八位小数精确询价时改用公共档');
});

test('缺决策盘口的全空和前缀、旧采样与升级混合窗口按逐行证据重放', () => {
  const rows = oscillating(121), params = { ...DEFAULT_SYMBOL, entryBps: 15, exitBps: 2, cooldownMinutes: 0 }, global = { ...DEFAULT_GLOBAL, minSamples: 10 };
  const noTop = (s: Sample) => ({ ...s, bBidRx: null, bAskRx: null, bRxAt: null });
  const run = (input: Sample[], from = rows[11].t) => runBacktest(RH_BTC, 'crypto', input, from, rows[90].t, params, global, ZERO_FEES);
  const allMissing = run(rows.map(noTop));
  assert.deepEqual([allMissing.trades.length, allMissing.summary.blocked[NO_LIVE_TOP]], [0, 3]);
  const mixed = rows.map((s, i): Sample => i < 30 ? { ...noTop(s), captureKind: 'aligned', decisionAt: null }
    : i < 60 ? { ...noTop(s), captureKind: null, decisionAt: null } : i < 80 ? noTop(s) : s);
  const a = run(mixed.slice(0, 91)), b = run(mixed), onlyFaults = run(mixed.slice(30), rows[41].t);
  assert.deepEqual([a.trades.length, a.trades[0].estimated, a.summary.alignedOpens, a.summary.unknownDecisionSamples, a.summary.blocked[NO_QUOTE_TIME], a.summary.blocked[NO_LIVE_TOP]], [1, true, 1, 30, 1, 1]);
  assert.deepEqual(a.summary, b.summary, '窗口尾部出现正常盘口不改变前缀');
  assert.deepEqual(onlyFaults.summary.blocked, a.summary.blocked, '去掉已证明旧版的行，缺证行的准入保持一致');
});

test('早期两腿库重复升级保留 Var 为 B 的旧值且不补造询价量，旧版按原列可继续插入', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tp-legs-schema-')), file = path.join(dir, 'varlighter.sqlite');
  const key = 'entropy:COIN|var:BTC@2', oldSample = sample(T0, 100, 50, { symbol: key, ratio: 2, aBidRx: 99.99, aAskRx: 100.01,
    bBidRx: null, bAskRx: null, bBidTk: 45, bAskTk: 55, bTkAt: T0 + 500 });
  try {
    const seed = openVarLighterStore(file);
    try { seed.addSamples([oldSample]); } finally { seed.close(); }
    const legacy = new DatabaseSync(file);
    try {
      for (const column of ['decision_at', 'capture_kind', 'a_rx_at', 'b_rx_at', 'a_tk_qty', 'b_tk_qty', 'a_tk_received_at', 'b_tk_received_at']) {
        legacy.exec(`ALTER TABLE leg_samples DROP COLUMN ${column}`);
      }
    } finally { legacy.close(); }
    for (let round = 0; round < 2; round++) {
      const store = openVarLighterStore(file);
      try {
        const first = store.samplesAfter(key, 0, 1)[0];
        assert.deepEqual([first.symbol, first.bTkAt, first.bBidTk, first.bTkQty, first.captureKind, first.decisionAt], [key, T0 + 500, 45, null, null, null]);
        assert.equal(closeSpread(first, position(key, { ratio: 2, qty: 10 }))?.varSource, '1k', '旧报价缺数量，平仓取公共档');
        if (round === 0) {
          const oldWriter = new DatabaseSync(file);
          try { oldWriter.prepare("INSERT INTO leg_samples(symbol,t,received_at,regime,ratio,a_at,a_bid0,a_ask0,b_at,b_bid0,b_ask0) VALUES (?,?,?,'all',2,?,99.9,100.1,?,49.9,50.1)").run(key, T0 + 100, T0 + 101, T0, T0); }
          finally { oldWriter.close(); }
        }
        assert.deepEqual([store.latest(key)!.captureKind, store.latest(key)!.decisionAt], [null, null]);
      } finally { store.close(); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
        const before = store.samples(RH_BTC, 1000, 1500)[0];
        assert.deepEqual([before.bBidRx, before.aBidTk, before.aAskTk, before.aTkAt, before.captureKind, before.bRxAt, before.decisionAt], [99.96, null, null, null, null, null, null]);
        if (round === 0) assert.equal(store.addSamples([sample(5000, 100.2, 100, { aBidTk: 100.18, aAskTk: 100.22, aTkAt: 5900 })]), 1);
        const latest = store.latest(RH_BTC)!;
        assert.deepEqual([latest.aBidTk, latest.aAskTk, latest.aTkAt], [100.18, 100.22, 5900]);
      } finally { store.close(); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('引擎接 Var 询价：只给已启用的配对询价，询价记进样本；询价失败、过旧或没有 token 时样本不带询价', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tp-varlighter-'));
  let clock = T0, varMid = 100.2, tick = 0, publicAge = 2000, tokenWait = 0;
  const sockets = new Map<string, FakeSocket>();
  const market = (symbol: string, id: number) => ({ symbol, market_id: id, market_type: 'perp', status: 'active', size_decimals: 4, price_decimals: 2, min_base_amount: '0.001', min_quote_amount: '10', taker_fee: '0', maker_fee: '0', mark_price: '100' });
  const fetchImpl = async (url: string) => {
    if (url.includes('orderBookDetails')) return Response.json({ code: 200, order_book_details: [market('BTC', url.includes('api.rh.lighter.xyz') ? 1 : 7)] });
    if (url.includes('orderBookOrders')) return Response.json({ code: 200, bids: [{ price: '99.99', remaining_base_amount: '100' }], asks: [{ price: '100.01', remaining_base_amount: '100' }] });
    return Response.json({ listings: [{ ticker: 'BTC', name: 'Bitcoin', mark_price: String(varMid), funding_rate: '0.1', funding_interval_s: 28800,
      quotes: { updated_at: new Date(clock - publicAge).toISOString(), base: { bid: String(varMid - 0.01), ask: String(varMid + 0.01) }, size_1k: { bid: String(varMid - 0.02), ask: String(varMid + 0.02) } } }] });
  };
  // 询价替身：tokenMid 为 null 时跟公开价；mode 决定这一轮的表现。
  const asked: [string, string, string][] = [];
  let usable = true, tokenMid: number | null = null, mode: 'ok' | 'fail' | 'timeout' | 'stale' = 'ok';
  const skipped = new Set<string>();
  const quoter: VarQuoter = {
    usable: () => usable,
    wants: (kind, symbol) => kind === 'crypto' && !skipped.has(symbol),
    async quote(kind, symbol, qty, phase, stop) {
      asked.push([kind, symbol, qty]);
      if (tokenWait) {
        clock += tokenWait;
        sockets.get('rh')!.push(RH_SNAPSHOT);
      }
      if (mode === 'timeout') {
        t.mock.timers.tick(TOKEN_QUOTE_PHASE_MS);
        assert.deepEqual([phase.aborted, stop?.aborted], [true, false], '阶段时限生效，调用方仍在运行');
        phase.throwIfAborted();
      }
      if (mode === 'fail') throw new Error('Variational 暂不可用，请稍后重试。');
      const mid = tokenMid ?? varMid;
      return { bid: mid - 0.005, ask: mid + 0.005, mark: mid, qty: Number(qty), at: clock - (mode === 'stale' ? TOKEN_QUOTE_MAX_AGE_MS + 1 : 300), receivedAt: clock };
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
    const book = { code: 0, bids: [{ price: '99.99', size: '100' }], asks: [{ price: '100.01', size: '100' }] };
    sockets.get('rh')!.push({ type: 'subscribed/order_book', channel: 'order_book:1', order_book: book });
    sockets.get('lighter')!.push({ type: 'subscribed/order_book', channel: 'order_book:7', order_book: book });
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
    assert.deepEqual(asked, [['crypto', 'BTC', '9.98']], '只询已启用的 RH 配对，数量按它的名义金额与公开标记价');
    assert.deepEqual([poll.tokenOk, poll.tokenFailed], [1, 0]);
    let latest = store.latest(RH_BTC)!;
    assert.deepEqual([latest.aBidTk, latest.aAskTk, latest.aTkAt], [100.2 - 0.005, 100.2 + 0.005, clock - 300]);
    assert.equal(store.latest(LIGHTER_BTC)!.aBidTk, null, '没启用的配对样本不带询价');
    for (let index = 0; index < 11; index++) await minute();

    // 询价失败或到阶段时限：这一轮的样本不带询价，统计里记失败；判断时刻照常落盘。
    varMid = 100.5; publicAge = 29_000; tokenWait = 8_000; mode = 'fail';
    poll = await minute();
    latest = store.latest(RH_BTC)!;
    assert.deepEqual([poll.tokenFailed, latest.receivedAt - latest.t, latest.decisionAt! - latest.t, latest.bRxAt, latest.aTkQty], [1, 29_000, 37_000, clock, null]);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      mode = 'timeout';
      poll = await minute();
      assert.equal(poll.tokenFailed, 1, '真实阶段定时器触发后照常采样');
    } finally { t.mock.timers.reset(); }
    tokenWait = 0; mode = 'ok';
    // 公开报价与询价都冲高：Var 配对只采集，不上实盘，询价记进样本供回测。
    tokenMid = 100.47;
    await minute();
    const sampled = store.latest(RH_BTC)!;
    assert.deepEqual([engine.views.state().trading.open, sampled.aTkQty, sampled.aTkReceivedAt], [0, Number(asked.at(-1)![2]), clock]);
    const replay = await engine.views.backtest({ symbol: RH_BTC, hours: 2 });
    assert.ok(replay.summary.blocked[STALE_QUOTE] >= 1, '回测按落盘的判断时刻还原报价过旧');
    publicAge = 2_000;
    varMid = 100.2; tokenMid = null;

    // 询价失败：这一轮的样本不带询价，统计里记失败。
    tokenMid = null; mode = 'fail';
    poll = await minute();
    assert.deepEqual([poll.tokenOk, poll.tokenFailed], [0, 1]);
    assert.equal(store.latest(RH_BTC)!.aBidTk, null);
    // 询价的报价时刻过旧：不用。
    mode = 'stale';
    poll = await minute();
    assert.deepEqual([poll.tokenOk, store.latest(RH_BTC)!.aBidTk], [1, null]);
    // 没有可用 token：一个请求也不发。
    mode = 'ok'; usable = false;
    const before = asked.length;
    poll = await minute();
    assert.equal(asked.length, before);
    assert.deepEqual([poll.tokenOk, poll.tokenFailed], [0, 0]);
    assert.equal(store.latest(RH_BTC)!.aBidTk, null);
    // 有了 token 继续询价；只有上一轮要询的都询到，就绪项才按询价的延迟算。
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

test('已提交样本只推进一次：重取同一时刻不重记，重启预热后基线相同；样本写失败时游标不前进，原报价可重试', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tp-decision-')), file = path.join(dir, 'varlighter.sqlite');
  const eth = 'var:ETH|rh:ETH', keys = [RH_BTC, eth], signal = new AbortController().signal;
  const settings = settings2(Object.fromEntries(keys.map(key => [key, { ...DEFAULT_SYMBOL, enabled: true, cooldownMinutes: 0 }])), { ...DEFAULT_GLOBAL, minSamples: 10 });
  let clock = T0, quoteAt = T0, ethMid = 100;
  const snapshot = { type: 'subscribed/market_stats', channel: 'market_stats:all', market_stats: Object.fromEntries([1, 2].map(id =>
    [id, { market_id: id, best_bid_price: '99.99', best_ask_price: '100.01', mark_price: '100' }])) };
  const fetchImpl = async (url: string) => {
    if (url.includes('orderBookDetails')) return Response.json({ code: 200, order_book_details: ['BTC', 'ETH'].map((symbol, i) =>
      ({ symbol, market_id: i + 1, market_type: 'perp', status: 'active', size_decimals: 4, price_decimals: 2, taker_fee: '0', mark_price: '100' })) });
    return Response.json({ listings: ['BTC', 'ETH'].map((ticker, i) => {
      const mid = i === 0 ? 100.5 : ethMid, price = { bid: String(mid - 0.01), ask: String(mid + 0.01) };
      return { ticker, name: ticker, mark_price: String(mid), funding_rate: 0, quotes: { updated_at: new Date(quoteAt).toISOString(), base: price, size_1k: price, size_100k: price } };
    }) });
  };
  const makeEngine = (store: ReturnType<typeof openVarLighterStore>) => {
    const socket = new FakeSocket(), engine = createVarLighterEngine({ store, fetchImpl, now: () => clock, connect: () => socket });
    engine.startStreams(); socket.open();
    const poll = async () => {
      clock = quoteAt;
      socket.push(snapshot);
      clock = quoteAt + 29_500;
      socket.push(snapshot);
      return engine.pollVar(signal);
    };
    return { engine, poll };
  };
  const store = openVarLighterStore(file);
  store.setState(SETTINGS_KEY, settings, T0);
  store.addSamples(keys.flatMap(symbol => Array.from({ length: 12 }, (_, i) => sample(T0 - (12 - i) * 60_000, 100, 100, { symbol }))));
  const { engine, poll } = makeEngine(store);
  const counts = (e: typeof engine) => e.views.state().rows.map(row => [row.key, row.baseline?.samples, row.samples24h]);
  try {
    await engine.refreshCatalog(signal);
    await poll();
    quoteAt += 60_000;
    await poll();
    quoteAt += 60_000; ethMid = 100.5;
    await poll();
    assert.deepEqual(counts(engine), [[RH_BTC, 15, 15], [eth, 15, 15]]);
    assert.equal(store.positions().length, 0, 'Var 配对不开仓');
    const events = store.events(100);
    await engine.pollVar(signal);
    assert.deepEqual([counts(engine), store.events(100)], [[[RH_BTC, 15, 15], [eth, 15, 15]], events], '重取同一时刻不重记样本、不意外补开仓');
    const restored = makeEngine(openVarLighterStore(file));
    try {
      await restored.engine.refreshCatalog(signal);
      await restored.poll();
      assert.deepEqual(counts(restored.engine), counts(engine), '重启预热后的基线与运行中相同，重复键也没有再次推进');
      assert.deepEqual(store.events(100), events);
      assert.equal(restored.engine.views.state().sources.var.poll?.written, 0);
    } finally { restored.engine.close(); }

    // 若本次失败的是样本写入，则游标和基线仍在上一条。原报价可安全重试，持仓只在样本成功提交后出现。
    quoteAt += 60_000;
    const insert = store.addNewSamples;
    const denied = t.mock.method(store, 'addNewSamples', (samples: Sample[]) => {
      if (samples.some(item => item.symbol === RH_BTC)) throw new Error('BTC 样本写失败');
      return insert(samples);
    });
    await assert.rejects(poll(), /BTC 样本写失败/);
    assert.deepEqual([store.latest(RH_BTC)?.t, counts(engine)[0]], [quoteAt - 60_000, [RH_BTC, 15, 15]]);
    denied.mock.restore();
    await engine.pollVar(signal);
    assert.deepEqual([store.latest(RH_BTC)?.t, counts(engine)[0]], [quoteAt, [RH_BTC, 16, 16]]);
  } finally { engine.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('估算开仓在盘口完整时估值，回测期末净盈亏仍标为估算', () => {
  const params = { ...DEFAULT_SYMBOL, notionalUsd: 100, entryBps: 15, exitBps: 2 }, global = { ...DEFAULT_GLOBAL, minSamples: 10 };
  const warm = Array.from({ length: 10 }, (_, i) => sample(T0 - (10 - i) * 60_000, 100));
  const entry = sample(T0, 100.5, 100, { captureKind: 'aligned', decisionAt: null, bBidRx: null, bAskRx: null, bRxAt: null });
  const last = sample(T0 + 60_000, 100.4);
  const replay = runBacktest(RH_BTC, 'crypto', [...warm, entry, last], entry.t, last.t, params, global, ZERO_FEES);
  const held = replay.open!;
  assert.deepEqual([held.estimated, closeSpread(last, held)?.estimated, replay.summary.openMarkEstimated], [true, false, true]);
});

test('两腿行情流的配对在风控读取（实盘当日已实现）后检查两腿年龄并落盘供回放', async t => {
  const key = 'rh:BTC|lighter:BTC', dir = mkdtempSync(path.join(tmpdir(), 'tp-live-decision-'));
  const store = openVarLighterStore(path.join(dir, 'varlighter.sqlite')), keys = createLiveKeysStore(dir);
  // 假值私钥，不对应任何真实账户。
  keys.set('rh', { accountIndex: 11, apiKeyIndex: 5, privateKey: 'cd'.repeat(40) });
  keys.set('lighter', { accountIndex: 12, apiKeyIndex: 5, privateKey: 'ab'.repeat(40) });
  const params = { ...DEFAULT_SYMBOL, enabled: true }, global = { ...DEFAULT_GLOBAL, minSamples: 10 };
  store.setState(SETTINGS_KEY, settings2({ [key]: params }, global, ['rh|lighter']), T0);
  store.setState(LIVE_SETTINGS_KEY, { on: true, pairs: [key], limits: { perTradeUsd: 100, maxOpen: 1, dailyLossUsd: 20, slippageBps: 30 } }, T0);
  store.addSamples(Array.from({ length: 12 }, (_, i) => sample(T0 - (12 - i) * 60_000, 100, 100, { symbol: key })));
  let clock = T0, riskWait = 30_001;
  const sockets = new Map<string, FakeSocket>(), net = store.liveNetSince;
  t.mock.method(store, 'liveNetSince', (at: number) => { clock += riskWait; return net(at); });
  const market = { symbol: 'BTC', market_id: 1, market_type: 'perp', status: 'active', size_decimals: 4, price_decimals: 2, taker_fee: '0', mark_price: '100' };
  const engine = createVarLighterEngine({ store, now: () => clock, fetchImpl: async () => Response.json({ code: 200, order_book_details: [market] }),
    connect: url => { const socket = new FakeSocket(); sockets.set(venueOf(url), socket); return socket; },
    liveKeys: keys, signerProblem: () => null, traders: () => { throw new Error('不该下单'); } });
  const snapshot = (at: number) => {
    clock = at;
    for (const [venue, socket] of sockets) {
      const mid = venue === 'rh' ? 100.5 : 100;
      socket.push({ type: 'subscribed/market_stats', channel: 'market_stats:all', market_stats: { 1: { market_id: 1, best_bid_price: String(mid - 0.01), best_ask_price: String(mid + 0.01), mark_price: String(mid) } } });
    }
    return engine.sampleLive();
  };
  try {
    engine.startStreams();
    for (const socket of sockets.values()) socket.open();
    for (const venue of ['rh', 'lighter'] as const) await engine.refreshCatalog(new AbortController().signal, venue);
    const prewarm = t.mock.method(store, 'samples', () => { throw new Error('基线暂不可读'); });
    assert.throws(() => snapshot(T0), /基线暂不可读/);
    prewarm.mock.restore();
    assert.deepEqual([store.latest(key)?.t, store.latest(key)?.decisionAt], [T0, null]);
    const unavailable = t.mock.method(store, 'liveNetSince', () => { throw new Error('账户风控暂不可读'); });
    assert.throws(() => snapshot(T0 + 60_000), /账户风控暂不可读/);
    unavailable.mock.restore();
    assert.deepEqual([store.latest(key)?.t, store.latest(key)?.decisionAt, store.liveActive().length], [T0 + 60_000, null, 0]);
    assert.equal(snapshot(T0 + 60_000).written, 0, '已经提交的行情不能补开仓');
    const lateAt = T0 + 120_000, validAt = T0 + 180_000;
    assert.deepEqual(snapshot(lateAt).blocked, { [STALE_QUOTE]: 1 });
    const first = store.latest(key)!;
    assert.deepEqual([first.aRxAt, first.bRxAt, first.decisionAt, store.liveActive().length], [lateAt, lateAt, lateAt + 30_001, 0]);
    riskWait = 30_000;
    // 年龄恰好达界：策略放行，交给实盘；实盘没有账户读数，挡下且不留持仓记录。
    assert.deepEqual(snapshot(validAt).blocked, { 'Lighter RH 账户读数不够新': 1 });
    const result = await engine.views.backtest({ symbol: key, hours: 2 });
    assert.deepEqual([store.liveActive().length, result.open?.openedAt, result.summary.blocked[STALE_QUOTE], result.summary.blocked[NO_QUOTE_TIME]], [0, validAt, 1, 2]);
  } finally { engine.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('两腿行情流的配对按策略信号驱动实盘（docs/dexspread.md 第 18 节）：止损按实际成交价与开仓时记下的平仓规则判断，平仓途中不再判断也不重复下单，结束后冷却；开仓被实盘挡下不留记录也不写样本；实盘没勾的配对不判断', async () => {
  const key = 'rh:BTC|lighter:BTC', dir = mkdtempSync(path.join(tmpdir(), 'tp-live-push-'));
  const store = openVarLighterStore(path.join(dir, 'varlighter.sqlite')), keys = createLiveKeysStore(dir);
  // 假值私钥，不对应任何真实账户。
  keys.set('rh', { accountIndex: 11, apiKeyIndex: 5, privateKey: 'cd'.repeat(40) });
  keys.set('lighter', { accountIndex: 12, apiKeyIndex: 5, privateKey: 'ab'.repeat(40) });
  // 配对现在的止损 5000 基点；持仓开仓时记下的平仓规则是 60 基点，按记下的判断。
  store.setState(SETTINGS_KEY, settings2({ [key]: { ...DEFAULT_SYMBOL, enabled: true, cooldownMinutes: 0, stopBps: 5000 } }, { ...DEFAULT_GLOBAL, minSamples: 10 }, ['rh|lighter']), T0);
  store.addSamples(Array.from({ length: 12 }, (_, i) => sample(T0 - (12 - i) * 60_000, 100, 100, { symbol: key })));
  // 总览的浮动按最近落盘的样本估：与下面第一次推送的行情相同。
  store.addSamples([sample(T0 - 1_000, 100.5, 100, { symbol: key })]);
  store.setState(LIVE_SETTINGS_KEY, { on: true, pairs: [key], limits: { perTradeUsd: 100, maxOpen: 1, dailyLossUsd: 20, slippageBps: 30 } }, T0);
  // v0.111 写下的实盘持仓：带 paperId。实际成交的入场价差 40 基点，记下的信号价差 80 基点——判断按实际成交。
  const leg = (venue: 'rh' | 'lighter', side: 'buy' | 'sell', entry: number) => ({ venue, symbol: 'BTC', side, qty: 1, entryQuote: entry, exitQty: 0, exitQuote: 0, feesUsd: 0, estimated: false });
  const held: LivePosition = { id: 'l-1', symbol: key, paperId: 'p-legacy', direction: 'a_rich', ratio: 1, state: 'open', step: 'settle', openedAt: T0 - 60_000, updatedAt: T0 - 60_000, closedAt: null,
    a: leg('rh', 'sell', 100.4), b: leg('lighter', 'buy', 100), plan: { qty: 1, limit: 100.1 }, pending: null, tries: 0, retryAt: 0, closeReason: null, singleLeg: false, netUsd: null, note: '',
    strategy: { notionalUsd: 100, entrySpread: 80, entryBaseline: 0, entryRegime: 'all', aFeeBps: 0, bFeeBps: 0, estimated: false, rules: { exitBps: 0, stopBps: 60, maxHoldMinutes: 1440 } } };
  store.saveLive(held);
  let clock = T0, hold = false, release: () => void = () => {};
  const placed: string[] = [];
  const trader = (venue: string) => ({
    async place(order: { side: string; qty: number; limit: number; reduceOnly: boolean }) {
      placed.push(`${venue} ${order.side} ${order.qty}${order.reduceOnly ? ' R' : ''}`);
      if (hold) await new Promise<void>(resolve => { release = resolve; });
      return { kind: 'done' as const, filledQty: order.qty, avgPrice: order.limit, note: '替身' };
    },
    async resolve() { return { kind: 'absent' as const, reason: '替身' }; },
  });
  const sockets = new Map<string, FakeSocket>();
  const market = { symbol: 'BTC', market_id: 1, market_type: 'perp', status: 'active', size_decimals: 4, price_decimals: 2, taker_fee: '0', mark_price: '100' };
  const engine = createVarLighterEngine({ store, now: () => clock, fetchImpl: async () => Response.json({ code: 200, order_book_details: [market] }),
    connect: url => { const socket = new FakeSocket(); sockets.set(venueOf(url), socket); return socket; },
    liveKeys: keys, signerProblem: () => null, traders: venue => trader(venue) as never });
  const push = (venue: string, at: number, mid: number, type = 'update') => {
    clock = at;
    sockets.get(venue)!.push({ type: `${type}/market_stats`, channel: 'market_stats:all', market_stats: { 1: { market_id: 1, best_bid_price: String(mid - 0.01), best_ask_price: String(mid + 0.01), mark_price: String(mid) } } });
  };
  const stats = () => engine.views.state().sources.push!;
  const liveEvents = () => store.events(200).filter(item => item.kind === 'live').map(item => item.message);
  try {
    engine.startStreams();
    for (const socket of sockets.values()) socket.open();
    for (const venue of ['rh', 'lighter'] as const) await engine.refreshCatalog(new AbortController().signal, venue);
    push('rh', T0, 100.5, 'subscribed'); push('lighter', T0, 100, 'subscribed');
    // 买回 A 的价差约 52 基点：按实际成交（入场 40）浮亏约 12 基点，没到止损 60；按信号价差（80）会是浮盈。
    const row = engine.views.state().rows.find(item => item.key === key)!;
    assert.ok(row.position && row.position.pnlBps! < -10 && row.position.pnlBps! > -15, `浮盈按实际成交价：${row.position?.pnlBps}`);
    assert.deepEqual([row.position.id, row.position.state, engine.views.symbol(key, '1').position?.entrySpread], ['l-1', 'open', (100.4 - 100) / 100 * 1e4]);
    assert.deepEqual([store.liveActive()[0]?.state, placed], ['open', []]);
    // 价差扩到约 102 基点：按实际成交亏 62 基点，止损。第一腿的平仓单挂着没回来。
    hold = true;
    push('rh', T0 + 1_000, 101);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual([store.liveActive()[0]?.state, store.liveActive()[0]?.closeReason, placed], ['closing', 'stop', ['rh buy 1 R']]);
    assert.ok(liveEvents().some(text => text.startsWith('平仓信号（止损）')), '平仓信号写进实盘事件');
    assert.equal(store.latest(key)!.t, T0 + 1_000, '有动作的推送留下这一刻的样本');
    const checks = stats().checks;
    push('rh', T0 + 1_200, 101.3);
    assert.deepEqual([stats().checks, placed.length], [checks, 1], '平仓途中不再判断，不重复下单');
    hold = false; release();
    await engine.live()!.idle();
    assert.deepEqual([placed, store.liveActive().length, store.liveClosed(5)[0]?.closeReason], [['rh buy 1 R', 'lighter sell 1 R'], 0, 'stop']);
    // 结束后冷却至少 1 分钟（配对参数冷却 0），写库。
    assert.equal(store.state<Record<string, number>>(COOLDOWN_KEY)?.[key], T0 + 1_200 + 60_000);
    assert.equal(engine.views.symbol(key, '1').trades.length, 1, '详情页列出这笔实盘成交');
    push('rh', T0 + 2_000, 101.5);
    assert.match(stats().lastBlocked!.reason, /冷却/, '冷却中的开仓信号被挡住');
    // 冷却过后：策略风控都过了，实盘自己挡下（账户读数不够新）——不留持仓记录、不写样本、不下单，事件只记一条。
    push('lighter', T0 + 70_000, 99.99); push('rh', T0 + 70_100, 101.5);
    const sampled = store.latest(key)!.t;
    push('rh', T0 + 70_200, 101.6);
    assert.equal(stats().lastBlocked?.reason, 'Lighter RH 账户读数不够新');
    assert.deepEqual([store.liveActive().length, store.liveClosed(5).length, placed.length, store.latest(key)!.t], [0, 1, 2, sampled]);
    assert.equal(liveEvents().filter(text => text === '实盘没有开仓：Lighter RH 账户读数不够新').length, 1);
    // 实盘里取消勾选：这个配对不再按推送判断（策略仍启用，只采集）。
    engine.views.liveSettings({ pairs: [] });
    const before = stats().checks;
    push('rh', T0 + 71_000, 101.8);
    assert.equal(stats().checks, before, '实盘没勾的配对不判断');
  } finally { engine.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('回测只读线程：并发未提交写入进行中仍读到一致快照并完成回测', async () => {
  const params = { ...DEFAULT_SYMBOL, notionalUsd: 100, entryBps: 15, exitBps: 2 }, global = { ...DEFAULT_GLOBAL, minSamples: 10 };
  const warm = Array.from({ length: 12 }, (_, i) => sample(T0 - (12 - i) * 60_000, 100, 100));
  const fixture = seededEngine(s => {
    s.addSamples([...warm, sample(T0, 100.5, 100), sample(T0 + 60_000, 100, 100)]);
    s.setState(SETTINGS_KEY, settings2({ [RH_BTC]: { ...params, enabled: true } }, global), T0);
  }, { clock: () => T0 + 120_000 });
  const db = new DatabaseSync(path.join(fixture.dir, 'varlighter.sqlite'));
  try {
    await fixture.engine.refreshCatalog(AbortSignal.timeout(1000), 'rh');
    await fixture.engine.pollVar(AbortSignal.timeout(1000));
    db.exec('PRAGMA busy_timeout=2000; BEGIN IMMEDIATE');
    db.prepare('INSERT INTO leg_samples(symbol, t, received_at, regime, ratio, a_at, a_bid0, a_ask0, b_at, b_bid0, b_ask0) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(RH_BTC, T0 + 90_000, T0 + 90_000, 'rth', 1, T0 + 90_000, 101.9, 102.1, T0 + 90_000, 100, 100);
    const replay = await fixture.engine.views.backtest({ symbol: RH_BTC, hours: 2 });
    assert.equal(replay.trades.length, 1, '回测只读线程不受另一连接未提交写事务影响');
    db.exec('ROLLBACK');
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
    fixture.dispose();
  }
});

test('回测只读线程：失败清理后不残留锁，恢复后后续回测正常完成', async () => {
  const params = { ...DEFAULT_SYMBOL, notionalUsd: 100, entryBps: 15, exitBps: 2 }, global = { ...DEFAULT_GLOBAL, minSamples: 10 };
  const warm = Array.from({ length: 12 }, (_, i) => sample(T0 - (12 - i) * 60_000, 100, 100));
  const fixture = seededEngine(s => {
    s.addSamples([...warm, sample(T0, 100.5, 100), sample(T0 + 60_000, 100, 100)]);
    s.setState(SETTINGS_KEY, settings2({ [RH_BTC]: { ...params, enabled: true } }, global), T0);
  }, { clock: () => T0 + 120_000 });
  const db = new DatabaseSync(path.join(fixture.dir, 'varlighter.sqlite'));
  try {
    await fixture.engine.refreshCatalog(AbortSignal.timeout(1000), 'rh');
    await fixture.engine.pollVar(AbortSignal.timeout(1000));
    db.exec('ALTER TABLE leg_samples RENAME TO leg_samples_bak');
    await assert.rejects(() => fixture.engine.views.backtest({ symbol: RH_BTC, hours: 2 }));
    db.exec('ALTER TABLE leg_samples_bak RENAME TO leg_samples');
    const replay = await fixture.engine.views.backtest({ symbol: RH_BTC, hours: 2 });
    assert.equal(replay.trades.length, 1);
  } finally {
    try { db.exec('ALTER TABLE leg_samples_bak RENAME TO leg_samples'); } catch { /* 已恢复 */ }
    db.close();
    fixture.dispose();
  }
});

test('Entropy 默认单边 0.2 基点（往返 0.4）与总览成本列；老库 null 一次性升级且不覆盖清空或自定义值', async () => {
  assert.equal(DEFAULT_GLOBAL.entropyFeeBps, 0.2);
  const dir = mkdtempSync(path.join(tmpdir(), 'tp-entropy-fee-'));
  const file = path.join(dir, 'varlighter.sqlite');
  const fetchImpl = async (url: string) => {
    if (url.includes('orderBookDetails')) return Response.json({ code: 200, order_book_details: [{ symbol: 'SNDK', market_id: 9, market_type: 'perp', status: 'active', size_decimals: 2, price_decimals: 2, min_base_amount: '0.01', min_quote_amount: '10', taker_fee: '0', maker_fee: '0', mark_price: '100' }] });
    if (url.includes('hyperliquid')) return Response.json([{ universe: [{ name: 'io:SNDK', szDecimals: 2, deployerFeeScale: '1.0', growthMode: 'enabled' }], collateralToken: 0 }, [{ markPx: '100', oraclePx: '100', funding: '0' }]]);
    return Response.json({ listings: [] });
  };
  try {
    // 老库保存了 entropyFeeBps: null：首次升级为 0.2（revision + 1），记一条事件；用户再手动清空为 null 重启后保持 null。
    const seed = openVarLighterStore(file);
    seed.setState(SETTINGS_KEY, settings2({}, { ...DEFAULT_GLOBAL, entropyFeeBps: null }, ['lighter|entropy']), T0);
    seed.close();
    const sockets = new Map<string, FakeSocket>();
    const first = createVarLighterEngine({ store: openVarLighterStore(file), fetchImpl, connect: url => { const s = new FakeSocket(); sockets.set(venueOf(url), s); return s; }, now: () => T0 });
    try {
      first.startStreams();
      sockets.get('lighter')!.open(); sockets.get('entropy')!.open();
      await first.refreshCatalog(AbortSignal.timeout(1000), 'lighter');
      await first.refreshCatalog(AbortSignal.timeout(1000), 'entropy');
      sockets.get('lighter')!.push({ type: 'subscribed/market_stats', channel: 'market_stats:all', market_stats: { 9: { market_id: 9, best_bid_price: '99.99', best_ask_price: '100.01', mark_price: '100' } } });
      sockets.get('entropy')!.push({ channel: 'bbo', data: { coin: 'io:SNDK', bbo: [{ px: '99.98', sz: '10', n: 1 }, { px: '100.02', sz: '10', n: 1 }] } });
      first.sampleLive();
      const view = first.views.state();
      assert.deepEqual([view.settings.revision, view.settings.global.entropyFeeBps], [4, 0.2]);
      const row = view.rows[0]!;
      assert.deepEqual([row.aFeeBps, row.bFeeBps], [0, 0.2]);
      assert.ok(Math.abs(row.cost! - 6) < 1e-6);
      assert.ok(Math.abs(row.feeCost! - 0.4) < 1e-6);
      assert.ok(Math.abs(row.totalCost! - 6.4) < 1e-6);
      const cleared = first.views.settings({ revision: 4, global: { entropyFeeBps: null } });
      assert.equal(cleared.global.entropyFeeBps, null);
    } finally { first.close(); }

    const second = createVarLighterEngine({ store: openVarLighterStore(file), fetchImpl, connect: () => new FakeSocket(), now: () => T0 + 1000 });
    try {
      const view = second.views.state();
      assert.equal(view.settings.global.entropyFeeBps, null, '用户主动清空后重启不再覆写回 0.2');
      assert.equal(view.settings.revision, 5);
    } finally { second.close(); }

    // 已有自定义值（0.5）的老库升级时保持 0.5 不覆盖。
    const customDir = mkdtempSync(path.join(tmpdir(), 'tp-entropy-custom-'));
    try {
      const cFile = path.join(customDir, 'varlighter.sqlite');
      const cSeed = openVarLighterStore(cFile);
      cSeed.setState(SETTINGS_KEY, settings2({}, { ...DEFAULT_GLOBAL, entropyFeeBps: 0.5 }, ['lighter|entropy']), T0);
      cSeed.close();
      const cEngine = createVarLighterEngine({ store: openVarLighterStore(cFile), fetchImpl, connect: () => new FakeSocket(), now: () => T0 });
      try {
        assert.deepEqual([cEngine.views.state().settings.revision, cEngine.views.state().settings.global.entropyFeeBps], [3, 0.5]);
      } finally { cEngine.close(); }
    } finally { rmSync(customDir, { recursive: true, force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
