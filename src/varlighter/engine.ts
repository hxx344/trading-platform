// DEX 价差模块（原 Var/Lighter 价差，docs/varlighter.md、docs/dexspread.md）的运行时：采集各配对两条腿的对齐样本、维护基线、按策略判断开平仓，
// 并给页面出视图。只写自己的 varlighter.sqlite，不碰执行器。没有模拟盘（docs/dexspread.md 第 18 节）：策略持仓就是实盘持仓（live.ts），
// 实盘默认关闭，录了凭据、开了总开关后才在启用且勾选实盘的配对上下真实订单；其余配对只采集、算基线与回测。
// 有 Var 腿的配对跟着每分钟一次的 Var 报价采样（样本时刻 = Var 报价时刻，另一腿回看那一刻的行情流）；两腿都是行情流的配对
// 由本机每秒检查一次，启用或有持仓的每 5 秒、其余每 20 秒采一条（样本时刻 = 本机采样时刻）。
import { createHash } from 'node:crypto';
import { anySignal } from '../any-signal.mjs';
import { TOKEN_QUOTE_CONCURRENCY, TOKEN_QUOTE_MAX_AGE_MS, TOKEN_QUOTE_PHASE_MS, type TokenQuote, type VarQuoter } from './varquote.ts';
import { Worker } from 'node:worker_threads';
import { backtestRequest } from './backtest.ts';
import type { ReplayJob } from './replay-worker.ts';
import { DEPTH_MAX_GAP_MS, HyperliquidStream, LighterStream, MAX_DEPTH_MARKETS, depthAt, fetchEntropyMarkets, fetchRhMarkets, fetchVarListings,
  type Connect, type DepthSnapshot, type FetchLike, type LiveStream, type TopPoint } from './feeds.ts';
import { createLeadTester } from './lead-streams.ts';
import { ACCOUNT_HISTORY_LIMIT, ACCOUNT_HISTORY_WINDOW_MS, COLLATERAL_ASSET, fetchAccount, fetchAccountHistory, type AccountFunding, type AccountHistorySnapshot, type AccountSnapshot, type AccountTrade } from './accounts.ts';
import { KEY_VENUES, configuredVenues, type DexAccounts, type DexAccountsSource, type KeyVenue } from '../dex/keys.ts';
import { ASSET_KINDS, COMBOS, DEFAULT_COMBOS, KIND_NAMES, LEG_SYMBOL, LIVE_VENUES, RATIO_MAX, RATIO_MIN, REGIME_NAMES, SAMPLE_FIELDS, SAMPLE_FORMAT, VENUE_IDS, VENUE_NAMES,
  bothLive, bucketOf, comboName, comboPairs, comboVenues, customPairInfo, formatRatio, isLive, legKey, lighterMarket, midBasis, pairKey, pairTitle, parsePairKey,
  regimeOf, regimesOf, sameSymbol, sortPairs, spreadOf, targetSpread, upgradeKey, varHourly, varMarket, varQuoteQty,
  type AssetKind, type Combo, type CustomPair, type Leg, type LegInfo, type LiveVenue, type MarketSpec, type PairInfo, type Sample, type SizeBucket, type Spread, type VarListing, type VenueId } from './model.ts';
import { orderPlan, type OrderPlan } from './plan.ts';
import { LiveError, createLiveTrader, type BlockerMemo, type LiveBlock, type LivePosition, type LiveSignal, type LiveTrader } from './live.ts';
import { LighterPrivateStream, type LighterPrivateStatus } from './lighter-private.ts';
import { LiveKeysError, type LighterKey, type LiveKeys, type LiveKeysStore } from './livekeys.ts';
import { createLighterSigner, lighterSignerProblem, type LighterSigner } from './lighter-signer.ts';
import { createEntropyTrader, createLighterTrader, scrub, type VenueTrader } from './orders.ts';
import { BaselineTracker, LIVE_BASELINE_GAP_MS, suggestedEntryBps, symbolStats, type Baseline, type RegimeStats } from './stats.ts';
import { ENTROPY_COST_AFTER_FILL_MS, ENTROPY_COST_POLL_MS, accountHashOf as entropyAccountHashOf, createEntropyCostCollector } from './entropy-cost.ts';
import { ATTENTION_BLOCKS, DEFAULT_GLOBAL, DEFAULT_SYMBOL, DIRECTIONS, ParamsError, closePosition, closeSpread, confirmOpen, decide, openEconomics, slippageBudgetBps, legFeeBps,
  deviationToClose, markToMarket, openBlocker, openPosition, positionSpread, readGlobalParams, readSymbolParams, recommendParams, upgradeDirection, upgradeGlobal,
  CLOSE_REASON_NAMES, DIRECTION_NAMES, type Direction, type GlobalParams, type LegFees, type Position, type SymbolParams } from './strategy.ts';
import { COOLDOWN_KEY, SAMPLE_RETENTION_DAYS, SETTINGS_KEY, type LegacyUpgrade, type VarLighterStore } from './store.ts';
import type { AccountsRefreshResult, AccountsView, AutoView, BacktestView, CatalogEntry, DepthStatus, GateView, LegRef, LivePositionMark, LiveStats, LiveTradeView, OrphanRow, PushStats, PollStats, PositionMark, ReadinessItem, ReadinessView, SamplesView, Settings, SourceState, StateRow, StateView,
  SymbolPoint, SymbolView, VenueAccountView, VenuePositionView, VenueStatus, LiveView } from './views.ts';

export const VAR_POLL_MS = 60_000;
export const CATALOG_MS = 10 * 60_000;
/** 目录读取失败后的重试间隔。 */
export const CATALOG_RETRY_MS = 60_000;
/** 两腿都是行情流的配对：检查间隔、启用或有持仓的采样间隔、其余的采样间隔。 */
export const LIVE_TICK_MS = 1_000, LIVE_ACTIVE_MS = 5_000, LIVE_IDLE_MS = 20_000;
/** 到期判断的余量：每秒一检查时不会因为毫秒抖动拖成 6 秒、21 秒一条。 */
export const LIVE_SLACK_MS = 500;
/** 按行情流推送判断时：盘口冲击沿用这么久以内算过的快照；同一个配对的出错日志这么久记一次。 */
export const PUSH_DEPTH_REUSE_MS = 1_000, PUSH_ERROR_LOG_MS = 60_000;
/** 自动配置：推荐参数所用的统计每这么久重算一次，样本窗口取基线窗口、最长这么多小时。 */
export const AUTO_REFRESH_MS = 10 * 60_000, AUTO_WINDOW_MAX_HOURS = 72;
/** 各配对的重算时刻按配对键错开，最多晚这么久：免得同时到期、在同一次判断里一起读库。 */
export const AUTO_JITTER_MS = 60_000;
/** 判断出错后丢掉基线重建：同一个配对这么久最多一次，持续出错时不反复读库。 */
export const TRACKER_REBUILD_MS = 60_000;
/** 按配对记最近一次被挡下的原因，最多记这么多个配对。 */
const LAST_BLOCKED_MAX = 500;
/** 盘口（行情流）超过这么久没同步算过期。 */
export const DEPTH_STALE_MS = DEPTH_MAX_GAP_MS;
const PRUNE_MS = 3_600_000;
const PRUNE_BATCH = 500;
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
/** 实盘持仓结束后至少冷却这么久（参数里的冷却分钟数更长时按参数）。 */
export const MIN_COOLDOWN_MS = 60_000;
/** 场所账户每分钟读一次；超过三分钟没读到新的就不算数。 */
export const ACCOUNT_POLL_MS = 60_000;
export const ACCOUNT_STALE_MS = 3 * 60_000;
/** 账户成交、资金费与盈亏历史每 3 分钟拉一次；10 分钟未更新标过期。 */
export const ACCOUNT_HISTORY_POLL_MS = 3 * 60_000;
export const ACCOUNT_HISTORY_STALE_MS = 10 * 60_000;
/** 账户权益快照落盘最小间隔（5 分钟）。 */
export const ACCOUNT_SNAPSHOT_GAP_MS = 5 * 60_000;
/** 页面手动触发账户刷新的最短冷却。 */
export const ACCOUNT_MANUAL_REFRESH_COOLDOWN_MS = 10_000;
const ACCOUNT_CURVE_POINTS_MAX = 300;
const LIGHTER_AUTH_TTL_SEC = 3600;
const LIGHTER_AUTH_RENEW_MS = 50 * 60_000;
/** 「账户资金」就绪的下限：每个要用的场所可用余额不少于实盘起步的单笔名义金额（docs/dexspread.md 12.6）。 */
export const READY_FUNDING_USD = 100;
export class VarLighterError extends Error {
  readonly status: number; readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
const reject = (code: string, message: string, status = 400): never => { throw new VarLighterError(status, code, message); };
/** 样本导出每页的上限。 */
export const SAMPLES_PAGE_MAX = 1000;
/** 行数据留在 480 KiB 内，给只读令牌的 512 KiB 应答上限留出列名和分页元数据空间。 */
const SAMPLE_ROWS_MAX_BYTES = 480 * 1024;
/** 详情页从最近这么多笔已结束的实盘持仓里挑这个配对的成交。 */
const LIVE_TRADES_SCAN = 2000;
const KEY_HINT = '配对键无效（应为「场所:代码|场所:代码」，如 var:AAPL|rh:AAPL）';

export type { Settings } from './views.ts';
const DEFAULT_SETTINGS: Settings = { revision: 0, global: DEFAULT_GLOBAL, symbols: {}, confirmed: [], combos: [...DEFAULT_COMBOS], pairs: [], auto: [] };
/** 新版本的参数与冷却存在新键里；旧键（settings、cooldown）留给回退版本，不再写。 */
export { COOLDOWN_KEY, SETTINGS_KEY };
/** v0.107.0 把保存为 null 的默认 Entropy 手续费一次性升级为 0.2 基点（不覆盖已有自定义值或用户之后主动清空的选择）。 */
export const ENTROPY_FEE_DEFAULT_MIGRATED_KEY = 'entropy_fee_default_02';

export interface EngineOptions { store: VarLighterStore; fetchImpl?: FetchLike; connect?: Connect; now?: () => number; /** 单调时钟（领先测速用；默认随 custom now 或 performance.now()）。 */ monoNow?: () => number; log?: (line: string) => void; /** Var token 询价；不给就只用公开报价。 */ quoter?: VarQuoter; /** 实盘场所账户（docs/dexspread.md 第 12 节）；不给就是没有配置。 */ accounts?: DexAccountsSource;
  /** 页面录入的实盘凭据（第 13 节）；不给就没有实盘。 */ liveKeys?: LiveKeysStore;
  /** 下单连接器（测试里换成替身）。 */ traders?: (venue: KeyVenue, keys: LiveKeys) => VenueTrader;
  /** Lighter 签名器缺什么（测试里换成 null）。 */ signerProblem?: () => string | null;
  /** Lighter 交易签名器注入（测试里绕过 WASM 替身）。 */ lighterSigner?: (venue: 'lighter' | 'rh', key: LighterKey) => Promise<LighterSigner>;
  /** Lighter 历史接口鉴权令牌（测试与本地预览可注入替身，返回 null 表示仅只读）。 */ lighterAuth?: (venue: 'lighter' | 'rh', key: LighterKey) => Promise<string | null> }
/** Lighter 两条链的 chainId（签名用）。 */
export const LIGHTER_CHAIN_ID = { lighter: 304, rh: 466324 } as const;

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const dayStart = (time: number) => Math.floor(time / 86_400_000) * 86_400_000;
/** 配对键定下的一个固定偏移（0 到 AUTO_JITTER_MS 之间）。 */
const autoJitter = (key: string): number => { let hash = 0; for (let index = 0; index < key.length; index++) hash = (hash * 31 + key.charCodeAt(index)) >>> 0; return hash % AUTO_JITTER_MS; };
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
interface DepthEntry { leg: LegInfo; at: number | null; error: string | null }

export function createVarLighterEngine({ store, fetchImpl = fetch, connect, now: customNow, monoNow: customMonoNow, log = () => {}, quoter, accounts: envAccounts = () => ({ accounts: {}, problem: null }), liveKeys, traders, signerProblem = lighterSignerProblem, lighterSigner, lighterAuth }: EngineOptions) {
  const now = customNow ?? Date.now;
  const monoNow = customMonoNow ?? (customNow ?? (() => performance.now()));
  /** 账户标识的来源：页面录入的凭据优先，没录的场所用安装时录入的账户（keys.env）。页面凭据文件读不懂时按有问题处理。 */
  const accountSource: DexAccountsSource = () => {
    const base = envAccounts(), page = liveKeys?.accounts() ?? {}, pageProblem = liveKeys?.read().problem ?? null;
    if (pageProblem) return { accounts: {}, problem: pageProblem };
    if (!Object.keys(page).length) return base;
    return { accounts: { ...(base.problem ? {} : base.accounts), ...page }, problem: null };
  };
  const accountHashOf = (venue: KeyVenue, accounts: DexAccounts): string | null => {
    const entry = accounts[venue];
    if (!entry) return null;
    const raw = venue === 'entropy' ? (entry as { address: string }).address.toLowerCase() : String((entry as { accountIndex: number }).accountIndex);
    return createHash('sha256').update(`${venue}:${raw}`).digest('hex').slice(0, 16);
  };
  const readSeq = new Map<KeyVenue, number>();
  const histSeq = new Map<KeyVenue, number>();
  /** 各场所账户最近一次读取：成功时 at 与 snapshot 一起更新；失败只记 error，旧快照留着但过了时限不算数。 */
  const accountReads = new Map<KeyVenue, { hash: string; at: number | null; snapshot: AccountSnapshot | null; error: string | null }>();
  const accountHistories = new Map<KeyVenue, { hash: string; at: number | null; snapshot: AccountHistorySnapshot | null; error: string | null }>();
  const lastSnapshotAt = new Map<KeyVenue, { hash: string; at: number }>();
  /** 各场所并行读、各用各的时限；用单调序号 + 发起时刻防慢回包/慢失败覆盖新状态，且仅淘汰变化场所的在途读取。 */
  async function refreshAccounts(signalFor: () => AbortSignal): Promise<void> {
    const { accounts, problem } = accountSource();
    const venues = problem ? [] : configuredVenues(accounts);
    for (const venue of [...accountReads.keys()]) {
      const hash = accountHashOf(venue, accounts);
      if (!venues.includes(venue) || accountReads.get(venue)!.hash !== hash) accountReads.delete(venue);
    }
    await Promise.all(venues.map(async venue => {
      const hash = accountHashOf(venue, accounts)!;
      const prev = accountReads.get(venue);
      const entry = prev && prev.hash === hash ? prev : { hash, at: null, snapshot: null, error: null };
      accountReads.set(venue, entry);
      const seq = (readSeq.get(venue) ?? 0) + 1;
      readSeq.set(venue, seq);
      const startedAt = now();
      const staleResult = () => {
        const after = accountSource();
        const latest = accountReads.get(venue);
        return after.problem || accountHashOf(venue, after.accounts) !== hash || liveStop.signal.aborted
          || (readSeq.get(venue) ?? 0) !== seq
          || (latest !== undefined && latest !== entry)
          || (latest && latest.hash === hash && latest.at !== null && startedAt < latest.at);
      };
      try {
        const snapshot = await fetchAccount(fetchImpl, signalFor(), venue, accounts);
        if (staleResult()) return;
        entry.snapshot = snapshot; entry.at = startedAt; entry.error = null;
        const lastSaved = lastSnapshotAt.get(venue);
        if (!lastSaved || lastSaved.hash !== hash || startedAt - lastSaved.at >= ACCOUNT_SNAPSHOT_GAP_MS) {
          try {
            store.addAccountSnapshot({
              venue, accountHash: hash, at: startedAt, equity: snapshot.equity ?? snapshot.collateral,
              collateral: snapshot.collateral, available: snapshot.available,
              unrealizedPnl: snapshot.unrealizedPnl ?? null, positions: snapshot.positions.length,
            });
            lastSnapshotAt.set(venue, { hash, at: startedAt });
          } catch (error) { log(`varlighter: 账户权益快照保存失败：${scrub(message(error))}`); }
        }
      } catch (error) {
        if (staleResult()) return;
        entry.error = scrub(message(error));
      }
    }));
  }
  const marketNamesFor = (venue: LiveVenue): Map<number, string> => new Map((live.get(venue)?.markets ?? []).map(market => [market.id, market.symbol]));
  async function refreshAccountHistory(signalFor: () => AbortSignal): Promise<void> {
    const { accounts, problem } = accountSource();
    const venues = problem ? [] : configuredVenues(accounts);
    for (const venue of [...accountHistories.keys()]) {
      const hash = accountHashOf(venue, accounts);
      if (!venues.includes(venue) || accountHistories.get(venue)!.hash !== hash) accountHistories.delete(venue);
    }
    const keysRead = liveKeys?.read();
    await Promise.all(venues.map(async venue => {
      const hash = accountHashOf(venue, accounts)!;
      const prev = accountHistories.get(venue);
      const entry = prev && prev.hash === hash ? prev : { hash, at: null, snapshot: null, error: null };
      accountHistories.set(venue, entry);
      const seq = (histSeq.get(venue) ?? 0) + 1;
      histSeq.set(venue, seq);
      const startedAt = now();
      const staleResult = () => {
        const after = accountSource();
        const latest = accountHistories.get(venue);
        return after.problem || accountHashOf(venue, after.accounts) !== hash || liveStop.signal.aborted
          || (histSeq.get(venue) ?? 0) !== seq
          || (latest !== undefined && latest !== entry)
          || (latest && latest.hash === hash && latest.at !== null && startedAt < latest.at);
      };
      try {
        let authToken: ((forceRefresh?: boolean) => Promise<string | null>) | undefined;
        if (venue === 'lighter' || venue === 'rh') {
          const key = !keysRead?.problem ? keysRead?.keys[venue] : undefined;
          if (key && accounts[venue]?.accountIndex === key.accountIndex) {
            authToken = (forceRefresh = false) => lighterAuthToken(venue, key, forceRefresh);
          } else if (lighterAuth && accounts[venue]) {
            const synthetic: LighterKey = { accountIndex: accounts[venue]!.accountIndex, apiKeyIndex: 4, privateKey: '' };
            authToken = (forceRefresh = false) => lighterAuthToken(venue, synthetic, forceRefresh);
          }
        }
        const snapshot = await fetchAccountHistory({ fetchImpl, signalFor, venue, accounts, now: startedAt, marketNames: marketNamesFor(venue), authToken });
        if (staleResult()) return;
        entry.snapshot = snapshot; entry.at = snapshot.at; entry.error = null;
      } catch (error) {
        if (staleResult()) return;
        entry.error = scrub(message(error));
      }
    }));
  }
  const open = connect ?? (url => new WebSocket(url) as unknown as ReturnType<Connect>);
  const migrated = store.migrateLegacy(now(), LEGACY_UPGRADE);
  if (migrated && migrated.positions + migrated.trades + migrated.skipped > 0) log(`varlighter: 已升级为两腿口径（持仓 ${migrated.positions}、成交 ${migrated.trades}${migrated.skipped ? `、无法识别 ${migrated.skipped}` : ''}）`);
  const savedSettings = store.state<Settings>(SETTINGS_KEY);
  let settings: Settings = normalizeSettings(savedSettings);
  if (!store.state(ENTROPY_FEE_DEFAULT_MIGRATED_KEY)) {
    const tMigrate = now();
    let applied = false;
    if (savedSettings !== null && settings.global.entropyFeeBps === null && DEFAULT_GLOBAL.entropyFeeBps !== null) {
      settings = { ...settings, revision: settings.revision + 1, global: { ...settings.global, entropyFeeBps: DEFAULT_GLOBAL.entropyFeeBps } };
      store.saveSettings(settings, tMigrate, `Entropy 默认手续费已更新为 ${DEFAULT_GLOBAL.entropyFeeBps} 基点（往返 ${2 * DEFAULT_GLOBAL.entropyFeeBps} 基点），留空可切回目录费率`);
      applied = true;
    }
    store.setState(ENTROPY_FEE_DEFAULT_MIGRATED_KEY, { at: tMigrate, applied }, tMigrate);
  }
  let autoKeys = new Set(settings.auto);
  /** 自动配置用的统计（各时段与全天），按配对缓存；名义金额档或类别变了就重算。 */
  const autoStats = new Map<string, { at: number; bucket: SizeBucket; kind: AssetKind; stats: RegimeStats[] }>();
  const live = new Map<LiveVenue, VenueRuntime>(LIVE_VENUES.map(venue => [venue, { venue, stream: null, markets: [], bySymbol: new Map(), catalog: { at: null, ok: null, error: null, count: 0 }, nextCatalog: 0, depth: new Map() }]));
  let listings = new Map<string, VarListing>(), varMarkets = new Map<string, MarketSpec>();
  let pairs: PairInfo[] = [], pairsByKey = new Map<string, PairInfo>();
  let running = false;
  const varSource: SourceState = { at: null, ok: null, error: null, count: 0 };
  let lastPoll: PollStats | null = null, lastLive: LiveStats | null = null;
  const pushStats: PushStats = { checks: 0, trades: 0, lastTradeAt: null, lastBlocked: null };
  /** 行情流的腿（场所:市场编号）→ 用到它、两腿都是行情流的配对。 */
  let pushPairs = new Map<string, PairInfo[]>();
  const pushErrorAt = new Map<string, number>();
  const lastQuoteAt = new Map<string, number>(), lastLiveAt = new Map<string, number>(), latest = new Map<string, Sample>();
  const trackers = new Map<string, BaselineTracker>();
  /** 后台循环在跑：页面要用而还没预热的基线排在这里，由循环分批预热（判断开平仓要用的仍当场预热）。 */
  let looping = false;
  const warmQueue = new Set<string>(), trackerDroppedAt = new Map<string, number>();
  /** 各配对最近一次到了入场线却没开成的时刻与原因（服务启动以来）。 */
  const lastBlockedByPair = new Map<string, { at: number; reason: string }>();
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

  // ---- 实盘（docs/dexspread.md 第 13 节） ----
  const liveStop = new AbortController();
  let nextAccounts = 0, nextAccountHistory = 0, accountsScheduleEpoch = 0, historyScheduleEpoch = 0, lastManualRefreshAt = -Infinity;
  let activeRefresh: Promise<void> | null = null;
  const scheduleImmediateAccountsRefresh = () => {
    nextAccounts = 0;
    nextAccountHistory = 0;
    accountsScheduleEpoch++;
    historyScheduleEpoch++;
  };
  let nextEntropyCost = now() + 20_000;
  const entropyAddress = (): string | null => {
    const source = accountSource();
    return source.problem ? null : source.accounts.entropy?.address ?? null;
  };
  const entropyCost = createEntropyCostCollector({
    store, fetchImpl, now, log,
    signalFor: () => anySignal([liveStop.signal], REQUEST_TIMEOUT_MS),
    stopSignal: liveStop.signal,
    entropyAccount: entropyAddress,
    assumedFeeBps: () => settings.global.entropyFeeBps,
    markets: () => live.get('entropy')!.markets,
  });
  const leadTester = createLeadTester({
    store,
    fetchImpl,
    connect: open,
    now,
    monoNow,
    log,
    dexMarkets: () => ({
      lighter: live.get('lighter')!.markets,
      rh: live.get('rh')!.markets,
      entropy: live.get('entropy')!.markets,
    }),
  });
  const traderCache = new Map<KeyVenue, { id: string; trader: VenueTrader }>();
  const lighterSignerCache = new Map<'lighter' | 'rh', { id: string; signer: Promise<LighterSigner> }>();
  const lighterTokenCache = new Map<'lighter' | 'rh', { id: string; token: string; at: number }>();
  const privateStreams = new Map<'lighter' | 'rh', { id: string; stream: LighterPrivateStream }>();
  function signerFor(venue: 'lighter' | 'rh', key: LighterKey): () => Promise<LighterSigner> {
    const id = JSON.stringify(key);
    return () => {
      const hit = lighterSignerCache.get(venue);
      if (hit && hit.id === id) return hit.signer;
      // 签名器建一次；建失败时下次再试。
      const signer = (lighterSigner
        ? lighterSigner(venue, key)
        : createLighterSigner({ chainId: LIGHTER_CHAIN_ID[venue], privateKey: key.privateKey, apiKeyIndex: key.apiKeyIndex, accountIndex: key.accountIndex }))
        .catch(error => { if (lighterSignerCache.get(venue)?.signer === signer) lighterSignerCache.delete(venue); throw error; });
      lighterSignerCache.set(venue, { id, signer });
      return signer;
    };
  }
  function privateStreamFor(venue: 'lighter' | 'rh', key: LighterKey): LighterPrivateStream {
    const id = JSON.stringify(key), hit = privateStreams.get(venue);
    if (hit && hit.id === id) return hit.stream;
    if (hit) { hit.stream.close(); traderCache.delete(venue); }
    const stream = new LighterPrivateStream({ venue, accountIndex: key.accountIndex, connect: open, signer: signerFor(venue, key), now, log });
    privateStreams.set(venue, { id, stream });
    traderCache.delete(venue);
    return stream;
  }
  function syncPrivateStreams(): void {
    const keys = liveKeys?.read().keys;
    const keep = !traders && running && !liveStop.signal.aborted && !!keys && !signerProblem() && ((liveTrader?.settings().on ?? false) || (liveTrader?.active().length ?? 0) > 0);
    for (const venue of ['lighter', 'rh'] as const) {
      const key = keys?.[venue];
      const hit = privateStreams.get(venue);
      if (!keep || !key) {
        if (hit) { hit.stream.close(); privateStreams.delete(venue); traderCache.delete(venue); }
        continue;
      }
      privateStreamFor(venue, key).start();
    }
  }
  async function lighterAuthToken(venue: 'lighter' | 'rh', key: LighterKey, forceRefresh = false): Promise<string | null> {
    const id = JSON.stringify(key);
    if (!forceRefresh) {
      const cached = lighterTokenCache.get(venue);
      if (cached && cached.id === id && now() - cached.at < LIGHTER_AUTH_RENEW_MS) return cached.token;
    } else {
      lighterTokenCache.delete(venue);
    }
    const token = lighterAuth
      ? await lighterAuth(venue, key)
      : await (async () => {
          const issue = signerProblem();
          if (issue) throw new Error(issue);
          return (await signerFor(venue, key)()).createAuthToken(Math.floor(now() / 1000) + LIGHTER_AUTH_TTL_SEC);
        })();
    if (token !== null) lighterTokenCache.set(venue, { id, token, at: now() });
    return token;
  }
  function dropVenueCaches(venue: KeyVenue): void {
    readSeq.set(venue, (readSeq.get(venue) ?? 0) + 1);
    histSeq.set(venue, (histSeq.get(venue) ?? 0) + 1);
    traderCache.delete(venue);
    if (venue === 'lighter' || venue === 'rh') {
      lighterSignerCache.delete(venue);
      lighterTokenCache.delete(venue);
      const priv = privateStreams.get(venue);
      if (priv) { priv.stream.close(); privateStreams.delete(venue); }
    }
    accountReads.delete(venue);
    accountHistories.delete(venue);
    lastSnapshotAt.delete(venue);
  }
  function traderFor(venue: KeyVenue, keys: LiveKeys): VenueTrader {
    if (traders) return traders(venue, keys);
    const id = JSON.stringify(keys[venue]), hit = traderCache.get(venue);
    if (hit && hit.id === id) return hit.trader;
    let trader: VenueTrader;
    if (venue === 'entropy') trader = createEntropyTrader({ key: keys.entropy!, fetchImpl, now });
    else trader = createLighterTrader({ venue, key: keys[venue]!, fetchImpl, now, signer: signerFor(venue, keys[venue]!), privateStream: privateStreamFor(venue, keys[venue]!) });
    traderCache.set(venue, { id, trader });
    return trader;
  }
  const liveTrader: LiveTrader | null = liveKeys ? createLiveTrader({
    store, keys: liveKeys, now, log, trader: traderFor,
    venueProblem: venue => venue === 'entropy' ? null : signerProblem(),
    pairOf: key => pairsByKey.get(key),
    quote: leg => { const top = isLive(leg.venue) ? live.get(leg.venue)!.stream?.topAt(leg.market.id, now()) ?? null : null; return top && top.bid > 0 && top.ask > 0 ? { bid: top.bid, ask: top.ask } : null; },
    takerFeeBps: leg => legFeeBps(settings.global, leg.venue, leg.market.takerFeeBps) ?? 0,
    account: venue => { const read = accountReads.get(venue); return read && read.at !== null && read.snapshot ? { at: read.at, snapshot: read.snapshot } : null; },
    readAccount: (venue, signal) => fetchAccount(fetchImpl, signal, venue, accountSource().accounts),
    privateStreams: () => {
      const out: Partial<Record<'lighter' | 'rh', LighterPrivateStatus>> = {};
      for (const [venue, entry] of privateStreams) out[venue] = entry.stream.status();
      return out;
    },
    // 一笔实盘持仓结束：第一腿未成交（not_filled）按可配短冷却（默认 30s），真实成交与单腿按配对冷却分钟数（至少 1 分钟）。
    onFinished: position => {
      const at = now();
      const durationMs = position.closeReason === 'not_filled'
        ? Math.max(5_000, liveTrader!.exec().notFilledCooldownSec * 1_000)
        : Math.max(MIN_COOLDOWN_MS, paramsOf(position.symbol).cooldownMinutes * 60_000);
      const until = at + durationMs;
      cooldown = Object.fromEntries(Object.entries({ ...cooldown, [position.symbol]: until }).filter(([, end]) => end > at));
      try { store.setState(COOLDOWN_KEY, cooldown, at); } catch (error) { log(`varlighter: 冷却保存失败：${message(error)}`); }
      updateDepth();
      syncPrivateStreams();
      // 余额与持仓变了：下一轮循环马上重读账户，不等每分钟一次的轮询。
      scheduleImmediateAccountsRefresh();
    },
    signalFor: () => anySignal([liveStop.signal], REQUEST_TIMEOUT_MS),
    stopped: () => liveStop.signal.aborted,
    onOrderSent: ({ cloid, positionId, purpose, leg, assumedFeeBps, at }) => {
      const address = entropyAddress();
      if (!address) return;
      store.saveEntropyOrderLink({
        cloid, accountHash: entropyAccountHashOf(address), positionId, purpose,
        coin: leg.market.coin ?? `io:${leg.symbol}`, assumedFeeBps,
        catalogFeeBps: leg.market.takerFeeBps, deployerFeeScale: leg.market.deployerFeeScale ?? null,
        growthMode: leg.market.growthMode ?? null, at,
      });
    },
    onEntropyFill: () => { nextEntropyCost = Math.min(nextEntropyCost, now() + ENTROPY_COST_AFTER_FILL_MS); },
  }) : null;
  for (const position of liveTrader?.active() ?? []) { const sample = store.latest(position.symbol); if (sample) latest.set(position.symbol, sample); }
  const liveOf = (): LiveTrader => liveTrader ?? reject('unavailable', '这个服务没有开启实盘', 503);
  const liveFailure = (error: unknown): never => {
    if (error instanceof LiveError) return reject(error.code, error.message, error.status);
    if (error instanceof LiveKeysError) return reject('invalid_keys', error.message);
    throw error;
  };
  const venueOf = (body: unknown): KeyVenue => isObject(body) && typeof body.venue === 'string' && (KEY_VENUES as readonly string[]).includes(body.venue) ? body.venue as KeyVenue : reject('invalid_body', '场所无效');
  function liveView(): LiveView {
    const trader = liveOf(), read = liveKeys!.read(), base = trader.view();
    return {
      ...base, marks: Object.fromEntries(base.positions.map(position => [position.id, liveMarkOf(position, base.now)])), keys: liveKeys!.view(), keysProblem: read.problem, signerProblem: signerProblem(), venueNames: VENUE_NAMES,
      // 能开实盘的配对：两腿都是下单场所。
      candidates: pairs.filter(pair => pair.a.venue !== 'var' && pair.b.venue !== 'var').map(pair => ({ key: pair.key, symbol: pair.symbol, a: legRef(pair.a), b: legRef(pair.b), enabled: paramsOf(pair.key).enabled })),
      events: store.events(1000).filter(item => item.kind === 'live').slice(0, 40),
    };
  }
  /** 一笔未结束的实盘持仓按最新样本的估值与它的平仓线（实盘页用）。 */
  function liveMarkOf(position: LivePosition, time: number): LivePositionMark {
    const sample = latest.get(position.symbol) ?? null, pair = pairOf(position.symbol), rules = holdParams(position), entry = strategyOf(position);
    const holding = position.state === 'open', mark = sample && holding ? markOf(entry, sample) : null;
    const baseline = pair ? trackerForView(pair)?.value(regimeOf(pair.kind, time), time) ?? null : null;
    // 回归平仓看的偏离与引擎判断用的同一个价差（按持仓数量取价的中间价）。
    const spread = sample && holding ? positionSpread(sample, entry) : null;
    return {
      at: sample?.t ?? null, pnlBps: mark?.pnlBps ?? null, netUsd: mark?.netUsd ?? null, estimated: mark?.estimated ?? null,
      signalSpread: position.strategy?.entrySpread ?? null, entrySpread: position.a.qty > 0 && position.b.qty > 0 ? entry.entrySpread : null,
      entryBaseline: position.strategy?.entryBaseline ?? null, baseline: baseline?.median ?? null,
      deviation: spread && baseline ? deviationToClose(position.direction, spread, baseline.median) : null,
      exitBps: rules.exitBps, stopBps: rules.stopBps, maxHoldMinutes: rules.maxHoldMinutes,
    };
  }  /** 录入一个场所的凭据：请求体是 { venue, ...该场所的字段 }。应答只说哪些场所已配置。 */
  function setLiveKeys(body: unknown) {
    liveOf();
    const venue = venueOf(body), { venue: _venue, ...fields } = body as Record<string, unknown>;
    void _venue;
    // 这个场所还有实盘持仓时只能给同一个账户换密钥：换成别的账户，查单、对账、平仓都会落到新账户上，旧账户的持仓就没人管了。
    const held = liveKeys!.read().keys[venue];
    if (liveOf().venueInUse(venue) && held) {
      const same = venue === 'entropy' ? String(fields.address ?? '').trim().toLowerCase() === (held as { address: string }).address : String(fields.accountIndex ?? '').trim() === String((held as { accountIndex: number }).accountIndex);
      if (!same) return reject('busy', `${VENUE_NAMES[venue]} 还有实盘持仓，只能给同一个账户换密钥；要换账户先平掉持仓`, 409);
    }
    try { liveKeys!.set(venue, fields); } catch (error) { return liveFailure(error); }
    dropVenueCaches(venue);
    syncPrivateStreams();
    scheduleImmediateAccountsRefresh();
    if (venue === 'entropy') nextEntropyCost = now();
    store.event(now(), 'live', null, `已录入 ${VENUE_NAMES[venue]} 的实盘凭据`);
    return { keys: liveKeys!.view() };
  }
  function removeLiveKeys(body: unknown) {
    const trader = liveOf(), venue = venueOf(body);
    if (trader.venueInUse(venue)) return reject('busy', `${VENUE_NAMES[venue]} 还有实盘持仓，平掉后才能移除凭据`, 409);
    try { liveKeys!.remove(venue); } catch (error) { return liveFailure(error); }
    dropVenueCaches(venue);
    syncPrivateStreams();
    scheduleImmediateAccountsRefresh();
    store.event(now(), 'live', null, `已移除 ${VENUE_NAMES[venue]} 的实盘凭据`);
    return { keys: liveKeys!.view() };
  }
  const liveCall = <T>(work: (trader: LiveTrader) => T): T => { const trader = liveOf(); try { return work(trader); } catch (error) { return liveFailure(error); } };
  const liveSettings = (body: unknown) => {
    const next = liveCall(trader => trader.update(body, key => pairsByKey.has(key) || parsePairKey(key) !== null));
    syncPrivateStreams();
    return next;
  };
  const liveClose = (body: unknown) => liveCall(trader => trader.close(body));
  const liveDismiss = (body: unknown) => liveCall(trader => trader.dismiss(body));
  const liveResume = () => liveCall(trader => trader.resume());

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
   * 一个配对当前的推荐参数（自动配置用）：统计取最近一个基线窗口（最长 72 小时）的样本，约 10 分钟重算一次（各配对错开，最多晚一分钟）；
   * 当前时段的样本够最少样本数就用它，否则用全天的，都不够或没有可成交价时没有推荐值。手续费、滑点与最低净利按当前的算，改了马上生效。
   */
  function recommendation(key: string): Omit<AutoView, 'on'> {
    const pair = pairOf(key);
    if (!pair) return { params: null, reason: '配对不在当前目录里', at: null, regime: null, samples: 0 };
    const time = now(), stored = storedOf(key), bucket = bucketOf(stored.notionalUsd);
    let cached = autoStats.get(key);
    if (!cached || time - cached.at >= AUTO_REFRESH_MS + autoJitter(key) || cached.bucket !== bucket || cached.kind !== pair.kind) {
      // 两腿都是行情流的配对几秒一个样本：与基线一样约每分钟取一个（逐条定位着读，不读中间的），样本数门槛、半衰期与含 Var 的配对同口径。
      const gap = bothLive(key) ? LIVE_BASELINE_GAP_MS : 0, from = time - Math.min(settings.global.windowHours, AUTO_WINDOW_MAX_HOURS) * 3_600_000;
      const samples = gap > 0 ? store.samplesSpaced(key, from, time, gap) : store.samples(key, from, time);
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
  /** 持仓的平仓规则：自动配置下开的仓沿用开仓时存下的出场、止损与最长持有，推荐值随时段或重算变了也不动已有的仓。 */
  const holdParams = (position: LivePosition): SymbolParams => {
    const params = paramsOf(position.symbol), kept = position.strategy?.rules;
    return kept ? { ...params, exitBps: kept.exitBps, stopBps: kept.stopBps, maxHoldMinutes: kept.maxHoldMinutes } : params;
  };
  /** 未结束的实盘持仓，按配对键（第 18 节：策略持仓就是实盘持仓；同一配对同时只有一笔）。 */
  const held = (): Map<string, LivePosition> => new Map((liveTrader?.active() ?? []).map(position => [position.symbol, position]));
  /**
   * 实盘持仓还原成策略持仓：入场按两腿实际成交均价（B 乘乘数），两腿还没都成交时按开仓信号里的价差；
   * v0.112.0 以前开的仓没有策略读数，名义取 A 腿开仓成交额、基线取当前基线、手续费取当前的。
   */
  function strategyOf(position: LivePosition): Position {
    const saved = position.strategy, pair = pairOf(position.symbol), ratio = position.ratio;
    const aEntry = position.a.qty > 0 ? position.a.entryQuote / position.a.qty : null, bEntry = position.b.qty > 0 ? ratio * position.b.entryQuote / position.b.qty : null;
    const remaining = position.a.qty - position.a.exitQty;
    const entrySpread = aEntry !== null && bEntry !== null ? (aEntry - bEntry) / bEntry * 1e4 : saved?.entrySpread ?? 0;
    const fees = saved ?? (pair ? feesOf(pair) : null);
    const baseline = saved?.entryBaseline ?? (pair ? baselineOf(pair, now())?.median : undefined) ?? entrySpread;
    return {
      id: position.id, symbol: position.symbol, direction: position.direction, openedAt: position.openedAt, ratio,
      qty: position.a.qty > 0 ? Math.max(0, remaining) : position.plan.qty,
      bQty: Math.max(0, position.b.qty - position.b.exitQty),
      notionalUsd: saved?.notionalUsd ?? (position.a.entryQuote > 0 ? position.a.entryQuote : position.plan.qty * position.plan.limit),
      entrySpread, entryBaseline: baseline, entryRegime: saved?.entryRegime ?? (pair ? regimeOf(pair.kind, position.openedAt) : 'all'),
      aEntry: aEntry ?? position.plan.limit, bEntry: bEntry ?? (position.plan.bLimit ?? 0) * ratio,
      estimated: (saved?.estimated ?? false) || position.a.estimated || position.b.estimated || aEntry === null || bEntry === null,
      aFeeBps: fees?.aFeeBps ?? 0, bFeeBps: fees?.bFeeBps ?? 0,
      ...(saved?.entryCostBps !== undefined && { entryCostBps: saved.entryCostBps }),
    };
  }
  /** 这个配对会不会开实盘：启用了（总览勾选）、实盘总开关开着且勾选了这个配对、两腿都是下单场所。 */
  function tradable(pair: PairInfo, params: SymbolParams): boolean {
    if (!liveTrader || !params.enabled || pair.a.venue === 'var' || pair.b.venue === 'var') return false;
    const current = liveTrader.settings();
    return current.on && current.pairs.includes(pair.key);
  }
  const eligible = (pair: PairInfo | undefined) => !!pair && pair.identity !== 'mismatch' && (pair.identity === 'verified' || settings.confirmed.includes(pair.key));
  const legsOfKey = (key: string): string[] => { const parsed = parsePairKey(key); return parsed ? [legKey(parsed.a), legKey(parsed.b)] : []; };
  /** 这个配对的某条腿已在另一个配对持仓（场所按代码合并持仓，两笔反向会互相抵消）。 */
  const legBusy = (pair: PairInfo, open: Iterable<string>) => { const legs = new Set([legKey(pair.a), legKey(pair.b)]); return [...open].some(key => key !== pair.key && legsOfKey(key).some(leg => legs.has(leg))); };
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
  /** 已启用或有实盘持仓的配对键。 */
  const activeKeys = (): Set<string> => new Set([...held().keys(), ...Object.entries(settings.symbols).filter(([, params]) => params.enabled).map(([key]) => key)]);

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
    pushPairs = new Map();
    for (const pair of pairs) {
      if (pair.identity === 'mismatch' || !isLive(pair.a.venue) || !isLive(pair.b.venue)) continue;
      for (const leg of [pair.a, pair.b]) { const key = `${leg.venue}:${leg.market.id}`; pushPairs.set(key, [...pushPairs.get(key) ?? [], pair]); }
    }
    // 重启后参数与持仓先于配对就有了：配对一建好就补上要订阅盘口的腿与 Entropy 要订阅的市场。
    updateDepth();
    syncEntropyMarkets();
  }

  /** 基线跟踪器：首次用到时从库里预热最近一个窗口的样本。窗口或最少样本改了就全部重建。 */
  function tracker(pair: PairInfo): BaselineTracker {
    const found = trackers.get(pair.key);
    // 手动配对删了再按同键加回、类别改了时，按新类别重建（时段划分随类别不同）。
    return found && found.kind === pair.kind ? found : buildTracker(pair);
  }
  /** 从库里预热一个配对的基线：只读基线用到的列；两腿都是行情流的配对约每分钟才计一条，逐条定位着读、不读中间的。 */
  function buildTracker(pair: PairInfo): BaselineTracker {
    const windowMs = settings.global.windowHours * 3_600_000, gap = bothLive(pair.key) ? LIVE_BASELINE_GAP_MS : 0;
    const built = new BaselineTracker(pair.kind, windowMs, settings.global.minSamples, gap), time = now();
    store.baselineScan(pair.key, time - windowMs, time, gap, point => built.push(point));
    trackers.set(pair.key, built);
    warmQueue.delete(pair.key);
    return built;
  }
  /** 页面用的基线：后台循环在跑时不在请求里现读库，没预热的排队交给循环分批做，这次返回 null（页面标「预热中」）。 */
  function trackerForView(pair: PairInfo): BaselineTracker | null {
    const found = trackers.get(pair.key);
    if (found && found.kind === pair.kind) return found;
    if (!looping) return buildTracker(pair);
    warmQueue.add(pair.key);
    return null;
  }
  /** 分批预热排队的基线：一次一个配对，之间让出事件循环（行情流的推送判断插得进来），启用或有持仓的先做。 */
  async function warmTrackers(stopped: () => boolean): Promise<void> {
    const active = activeKeys();
    while (warmQueue.size && !stopped()) {
      let key = warmQueue.values().next().value!;
      for (const candidate of warmQueue) if (active.has(candidate)) { key = candidate; break; }
      warmQueue.delete(key);
      const pair = pairOf(key);
      if (pair && trackers.get(key)?.kind !== pair.kind) buildTracker(pair);
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  /** 判断出错后丢掉这个配对的基线，下次用到时从库里重建；同一个配对一分钟最多一次。 */
  function dropTracker(key: string, time: number): void {
    if (Math.abs(time - (trackerDroppedAt.get(key) ?? -Infinity)) < TRACKER_REBUILD_MS) return;
    trackerDroppedAt.set(key, time);
    trackers.delete(key);
  }
  function noteBlocked(key: string, at: number, reason: string): void {
    lastBlockedByPair.delete(key);
    lastBlockedByPair.set(key, { at, reason });
    if (lastBlockedByPair.size > LAST_BLOCKED_MAX) lastBlockedByPair.delete(lastBlockedByPair.keys().next().value!);
  }

  /** 订阅完整盘口的腿：启用的与有持仓的配对的行情流腿，每个场所最多 MAX_DEPTH_MARKETS 条；同步给各场所的行情流。 */
  function updateDepth(): void {
    // 有持仓的配对排在前面：腿数到上限时先保住持仓腿的盘口（平仓滑点要用）。
    const open = held(), active = [...activeKeys()].sort((x, y) => Number(open.has(y)) - Number(open.has(x)) || (x < y ? -1 : x > y ? 1 : 0));
    for (const runtime of live.values()) {
      const wanted = new Map<string, LegInfo>();
      for (const key of active) {
        const pair = pairOf(key);
        for (const leg of pair ? [pair.a, pair.b] : []) if (leg.venue === runtime.venue && wanted.size < MAX_DEPTH_MARKETS) wanted.set(legKey(leg), leg);
      }
      for (const [key, entry] of runtime.depth) if (wanted.get(key)?.market.id !== entry.leg.market.id) runtime.depth.delete(key);
      for (const [key, leg] of wanted) if (!runtime.depth.has(key)) runtime.depth.set(key, { leg, at: null, error: null });
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
        runtime.stream = runtime.venue === 'entropy' ? new HyperliquidStream({ connect: open, now, log, onTop: id => onTop(runtime.venue, id) }) : new LighterStream({ venue: runtime.venue, connect: open, now, log, onTop: id => onTop(runtime.venue, id) });
        runtime.stream.start();
        if (runtime.venue === 'entropy') syncEntropyMarkets();
        updateDepth();
      }
      if (!want && runtime.stream) { runtime.stream.close(); runtime.stream = null; runtime.depth.clear(); }
    }
    syncPrivateStreams();
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

  /** 只从当前订阅取深度；失效时保留上次可用的来源时刻供状态页显示。 */
  function refreshEntry(runtime: VenueRuntime, entry: DepthEntry, reuseMs = 0): DepthSnapshot | null {
    const snapshot = runtime.stream?.depth(entry.leg.market.id, reuseMs) ?? null;
    if (snapshot) { entry.at = snapshot.at; entry.error = null; } else entry.error = runtime.stream?.depthError(entry.leg.market.id) ?? '行情流未连接';
    return snapshot;
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
    const jobs: (() => Promise<void>)[] = [], phase = anySignal([signal], TOKEN_QUOTE_PHASE_MS), open = held();
    for (const key of [...activeKeys()].sort()) {
      const pair = pairOf(key), varLeg = pair && [pair.a, pair.b].find(leg => leg.venue === 'var'), listing = varLeg && listings.get(varLeg.symbol);
      if (!pair || !varLeg || !listing) continue;
      if (!quoter.wants(pair.kind, varLeg.symbol)) { stats.tokenSkipped++; continue; }
      jobs.push(async () => {
        // 到了阶段时限，或这一轮里前面的请求让 token 不可用了（被拒、被拦截）：剩下的不再发。
        if (phase.aborted || !quoter.usable()) { stats.tokenSkipped++; return; }
        const position = open.get(key);
        const qty = varQuoteQty(position ? strategyOf(position) : paramsOf(key), pair.a.venue === 'var' ? 'a' : 'b', pair.ratio, listing.mark);
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
  function liveLeg(leg: LegInfo, t: number, decideAt: number, top?: TopPoint | null, depthReuseMs = 0): LegFields | null {
    const runtime = live.get(leg.venue as LiveVenue)!, stream = runtime.stream;
    const at = top === undefined ? stream?.topAt(leg.market.id, t) ?? null : top;
    if (!at) return null;
    const entry = runtime.depth.get(legKey(leg));
    const depth = depthAt(entry && refreshEntry(runtime, entry, depthReuseMs), at, t);
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

  const pendingSignals = new Map<string, { direction: Direction; firstSeenAt: number }>();
  const confirmTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const clearPendingSignal = (key: string): void => {
    pendingSignals.delete(key);
    const timer = confirmTimers.get(key);
    if (timer) { clearTimeout(timer); confirmTimers.delete(key); }
  };
  const clearAllPendingSignals = (): void => {
    pendingSignals.clear();
    for (const timer of confirmTimers.values()) clearTimeout(timer);
    confirmTimers.clear();
  };
  function confirmSignalPersistence(key: string, decision: ReturnType<typeof decide>, isTradable: boolean, time: number): number | null {
    if (!isTradable || decision.kind !== 'open') {
      clearPendingSignal(key);
      return null;
    }
    const confirmMs = liveTrader?.exec().confirmMs ?? 0;
    if (confirmMs <= 0) {
      clearPendingSignal(key);
      return time;
    }
    const existing = pendingSignals.get(key);
    if (!existing || existing.direction !== decision.direction) {
      clearPendingSignal(key);
      pendingSignals.set(key, { direction: decision.direction, firstSeenAt: time });
      if (running) {
        const timer = setTimeout(() => {
          confirmTimers.delete(key);
          const pair = pairOf(key);
          if (running && pair && pendingSignals.has(key)) evaluatePushPair(pair, now(), held());
        }, confirmMs);
        timer.unref?.();
        confirmTimers.set(key, timer);
      }
      return null;
    }
    if (time - existing.firstSeenAt < confirmMs) {
      if (running && !confirmTimers.has(key)) {
        const remaining = Math.max(1, confirmMs - (time - existing.firstSeenAt));
        const timer = setTimeout(() => {
          confirmTimers.delete(key);
          const pair = pairOf(key);
          if (running && pair && pendingSignals.has(key)) evaluatePushPair(pair, now(), held());
        }, remaining);
        timer.unref?.();
        confirmTimers.set(key, timer);
      }
      return null;
    }
    return existing.firstSeenAt;
  }

  /** 每个配对每批只有一条样本，先用已有历史判断信号。大多数样本批写，有开平仓动作的按时序逐一决定。 */
  function ingest(fresh: { pair: PairInfo; sample: Sample }[], blocked: Record<string, number>, cursors: Map<string, number>): number {
    const passive: Sample[] = [], active: SampleStep[] = [], errors: unknown[] = [];
    const open = held();
    fresh.sort((x, y) => x.sample.t - y.sample.t);
    for (const { pair, sample } of fresh) {
      try {
        const current = open.get(pair.key);
        // 开仓中、平仓中、需要人工处理的实盘持仓：不判断，也不开新仓。
        if (current && current.state !== 'open') { clearPendingSignal(pair.key); sample.decisionAt = now(); passive.push(sample); continue; }
        const params = paramsOf(pair.key);
        // 没有持仓、也不会开实盘的配对（带 Var 腿、没启用或没勾实盘）：只留样本，不为它现读库预热基线。
        if (!current && !tradable(pair, params)) { clearPendingSignal(pair.key); sample.decisionAt = now(); passive.push(sample); continue; }
        const track = tracker(pair), position = current ? strategyOf(current) : null;
        const baseline = track.value(sample.regime, sample.t), decision = decide(sample, baseline, current ? holdParams(current) : params, position);
        const isOpenTradable = !current && decision.kind === 'open' && tradable(pair, params);
        const signalAt = isOpenTradable ? confirmSignalPersistence(pair.key, decision, true, sample.t) : (clearPendingSignal(pair.key), null);
        if ((isOpenTradable && signalAt !== null) || (decision.kind === 'close' && position)) {
          active.push({ pair, sample, params, position, baseline, decision, signalAt });
        } else { sample.decisionAt = now(); passive.push(sample); }
      } catch (error) {
        dropTracker(pair.key, now()); // The next read rebuilds from all committed quotes, including this one.
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
        if (typeof apply === 'string') { blocked[apply] = (blocked[apply] ?? 0) + 1; noteBlocked(step.pair.key, step.sample.t, apply); }
        else apply?.();
      } catch (error) { errors.push(error); }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, errors.map(message).join('；'));
    return written;
  }

  type SampleStep = { pair: PairInfo; sample: Sample; params: SymbolParams; position: Position | null; baseline: Baseline | null; decision: ReturnType<typeof decide>; signalAt: number | null };
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
   * 每分钟一轮：拉 Var 报价，（有 token 时）询价；有 Var 腿的配对按报价时刻对齐另一腿当时的一档（盘口冲击取行情流的当前盘口），写库、计入基线（带 Var 腿的配对不开仓）。
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
      // 判断就发生在现在：记下这一刻对手腿的一档，回测按它复核信号。
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

  function evaluatePushPair(pair: PairInfo, time: number, open: ReadonlyMap<string, LivePosition>): void {
    const current = open.get(pair.key);
    if (current ? current.state !== 'open' : !tradable(pair, storedOf(pair.key))) { clearPendingSignal(pair.key); return; }
    try {
      const a = liveLeg(pair.a, time, time, undefined, PUSH_DEPTH_REUSE_MS), b = liveLeg(pair.b, time, time, undefined, PUSH_DEPTH_REUSE_MS);
      if (!a || !b) { clearPendingSignal(pair.key); return; }
      pushStats.checks++;
      const sample = makeSample(pair, time, time, a, b), params = paramsOf(pair.key), position = current ? strategyOf(current) : null;
      const baseline = tracker(pair).value(sample.regime, time), decision = decide(sample, baseline, current ? holdParams(current) : params, position);
      const isOpenTradable = !current && decision.kind === 'open' && tradable(pair, params);
      const signalAt = isOpenTradable ? confirmSignalPersistence(pair.key, decision, true, time) : (clearPendingSignal(pair.key), null);
      if (!((isOpenTradable && signalAt !== null) || (decision.kind === 'close' && position))) return;
      const apply = tradeDecision({ pair, sample, params, position, baseline, decision, signalAt });
      if (typeof apply === 'string') { pushStats.lastBlocked = { at: time, symbol: pair.key, reason: apply }; noteBlocked(pair.key, time, apply); return; }
      if (!saveSamples([sample], lastLiveAt)) return;
      apply();
      pushStats.trades++; pushStats.lastTradeAt = time;
    } catch (error) {
      dropTracker(pair.key, time); // 与定时采样出错时一样，下次用到时从库里重建基线。
      if (time - (pushErrorAt.get(pair.key) ?? -Infinity) >= PUSH_ERROR_LOG_MS) { pushErrorAt.set(pair.key, time); log(`varlighter: 按行情流推送判断 ${pair.key} 失败：${message(error)}`); }
    }
  }

  /**
   * 行情流推送了一条腿的新一档：用到它、会开实盘或有持有中实盘持仓、两腿都是行情流的配对立即按两腿当前的一档判断一次。
   * 有开平仓动作时才把这一刻的样本写库并下单（规则与定时采样的相同）；没有动作或被挡住的不写库，样本仍由定时采样留。
   */
  function onTop(venue: LiveVenue, marketId: number): void {
    const list = running ? pushPairs.get(`${venue}:${marketId}`) : undefined;
    if (!list) return;
    const time = now(), open = held();
    for (const pair of list) evaluatePushPair(pair, time, open);
  }

  /**
   * 复核两腿并决定是否开平仓（第 18、19 节）：平仓信号交给实盘两腿并发只减仓平掉；开仓过了策略风控（读数取实盘持仓与实盘当日已实现）后，
   * 再过实盘自己的检查。返回不开的原因，或只负责提交的操作（样本落盘后才调用）。
   */
  function tradeDecision({ pair, sample, params, position, baseline, decision, signalAt }: SampleStep): string | (() => void) {
    if (decision.kind === 'close' && position) {
      sample.decisionAt = now();
      const mark = markToMarket(position, decision.spread);
      return () => {
        // 先交给实盘平仓，事件写失败也不影响平仓。
        liveTrader?.signalClose(pair.key, decision.reason, sample.decisionAt ?? now());
        try { store.event(now(), 'live', pair.key, `平仓信号（${CLOSE_REASON_NAMES[decision.reason]}）：价差 ${fmt(mark.exitSpread, 1)} 基点，相对入场 ${fmt(mark.pnlBps, 1)} 基点`); }
        catch (error) { log(`varlighter: 平仓信号事件写入失败：${message(error)}`); }
      };
    }
    if (decision.kind !== 'open' || !baseline) throw new Error('缺少开仓信号或基线');
    if (!liveTrader) return '这个服务没有开启实盘';
    const open = [...held().values()], fees = feesOf(pair), costs = { slippageBps: settings.global.slippageBps, aFeeBps: fees?.aFeeBps ?? 0, bFeeBps: fees?.bFeeBps ?? 0 };
    const risk = {
      openPositions: open.length, openNotionalUsd: open.reduce((sum, item) => sum + strategyOf(item).notionalUsd, 0),
      dailyNetUsd: store.liveNetSince(dayStart(sample.t)), cooldownUntil: cooldown[pair.key] ?? 0, eligible: eligible(pair), legBusy: legBusy(pair, open.map(item => item.symbol)),
      feeUnknown: !fees, fallbackBaseline: baseline.fallback, autoPending: autoPending(pair.key),
    };
    sample.decisionAt = now();
    const confirmed = confirmOpen(sample, baseline, params, decision, settings.global.maxQuoteAgeSec);
    if (typeof confirmed === 'string') return confirmed;
    const blocker = openBlocker(sample, params, settings.global, {
      ...risk, ...openEconomics(confirmed, params, costs, confirmed.spread.varSource === 'token' ? decision : undefined),
    });
    if (blocker) return blocker;
    const signal = openPosition(`s${sample.decisionAt.toString(36)}-${(++sequence).toString(36)}`, sample, params, confirmed, baseline, costs);
    const rules = autoKeys.has(pair.key) ? { exitBps: params.exitBps, stopBps: params.stopBps, maxHoldMinutes: params.maxHoldMinutes } : undefined;
    const signalBbo = { aBid: sample.aBid0, aAsk: sample.aAsk0, bBid: sample.bBid0, bAsk: sample.bAsk0, at: sample.t };
    const request: LiveSignal = {
      direction: signal.direction,
      notionalUsd: params.notionalUsd,
      signalAt: signalAt ?? sample.decisionAt,
      check: { entryBps: params.entryBps, exitBps: params.exitBps, slippageBps: settings.global.slippageBps, minNetBps: settings.global.minNetBps },
      strategy: {
        entrySpread: signal.entrySpread, entryBaseline: signal.entryBaseline, entryRegime: signal.entryRegime,
        aFeeBps: signal.aFeeBps, bFeeBps: signal.bFeeBps, estimated: signal.estimated,
        ...(signal.entryCostBps !== undefined && { entryCostBps: signal.entryCostBps }),
        signalBbo,
        ...(rules && { rules }),
      },
    };
    const commit = liveTrader.prepare(pair, request, sample);
    if (typeof commit === 'string') return commit;
    return () => { clearPendingSignal(pair.key); commit(); updateDepth(); syncPrivateStreams(); };
  }

  function noteSamples(samples: readonly Sample[]): void {
    if (historyCache.size && samples.length) {
      const changed = new Set(samples.map(sample => sample.symbol));
      for (const [id, entry] of historyCache) if (changed.has(entry.key)) historyCache.delete(id);
    }
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
  /** 分批删过期样本，批间让出事件循环；停服时停下。在后台跑，不拖住每秒一次的采样与实盘推进。 */
  async function pruneSamples(time: number, stopped: () => boolean): Promise<void> {
    while (!stopped() && store.pruneSamples(time, PRUNE_BATCH) === PRUNE_BATCH) await new Promise(resolve => setImmediate(resolve));
    historyCache.clear();
    store.pruneEvents(time);
    store.pruneAccountSnapshots(time);
    store.pruneEntropyOrderLinks(time);
    firsts.clear(); firstSample = undefined;
  }
  function firstOf(key: string): number | null {
    if (!firsts.has(key)) firsts.set(key, store.firstAt(key));
    return firsts.get(key)!;
  }

  // ---- 视图 ----
  function baselineOf(pair: PairInfo, time: number): Baseline | null { return tracker(pair).value(regimeOf(pair.kind, time), time); }

  /** 实盘持仓在总览上的摘要：浮动按最新样本估（两腿都成交、持有中才估）。 */
  function positionSummary(position: LivePosition | undefined, sample: Sample | null): StateRow['position'] {
    if (!position) return null;
    const mark = sample && position.state === 'open' ? markOf(strategyOf(position), sample) : null;
    return { id: position.id, state: position.state, direction: position.direction, openedAt: position.openedAt, pnlBps: mark?.pnlBps ?? null, estimated: mark?.estimated ?? null };
  }

  /**
   * 为什么没开仓（总览用，只读，不计入被挡统计）：按 tradeDecision 的顺序走一遍，读数取这个配对最新的样本。
   * 没到入场线时只报与信号无关的拦截（暂停、规格、冷却、限额、实盘检查等），都没有就是在等信号。
   */
  function gateOf(pair: PairInfo, params: SymbolParams, sample: Sample | null, baseline: Baseline | null, warming: boolean, risk: { openPositions: number; openNotionalUsd: number; dailyNetUsd: number; openKeys: string[]; memo: BlockerMemo }): GateView {
    const last = lastBlockedByPair.get(pair.key) ?? null;
    const done = (block: LiveBlock | null, reached = false, deviation: number | null = null, expectedNetBps: number | null = null): GateView =>
      ({ blocker: block?.reason ?? null, attention: block?.attention ?? false, reached, deviation, expectedNetBps, last });
    // 等一等就会过去的（没有样本、预热、复核没过、信号消失）与这个服务本来就不做的，不用人处理。
    const wait = (reason: string): LiveBlock => ({ reason, attention: false });
    if (!liveTrader) return done(wait('这个服务没有开启实盘'));
    if (pair.a.venue === 'var' || pair.b.venue === 'var') return done(wait('带 Var 腿的配对不上实盘'));
    if (!sample) return done(wait('还没有样本'));
    const fees = feesOf(pair), costs = { slippageBps: settings.global.slippageBps, aFeeBps: fees?.aFeeBps ?? 0, bFeeBps: fees?.bFeeBps ?? 0 };
    const context = {
      openPositions: risk.openPositions, openNotionalUsd: risk.openNotionalUsd, dailyNetUsd: risk.dailyNetUsd, cooldownUntil: cooldown[pair.key] ?? 0, eligible: eligible(pair),
      legBusy: legBusy(pair, risk.openKeys), feeUnknown: !fees, fallbackBaseline: baseline?.fallback ?? false, autoPending: autoPending(pair.key),
    };
    // 策略风控在前、实盘检查在后，与真正开仓时的顺序相同。
    const blockOf = (economics?: { expectedNetBps: number; costBps: number }): LiveBlock | null => {
      const reason = openBlocker(sample, params, settings.global, { ...context, ...economics });
      return reason === null ? liveTrader.blocker(pair, params.notionalUsd, risk.memo) : { reason, attention: ATTENTION_BLOCKS.has(reason) };
    };
    const decision = warming ? null : decide(sample, baseline, params, null);
    if (decision?.kind === 'open' && baseline) {
      const confirmed = confirmOpen(sample, baseline, params, decision, settings.global.maxQuoteAgeSec);
      if (typeof confirmed === 'string') return done(wait(confirmed), true, decision.deviation);
      const economics = openEconomics(confirmed, params, costs, confirmed.spread.varSource === 'token' ? decision : undefined);
      return done(blockOf(economics), true, confirmed.deviation, economics.expectedNetBps);
    }
    const standing = blockOf();
    if (warming) return done(standing ?? wait('基线预热中'));
    if (decision?.kind === 'wait') return done(standing ?? wait(decision.reason));
    // 没到入场线：偏离取允许的方向里较大的。
    const spread = baseline ? spreadOf(sample, bucketOf(params.notionalUsd)) : null;
    const sides = spread && baseline ? params.directions.map(direction => direction === 'a_rich' ? spread.sellA - baseline.median : baseline.median - spread.buyA) : [];
    return done(standing, false, sides.length ? Math.max(...sides) : null);
  }
  function state(): StateView {
    const time = now(), open = held();
    const openNotionalUsd = [...open.values()].reduce((sum, item) => sum + strategyOf(item).notionalUsd, 0), todayNetUsd = store.liveNetSince(dayStart(time));
    const risk = { openPositions: open.size, openNotionalUsd, dailyNetUsd: todayNetUsd, openKeys: [...open.keys()], memo: { venues: new Map() } as BlockerMemo };
    const rows = pairs.map((pair): StateRow => {
      const sample = latest.get(pair.key) ?? null, params = paramsOf(pair.key);
      const track = trackerForView(pair), baseline = track ? track.value(regimeOf(pair.kind, time), time) : null;
      const spread = sample ? spreadOf(sample, bucketOf(params.notionalUsd)) : null;
      const mid = sample ? midBasis(sample) : null;
      const position = open.get(pair.key);
      const aFeeBps = legFeeBps(settings.global, pair.a.venue, pair.a.market.takerFeeBps);
      const bFeeBps = legFeeBps(settings.global, pair.b.venue, pair.b.market.takerFeeBps);
      const cost = spread ? spread.buyA - spread.sellA : null;
      const feeCost = aFeeBps !== null && bFeeBps !== null ? 2 * (aFeeBps + bFeeBps) : null;
      const totalCost = cost !== null && feeCost !== null ? cost + feeCost : null;
      return {
        key: pair.key, a: legRef(pair.a), b: legRef(pair.b), ratio: pair.ratio, custom: pair.custom, note: pair.note, venue: pair.b.venue, venueName: VENUE_NAMES[pair.b.venue],
        symbol: pair.symbol, name: pair.name, kind: pair.kind, kindName: KIND_NAMES[pair.kind], identity: pair.identity, eligible: eligible(pair), gapBps: pair.gapBps,
        regime: regimeOf(pair.kind, time), sampleAt: sample?.t ?? null, mid, sellA: spread?.sellA ?? null, buyA: spread?.buyA ?? null, estimated: spread?.estimated ?? null,
        cost, feeCost, totalCost,
        baseline: baseline ? { median: baseline.median, sigma: baseline.sigma, samples: baseline.samples, regime: baseline.regime, fallback: baseline.fallback } : null,
        z: baseline && mid !== null ? (mid - baseline.median) / baseline.sigma : null,
        rich: baseline && spread ? spread.sellA - baseline.median : null, cheap: baseline && spread ? baseline.median - spread.buyA : null,
        samples24h: recentCount(pair.key, time), firstAt: firstOf(pair.key), cooldownUntil: cooldown[pair.key] > time ? cooldown[pair.key] : null,
        enabled: params.enabled, directions: params.directions, entryBps: params.entryBps, exitBps: params.exitBps, auto: autoKeys.has(pair.key), autoPending: autoPending(pair.key),
        position: positionSummary(position, sample),
        aFunding: sample?.aFunding ?? pair.a.market.fundingHourly, bFunding: sample?.bFunding ?? pair.b.market.fundingHourly,
        aFeeBps, bFeeBps,
        gate: params.enabled && !position ? gateOf(pair, params, sample, baseline, !track, risk) : null,
        ...(!track && { baselineWarming: true }),
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
          depth: [...runtime.depth].map(([key, entry]): DepthStatus => ({ key, marketId: entry.leg.market.id, at: entry.at, error: entry.error })),
          pairs: pairs.filter(pair => pair.a.venue === runtime.venue || pair.b.venue === runtime.venue).length,
        })),
        live: lastLive, push: { ...pushStats },
        combos: COMBOS.map(combo => ({ combo, name: comboName(combo), enabled: settings.combos.includes(combo), pairs: pairs.filter(pair => !pair.custom && `${pair.a.venue}|${pair.b.venue}` === combo).length })),
      },
      firstSampleAt: firstSample === undefined ? (firstSample = store.firstSampleAt()) : firstSample,
      rows,
      orphans: orphans(),
      settings,
      trading: { on: liveTrader?.settings().on ?? false, pairs: liveTrader?.settings().pairs ?? [], open: open.size, openNotionalUsd, todayNetUsd },
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

  /** 已启用或有实盘持仓、但已失联的键：总览里列出来，可以停用或对实盘持仓发手动平仓。 */
  function orphans(): OrphanRow[] {
    const time = now(), open = held();
    return [...activeKeys()].sort().flatMap(key => {
      const reason = lostReason(key, time);
      if (reason === null) return [];
      const position = open.get(key), sample = lastSample(key), parsed = parsePairKey(key);
      return {
        key, a: parsed ? legRef(parsed.a) : null, b: parsed ? legRef(parsed.b) : null, venue: parsed?.b.venue ?? null, venueName: parsed ? VENUE_NAMES[parsed.b.venue] : '',
        symbol: pairTitle(key), reason, enabled: settings.symbols[key]?.enabled === true, lastSampleAt: sample?.t ?? null,
        position: positionSummary(position, sample),
      };
    });
  }

  // Cache only the replay. Order plans, freshness, live positions and trades are read on every request.
  type History = Pick<SymbolView, 'stats' | 'samples' | 'points'>;
  const historyCache = new Map<string, { key: string; from: number; expires: number; value: History }>();
  function historyOf(pair: PairInfo, hours: number, time: number, bucket: SizeBucket, entryBps: number): History {
    const span = hours * 3_600_000, from = time - span, windowMs = settings.global.windowHours * 3_600_000;
    const id = JSON.stringify([pair.key, hours, pair.kind, settings.revision, bucket, entryBps]);
    const hit = historyCache.get(id);
    if (hit && from >= hit.from && time <= hit.expires) return hit.value;
    const all = store.samples(pair.key, from - windowMs, time);
    const livePair = bothLive(pair.key);
    const local = new BaselineTracker(pair.kind, windowMs, settings.global.minSamples, livePair ? LIVE_BASELINE_GAP_MS : 0);
    const gapMs = 3 * (livePair ? LIVE_IDLE_MS : VAR_POLL_MS);
    const points: SymbolPoint[] = [], inRange: Sample[] = [];
    for (const sample of all) {
      if (sample.t >= from) {
        const baseline = local.value(sample.regime, sample.t), spread = spreadOf(sample, bucket);
        const previous = points.at(-1);
        points.push({ t: sample.t, mid: midBasis(sample), sellA: spread?.sellA ?? null, buyA: spread?.buyA ?? null,
          median: baseline?.median ?? null, sigma: baseline?.sigma ?? null, regime: sample.regime, estimated: spread?.estimated ?? false,
          ...(previous && sample.t - previous.t > gapMs ? { gapBefore: true } : {}) });
        inRange.push(sample);
      }
      local.push(sample);
    }
    const stats = symbolStats(pair.kind, inRange, entryBps, bucket);
    const value = { points: downsample(points, 1500), samples: inRange.length, stats: stats.map(item => ({ ...item, suggestedEntryBps: suggestedEntryBps(item) })) };
    // Sliding either SQL bound past its first sample changes the replay (including baseline warm-up).
    // A small positive exchange-clock skew can also leave a committed sample just beyond the right bound.
    const next = store.samplesAfter(pair.key, time, 1)[0];
    const expires = Math.min((all[0]?.t ?? Infinity) + span + windowMs, (inRange[0]?.t ?? Infinity) + span,
      next ? next.t - 1 : Infinity, time + VAR_POLL_MS);
    if (!hit && historyCache.size >= 16) historyCache.delete(historyCache.keys().next().value!);
    historyCache.set(id, { key: pair.key, from, expires, value });
    return value;
  }

  function symbolView(keyRaw: unknown, hoursRaw: unknown, pointsRaw?: unknown): SymbolView {
    const key = upgradeKey(String(keyRaw ?? ''));
    const pair = key ? pairOf(key) : undefined;
    if (!pair) return reject('unknown_symbol', '不是当前采集中的配对（或该场所组合未开启）');
    const hours = Number(hoursRaw ?? 24);
    if (!Number.isInteger(hours) || hours < 1 || hours > 24 * 14) reject('invalid_hours', '时长须为 1 到 336 小时');
    const pointsLimit = pointsRaw === undefined || pointsRaw === null || pointsRaw === '' ? 1500 : Number(pointsRaw);
    if (!Number.isInteger(pointsLimit) || pointsLimit < 0 || pointsLimit > 1500) reject('invalid_points', '点数须为 0 到 1500 之间的整数');
    const time = now(), from = time - hours * 3_600_000;
    const params = paramsOf(pair.key), bucket = bucketOf(params.notionalUsd);
    const history = historyOf(pair, hours, time, bucket, params.entryBps);
    const points = pointsLimit === 0 ? [] : pointsLimit < history.points.length ? downsample(history.points, pointsLimit) : history.points;
    const sample = latest.get(pair.key) ?? store.latest(pair.key);
    const quoted = sample ? spreadOf(sample, bucketOf(params.notionalUsd)) : null;
    const fees = feesOf(pair);
    const protection = slippageBudgetBps(params, { minNetBps: settings.global.minNetBps, aFeeBps: fees?.aFeeBps ?? 0, bFeeBps: fees?.bFeeBps ?? 0 }, quoted ? (quoted.buyA - quoted.sellA) / 2 : 0);
    const plans: OrderPlan[] = sample ? DIRECTIONS.map(direction => orderPlan(pair, sample, direction, params.notionalUsd, protection, time)) : [];
    const current = held().get(pair.key), position = current ? strategyOf(current) : null;
    return {
      key: pair.key, a: { ...pair.a, name: VENUE_NAMES[pair.a.venue] }, b: { ...pair.b, name: VENUE_NAMES[pair.b.venue] }, ratio: pair.ratio, custom: pair.custom, note: pair.note,
      venue: pair.b.venue, venueName: VENUE_NAMES[pair.b.venue],
      symbol: pair.symbol, name: pair.name, kind: pair.kind, kindName: KIND_NAMES[pair.kind], identity: pair.identity, eligible: eligible(pair), gapBps: pair.gapBps,
      regimes: regimesOf(pair.kind), hours, from, to: time, bucket,
      ...history, points,
      params: storedOf(pair.key), effective: params, auto: { on: autoKeys.has(pair.key), ...recommendation(pair.key) }, global: settings.global, latest: sample ?? null, plans,
      fees: { a: legFeeBps(settings.global, pair.a.venue, pair.a.market.takerFeeBps), b: legFeeBps(settings.global, pair.b.venue, pair.b.market.takerFeeBps) },
      position: position && current ? { ...position, state: current.state, mark: sample && current.state === 'open' ? markOf(position, sample) : null } : null,
      trades: store.liveClosed(LIVE_TRADES_SCAN).filter(item => item.symbol === pair.key && (item.closedAt ?? 0) >= from).flatMap(item => liveTradeOf(item) ?? []).reverse().slice(-500),
    };
  }

  /** 一笔已结束的实盘持仓换成详情页的成交行（两腿都开过、都平掉过的才算；没开成、单腿的只在实盘页）。 */
  function liveTradeOf(position: LivePosition): LiveTradeView | null {
    const { a, b, ratio } = position;
    if (position.closedAt === null || position.netUsd === null || !(a.qty > 0 && b.qty > 0 && a.exitQty > 0 && b.exitQty > 0)) return null;
    const entry = strategyOf(position), aExit = a.exitQuote / a.exitQty, bExit = ratio * b.exitQuote / b.exitQty, costUsd = a.feesUsd + b.feesUsd;
    return {
      ...entry, qty: a.qty, bQty: b.qty, closedAt: position.closedAt, aExit, bExit, exitSpread: (aExit - bExit) / bExit * 1e4, reason: position.closeReason ?? 'signal',
      grossUsd: position.netUsd + costUsd, costUsd, netUsd: position.netUsd, netBps: entry.notionalUsd > 0 ? position.netUsd / entry.notionalUsd * 10_000 : 0, fundingUsd: null,
      estimated: entry.estimated,
    };
  }

  function markOf(position: Position, sample: Sample): PositionMark | null {
    const spread = closeSpread(sample, position);
    if (!spread) return null;
    const trade = closePosition(position, sample.t, spread, 'manual', settings.global, null);
    return { netUsd: trade.netUsd, pnlBps: markToMarket(position, spread).pnlBps, at: sample.t, estimated: trade.estimated, varSource: spread.varSource };
  }

  let replayWorker: Worker | null = null;
  async function backtest(body: unknown): Promise<BacktestView> {
    const request = backtestRequest(body, settings.symbols, settings.global);
    const pair = pairOf(request.symbol) ?? reject('unknown_symbol', '不是当前采集中的配对');
    const time = now(), from = time - request.hours * 3_600_000;
    const fees = [legFeeBps(request.global, pair.a.venue, pair.a.market.takerFeeBps), legFeeBps(request.global, pair.b.venue, pair.b.market.takerFeeBps)];
    if (replayWorker) return reject('backtest_busy', '已有回测进行中，请稍后重试', 429);
    const job: ReplayJob = { file: store.file, symbol: pair.key, kind: pair.kind, from, to: time, params: request.params, global: request.global,
      fees: fees[0] === null || fees[1] === null ? null : { aFeeBps: fees[0], bFeeBps: fees[1] } };
    const worker = new Worker(new URL('./replay-worker.ts', import.meta.url), { workerData: job, env: {}, execArgv: [] });
    replayWorker = worker;
    const timer = setTimeout(() => { void worker.terminate(); }, 110_000);
    try {
      return await new Promise<BacktestView>((resolve, fail) => {
        let view: BacktestView | undefined;
        worker.once('message', result => { view = result; });
        worker.once('error', fail);
        worker.once('exit', code => code === 0 && view ? resolve(view) : fail(new Error('回测未完成')));
      });
    } finally { clearTimeout(timer); replayWorker = null; }
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
      // 关掉的组合或删掉的手动配对上不能还有启用的配对或实盘持仓。
      const holding = [...held().keys()];
      const enabled = Object.entries(symbols).filter(([, params]) => params.enabled).map(([key]) => key);
      const customKeys = new Set(custom.map(customKey));
      const coveredAfter = (key: string) => { const combo = autoComboOf(key); return (combo !== null && combos.includes(combo)) || customKeys.has(key); };
      const coveredBefore = (key: string) => { const combo = autoComboOf(key); return (combo !== null && settings.combos.includes(combo)) || settings.pairs.some(item => customKey(item) === key); };
      for (const key of [...new Set([...enabled, ...holding])]) {
        if (coveredBefore(key) && !coveredAfter(key)) reject('pair_busy', `${pairTitle(key)}（${key}）还启用着或有实盘持仓，先停用并平仓再关闭它的组合或删除手动配对`, 409);
      }
      for (const venue of LIVE_VENUES) {
        // 有持仓的配对也要订阅盘口，一并计入上限。
        const legsOf = (keys: string[]) => new Set([...new Set([...keys, ...holding])].flatMap(legsOfKey).filter(leg => leg.startsWith(`${venue}:`)));
        const legs = legsOf(enabled), before = legsOf(Object.entries(settings.symbols).filter(([, params]) => params.enabled).map(([key]) => key));
        // 只挡这次让腿变多的保存：升级前留下的超额状态不卡住无关的保存（改全局参数、确认规格）。
        if (legs.size > MAX_DEPTH_MARKETS && [...legs].some(leg => !before.has(leg))) reject('too_many', `${VENUE_NAMES[venue]} 一侧启用或有实盘持仓的市场最多 ${MAX_DEPTH_MARKETS} 个（各订阅完整盘口），先停用或平掉一些`);
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
    items.push({ key: 'enabled', status: enabled.length ? 'ok' : 'warn', label: '选定配对', detail: enabled.length ? enabled.map(label).join('、') : '还没有启用任何配对（总览勾选「策略」）' });
    const unconfirmed = enabled.filter(row => !row.eligible);
    items.push({ key: 'identity', status: unconfirmed.length ? 'warn' : 'ok', label: '合约规格核对', detail: unconfirmed.length ? `待确认：${unconfirmed.map(label).join('、')}` : '已启用配对的两边规格均已核对' });
    const unknownFee = enabled.filter(row => row.aFeeBps === null || row.bFeeBps === null);
    items.push({ key: 'fees', status: unknownFee.length ? 'warn' : 'ok', label: '两腿手续费', detail: unknownFee.length ? `手续费未知（不开仓）：${unknownFee.map(label).join('、')}；可在全局参数里填手动值` : '已启用配对两腿的手续费都已知（目录或手动值）' });
    const depth = active.flatMap(item => item.depth);
    const stale = depth.filter(item => item.at === null || time - item.at > DEPTH_STALE_MS || item.error !== null);
    items.push({ key: 'depth', status: depth.length && !stale.length ? 'ok' : 'warn', label: '盘口（行情流）', detail: depth.length ? `${depth.length - stale.length}/${depth.length} 条腿的盘口已同步${stale.length ? `；缺：${stale.map(item => `${item.key}${item.error ? `（${item.error}）` : ''}`).join('、')}` : ''}` : '没有启用配对，未订阅盘口' });
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
    // 实盘只在两腿都是行情流场所的配对上做；没有这样的已启用配对时按三个场所都要用来核对。
    const liveRows = enabled.filter(row => row.a.venue !== 'var' && row.b.venue !== 'var');
    const needed = (liveRows.length ? [...new Set(liveRows.flatMap(row => [row.a.venue, row.b.venue]))] : [...KEY_VENUES]) as KeyVenue[];
    const keys = accountSource(), have = keys.problem ? [] : configuredVenues(keys.accounts), missing = needed.filter(venue => !have.includes(venue));
    const names = (venues: KeyVenue[]) => venues.map(venue => VENUE_NAMES[venue]).join('、');
    const accountReadFor = (venue: KeyVenue) => {
      const hash = accountHashOf(venue, keys.accounts);
      const read = hash ? accountReads.get(venue) : undefined;
      return read && read.hash === hash ? read : undefined;
    };
    // 录入了但读不到（编号填错、账户不存在、接口不通）不算就绪：最近一次读取失败且没有时限内的读数。
    const unread = have.filter(venue => { const read = accountReadFor(venue); return !!read?.error && !(read.at !== null && time - read.at <= ACCOUNT_STALE_MS); });
    items.push({ key: 'accounts', status: keys.problem ? 'warn' : !have.length ? 'todo' : missing.length || unread.length ? 'warn' : 'ok', label: '场所账户',
      detail: keys.problem ? keys.problem : !have.length ? '还没有录入：在本页「实盘」一栏里按场所填账户与 API 私钥（只读余额的话，也可在服务器上执行 sudo bash install.sh --set-dex-keys 只录账户编号）'
        : `已录入 ${names(have)}${missing.length ? `；还缺 ${names(missing)}` : ''}${unread.length ? `；读不到 ${names(unread)}（核对录入的账户，原因见账户资金一项）` : ''}` });
    const signerIssue = liveTrader ? signerProblem() : null, keyed = liveKeys?.view() ?? null;
    const keyedNames = keyed ? KEY_VENUES.filter(venue => keyed[venue]).map(venue => VENUE_NAMES[venue]) : [];
    items.push({ key: 'lighter_order', status: !liveTrader ? 'todo' : signerIssue || !keyedNames.length ? 'warn' : 'ok', label: '行情流场所的下单连接器',
      detail: !liveTrader ? '这个服务没有开启实盘下单' : `Lighter 主网、Lighter RH、Entropy 的下单已接入；${signerIssue ? `Lighter 签名器不可用（${signerIssue}），两条 Lighter 链暂时下不了单；` : ''}${keyedNames.length ? `已录入下单凭据：${keyedNames.join('、')}` : '还没有录入下单凭据（在本页「实盘」一栏录入）'}${orderVenues.length ? `；已启用配对用到 ${orderVenues.join('、')}` : ''}；带 Var 腿的配对不上实盘` });
    if (liveTrader) {
      const current = liveTrader.settings(), stopped = liveTrader.view().halt;
      items.push({ key: 'live', status: current.on && current.pairs.length && !stopped ? 'ok' : 'warn', label: '实盘开关',
        detail: stopped ? `实盘已停止：${stopped}` : !current.on ? '实盘总开关关着，不会下真实订单' : !current.pairs.length ? '总开关已开，但还没有勾选实盘配对' : `实盘按策略信号开平仓：勾选 ${current.pairs.length} 个配对（还要在总览启用），单笔 ≤ ${fmt(current.limits.perTradeUsd, 0)} 美元，同时 ≤ ${current.limits.maxOpen} 笔，当日亏损 ≤ ${fmt(current.limits.dailyLossUsd, 0)} 美元` });
    }
    if (enabledVar || !enabled.length) items.push({ key: 'var_order', status: 'todo', label: 'Var 下单接口', detail: 'Var 没有公开交易接口；询价已可用 token 读取（各类标的的写法以实盘准备页的询价状态为准），成交接口尚未确认、尚未接入' });
    if (!have.length) items.push({ key: 'funding', status: 'todo', label: '两边账户资金', detail: `每个用到的场所各需保证金（Lighter 与 Entropy 用 USDC，Lighter RH 用 USDG）；录入场所账户后这里显示各场所的余额，每个场所可用余额至少 ${READY_FUNDING_USD} 才算就绪` });
    else {
      const lines = have.map(venue => {
        const read = accountReadFor(venue), fresh = !!read && read.at !== null && time - read.at <= ACCOUNT_STALE_MS;
        const text = !read || read.at === null || !read.snapshot ? `${VENUE_NAMES[venue]} ${read?.error ? `读取失败（${read.error}）` : '还没有读到'}`
          : `${VENUE_NAMES[venue]} 可用 ${fmt(read.snapshot.available, 2)}、权益 ${fmt(read.snapshot.collateral, 2)} ${COLLATERAL_ASSET[venue]}，持仓 ${read.snapshot.positions.length} 个${fresh ? '' : `（${read.error ? `读取失败：${read.error}` : '读数已过期'}）`}`;
        return { venue, text, ok: fresh && !!read?.snapshot && read.snapshot.available >= READY_FUNDING_USD };
      });
      const short = needed.filter(venue => !lines.some(line => line.venue === venue && line.ok));
      items.push({ key: 'funding', status: short.length ? 'warn' : 'ok', label: '两边账户资金', detail: `${lines.map(line => line.text).join('；')}${short.length ? `；可用余额至少 ${READY_FUNDING_USD} 才算就绪，未达到：${names(short)}` : ''}` });
    }
    items.push({ key: 'monitor', status: liveTrader ? 'ok' : 'todo', label: '实盘监控与告警', detail: liveTrader ? '单腿、持仓与账户对不上、当日亏损到上限、需要人工处理的持仓，经执行服务发飞书（设置页配了飞书才收得到）' : '这个服务没有开启实盘下单' });
    return { now: time, items, ready: items.every(item => item.status === 'ok'), markets: catalogs() };
  }

  /** 方向的中文：卖 A 场所 / 买 B 场所。 */
  function directionText(pair: PairInfo, direction: Position['direction']): string {
    return DIRECTION_NAMES[direction].replace('A', VENUE_NAMES[pair.a.venue]).replace('B', VENUE_NAMES[pair.b.venue]);
  }

  function markPriceFor(venue: KeyVenue, symbol: string, size: number, valueUsd: number, time: number): { markPrice: number | null; markEstimated: boolean } {
    const runtime = live.get(venue);
    const market = runtime?.markets.find(item => (venue === 'entropy' ? (item.coin ?? `io:${item.symbol}`) === symbol || item.symbol === symbol : item.symbol === symbol));
    if (market) {
      const liveMark = runtime?.stream?.topAt(market.id, time)?.mark ?? market.mark;
      if (typeof liveMark === 'number' && Number.isFinite(liveMark) && liveMark > 0) return { markPrice: liveMark, markEstimated: false };
    }
    const abs = Math.abs(size);
    if (abs > 0 && Number.isFinite(valueUsd) && valueUsd > 0) return { markPrice: valueUsd / abs, markEstimated: true };
    return { markPrice: null, markEstimated: false };
  }

  function downsampleCurve<T>(points: readonly T[], max: number): T[] {
    if (points.length <= max) return [...points];
    const result: T[] = [points[0]!];
    const step = (points.length - 1) / (max - 1);
    for (let index = 1; index < max - 1; index++) result.push(points[Math.round(index * step)]!);
    result.push(points.at(-1)!);
    return result;
  }

  function buildCombinedEquityCurve(
    configured: readonly KeyVenue[],
    byVenue: ReadonlyMap<KeyVenue, readonly { t: number; equity: number }[]>,
  ): { points: { t: number; equity: number }[]; complete: boolean } {
    if (!configured.length) return { points: [], complete: false };
    if (configured.length === 1) {
      const single = byVenue.get(configured[0]!) ?? [];
      return { points: downsampleCurve(single, ACCOUNT_CURVE_POINTS_MAX), complete: single.length >= 2 };
    }
    const allTimes: number[] = [];
    for (const venue of configured) {
      const list = byVenue.get(venue) ?? [];
      if (!list.length) return { points: [], complete: false };
      for (const point of list) allTimes.push(point.t);
    }
    allTimes.sort((a, b) => a - b);
    const rounds: number[] = [];
    for (const t of allTimes) {
      const prev = rounds.at(-1);
      if (prev !== undefined && t - prev <= 30_000) rounds[rounds.length - 1] = t;
      else rounds.push(t);
    }
    const cursors = new Map<KeyVenue, number>(configured.map(venue => [venue, -1]));
    const points: { t: number; equity: number }[] = [];
    for (const t of rounds) {
      let sum = 0, ok = true;
      for (const venue of configured) {
        const list = byVenue.get(venue)!;
        let idx = cursors.get(venue)!;
        while (idx + 1 < list.length && list[idx + 1]!.t <= t) idx++;
        cursors.set(venue, idx);
        const point = idx >= 0 ? list[idx]! : null;
        if (!point || t - point.t > ACCOUNT_STALE_MS) { ok = false; break; }
        sum += point.equity;
      }
      if (ok) points.push({ t, equity: sum });
    }
    return { points: downsampleCurve(points, ACCOUNT_CURVE_POINTS_MAX), complete: points.length >= 2 };
  }

  function accountsView(): AccountsView {
    const time = now(), cutoff = time - ACCOUNT_HISTORY_WINDOW_MS;
    const { accounts, problem } = accountSource();
    const configured = problem ? [] : configuredVenues(accounts);
    const configuredSet = new Set(configured);
    const keysRead = liveKeys?.read();
    const venues: VenueAccountView[] = [];
    const positionsList: VenuePositionView[] = [];
    const tradesList: AccountTrade[] = [];
    const fundingList: AccountFunding[] = [];
    const curveByVenue = new Map<KeyVenue, { t: number; equity: number }[]>();

    for (const venue of KEY_VENUES) {
      const isConf = configuredSet.has(venue);
      const hash = isConf ? accountHashOf(venue, accounts) : null;
      const rawRead = isConf && hash ? accountReads.get(venue) : undefined;
      const read = rawRead && rawRead.hash === hash ? rawRead : undefined;
      const rawHist = isConf && hash ? accountHistories.get(venue) : undefined;
      const hist = rawHist && rawHist.hash === hash ? rawHist : undefined;
      const snap = read?.snapshot ?? null;
      const at = read?.at ?? null;
      const stale = isConf ? !(at !== null && time - at <= ACCOUNT_STALE_MS) : false;
      const equity = snap ? (snap.equity ?? snap.collateral) : null;
      const unrealizedPnl = snap ? (snap.unrealizedPnl ?? null) : null;
      const posRealizedKnown = snap && (snap.positions.length === 0 || snap.positions.every(item => item.realizedPnl !== null && item.realizedPnl !== undefined));
      const positionRealizedPnl = snap && posRealizedKnown ? snap.positions.reduce((sum, item) => sum + (item.realizedPnl ?? 0), 0) : null;
      const hasTradingKey = !keysRead?.problem && Boolean(keysRead?.keys[venue]) && (!accounts[venue] || (venue === 'entropy' ? keysRead?.keys.entropy?.address === accounts.entropy?.address : keysRead?.keys[venue]?.accountIndex === accounts[venue]?.accountIndex));
      const rawCurve = isConf && hash ? store.accountSnapshots(venue, hash, cutoff).map(row => ({ t: row.at, equity: row.equity })) : [];
      curveByVenue.set(venue, rawCurve);
      const histSnap = hist?.snapshot ?? null;
      const historyAt = hist?.at ?? null;
      const historyStale = isConf ? !(historyAt !== null && time - historyAt <= ACCOUNT_HISTORY_STALE_MS) : false;
      const summary = histSnap?.summary ?? { tradeCount: 0, volumeUsd: 0, feeUsd: null, realizedPnlUsd: null, fundingUsd: null };

      venues.push({
        venue,
        name: VENUE_NAMES[venue],
        collateralAsset: COLLATERAL_ASSET[venue],
        configured: isConf,
        hasTradingKey,
        at,
        stale,
        error: read?.error ?? null,
        equity,
        collateral: snap ? snap.collateral : null,
        available: snap ? snap.available : null,
        marginUsed: snap ? (snap.marginUsed ?? null) : null,
        unrealizedPnl,
        positionRealizedPnl,
        positionsCount: snap ? snap.positions.length : 0,
        assets: snap?.assets ?? [],
        historyAt,
        historyStale,
        authRequired: histSnap?.authRequired ?? false,
        tradesError: histSnap?.tradesError ?? hist?.error ?? null,
        fundingError: histSnap?.fundingError ?? hist?.error ?? null,
        pnlError: histSnap?.pnlError ?? hist?.error ?? null,
        tradesTruncated: histSnap?.tradesTruncated ?? false,
        fundingTruncated: histSnap?.fundingTruncated ?? false,
        summary,
        equityCurve: downsampleCurve(rawCurve, ACCOUNT_CURVE_POINTS_MAX),
        pnlCurve: downsampleCurve(histSnap?.pnlSeries ?? [], ACCOUNT_CURVE_POINTS_MAX),
      });

      if (snap) {
        for (const item of snap.positions) {
          const { markPrice, markEstimated } = markPriceFor(venue, item.symbol, item.size, item.valueUsd, time);
          const itemUnrealized = item.unrealizedPnl ?? null;
          const basis = item.entryPrice && Math.abs(item.size) > 0 ? item.entryPrice * Math.abs(item.size) : item.valueUsd;
          positionsList.push({
            venue,
            venueName: VENUE_NAMES[venue],
            collateralAsset: COLLATERAL_ASSET[venue],
            symbol: item.symbol,
            size: item.size,
            side: item.size >= 0 ? 'long' : 'short',
            valueUsd: item.valueUsd,
            entryPrice: item.entryPrice ?? null,
            markPrice,
            markEstimated,
            unrealizedPnl: itemUnrealized,
            unrealizedPnlPct: itemUnrealized !== null && basis > 0 ? itemUnrealized / basis : null,
            realizedPnl: item.realizedPnl ?? null,
            liquidationPrice: item.liquidationPrice ?? null,
            leverage: item.leverage ?? null,
            marginMode: item.marginMode ?? null,
          });
        }
      }
      if (histSnap) {
        tradesList.push(...histSnap.trades);
        fundingList.push(...histSnap.funding);
      }
    }

    tradesList.sort((a, b) => b.at - a.at);
    fundingList.sort((a, b) => b.at - a.at);
    const configuredViews = venues.filter(item => item.configured);
    const withSnap = configuredViews.filter(item => item.equity !== null);
    const withHistory = configuredViews.filter(item => item.historyAt !== null);
    const feeList = withHistory.filter(item => !item.tradesError && item.summary.feeUsd !== null);
    const realizedList = withHistory.filter(item => !item.tradesError && item.summary.realizedPnlUsd !== null);
    const fundingSummaryList = withHistory.filter(item => !item.fundingError && item.summary.fundingUsd !== null);
    const combinedCurve = buildCombinedEquityCurve(configured, curveByVenue);
    const liveData = liveTrader?.view() ?? null;
    const elapsedSinceRefresh = time - lastManualRefreshAt;
    const cooldownMs = elapsedSinceRefresh >= 0 && elapsedSinceRefresh < ACCOUNT_MANUAL_REFRESH_COOLDOWN_MS
      ? ACCOUNT_MANUAL_REFRESH_COOLDOWN_MS - elapsedSinceRefresh
      : 0;

    return {
      now: time,
      windowDays: Math.round(ACCOUNT_HISTORY_WINDOW_MS / 86_400_000),
      refreshing: activeRefresh !== null,
      cooldownMs,
      keysProblem: problem,
      signerProblem: liveTrader ? signerProblem() : null,
      totals: {
        configured: configured.length,
        fresh: configuredViews.filter(item => !item.stale).length,
        staleVenues: configuredViews.filter(item => item.stale).map(item => item.venue),
        errorVenues: configuredViews.filter(item => item.error !== null).map(item => item.venue),
        complete: configured.length > 0 && configuredViews.every(item => item.equity !== null && !item.stale),
        equityUsd: withSnap.length ? withSnap.reduce((sum, item) => sum + item.equity!, 0) : null,
        collateralUsd: withSnap.length ? withSnap.reduce((sum, item) => sum + item.collateral!, 0) : null,
        availableUsd: withSnap.length ? withSnap.reduce((sum, item) => sum + item.available!, 0) : null,
        marginUsedUsd: withSnap.length && withSnap.every(item => item.marginUsed !== null) ? withSnap.reduce((sum, item) => sum + item.marginUsed!, 0) : null,
        unrealizedPnlUsd: withSnap.length && withSnap.every(item => item.unrealizedPnl !== null) ? withSnap.reduce((sum, item) => sum + item.unrealizedPnl!, 0) : null,
        positionsCount: positionsList.length,
        positionsNotionalUsd: positionsList.reduce((sum, item) => sum + item.valueUsd, 0),
        tradeCount30d: withHistory.reduce((sum, item) => sum + item.summary.tradeCount, 0),
        volumeUsd30d: withHistory.reduce((sum, item) => sum + item.summary.volumeUsd, 0),
        feeUsd30d: configured.length > 0 && withHistory.length === configured.length && feeList.length === configured.length
          ? feeList.reduce((sum, item) => sum + item.summary.feeUsd!, 0)
          : null,
        realizedPnlUsd30d: realizedList.length ? realizedList.reduce((sum, item) => sum + item.summary.realizedPnlUsd!, 0) : null,
        realizedVenues: realizedList.map(item => item.venue),
        fundingUsd30d: fundingSummaryList.length ? fundingSummaryList.reduce((sum, item) => sum + item.summary.fundingUsd!, 0) : null,
        fundingVenues: fundingSummaryList.map(item => item.venue),
        liveTrades: liveData?.totals.trades ?? 0,
        liveNetUsd: liveData?.totals.netUsd ?? 0,
        liveTodayNetUsd: liveData?.todayNetUsd ?? 0,
        liveWins: liveData?.totals.wins ?? 0,
        liveOpenCount: liveData?.positions.length ?? 0,
      },
      venues,
      positions: positionsList,
      trades: tradesList.slice(0, ACCOUNT_HISTORY_LIMIT),
      funding: fundingList.slice(0, ACCOUNT_HISTORY_LIMIT),
      equityCurve: combinedCurve.points,
      equityComplete: combinedCurve.complete,
      liveTrades: liveData?.trades ?? [],
      venueNames: VENUE_NAMES,
    };
  }

  function refreshAccountsNow(): AccountsRefreshResult {
    const time = now();
    if (liveStop.signal.aborted) return { triggered: false, cooldownMs: 0, refreshing: false };
    const elapsed = time - lastManualRefreshAt;
    if (elapsed >= 0 && elapsed < ACCOUNT_MANUAL_REFRESH_COOLDOWN_MS) {
      return { triggered: false, cooldownMs: ACCOUNT_MANUAL_REFRESH_COOLDOWN_MS - elapsed, refreshing: activeRefresh !== null };
    }
    if (activeRefresh) {
      return { triggered: false, cooldownMs: Math.max(1000, ACCOUNT_MANUAL_REFRESH_COOLDOWN_MS - Math.max(0, elapsed)), refreshing: true };
    }
    lastManualRefreshAt = time;
    const accEpoch = ++accountsScheduleEpoch, histEpoch = ++historyScheduleEpoch;
    nextAccounts = time + ACCOUNT_POLL_MS;
    nextAccountHistory = time + ACCOUNT_HISTORY_POLL_MS;
    const signalFor = () => anySignal([liveStop.signal], REQUEST_TIMEOUT_MS);
    const run: Promise<void> = Promise.all([refreshAccounts(signalFor), refreshAccountHistory(signalFor)])
      .then(() => undefined, error => { log(`varlighter: 手动刷新账户失败：${scrub(message(error))}`); })
      .finally(() => {
        if (accountsScheduleEpoch === accEpoch) nextAccounts = now() + ACCOUNT_POLL_MS;
        if (historyScheduleEpoch === histEpoch) nextAccountHistory = now() + ACCOUNT_HISTORY_POLL_MS;
        if (activeRefresh === run) activeRefresh = null;
      });
    activeRefresh = run;
    return { triggered: true, cooldownMs: 0, refreshing: true };
  }

  return {
    /** 某场所的行情流（测试用）；未在采集时为 null。 */
    stream: (venue: LiveVenue = 'rh') => live.get(venue)!.stream,
    /** 测试用：不跑后台循环时按参数启停各场所的行情流。 */
    startStreams(): void { running = true; syncStreams(); },
    pollVar, refreshCatalog, refreshDepth, sampleLive, refreshAccounts, refreshAccountHistory,
    syncEntropyCost: () => entropyCost.sync(true),
    views: { state, symbol: symbolView, samples: samplesPage, backtest, settings: updateSettings, readiness,
      accounts: accountsView, accountsRefresh: refreshAccountsNow,
      live: liveView, liveKeys: setLiveKeys, liveKeysRemove: removeLiveKeys, liveSettings, liveClose, liveDismiss, liveResume,
      entropyCost: (from?: unknown, to?: unknown, limit?: unknown) => entropyCost.view(from, to, limit),
      entropyCostSync: () => entropyCost.sync(true),
      lead: () => leadTester.view(),
      leadStart: (body: unknown) => leadTester.start(body),
      leadStop: (body: unknown) => leadTester.stop(body),
      leadClear: () => leadTester.clearHistory(),
      leadRefreshCatalog: () => leadTester.refreshCatalog() },
    /**
     * 后台循环：连上用到的行情流（一档、标记价、资金费与启用配对的盘口都走行情流）并在后台每 10 分钟取各场所目录，然后每分钟拉 Var 报价（连同询价），
     * 每秒检查两腿都是行情流的配对是否到期采样，每小时清理过期样本。
     */
    async loop(context: { stopped(): boolean; pause(ms: number): Promise<void> }): Promise<void> {
      running = true; looping = true;
      syncStreams();
      let nextVar = now() + 5_000, nextPrune = now() + 60_000, nextLive = now() + 10_000;
      nextAccounts = now() + 1_000;
      nextAccountHistory = now() + 1_500;
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
          // 没有配置账户时这一轮不发任何请求；结束时按 L049 顺延下一次轮询，并在周期序号变更时保留期间触发的立即重刷。
          if (time >= nextAccounts && !busy.has('accounts') && !activeRefresh) {
            const epoch = accountsScheduleEpoch;
            background('accounts', async () => {
              try { await refreshAccounts(request); }
              finally { if (accountsScheduleEpoch === epoch) nextAccounts = now() + ACCOUNT_POLL_MS; }
            });
          }
          if (time >= nextAccountHistory && !busy.has('accountHistory') && !activeRefresh) {
            const epoch = historyScheduleEpoch;
            background('accountHistory', async () => {
              try { await refreshAccountHistory(request); }
              finally { if (historyScheduleEpoch === epoch) nextAccountHistory = now() + ACCOUNT_HISTORY_POLL_MS; }
            });
          }
          if (time >= nextEntropyCost && !busy.has('entropy-cost')) {
            nextEntropyCost = time + ENTROPY_COST_POLL_MS;
            background('entropy-cost', () => entropyCost.sync(false).then(() => undefined));
          }
          liveTrader?.tick();
          if (warmQueue.size && !busy.has('warm')) background('warm', () => warmTrackers(() => context.stopped()));
          if (time >= nextLive) { nextLive = time + LIVE_TICK_MS; try { sampleLive(); } catch (error) { log(`varlighter: 行情流配对采样失败：${message(error)}`); } }
          if (time >= nextPrune && !busy.has('prune')) { nextPrune = time + PRUNE_MS; background('prune', () => pruneSamples(time, () => context.stopped())); }
          await context.pause(1_000);
        }
      } finally {
        done = true; running = false; looping = false; clearAllPendingSignals();
        leadTester.close();
        syncStreams();
        // 停止时掐断在途的下单请求（结果按「不明」落库，重启后先查询再决定，不重发），等这一轮推进收尾后才关库。
        liveStop.abort();
        await liveTrader?.idle();
        await watcher; await Promise.allSettled([...jobs, ...(activeRefresh ? [activeRefresh] : []), entropyCost.idle()]);
      }
    },
    /** 实盘告警（经执行服务发飞书）。 */
    liveAlerts: () => liveTrader?.alerts() ?? [],
    accounts: () => accountSource(),
    live: () => liveTrader,
    close(): void {
      running = false; clearAllPendingSignals(); leadTester.close(); if (replayWorker) void replayWorker.terminate(); liveStop.abort();
      syncStreams(); store.close();
    },
  };
}
export type VarLighterEngine = ReturnType<typeof createVarLighterEngine>;

const message = (error: unknown) => error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
const fmt = (value: number, digits: number) => Number.isFinite(value) ? value.toFixed(digits) : '-';

/** 按时间等分成不超过 limit 格：每格中间价取均值，卖 A 价差取最大、买 A 价差取最小（保留机会的极值），基线取格内最后一个。 */
export function downsample<T extends { t: number; mid: number; sellA: number | null; buyA: number | null; median: number | null; sigma: number | null; gapBefore?: boolean }>(points: T[], limit: number): T[] {
  if (points.length <= limit) return points;
  const first = points[0].t, span = points.at(-1)!.t - first + 1, result: T[] = [];
  let index = 0;
  for (let cell = 0; cell < limit && index < points.length; cell++) {
    const end = first + span * (cell + 1) / limit;
    while (index < points.length && points[index].t < end) {
      const start = index;
      let mid = 0, sellA: number | null = null, buyA: number | null = null;
      do {
        const point = points[index++];
        mid += point.mid;
        if (point.sellA !== null) sellA = sellA === null ? point.sellA : Math.max(sellA, point.sellA);
        if (point.buyA !== null) buyA = buyA === null ? point.buyA : Math.min(buyA, point.buyA);
      } while (index < points.length && points[index].t < end && !points[index].gapBefore);
      result.push({ ...points[index - 1], ...(points[start].gapBefore ? { gapBefore: true } : {}),
        mid: mid / (index - start), sellA, buyA });
    }
  }
  return result;
}
