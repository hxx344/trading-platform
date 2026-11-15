// Stand-in perpetual venues for the local preview (scripts/dev-monitor.ts): five venues with the real ids (so the page shows
// their marks), ~40 bases each, books and funding that drift once a second over in-process sockets. Nothing goes to the network:
// the on-demand depth check and spot FX (M-5a) read 20-level books around the current price from an in-process fetch, and the
// one venue the service reads over WebSocket (Lighter) refuses at once. The market metrics (M-5b1) answer Binance, Bybit and
// Hyperliquid's batch tickers and open interest; OKX and Lighter fail, so the page shows its failure state too. The settled
// funding histories (M-5b2) answer Binance and Bybit (8-hourly) and Hyperliquid (hourly) with a stable rate per base and
// time, paged as the venues page; OKX and Lighter fail likewise. The hourly trade closes (M-5c) answer Binance, Bybit and
// Hyperliquid's candles around each base's opening price with a per-venue offset and a slow swing; OKX fails, Lighter is not a
// venue the reader supports. The quality service (M-5d2) gets stand-in sources instead of CoinGecko and the ratio venues: BTC
// and ETH have market cap / FDV (every other base reads as unmapped); Binance and Bybit answer a long/short account ratio per
// base for the current 5-minute period, OKX has no series (unavailable), Hyperliquid and Lighter are DEXs (unsupported).
import type { PerpetualOptions } from '../src/monitor/perpetual.ts';
import type { FundamentalsClient } from '../src/vendor/perpetual-fundamentals.mjs';
import type { PositioningFetch } from '../src/vendor/perpetual-positioning.mjs';
import type { TokenFundamentals } from '../src/vendor/perpetual-quality.ts';
import type { PerpetualMarket, PerpetualUpdate } from '../src/vendor/perpetual-stream.mjs';

const VENUES = [
  { id: 'binance', name: 'Binance', kind: 'cex', quote: 'USDT', interval: 8 }, { id: 'bybit', name: 'Bybit', kind: 'cex', quote: 'USDT', interval: 8 },
  { id: 'okx', name: 'OKX', kind: 'cex', quote: 'USDT', interval: 8 }, { id: 'hyperliquid', name: 'Hyperliquid', kind: 'dex', quote: 'USDC', interval: 1 },
  { id: 'lighter', name: 'Lighter', kind: 'dex', quote: 'USDC', interval: 1 },
] as const;
const CRYPTO: Record<string, number> = { BTC: 98_500, ETH: 3_420, SOL: 182, XRP: 2.31, DOGE: 0.218, BNB: 702, ADA: 0.92, AVAX: 38.4, LINK: 21.6, DOT: 6.9, TON: 5.4, SUI: 4.12, APT: 9.8, ARB: 0.71, OP: 1.84, NEAR: 5.6, LTC: 104, BCH: 452, TRX: 0.251, ATOM: 7.2, FIL: 5.1, INJ: 24.3, TIA: 6.1, SEI: 0.43, WLD: 2.4, PEPE: 0.0000182, WIF: 2.1, ENA: 0.88, ORDI: 31, JUP: 1.02, HYPE: 27.4, AAVE: 342, UNI: 13.2, MKR: 1_620 };
const EQUITY: Record<string, number> = { TSLA: 412, NVDA: 142, AAPL: 238 };
const FEES: Record<string, [string, number]> = { bybit: ['bybit-standard', 0.00055], okx: ['okx-standard', 0.0005], lighter: ['lighter-standard', 0] };
const COMMODITY: Record<string, number> = { XAU: 2_680, CL: 71.4 };

interface Socket { readyState: number; listeners: Map<string, ((event: { data: unknown }) => void)[]>; closed: boolean; timer?: ReturnType<typeof setInterval> }

export function fakePerpetualVenues(): PerpetualOptions {
  const prices = new Map<string, number>(Object.entries({ ...CRYPTO, ...EQUITY, ...COMMODITY }));
  const funding = new Map<string, number>();
  const markets = (exchange: string): PerpetualMarket[] => {
    const venue = VENUES.find(item => item.id === exchange)!;
    // Each venue lists most bases; the DEXs list the RWA ones too, one base on OKX is about to be delisted.
    return [...prices.keys()].filter((base, index) => venue.kind === 'dex' || !(base in EQUITY || base in COMMODITY) && (index + venue.id.length) % 7 !== 0).map(base => ({
      id: `${exchange}:${base}`, exchange, symbol: venue.kind === 'dex' ? base : `${base}${venue.quote}`, base, quoteCurrency: venue.quote,
      assetClass: base in EQUITY ? 'equity' : base in COMMODITY ? 'commodity' : 'crypto', identitySource: 'preview', identityVerified: true,
      // The fee sources the page accepts (perpetual-fees.ts), so the net spread shows for these venues.
      ...(FEES[exchange] ? { takerFeeSource: FEES[exchange]![0], takerFeeRate: FEES[exchange]![1], takerFeeAt: Date.now() } : {}),
      ...(exchange === 'okx' && base === 'ORDI' ? { delisting: true, delistingAt: Date.now() + 3 * 86_400_000 } : {}),
    }));
  };
  class FakeSocket implements Socket {
    readyState = 0; closed = false; binaryType = 'blob'; timer?: ReturnType<typeof setInterval>;
    readonly listeners = new Map<string, ((event: { data: unknown }) => void)[]>();
    readonly url: string;
    constructor(url: string) {
      this.url = url;
      const exchange = new URL(url).hostname.split('.')[0]!;
      const venue = VENUES.find(item => item.id === exchange)!;
      setTimeout(() => {
        if (this.closed) return;
        this.readyState = 1; this.emit('open');
        const tick = () => {
          const updates: PerpetualUpdate[] = markets(exchange).map(market => {
            const base = market.base;
            const mid = prices.get(base)! * (1 + (Math.random() - 0.5) * 0.004 + (venue.kind === 'dex' ? 0.0008 : 0));
            const spread = mid * 0.0002;
            const key = `${exchange}:${base}`;
            const rate = (funding.get(key) ?? (Math.random() - 0.4) * 0.0003 * venue.interval / 8) + (Math.random() - 0.5) * 0.00001;
            funding.set(key, rate);
            const hour = 3_600_000 * venue.interval;
            return { exchange, symbol: market.symbol, base, quoteCurrency: market.quoteCurrency, bid: mid - spread, ask: mid + spread, mark: mid, last: mid,
              fundingRate: rate, fundingIntervalHours: venue.interval, nextFundingAt: Math.ceil(Date.now() / hour) * hour, sourceTime: Date.now() };
          });
          this.emit('message', JSON.stringify({ updates }));
        };
        tick(); this.timer = setInterval(tick, 1_000);
      }, 50);
    }
    addEventListener(type: string, listener: (event: { data: unknown }) => void): void { this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]); }
    emit(type: string, data?: unknown): void { for (const listener of this.listeners.get(type) ?? []) listener({ data }); }
    send(): void { /* Subscriptions are implied by the URL. */ }
    close(): void { this.closed = true; this.readyState = 3; clearInterval(this.timer); }
  }
  const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  const levels = (base: string, side: 'bids' | 'asks') => {
    const mid = prices.get(base) ?? 0;
    return Array.from({ length: 20 }, (_, index) => [String(mid * (1 + (side === 'asks' ? 1 : -1) * (0.0002 + index * 0.0001))), String(2_500 / mid * (1 + index / 4))]);
  };
  const baseOf = (symbol: string) => symbol.replace(/USDT$|USDC$/, '');
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input), symbol = url.searchParams.get('symbol') ?? url.searchParams.get('instId') ?? '', now = Date.now();
    if (url.hostname === 'fapi.binance.com') return json({ E: now, bids: levels(baseOf(symbol), 'bids'), asks: levels(baseOf(symbol), 'asks') });
    if (url.hostname === 'api.bybit.com') return json({ retCode: 0, result: { s: symbol, ts: now, b: levels(baseOf(symbol), 'bids'), a: levels(baseOf(symbol), 'asks') } });
    if (url.pathname === '/api/v5/public/instruments') return json({ code: '0', data: [{ instId: symbol, ctType: 'linear', ctValCcy: symbol.split('-')[0], ctVal: '1', ctMult: '1' }] });
    if (url.pathname === '/api/v5/market/books') return json({ code: '0', data: [{ ts: String(now), bids: levels(baseOf(symbol), 'bids'), asks: levels(baseOf(symbol), 'asks') }] });
    if (url.hostname === 'api.hyperliquid.xyz') {
      const coin = (JSON.parse(String(init?.body ?? '{}')) as { coin?: string }).coin ?? '';
      const side = (name: 'bids' | 'asks') => levels(coin, name).map(([px, sz]) => ({ px, sz, n: 1 }));
      return json({ coin, time: now, levels: [side('bids'), side('asks')] });
    }
    if (url.pathname === '/api/v4/spot/order_book') return json({ update: now, current: now, bids: [['0.9997', '50000']], asks: [['1.0002', '50000']] });
    if (url.hostname === 'api.kraken.com') return json({ error: [], result: { USDTZUSD: { bids: [['1.0001', '50000', now / 1000]], asks: [['1.0003', '50000', now / 1000]] } } });
    throw new Error(`preview: no stand-in for ${url.hostname}${url.pathname}`);
  };
  // A stable size per base (bigger for the majors), so sorting and the compact amounts have something to show.
  const size = (base: string, scale: number) => Math.round(scale * (1 + [...base].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 17) * (base === 'BTC' || base === 'ETH' ? 40 : 1));
  const listed = (exchange: string) => markets(exchange).map(market => ({ symbol: market.symbol, base: market.base }));
  const metricsFetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input), now = Date.now();
    if (url.hostname === 'fapi.binance.com' && url.pathname === '/fapi/v1/ticker/24hr') return json(listed('binance').map(({ symbol, base }) => ({ symbol, quoteVolume: String(size(base, 3_100_000)), closeTime: now })));
    if (url.hostname === 'fapi.binance.com' && url.pathname === '/futures/data/openInterestHist') {
      const symbol = url.searchParams.get('symbol') ?? '';
      return json([{ symbol, sumOpenInterestValue: String(size(baseOf(symbol), 1_400_000)), timestamp: now - 60_000 }]);
    }
    if (url.hostname === 'api.bybit.com') return json({ retCode: 0, time: now, result: { list: listed('bybit').map(({ symbol, base }) => ({ symbol, turnover24h: String(size(base, 1_900_000)), singleOpenInterestValue: String(size(base, 900_000)) })) } });
    if (url.hostname === 'api.hyperliquid.xyz') {
      const rows = listed('hyperliquid');
      return json([{ universe: rows.map(({ symbol }) => ({ name: symbol })) }, rows.map(({ base }) => ({ dayNtlVlm: String(size(base, 800_000)), openInterest: String(size(base, 300_000) / (prices.get(base) ?? 1)), markPx: String(prices.get(base) ?? 1) }))]);
    }
    throw new Error(`preview: no stand-in for ${url.hostname}${url.pathname}`);
  };
  const HOUR = 3_600_000;
  // A stable settled rate per venue, base and time: a per-base level, a per-venue offset and a slow swing, so the two legs of a
  // pair differ, the windows differ and some net carries are negative.
  const settled = (venue: string, base: string, time: number) => (([...base].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 7 - 2) * 0.00002 + ({ binance: 0, bybit: 0.00003, hyperliquid: -0.00002 }[venue] ?? 0) + 0.00001 * Math.sin(time / HOUR / 13)).toFixed(8);
  const times = (from: number, to: number, step: number) => { const list: number[] = []; for (let time = Math.ceil(from / step) * step; time <= to; time += step) list.push(time); return list; };
  const fundingFetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input), params = url.searchParams, now = Date.now();
    if (url.hostname === 'fapi.binance.com' && url.pathname === '/fapi/v1/fundingRate') {
      const symbol = params.get('symbol') ?? '', limit = Number(params.get('limit'));
      return json(times(Number(params.get('startTime')), Math.min(now, Number(params.get('endTime'))), 8 * HOUR).slice(0, limit).map(time => ({ symbol, fundingTime: time, fundingRate: settled('binance', baseOf(symbol), time) })));
    }
    if (url.hostname === 'api.bybit.com' && url.pathname === '/v5/market/funding/history') {
      const symbol = params.get('symbol') ?? '', limit = Number(params.get('limit')), end = Math.min(now, Number(params.get('endTime')));
      const list = times(end - limit * 8 * HOUR, end, 8 * HOUR).reverse().slice(0, limit).map(time => ({ symbol, fundingRateTimestamp: String(time), fundingRate: settled('bybit', baseOf(symbol), time) }));
      return json({ retCode: 0, result: { category: 'linear', list } });
    }
    if (url.hostname === 'api.hyperliquid.xyz' && init?.body) {
      const body = JSON.parse(String(init.body)) as { type: string; coin: string; startTime: number; endTime: number };
      if (body.type === 'fundingHistory') return json(times(body.startTime, Math.min(now, body.endTime), HOUR).slice(0, 500).map(time => ({ coin: body.coin, time, fundingRate: settled('hyperliquid', baseOf(body.coin), time), premium: '0' })));
    }
    throw new Error(`preview: no stand-in for ${url.hostname}${url.pathname}`);
  };
  const opening = new Map(prices);
  const close = (venue: string, base: string, open: number) => (opening.get(base) ?? 1) * (1 + ({ binance: 0, bybit: 0.0008, hyperliquid: -0.0005 }[venue] ?? 0)
    + 0.004 * Math.sin(open / HOUR / 17) + 0.0006 * Math.sin(open / HOUR / 3 + venue.length));
  // Closed and current hours only, as the venues answer (the reader drops the open one).
  const opens = (from: number, to: number) => times(from, Math.min(to, Math.floor(Date.now() / HOUR) * HOUR), HOUR);
  const priceFetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input), params = url.searchParams;
    if (url.hostname === 'fapi.binance.com' && url.pathname === '/fapi/v1/klines') {
      const symbol = params.get('symbol') ?? '';
      return json(opens(Number(params.get('startTime')), Number(params.get('endTime'))).slice(0, Number(params.get('limit'))).map(open => [open, '0', '0', '0', String(close('binance', baseOf(symbol), open)), '0', open + HOUR - 1]));
    }
    if (url.hostname === 'api.bybit.com' && url.pathname === '/v5/market/kline') {
      const symbol = params.get('symbol') ?? '';
      const list = opens(Number(params.get('start')), Number(params.get('end'))).slice(0, Number(params.get('limit'))).reverse().map(open => [String(open), '0', '0', '0', String(close('bybit', baseOf(symbol), open)), '0', '0']);
      return json({ retCode: 0, result: { symbol, category: 'linear', list } });
    }
    if (url.hostname === 'api.hyperliquid.xyz' && init?.body) {
      const body = JSON.parse(String(init.body)) as { type: string; req: { coin: string; startTime: number; endTime: number } };
      if (body.type === 'candleSnapshot') return json(opens(body.req.startTime, body.req.endTime).map(open => ({ t: open, T: open + HOUR - 1, s: body.req.coin, i: '1h', c: String(close('hyperliquid', body.req.coin, open)) })));
    }
    throw new Error(`preview: no stand-in for ${url.hostname}${url.pathname}`);
  };
  const assets: Record<string, Omit<TokenFundamentals, 'updatedAt'>> = {
    BTC: { coinId: 'bitcoin', name: 'Bitcoin', marketCapUsd: 1_950_000_000_000, fdvUsd: 2_070_000_000_000, circulatingSupply: 19_800_000, totalSupply: 19_800_000, maxSupply: 21_000_000, source: 'preview' },
    ETH: { coinId: 'ethereum', name: 'Ethereum', marketCapUsd: 412_000_000_000, fdvUsd: 412_000_000_000, circulatingSupply: 120_500_000, totalSupply: 120_500_000, maxSupply: null, source: 'preview' },
  };
  const fundamentals: FundamentalsClient = {
    refresh: async () => ({}),
    get: base => assets[base] ? { ...assets[base]!, updatedAt: Math.floor(Date.now() / 600_000) * 600_000 } : null,
    describe: base => assets[base] ? { base, coinId: assets[base]!.coinId, status: 'ready', reason: null } : { base, coinId: null, status: 'unmapped', reason: '资产目录中未找到该币种' },
  };
  const positioningFetch: PositioningFetch = async (quote, options) => {
    if (quote.exchange !== 'binance' && quote.exchange !== 'bybit') return null;
    const period = Math.floor((options?.now ?? Date.now()) / 300_000) * 300_000;
    const longRatio = 0.42 + ((quote.base.charCodeAt(0) + quote.base.length * 7 + (quote.exchange === 'bybit' ? 5 : 0)) % 20) / 100;
    return { exchange: quote.exchange, symbol: quote.symbol, longRatio, shortRatio: 1 - longRatio, kind: 'accounts', scope: '合约全体持仓账户（5 分钟）', source: `preview:${quote.exchange}`, observedAt: period };
  };
  class RefusingSocket {
    on(type: string, listener: (data?: unknown) => void): void { if (type === 'error') setTimeout(() => listener(), 0); }
    send(): void { /* Never opens. */ }
    terminate(): void { /* Never opened. */ }
  }
  // Prices drift slowly so the ranking reorders.
  setInterval(() => { for (const [base, value] of prices) prices.set(base, value * (1 + (Math.random() - 0.5) * 0.001)); }, 2_000).unref();
  return {
    exchanges: VENUES.map(({ id, name, kind }) => ({ id, name, kind })),
    discover: async exchange => markets(exchange),
    subscriptions: (exchange, list) => [{ url: `wss://${exchange}.preview/ws`, markets: list, subscribe: [] }],
    parse: ((_exchange: string, payload: unknown) => (payload as { updates?: PerpetualUpdate[] }).updates ?? []) as PerpetualOptions['parse'],
    control: (() => null) as PerpetualOptions['control'],
    WebSocketImpl: FakeSocket as unknown as PerpetualOptions['WebSocketImpl'],
    execution: { fetchImpl, WebSocketImpl: RefusingSocket },
    metrics: { fetchImpl: metricsFetch },
    fundingHistory: { fetchImpl: fundingFetch },
    priceHistory: { fetchImpl: priceFetch },
    quality: { fundamentals, positioningFetch },
  };
}
