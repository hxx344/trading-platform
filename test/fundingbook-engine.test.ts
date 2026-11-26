import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFundingBookEngine, FundingBookError, type MarketSource, type SourceQuote } from '../src/fundingbook/engine.ts';
import { DEFAULT_SETTINGS, SettingsError, type Settings } from '../src/fundingbook/model.ts';
import { DAY, HOUR } from '../src/fundingbook/stats.ts';
import { openFundingBookStore } from '../src/fundingbook/store.ts';

const START = Date.UTC(2026, 0, 15, 12, 30);
// 每条腿的年化资金费（多头付为正）：Lighter 的 BTC 明显高，其余接近；ETH 各所几乎一样（没有息差）。
const APR: Record<string, Record<string, number>> = {
  lighter: { BTC: 0.10, ETH: 0.03 }, bybit: { BTC: 0.0144, ETH: 0.03 }, bitget: { BTC: 0.0283, ETH: 0.031 }, okx: { BTC: 0.02, ETH: 0.03 },
};
const PRICE: Record<string, number> = { BTC: 100_000, ETH: 3_000 };
const interval = (venue: string): number => venue === 'lighter' ? HOUR : 8 * HOUR;
const symbolOf = (venue: string, base: string): string => venue === 'lighter' ? base : venue === 'okx' ? `${base}-USDT-SWAP` : `${base}USDT`;

/** 确定的伪随机小时收益：ETH 与 BTC 高度相关。 */
function closes(base: string, from: number, to: number): { time: number; close: number }[] {
  const points: { time: number; close: number }[] = [];
  for (let time = Math.floor(from / HOUR) * HOUR + HOUR; time <= to; time += HOUR) {
    const k = time / HOUR, common = Math.sin(k * 1.7) + Math.sin(k * 0.37), own = Math.sin(k * 2.9 + 1);
    const level = base === 'BTC' ? common : 1.2 * common + 0.3 * own;
    points.push({ time, close: PRICE[base]! * Math.exp(0.004 * level) });
  }
  return points;
}

interface FakeOptions {
  fail?: (venue: string, symbol: string) => boolean;
  price?: (venue: string, base: string) => number;
  onFunding?: (venue: string, range: { from: number; to: number }) => void;
}
function fakeMarket(clock: () => number, options: FakeOptions = {}) {
  const calls = { funding: 0, price: 0 };
  let running = true;
  /** 下一次资金费读取在途时调用 `hung`（它在里面保存参数，读取随即被中止）。 */
  let hung: ((signal: AbortSignal) => void) | null = null;
  const priceOf = (venue: string, base: string): number => options.price?.(venue, base) ?? PRICE[base]!;
  const quotes = (): SourceQuote[] => Object.keys(APR).flatMap(venue => Object.keys(PRICE).map((base): SourceQuote => ({
    exchange: venue, symbol: symbolOf(venue, base), base, quoteCurrency: venue === 'lighter' ? 'USDC' : 'USDT',
    bid: priceOf(venue, base) - 1, ask: priceOf(venue, base) + 1, mark: priceOf(venue, base), last: priceOf(venue, base),
    fundingRate: APR[venue]![base]! / 8760 * interval(venue) / HOUR, fundingIntervalHours: interval(venue) / HOUR,
  })));
  const baseOf = (symbol: string): string => symbol.startsWith('BTC') ? 'BTC' : 'ETH';
  const source: MarketSource = {
    running: () => running,
    quotes,
    async funding(venue, symbol, range, signal) {
      calls.funding += 1;
      options.onFunding?.(venue, range);
      if (hung) {
        const check = hung; hung = null;
        await Promise.resolve();
        check(signal);
        throw signal.reason ?? new Error('读取没有被中止');
      }
      assert.ok(range.to <= clock() && range.from <= range.to, '资金费查询范围不能越过现在');
      assert.ok(range.to - range.from <= (venue === 'bitget' ? 32 : 4) * DAY, `${venue} 的资金费一次查询超过了读取器允许的长度`);
      if (options.fail?.(venue, symbol)) throw new Error('场所没有应答');
      const step = interval(venue), rate = APR[venue]![baseOf(symbol)]! / 8760 * step / HOUR, records = [];
      for (let time = Math.ceil(range.from / step) * step; time <= range.to; time += step) records.push({ time, rate });
      return records;
    },
    async price(venue, symbol, range) {
      calls.price += 1;
      assert.ok(range.from % HOUR === 0 && range.to % HOUR === 0 && range.to <= clock() && range.to - range.from <= 30 * DAY, '价格查询范围须为整点且不超过 30 天');
      return closes(baseOf(symbol), range.from, range.to);
    },
  };
  return { source, calls, stop: () => { running = false; }, hang: (check: (signal: AbortSignal) => void) => { hung = check; } };
}

const settingsFor = (patch: Partial<Settings> = {}): Settings => ({ ...structuredClone(DEFAULT_SETTINGS), enabled: true, bases: ['BTC', 'ETH'], ...patch });

function harness(t: { after(fn: () => void): void }, options: FakeOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fundingbook-'));
  const store = openFundingBookStore(join(dir, 'fundingbook.sqlite'));
  t.after(() => { try { store.close(); } catch { /* 已关 */ } rmSync(dir, { recursive: true, force: true }); });
  let time = START;
  const market = fakeMarket(() => time, options);
  const engine = createFundingBookEngine({ store, source: () => market.source, now: () => time });
  /** 跑循环直到条件满足；每次暂停算一轮，超过上限就失败。 */
  async function until(done: () => boolean, limit = 40): Promise<void> {
    let turns = 0;
    await engine.loop({ stopped: () => done() || turns >= limit, pause: async () => { turns += 1; } });
    assert.ok(done(), `循环 ${limit} 轮后条件仍未满足`);
  }
  return { engine, store, market, until, advance: (ms: number) => { time += ms; }, now: () => time };
}

test('未启用时不采集也不规划', async t => {
  const { engine, market } = harness(t);
  let turns = 0;
  await engine.loop({ stopped: () => turns >= 3, pause: async () => { turns += 1; } });
  assert.equal(market.calls.funding + market.calls.price, 0);
  assert.equal(engine.views.state().round, null);
  assert.equal(engine.views.state().settings.enabled, false);
});

test('回补完成后规划一轮并记入模拟盘：在 Lighter 做空 BTC，各标的各账户合计为零', async t => {
  const { engine, until } = harness(t);
  engine.views.settings(settingsFor());
  await until(() => engine.views.state().round !== null);
  const state = engine.views.state();
  assert.equal(state.collect.done, state.collect.total);
  assert.deepEqual(state.collect.errors, []);
  assert.equal(state.legs.length, 8);
  const lighterBtc = state.legs.find(leg => leg.venue === 'lighter' && leg.base === 'BTC')!;
  assert.equal(lighterBtc.note, null);
  assert.ok(Math.abs(lighterBtc.adjustedApr! - 0.10) < 0.002, `调整均值应接近 10%，实际 ${lighterBtc.adjustedApr}`);
  assert.ok(lighterBtc.longApr !== null && lighterBtc.settlements > 200);
  assert.deepEqual(state.risk!.bases, ['BTC', 'ETH']);
  assert.ok(state.risk!.corr[0]![1]! > 0.8);

  const round = state.round!;
  assert.equal(round.applied, true);
  const lighter = round.accounts.find(account => account.id === 'lighter-1')!;
  const btc = lighter.positions.find(position => position.base === 'BTC')!;
  assert.ok(btc.notional < -10_000, `Lighter 的 BTC 应是空头，实际 ${btc.notional}`);
  for (const base of ['BTC', 'ETH']) {
    const net = round.accounts.reduce((sum, account) => sum + (account.positions.find(position => position.base === base)?.notional ?? 0), 0);
    assert.ok(Math.abs(net) < 1e-6, `${base} 各账户合计应为零，实际 ${net}`);
  }
  assert.ok(round.expectedApr > 0.05, `预期年化应明显为正，实际 ${round.expectedApr}`);
  for (const account of round.accounts) if (account.distance !== null) assert.ok(account.distance >= state.settings.safetySigma - 1e-6, `${account.id} 的安全距离 ${account.distance} 低于下限`);
  assert.ok(round.accounts.reduce((sum, account) => sum + account.required, 0) <= round.capital * (1 - state.settings.reservePct / 100) + 1e-6);

  // 步骤顺序：第一轮没有减仓，划转在加仓之前。
  const kinds = round.steps.map(step => step.kind);
  assert.ok(kinds.includes('transfer') && kinds.lastIndexOf('transfer') < kinds.indexOf('order'));
  const book = state.book!;
  assert.ok(Math.abs(book.equity! - (10_000 - book.fees)) < 1e-6, '模拟盘权益应等于本金减手续费');
  assert.ok(book.fees > 0 && book.accounts.find(account => account.id === 'lighter-1')!.positions[0]!.qty < 0);
  assert.equal(state.rounds.length, 1);
  assert.deepEqual(engine.views.round(round.id), round);
});

test('下一轮计入新结算的资金费，目标不变时不再出订单', async t => {
  const { engine, until, advance } = harness(t);
  engine.views.settings(settingsFor());
  await until(() => engine.views.state().round !== null);
  const first = engine.views.state().round!;
  advance(8 * HOUR + 60_000);
  await until(() => (engine.views.state().round?.id ?? 0) > first.id);
  const state = engine.views.state(), second = state.round!;
  assert.ok(state.book!.funding > 0, `空头收到的资金费应为正，实际 ${state.book!.funding}`);
  // 8 小时、10% 减 1.44%~2.83% 的息差：量级核对。
  const btc = Math.abs(first.accounts.find(account => account.id === 'lighter-1')!.positions.find(position => position.base === 'BTC')!.notional);
  assert.ok(state.book!.funding > btc * 0.06 * 8 / 8760 && state.book!.funding < btc * 0.11 * 9 / 8760, `资金费 ${state.book!.funding} 与仓位 ${btc} 的量级对不上`);
  assert.deepEqual(second.steps, [], '仓位已在目标上、各账户资金都够：不出订单也不划转');
});

test('一条腿读不到资金费时这条腿不参与，其余照常规划', async t => {
  const { engine, until } = harness(t, { fail: venue => venue === 'lighter' });
  engine.views.settings(settingsFor());
  await until(() => engine.views.state().round !== null);
  const state = engine.views.state();
  assert.ok(state.collect.errors.some(text => text.includes('lighter')));
  assert.match(state.legs.find(leg => leg.venue === 'lighter' && leg.base === 'BTC')!.note ?? '', /读取失败/);
  assert.equal(state.round!.accounts.find(account => account.id === 'lighter-1')!.positions.length, 0);
});

test('监控停止后不再读取；删掉仍有资金的账户被拒绝；重置清空模拟盘与规划', async t => {
  const { engine, until, market } = harness(t);
  engine.views.settings(settingsFor());
  await until(() => engine.views.state().round !== null);
  market.stop();
  const before = market.calls.funding + market.calls.price;
  let turns = 0;
  await engine.loop({ stopped: () => turns >= 3, pause: async () => { turns += 1; } });
  assert.equal(market.calls.funding + market.calls.price, before);
  assert.equal(engine.views.state().running, false);
  assert.equal(engine.views.state().book!.equity, null, '没有行情时不给权益');

  const fewer = settingsFor();
  fewer.accounts = fewer.accounts.filter(account => account.id !== 'lighter-1');
  assert.throws(() => engine.views.settings(fewer), (error: unknown) => error instanceof FundingBookError && error.code === 'account_in_use');
  assert.throws(() => engine.views.settings({ ...settingsFor(), capital: -1 }), SettingsError);
  assert.throws(() => engine.views.reset({}), (error: unknown) => error instanceof FundingBookError && error.status === 400);
  const cleared = engine.views.reset({ confirm: true });
  assert.equal(cleared.book, null);
  assert.equal(cleared.round, null);
  assert.deepEqual(cleared.rounds, []);
  assert.doesNotThrow(() => engine.views.settings(fewer));
  assert.throws(() => engine.views.round(1), (error: unknown) => error instanceof FundingBookError && error.status === 404);
});

test('重新打开库后沿用参数、模拟盘与上一轮规划', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'fundingbook-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'fundingbook.sqlite'), market = fakeMarket(() => START);
  const store = openFundingBookStore(file);
  const engine = createFundingBookEngine({ store, source: () => market.source, now: () => START });
  engine.views.settings(settingsFor());
  let turns = 0;
  await engine.loop({ stopped: () => engine.views.state().round !== null || turns >= 40, pause: async () => { turns += 1; } });
  const saved = engine.views.state();
  assert.ok(saved.round);
  store.close();
  const reopened = openFundingBookStore(file);
  try {
    const again = createFundingBookEngine({ store: reopened, source: () => market.source, now: () => START }).views.state();
    assert.deepEqual(again.settings, saved.settings);
    assert.deepEqual(again.round, saved.round);
    assert.deepEqual(again.book, saved.book);
  } finally { reopened.close(); }
});

test('价格与基差漂移：仓位还在目标附近时不出订单，各标的的数量合计为零', async t => {
  let shift = 1;
  const basis: Record<string, number> = { lighter: 1, bybit: 1, bitget: 1, okx: 1 };
  const { engine, until, advance } = harness(t, { price: (venue, base) => PRICE[base]! * shift * basis[venue]! });
  engine.views.settings(settingsFor());
  await until(() => engine.views.state().round !== null);
  const first = engine.views.state().round!;
  const quantity = (base: string) => engine.views.state().book!.accounts.reduce((sum, account) => sum + (account.positions.find(position => position.base === base)?.qty ?? 0), 0);
  for (const [move, spread] of [[0.985, 1.001], [0.99, 0.999], [0.98, 1.0015]] as const) {
    shift = move; basis.lighter = spread;
    advance(HOUR + 60_000);
    const last = engine.views.state().round!.id;
    await until(() => engine.views.state().round!.id > last);
    const round = engine.views.state().round!;
    assert.deepEqual(round.steps.filter(step => step.kind === 'order'), [], `价格 ${move}、基差 ${spread} 时不该出订单`);
    for (const base of ['BTC', 'ETH']) assert.ok(Math.abs(quantity(base)) * PRICE[base]! < 1, `${base} 的数量合计 ${quantity(base)}`);
  }
  assert.ok(first.steps.length > 0);
});

test('增量刷新回看两小时；保存参数中止在途读取时不记成失败', async t => {
  const ranges: { venue: string; from: number; to: number }[] = [];
  const h = harness(t, { onFunding: (venue, range) => { ranges.push({ venue, ...range }); } });
  h.engine.views.settings(settingsFor());
  await h.until(() => h.engine.views.state().round !== null);
  const covered = h.store.coverage('funding:lighter:BTC')!.to!;
  ranges.length = 0;
  h.advance(11 * 60_000);
  const before = h.engine.views.state().round!.id;
  h.engine.views.plan();
  await h.until(() => h.engine.views.state().round!.id > before);
  const again = ranges.find(range => range.venue === 'lighter')!;
  assert.equal(again.from, covered - 2 * HOUR, '从上次读到的时刻往回两小时重读');

  // 读取进行到一半时保存参数：在途请求被中止，覆盖范围里不留错误，也不退避。
  h.advance(11 * 60_000);
  let saved = false;
  h.market.hang(signal => { if (!saved) { saved = true; h.engine.views.settings(settingsFor({ horizonDays: 60 })); } assert.equal(signal.aborted, true); });
  const id = h.engine.views.state().round!.id;
  await h.until(() => h.engine.views.state().round!.id > id);
  assert.equal(saved, true);
  assert.deepEqual(h.engine.views.state().collect.errors, []);
});

test('模拟盘里有持仓的账户不能换场所；一条有持仓的腿读不到资金费时这个标的保持不动', async t => {
  let broken = false;
  const { engine, until, advance } = harness(t, { fail: venue => broken && venue === 'lighter' });
  engine.views.settings(settingsFor());
  await until(() => engine.views.state().round !== null);
  const first = engine.views.state().round!;
  const swapped = settingsFor();
  swapped.accounts = swapped.accounts.map(account => account.id === 'lighter-1' ? { ...account, venue: 'hyperliquid' as const } : account);
  assert.throws(() => engine.views.settings(swapped), (error: unknown) => error instanceof FundingBookError && error.code === 'account_in_use');

  broken = true;
  advance(7 * HOUR);
  await until(() => engine.views.state().round!.id > first.id, 80);
  const state = engine.views.state(), round = state.round!;
  assert.match(state.legs.find(leg => leg.venue === 'lighter' && leg.base === 'BTC')!.note ?? '', /过期/);
  assert.deepEqual(round.steps.filter(step => step.kind === 'order'), [], '数据过期不该把仓位平掉');
  assert.ok(state.book!.accounts.find(account => account.id === 'lighter-1')!.positions.some(position => position.base === 'BTC' && position.qty < 0));
});

test('停了将近四天再刷新：单次资金费查询不超过读取器的段长', async t => {
  const h = harness(t);
  h.engine.views.settings(settingsFor());
  await h.until(() => h.engine.views.state().round !== null);
  const first = h.engine.views.state().round!.id;
  h.advance(4 * DAY - 90 * 60_000);
  await h.until(() => h.engine.views.state().round!.id > first, 80);
  assert.deepEqual(h.engine.views.state().collect.errors, []);
});
