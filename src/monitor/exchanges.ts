// Monitor M-2c: the multi-exchange comparison for oil and Hynix, read on demand. Nothing runs in the background: a page that
// shows the comparison asks for one exchange at a time (every 15 s). Raw venue reads share five seconds and one request in
// flight. The executor also restores verified public display rows from monitor.sqlite (exchange-quote-cache.ts).
// Each venue request has a 10 s deadline. Contract catalogs are kept 60 s and, while a refresh fails, used up to 10 minutes.
// Oil on Binance comes from the oil collector's quote and Hynix on Hyperliquid from the Hynix collector's mids, so they cost
// no extra Binance or allMids reads.
// M-2d-3: one exchange's settled funding history (60 days, both legs), read only while a page has its panel open. A snapshot
// is shared for 5 minutes. The executor stores each leg's original settlements and completed windows. Both the comparison
// and the scheduled collector page only what is missing, and keep independently verified legs when their peer fails.
// M-3d: Variational (oil only), as the workbench's lib/oil-dex.ts createOilDexReader (8470785): with a usable saved token the
// authenticated marks, otherwise (or when they fail) the public metadata/stats marks; the public predicted funding joins
// either. A read that finds the token changed meanwhile is dropped and read again (twice at most, then the public marks),
// so an old token's verdict never lands on a new one. Variational has no settlement history.
import {
  LIGHTER_ORIGIN, binanceOilExchangeQuote, bybitInstruments, hyperliquidHynixQuote, hyperliquidOilQuote, parseBinanceQuote, parseBitgetQuote,
  parseBybitQuote, parseGateQuote, checkedReply, parseHyperliquidContexts, parseLighterOilMarkets, parseOkxQuote, readLighterOilSnapshot, supportsExchange,
  EXCHANGE_CONTRACTS, exchangeDefinition, type Exchange, type ExchangeQuote, type HyperliquidContext, type LighterMarket, type SpreadMarket,
} from '../vendor/exchange-comparison.mjs';
import type { RemoteComparison } from '../service/remote-monitor.ts';
import type { BinanceGate } from '../vendor/anthropic-market.mjs';
import { HISTORY_REFRESH_MS, HISTORY_STALE_MS, HISTORY_WINDOW_MS, createFundingLegReader, supportsFundingHistory, validateExchangeFundingHistory, type ExchangeFundingHistory, type FundingFact, type FundingHistoryRange } from '../vendor/exchange-funding-history.mjs';
import { FUNDING_PUBLICATION_GRACE_MS, fundingGap, settlementSchedule, settlementSlot } from '../vendor/funding-schedule.ts';
import { createFundingArchive, FundingArchiveWriteError, type FundingArchive, type FundingSide, type ReadFundingLeg } from './funding-archive.ts';
import { createMarketReaders } from './market-readers.ts';
import type { HynixQuote } from '../vendor/hynix-market.mjs';
import type { HynixQuoteView } from './hynix.ts';
import type { OilQuoteView } from './oil.ts';
import { boundedReply, BinanceCooldown } from './market-contract.ts';
import type { SharedMarketReads } from './shared-reads.ts';
import {
  VARIATIONAL_STATS, parseVariationalOilQuote, readVariationalAuthenticatedMarks, readVariationalPublicFunding, withVariationalFunding,
  type VariationalFetcher, type VariationalPublicFunding,
} from '../vendor/variational-market.mjs';
import type { VariationalSession } from './variational-session.ts';
import { createStoredExchangeQuotes } from './exchange-quote-cache.ts';
import type { MonitorStore } from './store.ts';
import { anySignal } from '../any-signal.mjs';

type ComparisonHynix = HynixQuote & { status: HynixQuoteView['status'] };
export type ExchangeFetcher = (url: string, init: RequestInit) => Promise<Response>;
export const EXCHANGE_RESULT_TTL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 10_000, CATALOG_TTL_MS = 60_000, CATALOG_RETAIN_MS = 600_000, FUNDING_TTL_MS = 15_000;
/** The settled-history read: one deadline for all pages of both legs, and how long a kept snapshot answers after a failure. */
export const FUNDING_HISTORY_DEADLINE_MS = 60_000, FUNDING_HISTORY_SNAPSHOT_MS = 15_000;
const HYPERLIQUID = 'https://api.hyperliquid.xyz/info';

/** A read that failed with a reason fit for the page. */
export class ExchangeReadError extends Error {}

/** Short Chinese reason for a failed read; never echoes upstream bodies. */
export function exchangeError(error: unknown): string {
  if (error instanceof ExchangeReadError) return error.message;
  if (error instanceof FundingArchiveWriteError) return 'monitor.sqlite 写入失败';
  if (error instanceof BinanceCooldown) return `接口限流冷却中（HTTP ${error.status}）`;
  const value = error as { name?: string; message?: unknown } | null;
  const message = String(value?.message ?? '');
  const http = /HTTP (\d{3})/.exec(message);
  if (http) return http[1] === '451' ? '服务器所在地区被拒绝访问（HTTP 451）' : http[1] === '429' || http[1] === '418' ? `接口限流（HTTP ${http[1]}）` : `接口返回 HTTP ${http[1]}`;
  // Variational's fixed texts (requestVariational and the Var parsers), never upstream content.
  if ((value as { variational?: unknown } | null)?.variational === true || /^Var /.test(message)) { if (/[一-鿿]/.test(message)) return message; }
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

export function createExchangeReader({ gate, oilQuote, hynixQuote, variationalSession, variationalFetch, remote, shared: common, quoteStore, controlRevision, epoch, fetchImpl = fetch, now = Date.now, archive = createFundingArchive(undefined, now), WebSocketImpl, log = line => process.stderr.write(`${line}\n`) }: {
  /** The Binance cooldown shared with the collectors: everything reads Binance from the same address. */
  gate: BinanceGate; remote?: RemoteComparison; archive?: FundingArchive;
  /** Supplied by the executor only. The market service has no monitor database. */
  quoteStore?: Pick<MonitorStore, 'readState' | 'writeState'>;
  controlRevision?: (market: SpreadMarket) => number | null; epoch?: () => string | null;
  /** The market service's reads in common with the cards and the collector (./shared-reads.ts); absent, this reader keeps its own. */
  shared?: SharedMarketReads;
  /** The collectors' current quotes (null when that market is not configured or has none yet). */
  oilQuote: () => OilQuoteView | null;
  hynixQuote: () => HynixQuoteView | null;
  /** M-3d: the saved token (absent: public marks only) and the transport to omni.variational.io (absent: no predicted funding). */
  variationalSession?: VariationalSession; variationalFetch?: VariationalFetcher;
  fetchImpl?: ExchangeFetcher; now?: () => number; WebSocketImpl?: typeof WebSocket; log?: (line: string) => void;
}) {
  const stopping = new AbortController();
  const cache = new Map<string, { value: unknown; until: number; at: number; scope: string }>();
  const pending = new Map<string, { done: Promise<unknown>; scope: string }>();

  async function request(url: string, init: RequestInit = {}): Promise<unknown> {
    const binance = new URL(url).hostname === 'fapi.binance.com';
    if (binance && now() < gate.until) throw new BinanceCooldown(gate.status);
    const signal = anySignal([stopping.signal, init.signal], REQUEST_TIMEOUT_MS);
    const response = boundedReply(await fetchImpl(url, { ...init, cache: 'no-store', signal }));
    if (binance && (response.status === 429 || response.status === 418)) {
      gate.until = Math.max(gate.until, now() + (response.status === 418 ? 120_000 : 60_000)); gate.status = response.status;
    }
    if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new Error(`Exchange market HTTP ${response.status}`); }
    return response.json();
  }
  /** One value per key for `ttl`; concurrent callers share the request in flight; a failure is not kept. */
  function shared<T>(key: string, ttl: number, load: () => Promise<T>, scope = ''): Promise<T> {
    const previous = cache.get(key);
    if (previous?.scope === scope && now() >= previous.at && now() < previous.until) return Promise.resolve(previous.value as T);
    const busy = pending.get(key);
    if (busy?.scope === scope) return busy.done as Promise<T>;
    const operation = Promise.resolve().then(load).then(value => {
      if (pending.get(key)?.done === operation && !stopping.signal.aborted) {
        const at = now();
        cache.set(key, { value, until: at + ttl, at, scope });
      }
      return value;
    }).finally(() => { if (pending.get(key)?.done === operation) pending.delete(key); });
    pending.set(key, { done: operation, scope });
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

  const hyperliquidContexts = () => common ? common.xyzContexts(EXCHANGE_RESULT_TTL_MS) : shared('hyperliquid/xyz', EXCHANGE_RESULT_TTL_MS, async () => ({
    reply: await request(HYPERLIQUID, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'metaAndAssetCtxs', dex: 'xyz' }) }),
    receivedAt: now(),
  }));

  // ---- Variational (oil) ----
  // The parts of the Var row that fail without failing the row, each logged once per reason like an exchange.
  const VARIATIONAL_AUTH = 'oil/variational 认证行情', VARIATIONAL_FUNDING = 'oil/variational 公开资金费';
  const variationalSignal = () => anySignal([stopping.signal], REQUEST_TIMEOUT_MS);
  const marketEpoch = () => epoch ? epoch() ?? 'offline' : 'local';
  const variationalRun = () => controlRevision ? controlRevision('oil') : 0;
  const checkVariationalRun = (run: number | null) => {
    stopping.signal.throwIfAborted();
    if (run === null || run !== variationalRun()) throw new ExchangeReadError('监控开关已切换，请重新读取');
  };
  const publicVariational = () => shared('variational/oil/public', 1_000, () => remote ? remote.variationalMarks(stopping.signal) : request(VARIATIONAL_STATS).then(reply => parseVariationalOilQuote(reply, now())), `${variationalRun()}/${marketEpoch()}`);
  type SessionRead = ReturnType<VariationalSession['current']>;
  const sameSession = (before: SessionRead) => { const current = variationalSession!.current(); return current.revision === before.revision && current.token === before.token; };
  const variationalSources = new WeakMap<ExchangeQuote, { authRevision: number | null; fundingEpoch: string }>();
  const authChanged = (quote: ExchangeQuote) => {
    const revision = variationalSources.get(quote)?.authRevision;
    if (revision == null) return false;
    const current = variationalSession!.current();
    return !current.token || current.revision !== revision;
  };
  async function variationalMarks(run: number | null): Promise<{ quote: ExchangeQuote; session: SessionRead | null }> {
    if (!variationalSession || !variationalFetch) return { quote: await publicVariational(), session: null };
    const fetcher = variationalFetch;
    for (let attempt = 0; attempt < 2; attempt++) {
      const session = variationalSession.current();
      if (session.token) {
        const token = session.token;
        try {
          const quote = await shared('variational/oil/authenticated', 1_000, () => readVariationalAuthenticatedMarks(token, { fetcher, clock: now, signal: variationalSignal() }), `${run}/${session.revision}`);
          checkVariationalRun(run);
          if (!sameSession(session)) continue;
          variationalSession.report(session.revision, 'ready');
          recovered(VARIATIONAL_AUTH);
          return { quote, session };
        } catch (error) {
          checkVariationalRun(run);
          if (!sameSession(session)) continue;
          const denied = Boolean(error && typeof error === 'object' && 'rejected' in error && error.rejected === true);
          // The reason (blocked, timed out, no Python…) reaches the log once per change and the form.
          variationalSession.report(session.revision, denied ? 'rejected' : 'unavailable', failed(VARIATIONAL_AUTH, error));
        }
      }
      const fallbackSession = variationalSession.current();
      try {
        const quote = await publicVariational();
        if (!sameSession(fallbackSession)) continue;
        return { quote, session: null };
      } catch (error) {
        if (!sameSession(fallbackSession)) continue;
        throw error;
      }
    }
    // Continuous session changes must not interrupt public market data.
    return { quote: await publicVariational(), session: null };
  }
  async function readVariational(): Promise<ExchangeQuote> {
    const fetcher = variationalFetch, run = variationalRun(), fundingEpoch = marketEpoch();
    checkVariationalRun(run);
    const [initialMarks, funding] = await Promise.all([
      variationalMarks(run),
      (fetcher || remote) ? shared('variational/oil/public-funding', 1_000, () => remote ? remote.variationalFunding(variationalSignal()) : readVariationalPublicFunding({ fetcher: fetcher!, clock: now, signal: variationalSignal() }), `${run}/${fundingEpoch}`)
        .then(value => { checkVariationalRun(run); recovered(VARIATIONAL_FUNDING); return { value, reason: '' }; }, (error: unknown) => {
          checkVariationalRun(run); return { value: null, reason: failed(VARIATIONAL_FUNDING, error) };
        })
        : Promise.resolve({ value: null, reason: '' }),
    ]);
    let marks = initialMarks;
    // Funding can finish after a rotation even when the old marks finished first.
    if (marks.session && !sameSession(marks.session)) marks = await variationalMarks(run);
    if (marks.session && !sameSession(marks.session)) marks = { quote: await publicVariational(), session: null };
    checkVariationalRun(run);
    const switched = fundingEpoch === 'offline' || marketEpoch() !== fundingEpoch;
    const prices = switched && marks.quote.timestampBasis === 'received' ? { ...marks.quote, status: 'snapshot' as const } : marks.quote;
    const row = withVariationalFunding(prices, switched ? null : funding.value as VariationalPublicFunding | null, now(), switched && funding.value ? '行情服务连接已切换' : funding.reason);
    variationalSources.set(row, { authRevision: marks.session?.revision ?? null, fundingEpoch });
    return row;
  }

  async function read(exchange: Exchange, market: SpreadMarket, savedHynix?: ComparisonHynix | null): Promise<ExchangeQuote> {
    // Binance oil is a pure projection of the persisted quote; only Var's authenticated marks use the token.
    if (remote && exchange !== 'variational' && !(market === 'oil' && exchange === 'binance')) {
      return remote.quote(market, exchange, market === 'hynix' && exchange === 'hyperliquid' ? hynixQuote() : null, stopping.signal);
    }
    const contracts = EXCHANGE_CONTRACTS[market], bases = [contracts.leftBase, contracts.rightBase];
    switch (exchange) {
      case 'hyperliquid': {
        if (market === 'oil') { const { reply, receivedAt } = await hyperliquidContexts(); return hyperliquidOilQuote(reply, receivedAt); }
        const quote = savedHynix === undefined ? hynixQuote() : savedHynix;
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
        const fundingInfo = optional(common ? common.fundingInfo() : shared('binance/funding', FUNDING_TTL_MS, async () => { const reply = await request('https://fapi.binance.com/fapi/v1/fundingInfo'); if (!Array.isArray(reply)) throw new Error('Invalid fundingInfo'); return reply as unknown[]; }));
        // Marks the spread collector received moments ago stand in for the two premiumIndex reads; otherwise read them.
        const rows = common?.binanceMarks([contracts.left, contracts.right]);
        if (rows) { try { return parseBinanceQuote(market, rows, await fundingInfo, now()); } catch { /* read premiumIndex instead */ } }
        const [left, right, funding] = await Promise.all([
          request(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${contracts.left}`),
          request(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${contracts.right}`),
          fundingInfo,
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
      case 'variational': return readVariational();
      default: throw new ExchangeReadError('不支持的交易所');
    }
  }

  const lighterMarkets = () => retained('lighter/markets', async () => parseLighterOilMarkets(await request(`${LIGHTER_ORIGIN}/api/v1/orderBookDetails`))) as Promise<LighterMarket[]>;
  const primary = createMarketReaders({ gate, fetchImpl, now });
  const rawFunding: ReadFundingLeg = (market, exchange, side, range, signal) => {
    if (remote) return remote.history(market, exchange, side, range, signal);
    if (market === 'oil' && exchange === 'binance') return primary.oilFunding(side, range, signal);
    if (market === 'hynix' && exchange === 'hyperliquid') return primary.hynixFunding(side, range, signal);
    const reader = createFundingLegReader({ request: (url, init) => request(url, { ...init, signal }), clock: now, lighterMarkets });
    return reader(exchange, exchangeDefinition(exchange, market)[side], range);
  };

  async function updateHistory(market: SpreadMarket, exchange: Exchange, at: number, signal: AbortSignal) {
    const requested = { from: at - HISTORY_WINDOW_MS, to: at }, sides = ['left', 'right'] as const;
    const definition = exchangeDefinition(exchange, market);
    const cadence = exchange === 'hyperliquid' || exchange === 'lighter' ? 1 : market === 'oil' && exchange === 'binance' ? 4 : null;
    function timing(records: FundingFact[], through: number) {
      const regular = records.filter(row => !row.special), schedule = settlementSchedule(regular, cadence);
      const last = regular.at(-1), due = last && schedule ? settlementSlot(last.time, schedule) + schedule.interval : null;
      const readAt = due !== null && through < due + FUNDING_PUBLICATION_GRACE_MS ? due + FUNDING_PUBLICATION_GRACE_MS : through + HISTORY_REFRESH_MS;
      return { regular, schedule, readAt, freshUntil: (due ?? through) + HISTORY_STALE_MS };
    }
    const results = await Promise.allSettled(sides.map(async side => {
      const saved = archive.inspect(market, exchange, side, requested);
      const latest = saved.proofs.at(-1)?.to;
      // A settled tail is current until the next publication. Always fill unqueried intervals earlier in the window.
      const to = latest !== undefined && at < timing(saved.records, latest).readAt ? Math.min(latest, at) : at;
      const leg = await archive.read(market, exchange, side, { from: requested.from, to }, rawFunding, signal);
      const { regular, schedule } = timing(leg.records, to);
      if (!schedule) return;
      const lastDue = settlementSlot(to - FUNDING_PUBLICATION_GRACE_MS, schedule);
      // A completed but empty publication at the tail gets another chance. Older holes need at most one repair per read.
      const last = regular.at(-1), late = !last || settlementSlot(last.time, schedule) < lastDue;
      const cutoff = at - (late ? HISTORY_REFRESH_MS : 3_600_000) + 1;
      const checked = leg.proofs.filter(p => p.checkedAt >= cutoff);
      // Skip slots just verified by either consumer, even if the venue still has no record.
      const gap = late ? lastDue : fundingGap(regular, schedule, requested.from, lastDue, 0, checked);
      if (gap !== null && gap >= requested.from) {
        await archive.read(market, exchange, side, { from: gap, to: Math.min(to, gap + schedule.interval - 1) }, rawFunding, signal, cutoff);
      }
    }));
    // Freeze the displayed 60 days at their actual latest query end. Receipts can follow that end by several pages.
    const end = Math.min(at, Math.max(...sides.map(side => archive.inspect(market, exchange, side, requested).proofs.at(-1)?.to ?? 0)));
    const window = { from: end - HISTORY_WINDOW_MS, to: end };
    const rows = new Map<number, ExchangeFundingHistory['rows'][number]>();
    let checkAt = at + HISTORY_REFRESH_MS;
    const leg = (side: FundingSide, i: number) => {
      const saved = archive.inspect(market, exchange, side, window);
      const ranges: FundingHistoryRange[] = [];
      for (const proof of saved.proofs) {
        const last = ranges.at(-1), to = Math.min(end, proof.to);
        if (last && last.to + 1 >= proof.from) last.to = to;
        else ranges.push({ from: Math.max(window.from, proof.from), to });
      }
      for (const fact of saved.records) {
        const row = rows.get(fact.time) ?? { time: fact.time, leftRate: null, rightRate: null };
        row[`${side}Rate`] = fact.rate; rows.set(fact.time, row);
      }
      const coverage = ranges.at(-1) ?? null, terms = coverage && timing(saved.records, coverage.to);
      if (terms && terms.readAt > at) checkAt = Math.min(checkAt, terms.readAt);
      return { symbol: definition[side], coverage, ...(terms ? { freshUntil: terms.freshUntil } : {}), ...(ranges.length > 1 ? { ranges } : {}),
        fetchedAt: saved.fetchedAt ? new Date(saved.fetchedAt).toISOString() : null, error: results[i]!.status === 'rejected' ? '本合约历史结算费率暂时读取失败，保留上次成功记录。' : '' };
    };
    const left = leg('left', 0), right = leg('right', 1);
    const failure = results.find(result => result.status === 'rejected')?.reason as unknown;
    if (!left.fetchedAt && !right.fetchedAt) throw failure ?? Error('Actual funding history unavailable');
    const bothFailed = results.every(result => result.status === 'rejected');
    const reason = bothFailed ? '历史结算费率暂时更新失败，保留上次成功记录。' : failure ? '部分合约更新失败，请查看各合约采集时间。' : '';
    const fetchedAt = new Date(Math.max(...[left, right].map(side => side.fetchedAt ? Date.parse(side.fetchedAt) : 0))).toISOString();
    const value = validateExchangeFundingHistory({ exchange, monitorId: market, currency: definition.currency, fetchedAt, left, right,
      rows: [...rows.values()], status: bothFailed ? 'snapshot' : 'live', reason }, exchange, market);
    return { value, until: failure ? at + FUNDING_HISTORY_SNAPSHOT_MS : checkAt, failure };
  }
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
      const deadline = anySignal([stopping.signal], FUNDING_HISTORY_DEADLINE_MS);
      operation = updateHistory(market, exchange, now(), deadline).then(entry => {
        histories.set(key, entry);
        historyFailures.delete(key);
        return entry;
      }, error => {
        if (!previous) {
          historyFailures.set(key, { until: now() + FUNDING_HISTORY_SNAPSHOT_MS, error });
          throw error;
        }
        // The previous snapshot answers for a short while; its records keep their own receipt times.
        const entry = { value: { ...previous.value, status: 'snapshot' as const, reason: '历史结算费率暂时更新失败，保留上次成功记录。' }, until: now() + FUNDING_HISTORY_SNAPSHOT_MS, failure: error };
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
  const recovered = (key: string) => { if (lastFailure.delete(key)) log(`交易所对比 ${key} 已恢复`); };
  async function currentQuote(market: SpreadMarket, exchange: Exchange, savedHynix?: ComparisonHynix | null): Promise<ExchangeQuote> {
    const key = `${market}/${exchange}`, run = controlRevision?.(market);
    const checkRun = () => {
      if (run === null || controlRevision?.(market) !== run) throw new ExchangeReadError('监控开关已切换，请重新读取');
    };
    checkRun();
    // Check before and after the remote read. A live Hynix comparison loses its funding as soon as the collector disconnects.
    const savedRow = () => {
      if (market !== 'hynix' || exchange !== 'hyperliquid') return null;
      const quote = savedHynix === undefined ? hynixQuote() : savedHynix;
      if (!quote) throw new ExchangeReadError('尚未取得海力士报价，后台正在采集');
      return quote.status === 'snapshot' ? hyperliquidHynixQuote(quote, null, true) : null;
    };
    const snapshot = savedRow();
    if (snapshot) return snapshot;
    try {
      const session = exchange === 'variational' ? variationalSession?.current() : undefined;
      const revision = session ? `/${session.revision}/${session.token ? 'authenticated' : 'public'}` : '';
      // The executor shares its own public results. An inner five-second row from a previous run must not
      // revalidate the executor's display after a reconnection. The worker still shares raw reads.
      const value = quoteStore && !session?.token ? await read(exchange, market, savedHynix)
        : await shared(`result/${key}`, EXCHANGE_RESULT_TTL_MS, () => read(exchange, market, savedHynix), `${run ?? ''}/${marketEpoch()}${revision}`);
      checkRun();
      recovered(key);
      return savedRow() ?? value;
    } catch (error) {
      checkRun();
      const snapshot = savedRow();
      if (snapshot) return snapshot;
      if (error instanceof ExchangeReadError || remote && exchange !== 'variational') throw error;
      throw new ExchangeReadError(failed(key, error));
    }
  }
  const publicScope = (market: SpreadMarket, exchange: Exchange) => {
    const run = controlRevision ? controlRevision(market) : 0;
    const session = exchange === 'variational' ? variationalSession?.current() : undefined;
    return run === null ? null : `${run}/${session?.revision ?? 0}/${session?.token ? 'authenticated' : 'public'}`;
  };
  const storedQuote = quoteStore ? createStoredExchangeQuotes({ store: quoteStore, read: currentQuote, scope: publicScope,
    ...(epoch ? { epoch } : {}), signal: stopping.signal, now, log }) : null;
  const displayQuote = (market: SpreadMarket, exchange: Exchange, savedHynix?: ComparisonHynix | null) => {
    if (!storedQuote || (market === 'oil' && exchange === 'binance') || (market === 'hynix' && exchange === 'hyperliquid')) return currentQuote(market, exchange, savedHynix);
    if (exchange === 'variational' && variationalSession) {
      const session = variationalSession.current(), run = variationalRun();
      if (session.token) return storedQuote.variational(() => run !== null && run === variationalRun() && session.revision === variationalSession.current().revision);
    }
    return storedQuote.read(market, exchange);
  };
  return {
    publicVariational, rawFunding,
    /** The primary Binance oil and Hyperliquid Hynix prices already have a collector-owned persisted source. */
    async quote(market: SpreadMarket, exchange: Exchange, savedHynix?: ComparisonHynix | null): Promise<ExchangeQuote> {
      if (!supportsExchange(market, exchange)) throw new ExchangeReadError('不支持的交易所');
      const run = controlRevision?.(market), sourceEpoch = marketEpoch();
      let quote = await displayQuote(market, exchange, savedHynix);
      // A shared result can resolve just as the eligible token expires or changes. Its actual producing
      // revision follows it through the in-memory read; no credential or revision goes into the JSON row.
      if (authChanged(quote)) {
        quote = await displayQuote(market, exchange, savedHynix);
        if (authChanged(quote)) quote = await publicVariational();
      }
      if (run === null || run !== controlRevision?.(market)) throw new ExchangeReadError('监控开关已切换，请重新读取');
      stopping.signal.throwIfAborted();
      // An authenticated price comes from this process. Funding comes from the public feed and may
      // cross its settlement instant or lose its connection even while this cached row is being delivered.
      if (exchange === 'variational' && quote.status === 'live') {
        const observed = variationalSources.get(quote)?.fundingEpoch ?? sourceEpoch;
        const switched = observed === 'offline' || observed !== marketEpoch();
        const at = now(), settled = [quote.left, quote.right].some(leg => leg.nextFundingAt !== null && Date.parse(leg.nextFundingAt) <= at);
        if (quote.fundingFetchedAt !== null && (switched || settled)) quote = withVariationalFunding(quote, null, at, switched ? '行情服务连接已切换' : '预测结算时间已到');
        if (switched && quote.timestampBasis === 'received') quote = { ...quote, status: 'snapshot' };
      }
      return quote;
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
