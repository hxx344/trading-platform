// Monitor M-3a: oil and Hynix threshold alerts (src/monitor/alerts.ts), the outbox additions they use (src/service/feishu.ts)
// and the three endpoints.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { ContractError } from '../src/contracts.ts';
import { ALERT_TEXT_MAX, QUEUE_RETRY_MS, TEST_INTERVAL_MS, createAlertService, createTestGate, evaluateRule, validateAlertConfig, type AlertDelivery, type AlertMarket, type AlertRule } from '../src/monitor/alerts.ts';
import { createMonitorStore, type MonitorStore } from '../src/monitor/store.ts';
import { createNotifier } from '../src/service/feishu.ts';
import { parseServiceConfig } from '../src/service/config.ts';
import { monitorStatus, monitorViews, openMonitor, stopMonitor } from '../src/service/monitor.ts';
import { applyAlertGrid, gridDefaults } from '../web/src/alert-grid.ts';
import { ALERT_MARKETS, alertView, alertViewFor, historyText, newRule } from '../web/src/monitor-alerts.ts';
import { createExecutorServer } from '../src/http.ts';
import { createHarness } from './harness.ts';
import { fakeAnthropicVenues } from './monitor-fake.ts';

const T0 = Date.parse('2026-11-14T08:00:00.000Z');
const rule = (values: Partial<AlertRule> = {}): AlertRule => ({ id: 'r1', label: '价差 4', metric: 'spread', operator: 'gte', threshold: 4, cooldownMinutes: 30, hysteresis: 0.1, enabled: true, ...values });
const oilQuote = (brent: number, wti: number, at: number, status = 'live') => ({ source: 'Binance', currency: 'USDT', fetchedAt: new Date(at).toISOString(), brent: { coin: 'BZUSDT', markPx: brent }, wti: { coin: 'CLUSDT', markPx: wti }, status });
const hynixQuote = (premium: number, at: number) => ({ source: 'Hyperliquid', fetchedAt: new Date(at).toISOString(), adr: 120, ordinary: 1000, equivalent: 100, spread: 20, premium, status: 'live' });

test('判定：单向一次越线只提醒一次，离开回差才结束，冷却跨越线生效', () => {
  const r = rule();
  let step = evaluateRule(r, undefined, 4, T0);
  assert.equal(step.due, true);
  step.state.alerted = true; step.state.lastSentAt = T0;
  step = evaluateRule(r, step.state, 4.5, T0 + 10_000);
  assert.equal(step.due, false, '持续越线不再提醒');
  step = evaluateRule(r, step.state, 3.95, T0 + 20_000);
  assert.equal(step.state.active, true, '未离开回差（3.9）仍算同一次越线');
  step = evaluateRule(r, step.state, 3.89, T0 + 30_000);
  assert.equal(step.state.active, false);
  step = evaluateRule(r, step.state, 4.1, T0 + 40_000);
  assert.deepEqual([step.due, step.state.active], [false, true], '再次越线但冷却未过');
  step = evaluateRule(r, step.state, 4.1, T0 + 30 * 60_000);
  assert.equal(step.due, true, '冷却结束后仍在越线中且未提醒过：提醒');
  // Floating point: 0.1 + 0.2 reaches a 0.3 threshold.
  assert.equal(evaluateRule(rule({ threshold: 0.3 }), undefined, 0.1 + 0.2, T0).due, true);
  assert.equal(evaluateRule(rule({ operator: 'lte', threshold: 3 }), undefined, 3.0000001, T0).due, false);
  assert.equal(evaluateRule(rule({ operator: 'lte', threshold: 3 }), undefined, 2.9, T0).due, true);
  assert.equal(evaluateRule(rule({ enabled: false }), undefined, 9, T0).due, false);
});

test('判定：双向穿越保存时不报当前所在一侧，穿越后各侧各报一次，冷却共用', () => {
  const r = rule({ operator: 'both', cooldownMinutes: 0 });
  let step = evaluateRule(r, undefined, 5, T0);
  assert.equal(step.due, false, '保存时已在上方：不报');
  step = evaluateRule(r, step.state, 3.8, T0 + 1);
  assert.deepEqual([step.due, step.operator], [true, 'lte'], '向下穿越');
  step.state.sides!.lte.alerted = true; step.state.lastSentAt = T0 + 1;
  step = evaluateRule(r, step.state, 3.85, T0 + 2);
  assert.equal(step.due, false);
  step = evaluateRule(r, step.state, 4.2, T0 + 3);
  assert.deepEqual([step.due, step.operator], [true, 'gte'], '向上穿越');
  const cooled = evaluateRule({ ...r, cooldownMinutes: 10 }, { ...step.state, lastSentAt: T0 + 2 }, 4.2, T0 + 4);
  assert.equal(cooled.due, false, '共用冷却');
});

test('校验：重复条件、价格须为正、未知字段、名称长度与档数上限', () => {
  assert.throws(() => validateAlertConfig('oil', { enabled: true, rules: [rule(), rule({ id: 'r2' })] }), /不能重复/);
  assert.throws(() => validateAlertConfig('oil', { enabled: true, rules: [rule({ metric: 'brent', threshold: 0 })] }), /大于 0/);
  assert.throws(() => validateAlertConfig('oil', { enabled: true, rules: [{ ...rule(), extra: 1 }] }), /未知字段/);
  assert.throws(() => validateAlertConfig('oil', { enabled: true, rules: [rule({ label: '价差\n4' })] }), /不含换行/);
  assert.throws(() => validateAlertConfig('oil', { enabled: true, rules: [rule({ id: '__proto__' })] }), /编号/);
  assert.throws(() => validateAlertConfig('hynix', { enabled: true, rules: [rule({ metric: 'premium', label: 'x'.repeat(41) })] }), /1–40/);
  assert.throws(() => validateAlertConfig('hynix', { enabled: true, rules: [rule({ metric: 'spread' })] }), /指标/);
  assert.throws(() => validateAlertConfig('hynix', { enabled: true, rules: [rule({ metric: 'premium', cooldownMinutes: 1441 })] }), /0–1440/);
  assert.throws(() => validateAlertConfig('hynix', { enabled: true, rules: Array.from({ length: 21 }, (_, i) => rule({ id: `r${i}`, metric: 'premium', threshold: i })) }), /20 档/);
  assert.equal(validateAlertConfig('oil', { enabled: true, rules: [rule({ label: '  价差 4  ', metric: 'spread', threshold: -2 })] }).rules[0]!.label, '价差 4');
  try { validateAlertConfig('oil', null); assert.fail(); } catch (error) { assert.ok(error instanceof ContractError && error.status === 400); }
});

interface Fixture {
  dir: string; store: MonitorStore; clock: { now: number }; quote: { value: unknown }; sent: string[]; robot: { on: boolean };
  notifyFails: { on: boolean }; writeFails: { on: boolean }; delivery: Map<number, AlertDelivery>; tests: string[]; testFails: { on: boolean }; logs: string[];
  service(market?: AlertMarket): ReturnType<typeof createAlertService>; close(): void;
}
function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'tp-alerts-'));
  const clock = { now: T0 };
  const real = createMonitorStore({ file: join(dir, 'monitor.sqlite'), now: () => clock.now });
  const writeFails = { on: false };
  const store = { ...real, writeState: (key: string, value: unknown) => { if (writeFails.on) throw new Error('disk full'); real.writeState(key, value); } } as MonitorStore;
  const f: Fixture = {
    dir, store, clock, quote: { value: null }, sent: [], robot: { on: true }, notifyFails: { on: false }, writeFails, delivery: new Map(), tests: [], testFails: { on: false }, logs: [],
    service: () => { throw new Error('unset'); }, close: () => { real.close(); rmSync(dir, { recursive: true, force: true }); },
  };
  const gate = createTestGate(() => clock.now);
  const hooks = {
    notify: (text: string) => { if (f.notifyFails.on) throw new Error('SQLITE_FULL'); if (!f.robot.on) return null; f.sent.push(text); return f.sent.length; },
    delivery: (ids: readonly number[]) => new Map([...f.delivery].filter(([id]) => ids.includes(id))),
    robot: () => f.robot.on ? 'feishu' as const : null,
    test: async (text: string) => { if (f.testFails.on) throw new Error('飞书返回 HTTP 200 code 19021'); f.tests.push(text); },
  };
  f.service = (market = 'oil') => createAlertService({ market, store, quote: () => f.quote.value, hooks, gate, now: () => clock.now, log: line => f.logs.push(line) });
  return f;
}
const enable = (service: ReturnType<typeof createAlertService>, rules?: AlertRule[]) => {
  const view = service.view();
  return service.update({ revision: view.revision, config: { enabled: true, rules: rules ?? view.config.rules } });
};

test('服务：默认关闭不发送；启用后越过多档合成一条入队，不重复；记录与送达状态', () => {
  const f = fixture();
  try {
    const service = f.service();
    assert.deepEqual(service.view().config.rules.map(r => r.threshold), [3, 4, 5]);
    f.quote.value = oilQuote(66.2, 62.0, f.clock.now);
    service.check();
    assert.equal(f.sent.length, 0, '总开关关闭：只跟踪越线');
    enable(service);
    f.clock.now += 10_000; f.quote.value = oilQuote(66.2, 62.0, f.clock.now);
    service.check();
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0]!, /^【原油阈值告警】价差 3 USDT：价差 4\.2000 ≥ 3 USDT\/桶；价差 4 USDT：价差 4\.2000 ≥ 4 USDT\/桶\n布伦特 66\.2000 · WTI 62\.0000 · 价差 4\.2000 USDT\/桶（Binance BZUSDT \/ CLUSDT 标记价，报价时刻 2026-11-14T08:00:10\.000Z）$/);
    f.clock.now += 10_000; f.quote.value = oilQuote(66.3, 62.0, f.clock.now);
    service.check();
    assert.equal(f.sent.length, 1, '持续越线不重复');
    let view = service.view();
    assert.equal(view.history.length, 1);
    assert.deepEqual([view.history[0]!.status, view.history[0]!.rules.map(r => r.threshold)], ['expired', [3, 4]]);
    f.delivery.set(1, { sentAt: null, attempts: 0, lastError: null, nextAt: f.clock.now });
    assert.equal(service.view().history[0]!.status, 'queued');
    f.delivery.set(1, { sentAt: null, attempts: 2, lastError: '飞书返回 HTTP 500', nextAt: f.clock.now });
    assert.deepEqual([service.view().history[0]!.status, service.view().history[0]!.error], ['retrying', '飞书返回 HTTP 500']);
    f.delivery.set(1, { sentAt: f.clock.now, attempts: 2, lastError: null, nextAt: f.clock.now });
    view = service.view();
    assert.equal(view.history[0]!.status, 'sent');
    assert.deepEqual(view.values, { brent: 66.3, wti: 62, spread: 4.3 });
    assert.equal(view.error, null);
    // Restarted on the same file: the crossing is remembered, nothing is sent again.
    const again = f.service();
    f.clock.now += 10_000; f.quote.value = oilQuote(66.3, 62.0, f.clock.now);
    again.check();
    assert.equal(f.sent.length, 1);
    assert.equal(again.view().history.length, 1);
  } finally { f.close(); }
});

test('服务：报价过期、快照或超前时不判断并给原因', () => {
  const f = fixture();
  try {
    const service = f.service();
    enable(service);
    f.quote.value = oilQuote(70, 62, f.clock.now - 91_000);
    service.check();
    assert.match(service.view().error ?? '', /过期/);
    f.quote.value = oilQuote(70, 62, f.clock.now, 'snapshot');
    service.check();
    f.quote.value = oilQuote(70, 62, f.clock.now + 6_000);
    service.check();
    assert.equal(f.sent.length, 0);
    f.quote.value = null;
    service.check();
    assert.match(service.view().error ?? '', /尚未取得/);
    // Hynix allows 30 s only.
    const hynix = f.service('hynix');
    enable(hynix, [rule({ metric: 'premium', label: '溢价 40', threshold: 40 })]);
    f.quote.value = hynixQuote(45, f.clock.now - 31_000);
    hynix.check();
    assert.equal(f.sent.length, 0);
    f.quote.value = hynixQuote(45, f.clock.now - 29_000);
    hynix.check();
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0]!, /^【海力士价差告警】溢价 40：ADR 溢价率 45\.00% ≥ 40%\nADR \$120\.00 · 正股 ÷ 10 \$100\.00 · 每份价差 \$20\.00（Hyperliquid xyz:SKHY \/ xyz:SKHX，获取时刻 /);
  } finally { f.close(); }
});

test('服务：没有机器人只跟踪越线，配置后仍在越线中即补发；入队失败不记已提醒，60 秒后重试', () => {
  const f = fixture();
  try {
    f.robot.on = false;
    const service = f.service();
    enable(service, [rule()]);
    assert.match(service.view().notice ?? '', /secrets\.json/);
    f.quote.value = oilQuote(66.5, 62, f.clock.now);
    service.check();
    assert.equal(f.sent.length, 0);
    f.robot.on = true;
    f.notifyFails.on = true;
    f.clock.now += 10_000; f.quote.value = oilQuote(66.5, 62, f.clock.now);
    service.check();
    assert.match(service.view().error ?? '', /飞书队列/);
    f.notifyFails.on = false;
    f.clock.now += 10_000; f.quote.value = oilQuote(66.5, 62, f.clock.now);
    service.check();
    assert.equal(f.sent.length, 0, '60 秒内不重试');
    f.clock.now += QUEUE_RETRY_MS; f.quote.value = oilQuote(66.5, 62, f.clock.now);
    service.check();
    assert.equal(f.sent.length, 1);
    assert.equal(service.view().error, null);
  } finally { f.close(); }
});

test('服务：写库失败时不重复提醒、暂停新提醒，写成功后恢复；保存失败返回 503 且不改配置', () => {
  const f = fixture();
  try {
    const service = f.service();
    enable(service, [rule(), rule({ id: 'r5', label: '价差 5', threshold: 5 })]);
    f.writeFails.on = true;
    f.quote.value = oilQuote(66.5, 62, f.clock.now);
    service.check();
    f.clock.now += 10_000; service.check();
    assert.equal(f.logs.filter(line => line.includes('写入 monitor.sqlite 失败')).length, 1, '持续失败只记一次日志');
    assert.equal(f.sent.length, 1, '入队在写库之前');
    assert.match(service.view().error ?? '', /monitor\.sqlite/);
    f.clock.now += 10_000; f.quote.value = oilQuote(67.5, 62, f.clock.now);
    service.check();
    assert.equal(f.sent.length, 1, '写库失败期间暂停新提醒（价差 5 也不发）');
    const revision = service.view().revision;
    assert.throws(() => service.update({ revision, config: { enabled: false, rules: [] } }), (error: unknown) => error instanceof ContractError && error.status === 503);
    assert.equal(service.view().revision, revision);
    assert.equal(service.view().config.rules.length, 2);
    assert.match(service.view().error ?? '', /monitor\.sqlite/, '保存失败不清掉巡检的写库失败');
    f.clock.now += 10_000; f.quote.value = oilQuote(67.5, 62, f.clock.now);
    service.check();
    assert.equal(f.sent.length, 1, '保存失败后仍暂停');
    f.writeFails.on = false;
    f.clock.now += 10_000; f.quote.value = oilQuote(67.5, 62, f.clock.now);
    service.check();
    assert.equal(f.sent.length, 2);
    assert.match(f.sent[1]!, /^【原油阈值告警】价差 5：/);
    assert.equal(f.logs.filter(line => line.includes('恢复提醒')).length, 1);
    assert.equal(service.view().error, null);
  } finally { f.close(); }
});

test('服务：版本不符 409；未变的档保留越线状态，改过的档从头算', () => {
  const f = fixture();
  try {
    const service = f.service();
    enable(service, [rule(), rule({ id: 'r3', label: '价差 3', threshold: 3 })]);
    f.quote.value = oilQuote(66.5, 62, f.clock.now);
    service.check();
    assert.equal(f.sent.length, 1);
    assert.throws(() => service.update({ revision: 0, config: { enabled: true, rules: [] } }), (error: unknown) => error instanceof ContractError && error.status === 409);
    const view = service.view();
    service.update({ revision: view.revision, config: { enabled: true, rules: [rule({ label: '改名不影响' }), rule({ id: 'r3', label: '价差 3', threshold: 3, hysteresis: 0.2 })] } });
    f.clock.now += 10_000; f.quote.value = oilQuote(66.5, 62, f.clock.now);
    service.check();
    assert.equal(f.sent.length, 2);
    assert.match(f.sent[1]!, /^【原油阈值告警】价差 3：价差 4\.5000 ≥ 3/, '只有改了回差的档重新提醒（冷却按档的状态从头算）');
    assert.throws(() => service.update({ revision: service.view().revision, config: { enabled: true, rules: [] }, extra: 1 }), /revision 与 config/);
  } finally { f.close(); }
});

test('测试消息：没有机器人 400；两个市场合计每分钟一次；失败 503 并记录', async () => {
  const f = fixture();
  try {
    const oil = f.service('oil'), hynix = f.service('hynix');
    f.robot.on = false;
    await assert.rejects(oil.test(), (error: unknown) => error instanceof ContractError && error.status === 400);
    f.robot.on = true;
    const view = await oil.test();
    assert.equal(f.tests.length, 1);
    assert.deepEqual([view.history[0]!.kind, view.history[0]!.status], ['test', 'sent']);
    await assert.rejects(hynix.test(), (error: unknown) => error instanceof ContractError && error.status === 429);
    f.clock.now += TEST_INTERVAL_MS;
    f.testFails.on = true;
    await assert.rejects(hynix.test(), (error: unknown) => error instanceof ContractError && error.status === 503 && /19021/.test(error.message));
    assert.deepEqual([hynix.view().history[0]!.status, hynix.view().history[0]!.error], ['failed', '飞书返回 HTTP 200 code 19021']);
  } finally { f.close(); }
});

test('读取已保存的值：格式不对时按默认启动并提示，后台不覆盖原值、保存才覆盖，版本号往后接；越线状态按档恢复', async () => {
  const f = fixture();
  try {
    f.store.writeState('alerts.oil', { version: 1, revision: 7, config: { enabled: true, rules: [{ bad: true }] }, states: {}, events: [] });
    const broken = f.service();
    assert.equal(broken.view().revision, 8);
    assert.match(broken.view().error ?? '', /无法读取/);
    assert.equal(broken.view().config.enabled, false);
    // The unreadable value stays in the file through checks (the defaults' states change) and a test message, until a save.
    f.quote.value = oilQuote(66.5, 62, f.clock.now);
    broken.check();
    await broken.test();
    assert.equal((f.store.readState('alerts.oil')!.value as { revision: number }).revision, 7);
    assert.match(broken.status().error ?? '', /无法读取/);
    f.writeFails.on = true;
    assert.throws(() => enable(broken, [rule()]), (error: unknown) => error instanceof ContractError && error.status === 503);
    assert.match(broken.view().error ?? '', /无法读取/, '保存失败后提示仍在');
    f.writeFails.on = false;
    const saved = enable(broken, [rule()]);
    assert.equal(saved.error, null);
    const file = f.store.readState('alerts.oil')!.value as { revision: number; config: { enabled: boolean } };
    assert.deepEqual([file.revision, file.config.enabled], [9, true], '保存才覆盖原值');
    f.store.writeState('alerts.oil', { version: 1, revision: 9, config: { enabled: true, rules: [rule()] }, states: { r1: { active: 'yes' }, gone: { active: true, alerted: true, lastSentAt: null } }, events: [{ nope: 1 }] });
    const restored = f.service();
    assert.equal(restored.view().history.length, 0);
    f.quote.value = oilQuote(66.5, 62, f.clock.now);
    restored.check();
    assert.equal(f.sent.length, 1, '坏状态从头算');
  } finally { f.close(); }
});

test('飞书队列：notify 返回消息编号，按编号读送达状态，没有机器人时为 null', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-alerts-outbox-'));
  let fail = true, at = T0;
  const base = { events: () => [], latestSeq: () => 0, pairs: () => [], incidentPair: () => null, now: () => at, log: () => undefined };
  const notifier = createNotifier({ ...base, file: join(dir, 'notify.sqlite'), feishu: { webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/abcdefgh', secret: null },
    fetchImpl: async () => fail ? new Response('{}', { status: 500 }) : new Response('{"code":0}', { status: 200 }) });
  const off = createNotifier({ ...base, file: join(dir, 'off.sqlite'), feishu: null });
  try {
    const id = notifier.notify('【原油阈值告警】测试');
    assert.equal(typeof id, 'number');
    assert.deepEqual(notifier.delivery([id!, 999]).get(id!), { sentAt: null, attempts: 0, lastError: null, nextAt: T0 });
    assert.equal(notifier.delivery([999]).size, 0);
    await notifier.flush();
    assert.deepEqual([notifier.delivery([id!]).get(id!)!.attempts, notifier.delivery([id!]).get(id!)!.lastError], [1, '飞书返回 HTTP 500']);
    fail = false; at += 10_000;
    await notifier.flush();
    assert.equal(notifier.delivery([id!]).get(id!)!.sentAt, at);
    assert.equal(off.notify('x'), null);
  } finally { notifier.close(); off.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('接口：读取、保存（409 / 400）、测试消息；须带页面请求标记；未配置的市场 404', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-alerts-http-'));
  const venues = fakeAnthropicVenues();
  const config = parseServiceConfig({ secretsFile: '/etc/tp/secrets.json', monitor: { oil: {} } });
  const tests: string[] = [];
  const runtime = openMonitor(config.monitor!, dir, { fetchImpl: venues.fetch, WebSocketImpl: venues.WebSocket, log: () => undefined,
    alertHooks: { notify: () => 1, delivery: () => new Map(), robot: () => 'feishu' as const, test: async text => { tests.push(text); } } });
  const h = createHarness();
  const server = createExecutorServer({ executor: h.ex, accessToken: 'monitor-token-0006', views: { monitor: monitorViews(runtime) } });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const cookie = ((await fetch(`${url}/login?token=monitor-token-0006`, { redirect: 'manual' })).headers.get('set-cookie') ?? '').split(';')[0]!;
    const call = async (path: string, body?: unknown, headers: Record<string, string> = { 'x-pa-executor': '1', 'content-type': 'application/json' }) => {
      const response = await fetch(url + path, body === undefined ? { headers: { cookie } } : { method: 'POST', headers: { cookie, ...headers }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    assert.equal((await fetch(`${url}/api/monitor/oil/alerts`)).status, 401);
    assert.equal((await call('/api/monitor/hynix/alerts')).status, 404);
    const view = await call('/api/monitor/oil/alerts');
    assert.equal(view.status, 200);
    assert.deepEqual([view.body.revision, view.body.robotConfigured, view.body.config.rules.length], [0, true, 3]);
    assert.deepEqual(Object.keys(view.body).sort(), ['checkedAt', 'config', 'error', 'history', 'lastValidAt', 'market', 'notice', 'revision', 'robot', 'robotConfigured', 'values'], '只返回有无机器人及其名称，不返回地址');
    assert.equal((await call('/api/monitor/oil/alerts', { revision: 0, config: { enabled: true, rules: [] } }, { 'content-type': 'application/json' })).status, 403);
    const saved = await call('/api/monitor/oil/alerts', { revision: 0, config: { enabled: true, rules: [rule()] } });
    assert.deepEqual([saved.status, saved.body.revision, saved.body.config.enabled], [200, 1, true]);
    const stale = await call('/api/monitor/oil/alerts', { revision: 0, config: { enabled: true, rules: [] } });
    assert.deepEqual([stale.status, stale.body.code], [409, 'stale_revision']);
    const bad = await call('/api/monitor/oil/alerts', { revision: 1, config: { enabled: true, rules: [rule({ metric: 'wti', threshold: -1 })] } });
    assert.deepEqual([bad.status, bad.body.code], [400, 'invalid_alerts']);
    const sent = await call('/api/monitor/oil/alerts/test', {});
    assert.deepEqual([sent.status, tests.length, sent.body.history[0].kind], [200, 1, 'test']);
    assert.equal((await call('/api/monitor/oil/alerts/test', {})).status, 429);
    assert.equal((await call('/api/monitor/oil/alerts/test', { x: 1 })).status, 400);
    assert.equal((await call('/api/monitor/oil/alerts/test')).status, 404, 'GET 测试接口不存在');
    // The page's boundary check takes what the service answers.
    const page = alertView((await call('/api/monitor/oil/alerts')).body);
    assert.deepEqual([page.revision, page.history[0]!.status, historyText('oil', page.history[0]!)], [1, 'sent', '测试消息']);
    assert.deepEqual(Object.keys(monitorStatus(runtime).alerts ?? {}), ['oil', 'hynix']);
  } finally {
    await new Promise(resolve => server.close(resolve));
    h.dispose();
    stopMonitor(runtime);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('页面：批量生成沿用同方向同阈值档位的编号，按服务的字段名生成；解析拒绝未知状态', () => {
  const adapter = { ...ALERT_MARKETS.oil, newRule: (config: Parameters<typeof newRule>[1]) => newRule('oil', config) };
  const draft = { enabled: true, rules: [rule({ id: 'keep', threshold: 4 }), rule({ id: 'wti', metric: 'wti', threshold: 60 })] };
  const grid = gridDefaults(draft, adapter);
  assert.deepEqual([grid.metric, grid.from, grid.to, grid.direction], ['spread', 4, 4, 'gte']);
  const next = applyAlertGrid(draft, { ...grid, from: 3, to: 5, step: 1 }, adapter);
  assert.deepEqual(next.rules.map(r => [r.metric, r.operator, r.threshold, r.label]), [['wti', 'gte', 60, '价差 4'], ['spread', 'gte', 3, '向上 3 USDT/桶'], ['spread', 'gte', 4, '向上 4 USDT/桶'], ['spread', 'gte', 5, '向上 5 USDT/桶']]);
  assert.equal(next.rules[2]!.id, 'keep');
  const view = { market: 'oil', revision: 1, config: { enabled: true, rules: [rule()] }, robotConfigured: true, checkedAt: null, lastValidAt: null, values: null, error: null, notice: null,
    history: [{ id: 'a', time: '2026-11-14T08:00:00.000Z', kind: 'alert', status: 'retrying', rules: [{ label: '价差 4', metric: 'spread', operator: 'gte', threshold: 4, value: 4.2 }], error: 'HTTP 500' }] };
  assert.equal(historyText('oil', alertView(view).history[0]!), '价差 4：4.2000 ≥ 4 USDT/桶');
  assert.throws(() => alertView({ ...view, history: [{ ...view.history[0], status: 'lost' }] }), /无法识别/);
  assert.throws(() => alertView({ ...view, config: { enabled: true, rules: [{ ...rule(), operator: 'above' }] } }), /无法识别/);
  assert.throws(() => alertView({ ...view, history: [{ ...view.history[0], rules: [{ ...view.history[0]!.rules[0], operator: 'both' }] }] }), /无法识别/);
  assert.throws(() => alertViewFor('hynix')(view), /无法识别/);
});

test('消息：多档同时触发时第一行不超过队列保留的长度，放不下的档记为“另有 N 档”，报价行完整', () => {
  const f = fixture();
  try {
    const service = f.service();
    enable(service, Array.from({ length: 50 }, (_, i) => rule({ id: `g${i}`, label: `向上 ${(i / 10).toFixed(1)} USDT/桶 梯度档位`, threshold: i / 10 })));
    f.quote.value = oilQuote(70, 62, f.clock.now);
    service.check();
    assert.equal(f.sent.length, 1);
    const [first, quote] = f.sent[0]!.split('\n');
    assert.ok(f.sent[0]!.length <= ALERT_TEXT_MAX, `长度 ${f.sent[0]!.length}`);
    assert.match(first!, /；另有 \d+ 档$/);
    assert.match(quote!, /^布伦特 70\.0000 · WTI 62\.0000 · 价差 8\.0000 USDT\/桶（Binance BZUSDT \/ CLUSDT 标记价，报价时刻 .+）$/);
    assert.equal(service.view().history[0]!.rules.length, 50, '记录保留全部档位');
  } finally { f.close(); }
});

test('入队失败后越线结束：提示清除，不误记“已恢复”', () => {
  const f = fixture();
  try {
    const service = f.service();
    enable(service, [rule()]);
    f.notifyFails.on = true;
    f.quote.value = oilQuote(66.5, 62, f.clock.now);
    service.check();
    f.clock.now += 10_000; f.quote.value = oilQuote(66.5, 62, f.clock.now);
    service.check();
    assert.equal(f.logs.filter(line => line.includes('已恢复')).length, 0, '退避中不算恢复');
    f.clock.now += 10_000; f.quote.value = oilQuote(65.8, 62, f.clock.now);
    service.check();
    assert.equal(service.view().error, null);
    assert.equal(f.logs.filter(line => line.includes('已恢复')).length, 0, '队列并未证实恢复，不记“已恢复”');
  } finally { f.close(); }
});

test('消息：价格位数很大时报价行仍完整', () => {
  const f = fixture();
  try {
    const service = f.service();
    enable(service, Array.from({ length: 50 }, (_, i) => rule({ id: `g${i}`, metric: 'brent', label: `布伦特梯度档位 ${'档'.repeat(40)} ${i}`, threshold: i + 1 })));
    f.quote.value = oilQuote(9.99e20, 62, f.clock.now);
    service.check();
    assert.ok(f.sent[0]!.length <= ALERT_TEXT_MAX, `长度 ${f.sent[0]!.length}`);
    assert.match(f.sent[0]!.split('\n')[1]!, /报价时刻 2026-11-14T08:00:00\.000Z）$/);
  } finally { f.close(); }
});
