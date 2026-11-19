// Public price reads shared between the ledger's sources. Every source prices its balances for itself (CoinGecko, then
// Coinbase; Bybit spot for other coins), so one sync used to ask the same public address several times. Here a plain GET
// of one of those addresses is sent once and its answer handed to every caller that asks while it is in flight or within
// 30 s of its receipt, including a following sync round. Only usable public observations are kept; a failure reaches the callers waiting for
// it and the next caller asks again. Requests that carry a body or any header besides Accept are never shared.
import type { Fetcher, Json } from './http.ts';

const SHARED = [
  /^https:\/\/api\.coingecko\.com\/api\/v3\/simple\/price\?[\w,=&-]{1,200}$/,
  /^https:\/\/api\.coinbase\.com\/v2\/exchange-rates\?currency=[A-Z]{1,10}$/,
  /^https:\/\/api\.bybit\.com\/v5\/market\/tickers\?category=spot&symbol=[A-Z0-9]{1,24}$/,
  /^https:\/\/api\.frankfurter\.dev\/v2\/rate\/USD\/CNY\?providers=ecb$/,
];
const MAX_BYTES = 2 * 1024 * 1024, MAX_AGE_MS = 30_000, TIMEOUT_MS = 12_000;
const MAX_ENTRIES = 64, MAX_RETAINED_BYTES = 128 * 1024;
type Answer = { status: number; contentType: string | null; bytes: Uint8Array | null };
type Entry = { answer: Promise<Answer>; keptAt: number | null; until: number };
const receipts = new WeakMap<Response, number>();
/** Providers without a quote timestamp use the actual retrieval time, including when this Response is a cached copy. */
export const priceReceivedAt = (response: Response, fallback = Date.now()) => receipts.get(response) ?? fallback;

/** Older Bybit responses omit symbol. An explicitly named ticker must match the exact request. */
export function bybitSpotTicker(data: Json, symbol: string): Json | null {
  const row = data?.result?.list?.[0];
  return data?.retCode === 0 && row && (row.symbol === undefined || row.symbol === symbol) ? row : null;
}

// A 2xx can contain a venue error, a partial quote or a source time about to expire. Return the original
// response to its current callers for their normal validation, but only reuse complete positive observations.
function usableUntil(input: string, bytes: Uint8Array, receivedAt: number): number {
  const positive = (value: unknown) => (typeof value === 'number' || typeof value === 'string' && value.trim() !== '') && Number.isFinite(Number(value)) && Number(value) > 0;
  const deadline = receivedAt + MAX_AGE_MS;
  const quoteDeadline = (at: unknown) => typeof at === 'number' && Number.isSafeInteger(at) && at > 0 && at <= receivedAt + 60_000 ? Math.min(deadline, at + 900_000) : 0;
  try {
    const url = new URL(input), body = JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8'));
    if (url.hostname === 'api.bybit.com') {
      if (!positive(bybitSpotTicker(body, url.searchParams.get('symbol')!)?.lastPrice)) return 0;
      return body.time === undefined ? deadline : quoteDeadline(Number(body.time));
    }
    if (url.hostname === 'api.coingecko.com') {
      const ids = url.searchParams.get('ids')?.split(',') ?? [];
      if (!ids.length || !ids.every(id => typeof body[id]?.usd === 'number' && positive(body[id].usd) && typeof body[id]?.last_updated_at === 'number')) return 0;
      return Math.min(...ids.map(id => quoteDeadline(Number(body[id].last_updated_at) * 1000)));
    }
    if (url.hostname === 'api.coinbase.com') {
      const currency = url.searchParams.get('currency');
      if (body.data?.currency !== currency) return 0;
      const rates = body.data.rates;
      if (currency === 'USD') return ['USDC', 'USDT', 'VIRTUAL', 'CNY'].every(coin => positive(rates?.[coin])) && Number(rates.CNY) <= 1000 ? deadline : 0;
      return typeof rates?.USD === 'string' && rates.USD.length <= 64 && /^\d+(?:\.\d+)?$/.test(rates.USD) && positive(rates.USD) ? deadline : 0;
    }
    if (body.base !== 'USD' || body.quote !== 'CNY' || !positive(body.rate) || Number(body.rate) > 1000 || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) return 0;
    const at = Date.parse(body.date + 'T00:00:00Z');
    return at <= receivedAt && new Date(at).toISOString().startsWith(body.date) ? Math.min(deadline, at + 7 * 86_400_000) : 0;
  } catch { return 0; }
}

function plainGet(init: RequestInit | undefined): boolean {
  if (!init) return true;
  if ((init.method ?? 'GET') !== 'GET' || init.body != null || init.credentials === 'include' || init.integrity) return false;
  for (const [name, value] of new Headers(init.headers)) if (name !== 'accept' || value !== 'application/json') return false;
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
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const stop = (): void => reject(signal.reason);
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
    if (signal.aborted) return stop();
    signal.addEventListener('abort', stop, { once: true });
  });
}

export function sharePublicReads(fetcher: Fetcher, now: () => number = Date.now): { fetcher: Fetcher; reset(): void } {
  const entries = new Map<string, Entry>();
  const shared = (async (input: Parameters<Fetcher>[0], init?: RequestInit): Promise<Response> => {
    if (typeof input !== 'string' || !plainGet(init) || !SHARED.some(pattern => pattern.test(input))) return fetcher(input, init);
    let entry = entries.get(input);
    const time = now();
    if (!entry || (entry.keptAt !== null && (time < entry.keptAt || time >= entry.until))) {
      if (entry) entries.delete(input);
      if (entries.size >= MAX_ENTRIES) {
        const first = [...entries].find(([, item]) => item.keptAt !== null);
        if (!first) return fetcher(input, init);
        entries.delete(first[0]);
      }
      const created: Entry = { answer: load(fetcher, input), keptAt: null, until: 0 };
      const drop = (): void => { if (entries.get(input) === created) entries.delete(input); };
      created.answer.then(answer => {
        if (!answer.bytes) { drop(); return; }
        created.keptAt = now();
        const type = answer.contentType?.split(';', 1)[0]?.trim().toLowerCase();
        if ((!type || type === 'application/json' || /^application\/[a-z0-9.+-]+\+json$/.test(type)) && answer.bytes.length <= MAX_RETAINED_BYTES) created.until = usableUntil(input, answer.bytes, created.keptAt);
        if (created.until <= created.keptAt) drop();
      }, drop);
      entries.set(input, created);
      entry = created;
    }
    const answer = await untilAborted(entry.answer, init?.signal);
    const response = new Response(answer.bytes, { status: answer.status, headers: answer.contentType ? { 'content-type': answer.contentType } : {} });
    if (entry.keptAt !== null) receipts.set(response, entry.keptAt);
    return response;
  }) as Fetcher;
  return { fetcher: shared, reset: () => entries.clear() };
}
