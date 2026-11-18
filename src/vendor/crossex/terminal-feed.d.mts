export interface TerminalFeed {
  subscribe(symbol: string, listener: { data(value: unknown): void; down(): void }): () => void;
  close(): void;
}
export function createTerminalFeed(options?: { WebSocketImpl?: unknown; clock?: () => number }): TerminalFeed;
