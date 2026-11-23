// A stand-in for the four public venues the Anthropic monitor reads (Binance, Hyperliquid xyz/io, Lighter RH) and the two
// Binance oil contracts (BZUSDT, CLUSDT) and the Hyperliquid Hynix pair (xyz:SKHY, xyz:SKHX), shared by the monitor tests and
// scripts/dev-monitor.ts, plus the comparison venues of M-2c (Bybit, OKX, Bitget, Gate, Lighter REST and its market_stats
// socket, Binance SKHY/SKHYNIX, Hyperliquid xyz oil and Hynix contexts), each a few cents off, and the settled funding of M-2d
// (Binance BZ/CL every 4 h, Hyperliquid SKHY/SKHX hourly, each a few milliseconds after the grid point), and the settlement
// history of M-2d-3 (Bybit, OKX, Bitget and Gate every 8 h, Binance SKHY/SKHYNIX every 4 h, Lighter and Hyperliquid xyz oil
// hourly, 70 days back, paged as each venue pages). Prices follow slow waves (~95 USD per share, Brent ~74 and WTI ~70 USDT per barrel, SKHX ~230 USD
// with the ADR 2–8 % above a tenth of it) so the charts have shape. M-3d adds Variational: the public metadata/stats on `fetch`,
// and on `variationalFetch` (standing in for the Python transport) /api/me, the authenticated indicative marks (5 cents above
// the public marks, so a test can tell them apart) and the public predicted funding. M-2f adds the gold/oil reads: Binance
// exchangeInfo (XAUUSDT, CLUSDT, BZUSDT), the XAUUSDT mark (gold ~2,400 USDT per ounce) and the three legs' 15-minute
// markPriceKlines; CLUSDT and BZUSDT marks are the oil marks above.
import { ANTHROPIC_SHARES, type AnthropicLegKey } from '../src/vendor/anthropic-market.mjs';

const BAR = 900_000, HOUR = 3_600_000, DAY = 86_400_000;
const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fail = (status: number) => new Response('{}', { status });

/** Native price of a leg at `time`: per-share price times the leg's shares per unit (1 on Binance and xyz, the default diluted count on io and Lighter RH). */
export function fakeAnthropicPrice(leg: AnthropicLegKey, time: number): number {
  const share = 95 + 4 * Math.sin(time / (5 * DAY));
  const premium = 0.02 + 0.015 * Math.sin(time / (2 * DAY) + (leg === 'io' ? 1 : leg === 'rh' ? 2 : 0));
  const value = leg === 'binance' ? share : share / (1 + premium) * (leg === 'xyz' ? 1 : ANTHROPIC_SHARES.diluted);
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

/** A leg's settled funding rate at `time` (8 decimals): Brent above WTI, the ADR above the ordinary share, both drifting across zero now and then. */
export function fakeSettledRate(leg: FakeOilLeg | FakeHynixLeg, time: number): number {
  const wave = leg === 'brent' ? 0.0001 + 0.00012 * Math.sin(time / (4 * DAY)) : leg === 'wti' ? 0.00004 + 0.00006 * Math.sin(time / (5 * DAY) + 1)
    : leg === 'skhy' ? 0.00002 + 0.00003 * Math.sin(time / (3 * DAY)) : 0.00001 + 0.00001 * Math.sin(time / (6 * DAY) + 2);
  return Math.round(wave * 1e8) / 1e8;
}

const COMPARISON_HOSTS: Record<string, string> = { 'api.bybit.com': 'bybit', 'www.okx.com': 'okx', 'api.bitget.com': 'bitget', 'api.gateio.ws': 'gate', 'mainnet.zklighter.elliot.ai': 'lighter' };
const HYNIX_BINANCE = ['SKHYUSDT', 'SKHYNIXUSDT'];
const LIGHTER_MARKETS = [{ symbol: 'BRENTOIL', market_id: 91 }, { symbol: 'WTI', market_id: 92 }];
const XYZ_EXTRA = ['xyz:BRENTOIL', 'xyz:CL', 'xyz:SKHY', 'xyz:SKHX'];
const VENUE_OFFSET: Record<string, number> = { hyperliquid: 0.004, bybit: -0.002, binance: 0, lighter: 0.003, okx: -0.001, bitget: 0.002, gate: -0.003, variational: -0.004 };
const VARIATIONAL_STATS_HOST = 'omni-client-api.prod.ap-northeast-1.variational.io';
/** How far the authenticated Variational marks sit above the public ones in the stand-in. */
export const VARIATIONAL_AUTH_SHIFT = 0.05;
/** The Variational stand-in's annualized predicted funding per base, and its 8 h interval. */
export const VARIATIONAL_ANNUAL_RATE: Record<string, number> = { BZ: 0.1095, CL: -0.0438 };
/** A vr-token shaped JWT declaring expiry `exp` (ms); `id` makes distinct tokens. */
export function fakeVariationalToken(exp: number, id = 'a'): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ exp: Math.floor(exp / 1000), sub: id })}.${Buffer.from(`sig-${id}`).toString('base64url')}`;
}
/** A comparison venue's mark for a contract base (BZ, CL, SKHY, SKHYNIX) at `time`: the shared wave, a few tenths of a percent off. */
export function venuePrice(venue: string, base: string, time: number): number {
  const value = base === 'BZ' ? fakeOilPrice('brent', time) : base === 'CL' ? fakeOilPrice('wti', time) : base === 'SKHY' ? fakeHynixPrice('skhy', time) : fakeHynixPrice('skhx', time);
  return Math.round(value * (1 + (VENUE_OFFSET[venue] ?? 0) * (base === 'CL' || base === 'SKHYNIX' ? -1 : 1)) * 1000) / 1000;
}
/** Each comparison venue's settlement step in hours, for the settlement-history stand-ins. */
export const SETTLE_HOURS: Record<string, number> = { hyperliquid: 1, lighter: 1, binance: 4, bybit: 8, okx: 8, bitget: 8, gate: 8 };
/** A comparison venue's settled rate for a contract base at grid time `time` (8 decimals): the first leg above the second. */
export function venueSettledRate(venue: string, base: string, time: number): number {
  const first = base === 'BZ' || base === 'SKHY', hours = SETTLE_HOURS[venue] ?? 8;
  const wave = (first ? 0.00008 : 0.00002) * hours / 8 + 0.00006 * hours / 8 * Math.sin(time / (3 * DAY) + (VENUE_OFFSET[venue] ?? 0) * 500 + (first ? 0 : 2));
  return Math.round(wave * 1e8) / 1e8;
}

function xyzContext(coin: string, time: number) {
  const base = coin === 'xyz:BRENTOIL' ? 'BZ' : coin === 'xyz:CL' ? 'CL' : coin === 'xyz:SKHY' ? 'SKHY' : 'SKHYNIX';
  const price = String(venuePrice('hyperliquid', base, time));
  return { markPx: price, oraclePx: price, funding: base === 'BZ' || base === 'SKHY' ? '0.0000125' : '-0.000005' };
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

/** Gold mark or close at `time`, on the 0.01 tick: about 2,340–2,460 USDT per ounce. */
export function fakeGoldPrice(time: number): number {
  return Math.round((2400 + 60 * Math.sin(time / (4 * DAY))) * 100) / 100;
}
type FakeGoldOilLeg = 'xau' | FakeOilLeg;
const GOLDOIL_SYMBOLS: Record<string, FakeGoldOilLeg> = { XAUUSDT: 'xau', CLUSDT: 'wti', BZUSDT: 'brent' };

export interface FakeVenueOptions {
  /** The venues' clock; candles end at the last completed bar before it. */
  now?: () => number;
  /** First bar each leg has (default: 60 days before the first request; Lighter RH 20 days; oil 2026-04-01 09:00 UTC or 30 days, the later; Hynix 30 days; gold 30 days). */
  listedAt?: Partial<Record<AnthropicLegKey | FakeOilLeg | FakeHynixLeg | 'xau', number>>;
}

export function fakeAnthropicVenues({ now = Date.now, listedAt = {} }: FakeVenueOptions = {}) {
  const start = now();
  const listed = (leg: AnthropicLegKey | FakeOilLeg | FakeHynixLeg | 'xau') => listedAt[leg] ?? (leg === 'xau' ? Math.ceil((start - 30 * DAY) / BAR) * BAR : leg === 'brent' || leg === 'wti' ? Math.max(Date.UTC(2026, 3, 1, 9), start - 30 * DAY) : leg === 'skhy' || leg === 'skhx' ? Math.ceil((start - 30 * DAY) / HOUR) * HOUR : start - (leg === 'rh' ? 20 : 60) * DAY);
  const state = {
    /** Legs answering HTTP 500 ('funding': the oil funding terms). */
    down: new Set<AnthropicLegKey | FakeOilLeg | FakeHynixLeg | 'funding' | 'settled' | 'xau' | 'catalog'>(),
    /** M-2f: XAUUSDT's contract type in exchangeInfo, how far its mark's source time lags the clock, and 15-minute bars a
     * gold/oil leg does not have, as `${leg}:${time}` ('xau:1775030400000'). */
    xauContractType: 'TRADIFI_PERPETUAL',
    xauLagMs: 0,
    goldOilMissing: new Set<string>(),
    /** Settlements a leg does not have, as `${leg}:${time}` ('brent:1775030400000'). */
    settledMissing: new Set<string>(),
    /** HTTP status the oil legs answer instead (429, 418, ...); null: normal answers. */
    oilStatus: null as number | null,
    /** HTTP status the Hynix reads (mids and candles) answer instead; null: normal answers. */
    hynixStatus: null as number | null,
    /** Hours neither Hynix leg has a candle for (no trades). */
    hynixMissing: new Set<number>(),
    /** Comparison venues answering HTTP 500 ('hyperliquid': the xyz oil and Hynix contracts are missing from the contexts). */
    exchangeDown: new Set<string>(),
    /** How the Lighter socket behaves: answers, stays silent (the read times out), or rejects the subscription. */
    lighterMode: 'normal' as 'normal' | 'silent' | 'reject',
    /** Delay before every answer; aborting the request ends the wait. */
    delayMs: 0,
    /** While set, every request waits for it (or its abort). */
    hold: null as Promise<void> | null,
    /** Comparison contracts whose settlement history answers HTTP 500, as `${venue}:${base}` ('bybit:CL'). */
    historyDown: new Set<string>(),
    /** M-3d: how the authenticated Variational endpoints answer the token: accept it, reject it (401 x-omni-auth: r), or
     * challenge every omni.variational.io request (403 cf-mitigated: challenge); funding down answers its reads HTTP 500. */
    variationalMode: 'accept' as 'accept' | 'reject' | 'challenge',
    variationalFundingDown: false,
    /** The tokens the authenticated requests carried, in order. */
    variationalTokens: [] as string[],
    /** Requests by kind ('quote:binance', 'candles:xyz', ...), and the most of one kind in flight at once. */
    requests: new Map<string, number>(),
    maxInFlight: new Map<string, number>(),
  };
  const inFlight = new Map<string, number>();
  const bars = (leg: AnthropicLegKey | FakeOilLeg | 'xau', from: number, to: number) => {
    const out: number[] = [];
    for (let t = Math.ceil(Math.max(from, listed(leg)) / BAR) * BAR; t < to && t <= now(); t += BAR) out.push(t);
    return out;
  };
  const oil = (leg: FakeOilLeg | 'funding', url: URL): Response => {
    if (state.down.has(leg)) return fail(500);
    if (state.oilStatus !== null) return fail(state.oilStatus);
    if (leg === 'funding') return ok([{ symbol: 'BTCUSDT', fundingIntervalHours: 8 }, { symbol: 'BZUSDT', fundingIntervalHours: 4 }, { symbol: 'CLUSDT', fundingIntervalHours: 4 }, { symbol: 'SKHYUSDT', fundingIntervalHours: 4 }, { symbol: 'SKHYNIXUSDT', fundingIntervalHours: 4 }]);
    const symbol = leg === 'brent' ? 'BZUSDT' : 'CLUSDT';
    if (url.pathname === '/fapi/v1/fundingRate') {
      if (state.down.has('settled')) return fail(500);
      const from = Number(url.searchParams.get('startTime')), to = Number(url.searchParams.get('endTime')), limit = Number(url.searchParams.get('limit'));
      const out: { symbol: string; fundingTime: number; fundingRate: string; markPrice: string }[] = [];
      for (let t = Math.ceil(listed(leg) / (4 * HOUR)) * 4 * HOUR; t + 7 <= Math.min(to, now()) && out.length < limit; t += 4 * HOUR) {
        if (t + 7 >= from && !state.settledMissing.has(`${leg}:${t}`)) out.push({ symbol, fundingTime: t + 7, fundingRate: String(fakeSettledRate(leg, t)), markPrice: String(fakeOilPrice(leg, t)) });
      }
      return ok(out);
    }
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
    if (body.type === 'fundingHistory') {
      const leg = HYNIX_COINS[body.coin]!;
      if (state.down.has('settled')) return fail(500);
      const out: { coin: string; fundingRate: string; premium: string; time: number }[] = [];
      // Hyperliquid answers at most 500 settlements a call, from startTime on.
      for (let t = Math.ceil(listed(leg) / HOUR) * HOUR + HOUR; t + 3 <= Math.min(body.endTime, now()) && out.length < 500; t += HOUR) {
        if (t + 3 >= body.startTime && !state.settledMissing.has(`${leg}:${t}`)) out.push({ coin: body.coin, fundingRate: String(fakeSettledRate(leg, t)), premium: '0', time: t + 3 });
      }
      return ok(out);
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
      if (url.pathname === '/fapi/v1/premiumIndex') return ok({ symbol: 'ANTUSDT', markPrice: String(fakeAnthropicPrice('binance', now())), lastFundingRate: '0.0001', nextFundingTime: Math.ceil(now() / 28_800_000) * 28_800_000 });
      const from = Number(url.searchParams.get('startTime')), to = Number(url.searchParams.get('endTime')), limit = Number(url.searchParams.get('limit'));
      return ok(bars(leg, from, to + 1).slice(0, limit).map(t => [t, '1', '1', '1', String(fakeAnthropicPrice(leg, t)), '1', t + BAR - 1]));
    }
    if (leg === 'xyz' || leg === 'io') {
      const name = leg === 'xyz' ? 'xyz:ANT' : 'io:ANTH';
      if (body!.type === 'metaAndAssetCtxs') {
        const own = { markPx: String(fakeAnthropicPrice(leg, now())), funding: '0.0000125', oraclePx: String(fakeAnthropicPrice(leg, now())) };
        if (leg === 'io') return ok([{ universe: [{ name: 'other' }, { name }] }, [{ markPx: '1' }, own]]);
        // The xyz dex also lists the oil and Hynix contracts the comparison reads.
        const extra = state.exchangeDown.has('hyperliquid') ? [] : XYZ_EXTRA;
        return ok([{ universe: [{ name: 'other' }, { name }, ...extra.map(coin => ({ name: coin }))] }, [{ markPx: '1' }, own, ...extra.map(coin => xyzContext(coin, now()))]]);
      }
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
  const settle = (hours: number) => Math.ceil((now() + 1) / (hours * HOUR)) * hours * HOUR;
  /** A contract's settlement times (ms) in [from, to], ascending: the venue's grid from 70 days before the first request. */
  const settlements = (venue: string, from: number, to: number): number[] => {
    const step = SETTLE_HOURS[venue]! * HOUR, out: number[] = [];
    for (let t = Math.max(Math.ceil((start - 70 * DAY) / step) * step, Math.ceil(from / step) * step); t <= Math.min(to, now()); t += step) out.push(t);
    return out;
  };
  /** The settlement-history envelopes of M-2d-3, paged as each venue pages; null when the request is not one. */
  const history = (venue: string, url: URL, symbol: string, base: string): Response | null => {
    const q = (name: string) => Number(url.searchParams.get(name));
    const paths: Record<string, string> = { binance: '/fapi/v1/fundingRate', bybit: '/v5/market/funding/history', okx: '/api/v5/public/funding-rate-history', bitget: '/api/v2/mix/market/history-fund-rate', gate: '/api/v4/futures/usdt/funding_rate', lighter: '/api/v1/fundings' };
    if (url.pathname !== paths[venue]) return null;
    if (state.historyDown.has(`${venue}:${base}`)) return fail(500);
    const rate = (t: number) => venueSettledRate(venue, base, t);
    switch (venue) {
      case 'binance': return ok(settlements(venue, q('startTime'), q('endTime')).slice(0, q('limit')).map(t => ({ symbol, fundingTime: t, fundingRate: String(rate(t)), markPrice: '1' })));
      case 'bybit': return ok({ retCode: 0, result: { category: 'linear', list: settlements(venue, 0, q('endTime')).reverse().slice(0, q('limit')).map(t => ({ symbol, fundingRate: String(rate(t)), fundingRateTimestamp: String(t) })) } });
      case 'okx': return ok({ code: '0', data: settlements(venue, 0, q('after') - 1).reverse().slice(0, q('limit')).map(t => ({ instId: symbol, instType: 'SWAP', method: 'current_period', fundingRate: String(rate(t)), realizedRate: String(rate(t)), fundingTime: String(t) })) });
      case 'bitget': { const size = q('pageSize'), page = q('pageNo'); return ok({ code: '00000', data: settlements(venue, 0, now()).reverse().slice((page - 1) * size, page * size).map(t => ({ symbol, fundingRate: String(rate(t)), fundingTime: String(t) })) }); }
      case 'gate': return ok(settlements(venue, q('from') * 1000, q('to') * 1000 - 1).reverse().slice(0, q('limit')).map(t => ({ t: t / 1000, r: String(rate(t)) })));
      default: {
        const id = q('market_id');
        return ok({ code: 200, fundings: settlements(venue, q('start_timestamp') * 1000, q('end_timestamp') * 1000).map(t => { const value = rate(t); return { timestamp: t / 1000, market_id: id, rate: String(Math.abs(value) * 100), direction: value < 0 ? 'short' : 'long' }; }) });
      }
    }
  };
  /** The comparison venues' official envelopes for one symbol's request. */
  const comparison = (venue: string, url: URL): Response => {
    const lighterId = url.searchParams.get('market_id');
    const t = now(), symbol = url.searchParams.get('symbol') ?? url.searchParams.get('instId') ?? url.searchParams.get('contract') ?? url.pathname.split('/').at(-1)!;
    const base = lighterId !== null ? (lighterId === '91' ? 'BZ' : 'CL') : symbol.replace(/(-USDT-SWAP|_USDT|USDT)$/, '');
    const settled = history(venue, url, symbol, base);
    if (settled) return settled;
    const mark = String(venuePrice(venue, base, t));
    if (venue === 'binance') return ok({ symbol, markPrice: mark, lastFundingRate: '0.00004', nextFundingTime: settle(4), time: t });
    if (venue === 'bybit') {
      if (url.pathname.endsWith('/instruments-info')) return ok({ retCode: 0, time: t, result: { category: 'linear', list: [{ symbol, status: 'Trading', contractType: 'LinearPerpetual', baseCoin: base, quoteCoin: 'USDT', settleCoin: 'USDT', fundingInterval: 480 }], nextPageCursor: '' } });
      return ok({ retCode: 0, time: t, result: { category: 'linear', list: [{ symbol, markPrice: mark, fundingRate: base === 'BZ' || base === 'SKHY' ? '0.0001' : '0.00002', nextFundingTime: String(settle(8)) }] } });
    }
    if (venue === 'okx') {
      if (url.pathname.endsWith('/instruments')) return ok({ code: '0', data: [{ instId: symbol, instType: 'SWAP', state: 'live', ctType: 'linear', settleCcy: 'USDT', ctValCcy: base, instFamily: `${base}-USDT`, uly: `${base}-USDT`, ruleType: 'normal' }] });
      if (url.pathname.endsWith('/mark-price')) return ok({ code: '0', data: [{ instId: symbol, instType: 'SWAP', markPx: mark, ts: String(t) }] });
      return ok({ code: '0', data: [{ instId: symbol, instType: 'SWAP', method: 'current_period', fundingRate: '0.00008', fundingTime: String(settle(8)), nextFundingTime: String(settle(8) + 8 * HOUR), ts: String(t) }] });
    }
    if (venue === 'bitget') {
      if (url.pathname.endsWith('/contracts')) return ok({ code: '00000', requestTime: t, data: [{ symbol, symbolStatus: 'normal', symbolType: 'perpetual', baseCoin: base, quoteCoin: 'USDT', supportMarginCoins: ['USDT'] }] });
      if (url.pathname.endsWith('/ticker')) return ok({ code: '00000', requestTime: t, data: [{ symbol, markPrice: mark, ts: String(t) }] });
      return ok({ code: '00000', requestTime: t, data: [{ symbol, fundingRate: '-0.00003', fundingRateInterval: '8', nextUpdate: String(settle(8)) }] });
    }
    if (venue === 'gate') return ok({ name: symbol, status: 'trading', in_delisting: false, type: 'direct', mark_price: mark, funding_rate: '0.00005', funding_interval: 28_800, funding_next_apply: settle(8) / 1000 });
    // Lighter's catalog.
    return ok({ code: 200, order_book_details: [{ symbol: 'ETH', market_id: 0, market_type: 'perp', status: 'active', multiplier: 1 }, ...LIGHTER_MARKETS.map(row => ({ ...row, market_type: 'perp', status: 'active', multiplier: 1 }))] });
  };
  /** A stand-in for Lighter's read-only stream: answers each market_stats subscription with one snapshot. */
  class FakeSocket {
    onopen: (() => void) | null = null; onmessage: ((event: { data: string }) => void) | null = null; onerror: (() => void) | null = null; onclose: (() => void) | null = null;
    readonly url: string;
    constructor(url: string) {
      this.url = url;
      state.requests.set('exchange:lighter-socket', (state.requests.get('exchange:lighter-socket') ?? 0) + 1);
      setTimeout(() => this.onopen?.(), 0);
    }
    send(text: string): void {
      const message = JSON.parse(text) as { type: string; channel?: string };
      if (message.type !== 'subscribe' || state.lighterMode === 'silent') return;
      setTimeout(() => {
        if (state.lighterMode === 'reject') { this.onmessage?.({ data: JSON.stringify({ type: 'error', error: 'denied' }) }); return; }
        const id = Number(message.channel!.split('/')[1]), market = LIGHTER_MARKETS.find(row => row.market_id === id)!;
        const price = venuePrice('lighter', market.symbol === 'BRENTOIL' ? 'BZ' : 'CL', now());
        this.onmessage?.({ data: JSON.stringify({ type: 'ping' }) });
        this.onmessage?.({ data: JSON.stringify({ type: 'subscribed/market_stats', channel: `market_stats:${id}`, timestamp: now(), market_stats: { symbol: market.symbol, market_id: id, mark_price: String(price), index_price: String(price), current_funding_rate: '0.0012' } }) });
      }, 0);
    }
    close(): void { /* nothing to release */ }
  }
  const count = (key: string) => state.requests.set(key, (state.requests.get(key) ?? 0) + 1);
  const pause = async (signal: AbortSignal | null | undefined) => {
    if (state.hold) await held(state.hold, signal);
    if (state.delayMs) await wait(state.delayMs, signal);
  };
  /** The Python transport's stand-in: the same Response shape for the three omni.variational.io reads. */
  const variationalFetch = async (href: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(href), path = url.pathname, headers = new Headers(init.headers);
    if (url.hostname !== 'omni.variational.io') throw new Error(`unexpected request ${href}`);
    const kind = path === '/api/me' ? 'me' : path === '/api/quotes/indicative' ? 'indicative' : path === '/api/funding/v2' ? 'funding' : null;
    if (!kind) throw new Error(`unexpected request ${href}`);
    count(`variational:${kind}`);
    await pause(init.signal);
    if (state.variationalMode === 'challenge') return new Response('<html></html>', { status: 403, headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' } });
    const t = now();
    if (kind === 'funding') {
      if (headers.has('cookie')) throw new Error('public funding carried a token');
      if (state.variationalFundingDown) return fail(500);
      const base = url.searchParams.get('underlying') ?? '';
      const next = (Math.floor(t / (8 * HOUR)) + 1) * 8 * HOUR;
      return ok({ underlying: base, predicted_funding_rate: String(VARIATIONAL_ANNUAL_RATE[base]), funding_interval_s: 28_800, next_funding_time: new Date(next).toISOString() });
    }
    const token = /^vr-token=(.+)$/.exec(headers.get('cookie') ?? '')?.[1];
    if (!token) throw new Error('authenticated request without a token');
    state.variationalTokens.push(token);
    if (state.variationalMode === 'reject') return new Response('{}', { status: 401, headers: { 'content-type': 'application/json', 'x-omni-auth': 'r' } });
    if (kind === 'me') return ok({ address: '0xabc', token });
    const instrument = (JSON.parse(String(init.body)) as { instrument: { underlying: string } }).instrument;
    const mark = Math.round((venuePrice('variational', instrument.underlying, t) + VARIATIONAL_AUTH_SHIFT) * 1000) / 1000;
    return ok({ instrument, qty: '1', mark_price: String(mark), bid: String(mark - 0.01), ask: String(mark + 0.01), timestamp: new Date(t - 1000).toISOString() });
  };
  const fetch = async (href: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(href);
    let leg: AnthropicLegKey, kind: string, body: Record<string, any> | null = null;
    if (url.hostname === VARIATIONAL_STATS_HOST) {
      count('exchange:variational');
      await pause(init.signal);
      if (state.exchangeDown.has('variational')) return fail(500);
      const row = (ticker: string) => ({ ticker, mark_price: String(venuePrice('variational', ticker, now())), funding_rate: '0.0001', funding_interval_s: 28_800 });
      return ok({ listings: [{ ticker: 'BTC', mark_price: '100000', funding_interval_s: 28_800 }, row('BZ'), row('CL')] });
    }
    if (url.hostname === 'fapi.binance.com' && HYNIX_BINANCE.includes(url.searchParams.get('symbol') ?? '')) {
      state.requests.set('exchange:binance', (state.requests.get('exchange:binance') ?? 0) + 1);
      if (state.hold) await held(state.hold, init.signal);
      if (state.delayMs) await wait(state.delayMs, init.signal);
      if (state.oilStatus !== null) return fail(state.oilStatus);
      return state.exchangeDown.has('binance') ? fail(500) : comparison('binance', url);
    }
    const goldOilLeg = url.hostname === 'fapi.binance.com' ? url.pathname === '/fapi/v1/exchangeInfo' ? 'catalog' as const
      : url.pathname === '/fapi/v1/markPriceKlines' || url.searchParams.get('symbol') === 'XAUUSDT' ? GOLDOIL_SYMBOLS[url.searchParams.get('symbol') ?? ''] : undefined : undefined;
    if (goldOilLeg) {
      const key = `goldoil:${goldOilLeg === 'catalog' ? 'catalog' : url.pathname === '/fapi/v1/markPriceKlines' ? 'candles' : 'quote'}${goldOilLeg === 'catalog' ? '' : `:${goldOilLeg}`}`;
      state.requests.set(key, (state.requests.get(key) ?? 0) + 1);
      if (state.hold) await held(state.hold, init.signal);
      if (state.delayMs) await wait(state.delayMs, init.signal);
      if (state.down.has(goldOilLeg)) return fail(500);
      if (state.oilStatus !== null) return fail(state.oilStatus);
      if (goldOilLeg === 'catalog') {
        const spec = (symbol: string, baseAsset: string, leg: FakeGoldOilLeg, contractType: string) => ({ symbol, status: 'TRADING', contractType, baseAsset, quoteAsset: 'USDT', marginAsset: 'USDT', onboardDate: listed(leg) });
        return ok({ symbols: [spec('BTCUSDT', 'BTC', 'xau', 'PERPETUAL'), spec('XAUUSDT', 'XAU', 'xau', state.xauContractType), spec('CLUSDT', 'CL', 'wti', 'TRADIFI_PERPETUAL'), spec('BZUSDT', 'BZ', 'brent', 'TRADIFI_PERPETUAL')] });
      }
      const price = (time: number) => goldOilLeg === 'xau' ? fakeGoldPrice(time) : fakeOilPrice(goldOilLeg, time);
      if (url.pathname === '/fapi/v1/premiumIndex') return ok({ symbol: 'XAUUSDT', markPrice: String(fakeGoldPrice(now())), lastFundingRate: '0.00001', nextFundingTime: Math.ceil(now() / 14_400_000) * 14_400_000, time: now() - state.xauLagMs });
      const from = Number(url.searchParams.get('startTime')), to = Number(url.searchParams.get('endTime')), limit = Number(url.searchParams.get('limit'));
      // Only closed bars, as Binance: a bar is served once its close time has passed.
      return ok(bars(goldOilLeg, from, to + 1).filter(t => t + BAR <= now() && !state.goldOilMissing.has(`${goldOilLeg}:${t}`)).slice(0, limit)
        .map(t => [t, '1', '1', '1', String(price(t)), '1', t + BAR - 1]));
    }
    const oilLeg = url.hostname === 'fapi.binance.com' ? url.pathname === '/fapi/v1/fundingInfo' ? 'funding' as const : OIL_SYMBOLS[url.searchParams.get('symbol') ?? ''] : undefined;
    if (oilLeg) {
      const key = `${url.pathname === '/fapi/v1/klines' ? 'candles' : url.pathname === '/fapi/v1/fundingRate' ? 'settled' : 'quote'}:${oilLeg}`;
      state.requests.set(key, (state.requests.get(key) ?? 0) + 1);
      if (state.hold) await held(state.hold, init.signal);
      if (state.delayMs) await wait(state.delayMs, init.signal);
      return oil(oilLeg, url);
    }
    if (url.hostname === 'fapi.binance.com') { leg = 'binance'; kind = url.pathname === '/fapi/v1/premiumIndex' ? 'quote' : 'candles'; }
    else if (url.hostname === 'api.hyperliquid.xyz') {
      body = JSON.parse(String(init.body)) as Record<string, any>;
      if (body.type === 'fundingHistory' && (body.coin === 'xyz:BRENTOIL' || body.coin === 'xyz:CL')) {
        state.requests.set('exchange:hyperliquid', (state.requests.get('exchange:hyperliquid') ?? 0) + 1);
        if (state.hold) await held(state.hold, init.signal);
        if (state.delayMs) await wait(state.delayMs, init.signal);
        const base = body.coin === 'xyz:CL' ? 'CL' : 'BZ';
        if (state.exchangeDown.has('hyperliquid') || state.historyDown.has(`hyperliquid:${base}`)) return fail(500);
        // Hyperliquid answers at most 500 settlements a call, from startTime on.
        return ok(settlements('hyperliquid', body.startTime, body.endTime).slice(0, 500).map(t => ({ coin: body!.coin, fundingRate: String(venueSettledRate('hyperliquid', base, t)), premium: '0', time: t })));
      }
      if (body.type === 'allMids' || HYNIX_COINS[body.req?.coin] || (body.type === 'fundingHistory' && HYNIX_COINS[body.coin])) {
        const key = body.type === 'allMids' ? 'quote:hynix' : body.type === 'fundingHistory' ? `settled:${HYNIX_COINS[body.coin]}` : `candles:${HYNIX_COINS[body.req.coin]}`;
        state.requests.set(key, (state.requests.get(key) ?? 0) + 1);
        if (state.hold) await held(state.hold, init.signal);
        if (state.delayMs) await wait(state.delayMs, init.signal);
        return hynix(body);
      }
      leg = body.type === 'metaAndAssetCtxs' ? (body.dex === 'xyz' ? 'xyz' : 'io') : (body.req.coin === 'xyz:ANT' ? 'xyz' : 'io');
      kind = body.type === 'metaAndAssetCtxs' ? 'quote' : 'candles';
    } else if (url.hostname === 'api.rh.lighter.xyz') { leg = 'rh'; kind = url.pathname === '/api/v1/candles' ? 'candles' : 'quote'; }
    else {
      const venue = COMPARISON_HOSTS[url.hostname];
      if (!venue) throw new Error(`unexpected request ${href}`);
      const key = `exchange:${venue}`;
      state.requests.set(key, (state.requests.get(key) ?? 0) + 1);
      if (state.hold) await held(state.hold, init.signal);
      if (state.delayMs) await wait(state.delayMs, init.signal);
      return state.exchangeDown.has(venue) ? fail(500) : comparison(venue, url);
    }
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
  return Object.assign(state, { fetch, variationalFetch, WebSocket: FakeSocket as unknown as typeof WebSocket });
}
export type FakeAnthropicVenues = ReturnType<typeof fakeAnthropicVenues>;
