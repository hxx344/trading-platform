// Monitor M-1 in this service: monitor.sqlite, the Anthropic collector's rounds and loops, the monitor block of config.json
// and the three read-only endpoints. Every venue is the stand-in in monitor-fake.ts; nothing goes to the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMonitorStore, MONITOR_FILE, type MonitorStore } from '../src/monitor/store.ts';
import { BINANCE_REBASE, CANDLE_KEY, CANDLE_STALE_MS, MAX_REPLY_BYTES, QUOTE_KEY, QUOTE_STALE_MS, boundedReply, createAnthropicMonitor, rebaseBinanceCandles } from '../src/monitor/anthropic.ts';
import { MODULE_KEYS, parseServiceConfig } from '../src/service/config.ts';
import { monitorSummary } from '../src/service/monitor-config.ts';
import { ANTHROPIC_LEG_KEYS, type AnthropicCandleRow } from '../src/vendor/anthropic-market.mjs';
import { createMarketReaders } from '../src/monitor/market-readers.ts';
import { fakeAnthropicPrice, fakeAnthropicVenues } from './monitor-fake.ts';
import { FakeAster } from './aster-fake.ts';
import { createHarness } from './harness.ts';
import { createExecutorServer } from '../src/http.ts';
import { monitorViews, openMonitor } from '../src/service/monitor.ts';
import type { AddressInfo } from 'node:net';

const BAR = 900_000, DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 6, 12, 7);
const iso = (ms: number) => new Date(ms).toISOString();
/** node:sqlite rows have no prototype; the collector's rows are plain objects. */
const plain = (rows: readonly AnthropicCandleRow[]) => rows.map(row => ({ ...row }));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 250; i++) { if (await check()) return; await sleep(20); }
  assert.fail(`等待超时：${what}`);
}

/** A fresh monitor.sqlite and the venue stand-in on a hand-moved clock. */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'tp-monitor-'));
  const store = createMonitorStore({ file: join(dir, MONITOR_FILE) });
  const env = { dir, store, clock: NOW, logs: [] as string[], venues: null as unknown as ReturnType<typeof fakeAnthropicVenues> };
  env.venues = fakeAnthropicVenues({ now: () => env.clock });
  const monitor = (over: { store?: MonitorStore; now?: () => number } = {}) => createAnthropicMonitor({ store: over.store ?? store, fetchImpl: env.venues.fetch, now: over.now ?? (() => env.clock), log: line => env.logs.push(line) });
  const dispose = () => { try { store.close(); } catch { /* closed by the test */ } rmSync(dir, { recursive: true, force: true }); };
  return Object.assign(env, { monitor, dispose });
}

test('行情监控库：按时间写入与覆盖、读回、按保留期删除，整轮写入在同一个事务里', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-monitor-'));
  const file = join(dir, MONITOR_FILE);
  let at = 1_000;
  const row = (time: number, binance: number | null): AnthropicCandleRow => ({ time, binance, xyz: 95, io: null, rh: 1500 });
  const store = createMonitorStore({ file, now: () => at });
  try {
    assert.deepEqual(store.candles(), []);
    assert.equal(store.readState('k'), null);
    assert.equal(store.writeCandles({ rows: [row(2 * BAR, 1201), row(BAR, 1200)], cutoff: 0, state: { key: 'k', value: { a: 1 } } }), 0);
    assert.deepEqual(store.candles().map(item => item.time), [BAR, 2 * BAR], '按时间升序读回');
    assert.equal(store.writeCandles({ rows: [row(2 * BAR, 1300), row(3 * BAR, null)], cutoff: 2 * BAR }), 1, '早于保留期起点的行被删除');
    assert.deepEqual(plain(store.candles()), [row(2 * BAR, 1300), row(3 * BAR, null)], '同一时间的行被覆盖，缺失的腿存为 null');
    assert.deepEqual(store.readState('k'), { value: { a: 1 }, updatedAt: 1_000 });
    // The state fails to serialise after the rows went in: the whole round is rolled back.
    assert.throws(() => store.writeCandles({ rows: [row(4 * BAR, 1)], cutoff: 99 * BAR, state: { key: 'k', value: { n: 1n } } }), /BigInt/);
    assert.deepEqual(store.candles().map(item => item.time), [2 * BAR, 3 * BAR]);
    assert.deepEqual(store.readState('k')!.value, { a: 1 });
    assert.equal(store.writeCandles({ rows: [row(5 * BAR, 2)], cutoff: 0, replace: true }), 0);
    assert.deepEqual(plain(store.candles()), [row(5 * BAR, 2)], 'replace 先清空整表');
    at = 2_000;
    store.writeState('q', { x: 1 });
    store.close();
    const again = createMonitorStore({ file });
    try {
      assert.deepEqual(plain(again.candles()), [row(5 * BAR, 2)]);
      assert.deepEqual(again.readState('q'), { value: { x: 1 }, updatedAt: 2_000 });
      const raw = new DatabaseSync(file);
      raw.prepare("UPDATE monitor_state SET json = '{' WHERE key = 'q'").run();
      raw.close();
      assert.throws(() => again.readState('q'), SyntaxError);
    } finally { again.close(); }
  } finally { try { store.close(); } catch { /* closed above */ } rmSync(dir, { recursive: true, force: true }); }
});

test('采集：报价超过 35 秒、K 线超过 615 秒转为快照；库里读回的数据先标为快照，下一轮成功后转为实时', async () => {
  const env = setup();
  try {
    const monitor = env.monitor();
    assert.equal(monitor.quote(), null);
    assert.equal(monitor.candles(null), null);
    await monitor.refreshQuote();
    const quote = monitor.quote()!;
    assert.deepEqual([quote.status, quote.fetchedAt, quote.staleAfterMs, quote.lastAttemptAt, quote.lastError, quote.errors], ['live', iso(NOW), QUOTE_STALE_MS, iso(NOW), null, {}]);
    for (const leg of ANTHROPIC_LEG_KEYS) assert.equal(quote[leg]!.markPx, fakeAnthropicPrice(leg, NOW), leg);
    env.clock = NOW + QUOTE_STALE_MS;
    assert.equal(monitor.quote()!.status, 'live');
    env.clock += 1;
    assert.equal(monitor.quote()!.status, 'snapshot', '超过 35 秒没有新报价');

    const fetched = env.clock;
    await monitor.refreshCandles();
    const all = monitor.candles(null)!;
    assert.equal(all.status, 'live');
    assert.equal(all.metadata.fetchedAt, iso(fetched));
    assert.deepEqual(all.metadata.errors, {});
    assert.equal(all.data.at(-1)!.time, Math.floor(fetched / BAR) * BAR - BAR, '只要已收盘的 K 线');
    assert.ok(all.data[0]!.time >= fetched - 50 * DAY - BAR, '首次回补 50 天');
    assert.ok(all.data.some(row => row.rh === null) && all.data.at(-1)!.rh !== null, 'Lighter RH 只覆盖上市以来');
    assert.deepEqual(plain(env.store.candles()), all.data, '每一行都已写入 monitor.sqlite');
    const week = monitor.candles(7)!;
    assert.equal(week.windowDays, 7);
    assert.deepEqual(week.coverage, { firstObservation: all.metadata.firstObservation, lastObservation: all.metadata.lastObservation, rows: all.data.length });
    assert.ok(week.data[0]!.time >= all.data.at(-1)!.time - 7 * DAY && week.data.length < all.data.length);
    env.clock = Math.floor(fetched / BAR) * BAR + BAR + CANDLE_STALE_MS;
    assert.equal(monitor.candles(null)!.status, 'live');
    env.clock += 1;
    assert.equal(monitor.candles(null)!.status, 'snapshot', '超过下一次应收盘时间和宽限仍未更新');

    // A restart reads both back as a snapshot, however recent they are.
    const restored = env.monitor({ now: () => fetched });
    assert.deepEqual([restored.quote()!.status, restored.quote()!.fetchedAt], ['snapshot', iso(NOW)]);
    assert.equal(restored.candles(null)!.status, 'snapshot');
    assert.deepEqual(restored.candles(null)!.data, all.data);
    const before = env.venues.requests.get('candles:binance');
    await restored.refreshQuote();
    await restored.refreshCandles();
    assert.equal(restored.quote()!.status, 'live');
    assert.equal(restored.candles(null)!.status, 'live');
    assert.equal(env.venues.requests.get('candles:binance'), before, '同一收盘区间从 SQLite 恢复，无上游读取');
    assert.deepEqual(env.logs, []);
  } finally { env.dispose(); }
});

test('采集：单腿失败只标出该腿原因；四条腿都失败时保留上次报价与 K 线并说明原因，恢复后清除', async () => {
  const env = setup();
  try {
    const monitor = env.monitor();
    await monitor.refreshQuote();
    await monitor.refreshCandles();
    env.venues.down.add('binance');
    env.clock += 10_000;
    await monitor.refreshQuote();
    let quote = monitor.quote()!;
    assert.deepEqual([quote.binance, quote.errors, quote.fetchedAt, quote.lastError], [null, { binance: '接口返回 HTTP 500' }, iso(env.clock), null]);
    assert.ok(quote.xyz && quote.io && quote.rh);

    for (const leg of ANTHROPIC_LEG_KEYS) env.venues.down.add(leg);
    const kept = quote.fetchedAt;
    for (let round = 0; round < 2; round++) {
      env.clock += 10_000;
      await monitor.refreshQuote();
    }
    quote = monitor.quote()!;
    assert.deepEqual([quote.fetchedAt, quote.lastAttemptAt, quote.lastError, quote.status], [kept, iso(env.clock), '四条腿都没有取到报价', 'live']);
    env.clock += 16_000;
    assert.equal(monitor.quote()!.status, 'snapshot');
    assert.equal(env.logs.filter(line => line.includes('报价读取失败')).length, 1, '同一原因只记一次日志');

    const rows = monitor.candles(null)!.data;
    env.clock += BAR;
    await monitor.refreshCandles();
    let candles = monitor.candles(null)!;
    assert.deepEqual([candles.status, candles.lastError, candles.lastAttemptAt], ['snapshot', 'K 线读取失败：接口返回 HTTP 500', iso(env.clock)]);
    assert.deepEqual(candles.data, rows, '失败的一轮不改动已有 K 线');
    assert.equal(monitor.status().candleError, 'K 线读取失败：接口返回 HTTP 500');

    env.venues.down.clear();
    env.venues.down.add('io');
    env.clock += BAR;
    await monitor.refreshQuote();
    await monitor.refreshCandles();
    quote = monitor.quote()!;
    assert.deepEqual([quote.status, quote.lastError, quote.errors], ['live', null, { io: '接口返回 HTTP 500' }]);
    candles = monitor.candles(null)!;
    assert.deepEqual([candles.status, candles.lastError, candles.metadata.errors], ['live', null, { io: '接口返回 HTTP 500' }]);
    assert.ok(candles.data.length > rows.length);
    assert.ok(candles.data.at(-1)!.io === null && candles.data[0]!.io !== null, '失败的腿保留旧收盘，不再向前');
    assert.ok(env.logs.some(line => line === 'Anthropic 报价读取已恢复'));
    assert.ok(env.logs.some(line => line === 'Anthropic K 线读取已恢复'));
    const restored = env.monitor();
    await restored.refreshCandles();
    const partial = restored.candles(null)!;
    assert.deepEqual([partial.status, partial.metadata.fetchedAt, partial.metadata.errors], ['live', candles.metadata.fetchedAt, { io: '接口返回 HTTP 500' }]);
    env.venues.down.clear(); env.venues.requests.clear();
    await restored.refreshCandles();
    assert.deepEqual([...env.venues.requests.keys()], ['candles:io'], '重启后只查未追到收盘的腿');
    assert.ok(restored.candles(null)!.data.at(-1)!.io);
    assert.deepEqual(restored.candles(null)!.metadata.errors, {});
  } finally { env.dispose(); }
});

test('四腿确认的空区间可以续读，不能给旧收盘续鲜', async () => {
  const env = setup();
  try {
    const first = env.monitor();
    await first.refreshCandles();
    const prior = first.candles(null)!.metadata.lastObservation;
    const empty = createAnthropicMonitor({ store: env.store, now: () => env.clock, readers: {
      ...createMarketReaders({ fetchImpl: env.venues.fetch }), async anthropicCandles(_starts, at, _signal, ends) {
        return { at, errors: {}, legs: { binance: [], io: [], xyz: [], rh: [] }, through: ends!, binanceSymbol: 'ANTUSDT' };
      },
    } });
    for (let i = 0; i < 3; i++) {
      env.clock = Math.floor(env.clock / BAR) * BAR + BAR + CANDLE_STALE_MS + 1;
      await empty.refreshCandles();
      const view = empty.candles(null)!;
      assert.deepEqual([view.status, view.metadata.lastObservation, view.metadata.fetchedAt], ['snapshot', prior, iso(env.clock)]);
    }
  } finally { env.dispose(); }
});

test('采集：写库失败时内存停在库里的状态；库里的历史读不回时下一轮整表重写', async () => {
  const env = setup();
  try {
    const failing: MonitorStore = { ...env.store, writeCandles: () => { throw new Error('disk I/O error'); }, writeState: () => { throw new Error('disk I/O error'); } };
    const broken = env.monitor({ store: failing });
    await broken.refreshQuote();
    assert.equal(broken.quote()!.status, 'live', '报价照常提供，只是没有存下');
    await broken.refreshCandles();
    assert.equal(broken.candles(null), null, 'K 线没写进库就不前进');
    assert.equal(broken.status().candleError, 'K 线保存失败：monitor.sqlite 写入失败');
    assert.ok(env.logs.some(line => /报价保存失败：monitor\.sqlite 写入失败（disk I\/O error）/.test(line)));
    assert.ok(env.logs.some(line => /K 线保存失败：monitor\.sqlite 写入失败/.test(line)));

    // Rows without their round's record, and a quote that no longer validates.
    const old = Math.floor((NOW - 100 * DAY) / BAR) * BAR;
    env.store.writeCandles({ rows: [{ time: old, binance: 1, xyz: 1, io: 1, rh: 1 }], cutoff: 0 });
    env.store.writeState(QUOTE_KEY, { fetchedAt: 'x' });
    env.logs.length = 0;
    const monitor = env.monitor();
    assert.equal(monitor.quote(), null);
    assert.equal(monitor.candles(null), null);
    assert.ok(env.logs.some(line => line.startsWith('Anthropic 上次报价无法读回')));
    assert.ok(env.logs.some(line => line.startsWith('Anthropic K 线历史无法读回，将从 50 天前重新回补')));
    await monitor.refreshCandles();
    assert.ok(!env.store.candles().some(row => row.time === old), '读不回的旧行被清掉');
    assert.deepEqual(plain(env.store.candles()), monitor.candles(null)!.data);
  } finally { env.dispose(); }
});

test('Binance 腿换到 ANTUSDT：旧合约的历史收盘价除以 13.116，切换时刻之后的清空，重复换算结果不变', () => {
  const cut = BINANCE_REBASE.from;
  const rows: AnthropicCandleRow[] = [
    { time: cut - 2 * BAR, binance: 1311.6, xyz: 99, io: 1700, rh: 1690 },
    { time: cut - BAR, binance: 1252.52, xyz: null, io: null, rh: null },
    { time: cut, binance: 1252.52, xyz: 95, io: null, rh: null },
    { time: cut + BAR, binance: 1252.52, xyz: null, io: null, rh: null },
    { time: cut + 6 * BAR, binance: 87.5, xyz: 88, io: 1560, rh: 1544 },
  ];
  const once = rebaseBinanceCandles(rows);
  assert.deepEqual(once.map(row => row.time), [cut - 2 * BAR, cut - BAR, cut, cut + 6 * BAR], '只剩旧合约收盘的行整行去掉');
  assert.ok(Math.abs(once[0]!.binance! - 100) < 1e-9 && Math.abs(once[1]!.binance! - 1252.52 / 13.116) < 1e-9);
  assert.deepEqual([once[2]!.binance, once[3]!.binance], [null, null], '切换时刻起的 Binance 收盘等新合约重新读取');
  assert.deepEqual({ ...once[0], binance: 0 }, { ...rows[0], binance: 0 }, '其余三条腿不动');
  assert.deepEqual(rebaseBinanceCandles(once), once, '已是每股口径的价格不再除');
});

test('采集：库里是旧合约 ANTHROPICUSDT 的历史时，启动后按每股口径读回，下一轮连同标记整表重写', async () => {
  const env = setup();
  try {
    const first = env.monitor();
    await first.refreshQuote();
    await first.refreshCandles();
    const fresh = first.candles(null)!.data;
    // Put the store back to what the previous version left: old-contract closes, no contract marker on either record.
    const raw = new DatabaseSync(join(env.dir, MONITOR_FILE));
    raw.prepare('UPDATE anthropic_candles SET binance = binance * 13.116 WHERE binance IS NOT NULL').run();
    raw.close();
    const round = env.store.readState(CANDLE_KEY)!.value as Record<string, unknown>;
    assert.equal(round.binance, 'ANTUSDT');
    const { binance: _marker, ...oldRound } = round;
    env.store.writeState(CANDLE_KEY, oldRound);
    const { binanceSymbol: _symbol, ...oldQuote } = env.store.readState(QUOTE_KEY)!.value as Record<string, unknown>;
    env.store.writeState(QUOTE_KEY, oldQuote);

    const upgraded = env.monitor();
    assert.equal(env.logs.filter(line => /按 ANTUSDT 口径换算/.test(line)).length, 1);
    const restored = upgraded.candles(null)!.data;
    assert.equal(restored.length, fresh.length);
    for (const [index, row] of restored.entries()) {
      const want = fresh[index]!;
      assert.deepEqual({ ...row, binance: null }, { ...want, binance: null });
      assert.ok(row.binance === want.binance || Math.abs(row.binance! - want.binance!) < 1e-9, '旧合约收盘价换回每股口径');
    }
    assert.equal(upgraded.quote()!.binance, null, '旧合约的报价不再显示');
    assert.match(upgraded.quote()!.errors.binance!, /合约已更换/);
    assert.equal(upgraded.quote()!.xyz!.markPx, fakeAnthropicPrice('xyz', NOW), '其余腿照常读回');
    assert.ok(env.store.candles().some(row => row.binance !== null && row.binance >= BINANCE_REBASE.oldUnitFloor), '换算只在内存里，库还没动');

    env.clock += BAR;
    await upgraded.refreshQuote();
    await upgraded.refreshCandles();
    assert.equal(upgraded.quote()!.binance!.markPx, fakeAnthropicPrice('binance', env.clock));
    assert.equal((env.store.readState(CANDLE_KEY)!.value as { binance?: string }).binance, 'ANTUSDT');
    assert.ok(env.store.candles().every(row => row.binance === null || row.binance < BINANCE_REBASE.oldUnitFloor), '整表已按每股口径重写');
    assert.deepEqual(plain(env.store.candles()), upgraded.candles(null)!.data);
    env.logs.length = 0;
    env.monitor();
    assert.deepEqual(env.logs, [], '带标记的历史不再换算');
  } finally { env.dispose(); }
});

test('采集：切换之后才升级时，旧合约冻结的收盘被清掉，Binance 腿从切换时刻起由 ANTUSDT 重新读回', async () => {
  const env = setup();
  try {
    env.clock = Date.UTC(2026, 10, 23, 12, 7);
    const first = env.monitor();
    await first.refreshCandles();
    const fresh = first.candles(null)!.data;
    assert.ok(fresh.some(row => row.time >= BINANCE_REBASE.from && row.binance !== null) && fresh[0]!.time < BINANCE_REBASE.from);
    // What v0.80.1 left: per-valuation closes up to the settlement, the frozen settlement price after it, no marker.
    const raw = new DatabaseSync(join(env.dir, MONITOR_FILE));
    raw.prepare('UPDATE anthropic_candles SET binance = binance * 13.116 WHERE binance IS NOT NULL AND time < ?').run(BINANCE_REBASE.from);
    raw.prepare('UPDATE anthropic_candles SET binance = 1252.52 WHERE time >= ?').run(BINANCE_REBASE.from);
    raw.close();
    const { binance: _marker, ...oldRound } = env.store.readState(CANDLE_KEY)!.value as Record<string, unknown>;
    env.store.writeState(CANDLE_KEY, oldRound);

    const upgraded = env.monitor();
    const restored = upgraded.candles(null)!.data;
    assert.ok(restored.every(row => row.time < BINANCE_REBASE.from ? true : row.binance === null), '冻结的结算价不显示');
    const before = env.venues.requests.get('candles:binance') ?? 0;
    await upgraded.refreshCandles();
    assert.ok((env.venues.requests.get('candles:binance') ?? 0) > before, 'Binance 腿的进度退回切换时刻后重新读取');
    const healed = upgraded.candles(null)!.data;
    assert.equal(healed.length, fresh.length);
    for (const [index, row] of healed.entries()) {
      const want = fresh[index]!;
      // Lighter RH keeps backfilling a few pages per round, so only the other legs are compared.
      assert.deepEqual([row.time, row.xyz, row.io], [want.time, want.xyz, want.io]);
      assert.ok(row.binance === want.binance || Math.abs(row.binance! - want.binance!) < 1e-9, iso(row.time));
    }
    assert.deepEqual(plain(env.store.candles()), healed, '整表重写');
    const saved = env.store.readState(CANDLE_KEY)!.value as { binance?: string; coverage: { binance: { through: number } } };
    assert.equal(saved.binance, 'ANTUSDT');
    assert.ok(saved.coverage.binance.through > BINANCE_REBASE.from);
    assert.deepEqual(upgraded.candles(null)!.metadata.errors, {});
  } finally { env.dispose(); }
});

test('采集：行情服务还在读旧合约（应答没有 ANTUSDT 标记）时，不采用它的 Binance 报价与 K 线', async () => {
  const env = setup();
  try {
    const real = createMarketReaders({ fetchImpl: env.venues.fetch, now: () => env.clock });
    let symbol: string | undefined;
    const monitor = createAnthropicMonitor({ store: env.store, now: () => env.clock, log: line => env.logs.push(line), readers: {
      ...real,
      anthropicQuote: async signal => ({ ...await real.anthropicQuote(signal), binanceSymbol: symbol }),
      anthropicCandles: async (starts, at, signal, ends) => ({ ...await real.anthropicCandles(starts, at, signal, ends), binanceSymbol: symbol }),
    } });
    for (symbol of [undefined, 'ANTHROPICUSDT']) {
      await monitor.refreshQuote();
      await monitor.refreshCandles();
      assert.equal(monitor.quote()!.binance, null, String(symbol));
      assert.match(monitor.quote()!.errors.binance!, /不是当前 Binance 合约/);
      assert.equal(monitor.quote()!.xyz!.markPx, fakeAnthropicPrice('xyz', env.clock));
      const view = monitor.candles(null)!;
      assert.ok(view.data.length > 0 && view.data.every(row => row.binance === null), '旧合约的收盘价不入库');
      assert.match(view.metadata.errors.binance!, /不是当前 Binance 合约/);
      assert.ok(env.store.candles().every(row => row.binance === null));
      env.clock += 10_000;
    }
    symbol = 'ANTUSDT';
    await monitor.refreshQuote();
    await monitor.refreshCandles();
    assert.equal(monitor.quote()!.binance!.markPx, fakeAnthropicPrice('binance', env.clock));
    assert.deepEqual(monitor.candles(null)!.metadata.errors, {});
    assert.ok(monitor.candles(null)!.data.at(-1)!.binance !== null, '行情服务更新后从头补回 Binance 腿');
  } finally { env.dispose(); }
});

test('采集循环：报价与 K 线两类轮次各自不重叠，停止后循环结束；stop() 中断在途请求', async () => {
  const env = setup();
  try {
    env.venues.delayMs = 3;
    let stopped = false;
    const pauses: number[] = [];
    const context = { stopped: () => stopped, pause: async (ms: number) => { pauses.push(ms); await sleep(1); } };
    const monitor = env.monitor();
    const loops = monitor.loops(context);
    await until(() => (env.venues.requests.get('quote:binance') ?? 0) >= 5 && monitor.candles(null) !== null, '几轮采集');
    stopped = true;
    await Promise.all(loops);
    for (const kind of ['quote:binance', 'quote:xyz', 'quote:io', 'candles:binance', 'candles:xyz', 'candles:io', 'candles:rh']) assert.equal(env.venues.maxInFlight.get(kind), 1, kind);
    assert.ok(pauses.includes(10_000) && pauses.includes(60_000), JSON.stringify([...new Set(pauses)]));
    const total = [...env.venues.requests.values()].reduce((sum, value) => sum + value, 0);
    await sleep(30);
    assert.equal([...env.venues.requests.values()].reduce((sum, value) => sum + value, 0), total, '停止后不再发请求');

    env.venues.hold = new Promise(() => undefined);
    env.clock += BAR;
    const held = env.monitor();
    const rounds = [held.refreshQuote(), held.refreshCandles()];
    await sleep(20);
    const started = Date.now();
    held.stop();
    await Promise.all(rounds);
    assert.ok(Date.now() - started < 1_000, '不等请求超时');
    assert.deepEqual([held.status().quoteError, held.status().candleError], [null, null], '停止中断的请求不算失败');
    assert.ok(!env.logs.some(line => line.includes('失败')), env.logs.join('\n'));
  } finally { env.dispose(); }
});

test('服务配置：monitor 段的默认股数与校验；只配 monitor 时 pairs 可以省略', async () => {
  assert.deepEqual(MODULE_KEYS, ['oil', 'options', 'monitor', 'asset', 'crossex', 'ondo']);
  const secretsFile = '/etc/tp/secrets.json';
  const config = parseServiceConfig({ secretsFile, monitor: { anthropic: {} } });
  assert.deepEqual(config.pairs, []);
  assert.equal(config.oil, undefined);
  assert.deepEqual(config.monitor, { anthropic: { shares: { outstanding: 13.116, diluted: 17.68 } } });
  assert.equal(monitorSummary(config.monitor), '，行情监控 Anthropic 价差（流通股 13.116 十亿、完全稀释 17.68 十亿股）');
  assert.equal(monitorSummary(undefined), '');
  for (const shares of [{ outstanding: 13, diluted: 13 }, { outstanding: 1, diluted: 100 }]) {
    assert.deepEqual(parseServiceConfig({ secretsFile, monitor: { anthropic: { shares } } }).monitor!.anthropic!.shares, shares);
  }
  const paired = parseServiceConfig({ secretsFile, pairs: [{ id: 'p1', main: 'main', long: 'a', short: 'b' }], monitor: { anthropic: {} } });
  assert.deepEqual(paired.pairs.map(pair => pair.id), ['p1']);
  for (const shares of [{ outstanding: 0.9, diluted: 16.7 }, { outstanding: 14, diluted: 13 }, { outstanding: 12.7, diluted: 100.1 }, { outstanding: '12.7', diluted: 16.7 }, { outstanding: 12.7 }, { outstanding: 12.7, diluted: 16.7, total: 20 }, null]) {
    assert.throws(() => parseServiceConfig({ secretsFile, monitor: { anthropic: { shares } } }), /monitor\.anthropic\.shares/, JSON.stringify(shares));
  }
  assert.throws(() => parseServiceConfig({ secretsFile, monitor: {} }), /monitor 须至少配置一个市场/);
  assert.throws(() => parseServiceConfig({ secretsFile, monitor: null }), /monitor 无效/);
  assert.throws(() => parseServiceConfig({ secretsFile, monitor: { anthropic: {}, aero: {} } }), /monitor 无效/);
  assert.throws(() => parseServiceConfig({ secretsFile, monitor: { anthropic: { refreshMs: 1000 } } }), /monitor\.anthropic 无效/);
  assert.throws(() => parseServiceConfig({ secretsFile }), '没有任何模块时仍须写 pairs');

  const { planImport } = await import('../src/service/import-workbench.ts');
  const existing = { config: { secretsFile: '/x/secrets.json', monitor: { anthropic: { shares: { outstanding: 13, diluted: 17 } } } }, secrets: { accounts: {} } };
  const plan = planImport({ pairs: [], accounts: [], env: {} }, existing, { secretsFile: '/x/secrets.json' });
  assert.deepEqual(plan.config.monitor, existing.config.monitor, '导入工作台配对时 monitor 段原样保留');
  assert.deepEqual(plan.config.pairs, []);
});

test('HTTP：行情监控三个接口未登录 401、未配置 404、尚无数据 503、days 不合法 400，取到数据后按窗口返回', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-monitor-'));
  const venues = fakeAnthropicVenues();
  const config = parseServiceConfig({ secretsFile: '/etc/tp/secrets.json', monitor: { anthropic: {} } }).monitor!;
  const runtime = openMonitor(config, dir, { fetchImpl: venues.fetch, log: () => undefined });
  const h = createHarness();
  const servers = [createExecutorServer({ executor: h.ex, accessToken: 'monitor-token-0001', views: { monitor: monitorViews(runtime) } }), createExecutorServer({ executor: h.ex, accessToken: 'monitor-token-0001', views: {} })];
  try {
    const [withMonitor, without] = await Promise.all(servers.map(async server => {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const cookie = ((await fetch(`${base}/login?token=monitor-token-0001`, { redirect: 'manual' })).headers.get('set-cookie') ?? '').split(';')[0]!;
      return { base, get: async (path: string) => { const response = await fetch(base + path, { headers: { cookie } }); return { status: response.status, body: await response.json() as Record<string, any> }; } };
    }));
    assert.equal((await fetch(`${withMonitor!.base}/api/monitor/state`)).status, 401);
    for (const path of ['/api/monitor/state', '/api/monitor/anthropic/quote', '/api/monitor/anthropic/candles']) assert.equal((await without!.get(path)).status, 404, path);
    const get = withMonitor!.get;
    assert.deepEqual(await get('/api/monitor/state'), { status: 200, body: { markets: ['anthropic'], anthropic: { shares: { outstanding: 13.116, diluted: 17.68 } }, controls: { anthropic: { market: 'anthropic', enabled: true, revision: 0, error: null } } } });
    assert.deepEqual([(await get('/api/monitor/anthropic/quote')).status, (await get('/api/monitor/anthropic/quote')).body.code], [503, 'not_ready']);
    assert.deepEqual([(await get('/api/monitor/anthropic/candles')).status, (await get('/api/monitor/anthropic/candles')).body.code], [503, 'not_ready']);
    for (const days of ['0', 'x', '401', '007', '1.5', '-1', '']) {
      const bad = await get(`/api/monitor/anthropic/candles?days=${days}`);
      assert.deepEqual([bad.status, bad.body.code], [400, 'invalid_days'], days);
    }
    for (const leg of ['binance', 'xyz', 'io', 'rh'] as const) venues.down.add(leg);
    await Promise.all([runtime.anthropic!.refreshQuote(), runtime.anthropic!.refreshCandles()]);
    assert.equal((await get('/api/monitor/anthropic/quote')).body.code, 'quote_unavailable');
    assert.equal((await get('/api/monitor/anthropic/candles?known=')).body.code, 'candles_unavailable');
    venues.down.clear();
    await runtime.anthropic!.refreshQuote();
    await runtime.anthropic!.refreshCandles();
    const quote = await get('/api/monitor/anthropic/quote');
    assert.deepEqual([quote.status, quote.body.status, quote.body.lastError], [200, 'live', null]);
    const all = (await get('/api/monitor/anthropic/candles')).body;
    const week = (await get('/api/monitor/anthropic/candles?days=7')).body;
    assert.deepEqual([all.status, all.windowDays, week.windowDays, week.coverage.rows], ['live', undefined, 7, all.metadata.rows]);
    assert.ok(week.data.length < all.data.length);
    assert.equal((await get('/api/monitor/anthropic/candles?days=400')).body.metadata.rows, all.metadata.rows);
  } finally {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    h.dispose();
    runtime.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// The two tests below start the whole service, which runs on Linux only (account process locks), like service.test.ts.
const APP = { index: Buffer.from('<!doctype html><title>t</title>'), assets: new Map() };
async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise<number>(resolve => { const probe = createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address() as { port: number }; probe.close(() => resolve(port)); }); });
}
// Every start gets its own connections: a kept-alive one to the previous start, on the same port, may only be seen
// closed after the next request has gone out on it.
const FRESH = { connection: 'close' };
async function login(dir: string, port: number) {
  let link = '';
  for (let i = 0; i < 100 && !link; i++) { try { link = readFileSync(join(dir, 'access-url'), 'utf8').trim(); } catch { await sleep(20); } }
  const cookie = (await fetch(link, { redirect: 'manual', headers: FRESH })).headers.get('set-cookie')!.split(';')[0]!;
  return async (path: string) => { const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { cookie, ...FRESH } }); return { status: response.status, body: await response.json() as Record<string, any> }; };
}

test('服务进程：配置 monitor 时提供三个只读接口与状态；未登录 401、days 不合法 400、尚无数据 503；重启后读回为快照', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-monitor-'));
  const data = join(dir, 'data');
  const venues = fakeAnthropicVenues();
  let release: () => void = () => undefined;
  venues.hold = new Promise<void>(resolve => { release = resolve; });
  const port = await freePort();
  const { startService } = await import('../src/service/main.ts');
  const config = parseServiceConfig({ secretsFile: '/etc/tp/secrets.json', monitor: { anthropic: { shares: { outstanding: 13, diluted: 17 } } } });
  const start = () => startService({ config, secrets: { accounts: new Map(), feishu: null }, dir: data, port, app: APP, fetchImpl: new FakeAster().fetch, monitorFetch: venues.fetch });
  try {
    let run = await start();
    try {
      const get = await login(data, port);
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/monitor/state`, { headers: FRESH })).status, 401);
      assert.deepEqual(await get('/api/monitor/state'), { status: 200, body: { markets: ['anthropic'], anthropic: { shares: { outstanding: 13, diluted: 17 } }, controls: { anthropic: { market: 'anthropic', enabled: true, revision: 0, error: null } } } });
      assert.deepEqual((await get('/api/monitor/anthropic/quote')).status, 503);
      assert.equal((await get('/api/monitor/anthropic/quote')).body.code, 'not_ready');
      assert.equal((await get('/api/monitor/anthropic/candles?days=7')).status, 503);
      for (const days of ['0', 'x', '401', '007', '1.5', '-1', '']) {
        const bad = await get(`/api/monitor/anthropic/candles?days=${days}`);
        assert.deepEqual([bad.status, bad.body.code], [400, 'invalid_days'], days);
      }
      release();
      await until(async () => (await get('/api/monitor/anthropic/quote')).status === 200 && (await get('/api/monitor/anthropic/candles')).status === 200, '第一轮报价与 K 线');
      const quote = (await get('/api/monitor/anthropic/quote')).body;
      assert.equal(quote.status, 'live');
      assert.ok(quote.binance.markPx > 0 && quote.xyz && quote.io && quote.rh);
      const all = (await get('/api/monitor/anthropic/candles')).body;
      assert.equal(all.status, 'live');
      const week = (await get('/api/monitor/anthropic/candles?days=7')).body;
      assert.deepEqual([week.windowDays, week.coverage.rows], [7, all.metadata.rows]);
      assert.equal((await get('/api/monitor/anthropic/candles?days=400')).status, 200);
      const status = (await get('/api/status')).body;
      assert.deepEqual([status.monitor.available, status.monitor.error, status.monitor.anthropic.quoteAt, status.monitor.anthropic.candleRows], [true, null, quote.fetchedAt, all.metadata.rows]);
    } finally { await run.shutdown(); await run.done; rmSync(join(data, 'access-url'), { force: true }); }

    // The blocked quote stays a snapshot. A verified closed-bar range is served without contacting the venues.
    venues.hold = new Promise(() => undefined);
    run = await start();
    try {
      const get = await login(data, port);
      assert.equal((await get('/api/monitor/anthropic/quote')).body.status, 'snapshot');
      const restored = (await get('/api/monitor/anthropic/candles')).body;
      assert.equal(restored.status, 'live');
      assert.ok(restored.coverage.rows > 0);
    } finally {
      const started = Date.now();
      await run.shutdown(); await run.done;
      assert.ok(Date.now() - started < 5_000, '停止时中断在途请求');
    }
  } finally {
    process.removeAllListeners('SIGINT'); process.removeAllListeners('SIGTERM');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('服务进程：monitor.sqlite 打不开时服务照常启动，行情监控接口 404、状态页说明原因；没配 monitor 时接口同样 404', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-monitor-'));
  const port = await freePort();
  const { startService } = await import('../src/service/main.ts');
  const start = (raw: unknown) => startService({ config: parseServiceConfig(raw), secrets: { accounts: new Map(), feishu: null }, dir: data, port, app: APP, fetchImpl: new FakeAster().fetch, monitorFetch: fakeAnthropicVenues().fetch });
  const data = join(dir, 'data');
  mkdirSync(join(data, MONITOR_FILE), { recursive: true });
  try {
    let run = await start({ secretsFile: '/etc/tp/secrets.json', monitor: { anthropic: {} } });
    try {
      const get = await login(data, port);
      assert.equal((await get('/api/monitor/state')).status, 404);
      const status = (await get('/api/status')).body;
      assert.equal(status.monitor.available, false);
      assert.ok(status.monitor.error);
      assert.equal(status.monitor.anthropic, null);
    } finally { await run.shutdown(); await run.done; rmSync(join(data, 'access-url'), { force: true }); }
    run = await start({ secretsFile: '/etc/tp/secrets.json', pairs: [] });
    try {
      const get = await login(data, port);
      assert.deepEqual([(await get('/api/monitor/state')).status, (await get('/api/monitor/anthropic/candles')).status], [404, 404]);
      assert.equal((await get('/api/status')).body.monitor, undefined, '没配 monitor 时状态里没有这一段');
    } finally { await run.shutdown(); await run.done; }
  } finally {
    process.removeAllListeners('SIGINT'); process.removeAllListeners('SIGTERM');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('交易所应答超过 8 MiB：按读取失败处理，不整体解析；上限内的应答原样可读', async () => {
  const body = (bytes: number) => new Response(new ReadableStream<Uint8Array>({
    start(controller) { for (let left = bytes; left > 0; left -= 65_536) controller.enqueue(new Uint8Array(Math.min(65_536, left))); controller.close(); },
  }));
  assert.equal((await boundedReply(body(MAX_REPLY_BYTES)).arrayBuffer()).byteLength, MAX_REPLY_BYTES);
  await assert.rejects(boundedReply(body(MAX_REPLY_BYTES + 1)).arrayBuffer(), /超过大小上限/);
  assert.throws(() => boundedReply(new Response('{}', { headers: { 'content-length': String(MAX_REPLY_BYTES + 1) } })), /超过大小上限/);
  assert.deepEqual(await boundedReply(Response.json({ ok: 1 }, { status: 429 })).json(), { ok: 1 });
});
