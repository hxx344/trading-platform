import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { ContractError } from '../src/contracts.ts';
import { createExecutorServer } from '../src/http.ts';
import { bybitPermissionProblem } from '../src/live/permissions.ts';
import { createOptionsClient } from '../src/options/client.ts';
import { createOptionsEngine, isoWeek, type AutoOpenSettings, type OptionsEngine, type TaskStatus } from '../src/options/engine.ts';
import { createOptionMarket } from '../src/options/market.ts';
import { openOptionsStore, type OptionsStore } from '../src/options/store.ts';
import { DEFAULT_ESTIMATES, type StrategyMode } from '../src/options/strategy.ts';
import { parseServiceConfig, parseServiceSecrets } from '../src/service/config.ts';
import { optionsSummary, parseOptionsConfig } from '../src/service/options-config.ts';
import { optionsViews, preflightOptions } from '../src/service/options.ts';
import { bindAccounts, createHarness } from './harness.ts';
import { EXPIRY, FRIDAY, FakeOptions, UID, symbolOf, type FillMode, type Row } from './options-fake.ts';

const CREDENTIALS = { apiKey: 'options-test-key', apiSecret: 'options-test-secret' };
const TERMINAL: TaskStatus[] = ['completed', 'partial', 'stopped', 'failed'];

interface Setup { fake: FakeOptions; market: ReturnType<typeof createOptionMarket>; engine: OptionsEngine; store: OptionsStore; notes: string[]; logs: string[]; dir: string; now: () => number; make(store: OptionsStore): OptionsEngine; dispose(): void;
  /** skewMs moves the engine's clock; onNote runs inside notify (synchronously, as the engine sends). */
  hooks: { skewMs: number; onNote?: (text: string) => void } }

function setup({ mode = 'iron_condor', fill = 'fill', maxRiskUsd = 50_000, maxMarginUsd = 50_000, orderTimeoutMs = 600, base = FRIDAY, missingSettleMs, autoOpen, marketFallback }: { mode?: StrategyMode; fill?: FillMode; maxRiskUsd?: number; maxMarginUsd?: number; orderTimeoutMs?: number; base?: number; missingSettleMs?: number; autoOpen?: AutoOpenSettings; marketFallback?: boolean } = {}): Setup {
  const started = Date.now();
  const hooks: Setup['hooks'] = { skewMs: 0 };
  const now = () => base + (Date.now() - started) + hooks.skewMs;
  const fake = new FakeOptions(now);
  fake.fillMode = fill;
  const client = createOptionsClient({ credentials: CREDENTIALS, fetchImpl: fake.fetch });
  const market = createOptionMarket(client, { now });
  const dir = mkdtempSync(join(tmpdir(), 'options-test-'));
  const store = openOptionsStore(join(dir, 'options.sqlite'));
  const notes: string[] = [], logs: string[] = [];
  const make = (target: OptionsStore) => createOptionsEngine({
    client, market, store: target, uid: UID, now, notify: text => { notes.push(text); hooks.onNote?.(text); }, log: line => logs.push(line),
    sleep: () => new Promise(resolve => setTimeout(resolve, 2)), pollMs: 20, sampleMs: 40, ...(missingSettleMs === undefined ? {} : { missingSettleMs }),
    settings: { maxRiskUsd, maxMarginUsd, legQty: '1', strategyMode: mode, orderTimeoutMs, estimates: DEFAULT_ESTIMATES, ...(autoOpen ? { autoOpen } : {}), ...(marketFallback ? { marketFallback } : {}) },
  });
  const engine = make(store);
  return { fake, market, engine, store, notes, logs, dir, now, make, hooks, dispose: () => { try { store.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); } };
}

async function until(check: () => boolean, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等待超时');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const finished = (s: Setup, id: string) => until(() => TERMINAL.includes(s.engine.state().tasks[id]!.status) || s.engine.state().tasks[id]!.status === 'recovery_needed');
let requestSeq = 0;
async function open(s: Setup, extra: { minNetIncomeUsd?: number } = {}) {
  const plan = await s.engine.createPlan({ operation: 'open' });
  const started = await s.engine.startTask({ planId: plan.planId, requestId: `req-${String(++requestSeq).padStart(8, '0')}`, confirmLive: true, ...extra });
  return { plan, started };
}
const refused = (code: string) => (error: unknown) => error instanceof ContractError && error.code === code;

test('期权：铁鹰开仓四腿全部成交，跟踪数量、成交明细与飞书消息齐全，同一请求编号幂等', async () => {
  const s = setup();
  try {
    const plan = await s.engine.createPlan({ operation: 'open' });
    assert.deepEqual(plan.legs.map(leg => `${leg.side} ${leg.symbol}`).sort(), [`Buy ${symbolOf(116000, 'C')}`, `Buy ${symbolOf(84000, 'P')}`, `Sell ${symbolOf(102000, 'C')}`, `Sell ${symbolOf(98000, 'P')}`].sort());
    assert.equal(plan.minNetIncomeUsd, plan.estimatedNetUsd);
    const request = { planId: plan.planId, requestId: 'req-open-0001', confirmLive: true };
    const started = await s.engine.startTask(request);
    await finished(s, started.taskId);
    const task = s.engine.state().tasks[started.taskId]!;
    assert.equal(task.status, 'completed');
    assert.deepEqual(Object.values(s.engine.state().tracked.sizes), ['1', '1', '1', '1']);
    assert.equal(s.engine.state().tracked.groupId, started.taskId);
    assert.equal(s.fake.creates, 4);
    assert.ok([...s.fake.orders.keys()].every(link => link.startsWith('tpo-') && !link.startsWith('tpo-close-')));
    // The wings go out (and fill) before the short legs.
    assert.deepEqual([...s.fake.orders.values()].map(order => order.side), ['Buy', 'Buy', 'Sell', 'Sell']);
    await until(() => s.engine.state().executions.length === 4);
    assert.ok(s.engine.state().executions.every(item => item.taskId === started.taskId && item.chainPrice !== null && !item.reduceOnly));
    assert.ok(s.notes.some(text => text.includes('已确认')) && s.notes.some(text => text.includes('结束：已完成')));
    // The same request again answers the same task; other parameters under the same id are refused.
    assert.deepEqual(await s.engine.startTask(request), { ...started, status: 'completed' });
    await assert.rejects(s.engine.startTask({ ...request, minNetIncomeUsd: 1 }), refused('request_reused'));
    // A tracked strategy blocks another opening.
    await assert.rejects(s.engine.createPlan({ operation: 'open' }), refused('strategy_open'));
  } finally { s.dispose(); }
});

test('期权：平仓只平跟踪数量、reduceOnly，全部成交后策略结束并清空跟踪', async () => {
  const s = setup();
  try {
    const { started } = await open(s);
    await finished(s, started.taskId);
    const plan = await s.engine.createPlan({ operation: 'close' });
    assert.ok(plan.legs.every(leg => leg.qty === '1'));
    assert.equal(plan.maxNetCostUsd, -plan.estimatedNetUsd);
    const closing = await s.engine.startTask({ planId: plan.planId, requestId: 'req-close-0001', confirmLive: true });
    await finished(s, closing.taskId);
    const state = s.engine.state();
    assert.equal(state.tasks[closing.taskId]!.status, 'completed');
    assert.deepEqual(state.tracked, { groupId: null, sizes: {} });
    assert.equal(state.tasks[started.taskId]!.strategyStatus, 'closed');
    assert.equal(s.fake.positions.size, 0);
    const closingOrders = [...s.fake.orders.values()].filter(order => order.link.startsWith('tpo-close-'));
    assert.ok(closingOrders.every(order => order.reduceOnly));
    // The short legs are bought back before the wings are sold.
    assert.deepEqual(closingOrders.map(order => order.side), ['Buy', 'Buy', 'Sell', 'Sell']);
  } finally { s.dispose(); }
});

test('期权：买翼没有全部成交时卖出腿不下单，任务为部分成交，不留下无保护的卖出', async () => {
  const s = setup();
  s.fake.modes.set(symbolOf(116000, 'C'), 'partial');
  try {
    const { started } = await open(s);
    await finished(s, started.taskId);
    const task = s.engine.state().tasks[started.taskId]!;
    assert.equal(task.status, 'partial');
    assert.match(task.error ?? '', /卖出腿未下单/);
    assert.ok([...s.fake.orders.values()].every(order => order.side === 'Buy'));
    assert.deepEqual(Object.keys(s.engine.state().tracked.sizes).sort(), [`${symbolOf(116000, 'C')}|Buy`, `${symbolOf(84000, 'P')}|Buy`].sort());
  } finally { s.dispose(); }
});

test('期权：一腿部分成交，超时撤单后任务为部分成交，跟踪数量只记成交部分', async () => {
  const s = setup();
  s.fake.modes.set(symbolOf(102000, 'C'), 'partial');
  try {
    const { started } = await open(s);
    await finished(s, started.taskId);
    assert.equal(s.engine.state().tasks[started.taskId]!.status, 'partial');
    assert.equal(s.engine.state().tracked.sizes[`${symbolOf(102000, 'C')}|Sell`], '0.5');
    assert.equal([...s.fake.orders.values()].find(order => order.symbol === symbolOf(102000, 'C'))!.status, 'PartiallyFilledCanceled');
  } finally { s.dispose(); }
});

test('期权 IOC 兜底：买翼超时未成交，剩余数量发一次 IOC 补齐后才下卖腿，任务完成', async () => {
  const s = setup({ marketFallback: true });
  s.fake.modes.set(symbolOf(116000, 'C'), 'rest');
  try {
    const plan = await s.engine.createPlan({ operation: 'open' });
    // Crossing the spread costs more than the passive estimate: the confirmed net limit must leave room for it.
    const started = await s.engine.startTask({ planId: plan.planId, requestId: 'req-ioc-0001', confirmLive: true, minNetIncomeUsd: plan.estimatedNetUsd - 500 });
    await finished(s, started.taskId);
    const task = s.engine.state().tasks[started.taskId]!;
    assert.equal(task.status, 'completed', task.error ?? '');
    const wing = [...s.fake.orders.values()].filter(order => order.symbol === symbolOf(116000, 'C'));
    assert.deepEqual(wing.map(order => [order.link.startsWith('tpo-ioc-'), order.status]), [[false, 'Cancelled'], [true, 'Filled']]);
    // The IOC buys at ask 1, the fake's mark + 10.
    assert.equal(wing[1]!.price, String(Number(s.fake.quote(symbolOf(116000, 'C')).ask1Price)));
    const ioc = Object.entries(s.engine.state().journal).find(([link]) => link.startsWith('tpo-ioc-'))!;
    assert.deepEqual([ioc[1].kind, ioc[1].qty, ioc[1].filledQty, ioc[1].taskId], ['ioc', '1', '1', started.taskId]);
    assert.equal(s.engine.state().tracked.sizes[`${symbolOf(116000, 'C')}|Buy`], '1');
    assert.equal([...s.fake.orders.values()].filter(order => order.side === 'Sell').length, 2);
    await until(() => s.engine.state().executions.some(item => item.orderLinkId.startsWith('tpo-ioc-')));
  } finally { s.dispose(); }
});

test('期权 IOC 兜底：部分成交只补剩余数量；默认净价限制挡住 IOC，卖腿不下', async () => {
  const partial = setup({ marketFallback: true });
  partial.fake.modes.set(symbolOf(84000, 'P'), 'partial');
  try {
    const plan = await partial.engine.createPlan({ operation: 'open' });
    const started = await partial.engine.startTask({ planId: plan.planId, requestId: 'req-ioc-0002', confirmLive: true, minNetIncomeUsd: plan.estimatedNetUsd - 500 });
    await finished(partial, started.taskId);
    assert.equal(partial.engine.state().tasks[started.taskId]!.status, 'completed');
    const ioc = [...partial.fake.orders.values()].find(order => order.link.startsWith('tpo-ioc-'))!;
    assert.deepEqual([ioc.symbol, ioc.qty, ioc.status], [symbolOf(84000, 'P'), '0.5', 'Filled']);
  } finally { partial.dispose(); }

  // The IOC itself only half fills: the leg ends partial and no sell goes out.
  const half = setup({ marketFallback: true });
  half.fake.modes.set(symbolOf(116000, 'C'), 'rest');
  half.fake.iocMode = 'partial';
  try {
    const plan = await half.engine.createPlan({ operation: 'open' });
    const started = await half.engine.startTask({ planId: plan.planId, requestId: 'req-ioc-0003', confirmLive: true, minNetIncomeUsd: plan.estimatedNetUsd - 5_000 });
    await finished(half, started.taskId);
    assert.equal(half.engine.state().tasks[started.taskId]!.status, 'partial');
    assert.equal(half.engine.state().tracked.sizes[`${symbolOf(116000, 'C')}|Buy`], '0.5');
    assert.ok([...half.fake.orders.values()].every(order => order.side === 'Buy'));
  } finally { half.dispose(); }

  const tight = setup({ marketFallback: true });
  tight.fake.modes.set(symbolOf(116000, 'C'), 'rest');
  try {
    const { started } = await open(tight);
    await finished(tight, started.taskId);
    const task = tight.engine.state().tasks[started.taskId]!;
    assert.equal(task.status, 'partial');
    assert.equal(task.netBlocked, true);
    assert.match(task.error ?? '', /净价限制/);
    assert.ok([...tight.fake.orders.values()].every(order => order.side === 'Buy' && !order.link.startsWith('tpo-ioc-')));
  } finally { tight.dispose(); }
});

test('期权 IOC 兜底：IOC 应答丢失且读不到时卖腿不下、转待核对；重启后对账结算 IOC，跟踪数量计入其成交，不补发卖腿', async () => {
  const s = setup({ marketFallback: true });
  s.fake.modes.set(symbolOf(116000, 'C'), 'rest');
  s.fake.iocMode = 'lost';
  const second = openOptionsStore(join(s.dir, 'second.sqlite'));
  try {
    const plan = await s.engine.createPlan({ operation: 'open' });
    const started = await s.engine.startTask({ planId: plan.planId, requestId: 'req-ioc-0004', confirmLive: true, minNetIncomeUsd: plan.estimatedNetUsd - 500 });
    await finished(s, started.taskId);
    assert.equal(s.engine.state().tasks[started.taskId]!.status, 'recovery_needed');
    const [link, entry] = Object.entries(s.engine.state().journal).find(([key]) => key.startsWith('tpo-ioc-'))!;
    assert.deepEqual([entry.terminal, entry.status], [false, 'unknown']);
    assert.ok([...s.fake.orders.values()].every(order => order.side === 'Buy'));
    const creates = s.fake.creates;
    // The process dies with the IOC unresolved; the next one restores it and reconciliation reads it back.
    second.save(structuredClone(s.store.load()));
    const restarted = s.make(second);
    await assert.rejects(restarted.createPlan({ operation: 'open' }), refused('orders_unresolved'));
    s.fake.orders.get(link)!.visible = true;
    await restarted.reconcileOnce();
    const settled = restarted.state().journal[link]!;
    assert.deepEqual([settled.terminal, settled.status, settled.filledQty], [true, 'filled', '1']);
    assert.equal(restarted.state().tasks[started.taskId]!.status, 'partial');
    assert.equal(restarted.state().tracked.sizes[`${symbolOf(116000, 'C')}|Buy`], '1');
    assert.equal(s.fake.creates, creates);
    assert.ok([...s.fake.orders.values()].every(order => order.side === 'Buy'));
  } finally { second.close(); s.dispose(); }
});

test('期权 IOC 兜底：兜底等待期间停止不发 IOC；兜底前读不到原单时原单保持终态、不发 IOC', async () => {
  const wingOf = (s: Setup) => Object.entries(s.engine.state().journal).find(([, entry]) => entry.symbol === symbolOf(116000, 'C') && entry.kind !== 'ioc');
  const iocSent = (s: Setup) => [...s.fake.orders.values()].some(order => order.link.startsWith('tpo-ioc-')) || Object.keys(s.engine.state().journal).some(link => link.startsWith('tpo-ioc-'));

  const stopped = setup({ marketFallback: true });
  stopped.fake.modes.set(symbolOf(116000, 'C'), 'rest');
  try {
    const plan = await stopped.engine.createPlan({ operation: 'open' });
    const started = await stopped.engine.startTask({ planId: plan.planId, requestId: 'req-ioc-0005', confirmLive: true, minNetIncomeUsd: plan.estimatedNetUsd - 500 });
    // The wing timed out; the fallback is in its 0.8 s pause.
    await until(() => wingOf(stopped)?.[1].terminal === true);
    stopped.engine.stopTask(started.taskId);
    await finished(stopped, started.taskId);
    // The other wing filled, so the stopped task ends partial; nothing more went out.
    const task = stopped.engine.state().tasks[started.taskId]!;
    assert.deepEqual([task.status, task.stopRequested], ['partial', true]);
    assert.match(task.error ?? '', /IOC 兜底中断/);
    assert.equal(iocSent(stopped), false);
    assert.ok([...stopped.fake.orders.values()].every(order => order.side === 'Buy'));
  } finally { stopped.dispose(); }

  const blind = setup({ marketFallback: true });
  blind.fake.modes.set(symbolOf(116000, 'C'), 'rest');
  try {
    const plan = await blind.engine.createPlan({ operation: 'open' });
    const started = await blind.engine.startTask({ planId: plan.planId, requestId: 'req-ioc-0006', confirmLive: true, minNetIncomeUsd: plan.estimatedNetUsd - 500 });
    await until(() => wingOf(blind)?.[1].terminal === true);
    const [link] = wingOf(blind)!;
    blind.fake.orders.get(link)!.visible = false;
    await finished(blind, started.taskId);
    const task = blind.engine.state().tasks[started.taskId]!;
    assert.deepEqual([blind.engine.state().journal[link]!.terminal, blind.engine.state().journal[link]!.status], [true, 'timeout_cancelled']);
    assert.equal(task.status, 'partial');
    assert.match(task.error ?? '', /兜底前未能再次读到原订单/);
    assert.equal(iocSent(blind), false);
    assert.ok([...blind.fake.orders.values()].every(order => order.side === 'Buy'));
  } finally { blind.dispose(); }
});

/** Friday 2026-11-13 21:00 UTC (the default opening time), plus offsetMs. */
const OPENING = (offsetMs = 0) => Date.UTC(2026, 10, 13, 21) + offsetMs;
const AUTO = (enabled: boolean, windowSeconds = 60): AutoOpenSettings => ({ enabled, hourUtc: 21, minuteUtc: 0, windowSeconds });

test('期权定时开仓：窗口内每周只开一次，请求编号 scheduled-<周>，结果与飞书消息标明定时；窗口外不动', async () => {
  assert.deepEqual([isoWeek(Date.UTC(2026, 10, 13)), isoWeek(Date.UTC(2027, 0, 1)), isoWeek(Date.UTC(2026, 0, 1)), isoWeek(Date.UTC(2024, 11, 30))], ['2026-W46', '2026-W53', '2026-W01', '2025-W01']);
  const s = setup({ base: OPENING(5_000), autoOpen: AUTO(true) });
  try {
    assert.deepEqual([s.engine.stateView().schedule.inWindow, s.engine.stateView().schedule.waiting], [true, true]);
    await s.engine.autoOpenTick();
    const tasks = Object.values(s.engine.state().tasks);
    assert.equal(tasks.length, 1);
    assert.deepEqual([tasks[0]!.requestId, tasks[0]!.scheduled, s.engine.state().schedule.lastOpenWeek], ['scheduled-2026-W46', true, '2026-W46']);
    await finished(s, tasks[0]!.id);
    assert.equal(s.engine.state().tasks[tasks[0]!.id]!.status, 'completed');
    assert.ok(s.notes.some(text => text.startsWith('期权定时开仓任务') && text.includes('已确认')));
    await s.engine.autoOpenTick();
    assert.equal(Object.keys(s.engine.state().tasks).length, 1);
    assert.equal(s.engine.stateView().schedule.waiting, false);
    // The next window is next Friday's.
    assert.equal(s.engine.stateView().schedule.nextAt, OPENING(7 * 86_400_000));
  } finally { s.dispose(); }

  const outside = setup({ autoOpen: AUTO(true) });
  try {
    await outside.engine.autoOpenTick();
    assert.deepEqual([Object.keys(outside.engine.state().tasks).length, outside.engine.state().schedule.attemptWeek], [0, null]);
    assert.equal(outside.engine.stateView().schedule.nextAt, OPENING());
  } finally { outside.dispose(); }
});

test('期权定时开仓：受理后重启不会再开；窗口里没跑过检查也提醒一次，页面在窗口后才打开的不提醒', async () => {
  const s = setup({ base: OPENING(5_000), autoOpen: AUTO(true) });
  try {
    await s.engine.autoOpenTick();
    const [task] = Object.values(s.engine.state().tasks);
    await finished(s, task!.id);
    const reopened = s.make(s.store);
    await reopened.autoOpenTick();
    assert.deepEqual([Object.keys(reopened.state().tasks).length, reopened.state().schedule.attemptWeek], [1, null]);
  } finally { s.dispose(); }

  const missed = setup({ base: OPENING(120_000), autoOpen: AUTO(true) });
  try {
    // The scheduler ran before (it opened last week); this week's window passed while the service was down.
    const document = structuredClone(missed.engine.state());
    Object.assign(document.schedule, { lastOpenWeek: '2026-W45', notifiedWeek: null });
    missed.store.save(document);
    const engine = missed.make(missed.store);
    await engine.autoOpenTick();
    await engine.autoOpenTick();
    assert.deepEqual(missed.notes.filter(text => text.includes('定时开仓未执行')), ['期权定时开仓未执行（2026-W46）：窗口内没有执行检查（服务没在运行，或窗口短于 5 秒的检查间隔）']);
    assert.equal(engine.stateView().schedule.lastError, null);
  } finally { missed.dispose(); }

  // A first deploy with config.json's switch on, after this week's window: nothing ran before it, so no reminder.
  const fresh = setup({ base: OPENING(120_000), autoOpen: AUTO(true) });
  try {
    await fresh.engine.autoOpenTick();
    assert.equal(fresh.notes.filter(text => text.includes('定时开仓未执行')).length, 0);
  } finally { fresh.dispose(); }

  const late = setup({ base: OPENING(120_000), autoOpen: AUTO(false) });
  try {
    late.engine.setAutoOpen(true);
    await late.engine.autoOpenTick();
    assert.equal(late.notes.filter(text => text.includes('定时开仓未执行')).length, 0);
    assert.equal(late.engine.stateView().schedule.nextAt, OPENING(7 * 86_400_000));
  } finally { late.dispose(); }
});

test('期权定时开仓：页面开关覆盖配置并在重启后保留；关闭时窗口内也不开仓', async () => {
  const s = setup({ base: OPENING(1_000), autoOpen: AUTO(false) });
  try {
    await s.engine.autoOpenTick();
    assert.equal(Object.keys(s.engine.state().tasks).length, 0);
    const view = s.engine.setAutoOpen(true);
    assert.deepEqual([view.enabled, view.source, view.configEnabled], [true, 'page', false]);
    const reopened = s.make(s.store);
    assert.deepEqual([reopened.stateView().schedule.enabled, reopened.stateView().schedule.source], [true, 'page']);
    await s.engine.autoOpenTick();
    assert.equal(Object.keys(s.engine.state().tasks).length, 1);
    assert.equal(s.engine.setAutoOpen(false).enabled, false);
  } finally { s.dispose(); }
});

test('期权定时开仓：被拒绝时窗口内重试、同一原因只记一次日志；窗口结束发一次飞书', async () => {
  const s = setup({ base: OPENING(100), autoOpen: AUTO(true, 1), maxRiskUsd: 1_000 });
  try {
    await s.engine.autoOpenTick();
    await s.engine.autoOpenTick();
    const schedule = s.engine.state().schedule;
    assert.equal(schedule.attemptWeek, '2026-W46');
    assert.equal(schedule.lastOpenWeek, null);
    assert.match(schedule.lastError ?? '', /上限/);
    assert.equal(s.logs.filter(line => line.startsWith('期权定时开仓未执行')).length, 1);
    assert.equal(s.engine.stateView().schedule.lastError?.week, '2026-W46');
    await until(() => s.now() >= OPENING(1_000));
    await s.engine.autoOpenTick();
    await s.engine.autoOpenTick();
    assert.deepEqual(s.notes.filter(text => text.includes('定时开仓未执行')).map(text => text.split('：')[0]), ['期权定时开仓未执行（2026-W46）']);
    assert.equal(Object.keys(s.engine.state().tasks).length, 0);
  } finally { s.dispose(); }
});

test('期权定时开仓：窗口已过或停服时不受理；受理后窗口在下单前结束则不下单，本周不再开', async () => {
  const s = setup({ base: OPENING(5_000), autoOpen: AUTO(true, 10) });
  try {
    const plan = await s.engine.createPlan({ operation: 'open' });
    s.hooks.skewMs = 6_000;
    await assert.rejects(s.engine.startTask({ planId: plan.planId, requestId: 'scheduled-2026-W46', confirmLive: true }, { scheduled: true }), refused('window_closed'));
    assert.deepEqual([Object.keys(s.engine.state().tasks).length, s.engine.state().schedule.lastOpenWeek], [0, null]);
    s.hooks.skewMs = 0;
    // Admitted inside the window; the clock passes the window's end as the admission is announced, before any order.
    s.hooks.onNote = text => { if (text.includes('已确认')) s.hooks.skewMs = 6_000; };
    await s.engine.autoOpenTick();
    const [task] = Object.values(s.engine.state().tasks);
    await finished(s, task!.id);
    assert.equal(s.engine.state().tasks[task!.id]!.status, 'failed');
    assert.match(s.engine.state().tasks[task!.id]!.error ?? '', /窗口在下单前已结束/);
    assert.equal(s.fake.creates, 0);
    assert.equal(s.engine.state().schedule.lastOpenWeek, '2026-W46');
  } finally { s.dispose(); }

  const closing = setup({ base: OPENING(1_000), autoOpen: AUTO(true) });
  try {
    const plan = await closing.engine.createPlan({ operation: 'open' });
    await closing.engine.close();
    await assert.rejects(closing.engine.startTask({ planId: plan.planId, requestId: 'scheduled-2026-W46', confirmLive: true }, { scheduled: true }), (error: unknown) => error instanceof ContractError);
    await closing.engine.autoOpenTick();
    assert.deepEqual([Object.keys(closing.engine.state().tasks).length, closing.engine.state().schedule.lastOpenWeek, closing.engine.state().schedule.attemptWeek], [0, null, null]);
  } finally { closing.dispose(); }
});

test('期权：执行中停止，挂单全部撤销，任务为已停止', async () => {
  const s = setup({ fill: 'rest', orderTimeoutMs: 30_000 });
  try {
    const { started } = await open(s);
    await until(() => s.fake.orders.size === 2);
    assert.equal(s.engine.stopTask(started.taskId).status, 'stopping');
    await finished(s, started.taskId);
    assert.equal(s.engine.state().tasks[started.taskId]!.status, 'stopped');
    assert.ok([...s.fake.orders.values()].every(order => order.status === 'Cancelled' && order.side === 'Buy'));
    assert.deepEqual(s.engine.state().tracked.sizes, {});
  } finally { s.dispose(); }
});

test('期权：净价限制突破后不再下单、已挂单撤销，任务失败并标记净价超限', async () => {
  const s = setup({ fill: 'rest', orderTimeoutMs: 30_000 });
  try {
    const plan = await s.engine.createPlan({ operation: 'open' });
    const started = await s.engine.startTask({ planId: plan.planId, requestId: 'req-net-0001', confirmLive: true, minNetIncomeUsd: plan.estimatedNetUsd + 1 });
    await finished(s, started.taskId);
    const task = s.engine.state().tasks[started.taskId]!;
    assert.equal(task.status, 'failed');
    assert.equal(task.netBlocked, true);
    assert.ok([...s.fake.orders.values()].every(order => order.status === 'Cancelled'));
  } finally { s.dispose(); }
});

test('期权：风险超上限时拒绝计划；卖出宽跨保证金超上限同样拒绝', async () => {
  const condor = setup({ maxRiskUsd: 1_000 });
  try { await assert.rejects(condor.engine.createPlan({ operation: 'open' }), refused('risk_limit')); } finally { condor.dispose(); }
  const strangle = setup({ mode: 'short_strangle', maxMarginUsd: 100 });
  try {
    await assert.rejects(strangle.engine.createPlan({ operation: 'open' }), refused('risk_limit'));
    await strangle.engine.reconcileOnce();
    assert.match(String(strangle.engine.previewView(null, null).riskProblem), /保证金估算/);
  } finally { strangle.dispose(); }
});

test('期权：执行中盘口变差使组合最大亏损超上限，停止剩余开仓订单', async () => {
  const probe = setup();
  let limit: number;
  try {
    await probe.engine.createPlan({ operation: 'open' });
    const view = probe.engine.previewView(null, null).preview;
    // The plan checks both the expiry loss and the margin estimate against maxRiskUsd; the task checks the loss.
    limit = Math.max(view.maxLossUsd!, view.estimatedMarginUsd) + 5;
    assert.ok(limit - view.maxLossUsd! < 5_000);
  } finally { probe.dispose(); }
  const s = setup({ fill: 'rest', orderTimeoutMs: 30_000, maxRiskUsd: limit });
  try {
    const plan = await s.engine.createPlan({ operation: 'open' });
    const started = await s.engine.startTask({ planId: plan.planId, requestId: 'req-risk-0001', confirmLive: true, minNetIncomeUsd: -1_000_000 });
    await until(() => s.fake.orders.size === 2);
    // The wings' asks jump: chasing them costs more and grows the expiry loss past the limit.
    for (const symbol of [symbolOf(84000, 'P'), symbolOf(116000, 'C')]) s.fake.shifts.set(symbol, 3_000);
    await s.market.refresh();
    await finished(s, started.taskId);
    const task = s.engine.state().tasks[started.taskId]!;
    assert.equal(task.riskBlocked, true);
    assert.equal(task.status, 'failed');
    // Only the wings were out: the stop leaves no short leg behind.
    assert.ok([...s.fake.orders.values()].every(order => order.status === 'Cancelled' && order.side === 'Buy'));
  } finally { s.dispose(); }
});

test('期权：订单查不到时转人工核对、拒绝新计划；对账读到终态后任务结束', async () => {
  const s = setup({ fill: 'invisible' });
  try {
    const { started } = await open(s);
    await finished(s, started.taskId);
    assert.equal(s.engine.state().tasks[started.taskId]!.status, 'recovery_needed');
    assert.ok(s.notes.some(text => text.includes('有订单状态未确认')));
    await assert.rejects(s.engine.createPlan({ operation: 'open' }), refused('orders_unresolved'));
    // The wings' outcome is unknown, so the short legs never went out.
    assert.equal(s.fake.creates, 2);
    for (const order of s.fake.orders.values()) Object.assign(order, { visible: true, status: 'Filled', cumExecQty: order.qty });
    await s.engine.reconcileOnce();
    assert.equal(s.engine.state().tasks[started.taskId]!.status, 'partial');
    assert.deepEqual(Object.values(s.engine.state().tracked.sizes), ['1', '1']);
    assert.equal(s.fake.creates, 2);
  } finally { s.dispose(); }
});

test('期权：下单请求没到交易所、查无此单且没有订单号：超过接收时限后对账按未下单结算，可以再下计划', async () => {
  const s = setup({ fill: 'dropped', missingSettleMs: 0 });
  try {
    const { started } = await open(s);
    await finished(s, started.taskId);
    assert.equal(s.engine.state().tasks[started.taskId]!.status, 'recovery_needed');
    await assert.rejects(s.engine.createPlan({ operation: 'open' }), refused('orders_unresolved'));
    await s.engine.reconcileOnce();
    const orders = Object.values(s.engine.state().journal).filter(entry => entry.taskId === started.taskId);
    assert.deepEqual(orders.map(entry => [entry.status, entry.terminal, entry.filledQty]), Array(2).fill(['not_submitted', true, '0']));
    assert.ok(TERMINAL.includes(s.engine.state().tasks[started.taskId]!.status));
    assert.ok(s.logs.some(line => line.includes('按未下单结算')));
    s.fake.fillMode = 'fill';
    await s.engine.createPlan({ operation: 'open' });
    assert.equal(s.fake.creates, 2);
  } finally { s.dispose(); }
});

test('期权：下单应答丢失（5xx）不重发，撤单核对后按终态结束', async () => {
  const s = setup({ fill: 'lost-create' });
  try {
    const { started } = await open(s);
    await finished(s, started.taskId);
    const task = s.engine.state().tasks[started.taskId]!;
    assert.equal(task.status, 'failed');
    assert.equal(s.fake.creates, 2);
    assert.ok([...s.fake.orders.values()].every(order => order.status === 'Cancelled'));
  } finally { s.dispose(); }
});

test('期权：重启后进行中的任务改为恢复中并请求停止，对账撤单核对后结束；其他账户的状态库拒绝启动', async () => {
  const s = setup({ fill: 'rest', orderTimeoutMs: 30_000 });
  const second = openOptionsStore(join(s.dir, 'second.sqlite'));
  try {
    const { started } = await open(s);
    await until(() => s.fake.orders.size === 2 && Object.keys(s.engine.state().journal).length === 2);
    second.save(structuredClone(s.store.load()));
    // The first process dies; its resting orders stay on the venue.
    const restarted = s.make(second);
    const task = restarted.state().tasks[started.taskId]!;
    assert.equal(task.status, 'recovering');
    assert.equal(task.stopRequested, true);
    await assert.rejects(restarted.createPlan({ operation: 'open' }), refused('orders_unresolved'));
    await restarted.reconcileOnce();
    assert.equal(restarted.state().tasks[started.taskId]!.status, 'stopped');
    assert.ok([...s.fake.orders.values()].every(order => order.status === 'Cancelled'));
    s.engine.stopTask(started.taskId);
    await finished(s, started.taskId);
    const document = structuredClone(second.load()) as { uid: string };
    second.save({ ...document, uid: '999' });
    assert.throws(() => s.make(second), /另一个 Bybit 账户/);
  } finally { second.close(); s.dispose(); }
});

test('期权：持仓消失须有平仓历史且再读仍不在才退役；只有空持仓不退役', async () => {
  const s = setup();
  try {
    const { started } = await open(s);
    await finished(s, started.taskId);
    // A transient empty list with no history: nothing retires, reconciliation reports it.
    s.fake.hidePositions = true;
    await s.engine.reconcileOnce();
    assert.equal(Object.keys(s.engine.state().tracked.sizes).length, 4);
    assert.match(String(s.engine.stateView().reconciliation.error), /平仓历史/);
    // Closed on the venue by hand: the history covers every leg.
    s.fake.hidePositions = false;
    const acceptedAt = s.engine.state().tasks[started.taskId]!.acceptedAt;
    for (const position of [...s.fake.positions.values()]) s.fake.closed.push({ symbol: position.symbol, side: position.side, qty: String(position.size), openTime: String(acceptedAt + 1), closeTime: String(s.now() - 1) });
    s.fake.positions.clear();
    await s.engine.reconcileOnce();
    const state = s.engine.state();
    assert.deepEqual(state.tracked, { groupId: null, sizes: {} });
    assert.equal(state.tasks[started.taskId]!.strategyStatus, 'closed');
    assert.equal(state.tasks[started.taskId]!.closeReason, 'exchange_closed_position_history');
    assert.equal(s.engine.stateView().reconciliation.error, null);
  } finally { s.dispose(); }
});

type PerformanceGroupView = { id: string; status: string; sampleCount: number; netPnl: number | null; markToMarketPnl: number | null; eligible: boolean; closureKind: string | null; issues: string[] };
type PerformanceView = { groups: PerformanceGroupView[]; series: { currency: string; closedCount: number; totalPnl: number; points: unknown[] }[]; ledger: { count: number; firstAt: number | null }; error: string | null };
const performance = (engine: OptionsEngine) => engine.performanceView() as unknown as PerformanceView;

test('期权收益：持仓每分钟一个采样，持仓数据过期时不采；到期交割证据带金额时纳入综合曲线', async () => {
  const s = setup();
  try {
    const { started } = await open(s);
    await finished(s, started.taskId);
    await s.engine.reconcileOnce();
    await s.engine.performanceTick();
    await s.engine.performanceTick();
    let group = performance(s.engine).groups.find(row => row.id === started.taskId)!;
    assert.equal(group.status, 'open');
    assert.notEqual(group.markToMarketPnl, null);
    assert.equal(group.sampleCount, 1);
    // A minute later without a fresh position read: nothing is sampled, the chart shows the gap.
    s.hooks.skewMs += 61_000;
    await s.engine.performanceTick();
    assert.equal(performance(s.engine).groups.find(row => row.id === started.taskId)!.sampleCount, 1);
    await s.engine.reconcileOnce();
    await s.engine.performanceTick();
    assert.equal(performance(s.engine).groups.find(row => row.id === started.taskId)!.sampleCount, 2);
    // Delivered at expiry: the venue's closed-position rows carry the amounts, and the retire keeps them.
    s.hooks.skewMs += EXPIRY - s.now() + 60_000;
    const acceptedAt = s.engine.state().tasks[started.taskId]!.acceptedAt;
    for (const position of [...s.fake.positions.values()]) {
      s.fake.closed.push({ symbol: position.symbol, side: position.side, qty: String(position.size), openTime: String(acceptedAt + 1), closeTime: String(EXPIRY), avgEntryPrice: '100', totalPnl: position.side === 'Sell' ? '3' : '-1', totalOpenFee: '0.5', totalCloseFee: '0', deliveryFee: '0.2' });
    }
    s.fake.positions.clear();
    await s.engine.reconcileOnce();
    assert.equal(s.engine.state().tasks[started.taskId]!.strategyStatus, 'closed');
    await s.engine.performanceTick();
    const view = performance(s.engine);
    group = view.groups.find(row => row.id === started.taskId)!;
    assert.deepEqual([group.status, group.closureKind, group.eligible, group.netPnl, group.sampleCount], ['closed', 'expiry', true, 4, 2]);
    assert.equal(view.series.length, 1);
    assert.deepEqual([view.series[0]!.currency, view.series[0]!.closedCount, view.series[0]!.totalPnl, view.series[0]!.points.length], ['USDC', 1, 4, 3]);
  } finally { s.dispose(); }
});

test('期权收益：成交明细读取失败时按订单补读（5 分钟内不重读）；台账超过 100 条且重启后保留', async () => {
  const s = setup();
  try {
    s.fake.failExecutions = true;
    const { started } = await open(s);
    await finished(s, started.taskId);
    assert.equal(s.engine.state().tasks[started.taskId]!.status, 'completed');
    assert.equal(performance(s.engine).ledger.count, 0);
    // One leg was filled in 125 pieces; the venue answers again only after the first backfill try.
    const link = Object.keys(s.engine.state().journal)[0]!;
    const piece = s.fake.executions.find(row => row.orderLinkId === link)!;
    s.fake.executions = s.fake.executions.filter(row => row !== piece);
    for (let index = 0; index < 125; index += 1) s.fake.executions.push({ ...piece, execId: `split-${index}`, execQty: '0.008', execFee: '0.004' });
    await s.engine.performanceTick();
    assert.match(String(performance(s.engine).error), /补读失败/);
    s.fake.failExecutions = false;
    await s.engine.performanceTick();
    assert.equal(performance(s.engine).ledger.count, 0);
    s.hooks.skewMs += 5 * 60_000;
    await s.engine.performanceTick();
    const view = performance(s.engine);
    assert.equal(view.ledger.count, 128);
    assert.equal(view.error, null);
    assert.equal(s.engine.state().executions.length, 100);
    const before = view.groups.find(row => row.id === started.taskId)!;
    assert.equal(before.issues.length, 0);
    // A restart reads the whole ledger from its table, not the capped recent list.
    await s.engine.close();
    const reopened = openOptionsStore(join(s.dir, 'options.sqlite'));
    try {
      const restarted = s.make(reopened);
      const after = performance(restarted);
      assert.equal(after.ledger.count, 128);
      // Compared as JSON: a -0 price difference comes back from the table as 0.
      assert.equal(JSON.stringify(after.groups.find(row => row.id === started.taskId)), JSON.stringify(before));
    } finally { reopened.close(); }
  } finally { s.dispose(); }
});

test('期权收益：到期后或平仓成交待确认时不再采样（持仓数据仍新鲜）', async () => {
  for (const when of ['expiry', 'closing'] as const) {
    const s = setup();
    try {
      const { started } = await open(s);
      await finished(s, started.taskId);
      await s.engine.reconcileOnce();
      await s.engine.performanceTick();
      s.hooks.skewMs += when === 'expiry' ? EXPIRY - s.now() + 1_000 : 61_000;
      await s.engine.reconcileOnce();
      if (when === 'closing') {
        s.fake.fillMode = 'rest';
        const plan = await s.engine.createPlan({ operation: 'close' });
        await s.engine.startTask({ planId: plan.planId, requestId: 'req-close-0001', confirmLive: true });
      }
      await s.engine.performanceTick();
      const group = performance(s.engine).groups.find(row => row.id === started.taskId)!;
      assert.equal(group.sampleCount, 1, when);
      if (when === 'closing') assert.equal(group.status, 'pending');
    } finally { s.dispose(); }
  }
});

test('期权收益：v0.13 状态里的成交在首次启动时转入台账', async () => {
  const s = setup();
  try {
    const { started } = await open(s);
    await finished(s, started.taskId);
    const saved = s.engine.state();
    assert.ok(saved.executions.length > 0);
    await s.engine.close();
    // A v0.13 database: the state document only, no ledger rows.
    const old = openOptionsStore(join(s.dir, 'v013.sqlite'));
    try {
      old.save(JSON.parse(JSON.stringify(saved)));
      const upgraded = s.make(old);
      const view = performance(upgraded);
      assert.equal(view.ledger.count, saved.executions.length);
      assert.deepEqual(view.groups.find(row => row.id === started.taskId)!.issues, []);
      assert.equal(old.executions().length, saved.executions.length);
    } finally { old.close(); }
  } finally { s.dispose(); }
});

test('期权：实盘开仓只在周五（UTC），计划过期或缺少确认被拒绝', async () => {
  const thursday = setup({ base: FRIDAY - 86_400_000 });
  try { await assert.rejects(thursday.engine.createPlan({ operation: 'open' }), refused('calendar')); } finally { thursday.dispose(); }
  const s = setup();
  try {
    const plan = await s.engine.createPlan({ operation: 'open' });
    await assert.rejects(s.engine.startTask({ planId: plan.planId, requestId: 'req-confirm-01', confirmLive: false }), refused('confirm_required'));
    await assert.rejects(s.engine.startTask({ planId: 'f'.repeat(32), requestId: 'req-missing-01', confirmLive: true }), refused('plan_missing'));
    await assert.rejects(s.engine.startTask({ planId: plan.planId, requestId: 'req-mismatch-1', confirmLive: true, maxNetCostUsd: 5 }), refused('net_limit_mismatch'));
    await assert.rejects(s.engine.createPlan({ operation: 'close' }), refused('nothing_to_close'));
  } finally { s.dispose(); }
});

test('期权：启动检查要求期权交易权限、绑定 IP、UID 一致，其余权限须关闭', async () => {
  const fake = new FakeOptions(Date.now);
  const client = createOptionsClient({ credentials: CREDENTIALS, fetchImpl: fake.fetch });
  const config = parseOptionsConfig({ accountId: UID, limits: { maxRiskUsd: 500, maxMarginUsd: 1_000 } });
  await preflightOptions(client, config, 5_000);
  fake.permissions = { ...fake.permissions, Wallet: ['AccountTransfer'] };
  await assert.rejects(preflightOptions(client, config, 5_000), /请关闭：钱包/);
  fake.permissions = { ...fake.permissions, Wallet: [], Options: [] };
  await assert.rejects(preflightOptions(client, config, 5_000), /期权交易/);
  fake.permissions = { ...fake.permissions, Options: ['OptionsTrade'] };
  fake.ips = ['*'];
  await assert.rejects(preflightOptions(client, config, 5_000), /绑定 IP/);
  fake.ips = ['203.0.113.7'];
  fake.uid = 87654321;
  await assert.rejects(preflightOptions(client, config, 5_000), /不符/);
  // The futures check is unchanged: options trading stays forbidden there.
  assert.match(String(bybitPermissionProblem({ readOnly: 0, permissions: { ContractTrade: ['Order'], Derivatives: [], Wallet: [], Spot: [], Options: ['OptionsTrade'] } })), /请关闭：期权/);
});

test('期权：配置缺省值与校验；只配 options 时 pairs 可省略，密钥须有 bybitOptions', () => {
  const config = parseOptionsConfig({ accountId: UID, limits: { maxRiskUsd: 500, maxMarginUsd: 1_000 } });
  assert.deepEqual({ ...config, limits: undefined }, { accountId: UID, limits: undefined, legQty: '1', strategyMode: 'iron_condor', marginMode: 'REGULAR_MARGIN', orderTimeoutSeconds: 600, feeRate: 0.0003, marginBufferPct: 0.10, autoOpen: false, openHourUtc: 21, openMinuteUtc: 0, openWindowSeconds: 60, marketFallback: false });
  assert.match(optionsSummary(config), /期权账户 Bybit \*\*\*5678.*定时开仓配置关）$/);
  const scheduled = parseOptionsConfig({ accountId: UID, limits: { maxRiskUsd: 500, maxMarginUsd: 1_000 }, autoOpen: true, openHourUtc: 20, openMinuteUtc: 5, openWindowSeconds: 300, marketFallback: true });
  assert.match(optionsSummary(scheduled), /定时开仓配置开（周五 20:05 UTC），IOC 兜底开）$/);
  for (const [field, value] of [['autoOpen', 'yes'], ['openHourUtc', 24], ['openMinuteUtc', 1.5], ['openWindowSeconds', 0], ['openWindowSeconds', 301], ['marketFallback', 1]] as const) {
    assert.throws(() => parseOptionsConfig({ accountId: UID, limits: { maxRiskUsd: 1, maxMarginUsd: 1 }, [field]: value }), new RegExp(field));
  }
  assert.equal(optionsSummary(undefined), '');
  assert.throws(() => parseOptionsConfig({ accountId: 'abc', limits: { maxRiskUsd: 500, maxMarginUsd: 1_000 } }), /UID/);
  assert.throws(() => parseOptionsConfig({ accountId: UID, limits: { maxRiskUsd: 0, maxMarginUsd: 1_000 } }), /maxRiskUsd/);
  assert.throws(() => parseOptionsConfig({ accountId: UID, limits: { maxRiskUsd: 1, maxMarginUsd: 1 }, orderTimeoutSeconds: 10 }), /orderTimeoutSeconds/);
  assert.throws(() => parseOptionsConfig({ accountId: UID, limits: { maxRiskUsd: 1, maxMarginUsd: 1 }, extra: 1 }), /不支持的字段/);
  const service = parseServiceConfig({ secretsFile: '/etc/x/secrets.json', options: { accountId: UID, limits: { maxRiskUsd: 500, maxMarginUsd: 1_000 } } });
  assert.deepEqual(service.pairs, []);
  assert.equal(service.options?.accountId, UID);
  assert.throws(() => parseServiceConfig({ secretsFile: '/etc/x/secrets.json' }), /缺少字段：pairs/);
  assert.throws(() => parseServiceSecrets({ accounts: {} }, [], [], true), /bybitOptions/);
  assert.equal(parseServiceSecrets({ accounts: {}, bybitOptions: CREDENTIALS }, [], [], true).bybitOptions?.apiKey, CREDENTIALS.apiKey);
  assert.throws(() => parseServiceSecrets({ accounts: {}, bybitOptions: CREDENTIALS }, [], []), /不支持的字段/);
});

test('期权：接口未配置时 404；配置后可读状态、校验请求体，停止未知任务返回 409', async () => {
  const s = setup();
  const h = createHarness();
  bindAccounts(h.ex);
  const servers = [createExecutorServer({ executor: h.ex, accessToken: 'options-token-0001', session: 'options-session-0001' }), createExecutorServer({ executor: h.ex, accessToken: 'options-token-0001', session: 'options-session-0001', views: { options: optionsViews(s.engine) } })];
  try {
    const [plain, wired] = await Promise.all(servers.map(async server => {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const login = await fetch(`${base}/login?token=options-token-0001`, { redirect: 'manual' });
      return { base, cookie: (login.headers.get('set-cookie') ?? '').split(';')[0]! };
    }));
    const get = (target: typeof plain, path: string) => fetch(target.base + path, { headers: { cookie: target.cookie } });
    const post = (target: typeof plain, path: string, body: unknown) => fetch(target.base + path, { method: 'POST', headers: { cookie: target.cookie, 'content-type': 'application/json', 'x-pa-executor': '1' }, body: JSON.stringify(body) });
    assert.equal((await get(plain!, '/api/options/state')).status, 404);
    const state = await get(wired!, '/api/options/state');
    assert.equal(state.status, 200);
    assert.equal(((await state.json()) as { account: string }).account, '***5678');
    assert.equal((await post(wired!, '/api/options/plans', { operation: 'open', extra: 1 })).status, 400);
    assert.equal((await post(wired!, '/api/options/plans', { operation: 'close', quantity: '1' })).status, 400);
    assert.equal((await post(wired!, '/api/options/tasks', { planId: 'x', requestId: 'req-http-0001', confirmLive: true })).status, 400);
    assert.equal((await post(wired!, '/api/options/tasks/0123456789abcdef/stop', {})).status, 409);
    assert.equal((await get(wired!, '/api/options/unknown')).status, 404);
    assert.equal((await post(wired!, '/api/options/auto-open', { enabled: 'yes' })).status, 400);
    assert.equal((await post(wired!, '/api/options/auto-open', { enabled: true, extra: 1 })).status, 400);
    const switched = await post(wired!, '/api/options/auto-open', { enabled: true });
    assert.equal(switched.status, 200);
    assert.deepEqual(((await switched.json()) as { enabled: boolean; source: string }), { ...(s.engine.stateView().schedule), enabled: true, source: 'page' });
    // 组合询价 (G2c): bodies are checked before the engine; the read answers without an RFQ.
    assert.equal((await post(wired!, '/api/options/rfq', { requestId: 'req-rfq-0001', confirmLive: true, extra: 1 })).status, 400);
    assert.equal((await post(wired!, '/api/options/rfq', { requestId: 'x', confirmLive: true })).status, 400);
    assert.equal((await post(wired!, '/api/options/rfq/execute', { rfqId: 'r1', quoteId: 'q 1', confirmLive: true })).status, 400);
    assert.equal((await post(wired!, '/api/options/rfq/execute', { rfqId: 'r1', quoteId: 'q1', confirmLive: true })).status, 409);
    assert.equal((await post(wired!, '/api/options/rfq/cancel', { rfqId: 'r1' })).status, 409);
    const rfqRead = (await (await get(wired!, '/api/options/rfq')).json()) as { rfq: unknown; finished: boolean };
    assert.equal(rfqRead.rfq, null);
    assert.equal(rfqRead.finished, true);
    await s.market.refresh();
    const market = (await (await get(wired!, '/api/options/market')).json()) as { rows: unknown[]; expiry: number };
    assert.ok(market.rows.length > 0 && market.expiry > 0);
    // The state carries the server's staleness verdict for the tabs that do not read the market.
    const fresh = (await (await get(wired!, '/api/options/state')).json()) as { market: { stale: boolean } };
    assert.equal(fresh.market.stale, false);
  } finally {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    h.dispose();
    s.dispose();
  }
});

// ---- 组合询价 RFQ (G2c) ------------------------------------------------------------------------------------------
let rfqSeq = 0;
const rfqRequest = () => ({ requestId: `rfq-${String(++rfqSeq).padStart(8, '0')}`, confirmLive: true });
async function activeRfq(s: Setup) {
  const created = await s.engine.createRfq(rfqRequest());
  assert.equal(created.status, 'Active');
  return created.rfqId!;
}

test('询价：创建发给做市商、交易被锁定；执行报价成交后成为跟踪中的开仓任务，成交明细按订单号归到该任务', async () => {
  const s = setup();
  try {
    const request = rfqRequest();
    const created = await s.engine.createRfq(request);
    assert.equal(created.status, 'Active');
    assert.deepEqual(await s.engine.createRfq(request), created, '同一请求编号幂等');
    await assert.rejects(s.engine.createRfq({ ...request, quantity: '2' }), refused('request_reused'));
    const sent = s.fake.calls.find(call => call.path === '/v5/rfq/create-rfq')!.body!;
    assert.deepEqual(sent.counterparties, ['DESK1', 'DESK2'], '最多 maxLP 家');
    assert.equal(sent.strategyType, 'Iron_Condor');
    assert.equal((sent.list as Row[]).length, 4);
    assert.ok(/^tporfq[0-9a-f]{16}$/.test(String(sent.rfqLinkId)));
    await assert.rejects(s.engine.createPlan({ operation: 'open' }), refused('rfq_active'));
    await assert.rejects(s.engine.createRfq(rfqRequest()), refused('rfq_active'));
    s.fake.addQuote({ quoteId: 'low', shift: -20 });
    s.fake.addQuote({ quoteId: 'high', deskCode: 'DESK2', shift: 5 });
    s.fake.addQuote({ quoteId: 'part', drop: symbolOf(84000, 'P') });
    await s.engine.rfqTick();
    const view = s.engine.rfqView();
    assert.deepEqual(view.quotes.map(quote => quote.quoteId), ['high', 'low', 'part'], '全覆盖在前、净收入高的在前');
    assert.equal(view.quotes[2]!.netUsd, null);
    assert.ok(view.quotes[2]!.problem);
    assert.equal(view.quotes[0]!.problem, null);
    assert.ok(view.quotes[0]!.feeUsd! > 0 && view.quotes[0]!.netUsd! > view.quotes[1]!.netUsd!);
    await assert.rejects(s.engine.executeQuote({ rfqId: created.rfqId!, quoteId: 'high', confirmLive: false }), refused('confirm_required'));
    await assert.rejects(s.engine.executeQuote({ rfqId: created.rfqId!, quoteId: 'part', confirmLive: true }), refused('quote_invalid'));
    const executed = await s.engine.executeQuote({ rfqId: created.rfqId!, quoteId: 'high', confirmLive: true });
    assert.equal(executed.status, 'PendingFill');
    assert.deepEqual(await s.engine.executeQuote({ rfqId: created.rfqId!, quoteId: 'high', confirmLive: true }), executed, '同一报价重试幂等');
    await s.engine.rfqTick();
    const state = s.engine.state(), task = state.tasks[created.taskId]!;
    assert.equal(state.rfq!.status, 'Filled');
    assert.equal(state.rfq!.trackingApplied, true);
    assert.equal(task.status, 'completed');
    assert.deepEqual(task.rfq, { rfqId: created.rfqId, quoteId: 'high', deskCode: 'DESK2' });
    assert.equal(state.tracked.groupId, task.id);
    assert.deepEqual(Object.values(state.tracked.sizes), ['1', '1', '1', '1']);
    const entries = Object.entries(state.journal).filter(([, entry]) => entry.taskId === task.id);
    assert.equal(entries.length, 4);
    assert.ok(entries.every(([link, entry]) => link.startsWith('tpo-rfq-') && entry.kind === 'rfq' && entry.terminal && entry.filledQty === '1' && entry.orderId.startsWith('b')));
    assert.ok(s.notes.some(note => note.includes('询价开仓已成交')));
    await until(() => s.engine.state().executions.filter(record => record.taskId === task.id).length === 4);
    assert.ok(s.engine.state().executions.every(record => record.taskId !== task.id || record.orderLinkId.startsWith('tpo-rfq-')));
    const group = s.engine.performanceView().groups.find(row => row.id === task.id)!;
    assert.ok(group, '收益页有这次询价开仓');
    // Trading is free again; the tracked strategy blocks another RFQ, and closes as usual.
    await assert.rejects(s.engine.createRfq(rfqRequest()), refused('strategy_open'));
    const close = await s.engine.createPlan({ operation: 'close' });
    assert.equal(close.legs.length, 4);
  } finally { s.dispose(); }
});

test('询价：创建应答丢失时按链接编号核对；被拒绝即失败不锁定；交易所始终查不到的按未创建结算', async () => {
  const lost = setup();
  try {
    lost.fake.rfqWrite = 'lost';
    const created = await lost.engine.createRfq(rfqRequest());
    assert.equal(created.status, 'CreationUnknown');
    assert.equal(lost.engine.rfqView().finished, false);
    await lost.engine.rfqTick();
    assert.equal(lost.engine.state().rfq!.status, 'Active');
    assert.equal(lost.engine.state().rfq!.rfqId, lost.fake.rfq!.rfqId);
  } finally { lost.dispose(); }
  const refusedCreate = setup();
  try {
    refusedCreate.fake.rfqWrite = 'refused';
    const created = await refusedCreate.engine.createRfq(rfqRequest());
    assert.equal(created.status, 'Failed');
    assert.equal(refusedCreate.engine.rfqView().finished, true);
    await refusedCreate.engine.createPlan({ operation: 'open' });
  } finally { refusedCreate.dispose(); }
  const dropped = setup({ missingSettleMs: 50 });
  try {
    dropped.fake.rfqWrite = 'dropped';
    assert.equal((await dropped.engine.createRfq(rfqRequest())).status, 'CreationUnknown');
    await dropped.engine.rfqTick();
    assert.equal(dropped.engine.state().rfq!.status, 'CreationUnknown', '未到结算时间仍锁定');
    dropped.hooks.skewMs = 100;
    await dropped.engine.rfqTick();
    assert.equal(dropped.engine.state().rfq!.status, 'Failed');
    assert.equal(dropped.engine.rfqView().finished, true);
  } finally { dropped.dispose(); }
});

test('询价：执行结果未知跨重启保持锁定，滞后的 Active 不会让询价重新可执行；成交或过期后才解除', async () => {
  const s = setup();
  try {
    const rfqId = await activeRfq(s);
    s.fake.addQuote({ quoteId: 'a' });
    s.fake.addQuote({ quoteId: 'b' });
    s.fake.rfqWrite = 'dropped';
    const executed = await s.engine.executeQuote({ rfqId, quoteId: 'a', confirmLive: true });
    assert.equal(executed.status, 'ExecutionUnknown');
    s.fake.rfqWrite = 'ok';
    const restarted = s.make(s.store);
    assert.equal(restarted.state().rfq!.status, 'ExecutionUnknown');
    await assert.rejects(restarted.createPlan({ operation: 'open' }), refused('rfq_active'));
    await restarted.rfqTick();
    assert.equal(restarted.state().rfq!.status, 'ExecutionUnknown', '交易所仍显示 Active');
    await assert.rejects(restarted.executeQuote({ rfqId, quoteId: 'b', confirmLive: true }), refused('rfq_state'));
    await assert.rejects(restarted.cancelRfq({ rfqId }), refused('rfq_state'));
    s.fake.rfq!.status = 'Expired';
    await restarted.rfqTick();
    const rfq = restarted.state().rfq!;
    assert.equal(rfq.status, 'Expired');
    assert.equal(rfq.executionResolved, true);
    assert.ok(s.notes.some(note => note.includes('没有成交')));
    await restarted.createPlan({ operation: 'open' });
  } finally { s.dispose(); }
  const pending = setup();
  try {
    const rfqId = await activeRfq(pending);
    pending.fake.addQuote({ quoteId: 'a' });
    pending.fake.executeOutcome = 'pending';
    pending.fake.rfqWrite = 'lost';
    assert.equal((await pending.engine.executeQuote({ rfqId, quoteId: 'a', confirmLive: true })).status, 'ExecutionUnknown');
    pending.fake.rfqWrite = 'ok';
    await pending.engine.rfqTick();
    assert.equal(pending.engine.state().rfq!.status, 'PendingFill');
    pending.fake.tradeMode = 'empty';
    pending.fake.settleRfq('a');
    await pending.engine.rfqTick();
    assert.equal(pending.engine.state().rfq!.status, 'Filled');
    assert.equal(pending.engine.rfqView().finished, false, '成交记录到达前仍锁定');
    pending.fake.tradeMode = 'ok';
    await pending.engine.rfqTick();
    assert.equal(pending.engine.state().tracked.groupId, pending.engine.state().rfq!.taskId);
    assert.equal(pending.engine.rfqView().finished, true);
  } finally { pending.dispose(); }
});

test('询价：执行前复核报价覆盖、数量、有效期、风险上限与日历；执行被拒或回复失败可换报价', async () => {
  const s = setup({ maxRiskUsd: 20_000 });
  try {
    const rfqId = await activeRfq(s);
    const legs = s.fake.rfq!.legs.map(leg => String(leg.symbol));
    s.fake.addQuote({ quoteId: 'soon', expiresInMs: 1_000 });
    s.fake.addQuote({ quoteId: 'cheap', prices: Object.fromEntries(legs.map(symbol => [symbol, s.fake.rfq!.legs.find(leg => leg.symbol === symbol)!.side === 'Sell' ? 1 : 5_000])) });
    s.fake.addQuote({ quoteId: 'good' });
    s.fake.rfqQuotes.push({ ...s.fake.rfqQuotes.at(-1)!, quoteId: 'qty', quoteSellList: (s.fake.rfqQuotes.at(-1)!.quoteSellList as Row[]).map((leg, index) => index === 0 ? { ...leg, qty: '2' } : leg) });
    await assert.rejects(s.engine.executeQuote({ rfqId, quoteId: 'soon', confirmLive: true }), refused('quote_invalid'));
    await assert.rejects(s.engine.executeQuote({ rfqId, quoteId: 'qty', confirmLive: true }), refused('quote_invalid'));
    await assert.rejects(s.engine.executeQuote({ rfqId, quoteId: 'cheap', confirmLive: true }), refused('risk_limit'));
    await assert.rejects(s.engine.executeQuote({ rfqId, quoteId: 'none', confirmLive: true }), refused('quote_missing'));
    // A Saturday execution of an RFQ (and quote) still live is refused by the calendar.
    s.fake.rfq!.expiresAt += 2 * 86_400_000;
    s.fake.addQuote({ quoteId: 'late', expiresInMs: 2 * 86_400_000 });
    await s.engine.rfqTick();
    s.hooks.skewMs = 86_400_000;
    await assert.rejects(s.engine.executeQuote({ rfqId, quoteId: 'late', confirmLive: true }), refused('calendar'));
    s.hooks.skewMs = 0;
    s.fake.rfqWrite = 'refused';
    const riskBefore = structuredClone(s.engine.state().rfq!.risk), baselineBefore = structuredClone(s.engine.state().pmBaseline);
    const refusedRun = await s.engine.executeQuote({ rfqId, quoteId: 'good', confirmLive: true });
    assert.equal(refusedRun.status, 'Active');
    assert.ok(refusedRun.error?.includes('拒绝'));
    assert.deepEqual(s.engine.state().rfq!.risk, riskBefore, '被拒的报价不留下它的风险');
    assert.deepEqual(s.engine.state().pmBaseline, baselineBefore, '被拒的报价不留下它的保证金基线');
    s.fake.rfqRefusalCode = 110304; // RFQ-specific refusal (quote no longer executable): definite, not unknown.
    assert.equal((await s.engine.executeQuote({ rfqId, quoteId: 'good', confirmLive: true })).status, 'Active');
    s.fake.rfqRefusalCode = 10001;
    s.fake.rfqWrite = 'ok';
    s.fake.executeOutcome = 'fail';
    const failed = await s.engine.executeQuote({ rfqId, quoteId: 'good', confirmLive: true });
    assert.equal(failed.status, 'Active');
    assert.equal(s.engine.state().rfq!.selectedQuoteId, null);
    s.fake.executeOutcome = 'fill';
    assert.equal((await s.engine.executeQuote({ rfqId, quoteId: 'good', confirmLive: true })).status, 'PendingFill');
    await s.engine.rfqTick();
    assert.equal(s.engine.state().rfq!.trackingApplied, true);
    const adopted = s.engine.state().tasks[s.engine.state().rfq!.taskId]!;
    assert.equal(adopted.acceptedAt, s.engine.state().rfq!.createdAt, '受理时间是询价创建时间');
    assert.equal(adopted.startedAt, s.engine.state().rfq!.executionStartedAt);
    assert.equal(s.fake.calls.filter(call => call.path === '/v5/order/create').length, 0, '询价不下普通订单');
  } finally { s.dispose(); }
});

test('询价：取消先记为待确认，交易所确认后结束；取消被拒绝恢复等待报价；成交记录两分钟对不上时按询价结构跟踪并通知一次', async () => {
  const s = setup();
  try {
    const rfqId = await activeRfq(s);
    s.fake.rfqWrite = 'refused';
    const refusedCancel = await s.engine.cancelRfq({ rfqId });
    assert.equal(refusedCancel.status, 'Active');
    s.fake.rfqWrite = 'ok';
    assert.equal((await s.engine.cancelRfq({ rfqId })).status, 'CancelUnknown');
    await s.engine.rfqTick();
    assert.equal(s.engine.state().rfq!.status, 'Canceled');
    assert.equal(s.engine.rfqView().finished, true);
  } finally { s.dispose(); }
  const bad = setup();
  try {
    const rfqId = await activeRfq(bad);
    bad.fake.addQuote({ quoteId: 'a' });
    bad.fake.tradeMode = 'mismatch';
    await bad.engine.executeQuote({ rfqId, quoteId: 'a', confirmLive: true });
    await bad.engine.rfqTick();
    await bad.engine.rfqTick();
    const rfq = bad.engine.state().rfq!;
    assert.equal(rfq.status, 'Filled');
    assert.equal(rfq.trackingApplied, false, '两分钟内成交记录对不上：继续核对，交易保持锁定');
    assert.ok(bad.engine.rfqView().readError?.includes('不一致'));
    assert.equal(Object.keys(bad.engine.state().tracked.sizes).length, 0);
    await assert.rejects(bad.engine.createPlan({ operation: 'open' }), refused('rfq_active'));
    bad.hooks.skewMs = 120_000;
    await bad.engine.rfqTick();
    await bad.engine.rfqTick();
    assert.equal(rfq.trackingApplied, true);
    assert.ok(rfq.error?.includes('待人工核对'));
    assert.equal(bad.notes.filter(note => note.includes('待人工核对')).length, 1);
    assert.equal(bad.engine.state().tracked.groupId, rfq.taskId);
    assert.deepEqual(Object.values(bad.engine.state().tracked.sizes), rfq.legs.map(leg => leg.qty));
    const links = bad.engine.state().tasks[rfq.taskId]!.links;
    assert.ok(links.every(link => bad.engine.state().journal[link]!.orderId === ''), '没有成交记录就不编订单号');
    assert.equal(bad.engine.rfqView().finished, true);
  } finally { bad.dispose(); }
  const unread = setup();
  try {
    // A trade list that never answers counts like one that lacks the trade; the wait starts when this process first sees
    // the fill (here long after the execution was sent), so a late first look never tracks without waiting.
    const rfqId = await activeRfq(unread);
    unread.fake.addQuote({ quoteId: 'a' });
    unread.fake.executeOutcome = 'pending';
    await unread.engine.executeQuote({ rfqId, quoteId: 'a', confirmLive: true });
    unread.hooks.skewMs = 300_000;
    unread.fake.tradeMode = 'error';
    unread.fake.settleRfq('a');
    await unread.engine.rfqTick();
    const rfq = unread.engine.state().rfq!;
    assert.equal(rfq.status, 'Filled');
    assert.equal(rfq.trackingApplied, false, '首次看到成交时不立即兜底');
    assert.ok(unread.engine.rfqView().readError?.includes('读取失败'));
    unread.hooks.skewMs = 420_000;
    await unread.engine.rfqTick();
    assert.equal(rfq.trackingApplied, true);
    assert.ok(rfq.error?.includes('读取失败'));
    assert.equal(unread.notes.filter(note => note.includes('待人工核对')).length, 1);
  } finally { unread.dispose(); }
  const held = setup();
  try {
    // A strategy tracked meanwhile (only a person's change can do that) is never replaced by the RFQ.
    const rfqId = await activeRfq(held);
    held.fake.addQuote({ quoteId: 'a' });
    await held.engine.executeQuote({ rfqId, quoteId: 'a', confirmLive: true });
    const before = { groupId: 'other', sizes: { 'X|Buy': '1' } };
    held.engine.state().tracked = structuredClone(before);
    await held.engine.rfqTick();
    const rfq = held.engine.state().rfq!;
    assert.equal(rfq.trackingApplied, true);
    assert.ok(rfq.error?.includes('已有跟踪中的策略'));
    assert.deepEqual(held.engine.state().tracked, before);
    assert.equal(held.engine.state().tasks[rfq.taskId], undefined);
    assert.equal(held.notes.filter(note => note.includes('已有跟踪中的策略')).length, 1);
    await held.engine.rfqTick();
    assert.equal(held.notes.filter(note => note.includes('已有跟踪中的策略')).length, 1);
  } finally { held.dispose(); }
  const foreign = setup();
  try {
    // An answer naming another RFQ proves nothing: the execution stays unknown (and trading locked) for the loop.
    const rfqId = await activeRfq(foreign);
    foreign.fake.addQuote({ quoteId: 'a' });
    foreign.fake.executeOutcome = 'foreign';
    const answer = await foreign.engine.executeQuote({ rfqId, quoteId: 'a', confirmLive: true });
    assert.equal(answer.status, 'ExecutionUnknown');
    assert.ok(answer.error?.includes('不符'));
    await foreign.engine.rfqTick();
    assert.equal(foreign.engine.state().rfq!.status, 'ExecutionUnknown');
    assert.equal(foreign.engine.rfqView().finished, false);
  } finally { foreign.dispose(); }
});
