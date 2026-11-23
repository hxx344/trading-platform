// Var/Lighter 价差页（docs/varlighter.md）的本地预览：替身 Var 公开行情、Lighter RH 与 Lighter 主网的行情流与盘口快照，
// 临时数据目录里预先写入 4 天的分钟样本，并按回测结果补几笔模拟成交，页面上的走势、统计、模拟盘都有内容。
// 不联网，退出时删除临时目录。
//   pnpm build:web; node scripts/dev-varlighter.ts [--port 4733]
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { openStore } from '../src/store.ts';
import { createExecutor } from '../src/executor.ts';
import { createSimulatedVenues } from '../src/simulation.ts';
import { runExecutor } from '../src/runtime.ts';
import { loadWebApp } from '../src/web-assets.ts';
import { openVarLighter, varLighterLoop, varLighterViews } from '../src/service/varlighter.ts';
import { openVarLighterStore, VARLIGHTER_FILE } from '../src/varlighter/store.ts';
import { runBacktest } from '../src/varlighter/backtest.ts';
import { KNOWN_KINDS, REVIEW_KINDS, pairKey, regimeOf, type Sample, type Venue } from '../src/varlighter/model.ts';
import { DEFAULT_GLOBAL, DEFAULT_SYMBOL } from '../src/varlighter/strategy.ts';
import type { SocketLike } from '../src/varlighter/feeds.ts';

const { values } = parseArgs({ options: { port: { type: 'string', default: '4733' } } });
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('--port 无效');

/** 替身标的：价格、Var 相对 Lighter 的基差常态（基点）、波动、夜盘偏移；各场所的市场编号与相对偏移（基点）。
 * OPENAI 两边规格不同，SPCX 待确认；主网只有加密货币与 NVDA。 */
const MARKETS = [
  { symbol: 'AAPL', name: 'Apple', price: 228, basis: 4, noise: 3, overnight: 12, venues: { rh: { id: 1, offset: 0 } } },
  { symbol: 'TSLA', name: 'Tesla', price: 345, basis: -6, noise: 6, overnight: -10, venues: { rh: { id: 2, offset: 0 } } },
  { symbol: 'NVDA', name: 'NVIDIA', price: 182, basis: 2, noise: 4, overnight: 8, venues: { rh: { id: 3, offset: 0 }, lighter: { id: 110, offset: -3 } } },
  { symbol: 'BTC', name: 'Bitcoin', price: 98_500, basis: 1.5, noise: 2, overnight: 0, venues: { rh: { id: 4, offset: 0 }, lighter: { id: 1, offset: 0.8 } } },
  { symbol: 'ETH', name: 'Ethereum', price: 3_650, basis: -2, noise: 3, overnight: 0, venues: { rh: { id: 5, offset: 0 }, lighter: { id: 0, offset: -1 } } },
  { symbol: 'SOL', name: 'Solana', price: 182, basis: 3, noise: 4, overnight: 0, venues: { lighter: { id: 2, offset: 0 } } },
  { symbol: 'SPCX', name: 'SPACX', price: 31, basis: 25, noise: 15, overnight: 0, venues: { rh: { id: 6, offset: 0 } } },
  { symbol: 'OPENAI', name: 'OpenAI', price: 50, basis: 0, noise: 0, overnight: 0, venues: { rh: { id: 7, offset: 0 } } },
] as const;
type Market = (typeof MARKETS)[number];
const VENUES_OF = (market: Market) => Object.entries(market.venues) as [Venue, { id: number; offset: number }][];
const onVenue = (venue: Venue) => MARKETS.flatMap(market => { const item = (market.venues as Partial<Record<Venue, { id: number; offset: number }>>)[venue]; return item ? [{ market, ...item }] : []; });
const kindOf = (symbol: string) => KNOWN_KINDS[symbol] ?? REVIEW_KINDS[symbol] ?? 'other';

// 均值回归的基差（OU 过程，每分钟一步，半衰期约 8 分钟），夜盘与周末抬高。Var 一个价，两个场所各自在基准价上偏一点。
let seed = 7;
const random = () => { seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31; return seed / 2 ** 31; };
const gauss = () => Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random());
const state = new Map<string, { deviation: number; price: number }>(MARKETS.map(market => [market.symbol, { deviation: 0, price: market.price }]));
function step(market: Market, t: number): { price: number; basis: number } {
  const value = state.get(market.symbol)!;
  value.deviation = value.deviation * 0.92 + gauss() * market.noise * 0.4 + (random() < 0.004 ? (random() < 0.5 ? -1 : 1) * market.noise * 4 : 0);
  value.price *= 1 + gauss() * 0.0004;
  const regime = regimeOf(kindOf(market.symbol), t);
  const shift = regime === 'overnight' || regime === 'weekend' ? market.overnight : regime === 'ext' ? market.overnight / 2 : 0;
  return { price: value.price, basis: market.basis + shift + value.deviation };
}
const half = (price: number, bps: number) => price * bps / 20_000;
const venueMid = (price: number, offset: number) => price * (1 + offset / 10_000);
/** 一分钟一步：Var 报价与各场所的样本。 */
function samplesAt(market: Market, t: number): { varMid: number; varFunding: number; samples: Sample[] } {
  const { price, basis } = step(market, t);
  const varMid = price * (1 + basis / 10_000);
  const crypto = kindOf(market.symbol) === 'crypto';
  const varHalf = half(varMid, crypto ? 2 : 5), varHalf1k = varHalf + half(varMid, 1), varHalf100k = varHalf + half(varMid, 6);
  const varFunding = crypto ? 0.1095 : 0.05;
  return { varMid, varFunding, samples: VENUES_OF(market).map(([venue, item]) => {
    const rhMid = venueMid(price, item.offset), rhHalf = half(rhMid, crypto ? 1 : 3);
    return {
      symbol: pairKey(venue, market.symbol), t, receivedAt: t + 20_000, regime: regimeOf(kindOf(market.symbol), t),
      varMark: varMid, varBid0: varMid - varHalf, varAsk0: varMid + varHalf, varBid1k: varMid - varHalf1k, varAsk1k: varMid + varHalf1k, varBid100k: varMid - varHalf100k, varAsk100k: varMid + varHalf100k, varFunding,
      rhAt: t, rhBid0: rhMid - rhHalf, rhAsk0: rhMid + rhHalf, rhMark: rhMid, rhIndex: rhMid, rhFunding: crypto ? 0.0000125 : 0.000005,
      rhBid1k: rhMid - rhHalf * 1.2, rhAsk1k: rhMid + rhHalf * 1.2, rhBid100k: rhMid - rhHalf * 3, rhAsk100k: rhMid + rhHalf * 3,
      rhBidRx: rhMid - rhHalf, rhAskRx: rhMid + rhHalf,
    };
  }) };
}

const app = loadWebApp();
const dir = mkdtempSync(join(tmpdir(), 'tp-dev-varlighter-'));
const now = Date.now();

// 预先写入 4 天样本；启用 RH 的 AAPL、BTC 与主网的 BTC、ETH，按回测补上成交记录（同一 Var 代码在两个场所的成交会重叠，预览不管）。
{
  const store = openVarLighterStore(join(dir, VARLIGHTER_FILE));
  const start = Math.floor((now - 4 * 86_400_000) / 60_000) * 60_000;
  const history = new Map<string, Sample[]>();
  for (let t = start; t < now - 60_000; t += 60_000) for (const market of MARKETS) {
    if (market.symbol === 'OPENAI') continue;
    for (const sample of samplesAt(market, t).samples) { const list = history.get(sample.symbol) ?? []; list.push(sample); history.set(sample.symbol, list); }
  }
  for (const list of history.values()) store.addSamples(list);
  const global = { ...DEFAULT_GLOBAL, minSamples: 60 };
  const symbols = {
    'rh:AAPL': { ...DEFAULT_SYMBOL, enabled: true, entryBps: 9, exitBps: 1 }, 'rh:BTC': { ...DEFAULT_SYMBOL, enabled: true, entryBps: 5, exitBps: 0.5 },
    'lighter:ETH': { ...DEFAULT_SYMBOL, enabled: true, entryBps: 7, exitBps: 1 },
  };
  // 一个已下架的配对（不在目录里）：已启用、有持仓，演示总览的「不在当前配对里的标的」。
  const gone = { ...history.get('rh:AAPL')!.at(-120)!, symbol: 'rh:DELISTED' };
  store.addSamples([gone]);
  store.savePosition({ id: 'preview-delisted', symbol: 'rh:DELISTED', direction: 'var_rich', openedAt: gone.t - 600_000, qty: 5, notionalUsd: 1000, entrySpread: 12, entryBaseline: 2,
    entryRegime: gone.regime, varEntry: gone.varBid1k, rhEntry: gone.rhAsk0, estimated: false });
  store.setState('settings', { revision: 1, global, symbols: { ...symbols, 'rh:DELISTED': { ...DEFAULT_SYMBOL, enabled: true } }, confirmed: [], venues: ['rh', 'lighter'] }, now);
  for (const [key, params] of Object.entries(symbols)) {
    const result = runBacktest(key, kindOf(key.split(':')[1]!), history.get(key)!, now - 3 * 86_400_000, now, params, global);
    for (const trade of result.trades.map(item => ({ ...item, id: `preview-${key}-${item.id}` }))) store.closePosition(trade, { at: trade.closedAt, kind: 'close', message: `（预览）${trade.reason} 净 ${trade.netUsd.toFixed(2)} 美元` });
  }
  store.close();
}

// 替身 Lighter 行情流：每秒推一次本场所全市场一档。
class FakeLighter implements SocketLike {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  private timer: ReturnType<typeof setInterval>;
  private readonly venue: Venue;
  constructor(venue: Venue) {
    this.venue = venue;
    setTimeout(() => { this.readyState = 1; this.onopen?.({}); }, 50);
    this.timer = setInterval(() => this.tick(), 1_000);
  }
  private push(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
  private stats() {
    return Object.fromEntries(onVenue(this.venue).map(({ market, id, offset }) => { const top = topOf(market, offset); return [id, { market_id: id, symbol: market.symbol, best_bid_price: top.bid.toFixed(4), best_ask_price: top.ask.toFixed(4), mark_price: top.price.toFixed(4), index_price: top.price.toFixed(4), current_funding_rate: '0.0005' }]; }));
  }
  private tick() { if (this.readyState === 1) this.push({ type: 'update/market_stats', channel: 'market_stats:all', market_stats: this.stats() }); }
  send(data: string) {
    const message = JSON.parse(data) as { type: string; channel?: string };
    if (message.type === 'subscribe' && message.channel === 'market_stats/all') this.push({ type: 'subscribed/market_stats', channel: 'market_stats:all', market_stats: this.stats() });
  }
  close() { this.readyState = 3; clearInterval(this.timer); this.onclose?.({}); }
}
function topOf(market: Market, offset: number) {
  const price = venueMid(state.get(market.symbol)!.price, offset), crypto = kindOf(market.symbol) === 'crypto', spread = half(price, crypto ? 1 : 3);
  return { bid: price - spread, ask: price + spread, price };
}

// 替身 Var 公开行情、两个场所的目录与盘口快照。Var 报价时刻比收到时早 20 秒，与真实接口的缓存相近。
const venueOfUrl = (url: string): Venue => url.includes('api.rh.lighter.xyz') ? 'rh' : 'lighter';
const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes('orderBookDetails')) return Response.json({ code: 200, order_book_details: onVenue(venueOfUrl(url)).map(({ market, id, offset }) => ({
    symbol: market.symbol, market_id: id, market_type: 'perp', status: 'active', size_decimals: market.price > 1000 ? 5 : 2, price_decimals: market.price > 1000 ? 1 : 3,
    min_base_amount: market.price > 1000 ? '0.0002' : '0.5', min_quote_amount: '10', taker_fee: '0.0000', maker_fee: '0.0000', mark_price: String(venueMid(state.get(market.symbol)!.price, offset)),
  })) });
  if (url.includes('orderBookOrders')) {
    const id = Number(new URL(url).searchParams.get('market_id'));
    const found = onVenue(venueOfUrl(url)).find(item => item.id === id);
    if (!found) return Response.json({ code: 21100, message: 'market not found' }, { status: 400 });
    const top = topOf(found.market, found.offset), size = (40_000 / top.price).toFixed(4);
    const levels = (side: 1 | -1, from: number) => [0, 1, 2, 3, 4].map(level => ({ price: (from + side * half(top.price, level * 1.5)).toFixed(4), remaining_base_amount: size }));
    return Response.json({ code: 200, total_asks: 5, asks: levels(1, top.ask), total_bids: 5, bids: levels(-1, top.bid) });
  }
  const at = Date.now() - 20_000;
  return Response.json({ listings: MARKETS.map(market => {
    const quote = (bid: number, ask: number) => ({ bid: String(bid), ask: String(ask) });
    if (market.symbol === 'OPENAI') {
      const mark = market.price * 7.3;
      return { ticker: market.symbol, name: market.name, mark_price: String(mark), funding_rate: '0.1', funding_interval_s: 28_800, quotes: { updated_at: new Date(at).toISOString(), base: quote(mark * 0.999, mark * 1.001), size_1k: quote(mark * 0.998, mark * 1.002) } };
    }
    const sample = samplesAt(market, at).samples[0]!;
    return { ticker: market.symbol, name: market.name, mark_price: String(sample.varMark), funding_rate: String(sample.varFunding), funding_interval_s: 28_800,
      quotes: { updated_at: new Date(at).toISOString(), base: quote(sample.varBid0, sample.varAsk0), size_1k: quote(sample.varBid1k!, sample.varAsk1k!), size_100k: quote(sample.varBid100k!, sample.varAsk100k!) } };
  }) });
};

const holder = openVarLighter(dir, { fetchImpl: fetchImpl as typeof fetch, connect: url => new FakeLighter(venueOfUrl(url)) }, line => process.stderr.write(`${line}\n`));
const store = openStore(join(dir, 'executor.sqlite'));
const { binance, bybit, aster, asterTrading } = createSimulatedVenues(Date.now);
const executor = createExecutor({ store, connectors: [binance, bybit], transfers: aster, adl: asterTrading, positions: asterTrading });
if (!executor.acquire()) throw new Error('写入租约被占用');
const run = runExecutor({
  executor, store, dir, port, app, passes: [],
  views: { varlighter: varLighterViews(holder) },
  startedMessage: `Var/Lighter 价差预览（替身行情）已启动，数据目录 ${dir}`,
  background: context => [varLighterLoop(holder, context)],
});
let link = '';
for (let i = 0; i < 100 && !link; i++) {
  try { link = readFileSync(join(dir, 'access-url'), 'utf8').trim().split('\n').at(-1)!; }
  catch { await new Promise(resolve => setTimeout(resolve, 50)); }
}
process.stdout.write(link ? `登录链接：${link}\n登录后打开：http://127.0.0.1:${port}/#/varlighter\n按 Ctrl+C 停止（临时数据目录随之删除）\n` : '未能读到登录链接\n');
await run.done;
rmSync(dir, { recursive: true, force: true });
