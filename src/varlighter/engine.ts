// DEX 价差模块（原 Var/Lighter 价差，docs/varlighter.md、docs/dexspread.md）的运行时：采集各配对两条腿的对齐样本、维护基线、跑模拟盘，
// 并给页面出视图。只读公开行情、只写自己的 varlighter.sqlite；不碰执行器、不下任何真实订单。
// 有 Var 腿的配对跟着每分钟一次的 Var 报价采样（样本时刻 = Var 报价时刻，另一腿回看那一刻的行情流）；两腿都是行情流的配对
// 由本机每秒检查一次，启用或有持仓的每 5 秒、其余每 20 秒采一条（样本时刻 = 本机采样时刻）。
import { anySignal } from '../any-signal.mjs';
import { TOKEN_QUOTE_CONCURRENCY, TOKEN_QUOTE_MAX_AGE_MS, TOKEN_QUOTE_PHASE_MS, type TokenQuote, type VarQuoter } from './varquote.ts';
import { backtestRequest, runBacktest } from './backtest.ts';
import { HyperliquidStream, LighterStream, MAX_DEPTH_MARKETS, depthAt, fetchEntropyMarkets, fetchRhMarkets, fetchVarListings,
  type Connect, type DepthSnapshot, type FetchLike, type LiveStream, type TopPoint } from './feeds.ts';
import { ASSET_KINDS, COMBOS, DEFAULT_COMBOS, KIND_NAMES, LEG_SYMBOL, LIVE_VENUES, RATIO_MAX, RATIO_MIN, REGIME_NAMES, SAMPLE_FIELDS, SAMPLE_FORMAT, VENUE_IDS, VENUE_NAMES,
  bothLive, bucketOf, comboName, comboPairs, comboVenues, customPairInfo, formatRatio, isLive, legKey, lighterMarket, midBasis, pairKey, pairTitle, parsePairKey,
  regimeOf, regimesOf, sameSymbol, sortPairs, spreadOf, upgradeKey, varHourly, varMarket, varQuoteQty,
  type AssetKind, type Combo, type CustomPair, type Leg, type LegInfo, type LiveVenue, type MarketSpec, type PairInfo, type Sample, type SizeBucket, type VarListing, type VenueId } from './model.ts';
import { orderPlan, type OrderPlan } from './plan.ts';
import { BaselineTracker, LIVE_BASELINE_GAP_MS, suggestedEntryBps, symbolStats, type Baseline, type RegimeStats } from './stats.ts';
import { DEFAULT_GLOBAL, DEFAULT_SYMBOL, DIRECTIONS, ParamsError, closePosition, closeSpread, confirmOpen, decide, openEconomics, slippageBudgetBps, fundingEstimate, legFeeBps,
  markToMarket, openBlocker, openPosition, readGlobalParams, readSymbolParams, recommendParams, upgradeDirection, upgradeGlobal,
  CLOSE_REASON_NAMES, DIRECTION_NAMES, type ClosedTrade, type GlobalParams, type LegFees, type Position, type SymbolParams } from './strategy.ts';
import { COOLDOWN_KEY, SAMPLE_RETENTION_DAYS, SETTINGS_KEY, type LegacyUpgrade, type VarLighterStore } from './store.ts';
import type { AutoView, BacktestView, CatalogEntry, DepthStatus, LegRef, LiveStats, OrphanRow, PaperView, PollStats, PositionMark, ReadinessItem, ReadinessView, SamplesView, Settings, SourceState, StateRow, StateView,
  SymbolPoint, SymbolView, VenueStatus } from './views.ts';

export const VAR_POLL_MS = 60_000;
export const CATALOG_MS = 10 * 60_000;
/** 目录读取失败后的重试间隔。 */
export const CATALOG_RETRY_MS = 60_000;
/** 两腿都是行情流的配对：检查间隔、启用或有持仓的采样间隔、其余的采样间隔。 */
export const LIVE_TICK_MS = 1_000, LIVE_ACTIVE_MS = 5_000, LIVE_IDLE_MS = 20_000;
/** 到期判断的余量：每秒一检查时不会因为毫秒抖动拖成 6 秒、21 秒一条。 */
export const LIVE_SLACK_MS = 500;
/** 自动配置：推荐参数所用的统计每这么久重算一次，样本窗口取基线窗口、最长这么多小时。 */
export const AUTO_REFRESH_MS = 10 * 60_000, AUTO_WINDOW_MAX_HOURS = 72;
/** 盘口（行情流）超过这么久没同步算过期。 */
export const DEPTH_STALE_MS = 3 * 60_000;
const PRUNE_MS = 3_600_000;
const PRUNE_BATCH = 2_000;
const RECOUNT_MS = 10 * 60_000;
/** 数据源都正常、单个配对却这么久没有新样本，就算失联。 */
export const LOST_MS = 30 * 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
/** 参数里最多保存这么多个配对键（含已停用的）。 */
const MAX_SAVED_SYMBOLS = 500;
/** 手动配对上限。 */
export const MAX_CUSTOM_PAIRS = 100;
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
/** 行数据留在 480 KiB 内，给只读令牌的 512 KiB 应答上限留出列名和分页元数据空间。 */
const SAMPLE_ROWS_MAX_BYTES = 480 * 1024;
const KEY_HINT = '配对键无效（应为「场所:代码|场所:代码」，如 var:AAPL|rh:AAPL）';

export type { Settings } from './views.ts';
const DEFAULT_SETTINGS: Settings = { revision: 0, global: DEFAULT_GLOBAL, symbols: {}, confirmed: [], combos: [...DEFAULT_COMBOS], pairs: [], auto: [] };
/** 新版本的参数与冷却存在新键里；旧键（settings、cooldown）留给回退版本，不再写。 */
export { COOLDOWN_KEY, SETTINGS_KEY };
/** 自动配置下开的仓，开仓时的出场、止损与最长持有（按配对键，带持仓编号）。存在 state 表里，旧版本不读。 */
export const EXITS_KEY = 'autoExits';
type ExitRules = { id: string; exitBps: number; stopBps: number; maxHoldMinutes: number };

export interface EngineOptions { store: VarLighterStore; fetchImpl?: FetchLike; connect?: Connect; now?: () => number; log?: (line: string) => void; /** Var token 询价；不给就只用公开报价。 */ quoter?: VarQuoter }

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const dayStart = (time: number) => Math.floor(time / 86_400_000) * 86_400_000;
const legRef = (leg: Leg): LegRef => ({ venue: leg.venue, symbol: leg.symbol, name: VENUE_NAMES[leg.venue] });

// ---- 旧参数迁移（v0.87.0 以前） ----
/** 旧参数换成新参数：配对键与方向换新写法，采集场所换成组合（原来采集的 Lighter 场所各对 Var，另加 Var 对 Entropy；主网在采集时加主网对 Entropy）。 */
export function upgradeSettings(old: unknown): Settings {
  if (!isObject(old)) return DEFAULT_SETTINGS;
  const symbols: Record<string, SymbolParams> = {};
  if (isObject(old.symbols)) for (const [key, raw] of Object.entries(old.symbols)) {
    const upgraded = upgradeKey(key);
    if (!upgraded || !isObject(raw)) continue;
    const directions = Array.isArray(raw.directions) ? raw.directions.map(upgradeDirection).filter(item => item !== null) : undefined;
    try { symbols[upgraded] = readSymbolParams({ ...raw, ...(directions ? { directions } : {}) }); } catch { /* 无效的单个配对参数丢掉 */ }
  }
  const extra = isObject(old.globalExtra) ? old.globalExtra : {};
  const confirmed = Array.isArray(old.confirmed) ? old.confirmed.map(item => typeof item === 'string' ? upgradeKey(item) : null).filter((item): item is string => item !== null) : [];
  const venues = Array.isArray(old.venues) ? old.venues : ['rh', 'lighter'];
  const combos = COMBOS.filter(combo => combo === 'var|entropy' || (combo === 'var|rh' && venues.includes('rh')) || ((combo === 'var|lighter' || combo === 'lighter|entropy') && venues.includes('lighter')));
  return {
    revision: Number.isSafeInteger(old.revision) ? old.revision as number : 0,
    global: upgradeGlobal({ ...(isObject(old.global) ? old.global : {}), ...(typeof extra.minNetBps === 'number' ? { minNetBps: extra.minNetBps } : {}) }),
    symbols, confirmed: [...new Set(confirmed)].sort(), combos, pairs: [], auto: [],
  };
}
export const LEGACY_UPGRADE: LegacyUpgrade = {
  settings: upgradeSettings,
  cooldown: old => isObject(old) ? Object.fromEntries(Object.entries(old).flatMap(([key, until]) => { const upgraded = upgradeKey(key); return upgraded && typeof until === 'number' ? [[upgraded, until]] : []; })) : {},
  fees: old => {
    const global = isObject(old) && isObject(old.global) ? old.global : {};
    const fee = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
    return { aFeeBps: fee(global.varFeeBps), bFeeBps: fee(global.rhFeeBps) };
  },
};

/** 手动配对的校验：两腿不同场所、代码合法、乘数在范围内并按十进制写法规整、类别与备注。 */
export function readCustomPair(value: unknown): CustomPair {
  const fail = (message: string): never => { throw new ParamsError(message); };
  if (!isObject(value)) return fail('手动配对须为对象');
  const unknown = Object.keys(value).find(key => !['a', 'b', 'ratio', 'kind', 'note'].includes(key));
  if (unknown) fail(`手动配对包含未知字段 ${unknown.slice(0, 40)}`);
  const leg = (raw: unknown, name: string): Leg => {
    if (!isObject(raw) || typeof raw.venue !== 'string' || !VENUE_IDS.includes(raw.venue as VenueId) || typeof raw.symbol !== 'string' || !LEG_SYMBOL.test(raw.symbol) || Object.keys(raw).some(key => key !== 'venue' && key !== 'symbol')) fail(`${name}无效（场所与代码）`);
    return { venue: (raw as { venue: VenueId }).venue, symbol: (raw as { symbol: string }).symbol };
  };
  const a = leg(value.a, 'A 腿'), b = leg(value.b, 'B 腿');
  if (a.venue === b.venue) fail('两条腿须在不同场所');
  const ratio = value.ratio === undefined ? 1 : value.ratio;
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < RATIO_MIN || ratio > RATIO_MAX) fail(`乘数须为 ${RATIO_MIN} 到 ${RATIO_MAX} 之间的数`);
  const kind = value.kind === undefined ? 'other' : value.kind;
  if (typeof kind !== 'string' || !ASSET_KINDS.includes(kind as AssetKind)) fail('类别无效');
  const note = value.note === undefined ? '' : value.note;
  if (typeof note !== 'string' || note.length > 80) fail('备注须为 80 字以内');
  return { a, b, ratio: Number(formatRatio(ratio as number)), kind: kind as AssetKind, note: (note as string).trim() };
}
export const customKey = (pair: CustomPair) => pairKey(pair.a, pair.b, pair.ratio);
/** 这个键是否是某个组合的自动配对（同代码或同一别名组、乘数 1、A 在前）。 */
function autoComboOf(key: string): Combo | null {
  const parsed = parsePairKey(key);
  if (!parsed || parsed.ratio !== 1 || !sameSymbol(parsed.a.symbol, parsed.b.symbol)) return null;
  const combo = `${parsed.a.venue}|${parsed.b.venue}` as Combo;
  return COMBOS.includes(combo) ? combo : null;
}

/** 一个行情流场所的运行状态：行情流（没有配对用到时为 null）、目录与订阅完整盘口的腿（最近一次取到的快照与原因）。 */
interface VenueRuntime {
  venue: LiveVenue; stream: LiveStream | null; markets: MarketSpec[]; bySymbol: Map<string, MarketSpec>; catalog: SourceState; nextCatalog: number;
  depth: Map<string, DepthEntry>;
}
interface DepthEntry { leg: LegInfo; snapshot: DepthSnapshot | null; error: string | null }

export function createVarLighterEngine({ store, fetchImpl = fetch, connect, now = Date.now, log = () => {}, quoter }: EngineOptions) {
  const open = connect ?? (url => new WebSocket(url) as unknown as ReturnType<Connect>);
  const migrated = store.migrateLegacy(now(), LEGACY_UPGRADE);
  if (migrated && migrated.positions + migrated.trades + migrated.skipped > 0) log(`varlighter: 已升级为两腿口径（持仓 ${migrated.positions}、成交 ${migrated.trades}${migrated.skipped ? `、无法识别 ${migrated.skipped}` : ''}）`);
  let settings: Settings = normalizeSettings(store.state<Settings>(SETTINGS_KEY));
  let autoKeys = new Set(settings.auto);
  /** 自动配置用的统计（各时段与全天），按配对缓存；名义金额档或类别变了就重算。 */
  const autoStats = new Map<string, { at: number; bucket: SizeBucket; kind: AssetKind; stats: RegimeStats[] }>();
  const live = new Map<LiveVenue, VenueRuntime>(LIVE_VENUES.map(venue => [venue, { venue, stream: null, markets: [], bySymbol: new Map(), catalog: { at: null, ok: null, error: null, count: 0 }, nextCatalog: 0, depth: new Map() }]));
  let listings = new Map<string, VarListing>(), varMarkets = new Map<string, MarketSpec>();
  let pairs: PairInfo[] = [], pairsByKey = new Map<string, PairInfo>();
  let running = false;
  const varSource: SourceState = { at: null, ok: null, error: null, count: 0 };
  let lastPoll: PollStats | null = null, lastLive: LiveStats | null = null;
  const lastQuoteAt = new Map<string, number>(), lastLiveAt = new Map<string, number>(), latest = new Map<string, Sample>();
  const trackers = new Map<string, BaselineTracker>();
  const positions = new Map<string, Position>();
  let cooldown = Object.fromEntries(Object.entries(store.state<Record<string, number>>(COOLDOWN_KEY) ?? {}).filter(([key, until]) => parsePairKey(key) && Number.isFinite(until)));
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
  const exits = new Map<string, ExitRules>(Object.entries(store.state<Record<string, ExitRules>>(EXITS_KEY) ?? {}).filter(([key, rules]) =>
    isObject(rules) && positions.get(key)?.id === rules.id && [rules.exitBps, rules.stopBps, rules.maxHoldMinutes].every(value => typeof value === 'number' && Number.isFinite(value))));
  // 持仓与成交已各自落盘；这份记录写不进去时只记日志，该仓退回按当前参数平仓。
  const saveExits = () => { try { store.setState(EXITS_KEY, Object.fromEntries(exits), now()); } catch (error) { log(`varlighter: 自动配置的平仓规则保存失败：${message(error)}`); } };
  for (const symbol of positions.keys()) { const sample = store.latest(symbol); if (sample) latest.set(symbol, sample); }

  function normalizeSettings(saved: Settings | null): Settings {
    if (!saved) return DEFAULT_SETTINGS;
    try {
      const symbols: Record<string, SymbolParams> = {};
      for (const [key, params] of Object.entries(saved.symbols ?? {})) if (parsePairKey(key)) symbols[key] = readSymbolParams(params);
      const combos = Array.isArray(saved.combos) ? COMBOS.filter(combo => saved.combos.includes(combo)) : [...DEFAULT_COMBOS];
      const custom: CustomPair[] = [];
      for (const raw of Array.isArray(saved.pairs) ? saved.pairs.slice(0, MAX_CUSTOM_PAIRS) : []) { try { custom.push(readCustomPair(raw)); } catch { /* 无效的单个手动配对丢掉 */ } }
      // global 里只取本版本认识的键：更新的版本往里加了字段再回退到这一版，不能因此丢掉整份参数。
      const global = isObject(saved.global) ? Object.fromEntries(Object.entries(saved.global).filter(([key]) => key in DEFAULT_GLOBAL)) : {};
      const auto = Array.isArray(saved.auto) ? [...new Set(saved.auto.filter(key => typeof key === 'string' && key in symbols))].sort() : [];
      return { revision: Number.isSafeInteger(saved.revision) ? saved.revision : 0, global: readGlobalParams(global), symbols, confirmed: (saved.confirmed ?? []).filter(key => parsePairKey(key)), combos, pairs: custom, auto };
    } catch (error) {
      log(`varlighter: 已保存的参数无效，改用默认值：${error instanceof Error ? error.message : String(error)}`);
      return { ...DEFAULT_SETTINGS, revision: Number.isSafeInteger(saved.revision) ? saved.revision : 0 };
    }
  }
  const storedOf = (symbol: string): SymbolParams => settings.symbols[symbol] ?? DEFAULT_SYMBOL;
  const pairOf = (key: string) => pairsByKey.get(key);
  /**
   * 一个配对当前的推荐参数（自动配置用）：统计取最近一个基线窗口（最长 72 小时）的样本，10 分钟重算一次；
   * 当前时段的样本够最少样本数就用它，否则用全天的，都不够或没有可成交价时没有推荐值。手续费、滑点与最低净利按当前的算，改了马上生效。
   */
  function recommendation(key: string): Omit<AutoView, 'on'> {
    const pair = pairOf(key);
    if (!pair) return { params: null, reason: '配对不在当前目录里', at: null, regime: null, samples: 0 };
    const time = now(), stored = storedOf(key), bucket = bucketOf(stored.notionalUsd);
    let cached = autoStats.get(key);
    if (!cached || time - cached.at >= AUTO_REFRESH_MS || cached.bucket !== bucket || cached.kind !== pair.kind) {
      // 两腿都是行情流的配对几秒一个样本：与基线一样约每分钟取一个，样本数门槛、半衰期与含 Var 的配对同口径。
      const gap = bothLive(key) ? LIVE_BASELINE_GAP_MS : 0;
      let kept = -Infinity;
      const samples = store.samples(key, time - Math.min(settings.global.windowHours, AUTO_WINDOW_MAX_HOURS) * 3_600_000, time).filter(sample => sample.t - kept >= gap && (kept = sample.t, true));
      let stats = symbolStats(pair.kind, samples, stored.entryBps, bucket);
      // 100k 档要完整盘口，启用前的样本没有：整个窗口都没有时先按 1k 档的成本算，开仓时的预期净利门槛仍按当时的 100k 档。
      if (bucket !== '1k' && stats.at(-1)!.costMedian === null) stats = symbolStats(pair.kind, samples, stored.entryBps, '1k');
      cached = { at: time, bucket, kind: pair.kind, stats };
      autoStats.set(key, cached);
    }
    const regime = regimeOf(pair.kind, time), fees = feesOf(pair);
    const costs = { slippageBps: settings.global.slippageBps, minNetBps: settings.global.minNetBps, aFeeBps: fees?.aFeeBps ?? 0, bFeeBps: fees?.bFeeBps ?? 0 };
    for (const item of [cached.stats.find(entry => entry.regime === regime), cached.stats.at(-1)]) {
      const params = item && item.samples >= settings.global.minSamples ? recommendParams(item, costs) : null;
      if (item && params) return { params, reason: null, at: cached.at, regime: item.regime, samples: item.samples };
    }
    const all = cached.stats.at(-1)!;
    return { params: null, reason: all.samples >= settings.global.minSamples ? '近期样本没有可成交价，算不出往返成本' : `近期样本不足（${all.samples} / ${settings.global.minSamples}）`, at: cached.at, regime: null, samples: all.samples };
  }
  /** 生效的参数：用自动配置且算得出推荐值时，入场、出场、止损与最长持有换成推荐值；算不出时仍是保存的参数（开仓由 autoPending 挡住）。 */
  const paramsOf = (symbol: string): SymbolParams => {
    const stored = storedOf(symbol), auto = autoKeys.has(symbol) ? recommendation(symbol).params : null;
    return auto ? { ...stored, ...auto } : stored;
  };
  const autoPending = (symbol: string) => autoKeys.has(symbol) && recommendation(symbol).params === null;
  /** 持仓的平仓规则：自动配置下开的仓沿用开仓时的出场、止损与最长持有，推荐值随时段或重算变了也不动已有的仓。 */
  const holdParams = (position: Position): SymbolParams => {
    const params = paramsOf(position.symbol), kept = exits.get(position.symbol);
    return kept?.id === position.id ? { ...params, exitBps: kept.exitBps, stopBps: kept.stopBps, maxHoldMinutes: kept.maxHoldMinutes } : params;
  };
  const dropExits = (symbol?: string) => { if (symbol === undefined ? exits.size : exits.has(symbol)) { if (symbol === undefined) exits.clear(); else exits.delete(symbol); saveExits(); } };
  const eligible = (pair: PairInfo | undefined) => !!pair && pair.identity !== 'mismatch' && (pair.identity === 'verified' || settings.confirmed.includes(pair.key));
  const legsOfKey = (key: string): string[] => { const parsed = parsePairKey(key); return parsed ? [legKey(parsed.a), legKey(parsed.b)] : []; };
  /** 这个配对的某条腿已在另一个配对持仓（场所按代码合并持仓，两笔反向会互相抵消）。 */
  const legBusy = (pair: PairInfo) => { const legs = new Set([legKey(pair.a), legKey(pair.b)]); return [...positions.keys()].some(key => key !== pair.key && legsOfKey(key).some(leg => legs.has(leg))); };
  const marketsOf = (venue: VenueId): MarketSpec[] => venue === 'var' ? [...varMarkets.values()] : live.get(venue)!.markets;
  const marketOf = (leg: Leg): MarketSpec | undefined => leg.venue === 'var' ? varMarkets.get(leg.symbol) : live.get(leg.venue)!.bySymbol.get(leg.symbol);
  /** 用到的场所：开着的组合与手动配对的两腿。 */
  function usedVenues(): Set<VenueId> {
    const used = new Set<VenueId>();
    for (const combo of settings.combos) for (const venue of comboVenues(combo)) used.add(venue);
    for (const custom of settings.pairs) { used.add(custom.a.venue); used.add(custom.b.venue); }
    return used;
  }
  /** 两腿手续费：手动值优先，其次目录；任一腿取不到为 null。 */
  function feesOf(pair: PairInfo): LegFees | null {
    const a = legFeeBps(settings.global, pair.a.venue, pair.a.market.takerFeeBps), b = legFeeBps(settings.global, pair.b.venue, pair.b.market.takerFeeBps);
    return a === null || b === null ? null : { aFeeBps: a, bFeeBps: b };
  }
  /** 已启用或有持仓的配对键。 */
  const activeKeys = (): Set<string> => new Set([...positions.keys(), ...Object.entries(settings.symbols).filter(([, params]) => params.enabled).map(([key]) => key)]);

  function rebuildPairs(): void {
    const built: PairInfo[] = [];
    for (const combo of settings.combos) {
      const [a, b] = comboVenues(combo), aMarkets = marketsOf(a), bMarkets = marketsOf(b);
      if (aMarkets.length && bMarkets.length) built.push(...comboPairs(combo, aMarkets, bMarkets));
    }
    const keys = new Set(built.map(pair => pair.key));
    for (const custom of settings.pairs) {
      const a = marketOf(custom.a), b = marketOf(custom.b), info = a && b ? customPairInfo(custom, a, b) : null;
      if (info && !keys.has(info.key)) { built.push(info); keys.add(info.key); }
    }
    pairs = sortPairs(built);
    pairsByKey = new Map(pairs.map(pair => [pair.key, pair]));
    // 重启后参数与持仓先于配对就有了：配对一建好就补上要订阅盘口的腿与 Entropy 要订阅的市场。
    updateDepth();
    syncEntropyMarkets();
  }

  /** 基线跟踪器：首次用到时从库里预热最近一个窗口的样本。窗口或最少样本改了就全部重建。 */
  function tracker(pair: PairInfo): BaselineTracker {
    let found = trackers.get(pair.key);
    // 手动配对删了再按同键加回、类别改了时，按新类别重建（时段划分随类别不同）。
    if (!found || found.kind !== pair.kind) {
      found = new BaselineTracker(pair.kind, settings.global.windowHours * 3_600_000, settings.global.minSamples, bothLive(pair.key) ? LIVE_BASELINE_GAP_MS : 0);
      const time = now();
      for (const sample of store.samples(pair.key, time - settings.global.windowHours * 3_600_000, time)) found.push(sample);
      trackers.set(pair.key, found);
    }
    return found;
  }

  /** 订阅完整盘口的腿：启用的与有持仓的配对的行情流腿，每个场所最多 MAX_DEPTH_MARKETS 条；同步给各场所的行情流。 */
  function updateDepth(): void {
    // 有持仓的配对排在前面：腿数到上限时先保住持仓腿的盘口（平仓滑点要用）。
    const active = [...activeKeys()].sort((x, y) => Number(positions.has(y)) - Number(positions.has(x)) || (x < y ? -1 : x > y ? 1 : 0));
    for (const runtime of live.values()) {
      const wanted = new Map<string, LegInfo>();
      for (const key of active) {
        const pair = pairOf(key);
        for (const leg of pair ? [pair.a, pair.b] : []) if (leg.venue === runtime.venue && wanted.size < MAX_DEPTH_MARKETS) wanted.set(legKey(leg), leg);
      }
      for (const [key, entry] of runtime.depth) if (wanted.get(key)?.market.id !== entry.leg.market.id) runtime.depth.delete(key);
      for (const [key, leg] of wanted) if (!runtime.depth.has(key)) runtime.depth.set(key, { leg, snapshot: null, error: null });
      runtime.stream?.setDepthMarkets(new Map([...runtime.depth.values()].map(({ leg }) => [leg.market.id, leg.market.coin ?? `io:${leg.symbol}`])));
    }
  }
  /** Entropy 行情流订阅配对用到的市场。 */
  function syncEntropyMarkets(): void {
    const stream = live.get('entropy')!.stream;
    if (!(stream instanceof HyperliquidStream)) return;
    const coins = new Map<number, string>();
    for (const pair of pairs) for (const leg of [pair.a, pair.b]) if (leg.venue === 'entropy' && pair.identity !== 'mismatch') coins.set(leg.market.id, leg.market.coin ?? `io:${leg.symbol}`);
    stream.setMarkets(coins);
  }

  /** 启停各场所的行情流：有组合或手动配对用到的场所才连。 */
  function syncStreams(): void {
    const used = usedVenues();
    for (const runtime of live.values()) {
      const want = running && used.has(runtime.venue);
      if (want && !runtime.stream) {
        runtime.stream = runtime.venue === 'entropy' ? new HyperliquidStream({ connect: open, now, log }) : new LighterStream({ venue: runtime.venue, connect: open, now, log });
        runtime.stream.start();
        if (runtime.venue === 'entropy') syncEntropyMarkets();
        updateDepth();
      }
      if (!want && runtime.stream) { runtime.stream.close(); runtime.stream = null; runtime.depth.clear(); }
    }
  }

  /** 刷新一个行情流场所的目录（合约规格、手续费，以及自动配对规格核对用的标记价）。没有配对用到的场所也取目录，手动配对要从里面选。 */
  async function refreshCatalog(signal: AbortSignal, venue: LiveVenue = 'rh'): Promise<void> {
    const runtime = live.get(venue)!;
    runtime.catalog.at = now();
    try {
      runtime.markets = venue === 'entropy' ? await fetchEntropyMarkets(fetchImpl, signal) : (await fetchRhMarkets(fetchImpl, signal, venue)).map(market => lighterMarket(venue, market));
      runtime.bySymbol = new Map(runtime.markets.map(market => [market.symbol, market]));
      runtime.catalog.ok = now(); runtime.catalog.error = null; runtime.catalog.count = runtime.markets.length;
      rebuildPairs();
    } catch (error) { runtime.catalog.error = message(error); }
  }

  /** 从行情流取一条腿当前的盘口快照；取不到时保留上一份（按时刻过期），原因记在该腿上。 */
  function refreshEntry(runtime: VenueRuntime, entry: DepthEntry): void {
    const snapshot = runtime.stream?.depth(entry.leg.market.id) ?? null;
    if (snapshot) { entry.snapshot = snapshot; entry.error = null; } else entry.error = runtime.stream?.depthError(entry.leg.market.id) ?? '行情流未连接';
  }
  /** 刷新各场所订阅中的盘口快照（读行情流里的当前盘口，不发请求）。 */
  function refreshDepth(): void {
    for (const runtime of live.values()) for (const entry of runtime.depth.values()) refreshEntry(runtime, entry);
  }

  /**
   * 给已启用或有持仓、带 Var 腿的配对各询一次 Var token 价，有持仓按该腿实际数量，空仓按配对名义金额与公开标记价折算。
   * 没有可用 token 时一个请求也不发；单个失败只少这一个配对的询价，原因在询价状态里。
   * 整个阶段有总时限，到点后没发出的不再发、在途的中止，这一轮用已经拿到的；写法没确认的类别与失败后暂停中的标的不询。
   */
  async function tokenQuotes(signal: AbortSignal, stats: PollStats): Promise<Map<string, TokenQuote>> {
    const result = new Map<string, TokenQuote>();
    if (!quoter?.usable()) return result;
    const jobs: (() => Promise<void>)[] = [], phase = anySignal([signal], TOKEN_QUOTE_PHASE_MS);
    for (const key of [...activeKeys()].sort()) {
      const pair = pairOf(key), varLeg = pair && [pair.a, pair.b].find(leg => leg.venue === 'var'), listing = varLeg && listings.get(varLeg.symbol);
      if (!pair || !varLeg || !listing) continue;
      if (!quoter.wants(pair.kind, varLeg.symbol)) { stats.tokenSkipped++; continue; }
      jobs.push(async () => {
        // 到了阶段时限，或这一轮里前面的请求让 token 不可用了（被拒、被拦截）：剩下的不再发。
        if (phase.aborted || !quoter.usable()) { stats.tokenSkipped++; return; }
        const qty = varQuoteQty(positions.get(key) ?? paramsOf(key), pair.a.venue === 'var' ? 'a' : 'b', pair.ratio, listing.mark);
        if (!qty) { stats.tokenSkipped++; return; }
        await quoter.quote(pair.kind, varLeg.symbol, qty, phase, signal).then(quote => { result.set(key, quote); stats.tokenOk++; }, () => { stats.tokenFailed++; });
      });
    }
    const workers = Array.from({ length: Math.min(TOKEN_QUOTE_CONCURRENCY, jobs.length) }, async () => { for (let job = jobs.shift(); job; job = jobs.shift()) await job(); });
    await Promise.all(workers);
    return result;
  }

  type LegFields = { At: number; Mark: number | null; Index: number | null; Funding: number | null; Bid0: number; Ask0: number; Bid1k: number | null; Ask1k: number | null; Bid100k: number | null; Ask100k: number | null;
    BidRx: number | null; AskRx: number | null; RxAt: number | null; TkQty: number | null; TkReceivedAt: number | null; BidTk: number | null; AskTk: number | null; TkAt: number | null };
  /** 行情流腿在 t 时刻的一档（带盘口冲击），以及判断时刻 decideAt 的一档；t 时刻没有可用一档为 null。 */
  function liveLeg(leg: LegInfo, t: number, decideAt: number, top?: TopPoint | null): LegFields | null {
    const runtime = live.get(leg.venue as LiveVenue)!, stream = runtime.stream;
    const at = top === undefined ? stream?.topAt(leg.market.id, t) ?? null : top;
    if (!at) return null;
    const entry = runtime.depth.get(legKey(leg));
    if (entry) refreshEntry(runtime, entry);
    const depth = depthAt(entry?.snapshot, at, t);
    const rx = decideAt === t ? at : stream?.topAt(leg.market.id, decideAt) ?? null;
    return {
      At: at.at, Mark: at.mark ?? leg.market.mark, Index: at.index ?? leg.market.index, Funding: at.funding ?? leg.market.fundingHourly,
      Bid0: at.bid, Ask0: at.ask, Bid1k: depth?.bid1k ?? null, Ask1k: depth?.ask1k ?? null, Bid100k: depth?.bid100k ?? null, Ask100k: depth?.ask100k ?? null,
      BidRx: rx?.bid ?? null, AskRx: rx?.ask ?? null, RxAt: rx?.at ?? null, BidTk: null, AskTk: null, TkAt: null, TkQty: null, TkReceivedAt: null,
    };
  }
  function varLeg(listing: VarListing, token: TokenQuote | null): LegFields {
    const quote = listing.quote!;
    return {
      At: quote.at, Mark: listing.mark, Index: null, Funding: varHourly(listing.fundingRate),
      Bid0: quote.bid0, Ask0: quote.ask0, Bid1k: quote.bid1k, Ask1k: quote.ask1k, Bid100k: quote.bid100k, Ask100k: quote.ask100k,
      BidRx: null, AskRx: null, RxAt: null, BidTk: token?.bid ?? null, AskTk: token?.ask ?? null, TkAt: token?.at ?? null, TkQty: token?.qty ?? null, TkReceivedAt: token?.receivedAt ?? null,
    };
  }
  function makeSample(pair: PairInfo, t: number, receivedAt: number, a: LegFields, b: LegFields): Sample {
    const prefixed = (side: 'a' | 'b', fields: LegFields) => Object.fromEntries(Object.entries(fields).map(([key, value]) => [`${side}${key}`, value]));
    return { symbol: pair.key, t, receivedAt, decisionAt: null, captureKind: 'decision', regime: regimeOf(pair.kind, t), ratio: pair.ratio, ...prefixed('a', a), ...prefixed('b', b) } as Sample;
  }

  /** 每个配对每批只有一条样本，先用已有历史判断信号。大多数样本批写，有模拟开平仓动作的按时序逐一决定。 */
  function ingest(fresh: { pair: PairInfo; sample: Sample }[], blocked: Record<string, number>, cursors: Map<string, number>): number {
    const passive: Sample[] = [], active: SampleStep[] = [], errors: unknown[] = [];
    fresh.sort((x, y) => x.sample.t - y.sample.t);
    for (const { pair, sample } of fresh) {
      try {
        const track = tracker(pair), params = paramsOf(pair.key), position = positions.get(pair.key) ?? null;
        const baseline = track.value(sample.regime, sample.t), decision = decide(sample, baseline, position ? holdParams(position) : params, position);
        if ((decision.kind === 'open' && params.enabled) || decision.kind === 'close') {
          active.push({ pair, sample, params, position, baseline, decision });
        } else { sample.decisionAt = now(); passive.push(sample); }
      } catch (error) {
        trackers.delete(pair.key); // The next read rebuilds from all committed quotes, including this one.
        passive.push(sample);
        errors.push(error);
      }
    }
    let written = 0;
    try { written = saveSamples(passive, cursors); } catch (error) { errors.push(error); }
    for (const step of active) {
      let apply: ReturnType<typeof tradeDecision> | undefined;
      try { apply = tradeDecision(step); }
      catch (error) {
        step.sample.decisionAt = null;
        errors.push(error);
      }
      try {
        if (!saveSamples([step.sample], cursors)) continue;
        written++;
        if (typeof apply === 'string') blocked[apply] = (blocked[apply] ?? 0) + 1;
        else apply?.();
      } catch (error) { errors.push(error); }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, errors.map(message).join('；'));
    return written;
  }

  type SampleStep = { pair: PairInfo; sample: Sample; params: SymbolParams; position: Position | null; baseline: Baseline | null; decision: ReturnType<typeof decide> };
  /** 成功落盘才推进游标；即使随后成交写失败，行情视图与基线仍和重启后相同。 */
  function saveSamples(samples: readonly Sample[], cursors: Map<string, number>): number {
    if (!samples.length) return 0;
    const inserted = store.addNewSamples(samples), added = new Set(inserted);
    noteSamples(inserted);
    for (const sample of samples) {
      if (added.has(sample)) {
        latest.set(sample.symbol, sample);
        trackers.get(sample.symbol)?.push(sample);
      } else if ((latest.get(sample.symbol)?.t ?? -Infinity) < sample.t) {
        const saved = store.latest(sample.symbol);
        if (saved) latest.set(sample.symbol, saved);
      }
      cursors.set(sample.symbol, Math.max(sample.t, latest.get(sample.symbol)?.t ?? 0));
    }
    return inserted.length;
  }

  /**
   * 每分钟一轮：拉 Var 报价，（有 token 时）询价；有 Var 腿的配对按报价时刻对齐另一腿当时的一档（盘口冲击取行情流的当前盘口），写库、计入基线、跑模拟盘。
   */
  async function pollVar(signal: AbortSignal): Promise<void> {
    varSource.at = now();
    let fetched: VarListing[] | null = null;
    try { fetched = await fetchVarListings(fetchImpl, signal, now); } catch (error) { varSource.error = message(error); }
    const receivedAt = now();
    const stats: PollStats = { at: receivedAt, listings: fetched?.length ?? 0, fresh: 0, unchanged: 0, noQuote: 0, noTop: 0, written: 0, noLive: 0, blocked: {}, tokenOk: 0, tokenFailed: 0, tokenSkipped: 0 };
    if (!fetched) return;
    if (varSource.ok === null || receivedAt - varSource.ok > 3 * VAR_POLL_MS) varHealthySince = receivedAt;
    varSource.ok = receivedAt; varSource.error = null; varSource.count = fetched.length;
    listings = new Map(fetched.map(listing => [listing.ticker, listing]));
    varMarkets = new Map(fetched.map(listing => [listing.ticker, varMarket(listing)]));
    rebuildPairs();
    const asked = await tokenQuotes(signal, stats);
    const fresh: { pair: PairInfo; sample: Sample }[] = [];
    for (const pair of pairs) {
      if (pair.identity === 'mismatch' || (pair.a.venue !== 'var' && pair.b.venue !== 'var')) continue;
      const varSide = pair.a.venue === 'var' ? pair.a : pair.b, other = pair.a.venue === 'var' ? pair.b : pair.a;
      const listing = listings.get(varSide.symbol), quote = listing?.quote;
      if (!listing || !quote) { stats.noQuote++; continue; }
      if (quote.at <= (lastQuoteAt.get(pair.key) ?? 0)) { stats.unchanged++; continue; }
      // 判断就发生在现在：记下这一刻对手腿的一档，模拟盘按它成交并复核信号。
      const decideAt = now(), otherLeg = liveLeg(other, quote.at, decideAt);
      if (!otherLeg) { stats.noTop++; continue; }
      if (otherLeg.BidRx === null) stats.noLive++;
      const token = asked.get(pair.key), tokenFresh = token && decideAt - token.at <= TOKEN_QUOTE_MAX_AGE_MS ? token : null;
      const varFields = varLeg(listing, tokenFresh ?? null);
      fresh.push({ pair, sample: pair.a.venue === 'var' ? makeSample(pair, quote.at, receivedAt, varFields, otherLeg) : makeSample(pair, quote.at, receivedAt, otherLeg, varFields) });
      ages.push(receivedAt - quote.at);
    }
    if (ages.length > 2000) ages.splice(0, ages.length - 2000);
    stats.fresh = fresh.length;
    stats.written = ingest(fresh, stats.blocked, lastQuoteAt);
    lastPoll = stats;
  }

  /** 两腿都是行情流的配对：到期的（启用或有持仓的 5 秒，其余 20 秒）按本机当前时刻采一条，两腿都要有可用一档。 */
  function sampleLive(): LiveStats {
    const time = now(), active = activeKeys();
    const stats: LiveStats = { at: time, due: 0, written: 0, noTop: 0, blocked: {} };
    const fresh: { pair: PairInfo; sample: Sample }[] = [];
    for (const pair of pairs) {
      if (pair.identity === 'mismatch' || !isLive(pair.a.venue) || !isLive(pair.b.venue)) continue;
      const interval = active.has(pair.key) ? LIVE_ACTIVE_MS : LIVE_IDLE_MS;
      if (time - (lastLiveAt.get(pair.key) ?? -Infinity) < interval - LIVE_SLACK_MS) continue;
      stats.due++;
      const a = liveLeg(pair.a, time, time), b = liveLeg(pair.b, time, time);
      if (!a || !b) { stats.noTop++; continue; }
      fresh.push({ pair, sample: makeSample(pair, time, time, a, b) });
    }
    stats.written = ingest(fresh, stats.blocked, lastLiveAt);
    // 每秒一检查，多数轮次没有到期的配对：状态里留最近一次有配对到期的那轮。
    if (stats.due > 0 || !lastLive) lastLive = stats;
    return stats;
  }

  /** 先取得上一笔交易之后的账户输入，再计时复核两腿和决定是否开仓。返回的操作只负责提交已决定的交易。 */
  function tradeDecision({ pair, sample, params, position, baseline, decision }: SampleStep): string | (() => void) {
    if (decision.kind === 'close' && position) {
      sample.decisionAt = now();
      const spread = closeSpread(sample, position) ?? decision.spread;
      return () => { finish(position, sample, spread, decision.reason); };
    }
    if (decision.kind !== 'open' || !baseline) throw new Error('模拟盘缺少开仓信号或基线');
    const open = [...positions.values()], fees = feesOf(pair), costs = { slippageBps: settings.global.slippageBps, aFeeBps: fees?.aFeeBps ?? 0, bFeeBps: fees?.bFeeBps ?? 0 };
    const risk = {
      openPositions: open.length, openNotionalUsd: open.reduce((sum, item) => sum + item.notionalUsd, 0),
      dailyNetUsd: store.netSince(dayStart(sample.t)), cooldownUntil: cooldown[pair.key] ?? 0, eligible: eligible(pair), legBusy: legBusy(pair), feeUnknown: !fees, fallbackBaseline: baseline.fallback, autoPending: autoPending(pair.key),
    };
    sample.decisionAt = now();
    const confirmed = confirmOpen(sample, baseline, params, decision, settings.global.maxQuoteAgeSec);
    if (typeof confirmed === 'string') return confirmed;
    const blocker = openBlocker(sample, params, settings.global, {
      ...risk, ...openEconomics(confirmed, params, costs, confirmed.spread.varSource === 'token' ? decision : undefined),
    });
    if (blocker) return blocker;
    const opened = openPosition(`p${sample.decisionAt.toString(36)}-${(++sequence).toString(36)}`, sample, params, confirmed, baseline, costs);
    const autoRules = autoKeys.has(pair.key) ? { id: opened.id, exitBps: params.exitBps, stopBps: params.stopBps, maxHoldMinutes: params.maxHoldMinutes } : null;
    return () => {
      store.openPosition(opened, { at: now(), kind: 'open', message: `${directionText(pair, opened.direction)} ${fmt(opened.notionalUsd, 0)} 美元，价差 ${fmt(opened.entrySpread, 1)} 基点，基线 ${fmt(baseline.median, 1)}，偏离 ${fmt(confirmed.deviation, 1)}（报价时刻 ${fmt(decision.deviation, 1)}）${autoRules ? `，入场线 ${fmt(params.entryBps, 1)}（自动配置）` : ''}${opened.entryVarSource === 'token' ? '，Var 按 token 询价' : opened.entryVarSource ? '，Var 按公开档位' : ''}` });
      positions.set(pair.key, opened);
      if (autoRules) { exits.set(pair.key, autoRules); saveExits(); }
      updateDepth();
    };
  }

  function finish(position: Position, sample: Sample, spread: NonNullable<ReturnType<typeof spreadOf>>, reason: ClosedTrade['reason'], note = ''): ClosedTrade {
    const trade = closePosition(position, sample.t, spread, reason, settings.global, fundingEstimate(position, sample.t, sample.aFunding, sample.bFunding));
    const at = now(), until = sample.t + paramsOf(position.symbol).cooldownMinutes * 60_000;
    const nextCooldown = Object.fromEntries(Object.entries({ ...cooldown, [position.symbol]: until }).filter(([, end]) => end > at));
    store.closePosition(trade, { at, kind: 'close', message: `${note}${CLOSE_REASON_NAMES[reason]}${spread.estimated ? '（盘口估算）' : ''}：净 ${fmt(trade.netUsd, 2)} 美元（${fmt(trade.netBps, 1)} 基点），持有 ${fmt((trade.closedAt - trade.openedAt) / 60_000, 0)} 分钟` }, nextCooldown);
    positions.delete(position.symbol);
    cooldown = nextCooldown;
    updateDepth();
    dropExits(position.symbol);
    return trade;
  }

  function noteSamples(samples: readonly Sample[]): void {
    for (const sample of samples) {
      const counted = recent.get(sample.symbol);
      if (counted) counted.count++;
      const first = firsts.get(sample.symbol);
      if (first !== undefined && (first === null || sample.t < first)) firsts.set(sample.symbol, sample.t);
      if (firstSample !== undefined && (firstSample === null || sample.t < firstSample)) firstSample = sample.t;
    }
  }
  function recentCount(key: string, time: number): number {
    const counted = recent.get(key);
    if (counted && time - counted.at < RECOUNT_MS) return counted.count;
    const count = store.countSince(key, time - 86_400_000);
    recent.set(key, { at: time, count });
    return count;
  }
  /** 分批删过期样本，批间让出事件循环；停服时停下。 */
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

  function positionSummary(position: Position | null, sample: Sample | null): StateRow['position'] {
    if (!position) return null;
    const mark = sample ? markOf(position, sample) : null;
    return { direction: position.direction, openedAt: position.openedAt, pnlBps: mark?.pnlBps ?? null, estimated: mark?.estimated ?? null };
  }

  function state(): StateView {
    const time = now();
    const open = [...positions.values()];
    const rows = pairs.map((pair): StateRow => {
      const sample = latest.get(pair.key) ?? null, params = paramsOf(pair.key);
      const baseline = baselineOf(pair, time);
      const spread = sample ? spreadOf(sample, bucketOf(params.notionalUsd)) : null;
      const mid = sample ? midBasis(sample) : null;
      const position = positions.get(pair.key) ?? null;
      return {
        key: pair.key, a: legRef(pair.a), b: legRef(pair.b), ratio: pair.ratio, custom: pair.custom, note: pair.note, venue: pair.b.venue, venueName: VENUE_NAMES[pair.b.venue],
        symbol: pair.symbol, name: pair.name, kind: pair.kind, kindName: KIND_NAMES[pair.kind], identity: pair.identity, eligible: eligible(pair), gapBps: pair.gapBps,
        regime: regimeOf(pair.kind, time), sampleAt: sample?.t ?? null, mid, sellA: spread?.sellA ?? null, buyA: spread?.buyA ?? null, estimated: spread?.estimated ?? null,
        cost: spread ? spread.buyA - spread.sellA : null,
        baseline: baseline ? { median: baseline.median, sigma: baseline.sigma, samples: baseline.samples, regime: baseline.regime, fallback: baseline.fallback } : null,
        z: baseline && mid !== null ? (mid - baseline.median) / baseline.sigma : null,
        rich: baseline && spread ? spread.sellA - baseline.median : null, cheap: baseline && spread ? baseline.median - spread.buyA : null,
        samples24h: recentCount(pair.key, time), firstAt: firstOf(pair.key), cooldownUntil: cooldown[pair.key] > time ? cooldown[pair.key] : null,
        enabled: params.enabled, entryBps: params.entryBps, exitBps: params.exitBps, auto: autoKeys.has(pair.key), autoPending: autoPending(pair.key),
        position: positionSummary(position, sample),
        aFunding: sample?.aFunding ?? pair.a.market.fundingHourly, bFunding: sample?.bFunding ?? pair.b.market.fundingHourly,
        aFeeBps: legFeeBps(settings.global, pair.a.venue, pair.a.market.takerFeeBps), bFeeBps: legFeeBps(settings.global, pair.b.venue, pair.b.market.takerFeeBps),
      };
    });
    refreshDepth();
    const sortedAges = [...ages].sort((a, b) => a - b), used = usedVenues();
    return {
      now: time, startedAt,
      sources: {
        var: { ...varSource, enabled: used.has('var'), poll: lastPoll, quoteAgeMedianMs: sortedAges.length ? sortedAges[Math.floor(sortedAges.length / 2)] : null, token: quoter?.view() ?? null },
        venues: [...live.values()].map((runtime): VenueStatus => ({
          venue: runtime.venue, name: VENUE_NAMES[runtime.venue], enabled: used.has(runtime.venue), catalog: runtime.catalog,
          stream: runtime.stream?.status(runtime.venue === 'entropy' ? (runtime.stream as HyperliquidStream).marketCount : runtime.markets.length) ?? null,
          depth: [...runtime.depth].map(([key, entry]): DepthStatus => ({ key, marketId: entry.leg.market.id, at: entry.snapshot?.at ?? null, error: entry.error })),
          pairs: pairs.filter(pair => pair.a.venue === runtime.venue || pair.b.venue === runtime.venue).length,
        })),
        live: lastLive,
        combos: COMBOS.map(combo => ({ combo, name: comboName(combo), enabled: settings.combos.includes(combo), pairs: pairs.filter(pair => !pair.custom && `${pair.a.venue}|${pair.b.venue}` === combo).length })),
      },
      firstSampleAt: firstSample === undefined ? (firstSample = store.firstSampleAt()) : firstSample,
      rows,
      orphans: orphans(),
      settings,
      paper: { open: open.length, openNotionalUsd: open.reduce((sum, item) => sum + item.notionalUsd, 0), todayNetUsd: store.netSince(dayStart(time)), ...store.totals() },
      regimeNames: REGIME_NAMES,
      venueNames: VENUE_NAMES,
    };
  }

  const lastSample = (key: string) => latest.get(key) ?? store.latest(key);
  /**
   * 配对失联的原因：不在目录里、改判为规格不同，或数据源都正常而 30 分钟没有新样本（某腿不再报价、盘口缺失）。
   * 数据源本身没就绪或在故障（启动期、Var 拉取失败、场所目录未取到、行情流断开或还没收到快照）时返回 null，不把整体故障当成单个配对失联。
   * 30 分钟从「最后样本」与「数据源连续正常的起点」（启动、Var 恢复、各行情流连续可用的起点取最晚）中较晚的一个算起：
   * 停机或故障前的旧样本不会在恢复后第一轮还没写入新样本时就被判失联。
   * 数据源中断不超过 3 分钟再恢复的都不重新计时，否则频繁的短暂断线会让没有报价的持仓一直处理不了。
   */
  function lostReason(key: string, time: number): string | null {
    const parsed = parsePairKey(key);
    if (!parsed) return '配对键无效';
    let healthyFrom = startedAt;
    for (const venue of [parsed.a.venue, parsed.b.venue]) {
      if (venue === 'var') {
        if (!listings.size || varSource.ok === null || time - varSource.ok > 3 * VAR_POLL_MS) return null;
        healthyFrom = Math.max(healthyFrom, varHealthySince);
      } else {
        const runtime = live.get(venue)!;
        if (!runtime.markets.length) return null;
        const streamFrom = runtime.stream?.healthySince() ?? null;
        if (streamFrom === null) return null;
        healthyFrom = Math.max(healthyFrom, streamFrom);
      }
    }
    const pair = pairOf(key);
    if (!pair) return '配对已不在目录里（或组合已关闭、手动配对已删除）';
    if (pair.identity === 'mismatch') return '两边价格相差超过 5%，已改判为规格不同';
    if (time - Math.max(lastSample(key)?.t ?? -Infinity, healthyFrom) <= LOST_MS) return null;
    const closed = pair.kind !== 'crypto' && ['weekend', 'overnight'].includes(regimeOf(pair.kind, time));
    return `超过 ${LOST_MS / 60_000} 分钟没有新样本（${closed ? '可能休市；' : ''}某腿无报价或盘口缺失）`;
  }

  /** 已启用或有模拟持仓、但已失联的键：总览里列出来，可以停用或按最后样本平仓。 */
  function orphans(): OrphanRow[] {
    const time = now();
    return [...activeKeys()].sort().flatMap(key => {
      const reason = lostReason(key, time);
      if (reason === null) return [];
      const position = positions.get(key) ?? null, sample = lastSample(key), parsed = parsePairKey(key);
      return {
        key, a: parsed ? legRef(parsed.a) : null, b: parsed ? legRef(parsed.b) : null, venue: parsed?.b.venue ?? null, venueName: parsed ? VENUE_NAMES[parsed.b.venue] : '',
        symbol: pairTitle(key), reason, enabled: settings.symbols[key]?.enabled === true, lastSampleAt: sample?.t ?? null,
        position: positionSummary(position, sample),
      };
    });
  }

  function symbolView(keyRaw: unknown, hoursRaw: unknown): SymbolView {
    const key = upgradeKey(String(keyRaw ?? ''));
    const pair = key ? pairOf(key) : undefined;
    if (!pair) return reject('unknown_symbol', '不是当前采集中的配对（或该场所组合未开启）');
    const hours = Number(hoursRaw ?? 24);
    if (!Number.isInteger(hours) || hours < 1 || hours > 24 * 14) reject('invalid_hours', '时长须为 1 到 336 小时');
    const time = now(), from = time - hours * 3_600_000, windowMs = settings.global.windowHours * 3_600_000;
    const params = paramsOf(pair.key);
    const all = store.samples(pair.key, from - windowMs, time);
    const local = new BaselineTracker(pair.kind, windowMs, settings.global.minSamples, bothLive(pair.key) ? LIVE_BASELINE_GAP_MS : 0);
    const bucket = bucketOf(params.notionalUsd);
    const points: SymbolPoint[] = [];
    const inRange: Sample[] = [];
    for (const sample of all) {
      if (sample.t >= from) {
        const baseline = local.value(sample.regime, sample.t), spread = spreadOf(sample, bucket);
        points.push({ t: sample.t, mid: midBasis(sample), sellA: spread?.sellA ?? null, buyA: spread?.buyA ?? null, median: baseline?.median ?? null, sigma: baseline?.sigma ?? null, regime: sample.regime, estimated: spread?.estimated ?? false });
        inRange.push(sample);
      }
      local.push(sample);
    }
    const stats: RegimeStats[] = symbolStats(pair.kind, inRange, params.entryBps, bucket);
    const sample = latest.get(pair.key) ?? store.latest(pair.key);
    const quoted = sample ? spreadOf(sample, bucketOf(params.notionalUsd)) : null;
    const fees = feesOf(pair);
    const protection = slippageBudgetBps(params, { minNetBps: settings.global.minNetBps, aFeeBps: fees?.aFeeBps ?? 0, bFeeBps: fees?.bFeeBps ?? 0 }, quoted ? (quoted.buyA - quoted.sellA) / 2 : 0);
    const plans: OrderPlan[] = sample ? DIRECTIONS.map(direction => orderPlan(pair, sample, direction, params.notionalUsd, protection, time)) : [];
    const position = positions.get(pair.key) ?? null;
    return {
      key: pair.key, a: { ...pair.a, name: VENUE_NAMES[pair.a.venue] }, b: { ...pair.b, name: VENUE_NAMES[pair.b.venue] }, ratio: pair.ratio, custom: pair.custom, note: pair.note,
      venue: pair.b.venue, venueName: VENUE_NAMES[pair.b.venue],
      symbol: pair.symbol, name: pair.name, kind: pair.kind, kindName: KIND_NAMES[pair.kind], identity: pair.identity, eligible: eligible(pair), gapBps: pair.gapBps,
      regimes: regimesOf(pair.kind), hours, from, to: time, bucket,
      points: downsample(points, 1500), samples: inRange.length,
      stats: stats.map(item => ({ ...item, suggestedEntryBps: suggestedEntryBps(item) })),
      params: storedOf(pair.key), effective: params, auto: { on: autoKeys.has(pair.key), ...recommendation(pair.key) }, global: settings.global, latest: sample ?? null, plans,
      fees: { a: legFeeBps(settings.global, pair.a.venue, pair.a.market.takerFeeBps), b: legFeeBps(settings.global, pair.b.venue, pair.b.market.takerFeeBps) },
      position: position ? { ...position, mark: sample ? markOf(position, sample) : null } : null,
      trades: store.symbolTrades(pair.key, from).slice(-500),
    };
  }

  function markOf(position: Position, sample: Sample): PositionMark | null {
    const spread = closeSpread(sample, position);
    if (!spread) return null;
    const trade = closePosition(position, sample.t, spread, 'manual', settings.global, null);
    return { netUsd: trade.netUsd, pnlBps: markToMarket(position, spread).pnlBps, at: sample.t, estimated: trade.estimated, varSource: spread.varSource };
  }

  function backtest(body: unknown): BacktestView {
    const request = backtestRequest(body, settings.symbols, settings.global);
    const pair = pairOf(request.symbol) ?? reject('unknown_symbol', '不是当前采集中的配对');
    const time = now(), from = time - request.hours * 3_600_000;
    const samples = store.samples(pair.key, from - request.global.windowHours * 3_600_000, time);
    const fees = [legFeeBps(request.global, pair.a.venue, pair.a.market.takerFeeBps), legFeeBps(request.global, pair.b.venue, pair.b.market.takerFeeBps)];
    const result = runBacktest(pair.key, pair.kind, samples, from, time, request.params, request.global, fees[0] === null || fees[1] === null ? null : { aFeeBps: fees[0], bFeeBps: fees[1] });
    const truncated = result.trades.length > 1000;
    return { ...result, trades: result.trades.slice(-1000), equity: result.equity.slice(-1000), truncated };
  }

  /**
   * 原始样本的一页（docs/mcp.md 第 8.3 节），供客户端拉到本机回测：只读本地库，不看配对是否仍在采集，失联配对的历史也能读。
   * after 不含本身；limit 1–1000。旧键（rh:AAPL）按新键读。
   */
  function samplesPage(symbolRaw: unknown, afterRaw: unknown, limitRaw: unknown): SamplesView {
    const symbol = upgradeKey(String(symbolRaw ?? '')) ?? reject('invalid_symbol', KEY_HINT);
    const after = afterRaw === null || afterRaw === undefined ? 0 : Number(afterRaw);
    if (!/^\d{1,15}$/.test(String(afterRaw ?? '0')) || !Number.isSafeInteger(after)) reject('invalid_after', 'after 须为毫秒时刻（非负整数）');
    const limit = limitRaw === null || limitRaw === undefined ? SAMPLES_PAGE_MAX : Number(limitRaw);
    if (!/^\d{1,4}$/.test(String(limitRaw ?? SAMPLES_PAGE_MAX)) || limit < 1 || limit > SAMPLES_PAGE_MAX) reject('invalid_limit', `limit 须为 1–${SAMPLES_PAGE_MAX} 的整数`);
    const samples = store.samplesAfter(symbol, after, limit);
    const rows: SamplesView['rows'] = [];
    let bytes = 0;
    for (const sample of samples) {
      const row = SAMPLE_FIELDS.map(field => sample[field]);
      bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
      if (bytes > SAMPLE_ROWS_MAX_BYTES) break;
      rows.push(row);
    }
    return {
      symbol, format: SAMPLE_FORMAT, columns: SAMPLE_FIELDS, rows,
      next: samples.length === limit || rows.length < samples.length ? samples[rows.length - 1].t : null,
      firstAt: store.firstAt(symbol), retentionDays: SAMPLE_RETENTION_DAYS,
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
      positions: open.map(position => { const sample = latest.get(position.symbol); return { ...position, mark: sample ? markOf(position, sample) : null, sampleAt: sample?.t ?? null, maxHoldMinutes: holdParams(position).maxHoldMinutes }; }),
      trades, equity, daily: [...daily].map(([day, value]) => ({ day, ...value })),
      totals: store.totals(), todayNetUsd: store.netSince(dayStart(time)),
      limits: { maxOpenPositions: settings.global.maxOpenPositions, maxTotalNotionalUsd: settings.global.maxTotalNotionalUsd, dailyLossLimitUsd: settings.global.dailyLossLimitUsd, paused: settings.global.paused },
      openNotionalUsd: open.reduce((sum, item) => sum + item.notionalUsd, 0),
      events: store.events(100),
    };
  }

  function updateSettings(body: unknown): Settings {
    if (!isObject(body)) return reject('invalid_body', '请求格式无效');
    const unknown = Object.keys(body).find(key => !['revision', 'global', 'symbols', 'confirmed', 'combos', 'pairs', 'auto'].includes(key));
    if (unknown) reject('invalid_body', `包含未知字段 ${unknown.slice(0, 40)}`);
    if (body.revision !== settings.revision) reject('stale_revision', '参数已被别处修改，请刷新后再改', 409);
    try {
      const global = body.global === undefined ? settings.global : readGlobalParams(body.global, settings.global);
      const symbols = { ...settings.symbols };
      if (body.symbols !== undefined) {
        if (!isObject(body.symbols) || Object.keys(body.symbols).length > 200) reject('invalid_body', '标的参数格式无效');
        for (const [raw, value] of Object.entries(body.symbols as Record<string, unknown>)) {
          const key = upgradeKey(raw) ?? reject('invalid_symbol', KEY_HINT);
          if (value === null) { delete symbols[key]; continue; }
          symbols[key] = readSymbolParams(value, symbols[key] ?? DEFAULT_SYMBOL);
        }
      }
      if (Object.keys(symbols).length > MAX_SAVED_SYMBOLS) reject('too_many', `最多保存 ${MAX_SAVED_SYMBOLS} 个配对的参数，先删掉不用的`);
      let confirmed = settings.confirmed;
      if (body.confirmed !== undefined) {
        if (!Array.isArray(body.confirmed) || body.confirmed.length > 400 || body.confirmed.some(item => typeof item !== 'string' || !upgradeKey(item))) reject('invalid_body', '已确认配对列表无效');
        confirmed = [...new Set((body.confirmed as string[]).map(item => upgradeKey(item)!))].sort();
      }
      let autoList = settings.auto;
      if (body.auto !== undefined) {
        if (!Array.isArray(body.auto) || body.auto.length > MAX_SAVED_SYMBOLS || body.auto.some(item => typeof item !== 'string' || !upgradeKey(item))) reject('invalid_body', '自动配置的配对列表无效');
        autoList = (body.auto as string[]).map(item => upgradeKey(item)!);
      }
      // 只留有保存参数的键：参数删掉的配对不再占自动配置的名额。
      autoList = [...new Set(autoList)].filter(key => key in symbols).sort();
      let combos = settings.combos;
      if (body.combos !== undefined) {
        if (!Array.isArray(body.combos) || body.combos.some(item => !COMBOS.includes(item as Combo))) reject('invalid_body', '自动配对组合列表无效');
        combos = COMBOS.filter(combo => (body.combos as unknown[]).includes(combo));
      }
      let custom = settings.pairs;
      if (body.pairs !== undefined) {
        if (!Array.isArray(body.pairs) || body.pairs.length > MAX_CUSTOM_PAIRS) reject('too_many', `手动配对最多 ${MAX_CUSTOM_PAIRS} 个`);
        custom = (body.pairs as unknown[]).map(readCustomPair);
        const keys = custom.map(customKey);
        const duplicate = keys.find((key, index) => keys.indexOf(key) !== index);
        if (duplicate) reject('duplicate_pair', `手动配对重复：${duplicate}`);
      }
      // 组合与手动配对都定下来后再查：只改组合（打开一个组合）也不能让手动配对与自动配对同键。
      // 升级前就有、组合也早已开着的同键手动配对（自动配对后来加了代码别名才同键）放过，不让每次无关的保存都失败；配对表里自动配对优先。
      const existing = (key: string, combo: Combo) => settings.combos.includes(combo) && settings.pairs.some(item => customKey(item) === key);
      const auto = custom.map(customKey).find(key => { const combo = autoComboOf(key); return combo && combos.includes(combo) && !existing(key, combo); });
      if (auto) reject('duplicate_pair', `${auto} 已是开启中的组合「${comboName(autoComboOf(auto)!)}」的自动配对，${body.pairs !== undefined ? '不必手动添加' : body.combos !== undefined ? '先删掉这个手动配对再开组合' : '先删掉这个手动配对或关掉该组合'}`);
      // 关掉的组合或删掉的手动配对上不能还有启用的配对或模拟持仓。
      const enabled = Object.entries(symbols).filter(([, params]) => params.enabled).map(([key]) => key);
      const customKeys = new Set(custom.map(customKey));
      const coveredAfter = (key: string) => { const combo = autoComboOf(key); return (combo !== null && combos.includes(combo)) || customKeys.has(key); };
      const coveredBefore = (key: string) => { const combo = autoComboOf(key); return (combo !== null && settings.combos.includes(combo)) || settings.pairs.some(item => customKey(item) === key); };
      for (const key of [...new Set([...enabled, ...positions.keys()])]) {
        if (coveredBefore(key) && !coveredAfter(key)) reject('pair_busy', `${pairTitle(key)}（${key}）还启用着或有模拟持仓，先停用并平仓再关闭它的组合或删除手动配对`, 409);
      }
      for (const venue of LIVE_VENUES) {
        // 有持仓的配对也要订阅盘口，一并计入上限。
        const legsOf = (keys: string[]) => new Set([...new Set([...keys, ...positions.keys()])].flatMap(legsOfKey).filter(leg => leg.startsWith(`${venue}:`)));
        const legs = legsOf(enabled), before = legsOf(Object.entries(settings.symbols).filter(([, params]) => params.enabled).map(([key]) => key));
        // 只挡这次让腿变多的保存：升级前留下的超额状态不卡住无关的保存（改全局参数、确认规格）。
        if (legs.size > MAX_DEPTH_MARKETS && [...legs].some(leg => !before.has(leg))) reject('too_many', `${VENUE_NAMES[venue]} 一侧启用或有模拟持仓的市场最多 ${MAX_DEPTH_MARKETS} 个（各订阅完整盘口），先停用或平掉一些`);
      }
      for (const key of enabled) {
        const pair = pairOf(key), wasEnabled = settings.symbols[key]?.enabled === true;
        if (!pair && !wasEnabled) reject('unknown_symbol', `${pairTitle(key)}（${key}）不在当前配对里（组合未开启、手动配对未添加或目录尚未加载）`);
        // 只挡“这次新启用”的配对：已启用的配对规格降回待确认或不同时，开仓已由 eligible 挡住，
        // 若在这里也拒绝，任何无关的保存（加手动配对、改全局参数）都会被它卡住。
        if (wasEnabled) continue;
        if (pair && pair.identity === 'mismatch') reject('mismatch', `${pairTitle(key)} 两边规格不同，不能启用`);
        if (pair && pair.identity === 'review' && !confirmed.includes(key)) reject('unconfirmed', `${pairTitle(key)} 规格待确认，先在实盘准备页确认后再启用`);
      }
      const windowChanged = global.windowHours !== settings.global.windowHours || global.minSamples !== settings.global.minSamples;
      const pairsChanged = combos.join() !== settings.combos.join() || JSON.stringify(custom) !== JSON.stringify(settings.pairs);
      const usedBefore = usedVenues();
      const next = { revision: settings.revision + 1, global, symbols, confirmed, combos, pairs: custom, auto: autoList };
      store.saveSettings(next, now(), `参数已更新（版本 ${next.revision}）${pairsChanged ? `，组合：${combos.map(comboName).join('、') || '无'}，手动配对 ${custom.length} 个` : ''}`);
      settings = next;
      autoKeys = new Set(autoList);
      // 统计窗口随基线窗口变；不再用自动配置的配对不留缓存。
      for (const key of [...autoStats.keys()]) if (windowChanged || !autoKeys.has(key)) autoStats.delete(key);
      if (windowChanged) trackers.clear();
      if (pairsChanged) {
        // 新用到的场所马上取一次目录（Entropy 没用到时十分钟才取一次，标记价与资金费会旧）。
        const used = usedVenues();
        for (const runtime of live.values()) if (used.has(runtime.venue) && !usedBefore.has(runtime.venue)) runtime.nextCatalog = 0;
        syncStreams(); rebuildPairs();
      }
      updateDepth();
      return settings;
    } catch (error) {
      if (error instanceof ParamsError) return reject('invalid_params', error.message);
      throw error;
    }
  }

  function closeManual(body: unknown) {
    if (!isObject(body) || typeof body.symbol !== 'string' || Object.keys(body).some(key => key !== 'symbol')) return reject('invalid_body', '请求格式无效（symbol 为配对键）');
    const key = upgradeKey(body.symbol) ?? reject('invalid_symbol', KEY_HINT);
    const position = positions.get(key) ?? reject('not_found', '该配对没有模拟持仓', 404);
    const time = now(), sample = lastSample(position.symbol);
    if (!sample) return reject('no_quote', '没有任何报价，无法平仓；可清空模拟盘', 409);
    // 失联的配对等不到新报价：按最后一个样本结算并在事件里注明原因。数据源整体故障不算失联，等恢复。
    const stale = time - sample.t > 10 * 60_000, reason = stale ? lostReason(position.symbol, time) : null;
    if (stale && reason === null) return reject('no_quote', '没有 10 分钟内的报价，无法按市价平仓；数据源恢复后再试', 409);
    const spread = closeSpread(sample, position) ?? reject('no_quote', '该档位缺少可成交价', 409);
    return finish(position, sample, spread, 'manual', reason ? `${reason}，按最后样本（${new Date(sample.t).toISOString().slice(0, 16).replace('T', ' ')} UTC）结算；` : '');
  }

  function resetPaper(body: unknown) {
    if (!isObject(body) || body.confirm !== 'RESET' || Object.keys(body).length !== 1) return reject('invalid_body', '需要确认文字 RESET');
    store.resetPaper(now());
    positions.clear(); cooldown = {}; dropExits();
    updateDepth();
    return { ok: true };
  }

  function catalogs(): Record<VenueId, CatalogEntry[]> {
    const entries = (markets: MarketSpec[]) => markets.map(market => ({ symbol: market.symbol, mark: market.mark })).sort((x, y) => x.symbol < y.symbol ? -1 : x.symbol > y.symbol ? 1 : 0);
    return { var: entries([...varMarkets.values()]), rh: entries(live.get('rh')!.markets), lighter: entries(live.get('lighter')!.markets), entropy: entries(live.get('entropy')!.markets) };
  }

  function readiness(): ReadinessView {
    const time = now(), view = state();
    const enabled = view.rows.filter(row => row.enabled);
    const items: ReadinessItem[] = [];
    const varFresh = varSource.ok !== null && time - varSource.ok < 3 * VAR_POLL_MS;
    const active = view.sources.venues.filter(item => item.enabled);
    const venueText = active.map(item => `${item.name} ${item.stream?.connected ? '已连接' : item.stream?.lastError ?? '未连接'}`).join('；');
    const varUsed = view.sources.var.enabled;
    items.push({ key: 'collect', status: (!varUsed || varFresh) && active.length > 0 && active.every(item => item.stream?.connected) ? 'ok' : 'warn', label: '行情采集',
      detail: `${varUsed ? `Var ${varFresh ? '正常' : varSource.error ?? '未取到'}；` : ''}${venueText || '没有采集中的行情流场所'}` });
    const span = view.firstSampleAt === null ? 0 : (time - view.firstSampleAt) / 86_400_000;
    items.push({ key: 'baseline', status: span >= READY_BASELINE_DAYS ? 'ok' : 'warn', label: `基线至少 ${READY_BASELINE_DAYS} 天`, detail: `已采集 ${span.toFixed(1)} 天（保留 14 天）` });
    const label = (row: StateRow) => `${row.symbol}（${VENUE_NAMES[row.a.venue]} ↔ ${VENUE_NAMES[row.b.venue]}）`;
    items.push({ key: 'enabled', status: enabled.length ? 'ok' : 'warn', label: '选定配对', detail: enabled.length ? enabled.map(label).join('、') : '还没有启用任何配对的模拟盘' });
    const unconfirmed = enabled.filter(row => !row.eligible);
    items.push({ key: 'identity', status: unconfirmed.length ? 'warn' : 'ok', label: '合约规格核对', detail: unconfirmed.length ? `待确认：${unconfirmed.map(label).join('、')}` : '已启用配对的两边规格均已核对' });
    const unknownFee = enabled.filter(row => row.aFeeBps === null || row.bFeeBps === null);
    items.push({ key: 'fees', status: unknownFee.length ? 'warn' : 'ok', label: '两腿手续费', detail: unknownFee.length ? `手续费未知（不开仓）：${unknownFee.map(label).join('、')}；可在全局参数里填手动值` : '已启用配对两腿的手续费都已知（目录或手动值）' });
    const depth = active.flatMap(item => item.depth);
    const stale = depth.filter(item => item.at === null || time - item.at > DEPTH_STALE_MS || item.error !== null);
    items.push({ key: 'depth', status: depth.length && !stale.length ? 'ok' : 'warn', label: '盘口（行情流）', detail: depth.length ? `${depth.length - stale.length}/${depth.length} 条腿的盘口已同步${stale.length ? `；缺：${stale.map(item => `${item.key}${item.error ? `（${item.error}）` : ''}`).join('、')}` : ''}` : '没有启用配对，未订阅盘口' });
    const totals = store.totals();
    items.push({ key: 'paper', status: totals.trades >= READY_PAPER_TRADES && totals.netUsd > 0 ? 'ok' : 'warn', label: `模拟盘至少 ${READY_PAPER_TRADES} 笔且净盈利`, detail: `${totals.trades} 笔，净 ${fmt(totals.netUsd, 2)} 美元，胜率 ${totals.trades ? fmt(totals.wins / totals.trades * 100, 0) : '-'}%` });
    const enabledVar = enabled.some(row => row.a.venue === 'var' || row.b.venue === 'var');
    if (enabledVar || !enabled.length) {
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
        : `${publicAge}；${tokenNote}实盘须每个带 Var 腿的配对都有实时询价` });
    }
    items.push({ key: 'limits', status: 'ok', label: '风控限额', detail: `最多 ${settings.global.maxOpenPositions} 笔，名义合计 ≤ ${fmt(settings.global.maxTotalNotionalUsd, 0)} 美元，当日亏损 ≤ ${fmt(settings.global.dailyLossLimitUsd, 0)} 美元` });
    const orderVenues = [...new Set(enabled.flatMap(row => [row.a.venue, row.b.venue]))].filter(venue => venue !== 'var').map(venue => VENUE_NAMES[venue]);
    items.push({ key: 'lighter_order', status: 'todo', label: '行情流场所的下单连接器', detail: `Lighter RH 链与主网是两套账户：各需账户编号、API 密钥编号与私钥，以及签名器；Entropy（Hyperliquid）需 API 钱包与签名；${orderVenues.length ? `已启用配对用到 ${orderVenues.join('、')}；` : ''}尚未接入` });
    if (enabledVar || !enabled.length) items.push({ key: 'var_order', status: 'todo', label: 'Var 下单接口', detail: 'Var 没有公开交易接口；询价已可用 token 读取（各类标的的写法以实盘准备页的询价状态为准），成交接口尚未确认、尚未接入' });
    items.push({ key: 'funding', status: 'todo', label: '两边账户资金', detail: '每个用到的场所各需 USDC 保证金；按单笔名义金额与杠杆核算，并留出单腿风险的余量' });
    items.push({ key: 'monitor', status: 'todo', label: '实盘监控与告警', detail: '单腿、持仓不一致、亏损上限触发时的飞书告警，接入下单后补上' });
    return { now: time, items, ready: items.every(item => item.status === 'ok'), markets: catalogs() };
  }

  /** 方向的中文：卖 A 场所 / 买 B 场所。 */
  function directionText(pair: PairInfo, direction: Position['direction']): string {
    return DIRECTION_NAMES[direction].replace('A', VENUE_NAMES[pair.a.venue]).replace('B', VENUE_NAMES[pair.b.venue]);
  }

  return {
    /** 某场所的行情流（测试用）；未在采集时为 null。 */
    stream: (venue: LiveVenue = 'rh') => live.get(venue)!.stream,
    /** 测试用：不跑后台循环时按参数启停各场所的行情流。 */
    startStreams(): void { running = true; syncStreams(); },
    pollVar, refreshCatalog, refreshDepth, sampleLive,
    views: { state, symbol: symbolView, samples: samplesPage, backtest, paper, settings: updateSettings, close: closeManual, reset: resetPaper, readiness },
    /**
     * 后台循环：连上用到的行情流（一档、标记价、资金费与启用配对的盘口都走行情流）并在后台每 10 分钟取各场所目录，然后每分钟拉 Var 报价（连同询价），
     * 每秒检查两腿都是行情流的配对是否到期采样，每小时清理过期样本。
     */
    async loop(context: { stopped(): boolean; pause(ms: number): Promise<void> }): Promise<void> {
      running = true;
      syncStreams();
      let nextVar = now() + 5_000, nextPrune = now() + 60_000, nextLive = now() + 10_000;
      // 停服时中断进行中的请求，不等各自的超时：pause 在停服时立即返回。
      const stop = new AbortController();
      let done = false;
      const watcher = (async () => { while (!done && !context.stopped()) await context.pause(1_000); stop.abort(); })();
      const request = () => anySignal([stop.signal], REQUEST_TIMEOUT_MS);
      // 目录与 Var 轮询在后台跑（各自同时最多一个），不拖住行情流配对的采样。
      const busy = new Set<string>(), jobs = new Set<Promise<void>>();
      const background = (name: string, job: () => Promise<void>) => {
        if (busy.has(name)) return;
        busy.add(name);
        const promise = job().catch(error => log(`varlighter: ${name} 失败：${message(error)}`)).finally(() => { busy.delete(name); jobs.delete(promise); });
        jobs.add(promise);
      };
      try {
        while (!context.stopped()) {
          const time = now();
          for (const runtime of live.values()) {
            if (time < runtime.nextCatalog || busy.has(`catalog:${runtime.venue}`)) continue;
            // 标记价与资金费都走行情流，目录只为规格、手续费与自动配对的规格核对，各场所十分钟一次；失败一分钟后重试。
            runtime.nextCatalog = time + CATALOG_MS;
            background(`catalog:${runtime.venue}`, async () => {
              await refreshCatalog(request(), runtime.venue);
              if (runtime.catalog.error) runtime.nextCatalog = Math.min(runtime.nextCatalog, (runtime.catalog.at ?? now()) + CATALOG_RETRY_MS);
            });
          }
          if (time >= nextVar && !busy.has('var') && [...live.values()].some(runtime => runtime.markets.length)) {
            nextVar = time + VAR_POLL_MS;
            background('var', () => pollVar(request()).catch(error => { varSource.error = message(error); }));
          }
          if (time >= nextLive) { nextLive = time + LIVE_TICK_MS; try { sampleLive(); } catch (error) { log(`varlighter: 行情流配对采样失败：${message(error)}`); } }
          if (time >= nextPrune) { nextPrune = time + PRUNE_MS; try { await pruneSamples(time, () => context.stopped()); } catch (error) { log(`varlighter: 清理样本失败：${message(error)}`); } }
          await context.pause(1_000);
        }
      } finally { done = true; running = false; syncStreams(); await watcher; await Promise.allSettled([...jobs]); }
    },
    close(): void { running = false; syncStreams(); store.close(); },
  };
}
export type VarLighterEngine = ReturnType<typeof createVarLighterEngine>;

const message = (error: unknown) => error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
const fmt = (value: number, digits: number) => Number.isFinite(value) ? value.toFixed(digits) : '-';

/** 按时间等分成不超过 limit 格：每格中间价取均值，卖 A 价差取最大、买 A 价差取最小（保留机会的极值），基线取格内最后一个。 */
export function downsample<T extends { t: number; mid: number; sellA: number | null; buyA: number | null; median: number | null; sigma: number | null }>(points: T[], limit: number): T[] {
  if (points.length <= limit) return points;
  const first = points[0].t, span = points.at(-1)!.t - first + 1, result: T[] = [];
  let index = 0;
  for (let cell = 0; cell < limit && index < points.length; cell++) {
    const end = first + span * (cell + 1) / limit;
    const group: T[] = [];
    while (index < points.length && points[index].t < end) group.push(points[index++]);
    if (!group.length) continue;
    const last = group.at(-1)!;
    const sells = group.map(point => point.sellA).filter((value): value is number => value !== null), buys = group.map(point => point.buyA).filter((value): value is number => value !== null);
    result.push({ ...last, mid: group.reduce((sum, point) => sum + point.mid, 0) / group.length, sellA: sells.length ? Math.max(...sells) : null, buyA: buys.length ? Math.min(...buys) : null });
  }
  return result;
}
