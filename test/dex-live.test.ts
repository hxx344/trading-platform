// DEX 价差实盘的状态机（src/varlighter/live.ts，docs/dexspread.md 第 13 节）的失败场景：零成交、部分成交、单腿回补、结果未知、
// 进程重启、平仓重试、对账、凭据被移除。v0.112.0 起开平仓信号来自策略（prepare / signalClose），不再跟随模拟盘。下单连接器、账户、报价全是替身，库是临时目录里的真实 SQLite；不连任何外部服务。
// 贯穿的要求：结果未知的单不重发（L039、L093）；同一自编号不发两次；同一时刻只有一笔单在途；告警、事件与日志不带账户标识。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { KeyVenue } from '../src/dex/keys.ts';
import type { AccountSnapshot } from '../src/varlighter/accounts.ts';
import { DEFAULT_LIVE_SETTINGS, LIVE_RUNTIME_KEY, LIVE_SETTINGS_KEY, LiveError, SKIP_EVENT_MS, createLiveTrader, type LiveAlert, type LiveLimits, type LivePosition, type LiveSignal, type LiveTrader } from '../src/varlighter/live.ts';
import type { LiveKeys } from '../src/varlighter/livekeys.ts';
import { pairKey, type LegInfo, type PairInfo, type Sample, type VenueId } from '../src/varlighter/model.ts';
import { ORDER_EXPIRY_MS, type OrderOutcome, type ResolveOutcome, type VenueOrder } from '../src/varlighter/orders.ts';
import { openVarLighterStore } from '../src/varlighter/store.ts';
import type { Direction } from '../src/varlighter/strategy.ts';

const T0 = Date.parse('2026-11-27T15:00:00Z');
// 假凭据：编号与地址挑不会偶然出现在别处的值，用来核对输出里不带它们。
const ACCOUNT = 987654, RH_ACCOUNT = 876543, ADDRESS = '0x00000000000000000000000000000000000000ab';
const LIGHTER_KEY = 'ab'.repeat(40), RH_KEY = 'cd'.repeat(40), ENTROPY_KEY = '0x' + '11'.repeat(32);
const ALL_KEYS: LiveKeys = { lighter: { accountIndex: ACCOUNT, apiKeyIndex: 5, privateKey: LIGHTER_KEY }, rh: { accountIndex: RH_ACCOUNT, apiKeyIndex: 6, privateKey: RH_KEY }, entropy: { address: ADDRESS, privateKey: ENTROPY_KEY } };
// live.ts 里没有导出的时限：重试间隔、按账户持仓核对的起点、结果一直不明的上限、对账间隔。
const RETRY_MS = 5_000, UNKNOWN_FIRST_MS = 2_000, CHECK_LIGHTER_MS = 60_000, CHECK_ENTROPY_MS = 20_000, UNKNOWN_STUCK_MS = 15 * 60_000, RECONCILE_MS = 60_000, ACCOUNT_FRESH_MS = 3 * 60_000;

const leg = (venue: VenueId, symbol: string, id: number): LegInfo => ({ venue, symbol, market: { venue, symbol, name: symbol, id, ...(venue === 'entropy' ? { coin: `io:${symbol}` } : {}), mark: 100, index: null, fundingHourly: 0,
  sizeDecimals: venue === 'var' ? null : 2, priceDecimals: venue === 'var' ? null : 2, minBase: venue === 'var' ? 0 : 0.01, minQuote: venue === 'var' ? 0 : 10, takerFeeBps: 0 } });
const pairOf = (a: LegInfo, b: LegInfo, ratio = 1, extra: Partial<PairInfo> = {}): PairInfo => ({ key: pairKey(a, b, ratio), a, b, ratio, symbol: a.symbol, name: a.symbol, kind: 'equity', identity: 'verified', gapBps: 0, custom: false, note: '', ...extra });
/** 主用配对：Lighter 主网对 Entropy，乘数 1。 */
const NVDA = pairOf(leg('lighter', 'NVDA', 7), leg('entropy', 'NVDA', 3));
/** 乘数 2：A（Lighter RH）价约为 B（Lighter 主网）的两倍，两条腿都与 NVDA 不重合。 */
const GOLD = pairOf(leg('rh', 'XAU', 11), leg('lighter', 'PAXG', 12), 2);
/** 与 NVDA 共用 Entropy 那条腿。 */
const SHARED = pairOf(leg('rh', 'NVDA', 13), leg('entropy', 'NVDA', 3));
const VARP = pairOf(leg('var', 'NVDA', 0), leg('lighter', 'NVDA', 7));
const MISMATCH = pairOf(leg('rh', 'TSLA', 14), leg('lighter', 'TSLA', 15), 1, { identity: 'mismatch' });
const PAIRS = [NVDA, GOLD, SHARED, VARP, MISMATCH];
const bookKey = (venue: string, symbol: string) => `${venue}:${symbol}`;
const positionSymbol = (info: LegInfo) => info.venue === 'entropy' ? info.market.coin! : info.symbol;

function sample(key: string, t: number, aMid: number, bMid: number, ratio = 1, extra: Partial<Sample> = {}): Sample {
  return {
    symbol: key, t, receivedAt: t, regime: 'all', ratio, captureKind: 'decision', decisionAt: t, aRxAt: t, bRxAt: t, aTkQty: null, bTkQty: null, aTkReceivedAt: null, bTkReceivedAt: null,
    aAt: t, aMark: aMid, aIndex: null, aFunding: 0, aBid0: aMid - 0.01, aAsk0: aMid + 0.01, aBid1k: aMid - 0.02, aAsk1k: aMid + 0.02, aBid100k: null, aAsk100k: null, aBidRx: aMid - 0.01, aAskRx: aMid + 0.01, aBidTk: null, aAskTk: null, aTkAt: null,
    bAt: t - 500, bMark: bMid, bIndex: bMid, bFunding: 0, bBid0: bMid - 0.01, bAsk0: bMid + 0.01, bBid1k: bMid - 0.02, bAsk1k: bMid + 0.02, bBid100k: null, bAsk100k: null, bBidRx: bMid - 0.01, bAskRx: bMid + 0.01, bBidTk: null, bAskTk: null, bTkAt: null, ...extra,
  };
}

interface Sent { venue: KeyVenue; symbol: string; side: 'buy' | 'sell'; qty: number; limit: number; reduceOnly: boolean; clientId: number; at: number }
/** 一笔单的剧本：给状态机的结果，以及交易所那边真实成交了多少（默认与结果一致；结果未知时默认 0）。 */
type Script = { outcome: OrderOutcome | ((order: VenueOrder) => OrderOutcome); real?: number | ((order: VenueOrder) => number) } | 'hang';
const done = (filledQty: number, avgPrice: number | null, note = '替身'): OrderOutcome => ({ kind: 'done', filledQty, avgPrice, note });
const unknown = (reason = '请求没有应答'): { kind: 'unknown'; reason: string } => ({ kind: 'unknown', reason });
/** 查单读成功了，但交易所没有这笔单的最终结果。 */
const absent = (reason = '交易所查无此单'): ResolveOutcome => ({ kind: 'absent', reason });
/** 成交：不给数量就全部成交，不给价格就按限价成交。 */
const fill = (qty?: number, price?: number | null): Script => ({ outcome: order => done(qty ?? order.qty, price === undefined ? order.limit : price) });
const miss = (): Script => ({ outcome: done(0, null, '未成交') });
/** 结果未知；real 是交易所那边实际成交的量（'all' 为全部）。 */
const lost = (real: number | 'all' = 0): Script => ({ outcome: unknown(), real: real === 'all' ? order => order.qty : real });

function harness(t: test.TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dex-live-'));
  const store = openVarLighterStore(path.join(dir, 'varlighter.sqlite'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const s = {
    clock: T0, keys: { ...ALL_KEYS } as LiveKeys, keysProblem: null as string | null, venueProblem: {} as Partial<Record<KeyVenue, string>>,
    pairs: new Map(PAIRS.map(pair => [pair.key, pair])), catalog: true,
    quotes: new Map<string, { bid: number; ask: number } | null>([['lighter:NVDA', { bid: 100.29, ask: 100.31 }], ['entropy:NVDA', { bid: 99.99, ask: 100.01 }], ['rh:XAU', { bid: 200.59, ask: 200.61 }], ['lighter:PAXG', { bid: 99.99, ask: 100.01 }],
      ['rh:NVDA', { bid: 100.29, ask: 100.31 }], ['rh:TSLA', { bid: 100.29, ask: 100.31 }], ['lighter:TSLA', { bid: 99.99, ask: 100.01 }]]),
    /** 交易所那边的真实持仓（场所:代码 → 带符号数量）。 */ book: new Map<string, number>(),
    available: { lighter: 1000, rh: 1000, entropy: 1000 } as Record<KeyVenue, number>,
    /** 定时读到账户的时刻：不设就是此刻，null 为还没读到。 */ accountAt: {} as Partial<Record<KeyVenue, number | null>>,
    readFails: false, fees: { lighter: 2, rh: 2, entropy: 5 } as Record<KeyVenue, number>,
    place: { lighter: [], rh: [], entropy: [] } as Record<KeyVenue, Script[]>, resolve: { lighter: [], rh: [], entropy: [] } as Record<KeyVenue, ResolveOutcome[]>, stopped: false,
    sent: [] as Sent[], resolved: [] as { venue: KeyVenue; clientId: number; sentAt: number; at: number }[], reads: [] as KeyVenue[], logs: [] as string[], traders: [] as LiveTrader[],
  };
  let inFlight = 0;
  const snapshot = (venue: KeyVenue): AccountSnapshot => ({ collateral: 1000, available: s.available[venue],
    positions: [...s.book].filter(([key, size]) => key.startsWith(`${venue}:`) && Math.abs(size) > 1e-9).map(([key, size]) => ({ symbol: key.slice(venue.length + 1), size, valueUsd: Math.abs(size) * 100 })) });
  const symbolOf = (venue: KeyVenue, order: VenueOrder) => venue === 'entropy' ? order.market.coin! : order.market.symbol;
  const trader = (venue: KeyVenue) => ({
    async place(order: VenueOrder): Promise<OrderOutcome> {
      assert.equal(++inFlight, 1, '同一时刻只有一笔单在途');
      s.sent.push({ venue, symbol: symbolOf(venue, order), side: order.side, qty: order.qty, limit: order.limit, reduceOnly: order.reduceOnly, clientId: order.clientId, at: s.clock });
      await new Promise(resolve => setImmediate(resolve));
      inFlight--;
      const script = s.place[venue].shift() ?? fill();
      // 进程在等应答时被杀掉：这个调用永远不返回。
      if (script === 'hang') return new Promise<OrderOutcome>(() => {});
      const outcome = typeof script.outcome === 'function' ? script.outcome(order) : script.outcome;
      const real = typeof script.real === 'function' ? script.real(order) : script.real ?? (outcome.kind === 'done' ? outcome.filledQty : 0);
      const key = bookKey(venue, symbolOf(venue, order));
      s.book.set(key, Math.round(((s.book.get(key) ?? 0) + (order.side === 'buy' ? 1 : -1) * real) * 1e9) / 1e9);
      return outcome;
    },
    async resolve(order: VenueOrder, sentAt: number): Promise<ResolveOutcome> {
      s.resolved.push({ venue, clientId: order.clientId, sentAt, at: s.clock });
      await new Promise(resolve => setImmediate(resolve));
      return s.resolve[venue].shift() ?? unknown('交易所暂时查不到这笔单');
    },
  });
  const traders = { lighter: trader('lighter'), rh: trader('rh'), entropy: trader('entropy') };
  /** 建一个实盘状态机（再调一次相当于进程重启：同一个库，内存状态全部重来）。 */
  function boot(): LiveTrader {
    const live = createLiveTrader({
      store, stopped: () => s.stopped, now: () => s.clock, log: line => { s.logs.push(line); },
      keys: { read: () => ({ keys: s.keysProblem ? {} : s.keys, problem: s.keysProblem }), view: () => ({ lighter: !!s.keys.lighter, rh: !!s.keys.rh, entropy: !!s.keys.entropy }), accounts: () => ({}), set() { assert.fail('状态机不改凭据'); }, remove() { assert.fail('状态机不改凭据'); } },
      trader: (venue, keys) => { assert.ok(keys[venue], '没有凭据的场所不该取连接器'); return traders[venue]; },
      venueProblem: venue => s.venueProblem[venue] ?? null,
      pairOf: key => s.catalog ? s.pairs.get(key) : undefined,
      quote: info => s.quotes.get(bookKey(info.venue, info.symbol)) ?? null,
      takerFeeBps: info => s.fees[info.venue as KeyVenue],
      account: venue => { const at = s.accountAt[venue]; return at === null ? null : { at: at ?? s.clock, snapshot: snapshot(venue) }; },
      readAccount: async venue => { s.reads.push(venue); if (s.readFails) throw new Error('HTTP 500'); return snapshot(venue); },
      signalFor: () => new AbortController().signal,
    });
    s.traders.push(live);
    return live;
  }
  const api = {
    s, store, boot,
    /** 打开总开关并勾选配对。 */
    enable(live: LiveTrader, pairs: PairInfo[], limits: Partial<LiveLimits> = {}) { return live.update({ on: true, pairs: pairs.map(pair => pair.key), limits: { ...DEFAULT_LIVE_SETTINGS.limits, ...limits } }, key => s.pairs.has(key)); },
    /** 策略发出开仓信号并等这一轮推进结束；返回被挡下的原因，提交了为 null。 */
    async open(live: LiveTrader, pair: PairInfo, options: { direction?: Direction; notionalUsd?: number; aMid?: number; bMid?: number; sample?: Partial<Sample> } = {}): Promise<string | null> {
      const reason = commit(live.prepare(pair, sig(options.direction ?? 'a_rich', options.notionalUsd ?? 100), sample(pair.key, s.clock, options.aMid ?? (pair.ratio === 1 ? 100.3 : 100.3 * pair.ratio), options.bMid ?? 100, pair.ratio, options.sample)));
      await live.idle();
      return reason;
    },
    /** 策略发出平仓信号。 */
    async closeSignal(live: LiveTrader, pair: PairInfo, reason = 'revert'): Promise<void> {
      live.signalClose(pair.key, reason);
      await live.idle();
    },
    /** 时钟前进一段并推进一轮。 */
    async step(live: LiveTrader, ms: number): Promise<void> { s.clock += ms; live.tick(); await live.idle(); },
    async run(live: LiveTrader, totalMs: number, stepMs = 1_000): Promise<void> { for (let passed = 0; passed < totalMs; passed += stepMs) await api.step(live, stepMs); },
    position(live: LiveTrader, pair: PairInfo = NVDA): LivePosition { const found = live.view().positions.find(item => item.symbol === pair.key); assert.ok(found, `${pair.key} 应有未结束的实盘持仓`); return found; },
    trades: (live: LiveTrader) => live.view().trades,
    resolvedCount: () => s.resolved.length,
    alerts: (): LiveAlert[] => s.traders.flatMap(live => live.alerts()),
    events: () => store.events(1000).filter(item => item.kind === 'live').map(item => item.message).reverse(),
    /** 发出的单的简写：场所 方向 数量（只减仓的加 R）。 */
    orders: (from = 0) => s.sent.slice(from).map(item => `${item.venue} ${item.side} ${item.qty}${item.reduceOnly ? ' R' : ''}`),
    /** 每个用例结束时都调：自编号不重复且递增；任何输出里都没有账户编号、地址与私钥。 */
    check(): void {
      const ids = s.sent.map(item => item.clientId);
      assert.equal(new Set(ids).size, ids.length, '同一个自编号发了两次');
      ids.forEach((id, index) => { assert.ok(Number.isSafeInteger(id) && id > 0 && id < 2 ** 48, '自编号须为小于 2^48 的正整数'); if (index > 0) assert.ok(id > ids[index - 1]!, '自编号须递增'); });
      for (const item of s.sent) assert.ok(item.qty > 0 && item.limit > 0 && Number.isFinite(item.qty) && Number.isFinite(item.limit), '发出的单数量与限价须为正');
      const output = JSON.stringify([api.alerts(), store.events(1000), s.logs, s.traders.map(live => live.view()), store.state(LIVE_RUNTIME_KEY), store.state(LIVE_SETTINGS_KEY), store.liveActive(), store.liveClosed(100)]).toLowerCase();
      for (const secret of [String(ACCOUNT), String(RH_ACCOUNT), ADDRESS.slice(2), LIGHTER_KEY.slice(0, 16), RH_KEY.slice(0, 16), ENTROPY_KEY.slice(2, 18)]) assert.ok(!output.includes(secret), `输出里带了账户标识或私钥：${secret.slice(0, 6)}…`);
    },
  };
  return api;
}
/** 一笔刚落库、还没发出第一腿的开仓意图（进程在落库与发送之间退出时库里就是这样）。 */
const intent = (openedAt: number): LivePosition => {
  const side = (info: LegInfo, way: 'buy' | 'sell') => ({ venue: info.venue as KeyVenue, symbol: positionSymbol(info), side: way, qty: 0, entryQuote: 0, exitQty: 0, exitQuote: 0, feesUsd: 0, estimated: false, market: info.market, code: info.symbol });
  return { id: 'lseed-1', symbol: NVDA.key, direction: 'a_rich', ratio: 1, state: 'opening', step: 'a', openedAt, updatedAt: openedAt, closedAt: null, a: side(NVDA.a, 'sell'), b: side(NVDA.b, 'buy'),
    plan: { qty: 1, limit: 99.97 }, pending: null, tries: 0, retryAt: 0, closeReason: null, singleLeg: false, netUsd: null, note: '' };
};
/** 策略的开仓信号（读数只记在持仓上，状态机不拿它判断）。 */
const sig = (direction: Direction, notionalUsd: number): LiveSignal => ({ direction, notionalUsd, strategy: { entrySpread: 30, entryBaseline: 0, entryRegime: 'all', aFeeBps: 0, bFeeBps: 0, estimated: false } });
/** 引擎拿到可提交的开仓就提交；被挡下的返回原因。 */
const commit = (result: string | (() => void)): string | null => { if (typeof result === 'string') return result; result(); return null; };
const near = (actual: number | null, expected: number, label = '') => assert.ok(actual !== null && Math.abs(actual - expected) < 1e-6, `${label} 实际 ${actual}，应为 ${expected}`);
const liveError = (work: () => unknown): [string, number] | null => { try { work(); } catch (error) { assert.ok(error instanceof LiveError, `应为 LiveError：${String(error)}`); return [error.code, error.status]; } return null; };

test('实盘开平仓：先下 A、按 A 的实际成交量乘乘数下 B，跟随模拟盘平仓；净盈亏含两腿手续费，名义取模拟名义与单笔上限的较小值', async t => {
  const h = harness(t), live = h.boot();
  h.enable(live, [NVDA, GOLD]);
  assert.deepEqual(live.settings().limits, { perTradeUsd: 100, maxOpen: 1, dailyLossUsd: 20, slippageBps: 30 });
  h.s.place.lighter.push(fill(1, 100.25), fill(1, 100.05));
  h.s.place.entropy.push(fill(1, 100.02), fill(1, 100));
  // 模拟盘名义 500，实盘单笔上限 100：A 腿 1.00（100 ÷ B 中间价 100），卖出限价 = 可成交买价 100.28 下浮 30 基点向下取整。
  await h.open(live, NVDA, { notionalUsd: 500 });
  assert.deepEqual(h.s.sent.map(({ clientId: _id, at: _at, ...rest }) => rest), [
    { venue: 'lighter', symbol: 'NVDA', side: 'sell', qty: 1, limit: 99.97, reduceOnly: false },
    // B 的限价按下单时的盘口卖一 100.01 上浮 30 基点、5 位有效数字、向上取整。
    { venue: 'entropy', symbol: 'io:NVDA', side: 'buy', qty: 1, limit: 100.31, reduceOnly: false },
  ]);
  const opened = h.position(live);
  assert.deepEqual([opened.state, opened.pending, opened.singleLeg, opened.a.qty, opened.b.qty, opened.a.estimated, opened.b.estimated, opened.a.symbol, opened.b.symbol], ['open', null, false, 1, 1, false, false, 'NVDA', 'io:NVDA']);
  near(opened.a.entryQuote, 100.25); near(opened.b.entryQuote, 100.02);
  assert.deepEqual([live.venueInUse('lighter'), live.venueInUse('entropy'), live.venueInUse('rh')], [true, true, false]);
  assert.ok(h.events().some(text => /^实盘开仓：Lighter 卖 1\.000000，Entropy 买 1\.000000$/.test(text)));
  // 持仓期间不动。
  await h.run(live, 30_000);
  assert.equal(h.s.sent.length, 2);

  await h.closeSignal(live, NVDA, 'revert');
  assert.deepEqual(h.s.sent.slice(2).map(({ clientId: _id, at: _at, ...rest }) => rest), [
    // 平仓两腿都只减仓；保护价至少 50 基点。
    { venue: 'lighter', symbol: 'NVDA', side: 'buy', qty: 1, limit: 100.82, reduceOnly: true },
    { venue: 'entropy', symbol: 'io:NVDA', side: 'sell', qty: 1, limit: 99.49, reduceOnly: true },
  ]);
  const [trade] = h.trades(live);
  assert.deepEqual([trade!.state, trade!.closeReason, trade!.singleLeg, live.view().positions.length], ['closed', 'revert', false, 0]);
  // A 卖 100.25 买回 100.05 赚 0.20，B 买 100.02 卖 100.00 亏 0.02；手续费 A 2 基点 ×（100.25 + 100.05）、B 5 基点 ×（100.02 + 100.00）。
  const expected = 0.20 - 0.02 - (100.25 + 100.05) * 2 / 10_000 - (100.02 + 100) * 5 / 10_000;
  near(trade!.netUsd, expected, '净盈亏');
  near(trade!.a.feesUsd, 0.04006); near(trade!.b.feesUsd, 0.10001);
  near(live.view().todayNetUsd, expected); near(live.view().totals.netUsd, expected);
  assert.deepEqual([live.view().totals.trades, live.view().totals.wins, live.venueInUse('lighter')], [1, 1, false]);
  assert.deepEqual([...h.s.book.values()].filter(size => size !== 0), [], '交易所那边也平了');

  // 模拟名义 50 小于单笔上限：按 50 下，A 买入方向（a_cheap）。
  await h.open(live, NVDA, { notionalUsd: 50, direction: 'a_cheap' });
  assert.deepEqual(h.orders(4), ['lighter buy 0.5', 'entropy sell 0.5']);
  await h.closeSignal(live, NVDA);
  assert.deepEqual(h.orders(6), ['lighter sell 0.5 R', 'entropy buy 0.5 R']);

  // 乘数 2：计划 A 0.50（B 1.00 ÷ 2）；A 只成交 0.30，B 按 0.30 × 2 = 0.60 对冲，不按计划的 1.00。
  h.s.place.rh.push(fill(0.3));
  await h.open(live, GOLD);
  assert.deepEqual(h.orders(8), ['rh sell 0.5', 'lighter buy 0.6']);
  const gold = h.position(live, GOLD);
  assert.deepEqual([gold.state, gold.a.qty, gold.b.qty, gold.ratio, gold.singleLeg], ['open', 0.3, 0.6, 2, false]);
  await h.closeSignal(live, GOLD);
  assert.deepEqual(h.orders(10), ['rh buy 0.3 R', 'lighter sell 0.6 R']);
  assert.equal(live.view().totals.trades, 3);
  h.check();
});

test('不开仓的条件：总开关、配对未勾选、凭据、签名器、账户读数、余额、预演不通过——都不发任何订单', async t => {
  const h = harness(t), live = h.boot(), s = h.s;
  const skips = new Set<string>();
  async function refused(label: string, pair: PairInfo, pattern: RegExp, options: Parameters<typeof h.open>[2] = {}): Promise<void> {
    const before = live.view().lastSkip;
    await h.open(live, pair, options);
    assert.deepEqual([s.sent.length, live.view().positions.length, h.store.liveActive().length], [0, 0, 0], `${label}：不该有订单与持仓`);
    const skip = live.view().lastSkip;
    assert.ok(skip && skip !== before, `${label}：应记下没跟的原因`);
    assert.deepEqual([skip.symbol, skip.at], [pair.key, s.clock], label);
    assert.match(skip.reason, pattern, label);
    skips.add(`${pair.key}
${skip.reason}`);
  }
  // 默认设置：总开关关。
  assert.deepEqual(live.settings(), DEFAULT_LIVE_SETTINGS);
  await refused('默认总开关关', NVDA, /^实盘总开关未开$/);
  live.update({ on: false, pairs: [NVDA.key], limits: DEFAULT_LIVE_SETTINGS.limits }, () => true);
  await refused('勾了配对但总开关关', NVDA, /^实盘总开关未开$/);
  h.enable(live, [GOLD]);
  await refused('总开关开但这个配对没勾', NVDA, /^这个配对没有开实盘$/);
  h.enable(live, [NVDA, VARP, MISMATCH]);

  await refused('带 Var 腿', VARP, /带 Var 腿的配对不上实盘/);
  s.keysProblem = '实盘凭据文件读不懂，未使用：不是有效的 JSON';
  await refused('凭据文件读不懂', NVDA, /实盘凭据文件读不懂/);
  s.keysProblem = null;
  s.keys = { entropy: ALL_KEYS.entropy };
  await refused('缺 A 腿凭据', NVDA, /^Lighter 还没有录入凭据$/);
  s.keys = { lighter: ALL_KEYS.lighter, rh: ALL_KEYS.rh };
  await refused('缺 B 腿凭据', NVDA, /^Entropy 还没有录入凭据$/);
  s.keys = {};
  await refused('都没有凭据', NVDA, /还没有录入凭据/);
  s.keys = { ...ALL_KEYS };
  s.venueProblem = { lighter: 'Lighter 签名器文件不存在' };
  await refused('签名器不可用', NVDA, /^Lighter 签名器文件不存在$/);
  s.venueProblem = {};
  s.accountAt = { lighter: null };
  await refused('A 腿账户还没读到', NVDA, /^Lighter 账户读数不够新$/);
  s.accountAt = { entropy: s.clock - ACCOUNT_FRESH_MS - 1 };
  await refused('B 腿账户读数过期', NVDA, /^Entropy 账户读数不够新$/);
  s.accountAt = {};
  s.available.lighter = 99.99;
  await refused('A 腿可用余额不足', NVDA, /^Lighter 可用余额 99\.99 不足单笔金额 100$/);
  s.available.lighter = 1000;
  s.available.entropy = 0;
  await refused('B 腿可用余额为 0', NVDA, /^Entropy 可用余额 0\.00 不足单笔金额 100$/);
  s.available.entropy = 1000;
  // 下单预演不通过：报价太旧、两腿报价对不齐、金额小于场所下限、规格不同。
  await refused('报价太旧', NVDA, /较慢一腿报价 91 秒前/, { sample: { aAt: s.clock - 91_000, bAt: s.clock - 91_000 } });
  await refused('两腿报价对不齐', NVDA, /报价相差 80 秒/, { sample: { bAt: s.clock - 80_000 } });
  await refused('小于最小金额', NVDA, /不小于 Lighter 最小金额 10 USDC/, { notionalUsd: 5 });
  await refused('数量取整后为 0', NVDA, /取整后数量 0\.00/, { notionalUsd: 0.5 });
  await refused('两边规格不同', MISMATCH, /规格不同/);
  await refused('缺可成交价', NVDA, /./, { sample: { aBid1k: null, aAsk1k: null, aBid0: 0, aAsk0: 0 } });

  assert.equal(h.events().filter(text => text.startsWith('实盘没有开仓：')).length, skips.size, '每个配对的每种原因留一条事件（10 分钟内不重复）');
  assert.deepEqual([s.sent.length, s.resolved.length, s.reads.length, h.store.liveClosed(10).length], [0, 0, 0, 0], '全程没有发单、查单、现读账户，也没有留下持仓记录');
  // 条件恢复后照常开仓；账户读数刚好在时限上算新的。
  s.accountAt = { lighter: s.clock - ACCOUNT_FRESH_MS };
  await h.open(live, NVDA);
  assert.deepEqual(h.orders(), ['lighter sell 1', 'entropy buy 1']);
  h.check();
});

test('不开仓的条件：同配对已有持仓、腿被占用、到持仓上限、已停止', async t => {
  const h = harness(t), live = h.boot(), s = h.s;
  h.enable(live, [NVDA, GOLD, SHARED], { maxOpen: 1 });
  await h.open(live, NVDA);
  assert.equal(s.sent.length, 2);
  await h.open(live, NVDA);
  assert.match(live.view().lastSkip!.reason, /^这个配对已有实盘持仓$/);
  await h.open(live, SHARED);
  assert.match(live.view().lastSkip!.reason, /^有一条腿已被别的实盘持仓占用$/, '同一场所同一代码上的两笔持仓无法各自对账');
  await h.open(live, GOLD);
  assert.match(live.view().lastSkip!.reason, /^实盘持仓已到上限 1 笔$/);
  assert.deepEqual([s.sent.length, live.view().positions.length], [2, 1], '被挡下的都没有发单');
  h.enable(live, [NVDA, GOLD, SHARED], { maxOpen: 2 });
  await h.open(live, GOLD);
  assert.deepEqual(h.orders(2), ['rh sell 0.5', 'lighter buy 1']);
  await h.open(live, SHARED);
  assert.match(live.view().lastSkip!.reason, /^有一条腿已被别的实盘持仓占用$/);
  assert.equal(s.sent.length, 4);
  h.check();
});

test('当日已实现亏损到上限：告警并不再开仓，第二天（UTC）恢复', async t => {
  const h = harness(t), live = h.boot(), s = h.s;
  h.enable(live, [NVDA], { dailyLossUsd: 1 });
  // A 卖 100 买回 101.5，亏 1.5。
  s.place.lighter.push(fill(1, 100), fill(1, 101.5));
  s.place.entropy.push(fill(1, 100), fill(1, 100));
  await h.open(live, NVDA);
  assert.equal(h.alerts().length, 0);
  await h.closeSignal(live, NVDA);
  const net = live.view().todayNetUsd;
  assert.ok(net < -1.5 && net > -1.7, `当日净 ${net}`);
  assert.deepEqual(h.alerts().map(item => [item.key.split(':')[0], /当日已实现亏损 1\.\d\d 美元，达到上限 1 美元/.test(item.text)]), [['loss', true]]);
  await h.open(live, NVDA);
  assert.match(live.view().lastSkip!.reason, /^当日已实现亏损达到上限 1 美元$/);
  assert.equal(s.sent.length, 4);
  assert.equal(live.view().halt, null, '亏损上限不是停止，第二天自己恢复');
  // 过了 UTC 零点。
  s.clock = Date.parse('2026-11-28T00:00:01Z');
  await h.open(live, NVDA);
  assert.equal(s.sent.length, 6);
  h.check();
});

test('第一腿零成交或被拒：放弃，不发第二腿，不算单腿也不计入成交笔数', async t => {
  const h = harness(t), live = h.boot(), s = h.s;
  h.enable(live, [NVDA]);
  for (const [label, script] of [['IOC 未成交', miss()], ['交易所拒绝', { outcome: done(0, null, '交易所拒绝：margin') }], ['没有发出', { outcome: done(0, null, '没有发出：读不到下一个 nonce') }]] as [string, Script][]) {
    const before = s.sent.length;
    s.place.lighter.push(script);
    await h.open(live, NVDA);
    assert.deepEqual(h.orders(before), ['lighter sell 1'], `${label}：只发了第一腿`);
    assert.equal(live.view().positions.length, 0, label);
    const trade = h.trades(live)[0]!;
    assert.deepEqual([trade.state, trade.closeReason, trade.netUsd, trade.singleLeg, trade.a.qty, trade.b.qty, trade.note], ['closed', 'not_filled', 0, false, 0, 0, 'Lighter 第一腿没有成交，放弃'], label);
  }
  assert.deepEqual(live.view().totals, { trades: 0, netUsd: 0, wins: 0 }, '没成交的不算笔数');
  assert.deepEqual([live.view().paused, live.view().halt, h.alerts()], [{}, null, []]);
  assert.equal(h.events().filter(text => text === '实盘未开成：Lighter 第一腿没有成交，放弃').length, 3);
  // 放弃之后可以立刻再开。
  await h.open(live, NVDA);
  assert.equal(h.position(live).state, 'open');
  h.check();
});

test('第二腿零成交：第一腿只减仓反向平掉，记单腿；连续两次单腿暂停该配对并告警，中间有一笔正常的则重新计数', async t => {
  const h = harness(t), live = h.boot(), s = h.s;
  h.enable(live, [NVDA, GOLD], { maxOpen: 2 });
  const single = async (label: string) => {
    const before = s.sent.length;
    s.place.lighter.push(fill(1, 100.25), fill(1, 100.35));
    s.place.entropy.push(miss());
    await h.open(live, NVDA);
    assert.deepEqual(h.orders(before), ['lighter sell 1', 'entropy buy 1', 'lighter buy 1 R'], `${label}：A 多出的 1 只减仓买回`);
    const trade = h.trades(live)[0]!;
    assert.deepEqual([trade.closeReason, trade.singleLeg, trade.a.qty, trade.a.exitQty, trade.b.qty, trade.note], ['single_leg', true, 1, 1, 0, 'Entropy 第二腿没有成交，第一腿已平掉'], label);
    // 卖 100.25 买回 100.35 亏 0.10，加 A 腿两笔手续费。
    near(trade.netUsd, -0.10 - (100.25 + 100.35) * 2 / 10_000, label);
    assert.equal(live.view().positions.length, 0, label);
    assert.equal(s.book.get('lighter:NVDA'), 0, `${label}：交易所那边没有留下裸露的仓位`);
  };
  await single('第一次');
  // 回补的保护价比开仓宽：至少 100 基点，买回的限价高于卖一。
  assert.ok(s.sent[2]!.limit > 100.31 * 1.009 && s.sent[2]!.limit < 100.31 * 1.011, `回补限价 ${s.sent[2]!.limit}`);
  assert.deepEqual([live.view().paused, h.alerts()], [{}, []], '一次单腿不暂停');
  // 中间一笔两腿都成交的：单腿计数清零。
  await h.open(live, NVDA);
  await h.closeSignal(live, NVDA);
  await single('第二次（前面隔了一笔正常的）');
  assert.deepEqual(live.view().paused, {}, '不连续，不暂停');
  await single('第三次');
  assert.deepEqual(live.view().paused, { [NVDA.key]: '连续两次单腿' });
  assert.deepEqual(h.alerts().map(item => [item.key.split(':')[0], item.text.includes('连续两次单腿，已暂停这个配对的实盘')]), [['paused', true]]);
  assert.ok(h.events().includes('连续两次单腿，已暂停这个配对的实盘'));
  const before = s.sent.length;
  await h.open(live, NVDA);
  assert.match(live.view().lastSkip!.reason, /^这个配对的实盘已暂停：连续两次单腿$/);
  assert.equal(s.sent.length, before);
  // 只暂停这一个配对；暂停是持久的（重启后还在），恢复后解除。
  await h.open(live, GOLD);
  assert.equal(h.position(live, GOLD).state, 'open');
  await h.closeSignal(live, GOLD);
  const again = h.boot();
  assert.deepEqual([again.view().paused, again.settings().pairs], [{ [NVDA.key]: '连续两次单腿' }, [GOLD.key, NVDA.key].sort()]);
  const sent = s.sent.length;
  await h.open(again, NVDA);
  assert.equal(s.sent.length, sent, '重启后仍然暂停');
  again.resume();
  await h.open(again, NVDA);
  assert.equal(h.position(again).state, 'open');
  h.check();
});

test('第二腿部分成交、没有报价或数量不足：第一腿多出的部分只减仓平掉，剩下的照常持有与平仓', async t => {
  const h = harness(t), live = h.boot(), s = h.s;
  h.enable(live, [NVDA, GOLD]);
  // B 只成交 0.40：A 多出 0.60 买回。
  s.place.entropy.push(fill(0.4));
  await h.open(live, NVDA);
  assert.deepEqual(h.orders(), ['lighter sell 1', 'entropy buy 1', 'lighter buy 0.6 R']);
  let position = h.position(live);
  assert.deepEqual([position.state, position.singleLeg, position.a.qty, position.a.exitQty, position.b.qty, position.tries], ['open', true, 1, 0.6, 0.4, 0]);
  assert.deepEqual([s.book.get('lighter:NVDA'), s.book.get('entropy:io:NVDA')], [-0.4, 0.4], '两边剩下的数量对得上');
  assert.ok(h.events().some(text => text.includes('（第二腿只成交了一部分，多出的已平掉）')));
  await h.closeSignal(live, NVDA);
  assert.deepEqual(h.orders(3), ['lighter buy 0.4 R', 'entropy sell 0.4 R'], '平仓只平剩下的');
  assert.deepEqual([h.trades(live)[0]!.singleLeg, h.trades(live)[0]!.closeReason, s.book.get('lighter:NVDA'), s.book.get('entropy:io:NVDA')], [true, 'revert', 0, 0]);

  // 回补自己也只成交一部分：接着平剩下的，不等。
  let from = s.sent.length;
  s.place.entropy.push(miss());
  s.place.lighter.push(fill(), fill(0.7), fill());
  await h.open(live, NVDA);
  assert.deepEqual(h.orders(from), ['lighter sell 1', 'entropy buy 1', 'lighter buy 1 R', 'lighter buy 0.3 R']);
  assert.deepEqual([h.trades(live)[0]!.closeReason, s.book.get('lighter:NVDA')], ['single_leg', 0]);
  live.resume();

  // 开仓时 B 腿没有报价：第一腿也不发（发第一腿前核对两腿此刻的报价）。
  from = s.sent.length;
  s.quotes.set('entropy:NVDA', null);
  await h.open(live, NVDA);
  assert.deepEqual([h.orders(from), live.view().lastSkip?.reason], [[], 'Entropy 此刻没有报价']);
  s.quotes.set('entropy:NVDA', { bid: 99.99, ask: 100.01 });
  // 第一腿成交后 B 腿的报价才没了：不发 B，A 直接平掉。
  s.place.lighter.push({ outcome: order => { s.quotes.set('entropy:NVDA', null); return done(order.qty, order.limit); } });
  await h.open(live, NVDA);
  assert.deepEqual(h.orders(from), ['lighter sell 1', 'lighter buy 1 R'], '没有报价就不下第二腿');
  assert.equal(h.trades(live)[0]!.closeReason, 'single_leg');
  s.quotes.set('entropy:NVDA', { bid: 99.99, ask: 100.01 });
  live.resume();

  // A 成交得太少，折到 B 不够最小数量（乘数 2 的配对：A 成交 0.004 不可能，这里用 A 0.01 × 乘数 2 = 0.02，把 B 的最小数量调到 0.05）。
  from = s.sent.length;
  const tight = pairOf(GOLD.a, { ...GOLD.b, market: { ...GOLD.b.market, minBase: 0.05, minQuote: 0 } }, 2);
  s.pairs.set(tight.key, tight);
  s.place.rh.push(fill(0.01));
  await h.open(live, tight);
  assert.deepEqual(h.orders(from), ['rh sell 0.5', 'rh buy 0.01 R'], 'B 的数量不够下限时不下 B，A 平掉');
  assert.equal(h.trades(live)[0]!.closeReason, 'single_leg');

  // 回补时 A 腿没有报价：等，不消耗次数，有了报价再发。
  live.resume();
  from = s.sent.length;
  s.place.entropy.push(miss());
  await h.open(live, NVDA);
  assert.deepEqual(h.orders(from), ['lighter sell 1', 'entropy buy 1', 'lighter buy 1 R']);
  h.check();

  const g = harness(t), other = g.boot();
  g.enable(other, [NVDA]);
  g.s.place.entropy.push(miss());
  g.s.quotes.set('lighter:NVDA', { bid: 100.29, ask: 100.31 });
  const original = g.s.place.lighter;
  original.push({ outcome: order => { g.s.quotes.set('lighter:NVDA', null); return done(order.qty, order.limit); } });
  await g.open(other, NVDA);
  assert.deepEqual(g.orders(), ['lighter sell 1', 'entropy buy 1'], 'A 腿没有报价时先不回补');
  position = g.position(other);
  assert.deepEqual([position.state, position.tries, position.singleLeg], ['opening', 0, true]);
  await g.run(other, 30_000);
  assert.equal(g.s.sent.length, 2);
  g.s.quotes.set('lighter:NVDA', { bid: 100.29, ask: 100.31 });
  await g.run(other, RETRY_MS);
  assert.deepEqual(g.orders(2), ['lighter buy 1 R']);
  assert.equal(g.trades(other)[0]!.closeReason, 'single_leg');
  g.check();
});

test('回补三次都平不掉：持仓转人工处理、停止开新仓并告警；其余持仓照常平仓；dismiss 要确认文字，有卡住的持仓时不能恢复', async t => {
  const h = harness(t), live = h.boot(), s = h.s;
  h.enable(live, [NVDA, GOLD], { maxOpen: 2 });
  await h.open(live, GOLD);
  s.place.entropy.push(miss());
  s.place.lighter.push(fill(), miss(), miss(), miss());
  await h.open(live, NVDA);
  assert.deepEqual(h.orders(2), ['lighter sell 1', 'entropy buy 1', 'lighter buy 1 R'], '第一次回补没成交');
  assert.deepEqual([h.position(live).state, h.position(live).tries], ['opening', 1]);
  await h.step(live, RETRY_MS - 1);
  assert.equal(s.sent.length, 5, '没到重试间隔不发');
  await h.step(live, 1);
  await h.step(live, RETRY_MS);
  assert.deepEqual(h.orders(5), ['lighter buy 1 R', 'lighter buy 1 R']);
  const limits = s.sent.slice(4).map(item => item.limit);
  assert.ok(limits[0]! < limits[1]! && limits[1]! < limits[2]! && limits[2]! <= 100.31 * 1.0301, `回补的保护价逐次放宽但不超过 300 基点：${limits.join(' ')}`);
  assert.equal(live.view().halt, null, '三次机会用完之前不停止');
  await h.step(live, RETRY_MS);
  assert.equal(s.sent.length, 7, '第四次不再发单');
  const stuck = h.position(live);
  assert.deepEqual([stuck.state, stuck.note, stuck.singleLeg, stuck.a.qty, stuck.a.exitQty, stuck.b.qty], ['stuck', 'Lighter 多出的 1 平不掉（第二腿没有补齐）', true, 1, 0, 0]);
  assert.match(live.view().halt!, /需要人工处理：Lighter 多出的 1 平不掉/);
  assert.deepEqual(h.alerts().map(item => [item.key.split(':')[0], /需要人工处理/.test(item.text)]), [['stuck', true], ['halt', true]]);
  assert.match(h.alerts()[1]!.text, /【DEX 价差实盘已停止】/);
  assert.equal(s.book.get('lighter:NVDA'), -1, '交易所那边确实留着裸露的 A 腿：必须告警');
  // 卡住之后不再自己动。
  await h.run(live, 120_000, 5_000);
  assert.equal(s.sent.length, 7);
  assert.equal(h.alerts().length, 2, '同一件事只告警一次');

  // 停止期间：不开新仓，但已有的持仓照常跟平仓信号。
  await h.closeSignal(live, NVDA);
  assert.equal(h.position(live).state, 'stuck', '卡住的持仓不会被平仓信号推动');
  await h.closeSignal(live, GOLD);
  assert.deepEqual(h.orders(7), ['rh buy 0.5 R', 'lighter sell 1 R'], '另一笔持仓照常平掉');
  await h.open(live, GOLD);
  assert.match(live.view().lastSkip!.reason, /^实盘已停止：/);
  assert.equal(s.sent.length, 9);

  // 人工处理：恢复被拒、手动平仓被拒、dismiss 要确认文字。
  const id = stuck.id;
  assert.deepEqual(liveError(() => live.resume()), ['busy', 409]);
  assert.deepEqual(liveError(() => live.close({ id })), ['busy', 409]);
  for (const body of [{ id }, { id, confirm: 'dismiss' }, { id, confirm: true }, { id: 'nope', confirm: 'DISMISS' }, { confirm: 'DISMISS' }, null, 'DISMISS', [id]]) assert.deepEqual(liveError(() => live.dismiss(body)), ['not_found', 404], JSON.stringify(body));
  assert.equal(h.position(live).state, 'stuck');
  assert.equal(live.venueInUse('lighter'), true, '卡住的持仓仍占着凭据');
  assert.deepEqual(live.dismiss({ id, confirm: 'DISMISS' }), { ok: true });
  const trade = h.trades(live)[0]!;
  assert.deepEqual([trade.closeReason, trade.state, live.view().positions.length, live.venueInUse('lighter')], ['dismissed', 'closed', 0, false]);
  // 没平掉的部分不计盈亏，只算已付的开仓手续费。
  near(trade.netUsd, -1 * 99.97 * 2 / 10_000);
  assert.match(live.view().halt!, /需要人工处理/, 'dismiss 不自动恢复');
  await h.open(live, GOLD);
  assert.equal(s.sent.length, 9);
  assert.deepEqual(live.resume(), { ok: true });
  assert.deepEqual([live.view().halt, live.view().paused], [null, {}]);
  await h.open(live, GOLD);
  assert.equal(s.sent.length, 11, '恢复后照常开仓');
  assert.equal(s.sent.length - 11, 0, 'dismiss 与 resume 自己不发任何单');
  // 不是卡住的持仓不能 dismiss。
  assert.deepEqual(liveError(() => live.dismiss({ id: h.position(live, GOLD).id, confirm: 'DISMISS' })), ['busy', 409]);
  h.check();
});

test('第一腿结果未知：不重发，按自编号查到成交后继续下第二腿；查到没成交就放弃', async t => {
  const h = harness(t), live = h.boot(), s = h.s;
  h.enable(live, [NVDA]);
  s.place.lighter.push(lost('all'));
  await h.open(live, NVDA);
  assert.deepEqual(h.orders(), ['lighter sell 1']);
  let position = h.position(live);
  assert.deepEqual([position.state, position.a.qty, position.pending?.leg, position.pending?.purpose, position.pending?.clientId, position.pending?.sentAt], ['opening', 0, 'a', 'open', s.sent[0]!.clientId, T0]);
  assert.deepEqual(h.store.liveActive()[0]!.pending?.clientId, s.sent[0]!.clientId, '在途的意图已落库');
  // 两秒内不查；之后每 5 秒查一次，查不到就继续等，始终不重发。
  await h.step(live, UNKNOWN_FIRST_MS - 1);
  assert.equal(s.resolved.length, 0);
  await h.step(live, 1);
  assert.deepEqual(s.resolved, [{ venue: 'lighter', clientId: s.sent[0]!.clientId, sentAt: T0, at: T0 + UNKNOWN_FIRST_MS }]);
  await h.run(live, 20_000);
  assert.deepEqual([s.sent.length, s.resolved.length, s.reads.length], [1, 5, 0], '没到核对持仓的时限，只查单');
  // 查到全部成交（查单不给均价）：按限价估，接着下第二腿。
  s.resolve.lighter.push(done(1, null, '已成交'));
  await h.run(live, RETRY_MS);
  assert.deepEqual(h.orders(), ['lighter sell 1', 'entropy buy 1']);
  position = h.position(live);
  assert.deepEqual([position.state, position.pending, position.a.qty, position.a.estimated, position.b.estimated], ['open', null, 1, true, false]);
  near(position.a.entryQuote, 99.97, '按限价估');
  await h.closeSignal(live, NVDA);
  assert.ok(h.events().some(text => text.includes('（部分成交价按限价估）')));

  // 查到没有成交：放弃，不发第二腿。
  const from = s.sent.length, asked = s.resolved.length;
  s.place.lighter.push(lost(0));
  await h.open(live, NVDA);
  s.resolve.lighter.push(done(0, null, '交易所查无此单'));
  await h.step(live, UNKNOWN_FIRST_MS);
  assert.deepEqual(h.orders(from), ['lighter sell 1']);
  assert.deepEqual([s.resolved.length - asked, s.resolved.at(-1)!.clientId, h.trades(live)[0]!.closeReason, live.view().positions.length], [1, s.sent[from]!.clientId, 'not_filled', 0]);

  // 查到部分成交：第二腿按查到的量对冲。
  const next = s.sent.length;
  s.place.lighter.push(lost(0.4));
  await h.open(live, NVDA);
  s.resolve.lighter.push(done(0.4, 100.2, '交易所撤销'));
  await h.step(live, UNKNOWN_FIRST_MS);
  assert.deepEqual(h.orders(next), ['lighter sell 1', 'entropy buy 0.4']);
  assert.deepEqual([h.position(live).state, h.position(live).a.qty, h.position(live).a.estimated], ['open', 0.4, false]);
  h.check();
});

test('第二腿与回补、平仓的单结果未知：同样只查不重发，查到的成交量决定下一步', async t => {
  const h = harness(t), live = h.boot(), s = h.s;
  h.enable(live, [NVDA]);
  // 第二腿未知，实际成交 0.4。
  s.place.entropy.push(lost(0.4));
  await h.open(live, NVDA);
  assert.deepEqual(h.orders(), ['lighter sell 1', 'entropy buy 1']);
  assert.deepEqual([h.position(live).state, h.position(live).step, h.position(live).pending?.leg, h.position(live).pending?.purpose], ['opening', 'settle', 'b', 'hedge']);
  await h.run(live, 10_000);
  assert.equal(s.sent.length, 2, '第二腿结果未知时不回补、不重发');
  s.resolve.entropy.push(done(0.4, 100.02));
  // 回补的单也未知，实际全部成交。
  s.place.lighter.push(lost('all'));
  await h.run(live, RETRY_MS);
  assert.deepEqual(h.orders(2), ['lighter buy 0.6 R']);
  assert.deepEqual([h.position(live).state, h.position(live).pending?.purpose, h.position(live).tries], ['opening', 'flatten', 1]);
  await h.run(live, 10_000);
  assert.equal(s.sent.length, 3, '回补结果未知时不再发第二笔回补');
  s.resolve.lighter.push(done(0.6, null));
  await h.run(live, RETRY_MS);
  assert.deepEqual([s.sent.length, h.position(live).state, h.position(live).a.exitQty, h.position(live).b.qty], [3, 'open', 0.6, 0.4]);

  // 平仓的单未知：A 实际平了 0.1，查到后接着平剩下的 0.3；B 的平仓单未知且查到没成交，重新发。
  s.place.lighter.push(lost(0.1));
  await h.closeSignal(live, NVDA);
  assert.deepEqual(h.orders(3), ['lighter buy 0.4 R']);
  assert.deepEqual([h.position(live).state, h.position(live).pending?.purpose], ['closing', 'close']);
  s.resolve.lighter.push(done(0.1, 100.3));
  s.place.entropy.push(lost(0));
  await h.run(live, RETRY_MS);
  assert.deepEqual(h.orders(4), ['lighter buy 0.3 R', 'entropy sell 0.4 R']);
  s.resolve.entropy.push(done(0, null, '交易所查无此单'));
  await h.run(live, 2 * RETRY_MS);
  assert.deepEqual(h.orders(6), ['entropy sell 0.4 R'], '确认没成交之后才重新发，用新的自编号');
  assert.deepEqual([live.view().positions.length, h.trades(live)[0]!.closeReason, s.book.get('lighter:NVDA'), s.book.get('entropy:io:NVDA')], [0, 'revert', 0, 0]);
  assert.deepEqual(s.resolved.map(item => item.clientId), [...new Set(s.resolved.map(item => item.clientId))].flatMap(id => s.resolved.filter(item => item.clientId === id).map(() => id)), '查的都是发过的单');
  assert.ok(s.resolved.every(item => s.sent.some(order => order.clientId === item.clientId && order.at === item.sentAt && order.venue === item.venue)));
  h.check();
});

test('查单一直不明：到时限后按账户持仓的差量判定（成交、没成交、部分成交），之前不读账户', async t => {
  // Lighter 的第一腿：实际全部成交，60 秒后按持仓认定。
  const h = harness(t), live = h.boot(), s = h.s;
  h.enable(live, [NVDA]);
  s.place.lighter.push(lost('all'));
  await h.open(live, NVDA);
  await h.run(live, CHECK_LIGHTER_MS - 3_000);
  assert.deepEqual([s.sent.length, s.reads.length, h.position(live).pending !== null], [1, 0, true], '60 秒之前不按持仓判定');
  await h.run(live, 6_000);
  assert.deepEqual([s.reads, h.orders()], [['lighter'], ['lighter sell 1', 'entropy buy 1']]);
  assert.deepEqual([h.position(live).state, h.position(live).a.qty, h.position(live).a.estimated], ['open', 1, true]);
  near(h.position(live).a.entryQuote, 99.97);
  h.check();

  // 实际没有成交：按持仓认定为 0，放弃。
  const g = harness(t), second = g.boot();
  g.enable(second, [NVDA]);
  g.s.place.lighter.push(lost(0));
  await g.open(second, NVDA);
  await g.run(second, ORDER_EXPIRY_MS.lighter - 10_000, 5_000);
  assert.ok(g.s.reads.length > 50, '到时限后每轮现读账户');
  assert.deepEqual([g.orders(), g.position(second).state, g.position(second).pending?.clientId, second.view().halt], [['lighter sell 1'], 'opening', g.s.sent[0]!.clientId, null],
    'Lighter 的交易过期（约 11 分钟）之前，持仓没变不能算没成交：它还可能被打包');
  await g.run(second, 20_000, 5_000);
  assert.deepEqual([g.orders(), second.view().positions.length, g.trades(second)[0]!.closeReason], [['lighter sell 1'], 0, 'not_filled'], '过期之后账户仍没有变化才放弃');
  g.check();

  // 过期之前这笔单晚到成交了：按持仓认定，接着对冲（不会留下没人管的仓位）。
  const late = harness(t), lateLive = late.boot();
  late.enable(lateLive, [NVDA]);
  late.s.place.lighter.push(lost(0));
  await late.open(lateLive, NVDA);
  await late.run(lateLive, 5 * 60_000, 5_000);
  assert.equal(late.s.sent.length, 1);
  late.s.book.set('lighter:NVDA', -1);
  await late.run(lateLive, 10_000, 5_000);
  assert.deepEqual([late.orders(), late.position(lateLive).state, late.position(lateLive).a.qty], [['lighter sell 1', 'entropy buy 1'], 'open', 1]);
  late.check();

  // Entropy 没有过期机制：持仓没变时还要查单这一次读成功且查无此单，才算没成交；查单一直没读成就继续等。
  const n = harness(t), none = n.boot();
  n.enable(none, [NVDA]);
  n.s.place.entropy.push(lost(0));
  await n.open(none, NVDA);
  await n.run(none, ORDER_EXPIRY_MS.entropy + 60_000, 5_000);
  assert.deepEqual([n.orders(), n.position(none).pending?.leg, n.position(none).state], [['lighter sell 1', 'entropy buy 1'], 'b', 'opening'], '查单没读成时，持仓没变也不认定没成交');
  n.s.resolve.entropy.push(absent());
  await n.run(none, RETRY_MS, RETRY_MS);
  assert.deepEqual(n.orders(2), ['lighter buy 1 R'], '查无此单且持仓没变：第二腿没成交，回补第一腿');
  assert.equal(n.trades(none)[0]!.closeReason, 'single_leg');
  n.check();

  // 过期之前查到「查无此单」不等于没成交。
  const early = harness(t), earlyLive = early.boot();
  early.enable(earlyLive, [NVDA]);
  early.s.place.entropy.push(lost(0));
  await early.open(earlyLive, NVDA);
  for (let index = 0; index < 20; index++) early.s.resolve.entropy.push(absent());
  await early.run(earlyLive, ORDER_EXPIRY_MS.entropy - 10_000, 5_000);
  assert.deepEqual([early.s.sent.length, early.position(earlyLive).pending?.leg], [2, 'b']);
  early.check();

  // Entropy 的第二腿：20 秒后按持仓认定成交了 0.4，A 回补 0.6。
  const e = harness(t), third = e.boot();
  e.enable(third, [NVDA]);
  e.s.place.entropy.push(lost(0.4));
  await e.open(third, NVDA);
  await e.run(third, CHECK_ENTROPY_MS - 3_000);
  assert.deepEqual([e.s.sent.length, e.s.reads.length], [2, 0]);
  await e.run(third, 6_000);
  assert.deepEqual([e.s.reads, e.orders(2)], [['entropy'], ['lighter buy 0.6 R']]);
  assert.deepEqual([e.position(third).state, e.position(third).b.qty, e.position(third).b.estimated, e.position(third).singleLeg], ['open', 0.4, true, true]);
  e.check();

  // 平仓单未知、实际全部平掉：持仓差量按「记录里还没减掉的量」算。
  const c = harness(t), fourth = c.boot();
  c.enable(fourth, [NVDA]);
  await c.open(fourth, NVDA);
  c.s.place.lighter.push(lost('all'));
  await c.closeSignal(fourth, NVDA);
  assert.deepEqual(c.orders(2), ['lighter buy 1 R']);
  await c.run(fourth, CHECK_LIGHTER_MS + 3_000);
  assert.deepEqual([c.orders(3), fourth.view().positions.length, c.trades(fourth)[0]!.a.exitQty, c.trades(fourth)[0]!.a.estimated], [['entropy sell 1 R'], 0, 1, true]);
  c.check();
});

test('查单不明且账户持仓对不上或读不到：不猜、不重发，15 分钟后转人工处理并停止', async t => {
  for (const [label, arrange, reason] of [
    ['账户上多出别的仓位', (s: ReturnType<typeof harness>['s']) => { s.book.set('lighter:NVDA', -3); }, /账户持仓与记录对不上/],
    ['账户方向相反', (s: ReturnType<typeof harness>['s']) => { s.book.set('lighter:NVDA', 0.5); }, /账户持仓与记录对不上/],
    ['账户读不到', (s: ReturnType<typeof harness>['s']) => { s.readFails = true; }, /读账户失败：HTTP 500/],
  ] as [string, (s: ReturnType<typeof harness>['s']) => void, RegExp][]) {
    const h = harness(t), live = h.boot(), s = h.s;
    h.enable(live, [NVDA]);
    s.place.lighter.push(lost(0));
    await h.open(live, NVDA);
    arrange(s);
    await h.run(live, UNKNOWN_STUCK_MS - 10_000, 5_000);
    assert.deepEqual([s.sent.length, h.position(live).state, live.view().halt], [1, 'opening', null], `${label}：15 分钟之前继续等`);
    assert.ok(s.reads.length > 100 && s.reads.every(venue => venue === 'lighter'), `${label}：到时限后每轮都现读账户`);
    await h.run(live, 20_000, 5_000);
    const position = h.position(live);
    assert.deepEqual([s.sent.length, position.state, position.pending?.clientId, position.a.qty], [1, 'stuck', s.sent[0]!.clientId, 0], `${label}：转人工，在途的意图留着供人核对`);
    assert.match(position.note, /^Lighter 有一笔单的结果一直定不下来/, label);
    assert.match(position.note, reason, label);
    assert.match(live.view().halt!, /结果一直定不下来/, label);
    assert.deepEqual(h.alerts().map(item => item.key.split(':')[0]), ['stuck', 'halt'], label);
    // 卡住之后不再查、不再发。
    const asked = s.resolved.length;
    await h.run(live, 60_000, 5_000);
    assert.deepEqual([s.sent.length, s.resolved.length], [1, asked], label);
    assert.ok(s.resolved.every(item => item.clientId === s.sent[0]!.clientId), label);
    h.check();
  }
});

test('进程重启：带着在途意图的持仓先查单，不重发；设置与停止状态也都还在', async t => {
  const h = harness(t), first = h.boot(), s = h.s;
  h.enable(first, [NVDA], { perTradeUsd: 200 });
  // 第二腿发出去之后进程被杀：应答永远没回来。
  s.place.entropy.push('hang');
  commit(first.prepare(NVDA, sig('a_rich', 200), sample(NVDA.key, s.clock, 100.3, 100)));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(h.orders(), ['lighter sell 2', 'entropy buy 2']);
  const saved = h.store.liveActive();
  assert.deepEqual([saved.length, saved[0]!.state, saved[0]!.step, saved[0]!.a.qty, saved[0]!.pending?.leg, saved[0]!.pending?.purpose, saved[0]!.pending?.clientId, saved[0]!.pending?.qty],
    [1, 'opening', 'settle', 2, 'b', 'hedge', s.sent[1]!.clientId, 2], '发送之前意图已落库');
  s.book.set('entropy:io:NVDA', 2);
  // v0.111 及以前写下的持仓带着 paperId：照样接着走，不因为模拟持仓不在了自己平。
  h.store.saveLive({ ...h.store.liveActive()[0]!, paperId: 'p-legacy' });

  s.clock += 3_000;
  const live = h.boot();
  assert.deepEqual([live.settings().on, live.settings().pairs, live.settings().limits.perTradeUsd, live.view().positions.length, live.venueInUse('entropy')], [true, [NVDA.key], 200, 1, true]);
  s.resolve.entropy.push(done(2, null, '查单结果：filled'));
  live.tick(); await live.idle();
  assert.deepEqual(s.resolved, [{ venue: 'entropy', clientId: s.sent[1]!.clientId, sentAt: T0, at: T0 + 3_000 }], '重启后先按原来的自编号查');
  assert.deepEqual(h.orders(), ['lighter sell 2', 'entropy buy 2'], '没有重发');
  assert.deepEqual([h.position(live).state, h.position(live).b.qty, h.position(live).b.estimated, h.position(live).pending], ['open', 2, true, null]);
  // 重启后同配对不会再开一笔。
  await h.open(live, NVDA);
  assert.match(live.view().lastSkip!.reason, /^这个配对已有实盘持仓$/);
  await h.step(live, 1_000);
  assert.deepEqual([h.orders(2), h.position(live).state], [[], 'open'], '旧记录不按 paper_gone 平');
  // 策略的平仓信号到了才平。
  await h.closeSignal(live, NVDA);
  assert.deepEqual(h.orders(2), ['lighter buy 2 R', 'entropy sell 2 R']);
  assert.equal(h.trades(live)[0]!.closeReason, 'revert');
  assert.ok(s.sent[2]!.clientId > s.sent[1]!.clientId, '重启后的自编号仍然更大');

  // 回补的单在途时重启：查到没成交后才重新回补，次数接着算。
  s.place.entropy.push(miss());
  s.place.lighter.push(fill(), 'hang');
  commit(live.prepare(NVDA, sig('a_rich', 100), sample(NVDA.key, s.clock, 100.3, 100)));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(h.orders(4), ['lighter sell 1', 'entropy buy 1', 'lighter buy 1 R']);
  s.clock += 3_000;
  const third = h.boot();
  assert.deepEqual([h.position(third).pending?.purpose, h.position(third).tries, h.position(third).singleLeg], ['flatten', 1, true]);
  s.resolve.lighter.push(done(0, null, '交易所查无此单'));
  third.tick(); await third.idle();
  assert.deepEqual(h.orders(7), ['lighter buy 1 R']);
  assert.equal(h.trades(third)[0]!.closeReason, 'single_leg');

  // 停止状态跨重启保留。
  s.place.entropy.push(miss());
  s.place.lighter.push(fill(), miss(), miss(), miss());
  await h.open(third, NVDA);
  await h.run(third, 4 * RETRY_MS, RETRY_MS);
  assert.equal(h.position(third).state, 'stuck');
  const fourth = h.boot();
  assert.match(fourth.view().halt!, /需要人工处理/);
  assert.deepEqual([h.position(fourth).state, liveError(() => fourth.resume())], ['stuck', ['busy', 409]]);
  const before = s.sent.length;
  await h.run(fourth, 60_000, 5_000);
  assert.equal(s.sent.length, before, '重启后卡住的持仓仍然不动');
  h.check();
});

test('进程重启：第一腿发出后、结果回来之前重启，查到结果后不能把第一腿再发一遍', async t => {
  // 查到已全部成交 → 应当直接去下第二腿。
  const h = harness(t), first = h.boot(), s = h.s;
  h.enable(first, [NVDA]);
  s.place.lighter.push('hang');
  commit(first.prepare(NVDA, sig('a_rich', 100), sample(NVDA.key, s.clock, 100.3, 100)));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(h.orders(), ['lighter sell 1']);
  assert.deepEqual([h.store.liveActive()[0]!.pending?.purpose, h.store.liveActive()[0]!.pending?.clientId, h.store.liveActive()[0]!.step], ['open', s.sent[0]!.clientId, 'b'], '步骤与在途意图同一次落库');
  s.book.set('lighter:NVDA', -1);
  s.clock += 3_000;
  const live = h.boot();
  s.resolve.lighter.push(done(1, 100.25, '已成交'));
  live.tick(); await live.idle();
  assert.deepEqual(s.resolved.map(item => item.clientId), [s.sent[0]!.clientId]);
  assert.deepEqual(h.orders(), ['lighter sell 1', 'entropy buy 1'], '第一腿已成交 1，只该补第二腿 1；不能再卖一次');
  assert.deepEqual([h.position(live).state, h.position(live).a.qty, h.position(live).b.qty], ['open', 1, 1]);
  h.check();

  // 查到没有成交 → 应当放弃（与不重启时一致），不自动再发。
  const g = harness(t), before = g.boot();
  g.enable(before, [NVDA]);
  g.s.place.lighter.push('hang');
  commit(before.prepare(NVDA, sig('a_rich', 100), sample(NVDA.key, g.s.clock, 100.3, 100)));
  await new Promise(resolve => setTimeout(resolve, 20));
  g.s.clock += 20_000;
  const after = g.boot();
  g.s.resolve.lighter.push(done(0, null, '交易所查无此单'));
  after.tick(); await after.idle();
  assert.deepEqual(g.orders(), ['lighter sell 1'], '第一腿没成交就放弃，不拿 20 秒前的限价再发一遍');
  assert.deepEqual([after.view().positions.length, g.trades(after)[0]?.closeReason], [0, 'not_filled']);
  g.check();
});

test('平仓重试：部分成交后接着平剩下的；一直平不掉到上限后转人工并停止；没有报价时等', async t => {
  const h = harness(t), live = h.boot(), s = h.s;
  h.enable(live, [NVDA]);
  await h.open(live, NVDA);
  // A 分三次平完（0.4、0、0.6），中间没成交的那次之后等 5 秒。
  s.place.lighter.push(fill(0.4, 100.3), miss(), fill(0.6, 100.4));
  s.place.entropy.push(fill(1, 100));
  await h.closeSignal(live, NVDA);
  assert.deepEqual(h.orders(2), ['lighter buy 1 R', 'lighter buy 0.6 R'], '部分成交后马上接着平');
  assert.deepEqual([h.position(live).state, h.position(live).a.exitQty, h.position(live).tries, h.position(live).closeReason], ['closing', 0.4, 2, 'revert']);
  await h.step(live, RETRY_MS - 1);
  assert.equal(s.sent.length, 4);
  await h.step(live, 1);
  assert.deepEqual(h.orders(4), ['lighter buy 0.6 R', 'entropy sell 1 R']);
  const trade = h.trades(live)[0]!;
  assert.deepEqual([trade.closeReason, trade.a.exitQty, trade.b.exitQty, s.book.get('lighter:NVDA'), s.book.get('entropy:io:NVDA')], ['revert', 1, 1, 0, 0]);
  near(trade.a.exitQuote, 0.4 * 100.3 + 0.6 * 100.4);

  // 没有报价：不发单、不消耗次数。
  await h.open(live, NVDA);
  s.quotes.set('lighter:NVDA', null);
  await h.closeSignal(live, NVDA);
  await h.run(live, 30_000, 5_000);
  assert.deepEqual([s.sent.length, h.position(live).state, h.position(live).tries], [8, 'closing', 0]);
  s.quotes.set('lighter:NVDA', { bid: 100.29, ask: 100.31 });

  // 一直没成交：共 10 次，保护价逐步放宽（封顶 300 基点），之后转人工。
  for (let index = 0; index < 10; index++) s.place.lighter.push(miss());
  await h.run(live, 9 * RETRY_MS + RETRY_MS, RETRY_MS);
  assert.deepEqual(h.orders(8), Array(10).fill('lighter buy 1 R'));
  const limits = s.sent.slice(8).map(item => item.limit);
  assert.ok(limits.every((limit, index) => index === 0 || limit >= limits[index - 1]!) && limits[9]! > limits[0]! && limits[9]! <= 100.31 * 1.0301, `保护价 ${limits.join(' ')}`);
  assert.deepEqual([h.position(live).state, live.view().halt], ['closing', null]);
  await h.step(live, RETRY_MS);
  assert.equal(s.sent.length, 18, '第 11 次不发');
  assert.deepEqual([h.position(live).state, h.position(live).note], ['stuck', 'Lighter 剩余 1.000000 平不掉']);
  assert.match(live.view().halt!, /平不掉/);
  assert.deepEqual(h.alerts().map(item => item.key.split(':')[0]), ['stuck', 'halt']);
  assert.equal(s.book.get('entropy:io:NVDA'), 1, 'B 腿还没轮到平，留给人处理');
  h.check();
});

test('手动平仓、只按策略信号平仓、开仓途中收到平仓信号', async t => {
  const h = harness(t), live = h.boot(), s = h.s;
  h.enable(live, [NVDA]);
  await h.open(live, NVDA);
  const id = h.position(live).id;
  for (const body of [null, {}, { id: 7 }, { id: 'nope' }, [id]]) assert.deepEqual(liveError(() => live.close(body)), ['not_found', 404], JSON.stringify(body));
  // 手动平仓途中（A 的平仓单未知）再点一次：拒绝。
  s.place.lighter.push(lost('all'));
  assert.deepEqual(live.close({ id }), { ok: true });
  await live.idle();
  assert.deepEqual(liveError(() => live.close({ id })), ['busy', 409]);
  s.resolve.lighter.push(done(1, 100.3));
  await h.run(live, RETRY_MS);
  assert.deepEqual([h.orders(2), h.trades(live)[0]!.closeReason], [['lighter buy 1 R', 'entropy sell 1 R'], 'manual']);
  assert.deepEqual(liveError(() => live.close({ id })), ['not_found', 404], '已结束的不能再平');

  // 持有中：没有平仓信号就一直持有；信号带的原因记在持仓上。
  await h.open(live, NVDA);
  await h.run(live, 5_000);
  assert.deepEqual([h.orders(6), h.position(live).state], [[], 'open']);
  await h.closeSignal(live, NVDA, 'timeout');
  assert.deepEqual([h.orders(6), h.trades(live)[0]!.closeReason], [['lighter buy 1 R', 'entropy sell 1 R'], 'timeout']);
  // 没有持仓的配对收到平仓信号：什么也不做。
  await h.closeSignal(live, GOLD);
  assert.equal(s.sent.length, 8);

  // 开仓途中（第一腿结果未知）策略就给了平仓信号：不动，先把开仓走完；持有后策略下一次判断再给信号时平掉，不留仓位。
  s.place.lighter.push(lost('all'));
  await h.open(live, NVDA);
  await h.closeSignal(live, NVDA, 'stop');
  assert.deepEqual([h.orders(8), h.position(live).state], [['lighter sell 1'], 'opening'], '开仓没走完时不发平仓单');
  s.resolve.lighter.push(done(1, null));
  await h.run(live, RETRY_MS);
  await h.run(live, 2_000);
  assert.deepEqual([h.orders(8), h.position(live).state, h.position(live).closeReason], [['lighter sell 1', 'entropy buy 1'], 'open', null]);
  await h.closeSignal(live, NVDA, 'stop');
  assert.deepEqual(h.orders(8), ['lighter sell 1', 'entropy buy 1', 'lighter buy 1 R', 'entropy sell 1 R']);
  assert.deepEqual([live.view().positions.length, s.book.get('lighter:NVDA'), s.book.get('entropy:io:NVDA')], [0, 0, 0]);
  h.check();
});

test('对账：记录与账户持仓连续两次对不上才停止，只一次不停；太旧的账户读数不用；对账自己不发单', async t => {
  const h = harness(t), live = h.boot(), s = h.s;
  h.enable(live, [NVDA]);
  await h.open(live, NVDA);
  // 账户读数停在开仓那一刻（动作结束后 10 秒内的读数不用）：即使对不上也不计。
  s.accountAt = { lighter: T0 + 5_000, entropy: T0 + 5_000 };
  s.book.set('lighter:NVDA', -3);
  await h.run(live, 5 * RECONCILE_MS);
  assert.equal(live.view().halt, null, '读数早于动作结束，不拿来对账');
  // 读数新了、持仓对得上。
  s.accountAt = {};
  s.book.set('lighter:NVDA', -1);
  await h.run(live, 2 * RECONCILE_MS);
  assert.equal(live.view().halt, null);
  // 只对不上一次（下一次又对上了）：不停止。
  s.book.set('lighter:NVDA', -3);
  await h.run(live, RECONCILE_MS);
  assert.equal(live.view().halt, null, '一次对不上不停止');
  s.book.set('lighter:NVDA', -1);
  await h.run(live, RECONCILE_MS);
  s.book.set('entropy:io:NVDA', 0);
  await h.run(live, RECONCILE_MS);
  assert.equal(live.view().halt, null, '中间对上过，重新计数');
  // 连续第二次：停止并告警，写明哪条腿差多少。
  await h.run(live, RECONCILE_MS);
  assert.equal(live.view().halt, '账户持仓与实盘记录对不上：Entropy io:NVDA 记录 1.000000、账户 0.000000');
  assert.deepEqual(h.alerts().map(item => [item.key.split(':')[0], item.text.includes('账户持仓与实盘记录对不上')]), [['halt', true]]);
  assert.deepEqual([s.sent.length, s.resolved.length, h.position(live).state], [2, 0, 'open'], '对账不发单，持仓状态不变');
  // 停止后：不开新仓；已有持仓仍按平仓信号平（只减仓）。
  await h.closeSignal(live, NVDA);
  assert.deepEqual(h.orders(2), ['lighter buy 1 R', 'entropy sell 1 R']);
  await h.open(live, NVDA);
  assert.match(live.view().lastSkip!.reason, /^实盘已停止：账户持仓与实盘记录对不上/);
  // 恢复后重新计数：恢复后的第一次对不上不会马上再停。
  live.resume();
  s.book.clear();
  await h.open(live, NVDA);
  s.book.set('lighter:NVDA', -2);
  await h.run(live, RECONCILE_MS + 15_000);
  assert.equal(live.view().halt, null);
  await h.run(live, RECONCILE_MS);
  assert.match(live.view().halt!, /Lighter NVDA 记录 -1\.000000、账户 -2\.000000/);
  h.check();
});

test('持仓途中凭据被移除或凭据文件读不懂：还没发过单的放弃；发过单的转人工并停止，不再发任何单', async t => {
  // 还没发过单（目录还没取到，持仓停在第一步）时凭据没了：放弃。
  const h = harness(t), live = h.boot(), s = h.s;
  h.enable(live, [NVDA]);
  h.store.saveLive(intent(s.clock));
  s.keys = { entropy: ALL_KEYS.entropy };
  const reborn = h.boot();
  reborn.tick(); await reborn.idle();
  assert.deepEqual([s.sent.length, reborn.view().positions.length, h.trades(reborn)[0]!.closeReason, h.trades(reborn)[0]!.note, reborn.view().halt], [0, 0, 'not_filled', '凭据已不在，没有下单', null]);
  h.check();

  // 第一腿结果未知时凭据被移除：没法查单，转人工。
  const g = harness(t), second = g.boot();
  g.enable(second, [NVDA]);
  g.s.place.lighter.push(lost('all'));
  await g.open(second, NVDA);
  g.s.keys = { entropy: ALL_KEYS.entropy };
  await g.step(second, UNKNOWN_FIRST_MS);
  assert.deepEqual([g.s.sent.length, g.s.resolved.length, g.position(second).state, g.position(second).note, g.position(second).pending?.clientId], [1, 0, 'stuck', '交易凭据已不在，无法继续下单', g.s.sent[0]!.clientId]);
  assert.match(second.view().halt!, /交易凭据已不在/);
  assert.deepEqual(g.alerts().map(item => item.key.split(':')[0]), ['stuck', 'halt']);
  g.check();

  // 持仓中另一条腿的凭据被移除：持有期间不动，平仓信号来了平不了，转人工；一笔平仓单都不发（不留半边）。
  const e = harness(t), third = e.boot();
  e.enable(third, [NVDA]);
  await e.open(third, NVDA);
  e.s.keys = { lighter: ALL_KEYS.lighter };
  await e.run(third, 30_000, 5_000);
  assert.deepEqual([e.position(third).state, third.view().halt], ['open', null]);
  await e.closeSignal(third, NVDA);
  assert.deepEqual([e.s.sent.length, e.position(third).state, e.position(third).note], [2, 'stuck', '交易凭据已不在，无法继续下单']);
  e.check();

  // 凭据文件读不懂与被移除同样处理。
  const c = harness(t), fourth = c.boot();
  c.enable(fourth, [NVDA]);
  await c.open(fourth, NVDA);
  c.s.keysProblem = '实盘凭据文件读不懂，未使用：不是有效的 JSON';
  await c.closeSignal(fourth, NVDA);
  assert.deepEqual([c.s.sent.length, c.position(fourth).state], [2, 'stuck']);
  // 凭据回来后：仍然要人处理（dismiss），不会自己接着发单。
  c.s.keysProblem = null;
  await c.run(fourth, 30_000, 5_000);
  assert.deepEqual([c.s.sent.length, c.position(fourth).state], [2, 'stuck']);
  c.check();
});

test('实盘设置：未知字段、越界、未知配对键一律拒绝且不改现有设置；合法设置去重排序并落库', t => {
  const h = harness(t), live = h.boot();
  const limits = DEFAULT_LIVE_SETTINGS.limits, known = (key: string) => h.s.pairs.has(key);
  const good = { on: true, pairs: [NVDA.key], limits };
  const bad: [string, unknown][] = [
    ['null', null], ['数组', []], ['字符串', 'on'],
    ['未知字段', { ...good, extra: 1 }], ['未知字段 halt', { ...good, halt: null }], ['on 不是布尔', { ...good, on: 'true' }], ['on 是 1', { ...good, on: 1 }],
    ['pairs 不是数组', { ...good, pairs: NVDA.key }], ['未知配对键', { ...good, pairs: ['lighter:NOPE|entropy:NOPE'] }], ['配对键不是字符串', { ...good, pairs: [7] }],
    ['有一个未知配对键', { ...good, pairs: [NVDA.key, 'x'] }], ['超过 50 个配对', { ...good, pairs: Array(51).fill(NVDA.key) }],
    ['limits 不是对象', { ...good, limits: [] }], ['limits 未知字段', { ...good, limits: { ...limits, leverage: 5 } }], ['limits 缺字段', { ...good, limits: { perTradeUsd: 100, maxOpen: 1, dailyLossUsd: 20 } }],
    ...([['perTradeUsd', 9.99], ['perTradeUsd', 100_001], ['perTradeUsd', '100'], ['perTradeUsd', NaN], ['perTradeUsd', Infinity], ['perTradeUsd', -100], ['maxOpen', 0], ['maxOpen', 21], ['maxOpen', 1.5],
      ['dailyLossUsd', 0], ['dailyLossUsd', 0.99], ['dailyLossUsd', 100_001], ['dailyLossUsd', null], ['slippageBps', 0], ['slippageBps', 301], ['slippageBps', -1]] as [keyof LiveLimits, unknown][])
      .map(([key, value]): [string, unknown] => [`${key} = ${String(value)}`, { ...good, limits: { ...limits, [key]: value } }]),
  ];
  for (const [label, body] of bad) {
    assert.deepEqual(liveError(() => live.update(body, known)), ['invalid_params', 400], label);
    assert.deepEqual([live.settings(), h.store.state(LIVE_SETTINGS_KEY)], [DEFAULT_LIVE_SETTINGS, null], `${label}：被拒的设置不生效、不落库`);
  }
  // 报错不回显提交的值。
  try { live.update({ ...good, pairs: ['secret-pair-key'] }, known); assert.fail('应当被拒'); } catch (error) { assert.ok(!(error as Error).message.includes('secret-pair-key')); }
  // 可以只带一部分字段，没带的保持原值；没带 pairs 时，原有配对即使已不在目录里也留着。
  assert.deepEqual(live.update({ pairs: [NVDA.key] }, known), { on: false, pairs: [NVDA.key], limits });
  assert.deepEqual(live.update({ limits: { ...limits, perTradeUsd: 50 } }, known), { on: false, pairs: [NVDA.key], limits: { ...limits, perTradeUsd: 50 } });
  assert.deepEqual(live.update({ on: true }, () => false), { on: true, pairs: [NVDA.key], limits: { ...limits, perTradeUsd: 50 } }, '只开总开关：配对与限额不动');
  assert.deepEqual(liveError(() => live.update({ pairs: [NVDA.key] }, () => false)), ['invalid_params', 400], '带了 pairs 就要按目录核对');
  assert.deepEqual(liveError(() => live.update({ on: 'yes' }, known)), ['invalid_params', 400]);
  assert.equal(live.settings().on, true);
  assert.deepEqual(live.update({ on: false }, known).on, false);
  // 边界值可以；配对去重排序。
  const edge = { perTradeUsd: 10, maxOpen: 20, dailyLossUsd: 100_000, slippageBps: 300 };
  assert.deepEqual(live.update({ on: true, pairs: [NVDA.key, GOLD.key, NVDA.key], limits: edge }, known), { on: true, pairs: [GOLD.key, NVDA.key].sort(), limits: edge });
  assert.deepEqual(h.store.state(LIVE_SETTINGS_KEY), live.settings());
  assert.deepEqual(h.boot().settings(), live.settings(), '重启后还在');
  assert.ok(h.events().some(text => /^实盘设置已更新：总开关开，配对 2 个，单笔 10 美元、最多 20 笔、当日亏损上限 100000 美元$/.test(text)));
  // 库里的设置坏了（旧版本、手改）：按默认（关）处理，不带着半懂的限额开实盘。
  h.store.setState(LIVE_SETTINGS_KEY, { on: true, pairs: [NVDA.key], limits: { ...limits, perTradeUsd: 1e9 } }, T0);
  assert.deepEqual(h.boot().settings(), DEFAULT_LIVE_SETTINGS);
  h.store.setState(LIVE_SETTINGS_KEY, { on: true, pairs: [NVDA.key], limits, extra: true }, T0);
  assert.deepEqual(h.boot().settings(), DEFAULT_LIVE_SETTINGS);
  // 目录里已经没有的配对：读设置时保留（开仓时再看）。
  h.store.setState(LIVE_SETTINGS_KEY, { on: true, pairs: ['rh:GONE|lighter:GONE'], limits }, T0);
  assert.deepEqual(h.boot().settings().pairs, ['rh:GONE|lighter:GONE']);
  h.check();
});

test('凭据占用：有未结束持仓（含开仓途中、平仓途中）的场所算在用，结束后释放', async t => {
  const h = harness(t), live = h.boot(), s = h.s;
  h.enable(live, [NVDA, GOLD], { maxOpen: 2 });
  assert.deepEqual((['lighter', 'rh', 'entropy'] as const).map(venue => live.venueInUse(venue)), [false, false, false]);
  s.place.lighter.push(lost('all'));
  await h.open(live, NVDA);
  assert.deepEqual((['lighter', 'rh', 'entropy'] as const).map(venue => live.venueInUse(venue)), [true, false, true], '开仓途中两条腿都算在用（第二腿还没发也算）');
  s.resolve.lighter.push(done(1, null));
  await h.run(live, RETRY_MS);
  s.place.entropy.push(lost('all'));
  await h.closeSignal(live, NVDA);
  assert.deepEqual([h.position(live).state, live.venueInUse('lighter'), live.venueInUse('entropy')], ['closing', true, true], '平仓途中仍算在用');
  s.resolve.entropy.push(done(1, null));
  await h.run(live, RETRY_MS);
  assert.deepEqual((['lighter', 'rh', 'entropy'] as const).map(venue => live.venueInUse(venue)), [false, false, false]);
  await h.open(live, GOLD);
  assert.deepEqual((['lighter', 'rh', 'entropy'] as const).map(venue => live.venueInUse(venue)), [true, true, false]);
  h.check();
});

test('开仓意图落库后没能马上发出（进程重启）：还新鲜且条件都在才发第一腿；过期、总开关已关、配对取消勾选或已停止时作废，不按旧限价补发', async t => {
  for (const [label, arrange, sends] of [
    ['3 秒后重启，条件都在', () => {}, true],
    ['16 秒后重启', (s: ReturnType<typeof harness>['s']) => { s.clock += 13_000; }, false],
  ] as [string, (s: ReturnType<typeof harness>['s']) => void, boolean][]) {
    const h = harness(t), s = h.s;
    h.enable(h.boot(), [NVDA]);
    h.store.saveLive(intent(s.clock));
    s.clock += 3_000;
    arrange(s);
    const live = h.boot();
    live.tick(); await live.idle();
    if (sends) assert.deepEqual([h.orders(), h.position(live).state], [['lighter sell 1', 'entropy buy 1'], 'open'], label);
    else assert.deepEqual([s.sent.length, live.view().positions.length, h.trades(live)[0]!.closeReason, h.trades(live)[0]!.note], [0, 0, 'not_filled', '开仓意图已过期，没有下单'], label);
    h.check();
  }
  // 总开关已关、配对取消勾选、已停止。
  for (const [label, arrange] of [['总开关已关', (h: ReturnType<typeof harness>) => { h.boot().update({ on: false }, () => true); }], ['配对取消勾选', (h: ReturnType<typeof harness>) => { h.boot().update({ pairs: [GOLD.key] }, () => true); }], ['已停止', (h: ReturnType<typeof harness>) => { h.store.setState(LIVE_RUNTIME_KEY, { halt: '人工停止', paused: {}, singles: {} }, T0); }]] as [string, (h: ReturnType<typeof harness>) => void][]) {
    const h = harness(t);
    h.enable(h.boot(), [NVDA]);
    h.store.saveLive(intent(h.s.clock));
    arrange(h);
    const live = h.boot();
    live.tick(); await live.idle();
    assert.deepEqual([h.s.sent.length, live.view().positions.length, h.trades(live)[0]!.note], [0, 0, '开仓意图已过期，没有下单'], label);
    h.check();
  }
});

test('成交量超过委托量的回报不可信：按结果未知处理，不照着它对冲，等账户持仓核对', async t => {
  const h = harness(t), live = h.boot(), s = h.s;
  h.enable(live, [NVDA]);
  // 委托 1，回报说成交了 100（单位读错）；交易所那边实际成交 1。
  s.place.lighter.push({ outcome: done(100, 100.25), real: 1 });
  await h.open(live, NVDA);
  assert.deepEqual([h.orders(), h.position(live).a.qty, h.position(live).pending?.leg], [['lighter sell 1'], 0, 'a'], '不按 100 去下第二腿');
  // 查单回来的数量同样离谱：也不信。
  s.resolve.lighter.push(done(100, 100.25));
  await h.run(live, 10_000);
  assert.deepEqual([s.sent.length, h.position(live).a.qty], [1, 0]);
  await h.run(live, CHECK_LIGHTER_MS, 5_000);
  assert.deepEqual([h.orders(), h.position(live).state, h.position(live).a.qty, h.position(live).b.qty], [['lighter sell 1', 'entropy buy 1'], 'open', 1, 1]);
  // 负数、NaN 的成交量一样不信。
  await h.closeSignal(live, NVDA);
  for (const bad of [-1, NaN]) {
    const from = s.sent.length;
    s.place.lighter.push({ outcome: done(bad, 100.25), real: 0 });
    await h.open(live, NVDA);
    assert.deepEqual([h.orders(from), h.position(live).pending?.leg], [['lighter sell 1'], 'a'], String(bad));
    s.resolve.lighter.push(done(0, null, '交易所撤销'));
    await h.run(live, RETRY_MS);
    assert.equal(live.view().positions.length, 0);
  }
  h.check();
});

test('回补或平仓一直取不到报价：一分钟后告警，十分钟后转人工并停止，期间不发单', async t => {
  const h = harness(t), live = h.boot(), s = h.s;
  h.enable(live, [NVDA]);
  await h.open(live, NVDA);
  s.quotes.set('lighter:NVDA', null);
  await h.closeSignal(live, NVDA);
  await h.run(live, 55_000, 5_000);
  assert.deepEqual([h.alerts(), h.position(live).state], [[], 'closing']);
  await h.run(live, 10_000, 5_000);
  assert.deepEqual(h.alerts().map(item => [item.key.split(':')[0], /要平仓但 Lighter 取不到报价/.test(item.text)]), [['noquote', true]]);
  await h.run(live, 8 * 60_000, 5_000);
  assert.deepEqual([h.position(live).state, live.view().halt, h.alerts().length, s.sent.length], ['closing', null, 1, 2]);
  await h.run(live, 60_000, 5_000);
  assert.deepEqual([h.position(live).state, h.position(live).note, s.sent.length], ['stuck', 'Lighter 一直取不到报价，剩余持仓平不掉', 2]);
  assert.match(live.view().halt!, /一直取不到报价/);
  h.check();

  // 中途报价回来：照常平掉，计时清零。
  const g = harness(t), other = g.boot();
  g.enable(other, [NVDA]);
  await g.open(other, NVDA);
  g.s.quotes.set('lighter:NVDA', null);
  await g.closeSignal(other, NVDA);
  await g.run(other, 5 * 60_000, 5_000);
  g.s.quotes.set('lighter:NVDA', { bid: 100.29, ask: 100.31 });
  await g.run(other, RETRY_MS, RETRY_MS);
  assert.deepEqual([g.orders(2), other.view().positions.length, other.view().halt], [['lighter buy 1 R', 'entropy sell 1 R'], 0, null]);
  g.check();
});

test('没有实盘持仓时也对账：总开关开着，勾选配对的合约上出现不属于实盘的仓位，连续两次就停止（L205）', async t => {
  const h = harness(t), live = h.boot(), s = h.s;
  h.enable(live, [NVDA]);
  await h.run(live, 3 * RECONCILE_MS, 5_000);
  assert.equal(live.view().halt, null, '账户是空的：不停止');
  s.book.set('entropy:io:NVDA', 0.5);
  await h.run(live, RECONCILE_MS, 5_000);
  assert.equal(live.view().halt, null);
  await h.run(live, RECONCILE_MS, 5_000);
  assert.equal(live.view().halt, '账户持仓与实盘记录对不上：Entropy io:NVDA 记录 0.000000、账户 0.500000');
  const before = s.sent.length;
  await h.open(live, NVDA);
  assert.deepEqual([s.sent.length, before], [0, 0], '不在有手动仓位的账户上开仓');

  // 总开关关着、没有持仓：不核对。
  const g = harness(t), off = g.boot();
  off.update({ on: false, pairs: [NVDA.key] }, () => true);
  g.s.book.set('entropy:io:NVDA', 0.5);
  await g.run(off, 5 * RECONCILE_MS, 5_000);
  assert.equal(off.view().halt, null);
  // 有持仓而账户一直读不到：十分钟后告警（不停止）。
  const b = harness(t), blind = b.boot();
  b.enable(blind, [NVDA]);
  await b.open(blind, NVDA);
  b.s.accountAt = { lighter: T0, entropy: T0 };
  await b.run(blind, 9 * 60_000, 5_000);
  assert.deepEqual(b.alerts(), []);
  await b.run(blind, 6 * 60_000, 5_000);
  assert.deepEqual([b.alerts().map(item => [item.key.split(':')[0], /读不到，有实盘持仓无法对账/.test(item.text)]), blind.view().halt], [[['blind', true]], null]);
  h.check(); g.check(); b.check();
});

test('服务正在停止：不再推进、不再发单；重启后从库里接着走', async t => {
  const h = harness(t), live = h.boot(), s = h.s;
  h.enable(live, [NVDA]);
  await h.open(live, NVDA);
  s.stopped = true;
  await h.closeSignal(live, NVDA);
  await h.run(live, 30_000, 5_000);
  assert.deepEqual([s.sent.length, h.position(live).state], [2, 'closing'], '停止过程中不发平仓单');
  s.stopped = false;
  const again = h.boot();
  again.tick(); await again.idle();
  assert.deepEqual([h.orders(2), h.trades(again)[0]!.closeReason], [['lighter buy 1 R', 'entropy sell 1 R'], 'revert']);
  h.check();
});

test('第一腿成交后落库失败：不重发第一腿；重启后按库里的在途意图查单，查到成交接着下第二腿', async t => {
  const h = harness(t), live = h.boot(), s = h.s;
  h.enable(live, [NVDA]);
  // 第一腿发出前的两次落库（自编号、意图）都成功，回来之后记成交的那次落库失败。
  const original = h.store.saveLive.bind(h.store);
  let saves = 0, failed = false;
  (h.store as { saveLive: (position: LivePosition) => void }).saveLive = position => {
    if (position.pending === null && position.a.qty > 0 && !failed) { failed = true; throw new Error('disk I/O error'); }
    saves++; original(position);
  };
  s.place.lighter.push('hang');
  commit(live.prepare(NVDA, sig('a_rich', 100), sample(NVDA.key, s.clock, 100.3, 100)));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(saves > 0);
  assert.equal(h.store.liveActive()[0]!.pending?.purpose, 'open', '发单前意图已落库');
  // 换一个进程（上一个卡在等应答）：这次让第一腿的应答回来，但记成交的落库失败。
  s.book.set('lighter:NVDA', -1);
  const second = h.boot();
  s.resolve.lighter.push(done(1, 100.25, '已成交'));
  second.tick();
  await second.idle().catch(() => undefined);
  assert.equal(failed, true, '记成交的那次落库失败了');
  assert.deepEqual(h.orders().filter(item => item.startsWith('lighter sell')), ['lighter sell 1'], '落库失败也不重发第一腿');
  assert.equal(h.store.liveActive()[0]!.pending?.leg === 'a' || h.store.liveActive()[0]!.a.qty === 1, true, '库里要么还留着在途意图，要么已记下成交');
  // 再重启一次：库里若还是在途意图，只查单、不重发。
  const third = h.boot();
  s.resolve.lighter.push(done(1, 100.25, '已成交'));
  await h.run(third, 10_000, 1_000);
  assert.deepEqual(h.orders().filter(item => item.startsWith('lighter sell')), ['lighter sell 1'], '重启后也只有一笔第一腿');
  assert.equal(h.orders().filter(item => item === 'entropy buy 1').length, 1, '第二腿只下一次');
  assert.deepEqual([s.book.get('lighter:NVDA'), s.book.get('entropy:io:NVDA')], [-1, 1]);
  h.check();
});

test('乘数除不尽的取整余量：不到第二腿一个步长的等值，不算单腿、不回补，平仓时两腿各自平掉', async t => {
  const h = harness(t), live = h.boot(), s = h.s;
  // 乘数 3，第二腿步长 1：第一腿成交 0.5 → 第二腿 floor(1.5) = 1，第一腿余 0.5 − 1/3 ≈ 0.16，不到 B 一个步长的等值（1/3）。
  const coarse = pairOf(GOLD.a, { ...GOLD.b, market: { ...GOLD.b.market, sizeDecimals: 0, minBase: 1, minQuote: 0 } }, 3);
  s.pairs.set(coarse.key, coarse);
  s.quotes.set('rh:XAU', { bid: 300.89, ask: 300.91 });
  h.enable(live, [coarse], { perTradeUsd: 300 });
  s.place.rh.push(fill(0.5));
  await h.open(live, coarse, { aMid: 300.9, bMid: 100, notionalUsd: 300 });
  const position = h.position(live, coarse);
  assert.deepEqual([position.state, position.singleLeg, position.a.qty, position.a.exitQty, position.b.qty], ['open', false, 0.5, 0, 1], JSON.stringify(h.orders()));
  assert.ok(!h.orders().some(item => item.endsWith(' R')), '没有回补单');
  await h.closeSignal(live, coarse);
  assert.deepEqual(h.orders().slice(-2), ['rh buy 0.5 R', 'lighter sell 1 R']);
  assert.deepEqual([h.trades(live)[0]!.singleLeg, h.trades(live)[0]!.closeReason], [false, 'revert']);
  h.check();
});

test('重启后告警重新给出：已停止与需要人工处理的持仓各一条，键与重启前相同', async t => {
  const h = harness(t), live = h.boot(), s = h.s;
  h.enable(live, [NVDA]);
  s.place.lighter.push(lost());
  await h.open(live, NVDA);
  s.readFails = true;
  await h.run(live, 16 * 60_000, 60_000);
  const before = live.alerts().map(item => item.key).sort();
  assert.deepEqual(before.map(key => key.split(':')[0]), ['halt', 'stuck']);
  const again = h.boot();
  assert.deepEqual(again.alerts().map(item => item.key).sort(), before, '重启后同样的告警、同样的键');
  assert.ok(again.alerts().every(item => item.text.length > 0));
  h.check();
});

test('发第一腿前核对两腿此刻的报价：样本里的价差已不存在（B 的卖一越过预演限价）就不跟，不发任何单', async t => {
  const h = harness(t), live = h.boot(), s = h.s;
  h.enable(live, [NVDA]);
  // 样本说 B 中间价 100，但 Entropy 此刻卖一已到 101：按样本下 A、再按当前价对冲 B 会直接亏掉价差。
  s.quotes.set('entropy:NVDA', { bid: 100.99, ask: 101.01 });
  await h.open(live, NVDA);
  assert.deepEqual(h.orders(), []);
  assert.match(live.view().lastSkip?.reason ?? '', /Entropy 此刻的卖一 101\.01 已越过限价/);
  // A 的买一跌破了卖出限价：同样不跟。
  s.quotes.set('entropy:NVDA', { bid: 99.99, ask: 100.01 });
  s.quotes.set('lighter:NVDA', { bid: 99.5, ask: 99.52 });
  await h.open(live, NVDA);
  assert.deepEqual(h.orders(), []);
  assert.match(live.view().lastSkip?.reason ?? '', /Lighter 此刻的买一 99\.5 已越过限价/);
  // 报价回到样本附近：照常跟。
  s.quotes.set('lighter:NVDA', { bid: 100.29, ask: 100.31 });
  await h.open(live, NVDA);
  assert.deepEqual(h.orders(), ['lighter sell 1', 'entropy buy 1']);
  h.check();
});

test('恢复后又因同样的原因停止：告警键不同，执行服务会再发一次通知；重启后键不变', async t => {
  const h = harness(t), live = h.boot(), s = h.s;
  h.enable(live, [NVDA]);
  // 账户上凭空多出一笔不属于实盘的仓位：连续两次对不上就停止。
  s.book.set('entropy:io:NVDA', 0.5);
  await h.run(live, 3 * RECONCILE_MS, 30_000);
  const first = live.alerts().filter(item => item.key.startsWith('halt:')).map(item => item.key);
  assert.equal(first.length, 1);
  live.resume();
  await h.run(live, 3 * RECONCILE_MS, 30_000);
  const keys = live.alerts().filter(item => item.key.startsWith('halt:')).map(item => item.key);
  assert.equal(keys.length, 2, '第二次停止要有新的告警');
  assert.notEqual(keys[0], keys[1]);
  assert.equal(live.alerts().find(item => item.key === keys[0])!.text, live.alerts().find(item => item.key === keys[1])!.text, '原因文字相同');
  assert.deepEqual(h.boot().alerts().filter(item => item.key.startsWith('halt:')).map(item => item.key), [keys[1]], '重启后给出的是这一次停止的键');
  h.check();
});

test('服务在两腿之间开始停止：不落第二腿的意图、不发单；重启后从第二腿接着对冲，不算单腿', async t => {
  const h = harness(t), live = h.boot(), s = h.s;
  h.enable(live, [NVDA]);
  s.place.lighter.push({ outcome: order => { s.stopped = true; return done(order.qty, order.limit); } });
  await h.open(live, NVDA);
  assert.deepEqual(h.orders(), ['lighter sell 1'], '停止后不再发第二腿');
  const saved = h.store.liveActive()[0]!;
  assert.deepEqual([saved.pending, saved.step, saved.a.qty, saved.singleLeg], [null, 'b', 1, false], '库里没有一笔从没发出的「在途」单');
  s.stopped = false;
  const again = h.boot();
  again.tick(); await again.idle();
  assert.deepEqual(h.orders(), ['lighter sell 1', 'entropy buy 1']);
  assert.deepEqual([h.position(again).state, h.position(again).singleLeg], ['open', false]);
  h.check();
});

test('落意图失败：内存退回发送前，不发单，也不留一笔「结果不明」去等过期', async t => {
  const h = harness(t), live = h.boot(), s = h.s;
  h.enable(live, [NVDA]);
  const original = h.store.saveLive.bind(h.store);
  let fail = false;
  (h.store as { saveLive: (position: LivePosition) => void }).saveLive = position => { if (fail && position.pending?.leg === 'b') throw new Error('disk I/O error'); original(position); };
  s.place.lighter.push({ outcome: order => { fail = true; return done(order.qty, order.limit); } });
  await h.open(live, NVDA);
  assert.deepEqual(h.orders(), ['lighter sell 1'], '第二腿的意图没落库就不发');
  assert.equal(h.position(live).pending, null, '内存里没有一笔没发出的在途单');
  fail = false;
  await h.run(live, RETRY_MS + 1_000, 1_000);
  assert.deepEqual(h.orders(), ['lighter sell 1', 'entropy buy 1'], '落库恢复后马上对冲，不等过期');
  assert.equal(h.resolvedCount(), 0, '没有去查一笔从没发出的单');
  h.check();
});

test('第二腿少成交一个步长也是真实敞口：回补并记单腿（乘数 3 与乘数 1 两种）', async t => {
  const h = harness(t), live = h.boot(), s = h.s;
  const coarse = pairOf(GOLD.a, { ...GOLD.b, market: { ...GOLD.b.market, sizeDecimals: 0, minBase: 1, minQuote: 0 } }, 3);
  s.pairs.set(coarse.key, coarse);
  s.quotes.set('rh:XAU', { bid: 300.89, ask: 300.91 });
  h.enable(live, [coarse, NVDA], { perTradeUsd: 300, maxOpen: 2 });
  // A 成交 1 → B 目标 3，只成交 2（差一个步长）：A 多出 0.33，要平掉。
  s.place.lighter.push(fill(2));
  await h.open(live, coarse, { aMid: 300.9, bMid: 100, notionalUsd: 300 });
  const position = h.position(live, coarse);
  assert.deepEqual(h.orders(), ['rh sell 1', 'lighter buy 3', 'rh buy 0.33 R']);
  assert.deepEqual([position.state, position.singleLeg, position.b.qty], ['open', true, 2]);
  // 乘数 1：B 成交 0.99 对 A 的 1，差 0.01 也要平。
  const from = s.sent.length;
  s.place.entropy.push(fill(0.99));
  await h.open(live, NVDA);
  assert.deepEqual(h.orders(from), ['lighter sell 1', 'entropy buy 1', 'lighter buy 0.01 R']);
  assert.equal(h.position(live, NVDA).singleLeg, true);
  h.check();
});

test('第一腿成交后第二腿的意图一直落不了库：一分钟告警，十分钟转人工并停止，不会无限重试', async t => {
  const h = harness(t), live = h.boot(), s = h.s;
  h.enable(live, [NVDA]);
  const original = h.store.saveLive.bind(h.store);
  (h.store as { saveLive: (position: LivePosition) => void }).saveLive = position => { if (position.pending?.leg === 'b' || (position.a.qty > 0 && position.state === 'stuck')) throw new Error('disk full'); original(position); };
  await h.open(live, NVDA);
  assert.deepEqual(h.orders(), ['lighter sell 1']);
  await h.run(live, 50_000, 5_000);
  assert.deepEqual(h.alerts(), [], '一分钟内只重试');
  await h.run(live, 20_000, 5_000);
  assert.deepEqual(h.alerts().map(item => item.key.split(':')[0]), ['hedgefail']);
  await h.run(live, 10 * 60_000, 30_000);
  assert.deepEqual(h.alerts().map(item => item.key.split(':')[0]).sort(), ['halt', 'hedgefail', 'stuck']);
  assert.equal(live.view().positions[0]!.state, 'stuck');
  // 库恢复可写之后也不再发：转人工就是停下等人。
  (h.store as { saveLive: (position: LivePosition) => void }).saveLive = original;
  await h.run(live, 5 * 60_000, 30_000);
  assert.deepEqual(h.orders(), ['lighter sell 1'], '转人工后不再发单');
  assert.match(live.view().positions[0]!.note, /先在实盘页核对并处理这笔，再重启服务/);
  h.check();
});

test('开仓意图落库后、发第一腿前报价变了：作废，不发单', async t => {
  const h = harness(t), s = h.s;
  h.boot().update({ on: true, pairs: [NVDA.key], limits: DEFAULT_LIVE_SETTINGS.limits }, () => true);
  h.store.saveLive({ ...intent(s.clock), plan: { qty: 1, limit: 99.97, bLimit: 100.32 } });
  s.quotes.set('entropy:NVDA', { bid: 100.49, ask: 100.51 });
  const live = h.boot();
  live.tick(); await live.idle();
  assert.deepEqual([h.orders(), h.trades(live)[0]?.closeReason], [[], 'not_filled']);
  assert.match(live.view().lastSkip?.reason ?? '', /Entropy 此刻的卖一 100\.51 已越过限价 100\.32/);
  h.check();
});

test('单已成交、记成交的那次落库失败：不能当成没发出，下一轮不再发同一腿，也不报第二腿没发出', async t => {
  for (const leg of ['a', 'b'] as const) {
    const h = harness(t), live = h.boot(), s = h.s;
    h.enable(live, [NVDA]);
    const original = h.store.saveLive.bind(h.store);
    let failed = false;
    // 记成交时 pending 已清空、这条腿已有数量：只让这一次失败。
    (h.store as { saveLive: (position: LivePosition) => void }).saveLive = position => {
      if (!failed && position.pending === null && position[leg].qty > 0 && (leg === 'a' ? position.b.qty === 0 && position.step === 'b' : position.step === 'settle')) { failed = true; throw new Error('SQLITE_BUSY'); }
      original(position);
    };
    await h.open(live, NVDA);
    await h.run(live, 60_000, 5_000);
    assert.equal(failed, true, `${leg} 腿记成交的落库确实失败过`);
    assert.deepEqual(h.orders(), ['lighter sell 1', 'entropy buy 1'], `${leg} 腿不会再发一遍`);
    assert.deepEqual([h.position(live).state, h.position(live).a.qty, h.position(live).b.qty, h.position(live).singleLeg], ['open', 1, 1, false]);
    assert.deepEqual(h.alerts(), [], '没有「第二腿没发出」之类的告警');
    // 落库恢复后库里与内存一致：重启也不会多发。
    const again = h.boot();
    await h.run(again, 30_000, 5_000);
    assert.deepEqual(h.orders(), ['lighter sell 1', 'entropy buy 1']);
    h.check();
  }
});

test('Entropy 发单关联与成交钩子：发单前记录 cloid 与假设费率，成交触发补采，钩子异常不阻断下单', async t => {
  const h = harness(t), s = h.s;
  const links: { cloid: string; positionId: string; purpose: string; assumedFeeBps: number }[] = [];
  let fillHooks = 0;
  const live = createLiveTrader({
    store: h.store, stopped: () => s.stopped, now: () => s.clock, log: line => s.logs.push(line),
    keys: { read: () => ({ keys: s.keys, problem: null }), view: () => ({ lighter: true, rh: true, entropy: true }), accounts: () => ({}), set() {}, remove() {} },
    trader: (venue) => ({
      async place(order) {
        s.sent.push({ venue, symbol: venue === 'entropy' ? order.market.coin! : order.market.symbol, side: order.side, qty: order.qty, limit: order.limit, reduceOnly: order.reduceOnly, clientId: order.clientId, at: s.clock });
        const key = `${venue}:${venue === 'entropy' ? order.market.coin! : order.market.symbol}`;
        s.book.set(key, (s.book.get(key) ?? 0) + (order.side === 'buy' ? 1 : -1) * order.qty);
        return done(order.qty, order.limit);
      },
      async resolve() { return absent(); },
    }),
    venueProblem: () => null, pairOf: key => s.pairs.get(key),
    quote: info => s.quotes.get(bookKey(info.venue, info.symbol)) ?? null,
    takerFeeBps: info => info.venue === 'entropy' ? 0.2 : 0,
    account: venue => ({ at: s.clock, snapshot: { collateral: 1000, available: 1000, positions: [...s.book].filter(([k]) => k.startsWith(`${venue}:`)).map(([k, size]) => ({ symbol: k.slice(venue.length + 1), size, valueUsd: Math.abs(size) * 100 })) } }),
    readAccount: async venue => ({ collateral: 1000, available: 1000, positions: [] }),
    signalFor: () => new AbortController().signal,
    onOrderSent: info => { links.push({ cloid: info.cloid, positionId: info.positionId, purpose: info.purpose, assumedFeeBps: info.assumedFeeBps }); throw new Error('link write failed'); },
    onEntropyFill: () => { fillHooks++; throw new Error('sync schedule failed'); },
  });
  h.enable(live, [NVDA]);
  await h.open(live, NVDA);
  assert.deepEqual(links.map(l => [l.purpose, l.assumedFeeBps]), [['open' === links[0]?.purpose ? 'open' : 'hedge', 0.2]]);
  assert.match(links[0]!.cloid, /^0x[0-9a-f]{32}$/);
  assert.equal(fillHooks, 1, 'Entropy 成交触发补采钩子');
  assert.equal(h.position(live, NVDA).state, 'open', '钩子抛出异常绝不阻断实盘开仓');
  await h.closeSignal(live, NVDA, 'revert');
  assert.deepEqual(links.map(l => l.purpose), ['hedge', 'close']);
  assert.equal(fillHooks, 2);
  h.check();
});

test('策略开仓信号被挡下：返回原因，不落库、不发单；同一配对同一原因的事件 10 分钟最多一条；提交前再核对一次', async t => {
  const h = harness(t), live = h.boot(), s = h.s;
  const skips = () => h.events().filter(text => text.startsWith('实盘没有开仓：'));
  assert.equal(await h.open(live, NVDA), '实盘总开关未开');
  h.enable(live, [GOLD]);
  assert.equal(await h.open(live, NVDA), '这个配对没有开实盘');
  for (let i = 0; i < 5; i++) { s.clock += 60_000; assert.equal(await h.open(live, NVDA), '这个配对没有开实盘'); }
  assert.deepEqual([s.sent.length, h.store.liveActive().length, live.view().lastSkip?.reason], [0, 0, '这个配对没有开实盘']);
  assert.deepEqual(skips(), ['实盘没有开仓：实盘总开关未开', '实盘没有开仓：这个配对没有开实盘'], '同一原因 10 分钟内只记一条');
  s.clock += SKIP_EVENT_MS;
  await h.open(live, NVDA);
  assert.equal(skips().length, 3, '过了 10 分钟再记');
  // 带 Var 腿的配对勾不上实盘；即使勾上也不开。
  h.enable(live, [NVDA, VARP]);
  assert.equal(await h.open(live, VARP), '带 Var 腿的配对不上实盘');
  // 两次 prepare 都通过，第一笔提交后第二笔在提交时被挡下：只有一笔落库。
  const first = live.prepare(NVDA, sig('a_rich', 100), sample(NVDA.key, s.clock, 100.3, 100)), second = live.prepare(NVDA, sig('a_rich', 100), sample(NVDA.key, s.clock, 100.3, 100));
  assert.ok(typeof first === 'function' && typeof second === 'function');
  first(); second();
  await live.idle();
  assert.deepEqual([h.store.liveActive().length, h.orders(), live.view().lastSkip?.reason], [1, ['lighter sell 1', 'entropy buy 1'], '这个配对已有实盘持仓']);
  // 持仓记下策略读数，名义取信号与单笔上限的较小值。
  assert.deepEqual(h.position(live).strategy, { entrySpread: 30, entryBaseline: 0, entryRegime: 'all', aFeeBps: 0, bFeeBps: 0, estimated: false, notionalUsd: 100 });
  h.check();
});
