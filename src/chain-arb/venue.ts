import { anySignal } from '../any-signal.mjs';
import { untilAborted } from '../asset/sources/shared-reads.ts';
import { readJsonResponse } from '../vendor/response.mjs';
import type { ScanCandidate } from './catalog.ts';
import type { GateLeg } from './gate.ts';
import type { ChainArbInput } from './model.ts';

export type VenueFetch = (url: string, init: RequestInit) => Promise<Response>;
export interface VenueReaderOptions { fetchImpl: VenueFetch; now: () => number }
export interface VenueBook { deposit: boolean | null; withdraw: boolean | null; minDeposit?: string; spot: GateLeg; perp: GateLeg }
export interface VenueReader {
  close?(): void;
  catalog(signal: AbortSignal): Promise<ScanCandidate[]>;
  read(input: ChainArbInput, signal: AbortSignal, reuseMetadata?: boolean): Promise<VenueBook>;
}

/** The transport timestamp bounds the response age; the adapter separately checks the book's source timestamp. */
export async function readVenueJson(fetchImpl: VenueFetch, url: string, signal: AbortSignal, maxBytes = 5 * 1024 * 1024,
  maxAgeMs = 300_000, now = Date.now): Promise<{ body: unknown; at: number }> {
  const start = now();
  const response = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json' }, redirect: 'error', cache: 'no-store', signal });
  const age = response.headers.get('age') ?? '0', date = response.headers.get('date');
  const at = Math.min(start - Number(age) * 1000, date === null ? start : Date.parse(date));
  if (response.status !== 200 || response.headers.has('content-range') || !/^\d+$/.test(age) || !Number.isFinite(at)
    || (date !== null && Date.parse(date) > now() + 2000) || now() - at >= maxAgeMs) {
    void response.body?.cancel().catch(() => {});
    throw Object.assign(new Error(response.status === 200 ? '行情应答已过期或不完整' : '公开行情读取失败（HTTP ' + response.status + '）'),
      { status: response.status === 429 || response.status === 418 ? 429 : 502 });
  }
  const body = await readJsonResponse(response, { signal, maxBytes, reviver(_key, value, context) {
    if (typeof value === 'number' && context?.source && (!Number.isSafeInteger(value) || /[.eE]/.test(context.source))) return context.source;
    return value;
  } });
  signal.throwIfAborted();
  if (now() - at >= maxAgeMs) throw new Error('行情应答已过期');
  return { body, at };
}

/** Share one bounded in-flight catalogue across the scanner and single-coin reviews. */
export function createVenueCatalog<T>(load: (signal: AbortSignal) => Promise<T>, now = Date.now, ttlMs = 300_000,
  validUntil?: (value: T) => number) {
  let cached: { value: T; start: number; expires: number } | undefined;
  let pending: { controller: AbortController; work: Promise<T>; readers: number } | undefined;
  return async (signal: AbortSignal): Promise<T> => {
    signal.throwIfAborted();
    const start = now();
    if (cached && start >= cached.start && start < cached.expires) return cached.value;
    if (!pending || pending.controller.signal.aborted) {
      const controller = new AbortController();
      const life = anySignal([controller.signal], 12_000);
      const work = untilAborted(load(life), life).then(value => {
        life.throwIfAborted();
        const expires = Math.min(start + ttlMs, validUntil?.(value) ?? Infinity);
        if (!Number.isFinite(expires) || now() < start || now() >= expires) throw new Error('交易所目录已过期');
        cached = { value, start, expires };
        return value;
      });
      pending = { controller, work, readers: 0 };
    }
    const job = pending;
    job.readers++;
    try { return await untilAborted(job.work, signal); }
    finally {
      if (--job.readers === 0) {
        job.controller.abort();
        if (pending === job) pending = undefined;
      }
    }
  };
}
