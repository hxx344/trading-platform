// 原油、海力士详情的关联交易（web/src/monitor-related.ts，A-5）：照工作台 related-pairs.ts、hub-positions.ts（提交 7745181）
// 的规则核对持仓挑选、同所配对与本轮 cycle 合计。全部是纯函数，不读网络。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_POSITION_ITEMS, POSITIONS_STALE_AFTER_MS, matchBase, positionItems, relatedSpreadPairs, RELATED_SYMBOLS, type RelatedItem } from '../web/src/monitor-related.ts';
import type { HubPositions, Position, PositionCycle, PositionsScope } from '../src/asset/positions-types.ts';

const at = '2026-10-01T08:00:00.000Z', now = Date.parse(at) + 10_000;
const position = (symbol: string, side: Position['side'], entryPrice: string, overrides: Partial<Position> = {}): Position => ({
  id: `${symbol}:${side}`, symbol, instrumentId: symbol, side, quantity: '2', quantityUnit: symbol.replace(/USDT$/, ''), contractSize: null,
  entryPrice, markPrice: entryPrice, notional: null, unrealizedPnl: '1.5', leverage: null, liquidationPrice: null, priceCurrency: 'USDT',
  notionalCurrency: 'USDT', pnlCurrency: 'USDT', marginMode: null, sourceUpdatedAt: at, ...overrides,
});
const scope = (positions: Position[], overrides: Partial<PositionsScope> = {}): PositionsScope => ({ id: 'um', label: 'U 本位合约', status: 'live', refreshing: false, fetchedAt: at, error: null, positions, ...overrides });
const reply = (...exchanges: [string, PositionsScope][]): HubPositions => ({
  schemaVersion: 1, generatedAt: at,
  exchanges: exchanges.map(([id, s]) => ({ id, name: id === 'okx' ? 'OKX' : id[0]!.toUpperCase() + id.slice(1), accounts: [{ id: 'main', name: '主账户', configured: true, revision: 'r1', scopes: [s] }] })),
});
const cycle = (overrides: Partial<PositionCycle> = {}): PositionCycle => ({
  status: 'complete', since: at, closedQuantity: '1', closePrice: '60', realizedPnl: '3', fees: '-0.5', funding: '0.25', net: '2.75', currency: 'USDT', note: null, updatedAt: at, ...overrides,
});

test('bases match exchange suffixes and prefer the longest base', () => {
  assert.equal(matchBase('CLUSDT', RELATED_SYMBOLS.oil), 'CL');
  assert.equal(matchBase('BZ-USDT-SWAP', RELATED_SYMBOLS.oil), 'BZ');
  assert.equal(matchBase('CLOVER', RELATED_SYMBOLS.oil), null, 'a longer name sharing the prefix is another asset');
  assert.equal(matchBase('SKHYNIXUSDT', RELATED_SYMBOLS.hynix), 'SKHYNIX');
  assert.equal(matchBase('SKHX', RELATED_SYMBOLS.hynix), 'SKHX');
});

test('only the market\'s legs are picked; unread or stale scopes mark the list incomplete', () => {
  const data = reply(['binance', scope([position('CLUSDT', 'long', '60'), position('BZUSDT', 'short', '64'), position('BTCUSDT', 'long', '1')])]);
  const picked = positionItems(data, RELATED_SYMBOLS.oil, now);
  assert.deepEqual(picked.items.map(item => item.base), ['CL', 'BZ']);
  assert.equal(picked.incomplete, false); assert.equal(picked.items[0]!.source, '资产账本'); assert.equal(picked.items[0]!.exchangeId, 'binance');
  assert.equal(positionItems(reply(['bybit', scope([], { status: 'loading', fetchedAt: null })]), RELATED_SYMBOLS.oil, now).incomplete, true);
  const late = positionItems(data, RELATED_SYMBOLS.oil, Date.parse(at) + POSITIONS_STALE_AFTER_MS + 1);
  assert.ok(late.items.every(item => item.stale), 'positions older than 90 s are shown as old values');
  const many = reply(['binance', scope(Array.from({ length: MAX_POSITION_ITEMS + 1 }, (_, i) => position('CLUSDT', 'long', String(60 + i))))]);
  const capped = positionItems(many, RELATED_SYMBOLS.oil, now);
  assert.equal(capped.items.length, MAX_POSITION_ITEMS); assert.equal(capped.truncated, true); assert.equal(capped.incomplete, true);
});

const items = (data: HubPositions, market: 'oil' | 'hynix' = 'oil'): RelatedItem[] => positionItems(data, RELATED_SYMBOLS[market], now).items;

test('one opposite pair per venue gets the opening, current and closing spread with cycle totals', () => {
  const data = reply(['binance', scope([position('CLUSDT', 'long', '60', { cycle: cycle({ closePrice: '61' }) }), position('BZUSDT', 'short', '64', { cycle: cycle({ closePrice: '64.5' }) })])]);
  const [pair] = relatedSpreadPairs('oil', items(data), { binance: { value: 3.5, stale: true } });
  assert.ok(pair && pair.status === 'paired');
  assert.equal(pair.opening, 4, 'oil spread is Brent minus WTI per barrel');
  assert.equal(pair.current, 3.5); assert.equal(pair.currentStale, true); assert.equal(pair.change, -0.5);
  assert.equal(pair.narrowingFavors, true, 'short Brent profits when the spread narrows');
  assert.equal(pair.closing, 3.5);
  assert.equal(pair.totals.unrealized, 3); assert.equal(pair.totals.realizedStatus, 'complete');
  assert.equal(pair.totals.net, 5.5); assert.equal(pair.totals.total, 8.5);
  const [unknown] = relatedSpreadPairs('oil', items(data), undefined);
  assert.ok(unknown && unknown.status === 'paired'); assert.equal(unknown.current, null, 'a venue without a live quote has no current spread');
});

test('hynix pairs use the ADR premium over the ordinary share divided by ten', () => {
  const data = reply(['binance', scope([position('SKHYUSDT', 'short', '55'), position('SKHYNIXUSDT', 'long', '500')])]);
  const [pair] = relatedSpreadPairs('hynix', items(data, 'hynix'), { binance: { value: 9, stale: false } });
  assert.ok(pair && pair.status === 'paired');
  assert.ok(Math.abs(pair.opening! - 10) < 1e-9); assert.ok(Math.abs(pair.change! + 1) < 1e-9);
  assert.equal(pair.narrowingFavors, true, 'short ADR profits when the premium narrows');
  assert.equal(pair.totals.realizedStatus, 'unavailable', 'no cycle means no realized half');
  assert.equal(pair.totals.total, null);
});

test('missing legs, same sides, duplicates and incomplete lists never pair', () => {
  const reason = (positions: Position[]) => { const [pair] = relatedSpreadPairs('oil', items(reply(['binance', scope(positions)])), undefined); return pair?.status === 'unpaired' ? pair.reason : pair?.status; };
  assert.equal(reason([position('CLUSDT', 'long', '60')]), 'missing-leg');
  assert.equal(reason([position('CLUSDT', 'long', '60'), position('BZUSDT', 'long', '64')]), 'same-side');
  assert.equal(reason([position('CLUSDT', 'long', '60'), position('CLUSDT', 'long', '61'), position('BZUSDT', 'short', '64')]), 'multiple');
  const split = reply(['binance', scope([position('CLUSDT', 'long', '60')])], ['okx', scope([position('BZ-USDT-SWAP', 'short', '64')])]);
  assert.deepEqual(relatedSpreadPairs('oil', items(split), undefined).map(pair => pair.status), ['unpaired', 'unpaired'], 'legs on different venues are not a pair');
  assert.deepEqual(relatedSpreadPairs('oil', items(reply(['binance', scope([position('CLUSDT', 'long', '60'), position('BZUSDT', 'short', '64')])])), undefined, true), []);
  const loading = reply(['binance', scope([position('CLUSDT', 'long', '60', { cycle: cycle({ status: 'loading' }) }), position('BZUSDT', 'short', '64', { cycle: cycle() })])]);
  const [pending] = relatedSpreadPairs('oil', items(loading), undefined);
  assert.ok(pending && pending.status === 'paired'); assert.equal(pending.totals.realizedStatus, 'loading'); assert.equal(pending.closing, null);
});
