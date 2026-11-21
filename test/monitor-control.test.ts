// Monitor M-3c: each market's run switch. The switch saved in monitor.sqlite (defaults, revisions, a failed write, an
// unreadable value), the loops it gates (no round while off, resuming once on, alert checks skipped), the endpoints
// (POST …/control, 423 for a market switched off) and the page's parsing of what the service answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { ContractError } from '../src/contracts.ts';
import { controlKey, createMonitorControl } from '../src/monitor/control.ts';
import { createMonitorStore, MONITOR_FILE } from '../src/monitor/store.ts';
import type { LoopContext } from '../src/monitor/anthropic.ts';
import { parseServiceConfig } from '../src/service/config.ts';
import { pendingImportKey } from '../src/monitor/alerts.ts';
import { monitorLoops, monitorStatus, monitorViews, openMonitor, stopMonitor, type MonitorRuntime } from '../src/service/monitor.ts';
import { createExecutorServer } from '../src/http.ts';
import { disabledNotice, parseControl, parseControls, switchFailure, switchLabel, toggleBody } from '../web/src/monitor-control.ts';
import { fakeAnthropicVenues } from './monitor-fake.ts';
import { createHarness } from './harness.ts';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 250; i++) { if (check()) return; await sleep(4); }
  assert.fail(`等待超时：${what}`);
}
const code = (status: number, name: string) => (error: unknown) => error instanceof ContractError && error.status === status && error.code === name;

function storeIn() {
  const dir = mkdtempSync(join(tmpdir(), 'tp-control-'));
  const file = join(dir, MONITOR_FILE);
  return { dir, file, store: createMonitorStore({ file }), dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

test('开关：默认开启，切换按版本号保存并在重开后保留；同向重试原样返回；版本过期 409、请求无效 400、写入失败 503 且不生效', () => {
  const { file, store, dispose } = storeIn();
  const logs: string[] = [];
  try {
    const control = createMonitorControl({ store, markets: ['oil', 'hynix'], log: line => logs.push(line) });
    assert.deepEqual(control.views(), { oil: { market: 'oil', enabled: true, revision: 0, error: null }, hynix: { market: 'hynix', enabled: true, revision: 0, error: null } });
    assert.equal(control.enabled('anthropic'), false, '未配置的市场不运行');
    assert.throws(() => control.view('anthropic'), code(404, 'not_found'));
    assert.throws(() => control.update('anthropic', { enabled: false, revision: 0 }), code(404, 'not_found'));
    for (const bad of [null, [], {}, { enabled: 'false', revision: 0 }, { enabled: false }, { enabled: false, revision: -1 }, { enabled: false, revision: 1.5 }, { enabled: false, revision: 0, extra: 1 }]) {
      assert.throws(() => control.update('oil', bad), code(400, 'invalid_control'), JSON.stringify(bad));
    }
    assert.deepEqual(control.update('oil', { enabled: false, revision: 0 }), { market: 'oil', enabled: false, revision: 1, error: null });
    assert.deepEqual([control.enabled('oil'), control.enabled('hynix')], [false, true]);
    assert.deepEqual(store.readState(controlKey('oil'))!.value, { version: 1, enabled: false, revision: 1 });
    assert.deepEqual(logs, ['原油监控已关闭（页面操作）']);
    // A retry whose answer was lost (or another page did the same) answers the state without a new revision.
    assert.deepEqual(control.update('oil', { enabled: false, revision: 0 }), { market: 'oil', enabled: false, revision: 1, error: null });
    assert.throws(() => control.update('oil', { enabled: true, revision: 0 }), code(409, 'control_conflict'));
    assert.equal(control.enabled('oil'), false);
    // A failed write leaves the switch as it was.
    const failing = { ...store, writeState: () => { throw new Error('disk I/O error'); } };
    const broken = createMonitorControl({ store: failing, markets: ['oil'] });
    assert.throws(() => broken.update('oil', { enabled: true, revision: 1 }), (error: unknown) => code(503, 'control_unsaved')(error) && /disk I\/O error/.test((error as Error).message));
    assert.deepEqual(broken.view('oil'), { market: 'oil', enabled: false, revision: 1, error: null });
    store.close();
    const reopenedStore = createMonitorStore({ file });
    try {
      const reopened = createMonitorControl({ store: reopenedStore, markets: ['oil', 'hynix'] });
      assert.deepEqual([reopened.view('oil'), reopened.enabled('hynix')], [{ market: 'oil', enabled: false, revision: 1, error: null }, true]);
      assert.deepEqual(reopened.update('oil', { enabled: true, revision: 1 }), { market: 'oil', enabled: true, revision: 2, error: null });
    } finally { reopenedStore.close(); }
  } finally { try { store.close(); } catch { /* closed above */ } dispose(); }
});

test('开关：保存值无法读取时按开启运行并给出提示，页面以当前版本号切换即可覆盖', () => {
  const { store, dispose } = storeIn();
  const logs: string[] = [];
  try {
    for (const value of [{ version: 2, enabled: false, revision: 1 }, { version: 1, enabled: 'no', revision: 1 }, 'off']) {
      store.writeState(controlKey('hynix'), value);
      const control = createMonitorControl({ store, markets: ['hynix'], log: line => logs.push(line) });
      const view = control.view('hynix');
      assert.deepEqual([view.enabled, view.revision, control.enabled('hynix')], [true, 0, true], JSON.stringify(value));
      assert.match(view.error!, /海力士监控开关无法读取（开关记录格式无效），按开启运行/);
    }
    assert.equal(logs.length, 3);
    const control = createMonitorControl({ store, markets: ['hynix'] });
    // Turning it "on" again is still saved while the value is unreadable, which clears the notice.
    assert.deepEqual(control.update('hynix', { enabled: true, revision: 0 }), { market: 'hynix', enabled: true, revision: 1, error: null });
    assert.deepEqual(store.readState(controlKey('hynix'))!.value, { version: 1, enabled: true, revision: 1 });
  } finally { store.close(); dispose(); }
});

/** A loop context whose pauses are a few milliseconds whatever they ask for, and the pauses it was asked for. */
function fastContext() {
  let stop = false;
  const pauses: number[] = [];
  const context: LoopContext = { stopped: () => stop, pause: async ms => { pauses.push(ms); await sleep(2); } };
  return { context, pauses, stop: () => { stop = true; } };
}

test('循环：关闭时启动不跑首轮；运行中关闭后本轮结束即停、告警检查跳过；重新开启后恢复，停止服务时正常退出', async () => {
  const { store, dispose } = storeIn();
  try {
    const control = createMonitorControl({ store, markets: ['oil', 'hynix'] });
    control.update('oil', { enabled: false, revision: 0 });
    const rounds = { oil: 0, hynix: 0 }, checks = { oil: 0, hynix: 0 }, pendings = { oil: 0, hynix: 0 };
    const logs: string[] = [];
    const collector = (market: 'oil' | 'hynix') => ({ loops: (context: LoopContext) => [(async () => { while (!context.stopped()) { rounds[market]++; await context.pause(60_000); } })()] });
    const runtime = { control, anthropic: null, oil: collector('oil'), hynix: collector('hynix'), alerts: { oil: { check: () => { checks.oil++; }, applyPending: () => { pendings.oil++; } }, hynix: { check: () => { checks.hynix++; }, applyPending: () => { pendings.hynix++; } } } } as unknown as MonitorRuntime;
    const { context, stop } = fastContext();
    const loops = monitorLoops(runtime, context, line => logs.push(line));
    await until(() => rounds.hynix >= 3 && checks.hynix >= 3 && pendings.oil >= 3, '海力士运行');
    assert.deepEqual([rounds.oil, checks.oil, pendings.hynix], [0, 0, 0], '原油关闭：不跑首轮、不判断告警，只换上待应用的导入档位');
    control.update('oil', { enabled: true, revision: 1 });
    await until(() => rounds.oil >= 2 && checks.oil >= 2, '原油开启后恢复');
    control.update('hynix', { enabled: false, revision: 0 });
    await sleep(20);
    const frozen = { rounds: rounds.hynix, checks: checks.hynix };
    await sleep(30);
    assert.deepEqual({ rounds: rounds.hynix, checks: checks.hynix }, frozen, '海力士关闭后不再采集与检查');
    assert.ok(rounds.oil > 2, '原油照常');
    stop();
    await Promise.all(loops);
    assert.deepEqual(logs, []);
  } finally { store.close(); dispose(); }
});

test('循环：采集器循环抛错时记日志，不影响其他市场', async () => {
  const { store, dispose } = storeIn();
  try {
    const control = createMonitorControl({ store, markets: ['oil', 'hynix'] });
    let hynix = 0;
    const runtime = { control, anthropic: null, alerts: {},
      oil: { loops: () => [Promise.reject(new Error('boom'))] },
      hynix: { loops: (context: LoopContext) => [(async () => { while (!context.stopped()) { hynix++; await context.pause(1); } })()] } } as unknown as MonitorRuntime;
    const logs: string[] = [];
    const { context, stop } = fastContext();
    const loops = monitorLoops(runtime, context, line => logs.push(line));
    await until(() => hynix >= 3, '海力士运行');
    stop();
    await Promise.all(loops);
    assert.deepEqual(logs, ['行情监控循环异常退出：boom']);
  } finally { store.close(); dispose(); }
});

test('接口：POST 开关须带页面请求标记，返回保存后的开关；关闭后该市场行情与告警接口 423、状态接口照常，重开后保留', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-control-http-'));
  const venues = fakeAnthropicVenues();
  const config = parseServiceConfig({ secretsFile: '/etc/tp/secrets.json', monitor: { oil: {}, hynix: {} } }).monitor!;
  const hooks = { notify: () => 1, delivery: () => new Map(), robot: () => 'feishu' as const, test: async () => undefined };
  let runtime = openMonitor(config, dir, { fetchImpl: venues.fetch, WebSocketImpl: venues.WebSocket, log: () => undefined, alertHooks: hooks });
  const h = createHarness();
  const views = { monitor: monitorViews(runtime) };
  const server = createExecutorServer({ executor: h.ex, accessToken: 'monitor-token-0009', views });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const cookie = ((await fetch(`${url}/login?token=monitor-token-0009`, { redirect: 'manual' })).headers.get('set-cookie') ?? '').split(';')[0]!;
    const call = async (path: string, body?: unknown, headers: Record<string, string> = { 'x-pa-executor': '1', 'content-type': 'application/json' }) => {
      const response = await fetch(url + path, body === undefined ? { headers: { cookie } } : { method: 'POST', headers: { cookie, ...headers }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    assert.equal((await fetch(`${url}/api/monitor/oil/control`, { method: 'POST', headers: { 'x-pa-executor': '1', 'content-type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal((await call('/api/monitor/oil/control', { enabled: false, revision: 0 }, { 'content-type': 'application/json' })).status, 403);
    assert.deepEqual([(await call('/api/monitor/anthropic/control', { enabled: false, revision: 0 })).status], [404]);
    assert.deepEqual([(await call('/api/monitor/oil/control', { enabled: 0, revision: 0 })).body.code], ['invalid_control']);
    const off = await call('/api/monitor/oil/control', { enabled: false, revision: 0 });
    assert.deepEqual(off, { status: 200, body: { market: 'oil', enabled: false, revision: 1, error: null } });
    assert.deepEqual([(await call('/api/monitor/oil/control', { enabled: true, revision: 0 })).status, (await call('/api/monitor/oil/control', { enabled: true, revision: 0 })).body.code], [409, 'control_conflict']);
    for (const path of ['/api/monitor/oil/quote', '/api/monitor/oil/candles?days=7', '/api/monitor/oil/alerts']) {
      const answer = await call(path);
      assert.deepEqual([answer.status, answer.body.code, answer.body.message], [423, 'monitor_disabled', '原油监控已关闭，行情采集与自动告警已暂停；开启后恢复'], path);
    }
    assert.deepEqual([(await call('/api/monitor/oil/alerts', { revision: 0, config: { enabled: true, rules: [] } })).status, (await call('/api/monitor/oil/alerts/test', {})).status], [423, 423]);
    assert.notEqual((await call('/api/monitor/hynix/alerts')).status, 423, '其他市场不受影响');
    const state = await call('/api/monitor/state');
    assert.deepEqual([state.status, state.body.controls.oil.enabled, state.body.controls.hynix.enabled], [200, false, true]);
    assert.deepEqual(parseControls(state.body.controls, state.body.markets), { oil: { enabled: false, revision: 1, error: null }, goldoil: { enabled: true, revision: 0, error: null }, hynix: { enabled: true, revision: 0, error: null } }, '原油隐含金油比，开关各自独立');
    assert.deepEqual(monitorStatus(runtime).controls?.oil, { market: 'oil', enabled: false, revision: 1, error: null });
    runtime.store.close();
    runtime = openMonitor(config, dir, { fetchImpl: venues.fetch, WebSocketImpl: venues.WebSocket, log: () => undefined, alertHooks: hooks });
    views.monitor = monitorViews(runtime);
    assert.equal(runtime.control.enabled('oil'), false, '重开后保留关闭');
    assert.deepEqual((await call('/api/monitor/oil/control', { enabled: true, revision: 1 })).body, { market: 'oil', enabled: true, revision: 2, error: null });
    assert.notEqual((await call('/api/monitor/oil/alerts')).status, 423);
  } finally {
    await new Promise(resolve => server.close(resolve));
    h.dispose();
    try { runtime.store.close(); } catch { /* closed */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('页面：解析开关、旧服务没有开关、按钮文字、切换请求体、关闭提示与失败文字', () => {
  assert.equal(parseControls(undefined, ['oil']), null, '旧服务不返回 controls：不显示开关');
  assert.deepEqual(parseControls({ oil: { market: 'oil', enabled: false, revision: 3, error: null }, aero: { x: 1 } }, ['oil', 'hynix']), { oil: { enabled: false, revision: 3, error: null } }, '只取本页认识且配置了的市场');
  for (const bad of [null, [], 'x']) assert.throws(() => parseControls(bad, ['oil']), /开关格式不正确/);
  for (const bad of [{ enabled: 1, revision: 0 }, { enabled: true, revision: -1 }, { enabled: true, revision: 0, error: 5 }]) assert.throws(() => parseControl(bad), /开关格式不正确/);
  assert.deepEqual(parseControl({ enabled: true, revision: 2, error: '无法读取' }), { enabled: true, revision: 2, error: '无法读取' });
  const on = { enabled: true, revision: 4, error: null };
  assert.deepEqual(toggleBody(on), { enabled: false, revision: 4 });
  assert.deepEqual([switchLabel(on, true, true), switchLabel(on, false, true), switchLabel(undefined, false, false), switchLabel(on, false, false), switchLabel({ ...on, enabled: false }, false, false)], ['保存中…', '重试切换', '读取中…', '已开启', '已关闭']);
  assert.equal(disabledNotice('oil'), '原油监控已关闭，行情采集、自动告警已暂停。配置和历史数据已保留，可通过上方开关重新开启。');
  assert.equal(disabledNotice('anthropic'), 'Anthropic监控已关闭，行情采集已暂停。配置和历史数据已保留，可通过上方开关重新开启。');
  assert.match(switchFailure(null, undefined, null), /结果未知/);
  assert.match(switchFailure(409, 'control_conflict', '开关已被其他页面修改'), /已重新读取最新状态/);
  assert.equal(switchFailure(503, 'control_unsaved', '监控开关未保存'), '监控开关未保存');
});

test('循环：真实原油采集器关闭期间不发任何上游请求，开启后恢复；关闭时从工作台导入的告警档位照常换上', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-control-real-'));
  const venues = fakeAnthropicVenues();
  let requests = 0;
  const fetchImpl = ((...args: Parameters<typeof venues.fetch>) => { requests++; return venues.fetch(...args); }) as typeof venues.fetch;
  const config = parseServiceConfig({ secretsFile: '/etc/tp/secrets.json', monitor: { oil: {} } }).monitor!;
  const hooks = { notify: () => 1, delivery: () => new Map(), robot: () => 'feishu' as const, test: async () => undefined };
  const runtime = openMonitor(config, dir, { fetchImpl, WebSocketImpl: venues.WebSocket, log: () => undefined, alertHooks: hooks });
  try {
    // `oil` brings the gold/oil ratio along (M-2g): it reads Binance too, so it is switched off for the count.
    assert.ok(runtime.goldoil, '原油隐含金油比');
    runtime.control.update('oil', { enabled: false, revision: 0 });
    runtime.control.update('goldoil', { enabled: false, revision: 0 });
    const before = runtime.alerts.oil!.view().revision;
    runtime.store.writeState(pendingImportKey('oil'), { version: 1, importedAt: new Date().toISOString(), source: 'workbench', config: { enabled: false, rules: [] } });
    const { context, stop } = fastContext();
    const loops = monitorLoops(runtime, context, () => undefined);
    await until(() => runtime.store.readState(pendingImportKey('oil')) === null, '关闭时导入照常换上');
    assert.equal(runtime.alerts.oil!.view().revision, before + 1);
    await sleep(40);
    assert.equal(requests, 0, '关闭期间没有上游请求');
    runtime.control.update('oil', { enabled: true, revision: 1 });
    await until(() => requests > 0, '开启后恢复采集');
    stop();
    stopMonitor(runtime);
    await Promise.all(loops);
  } finally { stopMonitor(runtime); runtime.store.close(); rmSync(dir, { recursive: true, force: true }); }
});
