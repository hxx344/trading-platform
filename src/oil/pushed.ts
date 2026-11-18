// O7 (docs/oil.md section 12): the oil and hynix book readers take a leg's best bid and ask from the market monitor's perpetual
// collector (public WebSockets, src/monitor/perpetual.ts) when it has a recent one, and read the venue over REST otherwise.
// This file maps a venue and contract to the collector's key and decides whether its book can stand in for a REST read.
import type { Venue } from '../contracts.ts';
import { INSTRUMENT_IDS } from '../live/instrument-ids.ts';
import { QUOTE_FUTURE_MS } from './rules.ts';

/** A pushed book is used only while its venue time is at most this old (one read round); older legs are read over REST. */
export const PUSHED_MAX_AGE_MS = 3_000;

/** What the collector holds for one contract (PerpetualMonitor.book). */
export interface CollectorBook { bid: number; ask: number; at: number; multiplier: number }
export interface CollectorBooks { book(exchange: string, symbol: string): CollectorBook | null }
/** A usable pushed book: decimal strings and the venue time. */
export interface PushedBook { bid: string; ask: string; at: number }
/** The book readers' source; null when the collector is not configured (or not open). */
export type PushedBooks = (venue: Venue, symbol: string) => PushedBook | null;

/** The collector's symbol for a contract: OKX lists instrument ids, Binance and Bybit the contract name itself. */
export function collectorSymbol(venue: Venue, symbol: string): string | null {
  return venue === 'okx' ? INSTRUMENT_IDS[symbol] ?? null : symbol;
}

/** A positive price as a plain decimal string; exponent notation (a number this code never expects) is refused. */
function price(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const text = String(value);
  return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text) && text !== '0' ? text : null;
}

/**
 * The collector's book for this leg when it can replace a REST read now: both sides present and ordered (bid < ask), prices
 * per contract (multiplier 1), and the venue time no older than PUSHED_MAX_AGE_MS nor more than the rules' QUOTE_FUTURE_MS ahead (defensive: the
 * collector already clamps its book time to the local receive time).
 */
export function pushedBook(collector: CollectorBooks | null, venue: Venue, symbol: string, now: number): PushedBook | null {
  const key = collector ? collectorSymbol(venue, symbol) : null;
  const book = key ? collector!.book(venue, key) : null;
  if (!book || book.multiplier !== 1 || !(book.bid < book.ask)) return null;
  if (!Number.isFinite(book.at) || now - book.at > PUSHED_MAX_AGE_MS || book.at - now > QUOTE_FUTURE_MS) return null;
  const bid = price(book.bid), ask = price(book.ask);
  return bid && ask ? { bid, ask, at: book.at } : null;
}

/** The readers' source over a collector that may be opened (or not) after them. */
export function pushedBooks(collector: () => CollectorBooks | null, now: () => number): PushedBooks {
  return (venue, symbol) => pushedBook(collector(), venue, symbol, now());
}
