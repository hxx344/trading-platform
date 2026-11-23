// What makes trouble visible: the crash marker a dying process leaves, the health watch over the market and control
// processes, the user streams and the perpetual venues, and the Feishu texts for the executor's attention events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { CRASH_FILE, clearCrashRecord, crashReportKey, installCrashGuard, readCrashRecord } from '../src/crash-guard.ts';
import { FEED_DOWN_AFTER_MS, HEALTH_REPEAT_MS, PROCESS_DOWN_AFTER_MS, STREAM_DOWN_AFTER_MS, createHealthWatch, type StreamRow } from '../src/service/health-watch.ts';
import { describeEvent } from '../src/service/feishu.ts';
import type { PerpetualStatusView } from '../src/monitor/perpetual.ts';
import { LOOP_WINDOW_MS, createHostStatus } from '../src/host-status.ts';
import { connectionQuality, formatBytes, formatUptime, hostLevel, hostWorst, servicesTone, type HostView, type ServiceConnection } from '../web/src/host-status.ts';

test('崩溃兜底：未捕获的异常写一行日志和标记文件后退出；下次启动读出标记、入队后才删除，坏标记读时即删除', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-crash-'));
  const lines: string[] = [], exits: number[] = [], source = new EventEmitter();
  const remove = installCrashGuard('交易服务', { dir, log: line => lines.push(line), exit: code => exits.push(code), now: () => 1234, source });
  try {
    source.emit('uncaughtException', new TypeError('boom'));
    source.emit('unhandledRejection', new Error('later'));
    assert.deepEqual(exits, [1, 1], '第二次只退出');
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^【交易服务异常退出】未捕获的异常：TypeError: boom\n/);
    const record = readCrashRecord(dir);
    assert.deepEqual([record?.at, record?.process, record?.kind, record?.message], [1234, '交易服务', 'uncaughtException', 'TypeError: boom']);
    assert.match(record!.stack, /observability\.test\.ts/);
    assert.equal(existsSync(join(dir, CRASH_FILE)), true, '读出不删除');
    assert.deepEqual(readCrashRecord(dir), record, '未确认前再次启动仍能读出同一条');
    assert.equal(crashReportKey(readCrashRecord(dir)!), crashReportKey(record!), '同一标记的入队键稳定');
    clearCrashRecord(dir);
    assert.equal(existsSync(join(dir, CRASH_FILE)), false);
    assert.equal(readCrashRecord(dir), null);
    clearCrashRecord(dir);
    writeFileSync(join(dir, CRASH_FILE), '{"at":"x"}');
    assert.equal(readCrashRecord(dir), null);
    assert.equal(existsSync(join(dir, CRASH_FILE)), false);
  } finally { remove(); rmSync(dir, { recursive: true, force: true }); }
});

test('崩溃兜底：Promise 拒绝的不是 Error 时也记下原值', () => {
  const lines: string[] = [], source = new EventEmitter();
  const remove = installCrashGuard('行情服务', { log: line => lines.push(line), exit: () => undefined, source });
  source.emit('unhandledRejection', 'plain reason');
  remove();
  assert.equal(source.listenerCount('unhandledRejection'), 0);
  assert.deepEqual(lines, ['【行情服务异常退出】未处理的 Promise 拒绝：plain reason']);
});

function watchHarness() {
  const clock = { now: 0 };
  const sent: string[] = [];
  const state = { market: true, instance: 'm1', control: true, streams: [] as StreamRow[], perpetual: null as PerpetualStatusView | null };
  const watch = createHealthWatch({
    marketSocketPath: '/run/market.sock', controlPort: 4700, now: () => clock.now, notify: text => sent.push(text),
    streams: () => state.streams, perpetual: () => state.perpetual,
    probeMarket: async () => { if (!state.market) throw new Error('connect ECONNREFUSED'); return { instance: state.instance }; },
    probeControl: async () => { if (!state.control) throw new Error('fetch failed'); },
  });
  const step = async (ms: number) => { clock.now += ms; await watch.tick(); };
  return { clock, sent, state, watch, step };
}

test('依赖巡检：行情进程断开满 30 秒才告警，持续时每 30 分钟重复，恢复时报恢复；换实例报重启', async () => {
  const { sent, state, watch, step } = watchHarness();
  await step(0);
  assert.equal(watch.view().market?.ok, true);
  state.market = false;
  await step(10_000);
  await step(PROCESS_DOWN_AFTER_MS - 10_000);
  assert.deepEqual(sent, [], '刚断开不告警');
  await step(10_000);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /^【行情服务不可用】公开行情进程.*ECONNREFUSED/);
  assert.equal(watch.view().incidents[0]?.alerted, true);
  await step(HEALTH_REPEAT_MS);
  assert.match(sent[1]!, /^【行情服务不可用仍未恢复】/);
  state.market = true; state.instance = 'm2';
  await step(10_000);
  assert.match(sent[2]!, /^【行情服务已重启】/);
  assert.match(sent[3]!, /^【行情服务不可用恢复】/);
  assert.equal(watch.view().market?.restarts, 1);
  assert.deepEqual(watch.view().incidents, []);
  // A blip shorter than the threshold is never posted, nor its end.
  state.control = false;
  await step(10_000);
  state.control = true;
  await step(10_000);
  assert.equal(sent.length, 4);
});

test('依赖巡检：ASTER 用户推送断开满 1 分钟告警；永续行情某所断流满 2 分钟告警一次，停用的不算，采集器关掉时不报恢复', async () => {
  const { sent, state, step } = watchHarness();
  state.streams = [{ account: 'main', connected: false, since: null, lastError: 'socket hang up' }];
  const venue = (id: string, status: string) => ({ id, status, lastMessageAt: 1, error: null });
  state.perpetual = { running: true, venues: [venue('binance', 'stale'), venue('okx', 'disabled')] } as unknown as PerpetualStatusView;
  await step(0);
  await step(STREAM_DOWN_AFTER_MS);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /^【ASTER 用户推送断开】账户 main：socket hang up/);
  await step(FEED_DOWN_AFTER_MS);
  assert.equal(sent.filter(text => text.startsWith('【永续行情断流】')).length, 1);
  assert.match(sent.find(text => text.startsWith('【永续行情断流】'))!, /binance：数据过期，最后一条消息在/);
  const before = sent.length;
  await step(HEALTH_REPEAT_MS);
  assert.equal(sent.filter(text => text.startsWith('【永续行情断流')).length, 1, '断流不重复');
  assert.ok(sent.slice(before).some(text => text.startsWith('【ASTER 用户推送断开仍未恢复】')));
  state.perpetual = null;
  state.streams = [{ account: 'main', connected: true, since: 1, lastError: null }];
  await step(10_000);
  assert.ok(sent.some(text => text.startsWith('【ASTER 用户推送断开恢复】')));
  assert.ok(!sent.some(text => text.startsWith('【永续行情断流恢复】')));
});

test('飞书：委托待核对、追价策略身份不一致、四腿偏离与暂停各发一次', () => {
  const row = (type: string, detail: object, jobId = 'job-0000-1111') => describeEvent({ seq: 1, at: 0, type, json: JSON.stringify(detail), jobId }, () => null);
  const mismatch = row('operation-mismatch', { op: 'op-1' });
  assert.match(mismatch?.text ?? '', /^【委托待人工核对】/);
  assert.equal(mismatch?.onceKey, 'operation-mismatch:op-1');
  assert.match(row('strategy-identity-mismatch', { op: 'op-2', strategyId: 's-1', verified: true })?.text ?? '', /^【追价策略身份不一致】.*s-1/);
  assert.match(row('four-leg-deviation', { reason: '首腿成交价偏离' })?.text ?? '', /^【四腿首腿偏离计划】.*首腿成交价偏离/);
  const halted = row('four-leg-halted', { by: 'job-peer', reason: '另一所失败' });
  assert.match(halted?.text ?? '', /^【四腿另一任务已暂停】/);
  assert.ok(halted?.onceKey);
});

test('服务器状态：CPU 首读间隔采样、1 秒内复用；数据目录与系统盘同盘时合并；进程内存与事件循环延迟按窗口重置', async () => {
  const clock = { now: 0 };
  let busy = 0, idle = 0;
  const cpus = () => [{ model: 'x', speed: 1, times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } }];
  let resets = 0;
  const loop = { count: 5, mean: 2_000_000, max: 9_000_000, percentile: () => 5_000_000, reset: () => { resets += 1; } };
  const host = createHostStatus({
    dataDir: '/data', now: () => clock.now, cpus, totalmem: () => 1000, freemem: () => 250, loadavg: () => [0.5, 0.25, 0.125], uptime: () => 3600.7,
    meminfo: async () => 'SwapTotal:  100 kB\nSwapFree:  25 kB\n',
    statDisk: async () => ({ blocks: 100, bfree: 40, bavail: 30, bsize: 10 }), statPath: async () => ({ dev: 7 }),
    wait: async () => { busy += 30; idle += 70; }, memoryUsage: () => ({ rss: 123, heapUsed: 45 }), loop,
  });
  const first = await host.read();
  assert.equal(first.cpu.usagePercent, 30);
  assert.deepEqual(first.cpu.loadAverage, [0.5, 0.25, 0.13]);
  assert.deepEqual([first.memory.usedPercent, first.memory.swap?.usedPercent, first.uptimeSeconds], [75, 75, 3600]);
  assert.deepEqual(first.disks.map(disk => [disk.id, disk.label, disk.usedPercent]), [['data', '数据目录（系统盘）', 66.7]]);
  assert.deepEqual([first.process.rssBytes, first.process.heapUsedBytes, first.process.loopDelayMs], [123, 45, { mean: 2, p99: 5, max: 9 }]);
  busy += 90; idle += 10; clock.now += 500;
  assert.equal((await host.read()).cpu.usagePercent, 30, '1 秒内复用');
  clock.now += 1_000;
  assert.equal((await host.read()).cpu.usagePercent, 90);
  assert.equal(resets, 0);
  clock.now += LOOP_WINDOW_MS;
  await host.read();
  assert.equal(resets, 1);
  const separate = createHostStatus({ dataDir: '/data', cpus, wait: async () => undefined, loop: null,
    statDisk: async path => { if (path === '/data') throw new Error('EACCES'); return { blocks: 10, bfree: 5, bavail: 5, bsize: 1 }; }, statPath: async () => ({ dev: 1 }) });
  const view = await separate.read();
  assert.deepEqual(view.disks.map(disk => [disk.id, disk.error ?? null]), [['data', '无法读取'], ['root', null]]);
  assert.equal(view.process.loopDelayMs, null);
});

test('服务连线汇总：行情、控制面、用户推送、永续行情与心跳各一行，没配置的不列', async () => {
  const { state, watch, step, clock } = watchHarness();
  assert.deepEqual(watch.connections(null).map(item => [item.id, item.state]), [['market', 'unknown'], ['control', 'unknown']]);
  state.control = false;
  state.streams = [{ account: 'main', connected: true, since: 1, lastError: null }, { account: 'hedge', connected: false, since: null, lastError: 'x' }];
  const venue = (id: string, status: string) => ({ id, status, lastMessageAt: 1, error: null });
  state.perpetual = { running: true, venues: [venue('binance', 'live'), venue('okx', 'stale'), venue('gate', 'disabled')] } as unknown as PerpetualStatusView;
  await step(0);
  const heartbeat = { url: 'https://watch.example', lastOkAt: clock.now - 10_000, lastReady: true, failures: 0, lastError: null, lastErrorAt: null };
  const lines = watch.connections(heartbeat);
  assert.deepEqual(lines.map(item => [item.id, item.state]), [['market', 'ok'], ['control', 'down'], ['streams', 'down'], ['perpetual', 'warn'], ['heartbeat', 'ok']]);
  assert.match(lines[2]!.detail, /1\/2 已连接；断开：hedge/);
  assert.match(lines[3]!.detail, /1\/2 个交易所正常；okx 数据过期/);
  assert.equal(watch.connections({ ...heartbeat, failures: 2, lastError: '超时' })[4]?.state, 'warn');
  assert.equal(watch.connections({ ...heartbeat, lastOkAt: clock.now - 10 * 60_000, failures: 3, lastError: '超时' })[4]?.state, 'down');
});

test('顶栏：负载取 CPU、内存与最满的可读磁盘中最高的；往返耗时分级；服务连线有断开为红、有异常为黄', () => {
  const view = { cpu: { usagePercent: 20, cores: 2, loadAverage: [] }, memory: { usedPercent: 80 }, disks: [{ id: 'data', label: '', usedPercent: 91 }, { id: 'root', label: '', error: '无法读取' }] } as unknown as HostView;
  assert.deepEqual(hostWorst(view), { cpu: 20, memory: 80, disk: 91, worst: 91 });
  assert.deepEqual([hostLevel(74.9), hostLevel(75), hostLevel(90), hostLevel(null)], ['', 'warn', 'alert', '']);
  assert.deepEqual([formatBytes(512), formatBytes(1536), formatBytes(200 * 1024 ** 3), formatUptime(90_061)], ['512 B', '1.5 KB', '200 GB', '1 天 1 小时']);
  assert.deepEqual([connectionQuality('ready', 150), connectionQuality('ready', 151), connectionQuality('ready', 501), connectionQuality('error', 10), connectionQuality('offline', 10), connectionQuality('loading', null)],
    ['good', 'fair', 'slow', 'unreachable', 'offline', 'checking']);
  const link = (state: ServiceConnection['state']) => ({ id: state, label: '', state, detail: '' });
  assert.deepEqual([servicesTone([link('ok'), link('unknown')]), servicesTone([link('warn')]), servicesTone([link('warn'), link('down')])], ['', 'warn', 'alert']);
});

test('崩溃兜底：标记的报告第一次入队失败时保留标记；下次启动入队成功后删除，同一标记重复读出也只入队一次', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-crash-'));
  const source = new EventEmitter();
  const remove = installCrashGuard('交易服务', { dir, log: () => undefined, exit: () => undefined, now: () => 99, source });
  // The service's start sequence (service/main.ts): read, queue keyed, then clear.
  const queued = new Set<string>(), sent: string[] = [];
  let failing = true;
  const notifyOnce = (key: string, text: string) => { if (failing) throw new Error('database is locked'); if (queued.has(key)) return false; queued.add(key); sent.push(text); return true; };
  const start = () => { const crash = readCrashRecord(dir); if (crash) { notifyOnce(crashReportKey(crash), crash.message); clearCrashRecord(dir); } };
  try {
    source.emit('uncaughtException', new Error('boom'));
    assert.throws(start, /database is locked/);
    assert.equal(existsSync(join(dir, CRASH_FILE)), true, '入队失败时标记保留');
    failing = false;
    start();
    assert.deepEqual(sent, ['boom']);
    assert.equal(existsSync(join(dir, CRASH_FILE)), false);
    start();
    // A marker that could not be removed after its report was queued: read again, dropped by its key.
    remove();
    const again = installCrashGuard('交易服务', { dir, log: () => undefined, exit: () => undefined, now: () => 99, source });
    source.emit('uncaughtException', new Error('boom'));
    again();
    start();
    assert.deepEqual(sent, ['boom'], '同一标记不重复报告');
  } finally { remove(); rmSync(dir, { recursive: true, force: true }); }
});

test('依赖巡检：告警入队失败时不记作已发，下一轮补发首报且只一次；恢复只跟在已入队的首报之后，入队失败也会重试', async () => {
  const clock = { now: 0 };
  const sent: string[] = [], logs: string[] = [];
  let failing = false;
  const state = { market: true, instance: 'm1', streams: [] as StreamRow[], perpetual: null as PerpetualStatusView | null };
  const watch = createHealthWatch({
    marketSocketPath: '/run/market.sock', now: () => clock.now, log: line => logs.push(line),
    notify: text => { if (failing) throw new Error('database is locked'); sent.push(text); },
    streams: () => state.streams, perpetual: () => state.perpetual,
    probeMarket: async () => { if (!state.market) throw new Error('connect ECONNREFUSED'); return { instance: state.instance }; },
  });
  const step = async (ms: number) => { clock.now += ms; await watch.tick(); };
  const venue = (status: string) => ({ running: true, venues: [{ id: 'binance', status, lastMessageAt: null, error: null }] } as unknown as PerpetualStatusView);

  // Perpetual feed stalls (no repeat): the first post fails, the next tick posts it, once.
  state.perpetual = venue('stale');
  await step(0);
  failing = true;
  await step(FEED_DOWN_AFTER_MS);
  assert.equal(sent.length, 0);
  assert.equal(watch.view().incidents[0]?.alerted, false, '入队失败不算已告警');
  assert.match(logs.at(-1)!, /未能入队/);
  failing = false;
  await step(1_000);
  assert.equal(sent.filter(text => text.startsWith('【永续行情断流】')).length, 1);
  await step(HEALTH_REPEAT_MS);
  assert.equal(sent.filter(text => text.startsWith('【永续行情断流】')).length, 1, '无重复设置时不再发');
  // Recovery fails to queue: kept open and retried, posted once.
  failing = true;
  state.perpetual = venue('live');
  await step(1_000);
  assert.equal(watch.view().incidents.length, 1, '恢复未入队前保留');
  failing = false;
  await step(1_000);
  assert.equal(sent.filter(text => text.startsWith('【永续行情断流恢复】')).length, 1);
  assert.equal(watch.view().incidents.length, 0);
  await step(1_000);
  assert.equal(sent.filter(text => text.startsWith('【永续行情断流恢复】')).length, 1);

  // A user stream down: a failed first post is retried on the next tick, not after HEALTH_REPEAT_MS.
  sent.length = 0;
  state.streams = [{ account: 'a1', connected: false, since: null, lastError: null }];
  await step(0);
  failing = true;
  await step(STREAM_DOWN_AFTER_MS);
  failing = false;
  await step(1_000);
  assert.equal(sent.filter(text => text.startsWith('【ASTER 用户推送断开】')).length, 1);
  // A recovery with no queued alert posts nothing.
  state.streams = [{ account: 'a2', connected: false, since: null, lastError: null }];
  await step(1_000);
  state.streams = [{ account: 'a2', connected: true, since: 1, lastError: null }];
  await step(1_000);
  assert.ok(!sent.some(text => text.includes('账户 a2')), '未告警过的恢复不发');
  // An alert that came due but never got queued, for a problem that ended before the queue came back: posted once with
  // its recovery; repeated failures log once.
  state.streams = [{ account: 'a3', connected: false, since: null, lastError: null }];
  await step(0);
  failing = true;
  const logged = logs.length;
  await step(STREAM_DOWN_AFTER_MS);
  await step(1_000);
  assert.equal(logs.slice(logged).filter(line => /未能入队/.test(line)).length, 1, '连续失败只记一行');
  state.streams = [{ account: 'a3', connected: true, since: 1, lastError: null }];
  await step(1_000);
  assert.equal(watch.view().incidents.some(item => item.key === 'stream:a3'), true, '补报未入队前保留');
  failing = false;
  await step(1_000);
  assert.equal(sent.filter(text => text.startsWith('【ASTER 用户推送断开（已恢复）】账户 a3')).length, 1);
  await step(1_000);
  assert.equal(sent.filter(text => text.includes('账户 a3')).length, 1);

  // A market restart whose notice cannot be queued: the market still reads as up, the notice goes out next tick.
  sent.length = 0;
  failing = true;
  state.instance = 'm2';
  await step(1_000);
  assert.equal(watch.view().market?.ok, true, '通知失败不当作行情不可达');
  failing = false;
  await step(1_000);
  assert.equal(sent.filter(text => text.startsWith('【行情服务已重启】')).length, 1);
  await step(1_000);
  assert.equal(sent.filter(text => text.startsWith('【行情服务已重启】')).length, 1);
});
