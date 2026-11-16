// 原油、海力士详情的「关联交易」（A-5）：从资产账本持仓（/api/asset/positions）里挑出本市场两条腿的持仓，同一交易所
// 两腿各一笔且方向相反时算开仓 / 当前 / 平仓价差与组合盈亏（含本轮 cycle）。复制自工作台（提交 7745181）并改写成
// TypeScript，规则不改：
// - src/hub-positions.ts（工作台宿主）的 matchBase、positionItems（MAX_POSITION_ITEMS 50、90 秒算旧值）；
// - modules/monitor/lib/related-pairs.ts 的 RELATED_SYMBOLS、pairTotals、relatedSpreadPairs。
// 与工作台的差异：只有本服务一个来源（工作台汇总多个 Asset 项目），来源固定为「资产账本」；数据来自本服务自己的
// 接口，不再逐字段校验格式；Anthropic 的 ANT 组合合计（related-position-totals.ts）不做（A-5 不做 anthropic）。
import type { FillMarket } from '../../src/asset/fills-types.ts';
import type { HubPositions, PositionCycle } from '../../src/asset/positions-types.ts';
import { oilSpread } from '../../src/vendor/oil-market.mjs';

export const RELATED_SOURCE = '资产账本';
export const MAX_POSITION_ITEMS = 50;
export const POSITIONS_STALE_AFTER_MS = 90_000;
/** Hyperliquid names the ordinary-share leg SKHX; the CEX contracts use SKHYNIX. */
export const RELATED_SYMBOLS: Record<FillMarket, readonly string[]> = { oil: ['CL', 'BZ'], hynix: ['SKHY', 'SKHX', 'SKHYNIX'] };
export type RelatedItem = {
  key: string; source: string; exchange: string; exchangeId?: string; symbol: string; base: string; side: 'long' | 'short';
  quantity: string; quantityUnit: string; entryPrice: string | null; markPrice: string | null;
  unrealizedPnl: string | null; pnlCurrency: string | null; updatedAt: string | null; stale: boolean;
  cycle?: PositionCycle | null;
};
export type RelatedSelection = { items: RelatedItem[]; incomplete: boolean; sourcesIncomplete: boolean; truncated: boolean; matchedCount: number; itemLimit: number };

const SUFFIXES = new Set(['', 'USDT', 'USD', 'USDC', 'USD1', 'PERP', 'SWAP', 'USDTSWAP', 'USDTPERP', 'USDCPERP', 'USDSWAP', 'USDPERP']);
export function matchBase(symbol: string, bases: readonly string[]): string | null {
  const normalized = symbol.toUpperCase().replace(/[^\p{L}\p{N}]/gu, '');
  let match: string | null = null;
  for (const base of bases) {
    if (normalized.startsWith(base) && SUFFIXES.has(normalized.slice(base.length)) && (!match || base.length > match.length)) match = base;
  }
  return match;
}
const old = (value: string | null, now: number) => value === null || !Number.isFinite(Date.parse(value)) || now - Date.parse(value) > POSITIONS_STALE_AFTER_MS;

/** `incomplete` marks unconfirmed scopes or a capped match list, so a subset is never mistaken for the complete set of related positions. */
export function positionItems(data: HubPositions, bases: readonly string[], now: number): RelatedSelection {
  const items: RelatedItem[] = [], seen = new Map<string, number>();
  let sourcesIncomplete = false, matchedCount = 0;
  for (const exchange of data.exchanges) for (const account of exchange.accounts) for (const scope of account.scopes) {
    const positions = scope.positions;
    if ((scope.status === 'error' || scope.status === 'loading') && !positions.length) sourcesIncomplete = true;
    const stale = scope.status === 'stale' || scope.status === 'error' || old(scope.fetchedAt, now);
    if (stale && !positions.length && !['unconfigured', 'unsupported'].includes(scope.status)) sourcesIncomplete = true;
    for (const position of positions) {
      const base = matchBase(position.symbol, bases) ?? matchBase(position.instrumentId, bases);
      if (!base) continue;
      matchedCount++;
      if (items.length >= MAX_POSITION_ITEMS) continue;
      const identity = `${exchange.id}:${position.symbol}:${position.side}`, count = (seen.get(identity) ?? 0) + 1;
      seen.set(identity, count);
      items.push({ key: `${identity}:${count}`, source: RELATED_SOURCE, exchange: exchange.name, exchangeId: exchange.id, symbol: position.symbol, base, side: position.side,
        quantity: position.quantity, quantityUnit: position.quantityUnit, entryPrice: position.entryPrice, markPrice: position.markPrice,
        unrealizedPnl: position.unrealizedPnl, pnlCurrency: position.pnlCurrency, updatedAt: scope.fetchedAt, stale, ...(position.cycle === undefined ? {} : { cycle: position.cycle }) });
    }
  }
  const truncated = matchedCount > MAX_POSITION_ITEMS;
  return { items, incomplete: sourcesIncomplete || truncated, sourcesIncomplete, truncated, matchedCount, itemLimit: MAX_POSITION_ITEMS };
}

/** Current same-venue spread in the market's unit (oil USDT/桶, Hynix percent), keyed by exchange id (for example `binance`). */
export type VenueSpreads = Record<string, { value: number | null; stale: boolean }>;
export type UnpairedReason = 'same-side' | 'multiple' | 'missing-leg';
/** Why the realized half of a pair total is missing or qualified. */
export type RealizedStatus = 'complete' | 'partial' | 'loading' | 'unavailable' | 'mixed-currency';
/** Both legs added together. Unrealized comes from the open positions, realized from each leg's current cycle; amounts in different currencies are never added. */
export type PairTotals = {
  unrealized: number | null; unrealizedCurrency: string | null; unrealizedStale: boolean;
  realizedStatus: RealizedStatus; realizedCurrency: string | null;
  realized: number | null; fees: number | null; funding: number | null; net: number | null;
  /** Unrealized plus realized net, only when both are known in the same currency. */
  total: number | null;
};
export type SpreadPair =
  | { key: string; label: string; status: 'paired'; opening: number | null; current: number | null; currentStale: boolean;
    /** Current minus opening, in USDT/桶 for oil and percentage points for Hynix. */
    change: number | null;
    /** True when a falling spread profits this pair, i.e. the leg in the numerator is short. */
    narrowingFavors: boolean;
    /** Same formula applied to both legs' average close price this cycle. */
    closing: number | null; totals: PairTotals }
  | { key: string; label: string; status: 'unpaired'; reason: UnpairedReason };

const HYNIX_UNITS = 10;
/** Each market pairs a base leg with a quote leg; the opening spread uses the same formula as the live exchange comparison so the two columns are comparable. */
const PAIRS: Record<FillMarket, { base: readonly string[]; quote: readonly string[]; spread: (base: number, quote: number) => number | null; numerator: 'base' | 'quote' }> = {
  oil: { base: ['CL'], quote: ['BZ'], spread: (cl, bz) => oilSpread(bz, cl), numerator: 'quote' },
  hynix: { base: ['SKHY'], quote: ['SKHX', 'SKHYNIX'], spread: (adr, ordinary) => (adr / (ordinary / HYNIX_UNITS) - 1) * 100, numerator: 'base' },
};
/** Venues are keyed by the stable `exchangeId`; without one, the display name lower-cased with punctuation removed (Binance -> binance). */
export function venueKey(item: Pick<RelatedItem, 'exchange'> & { exchangeId?: string }) {
  return item.exchangeId ?? item.exchange.toLowerCase().replace(/[^a-z0-9]/g, '');
}
const amount = (value: string | null | undefined) => { if (value === null || value === undefined || value.trim() === '') return null; const number = Number(value); return Number.isFinite(number) ? number : null; };
const price = (value: string | null | undefined) => { const number = amount(value); return number !== null && number > 0 ? number : null; };
const sum = (a: number | null, b: number | null) => a === null || b === null ? null : a + b;
const hasClosed = (cycle: PositionCycle | null | undefined) => !!cycle && (cycle.status === 'complete' || cycle.status === 'partial');

function realizedStatus(base: RelatedItem, quote: RelatedItem): RealizedStatus {
  const cycles = [base.cycle, quote.cycle];
  if (cycles.some(cycle => !cycle || cycle.status === 'unavailable')) return 'unavailable';
  if (cycles.some(cycle => cycle?.status === 'loading')) return 'loading';
  if (!base.cycle?.currency || base.cycle.currency !== quote.cycle?.currency) return 'mixed-currency';
  return cycles.some(cycle => cycle?.status === 'partial') ? 'partial' : 'complete';
}
export function pairTotals(base: RelatedItem, quote: RelatedItem): PairTotals {
  const unrealizedCurrency = base.pnlCurrency && base.pnlCurrency === quote.pnlCurrency ? base.pnlCurrency : null;
  const unrealized = unrealizedCurrency ? sum(amount(base.unrealizedPnl), amount(quote.unrealizedPnl)) : null;
  const status = realizedStatus(base, quote);
  const known = status === 'complete' || status === 'partial';
  const field = (key: 'realizedPnl' | 'fees' | 'funding' | 'net') => known ? sum(amount(base.cycle?.[key]), amount(quote.cycle?.[key])) : null;
  const realizedCurrency = known ? base.cycle?.currency ?? null : null;
  const net = field('net');
  return {
    unrealized, unrealizedCurrency, unrealizedStale: base.stale || quote.stale,
    realizedStatus: status, realizedCurrency, realized: field('realizedPnl'), fees: field('fees'), funding: field('funding'), net,
    total: unrealized !== null && net !== null && unrealizedCurrency === realizedCurrency ? unrealized + net : null,
  };
}
/** A spread is shown only for a venue holding exactly one position of each leg in opposite directions; incomplete lists cannot establish uniqueness and yield no pairs. */
export function relatedSpreadPairs(market: FillMarket, items: readonly RelatedItem[], spreads: VenueSpreads | undefined, incomplete = false): SpreadPair[] {
  if (incomplete) return [];
  const spec = PAIRS[market];
  const venues = new Map<string, { label: string; venue: string; base: RelatedItem[]; quote: RelatedItem[] }>();
  for (const item of items) {
    const leg = spec.base.includes(item.base) ? 'base' : spec.quote.includes(item.base) ? 'quote' : null;
    if (!leg) continue;
    const venue = venueKey(item), key = `${item.source}|${venue}`;
    const group = venues.get(key) ?? { label: `${item.source} · ${item.exchange}`, venue, base: [], quote: [] };
    group[leg].push(item);
    venues.set(key, group);
  }
  return [...venues.entries()].map(([key, group]): SpreadPair => {
    if (!group.base.length || !group.quote.length) return { key, label: group.label, status: 'unpaired', reason: 'missing-leg' };
    if (group.base.length > 1 || group.quote.length > 1) return { key, label: group.label, status: 'unpaired', reason: 'multiple' };
    const base = group.base[0]!, quote = group.quote[0]!;
    if (base.side === quote.side) return { key, label: group.label, status: 'unpaired', reason: 'same-side' };
    const baseEntry = price(base.entryPrice), quoteEntry = price(quote.entryPrice), live = spreads?.[group.venue];
    const opening = baseEntry !== null && quoteEntry !== null ? spec.spread(baseEntry, quoteEntry) : null, current = live?.value ?? null;
    const closed = hasClosed(base.cycle) && hasClosed(quote.cycle) && (amount(base.cycle?.closedQuantity) ?? 0) > 0 && (amount(quote.cycle?.closedQuantity) ?? 0) > 0;
    const baseClose = closed ? price(base.cycle?.closePrice) : null, quoteClose = closed ? price(quote.cycle?.closePrice) : null;
    return {
      key, label: group.label, status: 'paired', opening, current, currentStale: live?.stale ?? false,
      change: opening !== null && current !== null ? current - opening : null, narrowingFavors: (spec.numerator === 'base' ? base : quote).side === 'short',
      closing: baseClose !== null && quoteClose !== null ? spec.spread(baseClose, quoteClose) : null, totals: pairTotals(base, quote),
    };
  });
}
