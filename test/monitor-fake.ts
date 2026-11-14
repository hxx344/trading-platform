// A stand-in for the four public venues the Anthropic monitor reads (Binance, Hyperliquid xyz/io, Lighter RH) and the two
// Binance oil contracts (BZUSDT, CLUSDT) and the Hyperliquid Hynix pair (xyz:SKHY, xyz:SKHX), shared by the monitor tests and
// scripts/dev-monitor.ts. Prices follow slow waves (~95 USD per share, Brent ~74 and WTI ~70 USDT per barrel, SKHX ~230 USD
// with the ADR 2–8 % above a tenth of it) so the charts have shape.
import type { AnthropicLegKey } from '../src/vendor/anthropic-market.mjs';

const BAR = 900_000, HOUR = 3_600_000, DAY = 86_400_000;
const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fail = (status: number) => new Response('{}', { status });

/** Native price of a leg at `time`: per-share price times the leg's shares per unit (12.7, 1, 16.7, 16.7). */
export function fakeAnthropicPrice(leg: AnthropicLegKey, time: number): number {
  const share = 95 + 4 * Math.sin(time / (5 * DAY));
  const premium = 0.02 + 0.015 * Math.sin(time / (2 * DAY) + (leg === 'io' ? 1 : leg === 'rh' ? 2 : 0));
  const value = leg === 'binance' ? share * 12.7 : share / (1 + premium) * (leg === 'xyz' ? 1 : 16.7);
  return Math.round(value * 100) / 100;
}

export type FakeOilLeg = 'brent' | 'wti';
const OIL_SYMBOLS: Record<string, FakeOilLeg> = { BZUSDT: 'brent', CLUSDT: 'wti' };
/** Oil mark or close at `time`, on the 0.01 tick: the spread wanders between about 2.5 and 5.5 USDT. */
export function fakeOilPrice(leg: FakeOilLeg, time: number): number {
  const wti = 70 + 3 * Math.sin(time / (6 * DAY)), spread = 4 + 1.5 * Math.sin(time / (3 * DAY) + 0.5);
  return Math.round((leg === 'wti' ? wti : wti + spread) * 100) / 100;
}

export type FakeHynixLeg = 'skhy' | 'skhx';
const HYNIX_COINS: Record<string, FakeHynixLeg> = { 'xyz:SKHY': 'skhy', 'xyz:SKHX': 'skhx' };
/** Hynix mid or close at `time`, on the cent: SKHX near 230 USD, the ADR 2–8 % above SKHX ÷ 10. */
export function fakeHynixPrice(leg: FakeHynixLeg, time: number): number {
  const ordinary = 230 + 15 * Math.sin(time / (7 * DAY)), premium = 0.05 + 0.03 * Math.sin(time / (2 * DAY) + 1);
  return Math.round((leg === 'skhx' ? ordinary : ordinary / 10 * (1 + premium)) * 100) / 100;
}

const wait = (ms: number, signal: AbortSignal | null | undefined) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason); return; }
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  const abort = () => { clearTimeout(timer); reject(signal!.reason); };
  signal?.addEventListener('abort', abort, { once: true });
});

const held = (hold: Promise<void>, signal: AbortSignal | null | undefined) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason); return; }
  const abort = () => reject(signal!.reason);
  signal?.addEventListener('abort', abort, { once: true });
  void hold.then(() => { signal?.removeEventListener('abort', abort); resolve(); });
});

export interface FakeVenueOptions {
  /** The venues' clock; candles end at the last completed bar before it. */
  now?: () => number;
  /** First bar each leg has (default: 60 days before the first request; Lighter RH 20 days; oil 2026-04-01 09:00 UTC or 30 days, the later; Hynix 30 days). */
  listedAt?: Partial<Record<AnthropicLegKey | FakeOilLeg | FakeHynixLeg, number>>;
}

export function fakeAnthropicVenues({ now = Date.now, listedAt = {} }: FakeVenueOptions = {}) {
  const start = now();
  const listed = (leg: AnthropicLegKey | FakeOilLeg | FakeHynixLeg) => listedAt[leg] ?? (leg === 'brent' || leg === 'wti' ? Math.max(Date.UTC(2026, 3, 1, 9), start - 30 * DAY) : leg === 'skhy' || leg === 'skhx' ? Math.ceil((start - 30 * DAY) / HOUR) * HOUR : start - (leg === 'rh' ? 20 : 60) * DAY);
  const state = {
    /** Legs answering HTTP 500 ('funding': the oil funding terms). */
    down: new Set<AnthropicLegKey | FakeOilLeg | FakeHynixLeg | 'funding'>(),
    /** HTTP status the oil legs answer instead (429, 418, ...); null: normal answers. */
    oilStatus: null as number | null,
    /** HTTP status the Hynix reads (mids and candles) answer instead; null: normal answers. */
    hynixStatus: null as number | null,
    /** Hours neither Hynix leg has a candle for (no trades). */
    hynixMissing: new Set<number>(),
    /** Delay before every answer; aborting the request ends the wait. */
    delayMs: 0,
    /** While set, every request waits for it (or its abort). */
    hold: null as Promise<void> | null,
    /** Requests by kind ('quote:binance', 'candles:xyz', ...), and the most of one kind in flight at once. */
    requests: new Map<string, number>(),
    maxInFlight: new Map<string, number>(),
  };
  const inFlight = new Map<string, number>();
  const bars = (leg: AnthropicLegKey | FakeOilLeg, from: number, to: number) => {
    const out: number[] = [];
    for (let t = Math.ceil(Math.max(from, listed(leg)) / BAR) * BAR; t < to && t <= now(); t += BAR) out.push(t);
    return out;
  };
  const oil = (leg: FakeOilLeg | 'funding', url: URL): Response => {
    if (state.down.has(leg)) return fail(500);
    if (state.oilStatus !== null) return fail(state.oilStatus);
    if (leg === 'funding') return ok([{ symbol: 'BTCUSDT', fundingIntervalHours: 8 }, { symbol: 'BZUSDT', fundingIntervalHours: 4 }, { symbol: 'CLUSDT', fundingIntervalHours: 4 }]);
    const symbol = leg === 'brent' ? 'BZUSDT' : 'CLUSDT';
    if (url.pathname === '/fapi/v1/premiumIndex') return ok({ symbol, markPrice: String(fakeOilPrice(leg, now())), lastFundingRate: leg === 'brent' ? '0.00005' : '-0.00002', nextFundingTime: Math.ceil(now() / 14_400_000) * 14_400_000, time: now() });
    const from = Number(url.searchParams.get('startTime')), to = Number(url.searchParams.get('endTime')), limit = Number(url.searchParams.get('limit'));
    return ok(bars(leg, from, to + 1).slice(0, limit).map(t => [t, '1', '1', '1', String(fakeOilPrice(leg, t)), '1', t + BAR - 1]));
  };
  const hynix = (body: Record<string, any>): Response => {
    if (state.hynixStatus !== null) return fail(state.hynixStatus);
    if (body.type === 'allMids') {
      if (state.down.has('skhy') || state.down.has('skhx')) return fail(500);
      return ok({ 'xyz:ANT': '95', 'xyz:SKHY': String(fakeHynixPrice('skhy', now())), 'xyz:SKHX': String(fakeHynixPrice('skhx', now())) });
    }
    const leg = HYNIX_COINS[body.req.coin]!;
    if (state.down.has(leg)) return fail(500);
    const out: number[] = [];
    for (let t = Math.ceil(Math.max(body.req.startTime, listed(leg)) / HOUR) * HOUR; t <= body.req.endTime && t <= now(); t += HOUR) if (!state.hynixMissing.has(t)) out.push(t);
    // Hyperliquid serves only its latest 5000 candles; the open hour comes with them.
    return ok(out.slice(-5000).map(t => ({ t, T: t + HOUR - 1, s: body.req.coin, i: '1h', o: '1', h: '1', l: '1', c: String(fakeHynixPrice(leg, t)), v: '1', n: 1 })));
  };
  const answer = (leg: AnthropicLegKey, url: URL, body: Record<string, any> | null): Response => {
    if (state.down.has(leg)) return fail(500);
    if (leg === 'binance') {
      if (url.pathname === '/fapi/v1/premiumIndex') return ok({ symbol: 'ANTHROPICUSDT', markPrice: String(fakeAnthropicPrice('binance', now())), lastFundingRate: '0.0001', nextFundingTime: Math.ceil(now() / 28_800_000) * 28_800_000 });
      const from = Number(url.searchParams.get('startTime')), to = Number(url.searchParams.get('endTime')), limit = Number(url.searchParams.get('limit'));
      return ok(bars(leg, from, to + 1).slice(0, limit).map(t => [t, '1', '1', '1', String(fakeAnthropicPrice(leg, t)), '1', t + BAR - 1]));
    }
    if (leg === 'xyz' || leg === 'io') {
      const name = leg === 'xyz' ? 'xyz:ANT' : 'io:ANTH';
      if (body!.type === 'metaAndAssetCtxs') return ok([{ universe: [{ name: 'other' }, { name }] }, [{ markPx: '1' }, { markPx: String(fakeAnthropicPrice(leg, now())), funding: '0.0000125', oraclePx: String(fakeAnthropicPrice(leg, now())) }]]);
      // Hyperliquid serves only its latest 5000 candles.
      return ok(bars(leg, body!.req.startTime, body!.req.endTime + 1).slice(-5000).map(t => ({ t, T: t + BAR - 1, s: name, i: '15m', o: '1', h: '1', l: '1', c: String(fakeAnthropicPrice(leg, t)), v: '1', n: 1 })));
    }
    const row = () => ({ symbol: 'ANTHROPIC', market_id: 38, market_type: 'perp', status: 'active', mark_price: String(fakeAnthropicPrice('rh', now())), index_price: String(fakeAnthropicPrice('rh', now())), created_at: String(listed('rh')) });
    if (url.pathname === '/api/v1/orderBookDetails') {
      const market = url.searchParams.get('market_id');
      if (market === null) return ok({ code: 200, order_book_details: [{ symbol: 'BTC', market_id: 1, market_type: 'perp', status: 'active', mark_price: '1' }, row()] });
      return market === '38' ? ok({ code: 200, order_book_details: [row()] }) : ok({ code: 21602, message: 'invalid market index' }, 400);
    }
    if (url.pathname === '/api/v1/candles') {
      const end = Number(url.searchParams.get('end_timestamp')), count = Number(url.searchParams.get('count_back'));
      return ok({ code: 200, r: '15m', c: bars(leg, end - count * BAR, end).slice(-500).map(t => ({ t, o: 1, h: 1, l: 1, c: fakeAnthropicPrice('rh', t), v: 1, V: 1, i: t })) });
    }
    return fail(404);
  };
  const fetch = async (href: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(href);
    let leg: AnthropicLegKey, kind: string, body: Record<string, any> | null = null;
    const oilLeg = url.hostname === 'fapi.binance.com' ? url.pathname === '/fapi/v1/fundingInfo' ? 'funding' as const : OIL_SYMBOLS[url.searchParams.get('symbol') ?? ''] : undefined;
    if (oilLeg) {
      const key = `${url.pathname === '/fapi/v1/klines' ? 'candles' : 'quote'}:${oilLeg}`;
      state.requests.set(key, (state.requests.get(key) ?? 0) + 1);
      if (state.hold) await held(state.hold, init.signal);
      if (state.delayMs) await wait(state.delayMs, init.signal);
      return oil(oilLeg, url);
    }
    if (url.hostname === 'fapi.binance.com') { leg = 'binance'; kind = url.pathname === '/fapi/v1/premiumIndex' ? 'quote' : 'candles'; }
    else if (url.hostname === 'api.hyperliquid.xyz') {
      body = JSON.parse(String(init.body)) as Record<string, any>;
      if (body.type === 'allMids' || HYNIX_COINS[body.req?.coin]) {
        const key = body.type === 'allMids' ? 'quote:hynix' : `candles:${HYNIX_COINS[body.req.coin]}`;
        state.requests.set(key, (state.requests.get(key) ?? 0) + 1);
        if (state.hold) await held(state.hold, init.signal);
        if (state.delayMs) await wait(state.delayMs, init.signal);
        return hynix(body);
      }
      leg = body.type === 'metaAndAssetCtxs' ? (body.dex === 'xyz' ? 'xyz' : 'io') : (body.req.coin === 'xyz:ANT' ? 'xyz' : 'io');
      kind = body.type === 'metaAndAssetCtxs' ? 'quote' : 'candles';
    } else if (url.hostname === 'api.rh.lighter.xyz') { leg = 'rh'; kind = url.pathname === '/api/v1/candles' ? 'candles' : 'quote'; }
    else throw new Error(`unexpected request ${href}`);
    const key = `${kind}:${leg}`;
    state.requests.set(key, (state.requests.get(key) ?? 0) + 1);
    inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
    state.maxInFlight.set(key, Math.max(state.maxInFlight.get(key) ?? 0, inFlight.get(key)!));
    try {
      if (state.hold) await held(state.hold, init.signal);
      if (state.delayMs) await wait(state.delayMs, init.signal);
      return answer(leg, url, body);
    } finally { inFlight.set(key, inFlight.get(key)! - 1); }
  };
  return Object.assign(state, { fetch });
}
export type FakeAnthropicVenues = ReturnType<typeof fakeAnthropicVenues>;
