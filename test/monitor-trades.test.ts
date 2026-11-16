// 原油、海力士详情的成交标记（web/src/monitor-trades.ts，A-5）：照工作台 modules/monitor/tests/oil-trade-markers.test.mjs
// 与 hub-fills.test.mjs（提交 7745181）的对应用例，加本服务成交响应摊平（fillItems）的用例。全部是纯函数，不读网络。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FILLS_STALE_AFTER_MS, MAX_FILL_ITEMS, emptyFillsView, fillItems, fillsStatusText, groupTradeEvents, spreadTradeMarkers, summarizeTradeEvents,
  tradeDetailLines, tradeMarkers, type FillItem, type FillsView, type TradeEvent,
} from '../web/src/monitor-trades.ts';
import type { Point } from '../web/src/monitor-history.ts';
import type { Fill, HubFills } from '../src/asset/fills-types.ts';

const fill = (overrides: Partial<FillItem> = {}): FillItem => ({
  key: 'asset|binance|account|um|1', sourceId: 'asset', source: '资产账本', exchangeId: 'binance', exchange: 'Binance',
  accountId: 'account', account: '主账户', scope: 'um', symbol: 'CLUSDT', base: 'CL',
  time: '2026-10-01T08:00:00.000Z', side: 'buy', positionSide: 'net',
  quantity: '2', quantityUnit: 'CL', price: '100', priceCurrency: 'USDT',
  fee: '-0.10', feeCurrency: 'USDT', realizedPnl: '0', positionBefore: '0', positionAfter: '2', stale: false,
  ...overrides,
});
const view = (overrides: Partial<FillsView> = {}): FillsView => ({
  status: 'ok', generatedAt: '2026-10-01T08:01:00.000Z', lookbackStart: '2026-07-08T08:01:00.000Z', pending: false, incomplete: false, truncated: false, retained: false,
  coverage: [{ sourceId: 'asset', source: '资产账本', exchangeId: 'binance', exchange: 'Binance', account: '主账户', scope: 'um',
    status: 'live', fetchedAt: '2026-10-01T08:00:30.000Z', coverageStart: '2026-07-08T08:01:00.000Z', coverageEnd: '2026-10-01T08:00:00.000Z', error: null }],
  items: [fill()], ...overrides,
});

const start = Date.parse(fill().time), bar = 900_000;
const point = (i: number, premium = 2 + i, spread = 1.5 + i): Point => ({ time: start + i * bar, adr: 80 + spread, ordinary: 80, equivalent: 80, premium, spread });
const rows = [0, 1, 2, 3].map(i => point(i));
// The workbench test's OIL_SPREAD_CHART options without the metric (the percent value), as in oil-trade-markers.test.mjs.
const oilMarkers = (events: TradeEvent[], points = rows) => spreadTradeMarkers(events, points, { intervalMs: bar, rightPerUnit: 1, tradedBasis: '成交价差', chartBasis: '图表价差' });
const eventAt = (time: number, spread: number | null = null): TradeEvent => ({ ...groupTradeEvents([fill({ key: String(time), time: new Date(time).toISOString() })], 'oil')[0]!, spread });

test('oil markers use the 15-minute bar containing the fill and never bridge a gap', () => {
  const markers = oilMarkers([eventAt(start - 1, 1), eventAt(start, 12), eventAt(start + 120_000), eventAt(start + 3 * bar), eventAt(start + 3 * bar + 1, 1)]);
  assert.equal(markers.length, 4, 'fills before the first bar are outside the chart');
  assert.equal(markers[0]!.value, 12); assert.equal(markers[0]!.basis, '成交价差');
  assert.equal(markers[1]!.event.time, start + 120_000); assert.equal(markers[1]!.value, 2); assert.equal(markers[1]!.basis, '图表价差');
  assert.equal(markers[2]!.value, 5); assert.equal(markers[3]!.value, 1); assert.equal(markers[3]!.chartSpread, 5);
  const [gap] = oilMarkers([eventAt(start + 2 * bar)], [rows[0]!, point(4)]);
  assert.equal(gap!.value, null, 'a historical gap is not bridged with a remote candle');
  assert.equal(gap!.usd, null);
  assert.deepEqual(oilMarkers([eventAt(start)], []), []);
});

test('absolute oil markers use paired fill prices per barrel and fall back to the chart bar', () => {
  const paired = groupTradeEvents([fill({ price: '66.2' }), fill({ key: 'bz', symbol: 'BZUSDT', base: 'BZ', quantityUnit: 'BZ', price: '70.1', side: 'sell', positionAfter: '-2' })], 'oil');
  const [traded] = oilMarkers(paired);
  assert.equal(traded!.usd!.toFixed(3), '3.900'); assert.equal(traded!.basis, '成交价差'); assert.equal(traded!.chartSpread, 2);
  assert.equal(traded!.value, paired[0]!.spread, 'the percent value comes from the traded spread');
  const [single] = oilMarkers([eventAt(start + bar, 12)]);
  assert.equal(single!.usd, 2.5, 'a single-leg event falls back to the chart bar');
  // The page's own oil options (oil-chart-config.ts): the absolute spread of the bar, in USDT per barrel.
  const [page] = tradeMarkers('oil', [eventAt(start + bar)], rows);
  assert.equal(page!.unit, 'absolute'); assert.equal(page!.chartSpread, 2.5); assert.equal(page!.value, 2.5);
});

test('hynix markers use the hourly bar and the ADR premium', () => {
  const hour = 3_600_000;
  const points = [0, 1].map(i => ({ ...point(0), time: start + i * hour, premium: 4 + i }));
  const event = groupTradeEvents([fill({ symbol: 'SKHYUSDT', base: 'SKHY', quantityUnit: 'SKHY', time: new Date(start + hour + 60_000).toISOString() })], 'hynix');
  const [marker] = tradeMarkers('hynix', event, points);
  assert.equal(marker!.unit, 'percent'); assert.equal(marker!.chartSpread, 5); assert.equal(marker!.basis, '图表溢价率');
});

test('trade details keep user-controlled names as text and unknown cash flows stay explicit', () => {
  const malicious = '<img src=x onerror=alert(1)>';
  const event = groupTradeEvents([fill({ account: malicious, realizedPnl: null, fee: null, feeCurrency: null })], 'oil')[0]!;
  const lines = tradeDetailLines(oilMarkers([event])[0]!, String);
  assert.ok(lines.some(line => line.includes(malicious)));
  assert.ok(lines.some(line => line.includes('已实现盈亏 未知')));
  assert.ok(lines.some(line => line.includes('图表价差')));
  assert.ok(lines.some(line => line.includes('开仓 2 CL')));
});

test('same-day consecutive entries are summarized with a weighted price', () => {
  const entries = groupTradeEvents([
    fill({ key: 'a', price: '100', quantity: '2', positionBefore: '0', positionAfter: '2' }),
    fill({ key: 'b', time: '2026-10-01T09:00:00.000Z', price: '103', quantity: '1', positionBefore: '2', positionAfter: '3' }),
  ], 'oil');
  assert.equal(entries.length, 2, 'fills more than 10 minutes apart are separate events');
  assert.ok(entries.every(event => event.type === 'entry'));
  const [summary] = summarizeTradeEvents(entries, 'oil');
  assert.equal(summary!.fillCount, 2); assert.equal(summary!.eventKeys.length, 2);
  assert.equal(summary!.groups[0]!.legs[0]!.price, '101');
});

test('coverage states keep the actual source time and distinguish stale and partial data', () => {
  assert.match(fillsStatusText(emptyFillsView('missing'), String), /本服务没有配置资产账本/);
  const failed = view({ retained: true, incomplete: true, truncated: true, coverage: [{ ...view().coverage[0]!, status: 'stale' }] });
  const result = fillsStatusText(failed, String);
  for (const label of ['部分账户失败', '保留上次成功数据', '已截断', '最近 85 天', '仅支持 Binance、Bybit、OKX', view().coverage[0]!.fetchedAt!]) assert.ok(result.includes(label), label);
  assert.equal(result.includes(view().generatedAt!), false, 'response generation never refreshes stale source time');
  assert.match(fillsStatusText(view({ pending: true }), String), /^已显示上次成交，后台更新中…/);
  assert.match(fillsStatusText(view({ pending: true, items: [], coverage: [{ ...view().coverage[0]!, status: 'loading', fetchedAt: null }] }), String), /^读取中…/);
});

const serverFill = (id: string, overrides: Partial<Fill> = {}): Fill => ({
  id, symbol: 'CLUSDT', base: 'CL', time: '2026-10-01T08:00:00.000Z', side: 'buy', positionSide: 'net', quantity: '1', quantityUnit: 'CL',
  price: '60', priceCurrency: 'USDT', fee: null, feeCurrency: null, realizedPnl: null, positionBefore: '0', positionAfter: '1', ...overrides,
});
const reply = (scope: Partial<HubFills['exchanges'][number]['accounts'][number]['scopes'][number]> = {}): HubFills => ({
  schemaVersion: 1, generatedAt: '2026-10-01T08:01:00.000Z', lookbackStart: '2026-07-08T08:01:00.000Z',
  exchanges: [{ id: 'binance', name: 'Binance', accounts: [{ id: 'main', name: '主账户', configured: true, revision: 'r1', scopes: [{
    id: 'um', label: 'U 本位合约', status: 'live', refreshing: false, fetchedAt: '2026-10-01T08:00:30.000Z', coverageStart: null, coverageEnd: null, truncated: false, error: null,
    fills: [serverFill('1'), serverFill('2', { symbol: 'SKHYUSDT', base: 'SKHY', quantityUnit: 'SKHY' }), serverFill('3', { time: '2026-10-01T08:00:10.000Z', positionBefore: null })], ...scope,
  }] }] }],
});

test('the asset ledger reply is flattened per market, newest first, with stale and partial coverage marked', () => {
  const now = Date.parse('2026-10-01T08:01:00.000Z');
  const oil = fillItems(reply(), now, 'oil');
  assert.deepEqual(oil.items.map(item => item.key), ['asset|binance|main|um|3', 'asset|binance|main|um|1'], 'only the market\'s bases, newest first');
  assert.equal(oil.items[0]!.source, '资产账本'); assert.equal(oil.items[0]!.stale, false);
  assert.equal(oil.incomplete, true, 'a fill without position replay leaves the coverage incomplete');
  assert.equal(fillItems(reply(), now, 'hynix').items.length, 1);
  const late = fillItems(reply(), Date.parse('2026-10-01T08:00:30.000Z') + FILLS_STALE_AFTER_MS + 1, 'oil');
  assert.equal(late.coverage[0]!.status, 'stale'); assert.ok(late.items.every(item => item.stale));
  const loading = fillItems(reply({ status: 'loading', fetchedAt: null, fills: [] }), now, 'oil');
  assert.equal(loading.pending, true); assert.equal(loading.items.length, 0);
  const many = fillItems(reply({ fills: Array.from({ length: MAX_FILL_ITEMS + 1 }, (_, i) => serverFill(String(i))) }), now, 'oil');
  assert.equal(many.items.length, MAX_FILL_ITEMS); assert.equal(many.truncated, true); assert.equal(many.incomplete, true);
});
