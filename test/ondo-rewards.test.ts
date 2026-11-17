// The Ondo reward view (docs/ondo.md §5–§6): the income model, the depth digest, the one-minute volatility, the collector
// against a fake Ondo client, and the page's forms. Nothing reaches Ondo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BANDS, bandOf, bandScores, fillsPerDay, normalCdf, simulate, sweep, type SimMarket, type SimParams } from '../src/ondo/reward-sim.ts';
import { BUCKETS } from '../src/ondo/reward-types.ts';
import { createOndoRewards, digest, minuteVolatility, REWARD_MARKETS, RewardInputError, validateRewardConfig } from '../src/ondo/rewards.ts';
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

test('波动：只算间隔 30–120 秒的收益，按分钟折算，不足 10 个为空', () => {
  const samples = Array.from({ length: 12 }, (_, i) => ({ at: i * 60_000, mid: 100 * Math.exp(0.001 * i) }));
  const measured = minuteVolatility(samples);
  assert.equal(measured.returns, 11); close(measured.sigma1m!, 0.001);
  // A two-minute gap counts as one return scaled to a minute; a 10 s and a 5 min gap do not count.
  const gappy = [{ at: 0, mid: 100 }, { at: 10_000, mid: 101 }, { at: 130_000, mid: 101 * Math.exp(0.002) }, { at: 430_000, mid: 200 }];
  const result = minuteVolatility(gappy);
  assert.equal(result.returns, 1); assert.equal(result.sigma1m, null);
  assert.equal(minuteVolatility(samples.slice(0, 10)).sigma1m, null);
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
      return book([level((mid - 0.01).toFixed(4), '10'), level((mid - 0.03).toFixed(4), '20')], [level((mid + 0.01).toFixed(4), '10')], name);
    },
    close() { calls.push('close'); },
  };
  return { client: client as unknown as OndoClient, calls, fail: () => { failNext = true; } };
}

test('采集：轮流读取各市场、按窗口平均、计算波动；设置保存在数据目录', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tp-ondo-rewards-')), time = { now: 1_800_000_000_000 };
  const fake = fakeClient(time);
  const rewards = createOndoRewards({ dataDir, clientFactory: () => fake.client, now: () => time.now,
    restingOrders: () => [{ market: 'NVDA-USD.P', side: 'sell', price: (100 * Math.exp(0.001 * Math.round((time.now - 1_800_000_000_000) / 60_000)) + 0.01).toFixed(4), size: '4' }] });
  rewards.initialize();
  assert.equal(rewards.state().markets.length, 20); assert.equal(rewards.state().revision, 0);
  assert.throws(() => rewards.save({ markets: [] }), RewardInputError);
  const saved = rewards.save({ markets: ['NVDA-USD.P', 'TSLA-USD.P'], poolUsd: '1400', eligible: 2 });
  assert.equal(saved.revision, 1); assert.deepEqual(saved.markets.map(item => item.market), ['NVDA-USD.P', 'TSLA-USD.P']);
  assert.equal(JSON.parse(readFileSync(join(dataDir, 'ondo-mm', 'rewards.json'), 'utf8')).config.poolUsd, '1400');
  // 2 markets: one read every 30 s, each market once a minute; 44 rounds = 22 samples each.
  let rounds = 0;
  await rewards.run({ stopped: () => rounds >= 44, pause: async ms => { assert.equal(ms, 30_000); time.now += ms; rounds += 1; } });
  // The trading rules are read at the start and again after 15 minutes.
  assert.equal(fake.calls.filter(call => call === 'markets').length, 2);
  assert.equal(fake.calls.filter(call => call === 'NVDA-USD.P').length, 22);
  const view = rewards.state(15).markets[0]!;
  assert.equal(view.listed, true); assert.equal(view.makerFee, '0.0001');
  assert.equal(view.error, null);
  assert.equal(view.avg.samples, 15); assert.equal(view.returns, 14); close(view.sigma1m!, 0.001, 1e-6);
  // Our own resting sell is taken out of the depth: 6 left of 10 at the best ask.
  assert.equal(view.levels!.ask[0]!.oursUsd > 0, true); close(view.depth5!.ask, 6 * (view.ask ?? 0), 0.01);
  assert.equal(rewards.state(9999).windowMin, 60);
  assert.equal(rewards.state().markets[1]!.listed, false);
  // A failed read keeps the last levels and says why.
  fake.fail(); time.now += 10_000;
  const failed = await rewards.book('NVDA-USD.P');
  assert.match(failed.error!, /盘口读取失败：Ondo 接口出错（upstream）/); assert.ok(failed.levels);
  rewards.close();
  assert.ok(fake.calls.includes('close'));
  // A new instance reads the saved settings.
  const again = createOndoRewards({ dataDir, clientFactory: () => fake.client, now: () => time.now });
  again.initialize();
  assert.equal(again.state().config.poolUsd, '1400'); assert.equal(again.state().revision, 1); assert.equal(again.state().loadError, null);
});

test('采集：读取耗时计入每步间隔；循环撞上页面发起的读取时仍记一个样本', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tp-ondo-rewards-')), time = { now: 1_800_000_000_000 };
  let release: (() => void) | null = null;
  const fake = fakeClient(time);
  const slow = { ...fake.client, async depth(name: string, levels: number) {
    await new Promise<void>(resolve => { release = resolve; });
    time.now += 400;
    return fake.client.depth(name, levels);
  } } as unknown as OndoClient;
  const rewards = createOndoRewards({ dataDir, clientFactory: () => slow, now: () => time.now });
  rewards.initialize();
  rewards.save({ markets: ['NVDA-USD.P'], poolUsd: '1000', eligible: 1 });
  const pageRead = rewards.book('NVDA-USD.P');
  await new Promise(resolve => setImmediate(resolve));
  const pauses: number[] = [];
  const cycle = rewards.run({ stopped: () => pauses.length >= 1, pause: async ms => { pauses.push(ms); } });
  await new Promise(resolve => setImmediate(resolve));
  release!();
  await Promise.all([pageRead, cycle]);
  // One read served both; the cycle's step (60 s for one market) less the 400 ms it took.
  assert.equal(fake.calls.filter(call => call === 'NVDA-USD.P').length, 1);
  assert.equal(rewards.state(15).markets[0]!.avg.samples, 1);
  assert.deepEqual(pauses, [59_600]);
  rewards.close();
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
