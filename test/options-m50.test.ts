// M50 均线择边 (docs/options.md): the daily MA50 signal, single-leg opening on its side, switching by close then open,
// the margin cap, and what stays off (the Friday scheduler, RFQ). Uses the Bybit stand-in of options-fake.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContractError } from '../src/contracts.ts';
import { createOptionsClient } from '../src/options/client.ts';
import { createOptionsEngine, m50SignalDay, type AutoOpenSettings, type OptionsEngine, type TaskStatus } from '../src/options/engine.ts';
import { createOptionMarket } from '../src/options/market.ts';
import { openOptionsStore, type OptionsStore } from '../src/options/store.ts';
import { DEFAULT_ESTIMATES, StrategyError, buildStrategy, chooseTrendExpiry, trendSignal, validateStructure } from '../src/options/strategy.ts';
import { optionsSummary, parseOptionsConfig } from '../src/service/options-config.ts';
import { readOptionData } from '../src/market/options-data.ts';
import type { MarketClient } from '../src/market/ipc.ts';
import { FRIDAY, FakeOptions, UID, symbolOf } from './options-fake.ts';

const DAY_MS = 86_400_000;
const TERMINAL: TaskStatus[] = ['completed', 'partial', 'stopped', 'failed', 'recovery_needed'];
const refused = (code: string) => (error: unknown) => error instanceof ContractError && error.code === code;

interface Setup { fake: FakeOptions; market: ReturnType<typeof createOptionMarket>; engine: OptionsEngine; store: OptionsStore; notes: string[]; logs: string[]; hooks: { skewMs: number; failNotify: boolean }; make(store: OptionsStore): OptionsEngine; dispose(): void }
function setup({ maxMarginUsd = 50_000, autoOpen, base = FRIDAY, mode = 'trend_m50' as const }: { maxMarginUsd?: number; autoOpen?: AutoOpenSettings; base?: number; mode?: 'trend_m50' | 'iron_condor' } = {}): Setup {
  const started = Date.now();
  const hooks = { skewMs: 0, failNotify: false };
  const now = () => base + (Date.now() - started) + hooks.skewMs;
  const fake = new FakeOptions(now);
  const client = createOptionsClient({ credentials: { apiKey: 'options-test-key', apiSecret: 'options-test-secret' }, fetchImpl: async (url, init) => fake.fetch(url, init) });
  const market = createOptionMarket(client, { now });
  const dir = mkdtempSync(join(tmpdir(), 'options-m50-'));
  const store = openOptionsStore(join(dir, 'options.sqlite'));
  const notes: string[] = [], logs: string[] = [];
  const make = (target: OptionsStore) => createOptionsEngine({
    client, market, store: target, uid: UID, now, notify: text => { if (hooks.failNotify) throw new Error('飞书出口断开'); notes.push(text); }, log: line => logs.push(line),
    sleep: () => new Promise(resolve => setTimeout(resolve, 2)), pollMs: 20, sampleMs: 40,
    settings: { maxRiskUsd: 50_000, maxMarginUsd, legQty: '1', strategyMode: mode, orderTimeoutMs: 600, estimates: DEFAULT_ESTIMATES, ...(autoOpen ? { autoOpen } : {}) },
  });
  const engine = make(store);
  return { fake, market, engine, store, notes, logs, hooks, make, dispose: () => { try { store.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); } };
}
async function until(check: () => boolean, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等待超时');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
let seq = 0;
async function run(s: Setup, operation: 'open' | 'close') {
  const plan = await s.engine.createPlan({ operation });
  const started = await s.engine.startTask({ planId: plan.planId, requestId: `m50-${String(++seq).padStart(8, '0')}`, confirmLive: true });
  await until(() => TERMINAL.includes(s.engine.state().tasks[started.taskId]!.status));
  return { plan, task: s.engine.state().tasks[started.taskId]! };
}
const candles = (day: string, close: (back: number) => number, skip: number[] = []) => {
  const start = Date.parse(`${day}T00:00:00Z`);
  return Array.from({ length: 60 }, (_, back) => back).filter(back => !skip.includes(back)).map(back => [String(start - back * DAY_MS), '1', '1', '1', String(close(back))]);
};

test('M50 信号：前 50 个已收盘日的均值，不含当天未收盘的一根，缺一天就拒绝', () => {
  // Today's candle (back 0) is huge and must not count; days 1..50 average 100.
  const rows = candles('2026-11-13', back => back === 0 ? 1e9 : back <= 50 ? 100 : 1);
  const up = trendSignal(rows, '2026-11-13', 101, 1);
  assert.equal(up.ma, 100);
  assert.equal(up.side, 'Put');
  assert.equal(trendSignal(rows, '2026-11-13', 100, 1).side, 'Call', '等于均线时卖 Call（回测：现货高于均线才卖 Put）');
  assert.throws(() => trendSignal(candles('2026-11-13', () => 100, [50]), '2026-11-13', 101, 1), (error: unknown) => error instanceof StrategyError && /缺少 2026-09-24/.test(error.message));
  assert.throws(() => trendSignal([[String(Date.UTC(2026, 10, 12) + 1), '1', '1', '1', '1']], '2026-11-13', 101, 1), StrategyError);
  assert.throws(() => trendSignal(rows, '2026-11-13', 0, 1), StrategyError);
});

test('M50 信号日：08:15 UTC 之前沿用前一天', () => {
  assert.equal(m50SignalDay(Date.UTC(2026, 10, 13, 8, 14, 59)), '2026-11-12');
  assert.equal(m50SignalDay(Date.UTC(2026, 10, 13, 8, 15)), '2026-11-13');
  assert.equal(m50SignalDay(Date.UTC(2026, 10, 13, 23, 59)), '2026-11-13');
});

test('M50 到期日：剩余不少于 2 天、最接近 14 天；结构恰好一条卖腿', () => {
  const now = Date.UTC(2026, 10, 13, 10);
  const row = (expiry: number) => ({ expiry } as never);
  assert.equal(chooseTrendExpiry([row(now + DAY_MS), row(now + 9 * DAY_MS), row(now + 16 * DAY_MS), row(now + 30 * DAY_MS)], now), now + 16 * DAY_MS);
  assert.equal(chooseTrendExpiry([row(now + 12 * DAY_MS), row(now + 16 * DAY_MS)], now), now + 12 * DAY_MS, '同样接近取较早的');
  assert.throws(() => chooseTrendExpiry([row(now + DAY_MS)], now), StrategyError);
  const leg = { side: 'Sell' as const, optionType: 'Put' as const, strike: 90_000, qty: 1, expiry: now + 9 * DAY_MS };
  validateStructure({ a: leg }, 'trend_m50');
  assert.throws(() => validateStructure({ a: { ...leg, side: 'Buy' } }, 'trend_m50'), StrategyError);
  assert.throws(() => validateStructure({ a: leg, b: { ...leg, optionType: 'Call', strike: 110_000 } }, 'trend_m50'), StrategyError);
  assert.throws(() => buildStrategy([], { now, qty: '1', mode: 'trend_m50', index: 100_000, estimates: DEFAULT_ESTIMATES, marketAt: now, trendSide: null }), (error: unknown) => error instanceof StrategyError && error.code === 'no_signal');
});

test('M50：没有当天信号不能开仓；信号算出后按方向开单腿卖 Put，飞书提示一次', async () => {
  const s = setup();
  try {
    await s.market.refresh();
    await assert.rejects(s.engine.createPlan({ operation: 'open' }), refused('no_signal'));
    assert.equal(s.engine.stateView().m50.action, 'no_signal');
    await s.engine.trendTick();
    const signal = s.engine.state().m50.signal!;
    assert.deepEqual([signal.day, signal.ma, signal.side], ['2026-11-13', 90_000, 'Put']);
    assert.equal(s.notes.filter(text => text.includes('M50')).length, 1);
    assert.match(s.notes.at(-1)!, /建议开仓卖 Put/);
    await s.engine.trendTick();
    assert.equal(s.notes.filter(text => text.includes('M50')).length, 1, '同一天只提示一次');
    assert.equal(s.engine.stateView().m50.action, 'open');
    const { plan, task } = await run(s, 'open');
    // 13 Nov 10:00: the 15 Nov expiry is under 2 days away, the 22 Nov one is chosen; |delta| 0.30 put is 92k.
    assert.deepEqual(plan.legs.map(leg => `${leg.side} ${leg.symbol} ${leg.qty}`), [`Sell ${symbolOf(92000, 'P', '22NOV26')} 1`]);
    assert.equal(plan.mode, 'trend_m50');
    assert.equal(task.status, 'completed');
    assert.ok(task.risk && task.risk.reservedUsd > 0 && task.risk.reservedUsd <= 50_000, '按卖腿保证金预留');
    assert.deepEqual(s.engine.state().tracked.sizes, { [`${symbolOf(92000, 'P', '22NOV26')}|Sell`]: '1' });
    assert.equal(s.engine.stateView().m50.action, 'hold');
    await assert.rejects(s.engine.createPlan({ operation: 'open' }), refused('strategy_open'));
  } finally { await s.engine.close(); s.dispose(); }
});

test('M50：次日信号翻转提示换边，先平仓再开卖 Call，各自确认', async () => {
  const s = setup();
  try {
    await s.market.refresh();
    await s.engine.trendTick();
    await run(s, 'open');
    s.fake.dailyClose = 110_000;
    s.hooks.skewMs += DAY_MS;
    await s.market.refresh();
    await s.engine.trendTick();
    assert.equal(s.engine.state().m50.signal!.side, 'Call');
    const view = s.engine.stateView().m50;
    assert.deepEqual([view.action, view.trackedSide], ['switch', 'Put']);
    assert.match(s.notes.at(-1)!, /先平仓再开卖 Call/);
    await assert.rejects(s.engine.createPlan({ operation: 'open' }), refused('strategy_open'), '换边不会合成一个任务');
    const closing = await run(s, 'close');
    assert.deepEqual(closing.plan.legs.map(leg => `${leg.side} ${leg.symbol}`), [`Buy ${symbolOf(92000, 'P', '22NOV26')}`]);
    assert.equal(closing.task.status, 'completed');
    assert.ok([...s.fake.orders.values()].filter(order => order.link.startsWith('tpo-close-')).every(order => order.reduceOnly));
    assert.deepEqual(s.engine.state().tracked, { groupId: null, sizes: {} });
    assert.equal(s.engine.stateView().m50.action, 'open');
    const opening = await run(s, 'open');
    assert.deepEqual(opening.plan.legs.map(leg => `${leg.side} ${leg.symbol}`), [`Sell ${symbolOf(108000, 'C', '22NOV26')}`]);
    assert.equal(opening.plan.unboundedLoss, true, '卖 Call 亏损无上限');
  } finally { await s.engine.close(); s.dispose(); }
});

test('M50：确认前信号方向变了就拒绝，不按旧方向下单', async () => {
  const s = setup();
  try {
    await s.market.refresh();
    await s.engine.trendTick();
    const plan = await s.engine.createPlan({ operation: 'open' });
    s.engine.state().m50.signal!.side = 'Call';
    await assert.rejects(s.engine.startTask({ planId: plan.planId, requestId: 'm50-flip-0001', confirmLive: true }), refused('strategy_changed'));
    assert.equal(s.fake.creates, 0);
  } finally { await s.engine.close(); s.dispose(); }
});

test('M50：保证金超过上限不开仓；读不到日线时没有信号、每分钟重试一次', async () => {
  const s = setup({ maxMarginUsd: 1_000 });
  try {
    await s.market.refresh();
    s.fake.dailyClose = null;
    await s.engine.trendTick();
    await s.engine.trendTick();
    assert.equal(s.fake.calls.filter(call => call.path === '/v5/market/index-price-kline').length, 1, '一分钟内不重读');
    assert.equal(s.engine.state().m50.signal, null);
    assert.ok(s.engine.stateView().m50.error);
    assert.equal(s.logs.filter(line => line.includes('M50 信号读取失败')).length, 1);
    // 13 Nov 10:00 is past 09:15, but one failed read (as at start-up) is not yet worth a Feishu line.
    const late = () => s.notes.filter(text => text.includes('仍没读到均线信号')).length;
    assert.equal(late(), 0);
    for (let i = 0; i < 3; i += 1) { s.hooks.skewMs += 61_000; await s.market.refresh(); await s.engine.trendTick(); }
    assert.equal(late(), 1, '09:15 后第三次读取失败才提示一次');
    assert.equal(s.logs.filter(line => line.includes('M50 信号读取失败')).length, 1, '同一原因只记一行');
    s.fake.dailyClose = 90_000;
    s.hooks.skewMs += 61_000;
    await s.market.refresh();
    await s.engine.trendTick();
    assert.equal(s.engine.state().m50.signal!.side, 'Put');
    const view = s.engine.previewView(null, null);
    assert.match(view.riskProblem ?? '', /超过上限 1000/);
    await assert.rejects(s.engine.createPlan({ operation: 'open' }), refused('risk_limit'));
  } finally { await s.engine.close(); s.dispose(); }
});

test('M50：周五定时开仓不执行、不提醒；组合询价拒绝 M50；信号重启后保留', async () => {
  const window: AutoOpenSettings = { enabled: true, hourUtc: 10, minuteUtc: 0, windowSeconds: 300 };
  const s = setup({ autoOpen: window });
  try {
    await s.market.refresh();
    await s.engine.autoOpenTick();
    assert.equal(Object.keys(s.engine.state().tasks).length, 0);
    assert.equal(s.engine.stateView().schedule.applicable, false);
    await assert.rejects(s.engine.createRfq({ requestId: 'm50-rfq-0001', confirmLive: true }), refused('rfq_mode'));
    await s.engine.trendTick();
    const again = s.make(s.store);
    assert.deepEqual(again.state().m50.signal, s.engine.state().m50.signal);
    assert.equal(again.state().m50.notifiedDay, '2026-11-13');
  } finally { await s.engine.close(); s.dispose(); }
});

test('M50：配置为其他模式时不读日线，页面要 M50 预览后才开始算信号、但不发飞书', async () => {
  const s = setup({ mode: 'iron_condor' });
  try {
    await s.market.refresh();
    await s.engine.trendTick();
    assert.equal(s.fake.calls.filter(call => call.path === '/v5/market/index-price-kline').length, 0);
    assert.throws(() => s.engine.previewView(null, 'trend_m50'), refused('no_signal'));
    await s.engine.trendTick();
    assert.equal(s.engine.state().m50.signal!.side, 'Put');
    assert.equal(s.notes.length, 0);
    assert.equal(s.engine.previewView(null, 'trend_m50').preview.legs[0]!.symbol, symbolOf(92000, 'P', '22NOV26'));
  } finally { await s.engine.close(); s.dispose(); }
});

test('M50 配置：strategyMode 接受 trend_m50，摘要标明定时开仓不适用', () => {
  const config = parseOptionsConfig({ accountId: UID, limits: { maxRiskUsd: 1000, maxMarginUsd: 5000 }, strategyMode: 'trend_m50' });
  assert.equal(config.strategyMode, 'trend_m50');
  assert.match(optionsSummary(config), /M50 均线择边.*不适用/);
  assert.throws(() => parseOptionsConfig({ accountId: UID, limits: { maxRiskUsd: 1000, maxMarginUsd: 5000 }, strategyMode: 'm50' }), /trend_m50/);
});

test('M50：飞书写入失败时不记已提示，每分钟重试一次、同一原因只记一行日志，恢复后补发', async () => {
  const s = setup();
  try {
    await s.market.refresh();
    s.hooks.failNotify = true;
    await s.engine.trendTick();
    s.hooks.skewMs += 61_000;
    await s.market.refresh();
    await s.engine.trendTick();
    assert.equal(s.engine.state().m50.notifiedDay, null);
    assert.equal(s.logs.filter(line => line.includes('飞书通知未能写入')).length, 1);
    s.hooks.failNotify = false;
    await s.engine.trendTick();
    assert.equal(s.notes.length, 0, '一分钟内不重试');
    s.hooks.skewMs += 61_000;
    await s.market.refresh();
    await s.engine.trendTick();
    assert.match(s.notes.at(-1)!, /建议开仓卖 Put/);
    assert.equal(s.logs.filter(line => line.includes('飞书通知未能写入')).length, 1, '两次失败同一原因只记一行');
    assert.equal(s.engine.state().m50.notifiedDay, '2026-11-13');
  } finally { await s.engine.close(); s.dispose(); }
});

test('M50：持有的腿到期未退役时显示结算中，不提示、不记已提示', async () => {
  const s = setup();
  try {
    await s.market.refresh();
    await s.engine.trendTick();
    await run(s, 'open');
    const group = s.engine.state().tasks[s.engine.state().tracked.groupId!]!;
    for (const leg of Object.values(group.legs)) leg.expiry = FRIDAY; // expired (the fake clock is past FRIDAY), not yet retired
    s.engine.state().m50.notifiedDay = null;
    const notes = s.notes.length;
    await s.engine.trendTick();
    assert.equal(s.engine.stateView().m50.action, 'settling');
    assert.equal(s.notes.length, notes, '结算中不提示');
    assert.equal(s.engine.state().m50.notifiedDay, null, '退役后当天还要补发');
  } finally { await s.engine.close(); s.dispose(); }
});

test('M50：状态里的信号记录损坏时拒绝启动，缺少记录的旧状态正常启动', async () => {
  const s = setup();
  try {
    await s.engine.close();
    const saved = s.store.load() as Record<string, unknown> | null;
    const base = saved ?? { uid: UID, tasks: {}, journal: {}, tracked: { groupId: null, sizes: {} }, pmBaseline: null, executions: [] };
    s.store.save({ ...base, m50: { signal: { day: 'bad' }, notifiedDay: null } } as never);
    assert.throws(() => s.make(s.store), /M50 信号记录不完整/);
    const { m50: _drop, ...old } = base as Record<string, unknown>;
    s.store.save(old as never);
    const engine = s.make(s.store);
    assert.deepEqual(engine.state().m50, { signal: null, notifiedDay: null });
    await engine.close();
  } finally { s.dispose(); }
});

test('M50：经行情服务读指数日线，带来源时间', async () => {
  const fake = new FakeOptions(() => FRIDAY);
  const ops: string[] = [];
  const marketClient: MarketClient = {
    epoch: () => 'one', stream: () => { throw new Error('unexpected stream'); },
    async call<T>(op: string, _input: unknown, signal: AbortSignal) {
      ops.push(op);
      const reply = await readOptionData(op.slice('options.'.length) as 'indexKline', undefined, signal, { fetchImpl: async (url, init) => fake.fetch(url, init), now: () => FRIDAY });
      return { ...reply, sourceAt: reply.sourceAt ?? FRIDAY } as T;
    },
  };
  const client = createOptionsClient({ credentials: { apiKey: 'options-test-key', apiSecret: 'options-test-secret' }, marketClient, now: () => FRIDAY, fetchImpl: async () => { throw new Error('不应直连'); } });
  const reply = await client.indexKline!(AbortSignal.timeout(1000)) as { list: unknown[] };
  assert.deepEqual(ops, ['options.indexKline']);
  assert.equal(reply.list.length, 60);
  assert.equal(trendSignal(reply.list, '2026-11-13', 100_000, FRIDAY).ma, 90_000);
});

test('M50：09:15 之前读不到信号不提示迟到，之后提示一次，信号读到后一分钟内补发建议', async () => {
  const s = setup({ base: FRIDAY - 3_600_000 }); // 13 Nov 09:00
  try {
    await s.market.refresh();
    s.fake.dailyClose = null;
    const late = () => s.notes.filter(text => text.includes('仍没读到均线信号')).length;
    for (let i = 0; i < 4; i += 1) { await s.engine.trendTick(); s.hooks.skewMs += 61_000; await s.market.refresh(); }
    assert.equal(late(), 0, '09:15 之前不提示');
    s.hooks.skewMs += 15 * 60_000; // past 09:15
    await s.market.refresh();
    for (let i = 0; i < 3; i += 1) { await s.engine.trendTick(); s.hooks.skewMs += 61_000; await s.market.refresh(); }
    assert.equal(late(), 1);
    s.fake.dailyClose = 90_000;
    await s.engine.trendTick();
    assert.equal(s.engine.state().m50.signal!.side, 'Put');
    assert.match(s.notes.at(-1)!, /建议开仓卖 Put/);
    assert.equal(late(), 1);
  } finally { await s.engine.close(); s.dispose(); }
});
