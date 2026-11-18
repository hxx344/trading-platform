// Serializable results of named public reads. Preserve validated pagination progress and venue backoff on partial failures.
import type { FundamentalsDescription } from '../vendor/perpetual-fundamentals.mjs';
import type { PerpetualMetricsReading } from '../vendor/perpetual-metrics-reader.mjs';
import type { TokenFundamentals } from '../vendor/perpetual-quality.ts';

/** The largest reply read from a venue: a full candle page is well under 1 MiB, and the vendor module only limits Lighter RH itself. */
export const MAX_REPLY_BYTES = 8 * 1024 * 1024;
/** The reply with its body cut off (as a read error) once it passes MAX_REPLY_BYTES, so an oversized answer is never parsed whole by the collector. */
export function boundedReply(response: Response): Response {
  const length = Number(response.headers.get('content-length'));
  if (length > MAX_REPLY_BYTES) { void response.body?.cancel().catch(() => undefined); throw new Error('交易所应答超过大小上限'); }
  if (!response.body) return response;
  let size = 0;
  const counted = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > MAX_REPLY_BYTES) controller.error(new Error('交易所应答超过大小上限'));
      else controller.enqueue(chunk);
    },
  }));
  return new Response(counted, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export class BinanceCooldown extends Error {
  readonly status: number;
  constructor(status: number) { super(`Binance HTTP ${status} cooldown`); this.status = status; }
}

/** At most 1,344 closed 15-minute bars per leg, below one Binance 1,500-row page. */
export const OIL_CANDLE_WINDOW_MS = 14 * 86_400_000;

interface ReadFailure { variational?: true; blocked?: boolean; rejected?: boolean; message: string; name: string; code?: string; status?: number; retryAfterMs?: number; retryAfter?: string }
export type MarketRead<T> = { ok: true; value: T } | { ok: false; error: ReadFailure };
export async function marketRead<T>(run: () => Promise<T>): Promise<MarketRead<T>> {
  try { return { ok: true, value: await run() }; }
  catch (cause) {
    const error = cause as Partial<ReadFailure> | null;
    const name = cause instanceof BinanceCooldown ? 'BinanceCooldown' : cause instanceof Error ? cause.name : 'Error';
    const message = cause instanceof SyntaxError ? 'Invalid market response' : cause instanceof Error ? cause.message.slice(0, 240) : '公开行情暂不可用';
    return { ok: false, error: { name, message, ...(error?.code === 'UNSUPPORTED' ? { code: error.code } : {}),
      ...(error?.variational === true ? { variational: true, blocked: error.blocked === true, rejected: error.rejected === true } : {}),
      ...(Number.isInteger(error?.status) ? { status: error!.status! } : {}), ...(Number.isFinite(error?.retryAfterMs) ? { retryAfterMs: error!.retryAfterMs! } : {}),
      ...(typeof error?.retryAfter === 'string' ? { retryAfter: error.retryAfter.slice(0, 80) } : {}) } };
  }
}
export function unwrapMarketRead<T>(read: MarketRead<T>): T {
  if (read.ok) return read.value;
  if (read.error.name === 'BinanceCooldown') throw new BinanceCooldown(read.error.status ?? 429);
  throw Object.assign(new Error(read.error.message), read.error);
}
export interface MetricBatch { reading: MarketRead<PerpetualMetricsReading>; cached: [string, number][]; retryAt: number }
export interface FundamentalRow { value: TokenFundamentals | null; expiresAt: number; description: FundamentalsDescription }
