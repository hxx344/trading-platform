// O7 (docs/oil.md section 12): the oil and hynix book readers take a leg from the market monitor's perpetual collector when it
// pushed a recent book, and read the venue over REST otherwise; the collector's read-only book(); Binance TradFi discovery; a
// rule counting a pushed book once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PUSHED_MAX_AGE_MS, collectorSymbol, pushedBook, pushedBooks, type CollectorBook } from '../src/oil/pushed.ts';
import { createOilMarket } from '../src/oil/market.ts';
import { createHynixMarket } from '../src/hynix/market.ts';
import { createOilRules } from '../src/oil/rules.ts';
import { createPerpetualMonitor, type PerpetualOptions } from '../src/monitor/perpetual.ts';
import { discoverMarkets } from '../src/vendor/perpetual-exchanges.mjs';
import type { PerpetualUpdate } from '../src/vendor/perpetual-stream.mjs';

const NOW = 1_800_000_000_000;
const collector = (books: Record<string, CollectorBook>) => ({ book: (exchange: string, symbol: string) => books[`${exchange}:${symbol}`] ?? null });
const at = (book: Partial<CollectorBook> = {}): CollectorBook => ({ bid: 74.1, ask: 74.12, at: NOW - 500, multiplier: 1, ...book });

test('推送盘口可用性：两边齐全且买一 < 卖一、乘数为 1、交易所时间不超过 3 秒且超前不超过 1 秒、价格是普通小数；OKX 按合约编号找', () => {
  assert.deepEqual(pushedBook(collector({ 'binance:BZUSDT': at() }), 'binance', 'BZUSDT', NOW), { bid: '74.1', ask: '74.12', at: NOW - 500 });
  assert.deepEqual([collectorSymbol('okx', 'BZUSDT'), collectorSymbol('okx', 'SKHYNIXUSDT'), collectorSymbol('bybit', 'CLUSDT'), collectorSymbol('okx', 'BTCUSDT')], ['BZ-USDT-SWAP', 'SKHYNIX-USDT-SWAP', 'CLUSDT', null]);
  assert.equal(pushedBook(collector({ 'okx:BZ-USDT-SWAP': at() }), 'okx', 'BZUSDT', NOW)?.bid, '74.1');
  assert.equal(pushedBook(collector({ 'okx:BZUSDT': at() }), 'okx', 'BZUSDT', NOW), null, 'OKX 不按合约名找');
  assert.equal(pushedBook(null, 'binance', 'BZUSDT', NOW), null, '没有采集器');
  assert.equal(pushedBook(collector({}), 'binance', 'BZUSDT', NOW), null, '没有该合约');
  assert.equal(pushedBook(collector({ 'binance:BZUSDT': at({ at: NOW - PUSHED_MAX_AGE_MS }) }), 'binance', 'BZUSDT', NOW)?.ask, '74.12', '正好 3 秒仍可用');
  for (const [book, why] of [
    [at({ at: NOW - PUSHED_MAX_AGE_MS - 1 }), '超过 3 秒'], [at({ at: NOW + 1_001 }), '超前超过 1 秒'], [at({ multiplier: 1000 }), '乘数不是 1'],
    [at({ bid: 74.12 }), '买一不低于卖一'], [at({ bid: 74.2 }), '买一高于卖一'], [at({ bid: 1e-7, ask: 2e-7 }), '指数写法'], [at({ bid: 0 }), '非正数'],
    [at({ at: Number.NaN }), '时间无效'], [at({ ask: Number.POSITIVE_INFINITY }), '非有限数'],
  ] as const) assert.equal(pushedBook(collector({ 'binance:BZUSDT': book }), 'binance', 'BZUSDT', NOW), null, why);
  // The source looks the collector up on every read, so one opened after the readers is picked up.
  let late: ReturnType<typeof collector> | null = null;
  const source = pushedBooks(() => late, () => NOW);
  assert.equal(source('binance', 'BZUSDT'), null);
  late = collector({ 'binance:BZUSDT': at() });
  assert.equal(source('binance', 'BZUSDT')?.bid, '74.1');
});

/** A REST connector that counts its book reads. */
function restVenue(venue: 'binance' | 'bybit' | 'okx', clock: { now: number }, prices: Record<string, [string, string]>) {
  const reads: string[] = [], failing = new Set<string>();
  return {
    reads, failing,
    connector: {
      venue,
      quote: async (symbol: string) => {
        reads.push(symbol);
        if (failing.has(symbol)) throw new Error('读取超时');
        const [bid, ask] = prices[symbol] ?? ['1', '2'];
        return { venue, symbol, bid, ask, sourceTime: null, receivedAt: clock.now, connectionGeneration: 0, sequence: null, complete: true };
      },
    },
  };
}

test('读取器：推送盘口可用的腿不发 REST、盘口时刻记交易所时间；其余腿照旧 REST；推送盘口不让一条腿的时刻倒退；海力士同样', async () => {
  const clock = { now: NOW };
  const books: Record<string, CollectorBook> = { 'binance:BZUSDT': at({ bid: 74.1, ask: 74.12, at: NOW - 200 }) };
  const rest = restVenue('binance', clock, { BZUSDT: ['74.00', '74.05'], CLUSDT: ['70.00', '70.05'] });
  const market = createOilMarket({ connectors: [rest.connector] as never, accounts: [], now: () => clock.now, pushed: pushedBooks(() => collector(books), () => clock.now) });
  await market.refreshQuotes();
  assert.deepEqual(rest.reads, ['CLUSDT'], 'BZ 用推送盘口，CL 没有推送走 REST');
  const view = () => Object.fromEntries(market.view().books.map(row => [row.symbol, [row.bid, row.ask, row.receivedAt, row.source]]));
  assert.deepEqual(view(), { BZUSDT: ['74.1', '74.12', NOW - 200, 'pushed'], CLUSDT: ['70', '70.05', NOW, 'rest'] }, 'REST 盘口照旧规范化');
  assert.deepEqual(market.view().sameExchange[0]!.sell, '4.05', '价差照旧按十进制算');

  // Older than one round: back to REST, and a pushed book older than what the leg already shows is not taken.
  clock.now += 3_500;
  await market.refreshQuotes();
  assert.deepEqual([...rest.reads].sort(), ['BZUSDT', 'CLUSDT', 'CLUSDT']);
  assert.deepEqual(view().BZUSDT, ['74', '74.05', clock.now, 'rest']);
  books['binance:BZUSDT'] = at({ bid: 74.3, ask: 74.31, at: clock.now - 100 });
  await market.refreshQuotes();
  assert.equal(rest.reads.filter(symbol => symbol === 'BZUSDT').length, 2, '推送时间早于已有的 REST 时刻：不倒退，仍读 REST');
  books['binance:BZUSDT'] = at({ bid: 74.3, ask: 74.31, at: clock.now + 50 });
  await market.refreshQuotes();
  assert.deepEqual(view().BZUSDT, ['74.3', '74.31', clock.now + 50, 'pushed']);

  // Without a source (no monitor.perpetual) every leg is REST, as before.
  const plain = createOilMarket({ connectors: [rest.connector] as never, accounts: [], now: () => clock.now });
  await plain.refreshQuotes();
  assert.deepEqual(plain.view().books.map(row => row.source), ['rest', 'rest']);

  const hynixRest = restVenue('okx', clock, {});
  const hynix = createHynixMarket({ connectors: [hynixRest.connector] as never, accounts: [], now: () => clock.now,
    pushed: pushedBooks(() => collector({ 'okx:SKHY-USDT-SWAP': at({ bid: 120.5, ask: 120.6, at: clock.now }), 'okx:SKHYNIX-USDT-SWAP': at({ bid: 11.1, ask: 11.2, at: clock.now }) }), () => clock.now) });
  await hynix.refreshQuotes();
  assert.deepEqual(hynixRest.reads, []);
  assert.deepEqual(hynix.view().books.map(row => [row.symbol, row.bid, row.source]), [['SKHYUSDT', '120.5', 'pushed'], ['SKHYNIXUSDT', '11.1', 'pushed']]);
});

test('读取器：REST 失败后，早于失败时刻的推送盘口不用（页面与规则对同一条腿判断一致）；推送查询抛错当作没有推送', async () => {
  const clock = { now: NOW };
  const books: Record<string, CollectorBook> = {};
  const rest = restVenue('binance', clock, { BZUSDT: ['74.00', '74.05'] });
  let throwing = false;
  const source = pushedBooks(() => collector(books), () => clock.now);
  const market = createOilMarket({ connectors: [rest.connector] as never, accounts: [], now: () => clock.now,
    pushed: (venue, symbol) => { if (throwing) throw new Error('采集器异常'); return source(venue, symbol); } });
  const bz = () => market.view().books.find(row => row.symbol === 'BZUSDT')!;
  // The page's own failure test (OilPage / HynixPage book cell).
  const broken = () => { const row = bz(); return row.failedAt !== null && (row.receivedAt === null || row.failedAt > row.receivedAt); };
  rest.failing.add('BZUSDT');
  await market.refreshQuotes();
  const failedAt = clock.now;
  assert.equal(broken(), true);
  clock.now += 1_000;
  books['binance:BZUSDT'] = at({ at: failedAt - 500 });
  rest.failing.clear();
  await market.refreshQuotes();
  assert.deepEqual([bz().source, bz().receivedAt, broken()], ['rest', clock.now, false], '推送时间早于失败时刻：走 REST');
  rest.failing.add('BZUSDT');
  clock.now += 1_000;
  await market.refreshQuotes();
  assert.equal(broken(), true);
  books['binance:BZUSDT'] = at({ at: clock.now + 100 });
  clock.now += 500;
  await market.refreshQuotes();
  assert.deepEqual([bz().source, bz().error, broken()], ['pushed', null, false], '失败之后的推送盘口：采用，页面不再显示失败');
  throwing = true; rest.failing.clear();
  const before = rest.reads.length;
  clock.now += 1_000;
  await market.refreshQuotes();
  assert.deepEqual([bz().source, bz().error, rest.reads.length - before], ['rest', null, 2], '推送查询抛错：改走 REST，不记为读取失败');
});

test('规则：推送盘口没变（交易所时间相同）不重复计数，新的推送盘口才计', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-oil-pushed-'));
  const clock = { now: NOW };
  const books: Record<string, CollectorBook> = {};
  const push = (time: number) => {
    books['binance:BZUSDT'] = at({ bid: 74.1, ask: 74.12, at: time });
    books['binance:CLUSDT'] = at({ bid: 70, ask: 70.05, at: time });
  };
  const rest = restVenue('binance', clock, {});
  const market = createOilMarket({ connectors: [rest.connector] as never, accounts: [], now: () => clock.now, pushed: pushedBooks(() => collector(books), () => clock.now) });
  const rules = createOilRules({ file: join(dir, 'oil-rules.sqlite'), venues: ['binance'], books: () => market.view().books, now: () => clock.now });
  try {
    rules.create({ config: { name: '', venue: 'binance', direction: 'short', openThreshold: '4', closeThreshold: '3', barrels: '1', confirmSamples: 3, maxOpensPerDay: 3 }, observing: true });
    const hits = () => (rules.view() as { rules: { observation: { open: { hits: number } | null } | null }[] }).rules[0]!.observation?.open?.hits ?? 0;
    push(clock.now - 100);
    await market.refreshQuotes(); await rules.tick();
    clock.now += 1_000; push(clock.now - 100);
    await market.refreshQuotes(); await rules.tick();
    assert.equal(hits(), 1);
    clock.now += 1_000;
    await market.refreshQuotes(); await rules.tick();
    assert.equal(hits(), 1, '同一份推送盘口不重复计');
    clock.now += 1_000; push(clock.now - 100);
    await market.refreshQuotes(); await rules.tick();
    assert.equal(hits(), 2);
    assert.deepEqual(rest.reads, [], '全程没有 REST 读取');
  } finally { rules.close(); rmSync(dir, { recursive: true, force: true }); }
});

/** WebSockets the collector opens in a test, by URL. */
function fakeSockets() {
  const sockets: { url: string; emit(type: string, data?: unknown): void; readyState: number; closed: boolean }[] = [];
  class FakeSocket {
    readyState = 0; binaryType = 'blob'; closed = false;
    readonly listeners = new Map<string, ((event: { data: unknown }) => void)[]>();
    readonly url: string;
    constructor(url: string) { this.url = url; sockets.push(this); setTimeout(() => { if (!this.closed) { this.readyState = 1; this.emit('open'); } }, 0); }
    addEventListener(type: string, listener: (event: { data: unknown }) => void): void { this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]); }
    emit(type: string, data?: unknown): void { for (const listener of this.listeners.get(type) ?? []) listener({ data }); }
    send(): void {}
    close(): void { this.closed = true; this.readyState = 3; }
  }
  return { sockets, FakeSocket };
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const until = async (check: () => boolean, what: string) => { for (let i = 0; i < 500; i++) { if (check()) return; await sleep(4); } assert.fail(`等待超时：${what}`); };

test('采集器 book：运行中返回已提交的买一卖一、交易所时间与乘数；没有盘口或停止后为 null', async () => {
  const { sockets, FakeSocket } = fakeSockets();
  let clock = NOW;
  const options: PerpetualOptions = {
    exchanges: [{ id: 'binance', name: 'Binance', kind: 'cex' }],
    discover: async exchange => ['BZUSDT', 'CLUSDT'].map(symbol => ({ id: `${exchange}:${symbol}`, exchange, symbol, base: symbol.slice(0, 2), quoteCurrency: 'USDT' })),
    subscriptions: (exchange, markets) => [{ url: `wss://${exchange}.test/ws`, markets, subscribe: [{ op: 'subscribe' }], sendIntervalMs: 1 }],
    parse: ((_exchange: string, payload: unknown) => (payload as { updates?: PerpetualUpdate[] }).updates ?? []) as PerpetualOptions['parse'],
    control: (() => null) as PerpetualOptions['control'],
    WebSocketImpl: FakeSocket as never, now: () => clock, retryMs: 20, observationIntervalMs: 5, broadcastIntervalMs: 15, log: () => undefined,
  };
  const perpetual = createPerpetualMonitor(options);
  assert.equal(perpetual.book('binance', 'BZUSDT'), null, '未启动');
  try {
    perpetual.start();
    await until(() => sockets.some(socket => socket.readyState === 1), '连上');
    await sleep(20);
    sockets.at(-1)!.emit('message', JSON.stringify({ updates: [{ exchange: 'binance', symbol: 'BZUSDT', base: 'BZ', quoteCurrency: 'USDT', bid: 74.1, ask: 74.12, sourceTime: NOW - 300 }] }));
    await until(() => perpetual.book('binance', 'BZUSDT') !== null, '盘口提交');
    assert.deepEqual(perpetual.book('binance', 'BZUSDT'), { bid: 74.1, ask: 74.12, at: NOW - 300, multiplier: 1 });
    assert.equal(perpetual.book('binance', 'CLUSDT'), null, '没有盘口');
    clock += 1_000;
  } finally { perpetual.stop(); }
  assert.equal(perpetual.book('binance', 'BZUSDT'), null, '停止后清空');
});

test('采集器真实解析到 book：Bybit 增量只带一边时盘口时间不前进；OKX 按合约编号做键；乘数不为 1 的合约不用', async () => {
  const { sockets, FakeSocket } = fakeSockets();
  const clock = { now: NOW };
  const rows: Record<string, { symbol: string; base: string; multiplier: number }[]> = {
    bybit: [{ symbol: 'CLUSDT', base: 'CL', multiplier: 1 }, { symbol: '1000BZUSDT', base: 'BZ', multiplier: 1000 }],
    okx: [{ symbol: 'BZ-USDT-SWAP', base: 'BZ', multiplier: 1 }],
  };
  const perpetual = createPerpetualMonitor({
    exchanges: [{ id: 'bybit', name: 'Bybit', kind: 'cex' }, { id: 'okx', name: 'OKX', kind: 'cex' }],
    discover: async exchange => rows[exchange]!.map(row => ({ id: `${exchange}:${row.symbol}`, exchange, quoteCurrency: 'USDT', ...row })),
    subscriptions: (exchange, markets) => [{ url: `wss://${exchange}.test/ws`, markets, subscribe: [{ op: 'subscribe' }], sendIntervalMs: 1 }],
    WebSocketImpl: FakeSocket as never, now: () => clock.now, retryMs: 20, observationIntervalMs: 5, broadcastIntervalMs: 15, log: () => undefined,
  } as PerpetualOptions);
  const socket = (exchange: string) => sockets.findLast(item => item.url === `wss://${exchange}.test/ws`)!;
  const source = pushedBooks(() => perpetual, () => clock.now);
  try {
    perpetual.start();
    await until(() => ['bybit', 'okx'].every(exchange => socket(exchange)?.readyState === 1), '连上');
    await sleep(20);
    const t1 = NOW - 1_000;
    socket('bybit').emit('message', JSON.stringify({ topic: 'tickers.CLUSDT', type: 'snapshot', ts: t1, data: { symbol: 'CLUSDT', bid1Price: '70', bid1Size: '3', ask1Price: '70.05', ask1Size: '2', markPrice: '70.02' } }));
    socket('bybit').emit('message', JSON.stringify({ topic: 'tickers.1000BZUSDT', type: 'snapshot', ts: t1, data: { symbol: '1000BZUSDT', bid1Price: '74100', bid1Size: '1', ask1Price: '74120', ask1Size: '1' } }));
    socket('okx').emit('message', JSON.stringify({ arg: { channel: 'tickers', instId: 'BZ-USDT-SWAP' }, data: [{ instId: 'BZ-USDT-SWAP', bidPx: '74.1', bidSz: '5', askPx: '74.12', askSz: '4', last: '74.11', ts: String(t1) }] }));
    await until(() => source('bybit', 'CLUSDT') !== null && source('okx', 'BZUSDT') !== null, '盘口提交');
    assert.deepEqual(source('bybit', 'CLUSDT'), { bid: '70', ask: '70.05', at: t1 });
    assert.deepEqual(source('okx', 'BZUSDT'), { bid: '74.1', ask: '74.12', at: t1 }, 'OKX 按 BZ-USDT-SWAP 找到');
    assert.equal(perpetual.book('bybit', '1000BZUSDT')?.multiplier, 1000);
    assert.equal(source('bybit', '1000BZUSDT'), null, '乘数不为 1');

    // A delta with only the bid: the book's time stays at the older ask, so the leg ages out instead of looking fresh.
    socket('bybit').emit('message', JSON.stringify({ topic: 'tickers.CLUSDT', type: 'delta', ts: NOW - 100, data: { symbol: 'CLUSDT', bid1Price: '70.01', bid1Size: '1' } }));
    await until(() => source('bybit', 'CLUSDT')?.bid === '70.01', '增量提交');
    assert.equal(source('bybit', 'CLUSDT')!.at, t1, '只带买一的增量不让盘口时间前进');
    clock.now = t1 + 3_001;
    assert.equal(source('bybit', 'CLUSDT'), null, '卖一 3 秒没更新：不再采用');
  } finally { perpetual.stop(); }
});

test('合约发现：Binance 收入 TRADIFI_PERPETUAL（原油、海力士），交割与已下架照旧排除；Aster 不变', async () => {
  const row = (symbol: string, contractType: string, status = 'TRADING') => ({ symbol, baseAsset: symbol.replace(/USDT$/, ''), quoteAsset: 'USDT', marginAsset: 'USDT', status, contractType });
  const symbols = [row('BTCUSDT', 'PERPETUAL'), row('BZUSDT', 'TRADIFI_PERPETUAL'), row('SKHYUSDT', 'TRADIFI_PERPETUAL'), row('BTCUSDT_261225', 'CURRENT_QUARTER'), row('OLDUSDT', 'TRADIFI_PERPETUAL', 'SETTLING')];
  const fetchImpl = (async (url: string) => new Response(JSON.stringify(String(url).endsWith('fundingInfo') ? [] : { symbols }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  const binance = await discoverMarkets('binance', { fetchImpl });
  assert.deepEqual(binance.map(market => market.symbol).sort(), ['BTCUSDT', 'BZUSDT', 'SKHYUSDT']);
  assert.equal(binance.find(market => market.symbol === 'BZUSDT')!.assetClass, 'rwa');
  const aster = await discoverMarkets('aster', { fetchImpl });
  assert.deepEqual(aster.map(market => market.symbol), ['BTCUSDT']);
});
