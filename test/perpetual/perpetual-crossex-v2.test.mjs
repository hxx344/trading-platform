// 工作台 7745181 的 perpetual-crossex-v2 行为测试。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPerpetualOpportunitiesV2, CROSSEX_VENUES } from '../../src/vendor/perpetual-opportunities-v2.mjs';

const NOW = 1790000000000;
const fx = (at = NOW) => ({ baseCurrency: 'USDT', generatedAt: at, staleAfterMs: 180000, rates: { USDC: { bid: 0.998, ask: 1.002, at, source: 'Gate USDC_USDT' }, USD: { bid: 1.01, ask: 1.02, at, source: 'Kraken inverse USDT/USD' } } });
function quote(exchange, extra = {}) {
  const currency = ['bybit', 'okx', 'lighter'].includes(exchange) ? 'USDC' : exchange === 'kraken' ? 'USD' : 'USDT';
  const symbol = { binance: 'BTCUSDT', bybit: 'BTCPERP', okx: 'BTC-USDC-SWAP', gate: 'BTC_USDT', kraken: 'PF_XBTUSD', hyperliquid: 'BTC', lighter: 'BTC' }[exchange];
  return { exchange, symbol, base: 'BTC', rawBase: 'BTC', quoteCurrency: currency, multiplier: 1, assetClass: 'crypto', identityVerified: true, identitySource: 'official directory fixture', crossexVerified: true, comparable: true, delisting: false, delistingAt: null, bid: 100 + CROSSEX_VENUES.indexOf(exchange), ask: 101 + CROSSEX_VENUES.indexOf(exchange), bidAskAt: NOW, receivedAt: NOW, marketId: 1, ...extra };
}
function project(quotes = CROSSEX_VENUES.map(id => quote(id)), rates = fx(), now = NOW, patch = {}) {
  const markets = new Map(quotes.map(q => [`${q.exchange}:${q.symbol}`, q]));
  return createPerpetualOpportunitiesV2({ status: 'live', quotes, exchanges: CROSSEX_VENUES.map(id => ({ id, kind: ['hyperliquid', 'lighter'].includes(id) ? 'dex' : 'cex', status: 'live' })), ...patch }, now, (e, s) => markets.get(`${e}:${s}`), rates);
}
test('seven-venue v2 keeps native currencies and verified CrossEx mapping', () => {
  const result = project(); assert.equal(result.schemaVersion, 2); assert.equal(result.quotes.length, 7);
  for (const venue of CROSSEX_VENUES) assert.ok(result.signals.some(s => s.long.exchange === venue || s.short.exchange === venue), venue);
  const hl = result.quotes.find(q => q.exchange === 'hyperliquid');
  assert.equal(hl.quoteCurrency, 'USDT'); assert.equal(hl.settlementCurrency, 'USDC'); assert.equal(hl.contractKind, 'quanto'); assert.equal(hl.crossexSymbol, 'HYPERLIQUID_FUTURE_BTC_USDC');
  assert.equal(result.quotes.find(q => q.exchange === 'kraken').collateralCurrency, 'MULTI');
  assert.equal(result.quotes.find(q => q.exchange === 'lighter').marketId, 1);
  for (const s of result.signals) assert.ok(Math.abs(s.grossSpreadPercent - (s.referenceSellPrice / s.referenceBuyPrice - 1) * 100) < 1e-12);
});
test('non-1 FX and spread are applied to both legs, including same-currency pairs', () => {
  const rows = [quote('binance'), quote('okx', { ask: 100, bid: 99 }), quote('lighter', { bid: 103, ask: 104 })];
  const signal = project(rows).signals.find(s => s.long.exchange === 'okx' && s.short.exchange === 'lighter');
  assert.equal(signal.referenceBuyPrice, 100.2); assert.equal(signal.referenceSellPrice, 102.794);
  assert.ok(signal.grossSpreadPercent < 3);
});
test('FX timestamps and values bind signal identity; generation time cannot extend expiry', () => {
  const rows = [quote('binance'), quote('kraken')], first = project(rows).signals[0];
  assert.equal(project(rows, fx(), NOW + 100).signals[0].id, first.id);
  const rates = fx(); rates.rates.USD.bid = 1.009;
  assert.notEqual(project(rows, rates).signals[0].id, first.id);
  const almostOld = fx(NOW - 179000), expiring = project(rows, almostOld).signals[0];
  assert.equal(expiring.expiresAt, NOW + 1000);
});
test('missing, stale or future FX disables only dependent pairs; stale books stay raw', () => {
  const rows = [quote('binance'), quote('bybit', { symbol: 'BTCUSDT', quoteCurrency: 'USDT', bid: 103, ask: 104 }), quote('kraken'), quote('hyperliquid')];
  for (const rates of [null, fx(NOW - 180001), fx(NOW + 1001)]) {
    const result = project(rows, rates); assert.equal(result.quotes.length, 4); assert.ok(result.signals.length > 0);
    assert.ok(result.signals.every(s => [s.long, s.short].every(q => ['binance', 'bybit'].includes(q.exchange))));
  }
  const result = project([quote('binance', { bidAskAt: NOW - 10001 }), quote('kraken')]);
  assert.equal(result.quotes.length, 2); assert.equal(result.signals.length, 0);
});
test('Deribit, unknown class, missing directory, multiplier and lifecycle evidence are rejected', () => {
  for (const extra of [{ exchange: 'deribit' }, { crossexVerified: false }, { assetClass: 'equity' }, { comparable: false }, { multiplier: 1000 }, { delisting: true }, { delistingAt: NOW + 10000 }]) {
    const result = project([quote('binance'), quote('gate', extra)]); assert.equal(result.signals.length, 0);
  }
  assert.equal(project([quote('gate'), quote('okx')]).quotes.length, 0, 'independent COIN evidence is required');
  assert.equal(project(undefined, fx(), NOW, { storageError: 'disk failed' }).signals.length, 0);
});
