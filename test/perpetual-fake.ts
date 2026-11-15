// Stand-in perpetual venues for the local preview (scripts/dev-monitor.ts): five venues with the real ids (so the page shows
// their marks), ~40 bases each, books and funding that drift once a second over in-process sockets. Nothing goes to the network.
import type { PerpetualOptions } from '../src/monitor/perpetual.ts';
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
  // Prices drift slowly so the ranking reorders.
  setInterval(() => { for (const [base, value] of prices) prices.set(base, value * (1 + (Math.random() - 0.5) * 0.001)); }, 2_000).unref();
  return {
    exchanges: VENUES.map(({ id, name, kind }) => ({ id, name, kind })),
    discover: async exchange => markets(exchange),
    subscriptions: (exchange, list) => [{ url: `wss://${exchange}.preview/ws`, markets: list, subscribe: [] }],
    parse: ((_exchange: string, payload: unknown) => (payload as { updates?: PerpetualUpdate[] }).updates ?? []) as PerpetualOptions['parse'],
    control: (() => null) as PerpetualOptions['control'],
    WebSocketImpl: FakeSocket as unknown as PerpetualOptions['WebSocketImpl'],
  };
}
