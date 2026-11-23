// Adapted from project_aggregation modules/asset/lib/daily-positions.ts at 0014655.
import type { Position, PositionCycle } from './positions-types.ts';
import type { QuoteEvidence } from './types.ts';

/** Positions as cached when a daily snapshot was written; balances and holdings share that moment. */
export type SnapshotCycle = Pick<PositionCycle, 'status' | 'since' | 'realizedPnl' | 'fees' | 'funding' | 'net' | 'currency' | 'updatedAt'>;
export type SnapshotPosition = Pick<Position, 'id' | 'symbol' | 'instrumentId' | 'side' | 'quantity' | 'quantityUnit' | 'unrealizedPnl' | 'pnlCurrency'> & { cycle: SnapshotCycle | null };
/** `generation` is a one-way digest of the stored credential, so a replaced account is never compared with the old one. */
export type SnapshotScope = { exchange: string; account: string; accountName: string; generation: string; scope: string; status: 'live' | 'stale'; fetchedAt: string; positions: SnapshotPosition[] };
export type PositionsCapture = { capturedAt: string; scopes: SnapshotScope[]; scopeCoverage?: 'configured' };

export type ComboId = 'oil' | 'hynix' | 'anthropic';
export const COMBOS: { id: ComboId; label: string; bases: string[] }[] = [
  { id: 'oil', label: '原油套利', bases: ['CL', 'BZ', 'BRENTOIL', 'WTI'] },
  { id: 'hynix', label: '海力士套利', bases: ['SKHY', 'SKHX', 'SKHYNIX'] },
  { id: 'anthropic', label: 'ANT 套利', bases: ['ANTHROPIC', 'ANT'] },
];
export type PositionChange = {
  key: string; account: string; symbol: string; side: Position['side']; combo: ComboId | null;
  previousQuantity: string | null; quantity: string | null; quantityUnit: string;
  /** Native PnL currency; `change` is converted to USD. */
  currency: string | null; unrealizedChange: number | null; cashFlowChange: number | null; change: number | null;
  /** Funding, fees and realized PnL are missing from `change`, or the whole change is unknown. */
  partial: boolean; note: string | null;
};
export type GroupId = ComboId | 'other';
/** `change` sums known contributions only and is null when nothing is known; `complete` also requires every scope read live at both snapshots. */
export type GroupImpact = { id: GroupId; label: string; change: number | null; complete: boolean; legs: number };
/** `groups` is empty until two captures can be compared; `recorded` says the current snapshot holds any scope. */
export type PositionAnalysis = { compared: boolean; recorded: boolean; capturedAt: string; previousCapturedAt: string | null; groups: GroupImpact[] };
export const POSITION_GROUPS: ReadonlyArray<{ id: GroupId; label: string }> = [...COMBOS.map(({ id, label }) => ({ id, label })), { id: 'other', label: '其他持仓' }];
type BalanceRow = { mode?: string; value: number | null; details?: { coin: string; value: number; price: number }[]; quote?: QuoteEvidence };

const CENT = 0.005;
// Cycle summaries refresh every few minutes, so a flow landing just before a capture can shift to the next day; anything older means the summary stalled.
const CYCLE_MAX_LAG = 15 * 60_000;
const cents = (value: number) => Math.abs(value) < CENT ? 0 : value;
// Same prefix rule as the workbench's related-position matching, so both sides pick identical legs.
const SUFFIXES = new Set(['', 'USDT', 'USD', 'USDC', 'USD1', 'PERP', 'SWAP', 'USDTSWAP', 'USDTPERP', 'USDCPERP', 'USDSWAP', 'USDPERP']);
export function matchBase(symbol: string, bases: readonly string[]): string | null {
  const normalized = symbol.toUpperCase().replace(/[^\p{L}\p{N}]/gu, '');
  let match: string | null = null;
  for (const base of bases) if (normalized.startsWith(base) && SUFFIXES.has(normalized.slice(base.length)) && (!match || base.length > match.length)) match = base;
  return match;
}
/** A base that names the combo's asset on these venues only: Binance's ANTUSDT is Anthropic, an ANT contract elsewhere is not assumed to be. */
export const VENUE_ONLY_BASES: Readonly<Record<string, readonly string[]>> = { ANT: ['binance'] };
const basesAt = (bases: readonly string[], exchange: string) => bases.filter(base => VENUE_ONLY_BASES[base]?.includes(exchange) ?? true);
const HYPERLIQUID_COMBOS = new Map<string, ComboId>([
  ['XYZ:CL', 'oil'], ['XYZ:BRENTOIL', 'oil'], ['XYZ:SKHY', 'hynix'], ['XYZ:SKHX', 'hynix'],
  ['XYZ:ANT', 'anthropic'], ['IO:ANTH', 'anthropic'],
]);
export function comboOf(position: Pick<Position, 'symbol' | 'instrumentId'>, exchange: string): ComboId | null {
  if (exchange === 'hyperliquid') return HYPERLIQUID_COMBOS.get(position.symbol.toUpperCase()) ?? HYPERLIQUID_COMBOS.get(position.instrumentId.toUpperCase()) ?? null;
  return COMBOS.find(combo => { const bases = basesAt(combo.bases, exchange); return matchBase(position.symbol, bases) || matchBase(position.instrumentId, bases); })?.id ?? null;
}

const amount = (value: string | null | undefined) => {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
/** Rows whose sync stores quote evidence (sync.ts withQuote); evidence on any other row is not trusted. */
const QUOTE_EVIDENCE_MODES = new Set(['hyperliquid']);
// The source accepts a quote up to 15 minutes old when it reads it (sources/hyperliquid.ts QUOTE_MAX_AGE_MS); the holdings
// of the same snapshot are a live read of the last 90 s, so a quote received more than 5 minutes from that observation came
// from another sync (a later failed read keeps the old row and its quote) and is not this snapshot's price.
const QUOTE_SOURCE_MAX_AGE = 15 * 60_000, QUOTE_RECEIPT_WINDOW = 5 * 60_000, QUOTE_FUTURE_TOLERANCE = 60_000;
/** The evidence's USD price when it was fresh at the holdings' observation time `at`; null when it was not. */
function evidencedRate(quote: QuoteEvidence, at: string): number | null {
  const observed = Date.parse(at), priced = Date.parse(quote.at), received = Date.parse(quote.receivedAt);
  if (![observed, priced, received].every(Number.isFinite)) return null;
  if (priced - received > QUOTE_FUTURE_TOLERANCE || received - priced > QUOTE_SOURCE_MAX_AGE) return null;
  return Math.abs(received - observed) <= QUOTE_RECEIPT_WINDOW ? quote.usd : null;
}
/**
 * USD per unit of `currency`, from the snapshot's own rows so the rate matches the balances: a row's quote evidence for
 * that coin (issue #63) decides for its row (its balance details were priced with the same quote, so a stale quote
 * proves nothing through them either); other rows, and snapshots written before the evidence existed, use the balance
 * details as before. Only the current snapshot's rows are passed in: a quote never carries over from another snapshot.
 */
function usdRate(currency: string | null, rows: BalanceRow[], exchange: string, at: string) {
  if (currency === 'USD') return 1;
  if (!currency) return null;
  const candidates = [...rows.filter(row => row.mode === exchange), ...rows.filter(row => row.mode !== exchange)];
  for (const row of candidates) {
    const quote = row.mode !== undefined && QUOTE_EVIDENCE_MODES.has(row.mode) ? quoteOf(row.quote) : undefined;
    if (quote?.coin === currency) {
      const rate = evidencedRate(quote, at);
      if (rate !== null) return rate;
      continue;
    }
    for (const detail of row.details ?? []) if (detail.coin === currency && detail.price > 0) return detail.price;
  }
  return null;
}
const scopeKey = (scope: Pick<SnapshotScope, 'exchange' | 'account' | 'generation' | 'scope'>) => JSON.stringify([scope.exchange, scope.account, scope.generation, scope.scope]);
const knownSum = (values: (number | null)[]) => values.some(value => value !== null) ? cents(values.reduce<number>((sum, value) => sum + (value ?? 0), 0)) : null;

const lagging = (cycle: SnapshotCycle, at: string) => !cycle.updatedAt || Date.parse(at) - Date.parse(cycle.updatedAt) > CYCLE_MAX_LAG;
function cashFlow(previous: SnapshotPosition | undefined, current: SnapshotPosition | undefined, previousAt: string, currentAt: string): number | null {
  const before = previous?.cycle, after = current?.cycle;
  if (!current || !after?.since || after.net === null || after.status === 'loading' || after.status === 'unavailable' || lagging(after, currentAt)) return null;
  if (!previous) {
    // Opened after the previous capture: every cycle flow falls inside this interval.
    return Date.parse(after.since) >= Date.parse(previousAt) ? amount(after.net) : null;
  }
  if (previous.side !== current.side || !before || before.since !== after.since || before.net === null || before.currency !== after.currency || lagging(before, previousAt)) return null;
  const end = amount(after.net), start = amount(before.net);
  return end === null || start === null ? null : end - start;
}

function positionChange(previous: SnapshotPosition | undefined, current: SnapshotPosition | undefined, at: { usable: boolean; previous: string | null; current: string }, rate: (currency: string | null) => number | null, scope: SnapshotScope, key: string): PositionChange {
  const held = current ?? previous!, { usable, previous: previousAt } = at;
  const base = { key, account: scope.accountName, symbol: held.symbol, side: held.side, combo: comboOf(held, scope.exchange), previousQuantity: previous?.quantity ?? null, quantity: current?.quantity ?? null,
    quantityUnit: held.quantityUnit, currency: held.pnlCurrency };
  const unknown = (note: string): PositionChange => ({ ...base, unrealizedChange: null, cashFlowChange: null, change: null, partial: true, note });
  if (!usable || previousAt === null) return unknown(previousAt === null ? '前一份快照未记录持仓' : '持仓未在两份快照中同时有效读取');
  if (!current) return unknown('已平仓，平仓盈亏未单独统计');
  if (previous && previous.pnlCurrency !== current.pnlCurrency) return unknown('两份快照的盈亏币种不同');
  const before = previous ? amount(previous.unrealizedPnl) : 0, after = amount(current.unrealizedPnl);
  if (before === null || after === null) return unknown('缺少浮盈亏');
  const usd = rate(held.pnlCurrency);
  if (usd === null) return unknown(`缺少 ${held.pnlCurrency ?? '盈亏币种'} 兑 USD 价格`);
  const cash = cashFlow(previous, current, previousAt, at.current);
  const unrealizedChange = after - before;
  return { ...base, unrealizedChange, cashFlowChange: cash, change: cents((unrealizedChange + (cash ?? 0)) * usd), partial: cash === null,
    note: cash === null ? (current.cycle ? '本轮统计不可比，仅计浮盈亏变化' : '仅计浮盈亏变化，未含资金费与手续费') : null };
}

type CompareInput = { previous: PositionsCapture | null | undefined; current: PositionsCapture; rows: BalanceRow[] };
/** Per-position changes. `readable` is false when any scope was not read live at both captures, so an empty group may still hide holdings. */
export function comparePositions(input: CompareInput): { positions: PositionChange[]; readable: boolean } {
  const { previous, current } = input;
  const before = new Map((previous?.scopes ?? []).map(scope => [scopeKey(scope), scope]));
  const after = new Map(current.scopes.map(scope => [scopeKey(scope), scope]));
  const positions: PositionChange[] = [];
  // Older captures omitted unread scopes. Use their known legs, but require explicit coverage to prove a group is empty.
  let readable = previous?.scopeCoverage === 'configured' && current.scopeCoverage === 'configured' && before.size > 0 && after.size > 0;
  for (const key of new Set([...after.keys(), ...before.keys()])) {
    const old = before.get(key), next = after.get(key), scope = next ?? old!;
    const usable = old?.status === 'live' && next?.status === 'live' && Date.parse(next.fetchedAt) > Date.parse(old.fetchedAt);
    if (!usable) readable = false;
    const oldPositions = new Map((old?.positions ?? []).map(item => [item.id, item]));
    const nextPositions = new Map((next?.positions ?? []).map(item => [item.id, item]));
    for (const id of new Set([...nextPositions.keys(), ...oldPositions.keys()])) {
      positions.push(positionChange(oldPositions.get(id), nextPositions.get(id), { usable, previous: previous ? old?.fetchedAt ?? previous.capturedAt : null, current: next?.fetchedAt ?? current.capturedAt },
        currency => usdRate(currency, input.rows, scope.exchange, next?.fetchedAt ?? current.capturedAt), scope, JSON.stringify([key, id])));
    }
  }
  return { positions, readable };
}

/** Arbitrage legs by underlying, and all other holdings as one total. Unknown stays unknown, never zero. */
export function analyzePositions(input: Omit<CompareInput, 'current'> & { current: PositionsCapture | null | undefined }): PositionAnalysis | null {
  const { previous, current } = input;
  if (!current) return null;
  const { positions, readable } = comparePositions({ ...input, current });
  const groups = !previous ? [] : POSITION_GROUPS.map(group => {
    const legs = positions.filter(item => (item.combo ?? 'other') === group.id);
    // No legs only proves "no holdings" when every scope was read live at both captures.
    const change = legs.length ? knownSum(legs.map(item => item.change)) : readable ? 0 : null;
    return { ...group, change, complete: readable && legs.every(item => item.change !== null && !item.partial), legs: legs.length };
  });
  return { compared: !!previous, recorded: current.scopes.length > 0, capturedAt: current.capturedAt, previousCapturedAt: previous?.capturedAt ?? null, groups };
}

const isText = (value: unknown, max = 200): value is string => typeof value === 'string' && value.length <= max;
const decimalOrNull = (value: unknown) => isText(value, 128) && /^-?\d+(?:\.\d+)?$/.test(value) ? value : null;
const isTime = (value: unknown): value is string => isText(value, 40) && Number.isFinite(Date.parse(value));
/** A row's stored quote evidence (issue #63), re-validated on read; malformed evidence is dropped, never repaired. */
export function quoteOf(value: unknown): QuoteEvidence | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (!isText(raw.coin, 20) || !raw.coin || typeof raw.usd !== 'number' || !Number.isFinite(raw.usd) || raw.usd <= 0
    || !isText(raw.source, 100) || !raw.source || !isTime(raw.at) || !isTime(raw.receivedAt)) return undefined;
  return { coin: raw.coin, usd: raw.usd, source: raw.source, at: raw.at, receivedAt: raw.receivedAt };
}

/** Stored JSON is re-validated on read; malformed captures are dropped rather than trusted. */
export function positionsOf(value: unknown): PositionsCapture | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { capturedAt?: unknown; scopes?: unknown; scopeCoverage?: unknown };
  if (!isText(raw.capturedAt) || !Number.isFinite(Date.parse(raw.capturedAt)) || !Array.isArray(raw.scopes)) return null;
  const scopes: SnapshotScope[] = [];
  for (const item of raw.scopes) {
    if (!item || typeof item !== 'object') return null;
    const scope = item as Record<string, unknown>;
    if (![scope.exchange, scope.account, scope.accountName, scope.generation, scope.scope, scope.fetchedAt].every(field => isText(field)) || (scope.status !== 'live' && scope.status !== 'stale') || !Array.isArray(scope.positions)) return null;
    const positions: SnapshotPosition[] = [];
    for (const entry of scope.positions as unknown[]) {
      if (!entry || typeof entry !== 'object') return null;
      const p = entry as Record<string, unknown>, c = p.cycle as Record<string, unknown> | null | undefined;
      if (![p.id, p.symbol, p.instrumentId, p.quantityUnit].every(field => isText(field)) || (p.side !== 'long' && p.side !== 'short') || decimalOrNull(p.quantity) === null) return null;
      const cycle: SnapshotCycle | null = c && typeof c === 'object' && ['loading', 'complete', 'partial', 'unavailable'].includes(c.status as string)
        ? { status: c.status as SnapshotCycle['status'], since: isText(c.since) ? c.since : null, realizedPnl: decimalOrNull(c.realizedPnl), fees: decimalOrNull(c.fees),
          funding: decimalOrNull(c.funding), net: decimalOrNull(c.net), currency: isText(c.currency, 20) ? c.currency : null,
          updatedAt: isText(c.updatedAt) && Number.isFinite(Date.parse(c.updatedAt)) ? c.updatedAt : null } : null;
      positions.push({ id: p.id as string, symbol: p.symbol as string, instrumentId: p.instrumentId as string, side: p.side, quantity: p.quantity as string, quantityUnit: p.quantityUnit as string,
        unrealizedPnl: decimalOrNull(p.unrealizedPnl), pnlCurrency: isText(p.pnlCurrency, 20) ? p.pnlCurrency : null, cycle });
    }
    scopes.push({ exchange: scope.exchange as string, account: scope.account as string, accountName: scope.accountName as string, generation: scope.generation as string, scope: scope.scope as string,
      status: scope.status, fetchedAt: scope.fetchedAt as string, positions });
  }
  return { capturedAt: raw.capturedAt, scopes, ...(raw.scopeCoverage === 'configured' ? { scopeCoverage: raw.scopeCoverage } : {}) };
}
