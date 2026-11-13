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
import { createOptionsEngine, type OptionsEngine, type TaskStatus } from '../src/options/engine.ts';
import { createOptionMarket } from '../src/options/market.ts';
import { openOptionsStore, type OptionsStore } from '../src/options/store.ts';
import { DEFAULT_ESTIMATES, type StrategyMode } from '../src/options/strategy.ts';
import { parseServiceConfig, parseServiceSecrets } from '../src/service/config.ts';
import { optionsSummary, parseOptionsConfig } from '../src/service/options-config.ts';
import { optionsViews, preflightOptions } from '../src/service/options.ts';
import { bindAccounts, createHarness } from './harness.ts';
import { FRIDAY, FakeOptions, UID, symbolOf, type FillMode } from './options-fake.ts';

const CREDENTIALS = { apiKey: 'options-test-key', apiSecret: 'options-test-secret' };
const TERMINAL: TaskStatus[] = ['completed', 'partial', 'stopped', 'failed'];

interface Setup { fake: FakeOptions; market: ReturnType<typeof createOptionMarket>; engine: OptionsEngine; store: OptionsStore; notes: string[]; logs: string[]; dir: string; now: () => number; make(store: OptionsStore): OptionsEngine; dispose(): void }

function setup({ mode = 'iron_condor', fill = 'fill', maxRiskUsd = 50_000, maxMarginUsd = 50_000, orderTimeoutMs = 600, base = FRIDAY, missingSettleMs }: { mode?: StrategyMode; fill?: FillMode; maxRiskUsd?: number; maxMarginUsd?: number; orderTimeoutMs?: number; base?: number; missingSettleMs?: number } = {}): Setup {
  const started = Date.now();
  const now = () => base + (Date.now() - started);
  const fake = new FakeOptions(now);
  fake.fillMode = fill;
  const client = createOptionsClient({ credentials: CREDENTIALS, fetchImpl: fake.fetch });
  const market = createOptionMarket(client, { now });
  const dir = mkdtempSync(join(tmpdir(), 'options-test-'));
  const store = openOptionsStore(join(dir, 'options.sqlite'));
  const notes: string[] = [], logs: string[] = [];
  const make = (target: OptionsStore) => createOptionsEngine({
    client, market, store: target, uid: UID, now, notify: text => notes.push(text), log: line => logs.push(line),
    sleep: () => new Promise(resolve => setTimeout(resolve, 2)), pollMs: 20, sampleMs: 40, ...(missingSettleMs === undefined ? {} : { missingSettleMs }),
    settings: { maxRiskUsd, maxMarginUsd, legQty: '1', strategyMode: mode, orderTimeoutMs, estimates: DEFAULT_ESTIMATES },
  });
  const engine = make(store);
  return { fake, market, engine, store, notes, logs, dir, now, make, dispose: () => { try { store.close(); } catch { /* closed */ } rmSync(dir, { recursive: true, force: true }); } };
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
  assert.deepEqual({ ...config, limits: undefined }, { accountId: UID, limits: undefined, legQty: '1', strategyMode: 'iron_condor', marginMode: 'REGULAR_MARGIN', orderTimeoutSeconds: 600, feeRate: 0.0003, marginBufferPct: 0.10 });
  assert.match(optionsSummary(config), /期权账户 Bybit \*\*\*5678/);
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
