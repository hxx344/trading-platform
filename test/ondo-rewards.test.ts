// The Ondo reward view (docs/ondo.md §5–§6): the income model, the depth digest, the one-minute volatility, the collector
// against a fake Ondo client, and the page's forms. Nothing reaches Ondo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BANDS, bandOf, bandScores, fillsPerDay, normalCdf, simulate, sweep, type SimMarket, type SimParams } from '../src/ondo/reward-sim.ts';
import { observationEarnings } from '../src/ondo/observation-earnings.ts';
import { ONDO_MM_DEFAULTS } from '../src/vendor/ondo/mm.mjs';
import { BUCKETS } from '../src/ondo/reward-types.ts';
import { BURST_MS, createOndoRewards, digest, FEED_LEVELS, MIN_RETURNS, minuteVolatility, REWARD_MARKETS, RewardInputError, validateRewardConfig } from '../src/ondo/rewards.ts';
import { parseOndoBook, type OndoStreamFactory, type OndoStreamOptions } from '../src/vendor/ondo/stream.mjs';
import { OndoError, type OndoClient, type OndoDepth } from '../src/vendor/ondo/client.mjs';
import { defaultSimForm, readSimForm, rewardConfigRequest, simParams, type SimForm } from '../web/src/ondo/reward-form.ts';

const close = (actual: number, expected: number, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≠ ${expected}`);
const empty = (): number[] => new Array<number>(BUCKETS).fill(0);
const params = (extra: Partial<SimParams> = {}): SimParams => ({ poolUsd: 125_000, eligible: 20, sizeUsd: 100, distanceBps: 4, minBps: 3, reactionSec: 1, holdSec: 60, decayK: 0.1, uptime: 1, sides: 2, ...extra });

test('模拟：分档、正态分布与成交次数', () => {
  assert.deepEqual([bandOf(0), bandOf(4.99), bandOf(5), bandOf(9.9), bandOf(10), bandOf(24.9), bandOf(25), bandOf(-1), bandOf(Number.NaN)], [0, 0, 1, 1, 2, 2, null, null, null]);
  close(BANDS.reduce((sum, band) => sum + band.weight, 0), 1);
  close(normalCdf(0), 0.5, 1e-7); close(normalCdf(1.959964), 0.975, 1e-6); close(normalCdf(-1.959964), 0.025, 1e-6);
  assert.equal(fillsPerDay(0, 3, 1), 0);
  // Wider quotes fill less, a choppier market and a slower reaction more (per window, not per day).
  assert.ok(fillsPerDay(0.001, 3, 1) > fillsPerDay(0.001, 6, 1));
  assert.ok(fillsPerDay(0.002, 3, 1) > fillsPerDay(0.001, 3, 1));
  // The reflection principle: P(max over τ ≥ m) = 2(1 − Φ(m / σ√τ)), 86 400 / τ windows.
  const sigmaSec = 0.0006 / Math.sqrt(60);
  close(fillsPerDay(0.0006, 3, 2), 86_400 / 2 * 2 * (1 - normalCdf(0.0003 / (sigmaSec * Math.sqrt(2)))), 1e-6);
});

test('模拟：没有别人挂单时独得该档；份额按分数分；单边只算买方', () => {
  const quiet: SimMarket = { bid: empty(), ask: empty(), sigma1m: null, makerFee: null };
  const alone = simulate(quiet, params());
  const perSide = 125_000 / 20 / 7 / 2;
  assert.equal(alone.band, 0); close(alone.share.bid, 1); close(alone.share.ask, 1);
  close(alone.rewardDay, perSide * 0.85 * 2); close(alone.capDay, perSide * 0.85 * 2);
  assert.equal(alone.netDay, null); assert.equal(alone.fillsDay, null);
  // 1000 USD in the first bucket (0–0.5 bps, centre 0.25) on the bid only.
  const bid = empty(); bid[0] = 1000;
  const crowded = simulate({ ...quiet, bid }, params({ uptime: 0.5 }));
  const mine = 100 * Math.exp(-0.4), theirs = 1000 * Math.exp(-0.025);
  close(crowded.myScore, mine); close(crowded.others.bid, theirs); close(crowded.share.bid, mine / (mine + theirs)); close(crowded.share.ask, 1);
  close(crowded.rewardDay, 0.5 * perSide * 0.85 * (mine / (mine + theirs) + 1));
  close(simulate({ ...quiet, bid }, params({ sides: 1 })).rewardDay, perSide * 0.85 * (mine / (mine + theirs)));
  // Beyond 25 bps there is no reward; size in another band does not count against this one.
  assert.equal(simulate(quiet, params({ distanceBps: 30 })).rewardDay, 0);
  const far = empty(); far[15] = 1e9;
  close(simulate({ ...quiet, bid: far, ask: far }, params()).share.bid, 1);
  assert.deepEqual(bandScores(far, 0).map(Math.round), [0, 1e9, 0]);
});

test('模拟：成交亏损按波动、平仓耗时与两次挂单手续费计', () => {
  const market: SimMarket = { bid: empty(), ask: empty(), sigma1m: 0.0006, makerFee: 0.0001 };
  const result = simulate(market, params({ uptime: 0.9 }));
  const sigmaSec = 0.0006 / Math.sqrt(60);
  close(result.fillsDay!, 0.9 * 2 * fillsPerDay(0.0006, 3, 1));
  close(result.lossPerFill!, 100 * (sigmaSec * Math.sqrt(60) * Math.sqrt(2 / Math.PI) + 0.0002));
  close(result.netDay!, result.rewardDay - result.lossDay!);
  // The sweep keeps the gap between the distance and the closest point (1 bps here), never under 0.5 bps.
  const rows = sweep(market, params(), [1, 4, 20]);
  assert.deepEqual(rows.map(row => row.distanceBps), [1, 4, 20]);
  close(rows[0]!.result.fillsDay!, 2 * fillsPerDay(0.0006, 0.5, 1));
  close(rows[2]!.result.fillsDay!, 2 * fillsPerDay(0.0006, 19, 1));
  assert.equal(rows[2]!.result.band, 2);
});

test('观察收益：三档的买卖有效时长分别定权，手续费或波动缺失保留毛奖励，失效的样本不可年化', () => {
  const market = 'NVDA-USD.P', at = 1_800_000_120_000;
  const quote = { ...ONDO_MM_DEFAULTS, maxHoldSec: 25, orderUsd: '200' };
  const pool = { poolUsd: '1400', eligible: 2, markets: [market] };
  const observed = { startedAt: at - 120_000, rows: ([4, 8, 15] as const).flatMap(distanceBps => [
    { market, distanceBps, side: 'buy' as const, activeMs: 60_000 }, { market, distanceBps, side: 'sell' as const, activeMs: 90_000 },
  ]) };
  const status = { market, issue: null, makerFee: '0.0001' };
  const bid = empty(), ask = empty(); bid[0] = 2000; ask[0] = 600;
  const sample = { market, avg: { samples: 12, snapshots: 110, from: at - 12 * 60_000, to: at - 25_000, bid, ask, cover: { bid: 25, ask: 25 } }, returns: 22, sigma1m: 0.004 };
  const estimate = () => observationEarnings(quote, pool, observed, [status], [sample], at);
  const result = estimate(), first = result.markets[0].tiers[0];
  assert.deepEqual([result.referenceCapitalUsd, result.reactionSec, result.holdSec], [400, 1, 25]);
  assert.deepEqual(result.markets[0].tiers.map(tier => tier.distanceBps), [4, 8, 15]);
  assert.deepEqual([first.buyUptime, first.sellUptime, first.reason], [0.5, 0.75, null]);
  const myScore = 200 * Math.exp(-0.4), weight = Math.exp(-0.025);
  close(first.rewardDay!, 1400 / 2 / 7 / 2 * 0.85 * (0.5 * myScore / (myScore + 2000 * weight) + 0.75 * myScore / (myScore + 600 * weight)));
  close(first.lossDay!, 1.25 * fillsPerDay(0.004, 3, 1) * 200 * (0.004 / Math.sqrt(60) * 5 * Math.sqrt(2 / Math.PI) + 0.0002));
  close(first.netDay!, first.rewardDay! - first.lossDay!); assert.ok(first.netDay! < 0);
  const tier = (fee: string | null, sigma1m: number | null) => observationEarnings(quote, pool, observed, [{ ...status, makerFee: fee }], [{ ...sample, sigma1m }], at).markets[0].tiers[0];
  assert.equal(tier(null, 0.004).rewardDay, first.rewardDay); assert.equal(tier(null, 0.004).netDay, null);
  assert.match(tier(null, 0.004).reason!, /费率/); assert.equal(tier('0.0001', null).lossDay, null);
  assert.match(tier('0.0001', null).reason!, /波动率/);
  assert.notEqual(tier('0', 0).netDay, null); // Explicit zero fee and zero measured volatility are valid data.
  sample.avg.cover.ask = 9.99;
  assert.deepEqual(estimate().markets[0].tiers.map(item => item.rewardDay === null), [false, true, true]);
  assert.match(estimate().markets[0].tiers[1].reason!, /10 bps/);
  observed.rows.forEach(row => { row.activeMs = 59_999; });
  assert.match(estimate().markets[0].tiers[0].reason!, /60 秒/);
  sample.avg.to = at - 120_001;
  assert.match(estimate().markets[0].tiers[0].reason!, /过期/);
  // A newer on-demand book is deliberately absent from the estimate's inputs.
  sample.avg.to = at + 1; assert.equal(estimate().markets[0].tiers[0].netDay, null);
  assert.match(observationEarnings(quote, pool, observed, [status], [], at).markets[0].tiers[0].reason!, /分钟样本/);
  assert.match(observationEarnings(quote, { ...pool, markets: [] }, observed, [status], [sample], at).markets[0].tiers[0].reason!, /采集名单/);
  assert.match(observationEarnings(quote, pool, observed, [{ ...status, issue: '该市场休市或暂停交易' }], [sample], at).markets[0].tiers[0].reason!, /休市/);
});

const level = (price: string, size: string): [string, string] => [price, size];
const book = (bids: [string, string][], asks: [string, string][], market = 'NVDA-USD.P'): OndoDepth => ({ market, bids, asks } as unknown as OndoDepth);

test('盘口：前 5 bps 各档、扣除自己的挂单、按 0.5 bps 分桶', () => {
  const depth = book([level('100.00', '10'), level('99.99', '5'), level('99.90', '1')], [level('100.02', '10'), level('100.10', '3')]);
  const { sample, latest } = digest(depth, { buy: new Map([[100, 4]]), sell: new Map() }, 1000);
  close(latest.mid, 100.01);
  assert.deepEqual(latest.levels.bid.map(item => [item.price, item.usd, item.oursUsd, item.cumUsd]), [['100.00', 600, 400, 600], ['99.99', 499.95, 0, 1099.95]]);
  assert.equal(latest.depth5.bid, 1099.95); assert.equal(latest.depth5.ask, 1000.2);
  // 99.90 is 11 bps out: not a shown level, but in its bucket.
  close(sample.bid[1]!, 600, 1e-3); close(sample.bid[3]!, 499.95, 1e-3); close(sample.bid[21]!, 99.9, 1e-3);
  // A short side is not taken as whole: the cover is the farthest level returned (Ondo's level limit is not known).
  close(latest.cover[0], (100.01 - 99.9) / 100.01 * 1e4, 1e-6); close(latest.cover[1], (100.1 - 100.01) / 100.01 * 1e4, 1e-6);
  const full = Array.from({ length: 100 }, (_, i) => level((100 - i * 0.001).toFixed(3), '1'));
  // 100 levels: only as far as the last one is known.
  close(digest(book(full, [level('100.02', '1')]), { buy: new Map(), sell: new Map() }, 0).latest.cover[0], (100.01 - 99.901) / 100.01 * 1e4, 1e-6);
  assert.throws(() => digest(book([level('100.02', '1')], [level('100.01', '1')]), { buy: new Map(), sell: new Map() }, 0), /买一不低于卖一/);
  assert.throws(() => digest(book([], [level('100.01', '1')]), { buy: new Map(), sell: new Map() }, 0), /一侧为空/);
  assert.throws(() => digest(book([level('-1', '1')], [level('100.01', '1')]), { buy: new Map(), sell: new Map() }, 0), OndoError);
});

test('整数价格比值区分恰好覆盖奖励档和只差一个价格步长的盘口', () => {
  const snap = (bid: string, ask: string) => digest(book([level('99.999', '1'), level(bid, '1')],
    [level('100.001', '1'), level(ask, '1')]), { buy: new Map(), sell: new Map() }, 1000);
  const five = snap('99.95', '100.05'), ten = snap('99.9', '100.1'), inside = snap('99.9500000001', '100.0499999999');
  assert.deepEqual(five.sample.cover, [5, 5]); assert.deepEqual(ten.sample.cover, [10, 10]);
  assert.ok(five.sample.bid[10] > 0 && five.sample.ask[10] > 0 && ten.sample.bid[20] > 0);
  assert.ok(inside.sample.cover.every(value => value < 5)); assert.ok(inside.sample.ask[9] > 0 && inside.sample.ask[10] === 0);
  for (const bids of [[level('99.9', '1'), level('99', '0')], [level('99.9', '1'), level('99.9', '1')], [level('99', '1'), level('99.9', '1')]]) {
    assert.throws(() => digest(book(bids, [level('100.1', '1')]), { buy: new Map(), sell: new Map() }, 1000), OndoError);
  }
  for (const bad of [[[['99.94'], '1']], [['99.94', ['1000000']]]]) {
    assert.throws(() => digest({ market: 'NVDA-USD.P', bids: bad, asks: [['100.06', '1']] }, { buy: new Map(), sell: new Map() }, 0), OndoError);
  }
});

test('波动：各分钟的收益平方和合计后开方；不足 MIN_RETURNS 个为空', () => {
  const minutes = [{ rv: 12 * 1e-6, rn: 12 }, { rv: 8 * 1e-6, rn: 8 }];
  const measured = minuteVolatility(minutes);
  assert.equal(measured.returns, 20); close(measured.sigma1m!, 0.001);
  assert.equal(MIN_RETURNS, 20);
  assert.deepEqual(minuteVolatility(minutes.slice(0, 1)), { sigma1m: null, returns: 12 });
  assert.deepEqual(minuteVolatility([]), { sigma1m: null, returns: 0 });
});

test('奖励设置：只收市场、奖池与市场数', () => {
  assert.deepEqual(validateRewardConfig({ markets: ['NVDA-USD.P'], poolUsd: '1000.50', eligible: 3 }), { markets: ['NVDA-USD.P'], poolUsd: '1000.50', eligible: 3 });
  for (const bad of [null, [], { markets: [], poolUsd: '1', eligible: 1 }, { markets: ['nvda'], poolUsd: '1', eligible: 1 }, { markets: ['NVDA-USD.P', 'NVDA-USD.P'], poolUsd: '1', eligible: 1 },
    { markets: ['NVDA-USD.P'], poolUsd: '0', eligible: 1 }, { markets: ['NVDA-USD.P'], poolUsd: 1, eligible: 1 }, { markets: ['NVDA-USD.P'], poolUsd: '1.001', eligible: 1 },
    { markets: ['NVDA-USD.P'], poolUsd: '1', eligible: 0 }, { markets: ['NVDA-USD.P'], poolUsd: '1', eligible: 1.5 }, { markets: ['NVDA-USD.P'], poolUsd: '1', eligible: 1, extra: 1 }]) {
    assert.throws(() => validateRewardConfig(bad), RewardInputError, JSON.stringify(bad));
  }
  assert.equal(REWARD_MARKETS.length, 20);
});

function fakeClient(time: { now: number }) {
  const calls: string[] = [];
  let failNext = false;
  const client = {
    async markets() { calls.push('markets'); return new Map([['NVDA-USD.P', { tick: '0.01', step: '0.01', trading: true, makerFee: '0.0001' }]]); },
    async depth(name: string) {
      calls.push(name);
      if (failNext) { failNext = false; throw new OndoError('upstream', { status: 502 }); }
      // The mid steps 0.1% a minute, so the measured σ is 0.001.
      const mid = 100 * Math.exp(0.001 * Math.round((time.now - 1_800_000_000_000) / 60_000));
      return { ...book([level((mid - 0.01).toFixed(4), '10'), level((mid - 0.03).toFixed(4), '20')], [level((mid + 0.01).toFixed(4), '10')], name), time: new Date(time.now).toISOString() };
    },
    close() { calls.push('close'); },
  };
  return { client: client as unknown as OndoClient, calls, fail: () => { failNext = true; } };
}

/** A feed the test pushes books into; every burst opens one. */
function fakeFeeds(error: string | null = null) {
  const feeds: { options: OndoStreamOptions; started: boolean; closed: boolean }[] = [];
  const factory: OndoStreamFactory = options => {
    const feed = { options, started: false, closed: false };
    feeds.push(feed);
    return { start() { feed.started = true; }, close() { feed.closed = true; },
      status: () => ({ connected: error === null, publicReady: error === null, privateReady: false, lastFrameAt: null, error }) };
  };
  const push = (market: string, mid: number, at: number, sourceAt = at) => {
    const row = { time: new Date(sourceAt).toISOString(), bids: [[(mid - 0.01).toFixed(4), '10'], [(mid - 0.03).toFixed(4), '20']], asks: [[(mid + 0.01).toFixed(4), '10']] };
    feeds.at(-1)!.options.onBook(market, parseOndoBook(row), at);
  };
  return { factory, feeds, push };
}

test('采集：每分钟订阅推送 10 秒、按秒取盘口；推送缺的市场走 REST；按分钟平均并计算波动；设置保存在数据目录', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tp-ondo-rewards-')), T0 = 1_800_000_000_000, time = { now: T0 };
  const fake = fakeClient(time), feed = fakeFeeds();
  // The pushed mid stays at 100 but for one step of 1% inside minute 2's burst, between the snapshots at 1 s and 6 s.
  const pushedMid = () => time.now >= T0 + 123_500 ? 100 * Math.exp(0.01) : 100;
  const rewards = createOndoRewards({ dataDir, clientFactory: () => fake.client, streamFactory: feed.factory, now: () => time.now,
    restingOrders: () => [{ market: 'NVDA-USD.P', side: 'sell', price: (pushedMid() + 0.01).toFixed(4), size: '4' }] });
  rewards.initialize();
  assert.equal(rewards.state().markets.length, 20); assert.equal(rewards.state().revision, 0); assert.equal(rewards.state().feed, null);
  assert.throws(() => rewards.save({ markets: [] }), RewardInputError);
  const saved = rewards.save({ markets: ['NVDA-USD.P', 'TSLA-USD.P'], poolUsd: '1400', eligible: 2 });
  assert.equal(saved.revision, 1); assert.deepEqual(saved.markets.map(item => item.market), ['NVDA-USD.P', 'TSLA-USD.P']);
  assert.equal(JSON.parse(readFileSync(join(dataDir, 'ondo-mm', 'rewards.json'), 'utf8')).config.poolUsd, '1400');
  // Only NVDA is pushed, 100 ms before each tick. Minute 0 misses tick 7 (the tick-6 book is not taken twice) and minute 1
  // gets a 3 s old book at tick 3 (not taken): 108 snapshots in 11 minutes.
  let minutes = 0, tick = 0;
  const pauses: number[] = [];
  await rewards.run({ stopped: () => minutes >= 11, pause: async ms => {
    pauses.push(ms);
    if (ms === 1000) {
      tick += 1; time.now += 900;
      if (!(minutes === 0 && tick === 7)) feed.push('NVDA-USD.P', pushedMid(), minutes === 1 && tick === 3 ? time.now - 2900 : time.now);
      time.now += 100;
    } else { assert.equal(ms, 50_000); time.now += ms; minutes += 1; tick = 0; }
  } });
  assert.deepEqual(pauses.slice(0, 11), [...new Array<number>(10).fill(1000), 50_000]);
  assert.equal(feed.feeds.length, 11);
  for (const opened of feed.feeds) {
    assert.ok(opened.started && opened.closed);
    // TSLA is not in the trading rules, so it is not asked for (Ondo would refuse the whole subscription).
    assert.deepEqual(opened.options.markets, ['NVDA-USD.P']); assert.equal(opened.options.depth, FEED_LEVELS);
    assert.equal(opened.options.credentials, undefined);
  }
  assert.equal(FEED_LEVELS, 100); assert.equal(BURST_MS, 10_000);
  // The trading rules once (15 min apart); TSLA, which the feed missed, over REST once a minute; NVDA never over REST.
  assert.equal(fake.calls.filter(call => call === 'markets').length, 1);
  assert.equal(fake.calls.filter(call => call === 'TSLA-USD.P').length, 11);
  assert.equal(fake.calls.filter(call => call === 'NVDA-USD.P').length, 0);
  const state = rewards.state(15);
  assert.deepEqual(state.feed, { at: T0 + 10 * 60_000, pushed: 1, of: 2, error: null });
  assert.equal(state.burstMs, 10_000); assert.equal(state.minReturns, 20);
  const [nvda, tsla] = state.markets;
  assert.equal(nvda!.listed, true); assert.equal(nvda!.makerFee, '0.0001'); assert.equal(nvda!.error, null);
  assert.equal(nvda!.source, 'ws'); assert.equal(nvda!.avg.samples, 11); assert.equal(nvda!.avg.snapshots, 108);
  assert.equal(nvda!.avg.to, T0 + 10 * 60_000 + 9900);
  // Returns: one 5 s one in each burst and one across each gap between bursts; the 1% step is one 5 s return.
  assert.equal(nvda!.returns, 21); close(nvda!.sigma1m! ** 2, 0.01 ** 2 * 12 / 21, 1e-8); // prices are rounded to 4 places
  // Our own resting sell is taken out of the depth: 6 left of 10 at the best ask; the average carries it too.
  assert.ok(nvda!.levels!.ask[0]!.oursUsd > 0); close(nvda!.depth5!.ask, 6 * (nvda!.ask ?? 0), 0.01);
  const avgAsk5 = nvda!.avg.ask.slice(0, 10).reduce((sum, value) => sum + value, 0);
  assert.ok(avgAsk5 > 6 * 100.01 - 0.01 && avgAsk5 < 6 * 101.015 + 0.01, String(avgAsk5));
  assert.equal(tsla!.listed, false); assert.equal(tsla!.source, 'rest');
  assert.equal(tsla!.avg.samples, 11); assert.equal(tsla!.avg.snapshots, 11);
  assert.equal(tsla!.returns, 10); assert.equal(tsla!.sigma1m, null);
  assert.equal(rewards.state(9999).windowMin, 60);
  // A failed read keeps the last levels and says why.
  fake.fail(); time.now += 10_000;
  const failed = await rewards.book('TSLA-USD.P');
  assert.match(failed.error!, /盘口读取失败：Ondo 接口出错（upstream）/); assert.ok(failed.levels);
  time.now += 3000;
  const newer = await rewards.book('TSLA-USD.P');
  assert.ok(newer.at! > tsla!.at!); assert.equal(newer.avg.to, tsla!.avg.to);
  rewards.close();
  assert.ok(fake.calls.includes('close'));
  // A new instance reads the saved settings.
  const again = createOndoRewards({ dataDir, clientFactory: () => fake.client, streamFactory: feed.factory, now: () => time.now });
  again.initialize();
  assert.equal(again.state().config.poolUsd, '1400'); assert.equal(again.state().revision, 1); assert.equal(again.state().loadError, null);
});

test('采集：逐市场核对推送及 REST 兜底的交易所时刻，迟到、超前和无时刻的盘口不能刷新分钟样本', async () => {
  const names = ['NVDA-USD.P', 'TSLA-USD.P', 'AMD-USD.P'], epoch = 1_800_000_000_000, time = { now: epoch };
  const feed = fakeFeeds(), fake = fakeClient(time), rule = { tick: '0.01', step: '0.01', makerFee: '0.0001', trading: true };
  const client = { ...fake.client, async markets() { return new Map(names.map(name => [name, rule])); },
    async depth(name: string) { const sample = await fake.client.depth(name); return { ...sample, time: name === names[1] ? time.now - 5001 : undefined }; } };
  const rewards = createOndoRewards({ dataDir: mkdtempSync(join(tmpdir(), 'tp-ondo-time-')), clientFactory: () => client, streamFactory: feed.factory, now: () => time.now });
  rewards.initialize(); rewards.save({ markets: names, poolUsd: '700', eligible: 3 });
  let done = false;
  await rewards.run({ stopped: () => done, pause: async ms => {
    time.now += ms;
    if (ms !== 1000) { done = true; return; }
    feed.push(names[0], 100, time.now); feed.push(names[1], 100, time.now, time.now - 2001); feed.push(names[2], 100, time.now, time.now + 2001);
  } });
  const markets = rewards.state(60).markets;
  assert.deepEqual(markets.map(m => m.avg.to), [epoch + 10_000, null, null]);
  assert.deepEqual(markets.map(m => m.avg.samples), [1, 0, 0]);
  assert.match(markets[1].error!, /时刻/); assert.match(markets[2].error!, /时刻/);
  rewards.close();
});

test('按需展开盘口时，缺少源时间的 REST 应答保留上次可信价格和时间并显示错误', async () => {
  const time = { now: 1_800_000_000_000 }, market = 'NVDA-USD.P', fake = fakeClient(time);
  let valid = true;
  const client = { ...fake.client, async depth() { return { ...book([level(valid ? '99' : '97', '1')], [level('101', '1')]), time: valid ? time.now : undefined }; } };
  const rewards = createOndoRewards({ dataDir: mkdtempSync(join(tmpdir(), 'tp-ondo-detail-')), clientFactory: () => client, now: () => time.now });
  rewards.initialize();
  try {
    const first = await rewards.book(market); assert.equal(first.bid, 99);
    time.now += 6000; valid = false;
    const second = await rewards.book(market);
    assert.equal(second.at, first.at); assert.equal(second.bid, 99); assert.match(second.error ?? '', /时刻缺失或过期/);
  } finally { rewards.close(); }
});

test('奖励推送断开时清除已显示和未采样的盘口，已完成的历史采样仍可查询', async () => {
  const time = { now: 1_800_000_000_000 }, name = 'NVDA-USD.P', fake = fakeClient(time), feed = fakeFeeds();
  const rewards = createOndoRewards({ dataDir: mkdtempSync(join(tmpdir(), 'tp-ondo-interrupted-')), clientFactory: () => fake.client, streamFactory: feed.factory, now: () => time.now });
  rewards.initialize(); rewards.save({ markets: [name], poolUsd: '700', eligible: 1 });
  let done = false, tick = 0;
  try {
    await rewards.run({ stopped: () => done, async pause(ms) {
      time.now += ms;
      if (ms !== 1000) { done = true; return; }
      if (++tick === 1) feed.push(name, 100, time.now);
      if (tick === 2) {
        assert.equal(rewards.state().markets[0].mid, 100);
        feed.push(name, 150, time.now);
        feed.feeds.at(-1)!.options.onDown!('disconnected');
      }
    } });
    const row = rewards.state().markets[0];
    assert.equal(row.mid, null); assert.equal(row.avg.samples, 1); assert.equal(row.avg.to, 1_800_000_001_000);
  } finally { rewards.close(); }
});

test('采集：推送全断时说明原因并全部走 REST；REST 撞上页面发起的读取时共用并记样本；停在推送中途关闭推送、不记样本', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tp-ondo-rewards-')), time = { now: 1_800_000_000_000 };
  let release: (() => void) | null = null;
  const fake = fakeClient(time), feed = fakeFeeds('connect_timeout');
  const slow = { ...fake.client, async depth(name: string, levels: number) {
    await new Promise<void>(resolve => { release = resolve; });
    return fake.client.depth(name, levels);
  } } as unknown as OndoClient;
  const rewards = createOndoRewards({ dataDir, clientFactory: () => slow, streamFactory: feed.factory, now: () => time.now });
  rewards.initialize();
  rewards.save({ markets: ['NVDA-USD.P'], poolUsd: '1000', eligible: 1 });
  const pageRead = rewards.book('NVDA-USD.P');
  await new Promise(resolve => setImmediate(resolve));
  const pauses: number[] = [];
  const cycle = rewards.run({ stopped: () => pauses.length >= 11, pause: async ms => { pauses.push(ms); time.now += ms; } });
  while (pauses.length < 10) await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  release!();
  await Promise.all([pageRead, cycle]);
  // One read served the page and the cycle, and it is the minute's sample.
  assert.equal(fake.calls.filter(call => call === 'NVDA-USD.P').length, 1);
  const view = rewards.state(15);
  assert.equal(view.markets[0]!.avg.samples, 1); assert.equal(view.markets[0]!.source, 'rest');
  assert.deepEqual(view.feed, { at: 1_800_000_000_000, pushed: 0, of: 1, error: 'connect_timeout' });
  assert.equal(pauses.at(-1), 50_000);

  // Stopping mid-burst: the feed is closed and the half minute is not a sample.
  const pushed = fakeFeeds(), dir = mkdtempSync(join(tmpdir(), 'tp-ondo-rewards-'));
  const halted = createOndoRewards({ dataDir: dir, clientFactory: () => fake.client, streamFactory: pushed.factory, now: () => time.now });
  halted.initialize();
  halted.save({ markets: ['NVDA-USD.P'], poolUsd: '1000', eligible: 1 });
  let ticks = 0;
  await halted.run({ stopped: () => ticks >= 3, pause: async ms => { time.now += ms; ticks += 1; pushed.push('NVDA-USD.P', 100, time.now); } });
  assert.equal(pushed.feeds.length, 1); assert.ok(pushed.feeds[0]!.closed);
  assert.equal(halted.state().markets[0]!.avg.samples, 0); assert.equal(halted.state().feed, null);
  assert.ok(halted.state().markets[0]!.levels);
  rewards.close(); halted.close();
});

test('采集：推送期间保存观察列表，移除的市场不写回、留下的照常记样本；关闭后迟到的推送不改盘口', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tp-ondo-rewards-')), time = { now: 1_800_000_000_000 };
  const fake = fakeClient(time), feed = fakeFeeds();
  const twoListed = { ...fake.client, async markets() { return new Map([['NVDA-USD.P', { tick: '0.01', step: '0.01', trading: true, makerFee: null }], ['TSLA-USD.P', { tick: '0.01', step: '0.01', trading: true, makerFee: null }]]); } } as unknown as OndoClient;
  const rewards = createOndoRewards({ dataDir, clientFactory: () => twoListed, streamFactory: feed.factory, now: () => time.now });
  rewards.initialize();
  rewards.save({ markets: ['NVDA-USD.P', 'TSLA-USD.P'], poolUsd: '1000', eligible: 2 });
  let ticks = 0, cycles = 0;
  await rewards.run({ stopped: () => cycles >= 1, pause: async ms => {
    time.now += ms;
    if (ms !== 1000) { cycles += 1; return; }
    ticks += 1;
    if (ticks === 3) rewards.save({ markets: ['NVDA-USD.P'], poolUsd: '1000', eligible: 1 });
    feed.push('NVDA-USD.P', 100, time.now); feed.push('TSLA-USD.P', 200, time.now);
  } });
  assert.deepEqual(feed.feeds[0]!.options.markets, ['NVDA-USD.P', 'TSLA-USD.P']);
  const view = rewards.state(15);
  assert.deepEqual(view.markets.map(item => item.market), ['NVDA-USD.P']);
  assert.equal(view.markets[0]!.avg.samples, 1); assert.equal(view.markets[0]!.avg.snapshots, 10);
  // TSLA is gone for good: adding it back starts empty, and it was not read over REST.
  assert.equal(fake.calls.filter(call => call === 'TSLA-USD.P').length, 0);
  rewards.save({ markets: ['NVDA-USD.P', 'TSLA-USD.P'], poolUsd: '1000', eligible: 2 });
  assert.equal(rewards.state(15).markets[1]!.avg.samples, 0); assert.equal(rewards.state(15).markets[1]!.levels, null);
  // A book the closed feed delivers late changes nothing.
  const before = rewards.state(15).markets[0]!.at;
  rewards.close();
  time.now += 1000; feed.push('NVDA-USD.P', 150, time.now);
  assert.equal(rewards.state(15).markets[0]!.at, before); assert.equal(rewards.state(15).markets[0]!.mid, 100);
});

test('采集：关闭后不再新建客户端；停在读交易规则时不再读盘口', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tp-ondo-rewards-')), time = { now: 1_800_000_000_000 };
  let created = 0, depths = 0;
  const aborts: (() => void)[] = [];
  const hanging = (): OndoClient => {
    created += 1;
    return { markets: () => new Promise((_, reject) => { aborts.push(() => reject(new OndoError('closed'))); }),
      async depth() { depths += 1; return book([level('99.99', '1')], [level('100.01', '1')]); },
      close() { for (const abort of aborts.splice(0)) abort(); } } as unknown as OndoClient;
  };
  const rewards = createOndoRewards({ dataDir, clientFactory: hanging, streamFactory: fakeFeeds().factory, now: () => time.now });
  rewards.initialize();
  let stopped = false;
  const cycle = rewards.run({ stopped: () => stopped, pause: async () => {} });
  await new Promise(resolve => setImmediate(resolve));
  stopped = true; rewards.close();
  await cycle;
  assert.equal(depths, 0); assert.equal(created, 1);
  await rewards.book('NVDA-USD.P');
  assert.equal(created, 1); assert.equal(depths, 0);
  assert.match(rewards.state().markets.find(item => item.market === 'NVDA-USD.P')!.error!, /closed/);
});

test('采集：盘口按需读取最多 2 秒一次；不在列表的市场拒绝；坏的设置文件退回默认值', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tp-ondo-rewards-')), time = { now: 1_800_000_000_000 };
  mkdirSync(join(dataDir, 'ondo-mm'));
  writeFileSync(join(dataDir, 'ondo-mm', 'rewards.json'), '{not json');
  const fake = fakeClient(time), lines: string[] = [];
  const rewards = createOndoRewards({ dataDir, clientFactory: () => fake.client, now: () => time.now, log: line => lines.push(line) });
  rewards.initialize();
  assert.match(rewards.state().loadError!, /无法读取/); assert.equal(rewards.state().config.markets.length, 20); assert.equal(lines.length, 1);
  await Promise.all([rewards.book('NVDA-USD.P'), rewards.book('NVDA-USD.P')]);
  await rewards.book('NVDA-USD.P');
  assert.equal(fake.calls.filter(call => call === 'NVDA-USD.P').length, 1);
  time.now += 6000;
  await rewards.book('NVDA-USD.P');
  assert.equal(fake.calls.filter(call => call === 'NVDA-USD.P').length, 2);
  // An on-demand read is not a sample.
  assert.equal(rewards.state().markets.find(item => item.market === 'NVDA-USD.P')!.avg.samples, 0);
  await assert.rejects(rewards.book('ABC-USD.P'), RewardInputError);
});

test('页面表单：默认值取挂单设置、浏览器里存的表单须完整、参数越界报字段', () => {
  const form = defaultSimForm({ orderUsd: '250', targetBps: '4.5', minBps: '3.5' });
  assert.deepEqual([form.sizeUsd, form.distanceBps, form.minBps, form.sides], ['250', '4.5', '3.5', '2']);
  assert.deepEqual(readSimForm(JSON.stringify(form)), form);
  assert.equal(readSimForm('{"sizeUsd":"1"}'), null); assert.equal(readSimForm('not json'), null); assert.equal(readSimForm(JSON.stringify({ ...form, sides: '3' })), null);
  const ok = simParams(form, { poolUsd: '125000', eligible: 20 });
  assert.ok('params' in ok); assert.equal(ok.params.uptime, 0.95); assert.equal(ok.params.poolUsd, 125_000);
  const bad = (change: Partial<SimForm>) => { const result = simParams({ ...form, ...change }, { poolUsd: '1', eligible: 1 }); return 'error' in result ? result.error : null; };
  assert.equal(bad({ minBps: '5' }), '最近距离不能大于挂单距离');
  assert.equal(bad({ reactionSec: '0' }), '撤单反应时间须为 0.05–600');
  assert.equal(bad({ sizeUsd: '' }), '每单金额须为 0–10000000');
  const request = rewardConfigRequest({ markets: 'nvda-usd.p，TSLA-USD.P、 nvda-usd.p', poolUsd: '125,000', eligible: '20' });
  assert.deepEqual(request, { body: { markets: ['NVDA-USD.P', 'TSLA-USD.P'], poolUsd: '125000', eligible: 20 } });
  assert.deepEqual(rewardConfigRequest({ markets: 'NVDA', poolUsd: '1', eligible: '1' }), { error: '市场代码 NVDA 无效（如 NVDA-USD.P）' });
  assert.deepEqual(rewardConfigRequest({ markets: 'NVDA-USD.P', poolUsd: '0', eligible: '1' }), { error: '每周奖池须为大于 0 的美元数' });
});
