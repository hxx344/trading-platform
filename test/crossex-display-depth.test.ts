// Display-only depth sharing between the CrossEx open-capacity estimate and the terminal (src/crossex/display-depth.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DISPLAY_DEPTH_TTL_MS, createDisplayDepth, type DepthReader } from '../src/crossex/display-depth.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMarket } from '../src/vendor/crossex/market.mjs';
// @ts-expect-error 测试用存储是没有类型声明的 .mjs
import { createStore } from './crossex/workbench-store.mjs';

const quote = (symbol = 'BTCUSDT', overrides: Record<string, unknown> = {}) => ({ exchange: 'binance', symbol, base: 'BTC', quoteCurrency: 'USDT', crossexSymbol: `BINANCE_FUTURE_${symbol}`, nativeUnit: '1', assetClass: 'crypto', ...overrides });

test('CrossEx 展示用深度：同一合约并发只读一次，1 秒内复用并保留来源时间；失败不保留；身份不同或连接换代时重读', async () => {
  let clock = 1_800_000_000_000, reads = 0, current = true, failing = false;
  const reader: DepthReader = async q => {
    reads++;
    if (failing) throw new Error('down');
    return { exchange: q.exchange, symbol: q.symbol, at: clock - 40, receivedAt: clock, bids: [[1, 1]], asks: [[2, 1]], isCurrent: () => current };
  };
  const display = createDisplayDepth({ now: () => clock }), shared = display(reader);
  assert.equal(display(reader), shared, '同一个读取器只包一次，容量与终端共用');
  const [first, second] = await Promise.all([shared(quote()), shared(quote())]);
  assert.deepEqual([reads, first === second, first.at], [1, true, clock - 40]);
  clock += DISPLAY_DEPTH_TTL_MS - 1;
  assert.equal((await shared(quote())).at, first.at, '复用的盘口仍带原来的来源时间');
  assert.equal(reads, 1);
  await shared(quote('ETHUSDT')); await shared(quote('BTCUSDT', { nativeUnit: '0.001' }));
  assert.equal(reads, 3, '另一个合约或另一个数量单位各读各的');
  clock += 1;
  assert.equal((await shared(quote())).at, clock - 40);
  assert.equal(reads, 4, '满 1 秒重读');
  current = false; await shared(quote());
  assert.equal(reads, 5, '行情连接换代后不复用旧盘口');
  current = true; clock += DISPLAY_DEPTH_TTL_MS; failing = true;
  await assert.rejects(Promise.all([shared(quote()), shared(quote())]), /down/);
  assert.equal(reads, 6, '等同一次读取的调用方一起失败');
  failing = false; await shared(quote());
  assert.equal(reads, 7, '失败不保留');
  clock -= 5_000; await shared(quote());
  assert.equal(reads, 8, '时钟回拨时不复用');
});

test('CrossEx 行情：开仓容量用展示读取器，预览与发送前复核仍用自己的深度读取器', async t => {
  const now = 1_791_430_000_000, symbol = 'BINANCE_FUTURE_BTC_USDT', directory = mkdtempSync(join(tmpdir(), 'crossex-display-depth-')), store = createStore(directory);
  const reads = { capacity: 0, own: 0 };
  const book = (kind: 'capacity' | 'own') => async (q: { bid: number; ask: number }) => { reads[kind]++; return { at: now, bids: [[q.bid, 100]], asks: [[q.ask, 100]] }; };
  const market = createMarket(store, {
    clock: () => now, manualDepthReader: book('own'), capacityDepthReader: book('capacity'), fxReader: async () => ({ baseCurrency: 'USDT', staleAfterMs: 180_000, rates: {} }),
    catalogReader: async () => [{ symbol, exchange_type: 'BINANCE', business_type: 'FUTURE', state: 'live', min_size: '0.001', lot_size: '0.001', tick_size: '0.01', min_notional: '5', max_market_size: '10000', max_limit_size: '10000', delist_time: '0' }],
    manualIdentityReader: async () => ({ exchange: 'binance', symbol: 'BTCUSDT', crossexSymbol: symbol, base: 'BTC', rawBase: 'BTC', quoteCurrency: 'USDT', collateralCurrency: 'USDT', settlementCurrency: 'USDT', counterCurrency: 'USDT',
      contractKind: 'linear', multiplier: 1, nativeUnit: '1', assetClass: 'crypto', identityScope: 'manual', comparable: true, identitySource: 'exchange-instrument-metadata', identityVerified: true, bid: 99, ask: 100, bidAskAt: now, receivedAt: now }),
  });
  t.after(async () => { await market.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  (market.settings as (input: unknown) => unknown)({ config: { notionalPerLeg: 100_000, maxTotalNotional: 2_000_000, maxOpen: 20, slippageBps: 0 } });
  const order = { symbol, side: 'BUY', orderType: 'LIMIT', timeInForce: 'GTC', price: '100' };
  await (market.openCapacityContext as (request: unknown) => Promise<unknown>)({ source: 'direct', requests: [order] });
  assert.deepEqual(reads, { capacity: 1, own: 0 });
  const plan = await (market.previewDirect as (order: unknown) => Promise<unknown>)({ ...order, quantity: '1' });
  assert.deepEqual(reads, { capacity: 1, own: 1 });
  await (market.revalidateOpen as (plan: unknown) => Promise<unknown>)(plan);
  assert.deepEqual(reads, { capacity: 1, own: 2 });
});
