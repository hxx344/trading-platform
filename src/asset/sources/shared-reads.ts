// Public price reads shared between the ledger's sources. Every source prices its balances for itself (CoinGecko, then
// Coinbase; Bybit spot for other coins), so one sync used to ask the same public address several times. Here a plain GET
// of one of those addresses is sent once and its answer handed to every caller that asks while it is in flight or within
// the same sync round (at most 30 s). Only an answer with a 2xx status is kept; a failure reaches the callers waiting for
// it and the next caller asks again. Requests that carry a body or any header besides Accept are never shared.
import type { Fetcher } from './http.ts';

const SHARED = [
  /^https:\/\/api\.coingecko\.com\/api\/v3\/simple\/price\?[\w,=&-]{1,200}$/,
  /^https:\/\/api\.coinbase\.com\/v2\/exchange-rates\?currency=[A-Z]{1,10}$/,
  /^https:\/\/api\.bybit\.com\/v5\/market\/tickers\?category=spot&symbol=[A-Z0-9]{1,24}$/,
];
const MAX_BYTES = 2 * 1024 * 1024, MAX_AGE_MS = 30_000, TIMEOUT_MS = 12_000;
type Answer = { status: number; contentType: string | null; bytes: Uint8Array | null };
type Entry = { answer: Promise<Answer>; keptAt: number | null };

function plainGet(init: RequestInit | undefined): boolean {
  if (!init) return true;
  if ((init.method ?? 'GET') !== 'GET' || (init.body !== undefined && init.body !== null)) return false;
  for (const [name] of new Headers(init.headers)) if (name !== 'accept') return false;
  return true;
}

async function load(fetcher: Fetcher, url: string): Promise<Answer> {
  const response = await fetcher(url, { method: 'GET', headers: { Accept: 'application/json' }, redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
  const contentType = response.headers.get('content-type');
  if (!response.ok || response.redirected || !response.body) {
    void response.body?.cancel().catch(() => {});
    return { status: response.redirected ? 502 : response.status, contentType, bytes: null };
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > MAX_BYTES) { void reader.cancel().catch(() => {}); throw new Error('公开行情应答超过 2MB 上限'); }
    chunks.push(chunk.value);
  }
  return { status: response.status, contentType, bytes: Buffer.concat(chunks, size) };
}

/** Waits for the shared read, but no longer than the caller's own signal allows; it fails the way fetch does. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const stop = (): void => reject(signal.reason);
    if (signal.aborted) return stop();
    signal.addEventListener('abort', stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

export function sharePublicReads(fetcher: Fetcher, now: () => number = Date.now): { fetcher: Fetcher; reset(): void } {
  const entries = new Map<string, Entry>();
  const shared = (async (input: Parameters<Fetcher>[0], init?: RequestInit): Promise<Response> => {
    if (typeof input !== 'string' || !plainGet(init) || !SHARED.some(pattern => pattern.test(input))) return fetcher(input, init);
    let entry = entries.get(input);
    const time = now();
    if (!entry || (entry.keptAt !== null && (time < entry.keptAt || time - entry.keptAt >= MAX_AGE_MS))) {
      const created: Entry = { answer: load(fetcher, input), keptAt: null };
      const drop = (): void => { if (entries.get(input) === created) entries.delete(input); };
      created.answer.then(answer => { if (answer.bytes) created.keptAt = now(); else drop(); }, drop);
      entries.set(input, created);
      entry = created;
    }
    const answer = await untilAborted(entry.answer, init?.signal);
    return new Response(answer.bytes, { status: answer.status, headers: answer.contentType ? { 'content-type': answer.contentType } : {} });
  }) as Fetcher;
  return { fetcher: shared, reset: () => entries.clear() };
}
