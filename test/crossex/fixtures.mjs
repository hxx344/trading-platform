// Adapted from project-aggregation 工作台 modules/crossex/tests/fixtures.mjs (commit 7745181) for the vendored copy.
// Changes: the workbench store (server/store.mjs) is replaced by this service's store (src/crossex/store.ts) with a test
// key and the widest caps, exported as createStore(directory) for the ported tests that imported it; that store has no
// paper-trading tables, so positions() / executions() are always empty. The paper engine (server/engine.mjs) is not
// vendored: fixture() builds the store only.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCrossexStore } from '../../src/crossex/store.ts';
import { CROSSEX_LIMIT_BOUNDS } from '../../src/service/crossex-config.ts';
import { pairKey } from '../../src/vendor/crossex/model.mjs';
export const TEST_SECRET = { apiKey: 'test-api-key-1234', apiSecret: 'test-secret-5678' };
const widest = { notionalPerLeg: CROSSEX_LIMIT_BOUNDS.notionalPerLeg[1], maxOpen: CROSSEX_LIMIT_BOUNDS.maxOpen[1], maxTotalNotional: CROSSEX_LIMIT_BOUNDS.maxTotalNotional[1] };
export function createStore(directory) {
  const store = openCrossexStore(directory, { secret: TEST_SECRET, limits: widest });
  return { ...store, positions: () => [], executions: () => [] };
}
export const epoch = 1790000000000;
export function quote(exchange, at = epoch, extra = {}) { return { exchange, symbol: 'BTCUSDT', base: 'BTC', quoteCurrency: 'USDT', collateralCurrency: 'USDT', multiplier: 1, assetClass: 'crypto', identitySource: 'test-official-directory', identityVerified: true, bid: exchange === 'binance' ? 99 : 102, ask: exchange === 'binance' ? 100 : 103, bidAskAt: at, receivedAt: at, ...extra }; }
export function feed(at = epoch) { const long = quote('binance', at), short = quote('bybit', at); const signal = { id: `signal-${at}`, base: 'BTC', quoteCurrency: 'USDT', long, short, observedAt: at, expiresAt: at + 10000 }; return { schemaVersion: 1, mode: 'paper', source: 'market-monitor', monitorId: 'perpetual', generatedAt: at, status: 'live', exchanges: [{ id: 'binance', status: 'live' }, { id: 'bybit', status: 'live' }], quotes: [long, short], signals: [{ ...signal, pairKey: pairKey(signal) }] }; }
export const catalog = ['BINANCE', 'BYBIT'].map(exchange => ({ symbol: `${exchange}_FUTURE_BTC_USDT`, exchange_type: exchange, business_type: 'FUTURE', state: 'live', min_size: '0.001', lot_size: '0.001', tick_size: '0.01', min_notional: '5', max_market_size: '10000', delist_time: '0' }));
export function book(q, at = epoch) { return { at, bids: [[q.bid, 100]], asks: [[q.ask, 100]] }; }
export function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'crossex-test-')); let now = epoch;
  let store = createStore(directory);
  t.after(() => { store.close(); const resolved = join(tmpdir(), ''); if (!directory.startsWith(resolved) || !directory.includes('crossex-test-')) throw new Error('Unsafe test cleanup'); rmSync(directory, { recursive: true, force: true }); });
  return { directory, get store() { return store; }, advance(ms) { now += ms; }, now: () => now, async reopen() { store.close(); store = createStore(directory); } };
}
