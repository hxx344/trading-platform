// DEX 价差下单路径上的读库与页面读数（docs/dexspread.md 第 20 节）：基线预热与自动配置按间隔逐条定位着读、结果与逐条全读相同；
// 后台循环在跑时页面不现读库预热；判断持续出错时不反复重建基线；总览的「为什么没开仓」、实盘页的持仓估值与分组汇总。
// 行情、下单与账户全是替身，库是临时目录里的真实 SQLite；不连任何外部服务。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TRACKER_REBUILD_MS, SETTINGS_KEY, createVarLighterEngine } from '../src/varlighter/engine.ts';
import type { SocketLike } from '../src/varlighter/feeds.ts';
import { LIVE_SETTINGS_KEY, createLiveTrader, type LivePosition } from '../src/varlighter/live.ts';
import { createLiveSummary, summaryRowOf } from '../src/varlighter/live-summary.ts';
import { createLiveKeysStore } from '../src/varlighter/livekeys.ts';
import { regimeOf, regimesOf, type BaselinePoint, type Sample } from '../src/varlighter/model.ts';
import { BaselineTracker, LIVE_BASELINE_GAP_MS } from '../src/varlighter/stats.ts';
import { openVarLighterStore } from '../src/varlighter/store.ts';
import { DEFAULT_GLOBAL, DEFAULT_SYMBOL, LOSS_BLOCK, type GlobalParams, type SymbolParams } from '../src/varlighter/strategy.ts';

const T0 = Date.parse('2026-11-23T15:00:00Z'); // 周一纽约 10:00（盘中）
const DAY = 86_400_000;
const VAR_BTC = 'var:BTC|rh:BTC', LIVE_BTC = 'rh:BTC|lighter:BTC', LIVE_ETH = 'rh:ETH|lighter:ETH';
const venueOf = (url: string) => url.includes('hyperliquid') ? 'entropy' : url.includes('mainnet') ? 'lighter' : 'rh';

function sample(symbol: string, t: number, aMid: number, bMid = 100, extra: Partial<Sample> = {}): Sample {
  return {
    symbol, t, receivedAt: t + 1_000, regime: 'all', ratio: 1, captureKind: 'decision', decisionAt: t + 1_000,
    aRxAt: null, bRxAt: t + 1_000, aTkQty: null, bTkQty: null, aTkReceivedAt: null, bTkReceivedAt: null,
    aAt: t, aMark: aMid, aIndex: null, aFunding: 0,
    aBid0: aMid - 0.01, aAsk0: aMid + 0.01, aBid1k: aMid - 0.02, aAsk1k: aMid + 0.02, aBid100k: null, aAsk100k: null,
    aBidRx: null, aAskRx: null, aBidTk: null, aAskTk: null, aTkAt: null,
    bAt: t - 500, bMark: bMid, bIndex: bMid, bFunding: 0,
    bBid0: bMid - 0.01, bAsk0: bMid + 0.01, bBid1k: bMid - 0.02, bAsk1k: bMid + 0.02, bBid100k: null, bAsk100k: null,
    bBidRx: bMid - 0.01, bAskRx: bMid + 0.01, bBidTk: null, bAskTk: null, bTkAt: null, ...extra,
  };
}
const settingsOf = (symbols: Record<string, SymbolParams>, global: GlobalParams, combos: string[]) => ({ revision: 3, global, symbols, confirmed: [], combos, pairs: [] });
const pointOf = (item: BaselinePoint): BaselinePoint => ({ t: item.t, regime: item.regime, ratio: item.ratio, aBid0: item.aBid0, aAsk0: item.aAsk0, bBid0: item.bBid0, bAsk0: item.bAsk0 });
/** 临时目录；closing 登记的收尾（关库、关引擎）先于删目录执行。 */
function tempDir(t: test.TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), 'tp-dex-hotpath-')), closers: (() => void)[] = [];
  t.after(() => { for (const close of closers.reverse()) { try { close(); } catch { /* 已经关过 */ } } rmSync(dir, { recursive: true, force: true }); });
  return { dir, closing: (close: () => void) => { closers.push(close); } };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.({}); }
  push(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
}
const MARKET = { symbol: 'BTC', market_id: 1, market_type: 'perp', status: 'active', size_decimals: 4, price_decimals: 2, min_base_amount: '0.001', min_quote_amount: '10', taker_fee: '0', maker_fee: '0', mark_price: '100' };
const MARKET_ETH = { ...MARKET, symbol: 'ETH', market_id: 2 };
const stats = (mid: number, type = 'update') => ({ type: `${type}/market_stats`, channel: 'market_stats:all', market_stats: { 1: { market_id: 1, best_bid_price: String(mid - 0.01), best_ask_price: String(mid + 0.01), mark_price: String(mid) } } });
const bookOf = (mid: number) => ({ type: 'subscribed/order_book', channel: 'order_book:1', order_book: { code: 0, bids: [{ price: String(mid - 0.01), size: '1000' }], asks: [{ price: String(mid + 0.01), size: '1000' }] } });

test('按间隔逐条定位着读与逐条全读的结果相同：基线预热、自动配置的抽稀、旧表合并', t => {
  const { dir, closing } = tempDir(t), file = path.join(dir, 'varlighter.sqlite');
  let store = openVarLighterStore(file);
  closing(() => store.close());
  // 三小时、5 / 20 / 7 秒交替的不规则间隔，中间停采十分钟；每 37 条里有一条 B 腿报价为 0（基差算不出，不计入基线）。
  const rows: Sample[] = [];
  for (let at = T0 - 3 * 3_600_000, index = 0; at < T0; index++) {
    rows.push(sample(LIVE_BTC, at, 100 + Math.sin(index / 9), index % 37 === 5 ? 0 : 100, { regime: regimeOf('equity', at) }));
    at += [5_000, 20_000, 7_000][index % 3]! + (index === 400 ? 600_000 : 0);
  }
  assert.equal(store.addSamples(rows), rows.length);
  const from = T0 - 2 * 3_600_000, windowMs = 2 * 3_600_000, all = store.samples(LIVE_BTC, from, T0);
  for (const gap of [LIVE_BASELINE_GAP_MS, 0]) {
    const full = new BaselineTracker('equity', windowMs, 10, gap), scanned = new BaselineTracker('equity', windowMs, 10, gap);
    const keptFull = all.filter(item => full.push(item)).map(item => item.t), keptScan: number[] = [];
    let read = 0;
    store.baselineScan(LIVE_BTC, from, T0, gap, point => { read++; const taken = scanned.push(point); if (taken) keptScan.push(point.t); return taken; });
    assert.deepEqual(keptScan, keptFull, `间隔 ${gap}：计入基线的是同一批样本`);
    assert.ok(keptFull.length > 50);
    for (const regime of regimesOf('equity')) assert.deepEqual(scanned.value(regime, T0), full.value(regime, T0), `间隔 ${gap}、时段 ${regime} 的基线相同`);
    if (gap > 0) assert.ok(read < all.length / 3, `按间隔读时不读中间的（读了 ${read} / ${all.length} 条）`);
    else assert.equal(read, all.length);
  }
  let kept = -Infinity;
  const thinned = all.filter(item => item.t - kept >= LIVE_BASELINE_GAP_MS && (kept = item.t, true));
  assert.deepEqual(store.samplesSpaced(LIVE_BTC, from, T0, LIVE_BASELINE_GAP_MS), thinned, '抽稀后的样本与逐条过滤的相同（基差算不出的也照留）');
  assert.deepEqual(store.samplesSpaced(LIVE_BTC, from, T0, LIVE_BASELINE_GAP_MS, 3), thinned.slice(0, 3));
  assert.deepEqual(store.samplesSpaced('rh:NOPE|lighter:NOPE', from, T0, LIVE_BASELINE_GAP_MS), []);
  let none = 0;
  store.baselineScan('rh:NOPE|lighter:NOPE', from, T0, LIVE_BASELINE_GAP_MS, () => { none++; return true; });
  assert.equal(none, 0);

  // v0.87.0 以前的旧表：与新表按时刻合并，同一时刻以新表为准。
  store.close();
  const raw = new DatabaseSync(file);
  try {
    for (const [at, bid] of [[1_000, 99.9], [61_000, 99.8], [90_000, 99.7], [200_000, 99.6]] as const)
      raw.prepare("INSERT INTO samples(symbol, t, received_at, regime, var_mark, var_bid0, var_ask0, var_bid1k, var_ask1k, rh_at, rh_bid0, rh_ask0) VALUES ('rh:BTC', ?, ?, 'all', 100, ?, 100.1, 99.8, 100.2, ?, 99.95, 100.05)").run(at, at + 1_000, bid, at - 100);
  } finally { raw.close(); }
  store = openVarLighterStore(file);
  store.addSamples([sample(VAR_BTC, 61_000, 101), sample(VAR_BTC, 150_000, 102), sample(VAR_BTC, 260_000, 103)]);
  const merged = store.samples(VAR_BTC, 0, 300_000);
  assert.deepEqual(merged.map(item => item.t), [1_000, 61_000, 90_000, 150_000, 200_000, 260_000]);
  for (const gap of [0, 60_000]) {
    const seen: BaselinePoint[] = [];
    store.baselineScan(VAR_BTC, 0, 300_000, gap, point => { seen.push(point); return true; });
    let last = -Infinity;
    const expected = merged.filter(item => item.t - last >= gap && (last = item.t, true));
    assert.deepEqual(seen, expected.map(pointOf), `旧表合并，间隔 ${gap}`);
    assert.deepEqual(store.samplesSpaced(VAR_BTC, 0, 300_000, Math.max(1, gap)), gap ? expected : merged);
  }
});

const closedLive = (id: string, symbol: string, closedAt: number, extra: { reason: string; qty?: number; netUsd?: number; singleLeg?: boolean; note?: string; orders?: LivePosition['orders'] }): LivePosition => {
  const qty = extra.qty ?? 0;
  const leg = (venue: 'rh' | 'lighter', side: 'buy' | 'sell', filled: number) => ({ venue, symbol: 'BTC', side, qty: filled, entryQuote: filled * 100, exitQty: filled, exitQuote: filled * 100, feesUsd: 0, estimated: false });
  return { id, symbol, direction: 'a_rich', ratio: 1, state: 'closed', step: 'settle', openedAt: closedAt - 60_000, updatedAt: closedAt, closedAt,
    a: leg('rh', 'sell', qty), b: leg('lighter', 'buy', extra.singleLeg ? 0 : qty), plan: { qty: 1, limit: 100 }, pending: null, tries: 0, retryAt: 0,
    closeReason: extra.reason, singleLeg: extra.singleLeg ?? false, netUsd: extra.netUsd ?? 0, note: extra.note ?? '', ...(extra.orders && { orders: extra.orders }) };
};

test('实盘页的汇总：启动时读一次的分组与逐笔累加一致；没成交的再多也挤不掉有成交的；页面读数不再每次扫全表', t => {
  const { dir, closing } = tempDir(t), store = openVarLighterStore(path.join(dir, 'varlighter.sqlite'));
  closing(() => store.close());
  const other = 'rh:ETH|lighter:ETH';
  const positions = [
    closedLive('t1', LIVE_BTC, T0 - DAY - 5_000, { reason: 'revert', qty: 1, netUsd: 1.5 }),
    closedLive('t2', LIVE_BTC, T0 - 9_000_000, { reason: 'stop', qty: 1, netUsd: -0.7 }),
    closedLive('t3', other, T0 - 8_000_000, { reason: 'single_leg', qty: 1, netUsd: -0.2, singleLeg: true }),
    closedLive('d1', other, T0 - 7_000_000, { reason: 'dismissed' }),
    // 第一腿没成交的 60 笔：三分之一是旧版本只留了说明的、三分之一带逐单记录（都发出去过），其余是发单前就放弃的。
    ...Array.from({ length: 60 }, (_, index) => closedLive(`n${index}`, LIVE_BTC, T0 - 6_000_000 + index * 1_000, { reason: 'not_filled',
      ...(index % 3 === 0 ? { note: 'Lighter RH 第一腿没有成交，放弃' } : index % 3 === 1 ? { note: '此刻的卖一已越过限价', orders: [{ role: 'openA' }] as never } : { note: '开仓意图已过期，没有下单' }) })),
  ];
  for (const position of positions) store.saveLive(position);
  const loaded = createLiveSummary(store.liveSummaryRows()), counted = createLiveSummary([]);
  for (const position of positions) counted.add(summaryRowOf(position)!);
  const near = (x: number, y: number) => Math.abs(x - y) < 1e-9;
  for (const summary of [loaded, counted]) {
    const totals = summary.totals(), fromStore = store.liveTotals();
    assert.deepEqual([totals.trades, totals.wins], [fromStore.trades, fromStore.wins]);
    assert.deepEqual([totals.trades, totals.wins], [3, 1]);
    assert.ok(near(totals.netUsd, fromStore.netUsd) && near(totals.netUsd, 0.6));
    assert.deepEqual(summary.outcomes(T0), { today: { traded: 2, notFilled: 60, other: 1, singleLeg: 1, unsent: 20 }, total: { traded: 3, notFilled: 60, other: 1, singleLeg: 1, unsent: 20 } }, '发单前就放弃的 20 笔单独计数');
    assert.deepEqual(summary.outcomes(T0 + 5 * DAY).today, { traded: 0, notFilled: 0, other: 0, singleLeg: 0, unsent: 0 }, '没有记录的日子全是 0');
    const breakdown = summary.breakdown(T0);
    assert.deepEqual(breakdown.byPair.map(row => [row.key, row.trades, row.wins]), [[LIVE_BTC, 2, 1], [other, 1, 0]], '净额绝对值大的在前');
    assert.ok(near(breakdown.byPair[0]!.netUsd, 0.8));
    assert.deepEqual(breakdown.byDay.map(row => [row.key, row.trades]), [['2026-11-23', 2], ['2026-11-22', 1]], '按 UTC 日，新的在前；没成交的不计');
    assert.deepEqual(breakdown.byReason.map(row => row.key).sort(), ['revert', 'single_leg', 'stop']);
    assert.deepEqual(summary.breakdown(T0 + 20 * DAY).byDay, [], '只留最近 14 天');
  }
  assert.equal(summaryRowOf({ ...positions[0]!, closedAt: null }), null);
  assert.ok(store.liveClosed(50).every(position => position.a.qty === 0), '最近 50 笔已结束的全是没成交的');
  assert.deepEqual(store.liveTradedClosed(50).map(position => position.id), ['t3', 't2', 't1']);

  const scans = { totals: t.mock.method(store, 'liveTotals'), rows: t.mock.method(store, 'liveSummaryRows'), closed: t.mock.method(store, 'liveClosed'), traded: t.mock.method(store, 'liveTradedClosed') };
  const live = createLiveTrader({
    store, now: () => T0, log: () => {}, keys: { read: () => ({ keys: {}, problem: null }), view: () => ({ lighter: false, rh: false, entropy: false }), accounts: () => ({}), set() {}, remove() {} },
    trader: () => { throw new Error('不该下单'); }, venueProblem: () => null, pairOf: () => undefined, quote: () => null, takerFeeBps: () => 0, account: () => null,
    readAccount: async () => { throw new Error('不该读账户'); }, signalFor: () => new AbortController().signal,
  });
  for (let round = 0; round < 3; round++) {
    const view = live.view();
    assert.equal(view.trades.length, 50);
    assert.deepEqual(view.tradedMore?.map(position => position.id), ['t3', 't2', 't1'], '排不进最近 50 笔的有成交持仓另外给出');
    assert.deepEqual([view.totals.trades, view.totals.wins, view.outcomes?.total.notFilled, view.breakdown?.byPair.length], [3, 1, 60, 2]);
  }
  assert.deepEqual([scans.totals.mock.callCount(), scans.rows.mock.callCount(), scans.closed.mock.callCount(), scans.traded.mock.callCount()], [0, 1, 1, 1], '汇总启动时读一次，成交列表到下一笔结束前只读一次');

  // 汇总读不出来：不拦实盘启动，页面少结果计数与分组，累计退回读库。
  scans.rows.mock.mockImplementation(() => { throw new Error('malformed JSON'); });
  const logs: string[] = [];
  const degraded = createLiveTrader({
    store, now: () => T0, log: line => { logs.push(line); }, keys: { read: () => ({ keys: {}, problem: null }), view: () => ({ lighter: false, rh: false, entropy: false }), accounts: () => ({}), set() {}, remove() {} },
    trader: () => { throw new Error('不该下单'); }, venueProblem: () => null, pairOf: () => undefined, quote: () => null, takerFeeBps: () => 0, account: () => null,
    readAccount: async () => { throw new Error('不该读账户'); }, signalFor: () => new AbortController().signal,
  });
  const fallback = degraded.view();
  assert.deepEqual([fallback.totals.trades, fallback.outcomes, fallback.breakdown, fallback.trades.length], [3, undefined, undefined, 50]);
  assert.equal(logs.filter(line => line.includes('实盘汇总读取失败')).length, 1);
});

/** withEth：目录里多一个 ETH 市场，两个配对都启用并勾选实盘。 */
function liveFixture(t: test.TestContext, symbol: Partial<SymbolParams>, global: Partial<GlobalParams>, liveOn = true, withEth = false) {
  const { dir, closing } = tempDir(t), store = openVarLighterStore(path.join(dir, 'varlighter.sqlite')), keys = createLiveKeysStore(dir);
  // 假值私钥，不对应任何真实账户。
  keys.set('rh', { accountIndex: 11, apiKeyIndex: 5, privateKey: 'cd'.repeat(40) });
  keys.set('lighter', { accountIndex: 12, apiKeyIndex: 5, privateKey: 'ab'.repeat(40) });
  const traded = withEth ? [LIVE_BTC, LIVE_ETH] : [LIVE_BTC];
  store.setState(SETTINGS_KEY, settingsOf(Object.fromEntries(traded.map(key => [key, { ...DEFAULT_SYMBOL, enabled: true, ...symbol }])), { ...DEFAULT_GLOBAL, minSamples: 10, ...global }, ['rh|lighter']), T0);
  store.addSamples(traded.flatMap(key => Array.from({ length: 12 }, (_, index) => sample(key, T0 - (12 - index) * 60_000, 100))));
  store.setState(LIVE_SETTINGS_KEY, { on: liveOn, pairs: traded, limits: { perTradeUsd: 100, maxOpen: traded.length, dailyLossUsd: 20, slippageBps: 30 } }, T0);
  const state = { clock: T0, placed: [] as string[], logs: [] as string[], signerChecks: 0 };
  const trader = (venue: string) => ({
    async place(order: { side: string; qty: number; limit: number }) { state.placed.push(`${venue} ${order.side}`); return { kind: 'done' as const, filledQty: order.qty, avgPrice: order.limit, note: '替身' }; },
    async resolve() { return { kind: 'absent' as const, reason: '替身' }; },
  });
  const account = (index: number) => ({ code: 200, accounts: [{ account_index: index, collateral: '1000', available_balance: '1000', total_asset_value: '1000', positions: [] }] });
  const sockets = new Map<string, FakeSocket>();
  const engine = createVarLighterEngine({ store, now: () => state.clock, log: line => { state.logs.push(line); },
    fetchImpl: async (url: string) => url.includes('/account?') ? Response.json(account(Number(new URL(url).searchParams.get('value')))) : Response.json({ code: 200, order_book_details: withEth ? [MARKET, MARKET_ETH] : [MARKET] }),
    connect: url => { const socket = new FakeSocket(); sockets.set(venueOf(url), socket); return socket; },
    liveKeys: keys, signerProblem: () => { state.signerChecks++; return null; }, traders: venue => trader(venue) as never });
  closing(() => engine.close());
  const row = () => engine.views.state().rows.find(item => item.key === LIVE_BTC)!;
  return { store, engine, sockets, state, row, async start() {
    engine.startStreams();
    for (const socket of sockets.values()) socket.open();
    for (const venue of ['rh', 'lighter'] as const) await engine.refreshCatalog(new AbortController().signal, venue);
    for (const venue of ['rh', 'lighter']) { sockets.get(venue)!.push(stats(100, 'subscribed')); sockets.get(venue)!.push(bookOf(100)); }
  } };
}

test('总览的「为什么没开仓」与实盘页的持仓估值、分组汇总：被实盘检查挡下、到线放行、持有中、平仓后冷却', async t => {
  const { store, engine, sockets, state, row, start } = liveFixture(t, { notionalUsd: 1000, entryBps: 15, exitBps: 5, cooldownMinutes: 0 }, { minNetBps: 0, slippageBps: 0 });
  const blocker = 'Lighter RH 账户读数不够新';
  await start();
  engine.sampleLive();
  const skipsBefore = engine.views.live().skipStats.total;
  let gate = row().gate!;
  assert.deepEqual([gate.blocker, gate.attention, gate.reached, gate.expectedNetBps, gate.last], [blocker, true, false, null, null], '没到入场线时也先说实盘检查挡着什么；账户读数要人处理');
  assert.ok(gate.deviation !== null && Math.abs(gate.deviation) < 5);
  assert.equal(engine.views.live().skipStats.total, skipsBefore, '总览读数不计入被挡统计');

  // RH 冲高约 100 基点：推送判断到了入场线，被实盘检查挡下。总览读的是定时样本，要到下一条样本才显示已到线。
  state.clock = T0 + 1_000; sockets.get('rh')!.push(bookOf(101));
  gate = row().gate!;
  assert.deepEqual([gate.reached, gate.last], [false, { at: T0 + 1_000, reason: blocker }], '记下最近一次到线没开成的时刻与原因');
  state.clock = T0 + 5_000;
  assert.deepEqual(engine.sampleLive().blocked, { [blocker]: 1 });
  gate = row().gate!;
  assert.deepEqual([gate.blocker, gate.reached, gate.last?.at], [blocker, true, T0 + 5_000]);
  assert.ok(gate.deviation! > 90 && gate.expectedNetBps! > 0, `偏离 ${gate.deviation}、预期净利 ${gate.expectedNetBps}`);
  assert.equal(store.liveActive().length, 0);

  await engine.refreshAccounts(() => AbortSignal.timeout(1000));
  gate = row().gate!;
  assert.deepEqual([gate.blocker, gate.attention, gate.reached], [null, false, true], '账户读到后没有东西挡着');
  state.clock = T0 + 6_000; sockets.get('lighter')!.push(stats(100)); sockets.get('rh')!.push(bookOf(101.02));
  await engine.live()!.idle();
  const [opened] = store.liveActive();
  assert.deepEqual([opened?.state, state.placed], ['open', ['rh sell', 'lighter buy']]);
  assert.equal(row().gate, null, '有持仓的配对不给拦截原因');
  let view = engine.views.live();
  const mark = view.marks![opened!.id]!;
  assert.deepEqual([mark.exitBps, mark.stopBps, mark.maxHoldMinutes, mark.signalSpread, mark.at], [5, DEFAULT_SYMBOL.stopBps, DEFAULT_SYMBOL.maxHoldMinutes, opened!.strategy!.entrySpread, T0 + 6_000]);
  const aEntry = opened!.a.entryQuote / opened!.a.qty, bEntry = opened!.b.entryQuote / opened!.b.qty;
  assert.ok(Math.abs(mark.entrySpread! - (aEntry - bEntry) / bEntry * 1e4) < 1e-9, '入场价差按两腿实际成交均价，与信号价差分开给');
  assert.ok(mark.pnlBps !== null && mark.netUsd !== null && mark.baseline !== null && Math.abs(mark.baseline) < 5 && mark.deviation! > 90, '浮盈、现在的基线与离出场线还差多少');
  assert.deepEqual([view.totals.trades, view.outcomes?.total.traded, view.tradedMore], [0, 0, []]);

  // 价差回到基线：回归平仓，结束后冷却至少一分钟。
  state.clock = T0 + 12_000; sockets.get('lighter')!.push(stats(100)); sockets.get('rh')!.push(bookOf(100));
  await engine.live()!.idle();
  assert.equal(store.liveActive().length, 0);
  view = engine.views.live();
  assert.deepEqual([view.positions.length, view.marks, view.trades[0]?.closeReason], [0, {}, 'revert']);
  assert.deepEqual([view.totals.trades, view.outcomes?.total, view.outcomes?.today.traded], [1, { traded: 1, notFilled: 0, other: 0, singleLeg: 0, unsent: 0 }, 1]);
  assert.deepEqual([view.breakdown?.byPair.map(item => [item.key, item.trades]), view.breakdown?.byReason.map(item => item.key), view.breakdown?.byDay.map(item => item.key)], [[[LIVE_BTC, 1]], ['revert'], ['2026-11-23']]);
  assert.ok(Math.abs(view.totals.netUsd - store.liveTotals().netUsd) < 1e-9 && Math.abs(view.breakdown!.byPair[0]!.netUsd - view.trades[0]!.netUsd!) < 1e-9);
  assert.deepEqual([row().gate?.blocker, row().gate?.attention], ['冷却中', false], '冷却是策略本来就会等的');
});

test('总览的「为什么没开仓」：实盘总开关没开、没启用的配对不给、策略暂停排在前面', async t => {
  const { store, engine, row, start } = liveFixture(t, {}, {}, false);
  await start();
  engine.sampleLive();
  assert.deepEqual([row().gate?.blocker, row().gate?.attention, row().gate?.reached], ['实盘总开关未开', false, false], '用户自己关着的不用处理');
  const saved = engine.views.settings({ revision: 3, symbols: { [LIVE_BTC]: { enabled: false } } });
  assert.equal(row().gate, null, '没启用的配对不给');
  const paused = engine.views.settings({ revision: saved.revision, global: { paused: true }, symbols: { [LIVE_BTC]: { enabled: true } } });
  assert.deepEqual([row().gate?.blocker, row().gate?.attention], ['已暂停', false], '策略风控排在实盘检查前面');

  store.saveLive(closedLive('loss', LIVE_BTC, T0 - 1_000, { reason: 'stop', qty: 1, netUsd: -5 }));
  engine.views.settings({ revision: paused.revision, global: { paused: false, dailyLossLimitUsd: 1 } });
  assert.deepEqual([row().gate?.blocker, row().gate?.attention], [LOSS_BLOCK, true], '当日亏损上限要人处理');
});

test('运行中才打开实盘：之前不预热的配对，第一次开仓判断当场从库里建完整基线', async t => {
  const { store, engine, sockets, state, row, start } = liveFixture(t, { entryBps: 15 }, {}, false);
  const scans = t.mock.method(store, 'baselineScan');
  await start();
  engine.sampleLive();
  state.clock = T0 + 1_000; sockets.get('rh')!.push(bookOf(101));
  assert.equal(scans.mock.callCount(), 0, '实盘没开：采样与推送判断都不读库预热');
  engine.views.liveSettings({ on: true });
  state.clock = T0 + 2_000; sockets.get('rh')!.push(bookOf(101.01));
  assert.equal(scans.mock.callCount(), 1, '打开后的第一次判断当场预热');
  // 到了入场线、被实盘检查挡下：说明这次判断用的是库里的完整基线（样本不足时只会等，不会走到实盘检查）。
  const gate = row().gate!;
  assert.deepEqual(gate.last, { at: T0 + 2_000, reason: 'Lighter RH 账户读数不够新' });
  assert.ok(row().baseline!.samples >= 12, `基线样本 ${row().baseline!.samples}`);
  assert.equal(scans.mock.callCount(), 1, '之后不再读库');
  assert.equal(store.liveActive().length, 0);
});

test('一次总览读数里各配对共用实盘检查的读数：签名器检查每个场所只做一次', async t => {
  const { engine, sockets, state, start } = liveFixture(t, {}, {}, true, true);
  await start();
  for (const socket of sockets.values()) socket.push({ type: 'update/market_stats', channel: 'market_stats:all', market_stats: { 2: { market_id: 2, best_bid_price: '99.99', best_ask_price: '100.01', mark_price: '100' } } });
  engine.sampleLive();
  await engine.refreshAccounts(() => AbortSignal.timeout(1000));
  const before = state.signerChecks;
  const rows = engine.views.state().rows;
  assert.deepEqual(rows.map(item => [item.key, item.gate?.blocker]), [[LIVE_BTC, null], [LIVE_ETH, null]]);
  assert.equal(state.signerChecks - before, 2, '两个配对、RH 与 Lighter 各查一次（不共用时是四次）');
});

test('基线预热排队中改了基线窗口：之后的按新窗口建，已建的作废重排；循环停下时没做完的，之后用到时当场补', async t => {
  const { dir, closing } = tempDir(t), store = openVarLighterStore(path.join(dir, 'varlighter.sqlite'));
  closing(() => store.close());
  store.setState(SETTINGS_KEY, settingsOf({}, { ...DEFAULT_GLOBAL, minSamples: 10, windowHours: 24 }, ['rh|lighter']), T0);
  store.addSamples([LIVE_BTC, LIVE_ETH].flatMap(key => Array.from({ length: 12 }, (_, index) => sample(key, T0 - (12 - index) * 60_000 - 5_000, 100))));
  const scan = store.baselineScan, built: [string, number][] = [];
  let afterScan: (() => void) | null = null;
  const scans = t.mock.method(store, 'baselineScan', (...args: Parameters<typeof scan>) => {
    built.push([args[0], (args[2] - args[1]) / 3_600_000]);
    scan(...args);
    // 读库是同步的，设置只可能在两个配对之间（预热让出事件循环时）被改：用微任务插到那里。
    const hook = afterScan; afterScan = null;
    if (hook) queueMicrotask(hook);
  });
  const engine = createVarLighterEngine({ store, now: () => T0, log: () => {}, connect: () => new FakeSocket(),
    fetchImpl: async () => Response.json({ code: 200, order_book_details: [MARKET, MARKET_ETH] }) });
  let stopped = false;
  const sleepers = new Set<() => void>();
  const context = { stopped: () => stopped, pause: (ms: number) => new Promise<void>(resolve => {
    if (stopped) { resolve(); return; }
    const wake = () => { clearTimeout(timer); sleepers.delete(wake); resolve(); };
    const timer = setTimeout(wake, ms);
    sleepers.add(wake);
  }) };
  const tick = async () => { for (const wake of [...sleepers]) wake(); await settle(); };
  const warming = () => engine.views.state().rows.map(item => [item.baseline?.samples ?? null, item.baselineWarming ?? false]);
  const loop = engine.loop(context);
  let ended = false;
  try {
    await settle();
    assert.deepEqual(warming(), [[null, true], [null, true]], '两个配对都排队预热');
    let revision = 3;
    afterScan = () => { revision = engine.views.settings({ revision, global: { windowHours: 12 } }).revision; };
    await tick();
    assert.deepEqual(built.map(item => item[1]), [24, 12], '第一个按旧窗口建，窗口改了之后第二个按新窗口建');
    assert.deepEqual(warming().map(item => item[1]).sort(), [false, true], '按旧窗口建的那个作废，重新排队');
    await tick();
    assert.deepEqual([built.map(item => item[1]), built[2]![0]], [[24, 12, 12], built[0]![0]], '作废的那个按新窗口重建');
    assert.deepEqual(warming(), [[12, false], [12, false]]);

    // 再改一次窗口，两个都重新排队；这时循环停下：不再预热，也不卡住收尾。
    engine.views.settings({ revision, global: { windowHours: 24 } });
    assert.deepEqual(warming(), [[null, true], [null, true]]);
    stopped = true;
    for (const wake of [...sleepers]) wake();
    await loop;
    ended = true;
    assert.equal(scans.mock.callCount(), 3, '停下后队里没做完的不再读库');
    assert.deepEqual(warming(), [[12, false], [12, false]], '循环不在跑时，用到就当场补');
    assert.deepEqual(built.slice(3).map(item => item[1]), [24, 24]);
  } finally {
    stopped = true;
    for (const wake of [...sleepers]) wake();
    if (!ended) await loop;
    engine.close();
  }
});

test('行情流推送判断持续出错：基线一分钟最多重建一次，不反复读库', async t => {
  const { store, sockets, state, start } = liveFixture(t, { entryBps: 15 }, {});
  const scans = t.mock.method(store, 'baselineScan');
  await start();
  t.mock.method(store, 'liveNetSince', () => { throw new Error('账户风控暂不可读'); });
  // 每次推送都到入场线、都在读当日已实现时出错。
  const spike = (at: number, mid: number) => { state.clock = at; sockets.get('lighter')!.push(stats(100)); sockets.get('rh')!.push(bookOf(mid)); };
  for (let index = 1; index <= 20; index++) spike(T0 + index * 1_000, 101 + index / 100);
  assert.equal(scans.mock.callCount(), 2, '首次预热一次，出错后重建一次，之后一分钟内不再重建');
  assert.equal(state.logs.filter(line => line.includes('按行情流推送判断')).length, 1);
  spike(T0 + 1_000 + TRACKER_REBUILD_MS, 102);
  spike(T0 + 2_000 + TRACKER_REBUILD_MS, 102.1);
  assert.equal(scans.mock.callCount(), 3, '过了一分钟仍出错才再重建一次');
  assert.equal(store.liveActive().length, 0);
});

test('基线预热：不会开仓的配对采样时不预热；后台循环在跑时页面不现读库，先标预热中，循环分批补上', async t => {
  const { dir } = tempDir(t), file = path.join(dir, 'varlighter.sqlite');
  const seed = () => {
    const store = openVarLighterStore(file);
    store.setState(SETTINGS_KEY, settingsOf({}, { ...DEFAULT_GLOBAL, minSamples: 10 }, ['var|rh', 'rh|lighter']), T0);
    store.addSamples([VAR_BTC, LIVE_BTC].flatMap(key => Array.from({ length: 12 }, (_, index) => sample(key, T0 - (12 - index) * 60_000 - 5_000, 100))));
    return store;
  };
  const fetchImpl = async (url: string) => url.includes('orderBookDetails') ? Response.json({ code: 200, order_book_details: [MARKET] })
    : Response.json({ listings: [{ ticker: 'BTC', name: 'Bitcoin', mark_price: '100.2', quotes: { updated_at: new Date(T0 - 2_000).toISOString(), base: { bid: '100.19', ask: '100.21' }, size_1k: { bid: '100.18', ask: '100.22' }, size_100k: { bid: '100.1', ask: '100.3' } } }] });
  let clock = T0 - 3_000;
  const boot = (store: ReturnType<typeof openVarLighterStore>) => {
    const sockets = new Map<string, FakeSocket>();
    const engine = createVarLighterEngine({ store, fetchImpl, now: () => clock, log: () => {}, connect: url => { const socket = new FakeSocket(); sockets.set(venueOf(url), socket); return socket; } });
    return { engine, sockets, feed() { for (const venue of ['rh', 'lighter']) { sockets.get(venue)!.open(); sockets.get(venue)!.push(stats(100, 'subscribed')); } } };
  };

  // 不跑后台循环（测试与工具直接调用）：采样不预热，页面用到时当场预热。
  const first = seed(), scans = t.mock.method(first, 'baselineScan'), direct = boot(first);
  try {
    direct.engine.startStreams(); direct.feed();
    for (const venue of ['rh', 'lighter'] as const) await direct.engine.refreshCatalog(AbortSignal.timeout(1000), venue);
    clock = T0;
    await direct.engine.pollVar(AbortSignal.timeout(1000));
    assert.equal(direct.engine.sampleLive().written, 1);
    assert.equal(scans.mock.callCount(), 0, '没启用、不会开仓的配对写样本时不读库预热基线');
    const rows = direct.engine.views.state().rows;
    assert.deepEqual(rows.map(item => [item.key, item.baseline?.samples, item.baselineWarming, item.gate]).sort(), [[LIVE_BTC, 13, undefined, null], [VAR_BTC, 13, undefined, null]], '预热时把刚写的那条也读进来');
    assert.equal(scans.mock.callCount(), 2);
    direct.engine.views.state();
    assert.equal(scans.mock.callCount(), 2, '预热过的不再读');
  } finally { direct.engine.close(); }

  // 后台循环在跑：页面请求不读库，循环的下一轮分批预热。
  const second = openVarLighterStore(file), loopScans = t.mock.method(second, 'baselineScan'), looped = boot(second);
  let stopped = false;
  const sleepers = new Set<() => void>();
  const context = { stopped: () => stopped, pause: (ms: number) => new Promise<void>(resolve => {
    if (stopped) { resolve(); return; }
    const wake = () => { clearTimeout(timer); sleepers.delete(wake); resolve(); };
    const timer = setTimeout(wake, ms);
    sleepers.add(wake);
  }) };
  const tick = async () => { for (const wake of [...sleepers]) wake(); await settle(); };
  const loop = looped.engine.loop(context);
  try {
    await settle();
    const rows = looped.engine.views.state().rows;
    assert.deepEqual(rows.map(item => [item.key, item.baseline, item.baselineWarming]), [[LIVE_BTC, null, true]], '目录读到后配对已建好，基线标预热中');
    assert.equal(loopScans.mock.callCount(), 0, '页面请求里不读库');
    await tick();
    const warmed = looped.engine.views.state().rows[0]!;
    assert.deepEqual([warmed.baseline?.samples, warmed.baselineWarming, loopScans.mock.callCount()], [13, undefined, 1], '循环的下一轮补上');
  } finally {
    stopped = true;
    for (const wake of [...sleepers]) wake();
    await loop;
    looped.engine.close();
  }
});
