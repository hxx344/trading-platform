import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createChainArbBackground } from '../src/chain-arb/background.ts';
import { DEFAULT_BACKGROUND_SETTINGS, parseBackgroundSettings, type BackgroundView } from '../src/chain-arb/background-model.ts';
import type { ChainArbVenue } from '../src/chain-arb/model.ts';
import type { ScanInput, ScanRow, ScanView } from '../src/chain-arb/scan-model.ts';
import { createExecutorServer } from '../src/http.ts';
import { createMarketClient } from '../src/market/ipc.ts';
import { createMonitorData } from '../src/market/monitor-data.ts';
import { createMarketServer } from '../src/market/server.ts';
import { createMonitorStore } from '../src/monitor/store.ts';
import { createNotifier } from '../src/service/feishu.ts';
import { closeMonitor, monitorLoops, monitorViews, openMonitor, stopMonitor } from '../src/service/monitor.ts';
import { ARB_ADDRESS, chainArbFixture, testGateLedger } from './chain-arb-fake.ts';
import { createHarness } from './harness.ts';

function quote(at: number, venue: ChainArbVenue, netBps: number): ScanView {
  const row: ScanRow = { venue, symbol: 'ARB', address: ARB_ADDRESS, chain: 'arbitrum', kind: 'spot', netUsdt: 20.45, netBps,
    at, expiresAt: at + 15_000, dexPrice: 0.1, gatePrice: 0.12, gasUsdt: 0.5,
    execution: { receivedQuantity: 1000, transferQuantity: 1000, impactBps: 0, blockNumber: '0x123' } };
  return { asOf: at, phase: 'scanning', total: 1, cycle: 1, checked: 1, failed: 0, message: null, rows: [row], history: [] };
}

test('无人打开页面时轮转场所并按各自费率询价，阈值严格大于，过期只进历史，单所失败后恢复', async t => {
  const store = createMonitorStore({ file: ':memory:' }); t.after(() => store.close());
  let at = 100_000, old = false, failed = true;
  const calls: [ChainArbVenue, string][] = [], notifications: string[] = [];
  const service = createChainArbBackground({ store, gateResultCurrent: () => true, now: () => at, control: () => ({ enabled: true, revision: 0 }),
    hooks: { robot: () => 'feishuMonitor', notifyRepeating: (_key, message) => { notifications.push(message); } },
    scan: async raw => {
      const { venue = 'gate', spotFeeBps } = raw as ScanInput;
      calls.push([venue, spotFeeBps]);
      if (venue === 'binance' && failed) throw new Error('行情暂不可用');
      const snapshot = quote(at - (old ? 15_000 : 0), venue, venue === 'bitget' ? 101 : 100);
      // The spot quote succeeded even though the other leg put the venue on a 429 cooldown.
      if (venue === 'bitget') snapshot.phase = 'cooldown';
      return snapshot;
    } });
  await service.tick();
  assert.equal(calls.length, 0);
  const settings = { ...DEFAULT_BACKGROUND_SETTINGS, enabled: true, fees: { bitget: { spotFeeBps: '7.00', perpFeeBps: '5' } } };
  const saved = service.update({ revision: 0, settings });
  assert.equal(saved.settings.fees?.bitget?.spotFeeBps, '7');
  assert.equal(service.update({ revision: 0, settings }).revision, 1);
  assert.throws(() => service.update({ revision: 0, settings: { ...settings, amount: '400' } }), /其他页面/);
  assert.throws(() => parseBackgroundSettings({ ...settings, fees: { binance: { spotFeeBps: '5' } } }), /两条/);
  assert.throws(() => parseBackgroundSettings({ ...settings, venues: ['gate', 'gate'] }), /重复/);
  for (let i = 0; i < 3; i++) await service.tick();
  assert.deepEqual(calls, [['gate', '10'], ['binance', '10'], ['bitget', '7']]);
  assert.equal(service.view().results.binance?.phase, 'error');
  assert.equal(service.view().results.bitget?.rows.length, 1);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0]!, /ARB.*Arbitrum One/s);
  assert.match(notifications[0]!, /Bitget 现货充值卖出/);
  assert.match(notifications[0]!, /20.45 USDT/);
  assert.ok(notifications[0]!.includes(ARB_ADDRESS));
  at += 15_000;
  assert.equal(service.view().results.bitget?.rows.length, 0);
  assert.equal(service.view().results.bitget?.history.length, 1);
  old = true; failed = false;
  for (let i = 0; i < 3; i++) await service.tick();
  assert.equal(notifications.length, 1);
  assert.equal(service.view().results.binance?.phase, 'scanning');
});

test('一个场所的批次被阻塞时，其他场所继续轮扫，慢场所最多占用一个在途批次', { timeout: 2_000 }, async t => {
  const store = createMonitorStore({ file: ':memory:' }); t.after(() => store.close());
  const calls: ChainArbVenue[] = [], notifications: string[] = [];
  let ticks = 0, gateCancelled = false;
  const service = createChainArbBackground({ store, gateResultCurrent: () => true, now: () => 100_000, control: () => ({ enabled: true, revision: 0 }),
    hooks: { robot: () => 'feishuMonitor', notifyRepeating: (_key, text) => { notifications.push(text); } },
    scan: async (raw, _scope, signal, awaitBatch) => {
      assert.equal(awaitBatch, true);
      const { venue = 'gate' } = raw as ScanInput;
      calls.push(venue);
      if (venue === 'gate') await new Promise<void>(resolve => signal.addEventListener('abort', () => { gateCancelled = true; resolve(); }, { once: true }));
      return quote(100_000, venue, 150);
    } });
  t.after(() => service.stop());
  service.update({ revision: 0, settings: { ...DEFAULT_BACKGROUND_SETTINGS, enabled: true, venues: ['gate', 'bitget'] } });
  await service.loop({ stopped: () => ticks >= 4, pause: async () => { ticks++; await sleep(1); } });
  assert.deepEqual(calls, ['gate', 'bitget', 'bitget']);
  assert.ok(gateCancelled);
  assert.ok(notifications.length > 0 && notifications.every(text => text.includes('Bitget')));
});

test('更改设置、关闭行情或服务停止时，在途旧数据不会恢复榜单或发送；发件箱恢复后仅重试有效报价', async t => {
  const store = createMonitorStore({ file: ':memory:' }); t.after(() => store.close());
  const market = { enabled: true, revision: 0 }, now = () => 100_000;
  const hooks = { robot: () => 'feishu' as const, notifyRepeating: () => { if (broken) throw new Error('磁盘暂不可写'); sent++; } };
  let sent = 0, broken = true, blocked = false;
  let finish!: () => void;
  const settings = { ...DEFAULT_BACKGROUND_SETTINGS, enabled: true, venues: ['gate'] };
  const service = createChainArbBackground({ store, gateResultCurrent: () => true, hooks, now, control: () => market, scan: async () => {
    if (blocked) await new Promise<void>(resolve => { finish = resolve; });
    return quote(now(), 'gate', 120);
  } });
  service.update({ revision: 0, settings });
  await service.tick();
  assert.match(service.view().error ?? '', /入队失败/);
  await service.tick(); assert.equal(sent, 0);
  broken = false;
  await service.tick(); assert.equal(sent, 1);
  blocked = true;
  const first = service.tick();
  service.update({ revision: 1, settings: { ...settings, thresholdBps: 110 } });
  finish(); await first;
  assert.deepEqual(service.view().results, {});
  const second = service.tick();
  market.enabled = false; market.revision++;
  finish(); await second;
  assert.equal(sent, 1);
  market.enabled = true; market.revision++;
  const third = service.tick();
  service.stop(); finish(); await third;
  assert.equal(sent, 1);
  assert.deepEqual(service.view().results, {});
});

test('登录 HTTP 保存后，无页面读取时服务循环仍经行情 IPC 推送过线机会；重启复用设置和发件箱抑制', async () => {
  const h = createHarness(), socket = process.platform === 'win32' ? '\\\\.\\pipe\\tp-bg-' + randomUUID() : join(h.dir, 'market.sock');
  let at = Date.now(), stopped = false;
  const now = () => at, outboxOptions = { file: join(h.dir, 'notify-monitor.sqlite'), events: () => [], latestSeq: () => 0,
    pairs: () => [], incidentPair: () => null, now, log: () => {}, feishu: { webhook: 'https://example.invalid/robot', secret: null },
    fetchImpl: async () => { throw new Error('本测试禁止联网'); } };
  let notifier = createNotifier(outboxOptions);
  const market = createMarketServer({ monitor: createMonitorData({ now, fetchImpl: chainArbFixture(now) }) }, 'test');
  const client = createMarketClient(socket);
  const open = () => openMonitor({ perpetual: {} }, h.dir, { now, marketClient: client, gateLedger: testGateLedger(now), log: () => {},
    alertHooks: { robot: () => 'feishuMonitor', notify: () => null, test: async () => {}, delivery: () => new Map(),
      notifyRepeating: (key, text) => notifier.notifyRepeating(key, text) } });
  let runtime = open();
  const server = createExecutorServer({ executor: h.ex, accessToken: 'background-scan-fixture', views: { monitor: monitorViews(runtime) } });
  const loops: Promise<void>[] = [];
  try {
    await new Promise<void>((resolve, reject) => { market.server.once('error', reject); market.server.listen(socket, resolve); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port, path = base + '/api/monitor/perpetual/chain-arb-background';
    const login = await fetch(base + '/login?token=background-scan-fixture', { redirect: 'manual' });
    const headers = { cookie: login.headers.get('set-cookie')!.split(';')[0]!, 'content-type': 'application/json', 'x-pa-executor': '1' };
    const body = { revision: 0, settings: { ...DEFAULT_BACKGROUND_SETTINGS, venues: ['gate'], enabled: true, thresholdBps: 300 } };
    const post = (value: unknown) => fetch(path, { method: 'POST', headers, body: JSON.stringify(value) });
    assert.equal((await fetch(path)).status, 401);
    assert.equal((await fetch(path, { method: 'POST', headers: { cookie: headers.cookie }, body: JSON.stringify(body) })).status, 403);
    assert.equal((await post({ ...body, settings: { ...body.settings, thresholdBps: -1 } })).status, 400);
    assert.equal((await post(body)).status, 200);
    assert.equal((await post({ ...body, settings: { ...body.settings, thresholdBps: 10 } })).status, 409);
    assert.equal((await fetch(base + '/api/monitor/perpetual/chain-arb-scan', { headers })).status, 409);
    // Leave the unrelated contract collector out. Only the executor's background loop drives the market from here.
    loops.push(...monitorLoops({ ...runtime, perpetual: null }, { stopped: () => stopped, pause: async ms => { at += ms; await sleep(15); } }));
    const deadline = Date.now() + 5_000;
    while (!notifier.pending() && Date.now() < deadline) await sleep(15);
    assert.equal(notifier.pending(), 1);
    assert.match(notifier.status().recent[0]!.text, /Gate 永续开空（基差收敛情景/);
    const view = await (await fetch(path, { headers })).json() as BackgroundView;
    assert.equal(view.results.gate?.rows.length, 2);
    stopped = true; stopMonitor(runtime); await Promise.all(loops); closeMonitor(runtime);
    notifier.close(); notifier = createNotifier(outboxOptions); runtime = open();
    assert.deepEqual(runtime.chainArbBackground!.view().settings, body.settings);
    for (let i = 0; i < 3; i++) { at += 2_000; await runtime.chainArbBackground!.tick(); await sleep(15); }
    assert.ok(runtime.chainArbBackground!.view().results.gate?.rows.length);
    assert.equal(notifier.pending(), 1);
    at += 30 * 60_000;
    for (let i = 0; i < 2; i++) { at += 2_000; await runtime.chainArbBackground!.tick(); await sleep(15); }
    assert.equal(notifier.pending(), 2);
  } finally {
    stopped = true; stopMonitor(runtime); await Promise.all(loops);
    closeMonitor(runtime); client.close(); market.close(); notifier.close();
    await new Promise<void>(resolve => server.close(() => resolve())); h.dispose();
  }
});
