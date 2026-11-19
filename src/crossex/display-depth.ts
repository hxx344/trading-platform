// Depth for display only: the open-capacity estimate and the terminal's book read the same contracts' depth again and again
// (every tab's capacity poll every 1–5 s, the terminal up to once per 1.5 s per contract). Those two share one read per
// contract here: callers arriving while it is in flight wait for it, and its book serves others for at most one second, with
// the venue's own source time left on it, so every freshness check downstream still sees the true age. Previews and the
// checks before an order is sent do not come through here: they read their own depth (LESSONS L100).
import { contractIdentity } from '../vendor/crossex/model.mjs';

type Quote = Record<string, unknown>;
type Book = Record<string, unknown> & { isCurrent?: () => boolean };
export type DepthReader = ((quote: Quote) => Promise<Book>) & { forMarket?: (quote: Quote, marketIdentity: string) => Promise<Book> };

export const DISPLAY_DEPTH_TTL_MS = 1_000;
const MAX_CONTRACTS = 64;
/** Raw venue readers take only a quote. A sharing reader also accepts the caller's verified directory/native identity. */
export function readDisplayDepth(reader: DepthReader, quote: Quote, marketIdentity: string): Promise<Book> {
  return reader.forMarket ? reader.forMarket(quote, marketIdentity) : reader(quote);
}

/** One sharing reader per underlying reader: consumers given the same reader share its books. */
export function createDisplayDepth({ now = Date.now, ttlMs = DISPLAY_DEPTH_TTL_MS }: { now?: () => number; ttlMs?: number } = {}): (reader: DepthReader) => DepthReader {
  const wrapped = new Map<DepthReader, DepthReader>();
  return reader => {
    let sharing = wrapped.get(reader);
    if (sharing) return sharing;
    const kept = new Map<string, { book: Book; at: number }>(), pending = new Map<string, Promise<Book>>();
    const forMarket = (quote: Quote, key: string) => {
      const time = now(), previous = kept.get(key);
      if (previous && time >= previous.at && time - previous.at < ttlMs && previous.book.isCurrent?.() !== false) return Promise.resolve(previous.book);
      let flight = pending.get(key);
      if (!flight) {
        flight = Promise.resolve().then(() => reader(quote)).then(book => {
          const at = now();
          for (const [name, entry] of kept) if (at - entry.at >= ttlMs || at < entry.at) kept.delete(name);
          if (kept.size < MAX_CONTRACTS) kept.set(key, { book, at });
          return book;
        }).finally(() => pending.delete(key));
        pending.set(key, flight);
      }
      return flight;
    };
    sharing = Object.assign((quote: Quote) => forMarket(quote, contractIdentity(quote)), { forMarket });
    wrapped.set(reader, sharing);
    return sharing;
  };
}
