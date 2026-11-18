// Reads the public market service's monitor readers have in common. The oil card, the Anthropic card and the multi-exchange
// comparison each read for themselves, and the spread collector already receives Binance marks over its sockets; inside one
// process these overlap. Here:
// - Binance fundingInfo is read once per 15 s for whoever asks (the oil card and the comparison's Binance row);
// - Hyperliquid's xyz metaAndAssetCtxs reply is kept with its receipt time, and each caller says how old a reply it accepts
//   (the comparison 5 s, the Anthropic card 2 s because it dates its quote by the time it asked);
// - Binance marks come from the collector's `!markPrice@arr` rows when both the mark and its funding fields arrived in the
//   same event no more than 6 s ago, shaped like a premiumIndex reply. Otherwise the caller reads premiumIndex as before:
//   the collector only runs while a page watches the spread table.
// One request is in flight per key, a failure is not kept, and nothing here runs in the background.
import type { BinanceGate } from '../vendor/anthropic-market.mjs';
import type { PerpetualQuote } from '../vendor/perpetual-stream.mjs';
import { boundedReply, BinanceCooldown } from './market-contract.ts';

export const HYPERLIQUID_INFO = 'https://api.hyperliquid.xyz/info';
export const XYZ_CONTEXTS_BODY = JSON.stringify({ type: 'metaAndAssetCtxs', dex: 'xyz' });
export const FUNDING_INFO_TTL_MS = 15_000, COLLECTED_MARK_MAX_AGE_MS = 6_000;
const REQUEST_TIMEOUT_MS = 10_000;

export interface SharedMarketReads {
  /** The Binance fundingInfo list, read at most 15 s ago. */
  fundingInfo(): Promise<unknown[]>;
  /** Hyperliquid xyz metaAndAssetCtxs, received at most `maxAgeMs` ago. A refused read rejects with the HTTP `status`. */
  xyzContexts(maxAgeMs: number): Promise<{ reply: unknown; receivedAt: number }>;
  /** premiumIndex-shaped rows of these Binance symbols from the collector, or null unless every one is current and whole. */
  binanceMarks(symbols: readonly string[]): unknown[] | null;
}

export function createSharedMarketReads({ fetchImpl = fetch, now = Date.now, gate, quote, signal }: {
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>; now?: () => number; gate: BinanceGate;
  quote: (exchange: string, symbol: string) => PerpetualQuote | undefined; signal: AbortSignal;
}): SharedMarketReads {
  const kept = new Map<string, { value: unknown; at: number }>(), pending = new Map<string, Promise<unknown>>();
  async function request(url: string, init: RequestInit = {}): Promise<unknown> {
    const binance = new URL(url).hostname === 'fapi.binance.com';
    if (binance && now() < gate.until) throw new BinanceCooldown(gate.status);
    const response = boundedReply(await fetchImpl(url, { ...init, cache: 'no-store', signal: AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), signal]) }));
    if (binance && (response.status === 429 || response.status === 418)) {
      gate.until = Math.max(gate.until, now() + (response.status === 418 ? 120_000 : 60_000)); gate.status = response.status;
    }
    if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw Object.assign(new Error(`Exchange market HTTP ${response.status}`), { status: response.status }); }
    return response.json();
  }
  function shared<T>(key: string, maxAgeMs: number, load: () => Promise<T>): Promise<T> {
    const previous = kept.get(key), time = now();
    if (previous && time >= previous.at && time - previous.at < maxAgeMs) return Promise.resolve(previous.value as T);
    let operation = pending.get(key) as Promise<T> | undefined;
    if (!operation) {
      operation = Promise.resolve().then(load).then(value => { kept.set(key, { value, at: now() }); return value; }).finally(() => pending.delete(key));
      pending.set(key, operation);
    }
    return operation;
  }
  return {
    fundingInfo: () => shared('binance/funding', FUNDING_INFO_TTL_MS, async () => {
      const reply = await request('https://fapi.binance.com/fapi/v1/fundingInfo');
      if (!Array.isArray(reply)) throw new Error('Invalid fundingInfo');
      return reply as unknown[];
    }),
    xyzContexts: maxAgeMs => shared('hyperliquid/xyz', maxAgeMs, async () => ({
      reply: await request(HYPERLIQUID_INFO, { method: 'POST', headers: { 'content-type': 'application/json' }, body: XYZ_CONTEXTS_BODY }),
      receivedAt: now(),
    })),
    binanceMarks(symbols) {
      // During a cooldown the readers keep answering as they do without the collector.
      const time = now();
      if (time < gate.until) return null;
      const rows: unknown[] = [];
      for (const symbol of symbols) {
        const item = quote('binance', symbol), at = item?.markAt;
        if (!item || (item.multiplier ?? 1) !== 1 || typeof at !== 'number' || !Number.isSafeInteger(at) || at > time || time - at > COLLECTED_MARK_MAX_AGE_MS) return null;
        if (typeof item.mark !== 'number' || item.fundingRate === null || item.nextFundingAt === null || item.fundingAt !== at || item.nextFundingAtUpdatedAt !== at) return null;
        rows.push({ symbol, time: at, markPrice: item.mark, lastFundingRate: item.fundingRate, nextFundingTime: item.nextFundingAt });
      }
      return rows;
    },
  };
}
