// Monitor M-2d: the settled funding of oil (Binance BZ/CL every 4 h) and Hynix (Hyperliquid SKHY/SKHX hourly) — the vendored
// pairing and paging, the collectors' rounds against the stand-in venues, the endpoint and the page's rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  FUNDING_RESUME_MS, HYNIX_FIRST_SETTLEMENT, OIL_FIRST_SETTLEMENT, analyzeSettledFunding, fundingStart, mergeFundingRows, pairHynixFunding, pairOilFunding,
  validateOilFundingRows, type OilFundingRow,
} from '../src/vendor/settled-funding.mjs';
import { createBinanceGate } from '../src/vendor/anthropic-market.mjs';
import { createMonitorStore, MONITOR_FILE, type MonitorStore } from '../src/monitor/store.ts';
import { FUNDING_GAP_LOOKBACK_MS, FUNDING_GAP_RETRY_MS, FUNDING_RETENTION_DAYS, FUNDING_STALE_MS, createFundingHistory } from '../src/monitor/funding.ts';
import { OIL_FUNDING_KEY, createOilMonitor } from '../src/monitor/oil.ts';
import { HYNIX_FUNDING_KEY, HYNIX_FUNDING_SPAN_MS, createHynixMonitor } from '../src/monitor/hynix.ts';
import { parseServiceConfig } from '../src/service/config.ts';
import { monitorStatus, monitorViews, openMonitor } from '../src/service/monitor.ts';
import { createExecutorServer } from '../src/http.ts';
import { FUNDING_RETENTION_DAYS as PAGE_RETENTION_DAYS, fundingEnd, fundingFirst, hynixFunding, oilFunding } from '../web/src/monitor-funding.ts';
import { createHarness } from './harness.ts';
import { fakeAnthropicVenues, fakeSettledRate } from './monitor-fake.ts';

const HOUR = 3_600_000, DAY = 86_400_000, FOUR = 4 * HOUR;
const START = Date.UTC(2026, 10, 13, 8, 7);
const close = (actual: number | null, expected: number) => assert.ok(actual !== null && Math.abs(actual - expected) < 1e-12, `${actual} ≈ ${expected}`);
const plain = <T extends object>(rows: readonly T[]) => rows.map(row => ({ ...row }));

function fundingEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'tp-monitor-funding-'));
  const env = { clock: START, logs: [] as string[] };
  const venues = fakeAnthropicVenues({ now: () => env.clock });
  const store = createMonitorStore({ file: join(dir, MONITOR_FILE), now: () => env.clock });
  const gate = createBinanceGate();
  // Where each settlement read started, per leg.
  const starts: Record<string, number[]> = { brent: [], wti: [], skhy: [], skhx: [] };
  const fetchImpl = async (href: string, init: RequestInit) => {
    const url = new URL(href);
    if (url.pathname === '/fapi/v1/fundingRate') starts[url.searchParams.get('symbol') === 'BZUSDT' ? 'brent' : 'wti']!.push(Number(url.searchParams.get('startTime')));
    if (url.hostname === 'api.hyperliquid.xyz') {
      const body = JSON.parse(String(init.body)) as { type: string; coin?: string; startTime?: number };
      if (body.type === 'fundingHistory') starts[body.coin === 'xyz:SKHY' ? 'skhy' : 'skhx']!.push(body.startTime!);
    }
    return venues.fetch(href, init);
  };
  const options = (over: { store?: MonitorStore }) => ({ store: over.store ?? store, fetchImpl, now: () => env.clock, log: (line: string) => env.logs.push(line) });
  const oil = (over: { store?: MonitorStore } = {}) => createOilMonitor({ ...options(over), gate });
  const hynix = (over: { store?: MonitorStore } = {}) => createHynixMonitor(options(over));
  const clear = () => { for (const list of Object.values(starts)) list.length = 0; };
  return Object.assign(env, { dir, venues, store, gate, starts, oil, hynix, clear, dispose: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } });
}

test('结算配对：原油只收 4 小时整点后 60 秒内的常规结算，重复、越界、Special 拒收，未到时刻的跳过；海力士按整点归并，同一小时两个费率拒收', () => {
  const t = OIL_FIRST_SETTLEMENT + 10 * FOUR;
  const row = (symbol: string, fundingTime: number, fundingRate = '0.0001', extra = {}) => ({ symbol, fundingTime, fundingRate, ...extra });
  assert.deepEqual(pairOilFunding([row('BZUSDT', t + 5), row('BZUSDT', t + FOUR + 3)], [row('CLUSDT', t + 9, '-0.0002', { rateType: 'Regular' })], t + FOUR + 10),
    [{ time: t, brent: 0.0001, wti: -0.0002 }, { time: t + FOUR, brent: 0.0001, wti: null }]);
  assert.deepEqual(pairOilFunding([row('BZUSDT', t + 5), row('BZUSDT', t + FOUR + 3)], [], t + 100), [{ time: t, brent: 0.0001, wti: null }], '未到时刻的结算不收');
  for (const [brent, why] of [
    [[row('BZUSDT', t + 60_000)], '偏离整点 60 秒'], [[row('BZUSDT', t + 5, '0.0001', { rateType: 'Special' })], '非常规结算'],
    [[row('BZUSDT', t + 5), row('BZUSDT', t + 9)], '同一结算两次'], [[row('CLUSDT', t + 5)], '合约不符'], [[row('BZUSDT', t + 5, '1.5')], '费率超过 100%'],
    [[row('BZUSDT', OIL_FIRST_SETTLEMENT - FOUR + 5)], '首个结算之前'],
  ] as const) assert.throws(() => pairOilFunding(brent, [], t + DAY), /Binance funding/, why);

  const h = HYNIX_FIRST_SETTLEMENT + 5 * HOUR;
  const record = (coin: string, time: number, fundingRate = '0.00001') => ({ coin, time, fundingRate, premium: '0' });
  assert.deepEqual(pairHynixFunding([record('xyz:SKHY', h + 3), record('xyz:SKHY', HYNIX_FIRST_SETTLEMENT - HOUR)], [record('xyz:SKHX', h + 40, '-0.00002')], h + DAY),
    [{ time: h, adr: 0.00001, ordinary: -0.00002 }], '首个结算之前的记录跳过');
  assert.throws(() => pairHynixFunding([record('xyz:SKHY', h + 3), record('xyz:SKHY', h + 900, '0.00002')], [], h + DAY), /Conflicting/);
  assert.throws(() => pairHynixFunding([record('xyz:SKHX', h)], [], h + DAY), /Unexpected/);
});

test('续读起点与合并：没有记录从首个结算读起（不早于保留期）；平时从最后一次结算前 48 小时；整轮补读从最早的缺口或单腿结算；新读到的空腿不覆盖已存费率', () => {
  const t = OIL_FIRST_SETTLEMENT + 100 * FOUR, legs = ['brent', 'wti'] as const;
  const options = { first: OIL_FIRST_SETTLEMENT, intervalMs: FOUR, legs, cutoff: 0, full: false };
  assert.equal(fundingStart([], options), OIL_FIRST_SETTLEMENT);
  assert.equal(fundingStart([], { ...options, cutoff: t }), t, '保留期晚于首个结算');
  const rows = [0, 1, 3, 4, 20].map(i => ({ time: t + i * FOUR, brent: 0.0001, wti: i === 4 ? null : 0.0002 }));
  assert.equal(fundingStart(rows, options), t + 20 * FOUR - FUNDING_RESUME_MS);
  assert.equal(fundingStart(rows, { ...options, full: true }), t + 2 * FOUR, '整轮补读：缺口在第 2 次结算');
  assert.equal(fundingStart(rows.filter(row => row.time !== t + 3 * FOUR).slice(2), { ...options, full: true }), t + 4 * FOUR, '整轮补读：单腿结算');
  assert.equal(fundingStart(rows.slice(-1), { ...options, full: true }), t + 20 * FOUR - FUNDING_RESUME_MS, '没有缺口时与平时相同');
  const stored: OilFundingRow[] = [{ time: t, brent: 0.0001, wti: 0.0002 }], fetched: OilFundingRow[] = [{ time: t, brent: null, wti: 0.0003 }, { time: t - FOUR, brent: 0.0004, wti: null }];
  assert.deepEqual(mergeFundingRows(stored, fetched, legs),
    [{ time: t - FOUR, brent: 0.0004, wti: null }, { time: t, brent: 0.0001, wti: 0.0003 }]);
});

test('区间计算（手算）：净费率 = (A − B) ÷ 2，小时费率再除结算间隔；累计直接相加，年化 = 累计 ÷ (有效次数 × 间隔小时) × 8760；缺口与单腿结算断开不补零', () => {
  const t = OIL_FIRST_SETTLEMENT;
  const rows = [{ time: t, adr: 0.0005, ordinary: 0.0001 }, { time: t + FOUR, adr: 0.0002, ordinary: 0 }, { time: t + 3 * FOUR, adr: 0.0002, ordinary: null }];
  const result = analyzeSettledFunding(rows, null, t + 3 * FOUR + 5, { intervalMs: FOUR, firstSettlement: t });
  assert.deepEqual([result.count, result.expectedHours, result.missingHours, result.firstTime, result.lastTime], [2, 4, 2, t, t + 3 * FOUR]);
  close(result.shortCumulative, 0.0003);
  close(result.shortAnnualized, 0.0003 / (2 * 4) * 8760);
  close(result.longAnnualized, -0.0003 / (2 * 4) * 8760);
  close(result.latestShortRate, 0.0001 / 4);
  assert.deepEqual(result.chart.map(point => point.time), [t, t + FOUR, t + 2 * FOUR, t + 3 * FOUR]);
  close(result.chart[0]!.shortRate, 0.0002 / 4);
  assert.deepEqual([result.chart[2]!.shortRate, result.chart[3]!.shortRate, result.chart[3]!.shortCumulative], [null, null, null], '缺口与单腿处断开');
  // 1 day of four-hour settlements = 6 settlements, ending at the last one.
  const day = analyzeSettledFunding(rows, 1, t + 7 * FOUR, { intervalMs: FOUR, firstSettlement: t });
  assert.deepEqual([day.firstTime, day.expectedHours, day.count], [t + 2 * FOUR, 6, 0]);
});

test('采集：原油首轮从首个结算回补（替身上市 30 天）、海力士分页读完；存入 monitor.sqlite；超过约 3 轮未更新标为快照；重启读回为快照，之后只从最后 48 小时读起', async () => {
  const env = fundingEnv();
  try {
    const oil = env.oil(), hynix = env.hynix();
    assert.deepEqual([oil.funding(), hynix.funding()], [null, null]);
    await oil.refreshFunding();
    // Hynix reads 60 days a round from its first settlement: the first segment lies before the stand-in listing (30 days
    // ago) and holds nothing, the second reaches into it but not to now (it ends an hour short: records carry milliseconds past the hour, the next segment starts at the bound), the third finishes.
    await hynix.refreshFunding();
    assert.equal(hynix.funding(), null);
    await hynix.refreshFunding();
    assert.deepEqual([hynix.funding()!.complete, hynix.funding()!.rows.at(-1)!.time], [false, HYNIX_FIRST_SETTLEMENT + 2 * HYNIX_FUNDING_SPAN_MS - HOUR]);
    await hynix.refreshFunding();
    assert.deepEqual([env.starts.brent, env.starts.wti], [[OIL_FIRST_SETTLEMENT], [OIL_FIRST_SETTLEMENT]]);
    const firstOil = Math.ceil((START - 30 * DAY) / FOUR) * FOUR, lastOil = Math.floor(START / FOUR) * FOUR;
    const view = oil.funding()!;
    assert.deepEqual([view.status, view.intervalHours, view.rows[0]!.time, view.rows.at(-1)!.time, view.rows.length, view.lastError], ['live', 4, firstOil, lastOil, (lastOil - firstOil) / FOUR + 1, null]);
    assert.deepEqual(view.rows[0], { time: firstOil, brent: fakeSettledRate('brent', firstOil), wti: fakeSettledRate('wti', firstOil) });
    assert.deepEqual(view.coverage, { firstSettlement: new Date(firstOil).toISOString(), lastSettlement: new Date(lastOil).toISOString(), rows: view.rows.length, pairedRows: view.rows.length });
    assert.deepEqual(plain(env.store.oilFunding()), plain(view.rows));

    // Hyperliquid answers 500 settlements a call and a read ends on an empty page: 1 call for the empty segment, 3 for the
    // ~580 hours of the second, 2 for the rest.
    const firstHynix = Math.ceil((START - 30 * DAY) / HOUR) * HOUR + HOUR, lastHynix = Math.floor(START / HOUR) * HOUR;
    const hourly = hynix.funding()!;
    assert.deepEqual([hourly.status, hourly.intervalHours, hourly.complete, hourly.rows[0]!.time, hourly.rows.at(-1)!.time, hourly.rows.length], ['live', 1, true, firstHynix, lastHynix, (lastHynix - firstHynix) / HOUR + 1]);
    assert.deepEqual([env.starts.skhy.length, env.venues.requests.get('settled:skhx')], [6, 6]);
    assert.deepEqual([env.starts.skhy[0], env.starts.skhy[1], env.starts.skhy[4]], [HYNIX_FIRST_SETTLEMENT, HYNIX_FIRST_SETTLEMENT + HYNIX_FUNDING_SPAN_MS, HYNIX_FIRST_SETTLEMENT + 2 * HYNIX_FUNDING_SPAN_MS]);
    assert.deepEqual(plain(env.store.hynixFunding()), plain(hourly.rows));
    assert.deepEqual([monitorStatusLike(oil.status()), monitorStatusLike(hynix.status())], [[view.rows.length, null], [hourly.rows.length, null]]);

    env.clock += FUNDING_STALE_MS + 1;
    assert.deepEqual([oil.funding()!.status, hynix.funding()!.status], ['snapshot', 'snapshot']);
    const again = env.oil();
    assert.deepEqual([again.funding()!.status, again.funding()!.rows.length], ['snapshot', view.rows.length]);
    env.clear();
    env.clock += FOUR;
    await again.refreshFunding();
    assert.deepEqual(env.starts.brent, [lastOil - FUNDING_RESUME_MS], '没有缺口：整轮补读也只从最后 48 小时读起');
    assert.deepEqual([again.funding()!.status, again.funding()!.rows.length], ['live', view.rows.length + 1]);
  } finally { env.dispose(); }
});
const monitorStatusLike = (status: { fundingRows: number; fundingError: string | null }) => [status.fundingRows, status.fundingError];

test('缺口：一腿缺的结算保留为单腿、计入缺失；只在启动后第一轮和之后每小时一轮从那里补读，补到后配齐', async () => {
  const env = fundingEnv();
  try {
    // Older than the two days every round reads again.
    const gap = Math.floor(START / FOUR) * FOUR - 20 * FOUR;
    env.venues.settledMissing.add(`wti:${gap}`);
    const oil = env.oil();
    await oil.refreshFunding();
    const view = oil.funding()!;
    assert.deepEqual(view.rows.find(row => row.time === gap), { time: gap, brent: fakeSettledRate('brent', gap), wti: null });
    assert.equal(view.coverage.pairedRows, view.rows.length - 1);
    env.clear();
    env.clock += 5 * 60_000;
    await oil.refreshFunding();
    const last = oil.funding()!.rows.at(-1)!.time;
    assert.deepEqual(env.starts.wti, [last - FUNDING_RESUME_MS], '一小时内只续读最后 48 小时');
    env.venues.settledMissing.clear();
    env.clear();
    env.clock = START + FUNDING_GAP_RETRY_MS;
    await oil.refreshFunding();
    assert.deepEqual(env.starts.wti, [gap], '每小时一轮从单腿结算处补读');
    assert.deepEqual([oil.funding()!.coverage.pairedRows, oil.funding()!.rows.find(row => row.time === gap)!.wti], [oil.funding()!.rows.length, fakeSettledRate('wti', gap)]);
  } finally { env.dispose(); }
});

test('失败：读取失败保留已存记录并说明原因（日志只记一次、恢复记一次）；Binance 429 进入冷却；写入失败内存不前进、下一轮补写；读回失败下一轮整表重写', async () => {
  const env = fundingEnv();
  try {
    const oil = env.oil(), hynix = env.hynix();
    await oil.refreshFunding();
    const kept = oil.funding()!.rows.length;
    env.venues.down.add('settled');
    env.clock += 5 * 60_000;
    await oil.refreshFunding();
    await oil.refreshFunding();
    await hynix.refreshFunding();
    assert.deepEqual([oil.funding()!.status, oil.funding()!.rows.length, oil.funding()!.lastError], ['snapshot', kept, '资金费读取失败：接口返回 HTTP 500']);
    assert.equal(hynix.funding(), null);
    assert.equal(hynix.status().fundingError, '资金费读取失败：接口返回 HTTP 500');
    assert.equal(env.logs.filter(line => line.startsWith('原油资金费读取失败')).length, 1);
    env.venues.down.delete('settled');
    await oil.refreshFunding();
    assert.deepEqual([oil.funding()!.status, env.logs.filter(line => line === '原油资金费读取已恢复').length], ['live', 1]);

    env.venues.oilStatus = 429;
    await oil.refreshFunding();
    env.venues.oilStatus = null;
    await oil.refreshFunding();
    assert.equal(oil.funding()!.lastError, '资金费读取失败：接口限流冷却中（HTTP 429）');
    env.clock = env.gate.until;

    // A failed write leaves memory with what is stored; the next round writes the same settlement again.
    const write = env.store.writeOilFunding;
    env.store.writeOilFunding = () => { throw new Error('disk full'); };
    env.clock += FOUR;
    await oil.refreshFunding();
    assert.deepEqual([oil.funding()!.rows.length, oil.funding()!.lastError], [kept, '资金费保存失败：monitor.sqlite 写入失败']);
    env.store.writeOilFunding = write;
    await oil.refreshFunding();
    assert.deepEqual([oil.funding()!.rows.length, env.store.oilFunding().length, oil.funding()!.lastError], [kept + 1, kept + 1, null]);

    // The round record is gone: the history cannot be trusted, so the next round rewrites the table.
    env.store.writeState(OIL_FUNDING_KEY, { other: 1 });
    env.store.writeOilFunding({ rows: [{ time: OIL_FIRST_SETTLEMENT, brent: 0.5, wti: 0.5 }], cutoff: 0 });
    const reopened = env.oil();
    assert.equal(reopened.funding(), null);
    assert.ok(env.logs.some(line => line.startsWith('原油资金费历史无法读回，将重新回补')));
    await reopened.refreshFunding();
    assert.deepEqual([env.store.oilFunding().length, env.store.oilFunding()[0]!.time === OIL_FIRST_SETTLEMENT], [kept + 1, false]);
    assert.equal(env.store.readState(HYNIX_FUNDING_KEY), null);
  } finally { env.dispose(); }
});

test('分段回补与缺口范围：一轮最多读 spanMs（海力士 60 天），分几轮续读完，未读完时标未完成；每小时整轮只补读最近 7 天内的缺口', async () => {
  const H = HOUR, first = Date.UTC(2026, 0, 1);
  let clock = first + 100 * DAY + 30 * 60_000;
  const calls: [number, number][] = [], missing = new Set<number>();
  let stored: { time: number; a: number | null; b: number | null }[] = [], state: unknown = null;
  const history = createFundingHistory<{ time: number; a: number | null; b: number | null }>({
    name: '测试', key: 'test.funding', legs: ['a', 'b'], first, intervalMs: H, spanMs: 30 * DAY,
    read: () => stored, readState: () => state,
    write: ({ rows, replace, state: next }) => { const map = new Map((replace ? [] : stored).map(row => [row.time, row])); for (const row of rows) map.set(row.time, row); stored = [...map.values()].sort((x, y) => x.time - y.time); state = next?.value; return rows.length; },
    validate: rows => rows as { time: number; a: number | null; b: number | null }[],
    fetch: async (start, end) => {
      calls.push([start, end]);
      const rows = [];
      for (let time = Math.ceil(start / H) * H; time <= end; time += H) rows.push({ time, a: 0.0001, b: missing.has(time) ? null : 0.0002 });
      return rows;
    },
    reason: () => '失败', aborted: () => false, now: () => clock, log: () => undefined,
  });
  await history.refresh();
  assert.deepEqual(calls, [[first, first + 30 * DAY]]);
  assert.deepEqual([history.view()!.complete, history.view()!.rows.at(-1)!.time], [false, first + 30 * DAY]);
  for (let round = 0; round < 3; round++) { clock += 5 * 60_000; await history.refresh(); }
  assert.deepEqual(calls.slice(1).map(([start]) => start), [first + 30 * DAY, first + 60 * DAY, first + 90 * DAY]);
  assert.deepEqual([history.view()!.complete, history.view()!.rows.at(-1)!.time, history.view()!.rows.length], [true, Math.floor(clock / H) * H, (Math.floor(clock / H) * H - first) / H + 1]);

  // A gap older than seven days stays: the hourly round no longer reads from it; a recent one is read again.
  const old = first + 10 * DAY, recent = Math.floor(clock / H) * H - 3 * DAY;
  stored = stored.map(row => row.time === old || row.time === recent ? { ...row, b: null } : row);
  const reopened = createFundingHistory({ ...({} as Parameters<typeof createFundingHistory>[0]), name: '测试', key: 'test.funding', legs: ['a', 'b'], first, intervalMs: H, spanMs: 30 * DAY,
    read: () => stored, readState: () => state, write: () => 0, validate: rows => rows as never, fetch: async (start: number, end: number) => { calls.push([start, end]); return []; },
    reason: () => '失败', aborted: () => false, now: () => clock, log: () => undefined });
  calls.length = 0;
  await reopened.refresh();
  assert.ok(old < clock - FUNDING_GAP_LOOKBACK_MS && recent > clock - FUNDING_GAP_LOOKBACK_MS);
  assert.deepEqual(calls, [[recent, Math.min(clock, recent + 30 * DAY)]]);
  assert.equal(HYNIX_FUNDING_SPAN_MS, 60 * DAY);
});

test('接口与页面规则：只配海力士时原油资金费 404；回补前 503，之后 200；页面按同一规则校验并把布伦特 / WTI 映射到 A / B 两腿', async () => {
  const secretsFile = '/etc/tp/secrets.json';
  const config = parseServiceConfig({ secretsFile, monitor: { hynix: {} } });
  const dir = mkdtempSync(join(tmpdir(), 'tp-monitor-funding-http-'));
  const venues = fakeAnthropicVenues();
  const runtime = openMonitor(config.monitor!, dir, { fetchImpl: venues.fetch, log: () => undefined });
  const h = createHarness();
  const server = createExecutorServer({ executor: h.ex, accessToken: 'monitor-token-0004', views: { monitor: monitorViews(runtime) } });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const cookie = ((await fetch(`${base}/login?token=monitor-token-0004`, { redirect: 'manual' })).headers.get('set-cookie') ?? '').split(';')[0]!;
    const get = async (path: string) => { const response = await fetch(base + path, { headers: { cookie } }); return { status: response.status, body: await response.json() as Record<string, any> }; };
    assert.equal((await fetch(`${base}/api/monitor/hynix/funding`)).status, 401);
    assert.deepEqual([(await get('/api/monitor/oil/funding')).status, (await get('/api/monitor/oil/funding')).body.message], [404, '本服务没有配置原油行情监控']);
    assert.deepEqual(await get('/api/monitor/hynix/funding'), { status: 503, body: { code: 'not_ready', message: '尚未取得海力士历史资金费，后台正在回补' } });
    // A first round that failed says why instead of loading forever.
    venues.down.add('settled');
    await runtime.hynix!.refreshFunding();
    assert.deepEqual(await get('/api/monitor/hynix/funding'), { status: 503, body: { code: 'funding_unavailable', message: '尚未取得海力士历史资金费（资金费读取失败：接口返回 HTTP 500），下一轮自动重试' } });
    venues.down.delete('settled');
    // Three 60-day segments from the first settlement reach now; the first lies before the stand-in listing.
    for (let round = 0; round < 3; round++) await runtime.hynix!.refreshFunding();
    const answer = await get('/api/monitor/hynix/funding');
    assert.deepEqual([answer.status, answer.body.status, answer.body.intervalHours, answer.body.complete], [200, 'live', 1, true]);
    const page = hynixFunding(answer.body);
    assert.deepEqual([page.rows.length, page.status, page.lastError], [answer.body.rows.length, 'live', null]);
    assert.equal(fundingEnd(page, 'hynix'), page.rows.at(-1)!.time);
    assert.deepEqual([monitorStatus(runtime).hynix!.fundingRows, monitorStatus(runtime).oil], [page.rows.length, null]);
  } finally {
    await new Promise(resolve => server.close(resolve));
    h.dispose();
    runtime.store.close();
    rmSync(dir, { recursive: true, force: true });
  }

  const t = OIL_FIRST_SETTLEMENT + FOUR, fetchedAt = new Date(t + HOUR).toISOString();
  assert.deepEqual(oilFunding({ rows: [{ time: t, brent: 0.0002, wti: null }], fetchedAt, status: 'snapshot', lastError: '资金费读取失败：请求超时' }),
    { rows: [{ time: t, adr: 0.0002, ordinary: null }], fetchedAt, status: 'snapshot', complete: true, lastError: '资金费读取失败：请求超时' });
  for (const [rows, why] of [
    [[{ time: t + HOUR, brent: 0.1, wti: 0.1 }], '不在 4 小时网格'], [[{ time: t, brent: null, wti: null }], '两腿都空'], [[{ time: t, brent: 2, wti: 0 }], '费率超过 100%'],
    [[{ time: t + FOUR, brent: 0, wti: 0 }], '晚于获取时间'], [[{ time: t, brent: 0, wti: 0 }, { time: t, brent: 0, wti: 0 }], '重复'],
  ] as const) assert.throws(() => oilFunding({ rows, fetchedAt, status: 'live' }), /Binance settlement/, why);
  assert.throws(() => oilFunding({ rows: [] }), /Invalid funding answer/);
  // Settlements get a minute to arrive: at 00:00:30 the 00:00 settlement is not expected yet.
  const settled = { rows: [{ time: t, adr: 0, ordinary: 0 }], fetchedAt: new Date(t + 2 * FOUR + 30_000).toISOString(), status: 'live' as const, complete: true, lastError: null };
  assert.equal(fundingEnd(settled, 'oil'), t + FOUR);
  // A backfill still reading on ends at its last row instead of counting the rest as missing.
  assert.equal(fundingEnd({ ...settled, complete: false }, 'oil'), t);
  // 「全部」starts at the first settlement until the 400-day retention cuts it, then at the oldest kept settlement.
  assert.equal(PAGE_RETENTION_DAYS, FUNDING_RETENTION_DAYS);
  assert.equal(fundingFirst(settled, 'oil'), OIL_FIRST_SETTLEMENT);
  const later = { ...settled, fetchedAt: new Date(OIL_FIRST_SETTLEMENT + 500 * DAY + 1).toISOString() };
  assert.equal(fundingFirst(later, 'oil'), OIL_FIRST_SETTLEMENT + 100 * DAY + FOUR);
  assert.equal(fundingFirst(null, 'hynix'), HYNIX_FIRST_SETTLEMENT);
  assert.equal(fundingEnd(null, 'oil'), OIL_FIRST_SETTLEMENT - FOUR);
  assert.deepEqual(validateOilFundingRows([], fetchedAt), []);
});
