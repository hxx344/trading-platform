// Var/Lighter 价差模块的运行时（docs/varlighter.md）：采集对齐样本、维护各标的基线、跑模拟盘，并给页面出视图。
// 只读公开行情、只写自己的 varlighter.sqlite；不碰执行器、不下任何真实订单。
import { anySignal } from '../any-signal.mjs';
import { TOKEN_QUOTE_CONCURRENCY, TOKEN_QUOTE_MAX_AGE_MS, TOKEN_QUOTE_PHASE_MS, type TokenQuote, type VarQuoter } from './varquote.ts';
import { backtestRequest, runBacktest } from './backtest.ts';
import { LighterStream, MAX_DEPTH_MARKETS, depthAt, fetchDepth, fetchRhMarkets, fetchVarListings, type Connect, type DepthSnapshot, type FetchLike } from './feeds.ts';
import { KIND_NAMES, PAIR_KEY, REGIME_NAMES, SAMPLE_FIELDS, VENUES, VENUE_NAMES, bucketOf, hasTokenQuote, midBasis, pairMarkets, regimeOf, regimesOf, sortPairs, spreadOf, tickerOf, venueOf, type PairInfo, type RhMarket, type Sample, type VarListing, type Venue } from './model.ts';
import { orderPlan, type OrderPlan } from './plan.ts';
import { BaselineTracker, suggestedEntryBps, symbolStats, type Baseline, type RegimeStats } from './stats.ts';
import { DEFAULT_GLOBAL, DEFAULT_SYMBOL, ParamsError, closePosition, closeSpread, confirmOpen, decide, openEconomics, slippageBudgetBps, positionSpread, fundingEstimate, markToMarket, openBlocker, openPosition, readGlobalParams, readSymbolParams,
  CLOSE_REASON_NAMES, DIRECTION_NAMES, type ClosedTrade, type Direction, type GlobalParams, type Position, type SymbolParams } from './strategy.ts';
import { SAMPLE_RETENTION_DAYS, type VarLighterStore } from './store.ts';
import type { BacktestView, DepthStatus, OrphanRow, PaperView, PollStats, ReadinessItem, ReadinessView, SamplesView, Settings, SourceState, StateView, SymbolPoint, SymbolView, VenueStatus } from './views.ts';

export const VAR_POLL_MS = 60_000;
export const CATALOG_MS = 10 * 60_000;
const PRUNE_MS = 3_600_000;
const PRUNE_BATCH = 2_000;
const RECOUNT_MS = 10 * 60_000;
/** 数据源都正常、单个配对却这么久没有新样本，就算失联。 */
export const LOST_MS = 30 * 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
/** 参数里最多保存这么多个配对键（含已停用的）。 */
const MAX_SAVED_SYMBOLS = 500;
/** 上线前核对清单的门槛。 */
export const READY_BASELINE_DAYS = 3;
export const READY_PAPER_TRADES = 20;

export class VarLighterError extends Error {
  readonly status: number; readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
const reject = (code: string, message: string, status = 400): never => { throw new VarLighterError(status, code, message); };
/** 样本导出每页的上限。 */
export const SAMPLES_PAGE_MAX = 1000;

export type { Settings } from './views.ts';
const DEFAULT_SETTINGS: Settings = { revision: 0, global: DEFAULT_GLOBAL, symbols: {}, confirmed: [], venues: [...VENUES] };


export interface EngineOptions { store: VarLighterStore; fetchImpl?: FetchLike; connect?: Connect; now?: () => number; log?: (line: string) => void; /** Var token 询价；不给就只用公开报价。 */ quoter?: VarQuoter }

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const dayStart = (time: number) => Math.floor(time / 86_400_000) * 86_400_000;

/** 一个 Lighter 场所的运行状态：行情流（停用时为 null）、目录与盘口快照。 */
interface VenueRuntime { venue: Venue; stream: LighterStream | null; markets: RhMarket[]; catalog: SourceState; nextCatalog: number; depth: Map<string, { marketId: number; snapshot: DepthSnapshot | null; error: string | null }> }

export function createVarLighterEngine({ store, fetchImpl = fetch, connect, now = Date.now, log = () => {}, quoter }: EngineOptions) {
  const open = connect ?? (url => new WebSocket(url) as unknown as ReturnType<Connect>);
  let settings: Settings = normalizeSettings(store.state<Settings>('settings'));
  const venues = new Map<Venue, VenueRuntime>(VENUES.map(venue => [venue, { venue, stream: null, markets: [], catalog: { at: null, ok: null, error: null, count: 0 }, nextCatalog: 0, depth: new Map() }]));
  let listings = new Map<string, VarListing>(), pairs: PairInfo[] = [];
  let running = false;
  const varSource: SourceState = { at: null, ok: null, error: null, count: 0 };
  let lastPoll: PollStats | null = null;
  const lastQuoteAt = new Map<string, number>(), latest = new Map<string, Sample>();
  const trackers = new Map<string, BaselineTracker>();
  const positions = new Map<string, Position>();
  const cooldown = new Map<string, number>(Object.entries(store.state<Record<string, number>>('cooldown') ?? {}).filter(([key, until]) => PAIR_KEY.test(key) && Number.isFinite(until)));
  const saveCooldown = () => store.setState('cooldown', Object.fromEntries([...cooldown].filter(([, until]) => until > now())), now());
  /** 近 24 小时每个配对的样本数（按主键数，10 分钟内只数一次，其间随写入累加），每个配对首条样本时刻与全库首条（清理后重读）。 */
  const recent = new Map<string, { at: number; count: number }>();
  const firsts = new Map<string, number | null>();
  let firstSample: number | null | undefined;
  const ages: number[] = [];
  const startedAt = now();
  /** Var 拉取最近一次从未就绪或故障（超过 3 分钟没成功）恢复的时刻。 */
  let varHealthySince = startedAt;
  let sequence = 0;
  for (const position of store.positions()) positions.set(position.symbol, position);
  for (const symbol of positions.keys()) { const sample = store.latest(symbol); if (sample) latest.set(symbol, sample); }

  function normalizeSettings(saved: Settings | null): Settings {
    if (!saved) return DEFAULT_SETTINGS;
    try {
      const symbols: Record<string, SymbolParams> = {};
      for (const [key, params] of Object.entries(saved.symbols ?? {})) if (PAIR_KEY.test(key)) symbols[key] = readSymbolParams(params);
      const venues = Array.isArray(saved.venues) ? VENUES.filter(venue => saved.venues.includes(venue)) : [...VENUES];
      // globalExtra 里只取本版本认识的键，值不合法就用默认：更新的版本往里加了字段再回退到这一版，不能因此丢掉整份参数。
      const extra = (saved as { globalExtra?: unknown }).globalExtra, minNet = isObject(extra) ? extra.minNetBps : undefined;
      const known = typeof minNet === 'number' && Number.isFinite(minNet) && minNet >= 0 && minNet <= 500 ? { minNetBps: minNet } : {};
      return { revision: Number.isSafeInteger(saved.revision) ? saved.revision : 0, global: readGlobalParams({ ...(saved.global ?? {}), ...known }), symbols, confirmed: (saved.confirmed ?? []).filter(key => PAIR_KEY.test(key)), venues };
    } catch (error) {
      log(`varlighter: 已保存的参数无效，改用默认值：${error instanceof Error ? error.message : String(error)}`);
      return { ...DEFAULT_SETTINGS, revision: Number.isSafeInteger(saved.revision) ? saved.revision : 0 };
    }
  }
  const paramsOf = (symbol: string): SymbolParams => settings.symbols[symbol] ?? DEFAULT_SYMBOL;
  const pairOf = (key: string) => pairs.find(pair => pair.key === key);
  const eligible = (pair: PairInfo | undefined) => !!pair && pair.identity !== 'mismatch' && (pair.identity === 'verified' || settings.confirmed.includes(pair.key));
  /** 同一个 Var 代码在别的场所是否有持仓。 */
  const varBusy = (pair: PairInfo) => [...positions.keys()].some(key => key !== pair.key && tickerOf(key) === pair.symbol);
  function rebuildPairs(): void {
    if (!listings.size) return;
    const all = [...listings.values()];
    pairs = sortPairs(VENUES.filter(venue => settings.venues.includes(venue)).flatMap(venue => pairMarkets(all, venues.get(venue)!.markets, venue)));
    // 重启后参数与持仓先于配对就有了：配对一建好就补上要取盘口快照的市场。
    updateDepth();
  }

  /** 基线跟踪器：首次用到时从库里预热最近一个窗口的样本。窗口或最少样本改了就全部重建。 */
  function tracker(pair: PairInfo): BaselineTracker {
    let found = trackers.get(pair.key);
    if (!found) {
      found = new BaselineTracker(pair.kind, settings.global.windowHours * 3_600_000, settings.global.minSamples);
      const time = now();
      for (const sample of store.samples(pair.key, time - settings.global.windowHours * 3_600_000, time)) found.push(sample);
      trackers.set(pair.key, found);
    }
    return found;
  }

  /** 需要盘口快照的配对：启用的与有持仓的，每个场所最多 MAX_DEPTH_MARKETS 个。 */
  function updateDepth(): void {
    for (const runtime of venues.values()) {
      const keys = [...new Set([...positions.keys(), ...Object.entries(settings.symbols).filter(([, params]) => params.enabled).map(([key]) => key)])];
      const wanted = new Map<string, number>();
      for (const key of keys) {
        const pair = pairOf(key);
        if (pair?.venue === runtime.venue && wanted.size < MAX_DEPTH_MARKETS) wanted.set(key, pair.marketId);
      }
      for (const key of runtime.depth.keys()) if (wanted.get(key) !== runtime.depth.get(key)!.marketId) runtime.depth.delete(key);
      for (const [key, marketId] of wanted) if (!runtime.depth.has(key)) runtime.depth.set(key, { marketId, snapshot: null, error: null });
    }
  }

  /** 启停各场所的行情流，与参数里的采集场所一致。 */
  function syncStreams(): void {
    for (const runtime of venues.values()) {
      const want = running && settings.venues.includes(runtime.venue);
      if (want && !runtime.stream) { runtime.stream = new LighterStream({ venue: runtime.venue, connect: open, now, log }); runtime.stream.start(); runtime.nextCatalog = 0; }
      if (!want && runtime.stream) { runtime.stream.close(); runtime.stream = null; runtime.markets = []; runtime.depth.clear(); }
    }
  }

  async function refreshCatalog(signal: AbortSignal, venue: Venue = 'rh'): Promise<void> {
    const runtime = venues.get(venue)!;
    runtime.catalog.at = now();
    try {
      runtime.markets = await fetchRhMarkets(fetchImpl, signal, venue);
      runtime.catalog.ok = now(); runtime.catalog.error = null; runtime.catalog.count = runtime.markets.length;
      rebuildPairs();
      updateDepth();
    } catch (error) { runtime.catalog.error = message(error); }
  }

  /** 取各场所需要的盘口快照（并发；单个失败只记在该配对上）。 */
  async function refreshDepth(signal: AbortSignal): Promise<void> {
    const jobs: Promise<void>[] = [];
    for (const runtime of venues.values()) for (const entry of runtime.depth.values()) {
      jobs.push(fetchDepth(fetchImpl, runtime.venue, entry.marketId, signal, now).then(snapshot => { entry.snapshot = snapshot; entry.error = null; }, error => { entry.error = message(error); }));
    }
    await Promise.all(jobs);
  }

  /**
   * 给要取盘口快照的配对（已启用或有持仓）各询一次 Var token 价，数量按该配对的名义金额与公开标记价折算。
   * 没有可用 token 时一个请求也不发；单个失败只少这一个配对的询价，原因在询价状态里。
   * 整个阶段有总时限，到点后没发出的不再发、在途的中止，这一轮用已经拿到的；写法没确认的类别与失败后暂停中的标的不询。
   */
  async function tokenQuotes(signal: AbortSignal, stats: PollStats): Promise<Map<string, TokenQuote>> {
    const result = new Map<string, TokenQuote>();
    if (!quoter?.usable()) return result;
    const jobs: (() => Promise<void>)[] = [], phase = anySignal([signal], TOKEN_QUOTE_PHASE_MS);
    for (const runtime of venues.values()) for (const key of runtime.depth.keys()) {
      const pair = pairOf(key), listing = pair && listings.get(pair.symbol);
      if (!pair || !listing) continue;
      if (!quoter.wants(pair.kind, pair.symbol)) { stats.tokenSkipped++; continue; }
      jobs.push(async () => {
        // 到了阶段时限，或这一轮里前面的请求让 token 不可用了（被拒、被拦截）：剩下的不再发。
        if (phase.aborted || !quoter.usable()) { stats.tokenSkipped++; return; }
        await quoter.quote(pair.kind, pair.symbol, paramsOf(key).notionalUsd, listing.mark, phase, signal).then(quote => { result.set(key, quote); stats.tokenOk++; }, () => { stats.tokenFailed++; });
      });
    }
    const workers = Array.from({ length: Math.min(TOKEN_QUOTE_CONCURRENCY, jobs.length) }, async () => { for (let job = jobs.shift(); job; job = jobs.shift()) await job(); });
    await Promise.all(workers);
    return result;
  }

  /** 拉一次 Var 报价：每个共同标的的新报价按报价时刻对齐 Lighter 当时的盘口，写库、计入基线、跑模拟盘。 */
  async function pollVar(signal: AbortSignal): Promise<void> {
    varSource.at = now();
    let fetched: VarListing[];
    try { fetched = await fetchVarListings(fetchImpl, signal, now); } catch (error) { varSource.error = message(error); return; }
    const receivedAt = now();
    if (varSource.ok === null || receivedAt - varSource.ok > 3 * VAR_POLL_MS) varHealthySince = receivedAt;
    varSource.ok = receivedAt; varSource.error = null; varSource.count = fetched.length;
    listings = new Map(fetched.map(listing => [listing.ticker, listing]));
    rebuildPairs();
    const stats: PollStats = { at: receivedAt, listings: fetched.length, fresh: 0, unchanged: 0, noQuote: 0, noLighter: 0, written: 0, noLive: 0, blocked: {}, tokenOk: 0, tokenFailed: 0, tokenSkipped: 0 };
    const [, asked] = await Promise.all([refreshDepth(signal), tokenQuotes(signal, stats)]);
    const fresh: { pair: PairInfo; sample: Sample }[] = [];
    for (const pair of pairs) {
      if (pair.identity === 'mismatch') continue;
      const listing = listings.get(pair.symbol), quote = listing?.quote;
      if (!listing || !quote) { stats.noQuote++; continue; }
      if (quote.at <= (lastQuoteAt.get(pair.key) ?? 0)) { stats.unchanged++; continue; }
      const runtime = venues.get(pair.venue)!;
      const top = runtime.stream?.topAt(pair.marketId, quote.at) ?? null;
      if (!top) { stats.noLighter++; continue; }
      lastQuoteAt.set(pair.key, quote.at);
      const depth = depthAt(runtime.depth.get(pair.key)?.snapshot, top, quote.at);
      // 判断就发生在现在：记下这一刻的 Lighter 一档，模拟盘按它成交并复核信号。
      const live = runtime.stream?.topAt(pair.marketId, now()) ?? null;
      if (!live) stats.noLive++;
      const token = asked.get(pair.key), tokenFresh = token && now() - token.at <= TOKEN_QUOTE_MAX_AGE_MS ? token : null;
      fresh.push({ pair, sample: {
        symbol: pair.key, t: quote.at, receivedAt, regime: regimeOf(pair.kind, quote.at),
        varMark: listing.mark, varBid0: quote.bid0, varAsk0: quote.ask0, varBid1k: quote.bid1k, varAsk1k: quote.ask1k, varBid100k: quote.bid100k, varAsk100k: quote.ask100k, varFunding: listing.fundingRate,
        rhAt: top.at, rhBid0: top.bid, rhAsk0: top.ask, rhMark: top.mark, rhIndex: top.index, rhFunding: top.funding,
        rhBid1k: depth?.bid1k ?? null, rhAsk1k: depth?.ask1k ?? null, rhBid100k: depth?.bid100k ?? null, rhAsk100k: depth?.ask100k ?? null,
        rhBidRx: live?.bid ?? null, rhAskRx: live?.ask ?? null,
        varBidTk: tokenFresh?.bid ?? null, varAskTk: tokenFresh?.ask ?? null, varTkAt: tokenFresh?.at ?? null,
      } });
      ages.push(receivedAt - quote.at);
    }
    if (ages.length > 2000) ages.splice(0, ages.length - 2000);
    stats.fresh = fresh.length;
    fresh.sort((a, b) => a.sample.t - b.sample.t);
    // 先预热基线（只含库里已有的样本），再写入这批样本，避免当前样本被计入自己的基线。
    for (const { pair } of fresh) tracker(pair);
    stats.written = store.addSamples(fresh.map(item => item.sample));
    noteSamples(fresh.map(item => item.sample));
    for (const { pair, sample } of fresh) {
      latest.set(pair.key, sample);
      const blocker = step(pair, sample);
      if (blocker) stats.blocked[blocker] = (stats.blocked[blocker] ?? 0) + 1;
    }
    lastPoll = stats;
  }

  /** 持仓按判断时刻的 Lighter 一档估的平仓价差（没有那一刻的一档用样本本身的）；自动平仓、手动平仓与浮盈同一口径。 */
  function heldSpread(position: Position, sample: Sample) {
    const quoted = positionSpread(sample, position.notionalUsd);
    return quoted && closeSpread(sample, position, quoted);
  }

  /** 模拟盘的一步：先用之前的样本判断，再把这个样本计入基线（与回测同序）。已启用的配对达到入场偏离却没开仓时返回原因。 */
  function step(pair: PairInfo, sample: Sample): string | null {
    let blocked: string | null = null;
    const track = tracker(pair), params = paramsOf(pair.key), position = positions.get(pair.key) ?? null;
    const baseline = track.value(sample.regime, sample.t);
    const decision = decide(sample, baseline, params, position);
    if (decision.kind === 'close' && position) finish(position, sample, closeSpread(sample, position, decision.spread), decision.reason);
    else if (decision.kind === 'open' && baseline) {
      // 信号是按 Var 报价时刻算的；按现在的 Lighter 一档复核，仍成立才按现在的价开仓。
      const confirmed = confirmOpen(sample, baseline, params, decision, true);
      const open = [...positions.values()];
      const blocker = typeof confirmed === 'string' ? confirmed : openBlocker(sample, params, settings.global, {
        openPositions: open.length, openNotionalUsd: open.reduce((sum, item) => sum + item.notionalUsd, 0),
        dailyNetUsd: store.netSince(dayStart(sample.t)), cooldownUntil: cooldown.get(pair.key) ?? 0, eligible: eligible(pair), varBusy: varBusy(pair),
        fallbackBaseline: baseline.fallback, ...openEconomics(confirmed.decision, params, settings.global, hasTokenQuote(sample) ? decision : undefined),
      });
      if (blocker && params.enabled) blocked = blocker;
      if (!blocker && typeof confirmed !== 'string') {
        const opened = openPosition(`p${now().toString(36)}-${(++sequence).toString(36)}`, confirmed.sample, params, confirmed.decision, baseline);
        positions.set(pair.key, opened);
        updateDepth();
        store.openPosition(opened, { at: now(), kind: 'open', message: `${DIRECTION_NAMES[opened.direction]} ${fmt(opened.notionalUsd, 0)} 美元，价差 ${fmt(opened.entrySpread, 1)} 基点，基线 ${fmt(baseline.median, 1)}，偏离 ${fmt(confirmed.decision.deviation, 1)}（报价时刻 ${fmt(decision.deviation, 1)}）${hasTokenQuote(sample) ? '，Var 按 token 询价' : ''}` });
      }
    }
    track.push(sample);
    return blocked;
  }

  function finish(position: Position, sample: Sample, spread: NonNullable<ReturnType<typeof spreadOf>>, reason: ClosedTrade['reason'], note = ''): ClosedTrade {
    const trade = closePosition(position, sample.t, spread, reason, settings.global, fundingEstimate(position, sample.t, sample.varFunding, sample.rhFunding));
    positions.delete(position.symbol);
    cooldown.set(position.symbol, sample.t + paramsOf(position.symbol).cooldownMinutes * 60_000);
    saveCooldown();
    store.closePosition(trade, { at: now(), kind: 'close', message: `${note}${CLOSE_REASON_NAMES[reason]}${spread.estimated ? '（按 1k 档估算）' : ''}：净 ${fmt(trade.netUsd, 2)} 美元（${fmt(trade.netBps, 1)} 基点），持有 ${fmt((trade.closedAt - trade.openedAt) / 60_000, 0)} 分钟` });
    return trade;
  }

  function noteSamples(samples: readonly Sample[]): void {
    for (const sample of samples) {
      const counted = recent.get(sample.symbol);
      if (counted) counted.count++;
      if (firsts.get(sample.symbol) === null) firsts.set(sample.symbol, sample.t);
      if (firstSample === null) firstSample = sample.t;
    }
  }
  function recentCount(key: string, time: number): number {
    const counted = recent.get(key);
    if (counted && time - counted.at < RECOUNT_MS) return counted.count;
    const count = store.countSince(key, time - 86_400_000);
    recent.set(key, { at: time, count });
    return count;
  }
  /** 分批删过期样本，批间让出事件循环（满量时一小时约 1.3 万条）；停服时停下。 */
  async function pruneSamples(time: number, stopped: () => boolean): Promise<void> {
    while (!stopped() && store.pruneSamples(time, PRUNE_BATCH) === PRUNE_BATCH) await new Promise(resolve => setImmediate(resolve));
    store.pruneEvents(time);
    firsts.clear(); firstSample = undefined;
  }
  function firstOf(key: string): number | null {
    if (!firsts.has(key)) firsts.set(key, store.firstAt(key));
    return firsts.get(key)!;
  }

  // ---- 视图 ----
  function baselineOf(pair: PairInfo, time: number): Baseline | null { return tracker(pair).value(regimeOf(pair.kind, time), time); }

  function state(): StateView {
    const time = now();
    const open = [...positions.values()];
    const rows = pairs.map(pair => {
      const sample = latest.get(pair.key) ?? null, params = paramsOf(pair.key);
      const baseline = baselineOf(pair, time);
      const spread = sample ? spreadOf(sample, bucketOf(params.notionalUsd)) : null;
      const mid = sample ? midBasis(sample) : null;
      const position = positions.get(pair.key) ?? null;
      const held = position && sample ? heldSpread(position, sample) : null;
      return {
        key: pair.key, venue: pair.venue, venueName: VENUE_NAMES[pair.venue], symbol: pair.symbol, name: pair.name, kind: pair.kind, kindName: KIND_NAMES[pair.kind], identity: pair.identity, eligible: eligible(pair), gapBps: pair.gapBps,
        regime: regimeOf(pair.kind, time), sampleAt: sample?.t ?? null, mid, sellVar: spread?.sellVar ?? null, buyVar: spread?.buyVar ?? null, estimated: spread?.estimated ?? null,
        cost: spread ? spread.buyVar - spread.sellVar : null,
        baseline: baseline ? { median: baseline.median, sigma: baseline.sigma, samples: baseline.samples, regime: baseline.regime, fallback: baseline.fallback } : null,
        z: baseline && mid !== null ? (mid - baseline.median) / baseline.sigma : null,
        rich: baseline && spread ? spread.sellVar - baseline.median : null, cheap: baseline && spread ? baseline.median - spread.buyVar : null,
        samples24h: recentCount(pair.key, time), firstAt: firstOf(pair.key), cooldownUntil: (cooldown.get(pair.key) ?? 0) > time ? cooldown.get(pair.key)! : null,
        enabled: params.enabled, entryBps: params.entryBps, exitBps: params.exitBps,
        position: position ? { direction: position.direction, pnlBps: held ? markToMarket(position, held).pnlBps : null, openedAt: position.openedAt } : null,
        varFunding: sample?.varFunding ?? null, rhFunding: sample?.rhFunding ?? null,
      };
    });
    const sortedAges = [...ages].sort((a, b) => a - b);
    return {
      now: time, startedAt,
      sources: {
        var: { ...varSource, poll: lastPoll, quoteAgeMedianMs: sortedAges.length ? sortedAges[Math.floor(sortedAges.length / 2)] : null, token: quoter?.view() ?? null },
        venues: [...venues.values()].map((runtime): VenueStatus => ({
          venue: runtime.venue, name: VENUE_NAMES[runtime.venue], enabled: settings.venues.includes(runtime.venue), catalog: runtime.catalog,
          stream: runtime.stream?.status(runtime.markets.length) ?? null,
          depth: [...runtime.depth].map(([key, entry]): DepthStatus => ({ key, marketId: entry.marketId, at: entry.snapshot?.at ?? null, error: entry.error })),
          pairs: pairs.filter(pair => pair.venue === runtime.venue).length,
        })),
      },
      firstSampleAt: firstSample === undefined ? (firstSample = store.firstSampleAt()) : firstSample,
      rows,
      orphans: orphans(),
      settings,
      paper: { open: open.length, openNotionalUsd: open.reduce((sum, item) => sum + item.notionalUsd, 0), todayNetUsd: store.netSince(dayStart(time)), ...store.totals() },
      regimeNames: REGIME_NAMES,
    };
  }

  const lastSample = (key: string) => latest.get(key) ?? store.latest(key);
  /**
   * 配对失联的原因：不在目录里、改判为规格不同，或数据源都正常而 30 分钟没有新样本（Var 不再报价、对手盘口缺失）。
   * 数据源本身没就绪或在故障（启动期、Var 拉取失败、场所目录未取到、行情流断开或还没收到快照）时返回 null，不把整体故障当成单个配对失联。
   * 30 分钟从「最后样本」与「数据源连续正常的起点」（启动、Var 恢复、行情流收到快照三者取最晚）中较晚的一个算起：
   * 停机或故障前的旧样本不会在恢复后第一轮还没写入新样本时就被判失联。
   * 两个数据源中断不超过 3 分钟再恢复的都不重新计时，否则频繁的短暂断线会让没有报价的持仓一直处理不了。
   */
  function lostReason(key: string, time: number): string | null {
    if (!listings.size || varSource.ok === null || time - varSource.ok > 3 * VAR_POLL_MS) return null;
    const runtime = venues.get(venueOf(key));
    if (!runtime?.markets.length) return null;
    const pair = pairOf(key);
    if (!pair) return '配对已不在目录里';
    if (pair.identity === 'mismatch') return '两边价格相差超过 5%，已改判为规格不同';
    const streamFrom = runtime.stream?.healthySince() ?? null;
    if (streamFrom === null) return null;
    const healthyFrom = Math.max(startedAt, varHealthySince, streamFrom);
    if (time - Math.max(lastSample(key)?.t ?? -Infinity, healthyFrom) <= LOST_MS) return null;
    const closed = pair.kind !== 'crypto' && ['weekend', 'overnight'].includes(regimeOf(pair.kind, time));
    return `超过 ${LOST_MS / 60_000} 分钟没有新样本（${closed ? '可能休市；' : ''}Var 无报价或对手盘口缺失）`;
  }

  /** 已启用或有模拟持仓、但已失联的键：总览里列出来，可以停用或按最后样本平仓。 */

  function orphans(): OrphanRow[] {
    const time = now();
    const keys = [...new Set([...Object.entries(settings.symbols).filter(([, params]) => params.enabled).map(([key]) => key), ...positions.keys()])].sort();
    return keys.flatMap(key => {
      const reason = lostReason(key, time);
      if (reason === null) return [];
      const position = positions.get(key) ?? null, sample = lastSample(key);
      const held = position && sample ? heldSpread(position, sample) : null;
      return {
        key, venue: venueOf(key), venueName: VENUE_NAMES[venueOf(key)], symbol: tickerOf(key), reason, enabled: settings.symbols[key]?.enabled === true, lastSampleAt: sample?.t ?? null,
        position: position ? { direction: position.direction, openedAt: position.openedAt, pnlBps: held ? markToMarket(position, held).pnlBps : null } : null,
      };
    });
  }

  function symbolView(key: unknown, hoursRaw: unknown): SymbolView {
    const pair = pairOf(String(key ?? ''));
    if (!pair) return reject('unknown_symbol', '不是两边共有的标的（或该场所未在采集）');
    const hours = Number(hoursRaw ?? 24);
    if (!Number.isInteger(hours) || hours < 1 || hours > 24 * 14) reject('invalid_hours', '时长须为 1 到 336 小时');
    const time = now(), from = time - hours * 3_600_000, windowMs = settings.global.windowHours * 3_600_000;
    const params = paramsOf(pair.key);
    const all = store.samples(pair.key, from - windowMs, time);
    const local = new BaselineTracker(pair.kind, windowMs, settings.global.minSamples);
    const bucket = bucketOf(params.notionalUsd);
    const points: SymbolPoint[] = [];
    const inRange: Sample[] = [];
    for (const sample of all) {
      if (sample.t >= from) {
        const baseline = local.value(sample.regime, sample.t), spread = spreadOf(sample, bucket);
        points.push({ t: sample.t, mid: midBasis(sample), sellVar: spread?.sellVar ?? null, buyVar: spread?.buyVar ?? null, median: baseline?.median ?? null, sigma: baseline?.sigma ?? null, regime: sample.regime, estimated: spread?.estimated ?? false });
        inRange.push(sample);
      }
      local.push(sample);
    }
    const stats: RegimeStats[] = symbolStats(pair.kind, inRange, params.entryBps, bucket);
    const sample = latest.get(pair.key) ?? store.latest(pair.key);
    const quoted = sample ? spreadOf(sample, bucket) : null;
    const protection = slippageBudgetBps(params, settings.global, quoted ? (quoted.buyVar - quoted.sellVar) / 2 : 0);
    const plans: OrderPlan[] = sample ? (['var_rich', 'var_cheap'] as Direction[]).map(direction => orderPlan(pair, sample, direction, params.notionalUsd, protection, time)) : [];
    const position = positions.get(pair.key) ?? null;
    return {
      key: pair.key, venue: pair.venue, venueName: VENUE_NAMES[pair.venue], symbol: pair.symbol, name: pair.name, kind: pair.kind, kindName: KIND_NAMES[pair.kind], identity: pair.identity, eligible: eligible(pair), gapBps: pair.gapBps,
      rh: pair.rh, regimes: regimesOf(pair.kind), hours, from, to: time, bucket,
      points: downsample(points, 1500), samples: inRange.length,
      stats: stats.map(item => ({ ...item, suggestedEntryBps: suggestedEntryBps(item) })),
      params, global: settings.global, latest: sample ?? null, plans,
      position: position ? { ...position, mark: sample ? markOf(position, sample) : null } : null,
      trades: store.symbolTrades(pair.key, from).slice(-500),
    };
  }

  function markOf(position: Position, sample: Sample): { netUsd: number; pnlBps: number; at: number } | null {
    const spread = heldSpread(position, sample);
    if (!spread) return null;
    const trade = closePosition(position, sample.t, spread, 'manual', settings.global, null);
    return { netUsd: trade.netUsd, pnlBps: markToMarket(position, spread).pnlBps, at: sample.t };
  }

  function backtest(body: unknown): BacktestView {
    const request = backtestRequest(body, settings.symbols, settings.global);
    const pair = pairOf(request.symbol) ?? reject('unknown_symbol', '不是两边共有的标的');
    const time = now(), from = time - request.hours * 3_600_000;
    const samples = store.samples(pair.key, from - request.global.windowHours * 3_600_000, time);
    const result = runBacktest(pair.key, pair.kind, samples, from, time, request.params, request.global);
    const truncated = result.trades.length > 1000;
    return { ...result, trades: result.trades.slice(-1000), equity: result.equity.slice(-1000), truncated };
  }

  /**
   * 原始样本的一页（docs/mcp.md 第 8.3 节），供客户端拉到本机回测：只读本地库，不看配对是否仍在采集，失联配对的历史也能读。
   * after 不含本身；limit 1–1000，1000 行约 300 KiB，留在只读令牌 512 KiB 的应答上限以内。
   */
  function samplesPage(symbolRaw: unknown, afterRaw: unknown, limitRaw: unknown): SamplesView {
    const symbol = String(symbolRaw ?? '');
    if (!PAIR_KEY.test(symbol)) reject('invalid_symbol', '配对键无效（应为「场所:代码」，如 rh:AAPL）');
    const after = afterRaw === null || afterRaw === undefined ? 0 : Number(afterRaw);
    if (!/^\d{1,15}$/.test(String(afterRaw ?? '0')) || !Number.isSafeInteger(after)) reject('invalid_after', 'after 须为毫秒时刻（非负整数）');
    const limit = limitRaw === null || limitRaw === undefined ? SAMPLES_PAGE_MAX : Number(limitRaw);
    if (!/^\d{1,4}$/.test(String(limitRaw ?? SAMPLES_PAGE_MAX)) || limit < 1 || limit > SAMPLES_PAGE_MAX) reject('invalid_limit', `limit 须为 1–${SAMPLES_PAGE_MAX} 的整数`);
    const samples = store.samplesAfter(symbol, after, limit);
    return {
      symbol, columns: SAMPLE_FIELDS, rows: samples.map(sample => SAMPLE_FIELDS.map(field => sample[field])),
      next: samples.length === limit ? samples.at(-1)!.t : null, firstAt: store.firstAt(symbol), retentionDays: SAMPLE_RETENTION_DAYS,
    };
  }

  function paper(): PaperView {
    const time = now(), open = [...positions.values()];
    const trades = store.trades(300);
    const history = store.tradesSince(time - 30 * 86_400_000);
    const daily = new Map<number, { netUsd: number; trades: number }>();
    let cumulative = 0;
    const equity = history.map(trade => {
      const day = dayStart(trade.closedAt), entry = daily.get(day) ?? { netUsd: 0, trades: 0 };
      entry.netUsd += trade.netUsd; entry.trades++; daily.set(day, entry);
      cumulative += trade.netUsd;
      return { t: trade.closedAt, net: cumulative };
    });
    return {
      now: time,
      positions: open.map(position => { const sample = latest.get(position.symbol); return { ...position, mark: sample ? markOf(position, sample) : null, sampleAt: sample?.t ?? null, maxHoldMinutes: paramsOf(position.symbol).maxHoldMinutes }; }),
      trades, equity, daily: [...daily].map(([day, value]) => ({ day, ...value })),
      totals: store.totals(), todayNetUsd: store.netSince(dayStart(time)),
      limits: { maxOpenPositions: settings.global.maxOpenPositions, maxTotalNotionalUsd: settings.global.maxTotalNotionalUsd, dailyLossLimitUsd: settings.global.dailyLossLimitUsd, paused: settings.global.paused },
      openNotionalUsd: open.reduce((sum, item) => sum + item.notionalUsd, 0),
      events: store.events(100),
    };
  }

  function updateSettings(body: unknown): Settings {
    if (!isObject(body)) return reject('invalid_body', '请求格式无效');
    const unknown = Object.keys(body).find(key => !['revision', 'global', 'symbols', 'confirmed', 'venues'].includes(key));
    if (unknown) reject('invalid_body', `包含未知字段 ${unknown.slice(0, 40)}`);
    if (body.revision !== settings.revision) reject('stale_revision', '参数已被别处修改，请刷新后再改', 409);
    try {
      const global = body.global === undefined ? settings.global : readGlobalParams(body.global, settings.global);
      const symbols = { ...settings.symbols };
      if (body.symbols !== undefined) {
        if (!isObject(body.symbols) || Object.keys(body.symbols).length > 200) reject('invalid_body', '标的参数格式无效');
        for (const [key, value] of Object.entries(body.symbols as Record<string, unknown>)) {
          if (!PAIR_KEY.test(key)) reject('invalid_symbol', '配对键无效（应为「场所:代码」，如 rh:AAPL）');
          if (value === null) { delete symbols[key]; continue; }
          symbols[key] = readSymbolParams(value, symbols[key] ?? DEFAULT_SYMBOL);
        }
      }
      if (Object.keys(symbols).length > MAX_SAVED_SYMBOLS) reject('too_many', `最多保存 ${MAX_SAVED_SYMBOLS} 个标的的参数，先删掉不用的`);
      let confirmed = settings.confirmed;
      if (body.confirmed !== undefined) {
        if (!Array.isArray(body.confirmed) || body.confirmed.length > 400 || body.confirmed.some(item => typeof item !== 'string' || !PAIR_KEY.test(item))) reject('invalid_body', '已确认标的列表无效');
        confirmed = [...new Set(body.confirmed as string[])].sort();
      }
      let venueList = settings.venues;
      if (body.venues !== undefined) {
        if (!Array.isArray(body.venues) || body.venues.some(item => !VENUES.includes(item as Venue))) reject('invalid_body', '采集场所列表无效');
        venueList = VENUES.filter(venue => (body.venues as unknown[]).includes(venue));
        if (!venueList.length) reject('invalid_body', '至少保留一个采集场所');
      }
      const enabled = Object.entries(symbols).filter(([, params]) => params.enabled).map(([key]) => key);
      for (const venue of VENUES) {
        const count = enabled.filter(key => key.startsWith(`${venue}:`)).length;
        if (count > MAX_DEPTH_MARKETS) reject('too_many', `${VENUE_NAMES[venue]} 最多同时启用 ${MAX_DEPTH_MARKETS} 个标的（每分钟取一次盘口快照）`);
        if (!venueList.includes(venue)) {
          const busy = [...enabled, ...positions.keys()].find(key => key.startsWith(`${venue}:`));
          if (busy) reject('venue_busy', `${VENUE_NAMES[venue]} 上还有启用的标的或模拟持仓（${busy}），先停用并平仓再停止采集`);
        }
      }
      for (const key of enabled) {
        const pair = pairOf(key);
        if (!pair && settings.symbols[key]?.enabled !== true) reject('unknown_symbol', `${key} 不在两边共有的标的里（或目录尚未加载）`);
        if (pair && pair.identity === 'mismatch') reject('mismatch', `${key} 两边规格不同，不能启用`);
        if (pair && pair.identity === 'review' && !confirmed.includes(key)) reject('unconfirmed', `${key} 规格待确认，先在实盘准备页确认后再启用`);
      }
      const windowChanged = global.windowHours !== settings.global.windowHours || global.minSamples !== settings.global.minSamples;
      const venuesChanged = venueList.join() !== settings.venues.join();
      settings = { revision: settings.revision + 1, global, symbols, confirmed, venues: venueList };
      // v0.80.x 读参数时遇到 global 里不认识的字段会整份改用默认值：新加的全局参数另存在 globalExtra，回退后旧版本照常读。
      const { minNetBps, ...legacyGlobal } = settings.global;
      store.setState('settings', { ...settings, global: legacyGlobal, globalExtra: { minNetBps } }, now());
      store.event(now(), 'settings', null, `参数已更新（版本 ${settings.revision}）${venuesChanged ? `，采集场所：${venueList.map(venue => VENUE_NAMES[venue]).join('、')}` : ''}`);
      if (windowChanged) trackers.clear();
      if (venuesChanged) { syncStreams(); rebuildPairs(); }
      updateDepth();
      return settings;
    } catch (error) {
      if (error instanceof ParamsError) return reject('invalid_params', error.message);
      throw error;
    }
  }

  function closeManual(body: unknown) {
    if (!isObject(body) || typeof body.symbol !== 'string' || Object.keys(body).some(key => key !== 'symbol')) return reject('invalid_body', '请求格式无效（symbol 为配对键）');
    const position = positions.get(body.symbol) ?? reject('not_found', '该标的没有模拟持仓', 404);
    const time = now(), sample = lastSample(position.symbol);
    if (!sample) return reject('no_quote', '没有任何报价，无法平仓；可清空模拟盘', 409);
    // 失联的配对等不到新报价：按最后一个样本结算并在事件里注明原因。数据源整体故障不算失联，等恢复。
    const stale = time - sample.t > 10 * 60_000, reason = stale ? lostReason(position.symbol, time) : null;
    if (stale && reason === null) return reject('no_quote', '没有 10 分钟内的报价，无法按市价平仓；数据源恢复后再试', 409);
    const spread = heldSpread(position, sample) ?? reject('no_quote', '该档位缺少可成交价', 409);
    const trade = finish(position, sample, spread, 'manual', reason ? `${reason}，按最后样本（${new Date(sample.t).toISOString().slice(0, 16).replace('T', ' ')} UTC）结算；` : '');
    updateDepth();
    return trade;
  }

  function resetPaper(body: unknown) {
    if (!isObject(body) || body.confirm !== 'RESET' || Object.keys(body).length !== 1) return reject('invalid_body', '需要确认文字 RESET');
    positions.clear(); cooldown.clear(); saveCooldown();
    store.resetPaper(now());
    updateDepth();
    return { ok: true };
  }

  function readiness(): ReadinessView {
    const time = now(), view = state();
    const enabled = view.rows.filter(row => row.enabled);
    const items: ReadinessItem[] = [];
    const varFresh = varSource.ok !== null && time - varSource.ok < 3 * VAR_POLL_MS;
    const active = view.sources.venues.filter(item => item.enabled);
    const venueText = active.map(item => `${item.name} ${item.stream?.connected ? '已连接' : item.stream?.lastError ?? '未连接'}`).join('；');
    items.push({ key: 'collect', status: varFresh && active.length > 0 && active.every(item => item.stream?.connected) ? 'ok' : 'warn', label: '行情采集', detail: `Var ${varFresh ? '正常' : varSource.error ?? '未取到'}；${venueText || '没有采集中的 Lighter 场所'}` });
    const span = view.firstSampleAt === null ? 0 : (time - view.firstSampleAt) / 86_400_000;
    items.push({ key: 'baseline', status: span >= READY_BASELINE_DAYS ? 'ok' : 'warn', label: `基线至少 ${READY_BASELINE_DAYS} 天`, detail: `已采集 ${span.toFixed(1)} 天（保留 14 天）` });
    const label = (row: { symbol: string; venueName: string }) => `${row.symbol}（${row.venueName}）`;
    items.push({ key: 'enabled', status: enabled.length ? 'ok' : 'warn', label: '选定标的', detail: enabled.length ? enabled.map(label).join('、') : '还没有启用任何标的的模拟盘' });
    const unconfirmed = enabled.filter(row => !row.eligible);
    items.push({ key: 'identity', status: unconfirmed.length ? 'warn' : 'ok', label: '合约规格核对', detail: unconfirmed.length ? `待确认：${unconfirmed.map(label).join('、')}` : '已启用标的的两边规格均已核对' });
    const depth = active.flatMap(item => item.depth);
    const stale = depth.filter(item => item.at === null || time - item.at > 3 * VAR_POLL_MS);
    items.push({ key: 'depth', status: depth.length && !stale.length ? 'ok' : 'warn', label: 'Lighter 盘口快照', detail: depth.length ? `${depth.length - stale.length}/${depth.length} 个配对三分钟内取到${stale.length ? `；缺：${stale.map(item => `${item.key}${item.error ? `（${item.error}）` : ''}`).join('、')}` : ''}` : '没有启用标的，未取快照' });
    const totals = store.totals();
    items.push({ key: 'paper', status: totals.trades >= READY_PAPER_TRADES && totals.netUsd > 0 ? 'ok' : 'warn', label: `模拟盘至少 ${READY_PAPER_TRADES} 笔且净盈利`, detail: `${totals.trades} 笔，净 ${fmt(totals.netUsd, 2)} 美元，胜率 ${totals.trades ? fmt(totals.wins / totals.trades * 100, 0) : '-'}%` });
    const age = view.sources.var.quoteAgeMedianMs;
    // 有 token 询价且最近三轮内成功过，就按询价的延迟算；否则仍看公开报价的中位延迟。
    // 询价算数的条件：最近三轮内的上一次拉取里，已启用或有持仓的配对全部询到。有失败或没询的仍按公开报价的时效判断，并写出各有几个。
    const token = view.sources.var.token, last = view.sources.var.poll, asked = last && time - last.at <= 3 * VAR_POLL_MS ? last : null;
    const tokenLive = token?.status === 'ready' && token.lagMs !== null && !!asked && asked.tokenOk > 0 && asked.tokenFailed === 0 && asked.tokenSkipped === 0;
    const tokenNote = !token ? '' : token.status !== 'ready' ? `Var token 询价${token.statusName}${token.error ? `（${token.error}）` : ''}，`
      : asked && asked.tokenOk + asked.tokenFailed + asked.tokenSkipped > 0 ? `Var token 询价上一轮成功 ${asked.tokenOk}、失败 ${asked.tokenFailed}、未询 ${asked.tokenSkipped}${token.error ? `（${token.error}）` : ''}，` : 'Var token 已配置但上一轮没有要询价的配对，';
    const publicAge = age === null ? '还没有样本' : `公开报价收到时已过去 ${fmt(age / 1000, 0)} 秒（中位数）`;
    items.push({ key: 'latency', status: tokenLive || (age !== null && age < 45_000) ? 'ok' : 'warn', label: 'Var 报价时效', detail: tokenLive
      ? `判断时刻用 token 询价，收到时距 Var 报价时刻 ${fmt(token.lagMs! / 1000, 1)} 秒；信号仍按公开报价发现，${publicAge}`
      : `${publicAge}；${tokenNote}实盘须每个配对都有实时询价` });
    items.push({ key: 'limits', status: 'ok', label: '风控限额', detail: `最多 ${settings.global.maxOpenPositions} 笔，名义合计 ≤ ${fmt(settings.global.maxTotalNotionalUsd, 0)} 美元，当日亏损 ≤ ${fmt(settings.global.dailyLossLimitUsd, 0)} 美元` });
    const orderVenues = [...new Set(enabled.map(row => row.venueName))];
    items.push({ key: 'lighter_order', status: 'todo', label: 'Lighter 下单连接器', detail: `RH 链与主网是两套账户：各需账户编号、API 密钥编号与私钥，以及签名器（官方 Go 签名库或 WASM）；${orderVenues.length ? `已启用标的用到 ${orderVenues.join('、')}；` : ''}尚未接入` });
    items.push({ key: 'var_order', status: 'todo', label: 'Var 下单接口', detail: 'Var 没有公开交易接口；询价已可用 token 读取（各类标的的写法以实盘准备页的询价状态为准），成交接口尚未确认、尚未接入' });
    items.push({ key: 'funding', status: 'todo', label: '两边账户资金', detail: '两边各需 USDC 保证金；按单笔名义金额与杠杆核算，并留出单腿风险的余量' });
    items.push({ key: 'monitor', status: 'todo', label: '实盘监控与告警', detail: '单腿、持仓不一致、亏损上限触发时的飞书告警，接入下单后补上' });
    return { now: time, items, ready: items.every(item => item.status === 'ok') };
  }

  return {
    /** 某场所的行情流（测试用）；未在采集时为 null。 */
    stream: (venue: Venue = 'rh') => venues.get(venue)!.stream,
    /** 测试用：不跑后台循环时按参数启停各场所的行情流。 */
    startStreams(): void { running = true; syncStreams(); },
    pollVar, refreshCatalog, refreshDepth,
    views: { state, symbol: symbolView, samples: samplesPage, backtest, paper, settings: updateSettings, close: closeManual, reset: resetPaper, readiness },
    /** 后台循环：连上各采集场所的行情流并取目录，然后每分钟拉 Var 报价（连同盘口快照），每 10 分钟刷新目录，每小时清理过期样本。 */
    async loop(context: { stopped(): boolean; pause(ms: number): Promise<void> }): Promise<void> {
      running = true;
      syncStreams();
      let nextVar = now() + 5_000, nextPrune = now() + 60_000;
      // 停服时中断进行中的请求，不等各自的超时：pause 在停服时立即返回。
      const stop = new AbortController();
      let done = false;
      const watcher = (async () => { while (!done && !context.stopped()) await context.pause(1_000); stop.abort(); })();
      const request = () => anySignal([stop.signal], REQUEST_TIMEOUT_MS);
      try {
        while (!context.stopped()) {
          const time = now();
          for (const runtime of venues.values()) {
            if (!runtime.stream || time < runtime.nextCatalog) continue;
            await refreshCatalog(request(), runtime.venue);
            if (context.stopped()) break;
            runtime.nextCatalog = time + (runtime.catalog.error ? 60_000 : CATALOG_MS);
          }
          if (time >= nextVar && [...venues.values()].some(runtime => runtime.markets.length)) { nextVar = time + VAR_POLL_MS; await pollVar(request()).catch(error => { varSource.error = message(error); }); }
          if (time >= nextPrune) { nextPrune = time + PRUNE_MS; try { await pruneSamples(time, () => context.stopped()); } catch (error) { log(`varlighter: 清理样本失败：${message(error)}`); } }
          await context.pause(1_000);
        }
      } finally { done = true; running = false; syncStreams(); await watcher; }
    },
    close(): void { running = false; syncStreams(); store.close(); },
  };
}
export type VarLighterEngine = ReturnType<typeof createVarLighterEngine>;

const message = (error: unknown) => error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
const fmt = (value: number, digits: number) => Number.isFinite(value) ? value.toFixed(digits) : '-';

/** 按时间等分成不超过 limit 格：每格中间价取均值，卖 Var 价差取最大、买 Var 价差取最小（保留机会的极值），基线取格内最后一个。 */
export function downsample<T extends { t: number; mid: number; sellVar: number | null; buyVar: number | null; median: number | null; sigma: number | null }>(points: T[], limit: number): T[] {
  if (points.length <= limit) return points;
  const first = points[0].t, span = points.at(-1)!.t - first + 1, result: T[] = [];
  let index = 0;
  for (let cell = 0; cell < limit && index < points.length; cell++) {
    const end = first + span * (cell + 1) / limit;
    const group: T[] = [];
    while (index < points.length && points[index].t < end) group.push(points[index++]);
    if (!group.length) continue;
    const last = group.at(-1)!;
    const sells = group.map(point => point.sellVar).filter((value): value is number => value !== null), buys = group.map(point => point.buyVar).filter((value): value is number => value !== null);
    result.push({ ...last, mid: group.reduce((sum, point) => sum + point.mid, 0) / group.length, sellVar: sells.length ? Math.max(...sells) : null, buyVar: buys.length ? Math.min(...buys) : null });
  }
  return result;
}
