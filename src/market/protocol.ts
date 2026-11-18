// Private, versioned market-data protocol. Only local systemd service accounts can connect to its socket.
export const MARKET_PATH = '/market/v1/';
export const INSTANCE_HEADER = 'x-market-instance';
export const HEARTBEAT_MS = 5_000;
export const STREAM_TIMEOUT_MS = 15_000;
export const RPC_TIMEOUT_MS = 120_000;
export const INPUT_LIMIT = 2 * 1024 * 1024;
export const OUTPUT_LIMIT = 32 * 1024 * 1024;
export const FRAME_LIMIT = 4 * 1024 * 1024;
export const OPERATION_NAME = /^[a-z][a-zA-Z0-9.-]{0,95}$/;

export interface MarketOperations {
  call(op: string, input: unknown, signal: AbortSignal): Promise<unknown>;
  stream(op: string, input: unknown, emit: (value: unknown) => void, signal: AbortSignal): void | Promise<void>;
  close?(): void;
}

export class MarketError extends Error {
  readonly status: number;
  constructor(message: string, status = 503) { super(message); this.status = status; }
}
