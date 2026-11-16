// 原油、海力士详情的成交标记（A-5）：资产账本成交（/api/asset/fills）分组成入场 / 出场 / 调仓 / 成交事件、放到价格图上、
// 生成明细文字。逻辑复制自工作台（提交 7745181）并改写成 TypeScript，规则不改：
// - modules/monitor/modules/oil/trade-decimal.mjs：十进制加减乘除；
// - modules/monitor/modules/oil/trades.mjs：TRADE_PAIRS、TRADE_TYPES、classifyFill、groupTradeEvents；
// - modules/monitor/lib/trade-summary.ts：summarizeTradeEvents（同日连续分批的入场 / 出场汇总）；
// - modules/monitor/lib/hynix-trades.ts 与 lib/oil-chart-config.ts：spreadTradeMarkers 与两个市场的参数；
// - modules/monitor/modules/oil/trade-markers.mjs：tradeDetailLines、fillsStatusText；
// - src/hub-fills.ts（工作台宿主）的 fillItems：把成交响应摊平成逐笔列表与覆盖范围。
// 与工作台的差异：只有本服务一个来源（工作台汇总多个 Asset 项目），所以来源固定为「资产账本」、不逐字段校验来源格式
// （数据来自本服务自己的接口）；Anthropic 的执行任务归属（execution / attribution / orderId）不做（A-5 不做 anthropic）。
import { decimalDifference, oilSpread } from '../../src/vendor/oil-market.mjs';
import type { FillMarket, HubFills } from '../../src/asset/fills-types.ts';
import type { PositionsStatus } from '../../src/asset/positions-types.ts';
import type { Point } from './monitor-history.ts';

// ---- trade-decimal.mjs ----
type Decimal = { n: bigint; scale: number };
export function decimal(value: string): Decimal {
  const [whole, fraction = ''] = value.split('.');
  return { n: BigInt(whole! + fraction), scale: fraction.length };
}
export function decimalText({ n, scale }: Decimal) {
  const sign = n < 0n ? '-' : '', digits = (n < 0n ? -n : n).toString().padStart(scale + 1, '0');
  const text = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, '') : digits;
  return sign + text;
}
function add(a: Decimal, b: Decimal): Decimal {
  const scale = Math.max(a.scale, b.scale);
  return { n: a.n * 10n ** BigInt(scale - a.scale) + b.n * 10n ** BigInt(scale - b.scale), scale };
}
const negate = (a: Decimal): Decimal => ({ ...a, n: -a.n });
const absolute = (a: Decimal): Decimal => ({ ...a, n: a.n < 0n ? -a.n : a.n });
const compare = (a: Decimal, b: Decimal) => { const n = add(a, negate(b)).n; return n < 0n ? -1 : n > 0n ? 1 : 0; };
const multiply = (a: Decimal, b: Decimal): Decimal => ({ n: a.n * b.n, scale: a.scale + b.scale });
/** Bound recurring weighted prices without truncating the source's fractional precision. */
function divide(a: Decimal, b: Decimal, scale = Math.max(24, a.scale, b.scale)): Decimal | null {
  if (b.n === 0n) return null;
  const numerator = a.n * 10n ** BigInt(b.scale + scale), denominator = b.n * 10n ** BigInt(a.scale);
  return { n: numerator / denominator, scale };
}

// ---- hub-fills.ts fillItems ----
export const FILLS_STALE_AFTER_MS = 15 * 60_000;
export const MAX_FILL_ITEMS = 2000;
export const FILLS_SOURCE = '资产账本';
export type FillItem = {
  key: string; sourceId: string; source: string; exchangeId: string; exchange: string; accountId: string; account: string; scope: string;
  symbol: string; base: string; time: string; side: 'buy' | 'sell'; positionSide: 'long' | 'short' | 'net';
  quantity: string; quantityUnit: string; price: string; priceCurrency: string | null;
  fee: string | null; feeCurrency: string | null; realizedPnl: string | null; positionBefore: string | null; positionAfter: string | null; stale: boolean;
};
export type FillCoverage = {
  sourceId: string; source: string; exchangeId: string; exchange: string; account: string; scope: string; status: PositionsStatus;
  fetchedAt: string | null; coverageStart: string | null; coverageEnd: string | null; error: string | null;
};
/** `missing`: the service has no asset ledger (404); `unavailable`: the read failed and nothing was kept. */
export type FillsView = {
  status: 'ok' | 'loading' | 'unavailable' | 'missing';
  generatedAt: string | null; lookbackStart: string | null; pending: boolean; incomplete: boolean; truncated: boolean;
  coverage: FillCoverage[]; items: FillItem[]; retained: boolean;
};
export const emptyFillsView = (status: FillsView['status']): FillsView => ({ status, generatedAt: null, lookbackStart: null, pending: false, incomplete: status !== 'loading', truncated: false, coverage: [], items: [], retained: false });

export function fillItems(data: HubFills, now: number, market: FillMarket): Omit<FillsView, 'status' | 'retained'> {
  const items: FillItem[] = [], coverage: FillCoverage[] = [];
  const bases: readonly string[] = market === 'oil' ? ['CL', 'BZ'] : ['SKHY', 'SKHYNIX'];
  const sourceId = 'asset', source = FILLS_SOURCE;
  let pending = false, incomplete = false, truncated = false;
  for (const exchange of data.exchanges) for (const account of exchange.accounts) for (const scope of account.scopes) {
    const old = scope.fetchedAt === null || now - Date.parse(scope.fetchedAt) > FILLS_STALE_AFTER_MS;
    const stale = scope.status === 'stale' || scope.status === 'error' || old;
    pending ||= scope.status === 'loading' || scope.refreshing;
    truncated ||= scope.truncated;
    incomplete ||= scope.truncated || scope.status === 'stale' || scope.status === 'error' || scope.status === 'live' && old;
    const status = scope.status === 'live' && stale ? 'stale' : scope.status;
    const error = status === 'unsupported' ? '数据源暂不支持此产品范围的成交读取'
      : status === 'error' ? '资产账本读取此范围失败，请在资产页检查连接与权限'
        : status === 'stale' ? '成交数据已过期，等待资产账本更新' : null;
    coverage.push({ sourceId, source, exchangeId: exchange.id, exchange: exchange.name, account: account.name, scope: scope.id, status, fetchedAt: scope.fetchedAt, coverageStart: scope.coverageStart, coverageEnd: scope.coverageEnd, error });
    for (const fill of scope.fills) {
      if (!bases.includes(fill.base)) continue;
      incomplete ||= fill.positionBefore === null || fill.positionAfter === null;
      items.push({ key: [sourceId, exchange.id, account.id, scope.id, fill.id].map(encodeURIComponent).join('|'), sourceId, source, exchangeId: exchange.id, exchange: exchange.name, accountId: account.id, account: account.name, scope: scope.id,
        symbol: fill.symbol, base: fill.base, time: fill.time, side: fill.side, positionSide: fill.positionSide, quantity: fill.quantity, quantityUnit: fill.quantityUnit, price: fill.price, priceCurrency: fill.priceCurrency,
        fee: fill.fee, feeCurrency: fill.feeCurrency, realizedPnl: fill.realizedPnl, positionBefore: fill.positionBefore, positionAfter: fill.positionAfter, stale });
    }
  }
  items.sort((a, b) => Date.parse(b.time) - Date.parse(a.time) || a.key.localeCompare(b.key));
  if (items.length > MAX_FILL_ITEMS) { truncated = true; incomplete = true; items.length = MAX_FILL_ITEMS; }
  return { generatedAt: data.generatedAt, lookbackStart: data.lookbackStart, pending, incomplete, truncated, coverage, items };
}

// ---- trades.mjs ----
export const TRADE_GAP_MS = 10 * 60_000;
export const tradeDate = (time: string) => new Date(Date.parse(time) + 8 * 3_600_000).toISOString().slice(0, 10);
type TradePair = { left: string; right: string; spread: (left: number, right: number) => number | null; priceUnit: string; short: string; long: string };
/** left/right are the paired bases; spread is the market's chart metric from fill prices (oil: USDT/桶, Hynix: percent). */
export const TRADE_PAIRS: Record<FillMarket, TradePair> = {
  oil: { left: 'BZ', right: 'CL', spread: oilSpread, priceUnit: '/桶', short: '做空价差（空布伦特 / 多 WTI）', long: '做多价差（多布伦特 / 空 WTI）' },
  // One ordinary share equals ten ADRs, matching the chart's ADR premium.
  hynix: { left: 'SKHY', right: 'SKHYNIX', priceUnit: '',
    spread: (adr, ordinary) => adr > 0 && ordinary > 0 && Number.isFinite(adr / ordinary) ? (adr / (ordinary / 10) - 1) * 100 : null,
    short: '做空溢价（空 ADR / 多正股）', long: '做多溢价（多 ADR / 空正股）' },
};
export const TRADE_TYPES = { entry: { label: '入场', symbol: '▲' }, exit: { label: '出场', symbol: '▼' }, rebalance: { label: '调仓', symbol: '◆' }, trade: { label: '成交', symbol: '●' } } as const;
export type TradeType = keyof typeof TRADE_TYPES;
type Effect = { effect: 'open' | 'close' | 'unknown'; quantity: string };
type Cash = { currency: string; amount: string | null; known: string | null; unknown: boolean };
const zero = () => decimal('0');
export const tradeVenueKey = (item: Pick<FillItem, 'sourceId' | 'exchangeId' | 'accountId'>) => JSON.stringify([item.sourceId, item.exchangeId, item.accountId]);
/** Split cross-zero fills without allocating the fill's fees or realized PnL twice. */
export function classifyFill(fill: FillItem): Effect[] {
  const unknown = (): Effect[] => [{ effect: 'unknown', quantity: fill.quantity }];
  if (fill.positionBefore === null || fill.positionAfter === null) return unknown();
  const before = decimal(fill.positionBefore), after = decimal(fill.positionAfter), quantity = decimal(fill.quantity);
  const delta = fill.side === 'buy' ? quantity : negate(quantity);
  if (compare(add(before, delta), after) !== 0) return unknown();
  if (fill.positionSide === 'long' && (before.n < 0n || after.n < 0n) || fill.positionSide === 'short' && (before.n > 0n || after.n > 0n)) return unknown();
  if (before.n * after.n < 0n) return [
    { effect: 'close', quantity: decimalText(absolute(before)) },
    { effect: 'open', quantity: decimalText(absolute(after)) },
  ];
  if (before.n === 0n || compare(absolute(after), absolute(before)) > 0) return [{ effect: 'open', quantity: fill.quantity }];
  if (after.n === 0n || compare(absolute(after), absolute(before)) < 0) return [{ effect: 'close', quantity: fill.quantity }];
  return unknown();
}
function cashTotals(fills: FillItem[], field: 'fee' | 'realizedPnl', currencyField: 'feeCurrency' | 'priceCurrency'): Cash[] {
  const currencies = new Map<string, { known: Decimal; knownCount: number; unknown: boolean }>();
  for (const fill of fills) {
    const currency = fill[currencyField] ?? '未知币种';
    const item = currencies.get(currency) ?? { known: zero(), knownCount: 0, unknown: false };
    const value = fill[field];
    if (value === null || fill[currencyField] === null) item.unknown = true;
    else { item.known = add(item.known, decimal(value)); item.knownCount++; }
    currencies.set(currency, item);
  }
  return [...currencies].map(([currency, item]) => ({ currency, amount: item.unknown ? null : decimalText(item.known), known: item.knownCount ? decimalText(item.known) : null, unknown: item.unknown }));
}
function summarizeVenue(fills: FillItem[], pair: TradePair) {
  const first = fills[0]!, groups = new Map<string, { base: string; quantityUnit: string; currency: string | null; quantity: Decimal; notional: Decimal; sides: Set<string>; scopes: Set<string> }>();
  for (const fill of fills) {
    const key = JSON.stringify([fill.base, fill.quantityUnit, fill.priceCurrency]);
    const leg = groups.get(key) ?? { base: fill.base, quantityUnit: fill.quantityUnit, currency: fill.priceCurrency, quantity: zero(), notional: zero(), sides: new Set(), scopes: new Set() };
    leg.quantity = add(leg.quantity, decimal(fill.quantity));
    leg.notional = add(leg.notional, multiply(decimal(fill.quantity), decimal(fill.price)));
    leg.sides.add(fill.side); leg.scopes.add(fill.scope);
    groups.set(key, leg);
  }
  const legs = [...groups.values()].map(leg => ({
    base: leg.base, quantityUnit: leg.quantityUnit, currency: leg.currency, quantity: decimalText(leg.quantity),
    price: decimalText(divide(leg.notional, leg.quantity)!), sides: [...leg.sides], scopes: [...leg.scopes],
  }));
  const left = legs.filter(leg => leg.base === pair.left), right = legs.filter(leg => leg.base === pair.right);
  const paired = left.length === 1 && right.length === 1 && left[0]!.currency === right[0]!.currency;
  const side = (list: typeof legs) => { const sides = new Set(list.flatMap(leg => leg.sides)); return sides.size === 1 ? [...sides][0] : null; };
  const leftSide = side(left), rightSide = side(right);
  const direction = !left.length || !right.length ? '单腿' : leftSide === 'sell' && rightSide === 'buy' ? pair.short
    : leftSide === 'buy' && rightSide === 'sell' ? pair.long : '双向或同向成交';
  return {
    key: tradeVenueKey(first), sourceId: first.sourceId, source: first.source, exchangeId: first.exchangeId, exchange: first.exchange, accountId: first.accountId, account: first.account,
    legs, direction, spread: paired ? pair.spread(Number(left[0]!.price), Number(right[0]!.price)) : null,
    prices: paired ? { left: Number(left[0]!.price), right: Number(right[0]!.price) } : null,
    currency: paired ? left[0]!.currency : null,
    fees: cashTotals(fills, 'fee', 'feeCurrency'), realizedPnl: cashTotals(fills, 'realizedPnl', 'priceCurrency'),
  };
}
type Venue = ReturnType<typeof summarizeVenue>;
function effectType(effects: Effect[]): TradeType {
  const kinds = new Set(effects.map(part => part.effect));
  return kinds.has('unknown') ? 'trade' : kinds.size > 1 ? 'rebalance' : kinds.has('open') ? 'entry' : 'exit';
}
export type TradeEvent = {
  key: string; time: number; end: number; type: TradeType; fills: FillItem[]; effects: (Effect & { key: string })[]; venues: Venue[];
  spread: number | null; spreadVenue: Venue | null; fees: Cash[]; realizedPnl: Cash[]; stale: boolean;
};
function summarizeEvent(fills: FillItem[], pair: TradePair): TradeEvent {
  const effects = fills.flatMap(fill => classifyFill(fill).map(part => ({ ...part, key: fill.key })));
  const type = effectType(effects);
  const groups = new Map<string, FillItem[]>();
  for (const fill of fills) {
    const key = tradeVenueKey(fill);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(fill);
  }
  const venues = [...groups.values()].map(group => summarizeVenue(group, pair));
  const preferred = venues.find(venue => venue.exchangeId === 'binance' && venue.spread !== null) ?? venues.find(venue => venue.spread !== null);
  return {
    key: fills[0]!.key, time: Date.parse(fills[0]!.time), end: Date.parse(fills.at(-1)!.time), type,
    fills, effects, venues, spread: preferred?.spread ?? null, spreadVenue: preferred ?? null,
    fees: cashTotals(fills, 'fee', 'feeCurrency'), realizedPnl: cashTotals(fills, 'realizedPnl', 'priceCurrency'),
    stale: fills.some(fill => fill.stale),
  };
}
/** Cluster same-effect timestamps within a Beijing date; never sum quantities across venues. */
export function groupTradeEvents(items: readonly FillItem[], market: FillMarket): TradeEvent[] {
  const pair = TRADE_PAIRS[market];
  const ordered = [...items].sort((a, b) => Date.parse(a.time) - Date.parse(b.time) || a.key.localeCompare(b.key));
  const timestamps: FillItem[][] = [];
  for (const fill of ordered) {
    const previous = timestamps.at(-1);
    if (!previous || Date.parse(fill.time) !== Date.parse(previous[0]!.time)) timestamps.push([fill]);
    else previous.push(fill);
  }
  const groups: { type: TradeType; fills: FillItem[] }[] = [];
  for (const fills of timestamps) {
    const previous = groups.at(-1), type = effectType(fills.flatMap(classifyFill)), time = fills[0]!.time;
    if (!previous || previous.type !== type || tradeDate(time) !== tradeDate(previous.fills.at(-1)!.time) || Date.parse(time) - Date.parse(previous.fills.at(-1)!.time) > TRADE_GAP_MS) groups.push({ type, fills: [...fills] });
    else previous.fills.push(...fills);
  }
  return groups.map(group => summarizeEvent(group.fills, pair));
}

// ---- trade-summary.ts ----
type Leg = { key: string; symbol: string; base: string; side: string; positionSide: string; quantityUnit: string; quantity: Decimal; notional: Decimal };
type Group = { key: string; source: string; exchange: string; account: string; scope: string; currency: string | null; direction: string; stale: boolean; legs: Map<string, Leg> };
const positionKey = (fill: FillItem) => JSON.stringify([tradeVenueKey(fill), fill.scope, fill.symbol, fill.base, fill.positionSide, fill.quantityUnit, fill.priceCurrency]);
/** A consecutive same-day position segment, not an inferred order or strategy execution ID. */
export function summarizeTradeEvents(events: TradeEvent[], market: FillMarket) {
  const pair = TRADE_PAIRS[market];
  const directionFor = (fill: FillItem, type: string) => {
    const short = (fill.base === pair.left ? fill.side === 'sell' : fill.side === 'buy') === (type === 'entry');
    return short ? pair.short : pair.long;
  };
  const batches: { type: 'entry' | 'exit'; events: TradeEvent[]; date: string; identity: string; positions: Map<string, string | null>; continuous: boolean }[] = [];
  let current: (typeof batches)[number] | undefined;
  for (const event of [...events].sort((a, b) => a.time - b.time || a.key.localeCompare(b.key))) {
    if (event.type !== 'entry' && event.type !== 'exit') { current = undefined; continue; }
    const fills = event.fills, date = tradeDate(fills[0]!.time);
    const identity = JSON.stringify([...new Set(fills.map(fill => JSON.stringify([tradeVenueKey(fill), fill.scope, fill.priceCurrency, directionFor(fill, event.type)])))].sort());
    const firstPositions = new Map<string, string | null>(), lastPositions = new Map<string, string | null>();
    const positions = new Map<string, FillItem[]>();
    for (const fill of fills) {
      const key = positionKey(fill);
      const parts = positions.get(key) ?? []; parts.push(fill); positions.set(key, parts);
    }
    let internallyContinuous = new Set(fills.map(fill => directionFor(fill, event.type))).size === 1;
    for (const [key, parts] of positions) {
      // Reconstruct same-millisecond fills by their monotonic position chain,
      // rather than lexicographic IDs (which put 10 before 9).
      parts.sort((a, b) => Date.parse(a.time) - Date.parse(b.time) || (a.positionBefore !== null && b.positionBefore !== null
        ? compare(absolute(decimal(a.positionBefore)), absolute(decimal(b.positionBefore))) * (event.type === 'entry' ? 1 : -1) : a.key.localeCompare(b.key)));
      firstPositions.set(key, parts[0]!.positionBefore);
      for (const fill of parts) {
        const previous = lastPositions.get(key);
        if (fill.positionBefore === null || fill.positionAfter === null || previous !== undefined && (previous === null || compare(decimal(previous), decimal(fill.positionBefore)) !== 0)) internallyContinuous = false;
        lastPositions.set(key, fill.positionAfter);
      }
    }
    let shared = false, continuous = !!current?.continuous && internallyContinuous && current.positions.size === firstPositions.size;
    for (const [key, before] of firstPositions) if (current?.positions.has(key)) {
      shared = true;
      const after = current.positions.get(key);
      if (before == null || after == null || compare(decimal(before), decimal(after)) !== 0 || compare(decimal(after), decimal('0')) === 0) continuous = false;
    } else continuous = false;
    if (!current || current.type !== event.type || current.date !== date || current.identity !== identity || !shared || !continuous) {
      current = { type: event.type, events: [], date, identity, positions: new Map(), continuous: internallyContinuous }; batches.push(current);
    }
    current.events.push(event);
    for (const [key, after] of lastPositions) current.positions.set(key, after);
  }
  return batches.map(batch => {
    const { type, events: matching } = batch;
    const groups = new Map<string, Group>();
    for (const event of matching) for (const fill of event.fills) {
      if (fill.base !== pair.left && fill.base !== pair.right) continue;
      const direction = directionFor(fill, type);
      const key = JSON.stringify([tradeVenueKey(fill), fill.scope, fill.priceCurrency, direction]);
      const group = groups.get(key) ?? { key, source: fill.source, exchange: fill.exchange, account: fill.account, scope: fill.scope, currency: fill.priceCurrency, direction, stale: false, legs: new Map<string, Leg>() };
      const legKey = JSON.stringify([fill.symbol, fill.base, fill.side, fill.positionSide, fill.quantityUnit]);
      const leg = group.legs.get(legKey) ?? { key: legKey, symbol: fill.symbol, base: fill.base, side: fill.side, positionSide: fill.positionSide, quantityUnit: fill.quantityUnit, quantity: decimal('0'), notional: decimal('0') };
      leg.quantity = add(leg.quantity, decimal(fill.quantity));
      leg.notional = add(leg.notional, multiply(decimal(fill.quantity), decimal(fill.price)));
      group.stale ||= fill.stale;
      group.legs.set(legKey, leg); groups.set(key, group);
    }
    return { key: matching[0]!.key, type, eventKeys: matching.map(event => event.key), eventCount: matching.length, fillCount: matching.reduce((sum, event) => sum + event.fills.length, 0),
      start: Math.min(...matching.map(event => event.time)), end: Math.max(...matching.map(event => event.end)),
      groups: [...groups.values()].map(group => {
        // The server keeps only strictly positive fill quantities, so each populated leg has a nonzero divisor.
        const legs = [...group.legs.values()].map(leg => ({ ...leg, quantity: decimalText(leg.quantity), price: decimalText(divide(leg.notional, leg.quantity)!) }));
        const left = legs.filter(leg => leg.base === pair.left), right = legs.filter(leg => leg.base === pair.right);
        const spread = left.length === 1 && right.length === 1 ? pair.spread(Number(left[0]!.price), Number(right[0]!.price)) : null;
        return { ...group, legs, spread };
      }),
    };
  });
}
export type TradeSummary = ReturnType<typeof summarizeTradeEvents>[number];

// ---- hynix-trades.ts / oil-chart-config.ts ----
export const HOUR_MS = 3_600_000;
export const OIL_BAR_MS = 900_000;
/** value/usd are chart y values; value/chartSpread feed the shared detail text in `unit`. */
export type SpreadTradeMarker = {
  event: TradeEvent; value: number | null; chartSpread: number | null; basis: string; usd: number | null;
  /** `percent` for a premium market (Hynix), `absolute` for a quote-currency spread (oil). */
  unit: 'percent' | 'absolute';
  venueLabel?: string;
};
/** Index of the bar containing time, or -1 when it starts before every bar. */
function containingIndex(points: Point[], time: number) {
  let low = 0, high = points.length;
  while (low < high) { const middle = (low + high) >>> 1; if (points[middle]!.time <= time) low = middle + 1; else high = middle; }
  return low - 1;
}
type SpreadTradeOptions = { intervalMs: number; rightPerUnit: number; tradedBasis: string; chartBasis: string; metric?: 'premium' | 'spread' };
/** A fill belongs to the bar that contains it. Fills after the last closed bar stay listed with their own prices and no chart value. */
export function spreadTradeMarkers(events: TradeEvent[], points: Point[], { intervalMs, rightPerUnit, tradedBasis, chartBasis, metric = 'premium' }: SpreadTradeOptions): SpreadTradeMarker[] {
  if (!points.length) return [];
  const start = points[0]!.time;
  return events.filter(event => event.time >= start).map(event => {
    const bar = points[containingIndex(points, event.time)];
    const covered = bar && event.time - bar.time < intervalMs ? bar : null;
    const chartSpread = covered && Number.isFinite(covered[metric]) ? covered[metric] : null;
    const prices = event.spreadVenue?.prices;
    const usd = prices ? prices.left - prices.right / rightPerUnit : covered && Number.isFinite(covered.spread) ? covered.spread : null;
    return { event, chartSpread, value: event.spread ?? chartSpread, basis: event.spread === null ? chartBasis : tradedBasis, usd, unit: metric === 'spread' ? 'absolute' : 'percent' };
  });
}
export const tradeMarkers = (market: FillMarket, events: TradeEvent[], points: Point[]) => market === 'oil'
  ? spreadTradeMarkers(events, points, { intervalMs: OIL_BAR_MS, rightPerUnit: 1, tradedBasis: '成交价差', chartBasis: '图表价差', metric: 'spread' })
  : spreadTradeMarkers(events, points, { intervalMs: HOUR_MS, rightPerUnit: 10, tradedBasis: '成交溢价率', chartBasis: '图表溢价率' });
/** The panel text of each market: oil's from oil-chart-config.ts, Hynix's from HYNIX_SPREAD_CHART. */
export const TRADE_TEXT: Record<FillMarket, { priceUnit: string; chartLabel: string; chartNote: string; metricName: string }> = {
  oil: { priceUnit: '/桶', chartLabel: '图表同时刻价差', chartNote: '最近 15 分钟 K 线', metricName: '价差' },
  hynix: { priceUnit: '', chartLabel: '图表同小时溢价率', chartNote: '小时收盘，未收盘小时为未知', metricName: '溢价率' },
};

// ---- trade-markers.mjs ----
const absoluteSpread = (venue: Venue | null | undefined) => venue?.prices ? decimalDifference(venue.prices.left, venue.prices.right) : null;
export const spreadText = (value: number | null, unit: SpreadTradeMarker['unit'] = 'percent') => value === null ? '未知' : unit === 'absolute' ? `${value < 0 ? '−' : ''}${Math.abs(value).toFixed(3)}` : `${value.toFixed(3)}%`;
const cashText = (totals: Cash[]) => totals.map(item => `${item.amount === null ? item.known === null ? '未知' : `未知（已知 ${item.known}）` : item.amount} ${item.currency}`).join('；') || '未知';
function venueLabels(venues: Venue[]) {
  const groups = new Map<string, Venue[]>(), labels = new Map<string, string>();
  for (const venue of venues) {
    const displayKey = JSON.stringify([venue.source, venue.exchange, venue.account]);
    if (!groups.has(displayKey)) groups.set(displayKey, []);
    groups.get(displayKey)!.push(venue);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => a.key.localeCompare(b.key));
    group.forEach((venue, index) => labels.set(venue.key, `${venue.source}${group.length > 1 ? `（来源 ${index + 1}）` : ''} · ${venue.exchange} · ${venue.account}`));
  }
  return labels;
}
export function tradeDetailLines(marker: SpreadTradeMarker, formatTime: (time: number | string) => string, { priceUnit = '/桶', chartLabel = '图表同时刻价差', chartNote = '最近 15 分钟 K 线' } = {}) {
  const { event, chartSpread, basis, value, unit = 'percent' } = marker, type = TRADE_TYPES[event.type];
  const labels = venueLabels(event.venues);
  const effects = { open: '开仓', close: '平仓', unknown: '开平未知' };
  const byFill = new Map<string, TradeEvent['effects']>();
  for (const effect of event.effects) {
    if (!byFill.has(effect.key)) byFill.set(effect.key, []);
    byFill.get(effect.key)!.push(effect);
  }
  return [
    `${type.symbol} ${marker.venueLabel ? `${marker.venueLabel} ` : ''}${type.label} · ${formatTime(event.time)} 北京时间`,
    `${event.fills.length} 笔成交 · 至 ${formatTime(event.end)}${event.stale ? ' · 保留旧数据' : ''}`,
    `${basis} ${spreadText(value, unit)}${event.spreadVenue ? ` · ${labels.get(event.spreadVenue.key)}` : ''}`,
    `${chartLabel} ${spreadText(chartSpread, unit)}（${chartNote}）`,
    ...event.venues.flatMap(venue => [
      `${labels.get(venue.key)} · ${venue.direction}`,
      ...venue.legs.map(leg => `${leg.base} ${leg.sides.map(side => side === 'buy' ? '买' : '卖').join('/')} ${leg.quantity} ${leg.quantityUnit} @ ${leg.price} ${leg.currency ?? '币种未知'}${priceUnit} · ${leg.scopes.join(' / ')}`),
      `成交价差 ${spreadText(unit === 'absolute' ? absoluteSpread(venue) : venue.spread, unit)}${venue.currency ? `（${venue.currency}${unit === 'absolute' ? priceUnit : ''}）` : ''}`,
      `手续费 ${cashText(venue.fees)} · 已实现盈亏 ${cashText(venue.realizedPnl)}`,
    ]),
    `手续费合计 ${cashText(event.fees)}（支出为负，返佣为正）`,
    `已实现盈亏合计 ${cashText(event.realizedPnl)}（不含手续费）`,
    ...event.fills.map(fill => {
      const parts = byFill.get(fill.key)!.map(effect => `${effects[effect.effect]} ${effect.quantity} ${fill.quantityUnit}`).join(' → ');
      return `${formatTime(fill.time)} · ${labels.get(tradeVenueKey(fill))} · ${fill.symbol} · ${parts}`;
    }),
  ];
}
export function fillsStatusText(view: FillsView, formatTime: (time: string) => string, sources = '仅支持 Binance、Bybit、OKX') {
  const state = {
    missing: '本服务没有配置资产账本', loading: '读取中…', unavailable: '成交服务暂不可用，稍后自动重试',
    // Stored fills are already on screen while the ledger reads newer history.
    ok: view.pending ? view.coverage.some(scope => scope.fetchedAt) ? '已显示上次成交，后台更新中…' : '读取中…' : '成交已更新',
  }[view.status];
  const failed = view.coverage.filter(scope => ['stale', 'error'].includes(scope.status)).length;
  const times = view.coverage.map(scope => scope.fetchedAt).filter((time): time is string => !!time).sort();
  // generatedAt is the response time, not the time a stale venue was successfully read.
  const through = times[0] ?? view.generatedAt;
  return [state, through ? `截至 ${formatTime(through)} 北京时间` : null,
    view.retained ? '刷新失败，保留上次成功数据' : null,
    failed ? `部分账户失败（${failed} 个范围）` : null,
    view.incomplete && view.status === 'ok' ? '覆盖不完整，部分成交开平未知或数据陈旧' : null,
    view.truncated ? '成交记录已截断' : null,
    sources, '最近 85 天',
  ].filter(Boolean).join(' · ');
}
