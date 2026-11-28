// DEX 价差页（docs/varlighter.md、docs/dexspread.md）的本地预览：替身 Var 公开行情、Lighter RH 与 Lighter 主网的行情流（一档与 order_book 盘口）、
// Entropy（Hyperliquid io）的目录与行情流（bbo、activeAssetCtx、l2Book），临时数据目录里预先写入 4 天的分钟样本，并按回测结果补几笔模拟成交，
// 页面上的走势、统计、模拟盘都有内容。不联网，退出时删除临时目录。
//   pnpm build:web; node scripts/dev-varlighter.ts [--port 4733]
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { openStore } from '../src/store.ts';
import { createExecutor } from '../src/executor.ts';
import { createSimulatedVenues } from '../src/simulation.ts';
import { runExecutor } from '../src/runtime.ts';
import { loadWebApp } from '../src/web-assets.ts';
import { startDex } from '../src/dex/main.ts';
import { createDexClient } from '../src/dex/ipc.ts';
import { openVarLighterStore, VARLIGHTER_FILE } from '../src/varlighter/store.ts';
import { ENTROPY_COST_SYNC_KEY, accountHashOf } from '../src/varlighter/entropy-cost.ts';
import { runBacktest } from '../src/varlighter/backtest.ts';
import { KNOWN_KINDS, REVIEW_KINDS, pairKey, regimeOf, varHourly, type Leg, type LiveVenue, type Sample } from '../src/varlighter/model.ts';
import { DEFAULT_GLOBAL, DEFAULT_SYMBOL } from '../src/varlighter/strategy.ts';
import { SETTINGS_KEY } from '../src/varlighter/engine.ts';
import type { Settings } from '../src/varlighter/views.ts';
import { DEFAULT_LIVE_EXEC, LIVE_EXEC_KEY, LIVE_SKIP_STATS_KEY, type LiveLeg, type LiveOrderTelemetry, type LivePosition } from '../src/varlighter/live.ts';
import type { SocketLike } from '../src/varlighter/feeds.ts';

const { values } = parseArgs({ options: { port: { type: 'string', default: '4733' } } });
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('--port 无效');

/** 替身标的：价格、Var 相对基准价的基差常态（基点）、波动、夜盘偏移；各行情流场所的市场编号与相对基准价的偏移（基点）。
 * OPENAI 两边规格不同，SPCX 待确认；主网只有加密货币与 NVDA；Entropy 只有美股。 */
const MARKETS = [
  { symbol: 'AAPL', name: 'Apple', price: 228, basis: 4, noise: 3, overnight: 12, venues: { rh: { id: 1, offset: 0 }, entropy: { id: 0, offset: 1.5 } } },
  { symbol: 'TSLA', name: 'Tesla', price: 345, basis: -6, noise: 6, overnight: -10, venues: { rh: { id: 2, offset: 0 }, entropy: { id: 1, offset: -2 } } },
  { symbol: 'NVDA', name: 'NVIDIA', price: 182, basis: 2, noise: 4, overnight: 8, venues: { rh: { id: 3, offset: 0 }, lighter: { id: 110, offset: -3 }, entropy: { id: 2, offset: 2 } } },
  { symbol: 'SNDK', name: 'Sandisk', price: 61, basis: 8, noise: 7, overnight: 15, venues: { entropy: { id: 3, offset: 0 } } },
  { symbol: 'BTC', name: 'Bitcoin', price: 98_500, basis: 1.5, noise: 2, overnight: 0, venues: { rh: { id: 4, offset: 0 }, lighter: { id: 1, offset: 0.8 } } },
  { symbol: 'ETH', name: 'Ethereum', price: 3_650, basis: -2, noise: 3, overnight: 0, venues: { rh: { id: 5, offset: 0 }, lighter: { id: 0, offset: -1 } } },
  { symbol: 'SOL', name: 'Solana', price: 182, basis: 3, noise: 4, overnight: 0, venues: { lighter: { id: 2, offset: 0 } } },
  { symbol: 'SPCX', name: 'SPACX', price: 31, basis: 25, noise: 15, overnight: 0, venues: { rh: { id: 6, offset: 0 } } },
  { symbol: 'OPENAI', name: 'OpenAI', price: 50, basis: 0, noise: 0, overnight: 0, venues: { rh: { id: 7, offset: 0 } } },
] as const;
type Market = (typeof MARKETS)[number];
type VenueItem = { id: number; offset: number };
const venueItem = (market: Market, venue: LiveVenue) => (market.venues as Partial<Record<LiveVenue, VenueItem>>)[venue];
const onVenue = (venue: LiveVenue) => MARKETS.flatMap(market => { const item = venueItem(market, venue); return item ? [{ market, ...item }] : []; });
const bySymbol = new Map<string, Market>(MARKETS.map(market => [market.symbol, market]));
const kindOf = (symbol: string) => KNOWN_KINDS[symbol] ?? REVIEW_KINDS[symbol] ?? 'other';
/** 默认开着的四个组合（var|rh、var|lighter、var|entropy、lighter|entropy），外加一个手动配对 rh:ETH|lighter:ETH。 */
const PAIRS: [Leg, Leg][] = [];
for (const market of MARKETS) {
  const has = (venue: LiveVenue) => !!venueItem(market, venue);
  if (market.symbol !== 'OPENAI') for (const venue of ['rh', 'lighter', 'entropy'] as const) if (has(venue)) PAIRS.push([{ venue: 'var', symbol: market.symbol }, { venue, symbol: market.symbol }]);
  if (has('lighter') && has('entropy')) PAIRS.push([{ venue: 'lighter', symbol: market.symbol }, { venue: 'entropy', symbol: market.symbol }]);
}
PAIRS.push([{ venue: 'rh', symbol: 'ETH' }, { venue: 'lighter', symbol: 'ETH' }]);

// 均值回归的基差（OU 过程，每分钟一步，半衰期约 8 分钟），夜盘与周末抬高。Var 一个价，各行情流场所在基准价上偏一点并缓慢摆动。
let seed = 7;
const random = () => { seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31; return seed / 2 ** 31; };
const gauss = () => Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random());
const state = new Map<string, { deviation: number; price: number; at: number; basis: number }>(MARKETS.map(market => [market.symbol, { deviation: 0, price: market.price, at: 0, basis: market.basis }]));
/** 推进到 t（同一时刻只推一次），返回基准价与 Var 基差。 */
function step(market: Market, t: number): { price: number; basis: number } {
  const value = state.get(market.symbol)!;
  if (t > value.at) {
    value.at = t;
    value.deviation = value.deviation * 0.92 + gauss() * market.noise * 0.4 + (random() < 0.004 ? (random() < 0.5 ? -1 : 1) * market.noise * 4 : 0);
    value.price *= 1 + gauss() * 0.0004;
    const regime = regimeOf(kindOf(market.symbol), t);
    value.basis = market.basis + (regime === 'overnight' || regime === 'weekend' ? market.overnight : regime === 'ext' ? market.overnight / 2 : 0) + value.deviation;
  }
  return { price: value.price, basis: value.basis };
}
const half = (price: number, bps: number) => price * bps / 20_000;
/** 领先测速预览脉冲：每 2.5 秒产生一个 ±7 bps 跃变，且按各场所预设滞后返回，方便直观验收毫秒延迟与互相关。 */
const leadPulseBps = (t: number) => {
  const bucket = Math.floor(t / 2_500);
  const sign = bucket % 2 === 0 ? 1 : -1;
  return sign * 7;
};
/** 行情流场所的中间价：基准价加偏移，再加几个基点的慢摆动（各场所相位不同）与测速周期脉冲。 */
const liveMid = (market: Market, venue: LiveVenue, price: number, t: number) => {
  const item = venueItem(market, venue)!, phase = { rh: 0, lighter: 2.1, entropy: 4.2 }[venue];
  const lagMs = { lighter: 220, entropy: 140, rh: 420 }[venue];
  const pulse = leadPulseBps(t - lagMs);
  return price * (1 + (item.offset + pulse + 4 * Math.sin(t / 420_000 + phase + item.id)) / 10_000);
};
const binanceTopOf = (market: Market) => {
  const t = Date.now();
  const base = step(market, Math.floor(t / 60_000) * 60_000).price;
  const mid = base * (1 + leadPulseBps(t) / 10_000);
  const spread = half(mid, crypto(market) ? 0.8 : 2);
  return { bid: mid - spread, ask: mid + spread, mid };
};
const crypto = (market: Market) => kindOf(market.symbol) === 'crypto';
const VAR_FUNDING_ANNUAL = (market: Market) => crypto(market) ? 0.1095 : 0.05;

type LegFields = Record<string, number | null>;
function varFields(market: Market, t: number): LegFields {
  const { price, basis } = step(market, t), mid = price * (1 + basis / 10_000);
  const h = half(mid, crypto(market) ? 2 : 5), h1k = h + half(mid, 1), h100k = h + half(mid, 6);
  return { At: t, Mark: mid, Index: null, Funding: varHourly(VAR_FUNDING_ANNUAL(market)), Bid0: mid - h, Ask0: mid + h, Bid1k: mid - h1k, Ask1k: mid + h1k, Bid100k: mid - h100k, Ask100k: mid + h100k,
    BidRx: null, AskRx: null, RxAt: null, BidTk: null, AskTk: null, TkAt: null, TkQty: null, TkReceivedAt: null };
}
function liveFields(market: Market, venue: LiveVenue, t: number): LegFields {
  const mid = liveMid(market, venue, step(market, t).price, t), h = half(mid, crypto(market) ? 1 : 3);
  return { At: t, Mark: mid, Index: mid, Funding: crypto(market) ? 0.0000125 : 0.000005, Bid0: mid - h, Ask0: mid + h, Bid1k: mid - h * 1.2, Ask1k: mid + h * 1.2, Bid100k: mid - h * 3, Ask100k: mid + h * 3,
    BidRx: mid - h, AskRx: mid + h, RxAt: t, BidTk: null, AskTk: null, TkAt: null, TkQty: null, TkReceivedAt: null };
}
const legFields = (leg: Leg, t: number) => { const market = bySymbol.get(leg.symbol)!; return leg.venue === 'var' ? varFields(market, t) : liveFields(market, leg.venue, t); };
function sampleOf([a, b]: [Leg, Leg], t: number): Sample {
  const prefixed = (side: 'a' | 'b', fields: LegFields) => Object.fromEntries(Object.entries(fields).map(([key, value]) => [`${side}${key}`, value]));
  const receivedAt = a.venue === 'var' || b.venue === 'var' ? t + 20_000 : t;
  return { symbol: pairKey(a, b, 1), t, receivedAt, decisionAt: receivedAt, captureKind: 'decision', regime: regimeOf(kindOf(a.symbol), t), ratio: 1, ...prefixed('a', legFields(a, t)), ...prefixed('b', legFields(b, t)) } as Sample;
}

const app = loadWebApp();
const dir = mkdtempSync(join(tmpdir(), 'tp-dev-varlighter-'));
const now = Date.now();

// 预先写入 4 天样本；启用 Var↔RH 的 AAPL、BTC，Var↔主网的 ETH，主网↔Entropy 的 NVDA，按回测补上成交记录（同一条腿在几个配对里的成交会重叠，预览不管）。
{
  const store = openVarLighterStore(join(dir, VARLIGHTER_FILE));
  const start = Math.floor((now - 4 * 86_400_000) / 60_000) * 60_000;
  const history = new Map<string, Sample[]>();
  for (let t = start; t < now - 60_000; t += 60_000) for (const pair of PAIRS) {
    const sample = sampleOf(pair, t), list = history.get(sample.symbol) ?? [];
    list.push(sample); history.set(sample.symbol, list);
  }
  for (const list of history.values()) store.addSamples(list);
  const global = { ...DEFAULT_GLOBAL, minSamples: 60 };
  const symbols = {
    'var:AAPL|rh:AAPL': { ...DEFAULT_SYMBOL, enabled: true, entryBps: 9, exitBps: 1 }, 'var:BTC|rh:BTC': { ...DEFAULT_SYMBOL, enabled: true, entryBps: 5, exitBps: 0.5 },
    'var:ETH|lighter:ETH': { ...DEFAULT_SYMBOL, enabled: true, entryBps: 7, exitBps: 1 }, 'lighter:NVDA|entropy:NVDA': { ...DEFAULT_SYMBOL, enabled: true, entryBps: 6, exitBps: 1 },
  };
  // 一个已下架的配对（不在目录里）：已启用，演示总览的「失联的标的」。不预置实盘持仓（v0.112.0 起没有模拟持仓），预览里不会发任何订单。
  const gone = { ...history.get('var:AAPL|rh:AAPL')!.at(-120)!, symbol: 'var:DELISTED|rh:DELISTED' };
  store.addSamples([gone]);
  const settings: Settings = {
    revision: 1, global, symbols: { ...symbols, [gone.symbol]: { ...DEFAULT_SYMBOL, enabled: true } }, confirmed: [],
    combos: ['var|rh', 'var|lighter', 'var|entropy', 'lighter|entropy'], pairs: [{ a: { venue: 'rh', symbol: 'ETH' }, b: { venue: 'lighter', symbol: 'ETH' }, ratio: 1, kind: 'crypto', note: '预览：两条行情流' }],
    auto: ['lighter:NVDA|entropy:NVDA'],
  };
  store.setState(SETTINGS_KEY, settings, now);
  // 详情页的实盘成交（第 18 节）：没有 Var 腿的配对按回测结果写成已结束的实盘持仓，带策略读数。
  for (const [key, params] of Object.entries(symbols)) {
    if (key.includes('var:')) continue;
    const list = history.get(key)!;
    const result = runBacktest(key, kindOf(key.split('|')[0]!.split(':')[1]!), list, now - 3 * 86_400_000, now, params, global, { aFeeBps: 0, bFeeBps: 0 });
    const [aKey, bKey] = key.split('|') as [string, string];
    const legOf = (leg: string, side: LiveLeg['side'], qty: number, entry: number, exit: number, fees: number): LiveLeg => {
      const [venue, symbol] = leg.split(':') as [LiveLeg['venue'], string];
      return { venue, symbol: venue === 'entropy' ? `io:${symbol}` : symbol, side, qty, entryQuote: qty * entry, exitQty: qty, exitQuote: qty * exit, feesUsd: fees, estimated: false };
    };
    for (const trade of result.trades) {
      const aSide = trade.direction === 'a_rich' ? 'sell' : 'buy', bSide = aSide === 'sell' ? 'buy' : 'sell';
      store.saveLive({
        id: `preview-${key}-${trade.id}`, symbol: key, direction: trade.direction, ratio: 1, state: 'closed', step: 'settle', openedAt: trade.openedAt, updatedAt: trade.closedAt, closedAt: trade.closedAt,
        a: legOf(aKey, aSide, trade.qty, trade.aEntry, trade.aExit, trade.costUsd / 2), b: legOf(bKey, bSide, trade.qty, trade.bEntry, trade.bExit, trade.costUsd / 2),
        plan: { qty: trade.qty, limit: trade.aEntry }, pending: null, tries: 1, retryAt: 0, closeReason: trade.reason, singleLeg: false, netUsd: trade.netUsd, note: '（预览）',
        strategy: { notionalUsd: trade.notionalUsd, entrySpread: trade.entrySpread, entryBaseline: trade.entryBaseline, entryRegime: trade.entryRegime, aFeeBps: 0, bFeeBps: 0, estimated: trade.estimated },
      });
    }
  }
  // 实盘页的预览（docs/dexspread.md 第 13、19 节）：两笔带全链路遥测的已结束实盘成交，其中一笔是单腿。不预置凭据、不预置在途持仓，预览里不会发任何订单。
  const liveLeg = (venue: LiveLeg['venue'], symbol: string, side: LiveLeg['side'], qty: number, entry: number, exit: number): LiveLeg => ({ venue, symbol, side, qty, entryQuote: qty * entry, exitQty: qty, exitQuote: qty * exit, feesUsd: 0.02, estimated: false });
  const liveTrade = (id: string, ago: number, a: LiveLeg, b: LiveLeg, netUsd: number, singleLeg: boolean, closeReason: string, note: string, orders: LiveOrderTelemetry[]): LivePosition => ({
    id, symbol: 'lighter:NVDA|entropy:NVDA', direction: 'a_rich', ratio: 1, state: 'closed', step: 'settle', openedAt: now - ago, updatedAt: now - ago + 900_000, closedAt: now - ago + 900_000,
    a, b, plan: { qty: a.qty, limit: 181.8 }, pending: null, tries: 1, retryAt: 0, closeReason, singleLeg, netUsd, note, orders });
  store.saveLive(liveTrade('preview-live-1', 7_200_000, liveLeg('lighter', 'NVDA', 'sell', 0.5, 182.31, 182.02), liveLeg('entropy', 'io:NVDA', 'buy', 0.5, 182.05, 182.0), 0.08, false, 'revert', '', [
    { role: 'openA', leg: 'a', venue: 'lighter', side: 'sell', clientId: 10001, qty: 0.5, filledQty: 0.5, expectedPrice: 182.33, limitPrice: 182.29, avgPrice: 182.31, slippageBps: 1.1, signalAt: now - 7_200_000, sentAt: now - 7_199_990, ackAt: now - 7_199_940, confirmAt: now - 7_199_845, confirmSource: 'ws', status: '已成交' },
    { role: 'openB', leg: 'b', venue: 'entropy', side: 'buy', clientId: 10002, qty: 0.5, filledQty: 0.5, expectedPrice: 182.04, limitPrice: 182.58, avgPrice: 182.05, slippageBps: 0.55, signalAt: now - 7_199_845, sentAt: now - 7_199_840, ackAt: now - 7_199_775, confirmAt: now - 7_199_775, confirmSource: 'sync', status: '已成交' },
    { role: 'closeA', leg: 'a', venue: 'lighter', side: 'buy', clientId: 10003, qty: 0.5, filledQty: 0.5, expectedPrice: 182.01, limitPrice: 182.92, avgPrice: 182.02, slippageBps: 0.55, signalAt: now - 6_300_010, sentAt: now - 6_300_000, ackAt: now - 6_299_940, confirmAt: now - 6_299_870, confirmSource: 'ws', status: '已成交' },
    { role: 'closeB', leg: 'b', venue: 'entropy', side: 'sell', clientId: 10004, qty: 0.5, filledQty: 0.5, expectedPrice: 182.0, limitPrice: 181.09, avgPrice: 182.0, slippageBps: 0, signalAt: now - 6_300_010, sentAt: now - 6_300_000, ackAt: now - 6_299_935, confirmAt: now - 6_299_935, confirmSource: 'sync', status: '已成交' },
  ]));
  store.saveLive(liveTrade('preview-live-2', 3_600_000, liveLeg('lighter', 'NVDA', 'sell', 0.5, 182.4, 182.46), { ...liveLeg('entropy', 'io:NVDA', 'buy', 0, 0, 0), exitQty: 0, feesUsd: 0 }, -0.05, true, 'single_leg', 'Entropy 没有成交，Lighter 已反向平掉', [
    { role: 'openA', leg: 'a', venue: 'lighter', side: 'sell', clientId: 10005, qty: 0.5, filledQty: 0.5, expectedPrice: 182.42, limitPrice: 182.38, avgPrice: 182.4, slippageBps: 1.1, signalAt: now - 3_600_000, sentAt: now - 3_599_990, ackAt: now - 3_599_930, confirmAt: now - 3_599_350, confirmSource: 'rest', status: '已成交' },
    { role: 'openB', leg: 'b', venue: 'entropy', side: 'buy', clientId: 10006, qty: 0.5, filledQty: 0, expectedPrice: 182.1, limitPrice: 182.65, avgPrice: null, slippageBps: null, signalAt: now - 3_599_350, sentAt: now - 3_599_345, ackAt: now - 3_599_285, confirmAt: now - 3_599_285, confirmSource: 'sync', status: '未成交：Order could not immediately match' },
    { role: 'flatten', leg: 'a', venue: 'lighter', side: 'buy', clientId: 10007, qty: 0.5, filledQty: 0.5, expectedPrice: 182.4, limitPrice: 184.2, avgPrice: 182.46, slippageBps: 3.3, signalAt: now - 3_599_285, sentAt: now - 3_599_280, ackAt: now - 3_599_220, confirmAt: now - 3_599_090, confirmSource: 'ws', status: '已成交' },
  ]));
  // 成交表与结果计数的预览：两笔成交之后有 6 笔第一腿没成交的（不该挤掉成交表），另有两笔不同配对、不同平仓原因的成交（含一笔止损亏损），让执行质量与盈亏分组有内容。
  const emptyLeg = (venue: LiveLeg['venue'], symbol: string, side: LiveLeg['side']): LiveLeg => ({ ...liveLeg(venue, symbol, side, 0, 0, 0), feesUsd: 0 });
  [2_400_000, 2_100_000, 1_800_000, 1_500_000, 1_200_000, 900_000].forEach((ago, index) => {
    const sentAt = now - ago + 10;
    store.saveLive({ ...liveTrade(`preview-live-nf-${index + 1}`, ago, emptyLeg('lighter', 'NVDA', 'sell'), emptyLeg('entropy', 'io:NVDA', 'buy'), 0, false, 'not_filled', '第一腿没有成交（预览）', [
      { role: 'openA', leg: 'a', venue: 'lighter', side: 'sell', clientId: 10100 + index, qty: 0.5, filledQty: 0, expectedPrice: 182.3, limitPrice: 182.26, avgPrice: null, slippageBps: null, signalAt: now - ago, sentAt, ackAt: sentAt + 55, confirmAt: sentAt + 180, confirmSource: 'ws', status: '未成交：价格已离开限价' },
    ]), updatedAt: now - ago + 2_000, closedAt: now - ago + 2_000 });
  });
  store.saveLive({ ...liveTrade('preview-live-3', 18_000_000, liveLeg('rh', 'ETH', 'buy', 0.03, 3201.5, 3190.0), liveLeg('lighter', 'ETH', 'sell', 0.03, 3202.1, 3197.9), -0.26, false, 'stop', '', [
    { role: 'openA', leg: 'a', venue: 'rh', side: 'buy', clientId: 10011, qty: 0.03, filledQty: 0.03, expectedPrice: 3201.2, limitPrice: 3201.8, avgPrice: 3201.5, slippageBps: 0.94, signalAt: now - 18_000_000, sentAt: now - 17_999_985, ackAt: now - 17_999_920, confirmAt: now - 17_999_790, confirmSource: 'ws', status: '已成交' },
    { role: 'openB', leg: 'b', venue: 'lighter', side: 'sell', clientId: 10012, qty: 0.03, filledQty: 0.03, expectedPrice: 3202.4, limitPrice: 3192.8, avgPrice: 3202.1, slippageBps: 0.94, signalAt: now - 17_999_790, sentAt: now - 17_999_785, ackAt: now - 17_999_720, confirmAt: now - 17_999_610, confirmSource: 'ws', status: '已成交' },
    { role: 'closeA', leg: 'a', venue: 'rh', side: 'sell', clientId: 10013, qty: 0.03, filledQty: 0.03, expectedPrice: 3190.6, limitPrice: 3181.0, avgPrice: 3190.0, slippageBps: 1.88, signalAt: now - 17_100_010, sentAt: now - 17_100_000, ackAt: now - 17_099_930, confirmAt: now - 17_099_200, confirmSource: 'rest', status: '已成交' },
    { role: 'closeB', leg: 'b', venue: 'lighter', side: 'buy', clientId: 10014, qty: 0.03, filledQty: 0.03, expectedPrice: 3197.6, limitPrice: 3207.2, avgPrice: 3197.9, slippageBps: 0.94, signalAt: now - 17_100_010, sentAt: now - 17_100_000, ackAt: now - 17_099_940, confirmAt: now - 17_099_850, confirmSource: 'ws', status: '已成交' },
  ]), symbol: 'rh:ETH|lighter:ETH', direction: 'a_cheap' });
  store.saveLive(liveTrade('preview-live-4', 93_600_000, liveLeg('lighter', 'NVDA', 'sell', 0.5, 181.9, 181.78), liveLeg('entropy', 'io:NVDA', 'buy', 0.5, 181.7, 181.69), 0.03, false, 'timeout', '', [
    { role: 'openA', leg: 'a', venue: 'lighter', side: 'sell', clientId: 10021, qty: 0.5, filledQty: 0.5, expectedPrice: 181.92, limitPrice: 181.88, avgPrice: 181.9, slippageBps: 1.1, signalAt: null, sentAt: now - 93_599_990, ackAt: now - 93_599_930, confirmAt: now - 93_599_700, confirmSource: 'rest', status: '已成交' },
    { role: 'openB', leg: 'b', venue: 'entropy', side: 'buy', clientId: 10022, qty: 0.5, filledQty: 0.5, expectedPrice: 181.7, limitPrice: 182.25, avgPrice: 181.7, slippageBps: 0, signalAt: now - 93_599_700, sentAt: now - 93_599_695, ackAt: now - 93_599_640, confirmAt: now - 93_599_640, confirmSource: 'sync', status: '已成交' },
    { role: 'closeA', leg: 'a', venue: 'lighter', side: 'buy', clientId: 10023, qty: 0.5, filledQty: 0.5, expectedPrice: 181.77, limitPrice: 182.32, avgPrice: 181.78, slippageBps: 0.55, signalAt: now - 92_700_010, sentAt: now - 92_700_000, ackAt: now - 92_699_950, confirmAt: now - 92_698_800, confirmSource: 'account', status: '已成交' },
    { role: 'closeB', leg: 'b', venue: 'entropy', side: 'sell', clientId: 10024, qty: 0.5, filledQty: 0.5, expectedPrice: 181.7, limitPrice: 181.15, avgPrice: 181.69, slippageBps: 0.55, signalAt: now - 92_700_010, sentAt: now - 92_700_000, ackAt: now - 92_699_945, confirmAt: now - 92_699_945, confirmSource: 'sync', status: '已成交' },
  ]));
  store.setState(LIVE_EXEC_KEY, DEFAULT_LIVE_EXEC, now);
  store.setState(LIVE_SKIP_STATS_KEY, { day: Math.floor(now / 86_400_000) * 86_400_000, total: 14, byReason: { '实时价差已缩窄': 9, '价格已越过限价': 5 } }, now);
  store.event(now - 3_600_000, 'live', 'lighter:NVDA|entropy:NVDA', '（预览）第二腿没有成交，第一腿已反向平掉，记一次单腿');
  // 预写入近两天的账户权益快照（按 sha256("场所:标识").slice(0,16) 隔离），让账户资产页的权益走势图立即可见。
  const hashOf = (venue: string, id: string) => createHash('sha256').update(`${venue}:${id}`).digest('hex').slice(0, 16);
  const previewHashes = { lighter: hashOf('lighter', '1001'), rh: hashOf('rh', '2002'), entropy: hashOf('entropy', '0x' + 'ab'.repeat(20)) };
  for (let i = 48; i >= 1; i--) {
    const t = now - i * 3_600_000;
    const wave = Math.sin(i / 6) * 2.5;
    store.addAccountSnapshot({ venue: 'lighter', accountHash: previewHashes.lighter, at: t, equity: 302 + (48 - i) * 0.08 + wave, collateral: 300.25, available: 250.5, unrealizedPnl: 1.75 + wave, positions: 1 });
    store.addAccountSnapshot({ venue: 'rh', accountHash: previewHashes.rh, at: t, equity: 60 + wave * 0.2, collateral: 60, available: 60, unrealizedPnl: 0, positions: 0 });
    store.addAccountSnapshot({ venue: 'entropy', accountHash: previewHashes.entropy, at: t, equity: 510 + (48 - i) * 0.05 - wave * 0.6, collateral: 512.4, available: 480.1, unrealizedPnl: 0.3, positions: 1 });
  }
  const previewHash = accountHashOf('0x' + 'ab'.repeat(20));
  store.addEntropyFeeSnapshot({ accountHash: previewHash, at: now - 300_000, userCrossRate: 0.00045, userAddRate: 0.00015, referralDiscount: 0.04, stakingDiscount: 0, hypePriceUsd: 66.12, assumedFeeBps: 0.2 });
  store.upsertEntropyFills([
    { accountHash: previewHash, tid: 90001, oid: 80001, cloid: '0x00000000000000000000000000000001', time: now - 7_200_000, coin: 'io:NVDA', side: 'B', dir: 'Open Long', crossed: true, px: 182.05, sz: 0.5, notionalUsd: 91.025, feeUsd: 0.007865, feeToken: 'USDC', builderFeeUsd: 0, closedPnl: 0, livePositionId: 'preview-live-1', livePurpose: 'open', assumedFeeBps: 0.2, catalogFeeBps: 0.9, deployerFeeScale: 1, growthMode: 'enabled', hlCrossRate: 0.00045, hlReferralDiscount: 0.04, hlStakingDiscount: 0, hypePriceUsd: 65.8, recordedAt: now - 7_190_000 },
    { accountHash: previewHash, tid: 90002, oid: 80002, cloid: '0x00000000000000000000000000000002', time: now - 6_300_000, coin: 'io:NVDA', side: 'A', dir: 'Close Long', crossed: true, px: 182.0, sz: 0.5, notionalUsd: 91.0, feeUsd: 0.007862, feeToken: 'USDC', builderFeeUsd: 0, closedPnl: -0.025, livePositionId: 'preview-live-1', livePurpose: 'close', assumedFeeBps: 0.2, catalogFeeBps: 0.9, deployerFeeScale: 1, growthMode: 'enabled', hlCrossRate: 0.00045, hlReferralDiscount: 0.04, hlStakingDiscount: 0, hypePriceUsd: 65.9, recordedAt: now - 6_290_000 },
    { accountHash: previewHash, tid: 90003, oid: 80003, cloid: null, time: now - 1_800_000, coin: 'io:SNDK', side: 'B', dir: 'Open Long', crossed: true, px: 61.0, sz: 2, notionalUsd: 122.0, feeUsd: 0.010541, feeToken: 'USDC', builderFeeUsd: 0, closedPnl: 0, livePositionId: null, livePurpose: null, assumedFeeBps: 0.2, catalogFeeBps: 0.9, deployerFeeScale: 1, growthMode: 'enabled', hlCrossRate: 0.00045, hlReferralDiscount: 0.04, hlStakingDiscount: 0, hypePriceUsd: 66.1, recordedAt: now - 1_790_000 },
  ]);
  store.setState(ENTROPY_COST_SYNC_KEY, { [previewHash]: { cursorMs: now - 1_800_000, lastSyncAt: now - 60_000, lastOkAt: now - 60_000, incomplete: false, error: null } }, now);
  store.close();
}

/** 替身 WebSocket 的公共部分。 */
abstract class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  private timer: ReturnType<typeof setInterval>;
  constructor(tickMs = 1_000) {
    setTimeout(() => { this.readyState = 1; this.onopen?.({}); }, 30);
    this.timer = setInterval(() => { if (this.readyState === 1) this.tick(); }, tickMs);
  }
  protected push(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
  protected abstract tick(): void;
  abstract send(data: string): void;
  close() { this.readyState = 3; clearInterval(this.timer); this.onclose?.({}); }
}
// 替身 Binance bookTicker 行情流：每 100ms 检查，一档变动立即推给订阅的单标的。
class FakeBinance extends FakeSocket {
  private readonly subs = new Set<string>();
  private updateId = 1;
  private lastBid = new Map<string, string>();
  constructor() { super(100); }
  private resolveMarket(streamSym: string): Market | null {
    const base = streamSym.replace(/(USDT|USDC)$/i, '').toUpperCase();
    return bySymbol.get(base) ?? (base === 'ANT' ? bySymbol.get('AAPL') ?? null : null);
  }
  protected tick() {
    for (const stream of this.subs) {
      const sym = stream.replace(/@bookTicker$/i, '').toUpperCase();
      const market = this.resolveMarket(sym);
      if (!market) continue;
      const top = binanceTopOf(market);
      const b = top.bid.toFixed(4), a = top.ask.toFixed(4);
      if (this.lastBid.get(sym) === b) continue;
      this.lastBid.set(sym, b);
      const now = Date.now();
      this.push({ e: 'bookTicker', u: ++this.updateId, s: sym, b, B: '5.0', a, A: '5.0', T: now - 5, E: now });
    }
  }
  send(data: string) {
    const msg = JSON.parse(data) as { method?: string; params?: string[]; id?: number };
    if (msg.method === 'SUBSCRIBE' && Array.isArray(msg.params)) {
      for (const p of msg.params) this.subs.add(p);
      this.push({ result: null, id: msg.id });
    } else if (msg.method === 'LIST_SUBSCRIPTIONS') {
      this.push({ result: [...this.subs], id: msg.id });
    }
  }
}
function topOf(market: Market, venue: LiveVenue) {
  const t = Date.now(), price = liveMid(market, venue, step(market, Math.floor(t / 60_000) * 60_000).price, t), spread = half(price, crypto(market) ? 1 : 3);
  return { bid: price - spread, ask: price + spread, price };
}
/** Lighter 一个市场的五档盘口（价、量）。 */
function lighterLevels(market: Market, venue: LiveVenue): { bids: { price: string; size: string }[]; asks: { price: string; size: string }[] } {
  const top = topOf(market, venue), size = (40_000 / top.price).toFixed(4);
  const levels = (side: 1 | -1, from: number) => [0, 1, 2, 3, 4].map(level => ({ price: (from + side * half(top.price, level * 1.5)).toFixed(4), size }));
  return { bids: levels(-1, top.bid), asks: levels(1, top.ask) };
}
// 替身 Lighter 行情流：每秒推一次本场所全市场一档；订阅了盘口的市场先给快照，之后每秒推增量（删旧档、加新档，nonce 相连）。
class FakeLighter extends FakeSocket {
  private readonly venue: LiveVenue;
  private readonly books = new Map<number, { levels: ReturnType<typeof lighterLevels>; nonce: number }>();
  private lastStatsAt = 0;
  constructor(venue: LiveVenue) { super(100); this.venue = venue; }
  private stats() {
    return Object.fromEntries(onVenue(this.venue).map(({ market, id }) => { const top = topOf(market, this.venue); return [id, { market_id: id, symbol: market.symbol, best_bid_price: top.bid.toFixed(4), best_ask_price: top.ask.toFixed(4), mark_price: top.price.toFixed(4), index_price: top.price.toFixed(4), current_funding_rate: '0.0005' }]; }));
  }
  protected tick() {
    const now = Date.now();
    if (now - this.lastStatsAt >= 1_000) {
      this.lastStatsAt = now;
      this.push({ type: 'update/market_stats', channel: 'market_stats:all', market_stats: this.stats() });
    }
    for (const [id, book] of this.books) {
      const found = onVenue(this.venue).find(item => item.id === id);
      if (!found) continue;
      const next = lighterLevels(found.market, this.venue);
      if (next.bids[0]?.price === book.levels.bids[0]?.price && next.asks[0]?.price === book.levels.asks[0]?.price) continue;
      const diff = (old: { price: string }[], fresh: { price: string; size: string }[]) => [...old.filter(level => !fresh.some(item => item.price === level.price)).map(level => ({ price: level.price, size: '0.0000' })), ...fresh];
      this.push({ type: 'update/order_book', channel: `order_book:${id}`, order_book: { code: 0, bids: diff(book.levels.bids, next.bids), asks: diff(book.levels.asks, next.asks), begin_nonce: book.nonce, nonce: book.nonce + 1 } });
      this.books.set(id, { levels: next, nonce: book.nonce + 1 });
    }
  }
  send(data: string) {
    const message = JSON.parse(data) as { type: string; channel?: string };
    if (message.type === 'ping') { this.push({ type: 'pong' }); return; }
    if (message.type === 'subscribe' && message.channel === 'market_stats/all') this.push({ type: 'subscribed/market_stats', channel: 'market_stats:all', market_stats: this.stats() });
    if (message.type === 'subscribe' && message.channel?.startsWith('account_all_orders/')) {
      this.push({ type: 'subscribed/account_all_orders', channel: message.channel.replace('/', ':'), orders: {} });
      return;
    }
    const book = /^order_book\/(\d+)$/.exec(message.channel ?? '');
    if (!book) return;
    const id = Number(book[1]);
    if (message.type === 'unsubscribe') { this.books.delete(id); return; }
    const found = onVenue(this.venue).find(item => item.id === id);
    if (message.type !== 'subscribe' || !found) return;
    const levels = lighterLevels(found.market, this.venue);
    this.books.set(id, { levels, nonce: 1 });
    this.push({ type: 'subscribed/order_book', channel: `order_book:${id}`, order_book: { code: 0, ...levels, nonce: 1 } });
  }
}
// 替身 Entropy（Hyperliquid）行情流：按订阅每秒推 bbo、activeAssetCtx 与 l2Book，l2Book 的 post 立即回应，ping 回 pong。
class FakeEntropy extends FakeSocket {
  private readonly subscriptions = new Set<string>();
  private lastSlowAt = 0;
  private readonly lastBbo = new Map<string, string>();
  constructor() { super(100); }
  protected tick() {
    const now = Date.now();
    const sendSlow = now - this.lastSlowAt >= 1_000;
    if (sendSlow) this.lastSlowAt = now;
    for (const key of this.subscriptions) {
      const [type, coin] = key.split('|') as [string, string], found = entropyMarket(coin);
      if (!found) continue;
      const top = topOf(found, 'entropy');
      if (type === 'bbo') {
        const px = top.bid.toFixed(3);
        if (this.lastBbo.get(coin) === px) continue;
        this.lastBbo.set(coin, px);
        this.push({ channel: 'bbo', data: { coin, time: now, bbo: [{ px, sz: '50', n: 3 }, { px: top.ask.toFixed(3), sz: '50', n: 2 }] } });
      }
      if (sendSlow && type === 'activeAssetCtx') this.push({ channel: 'activeAssetCtx', data: { coin, ctx: { markPx: top.price.toFixed(3), oraclePx: (top.price * 0.9998).toFixed(3), funding: '0.0000125', openInterest: '1000' } } });
      if (sendSlow && type === 'l2Book') this.push({ channel: 'l2Book', data: l2Book(coin) });
    }
  }
  send(data: string) {
    const message = JSON.parse(data) as { method: string; id?: number; subscription?: { type: string; coin: string }; request?: { payload: { coin: string } } };
    if (message.method === 'subscribe' && message.subscription) { this.subscriptions.add(`${message.subscription.type}|${message.subscription.coin}`); this.push({ channel: 'subscriptionResponse', data: message }); }
    if (message.method === 'unsubscribe' && message.subscription) this.subscriptions.delete(`${message.subscription.type}|${message.subscription.coin}`);
    if (message.method === 'ping') this.push({ channel: 'pong' });
    if (message.method === 'post' && message.request) this.push({ channel: 'post', data: { id: message.id, response: { type: 'info', payload: { type: 'l2Book', data: l2Book(message.request.payload.coin) } } } });
  }
}
const entropyMarket = (coin: string) => coin.startsWith('io:') && bySymbol.get(coin.slice(3)) && venueItem(bySymbol.get(coin.slice(3))!, 'entropy') ? bySymbol.get(coin.slice(3))! : null;
function l2Book(coin: string) {
  const found = entropyMarket(coin);
  if (!found) return null;
  const top = topOf(found, 'entropy'), size = (40_000 / top.price).toFixed(2);
  const levels = (side: 1 | -1, from: number) => [0, 1, 2, 3, 4].map(level => ({ px: (from + side * half(top.price, level * 1.5)).toFixed(3), sz: size, n: 2 }));
  return { coin, time: Date.now(), levels: [levels(-1, top.bid), levels(1, top.ask)] };
}

// 替身 Var 公开行情与各场所的目录（盘口走上面的替身行情流）。Var 报价时刻比收到时早 20 秒，与真实接口的缓存相近。
const venueOfUrl = (url: string): LiveVenue => url.includes('hyperliquid') ? 'entropy' : url.includes('api.rh.lighter.xyz') ? 'rh' : 'lighter';
// 替身场所账户（docs/dexspread.md 12.13）：主网资金够、RH 不足 100、Entropy 有一笔持仓，准备页的两项各有内容可看。
const PREVIEW_ACCOUNTS = { lighter: { accountIndex: 1001 }, rh: { accountIndex: 2002 }, entropy: { address: '0x' + 'ab'.repeat(20) } };
const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = String(input instanceof Request ? input.url : input);
  const tNow = Date.now();
  if (url.includes('fapi.binance.com/fapi/v1/exchangeInfo')) {
    return Response.json({
      symbols: MARKETS.filter(m => m.symbol !== 'SPCX' && m.symbol !== 'OPENAI').map(m => ({
        symbol: `${m.symbol}USDT`,
        baseAsset: m.symbol,
        quoteAsset: 'USDT',
        marginAsset: 'USDT',
        contractType: crypto(m) ? 'PERPETUAL' : 'TRADIFI_PERPETUAL',
        status: 'TRADING',
      })),
    });
  }
  if (url.includes('/api/v1/account')) {
    const rh = venueOfUrl(url) === 'rh';
    return Response.json({ code: 200, accounts: [{ account_index: rh ? 2002 : 1001, collateral: rh ? '60.00' : '300.25', available_balance: rh ? '60.00' : '250.50',
      total_asset_value: rh ? '60.00' : '302.15',
      assets: rh ? [{ symbol: 'USDG', balance: '60.00', locked_balance: '0' }] : [{ symbol: 'USDC', balance: '300.25', locked_balance: '12.50' }],
      positions: rh ? [] : [{ market_id: 0, symbol: 'ETH', sign: 1, position: '0.0100', avg_entry_price: '3460.00', position_value: '36.50', unrealized_pnl: '1.90', realized_pnl: '4.25', initial_margin_fraction: '10.00', liquidation_price: '2150.00', margin_mode: 0, allocated_margin: '3.65' }] }] });
  }
  if (url.includes('/api/v1/trades')) {
    return Response.json({ code: 200, trades: [
      { trade_id: 901, market_id: 0, market_symbol: 'ETH', size: '0.0100', price: '3460.00', usd_amount: '34.60', bid_account_id: 1001, ask_account_id: 55, is_maker_ask: true, taker_fee: '0', maker_fee: '0', timestamp: tNow - 7_200_000 },
      { trade_id: 902, market_id: 110, market_symbol: 'NVDA', size: '0.50', price: '182.31', usd_amount: '91.155', bid_account_id: 88, ask_account_id: 1001, is_maker_ask: false, taker_fee: '0', maker_fee: '0', timestamp: tNow - 3_600_000 },
    ] });
  }
  if (url.includes('/api/v1/positionFunding')) {
    return Response.json({ code: 200, position_fundings: [
      { funding_id: 501, market_id: 0, timestamp: Math.floor((tNow - 3_600_000) / 1000), position_side: 'long', position_size: '0.01', rate: '0.0001', change: '-0.0036' },
    ] });
  }
  if (url.includes('/api/v1/pnl')) {
    return Response.json({ code: 200, pnl: Array.from({ length: 7 }, (_, i) => ({ timestamp: Math.floor((tNow - (6 - i) * 86_400_000) / 1000), trade_pnl: (i === 0 ? 1.2 : (i - 2) * 0.85).toFixed(2) })) });
  }
  if (url.includes('hyperliquid.xyz/info') && typeof init?.body === 'string') {
    const req = JSON.parse(init.body) as { type?: string };
    if (req.type === 'userAbstraction') return Response.json('unifiedAccount');
    if (req.type === 'spotClearinghouseState') {
      return Response.json({ balances: [{ coin: 'USDC', token: 0, total: '512.40', hold: '32.30' }, { coin: 'HYPE', token: 150, total: '0.02', hold: '0' }] });
    }
    if (req.type === 'clearinghouseState') {
      return Response.json({
        marginSummary: { accountValue: '0.0', totalMarginUsed: '18.20' }, withdrawable: '0.0',
        assetPositions: [{ type: 'oneWay', position: { coin: 'io:NVDA', szi: '-0.2', positionValue: '36.40', entryPx: '183.50', unrealizedPnl: '0.30', liquidationPx: '240.00', leverage: { type: 'isolated', value: 5 } } }],
      });
    }
    if (req.type === 'userFillsByTime') {
      return Response.json([
        { tid: 101, oid: 700101, coin: 'io:NVDA', px: '183.50', sz: '0.2', side: 'A', dir: 'Open Short', crossed: true, fee: '0.016', feeToken: 'USDC', builderFee: '0', closedPnl: '0.0', time: tNow - 7_200_000 },
        { tid: 102, oid: 700102, coin: 'io:AAPL', px: '228.40', sz: '0.5', side: 'B', dir: 'Close Short', crossed: true, fee: '0.05', feeToken: 'USDC', builderFee: '0', closedPnl: '1.45', time: tNow - 14_400_000 },
        { tid: 999, oid: 700999, coin: 'BTC', px: '98500', sz: '0.1', side: 'B', dir: 'Open Long', crossed: true, fee: '2.5', feeToken: 'USDC', builderFee: '0', closedPnl: '0.0', time: tNow - 10_000_000 },
      ]);
    }
    if (req.type === 'userFunding') {
      return Response.json([
        { time: tNow - 3_600_000, hash: '0x01', delta: { type: 'funding', coin: 'io:NVDA', usdc: '0.012', szi: '-0.2', fundingRate: '0.00015' } },
        { time: tNow - 7_200_000, hash: '0x02', delta: { type: 'funding', coin: 'BTC', usdc: '-0.95', szi: '0.1', fundingRate: '0.0001' } },
      ]);
    }
    if (req.type === 'userFees') return Response.json({ userCrossRate: '0.00045', userAddRate: '0.00015', activeReferralDiscount: '0.04', activeStakingDiscount: { discount: '0' } });
    if (req.type === 'allMids') return Response.json({ HYPE: '66.12' });
    if (req.type === 'candleSnapshot') return Response.json([]);
  }
  if (url.includes('hyperliquid.xyz/info')) {
    const listed = onVenue('entropy');
    return Response.json([
      { universe: listed.map(({ market }) => ({ name: `io:${market.symbol}`, szDecimals: market.price > 100 ? 2 : 1, maxLeverage: 10, deployerFeeScale: '1.0', growthMode: 'enabled' })), collateralToken: 0 },
      listed.map(({ market }) => { const mid = liveMid(market, 'entropy', state.get(market.symbol)!.price, Date.now()); return { markPx: mid.toFixed(3), oraclePx: (mid * 0.9998).toFixed(3), funding: '0.0000125', openInterest: '1000' }; }),
    ]);
  }
  if (url.includes('orderBookDetails')) {
    const venue = venueOfUrl(url);
    return Response.json({ code: 200, order_book_details: onVenue(venue).map(({ market, id }) => ({
      symbol: market.symbol, market_id: id, market_type: 'perp', status: 'active', size_decimals: market.price > 1000 ? 5 : 2, price_decimals: market.price > 1000 ? 1 : 3,
      min_base_amount: market.price > 1000 ? '0.0002' : '0.5', min_quote_amount: '10', taker_fee: '0.0000', maker_fee: '0.0000', mark_price: String(topOf(market, venue).price),
    })) });
  }
  const at = Date.now() - 20_000;
  return Response.json({ listings: MARKETS.map(market => {
    const quote = (bid: number, ask: number) => ({ bid: String(bid), ask: String(ask) });
    if (market.symbol === 'OPENAI') {
      const mark = market.price * 7.3;
      return { ticker: market.symbol, name: market.name, mark_price: String(mark), funding_rate: '0.1', funding_interval_s: 28_800, quotes: { updated_at: new Date(at).toISOString(), base: quote(mark * 0.999, mark * 1.001), size_1k: quote(mark * 0.998, mark * 1.002) } };
    }
    const leg = varFields(market, Math.floor(at / 60_000) * 60_000) as Record<string, number>;
    return { ticker: market.symbol, name: market.name, mark_price: String(leg.Mark), funding_rate: String(VAR_FUNDING_ANNUAL(market)), funding_interval_s: 28_800,
      quotes: { updated_at: new Date(at).toISOString(), base: quote(leg.Bid0!, leg.Ask0!), size_1k: quote(leg.Bid1k!, leg.Ask1k!), size_100k: quote(leg.Bid100k!, leg.Ask100k!) } };
  }) });
};

// 与安装后的拓扑一样：DEX 价差服务在本机套接字上（Windows 用命名管道），执行服务只转发（docs/dexspread.md 11.10）。
const socket = process.platform === 'win32' ? `\\\\.\\pipe\\tp-dex-preview-${process.pid}` : join(dir, 'dex.sock');
const dex = startDex({ socket, stateDir: dir, build: 'development', options: { fetchImpl: fetchImpl as typeof fetch, accounts: () => ({ accounts: PREVIEW_ACCOUNTS, problem: null }), lighterAuth: async venue => venue === 'lighter' ? 'preview-lighter-token' : null, connect: url => url.includes('binance.com') ? new FakeBinance() : venueOfUrl(url) === 'entropy' ? new FakeEntropy() : new FakeLighter(venueOfUrl(url)) } });
await dex.ready;
const client = createDexClient(socket);
await client.pushToken({ seq: Date.now(), token: '', problem: '' });
const store = openStore(join(dir, 'executor.sqlite'));
const { binance, bybit, aster, asterTrading } = createSimulatedVenues(Date.now);
const executor = createExecutor({ store, connectors: [binance, bybit], transfers: aster, adl: asterTrading, positions: asterTrading });
if (!executor.acquire()) throw new Error('写入租约被占用');
const run = runExecutor({
  executor, store, dir, port, app, passes: [],
  views: { varlighter: { page: request => client.page(request) } },
  startedMessage: `DEX 价差预览（替身行情）已启动，数据目录 ${dir}`,
  background: () => [],
});
let link = '';
for (let i = 0; i < 100 && !link; i++) {
  try { link = readFileSync(join(dir, 'access-url'), 'utf8').trim().split('\n').at(-1)!; }
  catch { await new Promise(resolve => setTimeout(resolve, 50)); }
}
process.stdout.write(link ? `登录链接：${link}\n登录后打开：http://127.0.0.1:${port}/#/varlighter\n按 Ctrl+C 停止（临时数据目录随之删除）\n` : '未能读到登录链接\n');
await run.done;
client.close();
await dex.stop();
rmSync(dir, { recursive: true, force: true });
