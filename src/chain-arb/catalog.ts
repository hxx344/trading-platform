import { anySignal } from '../any-signal.mjs';
import { untilAborted } from '../asset/sources/shared-reads.ts';
import { isObject } from '../contracts.ts';
import { ExchangeResponseError, readJsonResponse } from '../vendor/response.mjs';
import { isSettlementOrNative } from './dex.ts';
import { gateChain, gateSpotSellable } from './gate.ts';
import { isGateBaseSymbol, type Chain } from './model.ts';

export interface ScanCandidate { chain: Chain; symbol: string; address: string; spot: boolean; perp: boolean }
type Row = Record<string, unknown>;
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
const TTL = 5 * 60_000;
const MAX_BYTES = 5 * 1024 * 1024, MAX_ROWS = 12_000, MAX_CHAINS = 128;
const INVALID = 'Gate 目录不完整或格式无效';

function candidates(currencies: Row[], pairs: Row[], tickers: Row[], now: number): ScanCandidate[] {
  const spot = new Map<string, Row | null>(), futures = new Set<string>();
  for (const pair of pairs) {
    if (typeof pair.id !== 'string' || !pair.id || typeof pair.base !== 'string' || !pair.base || typeof pair.quote !== 'string' || !pair.quote
      || typeof pair.type !== 'string' || typeof pair.trade_status !== 'string') throw new Error(INVALID);
    if (pair.quote === 'USDT' && pair.id === pair.base + '_USDT') spot.set(pair.base, spot.has(pair.base) ? null : pair);
  }
  for (const ticker of tickers) {
    if (typeof ticker.contract !== 'string' || !ticker.contract) throw new Error(INVALID);
    futures.add(ticker.contract);
  }

  const seenSymbols = new Set<string>(), duplicateSymbols = new Set<string>();
  const seenAddresses = new Set<string>(), duplicateAddresses = new Set<string>();
  const possible: ScanCandidate[] = [];
  for (const currency of currencies) {
    const symbol = currency.currency;
    if (typeof symbol !== 'string' || !symbol || !Array.isArray(currency.chains) || currency.chains.length > MAX_CHAINS
      || typeof currency.delisted !== 'boolean' || typeof currency.trade_disabled !== 'boolean'
      || typeof currency.deposit_disabled !== 'boolean') throw new Error(INVALID);
    if (seenSymbols.has(symbol)) duplicateSymbols.add(symbol);
    seenSymbols.add(symbol);
    const networks = new Map<Chain, Row | null>();
    for (const network of currency.chains) {
      if (!isObject(network) || typeof network.name !== 'string' || !network.name
        || typeof network.addr !== 'string' || typeof network.deposit_disabled !== 'boolean') throw new Error(INVALID);
      const chain = gateChain(network.name);
      if (!chain) continue;
      // An invalid address or a closed listing still counts as a conflicting chain entry.
      networks.set(chain, networks.has(chain) ? null : network);
      if (!/^0x[0-9a-f]{40}$/i.test(network.addr)) continue;
      const key = chain + ':' + network.addr.toLowerCase();
      if (seenAddresses.has(key)) duplicateAddresses.add(key);
      seenAddresses.add(key);
    }
    if (!isGateBaseSymbol(symbol)) continue;
    const pair = spot.get(symbol), sellable = pair && gateSpotSellable(pair, currency, now);
    const perpetual = futures.has(symbol + '_USDT');
    for (const [chain, network] of networks) {
      if (!network || typeof network.addr !== 'string' || !/^0x[0-9a-f]{40}$/i.test(network.addr)) continue;
      const address = network.addr.toLowerCase();
      if (isSettlementOrNative(chain, address)) continue;
      const spot = !!sellable && !currency.deposit_disabled && !network.deposit_disabled;
      if (perpetual || spot) possible.push({ chain, symbol, address, spot, perp: perpetual });
    }
  }
  const result = possible.filter(row => !duplicateSymbols.has(row.symbol) && !duplicateAddresses.has(row.chain + ':' + row.address));
  // Compare exact strings so pagination is independent of locale and Gate response order.
  return result.sort((a, b) => a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : a.chain < b.chain ? -1 : a.chain > b.chain ? 1 : 0);
}

export function createScanCatalog({ fetchImpl = fetch, now = Date.now }: { fetchImpl?: Fetcher; now?: () => number } = {}) {
  let cached: { rows: ScanCandidate[]; at: number; expires: number } | undefined;
  let pending: { result: Promise<ScanCandidate[]>; controller: AbortController; readers: number } | undefined;

  async function read(path: string, signal: AbortSignal, started: number) {
    let response: Response;
    try {
      response = await fetchImpl('https://api.gateio.ws/api/v4' + path, {
        method: 'GET', headers: { Accept: 'application/json' }, redirect: 'error', cache: 'no-store', signal,
      });
    } catch {
      throw new Error('Gate 目录接口连接失败');
    }
    const age = response.headers.get('age') ?? '0', expires = started + TTL - Number(age) * 1000;
    if (response.status !== 200 || response.headers.has('content-range') || !/^\d+$/.test(age) || now() >= expires) {
      void response.body?.cancel().catch(() => {});
      if (response.status === 429) throw Object.assign(new Error('Gate 目录请求受限，请稍后重试'), { status: 429 });
      if (response.status !== 200) throw new Error(`Gate 目录读取失败（HTTP ${response.status}）`);
      throw new Error('Gate 目录已过期或应答不完整');
    }
    const rows = await readJsonResponse(response, { signal, maxBytes: MAX_BYTES });
    if (!Array.isArray(rows) || !rows.length || rows.length > MAX_ROWS || !rows.every(isObject)) throw new Error(INVALID);
    return { rows, expires };
  }

  async function refresh(controller: AbortController, started: number) {
    const signal = anySignal([controller.signal], 12_000);
    try {
      const [currencies, pairs, tickers] = await untilAborted(Promise.all([
        read('/spot/currencies', signal, started), read('/spot/currency_pairs', signal, started),
        read('/futures/usdt/tickers', signal, started),
      ]), signal);
      const rows = candidates(currencies.rows, pairs.rows, tickers.rows, now());
      const expires = Math.min(currencies.expires, pairs.expires, tickers.expires);
      signal.throwIfAborted();
      if (now() >= expires || now() < started) throw new Error('Gate 目录已过期');
      cached = { rows, at: started, expires };
      return rows;
    } catch (error) {
      if (signal.aborted) throw new Error('Gate 目录读取超时或已取消');
      if (error instanceof ExchangeResponseError) throw new Error(error.code === 'response_limit' ? 'Gate 目录应答过大' : INVALID);
      throw error;
    } finally {
      controller.abort();
    }
  }

  return async function catalog(signal: AbortSignal): Promise<ScanCandidate[]> {
    signal.throwIfAborted();
    const started = now();
    if (cached && started >= cached.at && started < cached.expires) return cached.rows;
    cached = undefined;
    if (!pending || pending.controller.signal.aborted) {
      const controller = new AbortController();
      pending = { result: refresh(controller, started), controller, readers: 0 };
    }
    const job = pending;
    job.readers++;
    try {
      return await untilAborted(job.result, signal);
    } finally {
      if (--job.readers === 0) {
        job.controller.abort();
        if (pending === job) pending = undefined;
      }
    }
  };
}
