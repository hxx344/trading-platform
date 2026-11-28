import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createFundingBookEngine, FundingBookError, type FundingBookEngine, type MarketSource, type SourceQuote } from '../src/fundingbook/engine.ts';
import { DEFAULT_SETTINGS, SettingsError, type Settings } from '../src/fundingbook/model.ts';
import { DAY, HOUR } from '../src/fundingbook/stats.ts';
import { openFundingBookStore, type FundingBookStore } from '../src/fundingbook/store.ts';

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
  includeClose?: (base: string, time: number) => boolean;
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
      const base = baseOf(symbol);
      return closes(base, range.from, range.to).filter(point => options.includeClose?.(base, point.time) ?? true);
    },
  };
  return { source, calls, stop: () => { running = false; }, hang: (check: (signal: AbortSignal) => void) => { hung = check; } };
}

const settingsFor = (patch: Partial<Settings> = {}): Settings => ({ ...structuredClone(DEFAULT_SETTINGS), enabled: true, bases: ['BTC', 'ETH'], ...patch });

function harness(t: { after(fn: () => void): void }, options: FakeOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fundingbook-'));
  const file = join(dir, 'fundingbook.sqlite'), store = openFundingBookStore(file);
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
  return { engine, store, file, market, until, advance: (ms: number) => { time += ms; }, now: () => time };
}

async function oneTick(engine: FundingBookEngine): Promise<void> {
  let paused = false;
  await engine.loop({ stopped: () => paused, pause: async () => { paused = true; } });
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

for (const missing of [false, true]) test(`保存 7 天参数后从行情回补整点锚点，${missing ? '缺锚点的 BTC 禁止开仓' : '168 个收益可开仓'}`, async t => {
  const anchor = Math.floor(START / HOUR) * HOUR - 7 * DAY;
  const h = harness(t, { includeClose: (base, time) => !(missing && base === 'BTC' && time === anchor) });
  h.engine.views.settings(settingsFor({ volDays: 7 }));
  await h.until(() => h.engine.views.state().round !== null);
  const state = h.engine.views.state();
  assert.equal(h.store.coverage('price:BTC:bybit:BTCUSDT')?.from, anchor - HOUR);
  assert.equal(state.risk!.samples[state.risk!.bases.indexOf('ETH')], 168);
  const btc = state.legs.find(leg => leg.base === 'BTC')!;
  assert.equal(btc.note, missing ? '价格样本不足，没进风险模型' : null);
  assert.equal(state.round!.steps.some(step => step.base === 'BTC'), !missing);
  assert.equal(state.book!.accounts.some(account => account.positions.some(p => p.base === 'BTC')), !missing);
});

for (const cause of ['小时历史缺失', '共同收益不足', '缩短窗口', '移出已持有标的']) test(`已有 BTC 持仓：${cause}导致风险未知时暂停，样本恢复后继续`, async t => {
  const h = harness(t);
  const settings = settingsFor();
  h.engine.views.settings(settings);
  await h.until(() => h.engine.views.state().round !== null);
  const before = h.engine.views.state(), savedBook = h.store.book();
  assert.ok(before.book!.accounts.some(a => a.positions.some(p => p.base === 'BTC')));
  const db = new DatabaseSync(h.file);
  try {
    const end = Math.floor(h.now() / HOUR) * HOUR;
    if (cause === '共同收益不足') {
      // 两个标的各自都有足够的收益，区间互不重叠。BTC 的可用收益较少，被共同样本筛选剔除。
      db.prepare("DELETE FROM prices WHERE base='BTC' AND time NOT BETWEEN ? AND ?").run(end - 700 * HOUR, end - 500 * HOUR);
      db.prepare("DELETE FROM prices WHERE base='ETH' AND time < ?").run(end - 400 * HOUR);
    } else if (cause === '缩短窗口') {
      db.prepare("DELETE FROM prices WHERE base='BTC' AND time >= ?").run(end - 8 * DAY);
      h.engine.views.settings({ ...settings, volDays: 7 });
    } else {
      db.exec("DELETE FROM prices WHERE base='BTC'");
      if (cause === '移出已持有标的') h.engine.views.settings({ ...settings, bases: ['ETH'], accounts: [...settings.accounts, { ...settings.accounts[0]!, id: 'constructor', venue: 'hyperliquid' }] });
    }
    h.engine.views.plan();
    await oneTick(h.engine);
    const blocked = h.engine.views.state();
    assert.match(blocked.roundError ?? '', /BTC.*风险与所需资金未知/);
    assert.equal(blocked.round, null);
    assert.deepEqual(blocked.rounds, before.rounds);
    assert.deepEqual(h.engine.views.round(before.round!.id), before.round);
    assert.deepEqual(blocked.book, before.book);
    assert.deepEqual(h.store.book(), savedBook);
    assert.deepEqual(blocked.risk!.bases, ['ETH']);
    // 后续行情再次给足 7 天收益与锚点，依靠引擎的正常刷新恢复，不重置覆盖记录或模拟盘。
    h.advance(8 * DAY);
    h.engine.views.plan();
    await h.until(() => (h.engine.views.state().round?.id ?? 0) > before.round!.id);
    const recovered = h.engine.views.state();
    assert.equal(recovered.roundError, null);
    assert.ok(recovered.risk!.bases.includes('BTC'));
    if (cause === '移出已持有标的') {
      const btc = recovered.round!.steps.filter(step => step.base === 'BTC');
      assert.ok(btc.length && btc.every(step => step.reduce && step.close));
      assert.ok(recovered.book!.accounts.every(a => a.positions.every(p => p.base !== 'BTC')));
    } else assert.ok(recovered.round!.required > 0);
  } finally { db.close(); }
});

/** 在独立临时库先规划出真实的模拟持仓与轮次，再停引擎、注入坏记录并重新打开同一个库。 */
async function persistedFixture(t: { after(fn: () => void): void }, paperAuto = true) {
  const h = harness(t);
  h.engine.views.settings(settingsFor({ bases: ['BTC'], volDays: 7 }));
  await h.until(() => !!h.engine.views.state().round);
  h.engine.views.settings({ ...h.engine.views.state().settings, paperAuto });
  const saved = h.engine.views.state();
  h.engine.quiesce(); h.store.close();
  const db = new DatabaseSync(h.file), logs: string[] = [];
  let store: FundingBookStore | null = null;
  const restart = () => {
    store?.close(); store = openFundingBookStore(h.file);
    return createFundingBookEngine({ store, source: () => h.market.source, now: h.now, log: message => logs.push(message) });
  };
  const snapshot = () => ({
    state: db.prepare('SELECT key, json, updated_at FROM state ORDER BY key').all(),
    rounds: db.prepare('SELECT id, at, summary, detail FROM rounds ORDER BY id').all(),
  });
  return { saved, db, logs, market: h.market, restart, snapshot, close: () => { store?.close(); db.close(); } };
}

const stateUnavailable = (error: unknown) => error instanceof FundingBookError && error.code === 'state_unavailable';
const accountInUse = (error: unknown) => error instanceof FundingBookError && error.code === 'account_in_use';

for (const paperAuto of [true, false]) test(`损坏账本在 paperAuto=${paperAuto} 时保留原始记录，仅确认重置后从新轮次继续`, async t => {
  const f = await persistedFixture(t, paperAuto);
  try {
    const put = f.db.prepare("UPDATE state SET json=? WHERE key='book'");
    const original = JSON.parse(f.db.prepare("SELECT json FROM state WHERE key='book'").get()!.json as string);
    const first = original.accounts['lighter-1'];
    const badAcct = (account: unknown) => JSON.stringify({ ...original, accounts: { ...original.accounts, 'lighter-1': account } });
    const cases = [
      ['{"PRIVATE_MARKER"', 'JSON 损坏'], ['null', '结构'], [JSON.stringify({ ...original, PRIVATE_MARKER: 2 }), '不支持'],
      [badAcct({ ...first, positions: [] }), '结构'], [badAcct({ ...first, fees: -1 }), '结构'],
      [badAcct({ ...first, positions: { BTC: { ...first.positions.BTC, entry: 0 } } }), '结构'],
      [badAcct({ ...first, positions: { BTC: { ...first.positions.BTC, PRIVATE_MARKER: true } } }), '不支持'],
    ] as const;
    for (const [raw, reason] of cases) {
      put.run(raw);
      const before = f.snapshot(), engine = f.restart(), state = engine.views.state();
      assert.match(state.recovery.book ?? '', new RegExp(reason));
      assert.match(state.roundError ?? '', /模拟账本不可用/);
      assert.equal(state.nextRoundAt, null); assert.equal(state.round, null); assert.equal(state.book, null);
      assert.deepEqual(state.rounds, f.saved.rounds);
      assert.deepEqual(engine.views.round(f.saved.round!.id), f.saved.round);
      assert.throws(() => engine.views.plan(), stateUnavailable);
      assert.throws(() => engine.views.reset({ confirm: false }), FundingBookError);
      await oneTick(engine);
      assert.deepEqual(f.snapshot(), before);
      assert.doesNotMatch(state.roundError!, /PRIVATE_MARKER/);
    }
    assert.equal(f.logs.length, cases.length); assert.doesNotMatch(f.logs.join(' '), /PRIVATE_MARKER/);
    f.db.exec("DELETE FROM state WHERE key='book'");
    const engine = f.restart();
    assert.match(engine.views.state().recovery.book ?? '', /已有规划历史.*缺少账本/);
    assert.throws(() => engine.views.plan(), stateUnavailable);
    const reset = engine.views.reset({ confirm: true });
    assert.deepEqual(reset.rounds, []); assert.equal(reset.recovery.book, null);
    engine.views.plan(); await oneTick(engine);
    const fresh = engine.views.state();
    assert.ok(fresh.round!.id > f.saved.round!.id);
    assert.equal(fresh.round!.applied, paperAuto);
    assert.equal(fresh.rounds.length, 1);
  } finally { f.close(); }
});

test('参数损坏只接受确认保存，完整账本继续可查，保留已占用账户和原场所并允许新增空账户', async t => {
  const f = await persistedFixture(t);
  try {
    const put = f.db.prepare("UPDATE state SET json=? WHERE key='settings'");
    for (const [raw, reason] of [['{"PRIVATE_MARKER"', 'JSON 损坏'], ['{}', '结构'], [JSON.stringify({ ...f.saved.settings, PRIVATE_MARKER: 3 }), '不支持']]) {
      put.run(raw!);
      const engine = f.restart(), state = engine.views.state(), before = f.snapshot();
      assert.match(state.recovery.settings ?? '', new RegExp(reason!));
      assert.match(state.roundError ?? '', /参数不可用/);
      assert.doesNotMatch(state.roundError!, /PRIVATE_MARKER/);
      assert.ok(state.book!.accounts.some(account => account.positions.length));
      assert.equal(state.book!.equity, null);
      assert.deepEqual(state.rounds, f.saved.rounds);
      assert.throws(() => engine.views.plan(), stateUnavailable);
      assert.throws(() => engine.views.settings(f.saved.settings), /确认保存/);
      assert.throws(() => engine.views.settings({ confirm: true, settings: {} }), SettingsError);
      await oneTick(engine);
      assert.deepEqual(f.snapshot(), before);
    }
    assert.doesNotMatch(f.logs.join(' '), /PRIVATE_MARKER/);
    f.db.exec("DELETE FROM state WHERE key='settings'");
    const engine = f.restart(), settings = f.saved.settings, before = f.snapshot();
    assert.match(engine.views.state().recovery.settings ?? '', /缺少参数/);
    const recover = (changes: Partial<Settings>) => engine.views.settings({ confirm: true, settings: { ...settings, ...changes } });
    assert.throws(() => recover({ accounts: settings.accounts.filter(a => a.id !== 'lighter-1') }), accountInUse);
    assert.throws(() => recover({ accounts: settings.accounts.map(a => a.id === 'lighter-1' ? { ...a, venue: 'bybit' } : a) }), accountInUse);
    assert.deepEqual(f.snapshot(), before);
    const restored = recover({ accounts: [...settings.accounts, { ...settings.accounts[0]!, id: 'extra' }] });
    assert.equal(restored.recovery.settings, null); assert.deepEqual(restored.book, f.saved.book);
    assert.deepEqual(f.snapshot().rounds, before.rounds);
    assert.deepEqual(f.snapshot().state.find(row => row.key === 'book'), before.state.find(row => row.key === 'book'));
    engine.views.plan(); await oneTick(engine);
    assert.ok(engine.views.state().round!.id > f.saved.round!.id);
    assert.ok(engine.views.state().book!.accounts.some(a => a.id === 'extra'));
  } finally { f.close(); }
});

for (const first of ['settings', 'book'] as const) for (const missing of [true, false]) test(`两份记录均${missing ? '缺行' : '损坏'}，先恢复 ${first} 后重启仍须确认另一项`, async t => {
  const f = await persistedFixture(t);
  try {
    f.db.exec(missing ? 'DELETE FROM state' : "UPDATE state SET json='{broken'");
    let engine = f.restart();
    const before = f.snapshot();
    const save = () => engine.views.settings({ confirm: true, settings: f.saved.settings });
    const reset = () => engine.views.reset({ confirm: true });
    const midway = first === 'settings' ? save() : reset();
    assert.equal(midway.recovery[first], null);
    const other = first === 'settings' ? 'book' : 'settings';
    assert.ok(midway.recovery[other]);
    assert.deepEqual(f.snapshot().state.find(row => row.key === other), before.state.find(row => row.key === other));
    if (first === 'settings') assert.deepEqual(f.snapshot().rounds, before.rounds);
    engine = f.restart();
    assert.equal(engine.views.state().recovery[first], null);
    assert.ok(engine.views.state().recovery[other]);
    if (other === 'settings') assert.throws(() => engine.views.settings(f.saved.settings), /确认保存/);
    assert.throws(() => engine.views.plan(), stateUnavailable);
    await oneTick(engine);
    if (first === 'settings') reset(); else save();
    engine.views.plan(); await oneTick(engine);
    assert.equal(engine.views.state().rounds.length, 1);
    assert.ok(engine.views.state().round!.id > f.saved.round!.id);
  } finally { f.close(); }
});

test('重置账本与保留参数恢复状态同时提交，任一步失败都可在重启后继续', async t => {
  const f = await persistedFixture(t);
  try {
    f.db.exec('DELETE FROM state');
    let engine = f.restart();
    const beforeReset = f.snapshot();
    f.db.exec("CREATE TRIGGER reject_reset BEFORE DELETE ON rounds BEGIN SELECT RAISE(ABORT, 'reset interrupted'); END");
    assert.throws(() => engine.views.reset({ confirm: true }), /reset interrupted/);
    assert.deepEqual(f.snapshot(), beforeReset);
    f.db.exec('DROP TRIGGER reject_reset');
    engine = f.restart(); engine.views.reset({ confirm: true });
    const beforeSave = f.snapshot();
    engine = f.restart();
    const save = () => engine.views.settings({ confirm: true, settings: f.saved.settings });
    f.db.exec("CREATE TRIGGER reject_save BEFORE DELETE ON state WHEN OLD.key='settings-recovery' BEGIN SELECT RAISE(ABORT, 'save interrupted'); END");
    assert.throws(save, /save interrupted/);
    assert.deepEqual(f.snapshot(), beforeSave);
    f.db.exec('DROP TRIGGER reject_save');
    engine = f.restart();
    assert.throws(() => engine.views.settings(f.saved.settings), /确认保存/);
    save();
    engine = f.restart();
    assert.deepEqual(engine.views.state().recovery, { settings: null, book: null });
  } finally { f.close(); }
});

for (const applied of [true, false]) test(`已保存轮次 applied=${applied}：账本缺少同轮账户时保留原文，设置变动和空账户可继续`, async t => {
  const f = await persistedFixture(t, applied);
  try {
    let engine = f.restart();
    engine.views.reset({ confirm: true }); engine.views.plan(); await oneTick(engine);
    const previous = engine.views.state();
    assert.equal(previous.round!.applied, applied);
    const occupied = previous.book!.accounts.find(a => applied ? a.positions.length > 0 : a.cash !== 0)!;
    assert.ok(occupied);
    if (!applied) {
      assert.ok(previous.book!.accounts.every(a => a.positions.length === 0));
      assert.ok(previous.round!.accounts.some(a => a.positions.length > 0), '未执行的规划仓位不同于实际账本');
    }
    const empty = previous.book!.accounts.find(a => a.cash === 0 && !a.positions.length);
    const settings = { ...previous.settings, accounts: [...previous.settings.accounts.filter(a => a.id !== empty?.id), { ...previous.settings.accounts[0]!, id: 'added' }] };
    engine.views.settings(settings);
    engine = f.restart();
    assert.deepEqual(engine.views.state().recovery, { settings: null, book: null });
    const raw = f.db.prepare("SELECT json FROM state WHERE key='book'").get()!.json as string;
    const partial = JSON.parse(raw);
    delete partial.accounts[occupied.id];
    const write = f.db.prepare("UPDATE state SET json=? WHERE key='book'");
    write.run(JSON.stringify(partial));
    const before = f.snapshot();
    engine = f.restart();
    const blocked = engine.views.state();
    assert.match(blocked.recovery.book ?? '', /缺少同轮规划已记录的账户/);
    assert.equal(blocked.recovery.settings, null); assert.equal(blocked.book, null); assert.equal(blocked.round, null);
    assert.deepEqual(engine.views.round(previous.round!.id), previous.round);
    assert.throws(() => engine.views.plan(), stateUnavailable);
    await oneTick(engine);
    assert.deepEqual(f.snapshot(), before);
    write.run(raw); engine = f.restart();
    assert.deepEqual(engine.views.state().recovery, { settings: null, book: null });
    assert.deepEqual(engine.views.state().book, previous.book);
    engine.views.plan(); await oneTick(engine);
    assert.ok(engine.views.state().book!.accounts.some(a => a.id === 'added'));
  } finally { f.close(); }
});

test('持仓报价消失即撤下预算与步骤，保存参数和重启都不会恢复旧规划，重新取得报价后可继续', async t => {
  const f = await persistedFixture(t);
  try {
    let engine = f.restart();
    const quotes = f.market.source.quotes;
    f.market.source.quotes = () => quotes().map(q => q.base === 'BTC' ? { ...q, mark: null, bid: null, ask: null, last: null } : q);
    const blocked = () => {
      const state = engine.views.state();
      assert.match(state.roundError ?? '', /BTC 模拟持仓拿不到价格/);
      assert.ok(state.risk!.bases.includes('BTC'));
      assert.equal(state.round, null); assert.equal(state.book!.equity, null);
      assert.ok(state.book!.accounts.some(a => a.positions.some(p => p.base === 'BTC' && p.price === null)));
      assert.deepEqual(state.rounds, f.saved.rounds);
      assert.deepEqual(engine.views.round(f.saved.round!.id), f.saved.round);
    };
    blocked();
    const before = f.snapshot();
    engine.views.plan(); await oneTick(engine); blocked();
    engine.views.settings(f.saved.settings); blocked();
    engine = f.restart(); blocked();
    assert.deepEqual(f.snapshot(), before);
    f.market.source.quotes = quotes;
    engine.views.plan(); await oneTick(engine);
    const resumed = engine.views.state();
    assert.equal(resumed.roundError, null); assert.ok(resumed.book!.equity! > 0 && resumed.round!.id > f.saved.round!.id);
  } finally { f.close(); }
});

test('缺少一户的账本仍可证明另一持仓账户被换场所，单独重置不能跳过参数恢复', async t => {
  const f = await persistedFixture(t);
  try {
    const kept = f.saved.book!.accounts.find(account => account.positions.length)!;
    const lost = f.saved.book!.accounts.find(account => account.id !== kept.id)!;
    const raw = JSON.parse(f.db.prepare("SELECT json FROM state WHERE key='book'").get()!.json as string);
    delete raw.accounts[lost.id];
    const changed = { ...f.saved.settings, accounts: f.saved.settings.accounts.map(account =>
      account.id === kept.id ? { ...account, venue: account.venue === 'bybit' ? 'bitget' : 'bybit' } : account) };
    const update = f.db.prepare('UPDATE state SET json=? WHERE key=?');
    update.run(JSON.stringify(raw), 'book'); update.run(JSON.stringify(changed), 'settings');
    let engine = f.restart();
    const before = f.snapshot(), state = engine.views.state();
    assert.ok(state.recovery.book && state.recovery.settings);
    assert.equal(state.book, null); assert.equal(state.round, null);
    assert.throws(() => engine.views.settings({ confirm: true, settings: changed }), accountInUse);
    assert.deepEqual(f.snapshot(), before);
    engine.views.reset({ confirm: true });
    engine = f.restart();
    assert.equal(engine.views.state().recovery.book, null); assert.ok(engine.views.state().recovery.settings);
    assert.throws(() => engine.views.settings(changed), /确认保存/);
    assert.throws(() => engine.views.plan(), stateUnavailable);
    engine.views.settings({ confirm: true, settings: f.saved.settings });
    engine.views.plan(); await oneTick(engine);
    assert.ok(engine.views.state().round);
  } finally { f.close(); }
});

test('同轮账户旁证结构异常时仍可打开模块和读取历史，自动规划不能覆盖账本', async t => {
  const f = await persistedFixture(t);
  try {
    const round = f.saved.round!, first = round.accounts[0]!;
    for (const accounts of [[null], [first, first], [{ ...first, venue: 'PRIVATE_MARKER' }], null]) {
      f.db.prepare('UPDATE rounds SET detail=? WHERE id=?').run(JSON.stringify({ ...round, accounts }), round.id);
      const engine = f.restart(), before = f.snapshot(), state = engine.views.state();
      assert.match(state.recovery.book ?? '', /账户记录无效/); assert.equal(state.round, null);
      assert.deepEqual(state.rounds, f.saved.rounds);
      assert.deepEqual(engine.views.round(round.id).accounts, accounts);
      assert.throws(() => engine.views.plan(), stateUnavailable);
      await oneTick(engine);
      assert.deepEqual(f.snapshot(), before);
    }
    assert.doesNotMatch(f.logs.join(' '), /PRIVATE_MARKER/);
  } finally { f.close(); }
});

test('仅剩历史或仅剩账本都与首次空库区分；带持仓但缺少场所证据时须修复原参数', async t => {
  const f = await persistedFixture(t);
  try {
    const original = f.snapshot();
    f.db.exec('DELETE FROM state');
    let engine = f.restart();
    assert.ok(engine.views.state().recovery.settings && engine.views.state().recovery.book);
    assert.throws(() => engine.views.plan(), stateUnavailable);
    await oneTick(engine);
    assert.deepEqual(f.snapshot().rounds, original.rounds);
    f.db.exec('DELETE FROM rounds');
    const book = original.state.find(row => row.key === 'book')!;
    f.db.prepare('INSERT INTO state(key,json,updated_at) VALUES (?,?,?)').run(book.key!, book.json!, book.updated_at!);
    engine = f.restart();
    const solo = f.snapshot();
    assert.equal(engine.views.state().recovery.book, null);
    assert.match(engine.views.state().recovery.settings ?? '', /缺少参数/);
    assert.throws(() => engine.views.settings({ confirm: true, settings: f.saved.settings }), accountInUse);
    assert.deepEqual(f.snapshot(), solo);
  } finally { f.close(); }
});

test('兼容的无版本旧账本及只缺 paperAuto 的旧参数正常继续，读取不改写旧参数', async t => {
  const f = await persistedFixture(t);
  try {
    const { paperAuto: _old, ...legacy } = f.saved.settings, raw = JSON.stringify(legacy);
    f.db.prepare("UPDATE state SET json=? WHERE key='settings'").run(raw);
    const before = f.snapshot(), engine = f.restart();
    assert.deepEqual(engine.views.state().recovery, { settings: null, book: null });
    assert.deepEqual(engine.views.state().book, f.saved.book);
    assert.equal(engine.views.state().settings.paperAuto, true);
    assert.deepEqual(f.snapshot(), before);
    engine.views.plan(); await oneTick(engine);
    assert.ok(engine.views.state().round!.id > f.saved.round!.id);
    assert.equal(f.db.prepare("SELECT json FROM state WHERE key='settings'").get()!.json, raw);
  } finally { f.close(); }
});
