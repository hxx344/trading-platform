// What the market service's monitor readers share (src/monitor/shared-reads.ts): the Binance funding terms, the Hyperliquid
// xyz contexts, and the spread collector's Binance marks in place of premiumIndex reads. Every venue is the stand-in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBinanceGate } from '../src/vendor/anthropic-market.mjs';
import type { PerpetualQuote } from '../src/vendor/perpetual-stream.mjs';
import { createExchangeReader } from '../src/monitor/exchanges.ts';
import { createMarketReaders } from '../src/monitor/market-readers.ts';
import { BinanceCooldown } from '../src/monitor/market-contract.ts';
import { COLLECTED_MARK_MAX_AGE_MS, FUNDING_INFO_TTL_MS, createSharedMarketReads } from '../src/monitor/shared-reads.ts';
import { fakeAnthropicVenues } from './monitor-fake.ts';

const signal = () => new AbortController().signal;
function setup() {
  let t = Date.UTC(2026, 10, 13, 9, 0, 7);
  const now = () => t, venues = fakeAnthropicVenues({ now }), gate = createBinanceGate();
  const collected = new Map<string, PerpetualQuote>();
  const shared = createSharedMarketReads({ fetchImpl: venues.fetch, now, gate, quote: (exchange, symbol) => collected.get(`${exchange}:${symbol}`), signal: signal() });
  const options = { fetchImpl: venues.fetch, now, gate };
  const exchangeOptions = { ...options, log: () => undefined, oilQuote: () => null, hynixQuote: () => null };
  /** A collector row whose mark and funding fields came in one event at `at`. */
  const collect = (symbol: string, mark: number, fundingRate: number, nextFundingAt: number, at = t, overrides: Partial<PerpetualQuote> = {}) => collected.set(`binance:${symbol}`, {
    exchange: 'binance', symbol, base: symbol.replace(/USDT$/, ''), quoteCurrency: 'USDT', multiplier: 1, bid: null, ask: null, mark, last: null,
    fundingRate, fundingIntervalHours: 4, nextFundingAt, sourceTime: at, receivedAt: at, transport: 'ws', markAt: at, fundingAt: at, nextFundingAtUpdatedAt: at, ...overrides,
  });
  return {
    venues, gate, shared, collect, collected, now, advance: (ms: number) => { t += ms; }, count: (key: string) => venues.requests.get(key) ?? 0,
    readers: createMarketReaders({ ...options, shared }), alone: createMarketReaders(options),
    exchanges: () => createExchangeReader({ ...exchangeOptions, shared }), exchangesAlone: () => createExchangeReader(exchangeOptions),
  };
}

test('行情服务：原油卡片与多所对比的 Binance 行共用一次 fundingInfo（15 秒），失败不保留', async () => {
  const { readers, exchanges, venues, count, advance } = setup();
  const oil = await readers.oilQuote(signal());
  assert.deepEqual([oil.brent.fundingIntervalHours, count('quote:brent'), count('quote:wti'), count('quote:funding')], [4, 1, 1, 1]);
  const row = await exchanges().quote('hynix', 'binance');
  assert.deepEqual([row.left.fundingIntervalHours, count('exchange:binance'), count('quote:funding')], [4, 2, 1]);
  advance(FUNDING_INFO_TTL_MS - 1); await readers.oilQuote(signal());
  assert.equal(count('quote:funding'), 1);
  advance(1); venues.down.add('funding');
  // The terms are optional for both: prices stand, rates are withheld, and the failure is asked again next time.
  assert.deepEqual([(await readers.oilQuote(signal())).brent.fundingRate, (await exchanges().quote('hynix', 'binance')).left.fundingRate], [null, null]);
  assert.equal(count('quote:funding'), 3);
  venues.down.delete('funding');
  assert.equal((await readers.oilQuote(signal())).brent.fundingIntervalHours, 4);
});

test('行情服务：采集器的 Binance 标记价在 6 秒内且与资金费同一次推送时代替 premiumIndex，结果与直接读取一致；否则照旧读取', async () => {
  const { readers, alone, exchanges, exchangesAlone, collect, collected, count, advance, gate, now } = setup();
  const direct = await alone.oilQuote(signal()), next = (leg: { nextFundingAt: string | null }) => Date.parse(leg.nextFundingAt!);
  collect('BZUSDT', direct.brent.markPx, direct.brent.fundingRate!, next(direct.brent));
  collect('CLUSDT', direct.wti.markPx, direct.wti.fundingRate!, next(direct.wti));
  const before = [count('quote:brent'), count('quote:wti')];
  assert.deepEqual(await readers.oilQuote(signal()), direct);
  assert.deepEqual([count('quote:brent'), count('quote:wti')], before, '没有读 premiumIndex');

  const row = await exchangesAlone().quote('hynix', 'binance'), requests = count('exchange:binance');
  collect(row.left.symbol, row.left.price, row.left.fundingRate!, next(row.left));
  collect(row.right.symbol, row.right.price, row.right.fundingRate!, next(row.right));
  assert.deepEqual(await exchanges().quote('hynix', 'binance'), row);
  assert.equal(count('exchange:binance'), requests, '没有读 premiumIndex');

  // Each of these makes the collector's row unfit, and the venue is read as before.
  const brent = collected.get('binance:BZUSDT')!;
  const unfit: [string, Partial<PerpetualQuote>][] = [
    ['过旧', { markAt: now() - COLLECTED_MARK_MAX_AGE_MS - 1, fundingAt: now() - COLLECTED_MARK_MAX_AGE_MS - 1, nextFundingAtUpdatedAt: now() - COLLECTED_MARK_MAX_AGE_MS - 1 }],
    ['资金费不是同一次推送', { fundingAt: now() - 3_000 }], ['结算时间不是同一次推送', { nextFundingAtUpdatedAt: now() - 3_000 }],
    ['没有资金费', { fundingRate: null }], ['没有标记价', { mark: null }], ['合约乘数不是 1', { multiplier: 1000 }], ['时间在未来', { markAt: now() + 1, fundingAt: now() + 1, nextFundingAtUpdatedAt: now() + 1 }],
  ];
  let reads = count('quote:brent');
  for (const [label, change] of unfit) {
    collected.set('binance:BZUSDT', { ...brent, ...change });
    assert.deepEqual(await readers.oilQuote(signal()), direct, label);
    assert.equal(count('quote:brent'), ++reads, label);
  }
  collected.delete('binance:BZUSDT');
  await readers.oilQuote(signal());
  assert.equal(count('quote:brent'), ++reads, '采集器没有这个合约');

  // Two legs the collector received too far apart are not a quote either.
  collected.set('binance:BZUSDT', brent); advance(COLLECTED_MARK_MAX_AGE_MS);
  collect('CLUSDT', direct.wti.markPx, direct.wti.fundingRate!, next(direct.wti));
  await readers.oilQuote(signal());
  assert.equal(count('quote:brent'), reads, '6 秒整仍可用');

  // A Binance cooldown answers as it does without the collector: no quote, no request.
  collect('BZUSDT', direct.brent.markPx, direct.brent.fundingRate!, next(direct.brent));
  gate.until = now() + 60_000; gate.status = 429;
  await assert.rejects(readers.oilQuote(signal()), BinanceCooldown);
  assert.equal(count('quote:brent'), reads);
});

test('行情服务：Anthropic 卡片与多所对比共用 Hyperliquid xyz 的一次应答，卡片只用 2 秒内的；被拒时卡片照原样记该腿失败', async () => {
  const { readers, alone, exchanges, venues, count, advance } = setup();
  const reader = exchanges();
  const [card, row] = await Promise.all([readers.anthropicQuote(signal()), reader.quote('oil', 'hyperliquid')]);
  assert.ok(card.xyz !== null && row.exchange === 'hyperliquid');
  assert.equal(count('quote:xyz'), 1, '并发只发一次');
  assert.deepEqual(card.xyz, (await alone.anthropicQuote(signal())).xyz);
  const requests = count('quote:xyz');
  advance(1_999); await readers.anthropicQuote(signal());
  assert.equal(count('quote:xyz'), requests, '2 秒内卡片复用');
  advance(1); await readers.anthropicQuote(signal());
  assert.equal(count('quote:xyz'), requests + 1, '满 2 秒卡片重读');
  advance(4_999); await exchanges().quote('hynix', 'hyperliquid').catch(() => undefined); await exchanges().quote('oil', 'hyperliquid');
  assert.equal(count('quote:xyz'), requests + 1, '5 秒内对比复用卡片读到的应答');

  advance(10_000); venues.down.add('xyz');
  const [refused, expected] = [await readers.anthropicQuote(signal()), await alone.anthropicQuote(signal())];
  assert.deepEqual([refused.xyz, refused.errors.xyz], [null, expected.errors.xyz]);
  assert.match(String(refused.errors.xyz), /500/);
});
