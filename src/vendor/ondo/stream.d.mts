// Types for stream.mjs, only what the service's TypeScript uses.
/** One depth snapshot in exact units (decimal × 10^18), bids and asks best first. */
export interface OndoBook { time: number; bids: [bigint, bigint][]; asks: [bigint, bigint][] }
export interface OndoPublicTrade { id: string; time: number; price: bigint; aggressorSide: 'buy' | 'sell' }
export function parseOndoBook(row: unknown): OndoBook | null;
export interface OndoStreamStatus { connected: boolean; publicReady: boolean; privateReady: boolean; deadManReady?: boolean; lastFrameAt: number | null; error: string | null }
export interface OndoStream { start(): void; status(): OndoStreamStatus; close(): void; expireOrders?(confirmedClear: () => boolean): void }
export interface OndoStreamOptions {
  markets: string[];
  credentials?: unknown;
  latency?: import('./latency.mjs').OndoLatencyObserver;
  heartbeatAllowed?: () => boolean;
  /** Levels per side asked for. */
  depth?: number;
  /** A book, or null when it was malformed or crossed; `at` is when the frame arrived. */
  onBook(market: string, book: OndoBook | null, at: number): void;
  /** Enables the live-only public tape on a connection without credentials. Price uses the book's fixed-point units. */
  onTrade?(market: string, trade: OndoPublicTrade, at: number): void;
  onPrivate?(channel: string, data: unknown): void;
  onDown?(reason: string): void;
  WebSocketImpl?: unknown;
  now?: () => number;
}
export type OndoStreamFactory = (options: OndoStreamOptions) => OndoStream;
export const createOndoStream: OndoStreamFactory;
export interface OndoTopStream { start(): void; status(): { connected: boolean; ready: boolean; lastFrameAt: number | null; error: string | null }; close(): void }
export interface OndoTopStreamOptions {
  markets: string[];
  /** Best bid and ask only, or null when the row was malformed or crossed; `at` is when the frame arrived. */
  onTop(market: string, top: OndoBook | null, at: number): void;
  /** true once the subscription has stayed confirmed for ten seconds, false when such a one is lost. */
  onState?(ready: boolean): void;
  WebSocketImpl?: unknown;
  now?: () => number;
}
export type OndoTopStreamFactory = (options: OndoTopStreamOptions) => OndoTopStream;
export const createOndoTopStream: OndoTopStreamFactory;
