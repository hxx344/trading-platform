import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { createMarketClient } from '../../src/market/ipc.ts';
import { createMonitorData } from '../../src/market/monitor-data.ts';
import { createMarketServer } from '../../src/market/server.ts';
import { openMonitor, closeMonitor, settleMonitor, stopMonitor } from '../../src/service/monitor.ts';
import { marketAlertHooks } from '../../src/service/main.ts';
import { sendFeishu } from '../../src/service/feishu.ts';
import { openPerpetualAlertStore, parsePerpetualAlertState, PERPETUAL_ALERT_FILE, PERPETUAL_ALERT_IMPORT } from '../../src/vendor/perpetual-alert-store.mjs';
import { initialPerpetualAlertState } from '../../src/vendor/perpetual-alert-engine.mjs';
import { createPerpetualAlertService } from '../../src/vendor/perpetual-alert-service.mjs';
import { createCrossExFilterService } from '../../src/vendor/perpetual-crossex-service.mjs';
import { initialCrossExSettings, openCrossExSettingsStore, validateCrossExState, PERPETUAL_CROSSEX_FILE, PERPETUAL_CROSSEX_IMPORT_FILE } from '../../src/monitor/perpetual-crossex-store.ts';
import { fakePerpetualVenues } from '../perpetual-fake.ts';

const rule = { id: 'btc', name: 'ETH 报价', base: 'ETH', enabled: true, longKey: 'binance:ETHUSDT', shortKey: 'bybit:ETHUSDT',
  thresholdPercent: -10, durationSeconds: 1, windowSeconds: 5, minHitRatio: 0.2, cooldownSeconds: 30,
  maxAgeSeconds: 10, budget: { slippagePercent: 0, takerOverrides: { binance: 0.05, bybit: 0.05 } } };
async function until(fn, detail = () => "") {
  const deadline = Date.now() + 8000;
  while (!fn()) { assert.ok(Date.now() < deadline, '等待机会提醒超时 ' + detail()); await pause(15); }
}

test('机会提醒认领未完成的工作台导入，既有投递保留为未知，服务写入后重复导入不覆盖', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-perpetual-alert-import-'));
  const pending = join(dir, PERPETUAL_ALERT_IMPORT), claimed = pending.replace(/\.json$/, '.loading.json');
  const now = Date.now();
  const state = { ...initialPerpetualAlertState(), revision: 7, config: { enabled: false, rules: [rule] },
    ruleStates: { btc: { armed: false, lastSentAt: null, lastAttemptAt: now } },
    history: [{ id: 'original', ruleId: 'btc', name: rule.name, base: 'ETH', longKey: rule.longKey, shortKey: rule.shortKey,
      netSpreadPercent: 1, time: now, status: 'sending', error: '', outboxId: 123 }] };
  writeFileSync(claimed, JSON.stringify(state));
  const runtime = openMonitor({ perpetual: {} }, dir, { perpetualOptions: { ...fakePerpetualVenues(), broadcastIntervalMs: 50 } });
  const collector = runtime.perpetual;
  t.after(async () => { stopMonitor(runtime); await settleMonitor(runtime); closeMonitor(runtime); rmSync(dir, { recursive: true, force: true }); });
  collector.start();
  await until(() => collector.alerts().revision === 1);
  assert.equal(collector.alerts().history[0].deliveryStage, 'unknown');
  assert.equal('outboxId' in collector.alerts().history[0], false);
  assert.equal(collector.alerts().progress.btc.lastAttemptAt, now);
  await assert.rejects(collector.alertsUpdate({ revision: 0, enabled: false, rules: [] }), { status: 409 });
  await collector.alertsUpdate({ revision: 1, enabled: false, rules: [] });
  writeFileSync(pending, JSON.stringify(state));
  await until(() => !existsSync(pending) && !existsSync(claimed));
  assert.equal(collector.alerts().revision, 2);
  assert.equal(collector.alerts().config.rules.length, 0);
  assert.equal(JSON.parse(readFileSync(join(dir, 'perpetual', 'opportunity-alerts.json'))).revision, 2);
});

test('无效交接文件保留待核对，正常配置和后续导入可继续使用', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-perpetual-alert-invalid-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pending = join(dir, PERPETUAL_ALERT_IMPORT), store = openPerpetualAlertStore(join(dir, 'perpetual'), pending);
  writeFileSync(pending, 'bad json');
  await assert.rejects(store.adoptPending(), /无效/);
  assert.equal(readFileSync(pending.replace(/\.json$/, '.rejected.json'), 'utf8'), 'bad json');
  assert.equal(store.get().revision, 0);
  writeFileSync(pending, JSON.stringify(initialPerpetualAlertState()));
  assert.equal((await store.adoptPending()).revision, 1);
});

test('执行服务通过行情 IPC 观察合约，关闭页面仍向选定机器人发送一次并核实其回执', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-perpetual-alert-ipc-'));
  const socket = process.platform === 'win32' ? '\\\\.\\pipe\\tp-opportunity-' + randomUUID() : join(dir, 'market.sock');
  const worker = createMarketServer({ monitor: createMonitorData({ perpetual: { ...fakePerpetualVenues(), observationIntervalMs: 30 }, log() {} }) }, 'test-opportunities');
  const client = createMarketClient(socket);
  let runtime;
  try {
    await new Promise((resolve, reject) => { worker.server.once('error', reject); worker.server.listen(socket, resolve); });
    const sent = [];
    const shared = { webhook: 'https://example.invalid/shared', secret: null }, robot = { webhook: 'https://example.invalid/monitor', secret: null };
    const hooks = marketAlertHooks({ secrets: { feishu: shared, feishuMonitor: robot }, notifier: {}, monitorOutbox: null, monitorOutboxError: null,
      send: async (secret, text, opportunityReceipt) => {
        assert.equal(opportunityReceipt, true);
        await sendFeishu(secret, { msg_type: 'text', content: { text } }, { opportunityReceipt, fetchImpl: async url => { sent.push(url); return Response.json({ code: 0 }); } });
      } });
    runtime = openMonitor({ perpetual: {} }, dir, { marketClient: client, alertHooks: hooks, perpetualOptions: { broadcastIntervalMs: 100 }, log() {} });
    const collector = runtime.perpetual;
    collector.start();
    await collector.alertsUpdate({ revision: 0, enabled: true, rules: [rule] });
    await until(() => collector.alerts().history.some(item => item.deliveryStage === 'confirmed'), () => JSON.stringify({ progress: collector.alerts().progress, history: collector.alerts().history, quote: collector.snapshot().quotes.find(q => q.base === 'ETH'), epoch: client.epoch() }));
    assert.deepEqual(sent, [robot.webhook]);
    assert.equal(collector.status().clients, 0);
    const id = collector.alerts().history[0].id;
    await collector.alertsReview({ id, note: '已核对', source: '替身回执' });
    assert.equal(collector.alerts().history[0].reviews[0].note, '已核对');
    collector.stop(); await collector.settled(); collector.start();
    await until(() => collector.alerts().progress.btc.state === 'triggered');
    assert.deepEqual(sent, [robot.webhook]);
  } finally {
    if (runtime) { stopMonitor(runtime); await settleMonitor(runtime); closeMonitor(runtime); }
    client.close(); await worker.close(); rmSync(dir, { recursive: true, force: true });
  }
});
import { createPerpetualMonitor } from '../../src/monitor/perpetual.ts';
import { perpetualPriceIdentity } from '../../src/vendor/perpetual-stream.mjs';

test('同一所其他连接仍在线时，失效合约盘口不能累计提醒，已准备发送也要重验双腿连接', async () => {
  let now = Date.now(), receive, sent = 0, attempted = 0, progress;
  const legs = ['binance', 'bybit'].map(exchange => ({ exchange, base: 'ETH', symbol: 'ETHUSDT', quoteCurrency: 'USDT', multiplier: 1 }));
  const remote = {
    epoch: () => 'market-epoch', subscribe(callback) { receive = callback; callback({ type: 'reset' }); return () => {}; },
    execution: () => ({ stop() {} }),
    metrics: Object.assign(async () => [], { retryAt: () => 0, isCached: () => false, stop() {} }),
    funding: async () => [], price: async () => [], positioning: async () => [],
    fundamentals: { refresh: async () => {}, asset: () => null, stop() {} },
  };
  function publish(bybitConnected) {
    const quotes = legs.map(market => ({ ...market, receivedAt: now, bidAt: now, askAt: now, bidAskAt: now,
      bid: 100, ask: 101, historyIdentity: perpetualPriceIdentity(market) }));
    receive({ type: 'quotes', quotes, removed: [], bookTimes: [[now, now], bybitConnected ? [now, now] : null] });
  }
  const state = initialPerpetualAlertState();
  const monitor = createPerpetualMonitor({ remote, now: () => now, broadcastIntervalMs: 15, alerts: {
    store: { get: () => state, save: async () => {} }, notifications: { configured: () => true, send: async (_message, beforeSend) => {
      attempted++; publish(false); beforeSend(); sent++;
    } },
  } });
  try {
    monitor.start();
    for (const market of legs) receive({ type: 'catalog', exchange: market.exchange, first: true, last: true, markets: [market] });
    receive({ type: 'venues', venues: legs.map(({ exchange }) => ({ id: exchange, name: exchange, kind: 'cex', online: true, marketCount: 1 })), connections: 3 });
    await monitor.alertsUpdate({ revision: 0, enabled: true, rules: [rule] });
    async function tick(connected) {
      now += 1000; publish(connected); await until(() => monitor.alerts().progress.btc?.checkedAt === now);
      progress = monitor.alerts().progress.btc;
    }
    for (let i = 0; i < 3; i++) await tick(false);
    assert.equal(progress.continuousSeconds, 0);
    assert.equal(progress.netSpreadPercent, null);
    assert.equal(monitor.snapshot().quotes.length, 2, '页上仍有两条最近报价');
    assert.equal(attempted, 0);
    await tick(true); await tick(true);
    await until(() => monitor.alerts().history[0]?.status === 'failed');
    assert.equal(attempted, 1); assert.equal(sent, 0);
    assert.match(monitor.alerts().history[0].error, /条件或报价已变化/);
  } finally { monitor.stop(); await monitor.settled(); }
});

test('提醒和 CrossEx 导入采用本机修订号，来源极值在编辑和重启后仍可用', async t => {
  for (const revision of [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER]) {
    const dir = mkdtempSync(join(tmpdir(), 'tp-opportunity-revision-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const pending = join(dir, PERPETUAL_ALERT_IMPORT);
    writeFileSync(pending, JSON.stringify({ ...initialPerpetualAlertState(), revision }));
    writeFileSync(join(dir, PERPETUAL_CROSSEX_IMPORT_FILE), JSON.stringify({ ...initialCrossExSettings(), revision }));
    const openAlerts = () => openPerpetualAlertStore(join(dir, 'perpetual'), pending);
    const openFilter = () => openCrossExSettingsStore(dir, () => {});
    const store = openAlerts();
    assert.equal((await store.adoptPending()).revision, 1);
    const alerts = createPerpetualAlertService({ store });
    const filter = createCrossExFilterService({ store: openFilter() });
    assert.equal(filter.view().revision, 1);
    const first = await alerts.update({ revision: 1, enabled: false, rules: [rule] });
    const second = await filter.update({ revision: 1, config: { requireSpotTransfer: false, blockedBases: ['ETH'] } });
    assert.equal(first.revision, 2); assert.equal(second.revision, 2);
    const restartedAlerts = createPerpetualAlertService({ store: openAlerts() });
    const restartedFilter = createCrossExFilterService({ store: openFilter() });
    assert.equal(restartedAlerts.view().config.rules[0].id, rule.id);
    assert.deepEqual(restartedFilter.view().config.blockedBases, ['ETH']);
    assert.equal((await restartedAlerts.update({ revision: 2, enabled: false, rules: [] })).revision, 3);
    assert.equal((await restartedFilter.update({ revision: 2, config: { requireSpotTransfer: false, blockedBases: [] } })).revision, 3);

    // Even a manually restored local file exactly at the boundary remains readable after a refused overflow.
    writeFileSync(join(dir, 'perpetual', PERPETUAL_ALERT_FILE), JSON.stringify({ ...initialPerpetualAlertState(), revision: Number.MAX_SAFE_INTEGER }));
    writeFileSync(join(dir, PERPETUAL_CROSSEX_FILE), JSON.stringify({ ...initialCrossExSettings(), revision: Number.MAX_SAFE_INTEGER }));
    const saturatedAlerts = createPerpetualAlertService({ store: openAlerts() });
    const saturatedFilter = createCrossExFilterService({ store: openFilter() });
    await assert.rejects(saturatedAlerts.update({ revision: Number.MAX_SAFE_INTEGER, enabled: false, rules: [rule] }), { status: 409 });
    await assert.rejects(saturatedFilter.update({ revision: Number.MAX_SAFE_INTEGER, config: { requireSpotTransfer: false, blockedBases: ['ETH'] } }), { status: 409 });
    assert.deepEqual(openAlerts().get().config.rules, []);
    assert.deepEqual(openFilter().get().config.blockedBases, []);
  }
  assert.throws(() => parsePerpetualAlertState({ ...initialPerpetualAlertState(), revision: Number.MAX_SAFE_INTEGER + 1 }));
  assert.throws(() => validateCrossExState({ ...initialCrossExSettings(), revision: Number.MAX_SAFE_INTEGER + 1 }));
});
