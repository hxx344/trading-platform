// Oil market and position display for the service page. Reads only: the books of BZUSDT and CLUSDT on each configured
// venue every few seconds and the configured accounts' oil positions a little less often. Nothing here feeds a preview or a
// send (those read their own books); a failed read keeps the last good value and says when it was read and when it failed.
import { sub } from '../decimal.ts';
import { OIL_SYMBOLS, VENUE_NAMES, accountKey, parseAccountSnapshot, parseQuote, positionOf, type AccountBinding, type Venue } from '../contracts.ts';
import type { VenueConnector } from '../connector.ts';

/** Book read spacing and the timeout of one read; a read is never retried, the next round reads again. */
export const MARKET_READ_MS = 3_000;
export const MARKET_TIMEOUT_MS = 3_000;
/** Account reads are several signed calls per contract, so they get more time and run less often. */
export const POSITIONS_READ_MS = 15_000;
export const POSITIONS_TIMEOUT_MS = 10_000;

const BZ = 'BZUSDT', CL = 'CLUSDT';
type Symbol = typeof OIL_SYMBOLS[number];
interface BookSlot { bid: string | null; ask: string | null; receivedAt: number | null; failedAt: number | null; error: string | null }
interface PositionSlot { long: Record<Symbol, string> | null; short: Record<Symbol, string> | null; openOrders: number | null; receivedAt: number | null; failedAt: number | null; error: string | null }

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 160);
/** One read bounded by its own timer as well as the abort signal, so a connector that ignores the signal cannot hold the round. */
export async function bounded<T>(read: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, fail) => {
    timer = setTimeout(() => { controller.abort(); fail(new Error(`读取超过 ${timeoutMs} 毫秒`)); }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
  });
  try { return await Promise.race([read(controller.signal), deadline]); } finally { clearTimeout(timer); }
}

export interface OilMarketOptions {
  connectors: readonly VenueConnector[];
  accounts: readonly AccountBinding[];
  now?: () => number;
  quoteTimeoutMs?: number;
  positionsTimeoutMs?: number;
}

/**
 * Spreads in USDT per barrel. The live connectors list oil at contract size 1 (notional = quantity × contract size × price),
 * so a price is already per barrel and two prices subtract directly.
 * - same venue, BZ − CL: sell = BZ bid − CL ask (sell BZ, buy CL: what shorting the spread gets), buy = BZ ask − CL bid
 *   (what going long the spread costs).
 * - one contract across venues: Binance bid − Bybit ask and Bybit bid − Binance ask.
 */
export function createOilMarket({ connectors, accounts, now = Date.now, quoteTimeoutMs = MARKET_TIMEOUT_MS, positionsTimeoutMs = POSITIONS_TIMEOUT_MS }: OilMarketOptions) {
  const venues = connectors.map(connector => connector.venue);
  const books = new Map<string, BookSlot>();
  const slot = (venue: Venue, symbol: string): BookSlot => {
    const key = `${venue}:${symbol}`;
    let found = books.get(key);
    if (!found) { found = { bid: null, ask: null, receivedAt: null, failedAt: null, error: null }; books.set(key, found); }
    return found;
  };
  const positions = new Map<string, PositionSlot>(accounts.map(account => [accountKey(account), { long: null, short: null, openOrders: null, receivedAt: null, failedAt: null, error: null }]));
  let quotesReadAt: number | null = null, positionsReadAt: number | null = null;

  async function refreshQuotes(): Promise<void> {
    await Promise.all(connectors.flatMap(connector => OIL_SYMBOLS.map(async symbol => {
      const target = slot(connector.venue, symbol);
      try {
        const quote = parseQuote(await bounded(signal => connector.quote(symbol, { signal }), quoteTimeoutMs), connector.venue, symbol);
        Object.assign(target, { bid: quote.bid, ask: quote.ask, receivedAt: quote.receivedAt, error: null });
      } catch (error) { Object.assign(target, { failedAt: now(), error: message(error) }); }
    })));
    quotesReadAt = now();
  }

  async function refreshPositions(): Promise<void> {
    await Promise.all(accounts.map(async account => {
      const target = positions.get(accountKey(account))!, connector = connectors.find(item => item.venue === account.venue);
      try {
        if (!connector) throw new Error(`${VENUE_NAMES[account.venue]} 连接器不可用`);
        const snapshot = parseAccountSnapshot(await bounded(signal => connector.account(account, OIL_SYMBOLS, { signal }), positionsTimeoutMs), account.venue);
        if (snapshot.accountId !== account.accountId) throw new Error(`${VENUE_NAMES[account.venue]} 账户真实身份与配置不一致`);
        const side = (which: 'long' | 'short') => Object.fromEntries(OIL_SYMBOLS.map(symbol => [symbol, positionOf(snapshot, symbol, which)])) as Record<Symbol, string>;
        Object.assign(target, { long: side('long'), short: side('short'), openOrders: snapshot.openOrders.filter(order => (OIL_SYMBOLS as readonly string[]).includes(order.symbol)).length, receivedAt: snapshot.receivedAt, error: null });
      } catch (error) { Object.assign(target, { failedAt: now(), error: message(error) }); }
    }));
    positionsReadAt = now();
  }

  const spread = (high: BookSlot, low: BookSlot) => high.bid !== null && low.ask !== null ? sub(high.bid, low.ask) : null;
  function view() {
    const book = (venue: Venue, symbol: string) => ({ venue, symbol, ...slot(venue, symbol) });
    const oldest = (...slots: BookSlot[]): number | null => slots.some(item => item.receivedAt === null) ? null : Math.min(...slots.map(item => item.receivedAt as number));
    return {
      now: now(), readAt: quotesReadAt, readEveryMs: MARKET_READ_MS, timeoutMs: quoteTimeoutMs,
      books: venues.flatMap(venue => OIL_SYMBOLS.map(symbol => book(venue, symbol))),
      sameExchange: venues.map(venue => {
        const bz = slot(venue, BZ), cl = slot(venue, CL);
        return { venue, sell: spread(bz, cl), buy: bz.ask !== null && cl.bid !== null ? sub(bz.ask, cl.bid) : null, receivedAt: oldest(bz, cl) };
      }),
      crossExchange: venues.includes('binance') && venues.includes('bybit') ? OIL_SYMBOLS.map(symbol => {
        const binance = slot('binance', symbol), bybit = slot('bybit', symbol);
        return { symbol, binanceOverBybit: spread(binance, bybit), bybitOverBinance: spread(bybit, binance), receivedAt: oldest(binance, bybit) };
      }) : [],
    };
  }
  /** Account ids masked like every other page view. */
  function positionsView() {
    return {
      readAt: positionsReadAt, readEveryMs: POSITIONS_READ_MS, timeoutMs: positionsTimeoutMs,
      accounts: accounts.map(account => ({ venue: account.venue, accountId: account.accountId.length > 4 ? `***${account.accountId.slice(-4)}` : '***', accountMode: account.accountMode, ...positions.get(accountKey(account))! })),
    };
  }
  return { refreshQuotes, refreshPositions, view, positionsView };
}
export type OilMarket = ReturnType<typeof createOilMarket>;
