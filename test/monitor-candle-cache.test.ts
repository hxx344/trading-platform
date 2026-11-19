import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createExecutorServer } from '../src/http.ts';
import type { MonitorCandleUpdate } from '../src/monitor/candle-window.ts';
import { anthropicCandleWindow, createAnthropicCandles } from '../src/vendor/anthropic-market.mjs';
import { createIntradaySnapshot, intradayWindow } from '../src/vendor/oil-market.mjs';
import { ApiError } from '../web/src/api.ts';
import { candleReadDenied, createMonitorCandleReader, monitorCandleSelection, type SavedMonitorCandles } from '../web/src/monitor-candle-cache.ts';
import { anthropicHistory } from '../web/src/monitor-history.ts';
import { hynixHistory } from '../web/src/monitor-hynix.ts';
import { oilHistory } from '../web/src/monitor-oil.ts';
import { createHarness } from './harness.ts';

const DAY = 86_400_000, HOUR = 3_600_000, START = Date.UTC(2026, 7, 3);
const sample = (day: number) => ({ time: START + day * DAY, adr: 70 + day, ordinary: 710 + day });
const signal = new AbortController().signal;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function browser(disk: Map<string, SavedMonitorCandles>) {
  const memory = new Map<string, SavedMonitorCandles>();
  return {
    peek: (key: string) => memory.get(key),
    async load(key: string) {
      const value = structuredClone(disk.get(key));
      if (value) memory.set(key, value);
      return value;
    },
    put(key: string, value: SavedMonitorCandles) { memory.set(key, value); disk.set(key, structuredClone(value)); },
    remove(key: string) { memory.delete(key); disk.delete(key); },
  };
}

test('监控 K 线真实 HTTP：缩放与重新打开、旧行修订和恢复权限', async t => {
  let rows = Array.from({ length: 74 }, (_, i) => sample(i)).filter(row => row.time !== sample(34).time);
  const stamp = new Date(sample(75).time).toISOString();
  const oil = createIntradaySnapshot(rows.map(row => ({ time: row.time, brent: row.adr, wti: row.time >= sample(70).time ? null : row.ordinary })), stamp);
  let anthropic = createAnthropicCandles(rows.map(row => ({ time: row.time, xyz: row.adr, binance: row.ordinary, io: null, rh: null })), stamp);
  let enabled = true;
  const view = (days: number | null) => {
    const last = rows.at(-1)!.time;
    return { rows: days === null ? rows : rows.filter(row => row.time >= last - days * DAY),
      status: 'live', fetchedAt: new Date(last + HOUR).toISOString(), ...(days === null ? {} : { windowDays: days }),
      coverage: { firstObservation: new Date(rows[0]!.time).toISOString(), lastObservation: new Date(last).toISOString(), rows: rows.length } };
  };
  const harness = createHarness();
  const server = createExecutorServer({ executor: harness.ex, accessToken: 'monitor-candle-test-token', views: {
    monitor: { state: () => ({ markets: ['hynix', 'oil', 'anthropic'] }), quote: () => undefined, enabled: () => enabled,
      candles(market, days) {
        if (market === 'oil') return days === null ? oil : intradayWindow(oil, days);
        if (market === 'anthropic') return days === null ? anthropic : anthropicCandleWindow(anthropic, days);
        return view(days);
      } },
  } });
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); harness.dispose(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(`${base}/login?token=monitor-candle-test-token`, { redirect: 'manual' });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  let transmitted: number[] = [];
  let delay: (() => Promise<void>) | undefined;
  let calls = 0, failure = 0, clock = START + HOUR - 20_000;
  const fetchHistory = async (path: string, signal: AbortSignal) => {
    calls++;
    if (failure) throw new ApiError('行情读取失败', failure);
    await delay?.();
    const response = await fetch(base + path, { headers: { cookie }, signal });
    if (!response.ok) throw new ApiError(response.statusText, response.status);
    const update = await response.json() as MonitorCandleUpdate;
    transmitted = update.candles.blocks.flatMap(block => block.rows?.map(row => row.time) ?? []);
    return update;
  };
  const disk = new Map<string, SavedMonitorCandles>();
  const reader = createMonitorCandleReader('hynix', hynixHistory, browser(disk), fetchHistory, () => clock);
  const week = await reader.read(28, signal);
  assert.deepEqual(week, hynixHistory(view(28)));
  const firstTransfer = new Set(transmitted);
  assert.strictEqual(await reader.read(28, signal), week);
  assert.deepEqual(transmitted, []);

  const started = deferred<void>(), resume = deferred<void>();
  delay = () => { started.resolve(); return resume.promise; };
  const expanding = reader.read(51, signal);
  await started.promise;
  const waiting = monitorCandleSelection(reader.peek(), 30, 21, 7);
  assert.strictEqual(waiting.data, week);
  assert.equal(waiting.range, 7);
  assert.match(waiting.notice, /1 月行情尚未补齐.*1 周/);
  resume.resolve(); delay = undefined;
  const month = await expanding;
  assert.deepEqual(month, hynixHistory(view(51)));
  assert.ok(transmitted.length > 0 && transmitted.every(time => !firstTransfer.has(time)), '扩窗没有重复传原窗口的 K 线');
  assert.deepEqual(monitorCandleSelection(month, 30, 21, 7), { data: month, range: 30, notice: '' });
  assert.deepEqual(monitorCandleSelection(month, 7, 21), { data: month, range: 7, notice: '' });
  const beforeNarrowing = calls;
  clock += 10_000;
  assert.strictEqual(await reader.read(28, signal, true), month);
  assert.equal(calls, beforeNarrowing, '同一次会话中缩小或重进已覆盖窗口，连 GET 也跳过');
  assert.equal(reader.intervalAfter(clock), 10_000, '跳过读取不会延后即将到达的新收盘边界');
  clock += 10_000;
  assert.strictEqual(await reader.read(28, signal, true), month);
  assert.equal(calls, beforeNarrowing + 1, '跨小时收盘立即重查');
  clock += 60_000;
  assert.strictEqual(await reader.read(28, signal, true), month);
  assert.equal(calls, beforeNarrowing + 2, '两次收盘间的确认也会在一分钟到期');
  assert.strictEqual(await reader.read(28, signal), month);
  assert.equal(calls, beforeNarrowing + 3, '显式刷新跳过复用');
  assert.deepEqual(transmitted, []);

  const reopened = createMonitorCandleReader('hynix', hynixHistory, browser(disk), fetchHistory, () => clock);
  const restored = await reopened.restore();
  assert.deepEqual(restored, month);
  const beforeReopen = calls;
  assert.strictEqual(await reopened.read(28, signal, true), restored);
  assert.equal(calls, beforeReopen + 1, '硬刷新先核实服务端的版本与状态');
  assert.deepEqual(transmitted, []);
  failure = 503;
  await assert.rejects(reopened.read(28, signal), { status: 503 });
  assert.strictEqual(reopened.peek(), restored);
  failure = 0;
  assert.strictEqual(await reopened.read(28, signal, true), restored);
  assert.equal(calls, beforeReopen + 3, '此前一次读取失败会作废跳过 GET 的资格');
  rows = [...rows.map(row => row.time === sample(31).time ? { ...row, adr: 999 } : row), sample(34)].sort((a, b) => a.time - b.time);
  const revised = await reopened.read(28, signal);
  assert.deepEqual(transmitted, [sample(31).time, sample(34).time]);
  assert.deepEqual(revised, hynixHistory(view(51)), '缩小时仍接收以前选过的一个月区间内的修订和缺口');
  rows = [...rows, sample(74)];
  assert.deepEqual(await reopened.read(51, signal), hynixHistory(view(51)));
  assert.deepEqual(transmitted, [sample(74).time], '滑动时间窗口仅下载新收盘');
  assert.deepEqual(await reopened.read(null, signal), hynixHistory(view(null)));
  assert.ok(transmitted.every(time => time < sample(24).time));
  enabled = false;
  await assert.rejects(reopened.read(null, signal), candleReadDenied);
  assert.equal(reopened.peek(), undefined);
  assert.equal(disk.size, 0);
  enabled = true;
  assert.deepEqual(await reopened.read(28, signal), hynixHistory(view(28)));
  assert.ok(transmitted.length >= week.points.length);
  assert.equal((await fetch(base + '/api/monitor/hynix/candles?known=')).status, 401);

  await t.test('原油从最后共同收盘定窗，单腿晚于该收盘仍能还原完整响应', async () => {
    const oilReader = createMonitorCandleReader('oil', oilHistory, browser(disk), fetchHistory);
    const history = await oilReader.read(28, signal);
    assert.deepEqual(history, oilHistory(intradayWindow(oil, 28)));
    assert.equal(history.points.at(-1)?.time, sample(69).time);
    assert.strictEqual(await oilReader.read(28, signal), history);
    assert.deepEqual(transmitted, []);
  });
  await t.test('Anthropic 的行数、采集时间与两端时间均未变化，也会收到旧时刻迟到的一条腿', async () => {
    const antReader = createMonitorCandleReader('anthropic', anthropicHistory, browser(disk), fetchHistory);
    await antReader.read(28, signal);
    const target = sample(61).time;
    anthropic = createAnthropicCandles(anthropic.data.map(row => row.time === target ? { ...row, rh: 123 } : row), stamp);
    const repaired = await antReader.read(28, signal);
    assert.deepEqual(transmitted, [target]);
    assert.equal(repaired.rows.find(row => row.time === target)?.rh, 123);
  });
});

test('会话、配置或开关明确失效才清掉历史；迟到应答不能重新填入', async () => {
  for (const status of [401, 403, 404, 423]) assert.equal(candleReadDenied(new ApiError('', status)), true);
  for (const status of [429, 502, 503]) assert.equal(candleReadDenied(new ApiError('', status)), false);
  const disk = new Map<string, SavedMonitorCandles>();
  const started = deferred<void>(), released = deferred<unknown>();
  const reader = createMonitorCandleReader('hynix', hynixHistory, browser(disk), async () => { started.resolve(); return released.promise; });
  const late = reader.read(null, signal);
  await started.promise; reader.clear(); released.resolve({});
  await assert.rejects(late, { name: 'AbortError' });
  assert.equal(disk.size, 0);
});
