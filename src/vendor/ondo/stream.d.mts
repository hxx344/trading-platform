// Types for stream.mjs, only what the service's TypeScript uses.
/** One depth snapshot in exact units (decimal × 10^18), bids and asks best first. */
export interface OndoBook { time: number; bids: [bigint, bigint][]; asks: [bigint, bigint][] }
export function parseOndoBook(row: unknown): OndoBook | null;
export interface OndoStreamStatus { connected: boolean; publicReady: boolean; privateReady: boolean; lastFrameAt: number | null; error: string | null }
export interface OndoStream { start(): void; status(): OndoStreamStatus; close(): void }
export interface OndoStreamOptions {
  markets: string[];
  credentials?: unknown;
  /** Levels per side asked for. */
  depth?: number;
  /** A book, or null when it was malformed or crossed; `at` is when the frame arrived. */
  onBook(market: string, book: OndoBook | null, at: number): void;
  onPrivate?(channel: string, data: unknown): void;
  onDown?(reason: string): void;
  WebSocketImpl?: unknown;
  now?: () => number;
}
export type OndoStreamFactory = (options: OndoStreamOptions) => OndoStream;
export const createOndoStream: OndoStreamFactory;
