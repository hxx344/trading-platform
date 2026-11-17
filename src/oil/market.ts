// Oil market and position display for the service page. Reads only: the books of BZUSDT and CLUSDT on each configured
// venue every few seconds and the configured accounts' oil positions a little less often. Nothing here feeds a preview or a
// send (those read their own books); a failed read keeps the last good value and says when it was read and when it failed.
// O7: a leg whose book the market monitor's collector pushed within the last round is taken from there (src/oil/pushed.ts);
// the other legs are read over REST as before. Each book says which (`source`).
import { sub } from '../decimal.ts';
import { OIL_SYMBOLS, VENUES, VENUE_NAMES, accountKey, parseAccountSnapshot, parseQuote, positionOf, type AccountBinding, type Venue } from '../contracts.ts';
import type { VenueConnector } from '../connector.ts';
import type { PushedBook, PushedBooks } from './pushed.ts';

/** Book read spacing and the timeout of one read; a read is never retried, the next round reads again. */
export const MARKET_READ_MS = 3_000;
export const MARKET_TIMEOUT_MS = 3_000;
/** Account reads are several signed calls per contract, so they get more time and run less often. */
export const POSITIONS_READ_MS = 15_000;
export const POSITIONS_TIMEOUT_MS = 10_000;

const BZ = 'BZUSDT', CL = 'CLUSDT';
/** `receivedAt` is this host's receive time for a REST read and the venue's book time for a pushed one (`source`). */
export type BookSource = 'pushed' | 'rest';
export interface BookSlot { bid: string | null; ask: string | null; receivedAt: number | null; source: BookSource | null; failedAt: number | null; error: string | null }
interface PositionSlot { long: Record<string, string> | null; short: Record<string, string> | null; openOrders: number | null; receivedAt: number | null; failedAt: number | null; error: string | null }

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
  /** O7: the market monitor's pushed books; without it (or without a usable book for a leg) every leg is read over REST. */
  pushed?: PushedBooks;
}

export interface MarketReaderOptions extends OilMarketOptions { symbols: readonly string[] }

/**
 * The books of these contracts on each configured venue and the accounts' positions in them, read on demand; a failed read
 * keeps the last good value. The oil and hynix views build their spreads on it.
 */
export function createMarketReader({ connectors, accounts, symbols, now = Date.now, quoteTimeoutMs = MARKET_TIMEOUT_MS, positionsTimeoutMs = POSITIONS_TIMEOUT_MS, pushed }: MarketReaderOptions) {
  const venues = connectors.map(connector => connector.venue);
  const books = new Map<string, BookSlot>();
  const slot = (venue: Venue, symbol: string): BookSlot => {
    const key = `${venue}:${symbol}`;
    let found = books.get(key);
    if (!found) { found = { bid: null, ask: null, receivedAt: null, source: null, failedAt: null, error: null }; books.set(key, found); }
    return found;
  };
  const positions = new Map<string, PositionSlot>(accounts.map(account => [accountKey(account), { long: null, short: null, openOrders: null, receivedAt: null, failedAt: null, error: null }]));
  let quotesReadAt: number | null = null, positionsReadAt: number | null = null;

  async function refreshQuotes(): Promise<void> {
    await Promise.all(connectors.flatMap(connector => symbols.map(async symbol => {
      const target = slot(connector.venue, symbol);
      // A pushed book never moves a leg back in time, nor lands before the leg's last failed read: both are host times (a REST
      // read may have landed after the venue time of the pushed book), and the page reads a failure as failedAt > receivedAt.
      // A failing lookup counts as no pushed book. A failed REST read is dated when it started: a read that times out lands
      // MARKET_TIMEOUT_MS later, and dating it then would leave a pushed book only the half-second gap before the next round.
      let book: PushedBook | null = null;
      try { book = pushed?.(connector.venue, symbol) ?? null; } catch { book = null; }
      if (book && book.at >= Math.max(target.receivedAt ?? -Infinity, target.failedAt ?? -Infinity)) {
        Object.assign(target, { bid: book.bid, ask: book.ask, receivedAt: book.at, source: 'pushed', error: null });
        return;
      }
      const startedAt = now();
      try {
        const quote = parseQuote(await bounded(signal => connector.quote(symbol, { signal }), quoteTimeoutMs), connector.venue, symbol);
        Object.assign(target, { bid: quote.bid, ask: quote.ask, receivedAt: quote.receivedAt, source: 'rest', error: null });
      } catch (error) { Object.assign(target, { failedAt: startedAt, error: message(error) }); }
    })));
    quotesReadAt = now();
  }

  async function refreshPositions(): Promise<void> {
    await Promise.all(accounts.map(async account => {
      const target = positions.get(accountKey(account))!, connector = connectors.find(item => item.venue === account.venue);
      try {
        if (!connector) throw new Error(`${VENUE_NAMES[account.venue]} 连接器不可用`);
        const snapshot = parseAccountSnapshot(await bounded(signal => connector.account(account, symbols, { signal }), positionsTimeoutMs), account.venue);
        if (snapshot.accountId !== account.accountId) throw new Error(`${VENUE_NAMES[account.venue]} 账户真实身份与配置不一致`);
        const side = (which: 'long' | 'short') => Object.fromEntries(symbols.map(symbol => [symbol, positionOf(snapshot, symbol, which)]));
        Object.assign(target, { long: side('long'), short: side('short'), openOrders: snapshot.openOrders.filter(order => symbols.includes(order.symbol)).length, receivedAt: snapshot.receivedAt, error: null });
      } catch (error) { Object.assign(target, { failedAt: now(), error: message(error) }); }
    }));
    positionsReadAt = now();
  }

  /** Account ids masked like every other page view. */
  function positionsView() {
    return {
      readAt: positionsReadAt, readEveryMs: POSITIONS_READ_MS, timeoutMs: positionsTimeoutMs,
      accounts: accounts.map(account => ({ venue: account.venue, accountId: account.accountId.length > 4 ? `***${account.accountId.slice(-4)}` : '***', accountMode: account.accountMode, ...positions.get(accountKey(account))! })),
    };
  }
  const header = () => ({ now: now(), readAt: quotesReadAt, readEveryMs: MARKET_READ_MS, timeoutMs: quoteTimeoutMs });
  const book = (venue: Venue, symbol: string) => ({ venue, symbol, ...slot(venue, symbol) });
  const oldest = (...slots: BookSlot[]): number | null => slots.some(item => item.receivedAt === null) ? null : Math.min(...slots.map(item => item.receivedAt as number));
  /**
   * One contract across every two configured venues, in VENUES order (Binance–Bybit, Binance–OKX, Bybit–OKX):
   * firstOverSecond = first bid − second ask (sell on the first, buy on the second), secondOverFirst the other way.
   */
  const crossExchange = () => {
    const configured = VENUES.filter(venue => venues.includes(venue));
    const pairs = configured.flatMap((first, index) => configured.slice(index + 1).map(second => [first, second] as const));
    const spread = (high: BookSlot, low: BookSlot) => high.bid !== null && low.ask !== null ? sub(high.bid, low.ask) : null;
    return pairs.flatMap(([first, second]) => symbols.map(symbol => {
      const a = slot(first, symbol), b = slot(second, symbol);
      return { symbol, first, second, firstOverSecond: spread(a, b), secondOverFirst: spread(b, a), receivedAt: oldest(a, b) };
    }));
  };
  return { venues, symbols, slot, book, oldest, header, crossExchange, refreshQuotes, refreshPositions, positionsView };
}
export type MarketReader = ReturnType<typeof createMarketReader>;

/**
 * Spreads in USDT per barrel. The live connectors list oil at contract size 1 (notional = quantity × contract size × price),
 * so a price is already per barrel and two prices subtract directly.
 * - same venue, BZ − CL: sell = BZ bid − CL ask (sell BZ, buy CL: what shorting the spread gets), buy = BZ ask − CL bid
 *   (what going long the spread costs).
 * - one contract across every two configured venues: first bid − second ask and second bid − first ask (reader.crossExchange).
 */
export function createOilMarket(options: OilMarketOptions) {
  const reader = createMarketReader({ ...options, symbols: OIL_SYMBOLS });
  const { venues, slot, book, oldest } = reader;
  const spread = (high: BookSlot, low: BookSlot) => high.bid !== null && low.ask !== null ? sub(high.bid, low.ask) : null;
  function view() {
    return {
      ...reader.header(),
      books: venues.flatMap(venue => OIL_SYMBOLS.map(symbol => book(venue, symbol))),
      sameExchange: venues.map(venue => {
        const bz = slot(venue, BZ), cl = slot(venue, CL);
        return { venue, sell: spread(bz, cl), buy: bz.ask !== null && cl.bid !== null ? sub(bz.ask, cl.bid) : null, receivedAt: oldest(bz, cl) };
      }),
      crossExchange: reader.crossExchange(),
    };
  }
  return { refreshQuotes: reader.refreshQuotes, refreshPositions: reader.refreshPositions, view, positionsView: reader.positionsView };
}
export type OilMarket = ReturnType<typeof createOilMarket>;
