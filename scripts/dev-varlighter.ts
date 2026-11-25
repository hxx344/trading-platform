// DEX 价差页（docs/varlighter.md、docs/dexspread.md）的本地预览：替身 Var 公开行情、Lighter RH 与 Lighter 主网的行情流（一档与 order_book 盘口）、
// Entropy（Hyperliquid io）的目录与行情流（bbo、activeAssetCtx、l2Book），临时数据目录里预先写入 4 天的分钟样本，并按回测结果补几笔模拟成交，
// 页面上的走势、统计、模拟盘都有内容。不联网，退出时删除临时目录。
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
import { startDex } from '../src/dex/main.ts';
import { createDexClient } from '../src/dex/ipc.ts';
import { openVarLighterStore, VARLIGHTER_FILE } from '../src/varlighter/store.ts';
import { runBacktest } from '../src/varlighter/backtest.ts';
import { KNOWN_KINDS, REVIEW_KINDS, pairKey, regimeOf, varHourly, type Leg, type LiveVenue, type Sample } from '../src/varlighter/model.ts';
import { DEFAULT_GLOBAL, DEFAULT_SYMBOL } from '../src/varlighter/strategy.ts';
import { SETTINGS_KEY } from '../src/varlighter/engine.ts';
import type { Settings } from '../src/varlighter/views.ts';
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
/** 行情流场所的中间价：基准价加偏移，再加几个基点的慢摆动（各场所相位不同），两腿都是行情流的配对也有价差可看。 */
const liveMid = (market: Market, venue: LiveVenue, price: number, t: number) => {
  const item = venueItem(market, venue)!, phase = { rh: 0, lighter: 2.1, entropy: 4.2 }[venue];
  return price * (1 + (item.offset + 4 * Math.sin(t / 420_000 + phase + item.id)) / 10_000);
};
const crypto = (market: Market) => kindOf(market.symbol) === 'crypto';
const VAR_FUNDING_ANNUAL = (market: Market) => crypto(market) ? 0.1095 : 0.05;

type LegFields = Record<string, number | null>;
function varFields(market: Market, t: number): LegFields {
  const { price, basis } = step(market, t), mid = price * (1 + basis / 10_000);
  const h = half(mid, crypto(market) ? 2 : 5), h1k = h + half(mid, 1), h100k = h + half(mid, 6);
  return { At: t, Mark: mid, Index: null, Funding: varHourly(VAR_FUNDING_ANNUAL(market)), Bid0: mid - h, Ask0: mid + h, Bid1k: mid - h1k, Ask1k: mid + h1k, Bid100k: mid - h100k, Ask100k: mid + h100k,
    BidRx: null, AskRx: null, BidTk: null, AskTk: null, TkAt: null };
}
function liveFields(market: Market, venue: LiveVenue, t: number): LegFields {
  const mid = liveMid(market, venue, step(market, t).price, t), h = half(mid, crypto(market) ? 1 : 3);
  return { At: t, Mark: mid, Index: mid, Funding: crypto(market) ? 0.0000125 : 0.000005, Bid0: mid - h, Ask0: mid + h, Bid1k: mid - h * 1.2, Ask1k: mid + h * 1.2, Bid100k: mid - h * 3, Ask100k: mid + h * 3,
    BidRx: mid - h, AskRx: mid + h, BidTk: null, AskTk: null, TkAt: null };
}
const legFields = (leg: Leg, t: number) => { const market = bySymbol.get(leg.symbol)!; return leg.venue === 'var' ? varFields(market, t) : liveFields(market, leg.venue, t); };
function sampleOf([a, b]: [Leg, Leg], t: number): Sample {
  const prefixed = (side: 'a' | 'b', fields: LegFields) => Object.fromEntries(Object.entries(fields).map(([key, value]) => [`${side}${key}`, value]));
  const receivedAt = a.venue === 'var' || b.venue === 'var' ? t + 20_000 : t;
  return { symbol: pairKey(a, b, 1), t, receivedAt, regime: regimeOf(kindOf(a.symbol), t), ratio: 1, ...prefixed('a', legFields(a, t)), ...prefixed('b', legFields(b, t)) } as Sample;
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
  // 一个已下架的配对（不在目录里）：已启用、有持仓，演示总览的「不在当前配对里的标的」。
  const gone = { ...history.get('var:AAPL|rh:AAPL')!.at(-120)!, symbol: 'var:DELISTED|rh:DELISTED' };
  store.addSamples([gone]);
  store.savePosition({ id: 'preview-delisted', symbol: gone.symbol, direction: 'a_rich', openedAt: gone.t - 600_000, qty: 5, notionalUsd: 1000, entrySpread: 12, entryBaseline: 2,
    entryRegime: gone.regime, aEntry: gone.aBid1k!, bEntry: gone.bAsk0, estimated: false, ratio: 1, aFeeBps: 0, bFeeBps: 0 });
  const settings: Settings = {
    revision: 1, global, symbols: { ...symbols, [gone.symbol]: { ...DEFAULT_SYMBOL, enabled: true } }, confirmed: [],
    combos: ['var|rh', 'var|lighter', 'var|entropy', 'lighter|entropy'], pairs: [{ a: { venue: 'rh', symbol: 'ETH' }, b: { venue: 'lighter', symbol: 'ETH' }, ratio: 1, kind: 'crypto', note: '预览：两条行情流' }],
  };
  store.setState(SETTINGS_KEY, settings, now);
  for (const [key, params] of Object.entries(symbols)) {
    const list = history.get(key)!;
    const result = runBacktest(key, kindOf(key.split('|')[0]!.split(':')[1]!), list, now - 3 * 86_400_000, now, params, global, { aFeeBps: 0, bFeeBps: 0 });
    for (const trade of result.trades.map(item => ({ ...item, id: `preview-${key}-${item.id}` }))) store.closePosition(trade, { at: trade.closedAt, kind: 'close', message: `（预览）${trade.reason} 净 ${trade.netUsd.toFixed(2)} 美元` });
  }
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
  constructor() {
    setTimeout(() => { this.readyState = 1; this.onopen?.({}); }, 50);
    this.timer = setInterval(() => { if (this.readyState === 1) this.tick(); }, 1_000);
  }
  protected push(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
  protected abstract tick(): void;
  abstract send(data: string): void;
  close() { this.readyState = 3; clearInterval(this.timer); this.onclose?.({}); }
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
  constructor(venue: LiveVenue) { super(); this.venue = venue; }
  private stats() {
    return Object.fromEntries(onVenue(this.venue).map(({ market, id }) => { const top = topOf(market, this.venue); return [id, { market_id: id, symbol: market.symbol, best_bid_price: top.bid.toFixed(4), best_ask_price: top.ask.toFixed(4), mark_price: top.price.toFixed(4), index_price: top.price.toFixed(4), current_funding_rate: '0.0005' }]; }));
  }
  protected tick() {
    this.push({ type: 'update/market_stats', channel: 'market_stats:all', market_stats: this.stats() });
    for (const [id, book] of this.books) {
      const found = onVenue(this.venue).find(item => item.id === id);
      if (!found) continue;
      const next = lighterLevels(found.market, this.venue);
      const diff = (old: { price: string }[], fresh: { price: string; size: string }[]) => [...old.filter(level => !fresh.some(item => item.price === level.price)).map(level => ({ price: level.price, size: '0.0000' })), ...fresh];
      this.push({ type: 'update/order_book', channel: `order_book:${id}`, order_book: { code: 0, bids: diff(book.levels.bids, next.bids), asks: diff(book.levels.asks, next.asks), begin_nonce: book.nonce, nonce: book.nonce + 1 } });
      this.books.set(id, { levels: next, nonce: book.nonce + 1 });
    }
  }
  send(data: string) {
    const message = JSON.parse(data) as { type: string; channel?: string };
    if (message.type === 'subscribe' && message.channel === 'market_stats/all') this.push({ type: 'subscribed/market_stats', channel: 'market_stats:all', market_stats: this.stats() });
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
  protected tick() {
    for (const key of this.subscriptions) {
      const [type, coin] = key.split('|') as [string, string], found = entropyMarket(coin);
      if (!found) continue;
      const top = topOf(found, 'entropy');
      if (type === 'bbo') this.push({ channel: 'bbo', data: { coin, time: Date.now(), bbo: [{ px: top.bid.toFixed(3), sz: '50', n: 3 }, { px: top.ask.toFixed(3), sz: '50', n: 2 }] } });
      if (type === 'activeAssetCtx') this.push({ channel: 'activeAssetCtx', data: { coin, ctx: { markPx: top.price.toFixed(3), oraclePx: (top.price * 0.9998).toFixed(3), funding: '0.0000125', openInterest: '1000' } } });
      if (type === 'l2Book') this.push({ channel: 'l2Book', data: l2Book(coin) });
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
const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes('hyperliquid.xyz/info')) {
    const listed = onVenue('entropy');
    return Response.json([
      { universe: listed.map(({ market }) => ({ name: `io:${market.symbol}`, szDecimals: market.price > 100 ? 2 : 1, maxLeverage: 10, deployerFeeScale: '1.0', growthMode: 'disabled' })), collateralToken: 0 },
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
const dex = startDex({ socket, stateDir: dir, build: 'development', options: { fetchImpl: fetchImpl as typeof fetch, connect: url => venueOfUrl(url) === 'entropy' ? new FakeEntropy() : new FakeLighter(venueOfUrl(url)) } });
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
