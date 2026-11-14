// Monitor M-2c: the multi-exchange comparison for oil and Hynix, read on demand. Nothing runs in the background: a page that
// shows the comparison asks for one exchange at a time (every 15 s), and the answer is shared for 5 s between viewers, with
// one request in flight per answer. Every request carries a 10 s timeout and is never retried; a failure is not cached and
// answers with a short Chinese reason. Contract catalogs are kept 60 s and, while a refresh fails, used up to 10 minutes.
// Oil on Binance comes from the oil collector's quote and Hynix on Hyperliquid from the Hynix collector's mids, so they cost
// no extra Binance or allMids reads.
// M-2d-3: one exchange's settled funding history (60 days, both legs), read only while a page has its panel open. A snapshot
// is shared for 5 minutes; the next read starts a day before each leg's last coverage end, so only the first read pages the
// whole window. The whole read has a 60 s deadline on top of each request's 10 s timeout, pages are capped per leg, and no
// request is retried. A leg that fails keeps its previous records and coverage; when both fail the previous snapshot is
// served for 15 s marked as a snapshot, and without one the read answers with a short Chinese reason. Kept in memory only.
import {
  LIGHTER_ORIGIN, binanceOilExchangeQuote, bybitInstruments, hyperliquidHynixQuote, hyperliquidOilQuote, parseBinanceQuote, parseBitgetQuote,
  parseBybitQuote, parseGateQuote, checkedReply, parseHyperliquidContexts, parseLighterOilMarkets, parseOkxQuote, readLighterOilSnapshot, supportsExchange,
  EXCHANGE_CONTRACTS, type Exchange, type ExchangeQuote, type HyperliquidContext, type LighterMarket, type SpreadMarket,
} from '../vendor/exchange-comparison.mjs';
import type { BinanceGate } from '../vendor/anthropic-market.mjs';
import { HISTORY_REFRESH_MS, createFundingLegReader, mergeFundingHistory, supportsFundingHistory, type ExchangeFundingHistory } from '../vendor/exchange-funding-history.mjs';
import type { HynixQuoteView } from './hynix.ts';
import type { OilQuoteView } from './oil.ts';
import { boundedReply } from './anthropic.ts';

export type ExchangeFetcher = (url: string, init: RequestInit) => Promise<Response>;
export const EXCHANGE_RESULT_TTL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 10_000, CATALOG_TTL_MS = 60_000, CATALOG_RETAIN_MS = 600_000, FUNDING_TTL_MS = 15_000;
/** The settled-history read: one deadline for all pages of both legs, and how long a kept snapshot answers after a failure. */
export const FUNDING_HISTORY_DEADLINE_MS = 60_000, FUNDING_HISTORY_SNAPSHOT_MS = 15_000;
const HYPERLIQUID = 'https://api.hyperliquid.xyz/info';

/** A read that failed with a reason fit for the page. */
export class ExchangeReadError extends Error {}

class BinanceCooldown extends Error {
  readonly status: number;
  constructor(status: number) { super(`Binance HTTP ${status} cooldown`); this.status = status; }
}

/** Short Chinese reason for a failed read; never echoes upstream bodies. */
export function exchangeError(error: unknown): string {
  if (error instanceof ExchangeReadError) return error.message;
  if (error instanceof BinanceCooldown) return `接口限流冷却中（HTTP ${error.status}）`;
  const value = error as { name?: string; message?: unknown } | null;
  const message = String(value?.message ?? '');
  const http = /HTTP (\d{3})/.exec(message);
  if (http) return http[1] === '451' ? '服务器所在地区被拒绝访问（HTTP 451）' : http[1] === '429' || http[1] === '418' ? `接口限流（HTTP ${http[1]}）` : `接口返回 HTTP ${http[1]}`;
  if (value?.name === 'TimeoutError' || value?.name === 'AbortError') return '请求超时';
  // The vendored parsers' own texts (fixed strings, never upstream content).
  if (/^Lighter /.test(message) && /[一-鿿]/.test(message)) return message;
  if (/Unsupported .* contract|contract unavailable|Missing or duplicate|Missing xyz:|Inactive xyz:|合约暂不可用/.test(message)) return '合约不可用或规格已变化';
  if (/not synchronized/.test(message)) return '两腿报价时间不同步';
  if (/Delayed or invalid/.test(message)) return '报价时间过旧或无效';
  if (/超过大小上限/.test(message)) return '交易所应答超过大小上限';
  if (/pagination|page limit|page size|page range|funding page|outside requested|Incomplete Lighter/.test(message)) return '历史分页不完整';
  return '响应无效或网络失败';
}

// JSON parse errors quote the reply, so only their name is logged.
const detail = (error: unknown): string => error instanceof SyntaxError ? error.name : (error instanceof Error ? error.message : String(error)).slice(0, 200);

export function createExchangeReader({ gate, oilQuote, hynixQuote, fetchImpl = fetch, now = Date.now, WebSocketImpl, log = line => process.stderr.write(`${line}\n`) }: {
  /** The Binance cooldown shared with the collectors: everything reads Binance from the same address. */
  gate: BinanceGate;
  /** The collectors' current quotes (null when that market is not configured or has none yet). */
  oilQuote: () => OilQuoteView | null;
  hynixQuote: () => HynixQuoteView | null;
  fetchImpl?: ExchangeFetcher; now?: () => number; WebSocketImpl?: typeof WebSocket; log?: (line: string) => void;
}) {
  const stopping = new AbortController();
  const cache = new Map<string, { value: unknown; until: number; at: number }>(), pending = new Map<string, Promise<unknown>>();

  async function request(url: string, init: RequestInit = {}): Promise<unknown> {
    const binance = new URL(url).hostname === 'fapi.binance.com';
    if (binance && now() < gate.until) throw new BinanceCooldown(gate.status);
    const signal = AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), stopping.signal, ...init.signal ? [init.signal] : []]);
    const response = boundedReply(await fetchImpl(url, { ...init, cache: 'no-store', signal }));
    if (binance && (response.status === 429 || response.status === 418)) {
      gate.until = Math.max(gate.until, now() + (response.status === 418 ? 120_000 : 60_000)); gate.status = response.status;
    }
    if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new Error(`Exchange market HTTP ${response.status}`); }
    return response.json();
  }
  /** One value per key for `ttl`; concurrent callers share the request in flight; a failure is not kept. */
  function shared<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    const previous = cache.get(key);
    if (previous && now() < previous.until) return Promise.resolve(previous.value as T);
    let operation = pending.get(key) as Promise<T> | undefined;
    if (!operation) {
      operation = Promise.resolve().then(load).then(value => {
        const at = now();
        cache.set(key, { value, until: at + ttl, at });
        return value;
      }).finally(() => pending.delete(key));
      pending.set(key, operation);
    }
    return operation;
  }
  /** Catalogs: an expired one refreshes in the background, and is used meanwhile while no older than CATALOG_RETAIN_MS. */
  function retained<T>(key: string, load: () => Promise<T>): Promise<T> {
    const previous = cache.get(key), refresh = shared(key, CATALOG_TTL_MS, load);
    if (!previous || now() >= previous.at + CATALOG_RETAIN_MS) return refresh;
    refresh.catch(() => undefined);
    return Promise.resolve(previous.value as T);
  }
  const optional = <T>(read: Promise<T>): Promise<T | null> => read.catch(() => null);

  const hyperliquidContexts = () => shared('hyperliquid/xyz', EXCHANGE_RESULT_TTL_MS, async () => ({
    reply: await request(HYPERLIQUID, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'metaAndAssetCtxs', dex: 'xyz' }) }),
    receivedAt: now(),
  }));

  async function read(exchange: Exchange, market: SpreadMarket): Promise<ExchangeQuote> {
    const contracts = EXCHANGE_CONTRACTS[market], bases = [contracts.leftBase, contracts.rightBase];
    switch (exchange) {
      case 'hyperliquid': {
        if (market === 'oil') { const { reply, receivedAt } = await hyperliquidContexts(); return hyperliquidOilQuote(reply, receivedAt); }
        const quote = hynixQuote();
        if (!quote) throw new ExchangeReadError('尚未取得海力士报价，后台正在采集');
        const stale = quote.status === 'snapshot';
        // The funding joins only a current quote: a snapshot's time would be too far from the funding's.
        let contexts: { contexts: HyperliquidContext[]; receivedAt: number } | null = null;
        if (!stale) {
          try { const { reply, receivedAt } = await hyperliquidContexts(); contexts = { contexts: parseHyperliquidContexts(reply, ['xyz:SKHY', 'xyz:SKHX']), receivedAt }; }
          catch { contexts = null; }
        }
        try { return hyperliquidHynixQuote(quote, contexts, stale); }
        catch (error) { if (!contexts) throw error; return hyperliquidHynixQuote(quote, null, stale); }
      }
      case 'binance': {
        if (market === 'oil') {
          const quote = oilQuote();
          if (!quote) throw new ExchangeReadError('尚未取得原油报价，后台正在采集');
          return binanceOilExchangeQuote(quote, quote.status === 'snapshot');
        }
        const [left, right, funding] = await Promise.all([
          request(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${contracts.left}`),
          request(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${contracts.right}`),
          optional(shared('binance/funding', FUNDING_TTL_MS, async () => { const reply = await request('https://fapi.binance.com/fapi/v1/fundingInfo'); if (!Array.isArray(reply)) throw new Error('Invalid fundingInfo'); return reply; })),
        ]);
        return parseBinanceQuote(market, [left, right], funding, now());
      }
      case 'bybit': {
        const symbols = [contracts.left, contracts.right];
        const [instruments, tickers] = await Promise.all([
          Promise.all(symbols.map(symbol => retained(`bybit/instruments/${symbol}`, async () => bybitInstruments(await request(`https://api.bybit.com/v5/market/instruments-info?category=linear&symbol=${symbol}`))))),
          Promise.all(symbols.map(symbol => request(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`))),
        ]);
        return parseBybitQuote(market, instruments.flat(), tickers, now());
      }
      case 'okx': {
        const ids = bases.map(base => `${base}-USDT-SWAP`);
        const [instruments, marks, funding] = await Promise.all([
          Promise.all(ids.map(id => retained(`okx/instruments/${id}`, async () => checkedReply('okx', await request(`https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId=${id}`), id)))),
          Promise.all(ids.map(id => request(`https://www.okx.com/api/v5/public/mark-price?instType=SWAP&instId=${id}`))),
          Promise.all(ids.map(id => optional(shared(`okx/funding/${id}`, FUNDING_TTL_MS, async () => checkedReply('okx', await request(`https://www.okx.com/api/v5/public/funding-rate?instId=${id}`), id))))),
        ]);
        return parseOkxQuote(market, instruments, marks, funding, now());
      }
      case 'bitget': {
        const symbols = bases.map(base => `${base}USDT`);
        const [instruments, tickers, funding] = await Promise.all([
          Promise.all(symbols.map(symbol => retained(`bitget/instruments/${symbol}`, async () => checkedReply('bitget', await request(`https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES&symbol=${symbol}`), symbol)))),
          Promise.all(symbols.map(symbol => request(`https://api.bitget.com/api/v2/mix/market/ticker?productType=USDT-FUTURES&symbol=${symbol}`))),
          Promise.all(symbols.map(symbol => optional(shared(`bitget/funding/${symbol}`, FUNDING_TTL_MS, async () => checkedReply('bitget', await request(`https://api.bitget.com/api/v2/mix/market/current-fund-rate?productType=USDT-FUTURES&symbol=${symbol}`), symbol))))),
        ]);
        return parseBitgetQuote(market, instruments, tickers, funding, now());
      }
      case 'gate': {
        const details = await Promise.all(bases.map(base => request(`https://api.gateio.ws/api/v4/futures/usdt/contracts/${base}_USDT`)));
        return parseGateQuote(market, details, now());
      }
      case 'lighter': {
        const markets = await retained('lighter/markets', async () => parseLighterOilMarkets(await request(`${LIGHTER_ORIGIN}/api/v1/orderBookDetails`))) as LighterMarket[];
        return readLighterOilSnapshot(markets, { clock: now, signal: stopping.signal, ...(WebSocketImpl ? { WebSocketImpl } : {}) });
      }
      default: throw new ExchangeReadError('不支持的交易所');
    }
  }

  const lighterMarkets = () => retained('lighter/markets', async () => parseLighterOilMarkets(await request(`${LIGHTER_ORIGIN}/api/v1/orderBookDetails`))) as Promise<LighterMarket[]>;
  // Settled histories by market/exchange: the last good snapshot stays as the base of the next incremental read. `failure`
  // is why the round behind the entry failed (both legs, or one leg of a live snapshot), for the log. A failure with nothing
  // to keep is held for the snapshot interval too, so pages retrying every 30 s do not each start a 60-day read.
  type HistoryEntry = { value: ExchangeFundingHistory; until: number; failure: unknown };
  const histories = new Map<string, HistoryEntry>(), historyPending = new Map<string, Promise<HistoryEntry>>();
  const historyFailures = new Map<string, { until: number; error: unknown }>();
  function readHistory(market: SpreadMarket, exchange: Exchange, key: string): Promise<HistoryEntry> {
    const previous = histories.get(key);
    if (previous && now() < previous.until) return Promise.resolve(previous);
    const held = previous ? undefined : historyFailures.get(key);
    if (held && now() < held.until) return Promise.reject(held.error);
    let operation = historyPending.get(key);
    if (!operation) {
      const deadline = AbortSignal.timeout(FUNDING_HISTORY_DEADLINE_MS);
      const legErrors: unknown[] = [];
      const reader = createFundingLegReader({ request: (url, init = {}) => request(url, { ...init, signal: deadline }), clock: now, lighterMarkets });
      const readLeg: typeof reader = (...args) => reader(...args).catch(error => { legErrors.push(error); throw error; });
      operation = mergeFundingHistory({ exchange, monitorId: market, previous: previous?.value ?? null, readLeg, clock: now }).then(value => {
        const entry = { value, until: now() + HISTORY_REFRESH_MS, failure: legErrors[0] ?? null };
        histories.set(key, entry);
        historyFailures.delete(key);
        return entry;
      }, error => {
        if (!previous) {
          const failure = legErrors[0] ?? error;
          historyFailures.set(key, { until: now() + FUNDING_HISTORY_SNAPSHOT_MS, error: failure });
          throw failure;
        }
        // The previous snapshot answers for a short while; its records keep their own receipt times.
        const entry = { value: { ...previous.value, status: 'snapshot' as const, reason: '历史结算费率暂时更新失败，保留上次成功记录。' }, until: now() + FUNDING_HISTORY_SNAPSHOT_MS, failure: legErrors[0] ?? error };
        histories.set(key, entry);
        return entry;
      }).finally(() => historyPending.delete(key));
      historyPending.set(key, operation);
    }
    return operation;
  }

  // Logs each exchange's failure when its reason changes and the recovery once, so a page left open does not log every 15 s.
  const lastFailure = new Map<string, string>();
  const failed = (key: string, error: unknown): string => {
    const reason = exchangeError(error);
    if (lastFailure.get(key) !== reason && !stopping.signal.aborted) log(`交易所对比 ${key} 读取失败：${reason}（${detail(error)}）`);
    lastFailure.set(key, reason);
    return reason;
  };
  return {
    /** One exchange's current comparison row; rejects with an ExchangeReadError carrying the page's reason. */
    async quote(market: SpreadMarket, exchange: Exchange): Promise<ExchangeQuote> {
      if (!supportsExchange(market, exchange)) throw new ExchangeReadError('不支持的交易所');
      const key = `${market}/${exchange}`;
      try {
        const value = await shared(`result/${key}`, EXCHANGE_RESULT_TTL_MS, () => read(exchange, market));
        if (lastFailure.delete(key)) log(`交易所对比 ${key} 已恢复`);
        return value;
      } catch (error) {
        // The reader's own reasons (a collector without a quote yet) are states, not failures worth a log line.
        if (error instanceof ExchangeReadError) throw error;
        throw new ExchangeReadError(failed(key, error));
      }
    },
    /** One exchange's settled funding history (M-2d-3); rejects with an ExchangeReadError only when there is nothing to keep. */
    async fundingHistory(market: SpreadMarket, exchange: Exchange): Promise<ExchangeFundingHistory> {
      if (!supportsFundingHistory(market, exchange)) throw new ExchangeReadError('不支持的交易所');
      const key = `${market}/${exchange}/funding-history`;
      let entry: HistoryEntry;
      try { entry = await readHistory(market, exchange, key); }
      catch (error) { throw new ExchangeReadError(failed(key, error)); }
      if (entry.failure) failed(key, entry.failure);
      else if (lastFailure.delete(key)) log(`交易所对比 ${key} 已恢复`);
      return entry.value;
    },
    /** Ends the requests in flight (at stopping). */
    stop(): void { stopping.abort(); },
  };
}
export type ExchangeReader = ReturnType<typeof createExchangeReader>;
