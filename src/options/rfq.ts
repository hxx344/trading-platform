// 组合询价 RFQ (G2c), after the workbench Greeks module's app/rfq.py (0c5a219): the record kept in the state document,
// how an exchange observation moves it, and the checks on a quote before it is executed. The engine (engine.ts) owns the
// reads and writes; everything here is pure so the rules can be tested without a venue.
import { cmp, decimal } from '../decimal.ts';
import type { Row } from './client.ts';
import type { FeeContext, PlanLeg, Task } from './engine.ts';
import type { Side, StrategyMode } from './strategy.ts';

/** Bybit's states, and ours while a write's answer is missing (the write may or may not have happened). */
export type RfqStatus = 'CreationUnknown' | 'ExecutionUnknown' | 'CancelUnknown' | 'Active' | 'PendingFill' | 'Filled' | 'Canceled' | 'Expired' | 'Failed';
const REMOTE: readonly RfqStatus[] = ['Active', 'PendingFill', 'Filled', 'Canceled', 'Expired', 'Failed'];
export const RFQ_TERMINAL: readonly RfqStatus[] = ['Filled', 'Canceled', 'Expired', 'Failed'];
export const isTerminal = (status: RfqStatus): boolean => RFQ_TERMINAL.includes(status);
export const RFQ_STATUS_NAMES: Record<RfqStatus, string> = {
  CreationUnknown: '创建结果待核对', ExecutionUnknown: '执行结果待核对', CancelUnknown: '取消已提交，待交易所确认',
  Active: '等待报价', PendingFill: '已提交执行，等待成交', Filled: '已成交', Canceled: '已取消', Expired: '已过期', Failed: '失败',
};
/** A quote must still have this long when it is sent, or the venue would refuse it on the way. */
export const QUOTE_MIN_LEFT_MS = 2_000;

export interface RfqQuoteLeg { symbol: string; qty: string; price: number }
export interface RfqQuote { quoteId: string; deskCode: string; status: string; expiresAt: number; sell: RfqQuoteLeg[] }
/** The one RFQ the service has (a new one replaces it only once it is finished, see rfqFinished). */
export interface RfqRecord {
  requestId: string; fingerprint: string; taskId: string; linkId: string; rfqId: string | null; status: RfqStatus;
  mode: StrategyMode; strategyType: string; counterparties: string[]; legs: PlanLeg[];
  /** The opening's risk at creation; on execution it is recomputed at the quote's prices. */
  risk: NonNullable<Task['risk']>; feeContext: FeeContext;
  createdAt: number; updatedAt: number; expiresAt: number | null;
  /** The quote sent for execution, its prices, and the chain price of each leg at that moment (for 价差 in the ledger). */
  selectedQuoteId: string | null; selectedDesk: string | null; selectedPrices: Record<string, number> | null; executionChain: Record<string, number> | null;
  executionStartedAt: number | null; executionResolved: boolean;
  /** Filled and turned into the tracked strategy (an RFQ opening task with its journal entries). */
  trackingApplied: boolean; error: string | null;
}

/** The saved record's shape (restore refuses a document it cannot act on safely). */
export function validRfq(value: unknown): value is RfqRecord {
  const item = value as Record<string, unknown>;
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return false;
  const text = (key: string) => typeof item[key] === 'string';
  const maybe = (key: string, check: (inner: unknown) => boolean) => item[key] === null || check(item[key]);
  const time = (inner: unknown) => Number.isFinite(inner);
  const record = (inner: unknown) => typeof inner === 'object' && inner !== null && !Array.isArray(inner);
  return ['requestId', 'fingerprint', 'taskId', 'linkId', 'strategyType'].every(text) && maybe('rfqId', inner => typeof inner === 'string')
    && (['Active', 'PendingFill', 'Filled', 'Canceled', 'Expired', 'Failed', 'CreationUnknown', 'ExecutionUnknown', 'CancelUnknown'] as unknown[]).includes(item.status)
    && (item.mode === 'iron_condor' || item.mode === 'short_strangle') && Array.isArray(item.counterparties) && Array.isArray(item.legs) && item.legs.length > 0
    && (item.legs as unknown[]).every(leg => record(leg) && typeof (leg as Row).symbol === 'string' && ((leg as Row).side === 'Buy' || (leg as Row).side === 'Sell') && typeof (leg as Row).qty === 'string')
    && record(item.risk) && record((item.risk as Row).legs) && record(item.feeContext) && time(item.createdAt) && time(item.updatedAt) && maybe('expiresAt', time)
    && maybe('selectedQuoteId', inner => typeof inner === 'string') && maybe('selectedDesk', inner => typeof inner === 'string') && maybe('selectedPrices', record) && maybe('executionChain', record)
    && maybe('executionStartedAt', time) && typeof item.executionResolved === 'boolean' && typeof item.trackingApplied === 'boolean' && maybe('error', inner => typeof inner === 'string');
}

/**
 * Still blocks trading: not final, filled but not yet tracked, or a chosen quote whose outcome is unknown. Unlike the
 * workbench, an Active RFQ also blocks other trading: its execution must not meet a strategy opened meanwhile.
 */
export const rfqFinished = (rfq: RfqRecord | null): boolean => rfq === null || (isTerminal(rfq.status) && (rfq.status !== 'Filled' || rfq.trackingApplied) && (rfq.selectedQuoteId === null || rfq.executionResolved));

export interface RfqObservation { rfqId: string; rfqLinkId: string; status: RfqStatus; expiresAt: number | null }
export function parseRfqRow(row: Row): RfqObservation {
  const status = row.status as RfqStatus;
  if (typeof row.rfqId !== 'string' || !row.rfqId || typeof row.rfqLinkId !== 'string' || !REMOTE.includes(status)) throw new Error('询价记录格式无效');
  const expiresAt = Number(row.expiresAt);
  return { rfqId: row.rfqId, rfqLinkId: row.rfqLinkId, status, expiresAt: Number.isSafeInteger(expiresAt) && expiresAt > 0 ? expiresAt : null };
}

/**
 * Applies what the venue says. A final state is never left; after a chosen quote or a cancel, a lagging Active never
 * brings the RFQ back to executable. Returns whether anything changed.
 */
export function observe(rfq: RfqRecord, seen: RfqObservation, at: number): boolean {
  if (seen.rfqLinkId !== rfq.linkId || (rfq.rfqId !== null && seen.rfqId !== rfq.rfqId)) throw new Error('交易所询价与本地记录的编号不符');
  if (isTerminal(rfq.status)) return false;
  const before = JSON.stringify(rfq);
  rfq.rfqId = seen.rfqId;
  if (seen.expiresAt !== null) rfq.expiresAt = seen.expiresAt;
  if (isTerminal(seen.status)) {
    rfq.status = seen.status;
    if (rfq.selectedQuoteId !== null) rfq.executionResolved = true;
  } else if (rfq.status === 'CancelUnknown') { /* waits for a final state */ }
  else if (rfq.selectedQuoteId !== null && !rfq.executionResolved) rfq.status = seen.status === 'PendingFill' || rfq.status === 'PendingFill' ? 'PendingFill' : 'ExecutionUnknown';
  else rfq.status = seen.status;
  if (JSON.stringify(rfq) === before) return false;
  rfq.updatedAt = at;
  return true;
}

/** The quotes for this RFQ that can be read; a malformed one is left out rather than shown with wrong numbers. */
export function parseQuotes(rows: readonly Row[], rfqId: string): RfqQuote[] {
  const quotes: RfqQuote[] = [];
  for (const row of rows) {
    if (row.rfqId !== rfqId || typeof row.quoteId !== 'string' || !row.quoteId || !Array.isArray(row.quoteSellList)) continue;
    const expiresAt = Number(row.expiresAt);
    if (!Number.isSafeInteger(expiresAt)) continue;
    const sell: RfqQuoteLeg[] = [];
    let valid = true;
    for (const leg of row.quoteSellList as unknown[]) {
      const item = leg as Row;
      let qty: string;
      try { qty = decimal(item?.qty, 'positive'); } catch { valid = false; break; }
      const price = Number(item?.price);
      if (typeof item?.symbol !== 'string' || !Number.isFinite(price)) { valid = false; break; }
      sell.push({ symbol: item.symbol, qty, price });
    }
    if (valid) quotes.push({ quoteId: row.quoteId, deskCode: typeof row.deskCode === 'string' ? row.deskCode : '', status: typeof row.status === 'string' ? row.status : '', expiresAt, sell });
  }
  return quotes;
}

/** Why this quote cannot be executed now; null when it can: live, not about to expire, every leg at its exact quantity and a positive price. */
export function quoteProblem(rfq: RfqRecord, quote: RfqQuote, at: number): string | null {
  if (rfq.status !== 'Active' || rfq.selectedQuoteId !== null) return '询价已不在可执行状态';
  if (rfq.expiresAt === null || rfq.expiresAt - at < QUOTE_MIN_LEFT_MS) return '询价已过期或即将过期';
  if (quote.status !== 'Active') return '这条报价已不可用';
  if (quote.expiresAt - at < QUOTE_MIN_LEFT_MS) return '这条报价已过期或即将过期';
  const legs = new Map(rfq.legs.map(leg => [leg.symbol, leg]));
  if (quote.sell.length !== legs.size || new Set(quote.sell.map(leg => leg.symbol)).size !== legs.size) return '报价没有恰好覆盖全部腿';
  for (const leg of quote.sell) {
    const wanted = legs.get(leg.symbol);
    if (!wanted) return '报价里有不在询价里的合约';
    if (cmp(leg.qty, wanted.qty) !== 0) return `报价数量与询价不一致（${leg.symbol}）`;
    if (!(leg.price > 0)) return `报价价格无效（${leg.symbol}）`;
  }
  return null;
}

export interface ChainPrice { bid: number; ask: number; mark: number }
export interface QuoteLegView { symbol: string; side: Side; qty: string; price: number | null; chain: number | null; diff: number | null }
export interface QuoteView {
  quoteId: string; deskCode: string; status: string; expiresAt: number; covered: number; total: number;
  /** In the RFQ's directions: + premium received, − premium paid; null unless every leg is quoted. */
  netUsd: number | null; chainNetUsd: number | null; diffUsd: number | null; feeUsd: number | null; legs: QuoteLegView[]; problem: string | null;
}
/** The chain price a leg would trade at on the book: the bid for a sale, the ask for a purchase, else the mark. */
export const chainFor = (side: Side, price: ChainPrice | undefined): number | null => price ? (side === 'Sell' ? price.bid : price.ask) || price.mark || null : null;

/** A quote against the chain and the estimated taker fee (same formula as the desk's net estimate). */
export function quoteView(rfq: RfqRecord, quote: RfqQuote, chain: ReadonlyMap<string, ChainPrice>, at: number): QuoteView {
  const priced = new Map(quote.sell.map(leg => [leg.symbol, leg]));
  const legs = rfq.legs.map(leg => {
    const sign = leg.side === 'Sell' ? 1 : -1, price = priced.get(leg.symbol)?.price ?? null, reference = chainFor(leg.side, chain.get(leg.symbol));
    return { symbol: leg.symbol, side: leg.side, qty: leg.qty, price, chain: reference, diff: price !== null && reference !== null ? sign * (price - reference) * Number(leg.qty) : null };
  });
  const covered = legs.filter(leg => leg.price !== null).length, complete = covered === legs.length;
  const sum = (value: (leg: QuoteLegView) => number | null) => legs.some(leg => value(leg) === null) ? null : legs.reduce((total, leg) => total + value(leg)!, 0);
  const sign = (leg: QuoteLegView) => leg.side === 'Sell' ? 1 : -1;
  const netUsd = complete ? sum(leg => sign(leg) * leg.price! * Number(leg.qty)) : null;
  const chainNetUsd = sum(leg => leg.chain === null ? null : sign(leg) * leg.chain * Number(leg.qty));
  const { index, feeRate, feeCapPct } = rfq.feeContext;
  const feeUsd = complete ? legs.reduce((total, leg) => total + Math.min(feeRate * index, feeCapPct * leg.price!) * Number(leg.qty), 0) : null;
  return {
    quoteId: quote.quoteId, deskCode: quote.deskCode, status: quote.status, expiresAt: quote.expiresAt, covered, total: legs.length,
    netUsd, chainNetUsd, diffUsd: netUsd !== null && chainNetUsd !== null ? netUsd - chainNetUsd : null, feeUsd, legs, problem: quoteProblem(rfq, quote, at),
  };
}
/** Full quotes first, then partial ones, each by the premium received. */
export const sortQuotes = (quotes: QuoteView[]): QuoteView[] => [...quotes].sort((a, b) => Number(b.covered === b.total) - Number(a.covered === a.total) || Number(b.covered > 0) - Number(a.covered > 0) || (b.netUsd ?? -Infinity) - (a.netUsd ?? -Infinity));

/** The venue's iron-condor combination when it lists one; anything else is a custom RFQ (as the workbench). */
export function strategyTypeFor(mode: StrategyMode, config: Row): string {
  if (mode !== 'iron_condor' || !Array.isArray(config.strategyTypes)) return 'custom';
  for (const item of config.strategyTypes as Row[]) {
    const name = item?.strategyName;
    if (typeof name === 'string' && name.replace(/[\s_]/g, '').toLowerCase().includes('ironcondor')) return name;
  }
  return 'custom';
}
/** Every market maker the venue lists for this account, at most its maxLP. */
export function counterpartiesFrom(config: Row): string[] {
  const desks = Array.isArray(config.counterparties) ? (config.counterparties as Row[]).map(item => item?.deskCode).filter((code): code is string => typeof code === 'string' && /^[\w-]{1,64}$/.test(code)) : [];
  const unique = [...new Set(desks)], limit = Number(config.maxLP);
  const chosen = Number.isSafeInteger(limit) && limit > 0 ? unique.slice(0, limit) : unique;
  if (!chosen.length) throw new Error('Bybit 没有为该账户列出可询价的做市商');
  return chosen;
}

/**
 * The filled trade's leg order ids, once the trade history shows every leg of the RFQ filled at its quantity. null
 * while the history has not caught up; a filled trade that does not match the RFQ throws. The leg's side is not compared:
 * whether the trade list reports it from our side or the quoter's is not confirmed live (the symbol and quantity are).
 */
export function filledOrders(rfq: RfqRecord, rows: readonly Row[]): Record<string, { orderId: string; price: number }> | null {
  const trade = rows.find(row => row.rfqId === rfq.rfqId && row.status === 'Filled');
  if (!trade) return null;
  if (!Array.isArray(trade.legs)) throw new Error('询价成交记录缺少腿');
  const result: Record<string, { orderId: string; price: number }> = {};
  for (const leg of rfq.legs) {
    const match = (trade.legs as Row[]).filter(item => item?.symbol === leg.symbol);
    if (match.length !== 1) throw new Error(`询价成交记录与询价的腿不一致（${leg.symbol}）`);
    const item = match[0]!;
    let qty: string;
    try { qty = decimal(item.qty, 'positive'); } catch { throw new Error(`询价成交数量无效（${leg.symbol}）`); }
    if (cmp(qty, leg.qty) !== 0 || Number(item.resultCode ?? 0) !== 0 || typeof item.orderId !== 'string' || !item.orderId) throw new Error(`询价成交的数量或结果与询价不一致（${leg.symbol}）`);
    result[leg.symbol] = { orderId: item.orderId, price: Number(item.price) };
  }
  if ((trade.legs as Row[]).length !== rfq.legs.length) throw new Error('询价成交记录的腿数与询价不一致');
  return result;
}
